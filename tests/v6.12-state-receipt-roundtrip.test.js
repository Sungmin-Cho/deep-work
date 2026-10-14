'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseFrontmatter, updateFrontmatterText } = require('../runtime/frontmatter.js');
const { parseStoredObject } = require('../runtime/session-store.js');
const { wrapEnvelope, unwrapEnvelope } = require('../hooks/scripts/envelope.js');
const { validateRoot } = require('../scripts/validate-envelope-emit.js');
const { verifyReceipts, VERIFICATION_ITEMS } = require('../hooks/scripts/verify-receipt-core.js');

const METHODOLOGY_POLICY = {
  schema_version: 1,
  mode: 'adaptive',
  risk_class: 'high',
  profile: 'strict',
  based_on: 'authoritative',
  floors_applied: { implement: { from: 'standard', to: 'deep' } },
  floors_effective: { research: 'deep', implement: 'deep', test: 'standard' },
  floor_overridden_by_pin: { implement: false },
  efforts: {
    research: { role: 'author', effort: 'high' },
    implement: { role: 'implementer', effort: 'high' },
    test: { role: 'implementer', effort: 'high' },
  },
  decided_at: '2026-07-21T00:00:00.000Z',
};

const REVIEW_EXECUTION = {
  schema_version: 1,
  channels: { subagent: true, codex_cli: true, gemini_cli: false, deep_review: true },
  points: {
    final: {
      mode: 'dual',
      reviewers: [{ role: 'executability', channel: 'codex-cli', model: 'gpt-6.1-sol',
        effort: 'high', effort_applied: true, required: true, status: 'completed',
        fallback_used: false, report_ref: 'reviews/final-round1-findings.json' }],
      rounds: 1,
      degraded_events: [],
      execution_decision: 'needs-human',
      human_ack: { required: true, at: '2026-07-21T00:10:00.000Z', actor: 'human' },
      verdict: 'PASS',
    },
  },
  external_change_lock: false,
  risk_acceptances: [{ from: 'critical', to: 'high', reason: 'bounded scope',
    at: '2026-07-21T00:05:00.000Z', scope: 'session' }],
};

test('methodology policy and review execution scalar state round-trip through both readers', () => {
  const base = '---\nsession_id: s-v612\ncurrent_phase: test\n---\nbody\n';
  const patched = updateFrontmatterText(base, {
    methodology_policy_json: JSON.stringify(METHODOLOGY_POLICY),
    review_execution_json: JSON.stringify(REVIEW_EXECUTION),
  });
  const fields = parseFrontmatter(patched).fields;
  assert.deepEqual(parseStoredObject(fields.methodology_policy_json), METHODOLOGY_POLICY);
  assert.deepEqual(parseStoredObject(fields.review_execution_json), REVIEW_EXECUTION);
  assert.deepEqual(JSON.parse(fields.methodology_policy_json), METHODOLOGY_POLICY);
  assert.deepEqual(JSON.parse(fields.review_execution_json), REVIEW_EXECUTION);
  assert.equal(fields.session_id, 's-v612');
});

test('corrupt optional state scalars fail open to empty objects', () => {
  assert.deepEqual(parseStoredObject('{broken-policy'), {});
  assert.deepEqual(parseStoredObject('{broken-review'), {});
});

test('session receipt envelope readers and validator preserve optional policy/review blocks', () => {
  const payload = {
    schema_version: '1.0',
    session_id: 's-v612',
    methodology_policy: {
      schema_version: 1, mode: 'adaptive', risk_class: 'high', profile: 'strict',
      floors_applied: METHODOLOGY_POLICY.floors_applied,
    },
    review_execution: {
      schema_version: 1,
      points_summary: { final: { mode: 'dual', completed: 2, failed: 0, rounds: 1, verdict: 'PASS' } },
      reviewer_failures: [], degraded_events: [], risk_acceptances: REVIEW_EXECUTION.risk_acceptances,
    },
  };
  const wrapped = wrapEnvelope({ artifactKind: 'session-receipt', payload,
    runId: '01J00000000000000000000000', producerVersion: '6.11.0',
    generatedAt: '2026-07-21T00:00:00.000Z',
    git: { head: 'abcdef0', branch: 'test', dirty: false } });
  const errors = [];
  validateRoot(wrapped, errors);
  assert.deepEqual(errors, []);
  assert.deepEqual(unwrapEnvelope(wrapped, 'session-receipt').methodology_policy, payload.methodology_policy);
  assert.deepEqual(unwrapEnvelope(wrapped, 'session-receipt').review_execution, payload.review_execution);
});

test('slice receipt optional review remains compatible with the additive evidence check', () => {
  assert.equal(VERIFICATION_ITEMS.length, 9);
  const plan = { slices: [{ id: 'SLICE-001', files: ['runtime/example.js'] }] };
  const receipt = {
    schema_version: '1.0', slice_id: 'SLICE-001', status: 'complete',
    tdd: { state_transitions: ['PENDING', 'RED_VERIFIED', 'GREEN', 'SENSOR_CLEAN'],
      red_verification_output: 'AssertionError: expected true, received false' },
    git_before_slice: 'abc', git_after_slice: 'abc', changes: { git_diff: '' },
    sensor_results: { lint: 'pass', typecheck: 'pass', reviewCheck: 'pass' },
    spec_compliance: { passed: true, verification_cmd: 'node --test',
      expected_output: 'pass', verification_output: 'pass' },
  };
  const baseline = verifyReceipts({ receipts: [receipt], plan, skip_git_checks: true });
  const review = {
    findings_ref: 'reviews/slice-SLICE-001-round1-findings.json',
    reviewers: [{ role: 'executability', channel: 'codex-cli', status: 'failed',
      fallback_used: true, effort: 'high', effort_applied: false }],
    verdict: 'PASS',
  };
  const extended = verifyReceipts({ receipts: [{ ...receipt, review }], plan, skip_git_checks: true });
  assert.deepEqual(extended, baseline);
  assert.deepEqual(extended, { pass: true, errors: [], warnings: [] });
});

test('Finish authored input cannot replace runtime policy, metrics or evidence', () => {
  const {validateAuthoredPayload}=require('../runtime/session-receipt-runtime.js');
  assert.deepEqual(validateAuthoredPayload(Buffer.from('{"task_description":"task","x-note":"optional"}')),
    {task_description:'task','x-note':'optional'});
  for(const key of ['methodology_policy','review_execution','quality_score','goal_acceptance'])
    assert.throws(()=>validateAuthoredPayload(Buffer.from(JSON.stringify({[key]:{}}))),/finish-payload-runtime-field/);
});
