# Browser Account Chooser

## 1. Scope / Trigger
The ordinary login page lists accounts authenticated in the same browser and allows another account to be added without logging out the existing one. This is separate from the current user's device-session management API. The active identity remains the existing `session` cookie.

## 2. Signatures
- `GET /api/auth/accounts` returns `{ accounts: [{ id, username, name, current }], currentAccountId }`; the empty browser returns an empty list and null current ID.
- `POST /api/auth/accounts/switch` accepts JSON `{ accountId }` and returns `{ accountId }` after selecting an existing valid saved session.
- `POST /api/auth/accounts/remove` accepts JSON `{ accountId }` and returns `{ accountId }` after revoking/removing that browser's saved session.
- `GET /oauth2/logout` removes the currently active account while preserving unrelated saved accounts.
- `browser_accounts` is a separate signed HttpOnly cookie with a distinct token purpose. It is never accepted as a normal session token.

## 3. Contracts
Only completed authentication may enter the saved list. Remember the previous active credential during successful new-account login, deduplicate by user ID and keep at most five recently used accounts. Bound serialized size as well as entry count. Never expose JWTs, session tokens or saved authentication claims in list JSON, DOM or Web Storage.

The signed roster retains the original subject, session token reference, issue time, expiry and session policy. Validate purpose, signature, issuer/audience, exact claim types, each entry's independent expiry, durable row ownership/expiry/revocation and current account availability. The roster's overall expiry does not extend any entry. Reuse the fixed/legacy rules in [Session Duration](./session-duration.md).

Selecting an account restores its existing session, without creating a new database row, extending expiry or inventing recent authentication. Mutation routes retain the existing same-origin protection. List responses are not cacheable. A legacy browser with only the active cookie must still appear in the chooser. Expired/revoked/banned/deleted entries are pruned before presenting them as usable accounts.

Integrate both direct issuance and post-commit login publication, plus credential replacement and legacy refresh. Preserve transaction boundaries: no global-pool acquisition while holding an account connection; pending/failed authentication must not change the active or saved account. Removing an inactive account cannot clear the active cookie. Removing the active account clears it and leaves other saved accounts available for explicit selection. Eviction from the bounded roster forgets the oldest entry rather than revoking unrelated device sessions.

The login page offers native select/remove/add/back buttons, safe display text, visible errors and busy/race protection. Add/back never invokes logout. Retain account-first login, registration, recovery, MFA, locale and duration behavior. Continue to profile normally; preserve the existing OAuth parameters when continuation applies. Automatic OAuth SSO and unsupported `prompt` behavior are unchanged.

## 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| No browser session | 200 empty chooser; login remains available |
| Active old single cookie | Enroll/display without new authentication |
| Valid saved account selected | Existing session restored with its original expiry |
| Unknown, forged, expired or revoked account ID | 401 `auth.required`; no account switch |
| Cross-origin mutation | Existing same-origin rejection |
| Malformed/tampered roster | No authentication authority; valid independent active cookie remains authoritative |
| Failed password or pending MFA for another account | Existing account remains active; no premature roster entry |
| One saved account removed | Only its corresponding session revoked; other accounts remain available |

## 5. Good / Base / Bad Cases
- Good: sign in A, add B, select A; A keeps its original session ID and fixed deadline.
- Base: a browser upgraded with only a `session` cookie sees its current user immediately.
- Bad: accepting an arbitrary posted user ID and creating a new session without possession of the saved signed proof.
- Bad: setting `created_at` to now while switching, which would bypass recent-authentication restrictions.

## 6. Tests Required
`tests/login-accounts.test.js` must cover cookie-jar A/B switching, unchanged session/expiry, old-cookie enrollment, de-duplication and bounds, invalid IDs/tampered proofs, independent expiry/revocation/ban checks, removal/logout, failed login and pending MFA. Assert safe response projections and cookie attributes. Existing session-duration and factor tests remain relevant.

`tests/login-accounts-browser.cjs` verifies actual add/back/select/remove behavior, reload, keyboard controls, desktop/mobile widths and three locales using the isolated real service. Inspect captured screenshots; simulated provider fixtures do not establish live provider coverage.

## 7. Wrong vs Correct
Wrong: store raw bearer tokens in localStorage, or consider a saved display-name row sufficient to authenticate.

Correct: keep signed credentials HttpOnly and validate their original authority and live database state before restoring the active cookie.
