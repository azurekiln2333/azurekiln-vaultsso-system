#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash scripts/deploy-docker.sh [--db external|bundled] [--watchtower]
       [--backup-confirmed] [--skip-migrate] [--override FILE] [--directory DIR]

Default: external MySQL using Linux host networking and the existing .env.
Bundled: add the private MySQL service from docker-compose.mysql.yaml.
--backup-confirmed  Confirm that the database is backed up and writes are paused.
--skip-migrate      Use only when the operator has already prepared the schema.
--watchtower        Start this project's scoped gateway updater after health passes.
--override FILE     Append an explicit Compose override (for example registry auth).
--directory DIR     Deployment directory (default: this script's parent directory).

The script never sources .env, deletes data, or stops a host Node process.
HELP
}

fail() {
  printf 'Deployment stopped: %s\n' "$*" >&2
  exit 1
}

deployment_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
db_mode=external
enable_watchtower=false
backup_confirmed=false
skip_migrate=false
override_files=()
while (($#)); do
  case "$1" in
    --db)
      [[ $# -ge 2 && "$2" != --* ]] || fail '--db requires external or bundled'
      db_mode=$2
      shift 2
      ;;
    --watchtower) enable_watchtower=true; shift ;;
    --backup-confirmed) backup_confirmed=true; shift ;;
    --skip-migrate) skip_migrate=true; shift ;;
    --override)
      [[ $# -ge 2 && "$2" != --* ]] || fail '--override requires a file'
      override_files+=("$2")
      shift 2
      ;;
    --directory)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail '--directory requires an existing directory'
      [[ -d "$2" ]] || fail 'The requested deployment directory does not exist'
      deployment_root=$(cd -- "$2" && pwd)
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
[[ "$db_mode" == external || "$db_mode" == bundled ]] || fail '--db requires external or bundled'

[[ -f "$deployment_root/.env" && -r "$deployment_root/.env" ]] || fail 'Prepare a readable deployment .env file'
for relative in data data/keys; do
  [[ -d "$deployment_root/$relative" ]] || fail "Prepare the deployment $relative/ directory"
done
for index in "${!override_files[@]}"; do
  case "${override_files[index]}" in
    /*) ;;
    *) override_files[index]="$deployment_root/${override_files[index]}" ;;
  esac
  override_file=${override_files[index]}
  [[ -f "$override_file" && -r "$override_file" ]] || fail 'A requested Compose override is missing or unreadable'
done

command -v docker >/dev/null 2>&1 || fail 'Install Docker and Docker Compose >=2.33.1 first'
compose_version=$(docker compose version --short)
if [[ "$compose_version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  compose_major=${BASH_REMATCH[1]}
  compose_minor=${BASH_REMATCH[2]}
  compose_patch=${BASH_REMATCH[3]}
  if ((compose_major < 2 || (compose_major == 2 && (compose_minor < 33 || (compose_minor == 33 && compose_patch < 1))))); then
    fail 'Docker Compose >=2.33.1 is required (!reset and gw_priority support)'
  fi
else
  fail 'Cannot determine Docker Compose version; require >=2.33.1'
fi
[[ $(docker info --format '{{.OSType}}') == linux ]] || fail 'This deployment requires a Linux Docker engine'

compose_command=(docker compose --project-directory "$deployment_root" --env-file "$deployment_root/.env" -f "$deployment_root/docker-compose.yaml")
if [[ "$db_mode" == bundled ]]; then
  compose_command+=(-f "$deployment_root/docker-compose.mysql.yaml")
fi
for override_file in "${override_files[@]}"; do
  compose_command+=(-f "$override_file")
done
compose() { "${compose_command[@]}" "$@"; }

deployment_step='configuration and mount checks'
trap 'deployment_exit=$?; if ((deployment_exit)); then printf "Deployment failed during %s. Inspect this project with the explicit Compose files. If a port is occupied, stop the old gateway yourself or choose another port; no host process was stopped.\n" "$deployment_step" >&2; fi' EXIT

compose config --quiet
pull_services=(gateway)
[[ "$db_mode" != bundled ]] || pull_services+=(mysql)
[[ "$enable_watchtower" != true ]] || pull_services+=(watchtower)
compose pull "${pull_services[@]}"
compose run --rm --no-deps --pull never gateway node scripts/check-container-mounts.js
compose run --rm --no-deps --pull never gateway npm run check:config

printf 'Before migration, back up the database, persistent keys/settings and JWT_SECRET, and pause application writes.\n'
printf 'An old host Node service must be stopped by its operator before taking this gateway port.\n'
if [[ "$skip_migrate" == true ]]; then
  printf 'Migration skipped: the operator is responsible for an already prepared schema.\n'
elif [[ "$backup_confirmed" != true ]]; then
  if [[ ! -t 0 ]]; then
    fail 'Backup confirmation is required; use --backup-confirmed after backing up and pausing writes, or --skip-migrate for an already prepared schema'
  fi
  read -r -p 'Type BACKUP_CONFIRMED to migrate this deployment: ' backup_answer
  [[ "$backup_answer" == BACKUP_CONFIRMED ]] || fail 'Backup confirmation was not provided'
fi

deployment_step='pausing this project gateway and updater'
compose --profile auto-update stop watchtower
compose stop gateway
if [[ "$db_mode" == bundled ]]; then
  deployment_step='waiting for bundled MySQL'
  compose up -d --pull never --wait --wait-timeout 180 mysql
fi
if [[ "$skip_migrate" != true ]]; then
  deployment_step='explicit database migration'
  compose run --rm --no-deps --pull never gateway npm run init-db
fi
deployment_step='starting and checking the gateway'
compose up -d --pull never --no-deps --force-recreate --wait --wait-timeout 180 gateway
if [[ "$enable_watchtower" == true ]]; then
  deployment_step='starting the scoped gateway updater'
  compose --profile auto-update up -d --pull never --no-deps --force-recreate --wait --wait-timeout 60 watchtower
fi

printf 'Gateway health passed. Verification commands:\n  '
printf '%q ' "${compose_command[@]}" ps
printf '\n  '
printf '%q ' "${compose_command[@]}" logs --tail 100 gateway
printf '\nVerify HTTPS login, refresh, MFA and new login audit IP/source-port records through Nginx.\n'
