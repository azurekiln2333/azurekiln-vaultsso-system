# Execution Notes — new-api UI refresh

## Shared design tokens (owner: sso-lead)

Committed as `style(ui): introduce md3 radius tokens and shrink base radius scale`.

### Files owned by sso-lead — do not edit from other agents

- `public/css/vaultsso-base.css`
- `public/css/vaultsso-utilities.css` (generated)
- `tailwind.config.cjs`

### Token definitions (`public/css/vaultsso-base.css`)

```css
:root {
  --radius-xs: 4px;
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-full: 9999px;
  --radius-pill: 9999px;
}
```

### Tailwind mapping (`tailwind.config.cjs`)

| Utility | Value |
|---|---|
| `rounded` / `rounded-xs` | `var(--radius-xs)` = 4px |
| `rounded-lg` / `rounded-sm` | `var(--radius-sm)` = 8px |
| `rounded-xl` / `rounded-md` | `var(--radius-md)` = 12px |
| `rounded-2xl` / `rounded-3xl` | `var(--radius-lg)` = 16px |
| `rounded-full` | 9999px (avatars, pills) |

Rebuild after markup changes that use new utilities:

```
npx tailwindcss -c tailwind.config.cjs -i styles/tailwind.css -o public/css/vaultsso-utilities.css --minify
```

### Usage rules

- Large panels / cards: `var(--radius-lg)` (16px max).
- Buttons / inputs / selects: `var(--radius-sm)` (8px).
- Chips / tags / badges: `var(--radius-xs)` or `var(--radius-sm)` (4–8px).
- Circular avatars and pills: keep `9999px` (`var(--radius-full)`), exempt.
- No numeric radius above 20px may remain in any stylesheet.

## File ownership

| Agent | Owned files |
|---|---|
| sso-lead | `public/css/vaultsso-base.css`, `public/css/vaultsso-utilities.css`, `tailwind.config.cjs` |
| sso-shell | `public/js/shared/admin-shell.js`, `views/admin/index.html`, `public/css/vaultsso-admin.css` (shell part only) |
| sso-admin | other `views/admin/*.html`, `public/js/pages/admin/*.js`, `public/css/vaultsso-admin-pages.css` |
| sso-user | `views/auth`, `views/account`, `views/docs`, `public/css/vaultsso-authorize.css`, `vaultsso-error.css`, `vaultsso-docs.css` |

## FROZEN — user's uncommitted work, must never be added or committed

These files had uncommitted user changes before this task started. No agent may
`git add`, `git commit`, `git checkout`, `git stash`, or `git reset` them.

- `public/css/vaultsso-profile.css`
- `views/account/profile.html`
- `views/auth/mfa.html`
- `public/js/pages/account/profile.js`
- `public/js/pages/account/authenticators.js`
- `public/js/pages/auth/mfa.js`
- `public/js/shared/i18n.js`
- `scripts/check-syntax.js`
- `tests/browser-smoke.cjs`
- `tests/password-mfa-browser.cjs`

### Uncommitted radius edits left in `public/css/vaultsso-profile.css`

sso-user tightened these values in the working tree only (not committed, held
for the user to decide). Recorded here for the user's review:

| Line | Selector | Before | After |
|---|---|---|---|
| 42 | `.profile-card` | `22px` | `var(--radius-lg)` = 16px |
| 117 | `.hero` | `18px` | `var(--radius-lg)` = 16px |
| 132 | `.avatar` (square avatar block) | `18px` | `var(--radius-md)` = 12px |
| 204 | `.ghost-button` | `14px` | `var(--radius-sm)` = 8px |
| 430 | `.modal-card` | `20px` | `var(--radius-lg)` = 16px |
| 513 | `.profile-card` (in `max-width: 760px`) | `18px` | `var(--radius-lg)` = 16px |

Pills at lines 71 / 97 / 110 / 175 (`999px`) are intentional and unchanged.

## Review log

| Commit | Verdict |
|---|---|
| `41ec285` (sso-user) docs page structural rewrite | Rejected — out of scope, reverted in `3b621c9` |
| `c807e20` (sso-user) error page rewrite hid `#errorTitle` | Rejected — broke dynamic error code, fixed in `af57f3d` |
| `ca5e271` (sso-shell) shell rebuild | Accepted pending `.hidden` scoping |
| `68f531e`…`b0d92a5` (sso-admin) page content | Accepted |

## Agent status log

| Agent | Status |
|---|---|
| sso-lead | tokens committed; reviewing |
| sso-shell | first shell round committed; asked to scope global `.hidden` |
| sso-admin | asked to resolve top-bar/page `<h1>` duplicate-title conflict |
| sso-user | docs + error reverted/fixed; profile.css frozen, uncommitted |
