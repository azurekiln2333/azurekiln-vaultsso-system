const i18n = window.VaultI18n;
    const statusBar = document.getElementById('statusBar');
    const formStatus = document.getElementById('formStatus');
    const clientGrid = document.getElementById('clientGrid');
    const template = document.getElementById('clientCardTemplate');
    const searchInput = document.getElementById('searchInput');
    const refreshBtn = document.getElementById('refreshBtn');
    const clientForm = document.getElementById('clientForm');
    const saveBtn = document.getElementById('saveBtn');
    const editorTitle = document.getElementById('editorTitle');

    let allClients = [];
    let pendingDeleteClientId = '';
    let pendingDeleteTimer = null;

    function translate(key, variables = {}) {
      return i18n.t(key, variables);
    }

    function setStatus(element, kind, message) {
      const classes = {
        error: 'border-red-200 bg-red-50 text-red-700',
        success: 'border-green-200 bg-green-50 text-green-700',
        info: 'border-blue-200 bg-blue-50 text-blue-700'
      };
      element.className = `rounded-lg border px-4 py-3 text-sm shadow-sm ${classes[kind] || classes.info}`;
      element.textContent = message;
      element.classList.toggle('hidden', !message);
    }

    function setButtonLoading(button, isLoading, label) {
      if (!button) return;

      button.disabled = isLoading;
      button.classList.toggle('opacity-70', isLoading);
      button.classList.toggle('cursor-wait', isLoading);

      if (isLoading) {
        button.dataset.originalHtml = button.innerHTML;
        button.innerHTML = `<span class="material-symbols-outlined animate-spin text-lg">progress_activity</span><span>${label || translate('common.loading')}</span>`;
      } else if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
      }
    }

    function clearPendingDelete() {
      pendingDeleteClientId = '';
      if (pendingDeleteTimer) {
        clearTimeout(pendingDeleteTimer);
        pendingDeleteTimer = null;
      }
      document.querySelectorAll('[data-action="delete"]').forEach(button => {
        button.textContent = translate('common.action.delete');
        button.className = 'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-100';
      });
    }

    function splitList(value) {
      return value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean);
    }

    function getFormPayload() {
      return {
        id: document.getElementById('clientId').value.trim(),
        name: document.getElementById('clientName').value.trim(),
        secret: document.getElementById('clientSecret').value.trim(),
        logoUrl: document.getElementById('clientLogo').value.trim(),
        redirectUris: splitList(document.getElementById('clientRedirects').value),
        scopes: splitList(document.getElementById('clientScopes').value),
        isActive: document.getElementById('clientActive').value === 'true',
        requirePkce: document.getElementById('clientRequirePkce').checked
      };
    }

    function formatDate(value) {
      if (!value) return translate('common.not_recorded');
      const date = new Date(value);
      const language = i18n.getLanguage();
      const locale = language === 'zh-TW' ? 'zh-TW' : language === 'zh' ? 'zh-CN' : 'en-US';
      return Number.isNaN(date.getTime()) ? translate('common.not_recorded') : date.toLocaleString(locale);
    }

    function setEditorMode(mode, client = null) {
      document.getElementById('formMode').value = mode;
      document.getElementById('currentClientId').value = client?.id || '';
      editorTitle.textContent = translate(mode === 'edit' ? 'apps.editor.title_edit' : 'apps.editor.title_create');
      saveBtn.textContent = translate(mode === 'edit' ? 'common.action.save_changes' : 'common.action.create');
      document.getElementById('clientId').disabled = mode === 'edit';

      if (!client) {
        clientForm.reset();
        document.getElementById('clientActive').value = 'true';
        document.getElementById('clientRequirePkce').checked = true;
      } else {
        document.getElementById('clientId').value = client.id;
        document.getElementById('clientName').value = client.name || '';
        document.getElementById('clientSecret').value = '';
        document.getElementById('clientLogo').value = client.logoUrl || '';
        document.getElementById('clientRedirects').value = (client.redirectUris || []).join('\n');
        document.getElementById('clientScopes').value = (client.scopes || []).join('\n');
        document.getElementById('clientActive').value = client.isActive !== false ? 'true' : 'false';
        document.getElementById('clientRequirePkce').checked = client.requirePkce !== false;
      }

      setStatus(formStatus, 'info', '');
    }

    function generateSecret() {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      let binary = '';
      bytes.forEach(byte => {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function updateStats(clients) {
      const scopes = new Set();
      document.getElementById('statsTotal').textContent = String(clients.length);
      document.getElementById('statsActive').textContent = String(clients.filter(client => client.isActive !== false).length);
      document.getElementById('statsRedirects').textContent = String(clients.reduce((sum, client) => sum + (client.redirectUris?.length || 0), 0));
      clients.forEach(client => (client.scopes || []).forEach(scope => scopes.add(scope)));
      document.getElementById('statsScopes').textContent = String(scopes.size);
    }

    function searchText(client) {
      return [client.id, client.name, ...(client.redirectUris || []), ...(client.scopes || [])].join(' ').toLowerCase();
    }

    function renderClients(clients) {
      clientGrid.innerHTML = '';
      if (!clients.length) {
        const empty = document.createElement('div');
        empty.className = 'rounded-xl bg-white p-10 text-center text-muted shadow-sm xl:col-span-2';
        empty.innerHTML = `<p class="font-bold text-ink">${translate('apps.list.empty_title')}</p><p class="mt-2">${translate('apps.list.empty_desc')}</p>`;
        clientGrid.appendChild(empty);
        return;
      }

      clients.forEach(client => {
        const fragment = template.content.cloneNode(true);
        const badge = fragment.querySelector('[data-role="badge"]');
        const logoImage = fragment.querySelector('[data-role="logo-image"]');
        const logoFallback = fragment.querySelector('[data-role="logo-fallback"]');
        const scopeList = fragment.querySelector('[data-role="scopes"]');

        fragment.querySelector('[data-role="name"]').textContent = client.name || client.id;
        fragment.querySelector('[data-role="id"]').textContent = client.id;
        const redirectCount = client.redirectUris?.length || 0;
        fragment.querySelector('[data-role="id"]').textContent = translate('apps.card.client_id', { id: client.id });
        fragment.querySelector('[data-role="redirect"]').textContent = client.redirectUris?.[0] || translate('apps.card.no_redirect');
        fragment.querySelector('[data-role="redirect-count"]').textContent = translate(redirectCount === 1 ? 'apps.card.redirect_count_one' : 'apps.card.redirect_count', { count: redirectCount });
        fragment.querySelector('[data-role="created"]').textContent = translate('apps.card.created', { value: formatDate(client.createdAt) });
        fragment.querySelector('[data-role="updated"]').textContent = translate('apps.card.updated', { value: formatDate(client.updatedAt) });

        badge.textContent = translate(client.isActive !== false ? 'apps.card.active' : 'apps.card.inactive');
        badge.className = client.isActive !== false
          ? 'rounded-lg bg-green-50 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-green-700'
          : 'rounded-lg bg-slate-100 px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-slate-600';

        if (client.logoUrl) {
          logoImage.src = client.logoUrl;
          logoImage.alt = translate('apps.card.logo_alt', { name: client.name || client.id });
          logoImage.classList.remove('hidden');
          logoImage.addEventListener('error', () => {
            logoImage.classList.add('hidden');
            logoFallback.textContent = (client.name || client.id || 'A').slice(0, 1).toUpperCase();
          }, { once: true });
        } else {
          logoFallback.textContent = (client.name || client.id || 'A').slice(0, 1).toUpperCase();
        }

        if (!(client.scopes || []).length) {
          const chip = document.createElement('span');
          chip.className = 'rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-bold text-slate-600';
          chip.textContent = translate('apps.card.no_scopes');
          scopeList.appendChild(chip);
        }

        (client.scopes || []).forEach(scope => {
          const chip = document.createElement('span');
          chip.className = 'rounded-lg bg-primary-soft px-2 py-1 text-[11px] font-bold text-primary';
          chip.textContent = scope;
          scopeList.appendChild(chip);
        });

        fragment.querySelector('[data-action="edit"]').addEventListener('click', () => setEditorMode('edit', client));
        fragment.querySelector('[data-action="delete"]').addEventListener('click', event => deleteClient(client, event.currentTarget));
        clientGrid.appendChild(fragment);
      });
    }

    async function request(url, options = {}) {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options
      });
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (response.status === 401) window.location.href = '/oauth2/authorize';
      if (response.status === 403) window.location.href = '/oauth2/error?error=access_denied';
      return { response, payload };
    }

    async function loadClients() {
      setButtonLoading(refreshBtn, true, translate('common.loading'));
      setStatus(statusBar, 'info', translate('apps.status.loading'));
      try {
        const { response, payload } = await request('/api/clients');
        if (!response.ok) throw new Error(i18n.resolveMessage(payload, 'apps.status.load_failed'));
        allClients = Array.isArray(payload) ? payload : [];
        updateStats(allClients);
        applySearch();
      } catch (error) {
        allClients = [];
        updateStats(allClients);
        renderClients([]);
        setStatus(statusBar, 'error', error.message);
      } finally {
        setButtonLoading(refreshBtn, false);
      }
    }

    function applySearch() {
      const keyword = searchInput.value.trim().toLowerCase();
      const clients = keyword ? allClients.filter(client => searchText(client).includes(keyword)) : allClients;
      renderClients(clients);
      setStatus(statusBar, 'info', keyword
        ? translate('apps.status.filtered', { count: clients.length, keyword })
        : translate('apps.status.loaded', { count: allClients.length }));
    }

    async function saveClient(event) {
      event.preventDefault();
      const mode = document.getElementById('formMode').value;
      const currentId = document.getElementById('currentClientId').value;
      const payload = getFormPayload();
      const url = mode === 'edit' ? `/api/clients/${encodeURIComponent(currentId)}` : '/api/clients';
      setButtonLoading(saveBtn, true, translate(mode === 'edit' ? 'apps.editor.saving_update' : 'apps.editor.saving_create'));
      try {
        const { response, payload: result } = await request(url, {
          method: mode === 'edit' ? 'PUT' : 'POST',
          body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(i18n.resolveMessage(result, 'apps.editor.save_failed'));
        setEditorMode('edit', result.client);
        if (result.clientSecret) document.getElementById('clientSecret').value = result.clientSecret;
        setStatus(formStatus, 'success', result.clientSecret ? translate('apps.editor.secret_notice', { secret: result.clientSecret }) : translate(mode === 'edit' ? 'apps.editor.update_success' : 'apps.editor.create_success'));
        await loadClients();
      } catch (error) {
        setStatus(formStatus, 'error', error.message);
      } finally {
        setButtonLoading(saveBtn, false);
      }
    }

    async function deleteClient(client, button) {
      if (pendingDeleteClientId !== client.id) {
        clearPendingDelete();
        pendingDeleteClientId = client.id;
        button.textContent = translate('common.action.confirm_delete');
        button.className = 'rounded-lg border border-red-300 bg-red-600 px-3 py-2 text-xs font-bold text-white hover:bg-red-700';
        setStatus(statusBar, 'info', translate('apps.status.delete_hint', { name: client.name || client.id }));
        pendingDeleteTimer = setTimeout(clearPendingDelete, 5000);
        return;
      }

      clearPendingDelete();
      setButtonLoading(button, true, translate('apps.editor.deleting'));
      try {
        const { response, payload } = await request(`/api/clients/${encodeURIComponent(client.id)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(i18n.resolveMessage(payload, 'apps.editor.delete_failed'));
        if (document.getElementById('currentClientId').value === client.id) setEditorMode('create');
        await loadClients();
        setStatus(statusBar, 'success', translate('apps.editor.delete_success'));
      } catch (error) {
        setStatus(statusBar, 'error', error.message);
      } finally {
        setButtonLoading(button, false);
      }
    }

    searchInput.addEventListener('input', applySearch);
    refreshBtn.addEventListener('click', loadClients);
    clientForm.addEventListener('submit', saveClient);
    document.getElementById('resetFormBtn').addEventListener('click', () => setEditorMode('create'));
    document.getElementById('cancelBtn').addEventListener('click', () => setEditorMode('create'));
    document.getElementById('generateSecretBtn').addEventListener('click', () => {
      document.getElementById('clientSecret').value = generateSecret();
    });
    document.addEventListener('vaultsso:languagechange', () => {
      document.title = translate('apps.page.title');
      clearPendingDelete();
      setEditorMode(document.getElementById('formMode').value, allClients.find(client => client.id === document.getElementById('currentClientId').value) || null);
      applySearch();
    });

    i18n.bindLanguageButtons(document);
    document.title = translate('apps.page.title');
    setEditorMode('create');
    loadClients();
