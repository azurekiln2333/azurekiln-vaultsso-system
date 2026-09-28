const crypto = require('crypto');
const UserModel = require('../models/User');
const ExternalIdentityModel = require('../models/ExternalIdentity');
const SessionModel = require('../models/Session');
const TokenModel = require('../models/Token');
const { toE164 } = require('./phone');

class AccountMergeError extends Error {
  constructor(message, code = 'account_merge_conflict') {
    super(message);
    this.name = 'AccountMergeError';
    this.code = code;
    this.status = code === 'reauthentication_required' ? 403 : 409;
  }
}

function text(value) { return String(value || '').trim(); }

function huaweiLockKeys(identity, config) {
  const provider = text(config.providerKey).toLowerCase();
  const scope = text(config.huaweiUnionScope);
  const subjects = [identity.unionId, identity.openId].filter(Boolean).map(id => `provider:${provider}:${id}`);
  if (scope && identity.unionId) subjects.push(`scope:${scope}:${identity.unionId}`);
  return subjects.map(subject => crypto.createHash('sha256').update(`huawei:${subject}`).digest('hex'));
}

function userLockKey(userId) {
  return `totp:${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 48)}`;
}

function profileOf(row) {
  return new ExternalIdentityModel(null).serialize(row).profile;
}

function sourceLooksDisposable(source, rows, identity, config) {
  if (source.role !== 'user' || source.password || source.email_verified || source.banned
      || source.totp_enabled || source.totp_secret || source.recovery_codes || source.captcha_required
      || Number(source.credits) !== 0 || text(source.description) || !rows.length) return false;

  const provider = text(config.providerKey).toLowerCase();
  const scope = text(config.huaweiUnionScope);
  const proven = rows.find(row => row.provider === provider
    && (row.provider_user_id === identity.unionId || row.provider_user_id === identity.openId)
    && (!identity.openId || row.provider_secondary_id === identity.openId || row.provider_user_id === identity.openId));
  if (!proven) return false;
  const provenProfile = profileOf(proven);
  if (provenProfile.provider !== 'huawei_quicklogin'
      || !text(config.clientId) || provenProfile.clientId !== config.clientId
      || (identity.unionId && provenProfile.unionID && provenProfile.unionID !== identity.unionId)
      || (identity.openId && provenProfile.openID && provenProfile.openID !== identity.openId)) return false;

  if (rows.length > 1 && (!scope || !identity.unionId)) return false;
  if (!rows.every(row => {
    const profile = profileOf(row);
    return profile.provider === 'huawei_quicklogin'
      && (row.id === proven.id || (profile.huaweiUnionScope === scope && profile.unionID === identity.unionId));
  })) return false;

  const syntheticEmail = rows.some(row => [row.provider_user_id, row.provider_secondary_id].filter(Boolean).some(subject =>
    source.email === `${row.provider}-${crypto.createHash('sha256').update(subject).digest('hex').slice(0, 24)}@users.invalid`
  ));
  const originalIdentity = rows.find(row => text(row.provider_username) === text(source.username));
  if (!syntheticEmail || !originalIdentity) return false;
  const originalName = text(originalIdentity.display_name) || text(source.username);
  if (text(source.name) !== originalName || text(source.avatar) !== text(originalIdentity.avatar)) return false;
  return true;
}

async function mergeHuaweiAccount({ pool, targetUserId, sourceUserId, provenIdentity, providerConfig, keepSessionId }) {
  if (!pool || !text(targetUserId) || !text(sourceUserId) || targetUserId === sourceUserId
      || !text(keepSessionId) || !text(providerConfig?.providerKey)
      || (!text(provenIdentity?.openId) && !text(provenIdentity?.unionId))) {
    throw new AccountMergeError('Invalid account merge request', 'invalid_request');
  }

  const connection = await pool.getConnection();
  const acquired = [];
  let transaction = false;
  let committed = false;
  try {
    const identities = new ExternalIdentityModel(connection);
    const beforeRows = await identities.findByUserId(sourceUserId);
    const locks = new Set([
      userLockKey(targetUserId), userLockKey(sourceUserId),
      ...huaweiLockKeys(provenIdentity, providerConfig)
    ]);
    for (const row of beforeRows) {
      const profile = profileOf(row);
      for (const key of huaweiLockKeys({ unionId: profile.unionID || '', openId: profile.openID || row.provider_secondary_id || row.provider_user_id }, {
        providerKey: row.provider, huaweiUnionScope: profile.huaweiUnionScope || ''
      })) locks.add(key);
    }
    for (const key of [...locks].sort()) {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [key]);
      if (Number(rows[0]?.acquired) !== 1) throw new AccountMergeError('Account merge is busy', 'account_merge_busy');
      acquired.push(key);
    }

    await connection.beginTransaction();
    transaction = true;
    const users = new UserModel(connection);
    const [lockedUsers] = await connection.execute(
      'SELECT * FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [targetUserId, sourceUserId]
    );
    const target = lockedUsers.find(row => row.id === targetUserId);
    const source = lockedUsers.find(row => row.id === sourceUserId);
    if (!target || !source || target.banned) throw new AccountMergeError('Account no longer available');
    const [sessions] = await connection.execute(
      'SELECT * FROM sessions WHERE id = ? AND user_id = ? FOR UPDATE', [keepSessionId, targetUserId]
    );
    const session = sessions[0];
    const now = Date.now();
    if (!session || session.revoked_at || !Number.isFinite(new Date(session.expires_at).getTime())
        || new Date(session.expires_at).getTime() <= now
        || !Number.isFinite(new Date(session.created_at).getTime())
        || now - new Date(session.created_at).getTime() >= 5 * 60 * 1000) {
      throw new AccountMergeError('Sign in to the existing account again', 'reauthentication_required');
    }
    const [sourceRows] = await connection.execute(
      'SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at ASC FOR UPDATE', [sourceUserId]
    );
    if (sourceRows.length !== beforeRows.length || sourceRows.some(row => !beforeRows.some(before => before.id === row.id))) {
      throw new AccountMergeError('Account bindings changed during merge');
    }
    if (!sourceLooksDisposable(source, sourceRows, provenIdentity, providerConfig)) {
      throw new AccountMergeError('Source account contains data requiring manual review', 'account_merge_manual_review');
    }
    const [authenticators] = await connection.execute('SELECT * FROM user_authenticators WHERE user_id = ? ORDER BY created_at, id', [sourceUserId]);
    if (authenticators.length) throw new AccountMergeError('Source account has an authenticator', 'account_merge_manual_review');

    const sourcePhone = toE164(source.phone_country_code, source.phone_number);
    const provenPhone = provenIdentity.phoneVerified && provenIdentity.phone
      ? toE164(provenIdentity.phone.countryCode, provenIdentity.phone.nationalNumber) : '';
    if (provenIdentity.phoneVerified && (!provenPhone || provenPhone !== provenIdentity.phone.e164)) {
      throw new AccountMergeError('Huawei phone proof is invalid', 'account_merge_phone_conflict');
    }
    if (sourcePhone && (!source.phone_verified || toE164(target.phone_country_code, target.phone_number))) {
      throw new AccountMergeError('Phone numbers require manual review', 'account_merge_phone_conflict');
    }
    if (sourcePhone && provenPhone && sourcePhone !== provenPhone) {
      throw new AccountMergeError('Huawei phone changed; manual review is required', 'account_merge_phone_conflict');
    }
    const targetPhone = toE164(target.phone_country_code, target.phone_number);
    const phoneToBind = sourcePhone || (!targetPhone && provenPhone);
    const phoneBinding = provenPhone && targetPhone && targetPhone !== provenPhone ? 'conflict'
      : phoneToBind ? 'verified' : provenPhone && targetPhone && !target.phone_verified ? 'verified' : 'unchanged';

    for (const row of sourceRows) {
      const [updated] = await connection.execute('UPDATE user_identities SET user_id = ? WHERE id = ?', [targetUserId, row.id]);
      if (updated.affectedRows !== 1) throw new AccountMergeError('Identity transfer failed');
    }
    const [usage] = await connection.execute('SELECT * FROM user_app_usage WHERE user_id = ? ORDER BY last_used_at DESC, client_id ASC FOR UPDATE', [sourceUserId]);
    for (const row of usage) {
      await connection.execute(
        `INSERT INTO user_app_usage (user_id, client_id, client_name, first_used_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE client_name = VALUES(client_name),
           first_used_at = LEAST(first_used_at, VALUES(first_used_at)),
           last_used_at = GREATEST(last_used_at, VALUES(last_used_at))`,
        [targetUserId, row.client_id, row.client_name, row.first_used_at, row.last_used_at]
      );
    }
    if (phoneToBind) {
      if (sourcePhone) await users.update(sourceUserId, { phone: '' });
      await users.update(targetUserId, {
        phone: phoneToBind, phoneVerified: true,
        phoneVerifiedAt: sourcePhone ? source.phone_verified_at : new Date()
      });
    } else if (phoneBinding === 'verified') {
      await users.update(targetUserId, { phoneVerified: true, phoneVerifiedAt: new Date() });
    }
    await new SessionModel(connection).revokeAllForUser(targetUserId, keepSessionId || null);
    await new TokenModel(connection).revokeByUser(targetUserId);
    await connection.execute('DELETE FROM email_verification_codes WHERE user_id = ?', [targetUserId]);
    const [deleted] = await connection.execute('DELETE FROM users WHERE id = ?', [sourceUserId]);
    if (deleted.affectedRows !== 1) throw new AccountMergeError('Source account deletion failed');

    const mergedUser = await users.findById(targetUserId);
    await connection.commit();
    transaction = false;
    committed = true;
    return { userId: targetUserId, movedIdentityIds: sourceRows.map(row => row.id),
      phoneTransferred: Boolean(sourcePhone), phoneBinding, user: mergedUser };
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    try {
      for (const key of acquired.reverse()) await connection.query('SELECT RELEASE_LOCK(?) AS released', [key]);
      connection.release();
    } catch (error) {
      connection.destroy();
      if (!committed) throw error;
      console.error('Account merge connection cleanup failed');
    }
  }
}

module.exports = { mergeHuaweiAccount, AccountMergeError };
