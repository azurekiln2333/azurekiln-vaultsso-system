# Existing User Import Behavior

Historical investigation before the authorized upload/scale corrections. The final behavior and validation are in `import-upload-contract.md`, `import-unbounded-review.md` and `validation.md`. Later review reproduced a legacy cross-field ambiguity in the old duplicate check; the import-only correction reuses `findUserConflicts` so such rows skip and processing continues.

This records the user's follow-up question about duplicate usernames/emails. It is a read-only investigation, not an added implementation deliverable.

## Backend

- `server.js:4265` handles admin-only `POST /api/users/import` for parsed CSV or JSON rows.
- `server.js:4298` normalizes `row.email`; `:4299` defaults an empty username to that email.
- `server.js:4312` skips a missing/invalid email and records `邮箱缺失或格式无效`. Format validation does not prove an actual mailbox can receive mail.
- `server.js:4337` tracks the normalized username/email pair within the current import and records `与本次导入中的其他记录重复` for a repeated pair.
- `server.js:4344` checks the imported username against both existing username and email; `:4348` performs the same lookup for the imported email. Conflicts are skipped with `用户名或邮箱已存在` or `邮箱已被其他账户使用`.
- `models/User.js:95` uses `WHERE username = ? OR email = ?` and accepts exactly one matching row. Successfully created earlier rows in the same sequential import also become visible to subsequent lookups.
- `server.js:4376` returns created/skipped counts plus a `skipped` array containing the input row number, username, email, and reason. Import conflicts do not intentionally overwrite existing users.

## Frontend

- `public/js/pages/admin/users.js:127` reveals the results block during the request.
- `:131` displays `成功导入 X 个用户，跳过 Y 条记录`.
- `:133` renders each skipped input as `第 N 行 <username or email>：<reason>`, with escaped text. This identifies the rejected input account, not the ID of the existing conflicting account; the generic username/email reason does not identify the exact conflicting column.
- Pi `auth-frontend` inspected `views/admin/users.html:80` and the dialog styles. The results block is in the dialog body; the dialog is scrollable and the result list is not clipped by a separate hidden/overflow rule.
- Results are at the end of the dialog content, and the handler does not scroll to them. A long input/example area may leave the results outside the current viewport. This is a source-based usability observation; no live deployment import was performed.

## Limits of This Answer

The current code has duplicate checks and per-input skipped details; it is inaccurate to say it silently imports known duplicates by design. This investigation did not test concurrent imports, legacy ambiguous database records, or a deployed frontend version. No import, admin styling, or user data was changed.
