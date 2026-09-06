const crypto = require('crypto');

class LoginLogModel {
  constructor(pool) {
    this.pool = pool;
  }

  normalizeResult(result) {
    const allowed = [
      'success',
      'invalid_credentials',
      'banned',
      'password_not_set',
      'locked',
      'captcha_failed',
      'email_code_required',
      'email_code_invalid',
      'totp_required',
      'totp_invalid',
      'register',
      'admin_action',
      'anomaly_detected'
    ];
    return allowed.includes(result) ? result : 'invalid_credentials';
  }

  async create({ username, userId = null, ip = '', userAgent = '', result, detail = '' }) {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO login_logs (id, username, user_id, ip, user_agent, result, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, String(username || '-').slice(0, 255), userId, String(ip || '').slice(0, 64), String(userAgent || '').slice(0, 255), this.normalizeResult(result), String(detail || '').slice(0, 255)]
    );
    return this.findById(id);
  }

  async findById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM login_logs WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async findRecentByUserId(userId, since) {
    const [rows] = await this.pool.execute(
      `SELECT id, username, user_id, ip, user_agent, result, detail, created_at FROM login_logs
       WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC`,
      [userId, new Date(since)]
    );
    return rows;
  }

  async findRecent(limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const [rows] = await this.pool.execute(
      'SELECT id, username, user_id, ip, user_agent, result, detail, created_at FROM login_logs ORDER BY created_at DESC LIMIT ?',
      [safeLimit]
    );
    return rows;
  }
}

module.exports = LoginLogModel;
