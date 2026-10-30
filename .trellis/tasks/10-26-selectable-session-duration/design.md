# Selectable Login Session Duration: Design

## Scope and Ownership

Implement PRD R1-R8 as one cross-layer deliverable: a web login selection whose fixed deadline is honored throughout authentication and later session replacement. Keep the existing session table, session revocation mechanisms, OAuth token policy, source-specific authentication rules, and account transaction boundaries.

`server.js` remains the single owner of browser-session policy and login input normalization. The login template/script own the selector and local provider-link parameters. Shared i18n owns the labels and readable validation text. Existing session persistence can store the selected absolute expiry without a database migration.

## Public Input Contract

| Boundary | Field | Accepted values | Missing value | Invalid value |
| --- | --- | --- | --- | --- |
| Password credential POST | `session_days` | JSON integer 1/7/14; exact string `1`/`7`/`14` for form submissions | 1 day | 400 with a localized readable key; no session or pending challenge |
| Local OIDC login initiation | `session_days` query | Exact single string `1`/`7`/`14` | 1 day | 400 before redirect/state issuance |
| Native Huawei login that can establish a gateway session | `session_days` | Same normalized input contract | 1 day | 400 before credentials or login continuation are issued |
| MFA / mailbox completion and binding skip | Original persisted context | Server-normalized duration saved by the initial request | Compatibility default for an old pending context | Do not treat a new request-body value as a replacement choice |

Reject coercive inputs such as booleans, null, arrays, non-integers, extra whitespace, and duplicate field values. Validate at the relevant login entry; account discovery remains stateless and cannot issue credentials. Registration's existing automatic login uses the same 1-day default without adding another selector to registration.

## Fixed Session Contract

Use a small normalized internal policy containing a supported duration (or an explicit legacy policy) and an absolute deadline. New login requests create the deadline only after every required factor has succeeded, immediately before durable session issuance. Waiting on the verification page does not consume the selected login period.

For new sessions:

1. Capture one issuance timestamp and compute the deadline as that timestamp plus the selected whole number of days. Align stored/signed deadlines at seconds precision so the JWT, SQL expiry, and cookie cannot disagree by an unintended interval.
2. Persist `sessions.expires_at` at that deadline using the existing connection-scoped session model.
3. Sign a session JWT with strictly validated `session_days` identifying the new fixed policy, signed `session_deadline` in integer epoch seconds, and `exp` equal to that deadline. A present invalid duration/deadline marker fails closed; it must not fall through to legacy handling.
4. Issue the normal HttpOnly, Secure-as-configured, SameSite=Lax cookie with a remaining Max-Age ending at that deadline. Preserve path and configured domain behavior.
5. Authenticate only while the JWT is valid, its matching row is active and owned by the same subject, and the account is present and allowed. The earlier signed deadline / row expiry always wins.
6. Do not invoke `Session.extend` or rebase the deadline for a fixed session on ordinary requests. A request near expiry cannot turn a 1-day selection into a rolling session.

Both direct `setSessionCookie` and transaction-bound `issueLoginWithinTransaction` must use this same policy calculation. `applyIssuedLogin` receives the already calculated policy and publishes cookies only at its existing post-commit stage. Avoid a broad rewrite of authentication or database transactions.

## Legacy Sessions and Credential Replacement

Tokens without the fixed-duration marker retain existing legacy authentication and renewal behavior. They are not silently upgraded. The existing `SESSION_ABSOLUTE_EXPIRY` setting continues to control that compatibility path; API `TOKEN_EXPIRY` and `REFRESH_TOKEN_EXPIRY` retain their existing meanings.

Derive a legacy session's original absolute cap from its authenticated row. Retain it in signed `session_deadline` on renewal or replacement, while leaving `session_days` absent to retain legacy semantics. Validate that a supplied internal deadline is a finite integer; keep applying the smaller of that original cap and the legacy calculation. Otherwise a profile edit or link callback would reset the cap merely by changing `created_at`. Old credentials lacking both new claims continue to derive their original cap from their existing row.

Expose the validated current policy on request-local authenticated state. Profile password/email/phone replacement and OIDC link intent must pass that policy explicitly to session issuance. They must not infer a fresh-login choice from their request fields. For a fixed session, preserve the same final expiry; for a legacy session, preserve both its remaining active window and original renewal cap. Recheck that the remaining lifetime is positive before creating a replacement. Leave `created_at` and its independent five-minute recent-authentication guards in their existing roles.

The new policy cannot be used to override existing immediate revocation. Session revocation, password reset, and bans remain authoritative even with an unexpired JWT. TOTP management currently retains the real current session row and therefore needs no deadline reset.

## Authentication Continuation

- Password entry normalizes the choice before it can create a challenge or session.
- Password TOTP, recovery, ordinary email verification, mandatory email bind/verify, and direct-code-to-mailbox transitions persist and copy `sessionDays` in the existing database pending context. Read it from the freshly checked parent when completing a stage. Do not widen the original password-proof deadline, challenge timeout, or attempt budget.
- OIDC initiation stores `sessionDays` in the existing signed state cookie. Callback uses that value for a real new login and copies it into persisted pending state if a local factor follows. Link/merge intent retains the authenticated session policy rather than applying the new-login default.
- The web provider anchors carry the current selection to the local OIDC initiation endpoint. They retain existing `provider` and safe `return_to` parameters; the added field is not passed to the upstream provider.
- Huawei login transports the optional normalized value through the existing binding token and MFA context only where a gateway cookie is eventually created. An OAuth authorization-code handoff continues to produce no gateway session. Linking or merging an already authenticated identity cannot restart a login duration.
- Legacy pending challenges lacking the field use the new-login default at completion; their existing short-lived proof deadline remains intact.

## Web Interaction

Place a labeled native select for keeping login state inside the existing sign-in form, visible at account and password entry so the same choice can apply to external sign-in. Offer 1 day, 7 days, and 14 days, initially selecting 1 day. Use existing form control styles and accessible label association; add narrowly scoped styling only if the inherited control fails actual layout checks.

Use the existing form serialization. Preserve the selected value during account-step changes and language rendering; do not store passwords or session credentials in browser storage. Do not introduce a cross-device preference or apply the select to an already established session without a new successful login.

Update provider links after hydration and on selection changes so normal click, keyboard activation, and opening a link in another tab use the current value. Keep ordinary OAuth continuation parameters unchanged. During an actual credential submission, capture and consistently use the submitted selection.

Add simplified Chinese, traditional Chinese, and English strings. Version changed JS/CSS references in every affected template, including shared i18n consumers if its URL needs changing. Verify the real rendered form at desktop and phone widths.

## Expected File Boundary

| Files | Purpose |
| --- | --- |
| `server.js` | Policy/input owner, fixed/legacy authentication, issuance, replacement, and all relevant continuation paths |
| `views/auth/login.html`, `public/js/pages/auth/login.js` | Duration selector, submission, and external link propagation |
| `public/js/shared/i18n.js`, affected referencing templates | Three-language labels/errors and matching shared asset versions |
| `public/css/vaultsso-authorize.css` only if needed | Native selector fit within the existing control system |
| `tests/session-duration.test.js`, `tests/session-duration-browser.cjs` | Focused policy, continuation, browser, and clock regressions |
| Existing security/MFA/OIDC/Huawei/browser/i18n tests | Targeted extensions where their existing fixtures are the clearest proof of an affected path |
| `package.json` | Include the new browser regression in the existing browser-check command |
| `.env.example`, `README.md` | Explain selected browser lifetime versus legacy cap and independent API token lifetimes |
| `.trellis/spec/backend/session-duration.md`, relevant spec indexes | Preserve the verified final contract after implementation |

No model/schema change is expected. Extend the memory adapter only if an actual needed persistence query changes; do not change production schema just to carry policy already present in the signed credential and existing expiry column.

## Validation and Delivery

Use isolated in-memory fixtures, captured mail, and local mocked identity providers. Native Node Date mocking must advance both `Date.now()` and `new Date()` so JWT and SQL-adapter checks agree. Keep real HTTP timers available; restore the clock after each scenario.

Cover all three durations; idle periods over 1 hour and over 12 hours; exact expiry; no extension from activity; repeated replacement; invalid/missing inputs; persisted verification choices; body override attempts; legacy renewal and rotation caps; and immediate revocation. Retain existing factor, phone-scope, OAuth-token, source-policy, and transaction rollback coverage.

Deliver code and local verification evidence. Live deployment, actual elapsed-day waiting, and a production MySQL test are outside local validation. Rollout requires the usual application/static-asset update and no new database migration. A rollback to old session policy may shorten newly issued long sessions and require users to sign in again; no data migration needs reversal.
