const tableBody = document.getElementById('userTableBody');
    const statusBar = document.getElementById('statusBar');
    const searchInput = document.getElementById('searchInput');
    const verifiedFilter = document.getElementById('verifiedFilter');
    const refreshBtn = document.getElementById('refreshBtn');
    const importBtn = document.getElementById('importBtn');
    const importModal = document.getElementById('importModal');
    const importFileInput = document.getElementById('importFileInput');
    const importContent = document.getElementById('importContent');
    const importSubmitBtn = document.getElementById('importSubmitBtn');
    const importCancelBtn = document.getElementById('importCancelBtn');
    const importCloseBtn = document.getElementById('importCloseBtn');
    const importResult = document.getElementById('importResult');
    let allUsers = [];
    let pendingDeleteId = '';
    let pendingDeleteTimer = null;
    let pendingBanId = '';
    let pendingBanTimer = null;

    function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
    function dateText(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN'); }
    function setStatus(kind, message) {
      statusBar.className = `admin-status admin-status-${kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info'} mb-4`;
      statusBar.textContent = message;
    }
    function updateStats() {
      document.getElementById('statsTotal').textContent = allUsers.length;
      document.getElementById('statsAdmins').textContent = allUsers.filter(user => user.role === 'admin').length;
    }
    function filteredUsers() {
      const keyword = searchInput.value.trim().toLowerCase();
      return allUsers.filter(user => {
        const text = [user.id, user.name, user.username, user.email, user.phoneE164, user.phoneNationalNumber].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!verifiedFilter.value || String(Boolean(user.emailVerified)) === verifiedFilter.value);
      });
    }
    function renderUsers() {
      const users = filteredUsers();
      tableBody.innerHTML = '';
      if (!users.length) { tableBody.innerHTML = '<tr><td colspan="9"><div class="napi-empty"><span class="material-symbols-outlined">person_search</span><p class="napi-empty-title">没有符合条件的用户</p><p>调整搜索关键字或邮箱状态筛选后再试。</p></div></td></tr>'; return; }
      users.forEach(user => {
        const row = document.createElement('tr');
        row.className = 'align-top';
        row.dataset.userId = user.id;
        row.addEventListener('click', (event) => {
          if (event.target.closest('select, button, a, input, label')) return;
          window.location.href = `/user.html?id=${encodeURIComponent(user.id)}`;
        });
        const identities = Array.isArray(user.identities) ? user.identities : [];
        const identityHtml = identities.length ? identities.map(identity => `<span class="napi-badge napi-badge-accent" title="${escapeHtml(identity.providerUserId)}">${escapeHtml(identity.provider)}</span>`).join('') : `<span class="admin-cell-sub">未绑定</span>`;
        const initials = escapeHtml((user.name || user.username || '?').slice(0, 1).toUpperCase());
        row.innerHTML = `<td><div class="admin-table-cell-user"><div class="admin-avatar">${initials}</div><div class="admin-cell-stack"><span class="admin-cell-strong">${escapeHtml(user.name || '未设置姓名')}</span><span class="admin-cell-sub">${escapeHtml(user.username || '')}</span><code class="admin-cell-sub">${escapeHtml(user.id || '')}</code></div></div></td><td><div class="admin-cell-stack"><span class="admin-cell-strong">${escapeHtml(user.email || '未设置邮箱')}</span></div></td><td><div class="flex flex-wrap gap-1">${identityHtml}</div></td><td><select class="napi-select admin-select-inline" data-role-id="${escapeHtml(user.id)}"><option value="user" ${user.role !== 'admin' ? 'selected' : ''}>普通用户</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option></select></td><td><span class="napi-badge ${user.emailVerified ? 'napi-badge-success' : 'napi-badge-warning'}">${user.emailVerified ? '已验证' : '未验证'}</span></td><td><span class="napi-badge ${user.banned ? 'napi-badge-danger' : ''}"><span class="material-symbols-outlined">${user.banned ? 'block' : 'how_to_reg'}</span>${user.banned ? '已封禁' : '正常'}</span></td><td class="admin-cell-sub">${dateText(user.createdAt)}</td><td><div class="admin-row-actions"><button class="napi-btn napi-btn-sm ${user.banned ? 'napi-btn-secondary' : 'napi-btn-danger'}" data-ban-id="${escapeHtml(user.id)}" type="button">${user.banned ? '解封' : '封禁'}</button><button class="napi-btn napi-btn-secondary napi-btn-sm" data-detail-id="${escapeHtml(user.id)}" type="button"><span class="material-symbols-outlined">edit</span>编辑</button><button class="napi-btn napi-btn-danger napi-btn-sm" data-delete-id="${escapeHtml(user.id)}" type="button">删除</button></div></td>`;
        const phoneCell = document.createElement('td');
        phoneCell.innerHTML = `<div class="admin-cell-stack"><span class="admin-cell-strong">${escapeHtml(user.phoneMasked || '未绑定手机号')}</span><div class="flex items-center gap-2"><span class="admin-cell-sub">${user.phoneE164 ? (user.phoneVerified ? '已验证' : '未验证') : ''}</span><a class="napi-btn napi-btn-ghost napi-btn-sm" href="/user.html?id=${encodeURIComponent(user.id)}#phoneInput" title="编辑手机号"><span class="material-symbols-outlined">edit</span>手机号</a></div></div>`;
        row.insertBefore(phoneCell, row.cells[2]);
        tableBody.appendChild(row);
      });
      tableBody.querySelectorAll('[data-role-id]').forEach(control => control.addEventListener('change', () => updateUser(control.dataset.roleId, { role: control.value })));
      tableBody.querySelectorAll('[data-ban-id]').forEach(control => control.addEventListener('click', () => toggleBan(control.dataset.banId, control)));
      tableBody.querySelectorAll('[data-detail-id]').forEach(control => control.addEventListener('click', () => { window.location.href = `/user.html?id=${encodeURIComponent(control.dataset.detailId)}`; }));
      tableBody.querySelectorAll('[data-delete-id]').forEach(control => control.addEventListener('click', () => deleteUser(control.dataset.deleteId, control)));
    }
    async function request(url, options = {}) {
      const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
      const payload = response.status === 204 ? null : await response.json();
      if (response.status === 401) { window.location.href = '/oauth2/authorize'; throw new Error('登录已过期'); }
      if (response.status === 403) { window.location.href = '/oauth2/error?error=access_denied'; throw new Error('没有权限'); }
      if (!response.ok) throw new Error(payload?.error_description || '请求失败');
      return payload;
    }
    async function loadUsers() {
      refreshBtn.disabled = true;
      setStatus('info', '正在加载全部用户...');
      try { allUsers = await request('/api/users') || []; updateStats(); renderUsers(); setStatus('success', `已加载 ${allUsers.length} 个用户，当前显示 ${filteredUsers().length} 个。`); }
      catch (error) { allUsers = []; updateStats(); renderUsers(); setStatus('error', error.message); }
      finally { refreshBtn.disabled = false; }
    }
    async function updateUser(id, changes) {
      try { const payload = await request(`/api/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(changes) }); const index = allUsers.findIndex(user => user.id === id); if (index >= 0) allUsers[index] = payload.user; updateStats(); renderUsers(); setStatus('success', '用户信息已更新。'); }
      catch (error) { setStatus('error', error.message); renderUsers(); }
    }
    function toggleBan(id, button) {
      const user = allUsers.find(item => item.id === id);
      if (!user) return;
      if (pendingBanId !== id) {
        pendingBanId = id;
        button.textContent = user.banned ? '确认解封？' : '确认封禁？';
        pendingBanTimer = setTimeout(() => { pendingBanId = ''; renderUsers(); }, 4000);
        return;
      }
      clearTimeout(pendingBanTimer);
      pendingBanId = '';
      updateUser(id, { banned: !user.banned });
    }
    function deleteUser(id, button) {
      if (pendingDeleteId !== id) { pendingDeleteId = id; button.textContent = '再次点击确认'; button.className = 'napi-btn napi-btn-danger napi-btn-sm'; pendingDeleteTimer = setTimeout(() => { pendingDeleteId = ''; renderUsers(); }, 4000); return; }
      clearTimeout(pendingDeleteTimer);
      request(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(() => { allUsers = allUsers.filter(user => user.id !== id); updateStats(); renderUsers(); setStatus('success', '用户已删除。'); }).catch(error => setStatus('error', error.message)).finally(() => { pendingDeleteId = ''; });
    }
    [searchInput, verifiedFilter].forEach(control => control.addEventListener('input', renderUsers));
    refreshBtn.addEventListener('click', loadUsers);
    function openImportModal() {
      importContent.value = '';
      importFileInput.value = '';
      importResult.hidden = true;
      importResult.innerHTML = '';
      importModal.classList.remove('hidden');
      importModal.classList.add('flex');
    }
    function closeImportModal() {
      importModal.classList.add('hidden');
      importModal.classList.remove('flex');
    }
    importBtn.addEventListener('click', openImportModal);
    importCancelBtn.addEventListener('click', closeImportModal);
    importCloseBtn.addEventListener('click', closeImportModal);
    importModal.addEventListener('click', event => { if (event.target === importModal) closeImportModal(); });
    importFileInput.addEventListener('change', () => {
      const file = importFileInput.files && importFileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { importContent.value = String(reader.result || ''); };
      reader.readAsText(file, 'utf-8');
    });
    importSubmitBtn.addEventListener('click', async () => {
      importSubmitBtn.disabled = true;
      importResult.hidden = false;
      importResult.innerHTML = '<p class="admin-cell-sub">正在导入...</p>';
      try {
        const result = await request('/api/users/import', { method: 'POST', body: JSON.stringify({ content: importContent.value }) });
        const parts = [`<p class="mb-2 text-sm font-bold ${result.skippedCount ? 'text-amber-700' : 'text-green-700'}">成功导入 ${result.createdCount} 个用户，跳过 ${result.skippedCount} 条记录。</p>`];
        if (result.skippedCount) {
          parts.push(`<div class="admin-note admin-note-error"><ul class="space-y-1">${result.skipped.map(item => `<li>第 ${item.row} 行 ${escapeHtml(item.username || item.email || '')}：${escapeHtml(item.reason)}</li>`).join('')}</ul></div>`);
        }
        importResult.innerHTML = parts.join('');
        if (result.createdCount) { await loadUsers(); }
      } catch (error) {
        importResult.innerHTML = `<p class="admin-status admin-status-error">导入失败：${escapeHtml(error.message)}</p>`;
      } finally { importSubmitBtn.disabled = false; }
    });
    loadUsers();