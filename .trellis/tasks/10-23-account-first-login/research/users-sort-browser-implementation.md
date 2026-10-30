# Admin user-table sorting — browser regression

Owner: `w1Q:p6` (browser regression, exclusive). Contract: `research/users-sort-contract.md`.
Frontend implementation frozen by `w1Q:p5` (`research/users-sort-frontend-implementation.md`).
Artifacts: `tests/user-table-sort-browser.cjs`, `.artifacts/user-table-sort/*.png`,
`package.json` → `check:browser`. No product file was edited by this owner.

## Status

**PASS** — 14 scenarios × desktop 1440 / mobile 390 (28 browser passes). Run:

```powershell
node tests/user-table-sort-browser.cjs
```

Registered as the tenth group in `check:browser` (after `tests/turnstile-browser.cjs`); the existing
nine groups are untouched. Root still owns the full aggregate run.

## Header surface driven by the test

The frontend owner delivered the sortable surface in `views/admin/users.html`:

```html
<th scope="col" data-sort-column="<key>" aria-sort="none">
  <button class="admin-sort-btn" type="button" data-sort="<key>">label<span class="admin-sort-arrow"></span></button>
</th>
```

Keys, in column order: `user, email, phone, identity, role, mailbox, ban, created`. The operations
column carries none. The visible direction indicator is a CSS-generated `::before` glyph driven by
`aria-sort` (`\25B2` ascending, `\25BC` descending), so the test asserts the **computed pseudo-element
content** of the active header (and that no inactive header carries a glyph) instead of a hard-coded
glyph node.

## Fixture and dataset

Isolated in-memory fixture, one dataset seeded per viewport, real two-step admin login, then
`/users.html`. Every column gets a genuine boundary rather than a mirror of the comparator:

| Column | What the dataset exercises |
| --- | --- |
| `user` | 排序用户1 / 排序用户2 / 排序用户10 (natural numeric), a name-less row that must fall back to its username, and two rows sharing 排序同名 for stability |
| `email` | mail1@ / mail2@ / mail10@ (natural numeric) and one unbound `import-<sha256>@users.invalid` that must stay last |
| `phone` | two numbered accounts (`+8613800000001`, `+8613800000003`), the rest unbound |
| `identity` | huawei and wechat bound rows (real `ExternalIdentity` records), the rest unbound |
| `role` | one `admin` among `user` rows |
| `mailbox` | unbound / unverified / verified all present |
| `ban` | one banned account among normal ones |
| `created` | seven distinct timestamps plus one corrupt (`not-a-date`) that must sort last and render 未记录 |

The corrupt timestamp is the only way to reach "missing/invalid dates stay last": `User.create`
coerces invalid input to `now()`, so the row is written and then broken in place. This is disclosed
test instrumentation, not product behaviour.

Rows created by the fixture itself (the login administrator) interleave with the dataset, so
ordering assertions run on the **dataset subsequence**, while the "empty value stays last" checks run
**globally** over every rendered row — so an unexpected extra row cannot silently invalidate them.

## Scenario matrix

| # | Scenario | What it proves |
| --- | --- | --- |
| 1 | Header surface and initial response order | Eight `data-sort-column` headers in column order with their labels and their own `data-sort` button; operations has no key and no button; every control is a real focused `BUTTON`; no column is pre-sorted on load; the table order equals the `/api/users` response order exactly; the name-less row renders 未设置姓名 and the unbound mailbox renders 未绑定邮箱 |
| 2 | User column natural order, toggle and stability | 用户1 < 用户2 < 用户10; every non-tied row is exactly reversed descending; the shared-name pair keeps its original relative order in **both** directions; a third activation returns to the identical ascending order |
| 3 | Email column natural order and unbound last | mail1 < mail2 < mail10; the unbound address is last ascending **and** descending; populated addresses reverse |
| 4 | Phone column with absent numbers last | Numbered accounts ascend by number and reverse descending; 未绑定手机号 stays last in both directions |
| 5 | Third-party accounts with unbound last | huawei < wechat and reverse; 未绑定 stays last in both directions |
| 6 | Role category order | Ascending groups every ordinary user before every administrator; descending puts the administrator first; row count is preserved |
| 7 | Mailbox state category order | Ascending groups unbound → unverified → verified (the frozen rank 0/1/2); descending is the exact reverse category order; row count preserved |
| 8 | Ban state category order | Ascending groups 正常 before 已封禁; descending puts 已封禁 first |
| 9 | Creation time order with an invalid date last | Real timestamps order exactly ascending and reverse descending; the corrupt date renders 未记录 and stays last both ways |
| 10 | Sorting retained across the search filter | With `created` ascending, `#searchInput` narrows to the dataset rows and they keep the active order; clearing restores **every** API row (count taken from the API, not hard-coded) and the complete list is still sorted — the stored list was not mutated or narrowed |
| 11 | Sorting retained across refresh | `#refreshBtn` re-reads `/api/users` and the active column, direction and row order survive |
| 12 | Keyboard activation | Focus + `Enter` sorts ascending and focuses a real button; Space toggles to the exact descending order |
| 13 | Row actions under an active sort | The row edit action navigates to `/user.html?id=<that row>` while sorted; a role change through the row select persists, re-renders, and does not drop the active sort |
| 14 | Local-only sorting and overflow containment | Clicking all eight headers issues **zero** `/api/users` requests; the document never overflows horizontally and the table stays inside `.napi-table-scroll` |

`pageerror` collections are asserted empty for both viewports.

## Measurements

```
desktop 1440px: document overflow 0px, table 1160/1134px (scrolls inside its container)
mobile  390px: document overflow 0px, table 1160/356px (scrolls inside its container)
```

At 1440 the table exceeds its scroll container by ~26px with this dataset; the wide user column is
driven by the 36-character UUID rendered in the `<code>` id line of every row, so the table is
container-scrolled even before any sorting. The contract explicitly keeps the table scrolling inside
its container, the document itself never scrolls sideways at either width, and scenario 13 confirms
the row actions still navigate and edit. No product defect.

## Fixes made during this run (all test-side)

1. **Origin guard.** The first attempt logged in against a fixture on a random port without pinning
   `PUBLIC_BASE_URL`, so discovery was rejected with `403 A same-origin browser request is required`.
   The suite now reserves a port, sets `PUBLIC_BASE_URL` and `COOKIE_SECURE=false`, and creates the
   fixture on that port — the same pinning the other browser suites use.
2. **Expected arrays omitted the empty rows.** The dataset-order assertions initially listed only the
   populated rows; the actual orders were correct (unbound email and the invalid date last). The
   expectations now include those rows, and the row-count checks derive from the API response and the
   seeded dataset instead of literals.

Neither change weakened an assertion, and neither indicated a product defect.

## Screenshots

28 PNGs in `.artifacts/user-table-sort/`: 14 states × desktop 1440 / mobile 390. Every screenshot is
preceded by a document-overflow assertion (`scrollWidth <= innerWidth + 1`).

`sort-initial`, `sort-user-asc`, `sort-user-desc`, `sort-email-asc`, `sort-phone-desc`,
`sort-identity-desc`, `sort-mailbox-asc`, `sort-mailbox-desc`, `sort-created-desc`,
`sort-retained-after-filter`, `sort-retained-after-refresh`, `sort-retained-after-update`,
`sort-keyboard-descending`, `sort-overflow-containment`.

Spot-checked: `sort-user-asc` shows the ▲ indicator on 用户 with 用户1/用户2/用户10 in natural order;
`sort-created-desc` shows ▼ on 创建时间 with newest first and the corrupt row last rendering 未记录;
`sort-overflow-containment` at mobile shows the table scrolling inside its panel with no page-level
sideways scroll.

## Stability

Frontend source frozen; the run above was against the frozen implementation. `w1Q:p4`'s comparator
review passed with no product fixes pending. Only `tests/user-table-sort-browser.cjs` and the
`package.json` `check:browser` line are owned/changed here; no product edits, no backend changes.