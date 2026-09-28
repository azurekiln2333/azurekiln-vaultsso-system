const { test } = require('node:test');
const assert = require('node:assert/strict');
const phone = require('../services/phone');

test('同一个号码的各种写法必须归一化为完全一致的 E.164', () => {
  const expected = { countryCode: '86', nationalNumber: '13800138000', e164: '+8613800138000' };
  for (const input of [
    '+86 138 0013 8000',
    '0086 138 0013 8000',
    '8613800138000',
    '13800138000',
    '013800138000',
    '0 138 0013 8000',
    '+8613800138000',
    '138-0013-8000',
    '138 0013 8000'
  ]) {
    assert.deepEqual(phone.normalizePhone(input), expected, `输入 ${input} 归一化结果不一致`);
  }
});

test('区号按输入本身的编号计划解析，不套用默认区号', () => {
  assert.deepEqual(phone.normalizePhone('+1 415 555 2671'), { countryCode: '1', nationalNumber: '4155552671', e164: '+14155552671' });
  assert.deepEqual(phone.normalizePhone('+852 9123 4567'), { countryCode: '852', nationalNumber: '91234567', e164: '+85291234567' });
  assert.deepEqual(phone.normalizePhone('+886 912 345 678'), { countryCode: '886', nationalNumber: '912345678', e164: '+886912345678' });
});

test('不使用国内长途冠码的编号计划不剥离前导 0', () => {
  // +1 与 +7 没有国内长途冠码，前导 0 属于号码本身。
  assert.equal(phone.normalizeParts('1', '0415555267').nationalNumber, '0415555267');
  assert.equal(phone.normalizeParts('7', '04951234567').nationalNumber, '04951234567');
  // 其余国家/地区剥离一位冠码。
  assert.equal(phone.normalizeParts('86', '013800138000').nationalNumber, '13800138000');
  assert.equal(phone.normalizeParts('44', '07911123456').nationalNumber, '7911123456');
});

test('华为回传的 00 形态区号必须剥掉前导 00', () => {
  assert.equal(phone.normalizeCountryCode('0086'), '86');
  assert.equal(phone.normalizeCountryCode('+86'), '86');
  assert.equal(phone.normalizeCountryCode('86'), '86');
  assert.equal(phone.normalizeCountryCode('00 86'), '86');
  assert.equal(phone.toE164('0086', '13800138000'), '+8613800138000');
  assert.equal(phone.normalizeParts('0086', '13800138000').e164, '+8613800138000');
});

test('无效输入一律拒绝，不允许落库', () => {
  for (const input of ['', '   ', '123', 'abc', '+', '+86', '0000', '+86 12']) {
    assert.equal(phone.normalizePhone(input), null, `输入 ${input} 应被拒绝`);
  }
  assert.equal(phone.normalizeParts('', '13800138000'), null);
  assert.equal(phone.normalizeParts('86', ''), null);
  assert.equal(phone.normalizeParts('086', '13800138000'), null);
  // 超过 E.164 的 15 位上限
  assert.equal(phone.toE164('86', '1380013800012345'), '');
});

test('掩码不泄露完整号码', () => {
  assert.equal(phone.maskPhone('86', '13800138000'), '+86 138****8000');
  assert.equal(phone.maskPhone('1', '4155552671'), '+1 415***2671');
  assert.equal(phone.maskPhone('86', ''), '');
  assert.doesNotMatch(phone.maskPhone('86', '13800138000'), /13800138000/);
  assert.equal(phone.formatPhone('0086', '13800138000'), '+86 13800138000');
});

test('号码比较只看数字部分', () => {
  assert.equal(phone.isSamePhone('+8613800138000', '8613800138000'), true);
  assert.equal(phone.isSamePhone('+8613800138000', '+8613800138001'), false);
  assert.equal(phone.isSamePhone('', ''), false);
});
