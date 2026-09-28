const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createFixture } = require('./support/fixture');
const UserAppUsageModel = require('../models/UserAppUsage');
const TokenModel = require('../models/Token');
const ExternalIdentityModel = require('../models/ExternalIdentity');

let f;
before(async () => { f = await createFixture(); });
beforeEach(() => f.reset());
after(async () => { if (f) await f.close(); });

async function ownApplications(cookie, suffix = '') {
  const result = await f.request(`/api/account/applications${suffix}`, { cookie });
  assert.equal(result.status, 200);
  return result.body;
}

test('only successfully redeemed user grants record app usage; failures, codes and machine grants do not', async () => {
  const account = await f.user();
  const app = await f.client();
  const grant = await f.authorize(account, app, 'openid offline_access');
  assert.deepEqual((await ownApplications(grant.cookie)).applications, []);
  assert.equal((await f.exchange(app, grant, { code_verifier: 'wrong' })).status, 400);
  assert.equal((await f.exchange(app, grant, { client_secret: 'wrong' })).status, 401);
  assert.equal(f.pool.userAppUsage.length, 0);
  const machine = await f.request('/oauth2/token', { method: 'POST', data: {
    grant_type: 'client_credentials', client_id: app.id, client_secret: app.clearSecret, scope: 'service.read'
  } });
  assert.equal(machine.status, 200);
  assert.equal(f.pool.userAppUsage.length, 0);
  assert.equal((await f.exchange(app, grant)).status, 200);
  const usage = (await ownApplications(grant.cookie)).applications;
  assert.equal(usage.length, 1);
  assert.deepEqual(Object.keys(usage[0]).sort(), ['clientId', 'configured', 'enabled', 'firstUsedAt', 'lastUsedAt', 'name']);
  assert.equal(usage[0].clientId, app.id);
  assert.equal(usage[0].name, app.name);
  const beforeReplay = JSON.stringify(f.pool.userAppUsage);
  assert.equal((await f.exchange(app, grant)).status, 400);
  assert.equal(JSON.stringify(f.pool.userAppUsage), beforeReplay);
});

test('refresh updates last activity and snapshot name but failed refresh and replay never advance history', async () => {
  const account = await f.user();
  const app = await f.client();
  const grant = await f.authorize(account, app, 'openid offline_access');
  const issued = await f.exchange(app, grant);
  assert.equal(issued.status, 200);
  const earlier = '2025-01-01T00:00:00.000Z';
  f.pool.userAppUsage[0].first_used_at = earlier;
  f.pool.userAppUsage[0].last_used_at = earlier;
  await f.Client.update(app.id, { name: 'Renamed real app' });
  assert.equal((await f.refresh(app, issued.body.refresh_token, { scope: 'invalid' })).status, 400);
  assert.equal(f.pool.userAppUsage[0].last_used_at, earlier);
  const renewed = await f.refresh(app, issued.body.refresh_token);
  assert.equal(renewed.status, 200);
  assert.equal(f.pool.userAppUsage.length, 1);
  assert.equal(f.pool.userAppUsage[0].first_used_at, earlier);
  assert.equal(f.pool.userAppUsage[0].client_name, 'Renamed real app');
  assert.ok(new Date(f.pool.userAppUsage[0].last_used_at) > new Date(earlier));
  const beforeReplay = JSON.stringify(f.pool.userAppUsage);
  assert.equal((await f.refresh(app, issued.body.refresh_token)).status, 400);
  assert.equal(JSON.stringify(f.pool.userAppUsage), beforeReplay);
});

test('atomic usage upsert keeps one row and chronological bounds despite concurrent out-of-order activity', async () => {
  const account = await f.user();
  const app = await f.client();
  const usage = new UserAppUsageModel(f.pool);
  await Promise.all(['2025-02-01', '2025-01-01', '2025-03-01', '2025-02-01'].map(date => usage.record(account.id, app, new Date(date))));
  const rows = await usage.findByUserId(account.id);
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].first_used_at).toISOString(), '2025-01-01T00:00:00.000Z');
  assert.equal(new Date(rows[0].last_used_at).toISOString(), '2025-03-01T00:00:00.000Z');
});

test('concurrent grants for one app deduplicate history and replayed refresh creates no second usage', async () => {
  const account = await f.user();
  const app = await f.client();
  const first = await f.authorize(account, app, 'openid offline_access');
  const second = await f.authorize(account, app, 'openid offline_access', first.cookie);
  const exchanged = await Promise.all([f.exchange(app, first), f.exchange(app, second)]);
  assert.deepEqual(exchanged.map(result => result.status), [200, 200]);
  assert.equal(f.pool.userAppUsage.length, 1);
  const rotated = await Promise.all([f.refresh(app, exchanged[0].body.refresh_token), f.refresh(app, exchanged[0].body.refresh_token)]);
  assert.deepEqual(rotated.map(result => result.status).sort(), [200, 400]);
  assert.equal(f.pool.userAppUsage.length, 1);
});

test('admin includes OAuth-only users and safe own-user API ignores supplied account selectors', async () => {
  const admin = await f.user('admin');
  const owner = await f.user();
  const other = await f.user();
  const app = await f.client();
  const grant = await f.authorize(owner, app);
  assert.equal((await f.exchange(app, grant)).status, 200);
  const otherLogin = await f.login(other);
  const adminLogin = await f.login(admin);
  assert.equal((await f.request('/api/account/applications')).status, 401);
  assert.equal((await f.request('/api/admin/account-bindings', { cookie: otherLogin.cookie })).status, 403);
  assert.deepEqual(await ownApplications(otherLogin.cookie, `?userId=${owner.id}&id=${owner.id}`), { applications: [], bindings: [] });
  const response = await f.request('/api/admin/account-bindings', { cookie: adminLogin.cookie });
  assert.equal(response.status, 200);
  assert.equal(response.body.accounts.length, 1);
  assert.equal(response.body.accounts[0].user.id, owner.id);
  assert.deepEqual(response.body.accounts[0].bindings, []);
  assert.equal(response.body.accounts[0].applications[0].clientId, app.id);
  for (const forbidden of [app.clearSecret, owner.password, f.pool.accessTokens[0].token]) {
    assert.ok(!JSON.stringify(response.body).includes(forbidden));
  }
});

test('own and admin binding projections match without exposing raw profile or provider credentials', async () => {
  const owner = await f.user();
  const admin = await f.user('admin');
  f.pool.oidcProviders.push({ provider_key: 'huawei-app', provider_name: 'Huawei app', provider_type: 'huawei_quicklogin',
    client_id: 'huawei-client', enabled: true, client_secret: 'never-send-provider-secret', huawei_union_scope: 'company' });
  const identity = new ExternalIdentityModel(f.pool);
  await identity.create({ userId: owner.id, provider: 'huawei-app', providerUserId: 'union-id', providerSecondaryId: 'open-id',
    profile: { provider: 'huawei_quicklogin', clientId: 'huawei-client', openID: 'open-id', unionID: 'union-id', huaweiUnionScope: 'company',
      access_token: 'never-send-profile-token', privateProfile: 'never-send-raw-profile' } });
  const ownerLogin = await f.login(owner);
  const adminLogin = await f.login(admin);
  const personal = await ownApplications(ownerLogin.cookie);
  const administrative = await f.request('/api/admin/account-bindings', { cookie: adminLogin.cookie });
  assert.deepEqual(personal.bindings, administrative.body.accounts[0].bindings);
  assert.equal(personal.bindings[0].openId, 'open-id');
  assert.equal(personal.bindings[0].unionId, 'union-id');
  assert.equal(personal.bindings[0].huaweiUnionScope, 'company');
  assert.equal(personal.bindings[0].configured, true);
  assert.doesNotMatch(JSON.stringify(personal), /never-send|privateProfile|access_token|client_secret/);
  f.pool.oidcProviders.length = 0;
  const removed = (await ownApplications(ownerLogin.cookie)).bindings[0];
  assert.equal(removed.configured, false);
  assert.equal(removed.enabled, false);
  assert.equal(removed.clientId, 'huawei-client');
  assert.equal(removed.openId, 'open-id');
});

test('history survives token expiry, account revocation, app disabling and app deletion; user deletion cascades', async () => {
  const owner = await f.user();
  const app = await f.client();
  const grant = await f.authorize(owner, app, 'openid offline_access');
  assert.equal((await f.exchange(app, grant)).status, 200);
  const token = new TokenModel(f.pool);
  for (const row of [...f.pool.accessTokens, ...f.pool.refreshTokens]) row.expires_at = '2020-01-01T00:00:00Z';
  await token.cleanExpiredTokens();
  await token.revokeByUser(owner.id);
  assert.equal((await ownApplications(grant.cookie)).applications.length, 1);
  await f.Client.update(app.id, { isActive: false });
  let usage = (await ownApplications(grant.cookie)).applications[0];
  assert.equal(usage.configured, true);
  assert.equal(usage.enabled, false);
  await f.Client.delete(app.id);
  usage = (await ownApplications(grant.cookie)).applications[0];
  assert.equal(usage.configured, false);
  assert.equal(usage.enabled, false);
  assert.equal(usage.name, app.name);
  assert.equal(usage.clientId, app.id);
  await f.User.delete(owner.id);
  assert.equal(f.pool.userAppUsage.length, 0);
});
