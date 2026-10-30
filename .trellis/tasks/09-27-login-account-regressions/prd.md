# Login verification and account edit regressions

## Goal

Fix phone self-edit sessions, version profile assets, trust local proxy addresses and move login second factors to a dedicated page

## Requirements

- Administrator phone edits persist, including own account edits, without unexpectedly ending the active session.
- Profile phone editing opens and saves with current assets.
- Baota/Nginx localhost proxy supplies the real client IP, with explicit proxy trust.
- Login initially shows credentials; CAPTCHA appears only after a login attempt requiring it.
- Password-authenticated email and authenticator verification use a separate page, preserving OAuth parameters.
- Existing Huawei bindings and translated bottom feedback remain functional.
- Business CSS and JavaScript live in separate `public/css` and `public/js` directories. Font/icon assets stay in `public/assets` and are excluded from deployment packages.
- A successful phone SQL response without the requested persisted phone must report a save failure.

## Acceptance Criteria

- [x] Actual self-edit admin form save/reload and profile edit browser tests pass.
- [x] MFA rejects incorrect, expired, replayed and invalidated challenges without authenticating.
- [x] Local proxy headers resolve client IP; untrusted spoofed headers do not.
- [x] Desktop/mobile CAPTCHA and dedicated verification flows pass.

## Notes

- 2026-09-28 follow-up: the original root ZIP omitted all assets, including required phone page scripts and modal styles. Corrected packaging now validates archived core references and intentionally excludes separately deployed font/icon resources. Live deployment usage of the original archive was not verified.
- 2026-09-28 source verification: npm run check passed 142 tests and 76 syntax/reference checks; all four browser suites passed after CSS/JS migration. Phone browser regression additionally covers failed save retaining the modal and explicit admin phone request fields. Phone API covers silent SQL non-writes, failed unbind and stale generated E.164. Real MySQL and production remain unverified.

- Final verification: npm run check passed 128 tests and syntax/reference checks for 72 files; npm run check:browser passed all four suites, including real OAuth nonce/state/PKCE with 2048 percent characters in state.
- Independent review fixed hidden unbind CSS, missing browser nonce inputs and oversized pending cookies. Schema v5 persists continuation as nullable JSON; update deployment with npm run init-db before restart.
- Profile Huawei identifier labels now match UnionID-primary/OpenID-secondary storage and are browser-tested.
- .env explicitly trusts localhost proxy IPs; README includes Baota/Nginx header configuration. Actual remote deployment was not accessed; historical localhost IPs cannot be reconstructed.
- npm run check:config remains blocked by an existing placeholder JWT_SECRET. No deployment secrets changed, no commits or production migration performed.

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
