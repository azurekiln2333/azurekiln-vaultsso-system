# Aliyun PNVS RPC signing notes

Official documentation and SDK source inspected on 2026-11-24. No provider request, package installation, local test, check or build was run. `services/phone-auth.js` was read only.

## Fixed service contract

- Endpoint: `https://dypnsapi.aliyuncs.com/`; API version: `2017-05-25`. The PNVS integration overview names this central endpoint and links to the V3 signing guide [S1]. This is **Dypnsapi**, not the separate Dysmsapi SMS product.
- The official product SDK declares all five task actions (`GetAuthToken`, `GetPhoneWithToken`, `GetMobile`, `SendSmsVerifyCode`, `CheckSmsVerifyCode`) as HTTPS, POST, pathname `/`, style `RPC`, auth type `AK`, response `json`; their action parameters are placed in `OpenApiRequest.query` [S2].
- The current SDK defaults to `ACS3-HMAC-SHA256`. It also explicitly retains the legacy RPC path when SDK `signatureAlgorithm` is `v2`; that branch emits wire `SignatureVersion=1.0` and `SignatureMethod=HMAC-SHA1` [S3]. Do not confuse the SDK selector `v2` with the wire signature version.

## Existing adapter: legacy RPC is an official compatibility path

The new adapter currently implements legacy signing. Its core construction matches the official RPC signing documentation [S4] and the SDK compatibility branch [S3]; the recommendation for V3 alone is not evidence that this branch is invalid. Keep one complete scheme; do not mix V3 headers with legacy signature parameters.

Required legacy common parameters:

| Parameter | Value |
| --- | --- |
| `Action` | Exact action name |
| `Version` | `2017-05-25` |
| `Format` | `JSON` |
| `AccessKeyId` | Server-configured AK ID |
| `SignatureMethod` | `HMAC-SHA1` |
| `SignatureVersion` | `1.0` |
| `SignatureNonce` | Fresh unique random value per request |
| `Timestamp` | UTC `YYYY-MM-DDTHH:mm:ssZ` |
| `SecurityToken` | Include and sign only when using STS credentials |

Combine common and action parameters, excluding `Signature`. Sort keys lexically; percent-encode every key/value as UTF-8 RFC3986, leaving only letters/digits/`-_.~` unescaped. Join encoded pairs with `&`. Calculate:

```text
stringToSign = "POST&%2F&" + percentEncode(canonicalPairs)
signature = Base64(HMAC_SHA1(UTF8(accessKeySecret + "&"), UTF8(stringToSign)))
```

Transmit `Signature` as another URL/form-encoded parameter; do not pre-encode its Base64 value twice. For form bodies use `application/x-www-form-urlencoded`, not JSON. The official RPC core signs the merged query and form parameters, so the transport serialization and canonical signing encoding need not be textually identical, but must decode to exactly the same values [S3, S4]. Preserve `false`, `0`, punctuation and Unicode; serialize `TemplateParam` JSON once before signing/transmitting it.

In `services/phone-auth.js`, `buildStringToSign`, `signParams` and the common parameters follow this legacy rule on inspection. Its URLSearchParams form encoding is separate from canonical RFC3986 encoding. No live success is claimed; cloud CI should verify a published fixed signature vector and inspect outgoing parameters independently, not recompute an expected value with the same helper.

## If choosing the current V3 scheme

V3 uses action/version headers, not the legacy common query parameters [S5]:

```text
host: dypnsapi.aliyuncs.com
x-acs-action: <action>
x-acs-version: 2017-05-25
x-acs-date: <UTC timestamp>
x-acs-signature-nonce: <fresh random value>
x-acs-content-sha256: <lowercase hex SHA256 of exact body bytes>
x-acs-security-token: <STS token, when present>
```

To follow the product SDK, put action fields in the canonical query and send an empty POST body; its SHA256 is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` [S2, S5]. Sort/encode query fields; lowercase and sort signed header names, trim values, and end every canonical header entry with a newline. Include `host` and every `x-acs-*` header in the signature. Then [S5]:

```text
canonical = method + "\n" + "/" + "\n" + query + "\n"
          + canonicalHeaders + "\n" + signedHeaderNames + "\n" + bodyHash
toSign = "ACS3-HMAC-SHA256\n" + lowercaseHex(SHA256(canonical))
signature = lowercaseHex(HMAC_SHA256(accessKeySecret, toSign))
Authorization = "ACS3-HMAC-SHA256 Credential=" + accessKeyId
              + ",SignedHeaders=" + signedHeaderNames + ",Signature=" + signature
```

The V3 secret has **no appended ampersand** and its signature is hexadecimal, not Base64. Hash exactly the transmitted body; do not silently serialize an empty body as `{}`. The product SDK also exposes an optional business `Version` field for `GetAuthToken`, separately from API version [S2]; do not allow an action parameter to overwrite the legacy common API `Version` accidentally.

## Official sources

- [S1: PNVS integration overview](https://help.aliyun.com/zh/pnvs/developer-reference/sdk-integration-overview) — endpoint/version and recommended signing link.
- [S2: Official Dypnsapi TypeScript SDK client](https://github.com/aliyun/alibabacloud-typescript-sdk/blob/master/dypnsapi-20170525/src/client.ts) — action metadata, query parameters and central endpoint rule.
- [S3: Official OpenAPI TypeScript core](https://github.com/aliyun/darabonba-openapi/blob/master/ts/src/client.ts) — `callApi`, `doRPCRequest`, `doRequest`; default ACS3 and explicit legacy RPC branch.
- [S4: Official RPC signing mechanism](https://help.aliyun.com/zh/sdk/product-overview/rpc-mechanism/) — legacy common parameters, RFC3986, HMAC-SHA1 and form rules.
- [S5: Official V3 request/signature mechanism](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature) — canonical request, headers, payload hash and Authorization format.
