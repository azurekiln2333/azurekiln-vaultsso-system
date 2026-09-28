const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROJECT_ROOT, resolveProjectPath } = require('../config/environment');
const { createSecretCipher } = require('./secret-storage');

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
    return result;
  }
  function save(settings) {
    const saved = { version: 1 };
    if (settings.smtp) saved.smtp = { ...settings.smtp, password: cipher.encrypt(settings.smtp.password) };
    if (settings.turnstile) saved.turnstile = { ...settings.turnstile, secretKey: cipher.encrypt(settings.turnstile.secretKey) };
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
