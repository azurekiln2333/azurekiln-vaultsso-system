# Browser implementation report — user import file upload

> **Superseded (row cap only).** The `/200/` UI expectation and the 190-row sample below are
> superseded by the later instruction that admin imports have **no** fixed record-count cap.
> See `research/import-unbounded-browser.md` for the current no-cap UI contract and the real
> 2501-row browser coverage. The 10 MiB bound, direct-file transport and pasted-content behavior
> described here still apply.

Owner: Pi w1Q:p6 (browser coverage only)
Task: `.trellis/tasks/10-23-account-first-login` (import transport follow-up)
Contract: `research/import-upload-contract.md`

## Files

| File | Change |
| --- | --- |
| `tests/user-import-upload-browser.cjs` | **New, this is the only file I added.** 5 scenarios × desktop 1440 / mobile 390. |

No product code, fixture, `package.json`, spec, or previously finished login/MFA test was touched.
`git status` for this scope shows exactly one new untracked test file.

## How the reported bug is reproduced as a precondition

The test builds a **real ~97KiB JSON file** (190 rows) and asserts the old transport would have
failed before any import happens:

- raw file: `98691` bytes = 96.4 KiB (in `[96 KiB, 98 KiB]`)
- `JSON.stringify({ content: <file text> }).length` = `160265` bytes **> 102400** (the global
  `express.json()` 100 KiB limit)

The filler contains quotes so the double escaping of the old `{ content }` wrapper is realistic
rather than hand-tuned. This is the exact shape the user hit: a 97KB file that reported “请求内容过大”.

## Scenarios and assertions

| # | Scenario | Assertions |
| --- | --- | --- |
| 1 | 97KiB JSON selected through the file input (memory buffer, `setInputFiles`) | Dialog states the real limits (`200` rows and `10 MiB`); selecting a file clears pasted content; `#importSourceHint` says the file itself is uploaded; **exactly one** `POST /api/users/import`; `Content-Type: application/octet-stream`; **request body is byte-for-byte the file** (`body.equals(fileBuffer)`); body contains no `"content"` wrapper; result shows `成功导入 188 个用户，跳过 2 条记录。`; duplicate rows reported line by line (`第 2 行 … 与本次导入中的其他记录重复`, `第 6 行 … 用户名或邮箱已存在`); result block is scrolled into the viewport. |
| 2 | Pasted JSON (compatibility) | Selecting a file then typing clears the file input; hint switches to the pasted source; request is `application/json` with exactly `{ content: <pasted> }`; import succeeds (`成功导入 2 个用户`). |
| 3 | Known over-limit input | A `10 MiB + 1` byte file is rejected **in the browser**: zero `/api/users/import` requests, visible explanation naming the real limit (`文件 10 MiB 超过 10 MiB 上限，请拆分文件后再导入。`). |
| 4 | Multi-byte paste over the **byte** limit | 3.5M CJK characters pasted in-page: the test asserts the precondition `text.length` (3,500,000) `< 10485760` **and** the serialized UTF-8 payload `> 10485760`, so a `.length`-based check would wrongly allow it. Submit is rejected **locally**: zero import requests, submit still enabled, `粘贴内容过大，请使用文件上传或拆分内容。` shown, the dialog still states `10 MiB`, the hint reflects the measured size, and the pasted text is preserved (length 3,500,000) for splitting and retry. |
| 5 | Request failure | A forced HTTP 500 shows the failure and the **same selected file survives** (`files[0].name === 'retry.json'`) so the user can retry. |

### Settled-state guard

Every scenario waits for a **final** result, not merely non-empty text. p5 sets
`importResult.innerHTML = '<p class="admin-cell-sub">正在导入...</p>'` and disables the submit button
while the request is in flight, so the wait requires **both**: the submit button to be enabled again
and the result text to be non-empty **and no longer containing `正在导入`**. The UI assertions are
also correlated with the observed response status (`200` for the file and paste imports, `500` for the
forced failure), so a passing check cannot read the in-progress placeholder as an outcome.

Every screenshot is taken through a helper that fails on horizontal overflow, so layout is
asserted, not just captured.

## Observed UI text (evidence from the screenshots)

```
将直接上传文件「users.json」（96.4 KiB），粘贴内容已清除。
单次最多 200 条记录；文件最大 10 MiB
成功导入 188 个用户，跳过 2 条记录。
第 2 行 imp000-…：与本次导入中的其他记录重复
第 6 行 existing-…：用户名或邮箱已存在
```

Over-limit branches:

```
文件 10 MiB 超过 10 MiB 上限，请拆分文件后再导入。          (file source)
粘贴内容过大，请使用文件上传或拆分内容。                    (multi-byte paste, UTF-8 bytes over the bound)
```

For the multi-byte paste the dialog hint reads `将按粘贴内容导入（10 MiB），未使用任何文件。`, which
proves the byte measurement (`TextEncoder`) ran even though the JavaScript string length is only
3.5M characters.

## Verification

```
node --check tests/user-import-upload-browser.cjs      syntax OK
node tests/user-import-upload-browser.cjs              PASS  desktop 1440 + mobile 390
```

Output: `User import upload browser checks passed: 97KiB raw-bytes file upload, line-by-line
duplicate reasons, pasted JSON compatibility, browser over-limit block, retry source preservation,
desktop and mobile`.

Both p3 (raw/octet-stream parser with the import-only 10 MiB bound and 413 `users.import.too_large`)
and p5 (no FileReader, single active source, preflight, limits display, result `scrollIntoView`)
were already in the working tree when the test ran, so these results validate the landed
implementation, not a mock.

## Screenshots

Fixed path: `.artifacts/user-import-upload/` — 8 PNGs (4 states × desktop 1440 / mobile 390):
`import-file-success`, `import-paste-success`, `import-oversize-blocked`,
`import-paste-oversize-blocked`.

## Notes for the coordinator

- The isolated fixture is used throughout: in-memory DB, no real user data, no SMTP.
- Import rows use empty passwords, which the importer accepts; nothing logs in as an imported user.
- `tests/user-import-upload-browser.cjs` still needs to be added to the `check:browser` npm command
  (integration step owned by the main session, per the contract).
- The 190-row file stays under the documented 200-row bound on purpose, so the size regression is
  tested without tripping the row bound.
