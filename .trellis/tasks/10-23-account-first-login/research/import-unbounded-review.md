# Complete-file user import review

Date: 2026-10-24 (Asia/Shanghai). Reviewer: `/root/check_import_scale`.

## Scope and method

Read the task's check context, current PRD/design/implementation plan, direct-upload contract, executable import/password/MFA/frontend specifications, and previous login/import integration reviews. Reviewed the current server import path, admin users script/template, both import regression files, and implementation reports. Product and test edits belong to the four existing Herdr Pi owners; this reviewer writes only this report.

Compared product hunks with `D:/AppData/Local/Temp/user-import-upload-baseline-3zoyncf9`. Server differences are confined to import parser selection, import path boundary/throttle matching, direct-file parsing, and importer changes. Login/discovery/setup/MFA/OAuth handler bodies have no changes from that already-reviewed snapshot. The current scale correction does not change the User model's login lookup semantics.

## Confirmed behavior

- `USER_IMPORT_MAX_ROWS`, its `users.import.too_many` rejection, and the frontend row-cap constant/copy are removed. Parsed rows pass from the empty check directly into the complete sequential loop. No row slicing or fixed-count truncation remains.
- Selected files remain the original `File` body with `application/octet-stream`; pasted input remains JSON `{ content }`. Import-only parsers retain 10MiB, and ordinary JSON/form endpoints retain 100KiB. The shared POST/case-insensitive/single-trailing-slash matcher remains in parser selection, origin protection and HTTP throttling; admin authorization runs before row processing.
- Frontend preflight still measures selected file bytes or the serialized pasted body's UTF-8 bytes. Failed requests retain their source. There is no import-specific fetch abort timer or app-level processing timeout in this repository. Existing OIDC/Huawei outbound verifier timers do not apply to imports.
- Success returns complete created/skipped arrays. The UI escapes identifiers/reasons and renders every skipped row; its `40vh` list uses the already compiled `overflow-y-auto` utility. The summary remains separate. The users asset query version is updated and no CSS rebuild is needed.
- API tests contain a 2501-valid-record upload with persisted first/last record and complete count assertions; a separate 2501-record file checks six existing/in-file conflicts and exact row/account/reason details. A repeated import asserts no duplicate creation. The 97KiB fixture's 200 records are now a transport sample count independent of any maximum.
- Browser tests retain byte-for-byte 97KiB upload coverage and use a real 2501-record file, expecting 2498 creations and three duplicate skips; identical-file reimport expects zero creations and 2501 skips on desktop/mobile. They await the enabled submit button and final text, preserving the previous completion-wait correction. Over-limit file/multibyte-paste preflight and source preservation remain covered.

## Concrete duplicate defect found

The original importer used `User.findByUsername` for existence checks. That model method intentionally returns null for more than one username/email match, which is appropriate for ambiguous login but unsafe as an import conflict predicate.

Isolated fixture reproduction (no real environment database):

1. Seed account A with username `legacy-cross@example.test`, email `owner-a@example.test`.
2. Seed account B with username `legacy-owner-b`, email `legacy-cross@example.test`.
3. `User.findByUsername('legacy-cross@example.test')` returns null, while `findPotentialConflicts(...)` returns two records.
4. Import the shared username with a fresh email, followed by an unrelated valid record.
5. Before correction: HTTP 409 `request.failed`, description `记录已存在`; neither row is created and no row-level skip result is returned. Thus the later valid record is never processed.

Sent the source-confirmed failure and reproduction to the coordinator. The coordinator assigned the backend owner to reuse the existing import-compatible `findUserConflicts` helper (preserving both reason strings and precedence), and the API owner to add username-ambiguous/email-ambiguous rows followed by a valid row. Do not change global login lookup behavior.

Closure: **fixed by the backend/API owners and independently verified**. The importer now calls `findUserConflicts({ username, email })` once per eligible row, checks username-conflict before email-conflict, and retains the original two skip descriptions. `User.findByUsername` is unchanged. The new API regression seeds the two ambiguous accounts, submits four username/email conflicts (including case variants), then a valid record, and asserts HTTP 200, created 1/skipped 4, exact row/reason/account details, persisted final record, unchanged pre-existing accounts and one admin import log. This reviewer ran that exact regression successfully (1/1, zero failures). The executable import spec and upload contract now document this rule. No unresolved product or test finding remains in this review.

## Verification and limits

- Reviewer execution: `node --check` passed for `server.js`, the admin users script, and both import regression files. `git diff --check` passed on those paths and the users template (only the existing LF/CRLF conversion notice appeared).
- Dedicated lint and TypeScript commands are absent from `package.json`; the project is JavaScript. The coordinator owns the repository syntax/API/browser gates.
- Reviewer executed the isolated duplicate reproduction above and, after the owner fix, `node --test --test-name-pattern='legacy cross-field' tests/user-import-upload.test.js`: **1/1 passed**, duration 984ms. No full test suite, real import, SMTP, commit or deployment was performed by this reviewer.
- Implementation reports currently record focused API 15/15 and desktop/mobile 2501-row browser success. These are worker-reported executions, not independent reviewer runs. The coordinator will record final checks after the duplicate correction.
- Memory-fixture timings validate behavior at the requested scale; they do not establish production MySQL throughput, reverse-proxy timeout behavior or large batches of nonempty passwords. The existing sequential password hashing and user-list rendering remain unchanged. No new queue, cap or performance guarantee is inferred.

## Findings summary

- Fixed by owners: ambiguous legacy username/email collisions no longer abort an import or suppress valid following rows; independently source-checked and regression-tested here.
- Not fixed: none. Earlier worker reports' stale coordination notes were sent to the coordinator for evidence cleanup; they do not describe current product behavior.
- Reviewer product/test edits: none. All unrelated dirty workspace changes are preserved.
