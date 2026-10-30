# User Import Upload — API test implementation

Owner: `trellis-implement` (Pi p4 — new `tests/user-import-upload.test.js`, import memory-DB adapter only if required).
Task: `.trellis/tasks/10-23-account-first-login`. Date: 2026-10-23.

## Files changed (my ownership only)

| File | Change |
| --- | --- |
| `tests/user-import-upload.test.js` | New. 13 API tests for the import transport correction. |
| `tests/support/memory-db.js` | **No change this round.** The existing users insert, `findByUsername`, and `login_logs` branches already cover the import route, so no adapter edit was needed. The only diff in this file remains the earlier account-first first-password branch (43 lines), untouched here. |
| `tests/support/fixture.js` | **Not modified.** Raw bodies are sent through the existing `request()` `...options` spread plus an explicit `Content-Type` header. |

No product code, browser tests, or spec files were edited. All accounts created by these tests use
an empty password, so the real bcrypt cost is never paid.

## Isolated reproduction of the reported bug

Acceptance 1 needs a genuine file that is itself under the ordinary limit but whose legacy wrapper is
over it. The fixture file is built to exactly `97 * 1024` bytes across `200` rows (the row-limit
boundary), padded with ignored columns:

```
file bytes         = 99328   (97.0 KiB)   <- real ~97KiB file
legacy wrapper     = 106542  (104.0 KiB)  <- JSON.stringify({ content })
ordinary limit     = 102400
wrapper over limit = 4142 bytes
rows in file       = 200
```

The extra ignored columns add unescaped quotes, so re-escaping the file inside `{ content }` grows it
past 100 KiB. Both measured facts are asserted in the test, so it fails if the fixture stops
reproducing the report (`> 95KiB`, `< 100KiB`, wrapper `> 100KiB`).

## Coverage (13 tests)

Acceptance 1 — real 97 KiB file via raw bytes
1. `~97KiB JSON file imports through raw uploaded bytes while the legacy wrapper alone would exceed 100KiB` —
   asserts file size, wrapper size, `createdCount === 200`, `skippedCount === 0`, 200 real rows in the
   DB with the unset-password marker, and one `import_users` admin log.
2. `import-only bound accepts a raw file above the ordinary 100KiB JSON limit` — 20 rows × ~7 KB = >100 KiB
   raw file still imports (the raw path's limit is raised, not just the JSON path).

Acceptance 5 — legacy pasted contract
3. `legacy pasted JSON contract still imports, including content above the ordinary limit` — `{ content }`
   wrapper over 100 KiB imports, proving the route-level JSON parser raised the bound for import only.
4. `empty or malformed import is rejected with the existing import errors` — whitespace → `users.import.invalid`;
   `[]` → `users.import.empty`; truncated JSON → `users.import.invalid`; `{ rows: [] }` → `users.import.invalid`.

Acceptance 2 — CSV/BOM, duplicates, per-row reasons
5. `BOM-prefixed CSV file imports and reports duplicate rows with per-row reasons` — UTF-8 BOM stripped,
   header detected, 1 created + 5 skipped; asserts the exact reasons
   (`与本次导入中的其他记录重复`, `用户名或邮箱已存在`, `邮箱已被其他账户使用`, `邮箱缺失或格式无效` ×2)
   and the exact input row numbers `[2,3,4,5,6]`, plus the reported username/email for rejected rows.
6. `JSON file skips rows that collide with existing usernames and emails` — email conflict resolves through
   the email lookup (`邮箱已被其他账户使用`), username conflict through the username lookup
   (`用户名或邮箱已存在`); row numbers `[2,3,4]`.

Acceptance 2/5 — the 200-row bound
7. `200-row bound is preserved and one extra row is rejected without writes` — 201 rows → 400
   `users.import.too_many`, no users created, no admin log. (The 200-row allowed boundary is covered by
   test 1.)

Acceptance 3 — over-limit returns 413 without writes
8. `upload above 10MiB returns a clear 413 without creating anything` — `10 MiB + 1 KiB` raw body → 413
   `users.import.too_large`, description mentions `10 MiB`, no users, no admin log.
9. `over-limit pasted JSON body is also rejected with the import size error` — same for the `{ content }` path.

Acceptance 4 — other endpoints keep 100 KiB
10. `other JSON endpoints keep the ordinary 100KiB limit` — 120 KiB JSON to `/api/email-verification/send`
    → 413, and the import-specific `error_key` does not leak; a normal small body is not 413.

Acceptance 4 — authorization and origin boundaries
11. `anonymous, non-admin and cross-origin uploads cannot import` — accounts are seeded **before** the write
    baseline; anonymous → 401, non-admin → 403 `auth.forbidden.admin_required`, cross-origin → 403
    (raw and pasted). Every case asserts the user count is unchanged, so a rejected request cannot write.
    The cross-origin paths use `/API/USERS/IMPORT/`, which does **not** start with the literal `/api/`
    prefix and therefore isolates the new case-insensitive import matcher.

Route matching
12. `raw uploads work on the trailing-slash and case-insensitive import route` — `/api/users/import/`,
    `/api/users/IMPORT`, and `/API/USERS/IMPORT/` each import (the last one only matches because the
    matcher is case-insensitive and strips the trailing slash).

Content-type honesty
13. `a declared non-octet-stream content type is not treated as uploaded file bytes` — `text/plain` body is
    not parsed into `req.body`, so nothing imports and no 200 is returned.

## The case-insensitive-matcher regression (reviewer follow-up)

The first draft used `/api/users/IMPORT` for the cross-origin case. That path still satisfies the older
`req.path.startsWith('/api/')` clause, so `browserEndpoint` was already true and the test could pass even
if `isUserImportRequest` were case-sensitive. Fixed by using `/API/USERS/IMPORT/`:

```
path                       = /API/USERS/IMPORT/
startsWith('/api/')        = false        <- old clause cannot catch it
isUserImportRequest result = /api/users/import   <- only the new matcher classifies it
```

Same path, same valid admin cookie, only `Origin` differs:
- same-origin → 200 (test 12)
- cross-origin → 403, no writes (test 11)

Without the case-insensitive matcher the cross-origin request would reach the importer, so the pair is
discriminating rather than vacuous.

## Commands and results

```powershell
node --check tests/user-import-upload.test.js
# syntax ok

node --test tests/user-import-upload.test.js
# tests 13 | pass 13 | fail 0
```

Per the review instruction, only the new API test was run this round; the full suite is owned by the main
session (it reported `check:e2e` 238/238 and the browser group green before this change, and `check:e2e`
auto-discovers `tests/*.test.js`, so this file is included in its next run).

## Notes for the coordinator

1. `check:e2e` (`scripts/check-e2e.js`) automatically includes `tests/user-import-upload.test.js`, so no
   package-script edit is needed for the API test.
2. `check:browser` already lists `tests/user-import-upload-browser.cjs` (owner Pi p6); that browser file
   exists but its run is outside this worker's scope.
3. No memory-DB adapter change was required for the import work; the earlier 43-line account-first branch
   in `tests/support/memory-db.js` is unchanged and still owned by the earlier sub-feature.
4. Unresolved: none for the API layer. All 13 tests pass against the landed backend.