const { v4: uuidv4 } = require('uuid');

class ClientModel {
  constructor(pool) {
    this.pool = pool;
  }

  async create(clientData) {
    const [result] = await this.pool.execute(
      `INSERT INTO clients (id, name, secret, redirect_uris, scopes, logo_url, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        clientData.id,
        clientData.name,
        clientData.secret,
        JSON.stringify(clientData.redirectUris),
        JSON.stringify(clientData.scopes),
        clientData.logoUrl || null,
        clientData.isActive !== false
      ]
    );
    
    return this.findById(clientData.id);
  }

  async findById(id) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM clients WHERE id = ?',
      [id]
    );
    
    if (!rows[0]) return null;
    
    return {
      ...rows[0],
      redirectUris: JSON.parse(rows[0].redirect_uris),
      scopes: JSON.parse(rows[0].scopes)
    };
  }

  async findAll() {
    const [rows] = await this.pool.execute(
      'SELECT * FROM clients ORDER BY created_at DESC'
    );
    
    return rows.map(row => ({
      ...row,
      redirectUris: JSON.parse(row.redirect_uris),
      scopes: JSON.parse(row.scopes)
    }));
  }

  async update(id, clientData) {
    const fields = [];
    const values = [];
    
    if (clientData.name) {
      fields.push('name = ?');
      values.push(clientData.name);
    }
    if (clientData.secret) {
      fields.push('secret = ?');
      values.push(clientData.secret);
    }
    if (clientData.redirectUris) {
      fields.push('redirect_uris = ?');
      values.push(JSON.stringify(clientData.redirectUris));
    }
    if (clientData.scopes) {
      fields.push('scopes = ?');
      values.push(JSON.stringify(clientData.scopes));
    }
    if (clientData.logoUrl !== undefined) {
      fields.push('logo_url = ?');
      values.push(clientData.logoUrl);
    }
    if (clientData.isActive !== undefined) {
      fields.push('is_active = ?');
      values.push(clientData.isActive);
    }
    
    if (fields.length === 0) return this.findById(id);
    
    values.push(id);
    await this.pool.execute(
      `UPDATE clients SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    
    return this.findById(id);
  }

  async delete(id) {
    await this.pool.execute('DELETE FROM clients WHERE id = ?', [id]);
    return true;
  }

  async validateRedirectUri(clientId, redirectUri) {
    const client = await this.findById(clientId);
    if (!client) return false;
    return client.redirectUris.includes(redirectUri);
  }
}

module.exports = ClientModel;
