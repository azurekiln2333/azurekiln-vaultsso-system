# Multiple Account Authenticators

## Goal
An account owner can add a second authenticator while retaining the original device. The user explicitly selected coexistence on 2026-09-28.

## Requirements
- Keep existing enrolled devices usable; adding a new device never silently replaces an existing secret.
- Show independently named authenticators in the personal profile, with add and individual remove actions.
- Verify an existing authenticator or unused recovery code before adding another device. First enrollment requires recent sign-in as today.
- Generate a separate encrypted secret for each device. Activate only after its new code is confirmed; cancellation, expiry and failed confirmation preserve enrolled devices.
- Login accepts any active enrolled authenticator, with replay protection per device. Account recovery codes remain account-wide.
- Confirm identity before removing a device; removing the last device clearly disables authenticator verification. Admin reset clears every authenticator.
- Preserve local, external OAuth/Huawei, MFA and native direct-code login contracts.
- Core styles/scripts stay in public/css and public/js. Deployment ZIP excludes font/icon assets.

## Acceptance Criteria
- An already bound account adds a second named device without losing the first.
- Login succeeds independently with either secret and rejects replayed codes, inactive or removed credentials.
- Setup failures, expiry and cancellation leave existing security state unchanged.
- Scoped list/mutation APIs cannot inspect or change another user's credentials and never expose active secrets.
- Individual removal and admin reset invalidate relevant sessions/tokens and pending MFA/setup grants as intended.
- Browser flows and desktop/mobile forms pass; package includes current sources and excludes assets.

## Limits
TOTP authenticator devices only. No WebAuthn/passkeys, SMS channel, email account recovery policy or secret export from an existing binding. Production database migrations and deployment are not performed locally.
