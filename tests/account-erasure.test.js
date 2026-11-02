const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createFixture, randomSecret } = require('./support/fixture');
const { isQfliClient } = require('../services/qfli-integration');
const { erasedLogUserId, accountLockKey } = require('../services/account-erasure');
const TokenModel = require('../models/Token');
const SessionModel = require('../models/Session');
const ExternalIdentityModel = require('../models/ExternalIdentity');
const EmailVerificationCodeModel = require('../models/EmailVerificationCode');
const OidcProviderModel = require('../models/OidcProvider');

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

async function erasingClient({ id = `QfLi-${crypto.randomUUID()}`, scopes = ['qfli_account_erase', 'qfli_public_profile'], active = true } = {}) {
  const secret = randomSecret();
  const client = await f.Client.create({ id, secret, name: 'Erasure caller', redirectUris: ['https://qfli.example.test/callback'], scopes, isActive: active });
  return { ...client, clearSecret: secret };
}

function credentials(client) { return { client_id: client.id, client_secret: client.clearSecret }; }
function basic(client) { return `Basic ${Buffer.from(`${client.id}:${client.clearSecret}`).toString('base64')}`; }
function erase(client, userId, extra = {}, options = {}) {
  return f.request(options.path || '/oauth2/account/erase', { method: 'POST', data: {
    ...credentials(client), user_id: userId, reason: 'user_request', ...extra
  }, ...options });
}
function expectError(result, status, error) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  assert.equal(result.body.error, error);
  assert.equal(typeof result.body.error_description, 'string');
  assert.ok(result.body.error_description.length > 0);
}
async function introspect(client, token) {
  return f.request('/oauth2/introspect', { method: 'POST', data: { ...credentials(client), token } });
}

test('isQfliClient recognises only string or client.id prefixes, case-insensitively', () => {
  for (const value of ['qfli', 'QFLI-app', { id: 'qFlIstudio' }]) assert.equal(isQfliClient(value), true);
  for (const value of [null, undefined, 1, {}, { client_id: 'qfli' }, 'other-qfli', ' qfli', { id: 2 }]) assert.equal(isQfliClient(value), false);
});

test('client authentication and authorization error matrix preserves all accounts', async () => {
  const owner = await f.user();
  const client = await erasingClient();
  const disabled = await erasingClient({ active: false });
  const other = await erasingClient({ id: 'other-application' });
  const noScope = await erasingClient({ scopes: [] });
  const cases = [
    [{ user_id: owner.id }, {}, 401, 'invalid_client'],
    [{ ...credentials(client), client_secret: 'wrong', user_id: owner.id }, {}, 401, 'invalid_client'],
    [{ ...credentials(disabled), user_id: owner.id }, {}, 403, 'access_denied'],
    [{ ...credentials(other), user_id: owner.id }, {}, 403, 'access_denied'],
    [{ ...credentials(noScope), user_id: owner.id }, {}, 403, 'insufficient_scope'],
    [{ user_id: owner.id }, { Authorization: 'Bearer arbitrary-machine-token' }, 401, 'invalid_client'],
    [{ ...credentials(client), user_id: owner.id }, { Authorization: basic(client) }, 401, 'invalid_client'],
    [{ user_id: owner.id }, { Authorization: 'Basic !!!' }, 401, 'invalid_client']
  ];
  for (const [data, headers, status, error] of cases) {
    expectError(await f.request('/oauth2/account/erase', { method: 'POST', data, headers }), status, error);
    assert.equal((await f.User.findById(owner.id)).status, 'active');
  }
  assert.equal(f.pool.loginLogs.length, 0);
});

test('request validation rejects malformed raw values, including trailing newlines and overlong fields', async () => {
  const client = await erasingClient();
  const owner = await f.user();
  const inputs = [
    { user_id: undefined }, { user_id: null }, { user_id: 1 }, { user_id: [] }, { user_id: {} },
    { user_id: '' }, { user_id: 'not-a-uuid' }, { user_id: `${owner.id}\n` }, { user_id: `${owner.id}\r` },
    { user_id: `${owner.id}\r\n` }, { user_id: ` ${owner.id}` }, { user_id: `${owner.id} ` },
    { reason: 'r'.repeat(256) }, { reason: null }, { reason: 1 }, { reason: [] },
    { request_id: 'r'.repeat(65) }, { request_id: null }, { request_id: 1 }, { request_id: {} }
  ];
  for (const input of inputs) {
    expectError(await erase(client, owner.id, input), 400, 'invalid_request');
    assert.equal((await f.User.findById(owner.id)).status, 'active');
  }
  expectError(await erase(client, crypto.randomUUID()), 404, 'user_not_found');
  assert.equal(f.pool.namedLocks.size, 0);
  assert.equal(f.pool.loginLogs.length, 0);
});

test('Basic and body credentials work without browser headers; optional fields and UUID case preserve idempotence', async () => {
  const client = await erasingClient();
  const owner = await f.user();
  const response = await fetch(`${f.baseUrl}/OAUTH2/ACCOUNT/ERASE/`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: basic(client) },
    body: JSON.stringify({ user_id: owner.id.toUpperCase() }) });
  assert.equal(response.status, 200);
  const deleted = await response.json();
  assert.deepEqual(Object.keys(deleted).sort(), ['deleted_at', 'status', 'tokens_revoked', 'user_id']);
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.user_id, owner.id);
  assert.equal(deleted.tokens_revoked, true);
  assert.equal(new Date(deleted.deleted_at).toISOString(), deleted.deleted_at);
  const repeated = await erase(client, owner.id, { reason: 'r'.repeat(255), request_id: 'q'.repeat(64) });
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body, { ...deleted, status: 'already_deleted' });
  assert.equal(f.pool.loginLogs.length, 1, 'retries do not duplicate erasure audit');
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('erasure scrubs the tombstone, all applications credentials and account data, retaining pseudonymous legal logs', async () => {
  const owner = await f.user();
  const otherUser = await f.user();
  const app = await f.client();
  const secondApp = await f.client();
  const client = await erasingClient();
  const firstGrant = await f.authorize(owner, app, 'openid profile offline_access');
  const issued = await f.exchange(app, firstGrant);
  const unspentGrant = await f.authorize(owner, secondApp, 'openid profile offline_access', firstGrant.cookie);
  const otherGrant = await f.authorize(otherUser, app, 'openid profile offline_access');
  const otherIssued = await f.exchange(app, otherGrant);
  const machineIssued = await f.request('/oauth2/token', { method: 'POST', data: { ...credentials(app), grant_type: 'client_credentials', scope: 'service.read' } });
  assert.equal(machineIssued.status, 200);
  const ids = new ExternalIdentityModel(f.pool);
  await ids.create({ userId: owner.id, provider: 'huawei', providerUserId: 'private-union', providerSecondaryId: 'private-open',
    providerUsername: owner.username, profile: { phone: '+8613800138000' } });
  await ids.create({ userId: otherUser.id, provider: 'huawei', providerUserId: 'other-union' });
  await f.User.update(owner.id, { phone: '+8613800138000', phoneVerified: true, name: 'Private name',
    description: 'Private bio', avatar: 'https://private.example.test/avatar', lastLoginIp: '192.0.2.99',
    credits: 9, totpSecret: 'encrypted-private-secret', totpEnabled: true, recoveryCodes: 'private-recovery' });
  f.pool.userAuthenticators.push({ id: crypto.randomUUID(), user_id: owner.id, secret: 'private-device' });
  const proof = new EmailVerificationCodeModel(f.pool);
  await proof.create({ userId: owner.id, email: owner.email, purpose: 'password_reset', codeHash: 'private-proof', expiresAt: new Date(Date.now() + 100000) });
  await proof.create({ email: owner.email, purpose: 'register', codeHash: 'old-mailbox-proof', expiresAt: new Date(Date.now() + 100000) });
  const fixedLog = { id: crypto.randomUUID(), username: owner.username, user_id: owner.id, ip: '198.51.100.20', source_port: 44321,
    platform: app.id, login_type: 'huawei', user_agent: 'private-device', result: 'success', detail: owner.email, created_at: new Date('2026-01-01T01:02:03Z') };
  f.pool.loginLogs.push(fixedLog,
    { ...fixedLog, id: crypto.randomUUID(), user_id: null, username: owner.email },
    { ...fixedLog, id: crypto.randomUUID(), user_id: otherUser.id, username: `admin:${otherUser.username}`, result: 'admin_action', detail: `update_user | ${owner.username} -> email,phone` },
    { ...fixedLog, id: crypto.randomUUID(), user_id: otherUser.id, username: otherUser.username, detail: 'unrelated-other-log' });
  const beforeCount = f.pool.loginLogs.length;
  const result = await erase(client, owner.id, { request_id: 'correlation-erase-1' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const tombstone = await f.User.findById(owner.id);
  assert.equal(tombstone.status, 'deleted');
  assert.match(tombstone.username, /^deleted_[a-f0-9]{32}$/);
  assert.equal(tombstone.email, `${tombstone.username}@users.invalid`);
  assert.equal(tombstone.password, '');
  for (const field of ['name', 'description', 'avatar', 'phone_country_code', 'phone_number', 'phone_e164', 'phone_verified_at', 'last_login_ip', 'totp_secret', 'recovery_codes']) assert.equal(tombstone[field], null, field);
  for (const field of ['email_verified', 'phone_verified', 'totp_enabled', 'captcha_required']) assert.equal(tombstone[field], false, field);
  assert.equal(tombstone.banned, true);
  assert.equal(tombstone.credits, 0);
  assert.equal(tombstone.totp_revision, 1);
  assert.equal(new Date(tombstone.deleted_at).toISOString(), result.body.deleted_at);
  for (const table of ['accessTokens', 'refreshTokens', 'authCodes', 'sessions', 'userIdentities', 'emailVerificationCodes', 'userAppUsage', 'userAuthenticators']) {
    assert.equal(f.pool[table].some(row => row.user_id === owner.id), false, table);
  }
  assert.equal(f.pool.emailVerificationCodes.some(row => row.email === owner.email), false);
  assert.equal(f.pool.loginLogs.length, beforeCount + 1);
  const retained = f.pool.loginLogs.find(row => row.id === fixedLog.id);
  const pseudo = erasedLogUserId(process.env.JWT_SECRET, owner.id);
  assert.equal(pseudo, crypto.createHmac('sha256', process.env.JWT_SECRET).update(`account-erasure:${owner.id}`).digest('hex').slice(0, 36));
  assert.equal(retained.username, 'deleted_user');
  assert.equal(retained.user_id, pseudo);
  assert.equal(retained.detail, '');
  assert.equal(retained.user_agent, '');
  for (const key of ['ip', 'source_port', 'platform', 'login_type']) assert.equal(retained[key], fixedLog[key], key);
  assert.equal(new Date(retained.created_at).getTime(), new Date(fixedLog.created_at).getTime());
  assert.doesNotMatch(JSON.stringify(f.pool.loginLogs), new RegExp(owner.username));
  assert.doesNotMatch(JSON.stringify(f.pool.loginLogs), new RegExp(owner.email.replaceAll('.', '\\.')));
  const audit = f.pool.loginLogs.find(row => row.result === 'admin_action' && row.user_id === pseudo);
  assert.deepEqual(JSON.parse(audit.detail), { action: 'account_erase', client_id: client.id, request_id: 'correlation-erase-1' });
  assert.equal((await introspect(app, issued.body.access_token)).body.active, false);
  assert.equal((await introspect(app, issued.body.refresh_token)).body.active, false);
  assert.equal((await f.refresh(app, issued.body.refresh_token)).status, 400);
  assert.equal((await f.exchange(secondApp, unspentGrant)).status, 400);
  assert.equal((await f.request('/api/profile', { cookie: firstGrant.cookie })).status, 401);
  assert.equal((await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${issued.body.access_token}` } })).status, 401);
  assert.equal((await f.request(`/oauth2/public-profile/${owner.id}`, { headers: { Authorization: basic(client) } })).status, 404);
  assert.ok((await f.login(owner)).status >= 400);
  assert.equal((await f.request('/oauth2/authorize', { method: 'POST', data: { username: owner.username, discover_account: true } })).status, 404);
  assert.equal((await introspect(app, otherIssued.body.access_token)).body.active, true);
  assert.equal((await introspect(app, machineIssued.body.access_token)).body.active, true);
  assert.equal((await f.refresh(app, otherIssued.body.refresh_token)).status, 200);
  assert.equal((await f.request('/api/profile', { cookie: otherGrant.cookie })).status, 200);
  assert.equal((await ids.findByUserId(otherUser.id)).length, 1);
  assert.ok(f.pool.loginLogs.some(row => row.detail === 'unrelated-other-log'));
});

test('audit retains maximum-length client and request IDs without leaking caller secrets', async () => {
  const owner = await f.user();
  const client = await erasingClient({ id: `qfli${'x'.repeat(251)}` });
  assert.equal(client.id.length, 255);
  const requestId = 'r'.repeat(64);
  assert.equal((await erase(client, owner.id, { request_id: requestId })).status, 200);
  const detail = JSON.parse(f.pool.loginLogs[0].detail);
  assert.equal(detail.client_id, client.id);
  assert.equal(detail.request_id, requestId);
  assert.ok(f.pool.loginLogs[0].detail.length > 255);
  assert.ok(!JSON.stringify(f.pool.loginLogs).includes(client.clearSecret));
});

test('legacy truncated administrator target details and literal wildcard usernames are anonymized without changing audit evidence', async () => {
  const admin = await f.user('admin');
  const client = await erasingClient();
  for (const username of ['legacy%_!'.repeat(32).slice(0, 255), 'legacy%_!owner']) {
    // Imports accepted these identifiers before registration acquired its ASCII-only policy.
    const owner = await f.User.create({ username, email: `legacy-${crypto.randomUUID()}@example.test`, password: '' });
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    const details = [
      `revoke_sessions | ${username}`, `reset_totp | ${username}`,
      `delete_user | ${username}`, `update_user | ${username} -> email,phone`
    ];
    const logs = details.map(detail => ({
      id: crypto.randomUUID(), username: `admin:${admin.username}`, user_id: admin.id,
      ip: '198.51.100.42', source_port: 32123, platform: 'web', login_type: 'password',
      user_agent: 'Administrator browser', result: 'admin_action',
      detail: detail.slice(0, 255), created_at: createdAt
    }));
    const differentTarget = username.replace('%', 'wild').replace('_', 'x');
    const unrelated = { ...logs[0], id: crypto.randomUUID(), detail: `update_user | ${differentTarget} -> name`.slice(0, 255) };
    f.pool.loginLogs.push(...logs, unrelated);

    assert.equal((await erase(client, owner.id)).status, 200);
    for (const original of logs) {
      const retained = f.pool.loginLogs.find(row => row.id === original.id);
      assert.equal(retained.detail, '', `retained target identifier in ${original.detail}`);
      for (const field of ['username', 'user_id', 'ip', 'source_port', 'platform', 'login_type', 'user_agent', 'result']) {
        assert.equal(retained[field], original[field], field);
      }
      assert.equal(new Date(retained.created_at).getTime(), createdAt.getTime());
    }
    assert.equal(f.pool.loginLogs.find(row => row.id === unrelated.id).detail, unrelated.detail,
      'wildcard characters in the erased username must not match a different target');
  }
});

test('explicit foreign browser origins and every accepted route spelling remain guarded', async () => {
  const owner = await f.user();
  const client = await erasingClient();
  for (const path of ['/oauth2/account/erase', '/OAUTH2/ACCOUNT/ERASE/']) {
    expectError(await erase(client, owner.id, {}, { path, headers: { Origin: 'https://evil.example.test' } }), 403, 'access_denied');
    expectError(await erase(client, owner.id, {}, { path, headers: { Origin: 'https://evil.example.test', 'Sec-Fetch-Site': 'same-origin' } }), 403, 'access_denied');
  }
  assert.equal((await f.User.findById(owner.id)).status, 'active');
});

test('per-client and independent transport limits return rate_limited with retry metadata', async () => {
  const owner = await f.user();
  const client = await erasingClient();
  for (let i = 0; i < 30; i++) expectError(await erase(client, crypto.randomUUID()), 404, 'user_not_found');
  const limited = await erase(client, owner.id, {}, { path: '/OAUTH2/ACCOUNT/ERASE/' });
  expectError(limited, 429, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const otherClient = await erasingClient();
  assert.equal((await erase(otherClient, owner.id)).status, 200);
  f.pool.rateLimits.length = 0;
  for (let i = 0; i < 120; i++) {
    expectError(await f.request(i % 2 ? '/OAUTH2/ACCOUNT/ERASE/' : '/oauth2/account/erase', { method: 'POST', data: {} }), 401, 'invalid_client');
  }
  expectError(await erase(otherClient, crypto.randomUUID()), 429, 'rate_limited');
  assert.equal((await f.login(await f.user())).status, 200, 'erasure transport throttle must not consume the shared auth bucket');
});

test('concurrent erasure returns 409 including differently cased UUIDs and releases its lifecycle lock', async () => {
  const owner = await f.user();
  const client = await erasingClient();
  const original = f.pool.getConnection.bind(f.pool);
  let entered, release;
  const parked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let armed = true;
  f.pool.getConnection = async () => {
    const connection = await original();
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql, params) => {
      if (armed && sql.startsWith('SELECT * FROM users WHERE id = ? FOR UPDATE')) {
        armed = false; entered(); await gate;
      }
      return execute(sql, params);
    };
    return connection;
  };
  let first;
  try {
    first = erase(client, owner.id);
    await parked;
    expectError(await erase(client, owner.id.toUpperCase()), 409, 'conflict');
    release();
    assert.equal((await first).status, 200);
    assert.equal((await erase(client, owner.id)).body.status, 'already_deleted');
    assert.equal(f.pool.namedLocks.size, 0);
  } finally { release(); if (first) await first; f.pool.getConnection = original; }
});

test('audit failure rolls back all deletion, logs and tombstone; a retry succeeds', async () => {
  const owner = await f.user();
  const client = await erasingClient();
  const app = await f.client();
  const grant = await f.authorize(owner, app, 'openid offline_access');
  const issued = await f.exchange(app, grant);
  const before = JSON.stringify({ users: f.pool.users, logs: f.pool.loginLogs, access: f.pool.accessTokens, refresh: f.pool.refreshTokens, sessions: f.pool.sessions, usage: f.pool.userAppUsage });
  const original = f.pool.getConnection.bind(f.pool);
  f.pool.getConnection = async () => {
    const connection = await original();
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql, params) => {
      if (/INSERT INTO login_logs/.test(sql) && String(params[6]).includes('account_erase')) throw new Error('private underlying failure');
      return execute(sql, params);
    };
    return connection;
  };
  try {
    const result = await erase(client, owner.id);
    expectError(result, 500, 'server_error');
    assert.ok(!JSON.stringify(result.body).includes('private underlying'));
  } finally { f.pool.getConnection = original; }
  assert.equal(JSON.stringify({ users: f.pool.users, logs: f.pool.loginLogs, access: f.pool.accessTokens, refresh: f.pool.refreshTokens, sessions: f.pool.sessions, usage: f.pool.userAppUsage }), before);
  assert.equal(f.pool.namedLocks.size, 0);
  assert.equal((await introspect(app, issued.body.access_token)).body.active, true);
  assert.equal((await erase(client, owner.id)).body.status, 'deleted');
});

test('boundary database failures and malformed JSON use the frozen erasure errors', async () => {
  const original = f.pool.execute.bind(f.pool);
  f.pool.execute = async () => { throw new Error('private SQL failure'); };
  try { expectError(await f.request('/oauth2/account/erase', { method: 'POST', data: {} }), 500, 'server_error'); }
  finally { f.pool.execute = original; }
  const response = await fetch(`${f.baseUrl}/oauth2/account/erase`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_request');
});

test('stale model writes cannot restore personal data, identities, proofs or credentials', async () => {
  const owner = await f.user();
  const client = await erasingClient();
  await erase(client, owner.id);
  const before = await f.User.findById(owner.id);
  await f.User.update(owner.id, { name: 'should not return', email: owner.email, banned: false });
  await f.User.updatePassword(owner.id, 'New-password-123!');
  await f.User.delete(owner.id);
  assert.equal(await f.User.bindPhoneIfEmpty(owner.id, { countryCode: '86', nationalNumber: '13800138000' }, true), false);
  assert.equal(await f.User.setInitialPassword(owner.id, before.email, 'New-password-123!'), false);
  assert.deepEqual(await f.User.findById(owner.id), before);
  const insertions = [
    () => new ExternalIdentityModel(f.pool).create({ userId: owner.id, provider: 'huawei', providerUserId: 'stale' }),
    () => new EmailVerificationCodeModel(f.pool).create({ userId: owner.id, email: owner.email, purpose: 'login', codeHash: 'stale', expiresAt: new Date() }),
    () => new SessionModel(f.pool).create({ userId: owner.id, token: 'stale', expiresAt: new Date() }),
    () => new TokenModel(f.pool).createAccessToken({ userId: owner.id, token: 'stale', clientId: client.id, scopes: [], expiresAt: new Date() }),
    () => new TokenModel(f.pool).createRefreshToken({ userId: owner.id, token: 'stale', clientId: client.id, scopes: [], expiresAt: new Date() }),
    () => new TokenModel(f.pool).createAuthCode({ userId: owner.id, clientId: client.id, scopes: [], expiresAt: new Date() })
  ];
  for (const insertion of insertions) await assert.rejects(insertion(), error => error.code === 'ACCOUNT_DELETED');
  for (const table of ['userIdentities', 'emailVerificationCodes', 'sessions', 'accessTokens', 'refreshTokens', 'authCodes']) assert.equal(f.pool[table].length, 0, table);
  assert.equal(f.pool.namedLocks.size, 0);
});

for (const scenario of ['code exchange', 'refresh', 'password login', 'failed login log']) {
  test(`erasure wins a deterministic race before ${scenario} acquires the lifecycle lock`, { timeout: 20000 }, async () => {
    const owner = await f.user();
    const client = await erasingClient();
    let start;
    if (scenario === 'code exchange' || scenario === 'refresh') {
      const app = await f.client();
      const grant = await f.authorize(owner, app, 'openid offline_access');
      if (scenario === 'code exchange') start = () => f.exchange(app, grant);
      else {
        const issued = await f.exchange(app, grant);
        start = () => f.refresh(app, issued.body.refresh_token);
      }
    } else start = () => f.login(owner, scenario === 'failed login log' ? { password: 'incorrect-password' } : {});
    const original = f.pool.getConnection.bind(f.pool);
    let entered, release;
    const parked = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    let armed = true;
    f.pool.getConnection = async () => {
      const connection = await original();
      const query = connection.query.bind(connection);
      connection.query = async (sql, params) => {
        if (armed && /GET_LOCK/.test(sql)) { armed = false; entered(); await gate; }
        return query(sql, params);
      };
      return connection;
    };
    let pending;
    try {
      pending = start();
      await parked;
      assert.equal((await erase(client, owner.id)).status, 200);
      release();
      const resumed = await pending;
      assert.equal(resumed.status, scenario === 'code exchange' || scenario === 'refresh' ? 400 : 401, JSON.stringify(resumed.body));
      assert.ok(!resumed.cookie.includes('session='));
      for (const table of ['accessTokens', 'refreshTokens', 'authCodes', 'sessions', 'userAppUsage']) {
        assert.equal(f.pool[table].some(row => row.user_id === owner.id), false, table);
      }
      assert.ok(!JSON.stringify(f.pool.loginLogs).includes(owner.username));
      if (scenario === 'failed login log') {
        const log = f.pool.loginLogs.find(row => row.result === 'invalid_credentials');
        assert.equal(log.username, 'deleted_user');
        assert.equal(log.user_id, erasedLogUserId(process.env.JWT_SECRET, owner.id));
      }
      assert.equal(f.pool.namedLocks.size, 0);
    } finally { release(); if (pending) await pending; f.pool.getConnection = original; }
  });
}

test('an administrator audit delayed beyond target erasure retains action and keyed target without restoring identifiers', { timeout: 20000 }, async () => {
  const admin = await f.user('admin');
  const owner = await f.user();
  const authenticated = await f.login(admin);
  const client = await erasingClient();
  const original = f.pool.getConnection.bind(f.pool);
  let entered, release;
  const parked = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let armed = true;
  f.pool.getConnection = async () => {
    const connection = await original();
    const query = connection.query.bind(connection);
    connection.query = async (sql, params) => {
      if (armed && /GET_LOCK/.test(sql)) { armed = false; entered(); await gate; }
      return query(sql, params);
    };
    return connection;
  };
  let update;
  try {
    update = f.request(`/api/users/${owner.id}`, { method: 'PUT', cookie: authenticated.cookie, data: { name: 'Changed before erasure' } });
    await parked;
    assert.equal((await erase(client, owner.id)).status, 200);
    release();
    assert.equal((await update).status, 200);
    const log = f.pool.loginLogs.find(row => row.detail?.startsWith('update_user |'));
    assert.equal(log.user_id, admin.id);
    assert.equal(log.username, `admin:${admin.username}`);
    assert.ok(log.detail.split(' -> ')[1].split(',').includes('name'));
    assert.ok(log.detail.includes(`target:${erasedLogUserId(process.env.JWT_SECRET, owner.id)}`));
    assert.ok(!JSON.stringify(f.pool.loginLogs).includes(owner.username));
    assert.ok(!JSON.stringify(f.pool.loginLogs).includes(owner.email));
  } finally { release(); if (update) await update; f.pool.getConnection = original; }
});

test('the same verified Huawei identity and phone can register a fresh account after erasure', async () => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Consume the isolated code-exchange request. */ }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ resultCode: 0, openId: 'repeat-open', unionId: 'repeat-union',
      phoneNumber: '+8613800138000', purePhoneNumber: '13800138000', phoneCountryCode: '86', phoneNumberValid: 1, displayName: 'Huawei test' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await new OidcProviderModel(f.pool).upsert({ providerKey: 'erase-huawei', providerType: 'huawei_quicklogin', providerName: 'Isolated Huawei', enabled: true,
      clientId: 'isolated-huawei', clientSecret: randomSecret(), tokenUrl: `http://127.0.0.1:${upstream.address().port}/code`, scopes: ['openid'], validateIdToken: false, pkceEnabled: false });
    const login = async () => {
      const initial = await f.request('/api/v1/auth/oauth/huawei/quick-login', { method: 'POST', data: { provider: 'erase-huawei', authorizationCode: randomSecret() } });
      if (!initial.body.binding_required) return initial;
      return f.request('/api/v1/auth/oauth/huawei/skip', { method: 'POST', data: { provider: 'erase-huawei', binding_token: initial.body.binding_token } });
    };
    const first = await login();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const erased = await erase(await erasingClient(), first.body.user.id);
    assert.equal(erased.status, 200);
    const second = await login();
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.user.id, first.body.user.id);
    assert.equal(second.body.user.phoneE164, '+8613800138000');
    assert.equal(f.pool.userIdentities.length, 1);
    assert.equal(f.pool.userIdentities[0].user_id, second.body.user.id);
  } finally { await new Promise(resolve => upstream.close(resolve)); }
});
