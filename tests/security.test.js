const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createFixture, randomSecret } = require('./support/fixture');
const { readRuntimeConfig } = require('../config/runtime');

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

test('startup creates no accounts, clients or identity providers', () => {
  assert.equal(f.pool.users.length, 0);
  assert.equal(f.pool.clients.length, 0);
  assert.equal(f.pool.oidcProviders.length, 0);
  const runtimeModule = require.cache[require.resolve('../server')];
  const seen = new Set();
  function inspect(module) {
    if (seen.has(module.id)) return;
    seen.add(module.id);
    assert.ok(!module.id.includes('tests\\support') && !module.id.includes('tests/support'));
    for (const child of module.children) inspect(child);
  }
  inspect(runtimeModule);
});

test('production rejects placeholder secrets, HTTP, memory drivers and insecure cookies', () => {
  const good = { NODE_ENV: 'production', JWT_SECRET: randomSecret(), PUBLIC_BASE_URL: 'https://login.example.test' };
  assert.equal(readRuntimeConfig(good).secureCookies, true);
  for (const bad of [
    { JWT_SECRET: '' }, { JWT_SECRET: 'your-super-secret-jwt-key-change-in-production' },
    { PUBLIC_BASE_URL: 'http://login.example.test' }, { PUBLIC_BASE_URL: 'https://user:pass@login.example.test' },
    { DB_DRIVER: 'memory' }, { COOKIE_SECURE: 'false' }, { TRUST_PROXY: 'true' }, { EMAIL_DEV_CODE: '123456' }
  ]) assert.throws(() => readRuntimeConfig({ ...good, ...bad }));
});

test('the first public registration stays an ordinary user and ignores a forged role', async () => {
  const email = `first-${crypto.randomUUID()}@example.test`;
  const password = randomSecret();
  assert.equal((await f.request('/api/email-verification/send', { method: 'POST', data: { email, purpose: 'register' } })).status, 200);
  const registered = await f.request('/oauth2/register', {
    method: 'POST', data: { email, password, email_code: f.lastCode(email), role: 'admin' }
  });
  assert.equal(registered.status, 200);
  const profile = await f.request('/api/profile', { cookie: registered.cookie });
  assert.equal(profile.body.user.role, 'user');
  assert.equal(profile.body.user.emailVerified, true);
  assert.equal((await f.request('/api/clients', { cookie: registered.cookie })).status, 403);
});

test('admin APIs and static pages reject unauthenticated and ordinary users', async () => {
  const user = await f.user();
  const login = await f.login(user);
  for (const route of ['/api/users', '/api/clients', '/api/tokens', '/api/admin/security', '/api/admin/oidc']) {
    assert.equal((await f.request(route)).status, 401, route);
    assert.equal((await f.request(route, { cookie: login.cookie })).status, 403, route);
  }
  for (const route of ['/apps.html', '/Apps.HTML', '/%61pps.html', '/%2e/apps.html', '/security.html']) {
    assert.notEqual((await f.request(route)).status, 200, route);
  }
  assert.equal((await f.request('/callback?code=%3Cscript%3Ebad%3C/script%3E')).status, 404);
});

test('cross-origin writes are rejected before mutation and responses are not cacheable', async () => {
  const admin = await f.user('admin');
  const login = await f.login(admin);
  for (const origin of ['https://evil.example.test', 'http://gateway.example.test', 'null', '']) {
    const result = await f.request('/api/admin/security', {
      method: 'PUT', cookie: login.cookie, headers: { Origin: origin }, data: { registrationEnabled: false }
    });
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(f.pool.settings.length, 0);
  const profile = await f.request('/api/profile', { cookie: login.cookie });
  assert.equal(profile.headers.get('cache-control'), 'no-store');
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(login.headers.get('set-cookie'), /Secure/i);
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/i);
});

test('logout revokes the database session and rejects replay of its cookie', async () => {
  const user = await f.user();
  const login = await f.login(user);
  const sessions = await f.request('/api/account/sessions', { cookie: login.cookie });
  assert.equal(sessions.body.length, 1);
  assert.equal(sessions.body[0].current, true);
  assert.ok(!Object.hasOwn(sessions.body[0], 'token'));
  assert.equal((await f.request('/oauth2/logout', { cookie: login.cookie })).status, 302);
  assert.ok(f.pool.sessions[0].revoked_at);
  assert.equal((await f.request('/api/profile', { cookie: login.cookie })).status, 401);
});

test('revoke-others retains the current session by database ID', async () => {
  const user = await f.user();
  const first = await f.login(user);
  const second = await f.login(user);
  assert.equal((await f.request('/api/account/sessions/revoke-others', { method: 'POST', cookie: second.cookie })).status, 200);
  assert.equal((await f.request('/api/profile', { cookie: first.cookie })).status, 401);
  assert.equal((await f.request('/api/profile', { cookie: second.cookie })).status, 200);
});

test('sliding renewal extends the same row and cannot exceed absolute expiry', async () => {
  const user = await f.user();
  await f.login(user);
  const row = f.pool.sessions[0];
  const issued = Math.floor(Date.now() / 1000) - 1900;
  const token = jwt.sign({ sub: user.id, sid: row.token, type: 'session', iss: process.env.PUBLIC_BASE_URL,
    aud: process.env.PUBLIC_BASE_URL, iat: issued, exp: issued + 3600 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const renewed = await f.request('/api/profile', { cookie: `session=${token}` });
  assert.equal(renewed.status, 200);
  assert.ok(renewed.cookie.includes('session='));
  assert.equal(f.pool.sessions.length, 1);
  assert.equal(row.revoked_at, null);
  row.created_at = new Date(Date.now() - 13 * 60 * 60 * 1000);
  assert.equal((await f.request('/api/profile', { cookie: renewed.cookie })).status, 401);
});

test('authorization requires registered HTTPS redirects and S256 PKCE', async () => {
  const app = await f.client();
  const params = new URLSearchParams({ response_type: 'code', client_id: app.id, redirect_uri: app.redirectUris[0], scope: 'openid' });
  assert.equal((await f.request(`/oauth2/authorize?${params}`)).status, 400);
  params.set('code_challenge', randomSecret());
  params.set('code_challenge_method', 'plain');
  assert.equal((await f.request(`/oauth2/authorize?${params}`)).status, 400);
  params.set('code_challenge_method', 'S256');
  params.set('redirect_uri', 'https://attacker.example.test/callback');
  assert.equal((await f.request(`/oauth2/authorize?${params}`)).status, 400);
});

test('client PKCE policy defaults to required and omitted API updates preserve it', async () => {
  const admin = await f.user('admin');
  const login = await f.login(admin);
  const id = `api-client-${crypto.randomUUID()}`;
  const data = {
    id, name: 'API default client', redirectUris: ['https://client.example.test/callback'], scopes: ['openid']
  };
  const invalid = await f.request('/api/clients', {
    method: 'POST', cookie: login.cookie,
    data: { ...data, id: `invalid-${crypto.randomUUID()}`, requirePkce: 'false' }
  });
  assert.equal(invalid.status, 400);

  const created = await f.request('/api/clients', { method: 'POST', cookie: login.cookie, data });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.client.requirePkce, true);

  const update = { name: data.name, redirectUris: data.redirectUris, scopes: data.scopes, requirePkce: false };
  const optedOut = await f.request(`/api/clients/${id}`, { method: 'PUT', cookie: login.cookie, data: update });
  assert.equal(optedOut.status, 200);
  assert.equal(optedOut.body.client.requirePkce, false);

  delete update.requirePkce;
  const preserved = await f.request(`/api/clients/${id}`, { method: 'PUT', cookie: login.cookie, data: update });
  assert.equal(preserved.status, 200);
  assert.equal(preserved.body.client.requirePkce, false);
});

test('clients may omit PKCE only when disabled, but supplied S256 still requires the matching verifier', async () => {
  const user = await f.user();
  const app = await f.client({ requirePkce: false });
  assert.equal(app.requirePkce, false);
  const noPkceGrant = await f.authorize(user, app, 'openid', undefined, { pkce: false });
  const noPkceCode = f.pool.authCodes.find(code => code.code === noPkceGrant.code);
  assert.equal(noPkceCode.code_challenge, null);
  noPkceCode.code_challenge_method = 'S256';
  assert.equal((await f.exchange(app, noPkceGrant)).status, 400);
  noPkceCode.code_challenge_method = null;
  const noPkceToken = await f.exchange(app, noPkceGrant);
  assert.equal(noPkceToken.status, 200, JSON.stringify(noPkceToken.body));

  const incompleteParams = new URLSearchParams({
    response_type: 'code', client_id: app.id, redirect_uri: app.redirectUris[0], scope: 'openid', code_challenge_method: 'S256'
  });
  assert.equal((await f.request(`/oauth2/authorize?${incompleteParams}`, { cookie: noPkceGrant.cookie })).status, 400);

  const optionalPkceGrant = await f.authorize(user, app);
  assert.equal((await f.exchange(app, optionalPkceGrant, { code_verifier: randomSecret() })).status, 400);
  assert.equal((await f.exchange(app, optionalPkceGrant)).status, 200);
});

test('changing client PKCE policy does not alter requirements for issued codes', async () => {
  const admin = await f.user('admin');
  const app = await f.client();
  const requiredGrant = await f.authorize(admin, app);
  const update = { name: app.name, redirectUris: app.redirectUris, scopes: app.scopes, requirePkce: false };
  assert.equal((await f.request(`/api/clients/${app.id}`, { method: 'PUT', cookie: requiredGrant.cookie, data: update })).status, 200);
  assert.equal((await f.exchange(app, requiredGrant, { code_verifier: '' })).status, 400);
  const exchangedRequiredGrant = await f.exchange(app, requiredGrant);
  assert.equal(exchangedRequiredGrant.status, 200, JSON.stringify(exchangedRequiredGrant.body));

  const optionalApp = await f.client({ requirePkce: false });
  const optionalGrant = await f.authorize(admin, optionalApp, 'openid', requiredGrant.cookie, { pkce: false });
  const requireUpdate = { name: optionalApp.name, redirectUris: optionalApp.redirectUris, scopes: optionalApp.scopes, requirePkce: true };
  assert.equal((await f.request(`/api/clients/${optionalApp.id}`, { method: 'PUT', cookie: requiredGrant.cookie, data: requireUpdate })).status, 200);
  assert.equal((await f.exchange(optionalApp, optionalGrant)).status, 200);
});

test('code exchange verifies redirect and PKCE, preserves nonce and publishes a real RSA key', async () => {
  const user = await f.user();
  const app = await f.client();
  const grant = await f.authorize(user, app);
  assert.equal((await f.exchange(app, grant, { redirect_uri: '' })).status, 400);
  assert.equal((await f.exchange(app, grant, { code_verifier: randomSecret() })).status, 400);
  const token = await f.exchange(app, grant);
  assert.equal(token.status, 200, JSON.stringify(token.body));
  assert.ok(!token.body.refresh_token);
  const jwks = await f.request('/.well-known/jwks.json');
  assert.equal(jwks.body.keys.length, 1);
  assert.ok(!jwks.body.keys[0].d);
  const key = crypto.createPublicKey({ key: jwks.body.keys[0], format: 'jwk' });
  const id = jwt.verify(token.body.id_token, key, { algorithms: ['RS256'], audience: app.id, issuer: process.env.PUBLIC_BASE_URL });
  assert.equal(id.nonce, grant.nonce);
  assert.equal(id.sub, user.id);
  assert.equal(id.email_verified, true);
  assert.notEqual(f.pool.accessTokens[0].token, token.body.access_token);
  const info = await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } });
  assert.equal(info.status, 200);
  assert.equal(info.body.email, user.email);
  assert.equal((await f.exchange(app, grant)).status, 400);
});

test('concurrent authorization-code exchange has only one winner', async () => {
  const user = await f.user();
  const app = await f.client();
  const grant = await f.authorize(user, app);
  const results = await Promise.all([f.exchange(app, grant), f.exchange(app, grant)]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 400]);
  assert.equal(f.pool.accessTokens.length, 1);
});

test('refresh tokens rotate once, enforce ownership and cannot expand scopes', async () => {
  const user = await f.user();
  const app = await f.client();
  const other = await f.client();
  const token = await f.exchange(app, await f.authorize(user, app, 'openid email offline_access'));
  assert.equal(token.status, 200, JSON.stringify(token.body));
  const refreshToken = token.body.refresh_token;
  assert.ok(refreshToken);
  assert.equal((await f.refresh(other, refreshToken)).status, 400);
  assert.equal((await f.refresh(app, refreshToken, { scope: 'openid profile' })).status, 400);
  const results = await Promise.all([f.refresh(app, refreshToken), f.refresh(app, refreshToken)]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 400]);
  const replacement = results.find(item => item.status === 200).body;
  assert.ok(replacement.refresh_token && replacement.refresh_token !== refreshToken);
  assert.equal((await f.refresh(app, refreshToken)).status, 400);
});

test('ID tokens and UserInfo disclose only the granted claims', async () => {
  const user = await f.user();
  const app = await f.client();
  const token = await f.exchange(app, await f.authorize(user, app, 'openid'));
  const id = jwt.decode(token.body.id_token);
  for (const claim of ['email', 'name', 'role', 'isAdmin']) assert.ok(!Object.hasOwn(id, claim));
  const info = await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } });
  assert.deepEqual(info.body, { sub: user.id });
  assert.equal((await f.request('/api/profile', { cookie: `session=${token.body.access_token}` })).status, 401);
  const noOpenid = await f.exchange(app, await f.authorize(user, app, 'email'));
  assert.ok(!noOpenid.body.id_token);
  assert.equal((await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${noOpenid.body.access_token}` } })).status, 403);
});

test('client credentials never fabricate a user or grant user identity scopes', async () => {
  const app = await f.client();
  const data = { grant_type: 'client_credentials', client_id: app.id, client_secret: app.clearSecret, scope: 'service.read' };
  const token = await f.request('/oauth2/token', { method: 'POST', data });
  assert.equal(token.status, 200);
  assert.equal(f.pool.users.length, 0);
  assert.equal(f.pool.accessTokens[0].user_id, null);
  assert.equal((await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } })).status, 401);
  assert.equal((await f.request('/oauth2/token', { method: 'POST', data: { ...data, scope: 'openid' } })).status, 400);
});

test('new client secrets are hashed, and malformed or duplicate authentication fails', async () => {
  const app = await f.client();
  assert.match(app.secret, /^scrypt\$/);
  const data = { grant_type: 'client_credentials', client_id: app.id, client_secret: app.clearSecret };
  assert.equal((await f.request('/oauth2/token', { method: 'POST', data, headers: { Authorization: 'Basic broken' } })).status, 401);
  assert.equal((await f.request('/oauth2/token', { method: 'POST', data: { ...data, client_secret: randomSecret() } })).status, 401);
  const basic = Buffer.from(`${app.id}:${app.clearSecret}`).toString('base64');
  assert.equal((await f.request('/oauth2/token', { method: 'POST', data: { grant_type: 'client_credentials' }, headers: { Authorization: `Basic ${basic}` } })).status, 200);
});

test('password reset revokes sessions, authorization codes and both token types', async () => {
  const user = await f.user();
  const app = await f.client();
  const grant = await f.authorize(user, app, 'openid offline_access');
  const token = await f.exchange(app, grant);
  await f.authorize(user, app, 'openid', grant.cookie);
  await f.request('/api/email-verification/send', { method: 'POST', data: { email: user.email, purpose: 'password_reset' } });
  const reset = await f.request('/api/password-reset', { method: 'POST', data: { email: user.email, email_code: f.lastCode(user.email), password: randomSecret() } });
  assert.equal(reset.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: grant.cookie })).status, 401);
  assert.equal((await f.refresh(app, token.body.refresh_token)).status, 400);
  assert.equal(f.pool.authCodes.length, 0);
  const info = await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } });
  assert.equal(info.status, 401);
});

test('IP header spoofing and alternate login names cannot bypass account throttling', async () => {
  const user = await f.user();
  for (let index = 0; index < 5; index++) {
    await f.request('/oauth2/authorize', { method: 'POST', headers: { 'X-Forwarded-For': `203.0.113.${index}` },
      data: { username: index % 2 ? user.email : user.username, password: randomSecret() } });
  }
  const locked = await f.request('/oauth2/authorize', { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.20' },
    data: { username: user.email, password: user.clearPassword } });
  assert.equal(locked.status, 429);
  assert.ok(f.pool.loginLogs.every(log => !log.ip.startsWith('203.0.113.')));
});

test('disabled proxy trust ignores forged forwarding headers in persisted login and session IPs', async () => {
  const user = await f.user();
  const login = await f.request('/oauth2/authorize', {
    method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.99', 'X-Real-IP': '203.0.113.20' },
    data: { username: user.username, password: user.clearPassword }
  });
  assert.equal(login.status, 200);
  assert.equal((await f.User.findById(user.id)).last_login_ip, '127.0.0.1');
  assert.equal(f.pool.sessions[0].ip_address, '127.0.0.1');
  assert.equal(f.pool.loginLogs.at(-1).ip, '127.0.0.1');
});

test('public callers cannot issue login or email-change codes', async () => {
  for (const purpose of ['login', 'email_change']) {
    const result = await f.request('/api/email-verification/send', { method: 'POST', data: { email: 'someone@example.test', purpose } });
    assert.equal(result.status, 400);
  }
  assert.equal(f.mails.length, 0);
});

test('verification codes have a bounded attempt count and only one concurrent consumer', async () => {
  const EmailCode = require('../models/EmailVerificationCode');
  const model = new EmailCode(f.pool);
  const record = await model.create({ email: 'test@example.test', purpose: 'register', codeHash: randomSecret(), expiresAt: new Date(Date.now() + 60000) });
  const attempts = await Promise.all(Array.from({ length: 12 }, () => model.incrementAttempts(record.id, 5)));
  assert.equal(attempts.filter(Boolean).length, 5);
  const consumed = await Promise.all([model.consume(record.id), model.consume(record.id)]);
  assert.equal(consumed.filter(Boolean).length, 1);
});

test('an enabled authenticator cannot be overwritten through the setup endpoint', async () => {
  const user = await f.user();
  const login = await f.login(user);
  await f.User.update(user.id, { totpSecret: 'JBSWY3DPEHPK3PXP', totpEnabled: true });
  const result = await f.request('/api/account/totp/setup', { method: 'POST', cookie: login.cookie });
  assert.equal(result.status, 409);
  assert.equal((await f.User.findById(user.id)).totp_secret, 'JBSWY3DPEHPK3PXP');
});

test('recovery codes are consumed atomically under concurrent login', async () => {
  const user = await f.user();
  const recovery = randomSecret().replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
  const hash = crypto.createHash('sha256').update(recovery).digest('hex');
  await f.User.update(user.id, { totpSecret: 'JBSWY3DPEHPK3PXP', totpEnabled: true, recoveryCodes: JSON.stringify([hash]) });
  const results = await Promise.all([f.login(user, { totp_code: recovery }), f.login(user, { totp_code: recovery })]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 400]);
  assert.equal(f.pool.sessions.length, 1);
});

test('database failures do not turn off configured authentication checks', async () => {
  const user = await f.user();
  const originalQuery = f.pool.query;
  f.pool.query = async () => { throw new Error('Unavailable'); };
  try { assert.equal((await f.login(user)).status, 500); }
  finally { f.pool.query = originalQuery; }
  assert.equal(f.pool.sessions.length, 0);
});

test('missing SMTP fails without exposing verification codes or pretending delivery', async () => {
  const email = require('../services/email');
  const originalPassword = process.env.SMTP_PASS;
  const originalHost = process.env.SMTP_HOST;
  email.applySmtpSettings({ host: '', password: '' });
  try {
    await assert.rejects(email.sendVerificationEmail({ to: 'test@example.test', code: randomSecret(), purpose: 'register', expiresInMinutes: 10 }), /SMTP is not configured/);
  } finally { email.applySmtpSettings({ host: originalHost, password: originalPassword }); }
});

test('CAPTCHA responses contain a bitmap, require the right answer and are single use', async () => {
  const user = await f.user();
  f.pool.settings.push({ setting_key: 'captcha_login', setting_value: 'true' });
  const challenge = await f.request('/api/captcha');
  const answer = f.captchaAnswers.at(-1);
  assert.match(challenge.body.image, /^data:image\/png;base64,/);
  assert.ok(!Object.hasOwn(challenge.body, 'svg') && !Object.hasOwn(challenge.body, 'text'));
  const bitmap = Buffer.from(challenge.body.image.split(',')[1], 'base64');
  assert.equal(bitmap.subarray(1, 4).toString(), 'PNG');
  const login = await f.login(user, { captcha_id: challenge.body.id, captcha_code: answer });
  assert.equal(login.status, 200);
  assert.equal((await f.login(user, { captcha_id: challenge.body.id, captcha_code: answer })).status, 400);
  const wrong = await f.request('/api/captcha');
  assert.equal((await f.login(user, { captcha_id: wrong.body.id, captcha_code: 'incorrect' })).status, 400);
  assert.equal(f.pool.captchas.length, 0);
});

test('TOTP setup encrypts the secret and an enrolled account remains protected when enrollment is disabled', async () => {
  const user = await f.user();
  const login = await f.login(user);
  const setup = await f.request('/api/account/totp/setup', { method: 'POST', cookie: login.cookie });
  assert.equal(setup.status, 200);
  const stored = await f.User.findById(user.id);
  assert.match(stored.totp_secret, /^enc:v1:/);
  assert.notEqual(stored.totp_secret, setup.body.secret);
  await f.User.update(user.id, { totpEnabled: true });
  f.pool.settings.push({ setting_key: 'totp_allowed', setting_value: 'false' });
  const nextLogin = await f.login(user);
  assert.equal(nextLogin.body.require_totp, true);
  assert.doesNotMatch(nextLogin.cookie, /(?:^|;\s*)session=[^;]+/);
});

test('a valid authenticator code cannot be replayed for a second login', async () => {
  const user = await f.user();
  // RFC 6238 SHA-1 reference secret. Compute a valid moving code independently of the service.
  await f.User.update(user.id, { totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', totpEnabled: true });
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from('12345678901234567890')).update(counter).digest();
  const offset = digest.at(-1) & 15;
  const code = String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
  assert.equal((await f.login(user, { totp_code: code })).status, 200);
  assert.equal((await f.login(user, { totp_code: code })).status, 400);
  assert.equal(f.pool.sessions.length, 1);
});

test('an invalid security settings batch cannot partially disable protections', async () => {
  const admin = await f.user('admin');
  const login = await f.login(admin);
  const invalid = await f.request('/api/admin/security', { method: 'PUT', cookie: login.cookie,
    data: { registrationEnabled: false, passwordMinLength: 1 } });
  assert.equal(invalid.status, 400);
  assert.equal(f.pool.settings.length, 0);
  const valid = await f.request('/api/admin/security', { method: 'PUT', cookie: login.cookie,
    data: { captchaLogin: true, registrationEnabled: false, passwordMinLength: 16 } });
  assert.equal(valid.status, 200);
  const config = await f.request('/api/auth/config');
  assert.equal(config.body.captchaLogin, true);
  assert.equal(config.body.registrationEnabled, false);
  assert.equal(config.body.passwordMinLength, 16);
});

test('email-change codes are tied to their requesting account', async () => {
  const owner = await f.user();
  const other = await f.user();
  const ownerLogin = await f.login(owner);
  const otherLogin = await f.login(other);
  const email = `${crypto.randomUUID()}@example.test`;
  const sent = await f.request('/api/profile', { method: 'PUT', cookie: ownerLogin.cookie, data: { email } });
  assert.equal(sent.body.require_email_code, true);
  const code = f.lastCode(email);
  const stolen = await f.request('/api/profile', { method: 'PUT', cookie: otherLogin.cookie, data: { email, email_code: code } });
  assert.equal(stolen.status, 400);
  const changed = await f.request('/api/profile', { method: 'PUT', cookie: ownerLogin.cookie, data: { email, email_code: code } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.emailVerified, true);
  assert.equal((await f.request('/api/profile', { cookie: ownerLogin.cookie })).status, 401);
});

test('client disable revokes credentials and modifying a disabled client does not re-enable it', async () => {
  const admin = await f.user('admin');
  const app = await f.client();
  const grant = await f.authorize(admin, app, 'openid offline_access');
  const token = await f.exchange(app, grant);
  const data = { name: app.name, redirectUris: app.redirectUris, scopes: app.scopes, isActive: false };
  assert.equal((await f.request(`/api/clients/${app.id}`, { method: 'PUT', cookie: grant.cookie, data })).status, 200);
  assert.equal(f.pool.accessTokens.length, 0);
  assert.equal(f.pool.refreshTokens.length, 0);
  delete data.isActive;
  assert.equal((await f.request(`/api/clients/${app.id}`, { method: 'PUT', cookie: grant.cookie, data })).status, 200);
  assert.equal((await f.Client.findById(app.id)).is_active, false);
  assert.equal((await f.refresh(app, token.body.refresh_token)).status, 403);
});
