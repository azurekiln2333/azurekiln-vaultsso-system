# AzureKiln OAuth2 项目状态总结

生成时间：2026-05-25 06:52:07 +08:00（Asia/Shanghai）

## 当前目录与仓库

- 外层根目录：`D:\MyNewProject\azurekiln-oauth`
- 主项目目录：`D:\MyNewProject\azurekiln-oauth\azurekiln-oauth2`
- Git 仓库位置：仅在 `azurekiln-oauth2` 内，外层根目录不是 Git 仓库
- 其他同级目录：目前只作为参考材料，不作为本次代码事实来源

## 当前完善进度

主项目 `azurekiln-oauth2` 已经从原始导入状态完善到可本地演示、可自动校验的 OAuth2/OIDC Demo 服务。

已完成的核心能力：

- 补齐 OpenID Connect / OAuth2 元数据接口：
  - `/.well-known/openid-configuration`
  - `/.well-known/oauth-authorization-server`
  - `/.well-known/jwks.json`
- 完善授权码模式：
  - Authorization Code Grant
  - PKCE `plain`
  - PKCE `S256`
- 完善服务端授权能力：
  - Client Credentials Grant
  - Refresh Token Grant
  - UserInfo
  - Token Introspection
  - Token Revocation
- 加强安全边界：
  - `/oauth2/introspect` 和 `/oauth2/revoke` 需要客户端认证
  - introspect/revoke 只允许操作同一客户端签发的 token
  - 只有授权请求包含 `offline_access` 时才签发 `refresh_token`
  - 移除存在审计风险的 `uuid` 依赖，改用 `crypto.randomUUID()`
- 新增内存数据库模式：
  - `DB_DRIVER=memory`
  - 无需 MySQL 即可完整跑通本地 Demo
  - 自动种子 demo 管理员和 demo 客户端
- 新增自动化端到端检查脚本：
  - `scripts/check-e2e.js`
  - 覆盖 discovery、登录、管理端 client、授权码、token、userinfo、introspection、revocation、offline_access refresh token grant
- 文档已同步：
  - `README.md` 已改写为简体中文、繁体中文、英文三语说明
  - `public/api-docs.html` 已按 `server.js` 实际路由重写
- 管理 UI 交互已改善：
  - `public/apps.html` 和 `public/tokens.html` 使用 loading 状态和页内反馈
  - `error.html`、`consent.html` 的按钮有实际动作和加载反馈
  - 已清理旧的 disabled token route

## 当前运行状态

最近一次本地 Demo 服务信息：

- 地址：`http://127.0.0.1:3147/oauth2/authorize`
- 进程 PID：`44364`
- 进程名：`powershell`
- 启动时间：2026-05-25 06:50:30
- Demo 登录账号：`demo@vaultsso.com`
- Demo 登录密码：`demo123`

注意：该 PID 是最后一次检查时存在的后台 PowerShell 进程。后续继续研究前，建议重新确认端口 `3147` 是否仍在监听。

## 验证结果

最后一次完成的验证结论：

- `git status --short`：主仓库干净
- `npm run check`：通过
- `npm audit --audit-level=moderate`：通过，`0 vulnerabilities`
- 路由覆盖审计：`server.js` 中的路由已在 `README.md` 或 `public/api-docs.html` 中覆盖
- README 编码：Node 读取 UTF-8 内容正常；PowerShell `Get-Content` 偶尔可能显示乱码，但文件内容本身正常

## 最近提交记录

主仓库 `azurekiln-oauth2` 最近提交：

- `e67912e docs: clarify memory database mode`
- `d30273e test: cover refresh token grant flow`
- `410974b fix: remove vulnerable uuid dependency`
- `0340726 feat: require client auth for token utilities`
- `d42ff22 feat: add in-memory demo verification mode`
- `80295a4 chore: sync npm lockfile`
- `c2ab277 refactor: remove obsolete token route`
- `d8e9b38 docs: document OAuth2 APIs in three languages`
- `4a22925 feat: add PKCE support and admin action feedback`
- `20b5600 chore: import AzureKiln OAuth2 baseline`

## 常用运行方式

进入主项目：

```powershell
cd D:\MyNewProject\azurekiln-oauth\azurekiln-oauth2
```

运行完整检查：

```powershell
npm run check
```

运行安全审计：

```powershell
npm audit --audit-level=moderate
```

以内存数据库模式运行本地 Demo：

```powershell
$env:DB_DRIVER='memory'
$env:PORT='3147'
npm start
```

如果要使用 MySQL 模式，继续按项目 `.env` / README 中的数据库配置启动。

## 后续接手注意

- 继续开发前先进入 `azurekiln-oauth2`，不要在外层其他目录改主代码。
- 如果 Git 报 `dubious ownership`，可临时使用：

```powershell
git -c safe.directory=D:/MyNewProject/azurekiln-oauth/azurekiln-oauth2 status --short
```

- 外层根目录不是 Git 仓库，所以外层这份 `PROJECT_STATUS_2026-05-25.md` 不在当前主仓库提交范围内。
- 本文件位于主项目仓库根目录，可随主项目一起提交和追踪。

## 后期研究入口

建议后续研究时优先看这些文件：

- `server.js`：主服务入口，包含 Express 中间件、OIDC/OAuth2 元数据、授权页、登录、token、userinfo、introspection、revocation、管理 API 等主要路由。
- `db/init.js`：数据库连接与初始化逻辑，负责 MySQL / memory 模式切换，以及表结构补齐。
- `db/memory.js`：内存数据库适配层，方便无 MySQL 环境跑通完整 OAuth2 流程。
- `models/User.js`、`models/Client.js`、`models/Token.js`：用户、OAuth 客户端、token/授权码/refresh token 的数据访问封装。
- `scripts/check-e2e.js`：当前最重要的行为回归验证入口，能看出系统预期支持哪些 OAuth2/OIDC 流程。
- `scripts/init-db.js`：MySQL 模式初始化和默认 demo 数据种子入口。
- `README.md`：三语项目说明、运行方式、API 摘要和示例请求。
- `public/api-docs.html`：浏览器内 API 文档页，内容已按 `server.js` 真实路由校准。
- `public/apps.html`、`public/tokens.html`：管理 UI 页面，重点看客户端管理和 token 管理交互。
- `authorize.html`、`consent.html`、`profile.html`、`success.html`、`error.html`：OAuth 登录、授权确认、成功/错误页面。

## 关键行为与研究重点

- 授权码模式是主流程，PKCE 校验逻辑集中在 `server.js` 中的授权码创建和 `/oauth2/token` 兑换阶段。
- `offline_access` 是 refresh token 的开关；不带该 scope 时，授权码换 token 不返回 `refresh_token`。
- introspection/revocation 的关键安全边界是客户端认证和 client ownership 校验，不能跨客户端探测或撤销 token。
- memory 模式是本地研究优先入口，因为不依赖 MySQL，适合快速验证前端页面、API 和 OAuth2 流程。
- MySQL 模式仍保留，后续研究生产化部署时要重点检查 `.env`、数据库表结构、迁移策略和密钥管理。
- 当前 JWKS 是 placeholder 级别，适合 Demo 发现文档完整性；如果要做生产级 OIDC，需要补真实签名 key 管理和 JWKS 轮换。
- 当前 E2E 是本项目行为契约的核心证据；修改 OAuth 流程、token 逻辑、DB 适配层或管理 API 后，应先跑 `npm run check`。
- UI 已重点修过“按钮无反馈/假链接/confirm 弹窗”等问题；后续新增页面也应保持页内 loading、错误、成功反馈一致。

## 已知范围边界

- 本项目目前定位是 OAuth2/OIDC Demo / Provider 原型，不等同于完整生产级身份平台。
- 尚未实现完整生产级能力，例如真实 JWKS 私钥轮换、细粒度审计日志、管理后台权限分级、长期迁移系统、分布式 session/token 存储。
- 外层同级目录名称相近，但不能直接假设是同一项目代码来源；本次可信代码源是 `azurekiln-oauth2`。
- 外层根目录这份总结用于人工研究；主项目内同名总结用于 Git 追踪。
