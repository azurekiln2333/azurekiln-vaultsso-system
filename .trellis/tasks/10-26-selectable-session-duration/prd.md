# Selectable login session duration

## Goal

Let users choose 1, 7, or 14 days of login persistence and remain signed in for the selected period, including after an hour of inactivity. Explain and remove the current premature-expiry policy without weakening explicit logout and session revocation.

## Background and Evidence

- The user reports frequent unexpected sign-outs and explicitly requests the three duration choices. Task creation and the default/fixed-duration rule were approved on October 26, 2026. After the complete planning package was presented, the user's instruction to continue approved implementation; no additional planning approval is pending.
- `.env.example:45` and the current local non-secret expiry settings specify `TOKEN_EXPIRY=1h`, `REFRESH_TOKEN_EXPIRY=7d`, and `SESSION_ABSOLUTE_EXPIRY=12h`.
- `server.js:551` derives the browser session's initial lifetime and renewal threshold from the API access-token lifetime. `server.js:1171` and `server.js:1482` issue a session with the smaller of that lifetime and the absolute lifetime. `server.js:1183` rejects expired JWTs before renewal and applies the creation-time absolute cap. Consequently, an hour without requests expires the current session; continued activity can only renew it within the twelve-hour cap.
- `server.js:1157`, `server.js:1164`, and `server.js:1505` produce the signed credential and persistent cookie, while `models/Session.js:8` persists the server-side expiry. All three boundaries must honor the selected period.
- `views/auth/login.html:49` and `public/js/pages/auth/login.js:553` own the login form and submission. `public/js/pages/auth/login.js:246` creates external-provider login links. `server.js:1335` and `server.js:1420` persist intermediate verification state.

## Requirements

- R1: Offer exactly 1 day, 7 days, and 14 days as readable login-duration choices on the web sign-in page. Preserve the selected value through account discovery, password entry, localized rendering, and any required verification steps.
- R2: Default to 1 day, with explicit 7-day and 14-day choices. Count a fixed period from successful authentication, without activity-based renewal. Apply the chosen period consistently to the browser cookie, signed session credential, and server-side session; the previous one-hour idle threshold and twelve-hour absolute cap must not shorten it. Closing and reopening the browser within that period retains login. Expiration requires a fresh login.
- R3: Carry the original choice through password, authenticator/recovery, mailbox verification/binding, and external-provider login continuation. A completion request cannot silently replace the duration that initiated its verification challenge. Preserve existing challenge deadlines and attempt limits.
- R4: Accept only the supported duration choices. Omitted values use the agreed default; invalid or unbounded values receive readable errors and never create an excessive-lifetime session.
- R5: Explicit logout, revocation from the session list, password-reset revocation, and account bans continue to invalidate access immediately. A long selected period must not resurrect a revoked or expired session.
- R6: Define compatibility for existing sessions and clients that omit the new field. Keep API access-token, refresh-token, CAPTCHA, and verification-code lifetimes independent of the new browser-login setting.
- R7: Keep the selector readable and usable at desktop and phone widths, with existing simplified Chinese, traditional Chinese, and English localization. Update the changed browser asset URLs so the new control and request handling load together.
- R8: When an authenticated profile change or external-account link replaces a session credential, preserve the original policy and deadline. Such operations must neither reset the choice to 1 day nor restart the chosen period. Existing-session compatibility must also prevent a replacement from restarting a legacy absolute cap.

## Acceptance Criteria

- [x] AC1 (R1, R7): The sign-in page exposes the three choices, uses the confirmed default, and submits the chosen value without breaking account-first discovery or mobile layout.
- [x] AC2 (R2): Each supported choice produces matching cookie and durable session expiry. Controlled-clock checks demonstrate that one-hour inactivity and the former twelve-hour cap do not invalidate a still-current selected duration.
- [x] AC3 (R2, R5): The confirmed expiration boundary is enforced; an expired credential or row cannot be renewed into a valid session.
- [x] AC4 (R3): Password and verification continuations retain the initial choice, including a TOTP/recovery-to-mailbox transition and external-provider continuation. Completion-body overrides do not extend it.
- [x] AC5 (R4, R6): Missing duration uses the confirmed default; unsupported values do not issue credentials. Existing-session compatibility is covered explicitly.
- [x] AC6 (R5): Logout, revoke-other-sessions, password reset, and bans still revoke access before the selected end date.
- [x] AC7 (R6): OAuth token lifetimes and verification-proof lifetimes retain their existing independent behavior.
- [x] AC8 (R8): Profile password/email/phone updates and OIDC linking retain the current session's remaining deadline; legacy rotation cannot reset its original absolute cap. Existing authenticator operations continue retaining the current session row.
- [x] AC9 (R1-R8): Relevant API, authentication browser, localization, and syntax checks pass. No unrelated working-tree edits are reverted or included in the feature's change boundary.

## Out of Scope

- Changing API token/refresh-token retention, upstream identity-provider login policies, or account expiration.
- Adding a separate administrative session-policy UI or arbitrary custom durations.
- Extending verification-code or pending-challenge deadlines to match the selected login duration.
- Revising the preceding SMTP error-display fix or unrelated authentication/UI work already present in the working tree.

## Planning Status

- No unresolved product decisions remain. The behavior is defined by R1-R8.
- The complete planning package is approved. Proceed with task activation, implementation, and verification within R1-R8.
