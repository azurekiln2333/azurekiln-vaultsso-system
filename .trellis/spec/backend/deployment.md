# Container Deployment and Image CI

## 1. Scope / Trigger

This contract applies to `Dockerfile`, `.dockerignore`, all `docker-compose*.yaml` files,
GitHub/CNB publishing, and changes to runtime environment or persisted files. Containers are an
additional distribution. Keep `npm run build:deploy` and its verified ZIP behavior intact.
Host Baota/Nginx and external databases remain operator-managed. Bundled MySQL is an explicit
deployment choice with its own persistent volume; it never imports an existing database.

## 2. Signatures

```sh
bash scripts/ci-backend.sh
npm run check
npm run build:deploy
bash scripts/deploy-docker.sh --db external
bash scripts/deploy-docker.sh --db bundled [--watchtower] [--backup-confirmed] [--skip-migrate] [--override FILE]
docker compose -f docker-compose.build.yaml build
docker compose -f docker-compose.build.yaml up -d --wait gateway
docker compose -f docker-compose.yaml -f docker-compose.mysql.yaml config --quiet
docker compose -f docker-compose.yaml -f docker-compose.mysql.yaml ps
```

`check:config` is static and does not migrate or connect to the database. `init-db` is an explicit
operator action after a backup, using a migration account. Production startup checks the schema
version and fails when it does not match; it never performs a migration.

The deployment command defaults to `external`. Require Linux Docker Engine and Compose
**2.33.1+** (`!reset` clears inherited host networking; `gw_priority` keeps frontend egress).
Always select files with `-f`; an unrelated implicit override must not change deployment behavior.

## 3. Contracts

### Image and persistence

- Node 24 is shared by `.node-version`, Docker and CI. Keep the runtime non-root (`node`, UID/GID
  `1000:1000`). Install production dependencies in a separate stage with the lockfile and the
  `vendor/azurekiln-moderation-client-0.1.0.tgz` dependency available before `npm ci --omit=dev`.
- Only runtime code, production dependencies and the SDK tarball enter the final image.
  `.dockerignore` is an allowlist with final secret exclusions. Do not send `.env`, `keys/`,
  `data/`, private key files, tests or local dependencies into any
  build stage. Do not pass credentials as build arguments. `public/assets/` is copied in on purpose:
the image is the single source of fonts and icons.
- Start `node server.js` directly with `NODE_ENV=production`. External Compose preserves
  `HOST`/`PORT` (defaults `127.0.0.1:3146`); bundled Compose uses `0.0.0.0:3146` internally.
  The healthcheck requests `http://127.0.0.1:${PORT}/.well-known/openid-configuration` and requires a
  successful response. The listener starts after initial database/key checks. This is process
  liveness after bootstrap, not a continuous database/SMTP/provider readiness guarantee.

| Host path | Container path | Access / owner contract |
| --- | --- | --- |
| `.env` | `/app/.env` | Existing file, read-only, readable by UID 1000 |
| `data/` | `/app/data` | Existing directory writable by UID 1000; encrypted `admin-settings.json` |
| `data/keys/` | `/app/data/keys` | Nested bind inside the writable `data/` mount, read-only; persistent signing key, optional DB CA / old JWKS |

The deployment directory therefore needs only `docker-compose.yaml`, `.env` and `data/` (plus
`docker-compose.mysql.yaml` for bundled MySQL and `scripts/deploy-docker.sh` for the one-shot
flow). `public/assets/` is baked into the image and is deliberately not mounted, so host fonts and
icons cannot drift from the shipped stylesheet. Nested `data/keys/` read-only over a writable
`data/` is what keeps the signing private key unwritable while `admin-settings.json` stays
persisted; the checker rejects `OIDC_SIGNING_KEY_FILE` values outside `data/keys/`, including the
legacy top-level `keys/` layout.

The application reads the mounted `.env` itself. Compose overrides container listener settings
as described per mode and `ADMIN_SETTINGS_FILE=/app/data/admin-settings.json`. Keep `JWT_SECRET`, signing keys and
admin settings stable across upgrades. Paths in `.env` must refer to container-visible files.
Never repair permissions by running the gateway as root; prepare only the dedicated deployment
copies for UID 1000. Suggested modes are `0600` for `.env`/private keys and `0700` for `data/`
and `data/keys/`.

### Compose and environment

| Key | Default / meaning |
| --- | --- |
| `GATEWAY_IMAGE` | Operator's published image; example CNB path is not proof a repository exists |
| `COMPOSE_PROJECT_NAME` | `azurekiln-oauth2`; also identifies the gateway and Watchtower scope |
| `HOST`, `PORT` | External host-mode listener; defaults `127.0.0.1`, `3146` |
| `GATEWAY_PORT` | Bundled-only host loopback port, default `3146`; container stays on 3146 |
| `GATEWAY_FRONT_SUBNET`, `GATEWAY_FRONT_GATEWAY` | Bundled frontend `172.30.46.0/24`, `172.30.46.1`; change together on collision |
| `WATCHTOWER_POLL_INTERVAL` | `600` seconds |
| `TRUST_PROXY` | External reads original `.env`; bundled overrides to frontend gateway `/32` |
| `DB_HOST`, `DB_TLS`, `DB_TLS_CA_FILE` | External MySQL; loopback exempt, verified TLS required for remote hosts |
| `DB_BUNDLED` | Explicit true/false; Compose forces false externally, true only for private bundled mode |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Existing app credentials; also bootstrap bundled database/app user on an empty volume |
| `MYSQL_ROOT_PASSWORD` | Bundled-only separate generated root credential, required by overlay |
| `MYSQL_INNODB_BUFFER_POOL_SIZE`, `MYSQL_MAX_CONNECTIONS` | Bundled tuning, defaults `128M`, `50`; Performance Schema disabled |

Production pulls the selected image. Watchtower is opt-in via the `auto-update` profile and
`--watchtower`; it is pinned to `nickfedor/watchtower:1.23.2`,
enables label filtering, matches the project's scope and explicitly targets its gateway
container name. Its own update label is false. Never replace this with a host-wide updater or
automatically update unrelated applications. Keep project names distinct; avoid a `-p` value
that disagrees with the environment used to resolve scope/container names.

The local-build Compose file works alone, builds `azurekiln-oauth2:local`, sets its update label
false and inherits the inactive updater profile. It can also be combined with the MySQL overlay.
Watchtower reuses the existing container configuration: environment, mount or Compose edits
need an explicit container recreation. Run
`docker compose -f docker-compose.yaml up -d --force-recreate --wait gateway` after such changes
(select the build file for a local image). The application reads `.env` once at startup; an atomic
file replacement may also leave the old container's bind mount on the old inode. Plain `up -d`
does not guarantee that this mounted file is refreshed. Pause updates before schema-changing upgrades.

Private registry pulls require an operator login. Watchtower separately needs a read-only
`config.json` mount at `/config.json` via a deployment-only override; do not commit this file.
Explicit `-f` selection does not auto-load that override: use both files, for example
`docker compose -f docker-compose.yaml --profile auto-update -f docker-compose.private.yaml up -d --force-recreate watchtower`.
Include `-f docker-compose.mysql.yaml` when operating bundled mode. The deployment script accepts
an explicit `--override FILE`, used for validation, pull, checks, migration and startup consistently.
Registry credentials belong in CI secrets, CNB built-in auth or an operator's Docker auth store.

### Database and proxy boundary

External mode uses `network_mode: host`, with no `ports` or mandatory MySQL service. Linux host
loopback reaches existing Baota MySQL, SMTP and moderation addresses directly. Keep existing
`DB_HOST=127.0.0.1`, `HOST=127.0.0.1` and loopback proxy defaults; no bind/grant/TLS changes are
needed for this single-host installation. Other production DB hosts still require `DB_TLS=true`,
a readable private CA when used and verified server identity. Do not disable certificate checks.

Bundled mode layers `docker-compose.mysql.yaml`, resets host networking and publishes the gateway
only to `127.0.0.1:${GATEWAY_PORT}:3146`. Gateway joins a fixed frontend bridge and an `internal:
true` DB network. Frontend `gw_priority: 1` preserves SMTP/OAuth/moderation egress. MySQL joins
only the private DB network, publishes no host port and is pinned to `mysql:8.4.13`; disable its
updater label. Its `mysql-data` volume persists independently of gateway recreation. The app
depends on healthy MySQL; the healthcheck must authenticate the application user/database.

The overlay explicitly sets gateway `DB_BUNDLED=true`, `DB_HOST=mysql`, `DB_PORT=3306`,
`DB_TLS=false` and forwards the same `DB_NAME`/`DB_USER`/`DB_PASSWORD` to MySQL bootstrap variables.
`validateDatabaseEnvironment(env)` accepts this production exception only when the flag is true
(case-insensitive), hostname is exactly case-sensitive `mysql`, and effective port is exactly
3306 (unset/empty uses the existing 3306 fallback). Malformed nonempty ports and malformed/empty
flags fail; wrong host/port fail even with `DB_TLS=true`. Missing/false flag keeps original TLS
rules. Development/test behavior is unchanged. This flag is operator-controlled configuration,
not an HTTP input or a general trusted-network TLS exemption.

MySQL bootstrap settings only affect an empty volume. Editing them does not rotate credentials,
create a new user or reset an existing database; perform those operations explicitly. Do not
remove the volume to fix startup or upgrade. Migration still runs explicitly through `init-db`,
never an image entrypoint. Back up/restore/import before moving an existing external database.
Bundled-mode URLs pointing at host loopback need a container-reachable address.

Host Nginx proxies to the selected loopback listener and sends:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Real-Port $remote_port;
```

External mode retains `127.0.0.1/32,::1/128`. Bundled mode overrides any legacy `TRUST_PROXY` with
`${GATEWAY_FRONT_GATEWAY}/32`, default `172.30.46.1/32`. Inspect that project network and confirm
the actual socket peer before accepting traffic; change frontend subnet/gateway together if
occupied. Trust only the explicit peer, never all Docker/private networks or boolean `true`.
Retain [Proxy Addresses](./proxy-addresses.md): Express walks the trusted chain for the client IP;
`readRequestSource` accepts `X-Real-Port` only from a trusted socket peer. Verify new login audit
rows after a proxy switch; a healthy discovery response alone does not prove audit correctness.

### Deployment command ordering and failures

Resolve the deployment root relative to the script, and let Compose/application parse `.env`;
never `source` it as shell code or print resolved configuration/secrets. Validate arguments,
Docker/Compose support and existing `.env`, `data/` and `data/keys/` sources. Pull only selected
services, then run the image mount checker as the
non-root image user and `npm run check:config` without connecting/migrating.

Require a backup and pause-writes acknowledgement before destructive schema work. Interactive
confirmation or explicit `--backup-confirmed` satisfies it; elapsed time/noninteractive input
does not. `--skip-migrate` is only for an operator-prepared schema; startup still checks version.
For a separate DDL/migration account, migrate separately, restore the normal app account, then
use this flag. This command does not automate account rotation.

Before migration/start, stop only this project's Watchtower/gateway. In bundled mode start MySQL
and wait healthy, run explicit `init-db`, force-recreate/start gateway and wait healthy, then
start Watchtower only if requested. Failures prevent later steps and print useful project-scoped
diagnostics/verification commands. Never remove data/volumes, call global prune, stop another
application, or kill an old host Node process. Print an operator hint for occupied host ports.

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
| `DB_BUNDLED=true` with exact `mysql:3306` in private overlay | Explicit production no-TLS exception |
| `DB_BUNDLED=true` with another host/port, even TLS enabled | Reject before a DB connection is created |
| Empty/malformed `DB_BUNDLED` in production | Reject; missing/false preserves remote TLS requirement |
| Bundled root/app bootstrap variables absent | Compose config fails before pull/migration |
| Existing MySQL volume and edited bootstrap credentials | No automatic rotation/reset; operator must reconcile credentials |
| No backup acknowledgement or failed mounts/config/pull/migration | Abort before later destructive/start/update steps |
| Discovery endpoint unavailable/non-successful | Healthcheck fails; inspect gateway logs |
| Default production/build profiles | Watchtower inactive; local gateway auto-update label false |
| Bundled mysql container | Internal network only, no published host port, updater label false |
| Another application's container, or Watchtower itself | Outside the updater's target/filter set |
| GitHub PR/feature push | Checks run; image publishing job skipped |
| CI check failure | No image build/push in the publishing path |
| Invalid version/Docker tag | Publishing fails before tagging/pushing |
| Prerelease version | Version/commit tags only; existing latest remains unchanged |
| Docker CLI/daemon absent locally | Explicitly report build/start unverified; YAML parsing is not a substitute |

## 5. Good / Base / Bad Cases

- Good: copy existing secrets/assets/settings to a new dedicated deployment directory, choose
  external host mode to preserve Baota loopback DB/proxy settings, back up/migrate explicitly,
  validate on a spare `PORT`, switch only
  this gateway's Nginx upstream, verify login/MFA/refresh/audit, then enable scoped Watchtower.
- Base: choose bundled mode for an empty installation with separate root/app passwords, persistent
  volume and fixed proxy gateway; no updater starts. Existing ZIP packaging still passes.
- Bad: use the bundled TLS flag with a remote database, expose MySQL, delete a volume to fix
  credentials, trust whole private networks, or let automatic image updates run migrations.

## 6. Tests Required

Run `npm run check` and `npm run build:deploy`. Validate all four effective Compose combinations
(production/build, external/bundled); use real `docker compose config --quiet` when available.
For a YAML-only fallback preserve/recognize `!reset` and reject duplicate keys. Check GitHub/CNB
event gates and credential scope. Run Bash syntax, shellcheck if available and deployment mocks
covering argument/version errors, backup refusal, mount/config/pull/migration/health failures,
mode/override forwarding, updater opt-in and no unrelated/data-deleting actions.

Database tests must cover the explicit bundled allow case; malformed flags/hosts/ports; wrong
host/port despite TLS; unchanged remote verified-TLS/loopback behavior; static check and
startup/migration rejection before DB connection. If Docker is available (including an authorized
WSL test distro), build and start both modes against isolated test MySQL until healthy. Assert
non-root identity, mount access, SDK/secret exclusions, actual dynamic health port, schema
migration and data persistence across recreation, default proxy configuration, frontend egress
and no published bundled DB port. Inventory baseline resources and clean only owned test
containers/networks/volumes. If Docker is absent, report real build/start checks as unexecuted.
Never trigger remote CI or touch a production server to compensate for local tooling.

## 7. Wrong vs Correct

Wrong: `COPY . .` with deployment secrets in the context, root runtime, Watchtower without
label/scope/target filters, a local image opted into updates, `TRUST_PROXY=true`, or an automatic
`init-db` entrypoint.

Correct: allowlisted build context plus explicit runtime copies, `USER node`, persisted read-only
secrets and writable admin data, scoped/targeted opt-in updates, disabled local updates, verified
proxy peers, and an explicit backed-up migration before traffic switches.
