const statusBar = document.getElementById('statusBar');
    const saveBtn = document.getElementById('saveBtn');
    const testBtn = document.getElementById('testBtn');
    const passwordInput = document.getElementById('passwordInput');

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
          : 'SMTP 尚未完整配置（主机 / 用户名 / 密码），未配置时验证码只打印在服务端控制台。');
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
