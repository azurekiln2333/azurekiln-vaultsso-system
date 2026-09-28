const crypto = require('crypto');

class TokenModel {
  constructor(pool) {
    this.pool = pool;
  }

  hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

  matchesToken(record, token) {
    if (!record || !/^[a-f0-9]{64}$/.test(record.token)) return false;
    return crypto.timingSafeEqual(Buffer.from(record.token, 'hex'), Buffer.from(this.hashToken(token), 'hex'));
  }

  async createAccessToken(data) {
    const id = data.id || crypto.randomUUID();
    
    await this.pool.execute(
      `INSERT INTO access_tokens (id, token, user_id, client_id, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, this.hashToken(data.token), data.userId, data.clientId, JSON.stringify(data.scopes), data.expiresAt]
    );
    
    return this.findAccessTokenById(id);
  }

  async findAccessTokenById(id) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM access_tokens WHERE id = ?',
      [id]
    );
    
    if (!rows[0]) return null;
    
    return {
      ...rows[0],
      scopes: JSON.parse(rows[0].scopes)
    };
  }

  async findAccessTokenByToken(token) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM access_tokens WHERE token = ?',
      [this.hashToken(token)]
    );
    
    if (!rows[0]) return null;
    
    return {
      ...rows[0],
      scopes: JSON.parse(rows[0].scopes)
    };
  }

  async findAccessTokensByUser(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    
    return rows.map(row => ({
      ...row,
      scopes: JSON.parse(row.scopes)
    }));
  }

  async findAllAccessTokens() {
    const [rows] = await this.pool.execute(
      `SELECT at.*, u.name as user_name, u.email as user_email, c.name as client_name
       FROM access_tokens at
       LEFT JOIN users u ON at.user_id = u.id
       LEFT JOIN clients c ON at.client_id = c.id
       ORDER BY at.created_at DESC`
    );
    
    return rows.map(row => ({
      ...row,
      scopes: JSON.parse(row.scopes)
    }));
  }

  async deleteAccessToken(id) {
    await this.pool.execute('DELETE FROM access_tokens WHERE id = ?', [id]);
    return true;
  }

  async deleteAccessTokensByUser(userId) {
    await this.pool.execute('DELETE FROM access_tokens WHERE user_id = ?', [userId]);
    return true;
  }

  async createRefreshToken(data) {
    const id = data.id || crypto.randomUUID();
    
    await this.pool.execute(
      `INSERT INTO refresh_tokens (id, token, user_id, client_id, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, this.hashToken(data.token), data.userId, data.clientId, JSON.stringify(data.scopes || []), data.expiresAt]
    );
    
    return this.findRefreshTokenById(id);
  }

  async findRefreshTokenById(id) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM refresh_tokens WHERE id = ?',
      [id]
    );
    
    if (!rows[0]) return null;

    return {
      ...rows[0],
      scopes: rows[0].scopes ? JSON.parse(rows[0].scopes) : []
    };
  }

  async findRefreshTokenByToken(token) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM refresh_tokens WHERE token = ?',
      [this.hashToken(token)]
    );
    
    if (!rows[0]) return null;

    return {
      ...rows[0],
      scopes: rows[0].scopes ? JSON.parse(rows[0].scopes) : []
    };
  }

  async deleteRefreshToken(id) {
    await this.pool.execute('DELETE FROM refresh_tokens WHERE id = ?', [id]);
    return true;
  }

  async consumeRefreshToken(id) {
    const [result] = await this.pool.execute('DELETE FROM refresh_tokens WHERE id = ? AND expires_at > ?', [id, new Date()]);
    return result.affectedRows === 1;
  }

  async createAuthCode(data) {
    const code = data.code || crypto.randomUUID();
    
    await this.pool.execute(
      `INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, scopes, code_challenge, code_challenge_method, nonce, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        code,
        data.userId,
        data.clientId,
        data.redirectUri,
        JSON.stringify(data.scopes),
        data.codeChallenge || null,
        data.codeChallengeMethod || null,
        data.nonce || null,
        data.expiresAt
      ]
    );
    
    return this.findAuthCode(code);
  }

  async findAuthCode(code) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM auth_codes WHERE code = ?',
      [code]
    );
    
    if (!rows[0]) return null;
    
    return {
      ...rows[0],
      scopes: JSON.parse(rows[0].scopes)
    };
  }

  async deleteAuthCode(code) {
    await this.pool.execute('DELETE FROM auth_codes WHERE code = ?', [code]);
    return true;
  }

  async consumeAuthCode(code) {
    const [result] = await this.pool.execute('DELETE FROM auth_codes WHERE code = ? AND expires_at > ?', [code, new Date()]);
    return result.affectedRows === 1;
  }

  async revokeByUser(userId) {
    for (const table of ['access_tokens', 'refresh_tokens', 'auth_codes']) {
      await this.pool.execute(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
    }
  }

  async revokeByClient(clientId, { preserveAuthCodes = false } = {}) {
    const tables = preserveAuthCodes ? ['access_tokens', 'refresh_tokens'] : ['access_tokens', 'refresh_tokens', 'auth_codes'];
    for (const table of tables) {
      await this.pool.execute(`DELETE FROM ${table} WHERE client_id = ?`, [clientId]);
    }
  }

  async cleanExpiredTokens() {
    const now = new Date();
    
    const [accessResult] = await this.pool.execute(
      'DELETE FROM access_tokens WHERE expires_at < ?',
      [now]
    );
    
    const [refreshResult] = await this.pool.execute(
      'DELETE FROM refresh_tokens WHERE expires_at < ?',
      [now]
    );
    
    const [authCodeResult] = await this.pool.execute(
      'DELETE FROM auth_codes WHERE expires_at < ?',
      [now]
    );
    
    console.log(`🧹 Cleaned expired tokens: ${accessResult.affectedRows} access, ${refreshResult.affectedRows} refresh, ${authCodeResult.affectedRows} auth codes`);
    
    return {
      accessTokens: accessResult.affectedRows,
      refreshTokens: refreshResult.affectedRows,
      authCodes: authCodeResult.affectedRows
    };
  }
}

module.exports = TokenModel;
