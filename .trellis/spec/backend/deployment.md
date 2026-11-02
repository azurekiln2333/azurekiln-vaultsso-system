# Container Deployment and Image CI

## 1. Scope / Trigger

This contract applies to `Dockerfile`, `.dockerignore`, both `docker-compose*.yaml` files,
GitHub/CNB publishing, and changes to runtime environment or persisted files. Containers are an
additional distribution. Keep `npm run build:deploy` and its verified ZIP behavior intact.
The external MySQL service and host Baota/Nginx remain operator-managed.

## 2. Signatures

```sh
bash scripts/ci-backend.sh
npm run check
npm run build:deploy
docker compose -f docker-compose.build.yaml build
docker compose -f docker-compose.build.yaml up -d --wait gateway
docker compose -f docker-compose.yaml pull gateway
docker compose -f docker-compose.yaml run --rm --no-deps gateway npm run check:config
docker compose -f docker-compose.yaml run --rm --no-deps gateway npm run init-db
docker compose -f docker-compose.yaml up -d --wait gateway
```

`check:config` is static and does not migrate or connect to the database. `init-db` is an explicit
operator action after a backup, using a migration account. Production startup checks the schema
version and fails when it does not match; it never performs a migration.

## 3. Contracts

### Image and persistence

- Node 24 is shared by `.node-version`, Docker and CI. Keep the runtime non-root (`node`, UID/GID
  `1000:1000`). Install production dependencies in a separate stage with the lockfile and the
  `vendor/azurekiln-moderation-client-0.1.0.tgz` dependency available before `npm ci --omit=dev`.
- Only runtime code, production dependencies and the SDK tarball enter the final image.
  `.dockerignore` is an allowlist with final secret exclusions. Do not send `.env`, `keys/`,
  private key files, persistent `data/`, host font assets, tests or local dependencies into any
  build stage. Do not pass credentials as build arguments.
- Start `node server.js` directly with `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3146`.
  The healthcheck requests `http://127.0.0.1:3146/.well-known/openid-configuration` and requires a
  successful response. The listener starts after initial database/key checks. This is process
  liveness after bootstrap, not a continuous database/SMTP/provider readiness guarantee.

| Host path | Container path | Access / owner contract |
| --- | --- | --- |
| `.env` | `/app/.env` | Existing file, read-only, readable by UID 1000 |
| `keys/` | `/app/keys` | Existing directory, read-only; persistent signing key, optional DB CA / old JWKS |
| `public/assets/` | `/app/public/assets` | Existing directory, read-only; fonts/icons supplied separately |
| `data/` | `/app/data` | Existing directory writable by UID 1000; encrypted `admin-settings.json` |

The application reads the mounted `.env` itself. Compose overrides container listener settings
and `ADMIN_SETTINGS_FILE=/app/data/admin-settings.json`. Keep `JWT_SECRET`, signing keys and
admin settings stable across upgrades. Paths in `.env` must refer to container-visible files.
Never repair permissions by running the gateway as root; prepare only the dedicated deployment
copies for UID 1000. Suggested modes are `0600` for `.env`/private keys and `0700` for `data/`.

### Compose and environment

| Key | Default / meaning |
| --- | --- |
| `GATEWAY_IMAGE` | Operator's published image; example CNB path is not proof a repository exists |
| `COMPOSE_PROJECT_NAME` | `azurekiln-oauth2`; also identifies the gateway and Watchtower scope |
| `GATEWAY_BIND_HOST` | `127.0.0.1`, host reverse-proxy boundary |
| `GATEWAY_PORT` | `3146`, host port; container stays on 3146 |
| `WATCHTOWER_POLL_INTERVAL` | `600` seconds |
| `TRUST_PROXY` | Actual observed Nginx socket peer, explicit IP/CIDR only |
| `DB_HOST`, `DB_TLS`, `DB_TLS_CA_FILE` | Reachable external MySQL and verified production TLS |

Production pulls the selected image. Watchtower is pinned to `nickfedor/watchtower:1.23.2`,
enables label filtering, matches the project's scope and explicitly targets its gateway
container name. Its own update label is false. Never replace this with a host-wide updater or
automatically update unrelated applications. Keep project names distinct; avoid a `-p` value
that disagrees with the environment used to resolve scope/container names.

The local-build Compose file works alone, builds `azurekiln-oauth2:local`, sets its update label
false and puts Watchtower behind an inactive `auto-update` profile. Select files with `-f`;
stale `compose.yaml` or override files must not silently select another configuration.
Watchtower reuses the existing container configuration: environment, mount or Compose edits
need an explicit container recreation. Run
`docker compose -f docker-compose.yaml up -d --force-recreate --wait gateway` after such changes
(select the build file for a local image). The application reads `.env` once at startup; an atomic
file replacement may also leave the old container's bind mount on the old inode. Plain `up -d`
does not guarantee that this mounted file is refreshed. Pause updates before schema-changing upgrades.

Private registry pulls require an operator login. Watchtower separately needs a read-only
`config.json` mount at `/config.json` via a deployment-only override; do not commit this file.
Explicit `-f` selection does not auto-load that override: use both files, for example
`docker compose -f docker-compose.yaml -f docker-compose.private.yaml up -d --force-recreate watchtower`.
Registry credentials belong in CI secrets, CNB built-in auth or an operator's Docker auth store.

### Database and proxy boundary

Container `127.0.0.1` is not the host MySQL server. Use a reachable DNS/address and, for every
non-loopback production DB host, `DB_TLS=true`; a private CA must be readable in the container
and hostname verification stays enabled. Do not add a mandatory database service or weaken
runtime validation for containers. The same reachability check applies to SMTP/moderation URLs.

Host Nginx proxies to the published loopback port and sends:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Real-Port $remote_port;
```

Inspect the project network gateway and confirm the actual socket peer. Trust that explicit
address (`/32`, or `/128` for IPv6), not an assumed `172.x` address, all private networks or `true`.
Retain [Proxy Addresses](./proxy-addresses.md): Express walks the trusted chain for the client IP;
`readRequestSource` accepts `X-Real-Port` only from a trusted socket peer. Verify new login audit
rows after a proxy switch; a healthy discovery response alone does not prove audit correctness.

### Publishing

- `scripts/ci-backend.sh` performs locked dependency installation and `npm run check` with
  fail-fast behavior. Shell files use LF. GitHub runs it for every branch push, `v*` tag and PR.
  Only successful `main`/`v*` push runs can publish to lower-case `ghcr.io/<owner>/<repo>` using
  `GITHUB_TOKEN` and job-level `packages: write`; PRs cannot publish.
- CNB `main` push and `v*` tag pipelines run the same checks before image build/login/push.
  Default target is `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}`, user `cnb`, password
  the platform-issued `CNB_TOKEN`. Optional repository settings `CNB_IMAGE`, `CNB_REGISTRY`,
  `CNB_REGISTRY_USER`, `CNB_REGISTRY_PASSWORD` select another registry; passwords are secrets.
- Main publishes `main`, `latest`, and a commit-specific tag. Version events publish the
  validated `v*` Docker tag and a commit-specific tag; only stable `vMAJOR.MINOR.PATCH` moves
  `latest`. Prereleases never move `latest`. Reject invalid/oversized tag input before Docker.
  Both platforms build independently; identical source does not guarantee identical digests.

## 4. Validation & Error Matrix

| Condition | Expected result |
| --- | --- |
| Build without the local SDK tarball | Dependency installation fails; never omit the SDK |
| `.env`, private key, database credentials present on host | Excluded from all build layers |
| Required mount source absent or unreadable by UID 1000 | Start/config check fails; operator prepares the path |
| Remote DB with `DB_TLS=false`, invalid secret, missing key or schema mismatch | Production validation/startup fails |
| Discovery endpoint unavailable/non-successful | Healthcheck fails; inspect gateway logs |
| Local build with default profiles | Gateway auto-update label false; Watchtower inactive |
| Another application's container, or Watchtower itself | Outside the updater's target/filter set |
| GitHub PR/feature push | Checks run; image publishing job skipped |
| CI check failure | No image build/push in the publishing path |
| Invalid version/Docker tag | Publishing fails before tagging/pushing |
| Prerelease version | Version/commit tags only; existing latest remains unchanged |
| Docker CLI/daemon absent locally | Explicitly report build/start unverified; YAML parsing is not a substitute |

## 5. Good / Base / Bad Cases

- Good: copy existing secrets/assets/settings to a new dedicated deployment directory, check
  permissions and TLS, back up/migrate explicitly, validate on a spare loopback port, switch only
  this gateway's Nginx upstream, verify login/MFA/refresh/audit, then enable scoped Watchtower.
- Base: build locally against a prepared isolated external DB with the build Compose file;
  no updater starts. Existing ZIP packaging still passes its asset and exclusion checks.
- Bad: start with host-loopback DB settings, trust every Docker/private-network address, generate
  replacement signing secrets during an upgrade, or let automatic image updates run migrations.

## 6. Tests Required

Run `npm run check` and `npm run build:deploy`. Parse both Compose files, GitHub and CNB YAML
with duplicate-key rejection; review publishing event gates, test dependencies, inherited local
labels/profiles and credential scope. Validate shared Bash scripts and main/stable/prerelease/
invalid-tag behavior. If Docker exists, run the standalone local build and start it against an
isolated MySQL with valid test-only production config until healthy. Check non-root identity,
mount access, vendor availability, and image contents for secret exclusions. If Docker is absent,
report those runtime checks as unexecuted. Never trigger remote CI or touch a production server
to compensate for unavailable local tooling.

## 7. Wrong vs Correct

Wrong: `COPY . .` with deployment secrets in the context, root runtime, Watchtower without
label/scope/target filters, a local image opted into updates, `TRUST_PROXY=true`, or an automatic
`init-db` entrypoint.

Correct: allowlisted build context plus explicit runtime copies, `USER node`, persisted read-only
secrets and writable admin data, scoped/targeted opt-in updates, disabled local updates, verified
proxy peers, and an explicit backed-up migration before traffic switches.
