# Username input correction — backend implementation

## Authorized boundary

The 2026-10-25 user correction in `research/username-input-contract.md` supersedes the earlier registration hyphen allowance. Public explicit registration usernames now use `[A-Za-z0-9_]`, 1–255 characters. Root owns input filtering, coordinated frontend work, documentation, independent review and final aggregates.

Compared with `research/username-input-baseline.json`, this implementer changed only:

- `server.js`: two lines in the existing `/oauth2/register` guard/description. Remove hyphen from the accepted character class and readable username guidance. HTTP400 `invalid_request` / `validation.username.invalid_format` remains the response contract.
- `tests/security.test.js`: adapt the existing registration cases and extend their existing legacy-account case. No parallel mirror test or shared-fixture changes were introduced.

This report is the only other owned file. Product/test files are frozen.

## Preserved behavior

The existing raw-versus-normalized comparison continues rejecting leading/trailing whitespace and CR/LF; the non-string type guard remains intact. The server rejects unsupported input rather than sanitizing it into another name. Omitted/null/empty/whitespace-only usernames still fall back to the valid ASCII email. Existing email validation, CAPTCHA and registration-switch precedence remain unchanged.

The guard remains before registration email-proof attempts/consumption and before account/session/OAuth-code issuance. Login/discovery, shared models, imports, external providers, PKCE and Turnstile rules were not changed. Stored Chinese and hyphenated usernames retain authentication compatibility. Password policy and configured guidance sources are unchanged.

## Adapted real API evidence

The existing seven registration-policy cases remain in the same security suite:

- Valid real registrations now include `a`, `Z9_foo_Bar`, `_`, `9` and a 255-character ASCII name, preserving case, underscore, boundary lengths, Unicode display names and verified email.
- The existing raw-invalid matrix now includes standalone `-` and mixed `valid_after-fix`, alongside Unicode/fullwidth characters, whitespace/CR/LF, punctuation, explicit email-shaped names, overlength and non-string values. All 21 values return the existing 400/key and leave proof attempts at zero, the code unconsumed, no new mail, and no users/sessions/auth codes/access or refresh tokens/login logs.
- The same valid code then registers the explicitly corrected `valid_after_fix` and completes the original real OAuth continuation. This proves rejection did not consume proof or silently create the filtered identifier.
- Blank ASCII-email fallback, Unicode-email rejection precedence, CAPTCHA/registration-switch ordering, and effective password minimum 12/16 checks remain present and passed.
- The existing legacy case now independently seeds both a Chinese identifier and an ASCII hyphenated identifier with verified mailboxes. Both still discover `{next:'password'}`, log in with their password and expose the correct authenticated profile.

## Checks

- `node --check server.js`: passed.
- `node --check tests/security.test.js`: passed.
- `node --test --test-timeout=45000 tests/security.test.js`: **40/40 passed** on the first focused run of this correction.
- Log: `.artifacts/username-input/security-focused.log`.
- Read-only baseline comparison confirmed the server delta is confined to the two registration lines and the test delta to the described existing cases.

Root owns full API/browser gates and independent review. This fixture uses an isolated memory database and captured SMTP; no live data or real mail was touched. No stage, commit, push, deployment, archive, reset or stash occurred.
