# Research — Admin flat surfaces (parent R1 / child `10-21-admin-flat-surfaces`)

Status: research only. No product edits, no task-lifecycle changes, no git operations.
Scope: where the admin decorative gradient actually comes from, every consumer, the read-only
New API-style reference primitives, and the smallest complete admin-scoped fix.

Evidence labels used below: **[S]** = source/measurement backed, **[J]** = judgement call
(subjective, needs design sign-off).

---

## 1. The gradient is a single shared class, not per-page styling

**[S]** The decorative background is exactly one rule:

- `public/css/vaultsso-base.css:92` — `.vaultsso-page-surface { ... }`
- `public/css/vaultsso-base.css:94-96` — the three layers that produce the effect:
  - `radial-gradient(circle at top left, rgba(11, 87, 208, 0.14), transparent 24%)`
  - `radial-gradient(circle at bottom right, rgba(0, 61, 155, 0.08), transparent 28%)`
  - `linear-gradient(135deg, #eef5ff 0%, #f8fbff 48%, #dee9ff 100%)`

**[S]** `public/css/vaultsso-admin-pages.css` contains **zero** `gradient` occurrences, and
`public/css/vaultsso-admin.css` contains only two, both chrome accents (not content):
`admin.css:73` `.admin-brand-logo` and `admin.css:164` `.admin-account-avatar`, each
`linear-gradient(135deg, #003d9b, #0b57d0)`.

So the admin content gradient is **not** admin CSS at all. It is inherited from the shared
public page-surface class. This is the single most important finding: a "flatten admin"
change is a background-declaration change, not a redesign of admin component CSS.

## 2. Complete consumer inventory of `.vaultsso-page-surface`

**[S]** Nine `<body>` elements reference it. Exactly two groups:

| Group | Files | Line | Notes |
| --- | --- | --- | --- |
| Admin shell | `views/admin/index.html` | `:14` | `<html ... data-admin-shell>`; iframe host |
| Admin embedded pages | `views/admin/users.html` | `:15` | `data-admin-page="users"` |
| | `views/admin/user.html` | `:15` | `data-admin-page="users"` |
| | `views/admin/clients.html` | `:14` | `data-admin-page="apps"` |
| | `views/admin/tokens.html` | `:14` | `data-admin-page="tokens"` |
| | `views/admin/security.html` | `:15` | `data-admin-page="security"` |
| | `views/admin/smtp.html` | `:15` | `data-admin-page="smtp"` |
| | `views/admin/user-applications.html` | `:16` | `data-admin-page="account-bindings"` |
| **Public (out of scope)** | `views/docs/api.html` | `:12` | `<html class="light" lang="en">`, **no** admin attribute |

All eight admin bodies are byte-identical: `class="vaultsso-page-surface min-h-screen text-ink"`.

**[S]** No other consumer exists. No admin view uses `bg-mesh`, `bg-white`, `bg-[#...]`,
`bg-surface-*`, `vault-gradient` or `primary-gradient` on any content wrapper. `.bg-mesh`
(`base.css:85`) is used only by the public auth pages (`views/auth/login.html:12`,
`views/auth/error.html:12`) and is therefore a separate, untouched surface.

## 3. Shell background vs iframe background — two independent gradient painters

This was measured, not assumed. Baseline: `.artifacts/admin-mfa-polish/baseline/measurements.json`
(gitignored artifacts, produced by `capture-baseline.cjs` in the same folder).

**[S]** For `zh/desktop/overview-users`, both the shell document and the embedded document
report the *same* computed value:

```
shell-background   .body.image = radial-gradient(...), radial-gradient(...), linear-gradient(135deg, rgb(238,245,255) ...)
shell-background   .bodyClass  = "vaultsso-page-surface min-h-screen text-ink"
embedded-background .body.image = <identical>
embedded-background .bodyClass  = "vaultsso-page-surface min-h-screen text-ink"
html.image = none   (both documents)
```

**[S]** Geometry at 1280×900 (`shell-metrics`): `header 1280×56 @ (0,0)`,
`sidebar 256×844 @ (0,56)`, `iframe 1024×844 @ (256,56)`.
At 390: `sidebar 256×788 @ (-256,56)`, `iframe 390×788 @ (0,56)`.
At 320: `iframe 320×684 @ (0,56)`.

Consequences that matter for the fix:

1. **[S]** The iframe exactly fills the area right of the sidebar and below the top bar, so the
   shell body's own gradient is currently *occluded* — the visible gradient is the **iframe
   document's** body. Flattening only the shell would change nothing visible.
2. **[S]** `admin.css:467` `.admin-shell-iframe` declares **no** background. The iframe is
   transparent, so if the embedded document's body ever paints nothing, the **shell body's**
   gradient shows through. Any fix must set an explicit flat colour on *both* sides rather than
   deleting the class.
3. **[S]** `admin.css:449` `.admin-shell-body` and `admin.css:462` `.admin-shell-iframe-wrap`
   also declare no background.

Therefore the naive fix "remove `vaultsso-page-surface` from the 8 view bodies" is **incorrect**:
it leaves the embedded body transparent and the shell gradient becomes the visible background
through the iframe. This is the concrete "iframe background mismatch" hazard named in the child
PRD, and it is why the class must be *re-declared flat*, not removed.

## 4. Read-only reference primitives (`D:/My2KProjects/codebuddy2api-ui_template`)

The reference contains **no** CSS gradient anywhere. **[S]** A search for `gradient` across
`src/*.scss`, `src/*.tsx`, `src/*.ts` and `index.html` returns only two hits, both SVG
`<linearGradient>` inside a chart (`src/Trend.tsx:84,87`). `dashboard.module.scss` and
`management.module.scss` have zero.

Primitive anchors worth aligning to:

| Primitive | Reference anchor | Value |
| --- | --- | --- |
| Flat page colour | `src/theme.scss:13` | `--page: #f7f9fb` (flat, no image) |
| Body paint | `src/ui.module.scss:10-12` | `background: var(--page)` |
| App frame | `src/ui.module.scss:190-196` | `.app { background: var(--page) }` — flat, no overlay |
| Panel | `src/ui.module.scss:607-613` | `background: var(--surface)`, `border: 1px solid var(--line)`, `border-radius: var(--panel-radius)`, `overflow: hidden`, **no box-shadow** |
| Panel head | `src/ui.module.scss:614-621` | `min-height: 58px`, `padding: 16px 20px` |
| Panel body | `src/ui.module.scss:626-631` | `padding: 0 20px 20px`, `gap: 14px` |
| Page title block | `src/ui.module.scss:440-446` | `margin-bottom: 24px`, `gap: 16px` |
| Content padding | `src/ui.module.scss:383-388` | `padding: 20px 24px 28px`, `max-width: 1600px` |
| Table header cell | `src/ui.module.scss:147-154` | `height: 40px`, `padding: 8px 16px`, `background: var(--soft)`, `border-block: 1px solid var(--line)`, 12px/500 |
| Table body cell | `src/ui.module.scss:155-160` | `height: 60px`, `padding: 10px 16px`, `border-bottom: 1px solid var(--line)` |
| Row hover | `src/ui.module.scss:164-166` | `background: var(--soft)` |
| Control | `src/ui.module.scss:19-34`, `:60-72` | `min-height: 32px`, `padding: 5px 10px`, `border-radius: var(--radius)` = 8px, `border: 1px solid var(--line-strong)` |
| Radius scale | `src/theme.scss:41-50` | `--radius: 8px`, sm 4.8, md 6.4, lg 8, xl 11.2 |
| Brand mark | `src/ui.module.scss:234-245` | flat `color: var(--accent)` icon — **no** gradient |

**[S]** VaultSSO already matches this rhythm closely, so R1 needs no density rework:

- `base.css:17` `--surface-page: #f8f9fb` vs reference `#f7f9fb` — visually indistinguishable.
- `base.css:61-62` `--control-height: 32px` / `--control-height-sm: 28px` — identical to reference.
- `base.css:10-12` `--radius-sm: 8px`, `--radius-lg: 16px`; `base.css:259` `.napi-input` 32px/8px.
- Measured live: form inputs `32px h / 8px radius / 13px`, buttons `28px or 32px / 8px radius`,
  panels `16px radius`, panel title `15px/700`. All already on-reference.

**[J]** Two real divergences from the reference remain, both cosmetic and both *optional*:
panel elevation (`--shadow-panel` / `--shadow-flat` are used, reference `.panel` has none), and
the chrome gradients on `.admin-brand-logo` / `.admin-account-avatar` where the reference uses a
flat accent mark. Neither is required by R1's wording ("remove the decorative gradient from
admin main content").

## 5. Smallest complete admin-scoped fix

**[S]** Load order in all eight admin views is `vaultsso-utilities.css` → `vaultsso-base.css` →
`vaultsso-admin.css` → (`vaultsso-admin-pages.css`). `views/docs/api.html:8-10` loads
`vaultsso-utilities.css` → `vaultsso-base.css` → `vaultsso-docs.css` and **never**
`vaultsso-admin.css`.

That gives a clean, zero-risk scoping mechanism: **`vaultsso-admin.css` is admin-only by
construction.** A rule there cannot reach the public docs page.

Recommended change (Option A), appended to `public/css/vaultsso-admin.css`:

```css
/* ---------- Flat admin surfaces ----------
 * The decorative page-surface mesh belongs to the public pages. Admin keeps the
 * neutral page token so the shell body and the embedded iframe paint the same
 * flat colour and no gradient can leak through a transparent iframe.
 */
html[data-admin-shell] body.vaultsso-page-surface,
html[data-admin-page] body.vaultsso-page-surface {
  background: var(--surface-page);
  background-image: none;
}
```

Why this shape:

- **[S]** Specificity `0,1,1` (attr + class) beats `base.css:92` `0,1,0`, so it wins regardless of
  later load order — no `!important`, no dependence on the current `<link>` sequence.
- **[S]** `data-admin-shell` covers `views/admin/index.html:2`; `data-admin-page` covers all seven
  embedded views and is present at parse time (it is a literal attribute, not JS-added), so there
  is no first-paint flash.
- **[S]** `background-image: none` is stated explicitly even though the `background` shorthand
  already resets it, so a future partial edit cannot silently reintroduce the mesh.
- **[S]** It deliberately does **not** touch `base.css`, so `views/docs/api.html:12` keeps its
  gradient and the child PRD constraint "preserve unrelated public surfaces" holds by
  construction rather than by review.
- **[S]** It re-declares rather than removes, so the transparent-iframe leak in §3 cannot occur.

Belt-and-braces (recommended, still tiny) at `admin.css:467`:

```css
.admin-shell-iframe {
  background: var(--surface-page);
}
```

This makes the shell side flat too, so the ~1 frame before the iframe document paints no longer
flashes a gradient, and the shell/iframe seam stays neutral even if a future route omits the class.

Do **not** do these:

- **[S]** Do not delete `vaultsso-page-surface` from the eight view bodies (leaves transparent
  bodies; shell gradient leaks through — §3).
- **[S]** Do not edit `base.css:92` in place (would flatten `views/docs/api.html`, a public
  surface explicitly out of scope).
- **[S]** Do not remove the chrome gradients at `admin.css:73` / `admin.css:164` as part of R1 —
  they are top-bar chrome, not "main content", and the PRD excludes branding changes.

**[J]** Option B — mirror the reference's *inset workspace* (`.workspace` white rounded panel at
`src/ui.module.scss:371-382`, `margin: 8px 8px 0 calc(sidebar+8px)`, `border`, `--workspace-radius`).
This is a genuine structural improvement and the most literal reading of "align with the New API
reference", but it changes `.admin-shell-body` / `.admin-shell-iframe-wrap` / `.admin-main`
geometry and therefore the iframe viewport width, scroll containment and the mobile drawer
overlay. Higher risk, larger blast radius, and not required by R1's wording. Recommend deferring
unless design explicitly wants the inset frame.

## 6. Mandatory cache-busting (easy to miss, breaks the whole change)

**[S]** Every admin stylesheet link currently has **no** `?v=` query string:

```
views/admin/index.html:9-10        /css/vaultsso-base.css, /css/vaultsso-admin.css
views/admin/users.html:9-11        /css/vaultsso-base.css, /css/vaultsso-admin.css, /css/vaultsso-admin-pages.css
views/admin/user.html:9-11         same
views/admin/clients.html:9-11      same
views/admin/tokens.html:9-11       same
views/admin/security.html:9-11     same
views/admin/smtp.html:9-11         same
views/admin/user-applications.html:9-11  same
```

**[S]** The JS files *are* versioned (`?v=20260928-js-1`, shell `?v=20261018-shell-1`), so the
precedent for query-string busting already exists in these exact files.

Because the admin UI is an iframe inside a cached shell, a CSS-only change to
`vaultsso-admin.css` can be served from the browser cache and the fix will appear not to work.
Implementation must append one consistent key to the changed stylesheet(s) on all eight views,
e.g. `?v=20261021-admin-flat-1`. If Option B is chosen, `vaultsso-base.css` links need the key too.

## 7. Test implications

**[S]** Existing coverage does not assert appearance, so it can only prove no regression:

- `tests/browser-smoke.cjs` (in `npm run check:browser`) visits `/admin.html`, `/apps.html`,
  `/users.html`, `/account-bindings.html`, `/tokens.html`, `/security.html`, `/smtp.html`,
  `/api-docs.html`, asserts `200` + `networkidle`, and asserts `pageerror` is empty. It never
  reads a computed background.
- Baseline `admin-pageerrors` is `[]` for every language/width combination, so the current page
  is already error-free; the change must keep it that way.
- `npm run check:syntax` and `npm run check:e2e` (`scripts/check-e2e.js` runs all `tests/*.test.js`)
  are unaffected — no backend or route changes.

Recommended new assertions (durable, in `tests/`, not in gitignored `.artifacts/`):

1. **Flattened, both documents.** At 320 / 390 / 1280, in `zh` and `en`:
   `getComputedStyle(body).backgroundImage === 'none'` for the shell document *and* for the
   iframe document, and `backgroundColor` equals the flat token (`rgb(248, 249, 251)` for
   `#f8f9fb`). Reading the iframe body requires same-origin frame access, which
   `admin-shell.js` already relies on, so this is straightforward.
2. **Public surface untouched (guard).** On `/api-docs.html`,
   `backgroundImage !== 'none'` still. This is the regression test for the §5 scoping decision
   and will fail loudly if someone later edits `base.css:92` instead.
3. **No seam / no overflow.** `documentElement.scrollWidth <= innerWidth + 1` in the shell *and*
   in the iframe at 320 / 390 / 1280. Baseline already reports `overflow: 0` everywhere, so this
   is a pure guard.
4. **No empty panel left behind.** Assert the content area still contains the toolbar/table/form
   nodes — i.e. the change removed paint, not layout.

Screenshot capture: `capture-baseline.cjs` in the baseline folder is the existing generator but is
gitignored. Reuse its route/width/language matrix for after-shots; promote a copy into `tests/`
only if the parent wants a durable visual harness.

## 8. Representative routes and screenshots

**[S]** Baseline set already exists at `.artifacts/admin-mfa-polish/baseline/`, named
`admin-<surface>-<lang>-<viewport>.png`, covering `zh`/`en` × desktop 1280 / mobile 390 / narrow 320.

Representative surfaces to re-capture and compare:

| Purpose | Route | Baseline files |
| --- | --- | --- |
| Shell + overview (primary) | `/admin.html#/users` | `admin-overview-users-{zh,en}-{desktop-1280,mobile-390,narrow-320}.png` |
| Table page | `/users.html` | `admin-users-table-*` |
| Form + table split | `/apps.html` | `admin-clients-form-table-*` |
| Form-heavy settings | `/security.html`, `/smtp.html` | not in baseline set — capture ad hoc |

The named baseline `admin-overview-users-zh-desktop-1280.png` is the clearest single before/after
pair: the content region behind the toolbar and below the table currently shows a blue tint that
is strongest in the lower-right corner and lightest at the upper-left, which is exactly the
`135deg` linear layer plus the two radial corners from `base.css:94-96`.

**[J]** Older shots `.artifacts/r2-users.png`, `r2-admin-shell.png`, `r2-security.png`,
`page-users-mobile.png` show the same gradient but predate the current toolbar markup
(`page-users-mobile.png` in particular shows a superseded card layout). Use the
`admin-mfa-polish/baseline` set, not these, for before/after evidence.

## 9. Source-backed vs subjective summary

**[S] Source-backed conclusions**

- The gradient is one shared class, `base.css:92-96`; admin CSS contributes none of it.
- There are nine consumers: eight admin bodies + `views/docs/api.html:12` (public).
- Shell body and iframe body each independently paint the gradient; the iframe currently covers
  the shell, and `.admin-shell-iframe` has no background, so removing the class is unsafe.
- `vaultsso-admin.css` is loaded only by admin views, which makes it a correct scoping boundary.
- Control rhythm, radii and table metrics already match the reference; only the background differs.
- Admin stylesheet links carry no `?v=` key, so cache busting is required for the change to appear.
- Existing browser tests assert status codes and absence of JS errors, never computed backgrounds.

**[J] Subjective / needs sign-off**

- Whether to also drop `--shadow-panel` / `--shadow-flat` from admin panels for exact reference
  parity (reference panels are shadowless).
- Whether to flatten `.admin-brand-logo` (`admin.css:73`) and `.admin-account-avatar`
  (`admin.css:164`) chrome gradients; reference uses a flat accent mark.
- Whether to adopt the reference's inset rounded `.workspace` frame (Option B) instead of only
  flattening the page colour. Recommended: defer; not required by R1.

## 10. Bounded fix checklist for the implementer

1. Append the flat-surface rule to `public/css/vaultsso-admin.css` (§5).
2. Add `background: var(--surface-page)` to `.admin-shell-iframe` (`admin.css:467`).
3. Add `?v=20261021-admin-flat-1` to the `vaultsso-admin.css` link in all eight admin views
   (`index.html:10`, `users.html:10`, `user.html:10`, `clients.html:10`, `tokens.html:10`,
   `security.html:10`, `smtp.html:10`, `user-applications.html:10`).
4. Do not touch `vaultsso-base.css`, `views/docs/api.html`, or the MFA child's files.
5. Verify with the four assertions in §7 plus re-captured screenshots in §8.
