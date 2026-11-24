'use strict';

const crypto = require('node:crypto');
const UserModel = require('../models/User');
const ExternalIdentityModel = require('../models/ExternalIdentity');
const SessionModel = require('../models/Session');
const { isQfliClient } = require('./qfli-integration');

// An app-scoped Tianyi openId is identity authority only. Never derive a phone or
// verified mailbox, and never reuse a provider key across applications.
module.exports = async function withTianyiIdentity({ pool, config, identity, state, isUserBanned,
  isSettingEnabled, fail, work }) {
  const connection = await pool.getConnection();
  const acquired = [];
  let transaction = false;
  const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 48);
  async function lock(key) {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [key]);
    if (Number(rows[0]?.acquired) !== 1) fail(429, '账号授权繁忙，请稍后重试');
    acquired.push(key);
  }
  try {
    // Serialize all subjects for this provider so an administrator's reused app
    // configuration cannot race the first app namespace assertion.
    await lock(`tianyi:${hash(config.providerKey)}`);
    const users = new UserModel(connection);
    const identities = new ExternalIdentityModel(connection);
    const rows = await identities.findByProviders([config.providerKey]);
    if (rows.some(row => {
      const profile = identities.serialize(row).profile;
      return profile.appId !== config.clientId || profile.provider !== config.providerType;
    })) fail(409, '该提供方已属于其他天翼应用，请新建 Provider');
    const existing = await identities.findByProviderUserId(config.providerKey, identity.openId);
    if (state.linkUserId && existing && existing.user_id !== state.linkUserId) fail(409, '该天翼账号已绑定其他账户');
    const userId = state.linkUserId || existing?.user_id;
    if (userId) await lock(`totp:${hash(userId)}`);
    await connection.beginTransaction();
    transaction = true;
    let user;
    if (userId) {
      const [locked] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
      user = locked[0];
      if (!user || isUserBanned(user)) fail(403, '账户不可用');
    }
    if (state.linkUserId) {
      const session = await new SessionModel(connection).findById(state.linkSessionId);
      if (!session || session.user_id !== user.id || session.revoked_at || new Date(session.expires_at) <= new Date()
          || Date.now() - new Date(session.created_at).getTime() >= 5 * 60 * 1000) {
        fail(403, '请重新登录后绑定天翼账号');
      }
    }
    if (!user) {
      if (!await isSettingEnabled('registration_enabled', connection) || isQfliClient(state.clientId) || isQfliClient(config.clientId)) {
        fail(403, '当前应用不允许通过此提供方创建账户');
      }
      const suffix = crypto.randomBytes(12).toString('hex');
      user = await users.create({ username: `tianyi-${suffix}`, email: `tianyi-${suffix}@users.invalid`,
        password: '', name: 'Tianyi user', emailVerified: false });
    }
    if (!existing) {
      await identities.create({ userId: user.id, provider: config.providerKey, providerUserId: identity.openId,
        displayName: 'Tianyi account', profile: { provider: config.providerType, appId: config.clientId,
          openId: identity.openId, _vaultsso: { clientId: config.clientId, issuer: 'https://open.e.189.cn' } } });
    }
    const result = await work(user, connection);
    await connection.commit();
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    try {
      for (const key of acquired.reverse()) await connection.query('SELECT RELEASE_LOCK(?) AS released', [key]);
    } finally { connection.release(); }
  }
};
