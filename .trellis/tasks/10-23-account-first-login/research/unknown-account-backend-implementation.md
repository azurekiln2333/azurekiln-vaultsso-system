# Missing-account discovery backend implementation

## Changed boundary

The account-only discovery branch in `server.js` now distinguishes a genuinely absent identifier from an ambiguous existing username/email match. Its existing `User.findByUsername` lookup returns null in both cases, so the null branch uses the existing `User.findPotentialConflicts(username, username)` query to confirm absence. No model or schema changed.

For `POST /oauth2/authorize` with `discover_account: true`, zero matching rows now return HTTP 404 with exactly:

```json
{"error":"account_not_found","error_key":"auth.account_not_found","error_description":"账号不存在"}
```

Ambiguous existing identifiers retain `{ "next": "password" }`; the branch does not choose an arbitrary matching account. Known password accounts, passwordless mailbox setup and contact-administrator outcomes retain their existing behavior.

## Ordering and side effects

The new check runs after the existing login lock, banned-account and OAuth request validation checks. Those errors retain precedence. It remains before the password credential path and does not consume a password attempt, create pending state, send mail, issue credentials or return account metadata. The ordinary endpoint-wide HTTP throttle remains unchanged.

## Validation and ownership

- `node --check server.js`: passed.
- This implementer changed only the narrow discovery branch in `server.js` and this report. Existing unrelated edits were preserved.
- Parent-owned API/browser regressions, translations, cache tags, spec synchronization and final aggregate validation remain separate coordinated work.
