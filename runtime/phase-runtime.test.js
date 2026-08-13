'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {execFileSync}=require('node:child_process');
const { transitionSliceTdd, advancePhase, enterSpecSubphase,approveSpecSubphase,approvePhase,
  completeDebug,recordPhaseReview,PHASE_GRAPH,rerunPhase } = require('./phase-runtime.js');
const {specContractDigest}=require('./contract-runtime.js');
const platform=require('./platform.js');const transaction=require('./transaction-runtime.js');
const {beginScopedWrite,acceptScopedWrite,completeSlice}=require('./slice-runtime.js');
const {deriveScopedWriteAuthority}=require('./plan-runtime.js');
const {runVerification}=require('./verification-runtime.js');
const {runSensor,runReviewCheck,aggregateSensorResults}=require('./sensor-runtime.js');
const {parseFrontmatter}=require('./frontmatter.js');
const artifact=require('./artifact-runtime.js');
const phaseRuntime=require('./phase-runtime.js');
const {canonicalJson,sha256}=require('./operation-journal.js');

test('test rerun preserves the recovery generation before resetting retry count',()=>{
  const next=rerunPhase({state:{current_phase:'test',test_retry_count:2},phase:'test'});
  assert.equal(next.receipt_recovery_generation,2);
  assert.equal(next.test_retry_count,0);assert.equal(next.test_passed,false);
});

test('phase graph is closed and skip edges are explicit', () => {
  assert.deepEqual(PHASE_GRAPH.brainstorm, ['research']);
  assert.deepEqual(PHASE_GRAPH.research, ['spec']);
  assert.deepEqual(PHASE_GRAPH.spec, ['plan']);
  assert.deepEqual(PHASE_GRAPH.implement, ['test']);
  assert.throws(() => advancePhase({state:{current_phase:'research'}, from:'research', to:'test'}),
    /phase-transition/);
});

test('research to plan requires fresh mandatory spec approval', () => {
  assert.throws(() => advancePhase({state:{current_phase:'research',spec_policy_required:true,
    subphase:'spec'},from:'research',to:'plan',at:'2026-07-22T00:00:00Z'}),
  /spec-approval-required/);
  assert.throws(() => advancePhase({state:{current_phase:'research',spec_policy_required:true,
    subphase:'spec',spec_approved_hash:'a'.repeat(64),spec_current_sha256:'b'.repeat(64),
    spec_contract_json:'{}',spec_gate_result_json:'{"pass":true}'},from:'research',to:'plan',
  at:'2026-07-22T00:00:00Z'}), /spec-approval-stale/);
});

test('spec is an explicit phase and legacy research subphase remains readable', () => {
  const entered=enterSpecSubphase({state:{current_phase:'research',research_completed_at:'2026-07-21T00:00:00Z',
    research_approved:{artifact_sha256:'c'.repeat(64)}},at:'2026-07-22T00:00:00Z'});
  assert.equal(entered.current_phase,'spec');assert.equal(entered.subphase,null);
  assert.equal(entered.spec_policy_required,true);assert.equal(entered.research_completed_at,'2026-07-21T00:00:00Z');
  const contract={schema_version:1,spec_id:'SPEC-PHASE',risk_class:'medium',requirements:[{id:'REQ-001',
    statement:'Require spec approval',acceptance:'Plan admission succeeds only after approval',priority:'must',
    negative_test_ids:['NEG-001'],evidence_gate_ids:['GATE-negative-tests']}],invariants:[{id:'INV-001',
    statement:'Research is not rerun',requirement_ids:['REQ-001']}],failure_matrix:[],negative_tests:[{id:'NEG-001',
    statement:'Attempt stale admission',requirement_ids:['REQ-001'],failure_mode_ids:[],
    expected_signal:'spec-approval-stale',gate_id:'GATE-negative-tests'}],compatibility:{legacy_inputs:'reject fresh',
    migration:'run deep-spec'},open_questions:[]};
  const specSha256=specContractDigest(contract);const approvedHash='a'.repeat(64);
  const approvalOperationId=`op-${'9'.repeat(64)}`;
  const approved=approveSpecSubphase({state:entered,specApprovedHash:approvedHash,specContract:contract,
    specGateResult:{schema_version:1,pass:true,spec_id:'SPEC-PHASE',spec_sha256:specSha256,risk_class:'medium',
      errors:[],warnings:[],requirement_coverage:{contract:{ratio:1},execution:null},
      failure_matrix_coverage:{contract:{ratio:null},execution:null}},
    approvalOperationId,at:'2026-07-22T00:01:00Z'});
  assert.equal(approved.spec_approval_operation_id,approvalOperationId);
  const advanced=advancePhase({state:{...approved,spec_current_sha256:approvedHash},from:'spec',to:'plan',
    at:'2026-07-22T00:02:00Z'});
  assert.equal(advanced.current_phase,'plan');assert.equal(advanced.subphase,null);
  assert.equal(advanced.research_completed_at,'2026-07-21T00:00:00Z');

  const legacy={...entered,current_phase:'research',subphase:'spec'};
  const legacyApproved=approveSpecSubphase({state:legacy,specApprovedHash:approvedHash,
    specContract:contract,specGateResult:{schema_version:1,pass:true,
      spec_id:'SPEC-PHASE',spec_sha256:specSha256,risk_class:'medium',
      errors:[],warnings:[],requirement_coverage:{contract:{ratio:1},execution:null},
      failure_matrix_coverage:{contract:{ratio:null},execution:null}},
    at:'2026-07-22T00:01:00Z'});
  assert.equal(advancePhase({state:{...legacyApproved,spec_current_sha256:approvedHash},
    from:'research',to:'plan',at:'2026-07-22T00:02:00Z'}).current_phase,'plan');
});

test('plan approval compiles and stores one exact authoritative verification plan',()=>{
  const specContract={schema_version:1,spec_id:'SPEC-APPROVAL',risk_class:'medium',requirements:[{id:'REQ-001'}],
    failure_matrix:[]};const specSha256='a'.repeat(64),specApprovedHash='b'.repeat(64),riskProfileSha256='c'.repeat(64);
  const planProjection={schema_version:1,contract_binding:{mode:'strict-spec',created_by_version:'6.13.0',
    source_plan_sha256:'d'.repeat(64),risk_profile_sha256:riskProfileSha256,spec_contract:{spec_id:specContract.spec_id,
      spec_sha256:specSha256,spec_approved_hash:specApprovedHash}},slices:[]};const planProjectionSha256=sha256(canonicalJson(planProjection));
  const state={current_phase:'plan',spec_policy_required:true,spec_approved_hash:specApprovedHash,
    risk_profile_sha256:riskProfileSha256};const compilerInput={riskProfile:{class:'medium'},riskProfileSha256,
    policySnapshot:{risk_class:'medium',profile:'standard',verification_policy:{recommended:'표준 검증'}},
    specContract,specSha256,specApprovedHash,planProjection,capabilities:{},
    compatibilityFacts:{created_by_version:'6.13.0',spec_policy_required:true}};
  const next=approvePhase({state,phase:'plan',artifactSha256:'d'.repeat(64),sourcePlanSha256:'d'.repeat(64),
    planProjectionSha256,verificationCompilerInput:compilerInput,planSpecGateResult:{pass:true,spec_id:specContract.spec_id,
      spec_sha256:specSha256,spec_approved_hash:specApprovedHash,risk_profile_sha256:riskProfileSha256,
      requirement_coverage:{execution:{ratio:1}},failure_matrix_coverage:{execution:{ratio:null}}},
    at:'2026-07-22T00:02:00Z'});
  const stored=JSON.parse(next.verification_plan_json);assert.equal(stored.plan_projection_sha256,planProjectionSha256);
  assert.equal(next.verification_plan_sha256,stored.plan_sha256);assert.equal(next.plan_approved.artifact_sha256,'d'.repeat(64));
});

test('fresh v6.13 Low plan approval also compiles the minimal authoritative verification plan',()=>{
  const specContract={schema_version:1,spec_id:'SPEC-LOW-APPROVAL',risk_class:'low',requirements:[{id:'REQ-001'}],
    failure_matrix:[]},specSha256='a'.repeat(64),specApprovedHash='b'.repeat(64),riskProfileSha256='c'.repeat(64),
    planProjection={schema_version:1,contract_binding:{mode:'strict-spec',created_by_version:'6.13.0',
      source_plan_sha256:'d'.repeat(64),risk_profile_sha256:riskProfileSha256,spec_contract:{spec_id:specContract.spec_id,
        spec_sha256:specSha256,spec_approved_hash:specApprovedHash}},slices:[]},planProjectionSha256=sha256(canonicalJson(planProjection)),
    state={current_phase:'plan',created_by_version:'6.13.0',spec_policy_required:false,spec_approved_hash:specApprovedHash,
      risk_profile_sha256:riskProfileSha256},compilerInput={riskProfile:{class:'low'},riskProfileSha256,
      policySnapshot:{risk_class:'low',profile:'lean',verification_policy:{recommended:'최소 검증 (기록 전용)'}},
      specContract,specSha256,specApprovedHash,planProjection,capabilities:{},
      compatibilityFacts:{created_by_version:'6.13.0',spec_policy_required:false}};
  const next=approvePhase({state,phase:'plan',artifactSha256:'d'.repeat(64),sourcePlanSha256:'d'.repeat(64),
    planProjectionSha256,verificationCompilerInput:compilerInput,planSpecGateResult:{pass:true,spec_id:specContract.spec_id,
      spec_sha256:specSha256,spec_approved_hash:specApprovedHash,risk_profile_sha256:riskProfileSha256,
      requirement_coverage:{execution:{ratio:1}},failure_matrix_coverage:{execution:{ratio:null}}},at:'2026-07-22T00:02:00Z'});
  const stored=JSON.parse(next.verification_plan_json);assert.equal(stored.risk_class,'low');assert.equal(stored.profile,'lean');
  assert.equal(next.verification_plan_sha256,stored.plan_sha256);
});

test('risk-only escalation clears prior authority and records every receipt invalidation', () => {
  const state={current_phase:'implement',subphase:null,spec_policy_required:true,
    spec_approved_hash:'a'.repeat(64),plan_approved:{artifact_sha256:'b'.repeat(64)},
    plan_projection_sha256:'c'.repeat(64),plan_source_sha256:'d'.repeat(64),
    plan_spec_gate_result_json:'{"pass":true}',verification_plan_json:'{"schema_version":1}',
    verification_plan_sha256:'e'.repeat(64),verification_consumptions_json:'{"op-old":{"sliceId":"SLICE-001"}}',
    test_passed:true,evidence_summary_json:'{"complete":true}',risk_profile_sha256:'f'.repeat(64),
    slice_receipts_json:JSON.stringify({'SLICE-002':{receipt_sha256:'2'.repeat(64),plan_sha256:'c'.repeat(64),
      risk_profile_sha256:'f'.repeat(64)},'SLICE-001':{receipt_sha256:'1'.repeat(64),plan_sha256:'c'.repeat(64),
      risk_profile_sha256:'f'.repeat(64)}})};
  const transition=phaseRuntime.invalidateForReplan||((args)=>phaseRuntime.rerunPhase({state:args.state,phase:'plan'}));
  const next=transition({state,reason:'risk-class-increase',fromRisk:'medium',toRisk:'high',
    affectedSliceIds:['SLICE-002','SLICE-001'],riskProfileSha256:'9'.repeat(64),at:'2026-07-22T00:03:00Z'});
  assert.equal(next.current_phase,'spec');assert.equal(next.subphase,null);assert.equal(next.replan_required,true);
  assert.equal(next.plan_approved,null);assert.equal(next.verification_plan_json,null);
  assert.equal(next.verification_consumptions_json,'{}');assert.equal(next.test_passed,false);
  assert.equal(next.evidence_summary_json,null);assert.equal(next.spec_approved_hash,null);
  const invalidations=JSON.parse(next.receipt_invalidations_json);
  assert.deepEqual(invalidations.map((row)=>row.slice_id),['SLICE-001','SLICE-002']);
  assert.deepEqual(invalidations.map((row)=>row.receipt_sha256),['1'.repeat(64),'2'.repeat(64)]);
  assert.ok(invalidations.every((row)=>row.prior_plan_sha256==='c'.repeat(64)&&
    row.prior_risk_profile_sha256==='f'.repeat(64)));
  assert.ok(invalidations.every((row)=>!Object.hasOwn(row,'package_sha256')&&
    !Object.hasOwn(row,'verification_plan_sha256')&&!Object.hasOwn(row,'risk_profile_sha256')));
});

test('TDD transition table rejects proofless RED and invalid refactor completion', async () => {
  await assert.rejects(() => transitionSliceTdd({state:{tdd_state:'PENDING'}, to:'RED_VERIFIED'}),
    /verification-required/);
  await assert.rejects(() => transitionSliceTdd({state:{tdd_state:'REFACTOR_PENDING'},
    to:'SENSOR_CLEAN'}), /tdd-transition/);
});

test('debug completion atomically publishes collision-free note receipt and state',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-debug-complete-'));fs.mkdirSync(path.join(root,'.git'));
  fs.mkdirSync(path.join(root,'.claude'));const work=path.join(root,'.deep-work','s-bbbbbbbb'),receipts=path.join(work,'receipts');
  fs.mkdirSync(receipts,{recursive:true});const statePath=path.join(root,'.claude','deep-work.s-bbbbbbbb.md');fs.writeFileSync(statePath,
    '---\nsession_id: s-bbbbbbbb\nwork_dir: .deep-work/s-bbbbbbbb\ncurrent_phase: implement\ndebug_active: true\ndebug_slice: SLICE-001\n---\n');
  fs.writeFileSync(path.join(receipts,'SLICE-001.json'),'{"slice_id":"SLICE-001","status":"in_progress","debug":{}}\n');
  const note=path.join(work,'root-cause-input.md');fs.writeFileSync(note,'# Root cause\n\nExact diagnosis.\n');const args=()=>{
    const stateCapability=platform.issueProjectStateCapability(root,statePath,{role:'session-state'});const sessionCapability=
      platform.issueProjectStateCapability(root,work,{role:'session-work-dir',sessionStateCapability:stateCapability});return{stateCapability,
      receiptsDirCapability:Object.freeze({kind:'receipts-directory',role:'receipts-directory',path:receipts,sessionCapability,projectRoot:root}),
      sliceId:'SLICE-001',noteFile:note,verification:{accepted:true}};};for(const target of ['after-note-write-before-stage',
    'after-receipt-write-before-stage','after-state-write-before-stage'])await assert.rejects(()=>completeDebug({...args(),seam:(name)=>{
      if(name===target)throw new Error(target);}}),new RegExp(target));const result=await completeDebug(args());assert.equal(result.status,'completed');
  assert.equal(path.basename(result.notePath),'RC-001.md');assert.equal(fs.readFileSync(result.notePath,'utf8'),'# Root cause\n\nExact diagnosis.\n');
  const receipt=JSON.parse(fs.readFileSync(path.join(receipts,'SLICE-001.json'),'utf8'));assert.equal(receipt.debug.root_cause_note,
    'debug-log/RC-001.md');const fields=parseFrontmatter(fs.readFileSync(statePath,'utf8')).fields;assert.equal(fields.debug_active,false);
});

test('phase review atomically publishes exact files and state authority',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-phase-review-'));fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const work=path.join(root,'.deep-work','s-cccccccc');fs.mkdirSync(work,{recursive:true});const statePath=path.join(root,'.claude',
    'deep-work.s-cccccccc.md');fs.writeFileSync(statePath,'---\nsession_id: s-cccccccc\nwork_dir: .deep-work/s-cccccccc\n'+
    'current_phase: plan\nphase_review: "{}"\nplan_review_retries: 2\n---\n');const structural=path.join(work,'input-structural.json'),
    markdown=path.join(work,'input-structural.md'),adversarial=path.join(work,'input-adversarial.json');fs.writeFileSync(structural,
    '{"result":"APPROVE","issues":[]}\n');fs.writeFileSync(markdown,'# Plan review\n\nApproved.\n');fs.writeFileSync(adversarial,
    '{"result":"APPROVE","risks":[]}\n');const args=()=>({stateCapability:platform.issueProjectStateCapability(root,statePath,
      {role:'session-state'}),phase:'plan',structuralJsonFile:structural,structuralMdFile:markdown,adversarialJsonFile:adversarial});
  for(const target of ['after-json-write-before-stage','after-markdown-write-before-stage','after-adversarial-write-before-stage',
    'after-state-write-before-stage'])await assert.rejects(()=>recordPhaseReview({...args(),seam:(name)=>{if(name===target)
      throw new Error(target);}}),new RegExp(target));const result=await recordPhaseReview(args());assert.equal(result.status,'completed');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(work,'plan-review.json'),'utf8')),{issues:[],result:'APPROVE'});
  assert.equal(fs.readFileSync(path.join(work,'plan-review.md'),'utf8'),'# Plan review\n\nApproved.\n');assert.deepEqual(JSON.parse(
    fs.readFileSync(path.join(work,'adversarial-review.json'),'utf8')),{result:'APPROVE',risks:[]});const fields=
    parseFrontmatter(fs.readFileSync(statePath,'utf8')).fields;assert.equal(fields.plan_review_retries,0);assert.equal(JSON.parse(
      fields.phase_review).plan.result,'APPROVE');
});

function refactorFixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-refactor-'));
  execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['config','user.email','test@example.invalid'],{cwd:root});
  execFileSync('git',['config','user.name','Deep Work Test'],{cwd:root});fs.mkdirSync(path.join(root,'src'));
  fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'src','a.js'),'module.exports=1;\n');
  fs.writeFileSync(path.join(root,'tests','a.test.js'),'// test\n');
  const verifier=path.join(root,'verify.js');fs.writeFileSync(verifier,"require('./src/a.js'); process.stdout.write('ok\\n');\n");
  execFileSync('git',['add','-A'],{cwd:root});execFileSync('git',['commit','-qm','initial'],{cwd:root});
  fs.mkdirSync(path.join(root,'.claude'));const workDir=path.join(root,'.deep-work','s-aaaaaaaa');fs.mkdirSync(workDir,{recursive:true});
  const statePath=path.join(root,'.claude','deep-work.s-aaaaaaaa.md');fs.writeFileSync(statePath,
    '---\nsession_id: s-aaaaaaaa\nwork_dir: .deep-work/s-aaaaaaaa\ncurrent_phase: implement\nactive_slice: SLICE-001\ntdd_state: SENSOR_CLEAN\nfresh_sensor_required: false\n---\n');
  const stateCapability=platform.issueProjectStateCapability(root,statePath,{role:'session-state'});
  const sessionCapability=platform.issueProjectStateCapability(root,workDir,{role:'session-work-dir',sessionStateCapability:stateCapability});
  const planCapability=transaction.issueSessionFileCapability({sessionCapability,candidate:path.join(workDir,'plan.json'),
    allowedBasenames:['plan.json'],allowMissingLeaf:true,role:'locked-plan'});
  const spec={schema_version:1,executable:{kind:'node',value:'node'},args:['verify.js'],cwd_role:'active-worktree',
    timeout_ms:5000,max_output_bytes:4096};
  const plan={schema_version:1,slices:[{id:'SLICE-001',checked:false,scope_schema_version:1,
    files:['src/a.js','tests/a.test.js'],write_scope:{failing_test:['tests/a.test.js'],production:['src/a.js'],
      refactor:['src/a.js']},verification_spec:spec}]};fs.writeFileSync(planCapability.path,JSON.stringify(plan));
  return{root,statePath,stateCapability,sessionCapability,planCapability,plan,spec};}

test('refactor proof chain authenticates write, verification, contextual sensors, and crash adoption', async () => {
  const f=refactorFixture();const authority=deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',writeClass:'refactor'});
  const write=await beginScopedWrite({stateCapability:f.stateCapability,planCapability:f.planCapability,plan:f.plan,
    sliceId:'SLICE-001',writeClass:'refactor',expectedScopeSha256:authority.sha256});
  fs.writeFileSync(path.join(f.root,'src','a.js'),'module.exports = 1;\n');
  const accepted=await acceptScopedWrite({stateCapability:f.stateCapability,planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
    operationId:write.operationId,preManifestSha256:write.preManifestSha256});
  assert.equal(parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields.tdd_state,'REFACTOR_PENDING');
  const verification=await runVerification({stateCapability:f.stateCapability,planCapability:f.planCapability,
    plan:f.plan,sliceId:'SLICE-001',expectedOutcome:'must-pass',spec:f.spec,cwd:f.root});
  await assert.rejects(()=>transitionSliceTdd({stateCapability:f.stateCapability,planCapability:f.planCapability,
    plan:f.plan,sliceId:'SLICE-001',to:'GREEN',verificationResult:verification.result,
    verificationSha256:verification.resultSha256,verificationOperationId:verification.operationId,
    seam:(name)=>{if(name==='after-state-write-before-stage')throw new Error('kill-transition');}}),/kill-transition/);
  assert.equal(parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields.tdd_state,'GREEN');
  await transitionSliceTdd({stateCapability:f.stateCapability,planCapability:f.planCapability,plan:f.plan,
    sliceId:'SLICE-001',to:'GREEN',verificationResult:verification.result,
    verificationSha256:verification.resultSha256,verificationOperationId:verification.operationId});
  await assert.rejects(()=>transitionSliceTdd({stateCapability:f.stateCapability,planCapability:f.planCapability,
    plan:f.plan,sliceId:'SLICE-001',to:'GREEN',verificationResult:verification.result,
    verificationSha256:verification.resultSha256,verificationOperationId:verification.operationId}),
  /verification-result-replay|verification-write-state/);
  await transitionSliceTdd({stateCapability:f.stateCapability,planCapability:f.planCapability,plan:f.plan,
    sliceId:'SLICE-001',to:'SENSOR_RUN'});
  const context={sessionId:'s-aaaaaaaa',stateCapability:f.stateCapability,planCapability:f.planCapability,
    sliceId:'SLICE-001',afterWriteOperationId:accepted.operationId};
  const worker=path.resolve(__dirname,'..','tests','fixtures','verification-process-worker.js');
  const lint=await runSensor({kind:'lint',processSpec:{kind:'native-executable',executable:process.execPath,
    args:[worker,'pass']},parser:'generic-line',budgetMs:2000,projectCapability:
      platform.issueProjectStateCapability(f.root,f.root,{role:'project-root'}),refactorContext:context});
  const typecheck=await runSensor({kind:'typecheck',processSpec:{kind:'native-executable',executable:process.execPath,
    args:[worker,'pass']},parser:'generic-line',budgetMs:2000,projectCapability:
      platform.issueProjectStateCapability(f.root,f.root,{role:'project-root'}),refactorContext:context});
  const review=await runReviewCheck(platform.issueProjectStateCapability(f.root,f.root,{role:'project-root'}),{},context);
  const rows=[lint,typecheck,review].sort((a,b)=>Buffer.compare(Buffer.from(a.operationId),Buffer.from(b.operationId)));
  const digest=aggregateSensorResults(rows);
  await assert.rejects(()=>transitionSliceTdd({stateCapability:f.stateCapability,planCapability:f.planCapability,
    plan:f.plan,sliceId:'SLICE-001',to:'SENSOR_CLEAN',sensorOperationIds:rows.slice(0,2).map((row)=>row.operationId),
    sensorResultsSha256:aggregateSensorResults(rows.slice(0,2)),afterWriteOperationId:accepted.operationId}),
  /sensor-result-incomplete/);
  await assert.rejects(()=>transitionSliceTdd({stateCapability:f.stateCapability,planCapability:f.planCapability,
    plan:f.plan,sliceId:'SLICE-001',to:'SENSOR_CLEAN',sensorOperationIds:rows.map((row)=>row.operationId),
    sensorResultsSha256:digest,afterWriteOperationId:accepted.operationId,
    seam:(name)=>{if(name==='after-state-write-before-stage')throw new Error('kill-sensor-cycle');}}),/kill-sensor-cycle/);
  await transitionSliceTdd({stateCapability:f.stateCapability,planCapability:f.planCapability,plan:f.plan,
    sliceId:'SLICE-001',to:'SENSOR_CLEAN',sensorOperationIds:rows.map((row)=>row.operationId),
    sensorResultsSha256:digest,afterWriteOperationId:accepted.operationId});
  const final=parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields;
  assert.equal(final.tdd_state,'SENSOR_CLEAN');assert.equal(final.fresh_sensor_required,false);
  assert.match(final.sensor_cycle_operation_id,/^op-/);assert.equal(final.sensor_results_sha256,digest);
  const freshState=platform.issueProjectStateCapability(f.root,f.statePath,{role:'session-state'});
  const freshSession=platform.issueProjectStateCapability(f.root,f.sessionCapability.path,
    {role:'session-work-dir',sessionStateCapability:freshState});
  const freshPlan=transaction.issueSessionFileCapability({sessionCapability:freshSession,candidate:f.planCapability.path,
    allowedBasenames:['plan.json'],role:'locked-plan'});
  const receiptsDir=path.join(freshSession.path,'receipts');fs.mkdirSync(receiptsDir);
  const receiptsDirCapability=Object.freeze({kind:'receipts-directory',role:'receipts-directory',path:receiptsDir,
    sessionCapability:freshSession,projectRoot:f.root});const authored={slice_id:'SLICE-001',status:'complete',
    tdd_state:'SENSOR_CLEAN',sensor_results_sha256:digest};
  const temp=await artifact.createOwnedTemp({sessionCapability:freshSession,purpose:'receipt-payload'});
  await artifact.writeOwnedTemp({sessionCapability:freshSession,operationId:temp.operationId,
    purpose:'receipt-payload'},Buffer.from(JSON.stringify(authored)));
  const completionArgs={stateCapability:freshState,planCapability:freshPlan,plan:f.plan,
    receiptsDirCapability,sliceId:'SLICE-001',receiptTemp:{sourceOperationId:temp.operationId,
      purpose:'receipt-payload',sessionCapability:freshSession}};
  await assert.rejects(()=>completeSlice({...completionArgs,seam:(name)=>{if(name==='after-receipt-write')
    throw new Error('kill-slice-receipt');}}),/kill-slice-receipt/);
  const completed=await completeSlice({...completionArgs,stateCapability:
    platform.issueProjectStateCapability(f.root,f.statePath,{role:'session-state'})});
  assert.equal(completed.status,'complete');assert.equal(JSON.parse(fs.readFileSync(freshPlan.path,'utf8')).slices[0].checked,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(receiptsDir,'SLICE-001.json'),'utf8')).slice_id,'SLICE-001');
  const completedState=parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields;
  assert.equal(completedState.active_slice,null);assert.equal(completedState.tdd_state,'PENDING');
});
