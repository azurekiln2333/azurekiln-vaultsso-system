const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

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
    const account = await fixture.user();
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true, args: ['--disable-background-networking']
    });
    const artifacts = path.resolve(__dirname, '..', '.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.route('**/*', route => new URL(route.request().url()).origin === fixture.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${fixture.baseUrl}/oauth2/authorize`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#loginForm input[name="totp_code"]').count(), 0);
      assert.equal(await page.locator('#loginForm input[name="email_code"]').count(), 0);
      assert.equal(await page.locator('#loginForm [data-captcha-group]').isVisible(), false);

      async function assertFeedback(formId, expected) {
        const status = page.locator('#statusMessage');
        await page.waitForFunction(({ formId, expected }) => {
          const status = document.getElementById('statusMessage');
          return status?.parentElement.id === formId && status.textContent.includes(expected);
        }, { formId, expected });
        assert.equal(await status.evaluate(element => element.previousElementSibling.matches('button.submit')), true);
        const box = await status.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height + 1, 'Feedback remains fully visible after submission');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Feedback fits viewport');
        assert.ok(!/validation\.password|auth\.status|invalid_request/.test(await status.innerText()));
      }

      await page.locator('#loginUsername').fill(account.username);
      await page.locator('#loginPassword').fill('incorrect-password');
      await page.locator('#loginForm .submit').click();
      await assertFeedback('loginForm', '用户名或密码错误');
      await page.screenshot({ path: path.join(artifacts, `auth-login-error-${viewport.width}.png`), animations: 'disabled' });

      await page.locator('[data-mode="register"]').click();
      await page.locator('#registerName').fill('Feedback verification');
      await page.locator('#registerEmail').fill('feedback@example.test');
      await page.locator('#registerEmailCode').fill('123456');
      await page.locator('#registerPassword').fill('valid-long-password');
      await page.locator('#registerConfirmPassword').fill('different-long-password');
      let submissions = 0;
      page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/oauth2/register')) submissions += 1; });
      await page.locator('#registerForm .submit').click();
      await assertFeedback('registerForm', '两次输入的密码不一致');
      assert.equal(submissions, 0, 'Local password mismatch must not issue a registration request');
      await page.screenshot({ path: path.join(artifacts, `auth-register-mismatch-${viewport.width}.png`), animations: 'disabled' });

      await page.locator('#registerPassword').fill('short');
      await page.locator('#registerConfirmPassword').fill('short');
      await page.locator('#registerForm .submit').click();
      await assertFeedback('registerForm', '密码');
      assert.equal(submissions, 1);
      assert.ok(!(await page.locator('#statusMessage').innerText()).includes('validation.password.weak'));
      await page.locator('#registerEmail').fill('invalid-email');
      await page.locator('#sendRegisterCodeBtn').click();
      await assertFeedback('registerForm', '有效的邮箱');

      // A pending code-send must not overwrite feedback from a more recent submit.
      await page.locator('#registerEmail').fill('feedback@example.test');
      let captureSend;
      const pendingSend = new Promise(resolve => { captureSend = resolve; });
      await page.route('**/api/email-verification/send', route => { captureSend(route); });
      await page.locator('#sendRegisterCodeBtn').click();
      const sendRoute = await pendingSend;
      await page.locator('#registerForm .submit').click();
      await assertFeedback('registerForm', '密码');
      const latestError = await page.locator('#statusMessage').innerText();
      await sendRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message_key: 'email_code.sent' }) });
      await page.waitForFunction(() => !document.getElementById('sendRegisterCodeBtn').disabled);
      assert.equal(await page.locator('#statusMessage').innerText(), latestError);
      await page.unroute('**/api/email-verification/send');

      await page.locator('[data-mode="login"]').click();
      await page.locator('#showRecoveryBtn').click();
      await page.locator('#recoverEmail').fill('feedback@example.test');
      await page.locator('#recoverEmailCode').fill('123456');
      await page.locator('#recoverPassword').fill('valid-long-password');
      await page.locator('#recoverConfirmPassword').fill('different-long-password');
      await page.locator('#recoverForm .submit').click();
      await assertFeedback('recoverForm', '两次输入的密码不一致');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Authentication feedback browser checks passed: login, register mismatch/policy/email errors, recovery, desktop/mobile visibility');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
