# Cloud validation research

Read-only source review on 2026-11-24. No local tests, syntax checks, builds, dependency installation, Git mutation or remote workflow action was performed. Only this research note was written. The user's cloud-only validation requirement overrides the generic local-validation guidance in the deployment spec.

## Existing behavior

- `.github/workflows/build-and-release.yml` runs `test` for every branch push, `v*` tag and PR. Its only validation step calls `scripts/ci-backend.sh`, which installs an archiver if needed, runs locked `npm ci`, then `npm run check`.
- `npm run check` runs syntax plus every `tests/*.test.js` file serially through `scripts/check-e2e.js`. New carrier API/service tests named `*.test.js` are discovered automatically.
- `tests/deploy-package.test.js` already builds and inspects a temporary deployment ZIP during the backend suite. It does not retain a downloadable `dist/azurekiln-oauth2.zip` artifact.
- The `image` job needs only `test` and runs exclusively on `main`/`v*` push. Feature branches and PRs never build an image today. Only that publishing job has `packages: write` and registry login.
- `package.json` lists 13 browser scripts under `check:browser`. All accept `BROWSER_EXECUTABLE`, otherwise use the installed Chrome channel. The installed/locked `playwright-core` package exposes its own CLI, so another Playwright dependency is unnecessary.
- Browser scripts start the real application with `tests/support/fixture.js` and an isolated in-memory database. They generally abort browser requests outside the fixture origin. Turnstile additionally fulfills its SDK script locally and stubs server-side verification.
- Browser evidence lives under `.artifacts/`, including subdirectories. Upload either narrowly selected image/report files with hidden-file inclusion enabled, or copy only that evidence into a nonhidden upload directory. Do not upload a broad working tree or temporary credentials.
- Fonts and icon assets under `public/assets/` are tracked in Git. Browser tests and image builds do not need font generation to find them. Deployment ZIP intentionally excludes those separately supplied assets; the Docker image includes them.
- `Dockerfile` already copies whole `services/`, `models/`, `config/`, views and public JS/CSS. New carrier files within those directories need no additional COPY rules. `package.json` includes those directories in the deploy ZIP. New dependencies require both package manifests/lockfile, as usual.

## Smallest cloud-only pipeline change

1. Extend the existing GitHub `test` job after backend validation: install the Chromium matching locked `playwright-core`, set `BROWSER_EXECUTABLE` to `require('playwright-core').chromium.executablePath()`, run the complete `npm run check:browser`, and run `npm run build:deploy` for a retained artifact. Use the already installed package CLI (`node node_modules/playwright-core/cli.js install --with-deps chromium`) rather than an unpinned package download. The new carrier browser script must be explicitly added to `check:browser` by its owning worker.
2. Upload browser screenshots/reports with an always-run evidence step, and upload `dist/azurekiln-oauth2.zip` after a successful ZIP build. Name artifacts with the commit/run identity. Preserve failing command exit status if piping logs through `tee`.
3. Add a nonpublishing `image-validation` job for every branch/PR/tag, dependent on `test`: use the existing Buildx/build action, `push: false`, `load: true`, and a fixed local test tag. Run the image as its configured non-root user with `--network none --entrypoint node` to assert the SDK resolves, runtime/carrier assets exist, production dependency layout is present, dev packages/tests/source credentials are absent, and the image metadata retains `node:node`, direct Node command and healthcheck.
4. Make the existing publishing `image` job require successful `image-validation` (which already requires `test`). Retain its exact main/tag push gate and job-scoped package permission. Feature validation needs no registry login or production secrets. This modestly duplicates the image build on a release event but keeps the proven publish path intact; avoiding the duplication is an optional later optimization.
5. A successful nonpublishing image build/inspection proves packaging, not real MySQL startup. If startup is an acceptance requirement, add an isolated GitHub MySQL/container smoke with generated test-only keys/credentials and explicitly disabled carrier settings. Keep its resources scoped to that runner. Do not label build-only evidence as deployed/healthy runtime evidence.

The narrow file boundary is the GitHub workflow plus an optional short image-validation helper if inline checks become unwieldy. No Dockerfile change is required merely to ship carrier modules. `scripts/ci-backend.sh` is also used by `.cnb.yml`; adding GitHub browser work there would unexpectedly change CNB requirements. Prefer GitHub-specific workflow steps unless a shared CI behavior change is deliberate.

## Carrier/SMS provider isolation

No carrier implementation/config names existed at review time, so coordinate exact environment keys and adapter injection with the backend worker.

- Extend `tests/support/fixture.js` to clear every new carrier/SMS credential, endpoint, enabled flag and app setting before loading `server.js`; keep its existing temporary `ADMIN_SETTINGS_FILE`. `NODE_ENV=test` already prevents loading the checkout `.env` through `config/environment.js`. Never load repository deployment data/settings into fixtures.
- Default service configuration must be disabled/unconfigured. Capability/config endpoints must return unavailable without SDK initialization, signing, token exchange, SMS send or network calls. Invoking unconfigured auth/send endpoints should fail readably before transport creation. Do not make a default official URL plus missing keys cause a network probe.
- For positive API tests, inject a fake provider transport or use a local `127.0.0.1` HTTP server with dummy credentials. Existing `tests/huawei.test.js` and `tests/oidc.test.js` provide local-server precedents. Restore test stubs and reset provider call logs between tests.
- Prove the negative contract with a counting/throwing transport: default/unconfigured capability queries, login and SMS calls result in zero transport calls. Cover incomplete credentials and disabled settings too. Do not merely assert a 503 after a real request failed.
- Browser routing protects Chromium, not the application's Node process. A carrier H5 SDK must be fulfilled from a controlled browser stub in positive tests, while every unmatched browser origin remains blocked. Service transport isolation must be independent of browser routing.
- If using direct Node `fetch`, an optional fixture egress guard should allow only fixture/local-provider loopback addresses and throw on every other host, before any real fetch. If the chosen SDK uses Node HTTP/HTTPS instead, inject/guard that actual transport; a fetch-only stub does not protect it. Fake credentials alone are not an egress guard.
- Production verification remains fail-closed: never accept a client-provided phone or canned test token as verified. Test injection must be constructor/bootstrap test dependency injection, not an HTTP parameter or a production env switch that bypasses verification.
- GitHub validation receives no carrier/SMS/production secrets. Image inspection uses no network and never starts provider clients. Package/base-image/browser downloads during setup are separate from authentication-provider traffic.

## Merge/release evidence

Require the latest feature commit's backend/browser/ZIP/image-validation checks to pass before merge. After the main push succeeds, a version-tag push must pass the same gates before publication. Existing `scripts/ci-image-tags.sh` keeps `latest` on main/stable `vMAJOR.MINOR.PATCH`, not prereleases. Record actual run IDs, commit SHA, downloadable ZIP/screenshots and published image tags/digest; an older in-progress main run cannot certify the new feature commit.
