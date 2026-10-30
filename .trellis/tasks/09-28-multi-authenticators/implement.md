# Execution

1. Backend: schema/model and legacy compatibility, scoped enrollment/removal APIs, common login verifier and pending security state; focused security tests.
2. Frontend: authenticators list, enrollment/removal modals, translations and visible errors; no window.prompt for the new workflow.
3. Verify both devices, replay/removal, cancellation and existing authentication suites; independent cross-layer review.
4. Update executable specs and deployment guidance, regenerate package, record evidence and limitations.

## Completed Evidence (2026-09-28)
- [x] Schema 7, independent encrypted device model, legacy compatibility and bounded enrollment lifecycle.
- [x] Profile device list, addition/removal/recovery modals, visible errors and three-language translations.
- [x] Final issuance holds the account lifecycle lock and transaction, rechecks security state, and uses the held connection. Removed/reset devices cannot mint access from a stale verified request.
- [x] Fifteen dedicated API regressions cover coexistence, replay, lifecycle rollback and deterministic concurrency boundaries.
- [x] Independent backend/frontend review complete; all task-blocking findings fixed.
- [x] `npm run check`: 162 tests pass, 81 syntax/reference files pass.
- [x] `npm run check:browser`: all five suites pass, including real old/new-device login at 1440px and 390px, delayed setup cancellation and individual removal.
- [x] README schema/workflow instructions and seven-section backend contract updated; `git diff --check` passes.
- [x] `npm run build:deploy`: root ZIP regenerated with 68 files, prior ZIP backed up. Every archived file matches current source text; zero font/icon assets.

## Limits / Next Work
No production service/database was connected, migrated or restarted; real MySQL transaction/lock semantics remain an integration verification requirement. Deployment requires backing up the database, `npm run init-db` and normal configuration validation. No automatic commit or deployment was performed. New structure/SSO roadmap remains in planning under `09-28-sso-structure-roadmap`.
