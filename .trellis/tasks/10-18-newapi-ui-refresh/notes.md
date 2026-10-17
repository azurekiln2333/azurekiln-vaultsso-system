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
| sso-admin | other `views/admin/*.html`, `public/js/pages/admin/*.js` | notified |
| sso-user | `views/auth`, `views/account`, `views/docs` + matching css/js | notified |
