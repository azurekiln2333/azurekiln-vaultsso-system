const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { createFixture, randomSecret } = require('./support/fixture');
const OidcProviderModel = require('../models/OidcProvider');
const ExternalIdentityModel = require('../models/ExternalIdentity');

let f, upstream, issuer;
let profiles = new Map();
let userinfoCalls = [];
let activeProfile;
const upstreamKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const upstreamJwk = { ...upstreamKeys.publicKey.export({ format: 'jwk' }), kid: 'isolated-provider', alg: 'RS256', use: 'sig' };
const upstreamClientId = randomSecret();
const upstreamSecret = randomSecret();

before(async () => {
  upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [upstreamJwk] }));
    if (req.url === '/userinfo') {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      userinfoCalls.push({ method: req.method, params: new URLSearchParams(body), authorization: req.headers.authorization });
      return res.end(JSON.stringify(activeProfile.userinfo));
    }
    if (req.url !== '/token') { res.statusCode = 404; return res.end('{}'); }
    let text = '';
    for await (const chunk of req) text += chunk.toString();
    const params = new URLSearchParams(text);
    const profile = profiles.get(params.get('code'));
    profiles.delete(params.get('code'));
    const expectedAuth = `Basic ${Buffer.from(`${upstreamClientId}:${upstreamSecret}`).toString('base64')}`;
    if (!profile || req.headers.authorization !== expectedAuth || !params.get('code_verifier')) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'invalid_grant' }));
    }
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
  userinfoCalls = [];
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

async function start(cookie, query = '') {
  const result = await f.request(`/api/v1/auth/oauth/oidc/login?provider=identity${query}`, { cookie });
  assert.equal(result.status, 302, JSON.stringify(result.body));
  return { ...result, params: new URL(result.headers.get('location')).searchParams, sessionCookie: cookie };
}

async function finish(started, { claims = {}, userinfo, rawIdToken, omit = [] } = {}) {
  const sub = `subject-${crypto.randomUUID()}`;
  const email = `${crypto.randomUUID()}@example.test`;
  const payload = {
    sub, email, email_verified: true, preferred_username: `external-${crypto.randomUUID()}`,
    iss: issuer, aud: upstreamClientId, nonce: started.params.get('nonce'),
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...claims
  };
  for (const claim of omit) delete payload[claim];
  const idToken = rawIdToken || jwt.sign(payload, upstreamKeys.privateKey, { algorithm: 'RS256', keyid: upstreamJwk.kid });
  const code = randomSecret();
  profiles.set(code, { idToken, userinfo: userinfo || { sub: payload.sub, email: payload.email, email_verified: payload.email_verified } });
  return f.request(`/api/v1/auth/oauth/oidc/callback?${new URLSearchParams({ state: started.params.get('state'), code })}`, {
    cookie: [started.cookie, started.sessionCookie].filter(Boolean).join('; ')
  });
}

function assertLoginRejected(result) {
  assert.equal(result.status, 302);
  assert.equal(new URL(result.headers.get('location'), process.env.PUBLIC_BASE_URL).searchParams.get('oidc_error'), 'login_failed');
  assert.doesNotMatch(result.cookie, /(?:^|;\s*)session=[^;]+/);
}

test('a valid signed external identity creates an ordinary account', async () => {
  const result = await finish(await start());
  assert.equal(result.status, 302);
  const profile = await f.request('/api/profile', { cookie: result.cookie });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.role, 'user');
  assert.equal(f.pool.userIdentities.length, 1);
});

test('fresh target login and a new OIDC code merge a disposable external account', async () => {
  const target = await f.user();
  const subject = `merge-${crypto.randomUUID()}`;
  const sourceLogin = await finish(await start(), { claims: { sub: subject, email_verified: false, preferred_username: 'merge-source' } });
  const sourceId = f.pool.userIdentities[0].user_id;
  assert.notEqual(sourceId, target.id);
  f.pool.userAppUsage.push({ user_id: sourceId, client_id: 'old-app', client_name: 'Old app',
    first_used_at: new Date('2026-01-01'), last_used_at: new Date('2026-02-01') });

  const targetLogin = await f.login(target);
  const started = await start(targetLogin.cookie, '&intent=merge&return_to=%2Fprofile');
  const merged = await finish(started, { claims: { sub: subject, email_verified: false, preferred_username: 'merge-source' } });
  assert.equal(merged.headers.get('location'), '/profile?account_merged=1');
  assert.equal(f.pool.users.some(row => row.id === sourceId), false);
  assert.equal(f.pool.userIdentities[0].user_id, target.id);
  assert.equal(f.pool.userAppUsage[0].user_id, target.id);
  assert.equal((await f.request('/api/profile', { cookie: targetLogin.cookie })).status, 200);
  assert.equal((await f.request('/api/profile', { cookie: sourceLogin.cookie })).status, 401);
});

test('OIDC merge keeps target email and retains provider-verified email on the moved identity', async () => {
  const target = await f.user();
  const subject = `merge-${crypto.randomUUID()}`;
  await finish(await start(), { claims: { sub: subject, preferred_username: 'verified-source' } });
  const sourceId = f.pool.userIdentities[0].user_id;
  const sourceEmail = f.pool.users.find(row => row.id === sourceId).email;
  const targetLogin = await f.login(target);
  const merged = await finish(await start(targetLogin.cookie, '&intent=merge'), { claims: { sub: subject } });
  assert.equal(merged.headers.get('location'), '/profile?account_merged=1');
  assert.equal(f.pool.users.some(row => row.id === sourceId), false);
  assert.equal(f.pool.users.find(row => row.id === target.id).email, target.email);
  assert.equal(f.pool.userIdentities[0].email, sourceEmail);
});

test('OIDC merge rejects a source with a locally changed email without deleting it', async () => {
  const target = await f.user();
  const subject = `merge-${crypto.randomUUID()}`;
  await finish(await start(), { claims: { sub: subject, preferred_username: 'verified-source' } });
  const sourceId = f.pool.userIdentities[0].user_id;
  await f.User.update(sourceId, { email: `changed-${crypto.randomUUID()}@example.test` });
  const targetLogin = await f.login(target);
  const merged = await finish(await start(targetLogin.cookie, '&intent=merge'), { claims: { sub: subject } });
  assertLoginRejected(merged);
  assert.ok(f.pool.users.some(row => row.id === sourceId));
  assert.equal(f.pool.userIdentities[0].user_id, sourceId);
});

test('OIDC merge rejects an identity created under a different issuer', async () => {
  const target = await f.user();
  const subject = `merge-${crypto.randomUUID()}`;
  await finish(await start(), { claims: { sub: subject } });
  const sourceId = f.pool.userIdentities[0].user_id;
  const profile = JSON.parse(f.pool.userIdentities[0].profile);
  profile._vaultsso.issuer = 'https://different-issuer.example.test';
  f.pool.userIdentities[0].profile = JSON.stringify(profile);
  const targetLogin = await f.login(target);
  const merged = await finish(await start(targetLogin.cookie, '&intent=merge'), { claims: { sub: subject } });
  assertLoginRejected(merged);
  assert.ok(f.pool.users.some(row => row.id === sourceId));
  assert.equal(f.pool.userIdentities[0].user_id, sourceId);
});

test('OIDC merge rejects an expired target proof and does not consume source data', async () => {
  const target = await f.user();
  const subject = `merge-${crypto.randomUUID()}`;
  await finish(await start(), { claims: { sub: subject, email_verified: false, preferred_username: 'merge-source' } });
  const sourceId = f.pool.userIdentities[0].user_id;
  const targetLogin = await f.login(target);
  const started = await start(targetLogin.cookie, '&intent=merge');
  f.pool.sessions.find(row => row.user_id === target.id).created_at = new Date(Date.now() - 6 * 60 * 1000);
  const merged = await finish(started, { claims: { sub: subject, email_verified: false } });
  assertLoginRejected(merged);
  assert.ok(f.pool.users.some(row => row.id === sourceId));
  assert.equal(f.pool.userIdentities[0].user_id, sourceId);
});

test('OIDC merge rolls back moved identity and app history if source deletion fails', async () => {
  const target = await f.user();
  const subject = `merge-${crypto.randomUUID()}`;
  await finish(await start(), { claims: { sub: subject, email_verified: false, preferred_username: 'merge-source' } });
  const sourceId = f.pool.userIdentities[0].user_id;
  f.pool.userAppUsage.push({ user_id: sourceId, client_id: 'source-app', client_name: 'Source app',
    first_used_at: new Date('2026-01-01'), last_used_at: new Date('2026-02-01') });
  const targetLogin = await f.login(target);
  const original = f.pool.getConnection.bind(f.pool);
  f.pool.getConnection = async () => {
    const connection = await original();
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql, params) => {
      if (sql === 'DELETE FROM users WHERE id = ?' && params[0] === sourceId) throw new Error('simulated delete failure');
      return execute(sql, params);
    };
    return connection;
  };
  try {
    const merged = await finish(await start(targetLogin.cookie, '&intent=merge'), { claims: { sub: subject, email_verified: false } });
    assertLoginRejected(merged);
  } finally {
    f.pool.getConnection = original;
  }
  assert.ok(f.pool.users.some(row => row.id === sourceId));
  assert.equal(f.pool.userIdentities[0].user_id, sourceId);
  assert.equal(f.pool.userAppUsage[0].user_id, sourceId);
  assert.equal((await f.request('/api/profile', { cookie: targetLogin.cookie })).status, 200);
});

test('OIDC rejects wrong state, nonce, issuer, audience, missing expiration and mismatched subjects', async () => {
  const initial = await start();
  assertLoginRejected(await f.request('/api/v1/auth/oauth/oidc/callback?state=wrong&code=invalid', { cookie: initial.cookie }));
  for (const options of [
    { claims: { nonce: randomSecret() } },
    { claims: { iss: 'https://untrusted.example.test' } },
    { claims: { aud: 'wrong-client' } },
    { omit: ['exp'] },
    { userinfo: { sub: 'different-subject' } },
    { claims: { aud: [upstreamClientId, 'another-client'] }, omit: ['azp'] }
  ]) assertLoginRejected(await finish(await start(), options));
  assert.equal(f.pool.users.length, 0);
  assert.equal(f.pool.sessions.length, 0);
});

test('a verified email claim cannot automatically link or take over an existing local account', async () => {
  const admin = await f.user('admin');
  const result = await finish(await start(), { claims: { email: admin.email, email_verified: true } });
  assertLoginRejected(result);
  assert.equal(f.pool.userIdentities.length, 0);
  assert.equal(f.pool.sessions.length, 0);
});

test('identity linking requires an explicit intent and the same live local session', async () => {
  const user = await f.user();
  const login = await f.login(user);
  assertLoginRejected(await finish(await start(login.cookie), { claims: { email: user.email } }));
  const binding = await start(login.cookie, '&intent=link&return_to=%2Fprofile');
  await f.request('/oauth2/logout', { cookie: login.cookie });
  assertLoginRejected(await finish(binding, { claims: { email: user.email } }));
  assert.equal(f.pool.userIdentities.length, 0);
  const freshLogin = await f.login(user);
  const linked = await finish(await start(freshLogin.cookie, '&intent=link&return_to=%2Fprofile'), { claims: { email: user.email } });
  assert.equal(linked.headers.get('location'), '/profile');
  assert.equal(f.pool.userIdentities[0].user_id, user.id);
});

test('UserInfo cannot borrow verified status from a different ID Token email', async () => {
  const sub = randomSecret();
  const result = await finish(await start(), {
    claims: { sub, email: 'verified@example.test', email_verified: true },
    userinfo: { sub, email: 'unverified@example.test', email_verified: false }
  });
  const profile = await f.request('/api/profile', { cookie: result.cookie });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.emailVerified, false);
  assert.ok(profile.body.user.email.endsWith('@users.invalid'));
});

test('external sign-in does not bypass local authenticator verification', async () => {
  const user = await f.user();
  const sub = randomSecret();
  const recovery = 'ABCD2345EFGH6789';
  await f.User.update(user.id, {
    totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP',
    recoveryCodes: JSON.stringify([crypto.createHash('sha256').update(recovery).digest('hex')])
  });
  await new ExternalIdentityModel(f.pool).create({ userId: user.id, provider: 'identity', providerUserId: sub });
  const callback = await finish(await start(), { claims: { sub, email: user.email } });
  assert.equal(callback.headers.get('location'), '/oauth2/mfa');
  assert.doesNotMatch(callback.cookie, /(?:^|;\s*)session=[^;]+/);
  assert.equal((await f.request('/api/profile', { cookie: callback.cookie })).status, 401);
  const pending = await f.request('/api/v1/auth/oauth/oidc/pending', { cookie: callback.cookie });
  assert.equal(pending.body.factor, 'totp');
  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: callback.cookie, data: { code: recovery } });
  assert.equal(completed.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: completed.cookie })).status, 200);
  assert.equal((await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: callback.cookie, data: { code: recovery } })).status, 401);
});

test('external sign-in also enforces the configured email second factor', async () => {
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  const callback = await finish(await start());
  assert.equal(callback.headers.get('location'), '/oauth2/mfa');
  const user = f.pool.users[0];
  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', cookie: callback.cookie, data: { code: f.lastCode(user.email) }
  });
  assert.equal(completed.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: completed.cookie })).status, 200);
});

test('disabling registration also blocks provisioning through external login', async () => {
  f.pool.settings.push({ setting_key: 'registration_enabled', setting_value: 'false' });
  assertLoginRejected(await finish(await start()));
  assert.equal(f.pool.users.length, 0);
});

test('deleted providers stay deleted despite environment variables, including unknown provider requests', async () => {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_CLIENT_ID = upstreamClientId;
  process.env.OIDC_CLIENT_SECRET = upstreamSecret;
  process.env.OIDC_ISSUER_URL = issuer;
  f.pool.oidcProviders.length = 0;
  const config = await f.request('/api/v1/auth/oauth/oidc/config');
  assert.equal(config.body.enabled, false);
  assert.deepEqual(config.body.providers, []);
  assert.equal((await f.request('/api/v1/auth/oauth/oidc/login?provider=unknown')).status, 503);
  assert.equal(f.pool.oidcProviders.length, 0);
});

test('OAuth-only providers use authenticated UserInfo and ignore unverified ID Tokens', async () => {
  f.pool.oidcProviders[0].validate_id_token = false;
  f.pool.oidcProviders[0].scopes = 'profile email';
  const result = await finish(await start(), {
    rawIdToken: 'untrusted.id.token',
    userinfo: { sub: randomSecret(), email: `${crypto.randomUUID()}@example.test`, email_verified: true }
  });
  assert.equal((await f.request('/api/profile', { cookie: result.cookie })).status, 200);
});

test('disabling the provider invalidates a pending external-login second factor', async () => {
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  const callback = await finish(await start());
  assert.equal(callback.headers.get('location'), '/oauth2/mfa');
  const user = f.pool.users[0];
  const code = f.lastCode(user.email);
  f.pool.oidcProviders[0].enabled = false;
  const result = await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: callback.cookie, data: { code } });
  assert.equal(result.status, 401);
  assert.equal(f.pool.sessions.length, 0);
});

test('an unreadable provider credential disables that login without blocking the administrator', async () => {
  const { createSecretCipher } = require('../services/secret-storage');
  f.pool.oidcProviders[0].client_secret = createSecretCipher(randomSecret(), 'oidc-provider-secret').encrypt(upstreamSecret);
  assert.equal((await f.request('/api/v1/auth/oauth/oidc/config')).body.enabled, false);
  const admin = await f.user('admin');
  const login = await f.login(admin);
  const settings = await f.request('/api/admin/oidc', { cookie: login.cookie });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.providers[0].credentialError, true);
});

test('自定义主标识与第二标识路径会同时落库，并可按主标识重复命中', async () => {
  const provider = f.pool.oidcProviders[0];
  provider.userinfo_id_path = 'unionID';
  provider.userinfo_secondary_id_path = 'openID';
  const unionID = `union-${crypto.randomUUID()}`;
  const openID = `open-${crypto.randomUUID()}`;

  const result = await finish(await start(), { userinfo: { unionID, openID } });
  assert.equal(result.status, 302);
  assert.equal(f.pool.userIdentities[0].provider_user_id, unionID);
  assert.equal(f.pool.userIdentities[0].provider_secondary_id, openID);

  // 主标识不变、第二标识变化（换应用）时仍归到同一账号
  const again = await finish(await start(), { userinfo: { unionID, openID: `open-${crypto.randomUUID()}` } });
  assert.equal(again.status, 302);
  assert.equal(f.pool.users.length, 1);
});

test('userinfo 请求方式可配置为 POST + body_form，以适配不接受 Bearer 头的提供方', async () => {
  const provider = f.pool.oidcProviders[0];
  provider.userinfo_method = 'POST';
  provider.userinfo_token_in = 'body_form';

  const result = await finish(await start());
  assert.equal(result.status, 302);
  assert.equal(userinfoCalls.length, 1);
  assert.equal(userinfoCalls[0].method, 'POST');
  assert.ok(userinfoCalls[0].params.get('access_token'));
  assert.equal(userinfoCalls[0].authorization, undefined);
});

test('默认的 userinfo 请求仍使用 GET 与 Bearer 头', async () => {
  const result = await finish(await start());
  assert.equal(result.status, 302);
  assert.equal(userinfoCalls.length, 1);
  assert.equal(userinfoCalls[0].method, 'GET');
  assert.match(userinfoCalls[0].authorization, /^Bearer /);
});
