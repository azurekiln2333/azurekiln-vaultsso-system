# Explicit missing-account feedback — independent integration check

Reviewer: `/root/check_user_sort` (`trellis-check`). Active task: `10-23-account-first-login`.
Reviewed only the follow-up defined by `research/unknown-account-contract.md`; its explicit
zero-match decision supersedes the older uniform unknown/ambiguous discovery contract.
No sorting or mailbox-flow audit was repeated. Other workers' edits were preserved.

## Findings (fixed)

- File: `public/js/shared/i18n.js` (English `auth.account_not_found` entry).
- Issue: the newly inserted line had two fewer leading spaces than its surrounding entries.
- Fix: aligned its indentation with the adjacent English entries. No string or runtime behavior changed.

No behavioral product defect was found in this narrow delta.

## Findings (not fixed)

None. Root has synchronized task/spec/API documents to the explicit zero-match contract. The native
browser owner's final coverage has now landed and passed; its independent source review is recorded
below. There are no open behavior findings in this follow-up.

## Source and precedence review

Compared `server.js`, shared i18n and the login template with the fresh
`users-sort-baseline.json` snapshots. The server delta is confined to the discovery null-lookup
branch; ordinary credentials/native probes, passwordless setup, generic recovery sending and final
credential issuance are unchanged. `public/js/pages/auth/login.js` still has its exact baseline
SHA-256 `b7d65e6ce3118c8c0013c08296118fce575cd4565cfa6439f500c4117813e687`.

The route order is: normalized identifier length validation -> `findByUsername` -> read-only
account lock check -> known-account ban check -> requested OAuth validation -> null-lookup
conflict check -> next-step response. Thus locked requests keep `auth.locked`, and invalid OAuth
requests keep their existing errors before zero-match feedback is considered. Existing endpoint-wide
HTTP/IP throttling remains intact.

`User.findByUsername(x)` returns a user only for exactly one row. On null, the existing
`findPotentialConflicts(x, x)` uses the same username/email comparisons (`IN (x,x)` on each field).
Only zero rows return 404 with exactly `account_not_found`, `auth.account_not_found`, and `账号不存在`;
there is no `next`, destination or selected account. Multiple matches keep `{next:'password'}`
without choosing a row or being mislabeled absent. No model/schema or lookup semantics changed.

The new branch performs SELECTs and returns JSON. `RateLimit.check` is also a SELECT; there is no
password-attempt consume, mail send, pending-code insert, session/cookie, authorization code or
access-token issuance on this path. The previously existing lock/ban logging behavior is unchanged.

## Frontend and localization review

For account-step Continue, `rediscoverAccount()` handles 404 in its existing `!response.ok` branch:
it resolves the message and returns before any step change. The account remains editable and the
password remains disabled/hidden. The finally block releases the shared action lock and restores
the Continue label; existing revision checks still reject stale responses.

`VaultI18n.resolveMessage` prefers known `error_key`/`message_key` translations before prose.
The three exact translations match the contract: `账号不存在`, `Account does not exist`, and
`帳號不存在`. Consequently the Chinese server description does not leak into English or Traditional
Chinese for this response, nor does the machine key appear as the displayed text.

Both auth templates reference `i18n.js?v=20261025-account-not-found-1`; login JS and unrelated
page/style references remain unchanged. No new UI form or dependency was introduced.

## Regression review

Reviewed p4's final `tests/account-first-login.test.js` delta and report:

- Missing username and email both assert 404/no next step or destination.
- A real cross-field collision keeps the ambiguous password-step response.
- Repeated missing-account requests assert zero mail/credentials/pending rows/cookies and verify
  the exact hashed account-attempt key is untouched, independently of HTTP/IP throttle rows.
- Real bad-password requests lock an absent identifier; lock and invalid OAuth precedence are asserted.
- The known-password, passwordless mailbox/contact-admin and generic recovery tests are preserved.

Owner-reported focused API result is **25/25 passing**. Root subsequently reports full
`npm run check:e2e` **288/288 passing**, with output at
`.artifacts/unknown-account/check-e2e-final.log`. No test file was edited by this reviewer.
The native browser owner/root retain ownership of the new desktop/mobile real-browser checks.

## Verification

- Lint: no standalone script configured.
- TypeCheck: no standalone script configured.
- `node --check server.js`: pass (exit 0).
- `node --check public/js/shared/i18n.js`: pass after the indentation fix (exit 0).
- Direct real-i18n VM harness: pass, three exact locale values plus three error-key preference
  assertions (six assertions total).
- API: p4 reports 25/25; not redundantly rerun here.
- Browser: native owner's focused run passed, including all 12 new cases and existing scenarios;
  reviewed final source/log below. No redundant reviewer browser execution.
- Root reports full syntax check passing (104 files); the ten-group browser aggregate remains
  root-owned and was running when the final browser review was appended.
- No aggregate, commit, push, deployment or archive.

Product review is clean and frozen after the single indentation correction.

## Final browser source and execution evidence

Reviewed the frozen `tests/account-first-login-browser.cjs` (SHA-256
`642fce2df09713935df62d3a66a6845fc2407b1907a03e25a47740e63783eca1`).
`node --check tests/account-first-login-browser.cjs` passed (exit 0). No product or test edits were
made during this final review.

The new loop executes desktop 1440/mobile 390 × zh-CN/en-US/zh-TW × missing username/email: **12
real-backend cases**. Each starts from a reset fixture and a new browser context; the missing value
uses a fresh UUID while a different known account is seeded for the correction check. The only
route guard continues same-origin traffic and blocks external origins; missing-discovery responses
are not fulfilled or synthesized by the test. Existing held-response tests use separate contexts.

Source assertions verify:

- The actual response is HTTP 404 with the exact three-field error payload, and the outgoing JSON is
  exactly account discovery plus the identifier, without a password or other credential.
- Correct localized feedback becomes visible inside the viewport. Account input remains editable,
  holds the entered value, and password is hidden, disabled and not required. The original Continue
  label is restored.
- After a settled observation, the browser has made exactly one authentication request. Known
  initial profile/configuration reads are excluded; no send, retry, credential or pending request is
  permitted. Explicit test-side profile/pending probes happen afterward through the request context.
- No Set-Cookie, mail, session, authorization code, access/refresh token, email-verification/pending
  row or session/pending cookie exists. Real profile and pending endpoints both still return 401.
- Correcting the same form to the seeded known account gets the real 200 `{next:'password'}` response,
  enables the password field, and creates exactly one additional discovery request, with no mail or
  session. Each context's page-error list must remain empty.

All 14 prior named scenario blocks remain present with their setup/manual-send/contact-admin,
stale discovery/send/reset, shared action lock, MFA and OAuth state/nonce/PKCE/code-exchange assertions.
The native owner's focused run passed the full file, so preservation has execution evidence as well
as source inspection.

Read `.artifacts/unknown-account/account-first-login-browser.log`: final account-first browser PASS
is recorded, including the new localized missing-account/correction cases and existing desktop/mobile
flows. Confirmed all 12 `missing-*.png` files are present in `.artifacts/account-first-login/`.
Root owns visual inspection and final aggregate logs; this reviewer did not repeat them.

Final verdict: **no open behavior findings**. Product and browser test source remain frozen.
