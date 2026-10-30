# SSO Structure and Capability Roadmap

## Goal
Organize the existing Express/MySQL SSO gateway into predictable backend, page, static resource, documentation and release boundaries. Complete Huawei native-app authorization-code login and verified-phone delivery first, then provide a safe route for merging an accidentally created external-login account into an existing account. Identify missing SSO capabilities and implement the stages in the order the user directs. The user approved implementation on 2026-09-28 and reprioritized Huawei/account linking during execution.

## Confirmed State
- Four root HTML files are live: `authorize.html`, `mfa.html`, `profile.html`, `error.html`. `server.js:1905`, `server.js:2391`, `server.js:3410` and `server.js:3423` explicitly serve them. They are not disposable leftovers.
- Nine other pages live directly under `public/`; administrator pages are explicitly guarded by `ADMIN_ONLY_STATIC_PATHS` (`server.js:48`). There is no unrestricted public-directory mount.
- `server.js` combines configuration, middleware, persistence initialization, OAuth/OIDC protocol, local/provider authentication, account APIs and administrator APIs in approximately 4,700 lines.
- CommonJS, Express 4, MySQL 8 and static HTML/JS are the current stack (`package.json`). Tests bootstrap the application with injected persistence; this seam must survive extraction.
- Business CSS/JS are already separate in `public/css/` and `public/js/`. Fonts/icons under `public/assets/` are supplied separately and excluded from ZIP/npm packages.
- OAuth authorization code/S256 PKCE, refresh rotation, client credentials, discovery/JWKS, UserInfo, introspection and revocation exist. Scope-filtered user claims and confidential-client authentication exist.
- Local login/registration/password reset, email/CAPTCHA verification, external OAuth/OIDC/Huawei identities, sessions, phone editing, user app history, basic roles and login/security alerts exist. Multiple authenticators are being completed by task `09-28-multi-authenticators`.
- Authorization explicitly rejects `prompt`, `max_age` and non-query response modes (`server.js:1828`). Client authentication advertises only secret-based methods (`server.js:1337`); public clients are not supported.
- `/oauth2/consent` currently redirects to authorization (`server.js:3405`). Existing trusted applications auto-authorize; app usage history is not a persisted consent/grant record.
- `/oauth2/logout` revokes the gateway's current session (`server.js:3426`); discovery has no `end_session_endpoint`. This is not OIDC RP-initiated or cross-application logout.
- Refresh credentials are deleted on consumption (`models/Token.js:138`); there is no retained token-family reuse detection.
- `login_logs` records login events (`db/init.js:101`) and basic `admin_action` entries (`server.js:420`), with free-text action details limited to 255 characters. Structured audit actor/action/target/result fields and complete action coverage are missing. Roles are `admin`/`user`, without groups or client-specific role mappings.
- Native Huawei client guidance posts `authorizationCode` to the application server and reads `result.phone`. The current quick-login endpoint reads only `code`; successful replies expose `user.phoneE164` but no top-level `phone`. Pending binding/MFA replies are not final login-user responses.
- The Huawei adapter exchanges codes server-side with POST JSON `{code,clientId,clientSecret}` and parses official full phone/UnionID/OpenID fields. It can only return a full phone if the upstream actually supplies a usable number and the authorization includes the required sensitive permission. A database phone conflict does not overwrite an existing account number.
- A configured shared Huawei subject group already resolves the same UnionID across different App OpenIDs to one user. Existing bindings on different local users are rejected; account merging is not implemented.

## Requirements
- R1: No live HTML remains in the project root after page consolidation. Group auth, account, admin and documentation pages consistently, preserving existing public URLs and access checks.
- R2: Keep business styles and scripts in separate directories and exclude all font/icon assets from release packages. Generated archives and review reports must have defined locations.
- R3: Separate bootstrap, application construction, middleware, routes/controllers, services and persistence without changing protocol or security behavior during extraction.
- R4: Record every proposed capability as existing, partial or missing; group additions by value and dependency rather than assuming every enterprise feature is mandatory.
- R5: Plan essential SSO additions: persisted application grants/consent and revocation, OIDC prompt/max_age authentication semantics, RP-initiated logout, token-family reuse detection, administrator audit and operational health/readiness.
- R6: Plan subsequent public/native client support, Passkey/WebAuthn, managed key rotation, application-specific access/roles, searchable personal security history and persisted notification delivery. Treat SMS, SAML, SCIM/LDAP and organizations as conditional extensions.
- R7: Every phase needs observable acceptance criteria, affected compatibility surfaces, data migration and verification requirements. Existing phone, Huawei, MFA and app-history fixes remain dependencies.
- R8 (current priority): Accept both the existing `code` and Huawei-client `authorizationCode` request field without ambiguity. The application server alone supplies Huawei Client ID/Secret; native apps never receive them. Return a clear verified E.164 `phone` field after successful login while retaining the current `user.phoneE164` and OAuth `phone` scope behavior; OAuth application handoffs disclose it only with granted `phone` scope. Distinguish missing/invalid upstream phone, pending binding/MFA and phone-storage conflict without inventing a number or overriding another account.
- R9 (current priority): When a third-party identity already created a local source account, support an explicit, authenticated transfer to an existing target account, then delete the source only after an atomic successful transfer. Verify control of both identities, preserve useful app/identity history, revoke source credentials and reject conflicts or populated source accounts that cannot be merged without loss. Same-scope Huawei UnionID auto-linking for unconflicted accounts remains automatic and does not require a merge UI.

## Acceptance Criteria
- A reviewed target tree and source-to-target page/route map explain the four root HTML files and every page group.
- Existing OAuth endpoints, registered callbacks, admin URLs, account flows and static resource paths remain compatible during structure-only changes; anonymous access to admin HTML still fails.
- Existing tests and deployment archive checks cover path changes, application lifecycle, secure page serving and retained CSS/JS references.
- The capability matrix cites current code behavior and never equates historical app usage with user consent or current gateway logout with global logout.
- Proposed additions have independent delivery gates; no missing function is presented as implemented or standards-certified.
- Native app posts `authorizationCode` and receives a complete, verified `phone` on the final success response when Huawei supplied it; unauthorized, masked, invalid or absent upstream phone is not represented as a complete number. Legacy `code` callers remain functional.
- Matching Huawei UnionID within one explicitly configured subject group connects different App OpenIDs to one local account; a real two-account conflict requires explicit merge, never silent reassignment.
- Account merge is transactional, requires fresh proof of the existing account and the source external identity, does not lose unrelated bindings or application history, and revokes old source sessions/tokens before deleting it. Unsafe cases fail with no partial writes.
- The roadmap has PRD, technical design and ordered implementation artifacts, with directory cleanup scheduled before new protocol/identity features.

## Planning Boundary
Keep the current technology stack and single-repository deployment. Future public-client, passkey and cross-app logout implementations require their own security contracts and tests. SMS requires an actual delivery provider; SAML/SCIM/LDAP and organizations depend on real integration requirements. No production migration, automatic commit, deletion of managed tool directories or OIDC certification claim is included. The repository contains the SSO/application-server implementation but no HarmonyOS application-client source; integration guidance must specify the correct HTTPS URL, JSON request and response branches without claiming a native binary was changed.
