# MFA execution plan

## Preconditions and ownership

- Wait for explicit approval of the parent final planning summary and activate this child before implementation.
- Load both manifests, this PRD/design, and the parent research notes.
- Reuse Pi `w1Q:p4` for MFA CSS/markup and `w1Q:p5` for MFA JS/tests, with disjoint ownership. They share this workspace and must preserve each other's changes. Pi `w1Q:p6` reviews browser evidence. No lifecycle/git operations by workers.

## Ordered work

1. Consolidate `public/css/vaultsso-mfa.css` around the agreed compact scale and following mobile rules. Keep recognizable input/slot markup, accessible status, focus and recovery behavior. Update `views/auth/mfa.html` only as needed for scoped hooks, dead class removal, and coordinated asset versions.
2. Add completion triggering in `public/js/pages/auth/mfa.js` through the existing submit path; guard composition, incomplete/recovery/disabled/pending/navigation states and duplicate complete notifications. Preserve fresh retries and all redirect/error guards.
3. Update `tests/password-mfa-browser.cjs` and the login helper in `tests/multi-authenticator-browser.cjs` for automatic TOTP/email completion and manual recovery. Keep native editing tests below six digits to avoid unintended submissions.
4. Add focused observable checks for incomplete input, typed completion, paste, input/change autofill simulation, pending duplicate/manual attempts, invalid-code correction and same-code retry, mode/language behavior, recovery, and terminal errors. Hold/release an intercepted request explicitly for locking checks; do not depend on timing or try to click a disabled control through Playwright actionability waits.
5. Reconcile `.trellis/spec/frontend/auth-feedback.md` with the new user-requested contract. Bump the changed CSS/JS asset versions and verify selectors, field names, and autocomplete behavior remain intact.

## Acceptance and verification

- Capture and inspect TOTP/email/recovery before/after at 1440px and 390px; check 320px/360px overflow and Chinese/Traditional Chinese/English wrapping. Keep instructions and feedback free to wrap.
- Measure the intended 48px/44px entry, 36px primary action, 40px recovery input and smaller heading. Check that slot width/height is roughly 0.75-1.35 and code-entry/action height is 1.0-1.6 at target widths; use these as proportion evidence alongside screenshots, not as the sole aesthetic verdict.
- `npm run check:syntax`
- `node --test tests/security.test.js tests/password-mfa.test.js`
- `node tests/password-mfa-browser.cjs`
- `node tests/multi-authenticator-browser.cjs`
- Parent integration runs `npm run check:browser` once; run any extra affected checks only for an actual uncovered change or failure.
- Use isolated fixtures, no real users/database/mail. Report simulated autofill accurately; it is not an unlocked real password-manager extension test.

## Review and rollback

The independent reviewer checks the visible proportions, successful continuation, no redirect on error, exactly one pending attempt, and preserved recovery/terminal behavior. Record results in `validation.md` and notify the parent. Do not archive or commit from a worker. Revert this child's product/spec/test changes together if a material regression cannot be resolved.
