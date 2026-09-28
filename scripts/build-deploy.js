const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout;
}

function archiveTools() {
  for (const command of ['tar', 'bsdtar']) {
    const version = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (version.status === 0 && /libarchive/i.test(version.stdout)) {
      return {
        create: (root, output, files) => run(command, ['--format=zip', '-cf', output, '-C', root, '--', ...files]),
        list: output => run(command, ['-tf', output]).trim().split(/\r?\n/),
        read: (output, file) => run(command, ['-xOf', output, file])
      };
    }
  }
  // GNU tar cannot write/read ZIP; Unix hosts can use their native zip/unzip pair.
  return {
    create: (root, output, files) => run('zip', ['-q', output, '-@'], { cwd: root, input: `${files.join('\n')}\n` }),
    list: output => run('unzip', ['-Z1', output]).trim().split(/\r?\n/),
    read: (output, file) => run('unzip', ['-p', output, file])
  };
}

function collectFiles(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = new Set();
  for (const directory of ['public/css', 'public/js']) {
    if (!fs.existsSync(path.join(root, directory)) || !fs.statSync(path.join(root, directory)).isDirectory()) {
      throw new Error(`Required deployment directory is missing: ${directory}`);
    }
  }
  function visit(relative) {
    const segments = relative.split('/');
    const name = segments.at(-1);
    if (relative === 'public/assets' || relative.startsWith('public/assets/')
      || segments.some(segment => ['keys', 'node_modules', '.git', '.artifacts'].includes(segment))
      || /\.(?:pem|key)$/i.test(name) || (name.startsWith('.env') && name !== '.env.example')) return;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error(`Package entry leaves source directory: ${relative}`);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Package entry must not be a symbolic link: ${relative}`);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(`${relative}/${child}`);
    } else if (stat.isFile()) files.add(relative);
  }
  for (const entry of [...manifest.files, 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) visit(entry.replaceAll('\\', '/'));
  return [...files].sort();
}

function validateAssets(files, read) {
  const names = new Set(files);
  const origin = 'https://package.invalid';
  function check(reference, source, base, fontStylesheet = false) {
    if (!reference || reference.startsWith('#')) return;
    const url = new URL(reference.replaceAll('&amp;', '&'), `${origin}${base}`);
    if (url.origin !== origin) return;
    // Fonts/icons are supplied separately; only their stylesheet may be linked by the page.
    if (fontStylesheet && url.pathname === '/assets/vaultsso-fonts.css') return;
    if (url.pathname === '/assets' || url.pathname.startsWith('/assets/')) {
      throw new Error(`Core resources must use /css or /js: ${reference} referenced by ${source}`);
    }
    const target = `public${decodeURIComponent(url.pathname)}`;
    if (!names.has(target)) throw new Error(`Missing packaged asset: ${reference} referenced by ${source}`);
  }
  for (const source of files) {
    if (source === 'public/assets' || source.startsWith('public/assets/')) throw new Error(`Font/icon assets must not be packaged: ${source}`);
    if (source.endsWith('.html')) {
      const html = read(source);
      const base = source.startsWith('public/') ? `/${source.slice(7)}` : `/${source}`;
      for (const tag of html.matchAll(/<(script|link|img|source)\b([^>]*)>/gi)) {
        const attribute = tag[1].toLowerCase() === 'link' ? 'href' : 'src';
        const reference = tag[2].match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
        const fontStylesheet = tag[1].toLowerCase() === 'link' && /\brel\s*=\s*(["'])stylesheet\1/i.test(tag[2]);
        if (reference) check(reference[2], source, base, fontStylesheet);
      }
    } else if (source.endsWith('.css')) {
      const css = read(source).replace(/\/\*[\s\S]*?\*\//g, '');
      const base = `/${source.replace(/^public\//, '')}`;
      for (const reference of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi)) {
        check(reference.slice(1).find(value => value !== undefined), source, base);
      }
    }
  }
}

function buildDeploy({ root = path.resolve(__dirname, '..'), output = path.join(root, 'dist', 'azurekiln-oauth2.zip') } = {}) {
  root = path.resolve(root);
  output = path.resolve(output);
  const files = collectFiles(root);
  validateAssets(files, file => fs.readFileSync(path.join(root, file), 'utf8'));
  const tools = archiveTools();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-deploy-'));
  let backup;
  try {
    const archive = path.join(temporary, 'deployment.zip');
    tools.create(root, archive, files);
    const entries = tools.list(archive);
    if (JSON.stringify([...entries].sort()) !== JSON.stringify(files)) throw new Error('Deployment archive differs from the complete source file list');
    validateAssets(entries, file => tools.read(archive, file));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (fs.existsSync(output)) {
      const backupDirectory = path.join(root, '.artifacts', 'deployment-backups');
      fs.mkdirSync(backupDirectory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = path.join(backupDirectory, `${path.basename(output, '.zip')}-${stamp}.zip`);
      fs.copyFileSync(output, backup, fs.constants.COPYFILE_EXCL);
    }
    fs.copyFileSync(archive, output);
    return { output, backup, files: entries };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const result = buildDeploy({ output: process.argv[2] });
    console.log(`Deployment ZIP verified: ${result.output} (${result.files.length} files)`);
    if (result.backup) console.log(`Previous archive preserved: ${result.backup}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { archiveTools, buildDeploy, validateAssets };
