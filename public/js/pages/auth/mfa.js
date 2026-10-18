'use strict';
const mfaStatus = document.getElementById('status');
const mfaSubmit = document.getElementById('submit');
const mfaCode = document.getElementById('code');
const mfaI18n = window.VaultI18n;
const mfaForm = document.getElementById('mfaForm');
const mfaInstructions = document.getElementById('instructions');
const mfaCodeLabel = document.getElementById('codeLabel');
const mfaCodeEntry = document.getElementById('codeEntry');
const mfaSlots = Array.from(document.querySelectorAll('[data-code-slot]'));
const mfaRecoveryToggle = document.getElementById('recoveryToggle');
const mfaLanguageMenu = document.getElementById('languageMenu');
let mfaChallenge = null;
let mfaRecoveryMode = false;
let mfaSubmitting = false;
let mfaNavigating = false;
let mfaFeedback = null;

function showMfaError(payload, fallbackKey) {
  mfaFeedback = { payload, fallbackKey };
  mfaStatus.textContent = mfaI18n.resolveMessage(payload, fallbackKey);
  mfaStatus.scrollIntoView({ block: 'nearest' });
}

function renderMfaSlots() {
  const start = mfaCode.selectionStart || 0;
  const end = mfaCode.selectionEnd || start;
  const focused = document.activeElement === mfaCode && !mfaCode.disabled && !mfaRecoveryMode;
  mfaSlots.forEach((slot, index) => {
    slot.textContent = mfaRecoveryMode ? '' : mfaCode.value[index] || '';
    const selected = start === end ? index === Math.min(start, 5) : index >= start && index < end;
    slot.classList.toggle('is-active', focused && selected);
  });
}

function syncMfaInput() {
  if (!mfaRecoveryMode) {
    const value = mfaCode.value;
    const normalized = value.replace(/\D/g, '').slice(0, 6);
    if (value !== normalized) {
      const start = value.slice(0, mfaCode.selectionStart).replace(/\D/g, '').length;
      const end = value.slice(0, mfaCode.selectionEnd).replace(/\D/g, '').length;
      mfaCode.value = normalized;
      mfaCode.setSelectionRange(Math.min(start, 6), Math.min(end, 6));
    }
  }
  renderMfaSlots();
}

function renderMfaChallenge() {
  mfaLanguageMenu.querySelector('summary').setAttribute('aria-label', mfaI18n.t('auth.mfa.language'));
  if (!mfaChallenge) return;
  const totp = mfaChallenge.factor === 'totp';
  const labelKey = mfaRecoveryMode ? 'auth.mfa.recovery_label' : totp ? 'auth.totp.label' : 'auth.login_code.label';
  mfaInstructions.removeAttribute('data-i18n');
  mfaInstructions.textContent = mfaI18n.t(mfaRecoveryMode ? 'auth.mfa.recovery_hint' : totp ? 'auth.mfa.totp_hint' : 'auth.mfa.email_hint', { email: mfaChallenge.email });
  mfaCodeLabel.dataset.i18n = labelKey;
  mfaCodeLabel.textContent = mfaI18n.t(labelKey);
  mfaCode.placeholder = mfaI18n.t(mfaRecoveryMode ? 'auth.mfa.recovery_placeholder' : totp ? 'auth.mfa.totp_placeholder' : 'auth.login_code.placeholder');
  // Firefox may expose an empty autocomplete property; the name also identifies TOTP.
  mfaCode.name = mfaRecoveryMode ? 'recovery_code' : totp ? 'totp_code' : 'email_code';
  mfaCode.inputMode = mfaRecoveryMode ? 'text' : 'numeric';
  mfaCode.autocomplete = mfaRecoveryMode ? 'off' : 'one-time-code';
  mfaCode.maxLength = mfaRecoveryMode ? 32 : 6;
  mfaCodeEntry.classList.toggle('is-recovery', mfaRecoveryMode);
  mfaRecoveryToggle.hidden = !totp;
  mfaRecoveryToggle.dataset.i18n = mfaRecoveryMode ? 'auth.mfa.use_totp' : 'auth.mfa.use_recovery';
  mfaRecoveryToggle.textContent = mfaI18n.t(mfaRecoveryToggle.dataset.i18n);
  mfaRecoveryToggle.setAttribute('aria-pressed', String(mfaRecoveryMode));
  renderMfaSlots();
}

function setMfaSubmitting(submitting) {
  mfaSubmitting = submitting;
  mfaForm.setAttribute('aria-busy', String(submitting));
  mfaCode.readOnly = submitting;
  mfaSubmit.disabled = submitting || mfaCode.disabled;
  mfaRecoveryToggle.disabled = submitting || mfaCode.disabled;
}

function rejectMfaSubmission(payload, fallbackKey) {
  if (!mfaCode.disabled) {
    mfaCode.value = '';
    mfaCode.focus();
  }
  renderMfaSlots();
  showMfaError(payload, fallbackKey);
}

async function loadMfaChallenge() {
  try {
    const response = await fetch('/api/v1/auth/oauth/oidc/pending', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) {
      showMfaError(data, 'auth.mfa.expired');
      return;
    }
    const loginUrl = new URL(data.login_url || '/oauth2/authorize', window.location.origin);
    if (loginUrl.origin === window.location.origin) document.getElementById('backLogin').href = loginUrl.toString();
    mfaChallenge = data;
    renderMfaChallenge();
    mfaCode.disabled = false;
    setMfaSubmitting(false);
    mfaCode.focus();
  } catch {
    showMfaError(null, 'common.request_error');
  }
}

mfaForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (mfaSubmitting || mfaCode.disabled) return;
  setMfaSubmitting(true);
  mfaFeedback = null;
  mfaStatus.textContent = '';
  try {
    const response = await fetch('/api/v1/auth/oauth/oidc/complete', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: mfaCode.value.trim() })
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 429) mfaCode.disabled = true;
      rejectMfaSubmission(data, 'auth.mfa.invalid');
      return;
    }
    const target = new URL(data.redirect, window.location.origin);
    if (target.origin !== window.location.origin) {
      rejectMfaSubmission(null, 'auth.request.invalid_redirect_uri');
      return;
    }
    mfaNavigating = true;
    window.location.assign(target.toString());
  } catch {
    mfaNavigating = false;
    rejectMfaSubmission(null, 'common.request_error');
  } finally {
    if (!mfaNavigating) setMfaSubmitting(false);
  }
});

mfaCode.addEventListener('input', syncMfaInput);
mfaCode.addEventListener('change', syncMfaInput);
mfaCode.addEventListener('focus', renderMfaSlots);
mfaCode.addEventListener('blur', renderMfaSlots);
mfaCode.addEventListener('keyup', renderMfaSlots);
mfaCode.addEventListener('select', renderMfaSlots);
document.addEventListener('selectionchange', renderMfaSlots);
mfaCode.addEventListener('click', event => {
  if (mfaRecoveryMode || mfaCode.disabled || mfaCode.readOnly || mfaCode.selectionStart !== mfaCode.selectionEnd) return;
  const index = mfaSlots.findIndex(slot => event.clientX <= slot.getBoundingClientRect().right);
  const start = Math.min(index < 0 ? 5 : index, mfaCode.value.length);
  mfaCode.setSelectionRange(start, Math.min(start + 1, mfaCode.value.length));
  renderMfaSlots();
});

mfaRecoveryToggle.addEventListener('click', () => {
  if (mfaRecoveryToggle.disabled || mfaChallenge?.factor !== 'totp') return;
  mfaRecoveryMode = !mfaRecoveryMode;
  mfaCode.value = '';
  mfaFeedback = null;
  mfaStatus.textContent = '';
  renderMfaChallenge();
  mfaCode.focus();
});

mfaI18n.bindLanguageButtons(document);
document.addEventListener('vaultsso:languagechange', () => {
  renderMfaChallenge();
  if (mfaFeedback) mfaStatus.textContent = mfaI18n.resolveMessage(mfaFeedback.payload, mfaFeedback.fallbackKey);
});
mfaLanguageMenu.querySelectorAll('[data-language-switch]').forEach(button => {
  button.addEventListener('click', () => {
    mfaLanguageMenu.open = false;
    mfaLanguageMenu.querySelector('summary').focus();
  });
});
document.addEventListener('click', event => {
  if (!mfaLanguageMenu.contains(event.target)) mfaLanguageMenu.open = false;
});
mfaLanguageMenu.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    mfaLanguageMenu.open = false;
    mfaLanguageMenu.querySelector('summary').focus();
  }
});
renderMfaChallenge();
loadMfaChallenge();
