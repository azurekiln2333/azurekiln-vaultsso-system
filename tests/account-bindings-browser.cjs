const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');
const ExternalIdentityModel = require('../models/ExternalIdentity');
const OidcProviderModel = require('../models/OidcProvider');

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';
  const fixture = await createFixture({ port });
  let browser;
  try {
    const admin = await fixture.user('admin');
    const target = await fixture.user();
    await fixture.User.update(target.id, { name: 'Phone verification target', phoneCountryCode: '86', phoneNumber: '13700137000' });
    await fixture.User.update(admin.id, { name: 'Browser verification' });
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true, args: ['--disable-background-networking']
    });
    const context = await browser.newContext();
    await context.route('**/*', route => new URL(route.request().url()).origin === fixture.baseUrl ? route.continue() : route.abort());
    const page = await context.newPage();
    let pendingApplicationsRequest;
    await context.route('**/api/account/applications', route => {
      if (!pendingApplicationsRequest) { pendingApplicationsRequest = route; return; }
      return route.continue();
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${fixture.baseUrl}/oauth2/authorize`);
    await page.locator('#loginForm input[name=username]').fill(admin.username);
    await page.locator('#loginForm input[name=password]').fill(admin.clearPassword);
    await page.locator('#loginForm button[type=submit]').click();
    await page.waitForURL('**/profile');
    await page.locator('#editPhoneBtn').click();
    assert.equal(await page.locator('#phoneUnbindBtn').isVisible(), false, 'Unbound account has no unbind action');
    await page.locator('#profilePhoneCountryInput').fill('+86');
    await page.locator('#profilePhoneInput').fill('13800138000');
    await context.route('**/api/profile', route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error_key: 'profile.phone.save_failed' }) })
      : route.continue());
    await page.locator('#phoneModalSubmit').click();
    await page.locator('#phoneModalError').waitFor({ state: 'visible' });
    assert.ok((await page.locator('#phoneModalError').innerText()).includes('保存未生效'));
    assert.equal(await page.locator('#phoneModal').isVisible(), true, 'Failed save keeps the editable phone modal open');
    assert.equal((await fixture.User.findById(admin.id)).phone_e164, null);
    await context.unroute('**/api/profile');
    await page.locator('#phoneModalSubmit').click();
    await page.locator('#phoneModal').waitFor({ state: 'hidden' });
    assert.ok(pendingApplicationsRequest);
    await pendingApplicationsRequest.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error_description: '应用记录请求已失效' }) });
    await page.waitForFunction(() => document.getElementById('applicationsStatus').textContent.includes('应用记录请求已失效'));
    assert.ok(page.url().endsWith('/profile'), 'An old background request cannot redirect a renewed phone-edit session');
    await context.unroute('**/api/account/applications');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('phoneValue').textContent.includes('8000'));
    assert.equal((await fixture.User.findById(admin.id)).phone_e164, '+8613800138000');
    assert.equal((await fixture.User.findById(admin.id)).phone_verified, false);

    const artifacts = path.resolve(__dirname, '..', '.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#editPhoneBtn').click();
      await page.screenshot({ path: path.join(artifacts, `phone-modal-${viewport.width}.png`), animations: 'disabled' });
      const bounds = await page.locator('#phoneModal .modal-card').boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width + 1, 'Phone modal fits viewport');
      await page.locator('[data-close-modal="phoneModal"]').first().click();
    }

    await page.goto(`${fixture.baseUrl}/user.html?id=${encodeURIComponent(admin.id)}#phoneInput`);
    await page.waitForFunction(() => document.getElementById('phoneInput')?.value === '13800138000');
    await page.locator('#phoneInput').fill('13600136000');
    const phoneSubmission = page.waitForRequest(request => request.url().endsWith(`/api/users/${admin.id}`) && request.method() === 'PUT');
    await page.locator('#saveBtn').click();
    const submitted = (await phoneSubmission).postDataJSON();
    assert.equal(submitted.phoneCountryCode, '+86');
    assert.equal(submitted.phoneNumber, '13600136000');
    await page.waitForFunction(() => document.getElementById('statusBar').textContent.includes('已保存'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('phoneInput')?.value === '13600136000');
    assert.equal((await fixture.User.findById(admin.id)).phone_e164, '+8613600136000');

    await page.goto(`${fixture.baseUrl}/user.html?id=${encodeURIComponent(target.id)}#phoneInput`);
    assert.ok(page.url().includes('/user.html'), `Unexpected admin navigation: ${page.url()}`);
    await page.waitForFunction(() => document.getElementById('phoneInput')?.value === '13700137000');
    await page.waitForFunction(() => document.activeElement?.id === 'phoneInput');
    await page.locator('#phoneInput').fill('13900139000');
    await page.locator('#saveBtn').click();
    await page.waitForFunction(() => document.getElementById('statusBar').textContent.includes('已保存'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('phoneInput').value === '13900139000');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(artifacts, 'admin-phone-390.png'), fullPage: true, animations: 'disabled' });

    await page.goto(`${fixture.baseUrl}/account-bindings.html`);
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('#bindingsAccounts').locator('a[href*="user.html"]').count(), 0);
    const providers = new OidcProviderModel(fixture.pool);
    const identities = new ExternalIdentityModel(fixture.pool);
    for (const app of ['one', 'two']) {
      await providers.upsert({ providerKey: `browser-huawei-${app}`, providerName: `Huawei App ${app}`, providerType: 'huawei_quicklogin', clientId: `app-${app}`, clientSecret: 'test-only-secret', huaweiUnionScope: 'browser-subject' });
      await identities.create({
        userId: admin.id, provider: `browser-huawei-${app}`, providerUserId: 'shared-union-id', providerSecondaryId: `openid-${app}`,
        profile: { provider: 'huawei_quicklogin', clientId: `app-${app}`, huaweiUnionScope: 'browser-subject', openID: `openid-${app}`, unionID: 'shared-union-id' }
      });
    }
    const usedApps = [];
    for (const name of ['Browser Notes', 'Browser Calendar']) {
      const app = await fixture.client();
      await fixture.Client.update(app.id, { name });
      const grant = await fixture.authorize(admin, app, 'openid offline_access');
      const exchanged = await fixture.exchange(app, grant);
      assert.equal(exchanged.status, 200);
      usedApps.push({ ...app, name });
    }
    const otherApp = await fixture.client();
    await fixture.Client.update(otherApp.id, { name: 'Other User Only' });
    assert.equal((await fixture.exchange(otherApp, await fixture.authorize(target, otherApp))).status, 200);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('bindingsAccounts').textContent.includes('openid-two'));
    assert.ok((await page.locator('#bindingsAccounts').innerText()).includes('Browser Notes'));
    assert.ok((await page.locator('#bindingsAccounts').innerText()).includes('Other User Only'));
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: path.join(artifacts, `account-bindings-${viewport.width}.png`), fullPage: true, animations: 'disabled' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Bindings page fits viewport');
    }
    await page.locator('#bindingsSearch').fill('does-not-exist');
    assert.equal(await page.locator('#bindingsAccounts').locator('a[href*="user.html"]').count(), 0);
    await page.locator('#bindingsSearch').fill('openid-one');
    await page.waitForFunction(() => document.getElementById('bindingsAccounts').textContent.includes('openid-one'));
    assert.ok((await page.locator('#bindingsAccounts').innerText()).includes('openid-two'), 'Search preserves account-level app relationships');
    await page.locator('#bindingsSearch').fill('Browser Notes');
    assert.equal(await page.locator('#bindingsAccounts a[href*="user.html"]').count(), 1);
    assert.ok((await page.locator('#bindingsAccounts').innerText()).includes('Browser Calendar'), 'App search keeps all applications of the matching user');
    assert.ok(!(await page.locator('#bindingsAccounts').innerText()).includes('Other User Only'));
    assert.ok(!(await page.locator('body').innerText()).includes('test-only-secret'));

    await page.goto(`${fixture.baseUrl}/profile`);
    await page.waitForFunction(() => document.getElementById('applicationsList').textContent.includes('Browser Calendar'));
    assert.ok(!(await page.locator('#applicationsList').innerText()).includes('Other User Only'), 'Personal page only shows current user apps');
    await page.waitForFunction(() => document.getElementById('identityList').textContent.includes('open_id: openid-one'));
    assert.ok((await page.locator('#identityList').innerText()).includes('union_id: shared-union-id'));
    assert.ok((await page.locator('#identityList').innerText()).includes('Huawei App one'));
    assert.ok((await page.locator('#identityList').innerText()).includes('App ID: app-one'));
    assert.ok((await page.locator('#identityList').innerText()).includes('browser-subject'));
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.locator('#applicationsTitle').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, `profile-applications-${viewport.width}.png`), animations: 'disabled' });
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        overflowing: [...document.querySelectorAll('[id]')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => node.id) }));
      assert.ok(layout.scrollWidth <= viewport.width + 1, `Profile application section fits viewport: ${JSON.stringify(layout)}`);
    }
    await fixture.Client.delete(usedApps[0].id);
    await page.locator('#applicationsRefresh').click();
    await page.waitForFunction(() => document.getElementById('applicationsList').textContent.includes('应用已移除'));
    assert.ok((await page.locator('#applicationsList').innerText()).includes('Browser Notes'), 'Removed app retains its recorded name');
    let staleApplicationsRoute;
    let staleApplicationsBody;
    await context.route('**/api/account/applications', async route => {
      if (staleApplicationsRoute) return route.continue();
      staleApplicationsRoute = route;
      staleApplicationsBody = await (await route.fetch()).json();
    });
    await page.evaluate(() => { window.pendingApplicationsRefresh = loadApplications(); });
    await page.waitForFunction(() => document.getElementById('applicationsRefresh').disabled);
    await page.waitForFunction(() => document.getElementById('applicationsStatus').textContent.includes('加载'));
    await page.evaluate(() => window.VaultI18n.setLanguage('en'));
    assert.equal(await page.locator('#applicationsStatus').innerText(), 'Loading...');
    await page.evaluate(() => window.VaultI18n.setLanguage('zh'));
    const captureDeadline = Date.now() + 5000;
    while (!staleApplicationsBody && Date.now() < captureDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(staleApplicationsBody, 'Captured the delayed application snapshot');
    await page.locator('#identityList [data-unbind-id]').first().click();
    await page.waitForFunction(() => !document.getElementById('identityList').textContent.includes('openid-one') && !document.getElementById('applicationsRefresh').disabled);
    await staleApplicationsRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(staleApplicationsBody) });
    await page.evaluate(() => window.pendingApplicationsRefresh);
    assert.ok(!(await page.locator('#identityList').innerText()).includes('openid-one'), 'An older application response cannot restore an unbound identity');
    assert.ok((await page.locator('#identityList').innerText()).includes('openid-two'), 'Unbinding preserves other app identities');
    await context.unroute('**/api/account/applications');
    await page.locator('#editPhoneBtn').click();
    await page.locator('#phoneUnbindBtn').click();
    await page.locator('#phoneModal').waitFor({ state: 'hidden' });
    assert.equal((await fixture.User.findById(admin.id)).phone_e164, null);
    await page.locator('#editPhoneBtn').click();
    assert.equal(await page.locator('#phoneUnbindBtn').isVisible(), false, 'Unbind action hides again after removing the phone');
    assert.deepEqual(errors, [], 'Feature pages execute without browser errors');
    console.log('Feature browser checks passed: profile/admin phone save/reload/unbind, app bindings/search, desktop/mobile screenshots');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
