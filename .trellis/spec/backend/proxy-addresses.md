# Reverse Proxy Addresses

## 1. Scope / Trigger
Client IP recording behind local Baota/Nginx, direct access or explicitly configured remote proxies.

## 2. Signatures
`readRuntimeConfig(env).trustedProxies`, `app.set('trust proxy', addresses || false)` and `getClientIp(req)` define this boundary.

## 3. Contracts
`config/runtime.js` parses `TRUST_PROXY` into explicit IP/CIDR entries. Undefined uses only `127.0.0.1/32,::1/128`, matching Baota/Nginx forwarding to the default localhost listener. Explicit empty disables trust; remote/container proxies require their actual addresses. Never use unrestricted boolean trust.

`getClientIp(req)` uses Express `req.ip`, which traverses forwarded addresses from the socket toward the first untrusted hop. Nginx must forward `X-Forwarded-For $proxy_add_x_forwarded_for`, so incoming spoofed earlier entries do not replace the immediate client. Do not directly read arbitrary `X-Real-IP` or the leftmost forwarded address. CDN deployments must configure their known sources at Nginx.

New login/user/session/audit/rate-limit records use this resolved address. Existing localhost records cannot be reconstructed. Service environment overrides .env, including explicit empty values.

## 4. Validation & Error Matrix
| Input | Result |
| --- | --- |
| Missing TRUST_PROXY | Exact IPv4/IPv6 localhost addresses |
| Explicit empty | No forwarding trust |
| Explicit IP/CIDR | Only those proxy addresses |
| Boolean true, invalid IP or unrestricted /0 | Startup rejects configuration |

## 5. Good / Base / Bad Cases
- Good: localhost Nginx appends actual client after an incoming spoofed address; Express resolves actual client.
- Base: no forwarded headers; socket address is retained.
- Bad: directly reading the first forwarded value accepts arbitrary spoofed IPs.

## 6. Tests Required
`tests/proxy-ip.test.js` covers runtime policy, local forwarded chains and direct socket fallback. `tests/security.test.js` checks that spoofed forwarding headers cannot evade rate limits or change stored user/session/log IPs when proxy trust is disabled.

## 7. Wrong vs Correct
Wrong: `trust proxy=true` or `X-Real-IP` read without source verification.

Correct: explicit trusted proxy addresses and Express chain traversal; upstream proxy handles any CDN trust.
