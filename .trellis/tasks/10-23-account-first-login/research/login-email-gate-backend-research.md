# Login email gate — backend research (review-corrected)

Research only. **No product or test code changed.** The coordinator freezes the contract; the
`server.js` / `models/User.js` write ownership stays with this worker afterwards.

This revision applies the reviewer's corrections:

1. `pendingLoginSecurityState` **must include `Boolean(email_verified)`**, and must **keep** `email`
   binding (email is not excluded).
2. The new mail-gate proof must bind the **exact pending `jti` + stage + user + target** via the
   stored code row id/context. Reusing "latest login code for email+purpose" is **insufficient**.
3. `EmailVerificationCode.invalidate` does **not** consume an old `password_mfa` pending record.
4. TOTP→mail must **atomically consume the old pending and create the unique next stage** inside the
   same account lock/transaction, with **no SMTP under the lock**.
5. Root preference: a dedicated `POST /api/v1/auth/oauth/oidc/email/send` (pending cookie/header) and
   **manual send for both bind and verify**, matching the original manual-send choice; the exact
   code + pending consumption + conditional email mutation + final credentials must be one
   transaction. **All OTP network sends happen outside the DB lock.**
6. A minimal persisted `target` / `codeId` / `generation` design in the existing `pending_context`
   JSON so a concurrent retarget/resend cannot let a stale code bind a different destination.

## 1. Goal (unchanged)

After a correct password (+ CAPTCHA, + TOTP when active) and **before** any session, authorization
code or token:

- `password` + bound **verified** email → normal login (TOTP if enabled).
- `password` + **no usable mailbox** → force binding a **new** email and verifying it.
- `password` + bound **unverified** email → verify a code for the **current stored** email; a correct
  code atomically marks it verified, then completes login.
- The global `login_email_code` switch is **kept**; TOTP preference preserved.
- One code satisfies the mandatory verification **and** the login email factor — no duplicate send.
- No-password + usable email initial-password flow unchanged; no-password + no mailbox stays
  `contact_admin`.

## 2. Code map (verified anchors)

| Concern | Location |
| --- | --- |
| Login handler / password compare | `server.js:2780`, compare `2845` |
| TOTP stage | `server.js:2852`–`2866` |
| Email-MFA stage (global switch) | `server.js:2869`–`2896` |
| `check_verification` native probe | `server.js:2779`–`2800` |
| `beginOidcSecondFactor` | `server.js:1212`–`1232` |
| `getPendingOidcLogin` | `server.js:1235`–`1260` |
| `beginPasswordSecondFactor` | `server.js:1262`–`1279` |
| `pendingLoginSecurityState` | `server.js:1205`–`1210` |
| `finishAccountLogin` (lock + work) | `server.js:1297`–`1304` |
| `completePasswordLogin` | `server.js:1281`–`1295` |
| `GET /api/v1/auth/oauth/oidc/pending` | `server.js:2626` |
| `POST /api/v1/auth/oauth/oidc/complete` | `server.js:2632`–`2686` |
| `normalizeEmailPurpose` | `server.js:1725` |
| `issueEmailVerificationCode` | `server.js:1749`–`1776` |
| `verifyEmailCode` | `server.js:1778`–`1810` |
| Purposes | `server.js:536`–`539` |
| `isSyntheticEmail` | `server.js:2155` |
| `Authenticator.withUser` — **real row lock** | `models/Authenticator.js:7`–`17` |
| Conditional-mutation precedent | `models/User.js:262` `setInitialPassword`, `283` `verifyPhoneIfUnchanged` |
| `email_verification_codes` schema | `db/init.js` (table below) |
| `users.email_verified` schema | `db/init.js:16` — `BOOLEAN DEFAULT FALSE` (**nullable**) |

`db/init.js` `email_verification_codes`: `id VARCHAR(36) PK`, `email`, `user_id`, `purpose`,
`code_hash`, `pending_context JSON NULL`, `attempts`, `consumed_at`, `expires_at`, `created_at`.
**There is no `generation` column** — so `generation` must live inside `pending_context`. **No
migration is required.** (An earlier draft of this report cited `scripts/init.js`; the correct path
is `db/init.js`.)

## 3. Confirmed hazards

### 3.1 Two different "codes" exist — and only one is pending-bound

`beginOidcSecondFactor` (`server.js:1212`) writes **two** rows for an email factor:

1. **OTP row** via `issueEmailVerificationCode` — `purpose = 'login'`, `code_hash =
   hashEmailCode(email, purpose, code)`. This is the code the user types.
2. **Pending row** — `purpose = 'password_mfa'`, `code_hash = sha256(challenge)` where `challenge`
   is the random 256-bit value inside the signed JWT.

`getPendingOidcLogin` validates the pending row by `jti` (`record.id`, `purpose`, `user_id`,
`consumed_at`, expiry, `code_hash`). But `verifyEmailCode` resolves the OTP row with
**`findLatestActive(email, purpose)`** — "newest active row for that email+purpose".

Therefore the user-typed OTP is bound only to `(email, purpose, user_id)`, **not** to a specific
pending `jti`, stage, or destination. Under retarget/resend this admits stale-code acceptance. This
is exactly the reviewer's point 2 and must be fixed.

### 3.2 `invalidate` does not consume the old pending

`EmailVerificationCode.invalidate(email, purpose)` → `UPDATE … WHERE email = ? AND purpose = ? AND
consumed_at IS NULL`. Re-issuing for the next stage uses the *new* purpose, so an old
`password_mfa` pending row stays **unconsumed** and remains replayable alongside the new one.
TOTP→mail must explicitly `consume(oldPendingId)` in the same transaction.

### 3.3 SMTP must never run under the account lock

`Authenticator.withUser` (`models/Authenticator.js:8`–`17`) does `pool.getConnection()` →
`beginTransaction()` → `SELECT * FROM users WHERE id = ? FOR UPDATE`. `issueEmailVerificationCode`
(`server.js:1749`) performs cooldown + `invalidate` + `create` + `sendVerificationEmail` in one
function, so calling it inside `withUser` would hold the row lock across a **network** SMTP call.
The lock-scoped path must therefore create the row(s) only, and send **after** commit.

### 3.4 `email_verified` in the state hash changes the mutation rules

Today the hash (`server.js:1205`) covers password, email, role, banned, phone, TOTP — **not**
`email_verified`. Adding `Boolean(email_verified)` (reviewer point 1) means:

- Marking the current email verified now **does** change the security state.
- Therefore the "mark verified" mutation must run **inside** the completion transaction, after all
  state checks — exactly the rule already required for binding a new email.
- Consequence: two parallel pendings for one account, where one completes the gate, correctly
  invalidate the other.

`Boolean()` normalization is required because the column is nullable (`db/init.js:16`), so legacy
rows may hold `NULL` and must hash identically to `FALSE`.

### 3.5 Synthetic-email password accounts already break

`server.js:2790`, `2870` and `1228` call `issueEmailVerificationCode({ email: user.email, … })`. For
a stored `…@users.invalid` address delivery fails (502). Those accounts must be routed to
`email_bind`, never to the existing `email` factor.

## 4. Architecture: staged pending gate (no new column, no migration)

### 4.1 Factors and persisted state

Keep `totp` and `email`; add two password-source factors:

| `factor` | Meaning |
| --- | --- |
| `totp` | TOTP / recovery code (existing) |
| `email_verify` | Stored email exists but is not verified |
| `email_bind` | No usable mailbox; a new address must be supplied, verified and bound |
| `email` | Verified mailbox + global `login_email_code` (existing) |

`pending_context` (existing JSON) gains:

```json
{
  "returnTo": "/oauth2/authorize?…",
  "emailGate": "verify" | "bind",
  "target": "alice@example.com",
  "codeId": "2f1c…-uuid-of-otp-row",
  "generation": 1
}
```

- `target` — the **only** destination this stage will trust.
- `codeId` — the exact OTP row id that must be presented.
- `generation` — bumped on every send/resend; a completion carrying a stale generation is rejected.

`returnTo`, CAPTCHA continuation, PKCE and OAuth parameter handling are untouched.

### 4.2 Security state (reviewer point 1)

```js
function pendingLoginSecurityState(user) {
  return crypto.createHmac('sha256', JWT_SECRET).update(JSON.stringify([
    user.password, user.email, Boolean(user.email_verified), user.role, user.banned,
    user.phone_e164, user.phone_country_code, user.phone_number,
    user.totp_enabled, user.totp_secret, Number(user.totp_revision || 0)
  ])).digest('hex');
}
```

`email` is **kept**; `Boolean(email_verified)` is **added**. Both `finishAccountLogin` (`1299`) and
`getPendingOidcLogin` (`1258`) then enforce the stricter state automatically.

### 4.3 Stage selection (replaces `server.js:2789`, mirrored at `2869`)

```js
const emailUsable = Boolean(user.email) && !isSyntheticEmail(user.email) && isValidEmail(normalizeEmail(user.email));
if (user.totp_enabled)                              factor = 'totp';
else if (!emailUsable)                               factor = 'email_bind';
else if (!user.email_verified)                       factor = 'email_verify';
else if (await isSettingEnabled('login_email_code')) factor = 'email';
else                                                 factor = '';
```

`email_verify`/`email_bind` are mandatory; the global switch only adds `email` for already-verified
accounts, so one code always covers both requirements.

### 4.4 Manual send for both gate stages

The gate never auto-sends. `beginOidcSecondFactor` must **not** call
`issueEmailVerificationCode` for `email_verify`/`email_bind` (unlike `email`). The browser/app calls
the dedicated send endpoint, mirroring the original account-first manual-send choice.

### 4.5 Lock-scoped creation, unlocked send

Split `issueEmailVerificationCode` into a DB-only part and a send part:

```js
// DB only — safe inside withUser
async function createEmailCodeRow({ email, purpose, userId, pendingContext }) { … create only … }
// network only — must run AFTER commit
async function deliverEmailCode(email, purpose, code) { return sendVerificationEmail(…); }
```

`issueEmailVerificationCode` keeps its current external behaviour by composing the two; the gate
uses them separately.

### 4.6 TOTP→mail transition (reviewer points 3 and 4)

Inside one `finishAccountLogin`/`withUser` transaction (account row locked):

1. `consume(oldPendingId)` — consumes the TOTP pending row (explicitly, because `invalidate` would
   not).
2. generate the OTP code and `createEmailCodeRow(...)` for `target`.
3. `EmailVerificationCode.create(...)` for the **next** pending row with `pending_context =
   { returnTo, emailGate, target, codeId: <new OTP row id>, generation: 1 }`.
4. commit.
5. **After commit**, `deliverEmailCode(...)`. If delivery fails, mark the OTP row consumed and return
   `502` — the pending row remains, so the user can resend.

No SMTP runs while the row lock is held.

## 5. Proof binding (reviewer point 2) — exact code row, not "latest"

Add a pending-scoped verifier instead of `findLatestActive`:

```js
// models/EmailVerificationCode.js — verify the exact row, not the newest for the address.
async verifyForId({ id, email, purpose, code, userId }) {
  const record = await this.findById(id);
  if (!record || record.purpose !== purpose || record.email !== email
      || (userId !== undefined && record.user_id !== userId)) return null;
  // attempts / expiry / hash checks then reuse the existing logic
}
```

Completion requires **all** of:

1. `getPendingOidcLogin(req)` valid (jti, purpose, unconsumed, unexpired, `code_hash`, state).
2. `pending.factor ∈ {email_verify, email_bind}` and `context.emailGate` matches.
3. `body.code` matches the row `context.codeId` for `context.target` with `user_id = user.id`
   (same purpose), and the OTP row is still active.
4. `context.generation` equals the value in the freshly re-read pending row.
5. The destination is exactly `context.target`:
   - `email_verify`: `context.target === user.email` (read at completion).
   - `email_bind`: `context.target` is the new address, valid and not owned by another account.

Only then may the conditional email mutation run (§6).

**Why this closes retarget/resend:** the trusted destination is `context.target` and the trusted
code is `context.codeId`; a concurrent retarget bumps `generation` and replaces both, so the stale
completion fails at step 4 and can never bind a different address.

## 6. Conditional mutations (no schema change)

```js
// bind a new mailbox and mark it verified only while the stored address is unchanged
async bindEmailIfUnchanged(id, expectedEmail, newEmail) {
  const [r] = await this.pool.execute(
    `UPDATE users SET email = ?, email_verified = ? WHERE id = ? AND email = ?`,
    [newEmail, true, id, expectedEmail]
  );
  return r.affectedRows === 1;
}

// mark the current stored mailbox verified only once, and only if still the same address
async markEmailVerifiedIfUnchanged(id, expectedEmail) {
  const [r] = await this.pool.execute(
    `UPDATE users SET email_verified = ? WHERE id = ? AND email = ?
       AND (email_verified = FALSE OR email_verified IS NULL)`,
    [true, id, expectedEmail]
  );
  return r.affectedRows === 1;
}
```

Zero rows ⇒ `409 auth.login.email_changed`, no credentials issued (mirrors
`auth.password.setup_changed`).

Also needed: a generation-guarded context update for resend:

```js
// bump the stage generation and swap codeId/target only if the caller saw the current generation
async updatePendingContext(id, expectedGeneration, nextContext) { … WHERE id = ? AND consumed_at IS NULL
  AND JSON_EXTRACT(pending_context, '$.generation') = ? … }
```

## 7. Routes and payloads (proposal to freeze)

### 7.1 Start (existing route, extended response)

After password (+CAPTCHA, +TOTP) without a factor code:

```json
{ "mfa_url": "/oauth2/mfa", "require_totp": false, "require_email_code": false,
  "email_gate": "verify" | "bind", "email_masked": "al***@example.com",
  "code_sent": false, "message_key": "auth.login_gate.send_required" }
```

`email_masked` only for `verify`. The `oidc_pending` cookie / `X-Oidc-Pending` header carries the
challenge.

### 7.2 Dedicated manual send (new — root preference)

`POST /api/v1/auth/oauth/oidc/email/send` — pending cookie/header, no body identifier for
`email_verify`:

```json
{ "email": "new@example.com" }
```

- Requires a valid pending with `emailGate ∈ {verify, bind}`; otherwise `401 auth.mfa.expired`.
- `verify`: body `email` optional and must equal `user.email` if supplied.
- `bind`: body `email` required, valid, and not owned by another account
  (`409 validation.email.taken`).
- Under `withUser`: consume the previous OTP row (if any), create the new OTP row, bump
  `generation`, set `target`/`codeId`. Commit.
- **After commit**: deliver the mail. Reuses the existing 60 s cooldown semantics.
- Response: `{ sent: true, email_masked, generation }`.

### 7.3 Complete (existing route, extended body)

`POST /api/v1/auth/oauth/oidc/complete`

```json
{ "code": "123456" }
{ "code": "123456", "generation": 1 }
```

One transaction (`finishAccountLogin`):
verify exact `codeId`+`target`+`generation` → conditional email mutation → consume the pending row →
`completePasswordLogin` + `buildAuthorizationResponse`.

### 7.4 Native probe (existing route, extended response)

`POST /oauth2/authorize` with `check_verification: true` returns
`{ verification_required, factor: '' | 'totp' | 'email' | 'email_verify' | 'email_bind',
   email_gate, captcha_required, captcha_provider: 'image', email_masked? }`.

It must not send any code for the gate stages and must stop calling
`issueEmailVerificationCode(user.email)` for synthetic addresses (fixes the latent 502). It still
creates no session/code/pending and still consumes a password attempt.

## 8. Remaining risk register

| Risk | Mitigation |
| --- | --- |
| Old direct clients bypass the gate | No session/code/token until the gate completes; `email_bind` is uncompletable without the new payload → fail closed |
| Bind/verify before password proof | Gate factors exist only on a pending created after password (+CAPTCHA +TOTP); send route requires that pending |
| Stale code after retarget/resend | `generation` + exact `codeId` + `target` (§5) |
| Old pending replay after stage advance | Explicit `consume(oldPendingId)` inside the same lock (§4.6) |
| SMTP under account lock | DB-only create inside `withUser`; delivery after commit (§4.5) |
| Email/password/phone/TOTP changed mid-gate | `pendingLoginSecurityState` already binds all of them, now including `Boolean(email_verified)` |
| Cross-purpose code reuse | Single dedicated purpose for the gate (`login_gate`), distinct from `login`/`password_mfa` |
| Two parallel pendings | Completing one changes `email_verified`/`email`, invalidating the other |
| Text-vs-`id` ambiguity in `findLatestActive` | Gate path never uses `findLatestActive`; uses `verifyForId` |

## 9. Files required (ownership: `server.js` + `models/User.js` + `models/EmailVerificationCode.js`)

- `server.js` — factor selection (`2789`, `2869`), `beginOidcSecondFactor` (`1212`),
  `beginPasswordSecondFactor` (`1262`), `pendingLoginSecurityState` (`1205`), completion route
  (`2632`), new send route, `check_verification` (`2779`), new purpose constant +
  `normalizeEmailPurpose` (`1725`).
- `models/User.js` — `bindEmailIfUnchanged`, `markEmailVerifiedIfUnchanged`.
- `models/EmailVerificationCode.js` — `verifyForId`, `updatePendingContext` (generation-guarded),
  and a create-only split used from the lock.
- `db/init.js` — **no change** (no new column; `generation` lives in `pending_context`).
- Tests (p4) and frontend (p5) remain separate owners.

## 10. Points for the coordinator to freeze

1. Gate purpose name: recommend a single `EMAIL_PURPOSE_LOGIN_GATE = 'login_gate'` for both stages.
2. Dedicated `/api/v1/auth/oauth/oidc/email/send` vs extending
   `/api/email-verification/send` (root leans dedicated).
3. Whether `generation` is echoed by the client (§7.3) or compared server-side only (recommended:
   server-side only, client echo optional).
4. Error key for a lost bind/verify race: propose `auth.login.email_changed` (409).
5. Two sequential pages for TOTP + email gate — confirm acceptable.
6. Confirm that accounts with synthetic/unverified email become temporarily unable to log in from
   clients that do not implement the new stages (fail-closed is intended, user-visible).
7. Confirm NULL and FALSE `email_verified` both count as unverified.

## 11. Preserved unchanged

No-password discovery/setup and `contact_admin`, `completePasswordLogin`,
`buildAuthorizationResponse`, OAuth continuation + PKCE omission, CAPTCHA grace, lockout/attempt
accounting, `check_verification` semantics apart from the new factor values, OIDC/Huawei pending
sources, and the completed import/upload/optional-email work.

## 12. Test-adapter implications (for p4 planning)

The new statements are ordinary `UPDATE … WHERE` with bound parameters, matching the existing
`setInitialPassword` precedent, so `tests/support/memory-db.js` needs one adapter per new statement,
keyed by its normalized lowercase SQL. Two points to flag early:

- The generation-guarded context update uses `JSON_EXTRACT(pending_context, '$.generation')`. If the
  in-memory adapter pattern-matches SQL strings, either add a handler for that exact statement or
  prefer a generation value passed as a bound parameter (e.g. store `generation` in a side field).
  **Recommendation:** avoid `JSON_EXTRACT` in the guard and compare generation in application code
  after a `findById` re-read inside the same transaction — simpler for both MySQL and the memory
  adapter, and equally race-safe because the row is already locked.
- `verifyForId` is a read + existing attempt/consume logic, so it needs no new SQL shape beyond the
  existing `SELECT * … WHERE id = ?`.

This keeps the adapter work to the two `User` mutations plus the pending-context update, with no
schema or parser change.
