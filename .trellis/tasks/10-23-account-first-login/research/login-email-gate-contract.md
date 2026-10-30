# Post-password email gate — frozen implementation contract

Status: implementation authorized; frozen 2026-10-24 by coordinator. This contract supersedes provisional suggestions in the four research reports. No further product-policy approval is needed.

## Required behavior

All local-password entry points (web, native/probe/direct factor submissions, OAuth continuation) enforce:

1. Password + usable verified mailbox: preserve existing login, TOTP preference, and the global `login_email_code` switch. The user explicitly chose to retain that switch.
2. Password + no usable mailbox: correct password and required CAPTCHA, then TOTP/recovery if configured, then bind a new unique mailbox and prove it by email code before credentials.
3. Password + usable unverified mailbox: same ordering, then prove the currently stored mailbox. Successful proof sets `email_verified=true` atomically with login completion.
4. No password + usable mailbox: retain existing manual-send initial-password setup followed by normal login.
5. No password + no usable mailbox: retain contact-administrator guidance.

Usable means nonempty normalized valid mailbox and not `@users.invalid`; unusable mailboxes are unbound even if a corrupt verification flag is true. NULL verification is false. Mandatory email proof satisfies that login's email factor even when the global switch is enabled; do not request another email code. External OIDC/Huawei login sources retain their current policies.

## Persisted stages and authority

Reuse the existing signed `oidc_pending` JWT and `password_mfa` database pending row. Add factors `email_bind` and `email_verify`, only for password source. Existing factors `totp` and `email` remain.

Add `Boolean(user.email_verified)` to `pendingLoginSecurityState`; keep email, password, role/ban, phone and authenticator bindings. New stage authority exists only after the actual password + CAPTCHA checks and, if enabled, completed TOTP/recovery. Native `check_verification` may report metadata but must not grant gate authority or send a mandatory-gate email before those checks.

The persisted next stage carries server-controlled `totpSatisfied: true` when an authenticator was required and completed, and an absolute original password-proof expiry. Stage transition and resend must never extend that expiry. Do not relax external-source email-factor guards. A TOTP stage advances by atomically consuming its old pending and creating exactly one next pending under `Authenticator.withUser`; recovery-code/TOTP replay consumption belongs to the same transaction. No credentials are issued at transition.

New gate pending context includes:

```json
{ "returnTo": "existing safe OAuth continuation", "totpSatisfied": true,
  "proofExpiresAt": "absolute timestamp", "mail": {
    "version": 0, "targetEmail": null, "codeId": null, "sentAt": null
  } }
```

The ordinary pending source/provider/subject/factor/challenge/securityState fields keep their established location. `totpSatisfied` need only be present when meaningful. The backend owner can choose timestamp serialization consistent with existing code, but names in HTTP payloads below are frozen.

## HTTP/UI contract

Use the existing `/oauth2/mfa` page for every pending factor, including both new gates. Do not create a second gate form on the login page. The existing login response keeps `mfa_url`; add `email_gate: 'bind' | 'verify'` for gates, `require_email_code:true`, and `code_sent:false`. Preserve native header transport. The initial account-discovery response for password-bearing users remains password-only and sends nothing.

`GET /api/v1/auth/oauth/oidc/pending` keeps current fields (`factor`, masked `email`, `login_url`, etc.) and for gates adds:

```json
{ "factor": "email_bind", "email_gate": "bind", "email": "",
  "mail_version": 0, "code_sent": false, "retry_after": 0 }
```

After send, `email` is the masked persisted target. For verify, it is the masked stored mailbox even before send. Never expose synthetic addresses or full stored mailboxes. `code_sent` must reflect an active exact code row, including SMTP-failure cleanup.

New endpoint: `POST /api/v1/auth/oauth/oidc/email/send`, same cookie or `X-Oidc-Pending` transport as completion. Allow only valid password-source `email_bind`/`email_verify` pending. Apply existing machine-client/origin validation and suitable IP/account/mail cooldown/limits. No anonymous account selector.

```json
{ "expected_mail_version": 0, "email": "new@example.com" }
```

`email` required only for bind. Verify always uses current stored mailbox; if an email is supplied, require normalized equality. The version is required integer >=0; it prevents stale concurrent actions and is not authority. Response:

```json
{ "sent": true, "mail_version": 1, "email": "ne***@example.com",
  "code_sent": true, "retry_after": 60 }
```

On SMTP failure return 502, include the reserved `mail_version`, consume only that exact code row, and allow recovery via pending GET + resend after cooldown. State conflicts return 409. Useful new stable `message_key` values (frontend owner translates): `auth.email_gate.bind_hint`, `auth.email_gate.verify_hint`, `auth.email_gate.bind_title`, `auth.email_gate.verify_title`, `auth.email_gate.send`, `auth.email_gate.sent`, `auth.email_gate.send_required`, `auth.email_gate.changed`. Reuse established email validation/taken, code-invalid/expired/locked, rate-limit and send-failed keys where appropriate. Backend/frontend owners may add precise translated keys as needed, communicating actual API keys in reports.

`POST /api/v1/auth/oauth/oidc/complete` keeps `{code}` for existing factors. Gate completion requires:

```json
{ "code": "123456", "expected_mail_version": 1 }
```

Do not trust a completion-supplied target; proof is bound to persisted target. If accepted as an optional consistency check it must match exactly. TOTP -> gate returns an intermediate 200 response `{next_step:true,mfa_url:'/oauth2/mfa'}` plus next challenge metadata (same shape as pending GET) and rotates pending cookie/header **after transaction commit**. Do not clear it. Frontend refreshes/rehydrates the next stage and clears the previous code, recovery mode, feedback and autosubmit marker. Only a final response has the existing `redirect` and clears the pending cookie.

MFA selectors: retain `#mfaForm`, `#code`, `#codeEntry`, `#submit`, `#status`, `#instructions`, `#mfaTitle`, `#recoveryToggle`. Add `#emailGateControls`, `#bindEmailInput` (bind only), `#sendEmailGateCodeBtn` (both gates), `#emailGateMasked`. Bind input is type=email and required only in bind mode; code entry/complete disabled until successful send. Manual sending applies to both gates. Preserve six-digit slots/auto-submit/IME/recovery behavior for existing stages. Prevent send/complete overlap, stale replies, duplicate actions, and completion using a code for an edited destination. Cooldown and all copy support current three languages. Update asset cache versions. Desktop/mobile visual checks required.

## Exact proof / transaction contract (mandatory)

Use distinct email code purpose `login_gate`; do not use `findLatestActive(email,purpose)` as gate proof. OTP row context:

```json
{ "parentPendingId": "uuid", "stage": "bind", "version": 1,
  "targetEmail": "new@example.com" }
```

The code row's internal `stage` is `bind`/`verify`, mapped one-to-one from the signed parent factor `email_bind`/`email_verify` and compared under lock; public factor names remain unchanged.

Every send and complete enters `Authenticator.withUser` and uses connection-scoped model instances to re-read the exact parent pending row. Validate JWT jti/challenge/purpose/user/source/factor/securityState/expiry/consumption again under the account lock. Avoid pool-scoped helper reads or nested account-lock helpers inside the transaction.

Send, under lock: require expected version=current; validate target and uniqueness, cooldown/account limits; reserve next version; invalidate previous exact `codeId`; create a distinct random OTP row with exact user/parent/stage/version/target; update parent context version/target/codeId/sentAt; commit. Same-version concurrent sends permit only one winner, and only that winner sends. SMTP runs **outside locks and transactions** after commit. SMTP failure consumes only the reserved exact code ID, never a later code or latest-by-mailbox row. Code expiry <= original absolute proof expiry.

Complete, under lock: require expected version=current and positive; resolve exact codeId and require user/purpose/parent/stage/version/target, active expiry and attempt budget, constant-time matching hash. Wrong-code attempts persist without writing the user. Verify stage must target current stored usable email; bind stage requires current mailbox still unbound and target unique. Conditional user mutation, exact code consumption, parent pending consumption, refreshed user read and final session/OAuth credential issuance form one transaction. Email verification and final claims use the refreshed user, so id_token reports verified=true.

Keep the parent's five-attempt budget across resend/retarget: a fresh OTP row must not reset the stage budget. Pending GET determines `code_sent` from the exact active unconsumed code row, including SMTP-failure cleanup, rather than trusting a stored boolean.

`Authenticator.withUser` commits on ordinary callback return, including error objects. **After any success-path writes, every failed condition/unique conflict/consume-zero/issuance failure must throw a controlled error to roll back.** Convert it to HTTP outside the transaction. HTTP success/cookie handling is after commit. Do not partially bind/verify on an eventual error. No prior-stage replay, duplicate credentials, code reuse across pending records, stale-target proof, or pre-completion session/code/token is allowed.

Minimal backend models: add conditional bind/verify methods to User and pending-context update method to EmailVerificationCode; existing pending_context JSON needs no schema change. Account-row locks serialize changes; a version condition in SQL is welcome but must not replace under-lock reread. Memory adapter must model new operations and real rollback behavior sufficiently for meaningful tests.

## Ownership and checks

- Herdr `w1Q:p3`: server.js, models/User.js, models/EmailVerificationCode.js, backend API docs if necessary. Implement directly; no spawned replacement.
- `w1Q:p4`: API tests and tests/support/fixture.js, memory-db.js. Coordinate exact SQL with p3. Cover full matrix, probe/direct/native bypass, TOTP/recovery transitions, stale state, replay, concurrent send/complete, retarget/resend, SMTP lock/failure, expiry and rollback/claims.
- `w1Q:p5`: auth frontend JS/templates/i18n/minimal CSS, cache versions. Keep completed import UI intact.
- `w1Q:p6`: browser tests (new login-email-gate-browser.cjs plus necessary legacy expectation updates); package.json script registration with coordinator agreement. Cover desktop/mobile manual-send bind/verify, verified global switch, TOTP chain, PKCE, wrong/stale target/code and unchanged setup/contact/import behavior.

All workers are sharing the codebase; preserve others' edits and unrelated dirty work. Do not commit/stage/reset/deploy/archive. Write durable implementation + validation reports. Root owns aggregate runs and task/spec integration. API/browser tests may run focused checks; do not race the final aggregate run.
