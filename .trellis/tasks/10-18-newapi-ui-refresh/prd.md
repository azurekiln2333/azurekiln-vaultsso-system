# new-api UI refresh

## Goal

Improve the VaultSSO UI by following the layout and interaction patterns of
[new-api](https://github.com/QuantumNous/new-api), while keeping this system's
existing color palette unchanged.

Reference success case (read-only, never modify): `D:\My2KProjects\codebuddy2api-ui_template`.

## Requirements

Only the four items below. Nothing outside this list may be added.

1. **Unify and shrink border radii** to the new-api 0.5-step / MD3 scale using
   tokens `--radius-xs: 4px; --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px`.
   Large panels/cards max 16px, buttons/inputs 8px, chips/tags 4–8px.
   Circular avatars and pills are exempt. No radius above 20px may remain.
2. **Do not break any existing screen or behavior.** Every `id` / `class` /
   `data-*` selector used by JS, every form, API call and i18n key must keep
   working.
3. **Remove duplicated elements.** A page title appears exactly once (not in
   sidebar + header + card simultaneously), no redundant horizontal separators,
   no repeated information blocks.
4. **Layout follows new-api:** left sidebar + top bar; avatar/account/logout
   move to the top-right dropdown menu; the sidebar collapse/expand has a smooth
   transition animation (as in new-api); the sidebar does not contain an
   "administrator" identity card and no admin session block at its bottom; the
   main content has no "AzureKiln · 管理控制台" style footer.

## Out Of Scope

- Token multi-key pages, storage management, and any other unrelated feature
  (belongs to a different project).
- Backend, API contracts, authentication policy, i18n copy changes.
- Color palette changes.

## Work Split

- `sso-lead` — design tokens (`vaultsso-base.css`), base/utilities styles, task
  coordination, and the final code review of all three agents' commits.
- `sso-shell` — admin shell: `public/js/pages/admin/admin-shell.js`,
  `views/admin/index.html`, and the shell portion of `public/css/vaultsso-admin.css`.
- `sso-admin` — remaining `views/admin/*.html` page content plus the matching
  `public/js/pages/admin/*.js` files.
- `sso-user` — `views/auth`, `views/account`, `views/docs` and their matching
  CSS/JS.

## Acceptance Criteria

- [ ] Radius tokens are defined once and base/utilities styles reference them.
- [ ] No radius above 20px remains in touched stylesheets; cards ≤ 16px,
      controls = 8px, chips 4–8px.
- [ ] Admin shell uses left sidebar + top bar, with the account menu (avatar,
      account links, logout) in the top-right dropdown.
- [ ] Sidebar collapse/expand animates smoothly.
- [ ] No administrator identity card in the sidebar, no admin session block at
      the sidebar bottom, no main-content console footer.
- [ ] Each page title renders exactly once; no duplicated separators or info
      blocks.
- [ ] All JS-referenced selectors, forms, API calls and i18n keys still resolve.
- [ ] `node scripts/check-syntax.js` and the package test scripts pass.
- [ ] Pre-existing uncommitted user work in the worktree is preserved.

## Background And Constraints

- The worktree already contains the user's uncommitted changes
  (`vaultsso-profile.css`, `account/authenticators.js`, `account/profile.js`,
  `auth/mfa.js`, `shared/i18n.js`, `scripts/check-syntax.js`,
  `tests/browser-smoke.cjs`, `tests/password-mfa-browser.cjs`,
  `views/account/profile.html`, `views/auth/mfa.html`). They must not be
  reverted, stashed, or reset.
- No `git add .` / `git add -A`; only explicitly named files per commit.
- Four agents share one worktree, so file ownership is strict and coordination
  happens through this task directory plus commit messages.
