# Bitwarden Evidence

Checked on 2026-09-30:

- https://bitwarden.com/help/auto-fill-browser/ states that TOTP can be filled using the inline menu, context menu, keyboard shortcuts, or manual autofill. Page-load autofill does not fill TOTP.
- https://github.com/bitwarden/clients/blob/main/apps/browser/src/autofill/services/autofill.service.ts detects a viewable text/tel/number field with `autocomplete="one-time-code"` even when the form contains no password field. Recovery-code signals are excluded from TOTP detection.
- The service gates integrated TOTP use on Premium access or organization TOTP permission. A matching vault login must contain the website's TOTP secret.
- Downloaded source snapshots are local, ignored artifacts. No installed browser-extension integration test was run; test coverage simulates whole-value input/change events and verifies actual login completion.

## Clarified Inline Workflow

The user specifically wants clicking the input to show Bitwarden's inline TOTP choices, without using the toolbar popup or shortcuts.

- In Settings > Autofill, enable `Show autofill suggestions on form fields`.
- Leave `Display suggestions when icon is selected` unchecked so focusing/clicking the field opens the suggestions immediately.
- The extension must be unlocked, and the matching login must contain a TOTP secret with integrated TOTP permission.
- Current `inline-menu-field-qualification.service.ts` recognizes `autocomplete="one-time-code"` as a TOTP field and gates the inline TOTP path on `premiumEnabled`.
- Current `autofill-overlay-content.service.ts` handles input focus and click by opening the inline menu, excluding read-only or disabled fields.
- The existing MFA input satisfies these page-side conditions after the pending challenge loads. No product-code change was required for this clarification. Actual installed-extension menu rendering remains unverified.

## User-Reported Missing Menu Investigation

The user reports that password filling works but TOTP suggestions remain absent. Production MFA JavaScript and CSS at `https://sso.azurekiln.cn` were fetched and matched the current local files after newline normalization.

The locally installed Chrome extension version is 2026.5.1. Its actual `content/bootstrap-autofill-overlay.js` was executed in an isolated Playwright browser against the MFA preview. Extension messaging/account responses were stubbed; no real vault data or account state was read. This is an installed-source integration probe, not a test of the user's unlocked extension.

| Stubbed premium status | TOTP detection | Menu listeners | Menu-open requests after click |
| --- | --- | --- | --- |
| true | true | attached | 3 |
| false | true | absent | 0 |

In both runs the actual collector reported `viewable=true`, `disabled=false`, `autocomplete=one-time-code`, and `isTotp=true`. This rules out basic field classification in the tested local DOM, but does not establish the user's real Premium status, URI match, browser, or menu rendering. Website CSP should not be relaxed without evidence that it is the blocking layer.

Pending user details: tested URL/browser, and whether other websites' TOTP fields show the inline menu or only password fields do. No speculative product change was made while these distinctions remained unknown.
