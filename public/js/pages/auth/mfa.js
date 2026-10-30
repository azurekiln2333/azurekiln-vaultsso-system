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
const mfaTitle = document.getElementById('mfaTitle');
const mfaEmailGateControls = document.getElementById('emailGateControls');
const mfaEmailGateMasked = document.getElementById('emailGateMasked');
const mfaBindEmailLabel = document.getElementById('bindEmailLabel');
const mfaBindEmailInput = document.getElementById('bindEmailInput');
const mfaSendGateBtn = document.getElementById('sendEmailGateCodeBtn');
let mfaChallenge = null;
let mfaRecoveryMode = false;
let mfaSubmitting = false;
let mfaNavigating = false;
let mfaFeedback = null;
let mfaAutoAttemptValue = null;
let mfaComposing = false;
let mfaChallengeRevision = 0;
let mfaGateSending = false;
let mfaGateSentTarget = '';
let mfaGateProofRestored = false;
let mfaGateRestoredVersion = 0;
let mfaGateCooldownTimer = null;
let mfaGateCooldownRemaining = 0;
let mfaTerminal = false;

function setMfaStatus(kind, payload, fallbackKey) {
  mfaFeedback = { kind, payload, fallbackKey };
  mfaStatus.textContent = mfaI18n.resolveMessage(payload, fallbackKey);
  mfaStatus.classList.toggle('is-success', kind === 'success');
  mfaStatus.scrollIntoView({ block: 'nearest' });
}

function showMfaError(payload, fallbackKey) {
  setMfaStatus('error', payload, fallbackKey);
}

// The email gate stages (email_bind / email_verify) reuse this page. A challenge
// reports the stage through `email_gate`; the factor name is the fallback.
function mfaGateMode() {
  if (!mfaChallenge) return '';
  if (mfaChallenge.email_gate === 'bind' || mfaChallenge.email_gate === 'verify') return mfaChallenge.email_gate;
  if (mfaChallenge.factor === 'email_bind') return 'bind';
  if (mfaChallenge.factor === 'email_verify') return 'verify';
  return '';
}

function mfaGateCodeSent() {
  return Boolean(mfaChallenge && mfaChallenge.code_sent);
}

function mfaGateVersion() {
  return Math.max(0, Number(mfaChallenge?.mail_version || 0));
}

function stopGateCooldown() {
  if (mfaGateCooldownTimer) {
    clearInterval(mfaGateCooldownTimer);
    mfaGateCooldownTimer = null;
  }
  mfaGateCooldownRemaining = 0;
}

function renderGateCooldown() {
  if (!mfaGateMode()) return;
  if (mfaTerminal) {
    mfaSendGateBtn.disabled = true;
    mfaSendGateBtn.textContent = mfaI18n.t('auth.email_gate.send');
    return;
  }
  // A restored bind proof already targets the persisted mailbox and the full
  // address is never sent back, so there is nothing to resend until the user
  // types a destination.
  if (gateInputOptional()) {
    mfaSendGateBtn.disabled = true;
    mfaSendGateBtn.textContent = mfaI18n.t('auth.email_gate.send');
    return;
  }
  if (mfaGateCooldownRemaining > 0) {
    mfaSendGateBtn.disabled = true;
    mfaSendGateBtn.textContent = mfaI18n.t('auth.status.resend_in', { seconds: mfaGateCooldownRemaining });
    return;
  }
  mfaSendGateBtn.textContent = mfaI18n.t('auth.email_gate.send');
  mfaSendGateBtn.disabled = mfaGateSending || mfaSubmitting;
}

// The bind field is optional only when a code is already active for the persisted
// mailbox: an empty field then means "use the persisted target".
function gateInputOptional() {
  return mfaGateMode() === 'bind' && mfaGateCodeSent() && !mfaGateSentTarget
    && mfaGateProofRestored && mfaGateVersion() === mfaGateRestoredVersion
    && !String(mfaBindEmailInput.value || '').trim();
}

function startGateCooldown(seconds) {
  stopGateCooldown();
  mfaGateCooldownRemaining = Math.max(0, Number(seconds) || 0);
  renderGateCooldown();
  if (!mfaGateCooldownRemaining) return;
  mfaGateCooldownTimer = setInterval(() => {
    mfaGateCooldownRemaining = Math.max(0, mfaGateCooldownRemaining - 1);
    if (!mfaGateCooldownRemaining) {
      stopGateCooldown();
      renderGateCooldown();
      return;
    }
    renderGateCooldown();
  }, 1000);
}

// Code entry and completion stay disabled until a code was actually sent for the
// current target; editing the bind address invalidates the sent code locally.
// A pending send also locks code entry and completion, so a resend cannot overlap
// an in-flight completion even when a previous code had already been sent.
function syncGateEnablement() {
  if (!mfaChallenge) return;
  // A terminal 401/429 failure must never be reversed by later render passes.
  if (mfaTerminal) {
    mfaCode.disabled = true;
    mfaSubmit.disabled = true;
    mfaRecoveryToggle.disabled = true;
    mfaBindEmailInput.disabled = true;
    if (mfaGateMode()) renderGateCooldown();
    return;
  }
  if (mfaGateMode()) {
    mfaCode.disabled = !mfaGateCodeSent() || mfaGateSending;
    mfaCode.readOnly = mfaSubmitting || mfaGateSending || mfaTerminal;
    mfaBindEmailInput.disabled = mfaGateSending || mfaSubmitting;
  }
  mfaSubmit.disabled = mfaSubmitting || mfaGateSending || mfaCode.disabled;
}

// Disable every entry point without changing the displayed factor. Used while a
// next stage is loading and after a failed refresh so a consumed stage cannot be
// submitted again. Locking is terminal: only a successful reload clears it.
function lockMfaStage() {
  mfaTerminal = true;
  mfaCode.disabled = true;
  mfaCode.readOnly = true;
  mfaSubmit.disabled = true;
  mfaRecoveryToggle.disabled = true;
  mfaBindEmailInput.disabled = true;
  mfaSendGateBtn.disabled = true;
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
  if (!mfaRecoveryMode && !mfaComposing) {
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
  maybeAutoVerify();
}

// Automatic completion reuses the form submit owner; a rejected attempt clears the
// marker so re-entering the same code can retry.
function maybeAutoVerify() {
  if (mfaRecoveryMode || mfaComposing || mfaTerminal) return;
  if (mfaSubmitting || mfaNavigating) return;
  if (!mfaChallenge || mfaCode.disabled || mfaCode.readOnly) return;
  const value = mfaCode.value;
  if (!/^\d{6}$/.test(value) || value === mfaAutoAttemptValue) return;
  mfaAutoAttemptValue = value;
  mfaForm.requestSubmit();
}

function renderMfaChallenge() {
  mfaLanguageMenu.querySelector('summary').setAttribute('aria-label', mfaI18n.t('auth.mfa.language'));
  if (!mfaChallenge) return;
  const gate = mfaGateMode();
  const totp = mfaChallenge.factor === 'totp';
  mfaTitle.textContent = mfaI18n.t(gate === 'bind' ? 'auth.email_gate.bind_title' : gate === 'verify' ? 'auth.email_gate.verify_title' : 'auth.mfa.title');
  const labelKey = mfaRecoveryMode ? 'auth.mfa.recovery_label' : totp ? 'auth.totp.label' : 'auth.login_code.label';
  mfaInstructions.removeAttribute('data-i18n');
  const hintKey = mfaRecoveryMode ? 'auth.mfa.recovery_hint'
    : totp ? 'auth.mfa.totp_hint'
      : gate === 'bind' ? 'auth.email_gate.bind_hint'
        : gate === 'verify' ? 'auth.email_gate.verify_hint'
          : 'auth.mfa.email_hint';
  mfaInstructions.textContent = mfaI18n.t(hintKey, { email: mfaChallenge.email });
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

  mfaEmailGateControls.hidden = !gate;
  if (gate) {
    const isBind = gate === 'bind';
    mfaBindEmailInput.hidden = !isBind;
    mfaBindEmailLabel.hidden = !isBind;
    // Required unless an active code already targets the persisted mailbox, in
    // which case an empty field is valid (native form validation must not block).
    if (isBind && !gateInputOptional()) mfaBindEmailInput.setAttribute('required', 'required');
    else mfaBindEmailInput.removeAttribute('required');
    if (mfaTerminal) mfaBindEmailInput.disabled = true;
    const masked = String(mfaChallenge.email || '');
    mfaEmailGateMasked.hidden = !masked;
    mfaEmailGateMasked.textContent = masked ? `${mfaI18n.t('auth.email_gate.masked_label')} ${masked}` : '';
    renderGateCooldown();
  }

  renderMfaSlots();
}

function setMfaSubmitting(submitting) {
  mfaSubmitting = submitting;
  mfaForm.setAttribute('aria-busy', String(submitting));
  mfaCode.readOnly = submitting || mfaTerminal;
  mfaSubmit.disabled = submitting || mfaCode.disabled;
  mfaRecoveryToggle.disabled = submitting || mfaCode.disabled;
  if (mfaGateMode()) {
    mfaBindEmailInput.disabled = mfaTerminal || submitting || mfaGateSending;
    renderGateCooldown();
    syncGateEnablement();
  }
}

function focusGateEntry() {
  if (mfaGateMode() === 'bind' && !mfaGateCodeSent()) {
    mfaBindEmailInput.focus();
    return;
  }
  if (mfaGateCodeSent()) {
    mfaCode.focus();
    return;
  }
  mfaSendGateBtn.focus();
}

// Shared rehydration for a next stage (TOTP -> gate) and for state conflicts.
// The pending challenge is retained; only this page's transient entry state resets.
// The consumed stage is locked before the refresh so a failed reload can never
// leave the obsolete factor accepting another submission.
async function advanceMfaStage(messageKey) {
  mfaAutoAttemptValue = null;
  mfaRecoveryMode = false;
  mfaComposing = false;
  mfaFeedback = null;
  mfaStatus.textContent = '';
  mfaStatus.classList.remove('is-success');
  mfaCode.value = '';
  mfaGateSending = false;
  mfaGateSentTarget = '';
  mfaGateProofRestored = false;
  mfaGateRestoredVersion = 0;
  stopGateCooldown();
  lockMfaStage();
  const refreshed = await loadMfaChallenge();
  if (!refreshed) {
    // Leave the stage locked and rely on the readable load/login error.
    lockMfaStage();
    return;
  }
  if (messageKey) showMfaError(null, messageKey);
}

async function sendEmailGateCode() {
  const gate = mfaGateMode();
  if (!gate || !mfaChallenge || mfaTerminal || mfaGateSending || mfaSubmitting || mfaNavigating) return;
  const isBind = gate === 'bind';
  const target = isBind ? String(mfaBindEmailInput.value || '').trim() : '';
  if (isBind && !target) {
    // Empty is only acceptable when a code is already active for the persisted
    // mailbox; focus the code entry instead of attempting an unusable send.
    if (gateInputOptional()) {
      mfaCode.focus();
      return;
    }
    mfaBindEmailInput.focus();
    showMfaError(null, 'validation.email.invalid');
    return;
  }
  const revision = mfaChallengeRevision;
  const requestedVersion = mfaGateVersion();
  mfaGateSending = true;
  mfaFeedback = null;
  mfaStatus.textContent = '';
  mfaStatus.classList.remove('is-success');
  // Lock entry and completion for the whole send, including when a previous code
  // was already sent and would otherwise stay usable.
  syncGateEnablement();
  mfaBindEmailInput.disabled = true;
  mfaSendGateBtn.disabled = true;
  try {
    const payload = { expected_mail_version: requestedVersion };
    if (isBind) payload.email = target;
    const response = await fetch('/api/v1/auth/oauth/oidc/email/send', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (revision !== mfaChallengeRevision) return;
    if (!response.ok) {
      if (response.status === 409) {
        await advanceMfaStage('auth.email_gate.changed');
        return;
      }
      // The send response may or may not have reserved a new version (an
      // invalid-address/cooldown rejection happens before reservation), so the
      // pending projection is the authority for version, cooldown and code_sent.
      const failedPayload = data;
      const failedFallback = response.status === 502 ? 'smtp.test_failed' : 'common.request_error';
      if (!await loadMfaChallenge()) {
        lockMfaStage();
        return;
      }
      showMfaError(failedPayload, failedFallback);
      return;
    }
    mfaChallenge.mail_version = Number(data.mail_version ?? requestedVersion + 1);
    mfaChallenge.code_sent = Boolean(data.code_sent);
    if (data.email) mfaChallenge.email = data.email;
    mfaGateSentTarget = isBind ? target : '';
    mfaGateProofRestored = false;
    mfaGateRestoredVersion = 0;
    mfaCode.value = '';
    mfaAutoAttemptValue = null;
    renderMfaChallenge();
    syncGateEnablement();
    startGateCooldown(Number(data.retry_after || 0));
    if (mfaGateCodeSent()) mfaCode.focus();
    else focusGateEntry();
    setMfaStatus('success', null, 'auth.email_gate.sent');
  } catch {
    // Outcome unknown after a network error: re-read the authoritative pending
    // projection instead of assuming the previous code is still usable.
    mfaGateSentTarget = '';
    mfaGateProofRestored = false;
    mfaGateRestoredVersion = 0;
    mfaCode.value = '';
    mfaAutoAttemptValue = null;
    renderMfaSlots();
    if (!await loadMfaChallenge()) {
      lockMfaStage();
      return;
    }
    showMfaError(null, 'common.request_error');
  } finally {
    mfaGateSending = false;
    // Re-derive from the current challenge: after a rehydrating failure the stage
    // may have changed, so the send flag alone must not gate re-enablement.
    if (mfaGateMode()) {
      mfaBindEmailInput.disabled = mfaTerminal || mfaSubmitting;
      renderGateCooldown();
      syncGateEnablement();
    }
  }
}

function rejectMfaSubmission(payload, fallbackKey) {
  mfaAutoAttemptValue = null;
  if (!mfaCode.disabled) {
    mfaCode.value = '';
    mfaCode.focus();
  }
  renderMfaSlots();
  showMfaError(payload, fallbackKey);
}

async function loadMfaChallenge() {
  mfaChallengeRevision += 1;
  try {
    const response = await fetch('/api/v1/auth/oauth/oidc/pending', { credentials: 'same-origin' });
    const data = await response.json();
    if (!response.ok) {
      showMfaError(data, 'auth.mfa.expired');
      return false;
    }
    const loginUrl = new URL(data.login_url || '/oauth2/authorize', window.location.origin);
    if (loginUrl.origin === window.location.origin) document.getElementById('backLogin').href = loginUrl.toString();
    mfaChallenge = data;
    mfaAutoAttemptValue = null;
    mfaTerminal = false;
    mfaGateSentTarget = '';
    // A reloaded bind stage may already have an active code for the persisted
    // mailbox. The address stays masked, so an empty field means that target.
    const gateStage = data.email_gate === 'bind' || data.factor === 'email_bind';
    mfaGateProofRestored = Boolean(gateStage && data.code_sent);
    mfaGateRestoredVersion = mfaGateProofRestored ? Math.max(0, Number(data.mail_version || 0)) : 0;
    // A rejected retarget can restore a still-active code for an earlier address.
    // Display only that persisted masked target, never the rejected editable address.
    if (mfaGateProofRestored) mfaBindEmailInput.value = '';
    renderMfaChallenge();
    if (mfaGateMode()) {
      startGateCooldown(Number(data.retry_after || 0));
      syncGateEnablement();
      setMfaSubmitting(false);
      focusGateEntry();
      return true;
    }
    stopGateCooldown();
    mfaCode.disabled = false;
    setMfaSubmitting(false);
    mfaCode.focus();
    return true;
  } catch {
    showMfaError(null, 'common.request_error');
    return false;
  }
}

mfaForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (mfaSubmitting || mfaGateSending || mfaCode.disabled) return;
  const gate = mfaGateMode();
  if (gate && !mfaGateCodeSent()) {
    showMfaError(null, 'auth.email_gate.send_required');
    return;
  }
  setMfaSubmitting(true);
  mfaFeedback = null;
  mfaStatus.textContent = '';
  mfaStatus.classList.remove('is-success');
  try {
    const body = { code: mfaCode.value.trim() };
    if (gate) body.expected_mail_version = mfaGateVersion();
    const response = await fetch('/api/v1/auth/oauth/oidc/complete', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) {
      // A stale version / changed target is a state conflict: rehydrate the stage.
      if (response.status === 409) {
        await advanceMfaStage('auth.email_gate.changed');
        return;
      }
      if (response.status === 401 || response.status === 429) {
        // Terminal for this challenge: keep it disabled through every later render.
        mfaTerminal = true;
        mfaCode.disabled = true;
      }
      rejectMfaSubmission(data, 'auth.mfa.invalid');
      return;
    }
    // A completed authenticator stage advances to the email gate without issuing
    // credentials: keep the pending challenge and reload the next stage.
    if (data && data.next_step) {
      await advanceMfaStage();
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
mfaCode.addEventListener('compositionstart', () => {
  mfaComposing = true;
});
mfaCode.addEventListener('compositionend', () => {
  mfaComposing = false;
  syncMfaInput();
});
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

mfaBindEmailInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  sendEmailGateCode();
});
mfaBindEmailInput.addEventListener('input', () => {
  if (mfaGateMode() !== 'bind' || !mfaChallenge) return;
  const value = String(mfaBindEmailInput.value || '').trim();
  if (value === '') {
    // Empty means the persisted target: restore the active proof it still owns.
    if (!mfaGateCodeSent() && (mfaGateSentTarget || mfaGateProofRestored)) {
      if (mfaGateSentTarget || mfaGateVersion() !== mfaGateRestoredVersion) return;
      mfaChallenge.code_sent = true;
      renderMfaChallenge();
      syncGateEnablement();
    }
    return;
  }
  if (mfaGateSentTarget && value === mfaGateSentTarget) return;
  if (!mfaGateCodeSent()) return;
  // Any other destination invalidates the sent proof: the code belongs to a
  // different mailbox, so an explicit resend is required before completing.
  mfaChallenge.code_sent = false;
  mfaCode.value = '';
  mfaAutoAttemptValue = null;
  renderMfaSlots();
  renderMfaChallenge();
  syncGateEnablement();
  setMfaStatus('error', null, 'auth.email_gate.send_required');
});
mfaSendGateBtn.addEventListener('click', () => {
  sendEmailGateCode();
});

mfaRecoveryToggle.addEventListener('click', () => {
  if (mfaRecoveryToggle.disabled || mfaChallenge?.factor !== 'totp') return;
  mfaRecoveryMode = !mfaRecoveryMode;
  mfaCode.value = '';
  mfaAutoAttemptValue = null;
  mfaFeedback = null;
  mfaStatus.textContent = '';
  renderMfaChallenge();
  mfaCode.focus();
});

mfaI18n.bindLanguageButtons(document);
document.addEventListener('vaultsso:languagechange', () => {
  renderMfaChallenge();
  if (mfaFeedback) {
    mfaStatus.textContent = mfaI18n.resolveMessage(mfaFeedback.payload, mfaFeedback.fallbackKey);
    mfaStatus.classList.toggle('is-success', mfaFeedback.kind === 'success');
  }
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
