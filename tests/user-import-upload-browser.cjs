// User import browser regression: transport, unbounded rows, missing email, grouped results.
//
// Reported problems and corrections:
//  1) a ~97KiB JSON file failed with "请求内容过大" because the browser read it through
//     FileReader and re-wrapped it in JSON, exceeding the 100KiB global JSON limit;
//  2) admin imports must have NO fixed record-count cap (only the 10 MiB bound applies);
//  3) a missing email must NOT block an import when a username exists. The account gets the
//     internal unbound address import-<sha256(username)[0:24]>@users.invalid, stays unverified
//     even for ischeck=y, shows 未绑定邮箱 in the admin list, and its login shows the
//     contact-administrator instruction without sending mail;
//  4) import results must be GROUPS (无邮箱但导入成功 / 重复账号跳过 / 邮箱格式错误 / 其他错误)
//     with counts and original row/account, never one mixed list, and must keep all details
//     scrollable. Missing-email rows are successes, not errors.
//
// Isolated in-memory fixture only; no real data and no SMTP.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright-core');
const { createFixture } = require('./support/fixture');

const ARTIFACTS = path.resolve(__dirname, '..', '.artifacts', 'user-import-upload');
const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10485760
const GLOBAL_JSON_LIMIT = 100 * 1024;      // express.json() default, 102400
const BULK_ROWS = 2501;                    // far above any historical 200-row cap
const BULK_UNBOUND_ROWS = 25;              // every 100th bulk row omits its email
const VIEWPORTS = [{ width: 1440, height: 1000, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }];

const GROUP_NO_EMAIL = '无邮箱但导入成功';
const GROUP_DUPLICATE = '重复账号跳过';
const GROUP_INVALID_EMAIL = '邮箱格式错误';
const GROUP_OTHER = '其他错误';

// Account-first login: the primary action advances from account entry to the password step.
async function continueToPassword(page) {
  await page.locator('#loginForm .submit').click();
  await page.waitForFunction(() => {
    const field = document.getElementById('loginPassword');
    return Boolean(field) && !field.disabled && field.getBoundingClientRect().width > 1;
  }, null, { timeout: 15000 });
}

function uniqueTag(prefix) {
  return `${prefix}-${crypto.randomBytes(6).toString('hex')}`;
}

// The agreed deterministic unbound address for an import row without a mailbox.
function syntheticEmailFor(username) {
  const digest = crypto.createHash('sha256').update(String(username).toLowerCase()).digest('hex').slice(0, 24);
  return `import-${digest}@users.invalid`;
}

// ~97KiB JSON file. The filler contains quotes so the *old* JSON wrapper
// (JSON.stringify({ content }) escapes every quote) exceeds the 100KiB limit.
function buildLegacy97KiBFile({ conflictUsername } = {}) {
  const rows = [];
  for (let index = 0; index < 190; index += 1) {
    const tag = uniqueTag(`imp${String(index).padStart(3, '0')}`);
    rows.push({
      username: tag, email: `${tag}@example.test`, name: `Imported ${index}`,
      password: '', role: 'user', description: ''
    });
  }
  rows[1].username = rows[0].username; // duplicate within this import
  rows[1].email = rows[0].email;
  if (conflictUsername) rows[5].username = conflictUsername; // username already taken

  const unit = '"a"';
  // Size by real serialized length: the quotes in the filler are escaped in the raw
  // JSON as well, so the unit count is searched instead of estimated.
  let text = JSON.stringify(rows);
  for (let units = 1; units <= 400; units += 1) {
    const filler = unit.repeat(units);
    for (const row of rows) row.description = filler;
    text = JSON.stringify(rows);
    const size = Buffer.byteLength(text, 'utf8');
    if (size >= 96 * 1024 && size <= 98 * 1024) break;
    if (size > 98 * 1024) break;
  }
  return { rows, text, buffer: Buffer.from(text, 'utf8') };
}

// Mixed file: 15 rows -> 8 created (6 of them unbound) and 7 skipped across every group.
//   1-4 omitted/empty/whitespace/null email      -> created, unbound
//   5   no email + ischeck=y                     -> created, unbound (not verified)
//   6   explicit @users.invalid + ischeck=y       -> created, unbound (not verified)
//   7   existing username                         -> duplicate account group
//   8   existing account email                    -> duplicate account group
//   9-10 same username+email pair                 -> 9 created, 10 duplicate account group
//   11  username + malformed email                -> email format group
//   12  no username and no email                  -> other errors group
//   13  negative credits                          -> other errors group
//   14  real email + ischeck=y                    -> created and verified
//   15  malformed email with no username          -> email format group (raw source value shown)
function buildMixedEmailFile({ conflictUsername, conflictEmail }) {
  const p = uniqueTag('me');
  const rows = [
    { username: `${p}-omitted`, name: 'Email omitted', password: '', role: 'user' },
    { username: `${p}-blank`, email: '', name: 'Blank', password: '', role: 'user' },
    { username: `${p}-space`, email: '   ', name: 'Whitespace', password: '', role: 'user' },
    { username: `${p}-null`, email: null, name: 'Null', password: '', role: 'user' },
    { username: `${p}-synthcheck`, ischeck: 'y', role: 'user' },
    { username: `${p}-explicit`, email: `${p}-explicit@users.invalid`, ischeck: 'y', role: 'user' },
    { username: conflictUsername, email: `${p}-dupuser@example.test`, role: 'user' },
    { username: `${p}-dupemail`, email: conflictEmail, role: 'user' },
    { username: `${p}-pair`, email: `${p}-pair@example.test`, role: 'user' },
    { username: `${p}-pair`, email: `${p}-pair@example.test`, role: 'user' },
    { username: `${p}-bad`, email: 'not-an-email', role: 'user' },
    { username: '', email: '', name: 'No identity', role: 'user' },
    { username: `${p}-badcredits`, email: `${p}-badcredits@example.test`, credits: '-5', role: 'user' },
    { username: `${p}-real`, email: `${p}-real@example.test`, ischeck: 'y', role: 'user' },
    { email: 'not-an-email-no-user', role: 'user' }
  ];
  const text = JSON.stringify(rows, null, 2);
  return { rows, text, buffer: Buffer.from(text, 'utf8'), prefix: p };
}

// A real multi-thousand-row file with empty passwords, well under the 10 MiB bound.
// Every 100th row omits its email so unbound accounts are proven at scale as well.
function buildBulkFile({ rowCount, conflictUsername, conflictEmail }) {
  const prefix = uniqueTag('bulk');
  const rows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const tag = `${prefix}-${String(index + 1).padStart(4, '0')}`;
    rows.push({
      username: tag, email: `${tag}@example.test`, name: `Bulk ${index + 1}`,
      password: '', role: 'user'
    });
    if (index % 100 === 50) delete rows[index].email;
  }
  rows[1].username = rows[0].username;
  rows[1].email = rows[0].email;
  if (conflictUsername) rows[9].username = conflictUsername;
  if (conflictEmail) rows[10].email = conflictEmail;
  const text = JSON.stringify(rows);
  return { rows, text, buffer: Buffer.from(text, 'utf8'), prefix };
}

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

    for (const viewport of VIEWPORTS) {
      f.reset();
      const context = await browser.newContext({ viewport, locale: 'zh-CN' });
      await context.route('**/*', route =>
        new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));

      const importRequests = [];
      const importResponses = [];
      page.on('request', request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/users/import') {
          importRequests.push({
            contentType: String(request.headers()['content-type'] || ''),
            body: request.postDataBuffer()
          });
        }
      });
      page.on('response', response => {
        if (new URL(response.url()).pathname === '/api/users/import') importResponses.push(response.status());
      });

      async function screenshot(target, name) {
        assert.equal(await target.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false,
          `${name}: horizontal overflow at ${viewport.width}px`);
        await target.screenshot({ path: path.join(ARTIFACTS, `${name}-${viewport.tag}-${viewport.width}.png`) });
      }
      async function openImportDialog() {
        await page.locator('#importBtn').click();
        await page.locator('#importModal').waitFor({ state: 'visible' });
        await page.locator('#importSubmitBtn').waitFor({ state: 'visible' });
      }
      async function closeImportDialog() {
        await page.locator('#importCloseBtn').click();
        await page.locator('#importModal').waitFor({ state: 'hidden' });
      }
      // Settle on a final result: the submit action must be enabled again and the text must
      // no longer be the "正在导入..." placeholder (that placeholder is itself non-empty).
      async function waitImportResult() {
        await page.waitForFunction(() => {
          const box = document.getElementById('importResult');
          const button = document.getElementById('importSubmitBtn');
          if (!box || !button) return false;
          if (button.disabled) return false;
          const text = box.textContent.trim();
          return text.length > 0 && !text.includes('正在导入');
        }, null, { timeout: 60000 });
      }
      async function resultSummaryInView() {
        await page.waitForFunction(() => {
          const box = document.getElementById('importResult');
          if (!box) return false;
          const summary = box.firstElementChild || box;
          const rect = summary.getBoundingClientRect();
          return rect.top >= 0 && rect.top <= window.innerHeight - 1;
        }, null, { timeout: 15000 });
      }
      async function uploadFile(name, buffer) {
        await page.locator('#importFileInput').setInputFiles({ name, mimeType: 'application/json', buffer });
      }
      async function importFile(name, buffer) {
        await openImportDialog();
        const before = importRequests.length;
        await uploadFile(name, buffer);
        const started = Date.now();
        await page.locator('#importSubmitBtn').click();
        await waitImportResult();
        const elapsed = Date.now() - started;
        await resultSummaryInView();
        assert.equal(importResponses.at(-1), 200, `${name} must import successfully`);
        assert.equal(importRequests.length - before, 1, `${name} must issue exactly one request`);
        const sent = importRequests.at(-1);
        assert.match(sent.contentType, /^application\/octet-stream/,
          `${name} must be uploaded as raw bytes, saw content-type "${sent.contentType}"`);
        assert.ok(sent.body && sent.body.equals(buffer), `${name} body must be the file bytes`);
        return elapsed;
      }
      async function adminRowText(username) {
        await page.locator('#searchInput').fill(username);
        const row = page.locator('#userTableBody tr', { hasText: username }).first();
        await row.waitFor({ state: 'visible' });
        return row.innerText();
      }
      // Every group in the result must be its own section with its own count.
      function groupPattern(label, count) {
        return new RegExp(`${label}（共\\s*${count}\\s*条）`);
      }
      async function assertDetailsScrollable() {
        const scrollable = await page.evaluate(() => {
          const box = document.getElementById('importResult');
          if (!box) return null;
          for (const node of [box, ...box.querySelectorAll('*')]) {
            const style = getComputedStyle(node);
            const scrollableY = style.overflowY === 'auto' || style.overflowY === 'scroll';
            if (scrollableY && node.scrollHeight > node.clientHeight + 1) {
              return { tag: node.tagName, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
            }
          }
          return null;
        });
        assert.ok(scrollable, 'the full grouped details must stay scrollable for large results');
      }

      // Admin session through the real two-step login.
      const admin = await f.user('admin');
      await page.goto(`${f.baseUrl}/oauth2/authorize`);
      await page.locator('#loginUsername').fill(admin.username);
      await continueToPassword(page);
      await page.locator('#loginPassword').fill(admin.clearPassword);
      await page.locator('#loginForm .submit').click();
      await page.waitForURL('**/profile');

      const conflictUserA = await f.User.create({
        username: uniqueTag('existing'), email: `${uniqueTag('existing-email')}@example.test`,
        password: 'existing-password', role: 'user', emailVerified: true
      });
      const conflictUserB = await f.User.create({
        username: uniqueTag('existing2'), email: `${uniqueTag('existing2-email')}@example.test`,
        password: 'existing-password', role: 'user', emailVerified: true
      });

      const file = buildLegacy97KiBFile({ conflictUsername: conflictUserA.username });
      // Prerequisite of the reported bug: the old JSON wrapper would exceed the 100KiB body limit.
      assert.ok(file.buffer.length >= 96 * 1024 && file.buffer.length <= 98 * 1024,
        `the sample file should be ~97KiB, got ${file.buffer.length}`);
      assert.ok(JSON.stringify({ content: file.text }).length > GLOBAL_JSON_LIMIT,
        'the old JSON-wrapped payload must exceed the global 100KiB limit for this regression to be meaningful');

      // ── 1. The 97KiB file uploads as its own bytes, with no record-count cap in the UI ──
      await page.goto(`${f.baseUrl}/users.html`);
      await page.locator('#importBtn').waitFor({ state: 'visible' });
      await openImportDialog();

      const limitsText = await page.locator('#importLimits').innerText();
      assert.match(limitsText, /10\s*(MB|MiB|M|兆)/i, 'the import dialog must state the size bound');
      assert.doesNotMatch(limitsText, /200/, 'the removed 200-record cap must not be advertised');
      assert.doesNotMatch(limitsText, /\d+\s*条/, `no fixed record-count cap may be shown, saw: ${limitsText}`);

      const requestsBefore = importRequests.length;
      await uploadFile('users.json', file.buffer);
      assert.equal(await page.locator('#importContent').inputValue(), '',
        'selecting a file must clear pasted content so exactly one source is active');
      assert.match(await page.locator('#importSourceHint').innerText(), /直接上传文件/,
        'the dialog must show that the file itself will be uploaded');

      await page.locator('#importSubmitBtn').click();
      await waitImportResult();
      await resultSummaryInView();
      assert.equal(importResponses.at(-1), 200, 'the file import must answer 200');
      assert.equal(importRequests.length - requestsBefore, 1, 'the file import must issue exactly one request');
      const upload = importRequests.at(-1);
      assert.match(upload.contentType, /^application\/octet-stream/,
        `the file must be uploaded as raw bytes, saw content-type "${upload.contentType}"`);
      assert.ok(upload.body && upload.body.equals(file.buffer),
        'the request body must be the file bytes, not a JSON string container');
      assert.equal(upload.body.includes(Buffer.from('"content"')), false,
        'the upload must not be wrapped as {"content": ...}');

      const resultText = await page.locator('#importResult').innerText();
      assert.match(resultText, /成功导入\s*188\s*个用户/, `expected 188 created, saw: ${resultText}`);
      assert.match(resultText, /跳过\s*2\s*条记录/, `expected 2 skipped, saw: ${resultText}`);
      assert.match(resultText, groupPattern(GROUP_DUPLICATE, 2),
        'the two skipped rows must be grouped with a count');
      assert.match(resultText, /第\s*2\s*行[\s\S]*与本次导入中的其他记录重复/,
        'the duplicate row must keep its row number and reason');
      assert.match(resultText, /第\s*6\s*行[\s\S]*用户名或邮箱已存在/,
        'the conflicting row must be reported with its reason');
      await screenshot(page, 'import-file-success');
      await closeImportDialog();

      // ── 2. Mixed file: grouped categories, missing emails are successes ─────
      const mixed = buildMixedEmailFile({
        conflictUsername: conflictUserA.username,
        conflictEmail: conflictUserB.email
      });
      await page.goto(`${f.baseUrl}/users.html`);
      await page.locator('#importBtn').waitFor({ state: 'visible' });
      const mixedElapsed = await importFile('mixed-email.json', mixed.buffer);
      const mixedText = await page.locator('#importResult').innerText();

      // Counts: 8 created (6 unbound) and 7 skipped split across three distinct groups.
      assert.match(mixedText, /成功导入\s*8\s*个用户/, `expected 8 created, saw: ${mixedText}`);
      assert.match(mixedText, /跳过\s*7\s*条记录/, `expected 7 skipped, saw: ${mixedText}`);
      assert.match(mixedText, groupPattern(GROUP_NO_EMAIL, 6),
        'missing-email creations must be their own success group with a count');
      assert.match(mixedText, groupPattern(GROUP_DUPLICATE, 3),
        'duplicate skips must be their own group with a count');
      assert.match(mixedText, groupPattern(GROUP_INVALID_EMAIL, 2),
        'malformed emails must be their own group with a count');
      assert.match(mixedText, groupPattern(GROUP_OTHER, 2),
        'remaining skips must be their own group with a count');

      // The three skip categories must not be merged into one list.
      const groupOrder = [GROUP_NO_EMAIL, GROUP_DUPLICATE, GROUP_INVALID_EMAIL, GROUP_OTHER]
        .map(label => mixedText.indexOf(label));
      assert.ok(groupOrder.every(index => index >= 0), 'all four groups must be rendered');
      assert.deepEqual([...groupOrder].sort((a, b) => a - b), groupOrder,
        'the groups must be rendered as separate ordered sections');

      // Original row/account details, and never the internal synthetic mailbox.
      assert.match(mixedText, new RegExp(`第\\s*1\\s*行\\s*${mixed.prefix}-omitted`),
        'the unbound success must show its original row and username');
      assert.match(mixedText, new RegExp(`第\\s*7\\s*行[\\s\\S]*${conflictUserA.username}[\\s\\S]*用户名或邮箱已存在`),
        'the duplicate-username row must show the original account and reason');
      assert.match(mixedText, new RegExp(`第\\s*8\\s*行[\\s\\S]*${mixed.prefix}-dupemail[\\s\\S]*邮箱已被其他账户使用`),
        'the duplicate-email row must show the original account and reason');
      assert.match(mixedText, new RegExp(`第\\s*10\\s*行[\\s\\S]*${mixed.prefix}-pair[\\s\\S]*与本次导入中的其他记录重复`),
        'the in-file duplicate row must be reported');
      assert.match(mixedText, new RegExp(`第\\s*11\\s*行[\\s\\S]*${mixed.prefix}-bad[\\s\\S]*邮箱格式无效`),
        'the malformed-email row must be reported with its own reason');
      assert.match(mixedText, /第\s*15\s*行[\s\S]*not-an-email-no-user[\s\S]*邮箱格式无效/,
        'a row whose source email is malformed and has no username must show that raw value');
      assert.match(mixedText, /第\s*12\s*行[\s\S]*缺少用户名/, 'a row without username or email must land in other errors');
      assert.match(mixedText, /第\s*13\s*行[\s\S]*积分/, 'an invalid credits row must land in other errors');
      assert.equal(mixedText.includes('@users.invalid'), false,
        'the internal unbound mailbox must never be displayed in the result');
      await screenshot(page, 'import-mixed-grouped-result');
      await closeImportDialog();

      // Deterministic unbound address, unique per username, unverified even for ischeck=y.
      const rowOmitted = await f.User.findByUsername(`${mixed.prefix}-omitted`);
      assert.equal(rowOmitted.email, syntheticEmailFor(`${mixed.prefix}-omitted`),
        'a missing email must become the deterministic import-<sha256>@users.invalid address');
      assert.ok(!rowOmitted.email_verified, 'a synthesized unbound address must not be verified');
      const rowNull = await f.User.findByUsername(`${mixed.prefix}-null`);
      assert.equal(rowNull.email, syntheticEmailFor(`${mixed.prefix}-null`));
      assert.notEqual(rowNull.email, rowOmitted.email, 'each imported username needs a unique unbound address');
      const rowSynthCheck = await f.User.findByUsername(`${mixed.prefix}-synthcheck`);
      assert.match(rowSynthCheck.email, /@users\.invalid$/);
      assert.ok(!rowSynthCheck.email_verified, 'ischeck=y must not verify a synthesized unbound address');
      const rowExplicit = await f.User.findByUsername(`${mixed.prefix}-explicit`);
      assert.equal(rowExplicit.email, `${mixed.prefix}-explicit@users.invalid`,
        'an explicitly provided @users.invalid address is kept as given');
      assert.ok(!rowExplicit.email_verified, 'an existing @users.invalid address must not be verified');
      const rowReal = await f.User.findByUsername(`${mixed.prefix}-real`);
      assert.ok(rowReal.email_verified, 'username + real email + ischeck=y must keep verifying');

      // The admin list must label the unbound account instead of showing the internal address.
      const unboundRowText = await adminRowText(`${mixed.prefix}-omitted`);
      assert.match(unboundRowText, /未绑定邮箱/, 'the admin list must display 未绑定邮箱 for an unbound account');
      assert.equal(unboundRowText.includes('@users.invalid'), false,
        'the admin list must not display the internal unbound mailbox');
      assert.match(await adminRowText(`${mixed.prefix}-real`), /已验证/,
        'a real, verified email must keep its 已验证 badge');
      await page.locator('#searchInput').fill('');
      await screenshot(page, 'admin-unbound-email');
      console.log(`[${viewport.tag}] mixed import: 15 rows -> created 8 (6 unbound), skipped 7, ${mixedElapsed}ms`);

      // ── 3. A fresh unauthenticated session sees the contact-administrator instruction ──
      const anonContext = await browser.newContext({ viewport, locale: 'zh-CN' });
      await anonContext.route('**/*', route =>
        new URL(route.request().url()).origin === f.baseUrl ? route.continue() : route.abort());
      const anonPage = await anonContext.newPage();
      const anonErrors = [];
      anonPage.on('pageerror', error => anonErrors.push(error.message));
      await anonPage.goto(`${f.baseUrl}/oauth2/authorize`);
      await anonPage.locator('#authRegion').waitFor({ state: 'visible' });

      const mailBefore = f.mails.length;
      const sessionsBefore = f.pool.sessions.length;
      for (const identifier of [`${mixed.prefix}-omitted`, `${mixed.prefix}-explicit`, `${mixed.prefix}-synthcheck`]) {
        // After a contact-administrator result the account fields are hidden again; go back first.
        if (await anonPage.locator('#loginContactAdmin').isVisible()) {
          await anonPage.locator('#changeLoginAccountBtn').click();
          await anonPage.waitForFunction(() => {
            const field = document.getElementById('loginUsername');
            return Boolean(field) && field.offsetParent !== null;
          }, null, { timeout: 15000 });
          assert.equal(await anonPage.locator('#loginContactAdmin').isVisible(), false,
            'the contact-administrator section must be cleared when returning to account entry');
        }
        await anonPage.locator('#loginUsername').fill(identifier);
        await anonPage.locator('#loginForm .submit').click();
        await anonPage.locator('#loginContactAdmin').waitFor({ state: 'visible', timeout: 15000 });
        assert.match(await anonPage.locator('#loginContactAdmin').innerText(), /请联系管理员重置/,
          `an unbound account must show the contact-administrator instruction (${identifier})`);
        assert.equal(await anonPage.locator('#sendSetupCodeBtn').isVisible(), false,
          'no send-code action may be offered for an unbound account');
        assert.equal(await anonPage.locator('#passwordSetupForm').isVisible(), false,
          'no first-password setup may be offered for an unbound account');
      }
      assert.equal(f.mails.length, mailBefore, 'discovering an unbound account must never send mail');
      assert.equal(f.pool.sessions.length, sessionsBefore, 'no session may be created for an unbound account');
      assert.equal((await anonContext.request.get(`${f.baseUrl}/api/profile`)).status(), 401);
      await screenshot(anonPage, 'contact-admin-unbound');
      assert.deepEqual(anonErrors, []);
      await anonContext.close();

      // ── 4. A real >2000-row file must import with no record-count cap ────────
      const bulk = buildBulkFile({
        rowCount: BULK_ROWS,
        conflictUsername: conflictUserA.username,
        conflictEmail: conflictUserB.email
      });
      assert.ok(bulk.rows.length > 2000, 'the bulk file must be far larger than any historical cap');
      assert.ok(bulk.buffer.length <= MAX_IMPORT_BYTES,
        `the bulk file must stay inside the size bound, got ${bulk.buffer.length}`);
      assert.ok(bulk.buffer.length > GLOBAL_JSON_LIMIT,
        'the bulk file must also exceed the ordinary JSON limit, proving it uses the file transport');
      const bulkUnboundTag = `${bulk.prefix}-0051`;
      assert.equal(bulk.rows[50].email, undefined, 'the bulk file must contain rows without an email');

      await page.goto(`${f.baseUrl}/users.html`);
      await page.locator('#importBtn').waitFor({ state: 'visible' });
      const bulkElapsed = await importFile('bulk-2501.json', bulk.buffer);
      const bulkText = await page.locator('#importResult').innerText();
      assert.match(bulkText, new RegExp(`成功导入\\s*${BULK_ROWS - 3}\\s*个用户`),
        `all non-conflicting rows must be created, saw: ${bulkText.slice(0, 200)}`);
      assert.match(bulkText, /跳过\s*3\s*条记录/, `only the 3 conflicting rows may be skipped, saw: ${bulkText.slice(0, 200)}`);
      assert.match(bulkText, groupPattern(GROUP_NO_EMAIL, BULK_UNBOUND_ROWS),
        `missing-email rows must be counted at scale, saw: ${bulkText.slice(0, 200)}`);
      assert.match(bulkText, groupPattern(GROUP_DUPLICATE, 3), 'bulk duplicate skips must be grouped');
      assert.match(bulkText, /第\s*10\s*行[\s\S]*用户名或邮箱已存在/);
      assert.match(bulkText, /第\s*11\s*行[\s\S]*邮箱已被其他账户使用/);
      const bulkUnbound = await f.User.findByUsername(bulkUnboundTag);
      assert.equal(bulkUnbound.email, syntheticEmailFor(bulkUnboundTag),
        'missing-email rows at scale must also receive the deterministic unbound address');
      assert.ok(!bulkUnbound.email_verified, 'bulk unbound accounts must not be verified');
      await screenshot(page, 'import-bulk-rows-success');
      closeImportDialog();
      await page.locator('#importModal').waitFor({ state: 'hidden' });
      console.log(`[${viewport.tag}] bulk first import: ${BULK_ROWS} rows -> created ${BULK_ROWS - 3} `
        + `(${BULK_UNBOUND_ROWS} unbound), skipped 3, ${bulkElapsed}ms`);

      // Re-importing the identical file proves every row is processed again with no cap.
      await openImportDialog();
      const reimportStarted = Date.now();
      await uploadFile('bulk-2501.json', bulk.buffer);
      await page.locator('#importSubmitBtn').click();
      await waitImportResult();
      const reimportElapsed = Date.now() - reimportStarted;
      const reimportText = await page.locator('#importResult').innerText();
      assert.match(reimportText, /成功导入\s*0\s*个用户/,
        `a re-import must create nothing, saw: ${reimportText.slice(0, 200)}`);
      assert.match(reimportText, new RegExp(`跳过\\s*${BULK_ROWS}\\s*条记录`),
        `a re-import must still process all ${BULK_ROWS} rows, saw: ${reimportText.slice(0, 200)}`);
      assert.match(reimportText, groupPattern(GROUP_DUPLICATE, BULK_ROWS),
        'the whole re-import must land in the duplicate group as one counted section');
      assert.equal(reimportText.includes(GROUP_NO_EMAIL), false,
        'a re-import with no created rows must not show an empty success group');
      await assertDetailsScrollable();
      await screenshot(page, 'import-bulk-rows-reimport');
      closeImportDialog();
      await page.locator('#importModal').waitFor({ state: 'hidden' });
      console.log(`[${viewport.tag}] bulk re-import: ${BULK_ROWS} rows -> created 0, `
        + `skipped ${BULK_ROWS}, ${reimportElapsed}ms`);

      // ── 5. Pasted JSON keeps the existing contract and clears the file ──────
      await openImportDialog();
      const pasted = JSON.stringify([
        { username: uniqueTag('paste0'), email: `${uniqueTag('paste0')}@example.test`, password: '', role: 'user' },
        { username: uniqueTag('paste1'), email: `${uniqueTag('paste1')}@example.test`, password: '', role: 'user' }
      ]);
      await uploadFile('ignored.json', Buffer.from('[]', 'utf8'));
      await page.locator('#importContent').fill(pasted);
      assert.equal(await page.locator('#importFileInput').inputValue(), '',
        'typing pasted content must clear the selected file');
      assert.match(await page.locator('#importSourceHint').innerText(), /粘贴内容|未使用任何文件/,
        'the dialog must show that only the pasted content will be sent');

      await page.locator('#importSubmitBtn').click();
      await waitImportResult();
      assert.equal(importResponses.at(-1), 200, 'the pasted import must answer 200');
      const pasteRequest = importRequests.at(-1);
      assert.match(pasteRequest.contentType, /application\/json/, 'the pasted path must keep sending JSON');
      assert.deepEqual(JSON.parse(pasteRequest.body.toString('utf8')), { content: pasted },
        'the pasted path must keep the {"content": ...} contract');
      assert.match(await page.locator('#importResult').innerText(), /成功导入\s*2\s*个用户/,
        'pasted import must succeed');
      await screenshot(page, 'import-paste-success');
      await closeImportDialog();

      // ── 6. A known over-limit file is blocked before any request ───────────
      await openImportDialog();
      const oversizeBefore = importRequests.length;
      await uploadFile('too-big.json', Buffer.alloc(MAX_IMPORT_BYTES + 1, 0x61));
      await page.locator('#importSubmitBtn').click();
      await waitImportResult();
      assert.equal(importRequests.length - oversizeBefore, 0,
        'an over-limit file must be rejected in the browser without an import request');
      const oversizeText = await page.locator('#importResult').innerText();
      assert.match(oversizeText, /(过大|超出|不能超过|超过|限制)/,
        `the over-limit explanation must be visible, saw: ${oversizeText}`);
      assert.match(oversizeText, /10\s*(MB|MiB|M|兆)/i, 'the over-limit explanation must name the real limit');
      await screenshot(page, 'import-oversize-blocked');
      await closeImportDialog();

      // ── 7. A multi-byte paste whose JS length fits but whose UTF-8 bytes do not ─
      await openImportDialog();
      const pasteOversizeBefore = importRequests.length;
      // Built inside the page: 3.5M CJK characters. `.length` is far below 10MiB, but the
      // serialized JSON is ~10.5MB of UTF-8, which is what the server actually receives.
      await page.evaluate(() => {
        const area = document.getElementById('importContent');
        area.value = '中'.repeat(3500000);
        area.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const pasteSizes = await page.evaluate(() => {
        const text = document.getElementById('importContent').value;
        const payload = JSON.stringify({ content: text });
        return { length: text.length, utf8: new TextEncoder().encode(payload).length };
      });
      assert.ok(pasteSizes.length < MAX_IMPORT_BYTES,
        `the precondition needs a JS length below the limit, got ${pasteSizes.length}`);
      assert.ok(pasteSizes.utf8 > MAX_IMPORT_BYTES,
        `the precondition needs UTF-8 bytes above the limit, got ${pasteSizes.utf8}`);

      await page.locator('#importSubmitBtn').click();
      await waitImportResult();
      assert.equal(importRequests.length - pasteOversizeBefore, 0,
        'a multi-byte paste over the byte limit must be rejected without any import request');
      assert.equal(await page.locator('#importSubmitBtn').isDisabled(), false,
        'the locally blocked paste must leave the submit action enabled');
      const pasteOversizeText = await page.locator('#importResult').innerText();
      assert.match(pasteOversizeText, /(超过|过大|超出|不能超过)/,
        `the byte-based explanation must be visible, saw: ${pasteOversizeText}`);
      assert.match(pasteOversizeText, /(文件上传|拆分)/,
        'the over-limit explanation must tell the user what to do instead');
      assert.match(await page.locator('#importLimits').innerText(), /10\s*(MB|MiB|M|兆)/i,
        'the dialog must still state the real size bound');
      assert.match(await page.locator('#importSourceHint').innerText(), /MiB/i,
        'the hint must reflect the measured UTF-8 size of the pasted payload');
      const preserved = await page.evaluate(() => document.getElementById('importContent').value.length);
      assert.equal(preserved, 3500000, 'the blocked paste must be preserved so it can be split and retried');
      await screenshot(page, 'import-paste-oversize-blocked');
      await closeImportDialog();

      // ── 8. A failed request preserves the selected source for retry ────────
      await page.goto(`${f.baseUrl}/users.html`);
      await page.locator('#importBtn').waitFor({ state: 'visible' });
      await openImportDialog();
      await uploadFile('retry.json', file.buffer);
      await context.route('**/api/users/import', route =>
        route.fulfill({ status: 500, contentType: 'application/json',
          body: JSON.stringify({ error: 'server_error', error_description: '导入失败，请重试' }) }));
      await page.locator('#importSubmitBtn').click();
      await waitImportResult();
      assert.equal(importResponses.at(-1), 500, 'the forced failure must be the response the UI reports');
      const failureText = await page.locator('#importResult').innerText();
      assert.match(failureText, /(失败|重试)/, `the failure must be reported, saw: ${failureText}`);
      const retryFiles = await page.locator('#importFileInput').evaluate(input =>
        input.files && input.files.length ? input.files[0].name : '');
      assert.equal(retryFiles, 'retry.json', 'the selected file must survive a failed request so it can be retried');
      await context.unroute('**/api/users/import');
      await closeImportDialog();

      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('User import upload browser checks passed: 97KiB raw-bytes upload, missing emails imported as '
      + 'unbound @users.invalid accounts (contact-administrator login, no mail/session, 未绑定邮箱), grouped result '
      + `groups with counts and original rows, no record-count cap (real ${BULK_ROWS}-row file with `
      + `${BULK_UNBOUND_ROWS} unbound rows), pasted JSON compatibility, browser over-limit blocks, retry source `
      + 'preservation, desktop and mobile');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });