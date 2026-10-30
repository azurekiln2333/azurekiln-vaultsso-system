# Validation

## Passed

- `npm run check`: production syntax/script references checked for 92 files; all 202 tests passed.
- `node tests/password-mfa-browser.cjs`: desktop 1440x1000 and mobile 390x844 verification passed. Additional 320x740 English screenshot shows no horizontal overflow or overlap.
- Focused browser coverage includes real clipboard paste, native editing and click replacement, extension-style whole-value `input` and `change` events, successful TOTP/recovery/email login, expiry, language preservation, and OAuth continuation.
- `trellis-check` review found no substantive regressions; independent mocked Chromium checks passed busy/read-only controls, duplicate submission prevention, terminal 429 disabling, and translated feedback.
- `node tests/turnstile-browser.cjs` passed desktop/mobile.
- Scoped `git diff --check` passed.

## Full Browser Suite Limitation

`npm run check:browser` passed browser-smoke, account-bindings, auth-feedback, and password-mfa, then timed out in `tests/multi-authenticator-browser.cjs:52` waiting for the personal-center enrollment error. The standalone multi-authenticator test also timed out.

A read-only baseline run served `HEAD:views/auth/mfa.html` and `HEAD:public/js/pages/auth/mfa.js` through Playwright routes while keeping the current personal-center tree. It reproduced the same enrollment timeout, confirming the MFA changes are not required to produce this failure. No unrelated personal-center code was edited.

## Preview And Limits

- Normal local startup cannot connect to configured MySQL. No database configuration was changed.
- Isolated local preview at `http://127.0.0.1:3147/` uses the project's memory-database fixture and a fresh pending challenge on each root visit. Verified entry 302, MFA page 200, and pending TOTP response 200. Preview-only helper is ignored under `.artifacts/`.
- Actual unlocked-vault Bitwarden integration was not tested. Content-code probes are detailed below and verify detection and menu requests with simulated extension permission responses.
- Changes remain uncommitted; task archive/journal auto-commit steps have not been run. Actual Firefox dropdown confirmation remains pending after deployment.

## Firefox TOTP Follow-up (2026-10-01)

- User clarified that the inline TOTP dropdown works in Chrome and on other websites, but fails here in Firefox.
- Firefox 157 was launched through WebDriver BiDi in a fresh temporary profile. No existing browser profile, vault, or extension storage was read.
- Official AMO Bitwarden 2026.9.0 content code was downloaded and executed with controlled extension message responses, including simulated Premium permission. The real browser DOM, collector, TOTP classifier, listener setup, and trusted pointer click were exercised. Full extension background/UI/vault behavior was not exercised.
- Before the fix: HTML autocomplete token `one-time-code`; native `input.autocomplete` empty; collected `autoCompleteType=null`; name `code`; `isTotp=false`; no field listeners; zero `openAutofillInlineMenu` messages after click.
- Root cause: Bitwarden's `getPropertyOrAttribute` returns the DOM property whenever that property exists, without falling back to the HTML attribute when empty. The generic name `code` is only an ambiguous keyword, insufficient for inline TOTP classification.
- After the fix: `name=totp_code`, `isTotp=true`, login qualification true, field listeners attached, and three menu-open messages. Chrome 2026.5.1 content code continues to recognize the field and request the menu.
- Field names now distinguish initial pending (`verificationcode`), authenticator (`totp_code`), email (`email_code`), and recovery (`recovery_code`). Existing `#code` and API `{ code }` remain intact. Script URL cache version changed to `20261001-mfa-2`.
- `node tests/password-mfa-browser.cjs` passed again with factor naming and recovery restoration assertions.
- Final `npm run check` passed again: 92 syntax/reference checks and 202 tests, zero failures. Independent review found no regressions in naming, mode transitions, cache version, or API serialization.
- Reproducer: ignored `.artifacts/firefox-bidi-probe.cjs` plus `.artifacts/bitwarden-firefox.xpi`. It uses local Firefox and the isolated preview; it does not prove actual vault dropdown contents or rendering.
- CSP was not changed: no matching refusal was established, and field classification already reproduces the Firefox-only failure.
