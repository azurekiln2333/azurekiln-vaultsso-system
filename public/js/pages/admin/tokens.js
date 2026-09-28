const i18n = window.VaultI18n;
    const statusBar = document.getElementById('statusBar');
    const searchInput = document.getElementById('searchInput');
    const refreshBtn = document.getElementById('refreshBtn');
    const tokenTableBody = document.getElementById('tokenTableBody');

    let allTokens = [];
    let pendingRevokeTokenId = '';
    let pendingRevokeTimer = null;

    function translate(key, variables = {}) {
      return i18n.t(key, variables);
    }

    function setStatus(kind, message) {
      const classes = {
        error: 'border-red-200 bg-red-50 text-red-700',
        success: 'border-green-200 bg-green-50 text-green-700',
        info: 'border-blue-200 bg-blue-50 text-blue-700'
      };
      statusBar.className = `mb-6 rounded-lg border px-4 py-3 text-sm shadow-sm ${classes[kind] || classes.info}`;
      statusBar.textContent = message;
    }

    function setButtonLoading(button, isLoading, label) {
      if (!button) return;
      if (!button.dataset.originalLabel) {
        button.dataset.originalLabel = button.innerHTML;
      }

      button.disabled = isLoading;
      button.classList.toggle('opacity-70', isLoading);
      button.classList.toggle('cursor-wait', isLoading);
      button.innerHTML = isLoading
        ? `<span class="material-symbols-outlined animate-spin text-lg">progress_activity</span><span>${label || translate('common.loading')}</span>`
        : button.dataset.originalLabel;
    }

    function clearPendingRevoke() {
      pendingRevokeTokenId = '';
      if (pendingRevokeTimer) {
        clearTimeout(pendingRevokeTimer);
        pendingRevokeTimer = null;
      }
      document.querySelectorAll('[data-revoke]').forEach(button => {
        button.textContent = translate('tokens.action.revoke');
        button.className = 'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-100';
      });
    }

    function formatDate(value) {
      if (!value) return translate('common.not_recorded');
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return translate('common.not_recorded');
      return date.toLocaleString(i18n.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
    }

    function resolveTokenState(token) {
      const expiresAt = new Date(token.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        return { key: 'unknown', className: 'bg-slate-100 text-slate-600' };
      }

      const diff = expiresAt.getTime() - Date.now();
      if (diff <= 0) {
        return { key: 'expired', className: 'bg-slate-100 text-slate-600' };
      }

      if (diff <= 24 * 60 * 60 * 1000) {
        return { key: 'expiring', className: 'bg-amber-50 text-amber-700' };
      }

      return { key: 'active', className: 'bg-green-50 text-green-700' };
    }

    function searchText(token) {
      return [
        token.id,
        token.client,
        token.clientId,
        token.user,
        token.userEmail,
        ...(token.scopes || [])
      ].join(' ').toLowerCase();
    }

    function renderStats(tokens) {
      let active = 0;
      let expiring = 0;
      let expired = 0;

      tokens.forEach(token => {
        const state = resolveTokenState(token);
        if (state.key === 'active') active += 1;
        if (state.key === 'expiring') expiring += 1;
        if (state.key === 'expired') expired += 1;
      });

      document.getElementById('statsTotal').textContent = String(tokens.length);
      document.getElementById('statsActive').textContent = String(active);
      document.getElementById('statsExpiring').textContent = String(expiring);
      document.getElementById('statsExpired').textContent = String(expired);
    }

    function renderTokens(tokens) {
      tokenTableBody.innerHTML = '';
      if (!tokens.length) {
        tokenTableBody.innerHTML = `<tr><td class="px-5 py-10 text-center text-muted" colspan="8">${escapeHtml(translate('tokens.table.empty'))}</td></tr>`;
        return;
      }

      tokens.forEach(token => {
        const state = resolveTokenState(token);
        const scopes = Array.isArray(token.scopes) ? token.scopes : [];
        const row = document.createElement('tr');
        row.className = 'border-b border-line/50 align-top';
        row.innerHTML = `
          <td class="px-5 py-4">
            <div class="font-semibold text-ink">${escapeHtml(token.client || translate('common.unknown'))}</div>
            <div class="mt-1 break-all text-xs text-muted">${escapeHtml(token.clientId || translate('tokens.value.no_client'))}</div>
          </td>
          <td class="px-5 py-4">
            <div class="font-semibold text-ink">${escapeHtml(token.user || translate('common.unknown'))}</div>
            <div class="mt-1 break-all text-xs text-muted">${escapeHtml(token.userEmail || translate('tokens.value.no_email'))}</div>
          </td>
          <td class="px-5 py-4">
            <div class="flex flex-wrap gap-1">
              ${scopes.length
                ? scopes.map(scope => `<span class="rounded-lg bg-primary-soft px-2 py-1 text-[11px] font-bold text-primary">${escapeHtml(scope)}</span>`).join('')
                : `<span class="text-xs text-muted">${escapeHtml(translate('tokens.value.no_scopes'))}</span>`}
            </div>
          </td>
          <td class="px-5 py-4 text-muted">${formatDate(token.createdAt)}</td>
          <td class="px-5 py-4 text-muted">${formatDate(token.expiresAt)}</td>
          <td class="px-5 py-4">
            <span class="rounded-lg px-3 py-1 text-[11px] font-bold uppercase tracking-widest ${state.className}">${escapeHtml(translate(`tokens.state.${state.key}`))}</span>
          </td>
          <td class="px-5 py-4"><code class="break-all text-xs text-muted">${escapeHtml(token.id || '')}</code></td>
          <td class="px-5 py-4 text-right">
            <button class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-100" data-revoke="${escapeHtml(token.id || '')}" type="button">${escapeHtml(translate('tokens.action.revoke'))}</button>
          </td>
        `;
        tokenTableBody.appendChild(row);
      });

      tokenTableBody.querySelectorAll('[data-revoke]').forEach(button => {
        button.addEventListener('click', event => revokeToken(button.dataset.revoke, event.currentTarget));
      });
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function applySearch() {
      const keyword = searchInput.value.trim().toLowerCase();
      const filtered = keyword ? allTokens.filter(token => searchText(token).includes(keyword)) : allTokens;
      renderTokens(filtered);
      setStatus('info', keyword
        ? translate('tokens.status.filtered', { count: filtered.length })
        : translate('tokens.status.loaded', { count: allTokens.length }));
    }

    async function loadTokens() {
      setButtonLoading(refreshBtn, true, translate('common.loading'));
      setStatus('info', translate('tokens.status.loading'));
      try {
        const response = await fetch('/api/tokens', { credentials: 'same-origin' });
        if (response.status === 401) {
          window.location.href = '/oauth2/authorize';
          return;
        }
        if (response.status === 403) {
          window.location.href = '/oauth2/error?error=access_denied';
          return;
        }

        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error_description || translate('tokens.status.load_failed'));

        allTokens = Array.isArray(payload) ? payload : [];
        renderStats(allTokens);
        applySearch();
      } catch (error) {
        allTokens = [];
        renderStats(allTokens);
        renderTokens([]);
        setStatus('error', error.message);
      } finally {
        setButtonLoading(refreshBtn, false);
      }
    }

    async function revokeToken(tokenId, button) {
      if (!tokenId) return;

      if (pendingRevokeTokenId !== tokenId) {
        clearPendingRevoke();
        pendingRevokeTokenId = tokenId;
        button.textContent = translate('tokens.action.confirm_revoke');
        button.className = 'rounded-lg border border-red-300 bg-red-600 px-3 py-2 text-xs font-bold text-white hover:bg-red-700';
        setStatus('info', translate('tokens.action.confirm_hint'));
        pendingRevokeTimer = setTimeout(clearPendingRevoke, 5000);
        return;
      }

      clearPendingRevoke();
      setButtonLoading(button, true, translate('tokens.action.revoking'));
      try {
        const response = await fetch(`/api/tokens/${encodeURIComponent(tokenId)}`, {
          method: 'DELETE',
          credentials: 'same-origin'
        });
        const payload = response.status === 204 ? null : await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error_description || translate('tokens.status.revoke_failed'));
        await loadTokens();
        setStatus('success', translate('tokens.status.revoked'));
      } catch (error) {
        setStatus('error', error.message);
      } finally {
        setButtonLoading(button, false);
      }
    }

    function renderDocument() {
      i18n.apply(document);
      document.title = translate('tokens.page.title');
    }

    i18n.bindLanguageButtons(document);
    renderDocument();
    searchInput.addEventListener('input', applySearch);
    refreshBtn.addEventListener('click', loadTokens);
    loadTokens();

    document.addEventListener('vaultsso:languagechange', () => {
      renderDocument();
      renderStats(allTokens);
      applySearch();
    });
