# Journal - lichengyu (Part 1)

> AI development session journal
> Started: 2026-09-23

---



## Session 1: OAuth2 login details cleanup
<!-- trellis-session: v=2 fp=dd219d2d8861a39c -->

**Date**: 2026-10-21
**Task**: OAuth2 login details cleanup
**Branch**: `style/oauth-login-cleanup`

### Summary

Removed the login authorization details card using four existing Pi agents in one Herdr workspace; preserved OAuth hidden fields and MFA continuation, validated desktop/mobile rendering, and committed the approved scope.

### Main Changes

- Removed callback URI, scope chips, redundant return-to-application copy, and repeated client name from the login page.
- Removed card-only JavaScript, styles, and translations; refreshed the page asset versions.

### Git Commits

| Hash | Message |
|------|---------|
| `5dec2129b5a278a8c329ccd12a6fefe0a7b8e663` | style(auth): simplify OAuth2 login page |

### Testing

- [OK] Syntax and browser script references: 97 files passed; i18n: 9 tests passed; authentication/security: 43 tests passed.
- [OK] Existing password/MFA browser suite and 18 direct/OAuth viewport/language combinations passed; screenshots reviewed.

### Status

[OK] **Completed**


## Session 2: Login account chooser and admin phone verification
<!-- trellis-session: v=2 fp=183e031005dfb317 -->

**Date**: 2026-11-23
**Task**: Login account chooser and admin phone verification
**Branch**: `main`

### Summary

Implemented and verified browser account list/add/switch/remove and administrator phone verification; user approved work commit and Trellis completion.

### Main Changes

- Added a bounded signed HttpOnly browser roster; account selection preserves the original session and expiry. Added three-locale desktop/mobile chooser UI.
- Added administrator Phone verified checkbox with saved timestamps, phone-change reset and atomic stale-number guard returning 409.
- Updated executable specs and archived 11-23-login-account-chooser. Original Pi workers shared the checkout; backend handoff and final test takeover are recorded in the archive.

### Git Commits

| Hash | Message |
|------|---------|
| `12cdee4bf40f4455c225e8701ed162c2502c7d52` | feat(auth): add browser account chooser and admin phone verification |

### Testing

- [OK] npm run check: 452 tests, 450 passed, 2 skipped, 0 failed. Phone API: 21/21. Final account API: 16/16. Final account browser: all four stages passed.
- [OK] Account bindings, session duration, account-first login and auth feedback browser regressions passed; desktop/mobile screenshots inspected; syntax and diff checks passed.

### Status

[OK] **Completed**

### Next Steps

- Changes are committed locally. Push and deployment were not requested. Unrelated compliance tasks and docs remain untouched.
