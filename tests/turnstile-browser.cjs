const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

// Account-first login: the primary action advances from account entry to the password step.
async function continueToPassword(page) {
  await page.locator('#loginForm .submit').click();
  await page.waitForFunction(() => {
    const field = document.getElementById('loginPassword');
    return Boolean(field) && !field.disabled && field.getBoundingClientRect().width > 1;
  }, null, { timeout: 15000 });
}

// Simulated provider geometry, not a live Cloudflare challenge. An iframe isolates
// its controls from the page CSS and follows the documented size constraints.
const mockTurnstile = `
  window.__turnstileWidgets = [];
  window.turnstile = {
    render(host, options) {
      const frame = document.createElement('iframe');
      frame.title = 'Simulated Turnstile';
      frame.style.cssText = 'display:block;border:0;';
      frame.width = options.size === 'compact' ? '150' : '300';
      frame.height = options.size === 'compact' ? '140' : '65';
      if (options.size === 'flexible') {
        frame.style.width = '100%';
        frame.style.minWidth = '300px';
      }
      frame.srcdoc = '<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#fafafa;font:12px sans-serif}button{width:100%;height:100vh;border:1px solid #ddd;background:#fafafa;color:#222;cursor:pointer}</style><button type="button">Verify</button>';
      frame.onload = () => {
        frame.contentDocument.querySelector('button').onclick = () =>
          options.callback('valid-' + options.action + '-' + Math.random());
      };
      const id = window.__turnstileWidgets.push({ host, options, frame, removed: false, resets: 0 }) - 1;
      host.appendChild(frame);
      return id;
    },
    reset(id) {
      window.__turnstileWidgets[id].resets += 1;
    },
    remove(id) {
      const widget = window.__turnstileWidgets[id];
      widget.removed = true;
      widget.frame.remove();
    },
  };
`;

async function widgetGeometry(widget, expectedSize, label) {
  await widget.locator('iframe').waitFor();
  const geometry = await widget.evaluate(host => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, right: box.right, width: box.width, height: box.height };
    };
    const current = window.__turnstileWidgets.findLast(item => item.host === host && !item.removed);
    return {
      host: rect(host), frame: rect(host.querySelector('iframe')), form: rect(host.closest('form')),
      size: current.options.size, viewport: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth + 1
    };
  });
  assert.equal(geometry.size, expectedSize, `${label}: choose a supported size for the usable container`);
  assert.equal(geometry.frame.height, expectedSize === 'compact' ? 140 : 65,
    `${label}: the provider iframe must keep its natural height`);
  assert.ok(geometry.frame.x >= geometry.form.x - 1 && geometry.frame.right <= geometry.form.right + 1,
    `${label}: the iframe must fit the form content, without clipping or intrinsic-track overflow`);
  assert.ok(geometry.host.x >= 0 && geometry.host.right <= geometry.viewport + 1, `${label}: host fits viewport`);
  assert.equal(geometry.overflow, false, `${label}: no horizontal document overflow`);
  if (expectedSize === 'flexible') {
    assert.ok(geometry.frame.width >= 300 && Math.abs(geometry.frame.width - geometry.form.width) <= 1,
      `${label}: horizontal challenge fills the usable form width`);
    assert.equal(geometry.host.height, 65, `${label}: no obsolete tall mobile reservation`);
  } else {
    assert.equal(geometry.frame.width, 150, `${label}: narrow fallback keeps supported compact geometry`);
  }
  return { label, ...geometry };
}

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
    const artifacts = path.resolve(__dirname, '..', '.artifacts', 'mobile-turnstile');
    fs.mkdirSync(artifacts, { recursive: true });
    const measurements = [];
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 },
      { width: 375, height: 812 }, { width: 360, height: 780 }, { width: 320, height: 780 }]) {
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
      // The account step must not mount a CAPTCHA challenge yet.
      assert.equal(await page.locator('#loginForm [data-captcha-group]').isVisible(), false,
        'the account step must not render the login CAPTCHA');
      assert.equal(await widget.locator('iframe').count(), 0, 'no widget may be mounted before the password step');
      await page.locator('#loginUsername').fill(account.username);
      await continueToPassword(page);
      const verify = widget.frameLocator('iframe').getByRole('button', { name: 'Verify' });
      await verify.waitFor();
      assert.equal(await page.locator('#loginForm [data-captcha-group]').isVisible(), true);
      assert.equal(await page.locator('#loginForm [data-image-captcha]').isVisible(), false);
      const tokenInput = page.locator('#loginForm input[name="turnstile_response"]');
      await verify.click();
      assert.match(await tokenInput.inputValue(), /^valid-login-/);
      const expectedSize = viewport.width === 320 ? 'compact' : 'flexible';
      measurements.push(await widgetGeometry(widget, expectedSize, `login-${viewport.width}`));
      await page.screenshot({ path: path.join(artifacts, `turnstile-login-${viewport.width}.png`) });

      if (viewport.width === 375) {
        const firstToken = await tokenInput.inputValue();
        const firstId = await page.evaluate(() => window.__turnstileWidgets.length - 1);
        await page.setViewportSize({ width: 390, height: viewport.height });
        measurements.push(await widgetGeometry(widget, 'flexible', 'resize-flexible-390'));
        await page.waitForTimeout(150);
        assert.equal(await tokenInput.inputValue(), firstToken, 'same-size resize must preserve the current token');
        assert.equal(await page.evaluate(() => window.__turnstileWidgets.length), firstId + 1,
          'same-size resize must not recreate the widget');
        assert.equal(await page.evaluate(id => window.__turnstileWidgets[id].resets, firstId), 0,
          'same-size resize must not reset the proof');

        await page.setViewportSize({ width: 320, height: viewport.height });
        await page.waitForFunction(() => window.__turnstileWidgets.at(-1).options.size === 'compact');
        measurements.push(await widgetGeometry(widget, 'compact', 'resize-compact-320'));
        assert.equal(await tokenInput.inputValue(), '', 'a size transition must clear the previous proof');
        assert.equal(await widget.locator('iframe').count(), 1, 'a size transition must remove the old iframe');
        await page.evaluate(id => window.__turnstileWidgets[id].options.callback('valid-login-removed'), firstId);
        assert.equal(await tokenInput.inputValue(), '', 'a removed widget callback must not restore stale proof');
        await verify.click();
        const compactToken = await tokenInput.inputValue();
        const compactId = await page.evaluate(() => window.__turnstileWidgets.length - 1);
        await page.evaluate(id => {
          window.__turnstileWidgets[id].options['expired-callback']();
          window.__turnstileWidgets[id].options['error-callback']();
        }, firstId);
        assert.equal(await tokenInput.inputValue(), compactToken, 'removed callbacks must not clear newer proof');
        await page.screenshot({ path: path.join(artifacts, 'turnstile-resize-compact-320.png') });

        await page.setViewportSize({ width: 340, height: viewport.height });
        measurements.push(await widgetGeometry(widget, 'compact', 'resize-compact-340'));
        await page.waitForTimeout(150);
        assert.equal(await tokenInput.inputValue(), compactToken, 'compact-to-compact resize must preserve proof');
        assert.equal(await page.evaluate(() => window.__turnstileWidgets.length), compactId + 1);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.waitForFunction(() => window.__turnstileWidgets.at(-1).options.size === 'flexible');
        measurements.push(await widgetGeometry(widget, 'flexible', 'resize-flexible-375'));
        assert.equal(await tokenInput.inputValue(), '');
        await page.evaluate(id => window.__turnstileWidgets[id].options.callback('valid-login-removed'), compactId);
        assert.equal(await tokenInput.inputValue(), '', 'old compact proof must not reach the new horizontal widget');

        const hiddenId = await page.evaluate(() => window.__turnstileWidgets.length - 1);
        await verify.click();
        await page.locator('#changeLoginAccountBtn').click();
        await page.evaluate(id => window.__turnstileWidgets[id].options.callback('valid-login-hidden'), hiddenId);
        assert.equal(await tokenInput.inputValue(), '', 'hidden account step must reject a late callback');
        assert.equal(await widget.locator('iframe').count(), 0);
        await continueToPassword(page);
        await verify.click();
        await page.locator('#loginPassword').fill('wrong-password-value');
        const [failed] = await Promise.all([
          page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname === '/oauth2/authorize'),
          page.locator('#loginForm .submit').click()
        ]);
        assert.equal(failed.status(), 401);
        await page.waitForFunction(() => document.querySelector('#loginForm input[name="turnstile_response"]').value === '');
        assert.equal(await page.evaluate(() => window.__turnstileWidgets.at(-1).resets), 1,
          'a failed credential request still resets its one-use challenge');
        await page.waitForFunction(() => !document.querySelector('#loginForm .submit').disabled);
        await verify.click();
      }

      await page.locator('#loginPassword').fill(account.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/profile');

      await context.clearCookies();
      await page.goto(`${fixture.baseUrl}/oauth2/authorize`);
      await page.locator('[data-mode="register"]').click();
      const registerWidget = page.locator('#registerForm [data-turnstile-widget]');
      await registerWidget.frameLocator('iframe').getByRole('button', { name: 'Verify' }).waitFor();
      assert.equal(await page.locator('#registerForm [data-image-captcha]').isVisible(), false);
      measurements.push(await widgetGeometry(registerWidget, expectedSize, `register-${viewport.width}`));
      await page.screenshot({ path: path.join(artifacts, `turnstile-register-${viewport.width}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    }
    fs.writeFileSync(path.join(artifacts, 'geometry.json'), JSON.stringify(measurements, null, 2));
    console.log('Turnstile browser checks passed: simulated provider iframe geometry at 1440/390/375/360/320px, '
      + 'password-step timing, registration, responsive proof lifecycle and ordinary login');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
    global.fetch = originalFetch;
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
