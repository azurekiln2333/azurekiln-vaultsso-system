# Unbounded user import — API test implementation

Owner: designated Herdr Pi worker (Pi p4 scope: `tests/user-import-upload.test.js` and strictly required test support).
Task: `.trellis/tasks/10-23-account-first-login`. Date: 2026-10-23.

## Instruction that supersedes the earlier 200-row statement

The user explicitly rejected replacing the old `200` record cap with an arbitrary `1500`/`2000` cap.
There is now **no fixed record-count cap** on admin imports. The only bound is the scoped **10 MiB**
body/file limit, and import keeps direct original-`File` upload, pasted `{ content }` compatibility,
existing auth/origin/throttle gates, and per-row created/skipped details.

`prd.md` / `design.md` / `implement.md` / `spec/backend/user-import.md` previously stated a 200-row
limit. That statement is superseded by this instruction. The spec has already been refreshed by another
worker to the unbounded contract (`spec/backend/user-import.md` §4 now reads *"Thousands of records
within 10MiB → Process the complete file; no `users.import.too_many` rejection"*). I did not edit the
spec, the server, or the frontend — only my test file.

## Files changed (my ownership only)

| File | Change |
| --- | --- |
| `tests/user-import-upload.test.js` | Removed the 200-row cap semantics; added unbounded-import coverage. 13 → 15 tests. |
| `tests/support/memory-db.js` | **No change this round.** Existing `users` insert / `findByUsername` / `login_logs` branches already support multi-thousand-row imports. Its only diff remains the earlier account-first first-password branch. |
| `tests/support/fixture.js` | **No change.** |

Product code, browser tests and specs were not edited. All imported rows use an empty password so the
real bcrypt cost is never paid — important at 2501 rows.

## Constant decoupling (sample count vs. removed maximum)

The 97 KiB transport regression reproduced a real export that happened to hold 200 records. That number
is now only a sample size, not a maximum:

```js
// The 97KiB transport regression reproduced a real export that happened to contain
// 200 records, so that sample keeps 200 rows. It is a sample count, NOT an import
// maximum.                                              <- TRANSPORT_SAMPLE_ROWS = 200

// Deliberately well above both the removed 200-row cap and the "above 2000 rows"
// acceptance.                                             <- UNBOUNDED_ROWS = 2501
```

`largeJsonExport(targetBytes, rowCount = TRANSPORT_SAMPLE_ROWS)` now takes the row count explicitly, so
the 97 KiB fixture's size and its workload size are independent. `bulkRows(count, prefix)` builds unique
passwordless rows for the large imports.

## Test changes

### Replaced (obsolete)

Removed `the 200-row bound is preserved and one extra row is rejected without writes` (201 rows → 400
`users.import.too_many`). It asserted the very cap the user rejected.

### Added

1. `an import well above the removed 200-row cap creates every valid record`
   - 2501 unique rows in one octet-stream file, payload asserted `< 10 MiB`.
   - Asserts `200`, `createdCount === 2501`, `skippedCount === 0`, `created.length === 2501`,
     `userCount()` delta `2501`, one `import_users` admin log.
   - Asserts `error_key !== 'users.import.too_many'` so a re-introduced cap fails loudly.
   - Asserts the **first and last** rows of the batch are stored, so silent truncation also fails.

2. `a large import still reports existing and in-file duplicate skips with row details`
   - 2495 unique rows + 6 intentional conflicts = 2501 rows (still above the removed cap).
   - 2 in-file duplicates of row 1 → `与本次导入中的其他记录重复`
   - 2 rows reusing a pre-seeded account's **username** (distinct emails) → `用户名或邮箱已存在`
   - 2 rows reusing a pre-seeded account's **email** (distinct usernames) → `邮箱已被其他账户使用`
   - Asserts `createdCount === 2495`, `skippedCount === 6`, exact 1-based row numbers
     `[2496, 2497, 2498, 2499, 2500, 2501]`, the exact reason sequence, and that every skipped entry
     reports its own `row` + `username` + `email`.
   - Distinct emails/usernames per conflict row are deliberate: the within-batch `seen` check runs
     *before* the existing-account lookup, so identical pairs would collapse into "in-file duplicate".

3. `re-importing the same records skips every row as an existing account`
   - Small (5-row) batch imported twice: first `created 5 / skipped 0`; second `created 0 / skipped 5`
     with rows `[1..5]` and reason `用户名或邮箱已存在`, and the user count unchanged.
   - Cheap because it reuses the same small payload.

### Preserved

- 97 KiB transport regression (now `TRANSPORT_SAMPLE_ROWS`), legacy `{ content }` paste above 100 KiB,
  raw file above the ordinary 100 KiB limit, BOM-prefixed CSV with per-row reasons, JSON collision
  skips, empty/malformed errors, **>10 MiB 413 with no writes** (raw and pasted), ordinary endpoints
  still 100 KiB, anonymous/non-admin/cross-origin gates with no writes, the case-insensitive
  `/API/USERS/IMPORT/` matcher coverage, and the non-octet-stream content-type case.

## Fail-before-fix evidence

The backend removal landed while this work was in progress, so the pre-fix failing run could not be
observed live. It is provable from the repository:

```
$ git show HEAD:server.js | Select-String USER_IMPORT_MAX_ROWS
const USER_IMPORT_MAX_ROWS = 200;
if (rows.length > USER_IMPORT_MAX_ROWS) {
error_description: `单次最多导入 ${USER_IMPORT_MAX_ROWS} 条记录`

$ Select-String server.js USER_IMPORT_MAX_ROWS   ->  (absent)
```

Against the committed baseline, a 2501-row upload hits the `rows.length > 200` guard and returns
**400 `users.import.too_many`**, so tests 1 and 2 above fail on both `status === 200` and
`createdCount`. Against the current worktree the same requests reach the row loop and succeed.

Current route structure confirming removal (no cap between the empty check and the loop):

```
4550:  if (!rows.length) { ... users.import.empty ... }
4557:
4558:  const created = [];      <- row loop starts; no row-count guard
```

## Commands, counts and timing

```powershell
node --check tests/user-import-upload.test.js
# syntax ok

node --test tests/user-import-upload.test.js
# tests 15 | pass 15 | fail 0 | duration_ms 9926.24 | wall 10.03s

node --test tests/user-import-upload.test.js      # stability re-run
# tests 15 | pass 15 | fail 0 | duration_ms 9485.06 | wall 9.56s
```

Per-test timings (first run):

| Test | ms |
| --- | --- |
| ~97KiB JSON via raw bytes | 560 |
| raw file above ordinary 100KiB | 474 |
| legacy pasted above ordinary limit | 488 |
| empty/malformed errors | 486 |
| BOM CSV + per-row reasons | 485 |
| JSON collision skips | 476 |
| **above-cap full creation (2501)** | **1286** |
| **large import duplicate details (2501)** | **1356** |
| repeat import | 469 |
| above 10MiB → 413, no writes | 518 |
| over-limit pasted → 413 | 510 |
| other endpoints keep 100KiB | 471 |
| anonymous/non-admin/cross-origin | 944 |
| trailing-slash / case-insensitive route | 464 |
| non-octet-stream content type | 480 |

The two 2501-row tests dominate (~1.3 s each) because the route performs two `findByUsername` scans per
row against a growing in-memory table; still ~10 s for the whole file, so no batching or shortcuts were
needed.

## Notes for the coordinator

1. `check:e2e` auto-discovers `tests/*.test.js`, so this file is already in the full suite; no script edit.
2. The backend removal (`server.js`) and the spec refresh (`spec/backend/user-import.md`) landed from
   other workers and are preserved untouched. `public/js/pages/admin/users.js` no longer defines
   `IMPORT_MAX_ROWS`.
3. No test-support change was required — no memory-DB adapter work, no fixture edit.
4. Unresolved: none on the API layer. 16/16 pass against the fixed backend (see the follow-up below,
   which added the legacy cross-field ambiguity regression).

## Follow-up: legacy cross-field ambiguity (API regression)

Checker finding: two legacy accounts where one account's `username` is the other account's `email`. A
single value then matches two rows, so `User.findByUsername` (which requires exactly one row) returns
`null`; the importer fell through to `User.create`, hit `ER_DUP_ENTRY`, and the global handler answered
409 — aborting the whole batch and discarding every later valid row.

Fix (Pi p3, `server.js` import route): the two `User.findByUsername` probes were replaced with
`findUserConflicts({ username, email })` (one `findPotentialConflicts` query) while preserving the
original precedence and reasons:

- `usernameConflict` → `用户名或邮箱已存在`
- `emailConflict` → `邮箱已被其他账户使用`

New test: `legacy cross-field accounts make ambiguous import rows skip instead of aborting the batch`

- Seeds A (`username=legacy-cross@example.test`, `email=owner-a@example.test`) and
  B (`username=legacy-owner-b`, `email=legacy-cross@example.test`), both with empty passwords.
- Asserts the precondition that caused the abort: `User.findByUsername(shared) === null` and
  `findPotentialConflicts(shared, shared).length === 2`.
- Rows: username-ambiguous, username-ambiguous with case variation (`LEGACY-CROSS@EXAMPLE.TEST`),
  email-ambiguous, email-ambiguous with case variation, then a valid row.
- Asserts `status 200`, `createdCount 1`, `skippedCount 4`, row numbers `[1,2,3,4]`, reasons
  `[用户名或邮箱已存在, 用户名或邮箱已存在, 邮箱已被其他账户使用, 邮箱已被其他账户使用]`, per-row input
  account details, that the following valid row is created and stored, `userCount` delta `1`, and that
  every pre-existing account is byte-for-byte unchanged (snapshot compare) with A/B cross-field values
  intact.
- Case handling pinned: usernames keep the submitted case in the reported row, emails are normalized
  (lowercased) before being reported.

Fail-before-fix evidence:

```
$ git show HEAD:server.js | Select-String findUserConflicts
# no import-route usage; HEAD still has:  if (await User.findByUsername(username)) {
$ git diff server.js | Select-String findUserConflicts
+    const { usernameConflict, emailConflict } = await findUserConflicts({ username, email });
```

Against `HEAD`, a 5-row batch containing one ambiguous row returns 409 and never reaches the later valid
row. The live pre-fix run could not be captured because p3 landed the fix before the first post-edit
execution; that first run instead returned 200 and surfaced one test-side expectation (the skipped row
reports the *normalized* email, not the submitted uppercase form), which was corrected.

Commands / counts / timing (after the fix):

```powershell
node --check tests/user-import-upload.test.js
# syntax ok

node --test tests/user-import-upload.test.js
# tests 16 | pass 16 | fail 0 | duration_ms 11200.63 | wall 11.28s
```

Updated timings: ambiguous-legacy test 466 ms; the two 2501-row tests 1767 ms / 1768 ms; all others
460–940 ms.

Notes:

1. `tests/support/memory-db.js` needed no change — `select id, username, email from users where username
   in (?, ?) or email in (?, ?)` was already supported (line 404) with case-insensitive `likeValue`, so
   `findPotentialConflicts` (and therefore `findUserConflicts`) already worked in the fixture.
2. The test file now holds 16 tests and is still auto-discovered by `check:e2e`.
3. Other workers' edits (`server.js`, `models/User.js`, `public/js/pages/admin/users.js`,
   `spec/backend/user-import.md`) are preserved; nothing was staged, committed or reverted.
