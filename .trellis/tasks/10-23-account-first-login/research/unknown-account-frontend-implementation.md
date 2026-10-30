# Explicit missing-account feedback — frontend/i18n implementation report (p5)

Task: `.trellis/tasks/10-23-account-first-login` (unknown-account feedback follow-up)
Owner: Pi `w1Q:p5` (auth/admin frontend). Status: **complete and stable; handed to root/p6.**

Authoritative contract: `research/unknown-account-contract.md`.
Product decision: 改为立即提示账号不存在 (explicit 404 feedback for identifiers with zero matches).
**No login JS behaviour change was made or needed.** No backend, tests, `package.json`, spec, sorting or
style change. Nothing staged/committed/reset/deployed/archived.

## 1. Changed files (this follow-up only)

| File | Change |
| --- | --- |
| `public/js/shared/i18n.js` | new `auth.account_not_found` key in zh-CN / en-US / zh-TW |
| `views/auth/login.html` | shared i18n cache version bump (auth consumer) |
| `views/auth/mfa.html` | shared i18n cache version bump, kept in lockstep with login.html |

The frozen sorting files (`public/js/pages/admin/users.js`, `views/admin/users.html`,
`public/css/vaultsso-admin-pages.css`) and all other workers' files were not touched.

## 2. Translations added

Placed immediately after the existing `auth.email_gate.cooldown` entry in each locale block, keeping each
block's existing indentation:

| Locale | Key | Value |
| --- | --- | --- |
| zh-CN | `auth.account_not_found` | `账号不存在` |
| en-US | `auth.account_not_found` | `Account does not exist` |
| zh-TW | `auth.account_not_found` | `帳號不存在` |

Exact line anchors after the edit: `i18n.js:125` (zh-CN), `i18n.js:648` (en-US), `i18n.js:1171` (zh-TW).

## 3. Why no login JS change

`public/js/pages/auth/login.js` `rediscoverAccount()` (lines 599-662) already does the right thing:

- On `!response.ok` it calls
  `setStatus('error', i18n.resolveMessage(result, 'common.network_error', { client: getClientLabel() }), requestFeedbackRevision)`
  and returns **without calling `setLoginStep`**, so the flow stays on the `account` step: the username
  field remains editable and the password field stays hidden/disabled.
- `i18n.resolveMessage` resolves `payload.error_key` **before** `error_description` (i18n.js:1271-1273), so
  the backend `{"error":"account_not_found","error_key":"auth.account_not_found","error_description":"账号不存在"}`
  renders the localized key in every locale instead of leaking the Chinese description.
- The `finally` block still calls `endAuthAction()` + `applyLoginStepLabels()`, so the Continue button
  label and the shared auth mutex are restored after the failed discovery.
- Unknown-key fallback still degrades to `common.network_error`; no machine code (`auth.account_not_found`,
  `account_not_found`) is ever displayed.

## 4. Cache versions

Both auth pages consume the shared i18n asset and were bumped together (they were previously both at
`?v=20261024-email-gate-3`):

- `views/auth/login.html`: `<script src="/js/shared/i18n.js?v=20261025-account-not-found-1">`
- `views/auth/mfa.html`: `<script src="/js/shared/i18n.js?v=20261025-account-not-found-1" defer>`

Per the contract, only affected auth pages were bumped. The admin pages and
`views/account/profile.html` do not render this login key and were deliberately left at their existing
versions (no cache-only churn). No other auth-page asset (`login.js`, `vaultsso-authorize.css`,
`vaultsso-mfa.css`, `mfa.js`) needed a bump because none of them changed.

## 5. Verification (focused, run by p5)

- `node --check public/js/shared/i18n.js` → OK.
- `npm run check:syntax` → "Syntax and browser script references checked: 104 files".
- `node --test tests/i18n.test.js` → **9/9 pass** (unchanged).
- **Independent focused resolution harness: 19/19 checks passed.** A throwaway Node `vm` script kept
  OUTSIDE the repo at `%TEMP%\verify-account-not-found.cjs` loads the real `i18n.js` with the same
  `window`/`navigator`/`document` sandbox as `tests/i18n.test.js` and asserts, for each of zh-CN, en-US
  and zh-TW:
  - `t('auth.account_not_found')` returns the expected localized string;
  - `resolveMessage({error,error_key,error_description}, 'common.network_error')` prefers `error_key` and
    returns the localized string (the Chinese description never leaks into en/zh-TW);
  - a payload carrying only the machine code never renders `auth.account_not_found` / `account_not_found`;
  - the previously added `auth.email_gate.cooldown` / `bind_title` / `verify_title` keys and prior
    `auth.password.contact_admin` / `auth.setup.code_hint` keys still resolve.
  The harness also confirms all three locales carry the new key identically.
  Reproduction: `node %TEMP%\verify-account-not-found.cjs` (run from the repo root).
- Regression sanity: `grep 'auth.email_gate.'` still yields **51** occurrences = 17 keys × 3 locales, so
  the earlier email-gate translations remain intact.
- Not run by p5 (owned by p4/p6/root): `tests/account-first-login*.test.js`,
  `tests/login-email-gate*.test.js`, `npm run check:browser`, and the new genuine-missing-account browser
  coverage. No aggregate suite was run.

## 6. Notes for p4 / p6

- Nothing in the response contract is rendered by login JS other than `error_key` → status text; there is
  no `next`, destination, password field, mail or session side effect to assert on the frontend beyond the
  stored step still being `account`.
- p6 UI assertions: stub `POST /oauth2/authorize` (JSON, `discover_account:true`) to return 404 with the
  payload above, then assert `#statusMessage` shows `账号不存在` (zh) / `Account does not exist` (en) /
  `帳號不存在` (zh-TW); the password input remains hidden/disabled and `#loginUsername` remains editable
  and focused-usable; no further request is made; and a subsequent genuine Continue with a known account
  still advances to the password step (preserve the existing account-first and sorting coverage).
- The zh-CN `账号不存在` string is the only visible copy for this state; it contains no implementation
  vocabulary and no machine codes.