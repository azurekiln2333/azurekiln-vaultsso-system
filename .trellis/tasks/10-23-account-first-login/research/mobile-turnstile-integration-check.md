# Mobile Turnstile — independent integration check

Reviewer: `/root/check_user_sort` (`trellis-check`). Task: `10-23-account-first-login`.
Contract: `research/mobile-turnstile-contract.md`. Reviewed after the implementation owner reported
the four product/test files stable. No product/test edits or aggregate execution by this reviewer.

## Findings (fixed)

None. No actionable defect was found in this bounded layout/lifecycle delta.

## Findings (not fixed)

None within this follow-up. Live Cloudflare verification is not configured in the isolated fixture;
the geometry and token/Siteverify simulations are explicitly described as simulations. This limits
the evidence to local layout, lifecycle and retained application request handling, rather than live
provider behavior. Root owns final visual inspection, specs/docs and aggregate checks.

## Baseline and scope

Compared all four files to their exact pre-edit snapshots in
`D:\AppData\Local\Temp\mobile-turnstile-followup-ijqqcyfd`, recorded by
`mobile-turnstile-baseline.json`:

- `public/js/pages/auth/login.js`: only `setupCaptchaWidget` state, measured-size selection,
  revision-guarded callbacks, mode-crossing ResizeObserver and shared removal logic changed.
  Discovery, unknown-account feedback, first-password setup, form submission and CAPTCHA policy
  entry points remain otherwise unchanged.
- `public/css/vaultsso-authorize.css`: captcha grid/host shrinkability, host width, removal of the
  viewport-based 120px reservation, and auth-page mobile padding are the complete style delta.
- `views/auth/login.html`: only the changed auth CSS/JS cache tags were bumped to
  `20261024-turnstile-layout-1`. The explicit-missing-account shared-i18n version is preserved.
- `tests/turnstile-browser.cjs`: geometry-bearing simulated iframe, five viewport widths, threshold
  transitions and proof lifecycle checks extend the prior login/registration surface checks.

No backend, MFA, shared translation, sorting or import behavior is changed by these four-file diffs.

## Geometry and layout

Selection reads the visible host's `getBoundingClientRect().width`, choosing flexible at >=300px
and compact below it. It no longer infers available width from a viewport cutoff. The CAPTCHA
grid item and host have `min-width:0`; the host has width 100%. At <=480px, page/card padding is
12px/16px through existing spacing tokens. Desktop page/card padding rules are unchanged.
No cross-origin iframe scaling, stretching, cropping or broad iframe selector was added.

Read the actual focused-run `.artifacts/mobile-turnstile/geometry.json` measurements for both login
and registration:

| Viewport | Host width | Selected size | Simulated frame | Document overflow |
| --- | --- | --- | --- | --- |
| 1440 | 350px | flexible | 350 x 65px | none |
| 390 | 332px | flexible | 332 x 65px | none |
| 375 | 317px | flexible | 317 x 65px | none |
| 360 | 302px | flexible | 302 x 65px | none |
| 320 | 262px | compact | 150 x 140px | none |

The iframe fits the measured form rather than enlarging an intrinsic grid track, and flexible hosts
have exactly 65px height without the old tall reservation. The 320px fallback retains natural compact
geometry. Desktop keeps its original 350px form content width; the supported flexible widget fills it.

## Show/hide, resize and proof lifecycle

- Widget removal increments the revision and clears the token before removing the old instance.
  Each render captures a fresh revision. Success, expiry and error callbacks require both the current
  revision and a visible active form/auth region before updating the token.
- Hiding the login challenge on account/setup/contact transitions uses that shared removal path.
  Late callbacks from removed instances therefore cannot restore old proof or clear newer proof.
- A pending script load checks current visibility and login step before rendering, and selects the
  current host width at render time. Hidden forms do not acquire a widget through that callback.
- ResizeObserver only refreshes an existing visible widget when the supported size category changes.
  Within flexible or within compact, it leaves the instance/token alone. Crossing the threshold
  removes the prior widget, clears proof and renders one replacement with the current size.
- Explicit refresh and post-credential one-use reset retain the prior reset behavior; callbacks and
  CAPTCHA action names remain tied to their respective login/registration controllers.

## Test validity and preserved behavior

The mock is explicitly a simulated provider iframe, separated from page CSS through its document.
It models flexible's minimum width and 65px height and compact's 150 x 140px geometry. Real provider
script and Siteverify responses are mocked; the served auth page, CSS, controls, application endpoints
and ordinary password login remain real isolated-fixture behavior.

The expanded test checks form/frame/host bounds, document overflow, natural heights and no obsolete
height reservation. It covers flexible->flexible retention, flexible->compact->flexible replacement,
compact->compact retention, exactly one live iframe, stale success rejection, stale expiry/error
rejection against newer proof, account-step hiding and the ordinary failed-password reset. It still
asserts no login widget at account entry, actual password-step rendering, hidden image CAPTCHA,
real successful password login, registration widget timing/geometry and empty page-error collections.

The mock has real geometry, unlike the former unbounded button; a pre-fix ordinary horizontal widget
could therefore no longer pass merely by expanding its grid track. Scope and live-provider limits
are accurately described in source and output. No test-side product workaround or backend-policy
relaxation was introduced.

## Verification

- Lint: no standalone script configured.
- TypeCheck: no standalone script configured.
- `node --check public/js/pages/auth/login.js`: pass (exit 0).
- `node --check tests/turnstile-browser.cjs`: pass (exit 0).
- Read `.artifacts/mobile-turnstile/turnstile-browser.log`: focused owner run PASS at
  1440/390/375/360/320px, registration, responsive proof lifecycle and ordinary login.
- Read before/final geometry artifacts; final screenshots exist for login/registration at all five
  widths plus the resize fallback. Root owns screenshot inspection and aggregate execution.
- No repeated browser/API/aggregate run, product/test mutation, commit, push, deploy or archive.

Final verdict: **no open behavior findings** in the frozen mobile Turnstile correction.
