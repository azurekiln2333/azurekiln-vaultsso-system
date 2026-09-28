const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function resolveProjectPath(value, projectRoot = PROJECT_ROOT) {
  return path.resolve(projectRoot, value);
}

function loadProjectEnvironment({ env = process.env, projectRoot = PROJECT_ROOT } = {}) {
  const envFile = path.join(projectRoot, '.env');
  const sources = Object.fromEntries(Object.keys(env).map(key => [key, 'environment']));
  // Isolated tests supply every setting explicitly and must never read deployment credentials.
  if (String(env.NODE_ENV || '').trim().toLowerCase() === 'test') {
    return { envFile, exists: false, skipped: true, sources };
  }
  let contents;
  try {
    contents = fs.readFileSync(envFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { envFile, exists: false, skipped: false, sources };
    throw new Error(`Cannot read the project .env file (${error.code || 'read error'})`);
  }
  for (const [key, value] of Object.entries(dotenv.parse(contents))) {
    // Preserve environment values injected by a process manager, including an explicit empty value.
    if (!Object.hasOwn(env, key)) {
      env[key] = value;
      sources[key] = '.env';
    }
  }
  return { envFile, exists: true, skipped: false, sources };
}

module.exports = { PROJECT_ROOT, resolveProjectPath, loadProjectEnvironment };
