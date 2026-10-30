# Icon font loading — independent integration check

Reviewer: `/root/check_user_sort` (`trellis-check`). Task: `10-23-account-first-login`.
Authority: `research/icon-font-loading-contract.md` and the pre-follow-up snapshots in
`research/icon-font-loading-baseline.json` (`icon-font-loading-followup-l7koh7st`).

Status: **final independent review clean — the confirmed profile-overlay regression is corrected
and revalidated**. Documentation review is complete. No product/test files were edited by this
reviewer. Root owns final aggregate execution and evidence.

## Findings (fixed)

- `views/account/profile.html:45`, `public/css/vaultsso-base.css:77`: the existing
  `.profile-avatar-edit.material-symbols-outlined` element is both the full-avatar structural hover
  overlay and the glyph. New global `inline-size/block-size: 1em` overrides its former automatic
  inset-based dimensions, shrinking it to the upper-left 24px square. The profile CSS does not set
  explicit width/height on this overlay, unlike the separate profile heading/session icon badges.
  Real authenticated `/profile` baseline/current comparison confirms desktop 88x88 -> 24x24 and
  mobile 62x62 -> 24x24; CSS zoom 2 yields 176/124 -> 48. White color, 24px size and variations are
  unchanged, but the hover background and centered camera regress. Screenshots confirm the effect.
  Root coordinated the owner correction: `.profile-avatar-edit` now remains the full-area grid
  overlay, with `.material-symbols-outlined` on a nested glyph. Original hover, centering and outer
  `aria-hidden="true"` semantics are preserved; no profile CSS or shared-gate exception was added.
  Added real profile hover/focus/click coverage at 1440/390 and CSS zoom 1/2 before and after actual
  font success confirms matching overlay/avatar bounds and centered 24/48px glyphs. Final focused
  evidence and inspected screenshots close this finding. Reviewer did not edit frozen product/tests.

## Findings (not fixed)

None. No unresolved product, test or documentation issue remains in the reviewed R18 delta.

## Documentation and contract review

Read the new seven-section `.trellis/spec/frontend/icon-font-loading.md`, its frontend index entry,
the new section of `.trellis/spec/frontend/surface-guidelines.md`, and the updated task contract.
The index and surface guide link to the same actual spec with correct relative paths. Earlier
surface requirements for admin iframes, asset caches, mobile CAPTCHA and visual evidence are retained.

At the contract level, the documentation consistently requires:

- A shared default-hidden icon slot that preserves compact geometry and visible ordinary labels,
  with packaged CSS independent of the separately supplied font stylesheet.
- A document-local gate based on the explicitly requested Material Symbols face successfully
  loading, including a nonempty result and loaded faces; global readiness alone, an empty result,
  a failed font request and unavailable APIs cannot reveal English ligatures.
- CSS-inherited behavior for runtime-generated icons, independent shell/iframe document readiness,
  no per-icon observer, no timeout reveal and no persistent retry loop.
- Existing icon sizes/colors/variations and accessible control names to remain usable, without an
  unrelated icon-library, authentication or page-layout rewrite.
- External deferred CSP-compatible helper references and synchronized affected asset versions in
  all 13 templates, while retaining the deployment exclusion of generated `/assets` fonts.
- Real delayed/rejected/cached font transport evidence, desktop/mobile geometry and label checks,
  actual loaded glyphs and dynamic icons, docs and admin integration, and inspected screenshots.

The two earlier evidence refinements are now explicit in both the contract and spec: exercise an
absent stylesheet/face so empty `load()` success cannot be mistaken for a loaded font; separately
attribute unavailable-FontFaceSet coverage as a controlled simulation. These close the previously
noted evidence omissions without changing product scope.

The frozen source review below traces the spec's exact CSS selector, helper path, `fonts.load()`
arguments and template coverage. The documentation remains consistent with the agreed contract;
the initial overlay drift from the retained-layout requirement is corrected as recorded above.

## Frozen source delta

Verified all 15 saved snapshot hashes, then compared every manifest file with the exact baseline.
The base CSS adds the default-hidden, clipped, nonshrinking one-em glyph slot and a document-root
ready selector; existing variation settings are preserved. The new external helper requests
`24px "Material Symbols Outlined"` with `person` once and requires a nonempty array whose faces
are all loaded before setting the ready class. Missing/nonfunction API returns safely, and rejected
or malformed results cannot escape the catch or reveal icons. No timeout, global-ready shortcut,
polling or observer is present. Existing per-page font sizes, colors and explicit badge dimensions
retain precedence. The corrected avatar markup separates its implicit-size structural overlay
from the constrained inner glyph, preserving both the original layout and the shared loading gate.

All 13 templates contain exactly one matching `20261025-icon-font-1` base-CSS reference and one
external deferred helper. Their other deltas are the error help link's `Help` label/title and the
reviewed avatar overlay/glyph separation. The link retains its icon-only accessible name and the
avatar retains the named parent button and decorative subtree. Existing page scripts, cache versions
and handlers are otherwise unchanged. The package script adds the focused test as group 11 after
the original ten.
The production CSP permits same-origin external scripts and fonts; no inline script or new origin
was added. The unchanged packager includes `public/css`/`public/js` and intentionally excludes
`public/assets`, so the critical gate is packaged independently of optional external font assets.

## Focused test and artifact review

Read the owner implementation report, final `browser-focused.log`, complete focused test and
`browser-evidence.json`. The final owner run passed. The test holds the actual WOFF2 response for
4100ms at 1440/390, captures the pending state through CDP without waiting on font readiness, then
releases actual bytes. Before release, visible label actions and account Continue work and icons
remain hidden/compact; afterwards actual loaded faces and glyph-family/visibility are checked.
Dynamic icons are inserted both before and after readiness. Real rejection stays hidden even when
`document.fonts.ready` completes. The helper is not replaced in these transport scenarios.

Unrouted docs navigation exercises immediate and real warm caching, including nonzero decoded
font bytes with transferSize 0. Authenticated admin shell and users iframe independently assert
hidden/revealed state and open the real import action. Separate disclosed API/stylesheet scenarios
cover `[]`, missing API and failed stylesheet; none incorrectly gains the ready class. Existing
loaded global font faces in the empty-array scenario do not override the target-load result.

The initial focused suite lacked profile avatar coverage, which explained the uncovered regression.
The final frozen test adds two real authenticated profile scenarios. Each holds the actual font
request while performing hover, native keyboard `:focus-visible` and click-to-open-modal at CSS
zoom 1/2, then releases the request and repeats those interactions with loaded glyphs. Assertions
compare x/y/width/height of avatar and overlay, both glyph centers, glyph visibility, overlay
opacity and decorative ARIA. Final evidence records desktop 88/176px and mobile 62/124px matching
overlay/avatar squares, with centered 24/48px glyphs in every hidden/loaded hover/focus state.
The real zoomed avatar click is proven before cleanup restores zoom 1 to close the existing modal.
This clearly scoped cleanup does not claim a zoomed-modal layout fix or broader modal coverage.

Reviewer inspected failed mobile login, delayed mobile admin and warm mobile docs screenshots:
no fallback icon names are painted, ordinary labels/actions remain visible, and the loaded dynamic
docs glyph renders. The owner/root already inspected delayed/loaded login and loaded admin images.
The reviewer also captured and inspected mobile profile baseline/current hover screenshots, which
show the original full-area versus regressed upper-left-square difference. After the owner fix,
reviewer inspected the new hidden/loaded mobile zoom-1 and loaded desktop zoom-2 profile images:
the full hover overlay and centered camera are restored, and the pending glyph stays invisible.

`docs-baseline-probe.json` records scrollWidth 453 / overflow 63px at 390px for both saved baseline
and current CSS, with 16px icon widths. This existing documentation width is not an R18 regression;
the scoped test appropriately keeps strict login/admin overflow checks without broadening into an
unrelated docs-layout fix.

Reviewer narrow artifacts: `.artifacts/icon-font-loading/avatar-overlay-review.json` and
`avatar-overlay-{baseline,current}-390.png`. The comparison used real isolated authenticated
profile pages, the saved baseline/current CSS, actual successful font loading and CSS zoom 1/2.
It did not rerun the focused suite or aggregate, and touched no live accounts or production data.
Those initial regression artifacts are retained as historical evidence, not final-state screenshots.
Final corrected profile evidence is in `browser-evidence.json` plus the eight
`profile-avatar-{hidden,visible}-{1440,390}-zoom-{1,2}.png` screenshots. The reviewer only read the
correction delta and new evidence after the second freeze; no baseline/current probe was repeated.

## Verification

- Documentation/contract consistency review: pass.
- Reviewer `node --check`: new helper and focused browser test both pass.
- Baseline integrity and all-13-template reference inventory: pass.
- Owner final focused browser: pass after the correction, including real profile hover/focus/click
  and zoom 1/2; final source/evidence review clean.
- Reviewer narrow profile baseline/current probe: confirmed the original regression; corrected
  product and additional owner evidence close it without repeating that probe.
- Root-reported initial syntax 106 files and deployment package tests 4/4: pass. Fresh root syntax,
  all-11-group browser and packaging reruns after correction remain root-owned and in progress.
- The first root browser aggregate stopped at an unchanged account-bindings status wait before
  R18. Preserve that separate log as historical evidence; no final complete aggregate pass is
  claimed by this report until root records it.
- Lint/TypeCheck: no standalone project scripts configured. No duplicate aggregate/focused run.
- No product/test mutations, stage, commit, reset/stash, push, deployment or archive.
