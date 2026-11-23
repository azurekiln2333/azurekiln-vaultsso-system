# Execution plan

The user explicitly authorized immediate plan and dispatch to the four existing Pi sessions. Planning was reviewed against current code and an independent read-only explorer. All workers share this checkout and must not revert others, commit, archive, create tasks, spawn agents or modify files outside their ownership without coordinator agreement.

| Worker | Herdr pane | Ownership |
| --- | --- | --- |
| Pi backend | w6Q:p2 | server.js; narrowly scoped new session helper under services if necessary; both account APIs and admin phoneVerified endpoint/security handling |
| Pi login UI | w6Q:p7 | views/auth/login.html, public/js/pages/auth/login.js, public/css/vaultsso-authorize.css, public/js/shared/i18n.js, cache-version-only edits to other templates |
| Pi phone UI/model | w6Q:p5 | views/admin/user.html and public/js/pages/admin/user.js except shared i18n cache version owned by UI worker; models/User.js if needed; tests/phone-api.test.js and tests/account-bindings-browser.cjs for checkbox coverage |
| Pi tests/review | w6Q:p6 | tests/login-accounts.test.js, tests/login-accounts-browser.cjs; package.json browser-check integration; read-only review of other workers |

Coordination update: Pi backend repeatedly reloaded context and left partial undefined helper calls. Its write ownership was stopped explicitly; native `backend_implementation` Trellis implementer now exclusively owns server.js and completes the same frozen contract. Pi backend is read-only. The other three Pi retain their original ownership.

1. Activate task after writing/reviewing PRD, design, manifests. Dispatch all four prompts with task path, ownership, shared API contract, authorization and applicable spec context.
2. Backend and UI workers implement concurrently; tests worker writes against frozen API, phone worker coordinates model semantics without touching server.js. Do not duplicate implementation.
3. Each runs focused checks; tests worker runs account checks when implementation is ready and captures desktop/mobile screenshots. Phone worker validates admin edit/reload and missing-number behavior.
4. Coordinator reviews combined diff and cross-layer consistency, runs npm run check plus targeted/full browser checks as appropriate, inspects actual screenshots, resolves findings via owning workers.
5. Update verified contracts in specs, record verification and session progress, and complete Trellis finish workflow. No production deployment.

## Checks
- npm run check:syntax
- node --test --test-concurrency=1 tests/login-accounts.test.js tests/session-duration.test.js tests/phone-api.test.js tests/password-mfa.test.js tests/login-email-gate.test.js tests/oidc.test.js tests/security.test.js tests/i18n.test.js
- node tests/login-accounts-browser.cjs
- node tests/account-bindings-browser.cjs
- npm run check (full final Node suite)
- Relevant existing account-first/session-duration/auth-feedback browser regressions.

## Review gates
No token disclosure; per-entry expiry and revocation rechecked; no fresh session on switch; no saved pending MFA; existing OAuth behavior; unchanged phone verification cannot be falsely carried to a different number; strict admin-only flag; portable fixtures and no dependency on real production data.
