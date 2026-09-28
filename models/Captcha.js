class CaptchaModel {
  constructor(pool) { this.pool = pool; }

  async create(id, answerHash, expiresAt) {
    await this.pool.execute('INSERT INTO captcha_challenges (id, answer_hash, expires_at) VALUES (?, ?, ?)', [id, answerHash, expiresAt]);
  }

  async consume(id) {
    const [rows] = await this.pool.execute('SELECT * FROM captcha_challenges WHERE id = ?', [id]);
    if (!rows[0]) return null;
    const [result] = await this.pool.execute('DELETE FROM captcha_challenges WHERE id = ? AND expires_at > ?', [id, new Date()]);
    return result.affectedRows === 1 ? rows[0] : null;
  }

  async deleteExpired() { await this.pool.execute('DELETE FROM captcha_challenges WHERE expires_at < ?', [new Date()]); }
}

module.exports = CaptchaModel;
