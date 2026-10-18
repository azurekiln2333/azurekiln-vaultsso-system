# Execution Notes — new-api full UI refresh (round 2)

## Round 1 recap (archived)

Task `10-18-newapi-ui-refresh` (archive: `.trellis/tasks/archive/2026-10/`) delivered:

- The `--radius-xs/sm/md/lg/full` token scale.
- `tailwind.config.cjs` mapped onto those tokens.
- Top-right account dropdown in the admin shell.
- Animated collapsible sidebar.
- Removal of duplicated page titles, separators and the console footer.

## Step 1 — committing the user's 10 files (owner: sso-lead) — DONE

Split by feature, never by file dump. No user line was removed.

| Commit | Message | Files |
|---|---|---|
| `ad802df` | feat(account): rebuild profile page with navigation rail and grouped setting panels | `public/css/vaultsso-profile.css`, `views/account/profile.html`, `public/js/pages/account/profile.js` |
| `2265155` | feat(auth): rebuild MFA page with six code slots and recovery toggle | `views/auth/mfa.html`, `public/js/pages/auth/mfa.js`, `public/css/vaultsso-mfa.css` (was untracked) |
| `f24e359` | feat(account): show authenticator device icons and idle state on profile | `public/js/pages/account/authenticators.js` |
| `c6dadf4` | feat(i18n): add profile navigation and MFA factor strings | `public/js/shared/i18n.js` |
| `5f3ecc1` | test: cover profile navigation and MFA code entry in real browsers | `tests/browser-smoke.cjs`, `tests/password-mfa-browser.cjs` |
| `1278f90` | chore: skip design artifacts in syntax check | `scripts/check-syntax.js` |

`public/css/vaultsso-mfa.css` was untracked and referenced by `views/auth/mfa.html`,
so it shipped with the MFA commit.

Verification before each commit: `node scripts/check-syntax.js`, plus
`browser-smoke`, `account-bindings-browser`, `auth-feedback-browser` and
`password-mfa-browser`. All passed.

After this step the ten files belong to `sso-user`; the freeze is lifted.

## Step 2 — shared new-api component baseline (owner: sso-lead) — DONE

Commit `08c1e1f` on `public/css/vaultsso-base.css`.

### Tokens added to `:root`

Surfaces `--surface-page/card/subtle/muted/hover/selected`; lines `--line`,
`--line-soft`; text `--text-strong/body/muted/faint`; accent `--accent`,
`--accent-strong`, `--accent-bright`, `--accent-soft`, `--accent-contrast`;
semantic `--success(-soft)`, `--danger(-soft)`, `--warning(-soft)`; depth
`--shadow-flat/panel/pop`; rhythm `--space-1..6`, `--control-height` (32px),
`--control-height-sm` (28px), `--motion`.

The accent family is the original VaultSSO blue — no new-api purple/green.

### Components added (all prefixed `napi-`)

| Group | Classes |
|---|---|
| Panel / card | `.napi-panel` `.napi-card` `.napi-panel-head` `.napi-panel-title` `.napi-panel-desc` `.napi-panel-body` |
| Buttons | `.napi-btn` + `.napi-btn-primary` / `-secondary` / `-ghost` / `-danger` / `-sm` |
| Forms | `.napi-input` `.napi-select` `.napi-textarea` `.napi-field` `.napi-label` `.napi-hint` `.napi-error-text` |
| Badges | `.napi-badge` `.napi-chip` + `-accent` / `-success` / `-warning` / `-danger` |
| Tables | `.napi-table` (sticky head, hairline rows) `.napi-table-scroll` |
| Filters | `.napi-filter-bar` |
| Empty state | `.napi-empty` `.napi-empty-title` |
| Dialog | `.napi-dialog-backdrop` `.napi-dialog` `.napi-dialog-head` `.napi-dialog-body` `.napi-dialog-foot` |
| Setting row | `.napi-setting-row` `.napi-setting-label` `.napi-setting-value` |
| Headings | `.napi-section-title` `.napi-section-desc` `.napi-page-header` `.napi-page-title` `.napi-page-desc` |

Rules given to the other agents: reuse these instead of redefining them, do not
edit `vaultsso-base.css` or `tailwind.config.cjs`, request additions through
this task directory, and keep radii on `--radius-*`.

## File ownership

| Agent | Owned files |
|---|---|
| sso-lead | `public/css/vaultsso-base.css`, `tailwind.config.cjs`, task docs |
| sso-shell | `public/js/shared/admin-shell.js`, `views/admin/index.html`, `public/css/vaultsso-admin.css` |
| sso-admin | other `views/admin/*.html`, `public/js/pages/admin/*.js`, `public/css/vaultsso-admin-pages.css` |
| sso-user | `views/auth`, `views/account`, `views/docs`, their CSS/JS (incl. the ten formerly frozen files) |

## Step 3 — admin content pages on the new-api baseline (owner: sso-admin) — DONE

All seven admin content pages were rebuilt on the shared `.napi-*` components.
The shell (`vaultsso-admin.css`, `admin-shell.js`, `views/admin/index.html`) was
never touched; page-only layout lives in `public/css/vaultsso-admin-pages.css`.

| Commit | Scope |
|---|---|
| `813ca40` | smtp page on panels + 3-column form grid |
| `67a720a` | five pages switched to the shared small radius token |
| `f38ce40` | users table: filter bar, `napi-table`, dialog |
| `b18de01` | users rows: `napi-badge` + row action buttons |
| `cc02ceb` | token audit: stat strip, filter bar, `napi-table` |
| `9b2fbd6` | security settings: panel sections, toggle rows, subform |
| `7db67f6` | clients: stat strip, sticky editor panel, card grid |
| `92f6b2f` | clients badges/status vocabulary |
| `35acc89` | user detail: panels, setting rows, identity list |
| `e3ed7c7` | user applications: account panels + kv grid |
| `3adb19c` | dynamic log/provider/import markup on `napi-*` |
| `468f345` | smtp status classes |

What changed, per the new-api reference:

- Page header holds only a description line (the shell top bar owns the single
  title) plus that page's primary action, if any.
- Filter/search/refresh moved into a compact toolbar card; statistics became a
  flat stat strip instead of four heavy shadow cards.
- Tables use `.napi-table` (sticky head, hairline rows, hover) inside
  `.admin-table-panel`; empty states use `.napi-empty`.
- Settings pages group items into panels with `.admin-toggle-row` rows instead
  of bordered mini-cards.
- Buttons follow the three-level hierarchy (`napi-btn-primary` for the single
  main action, `-secondary` for parallel actions, `-ghost` for inline, `-danger`
  for destructive); badges use `napi-badge-*` semantic variants.

Contracts preserved: no API call, form field, `id`, `data-*` or i18n key was
renamed or removed; `statusBar` still receives a full `className` rewrite from
JS, now pointing at `.admin-status*`.

Verification (`node .trellis/tasks/10-18-newapi-ui-full/admin-audit.js`):

```
clients            {"h1":0,"hr":0,"footer":0,"bigRadius":0,"panelBody":1} structure=ok
security           {"h1":0,"hr":0,"footer":0,"bigRadius":0,"panelBody":5} structure=ok
smtp               {"h1":0,"hr":0,"footer":0,"bigRadius":0,"panelBody":3} structure=ok
tokens             {"h1":0,"hr":0,"footer":0,"bigRadius":0,"panelBody":0} structure=ok
user               {"h1":0,"hr":0,"footer":0,"bigRadius":0,"panelBody":3} structure=ok
users              {"h1":0,"hr":0,"footer":0,"bigRadius":0,"panelBody":0} structure=ok
user-applications  {"h1":0,"hr":0,"footer":0,"bigRadius":0,"panelBody":0} structure=ok

ids referenced by admin js: 135
ids missing from any admin page: none
```

Also green: `node scripts/check-syntax.js`, `node scripts/check-e2e.js`
(202/202) and `node tests/browser-smoke.cjs`.


- Remove stray `tests/tmp-r2-*.cjs` scratch scripts left by agent probing.

## Progress log

| Agent | Status |
|---|---|
| sso-lead | user commits done; component baseline done; reviewing |
| sso-shell | working on shell alignment |
| sso-admin | working on admin content pages |
| sso-user | login/error/docs done (`4734e19`, `8809f1c`, `a3c3058`); profile/mfa next |
