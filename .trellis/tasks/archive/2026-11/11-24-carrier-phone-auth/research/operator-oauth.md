# Tianyi operator account authorization research

Researched 2026-11-24 (Asia/Shanghai). Official public documentation and repository source reads only; no local checks, builds, provider authentication calls, or code changes.

## Conclusion

**The existing generic OAuth2 adapter cannot connect to the documented Tianyi WEB/H5 login by configuration alone.** The official endpoints use encrypted request/callback envelopes, proprietary parameter names, and signed token requests. A dedicated Tianyi adapter is required. The presence of `oauth2` in their URLs does not establish standard OAuth2/OIDC compatibility.

### Selected implementation scope: account identity without UserInfo

The coordinator selected token-response `openId` only. This is viable: [guide 505](https://id.dlife.cn/html/api_detail_505.html) explicitly returns a required application-specific user identifier from the authenticated code exchange. **Inference from that contract:** validated callback HMAC, browser-bound one-time state, and the successful server-to-provider HTTPS code exchange establish authority for `(provider, appId, openId)`; UserInfo607 is unnecessary for this identity-only login. Preserve that application namespace across configuration changes; never accept the browser's asserted identifier. Reject failed HTTP responses, malformed identifiers, mismatching/missing application identifiers and stale response timestamps.

This path asserts no phone/email ownership. PNVS independently establishes phone authority. The RSA key and UserInfo ambiguities below are therefore outside the selected scope; only appId/appSecret, callback validation and XXTEA interoperability are required here. Cloud CI must compare the official external vector, not merely a local encrypt/decrypt roundtrip.

## Official sources and contract

### WEB authorization — [official guide 469](https://id.189.cn/html/api_detail_469.html)

- GET `https://open.e.189.cn/api/logbox/oauth2/separate/unifyAccountLogin.do`; documented as an embedded login frame supporting QR, password and SMS login.
- Public fields: `appId`, `clientType=10010`, `format=redirect`, `version=v2.0`, `paras`, `sign`.
- `paras` encrypts joined `key=value&...` parameters using XXTEA and appSecret; required content: millisecond `timeStamp`, `returnURL`. Include random `state` (maximum 32 characters). Optional `pageKey=normal|popping`, `regReturnUrl` and provider auto-login preferences.
- Request signature: uppercase hexadecimal `HMAC-SHA1(appId + clientType + format + version + paras, appSecret)`.
- Callback query is `appId`, `paras`, `sign`; signature input is `appId + paras`. Decrypt `paras` to obtain `result` (0 success), `code`, `state`, `timeStamp`. Code is single-use, valid two minutes. Callback time is `yyyy-MM-dd HH:mm:ss`, UTC+8, and the guide requires freshness validation.
- The guide describes appSecret-to-hex conversion and uppercase encryption output; obtain its linked official demo to resolve exact byte/XXTEA encoding before claiming interoperability.

### H5 authorization — [official guide 467](https://id.189.cn/html/api_detail_467.html)

GET `https://open.e.189.cn/api/logbox/oauth2/separate/autoLogin.do`, with `clientType=20100`, `format=redirect`, `version=v2.1`. Uses the same documented XXTEA/HMAC envelope and encrypted callback pattern. Required inner fields are `timeStamp` and `returnURL`; include `state`. Optional `loginType` controls password/SMS fallback (`1|2`, `2|1`, `1`, `2`); default `1|2`. This is a provider-hosted page, distinct from an embedded one-click SDK.

### Code exchange — [official guide 505](https://id.189.cn/html/api_detail_505.html)

POST form to `https://open.e.189.cn/api/logbox/oauth2/accessToken.do`:

```text
appId=<application id>
grantType=authorization_login
code=<decrypted callback code>
format=json
sign=UPPER_HEX(HMAC-SHA1(appId + code + format + grantType, appSecret))
```

Success is `result=10000`; documented fields include `accessToken`, `atExpiresIn`, `refreshToken`, `rfExpiresIn`, `openId`, `appId`, `timeStamp`. These are camelCase, not standard OAuth token field names. `loginMode` distinguishes passwordless, SMS, password, device verification, QR, uplink SMS and existing-login reuse: do not label every successful account authorization “one-click”. The timestamp is UTC+8 and requires freshness validation.

### Account user information — [official guide 607](https://id.189.cn/html/api_detail_607.html)

Server-side POST/GET form to `https://open.e.189.cn/openapi/asymauth/gbcs/getUserInfo.do`; POST recommended. Outer fields: `clientId`, `timeStamp`, `format=json`, `params`, `sign`. `params` XXTEA-encrypts `accessToken=<token>` using appSecret. The signing formula is shown as `RSA(APPId + format + params + timeStamp, RSA_Private_key)`; the page inconsistently names the actual field `clientId` and formula `APPId`, and does not specify the signature digest/padding. Confirm with the linked demo/support; do not silently guess.

Success `result=0`; `data` is encrypted with the application's registered RSA public key. Decrypted JSON includes required `mobile` and application-scoped `openId`, optional nickname/avatar/email/operator. No `sub`, ID token, `email_verified`, or `phone_number_verified` claim is documented. Do not invent those claims or treat optional email as verified. The page describes 1024-bit PKCS#8 key registration; confirm the current provisioned contract and supported cryptographic implementation before enabling.

### SDK path is separate — [official guide 481](https://id.189.cn/html/api_detail_481.html)

`https://open.e.189.cn/auth/sdkcodeinfo.do` consumes **both** `accessCode` and `authCode`, XXTEA-encrypted in `params`; outer fields are `appId`, `timeStamp`, `format`, `params`, `sign`. It explicitly specifies `SHA1WithRSA`, RSA/PKCS#1 padding, hexadecimal ciphertext, and RSA-encrypted response `data` containing `mobile` and optional `state`. It is not a replacement for WEB/H5 code exchange. Do not borrow this page's SHA1WithRSA specification to fill guide 607's ambiguity without provider confirmation.

Its section 2.4 publishes this non-secret algorithm reference vector (copied for CI interoperability verification, **not executed locally**):

```text
XXTEA key: sAecMFcAlIXes93VaWXgr3jgMup4Y0a6
plaintext: a=1&b=2&c=3
ciphertext hex: f6c45d934cde581e908d02487720161d
```

The SDK's documented RSA encryption uses 128-byte blocks and at most 117 plaintext bytes per block for its 1024-bit key. That concrete description belongs to the SDK guide; guide 607 does not independently state it.

## Keys, callback validation, and unresolved interoperability details

For the expanded UserInfo607 path only, secrets are provider-issued appSecret and **application-owned RSA private key**. The application's matching **public** key is registered with Tianyi; the private key remains server-side. WEB/H5 request/callback authentication uses appSecret/HMAC, not that RSA pair. User-info requests use the private key for signing, and encrypted responses need that same application's private key for decryption. No separate provider RSA public key is specified for the above WEB/H5 flow. The selected identity-only path does not require this RSA provisioning.

Implementation recommendation: select the configured appId before processing the callback; reject a different callback appId, compare the HMAC before decrypting, then require successful result, valid UTC+8 timestamp, and a one-time state bound to the initiating browser and intent. A 16-byte random value represented as 32 hex characters fits Tianyi's state limit; the current generic 32-byte base64url state exceeds it. Exchange the decrypted code only on the server. Match token/user-info openId when both are returned; never accept browser-supplied mobile/openId as provider proof.

Still missing from the retrieved WEB/H5+607 contract: exact XXTEA key byte conversion/packing and callback output case rules; user-info RSA signature digest, padding/encoding, and response ciphertext encoding/block handling. [Official companion guide 629](https://id.189.cn/html/api_detail_629.html) repeats the same `clientId`/`APPId` and unspecified `RSA(...)` notation, so it does not close these gaps. Do not mark them verified merely because a plausible implementation is internally consistent.

Official linked demos for resolving those details:

- [User-info API demo](https://cloud.189.cn/web/share?code=q2IfMn2IrQJz), published access code `2yob` (linked from guide 607).
- [H5 PHP demo](https://cloud.189.cn/web/share?code=R3u26bQRjmY3), published access code `mu5r` (guide 467).
- [H5 Java demo](https://cloud.189.cn/web/share?code=VZfABfFv6Fru), published access code `2dl0` (guide 467).
- [WEB demo](https://cloud.189.cn/web/share?code=2YriAbfUzYrm), published access code `9llc` (guide 469).

The public share landing page returned a JavaScript application shell; the available browser tool reported “The browser access host is unavailable”. This research therefore did not retrieve demo contents. This is a retrieval limitation, not evidence that operator onboarding or the share is unavailable. The next researcher can open these exact official links or obtain the same examples from the provisioned support channel.

## Repository compatibility (read-only findings)

There is no `services/oidc.js`. The adapter is in `server.js`:

- Around 2547: builds plaintext standard `response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, optional PKCE.
- Around 2600: callback expects plaintext query `state` and `code`.
- `exchangeOidcCode` around 1020: fixed `grant_type=authorization_code`; only Basic/client-secret-post authentication.
- `fetchOidcUserinfo` around 1036 and callback around 2631: expects `access_token`; can send Bearer/form credentials and map JSON paths, but cannot sign/encrypt requests or decrypt results.
- `models/OidcProvider.js`: URL, claim-path and HTTP-method options cannot bridge the above protocol differences.

Recommendation: dedicated server-side Tianyi transport with callback validation and decrypted, typed identity projection; reuse existing downstream account/session/MFA policies. Bind identity to provider/application plus `openId`; keep phone normalization, linking/conflict rules and proof provenance explicit. Provider login persistence must not extend local fixed session deadlines.

## Provisioning and honest delivery boundary

The WEB/H5 guides require enterprise developer enrollment, an application appId/appSecret, and login capability permission. Guide 607 additionally requires registering the application's public key in the provider console. Public pages were readable; linked demos were identified but their executable crypto implementation was **not** retrieved or validated in this research. No provisioned credentials or live provider success is established.

If onboarding-specific docs/demos or approved credentials cannot be obtained, deliver a disabled configuration entry with a precise “awaiting Tianyi provisioning/crypto contract” status. Generic OAuth2 remains appropriate only if the operator supplies a separately documented standard endpoint set; do not prefill invented endpoints/claims or advertise this researched protocol as live merely because URLs are saved. Hosted provider SMS fallback also does not implement this project's independent SMS-sending API.
