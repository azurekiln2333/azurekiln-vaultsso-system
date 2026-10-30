# R19 registration username input implementation

## Boundary and result

The former registration UI accepted unsupported characters during editing and only rejected them on submit. This follow-up changes only the registration username editing/feedback boundary to ASCII letters, digits and underscore, preserving case and a 255-character maximum. The task's `username-input-contract.md` supersedes the older hyphen and submit-only guidance. The saved snapshot in `username-input-baseline.json` was preserved.

Changed files:

- `public/js/pages/auth/login.js`: input/change filtering with mapped caret/selection; composition deferral and Enter/submit protection; clipboard filtering before the native length bound with selection replacement/suffix preservation; localized native-pattern invalid feedback; strict raw submit rejection independent of native validation.
- `public/js/shared/i18n.js`: matching Simplified Chinese, English and Traditional Chinese username hints/errors without hyphens.
- `views/auth/login.html`: optional username pattern, maxlength, username autocomplete, autocapitalize/spellcheck attributes and matching fallback hint; login/shared-script cache versions changed to `20261025-username-input-1`.
- `views/auth/mfa.html` and `views/account/profile.html`: shared i18n cache reference only. The R18 profile outer avatar overlay and inner glyph structure are untouched.
- `tests/auth-feedback-browser.cjs`: meaningful desktop/mobile editing and raw-submit coverage; previous successful registration fixture now uses underscores; existing raw Chinese rejection bypasses input events so native pattern feedback is still exercised.
- `tests/i18n.test.js`: three-locale current-rule coverage.

Ordinary login entry retains email, Chinese and existing hyphenated identifiers. Empty optional registration usernames still complete a real registration using the validated email fallback. Password policy/guidance, discovery, CAPTCHA/MFA, icon loading and OAuth behavior were preserved. No refactor or change to shared models, imported/provider usernames, live data, deployment or git state was performed.

## Focused verification

- `node --check public/js/pages/auth/login.js`, `node --check public/js/shared/i18n.js`, `node --check tests/auth-feedback-browser.cjs`, `node --check tests/i18n.test.js`: passed. Login/browser syntax was repeated after the mixed long-paste correction.
- `node --test tests/i18n.test.js`: 18/18 passed.
- `node tests/auth-feedback-browser.cjs`: passed after the final code change at 1440x1000 and 390x844. Preserves real minimum-12/minimum-16 settings, registration/setup/recovery/profile, all three languages, delayed/failed/malformed config and existing feedback scenarios.
- `git diff --check --` for the seven owned product/test files: passed (only existing Git LF/CRLF conversion notices).

The browser scenarios exercise allowed typing/case; unsupported Chinese, whitespace, punctuation, hyphen and fullwidth text; actual browser clipboard paste; mixed paste over 255 raw characters with valid suffixes; bounded replacement preserving original trailing text; forward/backward selection and caret mapping; deletion; native and event-driven length limits; optional-empty real registration; original native-pattern invalid feedback in three locales; direct raw `submit` event rejection bypassing native pattern; and unchanged login account values. Temporarily valid composition values attempt both `requestSubmit()` and a dispatched submit to prove the guard independently of the native pattern.

Evidence under `.artifacts/username-input/`:

- `auth-feedback-browser.log`: final focused browser command output.
- `browser-evidence.json`: desktop/mobile scenario records.
- `username-editing-1440.png` and `username-editing-390.png`: inspected; guidance, form fields and actions remain readable without overflow.
- `frontend-baseline.diff`: exact seven-file follow-up diff against the saved pre-R19 snapshot, excluding prior dirty changes.
- `focused-checks.json`: focused command outcomes.

## Limits and handoff

Composition checks use explicitly dispatched composition/input/keyboard events. They do not claim actual operating-system Chinese IME coverage. Clipboard checks use Chromium clipboard permissions and native Control+V. Root owns final aggregate checks and independent review. All seven product/test files are frozen for that handoff.

## Independent-review follow-up: post-composition Enter

The checker reproduced a narrow event-order gap: an IME may emit `compositionend` before its final `keydown Enter`, with both composing flags false and `keyCode === 229`. The Enter handler now treats that 229 event as IME confirmation too. This follow-up changes only `public/js/pages/auth/login.js` and `tests/auth-feedback-browser.cjs` within the original ownership.

The regression separately probes active composition with `isComposing:false`, no active composition with `isComposing:true`, and the post-composition 229 ordering with both flags false. Each synthetic keydown explicitly replays `requestSubmit()` only if the event was not prevented, because synthetic events do not invoke browser default actions. All three are prevented and produce zero registration POSTs at desktop/mobile. The final optional-empty registration now uses actual `username.press('Enter')` and succeeds, proving ordinary non-IME Enter still submits normally. These are event simulations, not actual OS IME evidence.

`node --check public/js/pages/auth/login.js`, `node --check tests/auth-feedback-browser.cjs` and the complete focused `node tests/auth-feedback-browser.cjs` all passed after this fix. Final output is `.artifacts/username-input/auth-feedback-browser-ime-order.log`; `browser-evidence.json` records all event flags, key codes, explicit default-action replay and normal Enter success. The snapshot diff and focused-check outcomes were refreshed. Product/test files are frozen again for the root aggregate and checker confirmation.
