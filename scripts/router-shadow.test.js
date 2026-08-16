'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  recordRouterShadow,
  buildShadowRequest,
} = require('./router-shadow.js');

const ROOT = path.resolve(__dirname, '..');
const REAL_CLI = '/Users/sungmin/Dev/claude-plugins/deep-model-router/skills/model-router/scripts/route_task.py';
const CLI = path.join(__dirname, 'model-routing-cli.js');
const SHADOW_CLI = path.join(__dirname, 'router-shadow.js');

function authorityFromCli(args = []) {
  const out = execFileSync(process.execPath, [
    CLI, '--root', ROOT, '--task', 'shadow authority probe',
    '--runtime', 'claude', ...args,
  ], { encoding: 'utf8' });
  return { raw: out, parsed: JSON.parse(out) };
}

function sampleRequest(overrides = {}) {
  return {
    route_schema_version: 1,
    task_class: 'IMPLEMENTATION',
    complexity: 1,
    uncertainty: 1,
    blast_radius: 1,
    reversibility: 1,
    reasoning_centric: false,
    flags: [],
    runtime: 'claude_code',
    prior_failures: [],
    ...overrides,
  };
}

function mockInvoke(outcome) {
  return () => outcome;
}

test('authority JSON is deepEqual to the input MR_OUT (live router)', () => {
  assert.ok(fs.existsSync(REAL_CLI), 'P2a tests require the local router checkout');
  const { raw, parsed } = authorityFromCli();
  const original = JSON.parse(raw);
  const result = recordRouterShadow({
    mrOut: parsed,
    request: sampleRequest(),
    env: { ...process.env, DEEP_MODEL_ROUTER_CLI: REAL_CLI },
  });
  assert.deepEqual(result.authority, original);
  assert.deepEqual(result.authority.model_routing, original.model_routing);
  assert.notEqual(result.authority, parsed);
  assert.ok(result.shadow);
  assert.equal(typeof result.shadow.dispatch_authorized, 'boolean');
  assert.ok(result.shadow.input_hash);
  assert.ok('latency_ms' in result.shadow);
  assert.ok('exit' in result.shadow);
});

test('HIGH/CRITICAL router error does not rewrite model_routing', () => {
  const { parsed } = authorityFromCli(['--risk-class', 'critical']);
  const before = JSON.parse(JSON.stringify(parsed.model_routing));
  const result = recordRouterShadow({
    mrOut: parsed,
    request: sampleRequest({
      complexity: 3, uncertainty: 3, blast_radius: 3, reversibility: 3,
    }),
    env: { ...process.env, DEEP_MODEL_ROUTER_CLI: REAL_CLI },
    localRiskBand: 'CRITICAL',
    invoke: mockInvoke({
      exit: 5,
      stdout: '',
      stderr: 'internal error: boom',
      processState: 'exited',
    }),
  });
  assert.deepEqual(result.authority.model_routing, before);
  assert.deepEqual(result.authority.model_routing, parsed.model_routing);
  assert.equal(result.shadow.dispatch_authorized, false);
  assert.equal(result.shadow.status, 'internal');
  assert.notEqual(result.shadow.routing_provenance, 'local-fallback');
  assert.ok(result.shadow.degrade_reason);
});

test('shadow records comparison fields without mutating authority', () => {
  const mrOut = {
    model_routing: { brainstorm: 'main', research: 'sonnet', plan: 'main', implement: 'opus', test: 'haiku' },
    meta: { runtime: 'claude', tiers: { implement: 'deep' }, efforts: { implement: { effort: 'high' } } },
    warnings: [],
  };
  const snapshot = JSON.parse(JSON.stringify(mrOut));
  const result = recordRouterShadow({
    mrOut,
    request: sampleRequest(),
    env: {},
    invoke: mockInvoke({
      exit: 0,
      stdout: JSON.stringify({
        route_schema_version: 1,
        router_plugin_version: '1.0.0',
        policy_sha256: 'c'.repeat(64),
        selected_model: 'gpt-5.6-luna',
        selected_effort: 'LOW',
        selected_effort_native: 'low',
        risk_band: 'LOW',
        review: { band: 'LOW', reviewers: ['worker_fast'] },
      }),
      stderr: '',
      processState: 'exited',
    }),
  });
  assert.deepEqual(mrOut, snapshot);
  assert.deepEqual(result.authority, snapshot);
  assert.equal(result.shadow.dispatch_authorized, true);
  assert.equal(result.shadow.identity.route_schema_version, 1);
  assert.equal(result.shadow.identity.router_plugin_version, '1.0.0');
  assert.equal(result.shadow.identity.policy_sha256, 'c'.repeat(64));
  assert.equal(result.shadow.comparison.router.selected_model, 'gpt-5.6-luna');
  assert.equal(result.shadow.comparison.authority.implement, 'opus');
  assert.equal(result.shadow.comparison.downgrade, true);
});

test('first digest is frozen; a later mismatch is invalid and leaves MR_OUT alone', () => {
  const mrOut = {
    model_routing: { implement: 'sonnet', research: 'sonnet', plan: 'main', brainstorm: 'main', test: 'haiku' },
    meta: { runtime: 'claude', tiers: {} },
    warnings: [],
  };
  const first = recordRouterShadow({
    mrOut,
    request: sampleRequest(),
    env: {},
    invoke: mockInvoke({
      exit: 0,
      stdout: JSON.stringify({
        route_schema_version: 1,
        router_plugin_version: '1.0.0',
        policy_sha256: 'd'.repeat(64),
        selected_model: 'sonnet',
        selected_effort: 'HIGH',
        risk_band: 'MEDIUM',
        review: { band: 'MEDIUM', reviewers: [] },
      }),
      stderr: '',
      processState: 'exited',
    }),
  });
  assert.equal(first.shadow.status, 'ok');
  assert.equal(first.shadow.policy_sha256, 'd'.repeat(64));
  assert.equal(first.shadow.frozen_digest, 'd'.repeat(64));

  const before = JSON.parse(JSON.stringify(mrOut.model_routing));
  const second = recordRouterShadow({
    mrOut,
    request: sampleRequest(),
    env: {},
    frozenDigest: first.shadow.frozen_digest,
    invoke: mockInvoke({
      exit: 0,
      stdout: JSON.stringify({
        route_schema_version: 1,
        router_plugin_version: '1.0.0',
        policy_sha256: 'e'.repeat(64),
        selected_model: 'haiku',
        selected_effort: 'LOW',
        risk_band: 'LOW',
        review: { band: 'LOW', reviewers: [] },
      }),
      stderr: '',
      processState: 'exited',
    }),
  });
  assert.deepEqual(second.authority.model_routing, before);
  assert.equal(second.shadow.status, 'invalid');
  assert.equal(second.shadow.dispatch_authorized, false);
  assert.match(String(second.shadow.degrade_reason), /digest/i);
  assert.equal(second.shadow.frozen_digest, 'd'.repeat(64));
});

test('matching frozen digest stays ok', () => {
  const digest = 'f'.repeat(64);
  const result = recordRouterShadow({
    mrOut: { model_routing: { implement: 'sonnet' }, meta: {}, warnings: [] },
    request: sampleRequest(),
    env: {},
    frozenDigest: digest,
    invoke: mockInvoke({
      exit: 0,
      stdout: JSON.stringify({
        route_schema_version: 1,
        router_plugin_version: '1.0.0',
        policy_sha256: digest,
        selected_model: 'sonnet',
        selected_effort: 'HIGH',
        risk_band: 'MEDIUM',
        review: { reviewers: [] },
      }),
      stderr: '',
      processState: 'exited',
    }),
  });
  assert.equal(result.shadow.status, 'ok');
  assert.equal(result.shadow.dispatch_authorized, true);
});

test('recordRouterShadow never throws into the orchestrator', () => {
  const mrOut = { model_routing: { implement: 'main' }, meta: { error: true }, warnings: ['x'] };
  const result = recordRouterShadow({
    mrOut,
    request: sampleRequest(),
    env: {},
    invoke: () => { throw new Error('spawn exploded'); },
  });
  assert.deepEqual(result.authority.model_routing, mrOut.model_routing);
  assert.equal(result.shadow.dispatch_authorized, false);
  assert.match(result.shadow.status, /^(internal|unavailable)$/);
});

test('missing router is unavailable shadow, authority intact', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-shadow-miss-'));
  const mrOut = { model_routing: { implement: 'opus' }, meta: {}, warnings: [] };
  const result = recordRouterShadow({
    mrOut,
    request: sampleRequest(),
    env: {},
    home,
  });
  assert.deepEqual(result.authority.model_routing, mrOut.model_routing);
  assert.equal(result.shadow.status, 'unavailable');
  assert.equal(result.shadow.dispatch_authorized, false);
});

test('python3-unavailable is recorded as unavailable, authority intact', () => {
  const mrOut = { model_routing: { implement: 'opus' }, meta: {}, warnings: [] };
  const result = recordRouterShadow({
    mrOut,
    request: sampleRequest(),
    env: { DEEP_MODEL_ROUTER_CLI: REAL_CLI, PYTHON3: '/definitely/missing/python3', PATH: '/empty' },
    findPython3: () => null,
  });
  assert.deepEqual(result.authority.model_routing, { implement: 'opus' });
  assert.equal(result.shadow.status, 'unavailable');
  assert.match(String(result.shadow.degrade_reason), /python3/i);
});

test('buildShadowRequest emits RouteRequestV1 with host runtime mapped', () => {
  const req = buildShadowRequest({
    runtime: 'claude',
    riskClass: 'high',
    taskClass: 'IMPLEMENTATION',
  });
  assert.equal(req.route_schema_version, 1);
  assert.equal(req.task_class, 'IMPLEMENTATION');
  assert.equal(req.runtime, 'claude_code');
  assert.equal(typeof req.complexity, 'number');
  assert.ok(!Object.hasOwn(req, 'extra'));
});

test('CLI prints shadow JSON and never a rewritten authority', () => {
  const mrFile = path.join(os.tmpdir(), `dw-shadow-cli-${process.pid}.json`);
  const reqFile = path.join(os.tmpdir(), `dw-shadow-req-${process.pid}.json`);
  const mrOut = { model_routing: { implement: 'opus' }, meta: { runtime: 'claude' }, warnings: [] };
  fs.writeFileSync(mrFile, JSON.stringify(mrOut));
  fs.writeFileSync(reqFile, JSON.stringify(sampleRequest()));
  const out = execFileSync(process.execPath, [
    SHADOW_CLI, '--mr-out-file', mrFile, '--request-json', reqFile,
  ], {
    encoding: 'utf8',
    env: { ...process.env, DEEP_MODEL_ROUTER_CLI: REAL_CLI },
  });
  const wrap = JSON.parse(out);
  assert.deepEqual(wrap.authority.model_routing, mrOut.model_routing);
  assert.ok(wrap.shadow);
  fs.unlinkSync(mrFile);
  fs.unlinkSync(reqFile);
});

test('orchestrator and research invoke router-shadow immediately after model-routing-cli', () => {
  const orch = fs.readFileSync(path.join(ROOT, 'skills/deep-work-orchestrator/SKILL.md'), 'utf8');
  const research = fs.readFileSync(path.join(ROOT, 'skills/deep-research/SKILL.md'), 'utf8');
  for (const [name, skill] of [['orchestrator', orch], ['research', research]]) {
    const cli = skill.indexOf('scripts/model-routing-cli.js');
    const shadow = skill.indexOf('scripts/router-shadow.js');
    assert.ok(cli >= 0, `${name} must call model-routing-cli.js`);
    assert.ok(shadow > cli, `${name} must call router-shadow.js after model-routing-cli.js`);
    const between = skill.slice(cli, shadow);
    assert.ok(!/current_phase|model_routing_json/.test(between),
      `${name} must invoke shadow immediately after the CLI, before state write`);
  }
});
