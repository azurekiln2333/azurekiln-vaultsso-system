const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { createFixture, randomSecret } = require('./support/fixture');
const OidcProviderModel = require('../models/OidcProvider');
const EmailVerificationCodeModel = require('../models/EmailVerificationCode');
const { isQfliClient } = require('../services/qfli-integration');

let f, upstream, issuer;
let profiles = new Map();
let activeProfile;
const upstreamKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const upstreamJwk = { ...upstreamKeys.publicKey.export({ format: 'jwk' }), kid: 'qfli-policy-provider', alg: 'RS256', use: 'sig' };
const upstreamClientId = randomSecret();
const upstreamSecret = randomSecret();

const QFLI_CLIENT_ID = 'qfli-studio-gateway-client';
const OTHER_CLIENT_ID = 'unrelated-partner-app';

before(async () => {
  upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [upstreamJwk] }));
    if (req.url === '/userinfo') {
      for await (const chunk of req) void chunk;
      return res.end(JSON.stringify(activeProfile.userinfo));
    }
    if (req.url !== '/token') { res.statusCode = 404; return res.end('{}'); }
    let text = '';
    for await (const chunk of req) text += chunk.toString();
    const params = new URLSearchParams(text);
    const profile = profiles.get(params.get('code'));
    profiles.delete(params.get('code'));
    if (!profile) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })); }
    activeProfile = profile;
    res.end(JSON.stringify({ access_token: randomSecret(), id_token: profile.idToken }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${upstream.address().port}`;
  f = await createFixture();
});

beforeEach(async () => {
  f.reset();
  profiles = new Map();
  await new OidcProviderModel(f.pool).upsert({
    providerKey: 'identity', providerName: 'Isolated identity provider', clientId: upstreamClientId, clientSecret: upstreamSecret,
    issuerUrl: issuer, authorizeUrl: `${issuer}/authorize`, tokenUrl: `${issuer}/token`,
    userinfoUrl: `${issuer}/userinfo`, jwksUrl: `${issuer}/jwks`, scopes: ['openid', 'profile', 'email'],
    allowedAlgorithms: ['RS256'], validateIdToken: true, pkceEnabled: true, requireEmailVerified: false,
    frontendCallbackPath: '/profile'
  });
});

after(async () => {
  if (f) await f.close();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
});

async function createClient(id, scopes) {
  const secret = randomSecret();
  const record = await f.Client.create({
    id, name: 'Isolated client', secret,
    redirectUris: ['https://client.example.test/callback'],
    scopes: scopes || ['openid', 'profile', 'email', 'offline_access', 'service.read']
  });
  return { ...record, clearSecret: secret };
}

function registerBody(email, extra = {}) {
  return {
    email, password: randomSecret(), email_code: '123456',
    ...extra
  };
}

function oauthRegistrationFields(clientId) {
  return {
    client_id: clientId, redirect_uri: 'https://client.example.test/callback', response_type: 'code', scope: 'openid',
    nonce: randomSecret(), state: randomSecret(), code_challenge: randomSecret(), code_challenge_method: 'S256'
  };
}

async function seedRegistrationCode(email) {
  // Registration proof is minted directly so the policy test never depends on mail delivery.
  return new EmailVerificationCodeModel(f.pool).create({
    email, purpose: 'register', codeHash: randomSecret(), expiresAt: new Date(Date.now() + 600000)
  });
}

test('isQfliClient matches only qfli-prefixed identifiers case-insensitively', () => {
  for (const value of ['qfli', 'QFLI', 'qfli-studio', 'QfliStudio+', '  qfli-app  ']) {
    assert.equal(isQfliClient(value), true, value);
    assert.equal(isQfliClient({ id: value }), true, value);
  }
  for (const value of ['', '   ', 'other-app', 'app-qfli', 'qf', 'qfl', null, undefined, 42, {}, { id: '' }]) {
    assert.equal(isQfliClient(value), false, String(value));
  }
  assert.equal(isQfliClient({ id: 'qfli-app' }), true);
  assert.equal(isQfliClient({ clientId: 'qfli-app' }), false, 'only id/client_id strings are authoritative');
});

test('QFLI email verification codes cannot be requested, while other clients and anonymous keep working', async () => {
  const qfli = await createClient(QFLI_CLIENT_ID);
  const email = `qfli-${crypto.randomUUID()}@example.test`;

  const rejected = await f.request('/api/email-verification/send', {
    method: 'POST', data: { email, purpose: 'register', client_id: qfli.id }
  });
  assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
  assert.equal(rejected.body.error, 'forbidden');
  assert.equal(rejected.body.error_key, 'auth.registration.oauth_only');
  assert.match(rejected.body.error_description, /华为账号/);
  assert.equal(f.mails.length, 0, 'no mail may be sent for a rejected QFLI registration code');
  assert.equal(f.pool.emailVerificationCodes.length, 0, 'no code row may be created');

  // Upper-case identifiers and Basic client authentication take the same path.
  assert.equal((await f.request('/api/email-verification/send', {
    method: 'POST', data: { email, purpose: 'register', client_id: QFLI_CLIENT_ID.toUpperCase() }
  })).status, 403);
  assert.equal((await f.request('/api/email-verification/send', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${qfli.id}:${qfli.clearSecret}`).toString('base64')}` },
    data: { email, purpose: 'register' }
  })).status, 403);
  assert.equal(f.mails.length, 0);

  // Password reset (an existing-account flow) is not a new-account path and stays available.
  const owner = await f.User.create({
    username: `owner-${crypto.randomUUID()}`, email, password: randomSecret(), emailVerified: true
  });
  const reset = await f.request('/api/email-verification/send', {
    method: 'POST', data: { email: owner.email, purpose: 'password_reset', client_id: qfli.id }
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(f.mails.length, 1);

  // Other clients keep the unchanged behavior, including the existing duplicate-email check.
  const otherEmail = `other-${crypto.randomUUID()}@example.test`;
  const allowed = await f.request('/api/email-verification/send', {
    method: 'POST', data: { email: otherEmail, purpose: 'register', client_id: OTHER_CLIENT_ID }
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(f.mails.length, 2);
  const duplicate = await f.request('/api/email-verification/send', {
    method: 'POST', data: { email: owner.email, purpose: 'register', client_id: OTHER_CLIENT_ID }
  });
  assert.equal(duplicate.status, 409);

  // No client context at all behaves exactly as before.
  const anonymousEmail = `anon-${crypto.randomUUID()}@example.test`;
  assert.equal((await f.request('/api/email-verification/send', {
    method: 'POST', data: { email: anonymousEmail, purpose: 'register' }
  })).status, 200);
  assert.equal(f.mails.length, 3);
});

test('QFLI registration is refused before CAPTCHA or email proof is consumed', async () => {
  const qfli = await createClient(QFLI_CLIENT_ID);
  f.pool.settings.push({ setting_key: 'captcha_register', setting_value: 'true' });
  const email = `qfli-${crypto.randomUUID()}@example.test`;
  await seedRegistrationCode(email);
  const proof = f.pool.emailVerificationCodes[0];

  for (const client_id of [qfli.id, QFLI_CLIENT_ID.toUpperCase()]) {
    const registered = await f.request('/oauth2/register', { method: 'POST', data: registerBody(email, { client_id }) });
    const rejected = await f.request('/oauth2/register', { method: 'POST', data: registerBody(email, { client_id }) });
    assert.equal(rejected.status, 403, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error, 'forbidden');
    assert.equal(rejected.body.error_key, 'auth.registration.oauth_only');
    assert.equal(rejected.cookie, '', 'a refused registration must not issue a session');
    for (const table of ['users', 'sessions', 'authCodes', 'accessTokens', 'refreshTokens', 'loginLogs']) {
      assert.equal(f.pool[table].length, 0, `${table} must stay empty`);
    }
  }

  // The CAPTCHA was never consumed and the proof was never attempted.
  assert.equal(f.captchaAnswers.length, 0);
  assert.equal(proof.attempts, 0);
  assert.equal(proof.consumed_at, null);

  // Basic client authentication is treated identically.
  const viaBasic = await f.request('/oauth2/register', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${qfli.id}:${qfli.clearSecret}`).toString('base64')}` },
    data: registerBody(email)
  });
  assert.equal(viaBasic.status, 403);
  assert.equal(proof.attempts, 0);
});

test('registration for other clients and without client_id is unchanged', async () => {
  for (const clientId of [undefined, 'anonymous']) {
    f.reset();
    const email = `other-${crypto.randomUUID()}@example.test`;
    if (clientId) await createClient(OTHER_CLIENT_ID);
    const context = clientId ? oauthRegistrationFields(OTHER_CLIENT_ID) : {};
    assert.equal((await f.request('/api/email-verification/send', {
      method: 'POST', data: { email, purpose: 'register', ...(clientId ? { client_id: OTHER_CLIENT_ID } : {}) }
    })).status, 200);
    const registered = await f.request('/oauth2/register', {
      method: 'POST', data: registerBody(email, { email_code: f.lastCode(email), ...context })
    });
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    assert.equal(f.pool.users.length, 1);
  }
});

test('auth config hides registration for QFLI clients only', async () => {
  const qfli = await createClient(QFLI_CLIENT_ID);
  const admin = await f.user('admin');
  const adminLogin = await f.login(admin);
  assert.equal((await f.request('/api/admin/security', {
    method: 'PUT', cookie: adminLogin.cookie, data: { registrationEnabled: true }
  })).status, 200);

  const qfliConfig = await f.request(`/api/auth/config?surface=web&client_id=${encodeURIComponent(qfli.id)}`);
  assert.equal(qfliConfig.status, 200);
  assert.equal(qfliConfig.body.registrationEnabled, false);
  assert.equal(qfliConfig.body.registrationDisabledReason, 'oauth_only');
  assert.equal(qfliConfig.body.captchaRegister, false, 'other settings are untouched');

  const upperConfig = await f.request(`/api/auth/config?client_id=${encodeURIComponent(QFLI_CLIENT_ID.toUpperCase())}`);
  assert.equal(upperConfig.body.registrationEnabled, false);
  assert.equal(upperConfig.body.registrationDisabledReason, 'oauth_only');

  // A client record whose id carries the prefix is also matched, even if the request string differs.
  const prefixed = await createClient(`qfli-${crypto.randomUUID()}`);
  assert.equal((await f.request(`/api/auth/config?client_id=${encodeURIComponent(prefixed.id)}`))
    .body.registrationDisabledReason, 'oauth_only');

  const other = await f.request(`/api/auth/config?client_id=${encodeURIComponent(OTHER_CLIENT_ID)}`);
  assert.equal(other.body.registrationEnabled, true);
  assert.equal(other.body.registrationDisabledReason, '');
  const anonymous = await f.request('/api/auth/config?surface=web');
  assert.equal(anonymous.body.registrationEnabled, true);
  assert.equal(anonymous.body.registrationDisabledReason, '');

  // The administrator's global switch is still authoritative and never leaked as QFLI-only.
  assert.equal((await f.request('/api/admin/security', {
    method: 'PUT', cookie: adminLogin.cookie, data: { registrationEnabled: false }
  })).status, 200);
  const disabledConfig = await f.request('/api/auth/config');
  assert.equal(disabledConfig.body.registrationEnabled, false);
  assert.equal(disabledConfig.body.registrationDisabledReason, '');
});

async function startOidc(query = '') {
  const started = await f.request(`/api/v1/auth/oauth/oidc/login?provider=identity${query}`);
  assert.equal(started.status, 302, JSON.stringify(started.body));
  return { ...started, params: new URL(started.headers.get('location')).searchParams };
}

async function finishOidc(started) {
  const sub = `subject-${crypto.randomUUID()}`;
  const email = `${crypto.randomUUID()}@example.test`;
  const payload = {
    sub, email, email_verified: true, preferred_username: `external-${crypto.randomUUID()}`,
    iss: issuer, aud: upstreamClientId, nonce: started.params.get('nonce'),
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300
  };
  const idToken = jwt.sign(payload, upstreamKeys.privateKey, { algorithm: 'RS256', keyid: upstreamJwk.kid });
  const code = randomSecret();
  profiles.set(code, { idToken, userinfo: { sub: payload.sub, email: payload.email, email_verified: true } });
  return f.request(`/api/v1/auth/oauth/oidc/callback?${new URLSearchParams({ state: started.params.get('state'), code })}`, {
    cookie: started.cookie
  });
}

test('QFLI OIDC email signups cannot create accounts while other clients still can', async () => {
  const qfli = await createClient(QFLI_CLIENT_ID);
  const rejected = await finishOidc(await startOidc(`&client_id=${encodeURIComponent(qfli.id)}`));
  assert.equal(rejected.status, 302);
  assert.equal(new URL(rejected.headers.get('location'), process.env.PUBLIC_BASE_URL).searchParams.get('oidc_error'), 'login_failed');
  assert.equal(f.pool.users.length, 0, 'no account may be created for a QFLI OIDC signup');
  assert.equal(f.pool.userIdentities.length, 0);
  assert.equal(f.pool.sessions.length, 0);

  await createClient(OTHER_CLIENT_ID);
  const other = await finishOidc(await startOidc(`&client_id=${encodeURIComponent(OTHER_CLIENT_ID)}`));
  assert.equal(other.headers.get('location'), '/profile');
  assert.equal(f.pool.users.length, 1);

  f.pool.users.length = 0;
  f.pool.userIdentities.length = 0;
  f.pool.sessions.length = 0;
  const anonymous = await finishOidc(await startOidc());
  assert.equal(anonymous.headers.get('location'), '/profile');
  assert.equal(f.pool.users.length, 1);
});
