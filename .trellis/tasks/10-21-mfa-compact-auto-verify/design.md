# Compact MFA presentation and completion design

## Evidence

- `views/auth/mfa.html:9` loads the MFA-only stylesheet; no other page consumes it.
- `public/css/vaultsso-mfa.css:163` retains an 80px code row and 40px bottom gap; the mobile block reduces these only to 64px/32px. The late alignment block beginning near `:395` shrinks the panel and button without shrinking the row or heading.
- Recovery mode near `public/css/vaultsso-mfa.css:230` inherits the oversized row for a single text input.
- `public/js/pages/auth/mfa.js:36` mirrors normalized input; `:110` owns submit, locking, errors, and continuation; `:142` binds input/change. Detailed anchors and existing test impacts are in the parent research notes.

## Presentation

Keep the 26rem white card and existing palette/radius tokens. Consolidate the stylesheet into one authoritative component layer and a following mobile adjustment layer; remove superseded/dead overrides rather than adding another patch block.

| Element | Desktop target | Narrow mobile target |
| --- | --- | --- |
| Heading | 20px | 18px |
| Six-slot row | 48px high, 8px gaps | 44px high, 6px gaps |
| Slot/native-input type | 18px | 18px |
| Row-to-action gap | 20px | 20px |
| Primary action | 36px minimum height | 36px minimum height |
| Recovery input | 40px high, 16px type | Same |
| Instructions | 13px, natural wrapped height | Same |

Keep 24px card padding and 16px outer mobile gutters. Allow instructions, feedback, and action labels to grow naturally; do not clip translations to a fixed two-line box. Preserve empty status regions without reserved space, visible focus, native selection/caret behavior, and recovery-code readability. Remove the unused submit gradient class and dead status overrides while retaining the working status behavior. Review the resulting screenshots before accepting these dimensions.

## Input contract and completion state

Retain the only real input `#code`, six aria-hidden slots, `verificationcode` initial name, `totp_code`/`email_code` factor names, recovery name, text type, input modes, length limits, and autocomplete. Preserve password-manager recognition and whole-value mirroring on input/change.

The auto trigger runs only on committed user/fill events after normalization:

1. During IME composition, do not normalize the live composing value or submit; synchronize once composition ends.
2. Mirror the completed value into the slots.
3. If the challenge is ready, code mode is active, the value is exactly six digits, and input is enabled/editable with no pending/navigation state, call the existing form `requestSubmit()` path once.
4. Repeated input/change notifications of the same completed value cannot duplicate the attempt. Reset the completion marker on rejected/cleared input, mode change, and a fresh challenge so explicitly re-entering the same code can retry.
5. Rendering, focus, language changes, and mode toggles never trigger verification. Recovery codes always use the manual path, including six-character recovery text.

Do not add polling, MutationObserver, a second fetch implementation, or a debounce delay. Preserve the existing synchronous request lock before the first await. Manual button/Enter submission remains available through the same handler.

## Request and response compatibility

Use the unchanged `POST /api/v1/auth/oauth/oidc/complete` JSON `{ code }` contract. Preserve the pending server challenge, OAuth continuation, same-origin redirect validation, and success-only navigation.

Invalid codes/network failures retain the existing clear/focus/localized-feedback behavior and permit a new completed entry. Terminal 401/429 responses retain disabled input/buttons. Each automatic attempt counts toward the existing server attempt budget; do not add background retries or alter throttling.

## Affected contracts and rollout

Update `.trellis/spec/frontend/auth-feedback.md` to replace the no-auto-submit rule with this completion, recovery, locking, and retry contract. Adjust the existing browser tests that assume `fill()` is followed by a manual click; retain manual recovery coverage and perform native editing checks before entering the sixth digit. Update affected CSS/JS URL versions in `views/auth/mfa.html`.

The change is confined to this page and its browser expectations. No server/database migration. Roll back the MFA CSS/markup/JS, contract and corresponding test assertions as one scoped change if required.
