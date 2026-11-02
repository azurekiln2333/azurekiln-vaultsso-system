const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const moderation = require('../services/moderation');
const { createFixture, randomSecret } = require('./support/fixture');

const originalAssert = moderation.assertProfileUpdates;
const apiKey = randomSecret();
const appId = 'isolated-gateway-sdk-test';
const received = [];
let f;
let upstream;
let service;
let reply;

function decision(value) {
  return {
    id: `decision-${crypto.randomUUID()}`, decision: value, categories: [], hits: [], createdAt: new Date().toISOString(),
    ...(value === 'review' ? { reviewId: 'private-review-id' } : {})
  };
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const record = { method: req.method, path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
    received.push(record);
    const response = reply(record);
    if (response.disconnect) return req.socket.destroy();
    res.writeHead(response.status || 200, { 'Content-Type': 'application/json', ...response.headers });
    res.end(response.raw ?? JSON.stringify(response.body));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  service = moderation.createModerationService({ env: {
    NODE_ENV: 'test', MODERATION_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    MODERATION_APP_ID: appId, MODERATION_API_KEY: apiKey
  } });
  f = await createFixture();
});
beforeEach(() => {
  f.reset();
  received.length = 0;
  reply = () => ({ body: decision('pass') });
  moderation.assertProfileUpdates = service.assertProfileUpdates;
});
after(async () => {
  moderation.assertProfileUpdates = originalAssert;
  if (f) await f.close();
  if (upstream) {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

async function context(route) {
  const account = await f.user();
  await f.User.update(account.id, { name: 'Original name', description: 'Original biography' });
  if (route === '/api/profile') return { account, cookie: (await f.login(account)).cookie };
  const app = await f.client();
  const grant = await f.authorize(account, app);
  const token = await f.exchange(app, grant);
  assert.equal(token.status, 200);
  return { account, cookie: grant.cookie, headers: { Authorization: `Bearer ${token.body.access_token}` } };
}

function edit(route, auth, data) {
  return f.request(route, { method: 'PUT', cookie: auth.cookie, headers: auth.headers, data });
}

test('the installed official SDK sends exact authenticated text requests for both profile routes', async () => {
  assert.equal(moderation.isModerationSdkAvailable(), true);
  for (const route of ['/api/profile', '/oauth2/profile']) {
    received.length = 0;
    const auth = await context(route);
    const result = await edit(route, auth, { name: 'New name', description: 'New biography' });
    assert.equal(result.status, 200);
    assert.equal(received.length, 2);
    for (const record of received) {
      assert.equal(record.method, 'POST');
      assert.equal(record.path, '/v1/text/check');
      assert.equal(record.headers['x-app-id'], appId);
      assert.equal(record.headers.authorization, `Bearer ${apiKey}`);
      assert.equal(record.headers['content-type'], 'application/json');
    }
    assert.deepEqual(received.map(record => record.body), [
      { scene: 'profile_name', text: 'New name', userId: auth.account.id, targetType: 'user', targetId: auth.account.id },
      { scene: 'profile_description', text: 'New biography', userId: auth.account.id, targetType: 'user', targetId: auth.account.id }
    ]);
    const user = await f.User.findById(auth.account.id);
    assert.equal(user.name, 'New name');
    assert.equal(user.description, 'New biography');
  }
});

test('real SDK block and pre-review decisions withhold both profile writes and hide service details', async () => {
  for (const value of ['block', 'review']) {
    reply = () => ({ body: { ...decision(value), categories: ['custom'], hits: [{ keywordId: 'private-keyword-id', category: 'custom' }] } });
    for (const route of ['/api/profile', '/oauth2/profile']) {
      const auth = await context(route);
      const before = await f.User.findById(auth.account.id);
      const result = await edit(route, auth, { name: 'Private submitted text', description: 'Private biography' });
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'content_rejected');
      assert.deepEqual(await f.User.findById(auth.account.id), before);
      for (const hidden of ['private-review-id', 'private-keyword-id', 'Private submitted text', apiKey]) {
        assert.ok(!JSON.stringify(result.body).includes(hidden));
      }
    }
  }
});

test('real SDK malformed JSON or incomplete check responses produce the fixed closed error on both routes', async () => {
  for (const response of [{ raw: '{not-json' }, { body: { decision: 'pass' } }, { body: { ...decision('pass'), decision: 'unknown' } }]) {
    reply = () => response;
    for (const route of ['/api/profile', '/oauth2/profile']) {
      const auth = await context(route);
      const before = await f.User.findById(auth.account.id);
      const result = await edit(route, auth, { description: 'New biography' });
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: 'moderation_unavailable', error_description: '审核服务暂不可用' });
      assert.deepEqual(await f.User.findById(auth.account.id), before);
    }
  }
});

test('real SDK HTTP failures, redirects and connection loss cannot publish either profile or disclose upstream errors', async () => {
  for (const response of [
    { status: 500, body: { error: 'internal_error', message: `private ${apiKey}`, requestId: 'private-request-id' } },
    { status: 401, body: { error: 'unauthorized', message: `private ${apiKey}` } },
    { status: 302, headers: { Location: 'https://untrusted.example.test/' }, body: {} },
    { disconnect: true }
  ]) {
    reply = () => response;
    for (const route of ['/api/profile', '/oauth2/profile']) {
      const auth = await context(route);
      const before = await f.User.findById(auth.account.id);
      const result = await edit(route, auth, { name: 'New name' });
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: 'moderation_unavailable', error_description: '审核服务暂不可用' });
      assert.deepEqual(await f.User.findById(auth.account.id), before);
    }
  }
});
