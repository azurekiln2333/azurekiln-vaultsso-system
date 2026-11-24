# Carrier Phone Authentication

## 1. Scope / Trigger

Applies to Aliyun PNVS H5/App one-click login, SMS login, authenticated verification of a bound phone, and Tianyi account authorization. See `docs/PHONE_AUTH.md` for operator onboarding. A provider adapter establishes only the identity claims its verified response actually supplies.

## 2. Signatures

| API | Input / result |
| --- | --- |
| `GET /api/auth/phone/config` | Public H5/App/SMS readiness and effective registration permission |
| `GET/PUT /api/admin/phone-auth` | Administrator configuration, secret-presence flags and readiness |
| `POST /api/auth/phone/h5/token` | Entry context to `{accessToken,jwtToken,challengeId}` |
| `POST /api/auth/phone/h5/login` | `{challengeId,spToken}` to completed login or existing MFA continuation |
| `POST /api/auth/phone/app/login` | `{accessToken,session_days,...OAuthParameters}` |
| `POST /api/auth/phone/sms/send` | `{phone,session_days,return_to,...OAuthParameters}` to `{challengeId,retryAfter:60,expiresIn:300}` |
| `POST /api/auth/phone/sms/login` | `{challengeId,code}` |
| `POST /api/profile/phone/sms/send` | Server derives current user, session and bound phone |
| `POST /api/profile/phone/sms/verify` | `{challengeId,code}`; no client-selected target |

`services/phone-auth.js` owns `fromEnvironment`, `normalizeConfig`, `publicConfig`, `adminConfig`, and `createClient(config,{fetchImpl})`. The client exposes `getH5AuthToken`, `getH5Phone`, `getAppPhone`, `sendSms`, and `verifySms`. `services/phone-routes.js` integrates existing authentication primitives.

Tianyi uses `tianyi_web` / `tianyi_h5` in existing provider storage and existing OIDC entry/callback URLs, with a dedicated protocol adapter in `services/tianyi.js` and identity resolution in `services/tianyi-identity.js`.

## 3. Contracts

### Provider authority and configuration

All channels and phone account creation default off. `PHONE_AUTH_` environment fields map to camelCase configuration: H5/APP/SMS_ENABLED, ALLOW_REGISTRATION, ACCESS_KEY_ID, ACCESS_KEY_SECRET, SECURITY_TOKEN, SCENE_CODE, H5_ORIGIN, H5_URL, H5_SDK_URL, SMS_SCHEME_NAME, SMS_SIGN_NAME, SMS_TEMPLATE_CODE, SMS_TEMPLATE_PARAM. Private admin overrides persist through both load and save; encrypt AccessKey Secret and Security Token. Blank secrets preserve stored values; `clearAccessKeySecret` and `clearSecurityToken` explicitly remove them. Public capability JSON and admin projections never contain these secrets.

Disabled or incomplete methods make zero upstream calls. Use fixed HTTPS provider endpoints, bounded requests and safe error messages. H5 requires the operator-provided official SDK at a same-origin path or HTTPS URL. App clients receive their approved SDK key from onboarding, never server AccessKey credentials.

Aliyun one-click uses GetAuthToken with BizType=1, then GetPhoneWithToken for H5 or GetMobile for App. Only a complete mainland phone is accepted. Bare national numbers and explicit +86/0086 forms normalize to the same E.164 identity; an explicit other country prefix must never be reinterpreted as a national number. SMS sends provider-generated codes with ReturnVerifyCode=false; only `Model.VerifyResult === 'PASS'` verifies a code. An HTTP/API success envelope alone is insufficient.

### Durable challenges and account lifecycle

`PhoneChallenge` adapts the existing `email_verification_codes` table; no schema change is required. Purpose namespaces are `phone_sms_login`, `phone_sms_verify`, `phone_h5_login`. The email column contains an opaque namespace hash. H5 token issuance has no phone yet and uses an opaque `ref`. Persist server-owned target/context and a random challenge binding hash; never persist raw SMS codes or provider tokens. Parse `pending_context` only when it is a string; mysql2 JSON objects are already decoded.

Durable limits cover IP, phone, resend cooldown and provider-token digest replay. Charge wrong attempts durably, bound expiry/attempt count, and consume the exact challenge once. Named phone locks serialize send/verify and first account creation. Provider calls precede account transactions. Within the held account connection, re-read state, consume proof, create any pending MFA or issue final credentials atomically; publish cookies after commit. Use the same `totp:` lifecycle lock key as existing account security operations.

Login matches only a verified local phone. An existing unverified binding returns a conflict requiring account-side verification. New phone accounts need both global registration and explicit phone registration permission; QFLI creation restrictions remain authoritative. A profile challenge belongs to the original account, session, current phone and security state; another number or account cannot reuse it. Verification does not silently replace a phone binding.

### Continuations and browser behavior

Use explicit pending source `phone` and durable purpose `phone_mfa`; validate the saved channel/configuration before completion. Preserve TOTP/email MFA, session duration and saved browser accounts. Failed/pending login leaves the active account intact. Native OAuth handoff validates registered client, redirect, PKCE and scopes, returns an authorization code and creates no gateway session cookie. Redact phone data when the phone scope was not granted.

The login UI uses `new PhoneNumberServer()`, the official consent/number-completion flow, and an SMS/password fallback. Hold busy state until SDK termination or server completion, prevent conflicting login actions and ignore stale responses. Keep each SMS challenge paired with the unchanged target. Profile verification uses the bound phone only. Admin template JSON must round-trip as JSON text, and readiness reads `ready:{h5,app,sms}`.

Tianyi authorization encrypts and signs the documented WEB/H5 envelope, verifies callback HMAC before decryption, requires fresh timestamps and once-only browser-bound state, then exchanges the code server-side. Application-scoped openId establishes a third-party account identity only. It never grants phone/email verification. A provider key cannot silently change its application namespace. The unsupported UserInfo607 RSA flow is not part of this integration.

## 4. Validation & Error Matrix

| Condition | Result |
| --- | --- |
| Disabled/incomplete channel | Unavailable; no transport call |
| Invalid phone/code/context | Readable 400; no credentials |
| Expired/consumed/changed challenge | Reject; no new account/session |
| Cooldown or attempt budget exhausted | 429; durable limit remains charged |
| Existing unverified phone binding | Conflict; no automatic account claim |
| Provider non-success, partial phone, invalid callback | Fail closed; safe message only |
| Native OAuth without phone scope | Code handoff without gateway cookie or phone claims |
| Profile phone/session/security state changed | Reject before verification or revocation |

## 5. Good / Base / Bad Cases

- Good: SMS verifies an existing verified phone, completes configured TOTP, then issues the selected fixed-duration browser session.
- Base: all channels disabled; login still supports existing methods and makes no carrier request.
- Bad: interpret `+14155550123` as mainland `14155550123`, trust a submitted phone beside an SDK token, or infer phone verification from Tianyi openId.

## 6. Tests Required

Provider unit tests cover official request/response envelopes, independently verified RPC signatures and the published Tianyi XXTEA vector, transport errors, disabled-channel zero calls, redaction and canonicalization. API regressions exercise real routes with isolated provider transports: readiness/save/reload, one-time consumption, expiry, attempt/cooldown, conflicting targets, registration gates, current-session preservation, MFA, duration and native OAuth scope behavior. Browser tests exercise admin setup, H5 consent/fallback, SMS login, roster and profile verification at desktop/mobile sizes. Provider fixtures must not make real paid sends or credential-bearing external calls.

For this task, all executable checks, browser runs, ZIP builds and container validation run in GitHub. A passing earlier SHA does not certify a later revision. See [Deployment](./deployment.md) for publication gates. Cloud fixtures do not establish live SIM/provider approval or production-host rollout.

## 7. Wrong vs Correct

Wrong: `JSON.parse(row.pending_context)` unconditionally; consume a challenge before a later credential failure outside a transaction; treat `Code=OK` as successful SMS verification.

Correct: accept decoded JSON objects, use the held lifecycle transaction for exact proof consumption and issuance, and require the provider's explicit PASS result. Keep network requests outside that transaction and publish only after commit.
