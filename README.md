# AzureKiln OAuth2 / VaultSSO

## 简体中文

AzureKiln OAuth2 是一个独立的 OAuth2 / OpenID Connect 身份提供方，主目录是 `azurekiln-oauth2`。当前项目使用 Node.js、Express、MySQL、JWT 和 Tailwind 风格前端，提供登录、注册、授权码登录、令牌签发、用户资料、OAuth 客户端管理和访问令牌审计。

### 当前状态

- 后端入口：`server.js`
- 数据库初始化：`db/init.js`
- 种子数据：`scripts/init-db.js`
- 模型：`models/User.js`、`models/Client.js`、`models/Token.js`
- 前端页面：`authorize.html`、`profile.html`、`success.html`、`error.html`、`consent.html`、`public/apps.html`、`public/tokens.html`、`public/api-docs.html`
- 已有检查命令：`npm run check`
- 管理页 `/apps.html` 和 `/tokens.html` 仅管理员可访问
- 按钮操作已包含加载/禁用/确认反馈，危险操作使用页面内二次确认

### 支持的标准能力

- OAuth 2.0 Authorization Code Grant
- OAuth 2.0 Client Credentials Grant
- OAuth 2.0 Refresh Token Grant
- PKCE：`plain` 和 `S256`
- OpenID Connect Discovery：`/.well-known/openid-configuration`
- OAuth 2.0 Authorization Server Metadata：`/.well-known/oauth-authorization-server`
- JWKS 元数据占位：`/.well-known/jwks.json`
- OpenID Connect UserInfo：`/oauth2/userinfo`
- Token Introspection：`/oauth2/introspect`
- Token Revocation：`/oauth2/revoke`
- 客户端认证：`client_secret_basic` 和 `client_secret_post`

说明：当前令牌使用 HS256 和 `JWT_SECRET` 签名，因此 JWKS 不公开公钥；生产环境建议改为 RS256/ES256 并公开真实 JWKS。

### 快速开始

```bash
cd azurekiln-oauth2
npm install
```

创建 MySQL 数据库：

```sql
CREATE DATABASE vaultsso_oauth2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

复制 `.env.example` 为 `.env` 并修改数据库和密钥：

```env
DB_DRIVER=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=vaultsso_oauth2
PORT=3146
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:3146
JWT_SECRET=replace-this-with-a-long-random-secret
TOKEN_EXPIRY=1h
REFRESH_TOKEN_EXPIRY=7d
```

初始化表结构和演示数据：

```bash
npm run init-db
```

启动服务：

```bash
npm start
```

打开 `http://localhost:3146/oauth2/authorize`。

无 MySQL 的开发/演示模式：

```bash
# PowerShell
$env:DB_DRIVER="memory"; npm start
```

该模式会自动创建 `demo@vaultsso.com` 管理员和内置 OAuth 客户端，适合本机验证前端页面、管理页和 OAuth2 流程。内存数据会在服务停止后清空。

### 演示账号和客户端

管理员账号：

- 用户名：`demo@vaultsso.com`
- 密码：`demo123`

内置客户端：

- `salesforce-prod` / `salesforce-secret`
- `slack-workspace` / `slack-secret`
- `github-enterprise` / `github-secret`
- `azure-portal` / `azure-secret`

每个内置客户端都包含 `http://localhost:3146/callback` 作为本地回调地址。

### 前端页面

| 路径 | 功能 |
| --- | --- |
| `/` | 跳转到授权登录页 |
| `/login` | 跳转到授权登录页 |
| `/oauth2/authorize` | 登录、注册、OAuth 授权入口 |
| `/oauth2/success`、`/success` | 登录成功页 |
| `/profile` | 当前用户资料、邮箱、头像和密码管理 |
| `/apps.html` | 管理员 OAuth2 客户端管理 |
| `/tokens.html` | 管理员访问令牌审计和撤销 |
| `/api-docs.html` | 前端接口文档 |
| `/oauth2/consent` | 授权确认页面 |
| `/oauth2/error` | 错误展示页面 |
| `/callback` | 本地 OAuth 回调演示页面 |
| `/oauth2/logout` | 清除会话后返回登录页 |

### 后端接口

| 方法 | 路径 | 权限 | 功能 |
| --- | --- | --- | --- |
| `GET` | `/.well-known/openid-configuration` | 公开 | OIDC Discovery |
| `GET` | `/.well-known/oauth-authorization-server` | 公开 | OAuth2 Authorization Server Metadata |
| `GET` | `/.well-known/jwks.json` | 公开 | JWKS 元数据占位 |
| `GET` | `/oauth2/authorize` | 公开/会话 | 授权请求入口 |
| `POST` | `/oauth2/authorize` | 公开 | 登录并继续授权 |
| `POST` | `/oauth2/register` | 公开 | 注册并继续授权 |
| `POST` | `/oauth2/token` | 客户端认证 | 授权码、刷新令牌、客户端凭证换取令牌 |
| `GET` | `/oauth2/userinfo` | Bearer Token | 返回 OIDC 用户信息 |
| `POST` | `/oauth2/introspect` | 客户端认证 | 检查同一客户端访问令牌的活跃状态 |
| `POST` | `/oauth2/revoke` | 客户端认证 | 撤销同一客户端的访问令牌或刷新令牌 |
| `GET` | `/api/me` | 会话 | 当前用户资料 |
| `GET` | `/api/profile` | 会话 | 当前用户资料 |
| `PUT` | `/api/profile` | 会话 | 修改资料、邮箱、头像或密码 |
| `GET` | `/api/clients` | 管理员 | 客户端列表 |
| `POST` | `/api/clients` | 管理员 | 创建客户端 |
| `PUT` | `/api/clients/:id` | 管理员 | 更新客户端 |
| `DELETE` | `/api/clients/:id` | 管理员 | 删除客户端 |
| `GET` | `/api/tokens` | 管理员 | 访问令牌列表 |
| `DELETE` | `/api/tokens/:id` | 管理员 | 删除访问令牌 |

### 授权码 + PKCE 示例

生成 `code_verifier`，并用 SHA-256 生成 `code_challenge`。授权请求：

```text
GET http://localhost:3146/oauth2/authorize?response_type=code&client_id=salesforce-prod&redirect_uri=http://localhost:3146/callback&scope=openid%20profile%20email&state=demo&code_challenge=CODE_CHALLENGE&code_challenge_method=S256
```

换取令牌：

```bash
curl -X POST http://localhost:3146/oauth2/token \
  -u "salesforce-prod:salesforce-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=http://localhost:3146/callback" \
  -d "code_verifier=CODE_VERIFIER"
```

只有授权请求包含 `offline_access` scope 时，授权码换取令牌的响应才会包含 `refresh_token`。

客户端凭证：

```bash
curl -X POST http://localhost:3146/oauth2/token \
  -u "salesforce-prod:salesforce-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "scope=openid profile email"
```

### 验证

```bash
npm run check
```

该命令对服务端、数据库初始化脚本和模型运行 `node --check`。

## 繁體中文

AzureKiln OAuth2 是一個獨立的 OAuth2 / OpenID Connect 身分提供方，主目錄是 `azurekiln-oauth2`。目前專案使用 Node.js、Express、MySQL、JWT 和 Tailwind 風格前端，提供登入、註冊、授權碼登入、權杖簽發、使用者資料、OAuth 用戶端管理與存取權杖稽核。

### 目前狀態

- 後端入口：`server.js`
- 資料庫初始化：`db/init.js`
- 種子資料：`scripts/init-db.js`
- 模型：`models/User.js`、`models/Client.js`、`models/Token.js`
- 前端頁面：`authorize.html`、`profile.html`、`success.html`、`error.html`、`consent.html`、`public/apps.html`、`public/tokens.html`、`public/api-docs.html`
- 已有檢查命令：`npm run check`
- 管理頁 `/apps.html` 和 `/tokens.html` 僅管理員可存取
- 按鈕操作包含載入、停用與確認回饋，危險操作使用頁面內二次確認

### 支援的標準能力

- OAuth 2.0 Authorization Code Grant
- OAuth 2.0 Client Credentials Grant
- OAuth 2.0 Refresh Token Grant
- PKCE：`plain` 與 `S256`
- OpenID Connect Discovery：`/.well-known/openid-configuration`
- OAuth 2.0 Authorization Server Metadata：`/.well-known/oauth-authorization-server`
- JWKS 中繼資料佔位：`/.well-known/jwks.json`
- OpenID Connect UserInfo：`/oauth2/userinfo`
- Token Introspection：`/oauth2/introspect`
- Token Revocation：`/oauth2/revoke`
- 用戶端驗證：`client_secret_basic` 與 `client_secret_post`

說明：目前權杖使用 HS256 和 `JWT_SECRET` 簽章，因此 JWKS 不公開公鑰；正式環境建議改為 RS256/ES256 並公開真實 JWKS。

### 快速開始

```bash
cd azurekiln-oauth2
npm install
```

建立 MySQL 資料庫：

```sql
CREATE DATABASE vaultsso_oauth2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

複製 `.env.example` 為 `.env` 並修改資料庫與密鑰：

```env
DB_DRIVER=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=vaultsso_oauth2
PORT=3146
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:3146
JWT_SECRET=replace-this-with-a-long-random-secret
TOKEN_EXPIRY=1h
REFRESH_TOKEN_EXPIRY=7d
```

初始化資料表與示範資料：

```bash
npm run init-db
```

啟動服務：

```bash
npm start
```

開啟 `http://localhost:3146/oauth2/authorize`。

無 MySQL 的開發/示範模式：

```bash
# PowerShell
$env:DB_DRIVER="memory"; npm start
```

此模式會自動建立 `demo@vaultsso.com` 管理員和內建 OAuth 用戶端，適合本機驗證前端頁面、管理頁與 OAuth2 流程。記憶體資料會在服務停止後清空。

### 示範帳號和用戶端

管理員帳號：

- 使用者名稱：`demo@vaultsso.com`
- 密碼：`demo123`

內建用戶端：

- `salesforce-prod` / `salesforce-secret`
- `slack-workspace` / `slack-secret`
- `github-enterprise` / `github-secret`
- `azure-portal` / `azure-secret`

每個內建用戶端都包含 `http://localhost:3146/callback` 作為本機回呼地址。

### 前端頁面

| 路徑 | 功能 |
| --- | --- |
| `/` | 轉向授權登入頁 |
| `/login` | 轉向授權登入頁 |
| `/oauth2/authorize` | 登入、註冊、OAuth 授權入口 |
| `/oauth2/success`、`/success` | 登入成功頁 |
| `/profile` | 目前使用者資料、信箱、頭像和密碼管理 |
| `/apps.html` | 管理員 OAuth2 用戶端管理 |
| `/tokens.html` | 管理員存取權杖稽核與撤銷 |
| `/api-docs.html` | 前端 API 文件 |
| `/oauth2/consent` | 授權確認頁面 |
| `/oauth2/error` | 錯誤顯示頁面 |
| `/callback` | 本機 OAuth 回呼示範頁面 |
| `/oauth2/logout` | 清除工作階段後返回登入頁 |

### 後端介面

| 方法 | 路徑 | 權限 | 功能 |
| --- | --- | --- | --- |
| `GET` | `/.well-known/openid-configuration` | 公開 | OIDC Discovery |
| `GET` | `/.well-known/oauth-authorization-server` | 公開 | OAuth2 Authorization Server Metadata |
| `GET` | `/.well-known/jwks.json` | 公開 | JWKS 中繼資料佔位 |
| `GET` | `/oauth2/authorize` | 公開/工作階段 | 授權請求入口 |
| `POST` | `/oauth2/authorize` | 公開 | 登入並繼續授權 |
| `POST` | `/oauth2/register` | 公開 | 註冊並繼續授權 |
| `POST` | `/oauth2/token` | 用戶端驗證 | 授權碼、刷新權杖、用戶端憑證換取權杖 |
| `GET` | `/oauth2/userinfo` | Bearer Token | 回傳 OIDC 使用者資訊 |
| `POST` | `/oauth2/introspect` | 用戶端驗證 | 檢查同一用戶端存取權杖的活躍狀態 |
| `POST` | `/oauth2/revoke` | 用戶端驗證 | 撤銷同一用戶端的存取權杖或刷新權杖 |
| `GET` | `/api/me` | 工作階段 | 目前使用者資料 |
| `GET` | `/api/profile` | 工作階段 | 目前使用者資料 |
| `PUT` | `/api/profile` | 工作階段 | 修改資料、信箱、頭像或密碼 |
| `GET` | `/api/clients` | 管理員 | 用戶端清單 |
| `POST` | `/api/clients` | 管理員 | 建立用戶端 |
| `PUT` | `/api/clients/:id` | 管理員 | 更新用戶端 |
| `DELETE` | `/api/clients/:id` | 管理員 | 刪除用戶端 |
| `GET` | `/api/tokens` | 管理員 | 存取權杖清單 |
| `DELETE` | `/api/tokens/:id` | 管理員 | 刪除存取權杖 |

### 授權碼 + PKCE 範例

產生 `code_verifier`，並以 SHA-256 產生 `code_challenge`。授權請求：

```text
GET http://localhost:3146/oauth2/authorize?response_type=code&client_id=salesforce-prod&redirect_uri=http://localhost:3146/callback&scope=openid%20profile%20email&state=demo&code_challenge=CODE_CHALLENGE&code_challenge_method=S256
```

換取權杖：

```bash
curl -X POST http://localhost:3146/oauth2/token \
  -u "salesforce-prod:salesforce-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=http://localhost:3146/callback" \
  -d "code_verifier=CODE_VERIFIER"
```

只有授權請求包含 `offline_access` scope 時，授權碼換取權杖的回應才會包含 `refresh_token`。

### 驗證

```bash
npm run check
```

## English

AzureKiln OAuth2 is a standalone OAuth2 / OpenID Connect provider. The main project directory is `azurekiln-oauth2`. It uses Node.js, Express, MySQL, JWT, and Tailwind-style frontend pages for sign-in, registration, authorization code login, token issuance, profile management, OAuth client administration, and access token auditing.

### Current Status

- Backend entry point: `server.js`
- Database initializer: `db/init.js`
- Seed script: `scripts/init-db.js`
- Models: `models/User.js`, `models/Client.js`, `models/Token.js`
- Frontend pages: `authorize.html`, `profile.html`, `success.html`, `error.html`, `consent.html`, `public/apps.html`, `public/tokens.html`, `public/api-docs.html`
- Check command: `npm run check`
- `/apps.html` and `/tokens.html` are admin-only pages
- User actions provide loading, disabled, success/error, or in-page confirmation feedback

### Supported Standards

- OAuth 2.0 Authorization Code Grant
- OAuth 2.0 Client Credentials Grant
- OAuth 2.0 Refresh Token Grant
- PKCE: `plain` and `S256`
- OpenID Connect Discovery: `/.well-known/openid-configuration`
- OAuth 2.0 Authorization Server Metadata: `/.well-known/oauth-authorization-server`
- JWKS metadata placeholder: `/.well-known/jwks.json`
- OpenID Connect UserInfo: `/oauth2/userinfo`
- Token Introspection: `/oauth2/introspect`
- Token Revocation: `/oauth2/revoke`
- Client authentication: `client_secret_basic` and `client_secret_post`

Note: tokens are currently signed with HS256 and `JWT_SECRET`, so JWKS does not expose public keys. For production, prefer RS256/ES256 and publish a real JWKS.

### Quick Start

```bash
cd azurekiln-oauth2
npm install
```

Create the MySQL database:

```sql
CREATE DATABASE vaultsso_oauth2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Copy `.env.example` to `.env` and update database credentials and secrets:

```env
DB_DRIVER=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=vaultsso_oauth2
PORT=3146
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:3146
JWT_SECRET=replace-this-with-a-long-random-secret
TOKEN_EXPIRY=1h
REFRESH_TOKEN_EXPIRY=7d
```

Initialize schema and demo data:

```bash
npm run init-db
```

Start the server:

```bash
npm start
```

Open `http://localhost:3146/oauth2/authorize`.

Development/demo mode without MySQL:

```bash
# PowerShell
$env:DB_DRIVER="memory"; npm start
```

This mode automatically creates the `demo@vaultsso.com` admin user and seeded OAuth clients, so local page, admin, and OAuth2 flow verification can run without MySQL. In-memory data is cleared when the server stops.

### Demo Account and Clients

Admin account:

- Username: `demo@vaultsso.com`
- Password: `demo123`

Seeded clients:

- `salesforce-prod` / `salesforce-secret`
- `slack-workspace` / `slack-secret`
- `github-enterprise` / `github-secret`
- `azure-portal` / `azure-secret`

Every seeded client includes `http://localhost:3146/callback` as a local redirect URI.

### Frontend Pages

| Path | Purpose |
| --- | --- |
| `/` | Redirects to the authorization login page |
| `/login` | Redirects to the authorization login page |
| `/oauth2/authorize` | Sign-in, registration, and OAuth authorization entry |
| `/oauth2/success`, `/success` | Sign-in success page |
| `/profile` | Current user profile, email, avatar, and password management |
| `/apps.html` | Admin OAuth2 client management |
| `/tokens.html` | Admin access token audit and revocation |
| `/api-docs.html` | Frontend API documentation |
| `/oauth2/consent` | Consent page |
| `/oauth2/error` | Error display page |
| `/callback` | Local OAuth callback demo page |
| `/oauth2/logout` | Clears the session and returns to sign-in |

### Backend API

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/.well-known/openid-configuration` | Public | OIDC Discovery |
| `GET` | `/.well-known/oauth-authorization-server` | Public | OAuth2 Authorization Server Metadata |
| `GET` | `/.well-known/jwks.json` | Public | JWKS metadata placeholder |
| `GET` | `/oauth2/authorize` | Public/session | Authorization request entry |
| `POST` | `/oauth2/authorize` | Public | Sign in and continue authorization |
| `POST` | `/oauth2/register` | Public | Register and continue authorization |
| `POST` | `/oauth2/token` | Client auth | Authorization code, refresh token, and client credentials grants |
| `GET` | `/oauth2/userinfo` | Bearer token | OIDC UserInfo response |
| `POST` | `/oauth2/introspect` | Client auth | Activity check for access tokens issued to the same client |
| `POST` | `/oauth2/revoke` | Client auth | Access token or refresh token revocation for the same client |
| `GET` | `/api/me` | Session | Current user profile |
| `GET` | `/api/profile` | Session | Current user profile |
| `PUT` | `/api/profile` | Session | Update profile, email, avatar, or password |
| `GET` | `/api/clients` | Admin | Client list |
| `POST` | `/api/clients` | Admin | Create client |
| `PUT` | `/api/clients/:id` | Admin | Update client |
| `DELETE` | `/api/clients/:id` | Admin | Delete client |
| `GET` | `/api/tokens` | Admin | Access token list |
| `DELETE` | `/api/tokens/:id` | Admin | Delete access token |

### Authorization Code + PKCE Example

Generate a `code_verifier`, then derive a SHA-256 `code_challenge`. Authorization request:

```text
GET http://localhost:3146/oauth2/authorize?response_type=code&client_id=salesforce-prod&redirect_uri=http://localhost:3146/callback&scope=openid%20profile%20email&state=demo&code_challenge=CODE_CHALLENGE&code_challenge_method=S256
```

Token exchange:

```bash
curl -X POST http://localhost:3146/oauth2/token \
  -u "salesforce-prod:salesforce-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=http://localhost:3146/callback" \
  -d "code_verifier=CODE_VERIFIER"
```

The authorization-code token response includes `refresh_token` only when the authorization request included the `offline_access` scope.

Client credentials:

```bash
curl -X POST http://localhost:3146/oauth2/token \
  -u "salesforce-prod:salesforce-secret" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "scope=openid profile email"
```

### Verification

```bash
npm run check
```

This runs `node --check` over the server, database initializer, seed script, and models.
