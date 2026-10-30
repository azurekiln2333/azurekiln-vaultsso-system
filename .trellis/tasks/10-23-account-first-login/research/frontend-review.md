# Email gate frontend — in-progress risk list

Date: 2026-10-24 (Asia/Shanghai). Reviewer: `/root/inspect_password_login`.

Final review: see `login-email-gate-frontend-review.md`. F1–F4 are closed after final source inspection and targeted isolated Chrome retests. No unresolved frontend review finding remains. The historical snapshot below is preserved as the earlier repair checklist.

This is a read-only review of a moving implementation snapshot, requested before p5 declares ready. It is a repair checklist, not a final acceptance or automated-test report. Product and test files remain owned by the implementation workers. Final review will be recorded in `login-email-gate-frontend-review.md` after the coordinator announces readiness.

## Open paths to address or confirm

### F1 — Reloading an already-sent bind stage loses the destination association

Current evidence: `public/js/pages/auth/mfa.js:325` reloads pending state, then `:338` clears `mfaGateSentTarget`. The server may validly return `email_bind` with `code_sent:true` and only a masked destination. Rendering at `:181` still makes the bind email input required, while `:340-344` enables code entry.

Two outcomes follow on an ordinary reload: with an empty email field, six-digit `requestSubmit()` is blocked by native required-email validation; if the user fills a different valid address, the `:434-436` input handler returns because the local sent target is empty. A code for the persisted original destination can then finish while a different destination is visible in the input.

Keep the server destination authoritative without returning the full stored address. The coordinator-approved option is: for an already-sent stage rehydrated with no known full local target, leave the bind input empty with an optional masked placeholder and remove its required constraint for completion; any nonempty user edit locally invalidates the old proof and requires an explicit send. An equivalent explicit retarget interaction is also acceptable. Coordinate this path with p6's existing edited-target scenario.

### F2 — Gate enablement overwrites terminal completion disablement

Current evidence: completion `:382` disables the code on HTTP 401/429, but its `finally` calls `setMfaSubmitting(false)` at `:403`. For a gate, that calls `syncGateEnablement()` at `:201`, whose `:103` derives `disabled` only from `code_sent` and `mfaGateSending`. If the challenge still says `code_sent:true`, the terminal input and completion action become enabled again. The send action also has no terminal-state guard.

Preserve a terminal/expired/locked state in all enablement rendering, or invalidate the local challenge and require a fresh login. Retryable invalid-code errors must still clear/refocus and allow a new entry. This is a frontend continuation issue; no backend credential bypass is claimed.

### F3 — A failed next-stage GET leaves the obsolete factor usable

Current evidence: `advanceMfaStage()` clears transient values at `:219-229` but retains `mfaChallenge` and the old rendered factor. `loadMfaChallenge()` reports an unsuccessful GET at `:330-332` or network failure at `:351-352` without invalidating or disabling that challenge. The completion finalizer then unlocks the old form. After a committed TOTP/recovery-to-gate transition, a failed rehydration can therefore leave the obsolete TOTP/recovery display accepting another submission against the new server stage.

Disable/invalidate the old stage before refreshing and keep it unavailable if refresh fails. Provide a readable retry/back-to-login outcome; do not silently restore the consumed stage. Successful rehydration must still clear code, recovery mode, feedback, autosubmit marker and composition state before activating the new controls.

### F4 — API error/cooldown alignment remains an in-progress dependency

The inspected server send snapshot emits `auth.email_gate.unsupported`, `.stale`, `.invalid_email`, `.email_taken` and `.cooldown`, while the inspected i18n snapshot contains only the 11 UI gate keys. Unknown keys currently fall back to Chinese descriptions, so English/Traditional Chinese error paths need agreed existing keys or precise translations.

The same inspected SMTP-failure response lacks reserved `mail_version`/`retry_after`. The frontend now correctly disables its local code after unsuccessful/unknown sends, but version and cooldown recovery must be reconciled with the final server response or a pending GET. A pre-reservation invalid-email/cooldown failure should not be assumed to have invalidated an earlier exact code; pending GET is the authoritative projection. This is an integration item while backend/frontend are still being completed, not a final finding on unfinished work.

## Earlier observations already addressed in the latest source

- Resend/completion overlap: `syncGateEnablement()` now locks code entry/completion during send, send calls it synchronously, and submit guards `mfaGateSending` (`:98-107`, `:245-253`, `:358`). This closes the initially reported normal-UI overlap path by source inspection.
- Delivery failure retaining old local proof: unsuccessful/unknown send paths now clear `code_sent`, code value and autosubmit state (`:263-303`). Final authoritative version/cooldown recovery remains F4.
- Completion now sends `expected_mail_version` for gates and handles `next_step` before final redirect (`:369-390`). Final state/refresh handling remains subject to the readiness review.
- Template selectors, `type=email`, a `type=button` manual-send action, strong `[hidden]` rules, 11 gate UI keys in zh/zh-TW/en, and coordinated MFA asset versions were source-confirmed by the narrow template reviewer. This does not establish rendered desktop/mobile quality.

## Verification boundary

No product or test changes were made by this reviewer. No automated tests, live browser session, screenshots or real email delivery were run or inspected for this in-progress review. The coordinator owns fixes, focused/aggregate checks and visual acceptance.
