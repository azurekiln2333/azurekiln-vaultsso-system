const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');
const { totpCode } = require('./support/totp-code');

const ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'session-duration');
const VIEWPORTS = [{ width: 1440, height: 1000, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }];
const LOCALES = [
  { locale: 'zh-CN', label: '保持登录' },
  { locale: 'zh-TW', label: '保持登入' },
  { locale: 'en-US', label: 'Keep me signed in' }
];

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';
  const f = await createFixture({ port });
  let browser;
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  try {
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true,
      args: ['--disable-background-networking']
    });

    async function newSession({ viewport = VIEWPORTS[0], locale = 'zh-CN', storageState } = {}) {
      const context = await browser.newContext({ viewport, locale, ...(storageState ? { storageState } : {}) });
      await context.route('**/*', route =>
        new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      return { context, page, errors };
    }

    async function continueToPassword(page, account) {
      await page.locator('#loginUsername').fill(account.username);
      await page.locator('#loginForm .submit').click();
      await page.waitForFunction(() => !document.getElementById('loginPassword').disabled);
    }

    async function submitPassword(page, account, days) {
      await page.locator('#loginSessionDays').selectOption(String(days));
      await continueToPassword(page, account);
      assert.equal(await page.locator('#loginSessionDays').inputValue(), String(days));
      await page.locator('#loginPassword').fill(account.clearPassword);
      const sent = page.waitForRequest(request => request.method() === 'POST'
        && new URL(request.url()).pathname === '/oauth2/authorize'
        && request.headers()['content-type'] === 'application/x-www-form-urlencoded');
      await page.locator('#loginForm .submit').click();
      assert.equal(new URLSearchParams((await sent).postData()).get('session_days'), String(days),
        'The actual credential POST must carry the selected duration');
    }

    async function assertSession(context, account, days) {
      const cookie = (await context.cookies()).find(item => item.name === 'session');
      assert.ok(cookie, 'Successful final authentication must issue a session cookie');
      const claims = jwt.decode(cookie.value);
      assert.equal(claims.sub, account.id);
      assert.equal(claims.session_days, days);
      assert.equal(claims.exp, claims.session_deadline);
      assert.equal(claims.exp - claims.iat, days * 24 * 60 * 60);
      const row = f.pool.sessions.find(item => item.token === claims.sid);
      assert.ok(row && !row.revoked_at);
      assert.equal(new Date(row.expires_at).getTime(), claims.exp * 1000);
      assert.ok(Math.abs(cookie.expires - claims.exp) <= 1, 'The persistent browser cookie must share the signed deadline');
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 200);
      return cookie;
    }

    // Only provider configuration is simulated here. Account discovery, credentials,
    // verification, cookie storage and authentication use the real isolated service.
    const layoutAccount = await f.user();
    const client = await f.client({ requirePkce: false });
    const oauth = new URLSearchParams({ client_id: client.id, redirect_uri: client.redirectUris[0],
      response_type: 'code', scope: 'openid profile', state: 'duration-browser-state', nonce: 'duration-browser-nonce' });
    const returnTo = `/oauth2/authorize?${oauth}`;
    for (const viewport of VIEWPORTS) {
      for (const { locale, label } of LOCALES) {
        const { context, page, errors } = await newSession({ viewport, locale });
        let releaseConfig;
        const configReady = new Promise(resolve => { releaseConfig = resolve; });
        await page.route('**/api/v1/auth/oauth/oidc/config', async route => {
          await configReady;
          await route.fulfill({ json: { enabled: true, providers: [
            { providerName: 'Example One', loginUrl: '/api/v1/auth/oauth/oidc/login?provider=one' },
            { providerName: 'Example Two', loginUrl: '/api/v1/auth/oauth/oidc/login?provider=two' }
          ] } });
        });
        await page.goto(`${f.baseUrl}${returnTo}`);
        await page.locator('#authRegion').waitFor({ state: 'visible' });
        assert.equal(await page.getByLabel(label, { exact: true }).count(), 1);
        const select = page.locator('#loginSessionDays');
        assert.equal(await select.inputValue(), '1');
        assert.deepEqual(await select.locator('option').evaluateAll(options => options.map(option => option.value)), ['1', '7', '14']);
        await select.selectOption('14');
        releaseConfig();
        await page.locator('#oidcProviders a').first().waitFor();
        for (const days of ['14', '7']) {
          await select.selectOption(days);
          const links = await page.locator('#oidcProviders a').evaluateAll(nodes => nodes.map(node => node.href));
          assert.equal(links.length, 2);
          for (const [index, href] of links.entries()) {
            const link = new URL(href);
            assert.equal(link.origin, f.baseUrl, 'The chosen duration belongs only on the local provider initiation URL');
            assert.equal(link.pathname, '/api/v1/auth/oauth/oidc/login');
            assert.equal(link.searchParams.get('session_days'), days);
            assert.equal(link.searchParams.get('provider'), index === 0 ? 'one' : 'two');
            assert.equal(link.searchParams.get('return_to'), returnTo);
          }
        }
        await page.evaluate(() => window.VaultI18n.setLanguage('en'));
        assert.equal(await select.inputValue(), '7', 'Changing language must preserve the choice');
        await page.evaluate(value => window.VaultI18n.setLanguage(value), locale);
        assert.equal(await page.locator('label[for="loginSessionDays"]').innerText(), label);
        assert.equal(await select.isVisible(), true);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(ARTIFACTS, `account-${viewport.tag}-${locale}.png`), fullPage: true });
        await continueToPassword(page, layoutAccount);
        assert.equal(await select.inputValue(), '7', 'Account discovery must preserve the choice');
        assert.equal(await select.isVisible(), true);
        await page.screenshot({ path: path.join(ARTIFACTS, `password-${viewport.tag}-${locale}.png`), fullPage: true });
        await page.locator('#changeLoginAccountBtn').click();
        assert.equal(await select.inputValue(), '7', 'Returning to account entry must preserve the choice');
        assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 401);
        await page.evaluate(() => document.getElementById('loginForm').reset());
        assert.equal(await select.inputValue(), '1');
        await page.waitForFunction(() => [...document.querySelectorAll('#oidcProviders a')]
          .every(link => new URL(link.href).searchParams.get('session_days') === '1'));
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
    console.log('Session duration UI passed: account/password steps, three locales, desktop/mobile, provider hydration/change/reset URLs');

    for (const days of [1, 7, 14]) {
      const account = await f.user();
      const { context, page, errors } = await newSession();
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      await submitPassword(page, account, days);
      await page.waitForURL('**/profile');
      const cookie = await assertSession(context, account, days);
      assert.deepEqual(errors, []);
      await context.close();

      // A fresh browser context receives only the persistent session cookie, with
      // no password, pending challenge, localStorage or sessionStorage restoration.
      const reopened = await newSession({ storageState: { cookies: [cookie], origins: [] } });
      await reopened.page.goto(`${f.baseUrl}/profile`);
      assert.equal(new URL(reopened.page.url()).pathname, '/profile');
      assert.equal((await reopened.context.request.get(`${f.baseUrl}/api/profile`)).status(), 200);
      const retained = (await reopened.context.cookies()).find(item => item.name === 'session');
      assert.equal(retained.value, cookie.value);
      assert.equal(retained.expires, cookie.expires, 'Ordinary activity must not restart the chosen period');
      assert.deepEqual(reopened.errors, []);
      await reopened.context.close();
    }

    // A normal email MFA completion keeps the initial seven days even if the
    // completing client attempts to replace it with fourteen.
    f.reset();
    f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
    const emailAccount = await f.user();
    const email = await newSession({ viewport: VIEWPORTS[1] });
    await email.page.goto(`${f.baseUrl}/oauth2/authorize`);
    await email.page.locator('#authRegion').waitFor({ state: 'visible' });
    await submitPassword(email.page, emailAccount, 7);
    await email.page.waitForURL('**/oauth2/mfa');
    await email.page.waitForFunction(() => !document.getElementById('code').disabled);
    assert.equal((await email.context.request.get(`${f.baseUrl}/api/profile`)).status(), 401);
    await email.page.route('**/api/v1/auth/oauth/oidc/complete', route =>
      route.continue({ postData: JSON.stringify({ ...route.request().postDataJSON(), session_days: 14 }) }));
    await email.page.locator('#code').fill(f.lastCode(emailAccount.email));
    await email.page.waitForURL('**/profile');
    await assertSession(email.context, emailAccount, 7);
    assert.deepEqual(email.errors, []);
    await email.context.close();

    // The original selection also survives a real TOTP -> mandatory mailbox
    // successor challenge; the second page never needs to retain the password.
    f.reset();
    const gateAccount = await f.user();
    const secret = 'JBSWY3DPEHPK3PXP';
    await f.User.update(gateAccount.id, { totpEnabled: true, totpSecret: secret, emailVerified: false });
    const gate = await newSession();
    await gate.page.goto(`${f.baseUrl}/oauth2/authorize`);
    await gate.page.locator('#authRegion').waitFor({ state: 'visible' });
    await submitPassword(gate.page, gateAccount, 14);
    await gate.page.waitForURL('**/oauth2/mfa');
    await gate.page.waitForFunction(() => !document.getElementById('code').disabled);
    const next = gate.page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/auth/oauth/oidc/complete');
    await gate.page.locator('#code').fill(totpCode(secret));
    assert.equal((await (await next).json()).next_step, true);
    await gate.page.locator('#emailGateControls').waitFor({ state: 'visible' });
    assert.equal((await gate.context.request.get(`${f.baseUrl}/api/profile`)).status(), 401);
    await gate.page.locator('#sendEmailGateCodeBtn').click();
    await gate.page.waitForFunction(() => !document.getElementById('code').disabled);
    await gate.page.locator('#code').fill(f.lastCode(gateAccount.email));
    await gate.page.waitForURL('**/profile');
    await assertSession(gate.context, gateAccount, 14);
    assert.deepEqual(gate.errors, []);
    await gate.context.close();
    console.log('Session duration browser checks passed: 1/7/14-day real POST/cookie/deadline, fresh browser context, email override rejection and TOTP/mailbox continuation');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
