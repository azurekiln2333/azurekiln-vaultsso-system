const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PROJECT_ROOT, loadProjectEnvironment, resolveProjectPath } = require('../config/environment');
const { readRuntimeConfig } = require('../config/runtime');
const { checkConfiguration, formatReport } = require('../scripts/check-config');

function fixture(t, contents = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-config-check-'));
  fs.writeFileSync(path.join(root, '.env'), contents, { mode: 0o600 });
  t.after(() => {
    for (const file of ['.env', 'signing.pem']) {
      const target = path.join(root, file);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    fs.rmdirSync(root);
  });
  return root;
}

test('environment loading uses the project directory and preserves process overrides', t => {
  const fileSecret = crypto.randomBytes(48).toString('base64url');
  const processSecret = crypto.randomBytes(48).toString('base64url');
  const root = fixture(t, `JWT_SECRET=${fileSecret}\nPUBLIC_BASE_URL=https://login.example.test\n`);
  const previousDirectory = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const fromFile = { NODE_ENV: 'production' };
    const fileResult = loadProjectEnvironment({ env: fromFile, projectRoot: root });
    assert.equal(fromFile.JWT_SECRET, fileSecret);
    assert.equal(fileResult.sources.JWT_SECRET, '.env');
    const fromProcess = { NODE_ENV: 'production', JWT_SECRET: processSecret };
    const processResult = loadProjectEnvironment({ env: fromProcess, projectRoot: root });
    assert.equal(fromProcess.JWT_SECRET, processSecret);
    assert.equal(processResult.sources.JWT_SECRET, 'environment');
    assert.equal(fromProcess.PUBLIC_BASE_URL, 'https://login.example.test');
    assert.equal(resolveProjectPath('keys/signing.pem'), path.join(PROJECT_ROOT, 'keys', 'signing.pem'));
  } finally { process.chdir(previousDirectory); }
});

test('an explicit empty process variable is diagnosed rather than silently overwritten', t => {
  const secret = crypto.randomBytes(48).toString('base64url');
  const root = fixture(t, `JWT_SECRET=${secret}\nPUBLIC_BASE_URL=https://login.example.test\n`);
  const env = { NODE_ENV: 'production', JWT_SECRET: '' };
  const report = checkConfiguration({ env, projectRoot: root });
  assert.equal(env.JWT_SECRET, '');
  assert.equal(report.jwtSecretSource, 'environment');
  assert.equal(report.jwtSecretBytes, 0);
  assert.ok(report.errors.some(message => /JWT_SECRET is missing or empty/.test(message)));
  assert.match(formatReport(report), /takes priority over .env/);
  assert.ok(!formatReport(report).includes(secret));
});

test('test mode never imports deployment settings from .env', t => {
  const root = fixture(t, 'JWT_SECRET=deployment-only\nDB_PASSWORD=deployment-only\n');
  const env = { NODE_ENV: 'test' };
  const result = loadProjectEnvironment({ env, projectRoot: root });
  assert.equal(result.skipped, true);
  assert.equal(env.JWT_SECRET, undefined);
  assert.equal(env.DB_PASSWORD, undefined);
});

test('configuration preflight accepts a persistent relative RSA key without exposing or changing credentials', t => {
  const secret = crypto.randomBytes(48).toString('base64url');
  const dbPassword = crypto.randomBytes(32).toString('hex');
  const contents = [
    'NODE_ENV=production', `JWT_SECRET=${secret}`, 'PUBLIC_BASE_URL=https://login.example.test',
    'OIDC_SIGNING_KEY_FILE=signing.pem', 'DB_HOST=127.0.0.1', 'DB_USER=application',
    `DB_PASSWORD=${dbPassword}`, 'DB_NAME=oauth', ''
  ].join('\n');
  const root = fixture(t, contents);
  const privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(root, 'signing.pem'), privateKey, { mode: 0o600 });
  const report = checkConfiguration({ env: {}, projectRoot: root });
  assert.deepEqual(report.errors, []);
  const output = formatReport(report);
  for (const sensitive of [secret, dbPassword, privateKey]) assert.ok(!output.includes(sensitive));
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), contents);
  assert.equal(fs.readFileSync(path.join(root, 'signing.pem'), 'utf8'), privateKey);
  assert.match(output, /were not tested/);
});

test('JWT configuration errors remain strict and never include the rejected secret', () => {
  for (const secret of ['', 'too-short', 'your-super-secret-jwt-key-change-in-production']) {
    assert.throws(() => readRuntimeConfig({ NODE_ENV: 'production', JWT_SECRET: secret, PUBLIC_BASE_URL: 'https://login.example.test' }), /JWT_SECRET/);
  }
  assert.throws(() => readRuntimeConfig({ JWT_SECRET: 'your-super-secret-jwt-key-change-in-production' }), /example\/placeholder/);
  const rejected = 'known-secret-too-short';
  try {
    readRuntimeConfig({ NODE_ENV: 'production', JWT_SECRET: rejected });
    assert.fail('A short secret must be rejected');
  } catch (error) {
    assert.ok(!error.message.includes(rejected));
    assert.match(error.message, /check:config/);
  }
});

test('Turnstile requires a complete key pair and keeps the secret in runtime config', () => {
  const base = {
    NODE_ENV: 'development', JWT_SECRET: crypto.randomBytes(48).toString('base64url'),
    PUBLIC_BASE_URL: 'http://localhost:3146'
  };
  assert.throws(() => readRuntimeConfig({ ...base, TURNSTILE_SITE_KEY: 'site-key' }), /must be configured together/);
  assert.throws(() => readRuntimeConfig({ ...base, TURNSTILE_SECRET_KEY: 'secret-key' }), /must be configured together/);
  const runtime = readRuntimeConfig({ ...base, TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' });
  assert.equal(runtime.turnstileSiteKey, 'site-key');
  assert.equal(runtime.turnstileSecretKey, 'secret-key');
});
