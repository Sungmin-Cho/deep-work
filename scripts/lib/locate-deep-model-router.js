'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROUTE_TASK = 'route_task.py';
const RELATIVE_SIBLING = /\.\.[/\\]+deep-model-router\b/;

function normalize(p) {
  return String(p).replace(/\\/g, '/');
}

function isPersonalSkillPath(p) {
  const text = normalize(p);
  return text.includes('/.claude/skills/model-router')
    || text.includes('/.codex/skills/model-router');
}

function isRouteTask(filePath) {
  try {
    const resolved = fs.realpathSync(filePath);
    if (path.basename(resolved) !== ROUTE_TASK) return false;
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function resolveRouteTask(filePath) {
  if (!isRouteTask(filePath)) return null;
  if (isPersonalSkillPath(filePath)) return null;
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function parseSemver(raw) {
  const m = String(raw).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i += 1) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  }
  if (pa && !pb) return 1;
  if (!pa && pb) return -1;
  return String(a).localeCompare(String(b));
}

function walkFiles(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, acc);
    else if (entry.isFile()) acc.push(full);
  }
  return acc;
}

function versionFromCachePath(filePath) {
  const text = normalize(filePath);
  const m = text.match(/\/deep-model-router\/([^/]+)\/skills\/model-router\/scripts\/route_task\.py$/);
  return m ? m[1] : null;
}

function isCacheRouteTask(filePath) {
  return versionFromCachePath(filePath) !== null && isRouteTask(filePath)
    && !isPersonalSkillPath(filePath);
}

function bestCacheHit(cacheRoot) {
  if (!cacheRoot) return null;
  try {
    if (!fs.statSync(cacheRoot).isDirectory()) return null;
  } catch {
    return null;
  }
  const hits = walkFiles(cacheRoot, []).filter(isCacheRouteTask);
  if (!hits.length) return null;
  hits.sort((a, b) => compareSemver(versionFromCachePath(a), versionFromCachePath(b)));
  return fs.realpathSync(hits[hits.length - 1]);
}

function locateDeepModelRouter({ env, home, cwd } = {}) {
  const e = env || process.env;
  const homeDir = home || os.homedir();

  const cli = e.DEEP_MODEL_ROUTER_CLI;
  if (cli) {
    if (!RELATIVE_SIBLING.test(cli) && !isPersonalSkillPath(cli)) {
      const hit = resolveRouteTask(path.isAbsolute(cli) ? cli : path.resolve(cwd || process.cwd(), cli));
      if (hit) return hit;
    }
  }

  const root = e.DEEP_MODEL_ROUTER_ROOT;
  if (root) {
    const hit = resolveRouteTask(path.join(root, 'skills', 'model-router', 'scripts', ROUTE_TASK));
    if (hit) return hit;
  }

  const claude = bestCacheHit(path.join(homeDir, '.claude', 'plugins', 'cache'));
  if (claude) return claude;
  return bestCacheHit(path.join(homeDir, '.codex', 'plugins'));
}

function findPython3({ env, execFileSync } = {}) {
  const exec = execFileSync || require('node:child_process').execFileSync;
  const e = env || process.env;
  const candidates = [];
  if (e.PYTHON3) candidates.push(e.PYTHON3);
  candidates.push('python3');
  for (const bin of candidates) {
    try {
      exec(bin, ['-c', 'import sys'], {
        encoding: 'utf8',
        env: e,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}

module.exports = { locateDeepModelRouter, findPython3 };
