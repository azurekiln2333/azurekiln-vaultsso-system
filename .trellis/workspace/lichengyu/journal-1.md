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


## Session 3: Carrier phone authentication merged and released
<!-- trellis-session: v=2 fp=cbfec86488dfdb16 -->

**Date**: 2026-11-25
**Task**: Carrier phone authentication merged and released
**Branch**: `main`

### Summary

Delivered Aliyun H5/App and SMS authentication plus Tianyi WEB/H5 authorization. Merged the cloud-verified feature into main, published v1.1.0, repaired a real-clock browser-test race, and completed GitHub-only release validation.

### Main Changes

- Added provider adapters, durable phone challenges, admin configuration, login/profile flows and docs/PHONE_AUTH.md.
- Fast-forwarded verified ec73f26 into main. Published v1.1.0 at ec73f26; follow-up 4010bbd changes only tests and Trellis docs.
- Recorded cloud regression lessons and archived 11-24-carrier-phone-auth; unrelated compliance directories remain untouched.

### Git Commits

| Hash | Message |
|------|---------|
| `70dfbc1` | feat(auth): add carrier phone authentication and cloud release gates |
| `ec73f26` | test(browser): retain H5 SDK count across navigation |
| `4010bbd` | test(auth): assert fixed session deadlines across signing delays |

### Testing

- [OK] GitHub feature run 45501906323: backend 512 passed, 7 skipped, 0 failed; all browser suites, deployment ZIP and container validation passed.
- [OK] GitHub tag run 45637874664: all gates and GHCR publication passed. Image ghcr.io/azurekiln2333/azurekiln-vaultsso-system:v1.1.0; digest sha256:55a181e7dbdaf2316032017b1cf2c56996299cae61c1a204c914430f80d1061b.
- [OK] Initial main run 45637867420 exposed an exp-minus-iat cross-second assertion; 4010bbd preserves fixed-deadline checks using measured authentication bounds. Main run 45641244196 passed tests, ZIP, image validation and publication.
- [OK] All executable checks and builds ran in GitHub; no local checks, builds, app startup, paid SMS, live SIM or production-host rollout.

### Status

[OK] **Completed**

### Next Steps

- Operator completes provider approval/credentials, installs the approved H5/App SDK configuration, enables channels and performs real provider/SIM validation using docs/PHONE_AUTH.md.
