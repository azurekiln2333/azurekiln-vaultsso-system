# Import Upload Integration Review

Historical transport review before the user's subsequent scale requirement. The retained 200-row
bound below was later removed; `import-unbounded-review.md` and `validation.md` contain the final
complete-file review and the legacy duplicate-ambiguity correction.

Review date: 2026-10-24 (Asia/Shanghai).

Reviewer: `/root/inspect_password_login`, with a narrow read-only frontend/test review by `/root/inspect_password_login/review_frontend_state`. The main session owns all product edits and automated verification. This report is the only file written by the import reviewer.

## Reviewed scope

Read the subsequent user-authorized `research/import-upload-contract.md`, existing import research, the updated task PRD/design/implementation plan, `.trellis/spec/backend/user-import.md`, backend/frontend spec indexes, and the relevant surface/quality guidance. Compared product changes against `D:/AppData/Local/Temp/user-import-upload-baseline-3zoyncf9`.

Reviewed `server.js`, `public/js/pages/admin/users.js`, `views/admin/users.html`, `package.json`, both new `user-import-upload` regression files, and the new/updated specs. No real import or environment database was used.

## Product review result

No new product-code defect was identified in the reviewed import snapshot.

- **Raw file transport:** `users.js:145` sends the selected `File` directly with `Content-Type: application/octet-stream`; FileReader and file-to-JSON wrapping are removed. Server raw parsing decodes UTF-8 and feeds the existing CSV/JSON parser (`server.js:4515`, `:4539`). No server temporary file or dependency was added.
- **Scoped body limits:** only POST requests matching the actual case-insensitive import path with one optional trailing slash defer the default JSON parser (`server.js:98`). Import raw and JSON parsers use 10MiB; ordinary JSON and form limits remain unchanged. Other methods or unrelated paths do not inherit the larger JSON limit.
- **Boundary consistency:** the same matcher participates in origin protection (`server.js:138`) and HTTP throttling (`:163`), including an uppercase `/API/USERS/IMPORT/` request. `requireAdminUser` remains before importer work; over-limit parsing returns a readable `413 users.import.too_large` before row writes.
- **Legacy compatibility:** pasted JSON `{ content }` remains supported. The parser, BOM handling, CSV/JSON formats, extra-column handling, duplicate checks, per-row reasons, 200-row preflight and existing importer loop are unchanged.
- **Frontend source/size handling:** selecting a file clears pasted content; editing pasted content clears the selected file. The selected file's `size`, or `Blob.size` of the serialized pasted request, supplies the byte preflight. This counts UTF-8 bytes rather than JavaScript code units. A failed request does not clear the active source.
- **Results and limits:** file/row bounds are displayed; user-controlled identifiers/reasons are escaped; `showImportResult` scrolls the actual result into view. The existing users template styling is preserved, with only import hints and the users-script cache version changed.
- **Login/MFA scope:** the incremental `server.js` diff contains only parser selection, the import-path additions to boundary/throttling, and import transport middleware/decoding. Existing discovery, password reset/setup, native verification, MFA and OAuth handler bodies are unchanged. All non-import requests still use the same default JSON/form parser settings. Runtime regression results remain the main session's responsibility.
- **Integration/specs:** the package browser command includes the new import browser regression without removing account-first/MFA coverage. The user-import spec and both layer indexes describe the approved direct upload, scoped limit, source switching and visible-results contracts. The task artifacts now explicitly include the subsequently authorized import scope.

## Findings sent to the coordinator

### Source-confirmed fixes during review

1. **Authorization-test baseline:** the first API test snapshot counted users before creating its login fixture accounts, then compared later totals against that old count. The latest source now records the count again after creating each fixture account, so it can detect actual import writes.
2. **Browser completion wait:** the initial helper accepted any visible nonempty result, including the pre-request “正在导入...” placeholder. The latest source waits for the submit button to re-enable and for final result text, preventing premature success/error assertions.
3. **Import route matcher:** the reviewed product snapshot already limits the shared matcher to POST and one optional trailing slash and applies it to both origin and HTTP throttling, closing the initially identified uppercase-path inconsistency.
4. **Whitespace/no-row assertions:** the API regression now preserves the existing distinction: whitespace raw content returns `users.import.invalid`; valid JSON `[]` returns `users.import.empty`. The coordinator confirmed the corrected assertions and passing verification. No product change was needed.

### Targeted coverage added and source-confirmed

- `tests/user-import-upload.test.js:372` and `:380` now send cross-origin raw and pasted requests to fully uppercase `/API/USERS/IMPORT/`, assert `403`, and verify the user count is unchanged. A positive raw-upload case at `:414` also exercises that exact matcher-only path. These additions were confirmed by source inspection.
- `tests/user-import-upload-browser.cjs:254` now constructs 3.5 million CJK characters, establishes that JavaScript length is below 10MiB while serialized UTF-8 bytes exceed it, and asserts zero import requests, a usable submit button, the visible limit/size explanation, and retained pasted content. It also writes `import-paste-oversize-blocked`. These additions were confirmed by source inspection; this reviewer did not execute the browser test or inspect that screenshot.

The pre-existing ability to close/reopen an import modal while a request is pending was observed in both baseline and new source. It was not reported as a new regression or expanded into this fix.

## Verification limits

- Product edits by reviewer: none.
- Automated tests, lint, syntax and browser execution by reviewer: not run, as assigned to the main session.
- Coordinator-reported verification: `check:e2e` passed **238/238**, `check:browser` passed **all 8 groups**, syntax checks passed **101 files**, and the API-test owner reported the focused import suite passed **13/13**. These are reports from the coordinator/test owners, not executions performed by this reviewer. The two targeted additions above were independently source-confirmed here.
- Screenshots/visual layout: the coordinator reported visually inspecting desktop and mobile `import-file-success`, with account identifiers, row numbers and reasons visible. This reviewer did not inspect those screenshots. The browser-test owner reported generating `import-paste-oversize-blocked` for the new UTF-8 paste case.
- Conclusion: reviewed product changes satisfy the approved import transport contract by source inspection. **No unresolved review findings remain.** The coordinator owns the final suite completion and acceptance; this report does not independently claim deployment or automated execution.
