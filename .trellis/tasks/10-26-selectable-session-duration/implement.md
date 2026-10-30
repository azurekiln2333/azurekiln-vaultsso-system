# Selectable Login Session Duration: Execution Plan

## Preconditions

- [x] User approved task creation and confirmed default 1 day, optional 7/14 days, fixed expiry.
- [x] Root cause and existing issuance/continuation owners inspected.
- [x] Final planning package reviewed and explicitly approved after its presentation (user: “继续”, October 26, 2026).
- [x] `implement.jsonl` and `check.jsonl` validated with real spec/research entries (8 implementation entries, 8 final check entries including the new session contract).
- [x] Task activated with `task.py start` after final review (October 26, 2026).

All implementation/check dispatches start with `Active task: .trellis/tasks/10-26-selectable-session-duration`. Use native Codex Trellis context injection, with child-side context loading only as a fallback. Tell workers they share a dirty workspace and must preserve others' changes.

## Ordered Work

1. Record a scoped pre-change snapshot/diff of the target files so the feature can be reviewed independently of existing account/MFA/UI and SMTP edits. Read the task artifacts and applicable specs. Do not reset or stage unrelated work.
2. Implement the server-owned input whitelist and normalized fixed/legacy session policy. Route both durable issuance functions through it. Keep access/refresh-token and pending-proof TTLs independent. Add focused controlled-clock API regressions for all three duration choices, invalid/missing values, and immediate revocation. (R2, R4-R6; AC2, AC3, AC5-AC7)
3. Preserve the validated current policy through profile-triggered replacements and OIDC linking, including the original legacy cap when a row is replaced. Keep transaction-bound connection usage and current-session retention semantics intact. Add repeated-replacement and legacy-rotation regressions. (R8; AC8)
4. Carry the normalized initial choice through password/TOTP/recovery/email/mailbox pending contexts, successor stages, OIDC signed state, and Huawei binding/MFA continuation. Prove that completion-body overrides cannot replace it and that native OAuth handoff still issues no gateway cookie. (R3; AC4)
5. Add the accessible 1/7/14-day selector, three-language strings, and local external-provider link propagation. Reuse existing control styling and form serialization. Update affected asset versions and include the browser regression in the current browser-check script. (R1, R7; AC1)
6. Run the targeted checks below, then the full API check. Inspect real desktop/phone screenshots and resolve any fit or localization failures. Update the plan only if evidence requires an approved scope change. (AC9)
7. Dispatch the Trellis check agent over the entire final feature diff, not just the last fix. Have it verify each PRD criterion, replacement edge, and changed source/fixture contract. Fix findings and rerun only the affected checks. (AC1-AC9)
8. Capture the verified session contract in the backend spec and relevant frontend/spec indexes, and clarify configuration/readme documentation. Review final diff, record validation and remaining local-environment limits, then perform the repository's finish/commit workflow within the authorized scope.

## Dispatch Ownership

- Server implementation owns session policy, issuance/replacement, continuation, and the corresponding API regression changes. It must coordinate any shared localization strings with the frontend owner.
- Frontend implementation owns the selector, client propagation, required styles, labels, templates/cache versions, browser regression, and browser-check script update.
- Main session coordinates shared-file ownership and integration, preserves task/spec artifacts, and handles final review/finish. Run dependent server and frontend changes in a coordinated sequence if parallel writes would overlap.
- The check agent reviews the full implementation against the PRD/design and fixes only verified issues within the task scope.

## Required Verification

Run commands from the repository root, using isolated fixtures only:

```text
node --test tests/session-duration.test.js tests/security.test.js tests/phone-api.test.js tests/multi-authenticator.test.js tests/password-mfa.test.js tests/login-email-gate.test.js tests/oidc.test.js tests/huawei.test.js tests/huawei-native-mfa.test.js tests/i18n.test.js
node tests/session-duration-browser.cjs
node tests/account-first-login-browser.cjs
node tests/password-mfa-browser.cjs
node tests/login-email-gate-browser.cjs
npm run check:syntax
npm run check:e2e
```

The exact new test filenames are part of the implementation boundary; extend an existing fixture-bearing suite instead when it proves a continuation path with less duplicate setup. Adapt the targeted command accordingly and record the actual run. Do not add tests that merely repeat CSS declarations or function internals.

Browser evidence: show actual selection/submission, account-step and locale retention, provider URL updates, MFA completion with the original selected duration, and cookie persistence across a fresh browser context using the saved persistent cookie. Capture desktop and phone forms in all supported languages under `.artifacts/session-duration/` and inspect the rendered images.

Clock evidence: mock Date consistently; advance beyond 1 hour and 12 hours while still inside the selected period, then to/beyond the fixed deadline. Assert successful requests do not shift it and expiration/revocation cannot revive it. Preserve real HTTP timers and restore Date in cleanup.

## Review Gates and Rollback

- Planning gate: PRD, design, this plan, completed research, and validated manifests must all be ready before activation. Existing product-choice approval does not substitute for presenting this complete package under the current workflow.
- Implementation gate: no pre-verification credential/cookie issuance, no resets of the fixed deadline, no completion-body duration override, no automatic upgrade of legacy sessions, and no token/proof TTL widening. Retain the existing external-issuer transaction boundary; do not widen this feature into a general cookie/commit refactor.
- Verification gate: required tests pass; focused browser screenshots are inspected; all PRD criteria have evidence. Do not claim real MySQL/deployment verification from the in-memory fixture.
- Rollback point: preserve a scoped patch of this feature. Revert only this task's introduced hunks if rollback is authorized, keeping pre-existing work. No database migration rollback is needed; warn in the rollout notes that old code may require new long-session users to authenticate again.

## Status

Implementation, verification, final full-scope Trellis review and spec synchronization are complete. All AC1-AC9 passed; see `verification.md` and the three implementation/review research reports. Required targeted APIs passed 234/234, all four required browser suites passed, final syntax covered 108 files, and full APIs passed 328/328. No unresolved review findings remain.

The 83-file pre-feature baseline and 30-file feature delta are retained under `.artifacts/session-duration/`. Nothing has been staged or committed. A scratch-index preflight established that feature-only commits depend on pre-existing uncommitted authentication work, so Phase 3.4 commit/archive remains pending a reviewed decision that explicitly handles those existing changes. Do not silently stage whole shared files or archive before that step.
