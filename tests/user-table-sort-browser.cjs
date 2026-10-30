// Admin user-table sorting browser regression.
//
// Contract: research/users-sort-contract.md (task 10-23-account-first-login).
// Eight data headers sort locally over the already-filtered copy; the operations column does not.
// First activation of a column is ascending, repeat activation toggles. Sorting survives
// search/filter, refresh and a successful row update. Empty/unbound raw values (email, phone,
// provider, date) stay last in BOTH directions; category columns (mailbox state, role, ban) use
// defined category ranks that reverse with the direction. Equal values keep their original order.
//
// Header surface delivered by the frontend owner:
//   <th data-sort-column="<key>" aria-sort="none|ascending|descending">
//     <button class="admin-sort-btn" data-sort="<key>">label<span class="admin-sort-arrow"></span></button>
//   keys: user, email, phone, identity, role, mailbox, ban, created   (operations has none)
//
// Isolated in-memory fixture only; no real data, no network beyond the fixture origin.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');
const ExternalIdentityModel = require('../models/ExternalIdentity');

const ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'user-table-sort');
const VIEWPORTS = [{ width: 1440, height: 1000, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }];

const SORT_KEYS = ['user', 'email', 'phone', 'identity', 'role', 'mailbox', 'ban', 'created'];
const SORT_LABELS = ['用户', '邮箱', '手机号', '第三方账号', '角色', '邮箱状态', '封禁状态', '创建时间'];

const EMPTY_EMAIL = '未绑定邮箱';
const EMPTY_PHONE = '未绑定手机号';
const EMPTY_IDENTITY = '未绑定';
const EMPTY_DATE = '未记录';
const NO_NAME = '未设置姓名';

// ---------------------------------------------------------------------------------------------
// Deterministic dataset. Every column has a meaningful boundary:
//  - user      : natural numeric names (用户1 < 用户2 < 用户10) plus a name-less row that must
//                fall back to its username, plus two rows sharing one name for stability.
//  - email     : natural numeric addresses (mail1 < mail2 < mail10) plus one unbound synthetic
//                @users.invalid address that must sort last in both directions.
//  - phone     : two numbered numbers, everything else unbound.
//  - identity  : two providers (huawei < wechat), everything else unbound.
//  - role      : one admin among users.
//  - mailbox   : unbound / unverified / verified all present.
//  - ban       : one banned among normal accounts.
//  - created   : seven distinct dates plus one corrupt date that must sort last and render 未记录.
// ---------------------------------------------------------------------------------------------
const DATASET = [
  { key: 'u1', name: '排序用户1', username: 'sort-u1', email: 'mail2@example.test', emailVerified: true, role: 'user', banned: false, createdAt: '2024-03-01T02:00:00Z', phone: { cc: '86', num: '13800000001', verified: true }, identity: null },
  { key: 'u2', name: '排序用户2', username: 'sort-u2', email: 'mail10@example.test', emailVerified: false, role: 'user', banned: false, createdAt: '2024-03-02T02:00:00Z', phone: null, identity: 'huawei' },
  { key: 'u10', name: '排序用户10', username: 'sort-u10', email: 'mail1@example.test', emailVerified: true, role: 'user', banned: false, createdAt: '2024-03-03T02:00:00Z', phone: { cc: '86', num: '13800000003', verified: false }, identity: null },
  { key: 'tieA', name: '排序同名', username: 'sort-tie-a', email: 'tie2@example.test', emailVerified: true, role: 'admin', banned: false, createdAt: '2024-03-04T02:00:00Z', phone: null, identity: 'wechat' },
  { key: 'tieB', name: '排序同名', username: 'sort-tie-b', email: 'tie1@example.test', emailVerified: false, role: 'user', banned: true, createdAt: '2024-03-05T02:00:00Z', phone: null, identity: null },
  { key: 'noname', name: '', username: 'sort-noname', email: 'noname@example.test', emailVerified: false, role: 'user', banned: false, createdAt: '2024-03-06T02:00:00Z', phone: null, identity: null },
  { key: 'unbound', name: '排序无邮箱', username: 'sort-unbound', email: '__UNBOUND__', emailVerified: false, role: 'user', banned: false, createdAt: '2024-03-07T02:00:00Z', phone: null, identity: null },
  { key: 'nodate', name: '排序无日期', username: 'sort-nodate', email: 'nodate@example.test', emailVerified: true, role: 'user', banned: false, createdAt: '2024-03-08T02:00:00Z', phone: null, identity: null }
];

// Expected relative order of the dataset rows, derived from the documented behaviour above.
// The fixture admin account interleaves but never reorders these rows, so assertions run on the
// dataset subsequence (plus a global "empties are last" check that covers every row).
const EMAIL_ASC = ['u10', 'u1', 'u2', 'nodate', 'noname', 'tieB', 'tieA']; // mail1, mail2, mail10, nodate, noname, tie1, tie2
const EMAIL_DESC = ['tieA', 'tieB', 'noname', 'nodate', 'u2', 'u1', 'u10'];
const PHONE_ASC = ['u1', 'u10'];    // +8613800000001 < +8613800000003
const PHONE_DESC = ['u10', 'u1'];
const IDENTITY_ASC = ['u2', 'tieA']; // huawei < wechat
const IDENTITY_DESC = ['tieA', 'u2'];
const CREATED_ASC = ['u1', 'u2', 'u10', 'tieA', 'tieB', 'noname', 'unbound'];
const CREATED_DESC = ['unbound', 'noname', 'tieB', 'tieA', 'u10', 'u2', 'u1'];
// The corrupt-date row must sit last in both directions, so the full dataset order is those plus it.
const CREATED_ASC_ALL = CREATED_ASC.concat('nodate');
const CREATED_DESC_ALL = CREATED_DESC.concat('nodate');
const MAILBOX_ASC_CATEGORIES = ['unbound', 'unverified', 'unverified', 'unverified', 'verified', 'verified', 'verified', 'verified'];
const MAILBOX_DESC_CATEGORIES = ['verified', 'verified', 'verified', 'verified', 'unverified', 'unverified', 'unverified', 'unbound'];

function syntheticEmailFor(username) {
  const digest = crypto.createHash('sha256').update(String(username).toLowerCase()).digest('hex').slice(0, 24);
  return `import-${digest}@users.invalid`;
}

async function seedDataset(f) {
  const records = {};
  for (const spec of DATASET) {
    const record = await f.User.create({
      username: spec.username,
      email: spec.email === '__UNBOUND__' ? syntheticEmailFor(spec.username) : spec.email,
      password: 'sort-regression-password',
      name: spec.name,
      role: spec.role,
      banned: spec.banned,
      emailVerified: spec.emailVerified,
      createdAt: spec.createdAt,
      ...(spec.phone ? { phoneCountryCode: spec.phone.cc, phoneNumber: spec.phone.num, phoneVerified: spec.phone.verified } : {})
    });
    records[spec.key] = record;
  }

  const identities = new ExternalIdentityModel(f.pool);
  const withIdentity = DATASET.filter(spec => spec.identity);
  for (const spec of withIdentity) {
    await identities.create({
      userId: records[spec.key].id,
      provider: spec.identity,
      providerUserId: `${spec.identity}-${spec.key}`,
      providerUsername: `${spec.identity}-${spec.key}`
    });
  }

  // A corrupt timestamp is the only way to exercise "missing/invalid dates stay last": the model
  // coerces invalid input to now(), so the row is written and then broken in place.
  const corrupt = f.pool.users.find(row => row.username === 'sort-nodate');
  assert.ok(corrupt, 'the corrupt-date row must exist');
  corrupt.created_at = 'not-a-date';

  return { records };
}

// ---------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------

// Account-first login: the primary action advances from account entry to the password step.
async function continueToPassword(page) {
  await page.locator('#loginForm .submit').click();
  await page.waitForFunction(() => {
    const field = document.getElementById('loginPassword');
    return Boolean(field) && !field.disabled && field.getBoundingClientRect().width > 1;
  }, null, { timeout: 15000 });
}

async function loginAsAdmin(page, f, admin) {
  await page.goto(`${f.baseUrl}/oauth2/authorize`);
  await page.locator('#loginUsername').fill(admin.username);
  await continueToPassword(page);
  await page.locator('#loginPassword').fill(admin.clearPassword);
  await page.locator('#loginForm .submit').click();
  await page.waitForURL('**/profile');
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openUsersPage(page, f) {
  await page.goto(`${f.baseUrl}/users.html`);
  await page.waitForFunction(() => {
    const bar = document.getElementById('statusBar');
    return Boolean(bar) && /已加载/.test(bar.textContent) && document.querySelectorAll('#userTableBody tr').length > 0;
  }, null, { timeout: 15000 });
  await settle(page);
}

async function readRows(page) {
  return page.$$eval('#userTableBody tr', rows => rows.map(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 9) return null;
    const userCell = cells[0].querySelector('.admin-table-cell-user');
    const subs = userCell ? userCell.querySelectorAll('.admin-cell-sub') : [];
    const strong = cell => {
      const node = cell ? cell.querySelector('.admin-cell-strong') : null;
      return node ? node.textContent.trim() : '';
    };
    const roleSelect = cells[4].querySelector('select');
    return {
      id: row.dataset.userId || '',
      name: strong(cells[0]),
      username: subs[0] ? subs[0].textContent.trim() : '',
      email: strong(cells[1]),
      phone: strong(cells[2]),
      identity: cells[3].textContent.trim(),
      role: roleSelect ? roleSelect.value : '',
      mailbox: cells[5].textContent.trim(),
      ban: cells[6].textContent.trim(),
      created: cells[7].textContent.trim()
    };
  }).filter(Boolean));
}

function banState(row) {
  return /已封禁/.test(row.ban) ? 'banned' : 'normal';
}

function mailboxState(row) {
  if (row.mailbox.includes('未绑定')) return 'unbound';
  if (row.mailbox.includes('已验证')) return 'verified';
  return 'unverified';
}

// The dataset subsequence, in rendered order, expressed as dataset keys.
function datasetOrder(rows, records) {
  const keyById = new Map(Object.entries(records).map(([key, record]) => [record.id, key]));
  return rows.filter(row => keyById.has(row.id)).map(row => keyById.get(row.id));
}

function assertNoEmptyBeforeValue(rows, describe, isEmpty, label) {
  const emptyIndexes = [];
  const valueIndexes = [];
  rows.forEach((row, index) => (isEmpty(row) ? emptyIndexes : valueIndexes).push(index));
  if (!emptyIndexes.length || !valueIndexes.length) return;
  assert.ok(Math.min(...emptyIndexes) > Math.max(...valueIndexes),
    `${label}: every empty/unbound ${describe} must sort after every populated one, ` +
    `saw empty at ${emptyIndexes[0]} and value at ${valueIndexes[valueIndexes.length - 1]}`);
}

async function ariaSortMap(page) {
  return page.$$eval('th[data-sort-column]', headers => Object.fromEntries(
    headers.map(header => [header.dataset.sortColumn, header.getAttribute('aria-sort')])));
}

async function arrowGlyph(page, key) {
  return page.locator(`th[data-sort-column="${key}"] .admin-sort-arrow`).evaluate(node => {
    const content = getComputedStyle(node, '::before').content;
    return content || '';
  });
}

async function assertIndicator(page, key, direction) {
  const before = await page.locator(`th[data-sort-column="${key}"] .admin-sort-arrow`).evaluate(node => {
    const style = getComputedStyle(node, '::before');
    return { content: style.content || '', width: style.width, height: style.height };
  });
  assert.notEqual(before.content, 'none', `${key}: the active header must render a visible direction indicator`);
  const glyph = direction === 'ascending' ? '\u25B2' : '\u25BC';
  const opposite = direction === 'ascending' ? '\u25BC' : '\u25B2';
  assert.ok(before.content.includes(glyph), `${key}: a ${direction} header must show ${glyph}, got ${JSON.stringify(before.content)}`);
  assert.ok(!before.content.includes(opposite), `${key}: a ${direction} header must not show ${opposite}`);
  const width = Number.parseFloat(before.width);
  if (Number.isFinite(width)) assert.ok(width > 0, `${key}: the direction indicator must occupy space`);
}

async function assertInactiveIndicator(page, key) {
  const glyph = await arrowGlyph(page, key);
  assert.ok(!glyph.includes('\u25B2') && !glyph.includes('\u25BC'),
    `${key}: an unsorted header must not show a direction indicator, got ${JSON.stringify(glyph)}`);
}

// Exactly one header carries the active aria-sort; every other sortable header is "none".
async function assertActiveHeader(page, key, direction) {
  const map = await ariaSortMap(page);
  for (const sortKey of SORT_KEYS) {
    const expected = sortKey === key ? direction : 'none';
    assert.equal(map[sortKey], expected, `${sortKey}: aria-sort must be ${expected} while ${key} is ${direction}`);
  }
  await assertIndicator(page, key, direction);
  for (const sortKey of SORT_KEYS) {
    if (sortKey !== key) await assertInactiveIndicator(page, sortKey);
  }
}

async function clickSort(page, key) {
  await page.locator(`th[data-sort-column="${key}"] button.admin-sort-btn`).click();
  await settle(page);
}

async function main() {
  // The server rejects unsafe cross-origin writes, so the fixture is pinned to a known port and
  // the browser origin must match it exactly (same pattern as the other browser suites).
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COOKIE_SECURE = 'false';
  const f = await createFixture({ port });
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  const screenshots = [];
  const scenarios = [];
  let browser;

  try {
    browser = await chromium.launch({
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }),
      headless: true,
      args: ['--disable-background-networking']
    });

    for (const viewport of VIEWPORTS) {
      f.reset();
      const { records } = await seedDataset(f);
      const admin = await f.user('admin');

      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.route('**/*', route =>
        new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));

      const usersRequests = [];
      page.on('request', request => {
        if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/users') usersRequests.push(request.url());
      });

      async function screenshot(name) {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false,
          `${name}: horizontal overflow at ${viewport.width}px`);
        const file = `${name}-${viewport.tag}-${viewport.width}.png`;
        await page.screenshot({ path: path.join(ARTIFACTS, file), fullPage: true });
        screenshots.push(file);
      }

      let viewportScenarios = 0;
      const record = name => { viewportScenarios += 1; if (viewport === VIEWPORTS[0]) scenarios.push(name); };

      await loginAsAdmin(page, f, admin);
      await openUsersPage(page, f);

      // ── 1. Header surface, initial response order, no pre-selected column ──────────────────
      {
        record('header surface and initial response order');
        const headers = await page.$$eval('th[data-sort-column]', list => list.map(header => ({
          key: header.dataset.sortColumn,
          ariaSort: header.getAttribute('aria-sort'),
          button: header.querySelector('button.admin-sort-btn') ? header.querySelector('button.admin-sort-btn').dataset.sort : null,
          label: header.querySelector('button.admin-sort-btn') ? header.querySelector('button.admin-sort-btn').textContent.trim() : ''
        })));
        assert.deepEqual(headers.map(header => header.key), SORT_KEYS,
          'the eight data headers must expose the agreed sort keys in column order');
        assert.deepEqual(headers.map(header => header.label), SORT_LABELS,
          'each sortable header must keep its visible column label');
        headers.forEach(header => {
          assert.equal(header.button, header.key, `${header.key}: the header button must carry its own data-sort key`);
          assert.equal(header.ariaSort, 'none', `${header.key}: no column may be pre-sorted on first load`);
        });

        // The operations column is a plain header: no key, no button, not sortable.
        const operations = await page.$$eval('th', list => {
          const last = list[list.length - 1];
          return {
            text: last.textContent.trim(),
            sortColumn: last.dataset.sortColumn || null,
            buttons: last.querySelectorAll('button[data-sort]').length
          };
        });
        assert.equal(operations.text, '操作', 'the last header must still be the operations column');
        assert.equal(operations.sortColumn, null, 'the operations column must not be sortable');
        assert.equal(operations.buttons, 0, 'the operations column must not offer a sort button');

        // Every sortable header is a real, keyboard-focusable button.
        for (const key of SORT_KEYS) {
          const button = page.locator(`th[data-sort-column="${key}"] button.admin-sort-btn`);
          assert.equal(await button.evaluate(node => node.tagName), 'BUTTON', `${key}: the sort control must be a real button`);
          await button.focus();
          assert.equal(await button.evaluate(node => document.activeElement === node), true,
            `${key}: the sort control must be focusable by keyboard`);
        }

        // Before any column is chosen the table keeps the API response order exactly.
        const api = await context.request.get(`${f.baseUrl}/api/users`);
        assert.equal(api.status(), 200, 'the admin must be able to read the user list');
        const apiUsers = await api.json();
        const rows = await readRows(page);
        assert.deepEqual(rows.map(row => row.id), apiUsers.map(user => user.id),
          'the initial table order must be the unfiltered response order, not a pre-sorted one');

        // The name-less account falls back to its username for display.
        const nameLess = rows.find(row => row.username === 'sort-noname');
        assert.ok(nameLess, 'the name-less account must be listed');
        assert.equal(nameLess.name, NO_NAME, 'a missing name must render the 未设置姓名 placeholder');
        assert.equal(rows.find(row => row.username === 'sort-unbound').email, EMPTY_EMAIL,
          'an unbound synthetic mailbox must render 未绑定邮箱');

        await screenshot('sort-initial');
      }

      // ── 2. User column: natural numeric order, toggle, stability ───────────────────────────
      {
        record('user column natural order, toggle and stability');
        await clickSort(page, 'user');
        await assertActiveHeader(page, 'user', 'ascending');
        let rows = await readRows(page);
        let order = datasetOrder(rows, records);
        const natural = order.filter(key => ['u1', 'u2', 'u10'].includes(key));
        assert.deepEqual(natural, ['u1', 'u2', 'u10'],
          `names must compare numerically (用户1 < 用户2 < 用户10), got ${natural.join(',')}`);
        const ascOrder = order;
        await screenshot('sort-user-asc');

        await clickSort(page, 'user');
        await assertActiveHeader(page, 'user', 'descending');
        rows = await readRows(page);
        order = datasetOrder(rows, records);
        const naturalDesc = order.filter(key => ['u1', 'u2', 'u10'].includes(key));
        assert.deepEqual(naturalDesc, ['u10', 'u2', 'u1'],
          `descending must reverse the numeric order, got ${naturalDesc.join(',')}`);
        assert.deepEqual(order.filter(key => !['u1', 'u2', 'u10', 'tieA', 'tieB'].includes(key)),
          ascOrder.filter(key => !['u1', 'u2', 'u10', 'tieA', 'tieB'].includes(key)).reverse(),
          'every non-tied dataset row must be exactly reversed in descending order');
        await screenshot('sort-user-desc');

        // Equal names keep their original relative order in both directions.
        const api = await context.request.get(`${f.baseUrl}/api/users`);
        const apiUsers = await api.json();
        const apiKeys = datasetOrder(apiUsers.map(user => ({ id: user.id })), records);
        const tieAFirst = apiKeys.indexOf('tieA') < apiKeys.indexOf('tieB');
        const descTies = order.filter(key => ['tieA', 'tieB'].includes(key));
        assert.deepEqual(descTies, tieAFirst ? ['tieA', 'tieB'] : ['tieB', 'tieA'],
          'equal names must keep their original relative order while descending');

        await clickSort(page, 'user');
        await assertActiveHeader(page, 'user', 'ascending');
        rows = await readRows(page);
        const ascTies = datasetOrder(rows, records).filter(key => ['tieA', 'tieB'].includes(key));
        assert.deepEqual(ascTies, descTies, 'equal names must keep their original relative order while ascending');
        assert.deepEqual(datasetOrder(rows, records), ascOrder,
          'a third activation must return to the ascending order, not a new one');
      }

      // ── 3. Email column: natural numeric order, unbound mailbox last both ways ─────────────
      {
        record('email column natural order and unbound last');
        await clickSort(page, 'email');
        await assertActiveHeader(page, 'email', 'ascending');
        let rows = await readRows(page);
        assert.deepEqual(datasetOrder(rows, records), EMAIL_ASC.concat('unbound'),
          `email ascending must compare numerically (mail1 < mail2 < mail10) and keep unbound last, got ${datasetOrder(rows, records).join(',')}`);
        assertNoEmptyBeforeValue(rows, 'mailbox', row => row.email === EMPTY_EMAIL, 'email ascending');
        await screenshot('sort-email-asc');

        await clickSort(page, 'email');
        await assertActiveHeader(page, 'email', 'descending');
        rows = await readRows(page);
        assert.deepEqual(datasetOrder(rows, records), EMAIL_DESC.concat('unbound'),
          `email descending must reverse the populated addresses and still keep unbound last, got ${datasetOrder(rows, records).join(',')}`);
        assertNoEmptyBeforeValue(rows, 'mailbox', row => row.email === EMPTY_EMAIL, 'email descending');
      }

      // ── 4. Phone column: absent numbers last both ways ─────────────────────────────────────
      {
        record('phone column with absent numbers last');
        await clickSort(page, 'phone');
        await assertActiveHeader(page, 'phone', 'ascending');
        let rows = await readRows(page);
        assert.deepEqual(datasetOrder(rows, records).filter(key => PHONE_ASC.includes(key)), PHONE_ASC,
          'the two numbered accounts must ascend by their number');
        assertNoEmptyBeforeValue(rows, 'phone', row => row.phone === EMPTY_PHONE, 'phone ascending');

        await clickSort(page, 'phone');
        await assertActiveHeader(page, 'phone', 'descending');
        rows = await readRows(page);
        assert.deepEqual(datasetOrder(rows, records).filter(key => PHONE_DESC.includes(key)), PHONE_DESC,
          'descending must reverse the numbered accounts');
        assertNoEmptyBeforeValue(rows, 'phone', row => row.phone === EMPTY_PHONE, 'phone descending');
        await screenshot('sort-phone-desc');
      }

      // ── 5. Third-party accounts: unbound last both ways ────────────────────────────────────
      {
        record('third-party accounts with unbound last');
        await clickSort(page, 'identity');
        await assertActiveHeader(page, 'identity', 'ascending');
        let rows = await readRows(page);
        assert.deepEqual(datasetOrder(rows, records).filter(key => IDENTITY_ASC.includes(key)), IDENTITY_ASC,
          'the two bound providers must ascend alphabetically');
        assertNoEmptyBeforeValue(rows, 'provider', row => row.identity === EMPTY_IDENTITY, 'third-party ascending');

        await clickSort(page, 'identity');
        await assertActiveHeader(page, 'identity', 'descending');
        rows = await readRows(page);
        assert.deepEqual(datasetOrder(rows, records).filter(key => IDENTITY_DESC.includes(key)), IDENTITY_DESC,
          'descending must reverse the bound providers');
        assertNoEmptyBeforeValue(rows, 'provider', row => row.identity === EMPTY_IDENTITY, 'third-party descending');
        await screenshot('sort-identity-desc');
      }

      // ── 6. Role column: users then admins ascending, reversed descending ───────────────────
      {
        record('role category order');
        await clickSort(page, 'role');
        await assertActiveHeader(page, 'role', 'ascending');
        let rows = await readRows(page);
        const ascRoles = rows.map(row => row.role);
        const firstAdmin = ascRoles.indexOf('admin');
        assert.ok(firstAdmin > 0, 'ascending must place the administrator after the ordinary users');
        assert.ok(ascRoles.slice(0, firstAdmin).every(role => role === 'user'),
          'every ordinary user must precede the first administrator while ascending');
        assert.ok(ascRoles.slice(firstAdmin).every(role => role === 'admin'),
          'all administrators must be grouped at the end while ascending');

        await clickSort(page, 'role');
        await assertActiveHeader(page, 'role', 'descending');
        rows = await readRows(page);
        const descRoles = rows.map(row => row.role);
        const firstUser = descRoles.indexOf('user');
        assert.ok(firstUser > 0, 'descending must place the administrator first');
        assert.ok(descRoles.slice(0, firstUser).every(role => role === 'admin'),
          'all administrators must be grouped at the start while descending');
        assert.equal(descRoles.length, ascRoles.length, 'sorting must not add or drop rows');
      }

      // ── 7. Mailbox state: unbound, unverified, verified — reversed descending ──────────────
      {
        record('mailbox state category order');
        await clickSort(page, 'mailbox');
        await assertActiveHeader(page, 'mailbox', 'ascending');
        let rows = await readRows(page);
        const keyById = new Map(Object.entries(records).map(([key, item]) => [item.id, key]));
        const ascCount = rows.length;
        const datasetStates = rows.filter(row => keyById.has(row.id)).map(mailboxState);
        assert.deepEqual(datasetStates, MAILBOX_ASC_CATEGORIES,
          `mailbox ascending must group unbound, then unverified, then verified; got ${datasetStates.join(',')}`);
        await screenshot('sort-mailbox-asc');

        await clickSort(page, 'mailbox');
        await assertActiveHeader(page, 'mailbox', 'descending');
        rows = await readRows(page);
        const datasetStatesDesc = rows.filter(row => keyById.has(row.id)).map(mailboxState);
        assert.deepEqual(datasetStatesDesc, MAILBOX_DESC_CATEGORIES,
          `mailbox descending must reverse the category order; got ${datasetStatesDesc.join(',')}`);
        assert.equal(ascCount, rows.length, 'sorting must not add or drop rows');
        await screenshot('sort-mailbox-desc');
      }

      // ── 8. Ban state: normal then banned ascending, reversed descending ────────────────────
      {
        record('ban state category order');
        await clickSort(page, 'ban');
        await assertActiveHeader(page, 'ban', 'ascending');
        let rows = await readRows(page);
        const ascBans = rows.map(banState);
        const firstBanned = ascBans.indexOf('banned');
        assert.ok(firstBanned > 0, 'ascending must place the banned account after the normal ones');
        assert.ok(ascBans.slice(0, firstBanned).every(state => state === 'normal'),
          'every normal account must precede the banned one while ascending');
        assert.ok(ascBans.slice(firstBanned).every(state => state === 'banned'),
          'all banned accounts must be grouped at the end while ascending');

        await clickSort(page, 'ban');
        await assertActiveHeader(page, 'ban', 'descending');
        rows = await readRows(page);
        const descBans = rows.map(banState);
        assert.equal(descBans[0], 'banned', 'descending must place the banned account first');
        assert.equal(descBans.length, ascBans.length, 'sorting must not add or drop rows');
      }

      // ── 9. Creation time: real dates ascending, invalid date last both ways ───────────────
      {
        record('creation time order with an invalid date last');
        await clickSort(page, 'created');
        await assertActiveHeader(page, 'created', 'ascending');
        let rows = await readRows(page);
        assert.deepEqual(datasetOrder(rows, records), CREATED_ASC_ALL,
          `created ascending must order by the real timestamps and keep the invalid date last, got ${datasetOrder(rows, records).join(',')}`);
        assertNoEmptyBeforeValue(rows, 'date', row => row.created === EMPTY_DATE, 'created ascending');
        const invalidRow = rows.find(row => row.username === 'sort-nodate');
        assert.equal(invalidRow.created, EMPTY_DATE, 'an unparseable timestamp must render 未记录');

        await clickSort(page, 'created');
        await assertActiveHeader(page, 'created', 'descending');
        rows = await readRows(page);
        assert.deepEqual(datasetOrder(rows, records), CREATED_DESC_ALL,
          `created descending must reverse the real timestamps and keep the invalid date last, got ${datasetOrder(rows, records).join(',')}`);
        assertNoEmptyBeforeValue(rows, 'date', row => row.created === EMPTY_DATE, 'created descending');
        await screenshot('sort-created-desc');
      }

      // ── 10. Sorting survives the search filter without narrowing the stored list ──────────
      {
        record('sorting retained across the search filter');
        await clickSort(page, 'created');
        await assertActiveHeader(page, 'created', 'ascending');
        await page.locator('#searchInput').fill('sort-');
        await settle(page);
        let rows = await readRows(page);
        assert.equal(rows.length, Object.keys(records).length, 'the search must narrow the table to the dataset rows');
        assert.ok(rows.every(row => row.username.startsWith('sort-')), 'the search must only keep the dataset rows');
        assert.deepEqual(datasetOrder(rows, records), CREATED_ASC_ALL,
          'the filtered subset must keep the active ascending order');

        await page.locator('#searchInput').fill('');
        await settle(page);
        rows = await readRows(page);
        const api = await context.request.get(`${f.baseUrl}/api/users`);
        const apiUsers = await api.json();
        assert.equal(rows.length, apiUsers.length, 'clearing the search must restore every row');
        assert.deepEqual(datasetOrder(rows, records), CREATED_ASC_ALL,
          'the complete list must still be sorted after the filter is cleared');
        await assertActiveHeader(page, 'created', 'ascending');
        await screenshot('sort-retained-after-filter');
      }

      // ── 11. Sorting survives a refresh, and a refresh is the only extra /api/users call ────
      {
        record('sorting retained across refresh');
        await clickSort(page, 'user');
        await clickSort(page, 'user');
        await assertActiveHeader(page, 'user', 'descending');
        const before = datasetOrder(await readRows(page), records);

        const requestsBefore = usersRequests.length;
        await page.locator('#refreshBtn').click();
        await page.waitForFunction(() => /已加载/.test(document.getElementById('statusBar').textContent), null, { timeout: 15000 });
        await settle(page);
        assert.ok(usersRequests.length > requestsBefore, 'refresh must re-read the user list');
        await assertActiveHeader(page, 'user', 'descending');
        assert.deepEqual(datasetOrder(await readRows(page), records), before,
          'a refresh must not drop the active sort or reorder the rows');
        await screenshot('sort-retained-after-refresh');
      }

      // ── 12. Keyboard activation on a real header button ───────────────────────────────────
      {
        record('keyboard activation');
        const button = page.locator('th[data-sort-column="created"] button.admin-sort-btn');
        await button.focus();
        assert.equal(await button.evaluate(node => document.activeElement === node), true,
          'the sort button must accept keyboard focus');

        await page.keyboard.press('Enter');
        await settle(page);
        await assertActiveHeader(page, 'created', 'ascending');
        const ascOrder = datasetOrder(await readRows(page), records);
        assert.deepEqual(ascOrder, CREATED_ASC_ALL, 'Enter must activate the same ascending sort as a click');

        await page.keyboard.press('Space');
        await settle(page);
        await assertActiveHeader(page, 'created', 'descending');
        const descOrder = datasetOrder(await readRows(page), records);
        assert.deepEqual(descOrder, CREATED_DESC_ALL, 'Space must toggle to the descending order');
        await screenshot('sort-keyboard-descending');
      }

      // ── 13. A sorted row still navigates and still edits ──────────────────────────────────
      {
        record('row actions under an active sort');
        await clickSort(page, 'email');
        await assertActiveHeader(page, 'email', 'ascending');
        const target = records.u10;
        await page.locator(`[data-detail-id="${target.id}"]`).click();
        await page.waitForURL(url => url.pathname === '/user.html', { timeout: 15000 });
        const navigated = new URL(page.url());
        assert.equal(navigated.searchParams.get('id'), target.id,
          'the edit action must open the row it belongs to, even while sorted');

        await openUsersPage(page, f);
        await clickSort(page, 'user');
        await assertActiveHeader(page, 'user', 'ascending');
        const roleSelect = page.locator(`[data-role-id="${records.u2.id}"]`);
        await roleSelect.selectOption('admin');
        await page.waitForFunction(() => /用户信息已更新/.test(document.getElementById('statusBar').textContent), null, { timeout: 15000 });
        await settle(page);
        assert.equal(await page.locator(`[data-role-id="${records.u2.id}"]`).inputValue(), 'admin',
          'the role change must be persisted and re-rendered');
        await assertActiveHeader(page, 'user', 'ascending');
        assert.deepEqual(datasetOrder(await readRows(page), records).filter(key => ['u1', 'u2', 'u10'].includes(key)),
          ['u1', 'u2', 'u10'], 'a successful update must not drop the active sort');
        await screenshot('sort-retained-after-update');

        // Restore the dataset so later assertions are unaffected.
        await page.locator(`[data-role-id="${records.u2.id}"]`).selectOption('user');
        await page.waitForFunction(() => /用户信息已更新/.test(document.getElementById('statusBar').textContent), null, { timeout: 15000 });
        await settle(page);
      }

      // ── 14. Sorting is local: no server round-trip, and it stays inside the table ─────────
      {
        record('local-only sorting and overflow containment');
        const requestsBefore = usersRequests.length;
        for (const key of SORT_KEYS) await clickSort(page, key);
        assert.equal(usersRequests.length, requestsBefore,
          'sorting must never request the user list from the server');

        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false,
          'the sorted table must not overflow the document at this width');
        const wrapper = page.locator('.napi-table-scroll');
        assert.equal(await wrapper.count(), 1, 'the table must stay inside its scroll container');
        const box = await wrapper.boundingBox();
        assert.ok(box && box.x >= -1 && box.x + box.width <= viewport.width + 1,
          'the table scroll container must stay within the viewport');

        // The document keeps no horizontal scroll even though the table itself may scroll.
        const overflow = await page.evaluate(() => {
          const node = document.querySelector('.napi-table-scroll');
          return {
            bodyScroll: document.documentElement.scrollWidth - innerWidth,
            tableScrolls: node ? node.scrollWidth > node.clientWidth : false,
            tableScrollWidth: node ? node.scrollWidth : 0,
            tableClientWidth: node ? node.clientWidth : 0
          };
        });
        console.log(`    ${viewport.tag} ${viewport.width}px: document overflow ${overflow.bodyScroll}px, ` +
          `table ${overflow.tableScrollWidth}/${overflow.tableClientWidth}px ` +
          `(${overflow.tableScrolls ? 'scrolls inside its container' : 'fits'})`);
        assert.ok(overflow.bodyScroll <= 1, 'sorting must not introduce page-level horizontal scroll');
        if (viewport.width <= 420) {
          assert.equal(overflow.tableScrolls, true, 'at mobile width the wide table must scroll inside its container');
        }
        await screenshot('sort-overflow-containment');
      }

      assert.deepEqual(errors, [], `no page errors are allowed at ${viewport.width}px`);

      // Every scenario above runs per viewport; report once per viewport.
      console.log(`  ${viewport.tag} ${viewport.width}x${viewport.height}: ${viewportScenarios} scenarios, ${screenshots.length} screenshots`);
      await context.close();
    }

    console.log('\nAdmin user-table sorting browser regression');
    scenarios.forEach((name, index) => console.log(`  ${String(index + 1).padStart(2, ' ')}. ${name}`));
    console.log(`\nAll ${scenarios.length} sorting scenarios pass on desktop ${VIEWPORTS[0].width} and mobile ${VIEWPORTS[1].width}.`);
    console.log(`Covered: header surface and initial order, natural numeric text, timestamp order, empty/unbound last, stable ties, filter/refresh/update retention, keyboard activation, row navigation and edit, local-only sorting, overflow containment.`);
    console.log(`Screenshots: ${screenshots.length} in ${ARTIFACTS}`);
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => {
  console.error('\nFAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
