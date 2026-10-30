# Implementation

- [x] Replace the MFA markup with the supplied composition and add scoped responsive CSS.
- [x] Implement single-input slot rendering, recovery mode, and localized factor state.
- [x] Add translations without disturbing existing account-page work.
- [x] Extend `tests/password-mfa-browser.cjs` for paste, editing, extension-style events, TOTP, recovery, terminal errors, and language switching.
- [x] Exclude the new source design directory from production script-reference checks, following the existing reference-directory exclusion.
- [x] Run `npm run check`, focused password-MFA browser checks, and the required browser suite. Full-suite limitation is documented in validation.md.
- [x] Inspect desktop/mobile screenshots and review the diff with `trellis-check`.
- [x] Record verification and summarize Bitwarden prerequisites and testing limits.
- [x] Reproduce Firefox's empty autocomplete DOM property with official Bitwarden content code; use factor-specific field names, verify TOTP recognition/menu requests in both engines, and add naming/mode restoration browser regression checks.
- [ ] Confirm the actual unlocked-vault Firefox dropdown after deploying the corrected page/script.
