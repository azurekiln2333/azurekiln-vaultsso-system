#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
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
