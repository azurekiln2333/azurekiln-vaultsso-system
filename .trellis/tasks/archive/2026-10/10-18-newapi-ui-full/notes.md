# Execution Notes — new-api full UI refresh (round 2)

## Round 1 recap (archived)

Task `10-18-newapi-ui-refresh` (archive: `.trellis/tasks/archive/2026-10/`) delivered:

- The `--radius-xs/sm/md/lg/full` token scale.
- `tailwind.config.cjs` mapped onto those tokens.
- Top-right account dropdown in the admin shell.
- Animated collapsible sidebar.
- Removal of duplicated page titles, separators and the console footer.

## Step 1 — committing the user's 10 files (owner: sso-lead)

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

## Step 2 — shared new-api component baseline (owner: sso-lead)

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

## Final state

All three agents delivered and every review finding was fixed.

| Phase | Commits | Owner |
|---|---|---|
| User file split | `ad802df` `2265155` `f24e359` `c6dadf4` `5f3ecc1` `1278f90` | sso-lead |
| Component baseline | `08c1e1f` | sso-lead |
| Sign-in / error / docs | `4734e19` `8809f1c` `a3c3058` `c515e17` `6889ed8` | sso-user |
| Profile / MFA | `e5de89e` `b6f9666` `29fbf56` `28b4f41` `e03c189` | sso-user |
| Admin shell | `a3907e0` `bad3a0a` `7a5ad23` | sso-shell |
| Admin content pages | `813ca40` `f38ce40` `b18de01` `cc02ceb` `9b2fbd6` `7db67f6` `92f6b2f` `35acc89` `e3ed7c7` `3adb19c` `468f345` `67a720a` | sso-admin |

### Findings fixed during review

1. **Token collision.** `public/css/vaultsso-profile.css` redefined `--line`,
   `--success`, `--danger` and `--shadow` at `:root`. Because `profile.html`
   loads it after `vaultsso-base.css`, those values silently overrode the
   shared baseline for the whole page. Renamed to `--profile-*` in `29fbf56`;
   the four `var(--line)` uses inside the new overlay layer intentionally keep
   pointing at the shared token.
2. **Decorative profile footer.** `<footer class="profile-footer">VaultSSO</footer>`
   violated the no-footer rule. Removed with its three CSS rules in `28b4f41`.
3. **Decorative MFA footer.** `<footer class="mfa-footer">VaultSSO 账户安全</footer>`
   was the same pattern. Removed in `e03c189`, together with the now-orphaned
   `auth.mfa.footer` key in all three languages.

### Review method

The sharded review caught the two footers only after the audit browser session
was fixed. The first version injected the fixture cookie incorrectly (the
`Set-Cookie` header carries `Secure` and the fixture serves plain HTTP), so
every page silently landed on the login form and reported "ok". `audit-session.cjs`
detects that false positive by asserting the body renders page-specific
markers; `audit-visual.cjs` now parses both cookies from the raw `Set-Cookie`
header and forces `secure: false`.

### Housekeeping done

- No `tests/tmp-r2-*.cjs` scratch files remain.
- Tool directories (`.agent/`, `.claude/`, `.codex`, …) and `AGENTS.md` are
  still untracked, as required.

### Audit scripts kept in this task directory

`audit-visual.cjs`, `audit-session.cjs`, `audit-selectors.cjs`,
`audit-contracts.cjs`, `audit-dupes.cjs`. These are throwaway review helpers,
not part of the shipped suite — `package.json` does not reference them.

See `validation.md` for the full results.
