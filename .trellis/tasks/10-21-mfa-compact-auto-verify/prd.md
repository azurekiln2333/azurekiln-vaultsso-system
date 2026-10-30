# Compact MFA code entry and auto-verify

## Goal

Deliver parent requirements R2-R4: make MFA code entry proportionate and automatically verify completed six-digit codes before continuing authentication.

## Requirements

- Rebalance the MFA title, code entry, card spacing, and action sizes across desktop/mobile and the existing Chinese/Traditional Chinese/English locales.
- Preserve one real accessible input, normal selection/editing/paste, autocomplete recognition, and six decorative visual slots.
- Automatically attempt verification after typing, paste, or autofill supplies a complete six-digit authenticator or email code.
- Reuse the existing submit/error/navigation flow; prevent duplicate requests from paired events or concurrent automatic/manual submission.
- Navigate only on successful verification and retain the existing same-origin redirect validation.
- Leave recovery codes manually submitted and retain the manual verify button, error feedback, retries, mode changes, and terminal-error handling.
- Update the old no-auto-submit spec/test contract alongside the implementation.

## Evidence

- `public/css/vaultsso-mfa.css:163` retains an 80px desktop row; `:395` begins a late compact override that never resets that row, its oversized gap or heading. Recovery input at `:230` inherits the same row height.
- `public/js/pages/auth/mfa.js:36`, `:110`, and `:142` define normalization, the existing request/redirect owner, and input/change binding.
- `.trellis/spec/frontend/auth-feedback.md:19` and `tests/password-mfa-browser.cjs:204` encode the superseded no-auto-submit expectation. Parent `research/mfa-layout.md` and `research/mfa-auto-verify.md` contain the source/test mapping.

## Acceptance criteria

- [x] Code rows are 48px desktop/44px mobile, headings 20px/18px, the primary action at least 36px, and the recovery field 40px; all supported localized text and status wrap naturally without clipping or overflow at desktop, 390px and 320px widths.
- [x] Incomplete codes do not submit. Typed, pasted, and autofilled complete codes automatically attempt once per completed edit.
- [x] A pending request blocks duplicate events/manual submission; invalid codes do not navigate and can be corrected and retried.
- [x] A successful code follows the existing authenticated continuation. Recovery codes remain manual; language/mode changes do not accidentally verify.
- [x] Targeted browser tests cover automatic completion, failed retry, recovery mode, and request locking; existing authentication security checks pass.

## Constraints and exclusions

- Parent: `10-21-admin-mfa-polish`; implementation can proceed independently of the admin child after parent planning approval.
- No backend, API payload, MFA policy, database, or redirect trust changes.
- The user approved the parent final planning summary on 2026-10-21 and instructed immediate implementation.
