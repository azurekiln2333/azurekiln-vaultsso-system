(function () {
  const STORAGE_KEY = 'vaultsso.lang';
  const FALLBACK_LANG = 'en';

  const translations = {
    zh: {
      'common.brand': 'VaultSSO',
      'common.language.zh': '中文',
      'common.language.en': 'English',
      'common.action.profile': '进入个人信息页',
      'common.action.logout': '退出登录',
      'common.action.logout_short': '注销',
      'common.action.back_signin': '返回登录页',
      'common.action.view_profile': '查看个人信息',
      'common.action.view_apps': '查看应用授权',
      'common.action.view_tokens': '查看令牌',
      'common.action.redirect_now': '立即跳转',
      'common.action.open_profile': '打开个人信息页',
      'common.action.refresh': '刷新',
      'common.action.create': '新建',
      'common.action.save': '保存',
      'common.action.cancel': '取消',
      'common.action.edit': '编辑',
      'common.action.delete': '删除',
      'common.action.close': '关闭',
      'common.action.generate': '生成',
      'common.network_error': '网络请求失败，请稍后再试。',
      'common.loading': '加载中...',
      'common.unknown': '未知',
      'common.not_provided': '未提供',
      'common.none': '无',
      'common.not_generated': '未生成',
      'common.user_fallback': 'VaultSSO 用户',
      'common.app_fallback': 'VaultSSO 应用',

      'auth.page.title': 'VaultSSO | 登录 / 注册',
      'auth.hero.default_title': '登录后继续你的工作流',
      'auth.hero.default_description': '直接访问系统时，这里就是你的登录和注册入口。完成登录后，你可以进入个人信息页，自定义资料与密码。',
      'auth.hero.oauth_title': '先完成登录，再把你带回应用',
      'auth.hero.oauth_description': '{client} 正在请求访问你的账户信息。登录或注册后，我们会返回这次授权结果。',
      'auth.session.title': '{user} 已登录',
      'auth.session.default_text': '当前会话仍然有效，你可以直接进入个人信息页继续修改资料。',
      'auth.session.oauth_text': '如果继续这次授权，请直接登录或刷新页面；如果只是想管理资料，可以进入个人信息页。',
      'auth.oauth.eyebrow': 'Authorization Request',
      'auth.oauth.client': '应用正在请求授权',
      'auth.oauth.description': '登录后我们会将你安全地带回目标应用，并返回本次授权结果。',
      'auth.oauth.redirect_label': '回调地址',
      'auth.feature.profile_title': '登录后进入个人信息页',
      'auth.feature.profile_desc': '支持查看并修改昵称、用户名、邮箱、头像地址，以及更新登录密码。',
      'auth.feature.oauth_title': '兼容 OAuth 授权流程',
      'auth.feature.oauth_desc': '当页面带有客户端参数时，这里仍然会继续承担授权登录页的职责。',
      'auth.feature.register_title': '默认注册即创建会话',
      'auth.feature.register_desc': '新用户注册成功后会自动登录，不需要再回到登录页重复输入一次。',
      'auth.feature.demo_title': '演示账号可直接试用',
      'auth.feature.demo_desc': '用户名 `demo@vaultsso.com`，密码 `demo123`，适合先验证完整流程。',
      'auth.panel.default_title': '欢迎回来',
      'auth.panel.default_description': '登录现有账户，或者新建一个账户后直接进入系统。',
      'auth.panel.oauth_title': '继续到 {client}',
      'auth.panel.oauth_description': '登录现有账户，或者临时创建新账户后继续这次授权流程。',
      'auth.tab.login': '登录',
      'auth.tab.register': '注册',
      'auth.form.username_or_email': '用户名或邮箱',
      'auth.form.password': '密码',
      'auth.form.display_name': '显示名称',
      'auth.form.username': '用户名',
      'auth.form.email': '邮箱',
      'auth.form.confirm_password': '确认密码',
      'auth.form.root_hint': '直接访问根域名时，系统会默认进入这里。',
      'auth.form.profile_hint': '已有会话，去个人信息页',
      'auth.form.register_hint': '注册成功后会自动建立登录会话，并跳到成功页或继续 OAuth 回调。',
      'auth.placeholder.username_or_email': 'demo@vaultsso.com',
      'auth.placeholder.password': '请输入密码',
      'auth.placeholder.display_name': '例如：Alexander Chen',
      'auth.placeholder.username': '留空则默认使用邮箱',
      'auth.placeholder.email': 'name@company.com',
      'auth.placeholder.password_short': '至少 6 位',
      'auth.placeholder.confirm_password': '再次输入密码',
      'auth.button.login': '登录并继续',
      'auth.button.register': '创建账户并继续',
      'auth.status.signing_in': '登录中...',
      'auth.status.creating': '创建中...',
      'auth.status.redirecting': '操作成功，正在跳转...',
      'auth.status.password_mismatch': '两次输入的密码不一致，请重新确认。',
      'auth.forbidden.admin_required': '仅管理员可访问此资源。',
      'auth.footnote': '登录成功后，如果没有回调地址，系统会停在成功页，并提供进入个人信息页的入口。',

      'profile.page.title': 'VaultSSO | 个人信息',
      'profile.hero.title': '个人资料',
      'profile.hero.description': '当前页面以资料展示为主。显示名称、头像、邮箱和密码都通过弹窗修改，用户名为只读。',
      'profile.sidebar.success_title': '登录成功页',
      'profile.sidebar.success_desc': '查看无回调场景下的成功结果页与跳转说明。',
      'profile.sidebar.apps_title': '应用管理',
      'profile.sidebar.apps_desc': '查看已接入的 OAuth 应用与可授权范围。',
      'profile.sidebar.tokens_title': '令牌管理',
      'profile.sidebar.tokens_desc': '查看当前系统中的访问令牌与生命周期信息。',
      'profile.sidebar.logout_title': '退出登录',
      'profile.sidebar.logout_desc': '清除当前会话并返回登录 / 注册页。',
      'profile.loading': '正在加载个人信息...',
      'profile.section.basic_title': '基础资料',
      'profile.section.basic_desc': '修改这些信息后，个人信息页和后续返回的用户资料都会同步更新。',
      'profile.section.password_title': '密码修改',
      'profile.section.password_desc': '修改密码时需要先输入当前密码，新密码最少 6 位。',
      'profile.section.overview_title': '当前账户概览',
      'profile.section.overview_desc': '这些信息来自当前登录会话，保存资料后会自动刷新。',
      'profile.field.display_name': '显示名称',
      'profile.field.username': '用户名',
      'profile.field.username_hint': '用户名已锁定，不允许修改。',
      'profile.field.email': '邮箱',
      'profile.field.avatar': '头像地址',
      'profile.field.avatar_hint': '留空会使用系统生成的默认头像。',
      'profile.field.current_password': '当前密码',
      'profile.field.new_password': '新密码',
      'profile.field.confirm_new_password': '确认新密码',
      'profile.field.user_id': '用户 ID',
      'profile.field.email_verified': '邮箱状态',
      'profile.field.created_at': '创建时间',
      'profile.field.updated_at': '最近更新时间',
      'profile.button.edit_profile': '修改资料',
      'profile.button.edit_email': '修改邮箱',
      'profile.button.edit_password': '修改密码',
      'profile.button.save': '保存资料',
      'profile.button.update_password': '更新密码',
      'profile.modal.profile_title': '修改资料',
      'profile.modal.profile_desc': '你可以在这里修改显示名称和头像地址。',
      'profile.modal.email_title': '修改邮箱',
      'profile.modal.email_desc': '提交后会立即更新当前账户邮箱。',
      'profile.modal.password_title': '修改密码',
      'profile.modal.password_desc': '请输入当前密码，并设置新的登录密码。',
      'profile.value.password_masked': '已隐藏',
      'profile.tip.password_optional': '如果这次不修改密码，可以把密码相关输入框保持为空。',
      'profile.status.password_empty': '请输入当前密码和新密码后再提交。',
      'profile.status.password_mismatch': '两次输入的新密码不一致。',
      'profile.status.saving': '保存中...',
      'profile.status.updating_password': '更新中...',
      'profile.status.basic_updated': '基础资料已更新。',
      'profile.status.password_updated': '密码已更新，请使用新密码登录。',
      'profile.meta.email_verified': '已验证',
      'profile.meta.email_unverified': '未验证',
      'profile.meta.date_missing': '未记录',

      'apps.page.title': 'VaultSSO | OAuth2 应用',
      'apps.nav.applications': '应用',
      'apps.nav.tokens': '令牌',
      'apps.nav.docs': 'API 文档',
      'apps.hero.title': 'OAuth2 应用管理',
      'apps.hero.description': '这个页面会直接从服务器 API 读取数据库里的客户端配置，不再显示写死卡片。你可以在这里创建、编辑、删除并检索 OAuth2 客户端。',
      'apps.stats.total': '客户端总数',
      'apps.stats.active': '启用中的客户端',
      'apps.stats.redirects': '回调地址数量',
      'apps.stats.scopes': '唯一 Scope 数量',
      'apps.search.placeholder': '按名称、ID、回调地址或 scope 搜索...',
      'apps.status.loading': '正在从 /api/clients 加载应用...',
      'apps.status.loaded': '已从 /api/clients 加载 {count} 个客户端。',
      'apps.status.filtered': '根据关键词 “{keyword}” 找到 {count} 个客户端。',
      'apps.status.load_failed': '从服务器 API 加载应用失败。',
      'apps.list.empty_title': '没有找到应用',
      'apps.list.empty_desc': '当前搜索条件下没有匹配的 OAuth 客户端。',
      'apps.card.client_id': '客户端 ID：{id}',
      'apps.card.no_redirect': '未配置回调地址',
      'apps.card.redirect_count': '{count} 个回调地址',
      'apps.card.redirect_count_one': '{count} 个回调地址',
      'apps.card.no_scopes': '未配置 scope',
      'apps.card.created': '创建时间：{value}',
      'apps.card.updated': '更新时间：{value}',
      'apps.card.created_unknown': '创建时间：未知',
      'apps.card.updated_unknown': '更新时间：未知',
      'apps.card.active': '启用',
      'apps.card.inactive': '停用',
      'apps.editor.title_create': '新建客户端',
      'apps.editor.title_edit': '编辑客户端',
      'apps.editor.desc': '这里的表单会直接调用数据库版 API 保存客户端配置。',
      'apps.editor.field.id': '客户端 ID',
      'apps.editor.field.name': '名称',
      'apps.editor.field.secret': '客户端密钥',
      'apps.editor.field.logo': 'Logo 地址',
      'apps.editor.field.redirects': '回调地址',
      'apps.editor.field.scopes': 'Scopes',
      'apps.editor.field.active': '启用状态',
      'apps.editor.placeholder.id': '例如：emlog-prod',
      'apps.editor.placeholder.name': '例如：emlog',
      'apps.editor.placeholder.secret': '创建时可留空自动生成；编辑时留空表示不修改',
      'apps.editor.help_secret': '系统会按常见 OAuth 做法生成高熵、URL-safe 的随机密钥。创建时留空即可自动生成。',
      'apps.editor.placeholder.logo': 'https://example.com/logo.png',
      'apps.editor.placeholder.redirects': '每行一个回调地址',
      'apps.editor.placeholder.scopes': '可用逗号或换行分隔，例如：openid, profile, email',
      'apps.editor.active_yes': '启用',
      'apps.editor.active_no': '停用',
      'apps.editor.help_redirects': '至少填写一个完整的 URL，保存时会校验格式。',
      'apps.editor.help_scopes': '建议至少包含 openid、profile、email。',
      'apps.editor.create_success': '应用已创建。',
      'apps.editor.update_success': '应用已更新。',
      'apps.editor.secret_notice': '请立即保存客户端密钥：{secret}',
      'apps.editor.delete_confirm': '确认删除客户端 “{name}” 吗？此操作会同时影响相关授权码和令牌记录。',
      'apps.editor.delete_success': '应用已删除。',
      'apps.editor.saving_create': '创建中...',
      'apps.editor.saving_update': '保存中...',
      'apps.editor.deleting': '删除中...',
      'apps.guide.title': '快速开始',
      'apps.guide.step1.title': '1. 创建客户端记录',
      'apps.guide.step1.desc': '在这里新增或编辑 OAuth 客户端，保存后页面会直接反映数据库内容。',
      'apps.guide.step2.title': '2. 检查回调地址',
      'apps.guide.step2.desc': '确认显示出来的回调地址和 scope 与实际接入应用一致。',
      'apps.guide.step3.title': '3. 实际跑授权流程',
      'apps.guide.step3.desc': '修改客户端后，立刻用授权端点和 token 端点验证真实登录链路。',

      'success.page.title': 'VaultSSO | 登录成功',
      'success.title.login': '登录成功',
      'success.title.oauth': '授权成功',
      'success.message.login': '{user}，您的身份验证已经通过，VaultSSO 已成功建立登录会话。',
      'success.redirect.eyebrow': 'Redirect',
      'success.redirect.title': '即将回跳到应用',
      'success.redirect.description': '认证已完成，系统将自动把您带回请求登录的应用。',
      'success.redirect.client_label': '目标应用',
      'success.redirect.uri_label': '回调地址',
      'success.redirect.code_label': '授权码',
      'success.redirect.state_label': '状态值',
      'success.redirect.ready': '将在 {count} 秒后自动跳转',
      'success.redirect.manual': '如果没有自动跳转，您可以手动点击下面的按钮继续。',
      'success.no_redirect.eyebrow': 'Session Active',
      'success.no_redirect.title': '已完成登录，没有检测到需要重定向的目标',
      'success.no_redirect.description': '这通常表示您是在本系统内直接登录，或者发起登录时没有提供回调地址。当前页面就是登录成功结果页。',
      'success.sidebar.profile_title': '个人信息',
      'success.sidebar.profile_desc': '查看并修改昵称、用户名、邮箱、头像以及登录密码。',
      'success.sidebar.apps_title': '应用管理',
      'success.sidebar.apps_desc': '查看已经接入 OAuth2 的应用，以及授权关系。',
      'success.sidebar.docs_title': '接口文档',
      'success.sidebar.docs_desc': '继续查看授权码、令牌、用户信息等端点说明。',
      'success.sidebar.logout_title': '退出登录',
      'success.sidebar.logout_desc': '清除当前会话，返回登录页重新开始。',
      'success.hint.default': '如果这是一次普通登录，没有客户端回调地址，页面会停留在这里，明确告诉您登录已经成功。',
      'success.hint.redirect': '当前页面处于“授权成功后等待回跳”的状态，稍后会自动跳转到客户端配置的回调地址。',
      'success.hint.invalid_redirect': '回调地址格式不正确，无法自动跳转。',
      'success.redirect.description_client': '{client} 已拿到授权结果，系统会把您带回应用继续完成登录。',

      'auth.request.missing_pair': 'client_id 和 redirect_uri 必须同时提供',
      'auth.request.unknown_client': '未知客户端：{client}',
      'auth.request.invalid_redirect_uri': '无效的回调地址',
      'auth.invalid_credentials': '用户名或密码错误',
      'auth.required': '请先登录',
      'auth.login_success': '登录成功',
      'validation.email.invalid': '请输入有效的邮箱地址',
      'validation.username.required': '请输入用户名',
      'validation.password.min_length': '密码长度不能少于 6 位',
      'validation.password.confirm_mismatch': '两次输入的密码不一致',
      'validation.email.taken': '该邮箱已被注册',
      'validation.username.taken': '该用户名已被占用',
      'profile.display_name.required': '显示名称不能为空',
      'profile.username.required': '用户名不能为空',
      'profile.username.read_only': '用户名不允许修改',
      'profile.current_password.invalid': '当前密码不正确',
      'profile.password.min_length': '新密码长度不能少于 6 位',
      'profile.updated': '个人信息已更新',
      'oauth.code.invalid': '授权码无效',
      'oauth.code.expired': '授权码已过期',
      'oauth.client.id_mismatch': '客户端 ID 不匹配',
      'oauth.client.credentials.invalid': '客户端凭证无效',
      'oauth.refresh_token.invalid': '刷新令牌无效',
      'oauth.refresh_token.expired': '刷新令牌已过期',
      'oauth.grant.unsupported': '不支持的授权类型',
      'auth.header.invalid': '缺少授权头，或授权头格式无效',
      'auth.token.invalid_or_expired': '令牌无效或已过期',
      'auth.user_not_found': '未找到用户',
      'server.internal': '服务器内部错误',
      'clients.validation.id': '客户端 ID 格式无效',
      'clients.validation.id_taken': '客户端 ID 已存在',
      'clients.validation.name': '客户端名称不能为空',
      'clients.validation.secret': '客户端密钥不能为空',
      'clients.validation.redirects': '至少需要一个回调地址',
      'clients.validation.scopes': '至少需要一个 scope',
      'clients.validation.logo': 'Logo 地址无效',
      'clients.created': '应用已创建',
      'clients.updated': '应用已更新',
      'clients.deleted': '应用已删除',
      'clients.not_found': '未找到客户端'
    },
    en: {
      'common.brand': 'VaultSSO',
      'common.language.zh': 'Chinese',
      'common.language.en': 'English',
      'common.action.profile': 'Open Profile',
      'common.action.logout': 'Sign Out',
      'common.action.logout_short': 'Log out',
      'common.action.back_signin': 'Back to Sign In',
      'common.action.view_profile': 'View Profile',
      'common.action.view_apps': 'View Apps',
      'common.action.view_tokens': 'View Tokens',
      'common.action.redirect_now': 'Redirect Now',
      'common.action.open_profile': 'Open Profile',
      'common.action.refresh': 'Refresh',
      'common.action.create': 'Create',
      'common.action.save': 'Save',
      'common.action.cancel': 'Cancel',
      'common.action.edit': 'Edit',
      'common.action.delete': 'Delete',
      'common.action.close': 'Close',
      'common.action.generate': 'Generate',
      'common.network_error': 'Network request failed. Please try again later.',
      'common.loading': 'Loading...',
      'common.unknown': 'Unknown',
      'common.not_provided': 'Not provided',
      'common.none': 'None',
      'common.not_generated': 'Not generated',
      'common.user_fallback': 'VaultSSO User',
      'common.app_fallback': 'VaultSSO App',

      'auth.page.title': 'VaultSSO | Sign In / Sign Up',
      'auth.hero.default_title': 'Sign in to continue your workflow',
      'auth.hero.default_description': 'When you visit the system directly, this page becomes your default sign-in and sign-up entry. After signing in, you can open the profile page and customize your account information.',
      'auth.hero.oauth_title': 'Sign in first, then return to the app',
      'auth.hero.oauth_description': '{client} is requesting access to your account information. After you sign in or sign up, we will return the authorization result.',
      'auth.session.title': '{user} is already signed in',
      'auth.session.default_text': 'Your current session is still active. You can jump straight to the profile page and continue editing your information.',
      'auth.session.oauth_text': 'If you want to continue this authorization request, sign in again or refresh the page. If you only want to manage your account, open the profile page.',
      'auth.oauth.eyebrow': 'Authorization Request',
      'auth.oauth.client': 'An application is requesting authorization',
      'auth.oauth.description': 'After signing in, we will safely return you to the target application with the authorization result.',
      'auth.oauth.redirect_label': 'Redirect URI',
      'auth.feature.profile_title': 'Go to your profile after sign-in',
      'auth.feature.profile_desc': 'View and edit your display name, username, email, avatar URL, and password.',
      'auth.feature.oauth_title': 'Still works as an OAuth authorization page',
      'auth.feature.oauth_desc': 'When this page includes client parameters, it still behaves as the authorization sign-in page.',
      'auth.feature.register_title': 'Registration creates a session immediately',
      'auth.feature.register_desc': 'New users are signed in automatically after registration and do not need to log in again.',
      'auth.feature.demo_title': 'The demo account is ready to use',
      'auth.feature.demo_desc': 'Use `demo@vaultsso.com` with password `demo123` to verify the complete flow quickly.',
      'auth.panel.default_title': 'Welcome back',
      'auth.panel.default_description': 'Sign in with an existing account, or create a new account and continue immediately.',
      'auth.panel.oauth_title': 'Continue to {client}',
      'auth.panel.oauth_description': 'Sign in with an existing account, or create a temporary account and continue this authorization flow.',
      'auth.tab.login': 'Sign In',
      'auth.tab.register': 'Sign Up',
      'auth.form.username_or_email': 'Username or Email',
      'auth.form.password': 'Password',
      'auth.form.display_name': 'Display Name',
      'auth.form.username': 'Username',
      'auth.form.email': 'Email',
      'auth.form.confirm_password': 'Confirm Password',
      'auth.form.root_hint': 'When you open the root domain directly, the system will land here by default.',
      'auth.form.profile_hint': 'Already signed in? Open your profile',
      'auth.form.register_hint': 'After registration, a session is created automatically and you will continue to the success page or OAuth callback.',
      'auth.placeholder.username_or_email': 'demo@vaultsso.com',
      'auth.placeholder.password': 'Enter your password',
      'auth.placeholder.display_name': 'For example: Alexander Chen',
      'auth.placeholder.username': 'Leave empty to reuse your email',
      'auth.placeholder.email': 'name@company.com',
      'auth.placeholder.password_short': 'At least 6 characters',
      'auth.placeholder.confirm_password': 'Enter the password again',
      'auth.button.login': 'Sign In and Continue',
      'auth.button.register': 'Create Account and Continue',
      'auth.status.signing_in': 'Signing in...',
      'auth.status.creating': 'Creating account...',
      'auth.status.redirecting': 'Done. Redirecting...',
      'auth.status.password_mismatch': 'The two passwords do not match. Please check again.',
      'auth.forbidden.admin_required': 'Administrator access is required for this resource.',
      'auth.footnote': 'If there is no redirect URI after sign-in, the system will stay on the success page and provide a direct entry to the profile page.',

      'profile.page.title': 'VaultSSO | Profile',
      'profile.hero.title': 'Profile',
      'profile.hero.description': 'This page focuses on displaying your account information. Update your display name, avatar, email, and password through focused modal dialogs while keeping the username read-only.',
      'profile.sidebar.success_title': 'Success Page',
      'profile.sidebar.success_desc': 'Review the success page used when there is no callback target.',
      'profile.sidebar.apps_title': 'Apps',
      'profile.sidebar.apps_desc': 'View connected OAuth applications and their authorized scopes.',
      'profile.sidebar.tokens_title': 'Tokens',
      'profile.sidebar.tokens_desc': 'Review the access tokens currently managed by the system.',
      'profile.sidebar.logout_title': 'Sign Out',
      'profile.sidebar.logout_desc': 'Clear the current session and return to the sign-in / sign-up page.',
      'profile.loading': 'Loading your profile...',
      'profile.section.basic_title': 'Basic Information',
      'profile.section.basic_desc': 'After these fields are updated, the profile page and future user information responses will stay in sync.',
      'profile.section.password_title': 'Password',
      'profile.section.password_desc': 'To change your password, enter the current password first. The new password must contain at least 6 characters.',
      'profile.section.overview_title': 'Account Overview',
      'profile.section.overview_desc': 'These values come from the current signed-in session and refresh automatically after you save.',
      'profile.field.display_name': 'Display Name',
      'profile.field.username': 'Username',
      'profile.field.username_hint': 'This username is locked and cannot be changed.',
      'profile.field.email': 'Email',
      'profile.field.avatar': 'Avatar URL',
      'profile.field.avatar_hint': 'Leave this empty to use the system-generated avatar.',
      'profile.field.current_password': 'Current Password',
      'profile.field.new_password': 'New Password',
      'profile.field.confirm_new_password': 'Confirm New Password',
      'profile.field.user_id': 'User ID',
      'profile.field.email_verified': 'Email Status',
      'profile.field.created_at': 'Created At',
      'profile.field.updated_at': 'Updated At',
      'profile.button.edit_profile': 'Edit Profile',
      'profile.button.edit_email': 'Edit Email',
      'profile.button.edit_password': 'Change Password',
      'profile.button.save': 'Save Profile',
      'profile.button.update_password': 'Update Password',
      'profile.modal.profile_title': 'Edit Profile',
      'profile.modal.profile_desc': 'Update your display name and avatar URL here.',
      'profile.modal.email_title': 'Edit Email',
      'profile.modal.email_desc': 'Submitting this form updates the current account email immediately.',
      'profile.modal.password_title': 'Change Password',
      'profile.modal.password_desc': 'Enter your current password and choose a new sign-in password.',
      'profile.value.password_masked': 'Hidden',
      'profile.tip.password_optional': 'If you are not changing the password right now, leave the password fields empty.',
      'profile.status.password_empty': 'Enter the current password and the new password before submitting.',
      'profile.status.password_mismatch': 'The new password entries do not match.',
      'profile.status.saving': 'Saving...',
      'profile.status.updating_password': 'Updating...',
      'profile.status.basic_updated': 'Your profile information has been updated.',
      'profile.status.password_updated': 'Your password has been updated. Please use the new password next time you sign in.',
      'profile.meta.email_verified': 'Verified',
      'profile.meta.email_unverified': 'Not verified',
      'profile.meta.date_missing': 'Not recorded',

      'apps.page.title': 'VaultSSO | OAuth2 Applications',
      'apps.nav.applications': 'Applications',
      'apps.nav.tokens': 'Tokens',
      'apps.nav.docs': 'API Docs',
      'apps.hero.title': 'OAuth2 Application Management',
      'apps.hero.description': 'This page loads client configuration directly from the server API backed by the database. You can create, edit, delete, and search OAuth2 clients here.',
      'apps.stats.total': 'Total Clients',
      'apps.stats.active': 'Active Clients',
      'apps.stats.redirects': 'Redirect URIs',
      'apps.stats.scopes': 'Unique Scopes',
      'apps.search.placeholder': 'Search by name, id, redirect URI, or scope...',
      'apps.status.loading': 'Loading applications from /api/clients...',
      'apps.status.loaded': 'Loaded {count} client records from /api/clients.',
      'apps.status.filtered': 'Found {count} client records for “{keyword}”.',
      'apps.status.load_failed': 'Failed to load applications from the server API.',
      'apps.list.empty_title': 'No Applications Found',
      'apps.list.empty_desc': 'No OAuth client matches the current search criteria.',
      'apps.card.client_id': 'Client ID: {id}',
      'apps.card.no_redirect': 'No redirect URI configured',
      'apps.card.redirect_count': '{count} redirect URIs',
      'apps.card.redirect_count_one': '{count} redirect URI',
      'apps.card.no_scopes': 'No scopes configured',
      'apps.card.created': 'Created: {value}',
      'apps.card.updated': 'Updated: {value}',
      'apps.card.created_unknown': 'Created: Unknown',
      'apps.card.updated_unknown': 'Updated: Unknown',
      'apps.card.active': 'Active',
      'apps.card.inactive': 'Inactive',
      'apps.editor.title_create': 'Create Client',
      'apps.editor.title_edit': 'Edit Client',
      'apps.editor.desc': 'This form writes directly to the database-backed client API.',
      'apps.editor.field.id': 'Client ID',
      'apps.editor.field.name': 'Name',
      'apps.editor.field.secret': 'Client Secret',
      'apps.editor.field.logo': 'Logo URL',
      'apps.editor.field.redirects': 'Redirect URIs',
      'apps.editor.field.scopes': 'Scopes',
      'apps.editor.field.active': 'Active Status',
      'apps.editor.placeholder.id': 'For example: emlog-prod',
      'apps.editor.placeholder.name': 'For example: emlog',
      'apps.editor.placeholder.secret': 'Leave empty on create to auto-generate; leave empty on edit to keep the current secret',
      'apps.editor.help_secret': 'The system generates a high-entropy, URL-safe secret following common OAuth practice. Leave this empty on create to generate one automatically.',
      'apps.editor.placeholder.logo': 'https://example.com/logo.png',
      'apps.editor.placeholder.redirects': 'One redirect URI per line',
      'apps.editor.placeholder.scopes': 'Separate scopes with commas or new lines, for example: openid, profile, email',
      'apps.editor.active_yes': 'Active',
      'apps.editor.active_no': 'Inactive',
      'apps.editor.help_redirects': 'Enter at least one full URL. Format validation runs before save.',
      'apps.editor.help_scopes': 'It is usually safest to include at least openid, profile, and email.',
      'apps.editor.create_success': 'Application created.',
      'apps.editor.update_success': 'Application updated.',
      'apps.editor.secret_notice': 'Save this client secret now: {secret}',
      'apps.editor.delete_confirm': 'Delete client “{name}”? This also affects related authorization codes and token records.',
      'apps.editor.delete_success': 'Application deleted.',
      'apps.editor.saving_create': 'Creating...',
      'apps.editor.saving_update': 'Saving...',
      'apps.editor.deleting': 'Deleting...',
      'apps.guide.title': 'Quick Start',
      'apps.guide.step1.title': '1. Create Client Records',
      'apps.guide.step1.desc': 'Add or edit OAuth clients here and immediately reflect the saved database state.',
      'apps.guide.step2.title': '2. Check Redirect URIs',
      'apps.guide.step2.desc': 'Make sure the redirect URIs and scopes shown here match the application integration you expect.',
      'apps.guide.step3.title': '3. Run Real Authorization Tests',
      'apps.guide.step3.desc': 'After changing a client, verify the full sign-in flow with the authorization and token endpoints.',

      'success.page.title': 'VaultSSO | Success',
      'success.title.login': 'Sign-in Successful',
      'success.title.oauth': 'Authorization Successful',
      'success.message.login': '{user}, your identity has been verified and VaultSSO has created a signed-in session successfully.',
      'success.redirect.eyebrow': 'Redirect',
      'success.redirect.title': 'Returning to the application',
      'success.redirect.description': 'Authentication has finished. The system will return you to the app that requested the sign-in.',
      'success.redirect.client_label': 'Target App',
      'success.redirect.uri_label': 'Redirect URI',
      'success.redirect.code_label': 'Authorization Code',
      'success.redirect.state_label': 'State',
      'success.redirect.ready': 'Automatic redirect in {count} seconds',
      'success.redirect.manual': 'If the redirect does not happen automatically, you can click the button below to continue manually.',
      'success.no_redirect.eyebrow': 'Session Active',
      'success.no_redirect.title': 'Signed in successfully and no redirect target was detected',
      'success.no_redirect.description': 'This usually means that you signed in directly inside the system, or no callback URL was provided when the sign-in request was started. This page is the success result.',
      'success.sidebar.profile_title': 'Profile',
      'success.sidebar.profile_desc': 'View and edit your display name, username, email, avatar, and sign-in password.',
      'success.sidebar.apps_title': 'Apps',
      'success.sidebar.apps_desc': 'Review connected OAuth2 applications and their authorization relationship.',
      'success.sidebar.docs_title': 'API Docs',
      'success.sidebar.docs_desc': 'Continue exploring authorization codes, tokens, user information, and other endpoints.',
      'success.sidebar.logout_title': 'Sign Out',
      'success.sidebar.logout_desc': 'Clear the current session and return to the sign-in page.',
      'success.hint.default': 'If this was a regular sign-in without a client callback, the page will stay here and clearly show that the sign-in completed successfully.',
      'success.hint.redirect': 'This page is waiting after a successful authorization. It will automatically redirect to the callback configured by the client.',
      'success.hint.invalid_redirect': 'The redirect URI format is invalid, so automatic redirect cannot continue.',
      'success.redirect.description_client': '{client} has received the authorization result. The system will now return you to the application to finish the sign-in flow.',

      'auth.request.missing_pair': 'client_id and redirect_uri must be provided together',
      'auth.request.unknown_client': 'Unknown client: {client}',
      'auth.request.invalid_redirect_uri': 'Invalid redirect URI',
      'auth.invalid_credentials': 'Invalid credentials',
      'auth.required': 'You need to sign in first',
      'auth.login_success': 'Login successful',
      'validation.email.invalid': 'Please provide a valid email address',
      'validation.username.required': 'Please provide a username',
      'validation.password.min_length': 'Password must be at least 6 characters long',
      'validation.password.confirm_mismatch': 'Password confirmation does not match',
      'validation.email.taken': 'Email address is already registered',
      'validation.username.taken': 'Username is already in use',
      'profile.display_name.required': 'Display name cannot be empty',
      'profile.username.required': 'Username cannot be empty',
      'profile.username.read_only': 'Username cannot be changed',
      'profile.current_password.invalid': 'Current password is incorrect',
      'profile.password.min_length': 'New password must be at least 6 characters long',
      'profile.updated': 'Profile updated successfully',
      'oauth.code.invalid': 'Invalid authorization code',
      'oauth.code.expired': 'Authorization code expired',
      'oauth.client.id_mismatch': 'Client ID mismatch',
      'oauth.client.credentials.invalid': 'Invalid client credentials',
      'oauth.refresh_token.invalid': 'Invalid refresh token',
      'oauth.refresh_token.expired': 'Refresh token expired',
      'oauth.grant.unsupported': 'Unsupported grant type',
      'auth.header.invalid': 'Missing or invalid authorization header',
      'auth.token.invalid_or_expired': 'Invalid or expired token',
      'auth.user_not_found': 'User not found',
      'server.internal': 'Internal server error',
      'clients.validation.id': 'Client ID format is invalid',
      'clients.validation.id_taken': 'Client ID already exists',
      'clients.validation.name': 'Client name cannot be empty',
      'clients.validation.secret': 'Client secret cannot be empty',
      'clients.validation.redirects': 'At least one redirect URI is required',
      'clients.validation.scopes': 'At least one scope is required',
      'clients.validation.logo': 'Logo URL is invalid',
      'clients.created': 'Application created',
      'clients.updated': 'Application updated',
      'clients.deleted': 'Application deleted',
      'clients.not_found': 'Client not found'
    }
  };

  function normalizeLanguage(language) {
    return String(language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  function getInitialLanguage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return normalizeLanguage(stored);
      }
    } catch (error) {
      console.warn('Unable to read saved language preference:', error);
    }

    return normalizeLanguage(navigator.language || FALLBACK_LANG);
  }

  let currentLanguage = getInitialLanguage();

  function interpolate(template, variables) {
    return String(template).replace(/\{(\w+)\}/g, function (_, key) {
      return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : '';
    });
  }

  function t(key, variables = {}) {
    const table = translations[currentLanguage] || translations[FALLBACK_LANG];
    const fallbackTable = translations[FALLBACK_LANG];
    const template = table[key] || fallbackTable[key] || key;
    return interpolate(template, variables);
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(function (element) {
      element.textContent = t(element.dataset.i18n);
    });

    root.querySelectorAll('[data-i18n-placeholder]').forEach(function (element) {
      element.placeholder = t(element.dataset.i18nPlaceholder);
    });

    root.querySelectorAll('[data-i18n-title]').forEach(function (element) {
      element.title = t(element.dataset.i18nTitle);
    });
  }

  function updateLanguageButtons(root = document) {
    root.querySelectorAll('[data-language-switch]').forEach(function (button) {
      const targetLanguage = normalizeLanguage(button.dataset.languageSwitch);
      const active = targetLanguage === currentLanguage;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function setLanguage(language) {
    currentLanguage = normalizeLanguage(language);
    document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';

    try {
      localStorage.setItem(STORAGE_KEY, currentLanguage);
    } catch (error) {
      console.warn('Unable to save language preference:', error);
    }

    apply(document);
    updateLanguageButtons(document);
    document.dispatchEvent(new CustomEvent('vaultsso:languagechange', {
      detail: { language: currentLanguage }
    }));
  }

  function bindLanguageButtons(root = document) {
    root.querySelectorAll('[data-language-switch]').forEach(function (button) {
      if (!button.dataset.i18nBound) {
        button.addEventListener('click', function () {
          setLanguage(button.dataset.languageSwitch);
        });
        button.dataset.i18nBound = 'true';
      }
    });

    updateLanguageButtons(root);
  }

  function resolveMessage(payload, fallbackKey, variables = {}) {
    if (payload) {
      if (payload.error_key) {
        return t(payload.error_key, variables);
      }

      if (payload.message_key) {
        return t(payload.message_key, variables);
      }

      if (payload.error_description) {
        return payload.error_description;
      }

      if (payload.message) {
        return payload.message;
      }

      if (payload.error) {
        return payload.error;
      }
    }

    return fallbackKey ? t(fallbackKey, variables) : '';
  }

  window.VaultI18n = {
    apply,
    bindLanguageButtons,
    getLanguage: function () {
      return currentLanguage;
    },
    normalizeLanguage,
    resolveMessage,
    setLanguage,
    t
  };

  setLanguage(currentLanguage);
})();
