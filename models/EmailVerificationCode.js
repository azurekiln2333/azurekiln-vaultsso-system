const crypto = require('crypto');

class EmailVerificationCodeModel {
  constructor(pool) {
    this.pool = pool;
  }

  async create(codeData) {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO email_verification_codes (id, email, user_id, purpose, code_hash, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, codeData.email, codeData.userId || null, codeData.purpose, codeData.codeHash, codeData.expiresAt]
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

  async incrementAttempts(id) {
    await this.pool.execute(
      'UPDATE email_verification_codes SET attempts = attempts + 1 WHERE id = ?',
      [id]
    );
  }

  async consume(id) {
    await this.pool.execute(
      'UPDATE email_verification_codes SET consumed_at = ? WHERE id = ?',
      [new Date(), id]
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
