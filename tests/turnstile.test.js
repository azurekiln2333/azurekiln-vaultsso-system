const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./support/fixture');
const { verifyTurnstile } = require('../services/turnstile');

test('Siteverify checks token, client IP, hostname, and action', async () => {
  const result = await verifyTurnstile({
    token: 'valid-token', secret: 'server-secret', ip: '192.0.2.10',
    hostname: 'login.example.test', action: 'login',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('secret'), 'server-secret');
      assert.equal(options.body.get('response'), 'valid-token');
      assert.equal(options.body.get('remoteip'), '192.0.2.10');
      return new Response(JSON.stringify({ success: true, hostname: 'login.example.test', action: 'login' }));
    }
  });
  assert.deepEqual(result, { ok: true, unavailable: false });
  assert.equal((await verifyTurnstile({
    token: 'valid-token', secret: 'server-secret', hostname: 'login.example.test', action: 'register',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, hostname: 'login.example.test', action: 'login' }))
  })).ok, false);
  assert.equal((await verifyTurnstile({
    token: 'valid-token', secret: 'server-secret', hostname: 'other.example.test', action: 'login',
    fetchImpl: async () => new Response(JSON.stringify({ success: true, hostname: 'login.example.test', action: 'login' }))
  })).ok, false);
  assert.deepEqual(await verifyTurnstile({
    token: 'valid-token', secret: 'server-secret', action: 'login',
    fetchImpl: async () => { throw new Error('Network unavailable'); }
  }), { ok: false, unavailable: true });
});

let fixture;
let originalFetch;
const usedTokens = new Set();

before(async () => {
  process.env.TURNSTILE_SITE_KEY = 'test-site-key';
  process.env.TURNSTILE_SECRET_KEY = 'test-server-secret';
  originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url) !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      return originalFetch(url, options);
    }
    const token = options.body.get('response');
    if (token === 'unavailable') throw new Error('Network unavailable');
    const action = token.includes('register') ? 'register' : 'login';
    const success = token.startsWith('valid-') && !usedTokens.has(token);
    usedTokens.add(token);
    return new Response(JSON.stringify({ success, hostname: 'gateway.example.test', action }));
  };
  fixture = await createFixture();
});

after(async () => {
  if (fixture) await fixture.close();
  global.fetch = originalFetch;
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
});

test('web forms use Turnstile while direct app requests keep image CAPTCHA', async () => {
  const account = await fixture.user();
  const nativeConfig = await fixture.request('/api/auth/config');
  assert.equal(nativeConfig.body.captchaProvider, 'image');
  assert.equal(nativeConfig.body.turnstileSiteKey, '');
  assert.equal(nativeConfig.body.captchaLogin, true);
  const config = await fixture.request('/api/auth/config?surface=web');
  assert.equal(config.body.turnstileSiteKey, 'test-site-key');
  assert.equal(config.body.captchaProvider, 'turnstile');
  assert.equal(config.body.captchaLogin, true);
  assert.equal(config.body.captchaRegister, true);
  assert.ok(!JSON.stringify(config.body).includes('test-server-secret'));

  const app = await fixture.client();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const probe = await fixture.login(account, {
    check_verification: true, client_id: app.id, redirect_uri: app.redirectUris[0],
    response_type: 'code', scope: 'openid',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.captcha_provider, 'image');

  assert.equal((await fixture.login(account, { captcha_surface: 'web' })).body.error_key, 'turnstile.required');
  assert.equal((await fixture.login(account, { captcha_surface: 'web', turnstile_response: 'invalid' })).body.error_key, 'turnstile.invalid');
  const unavailable = await fixture.login(account, { captcha_surface: 'web', turnstile_response: 'unavailable' });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error_key, 'turnstile.unavailable');
  assert.equal((await fixture.login(account, { captcha_surface: 'web', turnstile_response: 'valid-login-1' })).status, 200);
  assert.equal((await fixture.login(account, { captcha_surface: 'web', turnstile_response: 'valid-login-1' })).body.error_key, 'turnstile.invalid');

  assert.equal((await fixture.login(account, { turnstile_response: 'valid-login-native' })).body.error_key, 'captcha.required');
  const nativeCaptcha = await fixture.request('/api/captcha');
  assert.equal((await fixture.login(account, {
    captcha_id: nativeCaptcha.body.id, captcha_code: fixture.captchaAnswers.at(-1)
  })).status, 200);
  const webImage = await fixture.request('/api/captcha');
  assert.equal((await fixture.login(account, {
    captcha_surface: 'web', captcha_id: webImage.body.id, captcha_code: fixture.captchaAnswers.at(-1)
  })).body.error_key, 'turnstile.required');

  const missing = await fixture.request('/oauth2/register', { method: 'POST', data: { captcha_surface: 'web' } });
  assert.equal(missing.body.error_key, 'turnstile.required');
  const verified = await fixture.request('/oauth2/register', {
    method: 'POST', data: { captcha_surface: 'web', turnstile_response: 'valid-register-1' }
  });
  assert.notEqual(verified.body.error_key, 'turnstile.required');
  assert.notEqual(verified.body.error_key, 'turnstile.invalid');
  const nativeRegisterCaptcha = await fixture.request('/api/captcha');
  const nativeRegistration = await fixture.request('/oauth2/register', {
    method: 'POST', data: { captcha_id: nativeRegisterCaptcha.body.id, captcha_code: fixture.captchaAnswers.at(-1) }
  });
  assert.equal(nativeRegistration.body.error_key, 'validation.email.invalid');

  fixture.pool.settings.push({ setting_key: 'captcha_login', setting_value: 'false' });
  assert.equal((await fixture.request('/api/auth/config')).body.captchaLogin, false);
});
