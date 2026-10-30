// Post-password email gate browser regression (contract: research/login-email-gate-contract.md).
//
// Covers the mandatory email bind/verify gate that sits after password + CAPTCHA + optional
// TOTP/recovery and before any credential is issued, plus the unchanged verified-mailbox,
// initial-password and contact-administrator paths. Real Chrome, isolated in-memory fixture
// (memory DB, stubbed mail, no real SMTP), desktop 1440 and mobile 390.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');
const { totpCode } = require('./support/totp-code');

const ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'login-email-gate');
const VIEWPORTS = [{ width: 1440, height: 1000, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }];
const SYNTHETIC = /@users\.invalid$/i;

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

    // ── fixtures ────────────────────────────────────────────────────────────
    async function accountWithPassword({ email, emailVerified = false } = {}) {
      const username = `account-${crypto.randomUUID()}`;
      const password = newPassword();
      const address = email === undefined ? `${username}@example.test` : email;
      const record = await f.User.create({ username, email: address, password, role: 'user', emailVerified });
      return { ...record, email: address, clearPassword: password };
    }
    async function unboundAccount() {
      return accountWithPassword({ email: '', emailVerified: false });
    }
    async function syntheticAccount() {
      const username = `account-${crypto.randomUUID()}`;
      const digest = crypto.createHash('sha256').update(username.toLowerCase()).digest('hex');
      return accountWithPassword({ email: `import-${digest.slice(0, 24)}@users.invalid`, emailVerified: false });
    }
    async function passwordlessUser({ email } = {}) {
      const username = `account-${crypto.randomUUID()}`;
      const address = email === undefined ? `${username}@example.test` : email;
      const record = await f.User.create({ username, email: address, password: '', role: 'user', emailVerified: true });
      return { ...record, email: address };
    }
    function storedUser(id) {
      return f.pool.users.find(row => row.id === id);
    }
    function sessionCount() {
      return f.pool.sessions.length;
    }

    // ── browser helpers ─────────────────────────────────────────────────────
    async function newSession(viewport) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
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
      assert.equal(response.status(), 401, `${label}: no session may exist before the gate completes`);
      assert.equal(sessionCount(), 0, `${label}: no session row may exist before the gate completes`);
    }
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
    async function submitPassword(page, account) {
      await continueWithAccount(page, account.username);
      await waitPasswordStep(page);
      await page.locator('#loginPassword').fill(account.clearPassword);
      await page.locator('#loginForm .submit').click();
    }
    // Password proof -> /oauth2/mfa. Gate stages must land here, never on the login page.
    async function reachGate(page, account) {
      await submitPassword(page, account);
      await page.waitForURL('**/oauth2/mfa', { timeout: 15000 });
      await page.locator('#emailGateControls').waitFor({ state: 'visible', timeout: 15000 });
      await page.locator('#sendEmailGateCodeBtn').waitFor({ state: 'visible', timeout: 15000 });
    }
    async function pendingState(context) {
      const response = await context.request.get(`${f.baseUrl}/api/v1/auth/oauth/oidc/pending`);
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      return { status: response.status(), body };
    }
    async function codeEntryState(page) {
      return page.locator('#code').evaluate(field => ({
        disabled: field.disabled, name: field.name, visible: field.getBoundingClientRect().width > 1
      }));
    }
    // Manual send through the real button; asserts the frozen send response and the 60s resend cooldown.
    async function clickSend(page, context, { expectInactive = true } = {}) {
      const before = await pendingState(context);
      assert.equal(before.status, 200, `pending must be readable before send: ${JSON.stringify(before.body)}`);
      if (expectInactive) assert.equal(before.body.code_sent, false, 'no code may be active before the manual send');
      const mailsBefore = f.mails.length;
      const [response] = await Promise.all([
        page.waitForResponse(resp => resp.url().includes('/api/v1/auth/oauth/oidc/email/send'), { timeout: 15000 }),
        page.locator('#sendEmailGateCodeBtn').click()
      ]);
      const sentBody = await response.json().catch(() => null);
      assert.equal(response.status(), 200, `send must succeed: ${JSON.stringify(sentBody)}`);
      // Frozen contract: { sent: true, mail_version, email, code_sent: true, retry_after: 60 }.
      assert.equal(sentBody.sent, true, 'frozen: a successful send reports sent:true');
      assert.equal(sentBody.code_sent, true, 'frozen: a successful send reports code_sent:true');
      assert.equal(sentBody.mail_version, before.body.mail_version + 1,
        'frozen: the send response reports the reserved mail version');
      assert.equal(typeof sentBody.email, 'string', 'frozen: the send response reports the masked target');
      assertNoSynthetic(sentBody.email, 'send response email');
      assert.ok(Number(sentBody.retry_after) > 0 && Number(sentBody.retry_after) <= 60,
        `frozen: a successful send starts the 60s resend cooldown, got ${sentBody.retry_after}`);
      // Poll the authoritative persisted state instead of relying on copy/timing.
      const deadline = Date.now() + 15000;
      let after = await pendingState(context);
      while (Date.now() < deadline) {
        if (after.status === 200 && after.body.code_sent === true
            && after.body.mail_version === before.body.mail_version + 1) break;
        await page.waitForTimeout(100);
        after = await pendingState(context);
      }
      assert.equal(after.status, 200, `pending must stay readable after send: ${JSON.stringify(after.body)}`);
      assert.equal(after.body.mail_version, before.body.mail_version + 1,
        'a successful manual send must reserve exactly one new mail version');
      assert.equal(after.body.code_sent, true, 'code_sent must reflect the active exact code row');
      assert.ok(Number(after.body.retry_after) > 0,
        'frozen: the persisted projection reports the active resend cooldown');
      assert.equal(f.mails.length, mailsBefore + 1, 'a successful send must deliver exactly one message');
      await page.waitForFunction(() => {
        const button = document.getElementById('sendEmailGateCodeBtn');
        return Boolean(button) && button.disabled;
      }, null, { timeout: 5000 }).catch(() => {});
      assert.equal(await page.locator('#sendEmailGateCodeBtn').evaluate(button => button.disabled), true,
        'frozen: the send action stays disabled for the 60s cooldown');
      return { before: before.body, after: after.body, mail: f.mails.at(-1), sent: sentBody };
    }
    // The frozen contract enforces a 60s resend cooldown. Rate-limit keys are hashed by the model, so
    // clearing every persisted counter and reloading simulates the user waiting the cooldown out
    // instead of sleeping 60s. Each scenario starts from f.reset(), so this only affects its own account.
    async function expireSendCooldown(page) {
      f.pool.rateLimits.length = 0;
      await page.reload();
      await page.locator('#emailGateControls').waitFor({ state: 'visible', timeout: 15000 });
    }
    async function completeGate(page, code) {
      await page.waitForFunction(() => {
        const field = document.getElementById('code');
        return Boolean(field) && !field.disabled;
      }, null, { timeout: 15000 });
      await page.locator('#code').fill(code);
      // A complete six-digit code auto-submits; longer recovery codes need the button.
      if (!/^\d{6}$/.test(code)) await page.locator('#submit').click();
    }
    // Counts completion POSTs so a scenario can prove no extra attempt was made.
    function completionRequests(page) {
      const counter = { value: 0 };
      page.on('request', request => {
        if (request.url().includes('/api/v1/auth/oauth/oidc/complete')) counter.value += 1;
      });
      return counter;
    }
    // Submits a gate code and returns the completion response status and body.
    async function submitGateCodeResponse(page, code) {
      await page.waitForFunction(() => {
        const field = document.getElementById('code');
        return Boolean(field) && !field.disabled && !field.readOnly;
      }, null, { timeout: 15000 });
      const [response] = await Promise.all([
        page.waitForResponse(resp => resp.url().includes('/api/v1/auth/oauth/oidc/complete'), { timeout: 10000 }),
        (async () => {
          await page.locator('#code').fill(code);
          // Only a complete six-digit code auto-submits; longer recovery codes need the button.
          if (!/^\d{6}$/.test(code)) await page.locator('#submit').click();
        })()
      ]);
      const body = await response.json().catch(() => null);
      return { status: response.status(), body };
    }
    async function submitGateCode(page, code) {
      return (await submitGateCodeResponse(page, code)).status;
    }
    async function waitStatusText(page) {
      await page.waitForFunction(() => {
        const status = document.getElementById('status');
        return Boolean(status) && status.textContent.trim().length > 0;
      }, null, { timeout: 15000 });
    }
    async function shot(page, viewport, name) {
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) {
        assert.fail(`${name}: horizontal overflow at ${viewport.width}px`);
      }
      await page.screenshot({ path: path.join(ARTIFACTS, `${name}-${viewport.tag}-${viewport.width}.png`) });
    }
    function assertNoSynthetic(value, label) {
      assert.equal(SYNTHETIC.test(String(value || '')), false, `${label} must never expose a synthetic mailbox`);
    }
    async function oauthParams(page, { client, verifier, nonce, state }) {
      const params = new URLSearchParams({
        client_id: client.id, redirect_uri: client.redirectUris[0], scope: 'openid email',
        response_type: 'code', nonce, state,
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256'
      });
      await page.goto(`${f.baseUrl}/oauth2/authorize?${params}`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      return params;
    }
    async function oauthClient() {
      const client = await f.client();
      client.redirectUris = [`${f.baseUrl}/browser-oauth-callback`];
      await f.Client.update(client.id, { redirectUris: client.redirectUris });
      return client;
    }

    for (const viewport of VIEWPORTS) {
      // ── 1. Verified mailbox, switch off: no gate at all ───────────────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await f.user();
        await submitPassword(page, account);
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(page.url().includes('/oauth2/mfa'), false, 'a verified mailbox must not be gated');
        assert.equal(await page.locator('#emailGateControls').isVisible(), false);
        assert.equal(f.mails.length, 0, 'a verified mailbox must not receive a gate code');
        assert.equal(await sessionCount(), 1, 'a verified mailbox still logs in directly');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 2. Verified mailbox + global switch: existing email factor only ───
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await f.user();
        f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
        await submitPassword(page, account);
        await page.waitForURL('**/oauth2/mfa', { timeout: 15000 });
        await page.waitForFunction(() => !document.getElementById('code').disabled);
        assert.equal(await page.locator('#emailGateControls').isVisible(), false,
          'a verified mailbox must keep the ordinary email factor without gate controls');
        const entry = await codeEntryState(page);
        assert.equal(entry.name, 'email_code');
        assert.equal(f.mails.length, 1, 'the ordinary email factor sends exactly one code');
        await shot(page, viewport, 'verified-switch-email-factor');
        await completeGate(page, f.lastCode(account.email));
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 3. Unverified bound mailbox: manual send, then verify ─────────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        await reachGate(page, account);

        const pending = await pendingState(context);
        assert.equal(pending.status, 200);
        assert.equal(pending.body.factor, 'email_verify');
        assert.equal(pending.body.email_gate, 'verify');
        assert.equal(pending.body.code_sent, false, 'the gate must not send a code before the user asks');
        assert.equal(pending.body.mail_version, 0);
        assert.equal(pending.body.email, expectedMask(account.email),
          'verify gates expose the masked stored mailbox before send');
        assert.equal(f.mails.length, 0, 'no code may be sent before the manual send action');
        await expectAnonymous(context, 'verify-gate-before-send');

        // Bind-only input must not exist for a verify gate.
        assert.equal(await page.locator('#bindEmailInput').isVisible(), false,
          'a verify gate must not offer the bind input');
        assert.equal((await codeEntryState(page)).disabled, true,
          'code entry stays disabled until a send succeeds');
        const verifyMaskText = (await page.locator('#emailGateMasked').innerText()).trim();
        assert.ok(verifyMaskText.includes(expectedMask(account.email)),
          `the verify gate must show the masked stored mailbox, got "${verifyMaskText}"`);
        assert.equal(verifyMaskText.includes(account.email), false,
          'the full stored mailbox must never be rendered');
        assertNoSynthetic(verifyMaskText, 'gate hint');
        await shot(page, viewport, 'verify-gate-before-send');

        const sent = await clickSend(page, context);
        assert.equal(sent.after.email, expectedMask(account.email), 'send keeps the masked stored mailbox');
        assert.equal(sent.mail.to, account.email, 'the code must go to the stored mailbox');
        await page.waitForFunction(() => {
          const field = document.getElementById('code');
          return Boolean(field) && !field.disabled;
        }, null, { timeout: 15000 });
        assert.equal((await codeEntryState(page)).disabled, false, 'code entry unlocks after a send');
        await shot(page, viewport, 'verify-gate-after-send');

        await completeGate(page, f.lastCode(account.email));
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1, 'a completed gate establishes exactly one session');
        const stored = storedUser(account.id);
        assert.equal(Boolean(stored.email_verified), true, 'gate completion must mark the mailbox verified');
        assert.equal(stored.email, account.email, 'the verify gate must not change the mailbox');
        assert.equal(f.mails.length, 1, 'one gate code only');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 4. No mailbox: bind a new address and prove it ────────────────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await unboundAccount();
        const target = `bound-${crypto.randomBytes(6).toString('hex')}@example.test`;
        await reachGate(page, account);

        const pending = await pendingState(context);
        assert.equal(pending.body.factor, 'email_bind');
        assert.equal(pending.body.email_gate, 'bind');
        assert.equal(pending.body.email, '', 'a bind gate has no target before the user supplies one');
        assert.equal(pending.body.code_sent, false);
        assert.equal(pending.body.mail_version, 0);
        assert.equal(f.mails.length, 0);

        const bindInput = page.locator('#bindEmailInput');
        assert.equal(await bindInput.isVisible(), true, 'a bind gate must offer the new-address input');
        assert.equal(await bindInput.getAttribute('type'), 'email');
        assert.equal(await bindInput.evaluate(field => field.required), true,
          'the bind address is required');
        assert.equal((await codeEntryState(page)).disabled, true);
        await expectAnonymous(context, 'bind-gate-before-send');
        await shot(page, viewport, 'bind-gate-before-send');

        // Sending without a valid address must not deliver anything.
        await bindInput.fill('not-an-email');
        await page.locator('#sendEmailGateCodeBtn').click();
        await page.waitForTimeout(700);
        assert.equal(f.mails.length, 0, 'an invalid bind address must not receive a code');
        assert.equal((await codeEntryState(page)).disabled, true);

        await bindInput.fill(target);
        const sent = await clickSend(page, context);
        assert.equal(sent.mail.to, target, 'the bind code must go to the address the user supplied');
        assert.equal(sent.after.email, expectedMask(target), 'after send the masked target is the new address');
        const bindMaskText = (await page.locator('#emailGateMasked').innerText()).trim();
        assert.ok(bindMaskText.includes(expectedMask(target)),
          `the bind gate must show the masked new target, got "${bindMaskText}"`);
        assert.equal(bindMaskText.includes(target), false, 'the full bound mailbox must never be rendered');
        await shot(page, viewport, 'bind-gate-after-send');

        await completeGate(page, f.lastCode(target));
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1);
        const stored = storedUser(account.id);
        assert.equal(stored.email, target, 'gate completion must persist the proven address');
        assert.equal(Boolean(stored.email_verified), true, 'a bound mailbox is verified by proof');
        assert.equal(f.mails.length, 1);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 5. Synthetic (unusable) mailbox is treated as unbound ─────────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await syntheticAccount();
        const target = `rebound-${crypto.randomBytes(6).toString('hex')}@example.test`;
        await reachGate(page, account);
        const pending = await pendingState(context);
        assert.equal(pending.body.factor, 'email_bind',
          'a corrupt/unusable mailbox must be gated as a bind, not a verify');
        assertNoSynthetic(JSON.stringify(pending.body), 'pending payload');
        const hint = (await page.locator('#emailGateMasked').innerText()).trim();
        assertNoSynthetic(hint, 'gate hint');
        assert.equal(f.mails.length, 0, 'a synthetic mailbox must never receive mail');

        await page.locator('#bindEmailInput').fill(target);
        const sent = await clickSend(page, context);
        assert.equal(sent.mail.to, target);
        assert.equal(f.mails.filter(mail => SYNTHETIC.test(String(mail.to || ''))).length, 0,
          'no message may be addressed to a synthetic mailbox');
        await completeGate(page, f.lastCode(target));
        await page.waitForURL('**/profile', { timeout: 15000 });
        const stored = storedUser(account.id);
        assert.equal(stored.email, target, 'the unusable mailbox is replaced by the proven one');
        assert.equal(Boolean(stored.email_verified), true);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 6. TOTP completes first, then the gate (next_step transition) ────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
        await f.User.update(account.id, { totpEnabled: true, totpSecret: secret });

        await submitPassword(page, account);
        await page.waitForURL('**/oauth2/mfa', { timeout: 15000 });
        await page.waitForFunction(() => !document.getElementById('code').disabled);
        assert.equal((await codeEntryState(page)).name, 'totp_code', 'TOTP takes precedence over the gate');
        assert.equal(await page.locator('#emailGateControls').isVisible(), false,
          'the gate must not be reachable before the authenticator step');
        assert.equal(f.mails.length, 0, 'TOTP alone must not send an email');
        await expectAnonymous(context, 'totp-stage');
        await shot(page, viewport, 'totp-before-gate');

        const transition = await submitGateCodeResponse(page, totpCode(secret));
        assert.equal(transition.status, 200, 'the authenticator stage itself must succeed');
        // Frozen contract: { next_step:true, mfa_url:'/oauth2/mfa' } plus the next challenge metadata.
        assert.equal(transition.body.next_step, true, 'frozen: the authenticator stage announces the next step');
        assert.equal(transition.body.mfa_url, '/oauth2/mfa', 'frozen: the intermediate response keeps the MFA url');
        assert.equal(transition.body.factor, 'email_verify', 'frozen: the next stage is the email gate');
        assert.equal(transition.body.email_gate, 'verify');
        assert.equal(transition.body.code_sent, false, 'frozen: the next stage has not sent anything yet');
        assert.equal(transition.body.mail_version, 0);
        assert.equal(transition.body.email, expectedMask(account.email),
          'frozen: the intermediate response carries the same masked metadata as the pending GET');
        // Intermediate next_step response rehydrates the gate in place.
        await page.locator('#emailGateControls').waitFor({ state: 'visible', timeout: 15000 });
        assert.equal(page.url().includes('/oauth2/mfa'), true, 'the gate stays on the MFA page');
        assert.equal((await codeEntryState(page)).disabled, true,
          'the rehydrated gate must require a fresh manual send');
        assert.equal((await page.locator('#code').inputValue()), '',
          'the previous factor code must be cleared on the stage transition');
        const pending = await pendingState(context);
        assert.equal(pending.status, 200, 'the rotated pending cookie must remain readable');
        assert.equal(pending.body.factor, 'email_verify');
        assert.equal(pending.body.email_gate, 'verify');
        assert.equal(f.mails.length, 0);
        await expectAnonymous(context, 'totp-then-gate');
        await shot(page, viewport, 'totp-then-gate');

        await clickSend(page, context);
        await completeGate(page, f.lastCode(account.email));
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1);
        assert.equal(Boolean(storedUser(account.id).email_verified), true);
        assert.equal(f.mails.length, 1, 'one gate code across the TOTP chain');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 7. Recovery code completes TOTP, then the gate ────────────────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
        const recovery = ['ABCD2345EFGH6789', 'JKLM2345NPQR6789'];
        await f.User.update(account.id, {
          totpEnabled: true, totpSecret: secret,
          recoveryCodes: JSON.stringify(recovery.map(code => crypto.createHash('sha256').update(code).digest('hex')))
        });

        await submitPassword(page, account);
        await page.waitForURL('**/oauth2/mfa', { timeout: 15000 });
        await page.waitForFunction(() => !document.getElementById('recoveryToggle').disabled);
        await page.locator('#recoveryToggle').click();
        const recoveryTransition = await submitGateCodeResponse(page, recovery[0]);
        assert.equal(recoveryTransition.status, 200, 'the recovery stage itself must succeed');
        assert.equal(recoveryTransition.body.next_step, true,
          'frozen: a recovery-code stage also announces the next step');
        assert.equal(recoveryTransition.body.mfa_url, '/oauth2/mfa');
        assert.equal(recoveryTransition.body.factor, 'email_verify');
        assert.equal(recoveryTransition.body.email_gate, 'verify');
        assert.equal(recoveryTransition.body.code_sent, false);
        await page.locator('#emailGateControls').waitFor({ state: 'visible', timeout: 15000 });
        assert.equal((await codeEntryState(page)).disabled, true);
        await expectAnonymous(context, 'recovery-then-gate');

        await clickSend(page, context);
        await completeGate(page, f.lastCode(account.email));
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1);
        assert.equal(Boolean(storedUser(account.id).email_verified), true);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 8. Global switch on: the gate code is the login's email factor ────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
        await reachGate(page, account);

        await clickSend(page, context);
        await completeGate(page, f.lastCode(account.email));
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1,
          'the mandatory proof must satisfy the login email factor in one step');
        assert.equal(f.mails.length, 1, 'the global switch must not request a second email code');
        assert.equal(Boolean(storedUser(account.id).email_verified), true);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 9. Full OAuth continuation: state/nonce/PKCE/id_token verified ────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        const client = await oauthClient();
        f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
        const verifier = crypto.randomBytes(32).toString('base64url');
        const nonce = crypto.randomBytes(24).toString('base64url');
        const state = crypto.randomBytes(24).toString('base64url');
        const params = await oauthParams(page, { client, verifier, nonce, state });

        await continueWithAccount(page, account.username);
        await waitPasswordStep(page);
        const carried = await page.locator('#loginForm').evaluate(form => {
          const data = new FormData(form);
          return Object.fromEntries(['client_id', 'redirect_uri', 'scope', 'state', 'nonce',
            'response_type', 'code_challenge', 'code_challenge_method']
            .map(key => [key, data.get(key) === null ? '' : String(data.get(key))]));
        });
        for (const key of ['client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'response_type',
          'code_challenge', 'code_challenge_method']) {
          assert.equal(carried[key], params.get(key), `hidden OAuth field ${key} must survive the account step`);
        }
        await page.locator('#loginPassword').fill(account.clearPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/oauth2/mfa', { timeout: 15000 });
        await page.locator('#emailGateControls').waitFor({ state: 'visible', timeout: 15000 });
        await expectAnonymous(context, 'oauth-gate');

        await clickSend(page, context);
        await completeGate(page, f.lastCode(account.email));
        await page.waitForURL(`${client.redirectUris[0]}?**`, { timeout: 15000 });
        const callback = new URL(page.url());
        assert.equal(callback.searchParams.get('state'), state,
          'OAuth state must survive password, gate and email proof');
        const exchanged = await f.exchange(client, { code: callback.searchParams.get('code'), verifier });
        assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
        const claims = jwt.decode(exchanged.body.id_token);
        assert.equal(claims.nonce, nonce, 'OAuth nonce must survive the gate');
        assert.equal(claims.email_verified, true,
          'id_token must report the mailbox verified by the gate proof');
        assert.equal(claims.email, account.email);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 10. Wrong code does not complete; correct code still can ──────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        await reachGate(page, account);
        await clickSend(page, context);
        const real = f.lastCode(account.email);
        const wrong = real === '000000' ? '111111' : '000000';

        await completeGate(page, wrong);
        await page.waitForFunction(() => {
          const status = document.getElementById('status');
          return status && status.textContent.trim().length > 0;
        }, null, { timeout: 15000 });
        await expectAnonymous(context, 'wrong-gate-code');
        assert.equal(Boolean(storedUser(account.id).email_verified), false,
          'a wrong code must not verify the mailbox');
        await shot(page, viewport, 'gate-wrong-code');

        await completeGate(page, real);
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1, 'the correct code still completes after one failure');
        assert.equal(Boolean(storedUser(account.id).email_verified), true);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 11. Edited bind target cannot be completed with the sent code ─────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await unboundAccount();
        const first = `first-${crypto.randomBytes(6).toString('hex')}@example.test`;
        const second = `second-${crypto.randomBytes(6).toString('hex')}@example.test`;
        await reachGate(page, account);
        await page.locator('#bindEmailInput').fill(first);
        await clickSend(page, context);
        const code = f.lastCode(first);

        // The user edits the destination after the send. The server never trusts a
        // completion target, so the edited address must neither be persisted nor mailed.
        await page.locator('#bindEmailInput').fill(second);
        await page.waitForTimeout(500);
        const editable = await page.locator('#code').evaluate(field => !field.disabled);
        if (editable) {
          await page.locator('#code').fill(code);
        } else {
          // The frontend invalidates the sent code locally once the destination changes,
          // so completion stays locked and a fresh send is required.
          assert.equal(await page.locator('#code').evaluate(field => Boolean(field.disabled)), true,
            'editing the bind address must re-lock code entry');
          assert.equal((await page.locator('#status').innerText()).trim().length > 0, true,
            'editing the bind address must surface that a fresh send is required');
        }
        await page.waitForTimeout(1500);
        assert.equal(page.url().includes('/profile'), false,
          'a code sent to the first address must not complete a login for an edited target');
        await expectAnonymous(context, 'edited-target');
        const stored = storedUser(account.id);
        assert.equal(stored.email, '', 'the unproven edited address must not be persisted');
        assert.equal(Boolean(stored.email_verified), false);
        assert.equal(f.mails.some(mail => mail.to === second), false,
          'the edited address must never receive the original code');
        await shot(page, viewport, 'gate-edited-target');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 12. Bind refuses a mailbox already owned by another account ───────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await unboundAccount();
        const owner = await f.user();
        await reachGate(page, account);
        await page.locator('#bindEmailInput').fill(owner.email);
        await page.locator('#sendEmailGateCodeBtn').click();
        await page.waitForTimeout(900);
        assert.equal(f.mails.length, 0, 'a taken mailbox must not receive a gate code');
        assert.equal((await codeEntryState(page)).disabled, true, 'code entry stays locked after a rejected send');
        await expectAnonymous(context, 'taken-mailbox');
        const stored = storedUser(account.id);
        assert.equal(stored.email, '', 'a rejected bind must not touch the account mailbox');
        assert.equal(Boolean(stored.email_verified), false);
        await shot(page, viewport, 'gate-taken-mailbox');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 13. Initial-password setup is unchanged ───────────────────────────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await passwordlessUser();
        await continueWithAccount(page, account.username);
        await waitSetupStep(page);
        assert.equal((await page.locator('#setupEmailMasked').innerText()).trim(), expectedMask(account.email));
        assert.equal(await page.locator('#emailGateControls').isVisible(), false,
          'the setup step must not show gate controls');
        await page.locator('#sendSetupCodeBtn').click();
        await page.waitForFunction(() => document.getElementById('statusMessage').textContent.trim().length > 0);
        assert.equal(f.mails.length, 1);
        const setupPassword = newPassword();
        await page.locator('#setupEmailCode').fill(f.lastCode(account.email));
        await page.locator('#setupPassword').fill(setupPassword);
        await page.locator('#setupConfirmPassword').fill(setupPassword);
        await page.locator('#passwordSetupForm button[type=submit], #passwordSetupForm .submit').first().click();
        await waitPasswordStep(page);
        assert.equal(await sessionCount(), 0, 'initial-password setup must never authenticate');
        await expectAnonymous(context, 'setup-step');
        // The new password then logs in with a verified mailbox, so no gate applies.
        await page.locator('#loginPassword').fill(setupPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 14. No password and no mailbox keeps contact-administrator ───────
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await passwordlessUser({ email: '' });
        await continueWithAccount(page, account.username);
        await waitContactStep(page);
        assert.equal(await page.locator('#sendSetupCodeBtn').isVisible(), false);
        assert.equal(await page.locator('#emailGateControls').isVisible(), false);
        assert.equal(f.mails.length, 0, 'the contact branch must not send mail');
        assert.equal(await sessionCount(), 0);
        await expectAnonymous(context, 'contact-admin');
        await shot(page, viewport, 'contact-admin-unchanged');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 15. Reload after a bind code was already sent ─────────────────────
      // Reviewer F1: the server keeps the destination; the client must not lose it, and the
      // persisted target stays authoritative for completion.
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await unboundAccount();
        const target = `reload-${crypto.randomBytes(6).toString('hex')}@example.test`;
        await reachGate(page, account);
        await page.locator('#bindEmailInput').fill(target);
        await clickSend(page, context);
        const code = f.lastCode(target);

        await page.reload();
        await page.locator('#emailGateControls').waitFor({ state: 'visible', timeout: 15000 });
        const pending = await pendingState(context);
        assert.equal(pending.status, 200, 'the pending challenge must survive a reload');
        assert.equal(pending.body.factor, 'email_bind');
        assert.equal(pending.body.email_gate, 'bind');
        assert.equal(pending.body.code_sent, true, 'the already-sent proof must survive a reload');
        assert.equal(pending.body.mail_version, 1);
        assert.equal(pending.body.email, expectedMask(target),
          'the persisted destination stays authoritative after a reload');
        const reloadMask = (await page.locator('#emailGateMasked').innerText()).trim();
        assert.ok(reloadMask.includes(expectedMask(target)),
          `a reload must show the persisted masked destination, got "${reloadMask}"`);
        assert.equal(reloadMask.includes(target), false,
          'the full persisted destination must never be rendered');
        assert.equal(await page.locator('#bindEmailInput').inputValue(), '',
          'a reload must not invent the full persisted destination in the input');
        assert.equal(await page.locator('#code').evaluate(field => field.disabled), false,
          'an already-sent proof unlocks code entry again after a reload');
        await shot(page, viewport, 'bind-reload-code-sent');
        await expectAnonymous(context, 'bind-reload');

        // Completion for the persisted destination must still be possible without retyping it.
        assert.equal(await submitGateCode(page, code), 200,
          'completion for the persisted destination must succeed after a reload');
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1);
        const stored = storedUser(account.id);
        assert.equal(stored.email, target, 'the persisted destination is what gets bound');
        assert.equal(Boolean(stored.email_verified), true);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 16. Reload, then retarget: A must never be verified while B is shown ──
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await unboundAccount();
        const first = `orig-${crypto.randomBytes(6).toString('hex')}@example.test`;
        const second = `other-${crypto.randomBytes(6).toString('hex')}@example.test`;
        const completions = completionRequests(page);
        await reachGate(page, account);
        await page.locator('#bindEmailInput').fill(first);
        await clickSend(page, context);
        const firstCode = f.lastCode(first);

        await page.reload();
        await page.locator('#emailGateControls').waitFor({ state: 'visible', timeout: 15000 });
        // The user types a different address than the persisted one.
        await page.locator('#bindEmailInput').fill(second);
        await page.waitForTimeout(500);
        assert.equal(await page.locator('#code').evaluate(field => field.disabled), true,
          'editing the destination after a reload must re-lock code entry');
        assert.equal((await page.locator('#status').innerText()).trim().length > 0, true,
          'editing the destination must surface that a fresh send is required');
        const before = completions.value;
        await page.waitForTimeout(900);
        assert.equal(completions.value, before,
          'no completion may be attempted for the edited destination');
        await expectAnonymous(context, 'reload-retarget');
        const untouched = storedUser(account.id);
        assert.equal(untouched.email, '',
          'the persisted destination must not be verified while a different one is shown');
        assert.equal(Boolean(untouched.email_verified), false);
        assert.equal(f.mails.some(mail => mail.to === second), false,
          'the edited destination must never receive the original code');
        await shot(page, viewport, 'bind-reload-retarget');

        // A fresh send to the new address is the only way forward, and it binds B. The frozen 60s
        // resend cooldown is simulated as elapsed, then the user retypes the destination after reload.
        await expireSendCooldown(page);
        await page.locator('#bindEmailInput').fill(second);
        const resent = await clickSend(page, context, { expectInactive: false });
        assert.equal(resent.mail.to, second, 'the resend must go to the newly supplied destination');
        assert.equal(resent.after.mail_version, 2, 'the retarget reserves a new mail version');
        assert.equal(await submitGateCode(page, f.lastCode(second)), 200);
        await page.waitForURL('**/profile', { timeout: 15000 });
        const stored = storedUser(account.id);
        assert.equal(stored.email, second, 'the proven retarget is what gets bound');
        assert.equal(Boolean(stored.email_verified), true);
        assert.equal(stored.email === first, false, 'the abandoned destination must not be bound');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 17. Terminal completion errors keep the gate disabled ─────────────
      // Reviewer F2: 401/429 must stay terminal through the submit finalizer and cooldown render.
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        await reachGate(page, account);
        await clickSend(page, context);
        const code = f.lastCode(account.email);

        // Simulate an expired pending challenge: the browser no longer holds the credential.
        await context.clearCookies();
        assert.equal(await submitGateCode(page, code), 401, 'an expired pending must answer 401');
        await waitStatusText(page);
        await page.waitForTimeout(1400);
        assert.equal(await page.locator('#code').evaluate(field => field.disabled), true,
          'a terminal 401 must keep code entry disabled after the submit finalizer');
        assert.equal(await page.locator('#submit').evaluate(button => button.disabled), true,
          'a terminal 401 must keep completion disabled');
        assert.equal(await page.locator('#sendEmailGateCodeBtn').evaluate(button => button.disabled), true,
          'a terminal 401 must also disable the send action');
        await page.waitForTimeout(2200);
        assert.equal(await page.locator('#code').evaluate(field => field.disabled), true,
          'a cooldown render must not revive a terminal stage');
        assert.equal(await page.locator('#submit').evaluate(button => button.disabled), true);
        await shot(page, viewport, 'gate-terminal-401');
        assert.equal(await sessionCount(), 0);
        assert.deepEqual(errors, []);
        await context.close();
      }
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        await reachGate(page, account);
        await clickSend(page, context);
        const real = f.lastCode(account.email);
        const wrong = real === '000000' ? '111111' : '000000';
        const statuses = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          statuses.push(await submitGateCode(page, wrong));
        }
        assert.deepEqual(statuses.slice(0, 5), [400, 400, 400, 400, 400],
          'retryable wrong codes answer 400 and keep the stage usable');
        assert.equal(statuses[5], 429, 'the exhausted attempt budget is terminal');
        await waitStatusText(page);
        await page.waitForTimeout(1400);
        assert.equal(await page.locator('#code').evaluate(field => field.disabled), true,
          'a locked stage must keep code entry disabled after the submit finalizer');
        assert.equal(await page.locator('#submit').evaluate(button => button.disabled), true,
          'a locked stage must keep completion disabled');
        assert.equal(await page.locator('#sendEmailGateCodeBtn').evaluate(button => button.disabled), true,
          'a locked stage must also disable the send action');
        await shot(page, viewport, 'gate-terminal-429');
        assert.equal(await sessionCount(), 0);
        assert.equal(Boolean(storedUser(account.id).email_verified), false);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 18. TOTP next_step followed by a failed rehydration ───────────────
      // Reviewer F3: a consumed authenticator stage must not come back usable.
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
        await f.User.update(account.id, { totpEnabled: true, totpSecret: secret });
        const completions = completionRequests(page);

        await submitPassword(page, account);
        await page.waitForURL('**/oauth2/mfa', { timeout: 15000 });
        await page.waitForFunction(() => !document.getElementById('code').disabled);
        assert.equal((await codeEntryState(page)).name, 'totp_code');
        assert.equal(await page.locator('#recoveryToggle').evaluate(button => button.disabled), false,
          'the authenticator stage starts usable');

        // The stage transition commits, but the follow-up stage fetch fails.
        await page.route('**/api/v1/auth/oauth/oidc/pending', route => route.fulfill({
          status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'server_error' })
        }));
        assert.equal(await submitGateCode(page, totpCode(secret)), 200,
          'the authenticator stage itself must still succeed');
        await waitStatusText(page);
        await page.waitForTimeout(1400);
        assert.equal(await page.locator('#code').evaluate(field => field.disabled), true,
          'a failed rehydration must not re-enable the consumed authenticator entry');
        assert.equal(await page.locator('#submit').evaluate(button => button.disabled), true,
          'a failed rehydration must keep completion disabled');
        assert.equal(await page.locator('#recoveryToggle').evaluate(button => button.disabled), true,
          'a failed rehydration must disable the stale recovery toggle');
        const before = completions.value;
        await page.waitForTimeout(1200);
        assert.equal(completions.value, before,
          'no further completion may be attempted against the new stage');
        assert.equal(await sessionCount(), 0, 'a failed rehydration must not issue credentials');
        await shot(page, viewport, 'totp-next-step-rehydrate-failed');
        await page.unroute('**/api/v1/auth/oauth/oidc/pending');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 19. A delayed send failure clears the stale local proof ───────────
      // Reviewer F4: after a delivery error the client must not keep a usable code. A verify gate
      // resends to the stored mailbox without a typed target, so the cooldown can be simulated
      // without touching the restore semantics that intentionally clear an edited destination.
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await accountWithPassword({ emailVerified: false });
        await reachGate(page, account);
        await clickSend(page, context);
        assert.equal(await page.locator('#code').evaluate(field => field.disabled), false,
          'the first send unlocks code entry');

        // Wait out the frozen 60s resend cooldown; the restored proof stays usable.
        await expireSendCooldown(page);
        assert.equal(await page.locator('#code').evaluate(field => field.disabled), false,
          'the already-sent proof still unlocks code entry after the cooldown elapses');

        // Second send fails late, after the client already had a usable code.
        await page.route('**/api/v1/auth/oauth/oidc/email/send', async route => {
          await new Promise(resolve => setTimeout(resolve, 900));
          await route.fulfill({
            status: 502, contentType: 'application/json',
            body: JSON.stringify({ error: 'email_delivery_failed', error_key: 'smtp.test_failed',
              error_description: '验证码邮件发送失败' })
          });
        });
        const [failure] = await Promise.all([
          page.waitForResponse(resp => resp.url().includes('/api/v1/auth/oauth/oidc/email/send'), { timeout: 15000 }),
          page.locator('#sendEmailGateCodeBtn').click()
        ]);
        assert.equal(failure.status(), 502, 'the emulated delivery failure must reach the client');
        await waitStatusText(page);
        await page.waitForTimeout(400);
        // A delivery error must never leave the client offering a proof the server does not honour:
        // entry has to agree with the authoritative projection, and nothing typed may be replayable.
        const projection = await pendingState(context);
        assert.equal(projection.status, 200, 'the pending challenge must survive a failed send');
        const codeLocked = await page.locator('#code').evaluate(field => field.disabled);
        assert.equal(codeLocked, projection.body.code_sent === false,
          'code entry must agree with the authoritative projection after a failed send');
        assert.equal(await page.locator('#code').inputValue(), '',
          'a failed send must clear the typed code so nothing can be replayed');
        assert.equal(f.mails.length, 1, 'a failed send must not deliver another message');
        assert.equal(await page.locator('#sendEmailGateCodeBtn').evaluate(button => button.disabled), false,
          'a failed send must leave the send action retryable');
        await shot(page, viewport, 'gate-send-failed-cleared');
        await page.unroute('**/api/v1/auth/oauth/oidc/email/send');
        await expectAnonymous(context, 'send-failed');

        // Recovery: one real resend restores a working proof for the same mailbox.
        const resent = await clickSend(page, context, { expectInactive: false });
        assert.equal(resent.mail.to, account.email);
        assert.equal(resent.after.code_sent, true);
        assert.equal(await submitGateCode(page, f.lastCode(account.email)), 200);
        await page.waitForURL('**/profile', { timeout: 15000 });
        const stored = storedUser(account.id);
        assert.equal(stored.email, account.email);
        assert.equal(Boolean(stored.email_verified), true);
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ── 20. Rejected retarget, then a restore that still shows the new address ──
      // Reviewer F1 follow-up: send A, edit B, B's send is rejected, the next GET restores the
      // active A proof while the input still shows B. The UI target and the proof must agree, so
      // A's code must never complete while B is on screen.
      f.reset();
      {
        const { context, page, errors } = await newSession(viewport);
        const account = await unboundAccount();
        const owner = await f.user();
        const first = `kept-${crypto.randomBytes(6).toString('hex')}@example.test`;
        const completions = completionRequests(page);
        await reachGate(page, account);
        await page.locator('#bindEmailInput').fill(first);
        await clickSend(page, context);
        const firstCode = f.lastCode(first);

        // Clear the frozen cooldown so the retarget click really reaches the server and is rejected.
        await expireSendCooldown(page);

        // Retarget to a mailbox another account already owns: rejected even inside the cooldown,
        // because the conflict check runs before the send limits.
        await page.locator('#bindEmailInput').fill(owner.email);
        await page.waitForTimeout(300);
        const rejected = await Promise.all([
          page.waitForResponse(resp => resp.url().includes('/api/v1/auth/oauth/oidc/email/send'), { timeout: 15000 }),
          page.locator('#sendEmailGateCodeBtn').click()
        ]);
        assert.ok(rejected[0].status() >= 400,
          'a taken mailbox must be rejected, not silently sent');
        assert.equal(f.mails.some(mail => mail.to === owner.email), false,
          'the rejected destination must never receive mail');
        // A 409 makes the client re-read the pending challenge, which restores the active A proof.
        await page.waitForTimeout(900);
        const pending = await pendingState(context);
        assert.equal(pending.status, 200, 'the pending challenge must survive a rejected retarget');
        assert.equal(pending.body.email, expectedMask(first),
          'the server keeps the proven destination as the authoritative one');
        assert.equal(pending.body.code_sent, true, 'the A proof is still active after the rejection');

        // The screen must never present a usable proof for a destination it does not show.
        const shownValue = (await page.locator('#bindEmailInput').inputValue()).trim();
        const codeLocked = await page.locator('#code').evaluate(field => field.disabled);
        assert.ok(shownValue === '' || codeLocked,
          'the UI must not offer a usable proof while a different destination is on screen');
        if (shownValue !== '') {
          assert.equal(codeLocked, true, 'a mismatched destination must keep code entry locked');
          const before = completions.value;
          await page.waitForTimeout(900);
          assert.equal(completions.value, before,
            'no completion may be attempted while the screen shows a different destination');
          await expectAnonymous(context, 'rejected-retarget');
          const untouched = storedUser(account.id);
          assert.equal(untouched.email, '', 'the account must not be bound to either address yet');
          assert.equal(Boolean(untouched.email_verified), false);
        }
        assertNoSynthetic(await page.locator('#emailGateMasked').innerText(), 'restored gate hint');
        await shot(page, viewport, 'gate-rejected-retarget-restored');

        // The restored proof still belongs to A: clearing the edited destination lets A complete.
        await page.locator('#bindEmailInput').fill('');
        await page.waitForFunction(() => {
          const field = document.getElementById('code');
          return Boolean(field) && !field.disabled;
        }, null, { timeout: 15000 });
        assert.equal(await submitGateCode(page, firstCode), 200,
          'the restored proof must complete for the persisted destination');
        await page.waitForURL('**/profile', { timeout: 15000 });
        assert.equal(await sessionCount(), 1);
        const stored = storedUser(account.id);
        assert.equal(stored.email, first, 'only the proven destination may be bound');
        assert.equal(Boolean(stored.email_verified), true);
        assert.equal(f.mails.length, 1, 'no extra mail may be sent by the rejected retarget');
        assert.deepEqual(errors, []);
        await context.close();
      }
    }

    console.log('Login email gate browser checks passed: verified mailbox and global switch unchanged, '
      + 'manual-send verify gate for unverified mailboxes, manual-send bind gate for missing and synthetic '
      + 'mailboxes, TOTP and recovery next_step transitions, single gate code under the global switch, '
      + 'OAuth state/nonce/PKCE/id_token continuity, wrong and stale/edited targets, taken mailbox, '
      + 'reload after a sent bind code, retarget after reload, rejected retarget restore, '
      + 'terminal 401/429 disablement, failed '
      + 'rehydration after next_step, delayed send failure clearing stale proof, '
      + 'no session before final completion, initial-password and contact-administrator paths unchanged; '
      + 'desktop and mobile');
  } finally {
    if (browser) await browser.close();
    await f.close();
    if (savedTurnstile.site !== undefined) process.env.TURNSTILE_SITE_KEY = savedTurnstile.site;
    if (savedTurnstile.secret !== undefined) process.env.TURNSTILE_SECRET_KEY = savedTurnstile.secret;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
