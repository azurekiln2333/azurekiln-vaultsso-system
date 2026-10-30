const statusBar = document.getElementById('statusBar');
    const saveBtn = document.getElementById('saveBtn');
    const testBtn = document.getElementById('testBtn');
    const passwordInput = document.getElementById('passwordInput');

    function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
    function setStatus(kind, message) {
      statusBar.className = `admin-status admin-status-${kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'} mb-4`;
      statusBar.textContent = message;
    }
    async function request(url, options = {}) {
      let response;
      try {
        response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
      } catch (error) {
        throw new Error(error.name === 'AbortError' || error.name === 'TimeoutError'
          ? '请求超时，请稍后重试。'
          : '网络请求失败，无法连接服务器，请检查网络后重试。');
      }

      const httpStatus = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
      const redirectedToLogin = response.redirected && new URL(response.url).origin === window.location.origin
        && new URL(response.url).pathname === '/oauth2/authorize';
      if (response.status === 401 || redirectedToLogin) {
        window.location.href = '/oauth2/authorize';
        throw new Error(`登录已过期，请重新登录（${httpStatus}）。`);
      }
      if (response.status === 403) {
        window.location.href = '/oauth2/error?error=access_denied';
        throw new Error(`没有权限访问发件设置（${httpStatus}）。`);
      }
      if (response.status === 204) return null;

      let text;
      try {
        text = await response.text();
      } catch (error) {
        throw new Error(`读取服务器响应失败（${httpStatus}），连接可能已中断，请稍后重试。`);
      }
      const contentType = response.headers.get('content-type') || '';
      const isHtml = /html/i.test(contentType) || /^\s*</.test(text);
      let payload = null;
      if (!isHtml && text.trim()) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
        } catch (error) {
          // Proxies may return an HTML/text error page instead of the application's JSON.
        }
      }
      if (!response.ok) {
        const descriptions = {
          404: '请求的接口不存在，请检查服务部署和请求地址。',
          408: '请求超时，请稍后重试。',
          429: '请求过于频繁，请稍后重试。',
          502: '网关请求失败，请检查应用服务或反向代理。',
          503: '服务暂时不可用，请稍后重试。',
          504: '网关等待服务器响应超时，请检查服务连接后重试。'
        };
        const description = [payload?.error_description, payload?.message]
          .find(value => typeof value === 'string' && value.trim());
        const plainText = !payload && !isHtml && !/json/i.test(contentType) && !/^\s*[\[{]/.test(text)
          ? text.trim().replace(/\s+/g, ' ').slice(0, 500) : '';
        const fallback = descriptions[response.status] || (response.status >= 500
          ? '服务器处理请求失败，请稍后重试。' : '请求未能完成，请检查输入后重试。');
        throw new Error(`请求失败（${httpStatus}）：${description?.trim() || plainText || fallback}`);
      }
      if (!payload) throw new Error(`服务器响应异常（${httpStatus}），请刷新页面或检查服务状态。`);
      return payload;
    }
    function renderState(settings) {
      const items = {
        stateHost: settings.host ? `主机：${settings.host}:${settings.port}` : '未配置 SMTP 主机',
        stateUser: settings.user ? `用户名：${settings.user}` : '未配置用户名',
        statePassword: settings.hasPassword ? '密码：已保存（不回显）' : '密码：未设置'
      };
      Object.entries(items).forEach(([id, text]) => { document.getElementById(id).textContent = text; });
      document.getElementById('passwordHint').textContent = settings.hasPassword ? '已保存密码。填写新值将覆盖，留空保持不变。' : '尚未设置密码，填写后才会真正通过 SMTP 发信。';
    }
    async function loadSettings() {
      try {
        const settings = await request('/api/admin/smtp');
        document.getElementById('hostInput').value = settings.host || '';
        document.getElementById('portInput').value = settings.port || '';
        document.getElementById('userInput').value = settings.user || '';
        document.getElementById('fromInput').value = settings.from || '';
        passwordInput.value = '';
        document.getElementById('clearPassword').checked = false;
        renderState(settings);
        setStatus('info', settings.host && settings.user && settings.hasPassword
          ? 'SMTP 已配置。修改后点保存立即生效。'
          : 'SMTP 尚未完整配置（主机 / 用户名 / 密码），验证码邮件无法发送，请填写并保存完整配置。');
      } catch (error) { setStatus('error', error.message); }
    }
    document.getElementById('smtpForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      saveBtn.disabled = true;
      try {
        const body = {
          host: document.getElementById('hostInput').value.trim(),
          port: Number(document.getElementById('portInput').value || 0),
          user: document.getElementById('userInput').value.trim(),
          from: document.getElementById('fromInput').value.trim()
        };
        if (passwordInput.value) body.password = passwordInput.value;
        body.clearPassword = document.getElementById('clearPassword').checked;
        const result = await request('/api/admin/smtp', { method: 'PUT', body: JSON.stringify(body) });
        passwordInput.value = '';
        document.getElementById('clearPassword').checked = false;
        renderState(result);
        setStatus('success', result.message || '发件设置已保存。');
      } catch (error) { setStatus('error', error.message); }
      finally { saveBtn.disabled = false; }
    });
    testBtn.addEventListener('click', async () => {
      const to = document.getElementById('testToInput').value.trim();
      if (!to) { setStatus('error', '请先填写测试收件邮箱。'); return; }
      testBtn.disabled = true;
      setStatus('info', '正在发送测试邮件...');
      try {
        const result = await request('/api/admin/smtp/test', { method: 'POST', body: JSON.stringify({ to }) });
        setStatus('success', result.message || '测试邮件已发送。');
      } catch (error) { setStatus('error', error.message); }
      finally { testBtn.disabled = false; }
    });
    loadSettings();
