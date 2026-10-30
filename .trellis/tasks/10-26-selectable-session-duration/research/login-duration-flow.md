# Login Duration Flow

## Confirmed Outcome

The user confirmed the proposed default of 1 day and fixed expiry, with explicit 7-day and 14-day choices. This document describes the existing paths to be changed; it is not evidence that implementation has happened.

## Current Expiration Owner

- `server.js:551` parses API access-token duration; `server.js:553` reuses it as `SESSION_MAX_AGE`; `server.js:554` reads the separate legacy absolute cap.
- `server.js:1157` signs the browser JWT, `server.js:1164` produces cookie options, `server.js:1171` directly creates a persisted session, and `server.js:1482` separately creates a transaction-bound session.
- `server.js:1183` verifies the JWT before attempting renewal. A JWT that has already passed its one-hour expiry cannot be renewed. A still-valid legacy session is capped by the row's creation time plus the configured absolute lifetime.
- The inspected local expiry values match `.env.example:45`: 1-hour access tokens, 7-day refresh tokens, and a 12-hour legacy browser-session cap. No secret values were needed for this finding.
- `models/Session.js:8` already persists an explicit `expires_at`; `models/Session.js:22` filters both revocation and expiry; `models/Session.js:44` conditionally extends only live rows. A fixed 14-day expiry needs no new column.

## Login and Continuation Boundaries

| Entry / continuation | Existing owner | Required transport of the selection |
| --- | --- | --- |
| Web account discovery and password entry | `views/auth/login.html:49`, `public/js/pages/auth/login.js:553`, `server.js:3260` | A named selector in the login form; discovery never authenticates; credential submission captures the current value. |
| Password authenticator or email challenge | `server.js:1420`, `server.js:1335` | Persist a normalized `sessionDays` in the pending context, alongside the current proof deadline. |
| TOTP/recovery to mandatory mailbox transition | `server.js:3182` | Copy the original normalized duration to the new pending row instead of reading completion-body fields. |
| Direct TOTP plus mandatory mailbox gate | `server.js:3496` | Add the original duration to the successor context created inside the same account transaction. |
| Mandatory mailbox completion | `server.js:3129` | Use the freshly read parent context when issuing the final session. |
| Ordinary password or direct-code completion | `server.js:3536` | Pass the normalized initial duration to transaction-bound session issuance. |
| OIDC provider link on the sign-in page | `public/js/pages/auth/login.js:246` | Update the local login URL's `session_days` whenever the selector changes, including after provider hydration. |
| OIDC initiation / callback | `server.js:2272`, `server.js:2292`, `server.js:2434` | Validate the local query parameter, save it in signed state, then use that saved value directly or in persisted MFA context. Do not add it to the provider's OAuth request. |
| Huawei direct login / MFA | `server.js:2668`, `server.js:2776` | Validate the optional login input once and carry it through the existing pending context. Preserve the native OAuth branch that does not issue a gateway session. |
| Huawei binding-required / skip | `server.js:2862`, `server.js:2874` | Store the initial choice with the existing binding token and restore it on skip. A later request cannot replace it. |
| Registration's immediate sign-in | `server.js:3818` | Use the same new-login default; no additional registration duration UI is necessary. |

## Compatibility and Boundaries

- `session_days` is an optional local-login parameter, not an OAuth authorization parameter or access-token claim. Existing clients omit it and obtain the 1-day new-login default.
- Accept integer JSON values 1, 7, and 14 and their exact decimal form/query string equivalents. Reject null, arrays, booleans, decimals, whitespace-padded variants, unsupported integers, and duplicate form/query values.
- The completion endpoint uses the persisted original choice; an extra `session_days` in a completion request is not a policy update.
- Existing signed session tokens without the new duration marker keep their configured legacy renewal and cap. New sessions must not derive their validity from `TOKEN_EXPIRY` or be clipped by the legacy `SESSION_ABSOLUTE_EXPIRY`.
- Preserve existing same-origin checks, session revocation, account bans, source-specific factor requirements, verification attempt limits, and pending proof expiry.
- See `session-contract.md` for the focused audit of session consumers, replacement paths, and controlled-clock verification.

## Applicable Specs

- `.trellis/spec/backend/password-verification.md`
- `.trellis/spec/backend/multiple-authenticators.md`
- `.trellis/spec/backend/account-bindings.md`
- `.trellis/spec/frontend/auth-feedback.md`
- `.trellis/spec/frontend/surface-guidelines.md`

No external service requests, real-mail delivery, production database operations, or product-code edits were required for this research.
