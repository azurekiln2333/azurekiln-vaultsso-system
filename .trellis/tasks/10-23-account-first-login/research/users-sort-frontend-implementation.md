# User-table sorting — frontend implementation report (p5)

Task: `.trellis/tasks/10-23-account-first-login` (sorting follow-up)
Owner: Pi `w1Q:p5` (auth/admin frontend). Status: **implementation complete and stable; handed to root/p6.**

Authoritative contract: `research/users-sort-contract.md`. Baseline: `research/users-sort-baseline.json`.
No backend, test, `package.json`, spec or login-discovery change. No commit/stage/reset/deploy/archive.

Files changed by this follow-up (exactly the exclusive ownership set):

| File | Change |
| --- | --- |
| `public/js/pages/admin/users.js` | sort state, column accessors, comparators, header rendering/wiring; `renderUsers()` integration |
| `views/admin/users.html` | semantic sort header buttons + JS/CSS cache version bump |
| `public/css/vaultsso-admin-pages.css` | scoped sort-button/indicator styles + mobile bounded scroll for the users table |

All prior work is preserved: the import transport/10 MiB/optional-mail/grouped-results logic, the other
workers' dirty admin/MFA/login/auth styles and scripts, and this file's earlier `lg:px-8` and
`admin-flat` edits. Verified after the change that the import markers
(`postUserImport`, `IMPORT_MAX_BYTES`, `importResultSections`, `importedWithoutEmail`,
`IMPORT_DUPLICATE_REASON_CODES`, `openImportModal`, `renderImportLimits`) are all still present.

---

## 1. Folder of selectors for p6 (exact, frozen)

Table headers (`<thead>`), each data column now wraps a real `<button>`:

| Sort key | Header cell | Button | Visible label |
| --- | --- | --- | --- |
| `user` | `th[data-sort-column="user"]` | `th[data-sort-column="user"] button.admin-sort-btn[data-sort="user"]` | 用户 |
| `email` | `th[data-sort-column="email"]` | `… button.admin-sort-btn[data-sort="email"]` | 邮箱 |
| `phone` | `th[data-sort-column="phone"]` | `… button.admin-sort-btn[data-sort="phone"]` | 手机号 |
| `identity` | `th[data-sort-column="identity"]` | `… button.admin-sort-btn[data-sort="identity"]` | 第三方账号 |
| `role` | `th[data-sort-column="role"]` | `… button.admin-sort-btn[data-sort="role"]` | 角色 |
| `mailbox` | `th[data-sort-column="mailbox"]` | `… button.admin-sort-btn[data-sort="mailbox"]` | 邮箱状态 |
| `ban` | `th[data-sort-column="ban"]` | `… button.admin-sort-btn[data-sort="ban"]` | 封禁状态 |
| `created` | `th[data-sort-column="created"]` | `… button.admin-sort-btn[data-sort="created"]` | 创建时间 |

- Operations header is deliberately **not** sortable: the 9th `th` has no `data-sort-column` and no
  button, and keeps `class="text-right"`.
- Active direction is exposed on the header cell, not the button:
  `th[data-sort-column="<key>"]` has `aria-sort="none" | "ascending" | "descending"`.
  Exactly one header is non-`none` at a time.
- Direction indicator: `th[data-sort-column="<key>"] .admin-sort-arrow` (`aria-hidden="true"`); its
  `::before` content is `▲` when ascending and `▼` when descending, empty otherwise.
- Rows: `#userTableBody tr[data-user-id]` — `dataset.userId` is the user id; use this to assert order.
- Scroll container (mobile-bounded, users page only): `html[data-admin-page="users"] .napi-table-scroll`.
- Unchanged existing hooks: `#searchInput`, `#verifiedFilter`, `#refreshBtn`, `#importBtn`,
  `#importModal`, `#userTableBody`, `#statusBar`, `[data-role-id]`, `[data-ban-id]`, `[data-detail-id]`,
  `[data-delete-id]`.

Cache versions in `views/admin/users.html`: `/css/vaultsso-admin-pages.css?v=20261025-users-sort-1` and
`/js/pages/admin/users.js?v=20261025-users-sort-1`. Only the users template was bumped
(`vaultsso-admin.css` and other admin pages keep their existing versions).

## 2. Behaviour implemented

- **Eight data columns**, operations excluded.
- **First activation ascending; repeated activation toggles** desc ⇄ asc.
- **Initial order preserved** until a header is first clicked (no sort key ⇒ the `/api/users` response
  order is rendered unchanged).
- **Natural, Chinese-aware collation**: `Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })`
  so `用户2` sorts before `用户10`; guarded fallback if `Intl` is unavailable.
- **User column** compares the visible name, falling back to username then id.
- **Email column** compares the stored address (lower-cased); empty or `@users.invalid` placeholders are
  treated as unbound/**missing → last in both directions**.
- **Phone / identity columns**: absent phone or no third-party provider = missing → last both directions.
- **Created column** compares real parsed timestamps; missing/NaN dates = missing → last both directions.
- **Defined value orders** (never "missing"): role `user < admin`; mailbox
  `unbound < unverified < verified`; ban `normal < banned`.
- **Stable ties**: the filtered array is decorated with its original index and that index is the final
  tiebreaker, so equal values keep API order in both directions.
- **Filtered copy only**: `sortedUsers(filteredUsers())` — `allUsers` is never reordered or mutated.
- **Retained across** search/filter input, `#refreshBtn` reload, and successful role/ban updates, because
  the sort state lives in module scope and every `renderUsers()` re-applies it and refreshes `aria-sort`.
- **Keyboard + semantics**: real `<button type="button">` controls (tabbable, Enter/Space activate),
  accurate `aria-sort`, a `title` describing the next action, and `aria-hidden` arrows.
- **Mobile**: at ≤720px the users table scroll container gets `max-height: 70vh; overflow: auto` so
  scrolling stays inside the panel; no horizontal page overflow. Desktop keeps the existing
  horizontal-only container behaviour (sticky `th` still works).

## 3. Verification (focused, run by p5)

- `node --check public/js/pages/admin/users.js` → OK.
- `npm run check:syntax` → "Syntax and browser script references checked: 103 files".
- **Independent behavioural harness: 39/39 checks passed.** A throwaway Playwright-core headless
  Chromium harness kept OUTSIDE the repo at `%TEMP%\users-sort-harness.cjs` serves the real repo files and
  stubs `/api/users`, then drives the real `views/admin/users.html` + `users.js` DOM.
  Reproduction: `node %TEMP%\users-sort-harness.cjs <repo> <repo>\node_modules\playwright-core`.
  It asserts, against a deliberately unsorted fixture set:
  - initial order equals API order; eight sortable headers each carry a button; all `aria-sort="none"`
    initially; the operations header has no sort control;
  - `user` asc/desc with the `用户2` < `用户10` natural-numeric discriminator, empty-name username
    fallback, and the correct ▲/▼ `::before` indicator;
  - `email` asc/desc keeping unbound/synthetic rows last in **both** directions;
  - `created` asc/desc using real timestamps with an invalid date last in both directions;
  - stable ties (`用户2` rows keep API order a-before-b) in both directions;
  - role / mailbox / ban defined ranks;
  - sort + `aria-sort` retained across filtering, refresh, and a role update;
  - header control is focusable (real button) and activates on keyboard;
  - row action buttons still render;
  - at 390px the table scroll container scrolls both axes with a bounded height, the page has no
    horizontal overflow, and sorting still works.
- Not run by p5 (owned by p6/root): `tests/user-import-upload-browser.cjs`, the new sort browser test,
  `npm run check:browser`, and package registration. No visual screenshot review was produced here.

## 4. Notes for p6

- Coordinate the new browser test to click `th[data-sort-column="<key>"] button.admin-sort-btn` and read
  `aria-sort` on the header cell plus row order from `#userTableBody tr[data-user-id]`.
- Use non-ASCII/numeric data (`用户2` vs `用户10`) for the collation assertion, a synthetic/empty mailbox
  for the missing-last case, an invalid `createdAt` for the date case, and two equal sort values for the
  stable-tie case.
- Mobile bounded-scroll assertion: at ≤720px, `html[data-admin-page="users"] .napi-table-scroll`
  computed `overflow-x/y` are both `auto` and `max-height !== 'none'`.
- No login-discovery policy change was made or requested; the sorting change is frontend-only and issues
  no new network request.