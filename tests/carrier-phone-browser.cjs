const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

// Carrier phone authentication in a real browser.
// Evidence: .trellis/tasks/11-24-carrier-phone-auth/{prd,design}.md and the shipped views.
// The Aliyun PNVS provider is replaced by an in-process fake transport; account discovery,
// challenge lifecycle, cookies and redirects all run through the real isolated service.
// No provider credentials and no network egress: fixture.js installs a loopback-only guard
// and the fake transport is injected before any phone route can reach the official endpoint.

const ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'carrier-phone');
const VIEWPORTS = [
  { width: 1440, height: 1000, tag: 'desktop' },
  { width: 390, height: 844, tag: 'mobile' }
];

const SMS_PHONE = '13800138000';
const APP_PHONE = '13900139000';

async function captureJson(page, suffix) {
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  await page.route(url => url.pathname.endsWith(suffix), async route => {
    try {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response });
      resolveResult({ status: response.status(), body });
    } catch (error) {
      rejectResult(error);
    }
  }, { times: 1 });
  // Await route installation without waiting for the request triggered by the click.
  return { result };
}

// ---------------------------------------------------------------------------
// Fake PNVS transport. Installed on the module export so every route-level
// createClient() call uses it, regardless of when the client is constructed.
// ---------------------------------------------------------------------------

function installFakeProvider() {
  const phoneAuth = require('../services/phone-auth');
  const state = {
    calls: [],
    smsCode: '246810',
    verifyResult: 'PASS',
    h5Phone: `+86${SMS_PHONE}`,
    h5TokenFails: false
  };

  async function transport(url, init) {
    const params = new URLSearchParams(init.body);
    const action = params.get('Action');
    state.calls.push({ action, url, params: Object.fromEntries(params) });

    const reply = payload => ({ ok: true, async text() { return JSON.stringify(payload); } });

    switch (action) {
      case 'GetAuthToken':
        if (state.h5TokenFails) return reply({ Code: 'isv.BUSINESS_LIMIT_CONTROL' });
        return reply({ Code: 'OK', TokenInfo: { AccessToken: 'fake-access-token', JwtToken: 'fake-jwt-token' } });
      case 'GetPhoneWithToken':
        return reply({ Code: 'OK', Data: { Mobile: state.h5Phone } });
      case 'GetMobile':
        return reply({ Code: 'OK', GetMobileResultDTO: { Mobile: `+86${APP_PHONE}` } });
      case 'SendSmsVerifyCode':
        return reply({ Code: 'OK', RequestId: 'fake-request', Model: { BizId: 'fake-biz' } });
      case 'CheckSmsVerifyCode':
        return reply({ Code: 'OK', Model: { VerifyResult: state.verifyResult } });
      default:
        return reply({ Code: 'isv.INVALID_ACTION' });
    }
  }

  // The adapter receives fetchImpl through createClient's options; routes build the client
  // themselves, so the injection point is the module's client factory.
  const originalCreateClient = phoneAuth.createClient;
  phoneAuth.createClient = (config, options = {}) => originalCreateClient(config, { ...options, fetchImpl: transport });

  return {
    state,
    restore() { phoneAuth.createClient = originalCreateClient; },
    callsFor(action) { return state.calls.filter(entry => entry.action === action); }
  };
}

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';

  const provider = installFakeProvider();
  const f = await createFixture({ port });
  let browser;
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  try {
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true,
      args: ['--disable-background-networking']
    });

    async function newSession({ viewport = VIEWPORTS[0], locale = 'zh-CN' } = {}) {
      const context = await browser.newContext({ viewport, locale });
      await context.route('**/*', route =>
        new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      return { context, page, errors };
    }

    async function signIn(page, account) {
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      await page.locator('#loginUsername').fill(account.username);
      if (await page.locator('#loginForm .submit').isVisible()) {
        await page.locator('#loginForm .submit').click();
        await page.waitForFunction(() => !document.getElementById('loginPassword').disabled);
      }
      await page.locator('#loginPassword').fill(account.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/profile');
    }

    // A phone-bound account. Login authority requires phone_verified, so password-based stages
    // can opt into an initially unverified binding to prove the verification transition.
    async function phoneUser(phone, { verified = true } = {}) {
      const account = await f.user();
      await f.User.update(account.id, verified ? { phone, phoneVerified: true } : { phone });
      return { ...account, phone };
    }

    // Save provider settings exactly as an administrator would: through the real UI below.
    // Direct API helpers are only used to assert the persisted server state.
    function cookieHeader(cookies) {
      return cookies.map(item => `${item.name}=${item.value}`).join('; ');
    }

    // -----------------------------------------------------------------------
    // 1. Unconfigured: every phone surface stays hidden and no upstream call happens.
    // -----------------------------------------------------------------------
    for (const viewport of VIEWPORTS) {
      const { context, page, errors } = await newSession({ viewport });
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });

      const config = await page.evaluate(async () => (await fetch('/api/auth/phone/config')).json());
      assert.deepEqual(config, {
        h5: { enabled: false, available: false, sdkUrl: '' },
        app: { enabled: false, available: false },
        sms: { enabled: false, available: false, resendSeconds: 60 },
        registrationEnabled: false
      }, 'the default capability projection advertises nothing');

      assert.equal(await page.locator('#phoneAuthBlock').isVisible(), false, 'the phone block is hidden');
      assert.equal(await page.locator('#phoneH5Section').isVisible(), false);
      assert.equal(await page.locator('#phoneSmsForm').isVisible(), false);
      assert.equal(await page.locator('#loginForm').isVisible(), true, 'password login still works');

      await page.screenshot({ path: path.join(ARTIFACTS, `disabled-${viewport.tag}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    }
    assert.equal(provider.state.calls.length, 0, 'a disabled channel makes zero upstream requests');
    console.log('Carrier phone disabled state passed: hidden block, empty capabilities, no upstream calls');

    // -----------------------------------------------------------------------
    // 2. Admin save, reload persistence, readiness badge and secret preservation.
    // -----------------------------------------------------------------------
    const admin = await f.user('admin');
    {
      const { context, page, errors } = await newSession({ viewport: VIEWPORTS[0] });
      await signIn(page, admin);
      await page.goto(`${f.baseUrl}/security.html`);
      await page.locator('#savePhoneAuthBtn').waitFor({ state: 'visible' });

      // Nothing configured yet: the readiness badge reports "not enabled".
      await page.waitForFunction(() => document.getElementById('phoneAuthReadiness').textContent.trim() === '未启用');
      assert.match(await page.locator('#phoneAuthStatus').innerText(), /均已关闭/);

      await page.locator('#phoneAuthH5Enabled').check();
      await page.locator('#phoneAuthSmsEnabled').check();
      await page.locator('#phoneAuthAccessKeyId').fill('test-ak-id');
      await page.locator('#phoneAuthAccessKeySecret').fill('test-ak-secret');
      await page.locator('#phoneAuthSceneCode').fill('1000000001');
      await page.locator('#phoneAuthH5Origin').fill(process.env.PUBLIC_BASE_URL);
      await page.locator('#phoneAuthH5Url').fill(`${process.env.PUBLIC_BASE_URL}/oauth2/authorize`);
      await page.locator('#phoneAuthH5SdkUrl').fill('/js/fake-phone-sdk.js');
      await page.locator('#phoneAuthSmsSignName').fill('Example');
      await page.locator('#phoneAuthSmsTemplateCode').fill('SMS_000001');

      const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/phone-auth')
        && response.request().method() === 'PUT');
      await page.locator('#savePhoneAuthBtn').click();
      assert.equal((await saved).status(), 200, 'the admin save reaches the guarded route');

      // The page reloads its own state after saving, so the badge must already be complete.
      await page.waitForFunction(() => document.getElementById('phoneAuthReadiness').textContent.trim() === '配置完整');
      assert.match(await page.locator('#phoneAuthStatus').innerText(), /H5 一键登录/);
      assert.match(await page.locator('#phoneAuthStatus').innerText(), /短信验证码/);

      // Secrets are never echoed back to the browser.
      assert.equal(await page.locator('#phoneAuthAccessKeySecret').inputValue(), '');
      assert.match(await page.locator('#phoneAuthSecretHint').innerText(), /密钥已保存/);
      await page.screenshot({ path: path.join(ARTIFACTS, 'admin-configured-desktop.png'), fullPage: true });

      // A full reload must read the persisted, encrypted settings back.
      await page.reload();
      await page.locator('#savePhoneAuthBtn').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.getElementById('phoneAuthReadiness').textContent.trim() === '配置完整');
      assert.equal(await page.locator('#phoneAuthH5Enabled').isChecked(), true);
      assert.equal(await page.locator('#phoneAuthSmsEnabled').isChecked(), true);
      assert.equal(await page.locator('#phoneAuthAppEnabled').isChecked(), false);
      assert.equal(await page.locator('#phoneAuthAccessKeyId').inputValue(), 'test-ak-id');
      assert.equal(await page.locator('#phoneAuthH5SdkUrl').inputValue(), '/js/fake-phone-sdk.js');
      assert.equal(await page.locator('#phoneAuthAccessKeySecret').inputValue(), '', 'the stored secret is not re-rendered');

      // Saving again with a blank secret preserves it; the badge stays complete.
      await page.locator('#savePhoneAuthBtn').click();
      await page.waitForFunction(() => document.getElementById('phoneAuthReadiness').textContent.trim() === '配置完整');
      const preserved = await f.request('/api/admin/phone-auth', {
        cookie: cookieHeader(await context.cookies())
      });
      assert.equal(preserved.body.hasAccessKeySecret, true, 'a blank secret keeps the stored value');

      // Explicitly verifying readiness is honest: turning off every channel flips the badge.
      await page.locator('#phoneAuthH5Enabled').uncheck();
      await page.locator('#phoneAuthSmsEnabled').uncheck();
      await page.locator('#savePhoneAuthBtn').click();
      await page.waitForFunction(() => document.getElementById('phoneAuthReadiness').textContent.trim() === '未启用');

      // Restore the working configuration for the login stages below.
      await page.locator('#phoneAuthH5Enabled').check();
      await page.locator('#phoneAuthSmsEnabled').check();
      await page.locator('#savePhoneAuthBtn').click();
      await page.waitForFunction(() => document.getElementById('phoneAuthReadiness').textContent.trim() === '配置完整');

      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Carrier phone admin passed: save, persisted reload, readiness badge, secret preservation');

    // -----------------------------------------------------------------------
    // 3. SMS login at desktop and mobile, through the real challenge lifecycle.
    // -----------------------------------------------------------------------
    for (const viewport of VIEWPORTS) {
      f.reset();
      const account = await phoneUser(`+86${SMS_PHONE}`);
      provider.state.calls.length = 0;
      provider.state.verifyResult = 'PASS';

      const { context, page, errors } = await newSession({ viewport });
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#phoneAuthBlock').waitFor({ state: 'visible' });

      assert.equal(await page.locator('#phoneH5Section').isVisible(), true, 'H5 is enabled and ready');
      assert.equal(await page.locator('#phoneSmsForm').isVisible(), true, 'SMS is enabled and ready');

      // An explicit foreign country prefix must not be stripped and reinterpreted
      // as a mainland national number by the browser before it reaches the API.
      await page.locator('#phoneSmsPhone').fill('+14155550123');
      await page.locator('#phoneSmsSendBtn').click();
      await page.waitForFunction(() => {
        const node = document.getElementById('phoneAuthStatus');
        return node && node.classList.contains('is-visible') && node.textContent.trim().length > 0;
      });
      assert.equal(provider.callsFor('SendSmsVerifyCode').length, 0,
        'an explicit foreign number is rejected before any SMS request');

      await page.locator('#phoneSmsPhone').fill(SMS_PHONE);
      const send = page.waitForResponse(response => response.url().endsWith('/api/auth/phone/sms/send'));
      await page.locator('#phoneSmsSendBtn').click();
      const sent = await send;
      assert.equal(sent.status(), 200, `SMS send must succeed: ${sent.status()}`);
      const issued = await sent.json();
      assert.ok(issued.challengeId, 'the UI receives a real challenge id');
      assert.equal(issued.retryAfter, 60);
      assert.equal(issued.expiresIn, 300);
      assert.ok(!JSON.stringify(issued).includes('246810'), 'the provider code is never returned to the browser');
      assert.equal(provider.callsFor('SendSmsVerifyCode').length, 1, 'one UI send hits the provider exactly once');

      // The resend cooldown is real and driven by the server's retryAfter.
      await page.waitForFunction(() => document.getElementById('phoneSmsSendBtn').disabled);
      assert.match(await page.locator('#phoneSmsSendBtn').innerText(), /60|59/);

      // A wrong code is rejected by the provider verdict and reports a readable error.
      provider.state.verifyResult = 'FAIL';
      await page.locator('#phoneSmsCode').fill('111111');
      await page.locator('#phoneSmsSubmit').click();
      await page.waitForFunction(() => {
        const node = document.getElementById('phoneAuthStatus');
        return node && node.classList.contains('is-visible') && node.textContent.trim().length > 0;
      });
      assert.equal((await context.cookies()).some(item => item.name === 'session'), false,
        'a failed verification issues no session cookie');

      // The correct code completes the real login and lands on the return path.
      provider.state.verifyResult = 'PASS';
      await page.locator('#phoneSmsCode').fill('222222');
      const completion = page.waitForResponse(response => response.url().endsWith('/api/auth/phone/sms/login'));
      await page.locator('#phoneSmsSubmit').click();
      assert.equal((await completion).status(), 200, 'the second verification succeeds');
      await page.waitForURL('**/profile');
      assert.equal(provider.callsFor('CheckSmsVerifyCode').length, 2);

      const cookie = (await context.cookies()).find(item => item.name === 'session');
      assert.ok(cookie, 'a completed phone login issues the real session cookie');
      const claims = jwt.verify(cookie.value, process.env.JWT_SECRET);
      assert.equal(claims.sub, account.id, 'the phone login authenticates the real bound account');
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 200);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(ARTIFACTS, `sms-login-${viewport.tag}.png`), fullPage: true }).catch(() => {});
      await context.close();
    }
    console.log('Carrier phone SMS login passed: send, cooldown, wrong code, real login, desktop and mobile');

    // -----------------------------------------------------------------------
    // 3b. SMS login that completes an OAuth authorization request. The handoff must
    // return through the registered redirect, and the phone claim obeys the granted scope.
    // -----------------------------------------------------------------------
    {
      f.reset();
      const account = await phoneUser(`+86${SMS_PHONE}`);
      provider.state.calls.length = 0;
      const client = await f.client({ requirePkce: false });
      const params = new URLSearchParams({
        client_id: client.id, redirect_uri: client.redirectUris[0], response_type: 'code',
        scope: 'openid profile email', state: 'phone-browser-state', nonce: 'phone-browser-nonce'
      });
      provider.state.verifyResult = 'PASS';

      const { context, page, errors } = await newSession({ viewport: VIEWPORTS[0] });
      await page.goto(`${f.baseUrl}/oauth2/authorize?${params}`);
      await page.locator('#phoneAuthBlock').waitFor({ state: 'visible' });

      await page.locator('#phoneSmsPhone').fill(SMS_PHONE);
      const send = page.waitForResponse(response => response.url().endsWith('/api/auth/phone/sms/send'));
      await page.locator('#phoneSmsSendBtn').click();
      assert.equal((await send).status(), 200);

      const { result: completion } = await captureJson(page, '/api/auth/phone/sms/login');
      await page.locator('#phoneSmsCode').fill('555555');
      await page.locator('#phoneSmsSubmit').click();
      const captured = await completion;
      assert.equal(captured.status, 200, 'OAuth SMS login must complete');

      const body = captured.body;
      assert.ok(body.redirect, 'the OAuth handoff returns a redirect target');
      assert.match(body.redirect, /state=phone-browser-state/, 'the original state is preserved');
      // The client never requested the phone scope, so the handoff withholds the number.
      assert.equal(body.phone, null, 'the phone number is withheld without the phone scope');
      assert.equal(body.phoneStatus, 'scope_not_granted');
      assert.equal(body.user.phoneE164, '', 'the projected user hides the number too');

      // This is a browser OAuth login, so it also establishes the gateway session.
      // Native App requests use the separate code-only/no-cookie handoff contract.
      const browserSession = (await context.cookies()).find(item => item.name === 'session');
      assert.ok(browserSession, 'browser OAuth phone login establishes a gateway session');
      assert.equal(jwt.verify(browserSession.value, process.env.JWT_SECRET).sub, account.id);

      // The authorization code really is exchangeable by the client.
      const code = new URL(body.redirect).searchParams.get('code');
      assert.ok(code, 'the redirect carries a real authorization code');
      const token = await f.request('/oauth2/token', { method: 'POST', data: {
        grant_type: 'authorization_code', client_id: client.id, client_secret: client.clearSecret,
        redirect_uri: client.redirectUris[0], code
      } });
      assert.equal(token.status, 200, 'the code exchanges for a token');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Carrier phone OAuth handoff passed: state preserved, browser session established, phone withheld without scope, code exchanges');

    // -----------------------------------------------------------------------
    // 4. H5 SDK fixture: provider consent, MFA fallback and the real login result.
    // -----------------------------------------------------------------------
    {
      f.reset();
      const account = await phoneUser(`+86${SMS_PHONE}`);
      provider.state.calls.length = 0;

      const { context, page, errors } = await newSession({ viewport: VIEWPORTS[0] });
      // Serve a fixture SDK that behaves like the official PhoneNumberServer surface the page uses.
      await page.route('**/js/fake-phone-sdk.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.PhoneNumberServer = function PhoneNumberServer() {
            this.on = function () {};
            this.checkLoginAvailable = function (options) {
              if (typeof options.success === 'function') options.success({ code: '600000' });
            };
            this.getLoginToken = function (options) {
              if (typeof options.watch === 'function') options.watch(5, {});
              if (typeof options.success === 'function') options.success({ code: '600000', spToken: 'fake-sp-token' });
              // The official SDK may report a terminal close after success is
              // delivered. The page must retain its busy lock during proof exchange.
              if (typeof options.watch === 'function') options.watch(2, {});
            };
            this.closeLoginPage = function () {};
            window.__phoneSdkCalls = (window.__phoneSdkCalls || 0) + 1;
            sessionStorage.setItem('__phoneSdkCalls', String(window.__phoneSdkCalls));
          };
        `
      }));

      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#phoneAuthBlock').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#phoneH5Section').isVisible(), true);

      const tokenRequest = page.waitForResponse(response => response.url().endsWith('/api/auth/phone/h5/token'));
      const { result: loginResponse } = await captureJson(page, '/api/auth/phone/h5/login');
      await page.locator('#phoneH5Btn').click();
      const token = await tokenRequest;
      assert.equal(token.status(), 200, 'H5 token must be issued');
      const issued = await token.json();
      assert.ok(issued.challengeId, 'the token response carries a local challenge id');
      assert.equal(issued.accessToken, 'fake-access-token', 'only the SDK-facing token reaches the browser');
      assert.equal(provider.callsFor('GetAuthToken').length, 1);
      await page.waitForFunction(() => sessionStorage.getItem('__phoneSdkCalls') === '1', undefined, { timeout: 15000 });

      const captured = await loginResponse;
      assert.equal(captured.status, 200, 'H5 login must complete');
      assert.equal(provider.callsFor('GetPhoneWithToken').length, 1, 'the number is resolved server-side');

      const body = captured.body;
      // Either the flow finished with a redirect, or it correctly stopped at the second factor.
      const navigationTarget = body.mfa_url || body.redirect;
      assert.ok(navigationTarget, `the H5 login must return a navigation target: ${JSON.stringify(body)}`);
      await page.waitForURL(url => !url.pathname.endsWith('/oauth2/authorize'));

      // The completed H5 login authenticates the real phone owner.
      const cookie = (await context.cookies()).find(item => item.name === 'session');
      assert.ok(cookie, 'the H5 login issues the real session cookie');
      assert.equal(jwt.verify(cookie.value, process.env.JWT_SECRET).sub, account.id);

      // No provider credential is ever exposed to page script.
      const leaked = await page.evaluate(() => JSON.stringify({
        local: { ...localStorage }, session: { ...sessionStorage }
      }));
      assert.ok(!leaked.includes('test-ak-secret'), 'the access key secret never reaches the browser');
      assert.ok(!leaked.includes('fake-sp-token'), 'the spToken is not persisted client-side');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Carrier phone H5 passed: fixture SDK consent, server-side number resolution, MFA/redirect handoff');

    // -----------------------------------------------------------------------
    // 4b. Closing the provider authorization page is a terminal SDK event and
    // must release the cross-method busy lock without completing a phone login.
    // -----------------------------------------------------------------------
    {
      f.reset();
      provider.state.calls.length = 0;

      const { context, page, errors } = await newSession({ viewport: VIEWPORTS[1] });
      await page.route('**/js/fake-phone-sdk.js', route => route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.PhoneNumberServer = function PhoneNumberServer() {
            this.checkLoginAvailable = function (options) {
              if (typeof options.success === 'function') options.success({ code: '600000' });
            };
            this.getLoginToken = function (options) {
              window.__closePhoneAuth = function () {
                if (typeof options.watch === 'function') options.watch(2, { source: 'user-close' });
              };
            };
            this.closeLoginPage = function () {};
          };
        `
      }));

      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#phoneAuthBlock').waitFor({ state: 'visible' });
      const tokenRequest = page.waitForResponse(response => response.url().endsWith('/api/auth/phone/h5/token'));
      await page.locator('#phoneH5Btn').click();
      assert.equal((await tokenRequest).status(), 200);
      await page.waitForFunction(() => typeof window.__closePhoneAuth === 'function');
      assert.equal(await page.locator('#phoneH5Btn').isDisabled(), true,
        'H5 and other authentication methods remain locked while consent is open');

      await page.evaluate(() => window.__closePhoneAuth());
      await page.waitForFunction(() => !document.getElementById('phoneH5Btn').disabled);
      assert.equal(provider.callsFor('GetPhoneWithToken').length, 0,
        'closing consent does not exchange a phone proof');
      assert.equal((await context.cookies()).some(item => item.name === 'session'), false,
        'closing consent creates no session');

      // The unlocked SMS route can now proceed, proving the shared action lock was released.
      await page.locator('#phoneSmsPhone').fill(SMS_PHONE);
      const smsSend = page.waitForResponse(response => response.url().endsWith('/api/auth/phone/sms/send'));
      await page.locator('#phoneSmsSendBtn').click();
      assert.equal((await smsSend).status(), 200, 'another login method is usable after closing H5 consent');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Carrier phone H5 close passed: watch status 2 releases actions without login; SMS remains available');

    // -----------------------------------------------------------------------
    // 5. H5 provider rejection stays readable and issues no session.
    // -----------------------------------------------------------------------
    {
      f.reset();
      await phoneUser(`+86${SMS_PHONE}`);
      provider.state.calls.length = 0;
      provider.state.h5TokenFails = true;
      const { context, page, errors } = await newSession({ viewport: VIEWPORTS[1] });
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#phoneAuthBlock').waitFor({ state: 'visible' });

      const failed = page.waitForResponse(response => response.url().endsWith('/api/auth/phone/h5/token'));
      await page.locator('#phoneH5Btn').click();
      const response = await failed;
      assert.ok(response.status() >= 400, 'an upstream rejection is not reported as success');
      await page.waitForFunction(() => {
        const button = document.getElementById('phoneH5Btn');
        const status = document.getElementById('phoneAuthStatus');
        return button && !button.disabled && status && status.classList.contains('is-visible')
          && status.textContent.trim().length > 0;
      });
      const text = await page.locator('#phoneAuthStatus').innerText();
      assert.ok(text.trim().length > 0, 'the user sees a readable error');
      assert.ok(!/isv\.BUSINESS_LIMIT_CONTROL/.test(text), 'raw upstream codes are never shown');
      assert.equal((await context.cookies()).some(item => item.name === 'session'), false);
      assert.equal(await page.locator('#phoneH5Btn').isDisabled(), false, 'the button recovers for a retry');
      await page.screenshot({ path: path.join(ARTIFACTS, 'h5-rejected-mobile.png'), fullPage: true }).catch(() => {});
      assert.deepEqual(errors, []);
      await context.close();
      provider.state.h5TokenFails = false;
    }
    console.log('Carrier phone H5 rejection passed: readable error, no session, button recovers');

    // -----------------------------------------------------------------------
    // 6. Profile SMS verification of the already-bound number.
    // -----------------------------------------------------------------------
    {
      f.reset();
      // Bound but not yet verified: completing SMS verification must flip the flag itself.
      const account = await phoneUser(`+86${APP_PHONE}`, { verified: false });
      assert.equal((await f.User.findById(account.id)).phone_verified, false, 'precondition: unverified binding');
      provider.state.calls.length = 0;
      provider.state.verifyResult = 'PASS';
      const { context, page, errors } = await newSession({ viewport: VIEWPORTS[1] });
      await signIn(page, account);
      await page.goto(`${f.baseUrl}/profile`);
      await page.locator('#phoneSmsVerifyRow').waitFor({ state: 'visible' });

      assert.equal(await page.locator('#phoneSmsVerifyStartBtn').isVisible(), true,
        'the verify row appears only for a bound phone with an available SMS channel');

      const send = page.waitForResponse(response => response.url().endsWith('/api/profile/phone/sms/send'));
      await page.locator('#phoneSmsVerifyStartBtn').click();
      assert.equal((await send).status(), 200, 'the profile challenge is issued for the bound number');
      // Modals open by gaining the `show` class, not by clearing `hidden`.
      await page.waitForFunction(() => document.getElementById('phoneSmsModal').classList.contains('show'));
      assert.equal(provider.callsFor('SendSmsVerifyCode').length, 1);

      // The challenge is bound to the current session; a wrong code must not verify.
      provider.state.verifyResult = 'FAIL';
      await page.locator('#phoneSmsCode').fill('333333');
      await page.locator('#phoneSmsVerifySubmit').click();
      await page.waitForFunction(() => !document.getElementById('phoneSmsError').classList.contains('hidden'));
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 200,
        'a failed profile verification keeps the session');

      // The account phone is unchanged: verification never silently rebinds.
      const profile = await (await context.request.get(`${f.baseUrl}/api/profile`)).json();
      assert.equal(profile.user.phoneE164, `+86${APP_PHONE}`);

      provider.state.verifyResult = 'PASS';
      await page.locator('#phoneSmsCode').fill('444444');
      await page.locator('#phoneSmsVerifySubmit').click();
      await page.waitForFunction(() => !document.getElementById('phoneSmsModal').classList.contains('show'));

      const verified = await (await context.request.get(`${f.baseUrl}/api/profile`)).json();
      assert.equal(verified.user.phoneVerified, true, 'verification flips the stored flag');
      assert.equal(verified.user.phoneE164, `+86${APP_PHONE}`, 'verification does not change the stored number');
      assert.equal((await f.User.findById(account.id)).phone_verified, true, 'the durable row is marked verified');
      assert.equal(provider.callsFor('CheckSmsVerifyCode').length, 2);
      // The current session survives the verification-triggered revocation sweep.
      assert.equal((await context.request.get(`${f.baseUrl}/api/profile`)).status(), 200);
      await page.screenshot({ path: path.join(ARTIFACTS, 'profile-verify-mobile.png'), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Carrier phone profile verification passed: bound number only, failed code keeps session, no rebinding');
  } finally {
    if (browser) await browser.close();
    provider.restore();
    await f.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
