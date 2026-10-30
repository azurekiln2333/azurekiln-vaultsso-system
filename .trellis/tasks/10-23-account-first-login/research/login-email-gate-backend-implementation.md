# Password login mailbox gate — backend implementation

Owner: `w1Q:p3` (backend). Task: `.trellis/tasks/10-23-account-first-login`.
Frozen sources: `research/login-email-gate-contract.md` (2026-10-24) and
`research/login-email-gate-design-review.md`. Closes reviewer findings **B1–B10**.

Files changed (backend ownership only): `server.js`, `models/User.js`,
`models/EmailVerificationCode.js`. No test, fixture, frontend or spec file was edited by this owner.

---

## 1. Behaviour summary

| Account state (local password login) | Outcome |
| --- | --- |
| usable mailbox + `email_verified` true | unchanged login (TOTP precedence, then optional global `login_email_code`) |
| usable mailbox + `email_verified` false/NULL | password → TOTP/recovery if enabled → **`email_verify`** gate |
| unusable mailbox (`@users.invalid`, empty, malformed) | password → TOTP/recovery if enabled → **`email_bind`** gate |
| no password + usable mailbox | unchanged discovery → manual-send initial-password setup |
| no password + unusable mailbox | unchanged `contact_admin` guidance |

- "Usable" = normalised, `isValidEmail`, and not `isSyntheticEmail` (`@users.invalid`). A corrupt
  `email_verified = true` on an unusable mailbox is still unbound. `NULL` reads as unverified.
- A gate is **always** a manual send: stage creation, discovery, the native `check_verification`
  probe and the TOTP→gate transition never send mail.
- A completed mandatory proof also satisfies the optional global `login_email_code` factor — no
  second code is ever sent.
- External OIDC/Huawei policies are unchanged.

## 2. Security-state binding

`pendingLoginSecurityState(user)` now hashes
`[password, email, Boolean(email_verified), role, banned, phone_e164, phone_country_code,
phone_number, totp_enabled, totp_secret, totp_revision]`.
Any password/mailbox/verification-flag/role/ban/phone/authenticator change invalidates every
outstanding pending challenge, including gates.

The final write of a gate (`bind` / `markVerified`) intentionally changes that hash. The stage
validator therefore runs **once at transaction entry** (`finishAccountLogin`), never again after the
mutation, and the refreshed row is used for claims, session and logs.

## 3. Persisted stage authority

Reuses the existing `password_mfa` pending row + signed `oidc_pending` JWT. New factors:
`email_bind`, `email_verify` (password source only). No new table, cookie, migration or column.

`pending_context` for a password-source stage:

```json
{ "returnTo": "/oauth2/authorize?...",
  "proofExpiresAt": 1761300000000,
  "totpSatisfied": true,
  "mail": { "version": 0, "targetEmail": null, "codeId": null, "sentAt": null } }
```

- `proofExpiresAt` is **epoch milliseconds**, persisted for *every* password-source stage (TOTP,
  email and both gates). A successor inherits it verbatim and never extends it; stage and code
  expiry are `min(now + 5min, proofExpiresAt)`.
- `totpSatisfied` is present only when meaningful; the gate cannot be opened for a TOTP-enabled
  account without it.
- The gate OTP row is a separate `email_verification_codes` row with
  `purpose = 'login_gate'` and

```json
{ "parentPendingId": "<pending row id>", "stage": "bind|verify",
  "version": 1, "targetEmail": "new@example.com" }
```

Proof of email = **exact** `parentPendingId` + `stage` + `version` + `targetEmail` + row
id/hash/expiry. `findLatestActive` is never used for gates.

`readPendingUnderLock` re-validates, under the account lock: `pending.exp * 1000 > Date.now()`, the
security state, parent purpose/user/hash/row-expiry, `returnTo`, `mail.version`, the `totpSatisfied`
prerequisite and `proofExpiresAt`. The JWT `exp` is in whole seconds, so it can lapse up to 999 ms
before the row/proof timestamp; a request queued on the lock must not cross that boundary.

`'login_gate'` is deliberately **excluded** from `normalizeEmailPurpose`, so the public generic
`POST /api/email-verification/send` cannot mint a gate proof.

## 4. HTTP contract

### 4.1 Login stage response (`POST /oauth2/authorize`, gate stages)

```json
{ "mfa_url": "/oauth2/mfa", "require_totp": false, "require_email_code": true,
  "email_gate": "bind", "code_sent": false, "email_masked": null,
  "pending_token": "<signed jti credential>", "pending_header": "X-Oidc-Pending",
  "message_key": "auth.email_gate.bind_hint" }
```

`email_gate` is `"bind"` or `"verify"`; `code_sent` is always `false`.

### 4.2 `GET /api/v1/auth/oauth/oidc/pending`

Adds, for gate stages only:

```json
{ "factor": "email_bind", "email_gate": "bind", "email": "", "mail_version": 0,
  "code_sent": false, "retry_after": 0 }
```

`code_sent` is derived from the **exact active code row** referenced by `mail.codeId` (so an
SMTP-failure cleanup reports `false`), never from a stored boolean. `email` is the masked persisted
target; `""` before a bind target exists. Synthetic placeholders never appear.

### 4.3 `POST /api/v1/auth/oauth/oidc/email/send`

Machine endpoint (`MACHINE_ENDPOINTS`, so cookie-less native clients may send `X-Oidc-Pending`);
same-origin browser requests still pass and foreign browser origins are still rejected.

Request: `{ "expected_mail_version": 0, "email": "new@example.com" }` (`email` only for `bind`).

The version is read from the **raw JSON value** via `readMailVersion` (`Number.isInteger(value) &&
value >= 0`). A missing/null/false/`''`/numeric-string/negative/fractional/NaN/array/object value is
`400 invalid_request` — it is never coerced (`Number(null)`, `Number(false)`, `Number('')` are all
`0`, and `Number(true)` is `1`). A well-formed but stale integer is `409 auth.email_gate.stale`.
The same guard is used by `/complete`.

Success:

```json
{ "sent": true, "message_key": "auth.email_gate.sent", "email_gate": "bind",
  "email": "ne***@example.com", "mail_version": 1, "code_sent": true, "retry_after": 60,
  "pending_token": "<same credential>", "pending_header": "X-Oidc-Pending" }
```

`mail_version`/`email` echo the version and target **reserved by this send**; the parent is never
re-read after SMTP, so a concurrent send can never make an older delivery report a newer version.

SMTP failure (502):
`{ error: "email_delivery_failed", error_key: "email_delivery_failed", ..., "email_gate": "...",
"mail_version": <reserved>, "code_sent": false, "retry_after": <seconds> }` and only that exact
`codeId` is consumed.

The `error_key` is **fixed** to `email_delivery_failed` (root added all three translations). A
nodemailer transport code (`ECONNECTION`/`EAUTH`/`ETIMEDOUT`/`ESOCKET`) is rethrown unchanged by
`services/email.js`, so echoing `error.code` would surface an untranslatable key and fall back to
the hardcoded Chinese description in `en`/`zh-TW`. The status is likewise fixed at `502`.

Under-lock ordering: re-read parent by exact jti → security state / purpose / hash / expiry /
`proofExpiresAt` / TOTP prerequisite → `expected_mail_version` must equal the persisted version →
derive target from the locked account → uniqueness → IP/account/target limits → reserve version →
create OTP row → CAS `pending_context` → consume the previous exact `codeId` → commit → SMTP
outside the lock.

### 4.4 `POST /api/v1/auth/oauth/oidc/complete` (gate stages)

Request: `{ "code": "123456", "expected_mail_version": 1 }`.

Under one account transaction: re-read parent → charge the **parent** attempt budget → version
guard → resolve the exact `codeId` and verify user/purpose/parent/stage/version/target/expiry/hash
(constant time) → conditional user write → consume the exact code row → consume the parent →
refresh the user → durable issuance → commit. Cookies and alerts are applied only after commit.

Success: `200 { "redirect": "<persisted returnTo>" }` + session cookie.

### 4.5 TOTP → gate transition

`POST .../complete` with a `totp` factor returns an **intermediate** 200 before any credential:

```json
{ "next_step": true, "factor": "email_verify", "mfa_url": "/oauth2/mfa",
  "require_totp": false, "require_email_code": true, "email_gate": "verify",
  "email": "al***@example.com", "mail_version": 0, "code_sent": false, "retry_after": 0,
  "pending_token": "<rotated credential>", "pending_header": "X-Oidc-Pending",
  "message_key": "auth.email_gate.verify_hint" }
```

The parent consumption and the successor creation are one transaction; the cookie **and** the
body credential are published only after commit. The pending cookie is rotated, not cleared.

Direct `POST /oauth2/authorize` with password + TOTP/recovery in one request returns the same
shape (`next_step: true`), with the factor consumption and successor creation in one transaction.

### 4.6 Entry-point closure

`/oauth2/authorize` (direct), the native `check_verification` probe, `/complete` and the new send
route cannot bypass the gate:

- `/oauth2/authorize` answers with the gate stage **before** the optional email factor block, so a
  supplied `email_code`/`totp_code` cannot skip it.
- `check_verification` reports the gate (`factor`, `email_gate`, `code_sent: false`) and sends
  nothing; the legacy `email` factor is additionally guarded by `isUsableMailbox` (previously it
  could target an `@users.invalid` placeholder).
- `/complete` rejects any factor other than the stage's own; gate completion requires the exact
  `codeId` + version.

### 4.7 Case / trailing-slash route boundary (B12)

Express matches routes case-insensitively and tolerates a trailing slash, while the string guards
were case-sensitive. `/API/V1/AUTH/OAUTH/OIDC/EMAIL/SEND` therefore reached the handler with **no**
origin check and **no** throttle. `normalizeGuardPath(path)` (lowercase + strip trailing slashes) is
now used consistently by:

- `requestBoundary` → `browserEndpoint` (normalised `/api/` prefix + `BROWSER_GUARD_PATHS`),
- `requestBoundary` → the machine allowance (`MACHINE_ENDPOINTS.has(normalized)`), so native
  cookie-less clients keep working across every variant,
- `requestBoundary` → the `Cache-Control` decision,
- `limitRequests` → sensitivity and the `mail` category,
- the admin static-page auth gate (`ADMIN_ONLY_STATIC_PATHS`, normalised on both sides), which had
  the same fall-through shape.

So `lowercase`, `UPPERCASE`, `MiXeD` and trailing-slash variants of both pending-mutation routes all
return `403` for a foreign browser `Origin`, send no mail and mint no session/authorization code,
while the identical native (no-Origin) requests still succeed.

## 5. Error keys

Reused: `auth.mfa.expired` (401), `auth.mfa.invalid` (400), `auth.mfa.locked` (429, terminal),
`auth.totp.invalid` (400), `email_code.invalid` / `email_code.expired` (400),
`email_delivery_failed` (502).

New, and already translated by `w1Q:p5` in `public/js/i18n.js`:
`auth.email_gate.bind_hint`, `auth.email_gate.verify_hint`, `auth.email_gate.sent`,
`auth.email_gate.stale` (409), `auth.email_gate.invalid_email` (400),
`auth.email_gate.email_taken` (409), `auth.email_gate.cooldown` (429, **recoverable**),
`auth.email_gate.unsupported` (400).

New and **not** yet translated (backend request to `w1Q:p5`): `auth.email_gate.missing_version`
(400, unreachable from the shipped frontend, which always sends `expected_mail_version`) and
`auth.email_gate.rate_limited` was **not** used — the cooldown key reused is
`auth.email_gate.cooldown`.

`http` response `error` is derived from the status `400 invalid_request`, `401 invalid_grant`,
`409 conflict`, `429 too_many_requests`, `502 email_delivery_failed`.

### Cooldown vs terminal lockout

- `auth.email_gate.cooldown` (429) is **recoverable**: the body carries `retry_after` (seconds) and
  the response sets the `Retry-After` header. Applied to the per-IP, per-account and per-target
  send limits.
- `auth.mfa.locked` (429) is **terminal**: no `retry_after`, no `Retry-After` header; the user must
  start over.

## 6. Rate limits

| Scope | Key | Limit |
| --- | --- | --- |
| send, per source IP | `mailgate:ip:<ip>` | 10 / 60 s |
| send, per account challenge | `mailgate:<userId>` | **1 / 60 s** |
| send, per destination mailbox | `mailgate:target:<email>` | **1 / 60 s** |
| HTTP throttle category | `http:mail:<ip>` | 10 / 60 s (`OIDC_EMAIL_SEND_PATH` classified as `mail`, not `auth`) |
| direct TOTP/recovery attempts | `totp:<userId>` | 10 / 5 min, cleared on success |
| gate completion attempts | parent `email_verification_codes.attempts` | 5 per parent, **survives resend/retarget** |

Account + target at 1/60 s means an immediate second send on the same challenge — even at the new
version and a rotated destination — is rejected, and one mailbox cannot be hammered from several
account challenges. `retry_after` in the pending GET and in `resendRetryAfter()` uses the same
1-limit semantics.

## 7. Exact new SQL (`w1Q:p4` adapter contract — already implemented, listed for audit)

```sql
-- models/User.js bindEmailIfUnchanged
UPDATE users SET email = ?, email_verified = ?
 WHERE id = ? AND email = ?

-- models/User.js markEmailVerifiedIfUnchanged
UPDATE users SET email_verified = ?
 WHERE id = ? AND email = ? AND (email_verified = FALSE OR email_verified IS NULL)

-- models/EmailVerificationCode.js updatePendingContext
UPDATE email_verification_codes SET pending_context = ?
 WHERE id = ? AND consumed_at IS NULL
```

Version comparison is done in application code under the account lock (no `JSON_EXTRACT`), so the
adapter needs no JSON SQL. `users.email` is `NOT NULL`, so `email = ?` is sufficient.

## 8. Transaction / rollback discipline

`Authenticator.withUser` commits on a normal return **even when the callback returns an error
object**, so every failure after a success-path write throws `AccountTransactionAbort`:

- gate completion: version/state conflicts, zero-row conditional user write, zero-row code consume,
  zero-row parent consume, missing refreshed user — all throw and roll back the conditional write
  *and* the consumed rows.
- non-gate `/complete`: a valid factor already consumed the TOTP counter / recovery code / login
  code, so a zero-row parent consume **throws** (B8) instead of returning.
- Huawei second-factor branch: a failed `buildAuthorizationResponse` now throws instead of
  returning the error object (it runs after the factor consumption).
- direct `/oauth2/authorize`: OAuth continuation is validated **before** any factor is consumed; the
  factor consumption, the gate successor creation and the final issuance each share one transaction
  (B10).
- Wrong-code paths deliberately `return` (commit), because the only write is the attempt counter.
  Test-observable consequence: a stale-version 409 or any other abort rolls the attempt charge back.

### SMTP and alerts are strictly outside the lock

- Gate OTP delivery happens after commit, outside the account lock.
- `issueLoginWithinTransaction` performs only durable writes and returns a deferred payload;
  `applyIssuedLogin` applies the success cookie, the login alert and the behaviour alert after
  commit. A rolled-back login therefore never leaves a success cookie, never emails an alert and
  never starts SMTP under the lock (B9).
- `detectAndFlagAnomalousLogin` gained a `{ deferAlerts }` option; the failed-password path keeps
  its original fire-and-forget behaviour.

## 9. Removed / changed internals

- `verifyTotpOnce` and `completePasswordLogin` were deleted: both became unreachable once
  verification and issuance moved inside the account transaction, and keeping them would leave a
  second, non-atomic implementation of the same semantics. `verifyEmailCode` is unchanged and still
  used by password reset / setup / email change; `verifyEmailCodeWith(codes, …)` is its
  connection-scoped twin used inside account transactions.
- `beginOidcSecondFactor` was split into `createSecondFactorRecord` (persist) +
  `publishSecondFactor` (sign + cookie) so a transactional caller can create a successor atomically
  and publish after commit.
- Shared stage payload: `passwordStagePayload(user, factor, pendingToken)` keeps the direct entry
  path and the `/complete` transition byte-identical in shape; `passwordContinuationReturnTo`
  centralises the OAuth continuation keys; `OIDC_CONTINUATION_KEYS` names them once.
- Factor-failure audit trail preserved: `totp_invalid` / `email_code_invalid` login logs are written
  **outside** the transaction (`recordFactorFailure`), because a log written inside a rolled-back
  transaction would vanish — the anomaly detector counts these results.

## 10. Verification

Run by this owner (bounded, no commit/stage/reset):

| Suite | Result |
| --- | --- |
| `node --check server.js` / `models/*.js` | pass |
| `npm run check:syntax` | 103 files pass |
| `tests/login-email-gate.test.js` | **34/34** |
| `tests/password-mfa.test.js` | **10/10** |
| `tests/account-first-login.test.js` | **23/23** |
| `tests/account-first-login.test.js` + `tests/user-import-upload.test.js` | **43/43** |
| `tests/oidc.test.js` | **21/21** |
| `tests/huawei-native-mfa.test.js` | **4/4** |
| `tests/security.test.js` + `tests/account-merge.test.js` | **43/43** |
| `tests/admin-settings/app-usage/configuration/huawei/huawei-phone-parser/i18n/phone-api/phone/proxy-ip/schema/turnstile/deploy-package` | **108/109** |
| `.artifacts/gate-cooldown-probe.cjs` (scratch, gitignored) | 16/16 |
| `.artifacts/gate-version-probe.cjs` (scratch, gitignored) | 45/45 |
| `.artifacts/gate-smtp-key-probe.cjs` (scratch, gitignored) | 48/48 (ECONNECTION/EAUTH/ETIMEDOUT/ESOCKET) |

`tests/login-email-gate.test.js` includes p4's regressions for B1–B12: stale-state send denial,
zero-row parent rollback for TOTP **and** recovery, no TTL extension on transition, per-target
rate limiting, native header transport with foreign-origin rejection, rotated
`pending_token`/`mfa_url` on the transition, direct-path gate non-bypass, a **failed direct
successor insert rolling back the supplied TOTP factor**, raw-`expected_mail_version` typing, and
case/trailing-slash origin-boundary variants of both send and complete (foreign origin rejected, no
mail/session/authorization code, native cookie-less clients still accepted).

### B12 confirmation (durable)

Guard-path repair is in `server.js` and covered by `tests/login-email-gate.test.js` **34/34**
(focused, latest source):

- `normalizeGuardPath(path)` lowercases and strips trailing slashes once, then is used by
  `requestBoundary` (`browserEndpoint` + `MACHINE_ENDPOINTS` machine allowance + `Cache-Control`),
  `limitRequests` (sensitivity + `mail` category) and the admin static-page gate
  (`ADMIN_ONLY_STATIC_PATHS`, normalised on both sides).
- `SEND_VARIANTS` / `COMPLETE_VARIANTS` (`lowercase`, `UPPERCASE`, `MiXeD`, trailing slash) all
  return `403` for a foreign browser `Origin` with no mail, session or authorization code, while the
  matching native (no-`Origin`) requests still return `200` and reach the handler.
- The guard-path normalisation was the last backend product change; no further backend edits are
  expected from this owner.

## 11. Known failures owned by others

1. `tests/multi-authenticator.test.js` — **resolved** by `w1Q:p4`; the suite now passes **17/17**
   after the race test was realigned to the atomic direct transaction.
2. `tests/huawei.test.js` — *"待绑定华为身份只能绑定已验证登录的账号"* creates its account with
   `f.User.create({ …, password })`, i.e. `email_verified = false` on a **usable** mailbox. Under
   the frozen contract that account must now pass the `email_verify` gate instead of receiving an
   immediate `redirect`, so the test reads `undefined` and calls `new URL(undefined)`. The test
   needs `emailVerified: true` (or a gate-completing login). Test ownership: `w1Q:p4`; suite is
   **47/48** pending that adaptation. Not a product-behaviour defect — it encodes pre-gate
   behaviour.

## 12. Notes for `w1Q:p4` / `w1Q:p5`

- The memory-db adapter already implements all three new statements and reports real affected-row
  counts; `updatePendingContext` stores the JSON **string**, and `readPendingContext` accepts both
  a string and a parsed object, so no further adapter change is required for the context CAS.
- `f.pool.rateLimits` is the store behind `RateLimitModel`; clearing it (existing
  `elapseMailCooldown()`) is what lets a retarget/resend proceed, because the account and target
  limits are intentionally 1/60 s.
- `w1Q:p5`: only `auth.email_gate.missing_version` is currently untranslated (unreachable from the
  shipped frontend). `auth.email_gate.cooldown` is the recoverable 429 key and now always arrives
  with body `retry_after` plus a `Retry-After` header.
