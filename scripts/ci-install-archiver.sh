#!/usr/bin/env bash
set -euo pipefail

# build-deploy.js needs a ZIP-capable archiver: libarchive's tar/bsdtar, or the
# native zip/unzip pair on hosts whose tar is GNU tar (Debian/Ubuntu images).
# Skip entirely when a libarchive tar is already present.

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if tar --version 2>/dev/null | grep -qi libarchive; then
  printf 'libarchive tar present; no extra archiver needed\n'
  exit 0
fi

missing=()
for command in zip unzip; do
  command -v "$command" >/dev/null 2>&1 || missing+=("$command")
done

if ((${#missing[@]} == 0)); then
  printf 'ZIP archivers present; no installation needed\n'
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  printf 'Missing %s and apt-get is unavailable.\n' "${missing[*]}" >&2
  printf 'Install zip/unzip, or provide a libarchive-based tar (bsdtar/libarchive-tools).\n' >&2
  printf 'CI images on Debian/Ubuntu satisfy this through apt-get.\n' >&2
  exit 1
fi

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends zip unzip

for command in zip unzip; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s is still unavailable after installation\n' "$command" >&2
    exit 1
  }
done
printf 'ZIP archivers ready\n'
