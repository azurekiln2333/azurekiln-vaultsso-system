# Login email gate (bind / verify after password) — API research

Owner: designated Herdr Pi worker. **RESEARCH ONLY — no product or test edits this turn.**
Task: `.trellis/tasks/10-23-account-first-login`. Deliverable: `research/login-email-gate-api-research.md`
(coordinator composes the implementation contract from this).

## 1. Requirement as stated

| Account state after correct password | Required next step |
| --- | --- |
| password + **bound, verified** email | normal completion (TOTP first if enabled) |
| password + **no mailbox** | prompt to **bind a NEW email**; send code to it; verify; then complete |
| password + **bound, UNverified** email | prompt code **for the current stored email**; correct code atomically marks it verified, then completes |

Explicit user decisions:
- **Keep** the existing global `login_email_code` switch (verified accounts still get email MFA when enabled; TOTP preference preserved).
- Proposed full order: **password/CAPTCHA → TOTP if active → mandatory email bind/verify if missing/unverified → final session/OAuth**.
- **One email code satisfies both the required email verification and the login email factor** — no duplicate send and no second code.
- Existing no-password + usable-mail initial-password flow unchanged; no-password + no-mail stays `contact_admin`.
- **Nothing (bind/verify prompt included) may be revealed before password proof**; no session/code/token until all required steps pass.
- Preserve security/challenge locks, races, OAuth state/PKCE, native direct-code compatibility, source lifetime invalidation.
- Prior import work (no row cap, direct upload, 10 MiB bound, optional email, category grouping) is complete with tests — must be preserved.

## 2. Current code, concrete anchors

### 2.1 Entry and ordering — `POST /oauth2/authorize`

| Anchor | What it does |
| --- | --- |
| `server.js:2689` | route start; `username`, `password`, `email_code`, `totp_code`, `loginCaptchaGrace` parsed at `2731-2744` |
| `server.js:2700-2729` | `discover_account` branch (stateless, returns `password`/`set_password`/`contact_admin`) |
| `server.js:2781-2788` | banned → 403 `auth.account_banned` |
| `server.js:2790-2797` | `!user.password` → 403 `password_not_set` |
| `server.js:2799-2830` | native `check_verification` probe (no session; returns `verification_required`/`factor`) |
| `server.js:2832-2852` | CAPTCHA gate (`captcha_login` or `user.captcha_required`), `loginCaptchaGrace` only for second-step resubmission |
| `server.js:2854-2873` | `RateLimit.consume` then `bcrypt.compare` → 401 `auth.invalid_credentials` |
| `server.js:2876-2894` | TOTP branch (`user.totp_enabled`): no code → `beginPasswordSecondFactor(...,'totp')` |
| `server.js:2896-2913` | email branch `if (!totpActive && isSettingEnabled('login_email_code'))`: no code → `beginPasswordSecondFactor(...,'email')`; else `verifyEmailCode(purpose: 'login')` |
| `server.js:2915-2919` | `finishAccountLogin(user, …)` → `completePasswordLogin` + `buildAuthorizationResponse` |
| `server.js:1262-1279` | `beginPasswordSecondFactor` — validates OAuth params, builds continuation, `beginOidcSecondFactor`, `grantCaptchaContinuation`, returns `mfa_url`/`require_totp`/`require_email_code`/`email_masked` |
| `server.js:1212-1237` | `beginOidcSecondFactor` — issues the email code when `factor==='email'`, creates `EmailVerificationCode` with purpose `password_mfa`, signs `oidc_pending` JWT (5 min) |
| `server.js:1297-1304` | `finishAccountLogin` → `Authenticator.withUser` re-reads the user and rejects a changed `pendingLoginSecurityState` |
| `server.js:1205-1210` | `pendingLoginSecurityState` = HMAC over `[password, email, role, banned, phone_e164, phone_country_code, phone_number, totp_enabled, totp_secret, totp_revision]` |
| `server.js:1281-1295` | `completePasswordLogin` — clears rate limit, clears `login_step`, anomaly flag, `last_login_ip`, `setSessionCookie` |
| `server.js:2632-2662` | `POST /api/v1/auth/oauth/oidc/complete` — 5 attempts, single `consume` inside `finishAccountLogin`, then `completePasswordLogin` |
| `server.js:2621-2634` | `GET /oauth2/mfa`, `GET /api/v1/auth/oauth/oidc/pending` (factor + masked email + login_url) |

### 2.2 Email-code primitives (reusable)

| Anchor | What it does |
| --- | --- |
| `server.js:1748-1778` | `issueEmailVerificationCode({email, purpose, userId})` — 60 s per `email:purpose` cooldown, `EmailVerificationCode.invalidate(email, purpose)`, create hashed code, SMTP; on send failure consumes the row and throws 502 |
| `server.js:1780-1815+` | `verifyEmailCode({email, purpose, code, userId})` — 6-digit format, `findLatestActive(email, purpose)`, **`record.user_id !== userId` → `email_code.expired`**, `incrementAttempts(…, EMAIL_CODE_MAX_ATTEMPTS)`, constant-time-ish hash compare |
| `server.js:538-539` | `EMAIL_PURPOSE_LOGIN='login'`, `EMAIL_PURPOSE_EMAIL_CHANGE='email_change'`; also `register`, `password_reset` |
| `server.js:1727` | allowed-purpose whitelist for the public send endpoint |
| `server.js:3322` | existing idiom: `await User.update(user.id, { emailVerified: true })` (email-based password reset) |
| `server.js:3470-3516` | existing **email-change** contract in the profile route: new address needs `EMAIL_PURPOSE_EMAIL_CHANGE` code sent to the NEW address, `User.findByEmail` conflict → 409 `validation.email.taken`, 60 s cooldown, verify via `verifyEmailCode(..., userId)` |
| `server.js:2155-2157` | `isSyntheticEmail` = `/@users\.invalid$/i` |
| `server.js:2132`, `2386` | external providers already use `isSettingEnabled('login_email_code') && !isSyntheticEmail(user.email)` |

### 2.3 Model / DB

- `users.email` is `NOT NULL UNIQUE` (`db/init.js:11`); `users.email_verified` boolean.
- `email_verification_codes` has `pending_context JSON` (schema v5, `pending-mfa` spec §2).
- `EmailVerificationCode`: `create`, `findById`, `findLatestActive(email, purpose)`, `incrementAttempts`, `consume`, `invalidate(email, purpose)`.
- `Authenticator.withUser(id, work)` gives an atomic per-user section (used by the completion route).

### 2.4 Test support that already exists (no adapter work expected)

- `tests/support/memory-db.js:525,542,666,678,684,690,694,698` — full `email_verification_codes` support **including `pending_context`** (JSON round-trip at `:533`). No memory-DB change needed for this feature.
- `tests/password-mfa.test.js:12-16` — `enableEmail()` pushes the `login_email_code` setting; `complete(pending, code)` posts `/api/v1/auth/oauth/oidc/complete` with the pending cookie. Every invariant to preserve already has a test there (see §5).
- `tests/account-first-login.test.js` — helpers `createAccount({password,email,emailVerified,banned})`, `discover()`, `sendSetupCode()`, `submitSetup()`, `f.lastCode(email)`, `f.pool`, `f.User`.
- `tests/support/fixture.js` — `f.user(role)` creates `emailVerified: true`; `f.login()`, `f.authorize()`, `f.exchange()`, `f.request()`, `f.mails`, `f.lastCode`, `f.pool`, `f.reset()`.

## 3. Gap analysis against the new rules

1. **No gate exists for an unverified mailbox.** Today a user with a password and `email_verified = false` completes login with no email step at all when `login_email_code` is off; when it is on, the code is a *login factor* and does not mark the address verified.
2. **No gate exists for a missing mailbox.** A password account with a synthetic/`@users.invalid` address (now creatable via the import placeholder work) logs in with no email step, and `login_email_code` is skipped for synthetic addresses, so nothing prompts a bind.
3. **`pendingLoginSecurityState` already includes `email`**, so binding a new email during the challenge would invalidate the challenge on the next `finishAccountLogin` re-read — a real hazard for the bind step (see risk R1).
4. **`verifyEmailCode` binds `record.user_id`**, so a code issued to a *new* address can still be user-bound — good, but the new address has no `EmailVerificationCode.email` match against `user.email`, so a purpose carried through the pending record is required.
5. The native `check_verification` probe (`2799-2830`) reports `factor` from `totp_enabled` / `login_email_code` only; it must also report the mandatory email gate or native clients will omit a required step.

## 4. Minimal design options

All options keep: password → CAPTCHA → TOTP ordering, pending record + signed cookie, `finishAccountLogin` security-state check, 5-attempt limit, single consumption, OAuth continuation, and `completePasswordLogin` as the only session issuer.

### Option A (recommended): extend the pending record with a mail-gate state, reuse the existing EMAIL code

1. Compute `mailGate` **after TOTP passes**, from the re-read user:
   - `'none'` when `email_verified && !isSyntheticEmail(email)`
   - `'verify_current'` when a real address exists but `email_verified` is false
   - `'bind_new'` when `!email || isSyntheticEmail(email)`
2. If `mailGate !== 'none'` and the request carries no code (or, for `bind_new`, no `new_email`/code), return `beginPasswordSecondFactor(req, res, user, mailGate === 'bind_new' ? 'email_bind' : 'email_verify')`.
   - For `verify_current`: reuse `issueEmailVerificationCode({email: user.email, purpose: 'login', userId})` — **the same code that later serves as the login email factor**, satisfying "one code, no duplicate send".
   - For `bind_new`: the first response is a *prompt only* (no code yet) → `{ mfa_url:'/oauth2/mfa', require_email_bind:true, message_key:'auth.email.bind_required' }`. The code is issued only when the user submits a candidate address to a bind step scoped by the pending token.
3. Carry `mailGate` in the pending record's `pending_context` (already persisted) so the completion route knows what still must happen; keep `pending.factor` for the TOTP/email factor.
4. On completion (`/api/v1/auth/oauth/oidc/complete`), inside the existing `finishAccountLogin` + `consume` section:
   - `verify_current`: after `verifyEmailCode(...)` succeeds, atomically `User.update(id, { emailVerified: true })` **then** complete; consume the same row → one code did both jobs.
   - `bind_new`: verify the code against the **candidate** address (`EmailVerificationCode.email`), re-check `User.findByEmail(candidate)` for a conflict (409 `validation.email.taken`), then write `{ email: candidate, emailVerified: true }` **inside the same transaction** and only then complete.
5. `pendingLoginSecurityState` must exclude/refresh email for the bind case (see R1) or the bind write must be the last write before completion with the state re-derived.

**Why A:** the pending record, the 5-attempt limit, single consumption, `finishAccountLogin` atomicity, OAuth continuation and the `oidc_pending` cookie are all already there; only the gate decision + the two write paths are new. It also keeps `completePasswordLogin` as the single session issuer.

### Option B: separate authenticated "post-password" endpoints

Add `POST /oauth2/login/bind-email` and `POST /oauth2/login/verify-email` guarded by the `oidc_pending` token, each doing one step and re-issuing the pending record.

- **Pro:** smaller individual handlers, clear per-step API for a custom frontend.
- **Con:** duplicates the completion/consume/atomicity logic, adds a second success path that can issue a session (must be threaded through `finishAccountLogin` anyway), and risks a second code send. More surface for races.

### Option C: make it a pure extension of the existing `email` factor

Treat "unverified" as an extra *reason* the `email` factor is required, and set `email_verified` when the email-factor code verifies.

- **Pro:** minimal diff for `verify_current`.
- **Con:** cannot express `bind_new` (there is no code destination), and it conflates the login factor with verification for the `login_email_code=false` case, which the user explicitly wants kept as an independent switch.

**Recommendation:** Option A, with C folded in for `verify_current` (share one code path and mark verified on success).

### Error/response contract to freeze (proposal)

| Condition | Result |
| --- | --- |
| Correct password, gate needed, no code yet | 200 `{ mfa_url:'/oauth2/mfa', require_email_code:true \| require_email_bind:true, email_masked? , message_key }` + `oidc_pending` cookie |
| Correct password, verification/bind satisfied | 200 normal body + session (and OAuth code when applicable) |
| Code wrong/used/expired | 400 `auth.mfa.invalid` (existing) — never a session |
| Bind address already used | 409 `validation.email.taken` (reuse existing key) |
| Bind address invalid | 400 `validation.email.invalid` (new, or reuse `validation.email.taken`-adjacent key) |
| 5 attempts exceeded | 429 `auth.mfa.locked` (existing) |
| Security state changed mid-flow | 401 `auth.mfa.expired` (existing) |
| Wrong password | 401 `auth.invalid_credentials`; **no gate prompt, no code, no pending** |
| No password at all + usable email | unchanged `set_password` / `contact_admin` discovery branches |

## 5. Risks

- **R1 — security-state invalidation on bind (highest).** `pendingLoginSecurityState` includes `user.email` (`server.js:1207`). Writing the new address mid-challenge changes the state, so `finishAccountLogin` (`1299`) would return `auth.mfa.expired`. Fix: perform the bind write **inside** the same `finishAccountLogin` callback *before* completion, or derive the expected state from the post-bind row, or exclude `email` from the bind state and rely on the consumed single-use code + user binding. Must be decided in the contract, not discovered in implementation.
- **R2 — double code send.** `login_email_code` on + unverified mailbox must not send twice. `issueEmailVerificationCode` has a 60 s `email:purpose` cooldown, so a naive second send would surface a 429 instead of a client bug. The gate must reuse the already-issued `EMAIL_PURPOSE_LOGIN` row.
- **R3 — revealing the gate before password proof.** The response shape must be identical for wrong password (401 `auth.invalid_credentials`) regardless of mailbox state; no `require_email_bind` may leak from the unauthenticated branch. The native `check_verification` probe is the exception the user already sanctioned (it *does* check the password), but it must not leak more than `factor`.
- **R4 — consumed proof / concurrency.** Two parallel completions must not both succeed: the existing `EmailVerificationCode.consume` inside `finishAccountLogin` covers the factor row; the bind write must be an atomic conditional update (e.g. `WHERE id = ? AND email = ?`) so a concurrent admin email change is not overwritten — mirroring the `setInitialPassword` precedent.
- **R5 — TOTP ordering.** TOTP must still run *before* the mail gate, so a TOTP user with an unverified mailbox gets TOTP then email verification. The pending record must therefore be able to move factor `totp` → gate, i.e. either two sequential pending records or one record whose `pending_context` tracks remaining steps.
- **R6 — native direct-code clients.** `tests/password-mfa.test.js:124` "direct-code email clients remain compatible" and `:159` unsafe-continuation tests. A client that sends `email_code` directly must keep working; the gate must not demand a second code when the submitted code already satisfies it.
- **R7 — `check_verification` parity.** The App probes requirements first (`2802-2827`); if it is not taught the gate, the App will never collect the bind address and will be stuck.
- **R8 — existing `f.user()` defaults.** The fixture creates `emailVerified: true`, so all existing suites stay green *only if* verified accounts are unaffected. The new tests must use explicit `emailVerified: false` / synthetic addresses, and no existing test's account must become gated.
- **R9 — synthetic import accounts.** The import work now creates `import-<hash>@users.invalid` users (some with passwords). These will all be `bind_new` gated — an intended consequence, but it means the import→login test added earlier (`tests/user-import-upload.test.js`, "keeps password login") will need its expectation updated from "logs in with a session" to "requires binding" once this contract lands.
- **R10 — admin ban mid-flow** is already covered by `pendingLoginSecurityState` (`banned`) + `isUserBanned` in `finishAccountLogin`, but must also be re-checked before any bind write.

## 6. Proposed API test matrix

Suggested new file: **`tests/login-email-gate.test.js`** (focused, no product coupling), plus narrow edits to `tests/user-import-upload.test.js` (R9) and `tests/password-mfa.test.js` (native parity).

### 6.1 State × factor matrix (core)

| # | password | email state | `login_email_code` | TOTP | Expected |
| --- | --- | --- | --- | --- | --- |
| 1 | yes | bound+verified | off | off | straight success + session |
| 2 | yes | bound+verified | on | off | existing email-MFA pending (unchanged) |
| 3 | yes | bound+verified | on/off | on | TOTP first (unchanged) |
| 4 | yes | bound **unverified** | off | off | **gate**: `require_email_code`, no session; correct code → verified=true + session |
| 5 | yes | bound **unverified** | on | off | **one** code serves verification + login factor; no second mail |
| 6 | yes | bound unverified | on/off | on | TOTP → gate → session |
| 7 | yes | **no mailbox** (`@users.invalid` / imported) | off | off | **bind gate**: `require_email_bind`, no session, no code sent yet |
| 8 | yes | no mailbox | on | off | bind gate first; after bind the login factor must not double-send |
| 9 | yes | no mailbox | on/off | on | TOTP → bind gate → session |
| 10 | no | usable email | any | any | unchanged `set_password` |
| 11 | no | no mailbox | any | any | unchanged `contact_admin` |

### 6.2 Security invariants (must be asserted, not inferred)

- **No credentials before completion:** for every gate case assert `f.pool.sessions.length`, `f.pool.accessTokens.length`, `f.pool.authCodes.length` unchanged and no `Set-Cookie` session after the password-only request.
- **No premature disclosure:** wrong password returns 401 `auth.invalid_credentials` with an identical body for verified / unverified / no-mailbox accounts (compare bodies byte-for-byte).
- **No code before password proof:** `f.mails.length` unchanged after a wrong-password request on a `bind_new`/`verify_current` account.
- **Stale credentials:** password changed between password proof and completion → 401 `auth.mfa.expired`.
- **Stale mail:** admin changes `email` mid-challenge → 401 `auth.mfa.expired` (and the bind path must not resurrect the old token — R1).
- **Stale verified status:** if the address is verified by another path mid-challenge, completion must still be consistent (either succeed once or `auth.mfa.expired`; contract must pick one).
- **Admin ban mid-flow:** `banned` flips → 403/401 per existing rule, and no bind write.
- **Concurrency / consumed proof:** two `complete` calls with the same code → exactly one 200 and one 400/401; `EmailVerificationCode.consumed_at` set once.
- **Bind email conflicts:** bind to an address owned by another user → 409 `validation.email.taken`, no write, no session, and `pendingLoginSecurityState` unchanged.
- **Replay:** reuse a completed bind/verify code → 400 `auth.mfa.invalid`.
- **Attempt lock:** 6 wrong codes → 429 `auth.mfa.locked`.
- **Native parity:** `check_verification: true` reports the gate (e.g. `factor: 'email'` or a new `email_gate` field) without creating a pending record or session; and direct-code login that supplies a valid code succeeds in one call.

### 6.3 Cross-suite regression that must stay green

- `tests/password-mfa.test.js` — all 10 tests (pending, continuation with 2048-char state, recovery codes, expiry/attempts/security changes, direct-code, CAPTCHA attempt accounting, unregistered redirect, unsafe continuations).
- `tests/account-first-login.test.js` — 23 tests (discovery, `set_password`, `contact_admin`, conditional update, legacy reset).
- `tests/user-import-upload.test.js` — 20 tests; **one expectation change** for R9 (imported password+no-email account now gated rather than directly logged in).
- `tests/oidc.test.js`, `tests/huawei.test.js`, `tests/multi-authenticator.test.js`, `tests/security.test.js` — external pending sources and authenticator precedence must be untouched.

## 7. Test files needed (no edits made)

| File | Action | Why |
| --- | --- | --- |
| `tests/login-email-gate.test.js` | **new** | matrix 6.1 + invariants 6.2 |
| `tests/user-import-upload.test.js` | narrow edit | R9: imported password + no-mailbox account expectation |
| `tests/password-mfa.test.js` | narrow edit | native `check_verification` parity (R7) if the contract changes the probe output |
| `tests/support/fixture.js` | **likely none** | `f.user()`, `f.login()`, `f.request()`, `f.pool`, `f.mails`, `f.lastCode` suffice; a bind step may want a tiny helper |
| `tests/support/memory-db.js` | **none expected** | `pending_context` + all `email_verification_codes` branches already supported (`:525-698`) |

No other file needs to change for API coverage.

## 8. Questions the coordinator must freeze

1. `verify_current` + `login_email_code=on`: confirm exactly **one** send/reuse of the `EMAIL_PURPOSE_LOGIN` row (R2).
2. `bind_new` transport: is the candidate address submitted to `POST /api/v1/auth/oauth/oidc/complete` (or a new step endpoint), and what are the exact field names?
3. R1 resolution: does `pendingLoginSecurityState` keep `email` (bind write inside the atomic section) or exclude it for the bind path?
4. TOTP → gate sequencing (R5): one pending record whose `pending_context` tracks remaining steps, or two sequential records?
5. Exact new error keys: `validation.email.invalid` for a malformed bind address, and the `message_key`s for the two prompts.
6. Whether `check_verification` gains a field for the gate (R7) and its exact name, so the App can be adapted.
7. Whether the gate applies to external (OIDC/Huawei) pending sources — the user's text says "password + …", so the recommendation is **password source only**, leaving `oidc_mfa` untouched.

## 9. Status

Research complete. No files edited; `git status` untouched by this turn. Prior import fixes (cap removal, direct upload, 10 MiB bound, optional email, category grouping) remain intact and green — the only expected future change is the single R9 expectation in `tests/user-import-upload.test.js`.
