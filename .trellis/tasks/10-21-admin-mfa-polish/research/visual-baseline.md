# Visual baseline — admin surfaces and MFA code entry

Research worker: `trellis-check` (visual baseline ownership)
Date captured: 2026-10-21
Repo state: `D:/MyNewWebProjects/azurekiln-oauth2`, branch `style/oauth-login-cleanup`, product tree **clean** (`git status --porcelain -- public views tests` empty) — these are the true pre-change values.
Scope: read-only. No product/spec/test/task file was modified.

- Harness (temporary, ignored): `.artifacts/admin-mfa-polish/baseline/capture-baseline.cjs`
- Raw measurements (121 entries): `.artifacts/admin-mfa-polish/baseline/measurements.json`
- Screenshots (**36 PNGs**): `.artifacts/admin-mfa-polish/baseline/*.png`

## Screenshot matrix (36 files, 1.2 MB total)

Languages `zh`, `en` × viewports `1280x900` (`desktop`), `390x844` (`mobile`), `320x740` (`narrow`).
Each full set is 6 files per language/viewport (admin) and 6 files per language/viewport (MFA) = 18 + 18 = 36.

| Group | Files per language×viewport | Filename pattern |
| --- | --- | --- |
| Admin shell + overview (users embedded) | 1 | `admin-overview-users-{zh,en}-{desktop-1280,mobile-390,narrow-320}.png` |
| Admin form + table (`/apps.html`) | 1 | `admin-clients-form-table-…png` |
| Admin table (`/users.html`) | 1 | `admin-users-table-…png` |
| MFA email code | 1 | `mfa-email-code-…png` |
| MFA authenticator (TOTP) | 1 | `mfa-totp-…png` |
| MFA recovery mode | 1 | `mfa-recovery-…png` |

Total: 6 surfaces × 3 viewports × 2 languages = **36 screenshots**, from **60 navigations**
(18 admin page loads, 18 MFA page loads, 24 extra language/recovery state switches).

## Page errors and overflow (all clear)

- **`pageerror`: 0** on all 60 navigations, every language and viewport (`*/pageerrors` measurements are all empty arrays).
- **Horizontal overflow: 0px** on every admin, iframe and MFA surface at 1280, 390 and 320 in both languages.
  The only horizontal scrolling is *inside* `.napi-table-scroll` (see Finding 2), which never overflows the viewport.

## Fixture cleanup and side effects

- The harness `finally` block always runs `browser.close()` then `fixture.close()`, which closes the HTTP
  server and removes the temporary signing-key directory.
- No real database, no real users, no external mail (nodemailer stubbed), no Turnstile keys, no reused or
  persisted browser session (a fresh `browser.newContext()` per cell, closed after each cell).
- The last MFA cells intentionally leave the pending challenge unfinished and then close the context, so no
  authentication is completed and no session survives the run.
- Product tree verified untouched afterwards: `git status --porcelain -- public views tests .trellis/spec` shows
  no modified product, test or spec file.

## Method

Isolated in-memory fixture (`tests/support/fixture.js`: memory DB, random per-run JWT/OIDC keys, stubbed mail transport, no Turnstile keys) on an ephemeral port; off-origin requests aborted in the browser context. Unlike the archived `10-18-newapi-ui-full/audit-visual.cjs` cookie-injection approach, `PUBLIC_BASE_URL` is set to the local origin **before** `createFixture()`, so admin pages and MFA are reached through the real login form (same technique as the shipped `tests/password-mfa-browser.cjs`). No real DB, no real users, no external sends, no existing browser session reused. Browser and fixture are closed in `finally`.

Matrix: `zh` / `en` × `desktop 1280x900` / `mobile 390x844` / `narrow 320x740`.

Captured surfaces:

| Surface | URL | Why |
| --- | --- | --- |
| Admin shell + overview (users embedded) | `/admin.html` → iframe `/users.html` | default shell route is `users` (`admin-shell.js:210`); shows shell chrome *and* iframe background seam |
| Representative form + table | `/apps.html` → `#clientForm` in `.napi-panel` + `.napi-table` | `clients.html:49` |
| Representative table | `/users.html` | `.admin-table-panel` + `.admin-toolbar-card` |
| MFA email code | `/oauth2/mfa` (`login_email_code=true`) | R2 baseline |
| MFA authenticator (TOTP) | `/oauth2/mfa` (`totpEnabled`, recovery toggle visible) | R2/R3/R4 baseline |
| MFA recovery | same page, `#recoveryToggle` clicked | R4 "recovery stays manual" baseline |

## Finding 1 — R1: the decorative gradient is painted twice (shell *and* iframe)

Source, current state:

- `public/css/vaultsso-base.css:92-97` — `.vaultsso-page-surface` = 2 radial gradients + `linear-gradient(135deg, #eef5ff, #f8fbff, #dee9ff)`.
- `views/admin/index.html:14` — shell `<body class="vaultsso-page-surface min-h-screen text-ink">`.
- Every embedded admin page uses the same class on `<body>`: `views/admin/users.html:15`, `clients.html:14`, `security.html:15`, `smtp.html:15`, `tokens.html:14`, `user-applications.html:16`, `user.html:15` (and `views/docs/api.html:12`).

Measured computed `background-image` (identical strings, zh+en, all three widths):

| Element | Value |
| --- | --- |
| shell `body` | `radial-gradient(circle at 0% 0%, rgba(11,87,208,.14), transparent 24%), radial-gradient(circle at 100% 100%, rgba(0,61,155,.08), transparent 28%), linear-gradient(135deg, rgb(238,245,255) 0%, rgb(248,…` |
| iframe `body` | same three-layer value |
| shell `html` / iframe `html` | `none` (transparent) |

Consequences visible in the screenshots (not CSS-only conclusions):

- `admin-overview-users-zh-desktop-1280.png` — blue radial glow in the content area while the topbar and sidebar are white; the boundary at the topbar and at the sidebar edge is a visible tone seam. The iframe content re-paints the gradient, so the gradient origin restarts inside the iframe rather than continuing the shell's.
- `admin-clients-form-table-zh-desktop-1280.png` — the gradient surrounds the four stat cards and the editor panel; the right half of the content area is empty gradient.
- `admin-clients-form-table-zh-mobile-390.png` — the gradient wash is clearly visible behind the page description directly under the topbar.
- White panels (`--surface-card`) sit on the gradient, so every card edge reads as a halo rather than a hairline.

Card/panel radii already come from tokens (`admin-table-panel` `--radius-lg`, `admin-toolbar-card` `--radius-md`, `clients` `.napi-panel` measured **16px**), so R1 is essentially a **background/surface** problem, not a radius problem. Note `vaultsso-page-surface` is also used by `views/docs/api.html`, so an admin-scoped change must not silently restyle `/api-docs.html` (child PRD already requires auditing shared consumers).

Consumers to audit before editing: `.vaultsso-page-surface` (8 admin views + docs) and `.bg-mesh` (`views/auth/login.html:12`, `views/auth/error.html:12`, `vaultsso-base.css:85-90`) — the public auth pages use `.bg-mesh`, so leaving `vaultsso-base.css:92-97` intact and scoping an admin override is the lower-risk route.

## Finding 2 — R1: shell chrome and page density measurements

Measured (getBoundingClientRect + computed style):

| Metric | desktop 1280 | mobile 390 | narrow 320 |
| --- | --- | --- | --- |
| iframe size (`#adminFrame`) | 1024x844 | 390x788 | 320x684 |
| sidebar width | 256 | drawer (hidden at ≥ breakpoint) | drawer |
| topbar height | 56 | 56 | 56 |
| `#adminPageTitle` | 12px/600, 48x18 | 12px, **0 height** (hidden in drawer layout) | 12px, **0 height** |
| users table row height | **121px** | 121px | 121px |
| users table inner horizontal scroll | **119px** | **737px** | **807px** |
| clients `.napi-panel` | 420x973, radius 16px | 342x1033 | 272x1075 |
| clients form input | 378x32, 13px, radius 8px | 300x32 | 230x32 |
| admin buttons (`napi-btn-sm`) | 46–94 x 28, 12px/600, radius 8px | same | same |

Observations worth carrying into design (each backed by a screenshot):

1. **Table rows are 121px tall** at every width because the UUID/description columns wrap (`admin-overview-users-zh-desktop-1280.png`). This is the single largest density deviation from a restrained flat admin table.
2. **The users table overflows its own scroll container at desktop**: 119px of hidden horizontal content even in a 1024px iframe — the right-hand `创建时间` column is visibly clipped at the iframe edge in the screenshot. At 390/320 the inner scroll grows to 737/807px. The page itself never overflows the viewport (measured `0` everywhere), so this is contained by `.napi-table-scroll` and only shows as clipped columns.
3. **`clients` stat cards stack 1-per-row at 390px** (four full-width rows for four numbers, visible in `admin-clients-form-table-zh-mobile-390.png`) and the editor panel is a fixed 420px column that leaves the right half of the desktop canvas empty.
4. Shell top bar has **no visible page title at mobile/narrow** (measured height 0); only the sidebar drawer carries context.
5. Pre-existing quirk, not caused by the gradient: the account menu shows `加载中...` in the sampled desktop
   overview capture (`admin-overview-users-zh-desktop-1280.png`) — the shell's session hydration had not
   finished when the screenshot was taken — while it shows the account name on the clients capture at the same
   viewport. This is a **capture-timing limitation of that one image**, not a finding about the task; the
   "after" run should wait for the account name (or the menu's loaded state) before screenshotting so the pair
   is comparable. Recorded as an observation only.

## Finding 3 — R2: MFA proportions (the actual disproportion)

Measured on the freshly loaded, enabled page (zh, email mode; identical for en):

| Metric | desktop 1280 | mobile 390 | narrow 320 |
| --- | --- | --- | --- |
| `.mfa-card` | 416x453, padding 24, radius 16 | 358x424 | 288x448 |
| card / viewport | 0.325 | 0.918 | 0.900 |
| `#mfaTitle` | **30px/800**, 38px tall | 26px/800, 33px | 26px/800, 33px |
| `#codeEntry` | 366x**80** | 308x**64** | 238x**64** |
| one slot | **51x80**, radius 8, 20px/700 | 46x64 | 35x64 |
| slot gap | 12 | 6 | 6 |
| `#submit` | 366x**32**, 13px/600, radius 8 | 308x32 | 238x32 |
| title→code row gap (real; `#codeLabel` is a 1x1 SR-only element, `vaultsso-mfa.css:153-161`) | **96px** | **97px** | **121px** |
| code row→button gap | 40px | 32px | 32px |
| card top offset | 256 | 319 | 255 |
| horizontal overflow | 0 | 0 | 0 |

Source of the mismatch (root cause, with anchors):

- `public/css/vaultsso-mfa.css:163-167` — `.mfa-code-entry { height: 80px; margin-bottom: 40px; }` and `:347-371` (`@media max-width:540px`) `height: 64px`.
- `public/css/vaultsso-mfa.css:136-142` — `.mfa-intro h1 { font-size: 30px; font-weight: 800; }`; `:364-366` mobile 26px.
- The later "new-api surface alignment" layer (`vaultsso-mfa.css:394-539`) retuned the card, icon, slots and button to the 32px control rhythm (`--control-height` at `vaultsso-base.css:61`) but **never overrides `.mfa-code-entry` height or `.mfa-intro h1` size**. Result: an 80px code row and a 30px/800 heading above a 32px button — a 2.5:1 height ratio inside a 416px card, plus a 96–121px dead gap under the heading block.

Visual confirmation (`mfa-email-code-zh-desktop-1280.png`): the six portrait 51x80 slots dominate the card, the primary action reads as a thin strip beneath them, and the heading is heavier/larger than anything else on the page. `mfa-email-code-zh-narrow-320.png`: slots compress to 35x64 while the button stays 32px, so the row still dominates on the smallest width.

## Finding 4 — R2/R4: recovery mode and English text shape

- Recovery (`mfa-recovery-zh-desktop-1280.png`): slots collapse (measured 0x0), and `#code` renders as a single **80px-tall** text box (`vaultsso-mfa.css:230-258`) — a text field at code-row height, still under the same 30px heading and beside a 32px button. `#recoveryToggle` becomes visible and, at desktop, sits on one line with `返回登录页` on the right.
- English narrow (`mfa-totp-en-narrow-320.png`): the heading wraps to two lines (`Two-Step / Verification`) and the card grows to **504px** vs 448px in zh; the actions row wraps so `Use a recovery code` drops to its own line below `Back to Sign In` (in zh they share one row). No overflow in either language (measured 0), so this is a balance/rhythm issue, not a clipping bug.
- `#instructions` has `min-height: 48px` (`vaultsso-mfa.css:144-151`), which contributes to the 96px heading-block gap when the hint is one line.
- Empty slots show a decorative `•` from `.mfa-code-slot:empty::before` (`vaultsso-mfa.css:191-195`) — worth preserving as the idle state when heights are retuned.

## Finding 5 — zero-regression baseline for the MFA contract

Recorded so implementation can prove it changed only presentation: on every captured MFA state, `#code` keeps `name=email_code` / `totp_code` / `recovery_code`, `#recoveryToggle.hidden` is `false` only for TOTP/recovery, exactly 6 `[data-code-slot]` exist, `.mfa-page` background is flat `rgb(248,249,251)` (the MFA page is already flat — the gradient problem is admin-only), and the submit button currently has **no** gradient (`background-image: none`, despite the `vault-gradient` class in `views/auth/mfa.html:47`). **Zero `pageerror` and zero horizontal overflow on all 60 navigations.**

## Capture limitations (read before comparing "after" images)

1. **Topbar session text race.** `admin-overview-users-*` images may show `加载中...` (loading) instead of the
   account name — see Finding 2 item 5. Compare chrome/layout/surfaces, not the account label, and have the
   "after" harness wait for the resolved account name.
2. **Screenshots are viewport-sized, not full-page.** Panels taller than the viewport are cut at the fold
   (`clients` panel is 973-1201px tall vs an 844/788/684px viewport), so the lower part of the editor form is
   not visible in the images; its height is recorded in `measurements.json` instead.
3. **Admin screenshots use the real login form**, so the fixture's single seeded admin account owns the data:
   the users table renders exactly one row, and the clients page shows the empty state. Row-count-dependent
   impressions of density come from that single 121px row, not from a populated dataset.
4. **`zh-TW` was not captured.** The matrix is `zh` + `en` per the parent PRD's "Chinese and English" acceptance
   wording; `zh-TW` is covered by the existing MFA browser test only.
5. **Slot glyphs are placeholders.** The visible `•` in empty slots is `.mfa-code-slot:empty::before`, so an
   empty-slot image always shows six dots regardless of input state.
6. Screenshot color/luminance differences between shell and iframe in the admin images are genuine rendered
   output (two separate documents), not compression artifacts.

No blocker was found.

## Test implications

1. **Add a before/after screenshot pair** in the task directory for the three surface classes (shell+overview, form+table, MFA email/TOTP/recovery) at 1280/390/320 in zh and en — AC5 requires actual screenshots, and this baseline file plus `measurements.json` supplies the "before" side. The "after" set should reuse the same harness with a different output prefix so the pairs are comparable cell-for-cell.
2. **New assertions worth adding to the harness for the "after" run** (all currently absent from shipped tests):
   - shell `body` and iframe `body` computed `background-image` must both be `none` (or share one flat color) and must be **equal** — this is the seam check AC1 needs;
   - users table row height drops below the current 121px and the inner horizontal scroll is 0 at 1280;
   - `#submit` height ≥ `.mfa-code-entry` height × ~0.75 (i.e. the action is no longer a strip), and `#codeEntry` height ≤ ~56px desktop / ≤48px mobile.
3. **Existing suites that must stay green and already cover the contracts I must not break**: `tests/password-mfa-browser.cjs` (slots, names, `autocomplete`, recovery toggle, i18n preservation, bottom feedback, 320px overflow) and `npm run check:browser` (`browser-smoke.cjs` navigates `/admin.html`, `/apps.html`, `/users.html`, `/security.html`, `/smtp.html`, `/tokens.html`, `/account-bindings.html` and asserts **zero `pageerror`** plus no CSP-blocked scripts). `tests/multi-authenticator-browser.cjs` and `tests/account-bindings-browser.cjs` also render these surfaces.
4. **R3 conflicts with a written spec line** and must be changed together: `.trellis/spec/frontend/auth-feedback.md` §3 currently states "filling a code never submits automatically", and its §6 requires the browser test to assert `filling a code must not automatically sign in` (`tests/password-mfa-browser.cjs` asserts exactly that today). The MFA child PRD already records R3 as superseding it; the spec text and that assertion must be updated in the same change, and the new test needs an explicit "no duplicate request on paired `input`+`change`" case (the harness here sets values through real UI so it is a safe place to grow that coverage).
5. `public/css/vaultsso-utilities.css` is a Tailwind build artifact — if the flat-surface change adds or changes utility classes in templates, `npm run build:css` must be re-run or the admin pages will silently keep the old generated rules.
6. Keep the archived-audit lesson in mind: the older audit reported "ok" while every page had silently landed on the login form. Any "after" audit must assert page-specific markers (e.g. `#adminPageTitle` text, `table.napi-table` rows, `#mfaTitle`) before trusting a screenshot.
