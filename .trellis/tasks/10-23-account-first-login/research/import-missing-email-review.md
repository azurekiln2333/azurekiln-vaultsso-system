# Missing-email import and grouped-results review

Date: 2026-10-24 (Asia/Shanghai). Reviewer: `/root/check_import_scale`.

## Scope

Reviewed the subsequent R10/R11 correction against current PRD/design/implementation artifacts, `research/import-upload-contract.md`, the executable user-import spec and the existing passwordless discovery/send/setup contracts. Product/test editing remains with the four designated Herdr Pi owners; this report is the only file written by this reviewer. The earlier no-cap/direct-upload review remains in `research/import-unbounded-review.md`.

## Source-confirmed contracts

- Missing means omitted, null, or a blank/whitespace string. A nonempty malformed string or a non-string source email remains `invalid_email`; it is never silently converted into an unbound account. Missing both identifiers is `missing_username`. A valid email can still supply the default username.
- An accepted username-only row stores `import-${sha256(username.toLowerCase()).slice(0,24)}@users.invalid`. Username is already trimmed. The existing NOT NULL UNIQUE schema is preserved, different usernames obtain independent markers, and conflict checks use the actual stored email. In-file and existing-account checks retain the previous precedence/reasons and ambiguity-safe `findUserConflicts` helper.
- Missing/synthetic emails are forced unverified even with `ischeck=y`; an explicit valid `@users.invalid` source remains synthetic and unverified. Real mailbox verification imports retain their previous behavior. No global authentication lookup or database schema change is introduced.
- The original input email remains in skipped entries. Each skip gains its explicit `reason_code` from the documented nine-code taxonomy. `importedWithoutEmail: [{row,username}]` is populated only after a successful creation with a missing/synthetic mailbox; skipped rows are excluded, and its length is not added to `skippedCount`. Existing response fields remain present.
- Frontend sections separately count successful no-mailbox creations, all duplicate codes, invalid-email skips, and other skips. Rows keep original source positions, account details and readable reasons, escaping supplied values. Each nonempty section has its own complete, bounded scroll list. Unknown/uncoded entries in a partly coded response remain under other errors; a wholly uncoded legacy response retains readable generic details without invented categories.
- Admin user rows show `未绑定邮箱`/`未绑定` for blank/synthetic addresses and their verified-state filter agrees with that display. The internal generated email is not rendered as the user's bound mailbox. Real-email displays and verification badges are preserved.
- Existing account discovery already selects `contact_admin` for a passwordless synthetic-mailbox user. Existing account-bound send/setup reject that user with `auth.password.contact_admin` before email issuance or password mutation. A password-bearing imported user still follows ordinary password login. Import changes do not modify these login branches.
- Direct File upload, 10MiB import-only byte bounds, no fixed row cap, source switching/retry behavior, original parser formats, authorization/origin/throttling and earlier legacy-collision fix remain intact.

## Finding reported to coordinator

The users template's `#importLimits` described `email 可留空（需填写 username）`, but the earlier `renderImportLimits()` overwrote it on load with the older size/duplicate-only text. The actual page therefore lost that short guidance despite correct static HTML. Reported to the coordinator; the frontend owner corrected both versions to the same optional-email/username-required/contact-administrator guidance. **Closed by final source inspection**, followed by passing frontend syntax and scoped whitespace checks. No unresolved product finding remains.

## Independent verification

Executed:

```powershell
node --test --test-name-pattern='username-only|an imported account|mixed pasted' tests/user-import-upload.test.js
```

**4/4 passed**, zero failures, duration approximately 2.75s. Assertions prove:

- omitted/blank/null/whitespace and explicit synthetic addresses create distinct unverified accounts; malformed email and missing-both-identifiers skip with separate codes;
- within-batch/repeated username-only imports do not rewrite existing accounts, and skipped rows never enter the no-email success list;
- a user actually created by the importer reaches `contact_admin`; account-bound send/setup create no mail, email-code row, session or password; a second imported user with a real password can log in normally;
- mixed pasted data keeps successful missing-email rows separate from invalid-email and duplicate skips, with complete counts/source details.

`node --check` passed for `server.js`, `models/User.js`, admin users JS and both import regression files. `git diff --check` passed for those files and the users template (existing LF/CRLF conversion notices only). The project has no dedicated lint or TypeScript command; repository syntax/API/browser gates remain the coordinator's responsibility.

## Final browser/source review

Final browser test source includes a real 15-row mixed file (8 creations, 6 without mailbox; 7 skips split as 3 duplicates, 2 invalid emails and 2 other errors), with independent group-count assertions and original row/account/reason checks. It also verifies actual imported passwordless accounts in an unauthenticated browser, absent setup/send controls, no mail/session creation, real-email verification, admin unbound display, a 2501-record file containing 25 username-only records, and complete duplicate-only reimport. Source review confirms all those assertions target the actual response/UI and persisted fixture users.

The browser owner reports the focused script passed at desktop 1440 and mobile 390 in `research/import-missing-email-browser.md`. These are owner executions, not reviewer execution. This reviewer independently viewed desktop `import-mixed-grouped-result` and mobile `contact-admin-unbound` screenshots: four visibly distinct counted result sections retain their rows/reasons; the contact panel has the administrator instruction and change-account action without email/password-setup controls or visible internal mailbox. The result screenshot predates only the final guidance-copy correction, which was verified directly in source. The coordinator owns final full-suite and screenshot refresh.

The API owner's final source also updates the BOM CSV regression to accept its username-only row (created 2/skipped 4), with the precise no-email success source row and separate invalid-email code. This closes the stale email-required test expectation recorded in the backend worker's intermediate report.

## Limits

No real user data, environment database or SMTP was used. Reviewer did not execute full suites, commit or deploy. The coordinator owns the historical pasted-result classification artifact and final acceptance; this report reviews the product/API/browser correction and does not independently claim that artifact's completion. Memory fixtures establish tested behavior, not production MySQL throughput or deployed proxy settings.
