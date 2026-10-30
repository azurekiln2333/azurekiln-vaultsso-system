# Flat admin surface design

## Boundaries and reference

The child owns admin shell and content styling plus strictly necessary admin markup/cache references. Use the read-only local reference at `D:/My2KProjects/codebuddy2api-ui_template` for neutral canvas, inset white workspace/panels, clear filter/action/table hierarchy, and restrained density. Keep VaultSSO branding and palette.

The parent research note `research/admin-surfaces.md` records actual shared-background consumers, local-reference anchors, and admin/embed selectors. The actual baseline screenshot `admin-overview-users-zh-desktop-1280.png` confirms that the admin landing page currently shows a large blue decorative gradient around otherwise white controls and tables.

## Surface composition

Use existing `--surface-page` (`#f8f9fb`) for the page canvas and `--surface-card` (`#ffffff`) for content panels. Explicitly replace the full `background` value where necessary; changing only `background-color` leaves gradient images visible. Clear decorative page-background images on the admin shell and every administrative content page, both embedded and directly opened.

Scope the correction to admin CSS using existing `html[data-admin-shell]` and `html[data-admin-page]` hooks, and give `.admin-shell-iframe` an explicit neutral background. These attributes exist at parse time. The shared `.vaultsso-page-surface` also has a public API-docs consumer; do not globally flatten it or change public auth/account/docs styling. Reuse the existing embed attributes rather than changing iframe routing or messaging.

Keep the already compact 32px controls/28px small actions. Align page padding and panel/filter/table/form spacing to the existing 4px scale: 24px page inset on desktop, 16px on mobile, 16px between related sections, and 8px between related controls where layout allows. Prefer the existing 12px panel-radius token, 8px control radii, thin borders and shadowless primary panels as in the reference. Preserve responsive filters, table horizontal scrolling within their container, narrow-screen action wrapping and drawer navigation. Do not hide legitimate table columns to make screenshots fit.

Review card grouping, muted explanatory text, primary/secondary action hierarchy, row density, and empty/loading states against the local reference. Prefer the shared `.napi-*` patterns already present. Remove contradictory admin-only declarations instead of appending another global override layer. Keep selectors used by JavaScript and every existing administrative field/action.

The baseline's long generated usernames/IDs inflate its single user row to 121px. Reuse existing truncation/wrapping patterns to keep metadata from dominating rows while retaining access to full values. Do not impose a fixed row-height cap that clips content, or demand zero internal horizontal scrolling for a genuinely wide table. Review realistic and long-value rows rather than relying on the one seeded record.

## Files and compatibility

Expected implementation area: `public/css/vaultsso-admin.css`, `public/css/vaultsso-admin-pages.css`, and only those `views/admin/*.html` that require an explicit hook or affected cache-version update. Shared base CSS, generated utilities, backend routes and admin JavaScript are outside the default edit set; justify any expansion before editing.

There are no data-contract, storage or authentication changes. Small brand-mark gradients are separate from main-content surfaces. Do not add a replacement gradient or decorative background image to compensate for the flattened canvas.

## Rollout and rollback

Update affected CSS URL versions with the scoped change so a browser refresh receives the corrected styling. Verify both parent shell and iframe after cache updates. The admin-only CSS/markup changes can be reverted independently of MFA; no migrations or external actions are required.
