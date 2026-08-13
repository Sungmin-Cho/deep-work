'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const platform=require('./platform.js');
const journal=require('./operation-journal.js');
const {buildFunctionalSliceReceiptV2,validateFunctionalSliceReceiptV2,
  validateRefactorEvidenceV1,semanticDigest,
  buildFunctionalReceiptTargetLocks,reconstructInvalidatedFunctionalReceipt,
  validateFunctionalCompletionLedger,assertFunctionalRecoveryState,
  serializeFunctionalReceiptBindings,authenticateFunctionalReceiptBinding,
  requiresFunctionalReceiptBinding,recoveryInvalidationState,
  recoveryGenerationFloor}=
  require('./functional-receipt-runtime.js');

const op=(char)=>`op-${char.repeat(64)}`;
const ref=(char)=>({operation_id:op(char),
  result_path:`.claude/deep-work.s-aaaaaaaa.verification.${op(char)}.json`,
  result_sha256:char.repeat(64),ledger_result_sha256:
    (char==='f'?'e':((Number.parseInt(char,16)+1)%16).toString(16)).repeat(64)});
function noRefactor(){
  const value={kind:'no-refactor',decision_operation_id:op('3'),
    reason_code:'no-duplication',post_decision_green:ref('4'),
    sensor_results:[{kind:'lint',operation_id:op('5'),
      result_path:'.claude/deep-work.s-aaaaaaaa.sensor.result.json',
      result_sha256:'6'.repeat(64),ledger_result_sha256:'7'.repeat(64)}],
    decision_sha256:null};
  value.decision_sha256=semanticDigest('refactor-evidence-v1',value,
    'decision_sha256');
  return value;
}
function receipt(){
  return buildFunctionalSliceReceiptV2({session_id:'s-aaaaaaaa',
    slice_id:'SLICE-001',plan_authority_sha256:'8'.repeat(64),
    verification_plan_sha256:'9'.repeat(64),
    red_proof_ref:`.deep-work/s-aaaaaaaa/red-proofs/${'a'.repeat(64)}.json`,
    red_proof_sha256:'a'.repeat(64),red_proof_operation_id:op('b'),
    green_verification:ref('c'),refactor_evidence:noRefactor()});
}

function assertDeterministicCompletionIdentity(){
  const first=receipt(),second=receipt();
  assert.deepEqual(first,second);
  assert.match(first.completion_operation_id,/^op-[0-9a-f]{64}$/);
  assert.equal(validateFunctionalSliceReceiptV2(first).receipt_sha256,
    first.receipt_sha256);
}

function assertDuplicateSensorAuthorityRejected(){
  const value=noRefactor();
  value.sensor_results.push({...value.sensor_results[0]});
  value.decision_sha256=semanticDigest('refactor-evidence-v1',value,
    'decision_sha256');
  assert.throws(()=>validateRefactorEvidenceV1(value),/sensor-result-refs/);
}

function assertSwappedAuthorityRejected(){
  const green=receipt();green.green_verification.result_sha256='f'.repeat(64);
  assert.throws(()=>validateFunctionalSliceReceiptV2(green),
    /functional-receipt-digest/);
  const proof=receipt();proof.red_proof_sha256='f'.repeat(64);
  assert.throws(()=>validateFunctionalSliceReceiptV2(proof),
    /functional-receipt-digest/);
}
test('invalidated native functional receipts reconstruct only their original v2 identity',()=>{
  const original=receipt();
  const invalidated={...original,status:'invalidated'};
  const reconstructed=reconstructInvalidatedFunctionalReceipt({legacy:invalidated,
    sessionId:'s-aaaaaaaa',sliceId:'SLICE-001',
    plan:{plan_authority_sha256:original.plan_authority_sha256},
    verificationPlanSha256:original.verification_plan_sha256});
  assert.deepEqual(reconstructed,original);
  assert.throws(()=>reconstructInvalidatedFunctionalReceipt({
    legacy:{...invalidated,receipt_sha256:'0'.repeat(64)},
    sessionId:'s-aaaaaaaa',sliceId:'SLICE-001',plan:{plan_authority_sha256:original.plan_authority_sha256},
    verificationPlanSha256:original.verification_plan_sha256}),
  /functional-recovery-receipt/);
  assert.throws(()=>reconstructInvalidatedFunctionalReceipt({
    legacy:{...invalidated,schema_version:'1.0'},
    sessionId:'s-aaaaaaaa',sliceId:'SLICE-001',plan:{plan_authority_sha256:original.plan_authority_sha256},
    verificationPlanSha256:original.verification_plan_sha256}),
  /functional-recovery-receipt/);
  assert.throws(()=>reconstructInvalidatedFunctionalReceipt({legacy:invalidated,
    sessionId:'s-bbbbbbbb',sliceId:'SLICE-001',
    plan:{plan_authority_sha256:original.plan_authority_sha256},
    verificationPlanSha256:original.verification_plan_sha256}),
  /functional-recovery-receipt/);
});
test('functional receipt target locks follow capability path byte order',()=>{
  assertDeterministicCompletionIdentity();
  assertDuplicateSensorAuthorityRejected();
  assertSwappedAuthorityRejected();
  assert.strictEqual(typeof buildFunctionalReceiptTargetLocks==='function',true,
    'functional receipt target lock order invalid');
  const crypto=require('node:crypto');
  const path=require('node:path');
  const lockPath=(pathApi,root,target)=>pathApi.join(root,'.claude',
    `deep-work.target.${crypto.createHash('sha256')
      .update(pathApi.relative(root,target)).digest('hex')}.lock`);
  for(const [pathApi,root] of [[path.posix,'/repo'],[path.win32,'C:\\repo']]){
    const targets=[pathApi.join(root,'.deep-work','s-00000000','plan.json'),
      pathApi.join(root,'.deep-work','s-00000000','receipts','SLICE-001.json')]
      .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
    const derived=targets.map((target)=>lockPath(pathApi,root,target));
    assert.deepEqual([...derived].sort((a,b)=>Buffer.compare(Buffer.from(a),
      Buffer.from(b))),derived.toReversed(),
    'deterministic target and lock orders must be inverted');
  }
  const root='/repo';
  const targets=[path.join(root,'.deep-work','s-00000000','plan.json'),
    path.join(root,'.deep-work','s-00000000','receipts','SLICE-001.json')]
    .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const derived=targets.map((target)=>lockPath(path,root,target));
  assert.deepEqual([...derived].sort((a,b)=>Buffer.compare(Buffer.from(a),
    Buffer.from(b))),derived.toReversed(),
  'helper fixture must preserve the inverted target and lock orders');
  const requests=buildFunctionalReceiptTargetLocks({root,targets,rank:4,
    issueCapability:(_root,candidate)=>({path:candidate})});
  assert.deepEqual(requests.map((row)=>row.capability.path),
    [...derived].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),
  'functional receipt target lock order invalid');
  let emptyTargetsRejected=false;
  try{buildFunctionalReceiptTargetLocks({root,targets:[],rank:4,
    issueCapability:(_root,candidate)=>({path:candidate})});}
  catch(error){emptyTargetsRejected=/functional-completion-locks/.test(error.message);}
  assert.strictEqual(emptyTargetsRejected,true,
    'functional receipt target lock order invalid');
  assert.match(require('node:fs').readFileSync(
    require.resolve('./functional-receipt-runtime.js'),'utf8'),
  /buildFunctionalReceiptTargetLocks\(\{root,targets:/,
  'publication must use the tested target-lock helper');
});
test('completion-ledger adoption returns the flat public result contract',()=>{
  const current=receipt();
  const result={session_id:'s-aaaaaaaa',slice_id:'SLICE-001',
    receipt_path:'.deep-work/s-aaaaaaaa/receipts/SLICE-001.json',
    receipt_sha256:current.receipt_sha256,post_state_sha256:'d'.repeat(64)};
  const completed={stage:'completed-ledger',result,
    resultSha256:require('./operation-journal.js').sha256(
      require('./operation-journal.js').canonicalJson(result))};
  assert.deepEqual(validateFunctionalCompletionLedger(completed,{
    sessionId:'s-aaaaaaaa',sliceId:'SLICE-001',
    receiptRelative:result.receipt_path,receipt:current}),result);
});
test('invalidated functional replacement requires a reset plan and fresh TDD cycle',()=>{
  assert.throws(()=>assertFunctionalRecoveryState({
    target:{id:'SLICE-001',checked:true},
    fields:{active_slice:null,tdd_state:'PENDING'}}),
  /functional-recovery-plan-not-reset/);
  assert.throws(()=>assertFunctionalRecoveryState({
    target:{id:'SLICE-001',checked:false},
    fields:{active_slice:'SLICE-001',tdd_state:'GREEN'}}),
  /functional-recovery-plan-not-reset/);
  for(const checked of [null,0,''])assert.throws(()=>assertFunctionalRecoveryState({
    target:{id:'SLICE-001',checked},
    fields:{active_slice:'SLICE-001',tdd_state:'SENSOR_CLEAN'}}),
  /functional-recovery-plan-not-reset/);
  assert.equal(assertFunctionalRecoveryState({
    target:{id:'SLICE-001',checked:false},
    fields:{active_slice:'SLICE-001',tdd_state:'SENSOR_CLEAN'}}),true);
});

test('functional receipt binding rejects restored evidence after retry invalidation',()=>{
  const current=receipt();
  const invalidatedFields={test_retry_count:1,receipt_recovery_generation:1,
    functional_receipt_bindings_json:serializeFunctionalReceiptBindings({
      'SLICE-001':{recovery_generation:1,receipt_sha256:null,
        completion_operation_id:null}})};
  assert.equal(requiresFunctionalReceiptBinding(invalidatedFields),true);
  assert.doesNotThrow(()=>authenticateFunctionalReceiptBinding({
    fields:invalidatedFields,sliceId:'SLICE-001',invalidated:true,
    requireBinding:true}));
  assert.throws(()=>authenticateFunctionalReceiptBinding({
    fields:invalidatedFields,sliceId:'SLICE-001',receipt:current,
    requireBinding:true}),/functional-receipt-binding/);
  const currentFields={test_retry_count:1,receipt_recovery_generation:1,
    functional_receipt_bindings_json:serializeFunctionalReceiptBindings({
      'SLICE-001':{recovery_generation:1,
        receipt_sha256:current.receipt_sha256,
        completion_operation_id:current.completion_operation_id}})};
  assert.doesNotThrow(()=>authenticateFunctionalReceiptBinding({
    fields:currentFields,sliceId:'SLICE-001',receipt:current,
    requireBinding:true}));
  assert.throws(()=>authenticateFunctionalReceiptBinding({
    fields:{...currentFields,functional_receipt_bindings_json:
      serializeFunctionalReceiptBindings({'SLICE-001':{
        recovery_generation:1,receipt_sha256:'0'.repeat(64),
        completion_operation_id:'op-'+'0'.repeat(64)}})},
    sliceId:'SLICE-001',receipt:current,requireBinding:true}),
  /functional-receipt-binding/);
});

test('completed retry history establishes an invalidation floor for old bindings',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    'dw-functional-recovery-history-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const sessionId='s-aaaaaaaa';
  const result={status:'completed',failedSlices:['SLICE-001'],
    invalidatedSlices:['SLICE-001'],invalidated_slices:['SLICE-001'],
    recovery_generation:1,invalidated_functional_receipts:[{slice_id:'SLICE-001',
      receipt_sha256:'a'.repeat(64),completion_operation_id:op('b')}]};
  const row={version:1,operationId:op('8'),sessionId,kind:'test-retry',
    stage:'completed-ledger',result,resultSha256:journal.sha256(
      journal.canonicalJson(result)),completedAt:'2026-08-13T00:00:00.000Z'};
  fs.writeFileSync(path.join(root,'.claude',
    `deep-work.${sessionId}.completed-operations.json`),journal.canonicalJson({
      version:1,receipts:[row]}));
  const projectCapability=platform.issueProjectStateCapability(root,root,
    {role:'project-root'});
  assert.equal(require('./functional-receipt-runtime.js').recoveryInvalidationFloor({
    projectCapability,sessionId,sliceId:'SLICE-001'}),1);
  assert.throws(()=>authenticateFunctionalReceiptBinding({
    fields:{test_retry_count:1,receipt_recovery_generation:1,
      functional_receipt_bindings_json:serializeFunctionalReceiptBindings({
        'SLICE-001':{recovery_generation:0,receipt_sha256:'a'.repeat(64),
          completion_operation_id:op('b')}})},sliceId:'SLICE-001',
    receipt:{receipt_sha256:'a'.repeat(64),completion_operation_id:op('b')},
    requireBinding:true,minRecoveryGeneration:1}),/functional-receipt-binding/);
  assert.throws(()=>authenticateFunctionalReceiptBinding({
    fields:{test_retry_count:1,receipt_recovery_generation:1},sliceId:'SLICE-001',
    receipt:{receipt_sha256:'a'.repeat(64),completion_operation_id:op('b')},
    requireBinding:false,minRecoveryGeneration:1,
    invalidatedReceiptIdentities:[{receipt_sha256:'a'.repeat(64),
      completion_operation_id:op('b')}]}),/functional-receipt-binding/);
});

test('legacy retry history remains binding-required after the retry counter resets',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    'dw-functional-legacy-recovery-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const sessionId='s-aaaaaaaa';
  const result={status:'completed',failedSlices:['SLICE-001']};
  const row={version:1,operationId:op('9'),sessionId,kind:'test-retry',
    stage:'completed-ledger',result,resultSha256:journal.sha256(
      journal.canonicalJson(result)),completedAt:'2026-08-13T00:00:00.000Z'};
  fs.writeFileSync(path.join(root,'.claude',
    `deep-work.${sessionId}.completed-operations.json`),journal.canonicalJson({
      version:1,receipts:[row]}));
  const projectCapability=platform.issueProjectStateCapability(root,root,
    {role:'project-root'});
  const history=recoveryInvalidationState({projectCapability,sessionId,
    sliceId:'SLICE-001'});
  assert.equal(history.floor,0);assert.equal(history.historyComplete,false);
  const fields={test_retry_count:0};
  assert.equal(requiresFunctionalReceiptBinding(fields,'SLICE-001',
    history.floor,history.historyComplete),true);
  assert.throws(()=>authenticateFunctionalReceiptBinding({fields,
    sliceId:'SLICE-001',receipt,requireBinding:requiresFunctionalReceiptBinding(
      fields,'SLICE-001',history.floor,history.historyComplete),
    invalidationHistoryComplete:history.historyComplete}),
  /functional-receipt-binding/);
});

test('a complete current retry row seals an earlier legacy history gap for its generation',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    'dw-functional-mixed-recovery-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const sessionId='s-aaaaaaaa';
  const legacyResult={status:'completed',failedSlices:['SLICE-001']};
  const currentResult={status:'completed',failedSlices:['SLICE-001'],
    invalidatedSlices:['SLICE-001'],invalidated_slices:['SLICE-001'],
    recovery_generation:2,invalidated_functional_receipts:[{slice_id:'SLICE-001',
      receipt_sha256:'a'.repeat(64),completion_operation_id:op('b')}]};
  const row=(operationId,result)=>({version:1,operationId,sessionId,
    kind:'test-retry',stage:'completed-ledger',result,resultSha256:journal.sha256(
      journal.canonicalJson(result)),completedAt:'2026-08-13T00:00:00.000Z'});
  fs.writeFileSync(path.join(root,'.claude',
    `deep-work.${sessionId}.completed-operations.json`),journal.canonicalJson({
      version:1,receipts:[row(op('8'),legacyResult),row(op('9'),currentResult)]}));
  const projectCapability=platform.issueProjectStateCapability(root,root,
    {role:'project-root'});
  const history=recoveryInvalidationState({projectCapability,sessionId,
    sliceId:'SLICE-001'});
  assert.equal(history.floor,2);assert.equal(history.historyComplete,true);
  const currentReceipt={receipt_sha256:'c'.repeat(64),
    completion_operation_id:op('d')};
  assert.doesNotThrow(()=>authenticateFunctionalReceiptBinding({
    fields:{test_retry_count:2,receipt_recovery_generation:2,
      functional_receipt_bindings_json:serializeFunctionalReceiptBindings({
        'SLICE-001':{recovery_generation:2,
          receipt_sha256:currentReceipt.receipt_sha256,
          completion_operation_id:currentReceipt.completion_operation_id}})},
    sliceId:'SLICE-001',receipt:currentReceipt,requireBinding:true,
    minRecoveryGeneration:history.floor,
    invalidatedReceiptIdentities:history.identities,
    invalidationHistoryComplete:history.historyComplete}));
  assert.throws(()=>authenticateFunctionalReceiptBinding({
    fields:{test_retry_count:2,receipt_recovery_generation:2,
      functional_receipt_bindings_json:serializeFunctionalReceiptBindings({
        'SLICE-001':{recovery_generation:2,
          receipt_sha256:currentReceipt.receipt_sha256,
          completion_operation_id:currentReceipt.completion_operation_id}})},
    sliceId:'SLICE-001',receipt:{receipt_sha256:'a'.repeat(64),
      completion_operation_id:op('b')},requireBinding:true,
    minRecoveryGeneration:history.floor,
    invalidatedReceiptIdentities:history.identities,
    invalidationHistoryComplete:history.historyComplete}),
  /functional-receipt-binding/);
});

test('a later legacy row reopens the recovery history boundary across retry kinds',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    'dw-functional-recovery-order-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const sessionId='s-aaaaaaaa';
  const completeResult={status:'completed',failedSlices:['SLICE-001'],
    invalidated_slices:['SLICE-001'],recovery_generation:2,
    invalidated_functional_receipts:[]};
  const legacyResult={status:'completed',failedSlices:['SLICE-001']};
  const projectCapability=platform.issueProjectStateCapability(root,root,
    {role:'project-root'});
  const complete=(operationId,kind,result)=>journal.beginOperation({projectCapability,
    sessionId,kind,operationId,preconditions:{}}).then((operation)=>
    journal.completeOperation(operation,result));
  // The current-format exhaust row completes first. The later legacy retry row
  // deliberately has the lower lexical operation ID so operation-ID sorting
  // would incorrectly make the history look sealed.
  await complete(op('9'),'test-exhaust',completeResult);
  await complete(op('1'),'test-retry',legacyResult);
  assert.equal(recoveryInvalidationState({projectCapability,sessionId,
    sliceId:'SLICE-001'}).historyComplete,false);
  assert.equal(recoveryGenerationFloor({projectCapability,sessionId}).floor,2);
  assert.equal(recoveryGenerationFloor({projectCapability,sessionId})
    .historyComplete,false);
});

test('recovery history rejects a later lower generation across retry kinds',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),
    'dw-functional-generation-rollback-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'.git'));fs.mkdirSync(path.join(root,'.claude'));
  const sessionId='s-aaaaaaaa';
  const result=(generation)=>({status:'completed',failedSlices:['SLICE-001'],
    invalidated_slices:['SLICE-001'],recovery_generation:generation,
    invalidated_functional_receipts:[]});
  const projectCapability=platform.issueProjectStateCapability(root,root,
    {role:'project-root'});
  const complete=(operationId,kind,value)=>journal.beginOperation({projectCapability,
    sessionId,kind,operationId,preconditions:{}}).then((operation)=>
    journal.completeOperation(operation,value));
  await complete(op('9'),'test-retry',result(2));
  await complete(op('1'),'test-exhaust',result(1));
  assert.throws(()=>recoveryInvalidationState({projectCapability,sessionId,
    sliceId:'SLICE-001'}),/functional-recovery-history/);
  assert.throws(()=>recoveryGenerationFloor({projectCapability,sessionId}),
    /functional-recovery-history/);
});
