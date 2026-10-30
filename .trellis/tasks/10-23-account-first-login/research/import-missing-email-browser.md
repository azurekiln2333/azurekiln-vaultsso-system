# Missing-email import — browser implementation report

Owner: Pi w1Q:p6
Scope: `tests/user-import-upload-browser.cjs` only (no product, fixture, `package.json`, spec or login-test edits)
Task: `.trellis/tasks/10-23-account-first-login`
Supersedes the row-cap-only coverage in `research/import-unbounded-browser.md` (that file's findings still apply; this one adds missing-email, grouping and the contact-administrator branch).

## Instruction applied

1. A missing email must **not** block an import when a username exists.
2. The resulting account uses the internal unbound address
   `import-<sha256(lowercase username)[0:24]>@users.invalid`, is **never** verified (even for
   `ischeck=y`), and existing `@users.invalid` inputs are also never verified.
3. Its login shows **`请联系管理员重置`** with no mail, no send action and no session.
4. The admin list shows **`未绑定邮箱`** instead of the internal address.
5. Results must be **grouped categories with counts and original row/account**, not one mixed list:
   `无邮箱但导入成功` / `重复账号跳过` / `邮箱格式错误` / `其他错误`; missing-email imports are
   successes and must not inflate error counts. Full details stay scrollable and escaped, and the
   internal synthetic mailbox must never be rendered.
6. All prior work is preserved: no record-count cap, direct original-File upload, 10 MiB bound,
   ambiguity-safe duplicates, pasted-content compatibility.

## Command

```powershell
node tests/user-import-upload-browser.cjs
```

Result: **PASS** on desktop 1440 and mobile 390.

## Mixed real-file coverage (15 rows -> 8 created / 7 skipped)

| Row | Source | Outcome | Group |
| --- | --- | --- | --- |
| 1 | username, email omitted | created, unbound | 无邮箱但导入成功 |
| 2 | email `""` | created, unbound | 无邮箱但导入成功 |
| 3 | email `"   "` | created, unbound | 无邮箱但导入成功 |
| 4 | email `null` | created, unbound | 无邮箱但导入成功 |
| 5 | no email + `ischeck=y` | created, unbound **and unverified** | 无邮箱但导入成功 |
| 6 | explicit `@users.invalid` + `ischeck=y` | created, kept as given, **unverified** | 无邮箱但导入成功 |
| 7 | existing username | skipped `用户名或邮箱已存在` | 重复账号跳过 |
| 8 | existing account email | skipped `邮箱已被其他账户使用` | 重复账号跳过 |
| 9 | username+email pair | created | — |
| 10 | same pair again | skipped `与本次导入中的其他记录重复` | 重复账号跳过 |
| 11 | `not-an-email` | skipped `邮箱格式无效` (not silently dropped) | 邮箱格式错误 |
| 12 | no username and no email | skipped `缺少用户名` | 其他错误 |
| 13 | `credits: -5` | skipped `积分必须是不小于 0 的整数` | 其他错误 |
| 14 | real email + `ischeck=y` | created **and verified** | — |
| 15 | `not-an-email-no-user` (no username) | skipped `邮箱格式无效`, raw value shown | 邮箱格式错误 |

Asserted group counts: `无邮箱但导入成功（共 6 条）`, `重复账号跳过（共 3 条）`,
`邮箱格式错误（共 2 条）`, `其他错误（共 2 条）`, in that section order, with each row rendering
`第 <row> 行 <original account>` and its own reason. `@users.invalid` appears nowhere in the result
or the admin list.

## Scale (no record-count cap) with unbound rows

Every 100th bulk row omits its email, so unbound imports are also proven at scale.

## Observed counts and timing

| Viewport | Scenario | Result | Time |
| --- | --- | --- | --- |
| desktop 1440 | mixed file (15 rows) | created 8 (6 unbound), skipped 7 | 143 ms |
| desktop 1440 | bulk 2501 rows | created 2498 (25 unbound), skipped 3 | 1637 ms |
| desktop 1440 | bulk re-import | created 0, skipped 2501 | 2173 ms |
| mobile 390 | mixed file (15 rows) | created 8 (6 unbound), skipped 7 | 124 ms |
| mobile 390 | bulk 2501 rows | created 2498 (25 unbound), skipped 3 | 1575 ms |
| mobile 390 | bulk re-import | created 0, skipped 2501 | 2157 ms |

Grouping at scale: the first 2501-row import renders `无邮箱但导入成功（共 25 条）` and
`重复账号跳过（共 3 条）` as separate counted sections; the re-import renders a single
`重复账号跳过（共 2501 条）` and **no** empty success group, with the detail list still scrollable.

## Contact-administrator branch (fresh unauthenticated context)

A brand-new browser context (no cookies) enters each unbound username (`-omitted`,
`-explicit`, `-synthcheck`) and presses Continue:

- `#loginContactAdmin` becomes visible with `该账户没有可用邮箱，请联系管理员重置密码。`
- no `#sendSetupCodeBtn`, no `#passwordSetupForm`
- `f.mails` unchanged (discovery sends nothing), `f.pool.sessions` unchanged
- `/api/profile` still 401
- returning via `换一个账号` clears the contact section (`#changeLoginAccountBtn`)

## Admin list

Searching an unbound account shows `未绑定邮箱` (and the `未绑定` badge) with no internal address;
a real verified account still shows `已验证`.

## Screenshots

Fixed path: `.artifacts/user-import-upload/` — 18 PNGs (9 states × desktop 1440 / mobile 390):

| File | Content |
| --- | --- |
| `import-mixed-grouped-result-*` | the four grouped sections with counts and rows |
| `contact-admin-unbound-*` | unbound login showing 请联系管理员重置 |
| `admin-unbound-email-*` | admin list showing 未绑定邮箱 |
| `import-bulk-rows-success-*` | 2501 rows, 2498 created (25 unbound) |
| `import-bulk-rows-reimport-*` | 0 created / 2501 duplicate-group skips, scrollable details |
| `import-file-success-*` | real 97KiB upload |
| `import-paste-success-*` | pasted JSON compatibility |
| `import-oversize-blocked-*` | 10 MiB + 1 byte file blocked locally |
| `import-paste-oversize-blocked-*` | multi-byte paste blocked by UTF-8 byte size |

Each screenshot is preceded by an assertion that the page has no horizontal overflow.

## Verification notes

- p3 (`reason_code`, `importedWithoutEmail`, synthetic address, unverified synthetic emails) and p5
  (`无邮箱但导入成功` / `重复账号跳过` / `邮箱格式错误` / `其他错误` sections, `未绑定邮箱`,
  `importEntryAccount` never showing the internal mailbox) had landed before this run, so the checks
  validate the real implementation, not a mock.
- Not screenshot-only: counts, group boundaries, row numbers, account text, absence of
  `@users.invalid`, verification flags read from the fixture DB, request bytes/content type,
  response status, zero-request over-limit blocks and scrollability are all asserted.
- Isolated in-memory fixture; no live database and no SMTP.
- `npm run check:browser` was not run here (owned by the main session).
