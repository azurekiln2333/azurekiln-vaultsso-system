# Admin surfaces execution plan

## Preconditions and ownership

- Wait for explicit approval of the parent final planning summary and activate this child before implementation.
- Read this PRD/design, both manifests, and the parent admin/background and baseline research notes.
- Reuse Pi `w1Q:p3` as admin implementer, owning the scoped admin CSS/markup. Pi `w1Q:p6` independently reviews browser results. Preserve other workers' changes; no new agents/worktrees, lifecycle operations, or git mutations by workers.

## Ordered work

1. Confirm the shared-gradient consumer audit and choose explicit admin hooks. Replace the full shell and content background declarations with flat surface tokens in the owning admin stylesheet(s), covering embedded and direct access.
2. Align main-content panel/table/filter/form density, borders, radii, spacing and action hierarchy to the local reference within the existing layout and palette. Keep all selectors, routes and actions working.
3. Remove superseded admin-only style conflicts; update affected CSS URL versions. Keep shared public backgrounds and generated utility CSS outside the edit set.
4. Capture and inspect actual before/after screenshots for the admin landing/users view, clients table/form, and a settings form. Check sidebar expanded/collapsed states, mobile drawer, embedded and directly opened content.

## Verification

- Compare reference principles and baseline screenshots at 1280px/1440px and 390px, with a 320px/360px overflow check; cover Chinese and English.
- Assert computed page surfaces have no background image and use the intended flat canvas/panel colors. Check iframe/shell consistency and container-bounded table scrolling. Inspect screenshots manually for visual balance; CSS-value assertions alone do not meet acceptance.
- Wait for deterministic page/account initialization when capturing final evidence; do not use `networkidle` in place of actual UI readiness.
- `npm run check:syntax`
- `node tests/browser-smoke.cjs`
- Parent integration runs `npm run check:browser` once. Add a persistent test only for meaningful uncovered behavior; do not add tests that merely mirror CSS declarations.
- Use the isolated in-memory fixture; do not connect real database/mail or change real user data.

## Review and rollback

Record delivered files, current screenshots, command results and any limitations in `validation.md`. Independent review must confirm the visual reference was applied to the rendered main content. Notify the parent without committing or archiving. If needed, revert only this child's scoped admin CSS/markup changes while preserving MFA work.
