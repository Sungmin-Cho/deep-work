'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {buildFunctionalSliceReceiptV2,validateFunctionalSliceReceiptV2,
  validateRefactorEvidenceV1,semanticDigest,
  buildFunctionalReceiptTargetLocks,reconstructInvalidatedFunctionalReceipt,
  validateFunctionalCompletionLedger}=require('./functional-receipt-runtime.js');

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
    sliceId:'SLICE-001',
    plan:{plan_authority_sha256:original.plan_authority_sha256},
    verificationPlanSha256:original.verification_plan_sha256});
  assert.deepEqual(reconstructed,original);
  assert.throws(()=>reconstructInvalidatedFunctionalReceipt({
    legacy:{...invalidated,receipt_sha256:'0'.repeat(64)},
    sliceId:'SLICE-001',plan:{plan_authority_sha256:original.plan_authority_sha256},
    verificationPlanSha256:original.verification_plan_sha256}),
  /functional-recovery-receipt/);
  assert.throws(()=>reconstructInvalidatedFunctionalReceipt({
    legacy:{...invalidated,schema_version:'1.0'},
    sliceId:'SLICE-001',plan:{plan_authority_sha256:original.plan_authority_sha256},
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
