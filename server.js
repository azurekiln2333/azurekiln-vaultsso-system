require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

const { initDatabase, closePool } = require('./db/init');
const UserModel = require('./models/User');
const ClientModel = require('./models/Client');
const TokenModel = require('./models/Token');
const EmailVerificationCodeModel = require('./models/EmailVerificationCode');
const ExternalIdentityModel = require('./models/ExternalIdentity');
const LoginLogModel = require('./models/LoginLog');
const { sendVerificationEmail, getSmtpSettings, applySmtpSettings, sendTestEmail } = require('./services/email');

const app = express();

const PORT = Number(process.env.PORT || 3146);
const JWT_SECRET = process.env.JWT_SECRET || 'vaultsso-jwt-secret-key-2024-change-in-production';
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '1h';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').trim();
const SYSTEM_USER_EMAIL = 'system@vaultsso.local';
const SYSTEM_USER_USERNAME = 'system@vaultsso.local';
const USER_ROLE_ADMIN = 'admin';
const USER_ROLE_USER = 'user';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_ONLY_STATIC_PATHS = new Set(['/admin.html', '/apps.html', '/tokens.html', '/users.html', '/user.html', '/smtp.html', '/security.html']);
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const OIDC_CALLBACK_PATH = '/api/v1/auth/oauth/oidc/callback';
const OIDC_STATE_COOKIE = 'oidc_state';

let User;
let Client;
let Token;
let EmailVerificationCode;
let ExternalIdentity;
let LoginLog;
let pool = null;

const DEMO_CLIENTS = require('./config/demo-clients');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
  origin: true,
  credentials: true
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // SAMEORIGIN (not DENY): the admin center shell embeds admin pages from the same origin.
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https: http:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
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
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  return String(req.socket?.remoteAddress || '').slice(0, 64);
}

const SETTING_DEFAULTS = {
  captcha_login: 'false',
  captcha_register: 'false',
  login_email_code: 'false',
  registration_enabled: 'true',
  password_min_length: '6',
  login_max_attempts: '5',
  login_lockout_minutes: '15'
};
const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);
const settingCache = new Map();
const SETTING_CACHE_TTL_MS = 15 * 1000;

async function getSettingValue(key) {
  const cached = settingCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let value = SETTING_DEFAULTS[key];
  if (key === 'password_min_length') value = String(getSettingNumberFromEnv());
  try {
    const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
    if (rows.length && normalizeText(rows[0].setting_value) !== '') {
      value = normalizeText(rows[0].setting_value);
    }
  } catch (error) {
    // Missing table (fresh deployment before init-db) falls back to defaults.
  }

  settingCache.set(key, { value, expiresAt: Date.now() + SETTING_CACHE_TTL_MS });
  return value;
}

function getSettingNumberFromEnv() {
  const parsed = Number(process.env.PASSWORD_MIN_LENGTH);
  return Number.isInteger(parsed) && parsed >= 4 && parsed <= 64 ? parsed : 6;
}

async function saveSettingValue(key, value) {
  await pool.query(
    'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
    [key, String(value)]
  );
  settingCache.delete(key);
}

async function isSettingEnabled(key) {
  return (await getSettingValue(key)) === 'true';
}

async function getSettingNumber(key, fallback) {
  const parsed = Number(await getSettingValue(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function getPasswordMinLength() {
  return getSettingNumber('password_min_length', 6);
}

// --- CAPTCHA (self-hosted SVG; answers live in server memory, single use) ---
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const captchaStore = new Map();
const CAPTCHA_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function pruneCaptchaStore() {
  const now = Date.now();
  for (const [id, entry] of captchaStore) {
    if (entry.expiresAt < now) captchaStore.delete(id);
  }
}

function randomCaptchaText() {
  let text = '';
  for (let index = 0; index < 4; index++) {
    text += CAPTCHA_CHARS[crypto.randomInt(0, CAPTCHA_CHARS.length)];
  }
  return text;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function generateCaptchaSvg(text) {
  const width = 132;
  const height = 44;
  const colors = ['#0b57d0', '#2049c8', '#3b5bdb', '#1e3fae'];
  const glyphs = text.split('').map((char, index) => {
    const x = 18 + index * 27 + randomBetween(-3, 3);
    const y = 29 + randomBetween(-4, 4);
    const rotate = randomBetween(-18, 18).toFixed(1);
    const size = (21 + randomBetween(-2, 3)).toFixed(1);
    const fill = colors[crypto.randomInt(0, colors.length)];
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Verdana,Arial,sans-serif" font-size="${size}" font-weight="700" fill="${fill}" transform="rotate(${rotate} ${x.toFixed(1)} ${y.toFixed(1)})">${char}</text>`;
  }).join('');
  const lines = [0, 1, 2].map(() => {
    const x1 = randomBetween(0, width).toFixed(0);
    const y1 = randomBetween(0, height).toFixed(0);
    const x2 = randomBetween(0, width).toFixed(0);
    const y2 = randomBetween(0, height).toFixed(0);
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${colors[crypto.randomInt(0, colors.length)]}" stroke-opacity="0.35" stroke-width="1.5"/>`;
  }).join('');
  const dots = [0, 1, 2, 3, 4, 5].map(() => {
    return `<circle cx="${randomBetween(0, width).toFixed(0)}" cy="${randomBetween(0, height).toFixed(0)}" r="1.4" fill="#0b57d0" fill-opacity="0.35"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="captcha"><rect width="${width}" height="${height}" rx="8" fill="#f4f7ff"/>${lines}${dots}${glyphs}</svg>`;
}

app.get('/api/captcha', (req, res) => {
  pruneCaptchaStore();
  if (captchaStore.size > 5000) captchaStore.clear();
  const id = crypto.randomUUID();
  const text = randomCaptchaText();
  captchaStore.set(id, { text: text.toLowerCase(), expiresAt: Date.now() + CAPTCHA_TTL_MS });
  res.json({ id, svg: generateCaptchaSvg(text), expiresInMinutes: Math.ceil(CAPTCHA_TTL_MS / 60000) });
});

app.get('/api/auth/config', asyncHandler(async (req, res) => {
  res.json({
    captchaLogin: await isSettingEnabled('captcha_login'),
    captchaRegister: await isSettingEnabled('captcha_register'),
    loginEmailCode: await isSettingEnabled('login_email_code'),
    registrationEnabled: await isSettingEnabled('registration_enabled'),
    passwordMinLength: await getPasswordMinLength()
  });
}));

function verifyCaptcha(body) {
  const id = normalizeText(body.captcha_id);
  const code = normalizeText(body.captcha_code).toLowerCase();
  const entry = id ? captchaStore.get(id) : null;
  captchaStore.delete(id);
  if (!entry || entry.expiresAt < Date.now()) {
    return { ok: false, error_key: 'captcha.expired', error_description: '图形验证码已过期，请刷新后重试' };
  }
  if (!code || entry.text !== code) {
    return { ok: false, error_key: 'captcha.invalid', error_description: '图形验证码不正确' };
  }
  return { ok: true };
}

// --- Brute force lockout (per username + IP, in process memory) ---
const loginAttemptStore = new Map();
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
// Captcha grace: after captcha+password pass but email 2FA is pending, step 2 may resubmit.
const captchaGraceStore = new Map();
const CAPTCHA_GRACE_TTL_MS = 3 * 60 * 1000;

function pruneLoginAttempts() {
  const now = Date.now();
  for (const [key, entry] of loginAttemptStore) {
    if ((entry.lockedUntil && entry.lockedUntil < now) || (!entry.lockedUntil && now - entry.firstAt > LOGIN_ATTEMPT_WINDOW_MS)) {
      loginAttemptStore.delete(key);
    }
  }
  for (const [key, expiresAt] of captchaGraceStore) {
    if (expiresAt < now) captchaGraceStore.delete(key);
  }
}

function loginAttemptKey(username, ip) {
  return `${normalizeText(username).toLowerCase()}|${ip || 'unknown'}`;
}

function isLoginLocked(entry) {
  return Boolean(entry && entry.lockedUntil > Date.now());
}

function recordLoginFailure(key, maxAttempts, lockoutMs) {
  const now = Date.now();
  const entry = loginAttemptStore.get(key);
  if (!entry || now - entry.firstAt > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttemptStore.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + lockoutMs;
  }
}

function clearLoginAttempts(key) {
  loginAttemptStore.delete(key);
}

function maskEmail(email) {
  const text = normalizeText(email);
  const atIndex = text.indexOf('@');
  if (atIndex <= 0) return text;
  const local = text.slice(0, atIndex);
  const masked = local.length <= 2 ? `${local[0]}*` : `${local.slice(0, 2)}***`;
  return `${masked}${text.slice(atIndex)}`;
}

async function recordLoginLog({ username, userId = null, req, result }) {
  try {
    await LoginLog.create({
      username: username || '-',
      userId,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      result
    });
  } catch (error) {
    console.error('Failed to write login log:', error.message);
  }
}

setInterval(() => { pruneCaptchaStore(); pruneLoginAttempts(); }, 60 * 1000).unref();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getBaseUrl(req) {
  return PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
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
const EMAIL_CODE_TTL_MS = parseDurationToMs(process.env.EMAIL_CODE_EXPIRY || '10m', 10 * 60 * 1000);
const EMAIL_CODE_MAX_ATTEMPTS = Number(process.env.EMAIL_CODE_MAX_ATTEMPTS || 5);

const OIDC_CONFIG = {
  enabled: String(process.env.OIDC_ENABLED || '').trim().toLowerCase() === 'true',
  providerName: normalizeText(process.env.OIDC_PROVIDER_NAME) || 'OIDC',
  clientId: normalizeText(process.env.OIDC_CLIENT_ID),
  clientSecret: String(process.env.OIDC_CLIENT_SECRET || ''),
  issuerUrl: normalizeText(process.env.OIDC_ISSUER_URL),
  discoveryUrl: normalizeText(process.env.OIDC_DISCOVERY_URL),
  authorizeUrl: normalizeText(process.env.OIDC_AUTHORIZE_URL),
  tokenUrl: normalizeText(process.env.OIDC_TOKEN_URL),
  userinfoUrl: normalizeText(process.env.OIDC_USERINFO_URL),
  jwksUrl: normalizeText(process.env.OIDC_JWKS_URL),
  scopes: parseOidcScopes(process.env.OIDC_SCOPES || 'openid profile email'),
  tokenAuthMethod: normalizeText(process.env.OIDC_TOKEN_AUTH_METHOD) || 'client_secret_basic',
  clockTolerance: Number(process.env.OIDC_CLOCK_TOLERANCE || 60),
  allowedAlgorithms: toStringArray(process.env.OIDC_ALLOWED_ALGS || 'RS256 ES256').flatMap(item => item.split(/\s+/)).map(item => normalizeText(item)).filter(Boolean),
  pkceEnabled: String(process.env.OIDC_PKCE_ENABLED || 'true').trim().toLowerCase() !== 'false',
  validateIdToken: String(process.env.OIDC_VALIDATE_ID_TOKEN || 'true').trim().toLowerCase() !== 'false',
  requireEmailVerified: String(process.env.OIDC_REQUIRE_EMAIL_VERIFIED || '').trim().toLowerCase() === 'true',
  userinfoEmailPath: normalizeText(process.env.OIDC_USERINFO_EMAIL_PATH) || 'email',
  userinfoIdPath: normalizeText(process.env.OIDC_USERINFO_ID_PATH) || 'sub',
  userinfoUsernamePath: normalizeText(process.env.OIDC_USERINFO_USERNAME_PATH) || 'preferred_username',
  frontendCallbackPath: normalizeText(process.env.OIDC_FRONTEND_CALLBACK_PATH) || '/oauth2/success',
  providerKey: normalizeText(process.env.OIDC_PROVIDER_KEY) || normalizeText(process.env.OIDC_ISSUER_URL) || 'oidc',
  idTokenHmacSecret: String(process.env.OIDC_ID_TOKEN_HS_SECRET || process.env.OIDC_CLIENT_SECRET || ''),
  emailVerifiedPath: normalizeText(process.env.OIDC_USERINFO_EMAIL_VERIFIED_PATH) || 'email_verified'
};

function parseOidcProviders() {
  const raw = normalizeText(process.env.OIDC_PROVIDERS_JSON);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (error) {
    console.error('Invalid OIDC_PROVIDERS_JSON:', error.message);
    return {};
  }
}

const OIDC_PROVIDERS = parseOidcProviders();

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseOidcScopes(value) {
  return Array.from(new Set(['openid', ...parseRequestedScopes(value)]));
}

function getOidcProviderConfig(providerKey) {
  const key = normalizeText(providerKey).toLowerCase();
  if (!Object.keys(OIDC_PROVIDERS).length) return OIDC_CONFIG;
  const provider = key && OIDC_PROVIDERS[key];
  if (!key) return OIDC_CONFIG;
  if (!provider || typeof provider !== 'object') return null;
  return {
    ...OIDC_CONFIG,
    ...provider,
    providerKey: key,
    enabled: parseBoolean(provider.enabled, true),
    scopes: parseOidcScopes(provider.scopes || provider.scope || OIDC_CONFIG.scopes.join(' ')),
    allowedAlgorithms: toStringArray(provider.allowedAlgorithms || provider.allowedAlgs || OIDC_CONFIG.allowedAlgorithms.join(' ')).flatMap(item => item.split(/\s+/)).filter(Boolean),
    pkceEnabled: parseBoolean(provider.pkceEnabled, OIDC_CONFIG.pkceEnabled),
    validateIdToken: parseBoolean(provider.validateIdToken, OIDC_CONFIG.validateIdToken),
    requireEmailVerified: parseBoolean(provider.requireEmailVerified, OIDC_CONFIG.requireEmailVerified),
    tokenAuthMethod: normalizeText(provider.tokenAuthMethod) || OIDC_CONFIG.tokenAuthMethod,
    idTokenHmacSecret: String(provider.idTokenHmacSecret || provider.idTokenHsSecret || provider.clientSecret || OIDC_CONFIG.idTokenHmacSecret),
    userinfoEmailPath: normalizeText(provider.userinfoEmailPath) || OIDC_CONFIG.userinfoEmailPath,
    emailVerifiedPath: normalizeText(provider.emailVerifiedPath || provider.userinfoEmailVerifiedPath) || OIDC_CONFIG.emailVerifiedPath,
    userinfoIdPath: normalizeText(provider.userinfoIdPath) || OIDC_CONFIG.userinfoIdPath,
    userinfoUsernamePath: normalizeText(provider.userinfoUsernamePath) || OIDC_CONFIG.userinfoUsernamePath
  };
}

function getConfiguredOidcProviders() {
  const keys = Object.keys(OIDC_PROVIDERS);
  if (!keys.length) return isOidcEnabled(OIDC_CONFIG) ? [OIDC_CONFIG] : [];
  return keys.map(getOidcProviderConfig).filter(isOidcEnabled);
}

const OIDC_STATE_MAX_AGE = 10 * 60 * 1000;

function isOidcEnabled(config = OIDC_CONFIG) {
  return Boolean(config.enabled !== false && config.clientId && config.clientSecret &&
    (config.issuerUrl || config.discoveryUrl || config.authorizeUrl) &&
    (config.tokenUrl || config.discoveryUrl || config.issuerUrl) &&
    (!config.validateIdToken || config.issuerUrl || config.discoveryUrl));
}

function isHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
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
  if (!isHttpUrl(url)) throw new Error(`Invalid OIDC endpoint URL: ${url || '(empty)'}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(options.headers || {}) }
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error(`OIDC endpoint returned invalid JSON (${response.status})`);
    }
    if (!response.ok) throw new Error(payload.error_description || payload.error || `OIDC endpoint returned HTTP ${response.status}`);
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
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
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
  if (!config.validateIdToken) return decoded.payload;
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
    const jwk = keys.find(key => key.kid === decoded.header.kid && (!key.alg || key.alg === algorithm)) || (keys.length === 1 ? keys[0] : null);
    if (!jwk) throw new Error('No matching OIDC signing key was found');
    verificationKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } else if (!verificationKey) {
    throw new Error('OIDC HMAC validation secret is not configured');
  }
  const verified = jwt.verify(idToken, verificationKey, verifyOptions);
  if (nonce && verified.nonce !== nonce) throw new Error('OIDC nonce mismatch');
  return verified;
}

function appendQuery(pathname, params) {
  const query = new URLSearchParams(params);
  return `${pathname}${pathname.includes('?') ? '&' : '?'}${query.toString()}`;
}

function oidcErrorRedirect(state, message) {
  return appendQuery(getOidcReturnPath(state?.returnTo), {
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

async function findOrCreateOidcUser(claims, linkUserId = '', config = OIDC_CONFIG) {
  const provider = normalizeText(config.providerKey).toLowerCase();
  const providerUserId = normalizeText(claims.id);
  const email = normalizeEmail(claims.email);
  if (!providerUserId) throw new Error('OIDC account did not provide a subject identifier');

  const existingIdentity = await ExternalIdentity.findByProviderUserId(provider, providerUserId);
  if (existingIdentity) {
    const linkedUser = await User.findById(existingIdentity.user_id);
    if (!linkedUser) throw new Error('The linked local user no longer exists');
    if (linkUserId && existingIdentity.user_id !== linkUserId) {
      throw new Error('This third-party account is already linked to another user');
    }
    await ExternalIdentity.update(existingIdentity.id, {
      providerUsername: claims.username,
      displayName: claims.name,
      avatar: claims.picture,
      email: claims.email,
      profile: claims.profile
    });
    return linkedUser;
  }

  if (linkUserId) {
    const linkedUser = await User.findById(linkUserId);
    if (!linkedUser) throw new Error('The local account for this binding no longer exists');
    await ExternalIdentity.create({
      userId: linkedUser.id,
      provider,
      providerUserId,
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
  let existingUser = email && isValidEmail(email) && emailVerified ? await User.findByEmail(email) : null;
  if (!existingUser && email && isValidEmail(email) && !emailVerified) {
    const emailOwner = await User.findByEmail(email);
    if (emailOwner) {
      throw new Error('OIDC email is not verified; sign in locally before linking this account');
    }
  }
  if (existingUser) {
    await ExternalIdentity.create({
      userId: existingUser.id,
      provider,
      providerUserId,
      providerUsername: claims.username,
      displayName: claims.name,
      avatar: claims.picture,
      email,
      profile: claims.profile
    });
    return existingUser;
  }

  const localEmail = email && isValidEmail(email)
    ? email
    : `${provider}-${crypto.createHash('sha256').update(providerUserId).digest('hex').slice(0, 24)}@users.invalid`;
  const usernameBase = (claims.username || (email ? email.split('@')[0] : '') || 'oidc-user').slice(0, 220);
  let username = usernameBase;
  let suffix = 0;
  while ((await User.findByUsername(username)) && suffix < 20) {
    suffix += 1;
    username = `${usernameBase}-${suffix}`;
  }
  const user = await User.create({ username, email: localEmail, password: crypto.randomBytes(32).toString('base64url'), name: claims.name || claims.username || email || username, avatar: claims.picture || '', emailVerified });
  await ExternalIdentity.create({
    userId: user.id,
    provider,
    providerUserId,
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
    createdAt: user.createdAt || user.created_at || null,
    updatedAt: user.updatedAt || user.updated_at || null
  };
}

function validateToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

function createSessionToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: normalizeText(user.role).toLowerCase() || 'user' },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function sessionCookieOptions() {
  const options = {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE
  };
  if (COOKIE_DOMAIN) {
    options.domain = COOKIE_DOMAIN;
  }
  return options;
}

function setSessionCookie(res, user) {
  res.cookie('session', createSessionToken(user), sessionCookieOptions());
}

async function getAuthenticatedUser(req, res = null) {
  const sessionToken = req.cookies.session;
  if (!sessionToken) {
    return null;
  }

  const session = validateToken(sessionToken);
  if (!session) {
    return null;
  }

  const user = await User.findById(session.sub);
  if (!user || isUserBanned(user)) {
    return null;
  }

  return user;


  // 滑动续期：会话签发时长超过阈值一半时重发 session cookie，避免活跃用户被登出
  if (res && Number(session.iat) * 1000 < Date.now() - SESSION_REFRESH_THRESHOLD_MS) {
    setSessionCookie(res, user);
  }
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

function isValidPkceChallenge(value) {
  return CODE_CHALLENGE_PATTERN.test(normalizeText(value));
}

function normalizePkceMethod(value) {
  const method = normalizeText(value) || 'plain';
  return method.toUpperCase() === 'S256' ? 'S256' : method.toLowerCase();
}

function verifyPkceChallenge(authCodeData, codeVerifier) {
  const codeChallenge = normalizeText(authCodeData.code_challenge);
  if (!codeChallenge) {
    return true;
  }

  const verifier = normalizeText(codeVerifier);
  if (!CODE_CHALLENGE_PATTERN.test(verifier)) {
    return false;
  }

  const method = normalizePkceMethod(authCodeData.code_challenge_method);
  if (method === 'S256') {
    const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (digest.length !== codeChallenge.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(codeChallenge));
  }

  if (verifier.length !== codeChallenge.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(verifier), Buffer.from(codeChallenge));
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
    id_token_signing_alg_values_supported: ['HS256'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
    code_challenge_methods_supported: ['plain', 'S256'],
    claims_supported: ['sub', 'name', 'preferred_username', 'username', 'email', 'email_verified', 'picture', 'updated_at'],
    introspection_endpoint: `${baseUrl}/oauth2/introspect`,
    revocation_endpoint: `${baseUrl}/oauth2/revoke`,
    service_documentation: `${baseUrl}/api-docs.html`,
    ui_locales_supported: ['zh-CN', 'zh-TW', 'en']
  };
}

function parseClientCredentials(req) {
  const authHeader = normalizeText(req.headers.authorization);
  if (authHeader.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator >= 0) {
        return {
          clientId: decoded.slice(0, separator),
          clientSecret: decoded.slice(separator + 1),
          method: 'client_secret_basic'
        };
      }
    } catch (error) {
      return { clientId: '', clientSecret: '', method: 'client_secret_basic' };
    }
  }

  return {
    clientId: normalizeText(req.body.client_id),
    clientSecret: normalizeText(req.body.client_secret),
    method: 'client_secret_post'
  };
}

async function authenticateClient(req, res) {
  const credentials = parseClientCredentials(req);
  if (!credentials.clientId || !credentials.clientSecret) {
    res.status(401).json({
      error: 'invalid_client',
      error_key: 'oauth.client.credentials.required',
      error_description: 'Client authentication is required'
    });
    return null;
  }

  const client = await Client.findById(credentials.clientId);
  if (!client || client.secret !== credentials.clientSecret) {
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

app.use(express.static(PUBLIC_DIR));

function serializeClient(client) {
  return {
    id: client.id,
    name: client.name,
    logoUrl: client.logo_url || '',
    isActive: Boolean(client.is_active),
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
  const requireSecret = options.requireSecret === true;
  const clientId = normalizeText(body.id);
  const name = normalizeText(body.name);
  const secret = normalizeText(body.secret);
  const logoUrl = normalizeText(body.logoUrl);
  const redirectUris = toStringArray(body.redirectUris);
  const scopes = toStringArray(body.scopes);
  const isActive = body.isActive !== undefined ? Boolean(body.isActive) : true;

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
      new URL(redirectUri);
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
      new URL(logoUrl);
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
      isActive
    }
  };
}

async function findUserConflicts({ username, email, excludeUserId }) {
  const users = await User.findAll();
  const normalizedUsername = normalizeText(username).toLowerCase();
  const normalizedEmail = normalizeEmail(email);

  let usernameConflict = null;
  let emailConflict = null;

  for (const user of users) {
    if (excludeUserId && user.id === excludeUserId) {
      continue;
    }

    if (!usernameConflict && normalizedUsername && user.username.toLowerCase() === normalizedUsername) {
      usernameConflict = user;
    }

    if (!emailConflict && normalizedEmail && user.email.toLowerCase() === normalizedEmail) {
      emailConflict = user;
    }
  }

  return { usernameConflict, emailConflict };
}

function normalizeEmailPurpose(value) {
  const purpose = normalizeText(value).toLowerCase();
  return [EMAIL_PURPOSE_REGISTER, EMAIL_PURPOSE_PASSWORD_RESET, EMAIL_PURPOSE_LOGIN].includes(purpose) ? purpose : '';
}

function generateEmailCode() {
  const devCode = normalizeText(process.env.EMAIL_DEV_CODE);
  if (process.env.NODE_ENV !== 'production' && /^\d{6}$/.test(devCode)) {
    return devCode;
  }

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
  const code = generateEmailCode();
  await EmailVerificationCode.deleteExpired();
  await EmailVerificationCode.create({
    email,
    purpose,
    userId,
    codeHash: hashEmailCode(email, purpose, code),
    expiresAt: getEmailCodeExpiresAt()
  });

  return sendVerificationEmail({
    to: email,
    code,
    purpose,
    expiresInMinutes: getEmailCodeExpiryMinutes()
  });
}

async function verifyEmailCode({ email, purpose, code }) {
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
  if (!record) {
    return {
      ok: false,
      status: 400,
      error_key: 'email_code.expired',
      error_description: '验证码不存在或已过期'
    };
  }

  if (Number(record.attempts || 0) >= EMAIL_CODE_MAX_ATTEMPTS) {
    return {
      ok: false,
      status: 429,
      error_key: 'email_code.too_many_attempts',
      error_description: '验证码尝试次数过多，请重新获取'
    };
  }

  if (record.code_hash !== hashEmailCode(email, purpose, normalizedCode)) {
    await EmailVerificationCode.incrementAttempts(record.id);
    return {
      ok: false,
      status: 400,
      error_key: 'email_code.invalid',
      error_description: '验证码不正确'
    };
  }

  await EmailVerificationCode.consume(record.id);
  return { ok: true };
}

async function generateAccessToken(userId, clientId, scopes) {
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS);
  const token = jwt.sign({
    sub: userId,
    aud: clientId,
    scope: scopes.join(' '),
    jti: tokenId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000)
  }, JWT_SECRET);

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
    jti: tokenId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000)
  }, JWT_SECRET);

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

async function buildAuthorizationResponse(user, params) {
  const clientId = normalizeText(params.client_id);
  const redirectUri = normalizeText(params.redirect_uri);
  const scopeValue = normalizeText(params.scope);
  const state = normalizeText(params.state);

  if (clientId || redirectUri) {
    if (!clientId || !redirectUri) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          error_key: 'auth.request.missing_pair',
          error_description: 'client_id 和 redirect_uri 必须同时提供'
        }
      };
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return {
        status: 400,
        body: {
          error: 'invalid_client',
          error_key: 'auth.request.unknown_client',
          error_description: `未知客户端：${clientId}`
        }
      };
    }

    if (!client.redirectUris.includes(redirectUri)) {
      return {
        status: 400,
        body: {
          error: 'invalid_redirect_uri',
          error_key: 'auth.request.invalid_redirect_uri',
          error_description: '无效的回调地址'
        }
      };
    }

    const authCodeData = await Token.createAuthCode({
      userId: user.id,
      clientId,
      redirectUri,
      scopes: scopeValue ? scopeValue.split(' ') : ['openid'],
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', authCodeData.code);
    if (state) {
      redirectUrl.searchParams.set('state', state);
    }

    return {
      status: 200,
      body: {
        redirect: redirectUrl.toString()
      }
    };
  }

  return {
    status: 200,
    body: {
      message_key: 'auth.login_success',
      message: '登录成功'
    }
  };
}

async function buildAuthorizationResponseV2(user, params) {
  const clientId = normalizeText(params.client_id);
  const redirectUri = normalizeText(params.redirect_uri);
  const scopeValue = normalizeText(params.scope);
  const state = normalizeText(params.state);
  const responseType = normalizeText(params.response_type) || 'code';
  const codeChallenge = normalizeText(params.code_challenge);
  const codeChallengeMethod = normalizePkceMethod(params.code_challenge_method);

  if (!clientId && !redirectUri) {
    return {
      status: 200,
      body: {
        message_key: 'auth.login_success',
        message: 'Login successful',
        redirect: '/profile'
      }
    };
  }

  if (!clientId || !redirectUri) {
    return {
      status: 400,
      body: {
        error: 'invalid_request',
        error_key: 'auth.request.missing_pair',
        error_description: 'client_id and redirect_uri must be provided together'
      }
    };
  }

  if (responseType !== 'code') {
    return {
      status: 400,
      body: {
        error: 'unsupported_response_type',
        error_key: 'auth.request.response_type',
        error_description: 'Only response_type=code is supported'
      }
    };
  }

  if (codeChallenge) {
    if (!isValidPkceChallenge(codeChallenge)) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          error_key: 'auth.request.pkce.challenge',
          error_description: 'code_challenge must be 43-128 URL-safe characters'
        }
      };
    }

    if (!['plain', 'S256'].includes(codeChallengeMethod)) {
      return {
        status: 400,
        body: {
          error: 'invalid_request',
          error_key: 'auth.request.pkce.method',
          error_description: 'code_challenge_method must be plain or S256'
        }
      };
    }
  }

  const client = await Client.findById(clientId);
  if (!client) {
    return {
      status: 400,
      body: {
        error: 'invalid_client',
        error_key: 'auth.request.unknown_client',
        error_description: `Unknown client: ${clientId}`
      }
    };
  }

  if (!isClientActive(client)) {
    return {
      status: 403,
      body: {
        error: 'access_denied',
        error_key: 'oauth.client.inactive',
        error_description: 'Client is disabled'
      }
    };
  }

  if (!client.redirectUris.includes(redirectUri)) {
    return {
      status: 400,
      body: {
        error: 'invalid_redirect_uri',
        error_key: 'auth.request.invalid_redirect_uri',
        error_description: 'Invalid redirect URI'
      }
    };
  }

  const requestedScopes = parseRequestedScopes(scopeValue);
  const unsupportedScopes = findUnsupportedScopes(requestedScopes, client.scopes);
  if (unsupportedScopes.length) {
    return {
      status: 400,
      body: {
        error: 'invalid_scope',
        error_key: 'auth.request.invalid_scope',
        error_description: `Unsupported scope: ${unsupportedScopes.join(' ')}`
      }
    };
  }

  const authCodeData = await Token.createAuthCode({
    userId: user.id,
    clientId,
    redirectUri,
    scopes: requestedScopes,
    codeChallenge,
    codeChallengeMethod: codeChallenge ? codeChallengeMethod : '',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set('code', authCodeData.code);
  if (state) {
    redirectUrl.searchParams.set('state', state);
  }

  return {
    status: 200,
    body: {
      redirect: redirectUrl.toString()
    }
  };
}

async function ensureSystemUser() {
  const existing = await User.findByEmail(SYSTEM_USER_EMAIL);
  if (existing) {
    return existing;
  }

  return User.create({
    username: SYSTEM_USER_USERNAME,
    email: SYSTEM_USER_EMAIL,
    password: crypto.randomUUID(),
    name: 'VaultSSO System',
    avatar: '',
    emailVerified: true,
    role: USER_ROLE_USER
  });
}

async function seedMemoryDemoData() {
  if (String(process.env.DB_DRIVER || '').trim().toLowerCase() !== 'memory') {
    return;
  }

  const existingDemoUser = await User.findByEmail('demo@vaultsso.com');
  if (!existingDemoUser) {
    await User.create({
      username: 'demo@vaultsso.com',
      email: 'demo@vaultsso.com',
      password: 'demo123',
      name: 'Alexander Chen',
      avatar: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAeJvKl7fU1iqZh6zOZs1aafVqUuYiG5yITDbH2UYR4RvaLznuMOqj8sGGOh1goH16sh4Jq75d9IeEbhUtLzk8V_ShUGkRIRYsEqo47Ads_1pw_6ySjt3T4vIDRjraWDGUoLRxXLVv7EFVRgKp9Mjfa4sHjuoM9MM5o2VIPg0rF66x0vP9_zEV3twEjYqDi1fMs_24JUSsFwuNUa7Kdjm6U7EfrzZzUMwm4IGtYm7pSX12FASsT6BxFQxtLiP-qzQ-YOymo-NhULTCI',
      emailVerified: true,
      role: USER_ROLE_ADMIN
    });
  }

  for (const clientData of DEMO_CLIENTS) {
    const existingClient = await Client.findById(clientData.id);
    if (!existingClient) {
      await Client.create(clientData);
    }
  }
}

app.get('/.well-known/openid-configuration', (req, res) => {
  res.json(buildAuthorizationServerMetadata(getBaseUrl(req)));
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(buildAuthorizationServerMetadata(getBaseUrl(req)));
});

app.get('/.well-known/jwks.json', (req, res) => {
  res.json({
    keys: [],
    note: 'This provider signs tokens with HS256 using the configured shared secret. No public keys are exposed.'
  });
});

app.get('/oauth2/authorize', asyncHandler(async (req, res) => {
  const clientId = normalizeText(req.query.client_id);
  const redirectUri = normalizeText(req.query.redirect_uri);
  const scope = normalizeText(req.query.scope);
  const state = normalizeText(req.query.state);

  if (clientId || redirectUri) {
    if (!clientId || !redirectUri) {
      return res.redirect(`/oauth2/error?error=invalid_request&error_description=${encodeURIComponent('client_id 和 redirect_uri 必须同时提供')}`);
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.redirect(`/oauth2/error?error=invalid_client&error_description=${encodeURIComponent(`未知客户端：${clientId}`)}&state=${state || ''}`);
    }

    if (!client.redirectUris.includes(redirectUri)) {
      return res.redirect(`/oauth2/error?error=invalid_redirect_uri&error_description=${encodeURIComponent('无效的回调地址')}&state=${state || ''}`);
    }

    const user = await getAuthenticatedUser(req, res);
    if (user) {
      const result = await buildAuthorizationResponseV2(user, {
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state,
        response_type: req.query.response_type,
        code_challenge: req.query.code_challenge,
        code_challenge_method: req.query.code_challenge_method
      });
      return res.redirect(result.body.redirect);
    }
  }

  res.sendFile(path.join(__dirname, 'authorize.html'));
}));

app.get('/login', (req, res) => {
  res.redirect('/oauth2/authorize');
});

app.get('/api/v1/auth/oauth/oidc/login', asyncHandler(async (req, res) => {
  const config = getOidcProviderConfig(req.query.provider);
  if (!config || !isOidcEnabled(config)) {
    return res.status(503).json({
      error: 'oidc_not_configured',
      error_description: 'OIDC login is not configured'
    });
  }

  const endpoints = await resolveOidcEndpoints(config);
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(32).toString('base64url');
  const stateData = {
    state,
    nonce,
    returnTo: getOidcReturnPath(req.query.return_to),
    createdAt: Date.now(),
    linkUserId: (await getAuthenticatedUser(req))?.id || '',
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
    secure: req.secure || req.get('x-forwarded-proto') === 'https',
    sameSite: 'lax',
    maxAge: OIDC_STATE_MAX_AGE
  });
  return res.redirect(`${endpoints.authorizeUrl}${endpoints.authorizeUrl.includes('?') ? '&' : '?'}${new URLSearchParams(authorizeParams).toString()}`);
}));

app.get('/api/v1/auth/oauth/oidc/config', (req, res) => {
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
});

app.get(OIDC_CALLBACK_PATH, asyncHandler(async (req, res) => {
  const cookieState = decodeOidcState(req.cookies[OIDC_STATE_COOKIE]);
  res.clearCookie(OIDC_STATE_COOKIE);
  const queryState = normalizeText(req.query.state);
  const stateIsValid = cookieState && queryState && cookieState.state === queryState &&
    Number(cookieState.createdAt) + OIDC_STATE_MAX_AGE >= Date.now();

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
    const config = getOidcProviderConfig(cookieState.provider);
    if (!config || !isOidcEnabled(config)) throw new Error('OIDC provider is no longer configured');
    const endpoints = await resolveOidcEndpoints(config);
    const tokenPayload = await exchangeOidcCode(code, cookieState.codeVerifier, endpoints, getOidcCallbackUrl(req), config);
    if (config.validateIdToken && !tokenPayload.id_token) {
      throw new Error('OIDC token response did not include an ID Token');
    }
    const idTokenClaims = tokenPayload.id_token
      ? await verifyOidcIdToken(tokenPayload.id_token, endpoints, cookieState.nonce, config)
      : {};
    let userinfoClaims = {};
    if (endpoints.userinfoUrl && tokenPayload.access_token) {
      userinfoClaims = await fetchJson(endpoints.userinfoUrl, {
        headers: { Authorization: `Bearer ${tokenPayload.access_token}` }
      });
    }

    const userinfoId = claimText(userinfoClaims, config.userinfoIdPath);
    const idTokenId = claimText(idTokenClaims, 'sub');
    if (userinfoId && idTokenId && userinfoId !== idTokenId) {
      throw new Error('OIDC UserInfo subject does not match the ID Token subject');
    }
    const claims = {
      id: userinfoId || idTokenId,
      email: claimText(userinfoClaims, config.userinfoEmailPath) || claimText(idTokenClaims, config.userinfoEmailPath) || claimText(idTokenClaims, 'email'),
      emailVerified: claimBoolean(userinfoClaims, config.emailVerifiedPath) || claimBoolean(idTokenClaims, config.emailVerifiedPath) || claimBoolean(idTokenClaims, 'email_verified'),
      username: claimText(userinfoClaims, config.userinfoUsernamePath) || claimText(idTokenClaims, config.userinfoUsernamePath) || claimText(idTokenClaims, 'preferred_username'),
      name: claimText(userinfoClaims, 'name') || claimText(idTokenClaims, 'name'),
      picture: claimText(userinfoClaims, 'picture') || claimText(idTokenClaims, 'picture'),
      profile: { ...idTokenClaims, ...userinfoClaims }
    };
    if (!claims.id) throw new Error('OIDC account did not provide a subject identifier');
    const user = await findOrCreateOidcUser(claims, cookieState.linkUserId, config);
    if (isUserBanned(user)) {
      return res.redirect(oidcErrorRedirect(cookieState, '账户已被封禁，请联系管理员'));
    }
    await User.update(user.id, { lastLoginIp: getClientIp(req) });
    setSessionCookie(res, user);
    return res.redirect(getOidcReturnPath(cookieState.returnTo));
  } catch (error) {
    console.error('OIDC callback failed:', error.message);
    return res.redirect(oidcErrorRedirect(cookieState, error.message));
  }
}));

app.post('/oauth2/authorize', asyncHandler(async (req, res) => {
  const username = normalizeText(req.body.username);
  const password = String(req.body.password || '');
  const ip = getClientIp(req);
  const attemptKey = loginAttemptKey(username, ip);

  const maxAttempts = await getSettingNumber('login_max_attempts', 5);
  const lockoutMinutes = await getSettingNumber('login_lockout_minutes', 15);
  const lockedEntry = loginAttemptStore.get(attemptKey);
  if (isLoginLocked(lockedEntry)) {
    const minutes = Math.max(1, Math.ceil((lockedEntry.lockedUntil - Date.now()) / 60000));
    await recordLoginLog({ username, req, result: 'locked' });
    return res.status(429).json({
      error: 'too_many_attempts',
      error_key: 'auth.locked',
      error_description: `登录失败次数过多，请 ${minutes} 分钟后再试`
    });
  }

  // The captcha grace window only covers the email-code resubmission (step 2),
  // which carries the code from the request that already passed the captcha.
  // A fresh login must always pass the captcha, even within the grace window.
  const submittedEmailCode = normalizeText(req.body.email_code);
  const loginCaptchaGrace = captchaGraceStore.get(attemptKey) > Date.now();
  const captchaSkipped = loginCaptchaGrace && Boolean(submittedEmailCode);
  if ((await isSettingEnabled('captcha_login')) && !captchaSkipped) {
    const captcha = verifyCaptcha(req.body);
    if (!captcha.ok) {
      await recordLoginLog({ username, req, result: 'captcha_failed' });
      return res.status(400).json({
        error: 'invalid_request',
        error_key: captcha.error_key,
        error_description: captcha.error_description
      });
    }
  }

  const user = await User.findByUsername(username);

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

  if (!user || !user.password || !await bcrypt.compare(password, user.password)) {
    recordLoginFailure(attemptKey, maxAttempts, lockoutMinutes * 60 * 1000);
    const entry = loginAttemptStore.get(attemptKey);
    const remaining = maxAttempts - (entry ? entry.count : 1);
    await recordLoginLog({ username, userId: user?.id || null, req, result: 'invalid_credentials' });
    return res.status(401).json({
      error: 'invalid_grant',
      error_key: 'auth.invalid_credentials',
      error_description: '用户名或密码错误'
        + (remaining > 0 && remaining <= 2 ? `，还可尝试 ${remaining} 次` : '')
    });
  }

  if (await isSettingEnabled('login_email_code')) {
    const emailCode = submittedEmailCode;
    if (!emailCode) {
      try {
        await issueEmailVerificationCode({ email: user.email, purpose: EMAIL_PURPOSE_LOGIN, userId: user.id });
      } catch (error) {
        console.error('Failed to send login code:', error.message);
        return res.status(502).json({
          error: 'email_delivery_failed',
          error_key: 'smtp.test_failed',
          error_description: '验证码邮件发送失败，请稍后再试或联系管理员检查发件设置'
        });
      }
      await recordLoginLog({ username, userId: user.id, req, result: 'email_code_required' });
      captchaGraceStore.set(attemptKey, Date.now() + CAPTCHA_GRACE_TTL_MS);
      return res.json({
        require_email_code: true,
        email_masked: maskEmail(user.email),
        message_key: 'auth.login_code.sent',
        message: `验证码已发送至邮箱 ${maskEmail(user.email)}，请输入以完成登录`
      });
    }

    const verification = await verifyEmailCode({ email: user.email, purpose: EMAIL_PURPOSE_LOGIN, code: emailCode });
    if (!verification.ok) {
      await recordLoginLog({ username, userId: user.id, req, result: 'email_code_invalid' });
      return res.status(verification.status).json({
        error: 'invalid_request',
        error_key: verification.error_key,
        error_description: verification.error_description
      });
    }
  }

  clearLoginAttempts(attemptKey);
  captchaGraceStore.delete(attemptKey);
  await User.update(user.id, { lastLoginIp: ip });
  await recordLoginLog({ username, userId: user.id, req, result: 'success' });
  setSessionCookie(res, user);

  const result = await buildAuthorizationResponseV2(user, req.body);
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

  if (!purpose) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'email_code.purpose.invalid',
      error_description: '验证码用途无效'
    });
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
    const captcha = verifyCaptcha(req.body);
    if (!captcha.ok) {
      return res.status(400).json({
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
  const passwordMinLength = await getPasswordMinLength();

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

  if (password.length < passwordMinLength) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.password.min_length',
      error_description: `密码长度不能少于 ${passwordMinLength} 位`
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

  setSessionCookie(res, user);

  const result = await buildAuthorizationResponseV2(user, req.body);
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

  if (password.length < await getPasswordMinLength()) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.password.min_length',
      error_description: `密码长度不能少于 ${await getPasswordMinLength()} 位`
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
    code: emailCode
  });

  if (!verification.ok) {
    return res.status(verification.status).json({
      error: 'invalid_request',
      error_key: verification.error_key,
      error_description: verification.error_description
    });
  }

  await User.updatePassword(user.id, password);
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

    if (newPassword.length < await getPasswordMinLength()) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.password.min_length',
        error_description: `新密码长度不能少于 ${await getPasswordMinLength()} 位`
      });
    }

    await User.updatePassword(currentUser.id, newPassword);
  }

  await User.update(currentUser.id, {
    name: nextName,
    username: nextUsername,
    email: nextEmail,
    avatar: nextAvatar,
    description: nextDescription
  });

  const updatedUser = await User.findById(currentUser.id);
  setSessionCookie(res, updatedUser);

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

    if (redirectUri && authCodeData.redirect_uri !== redirectUri) {
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

    await Token.deleteAuthCode(code);

    const accessToken = await generateAccessToken(authCodeData.user_id, clientId, authCodeData.scopes);
    const newRefreshToken = authCodeData.scopes.includes('offline_access')
      ? await generateRefreshToken(authCodeData.user_id, clientId, authCodeData.scopes)
      : '';

    const idToken = jwt.sign({
      sub: user.id,
      email: user.email,
      name: user.name,
      preferred_username: user.username,
      username: user.username,
      picture: user.avatar,
      aud: clientId,
      iss: getBaseUrl(req),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((Date.now() + ACCESS_TOKEN_TTL_MS) / 1000)
    }, JWT_SECRET);

    const responseBody = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      id_token: idToken,
      scope: authCodeData.scopes.join(' ')
    };

    if (newRefreshToken) {
      responseBody.refresh_token = newRefreshToken;
    }

    return res.json(responseBody);
  }

  if (grantType === 'refresh_token') {
    const decoded = validateToken(refreshToken);
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
    if (!refreshTokenData || new Date(refreshTokenData.expires_at) < new Date()) {
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

    const refreshedScopes = Array.isArray(refreshTokenData.scopes) && refreshTokenData.scopes.length
      ? refreshTokenData.scopes
      : ['openid', 'profile', 'email'];
    const accessToken = await generateAccessToken(decoded.sub, clientId, refreshedScopes);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: refreshedScopes.join(' ')
    });
  }

  if (grantType === 'client_credentials') {
    const requestedScopes = scopeParam ? parseRequestedScopes(scopeParam) : ['client'];
    const unsupportedScopes = scopeParam ? findUnsupportedScopes(requestedScopes, client.scopes) : [];

    if (unsupportedScopes.length) {
      return res.status(400).json({
        error: 'invalid_scope',
        error_key: 'oauth.scope.invalid',
        error_description: `Unsupported scope: ${unsupportedScopes.join(' ')}`
      });
    }

    const systemUser = await ensureSystemUser();
    const accessToken = await generateAccessToken(systemUser.id, clientId, requestedScopes);

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
  const decoded = validateToken(token);
  if (!decoded) {
    return res.status(401).json({
      error: 'invalid_token',
      error_key: 'auth.token.invalid_or_expired',
      error_description: '令牌无效或已过期'
    });
  }

  const tokenData = await Token.findAccessTokenById(decoded.jti);
  if (!tokenData || new Date(tokenData.expires_at) < new Date()) {
    return res.status(401).json({
      error: 'invalid_token',
      error_key: 'auth.token.invalid_or_expired',
      error_description: '令牌无效或已过期'
    });
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

  res.json({
    sub: user.id,
    name: user.name,
    preferred_username: user.username,
    username: user.username,
    email: user.email,
    picture: user.avatar,
    email_verified: Boolean(user.email_verified),
    updated_at: Math.floor(new Date(user.updated_at || Date.now()).getTime() / 1000)
  });
}));

app.post('/oauth2/introspect', asyncHandler(async (req, res) => {
  const client = await authenticateClient(req, res);
  if (!client) {
    return;
  }

  const decoded = validateToken(normalizeText(req.body.token));
  if (!decoded) {
    return res.json({ active: false });
  }

  const tokenData = await Token.findAccessTokenById(decoded.jti);
  if (!tokenData || tokenData.client_id !== client.id || new Date(tokenData.expires_at) < new Date()) {
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

  const decoded = validateToken(normalizeText(req.body.token));

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
  res.sendFile(path.join(__dirname, 'consent.html'));
});

app.get('/oauth2/error', (req, res) => {
  res.sendFile(path.join(__dirname, 'error.html'));
});

app.get(['/success', '/oauth2/success'], (req, res) => {
  res.sendFile(path.join(__dirname, 'success.html'));
});

app.get('/profile', asyncHandler(async (req, res) => {
  const user = await getAuthenticatedUser(req, res);
  if (!user) {
    return res.redirect('/oauth2/authorize');
  }

  res.sendFile(path.join(__dirname, 'profile.html'));
}));

app.get('/oauth2/logout', (req, res) => {
  res.clearCookie('session', COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : undefined);
  const target = resolveLogoutRedirect(req.query.redirect);
  res.redirect(target || '/oauth2/authorize');
});

app.get('/api/account/identities', asyncHandler(async (req, res) => {
  const user = await requireAuthenticatedUser(req, res);
  if (!user) return;

  const identities = await ExternalIdentity.findByUserId(user.id);
  res.json({ identities: ExternalIdentity.serializeMany(identities) });
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
    const emailConflict = await User.findByEmail(email);
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
    if (password && password.length < await getPasswordMinLength()) {
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
    if (await User.findByEmail(email)) {
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
    id: clientId
  }, {
    requireId: false,
    requireSecret: false
  });
  if (!validated.ok) {
    return res.status(validated.status).json(validated.body);
  }

  const updated = await Client.update(clientId, {
    name: validated.value.name,
    secret: validated.value.secret || undefined,
    redirectUris: validated.value.redirectUris,
    scopes: validated.value.scopes,
    logoUrl: validated.value.logoUrl,
    isActive: validated.value.isActive
  });

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

  applySmtpSettings({
    host,
    port,
    user: req.body.user,
    password: req.body.password,
    from: req.body.from
  });

  res.json({ ...getSmtpSettings(), message_key: 'smtp.saved', message: '发件设置已保存（运行时生效，重启后以 .env 为准）' });
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

app.get('/api/admin/security', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  res.json({
    captchaLogin: (await getSettingValue('captcha_login')) === 'true',
    captchaRegister: (await getSettingValue('captcha_register')) === 'true',
    loginEmailCode: (await getSettingValue('login_email_code')) === 'true',
    registrationEnabled: (await getSettingValue('registration_enabled')) === 'true',
    passwordMinLength: await getSettingNumber('password_min_length', 6),
    loginMaxAttempts: await getSettingNumber('login_max_attempts', 5),
    loginLockoutMinutes: await getSettingNumber('login_lockout_minutes', 15)
  });
}));

const SECURITY_TOGGLE_KEYS = {
  captchaLogin: 'captcha_login',
  captchaRegister: 'captcha_register',
  loginEmailCode: 'login_email_code',
  registrationEnabled: 'registration_enabled'
};

app.put('/api/admin/security', asyncHandler(async (req, res) => {
  const admin = await requireAdminUser(req, res);
  if (!admin) return;

  for (const [bodyKey, settingKey] of Object.entries(SECURITY_TOGGLE_KEYS)) {
    if (req.body[bodyKey] !== undefined) {
      await saveSettingValue(settingKey, req.body[bodyKey] === true || req.body[bodyKey] === 'true' ? 'true' : 'false');
    }
  }

  if (req.body.passwordMinLength !== undefined) {
    const value = Number(req.body.passwordMinLength);
    if (!Number.isInteger(value) || value < 4 || value > 64) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'security.password_min_length.invalid',
        error_description: '密码最小长度必须是 4-64 之间的整数'
      });
    }
    await saveSettingValue('password_min_length', String(value));
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
    await saveSettingValue('login_max_attempts', String(value));
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
    await saveSettingValue('login_lockout_minutes', String(value));
  }

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
    user: tokenData.user_name || tokenData.user_email || 'Unknown',
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

app.get('/callback', (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <h1>OAuth2 Error</h1>
      <p><strong>Error:</strong> ${error}</p>
      <p><strong>Description:</strong> ${error_description || 'N/A'}</p>
      <a href="/oauth2/authorize">Back to Sign In</a>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>OAuth2 Callback</title>
      <style>
        body {
          font-family: 'Inter', sans-serif;
          background: #f8f9fb;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          padding: 24px;
        }
        .card {
          background: white;
          padding: 40px;
          border-radius: 12px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.04);
          text-align: center;
          max-width: 420px;
          width: 100%;
        }
        h1 {
          color: #003d9b;
          margin-bottom: 20px;
        }
        p {
          color: #434654;
          margin-bottom: 20px;
        }
        code {
          background: #e1e2e4;
          padding: 8px 16px;
          border-radius: 8px;
          display: block;
          margin: 20px 0;
          word-break: break-all;
        }
        .success {
          color: #059669;
          font-size: 48px;
          line-height: 1;
          margin-bottom: 20px;
        }
        .link {
          display: inline-block;
          margin-top: 8px;
          color: #003d9b;
          text-decoration: none;
          font-weight: 600;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="success">&#10003;</div>
        <h1>Authorization Successful</h1>
        <p>Your authorization code:</p>
        <code>${code}</code>
        <p>State: ${state || 'N/A'}</p>
        <a class="link" href="/profile">Open profile</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/', (req, res) => {
  res.redirect('/oauth2/authorize');
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'server_error',
    error_key: 'server.internal',
    error_description: '服务器内部错误'
  });
});

async function bootstrap() {
  pool = await initDatabase();

  User = new UserModel(pool);
  Client = new ClientModel(pool);
  Token = new TokenModel(pool);
  EmailVerificationCode = new EmailVerificationCodeModel(pool);
  ExternalIdentity = new ExternalIdentityModel(pool);
  LoginLog = new LoginLogModel(pool);

  await ensureSystemUser();
  await seedMemoryDemoData();
  await Token.cleanExpiredTokens();

  app.listen(PORT, () => {
    console.log(`
============================================================
  VaultSSO OAuth2 Service
  Server running on http://localhost:${PORT}

  Pages:
  - Sign In / Register: /oauth2/authorize
  - Profile:            /profile
  - Legacy Success URL: /oauth2/success -> /oauth2/authorize

  Endpoints:
  - Authorization: /oauth2/authorize
  - Register:      /oauth2/register
  - Profile API:   /api/profile
  - Token:         /oauth2/token
  - UserInfo:      /oauth2/userinfo

  Database driver: ${process.env.DB_DRIVER || 'mysql'}
  Run "npm run init-db" once if you use MySQL and need demo data.
============================================================
    `);
  });
}

bootstrap().catch(async (error) => {
  console.error('❌ Failed to start server:', error);
  await closePool();
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await closePool();
    process.exit(0);
  });
}
