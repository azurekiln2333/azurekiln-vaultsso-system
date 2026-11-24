# Progress

- User authorized four existing Herdr Pi workers, commits/pushes, merge after cloud checks, and tagged CI/CD. All local checks, tests, syntax validation, builds, dependency installation and app startup are forbidden.
- Trellis task is active on `feat/carrier-phone-auth`; PRD, design, execution/ownership manifests and official provider research are recorded here.
- Aliyun H5/App/SMS and Tianyi WEB/H5 account authorization are implemented. Tianyi's app-scoped `openId` never grants phone/email verification. Operator onboarding and live carrier approval remain external requirements.
- Backend review fixed strict foreign-prefix rejection, Tianyi MFA application-snapshot validation, transactional final issuance/cookie publication, and token-exchange redirect rejection. The account-binding spec now records the Tianyi identity boundary.
- UI review fixed H5 `watch(status === 2)` termination, cross-method busy-state handling, strict +86/0086 validation, profile challenge invalidation and capability loading, plus Tianyi administration and onboarding text.
- API regressions cover Tianyi app-ID changes during MFA and failed commit behavior. The browser suite now covers H5 close/unlock behavior and rejection of `+14155550123` before SMS send.
- GitHub workflow is configured to run backend tests, Chromium browser suite, deployment ZIP creation and isolated container-image validation on branch pushes. It publishes only on `main` or stable version tags. Feature-branch CI has not run yet.
- Initial implementation commit `70dfbc1` is pushed to the feature branch and GitHub run `45380623261` is underway. Static browser review corrected browser-versus-native OAuth cookie expectations and moved an SDK assertion before document navigation; these review fixes are being pushed as a new SHA, whose cloud run will be authoritative. Do not merge until every required cloud job passes for that exact SHA.
- Historical baseline only: `main` at `e2ade3d110ffdc7622c632dab4c2f7c136f151f6` had successful GitHub run `45252768616`; it does not validate this task.
- No provider call, paid SMS, production-host deployment or live SIM test has been performed.
