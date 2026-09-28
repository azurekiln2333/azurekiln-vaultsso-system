const crypto = require('crypto');

class EmailVerificationCodeModel {
  constructor(pool) {
    this.pool = pool;
  }

  async create(codeData) {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO email_verification_codes (id, email, user_id, purpose, code_hash, expires_at, pending_context)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, codeData.email, codeData.userId || null, codeData.purpose, codeData.codeHash, codeData.expiresAt,
        codeData.pendingContext == null ? null : JSON.stringify(codeData.pendingContext)]
    );
    return this.findById(id);
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM email_verification_codes WHERE id = ?',
      [id]
    );
    return rows[0] || null;
  }

  async findLatestActive(email, purpose, now = new Date()) {
    const [rows] = await this.pool.execute(
      `SELECT * FROM email_verification_codes
       WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [email, purpose, now]
    );
    return rows[0] || null;
  }

  async incrementAttempts(id, maxAttempts) {
    const [result] = await this.pool.execute(
      'UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND attempts < ? AND expires_at > ?',
      [id, maxAttempts, new Date()]
    );
    return result.affectedRows === 1;
  }

  async consume(id) {
    const [result] = await this.pool.execute(
      'UPDATE email_verification_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?',
      [new Date(), id, new Date()]
    );
    return result.affectedRows === 1;
  }

  async invalidate(email, purpose) {
    await this.pool.execute(
      'UPDATE email_verification_codes SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL',
      [new Date(), email, purpose]
    );
  }

  async deleteExpired(now = new Date()) {
    await this.pool.execute(
      'DELETE FROM email_verification_codes WHERE expires_at < ? OR consumed_at IS NOT NULL',
      [now]
    );
  }
}

module.exports = EmailVerificationCodeModel;
