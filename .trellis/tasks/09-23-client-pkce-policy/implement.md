# Implementation Plan

## Steps

- [x] Add `require_pkce` to fresh client schema and the schema-v3 migration; retain `true` for existing rows.
- [x] Extend `ClientModel`, client payload validation, API serialization, and client create/update handlers, including defaults for older API callers.
- [x] Apply the setting in authorization validation and persist nullable PKCE data for allowed no-PKCE authorizations.
- [x] Make token redemption verify PKCE based on the authorization code's stored challenge, not the client's current setting.
- [x] Preserve outstanding authorization codes during PKCE-only updates while continuing to revoke client tokens; other client configuration changes retain the existing full revocation behavior.
- [x] Add a localized per-client setting and warning to the OAuth client administration form.
- [x] Update README and API docs to explain that PKCE is configurable per client and remains S256-only when used.
- [x] Extend the in-memory DB test double and add regression tests for enabled, disabled, optional-PKCE, malformed boolean, malformed stored metadata, and configuration-change cases.

## Validation

- [x] Run the focused OAuth security and schema tests (`node --test tests/security.test.js tests/schema.test.js`).
- [ ] Run `npm run check` and the full test suite successfully. Current runs have one unrelated existing failure in `tests/huawei.test.js:245`: that test omits `code_challenge_method=S256` from an authorization-code request.
- [x] Review the affected implementation paths and preserve the pre-existing working-tree edits.

## Review Gates

- Confirm the database migration defaults legacy clients to PKCE-required.
- Confirm a PKCE-bearing authorization code always requires its verifier, regardless of later client setting changes.
- Confirm the no-PKCE path is reachable only for clients explicitly configured with `requirePkce: false`.
