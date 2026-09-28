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
}
