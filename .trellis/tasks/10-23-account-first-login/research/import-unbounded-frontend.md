# Admin Import: Remove the Frontend Row Cap (10 MiB bound retained)

Owner: Pi (auth-frontend). Scope: `public/js/pages/admin/users.js` and the import region + JS cache
version of `views/admin/users.html` only. No backend, test or spec edits; other workers' uncommitted
edits preserved; nothing staged, reverted or committed.

Superseded instruction: the earlier "200 rows" statement in `research/import-upload-contract.md`,
`research/import-frontend-implementation.md`, `.trellis/spec/backend/user-import.md` and
`prd.md`/`design.md`/`implement.md` is replaced by the user's explicit decision: **no fixed
record-count cap** on admin imports. The scoped 10 MiB body/file bound, existing admin
authorization/same-origin/throttling, and per-row created/skipped detail are unchanged.

## Changes

### `public/js/pages/admin/users.js`

- **Removed `const IMPORT_MAX_ROWS = 200;`** and every row-count reference. Verified residue check:
  0 occurrences of `IMPORT_MAX_ROWS` / `MAX_ROWS` / `200 条` / `单次最多` in the owned files.
- **No row-count rejection exists in the frontend** and none was added; the only preflight is the byte
  bound (`requestBytes > IMPORT_MAX_BYTES`, 10 MiB) plus the empty-source prompt.
- **Accurate limit hint** (`renderImportLimits()`):
  `文件最大 10 MiB；用户名或邮箱重复的记录会被跳过并列出原因。`
  This states the only remaining bound (file size) and the duplicate-skip behavior, with no numeric row
  cap. No implementation vocabulary (序列化 / 请求约 / TextEncoder) — still 0 occurrences.
- **Updated HTML default** for `#importLimits` to the same sentence, so it is correct even before JS.
- **Very large result UX (>2000 rows)**: the skipped list is now rendered inside its own bounded,
  independently scrollable region — `<p>跳过明细（共 N 条）：</p>` plus
  `<ul class="space-y-1 overflow-y-auto" style="max-height: 40vh">`. All rows are still rendered in full
  (no truncation, no data hidden); the dialog keeps its header/footer visible while thousands of
  `第 N 行 <账号>：<原因>` entries scroll inside the list. Counts (`createdCount` / `skippedCount`) stay
  in the summary line. No CSS file was touched; the inline `max-height` is scoped to this element.
- **Cache version bumped**: `users.js?v=20261024-import-upload-1` → `?v=20261024-import-unbounded-1`.

### Preserved (unchanged)

- Direct original `File` upload: `POST /api/users/import`, `Content-Type: application/octet-stream`,
  `body: file`; pasted content keeps `application/json` + `{ content }`. No `FileReader` (0 occurrences).
- Source switch: selecting a file clears the paste; editing the paste clears the file selection.
- Failed imports retain the active source so the user can retry; the submit button is re-enabled in
  `finally`.
- 10 MiB preflight uses `file.size` for files and `new Blob([text]).size` (real encoded bytes) for paste.
- Readable oversize messages: file `文件 X 超过 Y 上限，请拆分文件后再导入。`;
  paste `粘贴内容过大，请使用文件上传或拆分内容。`
- `showImportResult()` still calls `scrollIntoView({ block: 'nearest', inline: 'nearest' })` on
  preflight errors, success and failure, so skipped detail is brought into view.
- Per-row escape and detail rendering (`escapeHtml` on account and reason) unchanged.
- `views/admin/users.html` preserves the other worker's edits: both stylesheets remain
  `?v=20261021-admin-flat-1`, the `lg:px-8` removal is untouched; only the import-region text and the
  `users.js` version changed.

## Backend dependency resolved

Coordinator verified that p3 removed the backend row cap and p4 replaced the obsolete row-bound
assertion with multi-thousand-row coverage. The import specification now records no fixed row cap.
The integrated browser fixture has successfully uploaded 2501 rows and reimported the same file;
see `import-unbounded-browser.md` and `validation.md` for final results.

## Verification

- `node --check public/js/pages/admin/users.js` → OK.
- `npm run check:syntax` → "Syntax and browser script references checked: 101 files".
- Row-cap residue audit in the two owned files → 0 hits.
- Not run (per ownership / to avoid competing with the running integration checks):
  `tests/user-import-upload.test.js`, `tests/user-import-upload-browser.cjs`, `npm run check:browser`.
  No import was executed against any real database; no bulk/background job or multipart/temp file was
  added.
