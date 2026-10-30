# Mobile Turnstile layout correction

## Reproduced cause

The login/registration widget currently selects `compact` whenever `window.innerWidth < 380`. Cloudflare's documented compact geometry is 150×140, whereas normal/flexible are horizontal at 65px high. A realistic iframe geometry simulation against the current real login page reproduced 150×140 at 375px and 360px, matching the reported narrow/tall appearance. Existing CSS additionally reserves 120px below 380px, even when the selected widget is horizontal (380px).

Before measurements are saved in `.artifacts/mobile-turnstile/before-geometry.json`; simulated screenshots are `before-375.png` and `before-390.png` in that directory. The old mock is a small ordinary button and cannot detect the actual widget geometry. The ordinary horizontal widget has a 300px minimum, and the current nested 24px page/card padding leaves insufficient usable width on common phones; a normal widget can increase an intrinsic grid track rather than proving that the card content fits.

These are simulated documented iframe dimensions, not live Cloudflare verification. Root independently verified current official Cloudflare widget-configuration documentation.

## Smallest correction and files

- `public/js/pages/auth/login.js`: select supported `flexible` for a measured host of at least 300px; retain supported `compact` only below that usable width. Observe the actual host so crossing the threshold recreates the widget and clears the old proof. Same-size resizes preserve the widget and token; removed instances' late callbacks cannot refill proof. Existing account/password visibility, manual reset and action names remain intact.
- `public/css/vaultsso-authorize.css`: keep the widget's grid container shrinkable, remove the viewport-based tall reservation and make a narrow mobile padding adjustment so 360/375/390px viewports have at least 300px of usable content. Do not scale, stretch, crop or globally override cross-origin iframe dimensions. A 320px viewport may legitimately retain compact mode when its actual host remains below 300px.
- `views/auth/login.html`: bump only the changed auth JS/CSS cache versions. Preserve shared i18n and unknown-account versions/behavior.
- `tests/turnstile-browser.cjs`: replace the geometry-free button mock with an explicitly simulated iframe using documented normal/flexible/compact dimensions. Assert real host/form/iframe fit at desktop 1440px and mobile 390/375/360/320px, horizontal 65px geometry where it fits, and honest narrow fallback. Cover resizing across the threshold, same-size token retention, stale callback rejection and existing login/register timing/submission.

No backend, MFA, shared i18n, sorting, import or credential-policy change. Root saved the four-file baseline before mutation in `research/mobile-turnstile-baseline.json` and owns final aggregates/spec/task synchronization.

## Validation boundary

Run JS syntax checks and the focused Turnstile browser test; preserve desktop/mobile screenshots and dimension data under `.artifacts/mobile-turnstile/`. Inspect the resulting screenshots. Live Cloudflare is not configured in the isolated fixture, so report simulated geometry and token verification accurately and leave live-provider verification as a limitation.
