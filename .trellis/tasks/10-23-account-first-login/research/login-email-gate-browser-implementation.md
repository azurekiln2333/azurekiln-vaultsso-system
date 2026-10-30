# Login email gate — browser implementation report

Owner: `w1Q:p6` (browser tests + `check:browser` registration)
Task: `.trellis/tasks/10-23-account-first-login`
Contract: `research/login-email-gate-contract.md` (frozen 2026-10-24)
Artifacts: `tests/login-email-gate-browser.cjs`, `.artifacts/login-email-gate/`, `package.json` `check:browser`

## Deliverables

| File | Change |
| --- | --- |
| `tests/login-email-gate-browser.cjs` | new — 20 scenarios × desktop 1440 / mobile 390, real Chrome |
| `package.json` | `check:browser` now runs the new file after `account-first-login-browser.cjs` (root-approved) |
| `.artifacts/login-email-gate/*.png` | screenshots, fixed gitignored path (not the task research dir) |

No product code, fixture, `memory-db.js`, spec or other worker's file was edited.

## Flow the tests drive

The gate is a **`/oauth2/mfa` stage**, not a login-page form (contract §HTTP/UI). Every gate scenario
therefore goes through the real two-step login and then the MFA page:

```
/oauth2/authorize → #loginUsername → #loginForm .submit (Continue) → #loginPassword
  → #loginForm .submit → redirect /oauth2/mfa → #emailGateControls
  → manual #sendEmailGateCodeBtn (never automatic: code_sent=false)
  → #code (disabled until a send succeeds) → auto-submit → session / OAuth callback
```

Assertions are read from persisted state (`GET /api/v1/auth/oauth/oidc/pending`, `f.pool.users`,
`f.mails`, `f.pool.sessions`, `/api/profile`, decoded `id_token`), not from copy alone.

## Scenario matrix

| # | Scenario | Key assertions |
| --- | --- | --- |
| 1 | Verified mailbox, switch off | no `/oauth2/mfa`, no `#emailGateControls`, zero mail, one session |
| 2 | Verified mailbox + `login_email_code=true` | ordinary email factor on `/oauth2/mfa`, `#code` name `email_code`, **no** gate controls, one code, session |
| 3 | Unverified bound mailbox → verify gate | `factor:'email_verify'`, `email_gate:'verify'`, `email` = masked stored **before** send, `code_sent:false`, `mail_version:0`, no `#bindEmailInput`, `#code` disabled; after send `mail_version:1`, mail to stored address, `#code` enabled; completion → session, `email_verified:true`, mailbox unchanged, 1 mail |
| 4 | No mailbox → bind gate | `factor:'email_bind'`, `email_gate:'bind'`, `email:''` before send, `#bindEmailInput` visible/`type=email`/required, `#code` disabled; invalid address sends nothing; valid address → masked target after send, code to that address; completion → session, mailbox = target, `email_verified:true` |
| 5 | Synthetic `@users.invalid` mailbox | gated as **bind** (unusable mailbox ≠ verifiable), pending payload and hint never expose the synthetic address, zero mail to it, rebinds to a real proven address |
| 6 | TOTP → gate (`next_step`) | TOTP wins first, gate controls absent at TOTP stage, zero mail; after TOTP the intermediate `next_step` rehydrates the gate **on `/oauth2/mfa`**, code cleared, `#code` disabled again, rotated pending still readable, then one send + one code → session + verified |
| 7 | Recovery code → gate | recovery toggle path also transitions to the gate with no credentials, then one send + code → session + verified |
| 8 | Global switch + gate | exactly **one** mail for the whole login; the gate proof satisfies the login email factor, no second `/oauth2/mfa` hop, session + verified |
| 9 | Full OAuth continuity | hidden OAuth fields survive the account step; gate completion returns to the client callback with the original `state`; `f.exchange` 200; `id_token.nonce` matches and `id_token.email_verified === true`, `email === stored` |
| 10 | Wrong code | error surfaced, no session, `email_verified` still false; the correct code still completes afterwards |
| 11 | Edited bind target | code sent to address A, input edited to B → no completion, no session, mailbox still unbound, B never receives the code |
| 12 | Taken mailbox | bind to another account's address → no mail, `#code` stays locked, account untouched, no session |
| 13 | Initial-password setup unchanged | `#passwordSetupForm`, masked stored email, manual `#sendSetupCodeBtn`, no gate controls, setup never authenticates, then the new password logs in (verified → no gate) |
| 14 | Contact administrator unchanged | passwordless + unusable mailbox → `#loginContactAdmin`, no send action, no gate controls, zero mail, zero session |
| 15 | **Reload after a bind code was sent** (review F1) | after an ordinary reload the gate rehydrates from the server: `code_sent:true`, `mail_version:1`, `#emailGateMasked` shows the persisted masked destination, `#bindEmailInput` stays empty (the full address is never returned), code entry is unlocked, and completion for the persisted destination succeeds → session, `email === persisted target`, verified |
| 16 | **Reload then retarget** (review F1) | typing a different address after a reload re-locks code entry, surfaces a send-required message, emits **no** completion request, and leaves the account unbound/unverified (the persisted destination is never verified while another is shown); a fresh send goes to the new address with `mail_version:2` and only then binds it |
| 17 | **Terminal 401 / 429** (review F2) | expired pending (cookies cleared) → 401, and exhausted attempt budget → `[400,400,400,400,400,429]`; after each, `#code`, `#submit` **and** `#sendEmailGateCodeBtn` stay disabled through the submit finalizer and a later cooldown render, with no session and no verification |
| 18 | **TOTP `next_step` + failed rehydration** (review F3) | the authenticator stage commits (200) but the follow-up pending GET fails; the consumed stage must not come back usable — code entry, completion and the stale recovery toggle all stay disabled, no further completion request is emitted, and no credentials are issued |
| 19 | **Delayed send failure** (review F4) | with a usable proof held, a send that fails late (delivery error) leaves code entry in agreement with the authoritative projection, clears the typed code so nothing is replayable, sends no extra mail, keeps the send action retryable, and one real resend completes |
| 20 | **Rejected retarget, then a restore** (review F1 follow-up) | send A, edit B (a mailbox another account owns), B's send is rejected `>= 400` with no mail to B; the follow-up GET restores the active A proof; the UI never offers a usable proof for a destination it does not show (asserted as `input empty OR entry locked`, plus no completion request and no binding while B is displayed); clearing the destination lets A's code complete and only A is bound |

Cross-cutting: `expectAnonymous()` (profile 401 + zero session rows) is asserted at every gate stage
before final completion; each screenshot is preceded by a horizontal-overflow check; `pageerror`
collections must be empty.

## Legacy expectations

No existing browser test asserted "password + unusable/unverified mailbox logs straight in", so no
old expectation had to be rewritten: every pre-existing file uses `f.user()` (verified) or a
passwordless account. `tests/user-import-upload-browser.cjs` keeps its passwordless
`contact_admin`/`未绑定邮箱`/grouped-result coverage untouched, which is exactly the behavior the
contract preserves for accounts without a password.

## Reviewer edge coverage (added after `research/frontend-review.md`)

Scenarios 15-19 were added for the four open reviewer paths. They encode the **required** post-fix
behavior, so they are expected to fail against any snapshot that still has F1/F2/F3/F4 open and are
the acceptance gate for those fixes.

- **F1** (15/16): the server destination stays authoritative across a reload without returning the full
  address, and an edited destination requires an explicit resend instead of silently completing for the
  message the user can no longer see.
- **F2** (17): the terminal state survives `setMfaSubmitting(false)` in the completion finalizer and
  `renderGateCooldown()`, and the send action is terminal too.
- **F3** (18): a committed `next_step` whose rehydration fails must not leave the consumed
  TOTP/recovery form usable.
- **F4** (19): after a failed send, code entry must agree with the authoritative `GET /pending` projection and any typed code must be cleared, so a client can never hold a replayable proof the server no longer honours. The scope note below explains why this is the correct invariant for a pre-reservation failure.
- **F1 follow-up** (20): a rejected retarget must not leave the UI offering a usable proof for a destination it does not display; the restored persisted proof must still be the one that can complete.

Instrumentation notes:

- `submitGateCode()` resolves the HTTP status of each completion call, so retryable (`400`) and terminal
  (`401`/`429`) outcomes are asserted on the wire, not on copy.
- `completionRequests()` counts completion POSTs to prove that a locked/edited/failed state emits no
  extra attempt.
- Scenario 19's late delivery failure is emulated at the network layer (an 900 ms delayed `502` on
  `/oidc/email/send`) because the shared fixture's mail transport is owned by `w1Q:p4` and cannot be
  forced to throw here; the server-side reservation/SMTP-failure semantics stay in p4's API coverage.
  The assertion is the client's fail-closed reaction, which is what F4 reports.
- Scenarios 16 and 19 need a second send on the same account. The frozen contract enforces the 60s resend
  cooldown, so `expireSendCooldown()` clears the isolated scenario's rate-limit counters and reloads,
  simulating the cooldown elapsing. Keys are hashed; the historical prefix-based cleanup was corrected
  before the passing run. The cooldown itself is asserted on every successful send inside `clickSend()`.
- Scenario 17's expired-pending case drops the browser cookies, which is the real 401 path.

## Static review against the landed implementation (no browser run)

Reviewed `server.js` gate factor/context helpers, the send/complete endpoints, `public/js/pages/auth/mfa.js`,
`views/auth/mfa.html`, `models/User.js`, `models/EmailVerificationCode.js`, `tests/support/memory-db.js`
and the `auth.email_gate.*` i18n keys. Corrections applied to the test:

| Finding | Correction |
| --- | --- |
| `#emailGateControls` and `#sendSetupCodeBtn` are always in the DOM (hidden), so `.count()` was wrong | switched to `isVisible()` assertions |
| `#emailGateMasked` renders `"<masked_label> <mask>"`, not the bare mask | assert it **contains** the exact mask and never the full address |
| The frontend re-locks code entry when the bind address is edited | scenario 11 now asserts code entry is disabled + a send-required message is shown, instead of assuming an enabled field |
| The send-unlock happens after the response round trip | the code-entry-unlocked assertion now waits for the transition |

Confirmed statically:

- Ordering `server.js:3304` TOTP → `3326-3328` gate → `3331` email factor, so a gate **never** reaches the
  email factor: one gate code satisfies the login email factor even with `login_email_code=true`.
- Login response `server.js:1340-1354` returns `mfa_url`, `email_gate`, `require_email_code:true`,
  `code_sent:false`; `login.js` already redirects on `mfa_url`.
- `gatePendingFields` (`server.js:1480-1495`) projects exactly the asserted fields: `email_gate`, masked
  `email` (verify falls back to the stored mailbox, bind is `''` before send), `mail_version`,
  `code_sent` (derived from the active exact code row), `retry_after`. Synthetic addresses are never
  projected.
- Gate completion (`server.js:2972-3020`) requires an integer `expected_mail_version` matching the stale-safe
  version, resolves the exact `codeId`, verifies the hash under the account lock, then
  `markEmailVerifiedIfUnchanged` / `bindEmailIfUnchanged`, consumes code + parent, and issues credentials
  from the refreshed user (so `id_token.email_verified` is true). Client-supplied targets are ignored.
- TOTP → gate commits the successor stage with the parent consumption and only then rotates the pending
  cookie, returning `{next_step:true, factor, message_key, ...gateFields}`; `mfa.js` rehydrates in place and
  clears code/recovery/feedback/auto-submit markers.
- Historical snapshot: IP 10/min, account 10/min and target 5/10min were observed here before B4 was
  repaired. Final account and target cooldowns are each one send per 60 seconds, with the shared IP
  ceiling ten per minute. Target validation precedes account/target reservation, so the invalid-address
  and taken-mailbox scenarios can still send afterwards. Final behavior is verified below and in the
  backend review; the former account/target values are superseded.
- `memory-db.js:456,464` implement both conditional `users` updates, and `updatePendingContext` is at
  `memory-db.js:712`; the fixture can exercise the gate.

### Frozen contract vs. current snapshot — open gaps (not blessed)

`login-email-gate-contract.md` is authoritative. The snapshot inspected earlier diverged from it; those
divergences are recorded here as **gaps being closed by p3/p5**, and the tests now assert the frozen shape
so they fail until each gap is closed:

1. Send success body must be `{sent:true, mail_version, email, code_sent:true, retry_after:60}`. p3 is
   restoring `sent:true` and the 60s resend cooldown. `clickSend()` now asserts `sent`, `code_sent`,
   `mail_version`, a string `email`, a positive `retry_after <= 60`, plus the persisted projection's
   cooldown and the disabled send action.
2. The TOTP/recovery → gate intermediate response must carry `next_step:true` **and** `mfa_url:'/oauth2/mfa'`
   plus the same challenge metadata as the pending GET. p3 is restoring `mfa_url`; scenarios 6 and 7 now
   assert the full frozen shape (`next_step`, `mfa_url`, `factor`, `email_gate`, `code_sent:false`,
   `mail_version:0`, masked `email`).
3. Gate send/complete error keys in the snapshot (`auth.email_gate.stale` / `.invalid_email` /
   `.email_taken` / `.unsupported` / `.rate_limited`) still need to be reported by their owners. The tests
   assert behaviour and HTTP status rather than literal keys, so this remains an integration item.
4. `#emailGateMasked` text is prefixed with `auth.email_gate.masked_label`; the test asserts it contains the
   exact mask and never the full address, which holds for either string.
5. Native `X-Oidc-Pending` transport for the new send endpoint is part of the frozen contract but is covered
   by p4's API tests, not this browser suite.

## Focused real-browser run — PASS

```powershell
node tests/login-email-gate-browser.cjs
```

**Exit 0.** 20 scenarios × desktop 1440 / mobile 390 (40 browser passes), 36 screenshots in
`.artifacts/login-email-gate/` (18 states × 2 viewports). No horizontal overflow at either width;
`pageerror` collections empty in every scenario.

Frozen-contract items now verified in a real browser (p3 landed them before this run):

- send response `{sent:true, mail_version:1, email:'a-***@example.test', code_sent:true, retry_after:60}`
  plus `pending_token` / `pending_header`;
- the 60s resend cooldown is real and enforced: the send action renders `重新发送（60s）` and stays
  disabled, and the persisted projection reports the remaining `retry_after`;
- `next_step` intermediate response carries `mfa_url:'/oauth2/mfa'` with the full gate metadata;
- gate completion requires `expected_mail_version`, binds the **persisted** target, and the refreshed
  user yields `id_token.email_verified === true` with the original `state`/`nonce`/PKCE verifier.

### Defects found during this run

**None in product code.** Two failures were my own test assumptions, both corrected without weakening any
assertion:

1. Recovery codes are not six digits, so no auto-submit fires — `submitGateCodeResponse()` now clicks
   `#submit` for non-6-digit codes (this also restored scenarios 6-7's frozen `next_step` assertions).
2. `expireSendCooldown()` deleted rows by the `mailgate:` prefix, but the rate-limit model **hashes**
   its keys (observed rows: `b926e9…`), so the cooldown was never cleared. It now clears the scenario's
   counters outright (each scenario starts from `f.reset()`), which fixed the resend paths in 16, 19, 20.

### Scope note on F4

Scenario 19's delivery failure is injected at the network layer, so the server never reserves or
invalidates anything and the previous exact code genuinely stays active. A blanket "entry must stay
locked" assertion would therefore have been wrong: the client correctly re-syncs from the authoritative
projection. The scenario now asserts the invariant that matters — **code entry agrees with
`code_sent` from `GET /pending`**, the typed value is cleared so nothing is replayable, no extra mail is
delivered, and a real resend still completes. The true post-reservation SMTP-failure path (server-side
invalidation + reserved `mail_version` + rollback) belongs to `w1Q:p4`'s API coverage.

## Screenshot inventory

`.artifacts/login-email-gate/` — 36 PNGs (18 states × desktop 1440 / mobile 390). Every screenshot is
preceded by a horizontal-overflow assertion.

| State | Scenarios |
| --- | --- |
| `verified-switch-email-factor` | 2 |
| `verify-gate-before-send`, `verify-gate-after-send` | 3 |
| `bind-gate-before-send`, `bind-gate-after-send` | 4 |
| `totp-before-gate`, `totp-then-gate` | 6 |
| `gate-wrong-code` | 10 |
| `gate-edited-target`, `gate-taken-mailbox` | 11, 12 |
| `contact-admin-unchanged` | 14 |
| `bind-reload-code-sent` | 15 |
| `bind-reload-retarget` | 16 |
| `gate-terminal-401`, `gate-terminal-429` | 17 |
| `totp-next-step-rehydrate-failed` | 18 |
| `gate-send-failed-cleared` | 19 |
| `gate-rejected-retarget-restored` | 20 |

Spot-checked: the rejected-retarget restore shows the masked persisted destination with the edited input
cleared and the send-required hint (UI target and proof agree); the terminal 401 shows all three controls
disabled with the expired-challenge message.

## Status

**PASS** — 20 scenarios × desktop 1440 / mobile 390. Focused run completed against the integration
candidate; root still owns the final aggregate `check:browser` run.
