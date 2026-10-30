# User-list sorting follow-up

Authorized by the user's request to click admin user-list headers to sort. The user subsequently selected immediate missing-account discovery feedback; that separate login change is recorded in `unknown-account-contract.md` and does not widen sorting ownership.

## Change boundary

The current complete `/api/users` response is filtered in `public/js/pages/admin/users.js`, then rendered in response order. Add local sorting of this complete filtered array. No API, database, pagination or import transport change is needed. Preserve existing auth gates, imports, role/ban/delete/detail actions, data escaping and unrelated admin layout. Do not introduce a general table framework or a dependency.

Expected product files: `public/js/pages/admin/users.js` (state/comparison/render), `views/admin/users.html` (semantic sort controls and JS/cache reference), and minimal page-scoped controls in `public/css/vaultsso-admin-pages.css` if existing styles are insufficient. Do not overwrite prior uncommitted styles. Baseline: `users-sort-baseline.json`.

## Behavior

- Eight data headers sort: user, email, phone, third-party accounts, role, mailbox state, ban state and creation time. Operations is not sortable.
- First activation of a new column is ascending, repeated activation toggles descending/ascending. Preserve the initial response order before any column is chosen.
- User sorts by visible name with username/ID fallback. Text compares naturally using Chinese-aware numeric collation; timestamps compare actual dates, roles/statuses use defined values. Empty/unbound synthetic mailbox addresses, absent phones/providers and missing/invalid dates stay last in either direction. Mailbox state is a meaningful category: ascending unbound -> unverified -> verified, descending reversed. Role ascending is user -> admin; ban ascending is normal -> banned. The missing-value rule does not override the explicit mailbox-state category order.
- Sort the filtered copy rather than mutating the stored complete list. Keep sorting across search/filter, refresh and successful role/ban updates during the current page session. Equal values retain stable order.
- Use real buttons in scoped column headers, keyboard accessible, with a visible direction indicator and accurate `aria-sort` on the active header. Keep table scrolling within its container at mobile width. Existing rows/actions remain usable.
- No sort request to the server; no new persistent browser storage. Update users-page affected asset cache versions without changing unrelated pages' layout.

## Ownership / verification

- Existing Herdr Pi `w1Q:p5`: implement product files above; no tests or backend edits.
- Existing `w1Q:p6`: focused browser regression and its `package.json` registration, coordinating selectors with p5; no product edits. Test observable row orders/directions, text with numeric suffixes, timestamps, empty handling, stable ties, filter/refresh/update retention, keyboard and existing row actions; desktop/mobile screenshots.
- Existing `w1Q:p3`: read-only discovery/security explanation and sorting contract review if needed; no backend mutation unless a subsequently confirmed discovery-policy change is dispatched.
- Existing `w1Q:p4`: independent focused test/data/contract review; no product ownership in this expansion unless assigned.
- Root: task/spec integration, source/baseline review and aggregate checks. Independent `trellis-check` review follows implementation. No commit/push/deploy/archive.
