// Final visual audit for the new-api UI refresh.
// Seeds a session cookie from the fixture, then inspects every refreshed surface.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require(path.resolve(__dirname, '../../../tests/support/fixture'));

const ADMIN_PAGES = [
  ['users', '/users.html'],
  ['clients', '/apps.html'],
  ['security', '/security.html'],
  ['smtp', '/smtp.html'],
  ['tokens', '/tokens.html'],
  ['user-applications', '/account-bindings.html'],
  ['admin-shell', '/admin.html']
];

async function main() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));

  process.env.COOKIE_SECURE = 'false';
  const f = await createFixture({ port });
  let browser;
  const problems = [];

  try {
    // Obtain an authenticated session through the fixture HTTP client.
    const admin = await f.user('admin');
    const login = await f.request('/oauth2/authorize', {
      method: 'POST',
      data: { username: admin.username, password: admin.clearPassword }
    });
    if (login.status >= 400) throw new Error('fixture login failed: ' + login.status);

    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true,
      args: ['--disable-background-networking']
    });

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
    const raw = String(login.headers.get('set-cookie') || '');
    const cookies = raw.split(/,\s*(?=[A-Za-z0-9_-]+=)/).map(part => part.split(';')[0]).filter(Boolean).map(pair => {
      const index = pair.indexOf('=');
      return {
        name: pair.slice(0, index).trim(),
        value: pair.slice(index + 1).trim(),
        domain: '127.0.0.1',
        path: '/',
        secure: false,
        httpOnly: true
      };
    }).filter(cookie => cookie.value);
    if (cookies.length) await context.addCookies(cookies);
    console.log('injected cookies:', cookies.map(c => c.name).join(','));

    await context.route('**/*', route =>
      new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort()
    );

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));

    const check = async (label, url) => {
      await page.goto(`${f.baseUrl}${url}`);
      await page.waitForTimeout(500);

      const info = await page.evaluate(() => {
        const radii = [];
        for (const el of document.querySelectorAll('*')) {
          const style = getComputedStyle(el);
          for (const side of ['borderTopLeftRadius', 'borderTopRightRadius']) {
            const raw = style[side];
            if (!raw || raw === '0px') continue;
            const px = parseFloat(raw);
            if (Number.isFinite(px) && px > 16.5 && px < 999) radii.push(el.tagName.toLowerCase() + '.' + (el.className || '') + ' ' + raw);
          }
        }
        return {
          h1: document.querySelectorAll('h1').length,
          pageTitle: document.querySelectorAll('#adminPageTitle').length,
          footers: document.querySelectorAll('footer').length,
          hrs: document.querySelectorAll('hr').length,
          overflow: Math.round(document.documentElement.scrollWidth - window.innerWidth),
          oversized: [...new Set(radii)].slice(0, 4)
        };
      });

      const row = [];
      if (info.h1 > 1) row.push(`h1=${info.h1}`);
      if (info.pageTitle > 1) row.push(`pageTitle=${info.pageTitle}`);
      if (info.footers > 0) row.push(`footer=${info.footers}`);
      if (info.hrs > 0) row.push(`hr=${info.hrs}`);
      if (info.overflow > 1) row.push(`overflow=${info.overflow}px`);
      if (info.oversized.length) row.push('radius>16px: ' + info.oversized.join(' | '));

      console.log(label.padEnd(20), row.length ? row.join('  ') : 'ok');
      if (row.length) problems.push(label + ': ' + row.join(' '));
    };

    await check('profile', '/profile');
    for (const [label, url] of ADMIN_PAGES) await check(label, url);
    await check('api-docs', '/api-docs.html');
    await check('login', '/oauth2/authorize?client_id=none');

    await page.setViewportSize({ width: 390, height: 844 });
    await check('users @390', '/users.html');
    await check('profile @390', '/profile');
    await check('admin @390', '/admin.html');

    const artifacts = path.resolve(__dirname, '../../../.artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const [label, url] of ADMIN_PAGES) {
      await page.goto(`${f.baseUrl}${url}`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(artifacts, `r2-${label}.png`), fullPage: true });
    }

    if (errors.length) {
      problems.push('pageerror: ' + errors.join(' | '));
      console.log('\npage errors:', errors);
    }

    console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n` + problems.join('\n') : '\nVisual audit clean.');
    if (problems.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
