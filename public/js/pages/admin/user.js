const statusBar = document.getElementById('statusBar');
    const editForm = document.getElementById('userEditForm');
    const saveBtn = document.getElementById('saveBtn');
    let currentUserId = '';

    function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
    function dateText(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN'); }
    function setStatus(kind, message) {
      statusBar.className = `mb-6 rounded-lg border px-4 py-3 text-sm ${kind === 'error' ? 'border-red-200 bg-red-50 text-red-700' : kind === 'success' ? 'border-green-200 bg-green-50 text-green-700' : 'border-blue-200 bg-blue-50 text-blue-700'}`;
      statusBar.textContent = message;
    }
    function buildAvatarDataUri(name) {
      const initial = (name || 'U').trim().charAt(0).toUpperCase() || 'U';
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><rect width="80" height="80" rx="16" fill="#0b57d0"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-size="32" font-family="Segoe UI, Arial, sans-serif" font-weight="700">${escapeHtml(initial)}</text></svg>`;
      return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }
    function setAvatar(url, name) {
      const avatar = document.getElementById('detailAvatar');
      avatar.onerror = function () { avatar.src = buildAvatarDataUri(name); };
      avatar.src = url || buildAvatarDataUri(name);
    }
    function renderUser(user) {
      setAvatar(user.avatar, user.name || user.username);
      document.getElementById('detailName').textContent = user.name || '未设置姓名';
      document.getElementById('detailUsername').textContent = user.username || '';
      document.getElementById('detailId').textContent = user.id || '';
      document.getElementById('usernameHint').textContent = user.username || '';

      const roleBadge = document.getElementById('roleBadge');
      roleBadge.className = `inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${user.role === 'admin' ? 'bg-primary-soft text-primary' : 'bg-surface-container-low text-muted'}`;
      roleBadge.innerHTML = `<span class="material-symbols-outlined text-sm">${user.role === 'admin' ? 'admin_panel_settings' : 'person'}</span>${user.role === 'admin' ? '管理员' : '普通用户'}`;
      const verifiedBadge = document.getElementById('verifiedBadge');
      verifiedBadge.className = `inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${user.emailVerified ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`;
      verifiedBadge.innerHTML = `<span class="material-symbols-outlined text-sm">${user.emailVerified ? 'mark_email_read' : 'mark_email_unread'}</span>${user.emailVerified ? '邮箱已验证' : '邮箱未验证'}`;
      const bannedBadge = document.getElementById('bannedBadge');
      bannedBadge.className = `inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${user.banned ? 'bg-red-50 text-red-600' : 'bg-surface-container-low text-muted'}`;
      bannedBadge.innerHTML = `<span class="material-symbols-outlined text-sm">${user.banned ? 'block' : 'how_to_reg'}</span>${user.banned ? '已封禁' : '正常'}`;
      document.getElementById('bannedInput').checked = Boolean(user.banned);

      const totpBadge = document.getElementById('totpBadge');
      totpBadge.className = `inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${user.totpEnabled ? 'bg-green-50 text-green-700' : 'bg-surface-container-low text-muted'}`;
      totpBadge.innerHTML = `<span class="material-symbols-outlined text-sm">${user.totpEnabled ? 'phonelink_lock' : 'phonelink_erase'}</span>${user.totpEnabled ? '已绑验证器' : '未绑验证器'}`;
      document.getElementById('totpResetBtn').classList.toggle('hidden', !user.totpEnabled);

      const captchaBadge = document.getElementById('captchaBadge');
      captchaBadge.className = `inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold ${user.captchaRequired ? 'bg-red-50 text-red-600' : 'bg-surface-container-low text-muted'}`;
      captchaBadge.innerHTML = `<span class="material-symbols-outlined text-sm">${user.captchaRequired ? 'verified_user' : 'shield'}</span>${user.captchaRequired ? '下次登录需验证码' : '无强制验证'}`;
      document.getElementById('captchaClearBtn').classList.toggle('hidden', !user.captchaRequired);

      document.getElementById('detailCreatedAt').textContent = dateText(user.createdAt);
      document.getElementById('detailUpdatedAt').textContent = dateText(user.updatedAt);

      const identities = Array.isArray(user.identities) ? user.identities : [];
      const list = document.getElementById('identityList');
      list.innerHTML = identities.length
        ? identities.map(identity => `<div class="flex items-center justify-between gap-3 rounded-lg border border-line/70 px-3 py-2"><span class="inline-flex items-center gap-2 text-sm font-bold text-ink"><span class="material-symbols-outlined text-base text-primary">key</span>${escapeHtml(identity.provider)}</span><span class="truncate text-xs text-muted" title="${escapeHtml(identity.providerUserId)}">${escapeHtml(identity.providerUsername || identity.providerUserId)}</span></div>`).join('')
        : '<p class="text-sm text-muted">该账户未绑定第三方账号。</p>';

      document.getElementById('nameInput').value = user.name || '';
      document.getElementById('emailInput').value = user.email || '';
      document.getElementById('phoneCountryInput').value = `+${user.phoneCountryCode || '86'}`;
      document.getElementById('phoneInput').value = user.phoneNationalNumber || '';
      document.getElementById('phoneStatus').textContent = !user.phoneE164 ? '未绑定手机号' : user.phoneVerified ? '已验证' : '未验证';
      document.getElementById('phoneClearBtn').hidden = !user.phoneE164;
      document.getElementById('avatarInput').value = user.avatar || '';
      document.getElementById('descriptionInput').value = user.description || '';
      document.getElementById('creditsInput').value = String(user.credits ?? 0);
      document.getElementById('roleInput').value = user.role === 'admin' ? 'admin' : 'user';
      document.getElementById('verifiedInput').checked = Boolean(user.emailVerified);
      document.getElementById('detailLastLoginIp').textContent = user.lastLoginIp || '-';
    }
    async function request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
      const payload = response.status === 204 ? null : await response.json();
      if (response.status === 401) { window.location.href = '/oauth2/authorize'; throw new Error('登录已过期'); }
      if (response.status === 403) { window.location.href = '/oauth2/error?error=access_denied'; throw new Error('没有权限'); }
      if (!response.ok) throw new Error(payload?.error_description || '请求失败');
      return payload;
    }
    async function loadUser() {
      const params = new URLSearchParams(window.location.search);
      currentUserId = params.get('id') || '';
      if (!currentUserId) { setStatus('error', '缺少用户 ID，请从用户列表进入。'); return; }
      try {
        const payload = await request(`/api/users/${encodeURIComponent(currentUserId)}`);
        renderUser(payload.user);
        if (window.location.hash === '#phoneInput') document.getElementById('phoneInput').focus();
        setStatus('info', `正在查看用户：${payload.user.name || payload.user.username || payload.user.id}`);
      } catch (error) { setStatus('error', error.message); }
    }
    editForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!currentUserId) return;
      saveBtn.disabled = true;
      try {
        const payload = await request(`/api/users/${encodeURIComponent(currentUserId)}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: document.getElementById('nameInput').value.trim(),
            email: document.getElementById('emailInput').value.trim(),
            avatar: document.getElementById('avatarInput').value.trim(),
            description: document.getElementById('descriptionInput').value,
            credits: Number(document.getElementById('creditsInput').value || 0),
            role: document.getElementById('roleInput').value,
            emailVerified: document.getElementById('verifiedInput').checked,
            banned: document.getElementById('bannedInput').checked,
            phoneCountryCode: document.getElementById('phoneCountryInput').value.trim(),
            phoneNumber: document.getElementById('phoneInput').value.trim()
          })
        });
        renderUser(payload.user);
        setStatus('success', '用户信息已保存。');
      } catch (error) { setStatus('error', error.message); }
      finally { saveBtn.disabled = false; }
    });
    document.getElementById('phoneClearBtn').addEventListener('click', () => {
      if (!window.confirm('解除该用户的手机号绑定？保存后生效。')) return;
      document.getElementById('phoneInput').value = '';
      document.getElementById('phoneInput').focus();
      document.getElementById('phoneStatus').textContent = '待解除绑定，保存后生效';
    });
    document.getElementById('captchaClearBtn').addEventListener('click', async () => {
      if (!currentUserId) return;
      try {
        await request(`/api/users/${encodeURIComponent(currentUserId)}`, { method: 'PUT', body: JSON.stringify({ captchaRequired: false }) });
        setStatus('success', '已清除强制验证码标记。');
        await loadUser();
      } catch (error) { setStatus('error', error.message); }
    });
    document.getElementById('revokeSessionsBtn').addEventListener('click', async () => {
      if (!currentUserId) return;
      if (!window.confirm('确定强制该用户退出所有设备吗？')) return;
      try {
        await request(`/api/users/${encodeURIComponent(currentUserId)}/revoke-sessions`, { method: 'POST' });
        setStatus('success', '已强制该用户退出所有设备。');
      } catch (error) { setStatus('error', error.message); }
    });
    document.getElementById('totpResetBtn').addEventListener('click', async () => {
      if (!currentUserId) return;
      if (!window.confirm('确定重置该用户的验证器绑定吗？重置后该用户可直接重新绑定。')) return;
      try {
        await request(`/api/users/${encodeURIComponent(currentUserId)}/totp/reset`, { method: 'POST' });
        setStatus('success', '已重置该用户的验证器绑定。');
        await loadUser();
      } catch (error) { setStatus('error', error.message); }
    });
    loadUser();
