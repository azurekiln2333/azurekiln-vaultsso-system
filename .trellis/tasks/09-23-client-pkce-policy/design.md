# Design: Per-client PKCE enforcement policy

## Change Boundary

The behavior gap is the global S256-only PKCE requirement in the authorization request validator and token exchange handler. The policy belongs to the OAuth client record, so it must flow through persistence, client APIs, the existing client administration form, and both OAuth endpoints. Authorization-code rows already store nullable challenge and method fields.

## Data Flow and Contract

1. Persist `require_pkce` on each client and expose it as the boolean API/UI property `requirePkce`.
2. New clients default to `true`; migration of existing client rows must also produce `true` so upgrades preserve the current security behavior.
3. At authorization, require valid S256 when the client setting is true. When false, permit both PKCE fields to be absent; if either is supplied, require a complete valid S256 pair. Store null challenge/method for a non-PKCE authorization code.
4. At token exchange, use the values stored on the authorization code, not the client's current setting: codes with a challenge always require a matching verifier; codes without one do not.
5. If older API callers omit `requirePkce`, create requests default to true and update requests preserve the current value.

## Implementation Shape

- Add the column to fresh client table creation and add it through the existing `ensureColumn` migration path. Increment the schema version from 2 to 3 and document the upgrade.
- Extend the client model, API validation/serialization, and client create/update handlers without returning client secrets.
- Add a localized checkbox and security explanation to the existing OAuth client form; initialize it enabled for new clients and hydrate it for edits.
- Update README and API documentation so they no longer claim every registered client must always send PKCE.
- Extend the security tests and in-memory database test double to cover required and optional PKCE behavior end to end.
- For a PKCE-only setting change, keep outstanding authorization codes so their stored challenge remains authoritative while revoking access and refresh tokens. Other client configuration changes continue to revoke authorization codes as before.

## Security and Compatibility

Disabling PKCE lowers protection against authorization-code interception for that client, so the UI must clearly warn administrators and the default must remain enabled. Existing client rows remain protected by the migration default. A code's stored challenge determines token redemption behavior, preventing later configuration changes from downgrading a code that was issued with PKCE or invalidating one issued without it.

## Out of Scope

- Supporting PKCE `plain` or changing the server's advertised S256 method.
- Changing third-party client implementations.
- Changing PKCE policy for upstream OIDC providers; their existing `pkceEnabled` setting is separate.
