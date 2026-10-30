const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../public/js/shared/i18n.js'), 'utf8');
function messages(language) {
  const context = {
    window: {}, navigator: { language, languages: [language] },
    document: { documentElement: {}, querySelectorAll: () => [], dispatchEvent() {} },
    CustomEvent: class CustomEvent {}
  };
  vm.runInNewContext(source, context);
  return context.window.VaultI18n;
}

for (const language of ['zh-CN', 'zh-TW', 'en-US']) {
  test(`${language}: known authentication messages remain localized`, () => {
    const i18n = messages(language);
    const key = 'validation.password.confirm_mismatch';
    assert.equal(i18n.resolveMessage({ error_key: key, error_description: 'Server description' }), i18n.t(key));
    assert.notEqual(i18n.resolveMessage({ error_key: key }), key);
  });
  test(`${language}: login duration choices and validation remain readable`, () => {
    const i18n = messages(language);
    const label = i18n.t('auth.session.duration_label');
    assert.equal(label, language === 'en-US' ? 'Keep me signed in' : language === 'zh-TW' ? '保持登入' : '保持登录');
    for (const days of [1, 7, 14]) {
      assert.equal(i18n.t(`auth.session.days_${days}`), language === 'en-US' ? `${days} ${days === 1 ? 'day' : 'days'}` : `${days} 天`);
    }
    const key = 'auth.session.invalid_duration';
    const error = i18n.resolveMessage({ error_key: key, error: 'invalid_request' });
    assert.notEqual(error, key);
    assert.match(error, /1.*7.*14/);
    assert.match(error, language === 'en-US' ? /Choose/ : language === 'zh-TW' ? /請選擇/ : /请选择/);
  });
  test(`${language}: unknown message keys preserve human password policy detail`, () => {
    const i18n = messages(language);
    assert.equal(i18n.resolveMessage({ error_key: 'validation.password.weak', error_description: 'Password needs 16 characters' }, 'common.network_error'), 'Password needs 16 characters');
    assert.equal(i18n.resolveMessage({ message_key: 'future.code.sent', message: 'Code sent to your new address' }), 'Code sent to your new address');
  });
  test(`${language}: missing translations and machine codes use readable fallback`, () => {
    const i18n = messages(language);
    for (const payload of [
      { error_key: 'future.validation.failed', error: 'invalid_request' },
      { message_key: 'future.message', message: 'future.message' },
      { error_key: 'toString', error: 'invalid_request' },
      { error: 'invalid_request' }
    ]) {
      assert.equal(i18n.resolveMessage(payload, 'common.network_error'), i18n.t('common.network_error'));
    }
    assert.equal(i18n.resolveMessage({ error_key: 'future.error' }, 'missing.fallback'), i18n.t('common.request_error'));
  });
  test(`${language}: password guidance uses only a valid effective minimum`, () => {
    const i18n = messages(language);
    for (const minLength of [12, 16, 64]) {
      assert.equal(i18n.passwordGuidance(minLength), i18n.t('auth.password.minimum_hint', { minLength }));
      assert.ok(i18n.passwordGuidance(minLength).includes(String(minLength)));
    }
    for (const value of [undefined, null, false, '', '16', 6, 11, 65, 12.5, NaN, {}, []]) {
      assert.equal(i18n.passwordGuidance(value), i18n.t('auth.placeholder.new_password'));
    }
    for (const key of ['auth.placeholder.password_short', 'profile.section.password_desc', 'validation.password.min_length', 'profile.password.min_length']) {
      assert.doesNotMatch(i18n.t(key), /6|\{\w+\}/);
    }
    assert.notEqual(i18n.t('validation.username.invalid_format'), 'validation.username.invalid_format');
    assert.match(i18n.t('auth.username.hint'), /255/);
  });
  test(`${language}: known length errors preserve the server's current policy`, () => {
    const i18n = messages(language);
    for (const key of ['validation.password.min_length', 'profile.password.min_length']) {
      assert.equal(i18n.resolveMessage({ error_key: key, error_description: 'Password needs 16 characters' }), 'Password needs 16 characters');
      assert.equal(i18n.resolveMessage({ error_key: key }), i18n.t(key));
      assert.equal(i18n.resolveMessage({ error_key: key, error_description: key, error: 'invalid_request' }), i18n.t(key));
    }
  });
  test(`${language}: registration username guidance permits letters, digits and underscore only`, () => {
    const i18n = messages(language);
    for (const key of ['auth.username.hint', 'validation.username.invalid_format']) {
      const text = i18n.t(key);
      assert.match(text, /1–255/);
      assert.doesNotMatch(text, /hyphen|连字符|連字號|\{\w+\}/i);
      if (language === 'en-US') assert.match(text, /letters.*digits or underscores/);
      else if (language === 'zh-TW') assert.match(text, /英文字母、數字或底線/);
      else assert.match(text, /英文字母、数字或下划线/);
    }
  });
}
