# Admin import: fixed record-count cap removed

The user rejected replacing the old 200-row cap with another arbitrary fixed cap (1500/2000).
Admin imports now have **no record-count cap**. The remaining bound is the import-scoped
10 MiB request/file limit, which was already in place.

## Files changed

| File | Change |
| --- | --- |
| `server.js` | removed `USER_IMPORT_MAX_ROWS` and its `users.import.too_many` rejection |

`server.js` only. No test, frontend, spec or doc edit from this worker. No new dependency,
no temporary file, no background task.

## What was removed

```diff
-const USER_IMPORT_MAX_ROWS = 200;
 const USER_IMPORT_COLUMNS = ['username', 'email', ...];

-  if (rows.length > USER_IMPORT_MAX_ROWS) {
-    return res.status(400).json({
-      error: 'invalid_request',
-      error_key: 'users.import.too_many',
-      error_description: `单次最多导入 ${USER_IMPORT_MAX_ROWS} 条记录`
-    });
-  }
```

No replacement cap of any kind. `grep USER_IMPORT_MAX_ROWS|users.import.too_many server.js` is
now empty.

## What is deliberately preserved

- 10 MiB import-only bound: `USER_IMPORT_MAX_BODY_BYTES = 10485760`, `USER_IMPORT_MAX_BODY = '10mb'`.
- The single `isUserImportRequest` matcher used for the body-parser skip, the same-origin
  boundary, the HTTP throttle and the route (POST-only, `/^\/api\/users\/import\/?$/i`).
- Direct original `File` upload as `application/octet-stream` (raw bytes → `Buffer.toString('utf8')`)
  and the legacy pasted `{ content }` JSON contract.
- Admin authorization, same-origin check, HTTP throttling.
- CSV/JSON/BOM parsing, extra-column tolerance, username/email conflict skips, within-batch
  de-duplication, per-row `{ row, username, email, reason }` details, and the
  `{ createdCount, skippedCount, created, skipped }` success shape.
- `400 users.import.invalid` / `400 users.import.empty` / `413 users.import.too_large` unchanged.

## Performance assessment for large imports (>2000 records)

The loop is sequential: per row it does 2–3 `SELECT`s, and `User.create` per created row.
`User.create` only runs bcrypt when a password is present (`password ? bcrypt.hash(pw, 12) : ''`),
so imported users without a password skip password hashing entirely.

Measured on the isolated fixture (`.artifacts/import-unbounded-probe.cjs`, this machine):

| Workload | Result | Time |
| --- | --- | --- |
| 2500 rows, no password | 200, created 2500, skipped 0, 219171 B | **607 ms** (~0.24 ms/row) |
| 25 rows, with password | 200, created 25 | **5672 ms** (~227 ms/row) |
| 300 duplicate rows | 200, created 0, skipped 300 with reasons | 44 ms |
| >10 MiB upload | 413 `users.import.too_large`, no writes | — |

The dominant cost is bcrypt (cost 12), not the row bookkeeping. Extrapolating the measured
227 ms/row, a password-bearing import scales to roughly:

| Password rows | Approx. time |
| --- | --- |
| 500 | ~1.9 min |
| 2000 | ~7.6 min |
| 2500 | ~9.5 min |

Concerns to record, without widening scope:

1. **Password-heavy imports are slow and hold one HTTP request open.** A 2500-row file with
   passwords is a ~9–10 minute response. No row cap means this is now reachable from a single
   request.
2. **Processing is not the thing that aborts; intermediaries are.** This codebase sets no
   server timeout (`app.listen` at `server.js:5277`, no `setTimeout`/`requestTimeout`
   override). Node's default `requestTimeout` is 300000 ms but applies to *receiving* the
   request body, which for a ≤10 MiB upload completes in well under a second; it does not
   bound handler processing. A reverse proxy (`nginx` `proxy_read_timeout` defaults to 60 s)
   or an impatient client would abort a long import even though the server would eventually
   finish and commit every row.
3. **Response size grows with created rows.** `created` holds full `serializeUser(user)`
   objects, so a few-hundred-thousand-row minimal file would return a multi-megabyte JSON body.
   Bounded by the 10 MiB input, but no longer by any row count.
4. **Sequential DB work scales linearly**: 2–3 queries per row. A 10 MiB file of minimal rows
   (roughly 40 bytes/row) could be on the order of 10^5 rows, i.e. on the order of 2–3×10^5
   sequential queries.

No row cap, no batching, no concurrency change, and no timeout was added, per the explicit
instruction and the ownership bound.

## Validation

| Check | Result |
| --- | --- |
| `node --check server.js` | pass |
| `npm run check:syntax` | pass (101 files) |
| `tests/user-import-upload.test.js` (p4, updated) | **15/15 pass** |
| `tests/security.test.js` + `tests/account-first-login.test.js` + `tests/admin-settings.test.js` | **59/59 pass** |
| Scratch unbounded probe (`.artifacts/import-unbounded-probe.cjs`, gitignored) | see table above |

p4's updated suite now covers the unbounded case directly: `UNBOUNDED_ROWS = 2501`,
`result.body.createdCount === 2501`, `created.length === 2501`, the pool row count rises by
2501, `error_key !== 'users.import.too_many'`, and a re-import reports every row as skipped
with per-row `row` numbers.

## Coordinator notes (outside this worker's ownership)

- `tests/user-import-upload.test.js`: p4 has already replaced the obsolete 200-row assertion;
  it now passes 15/15. No action needed.
- `.trellis/spec/backend/user-import.md`: already updated by the coordinator — §4 now reads
  “Thousands of records within 10MiB → Process the complete file; no `users.import.too_many`
  rejection”, and §6 asks for a “more than 2000 records” test. Aligned with this change.
- `tests/user-import-upload-browser.cjs` and the frontend contain no remaining advertised
  200 cap. The browser suite is p6's to run; it was not executed here (needs a browser).

Backend change is complete. `server.js` editing is paused for main integration.

## Follow-up: legacy cross-field ambiguity aborted the import

An independent checker reproduced a real importer abort. Seed two legacy accounts:

- A: `username = 'legacy-cross@example.test'`, `email = 'owner-a@example.test'`
- B: `username = 'legacy-owner-b'`, `email = 'legacy-cross@example.test'`

Importing `[{ username: 'legacy-cross@example.test', email: 'new-owner@example.test', password: '' },
{ username: 'after-conflict', email: 'after-conflict@example.test', password: '' }]`
returned **409 `request.failed`** instead of skipping row 1 and importing row 2.

### Root cause

The loop used `User.findByUsername(username)` and `User.findByUsername(email)` as duplicate
guards. `User.findByUsername` is `SELECT * FROM users WHERE username = ? OR email = ?` and
returns `null` unless exactly one row matches. With the seed above, looking up
`'legacy-cross@example.test'` matches A (by username) **and** B (by email), so it reported
“not found”, both guards passed, and `User.create` hit the unique index. The global error
handler maps `ER_DUP_ENTRY` to 409, so the whole batch aborted mid-way.

### Fix (`server.js:4615`, server.js only)

```diff
-    if (await User.findByUsername(username)) {
-      skipped.push({ row: index + 1, username, email, reason: '用户名或邮箱已存在' });
-      continue;
-    }
-    if (await User.findByUsername(email)) {
-      skipped.push({ row: index + 1, username, email, reason: '邮箱已被其他账户使用' });
-      continue;
-    }
+    const { usernameConflict, emailConflict } = await findUserConflicts({ username, email });
+    if (usernameConflict) {
+      skipped.push({ row: index + 1, username, email, reason: '用户名或邮箱已存在' });
+      continue;
+    }
+    if (emailConflict) {
+      skipped.push({ row: index + 1, username, email, reason: '邮箱已被其他账户使用' });
+      continue;
+    }
```

`findUserConflicts` (`server.js:1700`) already handles case-insensitive cross-field conflicts
with one `User.findPotentialConflicts` query (`WHERE username IN (?, ?) OR email IN (?, ?)`) and
compares both fields of every candidate, so the A/B pair is detected. It replaces both
ambiguous lookups with a single query. The original precedence (username first, then email)
and the original skip strings are unchanged.

Login is untouched: the import loop now has zero `User.findByUsername` calls, while the other
9 global call sites are unchanged, so login ambiguity behavior is not altered.

### Focused validation

Scratch probe `.artifacts/import-ambiguity-probe.cjs` (gitignored) with the exact seed above:

```
status = 200
body   = {"createdCount":1,"skippedCount":1,
          "skipped":[{"row":1,"username":"legacy-cross@example.test",
                      "email":"new-owner@example.test","reason":"用户名或邮箱已存在"}],
          "created":[{"username":"after-conflict", …}]}
email-conflict status = 200 [{"row":1,"username":"fresh-name",
                              "email":"taken-by-other@example.test","reason":"邮箱已被其他账户使用"}]
PASS: ambiguous cross-field row is skipped and import continues
```

Row 1 is now skipped with the existing reason, row 2 is still created, and the email-only
conflict branch still reports `邮箱已被其他账户使用`.

| Check | Result |
| --- | --- |
| `node --check server.js` | pass |
| `npm run check:syntax` | pass (101 files) |
| `.artifacts/import-ambiguity-probe.cjs` (exact repro seed) | **PASS** |
| `tests/user-import-upload.test.js` | 15/15 pass |
| `tests/security.test.js` + `tests/account-first-login.test.js` + `tests/admin-settings.test.js` | 59/59 pass |
| `.artifacts/import-unbounded-probe.cjs` (2500 rows / duplicates / 413) | unchanged, pass |
| `.artifacts/import-upload-check.cjs` | 9/9 pass |

**Handoff:** p4 adds the regression test for this seed scenario. `server.js` editing remains
paused for main integration. No other worker's files were touched.