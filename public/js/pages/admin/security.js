const statusBar = document.getElementById('statusBar');
    const saveBtn = document.getElementById('saveBtn');
    const loginLogs = document.getElementById('loginLogs');
    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    const oidcStatus = document.getElementById('oidcStatus');
    const oidcSource = document.getElementById('oidcSource');
    const oidcCallback = document.getElementById('oidcCallback');
    const oidcProviders = document.getElementById('oidcProviders');
    const oidcForm = document.getElementById('oidcForm');
    const oidcCancelBtn = document.getElementById('oidcCancelBtn');
    const oidcFormTitle = document.getElementById('oidcFormTitle');
    const oidcResetBtn = document.getElementById('oidcResetBtn');
    let oidcEditingKey = '';

    const RESULT_LABELS = {
      success: ['成功', 'napi-badge-success'],
      invalid_credentials: ['密码错误', 'napi-badge-danger'],
      banned: ['已封禁', 'napi-badge-danger'],
      password_not_set: ['未设密码', 'napi-badge-warning'],
      locked: ['已锁定', 'napi-badge-danger'],
      captcha_failed: ['验证码错误', 'napi-badge-warning'],
      email_code_required: ['发送登录验证码', 'bg-blue-50 text-blue-700'],
      email_code_invalid: ['验证码错误', 'napi-badge-danger'],
      totp_required: ['等待动态码', 'bg-blue-50 text-blue-700'],
      totp_invalid: ['动态码错误', 'napi-badge-danger'],
      anomaly_detected: ['行为异常', 'bg-purple-50 text-purple-700'],
      register: ['注册', 'bg-blue-50 text-blue-700'],
      admin_action: ['管理员操作', 'bg-purple-50 text-purple-700']
    };

    const LOGIN_TYPE_LABELS = {
      password: '密码登录',
      huawei: '华为账号',
      oidc: '第三方账号',
      register: '注册',
      admin: '管理员'
    };

    function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
    function setStatus(kind, message) {
      statusBar.className = `admin-status admin-status-${kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'} mb-4`;
      statusBar.textContent = message;
    }
    async function request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
      const payload = response.status === 204 ? null : await response.json();
      if (response.status === 401) { window.location.href = '/oauth2/authorize'; throw new Error('登录已过期'); }
      if (response.status === 403) { window.location.href = '/oauth2/error?error=access_denied'; throw new Error('没有权限'); }
      if (!response.ok) throw new Error(payload?.error_description || '请求失败');
      return payload;
    }
    async function loadSettings() {
      try {
        const config = await request('/api/admin/security');
        document.getElementById('captchaLogin').checked = config.captchaLogin;
        document.getElementById('captchaRegister').checked = config.captchaRegister;
        document.getElementById('loginEmailCode').checked = config.loginEmailCode;
        document.getElementById('totpAllowed').checked = config.totpAllowed;
        document.getElementById('passwordRequireMixed').checked = config.passwordRequireMixed;
        document.getElementById('anomalyDetection').checked = config.anomalyDetection;
        document.getElementById('registrationEnabled').checked = config.registrationEnabled;
        document.getElementById('huaweiPhoneAutolink').checked = config.huaweiPhoneAutolink;
        document.getElementById('passwordMinLength').value = config.passwordMinLength;
        document.getElementById('loginMaxAttempts').value = config.loginMaxAttempts;
        document.getElementById('loginLockoutMinutes').value = config.loginLockoutMinutes;
        setStatus('info', '修改后点击“保存设置”立即生效。');
      } catch (error) { setStatus('error', error.message); }
    }
    async function loadTurnstile() {
      try {
        const config = await request('/api/admin/turnstile');
        document.getElementById('turnstileSiteKey').value = config.siteKey || '';
        document.getElementById('turnstileSecretKey').value = '';
        document.getElementById('clearTurnstile').checked = false;
        document.getElementById('turnstileSecretHint').textContent = config.hasSecretKey
          ? '私钥已保存。留空保持不变。' : '尚未设置私钥。';
      } catch (error) { setStatus('error', error.message); }
    }
    document.getElementById('saveTurnstileBtn').addEventListener('click', async () => {
      const button = document.getElementById('saveTurnstileBtn');
      button.disabled = true;
      try {
        const result = await request('/api/admin/turnstile', {
          method: 'PUT',
          body: JSON.stringify({
            siteKey: document.getElementById('turnstileSiteKey').value.trim(),
            secretKey: document.getElementById('turnstileSecretKey').value.trim(),
            clear: document.getElementById('clearTurnstile').checked
          })
        });
        await loadTurnstile();
        setStatus('success', result.message);
      } catch (error) { setStatus('error', error.message); }
      finally { button.disabled = false; }
    });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await request('/api/admin/security', {
          method: 'PUT',
          body: JSON.stringify({
            captchaLogin: document.getElementById('captchaLogin').checked,
            captchaRegister: document.getElementById('captchaRegister').checked,
            loginEmailCode: document.getElementById('loginEmailCode').checked,
            totpAllowed: document.getElementById('totpAllowed').checked,
            passwordRequireMixed: document.getElementById('passwordRequireMixed').checked,
            anomalyDetection: document.getElementById('anomalyDetection').checked,
            registrationEnabled: document.getElementById('registrationEnabled').checked,
            huaweiPhoneAutolink: document.getElementById('huaweiPhoneAutolink').checked,
            passwordMinLength: Number(document.getElementById('passwordMinLength').value),
            loginMaxAttempts: Number(document.getElementById('loginMaxAttempts').value),
            loginLockoutMinutes: Number(document.getElementById('loginLockoutMinutes').value)
          })
        });
        setStatus('success', '安全设置已保存，立即生效。');
      } catch (error) { setStatus('error', error.message); }
      finally { saveBtn.disabled = false; }
    });
    async function loadLogs() {
      loginLogs.innerHTML = '<p class="admin-cell-sub">正在加载...</p>';
      try {
        const logs = await request('/api/admin/security/logs?limit=50');
        if (!logs.length) { loginLogs.innerHTML = '<p class="admin-cell-sub">暂无登录记录。</p>'; return; }
        loginLogs.innerHTML = logs.map(log => {
          const [label, className] = RESULT_LABELS[log.result] || [log.result, ''];
          const time = new Date(log.createdAt);
          const timeText = Number.isNaN(time.getTime()) ? '-' : time.toLocaleString('zh-CN');
          // 合规字段：平台（发起方应用）、类型、IP、源端口。
          const platform = log.platform || '未知平台';
          const typeLabel = LOGIN_TYPE_LABELS[log.loginType] || log.loginType || '未知类型';
          const port = log.sourcePort ? `:${log.sourcePort}` : '';
          return `<div class="admin-log-item">
            <div class="flex items-center justify-between gap-2">
              <span class="admin-cell-strong truncate" title="${escapeHtml(log.username)}">${escapeHtml(log.username)}</span>
              <span class="napi-badge shrink-0 ${className}">${label}</span>
            </div>
            ${log.detail ? `<p class="admin-cell-sub mt-1">${escapeHtml(log.detail)}</p>` : ''}
            <div class="admin-log-meta">
              <span class="truncate">${escapeHtml(platform)} · ${escapeHtml(typeLabel)}</span>
              <span class="truncate font-mono">${escapeHtml((log.ip || '未知 IP') + port)}</span>
              <span class="shrink-0">${timeText}</span>
            </div>
          </div>`;
        }).join('');
      } catch (error) { loginLogs.innerHTML = `<p class="text-sm text-red-600">${escapeHtml(error.message)}</p>`; }
    }
    async function loadOidcSettings() {
      try {
        const config = await request('/api/admin/oidc');
        const providers = Array.isArray(config.providers) ? config.providers : [];
        const readyCount = providers.filter(provider => provider.configured).length;
        oidcSource.textContent = `配置来源：${config.source || '-'}`;
        oidcCallback.textContent = config.callbackUrl || '-';
        oidcStatus.textContent = readyCount
          ? `已配置 ${readyCount} 个可用登录 Provider`
          : '尚未配置可用的第三方登录 Provider';
        oidcStatus.parentElement.className = `admin-note mb-4 ${readyCount ? 'admin-note-success' : 'admin-note-warning'}`;
        if (!providers.length) {
          oidcProviders.innerHTML = '<p class="admin-cell-sub">暂无 Provider 配置。</p>';
          return;
        }
        oidcProviders.innerHTML = providers.map(provider => {
          const isHuawei = provider.providerType === 'huawei_quicklogin';
          const isTianyi = ['tianyi_web', 'tianyi_h5'].includes(provider.providerType);
          const providerLabel = isTianyi ? `天翼账号授权（${provider.providerType === 'tianyi_h5' ? 'H5' : 'WEB'}）` : isHuawei ? '华为一键登录' : 'OIDC';
          const state = provider.credentialError ? ['密钥需重新填写', 'napi-badge-warning'] : provider.enabled === false ? ['已停用', 'napi-badge'] : provider.configured ? ['已启用', 'napi-badge-success'] : ['未完成配置', 'bg-amber-50 text-amber-700'];
          const endpoint = provider.issuerUrl || provider.authorizeUrl || provider.tokenUrl || (isHuawei ? '华为官方默认地址' : '-');
          const rows = isTianyi
            ? `<span>App ID：<b class="font-semibold text-ink">${escapeHtml(provider.clientId || '-')}</b></span>
              <span>App Secret：<b class="font-semibold text-ink">${provider.clientSecretConfigured ? '已配置' : '未配置'}</b></span>
              <span class="sm:col-span-2">授权接口：<b class="font-semibold text-ink">天翼官方 ${provider.providerType === 'tianyi_h5' ? 'H5' : 'WEB'} 接口</b></span>
              <span class="sm:col-span-2">系统登录入口：<b class="break-all font-semibold text-ink">/api/v1/auth/oauth/oidc/login?provider=${escapeHtml(provider.key)}</b></span>
              <span class="sm:col-span-2">回调地址：<b class="break-all font-semibold text-ink">${escapeHtml(config.callbackUrl || '-')}</b></span>
              <span class="sm:col-span-2">账号标识：<b class="font-semibold text-ink">应用内 openId（不授予手机号或邮箱验证状态）</b></span>`
            : isHuawei
            ? `<span>Client ID：<b class="font-semibold text-ink">${escapeHtml(provider.clientId || '-')}</b></span>
              <span>Client Secret：<b class="font-semibold text-ink">${provider.clientSecretConfigured ? '已配置' : '未配置'}</b></span>
              <span class="sm:col-span-2">华为主体分组：<b class="break-all font-semibold text-ink">${escapeHtml(provider.huaweiUnionScope || '独立（未设置）')}</b></span>
              <span class="sm:col-span-2">手机号 / UnionID 换取地址：<b class="break-all font-semibold text-ink">${escapeHtml(provider.tokenUrl || '华为官方默认地址')}</b></span>
              <span class="sm:col-span-2">App 调用地址：<b class="break-all font-semibold text-ink">/api/v1/auth/oauth/huawei/quick-login</b></span>`
            : `<span>Client ID：<b class="font-semibold text-ink">${escapeHtml(provider.clientId || '-')}</b></span>
              <span>Client Secret：<b class="font-semibold text-ink">${provider.clientSecretConfigured ? '已配置' : '未配置'}</b></span>
              <span>授权地址：<b class="break-all font-semibold text-ink">${escapeHtml(endpoint)}</b></span>
              <span>Scope：<b class="font-semibold text-ink">${escapeHtml((provider.scopes || []).join(' ') || '-')}</b></span>
              <span>主标识字段：<b class="font-semibold text-ink">${escapeHtml(provider.userinfoIdPath || 'sub')}</b></span>
              <span>第二标识字段：<b class="admin-cell-strong">${escapeHtml(provider.userinfoSecondaryIdPath || '-')}</b></span>
              <span>UserInfo 请求：<b class="admin-cell-strong">${escapeHtml(provider.userinfoMethod || 'GET')} / ${provider.userinfoTokenIn === 'body_form' ? '请求体' : 'Bearer 头'}</b></span>
              <span>PKCE：<b class="admin-cell-strong">${provider.pkceEnabled ? '开启' : '关闭'}</b></span>
              <span>ID Token 验证：<b class="admin-cell-strong">${provider.validateIdToken ? '开启' : '关闭'}</b></span>`;
          return `<div class="admin-provider-item">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div><span class="admin-cell-strong">${escapeHtml(provider.providerName || provider.key)}</span><span class="admin-cell-sub ml-2">${escapeHtml(provider.key || '')}</span><span class="napi-badge ml-2">${providerLabel}</span></div>
              <div class="flex items-center gap-2"><span class="napi-badge ${state[1]}">${state[0]}</span><button class="oidc-edit napi-btn napi-btn-ghost napi-btn-sm" data-provider="${escapeHtml(provider.key)}" type="button">编辑</button><button class="oidc-delete napi-btn napi-btn-danger napi-btn-sm" data-provider="${escapeHtml(provider.key)}" type="button">删除</button></div>
            </div>
            <div class="admin-provider-meta grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
              ${rows}
            </div>
          </div>`;
        }).join('');
        oidcProviders.querySelectorAll('.oidc-edit').forEach(button => button.addEventListener('click', () => editOidcProvider(providers.find(provider => provider.key === button.dataset.provider))));
        oidcProviders.querySelectorAll('.oidc-delete').forEach(button => button.addEventListener('click', () => deleteOidcProvider(button.dataset.provider)));
      } catch (error) {
        oidcStatus.textContent = error.message;
        oidcStatus.parentElement.className = 'admin-note admin-note-error mb-4';
        oidcProviders.innerHTML = `<p class="text-sm text-red-600">${escapeHtml(error.message)}</p>`;
      }
    }
    function updateOidcProviderFields() {
      const type = document.getElementById('oidcProviderType').value;
      const isTianyi = ['tianyi_web', 'tianyi_h5'].includes(type);
      const genericFields = ['oidcHuaweiUnionScope', 'oidcIssuer', 'oidcDiscovery', 'oidcAuthorize', 'oidcToken', 'oidcUserinfo', 'oidcJwks', 'oidcScopes', 'oidcTokenAuth', 'oidcIdPath', 'oidcSecondaryIdPath', 'oidcEmailPath', 'oidcUsernamePath', 'oidcUserinfoMethod', 'oidcUserinfoTokenIn', 'oidcPkce', 'oidcValidate', 'oidcEmailVerified'];
      genericFields.forEach(id => {
        const field = document.getElementById(id);
        field.disabled = isTianyi;
        field.closest('label').hidden = isTianyi;
      });
      document.getElementById('oidcGenericHint').hidden = isTianyi;
      document.getElementById('oidcClientIdLabel').textContent = isTianyi ? 'App ID' : 'Client ID';
      document.getElementById('oidcClientSecretLabel').textContent = isTianyi ? 'App Secret' : 'Client Secret';
      document.getElementById('oidcProviderTypeHint').textContent = isTianyi
        ? '使用已开通的天翼应用 App ID / App Secret，并在天翼后台登记上方回调地址。系统使用固定官方接口；账号以应用内 openId 区分，不授予手机号或邮箱验证状态。'
        : type === 'huawei_quicklogin'
          ? '华为一键登录通过 POST + JSON 授权码换取 UnionID / OpenID / 手机号。Token 地址留空时使用华为官方接口；Client ID 必须与 App 的 AGC 配置一致。'
          : '填写平台提供的 OIDC / OAuth2 配置与上方回调地址。';
    }
    function resetOidcForm() {
      oidcEditingKey = '';
      oidcForm.reset();
      document.getElementById('oidcEnabled').checked = true;
      document.getElementById('oidcPkce').checked = true;
      document.getElementById('oidcValidate').checked = true;
      document.getElementById('oidcIdPath').value = 'sub';
      document.getElementById('oidcSecondaryIdPath').value = '';
      document.getElementById('oidcEmailPath').value = 'email';
      document.getElementById('oidcUsernamePath').value = 'preferred_username';
      document.getElementById('oidcProviderType').value = 'oidc';
      document.getElementById('oidcUserinfoMethod').value = 'GET';
      document.getElementById('oidcUserinfoTokenIn').value = 'header';
      oidcFormTitle.textContent = '新增 Provider';
      oidcCancelBtn.hidden = true;
      document.getElementById('oidcKey').disabled = false;
      updateOidcProviderFields();
    }
    function editOidcProvider(provider) {
      if (!provider) return;
      oidcEditingKey = provider.key;
      const values = { oidcKey: provider.key, oidcName: provider.providerName, oidcClientId: provider.clientId, oidcIssuer: provider.issuerUrl, oidcDiscovery: provider.discoveryUrl, oidcAuthorize: provider.authorizeUrl, oidcToken: provider.tokenUrl, oidcUserinfo: provider.userinfoUrl, oidcJwks: provider.jwksUrl, oidcScopes: (provider.scopes || []).join(' '), oidcIdPath: provider.userinfoIdPath, oidcSecondaryIdPath: provider.userinfoSecondaryIdPath, oidcEmailPath: provider.userinfoEmailPath, oidcUsernamePath: provider.userinfoUsernamePath };
      Object.entries(values).forEach(([id, value]) => { document.getElementById(id).value = value || ''; });
      document.getElementById('oidcTokenAuth').value = provider.tokenAuthMethod || 'client_secret_basic';
      document.getElementById('oidcProviderType').value = provider.providerType || 'oidc';
      document.getElementById('oidcHuaweiUnionScope').value = provider.huaweiUnionScope || '';
      document.getElementById('oidcUserinfoMethod').value = provider.userinfoMethod || 'GET';
      document.getElementById('oidcUserinfoTokenIn').value = provider.userinfoTokenIn || 'header';
      document.getElementById('oidcEnabled').checked = provider.enabled;
      document.getElementById('oidcPkce').checked = provider.pkceEnabled;
      document.getElementById('oidcValidate').checked = provider.validateIdToken;
      document.getElementById('oidcEmailVerified').checked = provider.requireEmailVerified;
      oidcFormTitle.textContent = `编辑 Provider：${provider.providerName}`;
      oidcCancelBtn.hidden = false;
      document.getElementById('oidcKey').disabled = true;
      document.getElementById('oidcClientSecret').value = '';
      updateOidcProviderFields();
      oidcForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    async function deleteOidcProvider(providerKey) {
      if (!window.confirm(`确定删除 Provider「${providerKey}」吗？`)) return;
      try { await request(`/api/admin/oidc/${encodeURIComponent(providerKey)}`, { method: 'DELETE' }); setStatus('success', 'Provider 已删除。'); resetOidcForm(); await loadOidcSettings(); } catch (error) { setStatus('error', error.message); }
    }
    oidcForm.addEventListener('submit', async event => {
      event.preventDefault();
      const huaweiUnionScope = document.getElementById('oidcHuaweiUnionScope').value.trim();
      const payload = { providerKey: document.getElementById('oidcKey').value, providerName: document.getElementById('oidcName').value, providerType: document.getElementById('oidcProviderType').value, clientId: document.getElementById('oidcClientId').value, clientSecret: document.getElementById('oidcClientSecret').value, issuerUrl: document.getElementById('oidcIssuer').value, discoveryUrl: document.getElementById('oidcDiscovery').value, authorizeUrl: document.getElementById('oidcAuthorize').value, tokenUrl: document.getElementById('oidcToken').value, userinfoUrl: document.getElementById('oidcUserinfo').value, jwksUrl: document.getElementById('oidcJwks').value, scopes: document.getElementById('oidcScopes').value, tokenAuthMethod: document.getElementById('oidcTokenAuth').value, userinfoIdPath: document.getElementById('oidcIdPath').value, userinfoSecondaryIdPath: document.getElementById('oidcSecondaryIdPath').value, userinfoEmailPath: document.getElementById('oidcEmailPath').value, userinfoUsernamePath: document.getElementById('oidcUsernamePath').value, userinfoMethod: document.getElementById('oidcUserinfoMethod').value, userinfoTokenIn: document.getElementById('oidcUserinfoTokenIn').value, enabled: document.getElementById('oidcEnabled').checked, pkceEnabled: document.getElementById('oidcPkce').checked, validateIdToken: document.getElementById('oidcValidate').checked, requireEmailVerified: document.getElementById('oidcEmailVerified').checked };
      payload.huaweiUnionScope = huaweiUnionScope;
      if (['tianyi_web', 'tianyi_h5'].includes(payload.providerType)) {
        ['huaweiUnionScope', 'issuerUrl', 'discoveryUrl', 'authorizeUrl', 'tokenUrl', 'userinfoUrl', 'jwksUrl', 'scopes', 'tokenAuthMethod', 'userinfoIdPath', 'userinfoSecondaryIdPath', 'userinfoEmailPath', 'userinfoUsernamePath', 'userinfoMethod', 'userinfoTokenIn', 'pkceEnabled', 'validateIdToken', 'requireEmailVerified'].forEach(key => { delete payload[key]; });
      }
      try { await request('/api/admin/oidc', { method: 'POST', body: JSON.stringify(payload) }); setStatus('success', 'Provider 已保存，立即生效。'); resetOidcForm(); await loadOidcSettings(); } catch (error) { setStatus('error', error.message); }
    });
    oidcResetBtn.addEventListener('click', resetOidcForm);
    oidcCancelBtn.addEventListener('click', resetOidcForm);
    document.getElementById('oidcProviderType').addEventListener('change', updateOidcProviderFields);
    updateOidcProviderFields();
    refreshLogsBtn.addEventListener('click', loadLogs);
    async function loadPhoneAuth() {
      try {
        const config = await request('/api/admin/phone-auth');
        document.getElementById('phoneAuthH5Enabled').checked = Boolean(config.h5Enabled);
        document.getElementById('phoneAuthAppEnabled').checked = Boolean(config.appEnabled);
        document.getElementById('phoneAuthSmsEnabled').checked = Boolean(config.smsEnabled);
        document.getElementById('phoneAuthAllowRegistration').checked = Boolean(config.allowRegistration);
        document.getElementById('phoneAuthAccessKeyId').value = config.accessKeyId || '';
        document.getElementById('phoneAuthAccessKeySecret').value = '';
        document.getElementById('phoneAuthSecurityToken').value = '';
        document.getElementById('phoneAuthClearSecret').checked = false;
        document.getElementById('phoneAuthClearToken').checked = false;
        document.getElementById('phoneAuthSceneCode').value = config.sceneCode || '';
        document.getElementById('phoneAuthH5Origin').value = config.h5Origin || '';
        document.getElementById('phoneAuthH5Url').value = config.h5Url || '';
        document.getElementById('phoneAuthH5SdkUrl').value = config.h5SdkUrl || '';
        document.getElementById('phoneAuthSmsSchemeName').value = config.smsSchemeName || '';
        document.getElementById('phoneAuthSmsSignName').value = config.smsSignName || '';
        document.getElementById('phoneAuthSmsTemplateCode').value = config.smsTemplateCode || '';
        document.getElementById('phoneAuthSmsTemplateParam').value = config.smsTemplateParam && typeof config.smsTemplateParam === 'object'
          ? JSON.stringify(config.smsTemplateParam)
          : (config.smsTemplateParam || '');
        document.getElementById('phoneAuthSecretHint').textContent = config.hasAccessKeySecret ? '密钥已保存。留空保持不变。' : '尚未设置 AccessKey Secret。';
        document.getElementById('phoneAuthTokenHint').textContent = config.hasSecurityToken ? '已保存临时凭证。留空保持不变。' : '未使用临时凭证。';
        // adminConfig 返回的是 ready:{h5,app,sms} 布尔对象，不是缺失项数组。
        const ready = config.ready && typeof config.ready === 'object' ? config.ready : {};
        const enabledChannels = [];
        const missingChannels = [];
        [['h5', 'H5 一键登录'], ['app', 'App 一键登录'], ['sms', '短信验证码']].forEach(function ([key, label]) {
          const isEnabled = Boolean(config[`${key}Enabled`]);
          if (!isEnabled) return;
          enabledChannels.push(label);
          if (!ready[key]) missingChannels.push(label);
        });
        const badge = document.getElementById('phoneAuthReadiness');
        const statusNode = document.getElementById('phoneAuthStatus');
        const statusBox = statusNode.parentElement;
        if (!enabledChannels.length) {
          badge.textContent = '未启用';
          badge.className = 'napi-badge';
          statusNode.textContent = '所有手机号认证通道均已关闭，服务端不会发起任何上游请求。';
          statusBox.className = 'admin-note mb-4';
        } else if (missingChannels.length) {
          badge.textContent = '配置不完整';
          badge.className = 'napi-badge napi-badge-warning';
          statusNode.textContent = `以下已启用的通道缺少必填配置：${missingChannels.join('、')}。在补齐前这些通道不会发起上游请求。`;
          statusBox.className = 'admin-note admin-note-warning mb-4';
        } else {
          badge.textContent = '配置完整';
          badge.className = 'napi-badge napi-badge-success';
          statusNode.textContent = `已启用并配置完整：${enabledChannels.join('、')}。`;
          statusBox.className = 'admin-note admin-note-success mb-4';
        }
      } catch (error) { setStatus('error', error.message); }
    }
    document.getElementById('savePhoneAuthBtn').addEventListener('click', async () => {
      const button = document.getElementById('savePhoneAuthBtn');
      button.disabled = true;
      try {
        const result = await request('/api/admin/phone-auth', {
          method: 'PUT',
          body: JSON.stringify({
            h5Enabled: document.getElementById('phoneAuthH5Enabled').checked,
            appEnabled: document.getElementById('phoneAuthAppEnabled').checked,
            smsEnabled: document.getElementById('phoneAuthSmsEnabled').checked,
            allowRegistration: document.getElementById('phoneAuthAllowRegistration').checked,
            accessKeyId: document.getElementById('phoneAuthAccessKeyId').value.trim(),
            accessKeySecret: document.getElementById('phoneAuthAccessKeySecret').value.trim(),
            securityToken: document.getElementById('phoneAuthSecurityToken').value.trim(),
            clearAccessKeySecret: document.getElementById('phoneAuthClearSecret').checked,
            clearSecurityToken: document.getElementById('phoneAuthClearToken').checked,
            sceneCode: document.getElementById('phoneAuthSceneCode').value.trim(),
            h5Origin: document.getElementById('phoneAuthH5Origin').value.trim(),
            h5Url: document.getElementById('phoneAuthH5Url').value.trim(),
            h5SdkUrl: document.getElementById('phoneAuthH5SdkUrl').value.trim(),
            smsSchemeName: document.getElementById('phoneAuthSmsSchemeName').value.trim(),
            smsSignName: document.getElementById('phoneAuthSmsSignName').value.trim(),
            smsTemplateCode: document.getElementById('phoneAuthSmsTemplateCode').value.trim(),
            smsTemplateParam: document.getElementById('phoneAuthSmsTemplateParam').value.trim()
          })
        });
        await loadPhoneAuth();
        setStatus('success', result.message || '手机号认证配置已保存。');
      } catch (error) { setStatus('error', error.message); }
      finally { button.disabled = false; }
    });
    loadSettings();
    loadTurnstile();
    loadLogs();
    loadOidcSettings();
    loadPhoneAuth();
