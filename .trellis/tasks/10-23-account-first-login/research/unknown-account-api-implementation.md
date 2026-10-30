# Unknown-account discovery — API test implementation

Owner: API test only (`tests/account-first-login.test.js`). No product, model, i18n, CSS or package edits.
No aggregate run. Contract: `research/unknown-account-contract.md`.

## Frozen behavior (as implemented and now covered)

For `POST /oauth2/authorize` with `discover_account: true`:

| Situation | Response |
| --- | --- |
| Genuinely missing username **or** email (zero matches) | `404 {error:'account_not_found', error_key:'auth.account_not_found', error_description:'账号不存在'}` — no `next`, no destination, no metadata |
| Ambiguous identifier (lookup returns `null` but rows exist) | `200 {next:'password'}`, no account selected |
| Known account with a password | `200 {next:'password'}` (unchanged) |
| Known passwordless + usable mailbox | `200 {next:'set_password', email_masked}` (unchanged) |
| Known passwordless + synthetic/malformed mailbox | `200 {next:'contact_admin'}` (unchanged) |
| Locked identifier | `429 auth.locked`, **before** both OAuth validation and missing-account feedback |
| Banned account | `403 auth.account_banned` (unchanged) |
| Registered-but-invalid OAuth parameters | `400 invalid_client` (unchanged), **before** missing-account feedback |

Server anchors: `server.js:3267` branch; `:3271` length guard; `:3272` `User.findByUsername`;
`:3274` attempt key `login:${id || lower}`; `:3275` `RateLimit.check` (read-only);
`:3276` → `rejectLockedLogin` (`:1587`, 429 `auth.locked`); `:3280` ban; `:3288`
`validateAuthorizationRequest`; `:3295-3303` null-lookup + `findPotentialConflicts` → 404;
`:3306-3308` ambiguous → password step; `:3311-3317` `contact_admin` / `set_password`.
Models: `User.findByUsername` returns the row only when exactly one match (`:98`), so a `null` lookup is
*ambiguous or absent*; `findPotentialConflicts(username, username)` (`:106`) distinguishes them by
matching `username IN (x,x) OR email IN (x,x)`.

## Test changes

Replaced the stale test `discovery hides unknown and ambiguous identifiers behind the password step`
(it asserted the superseded uniform-`password`-step behavior for unknown identifiers, so it was failing
against the landed branch) with three targeted tests.

### 1. `discovery reports genuinely missing identifiers and keeps ambiguous ones behind the password step`

- Genuinely unknown **username** → `404`, `error`/`error_key` exact, and `next`, `email_masked`,
  `exists` all `undefined` (no discovery side channel rides along with the error).
- Genuinely unknown **email address** → same `404` and same absence of a destination.
- Ambiguous (account A's username is set to account B's email; the single-row lookup returns `null`
  while two rows exist) → `200 {next:'password'}`, with `error_key`, `email_masked` and `exists` all
  `undefined`, so the ambiguous account is neither reported nonexistent nor selected.

### 2. `missing-account discovery has no side effects and never consumes a login attempt`

- Six consecutive `404`s for the same unknown identifier; **no** `Set-Cookie` on any of them.
- Zero mails, sessions, access tokens, auth codes, and verification/pending rows.
- The identifier's own attempt budget is untouched: the test computes
  `sha256('login:' + username.toLowerCase())` — exactly `RateLimit.key` (`models/RateLimit.js`) — and
  asserts no `rate_limits` row holds it. Discovery only calls `RateLimit.check` (a `SELECT`), so a
  missing-account answer can never be used to burn a brute-force budget or to pre-lock a real account.
  The assertion is by exact key, not by row count, because the per-IP HTTP throttle writes an unrelated
  `http:auth:<ip>` key.

### 3. `OAuth and lock errors take precedence over missing-account feedback`

- Unknown identifier **+** unregistered `client_id`/`redirect_uri` → `400 invalid_client`, and
  explicitly not `auth.account_not_found`.
- Unknown identifier locked by five real wrong-password logins (the credential path consumes
  `login:<lower>` at `server.js:3411`, so this works for identifiers with no account) → discovery
  answers `429 auth.locked`, not `404`.
- Locked **and** invalid OAuth → still `429 auth.locked`, proving the lock check outranks OAuth
  validation and the missing-account branch.

All other tests in the file were left untouched, including the known-password, `set_password`,
`contact_admin`, malformed/synthetic-mailbox, banned/locked-account, native-probe and generic
unknown-account **recovery send** (`/api/email-verification/send`) cases.

## Verification

| Run | Result |
| --- | --- |
| `node --test --test-timeout=45000 tests/account-first-login.test.js` | **25 / 25 pass** (23 prior, 1 adapted, 2 new) |
| `login-email-gate.test.js` — `accounts without a password keep the existing setup and administrator guidance` | pass |
| `user-import-upload.test.js` — discovery/placeholder selection | 5 / 5 pass |

No aggregate was run; root owns that.

Cross-suite impact checked: only `login-email-gate.test.js:363-375` and `user-import-upload.test.js:700`
also use discovery, and both discover **known** accounts only, so the new `404` cannot affect them.
`user-import-upload.test.js:705` independently confirms `cookie` is `''` when no `Set-Cookie` is sent,
which is what test 2's `!result.cookie` assertion relies on.

## Notes for root / other owners

- p5's i18n keys have landed for all three locales (`public/js/shared/i18n.js:125` zh, `:648` en,
  `:1171` zh-TW) and `views/auth/login.html:271` carries `i18n.js?v=20261025-account-not-found-1`, so the
  server's `auth.account_not_found` has a translation. Verified read-only; not edited.
- The server currently returns `error: 'account_not_found'` with a `404`; the description string is the
  zh text from the contract. If the frontend renders `error_description` rather than the i18n key in
  some path, p6's browser coverage will catch it — API-side contract is as specified.
- Ambiguity is only reachable when a username collides with another account's email; account creation
  does not prevent that, so the test builds it via `User.update`.

## Freeze

Test-only change, confined to `tests/account-first-login.test.js`. No product/model/i18n/package edits,
no support-helper changes needed, no stage/commit/reset/deploy/archive. Frozen pending root's final
review and aggregate.
