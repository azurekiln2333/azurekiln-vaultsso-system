# Per-client PKCE enforcement policy

## Goal

Let administrators configure whether each OAuth client must use PKCE, so clients that cannot be changed can still integrate without weakening the default policy for other clients.

## Background

- The authorization endpoint currently rejects requests without a valid S256 challenge for every client.
- Authorization codes already have nullable fields for the challenge and method, so codes can represent both PKCE and non-PKCE authorization.

## Requirements

- Expose a per-client `requirePkce` setting in client administration.
- Keep PKCE required by default for new clients and existing clients after upgrade.
- When required, accept only a valid S256 challenge and require the matching verifier when redeeming the authorization code.
- When not required, allow authorization without PKCE; if a challenge is supplied, still require a valid S256 pair and verify it at redemption.
- Preserve the PKCE requirement associated with an issued authorization code even if an administrator later changes the client's setting.
- Explain the security trade-off in the client settings and keep user-facing documentation accurate.

## Out of Scope

- Supporting PKCE `plain` or changing the server's S256-only support.
- Modifying third-party client implementations.
- Changing PKCE settings for upstream OIDC providers.

## Acceptance Criteria

- [ ] Administrators can view and change the PKCE requirement for each client, and the value persists across reloads.
- [ ] New clients and pre-existing clients default to requiring PKCE.
- [ ] Required clients reject missing, malformed, or non-S256 authorization challenges and reject missing or incorrect verifiers.
- [ ] Clients configured not to require PKCE can authorize and redeem codes without PKCE parameters.
- [ ] Optional PKCE remains enforced when a client configured not to require it supplies a challenge.
- [ ] Changing a client's setting after authorization does not bypass or add a verifier requirement to an already-issued code.
- [ ] Relevant English, Simplified Chinese, and Traditional Chinese UI text and PKCE documentation describe the per-client behavior.
- [ ] Relevant tests and project checks pass.
