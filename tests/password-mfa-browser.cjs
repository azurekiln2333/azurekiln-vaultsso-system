const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
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
    browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }), headless: true });
    const artifacts = path.resolve(__dirname, '..', '.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      f.reset();
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.route('**/*', route => new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const user = await f.user();
      async function credentials() {
        await page.goto(`${f.baseUrl}/oauth2/authorize`);
        await page.locator('#loginUsername').fill(user.username);
        await page.locator('#loginPassword').fill(user.clearPassword);
        assert.equal(await page.locator('#loginForm [data-captcha-group]').isVisible(), false);
        assert.equal(await page.locator('#loginForm input[name="totp_code"], #loginForm input[name="email_code"]').count(), 0);
      }
      f.pool.settings.push({ setting_key: 'captcha_login', setting_value: 'true' });
      await credentials();
      await page.locator('#loginForm .submit').click();
      await page.locator('#loginForm [data-captcha-box] img').waitFor();
      assert.ok((await page.locator('#loginForm [data-captcha-box] img').getAttribute('src')).startsWith('data:image/png;base64,'));
      await page.screenshot({ path: path.join(artifacts, `login-captcha-demand-${viewport.width}.png`) });
      await page.locator('#loginForm input[name="captcha_code"]').fill(f.captchaAnswers.at(-1));
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/profile');

      await context.clearCookies();
      f.pool.settings.length = 0;
      const noPkceUser = await f.user();
      const noPkceClient = await f.client({ requirePkce: false });
      noPkceClient.redirectUris = [`${f.baseUrl}/browser-oauth-callback`];
      await f.Client.update(noPkceClient.id, { redirectUris: noPkceClient.redirectUris });
      const noPkceState = crypto.randomBytes(24).toString('base64url');
      const noPkceParams = new URLSearchParams({
        client_id: noPkceClient.id, redirect_uri: noPkceClient.redirectUris[0],
        scope: 'openid', response_type: 'code', state: noPkceState
      });
      await page.goto(`${f.baseUrl}/oauth2/authorize?${noPkceParams}`);
      assert.deepEqual(await page.locator('#loginForm').evaluate(form => {
        const data = new FormData(form);
        return [data.has('code_challenge'), data.has('code_challenge_method')];
      }), [false, false]);
      await page.locator('#loginUsername').fill(noPkceUser.username);
      await page.locator('#loginPassword').fill(noPkceUser.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL(`${noPkceClient.redirectUris[0]}?**`);
      const noPkceCallback = new URL(page.url());
      assert.equal(noPkceCallback.searchParams.get('state'), noPkceState);
      const noPkceToken = await f.exchange(noPkceClient, { code: noPkceCallback.searchParams.get('code') });
      assert.equal(noPkceToken.status, 200, JSON.stringify(noPkceToken.body));

      await context.clearCookies();
      f.pool.settings.length = 0;
      f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
      await credentials();
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      assert.equal(await page.locator('input[name="password"]').count(), 0);
      assert.ok(!(await page.content()).includes(user.clearPassword));
      assert.ok((await page.locator('#instructions').innerText()).includes('@'));
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 401);
      await page.locator('#code').fill('wrong');
      await page.locator('#submit').click();
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('验证码不正确'));
      const status = await page.locator('#status').boundingBox();
      assert.ok(status.y >= 0 && status.y + status.height <= viewport.height);
      await page.locator('#code').fill(f.lastCode(user.email));
      await page.screenshot({ path: path.join(artifacts, `login-email-page-${viewport.width}.png`) });
      await page.locator('#submit').click();
      await page.waitForURL('**/profile');

      await context.clearCookies();
      const oauthUser = await f.user();
      const client = await f.client();
      client.redirectUris = [`${f.baseUrl}/browser-oauth-callback`];
      await f.Client.update(client.id, { redirectUris: client.redirectUris });
      const verifier = crypto.randomBytes(32).toString('base64url');
      const nonce = crypto.randomBytes(24).toString('base64url');
      const state = '%'.repeat(2048);
      const oauth = new URLSearchParams({ client_id: client.id, redirect_uri: client.redirectUris[0],
        scope: 'openid email', response_type: 'code', nonce, state,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      await page.goto(`${f.baseUrl}/oauth2/authorize?${oauth}`);
      await page.locator('#loginUsername').fill(oauthUser.username);
      await page.locator('#loginPassword').fill(oauthUser.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      const pendingCookie = (await context.cookies()).find(cookie => cookie.name === 'oidc_pending');
      assert.ok(pendingCookie && Buffer.byteLength(`${pendingCookie.name}=${pendingCookie.value}`) < 4096,
        'Maximum encoded OAuth state must keep the pending browser cookie within its size limit');
      await page.locator('#code').fill(f.lastCode(oauthUser.email));
      await page.locator('#submit').click();
      await page.waitForURL(`${client.redirectUris[0]}?**`);
      const callback = new URL(page.url());
      assert.equal(callback.searchParams.get('state'), state);
      const exchanged = await f.exchange(client, { code: callback.searchParams.get('code'), verifier });
      assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
      assert.equal(jwt.decode(exchanged.body.id_token).nonce, nonce, 'Real browser MFA preserves the original OIDC nonce');

      await context.clearCookies();
      const noPkceMfaParams = new URLSearchParams(noPkceParams);
      const noPkceMfaState = crypto.randomBytes(24).toString('base64url');
      noPkceMfaParams.set('state', noPkceMfaState);
      await page.goto(`${f.baseUrl}/oauth2/authorize?${noPkceMfaParams}`);
      await page.locator('#loginUsername').fill(noPkceUser.username);
      await page.locator('#loginPassword').fill(noPkceUser.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      await page.locator('#code').fill(f.lastCode(noPkceUser.email));
      await page.locator('#submit').click();
      await page.waitForURL(`${noPkceClient.redirectUris[0]}?**`);
      const noPkceMfaCallback = new URL(page.url());
      assert.equal(noPkceMfaCallback.searchParams.get('state'), noPkceMfaState);
      const noPkceMfaToken = await f.exchange(noPkceClient, { code: noPkceMfaCallback.searchParams.get('code') });
      assert.equal(noPkceMfaToken.status, 200, JSON.stringify(noPkceMfaToken.body));

      await context.clearCookies();
      f.pool.settings.length = 0;
      const recovery = 'ABCD2345EFGH6789';
      await f.User.update(user.id, { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP',
        recoveryCodes: JSON.stringify([crypto.createHash('sha256').update(recovery).digest('hex')]) });
      await credentials();
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      assert.ok((await page.locator('#instructions').innerText()).includes('验证器'));
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 401);
      await page.locator('#code').fill(recovery);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, `login-totp-page-${viewport.width}.png`) });
      await page.locator('#submit').click();
      await page.waitForURL('**/profile');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Password verification browser checks passed: on-demand CAPTCHA, separate email/TOTP pages, OAuth nonce/state/PKCE, desktop/mobile');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
