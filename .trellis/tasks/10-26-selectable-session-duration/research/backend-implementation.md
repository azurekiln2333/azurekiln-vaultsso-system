# Backend implementation evidence

Implemented on October 26, 2026. Product/test writes are complete.

## Owned files

- `server.js`: strict duration normalization; fixed/legacy issuance and authentication policies; request-local replacement policy; password/OIDC/Huawei continuation; original legacy-cap retention; readable expired-replacement error.
- `tests/session-duration.test.js`: 16 focused route-level cases, using native Date mocking that advances both `Date.now()` and `new Date()` while keeping network timers real.
- `tests/oidc.test.js`: local-only duration propagation, invalid/duplicate queries, fixed and legacy linking replacement, and original MFA choice assertions.
- `tests/huawei.test.js`: validation before upstream exchange, binding-skip override rejection, selected browser duration, original MFA choice, and unchanged native no-cookie handoff.
- `tests/huawei-native-mfa.test.js`: retained selected MFA context and unchanged no-cookie native OAuth handoff; selected browser MFA deadline.
- `tests/security.test.js`: registration auto-login explicitly uses the one-day default.

All edits preserve the dirty pre-feature baseline at `.artifacts/session-duration/baseline/`. No schema/model/fixture changes, staging or commits were made by this worker.

## Final verification

```text
node --test tests/session-duration.test.js tests/security.test.js tests/phone-api.test.js tests/multi-authenticator.test.js tests/password-mfa.test.js tests/login-email-gate.test.js tests/oidc.test.js tests/huawei.test.js tests/huawei-native-mfa.test.js tests/i18n.test.js
```

Result: **234/234 passed**, zero skipped, failed, or cancelled; approximately 35.4 seconds.

```text
npm run check:syntax
```

Result: **108 files passed**, including browser script reference checks. The project has no separate lint/type-check command. A final one-case run after adding JSON string `"7"` to Huawei's invalid-input matrix also passed:

```text
node --test --test-name-pattern="Huawei rejects invalid duration" tests/huawei.test.js
```

## Proven behavior and limits

All three fixed durations share seconds-aligned JWT/row/cookie deadlines and survive two-hour/thirteen-hour inactivity without renewal. Exact expiry, shorter durable/JWT expiry, malformed signed claims, logout/revocation/reset/bans, repeated fixed/profile and legacy replacements, all password mailbox continuations, ignored completion overrides, old pending defaults, independent OAuth/proof TTLs, and unchanged recent-authentication restrictions are covered.

JSON requires integer choices; form/query transport accepts exact supported numeric strings. OIDC never forwards the selection upstream. The original server-saved choice survives Huawei skip and MFA, while native OAuth handoff still returns no gateway session.

Fixtures use memory storage, captured SMTP, and local fake providers. Production MySQL, live providers, deployment and browser evidence belong to the main integration review and are not claimed by these API checks.
