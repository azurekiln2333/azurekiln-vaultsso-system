# User-list sorting — data/test review (read-only)

Reviewer: `trellis-check` (this session). Ownership: this file only. No product/test/CSS/package edits
were made; no aggregate run. p5 owns product, p6 owns focused tests, root owns integration.

Sources read: `research/users-sort-contract.md`, `research/users-sort-baseline.json`,
`public/js/pages/admin/users.js` (current working tree), `views/admin/users.html`,
`public/css/vaultsso-admin-pages.css`, `public/css/vaultsso-base.css`, `server.js`
(`serializeUser`, `GET/PUT /api/users`).

## 1. Landing state (important — tree is mid-flight)

| Surface | State |
| --- | --- |
| `views/admin/users.html` | **Landed.** Eight headers now wrap a real `<th scope="col" data-sort-column=… aria-sort="none">` + `<button class="admin-sort-btn" data-sort=…>` with an empty `<span class="admin-sort-arrow" aria-hidden="true">`. 操作 header untouched. |
| `public/js/pages/admin/users.js` | **Landed.** `SORT_COLUMNS`, `SORT_ROLE_RANK`, `SORT_MAILBOX_RANK`, `SORT_COLLATOR`, `sortColumnValue`, `compareSortColumn`, `sortedUsers`, `renderSortHeaders`, `toggleSort`; click wiring on `th[data-sort-column] .admin-sort-btn`. |
| `public/css/vaultsso-admin-pages.css` | **Landed.** `.admin-sort-btn` (inline-flex, `font: inherit`, hover, `:focus-visible` outline), `.admin-sort-arrow`, and `::before` glyphs driven by `th[data-sort-column][aria-sort="ascending"|"descending"]`. |
| Cache tags | **Bumped.** `users.js?v=20261025-users-sort-1` and `vaultsso-admin-pages.css?v=20261025-users-sort-1`. `vaultsso-admin.css` deliberately unchanged. |

All three surfaces have landed and the feature is reviewable end to end; see §5 for the concrete
verdict.

Column truth (verified consistent): header order `user, email, phone, identity, role, mailbox, ban,
created, 操作` = 9 `<th>`; the row builder emits 7 cells then `insertBefore(phoneCell, row.cells[2])`,
producing the same 9-cell order. Actions is correctly non-sortable; the empty-state `colspan="9"` stays
valid.

## 2. Payload semantics (ground truth for the sort keys)

`GET /api/users` → `[{ ...serializeUser(user), identities: [{provider, providerUserId}] }]`.
`PUT /api/users/:id` → `{ user: { ...serializeUser(updated), identities: […] } }` — **identities are
present on the update response too** (verified at `server.js` PUT tail), so `updateUser`'s
`allUsers[index] = payload.user` does not drop the third-party column.

Relevant fields:

| Field | Semantics |
| --- | --- |
| `name` | may be empty → cell shows literal `未设置姓名` |
| `username` | present (unique, required) |
| `email` | may be empty or a synthetic `import-<hash>@users.invalid` |
| `emailVerified` | boolean; **meaningless when the mailbox is unbound** |
| `role` | serializer lowercases → `'admin'` \| `'user'` |
| `banned` | boolean |
| `phoneE164`, `phoneNationalNumber` | raw values; empty when absent |
| `phoneMasked` | **display-masked string**, not a collation key |
| `createdAt` | ISO string **or `null`** (`serializeUser`: `… \|\| null`) |
| `identities` | array (possibly empty) |

## 3. Actionable findings (by priority)

### A1 — "stays last" must survive direction inversion (highest risk)
The contract pins empty/unbound/absent/invalid values **last in both directions**. The common
implementation `direction * compare(a, b)` floats them to the top when descending. Implement as a
**grouped comparator**: classify each value as *present* or *absent/sentinel* first, order present
values with the direction applied, and unconditionally append the sentinel group last (do not multiply
the sentinel branch by direction). This applies to `email`, `phone`, `identity`, `created`, and the
unbound branch of `mailbox`.

### A2 — mailbox sort key must be a 3-way rank, not `emailVerifiedState`
`emailVerifiedState(user)` returns a boolean (unbound → `false`), collapsing **unbound** and
**unverified**. The contract requires three distinct states. Derive the key from the same predicate
that drives the badge (`isUnboundEmail`), i.e. `'unbound' | 'unverified' | 'verified'`. Also resolve the
interaction with A1 explicitly: unbound is always last (`verified → unverified → unbound` ascending;
`unverified → verified → unbound` descending — verified/unverified flip, unbound stays last). Document
the chosen order so p6 can assert it.

### A3 — never sort on the displayed placeholder text
`renderUsers` substitutes user-facing strings for absent values. The comparator must use the raw data:

- `user`: `user.name || user.username || user.id` — **not** `未设置姓名` (otherwise every nameless row ties on the literal).
- `email`: raw `user.email`; group `isUnboundEmail(user.email)` as the A1 sentinel — **not** `未绑定邮箱`.
- `phone`: `user.phoneE164 || user.phoneNationalNumber` — **not** `phoneMasked` (`未绑定手机号` is display-only).
- `identity`: `identities.map(i => i.provider)` (join/rank) — **not** `未绑定`. Guard `Array.isArray(user.identities)`.
- `created`: `new Date(user.createdAt).getTime()` — **not** `dateText()` (locale `toLocaleString('zh-CN')` or `未记录`; both are non-collatable).

### A4 — text collation
Use a single shared `Intl.Collator('zh-CN', { numeric: true })` (at minimum `numeric: true`; choose and
document `sensitivity`) so number-like usernames/names order naturally (`user2` before `user10`) and
Chinese compares per locale. Do not rely on default `<`/`String.prototype.localeCompare` without options.

### A5 — role and ban use defined ranks
`role`: compare a rank map keyed off the (already-lowercased) raw `role` (`admin`/`user`), not the
`管理员`/`普通用户` labels. `ban`: rank off `Boolean(banned)`. The contract says "roles/statuses use
defined values", so the specific ascending orders must be deliberate and recorded for p6.

### A6 — retention across every re-render path
Sort state must be **module-scoped** (beside `allUsers`) and reapplied inside `renderUsers()`, which
must sort a copy of `filteredUsers()`. Entry points that re-render: `loadUsers()` (refresh **and** the
import success path's `await loadUsers()`), `updateUser()` (in-place `allUsers[index] = payload.user`),
`toggleBan()` (immediate + its 4 s `pendingBanTimer` re-render), `deleteUser()` (`filter`, then
render), and the `searchInput` / `verifiedFilter` `input` listeners. Before any column is chosen the
default state must be "no sort" so the **initial response order** is preserved.

### A7 — never mutate `allUsers`
`filteredUsers()` already returns a fresh array, so `.sort()` on that result is safe. Sorting `allUsers`
in place would destroy the pre-selection response order and cross-column stable ties. Equal keys must
return `0` so the input order is retained (modern `Array.prototype.sort` is stable).

### A8 — `aria-sort` ownership and rendering
Set `aria-sort="ascending" | "descending"` on the **active `<th>`** and `"none"` on the other seven, on
each activation; never on the inner `<button>`. The `<th>` markup is static and survives
`renderUsers()` (which rewrites only `tbody`), so it stays in sync as long as it is written on
activation. The empty `.admin-sort-arrow` span needs CSS keyed off `th[aria-sort="ascending"|"descending"]
.admin-sort-arrow` (page-scoped in `vaultsso-admin-pages.css`; do not disturb prior uncommitted styles).

### A9 — malformed-email divergence (flag to root; likely out of scope to "fix")
`isUnboundEmail` (UI) = empty **or** `@users.invalid`. The login gate's usable-mailbox rule additionally
rejects **invalid-format** addresses, so a stored malformed email (e.g. `not-an-email` or `abc@`) renders
badge `未验证` and sorts as "unverified", while login treats that mailbox as unbound. **Recommendation:**
keep the sort key aligned with the **badge** predicate (UI self-consistency) and record the divergence
for root as a pre-existing display/gate mismatch — do not change product behavior here.

### A10 — mobile scroll and hit area
Keep the existing `.napi-table-scroll` wrapper (`vaultsso-base.css:414 → overflow-x: auto`); it is the
contract's "scroll within container" mechanism. Give `.admin-sort-btn` the full header hit area and
keyboard focus styling; do not introduce a wrapper or dependency.

## 4. Checked and cleared (no action)

- PUT update preserves `identities` → no provider-column regression after role/ban updates.
- `.napi-table-scroll` pre-exists with `overflow-x: auto`.
- Header/markup column order matches the rendered DOM; Actions excluded from sorting.
- `aria-sort` is placed on the column header element (correct ARIA role for sorting state).
- Serializer lowercases `role`, so raw-value rank maps are reliable.
- Import completion routes through `loadUsers()`, so no separate retention path is needed.
- `filteredUsers()` already returns a copy — the contract's "don't mutate the stored list" is achievable
  without touching the stored array, provided A7 holds.

## 5. Final code review verdict

Supersedes the earlier provisional limit ("comparator not present"). The comparator now exists and was
reviewed line by line against A1–A7, with the coordinator's clarification folded in. **No actionable
comparator defects remain.**

Coordinator clarification (recorded, so this is not re-litigated):

- **"Missing values last" applies only to raw values** — email text, phone, providers, dates.
- **Mailbox state is an explicit three-way category, not a missing value.** Ascending is
  `unbound → unverified → verified`; descending is the reverse. `SORT_MAILBOX_RANK = { unbound: 0,
  unverified: 1, verified: 2 }` returned with `missing: false` is **intentional and correct**; it is not
  an A1 sentinel-inversion bug.

| Note | Requirement | Verdict |
| --- | --- | --- |
| A1 | raw-value sentinels last **in both directions** | **PASS.** `compareSortColumn` resolves `missing` **before** the `sortDirection === 'desc' ? -diff : diff` flip, so the `email` (unbound/empty), `phone`, `identity` and `created` sentinel groups never float to the top on descending. |
| A2 | mailbox = explicit 3-way category | **PASS** (per clarification). `unbound`/`unverified`/`verified` are distinct ranks, ascending `unbound → unverified → verified`, descending reversed, driven by the same `isUnboundEmail` predicate as the row badge. |
| A3 | never sort on displayed placeholder text | **PASS.** `user` → `name \|\| username \|\| id`; `email` → raw lowercased value with `isUnboundEmail` as the sentinel; `phone` → `phoneE164`; `identity` → `identities[].provider` with an `Array.isArray` guard; `created` → `Date.parse` (`null`/missing → `NaN` → sentinel). |
| A4 | locale/numeric collation | **PASS.** `Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })`, with a `<`/`>` fallback when `Intl` is unavailable. |
| A5 | role/ban use defined values | **PASS.** `SORT_ROLE_RANK = { user: 0, admin: 1 }`; ban = `banned ? 1 : 0`. Ascending: user→admin, normal→banned. Explicit and assertable. |
| A6 | retention across every re-render path | **PASS.** `sortKey`/`sortDirection` are module-scoped; `renderUsers()` recomputes `sortedUsers(filteredUsers())` on every call, covering refresh, import, `updateUser`, `toggleBan` (incl. its 4 s timer), `deleteUser`, and search/filter input. `sortKey = ''` default preserves the initial response order. |
| A7 | never mutate `allUsers` | **PASS.** `sortedUsers` maps to `{ user, index }`, sorts that wrapper array, then maps back; `allUsers` is untouched. Ties also break on the captured `index`, so stability is explicit rather than incidental. |
| A8 | `aria-sort` on the active `<th>` | **PASS.** `renderSortHeaders()` sets `ascending`/`descending` on the active header and `none` on the rest, runs **before** the empty-state early return, and sets a matching `title`. Glyphs are CSS-driven off `th[aria-sort]`. |
| A10 | scroll container + hit area | **PASS.** `.napi-table-scroll` retained; `.admin-sort-btn` is a real `<button type="button">` with `font: inherit` and a `:focus-visible` outline. |

### Previously suggested issues — both cleared

- **Mailbox ascending order** (was D1): cleared by the clarification above; current code is correct.
- **Phone sentinel ignoring `phoneNationalNumber`** (was D2): not reachable. `phone_e164` is a **STORED
  generated column** (`db/init.js:28`) computed from `phone_country_code` + `phone_number`, so it is
  non-null exactly when the row's masked phone is displayable. The sort key and the cell therefore always
  agree; no change suggested.

### Still open (root decision, out of sort scope)

A9 — malformed-email divergence between `isUnboundEmail` (UI) and the gate's usable-mailbox rule. The
sort key correctly follows the **badge**, keeping the UI self-consistent; the display/gate mismatch
remains a separate pre-existing question and is not fixed here.

### Verified clean

`SORT_COLUMNS` covers exactly the eight sortable headers (no `operations`); `toggleSort` ignores unknown
keys, first activation of a new column is ascending, repeat activation toggles; `renderSortHeaders()`
runs before the empty-state early return so `aria-sort` stays correct with zero rows; the empty-state
`colspan="9"` still matches the nine-column header; header buttons live in `<thead>` so the existing
`<tr>` row-click navigation is unaffected; the numeric-vs-text `diff` branch is column-consistent;
timestamps use `Date.parse` (not `new Date(null)`), so a null `createdAt` yields `NaN` and lands in the
sentinel group rather than epoch.

### Limits

Read-only static review of the landed JS/CSS/markup and the verified payload semantics. No aggregate and
no focused browser run was performed (p6 owns the focused regression). No aggregate or focused run
executed here.