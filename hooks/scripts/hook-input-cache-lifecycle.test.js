// Regression tests for GitHub issue #74 — the PostToolUse stdin-handoff cache
// (`.claude/.hook-tool-input.<PPID>`) accumulated one file per tool call.
//
// Two facts drive these tests:
//   1. The key is $PPID — the PID of the per-invocation node bootstrap — so the
//      cache is effectively per tool call, not per session.
//   2. hook-shell-adapter.js passes CLAUDE_TOOL_INPUT to phase-transition.sh,
//      so on the production path the cache fallback branch never runs and the
//      file is written but never consumed.
//
// The fix is therefore an *unconditional* delete in phase-transition.sh, which
// must fire whether or not the cache was the source of TOOL_INPUT.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PHASE_TRANSITION = path.resolve(__dirname, 'phase-transition.sh');
const SESSION_END = path.resolve(__dirname, 'session-end.sh');
const ADAPTER = path.resolve(__dirname, 'hook-shell-adapter.js');

describe('hook stdin-cache lifecycle (issue #74)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-cache-'));
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeStateFile(sid, fields) {
    const yaml = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
    const fp = path.join(tmpDir, '.claude', `deep-work.${sid}.md`);
    fs.writeFileSync(fp, `---\n${yaml}\n---\n`);
    fs.writeFileSync(path.join(tmpDir, '.claude', 'deep-work-current-session'), sid);
    return fp;
  }

  function cacheFiles() {
    return fs.readdirSync(path.join(tmpDir, '.claude'))
      .filter((f) => f.startsWith('.hook-tool-input.'));
  }

  it('phase-transition.sh deletes the cache it consumed (env unset)', () => {
    const stateFile = writeStateFile('s-del1', {
      current_phase: 'plan',
      worktree_enabled: 'true',
      worktree_path: '"/tmp/wt"',
      team_mode: 'team',
    });

    const cacheFile = path.join(tmpDir, '.claude', `.hook-tool-input.${process.pid}`);
    fs.writeFileSync(cacheFile, JSON.stringify({ file_path: stateFile }));

    const env = { ...process.env };
    delete env.CLAUDE_TOOL_USE_INPUT;
    delete env.CLAUDE_TOOL_INPUT;

    const result = spawnSync('bash', [PHASE_TRANSITION], {
      cwd: tmpDir, env, encoding: 'utf8', timeout: 5000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.match(result.stdout, /Phase Transition/, 'cache must still be consumed');
    assert.equal(fs.existsSync(cacheFile), false,
      'phase-transition.sh must remove the cache after reading it');
  });

  it('phase-transition.sh deletes the cache even when CLAUDE_TOOL_INPUT is set (adapter path)', () => {
    // This is the production topology: hook-shell-adapter.js hands the tool
    // input to phase-transition.sh via env, so the cache fallback branch never
    // runs. Before the fix nothing deleted the file and it leaked on every
    // single PostToolUse call.
    const stateFile = writeStateFile('s-del2', {
      current_phase: 'plan',
      worktree_enabled: 'true',
      worktree_path: '"/tmp/wt"',
      team_mode: 'team',
    });

    const cacheFile = path.join(tmpDir, '.claude', `.hook-tool-input.${process.pid}`);
    fs.writeFileSync(cacheFile, JSON.stringify({ file_path: stateFile }));

    const result = spawnSync('bash', [PHASE_TRANSITION], {
      cwd: tmpDir,
      env: { ...process.env, CLAUDE_TOOL_INPUT: JSON.stringify({ file_path: stateFile }) },
      encoding: 'utf8',
      timeout: 5000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(fs.existsSync(cacheFile), false,
      'phase-transition.sh must remove the PPID cache regardless of the input source');
  });

  it('phase-transition.sh deletes the cache before its own early exits', () => {
    // TOOL_INPUT resolves, but the payload names no file_path, so the script
    // exits early. The cache must already be gone by then.
    const stateFile = writeStateFile('s-del3', { current_phase: 'plan' });
    const cacheFile = path.join(tmpDir, '.claude', `.hook-tool-input.${process.pid}`);
    fs.writeFileSync(cacheFile, JSON.stringify({ command: 'ls -la' }));

    const env = { ...process.env };
    delete env.CLAUDE_TOOL_USE_INPUT;
    delete env.CLAUDE_TOOL_INPUT;

    const result = spawnSync('bash', [PHASE_TRANSITION], {
      cwd: tmpDir, env, encoding: 'utf8', timeout: 5000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(fs.existsSync(cacheFile), false,
      'an early exit must not strand the cache file');
    assert.ok(stateFile);
  });

  it('repeated post-tool cycles do not accumulate cache files', () => {
    const stateFile = writeStateFile('s-accum', {
      current_phase: 'plan',
      worktree_enabled: 'true',
      worktree_path: '"/tmp/wt"',
      team_mode: 'team',
    });
    const toolInput = JSON.stringify({ file_path: stateFile });

    // Drive the real entry point rather than the two scripts by hand:
    // `hook-shell-adapter.js post-tool` spawnSyncs both from one node process,
    // so they share a $PPID exactly as they do in production. Reproducing that
    // with a bash wrapper is not portable — bash may exec-optimise the last
    // command of a `-c` string, which changes the parent of one script only.
    for (let i = 0; i < 5; i++) {
      const cycle = spawnSync(process.execPath, [ADAPTER, 'post-tool'], {
        input: toolInput,
        cwd: tmpDir,
        env: { ...process.env, CLAUDE_TOOL_USE_TOOL_NAME: 'Write', DEEP_WORK_SESSION_ID: 's-accum' },
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(cycle.status, 0, `cycle ${i} failed: ${cycle.stderr}`);
    }

    assert.deepEqual(cacheFiles(), [],
      `5 post-tool cycles must leave no cache files, found: ${cacheFiles().join(', ')}`);
  });

  it('session-end.sh sweeps stale cache files left by crashed invocations', () => {
    writeStateFile('s-sweep', { current_phase: 'plan' });

    const stale = path.join(tmpDir, '.claude', '.hook-tool-input.999001');
    fs.writeFileSync(stale, '{}');
    const twoHoursAgo = Date.now() / 1000 - 7200;
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

    const result = spawnSync('bash', [SESSION_END], {
      cwd: tmpDir,
      env: { ...process.env, DEEP_WORK_SESSION_ID: 's-sweep' },
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.equal(fs.existsSync(stale), false,
      'session-end.sh must sweep cache files older than the retention window');
  });
});
