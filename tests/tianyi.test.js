const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const tianyi = require('../services/tianyi');

// Tianyi (China Telecom 189) operator account authorization contract.
// Evidence: .trellis/tasks/11-24-carrier-phone-auth/research/operator-oauth.md.
// This adapter produces an application-scoped openId only; it must never invent
// phone/email verification claims. No network is used.

const WEB_CONFIG = {
  type: 'tianyi_web',
  appId: 'test-app-id',
  appSecret: 'test-app-secret'
};
const H5_CONFIG = { ...WEB_CONFIG, type: 'tianyi_h5' };

function fakeTokenTransport(payload, calls = []) {
  return async function transport(url, init) {
    calls.push({ url, method: init.method, headers: init.headers, redirect: init.redirect,
      form: Object.fromEntries(new URLSearchParams(init.body)) });
    return { ok: true, async text() { return JSON.stringify(payload); } };
  };
}

// Build a valid encrypted callback envelope exactly as the provider would.
function makeCallback(config, fields) {
  const plaintext = Object.entries(fields).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const paras = tianyi.xxteaEncrypt(plaintext, config.appSecret);
  const sign = crypto.createHmac('sha1', config.appSecret).update(`${config.appId}${paras}`, 'utf8').digest('hex').toUpperCase();
  return { appId: config.appId, paras, sign };
}

// The documented callback timestamp is 'yyyy-MM-dd HH:mm:ss' in UTC+8 (no timezone suffix).
function utc8Timestamp(offsetMs = 0) {
  const date = new Date(Date.now() + offsetMs + 8 * 60 * 60 * 1000);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

// ---------------------------------------------------------------------------
// Official XXTEA reference vector (guide 481 section 2.4)
// ---------------------------------------------------------------------------

test('official XXTEA reference vector round-trips', () => {
  const vector = tianyi.OFFICIAL_XXTEA_VECTOR;
  assert.equal(vector.key, 'sAecMFcAlIXes93VaWXgr3jgMup4Y0a6');
  assert.equal(vector.plaintext, 'a=1&b=2&c=3');
  assert.equal(vector.ciphertextHex, 'f6c45d934cde581e908d02487720161d');
  assert.equal(tianyi.xxteaEncrypt(vector.plaintext, vector.key), vector.ciphertextHex,
    'encryption must match the published official ciphertext');
  assert.equal(tianyi.xxteaDecrypt(vector.ciphertextHex, vector.key), vector.plaintext,
    'decryption must recover the published official plaintext');
  assert.equal(tianyi.verifyOfficialVector(), true);
});

test('XXTEA decrypt accepts uppercase hex and rejects malformed ciphertext', () => {
  const vector = tianyi.OFFICIAL_XXTEA_VECTOR;
  assert.equal(tianyi.xxteaDecrypt(vector.ciphertextHex.toUpperCase(), vector.key), vector.plaintext);
  for (const bad of ['', 'zzzz', 'abc', 'a'.repeat(10)]) {
    assert.throws(() => tianyi.xxteaDecrypt(bad, vector.key), error => error.code === 'crypto_invalid');
  }
  // A wrong key must not silently yield the original plaintext.
  assert.throws(() => tianyi.xxteaDecrypt(vector.ciphertextHex, 'different-key-material'),
    error => error.code === 'crypto_invalid');
});

// ---------------------------------------------------------------------------
// Authorization URL: encryption + signing
// ---------------------------------------------------------------------------

test('WEB authorization URL uses the documented fixed endpoint and envelope', () => {
  const built = tianyi.buildAuthorizationUrl(WEB_CONFIG, { redirectUri: 'https://gateway.example.test/cb' });
  const url = new URL(built.url);
  assert.equal(`${url.origin}${url.pathname}`, tianyi.WEB_AUTHORIZE_URL);
  assert.equal(tianyi.WEB_AUTHORIZE_URL, 'https://open.e.189.cn/api/logbox/oauth2/separate/unifyAccountLogin.do');

  const params = url.searchParams;
  assert.equal(params.get('appId'), 'test-app-id');
  assert.equal(params.get('clientType'), '10010');
  assert.equal(params.get('format'), 'redirect');
  assert.equal(params.get('version'), 'v2.0');

  // The signature covers appId + clientType + format + version + paras with the app secret.
  const paras = params.get('paras');
  assert.match(paras, /^[0-9A-F]+$/, 'official authorization output is uppercase hex');
  const expected = crypto.createHmac('sha1', 'test-app-secret')
    .update(`test-app-id10010redirectv2.0${paras}`, 'utf8').digest('hex').toUpperCase();
  assert.equal(params.get('sign'), expected);

  // Decrypting paras exposes the documented inner fields.
  const inner = tianyi.xxteaDecrypt(paras, 'test-app-secret');
  const fields = Object.fromEntries(new URLSearchParams(inner));
  assert.match(fields.timeStamp, /^\d{13}$/, 'inner timeStamp is milliseconds');
  assert.equal(fields.returnURL, 'https://gateway.example.test/cb');
  assert.ok(built.state && built.state.length <= tianyi.MAX_STATE_LENGTH);
});

test('H5 authorization URL uses clientType=20100 and version=v2.1', () => {
  const built = tianyi.buildAuthorizationUrl(H5_CONFIG, { redirectUri: 'https://gateway.example.test/cb' });
  const url = new URL(built.url);
  assert.equal(`${url.origin}${url.pathname}`, tianyi.H5_AUTHORIZE_URL);
  assert.equal(url.searchParams.get('clientType'), '20100');
  assert.equal(url.searchParams.get('version'), 'v2.1');
  const expected = crypto.createHmac('sha1', 'test-app-secret')
    .update(`test-app-id20100redirectv2.1${url.searchParams.get('paras')}`, 'utf8').digest('hex').toUpperCase();
  assert.equal(url.searchParams.get('sign'), expected);
});

test('generated state fits the 32-character Tianyi limit', () => {
  for (let index = 0; index < 50; index += 1) {
    const state = tianyi.generateState();
    assert.ok(state.length <= tianyi.MAX_STATE_LENGTH, state);
    assert.match(state, /^[A-Za-z0-9_-]+$/);
  }
  assert.equal(tianyi.MAX_STATE_LENGTH, 32);
  // An oversized caller-provided state is rejected, never truncated silently.
  assert.throws(
    () => tianyi.buildAuthorizationUrl(WEB_CONFIG, { redirectUri: 'https://x.test/cb', state: 'a'.repeat(40) }),
    error => error.code === 'invalid_state'
  );
});

test('authorization URL requires appId, appSecret and a redirect URI', () => {
  for (const config of [{ type: 'tianyi_web', appSecret: 's' }, { type: 'tianyi_web', appId: 'a' }]) {
    assert.throws(() => tianyi.buildAuthorizationUrl(config, { redirectUri: 'https://x.test/cb' }),
      error => error.code === 'config_invalid');
  }
  assert.throws(() => tianyi.buildAuthorizationUrl(WEB_CONFIG, { redirectUri: '' }),
    error => error.code === 'config_invalid');
});

// ---------------------------------------------------------------------------
// Callback: signature before decryption
// ---------------------------------------------------------------------------

test('a valid callback decrypts to its code and state', () => {
  const state = tianyi.generateState();
  const envelope = makeCallback(WEB_CONFIG, {
    result: '0', code: 'auth-code-1', state, timeStamp: utc8Timestamp()
  });
  const parsed = tianyi.parseCallback(WEB_CONFIG, envelope);
  assert.deepEqual(parsed, { code: 'auth-code-1', state });
});

test('a wrong callback signature is rejected before decryption', () => {
  const envelope = makeCallback(WEB_CONFIG, {
    result: '0', code: 'auth-code-1', state: 'abc', timeStamp: utc8Timestamp()
  });
  const tampered = { ...envelope, sign: envelope.sign.slice(0, -2) + (envelope.sign.endsWith('AA') ? 'BB' : 'AA') };
  assert.throws(() => tianyi.parseCallback(WEB_CONFIG, tampered), error => error.code === 'invalid_signature');

  // A signature computed with a different app secret must also fail closed.
  const wrongSecret = makeCallback({ ...WEB_CONFIG, appSecret: 'other-secret' }, {
    result: '0', code: 'c', state: 's', timeStamp: utc8Timestamp()
  });
  assert.throws(() => tianyi.parseCallback(WEB_CONFIG, wrongSecret), error => error.code === 'invalid_signature');
});

test('a callback for another appId is rejected', () => {
  const envelope = makeCallback(WEB_CONFIG, {
    result: '0', code: 'auth-code-1', state: 'abc', timeStamp: utc8Timestamp()
  });
  assert.throws(() => tianyi.parseCallback(WEB_CONFIG, { ...envelope, appId: 'a-different-app' }),
    error => error.code === 'invalid_callback');
});

test('callback failures reject non-success results, missing code and stale timestamps', () => {
  const state = tianyi.generateState();
  const cases = [
    [{ result: '1', code: 'c', state, timeStamp: utc8Timestamp() }, 'invalid_callback', 'non-zero result'],
    [{ result: '0', state, timeStamp: utc8Timestamp() }, 'invalid_callback', 'missing code'],
    [{ result: '0', code: 'c', state, timeStamp: utc8Timestamp(-15 * 60 * 1000) }, 'invalid_callback', 'stale timestamp'],
    [{ result: '0', code: 'c', state, timeStamp: 'not-a-timestamp' }, 'invalid_callback', 'unparseable timestamp']
  ];
  for (const [fields, code, label] of cases) {
    const envelope = makeCallback(WEB_CONFIG, fields);
    assert.throws(() => tianyi.parseCallback(WEB_CONFIG, envelope), error => error.code === code, label);
  }
});

test('a tampered encrypted payload with a validly recomputed signature still fails closed', () => {
  // The attacker knows the app secret only if they can sign, so this proves the freshness and
  // result gates independently of the HMAC.
  const envelope = makeCallback(WEB_CONFIG, {
    result: '0', code: 'c', state: 'abc', timeStamp: utc8Timestamp(-60 * 60 * 1000)
  });
  assert.throws(() => tianyi.parseCallback(WEB_CONFIG, envelope), error => error.code === 'invalid_callback');
});

// ---------------------------------------------------------------------------
// Code exchange
// ---------------------------------------------------------------------------

test('exchangeCode posts the documented form and returns the application-scoped openId', async () => {
  const calls = [];
  const result = await tianyi.exchangeCode(WEB_CONFIG, 'auth-code-1', {
    fetchImpl: fakeTokenTransport({ result: '10000', openId: 'open-id-1', appId: 'test-app-id', accessToken: 'at', timeStamp: utc8Timestamp() }, calls)
  });
  assert.deepEqual(result, { subject: 'open-id-1', openId: 'open-id-1' });
  assert.equal(calls[0].url, tianyi.TOKEN_URL);
  assert.equal(calls[0].url, 'https://open.e.189.cn/api/logbox/oauth2/accessToken.do');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].redirect, 'error', 'signed authorization codes must never follow redirects');
  const { form } = calls[0];
  assert.equal(form.appId, 'test-app-id');
  assert.equal(form.grantType, 'authorization_login');
  assert.equal(form.code, 'auth-code-1');
  assert.equal(form.format, 'json');
  const expected = crypto.createHmac('sha1', 'test-app-secret')
    .update('test-app-idauth-code-1jsonauthorization_login', 'utf8').digest('hex').toUpperCase();
  assert.equal(form.sign, expected);
});

test('exchangeCode requires result=10000 and a nonempty openId', async () => {
  const rejected = await tianyi.exchangeCode(WEB_CONFIG, 'code', {
    fetchImpl: fakeTokenTransport({ result: '0', openId: 'x' })
  }).catch(error => error);
  assert.equal(rejected.code, 'upstream_rejected');

  const incomplete = await tianyi.exchangeCode(WEB_CONFIG, 'code', {
    fetchImpl: fakeTokenTransport({ result: '10000' })
  }).catch(error => error);
  assert.equal(incomplete.code, 'upstream_incomplete');
});

test('exchangeCode rejects an openId belonging to a different app', async () => {
  const error = await tianyi.exchangeCode(WEB_CONFIG, 'code', {
    fetchImpl: fakeTokenTransport({ result: '10000', openId: 'x', appId: 'other-app' })
  }).catch(reason => reason);
  assert.equal(error.code, 'upstream_rejected');
});

test('exchangeCode surfaces only fixed messages on transport failure', async () => {
  const error = await tianyi.exchangeCode(WEB_CONFIG, 'code', {
    fetchImpl: async () => { throw new Error('TLS handshake secret-detail'); }
  }).catch(reason => reason);
  assert.equal(error.code, 'upstream_error');
  assert.ok(!/TLS|secret-detail/.test(error.message));
});

test('exchangeCode requires a code and a transport', async () => {
  assert.equal((await tianyi.exchangeCode(WEB_CONFIG, '', {}).catch(error => error)).code, 'invalid_code');
  assert.equal((await tianyi.exchangeCode(WEB_CONFIG, 'code', { fetchImpl: null }).catch(error => error)).code, 'config_invalid');
});

// ---------------------------------------------------------------------------
// Honest scope boundary
// ---------------------------------------------------------------------------

test('the adapter exposes no phone or email verification claim', async () => {
  const result = await tianyi.exchangeCode(WEB_CONFIG, 'code', {
    fetchImpl: fakeTokenTransport({
      result: '10000', openId: 'open-id-1', appId: 'test-app-id', timeStamp: utc8Timestamp(),
      // Extra upstream fields must not be promoted to verified claims.
      mobile: '13800138000', email: 'user@example.test', phoneNumberVerified: true
    })
  });
  assert.deepEqual(Object.keys(result).sort(), ['openId', 'subject']);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('13800138000'), 'no phone claim is invented');
  assert.ok(!serialized.includes('user@example.test'), 'no email claim is invented');
  assert.ok(!/verified/i.test(serialized), 'no verification claim is invented');
});

test('tianyi_web and tianyi_h5 are distinct provider types', () => {
  const web = new URL(tianyi.buildAuthorizationUrl(WEB_CONFIG, { redirectUri: 'https://x.test/cb' }).url);
  const h5 = new URL(tianyi.buildAuthorizationUrl(H5_CONFIG, { redirectUri: 'https://x.test/cb' }).url);
  assert.notEqual(`${web.origin}${web.pathname}`, `${h5.origin}${h5.pathname}`);
  assert.notEqual(web.searchParams.get('clientType'), h5.searchParams.get('clientType'));
});

test('database providerType selects H5 and token identity fields fail closed', async () => {
  const built = tianyi.buildAuthorizationUrl({ providerType: 'tianyi_h5', clientId: WEB_CONFIG.appId,
    clientSecret: WEB_CONFIG.appSecret }, { redirectUri: 'https://x.test/cb' });
  assert.equal(new URL(built.url).pathname, new URL(tianyi.H5_AUTHORIZE_URL).pathname);
  for (const patch of [{ openId: {} }, { openId: [] }, { openId: 123 }, { appId: '' },
    { timeStamp: '' }, { timeStamp: utc8Timestamp(-60 * 60 * 1000) }]) {
    await assert.rejects(() => tianyi.exchangeCode(WEB_CONFIG, 'code', {
      fetchImpl: fakeTokenTransport({ result: '10000', openId: 'subject', appId: WEB_CONFIG.appId,
        timeStamp: utc8Timestamp(), ...patch })
    }));
  }
  await assert.rejects(() => tianyi.exchangeCode(WEB_CONFIG, 'code', {
    fetchImpl: async () => ({ ok: false, async text() { throw new Error('must not read error body'); } })
  }), error => error.code === 'upstream_error');
});
