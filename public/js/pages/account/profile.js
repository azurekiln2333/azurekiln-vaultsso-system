const i18n = window.VaultI18n;
    let currentUser = null;
    let currentApplications = [];
    let currentAppBindings = null;
    let applicationsRequestVersion = 0;
    let applicationsLoading = false;
    let applicationsError = '';
    let statusTimer = null;
    let passwordMinLength = null;

    function renderPasswordGuidance() {
      const hint = i18n.passwordGuidance(passwordMinLength);
      document.getElementById('newPasswordInput').placeholder = hint;
      document.getElementById('profilePasswordHint').textContent = hint;
    }

    async function loadPasswordGuidance() {
      passwordMinLength = null;
      renderPasswordGuidance();
      try {
        const response = await fetch('/api/auth/config');
        if (response.ok) passwordMinLength = (await response.json()).passwordMinLength;
      } catch (error) {
        console.error('Load password guidance failed:', error);
      }
      renderPasswordGuidance();
    }

    function buildAvatarDataUri(name) {
      const safeName = (name || 'U').trim();
      const initial = safeName.charAt(0).toUpperCase() || 'U';
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="88" height="88" viewBox="0 0 88 88">
          <defs>
            <linearGradient id="avatarGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#003d9b" />
              <stop offset="100%" stop-color="#0b57d0" />
            </linearGradient>
          </defs>
          <rect width="88" height="88" rx="18" fill="url(#avatarGradient)" />
          <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-size="34" font-family="Segoe UI, Arial, sans-serif" font-weight="700">${initial}</text>
        </svg>
      `;

      return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }

    function formatDate(value) {
      if (!value) {
        return i18n.t('profile.meta.date_missing');
      }

      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return i18n.t('profile.meta.date_missing');
      }

      const locale = i18n.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';
      return date.toLocaleString(locale, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }

    function setAvatar(url, name) {
      ['avatarPreview', 'navAvatarPreview'].forEach(id => {
        const avatar = document.getElementById(id);
        avatar.onerror = function () {
          avatar.onerror = null;
          avatar.src = buildAvatarDataUri(name);
        };
        avatar.src = url || buildAvatarDataUri(name);
      });
    }

    function toggleAdminLinks(isAdmin) {
      document.getElementById('adminCenterLink').style.display = isAdmin ? '' : 'none';
    }

    function setStatus(kind, message) {
      const element = document.getElementById('statusMessage');
      window.clearTimeout(statusTimer);
      if (!kind || !message) {
        element.className = 'status';
        element.textContent = '';
        return;
      }

      element.className = `status show ${kind}`;
      element.textContent = message;
      if (kind === 'success') {
        statusTimer = window.setTimeout(() => {
          element.className = 'status';
          element.textContent = '';
        }, 6000);
      }
    }

    function closeModal(modalId) {
      if (!window.ProfileTotp.canCloseModal(modalId)) return false;
      const modal = document.getElementById(modalId);
      if (modal) {
        modal.classList.remove('show');
      }
      window.ProfileTotp.onModalClosed(modalId);
      if (modalId === 'phoneSmsModal') resetPhoneSmsChallenge();
      return true;
    }

    function openModal(modalId) {
      if (!closeAllModals()) return;
      const modal = document.getElementById(modalId);
      if (modal) {
        modal.classList.add('show');
        const firstInput = modal.querySelector('input');
        if (firstInput) {
          window.setTimeout(() => firstInput.focus(), 20);
        }
      }
    }

    function closeAllModals() {
      let closed = true;
      document.querySelectorAll('[data-modal-backdrop]').forEach(modal => {
        if (modal.classList.contains('show') && !closeModal(modal.id)) closed = false;
      });
      return closed;
    }

    function syncUserToPage(user) {
      const previousUserId = currentUser && currentUser.id;
      const previousPhone = currentUser && currentUser.phoneE164;
      if (previousUserId !== (user && user.id) || previousPhone !== (user && user.phoneE164)) {
        resetPhoneSmsChallenge();
        clearPhoneSmsCooldown();
      }
      currentUser = user;
      toggleAdminLinks(Boolean(user.isAdmin));

      document.getElementById('profileName').textContent = user.name || user.username;
      document.getElementById('profileMeta').textContent = user.email || user.username;
      document.getElementById('profileHeroDescription').textContent = user.description || '';
      setAvatar(user.avatar, user.name || user.username);

      document.getElementById('emailVerifiedBadge').textContent = user.emailVerified
        ? i18n.t('profile.meta.email_verified')
        : i18n.t('profile.meta.email_unverified');
      document.getElementById('emailVerifiedBadge').className = user.emailVerified ? 'chip' : 'chip muted';

      document.getElementById('displayNameValue').textContent = user.name || '-';
      document.getElementById('descriptionValue').textContent = user.description || '-';
      document.getElementById('usernameValue').textContent = user.username || '-';
      document.getElementById('emailValue').textContent = user.email || '-';
      document.getElementById('passwordValue').textContent = i18n.t('profile.value.password_masked');
      document.getElementById('userIdValue').textContent = user.id || '-';
      document.getElementById('createdAtValue').textContent = formatDate(user.createdAt);
      document.getElementById('updatedAtValue').textContent = formatDate(user.updatedAt);
      document.getElementById('creditsValue').textContent = String(user.credits ?? 0);
      document.getElementById('lastLoginIpValue').textContent = user.lastLoginIp || '-';
      renderPhone(user);
      if (typeof applyPhoneSmsVisibility === 'function') applyPhoneSmsVisibility();
      renderIdentities(currentAppBindings || user.identities || []);
      renderTotpStatus(user);

      document.getElementById('profileNameInput').value = user.name || '';
      document.getElementById('profileDescriptionInput').value = user.description || '';
      document.getElementById('profileEmailInput').value = user.email || '';
    }

    function renderPhone(user) {
      const value = document.getElementById('phoneValue');
      const chip = document.getElementById('phoneVerifiedChip');
      const countryHint = document.getElementById('phoneCountryHint');
      const bindHint = document.getElementById('phoneBindHint');

      const masked = user.phoneMasked || '';
      if (!masked) {
        value.textContent = i18n.t('profile.phone.unbound');
        value.className = 'is-empty';
        chip.textContent = '';
        chip.className = 'profile-phone-chip hidden';
        countryHint.textContent = '';
        countryHint.classList.add('hidden');
        bindHint.classList.remove('hidden');
        return;
      }

      value.textContent = masked;
      value.className = '';
      chip.textContent = user.phoneVerified ? i18n.t('profile.phone.verified') : i18n.t('profile.phone.unverified');
      chip.className = user.phoneVerified
        ? 'profile-phone-chip is-verified'
        : 'profile-phone-chip';

      if (user.phoneCountryCode) {
        countryHint.textContent = `${i18n.t('profile.phone.country_code')}: +${user.phoneCountryCode}`;
        countryHint.classList.remove('hidden');
      } else {
        countryHint.textContent = '';
        countryHint.classList.add('hidden');
      }
      bindHint.classList.add('hidden');
    }

    function renderIdentities(identities) {
      const list = document.getElementById('identityList');
      if (!identities.length) {
        list.innerHTML = `<p class="text-sm text-muted">${escapeHtml(i18n.t('profile.identity.none'))}</p>`;
        return;
      }
      list.innerHTML = identities.map(identity => {
        const profile = identity.profile || {};
        const huawei = identity.providerType === 'huawei_quicklogin' || profile.provider === 'huawei_quicklogin';
        const openId = huawei
          ? identity.openId || profile.openID || identity.providerSecondaryId || (!profile.unionID ? identity.providerUserId : '')
          : identity.providerUserId;
        const unionId = huawei
          ? identity.unionId || profile.unionID || (identity.providerSecondaryId ? identity.providerUserId : '')
          : identity.providerSecondaryId;
        const details = [`${i18n.t('profile.identity.open_id')}: ${openId || '-'}`];
        if (unionId) {
          details.push(`${i18n.t('profile.identity.union_id')}: ${unionId}`);
        }
        const clientId = identity.clientId || profile.clientId;
        const scope = identity.huaweiUnionScope || profile.huaweiUnionScope;
        if (clientId) details.push(`App ID: ${clientId}`);
        if (scope) details.push(`${i18n.t('profile.apps.subject')}: ${scope}`);
        return `<div class="profile-identity-item"><div class="profile-identity-top"><div><strong>${escapeHtml(identity.providerName || profile.providerName || identity.provider)}</strong><p>${escapeHtml(identity.provider)}</p></div><button data-unbind-id="${escapeHtml(identity.id)}" type="button">${escapeHtml(i18n.t('profile.apps.unbind'))}</button></div><div class="profile-identity-details">${details.map(detail => escapeHtml(detail)).join('<br>')}</div></div>`;
      }).join('');
      list.querySelectorAll('[data-unbind-id]').forEach(button => button.addEventListener('click', () => unbindIdentity(button.dataset.unbindId)));
    }

    function renderApplications() {
      const status = document.getElementById('applicationsStatus');
      status.className = applicationsError ? 'profile-list-status profile-list-error' : 'profile-list-status';
      status.textContent = applicationsLoading ? i18n.t('common.loading') : applicationsError || (currentApplications.length ? '' : i18n.t('profile.apps.empty'));
      document.getElementById('applicationsCount').textContent = String(currentApplications.length);
      document.getElementById('applicationsList').innerHTML = currentApplications.map(app => `<article class="profile-app-item" data-client-id="${escapeHtml(app.clientId)}">
        <div class="profile-app-head"><span class="profile-app-icon" aria-hidden="true">${escapeHtml((app.name || app.clientId || '?').slice(0, 2).toUpperCase())}</span><div><h3>${escapeHtml(app.name || app.clientId)}</h3><p>${escapeHtml(app.clientId)}</p></div><span class="profile-app-status${app.configured && app.enabled ? '' : ' is-off'}">${escapeHtml(i18n.t(!app.configured ? 'profile.apps.removed' : app.enabled ? 'profile.apps.enabled' : 'profile.apps.disabled'))}</span></div>
        <dl class="profile-app-dates"><div><dt>${escapeHtml(i18n.t('profile.apps.first'))}</dt><dd>${escapeHtml(formatDate(app.firstUsedAt))}</dd></div><div><dt>${escapeHtml(i18n.t('profile.apps.last'))}</dt><dd>${escapeHtml(formatDate(app.lastUsedAt))}</dd></div></dl>
      </article>`).join('');
    }

    async function loadApplications() {
      const button = document.getElementById('applicationsRefresh');
      const requestVersion = ++applicationsRequestVersion;
      applicationsLoading = true;
      applicationsError = '';
      button.disabled = true;
      renderApplications();
      try {
        const response = await fetch('/api/account/applications', { credentials: 'same-origin' });
        const payload = await response.json();
        if (requestVersion !== applicationsRequestVersion) return;
        if (!response.ok) throw new Error(i18n.resolveMessage(payload, 'common.request_error'));
        currentApplications = payload.applications || [];
        currentAppBindings = payload.bindings || [];
        renderIdentities(currentAppBindings);
      } catch (error) {
        if (requestVersion !== applicationsRequestVersion) return;
        applicationsError = error.message || i18n.t('common.network_error');
      } finally {
        if (requestVersion === applicationsRequestVersion) {
          applicationsLoading = false;
          button.disabled = false;
          renderApplications();
        }
      }
    }

    document.getElementById('applicationsRefresh').addEventListener('click', loadApplications);

    function renderTotpStatus(user) {
      window.ProfileTotp.renderStatus(user);
    }

    function refreshTotpState() {
      return window.ProfileTotp.refresh();
    }

    // ---- 登录设备 ----
    function renderSessions(sessions) {
      const list = document.getElementById('sessionList');
      if (!sessions.length) {
        list.innerHTML = '<p class="profile-list-status">当前没有活跃会话。</p>';
        return;
      }
      list.innerHTML = sessions.map(session => {
        const time = new Date(session.createdAt);
        const timeText = Number.isNaN(time.getTime()) ? '-' : time.toLocaleString(i18n.getLanguage() === 'zh' ? 'zh-CN' : 'en-US');
        const device = escapeHtml((session.userAgent || '').split(')')[0] ? (session.userAgent || '').split(')')[0] + ')' : '未知设备');
        return `<div class="profile-session-item"><span class="profile-session-icon material-symbols-outlined" aria-hidden="true">${/mobile|android|iphone/i.test(session.userAgent || '') ? 'smartphone' : 'desktop_windows'}</span>
          <div class="profile-session-copy"><strong>${device}${session.current ? `<span class="profile-current-chip">${escapeHtml(i18n.t('profile.sessions.current'))}</span>` : ''}</strong><p>${escapeHtml(session.ip || '-')} · ${escapeHtml(timeText)}</p></div>
          ${session.current ? '' : `<button data-revoke-session="${escapeHtml(session.id)}" type="button">${escapeHtml(i18n.t('profile.sessions.revoke'))}</button>`}
        </div>`;
      }).join('');
      list.querySelectorAll('[data-revoke-session]').forEach(button => button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const response = await fetch(`/api/account/sessions/${encodeURIComponent(button.dataset.revokeSession)}`, { method: 'DELETE', credentials: 'same-origin' });
          if (!response.ok && response.status !== 204) throw new Error(i18n.t('common.network_error'));
          await loadSessions();
        } catch (error) { setStatus('error', error.message); button.disabled = false; }
      }));
    }

    async function loadSessions() {
      try {
        const response = await fetch('/api/account/sessions', { credentials: 'same-origin' });
        if (response.status === 401) return;
        renderSessions(await response.json());
      } catch (error) { /* ignore */ }
    }

    document.getElementById('revokeOthersBtn').addEventListener('click', async function () {
      this.disabled = true;
      try {
        const response = await fetch('/api/account/sessions/revoke-others', { method: 'POST', credentials: 'same-origin' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error_description || i18n.t('common.network_error'));
        setStatus('success', i18n.resolveMessage(payload, 'sessions.revoked_others'));
        await loadSessions();
      } catch (error) { setStatus('error', error.message); }
      finally { this.disabled = false; }
    });

    async function loadIdentityProviders() {
      const container = document.getElementById('bindIdentityButtons');
      try {
        const response = await fetch('/api/v1/auth/oauth/oidc/config', { credentials: 'same-origin' });
        const payload = await response.json();
        const providers = Array.isArray(payload.providers) ? payload.providers : [];
        container.innerHTML = providers.length
          ? providers.map(provider => {
            const linkUrl = new URL(provider.loginUrl, window.location.origin);
            const mergeUrl = new URL(linkUrl);
            linkUrl.searchParams.set('intent', 'link');
            linkUrl.searchParams.set('return_to', '/profile');
            mergeUrl.searchParams.set('intent', 'merge');
            mergeUrl.searchParams.set('return_to', '/profile');
            const label = provider.providerName || provider.key;
            return `<div class="flex flex-wrap gap-2"><a class="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-white px-4 py-3 text-sm font-bold text-muted hover:text-primary transition-colors" href="${escapeHtml(linkUrl.href)}">${escapeHtml(i18n.t('profile.identity.link_provider', { provider: label }))}</a><a class="inline-flex items-center justify-center gap-2 rounded-lg border border-line bg-white px-4 py-3 text-sm font-bold text-muted hover:text-primary transition-colors" data-merge-identity href="${escapeHtml(mergeUrl.href)}">${escapeHtml(i18n.t('profile.identity.merge_provider', { provider: label }))}</a></div>`;
          }).join('')
          : `<span class="text-sm text-muted">${escapeHtml(i18n.t('profile.identity.no_providers'))}</span>`;
        container.querySelectorAll('[data-merge-identity]').forEach(link => link.addEventListener('click', event => {
          if (!window.confirm(i18n.t('profile.identity.merge_confirm'))) event.preventDefault();
        }));
      } catch (error) {
        container.innerHTML = `<span class="text-sm text-muted">${escapeHtml(i18n.t('profile.identity.providers_failed'))}</span>`;
      }
    }

    function escapeHtml(value) {
      return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    async function unbindIdentity(id) {
      if (!window.confirm('确定解除这个第三方账号绑定吗？')) return;
      const response = await fetch(`/api/account/identities/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setStatus('error', payload.error_description || '解除绑定失败');
        return;
      }
      ++applicationsRequestVersion;
      currentAppBindings = (currentAppBindings || currentUser?.identities || []).filter(identity => identity.id !== id);
      renderIdentities(currentAppBindings);
      await loadProfile();
      await loadApplications();
      setStatus('success', '第三方账号绑定已解除');
    }

    function renderDocument() {
      i18n.apply(document);
      renderPasswordGuidance();
      document.title = i18n.t('profile.page.title');

      if (currentUser) {
        syncUserToPage(currentUser);
      }
      renderApplications();
      document.getElementById('applicationsRefresh').setAttribute('aria-label', i18n.t('profile.apps.refresh'));
    }

    async function loadProfile() {
      const loadingState = document.getElementById('loadingState');
      const profileContent = document.getElementById('profileContent');

      try {
        const response = await fetch('/api/profile', {
          credentials: 'same-origin'
        });

        if (response.status === 401) {
          window.location.href = '/oauth2/authorize';
          return;
        }

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(i18n.resolveMessage(payload, 'server.internal'));
        }

        syncUserToPage(payload.user);
        profileContent.classList.remove('hidden');
      } catch (error) {
        console.error('Load profile failed:', error);
        setStatus('error', error.message || i18n.t('common.network_error'));
      } finally {
        loadingState.classList.add('hidden');
      }
    }

    async function saveProfile(payload, submitButton, loadingKey, successKey) {
      const originalLabel = submitButton.textContent;
      submitButton.disabled = true;
      submitButton.textContent = i18n.t(loadingKey);
      setStatus('', '');

      try {
        const response = await fetch('/api/profile', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'same-origin',
          body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (response.status === 401) {
          window.location.href = '/oauth2/authorize';
          return false;
        }

        if (!response.ok) {
          throw new Error(i18n.resolveMessage(result, 'server.internal'));
        }

        syncUserToPage(result.user);
        setStatus('success', i18n.resolveMessage(result, successKey));
        return true;
      } catch (error) {
        console.error('Save profile failed:', error);
        setStatus('error', error.message || i18n.t('common.network_error'));
        return false;
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    }

    document.getElementById('editProfileBtn').addEventListener('click', function () {
      openModal('profileModal');
    });

    document.getElementById('avatarEditBtn').addEventListener('click', function () {
      openModal('profileModal');
    });

    document.getElementById('editEmailBtn').addEventListener('click', function () {
      openModal('emailModal');
    });

    // Whether the server has an SMS channel that is enabled AND fully configured.
    // The verification row stays hidden until capabilities say it is actually usable,
    // so a disabled or incomplete channel makes zero upstream calls.
    let phoneSmsAvailable = false;

    function applyPhoneSmsVisibility() {
      const row = document.getElementById('phoneSmsVerifyRow');
      if (!row) return;
      const show = phoneSmsAvailable && Boolean(currentUser && currentUser.phoneE164);
      row.hidden = !show;
    }

    async function loadPhoneCapabilities() {
      try {
        const response = await fetch('/api/auth/phone/config', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) {
          phoneSmsAvailable = false;
          applyPhoneSmsVisibility();
          return;
        }
        const config = await response.json();
        phoneSmsAvailable = Boolean(config && config.sms && config.sms.available);
      } catch (error) {
        console.error('Load phone capabilities failed:', error);
        phoneSmsAvailable = false;
      }
      applyPhoneSmsVisibility();
    }

    // Authenticated SMS verification of the phone already bound to this account.
    // The challenge is issued for the currently displayed saved number and is
    // discarded whenever the binding changes, the modal closes, or the page reloads.
    let phoneSmsChallengeId = '';
    let phoneSmsChallengePhone = '';
    let phoneSmsRequestGeneration = 0;
    let phoneSmsRemaining = 0;
    let phoneSmsCooldownTimer = null;

    async function requestPhoneSms(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload || {})
      });
      const result = response.status === 204 ? {} : await response.json().catch(function () { return {}; });
      if (response.status === 401) {
        window.location.href = '/oauth2/authorize';
        throw new Error(i18n.t('common.network_error'));
      }
      if (!response.ok) throw new Error(i18n.resolveMessage(result, 'common.network_error'));
      return result;
    }

    function currentPhoneIdentity() {
      return currentUser && currentUser.phoneE164 ? currentUser.phoneE164 : '';
    }

    function resetPhoneSmsChallenge() {
      phoneSmsRequestGeneration += 1;
      phoneSmsChallengeId = '';
      phoneSmsChallengePhone = '';
    }

    function clearPhoneSmsCooldown() {
      if (phoneSmsCooldownTimer) clearInterval(phoneSmsCooldownTimer);
      phoneSmsCooldownTimer = null;
      phoneSmsRemaining = 0;
      renderPhoneSmsCooldown();
    }

    async function sendProfilePhoneCode() {
      const phone = currentPhoneIdentity();
      if (!phone) throw new Error(i18n.t('profile.phone.sms_no_phone'));
      const userId = currentUser && currentUser.id;
      const generation = phoneSmsRequestGeneration;
      const result = await requestPhoneSms('/api/profile/phone/sms/send', {});
      if (generation !== phoneSmsRequestGeneration || phone !== currentPhoneIdentity() || userId !== (currentUser && currentUser.id)) return null;
      phoneSmsChallengeId = result.challengeId || '';
      phoneSmsChallengePhone = phone;
      startPhoneSmsCooldown(result.retryAfter || 60);
      return result;
    }

    document.getElementById('phoneSmsVerifyStartBtn').addEventListener('click', async function () {
      if (!currentUser || !currentUser.phoneE164) {
        setStatus('error', i18n.t('profile.phone.sms_no_phone'));
        return;
      }
      const button = document.getElementById('phoneSmsVerifyStartBtn');
      button.disabled = true;
      const originalLabel = button.textContent;
      try {
        const sent = await sendProfilePhoneCode();
        if (!sent) return;
        document.getElementById('phoneSmsError').classList.add('hidden');
        document.getElementById('phoneSmsCode').value = '';
        openModal('phoneSmsModal');
        setStatus('success', i18n.t('auth.status.code_sent'));
      } catch (error) {
        setStatus('error', error.message || i18n.t('common.network_error'));
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
        renderPhoneSmsCooldown();
      }
    });

    function renderPhoneSmsCooldown() {
      ['phoneSmsResendBtn', 'phoneSmsVerifyStartBtn'].forEach(function (id) {
        const element = document.getElementById(id);
        if (!element) return;
        if (phoneSmsRemaining > 0) {
          element.disabled = true;
          element.textContent = i18n.t('profile.phone.sms_resend_in', { seconds: phoneSmsRemaining });
        } else {
          element.disabled = false;
          element.textContent = i18n.t('profile.phone.sms_send');
        }
      });
    }
    function startPhoneSmsCooldown(seconds) {
      if (phoneSmsCooldownTimer) clearInterval(phoneSmsCooldownTimer);
      phoneSmsRemaining = Math.max(0, Number(seconds) || 0);
      renderPhoneSmsCooldown();
      if (!phoneSmsRemaining) return;
      phoneSmsCooldownTimer = setInterval(function () {
        phoneSmsRemaining = Math.max(0, phoneSmsRemaining - 1);
        if (!phoneSmsRemaining) {
          clearInterval(phoneSmsCooldownTimer);
          phoneSmsCooldownTimer = null;
        }
        renderPhoneSmsCooldown();
      }, 1000);
    }

    document.getElementById('phoneSmsResendBtn').addEventListener('click', async function () {
      if (phoneSmsRemaining > 0) return;
      const button = document.getElementById('phoneSmsResendBtn');
      button.disabled = true;
      try {
        const sent = await sendProfilePhoneCode();
        if (!sent) return;
        document.getElementById('phoneSmsError').classList.add('hidden');
        document.getElementById('phoneSmsCode').value = '';
        document.getElementById('phoneSmsCode').focus();
      } catch (error) {
        const errorNode = document.getElementById('phoneSmsError');
        errorNode.textContent = error.message || i18n.t('common.network_error');
        errorNode.classList.remove('hidden');
      } finally {
        renderPhoneSmsCooldown();
      }
    });

    document.getElementById('phoneSmsVerifyForm').addEventListener('submit', async function (event) {
      event.preventDefault();
      const submitButton = document.getElementById('phoneSmsVerifySubmit');
      if (submitButton.disabled) return;
      const errorNode = document.getElementById('phoneSmsError');
      errorNode.classList.add('hidden');
      const code = String(document.getElementById('phoneSmsCode').value || '').trim();
      if (!/^\d{6}$/.test(code)) {
        errorNode.textContent = i18n.t('profile.phone.sms_code_placeholder');
        errorNode.classList.remove('hidden');
        return;
      }
      if (!phoneSmsChallengeId || phoneSmsChallengePhone !== currentPhoneIdentity()) {
        errorNode.textContent = i18n.t('auth.phone.expired');
        errorNode.classList.remove('hidden');
        resetPhoneSmsChallenge();
        return;
      }
      submitButton.disabled = true;
      const originalLabel = submitButton.textContent;
      submitButton.textContent = i18n.t('auth.phone.sms_verifying');
      const generation = phoneSmsRequestGeneration;
      const challengeId = phoneSmsChallengeId;
      const challengePhone = phoneSmsChallengePhone;
      const userId = currentUser && currentUser.id;
      try {
        const result = await requestPhoneSms('/api/profile/phone/sms/verify', {
          challengeId,
          code
        });
        const modal = document.getElementById('phoneSmsModal');
        if (generation !== phoneSmsRequestGeneration
            || challengePhone !== currentPhoneIdentity()
            || userId !== (currentUser && currentUser.id)
            || !modal.classList.contains('show')) return;
        resetPhoneSmsChallenge();
        document.getElementById('phoneSmsCode').value = '';
        closeModal('phoneSmsModal');
        if (result && result.user) syncUserToPage(result.user);
        else { await loadProfile(); }
        setStatus('success', i18n.t('profile.phone.sms_verified'));
      } catch (error) {
        const modal = document.getElementById('phoneSmsModal');
        if (generation !== phoneSmsRequestGeneration
            || challengePhone !== currentPhoneIdentity()
            || userId !== (currentUser && currentUser.id)
            || !modal.classList.contains('show')) return;
        errorNode.textContent = error.message || i18n.t('common.network_error');
        errorNode.classList.remove('hidden');
        document.getElementById('phoneSmsCode').value = '';
        document.getElementById('phoneSmsCode').focus();
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    });

    document.getElementById('editPhoneBtn').addEventListener('click', function () {
      if (!currentUser) return;
      resetPhoneSmsChallenge();
      document.getElementById('profilePhoneCountryInput').value = `+${currentUser.phoneCountryCode || '86'}`;
      document.getElementById('profilePhoneInput').value = currentUser.phoneNationalNumber || '';
      document.getElementById('phoneCurrentPassword').value = '';
      document.getElementById('phoneUnbindBtn').hidden = !currentUser.phoneE164;
      document.getElementById('phoneModalError').classList.add('hidden');
      openModal('phoneModal');
    });

    document.getElementById('phoneUnbindBtn').addEventListener('click', function () {
      if (!window.confirm(i18n.t('profile.phone.unbind_confirm'))) return;
      document.getElementById('profilePhoneInput').value = '';
      document.getElementById('phoneEditForm').requestSubmit();
    });

    document.getElementById('phoneEditForm').addEventListener('submit', async function (event) {
      event.preventDefault();
      resetPhoneSmsChallenge();
      const unbindButton = document.getElementById('phoneUnbindBtn');
      if (unbindButton.disabled) return;
      unbindButton.disabled = true;
      const error = document.getElementById('phoneModalError');
      error.classList.add('hidden');
      const updated = await saveProfile({
        phoneCountryCode: document.getElementById('profilePhoneCountryInput').value.trim(),
        phoneNumber: document.getElementById('profilePhoneInput').value.trim(),
        currentPassword: document.getElementById('phoneCurrentPassword').value
      }, document.getElementById('phoneModalSubmit'), 'profile.status.saving', 'profile.updated');
      unbindButton.disabled = false;
      if (updated) {
        document.getElementById('phoneCurrentPassword').value = '';
        resetPhoneSmsChallenge();
        closeModal('phoneModal');
      } else {
        error.textContent = document.getElementById('statusMessage').textContent;
        error.classList.remove('hidden');
      }
    });

    document.getElementById('editPasswordBtn').addEventListener('click', function () {
      openModal('passwordModal');
    });

    document.getElementById('profileEditForm').addEventListener('submit', async function (event) {
      event.preventDefault();

      const updated = await saveProfile({
        name: document.getElementById('profileNameInput').value,
        description: document.getElementById('profileDescriptionInput').value
      }, document.getElementById('profileModalSubmit'), 'profile.status.saving', 'profile.status.basic_updated');

      if (updated) {
        closeModal('profileModal');
      }
    });

    document.getElementById('editBioBtn').addEventListener('click', function () {
      openModal('profileModal');
    });

    document.getElementById('emailEditForm').addEventListener('submit', async function (event) {
      event.preventDefault();

      const submitButton = document.getElementById('emailModalSubmit');
      const emailCodeField = document.getElementById('emailChangeCodeField');
      const payload = {
        email: document.getElementById('profileEmailInput').value,
        currentPassword: document.getElementById('emailCurrentPassword').value
      };
      if (!emailCodeField.classList.contains('hidden')) {
        payload.email_code = document.getElementById('emailChangeCode').value.trim();
      }

      submitButton.disabled = true;
      setStatus('', '');
      try {
        const response = await fetch('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (response.status === 401) {
          window.location.href = '/oauth2/authorize';
          return;
        }
        if (result.require_email_code) {
          emailCodeField.classList.remove('hidden');
          setStatus('success', i18n.resolveMessage(result, 'profile.email_change.sent'));
          document.getElementById('emailChangeCode').focus();
          return;
        }
        if (!response.ok) {
          throw new Error(i18n.resolveMessage(result, 'server.internal'));
        }
        syncUserToPage(result.user);
        setStatus('success', i18n.resolveMessage(result, 'profile.status.basic_updated'));
        emailCodeField.classList.add('hidden');
        document.getElementById('emailChangeCode').value = '';
        document.getElementById('emailCurrentPassword').value = '';
        closeModal('emailModal');
      } catch (error) {
        setStatus('error', error.message);
      } finally {
        submitButton.disabled = false;
      }
    });

    document.getElementById('passwordForm').addEventListener('submit', async function (event) {
      event.preventDefault();

      const currentPassword = document.getElementById('currentPasswordInput').value;
      const newPassword = document.getElementById('newPasswordInput').value;
      const confirmPassword = document.getElementById('confirmNewPasswordInput').value;

      if (!newPassword && !currentPassword && !confirmPassword) {
        setStatus('error', i18n.t('profile.status.password_empty'));
        return;
      }

      if (newPassword !== confirmPassword) {
        setStatus('error', i18n.t('profile.status.password_mismatch'));
        return;
      }

      const updated = await saveProfile({
        currentPassword,
        newPassword
      }, document.getElementById('passwordModalSubmit'), 'profile.status.updating_password', 'profile.status.password_updated');

      if (updated) {
        document.getElementById('currentPasswordInput').value = '';
        document.getElementById('newPasswordInput').value = '';
        document.getElementById('confirmNewPasswordInput').value = '';
        closeModal('passwordModal');
      }
    });

    document.querySelectorAll('[data-close-modal]').forEach(button => {
      button.addEventListener('click', function () {
        closeModal(button.getAttribute('data-close-modal'));
      });
    });

    document.querySelectorAll('[data-modal-backdrop]').forEach(backdrop => {
      backdrop.addEventListener('click', function (event) {
        if (event.target === backdrop) {
          closeModal(backdrop.id);
        }
      });
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        closeAllModals();
      }
    });

    i18n.bindLanguageButtons(document);
    document.querySelectorAll('.profile-navigation a').forEach(link => {
      link.addEventListener('click', () => {
        document.querySelectorAll('.profile-navigation a').forEach(item => item.removeAttribute('aria-current'));
        link.setAttribute('aria-current', 'location');
      });
    });
    document.querySelectorAll('.profile-language-options button').forEach(button => {
      button.addEventListener('click', () => { document.querySelector('.profile-language-menu').open = false; });
    });
    renderDocument();
    loadPasswordGuidance();
    loadProfile();
    loadPhoneCapabilities();
    const identityResult = new URLSearchParams(window.location.search);
    if (identityResult.has('account_merged')) setStatus('success', i18n.t('profile.identity.merge_success'));
    else if (identityResult.has('oidc_error')) setStatus('error', identityResult.get('oidc_error_description') || i18n.t('profile.identity.merge_failed'));
    if (identityResult.has('account_merged') || identityResult.has('oidc_error')) window.history.replaceState(null, '', '/profile');
    loadIdentityProviders();
    loadApplications();
    loadSessions();
    refreshTotpState();

    document.addEventListener('vaultsso:totpchange', function (event) {
      if (currentUser) currentUser.totpEnabled = event.detail.totpEnabled;
      loadSessions();
      loadPhoneCapabilities();
    });

    document.addEventListener('vaultsso:languagechange', function () {
      renderDocument();
      loadIdentityProviders();
    });
