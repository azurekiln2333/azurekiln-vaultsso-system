const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_ROOT, loadProjectEnvironment, resolveProjectPath } = require('../config/environment');

function validateKeyOwnership(stat, privateKey = false) {
  if (stat.uid !== 1000) throw new Error('data/keys and its signing private key must be owned by UID 1000');
  if (privateKey && (stat.mode & 0o7777) !== 0o600) throw new Error('The signing private key must have mode 0600');
}

function checkContainerMounts(projectRoot = PROJECT_ROOT, env = process.env) {
  const readable = fs.constants.R_OK;
  const traversable = readable | fs.constants.X_OK;
  const checks = [
    ['.env', false, readable],
    ['data', true, traversable | fs.constants.W_OK],
    ['data/keys', true, traversable]
  ];
  for (const [relative, directory, access] of checks) {
    const file = path.join(projectRoot, relative);
    try {
      const stat = fs.statSync(file);
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('unexpected path type');
      fs.accessSync(file, access);
    } catch {
      throw new Error(`Required container mount is missing, has the wrong type, or is inaccessible: ${relative}`);
    }
  }
  const keysDirectory = path.join(projectRoot, 'data/keys');
  if (process.platform !== 'win32') validateKeyOwnership(fs.statSync(keysDirectory));
  const configured = { ...env };
  loadProjectEnvironment({ env: configured, projectRoot });
  const readonlyKeys = fs.realpathSync(keysDirectory);
  const keyInputs = [
    ['OIDC_SIGNING_KEY_FILE', configured.OIDC_SIGNING_KEY_FILE || 'data/keys/oidc-private.pem', true],
    ['OIDC_PREVIOUS_JWKS_FILE', configured.OIDC_PREVIOUS_JWKS_FILE, false],
    ['DB_TLS_CA_FILE', configured.DB_TLS_CA_FILE, false]
  ];
  for (const [name, value, privateKey] of keyInputs) {
    if (!value) continue;
    const file = resolveProjectPath(value, projectRoot);
    if (!file.startsWith(`${path.resolve(keysDirectory)}${path.sep}`)) {
      throw new Error(`${name} must point inside the read-only data/keys directory`);
    }
    let stat;
    try {
      if (!fs.realpathSync(file).startsWith(`${readonlyKeys}${path.sep}`)) throw new Error('key symlink leaves the read-only directory');
      stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error('unexpected path type');
      fs.accessSync(file, readable);
    } catch {
      throw new Error(`${name} must point to a readable file inside read-only data/keys`);
    }
    if (privateKey && process.platform !== 'win32') validateKeyOwnership(stat, true);
  }
  const settings = path.join(projectRoot, 'data/admin-settings.json');
  try {
    if (!fs.statSync(settings).isFile()) throw new Error('unexpected path type');
    fs.accessSync(settings, readable);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Persisted data/admin-settings.json must be a readable file');
  }
}

if (require.main === module) {
  try {
    if (typeof process.getuid !== 'function' || process.getuid() === 0) {
      throw new Error('Container mount checks must run as the non-root gateway user');
    }
    checkContainerMounts();
    console.log('Required container mounts are accessible to the non-root gateway user.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkContainerMounts, validateKeyOwnership };
