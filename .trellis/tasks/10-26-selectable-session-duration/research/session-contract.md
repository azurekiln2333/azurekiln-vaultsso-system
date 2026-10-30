# Research: Session consumers, replacement deadlines, and regression strategy

- Query: Audit session consumers outside the normal authentication helper, account-change replacements, legacy compatibility, and controlled-clock testing for fixed 1/7/14-day sessions.
- Scope: internal
- Date: 2026-10-26
- Product decision supplied by the main session: default 1 day; choices 1, 7, or 14 days; fixed expiry from successful authentication. Research only; no product code changed.

## Findings

### Files and existing contracts

| File | Relevant responsibility |
| --- | --- |
| `server.js` | Cookie/JWT issuance, session validation, profile replacement, pending authentication, and security-management guards |
| `models/Session.js` | Durable row creation, active lookup, renewal, revocation, and cleanup |
| `models/Authenticator.js` | Held-connection account transactions and commit ordering |
| `services/account-merge.js` | Huawei account merge with an active, recently authenticated target session |
| `services/oidc-account-merge.js` | OIDC account merge with the same target-session protection |
| `db/init.js` | Existing sessions schema; expiry and creation timestamps already persist |
| `tests/support/fixture.js` | Isolated HTTP service, credentials, mail transport, account and login helpers |
| `tests/support/memory-db.js` | Session SQL adapter and JavaScript clock-dependent timestamps |
| `tests/security.test.js` | Cookie security, logout, revoke-other, legacy renewal, password-reset revocation |
| `tests/phone-api.test.js` | Profile replacement and self-administrator credential retention |
| `tests/multi-authenticator.test.js` | Current-session retention, five-minute enrollment proof, locked issuance races |

### Consumers outside `getAuthenticatedUser`

- `server.js:2255` re-reads the current session by real row ID inside existing-session OAuth authorization. It rejects revoked or expired rows. A fixed session row must therefore contain its actual selected final expiry, rather than the old one-hour idle expiry.
- `server.js:4673` (`mutateAuthenticators`) authenticates, acquires the account transaction, then re-reads the current session by ID and rejects revoked/expired rows before invoking a mutation. It will naturally honor a longer persisted expiry.
- `server.js:4699` (`authenticatorSecurityChanged`) revokes other sessions while retaining the current real row ID. It does not replace the current row or issue a new cookie. Preserve this behavior; do not restart the selected duration during enrollment, removal, recovery regeneration, or administrator self-reset.
- `server.js:4720` requires first-authenticator enrollment to originate from a session created within five minutes. `server.js:4744` binds an unfinished setup to that same session ID and its independent five-minute proof. A fourteen-day login must not count as fourteen days of recent authentication.
- Identity linking/merging also uses a separate five-minute freshness rule: `server.js:2288`, `server.js:2372`, `server.js:2798`, `services/account-merge.js:113`, and `services/oidc-account-merge.js:64`. Keep these checks independent of the chosen login duration.
- Profile phone and email changes use `req.authSession.created_at` plus optional current-password verification (`server.js:4032`, `server.js:4122`). Do not repurpose `created_at` as a synthetic old deadline carrier.
- Logout revokes the current row (`server.js:4593`); revoke-other-sessions keeps the current row by ID (`server.js:4617`); the session list exposes durable `expires_at` (`server.js:4601`). No new session-list column or schema field is required to display the correct end date.
- Cleanup deletes rows by their persisted expiry (`models/Session.js:67`, `server.js:5975`); fixed sessions need no special cleanup mechanism.

### Replacement is distinct from a new login

`PUT /api/profile` revokes all account sessions and OAuth credentials, then calls `setSessionCookie` for the current user after a password/email/phone change (`server.js:4254`-`4257`). Passing no policy would silently reset a selected seven/fourteen-day session to a fresh default day. Passing the original number of days and computing `now + days` would instead extend the original end date. Both violate fixed expiry.

The OIDC callback also calls `setSessionCookie` when `cookieState.linkUserId` is present (`server.js:2434`-`2444`), after validating the initiating live session. This is account management, so preserve the current authenticated policy and its deadline instead of accepting a new duration from callback/query fields. OIDC merge already returns while retaining the target row (`server.js:2414`-`2428`). Huawei link intent returns before fresh-session issuance (`server.js:2685`), and also retains its current row.

Recommended internal contract:

1. At authentication, derive and retain a trusted policy object containing `sessionDays` (`1`, `7`, `14`, or `null` for legacy) and the absolute session deadline. Derive it from the verified credential and corresponding active row, never from an account-change request body.
2. Capture that policy before revoking old rows. A replacement gets a new SID/row but the same fixed end date. Calculate cookie `Max-Age` from the remaining interval, not the original number of days.
3. Recheck the remaining interval immediately before replacement. Do not mint positive lifetime beyond the original end date if a slow mutation crosses it. This does not require redesigning the profile operation's existing transaction boundaries.
4. Preserve the existing revocation of all old credentials; replay of the old cookie must still fail after a successful replacement.

### Legacy replacement requires an explicit deadline carrier

The main session proposes a strictly whitelisted signed `session_days` claim for new fixed sessions and an optional signed `session_deadline` claim (epoch seconds) for the maximum deadline. This supports compatibility without a schema migration.

- A new fixed session uses the earlier of verified JWT `exp` and durable `sessions.expires_at`, never runs `Session.extend`, and never applies the old twelve-hour cap. Unknown/present-invalid policy values must fail closed, rather than silently entering legacy handling.
- A legacy token lacking `session_days` keeps the current one-hour sliding/twelve-hour maximum algorithm. If no signed deadline exists, derive its original absolute cap from the original row's `created_at` and `SESSION_ABSOLUTE_EXPIRY`. Existing tokens are not automatically upgraded to a day or longer.
- When a legacy session is renewed or replaced, carry that original absolute cap in signed `session_deadline`. Subsequent legacy validation/renewal must cap expiry by both `row.created_at + legacy absolute TTL` and that signed deadline. Keep the deadline on every renewed token.
- Merely copying a legacy JWT's old `exp` to a fresh row is insufficient: a later renewal otherwise recomputes a fresh twelve-hour maximum from the replacement row's `created_at`. A signed maximum-deadline carrier closes that extension path.
- Resetting `created_at` to its original value would avoid the extra claim, but requires model/adapter changes and alters the five-minute recent-authentication semantics. Retaining/rotating the original row requires changing the current revoke-all workflow. Both are broader than the optional signed deadline.
- `session_deadline` is internal authenticated state, not a user-supplied duration API field. Check for finite integer timestamps and never let it bypass the JWT/row expiry or revocation checks.
- Use second-aligned absolute expiry, or account explicitly for the subsecond rounding of JWT `exp`, cookie `Max-Age`, and MySQL `TIMESTAMP` (`db/init.js:214`). Boundary tests should compare one-second tolerances without allowing deadline extension.

No schema change is needed: `sessions.expires_at`, `created_at`, `revoked_at`, and row identity already supply durable enforcement (`db/init.js:214`, `models/Session.js:8`). The policy/deadline claims remain protected by existing signature/issuer/audience validation.

### Existing cookie/transaction ordering

- Password issuance already separates the transactional row creation (`server.js:1482`) from post-commit cookie application (`server.js:1505`). Keep new lifetime data in that same deferred result.
- `setSessionCookie` currently writes a response cookie inside transaction callbacks for OIDC (`server.js:2444`), Huawei browser login (`server.js:2755`), and external MFA (`server.js:3222`). `models/Authenticator.js:19` commits after the callback returns. This existing ordering predates the feature.
- Scope the feature to the policy/deadline passed through those existing issuers. Do not introduce further precommit side effects or broaden this task into an account-transaction rewrite. Existing password rollback regressions must remain green; the memory adapter does not establish live MySQL commit behavior.

### Controlled-clock regression strategy

The repository runs tests on Node `>=22`; the installed runtime inspected here is `v24.15.0`. A read-only local probe confirmed that `mock.timers.enable({ apis: ['Date'], now })` and `mock.timers.setTime(...)` advance both `Date.now()` and `new Date()` without mocking `setTimeout`. No test service or external transport was started for that probe.

- Use a dedicated `tests/session-duration.test.js` with the normal fixture and test-scoped Date mocking. Restore via the test mock lifecycle or `t.after`; do not replace only `Date.now`, since session SQL lookup in the adapter uses `new Date()` (`tests/support/memory-db.js:14`, `:580`).
- Keep real timers available for HTTP/fetch and account locks. Do not advance every timer or wait real hours/days. No background cleanup tick is required: active session lookups enforce expiry on each request.
- `tests/support/fixture.js:9` selects test mode before requiring the server, replaces SMTP with an isolated transport (`:48`), and creates an in-memory database (`:65`). `f.login(account, extra)` already forwards a duration field (`:93`); fixture changes are not inherently needed.
- For each choice, inspect JWT expiry, the row end date, and `Set-Cookie`; verify access after two hours and thirteen hours; verify access just before and rejection at/after the selected boundary; verify ordinary requests neither alter the deadline nor reissue a sliding cookie.
- Check that expiry of either the JWT or row rejects access even when the other remains future-dated. A revoked row must fail immediately even with a fourteen-day JWT.
- For replacement, sign in for seven/fourteen days, advance several days, change a phone or password with current-password proof, then assert the replacement ends at the original date and old-cookie replay fails. Cover OIDC link callback similarly in its existing isolated-provider suite.
- Construct legacy tokens explicitly in the style of `tests/security.test.js:268`. Cover old sliding renewal, the original twelve-hour cap, replacement near that cap, and preservation of `session_deadline` through another renewal on the fresh row.
- Keep the existing legacy renewal regression (`tests/security.test.js:268`) meaningful; merely extending its expected hour to a day would lose compatibility coverage.
- Reuse existing logout (`tests/security.test.js:247`), revoke-other (`:259`), password-reset (`:449`), profile credential replacement (`tests/phone-api.test.js:130`), and current-row-retention/final-issuance race tests (`tests/multi-authenticator.test.js`). Add selected-duration variants where needed rather than duplicating every unrelated flow.

## Affected Files and Validation Commands

Product changes should remain concentrated in `server.js` and the login page/script/translations. `models/Session.js`, `db/init.js`, and the SQL adapter need no changes for the recommended claim/deadline design. Account-change and OIDC-link handling inside `server.js` are required parts of that boundary.

Suggested focused checks after implementation:

```text
node --test tests/session-duration.test.js tests/security.test.js tests/phone-api.test.js tests/password-mfa.test.js tests/login-email-gate.test.js tests/oidc.test.js tests/huawei-native-mfa.test.js tests/multi-authenticator.test.js tests/i18n.test.js
node tests/account-first-login-browser.cjs
node tests/password-mfa-browser.cjs
node tests/login-email-gate-browser.cjs
node tests/browser-smoke.cjs
npm run check:syntax
```

Use `npm run check:e2e` for the final backend gate: `scripts/check-e2e.js:6` discovers all `.test.js` files and runs them with test concurrency one. New browser coverage should be included in the existing package command if a separate browser file is added. Avoid unrelated broad retesting once the required gate passes.

## Related Specs

- `.trellis/spec/backend/password-verification.md`: pending challenges, atomic factor consumption and post-commit cookies.
- `.trellis/spec/backend/multiple-authenticators.md`: current-row retention, freshness, held-connection checks and final-issuance races.
- `.trellis/spec/backend/account-bindings.md`: profile reauthentication and credential revocation.
- `.trellis/spec/frontend/auth-feedback.md`: localized readable status, account-first steps and stale-response ownership.

## External References

None needed. Findings use the repository's source/specs and the installed Node runtime. The Date-mock probe establishes local API availability, not a promise about other installed runtimes.

## Caveats / Not Found

- This audit ran no application tests and changed no product code. Recommended tests remain future validation work.
- The fixture cannot prove live database lock/commit semantics, deployed proxy behavior, real browser cookie retention policies, or external-provider availability.
- No technical blocker was found for the proposed no-migration design. The legacy replacement cap and the OIDC link-intent replacement are the two easy-to-miss correctness requirements.
