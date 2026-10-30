# Icon font loading follow-up

## User request and cause

On 2026-10-25 the user requested that icons not show English words while the page is still loading. All 13 templates use local Material Symbols ligature text and the generated font stylesheet has `font-display: swap`, exposing fallback English before the icon font is available. The deployment packager intentionally excludes `public/assets`; the font stylesheet/assets are supplied separately. Therefore the fix must work through packaged CSS/JS and cannot depend solely on regenerating an excluded stylesheet.

## Smallest behavior boundary

- Apply one shared loading gate to `.material-symbols-outlined` in `public/css/vaultsso-base.css`, which every current template includes. Before confirmed font success, hide only icon glyphs while preserving a compact, stable icon slot; do not hide labels, actions, page content or the entire page. Long fallback names must not widen flex buttons or forms. Retain existing font variation, size/color rules and dynamic icons.
- Add one external CSP-compatible helper under `public/js/shared/`, loaded once by every current template. Reveal icons only after loading the actual Material Symbols face succeeds; `document.fonts.ready`, global font-set readiness or an empty face list alone cannot establish success. Delayed, rejected, absent or unsupported font loading stays hidden without uncaught exceptions. Newly inserted icons inherit the same document state; do not add a per-icon observer, a hard-coded timeout reveal or persistent background retry.
- Keep normal text font behavior, login/CAPTCHA/MFA, user import/sorting, existing app scripts and page layouts unchanged. Do not migrate icon markup to another library, rewrite templates or alter authentication APIs. No server/model/data change is needed.
- Product owner may edit only shared base CSS, the new shared helper and the 13 templates' required helper/base-CSS cache references, plus the directly required error-page help label and profile avatar structural/glyph separation below. Inspect icon-only control naming in that boundary and report any direct regression; do not silently broaden the feature into a general accessibility redesign. Keep raw icon names from being newly exposed to assistive technology.
- Leave `scripts/build-fonts.js` and generated `public/assets` unchanged unless implementation evidence requires a coordinated scope change. No font-face definition change is required for the packaged gate to work with existing separately supplied fonts.

## Evidence and ownership

Native Trellis implementer owns those product files, meaningful focused browser coverage and its implementation report. Root owns this contract, task/spec synchronization and final integrated gates. Independent Trellis reviewer checks the frozen delta. Everyone preserves the pre-follow-up snapshots and all unrelated dirty work; no stage/commit/push/deploy/archive, reset/stash or live-data operations.

Use isolated local browser fixtures at desktop/mobile widths. Hold the real icon-font HTTP response past the browser's normal short block period and confirm no English glyphs, visible ordinary labels and stable compact geometry; release it and confirm actual glyph rendering and dynamic icons. Reject the font request and verify the same non-English failure state, including after font-set readiness. Include cached/immediate success, a non-font shared page and admin shell/iframe integration; distinguish actual font HTTP loading from synthetic API stubs. Capture representative delayed/loaded/failed screenshots and inspect them. Run focused browser checks, then appropriate root syntax/browser and packaging verification; no unchanged backend authentication rerun is needed.

Explicitly exercise an absent font stylesheet/face so a resolved empty load result cannot reveal fallback text after global font readiness. Add a clearly attributed synthetic unavailable-FontFaceSet probe to confirm safe hidden icons with ordinary labels/actions intact; do not describe that compatibility simulation as a second real font transport check.

## Independent review correction

The profile avatar edit overlay combined a structural `profile-avatar-edit` container and the glyph class on one span. The new `1em` rule shrinks its original inset/grid overlay from 88×88 desktop / 62×62 mobile to 24×24. A real baseline/current browser probe confirmed this at both widths and CSS zoom 2; evidence is `avatar-overlay-review.json`. Separate the original outer overlay from an inner Material Symbols span in the already affected profile template. Preserve the overlay's full avatar bounds, centered camera, hover/focus behavior, aria-hidden state and clickable button, with no page-specific exception in shared CSS. Add focused real profile geometry/interactions at both widths/zoom states and verify the loading period still exposes no English.
