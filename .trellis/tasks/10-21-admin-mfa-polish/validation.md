# Integration validation

Date: 2026-10-21. Branch: `fix/admin-mfa-polish`, based on `style/oauth-login-cleanup` at `4c264af`.

## Result

Implementation and quality review pass. All five parent acceptance criteria and both children's criteria are met. Work remains uncommitted pending the concrete Phase 3.4 commit-plan review; tasks remain `in_progress` until the work commits and normal finish-work archive.

| Criterion | Evidence |
| --- | --- |
| AC1 / R1 | Shell, iframe and direct admin documents paint neutral `#f8f9fb` with no background image. White panels use 12px radii and no shadow. Admin views consistently version the two changed stylesheets. See child `validation.md` and independent `review.md`. |
| AC2 / R2 | MFA heading 20px desktop / 18px mobile; code row 48px / 44px; primary action 36px; recovery field 40px. Screenshot matrix covers localized wrapping, focus and 320px width. |
| AC3 / R3 | Five digits make zero requests; typed sixth digit, paste and paired input/change completion verify through the existing submit handler. Held-request tests prove duplicate automatic/manual events cannot create a second pending request. IME remains unmodified until composition ends. |
| AC4 / R4 | Invalid codes stay on the page, clear/refocus the field and allow same-code re-entry. Recovery remains manual. Language changes preserve input. Terminal expiry and existing success-only same-origin/OAuth/PKCE continuation pass. |
| AC5 / R1-R4 | Current syntax, 43 security/MFA unit tests and all six integrated browser suites pass. Main inspected the final screenshots after the timestamp/mobile-stat follow-ups. Public shared backgrounds and backend authentication remain unchanged. |

## Commands actually run

| Command | Final result |
| --- | --- |
| `npm run check:syntax` | PASS: 97 files and browser script references checked |
| `node --test tests/security.test.js tests/password-mfa.test.js` | PASS: 43 tests, zero failures |
| `npm run check:browser` | PASS: exit 0; smoke, account bindings, auth feedback, password MFA, multi-authenticator and Turnstile suites all complete |
| `git diff --check` | PASS |

Focused password-MFA, multi-authenticator, auth-feedback and Turnstile browser suites also passed individually while investigating the first integrated failure. No dependency changes, CSS utility generation or backend changes require additional build/type-check work.

### Browser-run history and unresolved flake

The first integrated run stopped at `tests/account-bindings-browser.cjs:65`, waiting for a held background applications-list 401 to appear. The unchanged account-bindings suite also intermittently timed out in worker isolation. Source review and passing probes did not establish the cause. Extra diagnostic assertions were reviewed and removed because they did not prove or fix a race; **no account/profile product or test change is retained**. The final integrated rerun with the original test passes. This pass does not establish that the pre-existing intermittent timeout is fixed. See `account-bindings-review.md` for observed evidence and unproven hypotheses.

## Visual evidence

Independent reviewer: existing Pi pane `w1Q:p6`; full report: `review.md`.

- BEFORE: `.artifacts/admin-mfa-polish/baseline/`, 36 PNGs and `measurements.json`.
- AFTER: `.artifacts/admin-mfa-polish/after/`, 50 admin + 41 MFA PNGs and separate `after-measurements-admin.json` / `after-measurements-mfa.json`.
- Review records 167 measurements, zero failed review assertions, zero page errors/unexpected console errors and zero document overflow. Tables retain horizontal scrolling inside their container.
- Main inspected final `admin-shell-overview-users-zh-desktop-1280.png`, `admin-clients-form-table-zh-mobile-390.png`, `mfa-totp-zh-desktop-1280.png`, and `mfa-recovery-en-mobile-390.png`. The admin screenshots include the final intact timestamps and two-column mobile statistic cards.
- Admin matrix: Chinese/English desktop 1280 and mobile 390; representative Traditional Chinese desktop and Chinese narrow 320; embedded/direct views, collapsed rail and drawer. MFA matrix: Chinese/English/Traditional Chinese, desktop/mobile/narrow, email/TOTP/recovery/focus and interaction traces. Browser suites add 1440/390 checks.

All browser evidence uses isolated in-memory fixtures, stubbed mail and disposable browser contexts. Simulated autofill events are not real password-manager extension testing. Tall forms have full-page captures; the admin seed contains one long-value row, so large real-world table density is not established by this matrix.

## Nonblocking observation

Existing shell-mode runtime language switching re-renders the account label without calling `loadAccount()`, leaving the loading label until a reload. `public/js/shared/admin-shell.js` is unchanged by this task; the reviewer reproduced and documented this separately. Initial locale loading and direct-page account labels pass. Do not claim the runtime-language issue was fixed.

## Scope and specs

Fifteen product/test files change: ten admin CSS/template files and five MFA CSS/template/JS/test files. The account-bindings test has no final diff. Three intended frontend specs record the surface contract, automatic-completion behavior, and fixture/replay pitfalls. Existing unrelated untracked tooling, specs and older tasks remain excluded from the proposed commits. No new worktree, replacement agent, backend/API/schema/policy change or remote push is included.
