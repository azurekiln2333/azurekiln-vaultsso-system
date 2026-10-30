# MFA acceptance

Date: 2026-10-21. Branch: `fix/admin-mfa-polish`. Layout, behavior and independent browser review: PASS. Commit/archive pending parent Phase 3.4 review.

## Acceptance

- [x] Code row 48px desktop / 44px mobile, heading 20px / 18px, primary action 36px, recovery field 40px. Localized instructions and feedback wrap without overflow at desktop, 390px and 320px.
- [x] Incomplete input makes no request. Typing the sixth digit, whole-code paste and simulated autofill completion each attempt automatically through the existing submit owner.
- [x] A held request blocks duplicate input/change/manual attempts. Rejected codes do not navigate, clear/refocus the field and permit retry of the same code.
- [x] Success retains same-origin/OAuth continuation. Recovery remains manually submitted; mode/language rendering does not submit. Terminal expiry retains disabled controls.
- [x] Focused browser suites, security/MFA unit checks and the parent's final integrated browser check pass.

## Evidence

- Layout delivery: `layout-result.md`; behavior/test delivery: `behavior-result.md`.
- Independent browser review: `../10-21-admin-mfa-polish/review.md`; 41 final MFA PNGs and `after-measurements-mfa.json` under ignored `.artifacts/admin-mfa-polish/after/`.
- Main inspected final desktop TOTP and mobile English recovery screenshots. Chinese/English/Traditional Chinese, desktop/mobile/narrow, focus/error/recovery states have no document overflow or unexpected page/console errors in the matrix.
- `npm run check:syntax`: PASS, 97 files.
- `node --test tests/security.test.js tests/password-mfa.test.js`: PASS, 43 tests.
- `node tests/password-mfa-browser.cjs`: PASS, includes actual sixth-digit keypress, paste, native editing, paired autofill events, IME, held-request locking, invalid/same-code retry, manual recovery, expiry, language and OAuth/PKCE continuation at 1440/390.
- `node tests/multi-authenticator-browser.cjs`: PASS, desktop/mobile independent-device behavior.
- Parent `npm run check:browser`: final PASS, all six suites, exit 0. Parent validation records the initial unrelated account-bindings timeout honestly.
- `git diff --check`: PASS.

## Contract and limits

Only `vaultsso-mfa.css`, `views/auth/mfa.html`, `mfa.js` and two existing browser suites change. The frontend auth-feedback spec is updated with completion/retry/IME/recovery behavior and independent TOTP-fixture requirements. One real native input and its factor-specific names/autocomplete remain. No backend policy, attempt budget, endpoint or redirect-trust change. Every automatic verification consumes the existing attempt budget; there is no background retry. Autofill is simulated input/change notification, not a real extension test.
