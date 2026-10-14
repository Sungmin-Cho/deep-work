'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  REVIEW_MATRIX,
  DEGRADED_MATRIX,
  compileReviewPlan,
  evaluateReviewExecution,
  finishGateAllowed,
  detectReviewChannels,
  CODEX_REASONING_EFFORT_MAP,
  mapCodexReasoningEffort,
  staticEffortMetadata,
} = require('./review-policy-runtime.js');

const ALL_CHANNELS = Object.freeze({ subagent: true, codex_cli: true, gemini_cli: true, deep_review: true });

function compile(riskClass, artifactKind, overrides = {}) {
  return compileReviewPlan({ artifactKind, phase: 'implement', riskClass, runtime: 'claude',
    availableChannels: ALL_CHANNELS, tddMode: 'strict', ...overrides });
}

test('B.1 matrix pins all risk × artifact cells', () => {
  const expected = {
    low: {
      document: ['single', [['structural', 'subagent', 'standard', 'high', true]]],
      'slice-diff': ['single', [['semantic', 'subagent', 'standard', 'high', true]]],
      'cross-slice': ['single', [['semantic', 'subagent', 'standard', 'high', true]]],
      'session-final': ['single', [['semantic', 'subagent', 'standard', 'high', true]]],
    },
    medium: {
      document: ['single', [['structural', 'subagent', 'standard', 'high', true], ['semantic', 'subagent', 'standard', 'high', true]]],
      'slice-diff': ['single', [['semantic', 'subagent', 'standard', 'high', true], ['executability', 'codex-cli', 'standard', 'high', false]]],
      'cross-slice': ['single', [['semantic', 'subagent', 'deep', 'high', true]]],
      'session-final': ['single', [['semantic', 'subagent', 'deep', 'high', true]]],
    },
    high: {
      document: ['dual', [['structural', 'subagent', 'standard', 'xhigh', true], ['semantic', 'subagent', 'deep', 'xhigh', true], ['executability', 'codex-cli', 'deep', 'high', true]]],
      'slice-diff': ['dual', [['semantic', 'subagent', 'deep', 'xhigh', true], ['executability', 'codex-cli', 'deep', 'high', true]]],
      'cross-slice': ['dual', [['semantic', 'subagent', 'deep', 'xhigh', true], ['executability', 'codex-cli', 'deep', 'high', true]]],
      'session-final': ['dual', [['semantic', 'subagent', 'deep', 'xhigh', true], ['executability', 'codex-cli', 'deep', 'high', true]]],
    },
    critical: {
      document: ['dual', [['structural', 'subagent', 'standard', 'xhigh', true], ['semantic', 'subagent', 'deep', 'xhigh', true], ['executability', 'codex-cli', 'deep', 'xhigh', true]]],
      'slice-diff': ['dual', [['semantic', 'subagent', 'deep', 'xhigh', true], ['executability', 'codex-cli', 'deep', 'xhigh', true]]],
      'cross-slice': ['dual', [['semantic', 'subagent', 'deep', 'xhigh', true], ['executability', 'codex-cli', 'deep', 'xhigh', true]]],
      'session-final': ['dual', [['semantic', 'subagent', 'deep', 'xhigh', true], ['executability', 'codex-cli', 'deep', 'xhigh', true]]],
    },
  };
  assert.deepEqual(Object.keys(REVIEW_MATRIX), ['low', 'medium', 'high', 'critical']);
  for (const [risk, artifacts] of Object.entries(expected)) {
    for (const [artifactKind, [mode, reviewers]] of Object.entries(artifacts)) {
      const plan = compile(risk, artifactKind);
      assert.equal(plan.mode, mode, `${risk}:${artifactKind}:mode`);
      assert.deepEqual(plan.reviewers.map(({ role, channel, tier, effort, required }) =>
        [role, channel, tier, effort, required]), reviewers, `${risk}:${artifactKind}:reviewers`);
      assert.equal(plan.profile, { low: 'lean', medium: 'standard', high: 'strict', critical: 'critical' }[risk]);
      assert.equal(plan.source, 'risk');
    }
  }
});

test('sliceRiskClass uses max(session, slice) only for slice-diff', () => {
  assert.equal(compile('medium', 'slice-diff', { sliceRiskClass: 'high' }).risk_class, 'high');
  assert.equal(compile('high', 'slice-diff', { sliceRiskClass: 'low' }).risk_class, 'high');
  assert.equal(compile('medium', 'document', { sliceRiskClass: 'critical' }).risk_class, 'medium');
});

test('missing risk and shadow policy return default standard strength', () => {
  const missing = compileReviewPlan({ artifactKind: 'document', runtime: 'claude', availableChannels: ALL_CHANNELS });
  assert.equal(missing.source, 'default');
  assert.equal(missing.risk_class, 'medium');
  assert.equal(missing.profile, 'standard');
  const shadow = compile('critical', 'document', { policyMode: 'shadow' });
  assert.equal(shadow.source, 'default');
  assert.equal(shadow.risk_class, 'medium');
  assert.equal(shadow.mode, 'single');
});

test('reviewModeOverride changes composition without overriding the codex provider catalog', () => {
  const lowered = compile('high', 'slice-diff', { reviewModeOverride: 'single', evaluatorModelOverride: 'opus' });
  assert.equal(lowered.mode, 'single');
  assert.deepEqual(lowered.reviewers.map((reviewer) => reviewer.role), ['semantic','executability']);
  assert.equal(lowered.reviewers[0].model,'opus');assert.equal(lowered.reviewers[1].model,'gpt-6.1-sol');
  const raised = compile('low', 'slice-diff', { reviewModeOverride: 'dual', evaluatorModelOverride: 'opus' });
  assert.equal(raised.mode, 'dual');
  assert.deepEqual(raised.reviewers.map((reviewer) => reviewer.role), ['semantic', 'executability']);
  assert.equal(raised.reviewers.find((reviewer) => reviewer.channel === 'subagent').model, 'opus');
  assert.equal(raised.reviewers.find((reviewer) => reviewer.channel === 'codex-cli').model, 'gpt-6.1-sol');
});

test('compiled reviewer models follow their execution channel without cross-runtime leakage', () => {
  const plan = compile('high', 'slice-diff');
  const semantic = plan.reviewers.find((reviewer) => reviewer.channel === 'subagent');
  const executability = plan.reviewers.find((reviewer) => reviewer.channel === 'codex-cli');

  assert.equal(semantic.model, 'opus');
  assert.equal(executability.model, 'gpt-6.1-sol');
  assert.notEqual(executability.model, 'opus');
});

test('document plans never assign deep-review under any risk/channel combination', () => {
  for (const risk of ['low', 'medium', 'high', 'critical']) {
    for (const deepReview of [false, true]) {
      const plan = compile(risk, 'document', { availableChannels: { ...ALL_CHANNELS, deep_review: deepReview } });
      assert.ok(plan.reviewers.every((reviewer) => reviewer.channel !== 'deep-review'));
    }
  }
});

test('availableChannels matrix deterministically assigns executability fallback channels', () => {
  const combinations = [
    { subagent: true, codex_cli: true, gemini_cli: true, deep_review: true },
    { subagent: true, codex_cli: false, gemini_cli: true, deep_review: true },
    { subagent: true, codex_cli: false, gemini_cli: false, deep_review: false },
    { subagent: false, codex_cli: false, gemini_cli: false, deep_review: true },
  ];
  for (const availableChannels of combinations) {
    for (const risk of ['high', 'critical']) {
      for (const artifactKind of ['document', 'slice-diff', 'cross-slice', 'session-final']) {
        const plan = compile(risk, artifactKind, { availableChannels });
        const executability = plan.reviewers.find((reviewer) => reviewer.role === 'executability');
        const expected = availableChannels.codex_cli ? 'codex-cli'
          : availableChannels.gemini_cli ? 'gemini-cli' : 'subagent';
        assert.equal(executability.channel, expected, `${risk}:${artifactKind}:${JSON.stringify(availableChannels)}`);
      }
    }
  }
});

test('all plans enforce rounds_max=2, blind first round, and blocker evidence gate', () => {
  for (const risk of ['low', 'medium', 'high', 'critical']) {
    for (const artifactKind of ['document', 'slice-diff', 'cross-slice', 'session-final']) {
      const plan = compile(risk, artifactKind);
      assert.equal(plan.rounds_max, 2);
      assert.equal(plan.blind_first_round, true);
      assert.deepEqual(plan.gate.needs_evidence, ['blocker']);
      assert.equal(plan.gate.blocker_blocks, true);
    }
  }
});

test('B.2 matrix and evaluateReviewExecution cover partial and total required failure', () => {
  assert.deepEqual(Object.keys(DEGRADED_MATRIX), ['low', 'medium', 'high', 'critical']);
  const expected = { low: 'degraded-proceed', medium: 'needs-human', high: 'pause', critical: 'pause' };
  for (const risk of ['low', 'medium', 'high', 'critical']) {
    const plan = compile(risk, 'cross-slice');
    const roles = plan.reviewers.filter((reviewer) => reviewer.required).map((reviewer) => reviewer.role);
    const partial = roles.map((role, index) => ({ role, required: true,
      status: index === 0 ? 'completed' : 'timeout', channel: 'subagent', report_ref: null }));
    if (partial.length === 1) partial.push({ role: 'extra', required: true, status: 'failed', channel: 'subagent' });
    const total = partial.map((result) => ({ ...result, status: 'failed' }));
    assert.equal(evaluateReviewExecution(plan, partial).decision, expected[risk], `${risk}:partial`);
    assert.equal(evaluateReviewExecution(plan, total).decision, expected[risk], `${risk}:total`);
  }
});

test('critical human gate remains needs-human until a human ack is present', () => {
  const plan = compile('critical', 'session-final');
  const completed = plan.reviewers.filter((reviewer) => reviewer.required)
    .map((reviewer) => ({ ...reviewer, status: 'completed', report_ref: 'report.json' }));
  const waiting = evaluateReviewExecution(plan, completed);
  assert.equal(waiting.decision, 'needs-human');
  assert.deepEqual(waiting.human_gate, { required: true, satisfied: false });
  const acknowledged = evaluateReviewExecution({ ...plan,
    human_ack: { required: true, at: '2026-07-21T00:00:00.000Z', actor: 'human' } }, completed);
  assert.equal(acknowledged.decision, 'proceed');
  assert.deepEqual(acknowledged.human_gate, { required: true, satisfied: true });
});

test('compile exception is fail-closed for known high/critical and default-strength otherwise', () => {
  const brokenChannels = new Proxy({}, { get() { throw new Error('probe-state-corrupt'); } });
  for (const riskClass of ['high', 'critical']) {
    const result = compileReviewPlan({ artifactKind: 'document', riskClass, runtime: 'claude',
      availableChannels: brokenChannels });
    assert.equal(result.execution_decision, 'pause');
    assert.equal(result.compilation_error, true);
    assert.ok(result.degraded_events[0].message.includes('probe-state-corrupt'));
  }
  const low = compileReviewPlan({ artifactKind: 'document', riskClass: 'low', runtime: 'claude',
    availableChannels: brokenChannels });
  assert.equal(low.source, 'default');
  assert.equal(low.risk_class, 'medium');
  assert.equal(low.compilation_error, true);
  assert.ok(low.reviewers.length > 0);
});

test('finishGateAllowed blocks external lock and reports every missing critical ack', () => {
  const execution = {
    external_change_lock: true,
    points: {
      final: { human_ack: { required: true, at: null, actor: null } },
      plan: { human_ack: { required: true, at: '2026-07-21T00:00:00.000Z', actor: 'human' } },
    },
  };
  assert.deepEqual(finishGateAllowed(execution), {
    allowed: false,
    blocking: { external_change_lock: true, missing_acks: ['final'] },
  });
  execution.external_change_lock = false;
  execution.points.final.human_ack = { required: true, at: '2026-07-21T00:00:00.000Z', actor: 'human' };
  assert.deepEqual(finishGateAllowed(execution), {
    allowed: true,
    blocking: { external_change_lock: false, missing_acks: [] },
  });
});

test('finishGateAllowed treats a null human_ack on every critical review point as missing', () => {
  const execution = { external_change_lock: false, points: {
    final: { human_ack_required: true, human_ack: null },
    plan: { risk_class: 'critical', human_ack: { required: true,
      at: '2026-07-21T00:00:00.000Z', actor: 'human' } },
  } };
  assert.deepEqual(finishGateAllowed(execution), {
    allowed: false,
    blocking: { external_change_lock: false, missing_acks: ['final'] },
  });
});

test('finish gate blocks missing evidence and unaccepted residual risk',()=>{
  const result=finishGateAllowed({external_change_lock:false,points:{}},{compatibility_mode:'strict-spec',
    evidence_summary:{complete:false,redaction:{passed:true}},residual_risk:{class:'high',accepted:false},
    invalidated_evidence_ids:['EVID-BAD']});
  assert.equal(result.allowed,false);assert.equal(result.blocking.evidence_complete,true);
  assert.equal(result.blocking.residual_risk,true);assert.deepEqual(result.blocking.invalidated_evidence_ids,['EVID-BAD']);
});

test('detectReviewChannels is deterministic with injected executable probe and install tree', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'review-channels-'));
  const manifest = path.join(home, '.claude', 'plugins', 'cache', 'suite', 'deep-review', '.claude-plugin', 'plugin.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, '{}');
  const calls = [];
  const result = detectReviewChannels({ runtime: 'claude', nativeCapability:{available:true,observed:true}, env: { HOME: home },
    probe: (binary) => { calls.push(binary); return binary === 'codex'; } });
  assert.deepEqual(result, { subagent: true, codex_cli: true, claude_cli:false, gemini_cli: false, deep_review: true });
  assert.deepEqual(calls, ['codex','claude', 'gemini']);
  assert.deepEqual(detectReviewChannels({ runtime: 'codex', env: {}, probe: () => false }),
    { subagent: false, codex_cli: false, claude_cli:false, gemini_cli: false, deep_review: false });
});

test('B.3 Codex effort mapping is exact and max is model-gated', () => {
  assert.deepEqual(CODEX_REASONING_EFFORT_MAP, {
    medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max',
  });
  assert.deepEqual(mapCodexReasoningEffort('medium', 'gpt-6.1-sol'), {
    requested: 'medium', mapped: 'medium', effort_clamped: false,
  });
  assert.deepEqual(mapCodexReasoningEffort('high', 'gpt-6.1-sol'), {
    requested: 'high', mapped: 'high', effort_clamped: false,
  });
  assert.deepEqual(mapCodexReasoningEffort('xhigh', 'gpt-5.5-codex'), {
    requested: 'xhigh', mapped: 'xhigh', effort_clamped: false,
  });
  assert.deepEqual(mapCodexReasoningEffort('max', 'gpt-6.1-sol'), {
    requested: 'max', mapped: 'max', effort_clamped: false,
  });
  assert.deepEqual(mapCodexReasoningEffort('max', 'gpt-5.5-codex'), {
    requested: 'max', mapped: 'xhigh', effort_clamped: true,
  });
  assert.equal(mapCodexReasoningEffort('low', 'gpt-6.1-sol'), null);
});

test('subagent and gemini channels permanently record effort_applied false', () => {
  assert.deepEqual(staticEffortMetadata('subagent', 'high'), {
    effort: 'high', effort_applied: false, effort_channel: 'unsupported-host',
  });
  assert.deepEqual(staticEffortMetadata('gemini-cli', 'xhigh'), {
    effort: 'xhigh', effort_applied: false, effort_channel: 'unsupported-channel',
  });
});
