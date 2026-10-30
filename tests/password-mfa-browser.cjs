const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');
const { totpCode } = require('./support/totp-code');

// Account-first login: entering the account and pressing the primary action reveals
// the password step. Nothing is submitted for authentication until the password is sent.
async function continueToPassword(page) {
  await page.locator('#loginForm .submit').click();
  await page.waitForFunction(() => {
    const field = document.getElementById('loginPassword');
    return Boolean(field) && !field.disabled && field.getBoundingClientRect().width > 1;
  }, null, { timeout: 15000 });
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
    browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }), headless: true });
    const artifacts = path.resolve(__dirname, '..', '.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      f.reset();
      const context = await browser.newContext({ viewport, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] });
      await context.route('**/*', route => new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let completionPosts = 0;
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/auth/oauth/oidc/complete') {
          completionPosts += 1;
        }
      });
      const completeRequests = () => completionPosts;
      const user = await f.user();
      async function credentials() {
        await page.goto(`${f.baseUrl}/oauth2/authorize`);
        await page.locator('#loginUsername').fill(user.username);
        await continueToPassword(page);
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
      await continueToPassword(page);
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
      assert.equal(await page.locator('#code').getAttribute('autocomplete'), 'one-time-code');
      assert.equal(await page.locator('#code').getAttribute('name'), 'email_code');
      assert.equal(await page.locator('#code').getAttribute('inputmode'), 'numeric');
      assert.equal(await page.locator('[data-code-slot]').count(), 6);
      assert.equal(await page.locator('#recoveryToggle').isVisible(), false);
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 401);
      const emailCode = f.lastCode(user.email);
      const incorrectEmailCode = String((Number(emailCode) + 1) % 1000000).padStart(6, '0');
      // Incomplete input never submits, even when it is reported through both events.
      const initialRequests = completeRequests();
      await page.locator('#code').fill(incorrectEmailCode.slice(0, 5));
      await page.locator('#code').dispatchEvent('change');
      await page.locator('#code').dispatchEvent('input');
      await page.waitForTimeout(150);
      assert.equal(completeRequests() - initialRequests, 0, 'Incomplete codes must not submit');
      assert.equal(await page.locator('#status').innerText(), '');
      // Completing the final digit with a real keypress submits once and shows the
      // localized failure.
      const emailAttempt = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/oauth/oidc/complete'));
      await page.locator('#code').pressSequentially(incorrectEmailCode.slice(5));
      await emailAttempt;
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('验证码不正确'));
      assert.equal(completeRequests() - initialRequests, 1, 'A completed code must submit exactly once');
      assert.equal(await page.locator('#code').inputValue(), '');
      const status = await page.locator('#status').boundingBox();
      assert.ok(status.y >= 0 && status.y + status.height <= viewport.height);
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 401, 'A rejected code must not create a session');
      // Whole-code paste completes the same challenge and navigates on success.
      await page.screenshot({ path: path.join(artifacts, `login-email-page-${viewport.width}.png`) });
      await page.evaluate(value => navigator.clipboard.writeText(value), emailCode);
      await page.locator('#code').press('Control+V');
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
      await continueToPassword(page);
      await page.locator('#loginPassword').fill(oauthUser.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      const pendingCookie = (await context.cookies()).find(cookie => cookie.name === 'oidc_pending');
      assert.ok(pendingCookie && Buffer.byteLength(`${pendingCookie.name}=${pendingCookie.value}`) < 4096,
        'Maximum encoded OAuth state must keep the pending browser cookie within its size limit');
      await page.locator('#code').fill(f.lastCode(oauthUser.email));
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
      await continueToPassword(page);
      await page.locator('#loginPassword').fill(noPkceUser.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      await page.locator('#code').fill(f.lastCode(noPkceUser.email));
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
      assert.equal(await page.locator('#code').getAttribute('name'), 'totp_code',
        'Firefox password managers need an explicit TOTP name when one-time-code is absent from the DOM property');
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 401);

      await page.screenshot({ path: path.join(artifacts, `login-totp-empty-${viewport.width}.png`) });
      // Native editing stays below six digits so no automatic attempt is spent.
      await page.locator('#code').pressSequentially('12345');
      await page.locator('#code').press('Backspace');
      await page.locator('#code').press('ArrowLeft');
      await page.locator('#code').press('Backspace');
      assert.equal(await page.locator('#code').inputValue(), '124');
      assert.equal((await page.locator('[data-code-slot]').allTextContents()).join(''), '124');
      await page.locator('#code').fill('12345');
      const thirdSlot = await page.locator('[data-code-slot]').nth(2).boundingBox();
      await page.mouse.click(thirdSlot.x + thirdSlot.width / 2, thirdSlot.y + thirdSlot.height / 2);
      await page.keyboard.type('9');
      assert.equal(await page.locator('#code').inputValue(), '12945');

      await page.evaluate(() => window.VaultI18n.setLanguage('en'));
      assert.equal(await page.locator('#code').inputValue(), '12945');
      assert.equal(await page.locator('#codeLabel').innerText(), 'Authenticator code');
      await page.screenshot({ path: path.join(artifacts, `login-totp-english-${viewport.width}.png`) });
      if (viewport.width === 390) {
        await page.setViewportSize({ width: 320, height: 740 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(artifacts, 'login-totp-narrow-320.png') });
        await page.setViewportSize(viewport);
      }
      await page.evaluate(() => window.VaultI18n.setLanguage('zh-TW'));
      assert.equal(await page.locator('#codeLabel').innerText(), '驗證器動態碼');
      await page.evaluate(() => window.VaultI18n.setLanguage('zh'));
      // Language rendering with a partial value must not attempt verification.
      const languageRequests = completeRequests();
      await page.evaluate(() => window.VaultI18n.setLanguage('en'));
      await page.evaluate(() => window.VaultI18n.setLanguage('zh'));
      await page.waitForTimeout(150);
      assert.equal(completeRequests() - languageRequests, 0, 'Language changes must not submit');
      assert.equal(await page.locator('#code').inputValue(), '12945');

      // IME composition: the live composing value is neither normalized nor submitted;
      // composition end synchronizes once and attempts exactly once.
      const imeStart = completeRequests();
      await page.evaluate(() => {
        const input = document.getElementById('code');
        input.focus();
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input.value = '654-321';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '654-321' }));
      });
      await page.waitForTimeout(150);
      assert.equal(completeRequests() - imeStart, 0, 'Composition must not submit');
      assert.equal(await page.locator('#code').inputValue(), '654-321', 'Composition must not be normalized');
      const imeAttempt = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/oauth/oidc/complete'));
      await page.evaluate(() => {
        const input = document.getElementById('code');
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '654321' }));
        input.value = '654321';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '654321' }));
      });
      await imeAttempt;
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('验证码不正确'));
      assert.equal(completeRequests() - imeStart, 1, 'Composition end must synchronize and attempt once');
      assert.equal(await page.locator('[data-code-slot]').allTextContents().then(slots => slots.join('')), '', 'Rejected composition clears the slots');

      // Password managers write the whole value and notify either input or change;
      // paired notifications for one completed edit must produce a single attempt.
      await page.screenshot({ path: path.join(artifacts, `login-totp-autofill-${viewport.width}.png`) });
      const autofillCode = totpCode('JBSWY3DPEHPK3PXP');
      const autofillRequests = completeRequests();
      const autofillAttempt = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/oauth/oidc/complete'));
      await page.evaluate(code => {
        const input = document.getElementById('code');
        input.value = code;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, autofillCode);
      await autofillAttempt;
      assert.equal(completeRequests() - autofillRequests, 1, 'Paired input/change must attempt exactly once');
      await page.waitForURL('**/profile');
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 200, 'Autofill completion signs in');

      await context.clearCookies();
      await credentials();
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      await page.locator('#recoveryToggle').click();
      assert.equal(await page.locator('#code').getAttribute('inputmode'), 'text');
      assert.equal(await page.locator('#code').getAttribute('maxlength'), '32');
      assert.equal(await page.locator('#code').getAttribute('name'), 'recovery_code');
      assert.equal(await page.locator('#code').getAttribute('autocomplete'), 'off');
      // Six characters in recovery mode must never auto-submit.
      const recoverySixRequests = completeRequests();
      await page.locator('#code').fill('123456');
      await page.locator('#code').dispatchEvent('change');
      await page.waitForTimeout(150);
      assert.equal(completeRequests() - recoverySixRequests, 0, 'Recovery entry always stays manual');
      await page.locator('#code').fill(recovery);
      const recoveryRequests = completeRequests();
      await page.locator('#code').dispatchEvent('change');
      await page.waitForTimeout(150);
      assert.equal(completeRequests() - recoveryRequests, 0, 'Recovery codes must not submit automatically');
      await page.evaluate(() => window.VaultI18n.setLanguage('en'));
      assert.equal(await page.locator('#code').inputValue(), recovery);
      await page.evaluate(() => window.VaultI18n.setLanguage('zh'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts, `login-totp-page-${viewport.width}.png`) });
      await page.locator('#submit').click();
      await page.waitForURL('**/profile');

      // Hold the completion request open, then prove that duplicate events and a
      // manual submission cannot start a second attempt. The request is released
      // explicitly, and a dedicated account keeps the first-use TOTP step unique.
      await context.clearCookies();
      const heldUser = await f.user();
      const heldSecret = 'KRSXG5CTMVRXEZLU';
      await f.User.update(heldUser.id, { totpEnabled: true, totpSecret: heldSecret });
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#loginUsername').fill(heldUser.username);
      await continueToPassword(page);
      await page.locator('#loginPassword').fill(heldUser.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      let releaseHeld;
      const held = new Promise(resolve => { releaseHeld = resolve; });
      let markRouted;
      const routed = new Promise(resolve => { markRouted = resolve; });
      let heldCount = 0;
      await page.route('**/api/v1/auth/oauth/oidc/complete', async route => {
        heldCount += 1;
        if (heldCount === 1) {
          markRouted();
          await held;
        }
        await route.continue();
      });
      await page.evaluate(code => {
        const input = document.getElementById('code');
        input.value = code;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, totpCode(heldSecret));
      await routed;
      assert.equal(heldCount, 1, 'The completed code reached the completion endpoint once');
      assert.equal(await page.locator('#submit').isDisabled(), true);
      assert.equal(await page.evaluate(() => document.getElementById('code').readOnly), true);
      // Duplicate events and a direct form submission while the request is held must
      // not reach the endpoint again.
      await page.evaluate(code => {
        const input = document.getElementById('code');
        input.value = code;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('mfaForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }, totpCode(heldSecret));
      await page.waitForTimeout(200);
      assert.equal(heldCount, 1, 'A pending attempt blocks duplicate events and manual submission');
      releaseHeld();
      await page.waitForURL('**/profile');
      await page.unroute('**/api/v1/auth/oauth/oidc/complete');
      assert.equal(heldCount, 1);

      // A rejected code clears the field; re-entering the identical code retries.
      await context.clearCookies();
      const retryUser = await f.user();
      const retrySecret = 'MFRGGZDFMZTWQ2LK';
      await f.User.update(retryUser.id, { totpEnabled: true, totpSecret: retrySecret });
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#loginUsername').fill(retryUser.username);
      await continueToPassword(page);
      await page.locator('#loginPassword').fill(retryUser.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      const retryStart = completeRequests();
      const rejectedCode = '111111';
      async function submitAutomatically(code) {
        const responded = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/oauth/oidc/complete'));
        await page.locator('#code').fill(code);
        await responded;
        await page.waitForFunction(() => document.getElementById('status').textContent.includes('验证码不正确'));
        assert.equal(await page.locator('#code').inputValue(), '');
      }
      await submitAutomatically(rejectedCode);
      assert.equal(completeRequests() - retryStart, 1);
      await submitAutomatically(rejectedCode);
      assert.equal(completeRequests() - retryStart, 2, 'The same code must be retried after a rejection');
      // Correcting the code completes the flow through the same automatic path.
      const retrySuccess = page.waitForResponse(response => response.url().endsWith('/api/v1/auth/oauth/oidc/complete'));
      await page.locator('#code').fill(totpCode(retrySecret));
      await retrySuccess;
      await page.waitForURL('**/profile');
      assert.equal(completeRequests() - retryStart, 3);

      await context.clearCookies();
      await credentials();
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/oauth2/mfa');
      await page.waitForFunction(() => !document.getElementById('code').disabled);
      await page.locator('#recoveryToggle').click();
      await page.locator('#code').fill('incorrect-recovery');
      await page.locator('#recoveryToggle').click();
      assert.equal(await page.locator('#code').inputValue(), '');
      assert.equal(await page.locator('#code').getAttribute('autocomplete'), 'one-time-code');
      assert.equal(await page.locator('#code').getAttribute('name'), 'totp_code');
      assert.equal(await page.locator('#code').getAttribute('inputmode'), 'numeric');
      await context.clearCookies();
      await page.locator('#code').fill('123456');
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('已过期'));
      assert.equal(await page.locator('#code').isDisabled(), true);
      assert.equal(await page.locator('#submit').isDisabled(), true);
      assert.equal(await page.locator('#recoveryToggle').isDisabled(), true);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Password verification browser checks passed: CAPTCHA, email typing/paste auto-verify, incomplete input, TOTP autofill, request locking, same-code retry, recovery manual, expiry, i18n, OAuth nonce/state/PKCE, desktop/mobile');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
