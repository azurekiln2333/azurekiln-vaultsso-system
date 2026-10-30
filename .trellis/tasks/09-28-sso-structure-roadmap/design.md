# SSO Organization and Capability Design

## Architecture
SSO standards define protocol and security behavior, not a mandatory source-directory tree. Use conventional Express boundaries while retaining the current CommonJS/static-page stack.

```text
azurekiln-oauth2/
  server.js                  # Thin compatible process entry
  src/
    app.js                   # Application factory and route registration
    bootstrap.js             # Configuration, database, timers, shutdown
    config/
    middleware/              # Authentication, admin access, origin, rate limit, errors
    routes/                  # OAuth, authentication, account, administration, pages
    controllers/             # HTTP input/output; invoke domain services
    services/                # Login/MFA, credentials, providers, notifications
    models/                  # SQL persistence and atomic operations
    db/
      init.js
      migrations/            # Numbered explicit upgrades, preserving schema metadata
  views/
    auth/                    # login, mfa, error, future consent
    account/                 # profile, future security and grants
    admin/                   # shell, users, clients, sessions, security, integrations
    docs/                    # API reference page
  public/
    css/                     # Business styles only
    js/
      shared/                # i18n, admin shell and reused UI/API helpers
      pages/
        auth/
        account/
        admin/
    assets/                  # Separately supplied fonts/icons; excluded from packages
  styles/                    # Stylesheet build inputs
  scripts/                   # Build, configuration, migration, checks
  tests/
    unit/
    integration/
    browser/
    support/
  docs/                      # Architecture, deployment, protocol contracts, review history
  dist/                      # Generated deployment archives; ignored by git
  .artifacts/                # Local screenshots and evidence; ignored by git
  package.json
  package-lock.json
  README.md
  LICENSE
  .env.example
  tailwind.config.cjs
  AGENTS.md
  .trellis/                  # Project workflow; other managed tool directories remain owned by tooling
```

Only create submodules when code is moved or behavior is implemented; do not add empty directory scaffolding. Introduce controllers where they remove actual HTTP/domain mixing. A large domain service is not an improvement over the current large server: extract coherent authentication, authorization, account and administrative responsibilities.

## Page Mapping and URL Compatibility

| Current source | Target source | Public URL behavior |
| --- | --- | --- |
| `authorize.html` | `views/auth/login.html` | Keep `/oauth2/authorize` and `/login` |
| `mfa.html` | `views/auth/mfa.html` | Keep `/oauth2/mfa` and its pending check |
| `error.html` | `views/auth/error.html` | Keep `/oauth2/error` |
| `profile.html` | `views/account/profile.html` | Keep `/profile` with authentication |
| `public/admin.html` | `views/admin/index.html` | Keep `/admin.html`; optional later `/admin` alias |
| `public/users.html`, `user.html` | `views/admin/users.html`, `user.html` | Keep existing protected URLs |
| `public/apps.html` | `views/admin/clients.html` | Keep `/apps.html` |
| `public/tokens.html` | `views/admin/tokens.html` | Keep `/tokens.html` |
| `public/security.html`, `smtp.html` | `views/admin/security.html`, `smtp.html` | Keep existing protected URLs |
| `public/account-bindings.html` | `views/admin/user-applications.html` | Keep `/account-bindings.html` |
| `public/api-docs.html` | `views/docs/api.html` | Keep `/api-docs.html` and metadata link |

Use an explicit page registry with public/account/admin access policy. HTML under `views/` is served only through the page routes. Mount only `/css`, `/js` and `/assets`; never mount `views/`, `src/`, keys, `.env` or the repository as public static files. Source relocation must not remove authorization or expose an alternative unguarded URL.

Rename numeric scripts such as `profile-1.js` to stable page names while updating HTML references and cache versions together. Preserve `/i18n.js` compatibility while moving its implementation under shared JS. Update package allowlists, deploy reference validation, Tailwind content scanning, syntax checks and browser fixtures in the same phase. The final release package must include `views/` and `src/`, with zero `assets/` entries.

## Backend Extraction
1. Keep `server.js` as a small compatible launcher/export shim so existing `node server.js` deployments and fixtures can migrate safely.
2. Move configuration/persistence/bootstrap into explicit owners. Resolve root-based `.env` and key paths from a single project-root module; moving `__dirname` must not change paths.
3. Construct the application using explicit dependencies, preserving test injection and teardown.
4. Extract middleware and pages, then domain groups one at a time: account, admin, local auth/MFA, providers, OAuth/OIDC.
5. Keep transaction/lock ownership in lifecycle services; pass transaction-bound persistence into verification, revision checking, single-use consumption and credential issuance. Never release a lock before issuance is durable.
6. Move migrations only after the running schema gate remains covered. Existing schema versions and explicit `init-db` semantics must survive.

## Capability Matrix

| Capability | Current state | Planned work / completion gate |
| --- | --- | --- |
| Authorization code, S256, confidential clients | Existing | Preserve protocol tests and callback validation |
| Discovery, RSA/JWKS, scope-filtered UserInfo | Existing | Metadata must describe only implemented features |
| Refresh rotation, introspection, revocation | Existing with gap | Persist token families/tombstones; detected reuse revokes descendants |
| Gateway sessions and logout | Existing with gap | RP-initiated logout with validated client return URI and state |
| OIDC `prompt` and `max_age` | Missing/rejected | `none` has no UI and correct errors; `login`/max_age force fresh auth; record `auth_time`/AMR |
| App history/Huawei bindings | Existing | Preserve distinct OpenID/UnionID and durable usage history |
| User consent and application grants | Missing | First-party policy vs third-party consent; scope additions require consent; revoke grant and credentials |
| Admin/user roles | Basic | Per-application role/access mapping, groups and narrower admin permissions |
| Login logs, basic admin_action and alerts | Existing with gap | Structured complete audit of actor/action/target/result, personal security history; no secret payloads |
| Administrator configuration | Existing with gap | Define persisted SMTP/settings contract; current SMTP edits are process-local |
| Password/email/TOTP and recovery | Existing, multi-device finishing | Preserve safe enrollment, per-device replay, recovery and revocation |
| Passkeys/WebAuthn | Missing | Use maintained library; challenge/origin/RP ID validation; multiple credentials and recovery policy |
| Public SPA/native OAuth clients | Missing | Client type, secretless authentication, mandatory S256; exact web/app redirect policy and client-aware endpoint rules |
| Signing-key overlap | Partly existing | Administrative key lifecycle/kid, publish old public keys until expiry; separate data-encryption rotation |
| Operational health and delivery | Gap | Minimal liveness/readiness, DB/schema dependency checks, metrics, persisted notification retry and retention |
| Cross-application logout | Missing | After client logout registration, back-channel signed logout token with aud/sid/event/jti/iat and delivery retry |
| SMS phone verification | Missing | Delivery adapter, verified-number ownership and abuse controls; no provider supplied yet |
| SAML, SCIM/LDAP, organizations | Missing/conditional | Separate projects only when actual consuming systems require them |

Common standards to use for implementation: OIDC Core and RP-Initiated Logout; OAuth Security BCP RFC 9700, PKCE RFC 7636, native apps RFC 8252, introspection RFC 7662, revocation RFC 7009, authorization server metadata RFC 8414; WebAuthn for passkeys. This is a roadmap based on local code inspection, not a live standards-conformance audit.

## Feature Data and Security Boundaries
- Huawei native handoff: HarmonyOS client sends its short-lived Authorization Code over HTTPS to its application server. The server calls this gateway's quick-login endpoint using `authorizationCode` (legacy `code` accepted). This gateway exchanges the code with Huawei using configured server-side credentials, resolves OpenID per App and UnionID per trusted subject group, then returns user identity plus a verified upstream E.164 `phone` on final success. When an OAuth client receives a new authorization code, full phone delivery requires an authorized `phone` scope; otherwise `phone=null` and `phoneStatus=scope_not_granted`. The phone from Huawei and the phone currently stored on the local account are different facts when a conflict prevents binding; expose that distinction explicitly. Do not derive a full number from a mask or a guessed prefix. `binding_required` and `mfa_required` remain state transitions and cannot be parsed as successful user responses.
- Accidental-account merge: existing target account authentication and a fresh code proving the source external identity are both required. Under sorted account/identity locks and one transaction, recheck source/target/bindings, move safe external identities and application history, revoke source sessions/tokens/codes, delete the source, and record an audit event. Keep target role, password, phone, email, MFA and verification state authoritative. Reject sources with privileged role, local password, MFA or conflicting information until a separate reviewed migration policy exists. Never merge solely on email, phone, unscoped UnionID or a client-supplied identity string.
- Grants need per-user/client approved scopes, status, timestamps and audit; usage history remains a separate record.
- Standard logout needs registered post-logout URIs and validated ID Token/client association. An arbitrary request redirect is never sufficient. Gateway logout cannot promise to erase an application's own cookie.
- Reauthentication needs reliable persisted authentication time/factors and security-state checks across pending flow, sessions, authorization codes and ID Tokens.
- Refresh reuse requires retaining evidence after consumption, atomic rotation and family revocation. Define concurrent-refresh behavior rather than losing consumed rows immediately.
- Audit logs must be server-originated and redact passwords, codes, tokens, secrets and raw identity payloads. The application account may append/read as needed; retention/export privileges belong to operations.
- WebAuthn and public clients change trust boundaries and require separate review; do not add ad hoc protocol/crypto implementations.

## Release and Rollback
- Structural phases are independently reversible commits with no schema change. Keep old public URLs as aliases rather than mass URL replacement.
- New-feature schema changes must be explicit, versioned and documented; deployment backs up DB, runs `init-db`, checks configuration/readiness and then admits traffic.
- Preserve the previous archive before replacing it. Structure migration moves generated ZIPs to `dist/`; communicate the new path and support an explicit output argument for existing automation.
- Production MySQL semantics and real provider integration need target-environment validation; isolated-memory tests do not establish production readiness.
