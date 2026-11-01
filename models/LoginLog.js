const crypto = require('crypto');

// 合规要求（公安安全评估）：登录、注册日志需留存「用户ID、登录平台、登录类型、IP、
// 源端口、时间」不少于 365 天。字段名与含义在此固定，其他模块不要另起一套。
const RETENTION_DAYS = 365;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

class LoginLogModel {
  constructor(pool) {
    this.pool = pool;
  }

  // 合法的 result 取值。数据库列是 VARCHAR(32)，这里同时是写入白名单。
  static get RESULTS() {
    return [
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
  }

  normalizeResult(result) {
    return LoginLogModel.RESULTS.includes(result) ? result : 'invalid_credentials';
  }

  normalizeSourcePort(port) {
    const value = Number(port);
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  }

  async create({ username, userId = null, ip = '', userAgent = '', result, detail = '',
    platform = '', loginType = '', sourcePort = null }) {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO login_logs (id, username, user_id, ip, source_port, platform, login_type, user_agent, result, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, String(username || '-').slice(0, 255), userId, String(ip || '').slice(0, 64),
        this.normalizeSourcePort(sourcePort), String(platform || '').slice(0, 64),
        String(loginType || '').slice(0, 32), String(userAgent || '').slice(0, 255),
        this.normalizeResult(result), String(detail || '').slice(0, 255)]
    );
    return this.findById(id);
  }

  async findById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM login_logs WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async findRecentByUserId(userId, since) {
    const [rows] = await this.pool.execute(
      `SELECT id, username, user_id, ip, source_port, platform, login_type, user_agent, result, detail, created_at
       FROM login_logs WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC`,
      [userId, new Date(since)]
    );
    return rows;
  }

  async findRecent(limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const [rows] = await this.pool.execute(
      `SELECT id, username, user_id, ip, source_port, platform, login_type, user_agent, result, detail, created_at
       FROM login_logs ORDER BY created_at DESC LIMIT ?`,
      [safeLimit]
    );
    return rows;
  }

  // 保留期只删除确实超过 365 天的记录，不做更短的清理，也不做去标识化，
  // 否则无法满足「留痕不少于 365 天」的承诺。
  async deleteExpired(now = new Date()) {
    const cutoff = new Date(new Date(now).getTime() - RETENTION_MS);
    const [result] = await this.pool.execute('DELETE FROM login_logs WHERE created_at < ?', [cutoff]);
    return result?.affectedRows || 0;
  }
}

LoginLogModel.RETENTION_DAYS = RETENTION_DAYS;
LoginLogModel.RETENTION_MS = RETENTION_MS;

module.exports = LoginLogModel;
