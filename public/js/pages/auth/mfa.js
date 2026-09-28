'use strict';
const mfaStatus = document.getElementById('status');
const mfaSubmit = document.getElementById('submit');
const mfaCode = document.getElementById('code');
const mfaI18n = window.VaultI18n;

function showMfaError(message) {
  mfaStatus.textContent = message;
  mfaStatus.scrollIntoView({ block: 'nearest' });
}

async function loadMfaChallenge() {
  try {
    const response = await fetch('/api/v1/auth/oauth/oidc/pending', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) throw new Error(mfaI18n.resolveMessage(data, 'auth.mfa.expired'));
    document.getElementById('instructions').textContent = data.factor === 'totp'
      ? mfaI18n.t('auth.totp.hint')
      : mfaI18n.t('auth.mfa.email_hint', { email: data.email });
    document.getElementById('codeLabel').textContent = mfaI18n.t(data.factor === 'totp' ? 'auth.totp.label' : 'auth.login_code.label');
    mfaCode.placeholder = mfaI18n.t(data.factor === 'totp' ? 'auth.totp.placeholder' : 'auth.login_code.placeholder');
    mfaCode.maxLength = data.factor === 'totp' ? 32 : 6;
    if (data.factor === 'email') mfaCode.inputMode = 'numeric';
    const loginUrl = new URL(data.login_url || '/oauth2/authorize', window.location.origin);
    if (loginUrl.origin === window.location.origin) document.getElementById('backLogin').href = loginUrl.toString();
    mfaCode.disabled = false;
    mfaSubmit.disabled = false;
    mfaCode.focus();
  } catch (error) { showMfaError(error.message); }
}

document.getElementById('mfaForm').addEventListener('submit', async event => {
  event.preventDefault();
  mfaSubmit.disabled = true;
  mfaStatus.textContent = '';
  try {
    const response = await fetch('/api/v1/auth/oauth/oidc/complete', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: mfaCode.value.trim() })
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 429) mfaCode.disabled = true;
      throw new Error(mfaI18n.resolveMessage(data, 'auth.mfa.invalid'));
    }
    const target = new URL(data.redirect, window.location.origin);
    if (target.origin !== window.location.origin) throw new Error(mfaI18n.t('auth.request.invalid_redirect_uri'));
    window.location.assign(target.toString());
  } catch (error) {
    if (!mfaCode.disabled) {
      mfaCode.value = '';
      mfaCode.focus();
    }
    showMfaError(error.message);
    mfaSubmit.disabled = mfaCode.disabled;
  }
});

loadMfaChallenge();
