# Login email gate — browser research (password accounts with missing / unverified mailbox)

Owner: Pi p6 (browser test ownership only)
Task: `.trellis/tasks/10-23-account-first-login`
Status: **RESEARCH ONLY.** No product, test, fixture, spec or `package.json` edit was made this turn.
Deliverable: this file only — `research/login-email-gate-browser-research.md`.
Purpose: hand the coordinator concrete sources, minimal design options, risks, proposed selectors and
browser acceptance cases so it can freeze the implementation contract. Priorities: preserve every
existing fix (account-first two-step login, import cap/upload/optional-mail/grouping, MFA/OAuth
continuation, security-state invalidation, native direct-code compatibility).

---

## 1. Authorized rules being researched

1. password + bound **verified** mailbox → normal password login; TOTP if enabled.
2. password + **no mailbox** → after correct password, prompt to **bind a NEW** email and verify it.
3. password + bound **unverified** mailbox → after correct password, send a code to the **stored**
   email; the correct code **atomically marks it verified** and completes login.
4. Keep the existing global `login_email_code` switch. Verified accounts still need email MFA when
   it is ON; TOTP precedence is preserved.
5. Order: password/CAPTCHA → TOTP if active → mandatory email bind/verify if missing or unverified
   → final session/OAuth.
6. **One code** satisfies the mandatory verification *and* the login email factor. No duplicate send.
7. Unchanged: no-password + usable mailbox → initial-password setup; no-password + no mailbox →
   `contact_admin`.
8. Never expose bind/verify before password proof. No session, cookie, authorization code or token
   until every required step is complete.

---

## 2. Verified source anchors

| Concern | Anchor |
| --- | --- |
| Discovery branch (stateless, no mail) | `server.js:2706-2751` |
| Discovery: user **with** password → `{next:'password'}` | `server.js:2736` (`!discoveryUser \|\| discoveryUser.password`) |
| Discovery: passwordless + unusable mailbox → `contact_admin` | `server.js:2738-2741` (uses `normalizeEmail` / `isSyntheticEmail` / `isValidEmail`) |
| Discovery: passwordless + usable mailbox → `set_password` | `server.js:2743` |
| Discovery never mails / no session / no lockout consumption | `server.js:2718-2727` (`RateLimit.check`, no `consume`) |
| Main login body: length guard, lock, captcha grace | `server.js:2755-2776` |
| CAPTCHA gate (global toggle or `captcha_required`, grace window) | `server.js:2812-2825` |
| Password attempt consumed **after** CAPTCHA | `server.js:2828-2830` |
| Wrong password (single generic error) | `server.js:2832-2843` |
| **TOTP precedence over email** | `server.js:2846-2868` |
| **Email factor: `login_email_code` only, NO synthetic guard** | `server.js:2869-2897` |
| `finishAccountLogin` → `completePasswordLogin` → `buildAuthorizationResponse` | `server.js:2900-2906` |
| `completePasswordLogin` (clears `login_step`, session, alert, last IP) | `server.js:1281-1295` |
| `finishAccountLogin` re-reads user + re-checks security state | `server.js:1297-1306` |
| `pendingLoginSecurityState` HMAC — binds `email`, **not** `email_verified` | `server.js:1205-1211` |
| `beginOidcSecondFactor(res,user,returnTo,factor,providerKey,source,extraContext)` | `server.js:1212-1233` |
| − issues a code **only** when `factor === 'email'`, purpose `EMAIL_PURPOSE_LOGIN` | `server.js:1215-1217` |
| − pending purpose `password_mfa` when `source === 'password'` | `server.js:1219` |
| − `pending_context` = `{ returnTo, ...extraContext }` | `server.js:1221` |
| `beginPasswordSecondFactor` builds OAuth `returnTo` + `grantCaptchaContinuation` | `server.js:1263-1280` |
| `login_step` proof cookie (kind/userId/ip/expiresAt) | `server.js:383-391` |
| `/oauth2/mfa`, `/oidc/pending`, `/oidc/complete` | `server.js:2621-2649` |
| `oidc/complete` factor handling — **only `totp` and `email`** | `server.js:2642-2646` |
| `oidc/complete` consumes code once, then session + continuation | `server.js:2649-2690` |
| `issueEmailVerificationCode({email,purpose,userId})` — arbitrary target, 60s cooldown per `email+purpose` | `server.js:1749-1776` |
| `verifyEmailCode({email,purpose,code,userId})` — single-use `consume` | `server.js:1778-1822` |
| Email purposes whitelist (public endpoint) | `server.js:1725-1727` |
| `isSyntheticEmail = /@users\.invalid$/i` | `server.js:2155` |
| Factor hints **with** synthetic guard (OIDC / Huawei) | `server.js:2131-2133`, `server.js:2385-2387` |
| Native `check_verification` probe (factor hint **with** guard) | `server.js:2779-2806` |
| Registration requires code + marks verified | `server.js:3126-3147` |
| Password reset marks verified | `server.js:3322` |
| Import sets `email_verified` from `ischeck`; synthetic forced false | `server.js:4601-4609`, `server.js:4650` |
| `User.findByUsername` = `username = ? OR email = ?` | `models/User.js:98-104` |
| `findPotentialConflicts` | `models/User.js:106-112` |
| `setInitialPassword` conditional write (model for a conditional bind) | `models/User.js:262-270` |
| `setLoginStep` + `STEP_FIELDS = {account, password, setup, contact}` | `public/js/pages/auth/login.js:310-345`, `:20-24` |
| `mfa_url` → `window.location.assign('/oauth2/mfa')` | `public/js/pages/auth/login.js:517-520` |
| Step transitions (`setup`, `contact`) | `public/js/pages/auth/login.js:637-648` |
| Login + setup forms each carry hidden OAuth fields | `views/auth/login.html:49-57`, `:143-151` |
| MFA page selectors | `views/auth/mfa.html:31-54` |
| MFA renders `totp` vs `email` only | `public/js/pages/auth/mfa.js:66-93` |
| Fixture always creates a **verified** user with email | `tests/support/fixture.js:75-80` |
| Fixture `lastCode(email)`, `mails`, `pool.settings` | `tests/support/fixture.js:120-125`, `:139` |
| TOTP seeding pattern | `tests/multi-authenticator-browser.cjs:41-43`, `./support/totp-code` |
| Existing `login_email_code` toggling in tests | `tests/account-first-login-browser.cjs:279`, `:547` |

---

## 3. Current behavior matrix (today, before any change)

| Account state | `login_email_code` | Today's result |
| --- | --- | --- |
| password + verified mailbox | off | session directly ✔ (target: unchanged) |
| password + verified mailbox | on | email code factor (`totp` wins if enabled) ✔ (target: unchanged) |
| password + **unverified** mailbox | off | **session directly** ← target changes |
| password + **unverified** mailbox | on | email code factor, but `email_verified` never set ← target changes |
| password + **no/synthetic** mailbox | off | **session directly** ← target changes |
| password + **no/synthetic** mailbox | on | tries to mail `…@users.invalid` ← **pre-existing bug**; target changes to bind |
| password + TOTP + unverified/no mailbox | any | TOTP → session ← target: TOTP then gate |
| no password + usable mailbox | any | discovery `set_password` ✔ (unchanged) |
| no password + no mailbox | any | discovery `contact_admin` ✔ (unchanged) |

Two facts that drive the design:

- **Discovery already returns `password` for any account with a password**, whatever its mailbox
  state (`server.js:2736`). So "imported username-only **with** password → bind, not contact_admin"
  needs **no discovery change**; it falls out of placing the gate after password proof.
- **`pendingLoginSecurityState` includes `user.email` but not `email_verified`** (`server.js:1205`).
  A gate that marks verified inside the challenge does not invalidate its own challenge; a gate that
  **writes a new email** does — ordering is therefore load-bearing (§6).

---

## 4. Ordering (target)

```
POST /oauth2/authorize
  └─ discovery (optional)              → password | set_password | contact_admin
  └─ CAPTCHA (if required)             → 400 captcha.required   (no attempt consumed)
  └─ password check                    → 401 / 429              (attempt consumed here)
  └─ TOTP if enabled                    → factor 'totp' challenge
  └─ EMAIL GATE if mailbox missing or unverified
        bind   (no usable mailbox)      → collect target  → code to target  → verify
        verify (usable, unverified)     → code to stored  → verify → mark verified
  └─ login email factor if switch ON **and not already satisfied by the gate code**
  └─ completePasswordLogin + buildAuthorizationResponse
```

Rule 6 ("one code satisfies both") is only satisfiable if the gate and the login email factor use the
**same `email` + same `purpose` (`EMAIL_PURPOSE_LOGIN`)**, because `issueEmailVerificationCode`
invalidates the previous active code for the same `email+purpose` pair (`server.js:1755`) and
`verifyEmailCode` consumes the record (`server.js:1819`). A separate gate purpose would force a
second send — so the gate code **is** the login code.

---

## 5. Minimal design options

### Option A — login-page gate form, reuse the pending challenge as the proof carrier *(recommended)*
- First POST: password (and TOTP) verified → server returns
  `{ next: 'bind_email' }` or `{ next: 'verify_email', email_masked }` with **no session/code/token**,
  and a short-lived signed `login_step` proof (`kind:'email_gate'`, `userId`, `ip`, `gate`, `expiresAt`)
  reusing `grantCaptchaContinuation`/`hasCaptchaContinuation` (`server.js:383-391`).
- Second POST (same `#loginForm`, hidden OAuth fields already present, `views/auth/login.html:49-57`):
  `bind_email` (bind case only) → server validates/unique-checks it, issues the code to that address
  and creates the pending challenge (factor `email_bind`); or `send=1` (verify case) → issues the code
  to the stored address and creates factor `email_verify`.
- The proof cookie means the gate POST **does not re-consume** a password attempt and the password
  need not be resent — matching the existing CAPTCHA grace design (`server.js:2813-2814`).
- Code entry + completion on the **existing `/oauth2/mfa`** page via
  `POST /api/v1/auth/oauth/oidc/complete` (factor `email_bind`/`email_verify` added to the
  `server.js:2642-2646` chain). Completion marks verified (and writes the bound address for `bind`)
  inside `finishAccountLogin`, then `completePasswordLogin` + `buildAuthorizationResponse`.
- Proxy: tiny server diff (two factor strings + one branch), no new page, reuses expiry/attempts/
  security-state/single-consumption/OAuth continuation verbatim. Con: a third UI state.

### Option B — MFA-page-only gate
- Add an email input + "send to this address" step to `views/auth/mfa.html` + `mfa.js` and a new
  endpoint authenticated by the pending token, so the whole gate lives on `/oauth2/mfa`.
- Proxy: one page. Con: `mfa.js` currently branches `totp`/`email` only (`mfa.js:66-93`) and has no
  form beyond one code field; needs a new authed endpoint + 2 extra round trips + new pending state
  before a target exists. Highest UI churn of the three.

### Option C — stateless `next` steps, no pending challenge
- Each step returns `next`, the frontend accumulates state locally, and one final POST carries
  password + target + code.
- Proxy: no pending record. Con: **loses** the security-state HMAC, 5-minute expiry, ≤5 attempts,
  single atomic consumption and the OAuth continuation store — all of which the rules require
  ("no session/code/token until all required steps", "retain challenge locks/races/OAuth/state/PKCE").
  Requires re-authorizing from scratch at completion. Not recommended.

**Recommendation: Option A**, with the gate's pending factor reusing the existing machinery, and the
new target collected on the login page (bind case) before the challenge is created — which keeps
`beginOidcSecondFactor`'s "code issued at challenge creation" shape intact.

---

## 6. Backend contract touchpoints (for the coordinator to freeze; not implemented here)

1. **Probe/hint surface.** Decide whether the gate is advertised to native clients:
   - `check_verification` (`server.js:2779-2806`) already returns `factor`. Adding
     `email_bind_required` / `email_verification_required` is the only way an App can pre-collect it.
   - Older App builds that ignore the new fields would pass password+TOTP and then be stopped by the
     gate with no UI → effectively locked out until web login. **Coordinator decision required**:
     advertise the gate in the probe, or scope the gate to `captcha_surface=web`, or ship a version
     gate.
2. **Pending factor values.** Add `email_bind` and `email_verify` to the `server.js:2642-2646` chain;
   keep `require_totp`/`require_email_code` semantics for the existing two.
3. **Reusing `EMAIL_PURPOSE_LOGIN`** for the gate code so rule 6 holds. `beginOidcSecondFactor`
   currently auto-issues only for `factor === 'email'` (`server.js:1215`); the gate factors must also
   issue, to the **resolved target** (stored address for `verify`, chosen address for `bind`). The
   cleanest shape is an `emailTarget` argument threaded into `beginOidcSecondFactor`.
4. **TOTP chaining.** TOTP completion today ends in a session for `source==='password'`. With the gate,
   TOTP success must transition to the gate instead of completing. Minimal shape: put
   `gateAfter: 'bind'|'verify'` into the TOTP pending `extraContext` and, in
   `oidc/complete`, create the gate challenge instead of calling `completePasswordLogin`. Keep the
   5-minute/5-attempt/security-state guarantees across the chain.
5. **Atomic write.**
   - `verify`: `UPDATE users SET email_verified = 1 WHERE id = ? AND email = ?` (stored address), require
     affected-row success, mirroring `setInitialPassword` (`models/User.js:262-270`).
   - `bind`: a new conditional method, e.g. `bindVerifiedEmail(id, newEmail, expectedEmpty=true)` with
     `WHERE id = ? AND (email IS NULL OR email = '' OR email LIKE '%@users.invalid')` so a concurrent
     real-mailbox write cannot be overwritten; plus a uniqueness check via
     `findPotentialConflicts`/`findByEmail` returning a conflict error.
6. **Ordering inside completion.** `oidc/complete` currently re-validates the pending **after**
   verifying the code (`server.js:2647`). For `bind`, the email write changes
   `pendingLoginSecurityState` (it binds `user.email`), so the write must happen **inside**
   `finishAccountLogin`'s callback (after the state comparison at `server.js:1299-1301`) and **after**
   any further `getPendingOidcLogin` call. No second `getPendingOidcLogin` after the write.
7. **Clearing the proof.** `completePasswordLogin` clears `login_step` (`server.js:1285`); the gate
   proof must survive until that point, then be consumed/cleared.
8. **Skip the login email factor when the gate already verified it.** Add a `gateSatisfiedEmail`-style
   flag (pending context) so `server.js:2869` does not send/verify a second code when the switch is ON.
9. **Synthetic-mailbox bug.** `server.js:2869` lacks the `!isSyntheticEmail(user.email)` guard that
   `server.js:2132`, `2386` and `2803` all have. The gate removes the practical impact for password
   accounts, but the guard should still be added for the non-gate path (e.g. `email_verified` true on a
   synthetic address is impossible, so the gate always applies — confirm).

---

## 7. Proposed UI + selectors *(provisional — coordinator must freeze; none exist today)*

Recommended Option A surface. Reuse the `#passwordSetupForm` pattern (own form, own hidden OAuth
fields, own masked hint + manual send + inline status) so `#loginForm` and the account-first
`STEP_FIELDS` contract stay untouched.

Login page (`views/auth/login.html`), new sibling form after `#passwordSetupForm`:

| Selector | Role |
| --- | --- |
| `#emailGateForm` | the gate form (hidden until the gate step) |
| `#emailGateTitle` | step title (`绑定邮箱` / `验证邮箱`) |
| `#emailGateHint` | copy that distinguishes bind vs verify |
| `#bindEmailInput` (`name="bind_email"`) | bind case only: new address |
| `#emailGateMasked` | verify case only: `maskEmail(stored)` text |
| `#sendEmailGateCodeBtn` | manual send (verify: stored; bind: typed address) |
| `#emailGateCode` (`name="email_code"`, `inputmode=numeric`, `maxlength=6`) | code entry |
| `#emailGateSubmit` | submit |
| hidden `nonce/response_type/client_id/redirect_uri/scope/state/code_challenge/code_challenge_method` | OAuth continuation, copied per `views/auth/login.html:143-151` |

`login.js`: extend `setLoginStep` with `email_gate` (and its `STEP_FIELDS` entry), plus the same
`modeRevision` / `invalidateAuthAction` / single-action guard already used for `setup`/`contact`.

Reused, unchanged: `#statusMessage` (via `setStatus`/`anchorStatus`), `#loginUsername`,
`#loginPassword`, `#loginForm .submit`, `#changeLoginAccountBtn`, `#passwordSetupForm`,
`#sendSetupCodeBtn`, `#setupEmailMasked`, and the whole `/oauth2/mfa` page (`#code`, `#submit`,
`#status`, `#codeLabel`, `#instructions`).

Alternatively, if the coordinator prefers a single surface, the MFA page can carry the bind input as
`#bindEmailInput` next to `#code`. **Do not finalize selectors in the test before they are frozen.**

---

## 8. Browser acceptance cases (real login UI, both viewports 1440 / 390)

| # | Case | Seed | Expected UI + assertions |
| --- | --- | --- | --- |
| G1 | **Imported username-only WITH password → bind, not contact_admin** | `f.User.create({username, email:'', password, emailVerified:false})` or import a row with a real password and no email, then log in as that user | account step → Continue → password step → submit → **`#emailGateForm` visible**, `#bindEmailInput` editable, `#loginContactAdmin` **hidden**, no session cookie, `/api/profile` 401, no `oauth2/mfa` navigation |
| G2 | bind targets a NEW unique mailbox and completes | continue G1: type address → send → `f.mails` has exactly one mail to that address → `#emailGateCode` → submit | session established, `user.email_verified === true`, `user.email === typed`, id_token `email_verified === true`, exactly **one** mail total, admin list/`serializeUser` shows the new address |
| G3 | **Unverified bound mailbox → code → verified** | `f.User.create({username, email: real, password, emailVerified:false})` | after password submit → verify step with masked stored address; code from `f.lastCode(real)` → submit → session, `email_verified === true`, mailbox unchanged, **one** mail |
| G4 | **TOTP then email gate** | G3 seed + `f.User.update(id,{totpEnabled:true,totpSecret})` | password → TOTP challenge (`/oauth2/mfa`, `#code` name `totp_code`) → correct TOTP → gate appears → code → session; assert no session after TOTP alone, and no second code/e-mail for the gate beyond the one sent |
| G5 | **Valid OAuth PKCE continuation through both steps** | G3 seed + `f.client()` + full authorize URL with `state`/`nonce`/S256 PKCE | gate completes → returns to the client callback → `state` matches, `f.exchange(client,{code,verifier})` 200, id_token `nonce` matches, `email_verified` true |
| G6 | **Old first-password flow unchanged** | `f.User.create({password:'', email: real, emailVerified:true})` | discovery `set_password`, masked email, `#passwordSetupForm`, manual send, save password → **not logged in** → then normal password login |
| G7 | **No-password + no mailbox unchanged** | `f.User.create({password:'', email:''})` (or synthetic) | `#loginContactAdmin` message, `#sendSetupCodeBtn` absent, zero mail, zero session |
| G8 | **Verified mailbox unchanged** | `f.user()` (verified) | password → session directly (**no** gate) |
| G9 | **Verified mailbox + switch ON unchanged** | G8 + `pool.settings` `login_email_code=true` | password → email factor to `/oauth2/mfa`; `#code` name `email_code`; code → session; gate form never shown |
| G10 | **No premature exposure** | any gate seed | before the password POST: `#emailGateForm` hidden, `#bindEmailInput` absent/hidden, no gate mail sent, no pending cookie, no session |
| G11 | **Single code / no duplicate send** | G3 or G4 with `login_email_code=true` | exactly **one** captured mail across the whole login; the gate code also satisfies the login email factor; no second `/oauth2/mfa` hop |
| G12 | **Wrong code does not complete** | G3 | wrong code → error, still no session, `email_verified` still false; attempt counter advances; >5 → `auth.mfa.locked` |
| G13 | **Bind rejects a used / malformed address** | G1 | address already owned by another account → conflict error, no session, no mail to it; malformed → inline error, no mail |
| G14 | **Security-state race** | G3, change `user.email` or password between password step and code submit | old challenge rejected (`auth.mfa.expired`), no session, no verification flip |
| G15 | **No premature session/token** | G1–G5 | after password (and after TOTP) assert: no session cookie, `/api/profile` 401, no authorization code issued, no id_token; only after the final code |

Also worth asserting: masked-email text never reveals the full stored address
(`#emailGateMasked` only), and the synthetic `@users.invalid` address is never shown in the gate UI.

---

## 9. Test file approach

- **Recommendation: one new focused file `tests/login-email-gate-browser.cjs`**, not edits to
  `tests/account-first-login-browser.cjs`. Rationale: the gate is a new ordering contract with its own
  seeds (unverified/no-mailbox password accounts) and its own failure modes; keeping it separate avoids
  re-splitting a 700-line file and keeps the prior green file untouched, which matters while the main
  session owns the aggregate `check:browser` run.
- Reuse the established conventions verbatim: `createFixture()`, `f.User.create` for the odd account
  shapes, `f.pool.settings.push({setting_key:'login_email_code',setting_value:'true'})`,
  `f.lastCode(email)`/`f.mails`, `totpCode(secret, offset)` from `tests/support/totp-code`,
  the `continueToPassword(page)` helper shape from `tests/account-first-login-browser.cjs:36-45`,
  and the desktop-1440 / mobile-390 loop used by the other browser tests.
- Assert, don't screenshot-only: session cookies via `f.pool.sessions`, `/api/profile` status,
  `email_verified` read back from `f.pool`, `f.mails.length` exact counts, `f.exchange` result and
  decoded `nonce`/`email_verified` claims, plus no-horizontal-overflow checks before each screenshot.
- Screenshots to a fixed gitignored path `.artifacts/login-email-gate/` (not the task research dir,
  which moves on archive).
- Every selector in §7 is provisional: do not write test code against them before the coordinator
  freezes the contract.

---

## 10. Risks and open decisions

1. **Rollout blast radius (highest).** With the switch default off (`server.js:261`), the gate turns
   today's "unverified mailbox → password-only session" into a mandatory verification for **every**
   existing unverified account, including admin-created and imported `ischeck`-false accounts.
   Decision needed: unconditional, or behind a new setting (e.g. `login_require_email_verified`).
2. **Native App compatibility.** `check_verification` clients collect factors then submit once; an
   unknown gate means no UI (§6.1). Decision: advertise in the probe and/or scope to web.
3. **TOTP chaining is the most invasive branch.** Wiring `gateAfter` through the TOTP completion must
   not regress the existing `/oauth2/mfa` TOTP path, recovery codes, replay protection or the
   2048-char PKCE state continuation asserted today.
4. **`pendingLoginSecurityState` binds `user.email`.** The `bind` write must stay inside
   `finishAccountLogin` after the state comparison, and no `getPendingOidcLogin` may run afterwards
   (§6.6). Getting this wrong makes every bind fail with `auth.mfa.expired`.
5. **`email_verified` is not in the HMAC.** A verified/unverified flip elsewhere does not invalidate a
   pending challenge. Acceptable, but note it: the gate's own write is what must be conditional.
6. **Password-attempt re-consumption.** If the gate re-POSTs the password without the `login_step`
   proof, `RateLimit.consume` (`server.js:2829`) burns an attempt per step and can lock the user out
   mid-gate. The grace-cookie pattern in §5-A exists precisely to avoid this.
7. **Cooldown UX.** `issueEmailVerificationCode` enforces a 60s per `email+purpose` cooldown
   (`server.js:1750`); the gate's resend must surface it (the setup form already has
   `renderSetupCooldown`) rather than 429-ing unexpectedly.
8. **Bind uniqueness race.** Two accounts binding the same address concurrently must not both succeed;
   needs the conditional update + conflict error (§6.5). Empty-string emails are ambiguous under
   `findByUsername`'s `OR email = ?` (`models/User.js:100`), so never persist `''`.
9. **Synthetic-email accounts with `login_email_code` ON** currently attempt a real send to
   `@users.invalid` (`server.js:2869`, missing guard). The gate removes it for password logins, but
   the guard should be added regardless.
10. **Externally created accounts** (OIDC/Huawei) get synthetic mailboxes and log in through the
    external path (`server.js:2129-2134`, `2384-2387`); the rule is stated for password logins, so
    those paths must stay unchanged. A later password set on such an account would then be gated.
11. **`email_verified` in the OAuth response.** `buildAuthorizationResponse` must receive the re-read
    `current` (post-write) user, not the stale snapshot, or id_token `email_verified` would be false.
12. **Registration is unaffected** (it requires a code and creates `emailVerified: true`,
    `server.js:3126-3147`), so the gate has no effect there — worth an explicit assertion so it never
    regresses.

---

## 11. Browser suite status

- No `check:browser` / Playwright runner is currently executing (inspected live `node.exe` command
  lines; only agent runtimes are present). Nothing was interrupted by this turn.
- Last known state, unchanged by this turn:
  - previously reported full aggregate green (238/238 API + all browser files) **before** the
    missing-email work;
  - the later additions were each verified individually and are green:
    `account-first-login-browser.cjs`, the six adapted files (`browser-smoke`, `password-mfa`,
    `multi-authenticator`, `auth-feedback`, `account-bindings`, `turnstile`) and
    `user-import-upload-browser.cjs` (desktop 1440 + mobile 390; mixed 15→8 created / 7 skipped,
    2501-row bulk 2498 created incl. 25 unbound, re-import 2501 skipped).
- The aggregate run remains owned by the main session; p6 ran no suite this turn.

---

## 12. Preserved (not touched this turn)

Account-first two-step login and its 14 scenarios; import transport / 10 MiB byte bound /
no record cap / optional-mail / grouped results with `reason_code` + `importedWithoutEmail`;
all six adapted legacy browser tests; existing MFA, OAuth state/nonce/PKCE, Huawei/OIDC pending
flows, native `check_verification`, security-state invalidation, first-password setup and
`contact_admin`. No commit, stage, revert or branch operation was performed.