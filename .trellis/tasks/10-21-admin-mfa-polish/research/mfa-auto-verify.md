# R3/R4 research — compact MFA entry and auto-verify

Scope: parent `10-21-admin-mfa-polish` (R3, R4) and child `10-21-mfa-compact-auto-verify`.
Planning/research only. No product code, spec, task, or test files were modified while producing this.

## 1. Current implementation — event and submit state trace

File: `public/js/pages/auth/mfa.js` (188 lines), page `views/auth/mfa.html`.

| Line | Anchor | Role |
| --- | --- | --- |
| 36-48 | `function syncMfaInput()` | Normalizes `#code` to `\D`-stripped, `slice(0, 6)`, then `renderMfaSlots()`. Skips normalization entirely when `mfaRecoveryMode`. |
| 25-34 | `renderMfaSlots()` | Mirrors value into the 6 decorative `[data-code-slot]`; toggles `.is-active` only when focused and editable. |
| 50-71 | `renderMfaChallenge()` | Sets label, placeholder, `name` (`verificationcode` → `totp_code`/`email_code`/`recovery_code`), `inputMode`, `autocomplete`, `maxLength` (6 or 32), recovery toggle, then `renderMfaSlots()`. Does **not** clear the value (language preservation). |
| 73 | `setMfaSubmitting(bool)` | `mfaSubmitting`, `aria-busy` on form, `mfaCode.readOnly`, `mfaSubmit.disabled`, `mfaRecoveryToggle.disabled`. |
| 81 | `rejectMfaSubmission()` | If `!mfaCode.disabled`: clears value + refocuses. Then `renderMfaSlots()` + `showMfaError()`. |
| 110 | `mfaForm` submit handler | Sync guard `if (mfaSubmitting || mfaCode.disabled) return;` then `setMfaSubmitting(true)` **before** any await. |
| 123 | terminal branch | `401`/`429` → `mfaCode.disabled = true`. |
| 132 | success | origin-checked `window.location.assign(target)`, `mfaNavigating = true`. |
| 142-143 | `input` + `change` → `syncMfaInput` | The only two value-change entry points. Both are already required by the existing contract. |
| 149 | `click` slot-position handler | Guards on `mfaRecoveryMode \|\| mfaCode.disabled \|\| mfaCode.readOnly \|\| selection not collapsed`. |
| 157 | `#recoveryToggle` | Toggles `mfaRecoveryMode`, clears value + status + `mfaFeedback`, `renderMfaChallenge()`, focus. |
| 168 | `vaultsso:languagechange` | `renderMfaChallenge()` + re-resolves stored `mfaFeedback`. No value mutation, no events dispatched. |

Consequence: there is currently **no** auto-submit path, and the guards that a new trigger must respect already exist (`mfaSubmitting`, `mfaCode.disabled`, `mfaCode.readOnly`, `mfaRecoveryMode`, `mfaNavigating`).

## 2. API contract the trigger must fit (`server.js`)

- `POST /api/v1/auth/oauth/oidc/complete`, body `{ code }` (spec `auth-feedback.md:20`).
- `server.js:2619-2620` — no pending challenge → `401` + `error_key: auth.mfa.expired` (terminal).
- `server.js:2622-2624` — `incrementAttempts(record.id, 5)` runs **before** validation; failure → `429` + `auth.mfa.locked` (terminal).
- `server.js:2632-2634` — invalid/expired/already-consumed code → `400` + `auth.mfa.invalid` (retryable).
- Success → `200 { redirect }`, same-origin continuation validated client-side (`mfa.js:127-131`).
- `models/EmailVerificationCode.js` `incrementAttempts`: `attempts < 5` SQL guard, so a challenge tolerates **5 POSTs total**, the 6th is `429`. Verified by `tests/password-mfa.test.js:86-87` (5 × `400`, then `429`).

Design consequence (must be stated in the design): an automatic attempt is a real attempt. Auto-verify therefore cannot exceed the current manual budget, but it can *spend* attempts without an explicit user gesture — e.g. a stale autofilled email code fires one wasted attempt. Accepted risk, bounded by 5; do not change the backend.

## 3. Recommended completion-trigger flow (minimal, single code path)

Keep one fetch path: the automatic trigger must call `mfaForm.requestSubmit()` so the existing handler owns locking, feedback, 401/429 handling, and origin validation (child PRD: "Reuse the existing submit/error/navigation flow").

New state (module scope, next to `mfaSubmitting` at `mfa.js:13-17`):

```js
let mfaLastAutoValue = null;   // value of the last automatic attempt
let mfaComposing = false;      // IME composition in progress
```

Trigger predicate — call once at the end of `syncMfaInput()` (lines 36-48, after `renderMfaSlots()` at line 47):

```js
function maybeAutoVerify() {
  if (mfaRecoveryMode) return;                       // R4: recovery is manual only
  if (mfaComposing) return;                          // skip IME intermediate states
  if (mfaSubmitting || mfaNavigating) return;        // pending request blocks duplicates
  if (mfaCode.disabled || mfaCode.readOnly) return;  // terminal error / in-flight
  const value = mfaCode.value;
  if (!/^\d{6}$/.test(value)) return;                // incomplete input never submits
  if (value === mfaLastAutoValue) return;            // paired input+change fires once
  mfaLastAutoValue = value;
  mfaForm.requestSubmit();
}
```

Reset `mfaLastAutoValue = null` in exactly three places:

1. `rejectMfaSubmission()` (line 81) — after a failure the input is cleared, so a re-typed identical code is a *new* edit and must attempt again (R4 "correction/retry", including the same six digits).
2. `#recoveryToggle` handler (line 157) — mode change never verifies and must not suppress the next TOTP attempt.
3. `loadMfaChallenge()` success path (lines 100-104) — fresh challenge.

Why this shape:

- **Typing**: `input` fires per keystroke; only the transition to a 6-digit normalized value satisfies `/^\d{6}$/`. Digits 1-5 are no-ops. No debounce timer, so behaviour is deterministic under test.
- **Paste**: `paste` produces one `input` with the full string → one attempt.
- **Autofill (password manager / extension)**: managers set `.value` then dispatch `input` and/or `change`. Both are already bound to `syncMfaInput`, so the first event fires and `mfaLastAutoValue` makes the second a no-op — this is the "exactly one attempt per completed edit" guarantee at `AC3`.
- **Replace-paste over an existing 6-digit value**: value comparison (not a length transition) still fires, because the previous attempt always cleared the value (`rejectMfaSubmission`) and reset `mfaLastAutoValue`.
- **Pending duplicates**: `setMfaSubmitting(true)` runs synchronously at `mfa.js:113`, so an `input`/`change`/click arriving after the submit event sees `mfaSubmitting === true` and returns. No microtask or timer is needed; prefer no `setTimeout` to keep tests deterministic.
- **Normalization**: the predicate uses the post-normalization value (`syncMfaInput` rewrites `mfaCode.value` first), so `12 34 56` / `123-456` attempt only once and only with `123456`, matching the body already sent (`mfaCode.value.trim()` at `mfa.js:119`).
- **IME**: `syncMfaInput` rewrites `.value` during composition, which is a pre-existing hazard that auto-verify would amplify (a transient composed value could normalize to 6 digits). Add `compositionstart` → `mfaComposing = true` and `compositionend` → `mfaComposing = false; syncMfaInput();` so the predicate re-runs once with the committed value. This is the *only* new listener pair; all others stay.
- **Recovery mode**: `mfaRecoveryMode` guard plus `maxLength: 32` means recovery codes are never auto-submitted even if one is 6 characters long.
- **Language change**: `renderMfaChallenge()` (line 50) never dispatches `input`/`change`, so a language switch with 6 digits already present cannot re-fire; `mfaLastAutoValue` additionally blocks a later `blur`-driven `change`.
- **Terminal 401/429**: `mfaCode.disabled = true` at line 123 before `rejectMfaSubmission`, so every later event is blocked and the input keeps its disabled state; `setMfaSubmitting(false)` in `finally` keeps `#submit` and `#recoveryToggle` disabled because they read `mfaCode.disabled`.
- **Non-terminal 400**: input cleared + focused + localized `auth.mfa.invalid` (all three locales exist: `i18n.js:434/923/1054`); correction and retry work, one attempt consumed each.
- **Manual submission**: unchanged — the button and Enter still submit through the same handler.
- **Navigation**: unchanged; `window.location.assign` only on `200` with a same-origin `redirect`.

Optional (not required by R3/R4): set `mfaSubmit` text to a verifying label during auto submission. Skip unless R2 asks; `aria-busy` already conveys state to assistive tech.

Do **not** auto-submit by watching `#code` with `MutationObserver` or polling, and do not add a `keydown`-length heuristic — `input`/`change` already cover typing, paste, and autofill across Chrome/Firefox/Safari.

## 4. Asset/version bookkeeping

`views/auth/mfa.html` pins `mfa.js?v=20261001-mfa-2` and `vaultsso-mfa.css?v=20260930-mfa-1`. A cached old `mfa.js` is harmless (no auto-verify), but the repo convention (see the just-shipped OAuth login cleanup, `views/auth/login.html`) is to bump both when either changes. Bump the script tag at minimum.

## 5. Spec lines that must change (`.trellis/spec/frontend/auth-feedback.md`)

| Line | Current text | Required change |
| --- | --- | --- |
| 19 | "…Preserve native selection, keyboard editing, and paste; **filling a code never submits automatically**." | Replace the last clause with the auto-verify contract: a complete six-digit code supplied by typing, paste, or autofill triggers **exactly one** automatic submission per completed edit; incomplete input never submits; recovery mode, mode changes, and language changes never trigger submission. Keep the decimals about slots, `input`/`change` mirroring, and native editing. |
| 22 | "MFA submission makes the input read-only and disables verify/mode switching…" | Extend with: an automatic attempt is an ordinary submission — it must be blocked while one is pending (`mfaSubmitting`/`readOnly`/`disabled`), must not fire in recovery mode, and must not fire on language or mode changes. |
| 21 | recovery toggle paragraph | Add: changing entry mode clears the value and cancels automatic verification, so no attempt is spent on a mode switch. |
| 45 | test list for `tests/password-mfa-browser.cjs` | Update the listed coverage: automatic completion from typing/paste/autofill, single-attempt locking on paired `input`+`change`, failed-code retry, recovery-mode manual submission. Remove/replace the implicit "filling must not sign in" expectation. |
| 19-22 | (context) | `section 4` error matrix is unaffected; `section 6` `security.test.js` expectations unchanged. |

Nothing in `.trellis/spec/frontend/index.md` needs to change (the guide is already marked `Defined`).

## 6. Existing tests that must change

### `tests/password-mfa-browser.cjs` (the main contract-holding suite)

| Lines | Current behaviour | Why it breaks / what to change |
| --- | --- | --- |
| 92-93 | `fill(incorrectEmailCode)` then `click('#submit')` | The fill alone now submits. Drop the click (or assert the button is disabled/pending); keep the `验证码不正确` assertion at 95. This becomes the *failed auto attempt* case. |
| 98-102 | Clipboard paste `Control+V`, then `click('#submit')` | Paste now auto-submits. Assert the value after paste, then drop the click and let `waitForURL('**/profile')` cover success. |
| 125-126, 144-145 | `fill(code)` + `click('#submit')` | Auto-submits on fill; the click races navigation. Remove the click. |
| 167-173 | `pressSequentially('123456')` then `Backspace`/`ArrowLeft`/`Backspace`, expect `1235`; then `fill('123456')` | Typing the 6th digit auto-submits an invalid code, clears and refocuses the input, so the native-editing assertions collapse *and* one attempt is burned. Restructure: do the whole editing sequence with **five** digits (e.g. `12345` → edits → `1235`), assert slots, and only then complete the code. |
| 173-177 | `fill('123456')`, click 3rd slot, type `9`, expect `129456` | Requires a complete code without submitting. Move the slot-position test to a 5-digit value, or perform it after resetting the input. |
| 195-204 | Extension-style `input`/`change` write of a valid `totpCode`, then assert `api/profile` is **401** with the message "Filling a code must not automatically sign in" | This is the inverted contract. Replace with: the auto attempt happens once, `waitForURL('**/profile')` succeeds. Assert single-attempt separately (§7). |
| 205 | `click('#submit')` after the fill | Remove (already navigated). |
| 233-245 | recovery `incorrect-recovery` fill, toggle back, `fill('123456')` + `click('#submit')` for terminal expiry | Recovery fill must **not** auto-submit (guard: `mfaRecoveryMode`); keep manual `#submit`. For the terminal-expiry step the `fill('123456')` now auto-submits, so the click is redundant and must go; keep the `isDisabled()` assertions at 243-245. Note `'123456'` there is an invalid TOTP and consumes the last attempts anyway. |
| 218-224 | recovery code fill + `click('#submit')` | Keep as-is: this is the R4 "recovery codes remain manual" assertion. |

Also update the summary string at line 249 (it lists "TOTP autofill/editing").

### `tests/multi-authenticator-browser.cjs`

| Lines | Change |
| --- | --- |
| 40-43 (`loginWith`) | `fill(code)` then `click('#submit')`: drop the click, keep `waitForURL('**/profile')`. All four `loginWith(...)` calls (TOTP `-1`, live TOTP, recovery codes 2-3) inherit the fix. Recovery-code calls must keep the manual click — so `loginWith` needs a `manual` flag or two variants. |

### Unchanged

- `tests/password-mfa.test.js` — exercises the HTTP contract (`complete()` helper at 14-16, attempts budget at 86-87, recovery replay at 73-74). Auto-verify adds no server behaviour; the 5-attempt budget at `server.js:2622` stays the ceiling.
- `tests/security.test.js` — backend/API only (PKCE, nonce, replay, throttling). No UI coupling.
- `tests/auth-feedback-browser.cjs`, `tests/browser-smoke.cjs`, `tests/turnstile-browser.cjs` — verified: no `#code` / `/oauth2/mfa` interaction.
- `tests/i18n.test.js` — keys only; `auth.mfa.*` strings are untouched.

## 7. Smallest meaningful new tests

All in `tests/password-mfa-browser.cjs` (the suite that already owns this contract). No new file, no new fixture API.

1. **Single attempt on paired events (locking).** Install `await page.route('**/api/v1/auth/oauth/oidc/complete', ...)` that counts and delays (~300 ms) then continues. Dispatch `input` and `change` in one `page.evaluate` with a valid email code, then click `#submit` immediately. Assert: intercepted request count is exactly 1, `#submit` was disabled while pending, and the page still reaches `**/profile`. This is the only way to prove AC3 "pending requests cannot duplicate" deterministically — the fixture's `emailVerificationCodes[0].attempts` counter is a valid server-side cross-check (expect exactly 1 increment).
2. **Incomplete input never submits.** Route-intercept, type 5 digits + `Tab` (fires `change`), assert 0 intercepted requests and `#status` empty.
3. **Failed auto attempt then corrected retry.** Wrong 6-digit code typed (auto-submits) → assert localized `验证码不正确…`, input cleared, `api/profile` 401, no navigation; then type the correct code (auto-submits) → `waitForURL('**/profile')`. Also assert `attempts === 2` server-side.
4. **Recovery mode never auto-submits.** Toggle to recovery, `fill(recovery)` (16 chars), assert 0 intercepted requests, then manual `#submit` → success. Cheap extension of the existing 218-224 block.

Optional, only if cheap: a 6-character *recovery* value on a TOTP challenge to prove the `mfaRecoveryMode` guard, and re-sending the identical TOTP code after a network-level failure (`page.route` abort once) to prove same-code retry is allowed.

## 8. Risks to record in the design

1. **Attempt amplification** — each auto attempt spends one of the 5 server attempts; a stale autofilled email code costs one. Bounded, no backend change. Do not add a "skip if it failed before" rule: it would break retry of a legitimately repeated code.
2. **`readOnly` during submit** — `setMfaSubmitting(true)` sets `readOnly`; a password manager writing `.value` during the pending window still mutates the DOM (programmatic writes ignore `readOnly`). The predicate blocks the re-trigger, but the value the user sees can drift from the value being verified. Acceptable; `rejectMfaSubmission` clears on failure.
3. **IME composition** — pre-existing normalization-during-composition hazard; the added `compositionstart`/`compositionend` guards are the minimal fix and must not alter the existing "fill never submits during composition" expectation.
4. **`requestSubmit()` vs `#submit.click()`** — call `mfaForm.requestSubmit()` with no submitter argument; passing a submit button is unnecessary and `#submit` is `disabled` at times. The form's `required` input is satisfied by the 6-digit value, so constraint validation passes.
5. **Test flakiness** — no timers in production code keeps `waitForURL` semantics identical to today; the only timing-sensitive assertion is the route-interception count in §7(1), which is why the route handler must delay explicitly rather than rely on natural latency.
6. **`renderMfaChallenge()` is called at module load (line 187)** before `loadMfaChallenge()`; `maybeAutoVerify` must be defined before the first `syncMfaInput` call (it is, if declared as a function alongside the others), and must tolerate `mfaChallenge === null`.

## 9. Reconciliation with `design.md` / `implement.md`

`design.md` (written concurrently by the parent owner) already states the same guard set: "Incomplete, recovery, composing, disabled, read-only, initializing, or already-pending states do not auto-submit. Repeated notifications of an unchanged complete value must not create duplicate attempts; a fresh edit after failure can attempt again." That is exactly the §3 predicate plus the reset rule in §3 (points 1-3). No conflict — this file supplies the concrete anchors:

- `initializing` is **not** a separate flag in current code; it is `mfaCode.disabled === true` between page load and `loadMfaChallenge()` setting it false (`mfa.js:102`). The existing `mfaCode.disabled` guard therefore already covers it; do not add a fourth state variable.
- "Mode/language rendering alone cannot submit" is satisfied structurally: `renderMfaChallenge()` (`mfa.js:50-71`) and the `languagechange` handler (`mfa.js:168-171`) dispatch no `input`/`change`.
- `implement.md` step 5 assigns `public/js/pages/auth/mfa.js` and the affected MFA browser tests to one owner, and step 4 gives `views/auth/mfa.html` cache versions to the presentation owner. That split is correct for §4: the script-tag bump belongs with the presentation owner, so the behavior implementer must **request** the `mfa.js?v=` bump rather than edit `mfa.html`.
- `implement.md` validation list already names duplicate events, same-code re-entry, request locking, mode/language changes, and terminal errors — §7 items 1-4 give those the minimal concrete assertions.

Two small gaps not yet specified anywhere; recommend deciding them during final review rather than leaving them implicit:

1. **`#submit` affordance during an automatic attempt.** No verifying label exists (`auth.mfa.submit` is static, and `mfa.js` never rewrites the button text, unlike the login page's `loadingKey`). `aria-busy` on the form is the only signal. Either accept that (recommended, zero risk) or add a localized "verifying" string in all three locales, which would also require `i18n.test.js` coverage.
2. **`tests/password-mfa-browser.cjs:204` message string** is the only in-repo artifact that names the old contract in prose; whichever task updates it must also update spec line 19 in the same change, or `npm run check:browser` will pass while the written contract lies.
