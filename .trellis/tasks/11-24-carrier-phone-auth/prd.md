# Carrier phone authentication and cloud release

## Goal and authorization
Provide configuration-ready H5 and native App carrier one-click login, SMS verification/login and operator account authorization. The operator completes provider onboarding, enters approved credentials/scheme/SDK settings, and enables the relevant channel.

The user explicitly requested Trellis planning followed by implementation by four existing Herdr Pi workers. They authorized commits, pushes, tags and merging the feature branch into main after cloud checks pass. ALL local tests, checks and builds are prohibited. This direction overrides additional skill approval pauses and generic local verification instructions. Existing main commits were pushed; new implementation is on `feat/carrier-phone-auth`.

## Requirements
- R1: Aliyun PNVS uses documented H5 GetAuthToken (BizType=1)/GetPhoneWithToken, App GetMobile and SMS SendSmsVerifyCode/CheckSmsVerifyCode. Only a server-verified complete phone grants phone authority.
- R2: H5 loads the configured official SDK and uses its real consent/number-completion flow with fallback. Document the native App token exchange API and registered OAuth code handoff; this repository contains no native application to build.
- R3: SMS send/login has canonical mainland-China phone validation, durable purpose/context binding, cooldown, per-IP/per-phone limits, maximum attempts, expiry and one-time use. Authenticated verification targets the current bound phone without silently replacing a binding.
- R4: Tianyi WEB/H5 account authorization is distinct from network one-click login. Dedicated encrypted/HMAC adapter uses the documented token-exchange openId as application-scoped identity. Do not use the incompatible generic OAuth2 exchange or invent phone/email verification claims; richer encrypted userinfo is outside this scope.
- R5: Disabled/incomplete channels make zero upstream calls. Admin configuration persists encrypted credentials, preserves blank secrets and supports explicit clears. Public projections expose no server secrets. Supply setup, API and App integration docs plus environment examples.
- R6: Login matches an existing verified phone; an unverified conflicting binding requires explicit account-side verification. New passwordless phone accounts require global registration and a separate phone-registration switch (off by default). Preserve existing client-specific signup restrictions.
- R7: Preserve TOTP/email MFA, pending-factor state checks, session duration, browser saved accounts, native OAuth no-cookie handoff, registered redirects/PKCE/state and phone-scope redaction. Failed/pending auth preserves the current account.
- R8: GitHub branch validation covers backend, browser, deploy ZIP and container build with evidence artifacts and isolated provider fixtures. Merge only the latest passing feature revision; main/tag publish only after checks. Record run URLs, commit SHA and release result.

## Acceptance
- AC1 (R1-R2): Official-contract fixtures accept valid H5/App proof and reject malformed/expired/replayed/error/partial-phone responses. SDK/browser fixtures prove consent and fallback wiring; distinguish live SIM testing from fixtures.
- AC2 (R3): SMS success, wrong/expired/reused codes, resend limits and concurrent verification pass. Changed target/account/context cannot reuse authority; current bound phone verification is account-specific.
- AC3 (R5-R7): Admin save/reload/redaction/readiness pass; existing authentication remains green; MFA/duration/roster/native OAuth contracts survive new channels.
- AC4 (R4): Tianyi WEB/H5 authorization uses documented parameters, callback HMAC/state and stable exchanged openId; invalid callbacks fail closed. No Tianyi phone-verification claim without phone proof.
- AC5 (R8): Latest branch passes cloud checks/build, merges into main, pushes and produces successful tagged image publication. No local checks/builds are run.

## Delivery limits
Provider purchase, real-name approval, paid SMS delivery, App signatures/SDK keys, whitelists and live SIM validation require the operator's approved account and cannot be fabricated. No production host access is supplied; deliver configuration-ready code and a published image, not a claim of live host rollout. Unrelated compliance tasks/docs remain outside this task.
