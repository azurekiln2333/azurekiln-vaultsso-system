# Frontend implementation and verification

## Changes

- `views/auth/login.html`: accessible native `select#loginSessionDays[name=session_days]`, default 1, choices 1/7/14; visible on account and password steps.
- `public/js/pages/auth/login.js`: preserve the same select through discovery/account changes and locale rendering; serialize it with the existing credential form; append the current value to local provider initiation links at hydration and on change; synchronize provider links after a form reset.
- `public/js/shared/i18n.js`: simplified Chinese, traditional Chinese and English labels/options plus `auth.session.invalid_duration`.
- `public/css/vaultsso-authorize.css`: restore the native select arrow with a form-scoped `appearance: auto`. Initial actual screenshots and computed styles showed the Tailwind forms reset hid the arrow; no sizing/layout redesign was needed.
- `tests/session-duration-browser.cjs`: real browser regression for UI propagation, actual credential POSTs, exact session policy/cookie persistence and MFA continuation.
- `tests/i18n.test.js`: readable duration choices and validation in all three locales.
- `package.json`: include the new regression in `check:browser`.
- Shared i18n consumer cache URLs updated in `views/account/profile.html`, all eight `views/admin/*.html` consumers, `views/auth/login.html` and `views/auth/mfa.html` to `20261026-session-duration-1`. Login script and changed authorize CSS use the same feature version.

All edits were compared with `.artifacts/session-duration/baseline/`; pre-existing authentication, admin, SMTP and other changes were preserved. No files were staged or committed by this worker.

## Commands and results

All commands ran on October 26, 2026 with the isolated in-memory fixture and local Chrome.

| Command | Result |
| --- | --- |
| `node --test tests/i18n.test.js` | 21 passed, 0 failed |
| `node tests/session-duration-browser.cjs` | Passed: six UI locale/viewport combinations; real 1/7/14-day credential requests; matching JWT/row/cookie deadline; fresh browser context persistence without activity renewal; email MFA body override ignored; TOTP-to-mandatory-mailbox successor retains original duration |
| `node tests/account-first-login-browser.cjs` | Passed: account discovery/setup, missing-account localization and retries, stale-action guards, OAuth/MFA continuation, desktop/mobile |
| `node tests/password-mfa-browser.cjs` | Passed: CAPTCHA, email/TOTP entry/autofill, request locking/retries, recovery, expiry, localization and OAuth continuation, desktop/mobile |
| `node tests/login-email-gate-browser.cjs` | Passed: mailbox matrix, manual sends, TOTP/recovery successors, concurrency/failure guards, OAuth continuation and no premature credentials, desktop/mobile |
| `npm run check:syntax` | Passed: 107 files and browser script references |

The focused UI-only extraction was also run before the server was ready; the complete checked-in test subsequently passed against the implemented backend.

## Browser evidence and visual review

All twelve final screenshots were opened and inspected with the image tool after the native-arrow correction. The selector, labels, field alignment, focus, available actions and phone layout are readable, with no horizontal overflow.

Evidence under `.artifacts/session-duration/`:

- `account-desktop-zh-CN.png`, `account-desktop-zh-TW.png`, `account-desktop-en-US.png`
- `account-mobile-zh-CN.png`, `account-mobile-zh-TW.png`, `account-mobile-en-US.png`
- `password-desktop-zh-CN.png`, `password-desktop-zh-TW.png`, `password-desktop-en-US.png`
- `password-mobile-zh-CN.png`, `password-mobile-zh-TW.png`, `password-mobile-en-US.png`

Provider configuration is explicitly simulated in the new UI test to exercise two local initiation URLs and delayed hydration. Real external provider authentication is not claimed by this browser test; backend provider suites own that coverage. Credential discovery, actual form requests, mailbox/TOTP verification and browser cookies all run against the real isolated application with captured mail. No production database, real SMTP or live deployment was used.

## Remaining frontend gaps

None known within the approved feature scope. Main-session integration and Trellis quality review remain separate gates.
