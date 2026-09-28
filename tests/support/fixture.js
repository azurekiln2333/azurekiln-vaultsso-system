const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMemoryPool } = require('./memory-db');
const UserModel = require('../../models/User');
const ClientModel = require('../../models/Client');

// This process owns every credential and transport used by these tests.
// server.js does not load .env in this explicitly selected environment.
process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'mysql';
process.env.DB_TLS = 'false';
delete process.env.DB_TLS_CA_FILE;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.PUBLIC_BASE_URL = 'https://gateway.example.test';
process.env.TOKEN_EXPIRY = '1h';
process.env.REFRESH_TOKEN_EXPIRY = '7d';
process.env.SESSION_ABSOLUTE_EXPIRY = '12h';
process.env.COOKIE_DOMAIN = '';
process.env.COOKIE_SECURE = 'true';
process.env.TRUST_PROXY = '';
process.env.EMAIL_CODE_MAX_ATTEMPTS = '5';
process.env.EMAIL_CODE_EXPIRY = '10m';
process.env.SMTP_HOST = 'smtp.example.test';
process.env.SMTP_USER = 'isolated-tests';
process.env.SMTP_PASS = crypto.randomBytes(32).toString('hex');
process.env.MAIL_FROM = 'Gateway <no-reply@example.test>';
delete process.env.EMAIL_DEV_CODE;
delete process.env.OIDC_PREVIOUS_JWKS_FILE;
delete process.env.TURNSTILE_SITE_KEY;
delete process.env.TURNSTILE_SECRET_KEY;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-security-tests-'));
process.env.ADMIN_SETTINGS_FILE = path.join(directory, 'admin-settings.json');
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
process.env.OIDC_SIGNING_KEY_FILE = path.join(directory, 'signing.pem');
fs.writeFileSync(process.env.OIDC_SIGNING_KEY_FILE, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

const mails = [];
const nodemailer = require('nodemailer');
const originalTransport = nodemailer.createTransport;
nodemailer.createTransport = () => ({ async sendMail(message) { mails.push(message); return { accepted: [message.to] }; } });
const captcha = require('../../services/captcha');
const originalRenderCaptcha = captcha.renderCaptcha;
const captchaAnswers = [];
captcha.renderCaptcha = value => { captchaAnswers.push(value); return originalRenderCaptcha(value); };

function randomSecret() { return crypto.randomBytes(32).toString('base64url'); }
function cookies(response) { return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '); }

async function createFixture({ port = 0 } = {}) {
  const pool = createMemoryPool();
  const User = new UserModel(pool);
  const Client = new ClientModel(pool);
  const { bootstrap } = require('../../server');
  const service = await bootstrap({ databasePool: pool, port });
  const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
  async function request(route, { data, cookie, headers = {}, ...options } = {}) {
    const response = await fetch(baseUrl + route, {
      redirect: 'manual', ...options,
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      headers: {
        Origin: process.env.PUBLIC_BASE_URL,
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...headers
      }
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body, headers: response.headers, cookie: cookies(response) };
  }
  async function user(role = 'user') {
    const password = randomSecret();
    const username = `account-${crypto.randomUUID()}`;
    const record = await User.create({ username, email: `${username}@example.test`, password, role, emailVerified: true });
    return { ...record, clearPassword: password };
  }
  async function login(account, extra = {}) {
    return request('/oauth2/authorize', { method: 'POST', data: { username: account.username, password: account.clearPassword, ...extra } });
  }
  async function client({ requirePkce } = {}) {
    const secret = randomSecret();
    const record = await Client.create({
      id: `client-${crypto.randomUUID()}`, name: 'Isolated test client', secret,
      redirectUris: ['https://client.example.test/callback'], scopes: ['openid', 'profile', 'email', 'offline_access', 'service.read'],
      ...(requirePkce !== undefined ? { requirePkce } : {})
    });
    return { ...record, clearSecret: secret };
  }
  async function authorize(account, app, scopes = 'openid profile email', cookie, { pkce = true } = {}) {
    const authenticated = cookie ? { cookie } : await login(account);
    const verifier = pkce ? randomSecret() : '';
    const nonce = randomSecret();
    const params = new URLSearchParams({
      response_type: 'code', client_id: app.id, redirect_uri: app.redirectUris[0], scope: scopes, nonce, state: randomSecret()
    });
    if (pkce) {
      params.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
      params.set('code_challenge_method', 'S256');
    }
    const result = await request(`/oauth2/authorize?${params}`, { cookie: authenticated.cookie });
    if (result.status !== 302) throw new Error(`Authorization failed: ${JSON.stringify(result.body)}`);
    return { code: new URL(result.headers.get('location')).searchParams.get('code'), verifier, nonce, cookie: authenticated.cookie };
  }
  async function exchange(app, grant, extra = {}) {
    return request('/oauth2/token', { method: 'POST', data: {
      grant_type: 'authorization_code', client_id: app.id, client_secret: app.clearSecret,
      redirect_uri: app.redirectUris[0], code: grant.code,
      ...(grant.verifier ? { code_verifier: grant.verifier } : {}), ...extra
    } });
  }
  async function refresh(app, token, extra = {}) {
    return request('/oauth2/token', { method: 'POST', data: {
      grant_type: 'refresh_token', client_id: app.id, client_secret: app.clearSecret, refresh_token: token, ...extra
    } });
  }
  function lastCode(email) {
    const message = mails.findLast(item => item.to === email);
    if (!message) throw new Error('No verification email was captured');
    return message.text.match(/code is: (\d{6})/)[1];
  }
  function reset() {
    for (const key of Object.keys(pool)) if (Array.isArray(pool[key])) pool[key].length = 0;
    mails.length = 0;
    captchaAnswers.length = 0;
  }
  async function close() {
    await service.close();
    nodemailer.createTransport = originalTransport;
    captcha.renderCaptcha = originalRenderCaptcha;
    fs.unlinkSync(process.env.OIDC_SIGNING_KEY_FILE);
    if (fs.existsSync(process.env.ADMIN_SETTINGS_FILE)) fs.unlinkSync(process.env.ADMIN_SETTINGS_FILE);
    fs.rmdirSync(directory);
  }
  return { pool, User, Client, request, user, login, client, authorize, exchange, refresh, lastCode, reset, close, mails, captchaAnswers, baseUrl };
}

module.exports = { createFixture, randomSecret };
