(function () {
  const page = document.documentElement.getAttribute('data-admin-page') || '';
  const isShell = document.documentElement.hasAttribute('data-admin-shell');
  // Embedded pages (inside the admin shell iframe) must not inject their own chrome.
  const isEmbedded = window.self !== window.top || new URLSearchParams(window.location.search).has('embed');

  const NAV_ITEMS = [
    { id: 'users', href: '/users.html', icon: 'group', key: 'admin.nav.users', label: '用户管理' },
    { id: 'account-bindings', href: '/account-bindings.html', icon: 'account_tree', key: 'admin.nav.account_bindings', label: '用户应用' },
    { id: 'apps', href: '/apps.html', icon: 'apps', key: 'admin.nav.apps', label: '应用管理' },
    { id: 'tokens', href: '/tokens.html', icon: 'vpn_key', key: 'admin.nav.tokens', label: '令牌审计' },
    { id: 'security', href: '/security.html', icon: 'security', key: 'admin.nav.security', label: '安全设置' },
    { id: 'smtp', href: '/smtp.html', icon: 'outgoing_mail', key: 'admin.nav.smtp', label: '发件设置' }
  ];
  const RESOURCE_ITEMS = [
    { id: 'docs', href: '/api-docs.html', icon: 'menu_book', key: 'admin.nav.docs', label: 'API 文档' }
  ];

  function t(key, variables) {
    return window.VaultI18n ? window.VaultI18n.t(key, variables) : key;
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
    return `<a class="admin-nav-item ${activeId === item.id ? 'active' : ''}" href="${item.href}" data-nav-id="${item.id}" title="${escapeHtml(t(item.key))}" aria-current="${activeId === item.id ? 'page' : 'false'}">
      <span class="material-symbols-outlined">${item.icon}</span><span class="admin-nav-label">${escapeHtml(t(item.key))}</span>
    </a>`;
  }

  function buildSidebarContent(activeId) {
    const mainNav = NAV_ITEMS.map(item => navItemHtml(item, activeId)).join('');
    const resourceNav = RESOURCE_ITEMS.map(item => navItemHtml(item, activeId)).join('');

    return `
      <div class="admin-sidebar-scroll">
        <p class="admin-nav-group admin-nav-label">${escapeHtml(t('admin.nav.section_admin'))}</p>
        ${mainNav}
        <p class="admin-nav-group admin-nav-label">${escapeHtml(t('admin.nav.section_resources'))}</p>
        ${resourceNav}
      </div>`;
  }

  // Account dropdown lives in the top-right corner of the top bar.
  function buildTopbarHtml(activeId) {
    const isResource = RESOURCE_ITEMS.some(item => item.id === activeId);
    const routeLabel = NAV_ITEMS.concat(RESOURCE_ITEMS).find(item => item.id === activeId);
    const sectionLabel = isResource ? t('admin.nav.section_resources') : t('admin.nav.section_admin');
    return `
      <div class="admin-topbar-start">
        <button class="admin-icon-btn admin-sidebar-toggle" type="button" data-admin-collapse title="${escapeHtml(t('admin.nav.collapse'))}" aria-label="${escapeHtml(t('admin.nav.collapse'))}" aria-controls="adminSidebar">
          <span class="material-symbols-outlined">menu_open</span>
        </button>
        <a class="admin-brand" href="/admin.html#/users">
          <span class="admin-brand-logo">V</span>
          <span class="admin-brand-text">
            <span class="font-headline">${escapeHtml(t('common.brand'))}</span>
            <span class="admin-brand-sub">${escapeHtml(t('admin.nav.brand_subtitle'))}</span>
          </span>
        </a>
        <nav class="admin-breadcrumb" id="adminBreadcrumb" aria-label="${escapeHtml(t('admin.nav.brand_subtitle'))}">
          <span class="admin-breadcrumb-section" id="adminBreadcrumbSection">${escapeHtml(sectionLabel)}</span>
          <span class="admin-breadcrumb-sep" aria-hidden="true">/</span>
          <span class="admin-breadcrumb-current" id="adminPageTitle">${escapeHtml(routeLabel ? t(routeLabel.key) : '')}</span>
        </nav>
      </div>
      <div class="admin-topbar-end">
        <div class="admin-account" id="adminAccount">
          <button class="admin-account-trigger" type="button" id="adminAccountBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="adminAccountMenu">
            <span class="admin-account-avatar" id="adminAccountAvatar">V</span>
            <span class="admin-account-name" id="adminAccountName">${escapeHtml(t('common.loading'))}</span>
            <span class="material-symbols-outlined admin-account-caret">expand_more</span>
          </button>
          <div class="admin-account-menu hidden" id="adminAccountMenu" role="menu" aria-labelledby="adminAccountBtn">
            <div class="admin-account-meta">
              <p class="admin-account-meta-name" id="adminAccountMenuName">${escapeHtml(t('common.user_fallback'))}</p>
              <p class="admin-account-meta-email" id="adminAccountMenuEmail"></p>
            </div>
            <a class="admin-account-item" role="menuitem" href="/profile">
              <span class="material-symbols-outlined">person</span>${escapeHtml(t('common.action.profile'))}
            </a>
            <a class="admin-account-item" role="menuitem" href="/oauth2/logout">
              <span class="material-symbols-outlined">logout</span>${escapeHtml(t('common.action.logout'))}
            </a>
          </div>
        </div>
      </div>`;
  }

  function applyCollapsed(sidebar, collapsed) {
    document.body.classList.toggle('admin-collapsed', collapsed);
    const btn = document.querySelector('[data-admin-collapse] .material-symbols-outlined');
    if (btn) btn.textContent = collapsed ? 'menu' : 'menu_open';
  }

  // Single source of truth for the collapsed rail state, shared by both toggle buttons.
  let collapseState = null;

  function setCollapsed(collapsed, persist) {
    collapseState = collapsed;
    if (persist) window.localStorage.setItem('admin_sidebar_collapsed', collapsed ? '1' : '0');
    applyCollapsed(null, collapsed);
  }

  function bindCollapseToggle() {
    const button = document.querySelector('[data-admin-collapse]');
    if (!button) return;
    collapseState = window.localStorage.getItem('admin_sidebar_collapsed') === '1';
    applyCollapsed(null, collapseState);
    button.addEventListener('click', () => setCollapsed(!collapseState, true));
  }

  function bindAccountMenu(root) {
    const account = root.querySelector('#adminAccount');
    if (!account) return;
    const button = account.querySelector('#adminAccountBtn');
    const menu = account.querySelector('#adminAccountMenu');
    if (!button || !menu) return;

    function close() {
      menu.classList.add('hidden');
      button.setAttribute('aria-expanded', 'false');
    }
    function open() {
      menu.classList.remove('hidden');
      button.setAttribute('aria-expanded', 'true');
    }

    button.addEventListener('click', event => {
      event.stopPropagation();
      if (menu.classList.contains('hidden')) open(); else close();
    });
    document.addEventListener('click', event => {
      if (!account.contains(event.target)) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
    });
    menu.querySelectorAll('a').forEach(link => link.addEventListener('click', close));
  }

  function loadAccount() {
    if (!window.fetch) return;
    fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(response => (response.ok ? response.json() : null))
      .then(payload => {
        const user = payload && payload.user;
        if (!user) return;
        const displayName = user.name || user.username || t('common.user_fallback');
        const initial = String(displayName || 'V').trim().charAt(0).toUpperCase() || 'V';
        const nameEl = document.getElementById('adminAccountName');
        const menuNameEl = document.getElementById('adminAccountMenuName');
        const emailEl = document.getElementById('adminAccountMenuEmail');
        const avatarEl = document.getElementById('adminAccountAvatar');
        if (nameEl) nameEl.textContent = displayName;
        if (menuNameEl) menuNameEl.textContent = displayName;
        if (emailEl) emailEl.textContent = user.email || user.username || '';
        if (avatarEl) {
          if (user.avatar) {
            avatarEl.innerHTML = `<img src="${escapeHtml(user.avatar)}" alt="">`;
          } else {
            avatarEl.textContent = initial;
          }
        }
      })
      .catch(() => {
        // The menu keeps the fallback label when the session endpoint is unavailable.
      });
  }

  function bindLanguageSwitch(container, onChange) {
    if (!window.VaultI18n) return;
    window.VaultI18n.bindLanguageButtons(container);
    document.addEventListener('vaultsso:languagechange', () => {
      if (onChange) onChange();
    });
  }

  // --- Shell mode: top bar + sidebar + iframe switching without full page reloads ---
  function mountShell() {
    const app = document.createElement('div');
    app.className = 'admin-shell';
    app.innerHTML = `
      <aside class="admin-sidebar" id="adminSidebar"></aside>
      <div class="admin-shell-body">
        <header class="admin-topbar" id="adminTopbar"></header>
        <div class="admin-shell-iframe-wrap">
          <iframe class="admin-shell-iframe" id="adminFrame" title="${escapeHtml(t('admin.nav.brand_subtitle'))}"></iframe>
        </div>
      </div>
      <div class="admin-overlay hidden" id="adminOverlay"></div>`;

    document.body.append(app);

    const sidebar = app.querySelector('#adminSidebar');
    const topbar = app.querySelector('#adminTopbar');
    const overlay = app.querySelector('#adminOverlay');
    const iframe = app.querySelector('#adminFrame');
    const shellRoutes = NAV_ITEMS.concat(RESOURCE_ITEMS);
    const shellRouteIds = new Set(shellRoutes.map(item => item.id));

    function routeForHash(hash) {
      const id = String(hash || '').replace(/^#\/?/, '') || 'users';
      return shellRoutes.find(item => item.id === id) || shellRoutes[0];
    }

    function syncActive() {
      const current = routeForHash(window.location.hash).id;
      sidebar.querySelectorAll('[data-nav-id]').forEach(link => {
        const isActive = link.dataset.navId === current;
        link.classList.toggle('active', isActive);
        link.setAttribute('aria-current', isActive ? 'page' : 'false');
      });
      const route = routeForHash(window.location.hash);
      const titleEl = topbar.querySelector('#adminPageTitle');
      if (titleEl) titleEl.textContent = t(route.key);
      const sectionEl = topbar.querySelector('#adminBreadcrumbSection');
      if (sectionEl) {
        const isResource = RESOURCE_ITEMS.some(item => item.id === route.id);
        sectionEl.textContent = t(isResource ? 'admin.nav.section_resources' : 'admin.nav.section_admin');
      }
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

    function closeDrawer() {
      sidebar.classList.remove('open');
      overlay.classList.add('hidden');
    }

    function render() {
      const activeId = routeForHash(window.location.hash).id;
      sidebar.innerHTML = buildSidebarContent(activeId);
      topbar.innerHTML = buildTopbarHtml(activeId);
      bindCollapseToggle();
      bindAccountMenu(topbar);
    }

    render();
    loadAccount();

    sidebar.addEventListener('click', event => {
      const link = event.target.closest('a[data-nav-id]');
      if (!link) return;
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

    topbar.querySelector('.admin-sidebar-toggle').addEventListener('click', () => {
      // Desktop collapse is handled by the [data-admin-collapse] binding; only the mobile drawer needs this.
      if (!window.matchMedia('(max-width: 1023.98px)').matches) return;
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

    bindLanguageSwitch(topbar, () => {
      render();
      window.VaultI18n.bindLanguageButtons(topbar);
      syncActive();
      loadRoute(true);
    });

    loadRoute(true);
  }

  // --- Page mode: inject the shared chrome into a standalone admin page ---
  function mountPageChrome() {
    const sidebar = document.createElement('aside');
    sidebar.className = 'admin-sidebar';
    sidebar.id = 'adminSidebar';
    sidebar.innerHTML = buildSidebarContent(page);

    const topbar = document.createElement('header');
    topbar.className = 'admin-topbar';
    topbar.id = 'adminTopbar';
    topbar.innerHTML = buildTopbarHtml(page);

    const overlay = document.createElement('div');
    overlay.className = 'admin-overlay hidden';
    overlay.id = 'adminOverlay';

    document.body.prepend(overlay);
    document.body.prepend(sidebar);
    document.body.prepend(topbar);

    bindCollapseToggle();
    bindAccountMenu(topbar);
    loadAccount();

    sidebar.addEventListener('click', event => {
      if (event.target.closest('[data-admin-collapse]')) event.stopPropagation();
    }, true);

    function closeDrawer() {
      sidebar.classList.remove('open');
      overlay.classList.add('hidden');
    }

    topbar.querySelector('.admin-sidebar-toggle').addEventListener('click', () => {
      // Desktop collapse is handled by the [data-admin-collapse] binding; only the mobile drawer needs this.
      if (!window.matchMedia('(max-width: 1023.98px)').matches) return;
      const isOpen = sidebar.classList.toggle('open');
      overlay.classList.toggle('hidden', !isOpen);
    });
    overlay.addEventListener('click', closeDrawer);

    bindLanguageSwitch(topbar, () => {
      const wasCollapsed = document.body.classList.contains('admin-collapsed');
      sidebar.innerHTML = buildSidebarContent(page);
      topbar.innerHTML = buildTopbarHtml(page);
      bindCollapseToggle();
      bindAccountMenu(topbar);
      setCollapsed(wasCollapsed, false);
      window.VaultI18n.bindLanguageButtons(topbar);
      loadAccount();
    });
  }

  if (isShell) {
    mountShell();
  } else if (isEmbedded) {
    document.documentElement.setAttribute('data-admin-embed', '1');
  } else {
    mountPageChrome();
  }
})();
