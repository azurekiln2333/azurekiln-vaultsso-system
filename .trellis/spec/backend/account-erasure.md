# Permanent Account Erasure

## 1. Scope / Trigger

QFLI's application server permanently erases a gateway account after the user requests account deletion. The gateway owns the unified identity: erasure removes the target user's credentials for every relying application. Other accounts, client configurations and machine credentials remain usable.

The external contract is frozen in `.trellis/tasks/11-02-gateway-compliance-w4/design.md`. Changes must preserve its path, authentication, success fields and error codes.

## 2. Signatures

- `POST /oauth2/account/erase`, JSON body `{ "user_id": "<gateway user ID / ID-token sub>", "reason": "user_request", "request_id": "<optional, at most 64 characters>" }`.
- Authenticate with `Authorization: Basic base64(client_id:client_secret)` or body `client_id` and `client_secret`. Reuse the gateway's client-secret verification; a user bearer token grants no erasure authority.
- `isQfliClient(clientOrId)` is exported from `services/qfli-integration.js` alongside its existing installer. Only client IDs beginning with `qfli`, case insensitive, qualify.
- A qualifying client must be enabled and explicitly have the `qfli_account_erase` scope. Do not grant this scope automatically.
- HTTP 200 returns `{ user_id, status: 'deleted' | 'already_deleted', deleted_at: '<ISO8601>', tokens_revoked: true }`.
- Schema version 8 adds `users.status` (`active` / `deleted`) and nullable `users.deleted_at DATETIME(3)`, and widens `login_logs.detail` to `VARCHAR(1024)` so the client ID and request ID fit the audit. Existing installations migrate only through explicit `npm run init-db`; application startup does not perform migrations.

## 3. Contracts

### Authentication and request boundary

Check valid client credentials, enabled state, QFLI identity and scope before exposing target-account existence. `user_id` must be a gateway UUID. An omitted `reason` defaults to `user_request`; a supplied reason must be a string of at most 255 characters. A supplied `request_id` must be a string of at most 64 characters. Protect every route spelling accepted by Express, including case changes and the optional trailing slash, with the same origin and rate policies. Headerless server calls are supported; an explicit foreign browser origin is rejected.

Erasure uses a dedicated transport bucket of 120 requests per IP per minute and an authenticated-client bucket of 30 requests per minute. Neither consumes the ordinary authentication bucket used by other gateway applications. Return `rate_limited` and `Retry-After` when either limit is exceeded.

### Atomic tombstone and revocation

Use one held database connection and transaction for the durable erasure. Coordinate with the account lifecycle lock used by `Authenticator.withUser` and final login issuance: `totp:${sha256(userId).slice(0, 48)}`. Erasure acquires it using `GET_LOCK(?, 0)`. A simultaneous erasure of the same account returns 409 instead of waiting and executing a second operation. Release named locks and the connection on every exit, including lookup failures, rollback and commit failure.

Keep the user's ID as an internal tombstone with `status = 'deleted'` and a persistent deletion timestamp. Replace the username with `deleted_<random>` and clear the original email, phone, name, description, avatar, password hash, authenticator/recovery material and other identifying account fields. The existing unique, non-null email uses a random `deleted_<uuid>@users.invalid` marker containing no original account identifiers; the non-null password becomes the empty string. Never preserve an old mailbox or a recoverable password as a tombstone value.

Delete all access tokens, refresh tokens, authorization codes and sessions for this user, across clients. Remove external identity bindings, TOTP devices and pending setup, email verification and pending-login proofs, and application usage. The former Huawei identity and phone may then create a fresh account with a different user ID.

Tombstones cannot authenticate, refresh, obtain new credentials or appear through public profile lookup. Recheck account and grant state under the same lifecycle lock at final credential issuance, using connection-bound models. A request that read an active account before deletion must not recreate access or personal data after deletion.

`services/account-write.js` supplies `withActiveAccount(database, userId, work)` for user-bound inserts. Pool callers acquire the lifecycle transaction; existing connection callers lock and check the user row in their transaction. Account mutations also condition updates on `status <> 'deleted'`. Keep machine credentials with no user ID independent of these guards.

`User.delete` must preserve an existing tombstone, including when an older administrator request arrives late, so later erasure retries still return `already_deleted`. The in-memory Huawei binding map contains only unbound identities with its existing short expiry; it does not grant access to the erased account. Bound MFA continuations live in persisted verification rows and are removed by erasure.

### Retained logs and idempotence

Retain statutory login/registration records. Replace identifying usernames with `deleted_user` and user IDs with `HMAC-SHA256(JWT_SECRET, 'account-erasure:' + userId).hex.slice(0, 36)`, fitting the existing ID column. Retain IP, source port, timestamp and platform fields; clear the erased user's user agent and detail. Match user-bound records and legacy unbound records with the original username/mailbox. Scrub identifying admin-operation details as well: historical `recordAdminLog` values include prefixes such as `update_user | <username> -> ...`, `revoke_sessions | <username>` and `reset_totp | <username>`. Preserve other users' log identities and unrelated operation details.

Historical admin details were sliced to 255 JavaScript characters after adding the action prefix. Long imported usernames can therefore survive as a partial name with no final separator. Match those actual truncated formats as well as complete values. Escape `%`, `_` and the chosen escape character in username-based `LIKE` predicates; use an explicit `ESCAPE` clause so SQL modes do not turn literal account names into wildcards.

New user-target administrator actions (`update_user`, `revoke_sessions`, `reset_totp`, `delete_user`) record `target:<keyed user pseudonym>` rather than the target username. This also prevents a delayed administrator handler from restoring identifying details after erasure. Preserve the administrator actor and action/changed-field evidence. User-bound login log writes must serialize the account-state read with insertion and pseudonymize a freshly read tombstone.

Write one `admin_action` audit record containing the authenticated `client_id` and optional `request_id` in the same transaction. Do not store client secrets, bearer tokens or the erased personal profile. A failed erasure rolls back both cleanup and audit.

Idempotence is keyed by the gateway user ID and persisted tombstone, not an in-memory request cache. A retry, including one with a different or absent `request_id`, returns `already_deleted` with the original `deleted_at` and no duplicate audit. A user that never existed returns 404. Internal failures return a retryable `server_error`; they must not leave partial deletion.

## 4. Validation & Error Matrix

Every error response includes JSON `error` and a readable `error_description`.

| Condition | HTTP / error |
| --- | --- |
| Missing or malformed `user_id`; invalid or oversized `reason` / `request_id` | 400 `invalid_request` |
| Missing, malformed or incorrect client credentials; bearer-only authentication | 401 `invalid_client` |
| Disabled client or client ID outside QFLI prefix | 403 `access_denied` |
| QFLI client without `qfli_account_erase` | 403 `insufficient_scope` |
| User never existed | 404 `user_not_found` |
| Same account's erasure is in progress | 409 `conflict` |
| Request rate exceeded | 429 `rate_limited` |
| Internal transaction/storage failure | 500 `server_error`; rollback, then retry |
| Previously erased account | 200 `already_deleted`, original deletion time |
| Erased account requested through public profile | 404 `user_not_found` |

## 5. Good / Base / Bad Cases

- Good: an authorized QFLI backend erases a user with credentials for two applications. Both sets of user credentials fail immediately, retained logs are pseudonymized, and an unrelated account can still log in and refresh.
- Base: retry the operation after losing the first HTTP response. The original tombstone proves completion and supplies the same timestamp.
- Good: the user later verifies the same Huawei identity/phone and receives a new gateway account, without restoring old credentials or usage.
- Bad: delete only tokens issued to the calling QFLI client, leave a local password or MFA continuation usable, or let a stale grant exchange issue new tokens after deletion.
- Bad: update personal fields, audit or logs outside the transaction and then return 500 after only part of the operation committed.

## 6. Tests Required

`tests/account-erasure.test.js` must exercise the real HTTP route with isolated database fixtures, not production accounts. Cover Basic/body client authentication, helper case/type handling, the complete error matrix, route aliases, exact response fields, rate limits and cross-origin rejection.

Inspect stored tombstone and every credential/identity/proof/usage relation. Assert retained log fields and keyed pseudonyms, sanitized details, one audit, stable repeated deletion, no secret disclosure, unrelated user/application isolation, transaction rollback/retry, deterministic concurrent 409 and lock/connection cleanup. Exercise stale login and token-issuance races.

After erasure, assert failed password login, inactive access/refresh introspection, failed refresh and unspent authorization-code exchange, invalid old browser session and public-profile 404. Prove re-registration with the former Huawei identity and phone creates a different user.

Schema tests must cover fresh creation and idempotent migration of tombstone fields. Run relevant `node --test` suites and `npm run check` before committing. Memory-adapter tests establish application behavior; real MySQL lock/migration checks and live integration belong to user-controlled rollout.

Race-test interception must match the production SQL including its deletion-state guard, and assert that the interception actually ran. The memory adapter must dispatch normalized SQL internally without re-entering an overridden public `execute`, which would make a single database write trigger fault injection twice.

## 7. Wrong vs Correct

Wrong: read an active user, delete tokens on the pool, clear a few profile fields, then write an audit after returning success. Another asynchronous login can issue credentials between those operations.

Correct: authenticate the service client, hold the account's shared lifecycle lock, lock/read the current user, erase all relations and personal fields, pseudonymize logs and audit on the same transactional connection, then publish success after commit. Final credential issuance uses the same lock and rejects a freshly read tombstone.

Wrong: use plain SHA-256 of a user ID, retain the original mailbox as a unique tombstone, or rely on `request_id` memory to recognize retries.

Correct: use a domain-separated server-keyed HMAC pseudonym, generated non-identifying markers where required by schema constraints, and persistent `status` / deletion timestamp for retry behavior.
