# Behavior result — MFA auto-verify (R3/R4)

Owner: `public/js/pages/auth/mfa.js`, `tests/password-mfa-browser.cjs`, `tests/multi-authenticator-browser.cjs`.

## Change boundary

- `public/js/pages/auth/mfa.js`: `maybeAutoVerify()` called from `syncMfaInput()`; new `mfaAutoAttemptValue` + `mfaComposing` state; `compositionstart`/`compositionend` listeners; `mfaAutoAttemptValue` reset in `rejectMfaSubmission()`, recovery-mode toggle, and `loadMfaChallenge()` success. No new fetch path, no polling, no debounce, no backend change.
- `tests/password-mfa-browser.cjs`: auto-verify expectations replace the manual-click expectations; new focused cases.
- `tests/multi-authenticator-browser.cjs`: `loginWith()` no longer clicks `#submit` (TOTP completes automatically; recovery still needs the manual button).
- Not touched: `views/auth/mfa.html` (p4 owns cache versions), `.trellis/spec/frontend/auth-feedback.md` (main owns).

## Failing step and cause (found during implementation)

**Symptom:** `tests/password-mfa-browser.cjs` timed out on `page.waitForURL('**/profile')` inside the newly added same-code-retry block (and intermittently in the held-request block).

**Cause:** TOTP replay protection, not an auto-verify defect. `server.js` `verifyTotpLocked()` → `Authenticator.consumeCounter()` / `User.consumeTotpCounter()` **consumes the TOTP time-step counter on success**. The new scenarios reused `totpCode('JBSWY3DPEHPK3PXP')` for a second and third successful login of the same account within the same 30 s step, so the code was correctly rejected as already used and the page never navigated. An isolated probe of the same held-request sequence with a first-use code returned `RESPONSE 200` and navigated to `/profile`, which confirmed the product path was fine.

**Fix (applied):** each independent scenario now seeds its own TOTP account with a distinct secret (`KRSXG5CTMVRXEZLU` for the locking case, `MFRGGZDFMZTWQ2LK` for the retry case) so every successful attempt uses a never-consumed step. Server replay protection and the wall clock are not touched. TOTP accounts need no extra setting to reach `/oauth2/mfa`; the email-code scenarios keep `login_email_code=true`.

**Secondary defect found while fixing:** the retry block waited on the localized `验证码不正确` status text, which is already present from the previous failure, so the wait could pass before the new request was issued. Positive assertions now wait on `page.waitForResponse()` for the completion endpoint and only then compare the request counter.

## Integration notes applied

1. Sixth-digit completion is exercised with a real keypress: the email case leaves five digits, then `pressSequentially(<last digit>)` triggers the automatic attempt.
2. IME composition case added: during `compositionstart` the raw value (`654-321`) is neither normalized nor submitted (0 requests); `compositionend` synchronizes once and produces exactly one attempt.
3. Paired autofill success dispatches `input` + `change` inside a single `page.evaluate` so successful navigation cannot race a second call.
4. Held-request locking awaits a promise resolved by the route handler itself before asserting, instead of depending on `aria-busy` or request-event delivery timing; duplicates are dispatched while the request is provably held.

**Also fixed:** the paired-autofill success case asserted the request counter synchronously after `page.evaluate`, which reads 0 because `page.on('request')` is delivered asynchronously. It now awaits `page.waitForResponse()` for the completion endpoint first, then asserts exactly one request. This was a test-harness timing defect, not a product defect: an isolated probe showed the paired events produce exactly one POST and navigate.

## Verification (run on this branch)

| Command | Result |
| --- | --- |
| `node --check public/js/pages/auth/mfa.js` | pass |
| `node --check tests/password-mfa-browser.cjs` | pass |
| `node --check tests/multi-authenticator-browser.cjs` | pass |
| `node tests/password-mfa-browser.cjs` | pass (1440px and 390px iterations; ran twice consecutively, stable) |
| `node tests/multi-authenticator-browser.cjs` | pass (desktop and mobile) |

`npm run check:browser` was intentionally not run (parent owns the single integrated run). `node --test tests/security.test.js tests/password-mfa.test.js` was also left to the parent; the backend contract is unchanged.

## Coverage added in `tests/password-mfa-browser.cjs`

- Incomplete five-digit entry, reported through both `change` and `input`, issues no request and leaves feedback empty.
- Sixth digit supplied by a real keypress (`pressSequentially`) issues exactly one request, shows the localized failure, clears the field, keeps `api/profile` 401, and keeps the status inside the viewport.
- Whole-code paste verifies automatically and reaches `/profile`.
- Native editing (Backspace, ArrowLeft, Backspace) and slot-click positioning run below six digits, so no attempt is spent.
- Language switching with a partial value issues no request and preserves the value.
- IME: during composition the raw value `654-321` is neither normalized nor submitted; `compositionend` synchronizes once, issues exactly one request, and the rejected composition clears the slots.
- Paired `input` + `change` autofill in a single evaluate issues exactly one request and signs in.
- Held-request locking: the request is held at the route, duplicate events plus a direct form `submit` produce no second request, the input is `readOnly` and `#submit` disabled while pending, then release navigates.
- Same-code retry: two rejections of `111111` (the second a re-entry of the same code after clearing) each issue one request, and a corrected fresh-step TOTP code completes the flow.
- Recovery mode: six characters (`123456`) and the real recovery code both issue zero requests; manual `#submit` still succeeds. Toggling back to TOTP restores `one-time-code`/`totp_code`/numeric mode.
- Terminal expiry still disables `#code`, `#submit`, and `#recoveryToggle` after an automatic attempt.

`tests/multi-authenticator-browser.cjs`: `loginWith()` now relies on automatic TOTP completion and documents that recovery codes still need the manual button.

## Residual notes

- Simulated `input`/`change` writes are not real password-manager extension testing and are not reported as such.
- Each automatic attempt consumes one of the five server attempts per pending challenge; no client-side retry or throttling change was made.
