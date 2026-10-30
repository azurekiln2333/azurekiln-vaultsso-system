# Independent review — admin surfaces and MFA polish

Reviewer: `trellis-check` (this pane). Reviewed the delivered diff directly; no product/test file was edited by me.
Task: parent `10-21-admin-mfa-polish`, children `10-21-admin-flat-surfaces` and `10-21-mfa-compact-auto-verify`.
Date: 2026-10-21. Branch: `fix/admin-mfa-polish`.

## Verdict

**PASS — no material finding blocks integration.** Flat admin surfaces, compact MFA geometry, and the
automatic six-digit completion contract all hold in real browsers against the isolated fixture. All
review assertions pass and every product/test change I inspected matches its PRD, design, and the updated
`auth-feedback.md` / `surface-guidelines.md` contracts.

One **pre-existing, out-of-scope** defect is recorded below (shell-mode language switch drops the account
label); it is not caused by this task and I did not touch it.

## Evidence inventory (ignored `.artifacts/admin-mfa-polish/`)

| Artifact | Content |
| --- | --- |
| `baseline/` (36 PNGs + `measurements.json`) | BEFORE matrix, captured on a clean tree before any edit |
| `after/capture-after.cjs` | temporary review harness (`--admin` / `--mfa` / full); writes one measurement file per mode |
| `after/after-measurements-admin.json` + 50 admin PNGs | AFTER admin matrix, DOM/geometry/flat-surface assertions |
| `after/after-measurements-mfa.json` + 41 MFA PNGs | AFTER MFA matrix, geometry, focus/recovery states, behaviour traces |

Total after-evidence: **91 screenshots**, 167 measurements, zero failures. (The MFA set was regenerated after a
first-pass archive slip of mine described under Limitations; the admin set was not re-run for that.)

Method for every captured cell: isolated in-memory fixture (`tests/support/fixture.js` — memory DB, random
per-run JWT/OIDC keys, stubbed mail, no Turnstile), ephemeral port, off-origin requests aborted, real login
form, fresh context per cell. Browsers and fixture are closed in `finally`; nothing from the interrupted run
was left running (verified: no orphan fixture port, no stray Chrome child).

### AFTER admin matrix

`zh` + `en` at desktop 1280 / mobile 390, representative `zh-TW` desktop, and a `zh` narrow 320 overflow cell
× four surfaces (shell+overview/users, clients form+table, users table, security form), plus drawer and
collapsed-rail states. 50 screenshots, 87 measurements, **28.8 s** wall clock.

### AFTER MFA matrix

`zh` / `en` / `zh-TW` × desktop 1280 / mobile 390 / narrow 320 × email + TOTP + recovery/focus states, plus
four behaviour scenarios.

## AC1 / R1 — flat admin surfaces: PASS

Measured computed styles, every captured admin cell (shell and iframe, direct and embedded, zh/en/zh-TW):

| Probe | BEFORE (baseline) | AFTER |
| --- | --- | --- |
| shell `body` `background-image` | 3-layer radial+linear blue mesh | **`none`** |
| iframe `body` `background-image` | same 3-layer mesh | **`none`** |
| shell `body` `background-color` | transparent | `rgb(248, 249, 251)` |
| iframe `body` `background-color` | transparent | `rgb(248, 249, 251)` (identical → no seam) |
| direct page (`/apps.html`, `/users.html`, `/security.html`) | mesh | `rgb(248, 249, 251)`, `none` |

Both documents paint explicitly (`vaultsso-admin.css` — `html[data-admin-shell] body.vaultsso-page-surface,
html[data-admin-page] body.vaultsso-page-surface { background: var(--surface-page); background-image: none }`),
so the iframe cannot inherit a gradient through a transparent body, and direct entry matches embedded.
`.admin-shell-iframe` also carries an explicit neutral background. `.vaultsso-page-surface` itself was **not**
modified, so `views/docs/api.html` and the public auth pages are untouched (verified by reading the diff:
`public/css/vaultsso-base.css` is not in the change set).

Panel alignment: `.napi-panel`/`.napi-card`, `.admin-toolbar-card`, `.admin-table-panel`, `.admin-empty`,
`.admin-stat` all now `border-radius: 12px` with `box-shadow: none` and `1px var(--line)` borders — measured
`r12px sh:none` on clients (358x1033 mobile / 420x973 desktop / 288x1051 narrow) and security (643x504 /
358x600). Controls keep the existing compact rhythm (32px inputs, 28–40px buttons).

### Follow-up review (p3's narrow polish): PASS, both items

1. **Date cells no longer split.** New rule `td.admin-cell-sub { max-width: none; overflow-wrap: normal;
   white-space: nowrap }` narrows the change to `<td>` only, so `.admin-cell-sub` on username/UUID
   `<span>`/`<code>` still wraps. Confirmed visually: at the collapsed-rail width the timestamp renders as the
   complete `2026/10/21 20:49:40` on one line (before: isolated trailing digits on their own line, visible in
   `baseline/admin-overview-users-zh-desktop-1280.png`). At full-rail widths the column is clipped by the
   container edge exactly like every other wide column (see AC "container-bounded scrolling").
2. **Mobile clients stats are two columns.** The `max-width: 520px → 1fr` rule was removed, so
   `.admin-stat-grid` holds `repeat(2, minmax(0, 1fr))` from 960px down to 320px. Confirmed visually at 390
   and 320: four cards occupy two rows instead of four full-width rows, labels wrap without clipping, and
   `.admin-stat-grid-3` (user.html) is unaffected. No overflow (measured 0 at 320/360-class widths).

No ellipsis, no truncation, no hidden columns: full metadata remains available and wide tables scroll inside
`.napi-table-scroll` (measured inner scroll 167–168px at desktop, 785/856px at 390/320). Per the design, row
height stays 121px for the seeded long-value record — that is the recorded "keep full values" decision, not a
regression.

## AC2 / R2 — compact MFA geometry: PASS

Measured on freshly loaded, enabled pages (all three factor/mode states):

| Metric | BEFORE | Design target | AFTER (measured zh desktop / zh mobile / en narrow) |
| --- | --- | --- | --- |
| heading | 30px/800 (26px mobile) | 20px / 18px | **20px** desktop, **18px** mobile+narrow |
| code row | 80px (64px mobile) | 48px / 44px | **48px** / **44px** / **44px** |
| slot size | 51x80 (0.64 aspect) | aspect 0.75–1.35 | 54x48 (1.13) / 46x44 (1.05) / 35x44 (0.80) |
| slot gap | 12 / 6 | 8 / 6 | **8** / **6** / **6** |
| entry ÷ action | 80/32 = 2.5 | 1.0–1.6 | **1.33** / **1.22** / **1.22** |
| primary action | 32px | ≥36px | **36px** at every width |
| recovery input | 80px tall | 40px | **40px** |
| instructions | 15px, 48px min-height | 13px, natural | **13px**, `min-height: 1.6em` |
| heading→code-row gap (title bottom → row top, includes the intro divider + hint) | 96–121px | (compact) | **64px** desktop, **65–85px** narrow |
| submit gradient | `vault-gradient` class in markup | removed | **class removed**, `background-image: none` |

Recovery mode collapses the slots and shows a 40px text field, `name=recovery_code`, `inputmode=text`,
`maxlength=32`, `aria-pressed=true`; switching back restores `totp_code` and clears the value. Oversized
`::before` dots remain the idle placeholder. The stylesheet is now one component layer + one mobile layer +
reduced-motion (the old contradictory 539-line double layer is consolidated), which is exactly what
`surface-guidelines.md` now requires.

## AC3 / R3 — automatic completion, single owner: PASS

Behaviour traces from the harness (intercepted and held `POST /api/v1/auth/oauth/oidc/complete`):

| Case | Result |
| --- | --- |
| Five digits typed | **0** requests |
| Sixth digit typed | **exactly 1** request |
| While pending: synthetic `input` + `change` + direct `form.requestSubmit()` | still **1** request |
| Held request released → invalid code | no navigation, input cleared + refocused, localized feedback shown |
| Re-entering a *different* and then the *same* code | +1 request each (fresh edit retries) |
| Whole-code paste | 1 request, continues through the existing flow |
| Language change then mode toggle (`recoveryToggle` ×2) with 5 digits present | **0** requests |
| Recovery-mode six-character text (`ABCDEF`) | **0** requests, no navigation |

Statics confirm the single-owner design: `maybeAutoVerify()` only *calls* `mfaForm.requestSubmit()`; the
existing `mfaForm` submit handler still owns the synchronous lock (`setMfaSubmitting(true)` before the first
`await`), the single `fetch`, feedback, and success-only `window.location.assign` after same-origin
validation. Marker `mfaAutoAttemptValue` is reset on rejection, mode change, and fresh challenge; IME
composition sets `mfaComposing` and suppresses both normalization and submission until `compositionend`.
No polling, no `MutationObserver`, no debounce, no second fetch path.

## AC4 / R4 — preserved recovery, errors, terminal handling: PASS

- Recovery toggle only for TOTP; recovery stays manual; six-char recovery text does not submit.
- Invalid code: status region shows localized text, input cleared and refocused, no navigation.
- Terminal 401/429 path unchanged (`mfaCode.disabled = true`, both buttons stay disabled via
  `setMfaSubmitting(false)` reading `mfaCode.disabled`).
- Field contract intact in every state: `name` `email_code`/`totp_code`/`recovery_code`, `inputmode`,
  `autocomplete="one-time-code"`/`off`, `maxlength` 6/32, `#code` the only real input, six
  `[data-code-slot]`, empty `role=status` with no visible layout space.
- MFA page is flat `rgb(248, 249, 251)`; card has no gradient.

## Errors, overflow, markers

- **`pageerror`: 0** and **unexpected console errors: 0** across every captured admin and MFA cell.
- **Horizontal overflow: 0px** everywhere (admin shell, iframe, direct pages, 1280/1440/390/360/320; MFA
  1280/390/320; zh/en/zh-TW).
- Page markers asserted before every screenshot: shell `#adminAccountName` resolved (never `加载中...`),
  `#adminPageTitle` present, `[data-nav-id]` = 7 items with the correct `.active` entry, embedded
  `.napi-page-desc`/`.napi-panel`/`table.napi-table` present, `h1 ≤ 1`, `footer = 0`.

## Navigation and drawer

- Desktop collapse: rail 256 → **68px**, iframe 1216 → 1212, no overflow, and the width restores exactly on
  toggle back.
- Mobile drawer at 390/320 and in zh/en/zh-TW: opens (`sidebar.open`, overlay visible), no overflow.
  Overlay click to the right of the drawer **closes** it. My first run reported 7 false failures here because
  the harness clicked the overlay's `(5,5)` corner, which is covered by the topbar; the corrected coordinate
  passes. **Not a product defect.**

## Material observations

1. **(Pre-existing, out of scope) Shell-mode language switch drops the account label.**
   `public/js/shared/admin-shell.js` (unmodified by this task) handles `vaultsso:languagechange` in
   `mountShell()` by re-rendering the topbar (`render()` → `buildTopbarHtml`) but does **not** call
   `loadAccount()`, so `#adminAccountName` reverts to `加载中...` until the next full load. Page mode
   (`mountPageChrome`, line ~381) *does* call `loadAccount()`, so direct pages are unaffected. Reproduced in
   the harness (`observation/shell-language-switch`). This also explains the `加载中...` label in the
   BASELINE overview screenshot, which my earlier baseline note attributed to a capture race — the accurate
   cause is this missing re-fetch. Scope note: admin JavaScript is explicitly outside the admin child's edit
   set, so I did not change it. Recommend a separate follow-up task (one-line fix) rather than expanding this
   change.
2. Harness-only corrections I made while reviewing (no product impact): replaced `networkidle` with
   deterministic readiness, stopped waiting for *visibility* of the intentionally hidden optional
   `#statusBar` (this was the 20 s/cell cost), switched admin language from runtime `setLanguage` to context
   locale (because of observation 1), and fixed the drawer-click coordinate. The bounded admin rerun takes
   28.8 s instead of 4+ minutes with identical or stronger assertions.
3. `tests/password-mfa-browser.cjs` and `tests/multi-authenticator-browser.cjs` were updated by their owners
   and now match the automatic-completion contract; I did not run the full browser suite (main owns it) and
   did not repeat main's `security`/`password-mfa` unit run (43/43 pass).
4. The `account-bindings-browser.cjs:65` timeout main reported is on a surface outside this change
   (account bindings), owned by p5; nothing in my admin/MFA evidence suggests it is caused by the flat-surface
   or MFA work. No admin/MFA cell reproduced a timeout.

## Limitations

- One seeded admin account per cell, so table density is judged on that single (long-value) row.
- `zh-TW` is representative only (desktop admin, desktop+mobile MFA), per the bounded scope.
- Screenshots for tall panels are captured both viewport-sized and full-page (`*-full.png` for
  desktop/mobile); the clients panel is 973–1099px tall, so its lower half is only visible in the full-page
  images.
- Simulated `input`/`change` events approximate password-manager autofill; this is **not** a real extension
  test, consistent with `auth-feedback.md`.
- **Reviewer archive slip, disclosed:** while switching the harness to `--admin` I deleted the then-current
  PNGs and the `--admin` run overwrote the shared measurement file, briefly destroying the MFA evidence. I
  fixed the harness to write `after-measurements-<mode>.json` per mode and regenerated the MFA set once
  (46 s, same diff, all assertions pass); the numbers in this review come from the regenerated files. No
  product or test file was affected.
- CSS/JS asset versions were bumped (`?v=20261021-admin-flat-1`, `?v=20261021-mfa-polish-1`) on all eight
  admin views and the MFA page, so I did not need to test stale-cache behaviour explicitly.

## Recommendation

Accept both children for integration. Optionally file the one-line `admin-shell.js` `loadAccount()` follow-up
(observation 1) as its own small task. No product edits were made by me; I made no commit, branch, or
task-lifecycle change.
