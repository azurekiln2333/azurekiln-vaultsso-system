(function () {
  const page = document.documentElement.getAttribute('data-admin-page') || '';
  const isShell = document.documentElement.hasAttribute('data-admin-shell');
  // Embedded pages (inside the admin shell iframe) must not inject their own sidebar.
  const isEmbedded = window.self !== window.top || new URLSearchParams(window.location.search).has('embed');

  const NAV_ITEMS = [
    { id: 'users', href: '/users.html', icon: 'group', key: 'admin.nav.users', label: '用户管理' },
    { id: 'apps', href: '/apps.html', icon: 'apps', key: 'admin.nav.apps', label: '应用管理' },
    { id: 'tokens', href: '/tokens.html', icon: 'vpn_key', key: 'admin.nav.tokens', label: '令牌审计' },
    { id: 'security', href: '/security.html', icon: 'security', key: 'admin.nav.security', label: '安全设置' },
    { id: 'smtp', href: '/smtp.html', icon: 'outgoing_mail', key: 'admin.nav.smtp', label: '发件设置' }
  ];
  const EXTRA_ITEMS = [
    { id: 'docs', href: '/api-docs.html', icon: 'menu_book', key: 'admin.nav.docs', label: 'API 文档', group: 'resources' },
    { id: 'profile', href: '/profile', icon: 'person', key: 'admin.nav.profile', label: '个人信息', group: 'footer' },
    { id: 'logout', href: '/oauth2/logout', icon: 'logout', key: 'admin.nav.logout', label: '退出登录', group: 'footer' }
  ];

  function t(key, fallback) {
    return window.VaultI18n ? window.VaultI18n.t(key) : fallback;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function navItemHtml(item, activeId) {
    return `<a class="admin-nav-item ${page === item.id || activeId === item.id ? 'active' : ''}" href="${item.href}" data-nav-id="${item.id}" title="${escapeHtml(t(item.key, item.label))}">
      <span class="material-symbols-outlined">${item.icon}</span><span class="admin-nav-label">${escapeHtml(t(item.key, item.label))}</span>
    </a>`;
  }

  function buildSidebarContent(activeId) {
    const mainNav = NAV_ITEMS.map(item => navItemHtml(item, activeId)).join('');
    const docsNav = EXTRA_ITEMS.filter(item => item.group === 'resources').map(item => navItemHtml(item, activeId)).join('');
    const footerNav = EXTRA_ITEMS.filter(item => item.group === 'footer').map(item => navItemHtml(item, activeId)).join('');

    return `
      <div class="admin-sidebar-head">
        <button class="admin-collapse-btn" type="button" data-admin-collapse title="${escapeHtml(t('admin.nav.collapse', '收起侧边栏'))}" aria-label="${escapeHtml(t('admin.nav.collapse', '收起侧边栏'))}">
          <span class="material-symbols-outlined">menu_open</span>
        </button>
        <a class="admin-brand" href="/admin.html#/users">
          <span class="admin-brand-logo">V</span>
          <span class="admin-brand-text">
            <span class="font-headline admin-nav-label">${escapeHtml(t('common.brand', 'VaultSSO'))}</span>
            <span class="admin-brand-sub admin-nav-label">${escapeHtml(t('admin.nav.brand_subtitle', '管理中心'))}</span>
          </span>
        </a>
      </div>
      <div class="admin-sidebar-scroll">
        <p class="admin-nav-group admin-nav-label">${escapeHtml(t('admin.nav.section_admin', '管理'))}</p>
        ${mainNav}
        <p class="admin-nav-group admin-nav-label">${escapeHtml(t('admin.nav.section_resources', '资源'))}</p>
        ${docsNav}
      </div>
      <div class="admin-sidebar-footer">
        ${footerNav}
      </div>`;
  }

  function applyCollapsed(sidebar, collapsed) {
    document.body.classList.toggle('admin-collapsed', collapsed);
    const btn = sidebar.querySelector('[data-admin-collapse] .material-symbols-outlined');
    if (btn) btn.textContent = collapsed ? 'menu' : 'menu_open';
  }

  function bindCollapseToggle(sidebar) {
    const button = sidebar.querySelector('[data-admin-collapse]');
    if (!button) return;
    let collapsed = window.localStorage.getItem('admin_sidebar_collapsed') === '1';
    applyCollapsed(sidebar, collapsed);
    button.addEventListener('click', () => {
      collapsed = !collapsed;
      window.localStorage.setItem('admin_sidebar_collapsed', collapsed ? '1' : '0');
      applyCollapsed(sidebar, collapsed);
    });
  }

  function bindLanguageSwitch(container, onChange) {
    if (!window.VaultI18n) return;
    window.VaultI18n.bindLanguageButtons(container);
    document.addEventListener('vaultsso:languagechange', () => {
      if (onChange) onChange();
    });
  }

  // --- Shell mode: fixed sidebar + iframe switching without full page reloads ---
  function mountShell() {
    const sidebar = document.createElement('aside');
    sidebar.className = 'admin-sidebar';
    sidebar.id = 'adminSidebar';

    const overlay = document.createElement('div');
    overlay.className = 'admin-overlay hidden';
    overlay.id = 'adminOverlay';

    const frameWrap = document.createElement('div');
    frameWrap.className = 'admin-shell-iframe-wrap';
    frameWrap.innerHTML = '<iframe class="admin-shell-iframe" id="adminFrame" title="管理中心内容区"></iframe>';

    const topbar = document.createElement('div');
    topbar.className = 'admin-topbar';
    topbar.innerHTML = `
      <button class="rounded-lg border border-line bg-white px-3 py-2 text-muted" type="button" id="adminMenuBtn" aria-label="${escapeHtml(t('admin.nav.menu', '打开菜单'))}">
        <span class="material-symbols-outlined text-lg">menu</span>
      </button>
      <div class="flex items-center gap-2">
        <span class="flex h-8 w-8 items-center justify-center rounded-lg primary-gradient text-sm font-black text-white">V</span>
        <span class="font-headline text-base font-extrabold tracking-tight text-primary">${escapeHtml(t('common.brand', 'VaultSSO'))}</span>
      </div>`;

    document.body.append(sidebar, overlay, frameWrap);
    document.body.prepend(topbar);

    const iframe = frameWrap.querySelector('#adminFrame');
    const shellRoutes = NAV_ITEMS.concat(EXTRA_ITEMS.filter(item => item.group === 'resources'));
    const shellRouteIds = new Set(shellRoutes.map(item => item.id));

    function routeForHash(hash) {
      const id = String(hash || '').replace(/^#\/?/, '') || 'users';
      return shellRoutes.find(item => item.id === id) || shellRoutes[0];
    }

    function syncActive() {
      const current = routeForHash(window.location.hash).id;
      sidebar.querySelectorAll('[data-nav-id]').forEach(link => {
        link.classList.toggle('active', link.dataset.navId === current);
      });
    }

    function loadRoute(reload) {
      const route = routeForHash(window.location.hash);
      const target = `${route.href}${route.href.includes('?') ? '&' : '?'}embed=1`;
      const currentPath = iframe.contentWindow ? iframe.contentWindow.location.pathname + iframe.contentWindow.location.search : '';
      if (reload || currentPath !== route.href) {
        iframe.src = target;
      }
      syncActive();
    }

    sidebar.innerHTML = buildSidebarContent(routeForHash(window.location.hash).id);
    bindCollapseToggle(sidebar);

    sidebar.addEventListener('click', event => {
      const link = event.target.closest('a[data-nav-id]');
      if (!link) return;
      // Footer links like profile/logout navigate the whole page; only shell routes are iframe-switched.
      if (!shellRouteIds.has(link.dataset.navId)) return;
      event.preventDefault();
      const targetHash = `#/${link.dataset.navId}`;
      if (window.location.hash === targetHash) {
        loadRoute(true);
      } else {
        window.location.hash = targetHash;
      }
      closeDrawer();
    });

    window.addEventListener('hashchange', () => loadRoute(false));

    function closeDrawer() {
      sidebar.classList.remove('open');
      overlay.classList.add('hidden');
    }
    topbar.querySelector('#adminMenuBtn').addEventListener('click', () => {
      const isOpen = sidebar.classList.toggle('open');
      overlay.classList.toggle('hidden', !isOpen);
    });
    overlay.addEventListener('click', closeDrawer);

    iframe.addEventListener('load', () => {
      try {
        const frameLocation = iframe.contentWindow.location;
        if (frameLocation.pathname.startsWith('/oauth2/')) {
          window.location.href = frameLocation.href;
        }
      } catch (error) {
        // Cross-origin frames cannot be inspected; nothing to do.
      }
    });

    bindLanguageSwitch(sidebar, () => {
      sidebar.innerHTML = buildSidebarContent(routeForHash(window.location.hash).id);
      bindCollapseToggle(sidebar);
      window.VaultI18n.bindLanguageButtons(sidebar);
      syncActive();
      loadRoute(true);
    });

    loadRoute(true);
  }

  // --- Page mode: inject the shared sidebar into a standalone admin page ---
  function mountPageSidebar() {
    const sidebar = document.createElement('aside');
    sidebar.className = 'admin-sidebar';
    sidebar.id = 'adminSidebar';
    sidebar.innerHTML = buildSidebarContent(page);

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
        <span class="flex h-8 w-8 items-center justify-center rounded-lg primary-gradient text-sm font-black text-white">V</span>
        <span class="font-headline text-base font-extrabold tracking-tight text-primary">${escapeHtml(t('common.brand', 'VaultSSO'))}</span>
      </div>`;

    document.body.prepend(sidebar, overlay);

    const main = document.body.querySelector('.admin-main');
    if (main) {
      main.prepend(topbar);
    }

    bindCollapseToggle(sidebar);

    sidebar.addEventListener('click', event => {
      if (event.target.closest('[data-admin-collapse]')) event.stopPropagation();
    }, true);

    function closeDrawer() {
      sidebar.classList.remove('open');
      overlay.classList.add('hidden');
    }
    topbar.querySelector('#adminMenuBtn').addEventListener('click', () => {
      const isOpen = sidebar.classList.toggle('open');
      overlay.classList.toggle('hidden', !isOpen);
    });
    overlay.addEventListener('click', closeDrawer);

    bindLanguageSwitch(sidebar, () => {
      const wasCollapsed = document.body.classList.contains('admin-collapsed');
      sidebar.innerHTML = buildSidebarContent(page);
      bindCollapseToggle(sidebar);
      window.VaultI18n.bindLanguageButtons(sidebar);
      applyCollapsed(sidebar, wasCollapsed);
    });
  }

  if (isShell) {
    mountShell();
  } else if (isEmbedded) {
    document.documentElement.setAttribute('data-admin-embed', '1');
  } else {
    mountPageSidebar();
  }
})();
