# Account-First Login Integration Review

Review date: 2026-10-24 (Asia/Shanghai).

Read-only product review by `/root/inspect_password_login`, with a narrow frontend state review delegated to `/root/inspect_password_login/review_frontend_state`. The coordinator owns all product fixes and test execution. This report is the only file written by the reviewer.

## Context and scope

Read `.trellis/agents/check.md`, every `check.jsonl` entry, PRD/design/implementation plan, implementation coordination contract, relevant backend/frontend spec indexes and quality guidelines. The two general quality-guideline files are placeholders; the executable password-verification, multiple-authenticator, auth-feedback and surface contracts supply the relevant checks.

Reviewed the task's additions in `server.js`, `models/User.js`, `public/js/pages/auth/login.js`, `views/auth/login.html`, `public/js/shared/i18n.js`, the memory DB adapter, package browser command, both new account-first regression files, and affected existing MFA browser-test diffs. Compared changed existing files against the saved baseline directory from `research/baseline.json`, rather than treating all worktree changes as this task.

## Open at the latest reviewed snapshot

No product-code defect remains from the findings raised during this review.

One public-documentation correction was sent to the coordinator: `views/docs/api.html:119` says a well-formed discovery request always answers 200. Well-formed requests remain subject to banned/locked account, invalid/disabled OAuth client, and HTTP throttling responses. Describe **successful** discovery responses as 200 and explicitly retain the existing error behavior. The backend spec's validation matrix can also narrow its password/email-change conflict wording to an already-set password or a failed conditional write: a mailbox changed before the setup request instead produces the existing invalid/expired proof error, as the API test requires.

## Findings resolved in the implementation during review

- **Account-bound send with an existing password:** now returns `409 auth.password.setup_changed`; unknown/ambiguous accounts retain generic `200` without mail (`server.js:2927` onward).
- **Known unusable mailbox in setup:** now returns `400 auth.password.contact_admin`, separately from the unknown-account expired-code response (`server.js:3190` onward).
- **Identifier ambiguity:** send/reset select by username-field presence, reject simultaneous username/email fields even when one is empty, and reject empty/overlong usernames without falling through to the legacy email path (`server.js:2892`, `:3144`).
- **Cross-operation token replacement:** discovery/send/setup now use a single synchronous action lock; one pending operation cannot replace another's token (`login.js:244`).
- **Internal rediscovery lock and cleanup:** both setup-changed branches now call `resetToAccountStep()` before rediscovery (`login.js:693`, `:754`). This invalidates the old action, clears stale setup proof/secrets/controls, preserves account/OAuth fields, and leaves a retryable account step if rediscovery fails. The final product finding is resolved.
- **Account edits and mode switches:** editing the account invalidates the prior action; switching away from login invalidates actions and clears setup proof, passwords, masked destination and cooldown (`login.js:355`, `:909`).
- **Setup button label after success:** `clearSetupState` restores the idle label and enabled state, so another account's setup does not inherit “Saving” (`login.js:231`).
- **Traditional Chinese:** the 14 new keys now have explicit `zh-TW` translations (`public/js/shared/i18n.js:1104`).
- **Recovery browser interaction:** the new regression now uses Continue before the password-step forgot-password action.
- **Meaningful CAS tests:** the API regression now injects competing password and email writes immediately before the conditional SQL, checks an actual zero-row result, and observes that sessions/access tokens survive the rejected setup.
- **Browser evidence gaps:** source now includes mutually exclusive send/submit interactions, late send/reset responses after an account change, and passwordless OAuth setup followed by password/MFA and token exchange with retained state/nonce/PKCE. Execution evidence remains the coordinator's responsibility.
- **Public API/spec coverage:** `views/docs/api.html` documents optional discovery and both account-bound variants; both backend/frontend executable specs now record the discovery, proof/CAS, administrator fallback and active-password-step CAPTCHA contracts. Their original MFA sections are retained. The small response-status wording correction is listed above.

## Contracts verified by source review

- Discovery is strictly selected by `discover_account === true` before the legacy required-password guard. It uses the same account lock derivation and registered OAuth validation without consuming a password attempt or issuing mail/authentication credentials. Native `check_verification` and ordinary credential code remain outside the optional discovery branch.
- Destination authority remains server-side. Account send/setup resolve the current account and mailbox; masked discovery is the only new stored-mailbox projection. Existing purpose/user-ID-bound code verification is reused, and prior discovery is not an authorization prerequisite.
- `User.setInitialPassword` hashes through bcrypt and conditionally writes both password and verified-email state using the resolved user ID, verified email and unset-password predicate. Zero affected rows return a conflict before session/token revocation.
- Setup has no authenticated-success path and returns to password entry. The existing final credential/MFA flow remains the issuer of sessions and OAuth codes.
- OAuth hidden inputs remain in the existing form; absent optional PKCE fields are still omitted. Step changes do not reset the login form. Setup is a sibling form and cannot add duplicate password fields to the credential payload.
- CAPTCHA visibility/render entry points account for the password step; account/setup/contact transitions hide/reset the login challenge. Existing final-login CAPTCHA handling remains in place.

## Banned/locked recovery scope

No additional ban/login-lock gate is recommended for the new send/setup variants. The approved design explicitly preserves those errors on discovery and final login; the prior email recovery handlers also do not check the login lock or ban state. First-password setup does not authenticate, clear the login lock or remove a ban, so final login continues to enforce both. Adding recovery-specific gating would narrow recovery semantics beyond the requested change. The coordination contract's broad “applicable auth errors” wording should be read or clarified in that scope.

## Baseline preservation

SHA-256 comparison against `research/baseline.json` confirmed exact preservation of the existing admin CSS/templates, `vaultsso-mfa.css`, `public/js/pages/auth/mfa.js`, and `views/auth/mfa.html` (13 files). The existing password-MFA and multi-authenticator browser tests differ from their saved baselines only by the real Continue helper and its calls; prior MFA assertions remain present. No admin/import/MFA product change was introduced by this review.

## Verification status

- Product files edited by reviewer: none.
- Automated tests/lint/typecheck: not run here, as expressly assigned to the coordinator.
- Coordinator-reported evidence: the fresh integrated `check:e2e` run passed 225/225; reviewer did not independently rerun it. Browser-suite completion remains pending coordinator confirmation.
- Screenshots/visual layout: not reviewed here; coordinator/browser owner must inspect the generated desktop/mobile artifacts.
- Review status: all raised product defects have source-confirmed fixes; one small public-documentation correction remains at this snapshot. Do not treat source inspection as passing browser-test, visual or deployment evidence.
