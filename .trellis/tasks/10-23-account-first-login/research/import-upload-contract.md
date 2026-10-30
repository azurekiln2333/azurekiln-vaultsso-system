# User Import File Upload Correction

The user reported an actual import failure, “请求内容过大”, and confirmed the JSON file is only 97KB. They explicitly requested that the file be uploaded to the server. This subsequent instruction expands the task with a focused import transport fix; no further planning approval is needed.

## Evidence and change boundary

`public/js/pages/admin/users.js` currently uses FileReader, copies the file into a textarea, and POSTs `JSON.stringify({ content })`. The global `express.json()` default body limit is 100KiB. JSON quotes/newlines are escaped a second time, so a 97KiB file can exceed that limit before the import handler runs. All selected file contents must instead be uploaded directly, with parsing performed by the server.

Pre-import-fix snapshots of `server.js`, `public/js/pages/admin/users.js`, `views/admin/users.html` and `package.json` are stored at `D:/AppData/Local/Temp/user-import-upload-baseline-3zoyncf9`. They include the already completed login feature and the user's prior admin changes.

## Contract

- Existing admin-only `POST /api/users/import` accepts a selected File as an `application/octet-stream` request body. The server decodes UTF-8 and calls the existing CSV/JSON parser. No multipart dependency or temporary server file is needed for the bounded upload.
- The existing JSON `{ content }` contract remains available for pasted content and old clients.
- Import-only request-body limit: 10MiB (`10485760` bytes). Keep ordinary JSON/form endpoint limits unchanged. Match the actual import route including its Express-supported trailing slash/case behavior.
- Return HTTP 413 with a readable import-specific size explanation for excess imports. Browser preflight selected `file.size` and pasted serialized UTF-8 request bytes against the same maximum; do not read selected files through FileReader.
- On file selection, clear pasted content; typing pasted content clears the selected file. Send exactly the active source. Preserve the source on request failure so the user can retry.
- Preserve current CSV/JSON formats, BOM handling, extra-column compatibility, admin authorization and origin checks, duplicate skipping and per-row reasons. Remove the fixed row-count bound: the user explicitly requires whole-file imports containing thousands of users and rejected treating 1500 or 2000 as a new cap. Retain the 10MiB request-size bound. Display the actual size bound and duplicate-skip behavior in the UI, and scroll the result into view after success/failure.
- No import occurs outside isolated fixtures; do not use the user's real data or environment database.

## Ownership

- Pi p3: `server.js` import parsing/size errors only; preserve completed account-first work.
- Pi p5: `public/js/pages/admin/users.js`, import-only additions and asset-version change in current `views/admin/users.html`; preserve its earlier admin styling edits.
- Pi p4: new `tests/user-import-upload.test.js`; minimal test adapter changes only if required.
- Pi p6: new `tests/user-import-upload-browser.cjs`; run desktop/mobile file and pasted-content checks.
- Main: coordination, package command, task/spec evidence and full integration checks.

## Acceptance

1. A real ~97KiB JSON File whose old JSON wrapper exceeds 100KiB imports successfully via direct file bytes.
2. Larger valid CSV/JSON imports up to the bounded request limit reach the importer; duplicates are skipped with row/account/reason details.
3. Over-limit uploads return clear 413 without writes; frontend prevents known excess input before requesting.
4. Anonymous/non-admin/cross-origin requests cannot import; other endpoint body limits remain unchanged.
5. Pasted JSON contract remains compatible. Prior login/MFA/OAuth checks continue to pass.
6. A real file containing more than 2000 records succeeds through both API and browser, with all valid records created and duplicate username/email details visible. Reimport skips existing accounts without overwriting them. No fixed record-count rejection remains.
7. Legacy cross-field collisions matching multiple accounts are skipped rather than aborting the file. Reuse the existing import-compatible `findUserConflicts` helper; preserve login's intentionally ambiguous `findByUsername` semantics. Regression includes conflicting username/email rows followed by a valid row that must still import.
8. A nonempty username with an omitted/null/blank/whitespace email imports as an unbound account. Use the established internal synthetic-email convention (`import-${sha256(username.toLowerCase()).slice(0,24)}@users.invalid`) for the existing NOT NULL UNIQUE storage column, never verified even with `ischeck=y`. Both identifiers missing skips with `缺少用户名`; a provided malformed email skips with `邮箱格式无效`. Real-email fallback and duplicates remain compatible. Admin UI shows `未绑定邮箱`. Actual imported passwordless users reach contact-admin login without mail/send/setup credentials. Under the subsequent `login-email-gate-contract.md`, password-bearing users enter password login and must complete required mailbox binding/verification after password/CAPTCHA and configured TOTP before receiving credentials.
9. Preserve existing result fields/reason strings and add `importedWithoutEmail: [{row,username}]` only for successfully created missing/synthetic-mailbox rows. Skipped entries add `reason_code`: `duplicate_identity`, `duplicate_username`, `duplicate_email`, `duplicate_external_identity`, `invalid_email`, `missing_username`, `invalid_password`, `invalid_description`, `invalid_credits`. UI shows separately counted groups: successful without email, duplicate skips (all duplicate codes), invalid email, other errors. Every applicable row/account/reason remains inspectable and escaped; no single interleaved thousands-row list. Legacy missing-code response keeps readable details without guessing classification. Historical pasted-result classification is a local artifact, not a live import.

## Subsequent correction: missing email

The user identified the still-required import email on 2026-10-24. This conflicts with the already-agreed no-mailbox login path, so the import prerequisite is removed within the same active task. The change lives in import validation and mailbox storage, plus admin guidance/display; the existing login synthetic-email guard already implements the approved fallback. Preserve schema and authentication semantics. The four Pi ownership scopes stay unchanged, with the backend owner allowed to correct the now-inaccurate empty-password model comment. Tests must cover an imported account's real path to the fallback and multiple no-email rows at scale.

## Subsequent correction: fixed row cap

On 2026-10-24 the user encountered the old 200-record rejection with a 1500-plus-user export and explicitly rejected an arbitrary replacement maximum. This supersedes the original transport-only decision to retain 200 records. The behavior gap lives in the import handler's preflight guard, with duplicated UI/test constants; remove those together. Product edits are limited to `server.js`, `public/js/pages/admin/users.js`, and `views/admin/users.html`; the two existing import regression files validate scale and duplicate results. Continue using in-memory, bounded file parsing and the existing sequential creation loop. Background jobs, database changes, and unrelated authentication/admin work remain outside this correction.
