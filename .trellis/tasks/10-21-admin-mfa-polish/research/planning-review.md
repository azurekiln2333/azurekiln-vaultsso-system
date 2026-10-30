# Planning review and reconciled decisions

## Visual review

The main session inspected the current `admin-overview-users-zh-desktop-1280.png`, `mfa-totp-zh-desktop-1280.png`, and `mfa-recovery-en-mobile-390.png` under `.artifacts/admin-mfa-polish/baseline/`.

The blue admin content gradient, tall narrow code slots, oversized MFA heading/vertical gaps, and tall recovery text field are visible. These screenshots establish the current defects; they are not acceptance evidence for an implementation that has not begun.

The sampled admin header still shows its loading label. Final after-captures must wait for deterministic account/page initialization and disclose any residual capture limit. This does not invalidate the measured page background or MFA geometry.

## Research clarifications

- The selector `html[data-admin-shell] body.vaultsso-page-surface` has specificity `(0,2,2)`; it exceeds the shared class rule `(0,1,0)`. The admin note's smaller specificity count is a counting error, not a different precedence outcome.
- Removing all shared classes from both documents would remove that gradient source, but would leave the intended canvas unspecified. The selected design explicitly paints both documents and the iframe with the neutral token; it does not depend on transparency/default body paint.
- Existing compact controls already fit the reference. Panel radius/elevation alignment is a design choice: prefer existing 12px panel tokens and minimal/no panel shadow, without adopting the reference's new inset workspace structure.
- The baseline uses one unusually long generated account record. Its 121px row is useful visual evidence, but the baseline author's proposed fixed row/zero-table-scroll assertions are not selected acceptance criteria. Keep full data available, constrain metadata sensibly, and allow container-bounded scrolling for wide tables; do not clip real content to satisfy a numeric row cap.
- Research suggestions are not additional approved scope. Do not promote static CSS-value assertions or the baseline harness into a new persistent test suite solely to mirror declarations. Temporary visual audits plus existing browser checks cover the reversible styling change; persistent behavior tests belong to the new auto-verification flow.
- IME handling must avoid normalization of the live composing value as well as suppressing automatic submission. Synchronize on committed composition end.
- Request-lock tests should hold/release an intercepted request and attempt duplicate events or form submission directly. A Playwright click on a disabled button waits for actionability and is not evidence of concurrent-submit prevention.

## Converged scope

Parent/child PRDs and designs are authoritative: flat admin surfaces and restrained existing-layout polish; compact MFA; event-driven automatic six-digit verification through the existing submit owner; success-only continuation; manual recovery and retries preserved. No backend changes, replacement navigation, public-page redesign or new feature work.

All artifacts remain planning documents. User consent covers task creation/planning and existing-Pi research. A subsequent explicit approval of the final planning summary is still required by `trellis-brainstorm` before task activation or product edits.
