// Confirms the session cookie really lands on authenticated pages,
// and that each page renders its new-api content (not a login redirect).
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require(path.resolve(__dirname, '../../../tests/support/fixture'));

const PAGES = [
  ['profile', '/profile', ['profile-navigation', 'profile-panel']],
  ['users', '/users.html', ['napi-', 'filter']],
  ['clients', '/apps.html', ['napi-']],
  ['security', '/security.html', ['napi-']],
  ['smtp', '/smtp.html', ['napi-']],
  ['tokens', '/tokens.html', ['napi-']],
  ['user-applications', '/account-bindings.html', ['napi-']],
  ['admin-shell', '/admin.html', ['admin-topbar']]
];

(async () => {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));

  process.env.COOKIE_SECURE = 'false';
  const f = await createFixture({ port });
  let browser;
  try {
    const admin = await f.user('admin');
    const login = await f.request('/oauth2/authorize', {
      method: 'POST',
      data: { username: admin.username, password: admin.clearPassword }
    });
    console.log('fixture login status:', login.status);

    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const raw = String(login.headers.get('set-cookie') || '');
    const cookies = raw.split(/,\s*(?=[A-Za-z0-9_-]+=)/).map(part => part.split(';')[0]).filter(Boolean).map(pair => {
      const index = pair.indexOf('=');
      return { name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: '127.0.0.1', path: '/', secure: false, httpOnly: true };
    }).filter(c => c.value);
    if (cookies.length) await context.addCookies(cookies);
    console.log('injected cookies:', cookies.map(c => c.name).join(','));
    await context.route('**/*', route =>
      new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort()
    );
    const page = await context.newPage();

    for (const [label, url, markers] of PAGES) {
      await page.goto(f.baseUrl + url);
      await page.waitForTimeout(500);
      const state = await page.evaluate(markers => {
        const html = document.documentElement.outerHTML;
        return {
          title: document.title,
          onLogin: html.includes('loginForm'),
          markers: markers.map(m => m + '=' + (html.includes(m) ? 'yes' : 'NO')),
          bodyLen: document.body.innerText.trim().length
        };
      }, markers);
      console.log(
        label.padEnd(20),
        'login=' + (state.onLogin ? 'YES!' : 'no'),
        'body=' + String(state.bodyLen).padStart(5),
        state.markers.join(' ')
      );
    }
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
})().catch(e => { console.error(e.message); process.exit(1); });
