const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./support/fixture');
const { totpCode: code } = require('./support/totp-code');

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

const base = '/api/account/totp/authenticators';
function stage(cookie, name, proof) {
  return f.request(`${base}/setup`, { method: 'POST', cookie, data: { name, code: proof } });
}
function confirm(cookie, pending, otp) {
  return f.request(`${base}/${pending.id}/confirm`, { method: 'POST', cookie, data: { code: otp } });
}
function remove(cookie, id, proof) {
  return f.request(`${base}/${id}`, { method: 'DELETE', cookie, data: { code: proof } });
}
async function enroll(cookie, name, proof) {
  const pending = await stage(cookie, name, proof);
  assert.equal(pending.status, 200, JSON.stringify(pending.body));
  const enrolled = await confirm(cookie, pending.body, code(pending.body.secret, -1));
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  return { ...pending.body, ...enrolled.body };
}

test('two independent devices coexist, both authenticate, replay is per device and active secrets never leak', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  const first = await enroll(cookie, 'Phone');
  assert.equal(first.recoveryCodes.length, 10);
  assert.equal((await f.User.findById(user.id)).totp_secret, null);
  const hashes = (await f.User.findById(user.id)).recovery_codes;
  const second = await enroll(cookie, 'Tablet', code(first.secret));
  assert.notEqual(first.secret, second.secret);
  assert.equal(second.recoveryCodes, undefined);
  assert.equal((await f.User.findById(user.id)).recovery_codes, hashes);
  const listed = await f.request('/api/account/totp', { cookie });
  assert.equal(listed.body.authenticators.length, 2);
  assert.ok(listed.body.authenticators.every(device => !('secret' in device) && !('security_state' in device)));
  assert.ok(f.pool.userAuthenticators.every(device => device.secret.startsWith('enc:v1:')));
  assert.equal((await f.login(user, { totp_code: code(first.secret, 1) })).status, 200);
  assert.equal((await f.login(user, { totp_code: code(first.secret, 1) })).status, 400);
  assert.equal((await f.login(user, { totp_code: code(second.secret) })).status, 200);
  assert.equal((await f.login(user, { totp_code: code(second.secret) })).status, 400);
  const pending = await f.login(user);
  assert.equal(pending.body.require_totp, true);
  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', cookie: pending.cookie, data: { code: code(second.secret, 1) }
  });
  assert.equal(completed.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: completed.cookie })).status, 200);
});

test('an existing legacy device stays usable alongside its newly enrolled companion', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  const legacySecret = 'JBSWY3DPEHPK3PXP';
  await f.User.update(user.id, { totpSecret: legacySecret, totpEnabled: true });
  const second = await enroll(cookie, 'Other phone', code(legacySecret, -1));
  assert.equal(second.authenticators[0].id, 'legacy');
  assert.equal(second.authenticators[0].createdAt, null);
  assert.equal((await f.User.findById(user.id)).totp_secret, legacySecret);
  assert.equal((await f.login(user, { totp_code: code(legacySecret) })).status, 200);
  assert.equal((await f.login(user, { totp_code: code(second.secret) })).status, 200);
});

test('native verification probe and direct OAuth code login require a table-backed authenticator', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  const device = await enroll(cookie, 'Native phone');
  const app = await f.client();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const oauth = { client_id: app.id, redirect_uri: app.redirectUris[0], response_type: 'code', scope: 'openid',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
  const sessionCount = f.pool.sessions.length;
  const probe = await f.login(user, { ...oauth, check_verification: true });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.factor, 'totp');
  assert.equal(f.pool.sessions.length, sessionCount);
  assert.equal(f.pool.authCodes.length, 0);
  const login = await f.login(user, { ...oauth, totp_code: code(device.secret) });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.ok(login.body.redirect);
  const authorizationCode = new URL(login.body.redirect).searchParams.get('code');
  assert.equal((await f.exchange(app, { code: authorizationCode, verifier })).status, 200);
});

test('setup validates names, existing factors and recent first-enrollment sign-in', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  for (const name of ['', ' '.repeat(3), 'a'.repeat(65)]) assert.equal((await stage(cookie, name)).status, 400);
  f.pool.sessions[0].created_at = new Date(Date.now() - 6 * 60000);
  assert.equal((await stage(cookie, 'Phone')).status, 403);
  f.pool.sessions[0].created_at = new Date();
  const first = await enroll(cookie, 'Phone');
  assert.equal((await stage(cookie, 'Tablet', 'wrong')).status, 400);
  assert.equal((await stage(cookie, 'Tablet')).status, 400);
  const pending = await stage(cookie, 'Tablet', first.recoveryCodes[0]);
  assert.equal(pending.status, 200);
  assert.equal((await stage(cookie, 'Again', first.recoveryCodes[0])).status, 400);
  assert.equal((await f.request('/api/account/totp', { cookie })).body.recoveryCodesRemaining, 9);
});

test('pending expiry, attempt exhaustion, cancellation and owner/session checks preserve active devices', async () => {
  const user = await f.user();
  const other = await f.user();
  const { cookie } = await f.login(user);
  const otherCookie = (await f.login(other)).cookie;
  const first = await enroll(cookie, 'Phone');
  const pending = await stage(cookie, 'Tablet', first.recoveryCodes[0]);
  assert.equal((await confirm(otherCookie, pending.body, code(pending.body.secret))).status, 400);
  assert.equal((await remove(otherCookie, pending.body.id)).status, 404);
  const secondSession = await f.login(user, { totp_code: code(first.secret) });
  assert.equal((await confirm(secondSession.cookie, pending.body, code(pending.body.secret))).status, 400);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await confirm(cookie, pending.body, 'wrong')).status, 400);
  assert.equal((await confirm(cookie, pending.body, code(pending.body.secret))).status, 429);
  assert.equal((await remove(cookie, pending.body.id)).status, 200);
  assert.equal((await confirm(cookie, pending.body, code(pending.body.secret))).status, 400);
  const expired = await stage(cookie, 'Expired', first.recoveryCodes[1]);
  f.pool.userAuthenticators.find(row => row.id === expired.body.id).expires_at = new Date(Date.now() - 1);
  assert.equal((await confirm(cookie, expired.body, code(expired.body.secret))).status, 400);
  assert.equal((await f.request('/api/account/totp', { cookie })).body.authenticators.length, 1);
  assert.equal((await f.login(user, { totp_code: code(expired.body.secret) })).status, 400);
  assert.equal((await f.login(user, { totp_code: code(first.secret, 1) })).status, 200);
});

test('individual removal invalidates pending logins/setup, retains the other device and current session, last removal disables MFA', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  const first = await enroll(cookie, 'Phone');
  const second = await enroll(cookie, 'Tablet', first.recoveryCodes[0]);
  const pendingLogin = await f.login(user);
  const pendingDevice = await stage(cookie, 'Third', first.recoveryCodes[1]);
  const siblingSession = (await f.login(user, { totp_code: code(second.secret) })).cookie;
  f.pool.accessTokens.push({ id: 'access', user_id: user.id });
  f.pool.refreshTokens.push({ id: 'refresh', user_id: user.id });
  f.pool.authCodes.push({ code: 'grant', user_id: user.id });
  const result = await remove(cookie, first.id, first.recoveryCodes[2]);
  assert.equal(result.status, 200);
  assert.equal(result.body.totpEnabled, true);
  assert.deepEqual(result.body.authenticators.map(device => device.id), [second.id]);
  assert.equal((await f.request('/api/profile', { cookie })).status, 200);
  assert.equal((await f.request('/api/profile', { cookie: siblingSession })).status, 401);
  assert.equal(f.pool.accessTokens.length + f.pool.refreshTokens.length + f.pool.authCodes.length, 0);
  assert.equal((await confirm(cookie, pendingDevice.body, code(pendingDevice.body.secret))).status, 400);
  assert.equal((await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', cookie: pendingLogin.cookie, data: { code: first.recoveryCodes[3] }
  })).status, 401);
  assert.equal((await f.login(user, { totp_code: code(first.secret) })).status, 400);
  assert.equal((await f.login(user, { totp_code: code(second.secret, 1) })).status, 200);
  const last = await remove(cookie, second.id, first.recoveryCodes[4]);
  assert.equal(last.status, 200);
  assert.equal(last.body.totpEnabled, false);
  assert.equal(last.body.recoveryCodesRemaining, 0);
  assert.deepEqual(last.body.authenticators, []);
  assert.equal((await f.login(user)).status, 200);
});

test('legacy disable and administrator reset clear all devices and concurrently confirming cannot resurrect them', async () => {
  const user = await f.user();
  const admin = await f.user('admin');
  const adminCookie = (await f.login(admin)).cookie;
  const { cookie } = await f.login(user);
  const first = await enroll(cookie, 'Phone');
  await enroll(cookie, 'Tablet', first.recoveryCodes[0]);
  const pending = await stage(cookie, 'Third', first.recoveryCodes[1]);
  const results = await Promise.all([
    confirm(cookie, pending.body, code(pending.body.secret)),
    f.request(`/api/users/${user.id}/totp/reset`, { method: 'POST', cookie: adminCookie })
  ]);
  assert.equal(results[1].status, 200);
  assert.equal((await f.User.findById(user.id)).totp_enabled, false);
  assert.equal(f.pool.userAuthenticators.length, 0);
  const newCookie = (await f.login(user)).cookie;
  const fresh = await enroll(newCookie, 'Fresh');
  await enroll(newCookie, 'Fresh second', fresh.recoveryCodes[0]);
  const disabled = await f.request('/api/account/totp/disable', { method: 'POST', cookie: newCookie, data: { code: fresh.recoveryCodes[1] } });
  assert.equal(disabled.status, 200);
  assert.equal(f.pool.userAuthenticators.length, 0);
  assert.equal((await f.User.findById(user.id)).totp_secret, null);
});

test('transaction failures roll back activation and preserve the existing credential set', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  const first = await enroll(cookie, 'Phone');
  const pending = await stage(cookie, 'Tablet', first.recoveryCodes[0]);
  const original = f.pool.getConnection;
  f.pool.getConnection = async function () {
    const connection = await original.call(this);
    const execute = connection.execute;
    connection.execute = function (sql, params) {
      if (sql.includes('UPDATE users SET totp_revision')) throw new Error('Injected credential revision failure');
      return execute.call(this, sql, params);
    };
    return connection;
  };
  try { assert.equal((await confirm(cookie, pending.body, code(pending.body.secret))).status, 500); }
  finally { f.pool.getConnection = original; }
  assert.equal((await f.request('/api/account/totp', { cookie })).body.authenticators.length, 1);
  assert.equal(f.pool.userAuthenticators.find(row => row.id === pending.body.id).activated_at, null);
  assert.equal((await confirm(cookie, pending.body, code(pending.body.secret))).status, 200);
});

test('legacy setup/enable retains bounded pending proof and can coexist with later additions', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  const pending = await f.request('/api/account/totp/setup', { method: 'POST', cookie });
  assert.equal(pending.status, 200);
  const enabled = await f.request('/api/account/totp/enable', { method: 'POST', cookie, data: { code: code(pending.body.secret, -1) } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.authenticators[0].id, 'legacy');
  assert.equal((await f.login(user, { totp_code: code(pending.body.secret) })).status, 200);
  const second = await enroll(cookie, 'Tablet', enabled.body.recoveryCodes[0]);
  assert.equal(second.authenticators.length, 2);
});

test('only one concurrent confirmation succeeds, and confirmation invalidates older MFA requests', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  const first = await enroll(cookie, 'Phone');
  const pendingLogin = await f.login(user);
  const pending = await stage(cookie, 'Tablet', first.recoveryCodes[0]);
  const results = await Promise.all([
    confirm(cookie, pending.body, code(pending.body.secret)),
    confirm(cookie, pending.body, code(pending.body.secret))
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
  assert.equal((await f.request('/api/account/totp', { cookie })).body.authenticators.length, 2);
  assert.equal((await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', cookie: pendingLogin.cookie, data: { code: first.recoveryCodes[1] }
  })).status, 401);
});

test('account security changes reject staged credentials and scoped API requests reject other accounts', async () => {
  const user = await f.user();
  const other = await f.user();
  const { cookie } = await f.login(user);
  const otherCookie = (await f.login(other)).cookie;
  const device = await enroll(cookie, 'Phone');
  const pending = await stage(cookie, 'Tablet', device.recoveryCodes[0]);
  await f.User.update(user.id, { email: 'changed@example.test' });
  assert.equal((await confirm(cookie, pending.body, code(pending.body.secret))).status, 400);
  assert.equal((await remove(otherCookie, device.id, device.recoveryCodes[1])).status, 404);
  assert.equal((await f.request('/api/account/totp', { cookie: otherCookie })).body.authenticators.length, 0);
  assert.equal((await f.request('/api/account/totp')).status, 401);
  assert.equal((await stage(undefined, 'Unauthorized')).status, 401);
});

test('recovery regeneration accepts any active device and administrator self reset retains the current session', async () => {
  const admin = await f.user('admin');
  const { cookie } = await f.login(admin);
  const first = await enroll(cookie, 'Phone');
  const second = await enroll(cookie, 'Tablet', first.recoveryCodes[0]);
  const pending = await stage(cookie, 'Third', first.recoveryCodes[1]);
  const regenerated = await f.request('/api/account/totp/recovery-codes', {
    method: 'POST', cookie, data: { code: code(second.secret) }
  });
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.body.recoveryCodes.length, 10);
  assert.equal((await stage(cookie, 'Third', first.recoveryCodes[2])).status, 400);
  assert.equal((await confirm(cookie, pending.body, code(pending.body.secret))).status, 400);
  const reset = await f.request(`/api/users/${admin.id}/totp/reset`, { method: 'POST', cookie });
  assert.equal(reset.status, 200);
  assert.equal((await f.request('/api/profile', { cookie })).status, 200);
  assert.equal((await f.request('/api/account/totp', { cookie })).body.authenticators.length, 0);
});

test('removal between factor verification and final issuance cannot mint a session or native authorization code', async () => {
  for (const native of [false, true]) {
    f.reset();
    const user = await f.user();
    const { cookie } = await f.login(user);
    const device = await enroll(cookie, 'Phone');
    let entered;
    const atVerifiedFactor = new Promise(resolve => { entered = resolve; });
    let unblock;
    const release = new Promise(resolve => { unblock = resolve; });
    const original = f.pool.execute;
    const rateKey = crypto.createHash('sha256').update(`totp:${user.id}`).digest('hex');
    let armed = true;
    f.pool.execute = async function (sql, params) {
      if (armed && sql === 'DELETE FROM rate_limits WHERE rate_key = ?' && params[0] === rateKey) {
        armed = false;
        entered();
        await release;
      }
      return original.call(this, sql, params);
    };
    let oauth = {};
    if (native) {
      const app = await f.client();
      oauth = { client_id: app.id, redirect_uri: app.redirectUris[0], response_type: 'code', scope: 'openid',
        code_challenge: crypto.randomBytes(32).toString('base64url'), code_challenge_method: 'S256' };
    }
    const login = f.login(user, { ...oauth, totp_code: code(device.secret) });
    try {
      await atVerifiedFactor;
      assert.equal((await remove(cookie, device.id, device.recoveryCodes[0])).status, 200);
      unblock();
      const result = await login;
      assert.equal(result.status, 401);
      assert.equal(result.body.error_key, 'auth.mfa.expired');
      assert.doesNotMatch(result.cookie, /session=/);
      assert.equal(f.pool.authCodes.length, 0);
      assert.equal(f.pool.sessions.filter(row => !row.revoked_at).length, 1);
    } finally {
      unblock();
      await login;
      f.pool.execute = original;
    }
  }
});

test('reset after final MFA validation is rejected before pending consumption and session issuance', async () => {
  const user = await f.user();
  const admin = await f.user('admin');
  const adminCookie = (await f.login(admin)).cookie;
  const { cookie } = await f.login(user);
  const device = await enroll(cookie, 'Phone');
  const pending = await f.login(user);
  const original = f.pool.execute;
  let userReads = 0;
  let entered;
  const atFinalValidation = new Promise(resolve => { entered = resolve; });
  let unblock;
  const release = new Promise(resolve => { unblock = resolve; });
  f.pool.execute = async function (sql, params) {
    if (sql === 'SELECT * FROM users WHERE id = ?' && params[0] === user.id && ++userReads === 2) {
      const result = await original.call(this, sql, params);
      entered();
      await release;
      return result;
    }
    return original.call(this, sql, params);
  };
  const completion = f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', cookie: pending.cookie, data: { code: code(device.secret) }
  });
  try {
    await atFinalValidation;
    assert.equal((await f.request(`/api/users/${user.id}/totp/reset`, { method: 'POST', cookie: adminCookie })).status, 200);
    unblock();
    const result = await completion;
    assert.ok([400, 401].includes(result.status));
    assert.doesNotMatch(result.cookie, /session=/);
    assert.equal(f.pool.sessions.filter(row => row.user_id === user.id && !row.revoked_at).length, 0);
  } finally {
    unblock();
    await completion;
    f.pool.execute = original;
  }
});

test('lifecycle and final issuance callbacks use the held database connection throughout', async () => {
  const user = await f.user();
  const { cookie } = await f.login(user);
  const originalExecute = f.pool.execute;
  const originalConnection = f.pool.getConnection;
  let inTransaction = false;
  f.pool.execute = function (sql, params) {
    assert.equal(inTransaction, false, `Unexpected pool query while holding a transaction: ${sql}`);
    return originalExecute.call(this, sql, params);
  };
  f.pool.getConnection = async function () {
    const connection = await originalConnection.call(this);
    const begin = connection.beginTransaction;
    const commit = connection.commit;
    const rollback = connection.rollback;
    connection.beginTransaction = async function () { await begin.call(this); inTransaction = true; };
    connection.commit = async function () { try { return await commit.call(this); } finally { inTransaction = false; } };
    connection.rollback = async function () { try { return await rollback.call(this); } finally { inTransaction = false; } };
    return connection;
  };
  try {
    const first = await enroll(cookie, 'Phone');
    const second = await enroll(cookie, 'Tablet', first.recoveryCodes[0]);
    assert.equal((await f.request('/api/account/totp/recovery-codes', {
      method: 'POST', cookie, data: { code: code(second.secret) }
    })).status, 200);
    assert.equal((await f.login(user, { totp_code: code(first.secret) })).status, 200);
    const pending = await f.login(user);
    assert.equal((await f.request('/api/v1/auth/oauth/oidc/complete', {
      method: 'POST', cookie: pending.cookie, data: { code: code(first.secret, 1) }
    })).status, 200);
    assert.equal((await remove(cookie, second.id, code(second.secret, 1))).status, 200);
  } finally {
    f.pool.execute = originalExecute;
    f.pool.getConnection = originalConnection;
  }
});
