# Registration policy frontend implementation

## Boundary

The gap was visible guidance: registration and recovery promised six characters while the server already exposed its effective configured minimum, and explicit registration usernames had no character guidance or local feedback. This change uses the existing auth-config API for guidance and leaves password acceptance with the existing server policy. It does not change ordinary login restrictions, account discovery, CAPTCHA/MFA/OAuth ordering, imports, stored usernames, display-name character support, or styles.

Compared against `research/registration-policy-baseline.json`, the frontend owner changed only:

- `public/js/shared/i18n.js`: a small presentation-only `passwordGuidance(rawMinimum)` helper, localized dynamic/neutral prompts and username guidance, removal of legacy six-character password promises, and preservation of readable server descriptions for known password-length errors.
- `public/js/pages/auth/login.js`: apply dynamic guidance to registration, first-password setup and recovery after config and language rendering; start/restart config loading with neutral guidance; reject a nonblank explicit raw username outside `[A-Za-z0-9_-]{1,255}` in the existing active status region. Blank/whitespace-only usernames retain server email fallback. No trimming/sanitizing of an explicit username and no new browser password validator or `minlength`.
- `views/auth/login.html`: neutral new-password placeholders, visible optional-username rules with `aria-describedby`, and affected login/i18n cache references.
- `public/js/pages/account/profile.js` and `views/account/profile.html`: fetch the same public effective minimum and show a placeholder plus persistent accessible hint in the existing password modal; reapply after locale changes; update affected cache references.
- `views/auth/mfa.html`: only the shared-i18n cache reference, in lockstep with login.
- `tests/auth-feedback-browser.cjs` and `tests/i18n.test.js`: extend existing tests while retaining their feedback scenarios.

The password presentation helper accepts only raw JSON integers from 12 through 64, matching the existing admin setting boundary. Unknown, delayed, failed and malformed config has a neutral localized prompt. It does not implement mixed-character, common-password, byte-length or password acceptance rules. The server description still supplies the actual policy when a password fails.

## Focused evidence

- `node --test tests/i18n.test.js`: 15/15 pass, including zh/en/zh-TW dynamic variables, all malformed minimum classes, neutral legacy strings, and known/unknown policy-message fallback.
- `node --check` for both changed page scripts, shared i18n and both changed tests: pass.
- `node tests/auth-feedback-browser.cjs`: pass. Extended checks retain the previous login, registration mismatch/policy/email, delayed-send ordering and recovery feedback scenarios.
- Scoped `git diff --check`: pass (only repository line-ending notices).
- Main policy cases use real server settings `password_min_length=12` and `16`, at 1440×1000 and 390×844. Each exercises setup/recovery/register/profile guidance and locale reapplication, sends a real isolated registration email, receives the real server minimum error for a password one character too short, rejects a Chinese username locally with no POST, then registers an ASCII username with the same proof and a Chinese display name.
- Limited transport simulation covers delayed, HTTP 503 and malformed config on auth and profile. The delayed case starts neutral, advances to 16 after release and returns to neutral after a later unavailable refresh. These are explicitly transport simulations; the primary 12/16 checks do not stub config.
- Screenshots and logs are in `.artifacts/registration-policy/`; `browser-evidence.json` records the four real-setting cases and six uncertainty cases. Visual inspection included mobile registration guidance, mobile profile modal, desktop username error, and setup/recovery guidance. Text wraps and remains readable, active errors stay below the submit button, and the page has no horizontal overflow.

## Risks and coordination

The native backend owner independently implements registration-only enforcement and focused API coverage. Root owns combined review, spec/task synchronization and aggregate suites. All tests use isolated memory storage, captured mail and a local browser fixture; no live service, live Cloudflare, production account, commit, push, stage, deployment or archive operation was performed. Existing unrelated dirty edits were preserved.
