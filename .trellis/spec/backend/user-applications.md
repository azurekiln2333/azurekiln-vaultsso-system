# User Application Usage

## 1. Scope / Trigger
Persist accounts' relying-party OAuth application use and display their external provider app associations in admin and profile.

## 2. Signatures
- `UserAppUsage.record(userId, client, usedAt)`, `findByUserId(userId)`, `findAll()`.
- Schema v6: `user_app_usage(user_id, client_id, client_name, first_used_at, last_used_at)`, composite primary key, user-delete cascade, no client FK.
- `GET /api/account/applications`: authenticated `{ applications, bindings }`, no target selector.
- `GET /api/admin/account-bindings`: administrator `{ accounts: [{user, applications, bindings}] }`.
- Application projection: `{ clientId, name, configured, enabled, firstUsedAt, lastUsedAt }`; binding projection is shared with [Account Bindings](./account-bindings.md).

## 3. Contracts
Record only successful user authorization-code exchanges and refreshes, after credential/PKCE/account/grant consumption validation. Mere code creation, failures, replays and machine credentials do not create history. Atomic upsert keeps one row per user/client, minimum first and maximum last timestamps, and name snapshot. These are activity timestamps, not claimed precise historical login counts. Existing client configuration determines current name/status; missing configuration uses persisted name and disabled/removed state. Token expiry/revocation and app deletion preserve history; user deletion removes it.

Explicit `npm run init-db` creates the table and backfills retained user access/refresh token timestamp evidence joined to real users/clients. Exclude null users and authorization codes. Repeated migration must preserve earlier/later bounds and existing snapshots. No complete history can be reconstructed from already deleted tokens. Startup only checks schema version.

Personal endpoint ignores supplied IDs and never returns another user's data. Neither endpoint returns tokens, secrets or raw external profile data. Admin groups/searches by user, retaining all the matching user's apps; profile presents its own relying-party applications and per-provider app identifiers.

## 4. Validation & Error Matrix
| Condition | Result |
| --- | --- |
| Unauthenticated personal/admin API | 401 |
| Ordinary user requests admin API | 403 |
| Failed/replayed token grant | No usage mutation |
| Deleted app configuration | History retained with configured=false |
| Missing usage | Empty applications list |

## 5. Good / Base / Bad Cases
- Good: one user completes two app logins; both profile and admin list both, even after token cleanup.
- Base: user has only Huawei bindings or only OAuth history; admin still includes the account.
- Bad: infer all logged-in apps from currently active tokens, losing history when tokens expire.

## 6. Tests Required
`tests/app-usage.test.js` covers validated exchange/refresh, failures, machine grants, replay, concurrent grants/upserts, safe projection, own-user isolation and lifetime/deletion semantics. `tests/schema.test.js` covers create/cascade/no-client-FK and real timestamp backfill, including idempotency using the adapter. SQL semantics require a live MySQL migration before production rollout.

`tests/account-bindings-browser.cjs` covers admin app search/grouping, own-user apps, both Huawei app identifiers, removed app name, desktop/mobile screenshots and late responses after session renewal/unbind. Background app requests cannot force navigation on stale 401; loadProfile owns initial session navigation. Profile request revision prevents old responses/finalizers from overwriting a newer fetch; translation updates preserve loading/error states.

## 7. Wrong vs Correct
Wrong: show external identity providers as the complete list of relying-party apps, or use arbitrary account IDs on the personal API.

Correct: independent durable app usage plus safe external binding projection, with authenticated user ownership and administrator grouping.
