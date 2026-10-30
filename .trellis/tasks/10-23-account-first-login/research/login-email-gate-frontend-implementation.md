# Login email gate — frontend implementation report (p5 / auth-frontend)

Task: `.trellis/tasks/10-23-account-first-login`
Owner: Pi `w1Q:p5` (auth frontend). Status: **implementation and root integration complete.** No product or test edits are pending from p5. Root resolved the historical K1/K2 handoff below by requiring an empty restored bind input, clearing rejected retarget values, and adding SMTP/missing-version translations in all three locales. Independent frontend review F1–F4 is closed. Final JS/i18n cache version is `20261024-email-gate-3`; MFA CSS remains `20261024-email-gate-2`. Root's complete nine-group browser run passed; see `validation.md` for final aggregate evidence.

Scope implemented (exclusive ownership): `public/js/pages/auth/mfa.js`, `views/auth/mfa.html`,
`public/css/vaultsso-mfa.css`, `public/js/shared/i18n.js`, plus the `i18n.js` cache version in
`views/auth/login.html`. No backend, test, `package.json`, admin, import or login-flow product change.
All other workers' edits and prior work are preserved; nothing was staged, committed, reset or deployed.

Frozen contract source: `research/login-email-gate-contract.md`. Review checklist closed:
`research/frontend-review.md` F1–F4.

---

## 1. What shipped

### Template — `views/auth/mfa.html`

Retained every existing selector: `#mfaForm`, `#code`, `#codeEntry`, `#submit`, `#status`,
`#instructions`, `#mfaTitle`, `#recoveryToggle`, the six `[data-code-slot]` elements, `#languageMenu`,
`#backLogin`.

Added the gate cluster inside `#mfaForm`, before the code label:

| Selector | Role |
| --- | --- |
| `#emailGateControls` | container, `hidden` unless the stage is a gate |
| `#emailGateMasked` | masked persisted/sent target text (never a full address) |
| `#bindEmailLabel` | label for the new-address field, bind only |
| `#bindEmailInput` | `type=email`, `name=bind_email`, `autocomplete=email`, bind only |
| `#sendEmailGateCodeBtn` | `type=button` manual send, both gates |

The `required` attribute on `#bindEmailInput` is applied dynamically (see §3), not statically.

### Styles — `public/css/vaultsso-mfa.css`

Added into the existing component layer (no new override layer, per the file's own guidance):
`#emailGateControls`, `.mfa-gate-target`, `.mfa-gate-label`, `.mfa-gate-input`, `.mfa-gate-send`,
`#status.is-success`; plus the new controls in the `:focus-visible` and `prefers-reduced-motion` groups.
Tokens only; strong `[hidden]` rules from the component layer still win. No horizontal-overflow risk at
1440/390 (single-column, `width:100%`, `overflow-wrap:anywhere` on the masked line).

### Behaviour — `public/js/pages/auth/mfa.js`

- **Stage detection.** `mfaGateMode()` reads `email_gate` (`bind`/`verify`) with the `email_bind` /
  `email_verify` factor as fallback, so an older payload without `email_gate` still works.
- **Rendering.** `renderMfaChallenge()` sets the gate title/hint (`auth.email_gate.bind_title` /
  `verify_title`, `bind_hint` / `verify_hint`), shows/hides the mask and the bind field, and toggles
  `required`. Existing `totp` / `email` rendering is unchanged.
- **Manual send both gates.** `sendEmailGateCode()` posts
  `{ expected_mail_version, email? }` to `/api/v1/auth/oauth/oidc/email/send`; `email` is sent only for
  bind. Verify sends no address.
- **Code entry gated on a successful send.** `syncGateEnablement()` disables the code input and submit
  until `code_sent`, and keeps them locked for the whole in-flight send (a resend cannot overlap an
  in-flight completion, even when a previous code had been sent).
- **Completion.** `POST /api/v1/auth/oauth/oidc/complete` with `{ code, expected_mail_version }` for
  gates, `{ code }` otherwise. Intermediate `{ next_step: true }` is handled before any redirect.
- **Cooldown.** `retry_after` drives a resend countdown reusing `auth.status.resend_in`; the label
  refreshes on language change.
- **Reload of an already-sent bind proof (F1).** `mfaGateProofRestored` + `mfaGateRestoredVersion` record
  that the server already holds an exact code for the masked stored mailbox. In that state the bind field
  is **not** `required` (an empty field means the persisted target) and the send button is disabled
  because the full address is never returned. Any non-empty edit other than the known local target
  invalidates the local proof (`code_sent=false`, code cleared, `auth.email_gate.send_required`) and
  requires an explicit resend. Clearing the field back to empty restores the restored proof while its
  server version is unchanged.
- **Terminal 401/429 (F2).** `mfaTerminal` is set on a terminal completion failure; every later render
  pass re-derives `disabled`/`readOnly` from it, so the `finally` finalizer can no longer re-enable the
  code, submit, recovery toggle, send button or bind field. `maybeAutoVerify()` also refuses once
  terminal. Retryable invalid-code errors still clear/refocus and allow the same code again.
- **Failed next-stage refresh (F3).** `advanceMfaStage()` clears code/recovery/feedback/autosubmit/
  composition state, locks the stage (`lockMfaStage()`), then reloads. If the pending GET fails or the
  network drops, the stage stays locked and the readable error is kept; the consumed factor can never be
  submitted again. A successful reload re-activates the new stage. `loadMfaChallenge()` now returns
  success/failure so callers can distinguish.
- **Authoritative version/cooldown recovery (F4).** On a failed or unknown-outcome send the frontend
  re-reads `GET /api/v1/auth/oauth/oidc/pending` and adopts its `mail_version`, `code_sent`,
  `retry_after` and masked target, instead of assuming a reservation happened. A pre-reservation
  rejection (invalid address / cooldown) therefore keeps a previously sent exact code usable, while an
  SMTP-failure reservation (which does invalidate the old code) leaves the code entry disabled.
- **Preserved MFA behaviour.** Six-digit slots, `input`/`change` mirroring, IME composition handling,
  one-attempt auto-submit with retry after rejection, click-to-position, native editing/paste, manual
  recovery-code mode for TOTP, hidden recovery toggle off-TOTP, factor-specific `name`
  (`totp_code`/`email_code`/`recovery_code`), and language-change re-render with feedback refresh.

### i18n — `public/js/shared/i18n.js`

Added in zh, en and zh-TW (16 keys × 3 locales, verified):

`auth.email_gate.bind_title`, `verify_title`, `bind_hint`, `verify_hint`, `masked_label`, `bind_label`,
`bind_placeholder`, `send`, `sent`, `send_required`, `changed`, `unsupported`, `stale`, `invalid_email`,
`email_taken`, `cooldown`.

The last five exist because the backend emits exactly those `error_key` values
(`server.js` grep: `auth.email_gate.unsupported|stale|invalid_email|email_taken|cooldown`), which would
otherwise fall back to Chinese `error_description` under the English and Traditional Chinese locales.
`bind_hint` / `verify_hint` / `sent` are backend `message_key`s and are also translated. Existing
`validation.email.invalid` / `validation.email.taken` keys reuse the established translations.

### Cache versions

- `views/auth/mfa.html`: CSS + `i18n.js` + `mfa.js` → `?v=20261024-email-gate-2`.
- `views/auth/login.html`: shared `i18n.js` → `?v=20261024-email-gate-2` (the shared file changed; the
  login page loads it). `login.js` and `vaultsso-authorize.css` stay at `20261024-account-first-1`.
- Admin/authorize stylesheets and other workers' versions untouched.

---

## 2. Verification performed

- `node --check public/js/pages/auth/mfa.js` → OK; `node --check public/js/shared/i18n.js` → OK.
- `npm run check:syntax` → "Syntax and browser script references checked: 103 files".
- `node --test tests/i18n.test.js` → 9/9 pass.
- Gate key coverage: all 16 `auth.email_gate.*` keys present exactly 3× (one per locale).
- **Independent behavioural harness, 53/53 checks passed.** A throwaway Playwright-core (headless
  Chromium) harness, kept OUTSIDE the repo at `%TEMP%\gate-harness.cjs`, serves the real repo files from
  a local static server and stubs the pending/send/complete endpoints, then drives the real
  `views/auth/mfa.html` + `mfa.js`. It exercises the real DOM and real event handlers.
  Covered: F1 reload-restored proof (title, controls, not-required empty field, native `checkValidity`,
  masked-only target, code enabled, send disabled); F1b edit-invalidation, no completion request for the
  edited target, and proof restore on clearing; F2 terminal 401 and 429 (code disabled + read-only,
  submit/send disabled, no autosubmit re-fire); F3 failed next-stage GET keeps the old TOTP stage locked
  and unsubmittable with a readable error; F3b successful `next_step` rehydrates to the verify gate with
  code cleared; F4 cooldown failure restores the prior exact code from the pending projection and
  reflects cooldown, and SMTP-502 leaves code entry disabled with localized copy; N1 verify-stage manual
  send (payload carries `expected_mail_version`, omits `email`), localized success, 6-digit auto-submit
  completing with `expected_mail_version`; N2 fresh bind validation, masked hidden until a target is
  known, and English localization after switching language through the real menu control.
- Harness run command (for reproduction):
  `node %TEMP%\gate-harness.cjs <repo> <repo>\node_modules\playwright-core`.
- Not run by p5 (owned by p6/root): `npm run check:browser`, `tests/password-mfa-browser.cjs`,
  `tests/multi-authenticator-browser.cjs`, the new `tests/login-email-gate-browser.cjs`, and any API
  suite. No real mail was sent; no live database was used.

---

## 3. Historical integration handoff (K1/K2 resolved by root)

### K1 — Failed-retarget can leave a stale visible bind value (F1 rehydration variant)

`loadMfaChallenge()` restores an active persisted proof (`mfaGateProofRestored = true`,
`mfaGateRestoredVersion = …`, `mfaGateSentTarget = ''`) but does **not** clear
`#bindEmailInput.value`. So in the sequence *active proof for A → user types B → B's send is rejected
(invalid / taken / cooldown) → pending GET correctly restores A's proof*, the field still visibly shows
**B** while `gateInputOptional()` is true (bind + `code_sent` + no local sent target + restored proof +
version match), so the required attribute is dropped and a code for **A** can complete while B is
displayed.

Recommended minimal fix (root-owned): when restoring an active persisted proof for a bind stage, clear
`mfaBindEmailInput.value` so the masked target is the only visible destination — i.e. "restored proof
requires an empty visible bind input". Alternatively keep B visible but keep the proof disabled until an
explicit resend. p6's edited-target scenario should agree with whichever is chosen.

### K2 — SMTP failure localization / cache version

Root took ownership of "SMTP failure translations/cache version". Note that `smtp.test_failed` has **no**
translation entry in `i18n.js` today (0 occurrences); it is the fallback key p5 passes for an HTTP 502
send failure, so an unlocalized backend `error_description` (Chinese) is what renders for en / zh-TW.
Either add `smtp.test_failed` (or map the backend's `email_delivery_failed`) in all three locales, or
confirm the backend's final 502 `error_key` so p5's fallback can be aligned.

---

## 4. Contract surface p5 implemented against (for p6/root alignment)

- `GET /api/v1/auth/oauth/oidc/pending` → for gates: `factor` (`email_bind`/`email_verify`),
  `email_gate` (`bind`/`verify`), masked `email` (empty for bind before send; masked persisted target
  after send), `mail_version` (int ≥ 0), `code_sent` (bool), `retry_after` (seconds), `login_url`.
- `POST /api/v1/auth/oauth/oidc/email/send` ← `{ expected_mail_version, email? }` (email only for bind)
  → `{ sent, mail_version, email, code_sent, retry_after }`; 409 state conflict; 502 delivery failure.
- `POST /api/v1/auth/oauth/oidc/complete` ← `{ code, expected_mail_version }` for gates → final
  `{ redirect }`, or intermediate `{ next_step: true, mfa_url }` for a TOTP→gate transition; 409 state
  conflict; 401/429 terminal.
- Selectors are exactly the frozen set; no login-page gate form was created (gate lives on
  `/oauth2/mfa`). Login page keeps its `mfa_url` navigation untouched.

## 5. Files touched by p5 (final)

`views/auth/mfa.html`, `views/auth/login.html` (i18n cache version only),
`public/js/pages/auth/mfa.js`, `public/js/shared/i18n.js`, `public/css/vaultsso-mfa.css`.
