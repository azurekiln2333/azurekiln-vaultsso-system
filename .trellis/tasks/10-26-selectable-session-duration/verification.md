# Session Duration Verification

## Scope and baseline

- Approved October 26, 2026; task activated after complete planning review.
- Pre-feature working-tree snapshot: `.artifacts/session-duration/baseline/manifest.json` (83 files), with original Git status, index diff and working-tree diff.
- Preserve all previous account/MFA/UI and SMTP changes. Review this feature against the saved baseline, not the repository's already-dirty HEAD alone.
- Local runtime: Node.js v24.15.0. API fixtures use in-memory storage and captured mail; browser/provider fixtures are local. No live deployment, real elapsed-day wait or production MySQL verification is claimed.

## Acceptance evidence

| Criterion | Evidence | Status |
| --- | --- | --- |
| AC1: selector/default, account flow, locales and mobile fit | New session-duration browser regression, three existing authentication browser suites, 12 inspected desktop/phone images in all locales | Passed |
| AC2: matching fixed expiry, beyond 1h/12h | Controlled-clock API regression inspecting JWT/row/cookie for 1/7/14 days and access after 2h/13h | Passed |
| AC3: exact expiry and no revival | Independent credential/row expiry, malformed-claim and activity checks | Passed |
| AC4: saved choices across factors/providers, ignored overrides | Session/MFA/mailbox/OIDC/Huawei API and browser regressions, including successor stages and native no-cookie handoff | Passed |
| AC5: strict/missing input and legacy compatibility | JSON versus form/query input matrix, duplicates, defaults, old pending, legacy renewal/rotation checks | Passed |
| AC6: immediate revocation | 14-day-session logout, other-session revoke, password reset and ban checks | Passed |
| AC7: token/proof lifetimes independent | One-hour access, seven-day refresh, unchanged email-code and original pending-proof TTL assertions | Passed |
| AC8: original deadline across replacement | Fixed phone/password/email and OIDC link replacements; repeated legacy cap checks; existing recent-auth restrictions | Passed |
| AC9: relevant checks, final review and isolated scope | Required API/browser/syntax/full API checks, Trellis full-scope review and baseline delta audit | Passed |

## Verification runs

| Command | Result |
| --- | --- |
| Required ten-suite targeted `node --test` command in `implement.md` | 234 passed, zero failed/skipped/cancelled |
| Focused Huawei invalid-duration regression after final JSON-string assertion | 1 passed |
| `node tests/session-duration-browser.cjs` | Passed; real duration requests, original MFA choices, fixed/persistent cookies and three-language desktop/phone UI |
| `node tests/account-first-login-browser.cjs` | Passed |
| `node tests/password-mfa-browser.cjs` | Passed |
| `node tests/login-email-gate-browser.cjs` | Passed |
| `node --test tests/i18n.test.js` | 21 passed; also included in targeted/full API runs |
| `npm run check:syntax` | Passed; final backend/reviewer runs cover 108 files and browser script references |
| `git diff --check` | Passed |
| `npm run check:e2e` | 328 passed, zero failed/skipped/cancelled, exit 0; 152.6 seconds; log `.artifacts/session-duration/check-e2e.log` |

The project has no separately configured linter or TypeScript checker. Native Date mocking advances both Date APIs while leaving HTTP timers real. Review resolved the JSON numeric-string boundary: only form/query transport permits exact strings. No unresolved implementation findings remain.

Detailed evidence: `research/backend-implementation.md`, `research/frontend-implementation.md`, and `research/final-review.md`. All twelve UI screenshots are under `.artifacts/session-duration/`; workers inspected all images and main/reviewer independently opened representative combinations.

## Delivery

Implementation, local verification, full-scope review and spec synchronization are complete. No deployment or database migration was performed; this feature needs no migration.

Feature-only review artifact: `.artifacts/session-duration/feature.patch`, with a 30-file delta summary in `feature-files.json`. The prior 83-file baseline is preserved. The real Git index remains unchanged and nothing has been staged or committed.

Commit preflight used a separate scratch index and proved that this feature's baseline-relative patch cannot be applied directly to current HEAD: it depends on pre-existing uncommitted account/MFA changes in server/login/package/templates and previously untracked specs. Details: `.artifacts/session-duration/commit-preflight.txt`. A whole-file commit would silently include those older changes. Therefore commit/archive is pending the repository's Phase 3.4 reviewed commit decision; the complete implementation remains in the working tree.
