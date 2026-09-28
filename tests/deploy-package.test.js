const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { archiveTools, buildDeploy, validateAssets } = require('../scripts/build-deploy');

test('deployment ZIP contains separate phone scripts and styles with matching source content and excludes font/icon assets', () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-package-test-'));
  try {
    const output = path.join(temporary, 'deployment.zip');
    const result = buildDeploy({ root, output });
    const tools = archiveTools();
    const entries = tools.list(output);
    for (const file of ['views/account/profile.html', 'views/admin/user.html', 'views/page-registry.js', 'public/js/pages/account/profile.js', 'public/js/pages/admin/user.js',
      'public/css/vaultsso-profile.css', '.env.example', 'scripts/init-db.js', 'models/User.js']) {
      assert.ok(entries.includes(file), `${file} must be included`);
    }
    for (const file of ['views/account/profile.html', 'views/admin/user.html', 'public/js/pages/account/profile.js', 'public/js/pages/admin/user.js']) {
      assert.equal(tools.read(output, file), fs.readFileSync(path.join(root, file), 'utf8'));
    }
    assert.equal(result.backup, undefined);
    assert.ok(entries.every(file => !file.startsWith('public/assets/')));
    for (const directory of ['auth', 'account', 'admin', 'docs']) {
      for (const name of fs.readdirSync(path.join(root, 'views', directory)).filter(name => name.endsWith('.html'))) {
        assert.ok(entries.includes(`views/${directory}/${name}`), `${name} must be included`);
      }
    }
    for (const directory of ['public/css', 'public/js']) {
      const expected = fs.readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile()).map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
      for (const file of expected) assert.ok(entries.includes(file), `${file} must be included recursively`);
    }
    assert.ok(entries.every(file => !/(?:^|\/)(?:keys|node_modules|\.git|\.artifacts)(?:\/|$)|\.(?:pem|key)$|(?:^|\/)\.env(?:$|\.(?!example$))/.test(file)));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('asset verification rejects omitted page scripts and relative CSS font resources', () => {
  const sources = {
    'profile.html': '<script src="/js/pages/account/profile.js?v=2"></script><link rel="stylesheet" href="/css/vaultsso-profile.css">',
    'public/css/vaultsso-profile.css': '@import "./shared.css"; .test { font-family: Inter; src: url("./fonts/inter.woff2"); }',
    'public/css/shared.css': ''
  };
  assert.throws(() => validateAssets(Object.keys(sources), file => sources[file]), /Missing packaged asset: \/js\/pages\/account\/profile.js/);
  sources['public/js/pages/account/profile.js'] = '';
  assert.throws(() => validateAssets(Object.keys(sources), file => sources[file]), /Missing packaged asset: .\/fonts\/inter.woff2/);
  sources['public/css/fonts/inter.woff2'] = '';
  assert.doesNotThrow(() => validateAssets(Object.keys(sources), file => sources[file]));
});

test('publishing excludes local secrets, preserves the previous ZIP and rejects incomplete updates', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth2-package-publish-test-'));
  try {
    const sources = {
      'package.json': JSON.stringify({ files: ['public', 'keys', '.env', '.env.example'] }),
      'package-lock.json': '{}', 'README.md': '', 'LICENSE': '',
      '.env': 'secret', '.env.example': 'sample', 'keys/signing.pem': 'secret',
      'public/index.html': '<link rel="stylesheet" href="/assets/vaultsso-fonts.css"><link rel="stylesheet" href="/css/profile.css"><script src="/js/pages/account/profile.js?v=2"></script>',
      'public/js/pages/account/profile.js': 'console.log("current version");',
      'public/css/profile.css': 'body { color: black; }',
      'public/assets/vaultsso-fonts.css': '@font-face { src: url("./fonts/inter.woff2"); }',
      'public/assets/fonts/inter.woff2': 'font',
      'public/assets/icons.woff2': 'icons',
      'public/assets/local.key': 'secret', 'public/.env.production': 'secret',
      'public/keys/signing.pem': 'secret'
    };
    for (const [file, content] of Object.entries(sources)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    const defaultResult = buildDeploy({ root });
    assert.equal(defaultResult.output, path.join(root, 'dist', 'azurekiln-oauth2.zip'));
    assert.ok(fs.existsSync(defaultResult.output));
    assert.ok(!defaultResult.files.some(file => file.startsWith('dist/')));
    const output = path.join(root, 'deployment.zip');
    fs.writeFileSync(output, 'previous archive');
    const result = buildDeploy({ root, output });
    assert.equal(fs.readFileSync(result.backup, 'utf8'), 'previous archive');
    assert.ok(result.files.includes('public/js/pages/account/profile.js'));
    assert.ok(result.files.includes('public/css/profile.css'));
    assert.ok(result.files.includes('.env.example'));
    for (const file of ['.env', 'keys/signing.pem', 'public/assets/local.key', 'public/.env.production', 'public/keys/signing.pem',
      'public/assets/vaultsso-fonts.css', 'public/assets/fonts/inter.woff2', 'public/assets/icons.woff2']) {
      assert.ok(!result.files.includes(file), `${file} must be excluded`);
    }
    const complete = fs.readFileSync(output);
    fs.unlinkSync(path.join(root, 'public/js/pages/account/profile.js'));
    assert.throws(() => buildDeploy({ root, output }), /Missing packaged asset/);
    assert.deepEqual(fs.readFileSync(output), complete);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only an explicitly linked font stylesheet may reference excluded assets', () => {
  const sources = { 'profile.html': '<link rel="stylesheet" href="/assets/vaultsso-fonts.css?v=2">' };
  assert.doesNotThrow(() => validateAssets(Object.keys(sources), file => sources[file]));
  for (const html of ['<script src="/assets/pages/profile.js"></script>',
    '<link rel="stylesheet" href="/assets/vaultsso-profile.css">', '<script src="/assets/vaultsso-fonts.css"></script>']) {
    sources['profile.html'] = html;
    assert.throws(() => validateAssets(Object.keys(sources), file => sources[file]), /Core resources must use \/css or \/js/);
  }
  sources['profile.html'] = '<link rel="stylesheet" href="/css/profile.css">';
  sources['public/css/profile.css'] = '@import "/assets/vaultsso-fonts.css";';
  assert.throws(() => validateAssets(Object.keys(sources), file => sources[file]), /Core resources must use \/css or \/js/);
});
