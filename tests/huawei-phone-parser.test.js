const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseHuaweiPhone, parseHuaweiIdentity } = require('../services/huawei');

const chinesePhone = { countryCode: '86', nationalNumber: '13800138000', e164: '+8613800138000' };

test('prefers an official full number and accepts matching pure number', () => {
  assert.deepEqual(parseHuaweiPhone({
    phoneNumber: '0086 138 0013 8000', purePhoneNumber: '13800138000', phoneCountryCode: '0086'
  }), chinesePhone);
  assert.deepEqual(parseHuaweiPhone({
    phoneNumber: '+86 13800138000', phoneCountryCode: '0086'
  }), chinesePhone);
  assert.deepEqual(parseHuaweiPhone({
    login_mobile_number: '13800138000', phone_country_code: '0086'
  }), chinesePhone);
});

test('uses a complete pure number only with an explicit valid country code', () => {
  assert.deepEqual(parseHuaweiPhone({ purePhoneNumber: '13800138000', phoneCountryCode: '0086' }), chinesePhone);
  assert.deepEqual(parseHuaweiPhone({
    phoneNumber: '138****8000', purePhoneNumber: '13800138000', phoneCountryCode: '0086'
  }), chinesePhone);
  assert.equal(parseHuaweiPhone({ purePhoneNumber: '13800138000' }), null);
  assert.equal(parseHuaweiPhone({ purePhoneNumber: '13800138000', phoneCountryCode: 'invalid' }), null);
});

test('does not derive a plausible number from masked or malformed provider fields', () => {
  for (const value of ['138****8000', '138x00138000', '138+00138000', '138.0013.800x', '123']) {
    assert.equal(parseHuaweiPhone({ phoneNumber: value, phoneCountryCode: '0086' }), null, value);
    assert.equal(parseHuaweiPhone({ purePhoneNumber: value, phoneCountryCode: '0086' }), null, value);
  }
  assert.equal(parseHuaweiIdentity({ openId: 'open', phoneNumber: '138****8000', phoneCountryCode: '0086' }).phoneVerified, false);
});

test('rejects contradictory valid phone fields and country codes', () => {
  assert.equal(parseHuaweiPhone({
    phoneNumber: '008613800138000', purePhoneNumber: '13900139000', phoneCountryCode: '0086'
  }), null);
  assert.equal(parseHuaweiPhone({
    phoneNumber: '+14155552671', phoneCountryCode: '0086'
  }), null);
  assert.equal(parseHuaweiPhone({
    phoneNumber: '008613800138000', purePhoneNumber: '13800138000', phoneCountryCode: '001'
  }), null);
});

test('does not silently default a missing international country code to China', () => {
  assert.equal(parseHuaweiPhone({ phoneNumber: '13800138000' }), null);
  assert.deepEqual(parseHuaweiPhone({ phoneNumber: '+14155552671' }), {
    countryCode: '1', nationalNumber: '4155552671', e164: '+14155552671'
  });
});
