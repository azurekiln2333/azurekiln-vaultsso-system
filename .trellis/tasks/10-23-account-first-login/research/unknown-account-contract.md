# Explicit missing-account discovery feedback

The user explicitly chose “改为立即提示账号不存在” after the existing uniform-password behavior was explained. This supersedes the initial requirement only for identifiers with zero database matches.

## Boundary and API

For JSON `POST /oauth2/authorize` with `discover_account:true`, after existing account/IP lock and requested OAuth validation, an identifier with no matching username/email returns HTTP 404:

```json
{"error":"account_not_found","error_key":"auth.account_not_found","error_description":"账号不存在"}
```

No `next`, destination or account metadata. No password step, email, pending credential, session, authorization code, token or consumed password attempt. Keep the account input editable and password disabled/hidden. Existing frontend error handling can render the translated response without a new form.

`User.findByUsername` returns null for zero **or multiple** matches. Preserve ambiguous-identifier fail-closed behavior and its current password step; do not silently select a user or call a genuinely existing ambiguous account nonexistent. When needed, use existing `User.findPotentialConflicts(username, username)` only after the null lookup to distinguish zero matches; no new model/authentication lookup semantics or schema.

Normal credential requests/native probes, passwordless setup/contact administrator, generic unknown recovery send, CAPTCHA/MFA, final invalid-credentials errors and retained mailbox policy remain unchanged. OAuth and lock errors still take precedence over missing-account feedback.

Add `auth.account_not_found` in zh (`账号不存在`), en (`Account does not exist`) and zh-TW (`帳號不存在`). Update affected auth-page references to shared i18n assets to a new unique cache version; unrelated pages do not consume this new login key and need no cache-only edit. Do not change sorting implementation or unrelated styles.

## Ownership and checks

- A native Trellis implementer owns only the narrow `server.js` discovery branch. Herdr p3's earlier read-only work could not complete because its provider repeatedly returned Cloudflare 502; p3 has no outstanding product mutation instruction.
- Existing Herdr p5 owns shared i18n keys and versioned references; no new login JS change is expected unless an actual failed frontend check demonstrates the need.
- Existing Herdr p4 owns focused API regression adaptation: genuine missing username/email, zero discovery side effects/password attempts, ambiguous existing identifier, OAuth/lock precedence and existing known-password/setup/contact paths.
- Existing Herdr p6 adds genuine missing-account UI coverage to the existing account-first browser suite at desktop/mobile, proves editable account/no password/no mail/session, localized messages and a subsequent known-account Continue still works. Preserve sorting coverage.
- Root owns task/spec synchronization and final aggregates. Independent Trellis check reviews the narrow branch after implementation. No commit/push/deploy/archive.
