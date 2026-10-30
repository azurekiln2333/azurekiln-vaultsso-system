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
    const importSourceHint = document.getElementById('importSourceHint');
    const importLimits = document.getElementById('importLimits');
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
    function isUnboundEmail(email) {
      const value = String(email || '').trim();
      return !value || /@users\.invalid$/i.test(value);
    }
    function emailVerifiedState(user) {
      return isUnboundEmail(user.email) ? false : Boolean(user.emailVerified);
    }
    function filteredUsers() {
      const keyword = searchInput.value.trim().toLowerCase();
      return allUsers.filter(user => {
        const text = [user.id, user.name, user.username, user.email, user.phoneE164, user.phoneNationalNumber].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) && (!verifiedFilter.value || String(emailVerifiedState(user)) === verifiedFilter.value);
      });
    }
    // ---------- 本页用户列表排序（仅前端，不请求服务器） ----------
    // 数据列：用户、邮箱、手机号、第三方账号、角色、邮箱状态、封禁状态、创建时间；操作列不参与排序。
    const SORT_COLUMNS = ['user', 'email', 'phone', 'identity', 'role', 'mailbox', 'ban', 'created'];
    const SORT_ROLE_RANK = { user: 0, admin: 1 };
    const SORT_MAILBOX_RANK = { unbound: 0, unverified: 1, verified: 2 };
    // 中文感知的自然排序：数字后缀按数值比较（如 "用户2" 排在 "用户10" 之前）。
    const SORT_COLLATOR = (typeof Intl !== 'undefined' && Intl.Collator)
      ? new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
      : null;
    let sortKey = '';
    let sortDirection = '';

    function compareSortText(left, right) {
      if (SORT_COLLATOR) return SORT_COLLATOR.compare(String(left), String(right));
      const a = String(left);
      const b = String(right);
      return a < b ? -1 : a > b ? 1 : 0;
    }
    // 每列返回 { missing, value }。missing 表示该列没有可比较值，两个方向都排在最后。
    function sortColumnValue(key, user) {
      switch (key) {
        case 'user': {
          const name = String(user.name || '').trim();
          const fallback = String(user.username || user.id || '').trim();
          return { missing: !name && !fallback, value: name || fallback };
        }
        case 'email':
          // 空值或内部占位邮箱视为未绑定，排最后。
          return { missing: isUnboundEmail(user.email), value: String(user.email || '').toLowerCase() };
        case 'phone':
          return { missing: !user.phoneE164, value: String(user.phoneE164 || '') };
        case 'identity': {
          const providers = (Array.isArray(user.identities) ? user.identities : [])
            .map(identity => String(identity?.provider || '').trim())
            .filter(Boolean)
            .sort(compareSortText);
          return { missing: !providers.length, value: providers.join(' ') };
        }
        case 'role':
          return { missing: false, value: SORT_ROLE_RANK[user.role === 'admin' ? 'admin' : 'user'] };
        case 'mailbox':
          // 未绑定 / 未验证 / 已验证 三种状态各有排序值。
          if (isUnboundEmail(user.email)) return { missing: false, value: SORT_MAILBOX_RANK.unbound };
          return { missing: false, value: user.emailVerified ? SORT_MAILBOX_RANK.verified : SORT_MAILBOX_RANK.unverified };
        case 'ban':
          return { missing: false, value: user.banned ? 1 : 0 };
        case 'created': {
          const time = Date.parse(user.createdAt);
          return { missing: Number.isNaN(time), value: Number.isNaN(time) ? 0 : time };
        }
        default:
          return { missing: true, value: '' };
      }
    }
    // 降序只翻转有值的比较结果；缺失值始终排在最后；相等值保留原顺序（稳定）。
    function compareSortColumn(key, leftUser, rightUser) {
      const left = sortColumnValue(key, leftUser);
      const right = sortColumnValue(key, rightUser);
      if (left.missing !== right.missing) return left.missing ? 1 : -1;
      if (left.missing) return 0;
      const diff = (typeof left.value === 'number' && typeof right.value === 'number')
        ? left.value - right.value
        : compareSortText(left.value, right.value);
      return sortDirection === 'desc' ? -diff : diff;
    }
    function sortedUsers(users) {
      if (!sortKey || !SORT_COLUMNS.includes(sortKey)) return users;
      return users
        .map((user, index) => ({ user, index }))
        .sort((a, b) => {
          const diff = compareSortColumn(sortKey, a.user, b.user);
          return diff !== 0 ? diff : a.index - b.index;
        })
        .map(entry => entry.user);
    }
    function renderSortHeaders() {
      document.querySelectorAll('th[data-sort-column]').forEach(th => {
        const active = th.dataset.sortColumn === sortKey;
        th.setAttribute('aria-sort', active ? (sortDirection === 'desc' ? 'descending' : 'ascending') : 'none');
        const button = th.querySelector('.admin-sort-btn');
        if (button) {
          button.title = active
            ? (sortDirection === 'desc' ? '当前降序，点击切换为升序' : '当前升序，点击切换为降序')
            : '点击按此列排序（升序）';
        }
      });
    }
    function toggleSort(key) {
      if (!SORT_COLUMNS.includes(key)) return;
      if (sortKey === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      else { sortKey = key; sortDirection = 'asc'; }
      renderUsers();
    }

    function renderUsers() {
      const users = sortedUsers(filteredUsers());
      renderSortHeaders();
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
        const emailUnbound = isUnboundEmail(user.email);
        const emailDisplay = emailUnbound ? '未绑定邮箱' : user.email;
        const emailStatusHtml = emailUnbound
          ? '<span class="napi-badge napi-badge-warning">未绑定</span>'
          : `<span class="napi-badge ${user.emailVerified ? 'napi-badge-success' : 'napi-badge-warning'}">${user.emailVerified ? '已验证' : '未验证'}</span>`;
        row.innerHTML = `<td><div class="admin-table-cell-user"><div class="admin-avatar">${initials}</div><div class="admin-cell-stack"><span class="admin-cell-strong">${escapeHtml(user.name || '未设置姓名')}</span><span class="admin-cell-sub">${escapeHtml(user.username || '')}</span><code class="admin-cell-sub">${escapeHtml(user.id || '')}</code></div></div></td><td><div class="admin-cell-stack"><span class="admin-cell-strong">${escapeHtml(emailDisplay)}</span></div></td><td><div class="flex flex-wrap gap-1">${identityHtml}</div></td><td><select class="napi-select admin-select-inline" data-role-id="${escapeHtml(user.id)}"><option value="user" ${user.role !== 'admin' ? 'selected' : ''}>普通用户</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option></select></td><td>${emailStatusHtml}</td><td><span class="napi-badge ${user.banned ? 'napi-badge-danger' : ''}"><span class="material-symbols-outlined">${user.banned ? 'block' : 'how_to_reg'}</span>${user.banned ? '已封禁' : '正常'}</span></td><td class="admin-cell-sub">${dateText(user.createdAt)}</td><td><div class="admin-row-actions"><button class="napi-btn napi-btn-sm ${user.banned ? 'napi-btn-secondary' : 'napi-btn-danger'}" data-ban-id="${escapeHtml(user.id)}" type="button">${user.banned ? '解封' : '封禁'}</button><button class="napi-btn napi-btn-secondary napi-btn-sm" data-detail-id="${escapeHtml(user.id)}" type="button"><span class="material-symbols-outlined">edit</span>编辑</button><button class="napi-btn napi-btn-danger napi-btn-sm" data-delete-id="${escapeHtml(user.id)}" type="button">删除</button></div></td>`;
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
    document.querySelectorAll('th[data-sort-column] .admin-sort-btn').forEach(button => {
      button.addEventListener('click', () => toggleSort(button.dataset.sort));
    });
    refreshBtn.addEventListener('click', loadUsers);
    const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value >= 1024 * 1024) return `${Number((value / (1024 * 1024)).toFixed(value % (1024 * 1024) === 0 ? 0 : 1))} MiB`;
      if (value >= 1024) return `${Number((value / 1024).toFixed(value % 1024 === 0 ? 0 : 1))} KiB`;
      return `${value} B`;
    }
    function utf8ByteLength(text) {
      return new Blob([String(text)]).size;
    }
    function selectedImportFile() {
      return (importFileInput.files && importFileInput.files[0]) || null;
    }
    function renderImportLimits() {
      if (!importLimits) return;
      importLimits.textContent = `文件最大 ${formatBytes(IMPORT_MAX_BYTES)}；email 可留空（需填写 username），无邮箱且无密码的账户登录时会提示联系管理员重置密码；用户名或邮箱重复的记录会被跳过并列出原因。`;
    }
    function updateImportHint() {
      if (!importSourceHint) return;
      const file = selectedImportFile();
      const pasted = importContent.value;
      if (file) {
        importSourceHint.textContent = `将直接上传文件「${file.name}」（${formatBytes(file.size)}），粘贴内容已清除。`;
        return;
      }
      if (pasted.trim()) {
        importSourceHint.textContent = `将按粘贴内容导入（${formatBytes(utf8ByteLength(JSON.stringify({ content: pasted })))}），未使用任何文件。`;
        return;
      }
      importSourceHint.textContent = '选择文件后将直接上传文件；编辑粘贴内容会清除已选文件。';
    }
    function showImportResult(html) {
      importResult.hidden = false;
      importResult.innerHTML = html;
      importResult.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    function importErrorMessage(message) {
      return `<p class="admin-status admin-status-error">导入失败：${escapeHtml(message)}</p>`;
    }

    const IMPORT_DUPLICATE_REASON_CODES = ['duplicate_identity', 'duplicate_username', 'duplicate_email', 'duplicate_external_identity'];
    const IMPORT_INVALID_EMAIL_REASON_CODES = ['invalid_email'];

    function isSyntheticMailbox(email) {
      const value = String(email || '').trim();
      return Boolean(value) && /@users\.invalid$/i.test(value);
    }
    function importEntryAccount(item) {
      const username = String(item?.username || '').trim();
      if (username) return username;
      const email = String(item?.email || '').trim();
      return email && !isSyntheticMailbox(email) ? email : '';
    }
    function importRowsList(items) {
      return `<ul class="space-y-1 overflow-y-auto" style="max-height: 30vh">${items.map(item => `<li>第 ${escapeHtml(String(item?.row ?? ''))} 行 ${escapeHtml(importEntryAccount(item))}${item?.reason ? `：${escapeHtml(item.reason)}` : ''}</li>`).join('')}</ul>`;
    }
    function importResultSections(result) {
      const parts = [];
      const importedWithoutEmail = Array.isArray(result?.importedWithoutEmail) ? result.importedWithoutEmail : [];
      if (importedWithoutEmail.length) {
        parts.push(`<div class="admin-note admin-note-warning"><p class="mb-1">无邮箱但导入成功（共 ${importedWithoutEmail.length} 条）：</p>${importRowsList(importedWithoutEmail)}</div>`);
      }

      const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
      if (!skipped.length) return parts;

      const hasReasonCodes = skipped.some(item => typeof item?.reason_code === 'string' && item.reason_code);
      if (!hasReasonCodes) {
        parts.push(`<div class="admin-note admin-note-error"><p class="mb-1">跳过明细（共 ${skipped.length} 条）：</p>${importRowsList(skipped)}</div>`);
        return parts;
      }

      const duplicate = [];
      const invalidEmail = [];
      const other = [];
      skipped.forEach(item => {
        const code = typeof item?.reason_code === 'string' ? item.reason_code : '';
        if (IMPORT_DUPLICATE_REASON_CODES.includes(code)) duplicate.push(item);
        else if (IMPORT_INVALID_EMAIL_REASON_CODES.includes(code)) invalidEmail.push(item);
        else other.push(item);
      });
      if (duplicate.length) {
        parts.push(`<div class="admin-note admin-note-warning"><p class="mb-1">重复账号跳过（共 ${duplicate.length} 条）：</p>${importRowsList(duplicate)}</div>`);
      }
      if (invalidEmail.length) {
        parts.push(`<div class="admin-note admin-note-error"><p class="mb-1">邮箱格式错误（共 ${invalidEmail.length} 条）：</p>${importRowsList(invalidEmail)}</div>`);
      }
      if (other.length) {
        parts.push(`<div class="admin-note admin-note-error"><p class="mb-1">其他错误（共 ${other.length} 条）：</p>${importRowsList(other)}</div>`);
      }
      return parts;
    }
    async function postUserImport(file, pasted) {
      const options = file
        ? { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: pasted }) };
      const response = await fetch('/api/users/import', { credentials: 'same-origin', ...options });
      if (response.status === 401) { window.location.href = '/oauth2/authorize'; throw new Error('登录已过期'); }
      if (response.status === 403) { window.location.href = '/oauth2/error?error=access_denied'; throw new Error('没有权限'); }
      if (response.status === 413) {
        const payload = await response.json().catch(function () { return null; });
        throw new Error(payload?.error_description
          || `请求内容过大：单次导入上限为 ${formatBytes(IMPORT_MAX_BYTES)}，请拆分文件或内容后重试。`);      }
      let payload = null;
      try { payload = response.status === 204 ? null : await response.json(); } catch (error) { payload = null; }
      if (!response.ok) throw new Error(payload?.error_description || `导入失败（HTTP ${response.status}）`);
      return payload;
    }
    function openImportModal() {
      importContent.value = '';
      importFileInput.value = '';
      importResult.hidden = true;
      importResult.innerHTML = '';
      updateImportHint();
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
      if (selectedImportFile()) importContent.value = '';
      updateImportHint();
    });
    importContent.addEventListener('input', () => {
      if (importFileInput.value) importFileInput.value = '';
      updateImportHint();
    });
    importSubmitBtn.addEventListener('click', async () => {
      const file = selectedImportFile();
      const pasted = importContent.value;
      const requestBytes = file ? file.size : utf8ByteLength(JSON.stringify({ content: pasted }));

      if (!file && !pasted.trim()) {
        showImportResult(importErrorMessage('请选择文件或粘贴内容后再导入。'));
        return;
      }
      if (requestBytes > IMPORT_MAX_BYTES) {
        showImportResult(importErrorMessage(file
          ? `文件 ${formatBytes(file.size)} 超过 ${formatBytes(IMPORT_MAX_BYTES)} 上限，请拆分文件后再导入。`
          : '粘贴内容过大，请使用文件上传或拆分内容。'));
        return;
      }

      importSubmitBtn.disabled = true;
      importResult.hidden = false;
      importResult.innerHTML = '<p class="admin-cell-sub">正在导入...</p>';
      try {
        const result = await postUserImport(file, pasted);
        const summary = `<p class="mb-2 text-sm font-bold ${result.skippedCount ? 'text-amber-700' : 'text-green-700'}">成功导入 ${result.createdCount} 个用户，跳过 ${result.skippedCount} 条记录。</p>`;
        showImportResult([summary, ...importResultSections(result)].join(''));
        if (result.createdCount) { await loadUsers(); }
      } catch (error) {
        showImportResult(importErrorMessage(error.message));
      } finally { importSubmitBtn.disabled = false; }
    });
    renderImportLimits();
    updateImportHint();
    loadUsers();