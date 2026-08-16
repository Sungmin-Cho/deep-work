'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  locateDeepModelRouter,
  findPython3,
} = require('./locate-deep-model-router.js');

function tmpHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRouteTask(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '#!/usr/bin/env python3\nprint("ok")\n');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

test('DEEP_MODEL_ROUTER_CLI wins when it is an executable route_task.py', () => {
  const home = tmpHome('dw-locate-cli-');
  const cli = writeRouteTask(path.join(home, 'injected', 'route_task.py'));
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: cli },
    home,
  });
  assert.equal(found, fs.realpathSync(cli));
});

test('DEEP_MODEL_ROUTER_CLI from the source checkout is accepted (dev/CI override)', () => {
  const home = tmpHome('dw-locate-src-');
  const sourceCli = writeRouteTask(path.join(home, 'claude-plugins', 'deep-model-router',
    'skills', 'model-router', 'scripts', 'route_task.py'));
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: sourceCli },
    home,
  });
  assert.equal(found, fs.realpathSync(sourceCli));
});

test('DEEP_MODEL_ROUTER_ROOT locates only an installed/cache plugin root', () => {
  const home = tmpHome('dw-locate-root-');
  const root = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'deep-model-router', '1.2.0');
  const cli = writeRouteTask(path.join(root, 'skills', 'model-router', 'scripts', 'route_task.py'));
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: root },
    home,
  });
  assert.equal(found, fs.realpathSync(cli));
});

test('DEEP_MODEL_ROUTER_ROOT rejects a source checkout and a relative sibling', () => {
  const home = tmpHome('dw-locate-root-src-');
  const sourceRoot = path.join(home, 'claude-plugins', 'deep-model-router');
  writeRouteTask(path.join(sourceRoot, 'skills', 'model-router', 'scripts', 'route_task.py'));
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: sourceRoot },
    home,
  }), null);
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: '../deep-model-router' },
    home,
    cwd: home,
  }), null);
});

test('DEEP_MODEL_ROUTER_ROOT rejects a personal skill tree even via symlink', () => {
  const home = tmpHome('dw-locate-root-link-');
  const personal = writeRouteTask(path.join(home, '.claude', 'skills', 'model-router',
    'scripts', 'route_task.py'));
  const root = path.join(home, 'alias-root');
  fs.mkdirSync(path.join(root, 'skills', 'model-router', 'scripts'), { recursive: true });
  fs.symlinkSync(personal, path.join(root, 'skills', 'model-router', 'scripts', 'route_task.py'));
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: root },
    home,
  }), null);
});

test('Claude cache hit prefers the highest semver directory', () => {
  const home = tmpHome('dw-locate-cache-');
  writeRouteTask(path.join(home, '.claude', 'plugins', 'cache', 'mkt',
    'deep-model-router', '1.0.0', 'skills', 'model-router', 'scripts', 'route_task.py'));
  const newer = writeRouteTask(path.join(home, '.claude', 'plugins', 'cache', 'mkt',
    'deep-model-router', '1.10.0', 'skills', 'model-router', 'scripts', 'route_task.py'));
  writeRouteTask(path.join(home, '.claude', 'plugins', 'cache', 'mkt',
    'deep-model-router', '1.2.0', 'skills', 'model-router', 'scripts', 'route_task.py'));
  const found = locateDeepModelRouter({ env: {}, home });
  assert.equal(found, fs.realpathSync(newer));
});

test('Codex cache is used when Claude cache is empty', () => {
  const home = tmpHome('dw-locate-codex-');
  const cli = writeRouteTask(path.join(home, '.codex', 'plugins', 'cache',
    'deep-model-router', '1.0.0', 'skills', 'model-router', 'scripts', 'route_task.py'));
  const found = locateDeepModelRouter({ env: {}, home });
  assert.equal(found, fs.realpathSync(cli));
});

test('missing router returns null', () => {
  const home = tmpHome('dw-locate-miss-');
  assert.equal(locateDeepModelRouter({ env: {}, home }), null);
});

test('personal ~/.claude/skills/model-router symlink is never returned', () => {
  const home = tmpHome('dw-locate-symlink-');
  const personal = writeRouteTask(path.join(home, '.claude', 'skills', 'model-router',
    'scripts', 'route_task.py'));
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: personal },
    home,
  }), null);
  assert.equal(locateDeepModelRouter({ env: {}, home }), null);
});

test('relative ../deep-model-router is never returned', () => {
  const home = tmpHome('dw-locate-rel-');
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: '../deep-model-router/skills/model-router/scripts/route_task.py' },
    home,
    cwd: home,
  });
  assert.equal(found, null);
});

test('non-executable or non-route_task CLI path is ignored', () => {
  const home = tmpHome('dw-locate-badcli-');
  const other = path.join(home, 'not-the-router.py');
  fs.writeFileSync(other, 'print(1)\n');
  fs.chmodSync(other, 0o755);
  assert.equal(locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: other },
    home,
  }), null);
});

test('python3-unavailable: findPython3 returns null when the binary cannot run', () => {
  const found = findPython3({
    env: { PYTHON3: '/definitely/missing/python3', PATH: '' },
    execFileSync: () => { throw new Error('ENOENT'); },
  });
  assert.equal(found, null);
});

test('python3-unavailable: findPython3 returns the working binary', () => {
  const found = findPython3({
    env: { PYTHON3: '/opt/custom/python3' },
    execFileSync: (bin, args) => {
      assert.equal(bin, 'python3');
      assert.deepEqual(args, ['-c', 'import sys']);
      return '';
    },
  });
  assert.equal(found, 'python3');
});
