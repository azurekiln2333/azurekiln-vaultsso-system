# VaultSSO OAuth2 Provider

企业级 OAuth2 认证服务，基于现有的 VaultSSO 设计系统构建。

## 功能特性

- **OAuth2 授权码流程** - 完整实现 Authorization Code Grant
- **OpenID Connect** - 支持 OIDC 标准协议
- **刷新令牌** - 支持 offline\_access 获取长期访问
- **客户端凭证** - 支持 client\_credentials 授权类型
- **令牌管理** - 完整的令牌生命周期管理
- **安全设计** - JWT 签名、CSRF 防护、安全会话
- **MySQL 数据库** - 持久化存储用户和令牌数据

## 快速开始

### MySQL 数据库（当前唯一模式）

当前项目已移除内存版实现，服务端统一直接读取 MySQL。

#### 1. 安装依赖

```bash
cd oauth2
npm install
```

#### 2. 创建 MySQL 数据库

```sql
CREATE DATABASE vaultsso_oauth2 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

#### 3. 配置环境变量

复制示例配置文件：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=vaultsso_oauth2
JWT_SECRET=your-super-secret-jwt-key
```

#### 4. 初始化数据库

```bash
npm run init-db
```

#### 5. 启动服务

```bash
npm start
```

开发模式（支持热重载）:

```bash
npm run dev
```

服务将在 <http://localhost:3146> 启动

## OAuth2 端点

| 端点                                  | 方法   | 描述          |
| ----------------------------------- | ---- | ----------- |
| `/.well-known/openid-configuration` | GET  | OpenID 发现文档 |
| `/oauth2/authorize`                 | GET  | 授权端点        |
| `/oauth2/token`                     | POST | 令牌端点        |
| `/oauth2/userinfo`                  | GET  | 用户信息端点      |
| `/oauth2/introspect`                | POST | 令牌内省端点      |
| `/oauth2/revoke`                    | POST | 令牌撤销端点      |

## 预置客户端

| 客户端 ID              | 名称         | 回调地址                                           |
| ------------------- | ---------- | ---------------------------------------------- |
| `salesforce-prod`   | Salesforce | <https://login.salesforce.com/oauth2/callback> |
| `slack-workspace`   | Slack      | <https://slack.com/oauth2/callback>            |
| `github-enterprise` | GitHub     | <https://github.com/login/oauth/callback>      |

## 演示账号

- **用户名**: <demo@vaultsso.com>
- **密码**: demo123

## 授权流程示例

### 1. 发起授权请求

```
GET /oauth2/authorize?
    response_type=code&
    client_id=salesforce-prod&
    redirect_uri=http://localhost:3000/callback&
    scope=openid%20profile%20email&
    state=xyzABC123
```

### 2. 用户登录授权

用户在授权页面输入凭证，系统验证后重定向到回调地址并附带授权码。

### 3. 获取访问令牌

```bash
curl -X POST http://localhost:3000/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=http://localhost:3000/callback" \
  -d "client_id=salesforce-prod" \
  -d "client_secret=salesforce-secret"
```

### 4. 获取用户信息

```bash
curl http://localhost:3000/oauth2/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

## 支持的 Scopes

| Scope            | 描述             |
| ---------------- | -------------- |
| `openid`         | 必需，返回 ID Token |
| `profile`        | 访问用户资料信息       |
| `email`          | 访问用户邮箱地址       |
| `offline_access` | 获取刷新令牌         |

## 项目结构

```
oauth2/
├── server.js           # Express 服务器 (MySQL)
├── package.json        # 项目配置
├── .env.example        # 环境变量示例
├── authorize.html      # 授权登录页面
├── consent.html        # 授权同意页面
├── error.html          # 错误页面
├── config/
│   └── database.js     # 数据库配置
├── db/
│   └── init.js         # 数据库初始化
├── models/
│   ├── User.js         # 用户模型
│   ├── Client.js       # 客户端模型
│   └── Token.js        # 令牌模型
├── scripts/
│   └── init-db.js      # 数据库初始化脚本
└── public/
    ├── apps.html       # 应用管理页面
    ├── tokens.html     # 令牌管理页面
    └── api-docs.html   # API 文档页面
```

## 数据库表结构

系统会自动创建以下表：

| 表名               | 描述           |
| ---------------- | ------------ |
| `users`          | 用户账户信息       |
| `clients`        | OAuth2 客户端应用 |
| `auth_codes`     | 授权码          |
| `access_tokens`  | 访问令牌         |
| `refresh_tokens` | 刷新令牌         |
| `sessions`       | 用户会话         |

## 环境变量

| 变量            | 默认值                    | 描述        |
| ------------- | ---------------------- | --------- |
| `PORT`        | 3000                   | 服务端口      |
| `NODE_ENV`    | development            | 运行环境      |
| `JWT_SECRET`  | vaultsso-secret-key... | JWT 签名密钥  |
| `DB_HOST`     | localhost              | MySQL 主机  |
| `DB_PORT`     | 3306                   | MySQL 端口  |
| `DB_USER`     | root                   | MySQL 用户名 |
| `DB_PASSWORD` | -                      | MySQL 密码  |
| `DB_NAME`     | vaultsso\_oauth2       | 数据库名称     |

## 安全建议

生产环境部署时请注意：

1. **更换 JWT\_SECRET** - 使用强随机密钥
2. **启用 HTTPS** - 所有通信必须加密
3. **配置 CORS** - 限制允许的来源
4. **使用数据库** - 当前服务端已统一使用 MySQL 持久化数据
5. **添加速率限制** - 防止暴力攻击
6. **日志审计** - 记录所有认证事件

## 技术栈

- **Node.js** - 运行时环境
- **Express** - Web 框架
- **MySQL** - 数据库存储
- **jsonwebtoken** - JWT 处理
- **bcryptjs** - 密码哈希
- **uuid** - 唯一标识符生成
- **mysql2** - MySQL 客户端
- **dotenv** - 环境变量管理

## 设计系统

基于 VaultSSO 设计规范构建：

- **Tonal Depth** - 通过色调层次创建视觉深度
- **No-Line Rule** - 使用背景色变化代替边框
- **Ambient Shadows** - 柔和的环境阴影
- **Editorial Typography** - Manrope + Inter 字体组合

## License
