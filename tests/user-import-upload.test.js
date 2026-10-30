'use strict';

// API coverage for the user-import transport correction (10-23-account-first-login).
//
// The reported failure: a 97 KiB JSON export could not be imported because the
// browser serialised it into `{ content }` (escaping every quote twice) and the
// global express.json() limit is 100 KiB. Files are now uploaded as raw UTF-8
// bytes with an import-only 10 MiB bound; every other endpoint keeps 100 KiB.
//
// All accounts created here use an empty password so the real bcrypt cost is not
// paid and the isolated fixture stays fast.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFixture } = require('./support/fixture');

const MIB = 1024 * 1024;
const IMPORT_MAX_BYTES = 10 * MIB;
const ORDINARY_JSON_LIMIT = 100 * 1024;

// The 97KiB transport regression reproduced a real export that happened to contain
// 200 records, so that sample keeps 200 rows. It is a sample count, NOT an import
// maximum: imports are bounded only by the 10MiB body limit and must accept far more.
const TRANSPORT_SAMPLE_ROWS = 200;

// Deliberately well above both the removed 200-row cap and the "above 2000 rows"
// acceptance, so a re-introduced record cap fails this suite.
const UNBOUNDED_ROWS = 2501;

let f;

before(async () => {
  f = await createFixture();
});
beforeEach(() => f.reset());
after(async () => {
  if (f) await f.close();
});

// ── helpers ────────────────────────────────────────────────────────────────

function randomName(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}
function randomEmail(prefix) {
  return `${randomName(prefix)}@example.test`;
}

// Logs in a real administrator so the route sees an admin session cookie.
async function adminSession() {
  const account = await f.user('admin');
  const login = await f.login(account);
  assert.equal(login.status, 200, `admin login failed: ${JSON.stringify(login.body)}`);
  return { account, cookie: login.cookie };
}

// Creates an account without a password so no bcrypt work happens.
function seedAccount({ username = randomName('seed'), email = randomEmail('seed') } = {}) {
  return f.User.create({ username, email, password: '', name: 'Seed', emailVerified: true });
}

// Uploads a selected file exactly as the browser now does: raw UTF-8 bytes.
function upload(cookie, body, { path = '/api/users/import', headers = {}, ...options } = {}) {
  return f.request(path, {
    method: 'POST',
    body,
    cookie,
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    ...options
  });
}

// Uploads pasted content through the preserved legacy `{ content }` contract.
function paste(cookie, content, { path = '/api/users/import', ...options } = {}) {
  return f.request(path, { method: 'POST', cookie, data: { content }, ...options });
}

function userCount() {
  return f.pool.users.length;
}
function importAdminLogs() {
  return f.pool.loginLogs.filter(row => String(row.detail || '').includes('import_users'));
}

// Builds a real JSON export whose raw byte size is `targetBytes`. `rowCount` is the
// number of sample records (defaults to the 97KiB reproduction) and is independent of
// any import maximum, which no longer exists.
function largeJsonExport(targetBytes, rowCount = TRANSPORT_SAMPLE_ROWS) {
  const rows = [];
  for (let index = 0; index < rowCount; index++) {
    const id = crypto.randomUUID();
    rows.push({
      username: `bulk-${id}`,
      email: `bulk-${id}@example.test`,
      name: `Bulk ${index}`,
      password: '',
      extra_a: 'x',
      extra_b: 'y',
      extra_c: 'z',
      extra_d: 'w',
      note: ''
    });
  }
  // Every extra property adds unescaped quotes to the file, so the legacy
  // `{ content }` wrapper grows faster than the file itself.
  const base = JSON.stringify(rows);
  let deficit = targetBytes - Buffer.byteLength(base, 'utf8');
  assert.ok(deficit > 0, 'target size must exceed the bare export');
  const perRow = Math.floor(deficit / rowCount);
  for (let index = 0; index < rows.length && deficit > 0; index++) {
    const take = index === rows.length - 1 ? deficit : perRow;
    rows[index].note = 'x'.repeat(take);
    deficit -= take;
  }
  return JSON.stringify(rows);
}

// Builds `count` unique passwordless rows. Empty passwords keep bcrypt out of the
// path, which matters for the multi-thousand-row imports below.
function bulkRows(count, prefix = 'many') {
  const rows = [];
  for (let index = 0; index < count; index++) {
    const id = crypto.randomUUID();
    rows.push({
      username: `${prefix}-${id}`,
      email: `${prefix}-${id}@example.test`,
      name: `${prefix} ${index}`,
      password: ''
    });
  }
  return rows;
}

// Mirrors the importer's deterministic unbound placeholder for a username-only record.
function expectedPlaceholder(username) {
  return `import-${crypto.createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0, 24)}@users.invalid`;
}

// Unauthenticated account discovery (stateless: no token, no cookie).
function discover(username) {
  return f.request('/oauth2/authorize', { method: 'POST', data: { discover_account: true, username } });
}

// Passes the password policy; only used where a usable password is required.
const SEED_PASSWORD = 'Zx9!mQ2vLp7#Rt4s';

// ── acceptance 1: a ~97 KiB real file whose legacy wrapper exceeds 100 KiB ──

test('a ~97KiB JSON file imports through raw uploaded bytes while the legacy wrapper alone would exceed 100KiB', async () => {
  const admin = await adminSession();
  const file = largeJsonExport(97 * 1024);
  const fileBytes = Buffer.byteLength(file, 'utf8');

  // The file itself must be a genuine ~97KiB file that is under the ordinary limit.
  assert.ok(fileBytes > 95 * 1024, `expected a ~97KiB file, got ${fileBytes} bytes`);
  assert.ok(fileBytes < ORDINARY_JSON_LIMIT, `file must stay under the ordinary limit, got ${fileBytes} bytes`);

  // The old transport escaped every quote a second time and crossed 100KiB.
  const legacyWrapper = JSON.stringify({ content: file });
  assert.ok(
    Buffer.byteLength(legacyWrapper, 'utf8') > ORDINARY_JSON_LIMIT,
    `the legacy wrapper must exceed the ordinary limit, got ${Buffer.byteLength(legacyWrapper, 'utf8')} bytes`
  );

  const before = userCount();
  const result = await upload(admin.cookie, file);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.createdCount, TRANSPORT_SAMPLE_ROWS);
  assert.equal(result.body.skippedCount, 0);
  assert.equal(result.body.created.length, TRANSPORT_SAMPLE_ROWS);
  assert.equal(userCount() - before, TRANSPORT_SAMPLE_ROWS);

  // The uploaded file is imported as real users, not echoed back.
  const first = result.body.created[0];
  const stored = f.pool.users.find(row => row.id === first.id);
  assert.ok(stored, 'imported user must exist in the database');
  assert.equal(stored.password, '', 'imported users keep the unset-password marker');
  assert.equal(stored.email_verified, false);
  assert.equal(importAdminLogs().length, 1);
});

test('the import-only bound accepts a raw file above the ordinary 100KiB JSON limit', async () => {
  const admin = await adminSession();
  const rows = [];
  for (let index = 0; index < 20; index++) {
    const id = crypto.randomUUID();
    rows.push({ username: `wide-${id}`, email: `wide-${id}@example.test`, password: '', note: 'x'.repeat(7000) });
  }
  const file = JSON.stringify(rows);
  assert.ok(Buffer.byteLength(file, 'utf8') > ORDINARY_JSON_LIMIT, 'fixture must exceed the ordinary limit');

  const result = await upload(admin.cookie, file);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.createdCount, 20);
});

// ── acceptance 5: the legacy pasted `{ content }` contract is preserved ─────

test('the legacy pasted JSON contract still imports, including content above the ordinary limit', async () => {
  const admin = await adminSession();
  const file = largeJsonExport(97 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify({ content: file }), 'utf8') > ORDINARY_JSON_LIMIT);

  const result = await paste(admin.cookie, file);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.createdCount, TRANSPORT_SAMPLE_ROWS);
});

test('an empty or malformed import is rejected with the existing import errors', async () => {
  const admin = await adminSession();

  // Whitespace-only content is reported as unparseable, not as "no records".
  const blank = await upload(admin.cookie, '   ');
  assert.equal(blank.status, 400);
  assert.equal(blank.body.error_key, 'users.import.invalid');

  // A syntactically valid but empty document is the explicit "no records" case.
  const empty = await upload(admin.cookie, '[]');
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error_key, 'users.import.empty');

  const malformed = await upload(admin.cookie, '[{"username":');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error_key, 'users.import.invalid');

  const wrongShape = await upload(admin.cookie, JSON.stringify({ rows: [] }));
  assert.equal(wrongShape.status, 400);
  assert.equal(wrongShape.body.error_key, 'users.import.invalid');
});

// ── acceptance 2: CSV/BOM, duplicates and per-row reasons ──────────────────

test('a BOM-prefixed CSV file imports blank-email rows and reports per-row reasons', async () => {
  const admin = await adminSession();

  // Conflicts sourced from records that already exist in the database.
  const existingName = await seedAccount();
  const existingMail = await seedAccount();

  const created = { username: randomName('csv'), email: randomEmail('csv') };
  const noEmail = randomName('nomail');

  // A UTF-8 BOM must not break header detection.
  const csv = `\uFEFF${[
    'username,email,name',
    `${created.username},${created.email},Csv Created`,
    `${created.username},${created.email},Csv Duplicate`,
    `${existingName.username},${randomEmail('other')},Existing Name`,
    `${randomName('freshuser')},${existingMail.email},Existing Mail`,
    `${randomName('badmail')},not-an-email,Bad Mail`,
    `${noEmail},,No Mail`
  ].join('\n')}`;

  const before = userCount();
  const result = await upload(admin.cookie, csv);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  // A blank email is now a valid username-only record, not a rejection.
  assert.equal(result.body.createdCount, 2);
  assert.equal(result.body.skippedCount, 4);
  assert.equal(result.body.created[0].username, created.username);
  assert.equal(result.body.created[1].username, noEmail);
  assert.equal(userCount() - before, 2);

  const skipped = result.body.skipped;
  // Human reasons stay, and every skip carries a machine-readable category.
  assert.deepEqual(skipped.map(entry => entry.reason), [
    '与本次导入中的其他记录重复',
    '用户名或邮箱已存在',
    '邮箱已被其他账户使用',
    '邮箱格式无效'
  ]);
  assert.deepEqual(skipped.map(entry => entry.reason_code), [
    'duplicate_identity',
    'duplicate_username',
    'duplicate_email',
    'invalid_email'
  ]);

  // Each skipped entry identifies the input row and the raw source account.
  assert.deepEqual(skipped.map(entry => entry.row), [2, 3, 4, 5]);
  assert.equal(skipped[1].username, existingName.username);
  assert.equal(skipped[2].email, existingMail.email);
  assert.ok(skipped[3].username.startsWith('badmail-'));
  assert.equal(skipped[3].email, 'not-an-email');

  // The username-only row is reported as imported without email and stores a
  // deterministic unbound placeholder that is not a mailbox.
  assert.deepEqual(result.body.importedWithoutEmail, [{ row: 6, username: noEmail }]);
  const stored = f.pool.users.find(row => row.username === noEmail);
  assert.equal(stored.email, expectedPlaceholder(noEmail));
  assert.equal(stored.email_verified, false);
});

test('a JSON file skips rows that collide with existing usernames and emails', async () => {
  const admin = await adminSession();
  const existingName = await seedAccount();
  const existingMail = await seedAccount();
  const ok = { username: randomName('json'), email: randomEmail('json') };

  const result = await upload(admin.cookie, JSON.stringify([
    { ...ok, name: 'ok', password: '' },
    { username: randomName('taken'), email: existingName.email, password: '' },
    { username: existingName.username, email: randomEmail('takenname'), password: '' },
    { username: randomName('takenmail'), email: existingMail.email, password: '' }
  ]));

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.createdCount, 1);
  assert.equal(result.body.skippedCount, 3);
  // A conflicting email resolves through the email lookup, a conflicting username
  // through the username lookup; the reasons stay distinct and per-row.
  assert.deepEqual(result.body.skipped.map(entry => entry.reason), [
    '邮箱已被其他账户使用',
    '用户名或邮箱已存在',
    '邮箱已被其他账户使用'
  ]);
  assert.deepEqual(result.body.skipped.map(entry => entry.reason_code), [
    'duplicate_email',
    'duplicate_username',
    'duplicate_email'
  ]);
  assert.deepEqual(result.body.skipped.map(entry => entry.row), [2, 3, 4]);
  assert.equal(result.body.skipped[1].username, existingName.username);
});

// Regression: legacy cross-field rows where one account's username is another
// account's email. A plain single-row lookup (`WHERE username = ? OR email = ?`
// must match exactly one row) returns null because two rows match, so the importer
// used to fall through to User.create, hit a duplicate-key error and abort the whole
// batch with 409 -- discarding every later, perfectly valid row.
test('legacy cross-field accounts make ambiguous import rows skip instead of aborting the batch', async () => {
  const admin = await adminSession();

  // Legacy data: `shared` is A's username and also B's email.
  const shared = 'legacy-cross@example.test';
  const accountA = await seedAccount({ username: shared, email: 'owner-a@example.test' });
  const accountB = await seedAccount({ username: 'legacy-owner-b', email: shared });

  // Precondition that produced the abort: the shared value resolves to two rows, so
  // the single-row lookup intentionally reports "no match".
  assert.equal(await f.User.findByUsername(shared), null, 'the shared value must be ambiguous');
  assert.equal(
    (await f.User.findPotentialConflicts(shared, shared)).length,
    2,
    'two legacy accounts must share the value'
  );

  const before = userCount();
  const snapshot = f.pool.users.map(row => ({
    id: row.id,
    username: row.username,
    email: row.email,
    password: row.password
  }));

  const result = await upload(admin.cookie, JSON.stringify([
    // username is ambiguous: it matches A's username and B's email.
    { username: shared, email: 'new-username-row@example.test', password: '' },
    // same ambiguity expressed with a different case (accounts compare case-insensitively).
    { username: shared.toUpperCase(), email: 'new-username-case@example.test', password: '' },
    // email is ambiguous: it matches A's username and B's email.
    { username: 'new-email-row', email: shared, password: '' },
    // same ambiguity expressed with a different case; the server lowercases emails.
    { username: 'new-email-case', email: shared.toUpperCase(), password: '' },
    // A valid row after the ambiguous ones must still be processed, not discarded.
    { username: 'valid-after-ambiguous', email: 'valid-after-ambiguous@example.test', password: '' }
  ]));

  // The whole batch must complete instead of aborting with a duplicate-key 409.
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.createdCount, 1);
  assert.equal(result.body.skippedCount, 4);

  const skipped = result.body.skipped;
  assert.deepEqual(skipped.map(entry => entry.row), [1, 2, 3, 4]);
  // Original reasons: the username check runs before the email check.
  assert.deepEqual(skipped.map(entry => entry.reason), [
    '用户名或邮箱已存在',
    '用户名或邮箱已存在',
    '邮箱已被其他账户使用',
    '邮箱已被其他账户使用'
  ]);
  assert.deepEqual(skipped.map(entry => entry.reason_code), [
    'duplicate_username',
    'duplicate_username',
    'duplicate_email',
    'duplicate_email'
  ]);
  // Each skip still reports the rejected input account and its destination.
  assert.equal(skipped[0].username, shared);
  assert.equal(skipped[0].email, 'new-username-row@example.test');
  // Usernames keep the submitted case; emails are normalized (lowercased) before
  // being reported, so the case-variant row still echoes the canonical destination.
  assert.equal(skipped[1].username, shared.toUpperCase());
  assert.equal(skipped[1].email, 'new-username-case@example.test');
  assert.equal(skipped[2].email, shared);
  assert.equal(skipped[3].email, shared, 'the reported email is the normalized destination');

  // The valid row after the ambiguous ones is created and stored.
  assert.equal(result.body.created[0].username, 'valid-after-ambiguous');
  assert.ok(
    f.pool.users.some(row => row.username === 'valid-after-ambiguous'),
    'the row following the ambiguous ones must be imported'
  );
  assert.equal(userCount() - before, 1);

  // No existing account was rewritten or removed by the import.
  for (const original of snapshot) {
    const current = f.pool.users.find(row => row.id === original.id);
    assert.ok(current, `existing account ${original.id} must still exist`);
    assert.deepEqual(
      { username: current.username, email: current.email, password: current.password },
      { username: original.username, email: original.email, password: original.password },
      'an import must not modify existing accounts'
    );
  }
  assert.equal(f.pool.users.find(row => row.id === accountA.id).username, shared);
  assert.equal(f.pool.users.find(row => row.id === accountB.id).email, shared);
  assert.equal(importAdminLogs().length, 1);
});

// ── no record-count cap: imports are bounded only by the 10MiB body limit ───
//
// The user explicitly rejected replacing the old 200-row maximum with another fixed
// number. Every valid record must be created up to the scoped body bound, while
// per-row duplicate skips and their details keep working.

test('an import well above the removed 200-row cap creates every valid record', async () => {
  const admin = await adminSession();
  const rows = bulkRows(UNBOUNDED_ROWS);
  // A third of the mass sample is username-only: a missing email must not reduce the
  // accepted record count, it produces an unbound placeholder instead.
  const usernameOnlyRows = [];
  rows.forEach((row, index) => {
    if (index % 3 === 0) {
      delete row.email;
      usernameOnlyRows.push(row);
    }
  });
  const payload = JSON.stringify(rows);
  assert.ok(
    Buffer.byteLength(payload, 'utf8') < IMPORT_MAX_BYTES,
    'the fixture must stay inside the 10MiB body bound'
  );

  const before = userCount();
  const result = await upload(admin.cookie, payload);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  // The removed cap must not come back as any kind of record-count rejection.
  assert.notEqual(result.body.error_key, 'users.import.too_many');
  assert.equal(result.body.createdCount, UNBOUNDED_ROWS);
  assert.equal(result.body.skippedCount, 0);
  assert.equal(result.body.created.length, UNBOUNDED_ROWS);
  assert.equal(userCount() - before, UNBOUNDED_ROWS);

  // Every username-only record is listed as imported without email, in source order,
  // and stores a unique deterministic placeholder.
  assert.equal(result.body.importedWithoutEmail.length, usernameOnlyRows.length);
  assert.deepEqual(
    result.body.importedWithoutEmail.map(entry => entry.username),
    usernameOnlyRows.map(row => row.username)
  );
  const placeholders = usernameOnlyRows.map(
    row => f.pool.users.find(candidate => candidate.username === row.username).email
  );
  assert.equal(new Set(placeholders).size, usernameOnlyRows.length);
  assert.ok(placeholders.every(email => /^import-[0-9a-f]{24}@users\.invalid$/.test(email)));

  // Nothing was truncated: the first and last rows of the batch are both stored.
  assert.ok(f.pool.users.some(row => row.username === rows[0].username), 'first row must be created');
  assert.ok(
    f.pool.users.some(row => row.username === rows[UNBOUNDED_ROWS - 1].username),
    'last row must be created'
  );
  assert.equal(importAdminLogs().length, 1);
});

test('a large import still reports existing and in-file duplicate skips with row details', async () => {
  const admin = await adminSession();

  // Conflicts that already exist in the database before the import runs.
  const existingName = await seedAccount();
  const existingMail = await seedAccount();

  const uniqueCount = 2495;
  const rows = bulkRows(uniqueCount);

  // Two in-file duplicates of the very first row (rejected by the within-batch check).
  const inFileDuplicates = [0, 1].map(() => ({ ...rows[0] }));
  // Two username conflicts with distinct emails, so both reach the existing-account check.
  const nameConflicts = [0, 1].map(() => ({
    username: existingName.username,
    email: `${randomName('tname')}@example.test`,
    password: ''
  }));
  // Two email conflicts with distinct usernames, same reason.
  const mailConflicts = [0, 1].map(() => ({
    username: randomName('tmail'),
    email: existingMail.email,
    password: ''
  }));

  rows.push(...inFileDuplicates, ...nameConflicts, ...mailConflicts);
  assert.equal(rows.length, 2501);

  const before = userCount();
  const result = await upload(admin.cookie, JSON.stringify(rows));

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.createdCount, uniqueCount);
  assert.equal(result.body.skippedCount, 6);
  assert.equal(userCount() - before, uniqueCount);

  const skipped = result.body.skipped;
  // Row numbers are 1-based positions in the submitted file.
  assert.deepEqual(skipped.map(entry => entry.row), [2496, 2497, 2498, 2499, 2500, 2501]);
  assert.deepEqual(skipped.map(entry => entry.reason), [
    '与本次导入中的其他记录重复',
    '与本次导入中的其他记录重复',
    '用户名或邮箱已存在',
    '用户名或邮箱已存在',
    '邮箱已被其他账户使用',
    '邮箱已被其他账户使用'
  ]);
  assert.deepEqual(skipped.map(entry => entry.reason_code), [
    'duplicate_identity',
    'duplicate_identity',
    'duplicate_username',
    'duplicate_username',
    'duplicate_email',
    'duplicate_email'
  ]);

  // Each skip identifies the rejected input account, not just a count.
  assert.equal(skipped[0].username, rows[0].username);
  assert.equal(skipped[0].email, rows[0].email);
  assert.equal(skipped[2].username, existingName.username);
  assert.equal(skipped[1].email, rows[0].email);
  assert.equal(skipped[4].email, existingMail.email);
  for (const entry of skipped) {
    assert.ok(entry.username, 'a skipped row must report its username');
    assert.ok(entry.email, 'a skipped row must report its email');
  }
});

test('re-importing the same records skips every row as an existing account', async () => {
  const admin = await adminSession();
  const rows = bulkRows(5, 'repeat');
  const payload = JSON.stringify(rows);

  const first = await upload(admin.cookie, payload);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.createdCount, 5);
  assert.equal(first.body.skippedCount, 0);

  const before = userCount();
  const second = await upload(admin.cookie, payload);

  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.createdCount, 0);
  assert.equal(second.body.skippedCount, 5);
  assert.deepEqual(second.body.skipped.map(entry => entry.row), [1, 2, 3, 4, 5]);
  assert.deepEqual(second.body.skipped.map(entry => entry.reason), Array(5).fill('用户名或邮箱已存在'));
  assert.deepEqual(second.body.skipped.map(entry => entry.reason_code), Array(5).fill('duplicate_username'));
  assert.equal(userCount(), before, 'a repeat import must not create duplicate accounts');
});

// ── optional email: username-only records import as unbound accounts ───────

test('username-only imports store unique unbound placeholders that are never verified', async () => {
  const admin = await adminSession();

  const omitted = randomName('noemail-omitted');
  const blank = randomName('noemail-blank');
  const nullEmail = randomName('noemail-null');
  const whitespace = randomName('noemail-space');
  const ischeck = randomName('noemail-ischeck');
  const explicitSynthetic = randomName('noemail-synthetic');
  const badmail = randomName('badmail');

  const before = userCount();
  const result = await upload(admin.cookie, JSON.stringify([
    { username: omitted, password: '' },                                            // field omitted
    { username: blank, email: '', password: '' },                                    // empty string
    { username: nullEmail, email: null, password: '' },                              // null
    { username: whitespace, email: '   ', password: '' },                            // whitespace only
    { username: ischeck, email: '', password: '', ischeck: 'y' },                    // asks to be verified
    { username: explicitSynthetic, email: `${explicitSynthetic}@users.invalid`, password: '', ischeck: 'y' },
    { username: '', email: '', password: '' },                                       // both identifiers missing
    { username: badmail, email: 'not-an-email', password: '' }                       // nonempty malformed
  ]));

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.createdCount, 6);
  assert.equal(result.body.skippedCount, 2);
  assert.equal(userCount() - before, 6);

  const skipped = result.body.skipped;
  // A missing source email is a success now; only these two rows are rejected, and the
  // machine code keeps "missing username" and "invalid email" distinct.
  assert.deepEqual(skipped.map(entry => entry.row), [7, 8]);
  assert.deepEqual(skipped.map(entry => entry.reason_code), ['missing_username', 'invalid_email']);
  assert.deepEqual(skipped.map(entry => entry.reason), ['缺少用户名', '邮箱格式无效']);
  assert.equal(skipped[1].username, badmail);
  assert.equal(skipped[1].email, 'not-an-email', 'skip details keep the raw source email');

  // Deterministic, unique, unbound placeholders; the explicit synthetic input is kept as-is.
  const expected = [
    [omitted, expectedPlaceholder(omitted)],
    [blank, expectedPlaceholder(blank)],
    [nullEmail, expectedPlaceholder(nullEmail)],
    [whitespace, expectedPlaceholder(whitespace)],
    [ischeck, expectedPlaceholder(ischeck)],
    [explicitSynthetic, `${explicitSynthetic}@users.invalid`]
  ];
  for (const [username, email] of expected) {
    const row = f.pool.users.find(candidate => candidate.username === username);
    assert.ok(row, `row ${username} must be created`);
    assert.equal(row.email, email);
    // No imported or synthetic mailbox may ever be treated as verified.
    assert.equal(row.email_verified, false);
  }
  const generated = expected.slice(0, 5).map(([, email]) => email);
  assert.equal(new Set(generated).size, 5, 'placeholders must be unique per username');
  for (const email of generated) {
    assert.match(email, /^import-[0-9a-f]{24}@users\.invalid$/);
  }

  // The success list holds only created missing/synthetic-mailbox rows, never a skip.
  assert.deepEqual(result.body.importedWithoutEmail, [
    { row: 1, username: omitted },
    { row: 2, username: blank },
    { row: 3, username: nullEmail },
    { row: 4, username: whitespace },
    { row: 5, username: ischeck },
    { row: 6, username: explicitSynthetic }
  ]);
  assert.equal(f.mails.length, 0);
});

test('username-only rows still dedupe within a batch and on repeat without touching stored accounts', async () => {
  const admin = await adminSession();
  const username = randomName('noemail-dup');

  const first = await upload(admin.cookie, JSON.stringify([
    { username, password: '' },
    { username, password: '' }
  ]));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.createdCount, 1);
  assert.equal(first.body.skippedCount, 1);
  assert.equal(first.body.skipped[0].row, 2);
  assert.equal(first.body.skipped[0].reason_code, 'duplicate_identity');
  assert.equal(first.body.skipped[0].reason, '与本次导入中的其他记录重复');
  assert.equal(first.body.skipped[0].username, username);
  assert.equal(first.body.skipped[0].email, '', 'skip details keep the raw blank source email');
  assert.deepEqual(first.body.importedWithoutEmail, [{ row: 1, username }]);

  const stored = f.pool.users.filter(row => row.username === username);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].email, expectedPlaceholder(username));

  const before = userCount();
  const repeat = await upload(admin.cookie, JSON.stringify([{ username, password: '' }]));
  assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
  assert.equal(repeat.body.createdCount, 0);
  assert.equal(repeat.body.skippedCount, 1);
  assert.equal(repeat.body.skipped[0].reason_code, 'duplicate_username');
  assert.deepEqual(repeat.body.importedWithoutEmail, [], 'a skipped repeat must not appear in the success list');
  assert.equal(userCount(), before);
  assert.equal(f.pool.users.find(row => row.username === username).email, expectedPlaceholder(username));
});

test('an imported account without an email routes to the administrator and keeps password login', async () => {
  const admin = await adminSession();

  const unbound = randomName('unbound');
  const withPassword = randomName('unboundpw');

  const imported = await upload(admin.cookie, JSON.stringify([
    { username: unbound, password: '' },
    { username: withPassword, password: SEED_PASSWORD, ischeck: 'y' }
  ]));
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.createdCount, 2);
  assert.deepEqual(imported.body.importedWithoutEmail.map(entry => entry.row), [1, 2]);

  const unboundRow = f.pool.users.find(row => row.username === unbound);
  const passwordRow = f.pool.users.find(row => row.username === withPassword);
  assert.equal(unboundRow.email, expectedPlaceholder(unbound));
  assert.equal(passwordRow.email, expectedPlaceholder(withPassword));
  assert.equal(unboundRow.email_verified, false);
  assert.equal(passwordRow.email_verified, false);

  // Stateless discovery reports only the administrator branch, with no destination or cookie.
  const discovery = await discover(unbound);
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.next, 'contact_admin');
  assert.equal(discovery.body.email_masked, undefined);
  assert.ok(!JSON.stringify(discovery.body).includes('users.invalid'), 'the internal marker is never disclosed');
  assert.equal(discovery.cookie, '');

  const mailsBefore = f.mails.length;
  const codesBefore = f.pool.emailVerificationCodes.length;
  const sessionsBefore = f.pool.sessions.length;

  // Account-bound code sending refuses, with no mail and no verification row.
  const send = await f.request('/api/email-verification/send', {
    method: 'POST',
    data: { username: unbound, purpose: 'password_reset' }
  });
  assert.equal(send.status, 400);
  assert.equal(send.body.error_key, 'auth.password.contact_admin');
  assert.equal(f.mails.length, mailsBefore);
  assert.equal(f.pool.emailVerificationCodes.length, codesBefore);

  // First-password setup refuses for the same reason and writes nothing.
  const setup = await f.request('/api/password-reset', {
    method: 'POST',
    data: { username: unbound, email_code: '123456', password: SEED_PASSWORD, confirm_password: SEED_PASSWORD }
  });
  assert.equal(setup.status, 400);
  assert.equal(setup.body.error_key, 'auth.password.contact_admin');
  assert.equal(f.mails.length, mailsBefore);
  assert.equal(f.pool.sessions.length, sessionsBefore);
  assert.equal(f.pool.users.find(row => row.username === unbound).password, '');

  // The imported password still works, but the mandatory mailbox gate now blocks
  // completion until a real address is bound: the imported placeholder is unbound.
  const login = await f.login({ username: withPassword, clearPassword: SEED_PASSWORD });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.email_gate, 'bind', 'an unbound imported account must be gated');
  assert.equal(f.pool.sessions.length, sessionsBefore, 'no session may be issued before the mailbox is bound');
});

// A realistic pasted result: many missing-mailbox successes intermixed with a handful of
// invalid and duplicate rows. The response must separate the categories by machine code.
test('a mixed pasted import separates missing-email successes from invalid-email and duplicate skips', async () => {
  const admin = await adminSession();

  // Existing accounts that two imported rows will collide with.
  const existingName = await seedAccount();
  const existingMail = await seedAccount();

  const rows = [];
  const expectedWithoutEmail = [];

  // 120 username-only rows: missing source mailbox, every one a valid success.
  for (let index = 0; index < 120; index++) {
    const username = randomName('mixed-missing');
    rows.push({ username, email: index % 2 === 0 ? '' : '   ', password: '' });
    expectedWithoutEmail.push({ row: rows.length, username });
  }

  // 6 rows with a real mailbox: normal successes, not in the missing-email list.
  for (let index = 0; index < 6; index++) {
    rows.push({ username: randomName('mixed-real'), email: randomEmail('mixed-real'), password: '' });
  }

  // 4 nonempty malformed addresses: reported, never silently replaced.
  const malformed = [];
  for (let index = 0; index < 4; index++) {
    const username = randomName('mixed-bad');
    rows.push({ username, email: `not-an-email-${index}`, password: '' });
    malformed.push({ row: rows.length, username, email: `not-an-email-${index}` });
  }

  // 3 duplicate identities: an existing username, an existing email and an in-file repeat.
  const inFile = { username: randomName('mixed-dup'), email: randomEmail('mixed-dup') };
  rows.push({ username: existingName.username, email: randomEmail('mixed-taken'), password: '' });
  const takenNameRow = rows.length;
  rows.push({ username: randomName('mixed-takenmail'), email: existingMail.email, password: '' });
  const takenMailRow = rows.length;
  rows.push({ ...inFile, password: '' });
  rows.push({ ...inFile, password: '' });
  const inFileRow = rows.length;

  const before = userCount();
  const result = await paste(admin.cookie, JSON.stringify(rows));

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.createdCount, 120 + 6 + 1);
  assert.equal(result.body.skippedCount, 4 + 3);
  assert.equal(userCount() - before, 120 + 6 + 1);

  const skipped = result.body.skipped;
  // Categories come from the machine code, in source-row order.
  assert.deepEqual(skipped.map(entry => entry.row), [...malformed.map(entry => entry.row), takenNameRow, takenMailRow, inFileRow]);
  assert.deepEqual(skipped.map(entry => entry.reason_code), [
    'invalid_email', 'invalid_email', 'invalid_email', 'invalid_email',
    'duplicate_username',
    'duplicate_email',
    'duplicate_identity'
  ]);
  const countOf = code => skipped.filter(entry => entry.reason_code === code).length;
  assert.equal(countOf('invalid_email'), 4);
  assert.equal(countOf('duplicate_username'), 1);
  assert.equal(countOf('duplicate_email'), 1);
  assert.equal(countOf('duplicate_identity'), 1);

  // The success list contains exactly the created missing-mailbox rows.
  assert.deepEqual(result.body.importedWithoutEmail, expectedWithoutEmail);
  const successRows = new Set(result.body.importedWithoutEmail.map(entry => entry.row));
  assert.ok(skipped.every(entry => !successRows.has(entry.row)), 'no skipped row may appear in the success list');
  assert.equal(new Set(result.body.importedWithoutEmail.map(entry => entry.username)).size, 120);

  // Original row/account details survive on every category.
  assert.equal(skipped[4].username, existingName.username);
  assert.equal(skipped[5].email, existingMail.email);
  assert.equal(skipped[6].username, inFile.username);
  assert.equal(skipped[6].email, inFile.email);
  assert.deepEqual(
    skipped.slice(0, 4).map(entry => ({ username: entry.username, email: entry.email })),
    malformed.map(entry => ({ username: entry.username, email: entry.email }))
  );
});

// ── acceptance 3: over-limit uploads return a clear 413 without writes ─────

test('an upload above 10MiB returns a clear 413 without creating anything', async () => {
  const admin = await adminSession();
  const before = userCount();
  const logsBefore = importAdminLogs().length;

  // Not valid JSON on purpose: the transport bound rejects it before parsing.
  const oversized = 'x'.repeat(IMPORT_MAX_BYTES + 1024);
  assert.ok(Buffer.byteLength(oversized, 'utf8') > IMPORT_MAX_BYTES);

  const result = await upload(admin.cookie, oversized);

  assert.equal(result.status, 413);
  assert.equal(result.body.error_key, 'users.import.too_large');
  assert.match(result.body.error_description, /10\s*MiB/);
  assert.equal(userCount(), before, 'an over-limit upload must not write users');
  assert.equal(importAdminLogs().length, logsBefore);
});

test('an over-limit pasted JSON body is also rejected with the import size error', async () => {
  const admin = await adminSession();
  const before = userCount();
  const oversized = 'x'.repeat(IMPORT_MAX_BYTES + 1024);

  const result = await paste(admin.cookie, oversized);

  assert.equal(result.status, 413);
  assert.equal(result.body.error_key, 'users.import.too_large');
  assert.equal(userCount(), before);
});

// ── acceptance 4: ordinary endpoints keep the 100KiB limit ─────────────────

test('other JSON endpoints keep the ordinary 100KiB limit', async () => {
  const admin = await adminSession();

  const oversized = await f.request('/api/email-verification/send', {
    method: 'POST',
    cookie: admin.cookie,
    data: { email: 'pad@example.test', purpose: 'password_reset', pad: 'x'.repeat(120 * 1024) }
  });
  assert.equal(oversized.status, 413, 'ordinary endpoints must still reject bodies above 100KiB');
  // The import-specific explanation must not leak onto unrelated routes.
  assert.notEqual(oversized.body && oversized.body.error_key, 'users.import.too_large');

  // A body comfortably under the ordinary limit is still parsed normally.
  const normal = await f.request('/api/email-verification/send', {
    method: 'POST',
    cookie: admin.cookie,
    data: { email: randomEmail('normal'), purpose: 'password_reset' }
  });
  assert.notEqual(normal.status, 413);
});

// ── acceptance 4: authorization and origin boundaries ──────────────────────

test('anonymous, non-admin and cross-origin uploads cannot import', async () => {
  // Seed every account this test needs BEFORE recording the write baseline, so
  // the fixture's own accounts can never be mistaken for an import write.
  const plainUser = await f.user();
  const plainLogin = await f.login(plainUser);
  assert.equal(plainLogin.status, 200);
  const admin = await adminSession();

  const file = JSON.stringify([{ username: randomName('deny'), email: randomEmail('deny'), password: '' }]);
  const before = userCount();

  const anonymous = await upload(undefined, file);
  assert.equal(anonymous.status, 401);
  assert.equal(userCount(), before);

  const nonAdmin = await upload(plainLogin.cookie, file);
  assert.equal(nonAdmin.status, 403);
  assert.equal(nonAdmin.body.error_key, 'auth.forbidden.admin_required');
  assert.equal(userCount(), before);

  // An all-uppercase import path does not start with the literal lowercase
  // '/api/' prefix, so only the case-insensitive import matcher can classify it
  // as a browser endpoint and enforce the same-origin boundary.
  const crossOrigin = await upload(admin.cookie, file, {
    path: '/API/USERS/IMPORT/',
    headers: { Origin: 'https://evil.example.test' }
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(userCount(), before);

  // A cross-origin pasted payload on the same matcher-only path is blocked too.
  const crossOriginPaste = await paste(admin.cookie, file, {
    path: '/API/USERS/IMPORT/',
    headers: { Origin: 'https://evil.example.test' }
  });
  assert.equal(crossOriginPaste.status, 403);
  assert.equal(userCount(), before);
});

// ── route matching: the parser skip must cover what Express actually routes ──

test('raw uploads work on the trailing-slash and case-insensitive import route', async () => {
  const admin = await adminSession();

  const rows = () => JSON.stringify([{ username: randomName('route'), email: randomEmail('route'), password: '' }]);

  const trailing = await f.request('/api/users/import/', {
    method: 'POST',
    body: rows(),
    cookie: admin.cookie,
    headers: { 'Content-Type': 'application/octet-stream' }
  });
  assert.equal(trailing.status, 200, JSON.stringify(trailing.body));
  assert.equal(trailing.body.createdCount, 1);

  const upperCase = await f.request('/api/users/IMPORT', {
    method: 'POST',
    body: rows(),
    cookie: admin.cookie,
    headers: { 'Content-Type': 'application/octet-stream' }
  });
  assert.equal(upperCase.status, 200, JSON.stringify(upperCase.body));
  assert.equal(upperCase.body.createdCount, 1);

  // No lowercase '/api/' prefix: this only routes because the matcher is
  // case-insensitive and ignores the trailing slash.
  const matcherOnly = await upload(admin.cookie, rows(), { path: '/API/USERS/IMPORT/' });
  assert.equal(matcherOnly.status, 200, JSON.stringify(matcherOnly.body));
  assert.equal(matcherOnly.body.createdCount, 1);
});

// ── the transport must match the content type it claims ────────────────────

test('a declared non-octet-stream content type is not treated as uploaded file bytes', async () => {
  const admin = await adminSession();
  const file = JSON.stringify([{ username: randomName('ct'), email: randomEmail('ct'), password: '' }]);
  const before = userCount();

  const result = await f.request('/api/users/import', {
    method: 'POST',
    body: file,
    cookie: admin.cookie,
    headers: { 'Content-Type': 'text/plain' }
  });

  // text/plain is not parsed into req.body, so nothing is imported and no 200 is returned.
  assert.notEqual(result.status, 200);
  assert.equal(userCount(), before);
});
