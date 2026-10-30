# Implementation

- [x] Phone write routes, profile/admin forms, translations and focused tests.
- [x] Huawei subject scope configuration/migration, cross-app resolution and regressions.
- [x] Admin binding API/page/navigation with safe account grouping.
- [x] Integration, syntax/e2e and desktop/mobile browser verification.
- [x] Cross-layer review and documented conventions.

## Verification
- Full Node suite: 104 tests passed after review fixes.
- Syntax and browser script references: 67 files passed.
- `npm run check:browser`: existing smoke and feature interactions passed; screenshots at 1440px and 390px under ignored `.artifacts/`.
- `npm run build:css`: passed.
- `npm start`: blocked by existing placeholder JWT_SECRET in local .env. No deployment credentials were changed.
- Real MySQL locking/transaction integration was not exercised; isolated adapter tests cover concurrency, rollback and conditional phone writes.
- No commit created; the worktree contained extensive existing changes before this task.

Phone worker owns profile/user forms, phone routes and phone tests. Huawei worker owns provider config, identities, bindings page/API, migrations and Huawei tests. Shared server.js edits stay in distinct route/function regions. Primary owns integration, docs and final verification. Preserve all existing worktree edits.
