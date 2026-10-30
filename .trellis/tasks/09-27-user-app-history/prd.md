# User application login history

## Goal

Show durable per-account OAuth app history and external app bindings in admin and personal profile

## Requirements

- Administrator can inspect each user's logged-in OAuth applications alongside existing external app bindings.
- Personal profile displays own application usage and detailed Huawei app associations with app-specific OpenID and shared UnionID.
- Application usage survives token expiry/revocation and app deletion; no other user's data or secrets are exposed.
- Failed authentication or unredeemed authorization codes do not create app usage. Existing retained token evidence can populate real past app use without inventing missing history.

## Acceptance Criteria

- [x] Successful OAuth exchange/refresh creates or updates usage; failure and machine grants do not.
- [x] Admin grouping/search and profile own-account listing render real apps and identifiers on desktop/mobile.
- [x] Usage persists after credential revocation and removed app configuration.
- [x] Migration, access controls and API/browser regressions pass.

## Notes

- Completed schema v6 persisted usage and token-evidence backfill, own-account API and admin grouping with OAuth-only users. Both pages show actual application records and per-app Huawei identifiers.
- Final npm run check: 136 tests passed, syntax/reference checks for 74 files. npm run check:browser: all four suites passed, including app scope/search/deleted-app snapshots and delayed responses during phone renewal/unbind.
- Reviewed desktop/mobile screenshots. Long profile display names now wrap instead of causing horizontal overflow. Request revision prevents stale application responses from restoring removed bindings; language changes preserve loading/error state.
- Deployment requires npm run init-db then restart. No real MySQL migration or deployment was performed; existing placeholder JWT_SECRET still prevents production startup locally. Existing discarded tokens cannot reconstruct complete past use.
- Worktree changes preserved; no commit created.

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
