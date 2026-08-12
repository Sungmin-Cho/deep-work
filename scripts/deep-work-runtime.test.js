'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('structured dispatcher rejects plan.md input', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-json-only-')));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude'));
  const workDir = path.join(root, '.deep-work', 's-1234abcd');
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'deep-work.s-1234abcd.md'), [
    '---', 'session_id: s-1234abcd', 'work_dir: .deep-work/s-1234abcd',
    'current_phase: implement', '---', '', '# state',
  ].join('\n'));
  fs.writeFileSync(path.join(workDir, 'plan.md'), JSON.stringify({ schema_version: 1, slices: [] }));
  const { helpers } = require('../runtime/dispatcher-routes.js');
  assert.throws(
    () => helpers.readPlan({
      state: path.join(root, '.claude', 'deep-work.s-1234abcd.md'),
      plan: path.join(workDir, 'plan.md'),
    }, root),
    (error) => error && error.code === 'plan-json-only'
  );
});
const crypto = require('node:crypto');
const artifactRuntime = require('../runtime/artifact-runtime.js');
const platform = require('../runtime/platform.js');
const { updateFrontmatterText, parseFrontmatter } = require('../runtime/frontmatter.js');
const { canonicalJson } = require('../runtime/operation-journal.js');
const { parseSpecMarkdown, specContractDigest } = require('../runtime/contract-runtime.js');
const { compilePlanProjectionV1 } = require('../runtime/plan-runtime.js');
const { compileVerificationPlan, requiredGateIds } = require('../runtime/verification-policy-runtime.js');
const evidenceRuntime = require('../runtime/evidence-runtime.js');
const bootstrapRuntime = require('../runtime/bootstrap-runtime.js');
const redProofRuntime = require('../runtime/red-proof-runtime.js');
const verificationV2Runtime = require('../runtime/verification-v2-runtime.js');
const { compileReviewPlan } = require('../runtime/review-policy-runtime.js');
const { DISPATCHER_GRAMMAR, PHASE5_DISPATCHER_COMMANDS, DISPATCHER_HANDLERS,
  DISPATCHER_METADATA, validateGrammarContract, parseDispatcher, dispatch } =
  require('./deep-work-runtime.js');
const { executeReviewProcess } = require('../runtime/dispatcher-routes.js');
const { ROUTE_CONTRACTS } = require('./deep-work-route-contracts.js');

const ROUTE_TIMESTAMP = '2026-07-13T00:00:00Z';

test('bootstrap routes expose closed dispatcher grammar and route-contract metadata',()=>{
  const rows=[
    ['bootstrap failure-publish',['--state','/tmp/state','--authorization','/tmp/authorization.json',
      '--failure','/tmp/failure.json']],
    ['bootstrap abort',['--state','/tmp/state','--authorization','/tmp/authorization.json',
      '--failure','/tmp/failure.json']],
    ['bootstrap finalize',['--state','/tmp/state','--authorization','/tmp/authorization.json',
      '--execution','/tmp/execution.json']],
    ['bootstrap first-red',['--state','/tmp/state','--plan','/tmp/plan.json','--authorization',
      '/tmp/authorization.json','--receipt','/tmp/bootstrap-receipt.json','--marker','/tmp/marker.json',
      '--spec-json','/tmp/spec.json','--slice','SLICE-001','--write-receipt','/tmp/write.json']],
    ['bootstrap red-adopt',['--state','/tmp/state','--plan','/tmp/plan.json','--authorization',
      '/tmp/authorization.json','--receipt','/tmp/bootstrap-receipt.json','--marker','/tmp/marker.json',
      '--slice','SLICE-001','--bridge-operation-id',`op-${'1'.repeat(64)}`]],
    ['bootstrap proof-publish',['--state','/tmp/state','--plan','/tmp/plan.json','--slice','SLICE-001',
      '--transition-operation-id',`op-${'2'.repeat(64)}`]],
  ];
  for(const [id,args] of rows){
    const parsed=parseDispatcher([...id.split(' '),...args]);
    assert.equal(parsed.entry.id,id);
    assert.equal(DISPATCHER_GRAMMAR.some((entry)=>entry.id===id),true,`${id}:primary-grammar`);
    assert.doesNotThrow(()=>validateGrammarContract(parsed.entry));
    assert.equal(DISPATCHER_HANDLERS.has(id),true,id);
    assert.equal(ROUTE_CONTRACTS.has(id),true,id);
  }
  assert.throws(()=>parseDispatcher(['bootstrap','finalize','--state','/tmp/state',
    '--authorization','/tmp/authorization.json','--execution','/tmp/execution.json',
    '--widen-scope','runtime']),/unknown-flag/);
});

test('all six bootstrap commands cross the public dispatcher with exact typed arguments',async(t)=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-bootstrap-dispatch-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const session='s-aaaaaaaa',work=path.join(root,'.deep-work',session);
  fs.mkdirSync(path.join(work,'bootstrap'),{recursive:true});
  const state=path.join(root,'.claude',`deep-work.${session}.md`);
  fs.writeFileSync(state,updateFrontmatterText('',{schema_version:2,session_id:session,
    work_dir:`.deep-work/${session}`,current_phase:'implement',active_slice:'SLICE-001',
    tdd_state:'PENDING'}));
  const plan=writeJson(path.join(work,'plan.json'),{schema_version:2,
    plan_authority_sha256:'a'.repeat(64),
    slices:[{id:'SLICE-001',slice_kind:'functional'}]});
  const files=Object.fromEntries(['authorization','failure','execution','receipt','marker','spec','write']
    .map((name)=>[name,writeJson(path.join(work,'bootstrap',`${name}.json`),{name})]));
  const calls=[];
  const originals={publishBootstrapFailure:bootstrapRuntime.publishBootstrapFailure,
    abortBootstrap:bootstrapRuntime.abortBootstrap,finalizeBootstrap:bootstrapRuntime.finalizeBootstrap,
    runBootstrapFirstRed:bootstrapRuntime.runBootstrapFirstRed,
    adoptBootstrapRed:bootstrapRuntime.adoptBootstrapRed,
    publishBootstrapRedProof:bootstrapRuntime.publishBootstrapRedProof};
  t.after(()=>Object.assign(bootstrapRuntime,originals));
  for(const name of Object.keys(originals))bootstrapRuntime[name]=async(args)=>{
    calls.push({name,args});return {route:name};};
  const bridge=`op-${'1'.repeat(64)}`,transition=`op-${'2'.repeat(64)}`;
  const routes=[
    ['publishBootstrapFailure',['bootstrap','failure-publish','--state',state,'--authorization',
      files.authorization,'--failure',files.failure]],
    ['abortBootstrap',['bootstrap','abort','--state',state,'--authorization',files.authorization,
      '--failure',files.failure]],
    ['finalizeBootstrap',['bootstrap','finalize','--state',state,'--authorization',files.authorization,
      '--execution',files.execution]],
    ['runBootstrapFirstRed',['bootstrap','first-red','--state',state,'--plan',plan,'--authorization',
      files.authorization,'--receipt',files.receipt,'--marker',files.marker,'--spec-json',files.spec,
      '--slice','SLICE-001','--write-receipt',files.write]],
    ['adoptBootstrapRed',['bootstrap','red-adopt','--state',state,'--plan',plan,'--authorization',
      files.authorization,'--receipt',files.receipt,'--marker',files.marker,'--slice','SLICE-001',
      '--bridge-operation-id',bridge]],
    ['publishBootstrapRedProof',['bootstrap','proof-publish','--state',state,'--plan',plan,
      '--slice','SLICE-001','--transition-operation-id',transition]],
  ];
  for(const [name,argv] of routes){
    const out=await dispatch(argv,{cwd:root});
    assert.equal(out.route,name);
  }
  assert.deepEqual(calls.map((row)=>row.name),routes.map((row)=>row[0]));
  for(const row of calls){
    assert.equal(row.args.stateCapability.projectRoot,root,row.name);
    if(['runBootstrapFirstRed','adoptBootstrapRed','publishBootstrapRedProof'].includes(row.name))
      assert.equal(row.args.sliceId,'SLICE-001',row.name);
  }
});

test('strict RED producer commands cross the public dispatcher with exact authority inputs',
  async(t)=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-red-dispatch-')));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
    const session='s-aaaaaaaa',work=path.join(root,'.deep-work',session);
    fs.mkdirSync(work,{recursive:true});
    const state=path.join(root,'.claude',`deep-work.${session}.md`);
    fs.writeFileSync(state,updateFrontmatterText('',{session_id:session,
      work_dir:`.deep-work/${session}`,current_phase:'implement'}));
    const plan=writeJson(path.join(work,'plan.json'),{schema_version:2,
      plan_authority_sha256:'a'.repeat(64),slices:[]});
    const verificationOperationId=`op-${'1'.repeat(64)}`;
    const transitionOperationId=`op-${'2'.repeat(64)}`;
    const calls=[];
    const originals={runVerificationV2:verificationV2Runtime.runVerificationV2,
      transitionOrdinaryRed:redProofRuntime.transitionOrdinaryRed,
      publishOrdinaryRedProof:redProofRuntime.publishOrdinaryRedProof};
    t.after(()=>{Object.assign(verificationV2Runtime,{
      runVerificationV2:originals.runVerificationV2});
    Object.assign(redProofRuntime,{transitionOrdinaryRed:originals.transitionOrdinaryRed,
      publishOrdinaryRedProof:originals.publishOrdinaryRedProof});});
    verificationV2Runtime.runVerificationV2=async(args)=>{
      calls.push({name:'run',args});return{name:'run'};};
    redProofRuntime.transitionOrdinaryRed=async(args)=>{
      calls.push({name:'transition',args});return{name:'transition'};};
    redProofRuntime.publishOrdinaryRedProof=async(args)=>{
      calls.push({name:'proof',args});return{name:'proof'};};
    assert.equal((await dispatch(['verification','run-v2','--state',state,'--plan',plan,
      '--slice','SLICE-001'],{cwd:root})).name,'run');
    assert.equal((await dispatch(['verification','red-transition','--state',state,'--plan',
      plan,'--slice','SLICE-001','--verification-operation-id',verificationOperationId,
      '--verification-result-sha256','3'.repeat(64)],{cwd:root})).name,'transition');
    assert.equal((await dispatch(['verification','proof-publish','--state',state,'--plan',
      plan,'--slice','SLICE-001','--transition-operation-id',transitionOperationId],
    {cwd:root})).name,'proof');
    assert.deepEqual(calls.map((row)=>row.name),['run','transition','proof']);
    assert.equal(calls[1].args.verificationOperationId,verificationOperationId);
    assert.equal(calls[2].args.transitionOperationId,transitionOperationId);
  });

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value)}\n`); return file; }

function strictFinishAuthority() {
  const fixture = path.resolve(__dirname, '../tests/fixtures/v6.13-spec/medium-valid');
  const specContract = parseSpecMarkdown(fs.readFileSync(path.join(fixture, 'spec.md'), 'utf8'));
  const planProjection = compilePlanProjectionV1({
    planMarkdown: fs.readFileSync(path.join(fixture, 'plan.md'), 'utf8'), specContract,
    sliceRiskState: {'SLICE-001': {class:'medium',score:6,triggers:['strict-admission']}},
  });
  const verificationPlan = compileVerificationPlan({
    riskProfile:{class:'medium',score:6,triggers:['strict-admission']},riskProfileSha256:'b'.repeat(64),
    policySnapshot:{risk_class:'medium',profile:'standard',verification_policy:{recommended:'표준 검증'}},
    specContract,specSha256:planProjection.contract_binding.spec_contract.spec_sha256,
    specApprovedHash:'a'.repeat(64),planProjection,capabilities:{},
    compatibilityFacts:{created_by_version:'6.13.0',spec_policy_required:true},
  });
  return {planProjection, verificationPlan};
}

function strictFinishFixture({forgedSummary}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-finish-strict-route-'))),session='s-aaaaaaaa';
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));const work=path.join(root,'.deep-work',session);
  fs.mkdirSync(work,{recursive:true});const state=path.join(root,'.claude',`deep-work.${session}.md`);
  const {planProjection,verificationPlan}=strictFinishAuthority();writeJson(path.join(work,'plan.json'),planProjection);
  const evidence=forgedSummary?{schema_version:2,package_sha256:'c'.repeat(64),verification_plan_sha256:verificationPlan.plan_sha256,
    summary:{schema_version:2,complete:true,redaction:{passed:true},satisfied_gate_ids:[...verificationPlan.required_gate_ids],
      missing_gate_ids:[],unverified_areas:[]},residual_risk:{class:'low',accepted:true},invalidated_evidence_ids:[]}:undefined;
  const fields={schema_version:2,session_id:session,work_dir:`.deep-work/${session}`,current_phase:'implement',
    created_by_version:'6.13.0',spec_policy_required:true,risk_profile_json:canonicalJson({class:'medium',score:6,
      triggers:['strict-admission']}),review_execution_json:canonicalJson(evidence?{evidence}:{})};
  if(forgedSummary){fields.verification_plan_json=canonicalJson(verificationPlan);
    fields.verification_plan_sha256=verificationPlan.plan_sha256;fields.receipt_invalidations_json='[]';}
  fs.writeFileSync(state,updateFrontmatterText('',fields));writeJson(path.join(root,'.claude','deep-work-sessions.json'),
    {version:1,shared_files:[],sessions:{[session]:{pid:process.pid,task_description:'finish strict route',
      work_dir:`.deep-work/${session}`,current_phase:'implement',file_ownership:[],last_activity:ROUTE_TIMESTAMP}}});
  return {root,session,state,work};
}

function lowFlowContract(){return{schema_version:1,spec_id:'SPEC-LOW-FULL-FLOW',risk_class:'low',requirements:[{id:'REQ-001',
  statement:'Low flow finishes with authenticated evidence.',acceptance:'Finish keep succeeds after plan approval and test pass.',
  priority:'must',negative_test_ids:['NEG-001'],evidence_gate_ids:['GATE-plan-alignment']}],invariants:[{id:'INV-001',
  statement:'Plan and evidence identities stay bound.',requirement_ids:['REQ-001']}],failure_matrix:[],negative_tests:[{id:'NEG-001',
  statement:'Reject missing low verification plan.',requirement_ids:['REQ-001'],failure_mode_ids:[],
  expected_signal:'finish-verification-plan-required',gate_id:'GATE-plan-alignment'}],compatibility:{legacy_inputs:'reject fresh',
  migration:'author strict spec'},open_questions:[]};}
function lowSpecMarkdown(contract){return['# Executable Spec: Low Full Flow','','## Scope','','- Complete one LOW flow.','',
  '## Non-goals','','- No legacy downgrade.','','## Contract','','```json spec-contract\n'+JSON.stringify(contract)+'\n```','',
  '## Requirement Notes','','REQ-001 is executable.','','## Failure and Recovery Notes','','Missing authority fails closed.','',
  '## Decisions and Trade-offs','','- LOW still uses a minimal plan.','','## Open Questions','','- None.','','## Spec Gate Result','',
  '- Status: PASS'].join('\n');}
function lowPlanMarkdown(contract,specApprovedHash,riskProfileSha256){const binding={schema_version:1,mode:'strict-spec',
  created_by_version:'6.13.0',spec_contract:{schema_version:1,spec_id:contract.spec_id,
    spec_sha256:specContractDigest(contract),spec_approved_hash:specApprovedHash},risk_profile_sha256:riskProfileSha256};return[
  '## Spec Contract Binding','','```json\n'+JSON.stringify(binding)+'\n```','','## Slice Checklist','',
  '- [ ] SLICE-001: Complete LOW full flow','  - outcome: LOW flow reaches finish with authenticated evidence',
  '  - files: [runtime/low.js, runtime/low.test.js]','  - depends_on: []','  - integration_touchpoints: [finish admission]',
  '  - requirements: [REQ-001]','  - invariants: [INV-001]','  - failure_modes: []',
  '  - risk: { class: low, score: 2, triggers: [low-flow] }','  - negative_tests: [NEG-001]',
  '  - evidence_required: [GATE-plan-alignment]','  - rollback: { method: revert, verification: [GATE-recovery] }',
  '  - review_policy: single','  - scope_expansion_trigger: [risk increase]','  - failing_test: LOW verification plan omitted',
  '  - verification_cmd: node --test runtime/low.test.js','  - expected_output: fail 0','  - code_sketch: approvePhase()',
  '  - spec_checklist: [REQ-001]','  - contract: [LOW finish succeeds]','  - acceptance_threshold: all','  - size: S',
  '  - steps:','    1. Compile the minimal LOW plan','    2. Finish the session'].join('\n');}
async function publishLowFlowEvidence({root,state,work,plan,verificationPlan,specContract}){
  const reviewPlan=compileReviewPlan({artifactKind:'session-final',phase:'test',riskClass:'low',runtime:'claude',
    availableChannels:{subagent:true,codex_cli:true,gemini_cli:true,deep_review:true},tddMode:'strict'});
  const reports=reviewPlan.reviewers.map((row,index)=>({role:row.role,channel:row.channel,required:row.required,status:'completed',
    report_ref:`reports/${row.role}.json`,sha256:String(index+1).repeat(64).slice(0,64)}));const records=[];
  for(const [index,gateId] of verificationPlan.evidence_required_gate_ids.entries()){const gate=verificationPlan.gates.find((row)=>row.id===gateId),
      base={evidence_id:`EVID-LOW-${String(index+1).padStart(4,'0')}`,gate_id:gateId};let record;
    if(gate.adapter==='command')record=await evidenceRuntime.captureCommandEvidence({...base,verification_spec:{schema_version:1,
      executable:{kind:'node',value:'node'},args:['verify-low.js'],cwd_role:'active-worktree',timeout_ms:5000,max_output_bytes:4096,
      red_failure_literal:'expected-red'},expected_outcome:'must-pass',requirement_ids:gate.requirement_ids,invariant_ids:['INV-001'],
      failure_mode_ids:gate.failure_mode_ids,negative_test_ids:['NEG-001'],redaction_policy:{exact_secret_values:[]}},
    {runner:async()=>({exitCode:0,stdout:'ok',stderr:'',durationMs:1})});
    else if(gate.adapter==='contract')record=evidenceRuntime.captureContractEvidence({...base,verificationPlan,specContract,
      slices:plan.slices.map((row)=>row.contract)});
    else if(gate.adapter==='receipt')record=evidenceRuntime.captureReceiptEvidence({...base,verificationPlan,plan,
      receipts:[{slice_id:'SLICE-001',status:'complete'}],verificationResult:{pass:true,errors:[]}});
    else if(gate.adapter==='review')record=evidenceRuntime.captureReviewEvidence({...base,verificationPlan,reviewPlan,reports});
    else if(gate.adapter==='sensor'){const result={status:'pass',adapter:'sensor'};record=evidenceRuntime.captureRuntimeProjectionEvidence(
      {...base,verificationPlan,kind:'sensor',operation:{operationId:`op-${String(index+1).repeat(32).slice(0,32)}`},result,
        result_sha256:crypto.createHash('sha256').update(canonicalJson(result)).digest('hex')});}
    else throw new Error(`unhandled LOW adapter ${gate.adapter}`);records.push(record);}
  let published;for(const record of records)published=await evidenceRuntime.publishAuthenticatedRecord(record,{stateCapability:
    platform.issueProjectStateCapability(root,state,{role:'session-state'}),verificationPlan,plan,scope:{kind:'session',id:'s-aaaaaaaa'}});
  return published;
}

function finishArgv(outcome,fixture) {
  const argv=['session','finish',outcome,'--state',fixture.state,'--session',fixture.session,
    '--receipt-payload',path.join(fixture.work,'missing-receipt.tmp')];
  if(outcome==='publish-pr')argv.push('--title-file',path.join(fixture.work,'missing-title.tmp'),
    '--body-file',path.join(fixture.work,'missing-body.tmp'));
  return argv;
}

async function semanticFixture(entry, index) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-route-semantic-')));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude'));
  const session = `s-${(index + 1).toString(16).padStart(8, '0')}`;
  const workDir = path.join(root, '.deep-work', session);
  const receipts = path.join(workDir, 'receipts');
  fs.mkdirSync(receipts, {recursive:true});
  const standalone = entry.allowedPhases[0] === 'standalone';
  let currentPhase = standalone ? 'implement' : entry.allowedPhases[0];
  if (entry.id === 'mutation round end') currentPhase = 'implement';
  const state = path.join(root, '.claude', `deep-work.${session}.md`);
  const fields = {schema_version:2,session_id:session,current_phase:currentPhase,
    work_dir:`.deep-work/${session}`,repository_mode:'current',branch:'main',head_oid:'a'.repeat(40),
    worktree_enabled:false,active_slice:'SLICE-001',tdd_state:'PENDING',test_retry_count:0,
    max_test_retries:3,debug_active:true,debug_slice:'SLICE-001',active_cluster_takeover:'C1',
    delegation_snapshot:'a'.repeat(40),
    mutation_testing:JSON.stringify({active_round:1,survived:{mutants:[]}}),
    model_routing_json:JSON.stringify({research:'main',implement:'main',test:'main',plan:'main'})};
  fs.writeFileSync(state, updateFrontmatterText('', fields));
  const planValue = {schema_version:1,slices:[{id:'SLICE-001',checked:false,scope_schema_version:1,
    files:['src/a.js','tests/a.test.js'],write_scope:{failing_test:['tests/a.test.js'],production:['src/a.js'],
      refactor:['src/a.js','tests/a.test.js']}}],quality_gates:[{id:'QG-001'}]};
  const plan = writeJson(path.join(workDir, 'plan.json'), planValue);
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'tests', 'a.test.js'), 'test placeholder\n');
  writeJson(path.join(receipts, 'SLICE-001.json'), {slice_id:'SLICE-001',status:'complete',debug:{}});
  const registry = {version:1,shared_files:['package.json'],sessions:{[session]:{pid:process.pid,
    task_description:entry.id,work_dir:`.deep-work/${session}`,current_phase:currentPhase,
    file_ownership:[],last_activity:ROUTE_TIMESTAMP,branch:'main',head_oid:'a'.repeat(40)}}};
  writeJson(path.join(root, '.claude', 'deep-work-sessions.json'), registry);
  fs.writeFileSync(path.join(root, '.claude', 'deep-work-session'), `${session}\n`);

  const files = {
    task:path.join(workDir,'task.txt'), defaults:path.join(workDir,'defaults.json'),
    profileJson:path.join(workDir,'profile.json'), flags:path.join(workDir,'flags.json'),
    result:path.join(workDir,'result.json'), affected:path.join(workDir,'affected.json'),
    assignment:path.join(workDir,'assignment.json'), verificationSpec:path.join(workDir,'verification-spec.json'),
    gate:path.join(workDir,'gate.json'), failed:path.join(workDir,'failed.json'),
    survived:path.join(workDir,'survived.json'), verification:path.join(workDir,'verification.json'),
    structural:path.join(workDir,'structural.json'), structuralMd:path.join(workDir,'structural.md'),
    adversarial:path.join(workDir,'adversarial.json'), report:path.join(workDir,'drift.md'),
    score:path.join(workDir,'score.txt'), processSpec:path.join(workDir,'process-spec.json'),
    changed:path.join(workDir,'changed.json'), health:path.join(workDir,'health.json'),
    recommender:path.join(workDir,'recommender.json'), recommendation:path.join(workDir,'recommendation.txt'),
    capability:path.join(workDir,'capability.json'), ask:path.join(workDir,'ask.json'),
    arguments:path.join(workDir,'arguments.json'), profile:path.join(workDir,'profile.yaml'),
    cluster:path.join(workDir,'cluster.txt'), note:path.join(workDir,'root-cause.md'),
    specContract:path.join(workDir,'spec-contract.json'),specGate:path.join(workDir,'spec-gate.json'),
    bootstrapAuthorization:path.join(workDir,'bootstrap-authorization.json'),
    bootstrapFailure:path.join(workDir,'bootstrap-failure.json'),
    bootstrapExecution:path.join(workDir,'bootstrap-execution.json'),
    bootstrapReceipt:path.join(workDir,'bootstrap-receipt.json'),
    bootstrapMarker:path.join(workDir,'bootstrap-marker.json'),
    bootstrapWriteReceipt:path.join(workDir,'bootstrap-write-receipt.json'),
    finding:path.join(workDir,'reviews','research-round1-findings.json'),
  };
  fs.writeFileSync(files.task, 'semantic route');
  writeJson(files.defaults, {}); writeJson(files.profileJson, {}); writeJson(files.flags, {});
  writeJson(files.result, {result:'recorded',status:'completed'}); writeJson(files.affected, ['SLICE-001']);
  writeJson(files.assignment, {schema_version:1,clusters:[{id:'C1',slices:['SLICE-001']}]});
  const verificationSpec = {schema_version:1,executable:{kind:'node',value:'node'},
    args:['-e','process.stdout.write("semantic\\n")'],cwd_role:'active-worktree',timeout_ms:1000,
    max_output_bytes:65536};
  writeJson(files.verificationSpec, verificationSpec); writeJson(files.gate, {complete:true,failedSlices:[]});
  writeJson(files.failed, ['SLICE-001']); writeJson(files.survived, {mutants:[]});
  writeJson(files.verification, {accepted:true}); writeJson(files.structural, {result:'recorded'});
  fs.writeFileSync(files.structuralMd, '# Structural\n'); writeJson(files.adversarial, {result:'recorded'});
  fs.writeFileSync(files.report, '# Drift\n'); fs.writeFileSync(files.score, '1');
  writeJson(files.processSpec, {kind:'native-executable',executable:process.execPath,
    args:['-e','process.stdout.write("[]")']}); writeJson(files.changed, []);
  writeJson(files.health, {topology:'generic',health_report:{status:'pass'},fitness_baseline:null,
    unresolved_required_issues:[]});
  writeJson(files.recommender, {task_description:'task',git_status:'clean',recent_commits:[],top_level_dirs:[]});
  fs.writeFileSync(files.recommendation, JSON.stringify({team_mode:{value:'solo',reason:'safe'},
    start_phase:{value:'research',reason:'safe'},tdd_mode:{value:'strict',reason:'safe'},
    git:{value:'current-branch',reason:'safe'},model_routing:{value:'default',reason:'safe'}}));
  writeJson(files.capability, {git_worktree:false,team_mode_available:false,is_git:true});
  writeJson(files.ask, {item:'git',recommendation:'current-branch',default_value:'current-branch',
    enum_values:['worktree','new-branch','current-branch'],capability:{git_worktree:false,is_git:true}});
  writeJson(files.arguments, ['--tdd=strict','semantic']);
  fs.writeFileSync(files.profile, 'version: 3\ndefault_preset: solo-strict\npresets:\n  solo-strict:\n    interactive_each_session:\n      - team_mode\n    defaults:\n      team_mode: solo\n');
  fs.writeFileSync(files.cluster, 'C1\n'); fs.writeFileSync(files.note, '# Root cause\n');
  writeJson(files.specContract,{});writeJson(files.specGate,{});
  for(const file of [files.bootstrapAuthorization,files.bootstrapFailure,files.bootstrapExecution,
    files.bootstrapReceipt,files.bootstrapMarker,files.bootstrapWriteReceipt])writeJson(file,{fixture:true});
  fs.mkdirSync(path.dirname(files.finding),{recursive:true});
  writeJson(files.finding,{schema_version:1,point:'research',round:1,findings:[]});

  const stateCapability = platform.issueProjectStateCapability(root, state, {role:'session-state'});
  const sessionCapability = platform.issueProjectStateCapability(root, workDir,
    {role:'session-work-dir',sessionStateCapability:stateCapability});
  const temps = new Map();
  async function temp(purpose, bytes) {
    if (temps.has(purpose)) return temps.get(purpose);
    const created = await artifactRuntime.createOwnedTemp({sessionCapability,purpose});
    await artifactRuntime.writeOwnedTemp({sessionCapability,operationId:created.operationId,purpose},bytes);
    temps.set(purpose, created.path); return created.path;
  }
  return {root,session,state,workDir,receipts,plan,files,temp};
}

async function semanticArgv(entry, fx) {
  const phase = entry.id === 'phase approve' ? 'research' : entry.id === 'phase review record' ? 'brainstorm'
    : entry.allowedPhases[0] === 'standalone' ? 'implement' : entry.allowedPhases[0];
  const values = {
    session:fx.session,parent:fx.session,base:'HEAD','paths-json':fx.files.changed,state:fx.state,
    purpose:entry.id === 'git stash publish' ? 'fork' : 'receipt-payload','temp-operation-id':`op-${'1'.repeat(64)}`,
    'expected-sha256':'a'.repeat(64),'project-root':fx.root,path:'src/a.js',at:ROUTE_TIMESTAMP,
    phase,mode:'current-branch','task-file':fx.files.task,'defaults-json':fx.files.defaults,
    'profile-json':fx.files.profileJson,'base-ref':'HEAD','from-phase':'plan','dirty-resolution':'abort',
    reason:'risk-class-increase','from-risk':'medium','to-risk':'high',
    'risk-profile-sha256':'9'.repeat(64),
    worktree:path.join(fx.root, '..', `${path.basename(fx.root)}-wt-${fx.session.slice(2)}`),
    'flags-json':fx.files.flags,'finished-at':ROUTE_TIMESTAMP,'result-json':fx.files.result,
    artifact:fx.files.structuralMd,'contract-json':fx.files.specContract,'gate-json':fx.files.specGate,
    from:'brainstorm',to:'research','affected-slices-json':fx.files.affected,
    'observation-json':fx.files.structural,
    'producer-operation-id':`op-${'b'.repeat(64)}`,
    'next-risk-profile-json':fx.files.structural,
    'source-kind':'debug-root','source-operation-id':`op-${'d'.repeat(64)}`,
    checker:'spec-gate-v1',command:'pack','input-refs-json':fx.files.changed,
    'fact-operation-id':`op-${'c'.repeat(64)}`,
    'request-json':fx.files.structural,'receipt-json':fx.files.result,
    'functional-receipts-json':fx.files.changed,
    plan:fx.plan,'assignment-json':fx.files.assignment,snapshot:'a'.repeat(40),slice:'SLICE-001',
    class:'failing-test','scope-sha256':'a'.repeat(64),'delegation-operation-id':`op-${'2'.repeat(64)}`,
    cluster:'C1','operation-id':`op-${'3'.repeat(64)}`,'pre-manifest-sha256':'a'.repeat(64),
    'verification-result':fx.files.verification,'verification-sha256':'a'.repeat(64),
    'green-ref-json':fx.files.verification,
    'refactor-evidence-json':fx.files.verification,
    'verification-operation-id':`op-${'4'.repeat(64)}`,'sensor-operation-ids':JSON.stringify([`op-${'5'.repeat(64)}`]),
    'sensor-results-sha256':'a'.repeat(64),'after-write-operation-id':`op-${'6'.repeat(64)}`,
    'receipts-dir':fx.receipts,
    'cluster-file':fx.files.cluster,'delegation-snapshot':'a'.repeat(40),scope:'slice',id:'SLICE-001',
    spec:fx.files.structuralMd,'evidence-id':'EVID-SEMANTIC-0001','review-plan-json':fx.files.structural,
    'reports-json':fx.files.adversarial,'receipts-json':fx.files.adversarial,
    'verification-result-json':fx.files.verification,
    'spec-json':fx.files.verificationSpec,expected:'must-pass','gate-id':'QG-001',
    'gate-results-json':fx.files.gate,'failed-slices-json':fx.files.failed,'survived-json':fx.files.survived,
    round:'1','verification-json':fx.files.verification,'note-file':fx.files.note,
    'structural-json':fx.files.structural,'structural-md':fx.files.structuralMd,
    'adversarial-json':fx.files.adversarial,kind:'brainstorm',
    report:fx.files.report,'score-file':fx.files.score,format:'json',model:'opus',engine:'codex','timeout-ms':'1000',
    'process-spec-json':fx.files.processSpec,parser:'generic-json','budget-ms':'1000',topology:'generic',
    'changed-files-json':fx.files.changed,'fitness-file':path.join(fx.root,'.deep-review','fitness.json'),
    'report-json':fx.files.health,'input-json':entry.id==='ask options'?fx.files.ask:fx.files.recommender,
    'result-file':fx.files.recommendation,'capability-json':fx.files.capability,'profile-file':fx.files.profile,
    'initial-preset':'solo-strict',reason:'setup',preset:'solo-strict','arguments-json':fx.files.arguments,
    authorization:fx.files.bootstrapAuthorization,failure:fx.files.bootstrapFailure,
    execution:fx.files.bootstrapExecution,receipt:fx.files.bootstrapReceipt,
    marker:fx.files.bootstrapMarker,'write-receipt':fx.files.bootstrapWriteReceipt,
    point:'research',finding:fx.files.finding,'artifact-kind':'research-document',
    'bridge-operation-id':`op-${'7'.repeat(64)}`,
    'transition-operation-id':`op-${'8'.repeat(64)}`,
    'verification-operation-id':`op-${'9'.repeat(64)}`,
    'verification-result-sha256':'a'.repeat(64),
  };
  if (entry.id === 'implement tdd transition') values.to = 'PENDING';
  if (entry.id === 'verification run') delete values['gate-id'];
  if (entry.id === 'sensor run') values.kind = 'lint';
  if (entry.id === 'phase invalidate-replan') values.reason = 'risk-class-increase';
  if (entry.id === 'session fork') values.reason = 'alternative-experiment';
  if (entry.id === 'implement refactor no-change') values.reason = 'no-duplication';
  if (entry.id === 'session execution set') values.mode = 'inline';
  if (entry.id === 'review run') values.mode = 'read-only';
  const tempValues = {
    'receipt-payload':()=>fx.temp('receipt-payload', Buffer.from('{"status":"complete"}\n')),
    'title-file':()=>fx.temp('pr-title', Buffer.from('Semantic PR')),
    'body-file':()=>fx.temp('pr-body', Buffer.from('Semantic body')),
    'reason-file':()=>fx.temp('reason', Buffer.from('semantic override')),
    input:()=>fx.temp('artifact-input', Buffer.from('# Artifact\n')),
    'prompt-file':()=>fx.temp('review-prompt', Buffer.from('Review this')),
  };
  const argv = [...entry.tokens];
  for (const name of entry.required) {
    argv.push(`--${name}`);
    if (!['force','include-untracked','skip-audit','stdin'].includes(name)) argv.push(
      tempValues[name] ? await tempValues[name]() : values[name]);
  }
  if (entry.id === 'session context') argv.push('--session',fx.session);
  if (entry.id === 'verification run') argv.push('--slice','SLICE-001');
  if (entry.id === 'session cleanup remove') argv.push('--force');
  return argv;
}

test('dispatcher grammar is single-source typed metadata', () => {
  assert.ok(DISPATCHER_GRAMMAR.length >= 70);
  for (const entry of DISPATCHER_GRAMMAR) {
    assert.equal(typeof entry.phase5Allowed, 'boolean', entry.id);
    assert.ok(entry.allowedPhases.length > 0, entry.id);
    assert.ok(entry.capabilityKind.length > 0, entry.id);
    assert.ok(Array.isArray(entry.lockRanks), entry.id);
  }
  assert.deepEqual(PHASE5_DISPATCHER_COMMANDS,
    DISPATCHER_GRAMMAR.filter((entry) => entry.phase5Allowed));
  assert.deepEqual(PHASE5_DISPATCHER_COMMANDS.map((entry) => entry.id),
    ['session context','session authority validate','git capability','git changed',
      'temp create','temp write','temp remove']);
});

test('all route lock ranks match the global repository to target hierarchy',()=>{
  const expected=new Map([
    ['session context',[]],['session authority validate',[50]],['git capability',[]],
    ['git changed',[5]],
    ['temp create',[10,20,50,70]],['temp write',[10,20,50,70]],['temp remove',[10,20,50,70]],
    ['session registry read',[]],['session registry own',[10,20,30,40,50]],
    ['session registry touch',[10,20,30,40,50]],['session registry phase',[10,20,30,40,50]],
    ['session pointer select',[30,40,50]],['session repository prepare',[5,10,20,30,40,50]],
    ['session fork',[5,10,20,40,50,70]],['session finish merge',[5,10,20,30,40,50,70]],
    ['session finish publish-pr',[5,10,20,30,40,50,70]],['session finish keep',[10,20,30,40,50,70]],
    ['session finish discard',[5,10,20,30,40,50,70]],['session cleanup scan',[5,40]],
    ['session cleanup remove',[5,10,20,30,40,50]],['session cache-clear',[10,70]],
    ['session initialize',[]],['session state migrate-schema',[50]],['session execution set',[50]],
    ['session state migrate-model-routing',[50]],['session recovery worktree',[5,10,50]],
    ['session finalize',[10,20,30,40,50]],['phase begin',[10,20,50]],['phase complete',[10,20,50]],
    ['phase approve',[10,20,50,70]],['phase spec enter',[10,20,50]],['phase spec approve',[10,20,50]],
    ['phase advance',[10,20,50]],['phase rerun',[10,20,50]],['phase invalidate-replan',[10,20,50]],
    ['replan discovery publish',[10,20,50,70]],['replan discovery dispatch',[10,20,50,70]],
    ['replan risk publish',[10,20,50,70]],['replan risk dispatch',[10,20,50,70]],
    ['replan root-cause record',[10,20,50,70]],
    ['replan root-cause derive',[10,20,50,70]],
    ['replan root-cause dispatch',[10,20,50,70]],
    ['replan complete',[10,20,50,70]],
    ['release gate fact-publish',[10,20,50,70]],
    ['release gate result-publish',[10,20,50,70]],
    ['release gate command-run',[10,20,50,70]],
    ['release gate integrity-run',[10,20,50,70]],
    ['release verification complete',[10,20,50,70]],
    ['implement delegation set',[10,20,50,70]],['implement delegation clear',[50]],
    ['implement write begin',[10,20,50,70]],['implement write accept',[10,20,50,70]],
    ['implement tdd transition',[10,20,50]],['implement slice complete',[10,20,50,70]],
    ['implement slice complete-v2',[10,20,50,70]],
    ['implement refactor no-change',[10,20,50]],
    ['implement override set',[10,20,50,70]],['implement override clear',[50]],
    ['implement takeover set',[50,70]],['implement takeover clear',[50,70]],
    ['verification migrate-spec',[10,20,50,70]],['verification run',[10,20,50,70]],
    ['verification run-v2',[10,20,50,70]],
    ['verification red-transition',[10,20,50,70]],
    ['verification proof-publish',[10,20,50,70]],
    ['bootstrap failure-publish',[10,20,50,70]],['bootstrap abort',[10,20,50,70]],
    ['bootstrap finalize',[10,20,50,70]],['bootstrap first-red',[10,20,50,70]],
    ['bootstrap red-adopt',[10,20,50,70]],['bootstrap proof-publish',[10,20,50,70]],
    ['evidence record contract',[10,20,50,70]],['evidence record review',[10,20,50,70]],
    ['evidence record receipt',[10,20,50,70]],
    ['test pass',[10,20,50,70]],['test retry',[10,20,50,70]],['test exhaust',[10,20,50,70]],
    ['mutation round begin',[10,20,50,70]],['mutation round end',[10,20,50,70]],
    ['mutation record',[10,20,50,70]],['debug enter',[50]],['debug complete',[10,20,50,70]],
    ['debug exit',[50]],['phase review record',[10,20,50,70]],['artifact publish',[10,20,50,70]],
    ['analysis drift record',[50]],['receipt dashboard',[]],['receipt view',[]],
    ['receipt export',[10,20,50,70]],['history list',[]],['report generate',[10,20,50,70]],
    ['git report commit',[5,10,20,50]],['slice activate',[50]],['slice spike',[50]],
    ['slice reset',[5,10,20,50,70]],['slice model',[50]],['git delegated rollback',[5,10,20,50,70]],
    ['git stash publish',[5,10,20]],['git stash apply',[5,10,20]],['git stash drop',[5,10,20]],
    ['review run',[10,20,50,70]],['review envelope validate',[]],
    ['review finding-publish',[10,20,50,70]],
    ['sensor detect',[]],['sensor run',[10,20,50,70]],
    ['sensor review-check',[10,20,50,70]],['topology detect',[]],['health fitness-proposal',[]],
    ['health check',[70]],['health research-state',[50]],['capability detect',[]],
    ['recommender input',[]],['recommender validate',[]],['ask options',[]],['profile migrate',[70]],
    ['profile load',[]],['profile update',[70]],['flags parse',[]],
  ]);
  assert.equal(expected.size,DISPATCHER_GRAMMAR.length);
  assert.deepEqual([...expected.keys()],DISPATCHER_GRAMMAR.map((entry)=>entry.id));
  for(const entry of DISPATCHER_GRAMMAR)assert.deepEqual(entry.lockRanks,expected.get(entry.id),entry.id);
});

test('all grammar metadata is explicit and mutation-checked', () => {
  assert.equal(DISPATCHER_METADATA instanceof Map, true);
  assert.equal(DISPATCHER_METADATA.size, DISPATCHER_GRAMMAR.length);
  const fields = ['capabilityKind','readSet','writeSet','mutableFields','allowedPhases',
    'lockDomain','lockRanks','recoveryKind','operationKind','destructive','phase5Allowed'];
  for (const entry of DISPATCHER_GRAMMAR) {
    const metadata = DISPATCHER_METADATA.get(entry.id);
    assert.ok(metadata, entry.id);
    for (const field of fields) assert.ok(Object.hasOwn(metadata, field), `${entry.id}:${field}`);
    assert.doesNotThrow(() => validateGrammarContract(entry));
    for (const field of fields) {
      const mutant = {...entry, [field]: field === 'destructive' || field === 'phase5Allowed'
        ? !entry[field] : field === 'lockRanks' ? [999] : field.endsWith('Set') || field === 'mutableFields' || field === 'allowedPhases'
          ? ['mutated'] : 'mutated'};
      assert.throws(() => validateGrammarContract(mutant), undefined, `${entry.id}:${field}`);
    }
  }
  const source = fs.readFileSync(require.resolve('./deep-work-runtime.js'), 'utf8');
  assert.doesNotMatch(source, /function (?:capabilityName|routeWriteSet|routeAllowedPhases|routeLockDomain)/);
  assert.match(source, /ROUTE_CONTRACTS/);
});

test('every grammar row has one executable typed handler', () => {
  assert.equal(DISPATCHER_HANDLERS instanceof Map, true);
  assert.deepEqual([...DISPATCHER_HANDLERS.keys()].sort(),
    DISPATCHER_GRAMMAR.map((entry) => entry.id).sort());
  for (const entry of DISPATCHER_GRAMMAR) {
    assert.equal(typeof DISPATCHER_HANDLERS.get(entry.id), 'function', entry.id);
  }
  assert.doesNotMatch(require('node:fs').readFileSync(require.resolve('./deep-work-runtime.js'), 'utf8'),
    /route-not-implemented/);
});

test('parser rejects generic mutation, public reducers, duplicate and unknown flags', () => {
  for (const argv of [
    ['session','state','set'], ['session','registry','register'], ['session','registry','unregister'],
    ['temp','create','--path','x'], ['artifact','publish','--output','x'],
  ]) assert.throws(() => parseDispatcher(argv));
  assert.throws(() => parseDispatcher(['session','context','--session','s-aaaaaaaa','--session','s-bbbbbbbb']),
    /duplicate-flag/);
  const parsed = parseDispatcher(['flags','parse','--arguments-json','C:\\공백 dir\\args.json']);
  assert.equal(parsed.flags['arguments-json'], 'C:\\공백 dir\\args.json');
  for(const ref of ['HEAD --output=/tmp/owned','HEAD\n--output=x','refs/heads/main..foreign'])assert.throws(()=>
    parseDispatcher(['git','changed','--base',ref]),/git-ref/);
});

test('parser enforces grouped evidence, contextual sensor, target, and numeric contracts', () => {
  const sha = 'a'.repeat(64);
  const op = `op-${'b'.repeat(64)}`;
  const tdd = ['implement','tdd','transition','--state','state.md','--plan','plan.json',
    '--slice','SLICE-001'];
  assert.throws(() => parseDispatcher([...tdd,'--to','RED_VERIFIED']), /verification-flag-group/);
  assert.throws(() => parseDispatcher([...tdd,'--to','GREEN','--verification-result','result.json',
    '--verification-sha256',sha]), /verification-flag-group/);
  assert.throws(() => parseDispatcher([...tdd,'--to','PENDING','--verification-result','result.json',
    '--verification-sha256',sha,'--verification-operation-id',op]), /verification-flags-extra/);
  assert.throws(() => parseDispatcher([...tdd,'--to','SENSOR_CLEAN','--sensor-operation-ids',
    JSON.stringify([op]),'--sensor-results-sha256',sha]), /sensor-flag-group/);
  assert.throws(() => parseDispatcher([...tdd,'--to','SENSOR_CLEAN','--sensor-operation-ids',
    JSON.stringify([op,op]),'--sensor-results-sha256',sha,'--after-write-operation-id',op]),
  /sensor-operation-ids/);

  const sensor = ['sensor','run','--kind','lint','--process-spec-json','spec.json',
    '--parser','generic','--budget-ms','1000'];
  assert.throws(() => parseDispatcher([...sensor,'--state','state.md']), /sensor-context-group/);
  assert.throws(() => parseDispatcher(['sensor','run','--kind','lint','--process-spec-json','spec.json',
    '--parser','generic','--budget-ms','0']), /numeric-bound/);
  assert.throws(() => parseDispatcher(['review','run','--engine','codex','--prompt-file','prompt.tmp',
    '--timeout-ms','1.5','--mode','read-only']), /numeric-bound/);

  const verification = ['verification','run','--state','state.md','--plan','plan.json',
    '--spec-json','spec.json','--expected','must-pass'];
  assert.throws(() => parseDispatcher(verification), /verification-target/);
  assert.throws(() => parseDispatcher([...verification,'--slice','SLICE-001','--gate-id','QG-1']),
    /verification-target/);
  assert.throws(() => parseDispatcher(['artifact','publish','--state','state.md','--kind','research',
    '--input','input.tmp','--area','risks']), /artifact-area/);
  assert.throws(() => parseDispatcher(['artifact','publish','--state','state.md','--kind','plan-backup',
    '--input','input.tmp','--iteration','21']), /numeric-bound/);
});

test('dispatcher rejects a route outside the phase read under the state lock', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-dispatch-phase-')));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.mkdirSync(path.join(root, '.deep-work', 's-aaaaaaaa'), {recursive:true});
  const state = path.join(root, '.claude', 'deep-work.s-aaaaaaaa.md');
  fs.writeFileSync(state, '---\nsession_id: s-aaaaaaaa\nwork_dir: .deep-work/s-aaaaaaaa\ncurrent_phase: research\n---\n');
  await assert.rejects(() => dispatch(['slice','model','--state',state,'--slice','SLICE-001',
    '--model','opus'], {cwd:root}), /dispatcher-phase/);
});

test('review prompt authority cannot be a raw worktree file', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-review-route-')));
  fs.mkdirSync(path.join(root, '.git'));
  const prompt = path.join(root, 'prompt.md');
  fs.writeFileSync(prompt, 'review me');
  await assert.rejects(() => dispatch(['review','run','--engine','codex','--prompt-file',prompt,
    '--timeout-ms','1000','--mode','read-only'], {cwd:root}), /owned-temp-route/);
});

test('review route accepts bounded effort/model flags and declares them in its contract', () => {
  const parsed = parseDispatcher(['review','run','--engine','codex','--prompt-file','prompt.tmp',
    '--timeout-ms','1000','--mode','read-only','--effort','xhigh','--model','gpt-5.6-sol']);
  assert.equal(parsed.flags.effort, 'xhigh');
  assert.equal(parsed.flags.model, 'gpt-5.6-sol');
  assert.throws(() => parseDispatcher(['review','run','--engine','codex','--prompt-file','prompt.tmp',
    '--timeout-ms','1000','--mode','read-only','--effort','extreme']), /invalid-enum/);
  const contract = ROUTE_CONTRACTS.get('review run');
  assert.ok(contract.readSet.includes('validated-effort'));
  assert.ok(contract.readSet.includes('validated-review-model'));
});

function reviewResult(exitCode = 0, stdout = 'ok') {
  return { exitCode, stdout, stderr: exitCode ? 'failed' : '' };
}

test('Codex effort probe success applies -c and records high effort as applied', async () => {
  const runs = [];
  const result = await executeReviewProcess({ engine: 'codex',
    resolved: { executable: '/codex', argv: ['exec','--sandbox','read-only','--model','gpt-5.6-sol','-'] },
    prompt: Buffer.from('review'), timeoutMs: 1000, cwd: '/repo', env: {}, effort: 'high', model: 'gpt-5.6-sol',
    probeProcess: async () => reviewResult(0, 'medium high xhigh max'),
    runProcess: async (spec) => { runs.push(spec.args); return reviewResult(); } });
  assert.deepEqual(runs, [['exec','--sandbox','read-only','--model','gpt-5.6-sol',
    '-c','model_reasoning_effort=high','-']]);
  assert.equal(result.effort_applied, true);
  assert.equal(result.effort_clamped, false);
  assert.equal(result.fallback_used, false);
});

test('Codex effort probe preserves a Node package launcher argv prefix', async () => {
  const probes = [];
  await executeReviewProcess({ engine: 'codex',
    resolved: { executable: process.execPath,
      argv: ['/node_modules/@openai/codex/bin/codex.js','exec','--sandbox','read-only','-'] },
    prompt: Buffer.from('review'), timeoutMs: 1000, cwd: '/repo', env: {}, effort: 'high', model: 'gpt-5.6-sol',
    probeProcess: async (spec) => { probes.push(spec); return reviewResult(0, 'medium high xhigh max'); },
    runProcess: async () => reviewResult() });
  assert.deepEqual(probes, [{ executable: process.execPath,
    args: ['/node_modules/@openai/codex/bin/codex.js','debug','models','--bundled'] }]);
});

test('Codex max clamps to xhigh for non-gpt-5.6 and records the clamp', async () => {
  const runs = [];
  const result = await executeReviewProcess({ engine: 'codex',
    resolved: { executable: '/codex', argv: ['exec','--sandbox','read-only','-'] },
    prompt: Buffer.from('review'), timeoutMs: 1000, cwd: '/repo', env: {}, effort: 'max', model: 'gpt-5.5-codex',
    probeProcess: async () => reviewResult(0, 'medium high xhigh'),
    runProcess: async (spec) => { runs.push(spec.args); return reviewResult(); } });
  assert.ok(runs[0].includes('model_reasoning_effort=xhigh'));
  assert.equal(result.effort_applied, true);
  assert.equal(result.effort_clamped, true);
});

test('Codex effort probe failure retries without the flag and records not applied', async () => {
  const runs = [];
  const result = await executeReviewProcess({ engine: 'codex',
    resolved: { executable: '/codex', argv: ['exec','--sandbox','read-only','-'] },
    prompt: Buffer.from('review'), timeoutMs: 1000, cwd: '/repo', env: {}, effort: 'xhigh', model: 'gpt-5.6-sol',
    probeProcess: async () => reviewResult(1),
    runProcess: async (spec) => { runs.push(spec.args); return reviewResult(); } });
  assert.deepEqual(runs, [['exec','--sandbox','read-only','-']]);
  assert.equal(result.effort_applied, false);
  assert.equal(result.fallback_used, true);
  assert.equal(result.effort_failure, 'probe-failed');
});

test('Codex effort execution failure retries once without -c', async () => {
  const runs = [];
  const result = await executeReviewProcess({ engine: 'codex',
    resolved: { executable: '/codex', argv: ['exec','--sandbox','read-only','-'] },
    prompt: Buffer.from('review'), timeoutMs: 1000, cwd: '/repo', env: {}, effort: 'high', model: 'gpt-5.6-sol',
    probeProcess: async () => reviewResult(0, 'medium high xhigh max'),
    runProcess: async (spec) => { runs.push(spec.args); return runs.length === 1 ? reviewResult(2) : reviewResult(); } });
  assert.ok(runs[0].includes('model_reasoning_effort=high'));
  assert.ok(!runs[1].some((arg) => arg.startsWith('model_reasoning_effort=')));
  assert.equal(result.effort_applied, false);
  assert.equal(result.fallback_used, true);
  assert.equal(result.effort_failure, 'execution-failed');
});

test('Gemini review never receives effort and records unsupported-channel', async () => {
  const runs = [];
  const result = await executeReviewProcess({ engine: 'gemini',
    resolved: { executable: '/gemini', argv: ['--approval-mode','plan'] }, prompt: Buffer.from('review'),
    timeoutMs: 1000, cwd: '/repo', env: {}, effort: 'high', model: 'gemini-2',
    probeProcess: async () => { throw new Error('must not probe'); },
    runProcess: async (spec) => { runs.push(spec.args); return reviewResult(); } });
  assert.deepEqual(runs, [['--approval-mode','plan']]);
  assert.equal(result.effort_applied, false);
  assert.equal(result.effort_channel, 'unsupported-channel');
});

test('owned-temp dispatcher allocates, writes, adopts, and compare-removes its derived path', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dw-temp-route-')));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.mkdirSync(path.join(root, '.deep-work', 's-aaaaaaaa'), {recursive:true});
  const state = path.join(root, '.claude', 'deep-work.s-aaaaaaaa.md');
  fs.writeFileSync(state, '---\nsession_id: s-aaaaaaaa\nwork_dir: .deep-work/s-aaaaaaaa\ncurrent_phase: implement\n---\n');
  const created = await dispatch(['temp','create','--state',state,'--session','s-aaaaaaaa',
    '--purpose','receipt-payload'], {cwd:root});
  assert.match(created.operationId, /^op-[0-9a-f]{64}$/);
  assert.equal(path.basename(created.path), 'receipt-payload.tmp');
  const written = await dispatch(['temp','write','--state',state,'--session','s-aaaaaaaa',
    '--temp-operation-id',created.operationId,'--stdin'], {cwd:root,stdin:'payload'});
  assert.equal(written.status, 'written');
  assert.equal((await dispatch(['temp','write','--state',state,'--session','s-aaaaaaaa',
    '--temp-operation-id',created.operationId,'--stdin'], {cwd:root,stdin:'payload'})).status, 'adopted');
  await dispatch(['temp','remove','--state',state,'--session','s-aaaaaaaa',
    '--temp-operation-id',created.operationId,'--expected-sha256',written.sha256], {cwd:root});
  assert.equal(fs.existsSync(created.path), false);
});

test('spec-governed Medium+ test pass dispatcher route fails closed without committed plan or evidence package', async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-test-pass-strict-route-')));const session='s-aaaaaaaa';
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));const work=path.join(root,'.deep-work',session);
  fs.mkdirSync(work,{recursive:true});const state=path.join(root,'.claude',`deep-work.${session}.md`);
  fs.writeFileSync(state,updateFrontmatterText('',{schema_version:2,session_id:session,work_dir:`.deep-work/${session}`,
    current_phase:'test',created_by_version:'6.13.0',spec_policy_required:true,
    risk_profile_json:JSON.stringify({class:'medium',score:6,triggers:['strict-admission']}),review_execution_json:'{}'}));
  const plan=writeJson(path.join(work,'plan.json'),{schema_version:1,contract_binding:{mode:'strict-spec',
    created_by_version:'6.13.0'},slices:[],quality_gates:[]});
  const gates=writeJson(path.join(work,'gate-results.json'),{complete:true,failedSlices:[]});
  await assert.rejects(()=>dispatch(['test','pass','--state',state,'--plan',plan,'--gate-results-json',gates,
    '--at',ROUTE_TIMESTAMP],{cwd:root}),(error)=>error?.code==='gate-results-verification-plan');
  assert.doesNotMatch(fs.readFileSync(state,'utf8'),/^test_passed:\s*true$/m);
});

test('v6.14 test admission consumes the canonical projection blocker set',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    'dw-test-pass-governed-route-'))),session='s-aaaaaaaa';
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const work=path.join(root,'.deep-work',session);fs.mkdirSync(work,{recursive:true});
  const state=path.join(root,'.claude',`deep-work.${session}.md`);
  fs.writeFileSync(state,updateFrontmatterText('',{schema_version:2,session_id:session,
    work_dir:`.deep-work/${session}`,current_phase:'test',
    created_by_version:'6.14.0',review_execution_json:'{}'}));
  const plan=writeJson(path.join(work,'plan.json'),{schema_version:1,
    contract_binding:{mode:'strict-spec',created_by_version:'6.14.0'},
    slices:[],quality_gates:[]});
  const gates=writeJson(path.join(work,'gate-results.json'),
    {complete:true,failedSlices:[]});
  await assert.rejects(()=>dispatch(['test','pass','--state',state,'--plan',plan,
    '--gate-results-json',gates,'--at',ROUTE_TIMESTAMP],{cwd:root}),
  (error)=>error?.code==='test-governed-admission'&&
    /finding-required-unknown/.test(error.message)&&
    /residual-risk-unaccepted/.test(error.message));
  assert.doesNotMatch(fs.readFileSync(state,'utf8'),/^test_passed:\s*true$/m);
});

test('all finish dispatcher outcomes reject fresh Medium+ legacy bypass and forged evidence summaries',async(t)=>{
  for(const outcome of ['keep','merge','publish-pr','discard']){
    await t.test(`${outcome}: missing committed verification plan`,async()=>{
      const fixture=strictFinishFixture({forgedSummary:false});
      await assert.rejects(()=>dispatch(finishArgv(outcome,fixture),{cwd:fixture.root}),
        (error)=>error?.code==='finish-verification-plan-required');
      assert.equal(fs.existsSync(path.join(fixture.work,'.operation-results')),false);
    });
    await t.test(`${outcome}: forged review.evidence summary without committed package`,async()=>{
      const fixture=strictFinishFixture({forgedSummary:true});
      await assert.rejects(()=>dispatch(finishArgv(outcome,fixture),{cwd:fixture.root}),
        (error)=>error?.code==='finish-evidence-package');
      assert.equal(fs.existsSync(path.join(fixture.work,'.operation-results')),false);
    });
  }
});

test('fresh pure-LOW v6.13 production flow compiles minimal authority and reaches finish keep',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-low-v613-full-flow-'))),session='s-aaaaaaaa';
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));const work=path.join(root,'.deep-work',session);
  fs.mkdirSync(work,{recursive:true});const state=path.join(root,'.claude',`deep-work.${session}.md`),contract=lowFlowContract(),
    specText=lowSpecMarkdown(contract),specPath=path.join(work,'spec.md');fs.writeFileSync(specPath,specText);const specApprovedHash=
    crypto.createHash('sha256').update(specText).digest('hex'),riskProfile={class:'low',score:2,triggers:[]},riskProfileSha256='b'.repeat(64),
    planPath=path.join(work,'plan.md');fs.writeFileSync(planPath,lowPlanMarkdown(contract,specApprovedHash,riskProfileSha256));
  fs.writeFileSync(state,updateFrontmatterText('',{schema_version:2,session_id:session,work_dir:`.deep-work/${session}`,
    current_phase:'research',created_by_version:'6.13.0',spec_policy_required:null,risk_profile_json:canonicalJson(riskProfile),
    risk_profile_sha256:riskProfileSha256,methodology_policy_json:canonicalJson({risk_class:'low',profile:'lean',
      verification_policy:{recommended:'최소 검증 (기록 전용)'}}),slice_risk_shadow_json:canonicalJson({'SLICE-001':{class:'low',
      score:2,triggers:['low-flow']}}),review_execution_json:'{}',receipt_invalidations_json:'[]'}));
  writeJson(path.join(root,'.claude','deep-work-sessions.json'),{version:1,shared_files:[],sessions:{[session]:{pid:process.pid,
    task_description:'LOW v6.13 full flow',work_dir:`.deep-work/${session}`,current_phase:'research',file_ownership:[],
    last_activity:ROUTE_TIMESTAMP}}});fs.writeFileSync(path.join(root,'.claude','deep-work-current-session'),`${session}\n`);
  await dispatch(['phase','spec','enter','--state',state,'--at',ROUTE_TIMESTAMP],{cwd:root});
  await dispatch(['phase','spec','approve','--state',state,'--artifact',specPath,'--at',ROUTE_TIMESTAMP],{cwd:root});
  await dispatch(['phase','advance','--state',state,'--from','spec','--to','plan','--at',ROUTE_TIMESTAMP],{cwd:root});
  await dispatch(['phase','approve','--state',state,'--phase','plan','--artifact',planPath,'--at',ROUTE_TIMESTAMP],{cwd:root});
  let fields=parseFrontmatter(fs.readFileSync(state,'utf8')).fields;assert.match(fields.verification_plan_sha256,/^[0-9a-f]{64}$/);
  const verificationPlan=JSON.parse(fields.verification_plan_json),plan=JSON.parse(fs.readFileSync(path.join(work,'plan.json'),'utf8'));
  assert.equal(verificationPlan.risk_class,'low');assert.equal(verificationPlan.profile,'lean');
  await dispatch(['phase','advance','--state',state,'--from','plan','--to','implement','--at',ROUTE_TIMESTAMP],{cwd:root});
  await dispatch(['phase','advance','--state',state,'--from','implement','--to','test','--at',ROUTE_TIMESTAMP],{cwd:root});
  const published=await publishLowFlowEvidence({root,state,work,plan,verificationPlan,specContract:contract}),gateResults={complete:true,
    failedSlices:[],verification_plan_sha256:verificationPlan.plan_sha256,package_sha256:published.package.package_sha256,
    gates:requiredGateIds(verificationPlan,{at:'test'}).map((id)=>({id,status:'pass',evidence_ids:published.package.records
      .filter((row)=>row.gate_id===id&&row.status==='pass').map((row)=>row.evidence_id)}))};
  const completedProjection=JSON.parse(fs.readFileSync(path.join(work,'plan.json'),'utf8'));
  completedProjection.slices[0].checked=true;
  fs.writeFileSync(path.join(work,'plan.json'),canonicalJson(completedProjection));
  const gatePath=writeJson(path.join(work,'gate-results.json'),gateResults);await dispatch(['test','pass','--state',state,'--plan',
    path.join(work,'plan.json'),'--gate-results-json',gatePath,'--at',ROUTE_TIMESTAMP],{cwd:root});
  fields=parseFrontmatter(fs.readFileSync(state,'utf8')).fields;assert.equal(fields.test_passed,true);
  const stateCap=platform.issueProjectStateCapability(root,state,{role:'session-state'}),workCap=platform.issueProjectStateCapability(root,work,
    {role:'session-work-dir',sessionStateCapability:stateCap}),temp=await artifactRuntime.createOwnedTemp({sessionCapability:workCap,
      purpose:'receipt-payload'});await artifactRuntime.writeOwnedTemp({sessionCapability:workCap,operationId:temp.operationId,
      purpose:'receipt-payload'},Buffer.from('{"schema_version":"1.0","status":"complete"}\n'));
  const finished=await dispatch(['session','finish','keep','--state',state,'--session',session,'--receipt-payload',temp.path],{cwd:root});
  assert.equal(finished.status,'completed');assert.equal(finished.outcome,'keep');
});

test('finish keep holds the full store transaction and publishes from the finalized state identity', async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-finish-keep-route-')));const session='s-aaaaaaaa';
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));const workDir=path.join(root,'.deep-work',session);
  fs.mkdirSync(workDir,{recursive:true});const state=path.join(root,'.claude',`deep-work.${session}.md`);
  fs.writeFileSync(state,'---\nsession_id: s-aaaaaaaa\nwork_dir: .deep-work/s-aaaaaaaa\ncurrent_phase: implement\ncreated_by_version: 6.12.0\n---\n');
  fs.writeFileSync(path.join(root,'.claude','deep-work-sessions.json'),`${JSON.stringify({version:1,shared_files:[],sessions:{
    [session]:{pid:process.pid,task_description:'finish',work_dir:`.deep-work/${session}`,current_phase:'implement',file_ownership:[],
      last_activity:ROUTE_TIMESTAMP}}})}\n`);fs.writeFileSync(path.join(root,'.claude','deep-work-current-session'),`${session}\n`);
  const stateCap=platform.issueProjectStateCapability(root,state,{role:'session-state'});const workCap=
    platform.issueProjectStateCapability(root,workDir,{role:'session-work-dir',sessionStateCapability:stateCap});
  const authored={status:'authored',note:'keep'};const temp=await artifactRuntime.createOwnedTemp({sessionCapability:workCap,
    purpose:'receipt-payload'});await artifactRuntime.writeOwnedTemp({sessionCapability:workCap,operationId:temp.operationId,
      purpose:'receipt-payload'},Buffer.from(`${JSON.stringify(authored)}\n`));
  const result=await dispatch(['session','finish','keep','--state',state,'--session',session,'--receipt-payload',temp.path],{cwd:root});
  assert.equal(result.status,'completed');assert.equal(result.outcome,'keep');assert.equal(fs.existsSync(result.resultPath),true);
  const payload=JSON.parse(fs.readFileSync(result.resultPath,'utf8'));assert.equal(payload.note,'keep');assert.equal(payload.finish_outcome,'keep');
  assert.equal(fs.existsSync(path.join(root,'.claude','deep-work-current-session')),false);const registry=JSON.parse(fs.readFileSync(
    path.join(root,'.claude','deep-work-sessions.json'),'utf8'));assert.equal(registry.sessions[session],undefined);
});

test('finish keep resumes result publication from its journal without rereading a consumed temp',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dw-finish-keep-resume-')));const session='s-bbbbbbbb';
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));const work=path.join(root,'.deep-work',session);
  fs.mkdirSync(work,{recursive:true});const statePath=path.join(root,'.claude',`deep-work.${session}.md`);fs.writeFileSync(statePath,
    '---\nsession_id: s-bbbbbbbb\nwork_dir: .deep-work/s-bbbbbbbb\ncurrent_phase: implement\ncreated_by_version: 6.12.0\n---\n');fs.writeFileSync(
    path.join(root,'.claude','deep-work-sessions.json'),`${JSON.stringify({version:1,shared_files:[],sessions:{[session]:{pid:process.pid,
      task_description:'resume',work_dir:'.deep-work/s-bbbbbbbb',current_phase:'implement',file_ownership:[],last_activity:ROUTE_TIMESTAMP}}})}\n`);
  const state=platform.issueProjectStateCapability(root,statePath,{role:'session-state'});const sessionCap=platform.issueProjectStateCapability(root,
    work,{role:'session-work-dir',sessionStateCapability:state});const temp=await artifactRuntime.createOwnedTemp({sessionCapability:sessionCap,
    purpose:'receipt-payload'});await artifactRuntime.writeOwnedTemp({sessionCapability:sessionCap,operationId:temp.operationId,
      purpose:'receipt-payload'},Buffer.from('{"status":"authored","proof":"journal"}\n'));const argv=['session','finish','keep','--state',statePath,
    '--session',session,'--receipt-payload',temp.path];const publish=artifactRuntime.publishFinalizedReceipt;artifactRuntime.publishFinalizedReceipt=()=>{
      const error=new Error('lost-result-publication');error.code='lost-result-publication';throw error;};
  try{await assert.rejects(()=>dispatch(argv,{cwd:root}),/lost-result-publication/);}finally{artifactRuntime.publishFinalizedReceipt=publish;}
  fs.writeFileSync(temp.path,'foreign-after-consume\n');const result=await dispatch(argv,{cwd:root});const payload=JSON.parse(
    fs.readFileSync(result.resultPath,'utf8'));assert.equal(payload.proof,'journal');assert.equal(payload.finish_outcome,'keep');
});

test('all 118 grammar rows cross the parser and invoke their typed route semantics', async (t) => {
  assert.equal(DISPATCHER_GRAMMAR.length, 118);
  const outcomes = [];
  for (let index = 0; index < DISPATCHER_GRAMMAR.length; index += 1) {
    const entry = DISPATCHER_GRAMMAR[index];
    await t.test(entry.id, async () => {
      const fx = await semanticFixture(entry, index);
      const argv = await semanticArgv(entry, fx);
      assert.equal(parseDispatcher(argv).entry.id, entry.id);
      try {
        const value = await dispatch(argv, {cwd:fx.root,stdin:'semantic stdin'});
        assert.notEqual(value, undefined);
        outcomes.push({id:entry.id,status:'completed'});
      } catch (error) {
        assert.equal(typeof error.code, 'string', `${entry.id}: untyped error ${error.stack}`);
        assert.equal(error instanceof TypeError, false, `${entry.id}: ${error.stack}`);
        assert.equal(['ENOENT','ENOTDIR','EISDIR'].includes(error.code), false,
          `${entry.id}: stopped at an unprepared filesystem boundary: ${error.stack}`);
        outcomes.push({id:entry.id,status:'typed-rejection',code:error.code});
      } finally {
        fs.rmSync(fx.root, {recursive:true,force:true});
      }
    });
  }
  assert.deepEqual(outcomes.map((row) => row.id), DISPATCHER_GRAMMAR.map((entry) => entry.id));
  assert.equal(outcomes.length, 118);
});

test('CLI prints one JSON value and uses validation exit 1', () => {
  const cli = path.resolve(__dirname, 'deep-work-runtime.js');
  const good = spawnSync(process.execPath, [cli,'git','capability'], {encoding:'utf8'});
  assert.equal(good.status, 0, good.stderr);
  assert.doesNotThrow(() => JSON.parse(good.stdout));
  const bad = spawnSync(process.execPath, [cli,'unknown'], {encoding:'utf8'});
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
});
