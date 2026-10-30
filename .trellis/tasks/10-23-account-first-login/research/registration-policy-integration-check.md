# Registration policy — independent integration check

Reviewer: `/root/check_user_sort` (`trellis-check`). Task: `10-23-account-first-login`.
Authority: `research/registration-policy-contract.md`, AC15/AC16, and the exact snapshots in
`registration-policy-baseline.json` (`registration-policy-followup-3lvpescd`).

Status: **combined frontend/backend review complete; no actionable findings**. Both owners froze
their product/test files before final source review. No owner product/test files were edited.

## Findings (fixed)

- `.trellis/spec/frontend/auth-feedback.md`: changed ambiguous "empty-email fallback" wording to
  "email fallback when the username is blank". The implementation falls back only when the optional
  username is blank; an empty email remains an existing validation error. Root was notified before
  the mechanical documentation edit. No product/test change was required.

## Findings (not fixed)

None. Root owns spec/task synchronization and final aggregate evidence; those are not product
defects or incomplete work assigned to this reviewer.

## Frontend delta and behavior

Compared the frontend owner's eight files to the exact pre-follow-up snapshots:

- Login JS changes only unknown initial policy state, dynamic guidance rendering after config/language
  refresh, and raw explicit registration-username validation. The previous mobile Turnstile helper,
  discovery/unknown-account/setup transitions and credential submission paths are otherwise preserved.
- Profile JS adds the same public-config fetch and presentation update for the existing password
  modal; profile authentication, credential mutation, identities and other form behavior are untouched.
- Shared i18n adds a small presentation helper, neutral/numeric prompts and username hints in all
  three locales. It removes the stale six-character promises from old placeholder/profile/error keys.
- Login/profile templates provide neutral fallback text and accessible descriptions; affected auth
  pair/profile shared-i18n and page-script references use `20261024-registration-policy-1`. Auth CSS
  and MFA JS versions remain intact. The MFA template delta is the shared-i18n reference only.

`passwordGuidance` accepts only raw integer values 12–64, matching the pre-existing administrator and
environment-setting bounds. It neither coerces a numeric string nor reproduces server password
acceptance rules. Before configuration is available, at each config reload and after failed/malformed
configuration, the new-password fields show localized neutral text. A valid response updates register,
first-password setup, recovery and profile placeholders, plus the profile's persistent accessible hint.

The page render functions reapply dynamic guidance after ordinary i18n rendering, so language changes
retain the effective value. Ordinary login remains a current-password field without a new minimum.
No `minlength`, password-content check or acceptance bypass was added. Existing readable server
password descriptions remain authoritative: known legacy length keys prefer readable server details,
and fall back to neutral localized text if details are absent/machine identifiers.

Browser username validation reads the unmodified field value. Nonblank values must match
`^[A-Za-z0-9_-]{1,255}$`; whitespace-only values retain the existing backend email fallback.
It renders the localized error in the active status region without trimming/sanitizing the username
or changing the display-name field. Visible guidance explains both the character set and optional
email fallback. No generic model, imported identifier or login/discovery validator was changed here.

## Frontend test validity and evidence

The browser delta is additive: previous login/register/recovery feedback scenarios remain unchanged.
The four principal cases set real fixture `password_min_length` values 12/16 at desktop 1440 and
mobile 390, read the real auth-config response, walk setup/recovery/register/profile, and check three
locales. A one-character-short password reaches and is rejected by the real server. Chinese username
submissions then yield localized feedback without a POST, followed by successful ASCII-username
registration using the same email proof and a preserved Chinese display name.

Only uncertainty cases replace config transport: delayed, HTTP 503 and malformed values on both auth
and profile. The delayed response transitions neutral -> valid 16; a subsequent unavailable refresh
returns to neutral. This is accurately separated from real configured-policy evidence in source and
`browser-evidence.json`. Active feedback bounds, no horizontal overflow and page-error checks remain.

The i18n test additions cover 12/16/64, invalid raw types/ranges, neutral legacy keys without stray
interpolation markers, localized username guidance, readable dynamic error descriptions and neutral
fallbacks. Existing message fallback tests are preserved.

Read `.artifacts/registration-policy/browser-check.log`, `browser-evidence.json` and the frontend
implementation report: focused browser PASS and i18n **15/15 PASS** are owner execution evidence.
No duplicate reviewer browser/unit/aggregate run was performed.

## Backend delta and behavior

Compared the complete `server.js` and security-test delta to the exact pre-follow-up snapshots.
The sole server behavior change is inside `/oauth2/register`: retain the raw supplied username,
derive the existing normalized fallback, and reject non-string or nonblank invalid explicit names.
The generic User model, import, discovery, password login, provider creation, password policy and
public auth-config implementations are untouched by this delta.

The guard compares the raw nonblank string with its normalized value before testing the ASCII
character set. This rejects leading/trailing whitespace, including final LF, CR and CRLF that a
JavaScript `$` anchor alone could permit. Omitted/null/empty/whitespace-only values intentionally
retain the ASCII-email fallback. Existing email validation precedes the new guard, so invalid
non-ASCII local/domain emails retain `validation.email.invalid`, even with an explicit valid name.

Registration-enabled and CAPTCHA checks retain precedence. The new guard executes before
password/conflict feedback, `verifyEmailCode`, user creation, registration logging, session creation
or OAuth-code issuance. Computing the existing password-policy error before the guard is read-only.
Invalid usernames therefore cannot consume a mailbox proof or its attempt counter, create
credentials, or issue mail. Existing CAPTCHA consumption and HTTP throttling are unchanged.

Reviewed all seven added real API cases: allowed one-character and 255-character ASCII names;
19 invalid raw/type cases including LF/CR/CRLF; absent/empty/blank/null email fallback; non-ASCII
email precedence; registration/CAPTCHA precedence; unchanged default 12/configured 16 acceptance;
and legacy Unicode discovery/login. Invalid-name cases inspect proof attempts/consumption, mail,
users, sessions, OAuth codes, access/refresh tokens and login logs, then correct the username and
successfully reuse the same proof. Chinese display names remain intact. Compatibility follows from
the registration-only delta and the real legacy Unicode test; complete import/provider regression
coverage remains part of root's aggregate run, rather than a claimed new focused API case.

## Single-line browser/API boundary

The registration username is an actual `input type="text"`. A tiny isolated Chrome DOM probe
confirmed assigning `valid\n`, `valid\r` or `valid\r\n` yields the single-line value `valid` before
the frontend reads it; leading/trailing spaces and Chinese remain unchanged and fail its ASCII
regex. This probe launches no fixture server and submits nothing. It explains the frontend's `$`
anchor without implying that direct forged API values are trusted: the backend raw/normalized
comparison and actual API LF/CR/CRLF regressions independently reject those original raw values.

## Backend test evidence

Read the backend implementation report and final `.artifacts/registration-policy/security-focused.log`:
**40/40 PASS**, with zero failed/skipped/cancelled. The seven new tests preserve the earlier
security scenarios. Reviewer also ran `node --check` on both backend files, exit 0. No duplicate
reviewer security or aggregate run was performed.

## Verification

- Lint: not applicable as a standalone command; no lint script configured.
- TypeCheck: not applicable as a standalone command; no type-check script configured.
- Reviewer `node --check`: auth login JS, account profile JS, shared i18n, auth-feedback browser test
  and i18n test, plus `server.js` and `tests/security.test.js` — all seven pass (exit 0).
- Owner frontend checks: focused browser PASS, i18n 15/15 PASS, scoped whitespace check PASS.
- Owner backend focused security: 40/40 PASS, including seven added cases; source/test review clean.
- Reviewer isolated single-line input probe: PASS (six values, real Chrome DOM).
- Root final syntax/API/browser aggregates: root-owned; not executed by this reviewer.
- No product/test mutations, commit, push, deployment or archive by this reviewer.

## Documentation follow-up review

Reviewed the newly added `.trellis/spec/backend/registration-policy.md`, both backend/frontend
index entries, the registration additions in `.trellis/spec/frontend/auth-feedback.md`, and the
registration/auth-config additions in `views/docs/api.html` against the already reviewed source.
The one mechanical fallback wording issue above was corrected; no unresolved documentation
finding remains. Earlier unrelated document content was preserved.

- Backend and frontend index entries point to the same actual registration spec and accurately
  describe its scope. Relative links resolve from their respective directories.
- The spec explicitly preserves omitted/null/empty/whitespace-only username fallback, requires
  nonblank raw input equality before the ASCII regex, and records final CR/LF/CRLF API coverage and
  HTML single-line input sanitization without claiming the browser protects the API.
- It keeps email-error, registration-switch and CAPTCHA precedence and explains that invalid
  usernames preserve mailbox proof, not an already consumed CAPTCHA. Throttling is unchanged.
- Guidance accepts only raw integer values 12–64, stays neutral while unavailable/malformed and
  after a new failed load, and reapplies after language changes. Actual server policy, configurable
  bounds/default and existing readable error descriptions remain authoritative.
- Registration-only scope, Unicode display names and stored/imported Unicode identifiers are
  documented separately; the new rule is not assigned to models/import/providers/login.
- The public API documentation accurately states the auth-config field, default/configured
  minimum, username character/length rule, optional fallback, exact error key and proof/error
  precedence. It describes policy guidance without adding an acceptance validator or endpoint.

No tests or aggregate checks were rerun for this documentation-only follow-up. Root's ongoing
aggregate verification and final task/spec synchronization remain root-owned.
