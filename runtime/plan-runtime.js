'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalizePortableProjectPathV1, issueProjectStateCapability, atomicWriteFile,
  revalidatePathCapability } = require('./platform.js');
const { beginOperation, recordOperationStage, completeOperation, canonicalJson } =
  require('./operation-journal.js');

const CLASS_FIELD = Object.freeze({
  'failing-test':'failing_test', production:'production', refactor:'refactor',
});

function fail(code, message) {
  const error = new Error(`[${code}] ${message || code}`);
  error.code = code;
  throw error;
}

function byteSort(values) {
  return [...values].sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)));
}

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function isTestPath(file) {
  return /(?:^|\/)(?:tests?|__tests__|fixtures|__mocks__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(file);
}

function parseStoredObject(value, code) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return structuredClone(value);
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed; }
  catch {}
  fail(code);
}

function compilePlanProjectionV1({planMarkdown, specContract, sliceRiskState} = {}) {
  if (typeof planMarkdown !== 'string' || !planMarkdown.trim()) fail('plan-source');
  const contractRuntime = require('./contract-runtime.js');
  const specResult = contractRuntime.validateSpecContract(specContract, {riskClass:specContract?.risk_class});
  if (!specResult.pass) fail('plan-spec-contract', specResult.errors.map((row)=>row.code).join(','));
  const parsed = contractRuntime.parsePlanContractMarkdown(planMarkdown, {path:'plan.md',specIndex:specResult.index});
  if (!parsed.binding || parsed.binding.mode !== 'strict-spec') fail('plan-binding');
  const specSha256 = contractRuntime.specContractDigest(specContract);
  if (parsed.binding.spec_contract?.spec_id !== specContract.spec_id ||
      parsed.binding.spec_contract?.spec_sha256 !== specSha256 ||
      !/^[0-9a-f]{64}$/.test(parsed.binding.spec_contract?.spec_approved_hash || '') ||
      !/^[0-9a-f]{64}$/.test(parsed.binding.risk_profile_sha256 || '')) fail('plan-binding-identity');
  const riskState = parseStoredObject(sliceRiskState || {}, 'plan-slice-risk');
  const executionResult=contractRuntime.validateSpecContract(specContract,{riskClass:specContract.risk_class,
    slices:parsed.slices});
  if(!executionResult.pass)fail('plan-spec-execution',executionResult.errors.map((row)=>row.code).join(','));
  const slices = parsed.slices.map((contract) => {
    const projected = riskState[contract.id];
    if (!projected || canonicalJson({class:projected.class,score:projected.score,triggers:projected.triggers}) !==
        canonicalJson(contract.risk)) fail('plan-slice-risk', contract.id);
    const files = validatePaths(contract.files, `${contract.id}.files`);
    if(contract.slice_kind==='release-verification'){
      return {id:contract.id,slice_kind:contract.slice_kind,checked:false,scope_schema_version:1,files:[],
        write_scope:{failing_test:[],production:[],refactor:[]},
        verification_scope:byteSort(contract.verification_scope),
        release_gate_ids:byteSort(contract.release_gate_ids),verification_spec:null,
        verification_spec_sha256:null,contract};
    }
    const failing = files.filter(isTestPath);
    const production = files.filter((file)=>!isTestPath(file));
    if (!failing.length || !production.length) fail('plan-scope-empty-class', contract.id);
    const verificationSpec=contract.verification_spec;
    return {id:contract.id,...(contract.slice_kind?{slice_kind:contract.slice_kind}:{}),checked:false,
      scope_schema_version:1,files,write_scope:{failing_test:failing,production,refactor:[]},
      ...(verificationSpec?{verification_spec:verificationSpec,
        verification_spec_sha256:sha256(Buffer.from(canonicalJson(verificationSpec)))}:{}),contract};
  });
  const binding = {...parsed.binding,source_plan_sha256:sha256(Buffer.from(planMarkdown))};
  const projection=validatePlanScopeV1({schema_version:parsed.capability_facts?2:1,contract_binding:binding,
    ...(parsed.capability_facts?{replan_epoch:parsed.replan_epoch,capability_facts:parsed.capability_facts}:{}),slices});
  return parsed.capability_facts?{...projection,...compileImmutablePlanAuthorityV2(projection)}:projection;
}

function publishPlanProjectionV1({planCapability, projection} = {}) {
  if (!planCapability || !projection) fail('plan-publish-input');
  const checked = validatePlanScopeV1(projection);
  const bytes = Buffer.from(canonicalJson(checked));
  const transaction = require('./transaction-runtime.js');
  transaction.revalidateSessionFile(planCapability);
  if (path.basename(planCapability.path) !== 'plan.json') fail('plan-publish-target');
  if (fs.existsSync(planCapability.path)) {
    const current = transaction.readSessionFile(planCapability);
    if (current.equals(bytes)) return {path:planCapability.path,sha256:sha256(bytes),projection:checked,adopted:true};
  }
  transaction.atomicWriteSessionFile(planCapability, bytes);
  return {path:planCapability.path,sha256:sha256(bytes),projection:checked,adopted:false};
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function validatePaths(values, label) {
  if (!Array.isArray(values)) fail('plan-scope', `${label} must be an array`);
  const seen = new Set();
  const windows = new Set();
  for (const value of values) {
    let canonical;
    try { canonical = canonicalizePortableProjectPathV1(value); }
    catch (error) { if (!error.code) error.code = 'portable-path-v1'; throw error; }
    if (seen.has(canonical.path) || windows.has(canonical.windowsKey)) {
      fail('plan-scope-collision', `${label} contains an exact or Windows-key collision`);
    }
    seen.add(canonical.path); windows.add(canonical.windowsKey);
  }
  return byteSort(values);
}

function validatePlanScopeV1(input) {
  if (!input || ![1,2].includes(input.schema_version) || !Array.isArray(input.slices) || !input.slices.length) {
    fail('plan-scope-schema', 'plan scope must contain version-1 slices');
  }
  const sliceIds = new Set();
  const slices = input.slices.map((slice) => {
    if (!slice || !/^SLICE-\d{3}$/.test(slice.id || '') ||
        typeof slice.checked !== 'boolean' || slice.scope_schema_version !== 1 ||
        !slice.write_scope || typeof slice.write_scope !== 'object') fail('plan-scope-schema');
    if (sliceIds.has(slice.id)) fail('plan-scope-duplicate-slice');
    sliceIds.add(slice.id);
    const files = validatePaths(slice.files, `${slice.id}.files`);
    const failing = validatePaths(slice.write_scope.failing_test, 'failing_test');
    const production = validatePaths(slice.write_scope.production, 'production');
    const refactor = validatePaths(slice.write_scope.refactor || [], 'refactor');
    if(slice.slice_kind==='release-verification'){
      if(files.length||failing.length||production.length||refactor.length)
        fail('release-slice-write-scope');
      if(slice.verification_spec!==null||slice.verification_spec_sha256!==null||
          !Array.isArray(slice.verification_scope)||!slice.verification_scope.length||
          !Array.isArray(slice.release_gate_ids)||!slice.release_gate_ids.length)
        fail('release-slice-verification');
    }else if (!failing.length || !production.length) fail('plan-scope-empty-class');
    const fileSet = new Set(files);
    if ([...failing,...production,...refactor].some((entry) => !fileSet.has(entry))) {
      fail('plan-scope-membership');
    }
    if (failing.some((entry) => production.includes(entry))) fail('plan-scope-disjoint');
    const union = new Set([...failing,...production,...refactor]);
    if (union.size !== files.length || files.some((entry) => !union.has(entry))) {
      fail('plan-scope-coverage');
    }
    if (slice.contract) require('./contract-runtime.js').validateSliceContract(slice.contract,{legacy:false});
    return {...slice, files, write_scope:{failing_test:failing,production,refactor}};
  });
  return {...input,slices};
}

function compileImmutablePlanAuthorityV2(input) {
  if(!input||input.schema_version!==2||!Array.isArray(input.slices)||!input.slices.length)
    fail('plan-authority-v2');
  if(input.slices.some((slice)=>typeof slice?.checked!=='boolean'))
    fail('plan-authority-v2');
  const sliceIds=new Set(input.slices.map((row)=>row.id));
  const capabilityFacts=require('./contract-runtime.js').validateCapabilityFactsV1(input.capability_facts,{sliceIds});
  if(input.replan_epoch!==null&&input.replan_epoch!==undefined&&!/^[0-9a-f]{64}$/.test(input.replan_epoch))
    fail('plan-replan-epoch');
  const slices=[...input.slices].sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id))).map((slice)=>{
    const writeScope=structuredClone(slice.write_scope);
    if(slice.slice_kind==='release-verification'){
      if(Object.values(writeScope||{}).some((rows)=>!Array.isArray(rows)||rows.length))
        fail('release-slice-write-scope');
      if(slice.verification_spec!==null)fail('release-slice-verification-spec');
      return {id:slice.id,slice_kind:slice.slice_kind,scope_schema_version:slice.scope_schema_version,
        files:[],write_scope:writeScope,verification_scope:byteSort(slice.verification_scope||[]),
        release_gate_ids:byteSort(slice.release_gate_ids||[]),verification_spec:null,verification_spec_sha256:null,
        ...(slice.contract?{contract:structuredClone(slice.contract)}:{})};
    }
    if(slice.slice_kind!=='functional')fail('functional-slice-kind');
    const verificationSpec=require('./contract-runtime.js').validateVerificationSpecV2(slice.verification_spec);
    const verificationSpecSha256=sha256(Buffer.from(canonicalJson(verificationSpec)));
    const authoritativeCarrier=input.replan_epoch!==null&&input.replan_epoch!==undefined||
      require('./verification-policy-runtime.js').isAtLeast614(
        input.contract_binding?.created_by_version);
    if(authoritativeCarrier&&slice.verification_spec_sha256!==verificationSpecSha256)
      fail('verification-spec-digest');
    return {id:slice.id,slice_kind:slice.slice_kind,scope_schema_version:slice.scope_schema_version,
      files:validatePaths(slice.files,`${slice.id}.files`),write_scope:writeScope,
      verification_spec:verificationSpec,verification_spec_sha256:verificationSpecSha256,
      ...(slice.contract?{contract:structuredClone(slice.contract)}:{})};
  });
  const authority={schema_version:2,contract_binding:structuredClone(input.contract_binding),
    replan_epoch:input.replan_epoch??null,capability_facts:capabilityFacts,slices};
  return {...authority,plan_authority_sha256:sha256(Buffer.from(canonicalJson(authority))),authority};
}

function canonicalizePlanScopeV1(input) {
  const plan = validatePlanScopeV1(input);
  const canonical = {...plan, slices:[...plan.slices].sort((a,b) =>
    Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)))};
  return {...canonical, sha256:sha256(canonicalJson(canonical))};
}

function validateAssignment(plan, assignment) {
  if (!exactKeys(assignment, ['schema_version','clusters']) || assignment.schema_version !== 1 ||
      !Array.isArray(assignment.clusters) || !assignment.clusters.length) fail('delegation-scope-schema');
  const planIds = new Set(plan.slices.map((slice) => slice.id));
  const delegated = new Set();
  const clusters = assignment.clusters.map((cluster) => {
    if (!exactKeys(cluster,['id','slices']) || !/^C[1-9]\d*$/.test(cluster.id || '') ||
        !Array.isArray(cluster.slices) || !cluster.slices.length) fail('delegation-scope-cluster');
    const slices = byteSort(cluster.slices);
    if (canonicalJson(slices) !== canonicalJson(cluster.slices)) fail('delegation-scope-order');
    if (new Set(slices).size !== slices.length || slices.some((id) => !planIds.has(id))) {
      fail('delegation-scope-partition');
    }
    for (const id of slices) {
      if (delegated.has(id)) fail('delegation-scope-partition');
      delegated.add(id);
    }
    return {id:cluster.id,slices};
  }).sort((a,b) => Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));
  if (delegated.size !== planIds.size || [...planIds].some((id) => !delegated.has(id))) {
    fail('delegation-scope-partition');
  }
  return {schema_version:1,clusters};
}

async function publishDelegationScope({stateCapability, planCapability, plan, assignment, snapshot,
  deferCompletion=false,seam}) {
  if (stateCapability) revalidatePathCapability(stateCapability, 'delegation-state');
  if (planCapability) {if(planCapability.kind==='session-file-capability')require('./transaction-runtime.js').revalidateSessionFile(planCapability);
    else revalidatePathCapability(planCapability, 'delegation-plan');}
  const checked = canonicalizePlanScopeV1(plan || JSON.parse(fs.readFileSync(planCapability.path,'utf8')));
  const canonicalAssignment = validateAssignment(checked, assignment);
  const bytes = canonicalJson({schema_version:1,plan_sha256:checked.sha256,
    clusters:canonicalAssignment.clusters});
  const root = stateCapability.projectRoot;
  const fields = require('./frontmatter.js').parseFrontmatter(fs.readFileSync(stateCapability.path,'utf8')).fields;
  const workDir = path.join(root,...String(fields.work_dir).split('/'));
  const target = path.join(workDir,'delegation-scope.json');
  const projectCapability = issueProjectStateCapability(root,root,{role:'project-root'});
  if(snapshot!==undefined&&!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshot||''))fail('delegation-snapshot');
  const operation = await beginOperation({projectCapability,sessionId:fields.session_id,
    kind:'delegation-scope-publish',preconditions:{planSha256:checked.sha256,...(snapshot?{snapshot}:{})}});
  fs.mkdirSync(workDir,{recursive:true});
  const transaction=require('./transaction-runtime.js');const stateCap=stateCapability;
  const sessionCapability=issueProjectStateCapability(root,workDir,{role:'session-work-dir',sessionStateCapability:stateCap});
  const output=transaction.issueSessionFileCapability({sessionCapability,candidate:target,
    allowedBasenames:['delegation-scope.json'],allowMissingLeaf:true,role:'delegation-scope'});
  const exact=fs.existsSync(output.path)&&transaction.readSessionFile(output).equals(Buffer.from(bytes));
  if(!exact){seam?.('before-delegation-write',{operationId:operation.operationId,path:target,sha256:sha256(bytes)});
    transaction.atomicWriteSessionFile(output,bytes);seam?.('after-delegation-write-before-stage',
      {operationId:operation.operationId,path:target,sha256:sha256(bytes)});}
  await recordOperationStage(operation,'delegation-written',{owned:{sha256:sha256(bytes)}});
  if(!deferCompletion)await completeOperation(operation,{status:'completed',sha256:sha256(bytes)});
  return {assignment:canonicalAssignment,planSha256:checked.sha256,sha256:sha256(bytes),
    operationId:operation.operationId,path:target,...(deferCompletion?{operation}:{})};
}

function deriveScopedWriteAuthority({plan, sliceId, writeClass, assignment, clusterId,
  delegationOperationId = null, delegationSha256 = null, expectedSha256} = {}) {
  const canonical = canonicalizePlanScopeV1(plan);
  const slice = canonical.slices.find((entry) => entry.id === sliceId);
  if (!slice) fail('plan-scope-slice');
  const field = CLASS_FIELD[writeClass];
  if (!field) fail('plan-scope-class');
  let assignedUnion = slice.files;
  let selectedCluster = null;
  if (assignment) {
    const checked = validateAssignment(canonical, assignment.assignment || assignment);
    selectedCluster = checked.clusters.find((cluster) => cluster.id === clusterId);
    if (!selectedCluster || !selectedCluster.slices.includes(sliceId)) fail('delegation-scope-cluster');
    assignedUnion = byteSort([...new Set(selectedCluster.slices.flatMap((id) =>
      canonical.slices.find((item) => item.id === id).files))]);
  }
  const classPaths = slice.write_scope[field];
  const assignedSet = new Set(assignedUnion);
  const authority = {schema_version:1,plan_sha256:canonical.sha256,
    delegation_operation_id:delegationOperationId,
    delegation_sha256:delegationSha256,
    cluster_id:selectedCluster ? selectedCluster.id : null,
    slice_id:sliceId,write_class:writeClass,class_paths:classPaths,
    assigned_union:assignedUnion,authorized_paths:classPaths.filter((entry) => assignedSet.has(entry))};
  const digest = sha256(canonicalJson(authority));
  if (expectedSha256 && expectedSha256 !== digest) fail('write-scope-digest');
  return {...authority,sha256:digest};
}

module.exports = {
  CLASS_FIELD,
  validatePlanScopeV1,
  canonicalizePlanScopeV1,
  validateAssignment,
  publishDelegationScope,
  deriveScopedWriteAuthority,
  compilePlanProjectionV1,
  compileImmutablePlanAuthorityV2,
  publishPlanProjectionV1,
};
