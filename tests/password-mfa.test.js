const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createFixture, randomSecret } = require('./support/fixture');

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

function enableEmail() { f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' }); }
function complete(pending, code) {
  return f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: pending.cookie, data: { code } });
}

test('password email verification has no session until its separate challenge completes and cannot replay', async () => {
  enableEmail();
  const user = await f.user();
  const pending = await f.login(user);
  assert.equal(pending.body.mfa_url, '/oauth2/mfa');
  assert.equal(pending.body.require_email_code, true);
  assert.equal(f.pool.sessions.length, 0);
  assert.equal((await f.request('/api/profile', { cookie: pending.cookie })).status, 401);
  assert.equal((await f.request('/api/v1/auth/oauth/oidc/pending', { cookie: pending.cookie })).body.factor, 'email');
  const code = f.lastCode(user.email);
  assert.equal((await complete(pending, 'wrong')).status, 400);
  const finished = await complete(pending, code);
  assert.equal(finished.status, 200);
  assert.equal(finished.body.redirect, '/profile');
  assert.equal((await f.request('/api/profile', { cookie: finished.cookie })).status, 200);
  assert.equal((await complete(pending, code)).status, 401);
});

test('pending OAuth continuation retains maximum encoded state nonce and PKCE with a small signed cookie', async () => {
  enableEmail();
  const user = await f.user();
  const client = await f.client();
  const verifier = randomSecret();
  const oauth = { client_id: client.id, redirect_uri: client.redirectUris[0], scope: 'openid email',
    state: '%'.repeat(2048), nonce: randomSecret(), response_type: 'code',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
  const pending = await f.login(user, oauth);
  const token = decodeURIComponent(pending.cookie.match(/oidc_pending=([^;]+)/)[1]);
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  assert.ok(Buffer.byteLength(`oidc_pending=${token}`) < 4096);
  assert.equal(payload.returnTo, undefined);
  assert.ok(!JSON.stringify(payload).includes(oauth.state));
  const stored = f.pool.emailVerificationCodes.find(row => row.id === payload.jti);
  assert.equal(new URL(stored.pending_context.returnTo, process.env.PUBLIC_BASE_URL).searchParams.get('state'), oauth.state);
  assert.ok(!JSON.stringify(payload).includes(user.clearPassword));
  assert.ok(!JSON.stringify(payload).includes(user.password));
  const completed = await complete(pending, f.lastCode(user.email));
  const continuation = new URL(completed.body.redirect, process.env.PUBLIC_BASE_URL);
  for (const [key, value] of Object.entries(oauth)) assert.equal(continuation.searchParams.get(key), value);
  const authorized = await f.request(continuation.pathname + continuation.search, { cookie: completed.cookie });
  assert.equal(authorized.status, 302);
  const redirect = new URL(authorized.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), oauth.state);
  const exchanged = await f.exchange(client, { code: redirect.searchParams.get('code'), verifier });
  assert.equal(exchanged.status, 200);
  assert.equal(jwt.decode(exchanged.body.id_token).nonce, oauth.nonce);
});

test('password authenticator challenge accepts an unused recovery code on the separate page', async () => {
  const user = await f.user();
  const recovery = 'ABCD2345EFGH6789';
  await f.User.update(user.id, { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP',
    recoveryCodes: JSON.stringify([crypto.createHash('sha256').update(recovery).digest('hex')]) });
  const pending = await f.login(user);
  assert.equal(pending.body.require_totp, true);
  assert.equal(f.pool.sessions.length, 0);
  assert.equal((await complete(pending, recovery)).status, 200);
  assert.equal((await complete(pending, recovery)).status, 401);
});

test('expired or exhausted password challenges never create a session', async () => {
  enableEmail();
  const user = await f.user();
  let pending = await f.login(user);
  f.pool.emailVerificationCodes.find(row => row.purpose === 'password_mfa').expires_at = new Date(Date.now() - 1000);
  assert.equal((await complete(pending, f.lastCode(user.email))).status, 401);
  f.pool.rateLimits.length = 0;
  pending = await f.login(user);
  assert.equal(pending.body.mfa_url, '/oauth2/mfa');
  for (let i = 0; i < 5; i += 1) assert.equal((await complete(pending, 'wrong')).status, 400);
  assert.equal((await complete(pending, f.lastCode(user.email))).status, 429);
  assert.equal(f.pool.sessions.length, 0);
});

test('password phone email and authenticator changes invalidate pending password challenges', async () => {
  enableEmail();
  const user = await f.user();
  for (const updates of [
    { password: randomSecret() }, { phoneCountryCode: '+86', phoneNumber: '13800138000' },
    { email: 'changed@example.test' }, { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP' }
  ]) {
    f.pool.rateLimits.length = 0;
    const pending = await f.login(user);
    assert.equal(pending.body.mfa_url, '/oauth2/mfa');
    const code = f.lastCode((await f.User.findById(user.id)).email);
    if (updates.password) await f.User.updatePassword(user.id, updates.password);
    else await f.User.update(user.id, updates);
    assert.equal((await complete(pending, code)).status, 401);
    if (updates.password) user.clearPassword = updates.password;
  }
  assert.equal(f.pool.sessions.length, 0);
});

test('wrong password and missing CAPTCHA never create a pending verification', async () => {
  enableEmail();
  const user = await f.user();
  assert.equal((await f.login(user, { password: 'wrong-password' })).status, 401);
  assert.equal(f.pool.emailVerificationCodes.length, 0);
  f.pool.settings.push({ setting_key: 'captcha_login', setting_value: 'true' });
  assert.equal((await f.login(user)).body.error_key, 'captcha.required');
  assert.equal(f.pool.emailVerificationCodes.length, 0);
  const captcha = await f.request('/api/captcha');
  const pending = await f.login(user, { captcha_id: captcha.body.id, captcha_code: f.captchaAnswers.at(-1) });
  assert.equal(pending.body.mfa_url, '/oauth2/mfa');
  assert.equal((await complete(pending, f.lastCode(user.email))).status, 200);
});

test('direct-code email clients remain compatible', async () => {
  enableEmail();
  const user = await f.user();
  await f.login(user);
  const authenticated = await f.login(user, { email_code: f.lastCode(user.email) });
  assert.equal(authenticated.status, 200);
  assert.equal(authenticated.body.redirect, '/profile');
  assert.equal((await f.request('/api/profile', { cookie: authenticated.cookie })).status, 200);
});

test('revealing CAPTCHA preserves the only password attempt while wrong passwords still lock out', async () => {
  f.pool.settings.push({ setting_key: 'captcha_login', setting_value: 'true' },
    { setting_key: 'login_max_attempts', setting_value: '1' });
  const user = await f.user();
  for (let i = 0; i < 3; i += 1) assert.equal((await f.login(user)).body.error_key, 'captcha.required');
  assert.ok(!f.pool.rateLimits.some(row => row.rate_key === crypto.createHash('sha256').update(`login:${user.id}`).digest('hex')));
  let captcha = await f.request('/api/captcha');
  assert.equal((await f.login(user, { captcha_id: captcha.body.id, captcha_code: f.captchaAnswers.at(-1) })).status, 200);
  captcha = await f.request('/api/captcha');
  assert.equal((await f.login(user, { password: 'wrong-password', captcha_id: captcha.body.id, captcha_code: f.captchaAnswers.at(-1) })).status, 401);
  captcha = await f.request('/api/captcha');
  const locked = await f.login(user, { captcha_id: captcha.body.id, captcha_code: f.captchaAnswers.at(-1) });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error_key, 'auth.locked');
});

test('unregistered OAuth redirects are rejected before issuing pending verification', async () => {
  enableEmail();
  const user = await f.user();
  const client = await f.client();
  const invalid = await f.login(user, { client_id: client.id, redirect_uri: 'https://attacker.example.test' });
  assert.equal(invalid.status, 400);
  assert.equal(f.pool.emailVerificationCodes.length, 0);
});

test('missing malformed or unsafe persisted continuations never authenticate', async () => {
  enableEmail();
  const user = await f.user();
  const pending = await f.login(user);
  const code = f.lastCode(user.email);
  const row = f.pool.emailVerificationCodes.find(record => record.purpose === 'password_mfa');
  for (const context of [null, '{invalid', { returnTo: 'https://attacker.example.test' }, { returnTo: '//attacker.example.test' }]) {
    row.pending_context = context;
    assert.equal((await complete(pending, code)).status, 401);
  }
  row.pending_context = JSON.stringify({ returnTo: '/profile' });
  assert.equal((await complete(pending, code)).status, 200, 'JSON text from compatible database drivers also hydrates');
});
