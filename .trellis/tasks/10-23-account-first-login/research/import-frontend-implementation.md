# User Import Frontend Implementation (file upload transport)

> Historical transport implementation. The 200-row limit/copy below was subsequently removed entirely; see import-unbounded-frontend.md and validation.md. Current imports retain only the 10MiB size bound, accept username-only rows and display grouped outcomes.

Owner: Pi `w1Q:p5` (frontend). Scope: `public/js/pages/admin/users.js` and the import region plus
JS cache version of `views/admin/users.html` only. No backend, test, spec, login/MFA or admin-styling
changes; other workers' uncommitted edits preserved (no reset/revert/stash, no commit).

## Problem Confirmed

The old flow read the selected file with `FileReader` into the textarea and POSTed
`JSON.stringify({ content })`. The global `express.json()` limit is 100KiB, and JSON string escaping
(newlines/quotes) inflates the payload, so a 97KiB file could exceed the limit and fail with
"请求内容过大" before the import handler ran.

## Changes

### `public/js/pages/admin/users.js`

- **Removed `FileReader` entirely** (verified: 0 occurrences). A selected file is now sent as raw bytes.
- **Transport switch**: `postUserImport(file, pasted)` sends
  - file → `POST /api/users/import`, `Content-Type: application/octet-stream`, `body: File`;
  - paste → `POST /api/users/import`, `Content-Type: application/json`, `body: JSON.stringify({ content })`
    (existing contract preserved for pasted content and old clients).
  Exactly one active source is sent.
- **Header override**: the octet-stream type is supplied per request; the shared `request()` helper's
  default JSON header remains overridable (`{ 'Content-Type': 'application/json', ...(options.headers || {}) }`).
  The import now uses its own small fetch wrapper so it can render a readable 413 without changing the
  shared helper's behavior for other admin calls; 401/403 redirects mirror `request()`.
- **413 handling**: parses the server body and prefers its `error_description`, else falls back to
  `请求内容过大：单次导入上限为 10 MiB，请拆分文件或内容后重试。`
- **Source exclusivity**: selecting a file clears the pasted content; any edit of the textarea clears the
  selected file (`importFileInput.value = ''`). `openImportModal()` still resets both.
- **Preflight before any request**: `file.size` for files, and the real UTF-8 byte size of the pasted
  request body for pasted content, both compared against `IMPORT_MAX_BYTES = 10 * 1024 * 1024`.
  `utf8ByteLength()` uses `new Blob([text]).size` — actual encoded bytes, with no character-count
  fallback (a JS string length would under-count non-ASCII). Over-limit input shows a plain-language
  message and sends nothing: file → `文件 X 超过 Y 上限，请拆分文件后再导入。`,
  paste → `粘贴内容过大，请使用文件上传或拆分内容。` Empty source shows a prompt instead of requesting.
- **Failure preserves input**: the file selection and pasted text are never cleared on submit, so a
  failed request can be retried as-is.
- **Result visibility**: `showImportResult()` sets the panel, then
  `scrollIntoView({ block: 'nearest', inline: 'nearest' })`, used for preflight errors, success and
  request failures — the skipped-row detail (`第 N 行 <输入账号>：<原因>`) is now brought into view.
- **Limits are rendered from constants**: `renderImportLimits()` writes
  `单次最多 200 条，文件最大 10 MiB` using `IMPORT_MAX_ROWS = 200` and `IMPORT_MAX_BYTES`, matching
  `server.js`'s `USER_IMPORT_MAX_ROWS = 200` and the 10 MiB import-only body limit. `formatBytes()`
  yields `10 MiB` / `97 KiB` / `0 B` (spot-checked).
- **User-facing copy contains no implementation vocabulary** (audited: 0 occurrences of 序列化 /
  请求约 / TextEncoder). The paste hint reads
  `将按粘贴内容导入（99 KiB），未使用任何文件。` — a plain size, not a request/wire term.
- `#importSourceHint` states the active source and size, or that editing the paste clears the file.

### `views/admin/users.html` (import region only)

- Added `#importSourceHint` and `#importLimits` paragraphs (`napi-panel-desc`) between the paste field
  and `#importResult`. `#importLimits` reads `单次最多 200 条，文件最大 10 MiB`.
- Bumped the JS cache version only: `users.js?v=20260928-js-1` → `?v=20261024-import-upload-1`.
- Preserved the other worker's existing template edits: both stylesheet versions remain
  `?v=20261021-admin-flat-1` and the `lg:px-8` removal is untouched (confirmed by diff).

## Backend Dependency

The file path requires p3's octet-stream branch and the import-only 10 MiB body limit on
`POST /api/users/import`. Until that lands, `express.json()` ignores an `application/octet-stream`
body, so `req.body.content` is empty and the request returns the existing 400 parse error. The frontend
is written to the frozen contract in `research/import-upload-contract.md`; no frontend change is needed
once p3 lands. Pasted content keeps working with the current backend.

## Verification

- `node --check public/js/pages/admin/users.js` → OK.
- `npm run check:syntax` → "Syntax and browser script references checked: 101 files".
- `formatBytes` / byte math spot-check: `10485760 → 10 MiB`, `99328 → 97 KiB`, `0 → 0 B`,
  `11534336 → 11 MiB`; `utf8ByteLength('abc') → 3`, `utf8ByteLength('中文') → 6`, and a 97KiB pasted
  string measures 99,342 request bytes via `Blob().size`.
- Not run (per instruction to avoid re-running whole suites): `tests/user-import-upload-browser.cjs`
  (p6, new) and `npm run check:browser`. Real imports were not attempted against any live database.

## Out of Scope (unchanged)

No automatic batching or background job, no multipart dependency, no server temp file, no changes to
CSV/JSON formats, BOM/extra-column compatibility, duplicate skipping, row reasons, admin authorization
or origin checks. Login/MFA/OAuth work was not touched.
