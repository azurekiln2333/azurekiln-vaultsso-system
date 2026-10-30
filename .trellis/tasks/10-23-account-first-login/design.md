# Account-First Login Design

## Admin user-list sorting follow-up

The complete `/api/users` list is already loaded in the admin page. Sort a filtered copy in the frontend, retaining initial response order until a user selects one of the eight data headers. Use semantic keyboard-accessible buttons, `aria-sort` and visible direction indicators, natural text/date/status comparison, missing raw values last in both directions and stable ties. Mailbox state is a distinct ordered category: unbound, unverified, verified ascending. Retain the choice through in-page filtering/refresh/updates. No server sorting query, database migration, persistent preference or generic table framework is required. Product/test ownership and precise boundaries are in `research/users-sort-contract.md`.

## Mobile Turnstile follow-up

The user reported a narrow/tall phone widget. The existing viewport cutoff forces `compact` below 380px (150×140), while the default horizontal widget requires at least 300px; existing page/card padding also leaves some mobile form containers narrower than that. Use the actual host width to choose a supported size, provide sufficient form width at ordinary phone widths and retain an appropriate fallback for genuinely narrow containers. Do not stretch/scale a cross-origin iframe. Keep token clearing and widget lifecycle safe when the active form or supported size changes. Scope is login rendering/CSS, affected cache references and realistic browser geometry tests; backend verification policy is unchanged. Record the precise implementation boundary in `research/mobile-turnstile-contract.md` before product edits.

## Flow and Boundaries

### Registration username editing follow-up

The user's correction requires filtering during input, superseding the earlier submit-only UI rule and hyphen allowance. Limit only the registration field to ASCII letters/digits/underscore, preserve IME composition until committed, caret/editing and optional blank fallback, and keep strict raw submit/API validation. Align localized guidance and existing tests without imposing this rule on login or stored/imported identities. Exact scope and ownership are in `research/username-input-contract.md`.

### Icon-font loading follow-up

All current templates share Material Symbols ligature text and base CSS. Hide icon glyphs in a compact reserved slot before the actual face is loaded, then reveal through one packaged shared helper after successful font-face loading. Loading failure remains hidden while labels/actions remain available. Gate styling must live in packaged base CSS because the deployment archive intentionally excludes separately supplied font assets. Preserve dynamic icons, per-page sizes/colors, authentication behavior and CSP. Exact scope/ownership and delayed/failed/cached browser checks are in `research/icon-font-loading-contract.md`.

### Registration guidance and identifier follow-up

The existing public auth config already projects the effective server `passwordMinLength`; use it for new-password guidance instead of the static six-character placeholder. Apply the loaded value to registration, setup, recovery and profile fields, retain neutral guidance before valid configuration and after failure, and rerender it after language changes. Do not lower password policy or add a competing browser security policy. Clear legacy six-character strings without substituting another hard-coded promise.

The initial registration follow-up enforced ASCII letters/digits/underscore/hyphen at the existing 255-character account boundary. R19 supersedes that set with ASCII letters/digits/underscore and adds active browser input filtering as described above. Keep email fallback when username is blank and reject non-ASCII fallback; display names remain Unicode. Validate the original API value on the server before email-proof consumption and retain a strict raw frontend submit guard. Existing stored usernames, login/discovery, import and external-provider creation remain compatible. See `research/registration-policy-contract.md` for the historical checkpoint and `research/username-input-contract.md` for the current correction.

The shared web page begins with account entry. Continue performs server-side discovery and selects a step or shows missing-account feedback:

| Outcome | UI |
| --- | --- |
| Identifier has zero username/email matches | Show localized “账号不存在”; stay on editable account entry with password hidden/disabled. |
| Password exists, or an existing identifier is ambiguous | Enter password; run existing final login and required CAPTCHA/MFA. Ambiguity selects no account. |
| No password and a usable stored email | Show masked email, explicit Send code, email code, new password, and confirmation. |
| No password and no usable stored email | Display “请联系管理员重置” with a way to return and change account. |

Successful first-password setup returns to the password step for the same entered identifier, with the password field cleared and visible confirmation. Login still uses the existing final credential/MFA path. No setup step issues authentication credentials.

Ordinary forgot-password recovery remains a separate existing email-based flow. Existing third-party login and profile capabilities remain unchanged. User-import duplicate detection was initially read-only research. The subsequent real 97KB upload failure explicitly adds the bounded file-transfer correction documented in `research/import-upload-contract.md`.

## API Contracts

### Account discovery

Extend `POST /oauth2/authorize` with a strictly selected JSON branch:

```json
{ "discover_account": true, "username": "entered account", "client_id": "optional original OAuth client", "redirect_uri": "optional original redirect" }
```

The browser sends JSON so the boolean is not confused with a form-encoded string. Carry the applicable original OAuth parameters, omitting PKCE fields that were absent. Select this branch before the existing required-password guard; do not relax that guard for normal requests or `check_verification`.

Normalize the username before selecting discovery, and enforce its nonempty/length validation within that branch. Keep the combined username/password guard unchanged for all other requests. Retain HTTP/IP throttling and use the existing `login:${user?.id || username.toLowerCase()}` lock-key derivation with `RateLimit.check`, without consuming a password attempt. Apply registered OAuth validation when requested and preserve the current banned/locked error behavior. Successful branch responses are:

```json
{ "next": "password" }
{ "next": "set_password", "email_masked": "al***@example.com" }
{ "next": "contact_admin" }
```

The user's later explicit choice supersedes the original uniform response for unknown identifiers. After lock/ban and requested OAuth validation, zero matches return HTTP 404 `{error:"account_not_found",error_key:"auth.account_not_found",error_description:"账号不存在"}`, with no `next`, destination or account metadata. `findByUsername` conflates zero and multiple matches as null; only after that null result, use existing `findPotentialConflicts(username, username)` to distinguish zero matches. Existing ambiguous identifiers retain `password` without selecting an account. Normal credentials/native probes and generic unknown recovery responses keep their existing contracts. Discovery sends no mail and creates no cookie, token, pending challenge, session, or authorization code, and consumes no password attempt. Existing HTTP rate-limit bookkeeping still applies. See `research/unknown-account-contract.md`.

### Explicit code sending

Extend `POST /api/email-verification/send` with:

```json
{ "username": "entered account", "purpose": "password_reset" }
```

`username` and the existing `email` input are mutually exclusive. The new variant is restricted to `password_reset` and accounts without a local password. Resolve the account and its current stored email on the server; reject invalid/placeholder destinations. Reuse existing masking, code issuance, user binding, cooldown, delivery-failure behavior, and HTTP rate limits. Preserve the generic unknown-account response and the old email-based registration/reset contracts. State changes that invalidate setup return a specific localized conflict/refresh response, without sending mail.

### First-password submission

Extend `POST /api/password-reset` with:

```json
{ "username": "entered account", "email_code": "123456", "password": "new password", "confirm_password": "new password" }
```

Again reject simultaneous `username` and `email`. Re-resolve the account and usable email, validate the password policy/confirmation, and verify the existing `password_reset` code with the resolved `userId`. Prior discovery is not proof and is not required. Missing/invalid/reused/other-account proof cannot write a password.

The new variant only fills an unset password. Add a minimal conditional User-model update bound to both the resolved user ID and the exact email whose code was verified (`WHERE id = ? AND email = ? AND (password IS NULL OR password = '')`). Write the password and verified-email flag together. This prevents a concurrent administrator/profile/password or email change from being overwritten or a different mailbox being marked verified by stale setup. Return actual affected-row success. On zero affected rows, return a localized state-changed conflict before revoking sessions/tokens so the browser can rediscover the account. Hash passwords through the existing bcrypt mechanism. On success, preserve existing session/token revocation. Old email-based recovery remains a general password reset with its current semantics.

No new discovery token, credential purpose, schema migration, or email-code model refactor is needed.

## Frontend Structure and State

- Keep the original `loginForm`, username/password elements, and OAuth hidden inputs. Use account/password sections and one persistent primary submit whose label/action depends on the current step. Account submission has an explicit JSON discovery handler; do not run a discovery response through the existing credential-success handler. Keep the password field disabled and not required during account entry; restore both properties before displaying/focusing it for password entry.
- Add a sibling first-password form and a contact-administrator section inside the existing `data-card="login"`. The contact section is not a new card and does not require a submit button. Avoid nested forms or duplicate password names in a single submitted payload. Ordinary `recoverForm` keeps its email contract.
- Keep account selection in memory; setup sends only that identifier and the entered proof/password. Display the masked address as text, without an email input or browser storage containing a server-returned raw email.
- Put visible feedback next to the active step/form, including errors, sending/cooldown, and setup success. Do not rely on the first `.submit` within the outer card; handle the contact panel without assuming a submit button exists.
- Increment a request revision on account edits, back/step/mode changes, and use it to ignore stale discovery/send/reset responses. Clear setup code/password/confirmation, masked destination, and timers when changing accounts.
- Preserve static password inputs with appropriate username/current-password/new-password autocomplete. Hidden inactive controls must not block browser validation or leak duplicate values into requests.
- Only show/render/refetch login CAPTCHA on the password step when the current policy requires it. Preserve Turnstile reset/one-time-token behavior and final-login anomaly handling.
- Re-entering the login card from register/recovery starts at account entry and clears all prior setup state. Setup-success returns directly to the password substep rather than using a generic mode reset. Switching cards hides the setup/contact panels and reanchors the shared feedback element.
- Replace the legacy `auth.password.not_set` recovery jump with rediscovery/setup routing that preserves the account and OAuth context. Do not call `loginForm.reset()` merely to change steps; this is especially important for account/password controls and any fields whose reset behavior depends on their type.
- Keep MFA navigation and OAuth state/nonce/PKCE handoff. Setting the first password must not reset or lose the original OAuth fields.
- Add translations to every supported locale and reuse existing compact layout styles. Increment affected asset query versions.

## Compatibility and Rollout

### Subsequently authorized post-password mailbox gate

The user explicitly requires password-bearing accounts without a usable mailbox to bind and verify one after password proof, and accounts with an unverified stored mailbox to verify it after password proof. This supersedes the earlier assumption that an imported password-bearing unbound account can finish password-only login. Passwordless initial setup/contact-admin rules remain unchanged. The user explicitly retained the global `login_email_code` switch: verified accounts still perform its existing login factor, with TOTP preference preserved. If a mandatory mailbox proof is needed, one successful code also satisfies the email factor for that login.

Ordering: correct password and required CAPTCHA, then configured TOTP/recovery, then required mailbox bind/verification, then final credentials and original OAuth continuation. Discovery continues returning the password step for all password-bearing accounts and sends no mail. Reuse pending login state and the existing account lifecycle transaction; never authorize the binding through an anonymous username or an incomplete MFA proof. New mailbox stages use explicit sending. Codes must bind to exact pending challenge, user, stage and destination, with single-use consumption, state recheck, conditional mailbox write and final credentials in one account transaction. SMTP runs outside that transaction. Verification status joins the pending security snapshot; existing email/password/role/ban/phone/TOTP bindings remain. Freeze exact APIs and stage transitions in `research/login-email-gate-contract.md` after focused source/security review.

Verified-mailbox password clients retain existing behavior and the global email-code switch. Password clients with incomplete mailbox state must follow the new pending stages; clients that do not support them fail closed without credentials. Native `check_verification` reports the gate without granting binding authority. Email registration/reset and external-provider login retain their existing contracts. New discovery is opt-in. Serve backend support before or alongside the changed web assets. There is no database migration. Preserve unrelated admin/MFA work in any rollback.

The frozen HTTP, persisted proof, atomic transition and UI contract is `research/login-email-gate-contract.md`, reviewed against `research/login-email-gate-design-review.md`. The four Pi workers are implementing that contract, which overrides provisional options in their research reports.

Showing the requested masked destination reveals passwordless-account state. The user also explicitly authorized missing-account discovery feedback; reuse existing HTTP throttling and preserve lock/OAuth precedence. Delivery still depends on the deployed SMTP configuration; format validation cannot establish mailbox deliverability.

## Verification

### Complete-file import correction

The import transport correction also removes the legacy fixed 200-record guard. The user's reported 1500-plus-user file is an example workload, not a replacement maximum. Both file and pasted requests remain bounded by 10MiB and use the current parser and sequential importer. Preserve normalization, existing-account and within-file duplicate checks, per-row reasons, authorization, origin protection, and ordinary endpoint limits. UI copy describes the size bound and duplicate skips, without a numeric row cap. Validate an actual upload exceeding 2000 records and a duplicate reimport; use empty-password fixtures to avoid irrelevant bcrypt cost. No queue or database migration is introduced.

### Optional import mailbox

The user explicitly confirmed that no bound email must not prevent import. Accept a nonempty username with an omitted, null, blank or whitespace email. Preserve username-from-email fallback when a real valid email exists; skip missing both identifiers. A nonempty malformed email remains an individual invalid row. The existing schema has `email NOT NULL UNIQUE`, so use the established synthetic-mailbox convention: missing emails are stored as `import-${sha256(lowercaseNormalizedUsername).slice(0, 24)}@users.invalid`. This deterministic internal marker avoids collisions between different username-only rows, supports stable duplicate/reimport checks, and represents an unbound mailbox. It is never marked verified, regardless of imported `ischeck`; existing synthetic input addresses are also unverified. No schema migration or real email is invented.

Admin list and import guidance present these accounts as “未绑定邮箱”, without presenting the storage marker as a bound address. Reuse the existing passwordless discovery/send/setup synthetic-email guard: login discovery returns `contact_admin`, no send action is offered, and setup/send requests cannot send mail or reset credentials. An imported account with a password uses the normal password step. Validate the actual import-to-login path rather than only seeding an already-passwordless account.

### Inspectable import results

Preserve `createdCount`, `skippedCount`, `created` and human-readable skip `reason`. Add `importedWithoutEmail: [{ row, username }]` for successfully created missing/synthetic-email accounts; the row is the original one-based input position. Add `reason_code` to skipped entries: `duplicate_identity`, `duplicate_username`, `duplicate_email`, `duplicate_external_identity`, `invalid_email`, `missing_username`, `invalid_password`, `invalid_description`, or `invalid_credits`. Duplicate codes form one duplicate group; invalid-email rows form a separate group; all remaining skipped rows form other errors. The no-email success list is its own group and never increases skippedCount. Each nonempty section displays its count, original row/account and applicable reason in a separately scrollable complete list. Escape all supplied values; keep readable legacy fallback for servers without codes, without inventing a classification.

The user's historical pasted log is classified as supplied into gitignored local artifacts. Preserve its input row numbers, case and Unicode; distinguish the four existing-account conflicts from the old combined mailbox error. Do not infer missing versus malformed from that old message or alter any live user data.

Use the isolated memory-DB/mail fixture and meaningful API plus browser tests listed in `implement.md`. In particular prove no discovery side effects, no cross-account code reuse, conditional-update conflict handling, stale browser-response rejection, and real OAuth/MFA continuation after the two-step UI.
