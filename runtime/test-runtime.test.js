'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const { recordTestPass, recordTestRetry, recordTestExhaustion, beginMutationRound, recordMutationResult } =
  require('./test-runtime.js');
const platform=require('./platform.js');const transaction=require('./transaction-runtime.js');
const {parseFrontmatter}=require('./frontmatter.js');

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

test('retry invalidates only failed slices and mutation round is separate', () => {
  const plan = {slices:[{id:'SLICE-001',checked:true},{id:'SLICE-002',checked:true}]};
  const receipts = {'SLICE-001':{status:'complete'}, 'SLICE-002':{status:'complete'}};
  const result = recordTestRetry({state:{current_phase:'test',test_retry_count:0,max_test_retries:2},
    plan, receipts, failedSlices:['SLICE-002']});
  assert.equal(result.plan.slices[0].checked, true);
  assert.equal(result.plan.slices[1].checked, false);
  assert.equal(result.receipts['SLICE-002'].status, 'invalidated');
  assert.equal(result.state.receipt_recovery_generation,1);
  const exhausted=recordTestExhaustion({state:{current_phase:'test',test_retry_count:2,
    max_test_retries:2},plan,receipts,failedSlices:['SLICE-001']});
  assert.equal(exhausted.state.receipt_recovery_generation,1);
  assert.equal(beginMutationRound({state:{current_phase:'test'}, round:1,
    survived:{mutants:[1]}}).current_phase, 'implement');
  assert.equal(recordMutationResult({state:{}, result:{status:'not-applicable'}})
    .mutation_testing.status, 'not-applicable');
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
