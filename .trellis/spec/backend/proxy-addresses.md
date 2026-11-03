# Reverse Proxy Addresses

## 1. Scope / Trigger
Client IP and source-port recording behind local Baota/Nginx, direct access or explicitly configured remote proxies.

## 2. Signatures
`readRuntimeConfig(env).trustedProxies`, `app.set('trust proxy', addresses || false)`,
`getClientIp(req)`, `readRequestSource(req, trustedProxies)` and `isTrustedProxy(address, trustedProxies)`
define this boundary.

## 3. Contracts

### Trust policy
`config/runtime.js` parses `TRUST_PROXY` into explicit IP/CIDR entries. Undefined uses only
`127.0.0.1/32,::1/128`, matching Baota/Nginx forwarding to the default localhost listener. Explicit
empty disables trust; remote/container proxies require their actual addresses. Never use
unrestricted boolean trust.

### Client IP
`getClientIp(req)` uses Express `req.ip`, which traverses forwarded addresses from the socket
toward the first untrusted hop. Nginx must forward `X-Forwarded-For $proxy_add_x_forwarded_for`, so
incoming spoofed earlier entries do not replace the immediate client. **Do not** read an arbitrary
`X-Real-IP` header or the leftmost forwarded address. CDN deployments must configure their known
sources at Nginx.

### Source port (compliance)
`services/request-source.js` owns the port rule, because `443` is useless for audit purposes:

| Socket peer | IP source | Port source |
| --- | --- | --- |
| trusted proxy (in `TRUST_PROXY`) | `req.ip` (Express chain walk) | `X-Real-Port` when it is a valid 1–65535 integer, else `req.socket.remotePort` |
| untrusted / direct client | `req.ip` (equals socket address) | `req.socket.remotePort` only — `X-Real-Port` is ignored |

`X-Real-Port` must be set by the reverse proxy itself (`proxy_set_header X-Real-Port $remote_port`).
A value coming from the client is discarded whenever the peer is not a trusted proxy, and an
out-of-range or non-numeric value always falls through to the socket port (`normalizePort`).

`readRequestSource` returns `{ ip, port, proxy }` and is the only supported way to read a source
port. `recordLoginLog` in `server.js` writes `ip`/`source_port`; nothing else should read
`x-real-port` directly.

### Nginx (required, user-applied)
```nginx
location / {
    proxy_pass http://127.0.0.1:3146;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # compliance audit: real client address and TCP source port
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Real-Port       $remote_port;
}
```
`TRUST_PROXY` must contain the address Nginx connects from (default `127.0.0.1/32,::1/128` already
covers this). If Nginx runs in a container or on another host, add that explicit address.

The default external-MySQL Compose mode uses Linux host networking: keep the same loopback
listener and default trust above. The optional `docker-compose.mysql.yaml` changes the gateway
to bridge networking and publishes only on host `127.0.0.1`. Its frontend subnet/gateway are
fixed by `GATEWAY_FRONT_SUBNET=172.30.46.0/24` and `GATEWAY_FRONT_GATEWAY=172.30.46.1`; the overlay
sets `TRUST_PROXY` to the configured gateway `/32`, overriding a legacy loopback `.env` value.
If the subnet overlaps an existing network, change subnet and gateway together. Inspect the
actual project network and test new audit IP/port records after switching; never trust a whole
Docker network. See [Deployment](./deployment.md) for mode/port and private-DB contracts.

### Retention interaction
Login records written through this path feed `login_logs`, which is retained for 365 days
(`LoginLogModel.RETENTION_DAYS`). Existing localhost records cannot be reconstructed; new
`login/user/session/audit/rate-limit` records use the resolved address. Service environment
overrides `.env`, including explicit empty values.

## 4. Validation & Error Matrix
| Input | Result |
| --- | --- |
| Missing TRUST_PROXY | Exact IPv4/IPv6 localhost addresses |
| Explicit empty | No forwarding trust |
| Explicit IP/CIDR | Only those proxy addresses |
| Boolean true, invalid IP or unrestricted /0 | Startup rejects configuration |
| `X-Real-Port: 54321` from a trusted peer | `source_port = 54321` |
| `X-Real-Port: 54321` from an untrusted peer | ignored; socket port recorded |
| `X-Real-Port: 70000`, `0`, `abc` | ignored; socket port recorded |
| `X-Forwarded-For` with a spoofed leading hop | ignored; `req.ip` wins |

## 5. Good / Base / Bad Cases
- Good: localhost Nginx appends the actual client after an incoming spoofed address and sets
  `X-Real-Port $remote_port`; Express resolves the actual IP and the log stores the real peer port.
- Base: no forwarded headers; socket address and socket port are retained.
- Bad: directly reading the first forwarded value accepts arbitrary spoofed IPs; reading
  `X-Real-Port` without checking the socket peer accepts a client-chosen port.

## 6. Tests Required
`tests/proxy-ip.test.js` covers runtime policy, local forwarded chains and direct socket fallback.
`tests/login-audit.test.js` covers recorded user id/platform/type/IP/source port for login and
registration, spoofed `X-Forwarded-For`/`X-Real-IP`/`X-Real-Port` being ignored, trusted-peer
`X-Real-Port` acceptance, CIDR matching (IPv4, IPv6, IPv4-mapped IPv6), 365-day retention and the
admin listing fields. `tests/schema.test.js` proves the `login_logs` compliance columns migrate
idempotently. `tests/security.test.js` checks that spoofed forwarding headers cannot evade rate
limits or change stored user/session/log IPs when proxy trust is disabled.

## 7. Wrong vs Correct
Wrong: `trust proxy=true`; `X-Real-IP` read without source verification; `X-Real-Port` read from any
peer; a native prepared `SHOW COLUMNS ... LIKE ?` column probe, whose `LIKE` syntax requires a
literal pattern rather than a parameter marker.

Correct: explicit trusted proxy addresses and Express chain traversal; `execute()` for every
column probe using
`SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`
with `[tableName, columnName]` as values, matching `columnExists` in `db/init.js`; source port read
only through `readRequestSource`; upstream proxy handles any CDN trust.
