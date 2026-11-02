#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  printf 'Usage: %s IMAGE REF COMMIT_SHA\n' "$0" >&2
  exit 1
fi
image=$1
ref=$2
commit=$3

# Both platforms call this script so latest and prerelease policy cannot drift.
if [[ ! "$image" =~ ^[a-z0-9][a-z0-9._:/-]*$ ]] \
  || [[ ! "$ref" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] \
  || [[ ! "$commit" =~ ^[a-fA-F0-9]{40,64}$ ]]; then
  printf 'Invalid image name, Docker tag, or commit SHA\n' >&2
  exit 1
fi
if [[ "$ref" != main && "$ref" != v* ]]; then
  printf 'Only main and v* release refs can publish images\n' >&2
  exit 1
fi

printf '%s:%s\n' "$image" "$ref"
printf '%s:sha-%s\n' "$image" "${commit:0:12}"
if [[ "$ref" == main || "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  printf '%s:latest\n' "$image"
fi
