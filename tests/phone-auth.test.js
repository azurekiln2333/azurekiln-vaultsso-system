const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const phoneAuth = require('../services/phone-auth');
const phoneNumbers = require('../services/phone');

// Official Aliyun PNVS (Dypnsapi 2017-05-25) provider contract.
// Evidence: .trellis/tasks/11-24-carrier-phone-auth/research/aliyun-contract.md and
// research/aliyun-signing.md. No network is used: every transport is an injected fake.

const VALID_CONFIG = {
  h5Enabled: true,
  appEnabled: true,
  smsEnabled: true,
  accessKeyId: 'test-ak-id',
  accessKeySecret: 'test-ak-secret',
  sceneCode: '1000000001',
  h5Origin: 'https://gateway.example.test',
  h5Url: 'https://gateway.example.test/oauth2/authorize',
  // h5Ready() requires a real SDK URL (same-origin path or HTTPS); an empty value keeps H5
  // permanently unreachable, so a "valid" config must provide one.
  h5SdkUrl: '/js/phone-auth-sdk.js',
  smsSignName: 'Example',
  smsTemplateCode: 'SMS_000001'
};

// A fake `fetchImpl` that records the outgoing form body and replies with one canned payload.
function fakeTransport(reply, calls = []) {
  return async function transport(url, init) {
    const params = new URLSearchParams(init.body);
    calls.push({ url, method: init.method, headers: init.headers, params: Object.fromEntries(params) });
    return { ok: true, async text() { return typeof reply === 'string' ? reply : JSON.stringify(reply); } };
  };
}

function throwingTransport(calls = []) {
  return async function transport(url, init) {
    calls.push({ url, init });
    throw new Error('transport must not be called');
  };
}

// ---------------------------------------------------------------------------
// Configuration: defaults, normalization, projections
// ---------------------------------------------------------------------------

test('default configuration is disabled and unconfigured', () => {
  const config = phoneAuth.normalizeConfig({});
  for (const flag of ['h5Enabled', 'appEnabled', 'smsEnabled', 'allowRegistration']) {
    assert.equal(config[flag], false, `${flag} defaults off`);
  }
  assert.equal(config.accessKeyId, '');
  assert.equal(config.accessKeySecret, '');
  assert.deepEqual(config.smsTemplateParam, phoneAuth.DEFAULT_SMS_TEMPLATE_PARAM);

  const publicView = phoneAuth.publicConfig(config);
  assert.deepEqual(publicView, {
    h5: { enabled: false, available: false, sdkUrl: '' },
    app: { enabled: false, available: false },
    sms: { enabled: false, available: false, resendSeconds: phoneAuth.SMS_RESEND_SECONDS },
    registrationEnabled: false
  });
  assert.equal(phoneAuth.SMS_RESEND_SECONDS, 60);
  assert.equal(phoneAuth.SMS_CODE_TTL_SECONDS, 300);
});

test('blank secrets preserve the current value while explicit clears remove them', () => {
  const current = phoneAuth.normalizeConfig({
    h5Enabled: true,
    accessKeyId: 'ak',
    accessKeySecret: 'secret-value',
    securityToken: 'sts-value'
  });
  const preserved = phoneAuth.normalizeConfig({ accessKeyId: 'ak-2', accessKeySecret: '' }, current);
  assert.equal(preserved.accessKeySecret, 'secret-value', 'a blank secret keeps the stored one');
  assert.equal(preserved.securityToken, 'sts-value');
  assert.equal(preserved.accessKeyId, 'ak-2');

  const cleared = phoneAuth.normalizeConfig({ clearAccessKeySecret: true, clearSecurityToken: true }, current);
  assert.equal(cleared.accessKeySecret, '');
  assert.equal(cleared.securityToken, '');
});

test('admin projection exposes secret presence but never the secret values', () => {
  const config = phoneAuth.normalizeConfig({
    ...VALID_CONFIG,
    securityToken: 'sts-value',
    smsTemplateParam: '{"code":"##code##","min":"5"}'
  });
  const admin = phoneAuth.adminConfig(config);
  const serialized = JSON.stringify(admin);
  assert.equal(admin.hasAccessKeySecret, true);
  assert.equal(admin.hasSecurityToken, true);
  assert.equal(admin.accessKeyId, 'test-ak-id');
  assert.deepEqual(admin.ready, { h5: true, app: true, sms: true });
  assert.ok(!serialized.includes('test-ak-secret'), 'the access key secret must not be projected');
  assert.ok(!serialized.includes('sts-value'), 'the security token must not be projected');
  assert.equal(admin.smsTemplateParam.code, '##code##');
});

test('readiness requires the documented per-channel fields', () => {
  const missingScene = phoneAuth.publicConfig(phoneAuth.normalizeConfig({
    ...VALID_CONFIG, sceneCode: ''
  }));
  assert.equal(missingScene.h5.available, false, 'H5 needs SceneCode even though the docs mark it optional');
  const missingSms = phoneAuth.publicConfig(phoneAuth.normalizeConfig({
    ...VALID_CONFIG, smsSignName: ''
  }));
  assert.equal(missingSms.sms.available, false);
  // The enabled bit is advertised separately from availability so the UI can explain readiness.
  assert.equal(missingSms.sms.enabled, true);

  // A missing SDK URL keeps H5 unreachable even with every other field present.
  const missingSdk = phoneAuth.publicConfig(phoneAuth.normalizeConfig({
    ...VALID_CONFIG, h5SdkUrl: ''
  }));
  assert.equal(missingSdk.h5.available, false, 'H5 requires a usable SDK URL');
  assert.equal(missingSdk.h5.sdkUrl, '');
});

test('fromEnvironment reads PHONE_AUTH_ uppercase snake case variables', () => {
  const config = phoneAuth.fromEnvironment({
    PHONE_AUTH_H5_ENABLED: 'true',
    PHONE_AUTH_APP_ENABLED: '1',
    PHONE_AUTH_SMS_ENABLED: 'yes',
    PHONE_AUTH_ALLOW_REGISTRATION: 'on',
    PHONE_AUTH_ACCESS_KEY_ID: 'env-ak',
    PHONE_AUTH_ACCESS_KEY_SECRET: 'env-secret',
    PHONE_AUTH_SECURITY_TOKEN: 'env-sts',
    PHONE_AUTH_SCENE_CODE: 'scene-1',
    PHONE_AUTH_H5_ORIGIN: 'https://gateway.example.test',
    PHONE_AUTH_H5_URL: 'https://gateway.example.test/login',
    PHONE_AUTH_H5_SDK_URL: 'https://gateway.example.test/sdk.js',
    PHONE_AUTH_SMS_SCHEME_NAME: 'scheme-1',
    PHONE_AUTH_SMS_SIGN_NAME: 'Example',
    PHONE_AUTH_SMS_TEMPLATE_CODE: 'SMS_1',
    PHONE_AUTH_SMS_TEMPLATE_PARAM: '{"code":"##code##"}'
  });
  assert.equal(config.h5Enabled, true);
  assert.equal(config.appEnabled, true);
  assert.equal(config.smsEnabled, true);
  assert.equal(config.allowRegistration, true);
  assert.equal(config.accessKeyId, 'env-ak');
  assert.equal(config.accessKeySecret, 'env-secret');
  assert.equal(config.securityToken, 'env-sts');
  assert.equal(config.sceneCode, 'scene-1');
  assert.equal(config.smsSchemeName, 'scheme-1');
  assert.deepEqual(config.smsTemplateParam, { code: '##code##' });
});

// ---------------------------------------------------------------------------
// Legacy RPC HMAC-SHA1 signing (research/aliyun-signing.md)
// ---------------------------------------------------------------------------

// Independent RFC3986 encoder for verifying the adapter — deliberately NOT reusing any helper
// from phone-auth.js, so a broken helper cannot make this test pass against itself.
function rfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Rebuild the Aliyun string-to-sign from the *captured, decoded* request params. The official
// algorithm percent-encodes each key/value, joins with '&', then percent-encodes that query a
// second time for the signature, so a literal space renders as %2520 and '*' as %252A.
function aliyunStringToSign(params) {
  const canonical = Object.keys(params)
    .sort()
    .map(name => `${rfc3986(name)}=${rfc3986(params[name])}`)
    .join('&');
  return `POST&%2F&${rfc3986(canonical)}`;
}

test('RPC signing uses RFC3986 encoding, sorted keys and the documented HMAC-SHA1 form', () => {
  const params = { Action: 'GetAuthToken', Version: '2017-05-25', Name: 'a b*c~d' };
  const stringToSign = phoneAuth.buildStringToSign('POST', params);
  // Sorted: Action, Name, Version. Each value is encoded once inside the canonical query, then
  // the whole query is encoded again, so ' ' -> %2520 and '*' -> %252A while '~' stays raw.
  assert.equal(
    stringToSign,
    'POST&%2F&Action%3DGetAuthToken%26Name%3Da%2520b%252Ac~d%26Version%3D2017-05-25'
  );
  assert.equal(phoneAuth.percentEncode("!*'()"), '%21%2A%27%28%29');
  assert.equal(phoneAuth.percentEncode('~'), '~', 'tilde must stay unescaped');
});

test('the emitted Signature verifies against the captured request params, independently', async () => {
  const calls = [];
  const client = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', TokenInfo: { AccessToken: 'at', JwtToken: 'jwt' } }, calls)
  });
  await client.getH5AuthToken();
  const sent = { ...calls[0].params };
  const signature = sent.Signature;
  assert.ok(signature, 'a Signature was transmitted');
  delete sent.Signature;

  // Recompute from the actual transmitted (unsigned) parameters using an independent encoder.
  const expected = crypto
    .createHmac('sha1', 'test-ak-secret&')
    .update(aliyunStringToSign(sent), 'utf8')
    .digest('base64');
  assert.equal(signature, expected, 'transmitted Signature covers exactly the transmitted params');

  // Flipping any signed value must invalidate the signature check below.
  const tampered = { ...sent, SceneCode: '9999999999' };
  const tamperedExpected = crypto
    .createHmac('sha1', 'test-ak-secret&')
    .update(aliyunStringToSign(tampered), 'utf8')
    .digest('base64');
  assert.notEqual(signature, tamperedExpected, 'changing a signed parameter changes the signature');
});

// ---------------------------------------------------------------------------
// H5 one-click login: GetAuthToken (BizType=1) + GetPhoneWithToken
// ---------------------------------------------------------------------------

test('H5 GetAuthToken sends the documented common parameters and BizType=1', async () => {
  const calls = [];
  const client = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', TokenInfo: { AccessToken: 'at-1', JwtToken: 'jwt-1' } }, calls)
  });
  const result = await client.getH5AuthToken();
  assert.deepEqual(result, { accessToken: 'at-1', jwtToken: 'jwt-1' });

  assert.equal(calls.length, 1);
  const { url, method, headers, params } = calls[0];
  assert.equal(url, phoneAuth.API_ENDPOINT);
  assert.equal(url, 'https://dypnsapi.aliyuncs.com/');
  assert.equal(method, 'POST');
  assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(params.Action, 'GetAuthToken');
  assert.equal(params.Version, '2017-05-25');
  assert.equal(params.Format, 'JSON');
  assert.equal(params.AccessKeyId, 'test-ak-id');
  assert.equal(params.SignatureMethod, 'HMAC-SHA1');
  assert.equal(params.SignatureVersion, '1.0');
  assert.equal(params.BizType, '1', 'one-click login uses BizType=1');
  assert.equal(params.SceneCode, '1000000001');
  assert.equal(params.Origin, 'https://gateway.example.test');
  assert.match(params.Timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'UTC timestamp without ms');
  assert.ok(params.SignatureNonce && params.SignatureNonce.length >= 16);
  assert.ok(params.Signature && !params.Signature.includes(' '), 'Base64 signature is a single form value');
});

test('H5 GetAuthToken rejects non-OK and incomplete token responses', async () => {
  const rejected = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'isv.BUSINESS_LIMIT_CONTROL', Message: 'limit' })
  });
  await assert.rejects(() => rejected.getH5AuthToken(), error => error.code === 'upstream_rejected');

  const partial = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', TokenInfo: { AccessToken: 'at-only' } })
  });
  await assert.rejects(() => partial.getH5AuthToken(), error => error.code === 'upstream_incomplete');
});

test('H5 GetPhoneWithToken extracts the E.164 mobile from Data.Mobile', async () => {
  const calls = [];
  const client = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', Data: { Mobile: '13800138000' } }, calls)
  });
  assert.equal(await client.getH5Phone('sp-token-1'), '+8613800138000');
  assert.equal(calls[0].params.Action, 'GetPhoneWithToken');
  assert.equal(calls[0].params.SpToken, 'sp-token-1');
});

test('H5 GetPhoneWithToken rejects masked, partial and non-mainland numbers', async () => {
  // Note: a leading +1 like '+14155550123' would still pass the mainland pattern, so these cases
  // Explicit foreign country prefixes must never be reinterpreted as mainland national numbers.
  for (const mobile of ['138****8000', '1380013', '23800138000', '+14155550123', '0014155550123', '', undefined]) {
    const client = phoneAuth.createClient(VALID_CONFIG, {
      fetchImpl: fakeTransport({ Code: 'OK', Data: { Mobile: mobile } })
    });
    await assert.rejects(() => client.getH5Phone('sp'), error => error.code === 'upstream_incomplete',
      `mobile ${JSON.stringify(mobile)} must not grant phone authority`);
  }
  const missingProof = phoneAuth.createClient(VALID_CONFIG, { fetchImpl: fakeTransport({ Code: 'OK' }) });
  await assert.rejects(() => missingProof.getH5Phone(''), error => error.code === 'invalid_proof');
});

// ---------------------------------------------------------------------------
// App GetMobile
// ---------------------------------------------------------------------------

test('App GetMobile extracts the phone from GetMobileResultDTO.Mobile', async () => {
  const calls = [];
  const client = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', GetMobileResultDTO: { Mobile: '13900139000' } }, calls)
  });
  assert.equal(await client.getAppPhone('app-access-token'), '+8613900139000');
  assert.equal(calls[0].params.Action, 'GetMobile');
  assert.equal(calls[0].params.AccessToken, 'app-access-token');
});

test('App GetMobile fails closed on error and incomplete payloads', async () => {
  const error = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'isv.INVALID_PARAMETERS', Message: 'bad token' })
  });
  await assert.rejects(() => error.getAppPhone('x'), err => err.code === 'upstream_rejected');
  const incomplete = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', GetMobileResultDTO: { Mobile: '138****8000' } })
  });
  await assert.rejects(() => incomplete.getAppPhone('x'), err => err.code === 'upstream_incomplete');
});

// ---------------------------------------------------------------------------
// SMS SendSmsVerifyCode / CheckSmsVerifyCode
// ---------------------------------------------------------------------------

test('SendSmsVerifyCode sends the documented anti-abuse parameters and never returns the code', async () => {
  const calls = [];
  const client = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', RequestId: 'req-1', Model: { BizId: 'biz-1', VerifyCode: '123456' } }, calls)
  });
  const result = await client.sendSms('13800138000', 'out-1');
  assert.deepEqual(result, { requestId: 'req-1', bizId: 'biz-1' });
  assert.ok(!JSON.stringify(result).includes('123456'), 'the provider code must never be surfaced');

  const { params } = calls[0];
  assert.equal(params.Action, 'SendSmsVerifyCode');
  assert.equal(params.PhoneNumber, '13800138000', 'national number without the +86 prefix');
  assert.equal(params.CountryCode, '86');
  assert.equal(params.SignName, 'Example');
  assert.equal(params.TemplateCode, 'SMS_000001');
  assert.equal(params.CodeLength, '6');
  assert.equal(params.ValidTime, '300');
  assert.equal(params.Interval, '60');
  assert.equal(params.DuplicatePolicy, '1');
  assert.equal(params.ReturnVerifyCode, 'false');
  assert.equal(params.OutId, 'out-1');
  assert.deepEqual(JSON.parse(params.TemplateParam), phoneAuth.DEFAULT_SMS_TEMPLATE_PARAM);
});

test('CheckSmsVerifyCode requires Model.VerifyResult=PASS, not merely Code=OK', async () => {
  const pass = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', Model: { VerifyResult: 'PASS' } })
  });
  assert.equal(await pass.verifySms('13800138000', '123456', 'out-1'), true);

  for (const model of [{ VerifyResult: 'FAIL' }, {}, { VerifyResult: 'pass' }, null]) {
    const client = phoneAuth.createClient(VALID_CONFIG, {
      fetchImpl: fakeTransport({ Code: 'OK', Model: model })
    });
    assert.equal(await client.verifySms('13800138000', '123456', 'out-1'), false,
      `Model ${JSON.stringify(model)} must not verify`);
  }

  // A non-OK envelope is a failed verification regardless of any Model content.
  const rejected = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'isv.INVALID_PARAMETERS', Model: { VerifyResult: 'PASS' } })
  });
  assert.equal(await rejected.verifySms('13800138000', '123456', 'out-1'), false);
});

test('SMS verification sends the same SchemeName isolation parameters as sending', async () => {
  const calls = [];
  const client = phoneAuth.createClient(
    { ...VALID_CONFIG, smsSchemeName: 'login-scheme' },
    { fetchImpl: fakeTransport({ Code: 'OK', Model: { VerifyResult: 'PASS' } }, calls) }
  );
  await client.verifySms('13800138000', '123456', 'out');
  assert.equal(calls[0].params.Action, 'CheckSmsVerifyCode');
  assert.equal(calls[0].params.SchemeName, 'login-scheme');
  assert.equal(calls[0].params.VerifyCode, '123456');
  assert.equal(calls[0].params.CountryCode, '86');
});

test('invalid mainland numbers never reach the SMS transport', async () => {
  const calls = [];
  const client = phoneAuth.createClient(VALID_CONFIG, { fetchImpl: fakeTransport({ Code: 'OK' }, calls) });
  for (const phone of ['', '123', '1380013800a', '23800138000', '+14155550123', '0014155550123']) {
    await assert.rejects(() => client.sendSms(phone, 'out'), error => error.code === 'invalid_phone',
      `${JSON.stringify(phone)} is not a mainland phone`);
  }
  assert.equal(calls.length, 0, 'no upstream call for an invalid phone');
});

// ---------------------------------------------------------------------------
// Transport failures and configuration gating
// ---------------------------------------------------------------------------

test('upstream transport failures surface only fixed messages', async () => {
  const throwing = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: async () => { throw new Error('ECONNRESET secret-provider-detail'); }
  });
  await assert.rejects(() => throwing.sendSms('13800138000', 'out'), error => {
    assert.equal(error.code, 'upstream_error');
    assert.ok(!/ECONNRESET|secret-provider-detail/.test(error.message));
    return true;
  });

  const badJson = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: async () => ({ async text() { return '<html>404</html>'; } })
  });
  await assert.rejects(() => badJson.getH5Phone('sp'), error => error.code === 'upstream_error');
});

test('disabled channels throw channel_disabled and make zero transport calls', async () => {
  const disabledCalls = [];
  const disabled = phoneAuth.createClient(phoneAuth.normalizeConfig({}), {
    fetchImpl: throwingTransport(disabledCalls)
  });
  // Every channel is off by default, so each method reports channel_disabled (not not_configured).
  await assert.rejects(() => disabled.getH5AuthToken(), error => error.code === 'channel_disabled');
  await assert.rejects(() => disabled.getH5Phone('sp'), error => error.code === 'channel_disabled');
  await assert.rejects(() => disabled.getAppPhone('at'), error => error.code === 'channel_disabled');
  await assert.rejects(() => disabled.sendSms('13800138000', 'out'), error => error.code === 'channel_disabled');
  await assert.rejects(() => disabled.verifySms('13800138000', '123456', 'out'), error => error.code === 'channel_disabled');
  assert.equal(disabledCalls.length, 0, 'disabled configuration must not touch the transport');
});

test('enabled-but-incomplete channels throw not_configured and make zero transport calls', async () => {
  // Channel switches are on but no credentials / required fields exist, so readiness fails.
  const incompleteCalls = [];
  const incomplete = phoneAuth.createClient(phoneAuth.normalizeConfig({ h5Enabled: true, smsEnabled: true }), {
    fetchImpl: throwingTransport(incompleteCalls)
  });
  await assert.rejects(() => incomplete.getH5AuthToken(), error => error.code === 'not_configured');
  await assert.rejects(() => incomplete.getH5Phone('sp'), error => error.code === 'not_configured');
  await assert.rejects(() => incomplete.sendSms('13800138000', 'out'), error => error.code === 'not_configured');
  await assert.rejects(() => incomplete.verifySms('13800138000', '123456', 'out'), error => error.code === 'not_configured');
  assert.equal(incompleteCalls.length, 0, 'incomplete configuration must not touch the transport');
});

test('phone normalization accepts E.164 and mainland 11-digit forms but the adapter sends the national number', async () => {
  for (const input of ['13800138000', '+8613800138000', '008613800138000', '86 138 0013 8000']) {
    const normalized = phoneNumbers.normalizePhone(input);
    assert.ok(normalized, `${input} normalizes`);
    assert.equal(normalized.e164, '+8613800138000', input);
  }
  const calls = [];
  const client = phoneAuth.createClient(VALID_CONFIG, {
    fetchImpl: fakeTransport({ Code: 'OK', Model: { BizId: 'b' } }, calls)
  });
  await client.sendSms('+8613800138000', 'out');
  assert.equal(calls[0].params.PhoneNumber, '13800138000', 'E.164 input is split into CountryCode + national');
  assert.equal(calls[0].params.CountryCode, '86');
});
