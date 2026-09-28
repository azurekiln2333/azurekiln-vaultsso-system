const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { test, before, beforeEach, after } = require('node:test');
const { createFixture, randomSecret } = require('./support/fixture');
const OidcProviderModel = require('../models/OidcProvider');
const ClientModel = require('../models/Client');

let f;
let upstream;
let upstreamUrl;
let codes;
const huaweiClientId = randomSecret();
const huaweiClientSecret = randomSecret();
const identity = {
  openID: 'native-mfa-open', unionID: 'native-mfa-union',
  purePhoneNumber: '13800138000', phoneCountryCode: '0086', loginMobileValid: 'true'
};

before(async () => {
  upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const payload = codes.get(body.code);
    codes.delete(body.code);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body.clientId === huaweiClientId && body.clientSecret === huaweiClientSecret && payload
      ? payload : { resultCode: 60180005 }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}/oauth2/v6/quickLogin/getPhoneNumber`;
  f = await createFixture();
});

beforeEach(async () => {
  f.reset();
  codes = new Map();
  await new OidcProviderModel(f.pool).upsert({
    providerKey: 'huawei', providerName: 'Huawei', providerType: 'huawei_quicklogin',
    enabled: true, clientId: huaweiClientId, clientSecret: huaweiClientSecret,
    tokenUrl: upstreamUrl, scopes: ['openid'], validateIdToken: false, pkceEnabled: false
  });
});

after(async () => {
  if (f) await f.close();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
});

function stage() {
  const code = randomSecret();
  codes.set(code, identity);
  return code;
}

async function quickLogin(body) {
  let result = await f.request('/api/v1/auth/oauth/huawei/quick-login', {
    method: 'POST', data: { authorizationCode: stage(), ...body }
  });
  if (result.body.binding_required) {
    result = await f.request('/api/v1/auth/oauth/huawei/skip', {
      method: 'POST', data: { ...body, binding_token: result.body.binding_token }
    });
  }
  return result;
}

async function prepareAccount() {
  const first = await quickLogin({});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const recovery = 'ABCD2345EFGH6789';
  await f.User.update(first.body.user.id, {
    totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP',
    recoveryCodes: JSON.stringify([crypto.createHash('sha256').update(recovery).digest('hex')])
  });
  return recovery;
}

async function createClient(scopes) {
  const secret = randomSecret();
  const client = await new ClientModel(f.pool).create({
    id: `native-${crypto.randomUUID()}`, name: 'Native client', secret,
    redirectUris: ['https://native.example.test/callback'], scopes
  });
  return { ...client, clearSecret: secret };
}

test('Huawei MFA preserves native OAuth handoff and returns verified phone after factor', async () => {
  const recovery = await prepareAccount();
  const client = await createClient(['openid', 'profile', 'phone']);
  const verifier = randomSecret();
  const state = randomSecret();
  const pending = await quickLogin({
    client_id: client.id, redirect_uri: client.redirectUris[0], scope: 'openid profile phone', state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  });
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.equal(pending.body.mfa_required, true);
  assert.equal(pending.body.phone, undefined);
  assert.doesNotMatch(pending.cookie, /(?:^|;\s*)session=/);
  const stored = f.pool.emailVerificationCodes.find(row => row.id === JSON.parse(Buffer.from(pending.body.pending_token.split('.')[1], 'base64url').toString()).jti);
  assert.ok(stored);
  assert.doesNotMatch(JSON.stringify(stored.pending_context), /13800138000/);

  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', headers: { 'X-Oidc-Pending': pending.body.pending_token }, data: { code: recovery }
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.phone, '+8613800138000');
  assert.equal(completed.body.phoneStatus, 'verified');
  assert.equal(completed.body.state, state);
  assert.equal(completed.body.redirect_uri, client.redirectUris[0]);
  assert.ok(completed.body.authorization_code);
  assert.doesNotMatch(completed.cookie, /(?:^|;\s*)session=/);
  const exchanged = await f.exchange(client, { code: completed.body.authorization_code, verifier });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  const replay = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', headers: { 'X-Oidc-Pending': pending.body.pending_token }, data: { code: recovery }
  });
  assert.equal(replay.status, 401);
});

test('Huawei MFA native handoff hides phone without phone scope', async () => {
  const recovery = await prepareAccount();
  const client = await createClient(['openid', 'profile']);
  const verifier = randomSecret();
  const pending = await quickLogin({
    client_id: client.id, redirect_uri: client.redirectUris[0], scope: 'openid profile',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  });
  assert.equal(pending.body.mfa_required, true);
  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', headers: { 'X-Oidc-Pending': pending.body.pending_token }, data: { code: recovery }
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.phone, null);
  assert.equal(completed.body.phoneStatus, 'scope_not_granted');
  assert.equal(completed.body.user.phoneE164, '');
  assert.equal((await f.exchange(client, { code: completed.body.authorization_code, verifier })).status, 200);
});

test('Huawei MFA rejects invalid native OAuth parameters before issuing pending challenge', async () => {
  await prepareAccount();
  const result = await quickLogin({ client_id: 'unknown-client', redirect_uri: 'https://native.example.test/callback' });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_client');
  assert.equal(result.body.pending_token, undefined);
});

test('Huawei MFA without an OAuth client keeps browser session and redirect behavior', async () => {
  const recovery = await prepareAccount();
  const pending = await quickLogin({});
  assert.equal(pending.body.mfa_required, true);
  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', headers: { 'X-Oidc-Pending': pending.body.pending_token }, data: { code: recovery }
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.ok(completed.body.redirect);
  assert.equal(completed.body.phone, '+8613800138000');
  assert.match(completed.cookie, /(?:^|;\s*)session=/);
  assert.equal((await f.request('/api/profile', { cookie: completed.cookie })).status, 200);
});
