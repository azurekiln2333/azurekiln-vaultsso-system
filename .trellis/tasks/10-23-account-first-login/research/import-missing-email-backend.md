# Admin import: missing email no longer blocks the row

Correction to the earlier import contract: a **missing email must not block an import** when a
username exists. The original passwordless/no-mailbox login contract still applies — such an
account has no usable mailbox and must see **联系管理员重置** (`contact_admin`).

Preserved from prior work: no record-count cap, direct `File` upload, 10 MiB import bound,
ambiguity-safe duplicate skipping, per-row created/skipped details.

## Exact deterministic placeholder generation (for tests)

When a row has a username but no usable email, the importer stores:

```js
const storedEmail = `import-${crypto.createHash('sha256').update(username.toLowerCase()).digest('hex').slice(0, 24)}@users.invalid`;
```

Precisely:

| Step | Value |
| --- | --- |
| hash input | `username.toLowerCase()` — `username` is `normalizeText(row.username)`, falling back to the normalized email when the username is blank |
| digest | `crypto.createHash('sha256').update(input).digest('hex')` (lowercase hex) |
| truncation | `.slice(0, 24)` → exactly **24** hex characters |
| template | `import-` + those 24 chars + `@users.invalid` |

Example: `username = "Alice"` → sha256 of `"alice"` → first 24 hex chars, so the stored address
is `import-<24 hex>@users.invalid`. Deterministic: the same username always yields the same
placeholder, so a re-import is caught as a duplicate instead of creating a second row.

The hash input is always a nonempty username: a row with a blank username **and** a blank email
is rejected earlier as `缺少用户名`.

`isValidEmail` accepts the placeholder (TLD `invalid`), and `isSyntheticEmail`
(`/@users\.invalid$/i`) recognizes it. Discovery (`server.js:2738`), account-bound send
(`:2961`) and first-password setup (`:3216`) already treat it as unusable → `contact_admin`
with no mail sent. **No login or schema change was needed.**

## Row decision matrix (final)

| username | email | Result |
| --- | --- | --- |
| present | blank / omitted / `null` / whitespace | **imported** with the deterministic placeholder |
| blank | blank | skip `缺少用户名` |
| present | nonempty but malformed | skip `邮箱格式无效` (reported, never silently replaced) |
| present | valid | imported with that email, unchanged |
| blank | valid | imported; username defaults to the email, unchanged |
| any | nonempty `@users.invalid` | imported, but forced **unverified** |

`emailVerified` is now:

```js
const emailVerified = ['y', '1', 'true'].includes(normalizeText(row.ischeck).toLowerCase())
  && !isSyntheticEmail(storedEmail);
```

So `ischeck=y` cannot verify a placeholder, and a caller-supplied `@users.invalid` address can
never be verified either.

## Change boundary

`server.js` importer only, plus one comment in `models/User.js`.

- `email` in the loop keeps meaning **the input address**, so every `skipped` entry still
  reports the user's input email (`''` when blank) and never leaks the placeholder as a real
  mailbox.
- `storedEmail` is used for `dedupeKey`, `findUserConflicts`, `User.create` and the QQ identity
  record, so DB uniqueness and duplicate precedence are fully checked against what is stored.
- `findUserConflicts` precedence (username first, then email) and the existing skip strings are
  unchanged.
- `models/User.js`: the empty-password comment now acknowledges the admin-import fallback
  (unbound placeholder ⇒ admin-only reset). No model behavior, schema, provider or global login
  change.

## Final published contract (for other workers)

Additive and backward compatible: `createdCount`, `skippedCount`, `created`, `skipped` are all
unchanged in name and meaning.

### New response field

```json
{
  "createdCount": 8,
  "skippedCount": 2,
  "importedWithoutEmail": [{ "row": 1, "username": "BlankMail" }],
  "created": [ /* … */ ],
  "skipped": [ /* … */ ]
}
```

`importedWithoutEmail` contains only **successfully created** rows whose source mailbox was
missing **or** synthetic (`@users.invalid`, whether generated or supplied). Skipped rows are
never listed here. `username` is the account's resolved username; `row` is the 1-based source
row number (same numbering as `skipped[].row`).

### New `skipped[]` field: `reason_code`

Every skipped entry keeps its existing human `reason` **and** gains a machine `reason_code`.

| `reason_code` | human `reason` |
| --- | --- |
| `missing_username` | 缺少用户名 |
| `invalid_email` | 邮箱格式无效 |
| `invalid_password` | 密码长度不满足系统要求 |
| `invalid_description` | 个人简介不能超过 500 字 |
| `invalid_credits` | 积分必须是不小于 0 的整数 |
| `duplicate_identity` | 与本次导入中的其他记录重复 |
| `duplicate_username` | 用户名或邮箱已存在 |
| `duplicate_email` | 邮箱已被其他账户使用 |
| `duplicate_external_identity` | QQ 账号已绑定其他用户 |

All nine skip paths emit a code; consumers should branch on `reason_code`, not on the human text.

Suggested frontend grouping (p5 owns the UI):

- **无邮箱但导入成功** ← `importedWithoutEmail`
- **重复账号跳过** ← `duplicate_identity` / `duplicate_username` / `duplicate_email` / `duplicate_external_identity`
- **邮箱格式错误** ← `invalid_email`
- **其他错误** ← `missing_username` / `invalid_password` / `invalid_description` / `invalid_credits`

### Absent vs invalid source

Only an omitted, `null`, empty, or whitespace-only **string** email counts as absent.
Any other nonempty source value — including a non-string such as `12345` — is `invalid_email`
and is never silently turned into the missing-mailbox success path.

### Skip-detail hygiene

`skipped[]` reports the **raw input** `username`/`email` (`email: ""` when blank) and never the
internal `@users.invalid` placeholder. The placeholder appears only in stored records and is
never presented as a bound mailbox.

## Validation

Scratch probes (gitignored, isolated fixtures):

| Probe | Result |
| --- | --- |
| `.artifacts/import-missing-email-probe.cjs` | 8 created / 2 skipped; placeholders match an independently computed sha256; `ischeck=y` unverified; supplied `@users.invalid` unverified; discovery → `contact_admin` with no `email_masked`; re-import → `用户名或邮箱已存在` |
| `.artifacts/import-reason-codes-probe.cjs` | all 9 codes observed; `importedWithoutEmail = [1,2,3,4,9,16]` (created only); non-string email `12345` → `invalid_email`, not missing |

Observed `reason_code` output for the 16-row matrix:

```
5  missing_username      缺少用户名
6  invalid_email         邮箱格式无效
10 invalid_description   个人简介不能超过 500 字
11 invalid_credits       积分必须是不小于 0 的整数
12 duplicate_identity    与本次导入中的其他记录重复
13 duplicate_username    用户名或邮箱已存在
14 duplicate_email       邮箱已被其他账户使用
15 invalid_email         邮箱格式无效     (source email = 12345, non-string)
importedWithoutEmail = [{1,BlankMail},{2,OmittedMail},{3,NullMail},{4,SpaceMail},{9,CheckedButBlank},{16,SupSynthetic}]
```

| Check | Result |
| --- | --- |
| `node --check server.js` | pass |
| `node --check models/User.js` | pass |
| `npm run check:syntax` | pass |
| `tests/user-import-upload.test.js` | 15/16 — the one failure is p4's superseded BOM assertion (below) |

### Coordinator / p4 note

`tests/user-import-upload.test.js` › *“a BOM-prefixed CSV file imports and reports duplicate rows
with per-row reasons”* still asserts the **old** rule that the empty-email row is skipped. With
optional email that row is now imported. The test needs: `createdCount` 1 → 2, `skippedCount`
5 → 4, the second `'邮箱缺失或格式无效'` reason removed, the `'邮箱缺失或格式无效'` for the
badmail row replaced by `'邮箱格式无效'`, `skipped[].row` `[2,3,4,5,6]` → `[2,3,4,5]`, and the
`created[0]` / `skipped[4]` assertions re-pointed. No server-side change is needed.

`server.js` and the `models/User.js` comment are complete. Editing is paused for integration; no
commit or stage was performed, and no other worker's files were touched.
