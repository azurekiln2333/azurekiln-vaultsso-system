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
    return `<div class="min-w-0"><dt class="mb-1 text-xs text-muted">${label}</dt><dd class="break-all text-sm text-ink">${escapeHtml(value || '未记录')}</dd></div>`;
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
    status.className = 'mb-6 text-sm text-muted';
    status.textContent = !accounts.length ? '暂无用户应用记录' : !visible.length ? '没有符合条件的用户应用' : `显示 ${visible.length} 个账号`;
    container.innerHTML = visible.map(account => `<section class="border-t border-line pt-5">
      <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <a class="break-all text-lg font-bold text-primary hover:underline" href="/user.html?id=${encodeURIComponent(account.user.id)}">${escapeHtml(account.user.name || account.user.username)}</a>
          <p class="mt-1 break-all text-xs text-muted">${escapeHtml(account.user.username)} · ${escapeHtml(account.user.email)}</p>
          <p class="mt-1 break-all text-xs text-muted">${escapeHtml(account.user.id)}</p>
        </div>
        <span class="text-xs text-muted">${(account.applications || []).length} 条应用记录 · ${account.bindings.length} 个第三方绑定</span>
      </div>
      <h2 class="mb-2 text-sm font-bold">登录过的应用</h2>
      <div>${(account.applications || []).length ? account.applications.map(app => `<article class="border-b border-line py-4" data-client-id="${escapeHtml(app.clientId)}">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 class="break-all text-sm font-bold">${escapeHtml(app.name || app.clientId)}</h3><span class="text-xs text-muted">${!app.configured ? '应用已移除' : app.enabled ? '已启用' : '已禁用'}</span></div>
        <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">${field('Client ID', app.clientId)}${field('首次记录', dateText(app.firstUsedAt))}${field('最近活动', dateText(app.lastUsedAt))}</dl>
      </article>`).join('') : '<p class="mb-4 text-sm text-muted">暂无应用登录记录</p>'}</div>
      <h2 class="mb-2 mt-4 text-sm font-bold">第三方应用绑定</h2>
      <div>${account.bindings.map(binding => `<article class="border-b border-line py-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="break-all text-sm font-bold">${escapeHtml(binding.providerName)} <span class="font-normal text-muted">${escapeHtml(binding.provider)}</span></h3>
          <span class="text-xs ${!binding.configured ? 'text-amber-700' : binding.enabled ? 'text-green-700' : 'text-muted'}">${!binding.configured ? '未配置 / 配置已移除' : binding.enabled ? '已启用' : '已禁用'}</span>
        </div>
        <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          ${field('Client ID / App ID', binding.clientId)}
          ${binding.providerType === 'huawei_quicklogin' ? field('OpenID · App', binding.openId) + field('UnionID · 主体', binding.unionId) + field('华为主体分组', binding.huaweiUnionScope || '独立（未设置）') : field('用户标识', binding.providerUserId) + field('第二标识', binding.providerSecondaryId)}
          ${field('绑定时间', dateText(binding.createdAt))}${field('更新时间', dateText(binding.updatedAt))}
        </dl>
      </article>`).join('') || '<p class="text-sm text-muted">暂无第三方应用绑定</p>'}</div>
    </section>`).join('');
  }
  async function load() {
    refresh.disabled = true;
    status.className = 'mb-6 text-sm text-muted';
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
      status.className = 'mb-6 text-sm text-red-600';
      status.textContent = error.message;
    } finally {
      refresh.disabled = false;
    }
  }
  search.addEventListener('input', render);
  refresh.addEventListener('click', load);
  load();
})();
