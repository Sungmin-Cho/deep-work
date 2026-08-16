'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { translateRouteOutcome } = require('./router-adapter.js');

const REQUIRED = [
  'dispatch_authorized', 'status', 'degrade_reason', 'risk_band',
  'local_floor_applied', 'routing_provenance',
];

function assertShape(out) {
  for (const key of REQUIRED) assert.ok(key in out, `missing ${key}`);
  assert.equal(typeof out.dispatch_authorized, 'boolean');
  assert.match(out.status, /^(ok|terminal|invalid|human_gate|deferred_confirm|internal|unavailable)$/);
  assert.match(out.routing_provenance, /^(router|local-fallback)$/);
}

function decision(overrides = {}) {
  return JSON.stringify({
    route_schema_version: 1,
    router_plugin_version: '1.0.0',
    policy_sha256: 'a'.repeat(64),
    risk_band: 'MEDIUM',
    selected_model: 'gpt-5.6-luna',
    selected_effort: 'MEDIUM',
    review: { band: 'MEDIUM', reviewers: ['worker_balanced'] },
    ...overrides,
  });
}

test('exit 0 is dispatchable ok', () => {
  const out = translateRouteOutcome({
    exit: 0, stdout: decision(), stderr: '', processState: 'exited',
  });
  assertShape(out);
  assert.equal(out.dispatch_authorized, true);
  assert.equal(out.status, 'ok');
  assert.equal(out.degrade_reason, null);
  assert.equal(out.risk_band, 'MEDIUM');
  assert.equal(out.routing_provenance, 'router');
});

test('exit 1 HIGH/CRITICAL is blocked — no local-fallback', () => {
  const high = translateRouteOutcome({
    exit: 1, stdout: decision({ risk_band: 'HIGH', terminal: 'HUMAN_REQUIRED' }),
    stderr: '', processState: 'exited',
  });
  assertShape(high);
  assert.equal(high.dispatch_authorized, false);
  assert.equal(high.status, 'terminal');
  assert.equal(high.risk_band, 'HIGH');
  assert.notEqual(high.routing_provenance, 'local-fallback');

  const critical = translateRouteOutcome({
    exit: 1, stdout: decision({ risk_band: 'CRITICAL', terminal: 'HUMAN_REQUIRED' }),
    stderr: '', processState: 'exited', localRiskBand: 'CRITICAL',
  });
  assert.equal(critical.dispatch_authorized, false);
  assert.equal(critical.status, 'terminal');
  assert.notEqual(critical.routing_provenance, 'local-fallback');
});

test('exit 1 LOW/MEDIUM may local-fallback', () => {
  const out = translateRouteOutcome({
    exit: 1, stdout: decision({ risk_band: 'LOW', terminal: 'SUPPLY_EXHAUSTED' }),
    stderr: '', processState: 'exited',
  });
  assertShape(out);
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.status, 'terminal');
  assert.equal(out.routing_provenance, 'local-fallback');
  assert.ok(out.degrade_reason);
});

test('exit 2 is invalid and follows the same band rule as exit 1', () => {
  const medium = translateRouteOutcome({
    exit: 2, stdout: decision({ risk_band: 'MEDIUM' }), stderr: 'error: bad', processState: 'exited',
  });
  assert.equal(medium.status, 'invalid');
  assert.equal(medium.dispatch_authorized, false);
  assert.equal(medium.routing_provenance, 'local-fallback');

  const high = translateRouteOutcome({
    exit: 2, stdout: decision({ risk_band: 'HIGH' }), stderr: 'error: bad', processState: 'exited',
  });
  assert.equal(high.status, 'invalid');
  assert.equal(high.dispatch_authorized, false);
  assert.notEqual(high.routing_provenance, 'local-fallback');
});

test('exit 3 is human_gate and must not degrade', () => {
  const out = translateRouteOutcome({
    exit: 3, stdout: decision({ requires_human_confirmation: true, risk_band: 'LOW' }),
    stderr: '', processState: 'exited',
  });
  assertShape(out);
  assert.equal(out.status, 'human_gate');
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.routing_provenance, 'router');
  assert.equal(out.degrade_reason, null);
});

test('exit 4 is deferred_confirm, dispatchable, no degrade', () => {
  const out = translateRouteOutcome({
    exit: 4, stdout: decision({ human_confirmation_deferred: true, risk_band: 'HIGH' }),
    stderr: '', processState: 'exited',
  });
  assertShape(out);
  assert.equal(out.status, 'deferred_confirm');
  assert.equal(out.dispatch_authorized, true);
  assert.equal(out.routing_provenance, 'router');
  assert.equal(out.degrade_reason, null);
});

test('exit 5 is internal and follows the same band rule as exit 2', () => {
  const low = translateRouteOutcome({
    exit: 5, stdout: '', stderr: 'internal error', processState: 'exited', localRiskBand: 'LOW',
  });
  assert.equal(low.status, 'internal');
  assert.equal(low.dispatch_authorized, false);
  assert.equal(low.routing_provenance, 'local-fallback');

  const high = translateRouteOutcome({
    exit: 5, stdout: '', stderr: 'internal error', processState: 'exited', localRiskBand: 'HIGH',
  });
  assert.equal(high.status, 'internal');
  assert.equal(high.dispatch_authorized, false);
  assert.notEqual(high.routing_provenance, 'local-fallback');
});

test('spawn failure is unavailable', () => {
  const out = translateRouteOutcome({
    exit: null, stdout: '', stderr: 'spawn ENOENT', processState: 'spawn_failed',
    localRiskBand: 'MEDIUM',
  });
  assertShape(out);
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.status, 'unavailable');
  assert.equal(out.routing_provenance, 'local-fallback');
});

test('permission denied is unavailable', () => {
  const out = translateRouteOutcome({
    exit: null, stdout: '', stderr: 'EACCES', processState: 'permission_denied',
    localRiskBand: 'LOW',
  });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.dispatch_authorized, false);
});

test('timeout is unavailable', () => {
  const out = translateRouteOutcome({
    exit: null, stdout: '', stderr: 'ETIMEDOUT', processState: 'timeout',
    localRiskBand: 'MEDIUM',
  });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.dispatch_authorized, false);
});

test('signal is treated like invalid (same as exit 2)', () => {
  const out = translateRouteOutcome({
    exit: null, stdout: '', stderr: '', processState: 'signal', signal: 'SIGTERM',
    localRiskBand: 'MEDIUM',
  });
  assert.equal(out.dispatch_authorized, false);
  assert.match(out.status, /^(invalid|unavailable)$/);
});

test('empty stdout is unavailable', () => {
  const out = translateRouteOutcome({
    exit: 0, stdout: '', stderr: '', processState: 'empty_stdout', localRiskBand: 'LOW',
  });
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.status, 'unavailable');
});

test('truncated stdout is unavailable', () => {
  const out = translateRouteOutcome({
    exit: 0, stdout: '{"route_schema_version":1', stderr: '', processState: 'truncated',
    localRiskBand: 'LOW',
  });
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.status, 'unavailable');
});

test('non-JSON stdout is invalid', () => {
  const out = translateRouteOutcome({
    exit: 0, stdout: 'not json', stderr: '', processState: 'exited', localRiskBand: 'LOW',
  });
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.status, 'invalid');
});

test('unsupported schema is invalid', () => {
  const out = translateRouteOutcome({
    exit: 0, stdout: decision({ route_schema_version: 99 }), stderr: '', processState: 'exited',
  });
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.status, 'invalid');
  assert.match(String(out.degrade_reason), /schema/i);
});

test('digest mismatch is invalid', () => {
  const out = translateRouteOutcome({
    exit: 0, stdout: decision({ policy_sha256: 'b'.repeat(64) }), stderr: '',
    processState: 'digest_mismatch', expectedDigest: 'a'.repeat(64),
  });
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.status, 'invalid');
  assert.match(String(out.degrade_reason), /digest/i);
});

test('out-of-range exit is unavailable', () => {
  const out = translateRouteOutcome({
    exit: 9, stdout: decision(), stderr: '', processState: 'out_of_range',
    localRiskBand: 'MEDIUM',
  });
  assert.equal(out.dispatch_authorized, false);
  assert.equal(out.status, 'unavailable');
});

test('missing executable is unavailable', () => {
  const out = translateRouteOutcome({
    exit: null, stdout: '', stderr: '', processState: 'missing_cli', localRiskBand: 'LOW',
  });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.dispatch_authorized, false);
});

test('python3 unavailable is unavailable', () => {
  const out = translateRouteOutcome({
    exit: null, stdout: '', stderr: '', processState: 'python3_unavailable',
    localRiskBand: 'LOW',
  });
  assert.equal(out.status, 'unavailable');
  assert.equal(out.dispatch_authorized, false);
});

test('TERMINATION_UNCONFIRMED blocks write-capable retry', () => {
  const out = translateRouteOutcome({
    exit: 5, stdout: JSON.stringify({ result: { state: 'TERMINATION_UNCONFIRMED' } }),
    stderr: '', processState: 'termination_unconfirmed', localRiskBand: 'HIGH',
  });
  assertShape(out);
  assert.equal(out.dispatch_authorized, false);
  assert.match(out.status, /^(internal|unavailable)$/);
  assert.equal(out.write_retry_allowed, false);
  assert.notEqual(out.routing_provenance, 'local-fallback');
});

test('HIGH local band with empty stdout still does not degrade', () => {
  const out = translateRouteOutcome({
    exit: 2, stdout: '', stderr: 'boom', processState: 'exited', localRiskBand: 'HIGH',
  });
  assert.equal(out.dispatch_authorized, false);
  assert.notEqual(out.routing_provenance, 'local-fallback');
});
