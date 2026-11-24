# 手机号认证（运营商号码认证）接入说明

本文档说明 VaultSSO 内置的**可选**手机号认证能力，包含三条互相独立的通道：

| 通道 | 标识 | 用途 | 关键接口 |
| --- | --- | --- | --- |
| H5 本机号码一键登录 | `h5` | 浏览器中通过运营商网页 SDK 取本机号码并登录 | 阿里云号码认证 `GetAuthToken` / `GetPhoneWithToken` |
| App 本机号码一键登录 | `app` | 原生 App 通过官方 SDK 取号后，由服务端换取手机号 | 阿里云号码认证 `GetMobile` |
| 短信验证码 | `sms` | 发送并校验短信验证码，用于登录和当前手机号验证 | 阿里云短信 `SendSmsVerifyCode` / `CheckSmsVerifyCode` |

另有独立的**运营商账号授权**实现（天翼账号 WEB/H5），见文末「天翼账号授权」。

> 三条通道**默认全部关闭**。关闭或配置不完整时，服务端不会发起任何上游请求；前端对应入口也会隐藏。

---

## 1. 代码就绪 vs. 外部开通

本仓库提供的是**代码与接口层面的就绪**，不代表已经在真实环境完成运营商/云厂商的开通。上线前你仍然必须完成下列**外部**工作，仓库无法代办：

- 在阿里云号码认证控制台开通号码认证服务，创建方案并获取 **SceneCode**。
- 登记允许的 **H5 页面 Origin / URL**（需与实际部署域名完全一致）。
- 从控制台下载官方网页 SDK 并自行托管到同源或 HTTPS 地址（见 `h5SdkUrl`）。**本仓库不内置该 SDK，也不提供任何伪造的 SDK 资源。**
- 申请并通过审核的**短信签名**与**短信模板**。
- 为原生 App 准备官方 SDK，并在 App 侧使用控制台分配的 App 密钥（**App 不使用本服务端 AccessKey**）。
- 使用真实、有效的运营商 SIM 卡做端到端联调（网页一键登录通常要求用户**关闭 Wi-Fi** 并在移动网络下授权）。

在这些外部条件满足之前，即使打开开关，真实号码认证也无法完成。遇到失败时需结合本服务日志、SDK 返回码和运营商控制台状态定位。

---

## 2. 配置项

配置来源有两层，优先级从低到高：

1. **环境变量**（前缀 `PHONE_AUTH_`），适合首次部署。
2. **管理后台保存的加密覆盖值**（存储在既有加密私有设置中，键名 `phoneAuth`，会保留其它设置分区），适合运行期调整。

### 2.1 字段表

| 字段 | 环境变量 | 说明 |
| --- | --- | --- |
| `h5Enabled` | `PHONE_AUTH_H5_ENABLED` | 启用 H5 一键登录，默认 `false` |
| `appEnabled` | `PHONE_AUTH_APP_ENABLED` | 启用 App 一键登录，默认 `false` |
| `smsEnabled` | `PHONE_AUTH_SMS_ENABLED` | 启用短信验证码，默认 `false` |
| `allowRegistration` | `PHONE_AUTH_ALLOW_REGISTRATION` | 允许手机号注册新账号，默认 `false`；仍需全局开启注册 |
| `accessKeyId` | `PHONE_AUTH_ACCESS_KEY_ID` | 阿里云 AccessKey ID |
| `accessKeySecret` | `PHONE_AUTH_ACCESS_KEY_SECRET` | 阿里云 AccessKey Secret（**仅服务端**） |
| `securityToken` | `PHONE_AUTH_SECURITY_TOKEN` | 可选，STS 临时凭证的 SecurityToken |
| `sceneCode` | `PHONE_AUTH_SCENE_CODE` | 号码认证方案 Code |
| `h5Origin` | `PHONE_AUTH_H5_ORIGIN` | 允许的 H5 页面 Origin，例如 `https://sso.example.com` |
| `h5Url` | `PHONE_AUTH_H5_URL` | H5 页面 URL，例如 `https://sso.example.com/oauth2/authorize` |
| `h5SdkUrl` | `PHONE_AUTH_H5_SDK_URL` | 官方网页 SDK 的自托管地址（同源路径或 HTTPS） |
| `smsSchemeName` | `PHONE_AUTH_SMS_SCHEME_NAME` | 短信方案名 |
| `smsSignName` | `PHONE_AUTH_SMS_SIGN_NAME` | 短信签名 |
| `smsTemplateCode` | `PHONE_AUTH_SMS_TEMPLATE_CODE` | 短信模板 Code |
| `smsTemplateParam` | `PHONE_AUTH_SMS_TEMPLATE_PARAM` | 短信模板参数（JSON），默认 `{"code":"##code##","min":"5"}` |

### 2.2 密钥处理语义

- **空白保留**：管理后台提交时，`accessKeySecret` / `securityToken` 留空表示**保持现有值不变**，不会被清空。
- **显式清除**：勾选 `clearAccessKeySecret` / `clearSecurityToken`（后台对应「清除」勾选框）才会明确清空。
- 管理端接口只返回 `hasAccessKeySecret` / `hasSecurityToken` 布尔标志，**永不回传密钥明文**。

### 2.3 就绪判定

管理端 `adminConfig` 返回 `ready: { h5, app, sms }`：

- `h5`：已配置 AccessKey 对 + `sceneCode` + `h5Origin` + `h5Url` + 合法 `h5SdkUrl`。
- `app`：已配置 AccessKey 对。
- `sms`：已配置 AccessKey 对 + `smsSignName` + `smsTemplateCode`。

公共投影 `publicConfig` 返回 `{ h5:{enabled,available,sdkUrl}, app:{enabled,available}, sms:{enabled,available,resendSeconds:60}, registrationEnabled }`。`available` = 已启用且就绪。前端仅依据 `available` 决定是否显示入口。

---

## 3. 管理端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/phone-auth` | 读取配置（非密钥字段 + 就绪标志） |
| `PUT` | `/api/admin/phone-auth` | 保存配置（含空白保留 / 显式清除语义） |

---

## 4. 公共与登录接口

| 方法 | 路径 | 请求体 | 返回 |
| --- | --- | --- | --- |
| `GET` | `/api/auth/phone/config` | — | 公共能力位（`no-store`） |
| `POST` | `/api/auth/phone/h5/token` | `{session_days, return_to, ...OAuthParameters}` | 网页 SDK 的 `accessToken` / `jwtToken` + 本地 `challengeId` |
| `POST` | `/api/auth/phone/h5/login` | `{challengeId, spToken}` | 登录 / MFA / 原生 OAuth 交接结果 |
| `POST` | `/api/auth/phone/app/login` | `{accessToken, session_days, ...registeredOAuthParameters}` | 登录 / MFA / 交接结果 |
| `POST` | `/api/auth/phone/sms/send` | `{phone, session_days, return_to, ...registeredOAuthParameters}` | `{challengeId, retryAfter:60, expiresIn:300}` |
| `POST` | `/api/auth/phone/sms/login` | `{challengeId, code}` | 登录 / MFA / 交接结果 |
| `POST` | `/api/profile/phone/sms/send` | 空对象 | 针对当前已绑定手机号的 `{challengeId, retryAfter, expiresIn}` |
| `POST` | `/api/profile/phone/sms/verify` | `{challengeId, code}` | 校验当前手机号，`{verified:true, user}` |

约定：

- 错误返回稳定、可读的 `error` / `error_description`，**不会**泄漏上游原始错误、token 或手机号明文。
- 关闭或未就绪的通道一律拒绝，且**零上游调用**。
- `CheckSmsVerifyCode` 只有在 `Model.VerifyResult = PASS` 时才视为通过。

---

## 5. H5 一键登录前端流程

1. 用户点击「本机号码一键登录」后，前端才 `POST /api/auth/phone/h5/token` 获取 SDK token。
2. **只有在此刻**才按需加载 `h5SdkUrl` 指向的官方 SDK（`window.PhoneNumberServer`）。移动端/网络失败时有可读降级提示。
3. 调用 `checkLoginAvailable` 判断本机号码可用性（成功码 `600000`）。
4. 调用 `getLoginToken` 弹出运营商授权页；必须保留 SDK 的用户同意和中间四位补充流程。成功回调返回 `spToken`；官方 `watch(status, data)` 中 `status === 2` 表示用户主动返回或关闭授权页。
5. `POST /api/auth/phone/h5/login` 用 `{challengeId, spToken}` 完成登录。服务端始终自行用 `spToken` 换取手机号，**绝不信任前端上报的号码**。

> H5 一键登录通常要求用户**关闭 Wi-Fi**、处于移动数据网络，并接受运营商协议。

---

## 6. App 一键登录

原生 App 使用官方 SDK 取号，然后把 SDK 返回的 `accessToken` 发给服务端：

```http
POST /api/auth/phone/app/login
Content-Type: application/json

{ "accessToken": "<SDK 返回的 token>", "session_days": 1 }
```

服务端调用 `GetMobile` 换取手机号并登录。App 侧凭据由控制台分配，**不使用服务端 AccessKey**，也不放入任何浏览器可读存储。

若此次登录属于已登记的 OAuth 客户端授权，App 还必须把该客户端原始授权参数一并传入；回调地址必须是客户端登记值，并建议使用 PKCE：

```http
POST /api/auth/phone/app/login
Content-Type: application/json

{
  "accessToken": "<SDK 返回的 token>",
  "session_days": 7,
  "client_id": "<已登记的客户端 ID>",
  "redirect_uri": "<该客户端登记的回调地址>",
  "scope": "openid profile",
  "state": "<本次随机 state>",
  "code_challenge": "<PKCE challenge>",
  "code_challenge_method": "S256"
}
```

完成登录后，原生客户端收到授权码和原样 `state`，再按现有 OAuth Token API 兑换；原生请求不会依赖 VaultSSO 浏览器 Cookie。若账户需要 TOTP 或邮箱二次验证，先按现有 MFA pending 流程完成验证，再继续授权码交接。

---

## 7. 短信验证码

### 7.1 登录

```http
POST /api/auth/phone/sms/send
Content-Type: application/json

{ "phone": "13800138000", "session_days": 1 }
```

返回 `{ "challengeId": "...", "retryAfter": 60, "expiresIn": 300 }`。前端按 `retryAfter` 做倒计时，提交时：

```http
POST /api/auth/phone/sms/login
Content-Type: application/json

{ "challengeId": "...", "code": "123456" }
```

### 7.2 当前手机号验证（个人中心）

已登录用户可验证**当前已绑定**的手机号（服务端据此自行推导账号与目标号码，不接受任意号码）：

```http
POST /api/profile/phone/sms/send
Content-Type: application/json

{}
```

```http
POST /api/profile/phone/sms/verify
Content-Type: application/json

{ "challengeId": "...", "code": "123456" }
```

验证成功后号码标记为已验证；该流程**不会静默替换**绑定关系。若验证期间手机号或登录状态发生变化，会返回可读的过期错误，需要重新发送。

---

## 8. 天翼账号授权（`tianyi_web` / `tianyi_h5`）

天翼账号是**运营商账号授权**，与上面的「网络一键登录」不同：

- 在管理后台「安全 → 第三方登录 Provider」新增 Provider：选择「天翼账号授权（WEB）」或「天翼账号授权（H5）」，填写唯一的 Provider Key、显示名称、运营商分配的 App ID 与 App Secret，并保持启用。把页面展示的统一回调地址登记到对应天翼应用；实际入口是 `/api/v1/auth/oauth/oidc/login?provider=<Provider Key>`。
- 天翼类型不使用 OIDC Discovery、Scope、JWKS 或 UserInfo 字段；管理表单会隐藏这些字段。保存后可在 Provider 列表查看应用 ID、密钥是否已保存、授权类型及回调/登录地址。
- 申请并开通对应的天翼账号登录能力，准备好 App ID / App Secret 和登记回调地址。保存凭据只代表系统已配置，不能替代天翼侧开通、应用审核或真实账号联调。
- 专用适配器 `services/tianyi.js`：固定官方 WEB/H5 授权与 token 端点；先验证 `appId + paras` 回调签名，再解密并比较授权流程中的 `state`，同时检查时间戳新鲜度与一次性绑定。
- 换取结果要求 token `result = 10000` 且返回**非空、字符串**的 `openId`。

> ⚠️ **重要**：天翼返回的 `openId` 是**应用维度的身份标识**，它**不是**经过验证的手机号或邮箱。系统不会据此声明 `phone_number_verified` / `email_verified`。请勿把它当作号码认证或实名手机号使用。

网页 OAuth 客户端可以把上面的 Provider 登录地址作为第三方登录入口；App 如需 OAuth 授权码交接，仍需使用自己的已登记 `client_id`、`redirect_uri`、`state` 与 PKCE 参数。天翼的 `openId` 登录与 Aliyun PNVS 手机号一键认证、短信验证码发送是独立能力。

---

## 9. 安全要点

- AccessKey Secret / SecurityToken 仅存于服务端加密设置，任何接口都不回传明文。
- H5/App token 只用于服务端换号，前端不落任何凭据到 Web Storage。
- 短信挑战码按用途命名空间隔离（登录 / 当前号码验证 / H5 登录），单次消费、有尝试上限与过期时间，复用既有持久化验证码表，无新增表结构。
- 通道关闭或配置不完整 → 零上游请求。
