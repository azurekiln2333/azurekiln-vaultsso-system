'use strict';

const crypto = require('node:crypto');
const phoneAuth = require('./phone-auth');
const PhoneChallenge = require('../models/PhoneChallenge');
const UserModel = require('../models/User');
const SessionModel = require('../models/Session');
const TokenModel = require('../models/Token');
const RateLimitModel = require('../models/RateLimit');
const EmailVerificationCodeModel = require('../models/EmailVerificationCode');
const { isQfliClient } = require('./qfli-integration');

const TTL = 5 * 60 * 1000;
const PURPOSE = PhoneChallenge.PURPOSES;

// Provider requests precede account transactions. Exact challenge consumption, account
// creation and credential issuance share one held connection; cookies follow commit.
module.exports = function installPhoneRoutes(d) {
  const { app, asyncHandler, getPool, getConfig, secret, AccountTransactionAbort } = d;
  const abort = (status, message, key = 'auth.phone.failed') => {
    throw new AccountTransactionAbort(status, key, message);
  };
  const fingerprint = () => crypto.createHmac('sha256', secret)
    .update(JSON.stringify(getConfig())).digest('hex');
  const proofKey = token => crypto.createHash('sha256').update(token).digest('hex');
  const client = () => phoneAuth.createClient(getConfig());

  function requireChannel(channel) {
    if (!['h5', 'app', 'sms'].includes(channel) || !phoneAuth.publicConfig(getConfig())[channel]?.available) {
      abort(503, '手机号登录服务尚未配置或已停用', 'auth.phone.unavailable');
    }
  }

  function canonical(value) {
    if (typeof value !== 'string') abort(400, '请输入有效的中国大陆手机号', 'validation.phone.invalid');
    const phone = phoneAuth.normalizeMainlandPhone(value);
    if (!phone) abort(400, '请输入有效的中国大陆手机号', 'validation.phone.invalid');
    return phone.e164;
  }

  function readProof(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
      abort(400, '号码认证凭证无效', 'auth.phone.invalid_proof');
    }
    return value.trim();
  }

  async function limit(database, key, count, windowMs) {
    const result = await new RateLimitModel(database).consume(key, count, windowMs);
    if (!result.allowed) {
      throw new AccountTransactionAbort(429, 'auth.phone.rate_limited', '请求过于频繁，请稍后重试', { retryAfter: result.retryAfter });
    }
  }

  async function contextFor(req, channel) {
    const sessionDays = d.normalizeSessionDays(req.body.session_days, Boolean(req.is('application/x-www-form-urlencoded')));
    if (sessionDays === null) abort(400, '登录时长无效', 'auth.session.invalid_duration');
    const returnTo = d.getOidcReturnPath(req.body.return_to);
    let params = req.body;
    if (!params.client_id && returnTo.startsWith('/oauth2/authorize?')) {
      params = Object.fromEntries(new URL(returnTo, d.publicBaseUrl).searchParams);
    }
    const checked = await d.validateAuthorizationRequest(params);
    if (checked.body) abort(checked.status, checked.body.error_description, checked.body.error_key || 'auth.phone.invalid_context');
    const value = checked.value;
    const oauth = value ? {
      client_id: value.client.id, redirect_uri: value.redirectUri, scope: value.scopes.join(' '),
      state: value.state, nonce: value.nonce, response_type: 'code',
      ...(value.codeChallenge ? { code_challenge: value.codeChallenge, code_challenge_method: value.codeChallengeMethod } : {})
    } : null;
    return { channel, configState: fingerprint(), sessionDays, returnTo, oauth,
      clientId: value?.client.id || '',
      native: channel === 'app' || (!req.get('origin') && !req.get('referer') && !req.get('sec-fetch-site')) };
  }

  function validContext(context) {
    return Boolean(context && ['h5', 'app', 'sms'].includes(context.channel)
      && context.configState === fingerprint()
      && phoneAuth.publicConfig(getConfig())[context.channel]?.available
      && d.normalizeSessionDays(context.sessionDays) !== null
      && d.isSafeFrontendPath(context.returnTo));
  }

  function liveChallenge(row, purpose) {
    if (!row || row.purpose !== purpose || row.consumed_at
        || new Date(row.expires_at).getTime() <= Date.now() || !validContext(row.context)) {
      abort(401, '手机号验证已失效，请重新开始', 'auth.phone.expired');
    }
    return row;
  }

  // One durable phone lock serializes sends across both SMS purposes and their
  // completions. A late send can never reactivate a superseded challenge.
  async function withPhoneLock(phone, work) {
    const connection = await getPool().getConnection();
    const key = `phone:${proofKey(phone).slice(0, 48)}`;
    let acquired = false;
    try {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [key]);
      if (Number(rows[0]?.acquired) !== 1) abort(429, '手机号验证繁忙，请稍后重试');
      acquired = true;
      return await work(connection);
    } finally {
      try { if (acquired) await connection.query('SELECT RELEASE_LOCK(?) AS released', [key]); }
      finally { connection.release(); }
    }
  }

  async function transactAccount(connection, userId, work) {
    const key = userId ? `totp:${proofKey(userId).slice(0, 48)}` : '';
    let acquired = false;
    let transaction = false;
    try {
      if (key) {
        const [rows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [key]);
        if (Number(rows[0]?.acquired) !== 1) abort(429, '账户繁忙，请稍后重试');
        acquired = true;
      }
      await connection.beginTransaction();
      transaction = true;
      let user = null;
      if (userId) {
        const [rows] = await connection.execute('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
        user = rows[0];
        if (!user || d.isUserBanned(user)) abort(403, '账户不可用');
      }
      const result = await work(user);
      await connection.commit();
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) await connection.rollback();
      throw error;
    } finally {
      if (acquired) await connection.query('SELECT RELEASE_LOCK(?) AS released', [key]);
    }
  }

  async function finish(req, user, context, connection) {
    if (!validContext(context) || user.phone_e164 !== context.phone || !user.phone_verified || d.isUserBanned(user)) {
      abort(401, '手机号或登录配置已变化，请重新登录', 'auth.phone.expired');
    }
    let authorized;
    if (context.oauth) {
      authorized = await d.buildAuthorizationResponse(user, context.oauth, connection);
      if (authorized.status !== 200) abort(authorized.status, authorized.body.error_description, 'auth.phone.invalid_context');
    }
    const body = { user: d.serializeUser(user), redirect: authorized?.body.redirect || context.returnTo,
      phone: context.phone, phoneStatus: 'verified' };
    if (context.oauth && !context.oauth.scope.split(/\s+/).includes('phone')) {
      Object.assign(body.user, { phoneCountryCode: '', phoneNationalNumber: '', phoneE164: '',
        phoneMasked: '', phoneVerified: false, phoneVerifiedAt: null });
      body.phone = null;
      body.phoneStatus = 'scope_not_granted';
    }
    if (context.oauth && context.native) {
      const redirect = new URL(authorized.body.redirect);
      Object.assign(body, { authorization_code: redirect.searchParams.get('code'),
        state: redirect.searchParams.get('state') || '', redirect_uri: context.oauth.redirect_uri });
      await new UserModel(connection).update(user.id, { lastLoginIp: d.getClientIp(req) });
      await d.recordLoginLog({ username: user.username, userId: user.id, req, result: 'success',
        detail: 'Phone authentication OAuth handoff', database: connection });
      return { status: 200, body };
    }
    const issued = await d.issueLoginWithinTransaction(req, user, connection, { sessionDays: context.sessionDays });
    return { status: 200, body, issued };
  }

  async function stageOrFinish(req, user, context, connection) {
    const factor = user.totp_enabled ? 'totp'
      : await d.isSettingEnabled('login_email_code', connection) && d.isUsableMailbox(user.email) ? 'email' : '';
    if (!factor) return finish(req, user, context, connection);
    const expiresAt = new Date(Date.now() + TTL);
    const stage = await d.createSecondFactorRecord({ user, returnTo: context.returnTo, factor,
      source: 'phone', extraContext: { sessionDays: context.sessionDays, phone: context }, expiresAt,
      codes: new EmailVerificationCodeModel(connection), issueCode: false });
    return { stage: { ...stage, expiresAt, user, factor, source: 'phone', provider: '' } };
  }

  async function publish(req, res, result) {
    if (result.stage) {
      const { user, factor } = result.stage;
      if (factor === 'email') await d.issueEmailVerificationCode({ email: user.email, purpose: d.emailLoginPurpose, userId: user.id });
      const pending = d.publishSecondFactor(res, user, result.stage);
      return res.json({ mfa_required: true, factor, ...d.passwordStagePayload(user, factor, pending) });
    }
    if (result.issued) d.applyIssuedLogin(req, res, result.issued);
    return res.status(result.status).json(result.body);
  }

  async function loginWithPhone(req, phone, context, challenge, connection) {
    if (!validContext(context)) abort(401, '登录配置已变化，请重新开始', 'auth.phone.expired');
    const users = new UserModel(connection);
    const owner = await users.findByPhone(phone);
    return transactAccount(connection, owner?.id, async locked => {
      let user = locked;
      if (user && (!user.phone_verified || user.phone_e164 !== phone)) {
        abort(409, '请先登录原账户并验证其绑定的手机号', 'auth.phone.binding_unverified');
      }
      if (!user) {
        if (!getConfig().allowRegistration || !await d.isSettingEnabled('registration_enabled', connection)
            || isQfliClient(context.clientId)) abort(403, '该手机号尚未关联可登录账户，当前不允许注册', 'auth.phone.registration_disabled');
        const suffix = crypto.randomBytes(12).toString('hex');
        user = await users.create({ username: `phone-${suffix}`, email: `phone-${suffix}@users.invalid`,
          password: '', name: 'Phone user', emailVerified: false, phone, phoneVerified: true });
      }
      if (challenge) {
        const codes = new PhoneChallenge(connection);
        const fresh = liveChallenge(await codes.findById(challenge.id), challenge.purpose);
        if (fresh.context.phone && fresh.context.phone !== phone) abort(401, '手机号验证目标已变化', 'auth.phone.expired');
        if (fresh.user_id && fresh.user_id !== user.id) abort(401, '手机号验证账户已变化', 'auth.phone.expired');
        if (!await codes.consume(fresh.id)) abort(401, '手机号验证已使用', 'auth.phone.expired');
      }
      return stageOrFinish(req, user, { ...context, phone }, connection);
    });
  }

  app.get('/api/auth/phone/config', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const value = phoneAuth.publicConfig(getConfig());
    value.registrationEnabled = value.registrationEnabled && await d.isSettingEnabled('registration_enabled') && !isQfliClient(req.query.client_id);
    res.json(value);
  }));

  app.get('/api/admin/phone-auth', asyncHandler(async (req, res) => {
    if (!await d.requireAdminUser(req, res)) return;
    res.set('Cache-Control', 'no-store');
    res.json(phoneAuth.adminConfig(getConfig()));
  }));
  app.put('/api/admin/phone-auth', asyncHandler(async (req, res) => {
    const admin = await d.requireAdminUser(req, res);
    if (!admin) return;
    const config = phoneAuth.normalizeConfig(req.body, getConfig());
    d.saveConfig(config);
    await d.recordAdminLog({ admin, req, action: 'update_phone_auth', detail: 'Phone authentication configuration updated' });
    res.set('Cache-Control', 'no-store');
    res.json(phoneAuth.adminConfig(config));
  }));

  app.post('/api/auth/phone/h5/token', asyncHandler(async (req, res) => {
    requireChannel('h5');
    const context = await contextFor(req, 'h5');
    await limit(getPool(), `phone-h5-start:${d.getClientIp(req)}`, 20, 60 * 1000);
    const tokens = await client().getH5AuthToken();
    if (!validContext(context)) abort(409, '号码认证配置已变化，请重试');
    const challenge = await new PhoneChallenge(getPool()).create({ purpose: PURPOSE.H5_LOGIN,
      ref: crypto.randomUUID(), context, expiresAt: new Date(Date.now() + TTL) });
    res.set('Cache-Control', 'no-store');
    res.json({ ...tokens, challengeId: challenge.id });
  }));

  app.post('/api/auth/phone/h5/login', asyncHandler(async (req, res) => {
    requireChannel('h5');
    const token = readProof(req.body.spToken);
    const codes = new PhoneChallenge(getPool());
    const challenge = liveChallenge(await codes.findById(req.body.challengeId), PURPOSE.H5_LOGIN);
    await limit(getPool(), `phone-h5-finish:${d.getClientIp(req)}`, 30, 60 * 1000);
    if (!await codes.incrementAttempts(challenge.id, 5)) abort(429, '验证次数已达上限，请重新开始');
    await limit(getPool(), `phone-proof:h5:${proofKey(token)}`, 1, 24 * 60 * 60 * 1000);
    const phone = canonical(await client().getH5Phone(token));
    const result = await withPhoneLock(phone, connection => loginWithPhone(req, phone, challenge.context, challenge, connection));
    return publish(req, res, result);
  }));

  app.post('/api/auth/phone/app/login', asyncHandler(async (req, res) => {
    requireChannel('app');
    const token = readProof(req.body.accessToken);
    const context = await contextFor(req, 'app');
    await limit(getPool(), `phone-app:${d.getClientIp(req)}`, 30, 60 * 1000);
    await limit(getPool(), `phone-proof:app:${proofKey(token)}`, 1, 24 * 60 * 60 * 1000);
    const phone = canonical(await client().getAppPhone(token));
    const result = await withPhoneLock(phone, connection => loginWithPhone(req, phone, context, null, connection));
    return publish(req, res, result);
  }));

  async function sendSms(req, res, profile) {
    requireChannel('sms');
    const user = profile ? await d.getAuthenticatedUser(req, res) : null;
    if (profile && !user) return res.status(401).json({ error: 'unauthorized', error_description: '请先登录' });
    const phone = canonical(profile ? user.phone_e164 : req.body.phone);
    const purpose = profile ? PURPOSE.SMS_VERIFY : PURPOSE.SMS_LOGIN;
    const context = profile ? { channel: 'sms', configState: fingerprint(), sessionDays: 1, returnTo: '/profile',
      userId: user.id, sessionId: req.authSession.id, securityState: d.pendingLoginSecurityState(user) }
      : await contextFor(req, 'sms');
    await limit(getPool(), `phone-sms-send-ip:${d.getClientIp(req)}`, 10, 60 * 1000);
    const challenge = await withPhoneLock(phone, async connection => {
      await limit(connection, `phone-sms-cooldown:${phone}`, 1, 60 * 1000);
      await limit(connection, `phone-sms-hour:${phone}`, 10, 60 * 60 * 1000);
      const codes = new PhoneChallenge(connection);
      await codes.invalidate(phone, PURPOSE.SMS_LOGIN);
      await codes.invalidate(phone, PURPOSE.SMS_VERIFY);
      const row = await codes.create({ phone, purpose, userId: user?.id || null, context, expiresAt: new Date(Date.now() + TTL) });
      try {
        await client().sendSms(phone, row.id);
        if (!validContext(context)) abort(409, '短信配置已变化，请重新发送');
        return row;
      } catch (error) {
        await codes.consume(row.id);
        throw error;
      }
    });
    res.set('Cache-Control', 'no-store');
    return res.json({ challengeId: challenge.id, retryAfter: 60, expiresIn: 300 });
  }

  async function verifySms(req, res, profile) {
    requireChannel('sms');
    const user = profile ? await d.getAuthenticatedUser(req, res) : null;
    if (profile && !user) return res.status(401).json({ error: 'unauthorized', error_description: '请先登录' });
    if (typeof req.body.code !== 'string' || !/^\d{6}$/.test(req.body.code)) abort(400, '请输入六位短信验证码');
    const purpose = profile ? PURPOSE.SMS_VERIFY : PURPOSE.SMS_LOGIN;
    const initial = liveChallenge(await new PhoneChallenge(getPool()).findById(req.body.challengeId), purpose);
    const phone = canonical(initial.context.phone);
    await limit(getPool(), `phone-sms-verify-ip:${d.getClientIp(req)}`, 30, 60 * 1000);
    const result = await withPhoneLock(phone, async connection => {
      const codes = new PhoneChallenge(connection);
      const row = liveChallenge(await codes.findById(initial.id), purpose);
      if (profile && (row.user_id !== user.id || row.context.userId !== user.id
          || row.context.sessionId !== req.authSession.id || user.phone_e164 !== phone
          || row.context.securityState !== d.pendingLoginSecurityState(user))) abort(401, '手机号验证状态已变化', 'auth.phone.expired');
      if (!await codes.incrementAttempts(row.id, 5)) abort(429, '验证次数已达上限，请重新发送');
      if (!await client().verifySms(phone, req.body.code, row.id)) abort(400, '验证码不正确或已失效', 'auth.phone.invalid_code');
      if (!profile) return loginWithPhone(req, phone, row.context, row, connection);
      return transactAccount(connection, user.id, async current => {
        const fresh = liveChallenge(await codes.findById(row.id), purpose);
        const session = await new SessionModel(connection).findById(req.authSession.id);
        if (fresh.context.securityState !== d.pendingLoginSecurityState(current) || current.phone_e164 !== phone
            || !session || session.user_id !== current.id || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
          abort(409, '手机号或登录状态已变化，请重新验证', 'auth.phone.expired');
        }
        if (!await codes.consume(fresh.id)) abort(401, '验证码已使用', 'auth.phone.expired');
        const users = new UserModel(connection);
        if (!current.phone_verified) {
          if (!await users.verifyPhoneIfUnchanged(current.id, phone)) abort(409, '手机号已变化，请重新验证');
          await new SessionModel(connection).revokeAllForUser(current.id, session.id);
          await new TokenModel(connection).revokeByUser(current.id);
        }
        return { status: 200, body: { verified: true, user: d.serializeUser(await users.findById(current.id)) } };
      });
    });
    return publish(req, res, result);
  }

  app.post('/api/auth/phone/sms/send', asyncHandler((req, res) => sendSms(req, res, false)));
  app.post('/api/auth/phone/sms/login', asyncHandler((req, res) => verifySms(req, res, false)));
  app.post('/api/profile/phone/sms/send', asyncHandler((req, res) => sendSms(req, res, true)));
  app.post('/api/profile/phone/sms/verify', asyncHandler((req, res) => verifySms(req, res, true)));
  return { validContext, finishPending: finish };
};
