const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

const mockTurnstile = `
  window.turnstile = {
    render(host, options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Verify';
      button.onclick = () => options.callback('valid-' + options.action + '-' + Math.random());
      host.appendChild(button);
      return host;
    },
    reset(host) { host.querySelector('button').textContent = 'Verify'; },
    remove(host) { host.replaceChildren(); }
  };
`;

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';
  process.env.TURNSTILE_SITE_KEY = 'test-site-key';
  process.env.TURNSTILE_SECRET_KEY = 'test-server-secret';

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return originalFetch(url, options);
    }
    const token = options.body.get('response');
    return new Response(JSON.stringify({
      success: token.startsWith('valid-'),
      hostname: '127.0.0.1',
      action: token.includes('register') ? 'register' : 'login'
    }));
  };

  const fixture = await createFixture({ port });
  let browser;
  try {
    fixture.pool.settings.push(
      { setting_key: 'captcha_login', setting_value: 'true' },
      { setting_key: 'captcha_register', setting_value: 'true' }
    );
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true, args: ['--disable-background-networking']
    });
    const artifacts = path.resolve(__dirname, '..', '.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const viewport of [{ width: 1360, height: 900 }, { width: 360, height: 780 }]) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith('https://challenges.cloudflare.com/turnstile/v0/api.js')) {
          return route.fulfill({ status: 200, contentType: 'text/javascript', body: mockTurnstile });
        }
        return new URL(url).origin === fixture.baseUrl ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const account = await fixture.user();
      await page.goto(`${fixture.baseUrl}/oauth2/authorize`);
      const widget = page.locator('#loginForm [data-turnstile-widget]');
      await widget.locator('button').waitFor();
      assert.equal(await page.locator('#loginForm [data-captcha-group]').isVisible(), true);
      assert.equal(await page.locator('#loginForm [data-image-captcha]').isVisible(), false);
      await page.locator('#loginUsername').fill(account.username);
      await page.locator('#loginPassword').fill(account.clearPassword);
      await widget.locator('button').click();
      assert.match(await page.locator('#loginForm input[name="turnstile_response"]').inputValue(), /^valid-login-/);
      const bounds = await widget.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width);
      await page.screenshot({ path: path.join(artifacts, `turnstile-login-${viewport.width}.png`) });
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/profile');

      await context.clearCookies();
      await page.goto(`${fixture.baseUrl}/oauth2/authorize`);
      await page.locator('[data-mode="register"]').click();
      await page.locator('#registerForm [data-turnstile-widget] button').waitFor();
      assert.equal(await page.locator('#registerForm [data-image-captcha]').isVisible(), false);
      await page.screenshot({ path: path.join(artifacts, `turnstile-register-${viewport.width}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Turnstile browser checks passed: immediate web login, registration, desktop and mobile layout');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
    global.fetch = originalFetch;
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
