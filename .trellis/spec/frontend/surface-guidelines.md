# Admin surfaces and compact authentication layouts

## Scope and owning files

Admin shell/content styling lives in `public/css/vaultsso-admin.css` and `vaultsso-admin-pages.css`; dedicated MFA styling lives in `vaultsso-mfa.css`. Shared palette, radius and spacing tokens live in `vaultsso-base.css`. Preserve JavaScript selectors, routes and field names when changing presentation.

## Admin background contract

`views/admin/index.html` has `html[data-admin-shell]`; the seven content templates have `html[data-admin-page]`. Both shell and iframe documents paint their own body backgrounds. The shared `.vaultsso-page-surface` also styles the public API-docs page, so flatten admin through admin-owned hooks/stylesheets rather than changing that shared class globally.

```css
html[data-admin-shell] body.vaultsso-page-surface,
html[data-admin-page] body.vaultsso-page-surface {
  background: var(--surface-page);
}

.admin-shell-iframe {
  background: var(--surface-page);
}
```

Use the full `background` shorthand or explicitly clear `background-image`; setting only `background-color` leaves shared gradient images visible. Cover embedded and direct entry. Keep white content panels, restrained token-based radii/borders, minimal shadows, compact controls and container-bounded scrolling for wide tables. Preserve access to full metadata when using truncation; do not hide columns or clip real content to force a numeric row height.

## CSS cascade and cache contract

- Keep one authoritative component layer and a following responsive layer. Remove superseded declarations during local consolidation; avoid appended alignment blocks that shrink the card but retain oversized child heights, type or margins.
- For MFA, verify the heading, instructions, native input, decorative slots, primary action, recovery field, feedback and mobile rules as one layout. Keep localized text free to wrap and empty live-status regions free of visible layout space.
- Update versioned CSS/JS URLs in every affected template, including all admin iframe consumers. A shell refresh alone does not ensure cached iframe CSS has changed.
- Leave generated `vaultsso-utilities.css` alone unless utility usage changes; then rebuild through the existing CSS build script.

## Shared icon-font loading

All current templates load the same Material Symbols font, base CSS and deferred icon-font helper. Keep a compact hidden icon slot until the actual face successfully loads; failed or missing fonts must never expose English ligature names. Ordinary labels/actions stay visible. The critical CSS/JS belongs in packaged `/css` and `/js`, because font assets under `/assets` are supplied separately. Follow [Icon Font Loading](./icon-font-loading.md) for exact readiness, dynamic/iframe, failure and browser-evidence contracts.

## Turnstile form geometry

The shared login/registration page uses Cloudflare Turnstile's supported sizes. `compact` is 150×140; `flexible` is horizontal at 65px high with a 300px minimum width. Choose from the visible host's actual available width, rather than a viewport cutoff: use flexible at 300px or wider and compact only when the form genuinely cannot fit it. Keep the host's grid track shrinkable and allow sufficient form width at common 360/375/390px phone widths. Do not stretch, scale or clip the cross-origin iframe, or leave a mobile-only tall minimum-height reservation on a horizontal widget.

If the host crosses the supported-size boundary, recreate the widget and clear the old proof; preserve a valid token for same-size resizes. Hidden/inactive forms must not render widgets, and callbacks from removed instances must not restore a stale token. Scope mobile spacing changes to the auth page and bump its changed CSS/JS references.

`tests/turnstile-browser.cjs` uses simulated documented iframe geometry to check host/form/iframe fit at desktop and 390/375/360/320px, narrow fallback, resize/token lifecycle and existing login/registration behavior. Clearly distinguish this fixture from live Cloudflare verification. A geometry-free ordinary button mock cannot establish widget fit.

## Verification and common mistakes

Inspect actual before/after screenshots for shell and embedded/direct content, desktop and narrow mobile, supported locales, focus, errors and recovery mode. Assert page-specific ready markers so a login screen or unfinished shell is not mistaken for a reviewed admin page. Capture tall forms by scrolling or full-page images when needed.

Computed style/overflow measurements support review but cannot establish visual quality by themselves. Use existing browser smoke checks for navigation and focused behavior tests for authentication interactions; do not add persistent tests that merely repeat CSS declarations.

Wrong: flatten only the outer shell, or append a compact-panel override while the code row stays 80px tall.

Correct: paint both admin documents explicitly, and consolidate all MFA dimensions with the mobile layer after the base rules. See [Authentication Feedback](./auth-feedback.md) for the input and automatic-verification behavior contract.
