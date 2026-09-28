const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.js')).sort();
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests.map(name => path.join(root, 'tests', name))], {
  cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdio: 'inherit', windowsHide: true
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 ? 0 : 1;
