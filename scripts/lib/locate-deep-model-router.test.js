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
  const sourceCli = '/Users/sungmin/Dev/claude-plugins/deep-model-router/skills/model-router/scripts/route_task.py';
  assert.ok(fs.existsSync(sourceCli), 'P2a tests require the local router checkout');
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_CLI: sourceCli },
    home,
  });
  assert.equal(found, fs.realpathSync(sourceCli));
});

test('DEEP_MODEL_ROUTER_ROOT locates skills/model-router/scripts/route_task.py', () => {
  const home = tmpHome('dw-locate-root-');
  const root = path.join(home, 'plugin-root');
  const cli = writeRouteTask(path.join(root, 'skills', 'model-router', 'scripts', 'route_task.py'));
  const found = locateDeepModelRouter({
    env: { DEEP_MODEL_ROUTER_ROOT: root },
    home,
  });
  assert.equal(found, fs.realpathSync(cli));
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
      assert.equal(bin, '/opt/custom/python3');
      assert.deepEqual(args, ['-c', 'import sys']);
      return '';
    },
  });
  assert.equal(found, '/opt/custom/python3');
});
