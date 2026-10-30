# Implementation Coordination Contract

This is the initial account-first implementation contract. Later user-authorized import changes in `import-upload-contract.md`, mailbox gates in `login-email-gate-contract.md`, sorting in `users-sort-contract.md` and explicit missing-account feedback in `unknown-account-contract.md`, together with the current PRD/design, supersede its original scope restrictions. Do not ask for another planning approval. Preserve the captured baseline in `research/baseline.json`.

## Shared API/UI Values

- JSON `POST /oauth2/authorize` with `discover_account: true` and `username`, plus the applicable original OAuth parameters.
- Successful discovery `next` is exactly `password`, `set_password`, or `contact_admin`; only `set_password` returns `email_masked`. The later explicit user choice requires zero matches to return 404 `account_not_found` / `auth.account_not_found` with description `账号不存在` and no next step or account metadata. Existing ambiguous identifiers retain `password`; lock/OAuth precedence and generic recovery are unchanged.
- Account-bound send uses `POST /api/email-verification/send` with `{ username, purpose: 'password_reset' }`.
- Account-bound setup uses `POST /api/password-reset` with `{ username, email_code, password, confirm_password }`.
- Both new variants reject a body containing both `username` and `email`. Old email-only requests retain their current semantics.
- New account-bound setup state change: HTTP 409, `error_key: 'auth.password.setup_changed'`, readable description instructing the user to check the account again. Frontend safely rediscovers or returns to account entry.
- No usable mailbox on the new account-bound path: HTTP 400, `error_key: 'auth.password.contact_admin'`, description `该账户没有可用邮箱，请联系管理员重置。` Frontend selects the contact-administrator section.
- Invalid dual identifiers: HTTP 400, `error_key: 'auth.password.setup.invalid_identifier'`, description `请仅提供账号或邮箱中的一项。` Missing/invalid discovery account may use a readable existing validation response; do not expose a machine key as text.
- Unknown send remains generic HTTP 200 `email_code.sent` with no mail; unknown setup remains the existing invalid/expired-code failure. Discovery and final login preserve banned/locked errors. Send/setup retain existing recovery behavior and do not authenticate or remove bans/login locks.
- Setup success reuses HTTP 200 `message_key: 'auth.password_reset.updated'` and returns the browser to password entry without logging in.
- The backend adds `User.setInitialPassword(id, verifiedEmail, newPassword)` returning actual affected-row success. Its conditional SQL binds user ID, verified email, and unset password, sets password plus `email_verified` atomically, and runs before credential revocation. Backend publishes the exact SQL to API-test owner before integration.

## Frontend/Test Selectors

- Keep `#loginUsername`, `#loginPassword`, `#loginForm .submit`, and all existing OAuth hidden inputs.
- `#loginForm .submit` is one persistent button: account step means Continue; password step means Sign in. Tests must click Continue before filling the password.
- New sibling setup form ID: `#passwordSetupForm`; inputs `#setupEmailCode`, `#setupPassword`, `#setupConfirmPassword`; send button `#sendSetupCodeBtn`; masked destination `#setupEmailMasked`.
- Contact section ID: `#loginContactAdmin`. Put it inside the existing login card, not a new top-level data-card.
- Back/change-account action: `#changeLoginAccountBtn`, reachable from password/setup/contact steps (one common visible action is sufficient).
- New tests: `tests/account-first-login.test.js` (API owner), `tests/account-first-login-browser.cjs` (browser owner).

If a selector or contract must change for a concrete implementation reason, coordinate it with the other affected owner before editing. No hidden auto-advance to preserve one-step browser tests. The initial implementation excluded import/admin/MFA product changes; later contracts explicitly authorize the import corrections and shared MFA mailbox gates while preserving unrelated styling.
