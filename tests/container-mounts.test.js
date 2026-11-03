const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkContainerMounts, validateKeyOwnership } = require('../scripts/check-container-mounts');

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const canPrepareKeyOwner = process.platform === 'win32' || uid === 0 || uid === 1000;
const fixtureOptions = { skip: !canPrepareKeyOwner && 'Creating UID 1000 fixtures requires root or UID 1000' };
function prepareKeys(root) {
  fs.mkdirSync(path.join(root, 'data/keys'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/keys/oidc-private.pem'), 'test-only-placeholder\n', { mode: 0o600 });
  if (process.platform !== 'win32' && uid === 0) {
    fs.chownSync(path.join(root, 'data/keys'), 1000, 1000);
    fs.chownSync(path.join(root, 'data/keys/oidc-private.pem'), 1000, 1000);
  }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-mount-test-'));
  // Fonts and icons ship inside the image, so the host supplies .env, data/ and data/keys only.
  prepareKeys(root);
  fs.writeFileSync(path.join(root, '.env'), 'JWT_SECRET=test-only-placeholder\n');
  return root;
}

test('container mount checker accepts a prepared host directory with read-only keys', fixtureOptions, () => {
  const root = fixture();
  try {
    assert.doesNotThrow(() => checkContainerMounts(root));
    fs.writeFileSync(path.join(root, 'data/admin-settings.json'), '{}');
    assert.doesNotThrow(() => checkContainerMounts(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('container mount checker does not require host font assets, which ship inside the image', fixtureOptions, () => {
  const root = fixture();
  try {
    assert.equal(fs.existsSync(path.join(root, 'public/assets')), false);
    assert.equal(fs.existsSync(path.join(root, 'keys')), false);
    assert.doesNotThrow(() => checkContainerMounts(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('container mount checker rejects missing mount inputs and invalid persisted-settings path types', fixtureOptions, () => {
  const root = fixture();
  try {
    fs.unlinkSync(path.join(root, '.env'));
    assert.throws(() => checkContainerMounts(root), /\.env/);
    fs.writeFileSync(path.join(root, '.env'), '');

    fs.rmSync(path.join(root, 'data', 'keys'), { recursive: true, force: true });
    assert.throws(() => checkContainerMounts(root), /data\/keys/);

    fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
    fs.writeFileSync(path.join(root, 'data'), 'not a directory');
    assert.throws(() => checkContainerMounts(root), /Required container mount/);

    fs.unlinkSync(path.join(root, 'data'));
    prepareKeys(root);
    fs.mkdirSync(path.join(root, 'data/admin-settings.json'), { recursive: true });
    assert.throws(() => checkContainerMounts(root), /admin-settings\.json must be a readable file/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('container mount checker rejects a signing key outside the read-only data/keys directory', fixtureOptions, () => {
  const root = fixture();
  try {
    fs.mkdirSync(path.join(root, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(root, 'keys/oidc-private.pem'), 'test-only-placeholder\n', { mode: 0o600 });
    // 旧 keys/ 布局必须先移动文件并改 .env 路径，检查器会拒绝，避免容器内私钥可写。
    assert.throws(() => checkContainerMounts(root, { OIDC_SIGNING_KEY_FILE: 'keys/oidc-private.pem' }),
      /must point inside the read-only data\/keys directory/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('key ownership validation enforces UID 1000 and 0600 for the signing private key', () => {
  assert.doesNotThrow(() => validateKeyOwnership({ uid: 1000, mode: 0o40700 }));
  assert.throws(() => validateKeyOwnership({ uid: 0, mode: 0o40700 }), /owned by UID 1000/);
  assert.doesNotThrow(() => validateKeyOwnership({ uid: 1000, mode: 0o100600 }, true));
  assert.throws(() => validateKeyOwnership({ uid: 1000, mode: 0o100644 }, true), /mode 0600/);
  for (const mode of [0o100400, 0o100640, 0o104600]) {
    assert.throws(() => validateKeyOwnership({ uid: 1000, mode }, true), /mode 0600/);
  }
  assert.throws(() => validateKeyOwnership({ uid: 0, mode: 0o100600 }, true), /owned by UID 1000/);
});

test('optional CA and previous-JWKS files stay inside the read-only key mount', fixtureOptions, () => {
  const root = fixture();
  try {
    for (const name of ['OIDC_PREVIOUS_JWKS_FILE', 'DB_TLS_CA_FILE']) {
      assert.throws(() => checkContainerMounts(root, { [name]: 'data/outside.pem' }), /inside the read-only data\/keys directory/);
    }
    fs.writeFileSync(path.join(root, 'data/keys/old-jwks.json'), '{"keys":[]}');
    fs.writeFileSync(path.join(root, 'data/keys/database-ca.crt'), 'test-only-public-ca');
    assert.doesNotThrow(() => checkContainerMounts(root, { OIDC_PREVIOUS_JWKS_FILE: 'data/keys/old-jwks.json', DB_TLS_CA_FILE: 'data/keys/database-ca.crt' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Unix files enforce private-key mode and directory/key ownership', {
  skip: process.platform === 'win32' || !canPrepareKeyOwner
}, () => {
  const root = fixture();
  try {
    const key = path.join(root, 'data/keys/oidc-private.pem');
    fs.chmodSync(key, 0o644);
    assert.throws(() => checkContainerMounts(root), /mode 0600/);
    fs.chmodSync(key, 0o600);
    assert.doesNotThrow(() => checkContainerMounts(root));
    if (uid === 0) {
      fs.chownSync(key, 0, 0);
      assert.throws(() => checkContainerMounts(root), /owned by UID 1000/);
      fs.chownSync(key, 1000, 1000);
      fs.chownSync(path.join(root, 'data/keys'), 0, 0);
      assert.throws(() => checkContainerMounts(root), /owned by UID 1000/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Unix symlinks cannot escape the read-only key mount', {
  skip: process.platform === 'win32' || !canPrepareKeyOwner
}, () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'data/outside-ca.crt'), 'public CA outside protected mount');
    fs.symlinkSync('../outside-ca.crt', path.join(root, 'data/keys/escaped-ca.crt'));
    assert.throws(() => checkContainerMounts(root, { DB_TLS_CA_FILE: 'data/keys/escaped-ca.crt' }), /readable file inside read-only data\/keys/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
