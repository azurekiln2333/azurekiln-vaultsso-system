require('dotenv').config();

const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

const { initDatabase, closePool } = require('./db/init');
const UserModel = require('./models/User');
const ClientModel = require('./models/Client');
const TokenModel = require('./models/Token');

const app = express();

const PORT = Number(process.env.PORT || 3146);
const JWT_SECRET = process.env.JWT_SECRET || 'vaultsso-jwt-secret-key-2024-change-in-production';
const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || '1h';
const REFRESH_TOKEN_EXPIRY = process.env.REFRESH_TOKEN_EXPIRY || '7d';
const SYSTEM_USER_EMAIL = 'system@vaultsso.local';
const SYSTEM_USER_USERNAME = 'system@vaultsso.local';
const USER_ROLE_ADMIN = 'admin';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_ONLY_STATIC_PATHS = new Set(['/apps.html', '/tokens.html']);

let User;
let Client;
let Token;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors({
  origin: true,
  credentials: true
}));

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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    emailVerified: Boolean(user.emailVerified ?? user.email_verified),
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

function setSessionCookie(res, user) {
  res.cookie('session', createSessionToken(user), {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE
  });
}

async function getAuthenticatedUser(req) {
  const sessionToken = req.cookies.session;
  if (!sessionToken) {
    return null;
  }

  const session = validateToken(sessionToken);
  if (!session) {
    return null;
  }

  return User.findById(session.sub);
}

function isAdminUser(user) {
  return normalizeText(user?.role).toLowerCase() === USER_ROLE_ADMIN;
}

async function requireAuthenticatedUser(req, res) {
  const user = await getAuthenticatedUser(req);
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

  const user = await getAuthenticatedUser(req);
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

async function generateAccessToken(userId, clientId, scopes) {
  const tokenId = uuidv4();
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

async function generateRefreshToken(userId, clientId) {
  const tokenId = uuidv4();
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

async function ensureSystemUser() {
  const existing = await User.findByEmail(SYSTEM_USER_EMAIL);
  if (existing) {
    return existing;
  }

  return User.create({
    username: SYSTEM_USER_USERNAME,
    email: SYSTEM_USER_EMAIL,
    password: uuidv4(),
    name: 'VaultSSO System',
    avatar: '',
    emailVerified: true
  });
}

app.get('/.well-known/openid-configuration', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth2/authorize`,
    token_endpoint: `${baseUrl}/oauth2/token`,
    userinfo_endpoint: `${baseUrl}/oauth2/userinfo`,
    jwks_uri: `${baseUrl}/.well-known/jwks.json`,
    response_types_supported: ['code', 'token', 'id_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256', 'HS256'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials']
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

    const user = await getAuthenticatedUser(req);
    if (user) {
      const result = await buildAuthorizationResponse(user, {
        client_id: clientId,
        redirect_uri: redirectUri,
        scope,
        state
      });
      return res.redirect(result.body.redirect);
    }
  }

  res.sendFile(path.join(__dirname, 'authorize.html'));
}));

app.get('/login', (req, res) => {
  res.redirect('/oauth2/authorize');
});

app.post('/oauth2/authorize', asyncHandler(async (req, res) => {
  const username = normalizeText(req.body.username);
  const password = String(req.body.password || '');
  const user = await User.findByUsername(username);

  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({
      error: 'invalid_grant',
      error_key: 'auth.invalid_credentials',
      error_description: '用户名或密码错误'
    });
  }

  setSessionCookie(res, user);

  const result = await buildAuthorizationResponse(user, req.body);
  return res.status(result.status).json(result.body);
}));

app.post('/oauth2/register', asyncHandler(async (req, res) => {
  const name = normalizeText(req.body.name);
  const email = normalizeEmail(req.body.email);
  const username = normalizeText(req.body.username) || email;
  const password = String(req.body.password || '');
  const confirmPassword = String(req.body.confirm_password || '');

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

  if (password.length < 6) {
    return res.status(400).json({
      error: 'invalid_request',
      error_key: 'validation.password.min_length',
      error_description: '密码长度不能少于 6 位'
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

  const user = await User.create({
    username,
    email,
    password,
    name: name || username,
    avatar: '',
    emailVerified: false
  });

  setSessionCookie(res, user);

  const result = await buildAuthorizationResponse(user, req.body);
  return res.status(result.status).json(result.body);
}));

app.get(['/api/me', '/api/profile'], asyncHandler(async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({
      error: 'unauthorized',
      error_key: 'auth.required',
      error_description: '请先登录'
    });
  }

  res.json({
    user: serializeUser(user)
  });
}));

app.put('/api/profile', asyncHandler(async (req, res) => {
  const currentUser = await getAuthenticatedUser(req);
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

  let nextName = currentUser.name;
  let nextUsername = currentUser.username;
  let nextEmail = currentUser.email;
  let nextAvatar = currentUser.avatar || '';

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

    if (!currentPassword || !await bcrypt.compare(currentPassword, currentUser.password)) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.current_password.invalid',
        error_description: '当前密码不正确'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'invalid_request',
        error_key: 'profile.password.min_length',
        error_description: '新密码长度不能少于 6 位'
      });
    }

    await User.updatePassword(currentUser.id, newPassword);
  }

  await User.update(currentUser.id, {
    name: nextName,
    username: nextUsername,
    email: nextEmail,
    avatar: nextAvatar
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
  const clientId = normalizeText(req.body.client_id);
  const clientSecret = normalizeText(req.body.client_secret);
  const refreshToken = normalizeText(req.body.refresh_token);

  if (grantType === 'authorization_code') {
    const authCodeData = await Token.findAuthCode(code);
    if (!authCodeData) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.code.invalid',
        error_description: '授权码无效'
      });
    }

    if (new Date(authCodeData.expires_at) < new Date()) {
      await Token.deleteAuthCode(code);
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.code.expired',
        error_description: '授权码已过期'
      });
    }

    if (authCodeData.client_id !== clientId) {
      return res.status(400).json({
        error: 'invalid_client',
        error_key: 'oauth.client.id_mismatch',
        error_description: '客户端 ID 不匹配'
      });
    }

    if (redirectUri && authCodeData.redirect_uri !== redirectUri) {
      return res.status(400).json({
        error: 'invalid_redirect_uri',
        error_key: 'auth.request.invalid_redirect_uri',
        error_description: '无效的回调地址'
      });
    }

    const client = await Client.findById(clientId);
    if (!client || client.secret !== clientSecret) {
      return res.status(401).json({
        error: 'invalid_client',
        error_key: 'oauth.client.credentials.invalid',
        error_description: '客户端凭证无效'
      });
    }

    await Token.deleteAuthCode(code);

    const user = await User.findById(authCodeData.user_id);
    const accessToken = await generateAccessToken(authCodeData.user_id, clientId, authCodeData.scopes);
    const newRefreshToken = await generateRefreshToken(authCodeData.user_id, clientId);

    const idToken = jwt.sign({
      sub: user.id,
      email: user.email,
      name: user.name,
      preferred_username: user.username,
      username: user.username,
      picture: user.avatar,
      aud: clientId,
      iss: `${req.protocol}://${req.get('host')}`,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((Date.now() + ACCESS_TOKEN_TTL_MS) / 1000)
    }, JWT_SECRET);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: newRefreshToken,
      id_token: idToken,
      scope: authCodeData.scopes.join(' ')
    });
  }

  if (grantType === 'refresh_token') {
    const decoded = validateToken(refreshToken);
    if (!decoded || decoded.type !== 'refresh') {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.refresh_token.invalid',
        error_description: '刷新令牌无效'
      });
    }

    const refreshTokenData = await Token.findRefreshTokenById(decoded.jti);
    if (!refreshTokenData || new Date(refreshTokenData.expires_at) < new Date()) {
      return res.status(400).json({
        error: 'invalid_grant',
        error_key: 'oauth.refresh_token.expired',
        error_description: '刷新令牌已过期'
      });
    }

    const client = await Client.findById(clientId);
    if (!client || client.secret !== clientSecret) {
      return res.status(401).json({
        error: 'invalid_client',
        error_key: 'oauth.client.credentials.invalid',
        error_description: '客户端凭证无效'
      });
    }

    const accessToken = await generateAccessToken(decoded.sub, clientId, ['openid', 'profile', 'email']);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: 'openid profile email'
    });
  }

  if (grantType === 'client_credentials') {
    const client = await Client.findById(clientId);
    if (!client || client.secret !== clientSecret) {
      return res.status(401).json({
        error: 'invalid_client',
        error_key: 'oauth.client.credentials.invalid',
        error_description: '客户端凭证无效'
      });
    }

    const systemUser = await ensureSystemUser();
    const accessToken = await generateAccessToken(systemUser.id, clientId, ['client']);

    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scope: 'client'
    });
  }

  return res.status(400).json({
    error: 'unsupported_grant_type',
    error_key: 'oauth.grant.unsupported',
    error_description: '不支持的授权类型'
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
  const decoded = validateToken(normalizeText(req.body.token));
  if (!decoded) {
    return res.json({ active: false });
  }

  const tokenData = await Token.findAccessTokenById(decoded.jti);
  if (!tokenData || new Date(tokenData.expires_at) < new Date()) {
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
  const decoded = validateToken(normalizeText(req.body.token));

  if (decoded) {
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
  res.redirect('/oauth2/authorize');
});

app.get('/profile', asyncHandler(async (req, res) => {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    return res.redirect('/oauth2/authorize');
  }

  res.sendFile(path.join(__dirname, 'profile.html'));
}));

app.get('/oauth2/logout', (req, res) => {
  res.clearCookie('session');
  res.redirect('/oauth2/authorize');
});

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
  const pool = await initDatabase();

  User = new UserModel(pool);
  Client = new ClientModel(pool);
  Token = new TokenModel(pool);

  await ensureSystemUser();
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

  Database mode only. Run "npm run init-db" once if you need
  the demo user and demo clients in MySQL.
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
