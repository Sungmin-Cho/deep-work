'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const { recordTestPass, recordTestRetry, recordTestExhaustion, beginMutationRound, recordMutationResult } =
  require('./test-runtime.js');
const platform=require('./platform.js');const transaction=require('./transaction-runtime.js');
const {parseFrontmatter}=require('./frontmatter.js');
const functionalReceipt=require('./functional-receipt-runtime.js');

test('test pass consumes bounded complete gate evidence', () => {
  const state = {current_phase:'test', test_retry_count:0};
  const next = recordTestPass({state, gateResults:{complete:true, failedSlices:[]},
    at:'2026-07-13T00:00:00Z'});
  assert.equal(next.test_passed, true);
  assert.equal(next.test_completed_at, '2026-07-13T00:00:00Z');
  assert.throws(() => recordTestPass({state, gateResults:{complete:false}}), /gate-results/);
});

test('incomplete evidence cannot set test_passed for a compiled plan',()=>{
  const verificationPlan=JSON.parse(fs.readFileSync(path.join(__dirname,'../tests/fixtures/v6.13-evidence/verification-plan-minimal.json'),'utf8'));
  assert.throws(()=>recordTestPass({state:{current_phase:'test'},gateResults:{complete:true,failedSlices:[],gates:[]},
    verificationPlan,evidencePackage:null,evidenceSummary:{complete:false},at:'2026-07-13T00:00:00Z'}),/evidence|gate-results/);
});

test('retry invalidates failed functional slices and dependent release progress', () => {
  const plan = {slices:[{id:'SLICE-001',slice_kind:'functional',checked:true},
    {id:'SLICE-002',slice_kind:'functional',checked:true},
    {id:'SLICE-003',slice_kind:'release-verification',checked:true}]};
  const receipts = {'SLICE-001':{status:'complete'}, 'SLICE-002':{status:'complete'},
    'SLICE-003':{status:'complete'}};
  const result = recordTestRetry({state:{current_phase:'test',test_retry_count:0,max_test_retries:2},
    plan, receipts, failedSlices:['SLICE-002']});
  assert.equal(result.plan.slices[0].checked, true);
  assert.equal(result.plan.slices[1].checked, false);
  assert.equal(result.plan.slices[2].checked, false);
  assert.equal(result.receipts['SLICE-002'].status, 'invalidated');
  assert.equal(result.receipts['SLICE-003'].status, 'invalidated');
  assert.equal(result.state.receipt_recovery_generation,1);
  assert.equal(result.state.test_passed,false);
  const exhausted=recordTestExhaustion({state:{current_phase:'test',test_retry_count:2,
    max_test_retries:2},plan,receipts,failedSlices:['SLICE-001']});
  assert.equal(exhausted.state.receipt_recovery_generation,3);
  assert.equal(beginMutationRound({state:{current_phase:'test'}, round:1,
    survived:{mutants:[1]}}).current_phase, 'implement');
  assert.equal(recordMutationResult({state:{}, result:{status:'not-applicable'}})
    .mutation_testing.status, 'not-applicable');
});

test('functional retry invalidates the dependent release receipt and progress',()=>{
  const plan={slices:[{id:'SLICE-001',slice_kind:'functional',checked:true},
    {id:'SLICE-002',slice_kind:'release-verification',checked:true}]};
  const receipts={'SLICE-001':{status:'complete'},'SLICE-002':{status:'complete'}};
  const result=recordTestRetry({state:{current_phase:'test',test_retry_count:1,
    receipt_recovery_generation:1,max_test_retries:3,test_passed:true,
    functional_receipt_sha256:'a'.repeat(64),
    functional_completion_operation_id:'op-'+'b'.repeat(64),
    release_verification_receipt_sha256:'c'.repeat(64),
    release_verification_operation_id:'op-'+'d'.repeat(64),
    functional_receipt_bindings_json:functionalReceipt.serializeFunctionalReceiptBindings({
      'SLICE-001':{recovery_generation:1,receipt_sha256:'a'.repeat(64),
        completion_operation_id:'op-'+'b'.repeat(64)}})},plan,receipts,
    failedSlices:['SLICE-001']});
  assert.deepEqual(result.invalidatedSlices,['SLICE-001','SLICE-002']);
  assert.deepEqual(result.plan.slices.map((slice)=>slice.checked),[false,false]);
  assert.deepEqual(Object.values(result.receipts).map((receipt)=>receipt.status),
    ['invalidated','invalidated']);
  assert.equal(result.state.receipt_recovery_generation,2);
  assert.equal(result.state.test_passed,false);
  assert.equal(result.state.functional_receipt_sha256,null);
  assert.equal(result.state.functional_completion_operation_id,null);
  assert.equal(result.state.release_verification_receipt_sha256,null);
  assert.equal(result.state.release_verification_operation_id,null);
  assert.deepEqual(functionalReceipt.parseFunctionalReceiptBindings(
    result.state.functional_receipt_bindings_json),{
      'SLICE-001':{recovery_generation:2,receipt_sha256:null,
        completion_operation_id:null}});
});

test('retry seeds unaffected completed functional receipts before invalidating the failed slice',()=>{
  const plan={slices:[{id:'SLICE-001',slice_kind:'functional',checked:true},
    {id:'SLICE-002',slice_kind:'functional',checked:true}]};
  const receipts={
    'SLICE-001':{status:'complete',receipt_sha256:'a'.repeat(64),
      completion_operation_id:'op-'+'b'.repeat(64)},
    'SLICE-002':{status:'complete',receipt_sha256:'c'.repeat(64),
      completion_operation_id:'op-'+'d'.repeat(64)}};
  const result=recordTestRetry({state:{current_phase:'test',test_retry_count:0,
    max_test_retries:2},plan,receipts,failedSlices:['SLICE-002']});
  assert.deepEqual(functionalReceipt.parseFunctionalReceiptBindings(
    result.state.functional_receipt_bindings_json),{
      'SLICE-001':{recovery_generation:0,receipt_sha256:'a'.repeat(64),
        completion_operation_id:'op-'+'b'.repeat(64)},
      'SLICE-002':{recovery_generation:1,receipt_sha256:null,
        completion_operation_id:null}});
});

test('retry invalidated receipt identity is an atomic digest-operation pair',()=>{
  const result=recordTestRetry({
    state:{current_phase:'test',test_retry_count:0,max_test_retries:2},
    plan:{slices:[{id:'SLICE-001',slice_kind:'functional',checked:true}]},
    receipts:{'SLICE-001':{status:'complete',receipt_sha256:'a'.repeat(64),
      completion_operation_id:'op-malformed'}},failedSlices:['SLICE-001']});
  assert.deepEqual(result.invalidatedFunctionalReceipts,[{slice_id:'SLICE-001',
    receipt_sha256:null,completion_operation_id:null}]);
});

test('persisted recovery generation below retry count is rejected',()=>{
  assert.throws(()=>functionalReceipt.recoveryGenerationFromFields({
    test_retry_count:3,receipt_recovery_generation:1}),
  /functional-recovery-generation/);
});

test('journaled functional retry invalidates dependent release stores',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    'dw-test-dependent-release-')));fs.mkdirSync(path.join(root,'.git'));
  fs.mkdirSync(path.join(root,'.claude'));const sessionId='s-aaaaaaaa';
  const work=path.join(root,'.deep-work',sessionId),receipts=path.join(work,'receipts');
  fs.mkdirSync(receipts,{recursive:true});const statePath=path.join(root,'.claude',
    `deep-work.${sessionId}.md`);fs.writeFileSync(statePath,
    '---\nsession_id: s-aaaaaaaa\nwork_dir: .deep-work/s-aaaaaaaa\n'+
    'current_phase: test\ntest_retry_count: 1\nreceipt_recovery_generation: 1\n'+
    'max_test_retries: 3\n---\n');
  const plan={slices:[{id:'SLICE-001',slice_kind:'functional',checked:true},
    {id:'SLICE-002',slice_kind:'release-verification',checked:true}]};
  fs.writeFileSync(path.join(work,'plan.json'),JSON.stringify(plan));
  for(const id of ['SLICE-001','SLICE-002'])fs.writeFileSync(
    path.join(receipts,`${id}.json`),JSON.stringify({slice_id:id,status:'complete'}));
  const stateCapability=platform.issueProjectStateCapability(root,statePath,
    {role:'session-state'});const sessionCapability=platform.issueProjectStateCapability(
      root,work,{role:'session-work-dir',sessionStateCapability:stateCapability});
  const planCapability=transaction.issueSessionFileCapability({sessionCapability,
    candidate:path.join(work,'plan.json'),allowedBasenames:['plan.json'],role:'locked-plan'});
  const result=await recordTestRetry({stateCapability,planCapability,plan,
    receiptsDirCapability:Object.freeze({kind:'receipts-directory',role:'receipts-directory',
      path:receipts,sessionCapability,projectRoot:root}),failedSlices:['SLICE-001'],
    at:'2026-07-13T00:00:00Z'});
  assert.deepEqual(result.operationReceipt.result.invalidatedSlices,
    ['SLICE-001','SLICE-002']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work,'plan.json'))).slices
    .map((slice)=>slice.checked),[false,false]);
  assert.deepEqual(['SLICE-001','SLICE-002'].map((id)=>JSON.parse(fs.readFileSync(
    path.join(receipts,`${id}.json`))).status),['invalidated','invalidated']);
});

test('test retry adopts every partial plan receipt and state write',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-test-retry-'));fs.mkdirSync(path.join(root,'.git'));
  fs.mkdirSync(path.join(root,'.claude'));const work=path.join(root,'.deep-work','s-aaaaaaaa');const receipts=path.join(work,'receipts');
  fs.mkdirSync(receipts,{recursive:true});const statePath=path.join(root,'.claude','deep-work.s-aaaaaaaa.md');
  fs.writeFileSync(statePath,'---\nsession_id: s-aaaaaaaa\nwork_dir: .deep-work/s-aaaaaaaa\ncurrent_phase: test\ntest_retry_count: 0\nmax_test_retries: 2\n---\n');
  const originalPlan={slices:[{id:'SLICE-001',checked:true},{id:'SLICE-002',checked:true}]};
  fs.writeFileSync(path.join(work,'plan.json'),JSON.stringify(originalPlan));fs.writeFileSync(path.join(receipts,'SLICE-002.json'),
    JSON.stringify({slice_id:'SLICE-002',status:'complete'}));const args=()=>{const stateCapability=
      platform.issueProjectStateCapability(root,statePath,{role:'session-state'});const sessionCapability=platform.issueProjectStateCapability(
        root,work,{role:'session-work-dir',sessionStateCapability:stateCapability});const planCapability=transaction.issueSessionFileCapability({
          sessionCapability,candidate:path.join(work,'plan.json'),allowedBasenames:['plan.json'],role:'locked-plan'});return{stateCapability,
        planCapability,plan:JSON.parse(fs.readFileSync(planCapability.path,'utf8')),receiptsDirCapability:Object.freeze({kind:'receipts-directory',
          role:'receipts-directory',path:receipts,sessionCapability,projectRoot:root}),failedSlices:['SLICE-002'],at:'2026-07-13T00:00:00Z'};};
  for(const target of ['after-plan-write-before-stage','after-receipt-write-before-stage','after-state-write-before-stage'])await assert.rejects(
    ()=>recordTestRetry({...args(),seam:(name)=>{if(name===target)throw new Error(target);}}),new RegExp(target));
  const result=await recordTestRetry(args());assert.equal(result.state.current_phase,'implement');assert.equal(result.state.test_retry_count,1);
  assert.equal(result.state.receipt_recovery_generation,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(work,'plan.json'),'utf8')).slices[1].checked,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(receipts,'SLICE-002.json'),'utf8')).status,'invalidated');
  const fields=parseFrontmatter(fs.readFileSync(statePath,'utf8')).fields;assert.equal(fields.current_phase,'implement');
  assert.equal(fields.test_retry_count,1);assert.equal(fields.receipt_recovery_generation,1);
  assert.equal(fields.test_passed,false);
  assert.equal(Object.hasOwn(fields,'release_verification_receipt_sha256'),false);
  assert.equal(Object.hasOwn(fields,'release_verification_operation_id'),false);
  assert.equal(Object.hasOwn(fields,'functional_receipt_bindings_json'),false);
});

test('test retry uses bounded lock basenames for deep session work paths',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-test-deep-lock-'));fs.mkdirSync(path.join(root,'.git'));
  fs.mkdirSync(path.join(root,'.claude'));const relative=['.deep-work',...Array.from({length:10},(_,index)=>`segment-${index}-long`)];
  const work=path.join(root,...relative);const receipts=path.join(work,'receipts');fs.mkdirSync(receipts,{recursive:true});
  const statePath=path.join(root,'.claude','deep-work.s-bbbbbbbb.md');fs.writeFileSync(statePath,
    `---\nsession_id: s-bbbbbbbb\nwork_dir: ${relative.join('/')}\ncurrent_phase: test\ntest_retry_count: 0\nmax_test_retries: 2\n---\n`);
  const planPath=path.join(work,'plan.json');fs.writeFileSync(planPath,JSON.stringify({slices:[{id:'SLICE-001',checked:true}]}));
  fs.writeFileSync(path.join(receipts,'SLICE-001.json'),JSON.stringify({slice_id:'SLICE-001',status:'complete'}));
  const stateCapability=platform.issueProjectStateCapability(root,statePath,{role:'session-state'});const sessionCapability=
    platform.issueProjectStateCapability(root,work,{role:'session-work-dir',sessionStateCapability:stateCapability});
  const planCapability=transaction.issueSessionFileCapability({sessionCapability,candidate:planPath,allowedBasenames:['plan.json'],
    role:'locked-plan'});const result=await recordTestRetry({stateCapability,planCapability,plan:JSON.parse(fs.readFileSync(planPath,'utf8')),
    receiptsDirCapability:Object.freeze({kind:'receipts-directory',role:'receipts-directory',path:receipts,sessionCapability,projectRoot:root}),
    failedSlices:['SLICE-001'],at:'2026-07-13T00:00:00Z'});assert.equal(result.status,undefined);
  assert.equal(result.state.current_phase,'implement');
});
