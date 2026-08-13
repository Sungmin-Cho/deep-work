'use strict';

const crypto = require('node:crypto');
const fs=require('node:fs');const path=require('node:path');
const {canonicalJson,sha256,beginOperation,recordOperationStage,completeOperation,resumeOperation}=require('./operation-journal.js');
const {journaledStateMutation,readBoundedJson}=require('./transaction-runtime.js');
const {mutateState}=require('./slice-runtime.js');
const platform=require('./platform.js');const {updateFrontmatterText}=require('./frontmatter.js');

const PHASE_GRAPH = Object.freeze({brainstorm:['research'],research:['spec'],
  spec:['plan'],plan:['implement'],implement:['test']});
const TDD_GRAPH = Object.freeze({
  PENDING:['RED_VERIFIED','SPIKE'], RED_VERIFIED:['GREEN'], GREEN:['SENSOR_RUN'],
  SENSOR_RUN:['SENSOR_FIX','SENSOR_CLEAN'], SENSOR_FIX:['SENSOR_RUN','SENSOR_CLEAN'],
  SENSOR_CLEAN:['REFACTOR_PENDING'], REFACTOR_PENDING:['GREEN'], SPIKE:['PENDING'],
});

function fail(code,message) { const error=new Error(`[${code}] ${message||code}`);error.code=code;throw error; }
function clone(value){return structuredClone(value);}
function parseJson(value,code){if(value&&typeof value==='object')return clone(value);try{return JSON.parse(value||'{}');}
  catch{fail(code);}}

async function authenticateSensorEvidence({stateCapability,planCapability,plan,sliceId,
  sensorOperationIds,sensorResultsSha256,afterWriteOperationId,requirePass}={}){
  if(!Array.isArray(sensorOperationIds)||!sensorOperationIds.length||
      sensorOperationIds.some((id)=>!/^op-[0-9a-f]{32,64}$/.test(id))||
      new Set(sensorOperationIds).size!==sensorOperationIds.length||
      canonicalJson(sensorOperationIds)!==canonicalJson([...sensorOperationIds].sort((a,b)=>
        Buffer.compare(Buffer.from(a),Buffer.from(b))))||!/^[0-9a-f]{64}$/.test(sensorResultsSha256||'')||
      !/^op-[0-9a-f]{32,64}$/.test(afterWriteOperationId||''))fail('fresh-sensor-required');
  const transaction=require('./transaction-runtime.js');const sessionId=transaction.sessionIdFromState(stateCapability);
  const state=transaction.readState(stateCapability);const lockedPlan=JSON.parse(transaction.readSessionFile(planCapability));
  if(canonicalJson(lockedPlan)!==canonicalJson(plan))fail('sensor-plan-changed');
  const planSha256=sha256(canonicalJson(lockedPlan));const cycle=parseJson(state.refactor_cycle,'sensor-refactor-cycle');
  if(state.current_phase!=='implement'||state.active_slice!==sliceId||cycle.sliceId!==sliceId||
      cycle.planSha256!==planSha256||cycle.writeOperationId!==afterWriteOperationId||
      cycle.writeReceiptSha256!==state.accepted_write_receipt_sha256)fail('sensor-refactor-cycle');
  const project=transaction.projectCapabilityFor(stateCapability);const rows=[];const kinds=new Set();
  for(const operationId of sensorOperationIds){const resultPath=path.join(project.path,'.claude',
      `deep-work.${sessionId}.sensor.${operationId}.json`);let result;
    try{result=JSON.parse(fs.readFileSync(resultPath,'utf8'));}catch{fail('sensor-result');}
    const resultSha256=sha256(canonicalJson(result));const receipt=await resumeOperation({projectCapability:project,
      operationId,sessionId,kind:'sensor-run'});
    if(receipt.stage!=='completed-ledger'||receipt.result?.status!=='completed'||
        receipt.result.resultPath!==resultPath||receipt.result.resultSha256!==resultSha256||
        result.sessionId!==sessionId||result.planSha256!==planSha256||result.sliceId!==sliceId||
        result.afterWriteOperationId!==afterWriteOperationId||receipt.result.planSha256!==planSha256||
        receipt.result.sliceId!==sliceId||receipt.result.afterWriteOperationId!==afterWriteOperationId||
        kinds.has(result.kind))fail('sensor-result-authority');
    kinds.add(result.kind);rows.push({operationId,resultSha256,kind:result.kind,status:result.status});}
  const aggregate=require('./sensor-runtime.js').aggregateSensorResults(rows);
  if(aggregate!==sensorResultsSha256)fail('sensor-aggregate-mismatch');
  const required=['lint','review-check','typecheck'];
  if(requirePass&&(required.some((kind)=>!kinds.has(kind))||rows.some((row)=>row.status!=='pass')))fail('sensor-result-incomplete');
  if(!requirePass&&rows.every((row)=>row.status==='pass'))fail('sensor-fix-without-failure');
  return {sessionId,state,planSha256,cycle,rows,aggregate};
}

function beginPhase({state,stateCapability,phase,at,seam}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,kind:'phase-checkpoint',
    preconditions:{action:'begin',phase,at},seam,reducer:(fields)=>beginPhase({state:fields,phase,at})});
  if (!Object.hasOwn(PHASE_GRAPH,phase) && phase !== 'test') fail('phase-name');
  const next=clone(state); next[`${phase}_started_at`]=at; return next;
}

function completePhase({state,stateCapability,phase,result={},at,seam}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,kind:'phase-checkpoint',
    preconditions:{action:'complete',phase,at,resultSha256:crypto.createHash('sha256').update(canonicalJson(result)).digest('hex')},
    seam,reducer:(fields)=>completePhase({state:fields,phase,result,at})});
  if (!['brainstorm','research','spec','plan','implement'].includes(phase)) fail('phase-complete');
  const next=clone(state); next[`${phase}_completed_at`]=at; next.phase_review={...(next.phase_review||{}),
    [phase]:clone(result)}; return next;
}

function approvePhase({state,stateCapability,phase,artifactSha256,planProjectionSha256=null,
    sourcePlanSha256=null,verificationCompilerInput=null,verificationPlan=null,planSpecGateResult=null,
    approvalOperationId,at,seam}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,kind:'phase-approval',
    preconditions:{phase,artifactSha256,planProjectionSha256,sourcePlanSha256,at,
      verificationCompilerInputSha256:verificationCompilerInput?sha256(canonicalJson(verificationCompilerInput)):null},seam,
    reducer:(fields,context)=>{const next=approvePhase({state:fields,phase,artifactSha256,
      planProjectionSha256,sourcePlanSha256,verificationCompilerInput,verificationPlan,
      planSpecGateResult,approvalOperationId:context.operationId,at}),key=`${phase}_approved`;
      return{...next,[key]:canonicalJson(next[key])};}});
  if (!['research','plan'].includes(phase) || !/^[0-9a-f]{64}$/.test(artifactSha256||'')) fail('phase-approval');
  if(phase==='plan'&&(!/^[0-9a-f]{64}$/.test(planProjectionSha256||'')||
      !/^[0-9a-f]{64}$/.test(sourcePlanSha256||'')))fail('plan-projection-required');
  const next=clone(state);next[`${phase}_approved`]={artifact_sha256:artifactSha256,at,
    ...(phase==='plan'?{replan_epoch:state.active_replan_epoch_id||null,
      approval_operation_id:approvalOperationId||null}:{})};
  if(phase==='plan'){next.plan_projection_sha256=planProjectionSha256;next.plan_source_sha256=sourcePlanSha256;
    if(verificationPlanRequired(state)||verificationCompilerInput?.planProjection?.contract_binding?.mode==='strict-spec'){
      const policy=require('./verification-policy-runtime.js');
      if(!verificationCompilerInput)fail('verification-plan-compiler-input');const compiled=policy.compileVerificationPlan(
        verificationCompilerInput);const valid=policy.validateVerificationPlan(compiled);
      if(verificationPlan&&canonicalJson(verificationPlan)!==canonicalJson(compiled))fail('verification-plan-byte-mismatch');
      const risk=compiled.risk_class;const executionRequirement=planSpecGateResult?.requirement_coverage?.execution?.ratio;
      const executionFailure=planSpecGateResult?.failure_matrix_coverage?.execution?.ratio;
      if(!valid.pass||compiled.spec_approved_hash!==state.spec_approved_hash||
          compiled.plan_projection_sha256!==planProjectionSha256||compiled.source_plan_sha256!==sourcePlanSha256||
          compiled.risk_profile_sha256!==(state.risk_profile_sha256||verificationCompilerInput.riskProfileSha256)||
          !planSpecGateResult?.pass||planSpecGateResult.spec_id!==compiled.spec_id||
          planSpecGateResult.spec_sha256!==compiled.spec_sha256||
          planSpecGateResult.spec_approved_hash!==compiled.spec_approved_hash||
          planSpecGateResult.risk_profile_sha256!==compiled.risk_profile_sha256||executionRequirement!==1||
          (['high','critical'].includes(risk)&&executionFailure!==1))
        fail('verification-plan-required');
      next.verification_plan_json=canonicalJson(compiled);next.verification_plan_sha256=compiled.plan_sha256;
      next.plan_spec_gate_result_json=canonicalJson(planSpecGateResult);}}
  return next;
}

function enterSpecSubphase({state,stateCapability,at,seam}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,kind:'phase-checkpoint',
    preconditions:{action:'spec-enter',at},seam,reducer:(fields)=>enterSpecSubphase({state:fields,at})});
  if(state?.current_phase!=='research')fail('spec-subphase-phase');
  const next=clone(state);next.current_phase='spec';next.subphase=null;
  next.spec_started_at=at||new Date().toISOString();next.spec_policy_required=true;
  next.spec_completed_at=null;next.spec_approved_hash=null;next.spec_contract_json=null;next.spec_gate_result_json=null;
  return next;
}

function approveSpecSubphase({state,stateCapability,specApprovedHash,specContract,specGateResult,
  specReviewRefSha256,approvalOperationId,at,seam}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,kind:'phase-approval',
    preconditions:{phase:'spec',specApprovedHash,
      specContractSha256:specContract&&require('./contract-runtime.js').specContractDigest(specContract),at},seam,
    reducer:(fields,context)=>approveSpecSubphase({state:fields,specApprovedHash,specContract,
      specGateResult,specReviewRefSha256,approvalOperationId:context.operationId,at})});
  const canonical=state?.current_phase==='spec'&&state.subphase==null;
  const legacy=state?.current_phase==='research'&&state.subphase==='spec';
  if((!canonical&&!legacy)||!/^[0-9a-f]{64}$/.test(specApprovedHash||''))
    fail('spec-approval');
  const contractRuntime=require('./contract-runtime.js');const result=contractRuntime.validateSpecContract(specContract,
    {riskClass:specContract?.risk_class});const specSha256=contractRuntime.specContractDigest(specContract);
  if(!result.pass||!specGateResult||specGateResult.pass!==true||specGateResult.spec_sha256!==specSha256||
      specGateResult.spec_id!==specContract.spec_id||specGateResult.risk_class!==specContract.risk_class||
      specGateResult.requirement_coverage?.contract?.ratio!==1||
      (['high','critical'].includes(specContract.risk_class)&&specGateResult.failure_matrix_coverage?.contract?.ratio!==1))
    fail('spec-gate-failed');
  const next=clone(state);next.spec_policy_required=['medium','high','critical'].includes(specContract.risk_class);
  next.spec_completed_at=at;next.spec_approved_hash=specApprovedHash;
  next.spec_contract_json=canonicalJson(specContract);next.spec_gate_result_json=canonicalJson(specGateResult);
  const epoch=state.active_replan_epoch_id||null;
  if(epoch&&!/^[0-9a-f]{64}$/.test(specReviewRefSha256||''))
    fail('spec-review-ref-required');
  if(approvalOperationId!==undefined)
    next.spec_approval_operation_id=approvalOperationId;
  if(epoch){
    const approval={schema_version:1,session_id:state.session_id,
      spec_sha256:specSha256,spec_approved_hash:specApprovedHash,
      risk_profile_sha256:state.risk_profile_sha256,replan_epoch:epoch,
      spec_review_ref_sha256:specReviewRefSha256,
      approval_operation_id:approvalOperationId,approval_sha256:null};
    approval.approval_sha256=sha256(canonicalJson(Object.fromEntries(
      Object.entries(approval).filter(([key])=>key!=='approval_sha256'))));
    next.spec_approval_json=canonicalJson(approval);
  }
  return next;
}

function specPolicyRequired(state){
  if(state.spec_policy_required===true)return true;
  let profile={};try{profile=parseJson(state.risk_profile_json||'{}','risk-profile-state');}catch{return true;}
  const risk=profile.risk_class||profile.class;
  return ['medium','high','critical'].includes(risk);
}

function verificationPlanRequired(state){
  if(specPolicyRequired(state))return true;const match=String(state?.created_by_version||'').match(/^(\d+)\.(\d+)\./);
  return Boolean(match&&(Number(match[1])>6||(Number(match[1])===6&&Number(match[2])>=13)));
}

function requireFreshSpec(state){
  if(!specPolicyRequired(state))return;
  const inSpec=state.current_phase==='spec'||
    (state.current_phase==='research'&&state.subphase==='spec');
  if(!inSpec||!/^[0-9a-f]{64}$/.test(state.spec_approved_hash||'')||
      !state.spec_contract_json||!state.spec_gate_result_json)fail('spec-approval-required');
  if(!/^[0-9a-f]{64}$/.test(state.spec_current_sha256||'')||state.spec_current_sha256!==state.spec_approved_hash)
    fail('spec-approval-stale');
  const contract=parseJson(state.spec_contract_json,'spec-contract-state');
  const gate=parseJson(state.spec_gate_result_json,'spec-gate-state');
  const runtime=require('./contract-runtime.js');const validation=runtime.validateSpecContract(contract,{riskClass:contract.risk_class});
  if(!validation.pass||gate.pass!==true||gate.spec_sha256!==runtime.specContractDigest(contract))fail('spec-gate-failed');
}

function advancePhase({state,stateCapability,from,to,at,seam,specCurrentSha256}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,kind:'phase-checkpoint',
    preconditions:{action:'advance',from,to,at,specCurrentSha256},seam,
    reducer:(fields)=>advancePhase({state:{...fields,...(specCurrentSha256?{spec_current_sha256:specCurrentSha256}:{})},from,to,at})});
  const legacySpecTransition=from==='research'&&to==='plan'&&state.subphase==='spec';
  if (state.current_phase !== from ||
      (!(PHASE_GRAPH[from]||[]).includes(to)&&!legacySpecTransition))
    fail('phase-transition');
  if((from==='spec'&&to==='plan')||legacySpecTransition)requireFreshSpec(state);
  if(from==='plan'&&to==='implement'&&verificationPlanRequired(state)){
    const planGate=parseJson(state.plan_spec_gate_result_json||'{}','plan-spec-gate-state');
    if(planGate.pass!==true)fail('plan-spec-gate-required');
    const verificationPlan=parseJson(state.verification_plan_json||'{}','verification-plan-state');
    if(!require('./verification-policy-runtime.js').validateVerificationPlan(verificationPlan).pass||
        verificationPlan.plan_sha256!==state.verification_plan_sha256||verificationPlan.spec_approved_hash!==state.spec_approved_hash||
        verificationPlan.plan_projection_sha256!==state.plan_projection_sha256||
        verificationPlan.source_plan_sha256!==state.plan_source_sha256||
        verificationPlan.risk_profile_sha256!==(state.risk_profile_sha256||verificationPlan.risk_profile_sha256))
      fail('verification-plan-required');
  }
  const next=clone(state);delete next.spec_current_sha256;next.current_phase=to;
  if(to==='plan')next.subphase=null;
  next[`${to}_started_at`]=at||new Date().toISOString(); return next;
}

function rerunPhase({state,stateCapability,phase,affectedSlices=[],seam}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,kind:'phase-rerun',
    preconditions:{phase,affectedSlices},seam,reducer:(fields)=>rerunPhase({state:fields,phase})});
  if (!['brainstorm','research','spec','plan','implement','test'].includes(phase)) fail('phase-rerun');
  const next=clone(state);
  delete next[`${phase}_completed_at`]; delete next[`${phase}_approved`];
  if (phase==='test') {
    const functionalReceipt=require('./functional-receipt-runtime.js');
    next.receipt_recovery_generation=
      functionalReceipt.recoveryGenerationFromFields(state);
    next.test_passed=false;next.test_retry_count=0;
  }
  return next;
}

function invalidateForReplan({state,stateCapability,reason,fromRisk,toRisk,affectedSliceIds=[],
  riskProfileSha256,at,seam,operationId}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,kind:'phase-checkpoint',operationId,
    preconditions:{action:'invalidate-for-replan',reason,fromRisk,toRisk,affectedSliceIds,riskProfileSha256,at},seam,
    reducer:(fields)=>invalidateForReplan({state:fields,reason,fromRisk,toRisk,affectedSliceIds,riskProfileSha256,at})});
  const risks=['low','medium','high','critical'];const reasons=new Set(['risk-class-increase','scope-expansion',
    'public-contract','invariant','failure-state','external-side-effect','unplanned-mock','repeated-root-cause',
    'persistent-state-transition','spike-promotion']);
  if(!state||!reasons.has(reason)||risks.indexOf(toRisk)<=risks.indexOf(fromRisk)||
      !/^[0-9a-f]{64}$/.test(riskProfileSha256||'')||!Array.isArray(affectedSliceIds)||
      affectedSliceIds.some((id)=>!/^SLICE-\d{3}$/.test(id))||new Set(affectedSliceIds).size!==affectedSliceIds.length)
    fail('replan-invalidation-input');
  const sliceIds=[...affectedSliceIds].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  const receipts=parseJson(state.slice_receipts_json||'{}','slice-receipts-state');
  const priorInvalidations=parseJson(state.receipt_invalidations_json||'[]','receipt-invalidations-state');
  if(!Array.isArray(priorInvalidations))fail('receipt-invalidations-state');
  const additions=sliceIds.map((sliceId)=>{const row=receipts[sliceId]||{};return{slice_id:sliceId,
    receipt_sha256:row.receipt_sha256||null,prior_plan_sha256:row.plan_sha256||state.plan_projection_sha256||null,
    prior_risk_profile_sha256:row.risk_profile_sha256||state.risk_profile_sha256||null,
    invalidated_by_risk_profile_sha256:riskProfileSha256,reason,at};});
  const next=clone(state);next.current_phase='spec';next.subphase=null;next.replan_required=true;
  next.replan_reason=reason;next.risk_profile_sha256=riskProfileSha256;
  next.risk_transition_json=canonicalJson({from:fromRisk,to:toRisk,reason,at});
  next.receipt_invalidations_json=canonicalJson([...priorInvalidations,...additions]);
  for(const key of ['plan_approved','plan_projection_sha256','plan_source_sha256','plan_spec_gate_result_json',
    'verification_plan_json','verification_plan_sha256','evidence_summary_json','evidence_summary_sha256'])next[key]=null;
  next.verification_consumptions_json='{}';next.test_passed=false;
  next.spec_completed_at=null;next.spec_approved_hash=null;next.spec_contract_json=null;next.spec_gate_result_json=null;
  return next;
}

async function transitionSliceTdd({state,stateCapability,sliceId,to,verificationResult,verificationSha256,
  verificationOperationId,sensorOperationIds,sensorResultsSha256,afterWriteOperationId,
  planCapability,plan,seam,_verificationEvidence,_sensorEvidence,_transitionOperationId}={}) {
  if(stateCapability)return journaledStateMutation({stateCapability,
    kind:to==='SENSOR_CLEAN'?'sensor-cycle-accept':'phase-checkpoint',slice:sliceId,
    preconditions:{to,verificationSha256,verificationOperationId,sensorOperationIds,
      sensorResultsSha256,afterWriteOperationId},seam,
    reducer:async(fields,context)=>{const consumed=parseJson(fields.verification_consumptions_json||'{}',
        'verification-consumption-state')[verificationOperationId];
      const verificationAdoption=consumed&&consumed.transitionOperationId===context.operationId&&
        consumed.sliceId===sliceId&&consumed.to===to&&consumed.resultSha256===verificationSha256&&fields.tdd_state===to;
      const sensorAdoption=fields.sensor_cycle_operation_id===context.operationId&&fields.tdd_state===to&&
        fields.sensor_results_sha256===sensorResultsSha256;
      let verificationEvidence=null;let sensorEvidence=null;
      if(['RED_VERIFIED','GREEN'].includes(to)&&!verificationAdoption){
        if(verificationResult?.schema_version===2){
          const authority=await require('./verification-v2-runtime.js')
            .authenticateVerificationV2({stateCapability,planCapability,plan,sliceId,
              operationId:verificationOperationId,resultSha256:verificationSha256,
              expectedOutcome:to==='GREEN'?'must-pass':'must-fail'});
          if(canonicalJson(authority.verification)!==canonicalJson(verificationResult))
            fail('verification-result-digest');
          verificationEvidence={state:fields,resultSha256:verificationSha256,
            operationId:verificationOperationId,
            expectedOutcome:to==='GREEN'?'must-pass':'must-fail',
            result:{spec_sha256:authority.verification.spec_sha256,
              plan_sha256:authority.verification.plan_authority_sha256,
              contract_trace:null},v2:true};
        }else verificationEvidence=await require('./verification-runtime.js')
          .authenticateVerificationResult({stateCapability,planCapability,plan,sliceId,
            operationId:verificationOperationId,resultSha256:verificationSha256,
            claimedResult:verificationResult});
      }
      if(['SENSOR_FIX','SENSOR_CLEAN'].includes(to)&&sensorOperationIds&&!sensorAdoption) sensorEvidence=await authenticateSensorEvidence({
        stateCapability,planCapability,plan,sliceId,sensorOperationIds,sensorResultsSha256,afterWriteOperationId,
        requirePass:to==='SENSOR_CLEAN'});
      return transitionSliceTdd({state:fields,sliceId,to,verificationResult,verificationSha256,
        verificationOperationId,sensorOperationIds,sensorResultsSha256,afterWriteOperationId,
        _verificationEvidence:verificationEvidence,_sensorEvidence:sensorEvidence,
        _transitionOperationId:context.operationId});}});
  const from=state.tdd_state;
  if(sliceId&&state.active_slice!==sliceId)fail('tdd-slice');
  const consumptions=parseJson(state.verification_consumptions_json||'{}','verification-consumption-state');
  if(verificationOperationId&&consumptions[verificationOperationId]){
    const prior=consumptions[verificationOperationId];
    if(prior.transitionOperationId===_transitionOperationId&&prior.sliceId===sliceId&&prior.to===to&&
        prior.resultSha256===verificationSha256&&state.tdd_state===to)return {};
    fail('verification-result-replay');
  }
  if(sensorOperationIds&&state.sensor_cycle_operation_id===_transitionOperationId&&state.tdd_state===to&&
      state.sensor_results_sha256===sensorResultsSha256)return {};
  if (!(TDD_GRAPH[from]||[]).includes(to)) fail('tdd-transition',`${from} -> ${to}`);
  if (['RED_VERIFIED','GREEN'].includes(to)) {
    if (!verificationResult || !/^[0-9a-f]{64}$/.test(verificationSha256||'') ||
        !/^op-[0-9a-f]{32,64}$/.test(verificationOperationId||'')) fail('verification-required');
    if(stateCapability===undefined&&!_verificationEvidence)fail('verification-required');
    if(_verificationEvidence&&(_verificationEvidence.state.tdd_state!==from||
        _verificationEvidence.resultSha256!==verificationSha256||
        _verificationEvidence.operationId!==verificationOperationId||
        (to==='RED_VERIFIED')!==(_verificationEvidence.expectedOutcome==='must-fail')))fail('verification-evidence-stale');
    if(_verificationEvidence&&to==='GREEN'&&from==='RED_VERIFIED'&&
        !_verificationEvidence.v2){
      const prior=Object.values(consumptions).find((row)=>row.sliceId===sliceId&&row.to==='RED_VERIFIED');
      if(!prior||prior.specSha256!==_verificationEvidence.result.spec_sha256||
          canonicalJson(prior.contractTrace)!==canonicalJson(_verificationEvidence.result.contract_trace))
        fail('verification-trace-pair');
    }
    if(_verificationEvidence?.v2&&to==='GREEN'&&from==='RED_VERIFIED'&&
        state.red_proof_state!=='complete')fail('verification-trace-pair');
  } else if (verificationResult || verificationSha256 || verificationOperationId) fail('verification-extra');
  if (to==='SENSOR_CLEAN' && from==='SENSOR_RUN' && state.fresh_sensor_required) {
    if (!Array.isArray(sensorOperationIds)||!sensorOperationIds.length||
        new Set(sensorOperationIds).size!==sensorOperationIds.length||
        !/^[0-9a-f]{64}$/.test(sensorResultsSha256||'')||!afterWriteOperationId||!_sensorEvidence)
      fail('fresh-sensor-required');
  }
  if(to==='SENSOR_FIX'&&state.fresh_sensor_required&&!_sensorEvidence)fail('fresh-sensor-required');
  const patch={tdd_state:to};
  if(_verificationEvidence){consumptions[verificationOperationId]={transitionOperationId:_transitionOperationId,
      sliceId,to,resultSha256:verificationSha256,specSha256:_verificationEvidence.result.spec_sha256,
      planSha256:_verificationEvidence.result.plan_sha256,contractTrace:_verificationEvidence.result.contract_trace};
    patch.verification_consumptions_json=canonicalJson(consumptions);
    patch.verification_operation_id=verificationOperationId;patch.verification_result_sha256=verificationSha256;
    if(from!=='REFACTOR_PENDING'){
      patch.accepted_write_operation_id=null;patch.accepted_write_receipt_sha256=null;patch.accepted_write_class=null;}
    if(to==='GREEN'&&from==='REFACTOR_PENDING'){
      patch.fresh_sensor_required=true;const cycle=parseJson(state.refactor_cycle,'refactor-cycle');
      cycle.verificationOperationId=verificationOperationId;cycle.verificationResultSha256=verificationSha256;
      patch.refactor_cycle=JSON.stringify(cycle);}}
  if (to==='GREEN'&&from==='REFACTOR_PENDING') patch.fresh_sensor_required=true;
  if (to==='SENSOR_CLEAN') {patch.fresh_sensor_required=false;if(_sensorEvidence){
      const cycle=parseJson(state.refactor_cycle,'refactor-cycle');cycle.sensorCycleOperationId=_transitionOperationId;
      patch.refactor_cycle=JSON.stringify(cycle);patch.sensor_cycle_operation_id=_transitionOperationId;
      patch.sensor_results_sha256=sensorResultsSha256;patch.accepted_write_operation_id=null;
      patch.accepted_write_receipt_sha256=null;patch.accepted_write_class=null;}}
  return patch;
}

function setTddOverride({state,stateCapability,sliceId,reason}={}) {
  if(stateCapability)return mutateState(stateCapability,(fields)=>{const next=setTddOverride({state:fields,sliceId,reason});
    return {tdd_override:next.tdd_override,tdd_override_reason_sha256:next.tdd_override_reason_sha256};});
  if(!/^SLICE-\d{3}$/.test(sliceId||'')||typeof reason!=='string'||!reason.trim())fail('tdd-override');
  return {...clone(state),tdd_override:sliceId,tdd_override_reason_sha256:
    crypto.createHash('sha256').update(reason).digest('hex')};
}

function clearTddOverride({stateCapability,state,sliceId}={}){
  const reduce=(fields)=>{if(fields.tdd_override&&fields.tdd_override!==sliceId)fail('tdd-override');
    return {...clone(fields),tdd_override:null,tdd_override_reason_sha256:null};};
  if(stateCapability)return mutateState(stateCapability,(fields)=>({tdd_override:reduce(fields).tdd_override,
    tdd_override_reason_sha256:null}));return reduce(state);
}

function enterDebug({stateCapability,sliceId}={}){if(!/^SLICE-\d{3}$/.test(sliceId||''))fail('debug-slice');
  return mutateState(stateCapability,(fields)=>{if(fields.current_phase!=='implement')fail('debug-phase');
    return {debug_active:true,debug_slice:sliceId};});}
function exitDebug({stateCapability,verification}={}){if(verification?.accepted!==true)fail('debug-verification');
  return mutateState(stateCapability,(fields)=>{if(!fields.debug_active)fail('debug-state');
    return {debug_active:false,debug_slice:null};});}
async function completeDebug({stateCapability,receiptsDirCapability,sliceId,noteFile,verification,seam,_locksHeld=false}={}){
  if(!/^SLICE-\d{3}$/.test(sliceId||''))fail('debug-slice');let noteStat;try{noteStat=fs.lstatSync(noteFile);}catch{fail('debug-note');}
  if(!noteStat.isFile()||noteStat.isSymbolicLink()||noteStat.size>1_048_576)fail('debug-note');const noteBytes=fs.readFileSync(noteFile);
  if(!noteBytes.toString('utf8').trim()||!noteBytes.equals(Buffer.from(noteBytes.toString('utf8'))))fail('debug-note');
  if(verification?.accepted!==true)fail('debug-verification');const transaction=require('./transaction-runtime.js');const sessionId=
    transaction.sessionIdFromState(stateCapability),root=stateCapability.projectRoot,receiptPath=path.join(receiptsDirCapability?.path||'',
      `${sliceId}.json`);if(!_locksHeld){if(!receiptsDirCapability||receiptsDirCapability.kind!=='receipts-directory'||
        receiptsDirCapability.sessionCapability?.projectRoot!==root)fail('debug-receipts');const targets=['debug-log',receiptPath].map((value)=>
        platform.issueProjectStateCapability(root,path.join(root,'.claude',`deep-work.target.${sha256(value)}.lock`),
          {allowMissingLeaf:true,role:'lock'})).sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
    return transaction.withRankedLocks([{rank:transaction.RANKS.session,capability:platform.issueProjectStateCapability(root,
      path.join(root,'.claude',`deep-work.${sessionId}.rank-operation.lock`),{allowMissingLeaf:true,role:'lock'})},
      {rank:transaction.RANKS.journal,capability:platform.issueProjectStateCapability(root,path.join(root,'.claude',
        `deep-work.${sessionId}.rank-journal.lock`),{allowMissingLeaf:true,role:'lock'})},{rank:transaction.RANKS.state,
        capability:transaction.stateLock(stateCapability)},...targets.map((capability)=>({rank:transaction.RANKS.target,capability}))],
      ()=>completeDebug({stateCapability,receiptsDirCapability,sliceId,noteFile,verification,seam,_locksHeld:true}));}
  const sessionCapability=receiptsDirCapability.sessionCapability;if(sessionCapability.path!==path.dirname(receiptsDirCapability.path)||
      receiptsDirCapability.path!==path.join(sessionCapability.path,'receipts'))fail('debug-receipts');const receiptCapability=
    transaction.issueSessionFileCapability({sessionCapability,candidate:receiptPath,allowedBasenames:[`${sliceId}.json`],role:'slice-receipt'});
  const projectCapability=transaction.projectCapabilityFor(stateCapability),preconditions={sliceId,noteSha256:sha256(noteBytes),
    verificationSha256:sha256(canonicalJson(verification))};const operation=await beginOperation({projectCapability,sessionId,
      kind:'debug-complete',slice:sliceId,preconditions});let pending=await resumeOperation({projectCapability,
      operationId:operation.operationId,sessionId,kind:'debug-complete'});let prepared=pending.stages?.find((row)=>row.stage==='stores-prepared')
      ?.details?.owned;let stateText=fs.readFileSync(stateCapability.path,'utf8'),receiptBytes=transaction.readSessionFile(receiptCapability);
  if(!prepared){const fields=require('./frontmatter.js').parseFrontmatter(stateText).fields;if(!fields.debug_active||
      fields.debug_slice!==sliceId||fields.current_phase!=='implement')fail('debug-state');let receipt;try{receipt=JSON.parse(receiptBytes);}
    catch{fail('debug-receipt-json');}if(receipt.slice_id!==sliceId||!receipt.debug||typeof receipt.debug!=='object'||Array.isArray(receipt.debug))
      fail('debug-receipt');const debugDir=path.join(sessionCapability.path,'debug-log');fs.mkdirSync(debugDir,{recursive:true});const used=
      fs.readdirSync(debugDir).map((name)=>name.match(/^RC-(\d{3})\.md$/)?.[1]).filter(Boolean).map(Number);const next=(used.length?
        Math.max(...used):0)+1;if(next>999)fail('debug-note-limit');const basename=`RC-${String(next).padStart(3,'0')}.md`,relative=
      `debug-log/${basename}`;const nextReceipt=structuredClone(receipt);nextReceipt.debug={...nextReceipt.debug,root_cause_note:relative};
    const patch={debug_active:false,debug_slice:null,...(Object.hasOwn(fields,'debug_mode')?{debug_mode:false}:{})};const nextState=
      updateFrontmatterText(stateText,patch),nextReceiptBytes=Buffer.from(canonicalJson(nextReceipt));prepared={sliceId,notePath:path.join(debugDir,
        basename),noteRelative:relative,noteSha256:sha256(noteBytes),statePath:stateCapability.path,stateBeforeSha256:sha256(stateText),
        stateAfterSha256:sha256(nextState),receiptPath,receiptBeforeSha256:sha256(receiptBytes),receiptAfterSha256:sha256(nextReceiptBytes)};
    await recordOperationStage(operation,'stores-prepared',{owned:prepared});}
  if(prepared.sliceId!==sliceId||prepared.noteSha256!==sha256(noteBytes)||prepared.statePath!==stateCapability.path||
      prepared.receiptPath!==receiptPath)fail('debug-store-identity');const noteCapability=transaction.issueSessionFileCapability({sessionCapability,
    candidate:prepared.notePath,allowedBasenames:[path.basename(prepared.notePath)],allowMissingLeaf:true,role:'debug-root-cause'});
  if(fs.existsSync(noteCapability.path)){if(!transaction.readSessionFile(noteCapability).equals(noteBytes))fail('debug-note-diverged');}
  else{seam?.('before-note-write',{operationId:operation.operationId,path:noteCapability.path});transaction.atomicWriteSessionFile(noteCapability,
      noteBytes);seam?.('after-note-write-before-stage',{operationId:operation.operationId,path:noteCapability.path});}
  await recordOperationStage(operation,'note-written',{owned:{path:noteCapability.path,sha256:prepared.noteSha256}});const receiptDigest=
    sha256(receiptBytes);if(receiptDigest===prepared.receiptBeforeSha256){let receipt;try{receipt=JSON.parse(receiptBytes);}catch{fail('debug-receipt-json');}
    receipt.debug={...receipt.debug,root_cause_note:prepared.noteRelative};const next=Buffer.from(canonicalJson(receipt));
    if(sha256(next)!==prepared.receiptAfterSha256)fail('debug-receipt-replay');seam?.('before-receipt-write',{operationId:operation.operationId});
    transaction.atomicWriteSessionFile(receiptCapability,next);seam?.('after-receipt-write-before-stage',{operationId:operation.operationId});}
  else if(receiptDigest!==prepared.receiptAfterSha256)fail('debug-receipt-diverged');await recordOperationStage(operation,'receipt-written',
    {owned:{path:receiptPath,sha256:prepared.receiptAfterSha256}});const stateDigest=sha256(stateText);if(stateDigest===prepared.stateBeforeSha256){
    const fields=require('./frontmatter.js').parseFrontmatter(stateText).fields,patch={debug_active:false,debug_slice:null,
      ...(Object.hasOwn(fields,'debug_mode')?{debug_mode:false}:{})};const next=updateFrontmatterText(stateText,patch);
    if(sha256(next)!==prepared.stateAfterSha256)fail('debug-state-replay');seam?.('before-state-write',{operationId:operation.operationId});
    platform.atomicWriteFile(stateCapability,next);seam?.('after-state-write-before-stage',{operationId:operation.operationId});}
  else if(stateDigest!==prepared.stateAfterSha256)fail('debug-state-diverged');await recordOperationStage(operation,'state-written',
    {owned:{path:stateCapability.path,sha256:prepared.stateAfterSha256}});if(sha256(fs.readFileSync(stateCapability.path))!==
      prepared.stateAfterSha256||sha256(transaction.readSessionFile(receiptCapability))!==prepared.receiptAfterSha256)
    fail('debug-postcondition');const result={status:'completed',sliceId,notePath:noteCapability.path,noteSha256:prepared.noteSha256,
      receiptSha256:prepared.receiptAfterSha256,stateSha256:prepared.stateAfterSha256};const operationReceipt=await completeOperation(operation,result);
  return{...result,operationId:operation.operationId,operationReceipt};
}
async function recordPhaseReview({stateCapability,phase,structuralJsonFile,structuralMdFile,adversarialJsonFile,seam,
  _locksHeld=false}={}){if(!['brainstorm','research','plan'].includes(phase))fail('phase-review-phase');const structural=
    readBoundedJson(structuralJsonFile),adversarial=adversarialJsonFile?readBoundedJson(adversarialJsonFile):null;const markdownStat=
    fs.lstatSync(structuralMdFile);if(!markdownStat.isFile()||markdownStat.isSymbolicLink()||markdownStat.size>1_048_576)
    fail('phase-review-input');const markdownBytes=fs.readFileSync(structuralMdFile);if(!markdownBytes.toString('utf8').trim()||
      !markdownBytes.equals(Buffer.from(markdownBytes.toString('utf8')))||!structural||typeof structural!=='object'||Array.isArray(structural)||
      adversarial&&typeof adversarial!=='object')fail('phase-review-input');const transaction=require('./transaction-runtime.js'),sessionId=
    transaction.sessionIdFromState(stateCapability),root=stateCapability.projectRoot;if(!_locksHeld)return transaction.withRankedLocks([
      {rank:transaction.RANKS.session,capability:platform.issueProjectStateCapability(root,path.join(root,'.claude',
        `deep-work.${sessionId}.rank-operation.lock`),{allowMissingLeaf:true,role:'lock'})},{rank:transaction.RANKS.journal,
        capability:platform.issueProjectStateCapability(root,path.join(root,'.claude',`deep-work.${sessionId}.rank-journal.lock`),
          {allowMissingLeaf:true,role:'lock'})},{rank:transaction.RANKS.state,capability:transaction.stateLock(stateCapability)},
      {rank:transaction.RANKS.target,capability:platform.issueProjectStateCapability(root,path.join(root,'.claude',
        `deep-work.target.${sha256(`phase-review:${phase}`)}.lock`),{allowMissingLeaf:true,role:'lock'})}],()=>recordPhaseReview({
          stateCapability,phase,structuralJsonFile,structuralMdFile,adversarialJsonFile,seam,_locksHeld:true}));
  const stateText=fs.readFileSync(stateCapability.path,'utf8'),fields=require('./frontmatter.js').parseFrontmatter(stateText).fields;
  if(fields.current_phase!==phase||typeof fields.work_dir!=='string')fail('phase-review-phase');const sessionCapability=
    platform.issueProjectStateCapability(root,path.join(root,...fields.work_dir.split('/')),{role:'session-work-dir',
      sessionStateCapability:stateCapability});const structuralBytes=Buffer.from(canonicalJson(structural)),adversarialBytes=adversarial?
      Buffer.from(canonicalJson(adversarial)):null;const inputs={phase,structuralSha256:sha256(structuralBytes),markdownSha256:sha256(markdownBytes),
      adversarialSha256:adversarialBytes?sha256(adversarialBytes):null};const projectCapability=transaction.projectCapabilityFor(stateCapability);
  const operation=await beginOperation({projectCapability,sessionId,kind:'phase-review-record',preconditions:inputs});let pending=
    await resumeOperation({projectCapability,operationId:operation.operationId,sessionId,kind:'phase-review-record'});let prepared=
    pending.stages?.find((row)=>row.stage==='stores-prepared')?.details?.owned;const names={json:`${phase}-review.json`,
      markdown:`${phase}-review.md`,adversarial:'adversarial-review.json'};const capabilities={json:transaction.issueSessionFileCapability({
        sessionCapability,candidate:path.join(sessionCapability.path,names.json),allowedBasenames:[names.json],allowMissingLeaf:true,
        role:'phase-review-json'}),markdown:transaction.issueSessionFileCapability({sessionCapability,candidate:path.join(sessionCapability.path,
          names.markdown),allowedBasenames:[names.markdown],allowMissingLeaf:true,role:'phase-review-markdown'}),...(adversarialBytes?{
        adversarial:transaction.issueSessionFileCapability({sessionCapability,candidate:path.join(sessionCapability.path,names.adversarial),
          allowedBasenames:[names.adversarial],allowMissingLeaf:true,role:'phase-review-adversarial'})}:{})};
  const readMaybe=(capability)=>fs.existsSync(capability.path)?transaction.readSessionFile(capability):null;if(!prepared){let phaseReview={};
    if(typeof fields.phase_review==='string'&&fields.phase_review)try{phaseReview=JSON.parse(fields.phase_review);}catch{fail('phase-review-state');}
    else if(fields.phase_review&&typeof fields.phase_review==='object')phaseReview=structuredClone(fields.phase_review);
    if(!phaseReview||typeof phaseReview!=='object'||Array.isArray(phaseReview))fail('phase-review-state');phaseReview[phase]={
      result:structural.result||'recorded',structural_json:names.json,structural_json_sha256:inputs.structuralSha256,
      structural_markdown:names.markdown,structural_markdown_sha256:inputs.markdownSha256,
      adversarial_json:adversarialBytes?names.adversarial:null,adversarial_sha256:inputs.adversarialSha256,
      adversarial_result:adversarial?.result||null};const patch={phase_review:JSON.stringify(phaseReview),
      ...(phase==='plan'?{plan_review_retries:0}:{})};const nextState=updateFrontmatterText(stateText,patch);prepared={phase,
      statePath:stateCapability.path,stateBeforeSha256:sha256(stateText),stateAfterSha256:sha256(nextState),outputs:{json:{
        path:capabilities.json.path,beforeSha256:readMaybe(capabilities.json)?sha256(readMaybe(capabilities.json)):null,
        afterSha256:inputs.structuralSha256},markdown:{path:capabilities.markdown.path,beforeSha256:readMaybe(capabilities.markdown)?
          sha256(readMaybe(capabilities.markdown)):null,afterSha256:inputs.markdownSha256},...(adversarialBytes?{adversarial:{
        path:capabilities.adversarial.path,beforeSha256:readMaybe(capabilities.adversarial)?sha256(readMaybe(capabilities.adversarial)):null,
        afterSha256:inputs.adversarialSha256}}:{})}};await recordOperationStage(operation,'stores-prepared',{owned:prepared});}
  if(prepared.phase!==phase||prepared.statePath!==stateCapability.path)fail('phase-review-store-identity');const publish=async(key,bytes,stage,seamName)=>{
    const cap=capabilities[key],row=prepared.outputs[key],current=readMaybe(cap),digest=current?sha256(current):null;if(digest===row.afterSha256){
      if(!current.equals(bytes))fail('phase-review-output-diverged');}else if(digest===row.beforeSha256){seam?.(`before-${seamName}-write`,
        {operationId:operation.operationId,path:cap.path});transaction.atomicWriteSessionFile(cap,bytes);seam?.(
        `after-${seamName}-write-before-stage`,{operationId:operation.operationId,path:cap.path});}else fail('phase-review-output-diverged');
    await recordOperationStage(operation,stage,{owned:{path:cap.path,sha256:row.afterSha256}});};
  await publish('json',structuralBytes,'json-written','json');await publish('markdown',markdownBytes,'markdown-written','markdown');
  if(adversarialBytes)await publish('adversarial',adversarialBytes,'adversarial-written','adversarial');else await recordOperationStage(operation,
    'adversarial-written',{owned:{path:null,sha256:null}});const currentState=fs.readFileSync(stateCapability.path,'utf8'),stateDigest=
    sha256(currentState);if(stateDigest===prepared.stateBeforeSha256){let phaseReview={};const currentFields=require('./frontmatter.js')
      .parseFrontmatter(currentState).fields;if(typeof currentFields.phase_review==='string'&&currentFields.phase_review)
      try{phaseReview=JSON.parse(currentFields.phase_review);}catch{fail('phase-review-state');}phaseReview[phase]={result:structural.result||'recorded',
        structural_json:names.json,structural_json_sha256:inputs.structuralSha256,structural_markdown:names.markdown,
        structural_markdown_sha256:inputs.markdownSha256,adversarial_json:adversarialBytes?names.adversarial:null,
        adversarial_sha256:inputs.adversarialSha256,adversarial_result:adversarial?.result||null};const next=updateFrontmatterText(currentState,
        {phase_review:JSON.stringify(phaseReview),...(phase==='plan'?{plan_review_retries:0}:{})});if(sha256(next)!==prepared.stateAfterSha256)
        fail('phase-review-state-replay');seam?.('before-state-write',{operationId:operation.operationId});platform.atomicWriteFile(stateCapability,next);
      seam?.('after-state-write-before-stage',{operationId:operation.operationId});}else if(stateDigest!==prepared.stateAfterSha256)
    fail('phase-review-state-diverged');await recordOperationStage(operation,'state-written',{owned:{path:stateCapability.path,
      sha256:prepared.stateAfterSha256}});const result={status:'completed',phase,jsonPath:capabilities.json.path,
      markdownPath:capabilities.markdown.path,adversarialPath:capabilities.adversarial?.path||null,stateSha256:prepared.stateAfterSha256,
      structuralSha256:inputs.structuralSha256,markdownSha256:inputs.markdownSha256,adversarialSha256:inputs.adversarialSha256};
  const operationReceipt=await completeOperation(operation,result);return{...result,operationId:operation.operationId,operationReceipt};}

module.exports={PHASE_GRAPH,TDD_GRAPH,beginPhase,completePhase,approvePhase,enterSpecSubphase,
  approveSpecSubphase,advancePhase,
  rerunPhase,invalidateForReplan,transitionSliceTdd,setTddOverride,clearTddOverride,enterDebug,completeDebug,
  exitDebug,recordPhaseReview,authenticateSensorEvidence};
