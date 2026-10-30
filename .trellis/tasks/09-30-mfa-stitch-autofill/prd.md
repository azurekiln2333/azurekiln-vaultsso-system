# MFA Stitch layout and TOTP autofill

## Goal

Apply the supplied `stitch_mfa(1)` visual design to `/oauth2/mfa` and make TOTP entry compatible with Bitwarden filling.

## Requirements

- Follow the reference's centered verification card, lock icon, six code slots, primary verify action, and quiet page header/footer.
- Use real challenge data and the existing verification endpoints. Keep pending OAuth continuation and server verification behavior intact.
- Preserve email-code verification, TOTP verification, recovery-code verification, visible errors, and return-to-login behavior.
- Support typing, pasting an entire code, and extension-style filling into one visible, enabled input with `autocomplete="one-time-code"`.
- The intended Bitwarden workflow is to click the code input, see the extension's inline TOTP dropdown, and select a code without opening the toolbar popup. The website exposes a recognizable input; the browser extension owns menu display and its settings.
- Keep the page responsive and translate new text in Simplified Chinese, Traditional Chinese, and English.
- Preserve existing unrelated work in the dirty worktree.

## Acceptance Criteria

- [x] Desktop and mobile screenshots match the supplied layout's primary composition without overflow.
- [x] Email codes and TOTP codes render correctly in the six slots and successfully complete login.
- [x] Recovery-code mode supports the full code and completes login.
- [x] Native keyboard editing, paste, and input/change events from an extension update the displayed code.
- [x] Errors remain visible after submission; expired or locked challenges cannot be submitted again.
- [x] Language switching updates factor-specific text without clearing entered codes.
- [x] Project checks and focused real-browser verification pass.
- [ ] The user confirms that clicking the MFA input shows the TOTP choices in their actual unlocked Bitwarden environment. User clarified that Chrome works and Firefox fails. Firefox's missing autocomplete DOM token was reproduced; explicit TOTP naming restores actual extension-code classification and menu requests under simulated permission responses. Actual unlocked-vault dropdown confirmation remains pending after deployment.

## Background And Constraints

- `views/auth/mfa.html` and `public/js/pages/auth/mfa.js` own the current standalone MFA page.
- Bitwarden's current source recognizes `autocomplete="one-time-code"` even on forms with no password input. Official browser-extension docs support manual/shortcut/inline TOTP filling, but exclude page-load TOTP autofill.
- The installed Chrome extension's content script and official Firefox 2026.9.0 content script were exercised in their respective real browser engines with simulated extension permission responses. These probes verify recognition/listeners/menu requests, not the user's vault or actual dropdown rendering. Do not claim the latter was tested.
- The reference's resend button has no matching pending-challenge endpoint. Its sample avatar, device/location, certifications, and placeholder navigation are outside this task.
- No automatic submission on the sixth digit, new backend endpoints, password-manager secrets, authentication-policy changes, or unrelated account-page redesign.
