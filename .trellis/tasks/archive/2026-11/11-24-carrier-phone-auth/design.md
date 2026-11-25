# Integration design

## Provider/config boundary
`services/phone-auth.js` owns Aliyun PNVS signing, bounded timeouts, strict extraction and config normalization. Use Node crypto/fetch where possible, fixed official production endpoint and test-only dependency injection. Never request-selected upstream URLs/credentials.

Frozen exports: `fromEnvironment(env=process.env)`, `normalizeConfig(input,current={})`, `publicConfig(config)`, `adminConfig(config)`, `createClient(config,{fetchImpl=globalThis.fetch}={})`. Client methods: `getH5AuthToken()` -> `{accessToken,jwtToken}`; `getH5Phone(spToken)` / `getAppPhone(accessToken)` -> E.164 string; `sendSms(phone,outId)` -> safe `{requestId,bizId}`; `verifySms(phone,code,outId)` -> boolean (only Model.VerifyResult=PASS).

Fields: `h5Enabled`, `appEnabled`, `smsEnabled`, `allowRegistration` (all false), `accessKeyId`, `accessKeySecret`, optional `securityToken`, `sceneCode`, `h5Origin`, `h5Url`, `h5SdkUrl`, `smsSchemeName`, `smsSignName`, `smsTemplateCode`, `smsTemplateParam` (JSON default code=##code##, min=5). Admin projection returns nonsecrets and `hasAccessKeySecret`/`hasSecurityToken`; blank preserves and `clearAccessKeySecret`/`clearSecurityToken` explicitly clears secrets. Environment prefix PHONE_AUTH_ with uppercase snake case names.

Public projection: `{h5:{enabled,available,sdkUrl},app:{enabled,available},sms:{enabled,available,resendSeconds:60},registrationEnabled}`. Server additionally applies global/client creation policy. Persist overrides in existing encrypted private admin settings under `phoneAuth`; both load/save preserve other sections. Official H5 SDK is acquired from provider console and hosted at configured same-origin/HTTPS URL; no fictitious SDK asset.

## Frozen HTTP API
- GET `/api/auth/phone/config`: public capabilities, no-store.
- GET/PUT `/api/admin/phone-auth`: guarded admin config.
- POST `/api/auth/phone/h5/token`: `{session_days,return_to,...OAuthParameters}` -> SDK accessToken/jwtToken plus local `challengeId`; configured Origin/Url/SceneCode only.
- POST `/api/auth/phone/h5/login`: `{challengeId,spToken}` -> existing login/MFA result and optional native OAuth handoff.
- POST `/api/auth/phone/app/login`: `{accessToken,session_days,...registeredOAuthParameters}`. Native exception uses existing browser-origin guard. App receives SDK key from onboarding, never RAM credentials.
- POST `/api/auth/phone/sms/send`: `{phone,session_days,return_to,...registeredOAuthParameters}` -> `{challengeId,retryAfter:60,expiresIn:300}`.
- POST `/api/auth/phone/sms/login`: `{challengeId,code}` -> login/MFA/handoff; saved context wins over completion-body overrides.
- POST `/api/profile/phone/sms/send`: authenticated current bound phone only; derive account/target/session server-side -> challenge response.
- POST `/api/profile/phone/sms/verify`: `{challengeId,code}`; verify unchanged current number with existing self-session/revocation semantics, no silent rebinding.

One owner of server.js; focused registrar service with injected auth primitives is allowed. Stable readable errors, never raw upstream errors/tokens/phone. UI reuses actual existing MFA/redirect result contract.

## Durable proof/lifecycle
`models/PhoneChallenge.js` explicitly adapts the existing durable verification-code table already shared with MFA. Purpose namespaces: phone_sms_login, phone_sms_verify, phone_h5_login. The legacy email column holds an opaque hash namespace key; context contains canonical target, server-owned user/session/purpose/OAuth/sessionDays. Never store plaintext codes/provider tokens. Reuse existing attempts/consume/expiry SQL and erasure cleanup; no schema migration.

Adapter methods: static `key(phone,purpose)` plus `create({phone,purpose,userId,context,expiresAt})`, `findById`, `incrementAttempts`, `consume`, `invalidate(phone,purpose)`. Readback has existing snake_case fields plus parsed `context`; code_hash contains an opaque random challenge binding.

Durable RateLimit enforces per-IP/per-phone, cooldown and provider-proof-digest replay guards. Exact-ID challenge consumption is one-time, bounded by expiry/attempts. Serialize/correlate resends so late upstream responses cannot restore superseded challenge authority. Upstream calls stay outside account lifecycle transactions; final consume and issuance use the held connection atomically. Serialize initial phone creation using canonical-phone named locks and the unique index. Existing unverified phone ownership is not login authority.

Explicit `phone` pending source and channel/config validation must be implemented at pending lookup and MFA completion. Do not masquerade as password or unrelated OIDC. Retain external-login MFA policy. Cookies publish after commit and enroll completed logins; native OAuth preserves validated context and issues no gateway cookie.

## Tianyi account authorization
Dedicated `services/tianyi.js` per research/operator-oauth.md. Provider types `tianyi_web` and `tianyi_h5`, stored in existing provider config (clientId/appId, encrypted clientSecret/appSecret). Fixed official WEB/H5 authorize and token endpoints. Adapter exports `buildAuthorizationUrl(config,{redirectUri,state})`, `parseCallback(config,query)` -> `{code,state}`, `exchangeCode(config,code,{fetchImpl}={})` -> `{subject,openId}`. State fits 32 chars, HMAC checked before XXTEA decode, timestamp freshness and once-only bound state enforced. Token result=10000 and nonempty app-scoped openId are required; no unsupported UserInfo607 crypto or unverifiable phone/email claims. Use official XXTEA test vector in cloud CI; no guessed algorithm accepted only by a self-generated roundtrip.

## Cloud delivery
Branch `feat/carrier-phone-auth`; all test/build commands run in GitHub. Add cloud Chromium/full-browser evidence, deployment ZIP artifact, feature image build/inspection. Main coordinates commits/pushes and cloud failure fixes. Only latest passing branch merges. Select next available stable minor tag (expected v1.1.0), never overwrite tags. Existing GHCR conventions remain. No provider credentials in CI; live onboarding remains operator-owned.
