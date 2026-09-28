// 手机号归一化。所有入口（本地表单、外部提供方回传、导入）都必须经过这里，
// 保证同一个号码在库中只有一种写法，唯一键才有意义。
//
// 术语约定：本模块中的「区号」只指国际电话区号（国家码，如 86），
// 它决定路由与唯一性；国内长途区号（如 010）不参与存储与判重。

const MIN_NATIONAL_DIGITS = 4;
const MAX_E164_DIGITS = 15;

// 不使用国内长途冠码 0 的编号计划：北美编号计划 +1，俄罗斯/哈萨克斯坦 +7。
// 其余国家/地区普遍使用 0 作为国内长途冠码，归一化时剥离一位。
const NO_TRUNK_PREFIX = new Set(['1', '7']);

// 仅用于界面下拉的常用区号，不参与任何校验；未列出的区号仍可直接填写数字。
const COMMON_COUNTRY_CODES = [
  { code: '86', label: '中国' },
  { code: '852', label: '中国香港' },
  { code: '853', label: '中国澳门' },
  { code: '886', label: '中国台湾' },
  { code: '1', label: '美国 / 加拿大' },
  { code: '7', label: '俄罗斯 / 哈萨克斯坦' },
  { code: '44', label: '英国' },
  { code: '49', label: '德国' },
  { code: '33', label: '法国' },
  { code: '39', label: '意大利' },
  { code: '34', label: '西班牙' },
  { code: '31', label: '荷兰' },
  { code: '81', label: '日本' },
  { code: '82', label: '韩国' },
  { code: '65', label: '新加坡' },
  { code: '60', label: '马来西亚' },
  { code: '66', label: '泰国' },
  { code: '84', label: '越南' },
  { code: '62', label: '印度尼西亚' },
  { code: '63', label: '菲律宾' },
  { code: '91', label: '印度' },
  { code: '61', label: '澳大利亚' },
  { code: '64', label: '新西兰' },
  { code: '971', label: '阿联酋' },
  { code: '966', label: '沙特阿拉伯' },
  { code: '27', label: '南非' },
  { code: '55', label: '巴西' },
  { code: '52', label: '墨西哥' }
];

const DEFAULT_COUNTRY_CODE = '86';

function stripSeparators(value) {
  return String(value ?? '').replace(/[\s\-().\u3000]/g, '');
}

function digitsOnly(value) {
  return stripSeparators(value).replace(/[^0-9]/g, '');
}

// 接受 86 / 0086 / +86 / 00 86 等写法，输出纯数字区号。
// 华为回传的 phoneCountryCode 是「00 + 区号」形态，同样由这里统一。
function normalizeCountryCode(value) {
  let text = stripSeparators(value);
  if (!text) return '';
  text = text.replace(/^\+/, '').replace(/^00/, '');
  if (!/^[0-9]{1,3}$/.test(text) || text.startsWith('0')) return '';
  return text;
}

function isDialable(number) {
  return /^[0-9]+$/.test(number) && number.length >= MIN_NATIONAL_DIGITS;
}

// 剥离国内长途冠码。剥离后过短说明输入本身有问题，此时保留原值交给长度校验拒绝。
function stripTrunkPrefix(digits, countryCode) {
  if (NO_TRUNK_PREFIX.has(countryCode)) return digits;
  if (!digits.startsWith('0')) return digits;
  const stripped = digits.replace(/^0+/, '');
  return isDialable(stripped) ? stripped : digits;
}

function normalizeNationalNumber(value, countryCode) {
  const code = normalizeCountryCode(countryCode) || DEFAULT_COUNTRY_CODE;
  const digits = digitsOnly(value);
  if (!digits) return '';
  return stripTrunkPrefix(digits, code);
}

function toE164(countryCode, nationalNumber) {
  const code = normalizeCountryCode(countryCode);
  const number = digitsOnly(nationalNumber);
  if (!code || !number) return '';
  const combined = `${code}${number}`;
  if (combined.length > MAX_E164_DIGITS) return '';
  return `+${combined}`;
}

// 在已知区号表内匹配前缀，避免把 8613… 误切成 8 + 613…。
function matchCountryCode(digits) {
  if (!digits) return '';
  if (NO_TRUNK_PREFIX.has(digits[0]) && digits.length > 1) return digits[0];
  for (const length of [3, 2, 1]) {
    const candidate = digits.slice(0, length);
    if (candidate.length === length && COMMON_COUNTRY_CODES.some(item => item.code === candidate)) return candidate;
  }
  // 未收录的区号：按最长可用前缀处理，保证剩余号码仍然可拨。
  for (const length of [3, 2, 1]) {
    const candidate = digits.slice(0, length);
    if (candidate.length !== length || candidate.startsWith('0')) continue;
    if (isDialable(digits.slice(length))) return candidate;
  }
  return '';
}

// 首选入口：区号与号码已经分开（界面选择器、华为回传）时使用。
function normalizeParts(countryCode, nationalNumber) {
  const code = normalizeCountryCode(countryCode);
  if (!code) return null;
  const national = normalizeNationalNumber(nationalNumber, code);
  if (!isDialable(national)) return null;
  const e164 = toE164(code, national);
  if (!e164) return null;
  return { countryCode: code, nationalNumber: national, e164 };
}

// 便捷入口：只有一个输入框时，按默认区号解析 +86 / 0086 / 86 / 0 开头的四种写法。
function normalizePhone(value, defaultCountryCode = DEFAULT_COUNTRY_CODE) {
  const text = stripSeparators(value);
  if (!text) return null;
  const fallback = normalizeCountryCode(defaultCountryCode) || DEFAULT_COUNTRY_CODE;

  if (/^\+[0-9]+$/.test(text) || /^00[0-9]+$/.test(text)) {
    const digits = digitsOnly(text.replace(/^00/, ''));
    const code = matchCountryCode(digits);
    if (!code) return null;
    return normalizeParts(code, digits.slice(code.length));
  }

  const digits = digitsOnly(text);
  if (!digits) return null;
  if (digits.startsWith(fallback) && isDialable(stripTrunkPrefix(digits.slice(fallback.length), fallback))) {
    return normalizeParts(fallback, digits.slice(fallback.length));
  }
  return normalizeParts(fallback, digits);
}

function formatPhone(countryCode, nationalNumber) {
  const normalized = normalizeParts(countryCode, nationalNumber);
  return normalized ? `+${normalized.countryCode} ${normalized.nationalNumber}` : '';
}

// 展示与日志统一使用掩码，避免明文手机号出现在页面和审计记录里。
function maskPhone(countryCode, nationalNumber) {
  const code = normalizeCountryCode(countryCode);
  const number = digitsOnly(nationalNumber);
  if (!code || !number) return '';
  if (number.length <= 4) return `+${code} ${'*'.repeat(number.length)}`;
  const headLength = number.length >= 8 ? 3 : 1;
  const head = number.slice(0, headLength);
  const tail = number.slice(-4);
  const hidden = Math.max(2, number.length - headLength - 4);
  return `+${code} ${head}${'*'.repeat(hidden)}${tail}`;
}

// 只知道 E.164 字符串（日志、旧数据）时的掩码，不依赖区号切分结果。
function maskE164(value) {
  const digits = digitsOnly(value);
  if (!digits) return '';
  if (digits.length <= 6) return '*'.repeat(digits.length);
  return `+${digits.slice(0, 2)}${'*'.repeat(Math.max(2, digits.length - 6))}${digits.slice(-4)}`;
}

function isSamePhone(left, right) {
  const a = digitsOnly(left);
  const b = digitsOnly(right);
  return Boolean(a && b && a === b);
}

module.exports = {
  COMMON_COUNTRY_CODES,
  DEFAULT_COUNTRY_CODE,
  normalizeCountryCode,
  normalizeNationalNumber,
  normalizeParts,
  normalizePhone,
  toE164,
  formatPhone,
  maskPhone,
  maskE164,
  isSamePhone
};
