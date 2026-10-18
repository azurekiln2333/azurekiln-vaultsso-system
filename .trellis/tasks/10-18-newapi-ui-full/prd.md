# new-api full UI refresh (round 2)

## Goal

Align every VaultSSO surface with the visual and interaction language of
[new-api](https://github.com/QuantumNous/new-api) — cards, tables, filter bars,
button hierarchy, form grouping, dialogs, empty states, badges, spacing rhythm,
and settings-page layout — while keeping this system's existing color palette
and the `--radius-*` design tokens introduced in round 1.

Reference success case (read-only, never modify): `D:\My2KProjects\codebuddy2api-ui_template`.

Round 1 (`10-18-newapi-ui-refresh`) established the radius token scale, the
top-right account dropdown, the animated collapsible sidebar, and removed
duplicated titles/blocks/footers. Round 2 extends that to the full UI.

## Requirements

1. Admin content pages (`views/admin/*.html`, `public/js/pages/admin/*.js`,
   `public/css/vaultsso-admin-pages.css`) adopt the new-api content language:
   filter bar + table + pagination/empty state, clear action-button hierarchy,
   badges, and grouped dialog forms.
2. The account/auth/docs pages (`views/account`, `views/auth`, `views/docs` and
   their CSS/JS) adopt the new-api settings-page and login-page language:
   grouped cards, legible setting rows, and a clear button hierarchy.
3. The admin shell (`admin-shell.js`, `views/admin/index.html`,
   `public/css/vaultsso-admin.css`) continues toward new-api: top bar with the
   single page title or breadcrumb, sidebar group headings, selected state,
   icon-centred collapsed rail with tooltips, and a mobile drawer.
4. `public/css/vaultsso-base.css` / `vaultsso-utilities.css` carry the shared
   new-api component baselines for buttons, inputs, badges, cards, dialogs, and
   tables.
5. Radii use only `--radius-*` tokens: cards ≤ 16px, controls 8px, chips 4–8px,
   circular avatars and pills exempt.

## Constraints

- The existing color palette is unchanged.
- No functional additions: no multi-key token page, no storage management.
- API contracts, form field names, JS selectors (`id` / `class` / `data-*`), and
  i18n keys must keep working.
- No duplicated page titles or repeated information blocks.
- No sidebar administrator identity card, no sidebar session block, no
  main-content console footer.
- No page may break.
- The user's work previously frozen in 10 files is legitimate work authored by
  the user. `sso-lead` commits it first, split into conventional commits by
  feature, before any other agent touches those files.

## Work Split

- `sso-lead` — commit the 10 user-authored files as conventional commits;
  own the shared component baselines in `vaultsso-base.css` /
  `vaultsso-utilities.css`; final page-by-page review against new-api and the
  full test run.
- `sso-shell` — `admin-shell.js`, `views/admin/index.html`,
  `public/css/vaultsso-admin.css`.
- `sso-admin` — other `views/admin/*.html`, `public/js/pages/admin/*.js`,
  `public/css/vaultsso-admin-pages.css`.
- `sso-user` — `views/auth`, `views/account`, `views/docs` and their CSS/JS
  (after `sso-lead` finishes the commits).

## Acceptance Criteria

- [ ] The 10 user-authored files are committed as conventional commits with
      `check-syntax` and the related tests passing, and no user code removed.
- [ ] Shared component baselines exist in `vaultsso-base.css` /
      `vaultsso-utilities.css` and reference `--radius-*` only.
- [ ] Admin content pages present filter bar + table + empty state, clear
      button hierarchy, and grouped dialog forms.
- [ ] Account/auth/docs pages present grouped setting cards and a clear button
      hierarchy.
- [ ] The admin shell shows the page title or breadcrumb exactly once, has
      sidebar group headings, and a tooltip-bearing collapsed rail.
- [ ] No radius above 16px outside circular avatars and pills.
- [ ] All JS-referenced selectors, forms, API calls and i18n keys still resolve.
- [ ] `node scripts/check-syntax.js` and every `package.json` test script pass.
- [ ] Tool directories (`.agent/`, `.claude/`, `.codex/`, …) and `AGENTS.md`
      stay untracked.

## Background

- Round 1 archived task: `.trellis/tasks/archive/2026-10/10-18-newapi-ui-refresh/`.
- Working tree carries the 10 user-authored files plus untracked
  `public/css/vaultsso-mfa.css`, which `views/auth/mfa.html` references and
  therefore belongs in the same commit as the MFA work.
