(function () {
  'use strict';

  const i18n = window.VaultI18n;
  const element = id => document.getElementById(id);
  let state = null;
  let requestVersion = 0;
  let enrollmentVersion = 0;
  let pending = null;
  let management = null;
  let mutationBusy = false;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    })[character]);
  }

  async function request(endpoint, body, method = 'POST') {
    const response = await fetch(endpoint, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(i18n.resolveMessage(payload, 'common.request_error'));
      error.key = payload.error_key;
      throw error;
    }
    return payload;
  }

  function modalError(id, message = '') {
    const error = element(id);
    error.textContent = message;
    error.hidden = !message;
    if (message) error.scrollIntoView({ block: 'nearest' });
  }

  function notice(message) {
    const status = element('statusMessage');
    status.className = 'status show success';
    status.textContent = message;
  }

  function deviceName(device) {
    return device.name || i18n.t('profile.totp.existing_device');
  }

  function renderStatus(user = {}) {
    const enabled = state ? state.totpEnabled : Boolean(user.totpEnabled);
    const chip = element('totpStatusChip');
    chip.textContent = i18n.t(enabled ? 'profile.totp.status_on' : 'profile.totp.status_off');
    chip.className = enabled
      ? 'rounded-full px-3 py-1.5 text-xs font-bold bg-green-50 text-green-700'
      : 'rounded-full px-3 py-1.5 text-xs font-bold bg-surface-container-low text-muted';
    element('totpActionBtn').textContent = i18n.t('profile.totp.add');
    element('totpActionBtn').disabled = !state || mutationBusy;
    element('totpRecoveryInfo').hidden = !enabled;
    if (!state) return;
    element('totpRecoveryRemaining').textContent = String(state.recoveryCodesRemaining || 0);
    const list = element('totpDevicesList');
    list.innerHTML = state.authenticators.map(device => {
      const lastUsed = device.lastUsedAt
        ? new Date(device.lastUsedAt).toLocaleString(i18n.getLanguage() === 'en' ? 'en-US' : i18n.getLanguage() === 'zh-TW' ? 'zh-TW' : 'zh-CN')
        : i18n.t('profile.totp.never_used');
      const label = i18n.t('profile.totp.remove_named', { name: deviceName(device) });
      return `<div class="totp-device" data-authenticator-id="${escapeHtml(device.id)}">
        <div class="totp-device-copy"><p class="text-sm font-bold">${escapeHtml(deviceName(device))}</p>
          <p class="totp-device-meta">${escapeHtml(i18n.t('profile.totp.last_used'))}: ${escapeHtml(lastUsed)}</p></div>
        <button class="totp-device-remove" type="button" data-remove-authenticator="${escapeHtml(device.id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="material-symbols-outlined" aria-hidden="true">delete</span></button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-remove-authenticator]').forEach(button => {
      button.disabled = mutationBusy;
      button.addEventListener('click', () => openManagement('remove', state.authenticators.find(device => device.id === button.dataset.removeAuthenticator)));
    });
    if (!enabled) {
      element('totpCodesResult').classList.add('hidden');
      element('totpCodesList').textContent = '';
    }
  }

  function applyState(payload) {
    ++requestVersion;
    state = {
      totpEnabled: Boolean(payload.totpEnabled),
      recoveryCodesRemaining: payload.recoveryCodesRemaining ?? state?.recoveryCodesRemaining ?? 0,
      authenticators: Array.isArray(payload.authenticators) ? payload.authenticators : []
    };
    element('totpListError').classList.add('hidden');
    renderStatus();
    document.dispatchEvent(new CustomEvent('vaultsso:totpchange', { detail: { totpEnabled: state.totpEnabled } }));
  }

  async function refresh() {
    const version = ++requestVersion;
    try {
      const payload = await request('/api/account/totp', undefined, 'GET');
      if (version !== requestVersion) return;
      applyState(payload);
    } catch (error) {
      if (version !== requestVersion) return;
      element('totpListError').textContent = error.message;
      element('totpListError').classList.remove('hidden');
    }
  }

  function showRecoveryCodes(codes) {
    if (!Array.isArray(codes) || !codes.length) return;
    element('totpCodesList').innerHTML = codes.map(code => `<span>${escapeHtml(code)}</span>`).join('');
    element('totpCodesResult').classList.remove('hidden');
  }

  function clearSecret() {
    element('totpQrImage').removeAttribute('src');
    element('totpSecretText').textContent = '';
    element('totpEnableCode').value = '';
    element('totpCurrentCode').value = '';
    element('totpEnrollForm').hidden = false;
    element('totpConfirmForm').hidden = true;
  }

  function cancelPending(device) {
    if (!device) return;
    request(`/api/account/totp/authenticators/${encodeURIComponent(device.id)}`, {}, 'DELETE').catch(() => {});
  }

  function canCloseModal(id) {
    return !mutationBusy || !['totpEnrollModal', 'totpManageModal'].includes(id);
  }

  function onModalClosed(id) {
    if (id === 'totpEnrollModal') {
      ++enrollmentVersion;
      cancelPending(pending);
      pending = null;
      clearSecret();
      element('totpDeviceName').value = '';
      modalError('totpEnrollError');
    } else if (id === 'totpManageModal') {
      management = null;
      element('totpManageCode').value = '';
      modalError('totpManageError');
    }
  }

  element('totpActionBtn').addEventListener('click', () => {
    if (!state || mutationBusy) return;
    clearSecret();
    element('totpCurrentCodeField').hidden = !state.totpEnabled;
    element('totpCurrentCode').required = state.totpEnabled;
    modalError('totpEnrollError');
    openModal('totpEnrollModal');
  });

  element('totpEnrollForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = element('totpSetupSubmit');
    if (button.disabled) return;
    const version = ++enrollmentVersion;
    button.disabled = true;
    modalError('totpEnrollError');
    try {
      const payload = await request('/api/account/totp/authenticators/setup', {
        name: element('totpDeviceName').value.trim(), code: element('totpCurrentCode').value.trim()
      });
      if (version !== enrollmentVersion) { cancelPending(payload); return; }
      pending = payload;
      element('totpCurrentCode').value = '';
      element('totpPendingName').textContent = element('totpDeviceName').value.trim();
      element('totpQrImage').src = payload.qrDataUrl;
      element('totpSecretText').textContent = payload.secret;
      element('totpEnrollForm').hidden = true;
      element('totpConfirmForm').hidden = false;
      element('totpEnableCode').focus();
    } catch (error) {
      if (version === enrollmentVersion) modalError('totpEnrollError', error.message);
    } finally { button.disabled = false; }
  });

  element('totpConfirmForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!pending || mutationBusy) return;
    mutationBusy = true;
    element('totpEnableBtn').disabled = true;
    modalError('totpEnrollError');
    try {
      const payload = await request(`/api/account/totp/authenticators/${encodeURIComponent(pending.id)}/confirm`, { code: element('totpEnableCode').value.trim() });
      pending = null;
      applyState(payload);
      showRecoveryCodes(payload.recoveryCodes);
      mutationBusy = false;
      closeModal('totpEnrollModal');
      notice(i18n.t('profile.totp.added'));
    } catch (error) {
      if (['auth.totp.setup_expired', 'auth.totp.setup_locked', 'auth.totp.not_found'].includes(error.key)) {
        cancelPending(pending);
        pending = null;
        clearSecret();
      }
      modalError('totpEnrollError', error.message);
    } finally {
      mutationBusy = false;
      element('totpEnableBtn').disabled = false;
      renderStatus();
    }
  });

  function openManagement(mode, device) {
    if (!state || mutationBusy || (mode === 'remove' && !device)) return;
    management = { mode, device };
    element('totpManageTitle').textContent = i18n.t(mode === 'remove' ? 'profile.totp.remove' : 'profile.totp.recovery_regen');
    element('totpManageDevice').textContent = device ? deviceName(device) : '';
    element('totpManageDevice').hidden = !device;
    element('totpLastDeviceWarning').hidden = mode !== 'remove' || state.authenticators.length !== 1;
    element('totpRecoveryWarning').hidden = mode !== 'recovery';
    element('totpManageCodeLabel').textContent = i18n.t(mode === 'remove' ? 'profile.totp.current_code' : 'profile.totp.dynamic_code');
    element('totpManageCode').value = '';
    modalError('totpManageError');
    openModal('totpManageModal');
  }

  element('totpRegenerateBtn').addEventListener('click', () => openManagement('recovery'));

  element('totpManageForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!management || mutationBusy) return;
    mutationBusy = true;
    element('totpManageSubmit').disabled = true;
    modalError('totpManageError');
    const { mode, device } = management;
    try {
      const payload = mode === 'remove'
        ? await request(`/api/account/totp/authenticators/${encodeURIComponent(device.id)}`, { code: element('totpManageCode').value.trim() }, 'DELETE')
        : await request('/api/account/totp/recovery-codes', { code: element('totpManageCode').value.trim() });
      if (mode === 'remove') applyState(payload);
      else {
        showRecoveryCodes(payload.recoveryCodes);
        await refresh();
      }
      mutationBusy = false;
      closeModal('totpManageModal');
      notice(i18n.t(mode === 'remove' ? 'profile.totp.removed' : 'profile.totp.recovery_updated'));
    } catch (error) { modalError('totpManageError', error.message); }
    finally {
      mutationBusy = false;
      element('totpManageSubmit').disabled = false;
      renderStatus();
    }
  });

  document.addEventListener('vaultsso:languagechange', () => renderStatus());
  window.ProfileTotp = { renderStatus, refresh, canCloseModal, onModalClosed };
})();
