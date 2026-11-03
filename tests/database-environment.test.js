const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDatabaseEnvironment } = require('../config/runtime');

function production(overrides = {}) {
  return {
    NODE_ENV: 'production', DB_DRIVER: 'mysql', DB_HOST: '127.0.0.1',
    DB_USER: 'gateway', DB_PASSWORD: 'test-only-database-password', DB_NAME: 'oauth',
    ...overrides
  };
}

test('external loopback databases keep the existing no-TLS production behavior', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1']) {
    for (const flag of [undefined, 'false', 'FALSE']) {
      assert.doesNotThrow(() => validateDatabaseEnvironment(production({ DB_HOST: host, DB_BUNDLED: flag, DB_TLS: 'false' })));
    }
  }
});

test('an external production database still requires TLS regardless of its Docker-like name or address', () => {
  for (const host of ['mysql', 'mysql.example.test', 'db.example.test', '172.30.46.2', '10.0.0.2']) {
    for (const flag of [undefined, 'false', 'FALSE']) {
      for (const tls of [undefined, 'false', '1']) {
        assert.throws(() => validateDatabaseEnvironment(production({ DB_HOST: host, DB_BUNDLED: flag, DB_TLS: tls })), /Remote production databases require DB_TLS=true/);
      }
      for (const tls of ['true', 'TRUE']) {
        assert.doesNotThrow(() => validateDatabaseEnvironment(production({ DB_HOST: host, DB_BUNDLED: flag, DB_TLS: tls })));
      }
    }
  }
});

test('the explicit bundled database accepts only its service host and effective default port', () => {
  for (const flag of ['true', 'TRUE', 'True']) {
    for (const port of [undefined, '', '3306', 3306]) {
      for (const tls of [undefined, 'false', 'true']) {
        assert.doesNotThrow(() => validateDatabaseEnvironment(production({
          DB_BUNDLED: flag, DB_HOST: 'mysql', DB_PORT: port, DB_TLS: tls
        })));
      }
    }
  }
});

test('bundled mode rejects any other host even when TLS is enabled', () => {
  for (const host of ['MYSQL', 'MySQL', 'mysql.', 'mysql.example.test', 'mysql:3306', ' mysql', 'mysql ',
    '127.0.0.1', 'localhost', '::1', '172.30.46.2', 'db.example.test']) {
    for (const tls of ['false', 'true']) {
      assert.throws(() => validateDatabaseEnvironment(production({ DB_BUNDLED: 'true', DB_HOST: host, DB_TLS: tls })),
        /DB_BUNDLED=true requires the private Compose service DB_HOST=mysql and DB_PORT=3306/);
    }
  }
});

test('bundled mode rejects alternate or ambiguously parsed ports even when TLS is enabled', () => {
  for (const port of ['3307', '0', '-1', '65536', '3306junk', '3306.5', '3306.0', '03306', '3.306e3', ' 3306', '3306 ']) {
    for (const tls of ['false', 'true']) {
      assert.throws(() => validateDatabaseEnvironment(production({ DB_BUNDLED: 'true', DB_HOST: 'mysql', DB_PORT: port, DB_TLS: tls })),
        /DB_BUNDLED=true requires the private Compose service DB_HOST=mysql and DB_PORT=3306/);
    }
  }
});

test('malformed bundled flags cannot fall through to either TLS policy', () => {
  for (const flag of ['', ' ', ' true', 'false ', '1', '0', 'yes', 'no', 'enabled']) {
    for (const tls of ['false', 'true']) {
      assert.throws(() => validateDatabaseEnvironment(production({ DB_BUNDLED: flag, DB_HOST: 'mysql', DB_TLS: tls })), /DB_BUNDLED must be true or false/);
    }
  }
});

test('bundled mode does not waive required production credentials or the supported driver', () => {
  const bundled = production({ DB_BUNDLED: 'true', DB_HOST: 'mysql' });
  for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
    assert.throws(() => validateDatabaseEnvironment({ ...bundled, [key]: '' }), new RegExp(`${key} must be explicitly configured in production`));
  }
  assert.throws(() => validateDatabaseEnvironment({ ...bundled, DB_DRIVER: 'memory' }), /only supports DB_DRIVER=mysql/);
});

test('development and isolated tests retain the existing permissive database connection policy', () => {
  for (const nodeEnv of ['development', 'test']) {
    assert.doesNotThrow(() => validateDatabaseEnvironment({ NODE_ENV: nodeEnv }));
    assert.doesNotThrow(() => validateDatabaseEnvironment({ NODE_ENV: nodeEnv, DB_BUNDLED: 'invalid', DB_HOST: 'remote.example.test', DB_TLS: 'false' }));
    assert.throws(() => validateDatabaseEnvironment({ NODE_ENV: nodeEnv, DB_DRIVER: 'memory' }), /only supports DB_DRIVER=mysql/);
  }
});

test('startup and explicit migrations reject unsafe bundled claims before opening a database pool', async () => {
  const mysql = require('mysql2/promise');
  const { initDatabase } = require('../db/init');
  const env = production({ DB_BUNDLED: 'true', DB_HOST: 'remote.example.test', DB_TLS: 'true' });
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const createPool = mysql.createPool;
  let attemptedConnections = 0;
  mysql.createPool = () => { attemptedConnections++; throw new Error('Unexpected database connection'); };
  Object.assign(process.env, env);
  try {
    for (const initializeSchema of [false, true]) {
      await assert.rejects(initDatabase({ initializeSchema }), /DB_BUNDLED=true requires the private Compose service/);
    }
    assert.equal(attemptedConnections, 0);
  } finally {
    mysql.createPool = createPool;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
