const mysql = require('mysql2/promise');
const dbConfig = require('../config/database');

const USER_ROLE_ADMIN = 'admin';
const USER_ROLE_USER = 'user';

const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  avatar TEXT,
  email_verified BOOLEAN DEFAULT FALSE,
  role VARCHAR(32) NOT NULL DEFAULT '${USER_ROLE_USER}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_username (username),
  INDEX idx_email (email)
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
  user_id VARCHAR(36) NOT NULL,
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
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_client_id (client_id),
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  token TEXT NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

let pool = null;

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

async function ensureAdminUser(connection) {
  const [adminRows] = await connection.query(
    'SELECT id, email FROM users WHERE role = ? LIMIT 1',
    [USER_ROLE_ADMIN]
  );

  if (adminRows.length > 0) {
    return;
  }

  const configuredAdminEmail = String(process.env.ADMIN_EMAIL || process.env.BOOTSTRAP_ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();

  if (configuredAdminEmail) {
    const [configuredUsers] = await connection.query(
      'SELECT id, email FROM users WHERE LOWER(email) = ? LIMIT 1',
      [configuredAdminEmail]
    );

    if (configuredUsers.length > 0) {
      await connection.query(
        'UPDATE users SET role = ? WHERE id = ?',
        [USER_ROLE_ADMIN, configuredUsers[0].id]
      );
      console.log(`✅ Promoted configured admin user: ${configuredUsers[0].email}`);
      return;
    }
  }

  const [firstUsers] = await connection.query(
    'SELECT id, email FROM users ORDER BY created_at ASC, id ASC LIMIT 1'
  );

  if (firstUsers.length === 0) {
    return;
  }

  await connection.query(
    'UPDATE users SET role = ? WHERE id = ?',
    [USER_ROLE_ADMIN, firstUsers[0].id]
  );
  console.log(`✅ Promoted bootstrap admin user: ${firstUsers[0].email}`);
}

async function initDatabase() {
  const env = process.env.NODE_ENV || 'development';
  const config = dbConfig[env];
  
  pool = mysql.createPool(config);
  
  console.log('📦 Connecting to MySQL database...');
  
  try {
    const connection = await pool.getConnection();
    console.log('✅ Database connected successfully');
    
    await connection.query(CREATE_USERS_TABLE);
    await connection.query(CREATE_CLIENTS_TABLE);
    await connection.query(CREATE_AUTH_CODES_TABLE);
    await connection.query(CREATE_ACCESS_TOKENS_TABLE);
    await connection.query(CREATE_REFRESH_TOKENS_TABLE);
    await connection.query(CREATE_SESSIONS_TABLE);
    await ensureUsersRoleColumn(connection);
    await ensureAdminUser(connection);
    
    console.log('✅ Database tables initialized');
    
    connection.release();
    return pool;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    throw error;
  }
}

function getPool() {
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    console.log('📦 Database connection closed');
  }
}

module.exports = {
  initDatabase,
  getPool,
  closePool
};
