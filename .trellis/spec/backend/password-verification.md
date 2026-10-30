# Password Login Verification

## 1. Scope / Trigger
Local password login with account discovery, verified first-password setup, mandatory usable verified mailbox, and configured CAPTCHA/email/authenticator verification; existing external provider pending challenges share the completion mechanism while retaining their source-specific policies.

## 2. Signatures
- `POST /oauth2/authorize` accepts credentials, CAPTCHA and OAuth authorization parameters. Existing direct-code clients can still send `email_code`/`totp_code`.
- JSON `POST /oauth2/authorize` with `discover_account: true` and `username` selects account discovery before the password-required guard. Successful responses are `{ next: 'password' }`, `{ next: 'set_password', email_masked }`, or `{ next: 'contact_admin' }`; true zero-match identifiers return 404 `account_not_found` / `auth.account_not_found`.
- `POST /api/email-verification/send` accepts `{ username, purpose: 'password_reset' }` for first-password setup. `POST /api/password-reset` accepts `{ username, email_code, password, confirm_password }`. Both retain existing email-only variants and reject bodies containing both identifier fields.
- `User.setInitialPassword(id, verifiedEmail, newPassword)` hashes the password, conditionally updates only the exact user/email with a null or empty stored password, atomically marks the email verified, and returns actual affected-row success.
- Password validated but second factor absent: `{ mfa_url: '/oauth2/mfa', require_totp | require_email_code, email_masked?, message_key }` and HttpOnly `oidc_pending` cookie.
- `GET /oauth2/mfa` serves the verification page for a valid pending challenge.
- `GET /api/v1/auth/oauth/oidc/pending` projects factor, masked email and login URL.
- `POST /api/v1/auth/oauth/oidc/email/send` accepts `{ expected_mail_version, email? }` for password-source mailbox gates. Only bind requires a new email; verify uses the current stored mailbox.
- `POST /api/v1/auth/oauth/oidc/complete` accepts `{ code }` for existing factors or `{ code, expected_mail_version }` for mailbox gates; intermediate success returns `next_step:true` and rotates the pending challenge, while final success establishes a session and returns the existing `redirect`.
- Schema version 5 adds nullable `email_verification_codes.pending_context JSON`; deployments run `npm run init-db` before starting the updated service.

## 3. Contracts
Account discovery accepts a strictly boolean selector and the applicable original OAuth parameters. The user explicitly authorized immediate missing-account feedback: after lock/ban and requested OAuth validation, zero username/email matches return 404 `{error:'account_not_found',error_key:'auth.account_not_found',error_description:'账号不存在'}` with no `next`, destination or account metadata. `User.findByUsername` returns null for zero or multiple matches; only after a null result, existing `User.findPotentialConflicts(username, username)` distinguishes a genuinely missing account. Ambiguous existing identifiers retain `password` without selecting an account. Discovery uses the same HTTP throttling and `login:${user?.id || username.toLowerCase()}` lock check as credential login, but consumes no password attempt, sends no email, and creates no session, cookie, pending challenge, authorization code or token. Lock and requested OAuth errors precede missing-account feedback. Normal credential and native `check_verification` requests still require a nonempty password; general recovery's unknown response stays generic.

Account-bound code sending and setup re-resolve the stored email on every request and are restricted to accounts without a local password. Missing, invalid and `@users.invalid` destinations require administrator help. Do not return a full stored email. Reuse the `password_reset` purpose, user-ID-bound proof, cooldown and single-use verification. A prior discovery is neither proof nor a prerequisite. After verification, condition the write on `id = ? AND email = ? AND (password IS NULL OR password = '')`; on zero affected rows return `auth.password.setup_changed` before session/token revocation. Successful setup revokes old credentials and returns confirmation, without logging the user in. General email-only recovery keeps its existing behavior.

Validate password and required CAPTCHA before creating a pending record; no session before every required factor and mailbox gate completes. Password pending records use purpose `password_mfa`, five-minute expiry and a signed token with source `password`. The security state HMAC binds stored password, email, Boolean email verification, role, ban, phone and authenticator fields; changes invalidate the challenge. External sources still require an enabled provider. Challenge hash and user ID must match the unconsumed persisted record. At most five completion attempts, single atomic consumption, TOTP replay protection and single-use recovery codes.

For password sources, usable verified mailboxes retain normal login, authenticator preference and the global `login_email_code` switch. Unbound/invalid/synthetic mailboxes require `email_bind`; usable unverified mailboxes require `email_verify`, regardless of that switch. NULL verification is false, and an unusable address remains unbound even with a corrupt verified flag. Ordering is password + required CAPTCHA, then configured TOTP/recovery, then mandatory mailbox proof, then credentials. One mandatory proof satisfies the login email factor. Passwordless accounts still use initial setup or contact-administrator guidance, with no login authority from discovery.

Both mailbox gates send manually through the pending-gated endpoint. Persist `{mail:{version,targetEmail,codeId,sentAt}}` on the parent pending row. Require `expected_mail_version` to be a raw JSON nonnegative integer equal to the current version; do not coerce null, booleans or strings. Each successful send reserves the next version and a distinct `login_gate` code row bound to exact user/parent/stage/version/target. The code context uses stage `bind`/`verify`, corresponding to public factors `email_bind`/`email_verify`. Verify exact codeId, never latest-by-email. Target edits/resends invalidate old proof. Keep the parent's total attempt budget across resend. Expiry of later stages/codes never exceeds the original password proof's absolute expiry; recheck signed JWT expiry after acquiring the account lock.

Re-read and validate pending state through connection-scoped models inside `Authenticator.withUser`. Atomically consume a TOTP/recovery parent and create the unique next mailbox stage, retaining server-controlled TOTP satisfaction. Direct supplied-factor authorization follows the same atomic rule and validates OAuth before spending the factor. SMTP and behavior-alert delivery run after commit outside the account lock. Failed SMTP cleans up only its reserved codeId; pending GET projects send status from that exact active row. Send responses identify their own reserved version/target even if a newer send has committed. Completion combines conditional mailbox mutation, exact code/parent consumption, refreshed user and final credentials in one account transaction. Since `withUser` commits returned error objects, failures after success-path writes must throw controlled errors to roll back. Set response cookies only after commit. Initial and successor responses include `pending_token`/`pending_header` for cookie-less clients. See the task's frozen gate contract for exact HTTP fields and lifecycle details.

Gate send uses one-per-60-second account and target cooldowns plus the shared mail/IP ceiling of ten requests per minute. Recoverable cooldown responses include `retry_after` and `Retry-After`. Normalize origin-guard, machine-endpoint and HTTP rate-category matching consistently with Express's case-insensitive routes and optional trailing slash; every accepted spelling must apply the same policy. Header transport never exempts an explicit foreign browser origin.

Validate registered OAuth redirects/PKCE before creating pending state. Retain only authorization parameter names in the same-origin continuation stored in the pending record's `pending_context`; no passwords. The signed HttpOnly cookie carries only short challenge/account/security fields, and the server hydrates the continuation from the matching persisted record. Legitimate URL-encoded state can exceed cookie limits if embedded in a JWT. Completing MFA returns to GET authorization for the original client code flow, retaining state/nonce/PKCE. Without OAuth parameters return to `/profile`.

For clients with optional PKCE, the browser must omit `code_challenge` and `code_challenge_method` from the login POST when they are absent from the original authorization URL. Empty submitted fields count as supplied PKCE and fail validation; the same omission must survive the MFA continuation.

Missing CAPTCHA only requests the challenge and does not consume a password attempt; HTTP throttling still applies. `RateLimit.check` first rejects an already locked account without incrementing hits; `consume` runs after CAPTCHA for actual password requests. Wrong credentials remain subject to account lockout. Authenticator verification takes precedence over email.

When both Turnstile keys are configured, web forms carrying `captcha_surface=web` use Turnstile at the existing login, registration and anomaly CAPTCHA checkpoints. Direct App requests without that marker retain the image CAPTCHA and `GET /api/auth/config` reports `captchaProvider: image`; the web page loads `/api/auth/config?surface=web`. Siteverify must succeed for the expected action and, in production, the configured public hostname before password verification or account creation. An unavailable verifier fails closed. The admin CAPTCHA toggles still control the global login and registration checkpoints; absent saved settings, configured Turnstile enables both by default. Without keys, both surfaces use the image CAPTCHA.

## 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| Discovery identifier with zero matches | 404 `account_not_found` / `auth.account_not_found`; no next step, destination or mail |
| Ambiguous existing discovery identifier | 200 `next: password`; no account selected or destination |
| Locked identifier or invalid requested OAuth during discovery | Existing lock/OAuth error takes precedence over missing-account feedback |
| Passwordless account with usable email | 200 `next: set_password`; masked email only |
| Passwordless account without usable email | Discovery: 200 `next: contact_admin`; account-bound send/setup: 400 `auth.password.contact_admin` |
| Both `username` and `email` fields supplied | 400 `auth.password.setup.invalid_identifier` |
| Password already set, or conditional write loses a password/email race | 409 `auth.password.setup_changed`; no credential revocation on failed conditional write |
| Stored email changed after sending, before setup resolves the account | 400 existing invalid/expired-code error; proof cannot verify the new mailbox |
| Unknown account-bound send/setup identifier | Send: generic 200 `email_code.sent`, no mail; setup: existing invalid/expired-code error |
| Required CAPTCHA absent | 400 `captcha.required`; no pending/session/password attempt |
| Wrong password | 401 `auth.invalid_credentials` |
| Invalid registered OAuth parameters | 400 before pending creation |
| Pending expired, consumed, or security state changed | 401 `auth.mfa.expired` |
| Wrong or used factor code | 400 `auth.mfa.invalid` |
| More than five pending attempts | 429 `auth.mfa.locked` |
| Missing/malformed mailbox version | 400 `invalid_request`; no send or credential |
| Stale version or changed target authority | 409; no mailbox overwrite or credential |
| Gate account/target cooldown | 429 `auth.email_gate.cooldown`, with remaining retry seconds; active proof remains governed by pending GET |
| Reserved gate email delivery fails | 502 `email_delivery_failed`, reserved `mail_version`; only that exact code is invalidated |

## 5. Good / Base / Bad Cases
- Good: discover a passwordless username, explicitly send to its stored mailbox, verify and set its first password, then submit the normal password/MFA login.
- Base: an existing password account reaches password entry; direct credential and email-only recovery clients retain their original contracts.
- Bad: a password or mailbox changes after verification; the conditional write affects zero rows and cannot overwrite credentials or mark another mailbox verified.
- Good: correct password and email code on separate page; original OAuth state and S256 verifier exchange work.
- Base: account has a usable verified mailbox and no required factor; credentials establish the session directly.
- Bad: phone/password changes during pending verification; reject the old pending token.

## 6. Tests Required
`tests/account-first-login.test.js` proves username/email discovery with empty/null passwords, zero discovery mail/credential side effects, explicit zero-match errors versus ambiguous existing identifiers, unchanged password-attempt budgets and lock/OAuth precedence, manual send cooldown, dual-identifier rejection, current-email/user-ID proof binding, first-password-only behavior, failed conditional writes without revocation, and legacy email recovery/native credential compatibility. API and browser integration must prove successful setup still requires final password/MFA login and retains OAuth state/nonce/PKCE.

`tests/password-mfa.test.js` covers no pre-verification session, OAuth continuation/token exchange, recovery codes, expiry/attempt limits/replay/security changes, direct-code compatibility and one-password-attempt CAPTCHA flow. Browser test verifies separate pages, desktop/mobile form states and real browser OAuth POST/continuation/token nonce, including a 2048-character percent-encoded state: hidden form fields must include every collected authorization parameter. API-only tests do not prove hidden inputs exist or that the browser accepts the cookie. Existing OIDC/Huawei pending tests must pass.

## 7. Wrong vs Correct
Wrong: verify a mailbox code and then use an unconditional `updatePassword(id, password)` for the first-password route.

Correct: bind the verified mailbox and unset password in the conditional database update, require affected-row success, then revoke old credentials.

Wrong: persist a password in sessionStorage to resubmit from an MFA page, or issue a session after password verification before MFA.

Correct: server-side persisted pending challenge, signed minimal continuation, account security-state binding and session creation after successful second factor.

## 8. Native Verification Requirements

`POST /oauth2/authorize` also accepts `check_verification: true`. Validate registered OAuth parameters and the password under the same account/IP throttling before returning factor requirements, including `email_bind`/`email_verify` metadata when applicable, and CAPTCHA requirements. Existing verified-mailbox email factors retain their cooldown/SMTP behavior. Mandatory mailbox gates never send or grant authority from this pre-CAPTCHA probe.

This probe never creates a session, authorization code, pending MFA record/token, or CAPTCHA continuation cookie. It consumes a password attempt even before CAPTCHA because it actually checks a password; final login still checks required CAPTCHA and all required factors. Native/header and direct-code clients cannot bypass incomplete mailbox gates; clients without the new pending flow fail closed. Preserve the same origin/machine-client checks as equivalent pending endpoints.

Deploy this branch before QFLI `/api/auth/login/requirements` clients. No schema migration is introduced.

Mailbox gate API/browser regressions must cover verified/unverified/unbound/NULL states with the switch on/off, TOTP/recovery transitions, no premature credentials, full OAuth continuation/verified claims, exact challenge binding, target edits, concurrent send/completion, SMTP failure/lock boundaries, stale security state, attempt/expiry persistence, replay and rollback. Preserve imports and external-provider suites.
