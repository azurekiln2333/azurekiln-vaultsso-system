# Design

## Boundaries and shared contract
Keep the existing active session cookie and session table. Add a bounded, signed HttpOnly browser_accounts cookie containing only the essential completed-session claims needed to revalidate and restore up to five saved accounts. Do not put raw tokens, passwords or session IDs in JSON responses or Web Storage. Use compact claims (sub, sid, exp, iat, optional session_days/session_deadline) covered by a separate typed signature, issuer and audience. Validate exact shape, supported policy, signature, original expiry, active DB row, subject ownership and account status. Do not treat the roster token as an active session token. Bound both entry count and serialized cookie size.

New completed logins remember the previous valid active credential and the new credential, deduplicate by user ID, then select the new account. Integrate both issuance paths and credential replacements/legacy refresh. Keep transaction-bound issuance cookies after commit. Never add pending MFA or failed credentials. Existing single-cookie browsers are enrolled when listing. Every account list/switch checks current database state. Roster maximum expiry may be the maximum retained expiry, while each entry keeps its independent deadline. Selection restores the existing sid and original expiry, with no new row, renewed lifetime or invented recent-authentication time.

API contract shared by all workers:
- GET /api/auth/accounts -> 200 { accounts: [{ id, username, name, current }], currentAccountId: string|null }. Empty unauthenticated browser returns empty list. Safe display metadata only; no secrets. Send no-store.
- POST /api/auth/accounts/switch JSON { accountId: string } -> 200 { accountId: string }. Unknown/invalid/expired IDs -> 401 with existing auth.required key/readable description. It only selects; frontend continues to /profile, or /oauth2/authorize with preserved original OAuth parameters. Same-origin guard applies.
- POST /api/auth/accounts/remove JSON { accountId: string } -> 200 { accountId: string }. Revoke only the matching saved browser session, prune it and clear active cookie only if this is the active account; unknown IDs fail closed. Same-origin guard applies.
- GET /oauth2/logout continues to revoke/remove the current account and leaves unrelated saved accounts available.

No new OAuth prompt support and no change to automatic SSO on a valid OAuth request. Preserve PKCE/state/nonce, external-provider return paths, registration policy, account-first discovery and all current factor checks.

## Frontend
Reuse sessionBanner as the chooser container and authRegion for add mode. Render accounts using safe DOM/text content. Use native buttons for selecting/removing each row and an Add account button. Back returns to chooser without logout. Refresh list after remove and on locale changes; keep user errors visible with busy protection and handle late hydration without overwriting an explicit add/back action. Existing markup IDs may remain where useful to regression compatibility, but no nested interactive controls. Bump changed asset references consistently.

## Administrator phone verification
PUT /api/users/:id accepts optional boolean phoneVerified (strict boolean only). Resolve the effective canonical number before applying verification; true requires a valid bound number. Omitted flags preserve old behavior: unchanged canonical phone retains verification; changed/unbound clears. Explicit true can verify a valid newly supplied number and false clears verification. Keep verification timestamp stable for unchanged verified phone; set on first/new verification; clear on false/unbind. Changes in verification participate in security-state invalidation and credential revocation without revoking an administrator's own currently preserved session. Ordinary PUT /api/profile remains unable to self-verify.

Admin form checkbox id phoneVerifiedInput/name phoneVerified loads user.phoneVerified. Phone input changes clear the checkbox; disable/clear it for no number. Existing structured phone fields and save/readback contract remain authoritative. Backend worker owns server endpoint; phone worker owns model only if necessary, admin markup/script and focused phone tests. Coordinate through these frozen contracts.

For an explicit verification update to an unchanged phone, the route passes the observed canonical number as `expectedPhoneE164`. The model conditions the entire update on `phone_e164 <=> ?`; a concurrent number change returns HTTP 409 before any partial field update or credential revocation. Cover both a full form repeating the old number and a flag-only update. Explicit verification of a newly supplied number writes that new number and its verification atomically.

## Compatibility and rollback
No DB schema migration expected. Old session cookies remain usable. Removing the roster implementation restores single-account behavior; remove admin checkbox handling together with its model semantics if rolling back. Never modify unrelated existing untracked compliance/task files.
