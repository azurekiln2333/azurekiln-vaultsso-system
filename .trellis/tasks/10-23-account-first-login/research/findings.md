# Consolidated Pi Research

## Collaboration and Evidence

The user requested the four Pi panes on the right of the `azurekiln-oauth2` Herdr workspace. Inventory and layout identified workspace `w1Q`, with top-to-bottom panes `w1Q:p3`, `w1Q:p5`, `w1Q:p4`, and `w1Q:p6`. Three Pi agents were idle; `p5` was an interactive shell after an earlier Pi lock error. A new Pi was successfully started there as `auth-frontend`, without changing layout or focus. All four agents were observed working on their assigned research.

| Pane | Research responsibility | Result |
| --- | --- | --- |
| w1Q:p3 | Discovery, auth contracts, limits | Account-only JSON probe can precede the password guard; native/password branches remain separate. Second review confirmed account-bound send/reset needs no discovery token. |
| w1Q:p5 / auth-frontend | UI state, forms, async feedback | Explicit account/password/setup/contact steps; inactive required controls, feedback placement, CAPTCHA visibility, and stale-response guards all need deliberate handling. Also inspected import results markup/CSS. |
| w1Q:p4 | Recovery, provider mailbox constraints | Reuse `password_reset` and `userId` verification. Derive the mailbox server-side each request. Placeholder mailbox gets the user-selected administrator message. |
| w1Q:p6 | API/browser regression and compatibility | Isolated memory DB/mail fixture is available. New passwordless and discovery tests are needed; existing browser login actions must explicitly use Continue. |

Reports were returned in the terminals. Pi `p6` history could not be recovered even with larger reads, so the documented Herdr fallback was used: it wrote its report to `D:/AppData/Local/Temp/account-first-login-tests-research.md`, which the coordinator read. This consolidated document supersedes the reports' earlier token/provider suggestions and unresolved questions.

## Confirmed Contracts

- `server.js:2685`, `:2688`, `:2711`: the current final-login handler requires a nonempty submitted password before it can return `auth.password.not_set` for an empty stored password.
- `models/User.js:95`: `findByUsername` searches both username and email and returns a user only for exactly one match. Unknown or ambiguous identifiers must not fall back to a different account lookup.
- `server.js:1863`: `validateAuthorizationRequest` is the shared registered-client/redirect/scope/PKCE validator. Preserve it for discovery requests carrying OAuth context.
- `server.js:379`: reuse `maskEmail`. `server.js:2141`: reuse `isSyntheticEmail` together with email format validation.
- `server.js:154`: existing HTTP/IP throttling covers sensitive routes. Discovery may check existing login locks without consuming a password attempt. Final login keeps the current CAPTCHA and password-attempt rules.
- `server.js:1735`, `:1764`: email code issuance and verification carry `purpose` and `userId`. Codes expire, have attempt limits, and are atomically consumed; delivery failures invalidate the issued code.
- `server.js:2847`: email-based send accepts registration and password-reset purposes, rejects invalid mailboxes, preserves generic HTTP 200 for an unknown reset mailbox, and enforces the existing 60-second cooldown. Preliminary Pi suggestions of HTTP 202 were corrected against source.
- `server.js:3017`, `:3072`: existing reset checks the email code, changes the password, revokes sessions/tokens, and marks email verified. A prior `email_verified` value is not a prerequisite.
- `models/User.js:43`: creating a user without a password stores an empty password marker. Historical/null state also needs coverage.
- `server.js:3307`: authenticated passwordless accounts can already set a first password in profile; this feature remains as-is and is not the new no-mailbox login instruction.

## Resolved Design Decisions

1. Discovery uses a strict JSON `discover_account: true` branch before final-login password validation. There is no new discovery cookie, token, database challenge, or authenticated session.
2. Unknown/ambiguous identifiers take the ordinary password step without an `exists` flag. Locked/banned/invalid OAuth requests retain the applicable existing errors.
3. Account-bound setup extends send/reset with a mutually exclusive `username` input. The server derives the stored email each time. Verification proof remains the existing purpose/user-bound email code; performing discovery is not an authorization prerequisite.
4. The new account-bound variant is first-password-only. Recheck account state on each operation; a conditional update bound to user ID, the verified email, and an unset password prevents stale setup overwrites. Set password/email-verified atomically and return zero-row conflicts before credential revocation.
5. Keep old email-based reset behavior, native `check_verification`, and direct credential clients. Do not add account-input auto-advance to conceal outdated browser tests.
6. No additional change to the email-code model or database schema is necessary. Existing email uniqueness and explicit `userId` verification already support this scope; unrelated defensive refactors are deferred.

## Frontend Integration Risks

- `login.js` currently locates the first `.submit` to place `statusMessage`. Setup must move feedback next to the actual active form/action rather than leave it in a hidden step.
- The password input is static for autofill but disabled/not required during account entry. Setup is a separate sibling form, avoiding duplicate password fields in one `FormData` payload.
- Preserve original OAuth hidden inputs and the omission of absent PKCE fields. Do not reset the original form merely to change steps.
- CAPTCHA initialization/refresh must consider the login substep, not just the outer card's visibility.
- Extend `modeRevision` or an equivalent request revision to account edits, step changes, and pending send/setup responses. Clear passwords, codes, masked destination, and timers on account changes.
- Keep new copy in every locale actually supported by `VaultI18n`; use text content for masked email. Reuse existing layout styles and bump affected asset versions.
- Final frontend review identified explicit follow-ups: contact_admin stays a section inside the login card; discovery needs its own JSON dispatch; re-entering login resets its step; the legacy password-not-set fallback must rediscover without a form reset; shared feedback must be safely reanchored for a no-submit contact panel.
- The frontend feedback spec currently describes CAPTCHA rendering when the whole login form becomes visible. Update it alongside the backend password-verification spec to describe the new active-password-step visibility rule.
- One frontend-review assertion was corrected with a headless Chrome DOM experiment: assigning `.value` on an `input[type=hidden]` updates its default value, and `form.reset()` retained the test OAuth state while clearing the text username. Do not claim the current hidden fields necessarily lose their values on reset. The no-reset step transition remains appropriate to preserve account/input state and avoid depending on element-specific reset behavior.

## Final Planning Review

All four Pi agents reviewed the final planning artifacts in their respective scopes. Backend/recovery found no product-contract blockers and requested implementation precision: validate username before discovery, preserve the legacy combined guard, reuse the same login lock key, coordinate exact conditional SQL with the memory-DB owner, return actual affected-row success, and stop before revocation on conflict. These details are incorporated in `design.md` and `implement.md`.

Frontend structural findings are incorporated above: contact section stays inside the login card, JSON discovery has a separate dispatcher, login re-entry resets step state, legacy fallback is replaced, active feedback handles no-submit panels, and both affected executable specs are scheduled for update. The browser reviewer found the explicit Continue/manual-send/admin-fallback/no-token test approach consistent with the final design. No implementation was dispatched during planning.

## Validation Design

The existing `tests/support/fixture.js` uses a memory pool, temporary settings/signing keys, fake mail transport, and test-only startup. It does not load a real `.env`. Its `user(role)` helper currently always creates a password; tests can create passwordless records through the User model or add a compatible helper without breaking existing callers.

Meaningful cases: username/email discovery; empty/null stored password; unknown/ambiguous and banned/locked accounts; bad OAuth parameters; zero discovery mail/credentials/password attempts; explicit send/cooldown; wrong/expired/reused/other-user codes; email/account/password changes during setup; conditional-write conflict; setup returning to password with no login; mobile/desktop feedback; late responses and account switching; native/direct API compatibility; ordinary forgot password; MFA and OAuth continuation.

Do not write tests requiring a discovery token or rejecting a valid code merely because discovery was skipped: this design intentionally makes discovery stateless. Browser tests must add real Continue interactions while preserving the existing admin/MFA work.
