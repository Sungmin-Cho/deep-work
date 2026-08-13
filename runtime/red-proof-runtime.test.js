'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync,execFileSync}=require('node:child_process');
const platform=require('./platform.js');
const transaction=require('./transaction-runtime.js');
const journal=require('./operation-journal.js');
const frontmatter=require('./frontmatter.js');
const bootstrap=require('./bootstrap-runtime.js');
const {compileImmutablePlanAuthorityV2,deriveScopedWriteAuthority}=require('./plan-runtime.js');
const {beginScopedWrite,acceptScopedWrite}=require('./slice-runtime.js');
const {transitionSliceTdd}=require('./phase-runtime.js');
const {runSensor,runReviewCheck,aggregateSensorResults}=require('./sensor-runtime.js');
const {publishFunctionalSliceReceiptV2,semanticDigest:receiptDigest}=
  require('./functional-receipt-runtime.js');
const {recordNoRefactorDecision}=require('./refactor-decision-runtime.js');
const {transitionOrdinaryRed,publishOrdinaryRedProof,semanticDigest}=
  require('./red-proof-runtime.js');
const {runVerificationV2,buildSupervisorControl}=require('./verification-v2-runtime.js');
const {loadGovernedContext}=require('./governed-context-runtime.js');
const {publishOwnedDiscovery,dispatchOwnedDiscoveryReplan,
  publishRiskObservation,dispatchRiskIncreaseReplan,
  prepareManifestReplanAuthority,recordPreparedReplan}=
  require('./replan-runtime.js');
const {dispatch}=require('../scripts/deep-work-runtime.js');
const node26Test=process.versions.node==='26.0.0'?test:test.skip;

test('strict verification v2 exposes the governed production runner',()=>{
  assert.equal(typeof runVerificationV2,'function');
});

test('Windows verification control authenticates taskkill without entering the child environment',
  (t)=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dw-supervisor-control-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'System32'));
    fs.writeFileSync(path.join(root,'System32','taskkill.exe'),'pinned-taskkill');
    const control=buildSupervisorControl({platformName:'win32',
      environment:{SystemRoot:root},fsImpl:fs,pathImpl:path});
    assert.deepEqual(Object.keys(control.values),['SystemRoot']);
    assert.deepEqual(Object.keys(control.identities.system_root).sort(),
      ['dev','ino','mode','path']);
    assert.deepEqual(Object.keys(control.identities.taskkill).sort(),
      ['dev','ino','mode','mtime_ns','path','sha256','size']);
    assert.equal(control.identities.taskkill.sha256,
      crypto.createHash('sha256').update('pinned-taskkill').digest('hex'));
    assert.deepEqual(Object.keys({LANG:'C',LC_ALL:'C',TZ:'UTC'}).sort(),
      ['LANG','LC_ALL','TZ']);
  });

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-red-proof-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:root});
  execFileSync('git',['config','user.email','test@example.invalid'],{cwd:root});
  execFileSync('git',['config','user.name','Deep Work Test'],{cwd:root});
  fs.mkdirSync(path.join(root,'runtime'),{recursive:true});
  fs.writeFileSync(path.join(root,'runtime','a.js'),'module.exports=1;\n');
  fs.writeFileSync(path.join(root,'runtime','a.test.js'),'// base\n');
  fs.writeFileSync(path.join(root,'.gitignore'),'.claude/\n.deep-work/\n');
  execFileSync('git',['add','-A'],{cwd:root});
  execFileSync('git',['commit','-qm','base'],{cwd:root});
  const failing=["'use strict';","const test=require('node:test');",
    "const assert=require('node:assert/strict');",
    "test('expected red',()=>assert.strictEqual(require('./a.js'),2));",''].join('\n');
  fs.writeFileSync(path.join(root,'runtime','a.test.js'),failing);
  fs.mkdirSync(path.join(root,'.tmp-probe'));
  const probe=spawnSync(process.execPath,
    ['--no-warnings','--permission',`--allow-fs-read=${root}`,
      `--allow-fs-write=${path.join(root,'.tmp-probe')}`,'--test','--test-isolation=none',
      '--test-reporter=tap','--','runtime/a.test.js'],
    {cwd:root,env:{LANG:'C',LC_ALL:'C',TZ:'UTC'},encoding:null});
  assert.equal(probe.status,1);
  assert.equal(probe.stderr.length,0,probe.stderr.toString('utf8'));
  const event=bootstrap.parseNodeTapFailure(probe.stdout.toString('utf8'),{
    root,testPath:'runtime/a.test.js'});
  const expectedSignal={kind:'assertion',operator:'strictEqual',
    test_identity:{test_file:event.test_file,test_name:event.test_name,start_line:event.start_line},
    expected_digest:event.expected_digest,actual_digest:event.actual_digest,
    message_pattern:'Expected values to be strictly equal'};
  const spec={schema_version:2,executable:{kind:'node-toolchain',name:'node',
    supported_patches_sha256:bootstrap.BOOTSTRAP_SUPPORTED_NODE_PATCHES_SHA256},
  args:['--test','--test-reporter=tap','--','runtime/a.test.js'],cwd_role:'worktree',
  timeout_ms:120000,max_output_bytes:1048576,
  environment:{mode:'closed',values:{LANG:'C',LC_ALL:'C',TZ:'UTC'}},
  red_failure:{adapter:'node-test-tap',adapter_version:1,expected_class:'expected-failure',
    expected_signal:expectedSignal}};
  const specSha256=journal.sha256(journal.canonicalJson(spec));
  const facts={schema_version:1,authority:'reviewed-plan',destructive:false,
    external_action:false,has_backward_compat:true,has_migration:true,host_dependent:true,
    source_requirement_ids:['REQ-001'],source_slice_ids:['SLICE-002']};
  facts.facts_sha256=semanticDigest('capability-facts-v1',facts,'facts_sha256');
  const plan={schema_version:2,replan_epoch:'0'.repeat(64),
    contract_binding:{mode:'strict-spec',created_by_version:'6.14.0',
      source_plan_sha256:'1'.repeat(64),risk_profile_sha256:'2'.repeat(64),
      spec_contract:{schema_version:1,spec_id:'SPEC-RED',
        spec_sha256:'3'.repeat(64),spec_approved_hash:'4'.repeat(64)}},
    capability_facts:facts,slices:[
      {id:'SLICE-001',slice_kind:'functional',checked:false,scope_schema_version:1,
        files:['runtime/a.js','runtime/a.test.js'],write_scope:{
          failing_test:['runtime/a.test.js'],production:['runtime/a.js'],
          refactor:['runtime/a.js']},
        verification_spec:spec,verification_spec_sha256:specSha256},
      {id:'SLICE-002',slice_kind:'release-verification',checked:false,
        scope_schema_version:1,files:[],write_scope:{
          failing_test:[],production:[],refactor:[]},verification_scope:['npm test'],
        release_gate_ids:['GATE-full-relevant-suite'],verification_spec:null,
        verification_spec_sha256:null},
    ]};
  plan.plan_authority_sha256=compileImmutablePlanAuthorityV2(plan).plan_authority_sha256;
  fs.writeFileSync(path.join(root,'runtime','a.test.js'),'// base\n');
  fs.mkdirSync(path.join(root,'.claude'),{recursive:true});
  const work=path.join(root,'.deep-work','s-aaaaaaaa');
  fs.mkdirSync(work,{recursive:true});
  const statePath=path.join(root,'.claude','deep-work.s-aaaaaaaa.md');
  const verificationPlanSha256='5'.repeat(64);
  fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',{
    session_id:'s-aaaaaaaa',work_dir:'.deep-work/s-aaaaaaaa',
    current_phase:'implement',active_slice:'SLICE-001',tdd_state:'PENDING',
    verification_plan_sha256:verificationPlanSha256,risk_class:'critical'}));
  const stateCapability=platform.issueProjectStateCapability(root,statePath,{
    role:'session-state'});
  const sessionCapability=platform.issueProjectStateCapability(root,work,{
    role:'session-work-dir',sessionStateCapability:stateCapability});
  const planCapability=transaction.issueSessionFileCapability({sessionCapability,
    candidate:path.join(work,'plan.json'),allowedBasenames:['plan.json'],
    allowMissingLeaf:true,role:'locked-plan'});
  fs.writeFileSync(planCapability.path,journal.canonicalJson(plan));
  return{root,statePath,stateCapability,planCapability,plan,spec,failing,
    verificationPlanSha256};
}

async function ordinaryGreenFixture(t){
  const f=fixture(t);
  const failingScope=deriveScopedWriteAuthority({plan:f.plan,
    sliceId:'SLICE-001',writeClass:'failing-test'});
  const failingWrite=await beginScopedWrite({stateCapability:f.stateCapability,
    planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
    writeClass:'failing-test',expectedScopeSha256:failingScope.sha256});
  fs.writeFileSync(path.join(f.root,'runtime','a.test.js'),f.failing);
  await acceptScopedWrite({stateCapability:f.stateCapability,
    planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
    operationId:failingWrite.operationId,
    preManifestSha256:failingWrite.preManifestSha256});
  const red=await runVerificationV2({stateCapability:f.stateCapability,
    planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001'});
  const transitioned=await transitionOrdinaryRed({
    stateCapability:f.stateCapability,planCapability:f.planCapability,
    plan:f.plan,sliceId:'SLICE-001',verificationOperationId:red.operation_id,
    verificationResultSha256:red.verification_result_sha256});
  await publishOrdinaryRedProof({stateCapability:f.stateCapability,
    planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
    transitionOperationId:transitioned.operation_id});
  const productionScope=deriveScopedWriteAuthority({plan:f.plan,
    sliceId:'SLICE-001',writeClass:'production'});
  const production=await beginScopedWrite({stateCapability:f.stateCapability,
    planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
    writeClass:'production',expectedScopeSha256:productionScope.sha256});
  fs.writeFileSync(path.join(f.root,'runtime','a.js'),'module.exports=2;\n');
  await acceptScopedWrite({stateCapability:f.stateCapability,
    planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
    operationId:production.operationId,
    preManifestSha256:production.preManifestSha256});
  const green=await runVerificationV2({stateCapability:f.stateCapability,
    planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
    expectedOutcome:'must-pass'});
  const result=JSON.parse(fs.readFileSync(path.join(f.root,
    green.verification_result_path),'utf8'));
  await transitionSliceTdd({stateCapability:f.stateCapability,
    planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',to:'GREEN',
    verificationResult:result,verificationSha256:green.verification_result_sha256,
    verificationOperationId:green.operation_id});
  await transitionSliceTdd({stateCapability:f.stateCapability,
    sliceId:'SLICE-001',to:'SENSOR_RUN'});
  await transitionSliceTdd({stateCapability:f.stateCapability,
    sliceId:'SLICE-001',to:'SENSOR_CLEAN'});
  return{...f,green,greenRef:{operation_id:green.operation_id,
    result_path:green.verification_result_path,
    result_sha256:green.verification_result_sha256,
    ledger_result_sha256:green.operation_receipt.resultSha256}};
}

node26Test('ordinary RED transition and proof publication authorize the exact strict production write',
  async(t)=>{
    const f=fixture(t);
    const scope=deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test'});
    const begun=await beginScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test',expectedScopeSha256:scope.sha256});
    await assert.rejects(()=>runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001'}),
    /pending-scoped-write/);
    fs.writeFileSync(path.join(f.root,'runtime','a.test.js'),f.failing);
    const accepted=await acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256});
    assert.equal(accepted.status,'accepted');
    const writeReceiptPath=path.join(f.root,'.claude',
      `deep-work.s-aaaaaaaa.scoped-write.${begun.operationId}.json`);
    const writeReceiptBytes=fs.readFileSync(writeReceiptPath);
    const writeReceipt=JSON.parse(writeReceiptBytes);
    writeReceipt.authority.authorized_paths=[];
    fs.writeFileSync(writeReceiptPath,journal.canonicalJson(writeReceipt));
    await assert.rejects(()=>runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001'}),
    /verification-v2-write/);
    fs.writeFileSync(writeReceiptPath,writeReceiptBytes);
    const writeLedgerPath=path.join(f.root,'.claude',
      'deep-work.s-aaaaaaaa.completed-operations.json');
    const writeLedgerBytes=fs.readFileSync(writeLedgerPath);
    const writeLedger=JSON.parse(writeLedgerBytes);
    writeLedger.receipts=writeLedger.receipts.filter((row)=>
      row.operationId!==begun.operationId);
    fs.writeFileSync(writeLedgerPath,journal.canonicalJson(writeLedger));
    await assert.rejects(()=>runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001'}),
    /operation-not-found|verification-v2-write-ledger/);
    fs.writeFileSync(writeLedgerPath,writeLedgerBytes);
    const verification=await runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001'});
    assert.equal(verification.disposition,'accepted');
    assert.deepEqual(fs.readdirSync(path.join(f.root,'.claude')).filter((name)=>
      name.includes('.verification-temp.')),[]);
    const replay=await runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001'});
    assert.equal(replay.adopted,true);
    assert.deepEqual(fs.readdirSync(path.join(f.root,'.claude')).filter((name)=>
      name.includes('.verification-temp.')),[]);
    const result=JSON.parse(fs.readFileSync(path.join(f.root,
      verification.verification_result_path),'utf8'));
    const preManifestPath=path.join(f.root,...result.pre_manifest_ref.path.split('/'));
    const preManifestBytes=fs.readFileSync(preManifestPath);
    const tampered=JSON.parse(preManifestBytes);
    tampered.entries[0].sha256='f'.repeat(64);
    fs.writeFileSync(preManifestPath,journal.canonicalJson(tampered));
    await assert.rejects(()=>transitionOrdinaryRed({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      verificationOperationId:verification.operation_id,
      verificationResultSha256:verification.verification_result_sha256}),
    /verification-v2-manifest/);
    fs.writeFileSync(preManifestPath,preManifestBytes);
    const transitioned=await transitionOrdinaryRed({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      verificationOperationId:verification.operation_id,
      verificationResultSha256:verification.verification_result_sha256});
    const published=await publishOrdinaryRedProof({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      transitionOperationId:transitioned.operation_id});
    const fields=frontmatter.parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields;
    assert.equal(fields.red_proof_state,'complete');
    assert.equal(fields.red_proof_sha256,published.proof_sha256);
    const productionScope=deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',
      writeClass:'production'});
    const production=await beginScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      writeClass:'production',expectedScopeSha256:productionScope.sha256});
    assert.match(production.operationId,/^op-[0-9a-f]{64}$/);
    fs.writeFileSync(path.join(f.root,'runtime','a.js'),'module.exports=2;\n');
    const productionAccepted=await acceptScopedWrite({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',operationId:production.operationId,
      preManifestSha256:production.preManifestSha256});
    assert.equal(productionAccepted.status,'accepted');
    const green=await runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      expectedOutcome:'must-pass'});
    assert.equal(green.disposition,'accepted');
    assert.equal(green.observed_class,'unexpected-pass');
    const greenReplay=await runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      expectedOutcome:'must-pass'});
    assert.equal(greenReplay.adopted,true);
    const greenResult=JSON.parse(fs.readFileSync(path.join(f.root,
      green.verification_result_path),'utf8'));
    await transitionSliceTdd({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',to:'GREEN',
      verificationResult:greenResult,
      verificationSha256:green.verification_result_sha256,
      verificationOperationId:green.operation_id});
    await transitionSliceTdd({stateCapability:f.stateCapability,
      sliceId:'SLICE-001',to:'SENSOR_RUN'});
    await transitionSliceTdd({stateCapability:f.stateCapability,
      sliceId:'SLICE-001',to:'SENSOR_CLEAN'});
    const refactorScope=deriveScopedWriteAuthority({plan:f.plan,
      sliceId:'SLICE-001',writeClass:'refactor'});
    const refactorWrite=await beginScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      writeClass:'refactor',expectedScopeSha256:refactorScope.sha256});
    fs.writeFileSync(path.join(f.root,'runtime','a.js'),
      "'use strict';\nmodule.exports=2;\n");
    const refactorAccepted=await acceptScopedWrite({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',operationId:refactorWrite.operationId,
      preManifestSha256:refactorWrite.preManifestSha256});
    const postRefactor=await runVerificationV2({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',expectedOutcome:'must-pass'});
    const postResult=JSON.parse(fs.readFileSync(path.join(f.root,
      postRefactor.verification_result_path),'utf8'));
    await transitionSliceTdd({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',to:'GREEN',
      verificationResult:postResult,
      verificationSha256:postRefactor.verification_result_sha256,
      verificationOperationId:postRefactor.operation_id});
    await transitionSliceTdd({stateCapability:f.stateCapability,
      sliceId:'SLICE-001',to:'SENSOR_RUN'});
    const context={sessionId:'s-aaaaaaaa',stateCapability:f.stateCapability,
      planCapability:f.planCapability,sliceId:'SLICE-001',
      afterWriteOperationId:refactorWrite.operationId};
    const projectCap=platform.issueProjectStateCapability(
      f.root,f.root,{role:'project-root'});
    const processSpec={kind:'native-executable',executable:process.execPath,
      args:['-e','process.stdout.write("[]")']};
    const lint=await runSensor({kind:'lint',processSpec,parser:'generic-json',
      budgetMs:5000,projectCapability:projectCap,refactorContext:context});
    const typecheck=await runSensor({kind:'typecheck',processSpec,
      parser:'generic-json',budgetMs:5000,projectCapability:projectCap,
      refactorContext:context});
    const reviewCheck=await runReviewCheck(projectCap,{},context);
    const sensors=[lint,typecheck,reviewCheck];
    const sensorDigest=aggregateSensorResults(sensors);
    const sensorOperationIds=sensors.map((row)=>row.operationId)
      .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    await transitionSliceTdd({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      to:'SENSOR_CLEAN',sensorOperationIds,
      sensorResultsSha256:sensorDigest,
      afterWriteOperationId:refactorWrite.operationId});
    const greenRef={operation_id:green.operation_id,
      result_path:green.verification_result_path,
      result_sha256:green.verification_result_sha256,
      ledger_result_sha256:green.operation_receipt.resultSha256};
    const postRef={operation_id:postRefactor.operation_id,
      result_path:postRefactor.verification_result_path,
      result_sha256:postRefactor.verification_result_sha256,
      ledger_result_sha256:postRefactor.operation_receipt.resultSha256};
    const sensorRefs=sensors.map((row)=>({kind:row.kind,
      operation_id:row.operationId,result_path:path.relative(
        f.root,row.resultCapability.path).split(path.sep).join('/'),
      result_sha256:row.resultSha256,
      ledger_result_sha256:row.operationReceipt.resultSha256}))
      .sort((a,b)=>Buffer.compare(Buffer.from(journal.canonicalJson(
        [a.kind,a.operation_id])),Buffer.from(journal.canonicalJson(
        [b.kind,b.operation_id]))));
    const refactorEvidence={kind:'performed-refactor',
      write_operation_id:refactorWrite.operationId,
      write_receipt_sha256:refactorAccepted.receiptSha256,
      post_refactor_green:postRef,sensor_results:sensorRefs,
      evidence_sha256:null};
    refactorEvidence.evidence_sha256=receiptDigest('refactor-evidence-v1',
      refactorEvidence,'evidence_sha256');
    let interrupted=false;
    await assert.rejects(publishFunctionalSliceReceiptV2({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',greenVerification:greenRef,
      refactorEvidence,seam:(stage)=>{
        if(stage==='after-receipt-write-before-stage'&&!interrupted){
          interrupted=true;
          throw new Error('simulated receipt publication interruption');
        }
      }}),/simulated receipt publication interruption/);
    const completed=await publishFunctionalSliceReceiptV2({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',greenVerification:greenRef,
      refactorEvidence});
    assert.match(completed.receipt_sha256,/^[0-9a-f]{64}$/);
    const receiptPath=path.join(f.root,...completed.receipt_path.split('/'));
    const storedReceipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
    assert.equal(storedReceipt.schema_version,2);
    assert.match(frontmatter.parseFrontmatter(
      fs.readFileSync(f.statePath,'utf8')).fields.implement_completed_at,
    /^\d{4}-\d{2}-\d{2}T/);
    const checkedPlan=JSON.parse(fs.readFileSync(f.planCapability.path,'utf8'));
    const replayed=await publishFunctionalSliceReceiptV2({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:checkedPlan,sliceId:'SLICE-001',greenVerification:greenRef,
      refactorEvidence});
    assert.equal(replayed.adopted,true);
    assert.equal(loadGovernedContext({
      stateCapability:f.stateCapability}).projection.receipts.rows
      .find((row)=>row.slice_id==='SLICE-001').status,'complete');
    const ledgerPath=path.join(f.root,'.claude',
      'deep-work.s-aaaaaaaa.completed-operations.json');
    const ledgerBytes=fs.readFileSync(ledgerPath);
    const ledger=JSON.parse(ledgerBytes);
    ledger.receipts=ledger.receipts.filter((row)=>
      row.operationId!==completed.operation_id);
    fs.writeFileSync(ledgerPath,journal.canonicalJson(ledger));
    assert.equal(loadGovernedContext({
      stateCapability:f.stateCapability}).projection.receipts.rows
      .find((row)=>row.slice_id==='SLICE-001').status,'unknown');
    fs.writeFileSync(ledgerPath,ledgerBytes);
    fs.writeFileSync(receiptPath,journal.canonicalJson({
      ...storedReceipt,status:'invalidated'}));
    await assert.rejects(publishFunctionalSliceReceiptV2({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:checkedPlan,sliceId:'SLICE-001',greenVerification:greenRef,
      refactorEvidence}),/functional-recovery-fresh-evidence/);
    fs.writeFileSync(receiptPath,journal.canonicalJson(storedReceipt));
    fs.writeFileSync(receiptPath,journal.canonicalJson({
      ...storedReceipt,receipt_sha256:'0'.repeat(64)}));
    await assert.rejects(publishFunctionalSliceReceiptV2({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:checkedPlan,sliceId:'SLICE-001',greenVerification:greenRef,
      refactorEvidence}),/functional-receipt/);
    fs.writeFileSync(receiptPath,journal.canonicalJson(storedReceipt));
  });

node26Test('no-refactor decision binds fresh GREEN and sensors into functional completion',
  async(t)=>{
    const f=await ordinaryGreenFixture(t);
    let interrupted=false;
    await assert.rejects(recordNoRefactorDecision({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',greenVerification:f.greenRef,
      reasonCode:'no-duplication',seam:(stage)=>{
        if(stage==='after-state-write-before-stage'&&!interrupted){
          interrupted=true;
          throw new Error('simulated no-refactor state interruption');
        }
      }}),/simulated no-refactor state interruption/);
    const decision=await recordNoRefactorDecision({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',greenVerification:f.greenRef,
      reasonCode:'no-duplication'});
    assert.equal(decision.writeClass,'no-refactor-decision');
    const postDecision=await runVerificationV2({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',expectedOutcome:'must-pass'});
    const postResult=JSON.parse(fs.readFileSync(path.join(f.root,
      postDecision.verification_result_path),'utf8'));
    assert.equal(postResult.write_operation_id,decision.operationId);
    await transitionSliceTdd({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',to:'GREEN',
      verificationResult:postResult,
      verificationSha256:postDecision.verification_result_sha256,
      verificationOperationId:postDecision.operation_id});
    await transitionSliceTdd({stateCapability:f.stateCapability,
      sliceId:'SLICE-001',to:'SENSOR_RUN'});
    const context={sessionId:'s-aaaaaaaa',stateCapability:f.stateCapability,
      planCapability:f.planCapability,sliceId:'SLICE-001',
      afterWriteOperationId:decision.operationId};
    const projectCap=platform.issueProjectStateCapability(
      f.root,f.root,{role:'project-root'});
    const processSpec={kind:'native-executable',executable:process.execPath,
      args:['-e','process.stdout.write("[]")']};
    const sensors=[
      await runSensor({kind:'lint',processSpec,parser:'generic-json',
        budgetMs:5000,projectCapability:projectCap,refactorContext:context}),
      await runSensor({kind:'typecheck',processSpec,parser:'generic-json',
        budgetMs:5000,projectCapability:projectCap,refactorContext:context}),
      await runReviewCheck(projectCap,{},context),
    ];
    await transitionSliceTdd({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      to:'SENSOR_CLEAN',sensorOperationIds:sensors.map((row)=>row.operationId)
        .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),
      sensorResultsSha256:aggregateSensorResults(sensors),
      afterWriteOperationId:decision.operationId});
    const postRef={operation_id:postDecision.operation_id,
      result_path:postDecision.verification_result_path,
      result_sha256:postDecision.verification_result_sha256,
      ledger_result_sha256:postDecision.operation_receipt.resultSha256};
    const sensorRefs=sensors.map((row)=>({kind:row.kind,
      operation_id:row.operationId,result_path:path.relative(
        f.root,row.resultCapability.path).split(path.sep).join('/'),
      result_sha256:row.resultSha256,
      ledger_result_sha256:row.operationReceipt.resultSha256}))
      .sort((a,b)=>Buffer.compare(Buffer.from(journal.canonicalJson(
        [a.kind,a.operation_id])),Buffer.from(journal.canonicalJson(
        [b.kind,b.operation_id]))));
    const evidence={kind:'no-refactor',
      decision_operation_id:decision.operationId,reason_code:'no-duplication',
      post_decision_green:postRef,sensor_results:sensorRefs,
      decision_sha256:null};
    evidence.decision_sha256=receiptDigest('refactor-evidence-v1',evidence,
      'decision_sha256');
    const completed=await publishFunctionalSliceReceiptV2({
      stateCapability:f.stateCapability,planCapability:f.planCapability,
      plan:f.plan,sliceId:'SLICE-001',greenVerification:f.greenRef,
      refactorEvidence:evidence});
    const stored=JSON.parse(fs.readFileSync(path.join(f.root,
      ...completed.receipt_path.split('/')),'utf8'));
    assert.equal(stored.refactor_evidence.kind,'no-refactor');
    assert.equal(stored.refactor_evidence.decision_operation_id,
      decision.operationId);
  });

node26Test('a ledger-complete verification side effect automatically enters authenticated replan',
  async(t)=>{
    const f=fixture(t);
    const scope=deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test'});
    const begun=await beginScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test',expectedScopeSha256:scope.sha256});
    fs.writeFileSync(path.join(f.root,'runtime','a.test.js'),f.failing);
    await acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256});
    const verification=await runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      seam:(stage)=>{
        if(stage==='after-process-before-post-manifest')
          fs.writeFileSync(path.join(f.root,'runtime','a.js'),'module.exports=2;\n');
      }});
    assert.equal(verification.disposition,'rejected');
    assert.equal(verification.observed_class,'test-side-effect');
    assert.match(verification.replan_trigger_id,/^[0-9a-f]{64}$/);
    assert.match(verification.replan_epoch,/^[0-9a-f]{64}$/);
    const fields=frontmatter.parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields;
    assert.equal(fields.current_phase,'spec');
    assert.equal(fields.subphase,null);
    assert.equal(fields.replan_required,true);
    assert.equal(fields.replan_reason,'test-side-effect');
    assert.equal(fields.tdd_state,'PENDING');
    assert.equal(fields.red_proof_state,null);
    const replay=await runVerificationV2({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001'});
    assert.equal(replay.adopted,true);
    assert.equal(replay.replan_trigger_id,verification.replan_trigger_id);
    assert.equal(replay.replan_epoch,verification.replan_epoch);
  });

node26Test('owned discovery enters a same-risk authenticated replan and rejects source drift',
  async(t)=>{
    const f=fixture(t);
    const sourcePath='runtime/a.js';
    const observation={schema_version:1,reason:'public-contract',scope:'slice',
      slice_id:'SLICE-001',requirement_id:'REQ-001',invariant_id:null,
      failure_mode_id:null,source_path:sourcePath,
      source_sha256:journal.sha256(fs.readFileSync(path.join(f.root,sourcePath))),
      detail_code:'public-api-expanded'};
    const published=await publishOwnedDiscovery({stateCapability:f.stateCapability,
      plan:f.plan,observation});
    const replanned=await dispatchOwnedDiscoveryReplan({
      stateCapability:f.stateCapability,plan:f.plan,sliceId:'SLICE-001',
      producerOperationId:published.operation_id});
    assert.match(replanned.replan_epoch,/^[0-9a-f]{64}$/);
    const fields=frontmatter.parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields;
    assert.equal(fields.replan_reason,'public-contract');
    const trigger=JSON.parse(fs.readFileSync(path.join(f.root,
      ...fields.replan_trigger_ref.split('/')),'utf8'));
    assert.equal(trigger.from_risk,'critical');
    assert.equal(trigger.to_risk,'critical');
    fs.writeFileSync(path.join(f.root,sourcePath),'module.exports=99;\n');
    await assert.rejects(()=>publishOwnedDiscovery({
      stateCapability:f.stateCapability,plan:f.plan,observation}),
    /replan-discovery/);
  });

node26Test('owned discovery crosses the public dispatcher into same-risk replan',async(t)=>{
  const f=fixture(t),sourcePath='runtime/a.js';
  const observation={schema_version:1,reason:'invariant',scope:'slice',
    slice_id:'SLICE-001',requirement_id:null,invariant_id:'INV-001',
    failure_mode_id:null,source_path:sourcePath,
    source_sha256:journal.sha256(fs.readFileSync(path.join(f.root,sourcePath))),
    detail_code:'invariant-discovered'};
  const input=path.join(f.root,'discovery.json');
  fs.writeFileSync(input,journal.canonicalJson(observation));
  const published=await dispatch(['replan','discovery','publish','--state',
    f.statePath,'--plan',f.planCapability.path,'--observation-json',input],
  {cwd:f.root});
  const replanned=await dispatch(['replan','discovery','dispatch','--state',
    f.statePath,'--plan',f.planCapability.path,'--producer-operation-id',
    published.operation_id,'--slice','SLICE-001'],{cwd:f.root});
  assert.match(replanned.replan_epoch,/^[0-9a-f]{64}$/);
  assert.equal(frontmatter.parseFrontmatter(
    fs.readFileSync(f.statePath,'utf8')).fields.replan_reason,'invariant');
});

node26Test('authenticated risk observation crosses the public dispatcher with a strict increase',
  async(t)=>{
    const f=fixture(t),prior={class:'medium',score:5,triggers:['public-api']},
      next={class:'high',score:8,triggers:['external-side-effect']},
      priorSha256=journal.sha256(journal.canonicalJson(prior));
    f.plan.contract_binding.risk_profile_sha256=priorSha256;
    f.plan.plan_authority_sha256=
      compileImmutablePlanAuthorityV2(f.plan).plan_authority_sha256;
    fs.writeFileSync(f.planCapability.path,journal.canonicalJson(f.plan));
    const before=fs.readFileSync(f.statePath,'utf8');
    fs.writeFileSync(f.statePath,frontmatter.updateFrontmatterText(before,{
      risk_class:'medium',risk_profile_json:journal.canonicalJson(prior).trimEnd(),
      risk_profile_sha256:priorSha256,created_by_version:'6.14.0'}));
    const nextPath=path.join(f.root,'next-risk.json');
    fs.writeFileSync(nextPath,journal.canonicalJson(next));
    const published=await dispatch(['replan','risk','publish','--state',
      f.statePath,'--plan',f.planCapability.path,'--next-risk-profile-json',
      nextPath],{cwd:f.root});
    const replanned=await dispatch(['replan','risk','dispatch','--state',
      f.statePath,'--plan',f.planCapability.path,'--producer-operation-id',
      published.operation_id,'--scope','slice','--slice','SLICE-001'],
    {cwd:f.root});
    assert.match(replanned.replan_epoch,/^[0-9a-f]{64}$/);
    const fields=frontmatter.parseFrontmatter(
      fs.readFileSync(f.statePath,'utf8')).fields;
    assert.equal(fields.replan_reason,'risk-class-increase');
    assert.equal(fields.risk_class,'high');
    assert.equal(fields.risk_profile_sha256,
      journal.sha256(journal.canonicalJson(next)));
    const trigger=JSON.parse(fs.readFileSync(path.join(f.root,
      ...fields.replan_trigger_ref.split('/')),'utf8'));
    assert.equal(trigger.from_risk,'medium');
    assert.equal(trigger.to_risk,'high');
    const replay=await publishRiskObservation({stateCapability:f.stateCapability,
      plan:f.plan,nextRiskProfile:next});
    assert.equal(replay.adopted,true);
    await assert.rejects(()=>dispatchRiskIncreaseReplan({
      stateCapability:f.stateCapability,plan:f.plan,sliceId:null,
      producerOperationId:published.operation_id}),/replan-active-conflict/);
  });

node26Test('stale prepared replan cannot overwrite an active trigger',async(t)=>{
  const f=fixture(t),make=(digit,affectedPath)=>
    prepareManifestReplanAuthority({stateCapability:f.stateCapability,
      plan:f.plan,sliceId:'SLICE-001',
      parentWriteOperationId:`op-${digit.repeat(64)}`,
      observationKind:'scope-expansion',
      preManifestSha256:'a'.repeat(64),
      candidatePostManifestSha256:digit.repeat(64),
      observedPostManifestSha256:null,affectedPaths:[affectedPath]});
  const first=make('b','runtime/a.js');
  const stale=make('c','runtime/a.test.js');
  await recordPreparedReplan({stateCapability:f.stateCapability,plan:f.plan,
    sliceId:'SLICE-001',prepared:first});
  await assert.rejects(()=>recordPreparedReplan({
    stateCapability:f.stateCapability,plan:f.plan,sliceId:'SLICE-001',
    prepared:stale}),/replan-active-conflict/);
});

node26Test('session-scoped discovery publishes a session-plan invalidation',async(t)=>{
  const f=fixture(t),sourcePath='runtime/a.js';
  const observation={schema_version:1,reason:'public-contract',scope:'session',
    slice_id:null,requirement_id:'REQ-001',invariant_id:null,
    failure_mode_id:null,source_path:sourcePath,
    source_sha256:journal.sha256(fs.readFileSync(path.join(f.root,sourcePath))),
    detail_code:'session-contract-expanded'};
  const published=await publishOwnedDiscovery({stateCapability:f.stateCapability,
    plan:f.plan,observation});
  await dispatchOwnedDiscoveryReplan({stateCapability:f.stateCapability,
    plan:f.plan,sliceId:null,producerOperationId:published.operation_id});
  const fields=frontmatter.parseFrontmatter(
    fs.readFileSync(f.statePath,'utf8')).fields;
  const invalidations=JSON.parse(fields.replan_invalidations_json);
  assert.equal(invalidations.length,1);
  assert.equal(invalidations[0].scope,'session-plan');
  assert.equal(invalidations[0].session_id,'s-aaaaaaaa');
});

node26Test('replan completion requires epoch-bound completed Spec and Plan approvals',
  async(t)=>{
    const f=fixture(t),sourcePath='runtime/a.js';
    const observation={schema_version:1,reason:'invariant',scope:'slice',
      slice_id:'SLICE-001',requirement_id:null,invariant_id:'INV-001',
      failure_mode_id:null,source_path:sourcePath,
      source_sha256:journal.sha256(fs.readFileSync(path.join(f.root,sourcePath))),
      detail_code:'invariant-discovered'};
    const published=await publishOwnedDiscovery({stateCapability:f.stateCapability,
      plan:f.plan,observation});
    const replanned=await dispatchOwnedDiscoveryReplan({
      stateCapability:f.stateCapability,plan:f.plan,sliceId:'SLICE-001',
      producerOperationId:published.operation_id});
    const approvedPlan=structuredClone(f.plan);
    approvedPlan.replan_epoch=replanned.replan_epoch;
    approvedPlan.plan_authority_sha256=
      compileImmutablePlanAuthorityV2(approvedPlan).plan_authority_sha256;
    fs.writeFileSync(f.planCapability.path,journal.canonicalJson(approvedPlan));
    const project=transaction.projectCapabilityFor(f.stateCapability);
    async function approval(id){
      const operation=await journal.beginOperation({projectCapability:project,
        sessionId:'s-aaaaaaaa',kind:'phase-approval',operationId:id,
        preconditions:{epoch:replanned.replan_epoch}});
      await journal.recordOperationStage(operation,'state-written',{owned:{
        epoch:replanned.replan_epoch}});
      return journal.completeOperation(operation,{status:'completed',
        epoch:replanned.replan_epoch});
    }
    const specOperationId=`op-${'a'.repeat(64)}`;
    const planOperationId=`op-${'b'.repeat(64)}`;
    await approval(specOperationId);await approval(planOperationId);
    const riskProfileSha256='2'.repeat(64),specApprovedHash='4'.repeat(64);
    const specApproval={schema_version:1,session_id:'s-aaaaaaaa',
      spec_sha256:'3'.repeat(64),spec_approved_hash:specApprovedHash,
      risk_profile_sha256:riskProfileSha256,replan_epoch:replanned.replan_epoch,
      spec_review_ref_sha256:'c'.repeat(64),
      approval_operation_id:specOperationId,approval_sha256:null};
    specApproval.approval_sha256=journal.sha256(journal.canonicalJson(
      Object.fromEntries(Object.entries(specApproval).filter(([key])=>
        key!=='approval_sha256'))));
    const sourcePlanSha256='d'.repeat(64);
    const before=fs.readFileSync(f.statePath,'utf8');
    fs.writeFileSync(f.statePath,frontmatter.updateFrontmatterText(before,{
      current_phase:'plan',risk_profile_sha256:riskProfileSha256,
      spec_approved_hash:specApprovedHash,
      spec_approval_json:journal.canonicalJson(specApproval),
      spec_approval_operation_id:specOperationId,
      plan_projection_sha256:journal.sha256(journal.canonicalJson(approvedPlan)),
      plan_source_sha256:sourcePlanSha256,
      plan_approved:journal.canonicalJson({artifact_sha256:sourcePlanSha256,
        at:'2026-07-27T00:00:00.000Z',replan_epoch:replanned.replan_epoch,
        approval_operation_id:planOperationId})}));
    const completed=await dispatch(['replan','complete','--state',f.statePath,
      '--plan',f.planCapability.path],{cwd:f.root});
    assert.equal(completed.epoch_id,replanned.replan_epoch);
    const fields=frontmatter.parseFrontmatter(
      fs.readFileSync(f.statePath,'utf8')).fields;
    assert.equal(fields.replan_required,false);
    assert.equal(fields.active_replan_epoch_id,null);
    const replay=await dispatch(['replan','complete','--state',f.statePath,
      '--plan',f.planCapability.path],{cwd:f.root});
    assert.equal(replay.adopted,true);
  });

node26Test('strict scoped-write acceptance converts expanded scope into needs-replan authority',
  async(t)=>{
    const f=fixture(t);
    const scope=deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test'});
    const begun=await beginScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test',expectedScopeSha256:scope.sha256});
    fs.writeFileSync(path.join(f.root,'runtime','a.test.js'),f.failing);
    fs.writeFileSync(path.join(f.root,'runtime','a.js'),'module.exports=99;\n');
    const result=await acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256});
    assert.equal(result.status,'needs-replan');
    assert.equal(result.observationKind,'scope-expansion');
    assert.match(result.acceptOrReplanOperationId,/^op-[0-9a-f]{64}$/);
    const fields=frontmatter.parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields;
    assert.equal(fields.replan_required,true);
    assert.equal(fields.replan_reason,'scope-expansion');
    assert.equal(fields.active_slice,null);
    assert.equal(fields.accepted_write_operation_id,null);
    const needsPath=path.join(f.root,'.deep-work','s-aaaaaaaa','receipts',
      `write-${begun.operationId}-needs-replan.json`);
    const needsBytes=fs.readFileSync(needsPath);
    const tamperedNeeds=JSON.parse(needsBytes);
    tamperedNeeds.affected_paths=['runtime/forged.js'];
    fs.writeFileSync(needsPath,journal.canonicalJson(tamperedNeeds));
    await assert.rejects(()=>acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256}),
    /accept-or-replan-receipt/);
    fs.writeFileSync(needsPath,needsBytes);
    const replay=await acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256});
    assert.equal(replay.status,'needs-replan');
    assert.equal(replay.acceptOrReplanOperationId,result.acceptOrReplanOperationId);
  });

node26Test('strict scoped-write acceptance treats an authorized-path race as manifest divergence',
  async(t)=>{
    const f=fixture(t);
    const scope=deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test'});
    const begun=await beginScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test',expectedScopeSha256:scope.sha256});
    fs.writeFileSync(path.join(f.root,'runtime','a.test.js'),f.failing);
    const result=await acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256,
      seam:(stage)=>{
        if(stage==='after-candidate-post-manifest')
          fs.appendFileSync(path.join(f.root,'runtime','a.test.js'),'// raced\n');
      }});
    assert.equal(result.status,'needs-replan');
    assert.equal(result.observationKind,'manifest-divergence');
    assert.deepEqual(result.needsReplanReceipt.affected_paths,['runtime/a.test.js']);
  });

node26Test('accept-or-replan recovers after invalidation state write before its durable stage',
  async(t)=>{
    const f=fixture(t);
    const scope=deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test'});
    const begun=await beginScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test',expectedScopeSha256:scope.sha256});
    fs.writeFileSync(path.join(f.root,'runtime','a.test.js'),f.failing);
    fs.writeFileSync(path.join(f.root,'runtime','a.js'),'module.exports=99;\n');
    let crashed=false;
    await assert.rejects(()=>acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256,
      seam:(stage)=>{
        if(!crashed&&stage==='after-invalidation-state-write-before-stage'){
          crashed=true;throw new Error('crash-after-invalidation');
        }
      }}),/crash-after-invalidation/);
    const pending=frontmatter.parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields;
    assert.equal(JSON.parse(pending.pending_scoped_write_json).stage,'accept-or-replan');
    const recovered=await acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256});
    assert.equal(recovered.status,'needs-replan');
    assert.equal(frontmatter.parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields
      .pending_scoped_write_json,null);
  });

node26Test('accept-or-replan completes its child ledger after parent completion return loss',
  async(t)=>{
    const f=fixture(t);
    const scope=deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test'});
    const begun=await beginScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      writeClass:'failing-test',expectedScopeSha256:scope.sha256});
    fs.writeFileSync(path.join(f.root,'runtime','a.test.js'),f.failing);
    fs.writeFileSync(path.join(f.root,'runtime','a.js'),'module.exports=99;\n');
    await assert.rejects(()=>acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256,
      seam:(stage)=>{
        if(stage==='after-parent-ledger-before-child-resolution')
          throw new Error('lost-parent-result');
      }}),/lost-parent-result/);
    const recovered=await acceptScopedWrite({stateCapability:f.stateCapability,
      planCapability:f.planCapability,plan:f.plan,sliceId:'SLICE-001',
      operationId:begun.operationId,preManifestSha256:begun.preManifestSha256});
    assert.equal(recovered.status,'needs-replan');
    assert.equal(recovered.acceptOrReplanReceipt.stage,'completed-ledger');
    assert.equal(frontmatter.parseFrontmatter(fs.readFileSync(f.statePath,'utf8')).fields
      .pending_scoped_write_json,null);
  });
