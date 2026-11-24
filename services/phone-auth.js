// 阿里云号码认证服务（PNVS / Dypnsapi 2017-05-25）适配层。
//
// 边界：
// - 只请求固定的官方生产端点，绝不接受请求方指定的上游地址或凭据。
// - 所有上游调用都有硬超时，失败一律抛出固定文案的 PhoneAuthError，
//   绝不把上游原文、密钥、令牌或明文手机号透出到错误里。
// - 号码只以 E.164 返回给调用方；任何缺失/掩码/部分号码都视为取号失败。
//
// 官方协议依据（research/aliyun-contract.md）：
//   GetAuthToken        Code=OK -> TokenInfo.AccessToken / TokenInfo.JwtToken
//   GetPhoneWithToken   Code=OK -> Data.Mobile
//   GetMobile           Code=OK -> GetMobileResultDTO.Mobile
//   SendSmsVerifyCode   Code=OK -> Model.BizId / Model.RequestId
//   CheckSmsVerifyCode  Code=OK 不足以证明核验成功，必须 Model.VerifyResult === 'PASS'

'use strict';

const crypto = require('node:crypto');
const phoneNumbers = require('./phone');

// 固定官方网关（RPC 风格）。国内站生产端点。
const API_ENDPOINT = 'https://dypnsapi.aliyuncs.com/';
const API_VERSION = '2017-05-25';
const REQUEST_TIMEOUT_MS = 10000;
// 一键登录场景的 BizType 固定为 1；本适配层不提供“本机号码认证”(0) 能力。
const H5_BIZ_TYPE = 1;
const SMS_CODE_TTL_SECONDS = 300;
const SMS_RESEND_SECONDS = 60;

const DEFAULT_SMS_TEMPLATE_PARAM = { code: '##code##', min: '5' };

// 公共签名参数：业务参数不得覆盖，避免 Action/Version/凭据被改写。
const PUBLIC_PARAM_KEYS = new Set([
  'Action', 'Version', 'Format', 'AccessKeyId', 'SignatureMethod',
  'SignatureVersion', 'SignatureNonce', 'Timestamp', 'SecurityToken', 'Signature'
]);

const ENV_PREFIX = 'PHONE_AUTH_';

// 公开配置里只暴露能力位与 SDK 地址，绝不含任何密钥。
const SECRET_FIELDS = ['accessKeySecret', 'securityToken'];

class PhoneAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PhoneAuthError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PhoneAuthError(code, message);
}

// ---------------------------------------------------------------------------
// 配置：归一化 / 环境变量 / 投影
// ---------------------------------------------------------------------------

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off', ''].includes(text)) return false;
  }
  return fallback;
}

function normalizeString(value, maxLength = 512) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).trim().slice(0, maxLength);
}

// 模板参数必须是对象；非法/非对象一律回落到官方默认值，避免把坏数据发给上游。
function normalizeTemplateParam(value, fallback) {
  let parsed = value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return fallback;
    try {
      parsed = JSON.parse(text);
    } catch {
      return fallback;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return fallback;
  const result = {};
  for (const [key, item] of entries) {
    const name = normalizeString(key, 32);
    if (!name) continue;
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    result[name] = String(item).slice(0, 64);
  }
  return Object.keys(result).length ? result : fallback;
}

// SDK 地址既可以是同源路径（推荐自托管在 /js/…），也可以是完整 HTTPS 地址。
// 不接受其它协议，也不接受协议相对 //host 这种难以判断来源的写法。
function normalizeSdkUrl(value) {
  const text = normalizeString(value, 512);
  if (!text) return '';
  // 同源绝对路径：必须以单个 / 开头。
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  const url = normalizeUrl(text);
  if (!url) return '';
  // SDK 只能是 HTTPS（避免混合内容与脚本篡改）。
  try {
    return new URL(url).protocol === 'https:' ? url : '';
  } catch {
    return '';
  }
}

function blankConfig() {
  return {
    h5Enabled: false,
    appEnabled: false,
    smsEnabled: false,
    allowRegistration: false,
    accessKeyId: '',
    accessKeySecret: '',
    securityToken: '',
    sceneCode: '',
    h5Origin: '',
    h5Url: '',
    h5SdkUrl: '',
    smsSchemeName: '',
    smsSignName: '',
    smsTemplateCode: '',
    smsTemplateParam: { ...DEFAULT_SMS_TEMPLATE_PARAM }
  };
}

/**
 * 合并配置。规则与既有 Turnstile 配置一致：
 * - 空白的密钥字段表示“保留当前值”；
 * - clearAccessKeySecret / clearSecurityToken 显式清空；
 * - 其余字段按类型严格归一化，非法值回落默认。
 */
function normalizeConfig(input, current = {}) {
  const base = { ...blankConfig(), ...(current || {}) };
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const next = blankConfig();

  for (const flag of ['h5Enabled', 'appEnabled', 'smsEnabled', 'allowRegistration']) {
    next[flag] = Object.prototype.hasOwnProperty.call(source, flag)
      ? normalizeBoolean(source[flag], false)
      : normalizeBoolean(base[flag], false);
  }

  next.accessKeyId = Object.prototype.hasOwnProperty.call(source, 'accessKeyId')
    ? normalizeString(source.accessKeyId, 128)
    : normalizeString(base.accessKeyId, 128);

  // 密钥：空白保留；显式 clear 清空；否则接受新值。
  if (normalizeBoolean(source.clearAccessKeySecret, false)) {
    next.accessKeySecret = '';
  } else {
    const provided = normalizeString(source.accessKeySecret, 256);
    next.accessKeySecret = provided || normalizeString(base.accessKeySecret, 256);
  }

  if (normalizeBoolean(source.clearSecurityToken, false)) {
    next.securityToken = '';
  } else {
    const provided = normalizeString(source.securityToken, 4096);
    next.securityToken = provided || normalizeString(base.securityToken, 4096);
  }

  next.sceneCode = Object.prototype.hasOwnProperty.call(source, 'sceneCode')
    ? normalizeString(source.sceneCode, 64)
    : normalizeString(base.sceneCode, 64);
  next.h5Origin = Object.prototype.hasOwnProperty.call(source, 'h5Origin')
    ? normalizeUrl(source.h5Origin)
    : normalizeUrl(base.h5Origin);
  next.h5Url = Object.prototype.hasOwnProperty.call(source, 'h5Url')
    ? normalizeUrl(source.h5Url)
    : normalizeUrl(base.h5Url);
  next.h5SdkUrl = Object.prototype.hasOwnProperty.call(source, 'h5SdkUrl')
    ? normalizeSdkUrl(source.h5SdkUrl)
    : normalizeSdkUrl(base.h5SdkUrl);
  next.smsSchemeName = Object.prototype.hasOwnProperty.call(source, 'smsSchemeName')
    ? normalizeString(source.smsSchemeName, 20)
    : normalizeString(base.smsSchemeName, 20);
  next.smsSignName = Object.prototype.hasOwnProperty.call(source, 'smsSignName')
    ? normalizeString(source.smsSignName, 64)
    : normalizeString(base.smsSignName, 64);
  next.smsTemplateCode = Object.prototype.hasOwnProperty.call(source, 'smsTemplateCode')
    ? normalizeString(source.smsTemplateCode, 64)
    : normalizeString(base.smsTemplateCode, 64);

  const templateFallback = normalizeTemplateParam(base.smsTemplateParam, DEFAULT_SMS_TEMPLATE_PARAM);
  next.smsTemplateParam = Object.prototype.hasOwnProperty.call(source, 'smsTemplateParam')
    ? normalizeTemplateParam(source.smsTemplateParam, templateFallback)
    : templateFallback;

  return next;
}

/** 从环境变量读取（PHONE_AUTH_ 前缀 + 大写蛇形命名）。 */
function fromEnvironment(env = process.env) {
  const source = env || {};
  const read = name => source[`${ENV_PREFIX}${name}`];

  return normalizeConfig({
    h5Enabled: read('H5_ENABLED'),
    appEnabled: read('APP_ENABLED'),
    smsEnabled: read('SMS_ENABLED'),
    allowRegistration: read('ALLOW_REGISTRATION'),
    accessKeyId: read('ACCESS_KEY_ID'),
    accessKeySecret: read('ACCESS_KEY_SECRET'),
    securityToken: read('SECURITY_TOKEN'),
    sceneCode: read('SCENE_CODE'),
    h5Origin: read('H5_ORIGIN'),
    h5Url: read('H5_URL'),
    h5SdkUrl: read('H5_SDK_URL'),
    smsSchemeName: read('SMS_SCHEME_NAME'),
    smsSignName: read('SMS_SIGN_NAME'),
    smsTemplateCode: read('SMS_TEMPLATE_CODE'),
    smsTemplateParam: read('SMS_TEMPLATE_PARAM')
  });
}

function hasBaseCredentials(config) {
  return Boolean(config && config.accessKeyId && config.accessKeySecret);
}

function h5Ready(config) {
  // SDK 地址是前端能否真正拉起授权页的前提，必须是一个**实际可用**的地址
  // （同源路径或 HTTPS），而不是随便一个非空字符串。
  return Boolean(hasBaseCredentials(config) && config.sceneCode && config.h5Origin && config.h5Url
    && normalizeSdkUrl(config.h5SdkUrl));
}

function appReady(config) {
  return hasBaseCredentials(config);
}

function smsReady(config) {
  return Boolean(hasBaseCredentials(config) && config.smsSignName && config.smsTemplateCode);
}

/** 公开投影：只给前端能力位，绝不含密钥。 */
function publicConfig(config) {
  const safe = { ...blankConfig(), ...(config || {}) };
  return {
    h5: {
      enabled: Boolean(safe.h5Enabled),
      available: Boolean(safe.h5Enabled) && h5Ready(safe),
      sdkUrl: normalizeSdkUrl(safe.h5SdkUrl)
    },
    app: {
      enabled: Boolean(safe.appEnabled),
      available: Boolean(safe.appEnabled) && appReady(safe)
    },
    sms: {
      enabled: Boolean(safe.smsEnabled),
      available: Boolean(safe.smsEnabled) && smsReady(safe),
      resendSeconds: SMS_RESEND_SECONDS
    },
    registrationEnabled: Boolean(safe.allowRegistration)
  };
}

/** 管理端投影：返回非密钥字段 + 密钥是否存在标志。 */
function adminConfig(config) {
  const safe = normalizeConfig(config || {}, config || {});
  return {
    h5Enabled: safe.h5Enabled,
    appEnabled: safe.appEnabled,
    smsEnabled: safe.smsEnabled,
    allowRegistration: safe.allowRegistration,
    accessKeyId: safe.accessKeyId,
    hasAccessKeySecret: Boolean(safe.accessKeySecret),
    hasSecurityToken: Boolean(safe.securityToken),
    sceneCode: safe.sceneCode,
    h5Origin: safe.h5Origin,
    h5Url: safe.h5Url,
    h5SdkUrl: safe.h5SdkUrl,
    smsSchemeName: safe.smsSchemeName,
    smsSignName: safe.smsSignName,
    smsTemplateCode: safe.smsTemplateCode,
    smsTemplateParam: { ...safe.smsTemplateParam },
    ready: {
      h5: h5Ready(safe),
      app: appReady(safe),
      sms: smsReady(safe)
    }
  };
}

// ---------------------------------------------------------------------------
// 官方 RPC 签名（HMAC-SHA1 + RFC3986 百分号编码）
// ---------------------------------------------------------------------------

// 阿里云要求的百分号编码：在 encodeURIComponent 之上补齐 !'()* 与 +，保留 ~。
function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/%20/g, '%20');
}

function buildStringToSign(method, params) {
  const canonical = Object.keys(params)
    .sort()
    .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  return `${method.toUpperCase()}&${percentEncode('/')}&${percentEncode(canonical)}`;
}

function signParams(method, params, accessKeySecret) {
  const stringToSign = buildStringToSign(method, params);
  return crypto
    .createHmac('sha1', `${accessKeySecret}&`)
    .update(stringToSign, 'utf8')
    .digest('base64');
}

function buildSignedParams(config, action, actionParams) {
  const params = {
    Action: action,
    Version: API_VERSION,
    Format: 'JSON',
    AccessKeyId: config.accessKeyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
  if (config.securityToken) params.SecurityToken = config.securityToken;
  for (const [key, value] of Object.entries(actionParams)) {
    if (value === undefined || value === null || value === '') continue;
    // 公共参数不可被业务参数覆盖：GetAuthToken 的可选业务 Version 曾与 API Version 撞名，
    // 这里统一挡住，避免签名与请求版本被调用方意外改写。
    if (PUBLIC_PARAM_KEYS.has(key)) continue;
    params[key] = typeof value === 'string' ? value : String(value);
  }
  params.Signature = signParams('POST', params, config.accessKeySecret);
  return params;
}

// ---------------------------------------------------------------------------
// 号码提取：只接受完整、可归一化的中国大陆手机号
// ---------------------------------------------------------------------------

const MAINLAND_MOBILE = /^1[3-9][0-9]{9}$/;

/**
 * 把各种写法（+86…、0086…、86…、裸 11 位、带分隔符）收敛成
 * `{ e164: '+86…', nationalNumber: '1xx…' }`，不合法返回 null。
 *
 * 注意：不能把 E.164 值再交给 normalizeParts('86', …)——那会把 86 再次
 * 拼进国内号码，产生 +8686138…。这里显式剥掉国码后做严格校验。
 */
function normalizeMainlandPhone(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  // 掩码或部分号码（含 * ）一律拒绝，不能让脱敏号码拿到取号权威。
  if (!text || text.includes('*')) return null;

  const compact = text.replace(/[\s\-().\u3000]/g, '');
  let digits;
  if (compact.startsWith('+')) {
    // A full international E.164 input must explicitly use China's +86 prefix.
    // Otherwise e.g. +14155550123 would be misread as a mainland 11-digit number.
    if (!compact.startsWith('+86')) return null;
    digits = compact.slice(3);
  } else if (compact.startsWith('00')) {
    // International dialing prefix is accepted only when followed by China's 86.
    if (!compact.startsWith('0086')) return null;
    digits = compact.slice(4);
  } else {
    digits = compact;
    // Also accept the provider-style bare 86 + national number form.
    if (digits.startsWith('86') && digits.length > 11) digits = digits.slice(2);
  }
  if (!MAINLAND_MOBILE.test(digits)) return null;

  const e164 = `+86${digits}`;
  // 用公共归一化器复核一次，确保与库内 phone_e164 写法完全一致。
  const verified = phoneNumbers.normalizePhone(e164);
  if (!verified || verified.countryCode !== '86' || verified.nationalNumber !== digits) return null;
  return { e164, nationalNumber: digits };
}

function extractMobile(value) {
  if (value === undefined || value === null) return '';
  // 官方响应可能给数字或字符串；解析失败应返回空串而不是部分号码。
  return normalizeMainlandPhone(value)?.e164 || '';
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

function createClient(config, { fetchImpl = globalThis.fetch } = {}) {
  const settings = normalizeConfig(config || {}, config || {});
  if (typeof fetchImpl !== 'function') fail('config_invalid', '号码认证传输不可用');

  async function call(action, actionParams) {
    if (!hasBaseCredentials(settings)) fail('not_configured', '号码认证服务未配置');
    const body = new URLSearchParams(buildSignedParams(settings, action, actionParams)).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let payload;
    try {
      const response = await fetchImpl(API_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
        // 不跟随重定向：任何跳转都意味着实际请求的已经不是固定官方端点，
        // 一律当成上游故障，避免凭据被带到别的主机。
        redirect: 'error'
      });
      if (!response || typeof response.text !== 'function') fail('upstream_error', '号码认证服务暂时不可用');
      // 非 2xx 一律当成上游故障；不把状态行或响应体透出给调用方。
      if (typeof response.ok === 'boolean' && !response.ok) fail('upstream_error', '号码认证服务暂时不可用');
      let text;
      try {
        text = await response.text();
      } catch {
        fail('upstream_error', '号码认证服务暂时不可用');
      }
      try {
        payload = JSON.parse(text);
      } catch {
        fail('upstream_error', '号码认证服务暂时不可用');
      }
    } catch (error) {
      if (error instanceof PhoneAuthError) throw error;
      fail('upstream_error', '号码认证服务暂时不可用');
    } finally {
      clearTimeout(timer);
    }
    if (!payload || typeof payload !== 'object') fail('upstream_error', '号码认证服务暂时不可用');
    return payload;
  }

  function ensureOk(payload) {
    if (!payload || payload.Code !== 'OK') fail('upstream_rejected', '号码认证未通过');
    return payload;
  }

  return {
    /** H5 一键登录授权令牌。 */
    async getH5AuthToken() {
      // enabled 与就绪双重检查：关闭但已配置的通道必须零上游请求。
      if (!settings.h5Enabled) fail('channel_disabled', 'H5 一键登录未启用');
      if (!h5Ready(settings)) fail('not_configured', 'H5 一键登录未就绪');
      const payload = ensureOk(await call('GetAuthToken', {
        Origin: settings.h5Origin,
        Url: settings.h5Url,
        SceneCode: settings.sceneCode,
        BizType: H5_BIZ_TYPE
      }));
      const info = payload.TokenInfo;
      const accessToken = info && typeof info.AccessToken === 'string' ? info.AccessToken : '';
      const jwtToken = info && typeof info.JwtToken === 'string' ? info.JwtToken : '';
      if (!accessToken || !jwtToken) fail('upstream_incomplete', '号码认证未返回完整令牌');
      return { accessToken, jwtToken };
    },

    /** H5：用 JSSDK 返回的 spToken 换取手机号。 */
    async getH5Phone(spToken) {
      if (!settings.h5Enabled) fail('channel_disabled', 'H5 一键登录未启用');
      const token = normalizeString(spToken, 2048);
      if (!token) fail('invalid_proof', '缺少号码认证凭证');
      if (!h5Ready(settings)) fail('not_configured', 'H5 一键登录未就绪');
      const payload = ensureOk(await call('GetPhoneWithToken', { SpToken: token }));
      const mobile = extractMobile(payload.Data && payload.Data.Mobile);
      if (!mobile) fail('upstream_incomplete', '号码认证未返回完整号码');
      return mobile;
    },

    /** App：用原生 SDK 的 AccessToken 换取手机号。 */
    async getAppPhone(accessToken) {
      if (!settings.appEnabled) fail('channel_disabled', 'App 一键登录未启用');
      const token = normalizeString(accessToken, 2048);
      if (!token) fail('invalid_proof', '缺少号码认证凭证');
      if (!appReady(settings)) fail('not_configured', 'App 一键登录未就绪');
      const payload = ensureOk(await call('GetMobile', { AccessToken: token }));
      const mobile = extractMobile(payload.GetMobileResultDTO && payload.GetMobileResultDTO.Mobile);
      if (!mobile) fail('upstream_incomplete', '号码认证未返回完整号码');
      return mobile;
    },

    /** 发送短信验证码。返回安全的关联 ID，绝不回传上游验证码。 */
    async sendSms(phoneValue, outId) {
      if (!settings.smsEnabled) fail('channel_disabled', '短信验证码未启用');
      if (!smsReady(settings)) fail('not_configured', '短信验证码服务未就绪');
      const normalized = normalizeMainlandPhone(phoneValue);
      if (!normalized) fail('invalid_phone', '手机号格式不正确');
      const params = {
        CountryCode: '86',
        PhoneNumber: normalized.nationalNumber,
        SignName: settings.smsSignName,
        TemplateCode: settings.smsTemplateCode,
        TemplateParam: JSON.stringify(settings.smsTemplateParam),
        CodeType: 1,
        CodeLength: 6,
        ValidTime: SMS_CODE_TTL_SECONDS,
        DuplicatePolicy: 1,
        Interval: SMS_RESEND_SECONDS,
        ReturnVerifyCode: 'false',
        OutId: normalizeString(outId, 64)
      };
      if (settings.smsSchemeName) params.SchemeName = settings.smsSchemeName;
      const payload = ensureOk(await call('SendSmsVerifyCode', params));
      const model = payload.Model && typeof payload.Model === 'object' ? payload.Model : {};
      return {
        requestId: normalizeString(payload.RequestId || model.RequestId, 128),
        bizId: normalizeString(model.BizId, 128)
      };
    },

    /** 核验短信验证码。只有 Model.VerifyResult === 'PASS' 才返回 true。 */
    async verifySms(phoneValue, code, outId) {
      if (!settings.smsEnabled) fail('channel_disabled', '短信验证码未启用');
      if (!smsReady(settings)) fail('not_configured', '短信验证码服务未就绪');
      const normalized = normalizeMainlandPhone(phoneValue);
      if (!normalized) fail('invalid_phone', '手机号格式不正确');
      const verifyCode = normalizeString(code, 32);
      if (!verifyCode) fail('invalid_code', '验证码不正确');
      const params = {
        CountryCode: '86',
        PhoneNumber: normalized.nationalNumber,
        VerifyCode: verifyCode,
        CaseAuthPolicy: 1,
        OutId: normalizeString(outId, 64)
      };
      if (settings.smsSchemeName) params.SchemeName = settings.smsSchemeName;
      const payload = await call('CheckSmsVerifyCode', params);
      // Code=OK 只说明接口调用成功，核验结论只认 Model.VerifyResult。
      if (!payload || payload.Code !== 'OK') return false;
      const model = payload.Model && typeof payload.Model === 'object' ? payload.Model : {};
      return model.VerifyResult === 'PASS';
    }
  };
}

module.exports = {
  API_ENDPOINT,
  API_VERSION,
  ENV_PREFIX,
  PhoneAuthError,
  SECRET_FIELDS,
  SMS_CODE_TTL_SECONDS,
  SMS_RESEND_SECONDS,
  DEFAULT_SMS_TEMPLATE_PARAM,
  fromEnvironment,
  normalizeConfig,
  publicConfig,
  adminConfig,
  createClient,
  normalizeMainlandPhone,
  normalizeSdkUrl,
  // 导出供云端互操作测试复用，不改变上游调用面。
  percentEncode,
  buildStringToSign
};
