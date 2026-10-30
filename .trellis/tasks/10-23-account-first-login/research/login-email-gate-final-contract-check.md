# Final acceptance and contract consistency audit

Date: 2026-10-24 (Asia/Shanghai). Reviewer: `/root/final_contract_check` (`trellis-check`).

This review covers the complete active task, including account-first login, first-password setup, complete optional-mailbox file imports and categorized results, and the subsequently authorized post-password mailbox gate. It checks acceptance/spec/test consistency. It does not duplicate the independent backend security probes or completed frontend behavioral review, and does not run aggregate tests. Only this report was written.

## Findings (fixed)

No product/test edits by this reviewer. Coordinator/worker corrections were re-read in the final narrow pass:

- The Huawei binding fixture explicitly uses `emailVerified:true`, preserving its original authenticated-binding purpose without weakening the new mailbox gate.
- `backend/user-import.md` now states the post-password `email_bind`/`email_verify` requirements; `import-upload-contract.md` item 8 explicitly follows the subsequent gate contract.
- The initial `implementation-contract.md` now identifies its later scope overrides both at its introduction and its former exclusion.
- The frontend implementation report now closes root's K1/K2 integration, records F1–F4 closed, and states final JS/i18n version `-3` with CSS `-2`.
- p4 promoted native completion variants, concurrent completion, final session-insert rollback/retry and post-send target-claim conflict into permanent API tests. The owner reports **39/39** gate tests passing. The final cross-pending case now uses the same account and mailbox with two independent pending records, ensuring it tests exact parent/codeId authority. Root's named final follow-up passed **1/1**. This reviewer read the added assertions and follow-up log without rerunning them.
- The browser report's old rate limits are now explicitly historical and superseded by final account/target one-send-per-60s cooldowns and the shared ten-per-minute IP ceiling.

## Findings (not fixed)

None. The original documentation findings and final evidence-precision notes are closed. The same-account test rejects B's code for A's pending even though user, mailbox and version match, then proves A's own code remains usable. It therefore distinguishes exact challenge binding from latest-by-email/user-ID-only validation.

The coordinator owns the final implementation checklist, AC11, task notes and `research/validation.md` updates using the completed aggregate evidence below. The independent backend report closes **B1–B12**, including all accepted route spellings for foreign-origin rejection, native send/completion and the shared mail/IP category.

## Acceptance coverage map

| Acceptance | Observable evidence reviewed |
| --- | --- |
| AC1: username/email Continue without password | `account-first-login.test.js` discovery cases and `account-first-login-browser.cjs` account/password transitions; inactive password controls do not block Continue. |
| AC2: password/CAPTCHA/MFA/OAuth continuation | Existing password-MFA, multi-authenticator, Turnstile and OAuth suites plus the new browser gate's state/nonce/PKCE exchange. |
| AC3: empty/null first password and invalid proof | API null/empty state, wrong/expired/replayed/other-account codes, conditional password/email races; browser setup completes without a session. |
| AC3.1: masked destination and manual send | API zero-side-effect discovery and explicit account-bound send/cooldown; real browser masked-only display and exact mail count. |
| AC3.2: no usable mailbox contacts administrator | Discovery/send/setup synthetic and invalid-email cases; actual imported passwordless users and browser contact panel with no usable send action. |
| AC3.3: setup returns to password and preserves OAuth | Account-first browser setup and subsequent password/MFA/client continuation; setup itself never authenticates. |
| AC4: account changes/stale replies | Account-first browser back/card/account changes and delayed discovery/send/setup responses; API user-bound setup proof. |
| AC5: compatibility/preserved work | Existing direct/native, email-reset, OIDC/Huawei/browser suites; coordinator's saved baselines. Incomplete-mailbox clients intentionally follow R12 stages or fail closed. |
| AC6: four designated Pi owners | Durable p3/p4/p5/p6 implementation reports and frozen contract ownership. Root owns final integration and baseline evidence. |
| AC7: raw 97KiB upload and bounded parser | Import API fixture compares original and wrapped byte counts; browser actual file chooser verifies exact bytes/content type; auth/origin and ordinary endpoint body limits remain covered. |
| AC8: complete file above 2000 records | API 2501 unique users and real desktop/mobile 2501-row upload/reimport with all counts/details, no fixed row cap, 10MiB byte bound. |
| AC9: optional mailbox imports | Omitted/null/blank/whitespace mailbox, unverified synthetic storage, distinct markers, duplicate handling and later-row continuation; import-to-contact-admin and import-to-bind behavior. |
| AC10: inspectable result groups/history | Mixed import structured `reason_code` and successful-no-email rows; browser distinct counted sections and escaping; local classification artifact retains 347 rows, four duplicates and 343 historical combined errors. |
| AC11: complete password/mailbox matrix | API verified/global-switch/unverified/unbound/corrupt-flag/NULL/probe/direct/native cases, concurrent completion, final bind/session rollback/retry and claimed-target conflict; browser 20 scenarios at both widths including TOTP/recovery → gate, one email proof, verified claims, edited/taken destination, restoration and terminal failures. Independent backend review supplies further exact-proof/held-connection evidence. |

## Security evidence boundaries

The permanent gate API suite contains simultaneous same-version sends, retarget/stale-version rejection, shared target cooldown, replay, changed security state, delayed SMTP success/failure isolation, native token rotation, strict raw version typing, factor rollback and direct successor-failure rollback. B12 tests now cover hostile-origin send/complete spellings and cookie-less native send/complete spellings.

The final added cases assert exactly one winning concurrent completion/session, no mailbox/proof/session/cookie success after a failed final session insert followed by a working identical-code retry, refusal of another pending's code for the same account/mailbox/version while the correct proof remains usable, and no partial state/proof mutation when another account claims the target after sending. These are permanent regressions rather than only temporary probes.

The independent backend review remains the source of additional focused evidence for queued JWT expiry, anomaly-alert deferral after commit and lock/SMTP observations; its source review also checks exact parent/codeId binding, now additionally covered by the permanent same-account/two-pending test. Distinguish independently executed probes from permanent API test counts. No new product failure was identified by this evidence audit.

The browser suite verifies a real fixture HTTP/DOM/OAuth chain, while a delayed network-layer 502 scenario establishes frontend resynchronization. It does not itself establish the server's post-reservation SMTP cleanup. That cleanup is covered separately by API tests and independent SMTP probes. The frontend review's mocked exact-path probes establish client state/localization only. None of this claims live SMTP, a production database, real MySQL lock behavior, actual extension-vault integration or deployment.

## Specification assessment

The authoritative frozen contract, current PRD R12 and backend/frontend executable contracts agree on the resolved product decisions:

- password and required CAPTCHA, then configured TOTP/recovery, then mandatory mailbox bind/verify, then credentials;
- verified-mailbox accounts retain the global email-code switch and TOTP precedence;
- one mandatory mailbox proof satisfies that login's email factor;
- passwordless usable-mailbox accounts set their first password and return to password login; passwordless unusable-mailbox accounts contact the administrator;
- gate sends are manual, use the exact persisted destination/code/version, preserve the original absolute password-proof expiry and total attempt budget;
- final mailbox mutation/proof consumption/credential issuance are one account transaction; SMTP and cookies follow commit;
- external-provider source policy remains outside this local-password requirement.

No additional product-policy question or schema change is needed. Updated specs can explicitly name the new gate API/browser regression files in their tests sections for discoverability, but the required behavior is already documented.

## Verification

- Lint: no separate lint command/configured project gate in `package.json`; not applicable as a standalone run.
- TypeCheck: no separate TypeScript/type-check command in `package.json`; not applicable as a standalone run.
- Tests/syntax: not rerun by this reviewer. Owner report records **39/39** focused gate API tests. Root's final evidence is **286/286 API**, all **nine browser groups** (including 20 gate scenarios at desktop/mobile and 2501-row imports), **103 syntax files**, and ten unrelated baseline files preserved. The reviewer read the API aggregate's zero-failure summary in `.artifacts/login-email-gate/check-e2e-final.log`; browser/syntax/baseline results are attributed to the coordinator. After strengthening the same-account pending test, root's syntax check and named **1/1** follow-up passed; `.artifacts/login-email-gate/check-exact-pending-final.log` was read by this reviewer.
- Independent security review: B1–B12 closed in its final report; frontend F1–F4 closed.
- Findings: no new product defect identified; all documentation/coverage findings from this audit are closed, and final aggregate plus targeted follow-up evidence is available for coordinator acceptance. No commit, deployment or archive is implied.
