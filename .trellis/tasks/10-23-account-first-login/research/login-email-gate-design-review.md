# Password-login mailbox gate: security design pressure test

Date: 2026-10-24 (Asia/Shanghai). Reviewer: `/root/check_import_scale`.
Research only: this report is the only changed file. No product/test edits, full suites, real mail or deployment were performed.

## Minimal safe direction

Reuse the existing persisted `password_mfa` pending record, signed `oidc_pending` credential, `pending_context` JSON and `Authenticator.withUser` account lock/transaction. Add password-source-only mail stages and a dedicated pending-gated send route. No new table, cookie, schema migration, queue or general email-code refactor is necessary.

After validated password and required CAPTCHA, enforce active TOTP/recovery first. Then derive the mailbox requirement from the fresh locked account: usable+verified means the existing policy, usable+unverified means verify the exact stored mailbox, and missing/synthetic/invalid means bind and verify a new usable mailbox. With TOTP enabled the mandatory mailbox gate still follows TOTP; a verified account retains the existing TOTP precedence over optional global email MFA. Without TOTP, a mandatory mailbox code satisfies both mailbox verification and enabled global `login_email_code`, without a second send/code. No-password discovery/initial-password/admin branches remain unchanged.

## Source-confirmed hazards that the initial worker proposal must not preserve

1. `pendingLoginSecurityState` currently binds email but **not `email_verified`** (`server.js:1205`). The statement that leaving it unchanged covers verification-state changes is false. Include `Boolean(user.email_verified)` in the state, while retaining email/password/role/ban/phone/authenticator fields. Validate the old state before mutation and use the fresh updated user for final claims/session work. Do not call the old-state validator again after the intentional bind/verification write.
2. `verifyEmailCode` uses `findLatestActive(email,purpose)` plus `user_id`; it does **not** bind a code to a pending challenge (`server.js:1778`). New gate proof must name an exact persisted code record and bind account, parent pending, stage, destination and send version. Reusing the generic latest code cannot establish that invariant.
3. `beginOidcSecondFactor` invalidates only ordinary `login` email-code rows through the issue helper. It does **not** supersede an older `password_mfa` pending. TOTP-to-mail transition must atomically consume the original pending and create its successor under the same account lock/connection; at most one successor can win. Replaying the old TOTP pending must not create another stage or credential.
4. `Authenticator.withUser` commits whenever its callback returns normally, **including a returned 4xx/error object**. A failure after any bind/code/pending mutation must throw a controlled internal error to roll back, then become an HTTP error outside the transaction. Returning `authenticatorError` after a partial mutation would commit it.
5. Existing `verifyTotpOnce` acquires its own account lock. Do not nest it inside another `withUser` on a different connection. Reuse `verifyTotpLocked`, bound models and `consumeRecoveryCode(...,users)` under the held connection, or preserve the existing outside-proof/fresh-state-recheck pattern before an atomic stage transition. Do not call global-pool `getPendingOidcLogin`/`verifyEmailCode`/`issueEmailVerificationCode` while holding the connection.

## Concrete persisted mail-send state without a schema change

For a password-source mail-stage parent, persist:

```json
{
  "returnTo": "/original/safe/continuation",
  "proofExpiresAt": "original password-proof deadline",
  "totpSatisfied": true,
  "mail": { "version": 0, "targetEmail": null, "codeId": null }
}
```

`totpSatisfied` is server-generated: no client flag authorizes a factor. It can be omitted/false when the account has no TOTP. The signed stage/source plus persisted context must prove the prerequisite before a TOTP-enabled user can enter a mail stage. Do not simply remove the current email-completion branch's `!user.totp_enabled` condition for every source; that would weaken existing external pending behavior.

Add one minimal `EmailVerificationCodeModel` update operation for `pending_context`, conditional on the exact ID still unconsumed and unexpired, returning actual affected rows. All new parent-state reads/writes run under the account lock, so a JSON version field and an expected-version comparison there suffice; a general revision column is unnecessary. The memory adapter will require support for this new SQL operation even though it already supports JSON round trips.

Dedicated send route, proposed `/api/v1/auth/oauth/oidc/email/send`:

1. Validate the supplied pending credential format/source, then acquire the account lock. Refetch the parent by exact ID through `new EmailVerificationCodeModel(connection)` and compare challenge hash, account ID, password source, stage, expiry and fresh security-state HMAC. Never trust a stage/account/destination supplied by the browser.
2. Require `expected_mail_version` to equal the current persisted integer. Bind stage accepts a normalized usable non-synthetic new email; verify stage derives the target from the exact current stored email and rejects destination changes. Recheck conflicts with the bound existing conflict helper; exclude only this account.
3. Generate a code and a dedicated-purpose code row (for example `password_login_email`, which fits the existing `purpose VARCHAR(32)`). Bind its `user_id` and `pending_context` to `{parentPendingId,stage,version:old+1,targetEmail}`. In the same transaction consume the prior exact `codeId` if any, and update the parent to the new version/target/new code ID. A zero-row required write aborts the transaction.
4. Commit; only then perform SMTP outside the account lock. Two concurrent sends with the same expected version have exactly one accepted state update; the loser receives 409 and sends nothing. Resends/new targets use the returned latest version and invalidate the prior proof.
5. SMTP failure consumes **only this attempt's exact code ID**. It must never consume the current/latest code generically, reset the parent's version or overwrite a newer target. A delayed old success/failure cannot restore old context. Include the attempted version in responses; on mismatch/failure the frontend can refresh the pending projection. Use request revisions to ignore responses belonging to an earlier input/send action.

The pending GET may project stage, current version, masked allowed destination and continuation. Bind with no selected target must not display a masked `@users.invalid` marker. It must never expose the code/hash, full stored mailbox or internal challenge context. The newly entered bind address is already known to that requesting UI; it remains server-normalized and authoritative after send.

Both parent/successor and mail-code deadlines must be no later than the original password proof's absolute expiry. Neither resend nor TOTP-to-mail rotation may extend a proof indefinitely. Manual sends for bind and verify avoid implicit SMTP during discovery or stage creation and match the coordinator's frozen direction.

## Atomic completion contract

Completion names `expected_mail_version` and code; an optional submitted bind email is only checked for equality with the persisted target. It cannot select the target at completion.

Under the existing account lock and one connection:

- revalidate the exact unconsumed parent/current security state/stage/prerequisites;
- require the current version, target and exact `codeId`; fetch that code row by ID and verify its account/purpose/parent/stage/version/target, expiry, attempts and hash;
- count attempts without granting any proof on malformed/wrong codes; resending must not reset the parent challenge's overall attempt budget;
- recheck target conflicts and perform a conditional mailbox bind or stored-mailbox verification using the pre-mutation email/verification snapshot; require actual affected-row success;
- atomically consume both the precise code row and parent, and issue the final durable credential using the updated user on that connection;
- throw to roll back any failure after mutation, including a zero-row consume or unique-key conflict. Do not claim successful proof with an unchanged/overwritten mailbox or consume a later code instead.

Two simultaneous completions must yield at most one session/authorization code. If another account acquires the target between sending and completion, return a readable conflict with no partial email/verified/credential write; the SQL UNIQUE constraint remains the final email-ownership backstop. Do not weaken the security-state HMAC by removing email to make a bind pass. Apply successful new-stage/session cookies only after commit, or explicitly discard them on rollback; no success body may be sent before commit. SMTP and other remote I/O remain outside account transactions.

## Entry-point closure and compatibility

- Cover both local password credential issuers: direct final `POST /oauth2/authorize` (including supplied `totp_code`/`email_code`) and password-source `POST .../oidc/complete`. A client bypassing the new UI or calling completion directly must not bypass the mailbox requirement. A legacy generic login/email-reset code is not the new challenge-bound proof.
- Native `check_verification` remains a probe without a session, authorization code or authenticated mail-stage proof. It must report the mandatory gate/prerequisites and never send to a synthetic mailbox or run a pre-TOTP mandatory send. Final credential submission can create the pending and return its token for clients without cookie retention. Older clients that cannot render the new stages fail closed for affected accounts; that compatibility consequence should be stated rather than silently issuing credentials.
- For a dedicated send route using `X-Oidc-Pending`, apply the existing machine/browser-origin distinction, cross-origin rejection and HTTP throttling consistently. Include mail/IP plus account/challenge cooldowns, so rotating destinations cannot bypass the existing mail-send limits. Do not expose the dedicated purpose as a freely usable branch of the public generic send endpoint.
- Preserve external OIDC/Huawei source semantics, existing-session authorization scope, first-password-only setup and password reset purposes. A global guard in shared `finishAccountLogin` that forces every source into this local-password requirement would broaden scope incorrectly. New password-source mail contexts must not be accepted for an external factor or vice versa.
- Preserve original server-held OAuth state/nonce/PKCE continuation through every stage and retain required CAPTCHA/TOTP/recovery proof without password storage or forced TOTP replay. After bind, claims must use the newly verified mailbox. Existing authenticated-session migration is separate from this new password-login gate and should not be invented implicitly.

## Focused verification required before acceptance

Use existing isolated fixtures for: local verified/unverified/unbound matrix with global switch both ways and TOTP/recovery precedence; no credentials at either intermediate stage; exact account/challenge/target/version binding; target edits/resends/delayed SMTP success and failure; simultaneous send/complete; email/verified/password/ban/role/authenticator changes; final uniqueness conflict; unchanged initial-password/admin paths; legacy/direct/native fail-closed behavior; and final real OAuth continuation/token exchange. Add deterministic rollback/held-connection assertions for all-or-nothing mutation and stage successor creation. A memory-adapter pass does not by itself establish real MySQL transaction behavior.

The recommendations above were delivered to the coordinator before implementation. No claim is made that the gate is already implemented or validated.

## Frozen-contract audit

The coordinator's `login-email-gate-contract.md` was independently reviewed after freeze on 2026-10-24. No new product decision or design blocker was found. The frozen contract covers security-state verification changes, original proof deadlines, exact parent/code/version/target binding, post-commit SMTP, controlled rollback, TOTP stage rotation and closure of direct/native credential paths.

Implementation review will additionally check that the inherited five-attempt parent budget survives resends, and that pending GET derives `code_sent` from the exact active code row after delivery cleanup. These are existing proof/attempt guarantees, not new product scope. Product and test files remain owned by the four Pi workers; this reviewer will report concrete implementation defects before any coordinated fix.
