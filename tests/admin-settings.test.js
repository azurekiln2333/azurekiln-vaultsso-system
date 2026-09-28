const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFixture } = require('./support/fixture');
const { createStore } = require('../services/admin-settings');

let fixture;
before(async () => { fixture = await createFixture(); });
after(async () => { if (fixture) await fixture.close(); });

test('admin SMTP and Turnstile edits persist encrypted and take effect immediately', async () => {
  const admin = await fixture.user('admin');
  const login = await fixture.login(admin);
  const cookie = login.cookie;
  assert.equal((await fixture.request('/api/admin/turnstile')).status, 401);
  const siteKey = 'new-site-key';
  const secretKey = 'new-server-secret';
  const password = 'new-smtp-password';

  const turnstile = await fixture.request('/api/admin/turnstile', {
    method: 'PUT', cookie, data: { siteKey, secretKey }
  });
  assert.equal(turnstile.status, 200);
  assert.equal(turnstile.body.hasSecretKey, true);
  assert.ok(!JSON.stringify(turnstile.body).includes(secretKey));
  const publicConfig = await fixture.request('/api/auth/config?surface=web');
  assert.equal(publicConfig.body.captchaProvider, 'turnstile');
  assert.equal(publicConfig.body.turnstileSiteKey, siteKey);
  assert.equal((await fixture.request('/api/auth/config')).body.captchaProvider, 'image');
  assert.ok(!JSON.stringify(publicConfig.body).includes(secretKey));

  const smtp = await fixture.request('/api/admin/smtp', {
    method: 'PUT', cookie,
    data: { host: 'smtp.changed.test', port: 465, user: 'changed-user', from: 'Changed <mail@example.test>', password }
  });
  assert.equal(smtp.status, 200);
  assert.equal(smtp.body.hasPassword, true);
  assert.ok(!JSON.stringify(smtp.body).includes(password));
  const raw = fs.readFileSync(process.env.ADMIN_SETTINGS_FILE, 'utf8');
  assert.ok(!raw.includes(secretKey) && !raw.includes(password));
  assert.match(raw, /enc:v1:/);

  const store = createStore(process.env.JWT_SECRET, process.env.ADMIN_SETTINGS_FILE);
  assert.deepEqual(store.load().turnstile, { siteKey, secretKey });
  assert.equal(store.load().smtp.password, password);
  const keep = await fixture.request('/api/admin/smtp', { method: 'PUT', cookie, data: { host: 'smtp.next.test' } });
  assert.equal(keep.body.hasPassword, true);
  assert.equal(store.load().smtp.password, password);
  const invalid = await fixture.request('/api/admin/turnstile', {
    method: 'PUT', cookie, data: { siteKey: 'invalid key', secretKey: 'different-secret' }
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(store.load().turnstile, { siteKey, secretKey });
  const beforeFailure = fs.readFileSync(process.env.ADMIN_SETTINGS_FILE, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated settings write failure'); };
  try {
    const failed = await fixture.request('/api/admin/turnstile', {
      method: 'PUT', cookie, data: { siteKey: 'unwritten-site-key' }
    });
    assert.equal(failed.status, 500);
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(process.env.ADMIN_SETTINGS_FILE, 'utf8'), beforeFailure);
  assert.equal((await fixture.request('/api/auth/config?surface=web')).body.turnstileSiteKey, siteKey);
  const clearTurnstile = await fixture.request('/api/admin/turnstile', { method: 'PUT', cookie, data: { clear: true } });
  assert.equal(clearTurnstile.status, 200);
  assert.equal((await fixture.request('/api/auth/config?surface=web')).body.captchaProvider, 'image');
  assert.deepEqual(store.load().turnstile, { siteKey: '', secretKey: '' });
  const clearSmtp = await fixture.request('/api/admin/smtp', { method: 'PUT', cookie, data: { clearPassword: true } });
  assert.equal(clearSmtp.body.hasPassword, false);
  assert.equal(store.load().smtp.password, '');
});

test('startup reloads persisted admin settings before serving requests', async () => {
  const store = createStore(process.env.JWT_SECRET, process.env.ADMIN_SETTINGS_FILE);
  store.save({
    smtp: { host: 'smtp.restarted.test', port: 587, user: 'restarted-user', from: 'Restarted <mail@example.test>', password: 'restart-password' },
    turnstile: { siteKey: 'restart-site-key', secretKey: 'restart-secret-key' }
  });
  const { bootstrap } = require('../server');
  const { createMemoryPool } = require('./support/memory-db');
  const service = await bootstrap({ databasePool: createMemoryPool(), port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}/api/auth/config?surface=web`);
    const config = await response.json();
    assert.equal(config.turnstileSiteKey, 'restart-site-key');
    assert.equal(config.captchaProvider, 'turnstile');
    assert.equal(require('../services/email').getSmtpSettings().host, 'smtp.restarted.test');
    assert.equal(require('../services/email').getSmtpSettings().hasPassword, true);
  } finally { await service.close(); }
});

test('malformed and undecryptable stored credentials fail closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-settings-test-'));
  const file = path.join(directory, 'settings.json');
  try {
    createStore('original-root-secret', file).save({ turnstile: { siteKey: 'site-key', secretKey: 'server-secret' } });
    assert.throws(() => createStore('different-root-secret', file).load());
    fs.writeFileSync(file, JSON.stringify({ version: 1, turnstile: { siteKey: 'site-key', secretKey: 'server-secret' } }));
    assert.throws(() => createStore('original-root-secret', file).load(), /Invalid encrypted admin setting/);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});
