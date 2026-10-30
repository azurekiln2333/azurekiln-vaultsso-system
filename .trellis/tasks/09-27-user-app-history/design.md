# Design

Existing account-bindings lists external identity providers only. Persist OAuth relying-party app usage in user_app_usage, keyed by user/client with app name snapshot and first/last activity times. Write after validated authorization-code exchange and successful refresh; never count client-credentials or mere authorization-code creation. Schema v6 creates this relation with user-delete cascade and no client FK so removed apps remain inspectable. Explicit migration backfills retained user access/refresh tokens using their timestamp evidence, avoiding unavailable historical reconstruction. No fake login counts.

Extend GET /api/admin/account-bindings accounts with applications; union users from external bindings and usage, including OAuth-only accounts. Add GET /api/account/applications returning { applications, bindings } scoped solely to current user. Shared projections omit tokens, secrets and raw external profiles. Application projection includes clientId/name/configured/enabled/firstUsedAt/lastUsedAt. Binding projection retains existing provider/App/OpenID/UnionID scope data.

Admin retains existing page/navigation with OAuth usage and external binding sections. Profile gains a dense unframed applications section and richer external app association details. Existing unbind controls stay functional.
