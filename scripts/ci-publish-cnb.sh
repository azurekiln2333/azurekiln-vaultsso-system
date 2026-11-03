#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

# Fail with a clear message instead of a confusing error later in the build.
for command in docker bash; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Required command is unavailable in this CI image: %s\n' "$command" >&2
    exit 1
  }
done
if [[ "${BASH_VERSINFO[0]:-0}" -lt 4 ]]; then
  printf 'bash 4+ is required for mapfile; this image provides %s\n' "${BASH_VERSION:-unknown}" >&2
  exit 1
fi

registry=${CNB_REGISTRY:-${CNB_DOCKER_REGISTRY:-docker.cnb.cool}}
registry_user=${CNB_REGISTRY_USER:-${CNB_TOKEN_USER_NAME:-cnb}}
registry_password=${CNB_REGISTRY_PASSWORD:-${CNB_TOKEN:?CNB_TOKEN is not set}}
image=${CNB_IMAGE:-$registry/${CNB_REPO_SLUG_LOWERCASE:?CNB_REPO_SLUG_LOWERCASE is not set}}

image_tags=$(bash scripts/ci-image-tags.sh "$image" "${CNB_BRANCH:?CNB_BRANCH is not set}" "${CNB_COMMIT:?CNB_COMMIT is not set}")
mapfile -t tags <<< "$image_tags"

printf '%s' "$registry_password" | docker login "$registry" -u "$registry_user" --password-stdin
docker build -t "${tags[0]}" .
for tag in "${tags[@]:1}"; do
  docker tag "${tags[0]}" "$tag"
done
for tag in "${tags[@]}"; do
  docker push "$tag"
done
