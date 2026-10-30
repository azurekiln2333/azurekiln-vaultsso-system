# Backend implementation — account-first login

Contract source: `research/implementation-contract.md` (frozen). No new error keys were
invented; every response below is one of the frozen shapes.

## Change boundary

Only two files touched. No frontend, no tests, no fixtures, no specs, no docs.

| File | Change |
| --- | --- |
| `models/User.js` | `+14` — new `setInitialPassword(id, verifiedEmail, newPassword)` |
| `server.js` | `+245 / -6` — discovery branch, account-bound send, account-bound setup |

## 1. `models/User.js` — `setInitialPassword`

Inserted directly after `updatePassword` (now at `models/User.js:259`).

```js
async setInitialPassword(id, verifiedEmail, newPassword) {
  const hashedPassword = await bcrypt.hash(newPassword, 12);
  const [result] = await this.pool.execute(
    `UPDATE users SET password = ?, email_verified = ?
     WHERE id = ? AND email = ? AND (password IS NULL OR password = '')`,
    [hashedPassword, true, id, verifiedEmail]
  );
  return result.affectedRows === 1;
}
```

Exact SQL (whitespace-normalized) and parameter order:

```
UPDATE users SET password = ?, email_verified = ? WHERE id = ? AND email = ? AND (password IS NULL OR password = '')
```

| index | param | meaning |
| --- | --- | --- |
| 0 | `hashedPassword` | bcrypt(12) of the new password |
| 1 | `true` | `email_verified` |
| 2 | `id` | account id |
| 3 | `verifiedEmail` | the stored email the code was verified against |

Predicate is `id` + `email` + empty-password, so a concurrent admin/profile/reset write
cannot be overwritten. Returns real `affectedRows === 1`; callers must treat `false` as
a state change.

`tests/support/memory-db.js:455-495` (owned by p4) already matches this statement via
`and email = ?` + `password is null` + `password = ''` and reads `params[len-2]` = id,
`params[len-1]` = email. The order above satisfies it exactly.

## 2. `server.js:2692` — discovery branch on `POST /oauth2/authorize`

Selected **before** the legacy combined guard, which is unchanged and still sits at
`server.js:2732` (`if (!username || username.length > 255 || !password || ...)`).

Order: normalize/validate username → `User.findByUsername` → login lock check →
banned check → `validateAuthorizationRequest` → `next`.

- Empty or >255 username → `400 invalid_request` ("Invalid username length").
- Lock reuses the **same** key derivation as final login: `login:${user?.id || username.toLowerCase()}`,
  and returns via the existing `rejectLockedLogin`.
- Banned → existing 403 `auth.account_banned` + `recordLoginLog`.
- `validateAuthorizationRequest` runs only when OAuth params are supplied (it returns
  `{ value: null }` when neither `client_id` nor `redirect_uri` is present).
- `!discoveryUser || discoveryUser.password` → `{ next: 'password' }`.
  `findByUsername` returns `null` for both not-found and ≥2 rows, so unknown and
  ambiguous are conflated by construction — no `exists` field.
- no password + unusable mailbox (`''`, `@users.invalid`, invalid) → `{ next: 'contact_admin' }`.
- no password + usable mailbox → `{ next: 'set_password', email_masked: maskEmail(...) }`.

Always HTTP 200 except the four error paths above. Never sets a cookie, never creates a
session/token/pending challenge/auth code, never sends mail, and never calls
`RateLimit.consume` — only `RateLimit.check`.

## 3. `server.js:2891` — account-bound `POST /api/email-verification/send`

- Identifier selection is by **field presence** (`Object.prototype.hasOwnProperty`), not
  by non-empty value. Present-but-empty `username` therefore stays in the account
  variant and gets a readable 400; it never falls back to the legacy email branch.
- Both `username` and `email` present → `400 auth.password.setup.invalid_identifier`
  ("请仅提供账号或邮箱中的一项。").
- `username` present but empty / >255 → `400 invalid_request` ("请输入有效的账号").
- `purpose !== password_reset` → `400 email_code.purpose.invalid`.
- unknown / ambiguous → generic `200 email_code.sent` ("如果邮箱存在，验证码将发送到该邮箱"),
  no mail.
- **account already has a password → `409 auth.password.setup_changed`**
  (`账户状态已变化，请重新检查账号后再试。`).
- known + no usable mailbox → `400 auth.password.contact_admin`
  ("该账户没有可用邮箱，请联系管理员重置。").
- otherwise: 60 s cooldown pre-check (`429 email_code.cooldown`), then
  `issueEmailVerificationCode({ email: stored, purpose: password_reset, userId: account.id })`.
  The server derives the destination; the caller cannot choose it.
- Legacy email-only path is untouched.

## 4. `server.js:3139` — account-bound `POST /api/password-reset`

Same presence-based identifier selection and same mutual-exclusion 400.

- `username` present but empty / >255 → `400 invalid_request` ("请输入有效的账号").
- Then, in order: password policy (`validation.password.weak`) → confirm
  (`validation.password.confirm_mismatch`) → `User.findByUsername`.
- unknown / ambiguous → existing `400 email_code.expired`.
- **known + no usable mailbox → `400 auth.password.contact_admin`.**
- **account already has a password → `409 auth.password.setup_changed`.**
- `verifyEmailCode({ email: stored, purpose: password_reset, code, userId: account.id })`;
  failure maps to `setupVerification.status` + its `error_key`/`error_description`.
- `User.setInitialPassword(account.id, accountEmail, password)`; `false` →
  **`409 auth.password.setup_changed` returned before any revocation**.
- Only then `Session.revokeAllForUser` + `Token.revokeByUser`.
- Success: `200 { message_key: 'auth.password_reset.updated' }`. No login is performed.
- Legacy email-only path is untouched.

## Checks run

| Check | Result |
| --- | --- |
| `node --check server.js` | pass |
| `node --check models/User.js` | pass |
| `node --test tests/account-first-login.test.js` | **22/23 pass** |

Passing coverage includes: password/no-password/historical-null/placeholder/invalid-address
discovery, unknown+ambiguous hidden behind `password`, "discovery never sends mail /
issues credentials / consumes an attempt", banned+locked, send cooldown + stored-address
targeting, dual-identifier rejection, no-mail-for-password-account, generic unknown-account
send, setup without prior discovery and without a token, wrong/expired/replayed/other-account
codes, placeholder mailbox, email-changed-after-send invalidation, concurrent password write
not overwritten, concurrent email change not overwritten, confirm mismatch, end-to-end
account-email flow, legacy email reset semantics, unchanged `check_verification` and direct
credential login.

### The one failing test is a fixture bug, not a server bug

`tests/account-first-login.test.js:226` *"discovery still validates registered OAuth
parameters when they are supplied"* — the `good` case asserts 200 but gets 400.

Cause: `f.client()` creates the client with the real default `requirePkce: true`
(`server.js:1562`); enforcement is `const requirePkce = client.requirePkce !== false`
(`server.js:1887`), so a request carrying `client_id` + `redirect_uri` but no
`code_challenge`/`code_challenge_method` is correctly rejected with
`invalid_request` ("A valid S256 code_challenge and code_challenge_method are required
for this client or request").

Per instruction, the real parameter validation was kept. p4 fix (either is sufficient):

- `const app = await f.client({ requirePkce: false });` for this test only, or
- send valid PKCE with the good case, mirroring `fixture.js` `authorize()`
  (`code_challenge = base64url(sha256(verifier))`, `code_challenge_method = 'S256'`).

Note `response_type` defaults to `code` and `scope` may be empty, so PKCE is the only
blocker.

## API docs update (`views/docs/api.html`, +19 / -3)

Added after the existing `Authorization Request` heading, before `Token Exchange`:

- Table rows for `POST /oauth2/authorize`, `POST /api/email-verification/send` and
  `POST /api/password-reset` now mention the account-first path (discovery body;
  first password for an account without one).
- New heading **Account-First Sign-In**: the optional JSON body
  `{ "discover_account": true, "username", ...original OAuth params }`, the stateless
  guarantee (no cookie/session/token/auth-code/mail), and the three `next` values
  `password` / `set_password` / `contact_admin`, with `email_masked` returned only for
  `set_password` (example `al***@example.com`, matching `maskEmail`) and the full
  address never returned. Unknown and ambiguous are documented as deliberately
  indistinguishable.
- New heading **First-Password Setup**: the `username` variant of
  `/api/email-verification/send` (server re-derives the stored address),
  `400 auth.password.setup.invalid_identifier` for dual identifiers,
  `409 auth.password.setup_changed`, `400 auth.password.contact_admin`, generic `200`
  for unknown/ambiguous, and the `username` variant of `/api/password-reset` with the
  conditional write, `409` before any revocation, and
  `200 message_key: "auth.password_reset.updated"` — explicitly stating the user is
  **not** signed in and continues with the normal password step.
- A closing paragraph states both endpoints stay backward compatible for email-only
  requests and that the `username` variants are selected by field presence.

Checks: `npm run check:syntax` (99 files, pass) and a file-nesting scan of
`views/docs/api.html` (`HTML tag nesting OK`). `check:syntax` only extracts inline
`<script>` from HTML, so the nesting scan was added separately.

## Unresolved / handoff

1. **p4**: apply the PKCE fix above to `tests/account-first-login.test.js:226`.
2. **p5**: the new account-bound error shapes are
   `409 auth.password.setup_changed` and `400 auth.password.contact_admin`
   (plus `400 auth.password.setup.invalid_identifier` for dual identifiers and a
   plain-description `400` — no `error_key` — for an empty/overlong username).
3. `views/docs/api.html` now documents the new request variants — see
   "API docs update" above.
4. Send/reset intentionally do not add a banned check: the existing email-only paths do
   not have one either, and a banned account still cannot authenticate because final
   login rejects it. Preserving existing semantics rather than adding new surface.
