# Authentication Feedback

## 1. Scope / Trigger
Applies to login, registration, recovery and shared API message translation. The status must be readable and visible where the user submits a form.

## 2. Signatures
- `VaultI18n.resolveMessage(payload, fallbackKey, variables)` returns human-readable status text.
- `setMode(mode)` relocates `#statusMessage` immediately after the active `.submit` button.
- `setStatus(kind, message, revision)` announces and scrolls current feedback into view.
- `VaultI18n.passwordGuidance(rawMinimum)` presents the existing public `passwordMinLength` without duplicating password acceptance policy.

## 3. Contracts
- Prefer known `error_key` / `message_key` translations. Unknown keys fall back to readable `error_description` / `message`, then a known fallback or `common.request_error`.
- Retain dynamic password-policy descriptions; do not replace them with a hard-coded minimum length.
- Registration, first-password setup, recovery and profile new-password guidance use `/api/auth/config`'s raw integer `passwordMinLength` in the supported 12–64 range. Render neutral localized guidance before/at each load and after failed/malformed config, and reapply numeric guidance after language changes. Keep ordinary current-password login unrestricted by new-password length. Remove stale six-character promises, including legacy translation keys; known length errors prefer readable actual server descriptions.
- Public registration shows the optional username character/length rule and the email fallback when the username is blank. During typing, paste and committed IME input, retain only ASCII letters/digits/underscore (`[A-Za-z0-9_]`) up to 255 characters, preserving case, sensible caret/selection, replacement and deletion. Do not mutate unfinished composition or submit during composition. Include native field constraints; keep a strict raw submit guard before a POST for programmatic/autofill values that bypass editing events. Blank usernames retain the email fallback; direct whitespace-only API input keeps its existing fallback. Chinese display names and existing/imported Unicode, email and hyphenated login identifiers remain compatible. Follow [Registration Policy](../backend/registration-policy.md) for exact API/proof/CRLF boundaries.
- Never display unknown dotted keys or machine error codes as status text.
- Mode revision prevents a response from a previous form from writing to the current form. Feedback revision makes the most recent action own its status, even within one form. Older code-send responses cannot overwrite newer submit errors.
- Preserve successful authentication side effects independently of feedback ownership.
- Keep the empty `role=status` region in the accessibility tree without visible layout space. New feedback scrolls with `block: nearest`.
- The password form contains no email/TOTP code inputs. Successful credential submission with `mfa_url` clears password inputs and navigates to the same-origin `/oauth2/mfa` page, which displays factor-specific localized inputs and bottom feedback. Keep OAuth continuation in the server pending challenge; never store the password in browser storage or a URL.
- MFA's six slots are decorative `[data-code-slot]` elements with `aria-hidden`; `#code` is the only real, viewable input. Code mode uses text type, numeric input mode, a six-character limit, and `autocomplete="one-time-code"`. Both `input` and `change` events must mirror the entire committed value into the slots. Preserve native selection, keyboard editing, and paste. A complete six-digit TOTP/email value entered by typing, paste, or autofill automatically submits through the existing form handler once per completed edit; incomplete input never auto-submits. Do not normalize the live value or submit during IME composition; synchronize when composition ends.
- Give the disabled initial MFA input the recognizable name `verificationcode`, then use `totp_code` for authenticator challenges and `email_code` for email challenges. Do not simplify the TOTP name to `code`: Firefox 157 exposes an empty `input.autocomplete` property for the HTML token `one-time-code`, and Bitwarden 2026.9.0 reads that property before the HTML attribute. The explicit TOTP name lets its classifier recognize the field independently of browser token support. Keep the DOM ID `code` and the completion API body `{ code }`.
- `#recoveryToggle` appears only for TOTP challenges and switches the same input to visible text with name `recovery_code`, text input mode, a 32-character limit, and autocomplete off. Recovery codes always require manual submission, including six-character values. Changing entry mode clears the value and completion marker. Language changes preserve the value and refresh factor/mode-specific text and current feedback. Rendering or changing language/mode alone must not submit.
- Automatic and manual MFA submissions share the same synchronous request lock, fetch, feedback, and success-only continuation. Submission makes the input read-only and disables verify/mode switching. Paired `input`/`change` events, a pending request, navigation, or disabled/read-only state cannot create duplicate attempts. Retryable failures clear/refocus the input and permit a fresh completed edit, including re-entry of the same code. Terminal 401/429 failures disable the input and both buttons. Keep same-origin validation for pending login and successful continuation URLs; never navigate on a rejected code. Each automatic attempt uses the existing server attempt budget; do not add background retries.
- Login starts at account entry. The password input is disabled and not required until the password step. Continue sends JSON discovery with a boolean `discover_account: true`, preserving the original OAuth parameters and omitting absent PKCE fields. Discovery does not enter credential-success handling.
- The native `session_days` select offers exactly 1/7/14 days, initially 1. Preserve its value across account/password steps and language rendering, and submit it with credentials. Update local provider anchors after hydration and every selection change so keyboard activation and open-in-new-tab use the same choice. The server retains the original choice through verification; follow [Session Duration](../backend/session-duration.md) for the fixed deadline and legacy/replacement rules.
- A genuine zero-match discovery returns 404 `auth.account_not_found`. Resolve the key to “账号不存在” / “Account does not exist” / “帳號不存在”, remain on editable account entry with the password hidden/disabled, and restore Continue so the user can correct the identifier. Do not start mail, pending or credential requests. Ambiguous existing identifiers retain the password step; lock/OAuth errors retain precedence. General recovery keeps its generic unknown-account response.
- Passwordless accounts show a masked stored email, an explicit send-code button and a sibling first-password form. Do not send a code on discovery, require a retyped email, or authenticate after setup; successful setup clears setup secrets and returns to password entry. Without usable email, show the contact-administrator section inside the login card. Its feedback anchor must remain visible without a submit button.
- Changing accounts, returning from recovery/registration or navigating back invalidates pending discovery/send/setup responses and clears setup secrets, masked email and timers. Account edits return to account entry. Use a synchronous busy lock for duplicate attempts and separate feedback ownership so an older send response cannot replace newer setup feedback. A stale finalizer must not unlock a newer request.
- With Turnstile configured and login CAPTCHA enabled, the web login form renders the Cloudflare widget only when the password step is active. Account/setup/contact steps do not load or refresh a login challenge. Without Turnstile, the image CAPTCHA remains hidden until `captcha.required` after password submit. Registration renders its configured challenge when its tab opens.
- Turnstile size follows its visible host width, using flexible at 300px or more and compact only for genuinely narrower containers. Common phone forms must provide enough usable width for a horizontal widget. Recreating after a size-boundary change clears proof and rejects callbacks from removed instances; same-size resize preserves proof. Follow the surface guide's geometry and simulated-versus-live validation contract.
- Web forms submit `captcha_surface=web` and load `/api/auth/config?surface=web`; direct App requests use the default image CAPTCHA. Surface `turnstile.required`, `turnstile.invalid` and `turnstile.unavailable` near the submit button, and reset the one-use token after a request.
- Explicit `[hidden]` rules must win over `.field-group` grid display for conditional CAPTCHA and MFA fields.
- Password-source `email_bind`/`email_verify` pending stages reuse `/oauth2/mfa`. Show a new address input only for bind, masked current/target email, and an explicit send button for both gates. Disable completion until a current code was sent; editing the destination invalidates local proof and old responses. Never show internal synthetic addresses. Keep send and completion under one action lock and include the persisted `expected_mail_version`; conflicts/failures can refresh pending state without stale responses changing the active destination.
- Intermediate `next_step:true` advances TOTP/recovery to a mailbox gate without treating it as final login. Rehydrate the new pending stage, clear prior code/recovery/autosubmit state and feedback, then require explicit send. Only final `redirect` triggers navigation. Retain six-slot editing/IME/autofill behavior and all three locales. Resend cooldown is visible and does not turn a recoverable rate limit into a terminal disabled challenge.
- A failed next-stage GET keeps the consumed previous factor locked. On failed or unknown-outcome sending, restore version/code status/cooldown from pending GET. When restoring an active bind proof, clear a rejected edited address so only the masked persisted target is displayed; an optional empty bind input must never leave a different visible address associated with the old proof. Translate SMTP failure keys in all three locales and update asset versions whenever shared scripts change.

## 4. Validation & Error Matrix
| Input/event | Visible result |
| --- | --- |
| Continue with an existing account and no password | Password, first-password or contact-administrator step; no mail is sent |
| Continue with a nonexistent username/email | Localized missing-account feedback; account editable, password hidden/disabled; correcting the account allows Continue |
| Explicit setup send click | Account-bound request; masked destination remains the only displayed mailbox |
| Setup succeeds | Clear setup values; same account password step; no automatic login |
| Account changes while discovery/send/setup is pending | Clear prior state; late response cannot change the new step or feedback |
| Setup state changed on server | Rediscover safely or return to account entry; preserve OAuth context |
| Password confirmation mismatch | Localized message below submit; no request |
| Configured new-password minimum 12/16 | Matching localized guidance before submission; preserved across language changes |
| Config loading/failure/malformed minimum | Neutral new-password prompt without a guessed minimum or interpolation token |
| Chinese/space/punctuation/hyphen while editing registration username | Unsupported characters removed after committed input; display name unaffected; blank username visibly explains email fallback |
| Unfinished registration username IME composition | Value remains untouched; no registration submission |
| Programmatic invalid registration username bypassing editing events | Native constraints or raw submit guard prevent a registration POST |
| Unknown `validation.password.weak` key with description | Actual server password-policy description |
| Unknown key/code without description | Known translated fallback |
| Older email-send completes after submit error | Latest submit error remains |
| Mode switched while a request is pending | Old response does not update the new form |
| Five committed MFA digits | Slots mirror input; no verification request |
| Six committed TOTP/email digits from typing, paste, or autofill | One verification attempt through the existing submit path |
| Paired fill events or manual submission during a pending attempt | No duplicate request |
| Invalid MFA code | Localized feedback, no navigation, fresh entry can retry |
| Recovery input or language/mode rendering | No automatic request; manual recovery remains available |
| Terminal MFA 401/429 | Input and verify/mode controls remain disabled |
| Edited bind target | Previous proof cannot complete for the edited address; explicit send required |
| Rejected retarget restores a previous active proof | Clear the rejected editable address and show the masked persisted destination |
| Failed GET after `next_step` | Old factor stays locked; no resubmission of consumed proof |
| SMTP delivery failure | Localized error; completion follows the refreshed exact-code status |

## 5. Good / Base / Bad Cases
- Good: mobile registration submits mismatched passwords; bottom feedback is in viewport.
- Base: translated invalid-credentials error uses the browser language.
- Bad: returning `t(unknownKey)` exposes `validation.password.weak` instead of an explanation.

## 6. Tests Required
- `tests/account-first-login-browser.cjs`: explicit Continue, localized missing-account feedback and correction without password or authentication side effects, manual sending, no usable email, setup then password/MFA/OAuth continuation, stale discovery/send/setup, account switching and desktop/mobile feedback visibility.
- `tests/i18n.test.js`: known translations and unknown-key fallbacks for Chinese, Traditional Chinese and English; dynamic/neutral password guidance, malformed raw config, readable actual length errors and username rules.
- `tests/login-email-gate-browser.cjs`: full password/mailbox matrix and retained global switch, manual bind/verify, TOTP/recovery transitions, OAuth/verified claims, refresh, edited/taken target, terminal failures, next-stage GET failure, send failure and restored-proof target agreement at desktop/mobile widths.
- `tests/auth-feedback-browser.cjs`: real login/register/recovery failures, delayed email-send ordering, hidden conditional fields, desktop/mobile feedback location and screenshots; real configured 12/16 guidance on register/setup/recovery/profile across languages, allowed/mixed typing and paste, caret/replacement/deletion/255-character cap, controlled IME composition with no submit, raw invalid bypass with no POST, corrected registration with the same proof and Unicode display name, unchanged legacy login input, plus explicitly simulated delayed/failed/malformed config. Dispatched composition events do not establish real OS IME coverage.
- `npm run check:browser`: existing login/CAPTCHA/admin/profile workflows remain usable.
- `tests/turnstile-browser.cjs`: realistic simulated widget geometry, desktop/common-phone fit and narrow fallback, same-size versus size-boundary token lifecycle, stale callback rejection, account-step hiding and actual login/registration submission. Report live-provider coverage separately.
- `tests/password-mfa-browser.cjs`: on-demand CAPTCHA, dedicated email/TOTP pages, absent password/code fields on the wrong page, no session before successful verification, incomplete input, automatic typing/paste/extension-style input/change completion, exactly-one pending attempt, invalid and same-code retry, IME composition, manual recovery, terminal expiry, language preservation, visible bottom errors and desktop/mobile screenshots. Keep native-editing checks below six digits so they do not unintentionally verify. Hold/release a routed request to test locking rather than relying on latency or waiting to click a disabled button. Actual Bitwarden extension testing must be distinguished from simulated filling events.
- Independent successful TOTP scenarios must use separate fixture accounts/secrets: a successful verification consumes the time-step counter, so reusing one account/code within the same step tests replay rejection instead of a fresh login. Await the completion response and its resulting UI state before asserting request counts; a prior identical error message alone cannot establish that a later attempt completed.
- Check factor-specific names and recovery-to-TOTP restoration. A Chrome-only check of `autocomplete="one-time-code"` does not cover Firefox's DOM property behavior. Firefox content-script classification and menu request probes using simulated extension permission responses must not be reported as actual unlocked-vault dropdown testing.

## 7. Wrong vs Correct
Wrong: send a verification email while discovering the account, or route setup success through authenticated-login handling.

Correct: discovery selects a visible step; the user explicitly sends the code; verified setup returns to password entry with the original OAuth context.

Wrong: put the only status above a long form or use unverified translation lookups as user-facing text.

Correct: status follows active submit, stays in view, and resolves to a known translation or readable description.

Wrong: guard registration Enter only with the composition flag or `event.isComposing`; a final IME key can arrive after `compositionend` clears both signals.

Correct: suppress Enter while either composition signal is active or `event.keyCode === 229`. Keep ordinary Enter available. Cover the composition-end-before-keydown ordering with an explicitly attributed synthetic regression; do not report this as actual operating-system IME testing.
