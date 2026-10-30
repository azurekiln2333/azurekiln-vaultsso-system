# Visible authentication feedback

## Goal

Place sign-in sign-up and recovery feedback next to submit actions and prevent untranslated message keys

## Requirements

- Login, registration and recovery feedback appears immediately below each active form's primary submit button.
- New feedback enters the viewport after submission, including long/mobile registration forms; visible plain language and accessible live announcements.
- Unknown message/error translation keys never become visible status text; use backend human description or a translated readable fallback. Preserve dynamic password-policy details.
- Keep existing auth form layout, endpoints, validation and localization conventions.

## Acceptance Criteria

- [x] Mismatched registration/recovery passwords display readable feedback under submit without issuing a request.
- [x] Invalid login credentials and backend password-policy errors display at the bottom and in the viewport at desktop/mobile widths.
- [x] Known messages resolve in Chinese/English; unknown keys fall back to descriptions and generic text without leaking keys.
- [x] Existing smoke checks and focused browser/message-resolution regressions pass.

## Notes

- Verification: 9 multilingual message tests passed; syntax/reference checks passed for 69 files; complete `npm run check:browser` passed including prior profile/admin phone features and new auth checks at 1440px/390px.
- Review additionally fixed same-form stale response ordering and live-region accessibility; browser regression covers a delayed email-send response after a newer password error.
- Conditional fields now respect hidden attributes despite grid styles. Screenshots saved in ignored `.artifacts/`.
- No commit created; existing worktree edits preserved.

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
