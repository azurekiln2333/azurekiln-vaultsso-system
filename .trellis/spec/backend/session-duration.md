# Browser Login Session Duration

## 1. Scope / Trigger

Applies to new browser logins, authentication continuations, session authentication, and credential replacement after account changes. Browser persistence has a fixed user-selected deadline. OAuth access/refresh tokens and short-lived verification proofs retain their own policies.

The previous browser policy reused `TOKEN_EXPIRY` (normally one hour) and applied `SESSION_ABSOLUTE_EXPIRY` (normally twelve hours). An expired JWT could not reach sliding renewal, causing idle sign-outs. New sessions must not inherit either limit.

## 2. Signatures

- `POST /oauth2/authorize`: optional `session_days` on credential login. Account discovery grants no session authority.
- `GET /api/v1/auth/oauth/oidc/login`: optional local query `session_days`; retain the normalized choice in signed OIDC state.
- `POST /api/v1/auth/oauth/huawei/quick-login`: optional `session_days`; retain it through pending binding/MFA where a gateway session will be issued.
- `POST /api/v1/auth/oauth/oidc/complete` and Huawei binding completion: consume the original server-saved choice; a completion-body `session_days` cannot override it.
- `createSessionToken`, `setSessionCookie`, and `issueLoginWithinTransaction` in `server.js` share the browser policy. `applyIssuedLogin` publishes transaction-issued password-login cookies at its existing post-commit boundary.
- `normalizeSessionDays(value, allowString = false)` returns a supported integer/default or `null` for invalid input. Only form/query entry points enable exact string values; JSON bodies and saved internal contexts require integers. `sessionPolicyForIssue(options)` constructs a final policy; `authenticatedSessionPolicy(session, row)` validates the authenticated policy or returns `null`.
- `req.authSessionPolicy` contains `{ sessionDays, expiresAt, deadline }`: `expiresAt` is epoch milliseconds, `deadline` is integer epoch seconds, and `sessionDays: null` identifies legacy compatibility. Replacement callers pass this trusted state explicitly.
- `sessions.expires_at` stores the deadline using the existing session model. No schema change is required.

## 3. Contracts

### Public duration and continuation

JSON accepts only integers `1`, `7`, or `14`. Form/query values accept only the exact strings `"1"`, `"7"`, or `"14"`. An absent value defaults to one day; null, booleans, arrays, decimals, whitespace padding, and duplicate values are invalid.

Persist the normalized integer as `sessionDays` in pending contexts, successor stages, OIDC state, and Huawei binding state. Start the selected period only when all required factors have succeeded. A TOTP/recovery-to-mailbox transition must copy the choice without extending the original password-proof deadline or attempt budget. Old pending contexts without the field use the one-day default.

Only the local OIDC start URL receives the browser's selection. Do not add `session_days` to the upstream provider's authorization request. Native Huawei OAuth authorization-code handoff must continue issuing no gateway session cookie.

### Fixed sessions

For a successful new login, capture a single seconds-aligned issuance time and calculate an absolute deadline. The JWT has supported integer `session_days`, integer epoch-seconds `session_deadline`, and `exp` equal to that deadline. The durable row and persistent HttpOnly cookie end at the same deadline. Derive a replacement cookie's Max-Age from the remaining time.

Validate the signed policy as well as JWT purpose/issuer/expiry, live row ownership and expiry, and current account availability. A present-invalid policy fails closed. The earlier row or signed deadline wins; activity must not extend it or call `Session.extend` for a fixed session. Logout, revocation, password reset, and bans remain immediately authoritative.

### Legacy compatibility and replacement

A JWT without `session_days` retains legacy sliding behavior and the configured absolute cap. Derive the original cap from its authenticated row. Once a legacy credential is renewed or replaced, carry the original cap in signed `session_deadline`; continue enforcing the earlier of that cap and the current legacy row calculation. Do not silently upgrade old sessions.

Profile password/email/phone changes and OIDC link callbacks that replace a session must use the trusted policy from the authenticated request. A fixed replacement retains the exact deadline. A legacy replacement retains its remaining active expiry and original absolute cap. Recheck positive remaining lifetime before issuance; neither a request body nor a fresh row's `created_at` can restart it. Leave `created_at` intact because five-minute recent-authentication restrictions depend on it. Authenticator/Huawei/OIDC merge operations that retain the current row continue doing so.

`TOKEN_EXPIRY` and `REFRESH_TOKEN_EXPIRY` remain OAuth token settings. `SESSION_ABSOLUTE_EXPIRY` applies to legacy sessions only. Registration's automatic login uses one day. Preserve existing transaction and side-effect ordering; this policy is not a general authentication transaction refactor.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Missing duration at a new login entry | One-day fixed session after all factors succeed |
| Supported integer or exact form/query string | Selected fixed duration |
| Unsupported/coercive/duplicate input | Readable 400 with `auth.session.invalid_duration`; no new session or pending login |
| Completion body asks for a longer duration | Original pending choice remains authoritative |
| Present-invalid signed policy | Reject authentication; never fall back to legacy |
| Signed deadline or durable row has expired | Reject; no renewal or replacement can revive it |
| Row revoked, user banned/deleted | Reject despite an unexpired JWT |
| Ordinary request during fixed validity | Authenticate without moving expiry or reissuing a sliding cookie |
| Profile/OIDC replacement | New credential with the original remaining policy; revoked old credential stays invalid |
| Expired pending factor proof | Existing factor-expiry error; long login selection cannot prolong proof |

## 5. Good / Base / Bad Cases

- Good: select fourteen days, finish required mailbox verification, stay idle thirteen hours, then open the profile with the original fixed deadline.
- Base: an older client omits the new field and receives one day after successful authentication.
- Good: update a phone several days into a seven-day login; the new credential ends at the original deadline.
- Bad: rebuild a seven-day deadline as `Date.now() + 7 * DAY` during profile replacement; this would silently extend login.
- Bad: preserve only legacy `exp` during replacement, then derive the next renewal cap from the new row; this would restart the old absolute limit.

## 6. Tests Required

`tests/session-duration.test.js` must exercise the real login/authentication routes with isolated memory storage and captured SMTP. Inspect signed JWT, row and cookie deadlines for all choices. Advance beyond one hour and twelve hours, just before expiry, and to the exact deadline. Prove no sliding extension, independent row/JWT enforcement, revocation, invalid inputs/claims, fixed replacements and repeated legacy rotation.

Extend existing password/mailbox, OIDC and Huawei fixture suites to prove choice propagation, ignored completion overrides, unchanged proof/OAuth token TTLs, linking replacement, and no-cookie native OAuth handoff. Preserve five-minute recent-authentication coverage.

Controlled time must advance both `Date.now()` and `new Date()`: the memory DB uses the latter. In the local Node 24 test environment, use `t.mock.timers.enable({ apis: ['Date'], now })` and `t.mock.timers.setTime(...)`, with cleanup between scenarios. Leave network timers real. Mocking only `Date.now` cannot prove durable expiry.

`tests/session-duration-browser.cjs` covers native selection, account/locale retention, actual credential submission, local provider URL updates, MFA and persistent-cookie reuse in a fresh browser context. Inspect actual desktop/phone images for all three locales. Memory/provider fixtures do not establish production MySQL, deployment, or live external-provider behavior.

## 7. Wrong vs Correct

Wrong:

```js
const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
// Or reset now + selected days during a credential replacement.
```

Correct:

```text
fresh login: normalized original choice -> final successful authentication
             -> one absolute deadline -> JWT, durable row, cookie
replacement: validated current policy -> same remaining deadline
legacy rotation: preserve remaining expiry AND original signed absolute cap
```

Wrong: accept `req.body.session_days` when completing a saved MFA challenge.

Correct: read `sessionDays` from the freshly validated saved context, including every successor stage.
