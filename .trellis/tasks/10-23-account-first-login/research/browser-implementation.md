# Browser implementation report — account-first login

Owner: Pi w1Q:p6 (browser coverage + existing browser-test adaptation)
Task: `.trellis/tasks/10-23-account-first-login`

## Files owned and changed

| File | Change |
| --- | --- |
| `tests/account-first-login-browser.cjs` | **New.** 14 scenarios × desktop 1440 / mobile 390. |
| `tests/browser-smoke.cjs` | Real Continue before the password; CAPTCHA block no longer re-fills the account field (the account input is not on the password step). |
| `tests/auth-feedback-browser.cjs` | Real Continue before the password; recovery reached after Continue; feedback adjacency expressed against the active step's submit. |
| `tests/account-bindings-browser.cjs` | Real Continue before the password. |
| `tests/turnstile-browser.cjs` | Widget timing moved to the password step (asserted *absent* at the account step). |
| `tests/multi-authenticator-browser.cjs` | Real Continue inside `loginWith()`; all prior assertions preserved. |
| `tests/password-mfa-browser.cjs` | Real Continue at every account-entry site (`credentials()` and 5 inline sites); all prior assertions preserved. |

No product code, fixture, `package.json` or spec file was modified. The pre-existing uncommitted
admin/MFA baseline work in the two MFA browser tests is preserved (additions only).

## Frozen contract used

Selectors are exactly those of `research/implementation-contract.md`: `#loginUsername`,
`#loginPassword`, `#loginForm .submit` (one persistent button), `#passwordSetupForm`,
`#setupEmailCode`, `#setupPassword`, `#setupConfirmPassword`, `#sendSetupCodeBtn`,
`#setupEmailMasked`, `#loginContactAdmin`, `#changeLoginAccountBtn`.

Every login in every browser test is now a real two-step interaction: fill account →
click Continue → password step becomes editable → fill password → submit. No hidden or
backward-compatible shortcut path is used anywhere.

## New coverage (scenario map)

| # | Scenario | Key assertions |
| --- | --- | --- |
| 1 | Account step | Password field not editable and not required; Continue advances without any password; account label != password label; no session after Continue. |
| 2 | Passwordless by username | `next=set_password`; `#setupEmailMasked` equals the server `maskEmail()` of the stored email; raw email never rendered; **discovery sends no mail** and creates no session; explicit `#sendSetupCodeBtn` delivers exactly one code to the server-side address; setup success returns to the password step with **no session**; the new password then logs in. |
| 3 | Passwordless entered **as email** | Same masked setup step (identifier is username *or* email). |
| 4 | No usable mailbox (`@users.invalid`) | `#loginContactAdmin` visible with the contact-administrator instruction; no send action; no setup form; no mail; `#changeLoginAccountBtn` returns to account entry. |
| 5 | Password account + OAuth | Hidden OAuth fields survive the account step; password → `/oauth2/mfa` → callback `state` match → token exchange → `id_token.nonce` match (PKCE proven by the exchange). |
| 6 | Late discovery | First discovery held server-side, account changed, response released: the setup step does **not** open for the stale account, the typed account is not rewritten, and the next Continue resolves the account actually submitted. |
| 7 | Change account | Setup code/password inputs are cleared; no stale values survive. |
| 8 | Ordinary forgot password | `#showRecoveryBtn` is **not** offered at the account step and is reachable at the password step; the entered account carries into `#recoverForm`; the ordinary email code still sends. |
| 9 | Localized feedback | Credential error feedback stays inside the viewport on both widths. |
| 10 | Submit attempted while a **code send is pending** | No `/api/password-reset` request is issued; a **local** password mismatch still reports feedback in that state; step and both actions stay enabled; after the send settles the step is unchanged and no extra code was mailed; the retried submit issues exactly one reset request, no session, then the password logs in. |
| 11 | Send attempted while the **setup submit is pending** | No `/api/email-verification/send` request is issued; the send action is not left disabled; the real setup result is applied, the settled state reports it, no session, and the new password logs in. |
| 12 | Passwordless **+ real OAuth** end-to-end | Setup step and password step both carry the full OAuth request (`client_id`, `redirect_uri`, `scope`, `response_type`, `nonce`, `state`, `code_challenge`, `code_challenge_method`); setup creates **no session**; the new password then requires the **email MFA step** (not skipped); callback `state` matches; token exchange succeeds with the PKCE verifier and `id_token.nonce` matches. |
| 13 | Late **send** + account change | Send held, account changed to a second passwordless account, response released: step, masked destination and typed account all stay on the second account; setup action enabled; no session. |
| 14 | Late **reset** + account change | Password reset held, account changed, response released: no step jump, masked destination stays on the second account, no session, setup action not disabled. |

Every screenshot is taken through a helper that fails on horizontal overflow, so layout is
asserted rather than only captured.

## Frontend behaviour this pins (found while adapting)

`public/js/pages/auth/login.js` enforces a **single authentication action** (`beginAuthAction()`
returns `0` while `authActionActive`), so concurrent actions are *refused* rather than replacing
each other's token. `setLoginStep()` bumps `modeRevision`, calls `invalidateAuthAction()` and
re-enables both submit buttons, so a settled or superseded response can never leave a permanently
disabled control. Scenarios 10/11/13/14 encode exactly these properties, including "the refused
action issues no HTTP request" and "the refused action is not left disabled".

Two behaviours differ from the pre-change test expectations and were relocated, not relaxed:

- Login CAPTCHA (Turnstile and image) now mounts on the **password step**; `turnstile-browser.cjs`
  additionally asserts no widget is mounted at the account step.
- `#showRecoveryBtn` is offered only on the **password step**; `auth-feedback-browser.cjs` and the
  new scenario 8 both walk through a real Continue first.

## Verification (isolated in-memory fixtures, local run)

```
node tests/account-first-login-browser.cjs     PASS  desktop 1440 + mobile 390
node tests/auth-feedback-browser.cjs           PASS
node tests/account-bindings-browser.cjs        PASS
node tests/turnstile-browser.cjs               PASS
node tests/multi-authenticator-browser.cjs     PASS
node tests/password-mfa-browser.cjs            PASS
node tests/browser-smoke.cjs                   PASS
```

`node --check` passes on all seven files. The full `npm run check:browser` is owned by the main
coordinator; these runs were per-file and did not modify product or shared support files.

## Screenshots

Fixed path (gitignored artifacts, stable across task archiving):
`.artifacts/account-first-login/` — 26 PNGs (13 states × desktop 1440 / mobile 390):
`account-step`, `password-step`, `setup-step`, `setup-code-sent`, `setup-complete`,
`setup-by-email`, `contact-admin`, `oauth-password-step`, `stale-discovery`,
`late-send-after-account-change`, `late-reset-after-account-change`, `forgot-password`,
`password-error`.

## Notes for the coordinator

- Nothing in this scope needs a fixture change: passwordless accounts are created with
  `User.create({ password: '' })` exactly as the model stores an absent password, and first-password
  codes are seeded through `POST /api/email-verification/send` when a test needs a code without a UI send.
- `research/baseline.json` product files were already modified when the browser work started
  (`server.js`, `models/User.js`, `views/auth/login.html`, `public/js/pages/auth/login.js`,
  `public/js/shared/i18n.js`, `tests/support/memory-db.js`); `tests/support/fixture.js` was unchanged.
- `tests/account-first-login-browser.cjs` still needs to be appended to the `check:browser` command by
  the coordinator (integration step, as written in `implement.md`).
