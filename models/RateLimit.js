const crypto = require('node:crypto');

class RateLimitModel {
  constructor(pool) { this.pool = pool; }

  key(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

  async check(key, limit) {
    const [rows] = await this.pool.execute('SELECT hits, expires_at FROM rate_limits WHERE rate_key = ?', [this.key(key)]);
    const row = rows[0];
    if (!row || new Date(row.expires_at) <= new Date()) return { allowed: true, remaining: limit, retryAfter: 0 };
    return { allowed: Number(row.hits) < limit, remaining: Math.max(0, limit - Number(row.hits)),
      retryAfter: Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000)) };
  }

  async consume(key, limit, windowMs) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + windowMs);
    const id = this.key(key);
    await this.pool.execute(
      `INSERT INTO rate_limits (rate_key, hits, expires_at) VALUES (?, 1, ?)
       ON DUPLICATE KEY UPDATE hits = IF(expires_at <= ?, 1, hits + 1),
       expires_at = IF(expires_at <= ?, VALUES(expires_at), expires_at)`,
      [id, expiresAt, now, now]
    );
    const [rows] = await this.pool.execute('SELECT hits, expires_at FROM rate_limits WHERE rate_key = ?', [id]);
    const row = rows[0];
    if (!row) throw new Error('Rate limit state unavailable');
    return { allowed: Number(row.hits) <= limit, remaining: Math.max(0, limit - Number(row.hits)), retryAfter: Math.max(1, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1000)) };
  }

  async clear(key) { await this.pool.execute('DELETE FROM rate_limits WHERE rate_key = ?', [this.key(key)]); }
  async deleteExpired() { await this.pool.execute('DELETE FROM rate_limits WHERE expires_at < ?', [new Date()]); }
}

module.exports = RateLimitModel;
