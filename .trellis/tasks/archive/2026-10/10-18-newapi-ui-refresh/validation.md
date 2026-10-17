# Validation — new-api UI refresh

Date: 2026-10-18
Branch: `main`
Commits covered: `fcac665` … `54abdd7`

## Checks run

| Check | Command | Result |
|---|---|---|
| Syntax / browser script refs | `node scripts/check-syntax.js` | pass — 92 files |
| End-to-end suite | `node scripts/check-e2e.js` | pass — 202 tests, 0 fail |
| Browser smoke | `node tests/browser-smoke.cjs` | pass — login, CAPTCHA, profile, admin pages, CSP |
| Account bindings | `node tests/account-bindings-browser.cjs` | pass — phone save/reload/unbind, app bindings, desktop+mobile |
| Auth feedback | `node tests/auth-feedback-browser.cjs` | pass — login, register, recovery, desktop+mobile |
| Password / MFA | `node tests/password-mfa-browser.cjs` | pass — CAPTCHA, TOTP autofill, recovery, OAuth nonce/state/PKCE |
| Multi authenticator | `node tests/multi-authenticator-browser.cjs` | pass — add/remove/independent login, desktop+mobile |
| Turnstile | `node tests/turnstile-browser.cjs` | pass — login, registration, desktop+mobile |

## Static audits

### Radius audit

Scanned every `public/css/*.css` (excluding the generated utilities build) and
every inline `border-radius` in `views/**/*.html` for numeric values.

- Deviations above 16px (excluding `9999px` pills/circles): **0**.
- `rounded-2xl` / `rounded-3xl` in views: **0 occurrences** (both map to 16px
  through `tailwind.config.cjs`, so nothing can exceed the cap).
- Utilities build regenerated from tokens:
  `rounded`→`var(--radius-xs)`, `rounded-lg`→`var(--radius-sm)`,
  `rounded-xl`→`var(--radius-md)`, `rounded-2xl/3xl`→`var(--radius-lg)`,
  `rounded-full`→`9999px`.

### Duplicate-element audit

- `<h1>` per admin page: **0** — the shell top bar `#adminPageTitle` is the
  single source of the page name (`d9f1b87`).
- `<hr>` in admin pages: **0**; the only remaining `border-t` is the filter bar
  separator in `clients.html`, which is not duplicated.
- `<footer>` in `views/admin/*.html`: **0**. No "AzureKiln · 管理控制台" console
  footer anywhere.
- Sidebar administrator identity card and bottom admin session block: removed
  (`ca5e271`); confirmed absent from `admin-shell.js`.

## Review findings and fixes

| Finding | Fixed by |
|---|---|
| `views/docs/api.html` rewritten wholesale (312 lines) — out of scope, risk of breaking layout | reverted in `3b621c9`; only the CSS cache key and one radius line remain |
| `views/auth/error.html` rewrite hid `#errorTitle`, so `error.js` no longer surfaced the real OAuth2 error code | fixed in `af57f3d`; page markup restored, `vaultsso-error.css` reduced to a 9-line radius mapping |
| Global `.hidden { display: none !important; }` added by the shell collided with the Tailwind utilities class | scoped to `.admin-account-menu.hidden, .admin-overlay.hidden` in `a420522` |
| Page `<h1>` duplicated the top-bar page title | removed in `d9f1b87` |
| PowerShell line-splice accident in `public/css/vaultsso-profile.css` | repaired by sso-user; verified 887 lines, braces 249/249, `git diff --check` clean |

## Frozen user work (not committed)

The following files still carry the user's pre-existing uncommitted changes and
were deliberately left untouched in the index:

- `public/css/vaultsso-profile.css` (including 6 uncommitted radius edits, see
  `notes.md`)
- `views/account/profile.html`
- `views/auth/mfa.html`
- `public/js/pages/account/profile.js`
- `public/js/pages/account/authenticators.js`
- `public/js/pages/auth/mfa.js`
- `public/js/shared/i18n.js`
- `scripts/check-syntax.js`
- `tests/browser-smoke.cjs`
- `tests/password-mfa-browser.cjs`

`views/account/profile.html` and `views/auth/mfa.html` still contain page-level
`<footer>` elements. They live inside the frozen files and are not the
management-console footer the requirement targets, so they were left alone.

## Out-of-scope items confirmed absent

- No token multi-key page.
- No storage management page.
- No color palette changes (`#003d9b`, `#0052cc`, `#0b57d0`, `rgba(18,32,51,*)`
  unchanged).
- No backend, API contract, or i18n copy changes.
