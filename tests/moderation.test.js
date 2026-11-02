const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const moderation = require('../services/moderation');
const { createFixture, randomSecret } = require('./support/fixture');

const originalAssert = moderation.assertProfileUpdates;
let f;
before(async () => { f = await createFixture(); });
beforeEach(() => {
  f.reset();
  moderation.assertProfileUpdates = originalAssert;
});
after(async () => {
  moderation.assertProfileUpdates = originalAssert;
  if (f) await f.close();
});

function useReview(assertText) {
  moderation.assertProfileUpdates = moderation.createModerationService({
    env: { NODE_ENV: 'test', MODERATION_BASE_URL: 'http://127.0.0.1:4310', MODERATION_APP_ID: 'isolated-gateway-test', MODERATION_API_KEY: randomSecret() },
    loadSdk: () => ({ ModerationClient: class {
      async checkText({ text, scene }) {
        try {
          await assertText(text, { field: scene.replace('profile_', '') });
          return { decision: 'pass' };
        } catch (error) {
          if (error instanceof moderation.ModerationError && error.code === 'content_rejected') return { decision: 'block' };
          throw error;
        }
      }
    } })
  }).assertProfileUpdates;
}

async function context(route, scopes = 'openid profile offline_access') {
  const account = await f.user();
  await f.User.update(account.id, { name: 'Original name', description: 'Original bio', avatar: 'https://identity.example.test/avatar.png' });
  if (route === '/api/profile') {
    return { account, cookie: (await f.login(account)).cookie };
  }
  const app = await f.client();
  const grant = await f.authorize(account, app, scopes);
  const token = await f.exchange(app, grant);
  assert.equal(token.status, 200);
  return { account, cookie: grant.cookie, headers: { Authorization: `Bearer ${token.body.access_token}` } };
}

function edit(route, auth, data) {
  return f.request(route, { method: 'PUT', cookie: auth.cookie, headers: auth.headers, data });
}

function storedState() {
  return structuredClone(Object.fromEntries(['users', 'sessions', 'accessTokens', 'refreshTokens', 'emailVerificationCodes']
    .map(table => [table, f.pool[table]])));
}

test('internal adapter receives only changed profile text, including an explicit biography clear', async () => {
  const reviewed = [];
  const service = moderation.createModerationService({ assertText: async (text, { field }) => reviewed.push({ field, text }) });
  const current = { name: 'Name', description: 'Bio' };
  await service.assertProfileUpdates(current, { name: 'Name', description: 'Bio', email: 'new@example.test' });
  assert.deepEqual(reviewed, []);
  await service.assertProfileUpdates(current, { name: '中文昵称', description: '' });
  assert.deepEqual(reviewed, [{ field: 'name', text: '中文昵称' }, { field: 'description', text: '' }]);
});

test('adapter fails closed with a fixed error for unknown failures and preserves only known rejection', async () => {
  const secret = randomSecret();
  const broken = moderation.createModerationService({ assertText: async () => { throw new Error(`upstream ${secret}`); } });
  await assert.rejects(broken.assertProfileUpdates({ name: 'Old' }, { name: 'New' }), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'moderation_unavailable');
    assert.ok(!error.message.includes(secret));
    return true;
  });
  const rejected = moderation.createModerationService({ assertText: async () => { throw new moderation.ModerationError('content_rejected'); } });
  await assert.rejects(rejected.assertProfileUpdates({ name: 'Old' }, { name: 'New' }), error => error.status === 400 && error.code === 'content_rejected');
});

test('the SDK adapter uses the documented constructor and checkText request with a gateway-specific environment tenant', async () => {
  const key = randomSecret();
  const options = [];
  const requests = [];
  const service = moderation.createModerationService({
    env: { MODERATION_BASE_URL: 'https://moderation.example.test/', MODERATION_APP_ID: 'dedicated-gateway-tenant', MODERATION_API_KEY: key },
    loadSdk: () => ({ ModerationClient: class {
      constructor(value) { options.push(value); }
      async checkText(value) { requests.push(value); return { decision: 'pass', categories: [], hits: [] }; }
    } })
  });
  await service.assertProfileUpdates({ id: 'user-42', name: 'Old', description: 'Old bio' }, { name: 'New', description: 'New bio' });
  assert.equal(options.length, 2);
  for (const value of options) {
    assert.deepEqual(value, { baseUrl: 'https://moderation.example.test', appId: 'dedicated-gateway-tenant', apiKey: key, timeoutMs: 3000, failClosed: true });
  }
  assert.deepEqual(requests, [
    { scene: 'profile_name', text: 'New', userId: 'user-42', targetType: 'user', targetId: 'user-42' },
    { scene: 'profile_description', text: 'New bio', userId: 'user-42', targetType: 'user', targetId: 'user-42' }
  ]);
});

test('SDK decisions and failures map to closed gateway errors on both real profile routes', async () => {
  const env = { MODERATION_BASE_URL: 'https://moderation.example.test', MODERATION_APP_ID: 'isolated-gateway-test', MODERATION_API_KEY: randomSecret() };
  for (const [result, status, code] of [
    [{ decision: 'block' }, 400, 'content_rejected'],
    [{ decision: 'review', reviewId: 'private-review-id' }, 400, 'content_rejected'],
    [{ decision: 'unknown' }, 503, 'moderation_unavailable'],
    [{ decision: 'pass', unavailable: true }, 503, 'moderation_unavailable'],
    [null, 503, 'moderation_unavailable']
  ]) {
    moderation.assertProfileUpdates = moderation.createModerationService({ env, loadSdk: () => ({ ModerationClient: class {
      async checkText() { return result; }
    } }) }).assertProfileUpdates;
    for (const route of ['/api/profile', '/oauth2/profile']) {
      const auth = await context(route);
      const before = storedState();
      const response = await edit(route, auth, { name: 'Changed name' });
      assert.equal(response.status, status);
      assert.equal(response.body.error, code);
      if (status === 503) assert.equal(response.body.error_description, '审核服务暂不可用');
      assert.ok(!JSON.stringify(response.body).includes('private-review-id'));
      assert.deepEqual(storedState(), before);
    }
  }
  for (const loadSdk of [
    () => { throw Object.assign(new Error('SDK tarball not installed'), { code: 'MODULE_NOT_FOUND' }); },
    () => ({ ModerationClient: class { async checkText() { throw Object.assign(new Error('审核服务暂不可用'), { code: 'moderation.unavailable', status: 503 }); } } })
  ]) {
    const service = moderation.createModerationService({ env, loadSdk });
    await assert.rejects(service.assertProfileUpdates({ id: 'user-42', name: 'Old' }, { name: 'New' }), error => error.status === 503 && error.code === 'moderation_unavailable');
  }
});

test('moderation configuration permits an unconfigured gateway and validates complete tenant credentials without exposing them', () => {
  assert.deepEqual(moderation.readModerationConfig({}), { configured: false, baseUrl: '', appId: '', apiKey: '' });
  const key = randomSecret();
  const configured = moderation.readModerationConfig({ MODERATION_BASE_URL: 'https://moderation.example.test/', MODERATION_APP_ID: 'gateway-test', MODERATION_API_KEY: key });
  assert.equal(configured.configured, true);
  assert.equal(configured.baseUrl, 'https://moderation.example.test');
  assert.equal(configured.apiKey, key);
  assert.equal(configured.appId, 'gateway-test');
  assert.throws(() => moderation.readModerationConfig({ MODERATION_BASE_URL: 'https://moderation.example.test', MODERATION_API_KEY: key }), /must be configured together/);
  assert.throws(() => moderation.readModerationConfig({ MODERATION_BASE_URL: 'https://moderation.example.test', MODERATION_APP_ID: 'gateway-test', MODERATION_API_KEY: 'too-short' }), /at least 32 characters/);
  for (const env of [
    { MODERATION_API_KEY: key },
    { MODERATION_BASE_URL: 'https://moderation.example.test' },
    { MODERATION_BASE_URL: `https://user:${key}@moderation.example.test/`, MODERATION_API_KEY: key },
    { MODERATION_BASE_URL: `https://moderation.example.test/?key=${key}`, MODERATION_API_KEY: key },
    { MODERATION_BASE_URL: 'http://moderation.example.test', MODERATION_API_KEY: key },
    { MODERATION_BASE_URL: 'file:///moderation', MODERATION_API_KEY: key },
    { MODERATION_BASE_URL: 'https://moderation.example.test', MODERATION_API_KEY: `${key}\r\nHeader: value` }
  ]) {
    assert.throws(() => moderation.readModerationConfig({ MODERATION_APP_ID: 'gateway-test', ...env }), error => !error.message.includes(key) && /MODERATION_/.test(error.message));
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(moderation.readModerationConfig({ MODERATION_BASE_URL: `http://${host}:3180`, MODERATION_APP_ID: 'gateway-test', MODERATION_API_KEY: key }).configured, true);
  }
});

test('both profile routes return 503 before a real text edit when moderation is unconfigured', async () => {
  for (const route of ['/api/profile', '/oauth2/profile']) {
    const auth = await context(route);
    const before = storedState();
    const result = await edit(route, auth, { name: 'Changed name' });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'moderation_unavailable');
    assert.equal(result.body.error_description, '审核服务暂不可用');
    assert.deepEqual(storedState(), before);
  }
});

test('both routes persist approved text exactly as reviewed by the internal SDK adapter', async () => {
  const reviewed = [];
  useReview(async (text, { field }) => reviewed.push({ field, text }));
  for (const route of ['/api/profile', '/oauth2/profile']) {
    reviewed.length = 0;
    const auth = await context(route);
    const result = await edit(route, auth, { name: '  New name  ', description: 'New bio' });
    assert.equal(result.status, 200);
    assert.deepEqual(reviewed, [{ field: 'name', text: 'New name' }, { field: 'description', text: 'New bio' }]);
    const stored = await f.User.findById(auth.account.id);
    assert.equal(stored.name, 'New name');
    assert.equal(stored.description, 'New bio');
    assert.equal(stored.avatar, 'https://identity.example.test/avatar.png');
  }
});

test('either rejected text field returns content_rejected from both routes without a partial profile write', async () => {
  for (const field of ['name', 'description']) {
    useReview(async (_, reviewedField) => {
      if (reviewedField.field === field) throw new moderation.ModerationError('content_rejected');
    });
    for (const route of ['/api/profile', '/oauth2/profile']) {
      const auth = await context(route);
      const before = storedState();
      const result = await edit(route, auth, { name: 'Rejected name', description: 'Rejected bio' });
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'content_rejected');
      assert.deepEqual(storedState(), before);
      assert.ok(!JSON.stringify(result.body).includes('Rejected'));
    }
  }
});

test('unknown SDK failure returns 503 without leaking its content or credential from either route', async () => {
  const secret = randomSecret();
  useReview(async text => { throw new Error(`SDK body=${text} key=${secret}`); });
  for (const route of ['/api/profile', '/oauth2/profile']) {
    const auth = await context(route);
    const before = storedState();
    const result = await edit(route, auth, { description: 'Private biography' });
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'moderation_unavailable');
    assert.ok(!JSON.stringify(result.body).includes(secret));
    assert.ok(!JSON.stringify(result.body).includes('Private biography'));
    assert.deepEqual(storedState(), before);
  }
});

test('unchanged and omitted text never reaches moderation and leaves other profile changes available', async () => {
  const reviewed = [];
  useReview(async text => { reviewed.push(text); throw new Error('unavailable'); });
  for (const route of ['/api/profile', '/oauth2/profile']) {
    const auth = await context(route);
    const result = await edit(route, auth, { name: 'Original name', description: 'Original bio' });
    assert.equal(result.status, 200);
  }
  const auth = await context('/api/profile');
  const result = await edit('/api/profile', auth, {
    name: 'Original name', description: 'Original bio', avatar: 'https://identity.example.test/avatar.png',
    phoneCountryCode: '+86', phoneNumber: '13800138000'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.phoneE164, '+8613800138000');
  assert.deepEqual(reviewed, []);
});

test('rejected mixed profile edits cannot change passwords or phones, revoke credentials, or send email', async () => {
  const auth = await context('/oauth2/profile');
  useReview(async () => { throw new moderation.ModerationError('content_rejected'); });
  const before = storedState();
  const result = await edit('/api/profile', auth, {
    name: 'Rejected name', email: `${crypto.randomUUID()}@example.test`,
    phoneCountryCode: '+86', phoneNumber: '13800138000',
    currentPassword: auth.account.clearPassword, newPassword: randomSecret()
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'content_rejected');
  assert.deepEqual(storedState(), before);
  assert.equal(f.mails.length, 0);
  assert.equal((await f.request('/api/profile', { cookie: auth.cookie })).status, 200);
});

test('unavailable moderation cannot send a new email verification message in a mixed edit', async () => {
  const auth = await context('/api/profile');
  const before = storedState();
  const result = await edit('/api/profile', auth, { description: 'New bio', email: `${crypto.randomUUID()}@example.test` });
  assert.equal(result.status, 503);
  assert.deepEqual(storedState(), before);
  assert.equal(f.mails.length, 0);
});

test('a rejected mixed edit leaves a valid email proof reusable with no attempts consumed', async () => {
  const auth = await context('/oauth2/profile');
  const email = `${crypto.randomUUID()}@example.test`;
  const sent = await edit('/api/profile', auth, { email });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.require_email_code, true);
  const code = f.lastCode(email);
  const before = storedState();
  useReview(async () => { throw new moderation.ModerationError('content_rejected'); });
  const rejected = await edit('/api/profile', auth, {
    description: 'Rejected bio', email, email_code: code,
    currentPassword: auth.account.clearPassword, newPassword: randomSecret()
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, 'content_rejected');
  assert.deepEqual(storedState(), before);
  assert.equal(f.mails.length, 1);
  const corrected = await edit('/api/profile', auth, { email, email_code: code });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.user.email, email);
});

test('authentication, OAuth scopes and existing field validation still precede moderation', async () => {
  const reviewed = [];
  useReview(async text => reviewed.push(text));
  assert.equal((await edit('/api/profile', {}, { name: 'New name' })).status, 401);
  assert.equal((await edit('/oauth2/profile', {}, { name: 'New name' })).status, 401);
  const missingScope = await context('/oauth2/profile', 'openid');
  const denied = await edit('/oauth2/profile', missingScope, { name: 'New name' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'insufficient_scope');
  const auth = await context('/oauth2/profile');
  for (const data of [{ name: '' }, { name: 'x'.repeat(65) }, { description: 'x'.repeat(201) }, { avatar: 'https://image.example.test/new.png' }]) {
    assert.equal((await edit('/oauth2/profile', auth, data)).status, 400);
  }
  for (const data of [{ name: '' }, { description: 'x'.repeat(501) }, { username: 'different', name: 'New name' }, { phoneNumber: 'bad', name: 'New name' }]) {
    assert.equal((await edit('/api/profile', auth, data)).status, 400);
  }
  assert.deepEqual(reviewed, []);
});

test('manual avatar URLs, data URIs and clearing are closed while existing provider avatars remain visible', async () => {
  const auth = await context('/api/profile');
  const before = storedState();
  for (const avatar of ['https://image.example.test/new.png', 'data:image/png;base64,aGVsbG8=', '', null]) {
    const result = await edit('/api/profile', auth, { avatar });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'avatar_upload_disabled');
    assert.deepEqual(storedState(), before);
  }
  const existing = await edit('/api/profile', auth, { avatar: 'https://identity.example.test/avatar.png' });
  assert.equal(existing.status, 200);
  assert.equal(existing.body.user.avatar, 'https://identity.example.test/avatar.png');
  const page = fs.readFileSync(path.join(__dirname, '..', 'views/account/profile.html'), 'utf8');
  assert.doesNotMatch(page, /profileAvatarInput|name="avatar"|type="file"|photo_camera/);
});
