# Missing-account browser regression implementation

## Scope and ownership

This handoff replaces the unavailable Herdr p6 missing-account follow-up. Changed only `tests/account-first-login-browser.cjs` and this report. Product, API tests, shared fixture helpers, sorting coverage, package scripts and other workers' changes were preserved. The browser test is now frozen for root aggregate validation.

## Real backend coverage

Added 12 scenarios: two viewport sizes (1440×1000 desktop and 390×844 mobile), three browser locales (`zh-CN`, `en-US`, `zh-TW`), and genuinely missing username/email identifiers. The tests use the real login page and real `/oauth2/authorize` route against the existing isolated memory-database fixture. They do not stub account-discovery responses. Existing fixture mail capture replaces SMTP, and external-origin browser requests remain blocked by the existing session helper.

Each scenario asserts:

- Continue submits exactly account-only discovery JSON and receives the exact 404 `account_not_found` / `auth.account_not_found` response with no added account, destination or credential fields.
- The actual error key resolves to `账号不存在`, `Account does not exist` or `帳號不存在` according to the browser locale; feedback is inside the viewport, and screenshots have no horizontal overflow.
- The account field remains editable with the original identifier, the password remains hidden, disabled and not required, and the primary action returns to its account-step label.
- A settled 500ms failure observation produces exactly one authentication request, without automatic retry, mail, credential submit or pending-state request. Initial read-only profile/auth configuration/provider configuration GETs are excluded from request counting.
- No mail, session, authorization code, access/refresh token or email verification row exists. Discovery sends no Set-Cookie, the browser has no session/pending cookie, `/api/profile` remains 401 and the real pending endpoint remains 401.
- Correcting the same form to a known account and clicking Continue receives `{next:'password'}` and opens an editable password field, with exactly one additional discovery request and still no session or mail.

The pre-existing first-password setup, manual sending, contact-administrator, stale discovery/send/reset, action locking, MFA, OAuth state/nonce/PKCE and code-exchange scenarios remain present and passed in the focused run.

## Validation and evidence

- `node --check tests/account-first-login-browser.cjs`: passed.
- `node tests/account-first-login-browser.cjs`: passed, including all 12 new scenarios and existing desktop/mobile scenarios.
- Log: `.artifacts/unknown-account/account-first-login-browser.log`.
- Twelve screenshots: `.artifacts/account-first-login/missing-{username|email}-{zh-CN|en-US|zh-TW}-{desktop-1440|mobile-390}.png`.
- Visually inspected one real screenshot for every locale/viewport combination (six images); error text, editable account field and Continue action are fully visible and the password field is absent.

The first focused attempt timed out at an added global `networkidle` wait before reaching the new cases. That readiness assumption was removed; the final test uses the existing form-ready marker and filters only known initial read-only requests. The corrected focused run completed successfully. No product workaround was made.

Root owns syntax and full API/browser aggregates. No commit, push, deployment or archive was performed.
