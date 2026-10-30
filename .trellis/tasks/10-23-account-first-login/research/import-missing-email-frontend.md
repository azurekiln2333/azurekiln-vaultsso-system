# Import Without Email + Admin List "Unbound Email" Display (frontend)

> Coordinator correction (2026-10-24): the report's backend-dependency claim that a 200-row cap remains is stale. The current implementation has no fixed record-count cap; real 2501-row uploads and complete reimports passed. Optional-mailbox/grouped-result corrections passed 245 API tests and eight browser groups; see validation.md. Preserve the frontend findings below as implementation history.

Owner: Pi (auth-frontend). Scope: `public/js/pages/admin/users.js` and the import/list region + JS cache
version of `views/admin/users.html` only. No backend, test or spec edits; other workers' uncommitted
edits preserved; nothing staged, reverted or committed.

Supersedes the earlier "email required" expectation. New contract applied here: blank / omitted / `null`
/ whitespace email **plus** a username is importable; both empty → skip as 缺少用户名; a **nonempty but
malformed** email → skip as 邮箱格式无效 (never silently discarded).

## Changes

### `public/js/pages/admin/users.js`

- **Minimal scoped helpers** (no frontend equivalent existed; mirrors `server.js:2155`):
  - `isUnboundEmail(email)` → `!value || /@users\.invalid$/i.test(value)` — treats empty and the internal
    `@users.invalid` placeholder as unbound.
  - `emailVerifiedState(user)` → `false` when unbound, else `Boolean(user.emailVerified)`.
- **邮箱 column**: shows `未绑定邮箱` for empty / internal placeholder addresses instead of the raw
  internal address. The placeholder is no longer rendered anywhere in the row.
- **邮箱状态 column**: unbound accounts render `未绑定` (warning badge) and never claim a verified
  mailbox — this holds even when the import supplied `ischeck=y`, because the unbound check runs first.
  Bound addresses keep `已验证` / `未验证`.
- **邮箱状态 filter stays consistent**: `filteredUsers()` now uses `emailVerifiedState(user)`, so
  filtering by 已验证/未验证 agrees with the badge instead of listing an unbound account under 已验证.
- **Search and data preserved**: `user.email` is still included in the search haystack and the row still
  carries `data-user-id`; only the rendered label changed. `allUsers` payload handling is untouched.
- **No other styling or behaviour touched**: identity/phone/role/ban/created/actions cells, the
  empty-state, and the whole import transport path are unchanged.

### `views/admin/users.html` (import help only)

- Head help now states the new contract explicitly: `email 列可留空` as long as `username` is present;
  the system uses an internal placeholder, the account's email status is recorded as 未绑定 and the
  address is not a deliverable mailbox; only when **both** username and email are empty is the row
  skipped as 缺少用户名; a filled-in malformed email is skipped with 邮箱格式无效. It also states that
  accounts with neither email nor password are told at login to contact an administrator to reset.
- `#importLimits` now reads
  `文件最大 10 MiB；email 可留空（需填写 username）；用户名或邮箱重复的记录会被跳过并列出原因。`
- **Cache version bumped**: `users.js?v=20261024-import-unbounded-1` →
  `?v=20261024-import-optional-email-1`. Both stylesheet versions (`?v=20261021-admin-flat-1`) and the
  other worker's `lg:px-8` removal remain untouched.

### Preserved from prior rounds

No fixed row-count cap (no `IMPORT_MAX_ROWS`, no row rejection/hint); direct original `File` upload as
`application/octet-stream` with no `FileReader`; pasted `application/json` `{ content }`; 10 MiB
byte preflight via `file.size` / `new Blob([text]).size`; source switching (file ⇄ paste); failed imports
retain the source for retry; bounded scrollable skipped-detail list; `scrollIntoView` on completion or
failure; ambiguity-safe duplicate skipping with per-row account/reason detail.

## Backend Dependencies (p3, not my ownership)

1. **Import acceptance of a missing email.** `POST /api/users/import` must accept blank/omitted/`null`/
   whitespace email when a username exists and persist the deterministic internal placeholder
   `import-${sha256(normalized lowercased username).slice(0,24)}@users.invalid`, forcing
   `email_verified = false` even when `ischeck=y`. Existing `@users.invalid` inputs must also stay
   unverifiable. `email` is `NOT NULL UNIQUE`, so the deterministic derivation is what keeps repeated
   imports idempotent; no schema migration.
2. **Skip rules.** Both username and email empty → skip `缺少用户名`; nonempty malformed email → skip
   `邮箱格式无效` (do not drop silently). Username + real valid email keeps today's behaviour; empty
   username + valid email still defaults username to the email.
3. **Login path already correct — do not change.** `isSyntheticEmail` is consulted at
   `server.js:2738` (discovery), `:2961` (account-bound send) and `:3216` (account-bound setup), so an
   unbound account routes to `contact_admin` with no mail. The frontend renders that branch as the
   `#loginContactAdmin` "请联系管理员重置" panel; no login-flow edit was made here.
4. **Still outstanding from the previous round:** `server.js:4444` `USER_IMPORT_MAX_ROWS = 200` and the
   rejection at `:4558` remain, so imports above 200 rows still fail with 400 `users.import.too_many`
   despite the user's decision to drop the row cap. Also `.trellis/spec/backend/user-import.md` (§2 row
   limit, §4 `More than 200 records`) and the row-bound case in `tests/user-import-upload.test.js` still
   assert the old cap. Coordinator / p3 to resolve.

## Verification

- `node --check public/js/pages/admin/users.js` → OK.
- `npm run check:syntax` → "Syntax and browser script references checked: 101 files".
- Row-template audit: `escapeHtml(emailDisplay)` and `<td>${emailStatusHtml}</td>` present; legacy
  `未设置邮箱` and the inline verified-badge expression are gone (0 occurrences).
- Not run (ownership / to avoid competing with the running integration checks):
  `tests/user-import-upload.test.js`, `tests/user-import-upload-browser.cjs`, `npm run check:browser`.
  No import was executed against any real database.
