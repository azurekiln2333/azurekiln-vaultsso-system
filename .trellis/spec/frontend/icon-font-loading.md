# Icon Font Loading

## 1. Scope / Trigger

Material Symbols uses English ligature names such as `person` and `verified_user`. Prevent those names from rendering as fallback text while the separately supplied icon font loads or fails. Applies to auth, profile, admin shell/iframe and documentation pages, including runtime-generated icons.

## 2. Signatures

- `public/css/vaultsso-base.css` owns the `.material-symbols-outlined` hidden slot and `html.vaultsso-icons-ready` reveal state.
- External deferred `public/js/shared/icon-font.js` calls `document.fonts.load('24px "Material Symbols Outlined"', 'person')` once for the document.
- Every consuming template links the shared base CSS and helper with matching changed-asset versions. Current coverage is all 13 HTML templates under `views/`.

## 3. Contracts

Hide only icon glyphs by default, preserve a compact `1em` square with no flex shrinking, and clip fallback ligature width. Ordinary page labels, actions, text fonts, per-page icon sizes/colors and font variations retain their existing behavior. Keep the hidden-slot styling self-contained so a missing external font stylesheet cannot expose English or widen a button. Do not hide the page while waiting for icons.

Set the document ready class only after the explicitly requested face load returns a nonempty list whose faces are all loaded. An empty list, rejected request or unavailable FontFaceSet API leaves icons hidden without an uncaught exception. Neither `document.fonts.ready`, global `status` nor `check()` alone proves that the target face exists and succeeded. Do not reveal after a timeout or add background retries. Newly inserted icons inherit the document state through CSS; no per-icon observer is needed.

The deployment ZIP intentionally excludes `public/assets`; fonts and their generated stylesheet are supplied separately. Critical hiding CSS and the helper must live in packaged `/css` and `/js`, work with the existing font stylesheet and obey the production CSP. Changing only generated `font-display` cannot satisfy the failure contract. Preserve accessible names on icon-only controls; add a label when hiding the sole ligature would remove the control's name.

Apply the glyph class to the glyph itself, not a structural container. The profile avatar keeps its full-size `.profile-avatar-edit` inset/grid overlay as an outer span, with a separate inner `.material-symbols-outlined` span for `photo_camera`. The overlay's hover/focus background and clickable avatar must retain their original bounds. A global `1em` rule on the outer overlay incorrectly shrinks it to 24px; do not solve this by accumulating page-specific exceptions in shared icon CSS.

## 4. Validation & Error Matrix

| State | Expected result |
| --- | --- |
| Real icon font HTTP response still pending | Blank compact slot; no English, icon-induced page/form overflow or hidden ordinary labels |
| Actual font succeeds, including a cached load | Glyphs visible; original icon sizes/colors and dynamic icons work |
| Font request rejected, even after `document.fonts.ready` | Slot stays hidden; no unhandled error or English fallback |
| Font stylesheet/face absent and load resolves empty | Stay hidden; global readiness cannot override the gate |
| Font Loading API unsupported | Stay hidden safely; page text and actions remain available |
| Admin shell and iframe | Each document runs its own gate and reveals only after its own font load |

## 5. Good / Base / Bad Cases

- Good: hold the actual WOFF2 response beyond a short browser block period, inspect blank slots and visible labels, then release and see actual icons without changing slot geometry.
- Base: a fresh or cached normal load enables static and later inserted symbols.
- Bad: `fonts.ready.then(showIcons)` reveals `verified_user` after the actual font request failed.

## 6. Tests Required

- `tests/icon-font-loading-browser.cjs`: desktop/mobile real delayed, failed and cached/immediate font HTTP loading; compact geometry and ordinary control usability; actual successful face/glyph rendering; dynamic icons; docs without another common script; admin shell/iframe; missing stylesheet/face. Clearly attribute controlled unavailable-API probes as simulations.
- Check the real profile avatar overlay and inner camera at desktop/mobile and CSS zoom 2: full avatar coverage, centered glyph, loading-time hidden camera, hover/focus and click-to-open profile editing. This guards structural containers that previously also carried the glyph class.
- Capture and inspect representative delayed/loaded/failed screenshots. Geometry/visibility assertions support visual review; a static CSS string assertion is insufficient.
- Root syntax and integrated browser checks preserve login/CAPTCHA/MFA, profile and admin/import flows. Packaging tests must preserve the separate font-assets boundary while including the new core helper. Do not rerun unchanged backend authentication suites solely for this presentation change.

## 7. Wrong vs Correct

Wrong: set `font-display: block` and assume fallback stays invisible forever, or patch generated font CSS that is excluded from deployment.

Correct: hide compact slots through packaged base CSS and reveal through the shared helper only on an actual successful target-face load; failures remain hidden and ordinary content stays usable.
