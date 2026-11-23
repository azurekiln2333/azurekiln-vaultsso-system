const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

const ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'login-accounts');
const VIEWPORTS = [{ width: 1440, height: 1000, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }];
const LOCALES = [
  { locale: 'zh-CN', title: '选择账号', add: '添加账号', back: '返回账号列表', remove: /从此浏览器移除/ },
  { locale: 'zh-TW', title: '選擇帳號', add: '新增帳號', back: '返回帳號列表', remove: /從此瀏覽器移除/ },
  { locale: 'en-US', title: 'Choose an account', add: 'Add account', back: 'Back to accounts', remove: /^Remove .* from this browser$/ }
];

// Real browser account chooser regression: the isolated service issues the real session and roster
// cookies, and the real login page renders/selects/removes them. Only network egress is blocked.

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';
  const f = await createFixture({ port });
  let browser;
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  try {
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true,
      args: ['--disable-background-networking']
    });

    async function newSession({ viewport = VIEWPORTS[0], locale = 'zh-CN', storageState } = {}) {
      const context = await browser.newContext({ viewport, locale, ...(storageState ? { storageState } : {}) });
      await context.route('**/*', route =>
        new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      return { context, page, errors };
    }

    async function named(label) {
      const account = await f.user();
      await f.User.update(account.id, { name: label });
      return { ...account, name: label };
    }

    async function submitCredentials(page, account, { days = 1 } = {}) {
      await page.locator('#loginUsername').fill(account.username);
      if (await page.locator('#loginForm .submit').isVisible()) {
        await page.locator('#loginForm .submit').click();
        await page.waitForFunction(() => !document.getElementById('loginPassword').disabled);
      }
      await page.locator('#loginSessionDays').selectOption(String(days));
      await page.locator('#loginPassword').fill(account.clearPassword);
      await page.locator('#loginForm .submit').click();
    }

    async function signIn(page, account, options = {}) {
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      await submitCredentials(page, account, options);
      await page.waitForURL('**/profile');
    }

    async function sessionCookie(context) {
      const cookie = (await context.cookies()).find(item => item.name === 'session');
      assert.ok(cookie, 'a completed login issues the real session cookie');
      return { cookie, claims: jwt.verify(cookie.value, process.env.JWT_SECRET) };
    }

    async function profileId(context) {
      const response = await context.request.get(`${f.baseUrl}/api/profile`);
      assert.equal(response.status(), 200);
      return (await response.json()).user.id;
    }

    async function openChooser(page) {
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#sessionBanner').waitFor({ state: 'visible' });
    }

    function rows(page) {
      return page.locator('#sessionAccountList .account-row');
    }

    async function rowNames(page) {
      return rows(page).locator('.account-name').allInnerTexts();
    }

    // ---------------------------------------------------------------------
    // Layout, locales and the list/add/back surface.
    // ---------------------------------------------------------------------
    for (const viewport of VIEWPORTS) {
      for (const { locale, title, add, back, remove } of LOCALES) {
        f.reset();
        const a = await named('Alice Example');
        const { context, page, errors } = await newSession({ viewport, locale });
        await signIn(page, a);
        await openChooser(page);

        assert.equal(await page.locator('#sessionBannerTitle').innerText(), title);
        assert.equal(await rows(page).count(), 1, 'the signed-in account is listed');
        const row = rows(page).first();
        assert.equal(await row.getAttribute('data-account-id'), a.id, 'the row carries the real account id');
        assert.equal(await row.locator('.account-select').getAttribute('data-account-id'), a.id);
        assert.equal(await row.locator('.account-remove').getAttribute('data-account-id'), a.id);
        assert.equal(await row.locator('.account-select').getAttribute('aria-current'), 'true');
        assert.equal(await page.locator('#addAccountBtn').innerText(), add);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${viewport.tag}/${locale} list must not overflow`);
        await page.screenshot({ path: path.join(ARTIFACTS, `accounts-${viewport.tag}-${locale}.png`), fullPage: true });

        // Add account opens the ordinary sign-in form without logging the current account out.
        await page.locator('#addAccountBtn').click();
        await page.locator('#authRegion').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#sessionBanner').isVisible(), false);
        assert.equal(await page.locator('#backToAccountsBtn').innerText(), back);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${viewport.tag}/${locale} add mode must not overflow`);
        await page.locator('#backToAccountsBtn').focus();
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'backToAccountsBtn');
        await page.keyboard.press('Enter');
        await page.locator('#sessionBanner').waitFor({ state: 'visible' });
        assert.equal(await profileId(context), a.id, 'back must not log the current account out');
        // Keyboard access to the list: focusing the row button and pressing Enter selects that
        // account, which navigates to the continuation page as the same signed-in account.
        const selectButton = rows(page).first().locator('.account-select');
        await selectButton.focus();
        assert.equal(await page.evaluate(() => document.activeElement?.className), 'account-select');
        // Read the row-bound labels before activating: navigation replaces the chooser markup.
        assert.equal(await rows(page).first().locator('.account-select').getAttribute('data-account-id'), a.id);
        const removeLabels = await rows(page).first().locator('.account-remove').getAttribute('aria-label');
        assert.match(removeLabels, remove);
        await page.screenshot({ path: path.join(ARTIFACTS, `accounts-focus-${viewport.tag}-${locale}.png`), fullPage: true });
        await page.keyboard.press('Enter');
        await page.waitForURL('**/profile');
        assert.equal(new URL(page.url()).pathname, '/profile', 'Enter on the row continues to the profile');
        assert.equal(await profileId(context), a.id, 'Enter activates the focused account');
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
    console.log('Account chooser layout passed: list, add, back, keyboard focus and three locales at desktop/mobile');

    // ---------------------------------------------------------------------
    // Real A -> add B -> switch A flow, original sid/expiry preserved.
    // ---------------------------------------------------------------------
    f.reset();
    const a = await named('Alice Example');
    const b = await named('Bob Example');
    {
      const { context, page, errors } = await newSession();
      await signIn(page, a, { days: 7 });
      const first = await sessionCookie(context);
      assert.equal(first.claims.sub, a.id);
      const firstCookie = first.cookie;
      const firstRow = f.pool.sessions.find(item => item.token === first.claims.sid);
      const originalExpiry = new Date(firstRow.expires_at).getTime();
      const originalCreatedAt = new Date(firstRow.created_at).toISOString();

      await openChooser(page);
      await page.locator('#addAccountBtn').click();
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      await submitCredentials(page, b, { days: 14 });
      await page.waitForURL('**/profile');
      assert.equal(await profileId(context), b.id);

      await openChooser(page);
      assert.deepEqual(await rowNames(page), ['Bob Example', 'Alice Example'], 'most recently used first');
      assert.equal(await rows(page).first().locator('.account-select').getAttribute('aria-current'), 'true');
      await page.screenshot({ path: path.join(ARTIFACTS, 'accounts-desktop-two-accounts.png'), fullPage: true });

      const beforeSwitch = f.pool.sessions.length;
      await rows(page).nth(1).locator('.account-select').click();
      await page.waitForURL('**/profile');
      assert.equal(await profileId(context), a.id, 'selecting a stored account continues to profile as that account');
      const restored = await sessionCookie(context);
      assert.equal(restored.claims.sid, first.claims.sid, 'switching restores the original session id');
      assert.equal(restored.claims.exp, first.claims.exp, 'switching preserves the original deadline');
      // The browser cookie keeps the same deadline it already had: switching must not re-issue a
      // cookie with a later expiry. Playwright reports fractional seconds, so compare with the
      // sub-second rounding a cookie attribute carries rather than for exact equality.
      assert.ok(Math.abs(restored.cookie.expires * 1000 - firstCookie.expires * 1000) < 1000,
        'switching keeps the existing cookie deadline');
      assert.ok(Math.abs(restored.cookie.expires * 1000 - originalExpiry) < 1000,
        'switching keeps the database expiry within cookie attribute precision');
      assert.equal(f.pool.sessions.length, beforeSwitch, 'switching never creates a session row');
      assert.equal(new Date(f.pool.sessions.find(item => item.token === first.claims.sid).created_at).toISOString(),
        originalCreatedAt, 'switching never invents a recent authentication time');

      // Reload shows the same chooser with A selected.
      await openChooser(page);
      assert.deepEqual(await rowNames(page), ['Alice Example', 'Bob Example']);
      assert.equal(await rows(page).first().locator('.account-select').getAttribute('aria-current'), 'true');

      // No credential material is exposed to page JavaScript. A locale preference in
      // localStorage/sessionStorage is legitimate, so only credential VALUES are forbidden. Probe
      // the actual secrets this session uses, so a UUID or opaque value cannot slip past a shape
      // regex: the live session id, the signed cookie values, and both fixture passwords.
      const rosterCookie = (await context.cookies()).find(item => item.name === 'browser_accounts');
      assert.ok(rosterCookie, 'the chooser keeps its own signed roster cookie');
      const liveSession = await sessionCookie(context);
      const exposed = await page.evaluate(() => ({
        cookie: document.cookie,
        local: Object.entries(localStorage),
        session: Object.entries(sessionStorage),
        html: document.documentElement.innerHTML
      }));
      const pageStores = JSON.stringify([exposed.local, exposed.session]);
      const pageText = `${pageStores}\n${exposed.html}`;
      assert.ok(!exposed.cookie.includes('session='), 'session cookie stays HttpOnly');
      assert.ok(!exposed.cookie.includes('browser_accounts='), 'roster cookie stays HttpOnly');
      const secrets = [
        ['session id', first.claims.sid],
        ['live session id', liveSession.claims.sid],
        ['session cookie value', liveSession.cookie.value],
        ['roster cookie value', rosterCookie.value],
        ['account A password', a.clearPassword],
        ['account B password', b.clearPassword]
      ];
      for (const [label, secret] of secrets) {
        assert.ok(secret && String(secret).length > 8, `${label} is a real probe value`);
        assert.ok(!pageText.includes(String(secret)), `${label} must not reach the DOM or page storage`);
      }
      assert.ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(pageText), 'no JWT-shaped value reaches the page');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Account chooser flow passed: add B, choose A, original sid/expiry, reload, no credential material in the page');

    // ---------------------------------------------------------------------
    // Failed add-mode authentication preserves the active account.
    // ---------------------------------------------------------------------
    f.reset();
    {
      const a = await named('Alice Example');
      const b = await f.user();
      const { context, page, errors } = await newSession();
      await signIn(page, a);
      const before = await sessionCookie(context);
      await openChooser(page);
      await page.locator('#addAccountBtn').click();
      await page.locator('#loginUsername').fill(b.username);
      await page.locator('#loginForm .submit').click();
      await page.waitForFunction(() => !document.getElementById('loginPassword').disabled);
      await page.locator('#loginPassword').fill('wrong-password-value');
      await page.locator('#loginForm .submit').click();
      await page.locator('#statusMessage.is-visible').waitFor({ state: 'visible' });
      assert.ok((await page.locator('#statusMessage').innerText()).length > 0, 'a failed add attempt is reported');
      assert.equal(await profileId(context), a.id, 'a failed login preserves the active account');
      await page.locator('#backToAccountsBtn').click();
      await page.locator('#sessionBanner').waitFor({ state: 'visible' });
      assert.deepEqual(await rowNames(page), ['Alice Example']);
      assert.equal((await sessionCookie(context)).claims.sid, before.claims.sid);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---------------------------------------------------------------------
    // Revoked entry: selecting it shows a readable error and refreshes the list.
    // ---------------------------------------------------------------------
    f.reset();
    {
      const a = await named('Alice Example');
      const b = await named('Bob Example');
      const { context, page, errors } = await newSession({ viewport: VIEWPORTS[1] });
      await signIn(page, a);
      await openChooser(page);
      await page.locator('#addAccountBtn').click();
      await submitCredentials(page, b);
      await page.waitForURL('**/profile');
      await openChooser(page);

      // B's session is revoked server-side while its roster entry is still present.
      const bClaims = (await sessionCookie(context)).claims;
      f.pool.sessions.find(item => item.token === bClaims.sid).revoked_at = new Date();
      await rows(page).first().locator('.account-select').click();
      await page.locator('#accountsStatus.is-visible').waitFor({ state: 'visible' });
      const message = await page.locator('#accountsStatus').innerText();
      // The contract requires a readable message from the existing `auth.required` key; the exact
      // wording is the server's, so accept any non-empty localized explanation rather than one
      // specific phrase.
      assert.ok(message.trim().length > 0, 'a rejected switch shows readable feedback');
      assert.ok(!/^auth\./.test(message), 'the message is human-readable, not a machine key');
      await page.waitForFunction(() => document.querySelectorAll('#sessionAccountList .account-row').length === 1);
      assert.deepEqual(await rowNames(page), ['Alice Example']);
      assert.equal(new URL(page.url()).pathname, '/oauth2/authorize', 'a rejected switch never navigates away');
      await page.screenshot({ path: path.join(ARTIFACTS, 'accounts-error-mobile-zh-CN.png'), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Account chooser errors passed: failed add preserves the account; a revoked entry reports and refreshes');

    // ---------------------------------------------------------------------
    // Remove: inactive entry only, then the active entry, then empty browser.
    // ---------------------------------------------------------------------
    f.reset();
    {
      const a = await named('Alice Example');
      const b = await named('Bob Example');
      const { context, page, errors } = await newSession();
      await signIn(page, a);
      const aClaims = (await sessionCookie(context)).claims;
      await openChooser(page);
      await page.locator('#addAccountBtn').click();
      await submitCredentials(page, b);
      await page.waitForURL('**/profile');
      const bClaims = (await sessionCookie(context)).claims;
      await openChooser(page);

      // Remove inactive A from the list.
      await rows(page).nth(1).locator('.account-remove').click();
      await page.waitForFunction(() => document.querySelectorAll('#sessionAccountList .account-row').length === 1);
      assert.deepEqual(await rowNames(page), ['Bob Example']);
      assert.ok(f.pool.sessions.find(item => item.token === aClaims.sid).revoked_at, 'removal revokes that saved session');
      assert.equal(f.pool.sessions.find(item => item.token === bClaims.sid).revoked_at, null);
      assert.equal(await profileId(context), b.id, 'removing an inactive account keeps the active one signed in');

      // Remove the active B: the login form becomes available, A is already gone.
      await rows(page).first().locator('.account-remove').click();
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#sessionBanner').isVisible(), false);
      const leftover = await context.request.get(`${f.baseUrl}/api/profile`);
      assert.equal(leftover.status(), 401, 'removing the active account clears the session cookie');
      assert.deepEqual(await page.evaluate(() => document.cookie), '');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---------------------------------------------------------------------
    // A legacy browser with only the old session cookie is enrolled.
    // ---------------------------------------------------------------------
    f.reset();
    {
      const a = await named('Alice Example');
      const { context, page, errors } = await newSession();
      await signIn(page, a);
      const legacy = await sessionCookie(context);
      await context.clearCookies({ name: 'browser_accounts' });
      assert.equal((await context.cookies()).some(item => item.name === 'browser_accounts'), false);
      await openChooser(page);
      assert.deepEqual(await rowNames(page), ['Alice Example'], 'an existing single-session browser is listed');
      assert.equal(await rows(page).first().locator('.account-select').getAttribute('aria-current'), 'true');
      assert.equal(await profileId(context), a.id);
      const stillSame = await sessionCookie(context);
      assert.equal(stillSame.claims.sid, legacy.claims.sid, 'enrollment is not a re-authentication');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---------------------------------------------------------------------
    // An empty browser still shows the ordinary sign-in form.
    // ---------------------------------------------------------------------
    {
      const { context, page, errors } = await newSession();
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#authRegion').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#sessionBanner').isVisible(), false);
      assert.equal(await rows(page).count(), 0);
      assert.equal(await page.locator('#backToAccountsBtn').isVisible(), false);
      await page.screenshot({ path: path.join(ARTIFACTS, 'accounts-empty-desktop-zh-CN.png'), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Account chooser removal/enrollment passed: independent removal, active removal, legacy cookie enrollment, empty browser');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
