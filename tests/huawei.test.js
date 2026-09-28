const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createFixture, randomSecret } = require('./support/fixture');
const OidcProviderModel = require('../models/OidcProvider');
const ClientModel = require('../models/Client');
const huawei = require('../services/huawei');

let f, upstream, huaweiEndpoint;
let codes = new Map();
let upstreamCalls = [];
const clientId = randomSecret();
const clientSecret = randomSecret();
let acceptedClientIds = new Set([clientId]);

before(async () => {
  upstream = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    let text = '';
    for await (const chunk of req) text += chunk.toString();
    let params;
    try { params = JSON.parse(text); } catch { params = {}; }
    upstreamCalls.push({ url: req.url, method: req.method, params, contentType: req.headers['content-type'], authorization: req.headers.authorization });
    // 用官方 POST + JSON 协议校验，不让旧 OAuth 表单通过测试。
    if (req.method !== 'POST' || req.headers['content-type'] !== 'application/json'
        || !acceptedClientIds.has(params.clientId) || params.clientSecret !== clientSecret) {
      return res.end(JSON.stringify({ resultCode: 60010013, resultDesc: 'private upstream credential error' }));
    }
    const entry = codes.get(params.code);
    codes.delete(params.code);
    if (!entry) {
      return res.end(JSON.stringify({ resultCode: 60180005, resultDesc: 'private upstream code error' }));
    }
    res.statusCode = entry.status;
    res.setHeader('Content-Type', entry.contentType);
    res.end(typeof entry.payload === 'string' ? entry.payload : JSON.stringify(entry.payload));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  huaweiEndpoint = `http://127.0.0.1:${upstream.address().port}/oauth2/v6/quickLogin/getPhoneNumber`;
  f = await createFixture();
});

beforeEach(async () => {
  f.reset();
  codes = new Map();
  upstreamCalls = [];
  acceptedClientIds = new Set([clientId]);
  await new OidcProviderModel(f.pool).upsert({
    providerKey: 'huawei', providerName: '华为账号', providerType: 'huawei_quicklogin',
    enabled: true, clientId, clientSecret, tokenUrl: huaweiEndpoint,
    scopes: ['openid'], validateIdToken: false, pkceEnabled: false
  });
});

after(async () => {
  if (f) await f.close();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
});

function stage(payload, { status = 200, contentType = 'application/json' } = {}) {
  const code = randomSecret();
  codes.set(code, { payload, status, contentType });
  return code;
}

async function createClient(scopes) {
  const secret = randomSecret();
  const record = await new ClientModel(f.pool).create({
    id: `client-${crypto.randomUUID()}`, name: 'Native app', secret,
    redirectUris: ['https://app.example.test/callback'], scopes
  });
  return { ...record, clearSecret: secret };
}

// 原生 App 不发送 Origin / Referer / Sec-Fetch-*，因此默认不带这些头。
async function huaweiRequest(path, body, headers = {}) {
  const response = await fetch(`${f.baseUrl}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return {
    status: response.status,
    body: parsed,
    headers: response.headers,
    cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  };
}

async function quickLoginRaw(body, headers = {}) {
  return huaweiRequest('/api/v1/auth/oauth/huawei/quick-login', body, headers);
}

async function quickLogin(body, headers = {}) {
  const result = await quickLoginRaw(body, headers);
  if (result.body?.binding_required !== true) return result;
  return huaweiRequest('/api/v1/auth/oauth/huawei/skip', {
    ...body, code: undefined, binding_token: result.body.binding_token
  }, headers);
}

function huaweiPayload(overrides = {}) {
  return {
    openID: `open-${crypto.randomUUID()}`,
    unionID: `union-${crypto.randomUUID()}`,
    purePhoneNumber: '13800138000',
    phoneCountryCode: '0086',
    loginMobileValid: 'true',
    displayName: '华为用户',
    ...overrides
  };
}

test('一键登录用官方 POST + JSON 换取标识，并把 0086 区号归一化为 E.164', async () => {
  const payload = huaweiPayload();
  const result = await quickLogin({ code: stage(payload) });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.phoneE164, '+8613800138000');
  assert.equal(result.body.phone, '+8613800138000');
  assert.equal(result.body.phoneStatus, 'verified');
  assert.equal(result.body.phoneBinding, 'bound');
  assert.equal(result.body.user.phoneMasked, '+86 138****8000');
  assert.equal(result.body.user.phoneVerified, true);
  // 华为的 00 形态区号不能原样落库
  assert.equal(f.pool.users[0].phone_country_code, '86');
  assert.equal(f.pool.users[0].phone_number, '13800138000');
  assert.equal(f.pool.users[0].phone_e164, '+8613800138000');

  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].method, 'POST');
  assert.equal(upstreamCalls[0].contentType, 'application/json');
  assert.equal(upstreamCalls[0].authorization, undefined);
  assert.deepEqual(Object.keys(upstreamCalls[0].params).sort(), ['clientId', 'clientSecret', 'code']);
  assert.equal(huawei.HUAWEI_QUICK_LOGIN_URL, 'https://account-api.cloud.huawei.com/oauth2/v6/quickLogin/getPhoneNumber');
});

test('native authorizationCode returns the verified full phone; conflicting code fields fail', async () => {
  const result = await quickLogin({ authorizationCode: stage({
    openId: 'client-app-open', unionId: 'client-subject-union',
    phoneNumber: '008613800138000', purePhoneNumber: '13800138000',
    phoneCountryCode: '0086', phoneNumberValid: 1
  }) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.phone, '+8613800138000');
  assert.equal(result.body.user.phoneE164, result.body.phone);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(Object.hasOwn(upstreamCalls[0].params, 'authorizationCode'), false);

  const mismatch = await quickLoginRaw({ authorizationCode: stage(huaweiPayload()), code: 'different' });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error, 'invalid_request');
  assert.equal(upstreamCalls.length, 1);
});

test('a conflicting Huawei phone is returned separately from the stored account phone', async () => {
  const first = await quickLogin({ code: stage(huaweiPayload({
    unionID: 'same-huawei-person', openID: 'same-app-open'
  })) });
  assert.equal(first.status, 200);
  const second = await quickLogin({ authorizationCode: stage(huaweiPayload({
    unionID: 'same-huawei-person', openID: 'same-app-open',
    purePhoneNumber: '13900139000', phoneNumber: '008613900139000'
  })) });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.user.id, first.body.user.id);
  assert.equal(second.body.user.phoneE164, '+8613800138000');
  assert.equal(second.body.phone, '+8613900139000');
  assert.equal(second.body.phoneStatus, 'conflict');
  assert.equal(second.body.phoneBinding, 'conflict');
});

test('官方 openId/unionId/phoneNumber 字段匹配已验证手机号并自动绑定', async () => {
  const existing = await f.User.create({
    username: `official-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`,
    password: randomSecret(), phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true
  });
  f.pool.settings.push({ setting_key: 'huawei_phone_autolink', setting_value: 'true' });
  const result = await quickLogin({ code: stage({
    openId: 'official-app-open', unionId: 'official-subject-union',
    phoneNumber: '008613800138000', phoneCountryCode: '0086', phoneNumberValid: 1
  }) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.id, existing.id);
  assert.equal(result.body.user.phoneE164, '+8613800138000');
  assert.equal(f.pool.users.length, 1);
  assert.equal(f.pool.userIdentities[0].provider_user_id, 'official-subject-union');
  assert.equal(f.pool.userIdentities[0].provider_secondary_id, 'official-app-open');
});

test('官方 phoneNumberValid=0 不自动关联已有账号', async () => {
  const existing = await f.User.create({
    username: `unverified-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`,
    password: randomSecret(), phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true
  });
  f.pool.settings.push({ setting_key: 'huawei_phone_autolink', setting_value: 'true' });
  const result = await quickLogin({ code: stage({
    openId: 'unverified-open', unionId: 'unverified-union',
    purePhoneNumber: '13800138000', phoneCountryCode: '0086', phoneNumberValid: 0
  }) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.notEqual(result.body.user.id, existing.id);
  assert.equal(result.body.phone, null);
  assert.equal(result.body.phoneStatus, 'unverified');
  assert.equal(result.body.user.phoneE164, '');
  assert.equal(f.pool.userIdentities[0].user_id, result.body.user.id);
});

test('HTTP 200 中的华为业务错误不会建立账号且不泄露原始报文', async () => {
  for (const [resultCode, expectedStatus, expectedError] of [
    [60010012, 400, 'invalid_grant'], [60180004, 400, 'invalid_grant'],
    [60180005, 400, 'invalid_grant'], [60180006, 400, 'invalid_grant'],
    [60010013, 503, 'huawei_not_configured'], [60180003, 503, 'huawei_not_configured'],
    [60180007, 403, 'huawei_permission_required'], [60180008, 400, 'huawei_phone_unavailable'],
    [60010001, 502, 'huawei_upstream_error']
  ]) {
    const result = await quickLogin({ code: stage({ resultCode, resultDesc: clientSecret }) });
    assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
    assert.equal(result.body.error, expectedError);
    assert.equal(f.pool.users.length, 0);
    assert.equal(JSON.stringify(result.body).includes(clientSecret), false);
  }
});

test('HTML 404 提示服务地址错误，不提示授权码过期', async () => {
  const result = await quickLogin({ code: stage('<html>Not found</html>', { status: 404, contentType: 'text/html' }) });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'huawei_upstream_error');
  assert.match(result.body.error_description, /服务地址无效/);
  assert.doesNotMatch(result.body.error_description, /授权码|过期/);
  assert.equal(f.pool.users.length, 0);
});

test('已保存的旧默认域名纠正为官方域名，并继续发送 JSON', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl;
  let calledBody;
  globalThis.fetch = async (url, options) => {
    calledUrl = url;
    calledBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ openId: 'mapped-open', unionId: 'mapped-union' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const identity = await huawei.exchangeQuickLoginCode({ clientId, clientSecret }, 'fresh-code',
      'https://oauth-login.cloud.huawei.com/oauth2/v6/quickLogin/getPhoneNumber');
    assert.equal(calledUrl, huawei.HUAWEI_QUICK_LOGIN_URL);
    assert.deepEqual(calledBody, { clientId, clientSecret, code: 'fresh-code' });
    assert.equal(identity.unionId, 'mapped-union');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('UnionID 作为主标识，OpenID 可兜底但不能改变已知 UnionID', async () => {
  const unionID = `union-${crypto.randomUUID()}`;
  const openID = `open-${crypto.randomUUID()}`;
  const first = await quickLogin({ code: stage(huaweiPayload({ unionID, openID })) });
  assert.equal(first.status, 200);
  assert.equal(f.pool.users.length, 1);
  assert.equal(f.pool.userIdentities[0].provider_user_id, unionID);
  assert.equal(f.pool.userIdentities[0].provider_secondary_id, openID);

  // 同一 unionID、不同 openID（换应用）：仍命中同一账号，且不覆盖已存的 openID
  const second = await quickLogin({ code: stage(huaweiPayload({ unionID, openID: `open-${crypto.randomUUID()}` })) });
  assert.equal(second.status, 200);
  assert.equal(second.body.user.id, first.body.user.id);
  assert.equal(f.pool.users.length, 1);
  assert.equal(f.pool.userIdentities[0].provider_secondary_id, openID);

  // A known OpenID must not silently change its trusted subject identifier.
  const third = await quickLogin({ code: stage(huaweiPayload({ unionID: `union-${crypto.randomUUID()}`, openID })) });
  assert.equal(third.status, 400);
  assert.match(third.body.error_description, /UnionID/);
  assert.equal(JSON.parse(f.pool.userIdentities[0].profile).unionID, unionID);
  assert.equal(f.pool.users.length, 1);
});

test('默认按华为已验证手机号匹配已验证的已有账号', async () => {
  const existing = await f.User.create({
    username: `local-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`,
    password: randomSecret(), phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true
  });
  const result = await quickLogin({ code: stage(huaweiPayload()) });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.id, existing.id);
  assert.equal(f.pool.users.length, 1);
});

test('未获得手机号时先等待绑定，只有跳过才创建新账号，待绑定凭据不可重放', async () => {
  const pending = await quickLoginRaw({ code: stage(huaweiPayload({ purePhoneNumber: '', phoneNumber: '' })) });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.binding_required, true);
  assert.equal(pending.body.phone_available, false);
  assert.equal(f.pool.users.length, 0);
  const skipped = await huaweiRequest('/api/v1/auth/oauth/huawei/skip', { binding_token: pending.body.binding_token });
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.equal(f.pool.users.length, 1);
  const replay = await huaweiRequest('/api/v1/auth/oauth/huawei/skip', { binding_token: pending.body.binding_token });
  assert.equal(replay.status, 400);
  assert.equal(f.pool.users.length, 1);
});

test('过期的华为待绑定凭据不能创建账号', async () => {
  const pending = await quickLoginRaw({ code: stage(huaweiPayload({ purePhoneNumber: '' })) });
  assert.equal(pending.body.binding_required, true);
  const now = Date.now;
  const issuedAt = now();
  try {
    Date.now = () => issuedAt + 5 * 60 * 1000 + 1;
    const expired = await huaweiRequest('/api/v1/auth/oauth/huawei/skip', { binding_token: pending.body.binding_token });
    assert.equal(expired.status, 400);
    assert.equal(f.pool.users.length, 0);
  } finally {
    Date.now = now;
  }
});

test('待绑定华为身份只能绑定已验证登录的账号', async () => {
  const app = await createClient(['openid', 'profile', 'email', 'phone', 'offline_access']);
  const password = randomSecret();
  const existing = await f.User.create({
    username: `bind-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`, password
  });
  const pending = await quickLoginRaw({ code: stage(huaweiPayload({ purePhoneNumber: '' })), client_id: app.id });
  assert.equal(pending.body.binding_required, true);
  assert.equal(f.pool.users.length, 1);
  const unauthorized = await huaweiRequest('/api/v1/auth/oauth/huawei/bind', { binding_token: pending.body.binding_token });
  assert.equal(unauthorized.status, 401);
  const verifier = randomSecret();
  const authorized = await f.request('/oauth2/authorize', {
    method: 'POST', data: {
      username: existing.username, password, client_id: app.id,
      redirect_uri: app.redirectUris[0], response_type: 'code', scope: 'openid profile',
      state: randomSecret(), code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256'
    }
  });
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
  const code = new URL(authorized.body.redirect).searchParams.get('code');
  const exchanged = await f.exchange(app, { code, verifier });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  const bound = await huaweiRequest('/api/v1/auth/oauth/huawei/bind', { binding_token: pending.body.binding_token }, {
    Authorization: `Bearer ${exchanged.body.access_token}`
  });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  assert.equal(f.pool.userIdentities[0].user_id, existing.id);
  assert.equal(f.pool.users.length, 1);
  const replay = await huaweiRequest('/api/v1/auth/oauth/huawei/bind', { binding_token: pending.body.binding_token }, {
    Authorization: `Bearer ${exchanged.body.access_token}`
  });
  assert.equal(replay.status, 400);
});

test('开启手机号关联后，验证过的号码会绑定到已有账号', async () => {
  const existing = await f.User.create({
    username: `local-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`,
    password: randomSecret(), phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true
  });
  f.pool.settings.push({ setting_key: 'huawei_phone_autolink', setting_value: 'true' });

  const result = await quickLogin({ code: stage(huaweiPayload()) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.id, existing.id);
  assert.equal(f.pool.users.length, 1);
  assert.equal(f.pool.userIdentities[0].user_id, existing.id);
  assert.match(f.pool.loginLogs[0].detail, /phone:unchanged|phone:verified/);
});

test('本地号码未验证时不做关联', async () => {
  const existing = await f.User.create({
    username: `local-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`,
    password: randomSecret(), phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: false
  });
  f.pool.settings.push({ setting_key: 'huawei_phone_autolink', setting_value: 'true' });

  const result = await quickLogin({ code: stage(huaweiPayload()) });
  assert.equal(result.status, 200);
  assert.notEqual(result.body.user.id, existing.id);
  assert.equal(f.pool.users.length, 2);
});

test('本地号码与华为号码冲突时保留本地号码，不静默换号', async () => {
  const existing = await f.User.create({
    username: `local-${crypto.randomUUID()}`, email: `${crypto.randomUUID()}@example.test`,
    password: randomSecret(), phoneCountryCode: '86', phoneNumber: '13900139000', phoneVerified: true
  });
  f.pool.settings.push({ setting_key: 'huawei_phone_autolink', setting_value: 'true' });

  const unionID = `union-${crypto.randomUUID()}`;
  const first = await quickLogin({ code: stage(huaweiPayload({ unionID })) });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.user.id, existing.id);

  const stored = f.pool.users.find(row => row.id === first.body.user.id);
  assert.equal(stored.phone_number, '13800138000');
  const local = f.pool.users.find(row => row.id === existing.id);
  assert.equal(local.phone_number, '13900139000');
});

test('跨站浏览器请求被拒绝，防止登录 CSRF', async () => {
  const crossSite = await quickLogin({ code: stage(huaweiPayload()) }, { Origin: 'https://evil.example.test' });
  assert.equal(crossSite.status, 403);
  assert.equal(f.pool.users.length, 0);

  const secFetch = await quickLogin({ code: stage(huaweiPayload()) }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(secFetch.status, 403);
  assert.equal(f.pool.users.length, 0);

  // 同站浏览器请求（例如网关自身的页面）仍然放行
  const sameOrigin = await quickLogin({ code: stage(huaweiPayload()) }, { Origin: process.env.PUBLIC_BASE_URL });
  assert.equal(sameOrigin.status, 200);
});

test('可以换取授权码交给已注册客户端，并下发 phone 声明', async () => {
  const app = await createClient(['openid', 'profile', 'email', 'phone', 'offline_access']);
  const verifier = randomSecret();
  const state = randomSecret();
  const result = await quickLogin({
    code: stage(huaweiPayload()),
    client_id: app.id,
    redirect_uri: app.redirectUris[0],
    scope: 'openid profile phone',
    state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.state, state);
  assert.equal(result.body.phone, '+8613800138000');
  assert.ok(typeof result.body.authorization_code === 'string' && result.body.authorization_code.length > 0);
  // 换取授权码不应同时下发会话 Cookie
  assert.doesNotMatch(result.cookie, /(?:^|;\s*)session=/);

  const exchanged = await f.exchange(app, { code: result.body.authorization_code, verifier });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  const userinfo = await f.request('/oauth2/userinfo', {
    headers: { Authorization: `Bearer ${exchanged.body.access_token}` }
  });
  assert.equal(userinfo.status, 200);
  assert.equal(userinfo.body.phone_number, '+8613800138000');
  assert.equal(userinfo.body.phone_number_verified, true);
});

test('未申请 phone scope 时不下发手机号声明', async () => {
  const app = await createClient(['openid', 'profile', 'email', 'offline_access']);
  const verifier = randomSecret();
  const result = await quickLogin({
    code: stage(huaweiPayload()),
    client_id: app.id,
    redirect_uri: app.redirectUris[0],
    scope: 'openid profile',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256'
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.phone, null);
  assert.equal(result.body.phoneStatus, 'scope_not_granted');
  assert.equal(result.body.user.phoneE164, '');
  assert.equal(result.body.user.phoneNationalNumber, '');
  const exchanged = await f.exchange(app, { code: result.body.authorization_code, verifier });
  const userinfo = await f.request('/oauth2/userinfo', {
    headers: { Authorization: `Bearer ${exchanged.body.access_token}` }
  });
  assert.equal(userinfo.status, 200);
  assert.equal(userinfo.body.phone_number, undefined);
});

test('无 client_id 时下发会话 Cookie 并可直接访问个人资料', async () => {
  const result = await quickLogin({ code: stage(huaweiPayload()) });
  assert.equal(result.status, 200);
  assert.match(result.cookie, /(?:^|;\s*)session=/);
  const profile = await f.request('/api/profile', { cookie: result.cookie });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.phoneMasked, '+86 138****8000');
});

test('启用验证器时返回 mfa_required，并可用响应体里的凭据（无需 Cookie）完成验证', async () => {
  const first = await quickLogin({ code: stage(huaweiPayload()) });
  assert.equal(first.status, 200);
  const recovery = 'ABCD2345EFGH6789';
  await f.User.update(first.body.user.id, {
    totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP',
    recoveryCodes: JSON.stringify([crypto.createHash('sha256').update(recovery).digest('hex')])
  });

  const second = await quickLogin({ code: stage(huaweiPayload({ unionID: f.pool.userIdentities[0].provider_user_id })) });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.mfa_required, true);
  assert.equal(second.body.factor, 'totp');
  assert.ok(second.body.pending_token);
  assert.equal(second.body.pending_header, 'X-Oidc-Pending');
  // 二次验证未完成前不得下发会话
  assert.doesNotMatch(second.cookie, /(?:^|;\s*)session=/);

  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST',
    headers: { 'X-Oidc-Pending': second.body.pending_token },
    data: { code: recovery }
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.match(completed.cookie, /(?:^|;\s*)session=/);
  assert.equal((await f.request('/api/profile', { cookie: completed.cookie })).status, 200);
});

test('华为未返回手机号时仍可登录，只是不写手机号', async () => {
  const result = await quickLogin({
    code: stage(huaweiPayload({ purePhoneNumber: '', phoneCountryCode: '', loginMobileNumber: '', loginMobileValid: '' }))
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '');
  assert.equal(f.pool.users[0].phone_number, null);
});

test('无效或已使用的授权码被拒绝，且不泄露上游报文', async () => {
  const code = stage(huaweiPayload());
  assert.equal((await quickLogin({ code })).status, 200);
  const reused = await quickLogin({ code });
  assert.equal(reused.status, 400);
  assert.equal(reused.body.error, 'invalid_grant');

  const missing = await quickLogin({});
  assert.equal(missing.status, 400);
  // 响应只给出固定的中文说明，不回显华为原始错误码或凭据
  assert.equal(missing.body.error_description, '华为账号授权码无效或已过期');
  assert.doesNotMatch(missing.body.error_description, /invalid_client|client_secret|401/);

  // 凭据错误单独提示配置问题，但不回显原始报文。
  f.pool.oidcProviders[0].client_secret = 'wrong-secret';
  const badCredential = await quickLogin({ code: stage(huaweiPayload()) });
  assert.equal(badCredential.status, 503);
  assert.equal(badCredential.body.error, 'huawei_not_configured');
  assert.match(badCredential.body.error_description, /凭据配置错误/);
  assert.doesNotMatch(JSON.stringify(badCredential.body), /invalid_client/);
});

test('未配置华为提供方时返回 503 而不是静默失败', async () => {
  f.pool.oidcProviders.length = 0;
  const result = await quickLogin({ code: stage(huaweiPayload()) });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'huawei_not_configured');
});

test('禁用注册后不允许通过一键登录创建账号', async () => {
  f.pool.settings.push({ setting_key: 'registration_enabled', setting_value: 'false' });
  const result = await quickLogin({ code: stage(huaweiPayload()) });
  assert.equal(result.status, 400);
  assert.equal(f.pool.users.length, 0);
});

test('已封禁账号不允许通过一键登录进入', async () => {
  const unionID = `union-${crypto.randomUUID()}`;
  const first = await quickLogin({ code: stage(huaweiPayload({ unionID })) });
  assert.equal(first.status, 200);
  await f.User.update(first.body.user.id, { banned: true });
  const second = await quickLogin({ code: stage(huaweiPayload({ unionID })) });
  assert.equal(second.status, 403);
});

async function configureApp(providerKey, huaweiUnionScope = '', overrides = {}) {
  const appClientId = providerKey === 'huawei' ? clientId : `${clientId}-${providerKey}`;
  acceptedClientIds.add(appClientId);
  return new OidcProviderModel(f.pool).upsert({
    providerKey, providerName: `Huawei ${providerKey}`, providerType: 'huawei_quicklogin',
    clientId: appClientId, clientSecret, tokenUrl: huaweiEndpoint, huaweiUnionScope,
    validateIdToken: false, pkceEnabled: false, ...overrides
  });
}

function noPhone(overrides = {}) {
  return huaweiPayload({ purePhoneNumber: '', phoneCountryCode: '', loginMobileNumber: '', ...overrides });
}

test('fresh existing-account login merges a disposable Huawei account across Apps without losing bindings', async () => {
  await configureApp('huawei', 'company-one');
  await configureApp('huawei-two', 'company-one');
  const unionID = `merge-${crypto.randomUUID()}`;
  const sourceLogin = await quickLogin({ provider: 'huawei', code: stage(huaweiPayload({
    unionID, openID: 'merge-app-one'
  })) });
  assert.equal(sourceLogin.status, 200, JSON.stringify(sourceLogin.body));
  const sourceId = sourceLogin.body.user.id;
  const secondApp = await quickLogin({ provider: 'huawei-two', code: stage(noPhone({
    unionID, openID: 'merge-app-two'
  })) });
  assert.equal(secondApp.body.user.id, sourceId);
  f.pool.userAppUsage.push({ user_id: sourceId, client_id: 'historical-app', client_name: 'Historical app',
    first_used_at: new Date('2026-01-01'), last_used_at: new Date('2026-02-01') });

  const target = await f.user();
  const signedIn = await f.login(target);
  assert.equal(signedIn.status, 200);
  const freshProof = { provider: 'huawei', intent: 'merge', authorizationCode: stage(huaweiPayload({
    unionID, openID: 'merge-app-one'
  })) };
  const unauthorized = await quickLoginRaw(freshProof);
  assert.equal(unauthorized.status, 403);
  assert.ok(await f.User.findById(sourceId));

  const merged = await quickLoginRaw(freshProof, { Cookie: signedIn.cookie });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.merged, true);
  assert.equal(merged.body.user.id, target.id);
  assert.equal(merged.body.phone, '+8613800138000');
  assert.equal(await f.User.findById(sourceId), null);
  assert.deepEqual(f.pool.userIdentities.map(row => row.user_id), [target.id, target.id]);
  assert.equal(f.pool.userAppUsage[0].user_id, target.id);
  assert.equal((await f.request('/api/profile', { cookie: signedIn.cookie })).status, 200);

  const later = await quickLogin({ provider: 'huawei-two', code: stage(noPhone({ unionID, openID: 'merge-app-two' })) });
  assert.equal(later.body.user.id, target.id);
  assert.equal(f.pool.users.length, 1);
});

test('merge refuses a stale target session before consuming the fresh Huawei code', async () => {
  const target = await f.user();
  const signedIn = await f.login(target);
  const session = f.pool.sessions.find(row => row.user_id === target.id);
  session.created_at = new Date(Date.now() - 6 * 60 * 1000);
  const code = stage(huaweiPayload());
  const result = await quickLoginRaw({ intent: 'merge', authorizationCode: code }, { Cookie: signedIn.cookie });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'reauthentication_required');
  assert.equal(codes.has(code), true);
});

test('merge persists a verified phone first returned by the fresh Huawei code', async () => {
  const unionID = `merge-phone-${crypto.randomUUID()}`;
  const sourceLogin = await quickLogin({ code: stage(noPhone({ unionID, openID: 'merge-phone-open' })) });
  assert.equal(sourceLogin.status, 200);
  assert.equal(sourceLogin.body.user.phoneE164, '');
  const sourceId = sourceLogin.body.user.id;
  const target = await f.user();
  const signedIn = await f.login(target);
  const merged = await quickLoginRaw({ intent: 'merge', authorizationCode: stage(huaweiPayload({
    unionID, openID: 'merge-phone-open'
  })) }, { Cookie: signedIn.cookie });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.phone, '+8613800138000');
  assert.equal(merged.body.phoneBinding, 'verified');
  assert.equal(merged.body.user.phoneE164, '+8613800138000');
  assert.equal((await f.User.findById(target.id)).phone_e164, '+8613800138000');
  assert.equal(await f.User.findById(sourceId), null);
});

test('merge refuses a target session revoked after the Huawei exchange', async () => {
  const unionID = `merge-session-${crypto.randomUUID()}`;
  const sourceLogin = await quickLogin({ code: stage(noPhone({ unionID, openID: 'merge-session-open' })) });
  const target = await f.user();
  const signedIn = await f.login(target);
  const execute = f.pool.execute.bind(f.pool);
  let revoked = false;
  f.pool.execute = (sql, params) => {
    if (!revoked && sql === 'SELECT * FROM user_identities WHERE provider = ? AND provider_user_id = ?') {
      revoked = true;
      f.pool.sessions.find(row => row.user_id === target.id).revoked_at = new Date();
    }
    return execute(sql, params);
  };
  try {
    const merged = await quickLoginRaw({ intent: 'merge', authorizationCode: stage(noPhone({
      unionID, openID: 'merge-session-open'
    })) }, { Cookie: signedIn.cookie });
    assert.equal(revoked, true);
    assert.equal(merged.status, 403);
    assert.equal(merged.body.error, 'reauthentication_required');
    assert.ok(await f.User.findById(sourceLogin.body.user.id));
  } finally { f.pool.execute = execute; }
});

test('同主体多个 App 用 UnionID 关联一个用户，并分别保留 OpenID 与 Client ID', async () => {
  await configureApp('huawei', 'company-one');
  await configureApp('huawei-two', 'company-one');
  const unionID = randomSecret();
  const first = await quickLogin({ provider: 'huawei', code: stage(noPhone({ unionID, openID: 'open-app-one' })) });
  const second = await quickLogin({ provider: 'huawei-two', code: stage(noPhone({ unionID, openID: 'open-app-two' })) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.user.id, first.body.user.id);
  assert.equal(f.pool.users.length, 1);
  assert.equal(f.pool.userIdentities.length, 2);
  assert.deepEqual(f.pool.userIdentities.map(row => row.provider_secondary_id).sort(), ['open-app-one', 'open-app-two']);
  assert.equal(JSON.parse(f.pool.userIdentities[1].profile).clientId, `${clientId}-huawei-two`);
  assert.equal(JSON.parse(f.pool.userIdentities[1].profile).huaweiUnionScope, 'company-one');
});

test('不同主体、未设主体和仅 OpenID 的 App 不跨提供方关联', async () => {
  await configureApp('huawei', 'company-one');
  await configureApp('huawei-two', 'company-two');
  await configureApp('huawei-three');
  await configureApp('huawei-four');
  const unionID = randomSecret();
  for (const provider of ['huawei', 'huawei-two', 'huawei-three', 'huawei-four']) {
    const result = await quickLogin({ provider, code: stage(noPhone({ unionID })) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  await configureApp('huawei-open-one', 'company-one');
  await configureApp('huawei-open-two', 'company-one');
  for (const provider of ['huawei-open-one', 'huawei-open-two']) {
    const result = await quickLogin({ provider, code: stage(noPhone({ unionID: '', openID: 'same-open-without-union' })) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  assert.equal(f.pool.users.length, 6);
});

test('同主体不同 App 并发首次登录只创建一个用户', async () => {
  await configureApp('huawei', 'company-one');
  await configureApp('huawei-two', 'company-one');
  const unionID = randomSecret();
  const results = await Promise.all(['huawei', 'huawei-two'].map(provider => quickLogin({ provider, code: stage(noPhone({ unionID })) })));
  results.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)));
  assert.equal(results[0].body.user.id, results[1].body.user.id);
  assert.equal(f.pool.users.length, 1);
  assert.equal(f.pool.userIdentities.length, 2);
  assert.equal(f.pool.namedLocks.size, 0);
});

test('显式设主体后可关联旧空分组绑定，只有 OpenID 的旧记录不会被当成 UnionID', async () => {
  const unionID = randomSecret();
  const first = await quickLogin({ code: stage(noPhone({ unionID })) });
  assert.equal(first.status, 200);
  await configureApp('huawei', 'company-one');
  await configureApp('huawei-two', 'company-one');
  const second = await quickLogin({ provider: 'huawei-two', code: stage(noPhone({ unionID })) });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.user.id, first.body.user.id);
  await configureApp('huawei-open', 'company-one');
  const third = await quickLogin({ provider: 'huawei-open', code: stage(noPhone({ unionID: '', openID: 'open-only' })) });
  await configureApp('huawei-other', 'company-one');
  const fourth = await quickLogin({ provider: 'huawei-other', code: stage(noPhone({ unionID: 'open-only' })) });
  assert.equal(third.status, 200);
  assert.equal(fourth.status, 200);
  assert.notEqual(fourth.body.user.id, third.body.user.id);
});

test('同一 App 同时首次登录不会产生重复用户或孤立用户', async () => {
  const identity = noPhone();
  const results = await Promise.all([1, 2].map(() => quickLogin({ code: stage(identity) })));
  results.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)));
  assert.equal(f.pool.users.length, 1);
  assert.equal(f.pool.userIdentities.length, 1);
  assert.equal(f.pool.namedLocks.size, 0);
});

test('绑定写入失败会回滚新用户，同时保留另一个并发登录提交的用户', async () => {
  await configureApp('huawei-two');
  const getConnection = f.pool.getConnection.bind(f.pool);
  let otherResult;
  f.pool.getConnection = async () => {
    const connection = await getConnection();
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql, params) => {
      if (/^INSERT INTO user_identities/i.test(sql) && params[2] === 'huawei') {
        otherResult = await quickLogin({ provider: 'huawei-two', code: stage(noPhone({ unionID: 'committed-union' })) });
        throw new Error('Simulated identity storage failure');
      }
      return execute(sql, params);
    };
    return connection;
  };
  try {
    const failed = await quickLogin({ provider: 'huawei', code: stage(noPhone({ unionID: 'rolled-back-union' })) });
    assert.equal(failed.status, 400);
    assert.equal(otherResult.status, 200, JSON.stringify(otherResult.body));
    assert.equal(f.pool.users.length, 1);
    assert.equal(f.pool.users[0].id, otherResult.body.user.id);
    assert.equal(f.pool.userIdentities.length, 1);
    assert.equal(f.pool.userIdentities[0].provider, 'huawei-two');
    assert.equal(f.pool.namedLocks.size, 0);
  } finally { f.pool.getConnection = getConnection; }
});

test('默认不按手机号合并时，相同手机号的独立华为账号正常登录但不抢占号码', async () => {
  f.pool.settings.push({ setting_key: 'huawei_phone_autolink', setting_value: 'false' });
  const first = await quickLogin({ code: stage(huaweiPayload({ unionID: 'phone-owner-union', openID: 'phone-owner-open' })) });
  const second = await quickLogin({ code: stage(huaweiPayload({ unionID: 'separate-union', openID: 'separate-open' })) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.notEqual(second.body.user.id, first.body.user.id);
  assert.equal(first.body.user.phoneVerified, true);
  assert.equal(second.body.user.phoneE164, '');
  assert.equal(second.body.user.phoneVerified, false);
  assert.equal(f.pool.users.length, 2);
  assert.equal(f.pool.userIdentities.length, 2);
  assert.equal((await f.User.findById(first.body.user.id)).phone_e164, '+8613800138000');
});

test('华为回传手机号在绑定时发生唯一键竞争，保留账号登录并记录冲突', async () => {
  const execute = f.pool.execute.bind(f.pool);
  f.pool.execute = async (sql, params) => {
    if (/^UPDATE users SET .*phone_number = \?/i.test(sql)) {
      throw Object.assign(new Error('Duplicate phone_e164'), { code: 'ER_DUP_ENTRY' });
    }
    return execute(sql, params);
  };
  try {
    const result = await quickLogin({ code: stage(huaweiPayload()) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.user.phoneE164, '');
    assert.equal(result.body.user.phoneVerified, false);
    assert.match(f.pool.loginLogs[0].detail, /phone:conflict/);
  } finally { f.pool.execute = execute; }
});

test('华为绑定手机号时并发用户编辑不会被旧的空号码快照覆盖', async () => {
  const identity = { unionID: 'binding-race-union', openID: 'binding-race-open' };
  const first = await quickLogin({ code: stage(noPhone(identity)) });
  assert.equal(first.status, 200);
  const execute = f.pool.execute.bind(f.pool);
  let raced = false;
  f.pool.execute = async (sql, params) => {
    if (/WHERE id = \? AND phone_e164 IS NULL/i.test(sql) && !raced) {
      raced = true;
      await f.User.update(first.body.user.id, { phoneCountryCode: '86', phoneNumber: '13900139000', phoneVerified: false });
    }
    return execute(sql, params);
  };
  try {
    const result = await quickLogin({ code: stage(huaweiPayload(identity)) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(raced, true);
    assert.equal(result.body.user.phoneE164, '+8613900139000');
    assert.equal(result.body.user.phoneVerified, false);
    assert.equal((await f.User.findById(first.body.user.id)).phone_e164, '+8613900139000');
    assert.match(f.pool.loginLogs.at(-1).detail, /phone:conflict/);
  } finally { f.pool.execute = execute; }
});

test('华为验证手机号时并发用户换号不会使新号码被错误验证', async () => {
  const identity = { unionID: 'verification-race-union', openID: 'verification-race-open' };
  const first = await quickLogin({ code: stage(noPhone(identity)) });
  assert.equal(first.status, 200);
  await f.User.update(first.body.user.id, { phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: false });
  const execute = f.pool.execute.bind(f.pool);
  let raced = false;
  f.pool.execute = async (sql, params) => {
    if (/AND phone_e164 = \? AND phone_verified = FALSE/i.test(sql) && !raced) {
      raced = true;
      await f.User.update(first.body.user.id, { phoneCountryCode: '86', phoneNumber: '13900139000', phoneVerified: false });
    }
    return execute(sql, params);
  };
  try {
    const result = await quickLogin({ code: stage(huaweiPayload(identity)) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(raced, true);
    assert.equal(result.body.user.phoneE164, '+8613900139000');
    assert.equal(result.body.user.phoneVerified, false);
    assert.equal(result.body.user.phoneVerifiedAt, null);
    assert.equal((await f.User.findById(first.body.user.id)).phone_verified, false);
    assert.match(f.pool.loginLogs.at(-1).detail, /phone:conflict/);
  } finally { f.pool.execute = execute; }
});

test('已有华为绑定可验证相同的本地未验证号码', async () => {
  const identity = { unionID: 'verify-same-union', openID: 'verify-same-open' };
  const first = await quickLogin({ code: stage(noPhone(identity)) });
  assert.equal(first.status, 200);
  await f.User.update(first.body.user.id, { phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: false });
  const verified = await quickLogin({ code: stage(huaweiPayload(identity)) });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.equal(verified.body.user.id, first.body.user.id);
  assert.equal(verified.body.user.phoneVerified, true);
  assert.ok(verified.body.user.phoneVerifiedAt);
  assert.match(f.pool.loginLogs.at(-1).detail, /phone:verified/);
});

test('主标识和 OpenID 映射到不同用户时拒绝登录', async () => {
  const first = await quickLogin({ code: stage(noPhone({ unionID: 'union-one', openID: 'open-one' })) });
  const second = await quickLogin({ code: stage(noPhone({ unionID: 'union-two', openID: 'open-two' })) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const conflict = await quickLogin({ code: stage(noPhone({ unionID: 'union-one', openID: 'open-two' })) });
  assert.equal(conflict.status, 400);
  assert.equal(f.pool.users.length, 2);
  assert.equal(f.pool.userIdentities.length, 2);
  assert.equal(f.pool.namedLocks.size, 0);
});

test('历史重复 UnionID 在设同主体后报冲突，禁用 App 也参与检查', async () => {
  await configureApp('huawei');
  await configureApp('huawei-two');
  const unionID = randomSecret();
  for (const provider of ['huawei', 'huawei-two']) {
    assert.equal((await quickLogin({ provider, code: stage(noPhone({ unionID })) })).status, 200);
  }
  // The admin now explicitly asserts a common subject for previously independent apps.
  await configureApp('huawei', 'company-one');
  await configureApp('huawei-two', 'company-one', { enabled: false });
  const conflict = await quickLogin({ provider: 'huawei', code: stage(noPhone({ unionID })) });
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.error_description, /UnionID/);
  assert.equal(f.pool.users.length, 2);
});

test('OpenID-only 老绑定补充 UnionID 后仍保留原本地账号', async () => {
  const first = await quickLogin({ code: stage(noPhone({ unionID: '', openID: 'legacy-open' })) });
  const second = await quickLogin({ code: stage(noPhone({ unionID: 'new-union', openID: 'legacy-open' })) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(first.body.user.id, second.body.user.id);
  assert.equal(f.pool.userIdentities.length, 1);
  assert.equal(f.pool.userIdentities[0].provider_secondary_id, 'legacy-open');
});

test('已绑定 UnionID 的 App 后续只返回 OpenID 时仍使用原账号', async () => {
  const first = await quickLogin({ code: stage(noPhone({ unionID: 'existing-union', openID: 'existing-open' })) });
  const second = await quickLogin({ code: stage(noPhone({ unionID: '', openID: 'existing-open' })) });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.user.id, first.body.user.id);
  assert.equal(f.pool.users.length, 1);
  assert.equal(f.pool.userIdentities.length, 1);
  assert.equal(JSON.parse(f.pool.userIdentities[0].profile).unionID, 'existing-union');
});

test('复用 Provider key 更换 Client ID 必须拒绝，原 App 的标识不被覆盖', async () => {
  const unionID = randomSecret();
  assert.equal((await quickLogin({ code: stage(noPhone({ unionID, openID: 'original-open' })) })).status, 200);
  const changedClient = `${clientId}-changed`;
  acceptedClientIds.add(changedClient);
  await configureApp('huawei', '', { clientId: changedClient });
  const conflict = await quickLogin({ code: stage(noPhone({ unionID, openID: 'changed-open' })) });
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.error_description, /Provider key/);
  assert.equal(f.pool.userIdentities[0].provider_secondary_id, 'original-open');
  assert.equal(JSON.parse(f.pool.userIdentities[0].profile).clientId, clientId);
});

test('账号应用绑定数据和静态页面仅管理员可访问，配置移除后保留安全投影', async () => {
  assert.equal((await f.request('/api/admin/account-bindings')).status, 401);
  const ordinary = await f.user();
  const ordinaryLogin = await f.login(ordinary);
  assert.equal((await f.request('/api/admin/account-bindings', { cookie: ordinaryLogin.cookie })).status, 403);
  const deniedPage = await f.request('/account-bindings.html', { cookie: ordinaryLogin.cookie });
  assert.equal(deniedPage.status, 302);
  assert.match(deniedPage.headers.get('location'), /access_denied/);
  const admin = await f.user('admin');
  const adminLogin = await f.login(admin);
  await configureApp('huawei', 'company-one');
  await configureApp('huawei-two', 'company-one');
  const unionID = randomSecret();
  for (const provider of ['huawei', 'huawei-two']) {
    assert.equal((await quickLogin({ provider, code: stage(noPhone({ unionID })) })).status, 200);
  }
  const identity = f.pool.userIdentities[0];
  identity.profile = JSON.stringify({ ...JSON.parse(identity.profile), access_token: 'must-not-leak', raw: { secret: 'must-not-leak' } });
  await new OidcProviderModel(f.pool).delete('huawei');
  const result = await f.request('/api/admin/account-bindings', { cookie: adminLogin.cookie });
  assert.equal(result.status, 200);
  assert.equal(result.body.accounts.length, 1);
  assert.equal(result.body.accounts[0].bindings.length, 2);
  const removed = result.body.accounts[0].bindings.find(binding => binding.provider === 'huawei');
  assert.equal(removed.configured, false);
  assert.equal(removed.clientId, clientId);
  assert.equal(removed.huaweiUnionScope, 'company-one');
  assert.equal(removed.unionId, unionID);
  assert.doesNotMatch(JSON.stringify(result.body), /must-not-leak|clientSecret|access_token|"profile"/);
  assert.equal((await f.request('/account-bindings.html', { cookie: adminLogin.cookie })).status, 200);
});

test('管理员保存华为主体分组后读取不丢失，并拒绝非法分组', async () => {
  const admin = await f.user('admin');
  const login = await f.login(admin);
  const payload = { providerKey: 'huawei', providerName: 'Huawei', providerType: 'huawei_quicklogin', clientId, huaweiUnionScope: 'subject:test-one' };
  const result = await f.request('/api/admin/oidc', { cookie: login.cookie, method: 'POST', data: payload });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.provider.huaweiUnionScope, 'subject:test-one');
  assert.equal(result.body.provider.providerType, 'huawei_quicklogin');
  assert.equal((await f.request('/api/admin/oidc', { cookie: login.cookie })).body.providers[0].huaweiUnionScope, 'subject:test-one');
  const invalid = await f.request('/api/admin/oidc', { cookie: login.cookie, method: 'POST', data: { ...payload, huaweiUnionScope: { invalid: true } } });
  assert.equal(invalid.status, 400);
});
