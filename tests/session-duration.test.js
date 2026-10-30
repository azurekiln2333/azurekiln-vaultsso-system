const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createFixture, randomSecret } = require('./support/fixture');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

function token(result) {
  const value = result.cookie.match(/(?:^|;\s*)session=([^;]+)/);
  assert.ok(value, JSON.stringify(result.body));
  return jwt.verify(decodeURIComponent(value[1]), process.env.JWT_SECRET);
}

function assertDuration(result, days, deadline) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const claims = token(result);
  assert.equal(claims.session_days, days);
  assert.equal(claims.exp, claims.session_deadline);
  if (deadline !== undefined) assert.equal(claims.exp * 1000, deadline);
  const row = f.pool.sessions.find(item => item.token === claims.sid);
  assert.ok(row);
  assert.equal(new Date(row.expires_at).getTime(), claims.exp * 1000);
  const cookie = result.headers.getSetCookie().find(value => value.startsWith('session='));
  assert.equal(new Date(cookie.match(/Expires=([^;]+)/)[1]).getTime(), claims.exp * 1000);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  return claims;
}

function freeze(t) {
  const now = Math.floor(Date.now() / 1000) * 1000 + 123;
  t.mock.timers.enable({ apis: ['Date'], now });
  t.after(() => t.mock.timers.reset());
  return now;
}

for (const days of [1, 7, 14]) {
  test(`${days}-day login shares one fixed JWT/row/cookie deadline after idle hours and activity`, async t => {
    const now = freeze(t);
    const user = await f.user();
    const login = await f.login(user, { session_days: days });
    const deadline = Math.floor(now / 1000) * 1000 + days * DAY;
    const claims = assertDuration(login, days, deadline);
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('session='));
    assert.equal(Number(cookie.match(/Max-Age=(\d+)/)[1]), Math.floor((deadline - now) / 1000));
    for (const at of [now + 2 * HOUR, now + 13 * HOUR, deadline - 1000]) {
      t.mock.timers.setTime(at);
      const profile = await f.request('/api/profile', { cookie: login.cookie });
      assert.equal(profile.status, 200);
      assert.doesNotMatch(profile.cookie, /(?:^|;\s*)session=/, 'activity must not renew a fixed session');
      assert.equal(new Date(f.pool.sessions.find(row => row.token === claims.sid).expires_at).getTime(), deadline);
    }
    t.mock.timers.setTime(deadline);
    assert.equal((await f.request('/api/profile', { cookie: login.cookie })).status, 401);
    t.mock.timers.setTime(deadline + DAY);
    assert.equal((await f.request('/api/profile', { cookie: login.cookie })).status, 401);
    assert.equal(f.pool.sessions.length, 1, 'expiration cannot create a replacement');
  });
}

test('omitted duration defaults to one day and exact form strings select the supported days', async t => {
  const now = freeze(t);
  const user = await f.user();
  assertDuration(await f.login(user), 1, Math.floor(now / 1000) * 1000 + DAY);
  for (const days of [1, 7, 14]) {
    const result = await f.request('/oauth2/authorize', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: user.username, password: user.clearPassword, session_days: String(days) }) });
    assertDuration(result, days);
  }
});

test('invalid durations and duplicate form/query fields fail readably before a session or pending challenge', async () => {
  const user = await f.user();
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  for (const value of [null, false, true, 0, 2, -1, 30, 1.5, '7', '01', '7.0', ' 7', '7 ', '', [], [7], {}, 'Infinity']) {
    const result = await f.login(user, { session_days: value });
    assert.equal(result.status, 400, JSON.stringify(value));
    assert.equal(result.body.error_key, 'auth.session.invalid_duration');
    assert.ok(result.body.error_description);
  }
  const duplicate = await f.request('/oauth2/authorize', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams([['username', user.username], ['password', user.clearPassword], ['session_days', '1'], ['session_days', '14']]) });
  assert.equal(duplicate.status, 400);
  const duplicateQuery = await f.request('/api/v1/auth/oauth/oidc/login?session_days=1&session_days=14');
  assert.equal(duplicateQuery.status, 400);
  assert.equal(duplicateQuery.body.error_key, 'auth.session.invalid_duration');
  assert.equal(f.pool.sessions.length, 0);
  assert.equal(f.pool.emailVerificationCodes.length, 0);
  assert.equal(f.mails.length, 0);
});

test('signed JWT and durable row expiry are each authoritative and malformed policy claims fail closed', async t => {
  const now = freeze(t);
  const user = await f.user();
  const login = await f.login(user, { session_days: 14 });
  const claims = token(login);
  const sign = patch => `session=${jwt.sign({ ...claims, ...patch }, process.env.JWT_SECRET, { algorithm: 'HS256' })}`;
  for (const patch of [
    { session_days: '14' }, { session_days: 2 }, { session_days: null },
    { session_deadline: null }, { session_deadline: String(claims.exp) },
    { session_deadline: claims.exp + 1 }
  ]) assert.equal((await f.request('/api/profile', { cookie: sign(patch) })).status, 401);
  const shortDeadline = Math.floor(now / 1000) + 60;
  const shortJwt = sign({ session_deadline: shortDeadline, exp: shortDeadline });
  t.mock.timers.setTime(shortDeadline * 1000);
  assert.equal((await f.request('/api/profile', { cookie: shortJwt })).status, 401);
  assert.equal((await f.request('/api/profile', { cookie: login.cookie })).status, 200);
  f.pool.sessions[0].expires_at = new Date(Date.now());
  assert.equal((await f.request('/api/profile', { cookie: login.cookie })).status, 401);
});

test('14-day sessions still obey logout, other-session revocation, password reset and bans immediately', async () => {
  const user = await f.user();
  const first = await f.login(user, { session_days: 14 });
  const second = await f.login(user, { session_days: 14 });
  assert.equal((await f.request('/api/account/sessions/revoke-others', { method: 'POST', cookie: second.cookie })).status, 200);
  assert.equal((await f.request('/api/profile', { cookie: first.cookie })).status, 401);
  assert.equal((await f.request('/api/profile', { cookie: second.cookie })).status, 200);
  await f.request('/oauth2/logout', { cookie: second.cookie });
  assert.equal((await f.request('/api/profile', { cookie: second.cookie })).status, 401);
  const banned = await f.login(user, { session_days: 14 });
  await f.User.update(user.id, { banned: true });
  assert.equal((await f.request('/api/profile', { cookie: banned.cookie })).status, 401);
  await f.User.update(user.id, { banned: false });
  const reset = await f.login(user, { session_days: 14 });
  await f.request('/api/email-verification/send', { method: 'POST', data: { email: user.email, purpose: 'password_reset' } });
  const password = randomSecret();
  const success = await f.request('/api/password-reset', { method: 'POST', data: {
    email: user.email, email_code: f.lastCode(user.email), password, confirm_password: password
  } });
  assert.equal(success.status, 200, JSON.stringify(success.body));
  assert.equal((await f.request('/api/profile', { cookie: reset.cookie })).status, 401);
});

test('profile phone, password and email replacements retain the original 7-day deadline', async t => {
  const now = freeze(t);
  const user = await f.user();
  let currentPassword = user.clearPassword;
  let current = await f.login(user, { session_days: 7 });
  const original = assertDuration(current, 7);
  const deadline = original.exp * 1000;
  t.mock.timers.setTime(now + 2 * HOUR);
  const stale = await f.request('/api/profile', { method: 'PUT', cookie: current.cookie,
    data: { phoneCountryCode: '+86', phoneNumber: '13800138000' } });
  assert.equal(stale.status, 403, 'a long login duration does not extend recent-authentication permission');
  const phone = await f.request('/api/profile', { method: 'PUT', cookie: current.cookie,
    data: { phoneCountryCode: '+86', phoneNumber: '13800138000', currentPassword, session_days: 14 } });
  assertDuration(phone, 7, deadline);
  assert.equal((await f.request('/api/profile', { cookie: current.cookie })).status, 401);
  current = phone;
  const nextPassword = randomSecret();
  const changed = await f.request('/api/profile', { method: 'PUT', cookie: current.cookie,
    data: { currentPassword, newPassword: nextPassword, session_days: 14 } });
  assertDuration(changed, 7, deadline);
  current = changed;
  currentPassword = nextPassword;
  const email = `changed-${crypto.randomUUID()}@example.test`;
  const send = await f.request('/api/profile', { method: 'PUT', cookie: current.cookie, data: { email, currentPassword } });
  assert.equal(send.body.require_email_code, true);
  const verified = await f.request('/api/profile', { method: 'PUT', cookie: current.cookie,
    data: { email, currentPassword, email_code: f.lastCode(email), session_days: 14 } });
  assertDuration(verified, 7, deadline);
  t.mock.timers.setTime(deadline);
  assert.equal((await f.request('/api/profile', { cookie: verified.cookie })).status, 401);
});

test('legacy renewal and repeated credential replacement retain the original absolute cap', async t => {
  const now = Math.floor(freeze(t) / 1000) * 1000;
  t.mock.timers.setTime(now);
  const user = await f.user();
  await f.login(user);
  const row = f.pool.sessions[0];
  row.created_at = new Date(now - 11 * HOUR);
  row.expires_at = new Date(now + 45 * 60000);
  const cap = now + HOUR;
  let current = { cookie: `session=${jwt.sign({ sub: user.id, sid: row.token, type: 'session',
    iss: process.env.PUBLIC_BASE_URL, aud: process.env.PUBLIC_BASE_URL,
    iat: now / 1000, exp: (now + 45 * 60000) / 1000 }, process.env.JWT_SECRET)}` };
  t.mock.timers.setTime(now + 5 * 60000);
  current = await f.request('/api/profile', { method: 'PUT', cookie: current.cookie,
    data: { phoneNumber: '13800138000', currentPassword: user.clearPassword, session_days: 14 } });
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.equal(token(current).session_days, undefined);
  assert.equal(token(current).session_deadline * 1000, cap);
  assert.equal(token(current).exp * 1000, now + 45 * 60000, 'replacement retains the remaining window');
  t.mock.timers.setTime(now + 36 * 60000);
  current = await f.request('/api/profile', { cookie: current.cookie });
  assert.equal(current.status, 200);
  assert.equal(token(current).exp * 1000, cap);
  assert.equal(token(current).session_deadline * 1000, cap);
  t.mock.timers.setTime(now + 40 * 60000);
  current = await f.request('/api/profile', { method: 'PUT', cookie: current.cookie,
    data: { phoneNumber: '13900139000', currentPassword: user.clearPassword } });
  assert.equal(current.status, 200);
  assert.equal(token(current).session_deadline * 1000, cap);
  assert.equal(token(current).exp * 1000, cap);
  t.mock.timers.setTime(cap);
  assert.equal((await f.request('/api/profile', { cookie: current.cookie })).status, 401);
});

test('email and authenticator pending choices ignore completion overrides and start after final verification', async t => {
  const now = freeze(t);
  const emailUser = await f.user();
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  const pending = await f.login(emailUser, { session_days: 7 });
  const proof = jwt.decode(pending.body.pending_token);
  assert.equal(proof.exp - proof.iat, 300);
  assert.equal(f.pool.emailVerificationCodes.find(row => row.id === proof.jti).pending_context.sessionDays, 7);
  assert.equal(f.pool.sessions.length, 0);
  t.mock.timers.setTime(now + 2 * 60000);
  const completed = await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: pending.cookie,
    data: { code: f.lastCode(emailUser.email), session_days: 14 } });
  assertDuration(completed, 7, Math.floor(Date.now() / 1000) * 1000 + 7 * DAY);
  f.pool.settings.length = 0;
  const totpUser = await f.user();
  const recovery = 'ABCD2345EFGH6789';
  await f.User.update(totpUser.id, { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP',
    recoveryCodes: JSON.stringify([crypto.createHash('sha256').update(recovery).digest('hex')]) });
  const totpPending = await f.login(totpUser, { session_days: 1 });
  const totpCompleted = await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: totpPending.cookie,
    data: { code: recovery, session_days: 14 } });
  assertDuration(totpCompleted, 1);
});

test('old pending contexts default to one day while a present invalid saved duration fails closed', async () => {
  const user = await f.user();
  f.pool.settings.push({ setting_key: 'login_email_code', setting_value: 'true' });
  const pending = await f.login(user, { session_days: 7 });
  const parent = f.pool.emailVerificationCodes.find(row => row.id === jwt.decode(pending.body.pending_token).jti);
  parent.pending_context.sessionDays = null;
  let completed = await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: pending.cookie,
    data: { code: f.lastCode(user.email), session_days: 14 } });
  assert.equal(completed.status, 401);
  assert.equal(f.pool.sessions.length, 0);
  delete parent.pending_context.sessionDays;
  completed = await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: pending.cookie,
    data: { code: f.lastCode(user.email), session_days: 14 } });
  assertDuration(completed, 1);
});

test('new browser duration leaves OAuth access, refresh and verification-code TTLs independent', async t => {
  freeze(t);
  const user = await f.user();
  const login = await f.login(user, { session_days: 14 });
  const client = await f.client();
  const grant = await f.authorize(user, client, 'openid offline_access', login.cookie);
  const exchanged = await f.exchange(client, grant);
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal(exchanged.body.expires_in, 3600);
  const access = jwt.decode(exchanged.body.access_token);
  const refresh = jwt.decode(exchanged.body.refresh_token);
  assert.equal(access.exp - access.iat, 3600);
  assert.equal(refresh.exp - refresh.iat, 7 * DAY / 1000);
  await f.request('/api/email-verification/send', { method: 'POST', data: { email: user.email, purpose: 'password_reset' } });
  const code = f.pool.emailVerificationCodes.find(row => row.purpose === 'password_reset');
  assert.equal(new Date(code.expires_at).getTime() - new Date(code.created_at).getTime(), 10 * 60000);
});

for (const mode of ['verify', 'bind', 'totp', 'direct']) {
  test(`${mode} mailbox continuation retains the initial duration through every verification stage`, async t => {
    const now = freeze(t);
    const user = await f.user();
    const recovery = 'ABCD2345EFGH6789';
    await f.User.update(user.id, { emailVerified: false,
      ...(mode === 'bind' ? { email: `unbound-${crypto.randomUUID()}@users.invalid` } : {}),
      ...(['totp', 'direct'].includes(mode) ? { totpEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP',
        recoveryCodes: JSON.stringify([crypto.createHash('sha256').update(recovery).digest('hex')]) } : {})
    });
    let pending = await f.login(user, { session_days: 7, ...(mode === 'direct' ? { totp_code: recovery } : {}) });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    if (mode === 'totp') {
      assert.equal(pending.body.require_totp, true);
      t.mock.timers.setTime(now + 60000);
      pending = await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: pending.cookie,
        data: { code: recovery, session_days: 14 } });
      assert.equal(pending.body.next_step, true, JSON.stringify(pending.body));
    }
    const claims = jwt.decode(pending.body.pending_token);
    const parent = f.pool.emailVerificationCodes.find(row => row.id === claims.jti);
    assert.equal(parent.pending_context.sessionDays, 7);
    assert.ok(new Date(parent.expires_at).getTime() <= now + 5 * 60000, 'successor preserves original proof expiry');
    assert.equal(f.pool.sessions.length, 0);
    const email = mode === 'bind' ? `bound-${crypto.randomUUID()}@example.test` : user.email;
    const sent = await f.request('/api/v1/auth/oauth/oidc/email/send', { method: 'POST', cookie: pending.cookie,
      data: { expected_mail_version: 0, ...(mode === 'bind' ? { email } : {}), session_days: 14 } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    t.mock.timers.setTime(now + 2 * 60000);
    const completed = await f.request('/api/v1/auth/oauth/oidc/complete', { method: 'POST', cookie: pending.cookie,
      data: { expected_mail_version: 1, code: f.lastCode(email), session_days: 14 } });
    assertDuration(completed, 7, Math.floor(Date.now() / 1000) * 1000 + 7 * DAY);
  });
}
