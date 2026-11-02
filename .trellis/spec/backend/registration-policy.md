# Registration Policy and Password Guidance

## 1. Scope / Trigger

Applies to public registration and the existing public password-policy projection. Restrict explicit new registration usernames at the registration boundary, while keeping existing/imported Unicode identifiers, provider-created accounts and Unicode display names compatible. New-password guidance must follow the server configuration rather than promise six characters. The QFLI client policy below additionally closes every email-based new-account path for one client family only.

## 2. Signatures

- `GET /api/auth/config` (also `?surface=web`) returns the existing `passwordMinLength` JSON number alongside authentication settings, plus `registrationEnabled` and a new `registrationDisabledReason` string (`'oauth_only'` or `''`). The login page forwards its OAuth `client_id` as a query parameter so the server can apply the client-scoped policy.
- `POST /oauth2/register` accepts the existing `username?`, `name?`, `email`, `password`, `confirm_password?`, `email_code`/`verification_code`, CAPTCHA and OAuth fields. This policy adds no endpoint or request field.
- `POST /api/email-verification/send` keeps its existing body and semantics; a registration-purpose request from a QFLI client is refused before any code is minted or mail is sent.
- `isQfliClient(candidate)` is exported from `services/qfli-integration.js` and accepts a `client_id` string or a client record with an `id`. It is the single source of truth for the QFLI client family.
- `getPasswordMinLength()` reads `password_min_length` with a 12-character floor. Supported administrator values and `PASSWORD_MIN_LENGTH` are integers from 12 through 64; the environment fallback is 12.
- `VaultI18n.passwordGuidance(rawMinimum)` returns localized numeric guidance for raw integers 12–64 and neutral new-password guidance otherwise.

## 3. Contracts

An explicitly supplied nonblank registration username must be a string of 1–255 ASCII letters, digits or underscores (`[A-Za-z0-9_]`); hyphens are invalid. Validate the original string: leading/trailing/internal whitespace, Chinese/fullwidth characters, punctuation and explicit email-shaped usernames are invalid. Do not silently trim or sanitize an invalid explicit API name into validity. Omitted, null, empty and whitespace-only usernames intentionally retain the existing normalized ASCII-email fallback. The existing email validator runs first and rejects non-ASCII email; do not duplicate or relax it to accommodate fallback.

The registration browser field actively filters unsupported characters during editing and caps the committed value at 255 characters. Preserve case, caret/selection and deletion; defer normalization until IME composition commits and prevent submission during composition. Keep native field constraints and a strict raw submit guard for programmatic values that bypass editing events. This browser behavior does not authorize server-side sanitization or constrain login account entry.

Keep this rule inside `/oauth2/register`, before mailbox-proof verification/attempt consumption and account/session/code creation. Do not add it to `User.create`, import, providers, discovery or credential login. Chinese display names remain accepted. Registration switch, CAPTCHA consumption and HTTP throttling retain their existing semantics and precedence; invalid username feedback does not imply a reusable CAPTCHA.

The server remains authoritative for password length, common-password, optional mixed-character and 72-byte bcrypt limits. The browser uses the existing config value only for guidance in registration, first-password setup, recovery and the profile password modal. Start each config load with neutral localized guidance and retain it on transport failure or malformed values; do not coerce numeric strings. Reapply loaded guidance after language changes. Do not impose a new minimum on ordinary current-password login or add a competing browser policy validator.

Known legacy length error keys must preserve readable server descriptions containing the actual minimum. Without a readable description, use neutral localized text rather than a guessed number or unresolved interpolation token. Keep zh/en/zh-TW text and affected page/shared-script cache references synchronized.

### Client-scoped email registration closure (QFLI)

A QFLI client is any client whose `client_id` begins with `qfli`, case-insensitively (`isQfliClient`). For those clients, new accounts may only be created through a Huawei account; every path that can create a new account from an email address is closed:

- `POST /oauth2/register` returns `403 { error: 'forbidden', error_key: 'auth.registration.oauth_only' }` before CAPTCHA consumption, email-proof verification/attempt counting and any account/session/code creation.
- `POST /api/email-verification/send` with `purpose: 'register'` returns the same 403 before the code row is created or mail is sent. The check runs before the existing duplicate-email branch so it cannot be used to enumerate registered addresses. Account-bound `password_reset` sends, login-gate codes and email-change codes are unchanged.
- OIDC/passwordless provider callbacks (`findOrCreateOidcUser`) refuse to create a new account when the escalation context is a QFLI client or the provider configuration's own `clientId` is one. The gateway client context comes from the `client_id` query parameter on `/api/v1/auth/oauth/oidc/login`, persisted in the signed state cookie; the provider's configured `clientId` is a fallback so a misconfigured QFLI provider cannot silently email-sign-up users. Existing identities may still be matched and linked normally.
- `GET /api/auth/config` reports `registrationEnabled: false` and `registrationDisabledReason: 'oauth_only'`; the login page hides the registration tab, blocks `setMode('register')`, and shows the localized `auth.registration.oauth_only` notice.

Client identification reads `client_id` from the request body, the `client_id` query parameter, and HTTP Basic client authentication. A value matches when either the literal string or the stored client record carries the prefix. Requests with no client context, and requests for any other client, keep exactly the previous behavior. The policy is orthogonal to the administrator's global `registration_enabled` switch: that switch still applies globally and is reported with an empty `registrationDisabledReason`.

Do not move this rule into `User.create`, the import path, Huawei quick-login account creation or credential login: Huawei account creation remains the sanctioned path for QFLI clients.

## 4. Validation & Error Matrix

| Condition | Result / side effects |
| --- | --- |
| Registration disabled or CAPTCHA invalid | Existing error takes precedence; no new bypass |
| Missing/invalid email, including non-ASCII fallback input | 400 `invalid_request`, `validation.email.invalid`, before username feedback |
| Invalid nonblank explicit username or non-string non-null value | 400 `invalid_request`, `validation.username.invalid_format`, readable description |
| Omitted/null/empty/whitespace-only username and valid ASCII email | Existing email-as-username default; other registration checks still apply |
| Password below effective minimum | Existing 400 `validation.password.weak` with the actual numeric server description |
| Username rejected with valid registration email proof | Proof remains unconsumed with unchanged attempt count; no user/session/auth code/token/login log or new mail |
| Config pending, unavailable or malformed | Neutral localized guidance; server validation still applies |
| Valid config 12 or 16, including after language change | Matching numeric guidance before submit on every new-password surface |
| Stored/imported Unicode or hyphenated username used for discovery/login | Existing authentication semantics; new registration rule does not apply |
| Registration typing/paste/committed IME includes unsupported characters | Browser keeps only ASCII letters/digits/underscore, up to 255; unfinished composition is untouched |
| QFLI client posts to `/oauth2/register` (body, query or Basic `client_id`) | 403 `invalid_request`-free `forbidden`/`auth.registration.oauth_only`; no CAPTCHA consumed, no proof attempt, no user/session/code/log |
| QFLI client requests a `register` email code | 403 `auth.registration.oauth_only` before code creation or mail delivery; duplicate-email check not reached |
| QFLI client triggers OIDC callback for an unknown subject | Redirect with `oidc_error=login_failed`; no user or identity created |
| Other client or no `client_id` | Unchanged behavior on every path above |
| QFLI client asks `/api/auth/config` | `registrationEnabled: false`, `registrationDisabledReason: 'oauth_only'`; other config fields untouched |
| QFLI client with an existing bound identity signs in via OIDC | Existing account is matched and logged in; only creation is blocked |

## 5. Good / Base / Bad Cases

- Good: an `Alice_1_test` registration with display name `中文显示名`; a Chinese or hyphenated explicit API username fails before consuming proof, and correcting it permits reuse of the same valid email code.
- Base: an absent username defaults to `alice@example.com`; explicitly supplying that same email-shaped username fails the new character rule.
- Bad: trim `"alice\n"` and accept it, put the rule in a shared model, or hard-code another password minimum in a template.
- Good (client policy): a QFLI client registration attempt is refused with `auth.registration.oauth_only` while a parallel request for another client still completes normally with the same email proof untouched.
- Bad (client policy): rejecting registration only in `POST /oauth2/register` while `POST /api/email-verification/send` still mails codes, or keying the rule on a client display name rather than `client_id`.

## 6. Tests Required

- `tests/security.test.js`: actual API acceptance at 1/255 characters; raw/type/256-character failures including hyphens and final LF/CR/CRLF; optional ASCII-email fallback; non-ASCII email precedence; unchanged switch/CAPTCHA precedence; no invalid-name proof/credential mutations; correction with the same proof; default 12/configured 16 policy; legacy Unicode/hyphenated discovery and login.
- `tests/i18n.test.js`: supported locale interpolation, 12/16/64 and malformed raw minimums, neutral legacy strings, readable dynamic server errors and localized username rules.
- `tests/auth-feedback-browser.cjs`: real settings 12/16 at desktop/mobile, all four new-password surfaces, three-language rerender, min-minus-one server rejection, active username typing/paste/caret/replacement/deletion/length filtering, controlled composition and no submit during composition, strict raw bypass blocked without a POST, and real ASCII registration with Unicode display name. Verify login preserves email, Unicode and old hyphenated identifiers. Separate dispatched composition probes and delayed/failed/malformed transport simulations from actual OS IME and real configured-policy cases.
- Full syntax, API and browser gates preserve imports, external providers, password login, mailbox/MFA ordering, OAuth continuation and mobile CAPTCHA geometry. Use isolated fixtures and captured mail rather than production accounts.
- `tests/qfli-registration.test.js`: `isQfliClient` boundary/case-sensitivity and record form; QFLI registration-code refusal with zero mail and zero code rows including upper-case ids and Basic auth; `/oauth2/register` refusal before CAPTCHA/proof consumption with no user/session/code/log; unchanged registration for another client and for no client; `/api/auth/config` reporting for QFLI, upper-case QFLI, a prefixed client record, another client, anonymous, and the global switch; OIDC callback refusal for a QFLI client versus successful creation for another client and anonymous; existing-identity login still allowed.
- `tests/auth-feedback-browser.cjs` (`checkQfliRegistrationEntry`): real `/oauth2/authorize` requests for anonymous, QFLI and unrelated clients at desktop and mobile widths; assert the hidden tab, the collapsed register card, the visible `auth.registration.oauth_only` notice and that a forced `setMode('register')` falls back to the login card, while other clients still open registration.

## 7. Wrong vs Correct

Wrong: a JavaScript `^[A-Za-z0-9_]{1,255}$` test alone accepts a final newline because `$` can match before it; normalizing an API value before testing hides the invalid input.

Correct: preserve the raw supplied username, allow only the intentional blank fallback, require nonblank raw input to equal its normalized form, then check the ASCII set and length. Keep direct API LF/CR/CRLF regressions even though an HTML single-line input removes line breaks before page JavaScript reads it.

Wrong: show “At least 6 characters” or replace it with an unconditional “12”.

Correct: render `passwordGuidance(config.passwordMinLength)` after loading and language changes, with a neutral localized prompt whenever the effective value is unknown.

Wrong: close QFLI email signups only at the visible form, or compare a client's display `name`/`providerName`.

Correct: keep the single `isQfliClient` predicate in `services/qfli-integration.js`, apply it at every account-creation boundary (`/oauth2/register`, the register email-code send, OIDC account creation) and at `/api/auth/config`, and leave every non-QFLI request path byte-for-byte unchanged.
