# Firefox TOTP Recognition

## Root Cause

This is an implicit browser assumption and a coverage gap. Firefox 157 preserves the HTML `autocomplete="one-time-code"` attribute but exposes an empty `HTMLInputElement.autocomplete` property. Official Bitwarden Firefox 2026.9.0 content code uses `getPropertyOrAttribute`: when a property exists, it returns the property's value, even when empty. Its autocomplete collector then returns null because neither legacy autocomplete attribute is present.

The old name `code` is only in Bitwarden's ambiguous TOTP keyword list. Its inline qualifier requires an explicit TOTP keyword or `autoCompleteType === 'one-time-code'`. Therefore the field remains viewable and enabled but does not qualify, and clicking it cannot request the menu.

## Discriminating Evidence

An isolated real Firefox BiDi run executed the official content bundle against the unchanged MFA DOM with simulated extension permission responses. The before/after values were:

| Value | Before | After |
| --- | --- | --- |
| HTML autocomplete attribute | one-time-code | one-time-code |
| Native autocomplete property | empty string | empty string |
| Collected autocomplete | null | null |
| Field name | code | totp_code |
| TOTP classification | false | true |
| Login qualification | false | true |
| Field listeners | absent | attached |
| Menu-open requests after trusted pointer click | 0 | 3 |

The same Firefox classifier also recognizes `verificationcode` and `totp` independently of autocomplete. Chrome's installed 2026.5.1 content code continues to classify `totp_code` and request its menu.

These probes use mocked extension message responses. They verify the actual collector/classifier/listener code in the real engines, but do not verify rendered menus, actual vault matching, or account permissions.

## Why Earlier Checks Missed It

- Chromium tests inspect the HTML attribute and successfully read the autocomplete DOM token; Firefox differs at the browser API boundary.
- Simulated filling events verify that a known input accepts a code, but bypass the extension's field discovery.
- Browser and extension versions were not established before the compatibility claim. The user's Firefox/Chrome comparison provided the necessary direction.

## Fix And Prevention

- Use explicit standard input names: initial `verificationcode`, TOTP `totp_code`, email `email_code`, recovery `recovery_code`.
- Keep `#code`, the six-slot design, the single real input, and API `{ code }` unchanged.
- Browser regressions assert factor-specific names and recovery-to-TOTP restoration; frontend specs record the Firefox DOM behavior and test limits.
- Do not expand this into authentication backend changes or speculative CSP allowances. Existing profile authenticator enrollment is a separate workflow outside this task.

## Source And Reproduction

- AMO metadata: `https://addons.mozilla.org/api/v5/addons/addon/bitwarden-password-manager/`
- Official package: `https://addons.mozilla.org/firefox/downloads/file/5037282/bitwarden_password_manager-2026.9.0.xpi`
- Bundle functions: `getPropertyOrAttribute`, `getAutoCompleteAttribute`, `isTotpField`, `isFieldForLoginForm`, and `AutoFillConstants.TotpFieldNames`.
- Local ignored artifacts: `.artifacts/firefox-bidi-probe.cjs`, `.artifacts/bitwarden-firefox.xpi`, `.artifacts/bitwarden-field-probe.cjs`.
- The Firefox probe starts a fresh headless profile and connects to `ws://127.0.0.1:9227/session`; the page comes from the existing isolated memory-fixture preview at `http://127.0.0.1:3147/`.

Actual unlocked-vault Firefox dropdown confirmation remains pending after the corrected page/script is deployed.
