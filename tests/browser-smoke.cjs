const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

// Account-first login: the primary action advances from account entry to the password step.
async function continueToPassword(page) {
  await page.locator('#loginForm button[type=submit]').click();
  await page.waitForFunction(() => {
    const field = document.querySelector('#loginForm input[name=password]');
    return Boolean(field) && !field.disabled && field.getBoundingClientRect().width > 1;
  }, null, { timeout: 15000 });
}

async function checkSmtpErrors(page, fixture) {
  const endpoint = '**/api/admin/smtp/test';
  const cases = [
    { status: 502, contentType: 'text/html', body: '<html><title>502 Bad Gateway</title><body>nginx</body></html>', expected: /网关/ },
    { status: 504, contentType: 'text/html', body: '<html><title>504 Gateway Timeout</title></html>', expected: /超时/ },
    { status: 503, contentType: 'text/plain', body: 'upstream connection refused', expected: /upstream connection refused/ },
    { status: 429, contentType: 'text/plain', body: '', expected: /过于频繁/ },
    { status: 404, contentType: 'text/html', body: '<html>Cannot POST /api/admin/smtp/test</html>', expected: /接口不存在/ },
    { status: 500, contentType: 'application/json', body: '{broken', expected: /服务器/ },
    { status: 502, contentType: 'application/json', body: JSON.stringify({ error_description: { message: 'invalid shape' } }), expected: /网关/ },
    { status: 200, contentType: 'text/html', body: '<html><body>Sign in</body></html>', expected: /响应异常/ },
    { status: 200, contentType: 'application/json', body: '', expected: /响应异常/ },
    { status: 200, contentType: 'application/json', body: 'null', expected: /响应异常/ },
    { status: 200, contentType: 'application/json', body: '[]', expected: /响应异常/ }
  ];
  await page.locator('#testToInput').fill('smtp-errors@example.test');
  for (const scenario of cases) {
    const { expected, ...response } = scenario;
    await page.route(endpoint, route => route.fulfill(response));
    await page.locator('#testBtn').click();
    await page.waitForFunction(() => !document.getElementById('testBtn').disabled);
    const message = await page.locator('#statusBar').innerText();
    assert.match(message, new RegExp(`HTTP ${scenario.status}`), 'SMTP failure retains the HTTP status');
    assert.match(message, expected);
    assert.doesNotMatch(message, /JSON|SyntaxError|unexpected|<html|\[object Object\]/i);
    assert.match(await page.locator('#statusBar').getAttribute('class'), /admin-status-error/);
    await page.unroute(endpoint);
  }

  await page.route(endpoint, route => route.abort('failed'));
  await page.locator('#testBtn').click();
  await page.waitForFunction(() => !document.getElementById('testBtn').disabled);
  assert.match(await page.locator('#statusBar').innerText(), /网络请求失败/);
  await page.unroute(endpoint);

  // Exercise the actual backend error contract and a successful retry, without external SMTP.
  fixture.failNextMail(new Error('Invalid login: 535 Authentication failed <smtp-error>'));
  await page.locator('#testBtn').click();
  await page.waitForFunction(() => !document.getElementById('testBtn').disabled);
  assert.match(await page.locator('#statusBar').innerText(), /发送失败：Invalid login: 535 Authentication failed <smtp-error>/);
  assert.equal(await page.locator('#statusBar smtp-error').count(), 0, 'SMTP errors are rendered as text');
  await page.locator('#testBtn').click();
  await page.waitForFunction(() => !document.getElementById('testBtn').disabled);
  assert.match(await page.locator('#statusBar').innerText(), /测试邮件已发送到 smtp-errors@example.test/);
  assert.match(await page.locator('#statusBar').getAttribute('class'), /admin-status-success/);

  // HTML authentication failures must be handled before attempting to parse the body.
  await page.route('**/oauth2/authorize', route => route.fulfill({ contentType: 'text/html', body: 'Please sign in' }));
  await page.route(endpoint, route => route.fulfill({ status: 401, contentType: 'text/html', body: '<html>Unauthorized</html>' }));
  await page.locator('#testBtn').click();
  await page.waitForURL('**/oauth2/authorize');
  await page.unroute(endpoint);
  await page.unroute('**/oauth2/authorize');
  await page.goto(`${fixture.baseUrl}/smtp.html`);
  await page.locator('#statusBar.admin-status-info').waitFor();
  await page.locator('#testToInput').fill('smtp-errors@example.test');
  await page.route(endpoint, route => route.fulfill({ status: 403, contentType: 'text/html', body: '<html>Forbidden</html>' }));
  await page.locator('#testBtn').click();
  await page.waitForURL('**/oauth2/error?error=access_denied');
  await page.unroute(endpoint);
}

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
    await continueToPassword(page);
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
    await checkSmtpErrors(page, f);
    assert.deepEqual(errors, [], 'All browser modules should execute without errors');
    assert.deepEqual(blockedScripts, [], 'Application scripts must be compatible with the production CSP');

    f.pool.settings.push({ setting_key: 'captcha_login', setting_value: 'true' });
    await context.clearCookies();
    await page.goto(`${f.baseUrl}/oauth2/authorize`);
    assert.equal(await page.locator('#loginForm [data-captcha-group]').isVisible(), false);
    await page.locator('#loginForm input[name=username]').fill(admin.username);
    await continueToPassword(page);
    await page.locator('#loginForm input[name=password]').fill(admin.clearPassword);
    await page.locator('#loginForm button[type=submit]').click();
    await page.locator('#loginForm [data-captcha-box] img').waitFor();
    const image = await page.locator('#loginForm [data-captcha-box] img').getAttribute('src');
    assert.ok(image.startsWith('data:image/png;base64,'));
    await page.locator('#loginForm input[name=password]').fill(admin.clearPassword);
    await page.locator('#loginForm input[name=captcha_code]').fill(f.captchaAnswers.at(-1));
    await page.locator('#loginForm button[type=submit]').click();
    await page.waitForURL('**/profile');
    await page.locator('#avatarEditBtn').click();
    assert.equal(await page.locator('#profileModal').isVisible(), true);
    await page.locator('#profileModal [data-close-modal]').first().click();
    await page.locator('.profile-language-menu summary').click();
    await page.locator('[data-language-switch="en"]').click();
    assert.equal(await page.locator('.profile-navigation a').first().innerText(), 'Profile');
    await page.locator('.profile-language-menu summary').click();
    await page.locator('[data-language-switch="zh"]').click();
    assert.deepEqual(errors, []);
    const artifacts = path.resolve(__dirname, '..', '.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'security-profile.png'), fullPage: true });
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Profile fits the ${width}px viewport`);
      if (width === 390) await page.screenshot({ path: path.join(artifacts, 'security-profile-mobile.png'), fullPage: true });
    }
    console.log('Browser checks passed: login, CAPTCHA, profile, admin pages and local CSP-compatible scripts');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
