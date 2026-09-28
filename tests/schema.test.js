const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { initDatabase, closePool, SCHEMA_VERSION } = require('../db/init');
const { createMemoryPool } = require('./support/memory-db');

test('normal database startup only reads schema metadata; explicit initialization never provisions identities', async () => {
  const statements = [];
  let released = 0;
  const original = mysql.createPool;
  mysql.createPool = () => ({
    on() {},
    async getConnection() { return {
      async query(sql, params = []) {
        statements.push(sql);
        if (sql.startsWith('SELECT version')) return [[{ version: SCHEMA_VERSION }]];
        if (sql.startsWith('SHOW COLUMNS FROM clients') && params[0] === 'require_pkce') return [[]];
        if (sql.startsWith('SHOW COLUMNS FROM oidc_providers') && params[0] === 'huawei_union_scope') return [[]];
        if (sql.startsWith('SHOW COLUMNS FROM email_verification_codes') && params[0] === 'pending_context') return [[]];
        if (sql.startsWith('SHOW COLUMNS')) return [[{ Field: 'present' }]];
        return [{ affectedRows: 0 }];
      },
      release() { released++; }
    }; },
    async end() {}
  });
  const previousDriver = process.env.DB_DRIVER;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.DB_DRIVER = 'mysql';
  try {
    await initDatabase();
    assert.deepEqual(statements, ['SELECT version FROM schema_metadata WHERE id = 1']);
    await closePool();
    statements.length = 0;
    await initDatabase({ initializeSchema: true });
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS users/i.test(sql)));
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS captcha_challenges/i.test(sql)));
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS clients[\s\S]*require_pkce BOOLEAN NOT NULL DEFAULT TRUE/i.test(sql)));
    assert.ok(statements.some(sql => /ALTER TABLE clients ADD COLUMN require_pkce BOOLEAN NOT NULL DEFAULT TRUE AFTER is_active/i.test(sql)));
    assert.equal(SCHEMA_VERSION, 7);
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS user_authenticators[\s\S]*secret VARCHAR\(255\)[\s\S]*FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i.test(sql)));
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS users[\s\S]*totp_revision BIGINT NOT NULL DEFAULT 0/i.test(sql)));
    const usageCreate = statements.find(sql => /CREATE TABLE IF NOT EXISTS user_app_usage/i.test(sql));
    assert.match(usageCreate, /PRIMARY KEY \(user_id, client_id\)/i);
    assert.match(usageCreate, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i);
    assert.doesNotMatch(usageCreate, /REFERENCES clients/i);
    const usageBackfill = statements.find(sql => /INSERT INTO user_app_usage[\s\S]*SELECT evidence.user_id/i.test(sql));
    assert.match(usageBackfill, /MIN\(evidence.created_at\), MAX\(evidence.created_at\)/i);
    assert.match(usageBackfill, /FROM access_tokens WHERE user_id IS NOT NULL[\s\S]*UNION ALL[\s\S]*FROM refresh_tokens WHERE user_id IS NOT NULL/i);
    assert.doesNotMatch(usageBackfill, /auth_codes|CURRENT_TIMESTAMP|NOW\(\)/i);
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS email_verification_codes[\s\S]*pending_context JSON DEFAULT NULL/i.test(sql)));
    assert.ok(statements.some(sql => /ALTER TABLE email_verification_codes ADD COLUMN pending_context JSON DEFAULT NULL AFTER code_hash/i.test(sql)));
    assert.ok(statements.some(sql => /CREATE TABLE IF NOT EXISTS oidc_providers[\s\S]*huawei_union_scope VARCHAR\(128\) COLLATE utf8mb4_bin NOT NULL DEFAULT ''/i.test(sql)));
    assert.ok(statements.some(sql => /ALTER TABLE oidc_providers ADD COLUMN huawei_union_scope VARCHAR\(128\) COLLATE utf8mb4_bin NOT NULL DEFAULT '' AFTER provider_type/i.test(sql)));
    for (const sql of statements) {
      assert.doesNotMatch(sql, /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:users|clients|oidc_providers|user_identities)\b/i);
    }
    assert.equal(released, 2);
    await closePool();
    process.env.DB_DRIVER = 'memory';
    await assert.rejects(initDatabase(), /only supports DB_DRIVER=mysql/);
  } finally {
    mysql.createPool = original;
    if (previousDriver === undefined) delete process.env.DB_DRIVER; else process.env.DB_DRIVER = previousDriver;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
  }
});

test('explicit usage backfill combines retained token timestamps and preserves history across repeated migrations', async () => {
  const database = createMemoryPool();
  database.users.push({ id: 'owner' });
  database.clients.push({ id: 'app', name: 'Real application' });
  database.accessTokens.push(
    { user_id: 'owner', client_id: 'app', created_at: '2025-01-02T00:00:00Z' },
    { user_id: null, client_id: 'app', created_at: '2024-01-01T00:00:00Z' }
  );
  database.refreshTokens.push({ user_id: 'owner', client_id: 'app', created_at: '2025-01-05T00:00:00Z' });
  database.authCodes.push({ user_id: 'owner', client_id: 'app', created_at: '2024-01-01T00:00:00Z' });
  const original = mysql.createPool;
  const previousDriver = process.env.DB_DRIVER;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.DB_DRIVER = 'mysql';
  mysql.createPool = () => ({
    on() {}, async end() {},
    async getConnection() { return {
      release() {},
      async query(sql) {
        if (/INSERT INTO user_app_usage/i.test(sql)) return database.query(sql);
        if (sql.startsWith('SHOW COLUMNS') || sql.startsWith('SHOW INDEX')) return [[{ Field: 'present' }]];
        return [{ affectedRows: 0 }];
      }
    }; }
  });
  try {
    await initDatabase({ initializeSchema: true });
    assert.equal(database.userAppUsage.length, 1);
    assert.equal(database.userAppUsage[0].first_used_at, '2025-01-02T00:00:00Z');
    assert.equal(database.userAppUsage[0].last_used_at, '2025-01-05T00:00:00Z');
    database.userAppUsage[0].last_used_at = '2025-02-01T00:00:00Z';
    database.refreshTokens.length = 0;
    await closePool();
    await initDatabase({ initializeSchema: true });
    assert.equal(database.userAppUsage.length, 1);
    assert.equal(database.userAppUsage[0].last_used_at, '2025-02-01T00:00:00Z');
  } finally {
    await closePool();
    mysql.createPool = original;
    if (previousDriver === undefined) delete process.env.DB_DRIVER; else process.env.DB_DRIVER = previousDriver;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
  }
});
