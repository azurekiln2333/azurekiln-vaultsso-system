const crypto = require('node:crypto');
const TokenModel = require('../models/Token');

class AccountErasureError extends Error {
  constructor(status, code, description) {
    super(description);
    this.status = status;
    this.code = code;
  }
}

function erasedLogUserId(secret, userId) {
  return crypto.createHmac('sha256', secret).update(`account-erasure:${userId}`).digest('hex').slice(0, 36);
}

function accountLockKey(userId) {
  return `totp:${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 48)}`;
}

// The same account lock protects final login/token issuance. A nonblocking acquisition gives
// callers the frozen 409 response rather than serialising concurrent erasure requests.
async function eraseAccount({ pool, secret, userId, clientId, requestId = '', ip = '' }) {
  const connection = await pool.getConnection();
  const key = accountLockKey(userId.toLowerCase());
  let acquired = false;
  let transaction = false;
  let committed = false;
  try {
    const [locks] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [key]);
    if (Number(locks[0]?.acquired) !== 1) {
      throw new AccountErasureError(409, 'conflict', 'Account erasure is already in progress');
    }
    acquired = true;
    await connection.beginTransaction();
    transaction = true;
    const [rows] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    const user = rows[0];
    if (!user) throw new AccountErasureError(404, 'user_not_found', 'User does not exist');
    if (user.status === 'deleted') {
      const result = { user_id: user.id, status: 'already_deleted', deleted_at: new Date(user.deleted_at).toISOString(), tokens_revoked: true };
      await connection.commit();
      transaction = false;
      committed = true;
      return result;
    }

    const deletedAt = new Date();
    const anonymousId = erasedLogUserId(secret, user.id);
    const marker = `deleted_${crypto.randomUUID().replaceAll('-', '')}`;
    await new TokenModel(connection).revokeByUser(user.id);
    for (const table of ['sessions', 'user_identities', 'user_authenticators', 'user_app_usage']) {
      await connection.execute(`DELETE FROM ${table} WHERE user_id = ?`, [user.id]);
    }
    await connection.execute('DELETE FROM email_verification_codes WHERE user_id = ? OR email = ?', [user.id, user.email]);
    await connection.execute(
      `UPDATE login_logs SET username = ?, user_id = ?, user_agent = ?, detail = ?
       WHERE user_id = ? OR (user_id IS NULL AND username IN (?, ?))`,
      ['deleted_user', anonymousId, '', '', user.id, user.username, user.email]
    );
    // The historical writer clipped action-prefixed details to 255 characters, potentially before
    // the end of a long imported username. Match both complete and actually persisted references.
    const targetDetails = ['revoke_sessions', 'reset_totp', 'delete_user'].map(action => `${action} | ${user.username}`);
    const updatePrefix = `update_user | ${user.username} -> `;
    await connection.execute(
      "UPDATE login_logs SET detail = ? WHERE result = ? AND (detail IN (?, ?, ?, ?, ?, ?, ?) OR detail LIKE ? ESCAPE '!')",
      ['', 'admin_action', ...targetDetails, ...targetDetails.map(detail => detail.slice(0, 255)), updatePrefix.slice(0, 255),
        `${updatePrefix.replace(/[!%_]/g, '!$&')}%`]
    );
    const fields = {
      status: 'deleted', deleted_at: deletedAt, username: marker, email: `${marker}@users.invalid`, password: '',
      name: null, avatar: null, description: null, email_verified: false, banned: true,
      totp_secret: null, totp_enabled: false, totp_last_counter: -1,
      totp_revision: Number(user.totp_revision || 0) + 1, recovery_codes: null, captcha_required: false,
      credits: 0, last_login_ip: null, phone_country_code: null, phone_number: null,
      phone_verified: false, phone_verified_at: null, role: 'user'
    };
    const [updated] = await connection.execute(
      `UPDATE users SET ${Object.keys(fields).map(name => `${name} = ?`).join(', ')} WHERE id = ?`,
      [...Object.values(fields), user.id]
    );
    if (updated.affectedRows !== 1) throw new Error('Account tombstone was not persisted');
    await connection.execute(
      `INSERT INTO login_logs (id, username, user_id, ip, user_agent, result, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [crypto.randomUUID(), 'deleted_user', anonymousId, ip, '', 'admin_action',
        JSON.stringify({ action: 'account_erase', client_id: clientId, request_id: requestId })]
    );
    await connection.commit();
    transaction = false;
    committed = true;
    return { user_id: user.id, status: 'deleted', deleted_at: deletedAt.toISOString(), tokens_revoked: true };
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    try {
      if (acquired) await connection.query('SELECT RELEASE_LOCK(?) AS released', [key]);
      connection.release();
    } catch (error) {
      connection.destroy();
      if (!committed) throw error;
      console.error('Account erasure connection cleanup failed');
    }
  }
}

module.exports = { eraseAccount, erasedLogUserId, accountLockKey, AccountErasureError };
