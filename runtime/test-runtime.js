'use strict';

const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {atomicWriteFile,issueProjectStateCapability}=require('./platform.js');
const {updateFrontmatterText}=require('./frontmatter.js');
const transaction=require('./transaction-runtime.js');
const functionalReceipt=require('./functional-receipt-runtime.js');
const {beginOperation,recordOperationStage,completeOperation,resumeOperation,canonicalJson,sha256}=require('./operation-journal.js');

function fail(code,message){const error=new Error(`[${code}] ${message||code}`);error.code=code;throw error;}
function clone(value){return structuredClone(value);}
function validateGateResults(gateResults,{verificationPlan,evidencePackage,evidenceSummary,compatibilityMode,
  receiptInvalidations=[],artifactRoot}={}){if(!gateResults||gateResults.complete!==true||!Array.isArray(gateResults.failedSlices)||
  gateResults.failedSlices.length||Buffer.byteLength(canonicalJson(gateResults))>1_048_576)fail('gate-results','complete passing gate results required');
  if(verificationPlan){const policy=require('./verification-policy-runtime.js');if(!policy.validateVerificationPlan(verificationPlan).pass)
      fail('gate-results-verification-plan');const evidence=require('./evidence-runtime.js');
    if(compatibilityMode!==verificationPlan.compatibility_mode||!evidencePackage||
        !evidence.validateEvidencePackage(evidencePackage,verificationPlan,{artifactRoot}).pass||!evidenceSummary?.complete||
        evidenceSummary.complete!==evidence.evaluateEvidenceCompleteness(evidencePackage,verificationPlan,{artifactRoot}).complete)
      fail('gate-results-evidence');
    if(gateResults.verification_plan_sha256!==verificationPlan.plan_sha256)
      fail('gate-results-identity');if(gateResults.package_sha256!==evidencePackage.package_sha256)
      fail('gate-results-identity');const required=policy.requiredGateIds(verificationPlan,{at:'test'}),rows=gateResults.gates||[];
    if(rows.length!==required.length||new Set(rows.map((row)=>row.id)).size!==rows.length)fail('gate-results-required');
    for(const id of required){const row=rows.find((item)=>item.id===id);if(!row||row.status!=='pass')fail('gate-results-required',id);
      const gate=verificationPlan.gates.find((item)=>item.id===id);if(gate.evidence_required&&
        (!Array.isArray(row.evidence_ids)||!row.evidence_ids.length||row.evidence_ids.some((evidenceId)=>
          !(evidencePackage.records||[]).some((record)=>record.evidence_id===evidenceId&&record.gate_id===id&&record.status==='pass'))))
        fail('gate-results-evidence',id);}
    if(evidence.invalidatedReceiptEvidenceIds(evidencePackage,verificationPlan,receiptInvalidations).length)
      fail('gate-results-invalidated-receipt');
  }else if(compatibilityMode&&compatibilityMode!=='legacy-no-spec')fail('gate-results-verification-plan');
  return clone(gateResults);}

function pureRecordTestPass({state,gateResults,verificationPlan,evidencePackage,evidenceSummary,compatibilityMode,
  receiptInvalidations,artifactRoot,at}){validateGateResults(gateResults,{verificationPlan,evidencePackage,evidenceSummary,compatibilityMode,
    receiptInvalidations,artifactRoot});if(state.current_phase!=='test')fail('test-phase');
  if(!Number.isFinite(Date.parse(at)))fail('test-time');return {...clone(state),test_passed:true,test_completed_at:at,
    gate_results_sha256:sha256(canonicalJson(gateResults))};}
function recordTestPass({state,stateCapability,gateResults,verificationPlan,evidencePackage,evidenceSummary,
  compatibilityMode,receiptInvalidations,artifactRoot,governedAdmission,
  governedProjectionSha256,governedRequired=false,at,seam}={}){if(!stateCapability)return pureRecordTestPass({state,gateResults,
    verificationPlan,evidencePackage,evidenceSummary,compatibilityMode,receiptInvalidations,artifactRoot,at});
  require('./slice-runtime.js').assertNoPendingScopedWrite(stateCapability);
  if(governedRequired&&
      (governedAdmission?.enforcement_point!=='test'||governedAdmission.allowed!==true||
        !Array.isArray(governedAdmission.blocking_codes)||
        governedAdmission.blocking_codes.length!==0||
        !/^[0-9a-f]{64}$/.test(governedProjectionSha256||'')))
    fail('test-governed-admission');
  validateGateResults(gateResults,{verificationPlan,evidencePackage,evidenceSummary,compatibilityMode,receiptInvalidations,artifactRoot});
  return transaction.journaledStateMutation({stateCapability,kind:'test-pass',
    preconditions:{at,gateResultsSha256:sha256(canonicalJson(gateResults)),
      verificationPlanSha256:verificationPlan?.plan_sha256||null,packageSha256:evidencePackage?.package_sha256||null,
      compatibilityMode:compatibilityMode||null,
      governedProjectionSha256:governedProjectionSha256||null,
      governedRequired:Boolean(governedRequired),
      governedAdmissionSha256:governedAdmission?
        sha256(canonicalJson(governedAdmission)):null,
      receiptInvalidationsSha256:sha256(canonicalJson(receiptInvalidations||[]))},seam,
    reducer:(fields)=>{if(verificationPlan){let review;try{review=JSON.parse(fields.review_execution_json||'{}');}catch{fail('gate-results-state');}
        if(fields.verification_plan_sha256!==verificationPlan.plan_sha256||review.evidence?.package_sha256!==evidencePackage?.package_sha256||
          canonicalJson(JSON.parse(fields.receipt_invalidations_json||'[]'))!==canonicalJson(receiptInvalidations||[]))fail('gate-results-state');}
      const next=pureRecordTestPass({state:fields,gateResults,verificationPlan,evidencePackage,evidenceSummary,
        compatibilityMode,receiptInvalidations,artifactRoot,at});return {test_passed:next.test_passed,
      test_completed_at:next.test_completed_at,gate_results_sha256:next.gate_results_sha256};}});}

function failureTransition({state,plan,receipts,failedSlices,exhausted}){
  if(!Array.isArray(failedSlices)||!failedSlices.length||new Set(failedSlices).size!==failedSlices.length||
      failedSlices.some((id)=>!/^SLICE-\d{3}$/.test(id)))fail('failed-slices');
  if(state.current_phase!=='test')fail('test-phase');const max=state.max_test_retries??3;
  const retryCount=state.test_retry_count??0;
  if(!Number.isSafeInteger(retryCount)||retryCount<0||
      !Number.isSafeInteger(max)||max<0)fail('test-retry-count');
  if(exhausted?(retryCount<max):(retryCount>=max))fail('test-retry-boundary');
  const currentGeneration=state.receipt_recovery_generation===undefined?
    retryCount:state.receipt_recovery_generation;
  if(!Number.isSafeInteger(currentGeneration)||currentGeneration<0)
    fail('receipt-recovery-generation');
  const slices=plan?.slices||[],failedIds=new Set(failedSlices);
  if(failedSlices.some((id)=>!slices.some((slice)=>slice?.id===id)))
    fail('failed-slice-plan');
  const invalidatedIds=new Set(failedSlices);
  if(slices.some((slice)=>failedIds.has(slice.id)&&slice.slice_kind==='functional'))
    for(const slice of slices)
      if(slice.slice_kind==='release-verification')invalidatedIds.add(slice.id);
  const ids=[...invalidatedIds].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const nextGeneration=Math.max(currentGeneration,retryCount)+1;
  const nextState={...clone(state),current_phase:'implement',implement_completed_at:null,
    receipt_recovery_generation:nextGeneration,test_passed:false};
  if(!exhausted)nextState.test_retry_count=retryCount+1;
  const functionalFailedIds=slices.filter((slice)=>
    failedIds.has(slice.id)&&slice.slice_kind==='functional').map((slice)=>slice.id);
  const releaseInvalidated=slices.some((slice)=>
    invalidatedIds.has(slice.id)&&slice.slice_kind==='release-verification');
  if(functionalFailedIds.length){
    let bindings=functionalReceipt.parseFunctionalReceiptBindings(
      state.functional_receipt_bindings_json);
    for(const id of functionalFailedIds)
      bindings=functionalReceipt.invalidateFunctionalReceiptBinding(
        bindings,id,nextGeneration);
    nextState.functional_receipt_bindings_json=
      functionalReceipt.serializeFunctionalReceiptBindings(bindings);
    nextState.functional_receipt_sha256=null;
    nextState.functional_completion_operation_id=null;
  }
  if(releaseInvalidated){
    nextState.release_verification_receipt_sha256=null;
    nextState.release_verification_operation_id=null;
  }
  const nextPlan=clone(plan);const nextReceipts=clone(receipts);
  for(const slice of nextPlan.slices||[])if(invalidatedIds.has(slice.id))slice.checked=false;
  for(const id of ids){
    const slice=nextPlan.slices.find((row)=>row.id===id);
    if(!nextReceipts[id]){
      if(failedIds.has(id)||slice?.checked===true)fail('failed-slice-receipt');
      continue;
    }
    nextReceipts[id].status='invalidated';
  }
  return {state:nextState,plan:nextPlan,receipts:nextReceipts,
    failedSlices:[...failedIds].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))),
    invalidatedSlices:ids};
}

function failureStatePatch(state){
  const patch={current_phase:'implement',implement_completed_at:null,
    receipt_recovery_generation:state.receipt_recovery_generation,
    test_passed:false};
  for(const key of ['test_retry_count','functional_receipt_bindings_json',
    'functional_receipt_sha256','functional_completion_operation_id',
    'release_verification_receipt_sha256',
    'release_verification_operation_id'])
    if(Object.hasOwn(state,key))patch[key]=state[key];
  return patch;
}

function receiptCapability(directory,id){return transaction.issueSessionFileCapability({sessionCapability:directory.sessionCapability,
  candidate:path.join(directory.path,`${id}.json`),allowedBasenames:[`${id}.json`],
  allowMissingLeaf:true,role:'slice-receipt'});}
async function journaledFailure({stateCapability,planCapability,plan,receiptsDirCapability,failedSlices,at,exhausted,seam}){
  require('./slice-runtime.js').assertNoPendingScopedWrite(stateCapability);
  if(!Number.isFinite(Date.parse(at)))fail('test-time');if(!Array.isArray(failedSlices)||!failedSlices.length||
      new Set(failedSlices).size!==failedSlices.length||failedSlices.some((id)=>!/^SLICE-\d{3}$/.test(id)))fail('failed-slices');
  const failedIds=[...failedSlices].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const planSlices=plan?.slices||[],functionalFailure=planSlices.some((slice)=>
    failedIds.includes(slice.id)&&slice.slice_kind==='functional');
  const ids=[...new Set([...failedIds,...(functionalFailure?planSlices.filter((slice)=>
    slice.slice_kind==='release-verification').map((slice)=>slice.id):[])])].sort((a,b)=>
    Buffer.compare(Buffer.from(a),Buffer.from(b)));const sessionId=
    transaction.sessionIdFromState(stateCapability);const projectCapability=transaction.projectCapabilityFor(stateCapability);const root=
    stateCapability.projectRoot;const operationLock=issueProjectStateCapability(root,path.join(root,'.claude',
      `deep-work.${sessionId}.rank-operation.lock`),{allowMissingLeaf:true,role:'lock'});const journalLock=issueProjectStateCapability(root,
      path.join(root,'.claude',`deep-work.${sessionId}.rank-journal.lock`),{allowMissingLeaf:true,role:'lock'});const receiptCaps=
    Object.fromEntries(ids.map((id)=>[id,receiptCapability(receiptsDirCapability,id)]));const targetPaths=[planCapability.path,
      ...Object.values(receiptCaps).map((cap)=>cap.path)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const targets=targetPaths.map((target)=>({rank:transaction.RANKS.target,capability:issueProjectStateCapability(root,
    path.join(root,'.claude',`deep-work.target.${crypto.createHash('sha256').update(path.relative(root,target)).digest('hex')}.lock`),
    {allowMissingLeaf:true,role:'lock'})})).sort((a,b)=>Buffer.compare(Buffer.from(a.capability.path),Buffer.from(b.capability.path)));
  const kind=exhausted?'test-exhaust':'test-retry';return transaction.withRankedLocks([
    {rank:transaction.RANKS.session,capability:operationLock},{rank:transaction.RANKS.journal,capability:journalLock},
    {rank:transaction.RANKS.state,capability:transaction.stateLock(stateCapability)},...targets],async()=>{
    const preconditions={at,failedSlices:failedIds,exhausted:Boolean(exhausted)};const operation=await beginOperation({projectCapability,
      sessionId,kind,preconditions});let pending=await resumeOperation({projectCapability,operationId:operation.operationId,sessionId,kind});
    const stateText=fs.readFileSync(stateCapability.path,'utf8');const planBytes=transaction.readSessionFile(planCapability);const receiptBytes=
      Object.fromEntries(ids.map((id)=>[id,fs.existsSync(receiptCaps[id].path)?transaction.readSessionFile(receiptCaps[id]):null]));let prepared=pending.stages?.find(
      (row)=>row.stage==='stores-prepared')?.details?.owned;if(!prepared){const currentState=transaction.readState(stateCapability);let currentPlan;
      try{currentPlan=JSON.parse(planBytes);}catch{fail('test-plan-json');}if(plan&&canonicalJson(plan)!==canonicalJson(currentPlan))fail('test-plan-changed');
      const currentReceipts={};for(const id of ids)if(receiptBytes[id]!==null)try{currentReceipts[id]=JSON.parse(receiptBytes[id]);}catch{fail('test-receipt-json');}
      const changed=failureTransition({state:currentState,plan:currentPlan,receipts:currentReceipts,failedSlices:failedIds,exhausted});
      const nextPlanBytes=Buffer.from(canonicalJson(changed.plan));const nextReceiptBytes=Object.fromEntries(ids
        .filter((id)=>changed.receipts[id]!==undefined)
        .map((id)=>[id,Buffer.from(canonicalJson(changed.receipts[id]))]));const statePatch=failureStatePatch(changed.state);
      const nextStateText=updateFrontmatterText(stateText,statePatch);
      if(canonicalJson(changed.invalidatedSlices)!==canonicalJson(ids))fail('test-store-identity');
      prepared={statePath:stateCapability.path,stateBeforeSha256:sha256(stateText),stateAfterSha256:sha256(nextStateText),
        stateAfterFieldsSha256:sha256(canonicalJson(parseState(nextStateText))),planPath:planCapability.path,
        planBeforeSha256:sha256(planBytes),planAfterSha256:sha256(nextPlanBytes),receiptRows:ids.map((id)=>({id,path:receiptCaps[id].path,
          beforeSha256:receiptBytes[id]===null?null:sha256(receiptBytes[id]),
          afterSha256:nextReceiptBytes[id]===undefined?null:sha256(nextReceiptBytes[id])})),
        nextTestRetryCount:changed.state.test_retry_count??null,
        nextReceiptRecoveryGeneration:changed.state.receipt_recovery_generation,
        statePatch};
      await recordOperationStage(operation,'stores-prepared',{owned:prepared});}
    if(prepared.statePath!==stateCapability.path||prepared.planPath!==planCapability.path||canonicalJson(prepared.receiptRows.map(
        (row)=>({id:row.id,path:row.path})))!==canonicalJson(ids.map((id)=>({id,path:receiptCaps[id].path}))))fail('test-store-identity');
    const classify=(digest,before,after)=>before===null&&after===null?
      (digest===null?'absent':fail('test-store-diverged')):
      digest===before?'before':digest===after?'after':fail('test-store-diverged');const planState=
      classify(sha256(planBytes),prepared.planBeforeSha256,prepared.planAfterSha256);const receiptStates=Object.fromEntries(ids.map((id)=>{const row=
      prepared.receiptRows.find((item)=>item.id===id);return[id,classify(receiptBytes[id]===null?null:sha256(receiptBytes[id]),row.beforeSha256,row.afterSha256)];}));
    const stateStore=classify(sha256(stateText),prepared.stateBeforeSha256,prepared.stateAfterSha256);if(planState==='before'){
      let current;try{current=JSON.parse(planBytes);}catch{fail('test-plan-json');}for(const slice of current.slices||[])if(ids.includes(slice.id))
        slice.checked=false;const next=Buffer.from(canonicalJson(current));if(sha256(next)!==prepared.planAfterSha256)fail('test-plan-replay');
      seam?.('before-plan-write',{operationId:operation.operationId});transaction.atomicWriteSessionFile(planCapability,next);
      seam?.('after-plan-write-before-stage',{operationId:operation.operationId});}
    await recordOperationStage(operation,'plan-written',{owned:{path:planCapability.path,sha256:prepared.planAfterSha256}});
    for(const id of ids)if(receiptStates[id]==='before'){let current;try{current=JSON.parse(receiptBytes[id]);}catch{fail('test-receipt-json');}
      current.status='invalidated';const next=Buffer.from(canonicalJson(current));const row=prepared.receiptRows.find((item)=>item.id===id);
      if(sha256(next)!==row.afterSha256)fail('test-receipt-replay');transaction.atomicWriteSessionFile(receiptCaps[id],next);}
    seam?.('after-receipt-write-before-stage',{operationId:operation.operationId});await recordOperationStage(operation,'receipt-written',
      {owned:{rows:prepared.receiptRows.map((row)=>({id:row.id,path:row.path,sha256:row.afterSha256}))}});
    const finalPlan=JSON.parse(transaction.readSessionFile(planCapability));const finalReceipts={};
    for(const id of ids)if(fs.existsSync(receiptCaps[id].path))
      finalReceipts[id]=JSON.parse(transaction.readSessionFile(receiptCaps[id]));const receiptSha256=sha256(canonicalJson(finalReceipts));
    if(stateStore==='before'){const statePatch=prepared.statePatch||{current_phase:'implement',
        implement_completed_at:null,
        receipt_recovery_generation:prepared.nextReceiptRecoveryGeneration,
        ...(!exhausted?{test_retry_count:prepared.nextTestRetryCount}:{}),
        test_passed:false};const next=updateFrontmatterText(stateText,statePatch);
      if(sha256(next)!==prepared.stateAfterSha256)fail('test-state-replay');atomicWriteFile(stateCapability,next);
      seam?.('after-state-write-before-stage',{operationId:operation.operationId});}
    await recordOperationStage(operation,'state-written',{owned:{path:stateCapability.path,sha256:prepared.stateAfterSha256}});
    const finalState=transaction.readState(stateCapability);if(sha256(canonicalJson(finalState))!==prepared.stateAfterFieldsSha256)
      fail('test-state-postcondition');
    const result={status:'completed',failedSlices:failedIds,invalidatedSlices:ids,
      planSha256:prepared.planAfterSha256,receiptSha256,
      stateSha256:prepared.stateAfterFieldsSha256};const operationReceipt=await completeOperation(operation,result);return{state:finalState,
      plan:finalPlan,receipts:finalReceipts,operationId:operation.operationId,operationReceipt};
  });}
function parseState(text){return require('./frontmatter.js').parseFrontmatter(text).fields;}
function recordTestRetry(args){return args.stateCapability?journaledFailure({...args,exhausted:false}):failureTransition({...args,exhausted:false});}
function recordTestExhaustion(args){return args.stateCapability?journaledFailure({...args,exhausted:true}):failureTransition({...args,exhausted:true});}

function pureBeginMutationRound({state,round,survived}){if(state.current_phase!=='test'||![1,2,3].includes(round)||!survived||
  !Array.isArray(survived.mutants)||Buffer.byteLength(canonicalJson(survived))>1_048_576)fail('mutation-round');
  return {...clone(state),current_phase:'implement',mutation_testing:{...(state.mutation_testing||{}),active_round:round,survived:clone(survived)}};}
function beginMutationRound({state,stateCapability,round,survived,seam}={}){if(!stateCapability)return pureBeginMutationRound({state,round,survived});
  return transaction.journaledStateMutation({stateCapability,kind:'mutation-round',preconditions:{action:'begin',round,
    survivedSha256:sha256(canonicalJson(survived))},seam,reducer:(fields)=>{const next=pureBeginMutationRound({state:fields,round,survived});
      return {current_phase:next.current_phase,mutation_testing:JSON.stringify(next.mutation_testing)};}});}
function pureEndMutationRound({state,round,verification}){const mutation=typeof state.mutation_testing==='string'?JSON.parse(state.mutation_testing):state.mutation_testing;
  if(mutation?.active_round!==round||verification?.accepted!==true)fail('mutation-round');const next=clone(state);
  next.current_phase='test';next.mutation_testing={...mutation,active_round:null};return next;}
function endMutationRound({state,stateCapability,round,verification,seam}={}){if(!stateCapability)return pureEndMutationRound({state,round,verification});
  return transaction.journaledStateMutation({stateCapability,kind:'mutation-round',preconditions:{action:'end',round,
    verificationSha256:sha256(canonicalJson(verification))},seam,reducer:(fields)=>{const next=pureEndMutationRound({state:fields,round,verification});
      return {current_phase:next.current_phase,mutation_testing:JSON.stringify(next.mutation_testing)};}});}
function pureRecordMutationResult({state,result}){if(!result||!['completed','not-applicable'].includes(result.status))fail('mutation-result');
  return {...clone(state),mutation_testing:clone(result)};}
function recordMutationResult({state,stateCapability,result,seam}={}){if(!stateCapability)return pureRecordMutationResult({state,result});
  return transaction.journaledStateMutation({stateCapability,kind:'mutation-round',preconditions:{action:'record',
    resultSha256:sha256(canonicalJson(result))},seam,reducer:(fields)=>({mutation_testing:JSON.stringify(
      pureRecordMutationResult({state:fields,result}).mutation_testing)})});}

module.exports={recordTestPass,recordTestRetry,recordTestExhaustion,beginMutationRound,endMutationRound,recordMutationResult,
  failureTransition};
