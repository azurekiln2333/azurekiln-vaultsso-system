# Icon font loading implementation

## Result and boundary

The former Material Symbols fallback English is suppressed by a shared packaged gate. `public/css/vaultsso-base.css` reserves a one-em icon slot and defaults its glyph visibility to hidden, without hiding the surrounding control or label. The external `public/js/shared/icon-font.js` requests the actual `Material Symbols Outlined` face and reveals icons only after a nonempty list of loaded faces resolves. Rejected loading, an absent face/stylesheet, an empty list or an unsupported Font Loading API leaves the slot blank. No timeout reveal, observer, polling or global font-readiness shortcut was added.

The new helper and versioned base CSS are included once by all 13 current templates, using `20261025-icon-font-1`. Existing page scripts and their versions are retained. The icon-only help link in `views/auth/error.html` now has `aria-label="Help"` and `title="Help"`, preserving a useful name when its decorative glyph is hidden. Existing icon font variation, local size/color rules and dynamic icon content remain intact.

Files changed within this owner's boundary:

- `public/css/vaultsso-base.css` and new `public/js/shared/icon-font.js`.
- All 13 `views/**/*.html` templates: required base CSS cache reference/helper inclusion, the error-page help link name and the independently reviewed profile-avatar overlay/glyph separation described below.
- New `tests/icon-font-loading-browser.cjs` and this report.

The separately supplied `public/assets` files and `scripts/build-fonts.js` are unchanged. The gate deliberately lives in packaged CSS/JS because deployment archives exclude those external font assets. Server, models, existing page JS/CSS and other tests were not modified by this owner. Root owns the browser-script registration, specs, task artifacts and final aggregates.

## Focused browser evidence

`node tests/icon-font-loading-browser.cjs` passed at desktop 1440×1000 and mobile 390×844. It uses the existing isolated memory-database/mail fixture and actual browser HTTP/font loading; no live accounts, SMTP or provider service is contacted.

- A real WOFF2 request is held for **4100ms** at each viewport, beyond the ordinary short font block window. Existing login icons and a newly inserted long-name icon remain hidden in compact slots; labels stay visible and account Continue advances to the password step before font success. Releasing the real font reveals proper glyphs. The dynamic action width remains unchanged before/after, and a subsequent inserted icon is immediately rendered through the shared document state.
- Rejecting the real WOFF2 request keeps icons hidden even after `document.fonts.ready` resolves. Account Continue and the dynamic action remain usable; no page errors occur.
- The documentation page, which had no previous shared JS, loads glyphs on immediate success and a second warm navigation. Resource timing verifies actual cached bytes: `transferSize: 0`, `decodedBodySize: 3980092` at both widths.
- An authenticated real admin shell and its users iframe independently retain hidden icon slots while font loading is held, then reveal icons after release. The users import action remains visible and opens its real modal. Dynamically rendered navigation/row/modal icons inherit the same state.
- The profile-avatar regression covers actual hover, keyboard `:focus-visible` and click-to-open-modal while the real font is held and after release, at both viewports and CSS zoom 1/2. The decorative overlay remains the full avatar, and only its centered inner glyph follows font readiness.
- Explicitly separate simulations cover `document.fonts.load` resolving `[]`, no Font Loading API and a missing font stylesheet. They stay hidden without uncaught exceptions; documentation headings and the ordinary dynamic button remain visible and usable. The missing-stylesheet slot remains compact using packaged base CSS alone.

Evidence is under `.artifacts/icon-font-loading/`: `browser-focused.log`, `browser-evidence.json` and 20 screenshots (12 delayed/loaded/failed/docs/admin plus eight profile-avatar states). Both newly added JavaScript files pass `node --check`; scoped `git diff --check` passes with only existing LF→CRLF notices.

## Existing narrow documentation width

The first focused run's universal zero-overflow assertion exposed an existing mobile documentation layout width. A separate real-browser probe served the saved pre-follow-up base CSS and compared the current CSS at 390px: **both have scrollWidth 453 / overflow 63px**, and both use a 16px documentation icon. The new gate does not add width. Evidence: `.artifacts/icon-font-loading/docs-baseline-probe.json`.

The final test keeps strict no-overflow assertions for login/admin and checks compact icon geometry plus unchanged content width on documentation, including long dynamically inserted names. No documentation layout change was made beyond the authorized shared references.

## Visual inspection and completion

Initial focused scenarios did not cover the profile avatar's combined overlay/glyph class. Independent review caught the resulting one-em constraint on its full-size hover overlay. The root authorized a narrow correction: retain the outer `.profile-avatar-edit` layout/hover/`aria-hidden` semantics and put `photo_camera` in a nested `.material-symbols-outlined` glyph. No profile CSS or generic shared exception was added.

The final real-browser regression confirms overlay and avatar rectangles match at **88×88 / 176×176** on desktop (zoom 1/2) and **62×62 / 124×124** on mobile. Inner glyphs are centered at 24×24 / 48×48. Hidden and loaded phases each perform actual hover, keyboard focus-visible and clicking to open the existing profile modal. The pre-existing narrow modal can place its close button outside the CSS-zoom-2 viewport; after proving the real zoomed avatar click opens it, test cleanup restores zoom 1 to close normally, then restores the scenario zoom. No zoomed modal-layout fix or coverage is claimed.

Owner inspected mobile delayed/loaded login, desktop loaded admin, and profile-avatar hidden/loaded screenshots including zoom 2. Delayed glyphs are blank without English text, loaded icons render clearly, avatar overlays fill their original bounds, and the users import modal/navigation keep their layout. Root separately inspected representative screenshots. The final focused run passed after the avatar correction; no owner finding remains open.

All owner product/test files are frozen after the final focused checks. Root owns independent review and final syntax/browser/packaging gates. No staging, commit, push, deployment, archive, reset, stash or live-data operation was performed.
