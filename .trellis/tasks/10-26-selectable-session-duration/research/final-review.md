# Final full-scope review

Reviewed on October 26, 2026 against the approved PRD/design/implementation plan, all check-context references, and the pre-feature copies in `.artifacts/session-duration/baseline/`.

## Findings resolved during review

- `server.js`, `tests/session-duration.test.js`, `tests/huawei.test.js`: the initial normalizer also accepted exact numeric strings from JSON. The approved contract restricts JSON to integers and permits exact strings only for form/query transport. The backend implementer corrected this while review was in progress: `normalizeSessionDays(value, allowString = false)` allows strings only at the explicit form/query callers. Password and Huawei regressions reject JSON `"7"`; the Huawei test also proves invalid input does not consume the upstream code or create credentials. No duplicate product edit was made by the reviewer.

## Findings remaining

No unresolved findings. Main synchronized the normalizer's final signature/transport rule and clarified the account-bindings description of replacement with the original remaining deadline and legacy cap; the reviewer verified both updates.

## Scope and acceptance review

| Criteria | Reviewed evidence |
| --- | --- |
| AC1, R1/R7 | Accessible labeled native selector, exactly 1/7/14 with default 1, actual form serialization, account/password and locale retention, provider hydration/change/reset URL handling. Browser suite covers desktop/mobile and all three locales. |
| AC2/AC3, R2 | One seconds-aligned issuance deadline shared by signed JWT, durable row and cookie. Controlled Date tests cover all choices, 2h/13h inactivity, no renewal during activity, exact expiry and independent earlier JWT/row expiry. Fixed authentication does not call `Session.extend`. |
| AC4, R3 | Normalized original selection is persisted and reread under the account lock. Password email/TOTP/recovery, direct-factor mailbox successors, OIDC signed state, Huawei pending binding/skip and external MFA retain it. Completion overrides are ignored. Native Huawei authorization-code paths still return no gateway session cookie. |
| AC5, R4/R6 | JSON integers versus exact form/query strings; missing default; invalid/null/boolean/array/unsupported/whitespace/duplicate input; old pending defaults and present-invalid claims fail closed. |
| AC6, R5 | Active row ownership/expiry, account checks and existing revocation remain in authentication. Focused tests cover logout, other-session revoke, reset and ban before a 14-day deadline. |
| AC7, R6 | No OAuth token or proof-TTL policy changes. Tests assert one-hour access tokens, seven-day refresh tokens, existing email-code expiry and original pending-proof deadlines/attempt behavior. |
| AC8, R8 | Profile phone/password/email and OIDC link replacements pass trusted request-local policy. Fixed deadlines remain exact; legacy expiry and original absolute cap survive renewal and repeated rotation. Existing five-minute guards and current-row retention are preserved. |
| AC9 | Source changes are confined to the planned server/UI/tests/docs/spec/cache boundaries. Shared i18n and changed login JS/CSS consumer URLs are synchronized. No model/schema/fixture changes or unrelated baseline reversions were introduced. Final full API integration is run by the main session. |

Reviewed the single-repository backend/frontend spec indexes, complete feature diff from baseline, all new session tests/browser test, existing-suite extensions, documentation and all changed cache references. Existing external-issuer transaction boundaries were preserved; password issuance still applies cookies after commit.

## Verification

- Reviewer ran `npm run check:syntax`: **passed, 108 files**, including browser script references. This is the repository's configured static check; no separate linter or TypeScript checker is configured.
- Reviewer ran `git diff --check`: **passed**. Git emitted only configured LF/CRLF conversion notices.
- Backend evidence: required ten-suite targeted command **234/234 passed**, followed by the focused Huawei JSON-string validation case **1/1 passed**. See `backend-implementation.md`.
- Frontend evidence: new session-duration browser suite, account-first browser suite, password-MFA browser suite, mailbox-gate browser suite and **21/21 i18n tests passed**. See `frontend-implementation.md`.
- Reviewer opened `password-mobile-en-US.png`, `password-desktop-zh-TW.png` and `account-desktop-zh-CN.png`: labels, native arrow, field alignment and available actions render correctly. Frontend worker inspected all twelve final screenshots; main also inspected representative phone/desktop images.
- Main owns the final `npm run check:e2e` integration result and task acceptance bookkeeping; the reviewer did not duplicate that full suite.

## Limits

Checks use memory storage, captured SMTP and isolated local provider fixtures. Fresh browser-context cookie reuse is tested; real elapsed-day persistence, production MySQL, live providers and deployment are not claimed. No staging, commits, task status changes or unrelated edits were performed by this reviewer.
