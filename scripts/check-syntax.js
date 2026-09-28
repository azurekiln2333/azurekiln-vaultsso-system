const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
let checked = 0;
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git', '.agents', '.codex'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:js|cjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
      checked++;
    } else if (entry.name.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf8');
      for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const src = script[1].match(/\bsrc="([^"]+)"/);
        if (src) {
          if (!src[1].startsWith('/') || src[1].startsWith('//')) throw new Error(`Nonlocal script in ${file}`);
          const target = path.join(root, 'public', src[1].split('?')[0]);
          if (!fs.existsSync(target)) throw new Error(`Missing browser script: ${src[1]}`);
        } else if (script[2].trim()) {
          new vm.Script(script[2], { filename: file });
          throw new Error(`Inline script is blocked by the production CSP: ${file}`);
        }
      }
      checked++;
    }
  }
}

try {
  walk(root);
  console.log(`Syntax and browser script references checked: ${checked} files`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
