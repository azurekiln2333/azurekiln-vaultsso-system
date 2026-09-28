const fs = require('node:fs');
const { resolveProjectPath } = require('./environment');
const tlsEnabled = String(process.env.DB_TLS || '').toLowerCase() === 'true';
const ssl = tlsEnabled ? {
  rejectUnauthorized: true,
  minVersion: 'TLSv1.2',
  ...(process.env.DB_TLS_CA_FILE ? { ca: fs.readFileSync(resolveProjectPath(process.env.DB_TLS_CA_FILE)) } : {})
} : undefined;

module.exports = {
  development: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vaultsso_oauth2',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 100,
    connectTimeout: 10000,
    timezone: 'Z',
    ssl
  },
  production: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 100,
    connectTimeout: 10000,
    timezone: 'Z',
    ssl
  }
};
