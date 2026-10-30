# Design

## Boundaries
Backend owns credential storage, existing-binding compatibility, verification and security state. Frontend manages a profile authenticator list and modal enrollment/removal, using the current bottom/modal feedback conventions. Runtime schema advances from version 6; migration preserves existing users.totp_secret bindings.

## API Contract
- GET /api/account/totp retains totpEnabled and recoveryCodesRemaining; adds authenticators [{id,name,createdAt,lastUsedAt}]. Never return active secrets.
- POST /api/account/totp/authenticators/setup with {name,code}: name required (max 64), code is an existing TOTP or unused recovery code when already enabled; first enrollment requires recent sign-in. Returns {id,secret,qrDataUrl,expiresAt} for a pending device only.
- POST /api/account/totp/authenticators/:id/confirm with {code}: validate new pending secret, expiration, bounded attempts, owner/session/security state and atomic activation. Returns {totpEnabled,authenticators,recoveryCodes?}. Issue recovery codes only on first enrollment, preserving existing account codes on addition.
- DELETE /api/account/totp/authenticators/:id with {code}: verify an active TOTP or unused recovery code, remove exactly the requested owned device, return {totpEnabled,authenticators}. Cancel pending setup with the same endpoint without disabling active devices.
- Existing setup/enable/disable and administrator reset contracts remain supported; disable/reset removes all devices.

## Persistence and Compatibility
Dedicated authenticator records store encrypted secrets, names, activation/pending status, bounded pending expiry/attempts and per-device last accepted counter/use time. Preserve legacy single-device records either through explicit migration or a compatibility projection; existing tests and installed clients that use legacy setup APIs must remain valid. Mark credential-set changes in account security state so pending challenges cannot survive removals/resets. Serialize lifecycle writes per account and perform related writes transactionally. Do not expose an already enrolled QR/secret to add another device.

## Security Effects
Confirmation/removal/reset revoke other sessions and OAuth tokens while retaining the active self-service session. Staging and cancellation do not modify live MFA requirements. Last-device removal is explicit in the UI. Identity proof expires with pending setup; login codes are checked against active credentials only. Native/external MFA uses the same verifier.

## Deployment
Run explicit init-db before updated startup; no silent production migration. Preserve fonts/icons under separately supplied assets. Regenerate the ZIP after all verified source changes.
