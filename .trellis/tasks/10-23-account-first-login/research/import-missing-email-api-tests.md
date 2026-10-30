# Import: optional email + structured result categories — API tests

Owner: designated Herdr Pi worker (Pi p4 scope: `tests/user-import-upload.test.js`).
Task: `.trellis/tasks/10-23-account-first-login`. Date: 2026-10-24.

## Requirement this round

Two user corrections landed together:

1. **A missing email must not block an import when a username exists.** Username-only records import
   and, because of the original agreed passwordless/no-mailbox login contract, must then report
   **联系管理员重置** instead of pretending a mailbox exists.
2. **The real pasted result intermixes hundreds of missing/invalid-email rows with only ~4 duplicates.**
   The response must separate the categories by machine-readable code with counts and original
   row/account, because missing-email imports are now **successes, not errors**.

Both are backward compatible: `createdCount` / `skippedCount` / `created` / `skipped` are unchanged, all
human `reason` strings are kept, and `reason_code` + `importedWithoutEmail` are additive.

## Files changed (my ownership only)

| File | Change |
| --- | --- |
| `tests/user-import-upload.test.js` | Updated the obsolete missing-email rejection assertions; added optional-email, structured-category and mixed-result coverage. 16 → 20 tests. |
| `tests/account-first-login.test.js` | **Not modified** — no change was genuinely needed; it already proves `@users.invalid` → `contact_admin`. Re-run to confirm the shared convention still holds. |
| `tests/support/memory-db.js` / `fixture.js` | **Not modified.** Existing `findPotentialConflicts`, users insert and `login_logs` branches already support everything. |

No product code was edited. All mass fixtures use empty passwords so bcrypt is never paid.

## Contract as implemented (verified against `server.js`)

```
server.js:4581  emailIsAbsent      = omitted | null | (string && trim() === '')
server.js:4583  emailSourceInvalid = !absent && (not a string || !isValidEmail(email))
server.js:4586  emailSourceInvalid            -> skip { reason_code: 'invalid_email', reason: '邮箱格式无效' }
server.js:4590  !username                     -> skip { reason_code: 'missing_username', reason: '缺少用户名' }
server.js:4598  storedEmail = email || `import-${sha256(username.toLowerCase()).slice(0,24)}@users.invalid`
server.js:4600  emailVerified = ischeckTruthy && !isSyntheticEmail(storedEmail)
server.js:4605  sourceMailboxUnusable = emailIsAbsent || isSyntheticEmail(email)
server.js:4663  if (sourceMailboxUnusable) importedWithoutEmail.push({ row, username })   // after create only
server.js:4670  res.json({ createdCount, skippedCount, importedWithoutEmail, created, skipped })
```

Reason codes confirmed present and 1:1 with the human reasons:
`duplicate_identity`, `duplicate_username`, `duplicate_email`, `duplicate_external_identity`,
`invalid_email`, `missing_username`, `invalid_password`, `invalid_description`, `invalid_credits`.

`importedWithoutEmail` is pushed only after `User.create` succeeds, so a skipped row can never appear in
it. Skip details keep the **raw source** `username`/`email`, never the internal placeholder.

## Test changes

### Corrected obsolete assertions

- `a BOM-prefixed CSV file imports and reports per-row reasons` (was `...reports duplicate rows...`):
  the blank-email row is now **created**, not rejected, and `邮箱缺失或格式无效` is gone in favour of
  `邮箱格式无效` for the genuinely malformed value. Now asserts `createdCount 2`, `skippedCount 4`,
  the four `reason_code`s (`duplicate_identity`, `duplicate_username`, `duplicate_email`,
  `invalid_email`), and that the blank-email row appears in `importedWithoutEmail` as `{row: 6, username}`.

### New tests

1. `username-only imports store unique unbound placeholders that are never verified`
   - One row each for **omitted**, `''`, `null`, `'   '`, blank + `ischeck:'y'`, and an explicit
     `@users.invalid` input + `ischeck:'y'` → all 6 created.
   - `{ username:'', email:'' }` → `missing_username`; `not-an-email` → `invalid_email`, with the raw
     source email preserved in the skip detail.
   - Asserts deterministic placeholders (`import-[0-9a-f]{24}@users.invalid`), **unique per username**,
     the explicit synthetic input kept as-is, and `email_verified === false` for every one of them
     including the `ischeck:'y'` rows.
   - Asserts `importedWithoutEmail` is exactly the 6 created rows in source order and that no mail is sent.

2. `username-only rows still dedupe within a batch and on repeat without touching stored accounts`
   - In-file duplicate → `duplicate_identity` at row 2, raw blank email preserved, success list holds
     only row 1.
   - Repeat import → `duplicate_username`, `importedWithoutEmail: []`, user count unchanged, placeholder
     unchanged (no rewrite).

3. `an imported account without an email routes to the administrator and keeps password login`
   - Imports one passwordless and one password-bearing account, both without email; both store
     placeholders and stay unverified.
   - Unauthenticated `discover_account` → `next: 'contact_admin'`, no `email_masked`, no cookie, and the
     internal marker is never disclosed.
   - Account-bound send → `400 auth.password.contact_admin` with zero mail and zero verification rows.
   - First-password setup → `400 auth.password.contact_admin`, zero mail, no new session, password still `''`.
   - The password-bearing imported account then logs in normally (`200` + session cookie).

4. `a mixed pasted import separates missing-email successes from invalid-email and duplicate skips`
   - The realistic shape: **120** username-only rows (half blank, half whitespace) + **6** real-mailbox
     rows + **4** malformed addresses + **3** duplicates (existing username, existing email, in-file
     repeat) = 133 rows, submitted through the **pasted** `{ content }` contract.
   - `createdCount 127`, `skippedCount 7`; skip rows and `reason_code`s asserted in source order:
     `invalid_email` ×4, then `duplicate_username`, `duplicate_email`, `duplicate_identity`.
   - Per-category counts asserted explicitly, so the UI's four groups are meaningful.
   - `importedWithoutEmail` equals exactly the 120 created missing-mailbox rows; asserts the skipped rows
     are **disjoint** from the success list and that 120 distinct usernames are reported.
   - Raw row/account details asserted for every category.

### Mass coverage

`an import well above the removed 200-row cap creates every valid record` now deletes the email from
every third row (834 of 2501). It still asserts `createdCount 2501` / `skippedCount 0`, and adds:
`importedWithoutEmail.length === 834` in source order, 834 distinct `import-[0-9a-f]{24}@users.invalid`
placeholders. So missing emails are proven not to reduce the accepted record count at scale.

### Preserved

97 KiB transport regression, raw file >100 KiB, legacy paste >100 KiB, empty/malformed errors, JSON
collision skips, the legacy cross-field ambiguity regression, `reason_code` on the large duplicate-detail
and repeat-import tests, >10 MiB 413 with no writes (raw + pasted), ordinary endpoints still 100 KiB,
anonymous/non-admin/cross-origin gates, `/API/USERS/IMPORT/` matcher coverage, non-octet-stream case.

## Fail-before-fix evidence

```
$ git show HEAD:server.js | Select-String importedWithoutEmail   ->  (none)
$ git show HEAD:server.js | Select-String reason_code            ->  (none)
$ git show HEAD:server.js | Select-String 邮箱缺失或格式无效
skipped.push({ row: index + 1, username, email, reason: '邮箱缺失或格式无效' });

$ git diff server.js
+  skipped.push({ ..., reason_code: 'invalid_email', reason: '邮箱格式无效' });
+  const sourceMailboxUnusable = emailIsAbsent || isSyntheticEmail(email);
+  if (sourceMailboxUnusable) importedWithoutEmail.push({ row: index + 1, username });
```

Against `HEAD`, blank-email rows are rejected (so `createdCount`/`skippedCount` differ), `reason_code`
is `undefined`, and `importedWithoutEmail` does not exist — every new test fails. (The live failing run
was again not capturable: p3 landed the importer changes before my first execution.)

## Commands, counts and timing

```powershell
node --check tests/user-import-upload.test.js
# syntax ok

node --test tests/user-import-upload.test.js
# tests 20 | pass 20 | fail 0 | duration_ms 13342.26 | wall 13.43s

node --test tests/user-import-upload.test.js tests/account-first-login.test.js
# tests 43 | pass 43 | fail 0 | duration_ms 13943.88 | wall 14.04s
```

Per-test timings (import file):

| Test | ms |
| --- | --- |
| ~97KiB JSON via raw bytes | 557 |
| raw file above ordinary 100KiB | 475 |
| legacy pasted above ordinary limit | 483 |
| empty/malformed errors | 471 |
| BOM CSV + blank email + reasons | 454 |
| JSON collision skips | 460 |
| legacy cross-field ambiguity | 468 |
| above-cap full creation (2501, 834 no-email) | 1754 |
| large import duplicate details | 1729 |
| repeat import | 466 |
| **username-only placeholders** | **461** |
| **no-email dedupe + repeat** | **470** |
| **import → contact_admin + password login** | **922** |
| **mixed pasted categories** | **465** |
| above 10MiB → 413 | 493 |
| over-limit pasted → 413 | 499 |
| other endpoints keep 100KiB | 471 |
| anonymous/non-admin/cross-origin | 917 |
| route matching / case-insensitivity | 457 |
| non-octet-stream content type | 462 |

The single 922 ms outlier is the bcrypt hash for the one password-bearing imported account; every mass
fixture uses empty passwords.

## Integration note

`public/js/pages/admin/users.js` (Pi p5) now groups with exactly the codes these tests pin:
`IMPORT_DUPLICATE_REASON_CODES = ['duplicate_identity','duplicate_username','duplicate_email','duplicate_external_identity']`,
`IMPORT_INVALID_EMAIL_REASON_CODES = ['invalid_email']`, and renders `importedWithoutEmail` as
`无邮箱但导入成功（共 N 条）` before `重复账号跳过` / `邮箱格式错误` / `其他错误`. So the API contract and
the UI grouping agree.

## Coordinator notes

1. `check:e2e` auto-discovers `tests/*.test.js`; no package-script edit needed.
2. No test-support change was required this round.
3. Other workers' edits (`server.js`, `public/js/pages/admin/users.js`, `views/admin/users.html`,
   `spec/backend/user-import.md`) are preserved; nothing staged, committed or reverted.
4. Unresolved: none on the API layer. 20/20 import tests and 23/23 account-first tests pass.
