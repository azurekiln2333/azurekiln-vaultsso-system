# R2 Research — Compact MFA layout audit

Research owner: trellis-research (R2 only). Parent: `10-21-admin-mfa-polish`. Child: `10-21-mfa-compact-auto-verify`.
Scope: layout/proportion evidence for R2. R3/R4 (auto-verify) is covered by another research file. No product edits made.

---

## 1. Files audited and consumer scope

| File | Role |
| --- | --- |
| `views/auth/mfa.html` | Only page markup; 56 lines |
| `public/css/vaultsso-mfa.css` | Only stylesheet for that page; 539 lines |
| `public/css/vaultsso-base.css` | Shared tokens (`--space-*`, `--control-height`, `--radius-*`) |
| `public/js/pages/auth/mfa.js` | Toggles `is-active` / `is-recovery`, mirrors value into slots |

**Consumer isolation (safe to change `vaultsso-mfa.css`):**

- `grep vaultsso-mfa` across `views/` + `public/` returns exactly one hit: `views/auth/mfa.html:9`.
- No `.mfa-*` class appears in any other `views/**/*.html` file.
- The bare IDs `#code`, `#status`, `#submit`, `#codeEntry`, `#instructions` exist **only** in `views/auth/mfa.html` (verified repo-wide across `views/`). The login page uses `#statusMessage`, not `#status`.
- `vaultsso-base.css` is shared by login/admin/profile. **Do not edit it for R2.** In particular `.vault-gradient` (`vaultsso-base.css:80`) is shared, and `mfa.html:47` still applies it to the submit button.

**Guard for implementation:** keep every new rule inside `vaultsso-mfa.css`. Prefer adding `.mfa-*` class hooks over new bare-ID selectors, so a future page cannot inherit MFA-only geometry.

---

## 2. Root cause of the current disproportion

The stylesheet contains **three stacked layers**, appended over three commits
(`2265155` rebuild → `b6f9666` new-api alignment → `e03c189` footer removal):

| Layer | Lines | Retunes |
| --- | --- | --- |
| 2a. Base component layer | `1–345` | full original scale (large, centered, 48px card padding) |
| 2b. `@media (max-width: 540px)` | `347–385` | mobile sizes for card/intro/h1/code-entry/gap/slot font |
| 2c. "new-api surface alignment" late override | `395–539` | **chrome only**: card, intro, lock, slot border, submit, language menu |

The defect: **the late override block (2c) retunes the panel chrome but never retunes the content scale.** It never re-declares `.mfa-code-entry`, `.mfa-code-slots`, `#code`, `#instructions`, or the `.mfa-intro h1` font size. Confirmed by enumerating every selector in `395–539`: no `.mfa-code-entry`, no `.mfa-code-slots`, no `#code`, no `#instructions`, no `h1`.

Cascade consequence — because 2c is appended **after** the media query and has equal specificity (single class), it silently overrides mobile rules too:

| Property | Mobile rule (2b) | Late rule (2c) | Wins at ≤540px |
| --- | --- | --- | --- |
| `.mfa-card` padding | `32px 28px` (`:356`) | `var(--space-6)` = 24px (`:422`) | 2c → 24px |
| `.mfa-intro` margin-bottom | `32px` (`:360`) | `var(--space-5)` = 20px (`:431`) | 2c → 20px |
| `.mfa-main` padding | `24px 16px` (`:352`) | `20px 16px` (`:417`) | 2c → 20px |
| `.mfa-code-slot` font-size | `24px` (`:377`) | `20px` (`:454`) | 2c → 20px |
| `.mfa-code-entry` height | `64px` (`:368`) | **not declared** | 2b → 64px |
| `.mfa-code-slots` gap | `6px` (`:373`) | **not declared** | 2b → 6px |
| `.mfa-intro h1` font-size | `26px` (`:364`) | **not declared** | 2b → 26px |

So mobile currently mixes a *compact* panel (24px padding, left-aligned intro) with a *large-format* code row (80px→64px tall) and an untouched 30px→26px heading. That mixture is the visible disproportion.

---

## 3. Measured current geometry

### Desktop (≥541px)

Card `max-width: 26rem` = 416px, padding 24px → **content width 368px**.
Slots: 6 columns, `gap: 12px` → `(368 − 5×12) / 6` = **51.3px wide × 80px tall** → aspect **0.64** (tall rectangles).

Vertical stack inside the card content box:

| Segment | Height |
| --- | --- |
| lock 40 + margin 12 | 52.0 |
| h1 30 × 1.25 + margin 12 | 49.5 |
| `#instructions` `min-height: 48px` (floor only — actual height grows with the hint text) | ≥ 48.0 |
| intro `padding-bottom` 16 + `margin-bottom` 20 | 36.0 |
| code entry `height: 80px` + `margin-bottom: 40px` | 120.0 |
| submit `min-height: 32px` | 32.0 |
| `#status` empty | 0 |
| actions `margin-top` 24 + `min-height` 40 | 64.0 |
| **content total** | **≥ 401.5** |
| + card padding 24 / 24 | **≈450px card height (floor)** |

**Key ratios (desktop):**

- code entry height : submit height = `80 : 32` = **2.5 : 1** — the input dominates the primary action.
- card content width : slot height = `51.3 : 80` — slots are taller than they are wide.
- h1 30px inside a 24px-padded, 26rem panel (login page equivalent `.card-title` is **17px**, `vaultsso-authorize.css:109`) — heading is ~1.8× the sibling-page scale.

### Mobile 390px (`@media (max-width: 540px)`)

Card = `390 − 32` = 358px, padding 24 → **content 310px**; `gap: 6px` → `(310 − 30) / 6` = **46.7px wide × 64px tall** → aspect **0.73**.

Vertical: 40+12 + (26×1.25=32.5)+12 + 48 + 16+20 + 64+32 + 32 + 24+40 = **372.5** content → **≈420px card**, + main padding 40 + header ≈ 56 → **≈516px page height**.

### Mobile 320px (existing test viewport)

Card = `320 − 32` = 288px, content **240px**; gap 6 → `(240 − 30) / 6` = **35px wide × 64px tall** → aspect **0.55** — the worst proportionality in the set (nearly 1:2 vertical).

### Recovery mode (all viewports)

`.mfa-code-entry.is-recovery` (`:230`) only hides the slots (`display: none`) and restyles `#code` (`padding: 16px`, `font-size: 16px`, `:236–256`). It **does not reset `.mfa-code-entry` height**, so a single recovery text field is rendered inside an **80px (desktop) / 64px (mobile)** tall box with 16px text. That is the most visible proportion defect in R2 and it is currently untested visually — the screenshot `login-totp-page-*.png` (`tests/password-mfa-browser.cjs:223`) captures exactly this state.

**Note on overflow:** no horizontal overflow exists today (the existing tests already assert `scrollWidth <= innerWidth` at 320 and 390). R2 is therefore a *proportion/rhythm* problem, not an overflow regression. Automation must not "prove" R2 by overflow assertions alone.

---

## 4. Recommended compact scale (tokens only, existing visual system)

Reuse `--space-*` / `--control-height` / `--radius-*` from `vaultsso-base.css`; introduce no new magic numbers beyond what the layer already uses. Target: near-square slots and a primary action of comparable weight to the input.

| Selector | Current | Proposed | Rationale |
| --- | --- | --- | --- |
| `.mfa-card` max-width | `26rem` | keep `26rem` | already coherent with login's `25rem` |
| `.mfa-card` padding | 24px (2c) | keep 24px | matches login `.auth-card` |
| `.mfa-intro h1` | 30px / 26px | **20px** desktop, **18px** ≤540px | 17px `.card-title` sibling scale; 30px in a compact panel is the loudest offender |
| `.mfa-intro h1` line-height | 1.25 | keep 1.25 | fine once font shrinks |
| `#instructions` | 15px, `min-height: 48px` | **13px**, `min-height: 2.6em` (≈34px) | 48px reserve is dead space. `min-height` is a **floor, not a cap** — the hint must still be free to grow for longer localized text |
| `.mfa-code-entry` height | 80px / 64px | **48px** desktop, **44px** ≤540px | near-square slots; see ratios below |
| `.mfa-code-entry` margin-bottom | 40px / 32px | **var(--space-5)** 20px | 40px gap exceeds the entry's own height budget |
| `.mfa-code-slots` gap | 12px / 6px | **8px** desktop, **6px** ≤540px | keep current mobile value; 8px reads tighter at 48px height |
| `.mfa-code-slot` font-size | 20px (2c) | **18px** | keep proportional to 48px box |
| `.mfa-code-slot:empty::before` | 22px | **16px** | bullet must not exceed slot text size |
| `#code` font-size | 26px | **18px** | keep in sync with slot so selection geometry aligns |
| `.mfa-submit` min-height | 32px | **36px** | matches login `.primary-submit` 36px; 1:1.33 vs 48px entry instead of 1:2.5 |
| `.mfa-actions` margin-top | 24px | **var(--space-4)** 16px | consistent with tightened rhythm |
| `#backLogin`/`#recoveryToggle` min-height | 40px | **var(--control-height)** 32px | shared control baseline |
| recovery `.mfa-code-entry` height | inherits 80/64px | **40px** (`is-recovery`) | a single 16px text field must not sit in an 80px box |
| recovery `#code` padding | `16px` | `0 12px` | 16px vertical padding cannot fit a 40px box |

### Resulting ratios

| Viewport | Slot size | Aspect (width ÷ height) | entry : submit |
| --- | --- | --- | --- |
| 1440 (card 416, content 368, gap 8) | 54.7 × 48 | **1.14** | 48 : 36 = **1.33** |
| 390 (content 310, gap 6) | 46.7 × 44 | **1.06** | 44 : 36 = **1.22** |
| 320 (content 240, gap 6) | 35 × 44 | **0.80** | 44 : 36 = **1.22** |

320px remains the tightest case; if 0.80 still reads tall, reduce `gap` to 4px at `max-width: 360px` → slot 36.7 × 44 (0.83) or drop the 320px entry height to 40px → 0.88. Do not shrink below 40px (touch target).

Desktop card height then becomes 40+12 + 25+12 + 34 + 16+20 + 48+20 + 36 + 16+32 ≈ **311** content → **≈359px card** (from ≈450px), a ~20% reduction without removing any element.

---

## 5. Constraints that must survive the layout change

From `.trellis/spec/frontend/auth-feedback.md:19–21` — geometry work must not break these:

- Six `[data-code-slot]` spans stay decorative `aria-hidden`; `#code` stays the single real input.
- Keep `#code` absolutely positioned over the slot row (`inset: 0`, transparent text/caret/shimmer). Changing `.mfa-code-entry` height automatically reflows both, so no JS change is needed.
- Keep `maxlength` 6/32, `inputmode` numeric/text, `autocomplete` one-time-code/off, names `verificationcode`/`totp_code`/`email_code`/`recovery_code`.
- The slot click-to-position handler (`mfa.js:149–155`) uses `slot.getBoundingClientRect().right` — resizing slots is safe, but changing the slot count or making slots non-contiguous would break it.
- `#status` must stay an empty `role=status` region that occupies no layout space when empty. Currently `#status` has `margin: 0` and only gains `margin-top: 16px` via `#status:not(:empty)` (`:290`) — preserve that pattern; do not add a fixed `min-height`.
- `.mfa-page [hidden] { display: none !important; }` (`:23`) governs `#recoveryToggle`; do not add a competing `display` rule that would need higher specificity.

---

## 6. Latent defects found while auditing (report only, decide in planning)

1. **Dead status styling.** The late block styles `.mfa-status.is-error` (`:529`) and `.mfa-status.is-success` (`:535`), but **no element carries `mfa-status`** and `mfa.js` never adds it — it only writes `mfaStatus.textContent` (`mfa.js:21,115,162,170`). Real status styling comes from `#status` (`:282`, `color: #ba1a1a`, 14px) which has no background/border. Either wire `.mfa-status` onto `#status` in `mfa.js`, or delete the two dead rules. Leaving both is the current confusing state; R2 should resolve it one way while touching this file.
2. **Dead `.vault-gradient` on the submit.** `mfa.html:47` still has `class="mfa-submit vault-gradient"`; `.mfa-submit` (`:463`) sets a flat `background: var(--accent)` at equal specificity but later in the cascade, so the gradient never renders. Harmless today, but it is the same decorative-gradient family as R1 — worth removing the class when the admin child addresses gradients, and it must not be "fixed" by editing shared `vaultsso-base.css`.
3. **Three-layer stylesheet.** After R2 it is worth collapsing `1–345` + `395–539` into a single coherent layer rather than appending a fourth override block; otherwise the same "chrome retuned, content scale forgotten" drift recurs.
4. **Stale asset query.** `mfa.html:9` uses `?v=20260930-mfa-1`; `mfa.html:57` i18n `?v=20260930-mfa-1`; `mfa.html:58` mfa.js `?v=20261001-mfa-2`. Any CSS change must bump the `vaultsso-mfa.css` query so cached CSS cannot keep the old proportions.

---

## 7. Test implications

### Assertions that break or become insufficient

- `tests/password-mfa-browser.cjs:204` asserts `Filling a code must not automatically sign in` (HTTP 401 after a simulated autofill). This is the R3 contract; it must be rewritten alongside the spec line `.trellis/spec/frontend/auth-feedback.md:19` ("filling a code never submits automatically"). This is R3 ownership, flagged here because the same test run covers R2 screenshots.
- `:167–177` types `123456`, backspaces, then re-types — under auto-verify a complete 6-digit value submits mid-sequence, so this editing sequence must be moved to a sub-6-digit value (e.g. `12345`) or run with auto-verify disabled.
- `:173` `fill('123456')` and `:240` `fill('123456')` will both trigger auto-submission; they must assert navigation instead of relying on the later explicit `#submit` click at `:205`/`:241`.
- `:185` and `:222` already assert `scrollWidth <= innerWidth` at 320px — keep, but they do not measure proportion.

### New metrics required to actually prove AC2

Overflow assertions alone cannot pass/fail a proportion requirement. Add explicit geometry assertions via `getBoundingClientRect()`:

1. **Slot aspect** at 1440 / 390 / 320: `slotWidth / slotHeight` (width ÷ height, so 1.0 = square) within `0.75–1.35` (currently 0.64 / 0.73 / 0.55 — all below 1.0, i.e. taller than wide).
2. **Entry-to-action ratio**: `codeEntry.height / submit.height` within `1.0–1.6` (currently 2.5 / 2.0).
3. **Recovery mode**: with `is-recovery`, `codeEntry.height <= 44` and `#code` scrollHeight fits without clipping (currently 80/64).
4. **No vertical clipping at 320×740**: `documentElement.scrollHeight` and all of card/intro/entry/submit/actions within the card's client box.
5. **Language parity**: run each geometry assertion under `zh`, `zh-TW`, `en` (the longest strings are `en` — "Two-Step Verification" / "Verify and Sign In" — while `zh-TW` has the widest recovery labels) and assert the h1 does not wrap into 3+ lines.

   For `#instructions`, do **not** assert a fixed 2.6em box. It uses `min-height`, which is a floor that permits natural text growth, so the acceptance must be: (a) the rendered box height is **at least** 2.6em, and (b) `scrollHeight <= clientHeight` — i.e. the text is not clipped and the element grew to fit rather than being constrained. Long `en`/`zh-TW` hints are expected to make the element taller; that must be recorded as correct, not as a failure. The card is free to grow vertically with the hint (see metric 4 for the only real clipping gate).
6. **Screenshots**: keep `login-totp-empty-*`, `login-totp-english-*`, `login-totp-narrow-320.png`, `login-totp-page-*` (recovery) as before/after evidence for AC5; add an explicit recovery-mode desktop capture since `login-totp-page-*` currently doubles as both.

### Commands

- `node --check public/js/pages/auth/mfa.js` and `node --check public/js/shared/i18n.js` if either changes.
- `node --test tests/password-mfa.test.js`
- `node --test tests/huawei-native-mfa.test.js`
- `node tests/password-mfa-browser.cjs` (Playwright; the only R2 visual/geometry gate).
- `npm run check:browser` for regression on login/admin/profile.

---

## 8. Recommendation summary

1. Fix R2 by **replacing the content scale in the late override block**, not by appending a fourth layer: h1 30/26 → 20/18, entry 80/64 → 48/44, slot + `#code` font 20/26 → 18, `#instructions` 15px/`min-height` 48px → 13px/`min-height` 2.6em (a floor that still grows with the text), entry margin-bottom → 20px, submit → 36px, actions → 16px / 32px.
2. Give recovery mode its own height (`40px`) so one text field is not drawn in an 80px box.
3. Remove the media-query/late-block conflicts deliberately — either delete the superseded declarations in `347–385` or move the mobile block after `395–539`, so mobile values are not silently overridden.
4. Resolve the dead `.mfa-status.*` rules while in the file.
5. Bump `vaultsso-mfa.css?v=` in `mfa.html:9`.
6. Do not touch `vaultsso-base.css`; MFA is isolated, login/admin remain the sibling scale reference.
