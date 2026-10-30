# User Import Transport and Results

## 1. Scope / Trigger

Admin CSV/JSON imports must accept selected files without wrapping their text in another JSON document. A 97KiB JSON file can exceed the default 100KiB body limit after quotes and newlines are escaped again.

## 2. Signatures

- `POST /api/users/import`, `Content-Type: application/octet-stream`, body: the selected file's original UTF-8 bytes.
- The same route retains `Content-Type: application/json`, body: `{ "content": "CSV or JSON text" }` for pasted content and existing clients.
- Success: `{ createdCount, skippedCount, created, importedWithoutEmail: [{ row, username }], skipped: [{ row, username, email, reason, reason_code }] }`.
- Import request-body limit: `10485760` bytes (10MiB). There is no fixed record-count limit within that bound. Other endpoints retain their ordinary 100KiB JSON/form body limits.

## 3. Contracts

Use one import-path predicate consistent with Express POST matching, including a single optional trailing slash and case-insensitive matching. The default JSON parser must defer only matching import requests to the bounded import parser; raw files become `Buffer.toString('utf8')` and pass through the existing `parseUserImportContent`. Preserve admin authorization, same-origin checks, HTTP throttling, CSV/JSON/BOM handling and extra-column compatibility. Do not persist a server-side temporary file for this bounded upload.

The browser sends the selected `File` directly as the request body with an explicit octet-stream content type. Do not use `FileReader` or `JSON.stringify({ content: fileText })` for selected files. Selecting a file clears the pasted source; editing pasted content clears the file selection. Failed imports retain the active source so the user can retry.

Check selected `file.size`, or the actual UTF-8 byte size of the serialized pasted request, against 10MiB before sending. JavaScript string length is not a byte count. Show the size limit and duplicate-skip behavior, and scroll `#importResult` into view on completion/failure. Escape account identifiers and per-row reasons before rendering. Do not infer a new row cap from the user's example workload: whole files with thousands of records must reach the importer.

Normalize provided emails; an empty username defaults to a valid provided email. A username-only record is valid: omitted/null/blank/whitespace email is unbound, not an import error. The existing `users.email NOT NULL UNIQUE` column uses `import-${sha256(lowercaseNormalizedUsername).slice(0,24)}@users.invalid` for these records, following the established internal synthetic-mailbox convention without a schema migration. Different usernames must receive distinct markers; repeated usernames must still skip. Missing both identifiers skips with `缺少用户名`, and a nonempty invalid email skips with `邮箱格式无效`. Missing or synthetic emails must be stored unverified regardless of imported `ischeck`.

Admin UI shows unbound mailboxes as `未绑定邮箱` and never presents the internal marker as a bound address. Existing passwordless discovery returns `contact_admin` for synthetic mailboxes, account-bound send/setup rejects with `auth.password.contact_admin`, and no email is sent. Imported users with a password enter the password step; after correct password/CAPTCHA and configured TOTP, an unbound mailbox must complete `email_bind` before login, as specified in `password-verification.md`. A usable unverified imported mailbox similarly requires `email_verify`. Validate import-to-login end to end. Keep username/email conflict and within-batch duplicate skips. Return rejected input row/account/reason details without overwriting an existing user. Email format validation does not prove mailbox deliverability.

Result classification is structured. Set skipped `reason_code` to `duplicate_identity`, `duplicate_username`, `duplicate_email`, `duplicate_external_identity`, `invalid_email`, `missing_username`, `invalid_password`, `invalid_description` or `invalid_credits` while preserving human-readable reasons. `importedWithoutEmail` contains only successfully created missing/synthetic-mailbox rows with their original one-based row and username. Its length does not add to skippedCount. Frontend renders independent counted sections for those successes, all duplicate codes, invalid emails and other errors, with all row/account details escaped and scrollable. Preserve readable legacy skipped details when codes are absent; do not infer categories from text. Never mix missing-email successes into an invalid-email error group.

Use the existing `findUserConflicts({ username, email })` helper for import conflicts. It checks all matching rows through `User.findPotentialConflicts` and retains username-conflict precedence. Do not use login's `User.findByUsername` as an existence test: that method intentionally returns null for multiple matches, so legacy cross-field collisions can otherwise escape preflight, hit a unique-key error and abort the remaining import. Preserve that ambiguity behavior for authentication.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Authorized valid file/pasted input within bounds | Import, with created/skipped counts and row details |
| Import body exceeds 10MiB | 413 `users.import.too_large`, readable size explanation, no row writes |
| Thousands of records within 10MiB | Process the complete file; no `users.import.too_many` rejection |
| Username present, email omitted/null/blank/whitespace | Import as an unbound, unverified mailbox; passwordless login contacts administrator |
| Both username and email missing | Skip `缺少用户名` |
| Nonempty malformed email | Skip `邮箱格式无效`; continue with later rows |
| Invalid format / no rows | Existing 400 `users.import.invalid` / `users.import.empty` |
| Duplicate username/email / invalid individual row | Skip that row and include its account/reason |
| Username/email matches multiple legacy accounts across both fields | Skip with the existing conflict reason and continue with following valid rows |
| Anonymous / ordinary user / disallowed origin | Existing authorization/origin rejection; no import |
| Large body on an ordinary endpoint | Existing 413; import capability does not widen global limits |

## 5. Good / Base / Bad Cases

- Good: a 97KiB JSON File uploads byte-for-byte, is parsed by the server and imports valid users even when the old wrapped payload would exceed 100KiB.
- Good: more than 2000 valid rows import in one file; reimport reports those existing accounts individually as skipped without changing stored users.
- Base: a small pasted CSV remains a JSON `{ content }` request; known duplicates appear as skipped rows.
- Bad: changing the global JSON limit to accommodate imports enlarges every public authentication request and still needlessly wraps selected file contents.

## 6. Tests Required

- `tests/user-import-upload.test.js`: actual 97KiB file versus old wrapper byte counts; raw CSV/JSON/BOM; pasted compatibility; more than 2000 records with complete counts, duplicate username/email details and repeated import; size bound without writes; admin/origin gates; unchanged ordinary endpoint limit. Keep transport fixture size independent of workload size.
- `tests/user-import-upload-browser.cjs`: real file chooser upload with exact request bytes/content type; a file exceeding 2000 records, complete counts and duplicate details; source switching, pasted input, oversized local preflight without a request, visible duplicate results and desktop/mobile screenshots.
- Re-run syntax, API and browser integration checks after shared server parser changes; preserve login/MFA/OAuth coverage.

## 7. Wrong vs Correct

Wrong: `FileReader.readAsText(file)` followed by `JSON.stringify({ content: result })` for a selected JSON file.

Correct: `fetch('/api/users/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })`; server-side bounded raw parsing feeds the existing importer.
