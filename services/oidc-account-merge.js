const crypto = require('crypto');
const ExternalIdentityModel = require('../models/ExternalIdentity');
const SessionModel = require('../models/Session');
const TokenModel = require('../models/Token');
const { toE164 } = require('./phone');
const { AccountMergeError } = require('./account-merge');

function text(value) { return String(value || '').trim(); }

function disposableSource(source, identities, proven, config) {
  const provider = text(config.providerKey).toLowerCase();
  if (source.role !== 'user' || source.password || source.banned || source.totp_enabled || source.totp_secret
      || source.recovery_codes || source.captcha_required || Number(source.credits) !== 0
      || text(source.description) || identities.length !== 1
      || toE164(source.phone_country_code, source.phone_number)) return false;

  const identity = identities[0];
  if (identity.provider !== provider || identity.provider_user_id !== proven.id
      || (proven.secondaryId && text(identity.provider_secondary_id) !== proven.secondaryId)) return false;
  const profile = new ExternalIdentityModel(null).serialize(identity).profile;
  const original = profile._vaultsso || (config.validateIdToken ? { issuer: profile.iss, clientId: profile.aud } : null);
  const originalAudiences = Array.isArray(original?.clientId) ? original.clientId : [original?.clientId];
  if (!text(config.resolvedIssuer) || text(original?.issuer) !== text(config.resolvedIssuer)
      || !originalAudiences.includes(config.clientId)) return false;
  const generatedEmail = `${provider}-${crypto.createHash('sha256').update(proven.id).digest('hex').slice(0, 24)}@users.invalid`;
  const generatedUnverified = source.email === generatedEmail && !source.email_verified;
  const providerVerified = source.email === text(identity.email).toLowerCase() && source.email_verified;
  if (!generatedUnverified && !providerVerified) return false;
  const originalName = text(identity.display_name) || text(identity.provider_username) || text(identity.email) || text(source.username);
  return text(source.name) === originalName && text(source.avatar) === text(identity.avatar);
}

function lockKey(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

async function mergeOidcAccount({ pool, targetUserId, sourceUserId, provenIdentity, providerConfig, keepSessionId }) {
  const provider = text(providerConfig?.providerKey).toLowerCase();
  const id = text(provenIdentity?.id);
  const secondaryId = text(provenIdentity?.secondaryId);
  if (!pool || !text(targetUserId) || !text(sourceUserId) || targetUserId === sourceUserId || !provider || !id || !keepSessionId) {
    throw new AccountMergeError('Invalid account merge request', 'invalid_request');
  }

  const connection = await pool.getConnection();
  const acquired = [];
  let transaction = false;
  try {
    const before = await new ExternalIdentityModel(connection).findByUserId(sourceUserId);
    const locks = new Set([`totp:${lockKey(targetUserId).slice(0, 48)}`, `totp:${lockKey(sourceUserId).slice(0, 48)}`,
      lockKey(`oidc:${provider}:${id}`)]);
    for (const row of before) locks.add(lockKey(`oidc:${row.provider}:${row.provider_user_id}`));
    for (const key of [...locks].sort()) {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [key]);
      if (Number(rows[0]?.acquired) !== 1) throw new AccountMergeError('Account merge is busy', 'account_merge_busy');
      acquired.push(key);
    }

    await connection.beginTransaction();
    transaction = true;
    const [accounts] = await connection.execute('SELECT * FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE', [targetUserId, sourceUserId]);
    const target = accounts.find(row => row.id === targetUserId);
    const source = accounts.find(row => row.id === sourceUserId);
    if (!target || !source || target.banned) throw new AccountMergeError('Account no longer available');
    const [sessions] = await connection.execute('SELECT * FROM sessions WHERE id = ? FOR UPDATE', [keepSessionId]);
    const session = sessions[0];
    const created = new Date(session?.created_at).getTime();
    if (!session || session.user_id !== targetUserId || session.revoked_at
        || new Date(session.expires_at).getTime() <= Date.now() || !Number.isFinite(created)
        || Date.now() - created >= 5 * 60 * 1000) {
      throw new AccountMergeError('Sign in to the target account again', 'reauthentication_required');
    }
    const [identities] = await connection.execute('SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at ASC FOR UPDATE', [sourceUserId]);
    if (identities.length !== before.length || identities.some(row => !before.some(prior => prior.id === row.id))) {
      throw new AccountMergeError('Account bindings changed during merge');
    }
    if (!disposableSource(source, identities, { id, secondaryId }, providerConfig)) {
      throw new AccountMergeError('Source account contains data requiring manual review', 'account_merge_manual_review');
    }
    const [authenticators] = await connection.execute('SELECT * FROM user_authenticators WHERE user_id = ? ORDER BY created_at, id', [sourceUserId]);
    if (authenticators.length) throw new AccountMergeError('Source account has an authenticator', 'account_merge_manual_review');

    const [moved] = await connection.execute('UPDATE user_identities SET user_id = ? WHERE id = ?', [targetUserId, identities[0].id]);
    if (moved.affectedRows !== 1) throw new AccountMergeError('Identity transfer failed');
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
    await new SessionModel(connection).revokeAllForUser(targetUserId, keepSessionId || null);
    await new TokenModel(connection).revokeByUser(targetUserId);
    await connection.execute('DELETE FROM email_verification_codes WHERE user_id = ?', [targetUserId]);
    const [deleted] = await connection.execute('DELETE FROM users WHERE id = ?', [sourceUserId]);
    if (deleted.affectedRows !== 1) throw new AccountMergeError('Source account deletion failed');
    await connection.commit();
    transaction = false;
    return { userId: targetUserId, movedIdentityIds: [identities[0].id] };
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    let releaseFailed = false;
    try {
      for (const key of acquired.reverse()) {
        try {
          const [rows] = await connection.query('SELECT RELEASE_LOCK(?) AS released', [key]);
          if (Number(rows[0]?.released) !== 1) releaseFailed = true;
        } catch { releaseFailed = true; }
      }
    } finally {
      if (releaseFailed) connection.destroy();
      else connection.release();
    }
  }
}

module.exports = { mergeOidcAccount };
