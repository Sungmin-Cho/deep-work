'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {canonicalJson,sha256}=require('./operation-journal.js');

const DIGEST=/^[0-9a-f]{64}$/;
const OPERATION=/^op-[0-9a-f]{64}$/;
const SLICE=/^SLICE-\d{3}$/;
const SENSOR_KINDS=new Set(['lint','typecheck','coverage','mutation','review-check']);
const REASONS=new Set(['no-clarity-gain','no-duplication','risk-outweighs-change']);
function fail(code,message=code){const error=new Error(`[${code}] ${message}`);error.code=code;throw error;}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&
  canonicalJson(Object.keys(value).sort())===canonicalJson([...keys].sort());}
function semanticDigest(domain,value,omitted){
  const copy=structuredClone(value);if(omitted)delete copy[omitted];
  return crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from(`${domain}\0`),Buffer.from(canonicalJson(copy))])).digest('hex');
}
function validateVerificationResultRefV1(value){
  if(!exactKeys(value,['operation_id','result_path','result_sha256',
    'ledger_result_sha256'])||!OPERATION.test(value.operation_id||'')||
    typeof value.result_path!=='string'||!value.result_path||
    !DIGEST.test(value.result_sha256||'')||
    !DIGEST.test(value.ledger_result_sha256||''))
    fail('verification-result-ref');
  return structuredClone(value);
}
function validateSensorResultRefV1(value){
  if(!exactKeys(value,['kind','operation_id','result_path','result_sha256',
    'ledger_result_sha256'])||!SENSOR_KINDS.has(value.kind)||
    !OPERATION.test(value.operation_id||'')||typeof value.result_path!=='string'||
    !value.result_path||!DIGEST.test(value.result_sha256||'')||
    !DIGEST.test(value.ledger_result_sha256||''))
    fail('sensor-result-ref');
  return structuredClone(value);
}
function validateSensors(values){
  if(!Array.isArray(values))fail('sensor-result-refs');
  const rows=values.map(validateSensorResultRefV1);
  const sorted=[...rows].sort((a,b)=>Buffer.compare(
    Buffer.from(canonicalJson([a.kind,a.operation_id])),
    Buffer.from(canonicalJson([b.kind,b.operation_id]))));
  if(canonicalJson(rows)!==canonicalJson(sorted)||
      new Set(rows.map((row)=>row.kind)).size!==rows.length||
      new Set(rows.map((row)=>row.operation_id)).size!==rows.length)
    fail('sensor-result-refs');
  return rows;
}
function validateRefactorEvidenceV1(value){
  if(value?.kind==='no-refactor'){
    if(!exactKeys(value,['kind','decision_operation_id','reason_code',
      'post_decision_green','sensor_results','decision_sha256'])||
      !OPERATION.test(value.decision_operation_id||'')||
      !REASONS.has(value.reason_code)||
      !DIGEST.test(value.decision_sha256||''))
      fail('refactor-evidence');
    validateVerificationResultRefV1(value.post_decision_green);
    validateSensors(value.sensor_results);
    if(semanticDigest('refactor-evidence-v1',value,'decision_sha256')!==
        value.decision_sha256)fail('refactor-evidence-digest');
    return structuredClone(value);
  }
  if(value?.kind==='performed-refactor'){
    if(!exactKeys(value,['kind','write_operation_id','write_receipt_sha256',
      'post_refactor_green','sensor_results','evidence_sha256'])||
      !OPERATION.test(value.write_operation_id||'')||
      !DIGEST.test(value.write_receipt_sha256||'')||
      !DIGEST.test(value.evidence_sha256||''))
      fail('refactor-evidence');
    validateVerificationResultRefV1(value.post_refactor_green);
    validateSensors(value.sensor_results);
    if(semanticDigest('refactor-evidence-v1',value,'evidence_sha256')!==
        value.evidence_sha256)fail('refactor-evidence-digest');
    return structuredClone(value);
  }
  fail('refactor-evidence-kind');
}
function functionalCompletionOperationId(input){
  const preimage={session_id:input.session_id,slice_id:input.slice_id,
    plan_authority_sha256:input.plan_authority_sha256,
    verification_plan_sha256:input.verification_plan_sha256,
    red_proof_sha256:input.red_proof_sha256,
    green_verification:validateVerificationResultRefV1(input.green_verification),
    refactor_evidence:validateRefactorEvidenceV1(input.refactor_evidence)};
  if(!/^s-[0-9a-f]{8}$/.test(preimage.session_id||'')||
      !SLICE.test(preimage.slice_id||'')||
      !DIGEST.test(preimage.plan_authority_sha256||'')||
      !DIGEST.test(preimage.verification_plan_sha256||'')||
      !DIGEST.test(preimage.red_proof_sha256||''))
    fail('functional-completion-preimage');
  return`op-${sha256(canonicalJson(preimage))}`;
}
function buildFunctionalSliceReceiptV2(input){
  const completionOperationId=functionalCompletionOperationId(input);
  const value={schema_version:2,slice_id:input.slice_id,slice_kind:'functional',
    plan_authority_sha256:input.plan_authority_sha256,
    verification_plan_sha256:input.verification_plan_sha256,
    red_proof_ref:input.red_proof_ref,red_proof_sha256:input.red_proof_sha256,
    red_proof_operation_id:input.red_proof_operation_id,
    green_verification:validateVerificationResultRefV1(input.green_verification),
    refactor_evidence:validateRefactorEvidenceV1(input.refactor_evidence),
    completion_operation_id:completionOperationId,receipt_sha256:null};
  value.receipt_sha256=sha256(canonicalJson(Object.fromEntries(Object.entries(value)
    .filter(([key])=>key!=='receipt_sha256'))));
  return validateFunctionalSliceReceiptV2(value);
}
function validateFunctionalSliceReceiptV2(value){
  const keys=['schema_version','slice_id','slice_kind','plan_authority_sha256',
    'verification_plan_sha256','red_proof_ref','red_proof_sha256',
    'red_proof_operation_id','green_verification','refactor_evidence',
    'completion_operation_id','receipt_sha256'];
  if(!exactKeys(value,keys)||value.schema_version!==2||
      !SLICE.test(value.slice_id||'')||value.slice_kind!=='functional'||
      !DIGEST.test(value.plan_authority_sha256||'')||
      !DIGEST.test(value.verification_plan_sha256||'')||
      typeof value.red_proof_ref!=='string'||!value.red_proof_ref||
      !DIGEST.test(value.red_proof_sha256||'')||
      !OPERATION.test(value.red_proof_operation_id||'')||
      !OPERATION.test(value.completion_operation_id||'')||
      !DIGEST.test(value.receipt_sha256||''))
    fail('functional-receipt');
  validateVerificationResultRefV1(value.green_verification);
  validateRefactorEvidenceV1(value.refactor_evidence);
  const sid=value.red_proof_ref.match(/^\.deep-work\/(s-[0-9a-f]{8})\/red-proofs\/[0-9a-f]{64}\.json$/)?.[1];
  if(!sid||value.completion_operation_id!==functionalCompletionOperationId({
    session_id:sid,...value})||
      value.receipt_sha256!==sha256(canonicalJson(Object.fromEntries(
        Object.entries(value).filter(([key])=>key!=='receipt_sha256')))))
    fail('functional-receipt-digest');
  return structuredClone(value);
}
async function authenticateVerificationResultRefV1({stateCapability,planCapability,
  plan,sliceId,ref,expectedWriteClass}={}){
  const checked=validateVerificationResultRefV1(ref);
  const sid=require('./transaction-runtime.js').sessionIdFromState(stateCapability);
  const expectedPath=`.claude/deep-work.${sid}.verification.${checked.operation_id}.json`;
  if(checked.result_path!==expectedPath)fail('verification-result-ref-path');
  const authenticated=await require('./verification-v2-runtime.js')
    .authenticateVerificationV2({stateCapability,planCapability,plan,sliceId,
      operationId:checked.operation_id,resultSha256:checked.result_sha256,
      expectedOutcome:'must-pass'});
  const receipt=authenticated.verificationReceipt;
  if(receipt.resultSha256!==checked.ledger_result_sha256||
      authenticated.verification.disposition!=='accepted'||
      authenticated.verification.classification.observed_class!=='unexpected-pass'||
      authenticated.verification.scope_disposition!=='clean'||
      expectedWriteClass&&authenticated.write.writeClass!==expectedWriteClass)
    fail('verification-result-ref-authority');
  return{...authenticated,ref:checked};
}
async function authenticateSensorResultRefV1({stateCapability,plan,sliceId,ref,
  afterWriteOperationId}={}){
  const checked=validateSensorResultRefV1(ref);
  const transaction=require('./transaction-runtime.js');
  const sid=transaction.sessionIdFromState(stateCapability);
  const expectedPath=`.claude/deep-work.${sid}.sensor.${checked.operation_id}.json`;
  if(checked.result_path!==expectedPath)fail('sensor-result-ref-path');
  const absolute=path.join(stateCapability.projectRoot,...checked.result_path.split('/'));
  let bytes,result;try{bytes=fs.readFileSync(absolute);result=JSON.parse(bytes);}
  catch{fail('sensor-result-ref-result');}
  if(!bytes.equals(Buffer.from(canonicalJson(result)))||
      sha256(canonicalJson(result))!==checked.result_sha256||
      result.kind!==checked.kind||result.status!=='pass'||result.sliceId!==sliceId||
      result.afterWriteOperationId!==afterWriteOperationId||
      result.planAuthoritySha256!==plan.plan_authority_sha256)
    fail('sensor-result-ref-result');
  const receipt=await require('./operation-journal.js').resumeOperation({
    projectCapability:transaction.projectCapabilityFor(stateCapability),
    operationId:checked.operation_id,sessionId:sid,kind:'sensor-run'});
  if(receipt.stage!=='completed-ledger'||
      receipt.resultSha256!==checked.ledger_result_sha256||
      receipt.result?.status!=='completed'||receipt.result.resultPath!==absolute||
      receipt.result.resultSha256!==checked.result_sha256||
      receipt.result.kind!==checked.kind||receipt.result.sensorStatus!=='pass'||
      receipt.result.sliceId!==sliceId||
      receipt.result.planAuthoritySha256!==plan.plan_authority_sha256||
      receipt.result.afterWriteOperationId!==afterWriteOperationId)
    fail('sensor-result-ref-ledger');
  return{result,receipt,ref:checked};
}
function readCanonical(file,code,max=16*1024*1024,allowNoLf=false){
  let stat,bytes,value;try{stat=fs.lstatSync(file);bytes=fs.readFileSync(file);
    value=JSON.parse(bytes);}catch{fail(code);}
  const canonical=Buffer.from(canonicalJson(value));
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max||
      !bytes.equals(canonical)&&
        !(allowNoLf&&bytes.equals(Buffer.from(canonical.toString('utf8')
          .replace(/\n$/,'')))))
    fail(code);
  return{value,bytes};
}
function validateFunctionalCompletionLedger(completed,{sessionId,sliceId,
  receiptRelative,receipt,code='functional-recovery-parent'}={}){
  const result=completed?.result;
  if(completed?.stage!=='completed-ledger'||!exactKeys(result,
      ['session_id','slice_id','receipt_path','receipt_sha256',
        'post_state_sha256'])||result.session_id!==sessionId||
      result.slice_id!==sliceId||result.receipt_path!==receiptRelative||
      result.receipt_sha256!==receipt.receipt_sha256||
      !DIGEST.test(result.post_state_sha256||'')||
      completed.resultSha256!==sha256(canonicalJson(result)))
    fail(code);
  return result;
}
function reconstructInvalidatedFunctionalReceipt({legacy,sessionId,sliceId,
  plan,verificationPlanSha256}={}){
  if(!legacy||legacy.schema_version!==2||legacy.status!=='invalidated'||
      !/^s-[0-9a-f]{8}$/.test(sessionId||'')||
      legacy.slice_id!==sliceId||legacy.slice_kind!=='functional'||
      legacy.plan_authority_sha256!==plan.plan_authority_sha256||
      legacy.verification_plan_sha256!==verificationPlanSha256||
      legacy.red_proof_ref!==`.deep-work/${sessionId}/red-proofs/${
        legacy.red_proof_sha256}.json`)
    fail('functional-recovery-receipt');
  let receipt;try{const candidate=structuredClone(legacy);delete candidate.status;
    receipt=validateFunctionalSliceReceiptV2(candidate);}catch{fail('functional-recovery-receipt');}
  if(legacy.completion_operation_id!==receipt.completion_operation_id||
      legacy.receipt_sha256!==receipt.receipt_sha256)
    fail('functional-recovery-receipt');
  return receipt;
}
function assertFunctionalRecoveryState({target,fields}={}){
  if(target?.checked!==false||fields?.active_slice!==target?.id||
      fields?.tdd_state!=='SENSOR_CLEAN')
    fail('functional-recovery-plan-not-reset');
  return true;
}
async function authenticateRedProof({stateCapability,plan,sliceId,fields}){
  const transaction=require('./transaction-runtime.js');
  const root=stateCapability.projectRoot,sid=transaction.sessionIdFromState(stateCapability);
  const expected=`.deep-work/${sid}/red-proofs/${fields.red_proof_sha256}.json`;
  if(fields.red_proof_ref!==expected)fail('functional-red-proof');
  const proof=readCanonical(path.join(root,...expected.split('/')),
    'functional-red-proof',16*1024*1024,true).value;
  const project=transaction.projectCapabilityFor(stateCapability);
  if(proof.transition_kind==='bootstrap-adoption'){
    const bootstrap=require('./bootstrap-runtime.js');
    const control=path.join(root,'.deep-work',sid,'bootstrap');
    const readJson=(name,code)=>{
      let value;try{value=JSON.parse(fs.readFileSync(path.join(control,name),'utf8'));}
      catch{fail(code);}
      return value;
    };
    const authorization=bootstrap.validateBootstrapAuthorization(
      readJson('authorization.json','functional-bootstrap-authorization'));
    const receipt=readJson('bootstrap-receipt.json',
      'functional-bootstrap-receipt');
    const marker=readJson('marker.json','functional-bootstrap-marker');
    const completion=await require('./operation-journal.js').resumeOperation({
      projectCapability:project,operationId:receipt.completion_operation_id,
      sessionId:sid,kind:'bootstrap-finalize'});
    bootstrap.validateBootstrapCompletionAuthority({
      receipt,marker,operationReceipt:completion});
    const bridgeReceipt=await require('./operation-journal.js').resumeOperation({
      projectCapability:project,operationId:proof.bootstrap_bridge_operation_id,
      sessionId:sid,kind:'bootstrap-first-red'});
    const adoptionReceipt=await require('./operation-journal.js').resumeOperation({
      projectCapability:project,operationId:proof.transition_operation_id,
      sessionId:sid,kind:'bootstrap-red-adoption'});
    const proofReceipt=await require('./operation-journal.js').resumeOperation({
      projectCapability:project,operationId:proof.proof_operation_id,
      sessionId:sid,kind:'red-proof-publication'});
    const target=plan.slices?.find((row)=>row.id===sliceId);
    require('./slice-runtime.js').assertBootstrapProductionAdmission({
      sliceId,verificationSpecSha256:target?.verification_spec_sha256,
      planAuthoritySha256:plan.plan_authority_sha256,
      specSha256:plan.contract_binding.spec_contract.spec_sha256,
      specApprovedHash:plan.contract_binding.spec_contract.spec_approved_hash,
      verificationPlanSha256:fields.verification_plan_sha256,
      authorization:{first_red_slice_id:authorization.witness.first_red_slice_id,
        first_red_verification_spec_sha256:
          authorization.witness.first_red_verification_spec_sha256,
        bootstrap_receipt_sha256:receipt.receipt_sha256},
      marker,state:fields,proof,bridgeReceipt,adoptionReceipt,proofReceipt});
    return{proof,verificationReceipt:bridgeReceipt,
      transitionReceipt:adoptionReceipt,proofReceipt,bootstrap:true};
  }
  if(proof.transition_kind!=='ordinary')fail('functional-red-proof');
  const verificationReceipt=await require('./operation-journal.js').resumeOperation({
    projectCapability:project,operationId:proof.verification_operation_id,
    sessionId:sid,kind:'verification-run-v2'});
  const transitionReceipt=await require('./operation-journal.js').resumeOperation({
    projectCapability:project,operationId:proof.transition_operation_id,
    sessionId:sid,kind:'red-transition'});
  const proofReceipt=await require('./operation-journal.js').resumeOperation({
    projectCapability:project,operationId:proof.proof_operation_id,
    sessionId:sid,kind:'red-proof-publication'});
  require('./slice-runtime.js').assertProductionRedProofAdmission({sessionId:sid,
    sliceId,planAuthoritySha256:plan.plan_authority_sha256,
    specSha256:plan.contract_binding.spec_contract.spec_sha256,
    specApprovedHash:plan.contract_binding.spec_contract.spec_approved_hash,
    verificationPlanSha256:fields.verification_plan_sha256,state:fields,proof,
    verificationReceipt,transitionReceipt,proofReceipt});
  return{proof,verificationReceipt,transitionReceipt,proofReceipt};
}
function buildFunctionalReceiptTargetLocks({root,targets,rank,
  issueCapability}={}){
  if(typeof root!=='string'||!root||!Array.isArray(targets)||!targets.length||
      targets.some((target)=>typeof target!=='string'||!target)||
      !Number.isInteger(rank)||typeof issueCapability!=='function')
    fail('functional-completion-locks');
  const requests=targets.map((target)=>({rank,
    capability:issueCapability(root,path.join(root,'.claude',
      `deep-work.target.${sha256(path.relative(root,target))}.lock`),
    {allowMissingLeaf:true,role:'lock'})}));
  if(requests.some((request)=>typeof request.capability?.path!=='string'||
      !request.capability.path))fail('functional-completion-locks');
  return requests.sort((a,b)=>Buffer.compare(Buffer.from(a.capability.path),
    Buffer.from(b.capability.path)));
}
async function publishFunctionalSliceReceiptV2({stateCapability,planCapability,plan,
  sliceId,greenVerification,refactorEvidence,seam,_locksHeld=false}={}){
  const platform=require('./platform.js');
  const transaction=require('./transaction-runtime.js');
  const frontmatter=require('./frontmatter.js');
  const journal=require('./operation-journal.js');
  const planRuntime=require('./plan-runtime.js');
  const root=stateCapability?.projectRoot;
  if(!root||!SLICE.test(sliceId||''))fail('functional-completion-input');
  const sid=transaction.sessionIdFromState(stateCapability);
  if(!_locksHeld){
    const workFields=transaction.readState(stateCapability);
    if(typeof workFields.work_dir!=='string')fail('functional-completion-state');
    const receiptPath=path.join(root,...workFields.work_dir.split('/'),'receipts',
      `${sliceId}.json`);
    const targets=buildFunctionalReceiptTargetLocks({root,targets:
      [planCapability.path,receiptPath],rank:transaction.RANKS.target,
      issueCapability:platform.issueProjectStateCapability});
    return transaction.withRankedLocks([{rank:transaction.RANKS.session,
      capability:platform.issueProjectStateCapability(root,path.join(root,'.claude',
        `deep-work.${sid}.rank-operation.lock`),{allowMissingLeaf:true,role:'lock'})},
    {rank:transaction.RANKS.journal,capability:platform.issueProjectStateCapability(
      root,path.join(root,'.claude',`deep-work.${sid}.rank-journal.lock`),
      {allowMissingLeaf:true,role:'lock'})},{rank:transaction.RANKS.state,
      capability:transaction.stateLock(stateCapability)},...targets],
    ()=>publishFunctionalSliceReceiptV2({stateCapability,planCapability,plan,sliceId,
      greenVerification,refactorEvidence,seam,_locksHeld:true}));
  }
  require('./slice-runtime.js').assertNoPendingScopedWrite(stateCapability);
  transaction.revalidateSessionFile(planCapability);
  let current;try{current=JSON.parse(transaction.readSessionFile(planCapability));}
  catch{fail('functional-completion-plan');}
  if(canonicalJson(current)!==canonicalJson(plan)||
      current.contract_binding?.mode!=='strict-spec')
    fail('functional-completion-plan');
  const authority=planRuntime.compileImmutablePlanAuthorityV2(current);
  if(authority.plan_authority_sha256!==current.plan_authority_sha256)
    fail('functional-completion-plan');
  const target=current.slices?.find((row)=>row.id===sliceId);
  if(!target||target.slice_kind!=='functional')fail('functional-completion-slice');
  const stateText=fs.readFileSync(stateCapability.path,'utf8');
  const fields=frontmatter.parseFrontmatter(stateText).fields;
  if(fields.current_phase!=='implement'||
      !(fields.active_slice===sliceId||target.checked&&fields.active_slice===null)||
      !DIGEST.test(fields.verification_plan_sha256||''))
    fail('functional-completion-state');
  const red=await authenticateRedProof({stateCapability,plan:current,
    sliceId,fields});
  const green=await authenticateVerificationResultRefV1({stateCapability,
    planCapability,plan:current,sliceId,ref:greenVerification,
    expectedWriteClass:'production'});
  const refactor=validateRefactorEvidenceV1(refactorEvidence);
  let post,afterWriteOperationId;
  if(refactor.kind==='performed-refactor'){
    post=await authenticateVerificationResultRefV1({stateCapability,
      planCapability,plan:current,sliceId,ref:refactor.post_refactor_green,
      expectedWriteClass:'refactor'});
    if(post.write.operationId!==refactor.write_operation_id||
        post.write.receiptSha256!==refactor.write_receipt_sha256)
      fail('functional-refactor-write');
    afterWriteOperationId=refactor.write_operation_id;
  }else{
    const decision=await require('./refactor-decision-runtime.js')
      .authenticateNoRefactorDecision({stateCapability,plan:current,sliceId,
        greenVerification:green.ref,reasonCode:refactor.reason_code,
        operationId:refactor.decision_operation_id});
    post=await authenticateVerificationResultRefV1({stateCapability,
      planCapability,plan:current,sliceId,ref:refactor.post_decision_green,
      expectedWriteClass:'no-refactor-decision'});
    if(post.write.operationId!==decision.operationId)
      fail('functional-no-refactor-decision');
    afterWriteOperationId=decision.operationId;
  }
  for(const sensor of refactor.sensor_results)
    await authenticateSensorResultRefV1({stateCapability,plan:current,sliceId,
      ref:sensor,afterWriteOperationId});
  if(!target.checked&&fields.tdd_state!=='SENSOR_CLEAN')
    fail('functional-completion-state');
  const receipt=buildFunctionalSliceReceiptV2({session_id:sid,slice_id:sliceId,
    plan_authority_sha256:current.plan_authority_sha256,
    verification_plan_sha256:fields.verification_plan_sha256,
    red_proof_ref:fields.red_proof_ref,red_proof_sha256:red.proof.proof_sha256,
    red_proof_operation_id:red.proof.proof_operation_id,
    green_verification:green.ref,refactor_evidence:refactor});
  const operationId=receipt.completion_operation_id;
  const project=transaction.projectCapabilityFor(stateCapability);
  const completed=await journal.resumeOperation({projectCapability:project,
    operationId,sessionId:sid,kind:'functional-slice-complete-v2'})
    .catch((error)=>{if(error.code==='operation-not-found')return null;throw error;});
  const receiptRelative=`.deep-work/${sid}/receipts/${sliceId}.json`;
  const receiptPath=path.join(root,...receiptRelative.split('/'));
  if(completed?.stage==='completed-ledger'){
    const storedRaw=readCanonical(receiptPath,
      'functional-receipt-adoption').value;
    if(storedRaw.status==='invalidated')
      fail('functional-recovery-fresh-evidence');
    const stored=validateFunctionalSliceReceiptV2(storedRaw);
    if(canonicalJson(stored)!==canonicalJson(receipt))
      fail('functional-completion-ledger');
    const result=validateFunctionalCompletionLedger(completed,{sessionId:sid,
      sliceId,receiptRelative,receipt,code:'functional-completion-ledger'});
    return{...result,operation_id:operationId,operation_receipt:completed,
      adopted:true};
  }
  const preconditions={session_id:sid,slice_id:sliceId,
    plan_authority_sha256:current.plan_authority_sha256,
    verification_plan_sha256:fields.verification_plan_sha256,
    red_proof_sha256:red.proof.proof_sha256,
    green_verification:green.ref,refactor_evidence:refactor};
  const operation=await journal.beginOperation({projectCapability:project,
    sessionId:sid,kind:'functional-slice-complete-v2',operationId,slice:sliceId,
    preconditions});
  await journal.recordOperationStage(operation,'evidence-authenticated',{owned:{
    redProofSha256:red.proof.proof_sha256,
    greenResultSha256:green.ref.result_sha256,
    refactorEvidenceSha256:refactor.kind==='performed-refactor'?
      refactor.evidence_sha256:refactor.decision_sha256}});
  const workDir=path.join(root,...fields.work_dir.split('/'));
  const sessionCapability=platform.issueProjectStateCapability(root,workDir,{
    role:'session-work-dir',sessionStateCapability:stateCapability});
  const receiptBytes=Buffer.from(canonicalJson(receipt));
  fs.mkdirSync(path.dirname(receiptPath),{recursive:true});
  if(fs.existsSync(receiptPath)){
    const existing=readCanonical(receiptPath,'functional-receipt-adoption');
    if(!existing.bytes.equals(receiptBytes)){
      if(existing.value.status!=='invalidated')fail('functional-receipt-adoption');
      assertFunctionalRecoveryState({target,fields});
      let invalidated;
      try{invalidated=reconstructInvalidatedFunctionalReceipt({legacy:existing.value,
        sessionId:sid,sliceId,plan:current,
        verificationPlanSha256:fields.verification_plan_sha256});}
      catch{fail('functional-receipt-adoption');}
      if(invalidated.receipt_sha256===receipt.receipt_sha256||
          invalidated.completion_operation_id===receipt.completion_operation_id)
        fail('functional-recovery-fresh-evidence');
      const capability=transaction.issueSessionFileCapability({
        sessionCapability,candidate:receiptPath,allowedBasenames:[`${sliceId}.json`],
        role:'functional-slice-receipt'});
      seam?.('before-receipt-write',{operationId,receiptPath});
      transaction.atomicWriteSessionFile(capability,receiptBytes);
      seam?.('after-receipt-write-before-stage',{operationId,receiptPath});
    }
  }else{
    const capability=transaction.issueSessionFileCapability({
      sessionCapability,candidate:receiptPath,allowedBasenames:[`${sliceId}.json`],
      allowMissingLeaf:true,role:'functional-slice-receipt'});
    seam?.('before-receipt-write',{operationId,receiptPath});
    transaction.atomicWriteSessionFile(capability,receiptBytes);
    seam?.('after-receipt-write-before-stage',{operationId,receiptPath});
  }
  await journal.recordOperationStage(operation,'receipt-published',{owned:{
    receiptPath:receiptRelative,receiptSha256:receipt.receipt_sha256}});
  const nextPlan=structuredClone(current);
  nextPlan.slices.find((row)=>row.id===sliceId).checked=true;
  const planBytes=Buffer.from(canonicalJson(nextPlan));
  if(!transaction.readSessionFile(planCapability).equals(planBytes)){
    seam?.('before-plan-write',{operationId});
    transaction.atomicWriteSessionFile(planCapability,planBytes);
    seam?.('after-plan-write-before-state',{operationId});
  }
  const currentState=fs.readFileSync(stateCapability.path,'utf8');
  const currentFields=frontmatter.parseFrontmatter(currentState).fields;
  const implementSlices=nextPlan.slices.filter((row)=>
    row.slice_kind!=='release-verification');
  const afterState=frontmatter.updateFrontmatterText(currentState,{
    active_slice:null,tdd_state:'PENDING',accepted_write_operation_id:null,
    accepted_write_receipt_sha256:null,accepted_write_class:null,
    functional_receipt_sha256:receipt.receipt_sha256,
    functional_completion_operation_id:operationId,
    implement_completed_at:implementSlices.length>0&&
      implementSlices.every((row)=>row.checked===true)?
      currentFields.implement_completed_at||new Date().toISOString():undefined});
  if(afterState!==currentState){
    seam?.('before-state-write',{operationId});
    platform.atomicWriteFile(stateCapability,afterState);
    seam?.('after-state-write-before-stage',{operationId});
  }
  await journal.recordOperationStage(operation,'progress-committed',{owned:{
    planSha256:sha256(planBytes),
    postStateSha256:sha256(Buffer.from(afterState))}});
  const result={session_id:sid,slice_id:sliceId,receipt_path:receiptRelative,
    receipt_sha256:receipt.receipt_sha256,
    post_state_sha256:sha256(Buffer.from(afterState))};
  const operationReceipt=await journal.completeOperation(operation,result);
  return{...result,operation_id:operationId,operation_receipt:operationReceipt,
    adopted:false};
}

module.exports={validateVerificationResultRefV1,validateSensorResultRefV1,
  validateRefactorEvidenceV1,functionalCompletionOperationId,
  buildFunctionalSliceReceiptV2,validateFunctionalSliceReceiptV2,
  validateFunctionalCompletionLedger,
  reconstructInvalidatedFunctionalReceipt,
  assertFunctionalRecoveryState,
  authenticateVerificationResultRefV1,authenticateSensorResultRefV1,
  authenticateRedProof,buildFunctionalReceiptTargetLocks,
  publishFunctionalSliceReceiptV2,semanticDigest};
