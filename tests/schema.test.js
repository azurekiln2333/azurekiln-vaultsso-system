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
      async query(sql, params = []) { return this.execute(sql, params); },
      async execute(sql, params = []) {
        statements.push([sql, params]);
        if (sql.startsWith('SELECT version')) return [[{ version: SCHEMA_VERSION }]];
        if (sql.startsWith('SHOW COLUMNS FROM clients') && params[0] === 'require_pkce') return [[]];
        if (sql.startsWith('SHOW COLUMNS FROM oidc_providers') && params[0] === 'huawei_union_scope') return [[]];
        if (sql.startsWith('SHOW COLUMNS FROM email_verification_codes') && params[0] === 'pending_context') return [[]];
        if (sql.startsWith('SHOW COLUMNS FROM users') && ['status', 'deleted_at'].includes(params[0])) return [[]];
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
    assert.deepEqual(statements.map(([sql]) => sql), ['SELECT version FROM schema_metadata WHERE id = 1']);
    await closePool();
    statements.length = 0;
    await initDatabase({ initializeSchema: true });
    assert.ok(statements.some(([sql]) => /CREATE TABLE IF NOT EXISTS users/i.test(sql)));
    assert.ok(statements.some(([sql]) => /CREATE TABLE IF NOT EXISTS captcha_challenges/i.test(sql)));
    assert.ok(statements.some(([sql]) => /CREATE TABLE IF NOT EXISTS clients[\s\S]*require_pkce BOOLEAN NOT NULL DEFAULT TRUE/i.test(sql)));
    assert.ok(statements.some(([sql]) => /ALTER TABLE clients ADD COLUMN require_pkce BOOLEAN NOT NULL DEFAULT TRUE AFTER is_active/i.test(sql)));
    assert.equal(SCHEMA_VERSION, 8);
    // 注销（任务4）与日志合规（任务3）的 users / login_logs 变更必须在同一份迁移里共存。
    assert.ok(statements.some(([sql]) => /CREATE TABLE IF NOT EXISTS users[\s\S]*status VARCHAR\(16\) NOT NULL DEFAULT 'active'[\s\S]*deleted_at DATETIME\(3\) DEFAULT NULL/i.test(sql)));
    assert.ok(statements.some(([sql]) => /ALTER TABLE users ADD COLUMN status VARCHAR\(16\) NOT NULL DEFAULT 'active'/i.test(sql)));
    assert.ok(statements.some(([sql]) => /ALTER TABLE users ADD COLUMN deleted_at DATETIME\(3\) DEFAULT NULL/i.test(sql)));
    assert.ok(statements.some(([sql]) => /ALTER TABLE login_logs MODIFY detail VARCHAR\(1024\)/i.test(sql)));
    assert.ok(statements.some(([sql]) => /CREATE TABLE IF NOT EXISTS user_authenticators[\s\S]*secret VARCHAR\(255\)[\s\S]*FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i.test(sql)));
    assert.ok(statements.some(([sql]) => /CREATE TABLE IF NOT EXISTS users[\s\S]*totp_revision BIGINT NOT NULL DEFAULT 0/i.test(sql)));
    const [usageCreate] = statements.find(([sql]) => /CREATE TABLE IF NOT EXISTS user_app_usage/i.test(sql));
    assert.match(usageCreate, /PRIMARY KEY \(user_id, client_id\)/i);
    assert.match(usageCreate, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/i);
    assert.doesNotMatch(usageCreate, /REFERENCES clients/i);
    const [usageBackfill] = statements.find(([sql]) => /INSERT INTO user_app_usage[\s\S]*SELECT evidence.user_id/i.test(sql));
    assert.match(usageBackfill, /MIN\(evidence.created_at\), MAX\(evidence.created_at\)/i);
    assert.match(usageBackfill, /FROM access_tokens WHERE user_id IS NOT NULL[\s\S]*UNION ALL[\s\S]*FROM refresh_tokens WHERE user_id IS NOT NULL/i);
    assert.doesNotMatch(usageBackfill, /auth_codes|CURRENT_TIMESTAMP|NOW\(\)/i);
    assert.ok(statements.some(([sql]) => /CREATE TABLE IF NOT EXISTS email_verification_codes[\s\S]*pending_context JSON DEFAULT NULL/i.test(sql)));
    assert.ok(statements.some(([sql]) => /ALTER TABLE email_verification_codes ADD COLUMN pending_context JSON DEFAULT NULL AFTER code_hash/i.test(sql)));
    assert.ok(statements.some(([sql]) => /CREATE TABLE IF NOT EXISTS oidc_providers[\s\S]*huawei_union_scope VARCHAR\(128\) COLLATE utf8mb4_bin NOT NULL DEFAULT ''/i.test(sql)));    assert.ok(statements.some(([sql]) => /ALTER TABLE oidc_providers ADD COLUMN huawei_union_scope VARCHAR\(128\) COLLATE utf8mb4_bin NOT NULL DEFAULT '' AFTER provider_type/i.test(sql)));
    // 合规日志字段：源端口 / 平台 / 类型 必须在建表与迁移两处都存在。
    const [logCreate] = statements.find(([sql]) => /CREATE TABLE IF NOT EXISTS login_logs/i.test(sql));
    assert.match(logCreate, /source_port INT NULL/i);
    assert.match(logCreate, /platform VARCHAR\(64\)/i);
    assert.match(logCreate, /login_type VARCHAR\(32\)/i);
    for (const column of ['source_port', 'platform', 'login_type']) {
      // 此桩模拟“列已存在”，所以只断言迁移被探测过（SHOW COLUMNS），ALTER 由下面的幂等用例覆盖。
      assert.ok(statements.some(([sql, params]) => /SHOW COLUMNS FROM login_logs LIKE \?/i.test(sql) && params?.[0] === column),
        `missing idempotent migration probe for login_logs.${column}`);
    }
    for (const [sql] of statements) {
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
      },
      async execute(sql, params = []) { return this.query(sql, params); }
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

test('login log compliance columns migrate idempotently on an existing table', async () => {
  const statements = [];
  const existing = new Set(['detail']);
  const original = mysql.createPool;
  const previousDriver = process.env.DB_DRIVER;
  const previousEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.DB_DRIVER = 'mysql';
  mysql.createPool = () => ({
    on() {}, async end() {},
    async getConnection() { return {
      release() {},
      async query(sql, params = []) { return this.execute(sql, params); },
      async execute(sql, params = []) {
        statements.push([sql, params]);
        // Simulates a table created before this migration: only `detail` exists, so every other
        // compliance column is added once and the second run must be a no-op.
        if (sql.startsWith('SHOW COLUMNS FROM login_logs')) {
          if (existing.has(params[0])) return [[{ Field: params[0] }]];
          existing.add(params[0]);
          return [[]];
        }
        if (sql.startsWith('SHOW COLUMNS') || sql.startsWith('SHOW INDEX')) return [[{ Field: 'present' }]];
        return [{ affectedRows: 0 }];
      }
    }; }
  });
  try {
    await initDatabase({ initializeSchema: true });
    await closePool();
    const firstAdds = statements.filter(([sql]) => /ALTER TABLE login_logs ADD COLUMN (source_port|platform|login_type) /i.test(sql));
    assert.deepEqual(firstAdds.map(([sql]) => /ADD COLUMN (\w+)/i.exec(sql)[1]), ['source_port', 'platform', 'login_type']);
    statements.length = 0;
    await initDatabase({ initializeSchema: true });
    assert.equal(statements.filter(([sql]) => /ALTER TABLE login_logs ADD COLUMN/i.test(sql)).length, 0,
      'repeated migrations must not re-add existing login_logs columns');
  } finally {
    await closePool();
    mysql.createPool = original;
    if (previousDriver === undefined) delete process.env.DB_DRIVER; else process.env.DB_DRIVER = previousDriver;
    if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
  }
});
