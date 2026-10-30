# Password mailbox gate: independent backend review

Reviewer: `/root/check_import_scale`. Date: 2026-10-24 (Asia/Shanghai).

This first pass reviews the **in-progress implementation snapshot**, not an accepted final implementation. Source is changing under worker ownership. All findings below were delivered to the coordinator for p3 to fix. The reviewer has changed only research reports and will recheck the final source. No full aggregate suites, real SMTP or user imports are run by this reviewer.

## Findings and repair history

### B1 — stale pending credential can still send mail

`server.js`, new `POST /api/v1/auth/oauth/oidc/email/send`, `withAccountTransaction` and `readPendingUnderLock`.

The send route parses the signed token and independently fetches a fresh user. `finishAccountLogin` compares the user inside the lock with that freshly fetched user, rather than comparing it with `pending.securityState`. `readPendingUnderLock` rechecks parent identity/hash/expiry but not the token's security snapshot, original proof deadline or required `totpSatisfied` prerequisite. A gate token created before a password/security-state change can therefore continue to send mail. Revalidate the signed authority and prerequisite against the locked account and persisted context; retain the original proof deadline.

### B2 — TOTP/recovery consumption is outside the stage transaction

`server.js`, existing-factor branch of `POST .../oidc/complete` before the new TOTP-to-gate transition.

`verifyTotpOnce` commits its own transaction and `consumeRecoveryCode` uses the global User model before `withAccountTransaction` consumes the old pending and creates the gate successor. If successor creation or commit fails, the pending mutation rolls back but the accepted TOTP counter/recovery code remains consumed. Validate and consume local-password TOTP/recovery through `verifyTotpLocked` / bound User on the same held connection as old-pending consumption and successor creation. Do not nest `withUser`.

### B3 — TOTP-to-gate rotation extends password-proof lifetime

`server.js`, `beginPasswordSecondFactor` and TOTP successor creation.

Initial TOTP pending gets `{}` extra context, so it has no `proofExpiresAt`. The transition falls back to `Date.now() + 5min` and creates a fresh five-minute stage. A late TOTP completion extends the original password proof. Persist the deadline for every password-source stage and bound successor/code expiry by the original pending/JWT deadline as well as that value; fail closed if required persisted authority is missing.

### B4 — missing mailbox/IP send limits

`server.js`, send route plus `limitRequests`.

The first snapshot consumes only `gateSendKey(userId)`. `gateTargetKey(target)` exists but is unused, and the new send path remains in HTTP `auth` (120/min) rather than the established mail category (10/min). Different account challenges can therefore target one mailbox without its cooldown, and the intended mail/IP limit is not applied. Consume connection-bound target/account limits and classify the route consistently with mail sending. Keep version/CAS conflict rejection before delivery.

Interim follow-up: the added account limit was temporarily changed to 10/min and target to 5/10min while projections still used `check(accountKey, 1)`. That permits immediate server resends/retargets despite a displayed 60-second cooldown, and disagrees with the owner's newly added per-account/per-target regression assertions. Coordinator notified to retain the one-per-minute cooldown as well as the IP ceiling.

### B5 — native header clients cannot call the new send route

`server.js`, `MACHINE_ENDPOINTS` and request boundary.

`/api/v1/auth/oauth/oidc/email/send` is absent from the machine endpoint set. A native request with `X-Oidc-Pending` and no browser Origin/Referer/Fetch metadata receives 403, although completion is allowed. Add the new route to the same machine/browser-origin policy and prove explicit foreign-browser origins remain rejected.

### B6 — send responses do not identify the reserved send version

`server.js`, SMTP success/failure handling after the send transaction.

The failure body omits its reserved `mail_version`. After success the handler rereads the latest parent context and returns those fields; an older delayed SMTP request may therefore report a later target/version reserved by another request, rather than its own accepted send. Capture the reserved version/target in the committed delivery payload and use them in that attempt's response. A failed old SMTP delivery must continue consuming only its exact `codeId`, never a newer code. The frozen response also requires `sent:true`.

### B7 — intermediate response cannot rotate native pending authority

`server.js`, TOTP-to-gate `next_step` response.

The first snapshot issues the successor cookie but returns neither a new `pending_token`/`pending_header` for cookie-less clients nor the frozen `mfa_url:'/oauth2/mfa'`. Native clients keep only an already-consumed old pending token. Return the new committed credential through the established header contract and include the intermediate navigation metadata; do not clear the new cookie.

The initial `beginPasswordSecondFactor` response also discarded the returned pending credential; both initial and successor stages need this transport. Later source now shows both responses returning it; final native regression is pending.

### B8 — required consume failure still returns normally after factor mutation

`server.js`, non-gate branch of `POST .../oidc/complete`, inside `withAccountTransaction`.

After the new locked TOTP/recovery verifier succeeds, `if (!await codes.consume(record.id)) return authenticatorError(...)` still returns an ordinary error object. `Authenticator.withUser` commits normal returns, so consume-zero/expiry at this point commits the factor consumption despite unsuccessful stage/login completion. Throw the controlled rollback sentinel instead. Check all remaining failure returns after accepted-proof mutation, including external branches, rather than only the new gate branch.

### B9 — anomaly helper still starts SMTP inside the login transaction

`server.js`, `issueLoginWithinTransaction` and `detectAndFlagAnomalousLogin`.

Although the new issuance helper correctly defers ordinary login alerts/cookies, it still calls anomaly detection under the held account transaction. On reaching the existing anomaly thresholds, that helper directly starts `sendBehaviorAlertEmail(...).catch(...)` before commit. Fire-and-forget SMTP is still remote I/O started under the lock and can notify a login whose final session write later rolls back. Collect its alert payload when called from transaction-bound login issuance, then send it only after a successful commit. Existing password-failure calls outside account transactions can retain their behavior. Coordinator notified.

### B10 — direct factor submission still spends proof before gate creation

Coordinator finding, added to this review scope: `server.js`, direct `POST /oauth2/authorize` with supplied `totp_code`/recovery proof.

This separate entry still calls `verifyTotpOnce` / global `consumeRecoveryCode` before `beginPasswordSecondFactor` creates the mandatory mailbox stage and validates the original OAuth request. Pending-stage INSERT failure or invalid OAuth can therefore spend the accepted factor without producing a usable pending challenge. Validate OAuth before proof mutation; validate/consume the factor and create the new gate in one held account transaction, then issue cookie/body authority after commit. Final same-snapshot review will cover this path separately from B2's pending completion path. Root assigned the fix and regression to p3/p4.

### B11 — final contract precision: locked JWT expiry and integer versions

Final static follow-up sent to the coordinator: `readPendingUnderLock` checks persisted/proof expiry but does not recheck the JWT `exp` after the account-lock wait. Because JWT expiry is floored to seconds while the persisted deadline keeps milliseconds, a request that passed token parsing before expiry can still be accepted up to 999ms after the JWT's own expiry. Recheck that deadline under the lock as required by the frozen contract. The send/complete version parsers also coerce `null`, `false` and empty strings into zero; compare the original JSON field with `Number.isInteger` and require `>=0` to implement the required integer contract precisely. These are local contract tightenings; the B1–B10 dynamic results below are unaffected.

### B12 — case-insensitive route misses origin/machine/mail boundary matching

Express route matching accepts differently cased paths, but the request boundary's `/api/` prefix, machine endpoint set and HTTP mail-category checks use case-sensitive path comparisons. An isolated request with a valid gate cookie and explicit foreign `Origin` plus `Sec-Fetch-Site: same-site` was rejected with 403 at the lowercase send path, but the uppercase `/API/V1/AUTH/OAUTH/OIDC/EMAIL/SEND` accepted numeric-version JSON, returned 200/version=1 and sent one mail. That route variant also misses the global mail/IP category. The new strict numeric-version validation rejects form-encoded input (400); this is **not** a claim that a real cross-origin browser JSON request bypassed CORS or completed CSRF.

Apply one predicate/normalization matching Express's case-insensitive, single-optional-trailing-slash route behavior across origin/machine/mail-rate classification. Explicit foreign-browser origins must reject for every accepted route spelling, and native transport behavior should be consistent. Coordinator notified with the actual reproduction. Existing import already follows this path-matching convention.

## Interim isolated reproductions

The source changed while these checks were being prepared: p3 had already repaired B1/B2/B3 before this process loaded server.js. The narrow script used only `tests/support/fixture`, a memory DB and intercepted mail. It changed no repository product/test file.

| Check | Observed result | Interpretation |
| --- | --- | --- |
| Existing gate, change password, attempt send | 401, zero mail | B1 repaired in this interim source |
| Native header send with no Origin/Referer | 403 | B5 still reproduced |
| Advance Date.now by two minutes, complete TOTP | 200; successor minus original expiry = 0ms | B3 repaired in this interim source |
| Inspect that intermediate response | No `pending_token`, no `mfa_url` | B7 still reproduced |
| Inject successor INSERT failure after accepted recovery | 500; recovery remaining=1, parent unconsumed, sessions=0 | B2 repaired in this interim source |
| Force exact parent consume affectedRows=0 after recovery proof | 400; recovery remaining=1, parent unconsumed, sessions=0 | B8 repaired in the later interim source |
| Hold old SMTP success while a later send commits | Old response version=1; later response=2; latest code active | B6 success-version repair independently confirmed |
| Hold old SMTP failure while a later send commits | Old response 502/version=1; later response 200/version=2; latest code active | B6 failure isolation/response repair independently confirmed |
| Inspect account locks at both held-send SMTP calls | `[0, 0]` | Verification SMTP starts outside account locks |
| Complete one gate proof concurrently twice | Statuses `[200, 401]`; exactly one session | No double credential issuance |
| Fail final session INSERT after a conditional bind | 500; original email/unverified state intact; zero consumed proofs/sessions; no session cookie | Final issuance rollback is atomic |
| Seed three successful source IPs, then fail final session INSERT | 500; zero sessions and unverified user, **one anomaly SMTP call while namedLocks.size=1** | B9 reproduced; alert escapes rollback before commit |

These observations are provisional until final source review and owner regression coverage are complete.

## Final-source checkpoint after B9/B10 landed

B1–B10 are closed in the reviewed product source. Additional independent fixture results:

| Final check | Evidence |
| --- | --- |
| Native, zero-Origin TOTP -> gate -> send -> complete | Initial and rotated body tokens present and different; transition/send/complete all 200; `/oauth2/mfa` metadata retained; final verified user and exactly one session |
| Account/target send cooldowns | First send 200; immediate retarget and another account's send to the same target both 429; response body and `Retry-After` header both 60; one mail total |
| Direct recovery -> gate INSERT failure | 500; recovery remains available; no pending success cookie |
| Invalid direct OAuth before factor consumption | 400; the same recovery remains available |
| Valid direct recovery -> gate | 200 verify gate with body token; recovery then consumed; zero sessions and zero mail |
| Anomaly alert with failed final session write | 500; zero behavior-alert mail after rollback |
| Retry same proof successfully with anomaly condition | 200; one behavior alert starts with namedLocks.size=0; exactly one session |
| Target claimed by another account after send | 409; original unbound user/email preserved; zero proof consumptions and zero sessions |

Syntax: `node --check` passes for server.js, models/User.js, models/EmailVerificationCode.js and the current tests/multi-authenticator.test.js. No separate lint or TypeScript checker is configured in package.json. Main owns the aggregate API/browser/syntax run; these focused fixture checks do not claim real MySQL or live deployment validation.

Later B11 verification: supplied versions `null`, `false`, empty string, `-1` and string `'0'` all return 400 with zero mail. Advancing the clock to the JWT's expiry at `GET_LOCK`, after token parsing, now returns 401 with zero mail. B11 is closed.

Remaining review work at this checkpoint: B12 route/boundary consistency.

## Concurrency-test adjustment review

The initial replacement of the obsolete second pool-user-read hook with a hook immediately before `GET_LOCK` is sound: it deterministically lets the reset win before final transaction acquisition and retains the stale-snapshot rejection/no-credential assertions. Bounded hook waits were added.

The first added second test only reset **after awaiting completion**, so it proved sequential revocation but not the coordinator-required concurrent reset while the completion held the lock. This gap was reported to root for p4 to replace/add a held-connection pause, concurrent reset wait assertion, then release and verify revocation of the issued session. Final diff review is pending that update. No race assertion was edited by this reviewer.

Final test diff now resolves that gap. The direct-removal case again requires exact 401 / `auth.mfa.expired`. The locked case parks completion at its connection-scoped Session INSERT, waits until reset is actually in `namedLocks.waiters`, asserts its request is still unsettled, then releases completion and checks that reset removes authenticators and revokes the new credential. Its deferred signal and internal poll deadline prevent the former missing-hook infinite loop; finally releases the gate and settles both tracked requests.

Independent command: `node --test --test-name-pattern='removal between|reset landing|concurrent reset serialises' tests/multi-authenticator.test.js`. Result: **3 tests, 3 passed, 0 failed**, process exited 0 (14.3s). These assertions preserve and expand the meaningful security-race coverage rather than weakening it.

## Verification status

- Product source: B1–B12 repaired and independently rechecked; no open review findings.
- Focused isolated reproductions: results and final-source checks recorded above.
- Concurrency tests: final held-lock and stale-snapshot cases independently reviewed and passed 3/3.
- Lint/type-check: no separate configured scripts; four focused syntax checks pass. Root owns final aggregate evidence.
- Product/test edits by reviewer: none.

## B12 final boundary verification

p3's `normalizeGuardPath` now supplies the origin/machine and sensitive-route/mail-category comparisons. The final independent inline fixture checked lowercase, uppercase, mixed case, trailing slash, and mixed-case-with-trailing-slash spellings of both pending send and completion routes. Each check used valid pending authority and numeric JSON versions, so input validation could not hide a boundary failure.

| Check | Final evidence |
| --- | --- |
| Foreign Origin alone, and foreign Origin with `Sec-Fetch-Site: same-site` | All 20 send/completion requests returned 403 across five spellings; denied sends emitted zero mail and denied completions issued zero credentials |
| Native `X-Oidc-Pending` without Origin/Referer for every spelling | Send and completion both returned 200; each fresh account produced one mail, one final session and `email_verified=true`; zero sessions before completion |
| Mail category shared across mixed spellings | Eleven sends returned `[200,409,409,409,409,409,409,409,409,409,429]`; one mail total and zero sessions. The eleventh request hits the shared 10/minute HTTP mail category |
| Final source syntax | `node --check server.js` exited 0 |

B12 is closed. The original reproduction concerned inconsistent server-side path classification, not a demonstrated real-browser cross-origin JSON/CORS exploit. This final check changed no product or test files, used only the isolated memory database/intercepted SMTP fixture, and ran no aggregate suite.

Reviewed SHA256 checkpoint:

- `server.js`: `D8A2B1D29F5A9047994325083E8225E6F8DB0462EE08E86265A880D7CFDFCF12`
- `models/User.js`: `233BCDD63C2A7D27EBFDC0295A3C0B3EC331A9AA78913D3CB9A5F1C4DA28ACF1`
- `models/EmailVerificationCode.js`: `DDD0ACFBA4567B979FC9045DE6D4AE431E8A74BB8330FC451A5697F73AEB58D6`
- `tests/multi-authenticator.test.js`: `7DBDAB0563659BAAD428A6E31CA819F4D28EDE9E15CC36F5CB84692D5331B32E`

No open findings remain from this independent review. Root owns the final aggregate API/browser/syntax evidence. No separate lint/type-check commands are configured.
