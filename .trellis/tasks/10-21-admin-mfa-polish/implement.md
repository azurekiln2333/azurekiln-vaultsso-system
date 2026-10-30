# Integrated execution plan

## Planning and activation

- [x] Create parent and two child tasks with the user's planning consent.
- [x] Record user requirements and independently verifiable child acceptance criteria.
- [x] Complete the four read-only research reports and review actual baseline screenshots.
- [x] Reconcile the final PRDs/designs/plans with research and curate both manifests per task.
- [x] Validate all three task artifact/context sets.
- [x] Present the final planning summary and receive subsequent implementation approval: user said "分派任务下去立马做" on 2026-10-21.

## Implementation after approval

1. Recheck the dirty baseline. Create a new appropriate branch in this same workspace from the current approved baseline; record branch/base metadata without staging unrelated files.
2. Activate each child before its implementation dispatch. Reuse existing Herdr Pi panes with explicit IDs and disjoint file ownership; no extra worktrees or replacement agents.
3. Admin implementer owns admin shell/content CSS and any strictly necessary admin markup/cache references.
4. MFA presentation implementer owns `public/css/vaultsso-mfa.css` and `views/auth/mfa.html`, including final asset version references coordinated with the behavior implementer.
5. MFA behavior implementer owns `public/js/pages/auth/mfa.js` and affected MFA browser tests. Preserve the single submit/request owner.
6. Independent browser/review worker verifies delivered visuals and critical interaction paths. Main session reconciles the updated spec contract and integration findings.

## Validation

- Compare before/after admin shell, overview, users/clients table and a representative form at 1440px and 390px; add a 360px overflow check. Cover Chinese and English, sidebar/drawer states, and embedded/direct page surfaces.
- Compare MFA TOTP/email/recovery at desktop and narrow mobile widths in Chinese and English. Measure title, code row, button, and gaps. Inspect actual screenshots, focus/error states, and overflow.
- Exercise incomplete entry, typed sixth digit, whole-code paste, `input`/`change` autofill simulation, duplicate events, manual fallback, invalid retry, same-code re-entry, request locking, recovery mode, mode/language changes, terminal errors, and successful same-origin continuation.
- Run `npm run check:syntax`, `node --test tests/security.test.js tests/password-mfa.test.js`, and affected browser suites including `tests/password-mfa-browser.cjs` and `tests/multi-authenticator-browser.cjs`.
- Run `npm run check:browser` once after integration, addressing actual failures without redundant reruns after a clean pass. Use only isolated fixtures; no real database/mail interactions.
- Record commands, results, screenshot paths, and any limits in task validation artifacts. Do not count prior task passes as current verification.

## Finish

- Independently review child acceptance and parent integration before marking anything complete.
- Capture the changed MFA completion contract and CSS cascade lesson in applicable specs.
- Present a concrete conventional-commit file/message plan under the repository's commit gate; do not commit unrelated scaffolding.
- After approved commits, archive completed children and parent and record the developer session using Trellis finish-work.

## Execution status — 2026-10-21

- [x] Existing four Pi panes dispatched with separate file ownership; implementations and independent browser review complete.
- [x] Both child acceptance reviews and the parent integration review pass; see the three `validation.md` files and parent `review.md`.
- [x] Final browser aggregate passes all six suites; security/MFA unit tests pass 43/43; syntax passes for 97 files; diff whitespace check passes.
- [x] Surface/completion specs include the cascade and TOTP-fixture lessons.
- [x] Concrete conventional commit grouping and exact file lists prepared in `commit-plan.md`; unrelated workspace files excluded.
- [ ] Obtain the Phase 3.4 one-shot commit-plan confirmation and execute the two scoped work commits.
- [ ] Archive children then parent and record the session after the work commits.
