# OAuth2 login cleanup validation

## Result

All PRD acceptance criteria passed on October 21, 2026. The final product diff changes four frontend files, with three asset version updates and 115 deleted lines. No backend or authentication contract changed.

## Delegation

The user explicitly requested the four existing Pi agents in the same Herdr workspace. All worked in `D:/MyNewWebProjects/azurekiln-oauth2`, workspace `w1Q`, without creating additional agents or worktrees:

- `w1Q:p3`: implementation ownership of `views/auth/login.html` and `public/js/pages/auth/login.js`.
- `w1Q:p4`: implementation ownership of `public/css/vaultsso-authorize.css` and `public/js/shared/i18n.js`.
- `w1Q:p5`: read-only final code review, hidden OAuth field preservation, syntax and authentication/security checks.
- `w1Q:p6`: isolated browser validation and desktop/mobile screenshots.

The coordinator inspected the complete four-file diff and the OAuth desktop/mobile screenshots. Existing untracked project tooling and other tasks were excluded from the change set.

## Checks

- `node --check public/js/pages/auth/login.js`: passed.
- `node --check public/js/shared/i18n.js`: passed.
- `node --test tests/i18n.test.js`: 9 passed, 0 failed.
- `npm run check:syntax`: 97 files checked, passed.
- `node --test tests/security.test.js tests/password-mfa.test.js`: 43 passed, 0 failed.
- `node tests/password-mfa-browser.cjs`: passed using the existing test on the final diff. Covers password login, CAPTCHA, email/TOTP MFA, code editing/autofill, recovery, expiry, language changes, state/nonce preservation, and PKCE/non-PKCE authorization callbacks with token exchange.
- Temporary focused browser harness `.artifacts/oauth-login-cleanup/oauth-login-check.cjs`: all 18 combinations passed (direct/OAuth login, 1280x900/390x844/320x740, zh/en/zh-TW). Confirmed no removed card/callback/scope copy, no empty panel, original hidden OAuth fields, one client heading, zero page errors and zero horizontal overflow.
- `git diff --check`: passed.

## Visual evidence

Ignored local artifacts:

- `.artifacts/oauth-login-cleanup/authorize-oauth-desktop-1280.png`
- `.artifacts/oauth-login-cleanup/authorize-oauth-mobile-390.png`
- `.artifacts/oauth-login-cleanup/authorize-direct-desktop-1280.png`
- `.artifacts/oauth-login-cleanup/authorize-direct-mobile-390.png`

## Harness adjustments

The temporary harness initially waited for `networkidle`, which did not settle for the anonymous `/api/profile` probe. It was changed to wait for page load, initialization responses, a visible/sized `#authRegion`, and a nonempty heading. Only Chromium's expected anonymous-session HTTP 401 resource log is allowed; page errors and other console errors remain failures.

An initial direct-login assertion incorrectly expected empty `scope` and `response_type`. Comparison with `HEAD` confirmed that `openid profile email` and `code` are pre-existing hidden-input defaults. The harness explicitly asserts those defaults while requiring absent request-specific fields to remain empty. No product assertion about visible content was weakened.

## Spec review

Reviewed using `trellis-update-spec`. This is a one-off presentation deletion with no new API, data-flow, authentication, or reusable implementation contract. Existing authentication feedback and MFA contracts remain valid; no shared spec update is needed.

## Commit approval

Implementation and verification are complete. The user approved the presented commit plan on October 21, 2026 by requesting a standardized commit. The work commit, task archive, and session journal follow the approved scope.
