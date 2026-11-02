// 合规任务：登录/注册日志必须记录用户ID、登录平台、登录类型、IP、源端口、时间，
// 且 IP 不能被客户端伪造的 X-Forwarded-For / X-Real-IP 改写。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture, randomSecret } = require('./support/fixture');
const LoginLogModel = require('../models/LoginLog');
const { readRequestSource, isTrustedProxy, normalizePort } = require('../services/request-source');

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

function lastLog() {
  assert.ok(f.pool.loginLogs.length, 'expected at least one login log');
  return f.pool.loginLogs.at(-1);
}

test('successful password login records user id, platform, login type, IP, source port and time', async () => {
  const user = await f.user();
  const login = await f.login(user);
  assert.equal(login.status, 200);
  const log = lastLog();
  assert.equal(log.result, 'success');
  assert.equal(log.user_id, user.id);
  assert.equal(log.username, user.username);
  assert.equal(log.platform, 'web');
  assert.equal(log.login_type, 'password');
  assert.equal(log.ip, '127.0.0.1');
  assert.ok(Number.isInteger(log.source_port) && log.source_port > 0 && log.source_port <= 65535,
    `expected a real socket source port, got ${log.source_port}`);
  assert.ok(log.created_at instanceof Date && !Number.isNaN(log.created_at.getTime()));
});

test('registration log records the new user id, IP and source port', async () => {
  const username = `newuser${Date.now().toString().slice(-6)}`;
  const email = `${username}@example.test`;
  await f.request('/api/email-verification/send', { method: 'POST', data: { email, purpose: 'register' } });
  const result = await f.request('/oauth2/register', { method: 'POST', data: {
    username, email, password: randomSecret(), email_code: f.lastCode(email)
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const log = lastLog();
  assert.equal(log.result, 'register');
  assert.equal(log.username, username);
  assert.ok(log.user_id, 'registration log must reference the created user id');
  assert.equal(log.platform, 'web');
  assert.equal(log.login_type, 'register');
  assert.equal(log.ip, '127.0.0.1');
  assert.ok(Number.isInteger(log.source_port) && log.source_port > 0);
});

test('registration through a browser app records that client id as the platform', async () => {
  const app = await f.client();
  const username = `appuser${Date.now().toString().slice(-6)}`;
  const email = `${username}@example.test`;
  await f.request('/api/email-verification/send', { method: 'POST', data: { email, purpose: 'register' } });
  const result = await f.request('/oauth2/register', { method: 'POST', data: {
    username, email, password: randomSecret(), email_code: f.lastCode(email),
    client_id: app.id, redirect_uri: app.redirectUris[0], state: 'xyz',
    code_challenge: crypto.createHash('sha256').update(randomSecret()).digest('base64url'),
    code_challenge_method: 'S256'
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const log = lastLog();
  assert.equal(log.result, 'register');
  assert.equal(log.platform, app.id);
  assert.equal(log.login_type, 'register');
});

test('spoofed X-Forwarded-For cannot change the recorded IP while proxy trust is disabled', async () => {
  const user = await f.user();
  const login = await f.request('/oauth2/authorize', {
    method: 'POST',
    headers: {
      'X-Forwarded-For': '198.51.100.99',
      'X-Real-IP': '203.0.113.20',
      'X-Real-Port': '1234'
    },
    data: { username: user.username, password: user.clearPassword }
  });
  assert.equal(login.status, 200);
  const log = lastLog();
  assert.equal(log.ip, '127.0.0.1');
  assert.notEqual(log.source_port, 1234, 'X-Real-Port must be ignored when the peer is not a trusted proxy');
  assert.ok(Number.isInteger(log.source_port) && log.source_port > 0);
  assert.equal((await f.User.findById(user.id)).last_login_ip, '127.0.0.1');
});

test('trusted proxy X-Real-Port is accepted and untrusted X-Real-Port is not', () => {
  const trusted = readRequestSource({
    ip: '203.0.113.20',
    headers: { 'x-real-port': '54321', 'x-forwarded-for': '198.51.100.99' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 40000 }
  }, ['127.0.0.1/32']);
  assert.deepEqual(trusted, { ip: '203.0.113.20', port: 54321, proxy: true });

  const untrusted = readRequestSource({
    ip: '198.51.100.99',
    headers: { 'x-real-port': '54321' },
    socket: { remoteAddress: '198.51.100.99', remotePort: 40000 }
  }, ['127.0.0.1/32']);
  assert.deepEqual(untrusted, { ip: '198.51.100.99', port: 40000, proxy: false });

  // 非法端口被丢弃，退回 socket 端口。
  const invalid = readRequestSource({
    ip: '203.0.113.20', headers: { 'x-real-port': '70000' },
    socket: { remoteAddress: '127.0.0.1', remotePort: 40000 }
  }, ['127.0.0.1/32']);
  assert.equal(invalid.port, 40000);
  assert.equal(normalizePort('0'), null);
  assert.equal(normalizePort('65535'), 65535);
  assert.equal(normalizePort('65536'), null);
  assert.equal(normalizePort('abc'), null);
});

test('proxy CIDR matching supports IPv4, IPv6 and mapped addresses', () => {
  assert.equal(isTrustedProxy('127.0.0.1', ['127.0.0.1/32']), true);
  assert.equal(isTrustedProxy('127.0.0.5', ['127.0.0.1/32']), false);
  assert.equal(isTrustedProxy('::1', ['::1/128']), true);
  assert.equal(isTrustedProxy('::ffff:127.0.0.1', ['127.0.0.1/32']), true);
  assert.equal(isTrustedProxy('10.1.2.3', ['10.0.0.0/8']), true);
  assert.equal(isTrustedProxy('11.1.2.3', ['10.0.0.0/8']), false);
  assert.equal(isTrustedProxy('203.0.113.9', []), false);
});

test('login retention keeps records for at least 365 days', async () => {
  const model = new LoginLogModel(f.pool);
  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  await model.create({ username: 'old', ip: '127.0.0.1', result: 'success', loginType: 'password' });
  f.pool.loginLogs.at(-1).created_at = new Date(now.getTime() - 364 * day);
  await model.create({ username: 'ancient', ip: '127.0.0.1', result: 'success', loginType: 'password' });
  f.pool.loginLogs.at(-1).created_at = new Date(now.getTime() - 366 * day);

  const removed = await model.deleteExpired(now);
  assert.equal(removed, 1);
  assert.deepEqual(f.pool.loginLogs.map(row => row.username), ['old']);
  assert.equal(LoginLogModel.RETENTION_DAYS, 365);
  assert.equal(LoginLogModel.RETENTION_MS, 365 * 24 * 60 * 60 * 1000);
});

test('admin log listing exposes source port, platform, login type and user id', async () => {
  const admin = await f.user('admin');
  const login = await f.login(admin);
  const logs = await f.request('/api/admin/security/logs?limit=10', { cookie: login.cookie });
  assert.equal(logs.status, 200);
  const entry = logs.body.find(row => row.result === 'success' && row.username === admin.username);
  assert.ok(entry, 'admin listing must include the login record');
  assert.equal(entry.userId, admin.id);
  assert.equal(entry.platform, 'web');
  assert.equal(entry.loginType, 'password');
  assert.equal(entry.ip, '127.0.0.1');
  assert.ok(Number.isInteger(entry.sourcePort) && entry.sourcePort > 0);
  assert.ok(entry.createdAt);
});
