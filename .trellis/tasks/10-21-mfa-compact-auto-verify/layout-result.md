# Layout implementation result (R2)

Worker: `trellis-implement` (presentation ownership).
Branch: `fix/admin-mfa-polish`. Date: 2026-10-21.

## Change boundary

Owned and modified:

- `public/css/vaultsso-mfa.css` — rewritten from 539 → 420 lines.
- `views/auth/mfa.html` — 3 lines changed (asset versions + dead class).

Not touched: `public/js/pages/auth/mfa.js`, `tests/**`, `.trellis/spec/**`, admin CSS/views (other workers), all git/lifecycle state.

## What changed

### 1. Stylesheet consolidated into one authoritative layer

The file previously had three stacked layers — a base component layer (`1–345`), a mobile
`@media (max-width: 540px)` (`347–385`), and a late "new-api surface alignment" override
(`395–539`) that retuned chrome but never the content scale, and which silently overrode
mobile rules because it was appended after them.

Now there is exactly **one component layer** followed by **one mobile adjustment layer**
(`@media (max-width: 540px)`) and `@media (prefers-reduced-motion)`. Verified in-browser:
47 top-level rules, 53 flat rules, media blocks `(max-width: 540px)` and
`(prefers-reduced-motion: reduce)` only — no fourth override layer. No selector is declared
twice (checked programmatically).

Superseded/duplicate declarations removed rather than patched: the old 48px card padding,
centered intro, 64/80px code rows, 40/32px row margins, 56px gradient-era submit, 26/24px
slot type, and the hex palette are all gone in favour of shared tokens.

### 2. Agreed compact scale (all measured in a real browser)

| Element | Desktop | ≤540px | Measured desktop / 390 / 320 |
| --- | --- | --- | --- |
| `h1` | 20px | 18px | 20 / 18 / 18 ✓ |
| Code row `.mfa-code-entry` | 48px | 44px | 48 / 44 / 44 ✓ |
| Slot + `#code` type | 18px | 18px | 18 / 18 / 18 ✓ |
| Slot gap | 8px | 6px | — |
| Row → action gap | 20px | 20px | — |
| Primary action `.mfa-submit` | 36px min | 36px min | 36 / 36 / 36 ✓ |
| Recovery input | 40px, 16px type | same | 40 / 40 / 40 ✓, 16px ✓ |
| `#instructions` | 13px, `min-height: 1.6em` floor | same | 20.8px one line, grows to 62.4px at 3 lines ✓ |
| Quick actions | `--control-height` 32px | same | — |

Card: 26rem white panel, 24px padding, hairline `--line` border, `--radius-lg`,
`--shadow-panel`. Mobile outer gutter 16px.

### 3. `#instructions` floor, not cap

`min-height` was `48px` (a large reserved void). It is now `1.6em` (one line) and the element
remains free to grow. Verified at 320px: 1 named line = 20.8px; the longest instruction string
grows to 3 lines / 62.4px with `scrollHeight === clientHeight` — no clipping, no fixed box.

### 4. Recovery mode gets its own height

`.mfa-code-entry.is-recovery` now sets `height: 40px`; `#code` uses `padding: 0 12px`
instead of `16px` (16px vertical padding cannot fit 40px). Previously a single 16px text
field was drawn inside an 80px (desktop) / 64px (mobile) box — the worst proportion defect
in the baseline. Recovery toggle and language behavior untouched.

### 5. Dead code removed

- `.vault-gradient` removed from `views/auth/mfa.html:47`. It was already inert (`.mfa-submit`
  set a flat `background` later in the cascade) and is the decorative-gradient family owned by
  R1. **Not** removed from `.vaultsso-base.css` — `login.html` (×3) and `error.html` still use it.
- `.mfa-status.is-error` / `.mfa-status.is-success` deleted: no element carries `mfa-status`
  and `mfa.js` never adds it (`grep mfa-status` across `views/`, `public/`, `tests/` = 0 hits).
  The working `#status` rule (empty when empty, `margin-top` only when populated) is retained.
- `.mfa-secondary` / `.mfa-link-button` deleted — no markup consumer.

### 6. Cache versions

All three references bumped to `v=20261021-mfa-polish-1`:
`vaultsso-mfa.css` (was `20260930-mfa-1`), `i18n.js` (was `20260930-mfa-1`),
`mfa.js` (was `20261001-mfa-2`). Per the ownership split both script URLs are owned here
because the behavior worker does not touch HTML.

## Preserved contracts (verified in-browser)

| Item | Value |
| --- | --- |
| `#code` id / name | `code` / `verificationcode` |
| type / inputmode / autocomplete | `text` / `numeric` / `one-time-code` |
| maxlength / initial | `6` / `disabled` |
| Decorative slots | 6 × `[data-code-slot]`, wrapper `aria-hidden="true"` |
| `#codeLabel` | `for="code"` (screen-reader-only, unchanged) |
| `aria-describedby` | `instructions` |
| `#status` | `role="status"`, `aria-live="polite"`, `aria-atomic="true"` |
| `#recoveryToggle` | `hidden` until TOTP (`hidden` wins via `.mfa-page [hidden]`) |
| `#backLogin` | same-origin href rewritten by JS, unchanged |
| Slots ↔ input overlay | `#code` still `position: absolute; inset: 0` with transparent text, so
  native selection/caret, click-to-position (`slot.getBoundingClientRect().right`) and
  autofill all keep working with no JS change |

## Focused checks run

1. `npm run check:syntax` → **pass** ("Syntax and browser script references checked: 97 files").
2. Real-browser geometry audit (temporary harness in ignored `.artifacts/`, deleted after use;
   Chrome via `playwright-core`, real markup + real CSS/JS/fonts), 1440×900 / 390×844 / 320×740,
   code mode and recovery mode:

   | Metric | Target | Desktop | 390 | 320 |
   | --- | --- | --- | --- | --- |
   | entry height | 48 / 44 | 48 | 44 | 44 |
   | h1 font | 20 / 18 | 20 | 18 | 18 |
   | submit height | ≥36 | 36 | 36 | 36 |
   | recovery entry / font | 40 / 16 | 40 / 16 | 40 / 16 | 40 / 16 |
   | slot aspect (w÷h) | 0.75–1.35 | 1.13 | 1.05 | 0.79 |
   | entry : action | 1.0–1.6 | 1.33 | 1.22 | 1.22 |
   | slot count | 6 | 6 | 6 | 6 |
   | horizontal overflow | 0 | 0 | 0 | 0 |
   | text clipped | none | none | none | none |

   Card height fell from 453 / 424 / 448 to **376.6 / 370.0 / 370.0** — about 17 % shorter with
   every element retained. Recovery mode collapses slots to 0×0 ✓.
3. Locale wrap audit at 320px (forced longest strings for `en`, `zh`, `zh-TW`): h1 stays on one
   line (23.4px) in all three; longest instruction wraps to 3 lines without clipping; 0
   horizontal overflow; `.mfa-actions` wraps to two rows in English (76px) instead of clipping.
4. Browser console: no `pageerror`; the only console errors were the expected
   `/api/v1/auth/oauth/oidc/pending` 404s from the static harness (no challenge API), not a
   stylesheet or script fault.
5. Stylesheet parse audit: 47 top-level / 53 flat rules, no dropped selectors, no
   `vault-gradient` or `mfa-status` rules remaining.

### Harness caveats (disclosed, not acceptance evidence for behavior)

The temporary harness served the real page statically, so the MFA challenge API 404s: the input
stays disabled, `#recoveryToggle` stays hidden, and recovery geometry was measured by forcing
`is-recovery`. This validates **layout only**. Authentic TOTP/email/recovery flows, autofill and
auto-verify behavior belong to the behavior worker's fixture-based runs.

One earlier reading of "17px horizontal overflow" at 390/320 was a **harness artifact** — the
font files 404'd, so `material-symbols-outlined` ligatures rendered as literal text
(`language`, `arrow_back`) at full glyph width. After serving `/assets/fonts/*.woff2` correctly,
overflow is 0 at every width with zero offending elements. No product defect.

## Handoff notes

- Behavior worker: no CSS/HTML change is required for the auto-verify work. The submit button
  no longer carries `vault-gradient`; nothing else about the form changed.
- `#status` remains empty-in-layout when it has no text, so feedback will not reserve space.
- If a future visual check reports overflow on this page, confirm the Material Symbols font
  actually loaded before treating it as a stylesheet regression.
- The parent's `npm run check:browser` (which includes `password-mfa-browser.cjs`) is the
  integrated gate; it was not run here because the behavior worker is still editing
  `mfa.js` and the MFA tests.
