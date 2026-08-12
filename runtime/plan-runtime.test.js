'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validatePlanScopeV1, canonicalizePlanScopeV1, deriveScopedWriteAuthority,
  CLASS_FIELD } =
  require('./plan-runtime.js');
const { compilePlanProjectionV1, compileImmutablePlanAuthorityV2 } = require('./plan-runtime.js');
const { specContractDigest } = require('./contract-runtime.js');
const {canonicalJson}=require('./operation-journal.js');

test('plan approval is the sole plan.json producer', () => {
  const specContract = {
    schema_version: 1, spec_id: 'SPEC-PLAN', risk_class: 'medium',
    requirements: [{ id: 'REQ-001', statement: 'Project plan', acceptance: 'projection matches',
      priority: 'must', negative_test_ids: ['NEG-001'], evidence_gate_ids: ['GATE-plan-alignment'] }],
    invariants: [{ id: 'INV-001', statement: 'Bound identity', requirement_ids: ['REQ-001'] }],
    failure_matrix: [], negative_tests: [{ id: 'NEG-001', statement: 'stale plan',
      requirement_ids: ['REQ-001'], failure_mode_ids: [], expected_signal: 'digest mismatch',
      gate_id: 'GATE-plan-alignment' }], compatibility: { legacy_inputs: 'explicit', migration: 'none' },
    open_questions: [],
  };
  const markdown = ['## Spec Contract Binding', '', '```json', JSON.stringify({ schema_version: 1,
    mode: 'strict-spec', created_by_version: '6.13.0', spec_contract: { schema_version: 1,
      spec_id: 'SPEC-PLAN', spec_sha256: specContractDigest(specContract), spec_approved_hash: 'a'.repeat(64) },
    risk_profile_sha256: 'b'.repeat(64) }), '```', '', '## Slice Checklist', '',
    '- [ ] SLICE-001: Project one slice', '  - outcome: projection is authoritative',
    '  - files: [runtime/a.js, runtime/a.test.js]', '  - depends_on: []',
    '  - integration_touchpoints: [plan approval]', '  - requirements: [REQ-001]',
    '  - invariants: [INV-001]', '  - failure_modes: []',
    '  - risk: { class: medium, score: 6, triggers: [state-machine] }',
    '  - negative_tests: [NEG-001]', '  - evidence_required: [GATE-plan-alignment]',
    '  - rollback: { method: revert, verification: [GATE-recovery] }', '  - review_policy: single',
    '  - scope_expansion_trigger: [public API change]', '  - failing_test: projection absent',
    '  - verification_cmd: node --test runtime/a.test.js', '  - expected_output: fail 0',
    '  - code_sketch: compilePlanProjectionV1()', '  - spec_checklist: [REQ-001]',
    '  - contract: [exact digest]', '  - acceptance_threshold: all', '  - size: M',
    '  - steps:', '    1. runtime/a.test.js fails first', '    2. runtime/a.js compiles projection'].join('\n');
  const projection = compilePlanProjectionV1({ planMarkdown: markdown, specContract,
    sliceRiskState: { 'SLICE-001': { class: 'medium', score: 6, triggers: ['state-machine'] } } });
  assert.equal(projection.schema_version, 1);
  assert.equal(projection.contract_binding.spec_contract.spec_sha256, specContractDigest(specContract));
  assert.match(projection.contract_binding.source_plan_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(projection.slices[0].write_scope.failing_test, ['runtime/a.test.js']);
  assert.deepEqual(projection.slices[0].write_scope.production, ['runtime/a.js']);
  assert.equal(projection.slices[0].contract.outcome, 'projection is authoritative');
  assert.throws(() => compilePlanProjectionV1({ planMarkdown: markdown.replace('score: 6', 'score: 7'),
    specContract, sliceRiskState: { 'SLICE-001': { class: 'medium', score: 6, triggers: ['state-machine'] } } }),
  /risk/);
});

const plan = {schema_version:1, slices:[{id:'SLICE-001', checked:false,
  scope_schema_version:1, files:['src/a.js','tests/a.test.js'], write_scope:{
    failing_test:['tests/a.test.js'], production:['src/a.js'],
    refactor:['src/a.js','tests/a.test.js'],
  }}]};

test('plan scope is byte-sorted, disjoint, complete, and digest-bound', () => {
  const checked = validatePlanScopeV1(plan);
  const canonical = canonicalizePlanScopeV1(checked);
  assert.deepEqual(canonical.slices[0].files, ['src/a.js','tests/a.test.js']);
  assert.match(canonical.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => validatePlanScopeV1({schema_version:1, slices:[{
    ...plan.slices[0], files:['src/A.js','src/a.js','tests/a.test.js'],
  }]}), /plan-scope/);
  assert.throws(() => validatePlanScopeV1({schema_version:1, slices:[{
    ...plan.slices[0], files:['CON','tests/a.test.js'], write_scope:{
      failing_test:['tests/a.test.js'], production:['CON'], refactor:[],
    },
  }]}), /portable-path-v1/);
});

test('inline authority is the intersection of class paths and slice union', () => {
  const authority = deriveScopedWriteAuthority({plan, sliceId:'SLICE-001',
    writeClass:'failing-test'});
  assert.deepEqual(authority.authorized_paths, ['tests/a.test.js']);
  assert.equal(authority.cluster_id, null);
  assert.match(authority.sha256, /^[0-9a-f]{64}$/);
});

test('write-class authority uses the persisted failing_test carrier key',()=>{
  assert.deepEqual(CLASS_FIELD,{
    'failing-test':'failing_test',production:'production',refactor:'refactor'});
  const authority=deriveScopedWriteAuthority({plan,sliceId:'SLICE-001',
    writeClass:'failing-test'});
  assert.deepEqual(authority.class_paths,['tests/a.test.js']);
});

test('delegation assignment is an exact partition of the locked plan', () => {
  const twoSlicePlan = {...plan, slices:[...plan.slices, {
    id:'SLICE-002', checked:false, scope_schema_version:1,
    files:['src/b.js','tests/b.test.js'], write_scope:{
      failing_test:['tests/b.test.js'], production:['src/b.js'], refactor:[],
    },
  }]};
  assert.throws(() => deriveScopedWriteAuthority({plan:twoSlicePlan,
    sliceId:'SLICE-001', writeClass:'production', clusterId:'C1',
    assignment:{schema_version:1, clusters:[{id:'C1',slices:['SLICE-001']}]},
  }), /delegation-scope-partition/);
  assert.throws(() => deriveScopedWriteAuthority({plan:twoSlicePlan,
    sliceId:'SLICE-001', writeClass:'production', clusterId:'C1',
    assignment:{schema_version:1, clusters:[{id:'C1',slices:['SLICE-002','SLICE-001']}]},
  }), /delegation-scope-order/);
});

test('v6.14 immutable plan authority binds carriers and excludes progress',()=>{
  const verificationSpec={schema_version:2,executable:{kind:'node-toolchain',name:'node',
    supported_patches_sha256:'1'.repeat(64)},args:['--test','--test-reporter=tap','--','tests/a.test.js'],
    cwd_role:'worktree',timeout_ms:120000,max_output_bytes:1048576,
    environment:{mode:'closed',values:{LANG:'C',LC_ALL:'C',TZ:'UTC'}},
    red_failure:{adapter:'node-test-tap',adapter_version:1,expected_class:'expected-failure',
      expected_signal:{kind:'assertion',operator:'strictEqual',test_identity:{test_file:'tests/a.test.js',
        test_name:'fails first',start_line:1},expected_digest:'2'.repeat(64),actual_digest:null,message_pattern:'fails'}}};
  const capabilityFacts={schema_version:1,authority:'reviewed-plan',destructive:false,external_action:false,
    has_backward_compat:true,has_migration:true,host_dependent:false,source_requirement_ids:['REQ-001'],
    source_slice_ids:['SLICE-001','SLICE-002']};
  capabilityFacts.facts_sha256=crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from('capability-facts-v1\0'),Buffer.from(canonicalJson(capabilityFacts))])).digest('hex');
  const projection={schema_version:2,replan_epoch:null,contract_binding:{mode:'strict-spec'},
    capability_facts:capabilityFacts,slices:[
      {id:'SLICE-001',slice_kind:'functional',checked:false,scope_schema_version:1,
        files:['src/a.js','tests/a.test.js'],write_scope:{failing_test:['tests/a.test.js'],production:['src/a.js'],refactor:[]},
        verification_spec:verificationSpec,verification_spec_sha256:'4'.repeat(64)},
      {id:'SLICE-002',slice_kind:'release-verification',checked:false,scope_schema_version:1,files:[],
        write_scope:{failing_test:[],production:[],refactor:[]},verification_scope:['npm test'],
        release_gate_ids:['GATE-full-relevant-suite'],verification_spec:null,verification_spec_sha256:null},
    ]};
  const first=compileImmutablePlanAuthorityV2(projection);
  const progressed=structuredClone(projection);progressed.slices[0].checked=true;
  assert.equal(compileImmutablePlanAuthorityV2(progressed).plan_authority_sha256,first.plan_authority_sha256);
  const drifted=structuredClone(projection);drifted.slices[0].verification_spec.timeout_ms=119999;
  assert.notEqual(compileImmutablePlanAuthorityV2(drifted).plan_authority_sha256,first.plan_authority_sha256);
  const writableRelease=structuredClone(projection);writableRelease.slices[1].write_scope.production=['src/release.js'];
  assert.throws(()=>compileImmutablePlanAuthorityV2(writableRelease),/release-slice-write-scope/);
  for(const checked of [null,0,'']){
    const malformed=structuredClone(projection);malformed.slices[0].checked=checked;
    assert.throws(()=>compileImmutablePlanAuthorityV2(malformed),/plan-authority-v2/);
  }
});

test('first-RED Plan authority recomputes the exact VerificationSpecV2 digest and replan epoch',()=>{
  const verificationSpec={schema_version:2,executable:{kind:'node-toolchain',name:'node',
    supported_patches_sha256:'1'.repeat(64)},
  args:['--test','--test-reporter=tap','--','tests/a.test.js'],cwd_role:'worktree',
  timeout_ms:30000,max_output_bytes:262144,
  environment:{mode:'closed',values:{LANG:'C',LC_ALL:'C',TZ:'UTC'}},
  red_failure:{adapter:'node-test-tap',adapter_version:1,expected_class:'expected-failure',
    expected_signal:{kind:'assertion',operator:'strictEqual',
      test_identity:{test_file:'tests/a.test.js',test_name:'fails first',start_line:3},
      expected_digest:'2'.repeat(64),actual_digest:'3'.repeat(64),message_pattern:'fails first'}}};
  const verificationSpecSha256=crypto.createHash('sha256')
    .update(Buffer.from(canonicalJson(verificationSpec))).digest('hex');
  const facts={schema_version:1,authority:'reviewed-plan',destructive:false,external_action:false,
    has_backward_compat:true,has_migration:true,host_dependent:false,
    source_requirement_ids:['REQ-001'],source_slice_ids:['SLICE-001']};
  facts.facts_sha256=crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from('capability-facts-v1\0'),Buffer.from(canonicalJson(facts))])).digest('hex');
  const projection={schema_version:2,replan_epoch:'4'.repeat(64),
    contract_binding:{mode:'strict-spec',created_by_version:'6.14.0',
      spec_contract:{spec_id:'SPEC-FIRST-RED',spec_sha256:'5'.repeat(64),
        spec_approved_hash:'6'.repeat(64)},risk_profile_sha256:'7'.repeat(64)},
    capability_facts:facts,slices:[{id:'SLICE-001',slice_kind:'functional',checked:false,
      scope_schema_version:1,files:['src/a.js','tests/a.test.js'],
      write_scope:{failing_test:['tests/a.test.js'],production:['src/a.js'],refactor:[]},
      verification_spec:verificationSpec,verification_spec_sha256:verificationSpecSha256}]};
  const authority=compileImmutablePlanAuthorityV2(projection);
  assert.equal(authority.slices[0].verification_spec_sha256,verificationSpecSha256);
  const forged=structuredClone(projection);
  forged.slices[0].verification_spec_sha256='8'.repeat(64);
  assert.throws(()=>compileImmutablePlanAuthorityV2(forged),/verification-spec-digest/);
  for(const version of ['6.100.0','10.0.0']){
    const future=structuredClone(forged);
    future.replan_epoch=null;
    future.contract_binding.created_by_version=version;
    assert.throws(()=>compileImmutablePlanAuthorityV2(future),
      /verification-spec-digest/,version);
  }
  const stale=structuredClone(projection);
  stale.replan_epoch='9'.repeat(64);
  assert.notEqual(compileImmutablePlanAuthorityV2(stale).plan_authority_sha256,
    authority.plan_authority_sha256);
});
