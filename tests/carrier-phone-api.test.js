const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const jwt = require('jsonwebtoken');
const { createFixture, randomSecret } = require('./support/fixture');
const { failNextInsert, failNextConsume, failNextCommit } = require('./support/memory-db');
const { createStore } = require('../services/admin-settings');
const ExternalIdentityModel = require('../models/ExternalIdentity');
const tianyi = require('../services/tianyi');

// These tests exercise the real HTTP routes and provider adapter. Only the fixed
// PNVS transport is replaced; every other fetch retains the fixture egress guard.
const PNVS = 'https://dypnsapi.aliyuncs.com/';
const TIANYI_TOKEN = tianyi.TOKEN_URL;
const TIANYI_APP = 'carrier-test-app';
const TIANYI_SECRET = 'carrier-test-secret';
const PHONE = '+8613800138000';
const OTHER_PHONE = '+8613900139000';
const CONFIG = {
  h5Enabled: true, appEnabled: true, smsEnabled: true, allowRegistration: false,
  accessKeyId: 'isolated-ak', accessKeySecret: 'isolated-secret', securityToken: 'isolated-sts',
  sceneCode: 'scene-test', h5Origin: 'https://gateway.example.test',
  h5Url: 'https://gateway.example.test/oauth2/authorize', h5SdkUrl: '/test/phone-sdk.js',
  smsSchemeName: 'isolated', smsSignName: 'Test', smsTemplateCode: 'SMS_TEST',
  smsTemplateParam: { code: '##code##', min: '5' }
};
let f;
let adminCookie;
let calls;
let sms;
let phoneTokens;
let providerHook;
let tianyiPayload;
const guardedFetch = globalThis.fetch;

before(async () => { f = await createFixture(); });
beforeEach(async () => {
  f.reset();
  calls = [];
  sms = new Map();
  phoneTokens = new Map();
  providerHook = null;
  tianyiPayload = null;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input.url || input);
    if (url === TIANYI_TOKEN) {
      assert.equal(init.method, 'POST');
      assert.equal(init.redirect, 'error');
      assert.ok(tianyiPayload, 'unexpected Tianyi token exchange');
      return Response.json(tianyiPayload);
    }
    if (url !== PNVS) return guardedFetch(input, init);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const fields = Object.fromEntries(new URLSearchParams(init.body));
    assert.equal(fields.Version, '2017-05-25');
    assert.ok(fields.Signature);
    calls.push(fields);
    if (providerHook) {
      const response = await providerHook(fields);
      if (response !== undefined) return Response.json(response);
    }
    if (fields.Action === 'GetAuthToken') return Response.json({ Code: 'OK',
      TokenInfo: { AccessToken: 'h5-access', JwtToken: 'h5-jwt' } });
    if (fields.Action === 'GetMobile' || fields.Action === 'GetPhoneWithToken') {
      const token = fields.AccessToken || fields.SpToken;
      const phone = phoneTokens.get(token);
      if (!phone) return Response.json({ Code: 'InvalidToken' });
      return Response.json({ Code: 'OK', ...(fields.Action === 'GetMobile'
        ? { GetMobileResultDTO: { Mobile: phone } } : { Data: { Mobile: phone } }) });
    }
    if (fields.Action === 'SendSmsVerifyCode') {
      assert.equal(fields.CountryCode, '86');
      assert.match(fields.PhoneNumber, /^1[3-9][0-9]{9}$/);
      assert.equal(fields.ReturnVerifyCode, 'false');
      sms.set(fields.OutId, { phone: fields.PhoneNumber, code: '246810' });
      return Response.json({ Code: 'OK', RequestId: 'request', Model: { BizId: 'biz' } });
    }
    if (fields.Action === 'CheckSmsVerifyCode') {
      const issued = sms.get(fields.OutId);
      return Response.json({ Code: 'OK', Model: { VerifyResult:
        issued?.phone === fields.PhoneNumber && issued.code === fields.VerifyCode ? 'PASS' : 'FAIL' } });
    }
    throw new Error(`Unexpected isolated provider action: ${fields.Action}`);
  };
  const admin = await f.user('admin');
  const login = await f.login(admin);
  assert.equal(login.status, 200, JSON.stringify(login.body));
  adminCookie = login.cookie;
  await configure(CONFIG);
});
afterEach(() => { globalThis.fetch = guardedFetch; });
after(async () => { if (f) await f.close(); });

function post(path, data = {}, cookie = '', headers = {}) {
  return f.request(path, { method: 'POST', data, cookie, headers });
}
async function configure(data) {
  const result = await f.request('/api/admin/phone-auth', { method: 'PUT', cookie: adminCookie, data });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}
async function configureTianyi({ clientId = TIANYI_APP, clientSecret = TIANYI_SECRET } = {}) {
  const result = await f.request('/api/admin/oidc', { method: 'POST', cookie: adminCookie, data: {
    providerKey: 'tianyi-test', providerName: 'Tianyi isolated fixture', providerType: 'tianyi_web',
    clientId, clientSecret
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}
async function tianyiIdentityUser(openId) {
  const user = await f.user();
  await new ExternalIdentityModel(f.pool).create({ userId: user.id, provider: 'tianyi-test', providerUserId: openId,
    displayName: 'Tianyi fixture', profile: { provider: 'tianyi_web', appId: TIANYI_APP, openId } });
  return user;
}
function tianyiTimestamp(offsetMs = 0) {
  const date = new Date(Date.now() + offsetMs + 8 * 60 * 60 * 1000);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
async function startTianyi(cookie = '') {
  const started = await f.request('/api/v1/auth/oauth/oidc/login?provider=tianyi-test&session_days=7', { cookie });
  assert.equal(started.status, 302, JSON.stringify(started.body));
  const authorization = new URL(started.headers.get('location'));
  const fields = new URLSearchParams(tianyi.xxteaDecrypt(authorization.searchParams.get('paras'), TIANYI_SECRET));
  return { started, state: fields.get('state'), initialCookie: cookie };
}
async function finishTianyi(started, openId) {
  tianyiPayload = { result: '10000', openId, appId: TIANYI_APP, accessToken: 'fixture-token',
    timeStamp: tianyiTimestamp() };
  const plaintext = new URLSearchParams({ result: '0', code: `code-${openId}`, state: started.state,
    timeStamp: tianyiTimestamp() }).toString();
  const paras = tianyi.xxteaEncrypt(plaintext, TIANYI_SECRET);
  const sign = crypto.createHmac('sha1', TIANYI_SECRET).update(`${TIANYI_APP}${paras}`, 'utf8').digest('hex').toUpperCase();
  return f.request(`/api/v1/auth/oauth/oidc/callback?${new URLSearchParams({ appId: TIANYI_APP, paras, sign })}`,
    { cookie: [started.initialCookie, started.started.cookie].filter(Boolean).join('; ') });
}
async function phoneUser(phone = PHONE, verified = true) {
  const user = await f.user();
  await f.User.update(user.id, { phone, phoneVerified: verified });
  return { ...await f.User.findById(user.id), clearPassword: user.clearPassword };
}
async function send(phone = PHONE, data = {}, cookie = '') {
  const result = await post('/api/auth/phone/sms/send', { phone, ...data }, cookie);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(result.body.challengeId);
  assert.equal(result.body.retryAfter, 60);
  assert.equal(result.body.expiresIn, 300);
  return result;
}
function verify(sent, data = {}, cookie = '') {
  return post('/api/auth/phone/sms/login', { challengeId: sent.body.challengeId, code: '246810', ...data }, cookie);
}
function claims(result) {
  const raw = result.cookie.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  assert.ok(raw, JSON.stringify(result.body));
  return jwt.verify(decodeURIComponent(raw), process.env.JWT_SECRET);
}
function noSession(result) {
  assert.doesNotMatch(result.cookie, /(?:^|;\s*)session=/);
  assert.doesNotMatch(result.cookie, /(?:^|;\s*)browser_accounts=/);
}
function challenge(sent) {
  return f.pool.emailVerificationCodes.find(row => row.id === sent.body.challengeId);
}
function freeze(t) {
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  t.after(() => t.mock.timers.reset());
  return now;
}
async function oauthClient(id = `client-${crypto.randomUUID()}`) {
  const secret = randomSecret();
  const app = await f.Client.create({ id, name: 'Phone test client', secret,
    redirectUris: ['https://client.example.test/callback'], scopes: ['openid', 'profile', 'phone', 'offline_access'] });
  return { ...app, clearSecret: secret };
}
function oauth(app, scope = 'openid profile') {
  const verifier = randomSecret();
  return { verifier, params: { client_id: app.id, redirect_uri: app.redirectUris[0],
    response_type: 'code', scope, state: 'phone-state', nonce: 'phone-nonce',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' } };
}

test('admin config is encrypted, redacted, reloadable, and supports preserve/clear', async () => {
  const publicView = await f.request('/api/auth/phone/config');
  assert.match(publicView.headers.get('cache-control'), /no-store/);
  assert.deepEqual([publicView.body.h5.available, publicView.body.app.available, publicView.body.sms.available], [true, true, true]);
  assert.doesNotMatch(JSON.stringify(publicView.body), /isolated-(?:secret|sts|ak)/);
  const saved = JSON.parse(fs.readFileSync(process.env.ADMIN_SETTINGS_FILE, 'utf8'));
  assert.match(saved.phoneAuth.accessKeySecret, /^enc:v1:/);
  assert.match(saved.phoneAuth.securityToken, /^enc:v1:/);
  const loaded = createStore(process.env.JWT_SECRET).load();
  assert.equal(loaded.phoneAuth.accessKeySecret, CONFIG.accessKeySecret);
  const preserved = await configure({ accessKeySecret: '', securityToken: '' });
  assert.equal(preserved.body.hasAccessKeySecret, true);
  assert.equal(preserved.body.hasSecurityToken, true);
  assert.doesNotMatch(JSON.stringify(preserved.body), /isolated-(?:secret|sts)/);
  const cleared = await configure({ clearAccessKeySecret: true, clearSecurityToken: true });
  assert.equal(cleared.body.hasAccessKeySecret, false);
  assert.equal(cleared.body.hasSecurityToken, false);
  assert.equal((await f.request('/api/auth/phone/config')).body.sms.available, false);
  const ordinary = await f.user();
  const login = await f.login(ordinary);
  assert.equal((await f.request('/api/admin/phone-auth', { cookie: login.cookie })).status, 403);
  assert.equal((await f.request('/api/admin/phone-auth', { method: 'PUT', data: CONFIG, cookie: login.cookie })).status, 403);
  assert.equal(calls.length, 0);
});

test('disabled and incomplete channels reject without provider traffic', async () => {
  for (const update of [{ h5Enabled: false, appEnabled: false, smsEnabled: false },
    { h5Enabled: true, appEnabled: true, smsEnabled: true, clearAccessKeySecret: true }]) {
    await configure(update);
    for (const [path, data] of [['h5/token', {}], ['h5/login', { challengeId: 'x', spToken: 'x' }],
      ['app/login', { accessToken: 'x' }], ['sms/send', { phone: PHONE }], ['sms/login', { challengeId: 'x', code: '246810' }]]) {
      const result = await post(`/api/auth/phone/${path}`, data);
      assert.equal(result.status, 503, path);
      noSession(result);
    }
  }
  assert.equal(calls.length, 0);
});

test('SMS challenge retains server-owned target/duration and is one use', async () => {
  const user = await phoneUser();
  const sent = await send(PHONE, { session_days: 7, return_to: '/profile' });
  const row = challenge(sent);
  assert.equal(row.pending_context.phone, PHONE);
  assert.equal(row.pending_context.sessionDays, 7);
  assert.ok(!row.email.includes('13800138000'));
  assert.ok(!JSON.stringify(row).includes('246810'));
  const result = await verify(sent, { phone: OTHER_PHONE, session_days: 14, return_to: '//evil.test' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.id, user.id);
  assert.equal(result.body.phone, PHONE);
  assert.equal(claims(result).session_days, 7);
  assert.ok(challenge(sent).consumed_at);
  const replay = await verify(sent);
  assert.equal(replay.status, 401);
  noSession(replay);
  assert.equal(calls.filter(c => c.Action === 'CheckSmsVerifyCode').length, 1);
});

test('wrong-code attempts persist, stop at five, and expiry never reaches provider', async () => {
  await phoneUser();
  const sent = await send();
  for (let i = 0; i < 5; i += 1) assert.equal((await verify(sent, { code: '000000' })).status, 400);
  assert.equal(challenge(sent).attempts, 5);
  assert.equal((await verify(sent)).status, 429);
  assert.equal(calls.filter(c => c.Action === 'CheckSmsVerifyCode').length, 5);
  challenge(sent).expires_at = new Date(Date.now() - 1);
  assert.equal((await verify(sent)).status, 401);
  assert.equal(calls.filter(c => c.Action === 'CheckSmsVerifyCode').length, 5);
});

test('SMS cooldown is canonical and resend invalidates the prior challenge', async t => {
  const now = freeze(t);
  await phoneUser();
  const first = await send();
  const limited = await post('/api/auth/phone/sms/send', { phone: '138 0013 8000' });
  assert.equal(limited.status, 429);
  assert.equal(calls.filter(c => c.Action === 'SendSmsVerifyCode').length, 1);
  t.mock.timers.setTime(now + 61000);
  const second = await send();
  assert.notEqual(second.body.challengeId, first.body.challengeId);
  assert.ok(challenge(first).consumed_at);
  assert.equal((await verify(first)).status, 401);
  assert.equal((await verify(second)).status, 200);
});

test('concurrent SMS completion issues exactly one session', async () => {
  const user = await phoneUser();
  const sent = await send();
  const results = await Promise.all([verify(sent), verify(sent)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  assert.equal(f.pool.sessions.filter(row => row.user_id === user.id).length, 1);
  assert.equal(calls.filter(c => c.Action === 'CheckSmsVerifyCode').length, 1);
});

test('provider failure consumes delivery challenge and exposes no raw provider detail', async () => {
  providerHook = fields => fields.Action === 'SendSmsVerifyCode'
    ? { Code: 'FAIL', Message: 'private provider response 13800138000' } : undefined;
  const result = await post('/api/auth/phone/sms/send', { phone: PHONE });
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result.body), /private provider|13800138000/);
  assert.ok(f.pool.emailVerificationCodes.find(row => row.purpose === 'phone_sms_login').consumed_at);
  noSession(result);
});

test('unverified local phone is a conflict, never authentication authority', async () => {
  const user = await phoneUser(PHONE, false);
  const sent = await send();
  const result = await verify(sent);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  noSession(result);
  assert.equal((await f.User.findById(user.id)).phone_verified, false);
  assert.equal(f.pool.sessions.filter(row => row.user_id === user.id).length, 0);
});

test('phone signup requires both switches and remains closed to QFLI', async () => {
  phoneTokens.set('new-1', PHONE);
  assert.equal((await post('/api/auth/phone/app/login', { accessToken: 'new-1' })).status, 403);
  await configure({ allowRegistration: true });
  f.pool.settings.push({ setting_key: 'registration_enabled', setting_value: 'false' });
  phoneTokens.set('new-2', PHONE);
  assert.equal((await post('/api/auth/phone/app/login', { accessToken: 'new-2' })).status, 403);
  f.pool.settings.find(row => row.setting_key === 'registration_enabled').setting_value = 'true';
  const app = await oauthClient(`QfLi-${crypto.randomUUID()}`);
  const grant = oauth(app);
  phoneTokens.set('new-3', PHONE);
  const blocked = await post('/api/auth/phone/app/login', { accessToken: 'new-3', ...grant.params });
  assert.equal(blocked.status, 403);
  assert.equal(await f.User.findByPhone(PHONE), null);
  assert.equal((await f.request(`/api/auth/phone/config?client_id=${app.id}`)).body.registrationEnabled, false);
  phoneTokens.set('new-4', PHONE);
  const allowed = await post('/api/auth/phone/app/login', { accessToken: 'new-4' });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  const created = await f.User.findByPhone(PHONE);
  assert.equal(created.phone_verified, true);
  assert.equal(created.email_verified, false);
  assert.equal(created.password, '');
  assert.doesNotMatch(created.username, /13800138000/);
});

test('concurrent first App logins resolve one phone account', async () => {
  await configure({ allowRegistration: true });
  phoneTokens.set('first-a', PHONE);
  phoneTokens.set('first-b', PHONE);
  const results = await Promise.all(['first-a', 'first-b'].map(accessToken => post('/api/auth/phone/app/login', { accessToken })));
  results.forEach(result => assert.equal(result.status, 200, JSON.stringify(result.body)));
  assert.equal(results[0].body.user.id, results[1].body.user.id);
  assert.equal(f.pool.users.filter(row => row.phone_e164 === PHONE).length, 1);
});

test('H5 proof uses saved context, rejects replay, and never stores provider tokens', async () => {
  const user = await phoneUser();
  const start = await post('/api/auth/phone/h5/token', { session_days: 14 });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.accessToken, 'h5-access');
  assert.equal(start.body.jwtToken, 'h5-jwt');
  const row = challenge(start);
  assert.equal(row.purpose, 'phone_h5_login');
  assert.equal(row.pending_context.phone, undefined);
  assert.doesNotMatch(JSON.stringify(row), /h5-access|h5-jwt/);
  phoneTokens.set('sp-proof', PHONE);
  const result = await post('/api/auth/phone/h5/login', { challengeId: row.id, spToken: 'sp-proof', session_days: 1 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.id, user.id);
  assert.equal(claims(result).session_days, 14);
  assert.equal((await post('/api/auth/phone/h5/login', { challengeId: row.id, spToken: 'sp-proof' })).status, 401);
  const next = await post('/api/auth/phone/h5/token', {});
  assert.equal((await post('/api/auth/phone/h5/login', { challengeId: next.body.challengeId, spToken: 'sp-proof' })).status, 429);
  assert.equal(calls.filter(c => c.Action === 'GetPhoneWithToken').length, 1);
});

test('invalid/foreign phone, duration and OAuth context fail before provider calls', async () => {
  for (const phone of ['123', '+14155550123', '0014155550123', {}, ['13800138000']]) {
    assert.equal((await post('/api/auth/phone/sms/send', { phone })).status, 400);
  }
  for (const session_days of [null, '7', 2, true]) {
    assert.equal((await post('/api/auth/phone/h5/token', { session_days })).status, 400);
  }
  assert.equal((await post('/api/auth/phone/app/login', { accessToken: 'x', client_id: 'missing',
    redirect_uri: 'https://evil.test/cb', code_challenge: 'x', code_challenge_method: 'S256' })).status, 400);
  assert.equal(calls.length, 0);
});

test('cross-origin browser requests cannot use the native exception', async () => {
  for (const route of ['h5/token', 'sms/send', 'app/login']) {
    const result = await post(`/api/auth/phone/${route}`, { accessToken: 'x', phone: PHONE }, '', { Origin: 'https://evil.test' });
    assert.equal(result.status, 403);
  }
  assert.equal(calls.length, 0);
});

test('App OAuth handoff preserves PKCE/state and redacts phone without phone scope', async () => {
  const user = await phoneUser();
  const app = await oauthClient();
  const grant = oauth(app);
  phoneTokens.set('native-proof', PHONE);
  const result = await post('/api/auth/phone/app/login', { accessToken: 'native-proof', ...grant.params });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.id, user.id);
  assert.equal(result.body.phone, null);
  assert.equal(result.body.phoneStatus, 'scope_not_granted');
  assert.equal(result.body.user.phoneE164, '');
  assert.equal(result.body.state, grant.params.state);
  assert.ok(result.body.authorization_code);
  noSession(result);
  assert.equal(f.pool.sessions.filter(row => row.user_id === user.id).length, 0);
  const wrong = await f.exchange(app, { code: result.body.authorization_code, verifier: randomSecret() });
  assert.equal(wrong.status, 400);
  const exchanged = await f.exchange(app, { code: result.body.authorization_code, verifier: grant.verifier });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal(jwt.decode(exchanged.body.id_token).nonce, grant.params.nonce);
  assert.equal((await post('/api/auth/phone/app/login', { accessToken: 'native-proof', ...grant.params })).status, 429);
});

test('email MFA preserves existing active account until SMS login completes', async () => {
  const active = await f.user();
  const prior = await f.login(active);
  const user = await phoneUser();
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  const sent = await send(PHONE, { session_days: 7 }, prior.cookie);
  const pending = await verify(sent, {}, prior.cookie);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  assert.equal(pending.body.mfa_required, true);
  assert.equal(pending.body.require_email_code, true);
  noSession(pending);
  assert.equal((await f.request('/api/profile', { cookie: prior.cookie })).body.user.id, active.id);
  const record = f.pool.emailVerificationCodes.find(row => row.purpose === 'phone_mfa');
  assert.ok(record);
  assert.equal(record.pending_context.phone.phone, PHONE);
  assert.equal((await f.request('/api/v1/auth/oauth/oidc/pending', { cookie: pending.cookie })).body.factor, 'email');
  const complete = await post('/api/v1/auth/oauth/oidc/complete', { code: f.lastCode(user.email), session_days: 14 },
    `${prior.cookie}; ${pending.cookie}`);
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  assert.equal(claims(complete).session_days, 7);
  const roster = await f.request('/api/auth/accounts', { cookie: complete.cookie });
  assert.deepEqual(new Set(roster.body.accounts.map(item => item.id)), new Set([active.id, user.id]));
  assert.equal((await post('/api/v1/auth/oauth/oidc/complete', { code: f.lastCode(user.email) }, pending.cookie)).status, 401);
});

test('Tianyi pending MFA is invalidated when its application configuration changes', async () => {
  await configureTianyi();
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  const openId = `tianyi-${crypto.randomUUID()}`;
  const target = await tianyiIdentityUser(openId);
  const active = await f.user();
  const activeLogin = await f.login(active);

  const started = await startTianyi(activeLogin.cookie);
  const callback = await finishTianyi(started, openId);
  assert.equal(callback.status, 302, JSON.stringify(callback.body));
  assert.equal(callback.headers.get('location'), '/oauth2/mfa');
  noSession(callback);
  assert.equal(f.pool.sessions.filter(row => row.user_id === target.id).length, 0);
  const pendingRecord = f.pool.emailVerificationCodes.find(row => row.purpose === 'oidc_mfa' && row.user_id === target.id);
  assert.ok(pendingRecord);
  const context = typeof pendingRecord.pending_context === 'string'
    ? JSON.parse(pendingRecord.pending_context) : pendingRecord.pending_context;
  assert.equal(context.tianyiAppId, TIANYI_APP);

  const code = f.lastCode(target.email);
  const replacement = await configureTianyi({ clientId: 'replacement-app' });
  assert.equal(replacement.body.provider.clientId, 'replacement-app');
  assert.equal(f.pool.oidcProviders.find(row => row.provider_key === 'tianyi-test')?.client_id, 'replacement-app');
  const pendingCookie = callback.cookie.match(/(?:^|;\s*)oidc_pending=([^;]+)/)?.[1];
  assert.ok(pendingCookie, 'Tianyi MFA callback must publish its pending credential');
  const pendingClaims = jwt.verify(decodeURIComponent(pendingCookie), process.env.JWT_SECRET);
  assert.equal(pendingClaims.source, 'external');
  assert.equal(pendingClaims.provider, 'tianyi-test');
  const pendingHeaders = { 'X-Oidc-Pending': decodeURIComponent(pendingCookie) };
  const pending = await f.request('/api/v1/auth/oauth/oidc/pending', { cookie: activeLogin.cookie, headers: pendingHeaders });
  assert.equal(pending.status, 401);
  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', data: { code }, cookie: activeLogin.cookie, headers: pendingHeaders
  });
  assert.equal(completed.status, 401);
  noSession(completed);
  assert.equal(pendingRecord.consumed_at, null);
  assert.equal(f.pool.sessions.filter(row => row.user_id === target.id).length, 0);
  const activeSession = f.pool.sessions.find(row => row.token === claims(activeLogin).sid);
  assert.ok(activeSession && !activeSession.revoked_at);
});

test('Tianyi MFA publishes no session until the final account transaction commits', async () => {
  await configureTianyi();
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  const openId = `tianyi-${crypto.randomUUID()}`;
  const user = await tianyiIdentityUser(openId);
  const started = await startTianyi();
  const callback = await finishTianyi(started, openId);
  assert.equal(callback.headers.get('location'), '/oauth2/mfa');
  noSession(callback);
  const parent = f.pool.emailVerificationCodes.find(row => row.purpose === 'oidc_mfa' && row.user_id === user.id);
  assert.ok(parent);
  const code = f.lastCode(user.email);

  failNextCommit();
  const failed = await post('/api/v1/auth/oauth/oidc/complete', { code }, callback.cookie);
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  noSession(failed);
  assert.equal(parent.consumed_at, null);
  assert.equal(f.pool.sessions.filter(row => row.user_id === user.id).length, 0);

  const completed = await post('/api/v1/auth/oauth/oidc/complete', { code }, callback.cookie);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(claims(completed).session_days, 7);
  assert.ok(f.pool.emailVerificationCodes.find(row => row.id === parent.id)?.consumed_at);
  assert.equal(f.pool.sessions.filter(row => row.user_id === user.id).length, 1);
});

test('native App TOTP completion retains no-cookie OAuth handoff and phone scope', async () => {
  const user = await phoneUser();
  const recovery = 'ABCD2345EFGH6789';
  await f.User.update(user.id, { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP',
    recoveryCodes: JSON.stringify([crypto.createHash('sha256').update(recovery).digest('hex')]) });
  const app = await oauthClient();
  const grant = oauth(app, 'openid phone');
  phoneTokens.set('native-mfa', PHONE);
  const pending = await post('/api/auth/phone/app/login', { accessToken: 'native-mfa', ...grant.params });
  assert.equal(pending.body.require_totp, true, JSON.stringify(pending.body));
  noSession(pending);
  const complete = await post('/api/v1/auth/oauth/oidc/complete', { code: recovery,
    pending_token: pending.body.pending_token, session_days: 14 });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  assert.equal(complete.body.phone, PHONE);
  assert.equal(complete.body.user.phoneE164, PHONE);
  assert.ok(complete.body.authorization_code);
  noSession(complete);
  assert.equal(f.pool.sessions.filter(row => row.user_id === user.id).length, 0);
});

test('config or bound-phone changes invalidate pending phone MFA', async () => {
  const user = await phoneUser();
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  const pending = await verify(await send());
  const code = f.lastCode(user.email);
  await configure({ smsSchemeName: 'changed-scheme' });
  const result = await post('/api/v1/auth/oauth/oidc/complete', { code }, pending.cookie);
  assert.equal(result.status, 401);
  noSession(result);
});

test('profile verification derives target/account/session and revokes other credentials', async () => {
  const user = await phoneUser(PHONE, false);
  const other = await f.login(user);
  const current = await f.login(user, { session_days: 7 });
  const beforeClaims = claims(current);
  const sent = await post('/api/profile/phone/sms/send', { phone: OTHER_PHONE, userId: 'forged' }, current.cookie);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(calls.find(c => c.Action === 'SendSmsVerifyCode').PhoneNumber, '13800138000');
  assert.equal(challenge(sent).user_id, user.id);
  const stolen = await post('/api/profile/phone/sms/verify', { challengeId: sent.body.challengeId, code: '246810' }, other.cookie);
  assert.equal(stolen.status, 401);
  assert.equal((await verify(sent)).status, 401, 'profile challenge cannot log in');
  const result = await post('/api/profile/phone/sms/verify', { challengeId: sent.body.challengeId, code: '246810' }, current.cookie);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.phoneVerified, true);
  assert.equal(result.body.user.phoneE164, PHONE);
  assert.equal((await f.request('/api/profile', { cookie: other.cookie })).status, 401);
  assert.equal((await f.request('/api/profile', { cookie: current.cookie })).status, 200);
  const retained = f.pool.sessions.find(row => row.token === beforeClaims.sid);
  assert.equal(new Date(retained.expires_at).getTime(), beforeClaims.exp * 1000);
});

test('phone changed while provider verifies cannot verify its replacement', async () => {
  const user = await phoneUser(PHONE, false);
  const current = await f.login(user);
  const sent = await post('/api/profile/phone/sms/send', {}, current.cookie);
  assert.equal(sent.status, 200);
  providerHook = async fields => {
    if (fields.Action === 'CheckSmsVerifyCode') await f.User.update(user.id, { phone: OTHER_PHONE });
  };
  const result = await post('/api/profile/phone/sms/verify', { challengeId: sent.body.challengeId, code: '246810' }, current.cookie);
  assert.equal(result.status, 409, JSON.stringify(result.body));
  const stored = await f.User.findById(user.id);
  assert.equal(stored.phone_e164, OTHER_PHONE);
  assert.equal(stored.phone_verified, false);
  assert.equal(challenge(sent).consumed_at, null);
});

test('failed final issuance rolls challenge consumption back; zero-row consume grants no session', async () => {
  const user = await phoneUser();
  const sent = await send();
  failNextInsert('sessions');
  const failed = await verify(sent);
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  noSession(failed);
  assert.equal(challenge(sent).consumed_at, null);
  assert.equal(f.pool.sessions.filter(row => row.user_id === user.id).length, 0);
  failNextConsume(sent.body.challengeId);
  const zero = await verify(sent);
  assert.equal(zero.status, 401, JSON.stringify(zero.body));
  noSession(zero);
  assert.equal(challenge(sent).consumed_at, null);
  assert.equal((await verify(sent)).status, 200);
});
