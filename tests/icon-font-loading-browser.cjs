const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

const artifacts = path.resolve(__dirname, '..', '.artifacts/icon-font-loading');
const iconFontPath = '/assets/fonts/material-symbols-outlined.woff2';
const evidence = [];

async function screenshot(page, name) {
  // Capture the actual pending-font state without waiting for document.fonts.ready.
  const session = await page.context().newCDPSession(page);
  const result = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(artifacts, `${name}.png`), Buffer.from(result.data, 'base64'));
  await session.detach();
}

async function state(surface) {
  return surface.evaluate(() => {
    const icons = [...document.querySelectorAll('.material-symbols-outlined')].map(icon => {
      const box = icon.getBoundingClientRect();
      const style = getComputedStyle(icon);
      return { text: icon.textContent.trim(), width: box.width, height: box.height,
        fontSize: parseFloat(style.fontSize), visibility: style.visibility, family: style.fontFamily };
    }).filter(icon => icon.width > 0 && icon.height > 0);
    return { icons, overflow: document.documentElement.scrollWidth - innerWidth,
      ready: document.documentElement.classList.contains('vaultsso-icons-ready'),
      fontStatus: document.fonts?.status,
      loadedFaces: [...(document.fonts || [])].filter(face => face.family.includes('Material Symbols') && face.status === 'loaded').length };
  });
}

function assertHidden(result, label, maximumOverflow = 1) {
  assert.ok(result.icons.length > 0, `${label}: actual icon slots exist`);
  assert.equal(result.ready, false, `${label}: no unproven font success`);
  for (const icon of result.icons) {
    assert.equal(icon.visibility, 'hidden', `${label}: ${icon.text} does not paint fallback English`);
    assert.ok(icon.width <= icon.fontSize + 1, `${label}: ${icon.text} keeps a compact slot`);
  }
  if (maximumOverflow !== null) assert.ok(result.overflow <= maximumOverflow, `${label}: no page overflow`);
}

async function assertLoaded(surface, label, maximumOverflow = 1) {
  await surface.waitForFunction(() => document.documentElement.classList.contains('vaultsso-icons-ready'));
  const result = await state(surface);
  assert.ok(result.loadedFaces > 0, `${label}: the real icon face loaded`);
  assert.ok(result.icons.length > 0, `${label}: icons exist`);
  for (const icon of result.icons) {
    assert.equal(icon.visibility, 'visible', `${label}: ${icon.text} is revealed`);
    assert.match(icon.family, /Material Symbols Outlined/, `${label}: uses the actual icon font`);
    assert.ok(icon.width <= icon.fontSize + 1, `${label}: compact glyph geometry`);
  }
  if (maximumOverflow !== null) assert.ok(result.overflow <= maximumOverflow, `${label}: no page overflow`);
  return result;
}

async function fontContext(browser, f, viewport, mode, cookie = '') {
  const context = await browser.newContext({ viewport });
  if (cookie) {
    await context.addCookies(cookie.split('; ').map(value => {
      const separator = value.indexOf('=');
      return { name: value.slice(0, separator), value: value.slice(separator + 1), url: f.baseUrl };
    }));
  }
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== f.baseUrl) return route.abort();
    if (url.pathname === iconFontPath) {
      requests += 1;
      if (mode === 'failed') return route.abort('failed');
      if (mode === 'delayed') await gate;
    }
    return route.continue();
  });
  return { context, release, requests: () => requests };
}

async function dynamicProbe(page, expectedVisibility) {
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'iconFontDynamicProbe';
    button.type = 'button';
    button.className = 'napi-btn';
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'published_with_changes';
    const label = document.createElement('span');
    label.textContent = 'Dynamic action';
    button.append(icon, label);
    document.body.append(button);
  });
  const result = await page.locator('#iconFontDynamicProbe .material-symbols-outlined').evaluate(icon => {
    const style = getComputedStyle(icon);
    return { width: icon.getBoundingClientRect().width, fontSize: parseFloat(style.fontSize), visibility: style.visibility };
  });
  assert.equal(result.visibility, expectedVisibility, 'a newly inserted icon inherits the font state');
  assert.ok(result.width <= result.fontSize + 1, 'a long dynamic ligature retains one icon slot');
  assert.equal(await page.locator('#iconFontDynamicProbe').isVisible(), true, 'ordinary action remains visible');
  await page.locator('#iconFontDynamicProbe').click();
  return result;
}

async function avatarOverlayState(page) {
  return page.locator('#avatarEditBtn').evaluate(button => {
    const overlay = button.querySelector('.profile-avatar-edit');
    const icon = overlay.querySelector('.material-symbols-outlined');
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return { avatar: box(button), overlay: box(overlay), icon: box(icon),
      opacity: Number(getComputedStyle(overlay).opacity), visibility: getComputedStyle(icon).visibility,
      focusVisible: button.matches(':focus-visible'), ariaHidden: overlay.getAttribute('aria-hidden') };
  });
}

function assertAvatarOverlay(result, visibility, label) {
  assert.equal(result.ariaHidden, 'true', `${label}: overlay stays decorative`);
  assert.equal(result.visibility, visibility, `${label}: only the glyph follows font readiness`);
  assert.ok(result.opacity >= 0.99, `${label}: original interaction reveals the overlay`);
  for (const edge of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(result.avatar[edge] - result.overlay[edge]) <= 1, `${label}: overlay fills avatar ${edge}`);
  }
  for (const axis of ['x', 'y']) {
    const size = axis === 'x' ? 'width' : 'height';
    const avatarCenter = result.avatar[axis] + result.avatar[size] / 2;
    const iconCenter = result.icon[axis] + result.icon[size] / 2;
    assert.ok(Math.abs(avatarCenter - iconCenter) <= 1, `${label}: glyph is centered on ${axis}`);
  }
}

async function exerciseAvatar(page, visibility, width, zoom) {
  const button = page.locator('#avatarEditBtn');
  await button.hover();
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.profile-avatar-edit')).opacity) >= 0.99);
  const hover = await avatarOverlayState(page);
  assertAvatarOverlay(hover, visibility, `profile ${width} zoom ${zoom} hover`);
  await screenshot(page, `profile-avatar-${visibility}-${width}-zoom-${zoom}`);

  await page.mouse.move(0, 0);
  await button.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.equal(await button.evaluate(element => element.matches(':focus-visible')), true, 'keyboard focus uses the original focus-visible overlay');
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.profile-avatar-edit')).opacity) >= 0.99);
  const focus = await avatarOverlayState(page);
  assertAvatarOverlay(focus, visibility, `profile ${width} zoom ${zoom} focus`);

  await button.click();
  await page.locator('#profileModal').waitFor({ state: 'visible' });
  // The pre-existing narrow modal can place its close button outside the viewport
  // at CSS zoom 2. The avatar's real zoomed click is already proven above.
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await page.locator('#profileModal [data-close-modal]').first().click();
  await page.locator('#profileModal').waitFor({ state: 'hidden' });
  await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
  return { hover, focus, clickOpenedModal: true, modalClosedAtZoom: 1 };
}

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';
  const f = await createFixture({ port });
  let browser;
  try {
    const admin = await f.user('admin');
    const login = await f.login(admin);
    assert.equal(login.status, 200);
    browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true, args: ['--disable-background-networking'] });
    for (const width of [1440, 390]) {
      const viewport = { width, height: width === 1440 ? 1000 : 844 };
      const delayed = await fontContext(browser, f, viewport, 'delayed');
      const page = await delayed.context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${f.baseUrl}/oauth2/authorize`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.fonts.status === 'loading');
      await new Promise(resolve => setTimeout(resolve, 4100));
      assert.ok(delayed.requests() > 0, 'actual woff2 request is held');
      const pending = await state(page);
      assertHidden(pending, `delayed login ${width}`);
      assert.equal(await page.locator('#loginForm button[type=submit]').isVisible(), true);
      await page.locator('#loginForm input[name=username]').fill(admin.username);
      await page.locator('#loginForm button[type=submit]').click();
      await page.locator('#loginPassword').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#loginPassword').isEnabled(), true, 'Continue remains functional before font success');
      await dynamicProbe(page, 'hidden');
      await screenshot(page, `login-delayed-${width}`);
      const slotBefore = await page.locator('#iconFontDynamicProbe').boundingBox();
      delayed.release();
      const loaded = await assertLoaded(page, `released login ${width}`);
      const slotAfter = await page.locator('#iconFontDynamicProbe').boundingBox();
      assert.ok(Math.abs(slotBefore.width - slotAfter.width) <= 1, 'loading the face does not widen the dynamic button');
      await page.locator('#iconFontDynamicProbe').evaluate(button => button.remove());
      await dynamicProbe(page, 'visible');
      await screenshot(page, `login-loaded-${width}`);
      assert.deepEqual(errors, []);
      evidence.push({ case: 'real delayed and released icon font', width, heldMilliseconds: 4100,
        requests: delayed.requests(), pending, loaded, buttonWidthBefore: slotBefore.width, buttonWidthAfter: slotAfter.width });
      await delayed.context.close();

      const failed = await fontContext(browser, f, viewport, 'failed');
      const failedPage = await failed.context.newPage();
      const failedErrors = [];
      failedPage.on('pageerror', error => failedErrors.push(error.message));
      await failedPage.goto(`${f.baseUrl}/oauth2/authorize`);
      await failedPage.evaluate(() => document.fonts.ready);
      const failure = await state(failedPage);
      assert.ok(failed.requests() > 0, 'actual woff2 request failed');
      assertHidden(failure, `failed login after font-set ready ${width}`);
      await dynamicProbe(failedPage, 'hidden');
      await failedPage.locator('#loginForm input[name=username]').fill(admin.username);
      await failedPage.locator('#loginForm button[type=submit]').click();
      await failedPage.locator('#loginPassword').waitFor({ state: 'visible' });
      await screenshot(failedPage, `login-failed-${width}`);
      assert.deepEqual(failedErrors, []);
      evidence.push({ case: 'real failed icon font after document.fonts.ready', width, failure });
      await failed.context.close();

      // No request routing: the second navigation can use the browser's real font cache.
      const warmContext = await browser.newContext({ viewport });
      const warmPage = await warmContext.newPage();
      await warmPage.goto(`${f.baseUrl}/api-docs.html`);
      // Existing long documentation text overflows at narrow widths; compare unchanged
      // document width here while continuing to enforce one-em icon slots.
      const immediate = await assertLoaded(warmPage, `documentation immediate ${width}`, null);
      await warmPage.goto(`${f.baseUrl}/api-docs.html?icon-font-warm=1`);
      const warm = await assertLoaded(warmPage, `documentation warm ${width}`, null);
      assert.equal(warm.overflow, immediate.overflow, 'warm font loading does not widen existing documentation content');
      const timing = await warmPage.evaluate(fontPath => performance.getEntriesByType('resource')
        .filter(entry => new URL(entry.name).pathname === fontPath)
        .map(entry => ({ transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize })), iconFontPath);
      assert.ok(timing.some(entry => entry.transferSize === 0 && entry.decodedBodySize > 0), 'warm navigation uses the actual cached font bytes');
      await dynamicProbe(warmPage, 'visible');
      assert.equal((await state(warmPage)).overflow, warm.overflow, 'long dynamic icon name adds no documentation overflow');
      assert.equal(await warmPage.locator('h2').first().isVisible(), true, 'ordinary documentation headings remain visible');
      await screenshot(warmPage, `docs-warm-${width}`);
      evidence.push({ case: 'real immediate and warm-cache documentation font', width, immediate, warm, timing });
      await warmContext.close();

      const shell = await fontContext(browser, f, viewport, 'delayed', login.cookie);
      const shellPage = await shell.context.newPage();
      await shellPage.goto(`${f.baseUrl}/admin.html`, { waitUntil: 'domcontentloaded' });
      await shellPage.locator('#adminFrame').waitFor();
      const frame = await (await shellPage.locator('#adminFrame').elementHandle()).contentFrame();
      await frame.locator('tbody tr').first().waitFor();
      const shellPending = await state(shellPage);
      const framePending = await state(frame);
      assertHidden(shellPending, `admin shell delayed ${width}`);
      assertHidden(framePending, `admin iframe delayed ${width}`);
      assert.equal(await frame.locator('#importBtn').isVisible(), true, 'iframe action label stays available');
      await screenshot(shellPage, `admin-delayed-${width}`);
      shell.release();
      await assertLoaded(shellPage, `admin shell loaded ${width}`);
      await assertLoaded(frame, `admin iframe loaded ${width}`);
      await frame.locator('#importBtn').click();
      await frame.locator('#importModal').waitFor({ state: 'visible' });
      await screenshot(shellPage, `admin-loaded-${width}`);
      evidence.push({ case: 'real admin shell and iframe delayed/released font', width, shellPending, framePending });
      await shell.context.close();

      const profile = await fontContext(browser, f, viewport, 'delayed', login.cookie);
      const profilePage = await profile.context.newPage();
      const profileErrors = [];
      profilePage.on('pageerror', error => profileErrors.push(error.message));
      await profilePage.goto(`${f.baseUrl}/profile`, { waitUntil: 'domcontentloaded' });
      await profilePage.locator('#profileContent').waitFor({ state: 'visible' });
      const profileStates = [];
      for (const zoom of [1, 2]) {
        await profilePage.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
        profileStates.push({ stage: 'real font held', zoom, ...await exerciseAvatar(profilePage, 'hidden', width, zoom) });
      }
      assert.ok(profile.requests() > 0, 'real profile font response was held throughout hidden-state interactions');
      profile.release();
      await profilePage.waitForFunction(() => document.documentElement.classList.contains('vaultsso-icons-ready'));
      for (const zoom of [1, 2]) {
        await profilePage.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
        profileStates.push({ stage: 'real font loaded', zoom, ...await exerciseAvatar(profilePage, 'visible', width, zoom) });
      }
      assert.deepEqual(profileErrors, []);
      evidence.push({ case: 'real profile avatar hover/focus/click with separate overlay and glyph', width, states: profileStates });
      await profile.context.close();
      fs.writeFileSync(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
    }

    // Explicitly simulated API/stylesheet uncertainty, separate from real HTTP cases above.
    for (const mode of ['empty-face-list', 'unsupported-api', 'missing-font-stylesheet']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      if (mode === 'empty-face-list') await context.addInitScript(() => { document.fonts.load = async () => []; });
      if (mode === 'unsupported-api') await context.addInitScript(() => { Object.defineProperty(document, 'fonts', { value: undefined }); });
      if (mode === 'missing-font-stylesheet') await context.route('**/assets/vaultsso-fonts.css', route => route.abort('failed'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${f.baseUrl}/api-docs.html`);
      const result = await state(page);
      assertHidden(result, `simulated ${mode}`, null);
      await dynamicProbe(page, 'hidden');
      assert.equal((await state(page)).overflow, result.overflow, 'hidden dynamic name adds no documentation overflow');
      assert.equal(await page.locator('h2').first().isVisible(), true, 'ordinary documentation content remains visible');
      assert.deepEqual(errors, []);
      evidence.push({ case: 'simulated uncertainty', mode, result });
      await context.close();
    }
    fs.writeFileSync(path.join(artifacts, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log('Icon font browser checks passed: actual delayed/released and rejected woff2, font-set readiness is not success, immediate/warm documentation, dynamic icons and usable actions, admin shell/iframe, profile avatar full overlay and centered glyph through hover/focus/click at zoom 1/2 on desktop/mobile; separate empty-face/unsupported-API/missing-stylesheet simulations');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
