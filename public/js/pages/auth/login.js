const i18n = window.VaultI18n;
    const urlParams = new URLSearchParams(window.location.search);
    const oauthParams = {
      client_id: urlParams.get('client_id') || '',
      redirect_uri: urlParams.get('redirect_uri') || '',
      scope: urlParams.get('scope') || 'openid profile email',
      state: urlParams.get('state') || '',
      nonce: urlParams.get('nonce') || '',
      response_type: urlParams.get('response_type') || 'code',
      code_challenge: urlParams.get('code_challenge') || '',
      code_challenge_method: urlParams.get('code_challenge_method') || ''
    };

    const hasOAuthRequest = Boolean(oauthParams.client_id && oauthParams.redirect_uri);
    const tabButtons = Array.from(document.querySelectorAll('.tab-button'));
    const cards = Array.from(document.querySelectorAll('[data-card]'));
    const statusMessage = document.getElementById('statusMessage');
    const loginForm = document.getElementById('loginForm');
    const loginSessionDays = document.getElementById('loginSessionDays');
    const registerForm = document.getElementById('registerForm');
    const registerUsername = document.getElementById('registerUsername');
    const recoverForm = document.getElementById('recoverForm');
    const passwordSetupForm = document.getElementById('passwordSetupForm');
    const loginContactAdmin = document.getElementById('loginContactAdmin');
    const changeLoginAccountBtn = document.getElementById('changeLoginAccountBtn');
    const loginPrimarySubmit = document.getElementById('loginPrimarySubmit');
    const setupEmailMasked = document.getElementById('setupEmailMasked');
    const setupEmailCode = document.getElementById('setupEmailCode');
    const setupPassword = document.getElementById('setupPassword');
    const setupConfirmPassword = document.getElementById('setupConfirmPassword');
    const sendSetupCodeBtn = document.getElementById('sendSetupCodeBtn');
    const authRegion = document.getElementById('authRegion');
    const sessionBanner = document.getElementById('sessionBanner');
    const sessionEntry = document.getElementById('sessionEntry');
    const logoutButton = document.getElementById('logoutButton');
    const oidcDivider = document.getElementById('oidcDivider');
    const oidcProviders = document.getElementById('oidcProviders');
    let modeRevision = 0;
    let feedbackRevision = 0;
    let loginStep = 'account';
    let registerUsernameComposing = false;

    function usernameCharacters(value) {
      return value.replace(/[^A-Za-z0-9_]/g, '');
    }

    function filterRegisterUsername() {
      const raw = registerUsername.value;
      const allowed = value => usernameCharacters(value).slice(0, 255);
      const filtered = allowed(raw);
      if (filtered === raw) return;

      const start = allowed(raw.slice(0, registerUsername.selectionStart ?? raw.length)).length;
      const end = allowed(raw.slice(0, registerUsername.selectionEnd ?? raw.length)).length;
      const direction = registerUsername.selectionDirection;
      registerUsername.value = filtered;
      registerUsername.setSelectionRange(start, end, direction);
    }

    function showRegisterUsernameError() {
      clearStatus();
      setStatus('error', i18n.t('validation.username.invalid_format'));
    }

    const authConfig = {
      captchaLogin: false,
      captchaRegister: false,
      turnstileSiteKey: '',
      loginEmailCode: false,
      registrationEnabled: true,
      passwordMinLength: null
    };

    let turnstileScript;
    function loadTurnstile() {
      if (window.turnstile) return Promise.resolve(window.turnstile);
      if (!turnstileScript) {
        turnstileScript = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
          script.async = true;
          script.onload = () => window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile did not load'));
          script.onerror = () => {
            script.remove();
            reject(new Error('Turnstile did not load'));
          };
          document.head.appendChild(script);
        }).catch(error => {
          turnstileScript = null;
          throw error;
        });
      }
      return turnstileScript;
    }

    function loginStepVisible() {
      return loginStep === 'password';
    }

    function setupCaptchaWidget(form, action) {
      const group = form.querySelector('[data-captcha-group]');
      const box = form.querySelector('[data-captcha-box]');
      if (!group || !box) return null;
      const imageGroup = form.querySelector('[data-image-captcha]');
      const turnstileHost = form.querySelector('[data-turnstile-widget]');
      const turnstileInput = form.querySelector('input[name="turnstile_response"]');
      const idInput = form.querySelector('input[name="captcha_id"]');
      const codeInput = form.querySelector('input[name="captcha_code"]');
      let widgetId = null;
      let widgetSize = null;
      let widgetRevision = 0;
      let rendering = null;

      function turnstileSize() {
        return turnstileHost.getBoundingClientRect().width >= 300 ? 'flexible' : 'compact';
      }

      function removeTurnstileWidget() {
        widgetRevision += 1;
        turnstileInput.value = '';
        if (widgetId !== null) window.turnstile.remove(widgetId);
        widgetId = null;
        widgetSize = null;
      }

      async function refresh() {
        if (form === loginForm && !loginStepVisible()) {
          turnstileInput.value = '';
          return;
        }
        if (authConfig.turnstileSiteKey) {
          turnstileInput.value = '';
          if (group.hidden || form.closest('[data-card]').classList.contains('hidden') || authRegion.classList.contains('hidden')) return;
          if (widgetId !== null) {
            if (widgetSize === turnstileSize()) {
              window.turnstile.reset(widgetId);
              return;
            }
            removeTurnstileWidget();
          }
          if (rendering) return rendering;
          rendering = loadTurnstile().then(api => {
            if (group.hidden || form.closest('[data-card]').classList.contains('hidden') || authRegion.classList.contains('hidden')) return;
            if (form === loginForm && !loginStepVisible()) return;
            turnstileHost.replaceChildren();
            const revision = ++widgetRevision;
            const setToken = token => {
              if (revision === widgetRevision && !group.hidden
                && !form.closest('[data-card]').classList.contains('hidden')
                && !authRegion.classList.contains('hidden')) turnstileInput.value = token;
            };
            widgetSize = turnstileSize();
            widgetId = api.render(turnstileHost, {
              sitekey: authConfig.turnstileSiteKey,
              action,
              size: widgetSize,
              callback: setToken,
              'expired-callback': () => { setToken(''); },
              'error-callback': () => { setToken(''); }
            });
          }).catch(() => {
            turnstileHost.textContent = i18n.t('turnstile.unavailable');
          }).finally(() => { rendering = null; });
          return rendering;
        }
        try {
          const response = await fetch('/api/captcha');
          const data = await response.json();
          idInput.value = data.id;
          codeInput.value = '';
          const captchaImage = document.createElement('img');
          captchaImage.src = data.image;
          captchaImage.alt = '图形验证码';
          captchaImage.style.maxWidth = '100%';
          box.replaceChildren(captchaImage);
        } catch (error) {
          box.innerHTML = '<span class="material-symbols-outlined text-muted">error</span>';
        }
      }

      if (window.ResizeObserver) {
        new ResizeObserver(() => {
          if (widgetId !== null && !group.hidden
            && !form.closest('[data-card]').classList.contains('hidden')
            && !authRegion.classList.contains('hidden') && widgetSize !== turnstileSize()) refresh();
        }).observe(turnstileHost);
      }

      box.addEventListener('click', refresh);
      return {
        refresh,
        isVisible() { return !group.hidden; },
        setVisible(visible) {
          group.hidden = !visible;
          imageGroup.hidden = Boolean(authConfig.turnstileSiteKey);
          turnstileHost.hidden = !authConfig.turnstileSiteKey;
          if (visible) {
            refresh();
          } else {
            removeTurnstileWidget();
            idInput.value = '';
            codeInput.value = '';
            box.innerHTML = '<span class="material-symbols-outlined text-muted">refresh</span>';
          }
        }
      };
    }

    const loginCaptcha = setupCaptchaWidget(loginForm, 'login');
    const registerCaptcha = setupCaptchaWidget(registerForm, 'register');

    function renderPasswordGuidance() {
      const hint = i18n.passwordGuidance(authConfig.passwordMinLength);
      [setupPassword, document.getElementById('registerPassword'), document.getElementById('recoverPassword')].forEach(input => {
        input.placeholder = hint;
      });
    }

    async function hydrateAuthConfig() {
      authConfig.passwordMinLength = null;
      renderPasswordGuidance();
      try {
        const configUrl = new URL('/api/auth/config', window.location.origin);
        configUrl.searchParams.set('surface', 'web');
        // 让服务端能按客户端判定注册策略（如 QFLI 客户端只能经华为账号建号）。
        if (oauthParams.client_id) configUrl.searchParams.set('client_id', oauthParams.client_id);
        const response = await fetch(configUrl.toString());
        if (response.ok) Object.assign(authConfig, await response.json());
      } catch (error) {
        console.error('Load auth config failed:', error);
      }

      renderPasswordGuidance();

      if (loginCaptcha && !loginForm.closest('[data-card]').classList.contains('hidden')) {
        loginCaptcha.setVisible(Boolean(loginStep === 'password' && authConfig.captchaLogin && authConfig.turnstileSiteKey));
      }
      if (registerCaptcha) registerCaptcha.setVisible(authConfig.captchaRegister
        && !registerForm.closest('[data-card]').classList.contains('hidden'));

      const registerTab = tabButtons.find(button => button.dataset.mode === 'register');
      if (registerTab && !authConfig.registrationEnabled) {
        registerTab.hidden = true;
        if (registerTab.classList.contains('active')) setMode('login');
        const next = registerTab.nextElementSibling;
        if (next) next.hidden = true;
      }
      const oauthOnlyNotice = document.getElementById('oauthOnlyRegistrationNotice');
      if (oauthOnlyNotice) oauthOnlyNotice.hidden = authConfig.registrationDisabledReason !== 'oauth_only';
    }

    function getClientLabel() {
      return oauthParams.client_id || i18n.t('common.app_fallback');
    }

    async function hydrateOidcLogin() {
      try {
        const response = await fetch('/api/v1/auth/oauth/oidc/config', { credentials: 'same-origin' });
        const config = await response.json();
        if (!config.enabled) return;
        const returnTo = hasOAuthRequest ? window.location.pathname + window.location.search : '';
        const providers = Array.isArray(config.providers) && config.providers.length
          ? config.providers
          : [{ providerName: config.providerName, loginUrl: config.loginUrl }];
        oidcProviders.innerHTML = providers.map(provider => {
          const loginUrl = new URL(provider.loginUrl, window.location.origin);
          if (returnTo) loginUrl.searchParams.set('return_to', returnTo);
          loginUrl.searchParams.set('session_days', loginSessionDays.value);
          return `<a class="oidc-submit" href="${escapeHtml(loginUrl.toString())}"><span class="material-symbols-outlined">login</span><span>${escapeHtml(i18n.t('auth.oidc.login'))} · ${escapeHtml(provider.providerName)}</span></a>`;
        }).join('');
        oidcDivider.hidden = false;
      } catch (error) {
        console.error('OIDC configuration request failed:', error);
      }
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function updateOidcSessionDays() {
      oidcProviders.querySelectorAll('a').forEach(function (link) {
        const loginUrl = new URL(link.href);
        loginUrl.searchParams.set('session_days', loginSessionDays.value);
        link.href = loginUrl.toString();
      });
    }

    function clearStatus() {
      feedbackRevision += 1;
      statusMessage.className = 'status-box';
      statusMessage.textContent = '';
    }

    const STEP_FIELDS = {
      account: ['account', 'duration'],
      password: ['account', 'password', 'duration'],
      setup: [],
      contact: []
    };

    function stepSubmitButton(step) {
      if (step === 'setup') return passwordSetupForm.querySelector('.submit');
      if (step === 'contact') return loginContactAdmin;
      return loginPrimarySubmit;
    }

    function anchorStatus(step) {
      const anchor = stepSubmitButton(step);
      if (anchor) anchor.insertAdjacentElement('afterend', statusMessage);
    }

    function clearSetupState() {
      stopSetupCooldown();
      passwordSetupForm.reset();
      setupEmailMasked.textContent = '';
      const setupSubmit = passwordSetupForm.querySelector('.submit');
      setupSubmit.disabled = false;
      setupSubmit.dataset.i18n = 'auth.button.set_password';
      setupSubmit.textContent = i18n.t('auth.button.set_password');
    }

    let authActionToken = 0;
    let authActionActive = false;

    function beginAuthAction() {
      if (authActionActive) return 0;
      authActionActive = true;
      authActionToken += 1;
      return authActionToken;
    }

    function isCurrentAuthAction(token) {
      return Boolean(token) && authActionActive && token === authActionToken;
    }

    function endAuthAction(token) {
      if (!isCurrentAuthAction(token)) return;
      authActionActive = false;
    }

    function invalidateAuthAction() {
      authActionToken += 1;
      authActionActive = false;
    }

    let setupCooldownTimer = null;
    let setupCooldownRemaining = 0;

    function renderSetupCooldown() {
      if (setupCooldownRemaining > 0) {
        sendSetupCodeBtn.disabled = true;
        sendSetupCodeBtn.textContent = i18n.t('auth.status.resend_in', { seconds: setupCooldownRemaining });
        return;
      }
      sendSetupCodeBtn.disabled = false;
      sendSetupCodeBtn.textContent = i18n.t('auth.button.send_code');
    }

    function stopSetupCooldown() {
      if (setupCooldownTimer) {
        clearInterval(setupCooldownTimer);
        setupCooldownTimer = null;
      }
      setupCooldownRemaining = 0;
      renderSetupCooldown();
    }

    function startSetupCooldown(seconds) {
      if (setupCooldownTimer) {
        clearInterval(setupCooldownTimer);
        setupCooldownTimer = null;
      }
      setupCooldownRemaining = Math.max(0, Number(seconds) || 0);
      renderSetupCooldown();
      if (!setupCooldownRemaining) return;
      setupCooldownTimer = setInterval(function () {
        setupCooldownRemaining = Math.max(0, setupCooldownRemaining - 1);
        if (!setupCooldownRemaining) {
          stopSetupCooldown();
          return;
        }
        renderSetupCooldown();
      }, 1000);
    }

    function applyLoginStepLabels() {
      loginPrimarySubmit.dataset.i18n = loginStep === 'account' ? 'auth.button.continue' : 'auth.button.login';
      loginPrimarySubmit.textContent = i18n.t(loginPrimarySubmit.dataset.i18n);
    }

    function setLoginStep(step) {
      loginStep = step;
      modeRevision += 1;
      invalidateAuthAction();
      if (step === 'account') clearSetupState();

      cards.forEach(function (card) {
        card.classList.toggle('hidden', card.dataset.card !== 'login');
      });
      tabButtons.forEach(function (button) {
        button.classList.toggle('active', button.dataset.mode === 'login');
      });

      loginForm.querySelectorAll('[data-login-step]').forEach(function (group) {
        group.hidden = !STEP_FIELDS[step].includes(group.dataset.loginStep);
      });
      passwordSetupForm.hidden = step !== 'setup';
      loginContactAdmin.hidden = step !== 'contact';
      changeLoginAccountBtn.hidden = step === 'account';
      document.getElementById('showRecoveryBtn').hidden = step !== 'password';
      loginPrimarySubmit.hidden = step !== 'account' && step !== 'password';
      loginPrimarySubmit.disabled = false;
      passwordSetupForm.querySelector('.submit').disabled = false;
      renderSetupCooldown();
      oidcDivider.hidden = step === 'setup' || step === 'contact';
      oidcProviders.hidden = step === 'setup' || step === 'contact';

      const passwordInput = loginForm.querySelector('input[name="password"]');
      const passwordActive = step === 'password';
      passwordInput.disabled = !passwordActive;
      if (passwordActive) {
        passwordInput.setAttribute('required', 'required');
      } else {
        passwordInput.removeAttribute('required');
      }

      applyLoginStepLabels();
      if (loginCaptcha) {
        loginCaptcha.setVisible(Boolean(passwordActive && authConfig.captchaLogin && authConfig.turnstileSiteKey));
      }

      anchorStatus(step);
      clearStatus();
    }

    function setMode(mode) {
      // 邮箱注册入口被关闭（如 QFLI 客户端只能经华为账号建号）时不得停留在注册卡片。
      if (mode === 'register' && !authConfig.registrationEnabled) mode = 'login';
      modeRevision += 1;
      tabButtons.forEach(function (button) {
        button.classList.toggle('active', button.dataset.mode === mode);
      });

      cards.forEach(function (card) {
        card.classList.toggle('hidden', card.dataset.card !== mode);
      });

      if (mode === 'login') {
        setLoginStep('account');
        return;
      }

      invalidateAuthAction();
      clearSetupState();

      const activeForm = cards.find(function (card) {
        return card.dataset.card === mode;
      });
      const submit = activeForm.querySelector('.submit');
      if (submit) submit.insertAdjacentElement('afterend', statusMessage);

      if (loginCaptcha) loginCaptcha.setVisible(false);
      if (registerCaptcha) registerCaptcha.setVisible(Boolean(mode === 'register' && authConfig.captchaRegister));

      clearStatus();
    }

    function setStatus(kind, message, requestFeedbackRevision = feedbackRevision) {
      if (requestFeedbackRevision !== feedbackRevision) return;
      if (!kind || !message) {
        clearStatus();
        return;
      }

      const colorMap = {
        error: 'is-error',
        success: 'is-success'
      };

      statusMessage.className = `status-box is-visible ${colorMap[kind] || 'is-info'}`;
      statusMessage.textContent = message;
      statusMessage.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function setSignedInState(isSignedIn) {
      sessionBanner.classList.toggle('hidden', !isSignedIn);
      authRegion.classList.toggle('hidden', isSignedIn);
      if (!isSignedIn && loginCaptcha?.isVisible()) loginCaptcha.refresh();
      if (!isSignedIn && registerCaptcha?.isVisible()) registerCaptcha.refresh();

      if (isSignedIn) {
        clearStatus();
      }
    }

    function fillHiddenFields(form) {
      Object.keys(oauthParams).forEach(function (key) {
        const input = form.querySelector(`input[name="${key}"]`);
        if (input) {
          input.value = oauthParams[key];
          if (key === 'code_challenge' || key === 'code_challenge_method') {
            input.disabled = !urlParams.has(key);
          }
        }
      });
    }

    function renderPage() {
      i18n.apply(document);
      renderPasswordGuidance();
      document.title = i18n.t('auth.page.title');
      applyLoginStepLabels();

      if (hasOAuthRequest) {
        document.getElementById('panelTitle').textContent = i18n.t('auth.panel.oauth_title', {
          client: getClientLabel()
        });
        document.getElementById('panelDescription').textContent = i18n.t('auth.panel.oauth_description');
      } else {
        document.getElementById('panelTitle').textContent = i18n.t('auth.panel.default_title');
        document.getElementById('panelDescription').textContent = i18n.t('auth.panel.default_description');
      }
    }

    async function hydrateSessionBanner() {
      try {
        const response = await fetch('/api/profile', {
          credentials: 'same-origin'
        });

        if (!response.ok) {
          setSignedInState(false);
          return;
        }

        const payload = await response.json();
        const user = payload.user;
        document.getElementById('sessionBannerTitle').textContent = i18n.t('auth.session.title', {
          user: user.name || user.username
        });
        document.getElementById('sessionBannerText').textContent = i18n.t('auth.session.default_text');
        setSignedInState(true);
      } catch (error) {
        console.error('Session banner error:', error);
        setSignedInState(false);
      }
    }

    async function handleLogout() {
      const originalLabel = logoutButton.textContent;
      logoutButton.disabled = true;

      try {
        await fetch('/oauth2/logout', {
          credentials: 'same-origin'
        });

        loginForm.reset();
        registerForm.reset();
        recoverForm.reset();
        setMode('login');
        setSignedInState(false);
        document.getElementById('loginUsername').focus();
      } catch (error) {
        console.error('Logout failed:', error);
        window.location.href = '/oauth2/logout';
      } finally {
        logoutButton.disabled = false;
        logoutButton.textContent = originalLabel;
      }
    }

    async function submitAuthForm(form, endpoint, loadingKey) {
      if (form.dataset.busy === 'true') return;
      form.dataset.busy = 'true';
      setStatus('', '');
      const requestModeRevision = modeRevision;
      const requestFeedbackRevision = feedbackRevision;

      const submitButton = form.querySelector('.submit');
      const originalLabel = submitButton.textContent;
      const payload = new URLSearchParams(new FormData(form));

      submitButton.disabled = true;
      submitButton.textContent = i18n.t(loadingKey);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: payload
        });

        const result = await response.json();
        const usedCaptcha = form === loginForm ? loginCaptcha : form === registerForm ? registerCaptcha : null;
        if (authConfig.turnstileSiteKey && usedCaptcha?.isVisible()) usedCaptcha.refresh();
        if (requestModeRevision !== modeRevision) return;

        if (response.ok && result?.mfa_url && form === loginForm) {
          loginForm.querySelector('input[name="password"]').value = '';
          window.location.assign('/oauth2/mfa');
          return;
        }

        if (!response.ok) {
          if (result?.error_key === 'turnstile.required' && !authConfig.turnstileSiteKey) {
            await hydrateAuthConfig();
            if (requestModeRevision !== modeRevision) return;
            if (!authConfig.turnstileSiteKey) {
              setStatus('error', i18n.t('turnstile.unavailable'), requestFeedbackRevision);
              return;
            }
          }
          if (result?.error_key === 'auth.password.not_set' && form === loginForm) {
            const typedUsername = new URLSearchParams(new FormData(form)).get('username') || '';
            const message = i18n.resolveMessage(result, 'auth.password.not_set');
            await rediscoverAccount(typedUsername, { message });
            return;
          }
          if (['captcha.required', 'turnstile.required'].includes(result?.error_key) && form === loginForm && loginCaptcha) {
            loginCaptcha.setVisible(true);
            if (!authConfig.turnstileSiteKey) loginForm.querySelector('input[name="captcha_code"]').focus();
          }
          if (result?.error_key === 'captcha.invalid' || result?.error_key === 'captcha.expired') {
            if (form === loginForm && loginCaptcha) loginCaptcha.refresh();
            if (form === registerForm && registerCaptcha) registerCaptcha.refresh();
          }
          setStatus('error', i18n.resolveMessage(result, 'common.network_error', {
            client: getClientLabel()
          }), requestFeedbackRevision);
          return;
        }

        if (result.redirect) {
          setStatus('success', i18n.resolveMessage(result, 'auth.status.redirecting'), requestFeedbackRevision);
          window.location.href = result.redirect;
          return;
        }

        loginForm.reset();
        registerForm.reset();
        setMode('login');
        await hydrateSessionBanner();
      } catch (error) {
        console.error('Auth request failed:', error);
        const failedCaptcha = form === loginForm ? loginCaptcha : form === registerForm ? registerCaptcha : null;
        if (authConfig.turnstileSiteKey && failedCaptcha?.isVisible()) failedCaptcha.refresh();
        if (requestModeRevision === modeRevision) {
          setStatus('error', i18n.t('common.network_error'), requestFeedbackRevision);
        }
      } finally {
        form.dataset.busy = 'false';
        submitButton.disabled = false;
        if (form === loginForm) {
          applyLoginStepLabels();
        } else {
          submitButton.textContent = originalLabel;
        }
      }
    }

    function buildDiscoveryPayload(username) {
      const payload = { discover_account: true, username };
      ['client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'response_type'].forEach(function (key) {
        if (urlParams.has(key)) payload[key] = oauthParams[key];
      });
      if (urlParams.has('code_challenge')) {
        payload.code_challenge = oauthParams.code_challenge;
        payload.code_challenge_method = oauthParams.code_challenge_method;
      }
      return payload;
    }

    function resetToAccountStep() {
      loginForm.querySelector('input[name="password"]').value = '';
      clearSetupState();
      setLoginStep('account');
      document.getElementById('loginUsername').focus();
    }

    async function rediscoverAccount(username, options = {}) {
      const account = String(username || '').trim();
      const token = beginAuthAction();
      if (!token) return;

      setStatus('', '');
      const requestRevision = modeRevision;
      const requestFeedbackRevision = feedbackRevision;

      if (!account) {
        endAuthAction(token);
        setLoginStep('account');
        setStatus('error', i18n.t('validation.username.required'), feedbackRevision);
        return;
      }

      loginPrimarySubmit.textContent = i18n.t('auth.status.checking');

      try {
        const response = await fetch('/oauth2/authorize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(buildDiscoveryPayload(account))
        });
        const result = await response.json().catch(function () { return {}; });
        if (requestRevision !== modeRevision || !isCurrentAuthAction(token)) return;

        if (!response.ok) {
          setStatus('error', i18n.resolveMessage(result, 'common.network_error', {
            client: getClientLabel()
          }), requestFeedbackRevision);
          return;
        }

        if (result.next === 'set_password') {
          setupEmailMasked.textContent = result.email_masked || '';
          setLoginStep('setup');
          setStatus('success', i18n.t('auth.setup.code_hint', { email: result.email_masked || '' }), feedbackRevision);
          setupEmailCode.focus();
          return;
        }

        if (result.next === 'contact_admin') {
          setLoginStep('contact');
          return;
        }

        setLoginStep('password');
        if (options.message) setStatus('error', options.message, feedbackRevision);
        loginForm.querySelector('input[name="password"]').focus();
      } catch (error) {
        console.error('Account discovery failed:', error);
        if (requestRevision === modeRevision && isCurrentAuthAction(token)) {
          setStatus('error', i18n.t('common.network_error'), requestFeedbackRevision);
        }
      } finally {
        if (isCurrentAuthAction(token)) {
          endAuthAction(token);
          applyLoginStepLabels();
        }
      }
    }

    async function sendSetupCode(button) {
      const account = String(loginForm.querySelector('input[name="username"]').value || '').trim();
      const token = beginAuthAction();
      if (!token) return;

      setStatus('', '');
      const requestRevision = modeRevision;
      const requestFeedbackRevision = feedbackRevision;

      button.disabled = true;
      button.textContent = i18n.t('auth.status.sending_code');

      try {
        const response = await fetch('/api/email-verification/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ username: String(account || '').trim(), purpose: 'password_reset' })
        });
        const result = await response.json().catch(function () { return {}; });
        if (requestRevision !== modeRevision || !isCurrentAuthAction(token)) return;

        if (!response.ok) {
          if (result?.error_key === 'auth.password.contact_admin') {
            setLoginStep('contact');
            return;
          }
          if (result?.error_key === 'auth.password.setup_changed') {
            resetToAccountStep();
            await rediscoverAccount(account, { message: i18n.resolveMessage(result, 'auth.password.setup_changed') });
            return;
          }
          setStatus('error', i18n.resolveMessage(result, 'common.network_error'), requestFeedbackRevision);
          return;
        }

        setStatus('success', i18n.resolveMessage(result, 'auth.status.code_sent'), requestFeedbackRevision);
        startSetupCooldown(60);
      } catch (error) {
        console.error('Send setup code failed:', error);
        if (requestRevision === modeRevision && isCurrentAuthAction(token)) {
          setStatus('error', i18n.t('common.network_error'), requestFeedbackRevision);
        }
      } finally {
        if (isCurrentAuthAction(token)) {
          endAuthAction(token);
          renderSetupCooldown();
        }
      }
    }

    async function submitSetup() {
      const account = String(loginForm.querySelector('input[name="username"]').value || '').trim();
      const password = setupPassword.value;
      const confirmPassword = setupConfirmPassword.value;
      setStatus('', '');
      const requestRevision = modeRevision;
      const requestFeedbackRevision = feedbackRevision;

      if (password !== confirmPassword) {
        setStatus('error', i18n.t('auth.status.password_mismatch'), requestFeedbackRevision);
        return;
      }

      const token = beginAuthAction();
      if (!token) return;

      const submitButton = passwordSetupForm.querySelector('.submit');
      submitButton.disabled = true;
      submitButton.textContent = i18n.t('auth.status.saving_password');

      try {
        const response = await fetch('/api/password-reset', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({
            username: String(account || '').trim(),
            email_code: setupEmailCode.value,
            password,
            confirm_password: confirmPassword
          })
        });
        const result = await response.json().catch(function () { return {}; });
        if (requestRevision !== modeRevision || !isCurrentAuthAction(token)) return;

        if (!response.ok) {
          if (result?.error_key === 'auth.password.setup_changed') {
            resetToAccountStep();
            await rediscoverAccount(account, { message: i18n.resolveMessage(result, 'auth.password.setup_changed') });
            return;
          }
          if (result?.error_key === 'auth.password.contact_admin') {
            setLoginStep('contact');
            return;
          }
          setStatus('error', i18n.resolveMessage(result, 'common.network_error'), requestFeedbackRevision);
          return;
        }

        clearSetupState();
        loginForm.querySelector('input[name="password"]').value = '';
        setLoginStep('password');
        setStatus('success', i18n.t('auth.status.password_set'), feedbackRevision);
        loginForm.querySelector('input[name="password"]').focus();
      } catch (error) {
        console.error('First password setup failed:', error);
        if (requestRevision === modeRevision && isCurrentAuthAction(token)) {
          setStatus('error', i18n.t('common.network_error'), requestFeedbackRevision);
        }
      } finally {
        if (isCurrentAuthAction(token)) {
          endAuthAction(token);
          submitButton.disabled = false;
          submitButton.textContent = i18n.t('auth.button.set_password');
        }
      }
    }

    async function sendEmailCode(email, purpose, button) {
      const requestModeRevision = modeRevision;
      const originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = i18n.t('auth.status.sending_code');
      setStatus('', '');
      const requestFeedbackRevision = feedbackRevision;

      try {
        const payload = new URLSearchParams({ email, purpose });
        const response = await fetch('/api/email-verification/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: payload
        });
        const result = await response.json();
        if (requestModeRevision !== modeRevision) return;

        if (!response.ok) {
          setStatus('error', i18n.resolveMessage(result, 'common.network_error'), requestFeedbackRevision);
          return;
        }

        setStatus('success', i18n.resolveMessage(result, 'auth.status.code_sent'), requestFeedbackRevision);
      } catch (error) {
        console.error('Send email code failed:', error);
        if (requestModeRevision === modeRevision) {
          setStatus('error', i18n.t('common.network_error'), requestFeedbackRevision);
        }
      } finally {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }

    async function submitPasswordReset() {
      setStatus('', '');
      const requestModeRevision = modeRevision;
      const requestFeedbackRevision = feedbackRevision;
      const password = recoverForm.querySelector('input[name="password"]').value;
      const confirmPassword = recoverForm.querySelector('input[name="confirm_password"]').value;

      if (password !== confirmPassword) {
        setMode('recover');
        setStatus('error', i18n.t('auth.status.password_mismatch'));
        return;
      }

      const submitButton = recoverForm.querySelector('.submit');
      const originalLabel = submitButton.textContent;
      submitButton.disabled = true;
      submitButton.textContent = i18n.t('auth.status.resetting');

      try {
        const response = await fetch('/api/password-reset', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams(new FormData(recoverForm))
        });
        const result = await response.json();
        if (requestModeRevision !== modeRevision) return;

        if (!response.ok) {
          setStatus('error', i18n.resolveMessage(result, 'common.network_error'), requestFeedbackRevision);
          return;
        }

        loginForm.querySelector('input[name="username"]').value = recoverForm.querySelector('input[name="email"]').value;
        recoverForm.reset();
        setMode('login');
        setStatus('success', i18n.resolveMessage(result, 'auth.status.password_reset_done'));
      } catch (error) {
        console.error('Password reset failed:', error);
        if (requestModeRevision === modeRevision) {
          setStatus('error', i18n.t('common.network_error'), requestFeedbackRevision);
        }
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    }

    tabButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        setMode(button.dataset.mode);
      });
    });

    fillHiddenFields(loginForm);
    fillHiddenFields(registerForm);
    setMode('login');
    renderPage();
    hydrateAuthConfig();
    hydrateOidcLogin();
    i18n.bindLanguageButtons(document);
    hydrateSessionBanner();

    loginForm.addEventListener('reset', function () {
      // Reset values are applied after the reset event itself.
      queueMicrotask(updateOidcSessionDays);
      if (loginCaptcha) loginCaptcha.setVisible(Boolean(loginStep === 'password' && authConfig.captchaLogin && authConfig.turnstileSiteKey));
    });

    loginSessionDays.addEventListener('change', updateOidcSessionDays);

    registerForm.addEventListener('reset', function () {
      registerUsernameComposing = false;
      if (registerCaptcha?.isVisible()) registerCaptcha.refresh();
    });

    registerUsername.addEventListener('compositionstart', function () {
      registerUsernameComposing = true;
    });
    registerUsername.addEventListener('compositionend', function () {
      registerUsernameComposing = false;
      filterRegisterUsername();
    });
    registerUsername.addEventListener('input', function (event) {
      if (!registerUsernameComposing && !event.isComposing) filterRegisterUsername();
    });
    registerUsername.addEventListener('paste', function (event) {
      if (registerUsernameComposing || !event.clipboardData) return;
      // Filter before maxlength truncates a raw paste and discards its valid suffix.
      event.preventDefault();
      filterRegisterUsername();
      const start = registerUsername.selectionStart;
      const end = registerUsername.selectionEnd;
      const remaining = 255 - (registerUsername.value.length - (end - start));
      const pasted = usernameCharacters(event.clipboardData.getData('text/plain')).slice(0, remaining);
      registerUsername.setRangeText(pasted, start, end, 'end');
      registerUsername.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: pasted }));
    });
    registerUsername.addEventListener('change', function () {
      if (!registerUsernameComposing) filterRegisterUsername();
    });
    registerUsername.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (registerUsernameComposing || event.isComposing || event.keyCode === 229)) event.preventDefault();
    });
    registerUsername.addEventListener('invalid', function (event) {
      // Native pattern validation runs before the form submit event.
      event.preventDefault();
      if (!registerUsernameComposing) showRegisterUsernameError();
    });

    document.addEventListener('vaultsso:languagechange', function () {
      renderPage();
      hydrateSessionBanner();
    });

    loginForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (loginStep === 'account') {
        rediscoverAccount(loginForm.querySelector('input[name="username"]').value);
        return;
      }
      if (loginStep !== 'password') return;
      submitAuthForm(loginForm, '/oauth2/authorize', 'auth.status.signing_in');
    });

    loginForm.querySelector('input[name="username"]').addEventListener('input', function () {
      if (loginStep !== 'account') {
        resetToAccountStep();
        return;
      }
      modeRevision += 1;
      invalidateAuthAction();
    });

    passwordSetupForm.addEventListener('submit', function (event) {
      event.preventDefault();
      submitSetup();
    });

    sendSetupCodeBtn.addEventListener('click', function () {
      sendSetupCode(this);
    });

    changeLoginAccountBtn.addEventListener('click', function () {
      resetToAccountStep();
    });

    document.getElementById('showRecoveryBtn').addEventListener('click', function () {
      recoverForm.querySelector('input[name="email"]').value = loginForm.querySelector('input[name="username"]').value;
      setMode('recover');
    });

    document.getElementById('backToLoginBtn').addEventListener('click', function () {
      setMode('login');
    });

    document.getElementById('sendRegisterCodeBtn').addEventListener('click', function () {
      sendEmailCode(registerForm.querySelector('input[name="email"]').value, 'register', this);
    });

    document.getElementById('sendRecoveryCodeBtn').addEventListener('click', function () {
      sendEmailCode(recoverForm.querySelector('input[name="email"]').value, 'password_reset', this);
    });

    registerForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (registerUsernameComposing) return;

      const username = registerUsername.value;
      if (username.trim() && (username.length > 255 || /[^A-Za-z0-9_]/.test(username))) {
        showRegisterUsernameError();
        return;
      }

      const password = registerForm.querySelector('input[name="password"]').value;
      const confirmPassword = registerForm.querySelector('input[name="confirm_password"]').value;

      if (password !== confirmPassword) {
        setMode('register');
        setStatus('error', i18n.t('auth.status.password_mismatch'));
        return;
      }

      submitAuthForm(registerForm, '/oauth2/register', 'auth.status.creating');
    });

    recoverForm.addEventListener('submit', function (event) {
      event.preventDefault();
      submitPasswordReset();
    });

    logoutButton.addEventListener('click', function () {
      handleLogout();
    });

    sessionEntry.addEventListener('click', function (event) {
      if (event.target.closest('#logoutButton')) {
        return;
      }

      window.location.href = '/profile';
    });

    sessionEntry.addEventListener('keydown', function (event) {
      if (event.target.closest('#logoutButton')) {
        return;
      }

      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      window.location.href = '/profile';
    });

    if (urlParams.has('oidc_error')) {
      setStatus('error', i18n.resolveMessage({
        error_description: urlParams.get('oidc_error_description')
      }, 'common.request_error'));
    }
