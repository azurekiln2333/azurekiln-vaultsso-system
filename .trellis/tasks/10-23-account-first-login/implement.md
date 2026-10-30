# Implementation Plan

## Entry Gate

- [x] User consented to create a task and enter planning.
- [x] Four designated Herdr Pi agents completed independent research and technical follow-up.
- [x] User selected masked email with explicit code sending.
- [x] User selected a direct contact-administrator instruction for no usable email.
- [x] Consolidate PRD, technical design, import answer, and real spec/research manifests.
- [x] Presented the final planning summary. The subsequent user message “还没做好？？” expressed the expectation that the described work proceed; the coordinator is proceeding on that steering without asking again.
- [x] Loaded Phase 1.4; activate implementation on this subsequent turn.

## Workspace and Ownership

Use the existing four Pi agents in workspace `w1Q` without changing layout, focus, or cwd. Every dispatch starts `Active task: .trellis/tasks/10-23-account-first-login`, supplies the approved artifacts/manifests and Trellis implement/check role instructions, and states that other agents' edits must not be reverted.

| Worker | Exclusive implementation ownership | Coordination |
| --- | --- | --- |
| Pi w1Q:p3 | `server.js`, `models/User.js`, relevant public API documentation | Implements discovery and account-bound send/reset together because these share the server file. Publish the final response/error contract before the frontend/API tests depend on it. |
| Pi w1Q:p5 / auth-frontend | `views/auth/login.html`, `public/js/pages/auth/login.js`, `public/js/shared/i18n.js`, minimal login CSS if required | Implement approved steps, localized feedback, stale-response protection, CAPTCHA lifecycle, and asset versions. Do not edit browser tests or admin/import files. |
| Pi w1Q:p4 | New API regression tests and narrowly necessary `tests/support/fixture.js` / `memory-db.js` support | Test stateless discovery, first-password proof/state changes, conditional update, and legacy API compatibility. Preserve the fixture's current role-based callers; do not edit product code. |
| Pi w1Q:p6 | New two-step browser coverage and required existing `tests/*browser*.cjs` login interactions | Update real Continue interactions across affected tests; preserve pre-existing MFA test improvements. Do not add product shortcuts to satisfy old tests. |

The main coordinator owns task artifacts, spec updates, integration, and final review. If ownership must change, coordinate explicitly before editing. Save a baseline of already-modified affected files before implementation so the final diff can distinguish existing work. Do not reset, stash away, or commit unrelated changes.

## Ordered Execution

1. Backend worker publishes exact JSON fields, setup state-change errors, no-side-effect behavior, and the exact conditional SQL for the test-double owner. Confirm discovery is selected before required-password validation, and retain the original branch when the flag is absent. The initial-password update binds user ID and verified email, writes password/email-verified atomically, and reports actual affected rows; conflict returns before any session/token revocation.
2. Backend and frontend proceed in their independent file scopes. API test worker creates meaningful coverage and the fake-DB support required by the atomic User update. Browser worker prepares the new flow and updates login actions after the UI contract is stable.
3. Review email destination authority, mutually exclusive inputs, first-password-only gating, atomic update, CAPTCHA/limits, and preservation of old clients. No new schema or discovery credential.
4. Run each owner's focused tests. Resolve failures within the same ownership map; do not overwrite other workers' files to fix integration.
5. Main coordinator performs the full-scope Trellis check, records validation evidence, and updates both `backend/password-verification.md` and `frontend/auth-feedback.md` with the approved account-first contract and CAPTCHA visibility on the active password step.

## Validation

API coverage includes username/email identifiers, empty/null local passwords, unknown/ambiguous identifiers, banned/locked accounts, invalid OAuth, no discovery mail/session/code/attempt consumption, explicit send/cooldown, invalid/expired/replayed/other-account codes, stale account/email/password state, conditional-update conflict, and old email/native/direct-client behavior.

The R14 follow-up separates true zero-match discovery (404 `auth.account_not_found`) from ambiguous existing identifiers (200 `next: password`), preserves lock/OAuth precedence and generic recovery, and proves editable account/no password on desktop/mobile in all three locales. Backend ownership transferred from provider-failed p3 to the native Trellis implementer; after p6's provider failure, that implementer also owns only the account-first browser test. p4 API and p5 i18n ownership remain unchanged; sorting stays frozen.

Browser coverage includes account Continue without password, real password/MFA completion, first-password setup returning to password with no automatic login, contact-administrator branch, ordinary forgot password, stale discovery/send/setup responses, back/account changes, localized visible feedback, desktop/mobile layout, and OAuth state/nonce/PKCE including the existing long-state regression.

Proposed test files: `tests/account-first-login.test.js` and `tests/account-first-login-browser.cjs`. Add the new browser regression to the existing browser-check command as an integration change owned by the coordinator after the test file exists.

```powershell
node --test tests/account-first-login.test.js tests/password-mfa.test.js
node --test tests/security.test.js tests/oidc.test.js
node tests/account-first-login-browser.cjs
npm run check:syntax
npm run check:e2e
npm run check:browser
```

Use only isolated fixtures for these checks. Run the integrated browser suite once after the owner-level checks pass; repeat only if a new change/failure justifies it. Retain appropriate desktop/mobile screenshots from the new browser flow for visual review. Planning does not run these product tests or send real mail.

## Risks and Rollback Points

- Shared `server.js`: only the backend worker writes it. Stop and coordinate if another live agent is editing it.
- Existing dirty MFA/browser files: browser worker must extend the current versions, preserving all previous behavior/assertions.
- Mixed release: ship backend capability with/before updated login assets. Verified-mailbox clients retain behavior; incomplete-mailbox clients must implement R12 stages or fail closed.
- Stale first-password race: conditional update is mandatory; zero affected rows must not be reported as success.
- Restore only this task's additions if rollback is needed; preserve earlier admin/MFA work and user data.

## Before Completion

- [x] R19/AC18: implemented registration username filtering to ASCII letters/digits/underscore with caret/selection/deletion, pre-length clipboard filtering, native attributes and three-locale feedback; aligned strict raw submit/API checks. Independent review closed the post-composition Enter ordering gap with a 229 guard and regression. Preserved snapshots, legacy account/login/import and icon/password guidance; specs/API docs synchronized. Final root API 304/304, all eleven browser groups and syntax 106 files passed. Two earlier import browser timeout logs and passing diagnostic/final aggregate are retained without a speculative product workaround. See `research/username-input-contract.md`, `research/username-input-integration-check.md` and `research/validation.md`.

- [x] R18/AC17: implemented the packaged base-CSS icon slot and explicit target-face helper in all 13 templates, with actual delayed/failed/cached font loading, dynamic/admin iframe behavior and missing-face/unsupported-API simulations. Independent review found and closed a profile structural-overlay regression by separating its inner glyph; real hover/focus/click and zoom 1/2 at desktop/mobile pass. Final root eleven-group browser, syntax 106 files and packaging 4/4 passed; specs/evidence synchronized. Preserved `research/icon-font-loading-baseline.json`.

- [x] R13/AC12: implement and independently check admin user-list header sorting per `research/users-sort-contract.md`, preserve imports/actions and validate desktop/mobile behavior. Root ten-group browser aggregate passed.
- [x] R14/AC13: implement explicit zero-match feedback per `research/unknown-account-contract.md`; root 288 API tests, ten browser groups and syntax 104 files passed, with independent review and real desktop/mobile localized correction scenarios.
- [x] R15/AC14: fixed mobile Turnstile's viewport-based compact sizing and insufficient form width within login frontend/test scope; preserved token lifecycle and inspected simulated geometry screenshots. Focused five-width coverage, independent review, root ten-group browser aggregate and syntax 104 files passed. Backend remains unchanged from the passing 288-test checkpoint. Live Cloudflare is not claimed.
- [x] R16/AC15 and R17/AC16: native backend owner completed registration-only ASCII username validation and seven new API cases; frontend owner completed configured password guidance, localized username feedback and real 12/16 desktop/mobile plus three-locale/uncertain-config checks. Independent combined review and documentation review are clean. Root synchronized executable specs/API docs and passed syntax 104 files, API 301/301 and all ten browser groups. Earlier work and `research/registration-policy-baseline.json` are preserved; final evidence is in `research/validation.md`.

- [x] Remove the fixed import row-count cap across server/UI, preserving the 10MiB request-size bound.
- [x] API and browser regressions upload more than 2000 records and prove full creation, duplicate skips/details, and safe repeated import.
- [x] Recheck source integration and required project checks after the scale correction: 241 API tests, eight browser groups, syntax 101 files. Record evidence in `research/validation.md`.
- [x] Accept username-only import rows using established internal synthetic-mailbox storage; keep them unbound/unverified and show accurate UI guidance/status.
- [x] Prove actual file import to no-mailbox contact-admin login, no email side effects, username-only duplicate handling and continued >2000-record support; pre-R12 checks: 245 API tests, eight browser groups, syntax 101 files.
- [x] Add structured skipped reason codes and successful-no-email input rows; render and test separate counted groups with complete source details.
- [x] Classify the user's pasted historical result in gitignored local artifacts and verify all provided rows are retained exactly once (347 total, four duplicates and 343 old combined mailbox errors).
- [x] Consolidate four-Pi research plus independent security design review and freeze post-password mailbox API/stage/atomicity contract in `research/login-email-gate-contract.md` (2026-10-24).
- [x] Implement password/CAPTCHA -> TOTP -> required mailbox bind/verify -> final credential ordering in every local-password entry; preserve global email-code policy, external providers, passwordless setup and original OAuth continuation.
- [x] Verify the complete state matrix, challenge/target binding, races/replay, UI/localization and compatibility; final root checks: 286 API tests, nine browser groups, syntax 103 files, scoped whitespace check and exact-pending follow-up 1/1. B1–B12/F1–F4 closed; specs and evidence updated.

- [x] AC1–AC7 have evidence and all required checks pass; see research/validation.md.
- [x] Backend/password-verification and frontend/auth-feedback specs describe discovery, account-bound send/reset, the no-mailbox branch, and CAPTCHA rendering on the active password step.
- [x] Review final changed-file scope against the saved baseline.
- [x] The user subsequently requested a real file-upload correction after a 97KB import failed. The focused expansion is recorded in `research/import-upload-contract.md`.
- [ ] Commit/archive remains deferred. Implementation and verification are complete; no commit, push, deploy or archive is performed in this session.
