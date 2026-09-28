const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createMemoryPool } = require('./support/memory-db');
const UserModel = require('../models/User');
const ExternalIdentityModel = require('../models/ExternalIdentity');
const { mergeHuaweiAccount, AccountMergeError } = require('../services/account-merge');

const scope = 'company-a';
const unionId = 'union-member-1';
const config = { providerKey: 'huawei-a', huaweiUnionScope: scope, clientId: 'huawei-app-a' };
const proof = { unionId, openId: 'openid-app-a' };

function testPool() {
  const pool = createMemoryPool();
  const getConnection = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const connection = await getConnection();
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
      const state = connection.transactionPool || pool;
      if (normalized === 'select * from users where id in (?, ?) order by id for update') {
        return [state.users.filter(row => params.includes(row.id)).sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ ...row })), []];
      }
      if (normalized === 'select * from sessions where id = ? and user_id = ? for update') {
        return [state.sessions.filter(row => row.id === params[0] && row.user_id === params[1]).map(row => ({ ...row })), []];
      }
      if (normalized === 'select * from user_identities where user_id = ? order by created_at asc for update') {
        return [state.userIdentities.filter(row => row.user_id === params[0])
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(row => ({ ...row })), []];
      }
      if (normalized === 'select * from user_app_usage where user_id = ? order by last_used_at desc, client_id asc for update') {
        return [state.userAppUsage.filter(row => row.user_id === params[0])
          .sort((a, b) => new Date(b.last_used_at) - new Date(a.last_used_at)).map(row => ({ ...row })), []];
      }
      if (normalized === 'update user_identities set user_id = ? where id = ?') {
        const row = state.userIdentities.find(item => item.id === params[1]);
        if (!row) return [{ affectedRows: 0 }, []];
        row.user_id = params[0];
        return [{ affectedRows: 1 }, []];
      }
      if (normalized === 'delete from email_verification_codes where user_id = ?') {
        const before = state.emailVerificationCodes.length;
        state.emailVerificationCodes = state.emailVerificationCodes.filter(row => row.user_id !== params[0]);
        return [{ affectedRows: before - state.emailVerificationCodes.length }, []];
      }
      return execute(sql, params);
    };
    return connection;
  };
  return pool;
}

async function seed(pool, { sourcePhone = '', targetPhone = '', sourcePassword = '', sourceCredits = 0, secondApp = true } = {}) {
  const users = new UserModel(pool);
  const identities = new ExternalIdentityModel(pool);
  const target = await users.create({ username: 'existing', email: 'existing@example.test', password: 'password-123',
    phone: targetPhone || undefined });
  pool.sessions.push({ id: 'keep', user_id: target.id, revoked_at: null,
    created_at: new Date(), expires_at: new Date(Date.now() + 60 * 60 * 1000) });
  const email = `huawei-a-${crypto.createHash('sha256').update(unionId).digest('hex').slice(0, 24)}@users.invalid`;
  const source = await users.create({ username: 'Huawei member', email, password: sourcePassword,
    name: 'Huawei member', phone: sourcePhone || undefined, phoneVerified: Boolean(sourcePhone), credits: sourceCredits });
  const first = await identities.create({ userId: source.id, provider: 'huawei-a', providerUserId: unionId,
    providerSecondaryId: proof.openId, providerUsername: source.username, displayName: source.name,
    profile: { provider: 'huawei_quicklogin', clientId: config.clientId, huaweiUnionScope: scope,
      unionID: unionId, openID: proof.openId } });
  let second;
  if (secondApp) second = await identities.create({ userId: source.id, provider: 'huawei-b', providerUserId: unionId,
    providerSecondaryId: 'openid-app-b', providerUsername: source.username, displayName: source.name,
    profile: { provider: 'huawei_quicklogin', clientId: 'huawei-app-b', huaweiUnionScope: scope,
      unionID: unionId, openID: 'openid-app-b' } });
  return { target, source, first, second };
}

test('merges disposable Huawei account identities, usage and phone; revokes old credentials', async () => {
  const pool = testPool();
  const { target, source, first, second } = await seed(pool, { sourcePhone: '+8613800138000' });
  const old = new Date('2026-01-01T00:00:00Z');
  const recent = new Date('2026-02-01T00:00:00Z');
  pool.userAppUsage.push({ user_id: source.id, client_id: 'client-1', client_name: 'App', first_used_at: old, last_used_at: recent });
  pool.userAppUsage.push({ user_id: target.id, client_id: 'client-1', client_name: 'App', first_used_at: recent, last_used_at: recent });
  pool.sessions.push({ id: 'other', user_id: target.id, revoked_at: null },
    { id: 'source-session', user_id: source.id, revoked_at: null });
  pool.accessTokens.push({ id: 'target-token', user_id: target.id }, { id: 'source-token', user_id: source.id });
  pool.emailVerificationCodes.push({ id: 'pending', user_id: target.id });

  const result = await mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: proof, providerConfig: config, keepSessionId: 'keep' });

  assert.equal(result.userId, target.id);
  assert.deepEqual(result.movedIdentityIds, [first.id, second.id]);
  assert.equal(result.phoneTransferred, true);
  assert.equal(result.phoneBinding, 'verified');
  assert.equal(result.user.phone_e164, '+8613800138000');
  assert.equal(await new UserModel(pool).findById(source.id), null);
  assert.equal((await new UserModel(pool).findById(target.id)).phone_e164, '+8613800138000');
  assert.deepEqual((await new ExternalIdentityModel(pool).findByUserId(target.id)).map(row => row.id), [first.id, second.id]);
  assert.equal(pool.userAppUsage.length, 1);
  assert.equal(new Date(pool.userAppUsage[0].first_used_at).getTime(), old.getTime());
  assert.equal(pool.sessions.find(row => row.id === 'keep').revoked_at, null);
  assert.ok(pool.sessions.find(row => row.id === 'other').revoked_at);
  assert.equal(pool.sessions.some(row => row.id === 'source-session'), false);
  assert.equal(pool.accessTokens.length, 0);
  assert.equal(pool.emailVerificationCodes.length, 0);
});

test('rejects a source with local credentials or credits without changing either account', async () => {
  for (const option of [{ sourcePassword: 'local-password' }, { sourceCredits: 20 }]) {
    const pool = testPool();
    const { target, source } = await seed(pool, option);
    await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
      provenIdentity: proof, providerConfig: config, keepSessionId: 'keep' }), error => error instanceof AccountMergeError && error.code === 'account_merge_manual_review');
    assert.ok(await new UserModel(pool).findById(source.id));
    assert.equal((await new ExternalIdentityModel(pool).findByUserId(source.id)).length, 2);
  }
});

test('rejects mismatched trusted proof and conflicting target phone', async () => {
  const pool = testPool();
  const { target, source } = await seed(pool, { sourcePhone: '+8613800138000', targetPhone: '+8613900139000' });
  await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: { unionId: 'other-union', openId: 'other-openid' }, providerConfig: config, keepSessionId: 'keep' }),
  error => error.code === 'account_merge_manual_review');
  await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: { unionId, openId: 'other-openid' }, providerConfig: config, keepSessionId: 'keep' }),
  error => error.code === 'account_merge_manual_review');
  await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: proof, providerConfig: config, keepSessionId: 'keep' }), error => error.code === 'account_merge_phone_conflict');
  assert.equal((await new UserModel(pool).findById(source.id)).phone_e164, '+8613800138000');
});

test('rolls back prior identity transfer when a later transfer fails', async () => {
  const pool = testPool();
  const { target, source, second } = await seed(pool);
  const getConnection = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const connection = await getConnection();
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql, params = []) => {
      if (sql === 'UPDATE user_identities SET user_id = ? WHERE id = ?' && params[1] === second.id) {
        throw new Error('simulated write failure');
      }
      return execute(sql, params);
    };
    return connection;
  };
  await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: proof, providerConfig: config, keepSessionId: 'keep' }), /simulated write failure/);
  assert.ok(await new UserModel(pool).findById(source.id));
  assert.equal((await new ExternalIdentityModel(pool).findByUserId(source.id)).length, 2);
  assert.equal((await new ExternalIdentityModel(pool).findByUserId(target.id)).length, 0);
});

test('restores source phone and credentials if deletion fails after transfer', async () => {
  const pool = testPool();
  const { target, source } = await seed(pool, { sourcePhone: '+8613800138000' });
  pool.accessTokens.push({ id: 'target-token', user_id: target.id });
  const getConnection = pool.getConnection.bind(pool);
  pool.getConnection = async () => {
    const connection = await getConnection();
    const execute = connection.execute.bind(connection);
    connection.execute = async (sql, params = []) => {
      if (sql === 'DELETE FROM users WHERE id = ?' && params[0] === source.id) throw new Error('simulated deletion failure');
      return execute(sql, params);
    };
    return connection;
  };
  await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: proof, providerConfig: config, keepSessionId: 'keep' }), /simulated deletion failure/);
  assert.equal((await new UserModel(pool).findById(source.id)).phone_e164, '+8613800138000');
  assert.equal((await new UserModel(pool).findById(target.id)).phone_e164, null);
  assert.equal((await new ExternalIdentityModel(pool).findByUserId(source.id)).length, 2);
  assert.equal(pool.accessTokens.length, 1);
});

test('binds the verified phone returned by the merge code when the source had no phone', async () => {
  const pool = testPool();
  const { target, source } = await seed(pool);
  const result = await mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: { ...proof, phoneVerified: true,
      phone: { countryCode: '86', nationalNumber: '13800138000', e164: '+8613800138000' } },
    providerConfig: config, keepSessionId: 'keep' });
  assert.equal(result.phoneTransferred, false);
  assert.equal(result.phoneBinding, 'verified');
  assert.equal(result.user.phone_e164, '+8613800138000');
  assert.equal(result.user.phone_verified, true);
});

test('refuses to transfer a stale source phone that differs from current Huawei proof', async () => {
  const pool = testPool();
  const { target, source } = await seed(pool, { sourcePhone: '+8613800138000' });
  await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: { ...proof, phoneVerified: true,
      phone: { countryCode: '86', nationalNumber: '13900139000', e164: '+8613900139000' } },
    providerConfig: config, keepSessionId: 'keep' }), error => error.code === 'account_merge_phone_conflict');
  assert.ok(await new UserModel(pool).findById(source.id));
  assert.equal((await new UserModel(pool).findById(target.id)).phone_e164, null);
});

test('rechecks the target session inside the merge transaction', async () => {
  for (const change of [session => { session.revoked_at = new Date(); },
    session => { session.created_at = new Date(Date.now() - 6 * 60 * 1000); }]) {
    const pool = testPool();
    const { target, source } = await seed(pool);
    change(pool.sessions.find(row => row.id === 'keep'));
    await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
      provenIdentity: proof, providerConfig: config, keepSessionId: 'keep' }),
    error => error.code === 'reauthentication_required' && error.status === 403);
    assert.ok(await new UserModel(pool).findById(source.id));
    assert.equal((await new ExternalIdentityModel(pool).findByUserId(target.id)).length, 0);
  }
});

test('destroys a connection when releasing an advisory lock fails', async () => {
  const pool = testPool();
  const { target, source } = await seed(pool, { sourcePassword: 'local-password' });
  const getConnection = pool.getConnection.bind(pool);
  let destroyed = false;
  pool.getConnection = async () => {
    const connection = await getConnection();
    const query = connection.query.bind(connection);
    connection.query = (sql, params) => {
      if (sql.includes('RELEASE_LOCK')) throw new Error('lock release failed');
      return query(sql, params);
    };
    connection.destroy = () => { destroyed = true; };
    return connection;
  };
  await assert.rejects(mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: proof, providerConfig: config, keepSessionId: 'keep' }), /lock release failed/);
  assert.equal(destroyed, true);
});

test('reports a committed merge as successful even if advisory-lock cleanup fails', async () => {
  const pool = testPool();
  const { target, source } = await seed(pool);
  const getConnection = pool.getConnection.bind(pool);
  let destroyed = false;
  pool.getConnection = async () => {
    const connection = await getConnection();
    const query = connection.query.bind(connection);
    connection.query = (sql, params) => {
      if (sql.includes('RELEASE_LOCK')) throw new Error('lock release failed');
      return query(sql, params);
    };
    connection.destroy = () => { destroyed = true; };
    return connection;
  };
  const result = await mergeHuaweiAccount({ pool, targetUserId: target.id, sourceUserId: source.id,
    provenIdentity: proof, providerConfig: config, keepSessionId: 'keep' });
  assert.equal(result.userId, target.id);
  assert.equal(await new UserModel(pool).findById(source.id), null);
  assert.equal(destroyed, true);
});
