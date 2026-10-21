# Approved commit plan

Approved on October 21, 2026: the user requested a standardized commit after reviewing this plan.

## Work commit

Message: `style(auth): simplify OAuth2 login page`

Branch: `style/oauth-login-cleanup`

Product files:

- `views/auth/login.html`
- `public/js/pages/auth/login.js`
- `public/css/vaultsso-authorize.css`
- `public/js/shared/i18n.js`

New records created for this task:

- `.trellis/tasks/10-21-oauth-login-cleanup/prd.md`
- `.trellis/tasks/10-21-oauth-login-cleanup/task.json`
- `.trellis/tasks/10-21-oauth-login-cleanup/implement.jsonl`
- `.trellis/tasks/10-21-oauth-login-cleanup/check.jsonl`
- `.trellis/tasks/10-21-oauth-login-cleanup/validation.md`
- `.trellis/tasks/10-21-oauth-login-cleanup/commit-plan.md`

The product change deletes the authorization details card and its rendering, styles, and card-only translations. Asset references share the updated version `20261021-login-cleanup-1`. All acceptance criteria passed; see `validation.md` for evidence.

## Existing dirty paths excluded from the commit

These 35 untracked paths were already present before this task. None will be staged or committed as part of this work:

- `.agent/`
- `.agents/`
- `.claude/`
- `.codebuddy/`
- `.codex/`
- `.cursor/`
- `.devin/`
- `.dsh/`
- `.gemini/`
- `.gitattributes`
- `.kilocode/`
- `.kiro/`
- `.pi/`
- `.trae/`
- `.trellis/.gitignore`
- `.trellis/.template-hashes.json`
- `.trellis/.version`
- `.trellis/agents/`
- `.trellis/config.yaml`
- `.trellis/scripts/`
- `.trellis/spec/`
- `.trellis/tasks/00-bootstrap-guidelines/`
- `.trellis/tasks/09-23-client-pkce-policy/`
- `.trellis/tasks/09-27-auth-feedback/`
- `.trellis/tasks/09-27-login-account-regressions/`
- `.trellis/tasks/09-27-phone-huawei-bindings/`
- `.trellis/tasks/09-27-user-app-history/`
- `.trellis/tasks/09-28-multi-authenticators/`
- `.trellis/tasks/09-28-sso-structure-roadmap/`
- `.trellis/tasks/09-30-mfa-stitch-autofill/`
- `.trellis/workflow.md`
- `.trellis/workspace/`
- `.workbuddy-ai/`
- `.zcode/`
- `AGENTS.md`

Ignored screenshots and temporary browser harnesses under `.artifacts/` are also excluded.

## After approval

Stage only the exact product files and new task records listed above, create the work commit, then complete the workflow's task archive and session journal steps. Do not amend or push. If the user prefers manual commits, leave the reviewed edits available and follow that instruction.
