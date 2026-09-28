const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');
const { totpCode } = require('./support/totp-code');

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';
  const f = await createFixture({ port });
  let browser;
  try {
    browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }), headless: true });
    const artifacts = path.resolve(__dirname, '..', '.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      f.reset();
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.route('**/*', route => new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const account = await f.user();
      const legacySecret = 'JBSWY3DPEHPK3PXP';
      const recoveryCodes = ['ABCD2345EFGH6789', 'JKLM2345NPQR6789', 'STUV2345WXYZ6789'];
      await f.User.update(account.id, { totpEnabled: true, totpSecret: legacySecret,
        recoveryCodes: JSON.stringify(recoveryCodes.map(code => crypto.createHash('sha256').update(code).digest('hex'))) });
      async function loginWith(code) {
        await page.goto(`${f.baseUrl}/oauth2/authorize`);
        await page.locator('#loginUsername').fill(account.username);
        await page.locator('#loginPassword').fill(account.clearPassword);
        await page.locator('#loginForm .submit').click();
        await page.waitForURL('**/oauth2/mfa');
        await page.locator('#code').fill(code);
        await page.locator('#submit').click();
        await page.waitForURL('**/profile');
        await page.waitForFunction(() => !document.getElementById('totpActionBtn').disabled);
      }
      await loginWith(totpCode(legacySecret, -1));
      assert.equal(await page.locator('[data-authenticator-id="legacy"]').count(), 1);
      await page.locator('#totpActionBtn').click();
      await page.locator('#totpDeviceName').fill('工作手机');
      await page.locator('#totpCurrentCode').fill('incorrect');
      await page.locator('#totpSetupSubmit').click();
      await page.locator('#totpEnrollError').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#totpConfirmForm').isVisible(), false);
      await page.locator('#totpCurrentCode').fill(recoveryCodes[0]);
      await page.locator('#totpSetupSubmit').click();
      await page.locator('#totpConfirmForm').waitFor({ state: 'visible' });
      const newSecret = await page.locator('#totpSecretText').innerText();
      assert.notEqual(newSecret, legacySecret);
      assert.ok((await page.locator('#totpQrImage').getAttribute('src')).startsWith('data:image/png;base64,'));
      await page.locator('#totpEnableCode').fill('000000');
      if (totpCode(newSecret, -1) === '000000' || totpCode(newSecret) === '000000' || totpCode(newSecret, 1) === '000000') {
        await page.locator('#totpEnableCode').fill('111111');
      }
      await page.locator('#totpEnableBtn').click();
      await page.locator('#totpEnrollError').waitFor({ state: 'visible' });
      const errorBounds = await page.locator('#totpEnrollError').boundingBox();
      assert.ok(errorBounds.y >= 0 && errorBounds.y + errorBounds.height <= viewport.height + 1, 'Binding error is visible near the submit button');
      await page.screenshot({ path: path.join(artifacts, `totp-add-${viewport.width}.png`), animations: 'disabled' });
      await page.locator('#totpEnableCode').fill(totpCode(newSecret, -1));
      await page.locator('#totpEnableBtn').click();
      await page.locator('#totpEnrollModal').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelectorAll('[data-authenticator-id]').length === 2);
      assert.equal(await page.locator('#totpSecretText').innerText(), '', 'An active secret is cleared from the DOM');
      assert.equal(await page.locator('#totpRecoveryRemaining').innerText(), '2');
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('[data-authenticator-id]').length === 2);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#totpDevicesList').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(artifacts, `totp-devices-${viewport.width}.png`), animations: 'disabled' });

      await context.clearCookies();
      await loginWith(totpCode(legacySecret));
      await context.clearCookies();
      await loginWith(totpCode(newSecret));

      await page.locator('#totpActionBtn').click();
      await page.locator('#totpDeviceName').fill('取消添加的设备');
      await page.locator('#totpCurrentCode').fill(recoveryCodes[1]);
      await page.locator('#totpSetupSubmit').click();
      await page.locator('#totpConfirmForm').waitFor({ state: 'visible' });
      const cancelled = await page.locator('#totpSecretText').innerText();
      await page.locator('#totpConfirmForm [data-close-modal]').click();
      await page.locator('#totpEnrollModal').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#totpSecretText').innerText(), '');
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('[data-authenticator-id]').length === 2);
      assert.ok(!await page.locator('#totpDevicesList').innerText().then(text => text.includes('取消添加的设备')));

      let staged;
      let stageReady;
      const stagedOnServer = new Promise(resolve => { stageReady = resolve; });
      await context.route('**/api/account/totp/authenticators/setup', async route => {
        const response = await route.fetch();
        staged = { route, response, body: await response.json() };
        stageReady();
      });
      await page.locator('#totpActionBtn').click();
      await page.locator('#totpDeviceName').fill('延迟返回的设备');
      await page.locator('#totpCurrentCode').fill(totpCode(legacySecret, 1));
      await page.locator('#totpSetupSubmit').click();
      await stagedOnServer;
      assert.equal(staged.response.status(), 200);
      await page.locator('#totpEnrollForm [data-close-modal]').click();
      const pendingDeleted = page.waitForResponse(response => response.request().method() === 'DELETE'
        && new URL(response.url()).pathname === `/api/account/totp/authenticators/${staged.body.id}`);
      await staged.route.fulfill({ response: staged.response });
      assert.equal((await pendingDeleted).status(), 200);
      await context.unroute('**/api/account/totp/authenticators/setup');
      await page.waitForFunction(() => !document.getElementById('totpSetupSubmit').disabled);
      const cancellation = await context.request.post(`${f.baseUrl}/api/account/totp/authenticators/${staged.body.id}/confirm`, {
        headers: { Origin: f.baseUrl }, data: { code: totpCode(staged.body.secret) }
      });
      assert.equal(cancellation.status(), 400, 'Closing during setup must cancel a late server-created binding');
      assert.equal(await page.locator('#totpSecretText').innerText(), '');

      await page.locator('[data-remove-authenticator="legacy"]').click();
      assert.equal(await page.locator('#totpLastDeviceWarning').isVisible(), false);
      await page.locator('#totpManageCode').fill(recoveryCodes[2]);
      await page.locator('#totpManageSubmit').click();
      await page.locator('#totpManageModal').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelectorAll('[data-authenticator-id]').length === 1);
      assert.ok(page.url().endsWith('/profile'));
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll('[data-authenticator-id]').length === 1);
      await page.locator('[data-remove-authenticator]').click();
      assert.equal(await page.locator('#totpLastDeviceWarning').isVisible(), true);
      await page.locator('#totpManageForm [data-close-modal]').click();
      const currentStatus = await context.request.get(`${f.baseUrl}/api/account/totp`);
      assert.equal((await currentStatus.json()).totpEnabled, true);
      assert.equal((await f.login(account, { totp_code: totpCode(cancelled) })).status, 400);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Authenticator browser checks passed: old/new devices both login, add validation, independent removal, cancellation, secret cleanup, desktop/mobile');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
