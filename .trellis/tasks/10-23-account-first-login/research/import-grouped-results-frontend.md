# Grouped Import Results (frontend)

> Coordinator correction (2026-10-24): the report's backend-dependency claim that a 200-row cap remains is stale. There is no fixed record-count cap in the current backend/UI. The complete optional-mailbox/grouped-result correction passed 245 API tests, eight browser groups and real 2501-row file/reimport checks; see validation.md.

Owner: Pi (auth-frontend). Scope: `public/js/pages/admin/users.js` and the import region + JS cache
version of `views/admin/users.html`. No backend, test or spec edits; other workers' edits preserved;
nothing staged, reverted or committed.

## Problem

A real pasted import returned hundreds of missing/invalid-email entries intermixed with only 4
duplicates, all in one undifferentiated list. Missing-email rows are now **successes**, not errors, so a
single mixed list both buries the few duplicates and misrepresents successful imports as failures.

## Changes

### `public/js/pages/admin/users.js`

Result rendering moved from one mixed list into category sections driven by the machine-readable
`reason_code`:

- `IMPORT_DUPLICATE_REASON_CODES` = `duplicate_identity`, `duplicate_username`, `duplicate_email`,
  `duplicate_external_identity` → **重复账号跳过** (warning note).
- `IMPORT_INVALID_EMAIL_REASON_CODES` = `invalid_email` → **邮箱格式错误** (error note).
- every other code (`missing_username`, `invalid_password`, `invalid_description`, `invalid_credits`, and
  any future/unknown code) → **其他错误** (error note). Nothing is inferred from human text when a
  `reason_code` exists.
- `result.importedWithoutEmail` → **无邮箱但导入成功** (warning note), rendered from `{ row, username }`
  only; skipped rows are never listed here.

Each non-empty category renders its own `label（共 N 条）：` heading plus all rows in a separate bounded,
independently scrollable list (`overflow-y-auto`, `max-height: 30vh`). The old single mixed list is gone
in the coded path, so hundreds of rows can never intermix with the duplicate handful. The existing
summary line is retained unchanged:
`成功导入 N 个用户，跳过 M 条记录。`

- **Escaping**: row number, account and reason all pass through `escapeHtml`.
- **Raw source identity**: `importEntryAccount()` prefers the raw `username`, then a real `email`;
  `isSyntheticMailbox()` (`/@users\.invalid$/i`) suppresses any internal placeholder, so an internal
  synthetic mailbox is never displayed.
- **Backward compatible with old servers**: if no skipped entry carries a string `reason_code`, the
  renderer falls back to exactly the previous single `跳过明细（共 N 条）：` list with human reasons and
  invents no categories. A partial mix (some entries coded, some not) puts the uncoded ones in
  **其他错误** with their human reason.
- Grouping lives in pure helpers (`importResultSections`, `importRowsList`, `importEntryAccount`,
  `isSyntheticMailbox`) so the section logic is testable without DOM.

### Preserved from prior rounds

Optional-email import help (`email 可留空`, contact-administrator login note), admin list
`未绑定邮箱` / `未绑定` status display and filter consistency, no fixed row cap, direct original `File`
upload (`application/octet-stream`, no `FileReader`), pasted `application/json` `{ content }`, 10 MiB
byte preflight, file⇄paste source switching, retry preserving the source, `scrollIntoView` on completion
or failure, and the other worker's admin styling edits (both stylesheets still
`?v=20261021-admin-flat-1`).

### `views/admin/users.html`

- JS cache version: `?v=20261024-import-optional-email-1` → `?v=20261024-import-grouped-results-1`
  → `?v=20261024-import-grouped-results-2` (the second bump covers the `renderImportLimits` copy fix below).

### Dynamic vs. static import-limit copy (reviewer follow-up)

`renderImportLimits()` previously overwrote the `#importLimits` fallback with duplicate-only text
(`文件最大 10 MiB；用户名或邮箱重复的记录会被跳过并列出原因。`), so the rendered hint silently dropped the
optional-mailbox guidance every time the page script ran. Both sources now render the identical string:

> 文件最大 10 MiB；email 可留空（需填写 username），无邮箱且无密码的账户登录时会提示联系管理员重置密码；用户名或邮箱重复的记录会被跳过并列出原因。

- The dynamic copy is built as
  `文件最大 ${formatBytes(IMPORT_MAX_BYTES)}；email 可留空（需填写 username），无邮箱且无密码的账户登录时会提示联系管理员重置密码；用户名或邮箱重复的记录会被跳过并列出原因。`
  (`formatBytes(IMPORT_MAX_BYTES)` resolves to `10 MiB`, so the two are byte-identical).
- Both carry the email-optional/username-required rule, the no-email + no-password contact-administrator
  path, the 10 MiB byte bound and the duplicate-skip note; the old duplicate-only string is gone.

### Grouped labels aligned with the browser worker

The section labels and order match `tests/user-import-upload-browser.cjs` exactly:
无邮箱但导入成功 → 重复账号跳过 → 邮箱格式错误 → 其他错误, each rendered as `${label}（共 N 条）` so the
worker's `groupPattern(label, count)` (`${label}（共\s*${count}\s*条）`) matches, and empty groups are
omitted (so `无邮箱但导入成功` is absent when nothing was imported without a mailbox).

## Contract Consumed (additive, backward compatible)

Response of `POST /api/users/import`:

- Unchanged and still required: `createdCount`, `skippedCount`, `created`, `skipped`.
- `skipped[]` entries keep all human fields (`row`, `username`, `email`, `reason`) **and add**
  `reason_code` ∈ `duplicate_identity` | `duplicate_username` | `duplicate_email` |
  `duplicate_external_identity` | `invalid_email` | `missing_username` | `invalid_password` |
  `invalid_description` | `invalid_credits` as appropriate. Human `reason` strings are kept as-is.
- New `importedWithoutEmail: [{ row, username }]` lists **successfully created** rows whose source
  mailbox was missing or synthetic. It must never contain skipped rows.
- Frontend treats `reason_code` as authoritative when present; it never reclassifies from `reason` text.

## Backend Dependencies (p3, not my ownership)

1. Emit `reason_code` on every skipped entry from the taxonomy above, without removing or rewriting the
   existing human `reason` strings.
2. Populate `importedWithoutEmail` for created rows whose source email was blank/omitted/`null`/
   whitespace or an existing synthetic `@users.invalid` value — created rows only.
3. Keep `createdCount`/`skippedCount`/`created`/`skipped` unchanged so old clients and the summary line
   keep working.
4. Keep the source-level distinction between a **missing** mailbox (now a success) and a **malformed**
   mailbox (`invalid_email`, still a skip) — the frontend renders them in different sections and relies
   on the server to choose.
5. Still outstanding from earlier rounds: `server.js:4444` `USER_IMPORT_MAX_ROWS = 200` and the rejection
   at `:4558` remain, so >200-row imports still fail with 400 `users.import.too_many`; the user's
   decision removes that cap. `.trellis/spec/backend/user-import.md` §2/§4 and the row-bound case in
   `tests/user-import-upload.test.js` also still assert it.

## Verification

- `node --check public/js/pages/admin/users.js` → OK.
- `npm run check:syntax` → "Syntax and browser script references checked: 101 files".
- **Grouping logic exercised against the real source**: the helper section was sliced from
  `public/js/pages/admin/users.js` and evaluated (throwaway script outside the repo, since removed) with
  the reported scenario — 400 `invalid_email` + 4 duplicates across all four duplicate codes + 1
  `missing_username` + 2 `importedWithoutEmail`:
  - all four section labels present; counts `无邮箱但导入成功=2`, `重复账号跳过=4`, `邮箱格式错误=400`,
    `其他错误=1`;
  - legacy mixed list absent; 4 bounded scroll lists; output HTML escaped;
  - `missing_username` shown under 其他错误; duplicate and no-email rows all listed;
  - old-server response without `reason_code` → single `跳过明细（共 2 条）` list, no invented categories;
  - synthetic `@users.invalid` address never rendered; empty result → no sections.
- **Import-limit copy check**: `renderImportLimits()`'s template was extracted from the real file and
  substituted with `formatBytes(IMPORT_MAX_BYTES)` = `10 MiB`; the result is byte-identical to the
  `#importLimits` HTML fallback, and both contain the email-optional/username-required rule, the
  no-email + no-password contact-administrator note, the 10 MiB bound and the duplicate-skip note.
- **Browser-worker label alignment**: confirmed statically against
  `tests/user-import-upload-browser.cjs` — same four labels, same order, the same `${label}（共 N 条）`
  heading form the worker's `groupPattern` matches, and `@users.invalid` is never rendered (the worker
  asserts its absence).
- Not run (ownership / to avoid competing with the running integration checks):
  `tests/user-import-upload.test.js`, `tests/user-import-upload-browser.cjs`, `npm run check:browser`.
  No import was executed against any real database.
