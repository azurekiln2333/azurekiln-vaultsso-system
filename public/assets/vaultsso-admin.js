(function () {
  const page = document.documentElement.getAttribute('data-admin-page') || '';
  const NAV_ITEMS = [
    { id: 'users', href: '/users.html', icon: 'group', key: 'admin.nav.users', label: '用户管理' },
    { id: 'apps', href: '/apps.html', icon: 'apps', key: 'admin.nav.apps', label: '应用管理' },
    { id: 'tokens', href: '/tokens.html', icon: 'vpn_key', key: 'admin.nav.tokens', label: '令牌审计' },
    { id: 'security', href: '/security.html', icon: 'security', key: 'admin.nav.security', label: '安全设置' },
    { id: 'smtp', href: '/smtp.html', icon: 'outgoing_mail', key: 'admin.nav.smtp', label: '发件设置' }
  ];

  function t(key, fallback) {
    return window.VaultI18n ? window.VaultI18n.t(key) : fallback;
  }

  function buildSidebar() {
    const navLinks = NAV_ITEMS.map(item => `
      <a class="admin-nav-item ${page === item.id ? 'active' : ''}" href="${item.href}">
        <span class="material-symbols-outlined">${item.icon}</span>${escapeHtml(t(item.key, item.label))}
      </a>`).join('');

    const languageSwitch = window.VaultI18n ? `
      <div class="language-switch mt-3 inline-flex items-center gap-1 rounded-lg border border-line bg-white p-1">
        <button class="rounded-md px-3 py-2 text-xs font-bold text-muted" type="button" data-language-switch="zh">${escapeHtml(t('common.language.zh', '中文'))}</button>
        <button class="rounded-md px-3 py-2 text-xs font-bold text-muted" type="button" data-language-switch="en">${escapeHtml(t('common.language.en', 'English'))}</button>
      </div>` : '';

    return `
      <div class="flex items-center gap-3 px-5 py-5">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl primary-gradient text-lg font-black text-white">V</div>
        <div>
          <p class="font-headline text-lg font-extrabold tracking-tight text-primary">${escapeHtml(t('common.brand', 'VaultSSO'))}</p>
          <p class="text-xs text-muted">${escapeHtml(t('admin.nav.brand_subtitle', '管理中心'))}</p>
        </div>
      </div>
      <div class="admin-sidebar-scroll">
        <p class="admin-nav-group">${escapeHtml(t('admin.nav.section_admin', '管理'))}</p>
        ${navLinks}
        <p class="admin-nav-group">${escapeHtml(t('admin.nav.section_resources', '资源'))}</p>
        <a class="admin-nav-item ${page === 'docs' ? 'active' : ''}" href="/api-docs.html">
          <span class="material-symbols-outlined">menu_book</span>${escapeHtml(t('admin.nav.docs', 'API 文档'))}
        </a>
      </div>
      <div class="admin-sidebar-footer">
        <a class="admin-nav-item" href="/profile">
          <span class="material-symbols-outlined">person</span>${escapeHtml(t('admin.nav.profile', '个人信息'))}
        </a>
        <a class="admin-nav-item" href="/oauth2/logout">
          <span class="material-symbols-outlined">logout</span>${escapeHtml(t('admin.nav.logout', '退出登录'))}
        </a>
        ${languageSwitch}
      </div>`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function mount() {
    const sidebar = document.createElement('aside');
    sidebar.className = 'admin-sidebar';
    sidebar.id = 'adminSidebar';
    sidebar.innerHTML = buildSidebar();

    const overlay = document.createElement('div');
    overlay.className = 'admin-overlay hidden';
    overlay.id = 'adminOverlay';

    const topbar = document.createElement('div');
    topbar.className = 'admin-topbar';
    topbar.innerHTML = `
      <button class="rounded-lg border border-line bg-white px-3 py-2 text-muted" type="button" id="adminMenuBtn" aria-label="${escapeHtml(t('admin.nav.menu', '打开菜单'))}">
        <span class="material-symbols-outlined text-lg">menu</span>
      </button>
      <div class="flex items-center gap-2">
        <div class="flex h-8 w-8 items-center justify-center rounded-lg primary-gradient text-sm font-black text-white">V</div>
        <p class="font-headline text-base font-extrabold tracking-tight text-primary">${escapeHtml(t('common.brand', 'VaultSSO'))}</p>
      </div>`;

    document.body.prepend(sidebar, overlay);

    const main = document.body.querySelector('.admin-main');
    if (main) {
      main.prepend(topbar);
    }

    function closeSidebar() {
      sidebar.classList.remove('open');
      overlay.classList.add('hidden');
    }

    topbar.querySelector('#adminMenuBtn').addEventListener('click', () => {
      const isOpen = sidebar.classList.toggle('open');
      overlay.classList.toggle('hidden', !isOpen);
    });
    overlay.addEventListener('click', closeSidebar);

    if (window.VaultI18n) {
      window.VaultI18n.bindLanguageButtons(sidebar);
      document.addEventListener('vaultsso:languagechange', () => {
        sidebar.innerHTML = buildSidebar();
        window.VaultI18n.bindLanguageButtons(sidebar);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
