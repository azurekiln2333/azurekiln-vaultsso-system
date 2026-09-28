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
    const registerForm = document.getElementById('registerForm');
    const recoverForm = document.getElementById('recoverForm');
    const authRegion = document.getElementById('authRegion');
    const sessionBanner = document.getElementById('sessionBanner');
    const sessionEntry = document.getElementById('sessionEntry');
    const logoutButton = document.getElementById('logoutButton');
    const oauthCard = document.getElementById('oauthCard');
    const oidcDivider = document.getElementById('oidcDivider');
    const oidcProviders = document.getElementById('oidcProviders');
    let modeRevision = 0;
    let feedbackRevision = 0;

    const authConfig = {
      captchaLogin: false,
      captchaRegister: false,
      turnstileSiteKey: '',
      loginEmailCode: false,
      registrationEnabled: true,
      passwordMinLength: 12
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
      let rendering = null;

      async function refresh() {
        if (authConfig.turnstileSiteKey) {
          turnstileInput.value = '';
          if (group.hidden || form.closest('[data-card]').classList.contains('hidden') || authRegion.classList.contains('hidden')) return;
          if (widgetId !== null) {
            window.turnstile.reset(widgetId);
            return;
          }
          if (rendering) return rendering;
          rendering = loadTurnstile().then(api => {
            if (group.hidden || form.closest('[data-card]').classList.contains('hidden') || authRegion.classList.contains('hidden')) return;
            turnstileHost.replaceChildren();
            widgetId = api.render(turnstileHost, {
              sitekey: authConfig.turnstileSiteKey,
              action,
              size: window.innerWidth < 380 ? 'compact' : 'normal',
              callback: token => { turnstileInput.value = token; },
              'expired-callback': () => { turnstileInput.value = ''; },
              'error-callback': () => { turnstileInput.value = ''; }
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
            if (widgetId !== null) {
              window.turnstile.remove(widgetId);
              widgetId = null;
            }
            turnstileInput.value = '';
            idInput.value = '';
            codeInput.value = '';
            box.innerHTML = '<span class="material-symbols-outlined text-muted">refresh</span>';
          }
        }
      };
    }

    const loginCaptcha = setupCaptchaWidget(loginForm, 'login');
    const registerCaptcha = setupCaptchaWidget(registerForm, 'register');

    async function hydrateAuthConfig() {
      try {
        const response = await fetch('/api/auth/config?surface=web');
        if (response.ok) Object.assign(authConfig, await response.json());
      } catch (error) {
        console.error('Load auth config failed:', error);
      }

      if (loginCaptcha && !loginForm.closest('[data-card]').classList.contains('hidden')) {
        loginCaptcha.setVisible(Boolean(authConfig.captchaLogin && authConfig.turnstileSiteKey));
      }
      if (registerCaptcha) registerCaptcha.setVisible(authConfig.captchaRegister
        && !registerForm.closest('[data-card]').classList.contains('hidden'));

      const registerTab = tabButtons.find(button => button.dataset.mode === 'register');
      if (registerTab && !authConfig.registrationEnabled) {
        registerTab.hidden = true;
      }
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

    function clearStatus() {
      feedbackRevision += 1;
      statusMessage.className = 'status-box';
      statusMessage.textContent = '';
    }

    function setMode(mode) {
      modeRevision += 1;
      tabButtons.forEach(function (button) {
        button.classList.toggle('active', button.dataset.mode === mode);
      });

      cards.forEach(function (card) {
        card.classList.toggle('hidden', card.dataset.card !== mode);
      });
      const activeForm = cards.find(function (card) {
        return card.dataset.card === mode;
      });
      activeForm.querySelector('.submit').insertAdjacentElement('afterend', statusMessage);

      if (loginCaptcha) loginCaptcha.setVisible(Boolean(mode === 'login' && authConfig.captchaLogin && authConfig.turnstileSiteKey));
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
      document.title = i18n.t('auth.page.title');

      if (hasOAuthRequest) {
        document.getElementById('panelTitle').textContent = i18n.t('auth.panel.oauth_title', {
          client: getClientLabel()
        });
        document.getElementById('panelDescription').textContent = i18n.t('auth.panel.oauth_description');
        document.getElementById('oauthClientName').textContent = getClientLabel();
        document.getElementById('oauthDescription').textContent = i18n.t('auth.oauth.description');
        document.getElementById('redirectUriPreview').textContent = oauthParams.redirect_uri;

        const scopeList = document.getElementById('scopeList');
        scopeList.innerHTML = '';
        oauthParams.scope.split(' ').filter(Boolean).forEach(function (scope) {
          const chip = document.createElement('span');
          chip.className = 'scope-chip';
          chip.textContent = scope;
          scopeList.appendChild(chip);
        });

        oauthCard.classList.remove('hidden');
      } else {
        document.getElementById('panelTitle').textContent = i18n.t('auth.panel.default_title');
        document.getElementById('panelDescription').textContent = i18n.t('auth.panel.default_description');
        oauthCard.classList.add('hidden');
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
            if (typedUsername.includes('@')) {
              recoverForm.querySelector('input[name="email"]').value = typedUsername;
            }
            loginForm.reset();
            setMode('recover');
            setStatus('error', i18n.resolveMessage(result, 'auth.password.not_set'));
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
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
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
      if (loginCaptcha) loginCaptcha.setVisible(Boolean(authConfig.captchaLogin && authConfig.turnstileSiteKey));
    });

    registerForm.addEventListener('reset', function () {
      if (registerCaptcha?.isVisible()) registerCaptcha.refresh();
    });

    document.addEventListener('vaultsso:languagechange', function () {
      renderPage();
      hydrateSessionBanner();
    });

    loginForm.addEventListener('submit', function (event) {
      event.preventDefault();
      submitAuthForm(loginForm, '/oauth2/authorize', 'auth.status.signing_in');
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
