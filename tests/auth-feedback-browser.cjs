const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

// Account-first login: the primary action advances from account entry to the password step.
async function continueToPassword(page) {
  await page.locator('#loginForm .submit').click();
  await page.waitForFunction(() => {
    const field = document.getElementById('loginPassword');
    return Boolean(field) && !field.disabled && field.getBoundingClientRect().width > 1;
  }, null, { timeout: 15000 });
}

const POLICY_ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'registration-policy');
const USERNAME_ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'username-input');
const POLICY_LANGUAGES = [
  { language: 'zh', hint: minimum => `至少 ${minimum} 位`, neutral: '请输入新密码', invalid: '用户名只能使用' },
  { language: 'en', hint: minimum => `At least ${minimum} characters`, neutral: 'Choose a new password', invalid: 'Use 1–255 letters' },
  { language: 'zh-TW', hint: minimum => `至少 ${minimum} 個字元`, neutral: '請輸入新密碼', invalid: '使用者名稱只能使用' }
];

async function openPolicyContext(browser, fixture, viewport) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN' });
  await context.route('**/*', route => new URL(route.request().url()).origin === fixture.baseUrl ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors };
}

async function assertPasswordHints(page, minimum) {
  for (const locale of POLICY_LANGUAGES) {
    await page.evaluate(language => window.VaultI18n.setLanguage(language), locale.language);
    const expected = minimum === null ? locale.neutral : locale.hint(minimum);
    for (const id of ['registerPassword', 'setupPassword', 'recoverPassword']) {
      assert.equal(await page.locator(`#${id}`).getAttribute('placeholder'), expected, `${id} follows ${locale.language} and current config`);
      assert.equal(await page.locator(`#${id}`).getAttribute('minlength'), null, 'Guidance must not duplicate server password validation');
    }
    assert.equal(await page.locator('#loginPassword').getAttribute('minlength'), null);
    assert.ok(!(await page.locator('#loginPassword').getAttribute('placeholder')).includes(String(minimum)));
  }
  await page.evaluate(() => window.VaultI18n.setLanguage('zh'));
}

async function assertProfileHints(page, minimum) {
  for (const locale of POLICY_LANGUAGES) {
    await page.evaluate(language => window.VaultI18n.setLanguage(language), locale.language);
    const expected = minimum === null ? locale.neutral : locale.hint(minimum);
    assert.equal(await page.locator('#newPasswordInput').getAttribute('placeholder'), expected);
    assert.equal(await page.locator('#profilePasswordHint').innerText(), expected);
    assert.equal(await page.locator('#newPasswordInput').getAttribute('minlength'), null);
  }
  await page.evaluate(() => window.VaultI18n.setLanguage('zh'));
}

async function assertVisibleHint(page, selector) {
  const hint = page.locator(selector);
  await hint.scrollIntoViewIfNeeded();
  const box = await hint.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1 && box.y >= 0 && box.y + box.height <= viewport.height + 1,
    `${selector} remains readable in the viewport`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
}

async function checkUsernameEditing(browser, fixture) {
  fs.mkdirSync(USERNAME_ARTIFACTS, { recursive: true });
  const evidence = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    fixture.reset();
    const { context, page, errors } = await openPolicyContext(browser, fixture, viewport);
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.baseUrl });
      await page.goto(`${fixture.baseUrl}/oauth2/authorize`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      for (const identifier of ['person@example.test', '旧有中文账号', 'old-hyphen-name']) {
        await page.locator('#loginUsername').fill(identifier);
        assert.equal(await page.locator('#loginUsername').inputValue(), identifier, 'Login identifiers retain legacy characters');
      }
      await page.locator('[data-mode="register"]').click();
      const username = page.locator('#registerUsername');
      const selection = () => username.evaluate(input => ({ start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }));
      let submissions = 0;
      page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/oauth2/register')) submissions += 1; });

      await username.pressSequentially('Az_09');
      assert.equal(await username.inputValue(), 'Az_09', 'Typing keeps ASCII case, digits and underscore');
      await username.pressSequentially('- .!@');
      assert.equal(await username.inputValue(), 'Az_09', 'Typing removes hyphen, whitespace and punctuation');
      await username.fill('中文用户名');
      assert.equal(await username.inputValue(), '', 'Committed unsupported text is removed');
      await username.fill('a中文 B-é_9!😀Ａ');
      assert.equal(await username.inputValue(), 'aB_9', 'Mixed committed text preserves only allowed ASCII');

      // Exercise the browser clipboard paste path, not a dispatched synthetic paste event.
      await username.fill('');
      await page.evaluate(() => navigator.clipboard.writeText('Ab中 -c_09!'));
      await username.press('Control+V');
      assert.equal(await username.inputValue(), 'Abc_09', 'Real paste removes unsupported characters');
      await page.evaluate(() => navigator.clipboard.writeText('X中文-Y'));
      await username.evaluate(input => input.setSelectionRange(2, 5));
      await username.press('Control+V');
      assert.equal(await username.inputValue(), 'AbXY9', 'Paste replaces the selected range');
      assert.equal((await selection()).start, 4, 'Caret follows the retained replacement');
      await username.fill('');
      await page.evaluate(() => navigator.clipboard.writeText(`${'中-'.repeat(150)}Valid_9`));
      await username.press('Control+V');
      assert.equal(await username.inputValue(), 'Valid_9', 'Filter a long raw paste before native maxlength can discard allowed suffixes');
      await username.fill(`${'a'.repeat(250)}_END`);
      await username.evaluate(input => input.setSelectionRange(249, 250));
      await page.evaluate(() => navigator.clipboard.writeText(`中${'Z'.repeat(10)}`));
      await username.press('Control+V');
      assert.equal(await username.inputValue(), `${'a'.repeat(249)}ZZ_END`, 'Bound a paste to available replacement space while preserving the original suffix');
      assert.equal((await selection()).start, 251);
      await username.fill('');
      await page.evaluate(() => navigator.clipboard.writeText(`中${'B'.repeat(300)}`));
      await username.press('Control+V');
      assert.equal(await username.inputValue(), 'B'.repeat(255), 'Long mixed paste keeps at most 255 allowed characters');

      // Controlled input-event probe covers backward selections that native paste collapses.
      await username.evaluate(input => {
        input.value = 'ab中_cd-ef';
        input.setSelectionRange(1, 8, 'backward');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
      });
      assert.equal(await username.inputValue(), 'ab_cdef');
      assert.deepEqual(await selection(), { start: 1, end: 6, direction: 'backward' });
      await username.fill('Ab_09');
      await username.evaluate(input => input.setSelectionRange(2, 2));
      await page.keyboard.insertText('中-!');
      assert.equal(await username.inputValue(), 'Ab_09');
      assert.equal((await selection()).start, 2, 'Filtering in the middle does not jump the caret to the end');
      await username.press('ArrowRight');
      await username.press('Backspace');
      assert.equal(await username.inputValue(), 'Ab09', 'Backward deletion retains normal editing');
      await username.press('Delete');
      assert.equal(await username.inputValue(), 'Ab9', 'Forward deletion retains normal editing');
      await username.press('Control+A');
      await username.press('Backspace');
      assert.equal(await username.inputValue(), '', 'The optional username can be cleared');
      assert.equal(await username.evaluate(input => input.checkValidity()), true);
      await username.fill('A'.repeat(300));
      assert.equal((await username.inputValue()).length, 255, 'Native editing respects the 255-character limit');
      await username.pressSequentially('Z');
      assert.equal((await username.inputValue()).length, 255);
      await username.evaluate(input => {
        input.value = 'B'.repeat(300);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      assert.equal(await username.inputValue(), 'B'.repeat(255), 'Event-driven autofill also respects the bound');

      const email = `username-input-blank-${viewport.width}@example.test`;
      const password = 'Editing_Test_2026!';
      await page.locator('#registerName').fill('中文显示名称');
      await page.locator('#registerEmail').fill(email);
      await page.locator('#registerEmailCode').fill('123456');
      await page.locator('#registerPassword').fill(password);
      await page.locator('#registerConfirmPassword').fill(password);

      // These are dispatched composition events, not an actual operating-system IME.
      await username.evaluate(input => {
        input.focus();
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input.value = 'A中_-9';
        input.setSelectionRange(5, 5);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中', isComposing: true }));
      });
      assert.equal(await username.inputValue(), 'A中_-9', 'An unfinished composition is not mutated');
      assert.equal(await username.evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }))), false,
        'Composition Enter cannot submit');
      await username.evaluate(input => {
        // A temporarily valid composing value would pass native pattern validation.
        input.value = 'Pending_9';
        input.form.requestSubmit();
        input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      assert.equal(submissions, 0, 'A composing username cannot POST even if it is temporarily valid');
      await username.evaluate(input => {
        input.value = 'A中_-9';
        input.setSelectionRange(5, 5);
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }));
      });
      assert.equal(await username.inputValue(), 'A_9', 'Composition end filters the committed value');
      assert.equal((await selection()).start, 3);
      assert.equal(submissions, 0, 'Composition end does not submit automatically');
      const imeEventOrdering = await username.evaluate(input => {
        input.value = 'Pending_9';
        const probe = options => {
          const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options });
          const dispatchAllowed = input.dispatchEvent(event);
          // Synthetic keydown has no native default: explicitly replay it only if allowed.
          if (dispatchAllowed) input.form.requestSubmit();
          return { defaultPrevented: event.defaultPrevented, dispatchAllowed, keyCode: event.keyCode, isComposing: event.isComposing };
        };
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        const activeFlagOnly = probe({ isComposing: false, keyCode: 13 });
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        const eventFlagOnly = probe({ isComposing: true, keyCode: 13 });
        // Some IMEs deliver compositionend before their confirmation keydown.
        const postComposition229 = probe({ isComposing: false, keyCode: 229 });
        input.value = 'A_9';
        return { activeFlagOnly, eventFlagOnly, postComposition229, explicitDefaultActionReplay: true };
      });
      for (const key of ['activeFlagOnly', 'eventFlagOnly', 'postComposition229']) {
        assert.equal(imeEventOrdering[key].defaultPrevented, true, `${key} confirmation Enter is prevented`);
        assert.equal(imeEventOrdering[key].dispatchAllowed, false);
      }
      assert.equal(imeEventOrdering.postComposition229.keyCode, 229);
      assert.equal(imeEventOrdering.postComposition229.isComposing, false);
      assert.equal(submissions, 0, 'IME Enter never POSTs, including after compositionend with both composing flags false');
      await assertVisibleHint(page, '#registerUsernameHint');
      await page.screenshot({ path: path.join(USERNAME_ARTIFACTS, `username-editing-${viewport.width}.png`), fullPage: true, animations: 'disabled' });

      // Values assigned without editing events still need a strict raw submit guard.
      await page.locator('#registerConfirmPassword').focus();
      for (const raw of ['中文用户名', 'bad-name', 'has space', 'x'.repeat(256)]) {
        await username.evaluate((input, value) => {
          input.value = value;
          input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }, raw);
        assert.ok((await page.locator('#statusMessage').innerText()).includes(POLICY_LANGUAGES[0].invalid));
        assert.equal(submissions, 0, 'Raw programmatic invalid values never POST');
      }

      await username.fill('');
      const sent = page.waitForResponse(response => response.url().endsWith('/api/email-verification/send') && response.request().method() === 'POST');
      await page.locator('#sendRegisterCodeBtn').click();
      assert.equal((await sent).status(), 200);
      await page.locator('#registerEmailCode').fill(fixture.lastCode(email));
      const registered = page.waitForResponse(response => response.url().endsWith('/oauth2/register') && response.request().method() === 'POST');
      await username.press('Enter');
      assert.equal((await registered).status(), 200, 'Ordinary non-IME Enter still registers using the optional email fallback');
      await page.waitForURL('**/profile');
      assert.equal(submissions, 1);
      assert.equal((await fixture.User.findByEmail(email)).username, email);
      assert.deepEqual(errors, []);
      evidence.push({ viewport: viewport.width, nativeTypingAndClipboard: true, mixedPasteBeforeLengthLimit: true,
        boundedPastePreservesSuffix: true, caretSelectionDeletion: true, maxLength: 255,
        dispatchedCompositionSimulation: true, actualOsImeTested: false, rawSubmitGuard: true, blankEmailFallback: true,
        imeEventOrdering, normalEnterRegistration: true, legacyLoginValuesPreserved: true });
    } finally {
      await context.close();
    }
  }
  fs.writeFileSync(path.join(USERNAME_ARTIFACTS, 'browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function checkRegistrationPolicy(browser, fixture) {
  fs.mkdirSync(POLICY_ARTIFACTS, { recursive: true });
  const evidence = [];
  for (const minimum of [12, 16]) {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      fixture.reset();
      // This is a real server setting, not a config-response replacement.
      fixture.pool.settings.push({ setting_key: 'password_min_length', setting_value: String(minimum) });
      const account = await fixture.user();
      const setupAccount = await fixture.User.create({ username: `setup-${minimum}-${viewport.width}`, email: `setup-${minimum}-${viewport.width}@example.test`, password: '' });
      const { context, page, errors } = await openPolicyContext(browser, fixture, viewport);
      try {
        const configResponse = page.waitForResponse(response => response.url().includes('/api/auth/config?surface=web'));
        await page.goto(`${fixture.baseUrl}/oauth2/authorize`);
        assert.equal((await (await configResponse).json()).passwordMinLength, minimum);
        await page.locator('#authRegion').waitFor({ state: 'visible' });
        await page.waitForFunction(minimum => document.getElementById('registerPassword').placeholder.includes(String(minimum)), minimum);
        await assertPasswordHints(page, minimum);

        await page.locator('#loginUsername').fill(setupAccount.username);
        await page.locator('#loginForm .submit').click();
        await page.locator('#passwordSetupForm').waitFor({ state: 'visible' });
        await assertVisibleHint(page, '#setupPassword');
        await page.screenshot({ path: path.join(POLICY_ARTIFACTS, `setup-${minimum}-${viewport.width}.png`), animations: 'disabled' });
        await page.locator('#changeLoginAccountBtn').click();
        await page.locator('#loginUsername').fill(account.username);
        await continueToPassword(page);
        await page.locator('#showRecoveryBtn').click();
        await assertVisibleHint(page, '#recoverPassword');
        await page.screenshot({ path: path.join(POLICY_ARTIFACTS, `recovery-${minimum}-${viewport.width}.png`), animations: 'disabled' });

        await page.locator('[data-mode="register"]').click();
        await assertVisibleHint(page, '#registerUsernameHint');
        await assertVisibleHint(page, '#registerPassword');
        await page.screenshot({ path: path.join(POLICY_ARTIFACTS, `register-guidance-${minimum}-${viewport.width}.png`), fullPage: true, animations: 'disabled' });
        const email = `registration-${minimum}-${viewport.width}@example.test`;
        const username = `Ascii_${minimum}_${viewport.width}`;
        await page.locator('#registerName').fill('中文显示名称');
        await page.locator('#registerUsername').fill(username);
        await page.locator('#registerEmail').fill(email);
        const sent = page.waitForResponse(response => response.url().endsWith('/api/email-verification/send') && response.request().method() === 'POST');
        await page.locator('#sendRegisterCodeBtn').click();
        assert.equal((await sent).status(), 200);
        await page.locator('#registerEmailCode').fill(fixture.lastCode(email));
        let submissions = 0;
        page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/oauth2/register')) submissions += 1; });
        const shortPassword = `Aa1!${'x'.repeat(minimum - 5)}`;
        await page.locator('#registerPassword').fill(shortPassword);
        await page.locator('#registerConfirmPassword').fill(shortPassword);
        await page.locator('#registerForm .submit').click();
        await page.waitForFunction(minimum => document.getElementById('statusMessage').textContent.includes(`密码长度不能少于 ${minimum} 位`), minimum);
        assert.equal(submissions, 1, 'An under-policy password still reaches server validation');

        const password = `Aa1!${'x'.repeat(minimum - 4)}`;
        await page.locator('#registerPassword').fill(password);
        await page.locator('#registerConfirmPassword').fill(password);
        // Bypass editing events to exercise native pattern feedback for a raw invalid value.
        await page.locator('#registerUsername').evaluate(input => { input.value = '中文用户名'; });
        for (const locale of POLICY_LANGUAGES) {
          await page.evaluate(language => window.VaultI18n.setLanguage(language), locale.language);
          await page.locator('#registerForm .submit').click();
          assert.ok((await page.locator('#statusMessage').innerText()).includes(locale.invalid));
          assert.equal(await page.locator('#statusMessage').evaluate(element => element.previousElementSibling.matches('#registerForm .submit')), true);
          await assertVisibleHint(page, '#statusMessage');
          assert.equal(submissions, 1, 'Invalid explicit username is rejected locally without a POST');
        }
        assert.equal(await fixture.User.findByUsername('中文用户名'), null);
        await page.screenshot({ path: path.join(POLICY_ARTIFACTS, `register-username-error-${minimum}-${viewport.width}.png`), animations: 'disabled' });
        await page.evaluate(() => window.VaultI18n.setLanguage('zh'));
        await page.locator('#registerUsername').fill(username);
        const registration = page.waitForResponse(response => response.url().endsWith('/oauth2/register') && response.request().method() === 'POST');
        await page.locator('#registerForm .submit').click();
        assert.equal((await registration).status(), 200, 'Valid ASCII name accepts the same unconsumed email proof');
        assert.equal(submissions, 2);
        assert.equal((await fixture.User.findByUsername(username)).name, '中文显示名称');
        await page.waitForURL('**/profile');
        await page.locator('#profileContent').waitFor({ state: 'visible' });
        await page.locator('#editPasswordBtn').click();
        await page.waitForFunction(minimum => document.getElementById('newPasswordInput').placeholder.includes(String(minimum)), minimum);
        await assertProfileHints(page, minimum);
        await assertVisibleHint(page, '#profilePasswordHint');
        await page.screenshot({ path: path.join(POLICY_ARTIFACTS, `profile-${minimum}-${viewport.width}.png`), animations: 'disabled' });
        assert.deepEqual(errors, []);
        evidence.push({ minimum, viewport: viewport.width, config: 'real fixture setting', languages: POLICY_LANGUAGES.map(item => item.language), registeredUsername: username, unicodeDisplayName: true });
      } finally {
        await context.close();
      }
    }
  }

  // Only uncertainty cases replace transport. Main 12/16 policy evidence above uses the real API.
  for (const mode of ['delayed', 'failed', 'malformed']) {
    for (const surface of ['auth', 'profile']) {
      fixture.reset();
      const account = await fixture.user();
      const { context, page, errors } = await openPolicyContext(browser, fixture, { width: 390, height: 844 });
      let heldRoute;
      let captureRoute;
      const capturedRoute = new Promise(resolve => { captureRoute = resolve; });
      try {
        if (surface === 'profile') {
          const authenticated = await context.request.post(`${fixture.baseUrl}/oauth2/authorize`, {
            headers: { Origin: fixture.baseUrl }, data: { username: account.username, password: account.clearPassword }
          });
          assert.equal(authenticated.status(), 200);
        }
        await page.route('**/api/auth/config**', async route => {
          if (mode === 'delayed') {
            heldRoute = route;
            captureRoute(route);
          } else if (mode === 'failed') {
            await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
          } else {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passwordMinLength: '6' }) });
          }
        });
        const configResponse = page.waitForResponse(response => response.url().includes('/api/auth/config'));
        await page.goto(`${fixture.baseUrl}/${surface === 'auth' ? 'oauth2/authorize' : 'profile'}`);
        await page.locator(surface === 'auth' ? '#authRegion' : '#profileContent').waitFor({ state: 'visible' });
        if (surface === 'profile') await page.locator('#editPasswordBtn').click();
        if (mode === 'delayed') await capturedRoute;
        else {
          await (await configResponse).finished();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        if (surface === 'auth') {
          await assertPasswordHints(page, null);
          await page.locator('[data-mode="register"]').click();
          await assertVisibleHint(page, '#registerPassword');
        } else {
          await assertProfileHints(page, null);
          await assertVisibleHint(page, '#profilePasswordHint');
        }
        await page.screenshot({ path: path.join(POLICY_ARTIFACTS, `${surface}-config-${mode}.png`), fullPage: true, animations: 'disabled' });
        if (heldRoute) {
          await heldRoute.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ passwordMinLength: 16 }) });
          heldRoute = null;
          await configResponse;
          await page.waitForFunction(surface => document.getElementById(surface === 'auth' ? 'registerPassword' : 'newPasswordInput').placeholder.includes('16'), surface);
          if (surface === 'auth') await assertPasswordHints(page, 16);
          else await assertProfileHints(page, 16);

          // A later unavailable config must not retain a formerly valid numeric promise.
          await page.route('**/api/auth/config**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
          await page.evaluate(surface => surface === 'auth' ? hydrateAuthConfig() : loadPasswordGuidance(), surface);
          if (surface === 'auth') await assertPasswordHints(page, null);
          else await assertProfileHints(page, null);
        }
        assert.deepEqual(errors, []);
        evidence.push({ configTransportSimulation: mode, surface, neutral: true, delayedRecovery: mode === 'delayed' });
      } finally {
        if (heldRoute) await heldRoute.abort();
        await context.close();
      }
    }
  }
  fs.writeFileSync(path.join(POLICY_ARTIFACTS, 'browser-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

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
          return status?.closest('form')?.id === formId && status.textContent.includes(expected);
        }, { formId, expected });
        // The login card nests its account/password/setup steps inside one form, so the
        // adjacency rule is expressed against the submit control that produced the feedback.
        assert.equal(await status.evaluate(element => element.previousElementSibling.matches('button.submit')), true);
        assert.equal(await status.evaluate(element => element.previousElementSibling.offsetParent !== null), true,
          'Feedback must stay attached to the submit control of the active step');
        const box = await status.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height + 1, 'Feedback remains fully visible after submission');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Feedback fits viewport');
        assert.ok(!/validation\.password|auth\.status|invalid_request/.test(await status.innerText()));
      }

      await page.locator('#loginUsername').fill(account.username);
      await continueToPassword(page);
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
      await page.locator('#loginUsername').fill(account.username);
      await continueToPassword(page);
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
    await checkUsernameEditing(browser, fixture);
    await checkRegistrationPolicy(browser, fixture);
    console.log('Authentication feedback browser checks passed: existing feedback and configured password guidance; desktop/mobile username typing, real clipboard paste, selection/caret/deletion/length, dispatched IME composition, strict raw submit guards, optional email fallback, legacy login values; three-language username feedback and real ASCII registration; neutral delayed/failed/malformed config');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
