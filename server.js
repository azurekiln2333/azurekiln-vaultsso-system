require('./config/environment').loadProjectEnvironment();

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const path = require('path');
const { readRuntimeConfig } = require('./config/runtime');
const { loadSigningKeys } = require('./services/signing');
const { verifyClientSecret } = require('./services/client-secrets');
const { createSecretCipher } = require('./services/secret-storage');
const { createStore } = require('./services/admin-settings');
const { pageFile, adminPagePaths } = require('./views/page-registry');

const { initDatabase, closePool } = require('./db/init');
const UserModel = require('./models/User');
const AuthenticatorModel = require('./models/Authenticator');
const ClientModel = require('./models/Client');
const TokenModel = require('./models/Token');
const UserAppUsageModel = require('./models/UserAppUsage');
const EmailVerificationCodeModel = require('./models/EmailVerificationCode');
const ExternalIdentityModel = require('./models/ExternalIdentity');
const LoginLogModel = require('./models/LoginLog');
const SessionModel = require('./models/Session');
const OidcProviderModel = require('./models/OidcProvider');
const RateLimitModel = require('./models/RateLimit');
const CaptchaModel = require('./models/Captcha');
const { renderCaptcha } = require('./services/captcha');
const { verifyTurnstile } = require('./services/turnstile');
const { generateSecret, matchingTotpCounter, buildOtpauthUri } = require('./services/totp');
const phoneNumbers = require('./services/phone');
const huawei = require('./services/huawei');
const { mergeHuaweiAccount, AccountMergeError } = require('./services/account-merge');
const { mergeOidcAccount } = require('./services/oidc-account-merge');
const QRCode = require('qrcode');
const { sendVerificationEmail, getSmtpSettings, applySmtpSettings, sendTestEmail, sendLoginAlertEmail, sendBehaviorAlertEmail } = require('./services/email');

const app = express();
const RUNTIME = readRuntimeConfig();
app.disable('x-powered-by');
app.set('trust proxy', RUNTIME.trustedProxies.length ? RUNTIME.trustedProxies : false);

const PORT = Number(process.env.PORT || 3146);
const JWT_SECRET = RUNTIME.jwtSecret;
const adminSettingsStore = createStore(JWT_SECRET);
let adminSettingsOverrides = {};
let turnstileSettings = { siteKey: RUNTIME.turnstileSiteKey, secretKey: RUNTIME.turnstileSecretKey };
const totpCipher = createSecretCipher(JWT_SECRET, 'totp-secret');
const huaweiPendingPhoneCipher = createSecretCipher(JWT_SECRET, 'huawei-pending-phone');
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '1h';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';
const PUBLIC_BASE_URL = RUNTIME.publicBaseUrl;
const USER_ROLE_ADMIN = 'admin';
const USER_ROLE_USER = 'user';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_ONLY_STATIC_PATHS = new Set(adminPagePaths.keys());
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const OIDC_CALLBACK_PATH = '/api/v1/auth/oauth/oidc/callback';
const OIDC_STATE_COOKIE = 'oidc_state';
const HUAWEI_QUICK_LOGIN_PATH = '/api/v1/auth/oauth/huawei/quick-login';
const HUAWEI_BIND_PATH = '/api/v1/auth/oauth/huawei/bind';
const HUAWEI_SKIP_PATH = '/api/v1/auth/oauth/huawei/skip';
const HUAWEI_BIND_TTL_MS = 5 * 60 * 1000;
const pendingHuaweiBindings = new Map();
setInterval(() => {
  for (const [token, entry] of pendingHuaweiBindings) {
    if (Date.now() - entry.createdAt >= HUAWEI_BIND_TTL_MS) pendingHuaweiBindings.delete(token);
  }
}, 60000).unref();
// 这些端点由原生 App / 服务端直接调用，不经过浏览器，因此按机器调用校验来源。
const MACHINE_ENDPOINTS = new Set([HUAWEI_QUICK_LOGIN_PATH, HUAWEI_BIND_PATH, HUAWEI_SKIP_PATH, '/api/v1/auth/oauth/oidc/complete']);

let User;
let Authenticator;
let Client;
let Token;
let UserAppUsage;
let EmailVerificationCode;
let ExternalIdentity;
let LoginLog;
let Session;
let OidcProvider;
let RateLimit;
let Captcha;
let signingKeys;
let pool = null;
let oidcStorageSource = 'database';

app.use(express.json());
app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 100 }));
app.use(cookieParser());
function isSameOriginBrowserRequest(req) {
    const origin = req.get('origin');
    if (origin) return origin === PUBLIC_BASE_URL;
    const referer = req.get('referer');
    if (referer) {
      try { return new URL(referer).origin === PUBLIC_BASE_URL; } catch { return false; }
    }
    return req.get('sec-fetch-site') === 'same-origin';
  }

// 机器对机器端点（原生 App 直连）的调用方校验。
// 浏览器一定会带 Origin / Referer / Sec-Fetch-*，据此拒绝跨站请求以防登录 CSRF；
// 三者都不存在说明调用方不是浏览器，此时放行。
function isMachineClientRequest(req) {
    const site = normalizeText(req.get('sec-fetch-site')).toLowerCase();
    if (site) return site === 'same-origin';
    const origin = req.get('origin');
    if (origin) return origin === PUBLIC_BASE_URL;
    const referer = req.get('referer');
    if (referer) {
      try { return new URL(referer).origin === PUBLIC_BASE_URL; } catch { return false; }
    }
    return true;
  }

app.use(function requestBoundary(req, res, next) {
    const origin = req.get('origin');
    if (origin === PUBLIC_BASE_URL) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.vary('Origin');
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const browserEndpoint = req.path.startsWith('/api/') || ['/oauth2/authorize', '/oauth2/register'].includes(req.path);
    const allowed = MACHINE_ENDPOINTS.has(req.path)
      ? isMachineClientRequest(req)
      : isSameOriginBrowserRequest(req);
    if (unsafe && browserEndpoint && !allowed) {
      return res.status(403).json({ error: 'forbidden', error_description: 'A same-origin browser request is required' });
    }
    if (req.path.startsWith('/api/') || req.path.startsWith('/oauth2/') || req.cookies.session) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }
    if (RUNTIME.production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.method === 'OPTIONS') {
      if (origin && origin !== PUBLIC_BASE_URL) return res.status(403).end();
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      return res.status(204).end();
    }
    next();
  });

app.use(asyncHandler(async function limitRequests(req, res, next) {
    const isCaptcha = req.path === '/api/captcha';
    const isSensitive = isCaptcha || req.path === '/api/v1/auth/oauth/oidc/login' || req.path === OIDC_CALLBACK_PATH || (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && (req.path.startsWith('/api/') || req.path.startsWith('/oauth2/')));
    if (!isSensitive) return next();
    const category = isCaptcha ? 'captcha' : req.path === '/api/email-verification/send' ? 'mail' : 'auth';
    const limit = category === 'mail' ? 10 : category === 'captcha' ? 30 : 120;
    const result = await RateLimit.consume(`http:${category}:${getClientIp(req)}`, limit, 60 * 1000);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfter));
      return res.status(429).json({ error: 'too_many_requests', error_description: 'Too many requests; try again later' });
    }
    next();
  }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN (not DENY): the admin center shell embeds admin pages from the same origin.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: https: http:",
    "connect-src 'self' https://challenges.cloudflare.com",
    "frame-src 'self' https://challenges.cloudflare.com",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'"
  ].join('; '));
  next();
});

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function getClientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 64);
}

const RECOVERY_CODE_COUNT = 10;

function hashRecoveryCode(code) {
  const normalized = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function generateRecoveryCodes() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let index = 0; index < RECOVERY_CODE_COUNT; index++) {
    let code = '';
    for (let position = 0; position < 16; position++) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
      if (position % 4 === 3 && position < 15) code += '-';
    }
    codes.push(code);
  }
  return codes;
}

function getRecoveryHashes(user) {
  try {
    const parsed = JSON.parse(user.recovery_codes || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function consumeRecoveryCode(user, code, users = User) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalized) return false;
  const hash = hashRecoveryCode(normalized);
  const hashes = getRecoveryHashes(user);
  const index = hashes.findIndex(stored => stored.length === hash.length
    && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(hash)));
  if (index < 0) return false;
  hashes.splice(index, 1);
  return users.consumeRecoveryCode(user.id, user.recovery_codes, JSON.stringify(hashes));
}

const SETTING_DEFAULTS = {
  captcha_login: 'false',
  captcha_register: 'false',
  login_email_code: 'false',
  registration_enabled: 'true',
  password_min_length: '12',
  login_max_attempts: '5',
  login_lockout_minutes: '15',
  totp_allowed: 'true',
  password_require_mixed: 'false',
  anomaly_detection: 'true',
  // 仅用华为已验证号码匹配本地已验证号码；管理员可关闭自动关联。
  huawei_phone_autolink: 'true'
};

async function getSettingValue(key, database = pool) {
  let value = SETTING_DEFAULTS[key];
  if (key === 'captcha_login' || key === 'captcha_register') value = turnstileSettings.siteKey ? 'true' : 'false';
  if (key === 'password_min_length') value = String(getSettingNumberFromEnv());
  const [rows] = await database.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  if (rows.length && normalizeText(rows[0].setting_value) !== '') {
    value = normalizeText(rows[0].setting_value);
  }

  return value;
}

function getSettingNumberFromEnv() {
  const parsed = Number(process.env.PASSWORD_MIN_LENGTH);
  return Number.isInteger(parsed) && parsed >= 12 && parsed <= 64 ? parsed : 12;
}

async function saveSettingValues(changes) {
  if (!changes.length) return;
  await pool.execute(
    `INSERT INTO settings (setting_key, setting_value) VALUES ${changes.map(() => '(?, ?)').join(', ')} ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    changes.flat()
  );
}

async function isSettingEnabled(key, database = pool) {
  return (await getSettingValue(key, database)) === 'true';
}

async function getSettingNumber(key, fallback) {
  const parsed = Number(await getSettingValue(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function getPasswordMinLength() {
  return Math.max(12, await getSettingNumber('password_min_length', 12));
}

const COMMON_PASSWORDS = new Set([
  '123456', '123456789', '12345678', '111111', '1234567890', '1234567', 'password',
  'qwerty', 'abc123', '11111111', '123123', 'admin', 'letmein', 'iloveyou',
  '000000', '666666', '888888', 'a123456', '123qwe', 'qwertyuiop', '1qaz2wsx',
  'password1', 'test123', 'abcd1234', '1234qwer', '987654321', '112233', '123321'
]);

async function validatePasswordPolicy(password) {
  if (Buffer.byteLength(password, 'utf8') > 72) return '密码不能超过 72 个 UTF-8 字节';
  const minLength = await getPasswordMinLength();
  if (password.length < minLength) {
    return `密码长度不能少于 ${minLength} 位`;
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return '密码过于常见，请更换为更复杂的密码';
  }
  if ((await getSettingValue('password_require_mixed')) === 'true'
      && !(/[a-zA-Z]/.test(password) && /\d/.test(password))) {
    return '密码必须同时包含字母和数字';
  }
  return '';
}

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const CAPTCHA_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function hashCaptcha(id, text) { return crypto.createHmac('sha256', JWT_SECRET).update(`${id}:${text.toLowerCase()}`).digest('hex'); }

app.get('/api/captcha', asyncHandler(async function captchaChallenge(req, res) {
    const id = crypto.randomUUID();
    const text = Array.from({ length: 4 }, () => CAPTCHA_CHARS[crypto.randomInt(CAPTCHA_CHARS.length)]).join('');
    await Captcha.create(id, hashCaptcha(id, text), new Date(Date.now() + CAPTCHA_TTL_MS));
    res.json({ id, image: renderCaptcha(text), expiresInMinutes: 5 });
  }));

app.get('/api/auth/config', asyncHandler(async (req, res) => {
  const webTurnstile = req.query.surface === 'web' && Boolean(turnstileSettings.siteKey);
  res.json({
    captchaLogin: await isSettingEnabled('captcha_login'),
    captchaRegister: await isSettingEnabled('captcha_register'),
    captchaProvider: webTurnstile ? 'turnstile' : 'image',
    turnstileSiteKey: webTurnstile ? turnstileSettings.siteKey : '',
    loginEmailCode: await isSettingEnabled('login_email_code'),
    registrationEnabled: await isSettingEnabled('registration_enabled'),
    passwordMinLength: await getPasswordMinLength()
  });
}));

async function verifyCaptcha(body, req, action) {
    if (body.captcha_surface === 'web' && turnstileSettings.siteKey) {
      const token = normalizeText(body.turnstile_response);
      if (!token) return { ok: false, error_key: 'turnstile.required', error_description: '请完成人机验证' };
      if (token.length > 2048) return { ok: false, error_key: 'turnstile.invalid', error_description: '人机验证无效，请重试' };
      const result = await verifyTurnstile({
        token, secret: turnstileSettings.secretKey, ip: getClientIp(req),
        hostname: RUNTIME.production ? new URL(PUBLIC_BASE_URL).hostname : '', action
      });
      if (!result.ok) return result.unavailable
        ? { ok: false, status: 503, error_key: 'turnstile.unavailable', error_description: '人机验证暂时不可用，请稍后重试' }
        : { ok: false, error_key: 'turnstile.invalid', error_description: '人机验证无效，请重试' };
      return { ok: true };
    }
    const id = normalizeText(body.captcha_id);
    const code = normalizeText(body.captcha_code).toLowerCase();
    const record = id ? await Captcha.consume(id) : null;
    if (!record) return { ok: false, error_key: 'captcha.expired', error_description: '图形验证码已过期，请刷新后重试' };
    if (!code || record.answer_hash !== hashCaptcha(id, code)) {
      return { ok: false, error_key: 'captcha.invalid', error_description: '图形验证码不正确' };
    }
    return { ok: true };
  }

function grantCaptchaContinuation(req, res, userId) {
    const value = encodeOidcState({ kind: 'captcha', userId, ip: getClientIp(req), expiresAt: Date.now() + 3 * 60 * 1000 });
    res.cookie('login_step', value, { httpOnly: true, secure: RUNTIME.secureCookies, sameSite: 'strict', path: '/', maxAge: 3 * 60 * 1000 });
  }

function hasCaptchaContinuation(req, userId) {
    const value = decodeOidcState(req.cookies.login_step);
    return value && value.kind === 'captcha' && value.userId === userId && value.ip === getClientIp(req) && value.expiresAt > Date.now();
  }

function maskEmail(email) {
  const text = normalizeText(email);
  const atIndex = text.indexOf('@');
  if (atIndex <= 0) return text;
  const local = text.slice(0, atIndex);
  const masked = local.length <= 2 ? `${local[0]}*` : `${local.slice(0, 2)}***`;
  return `${masked}${text.slice(atIndex)}`;
}

async function recordLoginLog({ username, userId = null, req, result, detail = '', database = pool }) {
  try {
    await new LoginLogModel(database).create({
      username: username || '-',
      userId,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      result,
      detail
    });
  } catch (error) {
    console.error('Failed to write login log:', error.message);
  }
}

const ANOMALY_WINDOW_MS = 10 * 60 * 1000;
const ANOMALY_DISTINCT_IP_FAILURES = 2;
const ANOMALY_TOTAL_FAILURES = 5;
const ANOMALY_DISTINCT_IP_SUCCESS = 3;

// 行为分析：基于登录日志的滚动窗口判定。触发后给账户打上"下次登录强制图形验证码"
// 标记，并发送警告邮件；成功通过验证码的登录会自动解除标记。
async function detectAndFlagAnomalousLogin(user, req, event, database = pool) {
  try {
    if ((await getSettingValue('anomaly_detection', database)) !== 'true') {
      return;
    }
    if (user.captcha_required) {
      return;
    }

    const since = Date.now() - ANOMALY_WINDOW_MS;
    const logs = await new LoginLogModel(database).findRecentByUserId(user.id, new Date(since));
    const failures = logs.filter(log => log.result === 'invalid_credentials' || log.result === 'captcha_failed' || log.result === 'totp_invalid');
    const successIps = new Set(logs.filter(log => log.result === 'success').map(log => normalizeText(log.ip)).filter(Boolean));
    const failureIps = new Set(failures.map(log => normalizeText(log.ip)).filter(Boolean));
    if (event === 'failure') {
      failureIps.add(getClientIp(req));
    }

    const reasons = [];
    if (failureIps.size >= ANOMALY_DISTINCT_IP_FAILURES) {
      reasons.push(`多个 IP（${failureIps.size} 个）登录失败`);
    }
    if (failures.length >= ANOMALY_TOTAL_FAILURES) {
      reasons.push(`短时间内失败 ${failures.length} 次`);
    }
    if (successIps.size >= ANOMALY_DISTINCT_IP_SUCCESS) {
      reasons.push(`短时间内 ${successIps.size} 个不同 IP 成功登录`);
    }
    if (!reasons.length) {
      return;
    }

    await new UserModel(database).update(user.id, { captchaRequired: true });
    const description = reasons.join('；');
    await recordLoginLog({ username: user.username, userId: user.id, req, result: 'anomaly_detected', detail: description, database });
    if (user.email) {
      sendBehaviorAlertEmail({ to: user.email, username: user.username, reason: description }).catch(error => {
        console.error('Behavior alert delivery failed:', error.message);
      });
    }
    console.log(`[security:anomaly] ${user.username}: ${description}`);
  } catch (error) {
    console.error('Anomaly detection failed:', error.message);
  }
}

async function recordAdminLog({ admin, req, action, detail = '' }) {
  await recordLoginLog({
    username: `admin:${normalizeText(admin.username) || admin.id}`,
    userId: admin.id,
    req,
    result: 'admin_action',
    detail: [action, detail].filter(Boolean).join(' | ').slice(0, 255)
  });
}



function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(email);
}

function getBaseUrl() {
  return PUBLIC_BASE_URL;
}

function generateClientSecret() {
  // Common OAuth practice: use an opaque, high-entropy, URL-safe secret.
  return crypto.randomBytes(32).toString('base64url');
}

function parseDurationToMs(value, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  const normalized = String(value || '').trim().toLowerCase();
  const match = normalized.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) {
    return fallbackMs;
  }

  const amount = Number(match[1]);
  const unit = match[2] || 'ms';

  switch (unit) {
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 's':
      return amount * 1000;
    default:
      return amount;
  }
}

const ACCESS_TOKEN_TTL_MS = parseDurationToMs(TOKEN_EXPIRY, 60 * 60 * 1000);
const REFRESH_TOKEN_TTL_MS = parseDurationToMs(REFRESH_TOKEN_EXPIRY, 7 * 24 * 60 * 60 * 1000);
const SESSION_MAX_AGE = ACCESS_TOKEN_TTL_MS;
const SESSION_ABSOLUTE_TTL_MS = parseDurationToMs(process.env.SESSION_ABSOLUTE_EXPIRY || '12h', 12 * 60 * 60 * 1000);
// 登出后允许跳回的站点白名单（注册域名，逗号分隔；为空时保持原行为）
const LOGOUT_REDIRECT_HOSTS = String(process.env.LOGOUT_REDIRECT_HOSTS || '')
  .split(',').map(item => normalizeText(item).toLowerCase()).filter(Boolean);
// 会话 Cookie 作用域：配置为注册域名（如 .azurekiln.cn）后，主站/管理后台等
// 子域可共享登录态；留空保持默认的主机级 Cookie（仅 SSO 自身域名可见）
const COOKIE_DOMAIN = normalizeText(process.env.COOKIE_DOMAIN);
// 会话滑动续期阈值：会话有效时长过半后再次访问时重发 session cookie
const SESSION_REFRESH_THRESHOLD_MS = Math.floor(ACCESS_TOKEN_TTL_MS / 2);
const EMAIL_PURPOSE_REGISTER = 'register';
const EMAIL_PURPOSE_PASSWORD_RESET = 'password_reset';
const EMAIL_PURPOSE_LOGIN = 'login';
const EMAIL_PURPOSE_EMAIL_CHANGE = 'email_change';
const EMAIL_CODE_TTL_MS = parseDurationToMs(process.env.EMAIL_CODE_EXPIRY || '10m', 10 * 60 * 1000);
const EMAIL_CODE_MAX_ATTEMPTS = Number(process.env.EMAIL_CODE_MAX_ATTEMPTS || 5);
if (![ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, EMAIL_CODE_TTL_MS, SESSION_ABSOLUTE_TTL_MS].every(value => Number.isFinite(value) && value >= 1000)
    || !Number.isInteger(EMAIL_CODE_MAX_ATTEMPTS) || EMAIL_CODE_MAX_ATTEMPTS < 1 || EMAIL_CODE_MAX_ATTEMPTS > 10) {
  throw new Error('Invalid token/session/email expiry or email verification attempt limit');
}

const OIDC_CONFIG = {
  enabled: false, providerName: 'OIDC', providerKey: '', clientId: '', clientSecret: '',
  issuerUrl: '', discoveryUrl: '', authorizeUrl: '', tokenUrl: '', userinfoUrl: '', jwksUrl: '',
  scopes: ['openid', 'profile', 'email'], tokenAuthMethod: 'client_secret_basic',
  clockTolerance: 60, allowedAlgorithms: ['RS256', 'ES256'], pkceEnabled: true,
  validateIdToken: true, requireEmailVerified: true,
  userinfoEmailPath: 'email', userinfoIdPath: 'sub', userinfoUsernamePath: 'preferred_username',
  userinfoSecondaryIdPath: '', userinfoMethod: 'GET', userinfoTokenIn: 'header',
  emailVerifiedPath: 'email_verified', frontendCallbackPath: '/profile'
};

// 提供方类型：通用 OIDC，以及需要专用协议的华为账号一键登录。
const PROVIDER_TYPE_OIDC = 'oidc';
const PROVIDER_TYPE_HUAWEI = 'huawei_quicklogin';
const PROVIDER_TYPES = new Set([PROVIDER_TYPE_OIDC, PROVIDER_TYPE_HUAWEI]);
const USERINFO_METHODS = new Set(['GET', 'POST']);
const USERINFO_TOKEN_IN = new Set(['header', 'body_form']);
let OIDC_PROVIDERS = Object.create(null);

function oidcSecretKey() {
  return crypto.createHash('sha256').update(`${JWT_SECRET}:oidc-provider-secret`).digest();
}

function encryptOidcSecret(value) {
  const secret = String(value || '');
  if (!secret) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', oidcSecretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptOidcSecret(value) {
  const encoded = String(value || '');
  if (!encoded.startsWith('enc:v1:')) return encoded;
  try {
    const [, , ivText, tagText, dataText] = encoded.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', oidcSecretKey(), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new Error('OIDC provider secret could not be decrypted');
  }
}

function oidcDatabaseRowToConfig(row) {
  let clientSecret = '';
  let credentialError = false;
  try { clientSecret = decryptOidcSecret(row.client_secret); } catch { credentialError = true; }
  const algorithms = toStringArray(row.allowed_algorithms || '').flatMap(item => item.split(/\s+/)).filter(Boolean);
  return {
    providerKey: row.provider_key,
    providerName: row.provider_name,
    providerType: PROVIDER_TYPES.has(row.provider_type) ? row.provider_type : PROVIDER_TYPE_OIDC,
    enabled: Boolean(row.enabled),
    clientId: row.client_id,
    huaweiUnionScope: row.huawei_union_scope || '',
    clientSecret,
    credentialError,
    issuerUrl: row.issuer_url || '',
    discoveryUrl: row.discovery_url || '',
    authorizeUrl: row.authorize_url || '',
    tokenUrl: row.token_url || '',
    userinfoUrl: row.userinfo_url || '',
    jwksUrl: row.jwks_url || '',
    scopes: parseOidcScopes(row.scopes || '', Boolean(row.validate_id_token)),
    tokenAuthMethod: row.token_auth_method || 'client_secret_basic',
    clockTolerance: Number.isFinite(Number(row.clock_tolerance)) ? Math.min(120, Math.max(0, Number(row.clock_tolerance))) : 60,
    allowedAlgorithms: algorithms.length ? algorithms : ['RS256', 'ES256'],
    pkceEnabled: Boolean(row.pkce_enabled),
    validateIdToken: Boolean(row.validate_id_token),
    requireEmailVerified: Boolean(row.require_email_verified),
    userinfoEmailPath: row.userinfo_email_path || 'email',
    emailVerifiedPath: row.email_verified_path || 'email_verified',
    userinfoIdPath: row.userinfo_id_path || 'sub',
    userinfoSecondaryIdPath: row.userinfo_secondary_id_path || '',
    userinfoUsernamePath: row.userinfo_username_path || 'preferred_username',
    userinfoMethod: String(row.userinfo_method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    userinfoTokenIn: String(row.userinfo_token_in || 'header').toLowerCase() === 'body_form' ? 'body_form' : 'header',
    frontendCallbackPath: row.frontend_callback_path || '/oauth2/success',
    idTokenHmacSecret: clientSecret
  };
}

async function refreshOidcProvidersFromDatabase() {
  if (!OidcProvider) return;
  const rows = await OidcProvider.findAll();
  oidcStorageSource = 'database';
  const providers = Object.create(null);
  for (const row of rows) {
    providers[row.provider_key] = oidcDatabaseRowToConfig(row);
  }
  OIDC_PROVIDERS = providers;
}



function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseOidcScopes(value, requireOpenid = true) {
  const scopes = parseRequestedScopes(value);
  return requireOpenid ? Array.from(new Set(['openid', ...scopes])) : scopes;
}

function getOidcProviderConfig(providerKey) {
  const key = normalizeText(providerKey).toLowerCase();
  const keys = Object.keys(OIDC_PROVIDERS);
  const provider = key ? OIDC_PROVIDERS[key] : keys.length === 1 ? OIDC_PROVIDERS[keys[0]] : null;
  if (!provider || typeof provider !== 'object') return null;
  const validateIdToken = parseBoolean(provider.validateIdToken, OIDC_CONFIG.validateIdToken);
  return {
    ...OIDC_CONFIG,
    ...provider,
    providerKey: key || provider.providerKey,
    enabled: parseBoolean(provider.enabled, true),
    scopes: parseOidcScopes(provider.scopes || provider.scope || OIDC_CONFIG.scopes.join(' '), validateIdToken),
    allowedAlgorithms: toStringArray(provider.allowedAlgorithms || provider.allowedAlgs || OIDC_CONFIG.allowedAlgorithms.join(' ')).flatMap(item => item.split(/\s+/)).filter(Boolean),
    pkceEnabled: parseBoolean(provider.pkceEnabled, OIDC_CONFIG.pkceEnabled),
    validateIdToken,
    requireEmailVerified: parseBoolean(provider.requireEmailVerified, OIDC_CONFIG.requireEmailVerified),
    tokenAuthMethod: normalizeText(provider.tokenAuthMethod) || OIDC_CONFIG.tokenAuthMethod,
    idTokenHmacSecret: String(provider.idTokenHmacSecret || provider.idTokenHsSecret || provider.clientSecret || OIDC_CONFIG.idTokenHmacSecret),
    userinfoEmailPath: normalizeText(provider.userinfoEmailPath) || OIDC_CONFIG.userinfoEmailPath,
    emailVerifiedPath: normalizeText(provider.emailVerifiedPath || provider.userinfoEmailVerifiedPath) || OIDC_CONFIG.emailVerifiedPath,
    userinfoIdPath: normalizeText(provider.userinfoIdPath) || OIDC_CONFIG.userinfoIdPath,
    userinfoSecondaryIdPath: normalizeText(provider.userinfoSecondaryIdPath),
    userinfoUsernamePath: normalizeText(provider.userinfoUsernamePath) || OIDC_CONFIG.userinfoUsernamePath,
    userinfoMethod: USERINFO_METHODS.has(String(provider.userinfoMethod || '').toUpperCase())
      ? String(provider.userinfoMethod).toUpperCase()
      : OIDC_CONFIG.userinfoMethod,
    userinfoTokenIn: USERINFO_TOKEN_IN.has(String(provider.userinfoTokenIn || '').toLowerCase())
      ? String(provider.userinfoTokenIn).toLowerCase()
      : OIDC_CONFIG.userinfoTokenIn
  };
}

function isOidcProvider(config) {
  return (config?.providerType || PROVIDER_TYPE_OIDC) === PROVIDER_TYPE_OIDC;
}

function getConfiguredOidcProviders() {
  const keys = Object.keys(OIDC_PROVIDERS);
  if (!keys.length) return [];
  return keys.map(getOidcProviderConfig).filter(config => isOidcProvider(config) && isOidcEnabled(config));
}

// 华为一键登录不是 OIDC：只需要凭据和换码地址，不参与通用 OIDC 发现流程。
function isHuaweiEnabled(config) {
  return Boolean(config && config.enabled !== false && config.clientId && config.clientSecret
    && config.providerType === PROVIDER_TYPE_HUAWEI);
}

function getConfiguredHuaweiProviders() {
  return Object.keys(OIDC_PROVIDERS)
    .map(getOidcProviderConfig)
    .filter(isHuaweiEnabled);
}

function getHuaweiProviderConfig(providerKey) {
  const config = getOidcProviderConfig(providerKey);
  if (!config || config.providerType !== PROVIDER_TYPE_HUAWEI) return null;
  return config;
}

function huaweiQuickLoginEndpoint(config) {
  return normalizeText(config?.tokenUrl) || huawei.HUAWEI_QUICK_LOGIN_URL;
}

const OIDC_STATE_MAX_AGE = 10 * 60 * 1000;

function isOidcEnabled(config = OIDC_CONFIG) {
  return Boolean(config && config.enabled !== false && config.clientId && config.clientSecret &&
    (config.issuerUrl || config.discoveryUrl || config.authorizeUrl) &&
    (config.tokenUrl || config.discoveryUrl || config.issuerUrl) &&
    (!config.validateIdToken || config.issuerUrl || config.discoveryUrl));
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash
      && (url.protocol === 'https:' || (!RUNTIME.production && url.protocol === 'http:'));
  } catch (error) {
    return false;
  }
}

function oidcDiscoveryUrl(config = OIDC_CONFIG) {
  if (config.discoveryUrl) return config.discoveryUrl;
  if (!config.issuerUrl) return '';
  return `${config.issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
}

async function fetchJson(url, options = {}) {
  if (!isHttpUrl(url)) throw new Error('Invalid OIDC endpoint URL');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      ...options,
      redirect: 'error',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.headers || {}) }
    });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        controller.abort();
        throw new Error('OIDC response exceeds the maximum size');
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error(`OIDC endpoint returned invalid JSON (${response.status})`);
    }
    if (!response.ok) throw new Error(`OIDC endpoint returned HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveOidcEndpoints(config = OIDC_CONFIG) {
  const discoveryAddress = oidcDiscoveryUrl(config);
  const needsDiscovery = !config.authorizeUrl || !config.tokenUrl ||
    (!config.userinfoUrl && !config.jwksUrl);
  const discovery = discoveryAddress && needsDiscovery ? await fetchJson(discoveryAddress) : {};
  if (config.issuerUrl && discovery.issuer && config.issuerUrl !== discovery.issuer) {
    throw new Error('OIDC discovery issuer does not match the configured issuer');
  }
  const endpoints = {
    issuer: config.issuerUrl || normalizeText(discovery.issuer),
    authorizeUrl: config.authorizeUrl || normalizeText(discovery.authorization_endpoint),
    tokenUrl: config.tokenUrl || normalizeText(discovery.token_endpoint),
    userinfoUrl: config.userinfoUrl || normalizeText(discovery.userinfo_endpoint),
    jwksUrl: config.jwksUrl || normalizeText(discovery.jwks_uri)
  };
  if (!endpoints.authorizeUrl || !endpoints.tokenUrl) throw new Error('OIDC authorize and token endpoints are required');
  for (const [name, value] of Object.entries(endpoints)) {
    if (value && name !== 'issuer' && !isHttpUrl(value)) throw new Error(`Invalid OIDC ${name}`);
  }
  if (config.validateIdToken && !endpoints.issuer) throw new Error('OIDC issuer is required when ID Token validation is enabled');
  return endpoints;
}

function encodeOidcState(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeOidcState(value) {
  try {
    const [payload, signature] = String(value || '').split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (error) {
    return null;
  }
}

function isSafeFrontendPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) return false;
  try { return new URL(value, PUBLIC_BASE_URL).origin === PUBLIC_BASE_URL; } catch { return false; }
}

function getOidcReturnPath(value) {
  const candidate = normalizeText(value);
  return isSafeFrontendPath(candidate) ? candidate : OIDC_CONFIG.frontendCallbackPath;
}

function getOidcCallbackUrl(req) {
  return `${getBaseUrl(req).replace(/\/+$/, '')}${OIDC_CALLBACK_PATH}`;
}

function getOidcLoginUrl(req, providerKey = '') {
  const url = `${getBaseUrl(req).replace(/\/+$/, '')}/api/v1/auth/oauth/oidc/login`;
  return Object.keys(OIDC_PROVIDERS).length && providerKey
    ? `${url}?provider=${encodeURIComponent(providerKey)}`
    : url;
}

function getClaimByPath(source, pathValue) {
  if (!source || !pathValue) return undefined;
  const pathText = String(pathValue).trim();
  if (pathText.startsWith('/')) {
    return pathText.split('/').slice(1).reduce((value, key) => value == null ? undefined : value[key.replace(/~1/g, '/').replace(/~0/g, '~')], source);
  }
  const parts = pathText.replace(/\[([^\]]+)\]/g, '.$1').split('.').filter(Boolean);
  return parts.reduce((value, key) => value == null ? undefined : value[key], source);
}

function claimText(source, pathValue) {
  const value = getClaimByPath(source, pathValue);
  return value === undefined || value === null ? '' : String(value).trim();
}

function claimIdentifier(source, pathValue) {
  const value = getClaimByPath(source, pathValue);
  const id = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : '';
  return id && id === id.trim() && id.length <= 512 && id.isWellFormed() ? id : '';
}

function claimBoolean(source, pathValue) {
  const value = getClaimByPath(source, pathValue);
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function decodeJwt(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded !== 'object' || !decoded.header || !decoded.payload) throw new Error('OIDC ID Token is not a valid JWT');
  return decoded;
}

async function verifyOidcIdToken(idToken, endpoints, nonce, config = OIDC_CONFIG) {
  const decoded = decodeJwt(idToken);
  const algorithm = normalizeText(decoded.header.alg);
  const allowedAlgorithms = config.allowedAlgorithms.length ? config.allowedAlgorithms : ['RS256'];
  if (!allowedAlgorithms.includes(algorithm)) throw new Error(`OIDC ID Token algorithm ${algorithm} is not allowed`);
  if (!config.validateIdToken) throw new Error('Unverified ID Tokens cannot be used as identity claims');
  if (!['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'HS256', 'HS384', 'HS512'].includes(algorithm)) {
    throw new Error('Unsupported OIDC signature algorithm');
  }
  const verifyOptions = {
    algorithms: allowedAlgorithms,
    audience: config.clientId,
    clockTolerance: Number.isFinite(config.clockTolerance) ? config.clockTolerance : 60
  };
  if (endpoints.issuer) verifyOptions.issuer = endpoints.issuer;
  let verificationKey = config.idTokenHmacSecret;
  if (!algorithm.startsWith('HS')) {
    if (!endpoints.jwksUrl) throw new Error('OIDC JWKS URL is required for asymmetric ID Token validation');
    const jwks = await fetchJson(endpoints.jwksUrl);
    const keys = Array.isArray(jwks.keys) ? jwks.keys : [];
    const candidates = keys.filter(key => (!key.use || key.use === 'sig') && (!key.alg || key.alg === algorithm)
      && (!key.key_ops || key.key_ops.includes('verify')) && (!decoded.header.kid || key.kid === decoded.header.kid));
    const jwk = candidates.length === 1 ? candidates[0] : null;
    if (!jwk) throw new Error('No matching OIDC signing key was found');
    verificationKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } else if (!verificationKey) {
    throw new Error('OIDC HMAC validation secret is not configured');
  }
  const verified = jwt.verify(idToken, verificationKey, verifyOptions);
  if (!Number.isInteger(verified.exp) || !Number.isInteger(verified.iat) || typeof verified.sub !== 'string' || !claimIdentifier(verified, 'sub')
      || verified.iat > Date.now() / 1000 + verifyOptions.clockTolerance
      || (Array.isArray(verified.aud) && verified.aud.length > 1 && verified.azp !== config.clientId)
      || (verified.azp && verified.azp !== config.clientId)) {
    throw new Error('OIDC ID Token is missing required claims or has an invalid authorized party');
  }
  if (nonce && verified.nonce !== nonce) throw new Error('OIDC nonce mismatch');
  return verified;
}

function appendQuery(pathname, params) {
  const query = new URLSearchParams(params);
  return `${pathname}${pathname.includes('?') ? '&' : '?'}${query.toString()}`;
}

function oidcErrorRedirect(state, message) {
  return appendQuery(state?.linkUserId || state?.mergeUserId ? '/profile' : '/oauth2/authorize', {
    oidc_error: 'login_failed',
    oidc_error_description: String(message || 'OIDC login failed').slice(0, 300)
  });
}

async function exchangeOidcCode(code, codeVerifier, endpoints, redirectUri, config = OIDC_CONFIG) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.clientId });
  if (config.pkceEnabled && codeVerifier) body.set('code_verifier', codeVerifier);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (config.tokenAuthMethod === 'client_secret_basic') {
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    body.delete('client_id');
  } else if (config.tokenAuthMethod === 'client_secret_post') {
    body.set('client_secret', config.clientSecret);
  } else {
    throw new Error('OIDC token auth method must be client_secret_basic or client_secret_post');
  }
  return fetchJson(endpoints.tokenUrl, { method: 'POST', headers, body: body.toString() });
}

// 华为等提供方的 userinfo 不接受 Bearer 头，需要 POST + form 传递 access_token。
// 请求方式必须可配，否则「配置看起来正确、调用必然失败」。
async function fetchOidcUserinfo(config, endpoints, accessToken) {
  if (!endpoints.userinfoUrl || !accessToken) return {};
  const method = config.userinfoMethod === 'POST' ? 'POST' : 'GET';
  const formBody = new URLSearchParams();

  if (config.userinfoTokenIn === 'body_form') {
    formBody.set('access_token', accessToken);
    if (method === 'GET') {
      const separator = endpoints.userinfoUrl.includes('?') ? '&' : '?';
      return fetchJson(`${endpoints.userinfoUrl}${separator}${formBody.toString()}`);
    }
    return fetchJson(endpoints.userinfoUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString()
    });
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  if (method === 'POST') {
    return fetchJson(endpoints.userinfoUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString()
    });
  }
  return fetchJson(endpoints.userinfoUrl, { headers });
}

async function findOrCreateOidcUser(claims, linkUserId = '', config = OIDC_CONFIG) {
  const provider = normalizeText(config.providerKey).toLowerCase();
  const providerUserId = normalizeText(claims.id);
  const providerSecondaryId = normalizeText(claims.secondaryId);
  const email = normalizeEmail(claims.email);
  if (!providerUserId) throw new Error('OIDC account did not provide a subject identifier');

  // 主标识（华为 unionID）与第二标识（华为 openID）都要参与匹配，否则换配置会分裂账号。
  const existingIdentity = await ExternalIdentity.findByProviderSubject(provider, providerUserId, providerSecondaryId);
  if (existingIdentity) {
    const linkedUser = await User.findById(existingIdentity.user_id);
    if (!linkedUser) throw new Error('The linked local user no longer exists');
    if (linkUserId && existingIdentity.user_id !== linkUserId) {
      throw new Error('This third-party account is already linked to another user');
    }
    const priorProfile = ExternalIdentity.serialize(existingIdentity).profile;
    const changes = {
      providerUsername: claims.username,
      displayName: claims.name,
      avatar: claims.picture,
      email: claims.email,
      profile: {
        ...claims.profile,
        _vaultsso: priorProfile._vaultsso
          || { issuer: priorProfile.iss || '', clientId: priorProfile.aud || '' }
      }
    };
    // 第二标识缺失时补写，保证后续换应用/换配置仍能命中同一个账号。
    if (providerSecondaryId && !existingIdentity.provider_secondary_id) {
      changes.providerSecondaryId = providerSecondaryId;
    }
    await ExternalIdentity.update(existingIdentity.id, changes);
    return linkedUser;
  }

  if (linkUserId) {
    const linkedUser = await User.findById(linkUserId);
    if (!linkedUser) throw new Error('The local account for this binding no longer exists');
    await ExternalIdentity.create({
      userId: linkedUser.id,
      provider,
      providerUserId,
      providerSecondaryId,
      providerUsername: claims.username,
      displayName: claims.name,
      avatar: claims.picture,
      email,
      profile: claims.profile
    });
    return linkedUser;
  }

  const emailVerified = Boolean(claims.emailVerified);
  if (config.requireEmailVerified && !emailVerified) throw new Error('OIDC account email is not verified');
  const existingUser = email && isValidEmail(email) ? await User.findByUsername(email) : null;
  if (existingUser) {
    throw new Error('Sign in to the existing local account and explicitly link this identity from your profile');
  }

  if (!await isSettingEnabled('registration_enabled')) throw new Error('Registration is disabled');

  const localEmail = email && isValidEmail(email) && emailVerified
    ? email
    : `${provider}-${crypto.createHash('sha256').update(providerUserId).digest('hex').slice(0, 24)}@users.invalid`;
  const usernameBase = (claims.username || (email ? email.split('@')[0] : '') || 'oidc-user').slice(0, 220);
  let username = usernameBase;
  let suffix = 0;
  while ((await User.findByUsername(username)) && suffix < 20) {
    suffix += 1;
    username = `${usernameBase}-${suffix}`;
  }
  const user = await User.create({ username, email: localEmail, password: '', name: claims.name || claims.username || email || username, avatar: claims.picture || '', emailVerified });
  await ExternalIdentity.create({
    userId: user.id,
    provider,
    providerUserId,
    providerSecondaryId,
    providerUsername: claims.username,
    displayName: claims.name,
    avatar: claims.picture,
    email,
    profile: claims.profile
  });
  return user;
}

function serializeUser(user) {
  const role = normalizeText(user.role).toLowerCase() || 'user';

  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    avatar: user.avatar || '',
    role,
    isAdmin: role === USER_ROLE_ADMIN,
    banned: Boolean(user.banned ?? user.is_banned),
    emailVerified: Boolean(user.emailVerified ?? user.email_verified),
    description: user.description || '',
    credits: Number(user.credits ?? 0) || 0,
    lastLoginIp: user.last_login_ip || user.lastLoginIp || '',
    phoneCountryCode: user.phone_country_code || '',
    phoneNationalNumber: user.phone_number || '',
    phoneE164: user.phone_e164 || '',
    phoneMasked: phoneNumbers.maskPhone(user.phone_country_code, user.phone_number),
    phoneVerified: Boolean(user.phone_verified),
    phoneVerifiedAt: user.phone_verified_at || null,
    totpEnabled: Boolean(user.totp_enabled),
    captchaRequired: Boolean(user.captcha_required),
    createdAt: user.createdAt || user.created_at || null,
    updatedAt: user.updatedAt || user.updated_at || null
  };
}

function scopedUserClaims(user, scopes) {
  const claims = { sub: user.id };
  if (scopes.includes('profile')) {
    Object.assign(claims, {
      name: user.name, preferred_username: user.username, username: user.username, picture: user.avatar,
      description: user.description || '',
      updated_at: Math.floor(new Date(user.updated_at || Date.now()).getTime() / 1000)
    });
  }
  if (scopes.includes('email')) {
    claims.email = user.email;
    claims.email_verified = Boolean(user.email_verified);
  }
  // 手机号属于个人信息，只有显式申请 phone scope 才下发，且一律使用 E.164。
  if (scopes.includes('phone') && user.phone_e164) {
    claims.phone_number = user.phone_e164;
    claims.phone_number_verified = Boolean(user.phone_verified);
  }
  // 角色属于非标准声明，只在客户端显式请求 roles scope 时下发，
  // 避免任何拿到 profile 的客户端都能看到用户的权限级别。
  if (scopes.includes('roles')) {
    const role = normalizeText(user.role).toLowerCase() || USER_ROLE_USER;
    claims.role = role;
    claims.isAdmin = role === USER_ROLE_ADMIN;
  }
  return claims;
}

function validateToken(token, expectedType = 'session') {
    try {
      const decoded = expectedType === 'access'
        ? signingKeys.verify(token, PUBLIC_BASE_URL)
        : jwt.verify(token, JWT_SECRET, {
          algorithms: ['HS256'], issuer: PUBLIC_BASE_URL,
          ...(['session', 'oidc_pending'].includes(expectedType) ? { audience: PUBLIC_BASE_URL } : {})
        });
      if (decoded.type !== expectedType || typeof decoded.sub !== 'string' || !Number.isInteger(decoded.exp)) return null;
      return decoded;
    } catch { return null; }
  }

function createSessionToken(user, sid, expiresAt) {
    return jwt.sign({
      sub: user.id, sid, type: 'session', iss: PUBLIC_BASE_URL, aud: PUBLIC_BASE_URL,
      exp: Math.floor(expiresAt / 1000)
    }, JWT_SECRET, { algorithm: 'HS256' });
  }

function sessionCookieOptions(maxAge = SESSION_MAX_AGE) {
    const options = { httpOnly: true, secure: RUNTIME.secureCookies, sameSite: 'lax', path: '/' };
    if (maxAge !== null) options.maxAge = maxAge;
    if (COOKIE_DOMAIN) options.domain = COOKIE_DOMAIN;
    return options;
  }

async function setSessionCookie(req, res, user, database = pool) {
    const sid = crypto.randomUUID();
    const maxAge = Math.min(SESSION_MAX_AGE, SESSION_ABSOLUTE_TTL_MS);
    const expiresAt = Date.now() + maxAge;
    req.authSession = await new SessionModel(database).create({
      userId: user.id, token: sid, ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '', expiresAt
    });
    req.authenticatedUser = user;
    res.cookie('session', createSessionToken(user, sid, expiresAt), sessionCookieOptions(maxAge));
  }

async function getAuthenticatedUser(req, res = null) {
    if (req.authenticatedUser) return req.authenticatedUser;
    const session = validateToken(req.cookies.session);
    if (!session || !session.sid) return null;
    const row = await Session.findActiveTokenByToken(session.sid);
    if (!row || row.user_id !== session.sub) return null;
    const absoluteExpiry = new Date(row.created_at).getTime() + SESSION_ABSOLUTE_TTL_MS;
    if (!Number.isFinite(absoluteExpiry) || absoluteExpiry <= Date.now()) return null;
    const user = await User.findById(row.user_id);
    if (!user || isUserBanned(user)) return null;
    req.authSession = row;
    req.authenticatedUser = user;
    if (res && session.iat * 1000 < Date.now() - SESSION_REFRESH_THRESHOLD_MS) {
      const expiresAt = Math.min(Date.now() + SESSION_MAX_AGE, absoluteExpiry);
      if (await Session.extend(row.id, expiresAt)) {
        res.cookie('session', createSessionToken(user, row.token, expiresAt), sessionCookieOptions(expiresAt - Date.now()));
      } else {
        req.authenticatedUser = null;
        return null;
      }
    }
    return user;
  }

async function verifyTotpLocked(user, code, authenticators, users) {
    const rows = await authenticators.list(user.id);
    for (const credential of rows.filter(row => row.activated_at)) {
      let secret;
      try { secret = totpCipher.decrypt(credential.secret); } catch { continue; }
      const counter = matchingTotpCounter(secret, code);
      if (counter !== null && await authenticators.consumeCounter(credential.id, counter)) return true;
    }
    if (!user.totp_secret) return false;
    let secret;
    try { secret = totpCipher.decrypt(user.totp_secret); } catch { return false; }
    const counter = matchingTotpCounter(secret, code);
    return counter !== null && await users.consumeTotpCounter(user.id, counter);
}

async function verifyTotpOnce(user, code) {
    const limit = await RateLimit.consume(`totp:${user.id}`, 10, 5 * 60 * 1000);
    if (!limit.allowed) return false;
    const valid = await Authenticator.withUser(user.id, async (current, authenticators, users) => {
      if (!current || !current.totp_enabled || pendingLoginSecurityState(current) !== pendingLoginSecurityState(user)) return false;
      return verifyTotpLocked(current, code, authenticators, users);
    });
    if (valid) await RateLimit.clear(`totp:${user.id}`);
    return valid;
}

const OIDC_PENDING_COOKIE = 'oidc_pending';

function pendingLoginSecurityState(user) {
  return crypto.createHmac('sha256', JWT_SECRET).update(JSON.stringify([
    user.password, user.email, user.role, user.banned, user.phone_e164,
    user.phone_country_code, user.phone_number, user.totp_enabled, user.totp_secret, Number(user.totp_revision || 0)
  ])).digest('hex');
}

async function beginOidcSecondFactor(res, user, returnTo, factor, providerKey, source = 'external', extraContext = {}) {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const challenge = crypto.randomBytes(32).toString('base64url');
  if (factor === 'email') {
    await issueEmailVerificationCode({ email: user.email, purpose: EMAIL_PURPOSE_LOGIN, userId: user.id });
  }
  const record = await EmailVerificationCode.create({
    email: user.email, userId: user.id, purpose: source === 'password' ? 'password_mfa' : 'oidc_mfa',
    codeHash: crypto.createHash('sha256').update(challenge).digest('hex'), expiresAt,
    pendingContext: { returnTo: getOidcReturnPath(returnTo), ...extraContext }
  });
  const pending = jwt.sign({
    sub: user.id, jti: record.id, challenge, factor, provider: providerKey, source,
    securityState: pendingLoginSecurityState(user),
    type: 'oidc_pending', iss: PUBLIC_BASE_URL, aud: PUBLIC_BASE_URL, exp: Math.floor(expiresAt.getTime() / 1000)
  }, JWT_SECRET, { algorithm: 'HS256' });
  res.cookie(OIDC_PENDING_COOKIE, pending, { httpOnly: true, secure: RUNTIME.secureCookies, sameSite: 'lax', path: '/', maxAge: 5 * 60 * 1000 });
  // 原生 App 未必保留 Cookie，因此同时返回同一个凭据，供 X-Oidc-Pending 头回传。
  return pending;
}

const OIDC_PENDING_HEADER = 'x-oidc-pending';

async function getPendingOidcLogin(req) {
  const supplied = normalizeText(req.get(OIDC_PENDING_HEADER)) || normalizeText(req.body?.pending_token);
  const pending = validateToken(supplied || req.cookies[OIDC_PENDING_COOKIE], 'oidc_pending');
  if (!pending) return null;
  if (pending.source !== 'password') {
    await refreshOidcProvidersFromDatabase();
    // External pending logins may originate from either OIDC or Huawei.
    const providerConfig = getOidcProviderConfig(pending.provider);
    if (!isOidcEnabled(providerConfig) && !isHuaweiEnabled(providerConfig)) return null;
  }
  const record = await EmailVerificationCode.findById(pending.jti);
  const purpose = pending.source === 'password' ? 'password_mfa' : 'oidc_mfa';
  if (!record || record.purpose !== purpose || record.user_id !== pending.sub || record.consumed_at
      || new Date(record.expires_at) <= new Date()
      || record.code_hash !== crypto.createHash('sha256').update(pending.challenge).digest('hex')) return null;
  let context;
  try {
    context = typeof record.pending_context === 'string' ? JSON.parse(record.pending_context) : record.pending_context;
  } catch { return null; }
  if (!context || !isSafeFrontendPath(context.returnTo)) return null;
  if (pending.source === 'huawei' && (!context.huawei || typeof context.huawei !== 'object')) return null;
  pending.returnTo = context.returnTo;
  const user = await User.findById(pending.sub);
  if (!user || isUserBanned(user) || pending.securityState !== pendingLoginSecurityState(user)) return null;
  return { pending, record, user, context };
}

async function beginPasswordSecondFactor(req, res, user, factor) {
  const validation = await validateAuthorizationRequest(req.body);
  if (validation.body) return res.status(validation.status).json(validation.body);
  const continuation = new URLSearchParams();
  if (validation.value) {
    for (const key of ['client_id', 'redirect_uri', 'scope', 'state', 'nonce', 'response_type', 'code_challenge', 'code_challenge_method']) {
      if (req.body[key] !== undefined) continuation.set(key, normalizeText(req.body[key]));
    }
  }
  await beginOidcSecondFactor(res, user, validation.value ? `/oauth2/authorize?${continuation}` : '/profile', factor, '', 'password');
  grantCaptchaContinuation(req, res, user.id);
  await recordLoginLog({ username: user.username, userId: user.id, req, result: factor === 'totp' ? 'totp_required' : 'email_code_required' });
  return res.json({
    mfa_url: '/oauth2/mfa', require_totp: factor === 'totp', require_email_code: factor === 'email',
    email_masked: factor === 'email' ? maskEmail(user.email) : undefined,
    message_key: factor === 'totp' ? 'auth.totp.required' : 'auth.login_code.sent'
  });
}

async function completePasswordLogin(req, res, user, database = pool) {
  const users = new UserModel(database);
  const ip = getClientIp(req);
  await new RateLimitModel(database).clear(`login:${user.id}`);
  res.clearCookie('login_step', { httpOnly: true, secure: RUNTIME.secureCookies, sameSite: 'strict', path: '/' });
  await detectAndFlagAnomalousLogin(user, req, 'success', database);
  if (user.captcha_required) await users.update(user.id, { captchaRequired: false });
  const previousIp = normalizeText(user.last_login_ip || user.lastLoginIp);
  if (previousIp && previousIp !== ip && user.email) {
    sendLoginAlertEmail({ to: user.email, ip, userAgent: req.headers['user-agent'] }).catch(() => {});
  }
  await users.update(user.id, { lastLoginIp: ip });
  await recordLoginLog({ username: user.username, userId: user.id, req, result: 'success', database });
  await setSessionCookie(req, res, user, database);
}

async function finishAccountLogin(user, work) {
  return Authenticator.withUser(user.id, async (current, authenticators, users, connection) => {
    if (!current || isUserBanned(current) || pendingLoginSecurityState(current) !== pendingLoginSecurityState(user)) {
      return authenticatorError(401, 'auth.mfa.expired', '账户安全状态已改变，请重新登录');
    }
    return work(current, connection);
  });
}

async function rejectLockedLogin(req, res, username, attempt) {
  const minutes = Math.max(1, Math.ceil(attempt.retryAfter / 60));
  res.setHeader('Retry-After', String(attempt.retryAfter));
  await recordLoginLog({ username, req, result: 'locked' });
  return res.status(429).json({
    error: 'too_many_attempts', error_key: 'auth.locked',
    error_description: `登录失败次数过多，请 ${minutes} 分钟后再试`
  });
}

function isAdminUser(user) {
  return normalizeText(user?.role).toLowerCase() === USER_ROLE_ADMIN;
}

function isUserBanned(user) {
  return Boolean(user && (user.banned ?? user.is_banned));
}

function isClientActive(client) {
  return Boolean(client && client.is_active !== false && client.is_active !== 0);
}
/**
 * 校验登出后的跳回地址：必须是 http(s) 绝对地址，host 等于或属于
 * LOGOUT_REDIRECT_HOSTS 白名单中的注册域名（含子域名）；未配置白名单时返回空，
 * 保持登出后回到本服务登录页的既有行为。
 */
function resolveLogoutRedirect(rawValue) {
  const raw = normalizeText(rawValue);
  if (!raw || LOGOUT_REDIRECT_HOSTS.length === 0) {
    return '';
  }
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return '';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return '';
  }
  const isLocalDev = ['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !isLocalDev) {
    return '';
  }
  const host = url.hostname.toLowerCase();
  const allowed = LOGOUT_REDIRECT_HOSTS.some(entry =>
    host === entry || host.endsWith(`.${entry}`));
  return allowed ? url.toString() : '';
}

function parseRequestedScopes(scopeValue, fallbackScopes = ['openid']) {
  const scopes = normalizeText(scopeValue).split(/\s+/).filter(Boolean);
  return scopes.length ? Array.from(new Set(scopes)) : fallbackScopes;
}

function findUnsupportedScopes(requestedScopes, allowedScopes) {
  const allowedSet = new Set(Array.isArray(allowedScopes) ? allowedScopes : []);
  return requestedScopes.filter(scope => !allowedSet.has(scope));
}

function verifyPkceChallenge(authCodeData, codeVerifier) {
  if (authCodeData.code_challenge === null || authCodeData.code_challenge === undefined) {
    return authCodeData.code_challenge_method === null || authCodeData.code_challenge_method === undefined;
  }
  const codeChallenge = normalizeText(authCodeData.code_challenge);
  if (authCodeData.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return false;

  const verifier = normalizeText(codeVerifier);
  if (!CODE_CHALLENGE_PATTERN.test(verifier)) {
    return false;
  }

  const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
  return digest.length === codeChallenge.length && crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(codeChallenge));
}

function buildAuthorizationServerMetadata(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth2/authorize`,
    token_endpoint: `${baseUrl}/oauth2/token`,
    userinfo_endpoint: `${baseUrl}/oauth2/userinfo`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'phone', 'roles', 'offline_access'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: ['sub', 'name', 'preferred_username', 'username', 'email', 'email_verified', 'picture', 'phone_number', 'phone_number_verified', 'updated_at'],
    introspection_endpoint: `${baseUrl}/oauth2/introspect`,
    revocation_endpoint: `${baseUrl}/oauth2/revoke`,
    service_documentation: `${baseUrl}/api-docs.html`,
    ui_locales_supported: ['zh-CN', 'zh-TW', 'en']
  };
}

function parseClientCredentials(req) {
  const authHeader = normalizeText(req.headers.authorization);
  if (authHeader) {
    const invalid = { clientId: '', clientSecret: '', method: 'client_secret_basic' };
    if (!/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(authHeader) || req.body.client_secret !== undefined) return invalid;
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        return {
          clientId: decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' ')),
          clientSecret: decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, ' ')),
          method: 'client_secret_basic'
        };
      }
    } catch (error) {
      return invalid;
    }
    return invalid;
  }

  return {
    clientId: normalizeText(req.body.client_id),
    clientSecret: normalizeText(req.body.client_secret),
    method: 'client_secret_post'
  };
}

async function authenticateClient(req, res) {
  const credentials = parseClientCredentials(req);
  if (!credentials.clientId || !credentials.clientSecret || (RUNTIME.production && Buffer.byteLength(credentials.clientSecret) < 32)) {
    res.status(401).json({
      error: 'invalid_client',
      error_key: 'oauth.client.credentials.required',
      error_description: 'Client authentication is required'
    });
    return null;
  }

  const client = await Client.findById(credentials.clientId);
  if (!client || client.id !== credentials.clientId || !await verifyClientSecret(credentials.clientSecret, client.secret)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="oauth2"');
    res.status(401).json({
      error: 'invalid_client',
      error_key: 'oauth.client.credentials.invalid',
      error_description: 'Invalid client credentials'
    });
    return null;
  }

  if (!isClientActive(client)) {
    res.status(403).json({
      error: 'access_denied',
      error_key: 'oauth.client.inactive',
      error_description: 'Client is disabled'
    });
    return null;
  }

  return client;
}

async function requireAuthenticatedUser(req, res) {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    res.status(401).json({
      error: 'unauthorized',
      error_key: 'auth.required',
      error_description: '请先登录'
    });
    return null;
  }

  return user;
}

async function requireAdminUser(req, res) {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) {
    return null;
  }

  if (!isAdminUser(user)) {
    res.status(403).json({
      error: 'forbidden',
      error_key: 'auth.forbidden.admin_required',
      error_description: '仅管理员可访问此资源'
    });
    return null;
  }

  return user;
}

app.use(asyncHandler(async (req, res, next) => {
  if (!ADMIN_ONLY_STATIC_PATHS.has(req.path)) {
    next();
    return;
  }

  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    res.redirect('/oauth2/authorize');
    return;
  }

  if (!isAdminUser(user)) {
    res.redirect(`/oauth2/error?error=access_denied&error_description=${encodeURIComponent('仅管理员可访问此页面')}`);
    return;
  }

  next();
}));

for (const [staticPath, pageName] of adminPagePaths) {
  app.get(staticPath, asyncHandler(async (req, res) => {
    const user = await requireAdminUser(req, res);
    if (user) res.sendFile(pageFile(pageName));
  }));
}
app.get('/i18n.js', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'js', 'shared', 'i18n.js')));
app.get('/api-docs.html', (req, res) => res.sendFile(pageFile('docs')));
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), { dotfiles: 'deny', index: false }));
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { dotfiles: 'deny', index: false }));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { dotfiles: 'deny', index: false }));

function serializeClient(client) {
  return {
    id: client.id,
    name: client.name,
    logoUrl: client.logo_url || '',
    isActive: Boolean(client.is_active),
    requirePkce: client.requirePkce !== false,
    redirectUris: client.redirectUris,
    scopes: client.scopes,
    createdAt: client.created_at || null,
    updatedAt: client.updated_at || null
  };
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => normalizeText(item))
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/\r?\n|,/)
      .map(item => normalizeText(item))
      .filter(Boolean);
  }

  return [];
}

function validateClientPayload(body, options = {}) {
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'isActive must be a boolean' } };
  }
  if (body.requirePkce !== undefined && typeof body.requirePkce !== 'boolean') {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'requirePkce must be a boolean' } };
  }
  const requireSecret = options.requireSecret === true;
  const clientId = normalizeText(body.id);
  const name = normalizeText(body.name);
  const secret = normalizeText(body.secret);
  const logoUrl = normalizeText(body.logoUrl);
  const redirectUris = toStringArray(body.redirectUris);
  const scopes = toStringArray(body.scopes);
  const isActive = body.isActive !== undefined ? Boolean(body.isActive) : true;
  const requirePkce = body.requirePkce !== undefined ? body.requirePkce : true;

  if (options.requireId !== false) {
    if (!clientId || !/^[a-zA-Z0-9][a-zA-Z0-9-_]{1,127}$/.test(clientId)) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          error_key: 'clients.validation.id',
          error_description: '客户端 ID 格式无效'
        }
      };
    }
  }

  if (!name) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        error_key: 'clients.validation.name',
        error_description: '客户端名称不能为空'
      }
    };
  }

  if (requireSecret && !secret) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        error_key: 'clients.validation.secret',
        error_description: '客户端密钥不能为空'
      }
    };
  }

  if (secret && (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 256)) {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'Client secrets must contain 32-256 bytes' } };
  }
  if (name.length > 255 || redirectUris.length > 30 || scopes.length > 50) {
    return { ok: false, status: 400, body: { error: 'invalid_request', error_description: 'Client configuration exceeds the supported limits' } };
  }

  if (!redirectUris.length) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        error_key: 'clients.validation.redirects',
        error_description: '至少需要一个回调地址'
      }
    };
  }

  for (const redirectUri of redirectUris) {
    try {
      const url = new URL(redirectUri);
      const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
      if (url.username || url.password || url.hash || redirectUri.length > 2048
          || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !RUNTIME.production))) {
        throw new Error('Redirects must use HTTPS without credentials or fragments');
      }
    } catch (error) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          error_key: 'auth.request.invalid_redirect_uri',
          error_description: `无效的回调地址：${redirectUri}`
        }
      };
    }
  }

  if (!scopes.length) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'invalid_request',
        error_key: 'clients.validation.scopes',
        error_description: '至少需要一个 scope'
      }
    };
  }

  if (logoUrl) {
    try {
      const url = new URL(logoUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid logo URL');
    } catch (error) {
      return {
        ok: false,
        status: 400,
        body: {
          error: 'invalid_request',
          error_key: 'clients.validation.logo',
          error_description: 'Logo 地址无效'
        }
      };
    }
  }

  return {
    ok: true,
    value: {
      id: clientId,
      name,
      secret,
      redirectUris,
      scopes,
      logoUrl,
      isActive,
      requirePkce
    }
  };
}

async function findUserConflicts({ username, email, excludeUserId }) {
  const normalizedUsername = normalizeText(username).toLowerCase();
  const normalizedEmail = normalizeEmail(email);
  const users = await User.findPotentialConflicts(normalizedUsername, normalizedEmail);

  let usernameConflict = null;
  let emailConflict = null;

  for (const user of users) {
    if (excludeUserId && user.id === excludeUserId) {
      continue;
    }

    if (!usernameConflict && normalizedUsername && [user.username.toLowerCase(), user.email.toLowerCase()].includes(normalizedUsername)) {
      usernameConflict = user;
    }

    if (!emailConflict && normalizedEmail && [user.email.toLowerCase(), user.username.toLowerCase()].includes(normalizedEmail)) {
      emailConflict = user;
    }
  }

  return { usernameConflict, emailConflict };
}

function normalizeEmailPurpose(value) {
  const purpose = normalizeText(value).toLowerCase();
  return [EMAIL_PURPOSE_REGISTER, EMAIL_PURPOSE_PASSWORD_RESET, EMAIL_PURPOSE_LOGIN, EMAIL_PURPOSE_EMAIL_CHANGE].includes(purpose) ? purpose : '';
}

function generateEmailCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function hashEmailCode(email, purpose, code) {
  return crypto
    .createHash('sha256')
    .update(`${JWT_SECRET}:${normalizeEmail(email)}:${purpose}:${normalizeText(code)}`)
    .digest('hex');
}

function getEmailCodeExpiresAt() {
  return new Date(Date.now() + EMAIL_CODE_TTL_MS);
}

function getEmailCodeExpiryMinutes() {
  return Math.max(1, Math.ceil(EMAIL_CODE_TTL_MS / 60000));
}

async function issueEmailVerificationCode({ email, purpose, userId = null }) {
  const cooldown = await RateLimit.consume(`email:${purpose}:${normalizeEmail(email)}`, 1, 60 * 1000);
  if (!cooldown.allowed) {
    const error = new Error('发送过于频繁，请 1 分钟后再试');
    error.status = 429;
    error.code = 'email_code.cooldown';
    throw error;
  }
  const code = generateEmailCode();
  await EmailVerificationCode.invalidate(email, purpose);
  const record = await EmailVerificationCode.create({
    email,
    purpose,
    userId,
    codeHash: hashEmailCode(email, purpose, code),
    expiresAt: getEmailCodeExpiresAt()
  });

  try {
    return await sendVerificationEmail({ to: email, code, purpose, expiresInMinutes: getEmailCodeExpiryMinutes() });
  } catch (error) {
    await EmailVerificationCode.consume(record.id);
    const deliveryError = new Error('验证码邮件发送失败，请稍后再试或联系管理员');
    deliveryError.status = 502;
    deliveryError.code = 'email_delivery_failed';
    throw deliveryError;
  }
}

async function verifyEmailCode({ email, purpose, code, userId }) {
  const normalizedCode = normalizeText(code);
  if (!/^\d{6}$/.test(normalizedCode)) {
    return {
      ok: false,
      status: 400,
      error_key: 'email_code.invalid',
      error_description: '验证码格式不正确'
    };
  }

  const record = await EmailVerificationCode.findLatestActive(email, purpose);
  if (!record || (userId !== undefined && record.user_id !== userId)) {
    return {
      ok: false,
      status: 400,
      error_key: 'email_code.expired',
      error_description: '验证码不存在或已过期'
    };
  }

  if (!await EmailVerificationCode.incrementAttempts(record.id, EMAIL_CODE_MAX_ATTEMPTS)) {
    return {
      ok: false,
      status: 429,
      error_key: 'email_code.too_many_attempts',
      error_description: '验证码尝试次数过多，请重新获取'
    };
  }

  if (record.code_hash !== hashEmailCode(email, purpose, normalizedCode)) {
    return {
      ok: false,
      status: 400,
      error_key: 'email_code.invalid',
      error_description: '验证码不正确'
    };
  }

  if (!await EmailVerificationCode.consume(record.id)) {
    return { ok: false, status: 400, error_key: 'email_code.expired', error_description: '验证码已被使用或已过期' };
  }
  return { ok: true };
}

async function generateAccessToken(userId, clientId, scopes) {
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  const token = signingKeys.sign({
    sub: userId || clientId,
    type: 'access',
    iss: PUBLIC_BASE_URL,
    grant_type: userId ? 'authorization_code' : 'client_credentials',
    aud: clientId,
    scope: scopes.join(' '),
    jti: tokenId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000)
  });

  await Token.createAccessToken({
    id: tokenId,
    token,
    userId,
    clientId,
    scopes,
    expiresAt
  });

  return token;
}

async function generateRefreshToken(userId, clientId, scopes = ['openid', 'profile', 'email']) {
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);
  const token = jwt.sign({
    sub: userId,
    aud: clientId,
    type: 'refresh',
    iss: PUBLIC_BASE_URL,
    jti: tokenId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000)
  }, JWT_SECRET, { algorithm: 'HS256' });

  await Token.createRefreshToken({
    id: tokenId,
    token,
    userId,
    clientId,
    scopes,
    expiresAt
  });

  return token;
}



async function validateAuthorizationRequest(params, database = pool) {
    const clientId = normalizeText(params.client_id);
    const redirectUri = normalizeText(params.redirect_uri);
    const error = (name, description, status = 400) => ({ status, body: { error: name, error_description: description } });
    if (!clientId && !redirectUri) return { value: null };
  if (!clientId || !redirectUri) return error('invalid_request', 'client_id and redirect_uri are required together');
  if (params.prompt !== undefined || params.max_age !== undefined || (params.response_mode && params.response_mode !== 'query')) {
    return error('invalid_request', 'prompt, max_age and non-query response modes are not supported');
  }
    if ((normalizeText(params.response_type) || 'code') !== 'code') return error('unsupported_response_type', 'Only response_type=code is supported');
    const client = await new ClientModel(database).findById(clientId);
    if (!client || client.id !== clientId) return error('invalid_client', 'Unknown client');
    if (!isClientActive(client)) return error('access_denied', 'Client is disabled', 403);
    if (!client.redirectUris.includes(redirectUri)) return error('invalid_redirect_uri', 'Invalid redirect URI');
    let url;
    try { url = new URL(redirectUri); } catch { return error('invalid_redirect_uri', 'Invalid redirect URI'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !RUNTIME.production))) {
      return error('invalid_redirect_uri', 'Redirect URI must use HTTPS without credentials or fragments');
    }
    const scopes = parseRequestedScopes(params.scope);
    if (findUnsupportedScopes(scopes, client.scopes).length) return error('invalid_scope', 'Unsupported scope');
    const hasCodeChallenge = params.code_challenge !== undefined;
    const hasCodeChallengeMethod = params.code_challenge_method !== undefined;
    const requirePkce = client.requirePkce !== false;
    let codeChallenge = null;
    let codeChallengeMethod = null;
    if (requirePkce || hasCodeChallenge || hasCodeChallengeMethod) {
      codeChallenge = normalizeText(params.code_challenge);
      codeChallengeMethod = normalizeText(params.code_challenge_method);
      if (codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
        return error('invalid_request', 'A valid S256 code_challenge and code_challenge_method are required for this client or request');
      }
    }
    const nonce = normalizeText(params.nonce);
    const state = normalizeText(params.state);
    if (nonce.length > 255 || state.length > 2048) return error('invalid_request', 'nonce or state is too long');
    return { value: { client, redirectUri, scopes, codeChallenge, codeChallengeMethod, nonce, state } };
  }

async function buildAuthorizationResponse(user, params, database = pool) {
    const result = await validateAuthorizationRequest(params, database);
    if (result.body) return result;
    if (!result.value) return { status: 200, body: { message_key: 'auth.login_success', message: '登录成功', redirect: '/profile' } };
    const { client, redirectUri, scopes, codeChallenge, codeChallengeMethod, nonce, state } = result.value;
    const authCode = await new TokenModel(database).createAuthCode({
      userId: user.id, clientId: client.id, redirectUri, scopes, codeChallenge,
      codeChallengeMethod, nonce, expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    });
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', authCode.code);
    if (state) redirect.searchParams.set('state', state);
    return { status: 200, body: { redirect: redirect.toString() } };
  }

app.get('/.well-known/openid-configuration', (req, res) => {
  res.json(buildAuthorizationServerMetadata(getBaseUrl(req)));
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(buildAuthorizationServerMetadata(getBaseUrl(req)));
});

app.get('/.well-known/jwks.json', (req, res) => {
  res.json(signingKeys.jwks);
});

app.get('/oauth2/authorize', asyncHandler(async function authorizePage(req, res) {
  const validation = await validateAuthorizationRequest(req.query);
  if (validation.body) return res.status(validation.status).json(validation.body);
  if (validation.value) {
    const user = await getAuthenticatedUser(req, res);
    if (user) {
      const result = await finishAccountLogin(user, async (current, connection) => {
        const session = await new SessionModel(connection).findById(req.authSession.id);
        if (!session || session.revoked_at || new Date(session.expires_at) <= new Date()) {
          return authenticatorError(401, 'auth.mfa.expired', '登录已失效，请重新登录');
        }
        return buildAuthorizationResponse(current, req.query, connection);
      });
      if (result.status !== 200) return res.status(result.status).json(result.body);
      return res.redirect(result.body.redirect);
    }
  }
  res.sendFile(pageFile('login'));
}));

app.get('/login', (req, res) => {
  res.redirect('/oauth2/authorize');
});

app.get('/api/v1/auth/oauth/oidc/login', asyncHandler(async (req, res) => {
  await refreshOidcProvidersFromDatabase();
  const config = getOidcProviderConfig(req.query.provider);
  if (!config || !isOidcEnabled(config)) {
    return res.status(503).json({
      error: 'oidc_not_configured',
      error_description: 'OIDC login is not configured'
    });
  }

  const linkIntent = req.query.intent === 'link';
  const mergeIntent = req.query.intent === 'merge';
  const currentUser = await getAuthenticatedUser(req);
  if ((linkIntent || mergeIntent) && (!currentUser || !isSameOriginBrowserRequest(req))) {
    return res.status(403).json({ error: 'forbidden', error_description: 'Manage identities from your authenticated profile page' });
  }
  if ((linkIntent || mergeIntent) && (!Number.isFinite(new Date(req.authSession.created_at).getTime())
      || Date.now() - new Date(req.authSession.created_at).getTime() >= 5 * 60 * 1000)) {
    return res.status(403).json({ error: 'reauthentication_required', error_description: '处理第三方账号前，请重新登录' });
  }
  const endpoints = await resolveOidcEndpoints(config);
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const stateData = {
    state,
    nonce,
    returnTo: getOidcReturnPath(req.query.return_to),
    createdAt: Date.now(),
    linkUserId: linkIntent ? currentUser.id : '',
    linkSessionId: linkIntent ? req.authSession.id : '',
    mergeUserId: mergeIntent ? currentUser.id : '',
    mergeSessionId: mergeIntent ? req.authSession.id : '',
    provider: config.providerKey
  };
  const authorizeParams = {
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: getOidcCallbackUrl(req),
    scope: config.scopes.join(' '),
    state,
    nonce
  };

  if (config.pkceEnabled) {
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    stateData.codeVerifier = codeVerifier;
    authorizeParams.code_challenge = codeChallenge;
    authorizeParams.code_challenge_method = 'S256';
  }

  res.cookie(OIDC_STATE_COOKIE, encodeOidcState(stateData), {
    httpOnly: true,
    secure: RUNTIME.secureCookies,
    sameSite: 'lax',
    maxAge: OIDC_STATE_MAX_AGE
  });
  return res.redirect(`${endpoints.authorizeUrl}${endpoints.authorizeUrl.includes('?') ? '&' : '?'}${new URLSearchParams(authorizeParams).toString()}`);
}));

app.get('/api/v1/auth/oauth/oidc/config', asyncHandler(async (req, res) => {
  await refreshOidcProvidersFromDatabase();
  const providers = getConfiguredOidcProviders().map(config => ({
    key: config.providerKey,
    providerName: config.providerName,
    loginUrl: getOidcLoginUrl(req, config.providerKey)
  }));
  res.json({
    enabled: providers.length > 0,
    providerName: providers[0]?.providerName || OIDC_CONFIG.providerName,
    loginUrl: providers[0]?.loginUrl || getOidcLoginUrl(req),
    providers
  });
}));

app.get(OIDC_CALLBACK_PATH, asyncHandler(async (req, res) => {
  const cookieState = decodeOidcState(req.cookies[OIDC_STATE_COOKIE]);
  res.clearCookie(OIDC_STATE_COOKIE, { httpOnly: true, secure: RUNTIME.secureCookies, sameSite: 'lax', path: '/' });
  const queryState = normalizeText(req.query.state);
  const stateIsValid = cookieState && queryState && cookieState.state === queryState &&
    Number(cookieState.createdAt) <= Date.now() && Number(cookieState.createdAt) + OIDC_STATE_MAX_AGE >= Date.now();

  if (!stateIsValid) {
    return res.redirect(oidcErrorRedirect(cookieState, 'Invalid or expired OIDC state'));
  }
  if (req.query.error) {
    return res.redirect(oidcErrorRedirect(cookieState, req.query.error_description || req.query.error));
  }

  const code = normalizeText(req.query.code);
  if (!code) {
    return res.redirect(oidcErrorRedirect(cookieState, 'OIDC authorization code is missing'));
  }

  try {
    await refreshOidcProvidersFromDatabase();
    if (cookieState.linkUserId || cookieState.mergeUserId) {
      const linkingUser = await getAuthenticatedUser(req);
      if (!linkingUser || linkingUser.id !== (cookieState.linkUserId || cookieState.mergeUserId)
          || req.authSession.id !== (cookieState.linkSessionId || cookieState.mergeSessionId)
          || (cookieState.mergeUserId && (Date.now() - new Date(req.authSession.created_at).getTime() >= 5 * 60 * 1000))) {
        throw new Error('The session that requested identity management is no longer fresh and active');
      }
    }
    const config = getOidcProviderConfig(cookieState.provider);
    if (!config || !isOidcEnabled(config)) throw new Error('OIDC provider is no longer configured');
    const endpoints = await resolveOidcEndpoints(config);
    const tokenPayload = await exchangeOidcCode(code, cookieState.codeVerifier, endpoints, getOidcCallbackUrl(req), config);
    if (config.validateIdToken && !tokenPayload.id_token) {
      throw new Error('OIDC token response did not include an ID Token');
    }
    const idTokenClaims = config.validateIdToken && tokenPayload.id_token
      ? await verifyOidcIdToken(tokenPayload.id_token, endpoints, cookieState.nonce, config)
      : {};
    const userinfoClaims = await fetchOidcUserinfo(config, endpoints, tokenPayload.access_token);

    const userinfoId = claimIdentifier(userinfoClaims, config.userinfoIdPath);
    const idTokenId = claimIdentifier(idTokenClaims, 'sub');
    if (getClaimByPath(userinfoClaims, config.userinfoIdPath) !== undefined && !userinfoId) {
      throw new Error('OIDC UserInfo contains an invalid subject identifier');
    }
    // 仅当主标识取自标准 sub 时才与 ID Token 比对；自定义路径与 sub 不同源，比对无意义。
    if (config.userinfoIdPath === 'sub' && userinfoId && idTokenId && userinfoId !== idTokenId) {
      throw new Error('OIDC UserInfo subject does not match the ID Token subject');
    }
    const secondaryId = config.userinfoSecondaryIdPath
      ? claimIdentifier(userinfoClaims, config.userinfoSecondaryIdPath) || claimIdentifier(idTokenClaims, config.userinfoSecondaryIdPath)
      : '';
    const emailSource = claimText(userinfoClaims, config.userinfoEmailPath) ? userinfoClaims : idTokenClaims;
    const claims = {
      id: userinfoId || idTokenId,
      secondaryId,
      email: claimText(emailSource, config.userinfoEmailPath),
      emailVerified: claimBoolean(emailSource, config.emailVerifiedPath),
      username: claimText(userinfoClaims, config.userinfoUsernamePath) || claimText(idTokenClaims, config.userinfoUsernamePath) || claimText(idTokenClaims, 'preferred_username'),
      name: claimText(userinfoClaims, 'name') || claimText(idTokenClaims, 'name'),
      picture: claimText(userinfoClaims, 'picture') || claimText(idTokenClaims, 'picture'),
      profile: { ...idTokenClaims, ...userinfoClaims,
        _vaultsso: { issuer: endpoints.issuer || '', clientId: config.clientId } }
    };
    if (!claims.id) throw new Error('OIDC account did not provide a subject identifier');
    if (cookieState.mergeUserId) {
      const row = await ExternalIdentity.findByProviderSubject(config.providerKey, claims.id, claims.secondaryId);
      if (!row) throw new AccountMergeError('The external identity has no separate account; use binding instead', 'account_merge_not_found');
      if (row.user_id !== cookieState.mergeUserId) {
        const merged = await mergeOidcAccount({ pool, targetUserId: cookieState.mergeUserId, sourceUserId: row.user_id,
          provenIdentity: claims, providerConfig: { ...config, resolvedIssuer: endpoints.issuer }, keepSessionId: req.authSession.id });
        const target = await User.findById(merged.userId);
        try {
          await recordLoginLog({ username: target.username, userId: target.id, req, result: 'admin_action',
            detail: `merge_oidc_account | source:${row.user_id} | provider:${config.providerKey}` });
        } catch (auditError) {
          console.error('OIDC account merge audit failed:', auditError.message);
        }
      }
      return res.redirect(appendQuery('/profile', { account_merged: '1' }));
    }
    const user = await findOrCreateOidcUser(claims, cookieState.linkUserId, config);
    if (isUserBanned(user)) {
      return res.redirect(oidcErrorRedirect(cookieState, '账户已被封禁，请联系管理员'));
    }
    // 外部登录创建的用户可能没有真实邮箱，此时不能走邮件二次验证。
    const oidcFactor = user.totp_enabled
      ? 'totp'
      : (await isSettingEnabled('login_email_code')) && !isSyntheticEmail(user.email) ? 'email' : '';
    if (!cookieState.linkUserId && oidcFactor) {
      await beginOidcSecondFactor(res, user, cookieState.returnTo, oidcFactor, config.providerKey);
      return res.redirect('/oauth2/mfa');
    }
    const completed = await finishAccountLogin(user, async (current, connection) => {
      await new UserModel(connection).update(current.id, { lastLoginIp: getClientIp(req) });
      await recordLoginLog({ username: current.username, userId: current.id, req, result: 'success', detail: 'External identity authentication', database: connection });
      await setSessionCookie(req, res, current, connection);
      return { status: 200 };
    });
    if (completed.status !== 200) return res.redirect(oidcErrorRedirect(cookieState, completed.body.error_description));
    return res.redirect(getOidcReturnPath(cookieState.returnTo));
  } catch (error) {
    console.error('OIDC callback failed:', error.message);
    return res.redirect(oidcErrorRedirect(cookieState, error.message));
  }
}));

// ── 华为账号一键登录 ─────────────────────────────────────────────
// 原生 App 从华为 SDK 拿到 authorization code 后直接 POST 本接口，
// 不需要 WebView，也不依赖 Cookie：会话用 Cookie 下发，二次验证凭据同时用响应体返回。

function isSyntheticEmail(email) {
  return /@users\.invalid$/i.test(normalizeText(email));
}

function resolveHuaweiProvider(requestedKey) {
  const config = getHuaweiProviderConfig(requestedKey);
  if (config) return isHuaweiEnabled(config) ? config : null;
  const available = getConfiguredHuaweiProviders();
  return available.length === 1 ? available[0] : null;
}

// 只保存审计所需的标识与掩码手机号，不重复落明文号码。
function buildHuaweiProfile(identity, config) {
  return {
    provider: PROVIDER_TYPE_HUAWEI,
    openID: identity.openId,
    unionID: identity.unionId,
    clientId: config.clientId || '',
    providerName: config.providerName || config.providerKey,
    huaweiUnionScope: normalizeText(config.huaweiUnionScope),
    displayName: identity.displayName || '',
    reportedPhoneMasked: identity.phone ? phoneNumbers.maskPhone(identity.phone.countryCode, identity.phone.nationalNumber) : ''
  };
}

// 手机号只做绑定，不静默覆盖：本地已有号码且不一致时保留本地值并记录冲突。
async function applyHuaweiPhone(user, identity) {
  const phone = identity.phone;
  if (!phone) return { user, action: 'none' };
  const verified = Boolean(identity.phoneVerified);
  if (!verified) return { user, action: 'unverified' };

  if (!user.phone_e164) {
    const owner = await User.findByPhone(phone.e164);
    if (owner && owner.id !== user.id) return { user, action: 'conflict' };
    try {
      const bound = await User.bindPhoneIfEmpty(user.id, phone, verified);
      user = await User.findById(user.id) || user;
      if (bound) return { user, action: 'bound' };
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return { user: await User.findById(user.id) || user, action: 'conflict' };
      throw error;
    }
  }
  if (!phoneNumbers.isSamePhone(user.phone_e164, phone.e164)) {
    return { user, action: 'conflict' };
  }
  if (verified && !user.phone_verified) {
    const applied = await User.verifyPhoneIfUnchanged(user.id, phone.e164);
    user = await User.findById(user.id) || user;
    return { user, action: applied ? 'verified' : phoneNumbers.isSamePhone(user.phone_e164, phone.e164) ? 'unchanged' : 'conflict' };
  }
  return { user, action: 'unchanged' };
}

async function findOrCreateHuaweiUser(identity, config, linkUserId = '', allowCreate = true) {
  const provider = normalizeText(config.providerKey).toLowerCase();
  const scope = normalizeText(config.huaweiUnionScope);
  const subjects = [identity.unionId, identity.openId].filter(Boolean).map(id => `provider:${provider}:${id}`);
  if (scope && identity.unionId) subjects.push(`scope:${scope}:${identity.unionId}`);
  const lockKeys = [...new Set(subjects.map(subject => crypto.createHash('sha256').update(`huawei:${subject}`).digest('hex')))].sort();
  const phoneAutolink = await isSettingEnabled('huawei_phone_autolink');
  const registrationEnabled = await isSettingEnabled('registration_enabled');
  const connection = await pool.getConnection();
  const acquired = [];
  let transaction = false;
  try {
    for (const key of lockKeys) {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [key]);
      if (Number(rows[0]?.acquired) !== 1) throw new Error('华为账号关联忙，请稍后重试');
      acquired.push(key);
    }
    await connection.beginTransaction();
    transaction = true;
    const result = await resolveHuaweiUser(identity, config, linkUserId, connection, { phoneAutolink, registrationEnabled, allowCreate });
    await connection.commit();
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    try {
      for (const key of acquired.reverse()) await connection.query('SELECT RELEASE_LOCK(?) AS released', [key]);
      connection.release();
    } catch (error) {
      connection.destroy();
      throw error;
    }
  }
}

async function resolveHuaweiUser(identity, config, linkUserId, connection, settings) {
  const User = new UserModel(connection);
  const ExternalIdentity = new ExternalIdentityModel(connection);
  const provider = normalizeText(config.providerKey).toLowerCase();
  const primaryId = identity.unionId || identity.openId;
  const secondaryId = identity.unionId ? identity.openId : '';
  if (!primaryId) throw new Error('华为账号未返回 UnionID/OpenID');

  const existingIdentity = await ExternalIdentity.findByProviderSubject(provider, primaryId, secondaryId);
  const scope = normalizeText(config.huaweiUnionScope);
  // Only an explicit common subject permits inspecting another app's bindings.
  const sameScopeProviders = new Set([provider, ...Object.values(OIDC_PROVIDERS)
    .filter(item => scope && item.providerType === PROVIDER_TYPE_HUAWEI && normalizeText(item.huaweiUnionScope) === scope)
    .map(item => item.providerKey)]);
  const identityRows = await ExternalIdentity.findByProviders([...sameScopeProviders]);
  if (identityRows.some(row => row.provider === provider && ExternalIdentity.serialize(row).profile.clientId
    && ExternalIdentity.serialize(row).profile.clientId !== config.clientId)) {
    throw new Error('该提供方已绑定其他华为 App，请为每个 App 使用独立 Provider key');
  }
  let scopeUserId = '';
  if (scope && identity.unionId) {
    // Include disabled providers: disabling an app cannot erase an identity conflict.
    const matches = identityRows.filter(row => {
      if (!sameScopeProviders.has(row.provider)) return false;
      const profile = ExternalIdentity.serialize(row).profile;
      return profile.provider === PROVIDER_TYPE_HUAWEI && profile.unionID === identity.unionId
        && (!normalizeText(profile.huaweiUnionScope) || profile.huaweiUnionScope === scope);
    });
    const matchedUsers = new Set(matches.map(row => row.user_id));
    if (existingIdentity) matchedUsers.add(existingIdentity.user_id);
    if (linkUserId) matchedUsers.add(linkUserId);
    if (matchedUsers.size > 1) throw new Error('同一华为主体的 UnionID 已绑定到不同用户，请由管理员核查');
    scopeUserId = matches[0]?.user_id || '';
  }
  if (existingIdentity) {
    const previousUnionId = normalizeText(ExternalIdentity.serialize(existingIdentity).profile.unionID);
    if (previousUnionId && identity.unionId && previousUnionId !== identity.unionId) {
      throw new Error('该华为 OpenID 返回的 UnionID 与已有绑定不一致，请由管理员核查');
    }
    const linked = await User.findById(existingIdentity.user_id);
    if (!linked) throw new Error('该华为账号绑定的本地账号已不存在');
    if (linkUserId && existingIdentity.user_id !== linkUserId) throw new Error('该华为账号已绑定到其他用户');
    await ExternalIdentity.update(existingIdentity.id, {
      providerSecondaryId: secondaryId && !existingIdentity.provider_secondary_id ? secondaryId : undefined,
      displayName: identity.displayName || undefined,
      avatar: identity.avatar || undefined,
      profile: {
        ...buildHuaweiProfile(identity, config),
        openID: existingIdentity.provider_secondary_id || identity.openId,
        unionID: identity.unionId || ExternalIdentity.serialize(existingIdentity).profile.unionID || ''
      }
    });
    return { user: linked, created: false, matched: 'identity' };
  }

  if (linkUserId || scopeUserId) {
    const linked = await User.findById(linkUserId || scopeUserId);
    if (!linked) throw new Error('用于绑定的本地账号已不存在');
    await ExternalIdentity.create({
      userId: linked.id, provider, providerUserId: primaryId, providerSecondaryId: secondaryId,
      providerUsername: linked.username, displayName: identity.displayName,
      avatar: identity.avatar, email: linked.email, profile: buildHuaweiProfile(identity, config)
    });
    return { user: linked, created: false, matched: linkUserId ? 'link' : 'union_scope' };
  }

  // 华为明确验证的完整号码可关联同样已验证的本地号码。
  if (settings.phoneAutolink && identity.phone && identity.phoneVerified) {
    const byPhone = await User.findByPhone(identity.phone.e164);
    if (byPhone) {
      if (isUserBanned(byPhone)) throw new Error('账户已被封禁，请联系管理员');
      if (byPhone.phone_verified) {
        await ExternalIdentity.create({
          userId: byPhone.id, provider, providerUserId: primaryId, providerSecondaryId: secondaryId,
          providerUsername: byPhone.username, displayName: identity.displayName,
          avatar: identity.avatar, email: byPhone.email, profile: buildHuaweiProfile(identity, config)
        });
        return { user: byPhone, created: false, matched: 'phone' };
      }
    }
  }

  if (!settings.allowCreate) return { pending: true };
  if (!settings.registrationEnabled) throw new Error('Registration is disabled');

  const digest = crypto.createHash('sha256').update(primaryId).digest('hex');
  const email = `${provider}-${digest.slice(0, 24)}@users.invalid`;
  const usernameBase = normalizeText(identity.displayName).replace(/\s+/g, '').slice(0, 180) || `${provider}-${digest.slice(0, 12)}`;
  let username = usernameBase;
  let suffix = 0;
  while ((await User.findByUsername(username)) && suffix < 20) {
    suffix += 1;
    username = `${usernameBase}-${suffix}`;
  }
  const user = await User.create({
    username, email, password: '',
    name: identity.displayName || username,
    avatar: identity.avatar || '',
    emailVerified: false
  });
  await ExternalIdentity.create({
    userId: user.id, provider, providerUserId: primaryId, providerSecondaryId: secondaryId,
    providerUsername: username, displayName: identity.displayName,
    avatar: identity.avatar, email: '', profile: buildHuaweiProfile(identity, config)
  });
  return { user, created: true, matched: 'new' };
}

function pendingHuaweiBinding(token) {
  const entry = pendingHuaweiBindings.get(normalizeText(token));
  if (!entry || Date.now() - entry.createdAt >= HUAWEI_BIND_TTL_MS) {
    pendingHuaweiBindings.delete(normalizeText(token));
    return null;
  }
  return entry;
}

async function completeHuaweiQuickLogin(req, res, identity, config, result, linkIntent = false, currentUser = null) {
  let user = result.user;
  const phoneOutcome = await applyHuaweiPhone(user, identity);
  user = phoneOutcome.user;
  const phone = identity.phoneVerified ? identity.phone?.e164 || null : null;
  const phoneStatus = !identity.phone ? 'not_returned'
    : !identity.phoneVerified ? 'unverified'
      : phoneOutcome.action === 'conflict' ? 'conflict' : 'verified';
  if (isUserBanned(user)) {
    return res.status(403).json({ error: 'access_denied', error_description: '账户已被封禁，请联系管理员' });
  }

  const detail = `Huawei quick login (${result.created ? 'created' : `matched:${result.matched}`}, phone:${phoneOutcome.action})`;
  await recordLoginLog({ username: user.username, userId: user.id, req, result: 'success', detail });

  if (linkIntent) {
    await recordAdminLog({ admin: currentUser, req, action: 'link_identity', detail: `provider:${config.providerKey}` });
    return res.json({ linked: true, user: serializeUser(user), phone, phoneStatus, phoneBinding: phoneOutcome.action });
  }

  const factor = user.totp_enabled
    ? 'totp'
    : (await isSettingEnabled('login_email_code')) && !isSyntheticEmail(user.email) ? 'email' : '';
  if (factor) {
    const authorization = await validateAuthorizationRequest(req.body);
    if (authorization.body) return res.status(authorization.status).json(authorization.body);
    const oauth = authorization.value ? {
      client_id: authorization.value.client.id,
      redirect_uri: authorization.value.redirectUri,
      scope: authorization.value.scopes.join(' '),
      state: authorization.value.state,
      nonce: authorization.value.nonce,
      response_type: 'code',
      ...(authorization.value.codeChallenge ? {
        code_challenge: authorization.value.codeChallenge,
        code_challenge_method: authorization.value.codeChallengeMethod
      } : {})
    } : null;
    const pendingToken = await beginOidcSecondFactor(res, user, req.body.return_to, factor, config.providerKey, 'huawei', {
      huawei: {
        oauth,
        phone: huaweiPendingPhoneCipher.encrypt(phone),
        phoneStatus,
        phoneBinding: phoneOutcome.action
      }
    });
    return res.json({
      mfa_required: true,
      factor,
      email: maskEmail(user.email),
      pending_token: pendingToken,
      pending_header: 'X-Oidc-Pending'
    });
  }

  const completed = await finishAccountLogin(user, async (current, connection) => {
    await new UserModel(connection).update(current.id, { lastLoginIp: getClientIp(req) });
    const wantsAuthorizationCode = Boolean(normalizeText(req.body.client_id) || normalizeText(req.body.redirect_uri));
    if (wantsAuthorizationCode) {
      const authorized = await buildAuthorizationResponse(current, {
        client_id: req.body.client_id,
        redirect_uri: req.body.redirect_uri,
        scope: req.body.scope,
        state: req.body.state,
        nonce: req.body.nonce,
        code_challenge: req.body.code_challenge,
        code_challenge_method: req.body.code_challenge_method
      }, connection);
      if (authorized.status !== 200) return authorized;
      const redirect = new URL(authorized.body.redirect);
      const phoneGranted = normalizeText(req.body.scope).split(/\s+/).includes('phone');
      const responseUser = serializeUser(current);
      if (!phoneGranted) {
        Object.assign(responseUser, { phoneCountryCode: '', phoneNationalNumber: '', phoneE164: '',
          phoneMasked: '', phoneVerified: false, phoneVerifiedAt: null });
      }
      return { status: 200, body: {
        authorization_code: redirect.searchParams.get('code'),
        state: redirect.searchParams.get('state') || '',
        redirect_uri: normalizeText(req.body.redirect_uri),
        redirect: authorized.body.redirect,
        user: responseUser,
        phone: phoneGranted ? phone : null,
        phoneStatus: phoneGranted ? phoneStatus : 'scope_not_granted',
        phoneBinding: phoneOutcome.action
      } };
    }
    await setSessionCookie(req, res, current, connection);
    return { status: 200, body: { user: serializeUser(current), phone, phoneStatus, phoneBinding: phoneOutcome.action } };
  });
  return res.status(completed.status).json(completed.body);
}

app.get('/api/v1/auth/oauth/huawei/config', asyncHandler(async (req, res) => {
  await refreshOidcProvidersFromDatabase();
  const providers = getConfiguredHuaweiProviders().map(config => ({
    key: config.providerKey,
    providerName: config.providerName
  }));
  res.json({
    enabled: providers.length > 0,
    providers,
    quickLoginUrl: `${getBaseUrl().replace(/\/+$/, '')}${HUAWEI_QUICK_LOGIN_PATH}`,
    mfaCompleteUrl: `${getBaseUrl().replace(/\/+$/, '')}/api/v1/auth/oauth/oidc/complete`,
    phoneAutolink: await isSettingEnabled('huawei_phone_autolink')
  });
}));

app.post(HUAWEI_QUICK_LOGIN_PATH, asyncHandler(async (req, res) => {
  if (!isMachineClientRequest(req)) {
    return res.status(403).json({ error: 'forbidden', error_description: '该接口不接受跨站浏览器请求' });
  }
  await refreshOidcProvidersFromDatabase();
  const config = resolveHuaweiProvider(req.body.provider);
  if (!config) {
    return res.status(503).json({ error: 'huawei_not_configured', error_description: '华为账号登录未配置或未启用' });
  }

  const limit = await RateLimit.consume(`huawei-quick-login:${getClientIp(req)}`, 30, 10 * 60 * 1000);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'too_many_requests', error_description: '尝试次数过多，请稍后再试' });
  }

  const linkIntent = req.body.intent === 'link';
  const mergeIntent = req.body.intent === 'merge';
  const currentUser = await getAuthenticatedUser(req);
  if ((linkIntent || mergeIntent) && !currentUser) {
    return res.status(403).json({ error: 'forbidden', error_description: '请先登录后再绑定华为账号' });
  }
  if (mergeIntent && (!req.authSession || Date.now() - new Date(req.authSession.created_at).getTime() >= 5 * 60 * 1000)) {
    return res.status(403).json({ error: 'reauthentication_required', error_description: '合并账号前请重新登录已有账号' });
  }

  const authorizationCode = normalizeText(req.body.authorizationCode);
  const legacyCode = normalizeText(req.body.code);
  if (authorizationCode && legacyCode && authorizationCode !== legacyCode) {
    return res.status(400).json({ error: 'invalid_request', error_description: '授权码字段不一致' });
  }

  let identity;
  try {
    identity = await huawei.exchangeQuickLoginCode(config, authorizationCode || legacyCode, huaweiQuickLoginEndpoint(config));
  } catch (error) {
    // 不回显华为原始报文，避免把凭据写进日志或响应。
    console.error('Huawei quick login failed:', error.message);
    const failure = error instanceof huawei.HuaweiError ? error : new huawei.HuaweiError('Huawei exchange failed');
    return res.status(failure.status).json({ error: failure.publicCode, error_description: failure.publicDescription });
  }
  if (!identity.openId && !identity.unionId) {
    return res.status(400).json({ error: 'invalid_grant', error_description: '华为账号未返回用户标识' });
  }

  if (mergeIntent) {
    try {
      const provider = normalizeText(config.providerKey).toLowerCase();
      const row = await ExternalIdentity.findByProviderSubject(provider, identity.unionId || identity.openId,
        identity.unionId ? identity.openId : '');
      if (!row) return res.status(409).json({ error: 'account_merge_not_found', error_description: '该华为账号尚未绑定独立账号，请使用普通绑定流程' });
      if (row.user_id === currentUser.id) {
        return res.json({ merged: false, linked: true, user: serializeUser(currentUser) });
      }
      const merged = await mergeHuaweiAccount({ pool, targetUserId: currentUser.id, sourceUserId: row.user_id,
        provenIdentity: identity, providerConfig: config, keepSessionId: req.authSession.id });
      await recordLoginLog({ username: merged.user.username, userId: merged.userId, req, result: 'admin_action',
        detail: `merge_huawei_account | source:${row.user_id} | identities:${merged.movedIdentityIds.length}` });
      return res.json({ merged: true, user: serializeUser(merged.user),
        phone: identity.phoneVerified ? identity.phone?.e164 || null : null,
        phoneStatus: merged.phoneBinding === 'conflict' ? 'conflict'
          : identity.phoneVerified ? 'verified' : identity.phone ? 'unverified' : 'not_returned',
        phoneBinding: merged.phoneBinding, phoneTransferred: merged.phoneTransferred });
    } catch (error) {
      if (error instanceof AccountMergeError) {
        return res.status(error.status).json({ error: error.code, error_description: error.message });
      }
      if (error.message === 'External account identifiers are bound to different users') {
        return res.status(409).json({ error: 'account_merge_conflict', error_description: '该华为身份的标识分别属于不同账号，需人工核查' });
      }
      throw error;
    }
  }

  let result;
  try {
    result = await findOrCreateHuaweiUser(identity, config, linkIntent ? currentUser.id : '', false);
  } catch (error) {
    return res.status(400).json({ error: 'invalid_request', error_description: error.message });
  }

  if (result.pending) {
    if (pendingHuaweiBindings.size >= 1000) return res.status(429).json({ error: 'too_many_requests', error_description: '待绑定请求过多，请稍后重试' });
    const bindingToken = crypto.randomBytes(32).toString('base64url');
    const { raw, ...verifiedIdentity } = identity;
    const { providerKey, providerName, huaweiUnionScope, clientId } = config;
    pendingHuaweiBindings.set(bindingToken, {
      identity: verifiedIdentity, config: { providerKey, providerName, huaweiUnionScope, clientId },
      clientId: normalizeText(req.body.client_id), createdAt: Date.now(), inProgress: false
    });
    return res.json({ binding_required: true, binding_token: bindingToken,
      phone_available: Boolean(identity.phone && identity.phoneVerified),
      phone_status: !identity.phone ? 'not_returned' : identity.phoneVerified ? 'verified' : 'unverified' });
  }

  return completeHuaweiQuickLogin(req, res, identity, config, result, linkIntent, currentUser);
}));

app.post(HUAWEI_SKIP_PATH, asyncHandler(async (req, res) => {
  const token = normalizeText(req.body.binding_token);
  const entry = pendingHuaweiBinding(token);
  if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: '华为绑定请求已过期，请重新登录' });
  if (entry.inProgress) return res.status(409).json({ error: 'conflict', error_description: '请求正在处理' });
  if (normalizeText(req.body.client_id) !== entry.clientId) return res.status(403).json({ error: 'forbidden', error_description: '登录客户端不一致' });
  entry.inProgress = true;
  try {
    let result;
    try {
      result = await findOrCreateHuaweiUser(entry.identity, entry.config);
    } catch (error) {
      return res.status(400).json({ error: 'invalid_request', error_description: error.message });
    }
    pendingHuaweiBindings.delete(token);
    return await completeHuaweiQuickLogin(req, res, entry.identity, entry.config, result);
  } finally {
    entry.inProgress = false;
  }
}));

app.post(HUAWEI_BIND_PATH, asyncHandler(async (req, res) => {
  const token = normalizeText(req.body.binding_token);
  const entry = pendingHuaweiBinding(token);
  if (!entry) return res.status(400).json({ error: 'invalid_grant', error_description: '华为绑定请求已过期，请重新登录' });
  if (entry.inProgress) return res.status(409).json({ error: 'conflict', error_description: '请求正在处理' });
  const rawToken = /^Bearer (.+)$/.exec(req.get('authorization') || '')?.[1];
  const decoded = rawToken && validateToken(rawToken, 'access');
  const tokenData = decoded && await Token.findAccessTokenById(decoded.jti);
  const client = tokenData && await Client.findById(tokenData.client_id);
  if (!tokenData || !Token.matchesToken(tokenData, rawToken) || !isClientActive(client)
      || tokenData.client_id !== entry.clientId || tokenData.user_id !== decoded.sub
      || new Date(tokenData.expires_at) <= new Date() || !tokenData.scopes.includes('openid')) {
    return res.status(401).json({ error: 'invalid_token', error_description: '请重新验证已有账号' });
  }
  entry.inProgress = true;
  try {
    let result;
    try {
      result = await findOrCreateHuaweiUser(entry.identity, entry.config, tokenData.user_id, false);
    } catch (error) {
      return res.status(409).json({ error: 'conflict', error_description: error.message });
    }
    if (result.user.id !== tokenData.user_id) return res.status(409).json({ error: 'conflict', error_description: '华为账号已绑定其他用户' });
    pendingHuaweiBindings.delete(token);
    return res.json({ linked: true });
  } finally {
    entry.inProgress = false;
  }
}));

app.get('/oauth2/mfa', asyncHandler(async (req, res) => {
  if (!await getPendingOidcLogin(req)) return res.redirect('/oauth2/authorize');
  res.sendFile(pageFile('mfa'));
}));

app.get('/api/v1/auth/oauth/oidc/pending', asyncHandler(async (req, res) => {
  const login = await getPendingOidcLogin(req);
  if (!login) return res.status(401).json({ error: 'invalid_grant', error_key: 'auth.mfa.expired', error_description: '登录验证已过期，请重新登录' });
  res.json({ factor: login.pending.factor, email: maskEmail(login.user.email), login_url: login.pending.source === 'password' && login.pending.returnTo.startsWith('/oauth2/authorize?') ? login.pending.returnTo : '/oauth2/authorize' });
}));

app.post('/api/v1/auth/oauth/oidc/complete', asyncHandler(async (req, res) => {
  const login = await getPendingOidcLogin(req);
  if (!login) return res.status(401).json({ error: 'invalid_grant', error_key: 'auth.mfa.expired', error_description: '登录验证已过期，请重新登录' });
  const { pending, record, user, context } = login;
  if (!await EmailVerificationCode.incrementAttempts(record.id, 5)) {
    return res.status(429).json({ error: 'too_many_attempts', error_key: 'auth.mfa.locked', error_description: '尝试次数过多，请重新登录' });
  }
  const code = normalizeText(req.body.code);
  let valid = false;
  if (pending.factor === 'totp' && user.totp_enabled) {
    valid = await verifyTotpOnce(user, code) || await consumeRecoveryCode(user, code);
  } else if (pending.factor === 'email' && !user.totp_enabled) {
    valid = (await verifyEmailCode({ email: user.email, purpose: EMAIL_PURPOSE_LOGIN, code, userId: user.id })).ok;
  }
  if (!valid || !await getPendingOidcLogin(req)) {
    return res.status(400).json({ error: 'invalid_grant', error_key: 'auth.mfa.invalid', error_description: '验证码不正确、已使用或已过期' });
  }
  const result = await finishAccountLogin(user, async (current, connection) => {
    if (!await new EmailVerificationCodeModel(connection).consume(record.id)) {
      return authenticatorError(400, 'auth.mfa.invalid', '验证码不正确、已使用或已过期');
    }
    if (pending.source === 'password') {
      await completePasswordLogin(req, res, current, connection);
    } else if (pending.source === 'huawei' && context.huawei.oauth) {
      const oauth = context.huawei.oauth;
      const authorized = await buildAuthorizationResponse(current, oauth, connection);
      if (authorized.status !== 200) return authorized;
      const redirect = new URL(authorized.body.redirect);
      const phoneGranted = oauth.scope.split(/\s+/).includes('phone');
      const responseUser = serializeUser(current);
      if (!phoneGranted) {
        Object.assign(responseUser, { phoneCountryCode: '', phoneNationalNumber: '', phoneE164: '',
          phoneMasked: '', phoneVerified: false, phoneVerifiedAt: null });
      }
      await new UserModel(connection).update(current.id, { lastLoginIp: getClientIp(req) });
      await recordLoginLog({ username: current.username, userId: current.id, req, result: 'success',
        detail: 'Huawei identity with second factor', database: connection });
      return { status: 200, body: {
        authorization_code: redirect.searchParams.get('code'),
        state: redirect.searchParams.get('state') || '',
        redirect_uri: oauth.redirect_uri,
        redirect: authorized.body.redirect,
        user: responseUser,
        phone: phoneGranted ? huaweiPendingPhoneCipher.decrypt(context.huawei.phone) || null : null,
        phoneStatus: phoneGranted ? context.huawei.phoneStatus : 'scope_not_granted',
        phoneBinding: context.huawei.phoneBinding
      } };
    } else {
      await new UserModel(connection).update(current.id, { lastLoginIp: getClientIp(req) });
      await recordLoginLog({ username: current.username, userId: current.id, req, result: 'success', detail: 'External identity with second factor', database: connection });
      await setSessionCookie(req, res, current, connection);
      if (pending.source === 'huawei') {
        return { status: 200, body: {
          redirect: getOidcReturnPath(pending.returnTo),
          user: serializeUser(current),
          phone: huaweiPendingPhoneCipher.decrypt(context.huawei.phone) || null,
          phoneStatus: context.huawei.phoneStatus,
          phoneBinding: context.huawei.phoneBinding
        } };
      }
    }
    return { status: 200, body: { redirect: getOidcReturnPath(pending.returnTo) } };
  });
  if (result.status === 200) res.clearCookie(OIDC_PENDING_COOKIE, { httpOnly: true, secure: RUNTIME.secureCookies, sameSite: 'lax', path: '/' });
  res.status(result.status).json(result.body);
}));

app.post('/oauth2/authorize', asyncHandler(async (req, res) => {
  const username = normalizeText(req.body.username);
  const password = String(req.body.password || '');
  if (!username || username.length > 255 || !password || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Invalid username or password length' });
  }
  const user = await User.findByUsername(username);
  const attemptKey = `login:${user?.id || username.toLowerCase()}`;
  const maxAttempts = await getSettingNumber('login_max_attempts', 5);
  const lockoutMinutes = await getSettingNumber('login_lockout_minutes', 15);
  const existingAttempt = await RateLimit.check(attemptKey, maxAttempts);
  if (!existingAttempt.allowed) return rejectLockedLogin(req, res, username, existingAttempt);

  const submittedEmailCode = normalizeText(req.body.email_code);
  const submittedTotpCode = normalizeText(req.body.totp_code);
  const loginCaptchaGrace = hasCaptchaContinuation(req, user?.id);

  if (user && isUserBanned(user)) {
    await recordLoginLog({ username, userId: user.id, req, result: 'banned' });
    return res.status(403).json({
      error: 'account_banned',
      error_key: 'auth.account_banned',
      error_description: '账户已被封禁，请联系管理员'
    });
  }

  if (user && !user.password) {
    await recordLoginLog({ username, userId: user.id, req, result: 'password_not_set' });
    return res.status(403).json({
      error: 'password_not_set',
      error_key: 'auth.password.not_set',
      error_description: '该账户尚未设置密码，请先验证邮箱并设置密码'
    });
  }

  // Native forms collect MFA before CAPTCHA. This probe cannot create a session.
  if (req.body.check_verification === true) {
    const validation = await validateAuthorizationRequest(req.body);
    if (validation.body) return res.status(validation.status).json(validation.body);
    const attempt = await RateLimit.consume(attemptKey, maxAttempts, lockoutMinutes * 60 * 1000);
    if (!attempt.allowed) return rejectLockedLogin(req, res, username, attempt);
    if (!user || !user.password || !await bcrypt.compare(password, user.password)) {
      await recordLoginLog({ username, userId: user?.id || null, req, result: 'invalid_credentials' });
      if (user) await detectAndFlagAnomalousLogin(user, req, 'failure');
      return res.status(401).json({ error: 'invalid_grant', error_key: 'auth.invalid_credentials', error_description: '用户名或密码错误' });
    }
    const factor = user.totp_enabled ? 'totp' : await isSettingEnabled('login_email_code') ? 'email' : '';
    if (factor === 'email') {
      try {
        await issueEmailVerificationCode({ email: user.email, purpose: EMAIL_PURPOSE_LOGIN, userId: user.id });
      } catch (error) {
        return res.status(error.status || 502).json({
          error: error.code === 'email_code.cooldown' ? 'too_many_requests' : 'email_delivery_failed',
          error_key: error.code || 'smtp.test_failed',
          error_description: error.message
        });
      }
    }
    return res.json({
      verification_required: true, factor,
      email_masked: factor === 'email' ? maskEmail(user.email) : undefined,
      captcha_required: Boolean(user.captcha_required) || await isSettingEnabled('captcha_login'),
      captcha_provider: 'image'
    });
  }

  // The captcha grace window only covers the second-step resubmission (email or
  // authenticator code), which carries the code from the request that already
  // passed the captcha. A fresh login must always pass the captcha — either
  // because the global toggle is on, or because behavior analysis flagged the user.
  const userCaptchaRequired = Boolean(user && user.captcha_required);
  const captchaSkipped = loginCaptchaGrace && Boolean(submittedEmailCode || submittedTotpCode);
  const captchaNeeded = ((await isSettingEnabled('captcha_login')) || userCaptchaRequired) && !captchaSkipped;
  if (captchaNeeded) {
    const captcha = await verifyCaptcha(req.body, req, 'login');
    if (!captcha.ok) {
      await recordLoginLog({ username, userId: user?.id || null, req, result: 'captcha_failed' });
      const fieldsMissing = !(req.body.captcha_surface === 'web' && turnstileSettings.siteKey)
        && !normalizeText(req.body.captcha_id) && !normalizeText(req.body.captcha_code);
      return res.status(captcha.status || 400).json({
        error: 'invalid_request',
        error_key: fieldsMissing ? 'captcha.required' : captcha.error_key,
        error_description: fieldsMissing ? '检测到异常行为，本次登录需要输入图形验证码' : captcha.error_description
      });
    }
  }

  // Revealing or refreshing a CAPTCHA is not a password attempt.
  const attempt = await RateLimit.consume(attemptKey, maxAttempts, lockoutMinutes * 60 * 1000);
  if (!attempt.allowed) return rejectLockedLogin(req, res, username, attempt);

  if (!user || !user.password || !await bcrypt.compare(password, user.password)) {
    const remaining = attempt.remaining;
    await recordLoginLog({ username, userId: user?.id || null, req, result: 'invalid_credentials' });
    if (user) {
      await detectAndFlagAnomalousLogin(user, req, 'failure');
    }
    return res.status(401).json({
      error: 'invalid_grant',
      error_key: 'auth.invalid_credentials',
      error_description: '用户名或密码错误'
        + (remaining > 0 && remaining <= 2 ? `，还可尝试 ${remaining} 次` : '')
    });
  }

  // Authenticator (TOTP) verification takes precedence over the email code.
  const totpActive = Boolean(user.totp_enabled);
  if (totpActive) {
    if (!submittedTotpCode) {
      return beginPasswordSecondFactor(req, res, user, 'totp');
    }
    const totpOk = /^\d{6}$/.test(submittedTotpCode) && await verifyTotpOnce(user, submittedTotpCode);
    let recoveryOk = false;
    if (!totpOk) {
      recoveryOk = await consumeRecoveryCode(user, submittedTotpCode);
    }
    if (!totpOk && !recoveryOk) {
      await recordLoginLog({ username, userId: user.id, req, result: 'totp_invalid' });
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'auth.totp.invalid',
        error_description: '动态验证码不正确或已过期'
      });
    }
  }

  if (!totpActive && (await isSettingEnabled('login_email_code'))) {
    const emailCode = submittedEmailCode;
    if (!emailCode) {
      try {
        return await beginPasswordSecondFactor(req, res, user, 'email');
      } catch (error) {
        console.error('Failed to send login code:', error.message);
        if (error.code === 'email_code.cooldown') {
          return res.status(429).json({ error: 'too_many_attempts', error_key: error.code, error_description: error.message });
        }
        return res.status(502).json({
          error: 'email_delivery_failed',
          error_key: 'smtp.test_failed',
          error_description: '验证码邮件发送失败，请稍后再试或联系管理员检查发件设置'
        });
      }
    }

    const verification = await verifyEmailCode({ email: user.email, purpose: EMAIL_PURPOSE_LOGIN, code: emailCode, userId: user.id });
    if (!verification.ok) {
      await recordLoginLog({ username, userId: user.id, req, result: 'email_code_invalid' });
      return res.status(verification.status).json({
        error: 'invalid_request',
        error_key: verification.error_key,
        error_description: verification.error_description
      });
    }
  }

  const result = await finishAccountLogin(user, async (current, connection) => {
    await completePasswordLogin(req, res, current, connection);
    return buildAuthorizationResponse(current, req.body, connection);
  });
  return res.status(result.status).json(result.body);
}));

app.post('/api/email-verification/send', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const purpose = normalizeEmailPurpose(req.body.purpose);

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.email.invalid',
      error_description: '请输入有效的邮箱地址'
    });
  }

  if (![EMAIL_PURPOSE_REGISTER, EMAIL_PURPOSE_PASSWORD_RESET].includes(purpose)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'email_code.purpose.invalid',
      error_description: '验证码用途无效'
    });
  }

  if (purpose === EMAIL_PURPOSE_REGISTER && !await isSettingEnabled('registration_enabled')) {
    return res.status(403).json({ error: 'forbidden', error_description: 'Registration is disabled' });
  }

  const existingUser = await User.findByEmail(email);
  if (purpose === EMAIL_PURPOSE_REGISTER && existingUser) {
    return res.status(409).json({
      error: 'conflict',
      error_key: 'validation.email.taken',
      error_description: '该邮箱已被注册'
    });
  }

  if (purpose === EMAIL_PURPOSE_PASSWORD_RESET && !existingUser) {
    return res.json({
      message_key: 'email_code.sent',
      message: '如果邮箱存在，验证码将发送到该邮箱'
    });
  }

  const latestCode = await EmailVerificationCode.findLatestActive(email, purpose);
  if (latestCode && Date.now() - new Date(latestCode.created_at).getTime() < 60 * 1000) {
    return res.status(429).json({
      error: 'too_many_requests',
      error_key: 'email_code.cooldown',
      error_description: '发送过于频繁，请 1 分钟后再试'
    });
  }

  const delivery = await issueEmailVerificationCode({
    email,
    purpose,
    userId: existingUser?.id || null
  });

  res.json({
    message_key: 'email_code.sent',
    message: '验证码已发送',
    deliveryMode: delivery.mode
  });
}));

app.post('/oauth2/register', asyncHandler(async (req, res) => {
  if (!(await isSettingEnabled('registration_enabled'))) {
    return res.status(403).json({
      error: 'forbidden',
      error_key: 'auth.registration.disabled',
      error_description: '系统已关闭注册，请联系管理员'
    });
  }

  if (await isSettingEnabled('captcha_register')) {
    const captcha = await verifyCaptcha(req.body, req, 'register');
    if (!captcha.ok) {
      return res.status(captcha.status || 400).json({
        error: 'invalid_request',
        error_key: captcha.error_key,
        error_description: captcha.error_description
      });
    }
  }

  const name = normalizeText(req.body.name);
  const email = normalizeEmail(req.body.email);
  const username = normalizeText(req.body.username) || email;
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');
  const emailCode = normalizeText(req.body.email_code || req.body.verification_code);
  const passwordPolicyError = await validatePasswordPolicy(password);

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.email.invalid',
      error_description: '请输入有效的邮箱地址'
    });
  }

  if (!username) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.username.required',
      error_description: '请输入用户名'
    });
  }

  if (passwordPolicyError) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.password.weak',
      error_description: passwordPolicyError
    });
  }

  if (confirmPassword && confirmPassword !== password) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.password.confirm_mismatch',
      error_description: '两次输入的密码不一致'
    });
  }

  const { usernameConflict, emailConflict } = await findUserConflicts({ username, email });
  if (emailConflict) {
    return res.status(409).json({
      error: 'conflict',
      error_key: 'validation.email.taken',
      error_description: '该邮箱已被注册'
    });
  }

  if (usernameConflict) {
    return res.status(409).json({
      error: 'conflict',
      error_key: 'validation.username.taken',
      error_description: '该用户名已被占用'
    });
  }

  const verification = await verifyEmailCode({
    email,
    purpose: EMAIL_PURPOSE_REGISTER,
    code: emailCode
  });

  if (!verification.ok) {
    return res.status(verification.status).json({
      error: 'invalid_request',
      error_key: verification.error_key,
      error_description: verification.error_description
    });
  }

  const user = await User.create({
    username,
    email,
    password,
    name: name || username,
    avatar: '',
    emailVerified: true,
    lastLoginIp: getClientIp(req)
  });

  await recordLoginLog({ username, userId: user.id, req, result: 'register', detail: email });
  await setSessionCookie(req, res, user);

  const result = await buildAuthorizationResponse(user, req.body);
  return res.status(result.status).json(result.body);
}));

app.post('/api/password-reset', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const emailCode = normalizeText(req.body.email_code || req.body.verification_code);
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.email.invalid',
      error_description: '请输入有效的邮箱地址'
    });
  }

  const resetPolicyError = await validatePasswordPolicy(password);
  if (resetPolicyError) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.password.weak',
      error_description: resetPolicyError
    });
  }

  if (confirmPassword && confirmPassword !== password) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.password.confirm_mismatch',
      error_description: '两次输入的密码不一致'
    });
  }

  const user = await User.findByEmail(email);
  if (!user) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'email_code.expired',
      error_description: '验证码不存在或已过期'
    });
  }

  const verification = await verifyEmailCode({
    email,
    purpose: EMAIL_PURPOSE_PASSWORD_RESET,
    code: emailCode,
    userId: user.id
  });

  if (!verification.ok) {
    return res.status(verification.status).json({
      error: 'invalid_request',
      error_key: verification.error_key,
      error_description: verification.error_description
    });
  }

  await User.updatePassword(user.id, password);
  await Session.revokeAllForUser(user.id);
  await Token.revokeByUser(user.id);
  await User.update(user.id, { emailVerified: true });

  res.json({
    message_key: 'auth.password_reset.updated',
    message: '密码已重置，请使用新密码登录'
  });
}));

app.get(['/api/me', '/api/profile'], asyncHandler(async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    return res.status(401).json({
      error: 'unauthorized',
      error_key: 'auth.required',
      error_description: '请先登录'
    });
  }

  const identities = ExternalIdentity ? await ExternalIdentity.findByUserId(user.id) : [];
  res.json({
    user: { ...serializeUser(user), identities: ExternalIdentity ? ExternalIdentity.serializeMany(identities) : [] }
  });
}));

async function preparePhoneUpdate(req, res, user, requireReauthentication = false) {
  const body = req.body;
  if (body.phone === undefined && body.phoneNumber === undefined && body.phoneCountryCode === undefined) {
    return { updates: {}, changed: false };
  }
  const hasNumber = body.phone !== undefined || body.phoneNumber !== undefined;
  const input = String(hasNumber ? (body.phone !== undefined ? body.phone : body.phoneNumber) ?? '' : user.phone_number ?? '').trim();
  const countryCode = phoneNumbers.normalizeCountryCode(body.phoneCountryCode ?? user.phone_country_code ?? phoneNumbers.DEFAULT_COUNTRY_CODE);
  const fullNumber = body.phone !== undefined || /^\+|^00/.test(input);
  const phone = input && countryCode && /^\+?[0-9\s().\-]+$/.test(input)
    ? fullNumber ? phoneNumbers.normalizePhone(input, countryCode) : phoneNumbers.normalizeParts(countryCode, input)
    : null;
  if (input && !phone) {
    res.status(400).json({ error: 'invalid_request', error_key: 'validation.phone.invalid', error_description: '请输入有效的国家/地区代码和手机号' });
    return null;
  }
  const currentE164 = user.phone_e164 || phoneNumbers.toE164(user.phone_country_code, user.phone_number);
  const changed = (phone?.e164 || '') !== (currentE164 || '');
  if (changed && requireReauthentication) {
    const recent = req.authSession && Date.now() - new Date(req.authSession.created_at).getTime() < 5 * 60 * 1000;
    const password = String(body.currentPassword || '');
    const passwordVerified = !recent && user.password && password && Buffer.byteLength(password) <= 72
      && await bcrypt.compare(password, user.password);
    if (!recent && !passwordVerified) {
      res.status(403).json({ error: 'reauthentication_required', error_key: 'profile.phone.reauthentication_required', error_description: '修改手机号前请填写当前密码，或重新登录后重试' });
      return null;
    }
  }
  if (phone) {
    const conflict = await User.findByPhone(phone.e164);
    if (conflict && conflict.id !== user.id) {
      res.status(409).json({ error: 'conflict', error_key: 'validation.phone.taken', error_description: '该手机号已被其他账户绑定' });
      return null;
    }
  }
  return {
    changed,
    updates: changed ? {
      phoneCountryCode: phone?.countryCode || '', phoneNumber: phone?.nationalNumber || '', phoneVerified: false
    } : {}
  };
}

app.put('/api/profile', asyncHandler(async (req, res) => {
  const currentUser = await getAuthenticatedUser(req, res);
  if (!currentUser) {
    return res.status(401).json({
      error: 'unauthorized',
      error_key: 'auth.required',
      error_description: '请先登录'
    });
  }

  const hasName = Object.prototype.hasOwnProperty.call(req.body, 'name');
  const hasUsername = Object.prototype.hasOwnProperty.call(req.body, 'username');
  const hasEmail = Object.prototype.hasOwnProperty.call(req.body, 'email');
  const hasAvatar = Object.prototype.hasOwnProperty.call(req.body, 'avatar');
  const hasDescription = Object.prototype.hasOwnProperty.call(req.body, 'description');
  const hasEmailVerifyCode = normalizeText(req.body.email_code) !== '';
  const phoneUpdate = await preparePhoneUpdate(req, res, currentUser, true);
  if (!phoneUpdate) return;

  let nextName = currentUser.name;
  let nextUsername = currentUser.username;
  let nextEmail = currentUser.email;
  let nextAvatar = currentUser.avatar || '';
  let nextDescription = currentUser.description || '';

  if (hasName) {
    const normalizedName = normalizeText(req.body.name);
    if (!normalizedName) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.display_name.required',
        error_description: '显示名称不能为空'
      });
    }
    nextName = normalizedName;
  }

  if (hasUsername) {
    const normalizedUsername = normalizeText(req.body.username);
    if (!normalizedUsername) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.username.required',
        error_description: '用户名不能为空'
      });
    }

    if (normalizedUsername !== currentUser.username) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.username.read_only',
        error_description: '用户名不允许修改'
      });
    }
  }

  if (hasEmail) {
    const normalizedEmail = normalizeEmail(req.body.email);
    if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'validation.email.invalid',
        error_description: '请输入有效的邮箱地址'
      });
    }
    if (normalizedEmail !== normalizeEmail(currentUser.email)) {
      const recentlyAuthenticated = req.authSession && Date.now() - new Date(req.authSession.created_at).getTime() < 5 * 60 * 1000;
      const suppliedPassword = String(req.body.currentPassword || '');
      const passwordVerified = !recentlyAuthenticated && currentUser.password && suppliedPassword
        && Buffer.byteLength(suppliedPassword) <= 72 && await bcrypt.compare(suppliedPassword, currentUser.password);
      if (!recentlyAuthenticated && !passwordVerified) {
        return res.status(403).json({ error: 'reauthentication_required', error_description: '修改邮箱前请填写当前密码，或重新登录后重试' });
      }
    }
    // A changed email must be confirmed with a code sent to the NEW address.
    if (normalizedEmail !== normalizeEmail(currentUser.email) && !hasEmailVerifyCode) {
      const conflictUser = await User.findByEmail(normalizedEmail);
      if (conflictUser && conflictUser.id !== currentUser.id) {
        return res.status(409).json({
          error: 'conflict',
          error_key: 'validation.email.taken',
          error_description: '该邮箱已被注册'
        });
      }
      const latestCode = await EmailVerificationCode.findLatestActive(normalizedEmail, EMAIL_PURPOSE_EMAIL_CHANGE);
      if (latestCode && Date.now() - new Date(latestCode.created_at).getTime() < 60 * 1000) {
        return res.status(429).json({
          error: 'too_many_requests',
          error_key: 'email_code.cooldown',
          error_description: '发送过于频繁，请 1 分钟后再试'
        });
      }
      await issueEmailVerificationCode({
        email: normalizedEmail,
        purpose: EMAIL_PURPOSE_EMAIL_CHANGE,
        userId: currentUser.id
      });
      return res.json({
        require_email_code: true,
        email: normalizedEmail,
        message_key: 'auth.email_change.sent',
        message: `验证码已发送至新邮箱 ${maskEmail(normalizedEmail)}，请输入以完成修改`
      });
    }
    if (hasEmailVerifyCode && normalizedEmail !== normalizeEmail(currentUser.email)) {
      const verification = await verifyEmailCode({
        email: normalizedEmail,
        purpose: EMAIL_PURPOSE_EMAIL_CHANGE,
        code: req.body.email_code,
        userId: currentUser.id
      });
      if (!verification.ok) {
        return res.status(verification.status).json({
          error: 'invalid_request',
          error_key: verification.error_key,
          error_description: verification.error_description
        });
      }
    }
    nextEmail = normalizedEmail;
  }

  if (hasAvatar) {
    nextAvatar = normalizeText(req.body.avatar);
  }

  if (hasDescription) {
    const nextBio = String(req.body.description ?? '').trim();
    if (nextBio.length > 500) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.description.too_long',
        error_description: '个人简介不能超过 500 字'
      });
    }
    nextDescription = nextBio;
  }

  const { usernameConflict, emailConflict } = await findUserConflicts({
    username: nextUsername,
    email: nextEmail,
    emailVerified: nextEmail !== currentUser.email ? true : undefined,
    excludeUserId: currentUser.id
  });

  if (emailConflict) {
    return res.status(409).json({
      error: 'conflict',
      error_key: 'validation.email.taken',
      error_description: '该邮箱已被注册'
    });
  }

  if (usernameConflict) {
    return res.status(409).json({
      error: 'conflict',
      error_key: 'validation.username.taken',
      error_description: '该用户名已被占用'
    });
  }

  const newPassword = String(req.body.newPassword || '');
  if (newPassword) {
    const currentPassword = String(req.body.currentPassword || '');

    // Accounts without a password yet (e.g. imported users) may set one directly.
    if (currentUser.password && (!currentPassword || !await bcrypt.compare(currentPassword, currentUser.password))) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.current_password.invalid',
        error_description: '当前密码不正确'
      });
    }

    const newPolicyError = await validatePasswordPolicy(newPassword);
    if (newPolicyError) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.password.weak',
        error_description: newPolicyError
      });
    }

    await User.updatePassword(currentUser.id, newPassword);
    await Session.revokeAllForUser(currentUser.id);
    await Token.revokeByUser(currentUser.id);
  }

  await User.update(currentUser.id, {
    name: nextName,
    username: nextUsername,
    email: nextEmail,
    avatar: nextAvatar,
    description: nextDescription,
    ...phoneUpdate.updates
  });

  const updatedUser = await User.findById(currentUser.id);
  if (newPassword || nextEmail !== currentUser.email || phoneUpdate.changed) {
    await Session.revokeAllForUser(currentUser.id);
    await Token.revokeByUser(currentUser.id);
    await setSessionCookie(req, res, updatedUser);
  }

  res.json({
    message_key: 'profile.updated',
    message: '个人信息已更新',
    user: serializeUser(updatedUser)
  });
}));

app.post('/oauth2/token', asyncHandler(async (req, res) => {
  const grantType = normalizeText(req.body.grant_type);
  const code = normalizeText(req.body.code);
  const redirectUri = normalizeText(req.body.redirect_uri);
  const refreshToken = normalizeText(req.body.refresh_token);
  const scopeParam = normalizeText(req.body.scope);
  const codeVerifier = normalizeText(req.body.code_verifier);
  const client = await authenticateClient(req, res);

  if (!client) {
    return;
  }

  const clientId = client.id;

  if (grantType === 'authorization_code') {
    const authCodeData = await Token.findAuthCode(code);
    if (!authCodeData) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.code.invalid',
        error_description: 'Invalid authorization code'
      });
    }

    if (new Date(authCodeData.expires_at) < new Date()) {
      await Token.deleteAuthCode(code);
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.code.expired',
        error_description: 'Authorization code expired'
      });
    }

    if (authCodeData.client_id !== clientId) {
      return res.status(400).json({
        error: 'invalid_client',
        error_key: 'oauth.client.id_mismatch',
        error_description: 'Client ID does not match authorization code'
      });
    }

    if (!redirectUri || authCodeData.redirect_uri !== redirectUri || !client.redirectUris.includes(redirectUri)) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_key: 'auth.request.invalid_redirect_uri',
        error_description: 'Invalid redirect URI'
      });
    }

    if (!verifyPkceChallenge(authCodeData, codeVerifier)) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.pkce.verifier_invalid',
        error_description: 'Invalid code verifier'
      });
    }

    const user = await User.findById(authCodeData.user_id);
    if (!user) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'auth.user_not_found',
        error_description: 'Authorization code user no longer exists'
      });
    }

    if (isUserBanned(user)) {
      return res.status(403).json({
        error: 'account_banned',
        error_key: 'auth.account_banned',
        error_description: '账户已被封禁，请联系管理员'
      });
    }

    if (!await Token.consumeAuthCode(code)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code has already been used' });
    }

    const accessToken = await generateAccessToken(authCodeData.user_id, clientId, authCodeData.scopes);
    const newRefreshToken = authCodeData.scopes.includes('offline_access')
      ? await generateRefreshToken(authCodeData.user_id, clientId, authCodeData.scopes)
      : '';

    const responseBody = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: authCodeData.scopes.join(' ')
    };

    if (authCodeData.scopes.includes('openid')) {
      responseBody.id_token = signingKeys.sign({
        ...scopedUserClaims(user, authCodeData.scopes),
        ...(authCodeData.nonce ? { nonce: authCodeData.nonce } : {}),
        aud: clientId, iss: PUBLIC_BASE_URL, iat: Math.floor(Date.now() / 1000),
        exp: Math.floor((Date.now() + ACCESS_TOKEN_TTL_MS) / 1000)
      });
    }

    if (newRefreshToken) {
      responseBody.refresh_token = newRefreshToken;
    }

    await UserAppUsage.record(user.id, client);
    return res.json(responseBody);
  }

  if (grantType === 'refresh_token') {
    const decoded = validateToken(refreshToken, 'refresh');
    if (!decoded || decoded.type !== 'refresh') {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.refresh_token.invalid',
        error_description: 'Invalid refresh token'
      });
    }

    if (decoded.aud !== clientId) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.refresh_token.client_mismatch',
        error_description: 'Refresh token was issued to a different client'
      });
    }

    const refreshTokenData = await Token.findRefreshTokenById(decoded.jti);
    if (!Token.matchesToken(refreshTokenData, refreshToken) || refreshTokenData.client_id !== clientId
        || refreshTokenData.user_id !== decoded.sub || new Date(refreshTokenData.expires_at) <= new Date()) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.refresh_token.expired',
        error_description: 'Refresh token expired'
      });
    }

    const refreshUser = await User.findById(decoded.sub);
    if (!refreshUser || isUserBanned(refreshUser)) {
      return res.status(403).json({
        error: 'account_banned',
        error_key: 'auth.account_banned',
        error_description: '账户已被封禁，请联系管理员'
      });
    }

    const originalScopes = Array.isArray(refreshTokenData.scopes) ? refreshTokenData.scopes : [];
    const refreshedScopes = scopeParam ? parseRequestedScopes(scopeParam, []) : originalScopes;
    if (findUnsupportedScopes(refreshedScopes, originalScopes).length || findUnsupportedScopes(refreshedScopes, client.scopes).length) {
      return res.status(400).json({ error: 'invalid_scope', error_description: 'Refresh scopes may only narrow the original authorization' });
    }
    if (!await Token.consumeRefreshToken(decoded.jti)) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token has already been used' });
    }
    const accessToken = await generateAccessToken(decoded.sub, clientId, refreshedScopes);
    const replacementRefreshToken = await generateRefreshToken(decoded.sub, clientId, refreshedScopes);

    await UserAppUsage.record(refreshUser.id, client);
    return res.json({
      access_token: accessToken,
      refresh_token: replacementRefreshToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: refreshedScopes.join(' ')
    });
  }

  if (grantType === 'client_credentials') {
    const requestedScopes = parseRequestedScopes(scopeParam, []);
    const unsupportedScopes = findUnsupportedScopes(requestedScopes, client.scopes);
    unsupportedScopes.push(...requestedScopes.filter(scope => ['openid', 'profile', 'email', 'roles', 'offline_access'].includes(scope)));

    if (unsupportedScopes.length) {
      return res.status(400).json({
        error: 'invalid_scope',
        error_key: 'oauth.scope.invalid',
        error_description: `Unsupported scope: ${unsupportedScopes.join(' ')}`
      });
    }

    const accessToken = await generateAccessToken(null, clientId, requestedScopes);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: requestedScopes.join(' ')
    });
  }

  return res.status(400).json({
    error: 'unsupported_grant_type',
    error_key: 'oauth.grant.unsupported',
    error_description: 'Unsupported grant type'
  });
}));

require('./services/qfli-integration')({
  app, asyncHandler, authenticateClient, validateToken, getModels: () => ({ Token, Client, User }),
  isClientActive, isUserBanned, scopedUserClaims,
});

app.get('/oauth2/userinfo', asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'invalid_token',
      error_key: 'auth.header.invalid',
      error_description: '缺少授权头，或授权头格式无效'
    });
  }

  const token = authHeader.substring(7);
  const decoded = validateToken(token, 'access');
  if (!decoded) {
    return res.status(401).json({
      error: 'invalid_token',
      error_key: 'auth.token.invalid_or_expired',
      error_description: '令牌无效或已过期'
    });
  }

  const tokenData = await Token.findAccessTokenById(decoded.jti);
  const tokenClient = tokenData && await Client.findById(tokenData.client_id);
  if (!Token.matchesToken(tokenData, token) || !isClientActive(tokenClient)
      || tokenData.client_id !== decoded.aud || tokenData.user_id !== decoded.sub || new Date(tokenData.expires_at) <= new Date()) {
    return res.status(401).json({
      error: 'invalid_token',
      error_key: 'auth.token.invalid_or_expired',
      error_description: '令牌无效或已过期'
    });
  }

  if (!tokenData.scopes.includes('openid')) {
    return res.status(403).json({ error: 'insufficient_scope', error_description: 'UserInfo requires the openid scope' });
  }

  const user = await User.findById(decoded.sub);
  if (!user) {
    return res.status(404).json({
      error: 'user_not_found',
      error_key: 'auth.user_not_found',
      error_description: '未找到用户'
    });
  }

  if (isUserBanned(user)) {
    return res.status(403).json({
      error: 'account_banned',
      error_key: 'auth.account_banned',
      error_description: '账户已被封禁，请联系管理员'
    });
  }

  res.json(scopedUserClaims(user, tokenData.scopes));
}));

app.post('/oauth2/introspect', asyncHandler(async (req, res) => {
  const client = await authenticateClient(req, res);
  if (!client) {
    return;
  }

  const rawToken = normalizeText(req.body.token);
  const decoded = validateToken(rawToken, 'access');
  if (!decoded) {
    return res.json({ active: false });
  }

  const tokenData = await Token.findAccessTokenById(decoded.jti);
  const tokenUser = tokenData?.user_id ? await User.findById(tokenData.user_id) : null;
  if (!Token.matchesToken(tokenData, rawToken) || tokenData.client_id !== client.id || decoded.aud !== client.id
      || (tokenData.user_id && (!tokenUser || isUserBanned(tokenUser))) || new Date(tokenData.expires_at) <= new Date()) {
    return res.json({ active: false });
  }

  res.json({
    active: true,
    sub: decoded.sub,
    aud: decoded.aud,
    scope: decoded.scope,
    exp: decoded.exp,
    iat: decoded.iat
  });
}));

app.post('/oauth2/revoke', asyncHandler(async (req, res) => {
  const client = await authenticateClient(req, res);
  if (!client) {
    return;
  }

  const rawToken = normalizeText(req.body.token);
  const decoded = validateToken(rawToken, 'access') || validateToken(rawToken, 'refresh');

  if (decoded && decoded.aud === client.id) {
    if (decoded.type === 'refresh') {
      await Token.deleteRefreshToken(decoded.jti);
    } else {
      await Token.deleteAccessToken(decoded.jti);
    }
  }

  res.status(200).send();
}));

app.get('/oauth2/consent', (req, res) => {
  res.redirect(`/oauth2/authorize?${new URLSearchParams(Object.entries(req.query).filter(([, value]) => typeof value === 'string')).toString()}`);
});

app.get('/oauth2/error', (req, res) => {
  res.sendFile(pageFile('error'));
});

app.get(['/success', '/oauth2/success'], (req, res) => {
  res.redirect('/profile');
});

app.get('/profile', asyncHandler(async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    return res.redirect('/oauth2/authorize');
  }

  res.sendFile(pageFile('profile'));
}));

app.get('/oauth2/logout', asyncHandler(async (req, res) => {
  await getAuthenticatedUser(req);
  if (req.authSession) await Session.revoke(req.authSession.id);
  res.clearCookie('session', sessionCookieOptions(null));
  const target = resolveLogoutRedirect(req.query.redirect);
  res.redirect(target || '/oauth2/authorize');
}));

app.get('/api/account/sessions', asyncHandler(async (req, res) => {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return;

  const currentSid = req.authSession?.token || '';
  const rows = await Session.findActiveByUserId(user.id);
  res.json(rows.map(row => ({
    id: row.id,
    ip: row.ip_address || '',
    userAgent: row.user_agent || '',
    createdAt: row.created_at || null,
    expiresAt: row.expires_at || null,
    current: row.token === currentSid
  })));
}));

app.post('/api/account/sessions/revoke-others', asyncHandler(async (req, res) => {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return;

  await Session.revokeAllForUser(user.id, req.authSession.id);
  res.json({ message_key: 'sessions.revoked_others', message: '已退出其他所有设备' });
}));

app.delete('/api/account/sessions/:id', asyncHandler(async (req, res) => {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return;

  const row = await Session.findById(normalizeText(req.params.id));
  if (!row || row.user_id !== user.id) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'sessions.not_found',
      error_description: '未找到该登录会话'
    });
  }

  await Session.revoke(row.id);
  res.status(204).send();
}));

app.post('/api/users/:id/revoke-sessions', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const target = await User.findById(normalizeText(req.params.id));
  if (!target) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'users.not_found',
      error_description: '未找到用户'
    });
  }

  await Session.revokeAllForUser(target.id);
  await Token.revokeByUser(target.id);
  await recordAdminLog({ admin, req, action: 'revoke_sessions', detail: target.username });
  res.json({ message_key: 'users.sessions_revoked', message: '已强制该用户退出所有设备' });
}));

function authenticatorError(status, key, description) {
  return { status, body: { error: status === 404 ? 'not_found' : status === 403 ? 'forbidden' : 'invalid_request', error_key: key, error_description: description } };
}

async function authenticatorStatus(user, authenticators) {
  return {
    totpEnabled: Boolean(user.totp_enabled),
    recoveryCodesRemaining: getRecoveryHashes(user).length,
    authenticators: AuthenticatorModel.project(user, await authenticators.list(user.id))
  };
}

async function mutateAuthenticators(req, res, work) {
  const authenticated = await requireAuthenticatedUser(req, res);
  if (!authenticated) return;
  const result = await Authenticator.withUser(authenticated.id, async (user, authenticators, users, connection) => {
    const session = await new SessionModel(connection).findById(req.authSession.id);
    if (!user || isUserBanned(user) || !session || session.revoked_at || new Date(session.expires_at) <= new Date()) {
      return authenticatorError(401, 'auth.mfa.expired', '登录已失效，请重新登录');
    }
    return work(user, authenticators, users, connection);
  });
  res.status(result.status || 200).json(result.body);
}

async function verifyAuthenticatorManagement(user, code, authenticators, users) {
  const rateLimit = new RateLimitModel(authenticators.pool);
  const limit = await rateLimit.consume(`totp:${user.id}`, 10, 5 * 60 * 1000);
  if (!limit.allowed) return false;
  const valid = await verifyTotpLocked(user, normalizeText(code), authenticators, users)
    || await consumeRecoveryCode(user, code, users);
  if (valid) await rateLimit.clear(`totp:${user.id}`);
  return valid;
}

async function authenticatorSecurityChanged(user, authenticators, users, connection, sessionId) {
  await authenticators.clearPending(user.id);
  const updated = await users.update(user.id, { totpRevision: Number(user.totp_revision || 0) + 1 });
  await new SessionModel(connection).revokeAllForUser(user.id, sessionId);
  await new TokenModel(connection).revokeByUser(user.id);
  return updated;
}

async function stageAuthenticator(req, user, authenticators, users, legacySetup = false) {
  const name = legacySetup ? '' : normalizeText(req.body.name);
  if (!legacySetup && (!name || name.length > 64)) {
    return authenticatorError(400, 'auth.totp.name_required', '请输入验证器名称，最多 64 个字符');
  }
  if (legacySetup && user.totp_enabled) {
    return authenticatorError(409, 'auth.totp.already_enabled', '验证器已绑定，请使用添加验证器');
  }
  if (!(await isSettingEnabled('totp_allowed', authenticators.pool))) {
    return authenticatorError(403, 'auth.totp.disabled', '管理员已关闭验证器两步验证');
  }
  if (user.totp_enabled) {
    if (!await verifyAuthenticatorManagement(user, req.body.code, authenticators, users)) {
      return authenticatorError(400, 'auth.totp.invalid', '现有验证器动态码或恢复码不正确');
    }
    user = await users.findById(user.id);
  } else if (Date.now() - new Date(req.authSession.created_at).getTime() > 5 * 60 * 1000) {
    return authenticatorError(403, 'auth.totp.reauthentication_required', '绑定验证器前，请重新登录');
  }
  await authenticators.clearPending(user.id);
  const secret = generateSecret();
  const encrypted = totpCipher.encrypt(secret);
  if (legacySetup) {
    await users.stageTotpSecret(user.id, encrypted);
    user = await users.findById(user.id);
  } else if (!user.totp_enabled && user.totp_secret) {
    user = await users.update(user.id, { totpSecret: null });
  }
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  const id = await authenticators.stage({ userId: user.id, name, secret: encrypted,
    sessionId: req.authSession.id, securityState: pendingLoginSecurityState(user), expiresAt, legacySetup });
  const otpauthUri = buildOtpauthUri({ secret, account: `${user.email || user.username}${name ? ` (${name})` : ''}` });
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 220 });
  return { body: { id, secret, otpauthUri, qrDataUrl, expiresAt } };
}

async function confirmAuthenticator(req, user, authenticators, users, connection, legacySetup = false) {
  if (!(await isSettingEnabled('totp_allowed', authenticators.pool))) return authenticatorError(403, 'auth.totp.disabled', '管理员已关闭验证器两步验证');
  const pending = (await authenticators.list(user.id)).find(row => !row.activated_at
    && (legacySetup ? row.legacy_setup : row.id === req.params.id));
  if (!pending || pending.session_id !== req.authSession.id || new Date(pending.expires_at) <= new Date()
      || pending.security_state !== pendingLoginSecurityState(user)) {
    return authenticatorError(400, 'auth.totp.setup_expired', '绑定请求已失效，请重新添加');
  }
  if (pending.attempts >= 5) return authenticatorError(429, 'auth.totp.setup_locked', '验证失败次数过多，请重新添加');
  let secret;
  try { secret = totpCipher.decrypt(pending.secret); } catch { return authenticatorError(400, 'auth.totp.setup_expired', '绑定请求已失效'); }
  const counter = matchingTotpCounter(secret, normalizeText(req.body.code));
  if (counter === null) {
    await authenticators.failedAttempt(pending.id);
    return authenticatorError(400, 'auth.totp.invalid', '新验证器动态码不正确');
  }
  const recoveryCodes = user.totp_enabled ? null : generateRecoveryCodes();
  if (pending.legacy_setup) {
    if (user.totp_enabled || user.totp_secret !== pending.secret) return authenticatorError(409, 'auth.totp.setup_expired', '绑定请求已改变');
    await users.consumeTotpCounter(user.id, counter);
  } else {
    await authenticators.activate(pending.id, counter);
  }
  user = await users.update(user.id, { totpEnabled: true,
    ...(recoveryCodes ? { recoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)) } : {}) });
  user = await authenticatorSecurityChanged(user, authenticators, users, connection, req.authSession.id);
  return { body: { ...await authenticatorStatus(user, authenticators), ...(recoveryCodes ? { recoveryCodes } : {}), message_key: 'auth.totp.enabled' } };
}

app.post('/api/account/totp/authenticators/setup', asyncHandler(async (req, res) => {
  await mutateAuthenticators(req, res, (user, authenticators, users) => stageAuthenticator(req, user, authenticators, users));
}));

app.post('/api/account/totp/authenticators/:id/confirm', asyncHandler(async (req, res) => {
  await mutateAuthenticators(req, res, (user, authenticators, users, connection) => confirmAuthenticator(req, user, authenticators, users, connection));
}));

app.delete('/api/account/totp/authenticators/:id', asyncHandler(async (req, res) => {
  await mutateAuthenticators(req, res, async (user, authenticators, users, connection) => {
    const id = normalizeText(req.params.id);
    const rows = await authenticators.list(user.id);
    const legacy = id === 'legacy' && user.totp_enabled && user.totp_secret;
    const device = rows.find(row => row.id === id);
    if (!legacy && !device) return authenticatorError(404, 'auth.totp.not_found', '未找到验证器');
    if (device && !device.activated_at) {
      if (device.session_id !== req.authSession.id) return authenticatorError(404, 'auth.totp.not_found', '未找到绑定请求');
      await authenticators.remove(user.id, device.id);
      return { body: await authenticatorStatus(user, authenticators) };
    }
    if (!await verifyAuthenticatorManagement(user, req.body.code, authenticators, users)) return authenticatorError(400, 'auth.totp.invalid', '动态码或恢复码不正确');
    if (legacy) user = await users.update(user.id, { totpSecret: null });
    else await authenticators.remove(user.id, id);
    const enabled = Boolean((user.totp_secret && user.totp_enabled) || (await authenticators.list(user.id)).some(row => row.activated_at));
    user = await users.update(user.id, { totpEnabled: enabled, ...(!enabled ? { totpSecret: null, recoveryCodes: null } : {}) });
    user = await authenticatorSecurityChanged(user, authenticators, users, connection, req.authSession.id);
    return { body: await authenticatorStatus(user, authenticators) };
  });
}));

app.get('/api/account/totp', asyncHandler(async (req, res) => {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return;

  const status = await Authenticator.withUser(user.id, (current, authenticators) => authenticatorStatus(current, authenticators));
  res.json(status);
}));

app.post('/api/account/totp/recovery-codes', asyncHandler(async (req, res) => {
  await mutateAuthenticators(req, res, async (user, authenticators, users, connection) => {
    if (!user.totp_enabled) return authenticatorError(400, 'auth.totp.setup_required', '请先绑定验证器');
    const rateLimit = new RateLimitModel(connection);
    const limit = await rateLimit.consume(`totp:${user.id}`, 10, 5 * 60 * 1000);
    if (!limit.allowed || !await verifyTotpLocked(user, normalizeText(req.body.code), authenticators, users)) {
      return authenticatorError(400, 'auth.totp.invalid', '动态验证码不正确，无法重新生成');
    }
    await rateLimit.clear(`totp:${user.id}`);
    const recoveryCodes = generateRecoveryCodes();
    user = await users.update(user.id, { recoveryCodes: JSON.stringify(recoveryCodes.map(hashRecoveryCode)) });
    await authenticatorSecurityChanged(user, authenticators, users, connection, req.authSession.id);
    return { body: { recoveryCodes, message: '已生成新的恢复码，旧恢复码全部失效（仅显示这一次）' } };
  });
}));

app.post('/api/account/totp/setup', asyncHandler(async (req, res) => {
  await mutateAuthenticators(req, res, (user, authenticators, users) => stageAuthenticator(req, user, authenticators, users, true));
}));

app.post('/api/account/totp/enable', asyncHandler(async (req, res) => {
  await mutateAuthenticators(req, res, (user, authenticators, users, connection) => confirmAuthenticator(req, user, authenticators, users, connection, true));
}));

app.post('/api/account/totp/disable', asyncHandler(async (req, res) => {
  await mutateAuthenticators(req, res, async (user, authenticators, users, connection) => {
    if (user.totp_enabled && !await verifyAuthenticatorManagement(user, req.body.code, authenticators, users)) {
      return authenticatorError(400, 'auth.totp.invalid', '动态码或恢复码不正确，无法解绑');
    }
    await authenticators.clear(user.id);
    user = await users.update(user.id, { totpSecret: null, totpEnabled: false, recoveryCodes: null });
    user = await authenticatorSecurityChanged(user, authenticators, users, connection, req.authSession.id);
    return { body: { ...await authenticatorStatus(user, authenticators), message_key: 'auth.totp.disabled_ok', message: '验证器已解绑' } };
  });
}));

app.get('/api/account/identities', asyncHandler(async (req, res) => {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return;

  const identities = await ExternalIdentity.findByUserId(user.id);
  res.json({ identities: ExternalIdentity.serializeMany(identities) });
}));

app.get('/api/account/applications', asyncHandler(async (req, res) => {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return;
  const [usage, identities, clients, providers] = await Promise.all([
    UserAppUsage.findByUserId(user.id), ExternalIdentity.findByUserId(user.id),
    Client.findAll(), OidcProvider.findAll()
  ]);
  const clientMap = new Map(clients.map(row => [row.id, row]));
  const providerMap = new Map(providers.map(row => [row.provider_key, row]));
  res.json({
    applications: usage.map(row => serializeAppUsage(row, clientMap.get(row.client_id))),
    bindings: identities.map(row => serializeAccountBinding(row, providerMap.get(row.provider)))
  });
}));

app.delete('/api/account/identities/:id', asyncHandler(async (req, res) => {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return;

  const identity = await ExternalIdentity.findById(normalizeText(req.params.id));
  if (!identity || identity.user_id !== user.id) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'identity.not_found',
      error_description: '未找到第三方账号绑定'
    });
  }

  const identities = await ExternalIdentity.findByUserId(user.id);
  if (identities.length <= 1) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'identity.last_binding',
      error_description: '至少需要保留一个第三方账号绑定'
    });
  }

  await ExternalIdentity.delete(identity.id);
  res.status(204).send();
}));

app.get('/api/users/:id/identities', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const target = await User.findById(normalizeText(req.params.id));
  if (!target) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'users.not_found',
      error_description: '未找到用户'
    });
  }

  const identities = await ExternalIdentity.findByUserId(target.id);
  res.json({ identities: ExternalIdentity.serializeMany(identities) });
}));

app.get('/api/users', asyncHandler(async (req, res) => {
  const user = await requireAdminUser(req, res);
  if (!user) return;

  const users = await User.findAll();
  const result = [];
  for (const user of users) {
    const identities = await ExternalIdentity.findByUserId(user.id);
    result.push({ ...serializeUser(user), identities: ExternalIdentity.serializeMany(identities) });
  }
  res.json(result);
}));

app.get('/api/users/:id', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const target = await User.findById(normalizeText(req.params.id));
  if (!target) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'users.not_found',
      error_description: '未找到用户'
    });
  }

  const identities = await ExternalIdentity.findByUserId(target.id);
  res.json({ user: { ...serializeUser(target), identities: ExternalIdentity.serializeMany(identities) } });
}));

app.put('/api/users/:id', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const userId = normalizeText(req.params.id);
  const target = await User.findById(userId);
  if (!target) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'users.not_found',
      error_description: '未找到用户'
    });
  }

  const nextRole = req.body.role === undefined
    ? normalizeText(target.role).toLowerCase() || USER_ROLE_USER
    : normalizeText(req.body.role).toLowerCase();
  if (![USER_ROLE_ADMIN, USER_ROLE_USER].includes(nextRole)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'users.role.invalid',
      error_description: '用户角色无效'
    });
  }

  if (target.id === admin.id && nextRole !== USER_ROLE_ADMIN) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'users.self_demote',
      error_description: '不能移除自己的管理员权限'
    });
  }

  if (normalizeText(target.role).toLowerCase() === USER_ROLE_ADMIN && nextRole !== USER_ROLE_ADMIN) {
    const admins = (await User.findAll()).filter(item => normalizeText(item.role).toLowerCase() === USER_ROLE_ADMIN);
    if (admins.length <= 1) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'users.last_admin',
        error_description: '系统至少需要一个管理员'
      });
    }
  }

  const updates = { role: nextRole };
  const phoneUpdate = await preparePhoneUpdate(req, res, target);
  if (!phoneUpdate) return;
  Object.assign(updates, phoneUpdate.updates);
  if (req.body.captchaRequired !== undefined) {
    updates.captchaRequired = Boolean(req.body.captchaRequired);
  }
  if (req.body.banned !== undefined) {
    const banned = Boolean(req.body.banned);
    if (banned && target.id === admin.id) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'users.self_ban',
        error_description: '不能封禁当前登录的管理员账户'
      });
    }
    updates.banned = banned;
  }
  if (req.body.emailVerified !== undefined) {
    updates.emailVerified = Boolean(req.body.emailVerified);
  }
  if (req.body.name !== undefined) {
    const name = normalizeText(req.body.name);
    if (!name) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'users.name.required',
        error_description: '显示名称不能为空'
      });
    }
    updates.name = name;
  }
  if (req.body.email !== undefined) {
    const email = normalizeEmail(req.body.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'validation.email.invalid',
        error_description: '请输入有效的邮箱地址'
      });
    }
    const emailConflict = await User.findByUsername(email);
    if (emailConflict && emailConflict.id !== target.id) {
      return res.status(409).json({
        error: 'conflict',
        error_key: 'validation.email.taken',
        error_description: '该邮箱已被其他账户使用'
      });
    }
    updates.email = email;
  }
  if (req.body.avatar !== undefined) {
    updates.avatar = normalizeText(req.body.avatar);
  }
  if (req.body.description !== undefined) {
    const description = String(req.body.description ?? '').trim();
    if (description.length > 500) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'users.description.too_long',
        error_description: '个人简介不能超过 500 字'
      });
    }
    updates.description = description;
  }
  if (req.body.credits !== undefined) {
    const credits = Number(req.body.credits);
    if (!Number.isInteger(credits) || credits < 0) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'users.credits.invalid',
        error_description: '积分必须是不小于 0 的整数'
      });
    }
    updates.credits = credits;
  }

  const updated = await User.update(userId, updates);
  const securityChanged = (updates.banned !== undefined && updates.banned !== Boolean(target.banned))
    || (updates.email !== undefined && updates.email !== normalizeEmail(target.email))
    || (updates.emailVerified !== undefined && updates.emailVerified !== Boolean(target.email_verified))
    || nextRole !== normalizeText(target.role).toLowerCase()
    || phoneUpdate.changed;
  if (securityChanged) {
    await Session.revokeAllForUser(userId, target.id === admin.id ? req.authSession.id : null);
    await Token.revokeByUser(userId);
  }
  await recordAdminLog({ admin, req, action: 'update_user', detail: `${target.username} -> ${Object.keys(updates).join(',')}` });
  const identities = await ExternalIdentity.findByUserId(userId);
  res.json({ user: { ...serializeUser(updated), identities: ExternalIdentity.serializeMany(identities) } });
}));

app.delete('/api/users/:id', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const userId = normalizeText(req.params.id);
  const target = await User.findById(userId);
  if (!target) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'users.not_found',
      error_description: '未找到用户'
    });
  }
  if (target.id === admin.id) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'users.self_delete',
      error_description: '不能删除当前登录的管理员账户'
    });
  }
  if (normalizeText(target.role).toLowerCase() === USER_ROLE_ADMIN) {
    const admins = (await User.findAll()).filter(item => normalizeText(item.role).toLowerCase() === USER_ROLE_ADMIN);
    if (admins.length <= 1) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'users.last_admin',
        error_description: '不能删除最后一个管理员'
      });
    }
  }

  await User.delete(userId);
  await recordAdminLog({ admin, req, action: 'delete_user', detail: target.username });
  res.status(204).send();
}));

const USER_IMPORT_MAX_ROWS = 200;
const USER_IMPORT_COLUMNS = ['username', 'email', 'name', 'password', 'role', 'nickname', 'photo', 'description', 'credits', 'qq_login_openid', 'ip', 'ischeck', 'state', 'create_time', 'update_time'];

function parseImportCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"' && line[index + 1] === '"') { current += '"'; index++; }
      else if (char === '"') inQuotes = false;
      else current += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells.map(cell => cell.trim());
}

function parseImportDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000);
  if (/^\d{13}$/.test(text)) return new Date(Number(text));
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseUserImportContent(content) {
  const text = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!text) {
    return { rows: [], error: '导入内容不能为空' };
  }

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.users) ? parsed.users : null;
      if (!list) {
        return { rows: [], error: 'JSON 格式应为用户对象数组，或包含 users 数组的对象' };
      }
      return { rows: list, error: '' };
    } catch (error) {
      return { rows: [], error: 'JSON 解析失败，请检查格式' };
    }
  }

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const headers = parseImportCsvLine(lines[0]).map(header => header.toLowerCase());
  const hasHeader = headers.some(header => USER_IMPORT_COLUMNS.includes(header));
  const columns = hasHeader ? headers : ['username', 'email', 'name', 'password', 'role'];
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return {
    rows: dataLines.map(line => {
      const cells = parseImportCsvLine(line);
      const record = {};
      columns.forEach((column, index) => {
        if (USER_IMPORT_COLUMNS.includes(column)) record[column] = cells[index] || '';
      });
      return record;
    }),
    error: ''
  };
}

app.post('/api/users/import', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const { rows, error } = parseUserImportContent(req.body.content);
  if (error) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'users.import.invalid',
      error_description: error
    });
  }
  if (!rows.length) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'users.import.empty',
      error_description: '没有可导入的用户记录'
    });
  }
  if (rows.length > USER_IMPORT_MAX_ROWS) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'users.import.too_many',
      error_description: `单次最多导入 ${USER_IMPORT_MAX_ROWS} 条记录`
    });
  }

  const created = [];
  const skipped = [];
  const seen = new Set();

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] || {};
    const email = normalizeEmail(row.email);
    const username = normalizeText(row.username) || email;
    const name = normalizeText(row.name) || normalizeText(row.nickname);
    const password = String(row.password || '');
    const avatar = normalizeText(row.avatar) || normalizeText(row.photo);
    const description = String(row.description ?? '').trim();
    const creditsRaw = String(row.credits ?? '').trim();
    const qqOpenid = String(row.qq_login_openid ?? '').trim();
    const lastLoginIp = normalizeText(row.ip).slice(0, 64);
    const emailVerified = ['y', '1', 'true'].includes(normalizeText(row.ischeck).toLowerCase());
    const banned = ['1', 'true', 'y'].includes(normalizeText(row.state).toLowerCase());
    const createdAt = parseImportDate(row.create_time);
    const updatedAt = parseImportDate(row.update_time);

    if (!email || !isValidEmail(email)) {
      skipped.push({ row: index + 1, username, email, reason: '邮箱缺失或格式无效' });
      continue;
    }
    if (!username) {
      skipped.push({ row: index + 1, username, email, reason: '缺少用户名' });
      continue;
    }
    if (password && await validatePasswordPolicy(password)) {
      skipped.push({ row: index + 1, username, email, reason: '密码长度不满足系统要求' });
      continue;
    }
    if (description.length > 500) {
      skipped.push({ row: index + 1, username, email, reason: '个人简介不能超过 500 字' });
      continue;
    }
    let credits = 0;
    if (creditsRaw) {
      credits = Number(creditsRaw);
      if (!Number.isInteger(credits) || credits < 0) {
        skipped.push({ row: index + 1, username, email, reason: '积分必须是不小于 0 的整数' });
        continue;
      }
    }

    const dedupeKey = `${username.toLowerCase()}|${email}`;
    if (seen.has(dedupeKey)) {
      skipped.push({ row: index + 1, username, email, reason: '与本次导入中的其他记录重复' });
      continue;
    }
    seen.add(dedupeKey);

    if (await User.findByUsername(username)) {
      skipped.push({ row: index + 1, username, email, reason: '用户名或邮箱已存在' });
      continue;
    }
    if (await User.findByUsername(email)) {
      skipped.push({ row: index + 1, username, email, reason: '邮箱已被其他账户使用' });
      continue;
    }
    if (qqOpenid && await ExternalIdentity.findByProviderUserId('qq', qqOpenid)) {
      skipped.push({ row: index + 1, username, email, reason: 'QQ 账号已绑定其他用户' });
      continue;
    }

    const role = normalizeText(row.role).toLowerCase() === USER_ROLE_ADMIN ? USER_ROLE_ADMIN : USER_ROLE_USER;
    const user = await User.create({ username, email, password: password || '', name, avatar, description, credits, role, emailVerified, banned, lastLoginIp, createdAt, updatedAt });
    if (qqOpenid) {
      await ExternalIdentity.create({
        userId: user.id,
        provider: 'qq',
        providerUserId: qqOpenid,
        providerUsername: username,
        displayName: name,
        email,
        profile: {}
      });
    }
    created.push(serializeUser(user));
  }

  await recordAdminLog({ admin, req, action: 'import_users', detail: `created:${created.length} skipped:${skipped.length}` });
  res.json({
    createdCount: created.length,
    skippedCount: skipped.length,
    created,
    skipped
  });
}));

app.get('/api/clients', asyncHandler(async (req, res) => {
  const user = await requireAdminUser(req, res);
  if (!user) {
    return;
  }

  const clients = await Client.findAll();
  res.json(clients.map(serializeClient));
}));

app.post('/api/clients', asyncHandler(async (req, res) => {
  const user = await requireAdminUser(req, res);
  if (!user) {
    return;
  }

  const payload = {
    ...req.body,
    secret: normalizeText(req.body.secret) || generateClientSecret()
  };

  const validated = validateClientPayload(payload, {
    requireId: true,
    requireSecret: true
  });
  if (!validated.ok) {
    return res.status(validated.status).json(validated.body);
  }

  const existing = await Client.findById(validated.value.id);
  if (existing) {
    return res.status(409).json({
      error: 'conflict',
      error_key: 'clients.validation.id_taken',
      error_description: '客户端 ID 已存在'
    });
  }

  const created = await Client.create(validated.value);
  res.status(201).json({
    message_key: 'clients.created',
    message: '应用已创建',
    client: serializeClient(created),
    clientSecret: validated.value.secret
  });
}));

app.put('/api/clients/:id', asyncHandler(async (req, res) => {
  const user = await requireAdminUser(req, res);
  if (!user) {
    return;
  }

  const clientId = normalizeText(req.params.id);
  const existing = await Client.findById(clientId);
  if (!existing) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'clients.not_found',
      error_description: '未找到客户端'
    });
  }

  const validated = validateClientPayload({
    ...req.body,
    isActive: req.body.isActive === undefined ? isClientActive(existing) : req.body.isActive,
    requirePkce: req.body.requirePkce === undefined ? existing.requirePkce : req.body.requirePkce,
    id: clientId
  }, {
    requireId: false,
    requireSecret: false
  });
  if (!validated.ok) {
    return res.status(validated.status).json(validated.body);
  }

  const pkceOnlyChange = existing.requirePkce !== validated.value.requirePkce
    && existing.name === validated.value.name
    && !validated.value.secret
    && JSON.stringify(existing.redirectUris) === JSON.stringify(validated.value.redirectUris)
    && JSON.stringify(existing.scopes) === JSON.stringify(validated.value.scopes)
    && (existing.logo_url || '') === validated.value.logoUrl
    && isClientActive(existing) === validated.value.isActive;

  const updated = await Client.update(clientId, {
    name: validated.value.name,
    secret: validated.value.secret || undefined,
    redirectUris: validated.value.redirectUris,
    scopes: validated.value.scopes,
    logoUrl: validated.value.logoUrl,
    isActive: validated.value.isActive,
    requirePkce: validated.value.requirePkce
  });

  await Token.revokeByClient(clientId, { preserveAuthCodes: pkceOnlyChange });
  await recordAdminLog({ admin: user, req, action: 'update_client', detail: clientId });

  res.json({
    message_key: 'clients.updated',
    message: '应用已更新',
    client: serializeClient(updated),
    clientSecret: validated.value.secret || ''
  });
}));

app.delete('/api/clients/:id', asyncHandler(async (req, res) => {
  const user = await requireAdminUser(req, res);
  if (!user) {
    return;
  }

  const clientId = normalizeText(req.params.id);
  const existing = await Client.findById(clientId);
  if (!existing) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'clients.not_found',
      error_description: '未找到客户端'
    });
  }

  await Client.delete(clientId);
  res.json({
    message_key: 'clients.deleted',
    message: '应用已删除'
  });
}));

app.get('/api/admin/smtp', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  res.json(getSmtpSettings());
}));

app.put('/api/admin/smtp', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const host = req.body.host !== undefined ? normalizeText(req.body.host) : undefined;
  if (host !== undefined && host && !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'smtp.host.invalid',
      error_description: 'SMTP 主机格式无效'
    });
  }

  const port = req.body.port !== undefined ? Number(req.body.port) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'smtp.port.invalid',
      error_description: 'SMTP 端口无效'
    });
  }

  if (req.body.clearPassword !== undefined && typeof req.body.clearPassword !== 'boolean') {
    return res.status(400).json({ error: 'invalid_request', error_description: '清除密码参数无效' });
  }
  if (req.body.password !== undefined && (typeof req.body.password !== 'string' || req.body.password.length > 4096)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'SMTP 密码格式无效' });
  }
  const current = getSmtpSettings();
  const smtp = {
    host: host ?? current.host,
    port: port ?? current.port,
    user: req.body.user !== undefined ? normalizeText(req.body.user) : current.user,
    from: req.body.from !== undefined ? normalizeText(req.body.from) : current.from,
    password: req.body.clearPassword ? '' : req.body.password || process.env.SMTP_PASS || ''
  };
  if (smtp.host.length > 253 || smtp.user.length > 320 || smtp.from.length > 320) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'SMTP 配置内容过长' });
  }
  const next = { ...adminSettingsOverrides, smtp };
  adminSettingsStore.save(next);
  adminSettingsOverrides = next;

  applySmtpSettings(smtp);

  await recordAdminLog({ admin, req, action: 'update_smtp_settings', detail: `host:${normalizeText(req.body.host) || 'unchanged'} port:${port ?? 'unchanged'}` });
  res.json({ ...getSmtpSettings(), message_key: 'smtp.saved', message: '发件设置已保存，重启后仍然生效' });
}));

app.get('/api/admin/turnstile', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  res.json({ siteKey: turnstileSettings.siteKey, hasSecretKey: Boolean(turnstileSettings.secretKey) });
}));

app.put('/api/admin/turnstile', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  if (req.body.clear !== undefined && typeof req.body.clear !== 'boolean') {
    return res.status(400).json({ error: 'invalid_request', error_description: '清除配置参数无效' });
  }
  if (req.body.siteKey !== undefined && typeof req.body.siteKey !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: '站点密钥格式无效' });
  }
  if (req.body.secretKey !== undefined && typeof req.body.secretKey !== 'string') {
    return res.status(400).json({ error: 'invalid_request', error_description: '私钥格式无效' });
  }
  const siteKey = req.body.clear ? '' : req.body.siteKey === undefined ? turnstileSettings.siteKey : normalizeText(req.body.siteKey);
  const secretKey = req.body.clear ? '' : normalizeText(req.body.secretKey) || turnstileSettings.secretKey;
  if (Boolean(siteKey) !== Boolean(secretKey) || (siteKey && !/^[A-Za-z0-9_-]{1,256}$/.test(siteKey))
      || (secretKey && !/^[A-Za-z0-9_-]{1,256}$/.test(secretKey))) {
    return res.status(400).json({ error: 'invalid_request', error_description: '站点密钥和私钥必须同时设置，且只能包含字母、数字、下划线和连字符' });
  }
  const next = { ...adminSettingsOverrides, turnstile: { siteKey, secretKey } };
  adminSettingsStore.save(next);
  adminSettingsOverrides = next;
  turnstileSettings = next.turnstile;
  await recordAdminLog({ admin, req, action: 'update_turnstile_settings', detail: siteKey ? 'configured' : 'cleared' });
  res.json({ siteKey, hasSecretKey: Boolean(secretKey), message: 'Turnstile 设置已保存，重启后仍然生效' });
}));

app.post('/api/admin/smtp/test', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const to = normalizeEmail(req.body.to);
  if (!to || !isValidEmail(to)) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.email.invalid',
      error_description: '请输入有效的收件邮箱地址'
    });
  }

  try {
    await sendTestEmail(to);
    res.json({ message_key: 'smtp.test_sent', message: `测试邮件已发送到 ${to}` });
  } catch (error) {
    res.status(502).json({
      error: 'smtp_failed',
      error_key: 'smtp.test_failed',
      error_description: `发送失败：${error.message}`
    });
  }
}));

app.post('/api/users/:id/totp/reset', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const target = await User.findById(normalizeText(req.params.id));
  if (!target) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'users.not_found',
      error_description: '未找到用户'
    });
  }

  await Authenticator.withUser(target.id, async (user, authenticators, users, connection) => {
    if (!user) return;
    await authenticators.clear(user.id);
    user = await users.update(user.id, { totpSecret: null, totpEnabled: false, recoveryCodes: null });
    await authenticatorSecurityChanged(user, authenticators, users, connection, user.id === admin.id ? req.authSession.id : null);
  });
  await recordAdminLog({ admin, req, action: 'reset_totp', detail: target.username });
  res.json({ message_key: 'users.totp.reset', message: '已重置该用户的验证器绑定' });
}));

app.get('/api/admin/security', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  res.json({
    captchaLogin: (await getSettingValue('captcha_login')) === 'true',
    captchaRegister: (await getSettingValue('captcha_register')) === 'true',
    loginEmailCode: (await getSettingValue('login_email_code')) === 'true',
    registrationEnabled: (await getSettingValue('registration_enabled')) === 'true',
    totpAllowed: (await getSettingValue('totp_allowed')) === 'true',
    passwordRequireMixed: (await getSettingValue('password_require_mixed')) === 'true',
    anomalyDetection: (await getSettingValue('anomaly_detection')) === 'true',
    huaweiPhoneAutolink: (await getSettingValue('huawei_phone_autolink')) === 'true',
    passwordMinLength: await getPasswordMinLength(),
    loginMaxAttempts: await getSettingNumber('login_max_attempts', 5),
    loginLockoutMinutes: await getSettingNumber('login_lockout_minutes', 15)
  });
}));

function serializeAdminOidcProvider(config) {
  return {
    key: config.providerKey,
    providerName: config.providerName,
    providerType: config.providerType || PROVIDER_TYPE_OIDC,
    huaweiUnionScope: normalizeText(config.huaweiUnionScope),
    enabled: config.enabled !== false,
    configured: isOidcEnabled(config) || isHuaweiEnabled(config),
    clientId: config.clientId || '',
    clientSecretConfigured: Boolean(config.clientSecret),
    credentialError: Boolean(config.credentialError),
    issuerUrl: config.issuerUrl || '',
    discoveryUrl: config.discoveryUrl || '',
    authorizeUrl: config.authorizeUrl || '',
    tokenUrl: config.tokenUrl || '',
    userinfoUrl: config.userinfoUrl || '',
    jwksUrl: config.jwksUrl || '',
    scopes: config.scopes,
    tokenAuthMethod: config.tokenAuthMethod,
    pkceEnabled: Boolean(config.pkceEnabled),
    validateIdToken: Boolean(config.validateIdToken),
    requireEmailVerified: Boolean(config.requireEmailVerified),
    userinfoIdPath: config.userinfoIdPath,
    userinfoSecondaryIdPath: config.userinfoSecondaryIdPath || '',
    userinfoEmailPath: config.userinfoEmailPath,
    userinfoUsernamePath: config.userinfoUsernamePath,
    userinfoMethod: config.userinfoMethod || OIDC_CONFIG.userinfoMethod,
    userinfoTokenIn: config.userinfoTokenIn || OIDC_CONFIG.userinfoTokenIn
  };
}

async function getAdminOidcConfigs() {
  if (oidcStorageSource === 'database') {
    const rows = await OidcProvider.findAll();
    return rows.map(oidcDatabaseRowToConfig);
  }
  const keys = Object.keys(OIDC_PROVIDERS);
  return (keys.length ? keys.map(getOidcProviderConfig).filter(Boolean) : (isOidcEnabled(OIDC_CONFIG) ? [OIDC_CONFIG] : []));
}

function serializeAccountBinding(row, provider) {
  const identity = ExternalIdentity.serialize(row);
  const profile = identity.profile;
  const isHuawei = profile.provider === PROVIDER_TYPE_HUAWEI;
  return {
    id: identity.id, provider: row.provider,
    providerName: normalizeText(profile.providerName) || provider?.provider_name || row.provider,
    providerType: isHuawei ? PROVIDER_TYPE_HUAWEI : provider?.provider_type || row.provider,
    clientId: normalizeText(profile.clientId) || provider?.client_id || '',
    openId: isHuawei ? normalizeText(profile.openID) || row.provider_secondary_id || (!profile.unionID ? row.provider_user_id : '') : '',
    unionId: isHuawei ? normalizeText(profile.unionID) : '',
    huaweiUnionScope: isHuawei ? normalizeText(profile.huaweiUnionScope ?? provider?.huawei_union_scope) : '',
    providerUserId: identity.providerUserId, providerSecondaryId: identity.providerSecondaryId,
    configured: Boolean(provider), enabled: Boolean(provider?.enabled),
    createdAt: identity.createdAt, updatedAt: identity.updatedAt
  };
}

function serializeAppUsage(row, client) {
  return {
    clientId: row.client_id, name: client?.name || row.client_name,
    configured: Boolean(client), enabled: Boolean(client && isClientActive(client)),
    firstUsedAt: row.first_used_at, lastUsedAt: row.last_used_at
  };
}

app.get('/api/admin/account-bindings', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  const [identities, usage, providerRows, clientRows] = await Promise.all([
    ExternalIdentity.findAll(), UserAppUsage.findAll(), OidcProvider.findAll(), Client.findAll()
  ]);
  const providers = new Map(providerRows.map(row => [row.provider_key, row]));
  const clients = new Map(clientRows.map(row => [row.id, row]));
  const accounts = new Map();
  for (const userId of new Set([...identities, ...usage].map(row => row.user_id))) {
    const user = await User.findById(userId);
    if (!user) continue;
    accounts.set(user.id, {
      user: { id: user.id, username: user.username, name: user.name || '', email: user.email || '' },
      bindings: [], applications: []
    });
  }
  for (const row of identities) {
    accounts.get(row.user_id)?.bindings.push(serializeAccountBinding(row, providers.get(row.provider)));
  }
  for (const row of usage) {
    accounts.get(row.user_id)?.applications.push(serializeAppUsage(row, clients.get(row.client_id)));
  }
  res.json({ accounts: [...accounts.values()] });
}));

app.get('/api/admin/oidc', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const configs = await getAdminOidcConfigs();
  res.json({
    source: oidcStorageSource === 'database' ? 'database' : Object.keys(OIDC_PROVIDERS).length ? 'OIDC_PROVIDERS_JSON' : 'OIDC_* environment variables',
    callbackUrl: getOidcCallbackUrl(req),
    providers: configs.map(serializeAdminOidcProvider)
  });
}));

app.post('/api/admin/oidc', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  const providerKey = normalizeText(req.body.providerKey).toLowerCase();
  const providerName = normalizeText(req.body.providerName);
  if (!/^[a-z0-9][a-z0-9_-]{1,127}$/.test(providerKey) || !providerName) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Provider key 和名称格式无效' });
  }
  const current = await OidcProvider.findByKey(providerKey);
  for (const key of ['enabled', 'pkceEnabled', 'validateIdToken', 'requireEmailVerified']) {
    if (req.body[key] !== undefined && typeof req.body[key] !== 'boolean') {
      return res.status(400).json({ error: 'invalid_request', error_description: `${key} must be a boolean` });
    }
  }
  for (const key of ['issuerUrl', 'discoveryUrl', 'authorizeUrl', 'tokenUrl', 'userinfoUrl', 'jwksUrl']) {
    if (req.body[key] && !isHttpUrl(req.body[key])) {
      return res.status(400).json({ error: 'invalid_request', error_description: `${key} must be a valid HTTPS endpoint` });
    }
  }
  if (req.body.frontendCallbackPath && !isSafeFrontendPath(req.body.frontendCallbackPath)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Invalid frontend callback path' });
  }
  if (req.body.clockTolerance !== undefined && (!Number.isInteger(req.body.clockTolerance) || req.body.clockTolerance < 0 || req.body.clockTolerance > 120)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Clock tolerance must be an integer from 0 to 120 seconds' });
  }
  const providerType = (normalizeText(req.body.providerType) || current?.provider_type || PROVIDER_TYPE_OIDC).toLowerCase();
  if (!PROVIDER_TYPES.has(providerType)) {
    return res.status(400).json({ error: 'invalid_request', error_description: `providerType 必须是 ${[...PROVIDER_TYPES].join(' 或 ')}` });
  }
  const huaweiUnionScope = req.body.huaweiUnionScope === undefined
    ? current?.huawei_union_scope || '' : normalizeText(req.body.huaweiUnionScope);
  if (req.body.huaweiUnionScope !== undefined && (typeof req.body.huaweiUnionScope !== 'string' || !/^[a-zA-Z0-9._:-]{0,128}$/.test(huaweiUnionScope))) {
    return res.status(400).json({ error: 'invalid_request', error_description: '华为主体分组最多 128 位，只能包含字母、数字、点、下划线、冒号和短横线' });
  }
  const userinfoMethod = (normalizeText(req.body.userinfoMethod) || current?.userinfo_method || OIDC_CONFIG.userinfoMethod).toUpperCase();
  if (!USERINFO_METHODS.has(userinfoMethod)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'userinfoMethod 必须是 GET 或 POST' });
  }
  const userinfoTokenIn = (normalizeText(req.body.userinfoTokenIn) || current?.userinfo_token_in || OIDC_CONFIG.userinfoTokenIn).toLowerCase();
  if (!USERINFO_TOKEN_IN.has(userinfoTokenIn)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'userinfoTokenIn 必须是 header 或 body_form' });
  }
  const clientSecret = normalizeText(req.body.clientSecret);
  if (!current && !clientSecret) {
    return res.status(400).json({ error: 'invalid_request', error_description: '新 Provider 必须填写 Client Secret' });
  }
  const saved = await OidcProvider.upsert({
    providerKey, providerName, providerType, huaweiUnionScope, enabled: req.body.enabled !== false,
    clientId: req.body.clientId, clientSecret: clientSecret ? encryptOidcSecret(clientSecret) : current.client_secret,
    issuerUrl: req.body.issuerUrl, discoveryUrl: req.body.discoveryUrl, authorizeUrl: req.body.authorizeUrl,
    tokenUrl: req.body.tokenUrl, userinfoUrl: req.body.userinfoUrl, jwksUrl: req.body.jwksUrl,
    scopes: req.body.scopes, tokenAuthMethod: req.body.tokenAuthMethod, clockTolerance: req.body.clockTolerance ?? current?.clock_tolerance,
    allowedAlgorithms: req.body.allowedAlgorithms ?? current?.allowed_algorithms, pkceEnabled: req.body.pkceEnabled, validateIdToken: req.body.validateIdToken,
    requireEmailVerified: req.body.requireEmailVerified, userinfoEmailPath: req.body.userinfoEmailPath,
    emailVerifiedPath: req.body.emailVerifiedPath ?? current?.email_verified_path, userinfoIdPath: req.body.userinfoIdPath,
    userinfoSecondaryIdPath: req.body.userinfoSecondaryIdPath ?? current?.userinfo_secondary_id_path,
    userinfoUsernamePath: req.body.userinfoUsernamePath, userinfoMethod, userinfoTokenIn,
    frontendCallbackPath: req.body.frontendCallbackPath ?? current?.frontend_callback_path
  });
  await refreshOidcProvidersFromDatabase();
  await recordAdminLog({ admin, req, action: 'upsert_oidc_provider', detail: providerKey });
  res.json({ provider: serializeAdminOidcProvider(oidcDatabaseRowToConfig(saved)) });
}));

app.delete('/api/admin/oidc/:providerKey', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  const providerKey = normalizeText(req.params.providerKey).toLowerCase();
  const existing = await OidcProvider.findByKey(providerKey);
  if (!existing) return res.status(404).json({ error: 'not_found', error_description: 'Provider 不存在' });
  await OidcProvider.delete(providerKey);
  await refreshOidcProvidersFromDatabase();
  await recordAdminLog({ admin, req, action: 'delete_oidc_provider', detail: providerKey });
  res.status(204).send();
}));

const SECURITY_TOGGLE_KEYS = {
  captchaLogin: 'captcha_login',
  captchaRegister: 'captcha_register',
  loginEmailCode: 'login_email_code',
  registrationEnabled: 'registration_enabled',
  totpAllowed: 'totp_allowed',
  passwordRequireMixed: 'password_require_mixed',
  anomalyDetection: 'anomaly_detection',
  huaweiPhoneAutolink: 'huawei_phone_autolink'
};

app.put('/api/admin/security', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;
  const changes = [];

  for (const [bodyKey, settingKey] of Object.entries(SECURITY_TOGGLE_KEYS)) {
    if (req.body[bodyKey] !== undefined) {
      if (![true, false, 'true', 'false'].includes(req.body[bodyKey])) {
        return res.status(400).json({ error: 'invalid_request', error_description: `${bodyKey} must be a boolean` });
      }
      changes.push([settingKey, req.body[bodyKey] === true || req.body[bodyKey] === 'true' ? 'true' : 'false']);
    }
  }

  if (req.body.passwordMinLength !== undefined) {
    const value = Number(req.body.passwordMinLength);
    if (!Number.isInteger(value) || value < 12 || value > 64) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'security.password_min_length.invalid',
        error_description: '密码最小长度必须是 12-64 之间的整数'
      });
    }
    changes.push(['password_min_length', String(value)]);
  }

  if (req.body.loginMaxAttempts !== undefined) {
    const value = Number(req.body.loginMaxAttempts);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'security.login_max_attempts.invalid',
        error_description: '登录失败次数上限必须是 1-100 之间的整数'
      });
    }
    changes.push(['login_max_attempts', String(value)]);
  }

  if (req.body.loginLockoutMinutes !== undefined) {
    const value = Number(req.body.loginLockoutMinutes);
    if (!Number.isInteger(value) || value < 1 || value > 1440) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'security.login_lockout_minutes.invalid',
        error_description: '锁定时长必须是 1-1440 之间的整数（分钟）'
      });
    }
    changes.push(['login_lockout_minutes', String(value)]);
  }

  await saveSettingValues(changes);
  await recordAdminLog({ admin, req, action: 'update_security_settings', detail: Object.keys(req.body).filter(key => req.body[key] !== undefined).join(',') });
  res.json({ message_key: 'security.saved', message: '安全设置已保存，立即生效' });
}));

app.get('/api/admin/security/logs', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  const logs = await LoginLog.findRecent(Number(req.query.limit) || 50);
  res.json(logs.map(log => ({
    id: log.id,
    username: log.username,
    ip: log.ip || '',
    userAgent: log.user_agent || '',
    result: log.result,
    detail: log.detail || '',
    createdAt: log.created_at || log.createdAt || null
  })));
}));

app.get('/api/tokens', asyncHandler(async (req, res) => {
  const user = await requireAdminUser(req, res);
  if (!user) {
    return;
  }

  const tokenList = await Token.findAllAccessTokens();
  res.json(tokenList.map(tokenData => ({
    id: tokenData.id,
    user: tokenData.user_id ? tokenData.user_name || tokenData.user_email || 'Unknown' : 'Application credentials',
    userEmail: tokenData.user_email || '',
    client: tokenData.client_name || tokenData.client_id || 'Unknown',
    clientId: tokenData.client_id || '',
    scopes: tokenData.scopes,
    createdAt: tokenData.created_at,
    expiresAt: tokenData.expires_at
  })));
}));

app.delete('/api/tokens/:id', asyncHandler(async (req, res) => {
  const user = await requireAdminUser(req, res);
  if (!user) {
    return;
  }

  const tokenId = normalizeText(req.params.id);
  const existing = await Token.findAccessTokenById(tokenId);
  if (!existing) {
    return res.status(404).json({
      error: 'not_found',
      error_key: 'tokens.not_found',
      error_description: 'Token not found'
    });
  }

  await Token.deleteAccessToken(tokenId);
  res.status(204).send();
}));



app.get('/', (req, res) => {
  res.redirect('/oauth2/authorize');
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.code === 'PHONE_UPDATE_NOT_PERSISTED') {
    console.error('Request failed:', err.code);
    return res.status(500).json({
      error: 'server_error', error_key: 'profile.phone.save_failed',
      error_description: '手机号保存未生效，请重试或联系管理员'
    });
  }
  const expectedStatus = [400, 413, 429, 502].includes(err.status) ? err.status : err.code === 'ER_DUP_ENTRY' ? 409 : 500;
  if (expectedStatus === 500) console.error('Request failed:', err.code || err.name);
  res.status(expectedStatus).json({
    error: expectedStatus === 500 ? 'server_error' : err.code === 'ER_DUP_ENTRY' ? 'conflict' : 'invalid_request',
    error_key: expectedStatus === 500 ? 'server.internal' : 'request.failed',
    error_description: expectedStatus === 500 ? '服务器内部错误' : expectedStatus === 413 ? '请求内容过大' : expectedStatus === 409 ? '记录已存在' : expectedStatus === 400 ? '请求格式无效' : err.message
  });
});

async function bootstrap({ databasePool, port = PORT, host = process.env.HOST || '127.0.0.1' } = {}) {
  if (databasePool && RUNTIME.nodeEnv !== 'test') throw new Error('Injected databases are only supported by isolated tests');
  adminSettingsOverrides = adminSettingsStore.load();
  turnstileSettings = adminSettingsOverrides.turnstile || { siteKey: RUNTIME.turnstileSiteKey, secretKey: RUNTIME.turnstileSecretKey };
  if (adminSettingsOverrides.smtp) applySmtpSettings(adminSettingsOverrides.smtp);
  signingKeys = loadSigningKeys();
  pool = databasePool || await initDatabase();
  User = new UserModel(pool);
  Authenticator = new AuthenticatorModel(pool);
  Client = new ClientModel(pool);
  Token = new TokenModel(pool);
  UserAppUsage = new UserAppUsageModel(pool);
  EmailVerificationCode = new EmailVerificationCodeModel(pool);
  ExternalIdentity = new ExternalIdentityModel(pool);
  LoginLog = new LoginLogModel(pool);
  Session = new SessionModel(pool);
  OidcProvider = new OidcProviderModel(pool);
  RateLimit = new RateLimitModel(pool);
  Captcha = new CaptchaModel(pool);
  await refreshOidcProvidersFromDatabase();
  await getSettingValue('registration_enabled');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once('error', reject);
  });
  const timer = setInterval(() => {
    Promise.all([Captcha.deleteExpired(), Session.deleteExpired(), RateLimit.deleteExpired(), Token.cleanExpiredTokens(), EmailVerificationCode.deleteExpired()])
      .catch(error => console.error('Expired credential cleanup failed:', error.code || error.name));
  }, 60 * 1000);
  timer.unref();
  return {
    server,
    async close() {
      clearInterval(timer);
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (databasePool) await databasePool.end();
      else await closePool();
    }
  };
}

if (require.main === module) {
  if (RUNTIME.nodeEnv === 'test') throw new Error('The test environment must be started by the isolated test runner');
  bootstrap().then(service => {
    console.log('Authentication service listening at ' + PUBLIC_BASE_URL);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => service.close().then(() => { process.exitCode = 0; }).catch(() => { process.exitCode = 1; }));
    }
  }).catch(async error => {
    console.error('Failed to start server:', error.message);
    await closePool();
    process.exitCode = 1;
  });
}

module.exports = { bootstrap };
