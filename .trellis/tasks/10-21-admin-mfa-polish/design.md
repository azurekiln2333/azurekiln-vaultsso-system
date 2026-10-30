# Admin surfaces and MFA design

## Boundaries

This parent integrates two independent frontend deliverables. The admin child owns shell/content styling; the MFA child owns the dedicated MFA presentation and code-completion behavior. There is no backend, API, database, policy, or navigation-architecture change.

The read-only visual reference is `D:/My2KProjects/codebuddy2api-ui_template`. Existing VaultSSO colors and component tokens remain authoritative. Copy layout principles, density, and hierarchy rather than importing another application's dependencies or features.

## Admin presentation

Use a neutral flat page canvas, white panels, restrained borders and shadows, and consistent token-based radii. Make shell and embedded content backgrounds agree in both embedded and direct-entry modes. Audit all consumers of the shared gradient before choosing the admin-specific override. Review the whole main content composition, including cards, table/filter bars, and forms, rather than checking only the body declaration.

Retain the sidebar, header, responsive drawer, routes, iframe selectors, and existing administrative actions. Small isolated brand marks are separate from the rejected decorative main-content background.

## MFA presentation and behavior

Consolidate the conflicting original/late override CSS into coherent rules for the card, heading, code row, button, and mobile layout. Keep `#code` as the single real input and the six slots decorative. Retain localized labels, recognisable factor-specific input names, autocomplete attributes, recovery mode, native editing, selection, and paste.

Complete six-digit TOTP/email input enters the existing form-submit path. That path remains the sole owner of request locking, feedback, the completion request, and navigation. Completion events must not create a second fetch path. Incomplete, recovery, composing, disabled, read-only, initializing, or already-pending states do not auto-submit. Repeated notifications of an unchanged complete value must not create duplicate attempts; a fresh edit after failure can attempt again.

The completion API remains `POST /api/v1/auth/oauth/oidc/complete` with `{ code }`. Only a successful response that passes existing same-origin redirect validation permits navigation. Preserve failed-code clearing/focus and terminal 401/429 handling. Mode/language rendering alone cannot submit. Keep manual verify as a fallback.

## Compatibility and contracts

The user's explicit automatic-verification request supersedes the old `auth-feedback.md` prohibition. Update that single frontend contract and its browser assertions with the implementation. Do not weaken server-side MFA/session checks or report simulated autofill as real extension testing.

Product asset URLs affected by CSS/JS edits need the repository's existing cache-version convention updated so browser review sees the delivered changes.

## Evidence and rollback

Each child has its own PRD, design, execution plan, and curated context. The four research notes under `research/` contain source anchors and baseline findings. Acceptance requires actual rendered comparisons plus relevant browser checks; static radius/selector checks alone cannot establish visual quality.

The two product changes can be reverted independently. There are no migrations or stored-state changes. Review and stage only the scoped product changes, tests, spec contract, and this task tree; preserve unrelated untracked tooling.
