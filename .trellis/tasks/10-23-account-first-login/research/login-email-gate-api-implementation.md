# Password-login mailbox gate: API test implementation

Date: 2026-10-24 (Asia/Shanghai). Worker: API/support test owner (p4).
Ownership: `tests/login-email-gate.test.js`, `tests/user-import-upload.test.js`,
`tests/multi-authenticator.test.js`, `tests/huawei.test.js` (one fixture only),
`tests/support/fixture.js`, `tests/support/memory-db.js`.
Authority: `research/login-email-gate-contract.md` (frozen), the coordinator clarifications (parent
pending keeps its five-attempt budget across resend/retarget), and
`research/login-email-gate-backend-review.md` (B1–B12).

No commit, stage, reset, deploy or archive performed. `server.js` and `models/*` were read only.

## Result — all green

| Command | Result |
| --- | --- |
| `node --test --test-timeout=45000 tests/login-email-gate.test.js` | **39 / 39 pass** |
| `tests/multi-authenticator.test.js` | 17 / 17 |
| `tests/user-import-upload.test.js` | 20 / 20 |
| `tests/huawei.test.js` (focused adaptation) | 48 / 48 |
| `tests/account-first-login.test.js` | 23 / 23 |
| `tests/password-mfa.test.js` | 10 / 10 |

No known failures. No required coverage outstanding. Root owns the aggregate run.

## Permanently promoted probe regressions

Behaviours the independent reviewer had only verified in throwaway probes are now durable tests in
`tests/login-email-gate.test.js` (no new product hooks — `failNextInsert` and the existing fixture
helpers were sufficient):

1. **Concurrent exact-proof completion issues at most one session.** Two simultaneous completions
   with the same code + version resolve to exactly one `200`; `sessions.length === 1` and exactly one
   unrevoked session.
2. **Final Session INSERT failure rolls back everything.** With `failNextInsert('sessions')` the bind
   completion must not report success, must emit no `session=` cookie, must leave the mailbox
   unbound and unverified, and must leave **both** the parent pending and the `login_gate` proof
   unconsumed. The identical proof then succeeds and persists the bind.
3. **A proof from a separate pending cannot complete another challenge (parent/codeId isolation).**
   The *same* unverified account logs in twice, yielding two distinct pending cookies and two distinct
   `password_mfa` parent rows. Send on pending A (capture code A), elapse only the mail cooldown, then
   send on pending B for the same stored mailbox and version (capture code B, asserted different).
   Code B against pending A is rejected with no session even though destination and version match, and
   pending A's own code still completes. This isolates **parent/codeId** binding rather than account
   binding; the cross-account/wrong-code property is covered by the other challenge-binding checks.
4. **A target claimed after sending conflicts and leaves state intact.** A rival account is created
   with the bind target after the send; completion conflicts with no session, the original account
   keeps its unbound mailbox, the rival's mailbox is untouched, and neither the parent pending nor
   the gate proof is consumed.
5. **Native completion across case/trailing-slash variants.** The native loop now also completes via
   `COMPLETE_VARIANTS` using `X-Oidc-Pending` with no Origin — each variant issues exactly one
   session credential.

The adapter gained the matching `sessions` branch for `failNextInsert`; it remains inert unless
armed and is cleared by `reset()`.

## B11 — strict versions and expiry (covered)

- **Raw version typing.** `readMailVersion()` (`server.js`) is
  `Number.isInteger(value) && value >= 0 ? value : null`, so no `Number()` coercion. Asserted on both
  entry points, each value on a fresh account so one acceptance cannot mask another:
  - *send*: `null`, `false`, `true`, `''`, `'0'`, `'1'`, `1.5`, `-1` → refused, no mail,
    `mail_version` still 0, `code_sent: false`. `null`/`false`/`''` are the critical ones because
    `Number()` maps all three to `0`, which matched version 0.
  - *complete*: with the persisted version at 1, `true` and `'1'` coerce to a match, so those plus
    `null`/`false`/`''` are each refused with no session.
- **Expiry.** `readPendingUnderLock` re-checks `pending.exp * 1000 > Date.now()` under the lock
  (whole-second JWT `exp` can lapse up to 999 ms before the row/proof timestamp, and a queued
  request may cross that boundary). This is a TOCTOU guard and is *not independently
  unit-testable*: `exp*1000 <= now` and a non-expired JWT are mutually exclusive, so a forged token
  cannot isolate it. The observable consequence — a lapsed or state-changed pending is rejected —
  is asserted by the security-state test (below) and the deadline tests.

## B12 — case/trailing-slash origin boundary (covered)

`requestBoundary` now normalises the path (lowercase + trailing-slash strip) and feeds the same
value to the browser-guard set, the machine allowance and the rate category, matching Express's
case-insensitive routing. Asserted for four variants
(`lower`, `UPPER`, `Mixed`, `trailing-slash`) on **both** endpoints:

- *send* with a valid `X-Oidc-Pending` and `Origin: https://evil.example.test` → **403**, no mail,
  no session, no authorization code, and `mail_version` still 0 (the boundary must run before the
  version guard).
- *complete* with a hostile `Origin` → **403**, no session/code, and the proof is **not consumed** —
  a legitimate completion with the same code afterwards still succeeds.
- *native* (`X-Oidc-Pending`, no browser Origin) → **200** at `mail_version: 1` for all four
  variants, so the fix normalises rather than blanket-rejecting, and the trailing-slash variant is
  now classified in the `mail` rate category (10/min) instead of `auth` (120/min).

## Coverage summary

Matrix (green): verified → existing login, no gate; global `login_email_code` still governs a
verified mailbox and never becomes a gate; unverified → `email_gate: 'verify'` with
`code_sent: false`; the mandatory gate supersedes the optional factor without a second send;
unbound → `email_gate: 'bind'` with `email: ''` (the `@users.invalid` placeholder never leaks, even
masked); a corrupt `email_verified: true` on a synthetic mailbox is still `'bind'`;
`email_verified = NULL` counts as unverified; a wrong password discloses no gate and creates no
stage; passwordless accounts keep `set_password` / `contact_admin` discovery.

Boundaries (green): exact-version CAS and concurrent-send single winner; retarget invalidation;
bind-conflict with no writes; verify-only destination; **attempt budget survives resend**
(five wrong → resend → sixth is `429 auth.mfa.locked`); atomic verify and bind; replay rejection;
**B3** deadlines (send/retarget never move `proofExpiresAt`; no gate code outlives it; the
TOTP→gate successor is bounded by the original pending and records `totpSatisfied`);
**B6** delayed-success and delayed-failure SMTP with each attempt reporting **its own** reserved
`mail_version` and consuming only its own `codeId`; **B7** native `next_step` rotation (initial and
successor credentials, consumed predecessor rejected, rotated token usable); **B8** injected
zero-row parent consume rolls back an accepted TOTP factor and an accepted recovery code (same code
still works on retry); **B9** direct-path successor-INSERT failure rolls back the supplied recovery
code; entry-point closure (probe creates no session/stage/mail and never leaks the placeholder;
direct `email_code` submission still gates).

Security-state invalidation (green, tightened): password, mailbox, a real `email_verified` flip,
role, ban, TOTP enrollment and authenticator revision each yield exactly **`401` +
`auth.mfa.expired`** on **both** `GET /pending` and the send route. A `false → NULL` flip is
deliberately not asserted because `Boolean()` leaves the projected state equal. Mismatches are
collected so one defect cannot hide the others.

## `tests/multi-authenticator.test.js` — hang fixed, race coverage strengthened

The old `reset after final MFA validation` test hung forever: it awaited a second **pool-level**
`SELECT * FROM users WHERE id = ?` that the transaction-scoped validation no longer performs.

- `reset landing before the final MFA transaction denies any credential` — parks the completion at
  the connection's `GET_LOCK` (before account-lock acquisition), runs the admin reset (which
  acquires the lock freely), then releases; asserts 400/401, no session cookie, no usable
  credential.
- `a concurrent reset serialises behind the completion lock and then revokes its credential` — the
  real concurrent proof. It parks the completion at its final `INSERT INTO sessions` (lock held,
  transaction open), launches the admin reset, asserts the reset connection is genuinely queued via
  `[...pool.namedLocks.values()].some(lock => lock.waiters.length > 0)` and that a tracked
  `resetSettled` flag is still false, then releases. Afterwards: the completion issued a session
  credential, the reset removed the authenticators, `/api/profile` is 401 for that cookie, and no
  unrevoked session remains.
- `removal between factor verification and final issuance...` — hook moved from the rate-limit
  `DELETE` (which now runs inside the transaction, so the removal would queue behind the held lock
  and the login would correctly succeed) to the pre-lock `GET_LOCK` park. Retains exact
  `401` + `auth.mfa.expired`, no session cookie, no authorization code, and only the enrollment
  session usable.
- No polling loop survives a timeout: the deferred `atCompletionInsert` is resolved by the hook and
  awaited through `bounded(...)`; the only remaining poll is deadline-bounded `pollUntil`. The
  `finally` releases the gate, restores `getConnection`, and settles any tracked request.
- `alignTotpWindow()` — a 30 s window flake in `two independent devices coexist...` (it uses
  `code(secret, 1)` twice) is removed by waiting until ≥20 s remain before the pair. Replay
  coverage unchanged.
- All racy tests carry `{ timeout: 30000 }` plus bounded awaits.

## `tests/huawei.test.js` — one intentional fixture adaptation

`待绑定华为身份只能绑定已验证登录的账号` created a password user with the default
`email_verified = false` and then expected a direct password login redirect. The mandatory mailbox
gate intentionally supersedes that seed, so the fixture now sets `emailVerified: true`. The product
gate was **not** weakened, and no other Huawei fixture was touched. 48/48 pass.

## R9 — import expectation

An imported password account with no mailbox previously logged straight in; mandatory binding
supersedes that, so it asserts `email_gate: 'bind'` and no new session. 20/20 pass.

## Adapter additions (test support only)

- Three SQL branches for p3's model methods, verbatim (`updatePendingContext`,
  `bindEmailIfUnchanged`, `markEmailVerifiedIfUnchanged`), each reporting real affected rows so
  p3's "zero rows aborts the transaction" contract is observable.
- `failNextConsume(id)` — the next consume of that exact row reports 0 affected rows.
- `failNextInsert(table)` — the next insert into that table throws.
- Fixture mail controls: `holdNextMail()` (returns `{release, fail}`), `failNextMail(error)`,
  `blockedMailCount()`.
  All are module-scoped because `beginTransaction` builds a fresh `MemoryPool`; all are inert unless
  armed and are cleared by `reset()`.

The adapter models genuine rollback (`beginTransaction` clones, `commit` diffs, `rollback`
discards) and `commit()` runs `assertUserUniqueness`, so a thrown abort after a partial write is
really undone and a lost uniqueness race surfaces at commit.

## Assertion-precision notes (no security weakening)

- `unversioned send` asserts "refused, no version advance, no `code_sent`" rather than one status:
  the contract freezes the rule, not whether a missing version is a malformed request or a stale
  conflict.
- The delayed-SMTP failure accepts either `smtp.test_failed` or `email_delivery_failed` because the
  failure key is incidental; the reserved `mail_version`, `code_sent: false`, 502 status and the
  surviving newer proof are all asserted exactly.
- `elapseMailCooldown()` clears `pool.rateLimits` to simulate the cooldown window elapsing; attempt
  budgets live on the persisted parent row, so brute-force assertions are unaffected.
- `User.update` ignores `password`, so the security-state password mutation writes the stored row
  directly (fixture detail, not a product finding).
