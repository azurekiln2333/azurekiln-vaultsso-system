// 天翼（中国电信 189）账号授权适配层。
//
// 与「网络一键登录」不同：这里是**运营商账号授权**（provider 类型 tianyi_web / tianyi_h5），
// 只产出应用维度的 openId 身份，绝不产出手机号/邮箱已验证声明。
//
// 协议依据（research/operator-oauth.md）：
//   WEB 授权：GET separate/unifyAccountLogin.do  clientType=10010 format=redirect version=v2.0
//   H5  授权：GET separate/autoLogin.do          clientType=20100 format=redirect version=v2.1
//   paras  = XXTEA(timeStamp=<ms>&returnURL=<url>[&state=<32字符>])，key = appSecret
//   sign   = UPPER_HEX(HMAC-SHA1(appId + clientType + format + version + paras, appSecret))
//   回调    = query 里的 appId / paras / sign；签名输入 appId + paras；解密 paras 得 result/code/state/timeStamp
//   换码    = POST accessToken.do，appId / grantType=authorization_login / code / format=json
//             sign = UPPER_HEX(HMAC-SHA1(appId + code + format + grantType, appSecret))
//             成功 result=10000，必须返回非空、应用维度的 openId
//
// 明确不做：guide 607 的 UserInfo（RSA 签名/解密细节在官方文档中未闭合），
// 因此不提供手机号/邮箱/验证状态任何声明。未闭合的 crypto 细节不猜测实现。

'use strict';

const crypto = require('node:crypto');

const WEB_AUTHORIZE_URL = 'https://open.e.189.cn/api/logbox/oauth2/separate/unifyAccountLogin.do';
const H5_AUTHORIZE_URL = 'https://open.e.189.cn/api/logbox/oauth2/separate/autoLogin.do';
const TOKEN_URL = 'https://open.e.189.cn/api/logbox/oauth2/accessToken.do';

const WEB_CLIENT_TYPE = '10010';
const H5_CLIENT_TYPE = '20100';
const WEB_VERSION = 'v2.0';
const H5_VERSION = 'v2.1';
const CALLBACK_FORMAT = 'redirect';
const TOKEN_FORMAT = 'json';
const TOKEN_GRANT_TYPE = 'authorization_login';

const TOKEN_SUCCESS_RESULT = '10000';
const CALLBACK_SUCCESS_RESULT = '0';

const MAX_STATE_LENGTH = 32;
const STATE_BYTES = 16; // 16 字节 -> 32 位十六进制字符，恰好满足 32 字符上限。
const REQUEST_TIMEOUT_MS = 10000;
// 回调时间戳新鲜度窗口（官方要求校验新鲜度；文档未给具体值，这里取常见的 10 分钟）。
const CALLBACK_MAX_AGE_MS = 10 * 60 * 1000;

// 官方指南 481 第 2.4 节公布的**非机密**算法参考向量，仅用于云端互操作校验。
// 本地不执行；由 CI 中的测试比对。
const OFFICIAL_XXTEA_VECTOR = Object.freeze({
  key: 'sAecMFcAlIXes93VaWXgr3jgMup4Y0a6',
  plaintext: 'a=1&b=2&c=3',
  ciphertextHex: 'f6c45d934cde581e908d02487720161d'
});

class TianyiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TianyiError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TianyiError(code, message);
}

// ---------------------------------------------------------------------------
// XXTEA（David J. Wheeler 参考实现的字序与尾部长度字）
// ---------------------------------------------------------------------------

const DELTA = 0x9e3779b9;

function toWords(bytes) {
  // 小端 4 字节打包，末尾追加一个「字节长度」字，与 XXTEA 参考实现一致。
  // 例：9 字节明文 -> 3 个数据字 + 1 个长度字 = 4 字 = 16 字节密文。
  const length = bytes.length;
  const dataWords = Math.ceil(length / 4);
  const words = new Array(dataWords + 1).fill(0);
  for (let index = 0; index < length; index++) {
    words[index >> 2] |= bytes[index] << ((index & 3) << 3);
  }
  words[dataWords] = length;
  // 保证按有符号 32 位整数参与运算。
  return words.map(value => value | 0);
}

function toBytes(words) {
  const length = words[words.length - 1];
  if (!Number.isInteger(length) || length < 0 || length > (words.length - 1) * 4) {
    throw new TianyiError('crypto_invalid', '加密载荷无效');
  }
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = (words[index >> 2] >>> ((index & 3) << 3)) & 0xff;
  }
  return bytes;
}

function mx(sum, y, z, p, e, k) {
  return (((z >>> 5) ^ (y << 2)) + ((y >>> 3) ^ (z << 4))) ^ ((sum ^ y) + (k[(p & 3) ^ e] ^ z));
}

// 标准 XXTEA 加密：输入 32 位字数组，原地就地加密。
function encryptWords(words, key) {
  const n = words.length;
  if (n < 2) return words;
  let z = words[n - 1];
  let y;
  let sum = 0;
  let q = Math.floor(6 + 52 / n);
  while (q-- > 0) {
    sum = (sum + DELTA) | 0;
    const e = (sum >>> 2) & 3;
    let p;
    for (p = 0; p < n - 1; p++) {
      y = words[p + 1];
      z = words[p] = (words[p] + mx(sum, y, z, p, e, key)) | 0;
    }
    y = words[0];
    z = words[n - 1] = (words[n - 1] + mx(sum, y, z, p, e, key)) | 0;
  }
  return words;
}

function decryptWords(words, key) {
  const n = words.length;
  if (n < 2) return words;
  let y = words[0];
  let z;
  let q = Math.floor(6 + 52 / n);
  let sum = (q * DELTA) | 0;
  while (sum !== 0) {
    const e = (sum >>> 2) & 3;
    let p;
    for (p = n - 1; p > 0; p--) {
      z = words[p - 1];
      y = words[p] = (words[p] - mx(sum, y, z, p, e, key)) | 0;
    }
    z = words[n - 1];
    y = words[0] = (words[0] - mx(sum, y, z, 0, e, key)) | 0;
    sum = (sum - DELTA) | 0;
  }
  return words;
}

function keyWords(secret, keyMode = 'raw') {
  const raw = String(secret || '');
  if (!raw) throw new TianyiError('config_invalid', '应用密钥无效');
  // 官方文档只说明「appSecret 转十六进制」这一种可能，未公布确切字节转换。
  // 默认按原始 UTF-8 字节处理；keyMode='hex' 时按十六进制解码。这是唯一的
  // 互操作开关，云端向量测试失败时只需改这一处。
  const bytes = keyMode === 'hex' ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'utf8');
  if (bytes.length === 0) throw new TianyiError('config_invalid', '应用密钥无效');
  // XXTEA 使用 128 位（4 字）密钥：不足补齐、超长截断。
  const words = [0, 0, 0, 0];
  for (let index = 0; index < bytes.length && index < 16; index++) {
    words[index >> 2] |= bytes[index] << ((index & 3) << 3);
  }
  return words.map(value => value | 0);
}

/** XXTEA 加密：返回小写十六进制密文。 */
function xxteaEncrypt(plaintext, secret, { keyMode = 'raw', uppercase = false } = {}) {
  const words = toWords(Buffer.from(String(plaintext ?? ''), 'utf8'));
  const buffer = Buffer.alloc(words.length * 4);
  encryptWords(words, keyWords(secret, keyMode)).forEach((word, index) => buffer.writeInt32LE(word, index * 4));
  const hex = buffer.toString('hex');
  return uppercase ? hex.toUpperCase() : hex;
}

/** XXTEA 解密：接受大小写十六进制密文，返回 UTF-8 明文。 */
function xxteaDecrypt(cipherHex, secret, { keyMode = 'raw' } = {}) {
  const text = String(cipherHex || '').trim();
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 8 !== 0) {
    throw new TianyiError('crypto_invalid', '加密载荷无效');
  }
  const bytes = Buffer.from(text, 'hex');
  const words = [];
  for (let index = 0; index < bytes.length; index += 4) words.push(bytes.readInt32LE(index));
  // 解密后最后一个字是原始字节长度；长度字非法即视为密文无效，
  // 绝不回落到「原样输出」——那会把错误明文当成成功结果。
  return toBytes(decryptWords(words, keyWords(secret, keyMode))).toString('utf8');
}

/**
 * 官方参考向量校验（只读、无副作用）。云端测试可直接调用断言。
 * 使用默认的小写十六进制输出，与指南 481 公布的向量保持一致；
 * 授权链路的 paras 大写转换只发生在 buildAuthorizationUrl 内部。
 */
function verifyOfficialVector() {
  return xxteaEncrypt(OFFICIAL_XXTEA_VECTOR.plaintext, OFFICIAL_XXTEA_VECTOR.key)
    === OFFICIAL_XXTEA_VECTOR.ciphertextHex;
}

// ---------------------------------------------------------------------------
// 签名与状态
// ---------------------------------------------------------------------------

function hmacUpperHex(message, secret) {
  return crypto.createHmac('sha1', String(secret || '')).update(String(message), 'utf8').digest('hex').toUpperCase();
}

function requestSignature(appId, clientType, paras, secret) {
  return hmacUpperHex(`${appId}${clientType}${CALLBACK_FORMAT}${versionFor(clientType)}${paras}`, secret);
}

function versionFor(clientType) {
  return clientType === H5_CLIENT_TYPE ? H5_VERSION : WEB_VERSION;
}

function callbackSignature(appId, paras, secret) {
  return hmacUpperHex(`${appId}${paras}`, secret);
}

function tokenSignature(appId, code, secret) {
  return hmacUpperHex(`${appId}${code}${TOKEN_FORMAT}${TOKEN_GRANT_TYPE}`, secret);
}

function appIdOf(config) {
  const id = String(config?.appId || config?.clientId || '').trim();
  if (!id) fail('config_invalid', '天翼应用未配置 appId');
  return id;
}

function appSecretOf(config) {
  const secret = String(config?.appSecret || config?.clientSecret || '').trim();
  if (!secret) fail('config_invalid', '天翼应用未配置 appSecret');
  return secret;
}

function isH5(config) {
  // 服务端 provider 对象用 providerType（数据库列亦为蛇形），调用方也可能直接传 type；
  // 两套命名都接受，避免上层必须记得做一次映射。
  const kind = String(config?.type || config?.providerType || config?.provider_type || '').toLowerCase();
  return kind === 'tianyi_h5';
}

function clientTypeOf(config) {
  return isH5(config) ? H5_CLIENT_TYPE : WEB_CLIENT_TYPE;
}

/** 生成 32 字符以内的十六进制 state（16 随机字节）。 */
function generateState() {
  return crypto.randomBytes(STATE_BYTES).toString('hex');
}

function normalizeState(value) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_STATE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) return '';
  return text;
}

// 时间戳按 UTC+8 生成毫秒字符串（文档里 timeStamp 为毫秒）。
function currentTimestampMs(nowMs = Date.now()) {
  return String(nowMs);
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/**
 * 构造天翼授权跳转地址。
 * @returns {{url: string, state: string}}
 */
function buildAuthorizationUrl(config, { redirectUri, state } = {}) {
  const appId = appIdOf(config);
  const secret = appSecretOf(config);
  const clientType = clientTypeOf(config);
  const version = versionFor(clientType);

  const returnUrl = String(redirectUri || '').trim();
  if (!returnUrl) fail('config_invalid', '缺少回调地址');

  // state 由调用方提供；缺失则生成。超过 32 字符会被截断拒绝。
  const requestState = state === undefined ? generateState() : normalizeState(state);
  if (requestState === '' && state !== undefined) fail('invalid_state', 'state 无效');

  const parts = [`timeStamp=${currentTimestampMs()}`, `returnURL=${encodeURIComponent(returnUrl)}`];
  if (requestState) parts.push(`state=${encodeURIComponent(requestState)}`);
  const plaintext = parts.join('&');

  // 官方 469/467：paras 必须以**大写十六进制**输出，且签名输入用的就是最终下发的字串。
  // 只有授权输出用大写；xxteaEncrypt 默认仍是小写，以保持官方参考向量可校验。
  const paras = xxteaEncrypt(plaintext, secret, { uppercase: true });
  const sign = requestSignature(appId, clientType, paras, secret);

  const base = isH5(config) ? H5_AUTHORIZE_URL : WEB_AUTHORIZE_URL;
  const query = new URLSearchParams({
    appId,
    clientType,
    format: CALLBACK_FORMAT,
    version,
    paras,
    sign
  });
  return { url: `${base}?${query.toString()}`, state: requestState };
}

/**
 * 校验并解析回调。必须**先验签再解密**。
 * @returns {{code: string, state: string}}
 */
function parseCallback(config, query = {}) {
  const appId = appIdOf(config);
  const secret = appSecretOf(config);

  const callbackAppId = String(query.appId || '').trim();
  if (!callbackAppId || callbackAppId !== appId) fail('invalid_callback', '回调应用不匹配');

  const paras = String(query.paras || '').trim();
  const sign = String(query.sign || '').trim().toUpperCase();
  if (!paras || !sign) fail('invalid_callback', '回调参数缺失');

  // 先验签；签名不符时绝不进入解密。
  const expected = callbackSignature(appId, paras, secret);
  if (!safeEqualHex(expected, sign)) fail('invalid_signature', '回调签名校验失败');

  let payload;
  try {
    payload = xxteaDecrypt(paras, secret);
  } catch {
    fail('invalid_callback', '回调内容无法解析');
  }

  const fields = parseFormFields(payload);
  if (String(fields.result || '') !== CALLBACK_SUCCESS_RESULT) fail('invalid_callback', '授权未成功');

  const code = String(fields.code || '').trim();
  if (!code) fail('invalid_callback', '缺少授权码');

  // 新鲜度：回调时间 yyyy-MM-dd HH:mm:ss（UTC+8）；无法解析则视为过期。
  if (!isFreshTimestamp(fields.timeStamp)) fail('invalid_callback', '回调已过期');

  return { code, state: normalizeState(fields.state) };
}

/** 用一次性授权码换取应用维度 openId。 */
async function exchangeCode(config, code, { fetchImpl = globalThis.fetch } = {}) {
  const appId = appIdOf(config);
  const secret = appSecretOf(config);
  const authorizationCode = String(code || '').trim();
  if (!authorizationCode) fail('invalid_code', '缺少授权码');
  if (typeof fetchImpl !== 'function') fail('config_invalid', '天翼传输不可用');

  const body = new URLSearchParams({
    appId,
    grantType: TOKEN_GRANT_TYPE,
    code: authorizationCode,
    format: TOKEN_FORMAT,
    sign: tokenSignature(appId, authorizationCode, secret)
  }).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let payload;
  try {
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
      // The authorization code and signed request body must never be forwarded
      // to an unexpected redirect target.
      redirect: 'error'
    });
    if (!response || typeof response.text !== 'function') fail('upstream_error', '天翼授权服务暂时不可用');
    // 非 2xx 一律当成上游故障；不把状态行或响应体透出给调用方。
    if (typeof response.ok === 'boolean' && !response.ok) fail('upstream_error', '天翼授权服务暂时不可用');
    const text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch {
      fail('upstream_error', '天翼授权服务暂时不可用');
    }
  } catch (error) {
    if (error instanceof TianyiError) throw error;
    fail('upstream_error', '天翼授权服务暂时不可用');
  } finally {
    clearTimeout(timer);
  }

  if (!payload || typeof payload !== 'object') fail('upstream_error', '天翼授权服务暂时不可用');
  if (String(payload.result || '') !== TOKEN_SUCCESS_RESULT) fail('upstream_rejected', '天翼账号授权失败');

  // openId 必须是**字符串**且非空：数字/布尔之类不得被 String() 强转成看似合法的标识。
  if (typeof payload.openId !== 'string' || !payload.openId.trim()) {
    fail('upstream_incomplete', '天翼未返回账号标识');
  }
  const openId = payload.openId.trim();

  // appId 必须回传且与本应用一致，避免跨应用串号或返回体被换成别的应用。
  const returnedAppId = typeof payload.appId === 'string' ? payload.appId.trim() : '';
  if (!returnedAppId || returnedAppId !== appId) fail('upstream_rejected', '天翼账号归属不匹配');

  // 令牌响应同样带 UTC+8 时间戳，必须校验新鲜度，防止旧响应重放。
  if (!isFreshTimestamp(payload.timeStamp)) fail('upstream_rejected', '天翼授权响应已过期');

  // subject 即应用维度的 openId；不构造任何手机号/邮箱已验证声明。
  return { subject: openId, openId };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseFormFields(text) {
  const fields = {};
  for (const pair of String(text || '').split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const key = index === -1 ? pair : pair.slice(0, index);
    const value = index === -1 ? '' : pair.slice(index + 1);
    try {
      fields[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      fields[key] = value;
    }
  }
  return fields;
}

function parseUtc8Timestamp(value) {
  const text = String(value || '').trim();
  // 'yyyy-MM-dd HH:mm:ss'，UTC+8（+08:00），无时区后缀。
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second) - 8 * 60 * 60 * 1000;
  return Number.isFinite(epoch) ? epoch : null;
}

function isFreshTimestamp(value, nowMs = Date.now()) {
  const epoch = parseUtc8Timestamp(value);
  if (epoch === null) return false;
  const age = nowMs - epoch;
  // 允许少量时钟偏差，但拒绝明显过期或来自未来的时间。
  return age >= -60 * 1000 && age <= CALLBACK_MAX_AGE_MS;
}

module.exports = {
  WEB_AUTHORIZE_URL,
  H5_AUTHORIZE_URL,
  TOKEN_URL,
  MAX_STATE_LENGTH,
  OFFICIAL_XXTEA_VECTOR,
  TianyiError,
  buildAuthorizationUrl,
  parseCallback,
  exchangeCode,
  generateState,
  verifyOfficialVector,
  // 供云端向量测试与排障复用。
  xxteaEncrypt,
  xxteaDecrypt,
  callbackSignature,
  tokenSignature
};
