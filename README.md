# AzureKiln OAuth2 登录网关

Node.js / Express / MySQL 登录网关，提供本地账号、邮件验证、验证器 MFA、外部 OAuth/OIDC 登录、华为账号一键登录，以及 OAuth2 授权码、刷新令牌、客户端凭据和 OIDC UserInfo 接口。用户资料包含标准化手机号（E.164）。

客户端和第三方提供方由管理员在管理后台或数据库中明确配置。正式启动只连接 MySQL，读取配置和表结构版本。`init-db` 负责表结构迁移及版本记录；用户、管理员角色、OAuth 客户端和第三方提供方均由运维管理。

## 部署

要求 Node.js 22 或更新版本，以及 MySQL 8 / InnoDB。网关部署在 HTTPS 反向代理后，默认监听 `127.0.0.1:3146`。配置说明见 [.env.example](.env.example)。

执行 `npm run build:deploy` 默认生成 `dist/azurekiln-oauth2.zip`。打包前后会检查页面引用的脚本和样式是否齐全。业务样式在 `public/css/`，页面逻辑及国际化脚本在 `public/js/`；部署包不包含 `public/assets/` 中的字体和图标资源，也不包含 `.env`、私钥及依赖目录。部署时保留或单独提供现有 `public/assets/`，页面仍通过 `/assets/vaultsso-fonts.css` 加载字体和图标。

1. 安装锁文件中的生产依赖：`npm ci --omit=dev`。
2. 按 `.env.example` 配置数据库、公开 HTTPS 地址和服务密钥；SMTP 与 Turnstile 可在后台配置。执行 `npm run check:config` 检查静态配置。
3. 在接入流量前备份数据库，用具备 DDL 权限的迁移账号显式执行 `npm run init-db`。随后使用仅具备该数据库所需读写权限的应用账号启动。
4. 明确配置管理员账号及其 `users.role=admin`。公开注册得到的账号始终是普通用户；现有管理员角色会保留。
5. 运行 `npm start`，在管理后台添加实际 OAuth 客户端及第三方提供方。

`npm start` 不负责建表、升级表结构或配置初始身份。缺少迁移版本、密钥或必要数据库配置时启动会失败。首次配置管理员也可以先注册并验证自己的邮箱，再通过数据库按已核实的用户 ID 明确授予角色。

配置文件固定从项目根目录的 `.env` 读取，与进程工作目录无关。相对签名私钥、公钥集和数据库 CA 路径也以项目根目录为基准。面板、PM2、systemd 或容器注入的环境变量优先于 `.env`，包括显式设置的空值。

`npm run check:config` 显示 `.env` 路径、JWT 密钥的来源和字节数，并检查运行时、签名密钥及数据库静态配置；它不打印密钥，不改写配置或数据库，也不发送邮件。应在与实际服务相同的环境中执行。

遇到 `JWT_SECRET` 启动错误时，先运行该命令。若来源是 `environment`，需要同步修改进程管理器中的旧值；仅编辑 `.env` 无法覆盖它。已有真实数据时，先备份旧密钥和数据库，再安排更换，否则依赖旧密钥加密的提供方与验证器凭据可能无法读取。

`JWT_SECRET` 必须是独立生成的高熵随机值，至少 32 字节。可以在受控终端执行以下命令生成，然后保存到机密配置中：

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

OIDC / Access Token 使用持久化 RSA 私钥进行 RS256 签名，客户端通过 `/.well-known/jwks.json` 获取公钥。`OIDC_SIGNING_KEY_FILE` 指向该私钥文件；建议使用 3072 位 RSA，将文件放在静态资源目录之外，并限制文件权限。生产启动不会生成临时签名私钥。客户端只接收自己的 Client Secret 和公开 JWKS。

可选的 Cloudflare Turnstile 可在后台“安全设置”中修改站点密钥和私钥，也可首次使用 `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET_KEY` 提供默认值；两者必须同时配置。私钥仅保存在服务端，浏览器只获取站点密钥。配置后，未保存过开关值的安装默认启用登录和注册验证；后台已保存的“登录人机验证”和“注册人机验证”开关仍优先生效。网页表单通过 `captcha_surface=web` 使用 Turnstile：启用登录验证时页面加载后即显示组件，注册验证在打开注册页签时显示。未带此标记的 App 直连接口继续使用图形验证码，默认 `GET /api/auth/config` 也报告图形验证码；网页读取 `/api/auth/config?surface=web`。未配置密钥时均使用图形验证码。服务端通过 Cloudflare Siteverify 核验 token、动作和生产环境域名；部署服务器必须能访问 `challenges.cloudflare.com`。站点密钥需允许实际登录域名。

例如，在受控目录中显式生成私钥（已存在时拒绝覆盖）：

```sh
node -e "const fs=require('node:fs'); fs.mkdirSync('keys',{recursive:true}); const key=require('node:crypto').generateKeyPairSync('rsa',{modulusLength:3072}).privateKey; fs.writeFileSync('keys/oidc-private.pem',key.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});"
```

相应设置 `OIDC_SIGNING_KEY_FILE=keys/oidc-private.pem`，并通过操作系统权限限制读取者。

反向代理需要转发真实客户端地址，并在 `TRUST_PROXY` 中填写实际代理 IP/CIDR。未设置时仅信任本机 `127.0.0.1/32,::1/128`，适用于宝塔/Nginx 反代到本机 Node 服务；显式设置为空可关闭代理信任。远程生产 MySQL 必须配置 `DB_TLS=true`；私有 CA 使用 `DB_TLS_CA_FILE`，服务始终验证证书。数据库连接统一使用 UTC。

宝塔/Nginx 的站点反代 `location` 中应包含以下设置，并在修改后重载 Nginx、重启 Node 服务：

```nginx
proxy_pass http://127.0.0.1:3146;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

IP 记录使用可信代理链中的客户端地址；客户端伪造的更早转发地址不会覆盖紧邻本机代理的来源地址。若 Nginx 前还有 CDN，需在 Nginx 配置该 CDN 的可信来源和真实 IP 头。Docker/远程代理需明确填写实际代理地址。历史记录中的 `127.0.0.1` 无法恢复，配置生效后新登录记录会使用真实 IP。

SMTP 未配置或发送失败时，邮件验证流程返回错误。SMTP 管理页保存后立即生效，重启后从 JSON 配置文件恢复。后台保存的 SMTP 和 Turnstile 设置优先于 `.env`；默认写入 `data/admin-settings.json`，可通过 `ADMIN_SETTINGS_FILE` 指向部署期间保留的可写路径。请备份该文件和 `JWT_SECRET`，并限制服务账号以外的读取权限；修改 `JWT_SECRET` 后，已保存的凭据无法解密。

## 升级现有部署

此次安全修复包含数据库迁移和接入行为变更，细节见 [安全审查](docs/SECURITY_REVIEW.md)。

- 升级前备份数据库并执行 `npm run init-db`；该命令迁移结构、记录结构版本，并从仍保留的用户令牌回填真实的应用使用记录，不创建用户、管理员或应用配置。
- **结构版本 7** 新增 `user_authenticators` 和 `users.totp_revision`，支持一个账号绑定多个独立验证器，保留原有绑定。版本 6 的 `user_app_usage` 持久保留每个用户登录过的应用及首次记录、最近活动时间；版本 5 的二步验证服务端回跳信息、版本 4 的华为主体分组、版本 3 的 `require_pkce` 和版本 2 的手机号、外部身份迁移仍适用。旧版本启动时会因结构版本不匹配而失败，必须先完成迁移。
- `phone_e164` 是**存储生成列**（`GENERATED ALWAYS AS … STORED`）并带唯一索引 `uq_users_phone_e164`。迁移时不要手工写入该列；如果现有数据里已经存在重复手机号，迁移会因为唯一索引冲突而失败，需要先人工清理。
- `userinfo_method` / `userinfo_token_in` 配置通用 OIDC 的 UserInfo 调用，默认值为 `GET` / `header`。华为一键登录授权码接口使用独立的 POST + JSON 协议，不使用这两个 UserInfo 配置项。
- 华为账号优先以 `union_id` 存放在 `user_identities.provider_user_id`，对应 App 的 `open_id` 存放在 `provider_secondary_id`；仅有 OpenID 时，以 OpenID 为主标识。展示时使用各自标识，不把两者互换。标识按区分大小写（`utf8mb4_bin`）比较。同主体的各 App 提供方需设置相同的 `huaweiUnionScope`，系统才会按华为返回的 UnionID 关联同一账号；各 App 的 OpenID 仍分别保留。
- 每个客户端默认要求 **S256 PKCE**。管理员只能为确实无法支持 PKCE 的客户端关闭要求；关闭会降低授权码被截获时的防护。关闭后可同时省略 `code_challenge` 和 `code_challenge_method`，但只要提供其中任一项，就必须提供完整有效的 S256 参数对。换码时始终要求与已签发授权码中 challenge 匹配的 verifier；后续修改客户端策略不会改变既有授权码的要求。
- ID Token 和 Access Token 改为 RS256。内部会话和刷新凭据增加严格的用途与签发者校验，旧凭据需要重新登录签发。
- 每次刷新都会返回新的 `refresh_token`，调用方必须替换保存的旧值。
- 生产回调地址要求 HTTPS，且不允许用户信息或 fragment。生产客户端认证拒绝不足 32 字节的旧密钥；新密钥保存时加盐散列，只在创建/更新响应中提供明文。
- 历史明文 Client Secret 和 TOTP 数据保留读取兼容；通过管理后台轮换客户端密钥、重新绑定验证器，可升级为散列/加密存储。删除源代码里的旧配置不会删除数据库中已存在的记录，既有用户与客户端应由运维核查。
- 外部提供方配置仅来自数据库。删除提供方后，环境变量不会将其重新启用或写回数据库。
- `JWT_SECRET` 同时用于保护内部凭据和数据库中的加密字段。更换前需要安排凭据重录；无法解密的第三方提供方会停止提供登录入口，管理员可以在安全中心重新填写密钥。验证器用户应保存恢复码，以便重新绑定。

RSA 签名密钥与 `JWT_SECRET` 独立。轮换 RSA 私钥时，使用 `OIDC_PREVIOUS_JWKS_FILE` 保留尚未过期令牌对应的**公钥**。该文件不接受私钥字段。

## 接入规则

本服务面向管理员注册的可信、能够保管 Client Secret 的机密客户端。授权在已有登录会话下自动完成；公开 SPA/移动端客户端、逐次用户 consent、`prompt`、`max_age` 和非 query 响应模式不在当前实现范围，相关未支持的请求参数会被拒绝。每个客户端默认要求 PKCE；仅对已明确关闭此要求的客户端，授权请求才可同时省略 PKCE 参数。

典型授权请求（示例中的 ID 和地址需替换为实际注册配置；`code_challenge` 是**每次请求现场计算的值**，不能照抄占位符）：

```text
GET /oauth2/authorize?response_type=code&client_id=YOUR_CLIENT_ID&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback&scope=openid%20profile%20email&state=RANDOM_STATE&nonce=RANDOM_NONCE&code_challenge=BASE64URL_SHA256_OF_CODE_VERIFIER&code_challenge_method=S256
```

使用 PKCE 时（客户端要求 PKCE，或可选客户端主动发送任一 PKCE 参数），必须提供完整的 S256 参数对：`code_challenge` 是 `code_verifier` 的 SHA-256 摘要再做 **base64url 无填充**编码，结果固定为 **43 个字符**，且只能包含 `A-Z a-z 0-9 - _`；`code_challenge_method` 必须精确为 `S256`。服务端按 `^[A-Za-z0-9_-]{43}$` 校验，不满足即返回 `invalid_request`。关闭 PKCE 的客户端可以同时省略两项；若使用 PKCE，换码时仍必须提供匹配的 verifier。常见错误：照抄文档里的占位符、只传其中一项、`code_challenge_method` 不是精确的 `S256`（如 `plain`）、用十六进制摘要（64 字符）、或用了带 `=` 填充的标准 base64（44 字符）。

应用保存随机 `state`、`nonce` 和 `code_verifier`，使用 SHA-256 生成 `code_challenge`。换码通过服务端调用 `/oauth2/token`，使用 HTTP Basic 或请求体中的 Client Secret 进行认证；不要同时使用两种客户端认证方法。

生成一对可用的本地测试值：

```sh
node -e "const c=require('node:crypto');const v=c.randomBytes(48).toString('base64url');console.log('code_verifier  =',v);console.log('code_challenge =',c.createHash('sha256').update(v).digest('base64url'));"
```

- `openid` 才会签发 ID Token，UserInfo 也要求该 scope。
- `profile` 提供姓名、用户名、头像与更新时间；`email` 提供邮箱和验证状态；`phone` 提供 `phone_number`（E.164）和 `phone_number_verified`。
- 初次授权包含 `offline_access` 才签发刷新令牌。刷新只能保留或缩小授权范围。
- `client_credentials` 代表应用本身，数据库中的 `user_id` 为空；它不能申请 `openid`、`profile`、`email`、`offline_access` 用户身份权限。
- Introspection 和 Revocation 只接受客户端自身的令牌。
- 需要立即感知停用/撤销的业务 API 应调用 Introspection；仅离线验签可能在令牌到期前继续接受它。
- 禁用/修改客户端会撤销其现有凭据。改密、重置密码、封禁与强制退出会撤销相关会话和 OAuth 凭据。

外部身份以提供方和精确 subject 绑定，不按邮箱自动合并本地账号。已有用户应在重新登录后的 5 分钟内从个人资料页主动绑定；回调时必须仍处于发起绑定的同一会话。首次绑定验证器同样要求最近登录；添加其他验证器须校验现有动态码或恢复码。外部登录也必须通过本地账号启用的验证器或邮件二次验证。

**合并误建的普通 OIDC 账号**：先重新登录要保留的本地账号，在个人资料页“第三方账号”中选择对应提供方的“合并账号”。入口为 `GET /api/v1/auth/oauth/oidc/login?provider=<key>&intent=merge&return_to=/profile`；网关保存发起时的会话，回调时用外部提供方的授权码证明待合并账号，并再次检查同一会话创建不足五分钟。成功返回 `/profile?account_merged=1`；失败返回个人资料页并显示错误。直接绑定尚未创建本地账号的外部身份仍使用普通“绑定账号”入口。

只有系统自动创建、仅有这一个提供方身份且没有本地密码、验证器、手机号、积分或人工修改资料的普通源账号可以自动合并。原源账号可有与提供方身份一致的已验证邮箱；合并不会覆盖目标账号邮箱。成功后，事务转移身份与应用使用记录，删除源账号及其凭据，撤销目标账号其他会话和 OAuth 凭据，保留当前操作会话。资料不符合条件或身份发生冲突时拒绝，不会仅凭相同邮箱自动合并。

## 多设备验证器

在“个人信息 → 验证器 → 添加验证器”填写设备名称，输入现有验证器动态码或未使用的恢复码，再用新设备扫描新二维码并输入其动态码确认。每台设备使用独立密钥，添加成功后旧、新设备均可完成登录验证，无需先解绑旧设备。首次绑定要求在登录后 5 分钟内操作。

个人信息页列出各验证器并提供单独删除入口；删除需要动态码或恢复码，删除最后一个验证器前明确提示会关闭验证器二步验证。管理员重置会删除全部验证器。旧绑定显示为已有验证器，未记录的绑定时间和最近使用时间不补造。

恢复码属于整个账号，添加设备保留已有恢复码；输入一次即失效。重新生成恢复码需要有效动态码，旧恢复码全部作废。新增绑定请求 5 分钟过期，最多允许 5 次确认失败；关闭添加窗口会取消待确认绑定。系统不会重新显示已启用设备的二维码或密钥。

确认新增、删除设备或重新生成恢复码会保留当前操作会话并撤销其他会话与 OAuth 凭据。尚未完成的旧验证流程随账号安全状态变化失效。升级时先备份数据库、执行 `npm run init-db`，再重启服务；本地测试未替代真实 MySQL 和线上部署验收。

## 手机号

手机号在服务端统一归一化为 E.164 后存储，入口是 `services/phone.js`，任何写入路径（华为一键登录、管理员配置、后续短信通道）都必须先经过它。

区分两个容易混淆的概念：

- **国家/地区代码（country code）**：国际拨号前缀，例如中国大陆 `86`、美国 `1`。它决定路由和唯一性，**必须存储**，在数据库中是 `users.phone_country_code`（不带 `+`）。
- **国内长途冠码（trunk prefix）**：例如中国大陆手机号的 `0`（`013800138000`）。它只在“纯国内格式”里出现，国际格式必须去掉，因此**从不存储**。`+1` 和 `+7` 没有冠码，规则不同。

不要把国家代码和国家号码直接做字符串拼接：`+1 8005550100` 与 `+18 0055 50100` 会得到相同的数字串，产生错误合并。归一化结果写入 `users.phone_e164` 这一存储生成列，唯一性由数据库的 `uq_users_phone_e164` 保证，应用层不做二次判断。

`services/phone.js` 接受的输入形式（结果等价）：

```text
+86 138 0013 8000      0086 13800138000      8613800138000
13800138000            013800138000          0 13800138000      138-0013-8000
→ { countryCode: '86', nationalNumber: '13800138000', e164: '+8613800138000' }
```

`+44 07911 123456` → `+447911123456`（冠码 `0` 被去掉）。`123`、空串等无法解析的输入返回 `null`，`User.create` / `User.update` 会抛 `Invalid phone number`。

`phone` 是新增的授权 scope。客户端在授权请求中带上 `scope=openid phone` 后，UserInfo 和 ID Token 才会包含：

- `phone_number`：E.164 格式，例如 `+8613800138000`；
- `phone_number_verified`：布尔值。

未授予 `phone` scope 时这两个声明不会出现。界面展示统一使用掩码（`services/phone.js` 的 `maskPhone` / `maskE164`），`/api/profile` 返回 `phoneMasked` 供页面直接渲染，同时保留 `phoneE164` 供应用自己决定展示方式。

个人资料页提供手机号修改和解绑入口；管理员可以在“用户管理 → 用户详情”中修改或解绑手机号。支持分别填写国际区号和国家号码，服务端统一归一化并检查号码占用。

手动改号后，`phone_verified` 和验证时间会被清除；号码未变或保存其他资料时保留原验证状态。用户不能自行将号码标为已验证。修改或解绑要求最近登录或校验当前密码。当前未接入短信验证通道；华为账号一键登录可以在华为确认号码有效时设置验证状态。

### 多个华为 App 与一个本地账号

每个华为 App 使用独立的提供方配置和自己的 Client ID / Client Secret。OpenID 标识该 App 中的华为用户；同一华为主体下的 App 可以通过共同的 UnionID 关联到一个本地账号。

在提供方配置中填写 `huaweiUnionScope`（华为主体关联组）。只有管理员明确配置了相同的非空关联组，且华为服务端返回相同 UnionID，才会跨 App 查找同一个本地账号。各 App 的 OpenID 分别保存在各自绑定记录中。关联组是本系统的信任配置，必须仅用于确属同一华为主体的 App；它不是由客户端请求声明的身份信息。

关联组留空时保持各提供方独立；没有 UnionID 时只在当前 App 内按 OpenID 识别。已有绑定指向不同本地账号时会报冲突，不自动合并历史账号。管理员可从“账号应用绑定”页（`/account-bindings.html`，接口 `GET /api/admin/account-bindings`）按本地账号查看已保存的 App、Client ID、OpenID、UnionID、关联组和绑定时间；历史记录未保存的信息显示为未记录，不补造历史绑定。

升级已有部署后，先运行 `npm run init-db` 更新到数据库 schema v7，再启动服务。新增的 `oidc_providers.huawei_union_scope` 默认空串，保留原有独立提供方行为。相同主体的首次登录通过 MySQL 命名锁和事务串行处理，避免多个 App 同时创建重复本地账号。

管理面板的“用户应用”（`/account-bindings.html`）按用户展示登录过的 OAuth 应用和第三方应用绑定；个人信息页展示本人应用记录、App ID、华为 OpenID / UnionID 和主体分组。成功兑换授权码或刷新用户令牌后才更新应用使用记录，客户端凭据模式和未兑换的授权码不计入。令牌过期、撤销或应用配置删除后保留已记录的应用历史。升级时只能从数据库仍保留的用户令牌恢复历史记录；已删除的旧令牌对应历史无法完整还原。

## 华为账号一键登录

面向已申请华为 Account Kit 敏感权限的企业开发者，走一键登录路线（`/oauth2/v6/quickLogin/getPhoneNumber`）。服务端适配层是 `services/huawei.js`，接口是 `POST /api/v1/auth/oauth/huawei/quick-login`。

**配置**：在管理后台“安全设置 → 第三方登录”新增提供方，类型选择 `huawei_quicklogin`，填写该 App 在 AGC 的 Client ID / Client Secret，启用并保存。Token 地址留空时使用 `https://account-api.cloud.huawei.com/oauth2/v6/quickLogin/getPhoneNumber`；历史误填的同路径 `oauth-login.cloud.huawei.com` 地址会在调用时纠正为官方地址，无需数据库迁移。

网关向华为发送 **POST + `application/json`**，请求体是 `{code, clientId, clientSecret}`，没有 `grant_type`、`client_id`、`client_secret` 或 `access_token`。这与旧版 Access Token + form 的 UserInfo 接口是两套协议；管理页的通用 UserInfo 请求配置不参与一键登录换码。依据：[华为官方授权码接口文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-references/account-api-get-user-info-quicklogin-by-code)。

**应用侧对接**：HarmonyOS 客户端通过 HTTPS 将 Account Kit 获取的短期 `Authorization Code` 发给自己的应用服务端；应用服务端再调用本 SSO 网关。客户端不保存华为 Client Secret，也不把返回的掩码手机号当作完整号码。此仓库只有应用服务端/SSO 实现，没有 HarmonyOS 客户端工程。

```text
GET  /api/v1/auth/oauth/huawei/config
  → { enabled, providers: [{ key, providerName }], quickLoginUrl, mfaCompleteUrl, phoneAutolink }

POST /api/v1/auth/oauth/huawei/quick-login
Content-Type: application/json

{ "authorizationCode": "华为客户端 SDK 返回的授权码",
  "provider": "可省略，只有一个华为提供方时自动选择",
  "client_id": "YOUR_CLIENT_ID",
  "redirect_uri": "https://app.example.com/callback",
  "state": "RANDOM_STATE", "nonce": "RANDOM_NONCE",
  "scope": "openid profile phone",
  "code_challenge": "...", "code_challenge_method": "S256" }
```

网关兼容旧请求字段 `code`，同时提交两个字段时内容必须相同。`provider` 在只启用一个华为提供方时可以省略。传入 `client_id` / `redirect_uri` 时，还须按已注册 OAuth 客户端提交重定向地址、`state`、`nonce` 和 S256 PKCE 参数；请求 `scope: "openid profile phone"` 并确保客户端获准 `phone` scope，才能在授权码交接响应中获得完整手机号。应用服务端再按自身会话协议把登录结果交给客户端，不要把华为 Client Secret 传回客户端。

应用服务端接收客户端的 `authorizationCode` 后，可用 Node.js `fetch` 转交网关（仅展示请求和状态分支，实际服务须校验客户端、`state` 和 PKCE，并管理自身会话）：

```js
const response = await fetch(process.env.SSO_BASE_URL + '/api/v1/auth/oauth/huawei/quick-login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ authorizationCode, provider, client_id, redirect_uri,
    state, nonce, scope: 'openid profile phone', code_challenge,
    code_challenge_method: 'S256' })
});
const result = await response.json();
if (!response.ok) throw new Error(result.error || 'quick_login_failed');
if (result.binding_required) { /* 显示绑定已有账号或创建新账号的选择 */ }
else if (result.mfa_required) { /* 继续二步验证 */ }
else { /* 兑换 authorization_code，建立应用会话，再返回用户结果 */ }
```

主要响应形态：

| 形态 | 触发条件 | 响应 |
| --- | --- | --- |
| 授权码 | 传了 `client_id` / `redirect_uri` | `{ authorization_code, state, redirect_uri, redirect, user, phone, phoneStatus, phoneBinding }`，应用服务端用 `authorization_code` 走 `/oauth2/token` 换码；未获准 `phone` scope 时 `phone: null`、`phoneStatus: "scope_not_granted"` |
| 会话 Cookie | 未传 `client_id` / `redirect_uri` | `{ user, phone, phoneStatus, phoneBinding }`，同时下发网关会话 Cookie |
| 二次验证 | 账号启用了验证器，或开启了邮件验证码 | `{ mfa_required: true, factor, email, pending_token, pending_header: 'X-Oidc-Pending' }` |
| 绑定决策 | 尚无可直接认领的身份 | `{ binding_required: true, binding_token, phone_available, phone_status }`；需要绑定已有账号或明确跳过创建新账号 |
| 绑定结果 | 请求体带 `intent: "link"`（需已登录） | `{ linked: true, user, phone, phoneStatus, phoneBinding }` |
| 合并结果 | 请求体带 `intent: "merge"`，已有账号会话足够新 | `{ merged: true, user, phone, phoneStatus, phoneTransferred }`；原本已绑定当前账号时 `{ merged: false, linked: true, user }` |

**二次验证提交不需要 Cookie**：把返回的 `pending_token` 通过 `X-Oidc-Pending` 请求头（或 `body.pending_token`）带到 `POST /api/v1/auth/oauth/oidc/complete`。如果最初提交了 OAuth 客户端参数，验证成功后返回 `{ authorization_code, state, redirect_uri, redirect, user, phone, phoneStatus, phoneBinding }`，不建立网关会话 Cookie；应用服务端继续兑换授权码。如果没有 OAuth 交接，返回 `{ redirect, user, phone, phoneStatus, phoneBinding }` 并建立网关会话 Cookie。OAuth 交接下的完整号码仍受已申请和获准的 `phone` scope 限制。响应会给出 `pending_header`，不必硬编码头名称。

`binding_required` 和 `mfa_required` 都是待完成状态，不能按最终登录用户对象读取 `phone`。最终响应中的 `phone` 是华为本次返回且验证有效的完整 E.164 号码；`phoneStatus` 为 `verified`、`conflict`、`unverified`、`not_returned`，OAuth 交接未获准 `phone` scope 时为 `scope_not_granted`。`phoneBinding` 表示本地绑定结果。获准展示手机号时，`user.phoneE164` 是本地账号当前存储号码，发生 `conflict` 时两者可能不同；未获准的 OAuth 交接也会隐藏 `user` 中的手机号字段。华为未返回完整可用号码或未获准相关敏感权限时，网关不会补造号码。

**误建账号合并**：已创建独立华为账号、后来要并入已有本地账号时，先重新登录已有账号，确保网关会话创建不足五分钟；再以该会话调用同一 `POST /api/v1/auth/oauth/huawei/quick-login`，提交 `{ "intent": "merge", "provider": "对应华为 App", "authorizationCode": "新取得的华为授权码" }`。网关用新授权码证明源华为身份，成功返回 `{ merged: true, user, phone, phoneStatus, phoneTransferred }`；已经属于当前账号则返回 `{ merged: false, linked: true, user }`。应用服务端须保管已有账号会话及新授权码，不能仅凭手机号或客户端自称的 UnionID 发起合并。

合并在一个数据库事务中转移可安全迁移的华为身份和应用使用记录，必要时转移不冲突的已验证手机号，撤销源账号凭据后删除误建源账号。源账号已有本地密码、验证器、积分、人工修改的资料、其他不适合自动迁移的数据，或与目标账号手机号冲突时返回 409，需要人工核查；目标账号的密码、角色、邮箱和验证器保持原有状态。会话过期会返回 403 `reauthentication_required`。同一明确配置的 `huaweiUnionScope` 内，华为返回相同 UnionID 且无历史冲突时，不同 App 的 OpenID 本来就会自动关联同一本地账号，无需执行合并。

**身份标识**：华为返回两个标识，都要保存，且都是区分大小写的字符串。

- `openId`：**应用维度**，同一个用户在不同 App 中不同；有 UnionID 时存为第二标识，无 UnionID 时作为主标识。
- `unionId`：**开发者维度**，有值时存为主标识。同一显式华为主体分组内可关联同一用户，各 App 仍分别保留 OpenID。

适配层读取官方 `openId` / `unionId` / `phoneNumber` / `phoneNumberValid` / `purePhoneNumber` / `phoneCountryCode`，并兼容历史字段别名。手机号有效性为 `0` 时不用于自动认领已有账号。

**手机号自动关联已有账号**：安全开关 `huawei_phone_autolink` 当前新部署默认开启，由安全设置的“账户策略”控制。应用服务端应读取配置接口返回的 `phoneAutolink`，因为管理员可能修改当前部署的值。

- 开启后：没有现有华为身份绑定时，华为返回的已验证手机号与本地账号的已验证号码一致，直接绑定该账号，不需要手动绑定页面。
- 关闭时：仍按已保存的华为标识匹配或创建账号；不按手机号认领其他账号。
- 手机号写入当前账号时不覆盖已有不同号码；唯一键冲突保留原号码并记录 `phone:conflict`。

运营商可能二次放号。启用手机号自动关联前须确认业务能接受新机主通过华为号码认领旧账号的风险。

**`email` 与手机号的关系**：华为一键登录可能不返回邮箱。此时网关会写入一个 `@users.invalid` 结尾的合成邮箱占位（`isSyntheticEmail` 可识别），并且**不会**把二次验证走邮件通道，避免把验证码发到一个不存在的地址。这类账号的二次验证依赖验证器（TOTP）。

**跨站防护**：该接口按“机器调用”判定，只在 `Sec-Fetch-*` / `Origin` / `Referer` 证明是跨站浏览器请求时才拒绝。服务端到服务端的调用（没有这些头）正常放行；浏览器直接调用仍受保护。

**限流**：按来源 IP 每 10 分钟 30 次，超限返回 429 和 `Retry-After`。

**错误不回显上游报文**：HTTP 200 也可能包含 `resultCode` 业务错误。网关分别提示授权码无效（400）、Client ID / Secret 配置错误（503）、一键登录权限缺失（403）和上游地址/网络错误（502）；日志只保留固定说明、HTTP 状态和错误码，不记录华为原始报文、授权码、手机号或凭据。`60180003` 表示 App 与提供方的 Client ID 不一致，`60010013` 表示 Client Secret 不正确，`60180004/5/6` 表示授权码过期、重复使用或失效。

## 接口和页面

| 路径 | 用途 |
| --- | --- |
| `/oauth2/authorize` | 登录、注册和授权入口 |
| `/profile` | 当前账号、邮箱、密码、验证器和会话管理 |
| `/admin.html` | 管理中心 |
| `/api-docs.html` | 浏览器内接口说明 |
| `/.well-known/openid-configuration` | OIDC 发现文档 |
| `/.well-known/oauth-authorization-server` | OAuth2 服务端元数据 |
| `/.well-known/jwks.json` | RSA 公钥集 |
| `/oauth2/token` | 授权码兑换、刷新、客户端凭据 |
| `/oauth2/userinfo` | 按 scope 返回用户声明 |
| `/oauth2/introspect`、`/oauth2/revoke` | 令牌状态与撤销 |
| `/api/v1/auth/oauth/oidc/login`、`/api/v1/auth/oauth/oidc/callback` | 外部登录与绑定 |
| `/api/v1/auth/oauth/huawei/config` | 华为一键登录配置与入口地址 |
| `/api/v1/auth/oauth/huawei/quick-login` | 华为账号一键登录换码 |
| `/api/v1/auth/oauth/oidc/complete` | 外部登录后的二次验证完成（支持 `X-Oidc-Pending` 头） |
| `/oauth2/mfa` | 外部登录后的本地二次验证 |

管理 API 和账号 API 的写请求需要合法的同源 `Origin` / `Referer` / Fetch Metadata，并按账号权限检查。OAuth 机密客户端的 Token / Introspection / Revocation 后端调用不依赖浏览器 Cookie。`/api/v1/auth/oauth/huawei/quick-login` 和 `/api/v1/auth/oauth/oidc/complete` 按**机器调用**判定：只有在 `Sec-Fetch-*` / `Origin` / `Referer` 明确证明是跨站浏览器请求时才拒绝，服务端到服务端的调用正常放行。

## 本地开发与验证

开发服务同样使用 MySQL；明确设置 `NODE_ENV=development` 后可以使用本地 HTTP，但仍需要独立密钥。自动化验证使用 `tests/support` 中的隔离数据库适配器和邮件捕获器，由测试代码显式注入；应用的启动路径不会加载这些文件，也不读取测试固定验证码。

```sh
npm ci
npm run check
npm run check:browser
npm audit --omit=dev
```

浏览器检查使用已安装的 Chrome；也可通过 `BROWSER_EXECUTABLE` 指向兼容 Chromium 的浏览器。测试仅监听随机本地端口，使用临时生成的测试凭据与签名密钥，不连接 `.env` 配置的数据库和 SMTP。

页面 JavaScript 位于 `public/js/pages/`，共享脚本位于 `public/js/`，业务样式位于 `public/css/`。字体与图标包保留在 `public/assets/` 并单独部署。CSP 仅允许本地脚本和字体。Tailwind 样式已编译并纳入仓库，修改 HTML、页面脚本或主题后执行：

```sh
npm run build:css
```

升级 Fontsource 依赖后执行 `npm run build:fonts` 更新字体和随附许可证。

`npm run check` 覆盖语法、页面脚本引用和安全流程回归。这些隔离测试不等同于真实 MySQL、HTTPS 反向代理、SMTP、外部提供方及业务客户端的部署验收。
