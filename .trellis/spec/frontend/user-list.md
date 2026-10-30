# Admin User-list Sorting

## 1. Scope / Trigger

Applies to the complete admin user list in `views/admin/users.html` and `public/js/pages/admin/users.js`. Sort the data already returned by `GET /api/users`; do not add a server query or paginate only the visible rows to implement header sorting.

## 2. Signatures

- Sort buttons: `th[data-sort-column] button.admin-sort-btn[data-sort]`.
- Keys: `user`, `email`, `phone`, `identity`, `role`, `mailbox`, `ban`, `created`; the operations column has no sorting control.
- Direction: active header `aria-sort="ascending" | "descending"`, other headers `aria-sort="none"`.
- Rendered row identity remains `#userTableBody tr[data-user-id]`; all existing action selectors remain intact.

## 3. Contracts

Preserve response order until the first header activation. A newly selected column starts ascending; repeat activation toggles direction. Apply sorting to a copy of the complete filtered list on each render. Store the choice only in page state; preserve it during search/filter, refresh, successful imports and role/ban updates. Equal values retain original response order in either direction.

Use one `Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })` for text. User values use trimmed name with username/ID fallback. Email compares the stored normalized address; empty or `@users.invalid` addresses are missing. Phone compares `phoneE164`, providers compare normalized provider names, and creation time compares parsed timestamps. Missing email/phone/providers and missing/invalid timestamps stay last in both directions; decide this before applying the direction multiplier.

Status columns contain real categories: ascending role is user -> admin, mailbox is unbound -> unverified -> verified, and ban is normal -> banned. Reverse those ranks for descending. An unbound mailbox **state** is a category rather than a missing email-address value; do not merge it with unverified.

Use actual buttons for native keyboard activation, visible focus and a visible direction indicator. Put `aria-sort` on the header, and hide decorative arrows from assistive technology. Keep wide tables scrollable inside the users-page container at narrow widths. Update affected users-page JS/CSS versioned references while preserving other admin layout rules.

## 4. Validation & Error Matrix

| Event | Result |
| --- | --- |
| Initial load | API response order retained; no active sort |
| First click or keyboard activation of a header | Ascending order and matching header/arrow |
| Repeat activation | Direction toggles; empty raw values remain last |
| Select another header | New column ascending; previous indicator cleared |
| Search/filter, refresh, import or user update | Chosen sort reapplied to current data |
| Equal values | Stable response order in either direction |
| Empty filtered list | Existing nine-column empty state; header state remains accurate |

## 5. Good / Base / Bad Cases

- Good: `用户2` precedes `用户10`, and descending email still puts unbound accounts last.
- Base: filtering to unverified accounts preserves the selected creation-time direction.
- Bad: sorting the displayed `未绑定邮箱`/formatted date strings or mutating `allUsers` changes semantics or loses stable source ordering.

## 6. Tests Required

`tests/user-table-sort-browser.cjs` drives actual headers and asserts row IDs/order, direction/ARIA, numeric text, real timestamps, missing values, stable ties, filter/refresh/update retention, keyboard activation and existing row actions. Exercise desktop/mobile with overflow checks and screenshots. Preserve the user-import browser suite and existing admin/auth smoke checks. No backend change means an API suite rerun is unnecessary unless shared backend files also change.

## 7. Wrong vs Correct

Wrong: reverse the entire sorted array for descending, moving missing values to the top and reversing equal-value ties.

Correct: compare missing groups first, reverse only present unequal values, and preserve the original index for ties.
