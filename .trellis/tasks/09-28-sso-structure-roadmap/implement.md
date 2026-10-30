# Staged Implementation Plan

## Phase 0: Complete Current Delivery
- [x] Finish `09-28-multi-authenticators`, concurrency review, complete checks and source-matching deployment package. Evidence: 162 tests, 81 syntax/reference files, five browser suites; ZIP has 68 source-matching files and zero assets. Production migration is not performed.
- [x] Record which existing phone/Huawei/app-history/MFA contracts must remain unchanged in PRD/design and context manifests.
- Gate: current authorized feature delivery is usable before broad extraction begins.

## Immediate Priority: Huawei Native Login and Existing-Account Merge
- [x] Accept `authorizationCode` and legacy `code` at the application-server quick-login endpoint, rejecting conflicting inputs; only the server sends its configured credentials to Huawei.
- [x] Parse official full phone, UnionID and per-App OpenID defensively; do not turn masked/malformed upstream data into a stored number.
- [x] Return the verified Huawei `phone` (E.164) on final successful login with a binding status distinct from the stored `user.phoneE164`; never return a fabricated or unverified complete number. Document native JSON/HTTPS request and pending binding/MFA branches.
- [x] Confirm same-scope UnionID across Apps auto-matches one account, and an existing two-account conflict still requires explicit merge.
- [x] Add fresh-proof, atomic merge paths for disposable Huawei and OIDC-created accounts; transfer safe identities/app history, revoke source credentials and delete source only on full success. Reject destructive conflict cases without partial writes. Older OIDC rows lacking a trusted provider snapshot may need manual review.
- [x] Run focused Huawei/account-merge, schema and security tests plus browser/deployment checks affected by the in-progress page move. Verification: 196 tests; all five browser suites; CSS build; 71-file ZIP excluding `public/assets`; `git diff --check`. Production MySQL/provider integration remains outstanding.
- Gate: official code-to-server-to-Huawei request and complete verified phone are tested; separate App OpenIDs resolve through one trusted UnionID; merge cannot transfer an identity without both account proofs or lose existing data.

## Phase 1: Pages, Resources and Root Cleanup (P0)
- [x] Establish explicit view-root/page registry with access policies.
- [x] Move all live HTML into `views/auth`, `views/account`, `views/admin`, `views/docs` using the design mapping.
- [x] Group/rename JS under `public/js/shared` and `public/js/pages/{auth,account,admin}`, retaining distinct `public/css` and `public/js` directories and the `/i18n.js` compatibility route.
- [x] Move security review into documentation and generated release output into `dist`; retain tooling-owned hidden directories.
- [x] Update npm file allowlist, deployment builder, syntax/reference scanner and Tailwind content globs.
- [x] Verify all old URLs, anonymous/admin/account page boundaries and archive references through API/browser/deployment checks.
- Gate: no root HTML; unchanged login/profile/admin flows; complete archive with zero font/icon assets.

## Phase 2: Backend Responsibility Extraction (P0)
- [ ] Introduce app factory/bootstrap with the existing `bootstrap` fixture contract.
- [ ] Centralize root-path resolution before moving configuration modules.
- [ ] Extract middleware and page routes, then account/admin controllers and services.
- [ ] Extract login/MFA, provider and OAuth/OIDC modules one group at a time.
- [ ] Preserve held-connection transactions, revision checks, single-use issuance and shutdown/cleanup lifecycle.
- [ ] Organize tests by unit/integration/browser and adapt runners.
- Gate: `server.js` is only a launcher/shim; each extracted group passes existing API/browser regressions; no behavior/schema change hidden in moves.

## Phase 3: SSO Protocol and Control Gaps (P1)
Deliver independently after per-feature planning and review:
1. Administrator audit and health/readiness endpoints; persist administrator-edited operational settings according to an explicit contract.
2. Refresh-token family rotation and reuse detection, including concurrent refresh tests.
3. Fresh authentication (`prompt=login`, `max_age`), silent authentication (`prompt=none`) and reliable `auth_time`/AMR metadata.
4. RP-initiated logout and registered client return URIs, followed by opt-in back-channel application logout.
5. Persisted application grants, scope approval and revocation UI, preserving explicitly configured first-party auto-authorization.
- Gate: feature-specific schema upgrades and tests; discovery matches actual capabilities; existing trusted clients remain compatible under documented policy.

## Phase 4: Account and Client Expansion (P2)
- [ ] Public/native client contracts with mandatory S256 and client-aware authentication/CORS rules.
- [ ] Passkeys with a maintained WebAuthn library, multi-credential management and defined recovery behavior.
- [ ] Personal security history, persisted notification delivery and administrator search/filter/export.
- [ ] Application access/role mapping and reduced administrator privileges.
- [ ] Managed signing-key lifecycle with expiry overlap; encryption-key lifecycle planned separately.
- Gate: each feature has its own threat boundaries, schema contract and acceptance tests. No fake integrations.

## Phase 5: Conditional Enterprise Integrations (P3)
SMS delivery/phone verification, SAML service integration, SCIM/LDAP synchronization and multi-organization isolation are deferred until a real provider/client/tenant requirement is specified. Their absence is documented, not represented by empty menus or mock success flows.

## Verification and Rollback
- For structural changes: `npm run check`, `npm run check:browser`, `npm run build:css`, `npm run build:deploy`, `git diff --check`.
- Verify archive HTML/CSS/JS, server module and view inclusion; forbid assets/env/private keys/dependencies and internal task files.
- Test anonymous requests to every protected page, current/admin self-session preservation, both authenticator devices, Huawei multi-app identity and OAuth continuation.
- For database features: isolated regressions plus dedicated MySQL integration for transactions/locks/migrations and failure recovery before production claims.
- Keep each phase independently reviewable. Pure structure changes can roll back code; data changes need explicit migration/rollback and backups.

## Artifact Status
The immediate Huawei/native handoff and accidental-account merge priority and Phase 1 page/resource/release cleanup are implemented and checked in the isolated test environment. Phase 2 backend extraction and later protocol capabilities remain open. The repository does not contain the HarmonyOS application-client source, so only the server and its client integration contract were changed. Production database migration and live Huawei/provider verification have not been performed.
