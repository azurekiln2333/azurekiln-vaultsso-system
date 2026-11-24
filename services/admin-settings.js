const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROJECT_ROOT, resolveProjectPath } = require('../config/environment');
const { createSecretCipher } = require('./secret-storage');
// 引入号码认证配置归一化，保证「加载/保存」与运行时投影使用同一套字段规则。
const phoneAuth = require('./phone-auth');

function settingsFile() {
  const file = resolveProjectPath(process.env.ADMIN_SETTINGS_FILE || 'data/admin-settings.json');
  const publicDirectory = path.join(PROJECT_ROOT, 'public');
  if (file === publicDirectory || file.startsWith(`${publicDirectory}${path.sep}`)) {
    throw new Error('ADMIN_SETTINGS_FILE must be outside public/');
  }
  return file;
}

function createStore(rootSecret, file = settingsFile()) {
  const cipher = createSecretCipher(rootSecret, 'admin-settings');
  function decodeSecret(value) {
    if (value === '') return '';
    if (typeof value !== 'string' || !value.startsWith('enc:v1:')) throw new Error('Invalid encrypted admin setting');
    return cipher.decrypt(value);
  }
  function load() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    const saved = JSON.parse(raw);
    if (!saved || saved.version !== 1 || typeof saved !== 'object') throw new Error('Unsupported admin settings file');
    const result = {};
    if (saved.smtp) {
      const { host, port, user, from, password } = saved.smtp;
      if (typeof host !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535
          || typeof user !== 'string' || typeof from !== 'string') throw new Error('Invalid SMTP settings file');
      result.smtp = { host, port, user, from, password: decodeSecret(password) };
    }
    if (saved.turnstile) {
      const { siteKey, secretKey } = saved.turnstile;
      if (typeof siteKey !== 'string') throw new Error('Invalid Turnstile settings file');
      result.turnstile = { siteKey, secretKey: decodeSecret(secretKey) };
      if (Boolean(siteKey) !== Boolean(result.turnstile.secretKey)) throw new Error('Incomplete Turnstile settings file');
    }
    if (saved.phoneAuth) {
      const section = saved.phoneAuth;
      if (typeof section !== 'object' || Array.isArray(section)) throw new Error('Invalid phone auth settings file');
      // 两个密钥字段独立加密，缺省视为空串；其余字段由归一化器兜底，因此
      // 一个尚未配置完成的号码认证段可以安全地随进程启动加载。
      result.phoneAuth = phoneAuth.normalizeConfig({
        ...section,
        accessKeySecret: decodeSecret(typeof section.accessKeySecret === 'string' ? section.accessKeySecret : ''),
        securityToken: decodeSecret(typeof section.securityToken === 'string' ? section.securityToken : '')
      });
    }
    return result;
  }
  function save(settings) {
    const saved = { version: 1 };
    if (settings.smtp) saved.smtp = { ...settings.smtp, password: cipher.encrypt(settings.smtp.password) };
    if (settings.turnstile) saved.turnstile = { ...settings.turnstile, secretKey: cipher.encrypt(settings.turnstile.secretKey) };
    if (settings.phoneAuth) {
      // 只持久化归一化后的字段，并加密两个密钥；其余已存在的配置段不受影响。
      const normalized = phoneAuth.normalizeConfig(settings.phoneAuth, settings.phoneAuth);
      saved.phoneAuth = {
        ...normalized,
        accessKeySecret: cipher.encrypt(normalized.accessKeySecret),
        securityToken: cipher.encrypt(normalized.securityToken)
      };
    }
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(saved, null, 2)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return { load, save };
}

module.exports = { createStore, settingsFile };
