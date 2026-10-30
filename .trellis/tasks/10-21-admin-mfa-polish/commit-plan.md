# Proposed commit batch

Date: 2026-10-21. Branch: `fix/admin-mfa-polish`. Base: `style/oauth-login-cleanup` / `4c264af`.
Status: concrete plan prepared after quality review; awaiting one-shot user confirmation under `.trellis/workflow.md` Phase 3.4. No commit or push has been performed for this task.

## 1. `style(admin): flatten management panel surfaces`

Twelve files: the admin presentation changes plus the surface contract and its index entry.

- `public/css/vaultsso-admin.css`
- `public/css/vaultsso-admin-pages.css`
- `views/admin/index.html`
- `views/admin/clients.html`
- `views/admin/users.html`
- `views/admin/user.html`
- `views/admin/user-applications.html`
- `views/admin/tokens.html`
- `views/admin/security.html`
- `views/admin/smtp.html`
- `.trellis/spec/frontend/surface-guidelines.md`
- `.trellis/spec/frontend/index.md`

## 2. `feat(auth): auto-verify completed MFA codes`

Six files: coherent MFA layout, completion behavior, regression tests and the changed contract.

- `public/css/vaultsso-mfa.css`
- `public/js/pages/auth/mfa.js`
- `views/auth/mfa.html`
- `tests/password-mfa-browser.cjs`
- `tests/multi-authenticator-browser.cjs`
- `.trellis/spec/frontend/auth-feedback.md`

## Following the work commits

Use Trellis finish-work to archive these completed task trees, children before parent, with the normal archive commits:

- `.trellis/tasks/10-21-admin-flat-surfaces/`
- `.trellis/tasks/10-21-mfa-compact-auto-verify/`
- `.trellis/tasks/10-21-admin-mfa-polish/`

Then record this session in `.trellis/workspace/lichengyu/index.md` and `journal-1.md` using `add_session.py`, referencing the two work-commit hashes. This produces the normal journal commit after all archive commits. Do not amend or push.

## Existing unrecognized/unrelated paths: excluded

These paths were present before this task and are not part of either work commit or this task's bookkeeping. Keep them untouched; never stage the complete workspace, spec tree or task tree.

- `.agent/`, `.agents/`, `.claude/`, `.codebuddy/`, `.codex/`, `.cursor/`, `.devin/`, `.dsh/`, `.gemini/`
- `.gitattributes`, `.kilocode/`, `.kiro/`, `.pi/`, `.trae/`, `.workbuddy-ai/`, `.zcode/`, `AGENTS.md`
- `.trellis/.gitignore`, `.trellis/.template-hashes.json`, `.trellis/.version`, `.trellis/agents/`, `.trellis/config.yaml`, `.trellis/scripts/`, `.trellis/workflow.md`, `.trellis/workspace/index.md`
- Other files under `.trellis/spec/`, excluding the three exact frontend spec paths listed in commits 1 and 2
- `.trellis/tasks/00-bootstrap-guidelines/`
- `.trellis/tasks/09-23-client-pkce-policy/`
- `.trellis/tasks/09-27-auth-feedback/`
- `.trellis/tasks/09-27-login-account-regressions/`
- `.trellis/tasks/09-27-phone-huawei-bindings/`
- `.trellis/tasks/09-27-user-app-history/`
- `.trellis/tasks/09-28-multi-authenticators/`
- `.trellis/tasks/09-28-sso-structure-roadmap/`
- `.trellis/tasks/09-30-mfa-stitch-autofill/`

`tests/account-bindings-browser.cjs` has no final diff and is not in any commit. Ignored `.artifacts/` screenshots and temporary harnesses remain local evidence, not committed assets.

## Validation for both work commits

`npm run check:syntax`: 97 files pass. Security/MFA unit tests: 43/43 pass. Final `npm run check:browser`: all six suites pass, exit 0. `git diff --check`: pass. Independent screenshot review and both child acceptance reviews pass. See `validation.md` for the initial unrelated intermittent browser timeout and other evidence limits; neither that flake nor the existing admin-shell language-label issue is claimed fixed.
