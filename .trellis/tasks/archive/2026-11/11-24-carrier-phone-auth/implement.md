# Execution and ownership

Shared checkout on feat/carrier-phone-auth. Never revert others, switch branches, commit/push/tag/merge or create tasks. NO LOCAL TESTS/CHECKS/BUILDS including syntax checks and npm commands; cloud only. User authorized plan -> implementation -> cloud validation -> merge -> tag publication without another approval pause.

| Pi pane | Exclusive ownership |
| --- | --- |
| w6Q:p2 | services/phone-auth.js, services/tianyi.js, services/admin-settings.js, models/PhoneChallenge.js, .env.example. No server.js/tests. |
| w6Q:p5 | server.js plus focused new phone route/identity registrar if useful; explicit MFA/policy/transaction/native OAuth and Tianyi routing. No config service/views/tests. |
| w6Q:p7 | Login/admin/profile HTML+JS, relevant CSS, shared i18n/asset versions, setup/API/App integration docs. No server.js/provider services/tests. |
| w6Q:p6 | Tests/fixture/memory adapter; package.json browser command only; GitHub workflow/cloud helpers. Official response fixtures, meaningful API/browser regressions and cloud validation. No local execution. |

Final review handoff (after Pi implementation): native `backend_final_check` owns server/provider/model fixes; `api_regressions` owns API/unit tests and fixture/memory adapter; `ui_final_check` owns UI/docs fixes. Pi p5 is read-only, p2/p7 have stopped edits, and p6 owns only `tests/carrier-phone-browser.cjs` plus its package script entry. Root owns the GitHub workflow and `scripts/ci-image-inspect.sh`. These explicit transfers supersede the initial ownership table.

1. Complete PRD/design/manifests and official evidence, activate, dispatch four Pi.
2. Implement frozen interfaces; resolve contract mismatches with coordinator. Upstream evidence is research/aliyun-*.txt plus operator-oauth.md; avoid invented payloads.
3. Native Trellis read-only cross-layer review; coordinator updates executable specs. No local check command.
4. Commit/push branch; GitHub runs npm run check, npm run check:browser, npm run build:deploy and container validation. Route cloud failures to owning Pi, wait for latest revision.
5. Merge passing branch into main, push main, create/push nonconflicting stable tag, observe publication. Record runs/SHA/image tag and actual onboarding limits.
6. Trellis archive+journal, commit/push bookkeeping. Exclude the two unrelated 11-02 task dirs and docs/compliance.
