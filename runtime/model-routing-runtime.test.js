'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectCodebaseSignals, classifyRepoScale, SCALE_SMALL_MAX, SCALE_MEDIUM_MAX,
  FS_WALK_CAP, LOC_SAMPLE_CAP, LOC_FILE_BYTE_CAP,
} = require('./model-routing-runtime.js');

function makeFixture(fileCount) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-sig-'));
  fs.mkdirSync(path.join(dir, 'src'));
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, 'src', `f${i}.js`), 'const a = 1;\nconst b = 2;\n');
  }
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', 'a.test.js'), 'test();\n');
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ dependencies: { x: '1' }, devDependencies: { y: '1' } }));
  return dir;
}

function makeManyEmptyFilesFixture(count) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-sig-walkcap-'));
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, `f${i}`), '');
  }
  return dir;
}

function makeLocFixture(count, linesPerFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-sig-loc-'));
  const content = Array.from({ length: linesPerFile }, (_, i) => `line${i}`).join('\n');
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.js`), content);
  }
  return dir;
}

test('fs walk 기반 신호 수집 (비-git 픽스처)', () => {
  const dir = makeFixture(10);
  const s = collectCodebaseSignals(dir, { gitLsFiles: () => null }); // git 경로 강제 차단
  assert.strictEqual(typeof s.tracked_files, 'number');
  assert.ok(s.tracked_files >= 11); // src 10 + tests 1 (+ package.json은 소스 외)
  assert.ok(s.loc_estimate > 0);
  assert.ok(s.languages >= 1);
  assert.strictEqual(s.has_tests, true);
  assert.strictEqual(s.deps_count, 2);
  assert.deepStrictEqual(s.errors, []);
});

test('git ls-files 성공 시 그 count를 사용', () => {
  const dir = makeFixture(3);
  const s = collectCodebaseSignals(dir, { gitLsFiles: () => ['a.js', 'b.js', 'c.py', 'd.md'] });
  assert.strictEqual(s.tracked_files, 4);
});

test('수집 실패 시 null + errors 기록 (throw 금지)', () => {
  const s = collectCodebaseSignals('/nonexistent-path-xyz', { gitLsFiles: () => null });
  assert.strictEqual(s.tracked_files, null);
  assert.ok(s.errors.length >= 1);
});

test('규모 분류: tracked_files 우선, null→medium (리뷰 Low-7)', () => {
  assert.strictEqual(classifyRepoScale({ tracked_files: SCALE_SMALL_MAX - 1 }), 'small');
  assert.strictEqual(classifyRepoScale({ tracked_files: SCALE_SMALL_MAX }), 'medium');
  assert.strictEqual(classifyRepoScale({ tracked_files: SCALE_MEDIUM_MAX }), 'large');
  assert.strictEqual(classifyRepoScale({ tracked_files: null }), 'medium');
  assert.strictEqual(classifyRepoScale({}), 'medium');
});

// --- 리뷰 반영: 캡 3종 fixture 고정 + injection seam throw 안전성 + partial 실패 errors 기록 ---

test('FS_WALK_CAP: 파일 5,050개 중 5,000개로 캡 (git 경로 차단)', () => {
  const dir = makeManyEmptyFilesFixture(FS_WALK_CAP + 50);
  const s = collectCodebaseSignals(dir, { gitLsFiles: () => null });
  assert.strictEqual(s.tracked_files, FS_WALK_CAP);
});

test('LOC_SAMPLE_CAP: 소스 파일 250개 중 200개만 샘플링해 외삽', () => {
  const dir = makeLocFixture(250, 2); // 파일마다 2줄
  const s = collectCodebaseSignals(dir, { gitLsFiles: () => null });
  // 샘플 200개 평균 2줄 * 전체 소스 파일 250개 = 500 (샘플이 아닌 전체 파일 수 기준 외삽)
  assert.strictEqual(s.loc_estimate, 500);
});

test('1MB 초과 파일은 LOC 샘플링에서 skip — 정상 파일 평균만 외삽에 반영', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-sig-bigfile-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'line0\nline1'); // 2줄
  fs.writeFileSync(path.join(dir, 'b.js'), 'line0\nline1'); // 2줄
  fs.writeFileSync(path.join(dir, 'c.js'), 'x'.repeat(LOC_FILE_BYTE_CAP + 1024)); // >1MB
  const s = collectCodebaseSignals(dir, { gitLsFiles: () => null });
  // 정상 파일 2개 평균(2줄) * 전체 소스 파일 수(3, 대형 파일 포함) = 6
  assert.strictEqual(s.loc_estimate, 6);
});

test('gitLsFiles injection throw 시 throw 없이 walk 폴백 + errors 기록', () => {
  const dir = makeFixture(3);
  const s = collectCodebaseSignals(dir, { gitLsFiles: () => { throw new Error('boom'); } });
  assert.strictEqual(typeof s.tracked_files, 'number');
  assert.ok(s.tracked_files >= 4); // src 3 + tests 1
  assert.ok(s.errors.includes('gitLsFiles: boom'));
});

test('walk-dir 실패(readdirSync) 시 errors에 기록 — partial 데이터는 유지', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return; // root/Windows는 chmod 0o000이 읽기를 막지 못해 실패 유도 불가 — skip (errors 로직은 크로스플랫폼 순수 JS라 POSIX CI가 커버)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-sig-walkerr-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'line0\nline1');
  const blocked = path.join(dir, 'blocked');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'x.js'), 'line0\nline1');
  fs.chmodSync(blocked, 0o000);
  try {
    const s = collectCodebaseSignals(dir, { gitLsFiles: () => null });
    assert.ok(s.errors.some((e) => e.startsWith(`walk-dir: ${blocked}:`)));
    assert.strictEqual(typeof s.tracked_files, 'number'); // partial 데이터로 계속 채움
  } finally {
    fs.chmodSync(blocked, 0o755);
  }
});

test('loc-sample 실패(읽기 권한 없음) 시 errors에 기록 — partial 데이터는 유지', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return; // root/Windows는 chmod 0o000이 읽기를 막지 못해 실패 유도 불가 — skip (errors 로직은 크로스플랫폼 순수 JS라 POSIX CI가 커버)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-sig-locerr-'));
  fs.mkdirSync(path.join(dir, 'src'));
  const unreadable = path.join(dir, 'src', 'secret.js');
  fs.writeFileSync(unreadable, 'line0\nline1');
  fs.chmodSync(unreadable, 0o000);
  try {
    const s = collectCodebaseSignals(dir, { gitLsFiles: () => null });
    assert.ok(s.errors.some((e) => e.startsWith('loc-sample: secret.js:')));
    assert.strictEqual(typeof s.tracked_files, 'number'); // partial 데이터로 계속 채움
  } finally {
    fs.chmodSync(unreadable, 0o644);
  }
});

test('errors 배열은 최대 20개로 캡되고 초과 시 truncated 마커 1회 추가', () => {
  if ((process.getuid && process.getuid() === 0) || process.platform === 'win32') return; // root/Windows는 chmod 0o000이 읽기를 막지 못해 실패 유도 불가 — skip (errors 로직은 크로스플랫폼 순수 JS라 POSIX CI가 커버)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-sig-capped-'));
  const blockedDirs = [];
  for (let i = 0; i < 25; i++) {
    const blocked = path.join(dir, `blocked${i}`);
    fs.mkdirSync(blocked);
    fs.chmodSync(blocked, 0o000);
    blockedDirs.push(blocked);
  }
  try {
    const s = collectCodebaseSignals(dir, { gitLsFiles: () => null });
    assert.ok(s.errors.length <= 20);
    assert.strictEqual(s.errors[s.errors.length - 1], '…(truncated)');
  } finally {
    for (const blocked of blockedDirs) fs.chmodSync(blocked, 0o755);
  }
});

// --- Task 4: baseline tier + 난이도 보정 + per-slice 규칙 ---

const { PHASES, DIFFICULTY, tierIndex, shiftTier, baselineTiers, applyDifficulty,
  sizeToTier, sliceModelTier, sliceModelTierWithRisk } = require('./model-routing-runtime.js');

test('baseline 규칙표 (설계 §2.2 전 분기)', () => {
  const small = baselineTiers({ tracked_files: 50 }, '작업');
  assert.deepStrictEqual(small.tiers,
    { brainstorm: 'main', research: 'light', plan: 'main', implement: 'standard', test: 'light' });
  assert.strictEqual(small.scale, 'small');
  const medium = baselineTiers({ tracked_files: 500 }, '작업');
  assert.deepStrictEqual(medium.tiers,
    { brainstorm: 'main', research: 'standard', plan: 'main', implement: 'standard', test: 'light' });
  const large = baselineTiers({ tracked_files: 5000, languages: 2 }, '작업');
  assert.deepStrictEqual(large.tiers,
    { brainstorm: 'main', research: 'standard', plan: 'main', implement: 'deep', test: 'standard' });
});

test('대형+다언어(>=4) → research deep 상향', () => {
  const b = baselineTiers({ tracked_files: 5000, languages: 4 }, '작업');
  assert.strictEqual(b.tiers.research, 'deep');
});

test('소형+좁은 task 키워드 → implement light 하향', () => {
  const b = baselineTiers({ tracked_files: 50 }, 'typo fix 한 줄 수정');
  assert.strictEqual(b.tiers.implement, 'light');
});

test('난이도 보정: research/implement/test만 ±1, main 불변, clamp', () => {
  const base = { brainstorm: 'main', research: 'standard', plan: 'main', implement: 'deep', test: 'light' };
  const high = applyDifficulty(base, 'high');
  assert.deepStrictEqual(high,
    { brainstorm: 'main', research: 'deep', plan: 'main', implement: 'deep', test: 'standard' }); // deep은 상한 clamp
  const low = applyDifficulty(base, 'low');
  assert.deepStrictEqual(low,
    { brainstorm: 'main', research: 'light', plan: 'main', implement: 'standard', test: 'light' }); // light 하한 clamp
  assert.deepStrictEqual(applyDifficulty(base, 'medium'), base);
  assert.deepStrictEqual(applyDifficulty(base, null), base); // 부재 → 무보정
});

test('sizeToTier 매핑', () => {
  assert.strictEqual(sizeToTier('S'), 'light');
  assert.strictEqual(sizeToTier('M'), 'standard');
  assert.strictEqual(sizeToTier('L'), 'standard');
  assert.strictEqual(sizeToTier('XL'), 'deep');
  assert.strictEqual(sizeToTier('??'), null);
  assert.strictEqual(sizeToTier(undefined), null);
});

test('per-slice 규칙 (설계 §2.5): 세션 standard = 기존 slice-size auto와 동일', () => {
  assert.strictEqual(sliceModelTier('standard', 'S'), 'light');     // → haiku on Claude
  assert.strictEqual(sliceModelTier('standard', 'M'), 'standard');  // → sonnet
  assert.strictEqual(sliceModelTier('standard', 'L'), 'standard');
  assert.strictEqual(sliceModelTier('standard', 'XL'), 'deep');     // → opus
});

test('per-slice 규칙: offset 시프트 + clamp + size 부재 fallback', () => {
  assert.strictEqual(sliceModelTier('deep', 'S'), 'standard');  // +1 시프트
  assert.strictEqual(sliceModelTier('deep', 'XL'), 'deep');     // 상한 clamp
  assert.strictEqual(sliceModelTier('light', 'M'), 'light');    // -1 시프트
  assert.strictEqual(sliceModelTier('light', 'S'), 'light');    // 하한 clamp
  assert.strictEqual(sliceModelTier('standard', undefined), 'standard'); // size 부재 → 세션값
});

test("per-slice 규칙: 세션 tier 'main'은 size 무관 항상 main 유지 (final review #1 — fail-safe 붕괴 차단)", () => {
  // tierIndex('main') === -1 → offset 재도출 시 light로 조용히 붕괴하던 버그의 회귀 방지.
  // 'main'은 세션 모델 inline 실행을 의미하므로 per-slice 재도출 대상이 아니다.
  assert.strictEqual(sliceModelTier('main', 'S'), 'main');
  assert.strictEqual(sliceModelTier('main', 'XL'), 'main');
  assert.strictEqual(sliceModelTier('main', undefined), 'main');
});

// --- Task 5: decideModelRouting (우선순위 + 해석 + meta) ---

const { decideModelRouting } = require('./model-routing-runtime.js');

test('엔진 자동 경로: claude 런타임 해석 + meta 병행 기록', () => {
  const r = decideModelRouting({ signals: { tracked_files: 500 }, taskText: '기능 추가',
    difficulty: 'medium', runtime: 'claude' });
  assert.deepStrictEqual(r.model_routing,
    { brainstorm: 'main', research: 'sonnet', plan: 'main', implement: 'sonnet', test: 'haiku' });
  assert.deepStrictEqual(r.meta.tiers,
    { brainstorm: 'main', research: 'standard', plan: 'main', implement: 'standard', test: 'light' });
  assert.strictEqual(r.meta.runtime, 'claude');
  assert.strictEqual(typeof r.meta.catalog_version, 'number');
  assert.strictEqual(typeof r.meta.decided_at, 'string');
  assert.deepStrictEqual(r.warnings, []);
});

test('unknown 런타임 → 전 phase main + 경고 (설계 §3.1 fail-safe)', () => {
  const r = decideModelRouting({ signals: { tracked_files: 500 }, taskText: 't', runtime: 'unknown' });
  for (const phase of ['research', 'implement', 'test']) assert.strictEqual(r.model_routing[phase], 'main');
  assert.ok(r.warnings.length >= 1);
});

test('pinned tier는 tier를 교체 후 해석', () => {
  const r = decideModelRouting({ signals: { tracked_files: 500 }, taskText: 't', runtime: 'claude',
    pinned: { implement: 'deep' } });
  assert.strictEqual(r.model_routing.implement, 'opus');
  assert.strictEqual(r.meta.tiers.implement, 'deep');
  assert.deepStrictEqual(r.meta.pinned, { implement: 'deep' });
});

test('pinned concrete(현재 런타임)는 그대로 통과', () => {
  const r = decideModelRouting({ signals: { tracked_files: 500 }, taskText: 't', runtime: 'claude',
    pinned: { implement: 'opus' } });
  assert.strictEqual(r.model_routing.implement, 'opus');
});

test('pinned concrete foreign runtime rejects explicitly',()=>{
  assert.throws(()=>decideModelRouting({runtime:'codex',pinned:{implement:'opus'}}),/foreign-model/);
});

test('brainstorm/plan pinned는 거부+경고 (main 고정)', () => {
  const r = decideModelRouting({ signals: { tracked_files: 500 }, taskText: 't', runtime: 'claude',
    pinned: { plan: 'opus' } });
  assert.strictEqual(r.model_routing.plan, 'main');
  assert.ok(r.warnings.some((w) => /plan/.test(w)));
});

test('catalogOverride 반영', () => {
  const r = decideModelRouting({ signals: { tracked_files: 500 }, taskText: 't', runtime: 'claude',
    catalogOverride: { claude: { standard: 'sonnet-next' } } });
  assert.strictEqual(r.model_routing.research, 'sonnet-next');
});

test('adaptive policy floor와 effort meta는 high risk를 상향한다', () => {
  const r = decideModelRouting({ signals: { tracked_files: 50 }, taskText: 't', runtime: 'claude',
    riskClass: 'high', now: '2026-07-21T00:00:00.000Z' });
  assert.deepStrictEqual(r.meta.tiers,
    { brainstorm: 'main', research: 'deep', plan: 'main', implement: 'deep', test: 'standard' });
  assert.deepStrictEqual(r.meta.policy.floors_applied, {
    research: { from: 'light', to: 'deep' }, implement: { from: 'standard', to: 'deep' },
    test: { from: 'light', to: 'standard' },
  });
  assert.deepStrictEqual(r.meta.policy.floors_effective,
    { research: 'deep', implement: 'deep', test: 'standard' });
  assert.deepStrictEqual(r.meta.efforts, {
    research: { role: 'author', effort: 'high' },
    implement: { role: 'implementer', effort: 'high' },
    test: { role: 'implementer', effort: 'high' },
  });
  assert.equal(r.meta.decided_at, '2026-07-21T00:00:00.000Z');
});

test('policy floor는 상향 전용이며 main 같은 비-tier 값을 바꾸지 않는다', () => {
  const lean = decideModelRouting({ signals: { tracked_files: 500 }, runtime: 'unknown', riskClass: 'low' });
  assert.equal(lean.meta.tiers.research, 'standard');
  assert.equal(lean.meta.tiers.implement, 'standard');
  assert.equal(lean.meta.tiers.plan, 'main');
});

test('floorBaseline은 두 호출 사이 floor 단조성을 보장한다', () => {
  const first = decideModelRouting({ signals: { tracked_files: 50 }, runtime: 'claude', riskClass: 'critical' });
  const second = decideModelRouting({ signals: { tracked_files: 50 }, runtime: 'claude', riskClass: 'low',
    floorBaseline: first.meta.policy.floors_effective });
  for (const phase of ['research', 'implement', 'test']) {
    assert.ok(tierIndex(second.meta.policy.floors_effective[phase]) >=
      tierIndex(first.meta.policy.floors_effective[phase]));
    assert.ok(tierIndex(second.meta.tiers[phase]) >= tierIndex(first.meta.tiers[phase]),
      `${phase} effective routing tier must be monotonic`);
  }
});

test('pin은 floor보다 최종 우선이며 floor override를 기록한다', () => {
  const r = decideModelRouting({ signals: { tracked_files: 50 }, runtime: 'claude', riskClass: 'high',
    pinned: { implement: 'light' } });
  assert.equal(r.meta.tiers.implement, 'light');
  assert.equal(r.model_routing.implement, 'haiku');
  assert.deepStrictEqual(r.meta.policy.floor_overridden_by_pin, { implement: true });
  assert.equal(r.meta.policy.floors_effective.implement, 'deep');
});

test('pin of the model shared by standard and deep is not reported as overriding a deep floor', () => {
  const run = (model) => decideModelRouting({ signals: { tracked_files: 50 }, runtime: 'codex', riskClass: 'high',
    pinned: { implement: model } });
  const shared = run('gpt-6.1-sol');
  assert.equal(shared.model_routing.implement, 'gpt-6.1-sol');
  assert.equal(shared.meta.policy.floors_effective.implement, 'deep');
  assert.equal(shared.meta.policy.floor_overridden_by_pin.implement, undefined);
  const lower = run('gpt-6-luna');
  assert.equal(lower.model_routing.implement, 'gpt-6-luna');
  assert.equal(lower.meta.policy.floor_overridden_by_pin.implement, true);
});

test('recognized pins outside the default catalog are still compared with the floor by capability tier', () => {
  const run = (model) => decideModelRouting({ signals: { tracked_files: 50 }, runtime: 'codex', riskClass: 'high',
    pinned: { implement: model } });
  for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna']) {
    const r = run(model);
    assert.equal(r.model_routing.implement, model);
    assert.equal(r.meta.policy.floor_overridden_by_pin.implement, true);
    assert.deepEqual(r.warnings.filter((w) => w.includes(model)), []);
  }
  for (const model of ['gpt-5.6-sol', 'gpt-6-sol', 'gpt-6-astra', 'main']) {
    assert.equal(run(model).meta.policy.floor_overridden_by_pin.implement, undefined);
  }
  assert.equal(run('gpt-9-foo').meta.policy.floor_overridden_by_pin.implement, undefined);
});

test('risk/floor 부재는 고정 clock에서 기존 shape를 보존하고 policy/efforts를 생략한다', () => {
  const r = decideModelRouting({ signals: { tracked_files: 500 }, taskText: 't', runtime: 'claude',
    now: '2026-07-21T00:00:00.000Z' });
  assert.equal(r.meta.decided_at, '2026-07-21T00:00:00.000Z');
  assert.ok(!Object.hasOwn(r.meta, 'policy'));
  assert.ok(!Object.hasOwn(r.meta, 'efforts'));
});

test('shadow mode는 risk를 기록하되 floor를 적용하지 않는다', () => {
  const r = decideModelRouting({ signals: { tracked_files: 50 }, runtime: 'claude', riskClass: 'critical',
    policyMode: 'shadow' });
  assert.equal(r.meta.tiers.implement, 'standard');
  assert.deepStrictEqual(r.meta.policy.floors_applied, {});
  assert.deepStrictEqual(r.meta.policy.floors_effective, {});
});

test('sliceModelTierWithRisk는 session slice tier에 risk floor를 적용하고 부재 시 동일하다', () => {
  assert.equal(sliceModelTierWithRisk('standard', 'S', 'high'), 'deep');
  assert.equal(sliceModelTierWithRisk('standard', 'S', 'low'), 'light');
  assert.equal(sliceModelTierWithRisk('standard', 'XL', 'critical'), 'deep');
  assert.equal(sliceModelTierWithRisk('main', 'S', 'critical'), 'main');
  assert.equal(sliceModelTierWithRisk('standard', 'M'), sliceModelTier('standard', 'M'));
});

test('property: policy floor는 risk×scale×difficulty 조합에서 baseline tier를 낮추지 않는다', () => {
  for (const tracked_files of [50, 500, 5000]) for (const difficulty of ['low', 'medium', 'high']) {
    const baseline = decideModelRouting({ signals: { tracked_files }, difficulty, runtime: 'claude' });
    for (const riskClass of ['low', 'medium', 'high', 'critical']) {
      const routed = decideModelRouting({ signals: { tracked_files }, difficulty, runtime: 'claude', riskClass });
      for (const phase of ['research', 'implement', 'test']) {
        assert.ok(tierIndex(routed.meta.tiers[phase]) >= tierIndex(baseline.meta.tiers[phase]));
      }
    }
  }
});

test('무주입 clock 호출은 decided_at 제외 projection이 동일하다', () => {
  const a = decideModelRouting({ signals: { tracked_files: 500 }, runtime: 'claude' });
  const b = decideModelRouting({ signals: { tracked_files: 500 }, runtime: 'claude' });
  delete a.meta.decided_at; delete b.meta.decided_at;
  assert.deepStrictEqual(a, b);
});

test('effort meta는 provider-neutral effort 어휘만 포함한다', () => {
  const allowed = new Set(['medium', 'high', 'xhigh', 'max']);
  for (const riskClass of ['low', 'medium', 'high', 'critical']) {
    const r = decideModelRouting({ signals: { tracked_files: 500 }, runtime: 'codex', riskClass });
    for (const value of Object.values(r.meta.efforts)) {
      assert.ok(allowed.has(value.effort));
      assert.ok(!/claude|codex|gpt|sonnet|opus|haiku/i.test(value.effort));
    }
  }
});

test('v7 model router is a facade that cannot weaken methodology authority',()=>{
  const {compileMethodologyAuthority}=require('./policy-runtime.js');
  const methodologyPolicy=compileMethodologyAuthority({
    riskProfile:{class:'high'},difficulty:'medium',mode:'adaptive'});
  const r=decideModelRouting({signals:{tracked_files:50},runtime:'claude',
    methodologyPolicy,riskClass:'low'});
  assert.equal(r.meta.authority,'methodology-policy-v1');
  assert.equal(r.meta.compatibility_mode,'policy-facade');
  assert.equal(r.meta.tiers.research,'deep');
  assert.equal(r.meta.tiers.implement,'deep');
  assert.equal(r.meta.tiers.test,'standard');
  assert.ok(r.warnings.some((warning)=>/legacy riskClass.*ignored/i.test(warning)));

  const forged=structuredClone(methodologyPolicy);
  forged.role_routing.tiers.implement='opus';
  assert.throws(()=>decideModelRouting({signals:{tracked_files:50},
    runtime:'codex',methodologyPolicy:forged}),/methodology-policy/);
});
