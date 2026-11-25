# Progress

- User authorized four existing Herdr Pi workers, commits/pushes, merge after cloud checks, and tagged CI/CD. All local checks, tests, syntax validation, builds, dependency installation and app startup are forbidden.
- Trellis task is active on `feat/carrier-phone-auth`; PRD, design, execution/ownership manifests and official provider research are recorded here.
- Aliyun H5/App/SMS and Tianyi WEB/H5 account authorization are implemented. Tianyi's app-scoped `openId` never grants phone/email verification. Operator onboarding and live carrier approval remain external requirements.
- Backend review fixed strict foreign-prefix rejection, Tianyi MFA application-snapshot validation, transactional final issuance/cookie publication, and token-exchange redirect rejection. The account-binding spec now records the Tianyi identity boundary.
- UI review fixed H5 `watch(status === 2)` termination, cross-method busy-state handling, strict +86/0086 validation, profile challenge invalidation and capability loading, plus Tianyi administration and onboarding text.
- API regressions cover Tianyi app-ID changes during MFA and failed commit behavior. The browser suite now covers H5 close/unlock behavior and rejection of `+14155550123` before SMS send.
- GitHub runs backend tests, every Chromium browser suite, deployment ZIP creation and isolated container-image validation on branch pushes. Only `main`/`v*` pushes publish; prerelease tags do not move `latest`.
- Exact feature SHA `ec73f26f0263d30ec9289aec51793f9e0170cb96` passed all gates in [run 45501906323](https://github.com/azurekiln2333/azurekiln-vaultsso-system/actions/runs/45501906323). Retained artifacts include browser/log evidence and the deployment ZIP. Feature image publication was correctly skipped.
- Final full-scope review found no remaining blocker. The passing revision was fast-forwarded into `main` and pushed; annotated tag `v1.1.0` points to that same revision. No force push or existing tag replacement was used.
- Tag [run 45637874664](https://github.com/azurekiln2333/azurekiln-vaultsso-system/actions/runs/45637874664) passed all tests, ZIP, image validation and GHCR publication. Published release: `ghcr.io/azurekiln2333/azurekiln-vaultsso-system:v1.1.0` at source `ec73f26f0263d30ec9289aec51793f9e0170cb96`.
- The release manifest digest from the successful publish job is `sha256:55a181e7dbdaf2316032017b1cf2c56996299cae61c1a204c914430f80d1061b`; `sha-ec73f26f0263` references the same published image. Mutable `main`/`latest` tags may advance in later successful runs.
- Initial main [run 45637867420](https://github.com/azurekiln2333/azurekiln-vaultsso-system/actions/runs/45637867420) passed backend and every browser suite except session-duration: a cross-second test compared `exp - iat` to exactly 86400 and observed 86399. The fixed deadline is chosen before commit; signing adds `iat` later. Follow-up test-only fix `4010bbd2521414cdc57813b5a7599683b715ad5b` measures the final-authentication time window and still requires JWT/row/cookie deadline agreement and unchanged expiry on reopen. Main [run 45641244196](https://github.com/azurekiln2333/azurekiln-vaultsso-system/actions/runs/45641244196) passed backend, every browser suite, deployment ZIP, container validation and image publication; no runtime behavior was changed.
- All release acceptance criteria are complete. Remaining closure commits contain only these Trellis records and the session journal. Unrelated compliance task directories and `docs/compliance/` remain untouched and unstaged.
- No provider call, paid SMS, production-host deployment or live SIM test has been performed.

## 2026-11-25 handoff to Claude coordinator (w6Q:p8)

- Codex coordinator (w6Q:p3) stopped on upstream 429. Claude took over coordination; Pi workers restarted as fresh `newapi/gpt-6.1-sol` sessions named pi-a (p2), pi-b (p5), pi-c (p6), pi-d (p7). GPT upstream allows 20 turns per conversation, so each Pi gets one narrow task per fresh session.
- Backend now passes in GitHub; failures are browser-only. Browser suites had never run in CI before this branch; the runner defaults to en-US and is slower than the local machine.
- `5c09048` pinned account-bindings to zh-CN; run `45474121727` then passed line 63 and failed at line 164: the admin user page keeps the previous "已保存" status during the next save, so the test reads the DB before the PUT lands. Test-side race, not a product defect.
- Tianyi XXTEA key-mode concern is covered by the official vector in `tests/tianyi.test.js`, which passes in backend CI.

## Cloud fixes and final review

- Authenticated GitHub log access resolved the earlier public API 403, so backend/browser failures were diagnosed from their actual job logs. No local verification was substituted.
- Backend fixes cover H5 URL normalization and opaque challenge fixtures, the Tianyi identity serializer instance, and correctly establishing an existing session before enabling global MFA in regression fixtures. Pending tests explicitly select the intended credential and reread transaction-backed records.
- Browser fixes specify the language under test, wait for the exact action response, retain intercepted carrier payloads before navigation, and keep H5 SDK counts outside the reloaded page. The workflow now executes every suite before returning a nonzero result, so one failure cannot hide the rest.
- The final product fix consistently removes phone claims from browser and native OAuth handoffs without the phone scope; regression assertions still require this redaction.
- The final cloud gates cover syntax/backend, all browser scripts, deployment ZIP and container packaging/inspection. This is not a live production database/container startup test. Separate lint/type-check scripts are not configured.
