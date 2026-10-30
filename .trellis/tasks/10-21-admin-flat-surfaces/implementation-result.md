# Implementation result — flatten admin panel surfaces

Child: `10-21-admin-flat-surfaces` (parent `10-21-admin-mfa-polish`, requirement R1)
Worker: `trellis-implement`, Pi pane `w1Q:p3`
Date: 2026-10-21 · Branch: `fix/admin-mfa-polish`
Status: **code complete**. Main session owns spec updates and the integrated `npm run check:browser`; browser reviewer owns visual sign-off.

## Change boundary

Presentation only, admin-scoped. No backend, route, permission, data, navigation, iframe-routing,
localization, or public-page changes. `public/css/vaultsso-base.css` and `views/docs/api.html` were
deliberately **not** touched, so the public `.vaultsso-page-surface` consumer keeps its gradient.

Edited exactly these 10 files (all within worker ownership):

| File | Change |
| --- | --- |
| `public/css/vaultsso-admin.css` | Flat surface for both admin documents; explicit iframe neutral paint; 16px mobile page inset |
| `public/css/vaultsso-admin-pages.css` | Admin panels to 12px radius and shadowless; table metadata constrained |
| `views/admin/index.html` | `vaultsso-admin.css` cache key |
| `views/admin/users.html` | both admin CSS cache keys; page inset class |
| `views/admin/user.html` | both admin CSS cache keys; page inset class |
| `views/admin/clients.html` | both admin CSS cache keys; page inset class |
| `views/admin/tokens.html` | both admin CSS cache keys; page inset class |
| `views/admin/security.html` | both admin CSS cache keys; page inset class |
| `views/admin/smtp.html` | both admin CSS cache keys; page inset class |
| `views/admin/user-applications.html` | both admin CSS cache keys; page inset class |

Untouched by design: `public/css/vaultsso-base.css`, `views/docs/api.html`, all admin JS, all routes,
all form fields and action hooks (`.napi-panel-title`, `.admin-*` selectors consumed by page scripts
were preserved). The MFA child's in-flight files (`vaultsso-mfa.css`, `mfa.js`, `mfa.html`) were not touched.

## What was implemented

### 1. Flat canvas on both admin documents (`vaultsso-admin.css`)

```css
html[data-admin-shell] body.vaultsso-page-surface,
html[data-admin-page] body.vaultsso-page-surface {
  background: var(--surface-page, #f8f9fb);
  background-image: none;
}
```

- Specificity `(0,2,2)` beats the shared `.vaultsso-page-surface` rule `(0,1,0)` at
  `vaultsso-base.css:92`, so no `!important` and no dependence on `<link>` order.
- `data-admin-shell` covers the shell document; `data-admin-page` covers all seven embedded
  content pages. Both attributes are literal in the markup, so there is no first-paint flash.
- Declared in `vaultsso-admin.css` because that stylesheet is loaded by admin documents only —
  the public docs page never loads it. Scoping is structural, not review-dependent.
- **Re-declares rather than removes** the shared class on purpose: an unspecified body would be
  transparent, and the shell's gradient would leak through the transparent iframe. The
  research note (`admin-surfaces.md` §3) established that both documents independently paint
  the gradient, which is why "delete the class" was rejected.

The full `background` shorthand plus an explicit `background-image: none` was used because
setting only `background-color` would leave the gradient images visible (design constraint).

### 2. Explicit iframe neutral paint (`vaultsso-admin.css`)

`.admin-shell-iframe` now carries `background: var(--surface-page, #f8f9fb)`. The element
previously had no background, so the frame was transparent until the embedded document painted.

### 3. Panel treatment aligned to the local reference (`vaultsso-admin-pages.css`)

- Added a single admin-scoped rule bringing the shared `.napi-panel` / `.napi-card` to
  `--radius-md` (12px) with `box-shadow: none`:

  ```css
  html[data-admin-page] .napi-panel,
  html[data-admin-page] .napi-card {
    border-radius: var(--radius-md);
    box-shadow: none;
  }
  ```

  Scoped by the document hook rather than `.admin-main` descendant because
  `clients.html:135` holds a `<template id="clientCardTemplate">` **outside** `.admin-main`
  whose cards are cloned into `#clientGrid`. The base declarations live in the shared
  `vaultsso-base.css` (out of edit set), so this scoped收口 is the correct place.

- Edited existing admin declarations in place instead of layering more overrides:
  - `.admin-table-panel`: `--radius-lg` (16px) → `--radius-md` (12px); removed `--shadow-panel`.
  - `.admin-toolbar-card`: removed `--shadow-flat` (radius already 12px).
  - `.admin-stat`: removed `--shadow-flat` (radius already 12px).
  - `.admin-empty`: `--radius-lg` → `--radius-md`.
- Retained `--shadow-pop` for dialogs (`.napi-dialog`), which legitimately float above content.
- 32px controls / 28px small actions and 8px control radii were already on-reference and are unchanged.

### 4. Restrained table metadata (`vaultsso-admin-pages.css`)

`.admin-cell-sub` gained `max-width: 320px` (mirrors the reference's `td small { max-width: 320px }`)
and `line-height: 1.45`. This constrains runaway generated IDs without clipping: no `nowrap`,
no ellipsis, no line clamp, no fixed row height. Full values remain in the DOM and selectable.

### 4b. Date/time cells stay on one line (`vaultsso-admin-pages.css`)

Post-review fix. The 12px panel/table polish exposed a readability defect: in the last column
the created timestamp `2026/10/21 20:47:24` was breaking mid-number, leaving an isolated final
digit (`3/7`) on its own line, because `.admin-cell-sub` carries `overflow-wrap: anywhere` and
the column is narrow.

```css
td.admin-cell-sub {
  max-width: none;
  overflow-wrap: normal;
  white-space: nowrap;
}
```

Why `td.admin-cell-sub` is the correct existing hook: `users.js:52` renders the created-time
cell as `<td class="admin-cell-sub">`, and `tokens.js:139,140` use the identical `<td>` for
token created/expiry time. The same class is also used on `<span>` (username) and `<code>` (UUID)
inside `.admin-cell-stack`, which must keep wrapping — the `td` type selector isolates the date
cells without a new class or markup change.

No ellipsis, no truncation, no clamp: the full timestamp stays in the DOM and rendered.
`max-width: none` removes the 320px metadata cap so `nowrap` content can never overflow its own
cell; the extra column width is absorbed by the existing `.napi-table-scroll` container, which
scrolls rather than clipping the document.

### 4c. Two-column stat cards on narrow screens (`vaultsso-admin-pages.css`)

Post-review fix. `clients.html:18` renders four single-number `.admin-stat` cards in
`.admin-stat-grid`. The old cascade was 4 columns → 2 columns at ≤960px → **1 column at ≤520px**,
so a phone showed four full-width rows for four numbers.

Removed the `@media (max-width: 520px)` single-column override (dead rule after the change) and
documented the intent on the surviving `@media (max-width: 960px)` two-column rule. Two columns
now hold all the way down to 320px. `.admin-stat-label` is a plain `<p>` with no `nowrap`, so
labels wrap instead of clipping. `.admin-stat-grid-3` (three cards, `user.html:54`) keeps its own
breakpoint and is unaffected. `tokens.html:20` uses the same 4-card `.admin-stat-grid` and gains
the same density improvement.

### 5. Page inset on the 4px scale (`vaultsso-admin.css` + 7 views)

- Removed the contradictory `lg:px-8` (32px at ≥1024px) from the `.admin-main` class in all
  seven content views, letting the existing `px-6` (24px) govern desktop — matching the design's
  "24px page inset on desktop". This removes a declaration rather than adding an override;
  the generated `lg:px-8` utility still exists in the build, so no CSS rebuild is required.
- Added `@media (max-width: 640px) { .admin-main { padding-inline: var(--space-4) !important } }`
  for the 16px mobile inset.

### 6. Cache keys

`?v=20261021-admin-flat-1` applied to `vaultsso-admin.css` in all eight admin views and to
`vaultsso-admin-pages.css` in the seven content views (`index.html` correctly has no
`admin-pages.css` link). `vaultsso-base.css` links were intentionally left unversioned because
that file was not changed.

## Verification performed

| Check | Result |
| --- | --- |
| `npm run check:syntax` | **pass** — "Syntax and browser script references checked: 97 files" |
| `node tests/browser-smoke.cjs` | **pass** — "Browser checks passed: login, CAPTCHA, profile, admin pages and local CSP-compatible scripts" (covers `/admin.html`, `/apps.html`, `/users.html`, `/account-bindings.html`, `/tokens.html`, `/security.html`, `/smtp.html`, `/api-docs.html`, zero `pageerror`) |
| CSS brace balance | balanced — `admin.css` 80/80, `admin-pages.css` 105/105 after the follow-up edits |
| Cascade / no competing rule | confirmed — the new rule is the only `body` background declaration in admin CSS |
| Public surface preserved | confirmed — `/api-docs.html` body still reports its radial-gradient; file not modified |

### Follow-up fixes — measured results

Both follow-up fixes were verified by measurement in the running app (real login-gated pages,
isolated in-memory fixture, temporary harness under gitignored `.artifacts/`, since deleted —
no persistent CSS-mirroring test added). Zero `pageerror` throughout.

**Date/time cell** — `2026/10/21 20:47:24`, identical at 1280 / 390 / 320:

```
whiteSpace     : nowrap
overflowWrap   : normal
textOverflow   : clip      (rendered content 107px < cell 131px, so nothing is actually clipped)
lines          : 1         <- was fragmented before the fix
full text      : 2026/10/21 20:47:24   (preserved, not truncated)
contained      : true      (wide table scrolls inside .napi-table-scroll)
docOverflow    : 0
```

**Clients stat grid:**

| Width | Columns before | Columns now | Grid height now | Label clipped | Doc overflow |
| --- | --- | --- | --- | --- | --- |
| 1280 | 4 | 4 | 73px | no | 0 |
| 390 | 1 | **2** | 158px | no (label 139px in 173px card) | 0 |
| 320 | 1 | **2** | 158px | no (label 104px in 138px card) | 0 |

Labels measured (`客户端总数`, `启用中的客户端`, `回调地址数量`, `唯一 Scope 数量`) all report
`clipped=false` at every width, confirming the two-column narrow layout does not truncate copy in
either language.

### Broader audit performed earlier in this child

Ad-hoc computed-style audit (temporary harness under gitignored `.artifacts/`, since deleted —
not added as a persistent test, per the "no CSS-mirroring tests" instruction). Measured on the
real login-gated shell at 1280 / 390 / 320 in the running app:

```
--- 1280px ---                       (same at 390 and 320)
shell body   : background-image none | rgb(248, 249, 251)
iframe elem  : background-image none | rgb(248, 249, 251)
iframe body  : background-image none | rgb(248, 249, 251)
table panel  : radius 12px | shadow none
toolbar card : radius 12px
overflow     : shell 0 | iframe 0 (settled)
pageerrors   : []
```

Both documents and the iframe now report the identical flat `#f8f9fb`, so the shell/iframe seam
is gone. `/api-docs.html` body was verified to still report its radial-gradient.

## Resolved during implementation (worth recording)

**Apparent mobile iframe overflow was a measurement race, not a regression.** A first pass
measured `scrollWidth - innerWidth` of +39px at 390 and +48px at 320, which would have violated
the no-overflow acceptance criterion. Re-measuring with an explicit settle showed the frame
resize lags the outer viewport change: the "immediate" read caught the frame at its previous
width (`docW 173 / innerW 164`). Settled values were **0 at every width**. The wide users table
is correctly contained by `.napi-table-scroll` (`scrollWidth 1073` vs `clientWidth 356` at 390,
`286` at 320), i.e. container-bounded scrolling is preserved and no columns were hidden.
Any future after-capture must wait for the iframe to settle before asserting overflow.

## Not done here (by design)

- No new tests were added. The design and planning review explicitly reject persistent tests
  that merely mirror CSS declarations; the MFA child owns the new behavior tests.
- The users row remains ~121px tall. Row height is content-driven by the single seeded
  long-UUID account; the design forbids a fixed row cap or clipping to hit a numeric target.
  Metadata is now bounded (`max-width: 320px`, tighter line-height) so realistic data is
  restrained, but a genuinely long value (username/UUID) still wraps. **This is a known,
  accepted limitation** — the date column no longer contributes to it, since timestamps are now
  single-line.
- Panel shadow removal and 12px panel radius are applied; the reference's inset rounded
  `.workspace` frame was explicitly rejected in planning review and was not added.

## Follow-up round (post visual review)

Two concrete defects found in the after-capture `admin-shell-overview-users-zh-desktop-1280.png`
were fixed inside the already-approved table/stat polish, CSS-only, in
`public/css/vaultsso-admin-pages.css`:

1. **Fragmented timestamps** — created-time cells split mid-number onto an isolated final digit.
   Fixed with a `td.admin-cell-sub` nowrap rule (§4b). Full values preserved; wide tables scroll
   inside `.napi-table-scroll` instead of clipping or fragmenting dates.
2. **Four stacked stat cards on phones** — `.admin-stat-grid` collapsed to one column at ≤520px.
   Removed the dead single-column override so two columns hold down to 320px (§4c). Labels wrap,
   never clip.

No JS, backend, shared CSS (`vaultsso-base.css`), public page, or new markup/structure was touched;
no new class names were introduced — both fixes use selectors that already existed.
Re-verified: `npm run check:syntax` pass, `node tests/browser-smoke.cjs` pass, brace balance
105/105, zero `pageerror`, document overflow 0 at 1280/390/320.

Final screenshot capture and visual sign-off for both fixes remain with reviewer `p6`; no further
audit loops were run from this worker.

## Unresolved issues

None blocking. Two items for the reviewer's awareness:

1. Visual sign-off (screenshots at 1280/1440 and 390/320, zh + en, shell expanded/collapsed,
   mobile drawer, embedded and directly opened pages) is the browser reviewer's task; the
   computed-value audit above is not a substitute for inspecting rendered output. The follow-up
   fixes in §4b/§4c are covered by measurement only and still need the reviewer's capture.
2. `--shadow-flat` / `--shadow-panel` are now unused by the panel classes I edited but remain
   defined in `vaultsso-base.css` and may still be referenced by out-of-scope surfaces. They
   were left in place deliberately; removing tokens is outside this child's edit set.
