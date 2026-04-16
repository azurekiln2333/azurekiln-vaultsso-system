const { v4: uuidv4 } = require('uuid');

class TokenModel {
  constructor(pool) {
    this.pool = pool;
  }

  async createAccessToken(data) {
    const id = data.id || uuidv4();
    
    await this.pool.execute(
      `INSERT INTO access_tokens (id, token, user_id, client_id, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.token, data.userId, data.clientId, JSON.stringify(data.scopes), data.expiresAt]
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
      [token]
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
    const id = data.id || uuidv4();
    
    await this.pool.execute(
      `INSERT INTO refresh_tokens (id, token, user_id, client_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, data.token, data.userId, data.clientId, data.expiresAt]
    );
    
    return this.findRefreshTokenById(id);
  }

  async findRefreshTokenById(id) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM refresh_tokens WHERE id = ?',
      [id]
    );
    
    return rows[0] || null;
  }

  async findRefreshTokenByToken(token) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM refresh_tokens WHERE token = ?',
      [token]
    );
    
    return rows[0] || null;
  }

  async deleteRefreshToken(id) {
    await this.pool.execute('DELETE FROM refresh_tokens WHERE id = ?', [id]);
    return true;
  }

  async createAuthCode(data) {
    const code = data.code || uuidv4();
    
    await this.pool.execute(
      `INSERT INTO auth_codes (code, user_id, client_id, redirect_uri, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [code, data.userId, data.clientId, data.redirectUri, JSON.stringify(data.scopes), data.expiresAt]
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
