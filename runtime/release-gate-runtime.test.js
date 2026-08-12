'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const gate=require('./release-gate-runtime.js');
const journal=require('./operation-journal.js');
const platform=require('./platform.js');
const transaction=require('./transaction-runtime.js');
const frontmatter=require('./frontmatter.js');
const {compileImmutablePlanAuthorityV2}=require('./plan-runtime.js');
const {loadGovernedContext}=require('./governed-context-runtime.js');
const {dispatch}=require('../scripts/deep-work-runtime.js');

test('release gate catalog fixes all command argv and every release gate exactly once',()=>{
  assert.deepEqual(Object.keys(gate.RELEASE_GATE_CATALOG),
    ['carrier','tdd','replan','integration','targeted','full','pack']);
  assert.deepEqual(gate.RELEASE_GATE_CATALOG.targeted.argv,['node','--test',
    'runtime/functional-receipt-runtime.test.js',
    'tests/context-engineering-context-contract.test.js',
    'tests/context-engineering-receipt-contract.test.js',
    'tests/skill-reference-integrity.test.js']);
  assert.deepEqual(gate.RELEASE_GATE_CATALOG.targeted.gate_ids,[
    'GATE-context-contract','GATE-receipt-lock-order',
    'GATE-reference-integrity','GATE-targeted-tests']);
  assert.deepEqual(gate.RELEASE_GATE_CATALOG.full.argv,['npm','test']);
  assert.deepEqual(gate.RELEASE_GATE_CATALOG.full.gate_ids,
    ['GATE-full-relevant-suite','GATE-full-suite']);
  assert.deepEqual(gate.RELEASE_GATE_CATALOG.pack.argv,
    ['npm','pack','--dry-run','--json']);
  const ids=Object.values(gate.RELEASE_GATE_CATALOG)
    .flatMap((row)=>row.gate_ids)
    .concat(Object.values(gate.DETERMINISTIC_GATE_MAPPING).flat());
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(ids.length,36);
});

test('GateFactArtifactV1 separates semantic facts and raw artifact digests',()=>{
  const facts={changed_paths:['README.md','runtime/a.js'],
    checked_paths:['runtime/a.js'],failure_paths:[]};
  const artifact=gate.buildGateFactArtifact('changed-js-syntax-v1',facts);
  const validated=gate.validateGateFactArtifact(artifact);
  assert.equal(validated.blocking_codes.length,0);
  assert.notEqual(artifact.facts_sha256,validated.facts_artifact_sha256);
  const tampered=structuredClone(artifact);
  tampered.facts.checked_paths=[];
  assert.throws(()=>gate.validateGateFactArtifact(tampered),/gate-fact-artifact/);
});

test('deterministic fact validators emit only their closed blocker vocabulary',()=>{
  const integrity={manifest_versions:{claude:'6.14.0',codex:'6.14.0'},
    package_version:'6.14.0',runtime_version:'6.14.0',
    docs_rule_sha256:'a'.repeat(64),v7_surface_violations:[],
    git_state:{head:'b'.repeat(40),branch:'worktree-v6-14',dirty:false,
      changed_paths:[]},external_effect_operation_ids:[]};
  assert.deepEqual(gate.computeBlockingCodes('release-integrity-v1',integrity),[]);
  integrity.git_state.dirty=true;
  integrity.git_state.changed_paths=['runtime/untracked.js'];
  assert.deepEqual(gate.computeBlockingCodes('release-integrity-v1',integrity),
    ['git-dirty']);
  integrity.git_state.dirty=false;
  integrity.git_state.changed_paths=[];
  integrity.runtime_version='7.0.0';
  integrity.external_effect_operation_ids=[`op-${'c'.repeat(64)}`];
  assert.deepEqual(gate.computeBlockingCodes('release-integrity-v1',integrity),
    ['external-effect-seen','version-mismatch']);
  assert.throws(()=>gate.computeBlockingCodes('release-integrity-v1',{
    ...integrity,caller_note:'forged'}),/release-gate-facts/);
});

test('release integrity treats v7 surfaces as active after the v7 migration',()=>{
  const versions=[['.claude-plugin/plugin.json','7.1.4'],
    ['.codex-plugin/plugin.json','6.14.0'],['package.json','6.14.0']];
  assert.deepEqual(gate.legacyV7SurfaceViolations({
    activeVersion:'7.1.4',versions}),[]);
  assert.deepEqual(gate.legacyV7SurfaceViolations({
    activeVersion:'6.14.0',versions}),['.claude-plugin/plugin.json']);
});

test('CheckerInputCatalogV1 rejects wrong roles, duplicates, and caller ordering',()=>{
  const refs=['spec-approval','spec-contract','spec-gate-result'].map((kind,index)=>({
    kind,path:`.deep-work/s-aaaaaaaa/${kind}.json`,sha256:String(index+1).repeat(64),
    producer_operation_id:`op-${String(index+4).repeat(64)}`}));
  assert.deepEqual(gate.validateCheckerInputRefs('spec-gate-v1',refs),refs);
  assert.throws(()=>gate.validateCheckerInputRefs('spec-gate-v1',
    [refs[1],refs[0],refs[2]]),/checker-input-catalog/);
  assert.throws(()=>gate.validateCheckerInputRefs('spec-gate-v1',
    [refs[0],refs[0],refs[2]]),/checker-input-catalog/);
});

test('GateResultV1 derives deterministic status and GateResultRefV1 binds its producer',()=>{
  const facts={changed_paths:['runtime/a.js'],checked_paths:['runtime/a.js'],
    failure_paths:[]};
  const artifact=gate.buildGateFactArtifact('changed-js-syntax-v1',facts);
  const artifactSha256=gate.validateGateFactArtifact(artifact).facts_artifact_sha256;
  const factsRef={kind:'gate-fact',
    path:`.deep-work/s-aaaaaaaa/gate-facts/changed-js-syntax-v1-${artifact.facts_sha256}.json`,
    sha256:artifactSha256,producer_operation_id:`op-${'7'.repeat(64)}`};
  const result=gate.buildDeterministicGateResult({
    sessionId:'s-aaaaaaaa',planAuthoritySha256:'1'.repeat(64),
    verificationPlanSha256:'2'.repeat(64),checkerId:'changed-js-syntax-v1',
    gateIds:['GATE-impacted-lint-typecheck'],factsRef,artifact});
  assert.equal(result.status,'passed');
  assert.equal(gate.validateGateResult(result).result.passed,true);
  const ref={gate_id:'GATE-impacted-lint-typecheck',
    operation_id:`op-${'8'.repeat(64)}`,
    result_path:`.deep-work/s-aaaaaaaa/gate-results/op-${'8'.repeat(64)}.json`,
    result_sha256:result.result_sha256,ledger_result_sha256:'9'.repeat(64),
    checker_id:'changed-js-syntax-v1',argv_sha256:gate.argvSha256([])};
  assert.deepEqual(gate.validateGateResultRef(ref),ref);
  assert.throws(()=>gate.validateGateResult({...result,status:'failed'}),
    /gate-result/);
});

test('command GateResultV1 rejects a caller-forged pass on timeout',()=>{
  const result=gate.buildCommandGateResult({sessionId:'s-aaaaaaaa',
    planAuthoritySha256:'1'.repeat(64),verificationPlanSha256:'2'.repeat(64),
    commandId:'full',inputRefs:[],releaseEnvironmentSha256:'3'.repeat(64),
    processResult:{exit_code:null,signal:'SIGTERM',timed_out:true,
      output_overflow:false,stdout_sha256:'4'.repeat(64),stderr_sha256:'5'.repeat(64)}});
  assert.equal(result.status,'failed');
  assert.throws(()=>gate.validateGateResult({...result,status:'passed'}),
    /gate-result/);
});

test('ReleaseVerificationReceiptV1 rejects content changed after publication',()=>{
  const value={schema_version:1,slice_id:'SLICE-001',
    plan_authority_sha256:'1'.repeat(64),
    verification_plan_sha256:'2'.repeat(64),
    gate_results:[{gate_id:'GATE-full-relevant-suite',
      operation_id:`op-${'3'.repeat(64)}`,
      result_path:`.deep-work/s-aaaaaaaa/gate-results/op-${'3'.repeat(64)}.json`,
      result_sha256:'4'.repeat(64),ledger_result_sha256:'5'.repeat(64),
      checker_id:'command-v1',argv_sha256:gate.argvSha256(['npm','test'])}],
    functional_receipts:[],completion_operation_id:`op-${'6'.repeat(64)}`,
    receipt_sha256:null};
  value.receipt_sha256=journal.sha256(journal.canonicalJson(
    Object.fromEntries(Object.entries(value).filter(([key])=>
      key!=='receipt_sha256'))));
  assert.equal(gate.validateReleaseVerificationReceipt(value).slice_id,
    'SLICE-001');
  assert.throws(()=>gate.validateReleaseVerificationReceipt({
    ...value,verification_plan_sha256:'7'.repeat(64)}),
  /release-verification-receipt/);
});

test('invalidated release receipts accept only native numeric v1 shape and use ranked target locks',(t)=>{
  assert.equal(gate.isInvalidatedReleaseReceipt({schema_version:1,
    status:'invalidated'}),true);
  assert.equal(gate.isInvalidatedReleaseReceipt({schema_version:'1.0',
    status:'invalidated'}),true);
  assert.equal(gate.isInvalidatedReleaseReceipt({schema_version:2,
    status:'invalidated'}),false);
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-release-locks-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const locks=gate.releaseReceiptTargetLocks({root,
    planPath:path.join(root,'.deep-work/s-aaaaaaaa/plan.json'),
    receiptPath:path.join(root,'.deep-work/s-aaaaaaaa/receipts/SLICE-001.json')});
  assert.deepEqual(locks.map((row)=>row.rank),[70,70]);
  assert.ok(locks.every((row)=>row.capability.role==='lock'));
  assert.deepEqual(locks.map((row)=>row.capability.path),[...locks]
    .map((row)=>row.capability.path).sort((a,b)=>Buffer.compare(
      Buffer.from(a),Buffer.from(b))));
});

test('gate-fact-publish authenticates catalog inputs and adopts exact fact bytes',
  async(t)=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-gate-fact-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
    const sessionId='s-aaaaaaaa';
    const work=path.join(root,'.deep-work',sessionId);fs.mkdirSync(work,{recursive:true});
    const statePath=path.join(root,'.claude',`deep-work.${sessionId}.md`);
    fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',{
      session_id:sessionId,work_dir:`.deep-work/${sessionId}`,
      current_phase:'test',verification_plan_sha256:'2'.repeat(64),
      spec_approval_operation_id:`op-${'7'.repeat(64)}`,
      spec_approved_hash:'6'.repeat(64),
      spec_contract_json:journal.canonicalJson({
        spec_sha256:'5'.repeat(64)}),
      spec_gate_result_json:journal.canonicalJson({pass:true,
        requirement_coverage:{total:1,covered:1,uncovered_ids:[],ratio:1},
        failure_matrix_coverage:{total:1,covered:1,uncovered_ids:[],ratio:1}})}));
    const stateCapability=platform.issueProjectStateCapability(root,statePath,
      {role:'session-state'});
    const sessionCapability=platform.issueProjectStateCapability(root,work,{
      role:'session-work-dir',sessionStateCapability:stateCapability});
    const planCapability=transaction.issueSessionFileCapability({sessionCapability,
      candidate:path.join(work,'plan.json'),allowedBasenames:['plan.json'],
      allowMissingLeaf:true,role:'locked-plan'});
    const facts={schema_version:1,authority:'reviewed-plan',destructive:false,
      external_action:false,has_backward_compat:true,has_migration:true,
      host_dependent:false,source_requirement_ids:['REQ-001'],
      source_slice_ids:['SLICE-001']};
    facts.facts_sha256=gate.semanticDigest('capability-facts-v1',facts);
    const plan={schema_version:2,replan_epoch:null,contract_binding:{
      mode:'strict-spec',created_by_version:'6.14.0',source_plan_sha256:'3'.repeat(64),
      risk_profile_sha256:'4'.repeat(64),spec_contract:{schema_version:1,
        spec_id:'SPEC-GATE',spec_sha256:'5'.repeat(64),
        spec_approved_hash:'6'.repeat(64)}},capability_facts:facts,slices:[{
      id:'SLICE-001',slice_kind:'release-verification',checked:false,
      scope_schema_version:1,files:[],write_scope:{failing_test:[],production:[],
        refactor:[]},verification_scope:['npm test'],
      release_gate_ids:[...gate.DETERMINISTIC_GATE_MAPPING['spec-gate-v1']],
      verification_spec:null,verification_spec_sha256:null}]};
    plan.plan_authority_sha256=
      compileImmutablePlanAuthorityV2(plan).plan_authority_sha256;
    fs.writeFileSync(planCapability.path,journal.canonicalJson(plan));
    const inputs={
      'spec-approval':{spec_approved_hash:'6'.repeat(64)},
      'spec-contract':{spec_sha256:'5'.repeat(64)},
      'spec-gate-result':{pass:true,requirement_coverage:{
        total:1,covered:1,uncovered_ids:[],ratio:1},failure_matrix_coverage:{
        total:1,covered:1,uncovered_ids:[],ratio:1}},
    };
    const project=transaction.projectCapabilityFor(stateCapability),refs=[];
    let index=7;
    for(const [kind,value] of Object.entries(inputs)){
      const operationId=`op-${String(index).repeat(64)}`;index++;
      const operation=await journal.beginOperation({projectCapability:project,
        sessionId,kind:'phase-approval',operationId,preconditions:{kind}});
      await journal.recordOperationStage(operation,'state-written',{owned:{kind}});
      await journal.completeOperation(operation,{status:'completed',kind});
      const relative=`.deep-work/${sessionId}/release-inputs/${kind}.json`;
      const target=path.join(root,...relative.split('/'));
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,journal.canonicalJson(value));
      refs.push({kind,path:relative,sha256:journal.sha256(
        journal.canonicalJson(value)),producer_operation_id:operationId});
    }
    const refsPath=path.join(root,'input-refs.json');
    fs.writeFileSync(refsPath,journal.canonicalJson(refs));
    await assert.rejects(()=>dispatch(['release','gate','fact-publish',
      '--state',statePath,'--plan',planCapability.path,'--checker',
      'spec-gate-v1','--input-refs-json',refsPath],{cwd:root}),
    /gate-input-producer/);
    const specApprovalOperationId=`op-${'a'.repeat(64)}`;
    fs.writeFileSync(statePath,frontmatter.updateFrontmatterText(
      fs.readFileSync(statePath,'utf8'),{
        spec_approval_operation_id:specApprovalOperationId,
        spec_approved_hash:'6'.repeat(64),
        spec_contract_json:journal.canonicalJson(inputs['spec-contract']),
        spec_gate_result_json:journal.canonicalJson(inputs['spec-gate-result'])}));
    const approvalOperation=await journal.beginOperation({
      projectCapability:project,sessionId,kind:'phase-approval',
      operationId:specApprovalOperationId,preconditions:{phase:'spec'}});
    await journal.recordOperationStage(approvalOperation,'state-written',{
      owned:{phase:'spec'}});
    await journal.completeOperation(approvalOperation,{status:'completed',
      statePath,stateSha256:'b'.repeat(64),patchSha256:'c'.repeat(64)});
    for(const ref of refs)ref.producer_operation_id=specApprovalOperationId;
    fs.writeFileSync(refsPath,journal.canonicalJson(refs));
    const contractRef=refs.find((ref)=>ref.kind==='spec-contract');
    const contractPath=path.join(root,...contractRef.path.split('/'));
    const contractBytes=fs.readFileSync(contractPath);
    const forgedContract={spec_sha256:'d'.repeat(64)};
    fs.writeFileSync(contractPath,journal.canonicalJson(forgedContract));
    contractRef.sha256=journal.sha256(journal.canonicalJson(forgedContract));
    fs.writeFileSync(refsPath,journal.canonicalJson(refs));
    await assert.rejects(()=>dispatch(['release','gate','fact-publish',
      '--state',statePath,'--plan',planCapability.path,'--checker',
      'spec-gate-v1','--input-refs-json',refsPath],{cwd:root}),
    /gate-input-producer/);
    fs.writeFileSync(contractPath,contractBytes);
    contractRef.sha256=journal.sha256(contractBytes);
    fs.writeFileSync(refsPath,journal.canonicalJson(refs));
    const published=await dispatch(['release','gate','fact-publish','--state',
      statePath,'--plan',planCapability.path,'--checker','spec-gate-v1',
      '--input-refs-json',refsPath],{cwd:root});
    assert.match(published.facts_sha256,/^[0-9a-f]{64}$/);
    const stored=JSON.parse(fs.readFileSync(path.join(root,
      ...published.facts_path.split('/')),'utf8'));
    assert.equal(stored.facts.pass,true);
    const replay=await gate.publishGateFact({stateCapability,planCapability,
      plan,checkerId:'spec-gate-v1',inputRefs:refs});
    assert.equal(replay.adopted,true);
    const result=await dispatch(['release','gate','result-publish','--state',
      statePath,'--plan',planCapability.path,'--fact-operation-id',
      published.operation_id],{cwd:root});
    assert.equal(result.status,'passed');
    assert.equal(result.gate_result_refs.length,4);
    assert.ok(result.gate_result_refs.every((ref)=>
      ref.operation_id===result.operation_id));
    const resultReplay=await gate.publishDeterministicGateResult({
      stateCapability,planCapability,plan,factOperationId:published.operation_id});
    assert.equal(resultReplay.adopted,true);
    const gateRefsPath=path.join(root,'gate-refs.json');
    const functionalRefsPath=path.join(root,'functional-refs.json');
    fs.writeFileSync(gateRefsPath,journal.canonicalJson(result.gate_result_refs));
    fs.writeFileSync(functionalRefsPath,'[]');
    const completed=await dispatch(['release','verification','complete','--state',
      statePath,'--plan',planCapability.path,'--slice','SLICE-001',
      '--gate-results-json',gateRefsPath,'--functional-receipts-json',
      functionalRefsPath],{cwd:root});
    assert.match(completed.receipt_sha256,/^[0-9a-f]{64}$/);
    const completedPlan=JSON.parse(fs.readFileSync(planCapability.path,'utf8'));
    assert.equal(completedPlan.slices[0].checked,true);
    const governed=loadGovernedContext({stateCapability});
    assert.deepEqual(governed.projection.receipts.rows,[{
      slice_id:'SLICE-001',slice_kind:'release-verification',status:'complete',
      receipt_sha256:completed.receipt_sha256}]);
    const completionReplay=await gate.publishReleaseVerificationReceipt({
      stateCapability,planCapability,plan:completedPlan,sliceId:'SLICE-001',
      gateResults:result.gate_result_refs,functionalReceipts:[]});
    assert.equal(completionReplay.adopted,true);
  });

test('release integrity rejects a caller-authored empty external-operation index',
  async(t)=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
      'dw-integrity-input-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
    const sessionId='s-aaaaaaaa';
    const work=path.join(root,'.deep-work',sessionId);
    fs.mkdirSync(work,{recursive:true});
    const statePath=path.join(root,'.claude',`deep-work.${sessionId}.md`);
    fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',{
      session_id:sessionId,work_dir:`.deep-work/${sessionId}`,
      current_phase:'test',verification_plan_sha256:'2'.repeat(64)}));
    const stateCapability=platform.issueProjectStateCapability(root,statePath,
      {role:'session-state'});
    const sessionCapability=platform.issueProjectStateCapability(root,work,{
      role:'session-work-dir',sessionStateCapability:stateCapability});
    const planCapability=transaction.issueSessionFileCapability({
      sessionCapability,candidate:path.join(work,'plan.json'),
      allowedBasenames:['plan.json'],allowMissingLeaf:true,role:'locked-plan'});
    const facts={schema_version:1,authority:'reviewed-plan',destructive:false,
      external_action:false,has_backward_compat:true,has_migration:true,
      host_dependent:false,source_requirement_ids:['REQ-001'],
      source_slice_ids:['SLICE-001']};
    facts.facts_sha256=gate.semanticDigest('capability-facts-v1',facts);
    const plan={schema_version:2,replan_epoch:null,contract_binding:{
      mode:'strict-spec',created_by_version:'6.14.0',
      source_plan_sha256:'3'.repeat(64),
      risk_profile_sha256:'4'.repeat(64),spec_contract:{schema_version:1,
        spec_id:'SPEC-INTEGRITY',spec_sha256:'5'.repeat(64),
        spec_approved_hash:'6'.repeat(64)}},capability_facts:facts,slices:[{
      id:'SLICE-001',slice_kind:'release-verification',checked:false,
      scope_schema_version:1,files:[],write_scope:{failing_test:[],
        production:[],refactor:[]},verification_scope:['release integrity'],
      release_gate_ids:[...gate.DETERMINISTIC_GATE_MAPPING[
        'release-integrity-v1']],
      verification_spec:null,verification_spec_sha256:null}]};
    plan.plan_authority_sha256=
      compileImmutablePlanAuthorityV2(plan).plan_authority_sha256;
    fs.writeFileSync(planCapability.path,journal.canonicalJson(plan));
    const values={
      'claude-manifest':{version:'6.14.0'},
      'codex-manifest':{version:'6.14.0'},
      'docs-rule':{authority:'caller'},
      'external-operation-index':{operation_ids:[]},
      'git-snapshot':{head:'a'.repeat(40),branch:'fixture',dirty:false,
        changed_paths:[]},
      'package-manifest':{version:'6.14.0'},
      'runtime-version':{version:'6.14.0',v7_surface_violations:[]}};
    const project=transaction.projectCapabilityFor(stateCapability);
    const producerOperationId=`op-${'d'.repeat(64)}`;
    const operation=await journal.beginOperation({projectCapability:project,
      sessionId,kind:'evidence-capture',operationId:producerOperationId,
      preconditions:{caller:true}});
    await journal.recordOperationStage(operation,'state-written',{
      owned:{caller:true}});
    await journal.completeOperation(operation,{status:'completed',
      kind:'caller-capture'});
    const refs=[];
    for(const [kind,value] of Object.entries(values)){
      const relative=`.deep-work/${sessionId}/release-inputs/${kind}.json`;
      const target=path.join(root,...relative.split('/'));
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,journal.canonicalJson(value));
      refs.push({kind,path:relative,sha256:journal.sha256(
        journal.canonicalJson(value)),producer_operation_id:producerOperationId});
    }
    refs.sort((left,right)=>Buffer.compare(Buffer.from(
      `${left.kind}\0${left.path}\0${left.sha256}\0${
        left.producer_operation_id}`),Buffer.from(
      `${right.kind}\0${right.path}\0${right.sha256}\0${
        right.producer_operation_id}`)));
    const refsPath=path.join(root,'input-refs.json');
    fs.writeFileSync(refsPath,journal.canonicalJson(refs));
    await assert.rejects(()=>dispatch(['release','gate','fact-publish',
      '--state',statePath,'--plan',planCapability.path,'--checker',
      'release-integrity-v1','--input-refs-json',refsPath],{cwd:root}),
    /gate-input-producer/);
  });

test('integrity-run derives trusted release inputs and publishes GATE-clean-build',
  async(t)=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
      'dw-integrity-run-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'.claude-plugin'),{recursive:true});
    fs.mkdirSync(path.join(root,'.codex-plugin'),{recursive:true});
    fs.mkdirSync(path.join(root,'.claude'));
    fs.mkdirSync(path.join(root,'docs'));
    fs.writeFileSync(path.join(root,'package.json'),journal.canonicalJson({
      name:'deep-work-integrity-fixture',version:'6.14.0',
      scripts:{test:'node --test fixture.test.js'}}));
    fs.writeFileSync(path.join(root,'.claude-plugin','plugin.json'),
      journal.canonicalJson({name:'deep-work',version:'6.14.0'}));
    fs.writeFileSync(path.join(root,'.codex-plugin','plugin.json'),
      journal.canonicalJson({name:'deep-work',version:'6.14.0'}));
    fs.writeFileSync(path.join(root,'docs','DOCS_RULE.md'),'# Docs rule\n');
    fs.writeFileSync(path.join(root,'fixture.test.js'),
      "'use strict';\nrequire('node:test')('fixture',()=>{});\n");
    for(const args of [['init','-q'],['config','user.email',
      'fixture@example.invalid'],['config','user.name','Fixture'],
      ['add','package.json','.claude-plugin/plugin.json',
        '.codex-plugin/plugin.json','docs/DOCS_RULE.md','fixture.test.js'],
      ['commit','-qm','fixture']]){
      const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
    }
    const sessionId='s-aaaaaaaa',work=path.join(root,'.deep-work',sessionId);
    fs.mkdirSync(work,{recursive:true});
    const statePath=path.join(root,'.claude',`deep-work.${sessionId}.md`);
    fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',{
      session_id:sessionId,work_dir:`.deep-work/${sessionId}`,
      current_phase:'test',verification_plan_sha256:'2'.repeat(64)}));
    const stateCapability=platform.issueProjectStateCapability(root,statePath,
      {role:'session-state'});
    const sessionCapability=platform.issueProjectStateCapability(root,work,{
      role:'session-work-dir',sessionStateCapability:stateCapability});
    const planCapability=transaction.issueSessionFileCapability({
      sessionCapability,candidate:path.join(work,'plan.json'),
      allowedBasenames:['plan.json'],allowMissingLeaf:true,role:'locked-plan'});
    const facts={schema_version:1,authority:'reviewed-plan',destructive:false,
      external_action:false,has_backward_compat:true,has_migration:true,
      host_dependent:false,source_requirement_ids:['REQ-001'],
      source_slice_ids:['SLICE-001']};
    facts.facts_sha256=gate.semanticDigest('capability-facts-v1',facts);
    const plan={schema_version:2,replan_epoch:null,contract_binding:{
      mode:'strict-spec',created_by_version:'6.14.0',
      source_plan_sha256:'3'.repeat(64),
      risk_profile_sha256:'4'.repeat(64),spec_contract:{schema_version:1,
        spec_id:'SPEC-INTEGRITY',spec_sha256:'5'.repeat(64),
        spec_approved_hash:'6'.repeat(64)}},capability_facts:facts,slices:[{
      id:'SLICE-001',slice_kind:'release-verification',checked:false,
      scope_schema_version:1,files:[],write_scope:{failing_test:[],
        production:[],refactor:[]},verification_scope:['release integrity'],
      release_gate_ids:[...gate.DETERMINISTIC_GATE_MAPPING[
        'release-integrity-v1']],
      verification_spec:null,verification_spec_sha256:null}]};
    plan.plan_authority_sha256=
      compileImmutablePlanAuthorityV2(plan).plan_authority_sha256;
    fs.writeFileSync(planCapability.path,journal.canonicalJson(plan));
    const published=await dispatch(['release','gate','integrity-run','--state',
      statePath,'--plan',planCapability.path],{cwd:root});
    assert.equal(published.status,'passed');
    assert.deepEqual(published.gate_result_refs.map((row)=>row.gate_id),
      ['GATE-clean-build']);
    const project=transaction.projectCapabilityFor(stateCapability);
    const external=await journal.beginOperation({projectCapability:project,
      sessionId,kind:'remote-push',operationId:`op-${'e'.repeat(64)}`,
      preconditions:{remote:'origin'}});
    await journal.completeOperation(external,{status:'pushed'});
    const blocked=await dispatch(['release','gate','integrity-run','--state',
      statePath,'--plan',planCapability.path],{cwd:root});
    assert.equal(blocked.status,'failed');
    const blockedResult=JSON.parse(fs.readFileSync(path.join(root,
      ...blocked.result_path.split('/')),'utf8'));
    assert.deepEqual(blockedResult.result.blocking_codes,
      ['external-effect-seen']);
  });

test('command-run publishes an authenticated pack GateResult through the dispatcher',
  {skip:process.platform==='win32'},async(t)=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
      'dw-command-gate-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'.claude'));
    fs.writeFileSync(path.join(root,'package.json'),journal.canonicalJson({
      name:'deep-work-command-gate-fixture',version:'1.0.0',
      scripts:{test:'node --test fixture.test.js'}}));
    fs.writeFileSync(path.join(root,'fixture.test.js'),
      "'use strict';\nrequire('node:test')('fixture',()=>{});\n");
    for(const args of [['init','-q'],['config','user.email','fixture@example.invalid'],
      ['config','user.name','Fixture'],['add','package.json','fixture.test.js'],
      ['commit','-qm','fixture']]){
      const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});
      assert.equal(result.status,0,result.stderr);
    }
    const sessionId='s-aaaaaaaa',work=path.join(root,'.deep-work',sessionId);
    fs.mkdirSync(work,{recursive:true});
    const statePath=path.join(root,'.claude',`deep-work.${sessionId}.md`);
    fs.writeFileSync(statePath,frontmatter.updateFrontmatterText('',{
      session_id:sessionId,work_dir:`.deep-work/${sessionId}`,
      current_phase:'test',verification_plan_sha256:'2'.repeat(64)}));
    const stateCapability=platform.issueProjectStateCapability(root,statePath,
      {role:'session-state'});
    const sessionCapability=platform.issueProjectStateCapability(root,work,{
      role:'session-work-dir',sessionStateCapability:stateCapability});
    const planCapability=transaction.issueSessionFileCapability({
      sessionCapability,candidate:path.join(work,'plan.json'),
      allowedBasenames:['plan.json'],allowMissingLeaf:true,role:'locked-plan'});
    const facts={schema_version:1,authority:'reviewed-plan',destructive:false,
      external_action:false,has_backward_compat:true,has_migration:true,
      host_dependent:false,source_requirement_ids:['REQ-001'],
      source_slice_ids:['SLICE-001']};
    facts.facts_sha256=gate.semanticDigest('capability-facts-v1',facts);
    const plan={schema_version:2,replan_epoch:null,contract_binding:{
      mode:'strict-spec',created_by_version:'6.14.0',
      source_plan_sha256:'3'.repeat(64),
      risk_profile_sha256:'4'.repeat(64),spec_contract:{schema_version:1,
        spec_id:'SPEC-COMMAND',spec_sha256:'5'.repeat(64),
        spec_approved_hash:'6'.repeat(64)}},capability_facts:facts,slices:[{
      id:'SLICE-001',slice_kind:'release-verification',checked:false,
      scope_schema_version:1,files:[],write_scope:{failing_test:[],
        production:[],refactor:[]},verification_scope:[
        'npm pack --dry-run --json'],
      release_gate_ids:['GATE-fresh-install-build'],
      verification_spec:null,verification_spec_sha256:null}]};
    plan.plan_authority_sha256=
      compileImmutablePlanAuthorityV2(plan).plan_authority_sha256;
    fs.writeFileSync(planCapability.path,journal.canonicalJson(plan));
    const published=await dispatch(['release','gate','command-run','--state',
      statePath,'--plan',planCapability.path,'--command','pack'],{cwd:root});
    assert.equal(published.status,'passed');
    assert.deepEqual(published.gate_result_refs.map((row)=>row.gate_id),
      ['GATE-fresh-install-build']);
    const stored=JSON.parse(fs.readFileSync(path.join(root,
      ...published.result_path.split('/')),'utf8'));
    assert.equal(stored.checker_id,'command-v1');
    assert.equal(stored.status,'passed');
    const gateRefsPath=path.join(root,'gate-refs.json');
    const functionalRefsPath=path.join(root,'functional-refs.json');
    fs.writeFileSync(gateRefsPath,journal.canonicalJson(
      published.gate_result_refs));
    fs.writeFileSync(functionalRefsPath,'[]');
    const graphPath=path.join(root,...stored.input_refs[0].path.split('/'));
    const graphBytes=fs.readFileSync(graphPath);
    fs.appendFileSync(graphPath,' ');
    await assert.rejects(()=>dispatch(['release','verification','complete',
      '--state',statePath,'--plan',planCapability.path,'--slice','SLICE-001',
      '--gate-results-json',gateRefsPath,'--functional-receipts-json',
      functionalRefsPath],{cwd:root}),/release-verification-gates/);
    fs.writeFileSync(graphPath,graphBytes);
    const completed=await dispatch(['release','verification','complete',
      '--state',statePath,'--plan',planCapability.path,'--slice','SLICE-001',
      '--gate-results-json',gateRefsPath,'--functional-receipts-json',
      functionalRefsPath],{cwd:root});
    assert.match(completed.receipt_sha256,/^[0-9a-f]{64}$/);
    assert.equal(loadGovernedContext({stateCapability}).projection.receipts
      .rows[0].status,'complete');
    const replay=await dispatch(['release','gate','command-run','--state',
      statePath,'--plan',planCapability.path,'--command','pack'],{cwd:root});
    assert.equal(replay.adopted,true);
    assert.equal(replay.operation_id,published.operation_id);
  });
