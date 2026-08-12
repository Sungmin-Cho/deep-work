'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const platform=require('./platform.js');
const transaction=require('./transaction-runtime.js');
const journal=require('./operation-journal.js');
const frontmatter=require('./frontmatter.js');
const bootstrap=require('./bootstrap-runtime.js');
const planRuntime=require('./plan-runtime.js');
const {runSupervisedProcess}=require('./process-supervisor.js');

const DIGEST=/^[0-9a-f]{64}$/;
const OPERATION=/^op-[0-9a-f]{64}$/;
function fail(code,message=code){const error=new Error(`[${code}] ${message}`);error.code=code;throw error;}
function canonical(value){return journal.canonicalJson(value);}
function semanticDigest(domain,value,omitted){
  const copy=structuredClone(value);if(omitted)delete copy[omitted];
  return crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from(`${domain}\0`),Buffer.from(canonical(copy))])).digest('hex');
}
function operationId(domain,value){return `op-${semanticDigest(domain,value)}`;}
function byteSort(values){return [...values].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&
  canonical(Object.keys(value).sort())===canonical([...keys].sort());}
function sid(stateCapability){return transaction.sessionIdFromState(stateCapability);}
function project(stateCapability){return transaction.projectCapabilityFor(stateCapability);}
function readCanonical(file,code){
  let stat,bytes;try{stat=fs.lstatSync(file);bytes=fs.readFileSync(file);}catch{fail(code);}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)fail(code);
  let value;try{value=JSON.parse(bytes);}catch{fail(code);}
  if(!bytes.equals(Buffer.from(canonical(value))))fail(code);
  return{value,bytes,sha256:journal.sha256(bytes)};
}
function writeExclusive(file,value,code){
  const bytes=Buffer.from(canonical(value));fs.mkdirSync(path.dirname(file),{recursive:true});
  let fd;try{fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY,0o600);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);
  }catch(error){if(error.code!=='EEXIST'||!fs.readFileSync(file).equals(bytes))fail(code);}
  finally{if(fd!==undefined)fs.closeSync(fd);}
  if(!fs.readFileSync(file).equals(bytes))fail(code);
  return{bytes,sha256:journal.sha256(bytes)};
}
function loadPlan(planCapability,plan){
  transaction.revalidateSessionFile(planCapability);let current;
  try{current=JSON.parse(transaction.readSessionFile(planCapability));}catch{fail('verification-v2-plan-json');}
  if(canonical(current)!==canonical(plan)||current.contract_binding?.mode!=='strict-spec')
    fail('verification-v2-plan');
  let authority;try{authority=planRuntime.compileImmutablePlanAuthorityV2(current);}
  catch{fail('verification-v2-plan-authority');}
  if(authority.plan_authority_sha256!==current.plan_authority_sha256)
    fail('verification-v2-plan-authority');
  return current;
}
async function acceptedWrite({stateCapability,plan,sliceId,fields,expectedOutcome,
  operationId:explicitOperationId}){
  const operationIdValue=explicitOperationId||fields.accepted_write_operation_id;
  const expectedClasses=expectedOutcome==='must-fail'?['failing-test']:
    ['production','refactor','no-refactor-decision'];
  const stateSelected=!explicitOperationId;
  if(!OPERATION.test(operationIdValue||'')||
      stateSelected&&(!DIGEST.test(fields.accepted_write_receipt_sha256||'')||
      !expectedClasses.includes(fields.accepted_write_class)))
    fail('verification-v2-write');
  const file=path.join(stateCapability.projectRoot,'.claude',
    `deep-work.${sid(stateCapability)}.scoped-write.${operationIdValue}.json`);
  if(expectedOutcome==='must-pass'&&!fs.existsSync(file)){
    const decision=await require('./refactor-decision-runtime.js')
      .authenticateNoRefactorDecision({stateCapability,plan,sliceId,
        operationId:operationIdValue});
    if(stateSelected&&(fields.accepted_write_class!==decision.writeClass||
        fields.accepted_write_receipt_sha256!==decision.receiptSha256))
      fail('verification-v2-write');
    return decision;
  }
  const receipt=readCanonical(file,'verification-v2-write').value;
  const scopedWrite=require('./slice-runtime.js');
  try{scopedWrite.validateAcceptedScopedWriteReceipt(receipt,{
    operationId:operationIdValue,sliceId});
  }catch{fail('verification-v2-write');}
  const planSha256=planRuntime.canonicalizePlanScopeV1(plan).sha256;
  const slice=plan.slices.find((row)=>row.id===sliceId);
  const field={'failing-test':'failing_test',production:'production',
    refactor:'refactor'}[receipt.writeClass];
  const authority=receipt.authority;
  const allPlanFiles=new Set(plan.slices.flatMap((row)=>row.files||[]));
  const historicalAuthorityValid=explicitOperationId&&field&&authority&&
    authority.schema_version===1&&authority.plan_sha256===receipt.planSha256&&
    authority.slice_id===sliceId&&authority.write_class===receipt.writeClass&&
    canonical(authority.class_paths)===canonical(slice?.write_scope?.[field])&&
    Array.isArray(authority.assigned_union)&&
    authority.assigned_union.every((candidate)=>allPlanFiles.has(candidate))&&
    canonical(authority.authorized_paths)===canonical(
      authority.class_paths.filter((candidate)=>authority.assigned_union.includes(candidate)))&&
    authority.sha256===journal.sha256(canonical(Object.fromEntries(
      Object.entries(authority).filter(([key])=>key!=='sha256'))));
  const receiptSha256=scopedWrite.scopedWriteReceiptDigest(receipt);
  if(receipt.status!=='accepted'||receipt.operationId!==operationIdValue||
      receipt.sliceId!==sliceId||!expectedClasses.includes(receipt.writeClass)||
      !(receipt.planSha256===planSha256||historicalAuthorityValid)||
      receipt.receiptSha256!==receiptSha256||
      stateSelected&&fields.accepted_write_receipt_sha256!==receiptSha256)
    fail('verification-v2-write');
  try{await scopedWrite.authenticateScopedWriteProducer({stateCapability,receipt});}
  catch{fail('verification-v2-write-ledger');}
  return receipt;
}
function decimal(value){return String(typeof value==='bigint'?value:BigInt(value));}
function statNanos(stat){return decimal(stat.mtimeNs===undefined?
  BigInt(Math.trunc(stat.mtimeMs*1e6)):stat.mtimeNs);}
function buildSupervisorControl({platformName=process.platform,environment=process.env,
  fsImpl=fs,pathImpl=path}={}){
  if(platformName!=='win32')return{platform:'posix',values:{},identities:{}};
  const supplied=environment.SystemRoot||environment.SYSTEMROOT;
  if(typeof supplied!=='string'||!supplied||environment.SystemRoot&&environment.SYSTEMROOT&&
      pathImpl.normalize(environment.SystemRoot).toLowerCase()!==
      pathImpl.normalize(environment.SYSTEMROOT).toLowerCase())
    fail('verification-v2-supervisor-control');
  let root,rootStat,taskkill,taskkillStat,taskkillBytes;
  try{
    root=fsImpl.realpathSync(supplied);rootStat=fsImpl.lstatSync(root,{bigint:true});
    taskkill=fsImpl.realpathSync(pathImpl.join(root,'System32','taskkill.exe'));
    taskkillStat=fsImpl.lstatSync(taskkill,{bigint:true});taskkillBytes=fsImpl.readFileSync(taskkill);
  }catch{fail('verification-v2-supervisor-control');}
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||
      !taskkillStat.isFile()||taskkillStat.isSymbolicLink())
    fail('verification-v2-supervisor-control');
  return{platform:'win32',values:{SystemRoot:root},identities:{
    system_root:{path:root,dev:decimal(rootStat.dev),ino:decimal(rootStat.ino),
      mode:decimal(rootStat.mode)},
    taskkill:{path:taskkill,sha256:journal.sha256(taskkillBytes),
      dev:decimal(taskkillStat.dev),ino:decimal(taskkillStat.ino),
      mode:decimal(taskkillStat.mode),size:decimal(taskkillStat.size),
      mtime_ns:statNanos(taskkillStat)}}};
}
function executionContext(root,sessionId,sliceId,spec,writeOperationId){
  const tempKey=semanticDigest('verification-owned-temp-v1',{
    session_id:sessionId,slice_id:sliceId,write_operation_id:writeOperationId,
    verification_spec_sha256:journal.sha256(canonical(spec))});
  const ownedTemp=path.join(root,'.claude',
    `deep-work.${sessionId}.verification-temp.${tempKey}`);
  const identity=bootstrap.executableIdentity(),logicalArgv=structuredClone(spec.args);
  const realRoot=fs.realpathSync(root),realTemp=path.join(realRoot,
    path.relative(root,ownedTemp));
  const normalizedArgv=['--no-warnings','--permission',`--allow-fs-read=${realRoot}`,
    `--allow-fs-write=${realTemp}`,'--test','--test-isolation=none',
    '--test-reporter=tap','--',spec.args[3]];
  const environment=structuredClone(spec.environment);
  const containment={provider:'node-permission-v1',node_patch:process.versions.node,
    worktree_realpath:realRoot,owned_temp_realpath:realTemp,
    logical_argv_sha256:bootstrap.bootstrapCommandArgvSha256(logicalArgv),
    effective_argv_sha256:bootstrap.bootstrapCommandArgvSha256(normalizedArgv),
    denied_capabilities:['child-process','native-addon','wasi','worker']};
  const supervisor=buildSupervisorControl();
  return{ownedTemp,identity,logicalArgv,normalizedArgv,environment,containment,supervisor};
}
function prepareOwnedTemp(ownedTemp){
  try{fs.mkdirSync(ownedTemp,{recursive:false,mode:0o700});}
  catch(error){if(error.code!=='EEXIST')throw error;}
  let stat;try{stat=fs.lstatSync(ownedTemp);}catch{fail('verification-v2-owned-temp');}
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.readdirSync(ownedTemp).length!==0)
    fail('verification-v2-owned-temp');
}
function runtimeExclusions(stateCapability,operationIdValue,ownedTemp){
  const root=stateCapability.projectRoot,sessionId=sid(stateCapability);
  const names=[
    `.claude/deep-work.${sessionId}.op.verification-run-v2.${operationIdValue}.json`,
    `.claude/deep-work.${sessionId}.completed-operations.json`,
    `.claude/deep-work.${sessionId}.verification.${operationIdValue}.json`,
    `.claude/deep-work.${sessionId}.verification-manifest.${operationIdValue}.pre.json`,
    `.claude/deep-work.${sessionId}.verification-manifest.${operationIdValue}.post.json`,
  ];
  return[...names.map((name)=>platform.issueProjectStateCapability(root,
    path.join(root,...name.split('/')),{allowMissingLeaf:true,role:'state'})),
  platform.issueProjectStateCapability(root,ownedTemp,{role:'state'})];
}
function projectManifest(raw,{sessionId,operationId:operationIdValue,phase,exclusions}){
  const entries=[];
  for(const row of raw.entries){
    if(row.excluded)continue;
    if(row.type==='directory')continue;
    if(row.type!=='file'||!DIGEST.test(row.sha256||'')||
        !Number.isSafeInteger(row.mode))fail('verification-v2-manifest-entry');
    entries.push({path:row.path,kind:'file',mode:String(row.mode),sha256:row.sha256});
  }
  entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
  const value={schema_version:1,session_id:sessionId,operation_id:operationIdValue,
    phase,exclusions:byteSort(exclusions),entries,manifest_sha256:null};
  value.manifest_sha256=semanticDigest('verification-manifest-v1',value,'manifest_sha256');
  return value;
}
function validateManifest(value,{sessionId,operationId:operationIdValue,phase}){
  const keys=['schema_version','session_id','operation_id','phase','exclusions','entries',
    'manifest_sha256'];
  if(!exactKeys(value,keys)||value.schema_version!==1||value.session_id!==sessionId||
      value.operation_id!==operationIdValue||value.phase!==phase||
      !Array.isArray(value.exclusions)||canonical(value.exclusions)!==canonical(byteSort(value.exclusions))||
      !Array.isArray(value.entries)||value.entries.some((row)=>!exactKeys(row,
        ['path','kind','mode','sha256'])||row.kind!=='file'||!DIGEST.test(row.sha256||'')||
        !/^\d+$/.test(row.mode||''))||
      semanticDigest('verification-manifest-v1',value,'manifest_sha256')!==value.manifest_sha256)
    fail('verification-v2-manifest');
  return value;
}
function changedPaths(before,after){
  const left=new Map(before.entries.map((row)=>[row.path,row]));
  const right=new Map(after.entries.map((row)=>[row.path,row]));
  return byteSort([...new Set([...left.keys(),...right.keys()])].filter((key)=>
    canonical(left.get(key)||null)!==canonical(right.get(key)||null)));
}
async function runVerificationV2({stateCapability,planCapability,plan,sliceId,
  expectedOutcome='must-fail',seam}={}){
  if(!['must-fail','must-pass'].includes(expectedOutcome))
    fail('verification-v2-outcome');
  if(!/^SLICE-\d{3}$/.test(sliceId||''))fail('verification-v2-slice');
  const current=loadPlan(planCapability,plan);
  const target=current.slices?.find((row)=>row.id===sliceId);
  if(!target||target.slice_kind!=='functional')fail('verification-v2-slice');
  const spec=require('./contract-runtime.js').validateVerificationSpecV2(target.verification_spec);
  const specSha256=journal.sha256(canonical(spec));
  if(specSha256!==target.verification_spec_sha256)fail('verification-v2-spec');
  const fields=frontmatter.parseFrontmatter(fs.readFileSync(stateCapability.path,'utf8')).fields;
  require('./slice-runtime.js').assertNoPendingScopedWrite(stateCapability);
  const replanReplay=await require('./replan-runtime.js').adoptVerificationSideEffectReplay({
    stateCapability,plan:current,sliceId,spec,fields});
  if(replanReplay)return replanReplay;
  const allowedState=expectedOutcome==='must-fail'?fields.tdd_state==='PENDING':
    ['RED_VERIFIED','REFACTOR_PENDING'].includes(fields.tdd_state);
  if(fields.current_phase!=='implement'||fields.active_slice!==sliceId||
      !allowedState||!DIGEST.test(fields.verification_plan_sha256||''))
    fail('verification-v2-state');
  const write=await acceptedWrite({stateCapability,plan:current,sliceId,fields,
    expectedOutcome});
  const context=executionContext(stateCapability.projectRoot,sid(stateCapability),sliceId,spec,
    write.operationId);
  const preconditions={session_id:sid(stateCapability),slice_id:sliceId,
    plan_authority_sha256:current.plan_authority_sha256,
    write_operation_id:write.operationId,verification_spec_sha256:specSha256,
    execution_containment_sha256:semanticDigest('execution-containment-v1',
      context.containment),
    supervisor_control_sha256:semanticDigest('supervisor-control-v1',context.supervisor),
    expected_outcome:expectedOutcome};
  const id=operationId('verification-run-v2',preconditions);
  const resultRelative=`.claude/deep-work.${preconditions.session_id}.verification.${id}.json`;
  const resultPath=path.join(stateCapability.projectRoot,...resultRelative.split('/'));
  const completed=await journal.resumeOperation({projectCapability:project(stateCapability),
    operationId:id,sessionId:preconditions.session_id,kind:'verification-run-v2'})
    .catch((error)=>{if(error.code==='operation-not-found')return null;throw error;});
  if(completed?.stage==='completed-ledger'){
    const value=readCanonical(resultPath,'verification-v2-result').value;
    const authenticated=await authenticateVerificationV2({stateCapability,planCapability,
      plan:current,sliceId,operationId:id,resultSha256:value.result_sha256,
      expectedOutcome});
    let replan={};
    if(authenticated.verification.classification.observed_class==='test-side-effect'){
      const result=await require('./replan-runtime.js').dispatchVerificationSideEffectReplan({
        stateCapability,planCapability,plan:current,sliceId,verificationOperationId:id,
        verificationResultSha256:value.result_sha256,seam});
      replan={replan_trigger_id:result.trigger_id,replan_epoch:result.replan_epoch,
        replan_operation_id:result.trigger_operation_id};
    }
    return{...completed.result,...replan,verification_result_path:resultRelative,
      verification_result_sha256:authenticated.verification.result_sha256,
      operation_id:id,operation_receipt:completed,adopted:true};
  }
  prepareOwnedTemp(context.ownedTemp);
  const exclusions=runtimeExclusions(stateCapability,id,context.ownedTemp);
  const exclusionPaths=exclusions.map((capability)=>path.relative(stateCapability.projectRoot,
    capability.path).split(path.sep).join('/'));
  const capture=()=>platform.captureWorktreeManifest({projectCapability:project(stateCapability),
    gitCapability:platform.issueProjectStateCapability(stateCapability.projectRoot,
      path.join(stateCapability.projectRoot,'.git'),{role:'git-root'}),
    runtimeExclusions:exclusions});
  const operation=await journal.beginOperation({projectCapability:project(stateCapability),
    sessionId:preconditions.session_id,kind:'verification-run-v2',operationId:id,
    slice:sliceId,preconditions});
  await journal.recordOperationStage(operation,'containment-authenticated',{owned:{
    executionContainmentSha256:preconditions.execution_containment_sha256,
    supervisorControlSha256:preconditions.supervisor_control_sha256}});
  const pre=projectManifest(capture(),{sessionId:preconditions.session_id,operationId:id,
    phase:'pre',exclusions:exclusionPaths});
  const preRef={path:`.claude/deep-work.${preconditions.session_id}.verification-manifest.${id}.pre.json`,
    sha256:null};
  preRef.sha256=writeExclusive(path.join(stateCapability.projectRoot,...preRef.path.split('/')),
    pre,'verification-v2-pre-manifest').sha256;
  await journal.recordOperationStage(operation,'pre-manifest-published',{owned:{
    path:preRef.path,sha256:preRef.sha256}});
  let ran;
  if(spec.executable.supported_patches_sha256===
      bootstrap.BOOTSTRAP_SUPPORTED_NODE_PATCHES_SHA256&&process.versions.node==='26.0.0'){
    try{ran=await runSupervisedProcess({executable:context.identity.path,
      args:context.normalizedArgv},{cwd:stateCapability.projectRoot,
      timeoutMs:spec.timeout_ms,maxOutputBytes:spec.max_output_bytes,
      env:structuredClone(spec.environment.values),
      supervisorEnv:structuredClone(context.supervisor.values),rawOutput:true});}
    catch(error){ran={exitCode:null,signal:null,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),
      timedOut:false,outputOverflow:false,durationMs:0,spawnError:{code:'spawn-failed',
        message_sha256:journal.sha256(Buffer.from(String(error?.message||error).normalize('NFC')))}};}
  }else ran={exitCode:null,signal:null,stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),
    timedOut:false,outputOverflow:false,durationMs:0,spawnError:{code:'identity-drift',
      message_sha256:journal.sha256(Buffer.from('unsupported-node-patch'))}};
  const stdout=Buffer.isBuffer(ran.stdout)?Buffer.from(ran.stdout):Buffer.from(ran.stdout||'');
  const stderr=Buffer.isBuffer(ran.stderr)?Buffer.from(ran.stderr):Buffer.from(ran.stderr||'');
  const processRecord={exit_code:ran.exitCode,signal:ran.signal,timed_out:ran.timedOut,
    output_overflow:ran.outputOverflow,duration_ms:ran.durationMs,
    spawn_error:ran.spawnError||null};
  await journal.recordOperationStage(operation,'process-completed',{owned:{
    processSha256:semanticDigest('verification-process-v1',processRecord)}});
  seam?.('after-process-before-post-manifest',{operationId:id});
  const post=projectManifest(capture(),{sessionId:preconditions.session_id,operationId:id,
    phase:'post',exclusions:exclusionPaths});
  const postRef={path:`.claude/deep-work.${preconditions.session_id}.verification-manifest.${id}.post.json`,
    sha256:null};
  postRef.sha256=writeExclusive(path.join(stateCapability.projectRoot,...postRef.path.split('/')),
    post,'verification-v2-post-manifest').sha256;
  await journal.recordOperationStage(operation,'post-manifest-published',{owned:{
    path:postRef.path,sha256:postRef.sha256}});
  const changed=changedPaths(pre,post);
  const classification=bootstrap.classifyVerificationObservation({processResult:ran,
    changedPaths:changed,stdout,stderr,root:stateCapability.projectRoot,
    testPath:spec.args[3],nodePatch:process.versions.node,
    expectedSignal:spec.red_failure.expected_signal});
  const verification={schema_version:2,session_id:preconditions.session_id,slice_id:sliceId,
    plan_authority_sha256:current.plan_authority_sha256,
    spec_sha256:current.contract_binding.spec_contract.spec_sha256,
    verification_plan_sha256:fields.verification_plan_sha256,
    write_operation_id:write.operationId,verification_operation_id:id,
    result_path:resultRelative,executable_identity:context.identity,
    logical_argv:context.logicalArgv,normalized_argv:context.normalizedArgv,cwd_role:'worktree',
    environment:context.environment,
    environment_sha256:semanticDigest('node-test-env-v1',context.environment),
    execution_containment:context.containment,
    execution_containment_sha256:preconditions.execution_containment_sha256,
    supervisor_control:context.supervisor,
    supervisor_control_sha256:preconditions.supervisor_control_sha256,
    process:processRecord,raw_stdout:{base64:stdout.toString('base64'),byte_length:stdout.length,
      sha256:journal.sha256(stdout)},raw_stderr:{base64:stderr.toString('base64'),
      byte_length:stderr.length,sha256:journal.sha256(stderr)},pre_manifest_ref:preRef,
    post_manifest_ref:postRef,changed_paths:changed,
    scope_disposition:changed.length?'test-side-effect':'clean',classification,
    disposition:((expectedOutcome==='must-fail'&&
      classification.observed_class==='expected-failure')||
      (expectedOutcome==='must-pass'&&
        classification.observed_class==='unexpected-pass'))&&!changed.length?
      'accepted':'rejected',result_sha256:null};
  verification.result_sha256=semanticDigest('verification-result-v2',verification,
    'result_sha256');
  bootstrap.validateBootstrapVerificationResultV2(verification,{
    expectedSignal:spec.red_failure.expected_signal,expectedOutcome});
  writeExclusive(resultPath,verification,'verification-v2-result');
  await journal.recordOperationStage(operation,'result-published',{owned:{
    resultPath:resultRelative,resultSha256:verification.result_sha256}});
  try{fs.rmSync(context.ownedTemp,{recursive:true,force:false});}catch{fail('verification-v2-owned-temp-cleanup');}
  const terminal={session_id:preconditions.session_id,slice_id:sliceId,
    result_path:resultRelative,result_sha256:verification.result_sha256,
    disposition:verification.disposition,
    observed_class:verification.classification.observed_class,
    scope_disposition:verification.scope_disposition};
  const receipt=await journal.completeOperation(operation,terminal);
  let replan={};
  if(verification.classification.observed_class==='test-side-effect'){
    const result=await require('./replan-runtime.js').dispatchVerificationSideEffectReplan({
      stateCapability,planCapability,plan:current,sliceId,verificationOperationId:id,
      verificationResultSha256:verification.result_sha256,seam});
    replan={replan_trigger_id:result.trigger_id,replan_epoch:result.replan_epoch,
      replan_operation_id:result.trigger_operation_id};
  }
  return{...terminal,...replan,verification_result_path:resultRelative,
    verification_result_sha256:verification.result_sha256,operation_id:id,
    operation_receipt:receipt,adopted:false};
}
async function authenticateVerificationV2({stateCapability,planCapability,plan,sliceId,
  operationId:operationIdValue,resultSha256,expectedOutcome='must-fail'}={}){
  if(!/^SLICE-\d{3}$/.test(sliceId||'')||!OPERATION.test(operationIdValue||'')||
      !DIGEST.test(resultSha256||'')||
      !['must-fail','must-pass'].includes(expectedOutcome))
    fail('verification-v2-identity');
  const current=loadPlan(planCapability,plan),target=current.slices?.find((row)=>row.id===sliceId);
  if(!target||target.slice_kind!=='functional')fail('verification-v2-slice');
  const spec=require('./contract-runtime.js').validateVerificationSpecV2(target.verification_spec);
  const fields=frontmatter.parseFrontmatter(fs.readFileSync(stateCapability.path,'utf8')).fields;
  const resultPath=path.join(stateCapability.projectRoot,'.claude',
    `deep-work.${sid(stateCapability)}.verification.${operationIdValue}.json`);
  const verification=bootstrap.validateBootstrapVerificationResultV2(
    readCanonical(resultPath,'verification-v2-result').value,{
      expectedSignal:spec.red_failure.expected_signal,
      expectedOutcome});
  const write=await acceptedWrite({stateCapability,plan:current,sliceId,fields,
    expectedOutcome,operationId:verification.write_operation_id});
  const context=executionContext(stateCapability.projectRoot,sid(stateCapability),sliceId,spec,
    write.operationId);
  if(verification.result_sha256!==resultSha256||
      verification.plan_authority_sha256!==current.plan_authority_sha256||
      verification.spec_sha256!==current.contract_binding.spec_contract.spec_sha256||
      verification.verification_plan_sha256!==fields.verification_plan_sha256||
      verification.write_operation_id!==write.operationId)fail('verification-v2-authority');
  if(canonical(verification.executable_identity)!==canonical(context.identity)||
      canonical(verification.logical_argv)!==canonical(context.logicalArgv)||
      canonical(verification.normalized_argv)!==canonical(context.normalizedArgv)||
      canonical(verification.environment)!==canonical(context.environment)||
      semanticDigest('node-test-env-v1',context.environment)!==verification.environment_sha256||
      canonical(verification.execution_containment)!==canonical(context.containment)||
      semanticDigest('execution-containment-v1',context.containment)!==
        verification.execution_containment_sha256||
      canonical(verification.supervisor_control)!==canonical(context.supervisor)||
      semanticDigest('supervisor-control-v1',context.supervisor)!==
        verification.supervisor_control_sha256)
    fail('verification-v2-execution-authority');
  const preconditions={session_id:sid(stateCapability),slice_id:sliceId,
    plan_authority_sha256:current.plan_authority_sha256,
    write_operation_id:write.operationId,
    verification_spec_sha256:journal.sha256(canonical(spec)),
    execution_containment_sha256:semanticDigest('execution-containment-v1',
      context.containment),
    supervisor_control_sha256:semanticDigest('supervisor-control-v1',
      context.supervisor),expected_outcome:expectedOutcome};
  if(operationId('verification-run-v2',preconditions)!==operationIdValue)
    fail('verification-v2-operation-identity');
  const manifests={};
  for(const phase of ['pre','post']){
    const ref=verification[`${phase}_manifest_ref`];
    const raw=readCanonical(path.join(stateCapability.projectRoot,...ref.path.split('/')),
      'verification-v2-manifest');
    if(raw.sha256!==ref.sha256)fail('verification-v2-manifest');
    manifests[phase]=validateManifest(raw.value,{sessionId:sid(stateCapability),
      operationId:operationIdValue,phase});
  }
  if(canonical(changedPaths(manifests.pre,manifests.post))!==
      canonical(verification.changed_paths))fail('verification-v2-manifest');
  const stdout=Buffer.from(verification.raw_stdout.base64,'base64');
  const stderr=Buffer.from(verification.raw_stderr.base64,'base64');
  const replay=bootstrap.classifyVerificationObservation({processResult:{
    exitCode:verification.process.exit_code,signal:verification.process.signal,
    timedOut:verification.process.timed_out,outputOverflow:verification.process.output_overflow,
    spawnError:verification.process.spawn_error},changedPaths:verification.changed_paths,
    stdout,stderr,root:stateCapability.projectRoot,testPath:spec.args[3],
    nodePatch:verification.executable_identity.node_version,
    expectedSignal:spec.red_failure.expected_signal});
  if(canonical(replay)!==canonical(verification.classification))
    fail('verification-v2-classification');
  const receipt=await journal.resumeOperation({projectCapability:project(stateCapability),
    operationId:operationIdValue,sessionId:sid(stateCapability),kind:'verification-run-v2'});
  if(receipt.stage!=='completed-ledger'||receipt.result?.result_sha256!==resultSha256||
      receipt.result?.result_path!==verification.result_path)fail('verification-v2-ledger');
  return{plan:current,target,spec,fields,write,verification,verificationReceipt:receipt,
    manifests,expectedOutcome};
}

module.exports={runVerificationV2,authenticateVerificationV2,validateManifest,
  projectManifest,changedPaths,buildSupervisorControl};
