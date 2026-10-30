# Unbounded user import — browser implementation report

> **Extended.** Missing-email imports, grouped result sections (`无邮箱但导入成功` /
> `重复账号跳过` / `邮箱格式错误` / `其他错误`) and the contact-administrator login branch are
> covered in `research/import-missing-email-browser.md`. The row-cap, transport and size findings
> below still apply.

Owner: Pi w1Q:p6
Scope: `tests/user-import-upload-browser.cjs` only (no product, fixture, `package.json`, spec or login-test edits)
Supersedes: the `/200/` UI and row-cap expectations recorded in `research/import-browser-implementation.md`

## Instruction applied

The user rejected any fixed record-count cap (including 200, 1500 and 2000). Admin imports now carry
**no** row cap; only the scoped 10 MiB body/file bound applies, with the existing authorization,
origin and throttle behavior and the existing per-row created/skipped detail. Direct original-file
upload and pasted content are both preserved.

## What changed in the test

1. **Removed the old `/200/` UI contract.** The dialog is now asserted to state the size bound and to
   advertise **no** fixed record-count cap:

   ```js
   assert.match(limitsText, /10\s*(MB|MiB|M|兆)/i);
   assert.doesNotMatch(limitsText, /200/);
   assert.doesNotMatch(limitsText, /\d+\s*条/);
   ```

2. **Kept every real 97KiB upload byte check** (this is the original reported defect and must not
   regress): request count 1, `Content-Type: application/octet-stream`, `body.equals(fileBuffer)`,
   no `"content"` wrapper, plus the precondition that the old `JSON.stringify({content})` wrapper is
   `> 102400` bytes while the file itself is `~97KiB`.

3. **Added a real >2000-row file upload** (`BULK_ROWS = 2501`, empty passwords, 318.9 KiB, JSON
   array, uploaded through the real file input as its own bytes):
   - row 2 repeats row 1 → `与本次导入中的其他记录重复`
   - row 10 reuses an existing username → `用户名或邮箱已存在`
   - row 11 reuses an existing account email → `邮箱已被其他账户使用`
   - expected `成功导入 2498 个用户，跳过 3 条记录。` with all three row details rendered
   - then the **identical file is re-imported**: `成功导入 0 个用户，跳过 2501 条记录。`, which proves
     every one of the 2501 rows is processed again with no cap.

Nothing is "screenshot-only": counts, request bytes/content type, response status, the three per-row
reasons, the no-cap UI text, and the no-request over-limit blocks are all asserted.

## Command

```powershell
node tests/user-import-upload-browser.cjs
```

## Observed counts and timing

| Viewport | Scenario | Result | Time |
| --- | --- | --- | --- |
| desktop 1440 | bulk first import (2501 rows) | created 2498, skipped 3 | 1125 ms |
| desktop 1440 | bulk re-import (same file) | created 0, skipped 2501 | 850 ms |
| mobile 390 | bulk first import (2501 rows) | created 2498, skipped 3 | 2011 ms |
| mobile 390 | bulk re-import (same file) | created 0, skipped 2501 | 801 ms |

Console output of the run:

```
[desktop] bulk first import: 2501 rows -> created 2498, skipped 3, 1125ms
[desktop] bulk re-import: 2501 rows -> created 0, skipped 2501, 850ms
[mobile]  bulk first import: 2501 rows -> created 2498, skipped 3, 2011ms
[mobile]  bulk re-import: 2501 rows -> created 0, skipped 2501, 801ms
User import upload browser checks passed: 97KiB raw-bytes file upload, no record-count cap (real 2501-row
file with full counts and per-row duplicate details), pasted JSON compatibility, browser over-limit blocks
(file and multi-byte paste), retry source preservation, desktop and mobile
```

Independent corroboration from the screenshot: the admin list behind the dialog reports
`已加载 2689 个用户` = 188 (97KiB file) + 2498 (bulk) + 2 (pre-created conflict accounts) + 1 (admin),
so the rows really landed rather than only being counted in the response.

## Rendered UI evidence

```
将直接上传文件「bulk-2501.json」（318.9 KiB），粘贴内容已清除。
文件最大 10 MiB；用户名或邮箱重复的记录会被跳过并列出原因。        <- no record-count cap
成功导入 2498 个用户，跳过 3 条记录。
跳过明细（共 3 条）：
第 2 行 bulk-…-0001：与本次导入中的其他记录重复
第 10 行 existing-…：用户名或邮箱已存在
第 11 行 bulk-…-0011：邮箱已被其他账户使用
```

Re-import:

```
成功导入 0 个用户，跳过 2501 条记录。
跳过明细（共 2501 条）：第 1 行 … 用户名或邮箱已存在 …
```

## Screenshots

Fixed path: `.artifacts/user-import-upload/` — 12 PNGs (6 states × desktop 1440 / mobile 390):

| File | Content |
| --- | --- |
| `import-bulk-rows-success-*` | 2501-row file, 2498 created / 3 skipped with row details |
| `import-bulk-rows-reimport-*` | same file again, 0 created / 2501 skipped |
| `import-file-success-*` | real 97KiB upload result |
| `import-paste-success-*` | pasted JSON compatibility |
| `import-oversize-blocked-*` | 10 MiB + 1 byte file blocked locally |
| `import-paste-oversize-blocked-*` | multi-byte paste blocked by UTF-8 byte size |

Each screenshot is preceded by an assertion that the page has no horizontal overflow, so mobile
layout is asserted, not only captured.

## Coordination

- Server worker and frontend worker had already landed when this ran: `USER_IMPORT_MAX_ROWS`,
  the `users.import.too_many` 400 branch and `IMPORT_MAX_ROWS` are gone, and `#importLimits` reads
  `文件最大 10 MiB；用户名或邮箱重复的记录会被跳过并列出原因。`
- The 10 MiB preflight, source switching, retry preservation, multi-byte measurement and over-limit
  blocks are unchanged and still asserted.
- `npm run check:browser` was not run here (owned by the main session).

## Specification synchronization

Coordinator verified that `.trellis/spec/backend/user-import.md` now records no fixed record-count
cap, complete-file imports within 10MiB, and matching API/browser scale assertions. The prior
200-row contract is superseded.
