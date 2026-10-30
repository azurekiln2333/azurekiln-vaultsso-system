# Account Phone and Huawei App Identity Contracts

## 1. Scope / Trigger
Phone editing crosses profile/admin forms, authenticated API routes, identity verification and MySQL uniqueness. Huawei app association crosses provider configuration, external identities and the admin inspection page.

## 2. Signatures
- `PUT /api/profile`: own account phone update.
- `PUT /api/users/:id`: administrator phone update.
- `POST /api/admin/oidc`: optional `huaweiUnionScope` provider configuration.
- `POST /api/v1/auth/oauth/huawei/quick-login`: trusted server-side Huawei identity exchange.
- `POST /api/v1/auth/oauth/huawei/bind` and `/skip`: explicit decision after a pending, unbound identity; pending binding/MFA responses are not final login data.
- `POST /api/v1/auth/oauth/huawei/quick-login` with `intent: "merge"`: merge an accidentally created, disposable Huawei source account into a freshly authenticated existing account.
- `GET /api/admin/account-bindings`: administrator-only safe projection.
- `oidc_providers.huawei_union_scope VARCHAR(128) COLLATE utf8mb4_bin NOT NULL DEFAULT ''` was introduced in schema version 4. Current schema version 7 also persists MFA continuation, user application usage and multiple authenticators. Existing deployments must run `npm run init-db` before startup.

## 3. Contracts
Phone requests accept `phoneCountryCode` and national `phoneNumber`, or a full `phone` value. A blank/null number unbinds. Parse structured national numbers with `normalizeParts`, never guess a country prefix from a number already paired with an explicit country code. Preserve verification on unchanged canonical E.164; real changes clear verification/time and revoke old sessions and OAuth credentials. Profile changes replace the current session credential while preserving its remaining deadline and original legacy cap, following [Session Duration](./session-duration.md), and require authentication within five minutes or a valid `currentPassword`. Administrator self edits preserve `req.authSession.id` while revoking other sessions and OAuth credentials. Compare canonical values when deciding whether security fields changed: a full form submitting an unchanged email must not revoke sessions. Client-supplied verification flags do not verify numbers.

`User.update` must compare the phone country, national number and generated E.164 from its database readback with the requested normalized phone before returning success. A mismatch, including failed unbind, throws `PHONE_UPDATE_NOT_PERSISTED`; both APIs return 500 `profile.phone.save_failed` before revoking sessions or showing success. Admin forms always submit the structured phone fields.

Each Huawei app has a distinct provider key and client ID. A nonempty `huaweiUnionScope` is the administrator's assertion that apps belong to a common trusted subject; accept only `[a-zA-Z0-9._:-]{0,128}`. Match across configured Huawei providers in exactly that scope using a Huawei-returned UnionID, never request-provided identifiers or phone numbers by default. Keep a separate per-provider identity with its app OpenID and safe client ID/scope snapshots. Empty scope and missing UnionID retain app-local matching. Include disabled app bindings in conflict detection. Do not silently merge existing local users.

Huawei primary identity is UnionID when present, secondary is app OpenID; OpenID-only records use OpenID as primary. Personal profile must use stored Huawei metadata or these provider-specific rules when labeling identifiers, rather than the generic primary=OpenID assumption.

The bindings endpoint returns `{ accounts: [{ user: { id, username, name, email }, bindings: [...], applications: [...] }] }`, including OAuth-only users. `GET /api/account/applications` scopes `{ applications, bindings }` exclusively to the authenticated user. Bindings project provider/name/type, client ID, OpenID, UnionID, scope, primary/secondary identifiers, configuration/enabled state and timestamps. Never forward provider secrets, raw identity profiles or tokens. Removed configurations retain inspectable identity records. See [User Applications](./user-applications.md) for usage persistence.

Use sorted MySQL named locks on held connections for identity aliases and scope+UnionID. Resolve/create identities within a transaction on that connection; release locks/connections in `finally`. Huawei phone binding/verification must condition writes on the currently stored phone so a concurrent profile edit cannot be overwritten or incorrectly verified.

## 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| Invalid phone/code | 400 `invalid_request` |
| Another account owns requested phone, including unique-key race | 409 `conflict` |
| Phone database readback differs from normalized update/unbind | 500 `profile.phone.save_failed`; no success or session revocation |
| Old session and no valid current password | 403 `reauthentication_required` |
| Unauthenticated profile/API access | 401 |
| Ordinary user requests admin API/page | 403 |
| Same scope/UnionID maps to different users | Reject Huawei login; preserve bindings |
| A bound provider key is reused with a different client ID | Reject; use a new provider configuration |
| Huawei-reported phone belongs to another user | Preserve login and identity, report phone conflict, do not merge |

## 5. Good / Base / Bad Cases
- Good: two configured apps in `company-a` return the same UnionID and different OpenIDs; one local account has two binding records.
- Base: scope empty or no UnionID; login stays within its own app.
- Bad: two historical local users already own app bindings for one UnionID; enabling a common scope does not merge them.
- Phone: `+65` with national `65123456` stays `+6565123456`; it must not become `+65123456`.

## 6. Tests Required
- `tests/phone-api.test.js`: both write routes, format/uniqueness, unchanged verification, change/unbind, reauthentication, authorization and credential revocation.
- `tests/huawei.test.js`: multiple apps, separate scopes, OpenID-only fallback/upgrade, conflicts, concurrent first logins, transactional rollback, competing phone edits and safe admin projection.
- `tests/schema.test.js`: schema version, create and migration statements.
- `npm run check:browser`: saves/reloads/unbinds, navigation/search and desktop/mobile screenshots.
- Browser regression must save the currently signed-in administrator's full form, then reload and verify the phone. Editing another user alone misses self-session revocation bugs. Version changed phone scripts and required styles/translations in the referencing HTML to avoid old cached handlers.
- Core scripts live in `public/js` and business styles in `public/css`, served at `/js` and `/css`. Keep only separately deployed font/icon resources in `public/assets`; ZIP and npm packages exclude that directory. `npm run build:deploy` validates the archived HTML/CSS core references. Workspace-only browser checks do not establish archive completeness or live deployment success.
- Tests use isolated credentials and the memory adapter; MySQL lock semantics still need live-database integration coverage.

## 7. Wrong vs Correct
Wrong: merge any matching `UnionID` globally, keep one mutable OpenID for all apps, or verify a phone from a stale user snapshot.

Correct: establish explicit provider scope, keep each app's identity, reject conflicting mappings, and condition Huawei phone writes on the current database value.

## 8. Huawei Code Exchange Protocol

`services/huawei.js` posts JSON `{code, clientId, clientSecret}` to `https://account-api.cloud.huawei.com/oauth2/v6/quickLogin/getPhoneNumber`. The old default on `oauth-login.cloud.huawei.com` returns HTML 404; normalize that exact stored URL to the official host at call time. Preserve other explicitly configured endpoints for isolated tests. OAuth form fields and access-token UserInfo configuration do not apply to this code exchange.

Read `openId`, `unionId`, `phoneNumber`, `phoneNumberValid`, `purePhoneNumber`, and `phoneCountryCode`, retaining historical aliases. `phoneNumberValid=0` must not authorize phone-based account recognition. Inspect `resultCode` even for HTTP 200 responses. Expose only fixed messages: invalid code 400, provider credentials/client mismatch 503, missing quick-login permission 403, and endpoint/network failures 502. Never log or return `resultDesc`, raw response bodies, authorization codes or secrets. Clear phone numbers belong only in the authorized final login response under the phone-scope rule, never in errors or logs.

The Huawei upstream fixture must enforce POST + JSON with the exact official field names and simulate HTTP 200 business failures and HTML 404. Cover verified-phone automatic linking using the modern response fields; mocks that accept the adapter's old form format cannot validate the external contract.

Official contract: https://developer.huawei.com/consumer/cn/doc/harmonyos-references/account-api-get-user-info-quicklogin-by-code

## 9. Native Application Handoff and Phone Projection

HarmonyOS sends the short-lived Authorization Code over HTTPS to its application server. The application server calls the quick-login API with JSON `authorizationCode` and an optional configured `provider`, plus registered OAuth parameters for an authorization-code handoff. Legacy JSON `code` is accepted; simultaneous mismatched values fail with 400. Huawei Client ID/Secret come only from server-side provider configuration. Never let the native client choose those credentials or trust a request-supplied OpenID, UnionID or phone as identity proof.

The successful direct response projects `phone` from this exchange's normalized, Huawei-verified E.164 phone, or `null` if no usable verified number was returned. `phoneStatus` distinguishes `verified`, `conflict`, `unverified` and `not_returned`; OAuth authorization handoff without requested and approved `phone` scope uses `scope_not_granted` and a null phone. `phoneBinding` is the local write result; `user.phoneE164` is the currently stored account phone and may differ on conflict when phone disclosure is permitted. Without approved OAuth `phone` scope, redact the serialized user's phone fields as well. Do not copy a masked device hint, an unverified upstream number or an unrelated stored account number into top-level `phone`. A pending `binding_required` or `mfa_required` response must not be treated as a successful user response. Huawei MFA completion with OAuth handoff returns the authorization-code response and no session cookie; without OAuth handoff it returns user/phone fields and creates the gateway session. Both branches preserve phone-scope rules.

When `huaweiUnionScope` and Huawei UnionID match an unconflicted existing user, save each App's OpenID as a separate provider identity for that user. If the same scope/UnionID already belongs to different users, reject automatic linking. `intent: "merge"` requires a currently authenticated target session younger than five minutes and a new Huawei authorization code proving the source identity. `mergeHuaweiAccount` takes sorted account/identity locks and one transaction, transfers safe Huawei identities and app-use history, revokes source credentials and deletes the disposable source only on full success. Preserve target password, role, email, MFA and other target security state. Reject sources with local password, authenticators, credits, meaningful modified profile or incompatible phone, returning 409 for manual review. Phone-based account recognition is separately controlled by `huawei_phone_autolink`, which currently defaults on for new deployments; query the current setting because administrators can change it.

## 10. Generic OIDC Account Merge

Profile's per-provider Merge entry starts `GET /api/v1/auth/oauth/oidc/login?provider=<key>&intent=merge&return_to=/profile`. Require a target session younger than five minutes at initiation, callback and in the held-connection transaction; callback must use the same session and validated state. Prove the source provider subject through the normal OIDC authorization-code exchange and configured subject extraction. Return success through `/profile?account_merged=1`; errors redirect to profile with an error. Binding an unclaimed identity remains the normal link flow.

`mergeOidcAccount` may move only a disposable ordinary source account with exactly one matching provider identity, no password, authenticator, phone, credits, bans or modified profile. Accept a synthetic unverified email or a real verified email equal to the stored provider identity email; preserve the target's email, verification and other profile/security state. Under sorted named locks and one transaction, recheck account/session/identity state, transfer the identity and app-use history, revoke other target sessions and OAuth credentials, and delete the source. Keep only the target's current session. Reject conflicts or populated source accounts without partial writes; matching email by itself grants no merge authority. `tests/oidc.test.js` covers success, refusal and rollback.
