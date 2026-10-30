# User import upload — backend implementation

Fixes the reported “请求内容过大” failure for a ~97 KiB JSON file. Previously
`public/js/pages/admin/users.js` read the file with FileReader, pasted it into a textarea
and POSTed `JSON.stringify({ content })`. The global `express.json()` limit is 100 KiB, and
the extra JSON escaping pushed a 97 KiB file over that limit before the import handler ran.
The file is now uploaded as raw bytes.

Contract source: `research/import-upload-contract.md` (frozen).

## Change boundary

Only `server.js`. No new dependency, no multipart, no temporary server file, no background
task. Other endpoints, the completed account-first login work, and every other worker’s
files are untouched.

## The single route matcher

```js
function isUserImportRequest(req) {
  return req.method === 'POST' && /^\/api\/users\/import\/?$/i.test(String(req.path || ''));
}
```

POST only, case-insensitive, at most one optional trailing slash — exactly Express’s default
route matching for this path. One definition is used in **four** places, so the body-parser
skip, the origin boundary, the throttle classification and the route itself can never drift:

| Line | Use | Why |
| --- | --- | --- |
| `server.js:98` | definition | — |
| `server.js:102` | `express.json()` skip | the route needs a 10 MiB bound, not 100 KiB |
| `server.js:138` | `requestBoundary` → `browserEndpoint` | Express routing is case-insensitive, so `/API/USERS/IMPORT` reached the route while the case-sensitive `req.path.startsWith('/api/')` said it was not a browser endpoint and skipped the same-origin check |
| `server.js:163` | `limitRequests` → `isSensitive` | the same case-sensitivity gap would have let `/API/USERS/IMPORT` skip the HTTP throttle |

`express.urlencoded(...)` stays global and unchanged, so form-encoded behaviour is identical.
Only the JSON parser is skipped for this one path.

## Route-scoped body parsing

```js
const USER_IMPORT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const USER_IMPORT_MAX_BODY = '10mb';
const userImportRawParser = express.raw({ type: 'application/octet-stream', limit: USER_IMPORT_MAX_BODY });
const userImportJsonParser = express.json({ limit: USER_IMPORT_MAX_BODY });

function userImportBodyParser(req, res, next) {
  const parse = req.is('application/octet-stream') ? userImportRawParser : userImportJsonParser;
  parse(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'invalid_request',
        error_key: 'users.import.too_large',
        error_description: `导入内容不能超过 ${USER_IMPORT_MAX_BODY_BYTES / (1024 * 1024)} MiB（${USER_IMPORT_MAX_BODY_BYTES} 字节）`
      });
    }
    next(error);
  });
}

app.post('/api/users/import', userImportBodyParser, asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const importContent = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : (req.body && req.body.content !== undefined ? req.body.content : '');
  const { rows, error } = parseUserImportContent(importContent);
  // …existing admin/origin checks, parsing, duplicate skipping, per-row reasons and the 200-row bound are unchanged
```

`parseUserImportContent` is reused verbatim, so CSV/JSON formats, BOM stripping,
extra-column tolerance, duplicate skipping and the 200-row bound are all preserved.
`requireAdminUser` still runs first inside the handler, so admin authorization and the
origin boundary are unchanged.

## HTTP contract handed to p4 (validated by `tests/user-import-upload.test.js`)

- `POST /api/users/import`
  - `Content-Type: application/octet-stream`, body = raw selected-file bytes (UTF-8 decoded
    server-side) → same success body `{ createdCount, skippedCount, created, skipped }`.
  - `Content-Type: application/json`, body `{ "content": "…" }` → unchanged legacy contract,
    now also accepted up to the import bound.
- Route matching: `POST /api/users/import` and `POST /api/users/import/`, case-insensitive.
- `> 10 MiB` (10485760 bytes) → **413** `{ error: "invalid_request",
  error_key: "users.import.too_large", error_description: "导入内容不能超过 10 MiB（10485760 字节）" }`
  for both the raw and the JSON transport, with no writes.
- Every other endpoint keeps its 100 KiB JSON limit.
- No session cookie / non-admin / cross-origin `Origin` → existing 401/403 unchanged.

## Checks run

| Check | Result |
| --- | --- |
| `node --check server.js` | pass |
| `npm run check:syntax` | pass (101 files) |
| `tests/user-import-upload.test.js` (p4) | **13/13 pass** |
| `tests/security.test.js` + `tests/account-first-login.test.js` + `tests/admin-settings.test.js` | **59/59 pass** |
| Scratch transport check (`.artifacts/import-upload-check.cjs`, gitignored) | **9/9 pass** |

Scratch evidence: a generated `file=103981B` JSON whose legacy wrapper is `108555B`
(over the old 102400 limit) imports via raw bytes with `createdCount=190`; the JSON paste
path accepts the same >100 KiB payload; over-limit returns `413 users.import.too_large`;
`/API/USERS/IMPORT` and `/api/users/import/` both reach the route; an ordinary endpoint
still returns 413 above 100 KiB.

One deliberate non-change worth noting for reviewers: `tests/user-import-upload.test.js`
asserts that a declared non-octet-stream content type is **not** treated as file bytes, which
is why the parser selects `express.raw` only for `application/octet-stream` and otherwise
falls back to JSON.

## Status

Backend work is complete and paused for main integration. No further `server.js` edits are
planned from this worker.