'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURE = path.join(__dirname, '..', '..', 'tests', 'fixtures',
  'sample-slice-receipt.json');
const SCRIPT = path.join(__dirname, 'session-end.sh');

function runSession(receipt) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'session-end-model-'));
  const sid = 'model-extract-test';
  const receipts = path.join(project, '.deep-work', 'test', 'receipts');
  fs.mkdirSync(path.join(project, '.git'));
  fs.mkdirSync(path.join(project, '.claude'));
  fs.mkdirSync(receipts, { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'deep-work.' + sid + '.md'), [
    '---',
    'current_phase: implement',
    'work_dir: .deep-work/test',
    'started_at: 2026-08-20T00:00:00.000Z',
    'tdd_mode: strict',
    'test_retry_count: 0',
    '---',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(project, '.claude', 'deep-work-current-session'), sid);
  fs.writeFileSync(path.join(receipts, 'SLICE-001.json'), JSON.stringify(receipt) + '\n');

  try {
    const result = spawnSync('bash', [SCRIPT], {
      cwd: project,
      env: { ...process.env, DEEP_WORK_SESSION_ID: sid },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined, result.error && result.error.message);
    assert.equal(result.status, 0, 'session-end.sh failed: ' + result.stderr);
    const history = path.join(project, '.deep-work', 'harness-history',
      'harness-sessions.jsonl');
    assert.ok(fs.existsSync(history), 'history was not written: ' + result.stderr);
    const lines = fs.readFileSync(history, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}

test('session-end records the current envelope model_id', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const history = runSession(fixture);
  assert.equal(history.slices[0].model, 'claude-sonnet-4-5');
});

test('session-end falls back to legacy top-level model_used', () => {
  const history = runSession({
    slice_id: 'SLICE-001',
    status: 'complete',
    tdd_mode: 'strict',
    model_used: 'legacy-haiku',
  });
  assert.equal(history.slices[0].model, 'legacy-haiku');
});

test('session-end prefers model_id when both model fields exist', () => {
  const history = runSession({
    slice_id: 'SLICE-001',
    status: 'complete',
    tdd_mode: 'strict',
    model_id: 'current-sonnet',
    model_used: 'legacy-haiku',
  });
  assert.equal(history.slices[0].model, 'current-sonnet');
});
