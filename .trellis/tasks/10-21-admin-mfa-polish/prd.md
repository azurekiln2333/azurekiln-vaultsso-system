# Polish admin surfaces and MFA verification

## Goal

Give the admin panel the restrained, flat appearance requested by the user, using the existing local New API reference, and make MFA code entry proportionate and faster to complete.

## Requirements and ownership

- R1: Remove the decorative gradient from admin main content and align shell, panels, filters, tables and forms with the restrained New API reference. Owned by `10-21-admin-flat-surfaces`.
- R2: Rebalance the MFA title, code entry, spacing, and action proportions on desktop and mobile. Owned by `10-21-mfa-compact-auto-verify`.
- R3: Automatically attempt verification after a complete six-digit authenticator or email code is entered, pasted, or autofilled; navigate only after successful verification. Owned by the MFA child.
- R4: Preserve manual submission, recovery-code entry, localized feedback, failed-code retry, and existing OAuth continuation. Owned by the MFA child.

## Task map

| Child | Owns | Integration acceptance |
| --- | --- | --- |
| `10-21-admin-flat-surfaces` | R1 | Flat admin shell and embedded content, consistent cards/forms/tables and responsive layout |
| `10-21-mfa-compact-auto-verify` | R2-R4 | Balanced MFA presentation, exactly one automatic attempt per completed edit, correct success/error behavior |

## Evidence

- R1: `public/css/vaultsso-base.css:92` supplies the rejected gradient to all eight admin documents as well as public API docs. Both the shell and its iframe paint it independently. `research/admin-surfaces.md` lists all consumers and the local reference's actual primitives.
- R2: `public/css/vaultsso-mfa.css:163` retains an 80px row while the later alignment block at `:395` reduces its companion controls; recovery mode at `:230` inherits the oversized row. `research/mfa-layout.md` records the cascade and proportions.
- R3/R4: `public/js/pages/auth/mfa.js:110` owns verification and navigation, while `:142` binds the input/change events without automatic submission. `research/mfa-auto-verify.md` maps the existing contract and affected browser assertions.
- Current rendered baselines and measured dimensions are under ignored `.artifacts/admin-mfa-polish/baseline/`, indexed in `research/visual-baseline.md`. Historical acceptance records are not a substitute for this request's visual review.

## Constraints

- Work in `D:/MyNewWebProjects/azurekiln-oauth2`, reusing the four existing Pi panes through Herdr; do not create another worktree.
- Use the local read-only reference `D:/My2KProjects/codebuddy2api-ui_template` and the existing VaultSSO palette.
- Preserve the completed OAuth login cleanup and unrelated workspace changes.
- R3 explicitly supersedes the no-auto-submit clause in `.trellis/spec/frontend/auth-feedback.md:19`; update the spec and browser contract together.

## Acceptance criteria

- [x] AC1 (R1): Admin landing/users, clients and representative settings pages show neutral flat canvas and white panels, restrained borders/radii/shadows, consistent control density and no decorative content gradient or iframe seam in embedded/direct access.
- [x] AC2 (R2): MFA uses proportionate 48px desktop/44px mobile code rows, 20px/18px headings, a 36px primary action and a 40px recovery field; localized text wraps naturally without clipping or horizontal overflow.
- [x] AC3 (R3): Typing, pasting, and autofilling six digits trigger verification once; incomplete input does not submit, and pending requests cannot duplicate.
- [x] AC4 (R4): Invalid codes show feedback without navigation, allow correction/retry, and terminal errors preserve existing lockout handling. Recovery codes remain manually submitted.
- [x] AC5 (R1-R4): Current relevant browser/security checks pass, desktop/mobile before/after screenshots are inspected, and navigation, native editing, autocomplete names and existing public-page appearance remain intact.

## Out of scope

- Backend authentication, API payloads, database schema, MFA policy, or OAuth redirect trust changes.
- New navigation architecture/inset-workspace reconstruction, new branding, feature additions, or rewriting public login/account/docs pages.

## Planning status

This parent and both children have reviewed PRDs, designs, execution plans and validated context manifests. On 2026-10-21 the user approved the final planning summary and instructed immediate dispatch and implementation ("分派任务下去立马做"). No blocking product decisions remain.
