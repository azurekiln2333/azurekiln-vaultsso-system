class UserAppUsageModel {
  constructor(pool) {
    this.pool = pool;
  }

  async record(userId, client, usedAt = new Date()) {
    await this.pool.execute(
      `INSERT INTO user_app_usage (user_id, client_id, client_name, first_used_at, last_used_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE client_name = VALUES(client_name),
         first_used_at = LEAST(first_used_at, VALUES(first_used_at)),
         last_used_at = GREATEST(last_used_at, VALUES(last_used_at))`,
      [userId, client.id, client.name, usedAt, usedAt]
    );
  }

  async findByUserId(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM user_app_usage WHERE user_id = ? ORDER BY last_used_at DESC, client_id ASC',
      [userId]
    );
    return rows;
  }

  async findAll() {
    const [rows] = await this.pool.execute(
      'SELECT * FROM user_app_usage ORDER BY user_id ASC, last_used_at DESC, client_id ASC'
    );
    return rows;
  }
}

module.exports = UserAppUsageModel;
