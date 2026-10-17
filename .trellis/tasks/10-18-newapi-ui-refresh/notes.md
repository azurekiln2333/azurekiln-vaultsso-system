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

## Agent status log

| Agent | Owned files | Status |
|---|---|---|
| sso-lead | tokens, base + utilities css, review | tokens committed; reviewing |
| sso-shell | `admin-shell.js`, `views/admin/index.html`, shell part of `vaultsso-admin.css` | notified |
| sso-admin | other `views/admin/*.html`, `public/js/pages/admin/*.js` | notified | |
| sso-user | `views/auth`, `views/account`, `views/docs` + matching css/js | notified |

## sso-admin progress (page content area)

Owned files: `views/admin/{clients,security,smtp,tokens,user,users,user-applications}.html`,
`public/js/pages/admin/*.js`, plus the new page-content stylesheet
`public/css/vaultsso-admin-pages.css` (owned by sso-admin; it only styles page
content, never the shell in `vaultsso-admin.css`).

Done:

- `public/css/vaultsso-admin-pages.css` created: page radius overrides driven by
  `--radius-lg/-sm/-xs/-full`, buttons/inputs 8px, chips 4px, panels capped at 16px.
- All seven admin pages link the page stylesheet after `vaultsso-admin.css`.
- Duplicate hero blocks removed on clients / tokens / smtp / security / users /
  user detail; each page now has exactly one `<h1>` page header (no
  "管理员控制台 / 管理中心" eyebrow repeated next to the shell brand).
- Redundant "点击页面右上角保存设置" hints removed (the header already has the save button).
- User detail badges switched from `rounded-full` to token `rounded`; avatar kept circular.
- `node scripts/check-syntax.js`, `npm run check:e2e` and `node tests/browser-smoke.cjs` pass.

Open / needs other owners:

- `views/admin/clients.html` header currently has only the title block; a
  right-aligned action area is unused until someone adds actions.
- Functionality untouched: no API, form field, id or data-* selector changed.
