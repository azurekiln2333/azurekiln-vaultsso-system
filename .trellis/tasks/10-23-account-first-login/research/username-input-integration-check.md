# R19 / AC18 independent integration review

Date: 2026-10-25. Scope: the frozen registration-username input follow-up in `username-input-contract.md`, both implementation reports, executable specs and public API documentation. Reviewer: `/root/check_user_sort`.

## Verdict

The final reviewed product, regression tests and documentation satisfy the R19 contract. No unresolved finding remains within this review scope. The earlier reviewer-discovered post-composition Enter submission gap was fixed by the frontend owner and independently rechecked. The coordinator's final original browser aggregate passed all eleven groups, including the unchanged import test, after the final IME fix. Final refreshed syntax passed 106 files, and the 304/304 API checkpoint remains valid. The required R19 verification gates are green.

The reviewer changed only this report in the final review handoff. Product/test changes stayed with their assigned owners. Unrelated dirty work and the pre-follow-up snapshots were preserved; no stage, commit, push, deployment, archive, reset, stash or live-data operation was performed.

## Findings (fixed)

- File: `public/js/pages/auth/login.js:985`; regression: `tests/auth-feedback-browser.cjs:185`.
- Issue: the initial Enter guard checked only the active composition flag and `event.isComposing`. In the controlled `compositionend -> keydown Enter` ordering, both flags were false while `keyCode` was 229. A temporarily valid username passed native validation, and the review probe replayed the unprevented default action to produce one intercepted registration POST. Native pattern rejection therefore could not establish that IME confirmation was safe.
- Fix: following coordinator approval, the frontend owner added `event.keyCode === 229` to the existing Enter guard. The regression now independently exercises active-flag-only, event-flag-only and post-composition-229 cases with a valid name and explicit default-action replay. Both viewports show `defaultPrevented: true`, `dispatchAllowed: false` and zero registration POSTs in all three cases. A native ordinary Enter then completes the real optional-empty registration through the email fallback.
- Evidence: `.artifacts/username-input/ime-order-review.json` records the original controlled reproduction. `.artifacts/username-input/browser-evidence.json` and `auth-feedback-browser-ime-order.log` record the final regression. The frontend executable spec and frozen contract also capture the event-order requirement.

These composition checks dispatch DOM events; synthetic keyboard events have no native default, so the probe explicitly calls `requestSubmit()` only when the event was not prevented. They establish the implemented event-handling contract, not actual operating-system Chinese IME coverage. The original POST was intercepted with a synthetic error and did not create live data.

## Findings (not fixed)

None within the reviewed R19 product, test and documentation scope.

Historical validation attempts remain recorded rather than being relabeled as passes. In `.artifacts/username-input/check-browser-before-ime-order.log`, the first five groups and desktop mixed/2501-row import/reimport completed before unchanged `tests/user-import-upload-browser.cjs:534` timed out in `locator.setInputFiles` at the over-limit upload. An isolated original import run then timed out at the different `locator.innerText('#importResult')` call at line 526 (`import-browser-isolated.log`). Diagnostic copies and logs (`import-diagnostic.cjs`, `import-diagnostic.log`, `import-diagnostic-silent.cjs`, `import-diagnostic-silent.log` and `import-diagnostic/`) retain the investigation evidence; the logged diagnostic copy completed desktop/mobile, but those copies do not replace the original test as the required gate. These two earlier timeouts were not sufficient to establish a product root cause, and no product/test workaround or timeout extension was made. The coordinator's final original aggregate subsequently passed the unchanged import desktop/mobile 2501-row import/reimport and every remaining group (`check-browser-final.log`, exit 0). There is no remaining aggregate blocker. The reviewer did not rerun tests or aggregates for this final evidence-only report update.

## Source and baseline review

- All ten stored snapshot hashes in `username-input-baseline.json` were verified. The exact follow-up delta was reviewed against those snapshots rather than treating the repository's combined dirty diff as R19 work.
- Backend: the server follow-up is exactly two registration-route lines: remove hyphen from `^[A-Za-z0-9_]{1,255}$` and its readable description. Raw-versus-normalized comparison, non-string rejection, blank/null/whitespace-only ASCII-email fallback, existing email/CAPTCHA/registration-switch precedence and validation before proof consumption remain intact. The server rejects raw invalid input rather than sanitizing it into a different account name.
- Frontend: only the optional registration username field is filtered. Allowed case and characters remain; selection endpoints are mapped through filtered prefixes, selection direction/deletion are preserved and the result is bounded to 255 characters. Clipboard text is filtered before native maxlength, with remaining capacity based on the selected range, so valid suffixes and existing trailing text survive replacement. Unfinished composition remains untouched and committed composition is normalized. The final Enter guard and submit guard block composition submissions.
- Native field constraints, localized invalid feedback and an independent raw submit guard agree on letters/digits/underscore. Programmatic raw invalid values cannot bypass the guard by skipping editing events. Blank username remains optional. Login account entry is unchanged for emails, Chinese and existing hyphenated names.
- Three locales, affected login/shared-i18n cache references (`20261025-username-input-1`) and MFA/profile shared-i18n references agree. Prior configured-password guidance and R18 icon loading references remain present. The profile outer `.profile-avatar-edit` and nested glyph structure are preserved.
- Callers: all `/oauth2/register` uses were scanned. The successful browser fixture changed from `Ascii_${minimum}-${viewport.width}` to the underscore form. Security cases were adapted by the backend owner. Turnstile callers cover validation precedence/widget rendering and require no successful-name fixture change. Direct model/import/provider/login fixtures retain their legacy Chinese, email and hyphenated identifiers. No shared-model or provider sanitization was added.

## Meaningful regression evidence

- Security focused suite: 40/40 passed (`.artifacts/username-input/security-focused.log`). Existing registration cases now prove case/underscore/1/255 boundaries and Unicode display names; 21 raw/type invalid values including hyphens return the current error without proof attempts/consumption, mail or credentials. The same proof succeeds with a corrected underscore name and real OAuth continuation. Blank fallback, Unicode-email/error precedence, configured password 12/16 and separately seeded Chinese/hyphenated legacy account discovery/password/profile remain covered.
- I18n focused suite: 18/18 passed (`.artifacts/username-input/focused-checks.json`).
- Final focused auth browser suite passed after the IME fix (`.artifacts/username-input/auth-feedback-browser-ime-order.log`). Desktop/mobile cover actual typing and Chromium clipboard/Control+V; unsupported and mixed text; overlength raw prefixes preserving legal suffixes; bounded selected replacement preserving trailing text; caret/backward selection/deletion; native and event-driven length limits; controlled composition; raw direct-submit rejection with zero POST; all-three-locale native invalid feedback; real corrected registration and ordinary Enter email fallback. Existing real configured-12/16 guidance and simulated uncertain-config states remain covered.
- Browser evidence explicitly distinguishes real clipboard/registration from simulated composition/config states. The coordinator inspected desktop/mobile username-editing screenshots and found readable guidance/controls without overflow.

## Documentation synchronization

The current backend registration policy, frontend feedback spec and `views/docs/api.html` agree on new explicit `[A-Za-z0-9_]` names, raw API rejection, browser editing behavior, optional validated ASCII-email fallback and legacy login/import/provider compatibility. The frontend spec includes the post-composition 229 pitfall. PRD R19 describes email fallback when username is blank. Older R17/AC16 and `registration-policy-contract.md` hyphen statements are explicitly marked superseded historical context. PKCE's separate `[A-Za-z0-9_-]` contract is unchanged.

## Verification

- Lint: no standalone lint script is configured. The frontend owner's scoped seven-file whitespace check passed. No lint gate was invented or claimed.
- TypeCheck: no standalone type-check script is configured for this JavaScript project. Final reviewer `node --check` passed on `server.js`, `tests/security.test.js`, `public/js/pages/auth/login.js`, `public/js/shared/i18n.js`, `tests/auth-feedback-browser.cjs` and `tests/i18n.test.js` after final freeze.
- Tests: focused security 40/40, i18n 18/18 and final focused auth browser passed, as above. The reviewer inspected the final evidence without rerunning those suites.
- Coordinator API aggregate: 304/304 passed, zero failures/cancellations/skips (`.artifacts/username-input/check-e2e-final.log`).
- Coordinator final refreshed syntax aggregate: 106 files and browser references passed after the IME fix, exit 0 (`.artifacts/username-input/check-syntax-final.log`).
- Coordinator final original browser aggregate: all eleven groups passed after the IME fix, exit 0 (`.artifacts/username-input/check-browser-final.log`). This includes desktop/mobile 2501-row import/reimport, the original 97KiB/over-limit/retry cases, account-first and mailbox/MFA/OAuth flows, Turnstile, user sorting and icon loading. The historical timeout/diagnostic logs above are retained separately.
