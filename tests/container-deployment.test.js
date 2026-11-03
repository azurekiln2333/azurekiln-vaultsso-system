const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '..');
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  // Windows' system bash.exe is a WSL launcher, not a portable test shell.
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
  if (git.status === 0) {
    const candidate = path.resolve(git.stdout.trim(), '../../../bin/bash.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
const bash = findBash();
const shellOptions = { skip: !bash };
function shellPath(value) {
  const normalized = value.replaceAll('\\', '/');
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function deployment(args = [], { fail, prepare, version = '2.33.1', separateDirectory = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-deploy-test-'));
  const target = separateDirectory ? path.join(root, 'deployment only') : root;
  try {
    for (const directory of ['scripts', 'mock-bin']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.mkdirSync(path.join(target, 'data/keys'), { recursive: true });
    fs.copyFileSync(path.join(source, 'scripts/deploy-docker.sh'), path.join(root, 'scripts/deploy-docker.sh'));
    fs.writeFileSync(path.join(target, '.env'), 'DO_NOT_EXECUTE=$(touch .env-was-sourced)\nDB_PASSWORD=test-only-secret\n');
    for (const file of ['docker-compose.yaml', 'docker-compose.mysql.yaml', 'private registry.yaml']) {
      fs.writeFileSync(path.join(target, file), 'services: {}\n');
    }
    const mock = path.join(root, 'mock-bin/docker');
    fs.writeFileSync(mock, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\034' "$@" >> "$MOCK_DOCKER_LOG"
printf '\\n' >> "$MOCK_DOCKER_LOG"
if [[ "$1" == compose && "$2" == version ]]; then printf '%s\\n' "$MOCK_COMPOSE_VERSION"; exit 0; fi
if [[ "$1" == info ]]; then printf 'linux\\n'; exit 0; fi
phase=
case " $* " in
  *' config --quiet '*) phase=config ;;
  *' pull '*) phase=pull ;;
  *'scripts/check-container-mounts.js '*) phase=mounts ;;
  *' npm run check:config '*) phase=static ;;
  *' npm run init-db '*) phase=migrate ;;
  *' up '*' mysql '*) phase=mysql ;;
  *' up '*' gateway '*) phase=gateway ;;
  *' up '*' watchtower '*) phase=updater ;;
esac
if [[ -n "$phase" && "$phase" == "$MOCK_FAIL" ]]; then exit 19; fi
`, { mode: 0o755 });
    if (prepare) prepare(target);
    const logFile = path.join(root, 'docker.log');
    const result = spawnSync(bash, ['-c', 'export PATH="$1:$PATH"; exec bash "$2" "${@:3}"', '--',
      shellPath(path.join(root, 'mock-bin')), shellPath(path.join(root, 'scripts/deploy-docker.sh')), ...args], {
      cwd: root,
      env: { ...process.env, MOCK_DOCKER_LOG: shellPath(logFile), MOCK_COMPOSE_VERSION: version, MOCK_FAIL: fail || '' },
      encoding: 'utf8', windowsHide: true, timeout: 30000
    });
    const commands = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map(line => line.split('\x1c').filter(Boolean)) : [];
    assert.doesNotMatch(result.stdout + result.stderr, /test-only-secret/);
    assert.equal(fs.existsSync(path.join(root, '.env-was-sourced')), false, '.env must never be executed as shell code');
    assert.equal(fs.existsSync(path.join(target, '.env-was-sourced')), false, 'the selected .env must never be executed');
    // Git Bash resolves a Windows-inherited working directory to its own mount form (for example
    // /tmp instead of /d/AppData/Local/Temp), so derive the expected path the same way the script does.
    const canonicalTarget = separateDirectory ? spawnSync(bash, ['-c', 'pwd -P'], {
      cwd: target, encoding: 'utf8', windowsHide: true
    }).stdout.trim() : shellPath(target);
    return { ...result, commands, lines: commands.map(command => command.join(' ')), targetFiles: fs.readdirSync(target).sort(), target: canonicalTarget };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function index(result, pattern) { return result.lines.findIndex(line => pattern.test(line)); }
function noMutation(result) {
  assert.ok(result.lines.every(line => !/\b(stop|up)\b|npm run init-db/.test(line)), result.lines.join('\n'));
}

test('external deployment checks first, requires explicit migration, and controls only project services', shellOptions, () => {
  const result = deployment(['--backup-confirmed']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(index(result, /scripts\/check-container-mounts\.js/) < index(result, /npm run check:config/));
  assert.ok(index(result, /npm run check:config/) < index(result, /stop watchtower/));
  assert.ok(index(result, /stop gateway/) < index(result, /npm run init-db/));
  assert.ok(index(result, /npm run init-db/) < index(result, /up .*--force-recreate .*gateway$/));
  assert.equal(index(result, /docker-compose\.mysql\.yaml/), -1);
  assert.equal(index(result, /up .*watchtower$/), -1);
  assert.ok(result.lines.every(line => !/\b(down|kill|prune)\b/.test(line)));
  assert.match(result.stdout, /Verification commands/);
});

test('bundled deployment waits for MySQL, migrates, then starts gateway and optional updater', shellOptions, () => {
  const result = deployment(['--db', 'bundled', '--backup-confirmed', '--watchtower']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(index(result, /pull gateway mysql watchtower/) >= 0);
  assert.ok(index(result, /up .*--wait .*mysql$/) < index(result, /npm run init-db/));
  assert.ok(index(result, /npm run init-db/) < index(result, /up .*gateway$/));
  assert.ok(index(result, /up .*gateway$/) < index(result, /--profile auto-update up .*watchtower$/));
  assert.ok(result.commands.filter(command => command.includes('config')).every(command => command.includes('--quiet')));
  const starts = result.commands.filter(command => command.includes('up'));
  assert.equal(starts.length, 3);
  for (const command of starts) {
    const pull = command.indexOf('--pull');
    assert.notEqual(pull, -1, 'startup must reuse the explicitly pulled and checked image');
    assert.equal(command[pull + 1], 'never');
  }
});

test('noninteractive migration without backup acknowledgement performs no stop, migration, or startup', shellOptions, () => {
  const result = deployment();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Backup confirmation is required/);
  noMutation(result);
});

test('skip-migrate only restarts an explicitly prepared schema', shellOptions, () => {
  const result = deployment(['--skip-migrate']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(index(result, /npm run init-db/), -1);
  assert.ok(index(result, /up .*gateway$/) >= 0);
  assert.match(result.stdout, /already prepared schema/);
});

for (const phase of ['config', 'pull', 'mounts', 'static']) {
  test(`failed ${phase} preflight prevents all service stops and database writes`, shellOptions, () => {
    const result = deployment(['--backup-confirmed', '--watchtower'], { fail: phase });
    assert.notEqual(result.status, 0);
    noMutation(result);
  });
}

for (const phase of ['mysql', 'migrate', 'gateway']) {
  test(`failed ${phase} step prevents later gateway/updater actions`, shellOptions, () => {
    const result = deployment(['--db', 'bundled', '--backup-confirmed', '--watchtower'], { fail: phase });
    assert.notEqual(result.status, 0);
    assert.equal(index(result, /up .*watchtower$/), -1);
    if (phase === 'mysql') assert.equal(index(result, /npm run init-db/), -1);
    if (phase !== 'gateway') assert.equal(index(result, /up .*gateway$/), -1);
    assert.match(result.stderr, /no host process was stopped/);
  });
}

test('missing data or nested keys fail before invoking Docker', shellOptions, () => {
  for (const missing of ['data/keys', 'data']) {
    const result = deployment(['--backup-confirmed'], { prepare: root => fs.rmSync(path.join(root, missing), { recursive: true }) });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.commands, []);
  }
});

test('explicit override paths remain single arguments, including spaces', shellOptions, () => {
  const result = deployment(['--backup-confirmed', '--override', 'private registry.yaml']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.commands.filter(command => command.includes('--quiet')).every(command => command.some(arg => arg.endsWith('/private registry.yaml'))));
});

test('an external script selects a minimal deployment directory without host assets or top-level keys', shellOptions, () => {
  const result = deployment(['--backup-confirmed', '--override', 'private registry.yaml', '--directory', 'deployment only'], { separateDirectory: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.targetFiles, ['.env', 'data', 'docker-compose.mysql.yaml', 'docker-compose.yaml', 'private registry.yaml']);
  for (const command of result.commands.filter(command => command.includes('--project-directory'))) {
    assert.equal(command[command.indexOf('--project-directory') + 1], result.target);
    assert.equal(command[command.indexOf('--env-file') + 1], `${result.target}/.env`);
    assert.ok(command.includes(`${result.target}/private registry.yaml`), 'override resolution uses the selected directory even when its flag came first');
  }
});

test('invalid flags, modes, and missing override values fail without Docker calls', shellOptions, () => {
  for (const args of [['--db', 'unknown'], ['--db'], ['--override'], ['--unknown'], ['--directory'], ['--directory', 'nonexistent-deployment']]) {
    const result = deployment(args);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.commands, []);
  }
});

test('Compose versions below the network feature minimum are rejected before configuration', shellOptions, () => {
  for (const version of ['2.32.9', '2.33.0', '1.29.2', 'unknown']) {
    const result = deployment(['--backup-confirmed'], { version });
    assert.notEqual(result.status, 0);
    assert.equal(index(result, /config --quiet/), -1);
  }
  assert.equal(deployment(['--skip-migrate'], { version: 'v5.5.1' }).status, 0);
});
