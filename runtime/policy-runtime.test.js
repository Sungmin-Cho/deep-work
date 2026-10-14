'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compilePolicySnapshot, PROFILE_BY_CLASS, TIER_CATALOG, EFFORT_CATALOG,
  REVIEW_POLICY, VERIFICATION_POLICY, DIFF_PHASES,
  compileMethodologyAuthority } = require('./policy-runtime.js');
const { CLASS_ORDER } = require('./risk-runtime.js');

test('A.1 매핑 고정', () => {
  assert.deepStrictEqual(PROFILE_BY_CLASS,
    { low: 'lean', medium: 'standard', high: 'strict', critical: 'critical' });
});

test('A.2b tier 카탈로그 고정 — standard 행은 v6.10 baseline과 일치', () => {
  assert.deepStrictEqual(TIER_CATALOG.standard, { research: 'standard', implement: 'standard', test: 'light' });
  assert.deepStrictEqual(TIER_CATALOG.strict, { research: 'deep', implement: 'deep', test: 'standard' });
  assert.deepStrictEqual(TIER_CATALOG.lean, { research: 'light', implement: 'light', test: 'light' });
  assert.deepStrictEqual(TIER_CATALOG.critical, { research: 'deep', implement: 'deep', test: 'deep' });
});

test('routing_diff — tier 일치 시 diff 없음(standard risk × baseline)', () => {
  const snap = compilePolicySnapshot({
    riskProfile: { class: 'medium' }, difficulty: null, runtime: 'claude',
    actualRouting: { research: 'sonnet', implement: 'sonnet', test: 'haiku' },
    actualTiers: { brainstorm: 'main', research: 'standard', plan: 'main', implement: 'standard', test: 'light' },
    actualPinned: {},
  });
  assert.strictEqual(snap.profile, 'standard');
  const mismatches = snap.routing_diff.filter((d) => !d.excluded_reason && d.actual_tier !== d.recommended_tier);
  assert.deepStrictEqual(mismatches, []);
  for (const d of snap.routing_diff.filter((x) => !x.excluded_reason)) {
    assert.strictEqual(d.actual_effort_axis, 'absent');
    assert.ok(DIFF_PHASES.includes(d.phase)); // brainstorm/plan 미포함
  }
});

test('routing_diff — high risk × baseline은 implement tier 불일치 검출', () => {
  const snap = compilePolicySnapshot({
    riskProfile: { class: 'high' }, difficulty: null, runtime: 'claude',
    actualRouting: { research: 'sonnet', implement: 'sonnet', test: 'haiku' },
    actualTiers: { research: 'standard', implement: 'standard', test: 'light' },
    actualPinned: {},
  });
  const imp = snap.routing_diff.find((d) => d.phase === 'implement');
  assert.strictEqual(imp.actual_tier, 'standard');
  assert.strictEqual(imp.recommended_tier, 'deep');
});

test('routing_diff — concrete pin phase는 excluded_reason: concrete-pin (스펙 §4.5)', () => {
  const snap = compilePolicySnapshot({
    riskProfile: { class: 'medium' }, difficulty: null, runtime: 'codex',
    actualRouting: { research: 'gpt-6.1-sol', implement: 'gpt-6.1-sol', test: 'gpt-6-luna' },
    actualTiers: { research: 'standard', implement: 'standard', test: 'light' }, // implement pin에도 baseline 잔존
    actualPinned: { implement: 'gpt-6.1-sol' }, // tier 어휘 아님 = concrete pin
  });
  const imp = snap.routing_diff.find((d) => d.phase === 'implement');
  assert.deepStrictEqual(imp, { phase: 'implement', excluded_reason: 'concrete-pin' });
});

test('routing_diff — tier pin은 정상 비교 대상', () => {
  const snap = compilePolicySnapshot({
    riskProfile: { class: 'medium' }, difficulty: null, runtime: 'claude',
    actualRouting: { research: 'sonnet', implement: 'opus', test: 'haiku' },
    actualTiers: { research: 'standard', implement: 'deep', test: 'light' },
    actualPinned: { implement: 'deep' }, // tier 어휘 = tier pin
  });
  const imp = snap.routing_diff.find((d) => d.phase === 'implement');
  assert.strictEqual(imp.excluded_reason, undefined);
  assert.strictEqual(imp.actual_tier, 'deep');
});

test('routing_diff — 비-tier 값(main 등)은 excluded_reason 기록', () => {
  const snap = compilePolicySnapshot({
    riskProfile: { class: 'low' }, difficulty: null, runtime: 'claude',
    actualRouting: { research: 'main', implement: 'sonnet', test: 'haiku' },
    actualTiers: { research: 'main', implement: 'standard', test: 'light' },
    actualPinned: {},
  });
  const res = snap.routing_diff.find((d) => d.phase === 'research');
  assert.ok(res.excluded_reason && res.excluded_reason !== 'concrete-pin');
});

test('property: profile이 risk class에 대해 약해지지 않는다 (§8.2-4)', () => {
  const strength = { lean: 0, standard: 1, strict: 2, critical: 3 };
  let prev = -1;
  for (const cls of CLASS_ORDER) {
    const cur = strength[PROFILE_BY_CLASS[cls]];
    assert.ok(cur >= prev);
    prev = cur;
  }
});

test('알 수 없는 class → standard fallback (fail-open)', () => {
  const snap = compilePolicySnapshot({ riskProfile: { class: 'wat' }, difficulty: null,
    runtime: 'unknown', actualRouting: {}, actualTiers: {}, actualPinned: {} });
  assert.strictEqual(snap.profile, 'standard');
});

// Task 2 리뷰 W1: A.2/A.3 정본 표 회귀 가드 + recommended_effort 값 고정
test('A.2 effort catalog 고정 (정본 표 1:1)', () => {
  assert.deepStrictEqual(EFFORT_CATALOG, {
    lean: { author: 'medium', implementer: 'medium', reviewer: 'high' },
    standard: { author: 'high', implementer: 'medium', reviewer: 'high' },
    strict: { author: 'high', implementer: 'high', semantic_reviewer: 'xhigh', executability_reviewer: 'high' },
    critical: { author: 'xhigh', implementer: 'high', semantic_reviewer: 'xhigh', executability_reviewer: 'xhigh', escalation: 'max' },
  });
});

test('A.3 review/verification policy 고정 (정본 표 1:1)', () => {
  assert.deepStrictEqual(REVIEW_POLICY, {
    lean: '단일 리뷰', standard: '단일 강한 리뷰 + 필요 시 dual',
    strict: '독립 dual 리뷰', critical: 'dual + adjudication + human gate',
  });
  assert.deepStrictEqual(VERIFICATION_POLICY, {
    lean: '최소 검증 (기록 전용)', standard: '표준 검증',
    strict: '강화 검증', critical: '전수 검증 + human gate',
  });
});

test('routing_diff recommended_effort 값 고정 (§5.1 예시 대조)', () => {
  const tiers = { research: 'standard', implement: 'standard', test: 'light' };
  const std = compilePolicySnapshot({ riskProfile: { class: 'medium' }, difficulty: null,
    runtime: 'claude', actualRouting: {}, actualTiers: tiers, actualPinned: {} });
  assert.strictEqual(std.routing_diff.find((d) => d.phase === 'implement').recommended_effort, 'medium');
  assert.strictEqual(std.routing_diff.find((d) => d.phase === 'research').recommended_effort, 'high');
  const strict = compilePolicySnapshot({ riskProfile: { class: 'high' }, difficulty: null,
    runtime: 'claude', actualRouting: {}, actualTiers: tiers, actualPinned: {} });
  assert.strictEqual(strict.routing_diff.find((d) => d.phase === 'implement').recommended_effort, 'high');
});

test('v7 methodology authority is provider-neutral and binds policy floors',()=>{
  const authority=compileMethodologyAuthority({riskProfile:{class:'high'},
    difficulty:'medium',mode:'adaptive',floorBaseline:{implement:'standard'}});
  assert.equal(authority.schema_version,1);
  assert.equal(authority.authority,'methodology-policy-v1');
  assert.equal(authority.risk_class,'high');
  assert.equal(authority.profile,'strict');
  assert.deepStrictEqual(authority.role_routing.tiers,{
    brainstorm:'main',research:'deep',spec:'main',plan:'main',
    implement:'deep',test:'standard',
  });
  assert.equal(authority.role_routing.efforts.semantic_reviewer,'xhigh');
  assert.deepStrictEqual(authority.floors_effective,{
    research:'deep',implement:'deep',test:'standard',
  });
  assert.doesNotMatch(JSON.stringify(authority),/opus|sonnet|haiku|gpt-/i);
});
