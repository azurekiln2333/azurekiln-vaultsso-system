const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./support/fixture');

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

async function edit(route, cookie, data) {
  return f.request(route, { method: 'PUT', cookie, data });
}

test('profile phone saves normalized country code, reloads, changes and unbinds without trusting verification input', async () => {
  const account = await f.user();
  let { cookie } = await f.login(account);
  let result = await edit('/api/profile', cookie, { phoneCountryCode: '0086', phoneNumber: '138-0013-8000', phoneVerified: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '+8613800138000');
  assert.equal(result.body.user.phoneVerified, false);
  assert.equal(result.body.user.phoneVerifiedAt, null);
  cookie = result.cookie;
  result = await f.request('/api/profile', { cookie });
  assert.equal(result.body.user.phoneNationalNumber, '13800138000');
  result = await edit('/api/profile', cookie, { phoneCountryCode: '+852', phoneNumber: '9123 4567' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '+85291234567');
  cookie = result.cookie;
  result = await edit('/api/profile', cookie, { phoneNumber: null });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '');
  assert.equal(result.body.user.phoneVerified, false);
  assert.equal(result.body.user.phoneVerifiedAt, null);
});

test('unchanged phone preserves verification timestamp while a real change clears it', async () => {
  const account = await f.user();
  const timestamp = '2025-02-01T12:00:00.000Z';
  await f.User.update(account.id, { phone: '+8613800138000', phoneVerified: true, phoneVerifiedAt: timestamp });
  const { cookie } = await f.login(account);
  let result = await edit('/api/profile', cookie, { phoneCountryCode: '86', phoneNumber: '138 0013 8000', phoneVerified: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerified, true);
  assert.equal(result.body.user.phoneVerifiedAt, timestamp);
  await f.User.update(account.id, { phone: '+8613800138000' });
  assert.equal((await f.User.findById(account.id)).phone_verified_at, timestamp);
  result = await edit('/api/profile', cookie, { phoneNumber: '13900139000', phoneVerified: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerified, false);
  assert.equal(result.body.user.phoneVerifiedAt, null);
});

test('profile changes require recent authentication or the correct current password including unbinding', async () => {
  const account = await f.user();
  await f.User.update(account.id, { phone: '+8613800138000', phoneVerified: true });
  const { cookie } = await f.login(account);
  f.pool.sessions[0].created_at = new Date(Date.now() - 6 * 60 * 1000);
  for (const data of [{ phoneNumber: '13900139000' }, { phoneNumber: '' }, { phoneNumber: '13900139000', currentPassword: 'incorrect' }]) {
    const result = await edit('/api/profile', cookie, data);
    assert.equal(result.status, 403);
    assert.equal(result.body.error_key, 'profile.phone.reauthentication_required');
  }
  const unchanged = await edit('/api/profile', cookie, { phone: '+8613800138000' });
  assert.equal(unchanged.status, 200);
  const changed = await edit('/api/profile', cookie, { phone: '+8613900139000', currentPassword: account.clearPassword });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.user.phoneE164, '+8613900139000');
});

test('both phone routes reject invalid or duplicate numbers without changing stored state', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  const occupied = await f.user();
  await f.User.update(occupied.id, { phone: '+8613800138000' });
  const own = await f.login(account);
  const privileged = await f.login(admin);
  for (const [route, cookie] of [['/api/profile', own.cookie], [`/api/users/${account.id}`, privileged.cookie]]) {
    for (const data of [
      { phoneNumber: '123' }, { phoneNumber: '138abc00138000' }, { phoneNumber: '138+00138000' },
      { phoneCountryCode: 'invalid', phoneNumber: '13800138000' },
      { phoneNumber: '+8613800138000123456' }
    ]) {
      const result = await edit(route, cookie, data);
      assert.equal(result.status, 400);
      assert.equal(result.body.error_key, 'validation.phone.invalid');
    }
    const result = await edit(route, cookie, { phoneCountryCode: '86', phoneNumber: '13800138000' });
    assert.equal(result.status, 409);
    assert.equal(result.body.error_key, 'validation.phone.taken');
    assert.equal((await f.User.findById(account.id)).phone_e164, null);
  }
});

test('administrator can save, preserve, change and unbind a user phone', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  const { cookie } = await f.login(admin);
  const route = `/api/users/${account.id}`;
  let result = await edit(route, cookie, { phoneCountryCode: '+1', phoneNumber: '415 555 2671', phoneVerified: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '+14155552671');
  assert.equal(result.body.user.phoneVerified, false);
  await f.User.update(account.id, { phoneVerified: true, phoneVerifiedAt: '2025-03-01T00:00:00.000Z' });
  result = await edit(route, cookie, { phoneCountryCode: '1', phoneNumber: '4155552671' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerifiedAt, '2025-03-01T00:00:00.000Z');
  result = await f.request(route, { cookie });
  assert.equal(result.body.user.phoneVerified, true);
  result = await edit(route, cookie, { phoneNumber: '4155552672' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerified, false);
  assert.equal(result.body.user.phoneVerifiedAt, null);
  result = await edit(route, cookie, { phoneNumber: '' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '');
});

test('ordinary users cannot edit another account and cannot choose a profile target', async () => {
  const account = await f.user();
  const other = await f.user();
  const { cookie } = await f.login(account);
  assert.equal((await edit(`/api/users/${other.id}`, cookie, { phoneNumber: '13800138000' })).status, 403);
  assert.equal((await edit('/api/profile', '', { phoneNumber: '13800138000' })).status, 401);
  const result = await edit('/api/profile', cookie, { id: other.id, phoneNumber: '13800138000' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.id, account.id);
  assert.equal((await f.User.findById(other.id)).phone_e164, null);
});

test('profile changes revoke old sessions and OAuth credentials while renewing the current session', async () => {
  const account = await f.user();
  const app = await f.client();
  const grant = await f.authorize(account, app, 'openid offline_access');
  const token = await f.exchange(app, grant);
  const another = await f.login(account);
  const unchanged = await edit('/api/profile', grant.cookie, { phoneNumber: '' });
  assert.equal(unchanged.status, 200);
  assert.equal((await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } })).status, 200);
  const changed = await edit('/api/profile', grant.cookie, { phoneNumber: '13800138000' });
  assert.equal(changed.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: grant.cookie })).status, 401);
  assert.equal((await f.request('/api/profile', { cookie: another.cookie })).status, 401);
  assert.equal((await f.request('/api/profile', { cookie: changed.cookie })).status, 200);
  assert.equal((await f.refresh(app, token.body.refresh_token)).status, 400);
  assert.equal((await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } })).status, 401);
});

test('administrator phone changes revoke target credentials and leave the admin signed in', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  const app = await f.client();
  const grant = await f.authorize(account, app, 'openid offline_access');
  const token = await f.exchange(app, grant);
  const privileged = await f.login(admin);
  const changed = await edit(`/api/users/${account.id}`, privileged.cookie, { phoneNumber: '13800138000' });
  assert.equal(changed.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: grant.cookie })).status, 401);
  assert.equal((await f.request('/api/profile', { cookie: privileged.cookie })).status, 200);
  assert.equal((await f.refresh(app, token.body.refresh_token)).status, 400);
  assert.equal((await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } })).status, 401);
});

test('administrator full-form self edits retain the current session and persist after reload', async () => {
  const admin = await f.user('admin');
  const otherSession = await f.login(admin);
  const current = await f.login(admin);
  const fullForm = { name: 'Edited admin', email: admin.email, role: 'admin', emailVerified: true, banned: false };
  const route = `/api/users/${admin.id}`;
  const unchanged = await edit(route, current.cookie, fullForm);
  assert.equal(unchanged.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: otherSession.cookie })).status, 200);
  const changed = await edit(route, current.cookie, { ...fullForm, phoneCountryCode: '+86', phoneNumber: '13800138000' });
  assert.equal(changed.status, 200);
  assert.equal((await f.request('/api/profile', { cookie: otherSession.cookie })).status, 401);
  const reloaded = await f.request(route, { cookie: current.cookie });
  assert.equal(reloaded.status, 200);
  assert.equal(reloaded.body.user.phoneE164, '+8613800138000');
  const emailChanged = await edit(route, current.cookie, { email: 'admin-new@example.test' });
  assert.equal(emailChanged.status, 200);
  assert.equal((await f.request(route, { cookie: current.cookie })).body.user.email, 'admin-new@example.test');
});

test('a database uniqueness race returns a conflict from both phone write routes', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  const own = await f.login(account);
  const privileged = await f.login(admin);
  const execute = f.pool.execute.bind(f.pool);
  f.pool.execute = async (sql, params) => {
    if (/^UPDATE users SET .*phone_number = \?/i.test(sql)) {
      throw Object.assign(new Error('Duplicate phone_e164'), { code: 'ER_DUP_ENTRY' });
    }
    return execute(sql, params);
  };
  try {
    for (const [route, cookie] of [['/api/profile', own.cookie], [`/api/users/${account.id}`, privileged.cookie]]) {
      const result = await edit(route, cookie, { phoneNumber: '13800138000' });
      assert.equal(result.status, 409);
      assert.equal(result.body.error, 'conflict');
    }
  } finally { f.pool.execute = execute; }
});

test('separate national numbers retain digits matching their country code in both write routes and the model', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  const own = await f.login(account);
  const privileged = await f.login(admin);
  for (const [route, cookie] of [['/api/profile', own.cookie], [`/api/users/${account.id}`, privileged.cookie]]) {
    const result = await edit(route, cookie, { phoneCountryCode: '65', phoneNumber: '65123456' });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.user.phoneCountryCode, '65');
    assert.equal(result.body.user.phoneNationalNumber, '65123456');
    assert.equal(result.body.user.phoneE164, '+6565123456');
  }
  await f.User.update(account.id, { phoneCountryCode: '20', phoneNumber: '1001234567' });
  const stored = await f.User.findById(account.id);
  assert.equal(stored.phone_country_code, '20');
  assert.equal(stored.phone_number, '1001234567');
  assert.equal(stored.phone_e164, '+201001234567');
});

test('both phone routes reject a successful SQL response when the requested phone did not persist', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  const own = await f.login(account);
  const privileged = await f.login(admin);
  const execute = f.pool.execute.bind(f.pool);
  f.pool.execute = async (sql, params) => {
    if (/^UPDATE users SET .*phone_number = \?/i.test(sql)) return [{ affectedRows: 1 }, []];
    return execute(sql, params);
  };
  try {
    for (const [route, cookie] of [['/api/profile', own.cookie], [`/api/users/${account.id}`, privileged.cookie]]) {
      const result = await edit(route, cookie, { phoneCountryCode: '86', phoneNumber: '13800138000' });
      assert.equal(result.status, 500);
      assert.equal(result.body.error_key, 'profile.phone.save_failed');
      assert.equal((await f.User.findById(account.id)).phone_e164, null);
      assert.equal((await f.request('/api/profile', { cookie })).status, 200, 'A failed write does not revoke the current session');
    }
  } finally { f.pool.execute = execute; }
});

test('phone update rejects stale generated E164 and an unbind that did not persist', async () => {
  const account = await f.user();
  await f.User.update(account.id, { phone: '+8613800138000' });
  const { cookie } = await f.login(account);
  const execute = f.pool.execute.bind(f.pool);
  f.pool.execute = async (sql, params) => {
    if (/^UPDATE users SET .*phone_number = \?/i.test(sql)) return [{ affectedRows: 1 }, []];
    return execute(sql, params);
  };
  try {
    const result = await edit('/api/profile', cookie, { phoneNumber: '' });
    assert.equal(result.status, 500);
    assert.equal(result.body.error_key, 'profile.phone.save_failed');
    assert.equal((await f.User.findById(account.id)).phone_e164, '+8613800138000');
  } finally { f.pool.execute = execute; }
  f.pool.execute = async (sql, params) => {
    const result = await execute(sql, params);
    if (/^UPDATE users SET .*phone_number = \?/i.test(sql)) {
      const record = f.pool.users.find(user => user.id === account.id);
      record.phone_e164 = '+8613800138000';
    }
    return result;
  };
  try {
    await assert.rejects(f.User.update(account.id, { phoneNumber: '13900139000', phoneCountryCode: '86' }), { code: 'PHONE_UPDATE_NOT_PERSISTED' });
  } finally { f.pool.execute = execute; }
});
