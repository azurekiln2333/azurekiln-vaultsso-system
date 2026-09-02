const crypto = require('crypto');

function normalize(value) {
  return String(value || '').trim();
}

function parseProfile(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return {};
  }
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    providerUsername: row.provider_username || '',
    displayName: row.display_name || '',
    avatar: row.avatar || '',
    email: row.email || '',
    profile: parseProfile(row.profile),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

class ExternalIdentityModel {
  constructor(pool) {
    this.pool = pool;
  }

  async create(identityData) {
    const id = crypto.randomUUID();
    await this.pool.execute(
      `INSERT INTO user_identities
       (id, user_id, provider, provider_user_id, provider_username, display_name, avatar, email, profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalize(identityData.userId),
        normalize(identityData.provider).toLowerCase(),
        normalize(identityData.providerUserId),
        normalize(identityData.providerUsername),
        normalize(identityData.displayName),
        normalize(identityData.avatar),
        normalize(identityData.email).toLowerCase(),
        JSON.stringify(identityData.profile || {})
      ]
    );
    return this.findById(id);
  }

  async findById(id) {
    const [rows] = await this.pool.execute('SELECT * FROM user_identities WHERE id = ?', [id]);
    return rows[0] || null;
  }

  async findByProviderUserId(provider, providerUserId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM user_identities WHERE provider = ? AND provider_user_id = ?',
      [normalize(provider).toLowerCase(), normalize(providerUserId)]
    );
    return rows[0] || null;
  }

  async findByUserId(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at ASC',
      [userId]
    );
    return rows;
  }

  async update(id, identityData) {
    const fields = [];
    const values = [];
    const mappings = {
      providerUsername: 'provider_username',
      displayName: 'display_name',
      avatar: 'avatar',
      email: 'email'
    };

    for (const [key, column] of Object.entries(mappings)) {
      if (identityData[key] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(key === 'email' ? normalize(identityData[key]).toLowerCase() : normalize(identityData[key]));
      }
    }
    if (identityData.profile !== undefined) {
      fields.push('profile = ?');
      values.push(JSON.stringify(identityData.profile || {}));
    }
    if (!fields.length) return this.findById(id);

    values.push(id);
    await this.pool.execute(`UPDATE user_identities SET ${fields.join(', ')} WHERE id = ?`, values);
    return this.findById(id);
  }

  async delete(id) {
    await this.pool.execute('DELETE FROM user_identities WHERE id = ?', [id]);
    return true;
  }

  serialize(row) {
    return serialize(row);
  }

  serializeMany(rows) {
    return rows.map(serialize);
  }
}

module.exports = ExternalIdentityModel;
