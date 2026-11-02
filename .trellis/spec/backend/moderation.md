# Profile Content Moderation

## 1. Scope / Trigger

Gateway-owned edits to display names and descriptions pass through `services/moderation.js` before persistence. This applies to `PUT /api/profile` and `PUT /oauth2/profile`. Keep authentication, OAuth scopes, provider identity synchronization, administrator imports and other applications' login/registration behavior at their existing boundaries.

The shared service contract belongs to `azurekiln-moderation/README.md` (initial contract commit `e95e7ff`), with its Node SDK in `packages/client`. Do not invent its transport protocol or implement moderation algorithms in this gateway. Missing SDK/configuration or failed checks must close changed profile text with 503; test doubles are not a production moderation service.

## 2. Signatures

- `await moderation.assertProfileUpdates(currentUser, updates)` checks only supplied `name` and `description` values that differ from stored values.
- `createModerationService({ env, loadSdk, assertText })` provides an injectable SDK boundary for isolated tests. The assertion resolves on approval and throws on rejection or unavailability. The production adapter loads the SDK lazily so missing optional configuration does not break unrelated routes.
- `new ModerationClient({ baseUrl, appId, apiKey, timeoutMs: 3000, failClosed: true })` and `client.checkText({ scene, text, userId, ... })` come from `@azurekiln/moderation-client`.
- `readModerationConfig(env)` reads `MODERATION_BASE_URL`, `MODERATION_APP_ID` and `MODERATION_API_KEY` without network access.
- `isModerationSdkAvailable()` and `npm run check:config` report the installed SDK and static configuration state without printing the key or making remote calls.

## 3. Contracts

Keep each route's existing input normalization and length validation. Audit the exact normalized text that would be persisted. Unchanged fields and requests that only change email, password or phone must not require the moderation service.

Authenticate and authorize first. Complete moderation before email-change code sending/consumption, password writes, credential revocation or profile writes. A rejected mixed request must not partially apply its other changes. Do not put moderation into `User.update`, which is also used by imports, providers and administrator operations.

All three missing configuration values leave other application functions available; changed text remains unavailable. Partial configuration or an invalid address must produce a fixed configuration error without echoing input or secrets. App ID and API key are supplied by the operator; never hard-code another application's tenant. HTTPS certificate validation remains enabled. Configuration availability does not prove SDK connectivity.

The API key must contain at least 32 characters. Header values must not contain line breaks. Production addresses require HTTPS, except an explicitly local loopback listener. Use separate `profile_name` and `profile_description` scenes; send the current account ID as both `userId` and `targetId`, with `targetType: "user"`. Do not accept a request-supplied tenant or user identity.

Only `decision: "pass"` approves a change. Both `block` and `review` withhold the edit; an unknown/malformed result, SDK failure or unavailable dependency returns 503. The SDK's fail-closed exception has `code: "moderation.unavailable"`, status 503 and a safe message. Do not expose upstream bodies or hit details.

Distribution uses the official SDK tarball: pack `packages/client` into a temporary output directory, commit the resulting `.tgz` under this repository's `vendor/`, and reference `file:vendor/<tarball>.tgz` in the dependency and lockfile. Include `vendor/` in deployment package files. Do not depend on sibling repositories or an unpublished registry package. Packaging is a local verification step and does not authorize deployment.

There is no avatar file-upload implementation. The public profile editor must expose no manual avatar URL/file input and submit no avatar value. Keep existing provider avatars visible. `/api/profile` rejects a changed avatar, including data URIs, before side effects; an older form submitting the unchanged stored avatar may retain compatibility. `/oauth2/profile` continues rejecting unsupported fields.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Unauthenticated or insufficient OAuth scope | Existing 401/403; do not call moderation |
| Invalid name/description or unsupported personal avatar edit | Existing field validation before moderation; no profile mutation |
| Changed text approved by assertion | Persist the same normalized text |
| Changed text receives `block` or `review` | 400 `content_rejected`, fixed readable message |
| Missing SDK, missing configuration or service failure | 503 `moderation_unavailable`, `审核服务暂不可用` |
| Supplied text unchanged | Skip moderation; preserve other authorized updates |
| Changed avatar through personal profile | 400; no profile or security changes |
| Upstream failure contains submitted text or credentials | Never include those values in client errors or logs |

## 5. Good / Base / Bad Cases

- Good: change a Chinese display name and description; the adapter approves exactly the normalized stored values.
- Base: submit the existing name with a phone-only update during a moderation outage; the existing phone authorization and replacement-session policy still apply.
- Bad: reject a new name only after consuming an email-change proof or changing the password.
- Bad: treat an injected test double, an unconnected URL or an unknown SDK response as an approval.

## 6. Tests Required

Use the isolated memory database, captured mail and injected SDK doubles. The shared fixture must clear all three moderation environment variables so inherited deployment settings cannot make tests call a real service. Cover both real HTTP routes, approval/rejection/unavailability, exact values, changed versus unchanged fields, authentication/scopes, mixed-request side effects, retained credentials and safe errors. Cover configuration with absent/partial/invalid values and prove the key is hidden. Verify the real profile editor has no avatar input/payload and the API rejects attempts to replace the image while allowing unchanged legacy values.

Exercise the vendored SDK against an isolated local HTTP fixture, enforcing the exact `POST /v1/text/check` path, `X-App-Id`, Bearer credential and JSON body. Valid fixture check results require `id`, `decision`, `createdAt`, `categories` and `hits`; `review` also requires `reviewId`. Prove a malformed/failed service cannot be treated as an approval. Keep mock-route, SDK transport and live deployment coverage distinct.

Run the relevant `node --test` suites and `npm run check`. SDK-backed acceptance requires the actual published contract and SDK adapter; stub tests alone must be reported as preparation coverage.

## 7. Wrong vs Correct

Wrong: copy a word list or a guessed HTTP request into either profile handler, audit every field on every profile request, or bypass moderation when its service fails.

Correct: keep one thin adapter around the contract's SDK, call it only for changed profile text before side effects, and return a safe 503 while approval cannot be obtained.
