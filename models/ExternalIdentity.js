const crypto = require('crypto');

function normalize(value) {
  return String(value || '').trim();
}

function parseProfile(value) {
  if (!value) return {};
  if (typeof value === 'object') return Array.isArray(value) ? {} : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
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
    providerSecondaryId: row.provider_secondary_id || '',
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
       (id, user_id, provider, provider_user_id, provider_secondary_id, provider_username, display_name, avatar, email, profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        normalize(identityData.userId),
        normalize(identityData.provider).toLowerCase(),
        normalize(identityData.providerUserId),
        normalize(identityData.providerSecondaryId) || null,
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

  async findAll() {
    const [rows] = await this.pool.execute('SELECT * FROM user_identities ORDER BY user_id ASC, created_at ASC');
    return rows;
  }

  async findByProviders(providers) {
    if (!providers.length) return [];
    const [rows] = await this.pool.execute(`SELECT * FROM user_identities WHERE provider IN (${providers.map(() => '?').join(', ')})`, providers);
    return rows;
  }

  async findByProviderUserId(provider, providerUserId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM user_identities WHERE provider = ? AND provider_user_id = ?',
      [normalize(provider).toLowerCase(), normalize(providerUserId)]
    );
    return rows[0] || null;
  }

  // 第二标识（华为 openID 这类应用维度标识）同样需要唯一命中。
  async findByProviderSecondaryId(provider, providerSecondaryId) {
    const secondary = normalize(providerSecondaryId);
    if (!secondary) return null;
    const [rows] = await this.pool.execute(
      'SELECT * FROM user_identities WHERE provider = ? AND provider_secondary_id = ?',
      [normalize(provider).toLowerCase(), secondary]
    );
    return rows[0] || null;
  }

  // 主标识优先、第二标识兜底。两者都必须查，否则换配置或老数据会分裂账号。
  async findByProviderSubject(provider, providerUserId, providerSecondaryId = '') {
    const byPrimary = await this.findByProviderUserId(provider, providerUserId);
    const bySecondary = await this.findByProviderSecondaryId(provider, providerSecondaryId || providerUserId);
    const legacyPrimary = providerSecondaryId ? await this.findByProviderUserId(provider, providerSecondaryId) : null;
    const matches = [byPrimary, bySecondary, legacyPrimary].filter(Boolean);
    if (new Set(matches.map(row => row.user_id)).size > 1) {
      throw new Error('External account identifiers are bound to different users');
    }
    return matches[0] || null;
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
      providerSecondaryId: 'provider_secondary_id',
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
