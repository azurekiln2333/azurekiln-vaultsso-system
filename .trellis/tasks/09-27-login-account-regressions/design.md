# Design

The account session gap lives in PUT /api/users/:id: compare changed security values and preserve the current administrator session for allowed self edits. Version profile/admin assets so updated HTML loads corresponding handlers. The profile modal must tolerate loading state.

Extend established pending MFA mechanisms for password login after credential and CAPTCHA validation. Pending state is signed, short lived, stored server side, and does not grant a session; preserve validated OAuth continuation without persisting passwords client side. Schema v5 stores continuation in nullable pending_context JSON so valid encoded state does not exceed cookie size limits. Reuse /oauth2/mfa UI with localized feedback. Existing direct-code clients remain compatible where safe. Check existing account lockout before CAPTCHA; challenge requests do not consume password attempts.

Configure localhost proxy trust in deployment environment and sample configuration. Express resolves forwarded chains only for trusted IPs. Document Nginx forwarding requirements. Keep remote proxy trust explicit.

Changes cover server authentication/account routes, auth/profile/admin static assets, runtime configuration/docs and focused API/browser regressions. No unrelated navigation redesign or account merging.
