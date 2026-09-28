function normalize(value) {
  return String(value ?? '').trim();
}

function parseList(value) {
  if (Array.isArray(value)) return value.map(normalize).filter(Boolean);
  return normalize(value).split(/\s+/).filter(Boolean);
}

function serialize(row) {
  if (!row) return null;
  return {
    providerKey: row.provider_key,
    providerName: row.provider_name || row.provider_key,
    providerType: row.provider_type || 'oidc',
    enabled: Boolean(row.enabled),
    clientId: row.client_id || '',
    huaweiUnionScope: row.huawei_union_scope || '',
    clientSecret: row.client_secret || '',
    issuerUrl: row.issuer_url || '',
    discoveryUrl: row.discovery_url || '',
    authorizeUrl: row.authorize_url || '',
    tokenUrl: row.token_url || '',
    userinfoUrl: row.userinfo_url || '',
    jwksUrl: row.jwks_url || '',
    scopes: parseList(row.scopes),
    tokenAuthMethod: row.token_auth_method || 'client_secret_basic',
    clockTolerance: Number.isFinite(Number(row.clock_tolerance)) ? Number(row.clock_tolerance) : 60,
    allowedAlgorithms: parseList(row.allowed_algorithms),
    pkceEnabled: Boolean(row.pkce_enabled),
    validateIdToken: Boolean(row.validate_id_token),
    requireEmailVerified: Boolean(row.require_email_verified),
    userinfoEmailPath: row.userinfo_email_path || 'email',
    emailVerifiedPath: row.email_verified_path || 'email_verified',
    userinfoIdPath: row.userinfo_id_path || 'sub',
    userinfoSecondaryIdPath: row.userinfo_secondary_id_path || '',
    userinfoUsernamePath: row.userinfo_username_path || 'preferred_username',
    userinfoMethod: row.userinfo_method || 'GET',
    userinfoTokenIn: row.userinfo_token_in || 'header',
    frontendCallbackPath: row.frontend_callback_path || '/oauth2/success',
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null
  };
}

class OidcProviderModel {
  constructor(pool) { this.pool = pool; }

  async findAll() {
    const [rows] = await this.pool.execute('SELECT * FROM oidc_providers ORDER BY provider_key ASC');
    return rows;
  }

  async findByKey(providerKey) {
    const [rows] = await this.pool.execute('SELECT * FROM oidc_providers WHERE provider_key = ?', [normalize(providerKey).toLowerCase()]);
    return rows[0] || null;
  }

  async upsert(provider) {
    const values = [
      normalize(provider.providerKey).toLowerCase(), normalize(provider.providerName), normalize(provider.providerType) || 'oidc', provider.enabled !== false,
      normalize(provider.clientId), normalize(provider.clientSecret), normalize(provider.issuerUrl), normalize(provider.discoveryUrl),
      normalize(provider.authorizeUrl), normalize(provider.tokenUrl), normalize(provider.userinfoUrl), normalize(provider.jwksUrl),
      parseList(provider.scopes).join(' '), normalize(provider.tokenAuthMethod) || 'client_secret_basic', Number.isFinite(Number(provider.clockTolerance)) ? Number(provider.clockTolerance) : 60,
      parseList(provider.allowedAlgorithms).join(' '), provider.pkceEnabled !== false, provider.validateIdToken !== false,
      provider.requireEmailVerified === true, normalize(provider.userinfoEmailPath) || 'email', normalize(provider.emailVerifiedPath) || 'email_verified',
      normalize(provider.userinfoIdPath) || 'sub', normalize(provider.userinfoSecondaryIdPath), normalize(provider.userinfoUsernamePath) || 'preferred_username',
      normalize(provider.userinfoMethod) || 'GET', normalize(provider.userinfoTokenIn) || 'header', normalize(provider.frontendCallbackPath) || '/oauth2/success', normalize(provider.huaweiUnionScope)
    ];
    await this.pool.execute(
      `INSERT INTO oidc_providers
       (provider_key, provider_name, provider_type, enabled, client_id, client_secret, issuer_url, discovery_url, authorize_url, token_url,
        userinfo_url, jwks_url, scopes, token_auth_method, clock_tolerance, allowed_algorithms, pkce_enabled, validate_id_token,
        require_email_verified, userinfo_email_path, email_verified_path, userinfo_id_path, userinfo_secondary_id_path, userinfo_username_path,
        userinfo_method, userinfo_token_in, frontend_callback_path, huawei_union_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE provider_name = VALUES(provider_name), provider_type = VALUES(provider_type), enabled = VALUES(enabled), client_id = VALUES(client_id),
        client_secret = VALUES(client_secret), issuer_url = VALUES(issuer_url), discovery_url = VALUES(discovery_url),
        authorize_url = VALUES(authorize_url), token_url = VALUES(token_url), userinfo_url = VALUES(userinfo_url), jwks_url = VALUES(jwks_url),
        scopes = VALUES(scopes), token_auth_method = VALUES(token_auth_method), clock_tolerance = VALUES(clock_tolerance),
        allowed_algorithms = VALUES(allowed_algorithms), pkce_enabled = VALUES(pkce_enabled), validate_id_token = VALUES(validate_id_token),
        require_email_verified = VALUES(require_email_verified), userinfo_email_path = VALUES(userinfo_email_path),
        email_verified_path = VALUES(email_verified_path), userinfo_id_path = VALUES(userinfo_id_path),
        userinfo_secondary_id_path = VALUES(userinfo_secondary_id_path), userinfo_username_path = VALUES(userinfo_username_path),
        userinfo_method = VALUES(userinfo_method), userinfo_token_in = VALUES(userinfo_token_in),
        frontend_callback_path = VALUES(frontend_callback_path), huawei_union_scope = VALUES(huawei_union_scope)`, values);
    return this.findByKey(provider.providerKey);
  }

  async delete(providerKey) {
    await this.pool.execute('DELETE FROM oidc_providers WHERE provider_key = ?', [normalize(providerKey).toLowerCase()]);
  }

  serialize(row) { return serialize(row); }
}

module.exports = OidcProviderModel;
