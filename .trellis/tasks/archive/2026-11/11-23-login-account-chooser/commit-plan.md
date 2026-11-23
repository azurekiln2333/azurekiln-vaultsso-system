# Proposed commit plan

## Work commit

`feat(auth): add browser account chooser and admin phone verification`

These changes form the requested task. The shared `server.js` and admin template contain both features, so keep their verified integration together in one work commit.

Files:

- `server.js`
- `models/User.js`
- `package.json`
- `public/css/vaultsso-authorize.css`
- `public/js/pages/auth/login.js`
- `public/js/pages/admin/user.js`
- `public/js/shared/i18n.js`
- `views/auth/login.html`
- `views/auth/mfa.html`
- `views/account/profile.html`
- `views/admin/clients.html`
- `views/admin/index.html`
- `views/admin/security.html`
- `views/admin/smtp.html`
- `views/admin/tokens.html`
- `views/admin/user-applications.html`
- `views/admin/user.html`
- `views/admin/users.html`
- `tests/login-accounts.test.js`
- `tests/login-accounts-browser.cjs`
- `tests/phone-api.test.js`
- `tests/account-bindings-browser.cjs`
- `tests/support/memory-db.js`
- `.trellis/spec/backend/account-bindings.md`
- `.trellis/spec/backend/browser-accounts.md`
- `.trellis/spec/backend/index.md`
- `.trellis/spec/frontend/index.md`

Other templates change only the shared translation asset cache version. Local screenshots/logs stay in ignored `.artifacts/`.

## Subsequent Trellis bookkeeping

After the work commit, archive this task's PRD/design/implementation/context/verification records and record the session journal through the existing Trellis commands. Their script-generated bookkeeping commits follow the work commit. This task was implemented directly in the existing shared checkout and has no PR; use the documented non-PR archive path if branch metadata validation applies.

## Unrelated paths excluded

- `.trellis/tasks/11-02-gateway-compliance-w4/`
- `.trellis/tasks/11-02-gateway-container-ci/`
- `docs/compliance/`

The user approved this plan with "行". Work commit completed: `12cdee4bf40f4455c225e8701ed162c2502c7d52`. Archive and journal follow under the same confirmation. No push or deployment is part of this plan.
