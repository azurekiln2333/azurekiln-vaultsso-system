const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, randomSecret } = require('./support/fixture');
const { readRuntimeConfig } = require('../config/runtime');

// Select the production localhost proxy policy before server.js reads configuration.
delete process.env.TRUST_PROXY;
let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

test('runtime trusts only localhost by default and accepts explicit disabled/custom policies', () => {
  const env = { NODE_ENV: 'test', JWT_SECRET: randomSecret(), PUBLIC_BASE_URL: 'http://localhost' };
  assert.deepEqual(readRuntimeConfig(env).trustedProxies, ['127.0.0.1/32', '::1/128']);
  assert.deepEqual(readRuntimeConfig({ ...env, TRUST_PROXY: '' }).trustedProxies, []);
  assert.deepEqual(readRuntimeConfig({ ...env, TRUST_PROXY: '192.0.2.10/32' }).trustedProxies, ['192.0.2.10/32']);
});

test('localhost Nginx forwarding records real IP and ignores spoofed earlier hops', async () => {
  const user = await f.user();
  const login = await f.request('/oauth2/authorize', { method: 'POST', headers: {
    'X-Forwarded-For': '198.51.100.99, 203.0.113.20', 'X-Real-IP': '198.51.100.88'
  }, data: { username: user.username, password: user.clearPassword } });
  assert.equal(login.status, 200);
  assert.equal((await f.User.findById(user.id)).last_login_ip, '203.0.113.20');
  assert.equal(f.pool.sessions[0].ip_address, '203.0.113.20');
});

test('direct localhost login without forwarded headers still records the socket address', async () => {
  const user = await f.user();
  assert.equal((await f.login(user)).status, 200);
  assert.equal((await f.User.findById(user.id)).last_login_ip, '127.0.0.1');
});
