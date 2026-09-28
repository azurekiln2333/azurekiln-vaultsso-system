const crypto = require('crypto');

class SessionModel {
  constructor(pool) {
    this.pool = pool;
  }

  async create({ userId, token, ip = '', userAgent = '', expiresAt }) {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO sessions (id, user_id, token, ip_address, user_agent, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, userId, token, String(ip || '').slice(0, 45), String(userAgent || '').slice(0, 255), new Date(expiresAt)]
    );
    return this.findById(id);
  }

  async findById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM sessions WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async findActiveTokenByToken(token) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM sessions WHERE token = ? AND revoked_at IS NULL AND expires_at > ?',
      [token, new Date()]
    );
    return rows[0] || null;
  }

  async findActiveByUserId(userId) {
    const [rows] = await this.pool.execute(
      `SELECT id, user_id, token, ip_address, user_agent, created_at, expires_at FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
      [userId, new Date()]
    );
    return rows;
  }

  async revoke(id) {
    await this.pool.execute('UPDATE sessions SET revoked_at = ? WHERE id = ?', [new Date(), id]);
  }

  async extend(id, expiresAt) {
    const [result] = await this.pool.execute(
      'UPDATE sessions SET expires_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?',
      [new Date(expiresAt), id, new Date()]
    );
    return result.affectedRows === 1;
  }

  async revokeAllForUser(userId, exceptSessionId = null) {
    if (exceptSessionId) {
      await this.pool.execute(
        'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id <> ?',
        [new Date(), userId, exceptSessionId]
      );
      return;
    }
    await this.pool.execute(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [new Date(), userId]
    );
  }

  async deleteExpired() {
    await this.pool.execute('DELETE FROM sessions WHERE expires_at < ?', [new Date()]);
  }
}

module.exports = SessionModel;
