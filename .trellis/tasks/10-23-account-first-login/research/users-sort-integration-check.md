# User-table sorting — independent integration check

Reviewer: `/root/check_user_sort` (`trellis-check`). Task: `10-23-account-first-login`.
Ownership: this report only. No product, test, package or spec edits; no aggregate execution.

## Findings (fixed)

None. No actionable integration defect was found in the frozen sorting implementation.

## Findings (not fixed)

None within the sorting follow-up. Unknown-account discovery policy remains outside this review;
the current backend/login sources are unchanged from the fresh sorting baseline. The pre-existing
malformed-mailbox display/gate difference is already recorded in `users-sort-review.md` A9 and is
not a sorting regression.

## Baseline and change boundary

Compared the three product files against the exact snapshots in
`D:\AppData\Local\Temp\users-sort-followup-sr70qgav`, recorded in `users-sort-baseline.json`:

- `public/js/pages/admin/users.js`: sorting helpers/state, `renderUsers()` integration, and header
  click listeners only. The raw-file import transport, byte limits, grouped import results,
  role/ban/delete/detail actions and existing row rendering are unchanged.
- `views/admin/users.html`: eight semantic sorting buttons plus the affected CSS/JS cache tags.
  The operations header stays plain; header/row alignment and the nine-column empty state remain valid.
- `public/css/vaultsso-admin-pages.css`: sorting-control rules inserted in the existing table section,
  plus the users-only bounded scroll rule inside the existing mobile breakpoint. Prior rules remain intact.

SHA-256 of `server.js`, `public/js/pages/auth/login.js`, `public/js/shared/i18n.js` and
`views/auth/login.html` exactly matches the manifest. This extension changes no backend or login policy.
Comparator semantics were independently reviewed by p4; its closed findings are retained, not reopened.

## Assets, containment and accessibility

- Users-page CSS and JS references both use `v=20261025-users-sort-1`. Repository search confirms the
  new sorting classes/attributes are used only by the users surface. Other admin consumers do not
  acquire a changed layout, so their unchanged CSS references need no follow-up bump for these rules.
- The mobile overflow rule explicitly targets `html[data-admin-page="users"] .napi-table-scroll`;
  the existing table wrapper and responsive layer remain in place.
- All eight controls are actual `button type="button"` elements inside `th scope="col"`. The active
  header owns `aria-sort`; inactive headers are cleared on every render, including the empty result.
  Decorative arrows have `aria-hidden`, matching visible CSS glyphs, and controls have a visible
  `:focus-visible` outline. Headers are outside tbody row action/navigation handlers.
- Existing import completion, refresh and user updates all reach `renderUsers()`, so the same active
  sort is applied. No duplicate rendering path or new server request is introduced.

Reviewed actual screenshots `sort-user-asc-desktop-1440.png` and
`sort-overflow-containment-mobile-390.png`: the direction marker is visible, the wide table remains
inside its panel, and the mobile page has no horizontal spill. Existing table content is accessible
through container scrolling.

## Browser regression review

`tests/user-table-sort-browser.cjs` drives an isolated real fixture server, actual account-first
administrator login, the served users page, real header clicks and DOM row IDs. It creates users,
phone data and external identities; expected boundary orders are independent observable values.
The invalid timestamp is explicit fixture instrumentation rather than a product stub.

The final test covers all eight keys/directions, numeric text, missing raw values in both directions,
real timestamps, stable ties, initial response order, ARIA/glyphs, keyboard Enter/Space, search and
refresh retention, actual detail navigation, successful role update retention, local-only sorting,
page errors and desktop/mobile overflow. Search-filter retention is exercised directly; the mailbox
filter and import retention share the reviewed unchanged render path. The existing import suite
remains registered.

`package.json` appends the new test as browser group ten without changing the previous nine groups.
The browser owner's final report records **14 scenarios × two viewports passing**, with 28 screenshots;
that execution evidence is owned by p6/root, not claimed as a separate reviewer run.

## Verification

- Lint: no standalone lint script is configured in `package.json`.
- TypeCheck: no TypeScript/type-check script is configured.
- Focused syntax: `node --check public/js/pages/admin/users.js` — pass (exit 0).
- Focused test syntax: `node --check tests/user-table-sort-browser.cjs` — pass (exit 0).
- Browser: p6 reports 28 scenario passes; final aggregate and acceptance belong to root.
- No aggregate/API/browser test rerun by this reviewer; no commit, push, deployment or archive.
