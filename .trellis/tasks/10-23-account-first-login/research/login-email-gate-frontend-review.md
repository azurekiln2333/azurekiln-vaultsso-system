# Post-password email gate — frontend review

Review date: 2026-10-24 (Asia/Shanghai).

Reviewer: `/root/inspect_password_login`, with a narrow template/CSS/i18n review by `/root/inspect_password_login/review_frontend_state`.

## Scope and result

Reviewed the frozen `login-email-gate-contract.md`, `public/js/pages/auth/mfa.js`, `views/auth/mfa.html`, the affected MFA CSS, shared i18n and asset versions. Read only the relevant server response shapes to align the frontend. Preserved the earlier MFA/input work and completed import UI. No product or test file was edited.

The final reviewed source closes all four frontend findings. **No unresolved frontend review finding remains.** Targeted isolated Chrome probes confirm the repaired target-restoration, terminal-state, failed-next-stage and SMTP-language paths. Full integration and visual acceptance remain with the coordinator and browser owner.

## Findings

### F1 — Closed: restored bind proof matches the displayed persisted target

The original empty-field reload is fixed: `loadMfaChallenge()` records the restored proof/version (`mfa.js:410-414`), and `gateInputOptional()` plus rendering remove the required-email constraint for that active persisted target (`:98-100`, `:228-229`). An isolated Chrome probe confirmed that a fresh restored bind stage with an empty email field sends exactly one completion containing the persisted version, rather than being blocked by native email validation.

The initial candidate still retained an already-entered email during that restoration. A server rejection followed by GET could enable a restored proof for destination A while the input still contained newly entered B.

Confirmed in a second isolated Chrome probe using a realistic `409 auth.email_gate.email_taken` response:

1. Pending GET reports active bind proof for masked `al***@example.test`, version 1; no full address is returned.
2. User enters `taken@example.test`; the edit correctly disables code entry.
3. Explicit send returns 409; the pending GET still reports A/version 1 because the rejected destination never reserved a new proof.
4. The page retains `taken@example.test`, displays A's masked target, and enables code entry. Six digits cause `/complete` with `{code:"123456", expected_mail_version:1}`.

The coordinator's final repair clears the bind input whenever GET restores an active bind proof (`mfa.js:418`); `gateInputOptional()` now also requires that input to be empty (`:98-101`). The final exact-path Chrome retest returned the same 409 and verified an empty editable input, the persisted masked A target, no native required-email block, and one completion using version 1. Typing another destination immediately disabled code entry again. The original mismatch is closed without exposing the full stored mailbox or changing server target authority. The browser owner retains responsibility for the permanent failed-retarget regression.

### F2 — Closed: terminal completion failures remain disabled

`mfaTerminal` now participates in autosubmit, send, gate enablement and input read-only state (`:74-77`, `:123-153`, `:183-186`, `:294`, `:460-464`). A 401/429 cannot be reversed by `setMfaSubmitting(false)` or later language rendering.

An isolated Chrome probe returned 401 for an active verify gate, waited for completion finalization, then dispatched language change. Code, complete and send controls all remained disabled. Retryable nonterminal failures still clear the auto-attempt marker and input through `rejectMfaSubmission()`.

### F3 — Closed: failed next-stage loading cannot reopen the consumed factor

`advanceMfaStage()` clears code, recovery mode, composition, feedback, auto-attempt state and gate target state, stops the timer and calls `lockMfaStage()` before fetching (`:269-289`). `loadMfaChallenge()` reports success/failure as a boolean; unsuccessful refresh remains locked. A successful GET explicitly clears terminal state before enabling the current factor (`:395-430`).

An isolated Chrome probe completed a TOTP stage with `next_step:true`, then returned 503 for pending GET. Code, complete and recovery remained disabled with a readable request error. Injecting a second six-digit input event did not produce a second completion request. The final redirect path still checks same-origin and is handled only after the intermediate-stage branch.

### F4 — Closed: errors, delivery failure and cooldown align with the current language

The server's five new gate error keys (`unsupported`, `stale`, `invalid_email`, `email_taken`, `cooldown`) now have explicit zh/en/zh-TW translations. Final server send failure responses include the reserved version, `code_sent:false` and retry hint; successful sends echo their own reserved target/version. The frontend treats pending GET as authoritative after a rejected or unknown send (`:328-372`), which avoids assuming that a pre-reservation rejection invalidated a previous code. These close the original version/cooldown/key alignment notes.

The final shared dictionaries explicitly translate both `email_delivery_failed` and `smtp.test_failed` in zh/en/zh-TW. The server's gate SMTP failure response now always returns HTTP 502 with the stable `error_key:'email_delivery_failed'` (`server.js:3027-3034`), rather than using transport codes such as `ECONNECTION`/`EAUTH` as translation keys. This closes the carrier-error variant as well as the no-code delivery failure.

After source-confirming that stable server key, the reviewer repeated only the SMTP path in isolated Chrome for English and Traditional Chinese. Both displayed the exact current-language dictionary text, kept code disabled and retained the resend cooldown. The final API response and UI now agree; the fixed Chinese diagnostic description no longer wins over the known translated key.

## Other source-confirmed contracts

- Both new gates reuse the existing MFA page. The explicit send handler is the only email-send caller on the page; loading/rendering/stage transition sends no mail. Bind uses `type=email`; verify hides and removes the requirement from the bind input. The send button is `type=button`.
- Sending synchronously locks code entry and completion; completion checks `mfaGateSending`. Completion locks bind/send. Gates include `expected_mail_version`, while existing factors keep the original `{code}` shape.
- TOTP-only recovery switching, the real input plus six decorative slots, factor-specific input names, native selection/paste handling, committed six-digit autosubmit, paired-event request locking and IME guards remain. Recovery mode still requires manual submit. Stage transition resets recovery/composition and clears previous entries.
- Feedback uses text content, a live region and `scrollIntoView({block:'nearest'})`; current feedback and factor-specific heading repaint on language change without resubmitting.
- The strong `[hidden]` rule remains in MFA CSS; added controls use the existing token-based styling and responsive layout. New UI, gate-error and delivery-failure keys are present in all three supported languages.
- Final affected MFA JS/shared i18n template versions are `20261024-email-gate-3`, including the login template's shared i18n consumer. MFA CSS remains at the existing `20261024-email-gate-2` version because the last repair changed scripts only. No import file was changed by this review.

## Verification and limits

- Reviewer-executed: ephemeral headless Chrome probes served the actual template/CSS/JS from a request interceptor with mocked pending/send/complete responses. Initial probes verified fresh restored-bind submission, terminal 401 persistence and failed-next-stage lock, and reproduced the retarget finding. Final focused retests confirmed the repaired 409 retarget path and then the stable-key SMTP failure in en/zh-TW. No JavaScript page errors were reported by these probes. No script or test file was added.
- The coordinator reported p5's scoped checks passing **53/53** before the initial candidate review, then reported passing `node --check` and **9 i18n tests** after the final frontend repair. Those checks were not run by this reviewer; they are separate from the targeted UI evidence above.
- No environment database, user data, real SMTP, session/token issuance, deployment, aggregate browser suite or screenshots were used by this review. These mocked UI probes establish client behavior only. API security/transaction review, the full p6 browser suite and desktop/mobile visual acceptance remain with their assigned owners.
- Acceptance status: **F1–F4 are closed; no unresolved frontend review findings remain.** The coordinator owns aggregate verification, permanent p6 regression coverage and final visual acceptance. No broader review expansion is requested.
