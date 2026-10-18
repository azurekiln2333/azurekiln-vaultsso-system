(function () {
  const search = document.getElementById('bindingsSearch');
  const refresh = document.getElementById('bindingsRefresh');
  const status = document.getElementById('bindingsStatus');
  const container = document.getElementById('bindingsAccounts');
  const count = document.getElementById('bindingsCount');
  let accounts = [];
  let loaded = false;

  function escapeHtml(value) {
    return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function dateText(value) {
    if (!value) return '未记录';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString();
  }
  function field(label, value) {
    return `<div class="admin-kv"><dt class="napi-label">${label}</dt><dd class="admin-cell-sub">${escapeHtml(value || '未记录')}</dd></div>`;
  }
  function render() {
    if (!loaded) return;
    const keyword = search.value.trim().toLowerCase();
    const visible = accounts.filter(account => [
      account.user.id, account.user.username, account.user.name, account.user.email,
      ...(account.applications || []).flatMap(app => [app.clientId, app.name]),
      ...account.bindings.flatMap(binding => [binding.provider, binding.providerName, binding.clientId, binding.openId, binding.unionId, binding.huaweiUnionScope, binding.providerUserId, binding.providerSecondaryId])
    ].join(' ').toLowerCase().includes(keyword));
    count.textContent = `${accounts.length} 个账号 · ${accounts.reduce((total, account) => total + (account.applications || []).length, 0)} 条应用记录 · ${accounts.reduce((total, account) => total + account.bindings.length, 0)} 个第三方绑定`;
    status.className = 'admin-status mb-4';
    status.textContent = !accounts.length ? '暂无用户应用记录' : !visible.length ? '没有符合条件的用户应用' : `显示 ${visible.length} 个账号`;
    container.innerHTML = visible.map(account => `<section class="napi-panel">
      <div class="napi-panel-head">
        <div class="min-w-0">
          <a class="napi-panel-title" href="/user.html?id=${encodeURIComponent(account.user.id)}">${escapeHtml(account.user.name || account.user.username)}</a>
          <p class="napi-panel-desc">${escapeHtml(account.user.username)} · ${escapeHtml(account.user.email)}</p>
          <p class="napi-panel-desc">${escapeHtml(account.user.id)}</p>
        </div>
        <span class="napi-badge">${(account.applications || []).length} 应用 · ${account.bindings.length} 绑定</span>
      </div>
      <div class="napi-panel-body">
        <h2 class="napi-section-title mb-2">登录过的应用</h2>
        ${(account.applications || []).length ? account.applications.map(app => `<article class="admin-binding-item" data-client-id="${escapeHtml(app.clientId)}">
          <div class="admin-binding-head"><h3 class="admin-cell-strong">${escapeHtml(app.name || app.clientId)}</h3><span class="napi-badge ${!app.configured ? 'napi-badge-warning' : app.enabled ? 'napi-badge-success' : ''}">${!app.configured ? '应用已移除' : app.enabled ? '已启用' : '已禁用'}</span></div>
          <dl class="admin-kv-grid">${field('Client ID', app.clientId)}${field('首次记录', dateText(app.firstUsedAt))}${field('最近活动', dateText(app.lastUsedAt))}</dl>
        </article>`).join('') : '<p class="admin-cell-sub mb-4">暂无应用登录记录</p>'}
        <h2 class="napi-section-title mb-2 mt-4">第三方应用绑定</h2>
        ${account.bindings.map(binding => `<article class="admin-binding-item">
          <div class="admin-binding-head">
            <h3 class="admin-cell-strong">${escapeHtml(binding.providerName)} <span class="admin-cell-sub">${escapeHtml(binding.provider)}</span></h3>
            <span class="napi-badge ${!binding.configured ? 'napi-badge-warning' : binding.enabled ? 'napi-badge-success' : ''}">${!binding.configured ? '未配置 / 配置已移除' : binding.enabled ? '已启用' : '已禁用'}</span>
          </div>
          <dl class="admin-kv-grid">
            ${field('Client ID / App ID', binding.clientId)}
            ${binding.providerType === 'huawei_quicklogin' ? field('OpenID · App', binding.openId) + field('UnionID · 主体', binding.unionId) + field('华为主体分组', binding.huaweiUnionScope || '独立（未设置）') : field('用户标识', binding.providerUserId) + field('第二标识', binding.providerSecondaryId)}
            ${field('绑定时间', dateText(binding.createdAt))}${field('更新时间', dateText(binding.updatedAt))}
          </dl>
        </article>`).join('') || '<p class="admin-cell-sub">暂无第三方应用绑定</p>'}
      </div>
    </section>`).join('');
  }
  async function load() {
    refresh.disabled = true;
    status.className = 'admin-status mb-4';
    status.textContent = '正在加载应用...';
    try {
      const response = await fetch('/api/admin/account-bindings', { credentials: 'same-origin' });
      if (response.status === 401) {
        window.location.href = '/oauth2/authorize?redirect=/account-bindings.html';
        return;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body.error_description || '无法加载账号应用绑定');
      accounts = Array.isArray(body.accounts) ? body.accounts : [];
      loaded = true;
      render();
    } catch (error) {
      loaded = false;
      container.innerHTML = '';
      count.textContent = '';
      status.className = 'admin-status admin-status-error mb-4';
      status.textContent = error.message;
    } finally {
      refresh.disabled = false;
    }
  }
  search.addEventListener('input', render);
  refresh.addEventListener('click', load);
  load();
})();
