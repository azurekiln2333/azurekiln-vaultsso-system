# Flatten admin panel surfaces

## Goal

Deliver parent requirement R1: make the admin shell and embedded pages visually consistent with the flat, restrained local New API reference.

## Requirements

- Remove decorative gradients from the admin shell, landing content, and table/form page backgrounds.
- Use the existing neutral page and white-card palette with restrained borders/shadows, token-based panel radii, spacing, and control density aligned with the local reference.
- Preserve unrelated public surfaces and cover both embedded and directly opened admin pages.
- Preserve current navigation, iframe routing, administrative actions, responsive behavior, and localization.

## Evidence

- `public/css/vaultsso-base.css:92` paints the gradient; admin bodies at `views/admin/index.html:14` and seven content views consume it, as does public `views/docs/api.html:12`.
- `public/css/vaultsso-admin.css:467` leaves the iframe background unspecified. The measured shell and embedded document each paint the shared gradient.
- Local `src/theme.scss:13` and `src/ui.module.scss:607` in the read-only reference establish the flat page/white bordered-panel treatment. Full consumer and primitive anchors are in parent `research/admin-surfaces.md`.

## Acceptance criteria

- [x] The rendered admin shell, landing/users view, clients table/form, and settings form use flat surfaces without visible background seams in embedded/direct access.
- [x] Desktop and mobile screenshots show restrained spacing and proportionate cards, controls, and tables aligned with the local reference.
- [x] Chinese and English do not clip, overflow, or obscure navigation and actions.
- [x] Existing admin browser navigation and functional checks still pass.

## Constraints and exclusions

- Parent: `10-21-admin-mfa-polish`; implementation can proceed independently of the MFA child after parent planning approval.
- Reference project is read-only. No backend, route, permission, feature, branding, public-page redesign or new inset workspace structure.
- The user approved the parent final planning summary on 2026-10-21 and instructed immediate implementation.
