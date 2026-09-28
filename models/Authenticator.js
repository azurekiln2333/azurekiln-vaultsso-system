const crypto = require('crypto');
const UserModel = require('./User');

class AuthenticatorModel {
  constructor(pool) { this.pool = pool; }

  // Hold a database lock and transaction across each account's credential lifecycle.
  async withUser(userId, work) {
    const connection = await this.pool.getConnection();
    const key = `totp:${crypto.createHash('sha256').update(userId).digest('hex').slice(0, 48)}`;
    let acquired = false;
    try {
      const [locks] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [key]);
      if (Number(locks[0]?.acquired) !== 1) throw new Error('Authenticator account lock unavailable');
      acquired = true;
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
      const result = await work(rows[0] || null, new AuthenticatorModel(connection), new UserModel(connection), connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      try {
        if (acquired) await connection.query('SELECT RELEASE_LOCK(?) AS released', [key]);
      } finally {
        connection.release();
      }
    }
  }

  async list(userId) {
    const [rows] = await this.pool.execute('SELECT * FROM user_authenticators WHERE user_id = ? ORDER BY created_at, id', [userId]);
    return rows;
  }

  async stage(data) {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO user_authenticators (id, user_id, name, secret, session_id, security_state, expires_at, legacy_setup)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.userId, data.name, data.secret, data.sessionId, data.securityState, data.expiresAt, Boolean(data.legacySetup)]
    );
    return id;
  }

  async failedAttempt(id) {
    await this.pool.execute('UPDATE user_authenticators SET attempts = attempts + 1 WHERE id = ? AND activated_at IS NULL', [id]);
  }

  async activate(id, counter) {
    await this.pool.execute(
      'UPDATE user_authenticators SET activated_at = ?, last_counter = ?, last_used_at = ?, session_id = NULL, security_state = NULL, expires_at = NULL WHERE id = ? AND activated_at IS NULL',
      [new Date(), counter, new Date(), id]
    );
  }

  async consumeCounter(id, counter) {
    const [result] = await this.pool.execute(
      'UPDATE user_authenticators SET last_counter = ?, last_used_at = ? WHERE id = ? AND activated_at IS NOT NULL AND last_counter < ?',
      [counter, new Date(), id, counter]
    );
    return result.affectedRows === 1;
  }

  async remove(userId, id) {
    await this.pool.execute('DELETE FROM user_authenticators WHERE user_id = ? AND id = ?', [userId, id]);
  }

  async clearPending(userId) {
    await this.pool.execute('DELETE FROM user_authenticators WHERE user_id = ? AND activated_at IS NULL', [userId]);
  }

  async clear(userId) {
    await this.pool.execute('DELETE FROM user_authenticators WHERE user_id = ?', [userId]);
  }

  static project(user, rows) {
    const devices = rows.filter(row => row.activated_at).map(row => ({
      id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at || null
    }));
    if (user.totp_enabled && user.totp_secret) devices.unshift({
      id: 'legacy', name: '', createdAt: null, lastUsedAt: null
    });
    return devices;
  }
}

module.exports = AuthenticatorModel;
