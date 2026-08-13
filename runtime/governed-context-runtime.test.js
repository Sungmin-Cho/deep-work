'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const platform=require('./platform.js');
const frontmatter=require('./frontmatter.js');
const journal=require('./operation-journal.js');
const transaction=require('./transaction-runtime.js');
const {compileImmutablePlanAuthorityV2}=require('./plan-runtime.js');
const {compileVerificationPlan}=require('./verification-policy-runtime.js');
const {semanticDigest}=require('./release-gate-runtime.js');
const {buildProgressProjectionV1,selectGovernedAdmission,loadGovernedContext,
  validateSessionAuthority,deriveAdmissionSatisfiedGateIds,receiptProjection}=
  require('./governed-context-runtime.js');
const reportRuntime=require('./report-runtime.js');
const releaseRuntime=require('./release-gate-runtime.js');
const functionalRuntime=require('./functional-receipt-runtime.js');

const empty={evidence:{status:'unknown',required_ids:[],completed_ids:[],missing_ids:[],
  invalidated_ids:[]},residual_risk:{status:'unknown',class:null,accepted:null,
  blocking_reasons:[]},replan:{status:'none',epoch:null,reason:null,trigger_id:null},
invalidations:[],findings:{status:'unknown',points:[]},receipts:{status:'unknown',rows:[]},
required_gate_ids:[],satisfied_gate_ids:[],warnings:['projection-input-missing']};

test('evidence admission pseudo-gates require their exact positive predicates',()=>{
  const base=['GATE-targeted-tests'];
  assert.deepEqual(deriveAdmissionSatisfiedGateIds({complete:true,
    redaction:{passed:true}},base),[
    'GATE-evidence-completeness','GATE-redaction','GATE-targeted-tests']);
  assert.deepEqual(deriveAdmissionSatisfiedGateIds({complete:false,
    redaction:{passed:false}},base,{humanAckSatisfied:true}),[
    'GATE-human-ack','GATE-targeted-tests']);
  assert.deepEqual(deriveAdmissionSatisfiedGateIds({complete:true,
    redaction:{passed:true}},[],{humanAckSatisfied:false}),[
    'GATE-evidence-completeness','GATE-redaction']);
  assert.deepEqual(deriveAdmissionSatisfiedGateIds({complete:true,
    redaction:{passed:true}},[],{humanAckSatisfied:true}),[
    'GATE-evidence-completeness','GATE-human-ack','GATE-redaction']);
});

test('receipt projection classifies authenticated release invalidation as incomplete',
  (t)=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
      'dw-governed-invalidation-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
    const sessionId='s-aaaaaaaa',work=path.join(root,'.deep-work',sessionId),
      receipts=path.join(work,'receipts');fs.mkdirSync(receipts,{recursive:true});
    const statePath=path.join(root,'.claude',`deep-work.${sessionId}.md`);
    fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',{
      session_id:sessionId,work_dir:`.deep-work/${sessionId}`,current_phase:'test',
      verification_plan_sha256:'2'.repeat(64)}));
    const stateCapability=platform.issueProjectStateCapability(root,statePath,
      {role:'session-state'});
    const receipt={schema_version:1,slice_id:'SLICE-001',
      plan_authority_sha256:'1'.repeat(64),verification_plan_sha256:'2'.repeat(64),
      gate_results:[{gate_id:'GATE-full-relevant-suite',
        operation_id:`op-${'3'.repeat(64)}`,
        result_path:`.deep-work/${sessionId}/gate-results/op-${'3'.repeat(64)}.json`,
        result_sha256:'4'.repeat(64),ledger_result_sha256:'5'.repeat(64),
        checker_id:'command-v1',argv_sha256:releaseRuntime.argvSha256(['npm','test'])}],
      functional_receipts:[],completion_operation_id:`op-${'6'.repeat(64)}`,
      receipt_sha256:null};
    receipt.receipt_sha256=journal.sha256(journal.canonicalJson(
      Object.fromEntries(Object.entries(receipt).filter(([key])=>
        key!=='receipt_sha256'))));
    fs.writeFileSync(path.join(receipts,'SLICE-001.json'),journal.canonicalJson({
      ...receipt,status:'invalidated'}));
    const projection=receiptProjection(work,{slices:[{id:'SLICE-001',
      slice_kind:'release-verification',checked:false}]},false,stateCapability,
      {verification_plan_sha256:'2'.repeat(64)});
    assert.deepEqual(projection.rows,[{slice_id:'SLICE-001',
      slice_kind:'release-verification',status:'invalidated',
      receipt_sha256:receipt.receipt_sha256}]);
    assert.equal(projection.status,'incomplete');
  });

test('release projection rejects a stale embedded functional receipt',async(t)=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    'dw-governed-functional-dependency-')));t.after(()=>fs.rmSync(root,
    {recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const sessionId='s-aaaaaaaa',work=path.join(root,'.deep-work',sessionId),
    receipts=path.join(work,'receipts');fs.mkdirSync(receipts,{recursive:true});
  const statePath=path.join(root,'.claude',`deep-work.${sessionId}.md`);
  const stateFields={session_id:sessionId,work_dir:`.deep-work/${sessionId}`,
    current_phase:'test',verification_plan_sha256:'9'.repeat(64)};
  fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',stateFields));
  const stateCapability=platform.issueProjectStateCapability(root,statePath,
    {role:'session-state'});fs.writeFileSync(statePath,
    frontmatter.updateFrontmatterText('',stateFields));
  const op=(char)=>`op-${char.repeat(64)}`;
  const verificationRef=(char)=>({operation_id:op(char),result_path:
    `.claude/deep-work.${sessionId}.verification.${op(char)}.json`,
    result_sha256:char.repeat(64),ledger_result_sha256:
      ((Number.parseInt(char,16)+1)%16).toString(16).repeat(64)});
  const refactor={kind:'no-refactor',decision_operation_id:op('1'),
    reason_code:'no-duplication',post_decision_green:verificationRef('2'),
    sensor_results:[{kind:'lint',operation_id:op('3'),result_path:
      `.claude/deep-work.${sessionId}.sensor.${op('3')}.json`,
      result_sha256:'4'.repeat(64),ledger_result_sha256:'5'.repeat(64)}],
    decision_sha256:null};
  refactor.decision_sha256=functionalRuntime.semanticDigest(
    'refactor-evidence-v1',refactor,'decision_sha256');
  const functional=functionalRuntime.buildFunctionalSliceReceiptV2({
    session_id:sessionId,slice_id:'SLICE-001',plan_authority_sha256:'8'.repeat(64),
    verification_plan_sha256:'9'.repeat(64),red_proof_ref:
      `.deep-work/${sessionId}/red-proofs/${'a'.repeat(64)}.json`,
    red_proof_sha256:'a'.repeat(64),red_proof_operation_id:op('6'),
    green_verification:verificationRef('7'),refactor_evidence:refactor});
  const gateRef={gate_id:'GATE-full-relevant-suite',operation_id:op('b'),
    result_path:`.deep-work/${sessionId}/gate-results/${op('b')}.json`,
    result_sha256:'c'.repeat(64),ledger_result_sha256:'d'.repeat(64),
    checker_id:'command-v1',argv_sha256:'e'.repeat(64)};
  const release={schema_version:1,slice_id:'SLICE-002',
    plan_authority_sha256:'8'.repeat(64),verification_plan_sha256:'9'.repeat(64),
    gate_results:[gateRef],functional_receipts:[{slice_id:'SLICE-001',
      receipt_sha256:functional.receipt_sha256,
      completion_operation_id:functional.completion_operation_id}],
    completion_operation_id:op('f'),receipt_sha256:null};
  release.receipt_sha256=journal.sha256(journal.canonicalJson(
    Object.fromEntries(Object.entries(release).filter(([key])=>
      key!=='receipt_sha256'))));
  stateFields.release_verification_operation_id=release.completion_operation_id;
  stateFields.release_verification_receipt_sha256=release.receipt_sha256;
  fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',stateFields));
  const plan={schema_version:2,plan_authority_sha256:'8'.repeat(64),slices:[
    {id:'SLICE-001',slice_kind:'functional',checked:true},
    {id:'SLICE-002',slice_kind:'release-verification',checked:true}]};
  fs.writeFileSync(path.join(work,'plan.json'),journal.canonicalJson(plan));
  fs.writeFileSync(path.join(receipts,'SLICE-001.json'),
    journal.canonicalJson(functional));
  fs.writeFileSync(path.join(receipts,'SLICE-002.json'),
    journal.canonicalJson(release));
  const project=transaction.projectCapabilityFor(stateCapability);
  const functionalOperation=await journal.beginOperation({projectCapability:project,
    sessionId,kind:'functional-slice-complete-v2',operationId:
      functional.completion_operation_id,slice:'SLICE-001'});
  await journal.completeOperation(functionalOperation,{session_id:sessionId,
    slice_id:'SLICE-001',receipt_path:`.deep-work/${sessionId}/receipts/SLICE-001.json`,
    receipt_sha256:functional.receipt_sha256,post_state_sha256:'1'.repeat(64)});
  const releaseOperation=await journal.beginOperation({projectCapability:project,
    sessionId,kind:'release-verification-complete',operationId:release.completion_operation_id});
  await journal.completeOperation(releaseOperation,{slice_id:'SLICE-002',
    receipt_path:`.deep-work/${sessionId}/receipts/SLICE-002.json`,
    receipt_sha256:release.receipt_sha256,post_state_sha256:'2'.repeat(64)});
  let projection=receiptProjection(work,plan,false,stateCapability,stateFields);
  assert.equal(projection.rows.find((row)=>row.slice_id==='SLICE-002').status,'complete',
    JSON.stringify(projection));
  fs.writeFileSync(path.join(receipts,'SLICE-001.json'),journal.canonicalJson({
    ...functional,status:'invalidated'}));
  projection=receiptProjection(work,plan,false,stateCapability,stateFields);
  assert.equal(projection.rows.find((row)=>row.slice_id==='SLICE-001').status,'invalidated');
  assert.equal(projection.rows.find((row)=>row.slice_id==='SLICE-002').status,'unknown');
  assert.equal(projection.status,'unknown');
});

test('no-plan projection has exact defaults and only compatibility plus gate blockers',()=>{
  const built=buildProgressProjectionV1({...empty,plan_identity:{status:'missing',
    plan_authority_sha256:null,verification_plan_sha256:null}});
  assert.deepEqual(built.projection.admissions.map((row)=>row.enforcement_point),
    ['finish-finalize','finish-pre-action','test']);
  for(const row of built.projection.admissions)
    assert.deepEqual(row.blocking_codes,['compatibility-context-missing','gate-missing']);
  assert.equal(selectGovernedAdmission(built.projection,'test').allowed,false);
});

test('active invalidation yields byte-identical authority blockers at every consumer',()=>{
  const invalidation={scope:'session-plan',session_id:'s-aaaaaaaa',
    prior_plan_authority_sha256:'1'.repeat(64),trigger_id:'2'.repeat(64),
    invalidation_sha256:'3'.repeat(64)};
  const built=buildProgressProjectionV1({...empty,plan_identity:{status:'invalidated',
    plan_authority_sha256:null,verification_plan_sha256:null},
  replan:{status:'active',epoch:'4'.repeat(64),reason:'test-side-effect',
    trigger_id:'2'.repeat(64)},invalidations:[invalidation],
  warnings:['invalidation-active']});
  for(const row of built.projection.admissions){
    assert.deepEqual(row.blocking_codes,['authority-invalidated','replan-active']);
  }
});

test('an approved plan without a verification plan has the exact two blockers',()=>{
  const built=buildProgressProjectionV1({...empty,plan_identity:{status:'current',
    plan_authority_sha256:'1'.repeat(64),verification_plan_sha256:null}});
  for(const row of built.projection.admissions)
    assert.deepEqual(row.blocking_codes,['evidence-missing','gate-missing']);
});

test('only finish admissions add a missing Critical human acknowledgment',()=>{
  const common={...empty,plan_identity:{status:'current',
    plan_authority_sha256:'1'.repeat(64),verification_plan_sha256:'2'.repeat(64)},
  evidence:{status:'complete',required_ids:[],completed_ids:[],missing_ids:[],
    invalidated_ids:[]},residual_risk:{status:'accepted',class:'critical',accepted:true,
    blocking_reasons:[]},findings:{status:'complete',points:[]},
  receipts:{status:'complete',rows:[]},warnings:[],human_ack_required:true,
  human_ack_satisfied:false};
  const projection=buildProgressProjectionV1(common).projection;
  assert.deepEqual(selectGovernedAdmission(projection,'test').blocking_codes,[]);
  assert.deepEqual(selectGovernedAdmission(projection,'finish-pre-action').blocking_codes,
    ['human-ack-missing']);
  assert.deepEqual(selectGovernedAdmission(projection,'finish-finalize').blocking_codes,
    ['human-ack-missing']);
});

test('every non-complete receipt projection blocks test and finish admissions',()=>{
  const projection=buildProgressProjectionV1({...empty,
    plan_identity:{status:'current',plan_authority_sha256:'1'.repeat(64),
      verification_plan_sha256:'2'.repeat(64)},
    evidence:{status:'complete',required_ids:[],completed_ids:[],missing_ids:[],
      invalidated_ids:[]},residual_risk:{status:'accepted',class:'medium',accepted:true,
      blocking_reasons:[]},findings:{status:'complete',points:[]},
    receipts:{status:'incomplete',rows:[{slice_id:'SLICE-001',
      slice_kind:'functional',status:'invalidated',receipt_sha256:'3'.repeat(64)}]},
    required_gate_ids:[],satisfied_gate_ids:[],warnings:[]}).projection;
  for(const point of ['test','finish-pre-action','finish-finalize']){
    const admission=selectGovernedAdmission(projection,point);
    assert.equal(admission.allowed,false);
    assert.deepEqual(admission.blocking_codes,['receipt-invalid']);
  }
});

test('the governed loader emits the same no-plan bytes consumed by all readers',(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-governed-context-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.claude'));fs.mkdirSync(path.join(root,'.deep-work',
    's-aaaaaaaa'),{recursive:true});
  const state=path.join(root,'.claude','deep-work.s-aaaaaaaa.md');
  fs.writeFileSync(state,frontmatter.updateFrontmatterText('',{
    session_id:'s-aaaaaaaa',work_dir:'.deep-work/s-aaaaaaaa',
    current_phase:'research'}));
  const stateCapability=platform.issueProjectStateCapability(root,state,{
    role:'session-state'});
  const loaded=loadGovernedContext({stateCapability});
  assert.equal(loaded.projection.plan_identity.status,'missing');
  for(const point of ['test','finish-pre-action','finish-finalize'])
    assert.deepEqual(selectGovernedAdmission(loaded.projection,point).blocking_codes,
      ['compatibility-context-missing','gate-missing']);
  assert.equal(loaded.bytes.toString('utf8').endsWith('\n'),true);
});

test('the governed loader derives finish locks from the review execution carrier',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-governed-review-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.claude'));const sessionId='s-aaaaaaaa';
  const work=path.join(root,'.deep-work',sessionId);
  fs.mkdirSync(work,{recursive:true});
  const riskSha='4'.repeat(64),specContract={schema_version:1,
    spec_id:'SPEC-GOVERNED',risk_class:'critical',
    requirements:[{id:'REQ-001',
      evidence_gate_ids:['GATE-backward-compat','GATE-migration-dry-run']}],
    failure_modes:[],compatibility:{legacy_inputs:'covered',migration:'covered'}};
  const specText=`# Executable Spec: Governed
## Scope
x
## Non-goals
x
## Contract
\`\`\`json spec-contract
${JSON.stringify(specContract)}
\`\`\`
## Requirement Notes
x
## Failure and Recovery Notes
x
## Decisions and Trade-offs
x
## Open Questions
x
## Spec Gate Result
x
`,approved=journal.sha256(Buffer.from(specText)),specSha=
    require('./contract-runtime.js').specContractDigest(specContract);
  const facts={schema_version:1,authority:'reviewed-plan',destructive:false,
    external_action:false,has_backward_compat:true,has_migration:true,
    host_dependent:false,source_requirement_ids:['REQ-001'],
    source_slice_ids:['SLICE-001']};
  facts.facts_sha256=semanticDigest('capability-facts-v1',facts);
  const plan={schema_version:2,replan_epoch:null,contract_binding:{
    mode:'strict-spec',created_by_version:'7.0.0',
    source_plan_sha256:'3'.repeat(64),risk_profile_sha256:riskSha,
    spec_contract:{schema_version:1,spec_id:'SPEC-GOVERNED',
      spec_sha256:specSha,spec_approved_hash:approved}},
  capability_facts:facts,slices:[{id:'SLICE-001',
    slice_kind:'release-verification',checked:false,scope_schema_version:1,
    files:[],write_scope:{failing_test:[],production:[],refactor:[]},
    verification_scope:['npm test'],release_gate_ids:['GATE-human-ack'],
    verification_spec:null,verification_spec_sha256:null}]};
  plan.plan_authority_sha256=
    compileImmutablePlanAuthorityV2(plan).plan_authority_sha256;
  const verificationPlan=compileVerificationPlan({
    riskProfile:{class:'critical',score:8,triggers:[]},
    riskProfileSha256:riskSha,policySnapshot:
      require('./policy-runtime.js').compileMethodologyAuthority({
        riskProfile:{class:'critical'},difficulty:'high',mode:'adaptive'}),
    specContract,
    specSha256:specSha,specApprovedHash:approved,planProjection:plan,
    capabilities:{},compatibilityFacts:{created_by_version:'6.14.0',
      spec_policy_required:true,created_by_version:'7.0.0'}});
  fs.writeFileSync(path.join(work,'spec.md'),specText);
  fs.writeFileSync(path.join(work,'plan.json'),journal.canonicalJson(plan));
  const statePath=path.join(root,'.claude',`deep-work.${sessionId}.md`);
  const review={external_change_lock:true,points:{final:{
    risk_class:'critical',human_ack:null}}};
  fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',{
    session_id:sessionId,work_dir:`.deep-work/${sessionId}`,
    current_phase:'test',verification_plan_sha256:verificationPlan.plan_sha256,
    verification_plan_json:JSON.stringify(verificationPlan),
    methodology_policy_json:JSON.stringify(require('./policy-runtime.js')
      .compileMethodologyAuthority({riskProfile:{class:'critical'},
        difficulty:'high',mode:'adaptive'})),
    review_execution_json:JSON.stringify(review)}));
  const stateCapability=platform.issueProjectStateCapability(root,statePath,{
    role:'session-state'});
  assert.equal(validateSessionAuthority({stateCapability}).status,'current');
  const evidenceRuntime=require('./evidence-runtime.js');
  const originalLoadCommittedPackage=evidenceRuntime.loadCommittedPackage;
  const originalEvaluateEvidenceCompleteness=evidenceRuntime.evaluateEvidenceCompleteness;
  evidenceRuntime.loadCommittedPackage=()=>({schema_version:2});
  evidenceRuntime.evaluateEvidenceCompleteness=()=>({complete:true,
    redaction:{passed:true},satisfied_gate_ids:verificationPlan.evidence_required_gate_ids,
    missing_gate_ids:[],unverified_areas:[]});
  t.after(()=>{
    evidenceRuntime.loadCommittedPackage=originalLoadCommittedPackage;
    evidenceRuntime.evaluateEvidenceCompleteness=originalEvaluateEvidenceCompleteness;
  });
  const completeEvidenceProjection=loadGovernedContext({stateCapability}).projection;
  const testAdmission=selectGovernedAdmission(completeEvidenceProjection,'test');
  assert.equal(testAdmission.required_gate_ids.includes('GATE-evidence-completeness'),true);
  assert.equal(testAdmission.required_gate_ids.includes('GATE-redaction'),true);
  assert.equal(testAdmission.satisfied_gate_ids.includes('GATE-evidence-completeness'),true);
  assert.equal(testAdmission.satisfied_gate_ids.includes('GATE-redaction'),true);
  let admission=selectGovernedAdmission(
    loadGovernedContext({stateCapability}).projection,'finish-finalize');
  assert.equal(admission.blocking_codes.includes('human-ack-missing'),true);
  assert.equal(admission.blocking_codes.includes('external-change-lock'),true);
  review.external_change_lock=false;
  review.points.final.human_ack={required:true,
    at:'2026-07-27T00:00:00.000Z',actor:'human'};
  fs.writeFileSync(statePath,frontmatter.updateFrontmatterText(
    fs.readFileSync(statePath,'utf8'),{
      review_execution_json:JSON.stringify(review)}));
  admission=selectGovernedAdmission(
    loadGovernedContext({stateCapability}).projection,'finish-finalize');
  assert.equal(admission.blocking_codes.includes('human-ack-missing'),false);
  assert.equal(admission.blocking_codes.includes('external-change-lock'),false);
  assert.equal(admission.blocking_codes.includes('gate-missing'),false);
  assert.equal(admission.satisfied_gate_ids.includes('GATE-human-ack'),true);
  const invalidatedRelease={schema_version:1,slice_id:'SLICE-001',
    plan_authority_sha256:plan.plan_authority_sha256,
    verification_plan_sha256:verificationPlan.plan_sha256,
    gate_results:[{gate_id:'GATE-full-relevant-suite',
      operation_id:`op-${'3'.repeat(64)}`,
      result_path:`.deep-work/${sessionId}/gate-results/op-${'3'.repeat(64)}.json`,
      result_sha256:'4'.repeat(64),ledger_result_sha256:'5'.repeat(64),
      checker_id:'command-v1',argv_sha256:releaseRuntime.argvSha256(['npm','test'])}],
    functional_receipts:[],completion_operation_id:`op-${'6'.repeat(64)}`,
    receipt_sha256:null};
  invalidatedRelease.receipt_sha256=journal.sha256(journal.canonicalJson(
    Object.fromEntries(Object.entries(invalidatedRelease).filter(([key])=>
      key!=='receipt_sha256'))));
  fs.mkdirSync(path.join(work,'receipts'),{recursive:true});
  fs.writeFileSync(path.join(work,'receipts','SLICE-001.json'),journal.canonicalJson({
    ...invalidatedRelease,status:'invalidated'}));
  const invalidatedProjection=loadGovernedContext({stateCapability}).projection;
  assert.equal(invalidatedProjection.receipts.status,'incomplete');
  assert.equal(invalidatedProjection.receipts.rows[0].status,'invalidated');
  for(const point of ['test','finish-pre-action','finish-finalize'])
    assert.equal(selectGovernedAdmission(invalidatedProjection,point)
      .blocking_codes.includes('receipt-invalid'),true);
  evidenceRuntime.loadCommittedPackage=originalLoadCommittedPackage;
  evidenceRuntime.evaluateEvidenceCompleteness=originalEvaluateEvidenceCompleteness;

  const governed=loadGovernedContext({stateCapability});
  assert.deepEqual(reportRuntime.readReceiptDashboard({stateCapability}),
    governed.projection);
  const generated=await reportRuntime.generateReport({stateCapability});
  assert.equal(generated.projection_sha256,governed.sha256);
  const reportText=fs.readFileSync(generated.output,'utf8');
  assert.equal(reportText.includes(`Projection SHA-256: ${governed.sha256}`),true);
  assert.equal(reportText.includes(governed.bytes.toString('utf8')),true);

  const current=frontmatter.parseFrontmatter(fs.readFileSync(statePath,'utf8')).fields;
  const tamperedPolicy=JSON.parse(current.methodology_policy_json);
  tamperedPolicy.profile='lean';
  fs.writeFileSync(statePath,frontmatter.updateFrontmatterText(
    fs.readFileSync(statePath,'utf8'),{
      methodology_policy_json:JSON.stringify(tamperedPolicy)}));
  let drifted=loadGovernedContext({stateCapability}).projection;
  assert.equal(drifted.plan_identity.status,'invalidated');
  assert.throws(()=>validateSessionAuthority({stateCapability}),
    /session-authority-invalidated/);
  assert.equal(selectGovernedAdmission(drifted,'finish-finalize')
    .blocking_codes.includes('authority-invalidated'),true);

  fs.writeFileSync(statePath,frontmatter.updateFrontmatterText(
    fs.readFileSync(statePath,'utf8'),{
      methodology_policy_json:current.methodology_policy_json}));
  fs.appendFileSync(path.join(work,'spec.md'),'drift\n');
  drifted=loadGovernedContext({stateCapability}).projection;
  assert.equal(drifted.plan_identity.status,'invalidated');
});
