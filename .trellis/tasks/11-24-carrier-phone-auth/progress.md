# Progress

- User authorized four existing Herdr Pi workers, commits/pushes, merge after cloud checks, and tagged CI/CD. All local checks, tests, syntax validation, builds, dependency installation and app startup are forbidden.
- Trellis task is active on `feat/carrier-phone-auth`; PRD, design, execution/ownership manifests and official provider research are recorded here.
- Aliyun H5/App/SMS and Tianyi WEB/H5 account authorization are implemented. Tianyi's app-scoped `openId` never grants phone/email verification. Operator onboarding and live carrier approval remain external requirements.
- Backend review fixed strict foreign-prefix rejection, Tianyi MFA application-snapshot validation, transactional final issuance/cookie publication, and token-exchange redirect rejection. The account-binding spec now records the Tianyi identity boundary.
- UI review fixed H5 `watch(status === 2)` termination, cross-method busy-state handling, strict +86/0086 validation, profile challenge invalidation and capability loading, plus Tianyi administration and onboarding text.
- API regressions cover Tianyi app-ID changes during MFA and failed commit behavior. The browser suite now covers H5 close/unlock behavior and rejection of `+14155550123` before SMS send.
- GitHub workflow is configured to run backend tests, Chromium browser suite, deployment ZIP creation and isolated container-image validation on branch pushes. It publishes only on `main` or stable version tags. Feature-branch CI has not run yet.
- Feature commits `70dfbc1`, `bb471b9`, and `d9f7956` are pushed. Latest SHA `d9f7956ceb06bab5b7f87727f75f7dfa20f3d033`, run `45382222061`, failed at `Verify backend`; browser, ZIP and image-validation jobs were skipped. The job-log API returns 403 `Must have admin rights to Repository`, so the failing test cannot be identified or corrected from the available run metadata. Do not merge/tag until logs are accessible and a later exact SHA passes every gate.
- Historical baseline only: `main` at `e2ade3d110ffdc7622c632dab4c2f7c136f151f6` had successful GitHub run `45252768616`; it does not validate this task.
- No provider call, paid SMS, production-host deployment or live SIM test has been performed.

## 2026-11-25 handoff to Claude coordinator (w6Q:p8)

- Codex coordinator (w6Q:p3) stopped on upstream 429. Claude took over coordination; Pi workers restarted as fresh `newapi/gpt-6.1-sol` sessions named pi-a (p2), pi-b (p5), pi-c (p6), pi-d (p7). GPT upstream allows 20 turns per conversation, so each Pi gets one narrow task per fresh session.
- Backend now passes in GitHub; failures are browser-only. Browser suites had never run in CI before this branch; the runner defaults to en-US and is slower than the local machine.
- `5c09048` pinned account-bindings to zh-CN; run `45474121727` then passed line 63 and failed at line 164: the admin user page keeps the previous "已保存" status during the next save, so the test reads the DB before the PUT lands. Test-side race, not a product defect.
- Tianyi XXTEA key-mode concern is covered by the official vector in `tests/tianyi.test.js`, which passes in backend CI.
