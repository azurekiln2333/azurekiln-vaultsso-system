# API test implementation report

Owner: `trellis-implement` (w1Q:p4 — API regression tests + `tests/support/memory-db.js`).
Task: `.trellis/tasks/10-23-account-first-login`. Date: 2026-10-23.

## Files changed (my ownership only)

| File | Change |
| --- | --- |
| `tests/account-first-login.test.js` | New. 23 API tests against the frozen contract. |
| `tests/support/memory-db.js` | One new branch: real predicate + real `affectedRows` for the conditional first-password UPDATE. All pre-existing branches untouched. |
| `tests/support/fixture.js` | **Not modified.** `user(role)` signature and all existing callers unchanged; passwordless records are created through `f.User.create({ password: '' })` in the test. |

No product code, browser tests, or spec files were edited.

## memory-db support for `User.setInitialPassword`

Backend SQL (as landed by p3, `models/User.js`):

```sql
UPDATE users SET password = ?, email_verified = ?
 WHERE id = ? AND email = ? AND (password IS NULL OR password = '')
-- params: [hashedPassword, true, id, verifiedEmail]
```

The adapter previously had no branch for this shape: it neither equalled
`update users set password = ? where id = ?` (`:440`) nor satisfied
`endsWith(' where id = ?')` (`:454`), so it fell through to
`throw new Error('Memory DB does not support SQL: …')`.

The added branch (placed before the generic fallback):

- matches on `update users set ` + `and email = ?` + `password is null` + `password = ''`,
  so it is tolerant of column-list and guard ordering;
- parses the SET clause, supporting `?` placeholders and `true`/`false`/`null` literals;
- takes `id` and `email` as the last two parameters (matching `WHERE id = ? AND email = ?`);
- applies the real predicate `row.id === id && row.email === email && (password is null || undefined || '')`;
- returns `{ affectedRows }` from `updateRows`, so the route can distinguish 1 vs 0 rows;
- re-derives the `phone_e164` generated column and re-asserts user uniqueness, matching the
  behaviour of the existing generic users-update branch.

Verified directly: first apply → `affectedRows 1`; second apply → `0`; mismatched email → `0`;
`null` password treated as unset → `1`; literal-`true` variant → `1`.

## Coverage (23 tests)

Discovery (`POST /oauth2/authorize { discover_account: true }`)
1. account with a local password → `password` (by username and by email)
2. unset password (`''`) → `set_password` + masked destination only
3. historical `null` password → `set_password`
4. `@users.invalid` placeholder → `contact_admin`, no destination
5. non-address stored value → `contact_admin`
6. unknown identifier → `password`; username/email cross-collision (ambiguous) → `password`
7. no mail, no session, no access token, no auth code, no verification-code row across 6 discoveries; repeated discovery does not consume the password-attempt budget
8. banned → 403 `auth.account_banned`; locked → 429
9. invalid registered OAuth parameters → 400; complete valid OAuth context (PKCE S256) → 200 with no redirect/cookie/auth code

Account-bound send (`{ username, purpose: 'password_reset' }`)
10. targets the stored address, code row carries `user_id` + `password_reset` purpose, 60s cooldown → 429
11. dual identifiers → 400 `auth.password.setup.invalid_identifier`; placeholder mailbox → 400 `auth.password.contact_admin`; zero mail in both
12. account that already has a password → no mail, no code row
13. unknown account → generic 200 `email_code.sent`, no mail

First-password setup (`{ username, email_code, password, confirm_password }`)
14. succeeds with **no prior discovery and no token**; password set, `email_verified` true, no `Set-Cookie`, no session/token/auth code; new password then logs in normally
15. wrong code, expired code, other-account code → 400 and password unchanged; replay after success → **409 `auth.password.setup_changed`** with the established password intact
16. dual identifiers → 400; placeholder mailbox → 400; zero writes
17. email changed after send → 400, password unchanged
18. **true CAS race (password)**: `pool.execute` interception mutates the stored password immediately before the conditional UPDATE; asserts exactly one interception, 409 `auth.password.setup_changed`, concurrent password preserved, session `revoked_at` null, access token still present
19. **true CAS race (email)**: same interception mutating the stored email; asserts exactly one interception, 409, replacement email preserved, no password written, session/token not revoked
20. confirmation mismatch → 400 `validation.password.confirm_mismatch`, no write
21. end-to-end flow using the **account email** as the identifier (send + setup), asserting no `Set-Cookie` and a subsequent normal login

Legacy contracts
22. email-based `/api/password-reset` unchanged
23. native `check_verification` unchanged; empty password still rejected before lookup; direct credential login still establishes a session

Note on the CAS tests: they intercept the pool and mutate state **after** the route's
account read and immediately **before** the real conditional UPDATE executes, so the
server observes `affectedRows = 0` from the CAS itself — not from a pre-flight
"already has a password" rejection. This was validated standalone
(`intercepted 1`, `affectedRows 0` for both the password and email races) before
running through the route.

## Commands and results

```powershell
node --check tests/account-first-login.test.js      # pass
node --check tests/support/memory-db.js             # pass

node --test tests/account-first-login.test.js tests/password-mfa.test.js
#  tests 33 | pass 33 | fail 0 | duration ~7.2s

node --test tests/account-first-login.test.js
#  tests 23 | pass 23 | fail 0   (repeat run, stable)

node --test tests/security.test.js tests/oidc.test.js tests/account-merge.test.js tests/password-mfa.test.js
#  tests 74 | pass 74 | fail 0
```

`tests/password-mfa.test.js` alone: 10/10. `tests/security.test.js` alone: 33/33.

## One test correction made during integration (not a weakened assertion)

`discovery still validates registered OAuth parameters` initially failed because the
positive case supplied only `client_id` + `redirect_uri`. `validateAuthorizationRequest`
(`server.js:1863`) requires an S256 `code_challenge` whenever `client.requirePkce !== false`,
so a partial OAuth context is correctly a 400. The positive case now sends the complete
original OAuth context (response_type, scope, state, nonce, S256 challenge) — which is what
the browser actually carries — and additionally asserts no `redirect`, no `Set-Cookie` and
no authorization code. The negative (attacker redirect URI → 400) is unchanged. No security
assertion was relaxed.

## Unresolved / for the coordinator

1. **Nothing blocking.** All 23 account-first tests pass against the landed backend, and
   the 74-test regression set is green.
2. **`account-bound send never mails an account that already has a password`** asserts only
   the security invariant (`notEqual(status, 200)`, zero mail, zero code rows) because the
   frozen contract does not pin the exact status/key for that case. If the coordinator wants
   it pinned, the contract needs a value.
3. **Replay expectation depends on gate ordering.** The test asserts 409
   `auth.password.setup_changed` for a replay after success, per the frozen contract and the
   reviewer's instruction. This requires the first-password-only gate to fire before code
   verification. The landed backend satisfies it (test passes), but it is an ordering
   property worth keeping in the spec text.
4. **Browser coverage is not mine.** `tests/account-first-login-browser.cjs` (w1Q:p6) is
   still required for AC1/AC3.1/AC3.3; the coordinator adds it to `check:browser`.
