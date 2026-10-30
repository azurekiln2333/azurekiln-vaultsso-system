# Proposed Work Commit

Implementation and validation are complete. No commit has been made. The project workflow Phase 3.4 requires one confirmation before a batched work commit; archive/journal commits come afterward.

Proposed message: `fix: support account-first login and direct user import uploads`

## Current-task changes

- `server.js`: account discovery, account-bound first-password send/setup, import-only raw/JSON parsing and body bound.
- `models/User.js`: conditional first-password update.
- `public/js/pages/auth/login.js`, `public/js/shared/i18n.js`, `views/auth/login.html`: account/password/setup/contact flow and translations.
- `public/js/pages/admin/users.js`, `views/admin/users.html`: direct File upload, pasted-content compatibility, byte preflight and visible results.
- `views/docs/api.html`: optional discovery/setup API contracts.
- `tests/account-first-login.test.js`, `tests/account-first-login-browser.cjs`, `tests/user-import-upload.test.js`, `tests/user-import-upload-browser.cjs`: new meaningful regressions.
- `tests/support/memory-db.js`: conditional-update support.
- `tests/browser-smoke.cjs`, `tests/account-bindings-browser.cjs`, `tests/auth-feedback-browser.cjs`, `tests/password-mfa-browser.cjs`, `tests/multi-authenticator-browser.cjs`, `tests/turnstile-browser.cjs`: real Continue interaction for the new login entry.
- `package.json`: include both new browser groups.
- Task-specific spec additions/updates and this task's planning, review and validation artifacts.

## Existing work excluded

The worktree already contained admin/MFA styles, templates, product code, browser tests and untracked Trellis/platform files. They are not authorized for blanket inclusion in this work commit. In particular, `views/admin/users.html`, `tests/password-mfa-browser.cjs` and `tests/multi-authenticator-browser.cjs` contain earlier changes; only this task's additions may be staged. The original snapshots in `research/baseline.json` and the import snapshot in `research/import-upload-contract.md` are the scope authority. Do not use `git add .` or stage entire overlapping files.

If a task-only hunk cannot apply to the current index independently of earlier work, preserve it in the worktree and report that dependency rather than silently committing the earlier changes. Existing untracked spec content must likewise be distinguished from task-created content before staging.

## Validation

`npm run check:e2e`: 238/238. `npm run check:browser`: eight groups passed. `npm run check:syntax`: 101 files passed. Final focused import checks passed after the two added boundary assertions. Both login/import integration reviews have no unresolved product findings. See `research/validation.md` for logs and screenshot evidence.
