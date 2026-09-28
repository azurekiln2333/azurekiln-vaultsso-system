const net = require('node:net');

function environment(env = process.env) {
  const name = String(env.NODE_ENV || 'production').trim().toLowerCase();
  if (!['production', 'development', 'test'].includes(name)) {
    throw new Error('NODE_ENV must be production, development or test');
  }
  return name;
}

function readRuntimeConfig(env = process.env) {
  const nodeEnv = environment(env);
  const production = nodeEnv === 'production';
  const jwtSecret = String(env.JWT_SECRET || '');
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is missing or empty. Set it in the project .env file or service environment; run npm run check:config to inspect its source');
  }
  if (/change.in.production|change-me|replace.this|your.super.secret|example.secret/i.test(jwtSecret)) {
    throw new Error('JWT_SECRET is still an example/placeholder value. Configure a generated random secret; run npm run check:config to inspect its source');
  }
  if (Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('JWT_SECRET is too short: at least 32 bytes are required. Run npm run check:config to inspect its source');
  }
  if (new Set(jwtSecret).size < 10) {
    throw new Error('JWT_SECRET is too repetitive to use as a signing secret. Configure a generated random secret; run npm run check:config to inspect its source');
  }

  let publicUrl;
  try { publicUrl = new URL(String(env.PUBLIC_BASE_URL || '').trim()); } catch {
    throw new Error('PUBLIC_BASE_URL must be an absolute origin URL');
  }
  if (!['https:', 'http:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password
      || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash
      || (production && publicUrl.protocol !== 'https:')) {
    throw new Error('PUBLIC_BASE_URL must be an origin without credentials, path or query; production requires HTTPS');
  }
  if (env.COOKIE_SECURE && !['true', 'false'].includes(String(env.COOKIE_SECURE).toLowerCase())) {
    throw new Error('COOKIE_SECURE must be true or false');
  }
  if (production && String(env.COOKIE_SECURE).toLowerCase() === 'false') {
    throw new Error('Secure session cookies cannot be disabled in production');
  }
  if (env.EMAIL_DEV_CODE) throw new Error('EMAIL_DEV_CODE is no longer supported');
  if (env.DB_DRIVER && String(env.DB_DRIVER).trim().toLowerCase() !== 'mysql') {
    throw new Error('The application only supports DB_DRIVER=mysql');
  }
  const turnstileSiteKey = String(env.TURNSTILE_SITE_KEY || '').trim();
  const turnstileSecretKey = String(env.TURNSTILE_SECRET_KEY || '').trim();
  if (Boolean(turnstileSiteKey) !== Boolean(turnstileSecretKey)) {
    throw new Error('TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be configured together');
  }

  const trustedProxies = String(env.TRUST_PROXY ?? '127.0.0.1/32,::1/128').split(',').map(value => value.trim()).filter(Boolean);
  for (const proxy of trustedProxies) {
    const [address, prefix, extra] = proxy.split('/');
    const version = net.isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined
        && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error('TRUST_PROXY must contain explicit proxy IP addresses or CIDRs; unrestricted trust is rejected');
    }
  }
  return {
    nodeEnv, production, jwtSecret, publicBaseUrl: publicUrl.origin,
    secureCookies: production || publicUrl.protocol === 'https:' || String(env.COOKIE_SECURE).toLowerCase() === 'true',
    trustedProxies, turnstileSiteKey, turnstileSecretKey
  };
}

function validateDatabaseEnvironment(env = process.env) {
  if (env.DB_DRIVER && String(env.DB_DRIVER).trim().toLowerCase() !== 'mysql') {
    throw new Error('The application only supports DB_DRIVER=mysql');
  }
  if (environment(env) === 'production') {
    for (const key of ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']) {
      if (!env[key]) throw new Error(`${key} must be explicitly configured in production`);
    }
    if (!['localhost', '127.0.0.1', '::1'].includes(String(env.DB_HOST).toLowerCase())
        && String(env.DB_TLS || '').toLowerCase() !== 'true') {
      throw new Error('Remote production databases require DB_TLS=true (and DB_TLS_CA_FILE for a private CA)');
    }
  }
}

module.exports = { environment, readRuntimeConfig, validateDatabaseEnvironment };
