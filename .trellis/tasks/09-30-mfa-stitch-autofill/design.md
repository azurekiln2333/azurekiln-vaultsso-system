# MFA Entry Design

## Boundary

The gap is a plain MFA form instead of the supplied Stitch composition. Presentation and input interaction live in the MFA HTML, a dedicated stylesheet, and its existing page script. The existing pending/complete API contract remains `{ code }`.

## Input Contract

Keep `#code` as the only real code input. It occupies the entire six-slot entry area and remains visible to accessibility and autofill APIs. Decorative slots are `aria-hidden`; their characters and active slot mirror native input values and selection. Handle both `input` and `change` so extension filling updates the slots. Native input behavior handles paste, deletion, selection, and keyboard navigation. Clicking a slot sets the native selection position.

TOTP and email entry use six characters, numeric input mode, and `autocomplete="one-time-code"`. An explicit recovery-mode button changes the same input to normal visible text, a 32-character limit, and text input mode. Clear the value only when changing mode or after rejected verification. Keep manual verification submission.

Use `verificationcode` as the initial disabled field name, then `totp_code`, `email_code`, or `recovery_code` according to the active challenge/mode. Firefox can return an empty `input.autocomplete` property for `one-time-code`; Bitwarden reads this property, so an explicit authenticator field name is necessary for its independent TOTP heuristic. The input ID and API JSON key remain `code`.

## Presentation And State

Use local fonts and the project's Material Symbols icons. Place the only verification card on a neutral full-height page. Keep language switching functional using `VaultI18n`, return-to-login using the validated challenge URL, and status below submit. Resolve factor/mode-specific translations again when the language changes. Disable mode switching while a request is pending and after terminal challenge failure.

## Compatibility And Rollback

Retain form, input, submit, status, instructions, and return-link IDs. No API or database changes. Restore only this task's frontend changes to roll back. Existing personal-center work must remain intact.
