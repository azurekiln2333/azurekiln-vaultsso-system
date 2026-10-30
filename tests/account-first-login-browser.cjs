// Account-first login browser regression: real Continue interaction, first-password
// setup, localized missing accounts, stale responses, and OAuth/MFA continuation.
// Isolated in-memory fixture only (memory DB, stubbed mail, no real SMTP).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

const ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'account-first-login');
const VIEWPORTS = [{ width: 1440, height: 1000, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }];
const MISSING_ACCOUNT_LOCALES = [
  { locale: 'zh-CN', message: '账号不存在' },
  { locale: 'en-US', message: 'Account does not exist' },
  { locale: 'zh-TW', message: '帳號不存在' }
];

// Mirrors server maskEmail() so the masked destination can be asserted exactly.
function expectedMask(email) {
  const at = email.indexOf('@');
  if (at <= 0) return email;
  const local = email.slice(0, at);
  return `${local.length <= 2 ? `${local[0]}*` : `${local.slice(0, 2)}***`}${email.slice(at)}`;
}
function newPassword() {
  return `Aa1-${crypto.randomBytes(9).toString('hex')}`;
}

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';

  // Remove TURNSTILE keys so these checks exercise the on-demand image CAPTCHA path only.
  const savedTurnstile = { site: process.env.TURNSTILE_SITE_KEY, secret: process.env.TURNSTILE_SECRET_KEY };
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;

  const f = await createFixture({ port });
  let browser;
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  try {
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true,
      args: ['--disable-background-networking']
    });

    // Passwordless account: User.create stores '' for an absent password.
    async function passwordlessUser({ email } = {}) {
      const username = `account-${crypto.randomUUID()}`;
      const address = email || `${username}@example.test`;
      const record = await f.User.create({ username, email: address, password: '', role: 'user', emailVerified: true });
      return { ...record, email: address };
    }
    async function sessionCount() {
      return f.pool.sessions.length;
    }
    async function newSession(viewport, locale = 'zh-CN') {
      const context = await browser.newContext({ viewport, locale });
      await context.route('**/*', route =>
        new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      return { context, page, errors };
    }
    async function expectAnonymous(context, label) {
      const response = await context.request.get(`${f.baseUrl}/api/profile`);
      assert.equal(response.status(), 401, `${label}: no session may exist before authentication completes`);
    }
    // Real Continue interaction: account only, then explicit password step.
    async function continueWithAccount(page, identifier) {
      await page.locator('#loginUsername').fill(identifier);
      await page.locator('#loginForm .submit').click();
    }
    async function waitPasswordStep(page) {
      await page.waitForFunction(() => {
        const field = document.getElementById('loginPassword');
        if (!field || field.disabled) return false;
        const box = field.getBoundingClientRect();
        return box.width > 1 && box.height > 1;
      }, null, { timeout: 15000 });
    }
    async function waitSetupStep(page) {
      await page.locator('#passwordSetupForm').waitFor({ state: 'visible', timeout: 15000 });
    }
    async function waitContactStep(page) {
      await page.locator('#loginContactAdmin').waitFor({ state: 'visible', timeout: 15000 });
    }
    async function waitAccountStep(page) {
      await page.waitForFunction(() => {
        const username = document.getElementById('loginUsername');
        const password = document.getElementById('loginPassword');
        return Boolean(username) && username.offsetParent !== null && Boolean(password) && password.disabled;
      }, null, { timeout: 15000 });
    }
    function hiddenOAuthFields(page) {
      return page.locator('#loginForm').evaluate(form => {
        const keys = ['client_id', 'redirect_uri', 'scope', 'response_type', 'nonce', 'state',
          'code_challenge', 'code_challenge_method'];
        const data = new FormData(form);
        return Object.fromEntries(keys.map(key => [key, data.get(key) === null ? '' : String(data.get(key))]));
      });
    }
    async function seedResetCode(account) {
      const seeded = await f.request('/api/email-verification/send', {
        method: 'POST', data: { username: account.username, purpose: 'password_reset' }
      });
      assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
      return f.lastCode(account.email);
    }
    async function currentStep(page) {
      return page.evaluate(() => {
        const visible = element => Boolean(element) && element.offsetParent !== null;
        const password = document.getElementById('loginPassword');
        if (visible(document.getElementById('passwordSetupForm'))) return 'setup';
        if (visible(document.getElementById('loginContactAdmin'))) return 'contact';
        if (visible(password) && !password.disabled) return 'password';
        return 'account';
      });
    }
    async function shot(page, viewport, name) {
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
        assert.fail(`${name}: horizontal overflow at ${viewport.width}px`);
      }
      await page.screenshot({ path: path.join(ARTIFACTS, `${name}-${viewport.tag}-${viewport.width}.png`) });
    }
    async function signInWithPassword(page, identifier, password) {
      await continueWithAccount(page, identifier);
      await waitPasswordStep(page);
      await page.locator('#loginPassword').fill(password);
      await page.locator('#loginForm .submit').click();
    }

    for (const viewport of VIEWPORTS) {
      // ── 1. Account step requires no password; Continue advances ──────────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await f.user();
        const accountLabel = (await page.locator('#loginForm .submit').innerText()).trim();
        const passwordState = await page.locator('#loginPassword').evaluate(field => ({
          disabled: field.disabled,
          required: field.required,
          visible: field.getBoundingClientRect().width > 1
        }));
        assert.equal(passwordState.disabled || !passwordState.visible, true,
          'password must not be editable at the account step');
        assert.equal(passwordState.required, false, 'password must not be required at the account step');
        await shot(page, viewport, 'account-step');

        await continueWithAccount(page, account.username);
        await waitPasswordStep(page);
        const passwordLabel = (await page.locator('#loginForm .submit').innerText()).trim();
        assert.notEqual(passwordLabel, accountLabel, 'the primary action label must follow the current step');
        assert.equal(await page.locator('#loginPassword').isEditable(), true);
        assert.equal((await sessionCount()), 0, 'Continue must not create a session');
        await expectAnonymous(context, 'continue');
        await shot(page, viewport, 'password-step');

        await page.locator('#loginPassword').fill(account.clearPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/profile');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // Zero-match usernames/emails stay editable and report the real localized 404.
      for (const { locale, message } of MISSING_ACCOUNT_LOCALES) {
        for (const kind of ['username', 'email']) {
          f.reset();
          const account = await f.user();
          const missingName = `missing-${crypto.randomUUID()}`;
          const identifier = kind === 'email' ? `${missingName}@example.test` : missingName;
          const { context, page, errors } = await newSession(viewport, locale);
          const requests = [];
          page.on('request', request => {
            const url = new URL(request.url());
            // Initial configuration/session reads can finish after the form is ready.
            if (request.method() === 'GET' && ['/api/profile', '/api/auth/config',
              '/api/v1/auth/oauth/oidc/config'].includes(url.pathname)) return;
            if (url.origin === f.baseUrl && /^\/(api|oauth2)\//.test(url.pathname)) {
              requests.push(`${request.method()} ${url.pathname}`);
            }
          });
          const actionLabel = (await page.locator('#loginForm .submit').innerText()).trim();
          const [missingResponse] = await Promise.all([
            page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === '/oauth2/authorize'),
            continueWithAccount(page, identifier)
          ]);
          assert.equal(missingResponse.status(), 404, `${locale}/${kind}: real discovery must reject absence`);
          assert.deepEqual(await missingResponse.json(), {
            error: 'account_not_found', error_key: 'auth.account_not_found', error_description: '账号不存在'
          });
          assert.deepEqual(missingResponse.request().postDataJSON(), {
            discover_account: true, username: identifier
          }, 'Continue must only submit account discovery, without credentials');
          assert.equal(missingResponse.headers()['set-cookie'], undefined, 'discovery must not set a cookie');
          await page.waitForFunction(expected =>
            document.getElementById('statusMessage').textContent.trim() === expected, message);
          // Observe a settled failure before editing: no automatic retry, send or pending request.
          await page.waitForTimeout(500);
          assert.deepEqual(requests, ['POST /oauth2/authorize'], 'missing discovery must not trigger a follow-up');
          assert.equal(await currentStep(page), 'account');
          assert.equal(await page.locator('#loginUsername').isEditable(), true);
          assert.equal(await page.locator('#loginUsername').inputValue(), identifier);
          assert.equal(await page.locator('#loginPassword').isVisible(), false);
          assert.equal(await page.locator('#loginPassword').isDisabled(), true);
          assert.equal(await page.locator('#loginPassword').evaluate(field => field.required), false);
          assert.equal((await page.locator('#loginForm .submit').innerText()).trim(), actionLabel);
          const feedback = await page.locator('#statusMessage').boundingBox();
          assert.ok(feedback && feedback.y >= 0 && feedback.y + feedback.height <= viewport.height + 1,
            `${locale}/${kind}: localized missing-account feedback must be visible`);
          assert.equal(f.mails.length, 0, 'missing discovery must never send mail');
          for (const table of ['sessions', 'authCodes', 'accessTokens', 'refreshTokens', 'emailVerificationCodes']) {
            assert.equal(f.pool[table].length, 0, `missing discovery must not create ${table}`);
          }
          assert.equal((await context.cookies()).some(cookie =>
            cookie.name === 'session' || cookie.name === 'oidc_pending'), false,
          'missing discovery must leave no session or pending cookie');
          await expectAnonymous(context, `${locale}/${kind}`);
          const pending = await context.request.get(`${f.baseUrl}/api/v1/auth/oauth/oidc/pending`);
          assert.equal(pending.status(), 401, 'missing discovery must not create pending login state');
          await shot(page, viewport, `missing-${kind}-${locale}`);

          // A real account can be entered immediately after the failed discovery.
          const [knownResponse] = await Promise.all([
            page.waitForResponse(response => response.request().method() === 'POST'
              && new URL(response.url()).pathname === '/oauth2/authorize'),
            continueWithAccount(page, account.username)
          ]);
          assert.equal(knownResponse.status(), 200);
          assert.deepEqual(await knownResponse.json(), { next: 'password' });
          await waitPasswordStep(page);
          assert.equal(await page.locator('#loginUsername').inputValue(), account.username);
          assert.equal(await page.locator('#loginPassword').isEditable(), true);
          assert.deepEqual(requests, ['POST /oauth2/authorize', 'POST /oauth2/authorize']);
          assert.equal(f.mails.length, 0);
          assert.equal(await sessionCount(), 0, 'correcting the account still requires password authentication');
          assert.deepEqual(errors, []);
          await context.close();
        }
      }

      // ── 2. Passwordless account by username: masked email + manual send ──────
      f.reset();
      const setupPassword = newPassword();
      let setupUsername;
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await passwordlessUser();
        setupUsername = account.username;
        await continueWithAccount(page, account.username);
        await waitSetupStep(page);

        assert.equal(await page.locator('#setupEmailMasked').innerText(), expectedMask(account.email),
          'the masked destination must be shown and unmasked parts must not leak');
        assert.equal(await page.locator('#setupEmailMasked').innerText().then(text => text.includes(account.email)), false);
        assert.equal(f.mails.length, 0, 'discovery must never send mail');
        assert.equal(await sessionCount(), 0, 'discovery must never create a session');
        await expectAnonymous(context, 'discovery');
        await shot(page, viewport, 'setup-step');

        // Explicit send action is the only thing that may deliver a code.
        const feedbackBeforeSend = await page.locator('#statusMessage').innerText();
        await page.locator('#sendSetupCodeBtn').click();
        await page.waitForFunction(previous => {
          const node = document.getElementById('statusMessage');
          const text = node ? node.textContent.trim() : '';
          return text.length > 0 && text !== previous.trim();
        }, feedbackBeforeSend);
        assert.equal(f.mails.length, 1, 'the explicit send action delivers exactly one code');
        assert.equal(f.mails[0].to, account.email, 'the server-side account email is the destination');
        const maskedInBody = (await page.locator('body').innerText()).includes(account.email);
        assert.equal(maskedInBody, false, 'the raw email must not be rendered or returned to the page');
        await shot(page, viewport, 'setup-code-sent');

        // Successful first-password setup returns to password entry without logging in.
        const feedbackBeforeSetup = await page.locator('#statusMessage').innerText();
        await page.locator('#setupEmailCode').fill(f.lastCode(account.email));
        await page.locator('#setupPassword').fill(setupPassword);
        await page.locator('#setupConfirmPassword').fill(setupPassword);
        await page.locator('#passwordSetupForm button[type=submit], #passwordSetupForm .submit').first().click();
        await waitPasswordStep(page);
        await page.waitForFunction(previous => {
          const node = document.getElementById('statusMessage');
          const text = node ? node.textContent.trim() : '';
          return text.length > 0 && text !== previous.trim();
        }, feedbackBeforeSetup);
        assert.equal(await sessionCount(), 0, 'first-password setup must not log the user in');
        await expectAnonymous(context, 'setup-complete');
        assert.equal(await page.locator('#loginUsername').inputValue(), account.username,
          'the same account stays selected after setup');
        await shot(page, viewport, 'setup-complete');

        // The new password authenticates through the ordinary two-step login.
        await page.locator('#loginPassword').fill(setupPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/profile');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 3. Passwordless account entered as email ────────────────────────────
      f.reset();
      {
        const { context, page } = await newSession(viewport);
        const account = await passwordlessUser();
        await continueWithAccount(page, account.email);
        await waitSetupStep(page);
        assert.equal(await page.locator('#setupEmailMasked').innerText(), expectedMask(account.email));
        assert.equal(f.mails.length, 0);
        await shot(page, viewport, 'setup-by-email');
        await context.close();
      }

      // ── 4. No usable mailbox → contact administrator, no send action ────────
      f.reset();
      {
        const { context, page } = await newSession(viewport);
        const synthetic = `account-${crypto.randomUUID()}@users.invalid`;
        const account = await passwordlessUser({ email: synthetic });
        await continueWithAccount(page, account.username);
        await waitContactStep(page);
        const contactText = await page.locator('#loginContactAdmin').innerText();
        assert.match(contactText, /联系管理员/, 'the contact-administrator instruction must be visible');
        assert.equal(await page.locator('#sendSetupCodeBtn').isVisible(), false,
          'no send-code action may be offered without a usable mailbox');
        assert.equal(await page.locator('#passwordSetupForm').isVisible(), false,
          'the setup form must not be offered without a usable mailbox');
        assert.equal(f.mails.length, 0, 'no mail may be attempted for a placeholder mailbox');
        assert.equal(await sessionCount(), 0);
        await expectAnonymous(context, 'contact-admin');
        await shot(page, viewport, 'contact-admin');

        // Returning to account entry clears the branch.
        await page.locator('#changeLoginAccountBtn').click();
        await page.waitForFunction(() => document.getElementById('loginContactAdmin').hidden
          || getComputedStyle(document.getElementById('loginContactAdmin')).display === 'none'
          || !document.getElementById('loginContactAdmin').offsetParent);
        assert.equal(await page.locator('#loginUsername').isVisible(), true);
        await context.close();
      }

      // ── 5. Password account + MFA + OAuth state/nonce/PKCE ─────────────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await f.user();
        const client = await f.client();
        client.redirectUris = [`${f.baseUrl}/browser-oauth-callback`];
        await f.Client.update(client.id, { redirectUris: client.redirectUris });
        f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });

        const verifier = crypto.randomBytes(32).toString('base64url');
        const nonce = crypto.randomBytes(24).toString('base64url');
        const state = crypto.randomBytes(24).toString('base64url');
        const params = new URLSearchParams({
          client_id: client.id, redirect_uri: client.redirectUris[0], scope: 'openid email',
          response_type: 'code', nonce, state,
          code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256'
        });
        await page.goto(`${f.baseUrl}/oauth2/authorize?${params}`);
        await page.locator('#authRegion').waitFor({ state: 'visible' });

        // Hidden OAuth parameters survive the account step.
        await continueWithAccount(page, account.username);
        await waitPasswordStep(page);
        const carried = await page.locator('#loginForm').evaluate(form => {
          const data = new FormData(form);
          return Object.fromEntries([...data.entries()].filter(([, value]) => value !== ''));
        });
        for (const key of ['client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'response_type',
          'code_challenge', 'code_challenge_method']) {
          assert.equal(carried[key], params.get(key), `hidden OAuth field ${key} must survive the account step`);
        }
        await shot(page, viewport, 'oauth-password-step');

        await page.locator('#loginPassword').fill(account.clearPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/oauth2/mfa');
        assert.equal(await sessionCount(), 0, 'no session before the second factor');
        await page.waitForFunction(() => !document.getElementById('code').disabled);
        await page.locator('#code').fill(f.lastCode(account.email));
        await page.waitForURL(`${client.redirectUris[0]}?**`);
        const callback = new URL(page.url());
        assert.equal(callback.searchParams.get('state'), state, 'OAuth state must survive the two-step login');
        const exchanged = await f.exchange(client, { code: callback.searchParams.get('code'), verifier });
        assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
        assert.equal(require('jsonwebtoken').decode(exchanged.body.id_token).nonce, nonce);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 6. Late discovery response cannot change the current account ────────
      f.reset();
      {
        const { context, page } = await newSession(viewport);
        const first = await passwordlessUser();
        const second = await passwordlessUser();
        let release;
        let held = false;
        await page.route('**/oauth2/authorize', async route => {
          const body = route.request().postData() || '';
          if (!held && body.includes('discover_account') && body.includes(first.username)) {
            held = true;
            await new Promise(resolve => { release = resolve; });
          }
          return route.continue();
        });
        await continueWithAccount(page, first.username);   // held at the server
        for (let attempt = 0; attempt < 100 && !release; attempt += 1) await page.waitForTimeout(50);
        assert.ok(release, 'the first discovery request must be intercepted before the account changes');
        // While the first discovery is still in flight the account may be changed.
        await page.locator('#loginUsername').fill(second.username);
        release();
        await page.waitForTimeout(800);
        assert.equal(await page.locator('#passwordSetupForm').isVisible(), false,
          'a discovery response for another account must not open the setup step');
        assert.equal(await page.locator('#loginContactAdmin').isVisible(), false,
          'a discovery response for another account must not open the contact branch');
        assert.equal(await page.locator('#loginUsername').inputValue(), second.username,
          'the stale response must not rewrite the entered account');
        await page.waitForFunction(() => {
          const button = document.querySelector('#loginForm .submit');
          return button && !button.disabled;
        });
        await page.locator('#loginForm .submit').click();
        await waitSetupStep(page);
        assert.equal(await page.locator('#setupEmailMasked').innerText(), expectedMask(second.email),
          'the visible step must belong to the account that was actually submitted');
        await page.unroute('**/oauth2/authorize');
        await shot(page, viewport, 'stale-discovery');
        await context.close();
      }

      // ── 7. Changing account clears setup inputs ────────────────────────────
      f.reset();
      {
        const { context, page } = await newSession(viewport);
        const account = await passwordlessUser();
        await continueWithAccount(page, account.username);
        await waitSetupStep(page);
        await page.locator('#setupEmailCode').fill('123456');
        await page.locator('#setupPassword').fill('temporary-value-1');
        await page.locator('#changeLoginAccountBtn').click();
        await page.waitForFunction(() => document.getElementById('loginUsername').offsetParent !== null);
        await continueWithAccount(page, account.username);
        await waitSetupStep(page);
        assert.equal(await page.locator('#setupEmailCode').inputValue(), '', 'stale setup code must be cleared');
        assert.equal(await page.locator('#setupPassword').inputValue(), '', 'stale setup password must be cleared');
        await context.close();
      }

      // ── 8. Ordinary forgot-password recovery stays reachable at the password step ─
      f.reset();
      {
        const { context, page } = await newSession(viewport);
        const account = await f.user();
        assert.equal(await page.locator('#showRecoveryBtn').isVisible(), false,
          'forgot-password must not be offered before the account is entered');
        await continueWithAccount(page, account.username);
        await waitPasswordStep(page);
        await page.locator('#showRecoveryBtn').click();
        await page.locator('#recoverForm').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#recoverForm input[name=email]').inputValue(), account.username,
          'the entered account carries into the ordinary recovery form');
        await page.locator('#recoverForm input[name=email]').fill(account.email);
        const feedbackBeforeRecovery = await page.locator('#statusMessage').innerText();
        await page.locator('#sendRecoveryCodeBtn').click();
        await page.waitForFunction(previous => {
          const node = document.getElementById('statusMessage');
          const text = node ? node.textContent.trim() : '';
          return text.length > 0 && text !== previous.trim();
        }, feedbackBeforeRecovery);
        assert.equal(f.mails.length, 1, 'the ordinary email recovery still sends its own code');
        assert.equal(f.mails[0].to, account.email);
        await shot(page, viewport, 'forgot-password');
        await context.close();
      }

      // ── 9. Localized feedback is visible on desktop and mobile ─────────────
      f.reset();
      {
        const { context, page } = await newSession(viewport);
        const account = await f.user();
        await signInWithPassword(page, account.username, 'wrong-password-value');
        await page.waitForFunction(() => document.getElementById('statusMessage').textContent.trim().length > 0);
        const box = await page.locator('#statusMessage').boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height + 1,
          'credential feedback must stay inside the viewport');
        await shot(page, viewport, 'password-error');
        await context.close();
      }

      // ── 10. A submit attempted while a code send is still in flight ─────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await passwordlessUser();
        const firstPassword = newPassword();
        // Seed a valid code through the API so the UI send stays a single request.
        const code = await seedResetCode(account);

        await continueWithAccount(page, account.username);
        await waitSetupStep(page);
        await page.locator('#setupEmailCode').fill(code);
        await page.locator('#setupPassword').fill(firstPassword);
        await page.locator('#setupConfirmPassword').fill(firstPassword);

        let resetRequests = 0;
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/password-reset') {
            resetRequests += 1;
          }
        });
        let captureSend;
        const pendingSend = new Promise(resolve => { captureSend = resolve; });
        await page.route('**/api/email-verification/send', route => { captureSend(route); });
        await page.locator('#sendSetupCodeBtn').click();
        const sendRoute = await pendingSend;

        // Local validation feedback must still work while the send is pending.
        await page.locator('#setupConfirmPassword').fill(`${firstPassword}-different`);
        await page.locator('#passwordSetupForm button[type=submit], #passwordSetupForm .submit').first().click();
        await page.waitForFunction(() => document.getElementById('statusMessage').textContent.trim().length > 0);
        assert.match(await page.locator('#statusMessage').innerText(), /不一致/,
          'a local password mismatch must report feedback even while a send is pending');
        assert.equal(resetRequests, 0, 'a local mismatch must not issue a reset request');

        // One authentication action at a time: this submit must be refused cleanly.
        await page.locator('#setupConfirmPassword').fill(firstPassword);
        await page.locator('#passwordSetupForm button[type=submit], #passwordSetupForm .submit').first().click();
        await page.waitForTimeout(400);
        assert.equal(resetRequests, 0, 'a pending send must block the setup request entirely');
        assert.equal(await currentStep(page), 'setup', 'a concurrent submit must not advance the step');
        assert.equal(await page.locator('#passwordSetupForm .submit').isDisabled(), false,
          'a refused concurrent submit must not leave the setup action disabled');
        assert.equal(await page.locator('#loginForm .submit').isDisabled(), false);
        assert.equal(await sessionCount(), 0);

        // Settling the send must keep the step and the form usable.
        await sendRoute.continue();
        await page.waitForTimeout(700);
        assert.equal(await currentStep(page), 'setup', 'the send result must not move the step');
        assert.equal(await page.locator('#passwordSetupForm .submit').isDisabled(), false);
        assert.equal(f.mails.length, 1, 'the interleaved send must not deliver an extra code');
        await page.unroute('**/api/email-verification/send');

        // The retried submit is a real success, and it does not log in.
        await page.locator('#passwordSetupForm button[type=submit], #passwordSetupForm .submit').first().click();
        await waitPasswordStep(page);
        assert.equal(resetRequests, 1, 'the retried submit issues exactly one reset request');
        assert.equal(await sessionCount(), 0, 'setup must not log the user in');
        await page.locator('#loginPassword').fill(firstPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/profile');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 11. A send attempted while the setup submit is still in flight ──────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await passwordlessUser();
        const secondPassword = newPassword();
        const code = await seedResetCode(account);

        await continueWithAccount(page, account.username);
        await waitSetupStep(page);
        await page.locator('#setupEmailCode').fill(code);
        await page.locator('#setupPassword').fill(secondPassword);
        await page.locator('#setupConfirmPassword').fill(secondPassword);

        let sendRequests = 0;
        page.on('request', request => {
          if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/email-verification/send') {
            sendRequests += 1;
          }
        });
        let captureSetup;
        const pendingSetup = new Promise(resolve => { captureSetup = resolve; });
        await page.route('**/api/password-reset', route => { captureSetup(route); });
        await page.locator('#passwordSetupForm button[type=submit], #passwordSetupForm .submit').first().click();
        const setupRoute = await pendingSetup;

        // The concurrent send is refused before it can issue a request.
        await page.locator('#sendSetupCodeBtn').click();
        await page.waitForTimeout(400);
        assert.equal(sendRequests, 0, 'a concurrent send must not issue a second code request');
        assert.equal(await page.locator('#sendSetupCodeBtn').isDisabled(), false,
          'a refused concurrent send must not stay disabled');

        await setupRoute.continue();
        await waitPasswordStep(page);
        assert.equal(await currentStep(page), 'password', 'the real setup result must be applied');
        assert.ok((await page.locator('#statusMessage').innerText()).trim().length > 0,
          'the settled state reports the setup result');
        assert.equal(await sessionCount(), 0, 'setup must not log the user in');
        assert.equal(await page.locator('#loginForm .submit').isDisabled(), false,
          'the login action must not stay disabled after the interleaved send');
        await page.unroute('**/api/password-reset');

        await page.locator('#loginPassword').fill(secondPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/profile');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 12. Passwordless OAuth: setup keeps the request, then MFA, then code exchange
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await passwordlessUser();
        const client = await f.client();
        client.redirectUris = [`${f.baseUrl}/browser-oauth-callback`];
        await f.Client.update(client.id, { redirectUris: client.redirectUris });
        f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });

        const verifier = crypto.randomBytes(32).toString('base64url');
        const nonce = crypto.randomBytes(24).toString('base64url');
        const state = crypto.randomBytes(24).toString('base64url');
        const params = new URLSearchParams({
          client_id: client.id, redirect_uri: client.redirectUris[0], scope: 'openid email',
          response_type: 'code', nonce, state,
          code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256'
        });
        const expected = Object.fromEntries(params.entries());
        await page.goto(`${f.baseUrl}/oauth2/authorize?${params}`);
        await page.locator('#authRegion').waitFor({ state: 'visible' });

        const setupPassword = newPassword();
        await continueWithAccount(page, account.username);
        await waitSetupStep(page);
        // The first-password step must not drop the original authorization request.
        assert.deepEqual(await hiddenOAuthFields(page), expected,
          'the setup step must preserve the OAuth request fields');

        await page.locator('#sendSetupCodeBtn').click();
        await page.waitForFunction(() => document.getElementById('statusMessage').textContent.trim().length > 0);
        assert.equal(f.mails.length, 1);
        await page.locator('#setupEmailCode').fill(f.lastCode(account.email));
        await page.locator('#setupPassword').fill(setupPassword);
        await page.locator('#setupConfirmPassword').fill(setupPassword);
        await page.locator('#passwordSetupForm button[type=submit], #passwordSetupForm .submit').first().click();
        await waitPasswordStep(page);

        // Setup alone never authenticates and never skips the second factor.
        assert.equal(await sessionCount(), 0, 'setup must not create a session');
        await expectAnonymous(context, 'oauth-setup');
        assert.deepEqual(await hiddenOAuthFields(page), expected,
          'the password step must still carry the OAuth request fields');

        await page.locator('#loginPassword').fill(setupPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/oauth2/mfa');
        assert.equal(await sessionCount(), 0, 'no session before the second factor');
        await page.waitForFunction(() => !document.getElementById('code').disabled);
        await page.locator('#code').fill(f.lastCode(account.email));
        await page.waitForURL(`${client.redirectUris[0]}?**`);

        const callback = new URL(page.url());
        assert.equal(callback.searchParams.get('state'), state, 'state must survive setup and MFA');
        const exchanged = await f.exchange(client, { code: callback.searchParams.get('code'), verifier });
        assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
        assert.equal(require('jsonwebtoken').decode(exchanged.body.id_token).nonce, nonce,
          'nonce must survive setup and MFA');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 13. A late code send must not resurrect the previous account ────────
      f.reset();
      {
        const { context, page } = await newSession(viewport);
        const first = await passwordlessUser();
        const second = await passwordlessUser();

        await continueWithAccount(page, first.username);
        await waitSetupStep(page);
        assert.equal(await page.locator('#setupEmailMasked').innerText(), expectedMask(first.email));

        let captureSend;
        const pendingSend = new Promise(resolve => { captureSend = resolve; });
        await page.route('**/api/email-verification/send', route => { captureSend(route); });
        await page.locator('#sendSetupCodeBtn').click();
        const sendRoute = await pendingSend;

        // Change the account while that send is still in flight.
        await page.locator('#changeLoginAccountBtn').click();
        await waitAccountStep(page);
        await continueWithAccount(page, second.username);
        await waitSetupStep(page);
        const secondMask = expectedMask(second.email);
        assert.equal(await page.locator('#setupEmailMasked').innerText(), secondMask);

        await sendRoute.continue();
        await page.waitForTimeout(800);
        assert.equal(await currentStep(page), 'setup', 'a late send must not change the active step');
        assert.equal(await page.locator('#setupEmailMasked').innerText(), secondMask,
          'a late send must not restore the previous account');
        assert.equal(await page.locator('#loginUsername').inputValue(), second.username);
        assert.equal(await sessionCount(), 0);
        assert.equal(await page.locator('#passwordSetupForm .submit').isDisabled(), false);
        await page.unroute('**/api/email-verification/send');
        await shot(page, viewport, 'late-send-after-account-change');
        await context.close();
      }

      // ── 14. A late password reset must not resurrect the previous account ───
      f.reset();
      {
        const { context, page } = await newSession(viewport);
        const first = await passwordlessUser();
        const second = await passwordlessUser();
        const code = await seedResetCode(first);

        await continueWithAccount(page, first.username);
        await waitSetupStep(page);
        await page.locator('#setupEmailCode').fill(code);
        const latePassword = newPassword();
        await page.locator('#setupPassword').fill(latePassword);
        await page.locator('#setupConfirmPassword').fill(latePassword);

        let captureReset;
        const pendingReset = new Promise(resolve => { captureReset = resolve; });
        await page.route('**/api/password-reset', route => { captureReset(route); });
        await page.locator('#passwordSetupForm button[type=submit], #passwordSetupForm .submit').first().click();
        const resetRoute = await pendingReset;

        // Change the account while that reset is still in flight.
        await page.locator('#changeLoginAccountBtn').click();
        await waitAccountStep(page);
        await continueWithAccount(page, second.username);
        await waitSetupStep(page);
        const secondMask = expectedMask(second.email);

        await resetRoute.continue();
        await page.waitForTimeout(800);
        assert.equal(await currentStep(page), 'setup', 'a late reset must not change the active step');
        assert.equal(await page.locator('#setupEmailMasked').innerText(), secondMask,
          'a late reset must not restore the previous account');
        assert.equal(await page.locator('#loginUsername').inputValue(), second.username);
        assert.equal(await sessionCount(), 0, 'a late reset must never create a session');
        assert.equal(await page.locator('#passwordSetupForm .submit').isDisabled(), false,
          'a late reset must not disable the setup action');
        await page.unroute('**/api/password-reset');
        await shot(page, viewport, 'late-reset-after-account-change');
        await context.close();
      }
    }
    console.log('Account-first login browser checks passed: Continue step, masked setup with manual send, '
      + 'real missing username/email in zh/en/zh-TW with editable retry and no side effects, '
      + 'contact-administrator branch, stale discovery/send/reset, single-action guard, '
      + 'passwordless OAuth setup with MFA and code exchange, desktop and mobile');
  } finally {
    if (browser) await browser.close();
    await f.close();
    if (savedTurnstile.site !== undefined) process.env.TURNSTILE_SITE_KEY = savedTurnstile.site;
    if (savedTurnstile.secret !== undefined) process.env.TURNSTILE_SECRET_KEY = savedTurnstile.secret;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
