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
  // 未提交 phoneVerified 时，绑定新号码不得自动带出验证状态。
  let result = await edit(route, cookie, { phoneCountryCode: '+1', phoneNumber: '415 555 2671' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '+14155552671');
  assert.equal(result.body.user.phoneVerified, false);
  assert.equal(result.body.user.phoneVerifiedAt, null);
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

test('administrator phone verification checkbox persists checking, unchecking and reloads the actual value', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  const { cookie } = await f.login(admin);
  const route = `/api/users/${account.id}`;
  assert.equal((await f.request(route, { cookie })).body.user.phoneVerified, false, 'A new account starts unverified');

  // 勾选可验证本次提交的新号码，并写入新的验证时间。
  let result = await edit(route, cookie, { phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.phoneE164, '+8613800138000');
  assert.equal(result.body.user.phoneVerified, true);
  const firstVerifiedAt = result.body.user.phoneVerifiedAt;
  assert.ok(firstVerifiedAt, 'Verifying a number records a timestamp');
  let reloaded = await f.request(route, { cookie });
  assert.equal(reloaded.body.user.phoneVerified, true, 'Reload returns the saved verification');
  assert.equal(reloaded.body.user.phoneVerifiedAt, firstVerifiedAt);

  // 重新提交同一个已验证号码：保留原验证时间。
  result = await edit(route, cookie, { phoneCountryCode: '+86', phoneNumber: '138 0013 8000', phoneVerified: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerified, true);
  assert.equal(result.body.user.phoneVerifiedAt, firstVerifiedAt, 'Unchanged verified number keeps its timestamp');

  // 取消勾选：清除验证与时间。
  result = await edit(route, cookie, { phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerified, false);
  assert.equal(result.body.user.phoneVerifiedAt, null);
  reloaded = await f.request(route, { cookie });
  assert.equal(reloaded.body.user.phoneVerified, false, 'Unchecking persists after reload');

  // 重新勾选，然后换号（不勾选）：旧验证状态不得跟随新号码。
  result = await edit(route, cookie, { phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true });
  assert.equal(result.body.user.phoneVerified, true);
  result = await edit(route, cookie, { phoneCountryCode: '86', phoneNumber: '13900139000' });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '+8613900139000');
  assert.equal(result.body.user.phoneVerified, false, 'A changed number drops the previous verification');
  assert.equal(result.body.user.phoneVerifiedAt, null);
  assert.notEqual(result.body.user.phoneVerifiedAt, firstVerifiedAt);
});

test('administrator can verify a bound number without resubmitting it and unchecking clears the timestamp', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  await f.User.update(account.id, { phoneCountryCode: '86', phoneNumber: '13800138000' });
  const { cookie } = await f.login(admin);
  const route = `/api/users/${account.id}`;
  let result = await edit(route, cookie, { phoneVerified: true });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.phoneVerified, true);
  const verifiedAt = result.body.user.phoneVerifiedAt;
  assert.ok(verifiedAt);
  // 同一个号码再次勾选保留时间戳。
  result = await edit(route, cookie, { phoneVerified: true });
  assert.equal(result.body.user.phoneVerified, true);
  assert.equal(result.body.user.phoneVerifiedAt, verifiedAt);
  // 未勾选也不得丢掉已保存的验证状态。
  result = await edit(route, cookie, { phoneVerified: true, name: 'Verified Name' });
  assert.equal(result.body.user.phoneVerified, true);
  result = await edit(route, cookie, { phoneVerified: false });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerified, false);
  assert.equal(result.body.user.phoneVerifiedAt, null);
});

for (const [description, data] of [
  ['with the original phone fields', { phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true }],
  ['with only the verification flag', { phoneVerified: true }]
]) {
  test(`administrator stale phone verification is rejected ${description}`, async () => {
    const admin = await f.user('admin');
    const account = await f.user();
    await f.User.update(account.id, { phoneCountryCode: '86', phoneNumber: '13800138000' });
    const app = await f.client();
    const grant = await f.authorize(account, app, 'openid offline_access');
    const token = await f.exchange(app, grant);
    const privileged = await f.login(admin);
    const execute = f.pool.execute.bind(f.pool);
    let interleaved = false;
    f.pool.execute = async (sql, params) => {
      if (!interleaved && /^UPDATE users SET [\s\S]*\bphone_verified\s*=/i.test(sql)
        && params.includes(account.id)) {
        interleaved = true;
        // A different request commits a new, unverified phone after this
        // administrator's validation/read, immediately before the write.
        await execute(
          'UPDATE users SET phone_country_code = ?, phone_number = ?, phone_verified = ?, phone_verified_at = ? WHERE id = ?',
          ['86', '13900139000', false, null, account.id]
        );
      }
      return execute(sql, params);
    };
    let result;
    try {
      result = await edit(`/api/users/${account.id}`, privileged.cookie, data);
    } finally {
      f.pool.execute = execute;
    }
    assert.equal(interleaved, true, 'The competing phone change reached the verification write');
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, 'conflict');
    assert.ok(result.body.error_description, 'A stale verification is rejected readably');
    const stored = await f.User.findById(account.id);
    assert.equal(stored.phone_e164, '+8613900139000', 'The competing phone change is preserved');
    assert.equal(stored.phone_verified, false, 'A stale check cannot verify a different phone');
    assert.equal(stored.phone_verified_at, null);
    assert.equal((await f.request('/api/profile', { cookie: grant.cookie })).status, 200, 'Rejected verification does not revoke the target session');
    assert.equal((await f.request('/api/profile', { cookie: privileged.cookie })).status, 200, 'The acting administrator stays signed in');
    assert.equal((await f.request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.body.access_token}` } })).status, 200);
    assert.equal((await f.refresh(app, token.body.refresh_token)).status, 200, 'Rejected verification does not revoke OAuth credentials');
  });
}

test('an account without a phone cannot be marked phone verified', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  const { cookie } = await f.login(admin);
  const route = `/api/users/${account.id}`;

  // 仅有验证标记、没有任何号码：必须可读地拒绝，且不写入任何验证状态。
  let result = await edit(route, cookie, { phoneVerified: true });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error_key, 'validation.phone.invalid');
  assert.ok(result.body.error_description, 'The failure is readable');
  assert.equal((await f.User.findById(account.id)).phone_verified, false);
  assert.equal((await f.User.findById(account.id)).phone_verified_at, null);

  // 空手机号 + 勾选验证：同样拒绝，不能凭空生成验证状态。
  result = await edit(route, cookie, { phoneCountryCode: '86', phoneNumber: '', phoneVerified: true });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.error_key, 'validation.phone.invalid');
  assert.equal((await f.User.findById(account.id)).phone_e164, null);
  assert.equal((await f.User.findById(account.id)).phone_verified, false);

  // 非严格布尔值必须被拒绝，而不是被当成真值。
  for (const value of ['true', '1', 1]) {
    result = await edit(route, cookie, { phoneVerified: value });
    assert.equal(result.status, 400, `${JSON.stringify(value)} is not a strict boolean: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error_key, 'validation.phone.invalid');
    assert.equal((await f.User.findById(account.id)).phone_verified, false);
  }

  // 模型层是最后一道防线：无号码时绝不写验证。
  await f.User.update(account.id, { phone: '+8613800138000', phoneVerified: true });
  await f.User.update(account.id, { phoneNumber: '' });
  assert.equal((await f.User.findById(account.id)).phone_verified, false);
  await f.User.update(account.id, { phoneVerified: true });
  assert.equal((await f.User.findById(account.id)).phone_verified, false, 'Unbind then verify without a number stays unverified');
  await f.User.update(account.id, { phoneVerified: '1' });
  assert.equal((await f.User.findById(account.id)).phone_verified, false, 'A non-boolean flag never verifies');
});

test('ordinary profile edits cannot verify a phone even when the flag is sent', async () => {
  const account = await f.user();
  const { cookie } = await f.login(account);
  let result = await edit('/api/profile', cookie, { phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerified, false, 'Profile never self-verifies a phone');
  assert.equal(result.body.user.phoneVerifiedAt, null);
  let current = result.cookie;
  // 号码未变时提交 true 也不能自证。
  result = await edit('/api/profile', current, { phoneCountryCode: '86', phoneNumber: '13800138000', phoneVerified: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneVerified, false);
  // 直接对模型提交非严格布尔值同样无效。
  await f.User.update(account.id, { phoneVerified: '1' });
  assert.equal((await f.User.findById(account.id)).phone_verified, false);
});

test('administrator phone verification changes revoke target credentials but keep the admin signed in', async () => {
  const admin = await f.user('admin');
  const account = await f.user();
  await f.User.update(account.id, { phoneCountryCode: '86', phoneNumber: '13800138000' });
  const app = await f.client();
  const grant = await f.authorize(account, app, 'openid offline_access');
  const token = await f.exchange(app, grant);
  const privileged = await f.login(admin);
  const verified = await edit(`/api/users/${account.id}`, privileged.cookie, { phoneVerified: true });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.user.phoneVerified, true);
  assert.equal((await f.request('/api/profile', { cookie: grant.cookie })).status, 401, 'Verification change revokes the target session');
  assert.equal((await f.request('/api/profile', { cookie: privileged.cookie })).status, 200, 'The acting administrator stays signed in');
  assert.equal((await f.refresh(app, token.body.refresh_token)).status, 400);
});

test('administrator verifying their own phone keeps the current session', async () => {
  const admin = await f.user('admin');
  const otherSession = await f.login(admin);
  const current = await f.login(admin);
  const route = `/api/users/${admin.id}`;
  const result = await edit(route, current.cookie, {
    name: 'Self verify admin', email: admin.email, role: 'admin', emailVerified: true, banned: false,
    phoneCountryCode: '+86', phoneNumber: '13800138000', phoneVerified: true
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.user.phoneVerified, true);
  assert.ok(result.body.user.phoneVerifiedAt);
  const reloaded = await f.request(route, { cookie: current.cookie });
  assert.equal(reloaded.status, 200, 'Self verification keeps the acting session');
  assert.equal(reloaded.body.user.phoneVerified, true);
  assert.equal((await f.request('/api/profile', { cookie: otherSession.cookie })).status, 401, 'Other sessions of the target are revoked');
});
