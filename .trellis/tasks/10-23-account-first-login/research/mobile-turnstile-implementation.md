# Mobile Turnstile implementation and validation

## Result and cause

The reported narrow/tall mobile challenge was reproduced before editing. The renderer explicitly chose `compact` below a 380px viewport, yielding Cloudflare's documented 150×140 geometry on 375px and 360px screens. It was an intentional compact-size selection, rather than CSS stretching a horizontal iframe. The old mobile CSS also reserved at least 120px at 380px even when the widget was horizontal. Nested page/card padding prevented a 300px horizontal widget from fitting ordinary mobile form content, and intrinsic grid tracks could conceal that mismatch by growing.

The correction now measures usable host width: 300px or more uses supported `flexible` mode; narrower hosts retain supported `compact`. Mobile horizontal padding is reduced sufficiently for 360/375/390px phones. No cross-origin iframe dimensions are overridden or scaled.

## Changed files

- `public/js/pages/auth/login.js`: measured host-size choice; instance size/revision tracking; threshold-only `ResizeObserver` recreation. A mode transition removes the old instance and clears proof. Same-mode resizing preserves the instance and token. Late success/expiry/error callbacks from removed instances cannot change the current token. Existing visible password-step gating, register action, challenge reset after credential submission and image fallback remain intact.
- `public/css/vaultsso-authorize.css`: shrinkable CAPTCHA grid item and full-width host; remove the old mobile tall reservation; at widths up to 480px use 12px page-side padding and 16px card padding. Other auth layouts continue using existing tokens and rules.
- `views/auth/login.html`: update the changed JS/CSS references to `20261024-turnstile-layout-1`. The unknown-account i18n cache version is preserved. Search confirmed this is the only consumer of those two changed assets.
- `tests/turnstile-browser.cjs`: realistic documented iframe geometry simulation replaces the unconstrained button mock. Tests now inspect the iframe against actual form content and document bounds, so an oversized intrinsic grid track cannot masquerade as a valid fit.

The four-file baseline is recorded in `research/mobile-turnstile-baseline.json`. Product/test files are frozen; this report and the pre-edit `research/mobile-turnstile-contract.md` are the only additional owned artifacts. No server, MFA, shared i18n, sorting or import code changed.

## Measured browser behavior

| Viewport width | Previous simulated widget | Updated simulated widget | Updated host width |
| --- | --- | --- | --- |
| 1440px | normal 300×65 | flexible 350×65 | 350px |
| 390px | normal 300×65 | flexible 332×65 | 332px |
| 375px | compact 150×140 | flexible 317×65 | 317px |
| 360px | compact 150×140 | flexible 302×65 | 302px |
| 320px | compact 150×140 | compact 150×140 | 262px |

Both login and registration pass at all five widths. At 320px, compact is the honest supported fallback because flexible requires at least 300px of usable container width. No horizontal overflow or clipping was observed. At the common phone widths, the challenge fills the form horizontally and remains 65px high.

The 375px scenario additionally resizes to 390 → 320 → 340 → 375. It proves same-mode token/instance retention, threshold-crossing token clearing and old iframe removal, rejection of removed-instance success/expiry/error callbacks, safe account-step hiding and recreation, and ordinary one-use challenge reset after a real wrong-password response. A newly completed challenge then allows real fixture-backed password login. Existing account-step absence, registration mounting and login submission coverage remain present.

## Checks and artifacts

- `node --check public/js/pages/auth/login.js`: passed.
- `node --check tests/turnstile-browser.cjs`: passed.
- `node tests/turnstile-browser.cjs`: passed on the first focused implementation run.
- Focused log: `.artifacts/mobile-turnstile/turnstile-browser.log`.
- Before measurement data: `.artifacts/mobile-turnstile/before-geometry.json`.
- Updated dimensions for login/register/resizes: `.artifacts/mobile-turnstile/geometry.json`.
- Before screenshots: `.artifacts/mobile-turnstile/before-375.png` and `before-390.png`.
- Updated screenshots: `.artifacts/mobile-turnstile/turnstile-login-{1440|390|375|360|320}.png`, corresponding `turnstile-register-{width}.png`, and `turnstile-resize-compact-320.png`.
- Visually inspected the before-375 reproduction; updated login at 1440/390/375/320; and updated registration at 360. The common mobile horizontal challenge now fits between the form edges, with no tall unused reservation. Root also independently inspected before/after375.

Root owns independent code review, task/spec synchronization and final syntax/browser aggregates. No commit, push, deployment or archive was performed.

## Verification limit

Cloudflare's script and siteverify endpoint are explicitly simulated in this isolated fixture. The iframe honors documented fixed/flexible dimensions and isolates its contents from page CSS, but this does not establish behavior of an actual configured Cloudflare challenge, its shadow DOM, network delivery or anti-bot decision. No real production site/secret keys or live-provider challenge were used. The 320px compact fallback remains deliberate.
