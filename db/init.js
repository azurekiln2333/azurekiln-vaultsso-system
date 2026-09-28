const mysql = require('mysql2/promise');
const dbConfig = require('../config/database');
const { environment, validateDatabaseEnvironment } = require('../config/runtime');

const USER_ROLE_USER = 'user';

const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  avatar TEXT,
  description TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret VARCHAR(255) DEFAULT NULL,
  totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  totp_last_counter BIGINT NOT NULL DEFAULT -1,
  totp_revision BIGINT NOT NULL DEFAULT 0,
  captcha_required BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_codes TEXT,
  credits INT NOT NULL DEFAULT 0,
  last_login_ip VARCHAR(64) DEFAULT NULL,
  phone_country_code VARCHAR(4) DEFAULT NULL,
  phone_number VARCHAR(32) DEFAULT NULL,
  phone_e164 VARCHAR(40) GENERATED ALWAYS AS (CASE WHEN phone_country_code IS NULL OR phone_number IS NULL THEN NULL ELSE CONCAT('+', phone_country_code, phone_number) END) STORED,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified_at TIMESTAMP NULL DEFAULT NULL,
  role VARCHAR(32) NOT NULL DEFAULT '${USER_ROLE_USER}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_username (username),
  INDEX idx_email (email),
  UNIQUE KEY uq_users_phone_e164 (phone_e164)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_AUTHENTICATORS_TABLE = `
CREATE TABLE IF NOT EXISTS user_authenticators (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  name VARCHAR(64) NOT NULL,
  secret VARCHAR(255) NOT NULL,
  session_id VARCHAR(36) DEFAULT NULL,
  security_state CHAR(64) DEFAULT NULL,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  attempts INT NOT NULL DEFAULT 0,
  legacy_setup BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at TIMESTAMP NULL DEFAULT NULL,
  last_counter BIGINT NOT NULL DEFAULT -1,
  last_used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_authenticator_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_SETTINGS_TABLE = `
CREATE TABLE IF NOT EXISTS settings (
  setting_key VARCHAR(64) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_OIDC_PROVIDERS_TABLE = `
CREATE TABLE IF NOT EXISTS oidc_providers (
  provider_key VARCHAR(128) PRIMARY KEY,
  provider_name VARCHAR(255) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  client_id VARCHAR(255) NOT NULL,
  client_secret TEXT NOT NULL,
  issuer_url TEXT,
  discovery_url TEXT,
  authorize_url TEXT,
  token_url TEXT,
  userinfo_url TEXT,
  jwks_url TEXT,
  provider_type VARCHAR(32) NOT NULL DEFAULT 'oidc',
  huawei_union_scope VARCHAR(128) COLLATE utf8mb4_bin NOT NULL DEFAULT '',
  scopes TEXT NOT NULL,
  token_auth_method VARCHAR(32) NOT NULL DEFAULT 'client_secret_basic',
  clock_tolerance INT NOT NULL DEFAULT 60,
  allowed_algorithms VARCHAR(255),
  pkce_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  validate_id_token BOOLEAN NOT NULL DEFAULT TRUE,
  require_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  userinfo_email_path VARCHAR(255) NOT NULL DEFAULT 'email',
  email_verified_path VARCHAR(255) NOT NULL DEFAULT 'email_verified',
  userinfo_id_path VARCHAR(255) NOT NULL DEFAULT 'sub',
  userinfo_username_path VARCHAR(255) NOT NULL DEFAULT 'preferred_username',
  frontend_callback_path VARCHAR(255) NOT NULL DEFAULT '/oauth2/success',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_LOGIN_LOGS_TABLE = `
CREATE TABLE IF NOT EXISTS login_logs (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  user_id VARCHAR(36) NULL,
  ip VARCHAR(64),
  user_agent VARCHAR(255),
  result VARCHAR(32) NOT NULL,
  detail VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_login_logs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_CLIENTS_TABLE = `
CREATE TABLE IF NOT EXISTS clients (
  id VARCHAR(255) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  secret VARCHAR(255) NOT NULL,
  redirect_uris TEXT NOT NULL,
  scopes TEXT NOT NULL,
  logo_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  require_pkce BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_AUTH_CODES_TABLE = `
CREATE TABLE IF NOT EXISTS auth_codes (
  code VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  client_id VARCHAR(255) NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method VARCHAR(16),
  nonce VARCHAR(255),
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_client_id (client_id),
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_ACCESS_TOKENS_TABLE = `
CREATE TABLE IF NOT EXISTS access_tokens (
  id VARCHAR(36) PRIMARY KEY,
  token TEXT NOT NULL,
  user_id VARCHAR(36) NULL,
  client_id VARCHAR(255) NOT NULL,
  scopes TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_client_id (client_id),
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_REFRESH_TOKENS_TABLE = `
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id VARCHAR(36) PRIMARY KEY,
  token TEXT NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  client_id VARCHAR(255) NOT NULL,
  scopes TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_client_id (client_id),
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_USER_APP_USAGE_TABLE = `
CREATE TABLE IF NOT EXISTS user_app_usage (
  user_id VARCHAR(36) NOT NULL,
  client_id VARCHAR(255) NOT NULL,
  client_name VARCHAR(255) NOT NULL,
  first_used_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, client_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// Retained tokens provide actual usage evidence; expired or revoked history may already be absent.
const BACKFILL_USER_APP_USAGE = `
INSERT INTO user_app_usage (user_id, client_id, client_name, first_used_at, last_used_at)
SELECT evidence.user_id, evidence.client_id, clients.name,
       MIN(evidence.created_at), MAX(evidence.created_at)
FROM (
  SELECT user_id, client_id, created_at FROM access_tokens WHERE user_id IS NOT NULL
  UNION ALL
  SELECT user_id, client_id, created_at FROM refresh_tokens WHERE user_id IS NOT NULL
) AS evidence
INNER JOIN users ON users.id = evidence.user_id
INNER JOIN clients ON clients.id = evidence.client_id
GROUP BY evidence.user_id, evidence.client_id, clients.name
ON DUPLICATE KEY UPDATE
  first_used_at = LEAST(first_used_at, VALUES(first_used_at)),
  last_used_at = GREATEST(last_used_at, VALUES(last_used_at));
`;

const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  token VARCHAR(128) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  revoked_at TIMESTAMP NULL DEFAULT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_EMAIL_VERIFICATION_CODES_TABLE = `
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id VARCHAR(36) PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  user_id VARCHAR(36),
  purpose VARCHAR(32) NOT NULL,
  code_hash VARCHAR(128) NOT NULL,
  pending_context JSON DEFAULT NULL,
  attempts INT NOT NULL DEFAULT 0,
  consumed_at TIMESTAMP NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_email_purpose (email, purpose),
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

// A provider-neutral relation table keeps external identities out of users.
// Existing users are not altered; rows are added only when an identity is linked.
const CREATE_USER_IDENTITIES_TABLE = `
CREATE TABLE IF NOT EXISTS user_identities (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  provider VARCHAR(128) NOT NULL,
  provider_user_id VARCHAR(512) COLLATE utf8mb4_bin NOT NULL,
  provider_secondary_id VARCHAR(512) COLLATE utf8mb4_bin DEFAULT NULL,
  provider_username VARCHAR(255),
  display_name VARCHAR(255),
  avatar TEXT,
  email VARCHAR(255),
  profile JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_identity_provider_subject (provider, provider_user_id),
  UNIQUE KEY uq_user_identity_secondary_subject (provider, provider_secondary_id),
  INDEX idx_user_identities_user_id (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

let pool = null;

const SCHEMA_VERSION = 7;
const CREATE_SCHEMA_METADATA_TABLE = `CREATE TABLE IF NOT EXISTS schema_metadata (
  id TINYINT PRIMARY KEY, version INT NOT NULL
) ENGINE=InnoDB`;
const CREATE_RATE_LIMITS_TABLE = `CREATE TABLE IF NOT EXISTS rate_limits (
  rate_key CHAR(64) PRIMARY KEY,
  hits INT UNSIGNED NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_rate_limit_expiry (expires_at)
) ENGINE=InnoDB`;
const CREATE_CAPTCHA_TABLE = `CREATE TABLE IF NOT EXISTS captcha_challenges (
  id VARCHAR(36) PRIMARY KEY,
  answer_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  INDEX idx_captcha_expiry (expires_at)
) ENGINE=InnoDB`;

async function ensureUsersRoleColumn(connection) {
  const [columns] = await connection.query('SHOW COLUMNS FROM users LIKE ?', ['role']);
  if (columns.length > 0) {
    return;
  }

  await connection.query(
    `ALTER TABLE users ADD COLUMN role VARCHAR(32) NOT NULL DEFAULT '${USER_ROLE_USER}' AFTER email_verified`
  );
  console.log('✅ Added users.role column');
}

async function ensureColumn(connection, tableName, columnName, definition, afterColumn) {
  const [columns] = await connection.query(`SHOW COLUMNS FROM ${tableName} LIKE ?`, [columnName]);
  if (columns.length > 0) {
    return;
  }

  const afterClause = afterColumn ? ` AFTER ${afterColumn}` : '';
  await connection.query(`ALTER TABLE ${tableName} ADD COLUMN ${definition}${afterClause}`);
  console.log(`Added ${tableName}.${columnName} column`);
}

// 唯一索引必须显式存在，否则手机号与第二身份标识可能写入重复值。
async function ensureIndex(connection, tableName, indexName, definition) {
  const [rows] = await connection.query(`SHOW INDEX FROM ${tableName} WHERE Key_name = ?`, [indexName]);
  if (rows && rows.length > 0) {
    return;
  }

  await connection.query(`ALTER TABLE ${tableName} ADD ${definition}`);
  console.log(`Added index ${tableName}.${indexName}`);
}

async function initDatabase({ initializeSchema = false } = {}) {
  validateDatabaseEnvironment();
  const env = environment();
  const config = dbConfig[env === 'test' ? 'development' : env];
  
  pool = mysql.createPool(config);
  pool.on('connection', connection => {
    connection.query("SET time_zone = '+00:00'", error => { if (error) connection.destroy(); });
  });
  
  console.log('📦 Connecting to MySQL database...');
  
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('✅ Database connected successfully');
    if (!initializeSchema) {
      let rows;
      try {
        [rows] = await connection.query('SELECT version FROM schema_metadata WHERE id = 1');
      } catch {
        throw new Error('Database schema is not initialized. Run npm run init-db explicitly before starting the service');
      }
      if (Number(rows[0]?.version) !== SCHEMA_VERSION) {
        throw new Error('Database schema version mismatch. Run npm run init-db before starting the service');
      }
      return pool;
    }
    
    await connection.query(CREATE_USERS_TABLE);
    await connection.query(CREATE_AUTHENTICATORS_TABLE);
    await connection.query(CREATE_CLIENTS_TABLE);
    await connection.query(CREATE_AUTH_CODES_TABLE);
    await connection.query(CREATE_ACCESS_TOKENS_TABLE);
    await connection.query(CREATE_REFRESH_TOKENS_TABLE);
    await connection.query(CREATE_USER_APP_USAGE_TABLE);
    await connection.query(CREATE_SESSIONS_TABLE);
    await connection.query(CREATE_EMAIL_VERIFICATION_CODES_TABLE);
    await connection.query(CREATE_USER_IDENTITIES_TABLE);
    await connection.query(CREATE_SETTINGS_TABLE);
    await connection.query(CREATE_OIDC_PROVIDERS_TABLE);
    await connection.query(CREATE_LOGIN_LOGS_TABLE);
    await connection.query(CREATE_RATE_LIMITS_TABLE);
    await connection.query(CREATE_CAPTCHA_TABLE);
    await connection.query(CREATE_SCHEMA_METADATA_TABLE);
    await ensureUsersRoleColumn(connection);
    await ensureColumn(connection, 'clients', 'require_pkce', 'require_pkce BOOLEAN NOT NULL DEFAULT TRUE', 'is_active');
    await ensureColumn(connection, 'email_verification_codes', 'pending_context', 'pending_context JSON DEFAULT NULL', 'code_hash');
    await ensureColumn(connection, 'users', 'banned', 'banned BOOLEAN NOT NULL DEFAULT FALSE', 'email_verified');
    await ensureColumn(connection, 'users', 'totp_secret', 'totp_secret VARCHAR(64) DEFAULT NULL', 'banned');
    await ensureColumn(connection, 'users', 'totp_enabled', 'totp_enabled BOOLEAN NOT NULL DEFAULT FALSE', 'totp_secret');
    await ensureColumn(connection, 'users', 'totp_last_counter', 'totp_last_counter BIGINT NOT NULL DEFAULT -1', 'totp_enabled');
    await ensureColumn(connection, 'users', 'totp_revision', 'totp_revision BIGINT NOT NULL DEFAULT 0', 'totp_last_counter');
    await ensureColumn(connection, 'users', 'recovery_codes', 'recovery_codes TEXT', 'totp_enabled');
    await ensureColumn(connection, 'users', 'captcha_required', 'captcha_required BOOLEAN NOT NULL DEFAULT FALSE', 'totp_enabled');
    await ensureColumn(connection, 'sessions', 'token', 'token VARCHAR(128) NOT NULL', 'user_id');
    await ensureColumn(connection, 'sessions', 'revoked_at', 'revoked_at TIMESTAMP NULL DEFAULT NULL', 'user_agent');
    await ensureColumn(connection, 'login_logs', 'detail', 'detail VARCHAR(255)', 'result');
    await ensureColumn(connection, 'users', 'description', 'description TEXT', 'avatar');
    await ensureColumn(connection, 'users', 'credits', 'credits INT NOT NULL DEFAULT 0', 'banned');
    await ensureColumn(connection, 'users', 'last_login_ip', 'last_login_ip VARCHAR(64) DEFAULT NULL', 'credits');
    await ensureColumn(connection, 'auth_codes', 'code_challenge', 'code_challenge TEXT', 'scopes');
    await ensureColumn(connection, 'auth_codes', 'code_challenge_method', 'code_challenge_method VARCHAR(16)', 'code_challenge');
    await ensureColumn(connection, 'auth_codes', 'nonce', 'nonce VARCHAR(255)', 'code_challenge_method');
    await ensureColumn(connection, 'refresh_tokens', 'scopes', 'scopes TEXT', 'client_id');
    await connection.query('ALTER TABLE access_tokens MODIFY user_id VARCHAR(36) NULL');
    await ensureColumn(connection, 'users', 'phone_country_code', 'phone_country_code VARCHAR(4) DEFAULT NULL', 'last_login_ip');
    await ensureColumn(connection, 'users', 'phone_number', 'phone_number VARCHAR(32) DEFAULT NULL', 'phone_country_code');
    await ensureColumn(connection, 'users', 'phone_e164', "phone_e164 VARCHAR(40) GENERATED ALWAYS AS (CASE WHEN phone_country_code IS NULL OR phone_number IS NULL THEN NULL ELSE CONCAT('+', phone_country_code, phone_number) END) STORED", 'phone_number');
    await ensureColumn(connection, 'users', 'phone_verified', 'phone_verified BOOLEAN NOT NULL DEFAULT FALSE', 'phone_e164');
    await ensureColumn(connection, 'users', 'phone_verified_at', 'phone_verified_at TIMESTAMP NULL DEFAULT NULL', 'phone_verified');
    await ensureColumn(connection, 'user_identities', 'provider_secondary_id', 'provider_secondary_id VARCHAR(512) COLLATE utf8mb4_bin DEFAULT NULL', 'provider_user_id');
    await ensureColumn(connection, 'oidc_providers', 'provider_type', "provider_type VARCHAR(32) NOT NULL DEFAULT 'oidc'", 'enabled');
    await ensureColumn(connection, 'oidc_providers', 'huawei_union_scope', "huawei_union_scope VARCHAR(128) COLLATE utf8mb4_bin NOT NULL DEFAULT ''", 'provider_type');
    await ensureColumn(connection, 'oidc_providers', 'userinfo_secondary_id_path', 'userinfo_secondary_id_path VARCHAR(255) DEFAULT NULL', 'userinfo_id_path');
    await ensureColumn(connection, 'oidc_providers', 'userinfo_method', "userinfo_method VARCHAR(8) NOT NULL DEFAULT 'GET'", 'userinfo_username_path');
    await ensureColumn(connection, 'oidc_providers', 'userinfo_token_in', "userinfo_token_in VARCHAR(16) NOT NULL DEFAULT 'header'", 'userinfo_method');
    await ensureIndex(connection, 'users', 'uq_users_phone_e164', 'UNIQUE KEY uq_users_phone_e164 (phone_e164)');
    await ensureIndex(connection, 'user_identities', 'uq_user_identity_secondary_subject', 'UNIQUE KEY uq_user_identity_secondary_subject (provider, provider_secondary_id)');
    await connection.query('ALTER TABLE users MODIFY totp_secret VARCHAR(255) DEFAULT NULL');
    await connection.query('ALTER TABLE user_identities MODIFY provider_user_id VARCHAR(512) COLLATE utf8mb4_bin NOT NULL');
    await connection.query(BACKFILL_USER_APP_USAGE);
    await connection.query('INSERT INTO schema_metadata (id, version) VALUES (1, ?) ON DUPLICATE KEY UPDATE version = VALUES(version)', [SCHEMA_VERSION]);
    
    console.log('✅ Database tables initialized');
    
    return pool;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    throw error;
  } finally {
    if (connection) connection.release();
  }
}

function getPool() {
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('📦 Database connection closed');
  }
}

module.exports = {
  initDatabase,
  getPool,
  closePool,
  SCHEMA_VERSION
};
