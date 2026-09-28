const { hashClientSecret } = require('../services/client-secrets');

function deserializeClient(row) {
  return {
    ...row,
    requirePkce: row.require_pkce === undefined ? true : Boolean(row.require_pkce),
    redirectUris: JSON.parse(row.redirect_uris),
    scopes: JSON.parse(row.scopes)
  };
}

class ClientModel {
  constructor(pool) {
    this.pool = pool;
  }

  async create(clientData) {
    const [result] = await this.pool.execute(
      `INSERT INTO clients (id, name, secret, redirect_uris, scopes, logo_url, is_active, require_pkce)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clientData.id,
        clientData.name,
        await hashClientSecret(clientData.secret),
        JSON.stringify(clientData.redirectUris),
        JSON.stringify(clientData.scopes),
        clientData.logoUrl || null,
        clientData.isActive !== false,
        clientData.requirePkce !== false
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
    
    return deserializeClient(rows[0]);
  }

  async findAll() {
    const [rows] = await this.pool.execute(
      'SELECT * FROM clients ORDER BY created_at DESC'
    );
    
    return rows.map(deserializeClient);
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
      values.push(await hashClientSecret(clientData.secret));
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
    if (clientData.requirePkce !== undefined) {
      fields.push('require_pkce = ?');
      values.push(clientData.requirePkce);
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
