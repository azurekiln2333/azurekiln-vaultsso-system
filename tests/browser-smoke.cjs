const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';
  const f = await createFixture({ port });
  let browser;
  try {
    const admin = await f.user('admin');
    await f.client();
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true, args: ['--disable-background-networking']
    });
    const context = await browser.newContext();
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === f.baseUrl ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    const blockedScripts = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (/violates.*script-src|Refused to execute.*script/i.test(message.text())) blockedScripts.push(message.text());
    });
    await page.goto(`${f.baseUrl}/oauth2/authorize`);
    await page.locator('#loginForm input[name=username]').fill(admin.username);
    await page.locator('#loginForm input[name=password]').fill(admin.clearPassword);
    await page.locator('#loginForm button[type=submit]').click();
    await page.waitForURL('**/profile');
    assert.ok(await page.locator('body').innerText());
    for (const route of ['/admin.html', '/apps.html', '/users.html', '/account-bindings.html', '/tokens.html', '/security.html', '/smtp.html', '/api-docs.html']) {
      const response = await page.goto(f.baseUrl + route);
      assert.equal(response.status(), 200, route);
      await page.waitForLoadState('networkidle');
    }
    await page.goto(`${f.baseUrl}/security.html`);
    await page.locator('#turnstileSiteKey').fill('browser-site-key');
    await page.locator('#turnstileSecretKey').fill('browser-secret-key');
    await page.locator('#saveTurnstileBtn').click();
    await page.getByText('Turnstile 设置已保存，重启后仍然生效').waitFor();
    await page.reload();
    assert.equal(await page.locator('#turnstileSiteKey').inputValue(), 'browser-site-key');
    assert.equal(await page.locator('#turnstileSecretKey').inputValue(), '');
    await page.locator('#clearTurnstile').check();
    await page.locator('#saveTurnstileBtn').click();
    await page.getByText('Turnstile 设置已保存，重启后仍然生效').waitFor();

    await page.goto(`${f.baseUrl}/smtp.html`);
    await page.locator('#hostInput').fill('smtp.browser.test');
    await page.locator('#passwordInput').fill('browser-smtp-password');
    await page.locator('#saveBtn').click();
    await page.getByText('发件设置已保存，重启后仍然生效').waitFor();
    await page.reload();
    assert.equal(await page.locator('#hostInput').inputValue(), 'smtp.browser.test');
    assert.equal(await page.locator('#passwordInput').inputValue(), '');
    assert.match(await page.locator('#passwordHint').innerText(), /已保存密码/);
    assert.deepEqual(errors, [], 'All browser modules should execute without errors');
    assert.deepEqual(blockedScripts, [], 'Application scripts must be compatible with the production CSP');

    f.pool.settings.push({ setting_key: 'captcha_login', setting_value: 'true' });
    await context.clearCookies();
    await page.goto(`${f.baseUrl}/oauth2/authorize`);
    assert.equal(await page.locator('#loginForm [data-captcha-group]').isVisible(), false);
    await page.locator('#loginForm input[name=username]').fill(admin.username);
    await page.locator('#loginForm input[name=password]').fill(admin.clearPassword);
    await page.locator('#loginForm button[type=submit]').click();
    await page.locator('#loginForm [data-captcha-box] img').waitFor();
    const image = await page.locator('#loginForm [data-captcha-box] img').getAttribute('src');
    assert.ok(image.startsWith('data:image/png;base64,'));
    await page.locator('#loginForm input[name=username]').fill(admin.username);
    await page.locator('#loginForm input[name=password]').fill(admin.clearPassword);
    await page.locator('#loginForm input[name=captcha_code]').fill(f.captchaAnswers.at(-1));
    await page.locator('#loginForm button[type=submit]').click();
    await page.waitForURL('**/profile');
    assert.deepEqual(errors, []);
    const artifacts = path.resolve(__dirname, '..', '.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'security-profile.png'), fullPage: true });
    console.log('Browser checks passed: login, CAPTCHA, profile, admin pages and local CSP-compatible scripts');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
