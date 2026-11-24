#!/usr/bin/env bash
set -euo pipefail

# Executed by GitHub after the branch's tests and image build. No provider or DB
# connection is made; this asserts the shipped artifact's runtime boundary.
if [[ $# -ne 1 ]]; then
  printf 'Usage: %s IMAGE\n' "$0" >&2
  exit 1
fi
image=$1
[[ "$(docker image inspect --format '{{.Config.User}}' "$image")" == 'node:node' ]]
[[ "$(docker image inspect --format '{{json .Config.Cmd}}' "$image")" == '["node","server.js"]' ]]
[[ "$(docker image inspect --format '{{json .Config.Healthcheck.Test}}' "$image")" == *'openid-configuration'* ]]

docker run --rm --network none --read-only --entrypoint node "$image" -e '
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  assert.equal(process.getuid(), 1000);
  assert.equal(process.env.NODE_ENV, "production");
  for (const dependency of ["express", "mysql2", "@azurekiln/moderation-client"]) {
    assert.ok(require.resolve(dependency));
  }
  for (const file of ["server.js", "services/phone-auth.js", "services/tianyi.js",
    "models/PhoneChallenge.js", "views/auth/login.html", "public/js/pages/auth/login.js",
    "public/assets", "scripts/init-db.js"]) {
    assert.ok(fs.existsSync(file), `Missing runtime asset: ${file}`);
  }
  for (const file of [".env", ".git", ".trellis", "tests", "keys",
    "node_modules/playwright-core", "node_modules/tailwindcss"]) {
    assert.equal(fs.existsSync(file), false, `Unexpected runtime content: ${file}`);
  }
  console.log("Runtime image verified: non-root, production dependencies, carrier assets, no source credentials/dev tools.");
'
