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
// TOTP codes are window-based. Keep a multi-step assertion inside one 30s window so replay
// behaviour cannot flip when the boundary rolls over mid-test.
async function alignTotpWindow(minRemainingMs = 20000) {
  const remaining = 30000 - (Date.now() % 30000);
  if (remaining < minRemainingMs) await new Promise(resolve => setTimeout(resolve, remaining + 50));
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
  await alignTotpWindow();
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

test('removal between factor verification and final issuance cannot mint a session or native authorization code', { timeout: 30000 }, async () => {
  for (const native of [false, true]) {
    f.reset();
    const user = await f.user();
    const { cookie } = await f.login(user);
    const device = await enroll(cookie, 'Phone');
    let entered;
    const atVerifiedFactor = new Promise(resolve => { entered = resolve; });
    let unblock;
    const release = new Promise(resolve => { unblock = resolve; });
    // Park *before* account-lock acquisition. Parking inside the transaction would make the removal
    // wait on a lock the login already holds, so the removal would land after issuance and the
    // login would (correctly) succeed; that is not the race this test is about.
    const originalGetConnection = f.pool.getConnection;
    let armed = true;
    f.pool.getConnection = async function () {
      const connection = await originalGetConnection.call(this);
      const originalQuery = connection.query.bind(connection);
      connection.query = async function (sql, params) {
        if (armed && /GET_LOCK/i.test(String(sql))) {
          armed = false;
          entered();
          await release;
        }
        return originalQuery(sql, params);
      };
      return connection;
    };
    let oauth = {};
    if (native) {
      const app = await f.client();
      oauth = { client_id: app.id, redirect_uri: app.redirectUris[0], response_type: 'code', scope: 'openid',
        code_challenge: crypto.randomBytes(32).toString('base64url'), code_challenge_method: 'S256' };
    }
    const login = f.login(user, { ...oauth, totp_code: code(device.secret) });
    try {
      await Promise.race([
        atVerifiedFactor,
        new Promise((_, reject) => setTimeout(() => reject(new Error('login never reached the pre-lock boundary')), 10000))
      ]);
      assert.equal((await remove(cookie, device.id, device.recoveryCodes[0])).status, 200);
      unblock();
      const result = await login;
      // The stale snapshot is taken before the account lock is acquired, so the login must be
      // rejected by the security-state check with the exact frozen contract key.
      assert.equal(result.status, 401, JSON.stringify(result.body));
      assert.equal(result.body.error_key, 'auth.mfa.expired', JSON.stringify(result.body));
      assert.doesNotMatch(result.cookie, /session=/);
      assert.equal(f.pool.authCodes.length, 0);
      assert.equal(f.pool.sessions.filter(row => !row.revoked_at).length, 1,
        'only the enrollment session may remain usable');
    } finally {
      armed = false;
      unblock();
      await login;
      f.pool.getConnection = originalGetConnection;
    }
  }
});

test('reset landing before the final MFA transaction denies any credential', { timeout: 30000 }, async () => {
  const user = await f.user();
  const admin = await f.user('admin');
  const adminCookie = (await f.login(admin)).cookie;
  const { cookie } = await f.login(user);
  const device = await enroll(cookie, 'Phone');
  const pending = await f.login(user);

  // Deterministic hook *before* account-lock acquisition. The completion parks immediately before
  // it takes the authenticator account lock, so the concurrent reset always wins without ever
  // waiting on a lock the completion holds. (The previous hook waited for a second pool-level user
  // read that the transaction-scoped validation no longer performs, so it never fired.)
  const originalGetConnection = f.pool.getConnection;
  let entered;
  const atLock = new Promise(resolve => { entered = resolve; });
  let unblock;
  const release = new Promise(resolve => { unblock = resolve; });
  let armed = true;
  f.pool.getConnection = async function () {
    const connection = await originalGetConnection.call(this);
    const originalQuery = connection.query.bind(connection);
    connection.query = async function (sql, params) {
      if (armed && typeof sql === 'string' && /GET_LOCK/i.test(sql)) {
        armed = false;
        entered();
        await release;
      }
      return originalQuery(sql, params);
    };
    return connection;
  };

  const completion = f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', cookie: pending.cookie, data: { code: code(device.secret) }
  });
  try {
    // Bounded: fail loudly instead of hanging if the hook point ever moves again.
    await Promise.race([
      atLock,
      new Promise((_, reject) => setTimeout(() => reject(new Error('completion never reached the account lock')), 10000))
    ]);
    assert.equal((await f.request(`/api/users/${user.id}/totp/reset`, { method: 'POST', cookie: adminCookie })).status, 200);
    unblock();
    const result = await completion;
    assert.ok([400, 401].includes(result.status), `a stale MFA snapshot must not complete: ${JSON.stringify(result.body)}`);
    assert.doesNotMatch(result.cookie, /session=/);
    assert.equal(f.pool.sessions.filter(row => row.user_id === user.id && !row.revoked_at).length, 0,
      'no usable credential may survive a reset that landed before final issuance');
  } finally {
    armed = false;
    unblock();
    await completion;
    f.pool.getConnection = originalGetConnection;
  }
});

test('a reset after a completed MFA login revokes the credential it issued', { timeout: 30000 }, async () => {
  const user = await f.user();
  const admin = await f.user('admin');
  const adminCookie = (await f.login(admin)).cookie;
  const { cookie } = await f.login(user);
  const device = await enroll(cookie, 'Phone');
  const pending = await f.login(user);

  const done = await f.request('/api/v1/auth/oauth/oidc/complete', {
    method: 'POST', cookie: pending.cookie, data: { code: code(device.secret) }
  });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await f.request('/api/profile', { cookie: done.cookie })).status, 200);

  assert.equal((await f.request(`/api/users/${user.id}/totp/reset`, { method: 'POST', cookie: adminCookie })).status, 200);
  assert.equal((await f.request('/api/profile', { cookie: done.cookie })).status, 401,
    'a reset must revoke the credential issued by the preceding login');
});

// Bounded poll: always terminates, and cannot keep spinning after the test gives up.
async function pollUntil(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Race a deferred signal against a bounded timeout without leaving a polling loop alive.
function bounded(promise, message, timeoutMs = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
  ]);
}

test('a concurrent reset serialises behind the completion lock and then revokes its credential', { timeout: 30000 }, async () => {
  const user = await f.user();
  const admin = await f.user('admin');
  const adminCookie = (await f.login(admin)).cookie;
  const { cookie } = await f.login(user);
  const device = await enroll(cookie, 'Phone');
  const pending = await f.login(user);

  // Park the completion at its final Session INSERT: at that moment it holds the authenticator
  // account lock and its transaction is still open. This proves real lock serialisation, unlike
  // the sequential test which only proves ordering.
  const originalGetConnection = f.pool.getConnection;
  let parkedConnection = null;
  let armed = true;
  let releaseCompletion;
  const completionGate = new Promise(resolve => { releaseCompletion = resolve; });
  let signalCompletionInsert;
  const atCompletionInsert = new Promise(resolve => { signalCompletionInsert = resolve; });

  f.pool.getConnection = async function () {
    const connection = await originalGetConnection.call(this);
    const originalExecute = connection.execute.bind(connection);
    connection.execute = async function (sql, params) {
      if (armed && /INSERT\s+INTO\s+sessions/i.test(String(sql))) {
        armed = false;
        parkedConnection = connection;
        signalCompletionInsert();
        await completionGate;
      }
      return originalExecute(sql, params);
    };
    return connection;
  };

  // True only once a connection is actually queued on a named lock held by someone else.
  const resetQueuedInWaiters = () => [...f.pool.namedLocks.values()].some(lock => lock.waiters.length > 0);

  let completion = null;
  let reset = null;
  let resetSettled = false;
  try {
    completion = f.request('/api/v1/auth/oauth/oidc/complete', {
      method: 'POST', cookie: pending.cookie, data: { code: code(device.secret) }
    });
    // Deferred signal resolved by the hook itself: no polling loop survives a timeout.
    await bounded(atCompletionInsert, 'completion never reached its final session insert');
    assert.equal(parkedConnection !== null, true, 'the completion must be parked holding the account lock');

    reset = f.request(`/api/users/${user.id}/totp/reset`, { method: 'POST', cookie: adminCookie })
      .finally(() => { resetSettled = true; });
    // The reset connection must actually be queued in namedLocks.waiters, and the request must not
    // have settled, before the completion is allowed to release the lock.
    await pollUntil(resetQueuedInWaiters, 'the reset never queued behind the held account lock');
    assert.equal(resetSettled, false, 'the reset must still be blocked while the completion holds the lock');
    assert.equal(f.pool.userAuthenticators.length, 1,
      'the reset must not complete while the completion holds the account lock');

    releaseCompletion();
    const done = await completion;
    completion = null;
    assert.equal(done.status, 200, JSON.stringify(done.body));
    // Proving issuance from the response avoids racing the now-unblocked reset, which may revoke
    // the session before an HTTP probe could observe it.
    assert.match(done.cookie, /session=/, 'the completion must have issued a session credential');

    const resetDone = await reset;
    reset = null;
    assert.equal(resetDone.status, 200, JSON.stringify(resetDone.body));

    // The reset landed after issuance, so it must revoke the credential that was just minted.
    assert.equal(f.pool.userAuthenticators.length, 0, 'the reset must remove the authenticators');
    assert.equal((await f.request('/api/profile', { cookie: done.cookie })).status, 401,
      'the reset must revoke the newly issued credential');
    assert.equal(f.pool.sessions.filter(row => row.user_id === user.id && !row.revoked_at).length, 0,
      'no usable stale credential may remain');
  } finally {
    armed = false;
    releaseCompletion();
    f.pool.getConnection = originalGetConnection;
    // Settle every tracked request so no gate is left holding a connection.
    if (completion) await completion.catch(() => {});
    if (reset) await reset.catch(() => {});
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
