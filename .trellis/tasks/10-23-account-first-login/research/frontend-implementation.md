# Frontend Implementation Report — Account-First Login

Owner: auth-frontend (Pi `w1Q:p5`). Read-only sources: `prd.md`, `design.md`, `implement.md`,
`research/findings.md`, `research/implementation-contract.md`, `research/baseline.json`, and the
`.trellis/spec/frontend/*` guidelines. No commit, no reset/revert/stash of other workers' files.

## Files Changed (only owned scope)

| File | Change |
| --- | --- |
| `views/auth/login.html` | Account/password step markup inside `#loginForm`; sibling `#passwordSetupForm`; `#loginContactAdmin` panel; `#changeLoginAccountBtn`; asset query versions. |
| `public/js/pages/auth/login.js` | Step state machine, discovery, setup/send/reset, concurrency lock, step-aware feedback anchoring and CAPTCHA lifecycle. |
| `public/js/shared/i18n.js` | New keys in `zh`, `en`, and `zh-TW` override table. |

`public/css/vaultsso-authorize.css` was **not** changed: the existing `.auth-card [hidden]
{ display: none !important }` and `.text-action-button` / secondary-submit styles already cover the
new markup, so no CSS was required.

## Frozen Contract Compliance

- Kept `#loginUsername`, `#loginPassword`, `#loginForm .submit` and every existing OAuth hidden input.
- `#loginForm .submit` (`#loginPrimarySubmit`) is one persistent button: **Continue** on the account
  step, **Sign in** on the password step.
- Added `#passwordSetupForm`, `#setupEmailCode`, `#setupPassword`, `#setupConfirmPassword`,
  `#sendSetupCodeBtn`, `#setupEmailMasked`, `#loginContactAdmin` (inside the login card, not a new
  `data-card`), `#changeLoginAccountBtn`.
- Discovery: `POST /oauth2/authorize` JSON `{ discover_account: true, username, ...applicable OAuth }`;
  kept only originally present OAuth keys, PKCE included only when `code_challenge` was present.
  Branches on `next ∈ { password, set_password, contact_admin }`.
- Setup send: `POST /api/email-verification/send` `{ username, purpose: 'password_reset' }`.
- Setup submit: `POST /api/password-reset` `{ username, email_code, password, confirm_password }`.
- Handled `auth.password.setup_changed` (409 → rediscover), `auth.password.contact_admin` (→ contact
  step), and non-OK responses via localized `resolveMessage`. No discovery token, no stored email.
- Setup success returns to the password step with cleared password and visible confirmation; no login
  and no `hydrateSessionBanner()` call.

## State Machine and Selectors

`loginStep ∈ { account, password, setup, contact }`, driven by `setLoginStep()`:

- Step field groups are `[data-login-step]` with `hidden`; `STEP_FIELDS` keeps the username visible on
  both account and password steps so the password screen matches the previous layout.
- `#loginPassword` keeps `name="password"` / `autocomplete="current-password"` and is always present;
  it is `disabled` + not `required` outside the password step (disabled controls are excluded from both
  `FormData` and constraint validation), and re-enabled with `required` on the password step.
- `#showRecoveryBtn` visible only on the password step; `#changeLoginAccountBtn` visible on
  password/setup/contact; OIDC block hidden on setup/contact.
- Feedback (`#statusMessage`) is re-anchored per step: after `#loginPrimarySubmit` on account/password,
  after the setup submit on setup, after `#loginContactAdmin` on contact. Verified by
  `tests/auth-feedback-browser.cjs`, which asserts the status element's previous sibling is the visible
  submit of the active step. `setMode()` no longer assumes the first `.submit`.

## Concurrency, Feedback Ownership, and Review Fixes

Model: one shared mutex for the current account's discovery/send/setup, plus `modeRevision` for
response staleness and `feedbackRevision` for feedback ownership.

1. **P2 lock regression fixed.** A keyed "reject only the same key" design let `setup:A` supersede
   `send:A`, so the skipped `finally` left the send button permanently disabled. Replaced with a strict
   mutex: `beginAuthAction()` refuses while any action is active; `invalidateAuthAction()` on back /
   account edit / step change / mode change clears it. Cleanup is guaranteed because those reset paths
   also restore controls.
2. **`clearSetupState()` now restores the setup submit.** It stops the cooldown, resets the form and
   mask, and restores the submit label/enabled state, so a `setLoginStep`-invalidated `finally` can no
   longer leave "正在保存..." behind.
3. **`setMode('register'|'recover')` clears immediately.** It now calls `invalidateAuthAction()` and
   `clearSetupState()` (values, mask, cooldown) rather than deferring cleanup until login is re-entered.
4. **Nested rediscovery resets before it releases the mutex.** Both `send`/`setup`
   `auth.password.setup_changed` branches call `resetToAccountStep()` instead of only `endAuthAction(token)`:
   that clears the mutex, stops the cooldown, clears the stale setup code/password/mask and restores the
   setup submit label/enabled state, then rediscovers the same account (OAuth hidden inputs untouched).
   If the rediscovery itself fails or returns 403, the account step shows the error with the primary
   submit re-enabled, and a subsequent `next: set_password` starts from clean setup fields — no stuck
   disabled button and no reused old code.
5. **Account edit invalidates the in-flight action.** The username `input` handler invalidates the
   mutex as well as bumping `modeRevision` while already on the account step, so a new account is not
   blocked by the previous account's discovery; on other steps it resets to the account step and clears
   setup state.
6. **Local confirmation check precedes the HTTP lock.** A password mismatch in setup validates locally,
   refreshes `feedbackRevision` first, and never consumes the mutex or issues a request (mirrors the
   registration/recovery behavior).
7. **Busy guards.** The shared mutex is synchronous (duplicate submit is refused before any await);
   `submitAuthForm` additionally uses a synchronous `data-busy` guard per form; each `finally` only
   releases when its token is still current, never the newer request's lock.
8. **Late send cannot outrank a newer submit.** Send/setup capture `feedbackRevision` after clearing
   status; a late send success still starts the cooldown but its `setStatus` is discarded when newer
   feedback owns the region.

## CAPTCHA, OAuth, MFA Preservation

- CAPTCHA/Turnstile is only shown/rendered/refreshed on the password step; `setupCaptchaWidget()`'s
  `refresh()` and `hydrateAuthConfig()`/`reset` handlers are step-aware. One-use token reset on request
  is unchanged.
- OAuth hidden inputs are written once by `fillHiddenFields()` and survive all step changes. The old
  `auth.password.not_set` branch no longer calls `loginForm.reset()` nor switches to recovery: it
  rediscovers the account, so `client_id`/`state`/`nonce`/PKCE are never dropped (the previous
  `reset()` reverted those imperatively-set values to empty).
- MFA navigation (`mfa_url` → `/oauth2/mfa`) and final-login behavior are unchanged.

## i18n

Added to `zh`, `en`, and the `translations['zh-TW']` override table: `auth.button.continue`,
`auth.button.change_account`, `auth.button.set_password`, `auth.status.checking`,
`auth.status.saving_password`, `auth.status.password_set`, `auth.status.resend_in` (`{seconds}`),
`auth.setup.heading`, `auth.setup.email_hint`, `auth.setup.code_hint` (`{email}`),
`auth.setup.contact_admin`, `auth.password.setup_changed`, `auth.password.contact_admin`,
`auth.password.setup.invalid_identifier`. The masked address is written with `textContent` only.

## Verification Evidence

- `node --check public/js/pages/auth/login.js` → OK; `node --check public/js/shared/i18n.js` → OK.
- `npm run check:syntax` → "Syntax and browser script references checked: 99 files".
- `node --test tests/i18n.test.js` → 9/9 pass (includes the zh-TW section).
- `node tests/account-first-login-browser.cjs` → **passed** (Continue step, masked setup with manual
  send, contact-admin branch, stale discovery/send, setup→password without login, OAuth/MFA
  continuation with state/nonce/PKCE, desktop + mobile).
- `node tests/auth-feedback-browser.cjs` → passed standalone (twice); one earlier failure inside a
  back-to-back combined invocation was a transient timeout and did not reproduce.

## Handoff Notes

- Requested of p6 (test owner, not edited here): an interleaved `send`/`submit` regression that holds a
  `send` response while a `setup` submit is issued (and the reverse), asserting the confirm-mismatch
  path ignores the in-flight send and that a late send success cannot overwrite setup feedback while the
  cooldown still starts.
- Spec follow-up for the coordinator at finish: `.trellis/spec/frontend/auth-feedback.md` §3 still says
  login CAPTCHA/Turnstile "renders as soon as the form is visible"; the approved design now shows it
  only on the password step. That document is owned by the coordinator and was intentionally not edited.
- Asset versions bumped to `?v=20261024-account-first-1` for the login CSS, i18n and login JS.
- Baseline preserved: only the three owned files above are modified; backend, tests, admin/import, MFA
  and other workers' changes were not touched. No commit performed.