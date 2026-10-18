# Validation — new-api full UI refresh (round 2)

Date: 2026-10-18
Branch: `main`
Commits covered: `ad802df` … `e03c189`

## Test suite

| Check | Command | Result |
|---|---|---|
| Syntax / browser script refs | `node scripts/check-syntax.js` | pass — 98 files |
| End-to-end suite | `node scripts/check-e2e.js` | pass — 202 tests, 0 fail |
| Browser smoke | `node tests/browser-smoke.cjs` | pass — login, CAPTCHA, profile, admin pages, CSP |
| Account bindings | `node tests/account-bindings-browser.cjs` | pass — phone save/reload/unbind, app bindings, desktop+mobile |
| Auth feedback | `node tests/auth-feedback-browser.cjs` | pass — login, register, recovery, desktop+mobile |
| Password / MFA | `node tests/password-mfa-browser.cjs` | pass — CAPTCHA, TOTP autofill, recovery, i18n, OAuth nonce/state/PKCE |
| Multi authenticator | `node tests/multi-authenticator-browser.cjs` | pass — add/remove/independent login, desktop+mobile |
| Turnstile | `node tests/turnstile-browser.cjs` | pass — login, registration, desktop+mobile |

One transient `tests/phone-api.test.js` failure appeared on the first
`check:e2e` run. Re-running that file alone (13/13 pass) and the full suite
again (202/202 pass) confirmed it was a port/concurrency flake, not a
regression.

## Custom audits (`audit-*.cjs` in this directory)

### `audit-visual.cjs` — real browser, authenticated session

Seeds a fixture session into Chromium and inspects every refreshed surface at
1440px and 390px:

```
profile              ok          users @390           ok
users                ok          profile @390         ok
clients              ok          admin @390           ok
security             ok
smtp                 ok
tokens               ok
user-applications    ok
admin-shell          ok
api-docs             ok
login                ok
→ Visual audit clean.
```

Per page it asserts: at most one `<h1>`, at most one `#adminPageTitle`, zero
`<footer>`, zero `<hr>`, no horizontal overflow, and no computed
`border-radius` between 16px and 999px.

### `audit-selectors.cjs` — JS ↔ template contract

All 250 `getElementById` targets across 12 page scripts resolve in their
templates:

| Script | ids | Result |
|---|---|---|
| `users.js` | 15 | all present |
| `clients.js` | 26 | all present |
| `security.js` | 52 | all present |
| `smtp.js` | 12 | all present |
| `tokens.js` | 8 | all present |
| `user.js` | 32 | all present |
| `user-applications.js` | 5 | all present |
| `profile.js` | 59 | all present |
| `mfa.js` | 10 | all present |
| `login.js` | 24 | all present |
| `error.js` | 7 | all present |

### `audit-contracts.cjs` — data attributes and i18n keys

```
data-* selectors queried from JS : 2   → unresolved: none
i18n keys used in views/js      : 197 → unresolved: none
                                     (487 defined in i18n.js)
```

### `audit-dupes.cjs` — duplicate content

```
Templates scanned: 13
No duplicate ids, no multi-h1, no <footer> in views.
```

### Radius audit

Every `public/css/*.css` (excluding the generated utilities build) plus every
inline `border-radius` in `views/**/*.html`:

- Values above 16px and below 999px: **0**.
- `rounded-2xl` / `rounded-3xl` in views: mapped to `var(--radius-lg)` = 16px.
- Circular avatars and pills keep 9999px.

### Out-of-scope feature audit

- No multi-key token page.
- No storage management page.
- No top-bar search box. The `admin-search` labels found in `clients.html`,
  `tokens.html`, `user-applications.html` and `users.html` are the pre-existing
  page-level filters (previously `#searchInput` with utility classes), not a new
  shell feature.

## Review findings and fixes

| Finding | Fixed by |
|---|---|
| `views/docs/api.html` rewritten wholesale (312 lines) in round 1 | reverted earlier; round 2 kept markup untouched |
| `views/auth/error.html` hid `#errorTitle`, losing the dynamic OAuth2 error code | restored in `af57f3d` |
| Global `.hidden { display: none !important }` collided with Tailwind utilities | scoped in `a420522` |
| Page `<h1>` duplicated the top-bar title | removed in `d9f1b87` |
| `vaultsso-profile.css` redefined `--line`, `--success`, `--danger`, `--shadow` at `:root`, silently overriding the shared tokens for its own page | renamed to `--profile-*` in `29fbf56`; the 4 `var(--line)` uses in the new overlay layer still point at the shared token |
| Decorative `<footer>` rendered only "VaultSSO" on the profile page | removed in `28b4f41` |
| Decorative `<footer>` rendered only a brand phrase on the MFA page, plus a now-orphaned `auth.mfa.footer` key | removed in `e03c189` |

## Notes for the user

- No color was changed: the accent family is still `#003d9b` / `#0052cc` /
  `#0b57d0`. The new-api purple/green primary is not used.
- All radii reference `--radius-*` tokens.
- `public/css/vaultsso-utilities.css` is a Tailwind build artifact; regenerate
  with `npm run build:css` after adding utility classes to templates.
- Scenes the audits seed a session directly into Chromium because the fixture
  sets `PUBLIC_BASE_URL` to a placeholder origin, so the browser login POST is
  rejected by the same-origin guard. The shipped browser tests log in through
  the real form and remain the authoritative end-to-end check.
