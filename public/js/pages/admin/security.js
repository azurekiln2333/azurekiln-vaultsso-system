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
      success: ['成功', 'bg-green-50 text-green-700'],
      invalid_credentials: ['密码错误', 'bg-red-50 text-red-600'],
      banned: ['已封禁', 'bg-red-50 text-red-600'],
      password_not_set: ['未设密码', 'bg-amber-50 text-amber-700'],
      locked: ['已锁定', 'bg-red-50 text-red-600'],
      captcha_failed: ['验证码错误', 'bg-amber-50 text-amber-700'],
      email_code_required: ['发送登录验证码', 'bg-blue-50 text-blue-700'],
      email_code_invalid: ['验证码错误', 'bg-red-50 text-red-600'],
      totp_required: ['等待动态码', 'bg-blue-50 text-blue-700'],
      totp_invalid: ['动态码错误', 'bg-red-50 text-red-600'],
      anomaly_detected: ['行为异常', 'bg-purple-50 text-purple-700'],
      register: ['注册', 'bg-blue-50 text-blue-700'],
      admin_action: ['管理员操作', 'bg-purple-50 text-purple-700']
    };

    function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
    function setStatus(kind, message) {
      statusBar.className = `mb-6 rounded-lg border px-4 py-3 text-sm ${kind === 'error' ? 'border-red-200 bg-red-50 text-red-700' : kind === 'success' ? 'border-green-200 bg-green-50 text-green-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`;
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
      loginLogs.innerHTML = '<p class="text-sm text-muted">正在加载...</p>';
      try {
        const logs = await request('/api/admin/security/logs?limit=50');
        if (!logs.length) { loginLogs.innerHTML = '<p class="text-sm text-muted">暂无登录记录。</p>'; return; }
        loginLogs.innerHTML = logs.map(log => {
          const [label, className] = RESULT_LABELS[log.result] || [log.result, 'bg-surface-container-low text-muted'];
          const time = new Date(log.createdAt);
          const timeText = Number.isNaN(time.getTime()) ? '-' : time.toLocaleString('zh-CN');
          return `<div class="rounded-lg border border-line/70 px-3 py-2">
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-sm font-bold text-ink" title="${escapeHtml(log.username)}">${escapeHtml(log.username)}</span>
              <span class="shrink-0 rounded-lg px-2 py-0.5 text-[11px] font-bold ${className}">${label}</span>
            </div>
            ${log.detail ? `<p class="mt-1 break-all text-[11px] text-muted">${escapeHtml(log.detail)}</p>` : ''}
            <div class="mt-1 flex items-center justify-between gap-2 text-xs text-muted">
              <span class="truncate">${escapeHtml(log.ip || '未知 IP')}</span>
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
        oidcStatus.parentElement.className = `mb-4 rounded-lg border px-4 py-3 text-sm ${readyCount ? 'border-green-200 bg-green-50 text-green-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`;
        if (!providers.length) {
          oidcProviders.innerHTML = '<p class="text-sm text-muted">暂无 Provider 配置。</p>';
          return;
        }
        oidcProviders.innerHTML = providers.map(provider => {
          const isHuawei = provider.providerType === 'huawei_quicklogin';
          const state = provider.credentialError ? ['密钥需重新填写', 'bg-amber-50 text-amber-700'] : provider.configured ? ['已启用', 'bg-green-50 text-green-700'] : ['未完成配置', 'bg-amber-50 text-amber-700'];
          const endpoint = provider.issuerUrl || provider.authorizeUrl || provider.tokenUrl || (isHuawei ? '华为官方默认地址' : '-');
          const rows = isHuawei
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
              <span>第二标识字段：<b class="font-semibold text-ink">${escapeHtml(provider.userinfoSecondaryIdPath || '-')}</b></span>
              <span>UserInfo 请求：<b class="font-semibold text-ink">${escapeHtml(provider.userinfoMethod || 'GET')} / ${provider.userinfoTokenIn === 'body_form' ? '请求体' : 'Bearer 头'}</b></span>
              <span>PKCE：<b class="font-semibold text-ink">${provider.pkceEnabled ? '开启' : '关闭'}</b></span>
              <span>ID Token 验证：<b class="font-semibold text-ink">${provider.validateIdToken ? '开启' : '关闭'}</b></span>`;
          return `<div class="rounded-lg border border-line/70 px-4 py-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div><span class="font-bold text-ink">${escapeHtml(provider.providerName || provider.key)}</span><span class="ml-2 text-xs text-muted">${escapeHtml(provider.key || '')}</span><span class="ml-2 rounded bg-surface-container-low px-2 py-0.5 text-[11px] font-bold text-muted">${isHuawei ? '华为一键登录' : 'OIDC'}</span></div>
              <div class="flex items-center gap-2"><span class="rounded-lg px-2 py-1 text-xs font-bold ${state[1]}">${state[0]}</span><button class="oidc-edit rounded-lg border border-line px-2 py-1 text-xs font-bold text-muted" data-provider="${escapeHtml(provider.key)}" type="button">编辑</button><button class="oidc-delete rounded-lg border border-red-200 px-2 py-1 text-xs font-bold text-red-600" data-provider="${escapeHtml(provider.key)}" type="button">删除</button></div>
            </div>
            <div class="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-xs text-muted sm:grid-cols-2">
              ${rows}
            </div>
          </div>`;
        }).join('');
        oidcProviders.querySelectorAll('.oidc-edit').forEach(button => button.addEventListener('click', () => editOidcProvider(providers.find(provider => provider.key === button.dataset.provider))));
        oidcProviders.querySelectorAll('.oidc-delete').forEach(button => button.addEventListener('click', () => deleteOidcProvider(button.dataset.provider)));
      } catch (error) {
        oidcStatus.textContent = error.message;
        oidcStatus.parentElement.className = 'mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700';
        oidcProviders.innerHTML = `<p class="text-sm text-red-600">${escapeHtml(error.message)}</p>`;
      }
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
      try { await request('/api/admin/oidc', { method: 'POST', body: JSON.stringify(payload) }); setStatus('success', 'Provider 已保存，立即生效。'); resetOidcForm(); await loadOidcSettings(); } catch (error) { setStatus('error', error.message); }
    });
    oidcResetBtn.addEventListener('click', resetOidcForm);
    oidcCancelBtn.addEventListener('click', resetOidcForm);
    refreshLogsBtn.addEventListener('click', loadLogs);
    loadSettings();
    loadTurnstile();
    loadLogs();
    loadOidcSettings();
