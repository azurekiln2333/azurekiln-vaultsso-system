const fs = require('node:fs');
const { PROJECT_ROOT, loadProjectEnvironment, resolveProjectPath } = require('../config/environment');
const { readRuntimeConfig, validateDatabaseEnvironment } = require('../config/runtime');
const { loadSigningKeys } = require('../services/signing');

function checkConfiguration({ env = process.env, projectRoot = PROJECT_ROOT } = {}) {
  const loaded = loadProjectEnvironment({ env, projectRoot });
  const errors = [];
  try {
    const runtime = readRuntimeConfig(env);
    if (runtime.nodeEnv === 'test') errors.push('NODE_ENV=test is reserved for the isolated test runner');
  } catch (error) { errors.push(error.message); }
  try {
    const signingEnv = { ...env };
    for (const key of ['OIDC_SIGNING_KEY_FILE', 'OIDC_PREVIOUS_JWKS_FILE']) {
      if (signingEnv[key]) signingEnv[key] = resolveProjectPath(signingEnv[key], projectRoot);
    }
    loadSigningKeys(signingEnv);
  } catch (error) {
    errors.push(error.code === 'ENOENT' ? 'Signing key file not found; check OIDC_SIGNING_KEY_FILE / OIDC_PREVIOUS_JWKS_FILE'
      : error.code === 'EACCES' || error.code === 'EPERM' ? 'Signing key file is not readable by the service account'
        : error.message);
  }
  try {
    validateDatabaseEnvironment(env);
    if (String(env.DB_TLS || '').toLowerCase() === 'true' && env.DB_TLS_CA_FILE) {
      fs.accessSync(resolveProjectPath(env.DB_TLS_CA_FILE, projectRoot), fs.constants.R_OK);
    }
  } catch (error) {
    errors.push(['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? 'DB_TLS_CA_FILE is missing or unreadable' : error.message);
  }
  return {
    envFile: loaded.envFile,
    envFileStatus: loaded.skipped ? 'skipped for tests' : loaded.exists ? 'found' : 'not found',
    jwtSecretSource: loaded.sources.JWT_SECRET || 'not configured',
    jwtSecretBytes: Buffer.byteLength(String(env.JWT_SECRET || '')),
    errors
  };
}

function formatReport(report) {
  return [
    `.env: ${report.envFile} (${report.envFileStatus})`,
    `JWT_SECRET source: ${report.jwtSecretSource}; length: ${report.jwtSecretBytes} bytes; value hidden`,
    ...(report.jwtSecretSource === 'environment'
      ? ['The service/process environment takes priority over .env, including an empty JWT_SECRET. Update the panel/PM2/systemd setting if it is stale.'] : []),
    ...report.errors.map(message => `ERROR: ${message}`),
    report.errors.length ? 'Configuration check failed. No configuration or database data was changed.'
      : 'Static runtime, signing-key and database configuration checks passed. Database connectivity, schema, HTTPS and SMTP were not tested.'
  ].join('\n');
}

if (require.main === module) {
  try {
    const report = checkConfiguration();
    console.log(formatReport(report));
    process.exitCode = report.errors.length ? 1 : 0;
  } catch (error) {
    console.error('Configuration check failed:', error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkConfiguration, formatReport };
