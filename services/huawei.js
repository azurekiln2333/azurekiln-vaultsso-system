// 华为账号一键登录（获取手机号和 UnionID/OpenID）服务端适配。
//
// 授权码接口使用 POST + JSON code/clientId/clientSecret；它不同于旧版
// access_token + form 的 UserInfo 接口。HTTP 200 也可能包含 resultCode 错误。

const { normalizeParts, normalizePhone, normalizeCountryCode } = require('./phone');

const HUAWEI_QUICK_LOGIN_URL = 'https://account-api.cloud.huawei.com/oauth2/v6/quickLogin/getPhoneNumber';
const OBSOLETE_QUICK_LOGIN_URL = 'https://oauth-login.cloud.huawei.com/oauth2/v6/quickLogin/getPhoneNumber';
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

class HuaweiError extends Error {
  constructor(message, { status = 502, error = 'huawei_upstream_error', description = '华为账号服务暂时不可用，请稍后重试' } = {}) {
    super(message);
    this.status = status;
    this.publicCode = error;
    this.publicDescription = description;
  }
}

function businessError(code) {
  const message = `Huawei endpoint returned resultCode ${/^\d{8}$/.test(code) ? code : 'unknown'}`;
  if (['60010012', '60180004', '60180005', '60180006'].includes(code)) {
    return new HuaweiError(message, { status: 400, error: 'invalid_grant', description: '华为账号授权码无效或已过期，请重新发起登录' });
  }
  if (['60010002', '60010013', '60180003'].includes(code)) {
    const description = code === '60180003' ? '华为账号 Client ID 与应用不一致，请联系管理员检查配置'
      : code === '60010013' ? '华为账号服务凭据配置错误，请联系管理员'
        : '华为账号服务请求参数错误，请联系管理员检查配置';
    return new HuaweiError(message, { status: 503, error: 'huawei_not_configured', description });
  }
  if (code === '60180007') {
    return new HuaweiError(message, { status: 403, error: 'huawei_permission_required', description: '华为账号授权未包含一键登录权限，请使用其他登录方式' });
  }
  if (['60180008', '60180009'].includes(code)) {
    return new HuaweiError(message, { status: 400, error: 'huawei_phone_unavailable', description: '该华为账号无法使用手机号一键登录，请使用其他登录方式' });
  }
  return new HuaweiError(message);
}

function readValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return '';
}

function readFlag(source, keys, fallback) {
  const value = readValue(source, keys);
  if (!value) return fallback;
  return ['true', '1', 'yes', 'y'].includes(value.toLowerCase());
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) {
        controller.abort();
        throw new HuaweiError('Huawei response exceeds the maximum size');
      }
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (response.status === 404) {
      throw new HuaweiError('Huawei endpoint returned HTTP 404', {
        description: '华为账号服务地址无效，请联系管理员检查提供方配置'
      });
    }
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      throw new HuaweiError(`Huawei endpoint returned invalid JSON (${response.status})`);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HuaweiError('Huawei endpoint returned an invalid response');
    }
    const resultCode = readValue(payload, ['resultCode']);
    if (resultCode && resultCode !== '0') throw businessError(resultCode);
    if (!response.ok) {
      throw new HuaweiError(`Huawei endpoint returned HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error instanceof HuaweiError) throw error;
    throw new HuaweiError('Huawei endpoint request failed', {
      description: '暂时无法连接华为账号服务，请稍后重试'
    });
  } finally {
    clearTimeout(timeout);
  }
}

// 用 authorization code 换取华为账号标识与绑定手机号。
// config 需要 clientId / clientSecret；endpoint 默认使用华为官方地址，测试可覆盖。
async function exchangeQuickLoginCode(config, code, endpoint = HUAWEI_QUICK_LOGIN_URL) {
  const authorizationCode = String(code || '').trim();
  if (!authorizationCode) throw new HuaweiError('Huawei authorization code is missing', {
    status: 400, error: 'invalid_grant', description: '华为账号授权码无效或已过期'
  });
  if (!config?.clientId || !config?.clientSecret) throw new HuaweiError('Huawei provider credentials are not configured', {
    status: 503, error: 'huawei_not_configured', description: '华为账号登录未配置或未启用'
  });

  const body = {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code: authorizationCode
  };
  // 已保存的旧默认地址在调用时纠正，无需改写数据库中的提供方配置。
  const url = endpoint === OBSOLETE_QUICK_LOGIN_URL ? HUAWEI_QUICK_LOGIN_URL : endpoint;
  const payload = await postJson(url, body);
  return parseHuaweiIdentity(payload);
}

// 华为的区号字段是「00 + 国际电话区号」（如 0086），
// 必须剥掉前导 00 再入库，否则会写出 +0086… 这种脏数据。
function parseHuaweiPhone(payload) {
  const countryCodeRaw = readValue(payload, ['phoneCountryCode', 'phone_country_code', 'countryCode', 'country_code']);
  const pureNumber = readValue(payload, ['purePhoneNumber', 'pure_phone_number']);
  const fullNumber = readValue(payload, ['phoneNumber', 'phone_number', 'loginMobileNumber', 'login_mobile_number', 'mobileNumber', 'mobile_number']);
  const countryCode = normalizeCountryCode(countryCodeRaw);
  if (countryCodeRaw && !countryCode) return null;

  // Generic phone normalization strips arbitrary characters. Reject them at the provider boundary
  // so masked and malformed upstream values cannot turn into a different dialable number.
  const pure = pureNumber && /^[0-9]+$/.test(pureNumber) && countryCode
    ? normalizeParts(countryCode, pureNumber) : null;
  let full = null;
  if (fullNumber && /^\+?[0-9\s\-().\u3000]+$/.test(fullNumber)) {
    const compact = fullNumber.replace(/[\s\-().\u3000]/g, '');
    if (compact.startsWith('+') || compact.startsWith('00')) {
      full = normalizePhone(compact);
    } else if (countryCode && compact.startsWith(countryCode)) {
      full = normalizeParts(countryCode, compact.slice(countryCode.length));
    } else if (countryCode) {
      // Historical loginMobileNumber aliases may contain only the national number.
      full = normalizeParts(countryCode, compact);
    }
  }

  if (full && countryCode && full.countryCode !== countryCode) return null;
  if (full && pure && full.e164 !== pure.e164) return null;
  return full || pure;
}

function parseHuaweiIdentity(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const openId = readValue(source, ['openId', 'openID', 'open_id', 'openid']);
  const unionId = readValue(source, ['unionId', 'unionID', 'union_id', 'unionid']);
  const phone = parseHuaweiPhone(source);
  // 一键登录返回的号码由华为侧完成验证；仅在华为明确回传无效时降级。
  const phoneVerified = Boolean(phone) && readFlag(source, ['phoneNumberValid', 'phone_number_valid', 'loginMobileValid', 'login_mobile_valid'], true);

  return {
    openId,
    unionId,
    phone,
    phoneVerified,
    displayName: readValue(source, ['displayName', 'display_name']),
    avatar: readValue(source, ['headPictureURL', 'head_picture_url', 'picture']),
    raw: source
  };
}

module.exports = {
  HUAWEI_QUICK_LOGIN_URL,
  HuaweiError,
  exchangeQuickLoginCode,
  parseHuaweiIdentity,
  parseHuaweiPhone
};
