const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, 'update-check.sh');
const LOCAL_VERSION = require('../../package.json').version;

// ─── URL anchor (no network) ───────────────────────────────
// The remote package.json lives at the repo ROOT. The previous
// `.../main/plugins/deep-work/package.json` path 404'd (no plugins/ subtree),
// so every fetch failed and the cache was poisoned UP_TO_DATE — permanently
// killing the update prompt.

describe('update-check.sh — remote URL', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');

  it('points at the repo-root package.json (not plugins/deep-work/)', () => {
    // Check the REMOTE_URL assignment itself, not the surrounding comment that
    // documents the old broken path.
    const urlLine = src.split('\n').find((l) => l.trim().startsWith('REMOTE_URL='));
    assert.ok(urlLine, 'REMOTE_URL assignment line present');
    assert.match(urlLine, /raw\.githubusercontent\.com\/Sungmin-Cho\/deep-work\/main\/package\.json/);
    assert.doesNotMatch(urlLine, /plugins\/deep-work/);
  });
});

// ─── Fetch failure vs. up-to-date (fake curl, no network) ──

describe('update-check.sh — fetch failure never poisons the cache', () => {
  let home;
  let proj;
  let bin;

  function run(curlBody) {
    // Fake `curl` shadows the real one; everything else stays on PATH.
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\n${curlBody}\n`);
    fs.chmodSync(path.join(bin, 'curl'), 0o755);
    return spawnSync('bash', [SCRIPT], {
      cwd: proj,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
  }

  const cacheFile = () => path.join(home, '.claude', '.deep-work-update-cache');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-home-'));
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-proj-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-bin-'));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  });
  afterEach(() => {
    for (const d of [home, proj, bin]) {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('curl failure (non-zero exit) → exit 0, NO cache written', () => {
    const r = run('exit 22');
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(fs.existsSync(cacheFile()), false,
      'a failed fetch must not create the cache (was written as UP_TO_DATE pre-fix)');
  });

  it('empty body (200 but blank) → exit 0, NO cache written', () => {
    const r = run("printf ''");
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(fs.existsSync(cacheFile()), false);
  });

  it('non-version body (HTML error page) → exit 0, NO cache written', () => {
    const r = run("printf '<!DOCTYPE html><h1>404</h1>'");
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(fs.existsSync(cacheFile()), false);
  });

  it('same version → caches UP_TO_DATE (genuine up-to-date is still cached)', () => {
    const r = run(`printf '%s' '{"version":"${LOCAL_VERSION}"}'`);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(fs.existsSync(cacheFile()), true);
    assert.match(fs.readFileSync(cacheFile(), 'utf8'), new RegExp(`^UP_TO_DATE ${LOCAL_VERSION.replace(/\./g, '\\.')}`));
  });

  it('newer remote version → prints + caches UPGRADE_AVAILABLE', () => {
    const r = run(`printf '%s' '{"version":"999.0.0"}'`);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^UPGRADE_AVAILABLE /);
    assert.match(fs.readFileSync(cacheFile(), 'utf8'), /^UPGRADE_AVAILABLE /);
  });
});
