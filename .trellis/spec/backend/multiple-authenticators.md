# Multiple Authenticator Contracts

## 1. Scope / Trigger
An existing TOTP user adds another device without replacing the original binding. The profile, native/password login, separate MFA, external providers, administrator reset and database migration must share the same account security state.

## 2. Signatures
- `GET /api/account/totp` returns `{totpEnabled,recoveryCodesRemaining,authenticators:[{id,name,createdAt,lastUsedAt}]}`. Never return active secrets.
- `POST /api/account/totp/authenticators/setup` accepts `{name,code}` and returns `{id,secret,otpauthUri,qrDataUrl,expiresAt}` only for a new pending device.
- `POST /api/account/totp/authenticators/:id/confirm` accepts `{code}` and returns status/list; return initial `recoveryCodes` only for first activation.
- `DELETE /api/account/totp/authenticators/:id` accepts `{code}` for an active device, or `{}` to cancel the current session's pending device.
- Existing setup/enable/disable/recovery endpoints and administrator reset remain supported.
- Schema version 7 introduces `user_authenticators` and `users.totp_revision`. Startup checks the version; only explicit `npm run init-db` migrates it.

## 3. Contracts
Each named device owns an independently generated encrypted secret and monotonic last-used counter. Adding one never copies or exports an active secret. Existing enabled `users.totp_secret` is represented as virtual ID `legacy`, with unknown `createdAt`/`lastUsedAt` set to null. New-only users may have `totp_enabled=true` and `totp_secret=null`; login must not treat that as missing MFA.

Existing MFA requires a current device code or unused account-wide recovery code before staging. First enrollment requires a session created within five minutes. Device names are required, at most 64 characters. At most one pending device per account, five-minute expiry, five failed confirmations, bound to the same user/session/security-state HMAC. Activate only after verifying the new device's code; cancellation and failures preserve active devices.

Recovery codes are account-wide and consumed atomically. Addition preserves remaining codes; regeneration requires an active dynamic code, replaces the full set and returns clear codes only once. Last-device removal clears the enabled flag/recovery state. Legacy disable and admin reset clear every device. Self-service mutations and administrator self-reset retain the current real session row ID while revoking other sessions and OAuth credentials.

`Authenticator.withUser` holds a MySQL named lock, transaction and user `FOR UPDATE` row through each lifecycle change. All queries in its callback use models bound to the held connection, including settings/rate limits/sessions/tokens. Never use the global pool while occupying lifecycle connections. Release locks and connections in nested `finally`; failed revision/activation rolls back.

Confirm/removal/reset/recovery regeneration advance `totp_revision` and invalidate pending setups/logins. `finishAccountLogin` reacquires the same lifecycle lock, reads fresh security state and keeps it through pending challenge consumption and durable session/authorization-code issuance. This applies to local direct login, native OAuth, separate/external MFA, OIDC/Huawei and existing-session authorization. Verifying a code then releasing the lock before final credential issuance without a fresh guard allows a removed device's stale request to recreate access. Do not await SMTP under these locks.

## 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| Unauthenticated request | 401 |
| Empty/too-long device name | 400 `auth.totp.name_required` |
| First enrollment with an old session | 403 `auth.totp.reauthentication_required` |
| Administrator disabled TOTP enrollment | 403 `auth.totp.disabled` |
| Wrong/used management or new code | 400 `auth.totp.invalid` |
| Pending expired or security/session mismatch | 400 `auth.totp.setup_expired` |
| Pending exhausted five failed confirmations | 429 `auth.totp.setup_locked` |
| Another account/session cancels pending device | 404; preserve owner state |
| Lifecycle change before final login mint | 401; no new session or authorization code |

## 5. Good / Base / Bad Cases
- Good: legacy phone plus independently enrolled tablet; either device completes a real login, and removing the phone leaves the tablet usable.
- Base: first enrollment generates recovery codes; addition uses proof and preserves them.
- Bad: close while setup response is delayed; cancel the server-created pending record when response arrives and clear QR/secret DOM.
- Bad: valid factor checked, then last device removed before issuance; reject the stale login instead of creating a fresh session.

## 6. Required Evidence
- `tests/multi-authenticator.test.js`: independent devices/replay, recovery, scoped access, expiry/exhaustion, removal/reset, transactions, concurrent confirmation and deterministic final-issuance races; held-connection assertions.
- Existing security/password-MFA/native/OIDC/Huawei/schema tests remain green.
- `tests/multi-authenticator-browser.cjs`: real old/new-device login, desktop/mobile enrollment/list/removal, visible errors, reload persistence, last-device warning, DOM cleanup, cancellation including delayed setup response. Await DELETE success before testing rejected confirmation.
- Archive contains current schema/model/server/profile/CSS/JS and zero `public/assets` entries. Isolated adapter tests do not establish real MySQL transaction/lock behavior or live deployment success.

## 7. Wrong vs Correct
Wrong: expose the original QR again, overwrite an enabled secret, infer enabled MFA solely from `totp_secret`, or issue credentials from a stale verified user object.

Correct: new independent pending secret with old-factor proof/new-factor confirmation, per-device counter CAS, explicit account revision, transaction-bound persistence and fresh guarded final issuance.
