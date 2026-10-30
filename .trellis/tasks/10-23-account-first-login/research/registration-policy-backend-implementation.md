# Registration username policy — backend implementation

## Scope and result

Changed only `server.js`, `tests/security.test.js` and this report against the root-owned `registration-policy-baseline.json`. The product/test files are frozen for independent review and aggregate validation. No frontend, shared fixture, model, import, external-provider, password-policy or API-config change was made.

The `/oauth2/register` handler now validates a nonblank explicitly supplied username against ASCII letters, digits, underscore and hyphen, with a 1–255-character boundary. It checks the raw supplied string against its trimmed value, so leading/trailing whitespace, including final CR/LF (which JavaScript `$` alone can overlook), cannot be silently accepted. Non-string supplied values are rejected; omitted/null/empty/whitespace-only usernames retain the existing email-as-username fallback.

Rejection returns HTTP 400 with `error: invalid_request`, `error_key: validation.username.invalid_format` and a readable Chinese description. Chinese display names remain valid. The generic User model and login/discovery paths remain unchanged, so already stored Unicode identifiers keep working.

## Validation order and fallback

The existing registration switch and CAPTCHA checks retain precedence. Invalid-email validation still runs before the new username rule. The existing `isValidEmail` already accepts only ASCII email addresses, which prevents non-ASCII fallback bypasses without adding a second email validator or broadening email support. An explicit valid username does not make an invalid Unicode email valid; it still gets `validation.email.invalid`.

The new guard runs before password/conflict feedback and before `verifyEmailCode`, account creation, registration logging, session or OAuth-code issuance. Invalid usernames neither consume email proof nor spend an email-code attempt. Existing endpoint HTTP throttling and CAPTCHA consumption retain their behavior. A corrected username can reuse the exact valid email code and complete the original OAuth continuation.

The existing effective password policy is untouched: `/api/auth/config` already reports `getPasswordMinLength()`, including its 12-character floor and administrator-configured longer value. Frontend presentation is handled by its separate owner.

## Added real API regressions

Seven tests were added to `tests/security.test.js`:

1. Successful real registration for one-character names, uppercase/digit/underscore/hyphen combinations and a 255-character name, with Unicode display names and verified mailboxes preserved.
2. Nineteen invalid usernames (Chinese/fullwidth characters, internal and edge whitespace, CR/LF, punctuation, explicit email-shaped names, 256 characters and non-string values). Each leaves users, sessions, auth codes, access/refresh tokens and login logs empty; the seeded proof remains at zero attempts/unconsumed, with no new mail. Correcting to a valid name consumes that same proof and completes a real OAuth registration with one session/code.
3. Omitted, empty, whitespace-only and null usernames preserve the ASCII email fallback.
4. Non-ASCII local/domain email values cannot bypass the existing email check, whether the username is omitted, blank or valid explicit ASCII.
5. Disabled registration and missing/valid CAPTCHA preserve precedence. The existing missing image CAPTCHA result is `captcha.expired`; invalid usernames after a valid CAPTCHA still leave the email proof untouched.
6. Default minimum 12 and configured minimum 16 match both public auth-config surfaces and real registration: six-character and one-below-minimum passwords fail with the actual numeric policy, while a password exactly at the configured minimum succeeds using the same unconsumed proof.
7. A seeded legacy Unicode username still discovers the password step and logs in successfully with its verified mailbox, confirming that registration policy was not placed in the shared model/authentication paths.

## Checks and evidence

- `node --check server.js`: passed.
- `node --check tests/security.test.js`: passed.
- `node --test --test-timeout=45000 tests/security.test.js`: **40/40 passed** (seven added; all existing security regressions retained).
- Focused log: `.artifacts/registration-policy/security-focused.log`.

The first run passed 39/40 because the new CAPTCHA-precedence test expected `captcha.required`, whereas the existing image CAPTCHA path returns `captcha.expired` when no challenge ID exists. The assertion was aligned with the unchanged endpoint behavior; the final full focused run passed. Root owns independent combined review and final aggregates. No commit, staging, reset, push, deployment, archive or live-data operation occurred.

## Limits and follow-up

These tests use the existing isolated memory database and captured SMTP fixture; no real user accounts or mail were touched. Import/provider behavior was preserved by limiting the new rule to the registration handler; their complete regression suites remain root-owned. Optional ASCII email-as-username behavior remains an intentional compatibility exception to the explicit username character set.
