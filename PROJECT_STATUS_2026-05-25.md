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
