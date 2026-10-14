'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { TIERS, MAIN, CATALOG_VERSION, DEFAULT_CATALOG, mergeCatalog, resolveTier,
  concreteModelsFor, allConcreteModels, tierForModel } = require('./model-catalog.js');

test('TIERS/MAIN 어휘 고정', () => {
  assert.deepStrictEqual(TIERS, ['light', 'standard', 'deep']);
  assert.strictEqual(MAIN, 'main');
  assert.strictEqual(typeof CATALOG_VERSION, 'number');
});

test('claude 기본 카탈로그 해석', () => {
  assert.deepStrictEqual(resolveTier('light', 'claude'), { model: 'haiku', warning: null });
  assert.deepStrictEqual(resolveTier('standard', 'claude'), { model: 'sonnet', warning: null });
  assert.deepStrictEqual(resolveTier('deep', 'claude'), { model: 'opus', warning: null });
});

test('main sentinel은 카탈로그 미경유', () => {
  assert.deepStrictEqual(resolveTier('main', 'claude'), { model: 'main', warning: null });
  assert.deepStrictEqual(resolveTier('main', 'codex'), { model: 'main', warning: null });
});

test('unknown 런타임 → main fail-safe + 경고', () => {
  const r = resolveTier('standard', 'unknown');
  assert.strictEqual(r.model, 'main');
  assert.match(r.warning, /unknown/);
});

test('카탈로그 값 null(미pin) → main fail-safe + 경고', () => {
  // Task 12 pin 전 codex 슬롯은 null — 안전 degrade가 계약이다
  const r = resolveTier('standard', 'codex', DEFAULT_CATALOG);
  if (DEFAULT_CATALOG.codex.standard === null) {
    assert.strictEqual(r.model, 'main');
    assert.match(r.warning, /codex/);
  } else {
    assert.strictEqual(r.model, DEFAULT_CATALOG.codex.standard);
  }
});

test('codex 카탈로그 pin(Task 12 실기 검증) — 관측된 모델명과 일치', () => {
  // ~/.codex/models_cache.json 실기 조사로 확정된 값. null로 되돌아가면(fail-safe 재진입)
  // 아래 3개 assert가 실패해 회귀를 잡는다. 근거: .superpowers/sdd/task-12-report.md
  assert.strictEqual(DEFAULT_CATALOG.codex.light, 'gpt-6-luna');
  assert.strictEqual(DEFAULT_CATALOG.codex.standard, 'gpt-6.1-sol');
  assert.strictEqual(DEFAULT_CATALOG.codex.deep, 'gpt-6.1-sol');
  assert.deepStrictEqual(resolveTier('deep', 'codex'), { model: 'gpt-6.1-sol', warning: null });
});

test('잘못된 tier → main + 경고 (fail-safe, throw 금지)', () => {
  const r = resolveTier('opus', 'claude'); // concrete명은 tier가 아니다
  assert.strictEqual(r.model, 'main');
  assert.match(r.warning, /tier/);
});

test('mergeCatalog는 2-레벨 부분 override + 미지 키 무시', () => {
  const merged = mergeCatalog({ claude: { deep: 'opus-next' }, bogus: { light: 'x' } });
  assert.strictEqual(merged.claude.deep, 'opus-next');
  assert.strictEqual(merged.claude.light, 'haiku');
  assert.strictEqual(merged.bogus, undefined);
});

test('concreteModelsFor/allConcreteModels는 null 제외', () => {
  assert.deepStrictEqual(concreteModelsFor('claude'), ['haiku', 'sonnet', 'opus']);
  assert.ok(allConcreteModels().includes('sonnet'));
  assert.ok(!allConcreteModels().includes(null));
});
test('Astra is an explicit Codex catalog pin without replacing Sol deep default',()=>{
  assert.ok(concreteModelsFor('codex').includes('gpt-6-astra'));
  assert.equal(DEFAULT_CATALOG.codex.deep,'gpt-6.1-sol');
});
test('catalog version 3 and codex concrete set follow the latest generation of each line',()=>{
  assert.equal(CATALOG_VERSION,3);
  assert.deepStrictEqual(concreteModelsFor('codex'),['gpt-6-luna','gpt-6.1-sol','gpt-6-astra']);
});
test('tierForModel returns the highest pinned tier or null',()=>{
  assert.equal(tierForModel('gpt-6.1-sol','codex'),'deep');
  assert.equal(tierForModel('gpt-6-luna','codex'),'light');
  assert.equal(tierForModel('haiku','claude'),'light');
  assert.equal(tierForModel('gpt-9-foo','codex'),null);
  assert.equal(tierForModel('gpt-6-astra','codex'),null);
  assert.equal(tierForModel('main','codex'),null);
  assert.equal(tierForModel(undefined,'codex'),null);
  assert.equal(tierForModel(42,'codex'),null);
  assert.equal(tierForModel('gpt-6.1-sol','unknown'),null);
  const shared=mergeCatalog({codex:{light:'custom-x',standard:'custom-x'}});
  assert.equal(tierForModel('custom-x','codex',shared),'standard');
});
