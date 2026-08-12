'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const journal=require('./operation-journal.js');
const transaction=require('./transaction-runtime.js');
const frontmatter=require('./frontmatter.js');
const planRuntime=require('./plan-runtime.js');
const platform=require('./platform.js');

const DIGEST=/^[0-9a-f]{64}$/;
const OPERATION=/^op-[0-9a-f]{64}$/;
const RELEASE_RECEIPT_KEYS=['schema_version','slice_id','plan_authority_sha256',
  'verification_plan_sha256','gate_results','functional_receipts',
  'completion_operation_id','receipt_sha256'];
const LEGACY_INVALIDATED_RELEASE_RECEIPT_KEYS=[...RELEASE_RECEIPT_KEYS,
  'estimated_cost','git_after','git_before','goal','model_auto_selected',
  'model_override_reason','model_used','status','tdd_mode','worktree_branch'];
const SEMVER=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
function fail(code,message=code){const error=new Error(`[${code}] ${message}`);
  error.code=code;throw error;}
function canonical(value){return journal.canonicalJson(value);}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&
  canonical(Object.keys(value).sort())===canonical([...keys].sort());}
function semanticDigest(domain,value){
  return crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from(`${domain}\0`),Buffer.from(canonical(value))])).digest('hex');
}
function operationId(domain,value){return `op-${semanticDigest(domain,value)}`;}
function sortedUnique(values,validator=()=>true){
  return Array.isArray(values)&&values.every(validator)&&
    new Set(values).size===values.length&&canonical(values)===canonical([...values]
      .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
}
function portable(value){return typeof value==='string'&&value.length>0&&
  !value.startsWith('/')&&!value.includes('\\')&&!value.split('/').includes('..');}

const RELEASE_GATE_CATALOG=Object.freeze({
  carrier:Object.freeze({argv:Object.freeze(['node','--test',
    'runtime/contract-runtime.test.js','runtime/plan-runtime.test.js',
    'runtime/verification-policy-runtime.test.js','scripts/deep-work-runtime.test.js']),
  gate_ids:Object.freeze(['GATE-backward-compat','GATE-migration-dry-run'])}),
  tdd:Object.freeze({argv:Object.freeze(['node','--test',
    'runtime/verification-runtime.test.js','runtime/phase-runtime.test.js',
    'runtime/slice-runtime.test.js','hooks/scripts/verify-receipt-core.test.js']),
  gate_ids:Object.freeze(['GATE-negative-tests','GATE-permission-negative',
    'GATE-receipt-completeness','GATE-tdd-green',
    'GATE-tdd-red'])}),
  replan:Object.freeze({argv:Object.freeze(['node','--test',
    'runtime/phase-runtime.test.js','runtime/slice-runtime.test.js',
    'runtime/evidence-runtime.test.js','runtime/report-runtime.test.js',
    'runtime/transaction-runtime.test.js','scripts/deep-work-runtime.test.js']),
  gate_ids:Object.freeze(['GATE-concurrency-stress','GATE-fault-injection',
    'GATE-idempotency-proof','GATE-recovery','GATE-timeout-retry-partial'])}),
  integration:Object.freeze({argv:Object.freeze(['node','--test',
    'tests/v6.13-spec-contract-integration.test.js',
    'tests/v6.13-spec-evidence-integration.test.js']),
  gate_ids:Object.freeze(['GATE-e2e-entrypoint','GATE-host-smoke',
    'GATE-relevant-integration'])}),
  targeted:Object.freeze({argv:Object.freeze(['node','--test',
    'runtime/functional-receipt-runtime.test.js',
    'tests/context-engineering-context-contract.test.js',
    'tests/context-engineering-receipt-contract.test.js',
    'tests/skill-reference-integrity.test.js']),
  gate_ids:Object.freeze(['GATE-context-contract','GATE-receipt-lock-order',
    'GATE-reference-integrity','GATE-targeted-tests'])}),
  full:Object.freeze({argv:Object.freeze(['npm','test']),
    gate_ids:Object.freeze(['GATE-full-relevant-suite','GATE-full-suite'])}),
  pack:Object.freeze({argv:Object.freeze(['npm','pack','--dry-run','--json']),
    gate_ids:Object.freeze(['GATE-fresh-install-build'])}),
});

const DETERMINISTIC_GATE_MAPPING=Object.freeze({
  'spec-gate-v1':Object.freeze(['GATE-failure-matrix','GATE-plan-alignment',
    'GATE-requirement-coverage','GATE-spec-contract']),
  'changed-js-syntax-v1':Object.freeze(['GATE-impacted-lint-typecheck']),
  'release-integrity-v1':Object.freeze(['GATE-clean-build']),
  'single-review-v1':Object.freeze(['GATE-single-review']),
  'mutation-critical-path-v1':Object.freeze(['GATE-mutation-critical-path']),
  'rollback-rehearsal-v1':Object.freeze(['GATE-rollback-rehearsal']),
  'governed-health-v1':Object.freeze(['GATE-health-required']),
  'governed-evidence-v1':Object.freeze(['GATE-evidence-completeness']),
  'evidence-redaction-v1':Object.freeze(['GATE-redaction']),
  'dual-final-review-v1':Object.freeze(['GATE-dual-final-review']),
  'human-ack-v1':Object.freeze(['GATE-human-ack']),
});

const CHECKER_INPUT_CATALOG=Object.freeze({
  'spec-gate-v1':Object.freeze(['spec-approval','spec-contract','spec-gate-result']),
  'changed-js-syntax-v1':Object.freeze(['git-diff-manifest','plan-authority']),
  'release-integrity-v1':Object.freeze(['claude-manifest','codex-manifest',
    'docs-rule','external-operation-index','git-snapshot','package-manifest',
    'runtime-version']),
  'single-review-v1':Object.freeze(['finding-ref','review-execution']),
  'mutation-critical-path-v1':Object.freeze(['mutation-round-result']),
  'rollback-rehearsal-v1':Object.freeze(['rollback-rehearsal']),
  'governed-health-v1':Object.freeze(['health-report']),
  'governed-evidence-v1':Object.freeze(['evidence-package','verification-plan']),
  'evidence-redaction-v1':Object.freeze(['evidence-package','redaction-policy']),
  'dual-final-review-v1':Object.freeze(['executability-finding-ref',
    'executability-review-execution','semantic-finding-ref',
    'semantic-review-execution']),
  'human-ack-v1':Object.freeze(['human-ack']),
});
const INPUT_PRODUCER_KINDS=Object.freeze({
  'spec-approval':Object.freeze(['phase-approval']),
  'spec-contract':Object.freeze(['phase-approval']),
  'spec-gate-result':Object.freeze(['phase-approval']),
  'git-diff-manifest':Object.freeze(['evidence-capture']),
  'plan-authority':Object.freeze(['phase-approval']),
  'claude-manifest':Object.freeze(['release-input-publish']),
  'codex-manifest':Object.freeze(['release-input-publish']),
  'docs-rule':Object.freeze(['release-input-publish']),
  'external-operation-index':Object.freeze(['release-input-publish']),
  'git-snapshot':Object.freeze(['release-input-publish']),
  'package-manifest':Object.freeze(['release-input-publish']),
  'runtime-version':Object.freeze(['release-input-publish']),
  'finding-ref':Object.freeze(['finding-publish']),
  'review-execution':Object.freeze(['phase-review-record']),
  'mutation-round-result':Object.freeze(['mutation-round']),
  'rollback-rehearsal':Object.freeze(['evidence-adapter-run']),
  'health-report':Object.freeze(['evidence-capture']),
  'evidence-package':Object.freeze(['evidence-capture','evidence-publish']),
  'verification-plan':Object.freeze(['phase-approval']),
  'redaction-policy':Object.freeze(['evidence-capture']),
  'executability-finding-ref':Object.freeze(['finding-publish']),
  'executability-review-execution':Object.freeze(['phase-review-record']),
  'semantic-finding-ref':Object.freeze(['finding-publish']),
  'semantic-review-execution':Object.freeze(['phase-review-record']),
  'human-ack':Object.freeze(['evidence-capture']),
});

function validateCoverage(row){
  if(!exactKeys(row,['total','covered','uncovered_ids','ratio'])||
      !Number.isSafeInteger(row.total)||row.total<0||
      !Number.isSafeInteger(row.covered)||row.covered<0||row.covered>row.total||
      !sortedUnique(row.uncovered_ids,(value)=>typeof value==='string'&&value.length>0)||
      row.uncovered_ids.length!==row.total-row.covered||
      row.ratio!==(row.total===0?1:row.covered/row.total))
    fail('release-gate-facts');
  return row;
}
function locator(value){return exactKeys(value,
  ['kind','path','sha256','producer_operation_id'])&&
  typeof value.kind==='string'&&portable(value.path)&&DIGEST.test(value.sha256||'')&&
  OPERATION.test(value.producer_operation_id||'');}
function locatorSortKey(row){return `${row.kind}\0${row.path}\0${row.sha256}\0${
  row.producer_operation_id}`;}
function validateCheckerInputRefs(checkerId,refs){
  const expected=CHECKER_INPUT_CATALOG[checkerId];
  if(!expected||!Array.isArray(refs)||refs.some((row)=>!locator(row))||
      canonical(refs.map(locatorSortKey))!==canonical(refs.map(locatorSortKey)
        .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))))||
      new Set(refs.map(locatorSortKey)).size!==refs.length)
    fail('checker-input-catalog');
  const kinds=refs.map((row)=>row.kind);
  if(checkerId==='mutation-critical-path-v1'){
    if(kinds.length===0||kinds.some((kind)=>kind!=='mutation-round-result'))
      fail('checker-input-catalog');
  }else if(canonical(kinds)!==canonical(expected))fail('checker-input-catalog');
  return structuredClone(refs);
}
function commonLocator(value){return locator(value);}
function validateFacts(checkerId,facts){
  const ids=(value)=>sortedUnique(value,(row)=>typeof row==='string'&&row.length>0);
  switch(checkerId){
  case 'spec-gate-v1':
    if(!exactKeys(facts,['spec_sha256','spec_approved_hash',
      'requirement_coverage','failure_matrix_coverage','pass'])||
      !DIGEST.test(facts.spec_sha256||'')||!DIGEST.test(facts.spec_approved_hash||'')||
      typeof facts.pass!=='boolean')fail('release-gate-facts');
    validateCoverage(facts.requirement_coverage);
    validateCoverage(facts.failure_matrix_coverage);break;
  case 'changed-js-syntax-v1':
    if(!exactKeys(facts,['changed_paths','checked_paths','failure_paths'])||
      !ids(facts.changed_paths)||!ids(facts.checked_paths)||!ids(facts.failure_paths)||
      facts.failure_paths.some((value)=>!facts.checked_paths.includes(value)))
      fail('release-gate-facts');break;
  case 'release-integrity-v1':
    if(!exactKeys(facts,['manifest_versions','package_version','runtime_version',
      'docs_rule_sha256','v7_surface_violations','git_state',
      'external_effect_operation_ids'])||
      !exactKeys(facts.manifest_versions,['claude','codex'])||
      ![facts.manifest_versions.claude,facts.manifest_versions.codex,
        facts.package_version,facts.runtime_version].every((value)=>SEMVER.test(value||''))||
      !DIGEST.test(facts.docs_rule_sha256||'')||!ids(facts.v7_surface_violations)||
      !exactKeys(facts.git_state,['head','branch','dirty','changed_paths'])||
      !/^[0-9a-f]{40}$/.test(facts.git_state.head||'')||
      typeof facts.git_state.branch!=='string'||!facts.git_state.branch||
      typeof facts.git_state.dirty!=='boolean'||!ids(facts.git_state.changed_paths)||
      !sortedUnique(facts.external_effect_operation_ids,(value)=>OPERATION.test(value)))
      fail('release-gate-facts');break;
  case 'single-review-v1':
    if(!exactKeys(facts,['point','finding_ref_sha256','review_execution_sha256',
      'blocking_ids'])||typeof facts.point!=='string'||!facts.point||
      !DIGEST.test(facts.finding_ref_sha256||'')||
      !DIGEST.test(facts.review_execution_sha256||'')||!ids(facts.blocking_ids))
      fail('release-gate-facts');break;
  case 'mutation-critical-path-v1':
    if(!exactKeys(facts,['round_result_refs','survived_count'])||
      !Array.isArray(facts.round_result_refs)||facts.round_result_refs.length===0||
      facts.round_result_refs.some((row)=>!commonLocator(row))||
      !Number.isSafeInteger(facts.survived_count)||facts.survived_count<0)
      fail('release-gate-facts');break;
  case 'rollback-rehearsal-v1':
    if(!exactKeys(facts,['rehearsal_result_ref','passed'])||
      !commonLocator(facts.rehearsal_result_ref)||typeof facts.passed!=='boolean')
      fail('release-gate-facts');break;
  case 'governed-health-v1':
    if(!exactKeys(facts,['health_report_sha256','required_missing','failed'])||
      !DIGEST.test(facts.health_report_sha256||'')||
      !ids(facts.required_missing)||!ids(facts.failed))fail('release-gate-facts');break;
  case 'governed-evidence-v1': {
    if(!exactKeys(facts,['package_sha256','required_ids','completed_ids',
      'missing_ids','invalidated_ids'])||!DIGEST.test(facts.package_sha256||'')||
      !ids(facts.required_ids)||!ids(facts.completed_ids)||!ids(facts.missing_ids)||
      !ids(facts.invalidated_ids))fail('release-gate-facts');
    const required=new Set(facts.required_ids),sets=[facts.completed_ids,
      facts.missing_ids,facts.invalidated_ids];
    if(sets.some((rows)=>rows.some((id)=>!required.has(id)))||
        new Set(sets.flat()).size!==sets.flat().length)fail('release-gate-facts');break;}
  case 'evidence-redaction-v1':
    if(!exactKeys(facts,['package_sha256','passed','violation_ids'])||
      !DIGEST.test(facts.package_sha256||'')||typeof facts.passed!=='boolean'||
      !ids(facts.violation_ids))fail('release-gate-facts');break;
  case 'dual-final-review-v1':
    if(!exactKeys(facts,['semantic_finding_ref_sha256',
      'executability_finding_ref_sha256','blocking_ids'])||
      !DIGEST.test(facts.semantic_finding_ref_sha256||'')||
      !DIGEST.test(facts.executability_finding_ref_sha256||'')||
      facts.semantic_finding_ref_sha256===facts.executability_finding_ref_sha256||
      !ids(facts.blocking_ids))fail('release-gate-facts');break;
  case 'human-ack-v1':
    if(!exactKeys(facts,['point','actor','at','ack_sha256'])||
      typeof facts.point!=='string'||!facts.point||typeof facts.actor!=='string'||
      !facts.actor||typeof facts.at!=='string'||!DIGEST.test(facts.ack_sha256||'')||
      Number.isNaN(Date.parse(facts.at))||new Date(facts.at).toISOString()!==facts.at)
      fail('release-gate-facts');break;
  default: fail('release-gate-checker');
  }
  return facts;
}
function computeBlockingCodes(checkerId,facts){
  validateFacts(checkerId,facts);const blockers=[];
  switch(checkerId){
  case 'spec-gate-v1':
    if(!facts.pass)blockers.push('spec-invalid');
    if(facts.requirement_coverage.ratio!==1)blockers.push('required-uncovered');
    if(facts.failure_matrix_coverage.ratio!==1)blockers.push('failure-uncovered');break;
  case 'changed-js-syntax-v1': {
    const expected=facts.changed_paths.filter((value)=>
      /\.(?:cjs|mjs|js|jsx|ts|tsx)$/.test(value));
    if(canonical(expected)!==canonical(facts.checked_paths))
      blockers.push('changed-path-mismatch');
    if(facts.failure_paths.length)blockers.push('syntax-failed');break;}
  case 'release-integrity-v1': {
    const versions=[facts.manifest_versions.claude,facts.manifest_versions.codex,
      facts.package_version,facts.runtime_version];
    if(new Set(versions).size!==1)blockers.push('version-mismatch');
    if(facts.v7_surface_violations.length)blockers.push('v7-surface-present');
    if(!facts.git_state.head||!facts.git_state.branch)blockers.push('git-state-invalid');
    if(facts.git_state.dirty||facts.git_state.changed_paths.length)
      blockers.push('git-dirty');
    if(facts.external_effect_operation_ids.length)blockers.push('external-effect-seen');break;}
  case 'single-review-v1':
    if(facts.blocking_ids.length)blockers.push('review-blocking');break;
  case 'mutation-critical-path-v1':
    if(facts.survived_count>0)blockers.push('mutation-survived');break;
  case 'rollback-rehearsal-v1':
    if(!facts.passed)blockers.push('rollback-failed');break;
  case 'governed-health-v1':
    if(facts.required_missing.length)blockers.push('health-missing');
    if(facts.failed.length)blockers.push('health-failed');break;
  case 'governed-evidence-v1':
    if(facts.missing_ids.length)blockers.push('evidence-missing');
    if(facts.invalidated_ids.length)blockers.push('evidence-invalidated');break;
  case 'evidence-redaction-v1':
    if(!facts.passed||facts.violation_ids.length)blockers.push('redaction-failed');break;
  case 'dual-final-review-v1':
    if(facts.blocking_ids.length)blockers.push('review-blocking');break;
  case 'human-ack-v1': break;
  }
  return blockers.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
}
function buildGateFactArtifact(checkerId,facts){
  validateFacts(checkerId,facts);
  return{schema_version:1,checker_id:checkerId,facts:structuredClone(facts),
    facts_sha256:semanticDigest(checkerId,facts)};
}
function validateGateFactArtifact(value){
  if(!exactKeys(value,['schema_version','checker_id','facts','facts_sha256'])||
      value.schema_version!==1||!Object.hasOwn(DETERMINISTIC_GATE_MAPPING,
        value.checker_id)||semanticDigest(value.checker_id,
        validateFacts(value.checker_id,value.facts))!==value.facts_sha256)
    fail('gate-fact-artifact');
  return{artifact:structuredClone(value),
    facts_artifact_sha256:journal.sha256(canonical(value)),
    blocking_codes:computeBlockingCodes(value.checker_id,value.facts)};
}
function argvSha256(argv){
  if(!Array.isArray(argv)||argv.some((value)=>typeof value!=='string'||/[\0\r\n]/.test(value)))
    fail('gate-result-argv');
  return journal.sha256(canonical(argv));
}
function sortInputRefs(refs){
  if(!Array.isArray(refs)||refs.some((row)=>!locator(row))||
      new Set(refs.map(locatorSortKey)).size!==refs.length)
    fail('gate-result-input');
  const sorted=[...refs].sort((a,b)=>Buffer.compare(Buffer.from(locatorSortKey(a)),
    Buffer.from(locatorSortKey(b))));
  if(canonical(sorted)!==canonical(refs))fail('gate-result-input');
  return structuredClone(refs);
}
function resultDigest(value){const copy=structuredClone(value);delete copy.result_sha256;
  return journal.sha256(canonical(copy));}
function buildDeterministicGateResult({sessionId,planAuthoritySha256,
  verificationPlanSha256,checkerId,gateIds,factsRef,artifact}={}){
  const checked=validateGateFactArtifact(artifact),blocking=checked.blocking_codes;
  if(!locator(factsRef)||factsRef.kind!=='gate-fact'||
      factsRef.sha256!==checked.facts_artifact_sha256||
      !Object.hasOwn(DETERMINISTIC_GATE_MAPPING,checkerId)||
      canonical(gateIds)!==canonical(DETERMINISTIC_GATE_MAPPING[checkerId]))
    fail('gate-result');
  const result={schema_version:1,session_id:sessionId,
    plan_authority_sha256:planAuthoritySha256,
    verification_plan_sha256:verificationPlanSha256,checker_id:checkerId,
    argv_sha256:argvSha256([]),gate_ids:[...gateIds],input_refs:[factsRef],
    status:blocking.length?'failed':'passed',result:{kind:'deterministic',
      facts_ref:factsRef,facts_sha256:artifact.facts_sha256,
      facts_artifact_sha256:checked.facts_artifact_sha256,
      passed:blocking.length===0,blocking_codes:blocking},result_sha256:null};
  result.result_sha256=resultDigest(result);return validateGateResult(result);
}
function buildCommandGateResult({sessionId,planAuthoritySha256,verificationPlanSha256,
  commandId,inputRefs,releaseEnvironmentSha256,processResult}={}){
  const catalog=RELEASE_GATE_CATALOG[commandId];
  if(!catalog||!DIGEST.test(releaseEnvironmentSha256||'')||
      !exactKeys(processResult,['exit_code','signal','timed_out','output_overflow',
        'stdout_sha256','stderr_sha256'])||
      !(processResult.exit_code===null||Number.isSafeInteger(processResult.exit_code))||
      !(processResult.signal===null||typeof processResult.signal==='string')||
      typeof processResult.timed_out!=='boolean'||
      typeof processResult.output_overflow!=='boolean'||
      !DIGEST.test(processResult.stdout_sha256||'')||
      !DIGEST.test(processResult.stderr_sha256||''))fail('gate-result');
  const passed=processResult.exit_code===0&&processResult.signal===null&&
    !processResult.timed_out&&!processResult.output_overflow;
  const result={schema_version:1,session_id:sessionId,
    plan_authority_sha256:planAuthoritySha256,
    verification_plan_sha256:verificationPlanSha256,checker_id:'command-v1',
    argv_sha256:argvSha256(catalog.argv),gate_ids:[...catalog.gate_ids],
    input_refs:sortInputRefs(inputRefs),status:passed?'passed':'failed',
    result:{kind:'command',release_environment_sha256:releaseEnvironmentSha256,
      ...structuredClone(processResult)},result_sha256:null};
  result.result_sha256=resultDigest(result);return validateGateResult(result);
}
function validateGateResult(value){
  const keys=['schema_version','session_id','plan_authority_sha256',
    'verification_plan_sha256','checker_id','argv_sha256','gate_ids',
    'input_refs','status','result','result_sha256'];
  if(!exactKeys(value,keys)||value.schema_version!==1||
      !/^s-[0-9a-f]{8}$/.test(value.session_id||'')||
      !DIGEST.test(value.plan_authority_sha256||'')||
      !DIGEST.test(value.verification_plan_sha256||'')||
      !DIGEST.test(value.argv_sha256||'')||
      !['passed','failed','unknown'].includes(value.status)||
      !DIGEST.test(value.result_sha256||'')||
      !sortedUnique(value.gate_ids,(id)=>/^GATE-[A-Za-z0-9-]+$/.test(id))||
      resultDigest(value)!==value.result_sha256)
    fail('gate-result');
  sortInputRefs(value.input_refs);
  if(value.checker_id==='command-v1'){
    const command=Object.values(RELEASE_GATE_CATALOG).find((row)=>
      row.argv&&argvSha256(row.argv)===value.argv_sha256);
    if(!command||canonical(command.gate_ids)!==canonical(value.gate_ids)||
        !exactKeys(value.result,['kind','release_environment_sha256','exit_code',
          'signal','timed_out','output_overflow','stdout_sha256','stderr_sha256'])||
        value.result.kind!=='command'||
        !DIGEST.test(value.result.release_environment_sha256||'')||
        !(value.result.exit_code===null||Number.isSafeInteger(value.result.exit_code))||
        !(value.result.signal===null||typeof value.result.signal==='string')||
        typeof value.result.timed_out!=='boolean'||
        typeof value.result.output_overflow!=='boolean'||
        !DIGEST.test(value.result.stdout_sha256||'')||
        !DIGEST.test(value.result.stderr_sha256||''))fail('gate-result');
    const passed=value.result.exit_code===0&&value.result.signal===null&&
      !value.result.timed_out&&!value.result.output_overflow;
    if(value.status!==(passed?'passed':'failed'))fail('gate-result');
  }else{
    if(!Object.hasOwn(DETERMINISTIC_GATE_MAPPING,value.checker_id)||
        canonical(value.gate_ids)!==canonical(
          DETERMINISTIC_GATE_MAPPING[value.checker_id])||
        value.argv_sha256!==argvSha256([])||
        value.input_refs.length!==1||value.input_refs[0].kind!=='gate-fact'||
        !exactKeys(value.result,['kind','facts_ref','facts_sha256',
          'facts_artifact_sha256','passed','blocking_codes'])||
        value.result.kind!=='deterministic'||
        canonical(value.result.facts_ref)!==canonical(value.input_refs[0])||
        !DIGEST.test(value.result.facts_sha256||'')||
        value.result.facts_artifact_sha256!==value.input_refs[0].sha256||
        typeof value.result.passed!=='boolean'||
        !sortedUnique(value.result.blocking_codes,
          (code)=>typeof code==='string'&&code.length>0)||
        value.status!==(value.result.passed?'passed':'failed')||
        value.result.passed!==(value.result.blocking_codes.length===0))
      fail('gate-result');
  }
  return structuredClone(value);
}
function validateGateResultRef(value){
  if(!exactKeys(value,['gate_id','operation_id','result_path','result_sha256',
      'ledger_result_sha256','checker_id','argv_sha256'])||
      !/^GATE-[A-Za-z0-9-]+$/.test(value.gate_id||'')||
      !OPERATION.test(value.operation_id||'')||!portable(value.result_path)||
      !DIGEST.test(value.result_sha256||'')||
      !DIGEST.test(value.ledger_result_sha256||'')||
      !(value.checker_id==='command-v1'||
        Object.hasOwn(DETERMINISTIC_GATE_MAPPING,value.checker_id))||
      !DIGEST.test(value.argv_sha256||''))
    fail('gate-result-ref');
  return structuredClone(value);
}
function readCanonical(file,code){
  let stat,bytes;try{stat=fs.lstatSync(file);bytes=fs.readFileSync(file);}catch{
    fail(code);}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)fail(code);
  let value;try{value=JSON.parse(bytes);}catch{fail(code);}
  if(!bytes.equals(Buffer.from(canonical(value))))fail(code);
  return{value,bytes,sha256:journal.sha256(bytes)};
}
function writeExclusive(file,value,code){
  const bytes=Buffer.from(canonical(value));fs.mkdirSync(path.dirname(file),{recursive:true});
  let fd;try{fd=fs.openSync(file,fs.constants.O_CREAT|fs.constants.O_EXCL|
    fs.constants.O_WRONLY,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}
  catch(error){if(error.code!=='EEXIST'||!fs.readFileSync(file).equals(bytes))
    fail(code);}finally{if(fd!==undefined)fs.closeSync(fd);}
  if(!fs.readFileSync(file).equals(bytes))fail(code);
  return journal.sha256(bytes);
}
function releaseReceiptTargetLocks({root,planPath,receiptPath}={}){
  if(typeof root!=='string'||!root||typeof planPath!=='string'||
      typeof receiptPath!=='string')fail('release-verification-locks');
  const targets=[planPath,receiptPath].sort((a,b)=>Buffer.compare(
    Buffer.from(a),Buffer.from(b)));
  return targets.map((target)=>({rank:transaction.RANKS.target,
    capability:platform.issueProjectStateCapability(root,path.join(root,'.claude',
      `deep-work.target.${journal.sha256(path.relative(root,target))}.lock`),
      {allowMissingLeaf:true,role:'lock'})})).sort((a,b)=>Buffer.compare(
        Buffer.from(a.capability.path),Buffer.from(b.capability.path)));
}
async function replaceInvalidatedReleaseReceipt({stateCapability,current,fields,
  sliceId,relative,receipt}={}){
  const root=stateCapability.projectRoot,file=path.join(root,...relative.split('/'));
  if(!fs.existsSync(file))return false;
  const existingRecord=readCanonical(file,'release-verification-receipt');
  const rawExisting=existingRecord.value;
  if(rawExisting.status!=='invalidated')return false;
  let existing;
  try{existing=reconstructInvalidatedReleaseReceipt(rawExisting);}
  catch{fail('release-verification-receipt');}
  if(existing.slice_id!==sliceId||
      existing.plan_authority_sha256!==current.plan_authority_sha256||
      existing.verification_plan_sha256!==fields.verification_plan_sha256||
      !DIGEST.test(existing.receipt_sha256||'')||
      !Array.isArray(existing.gate_results)||
      !Array.isArray(existing.functional_receipts))
    fail('release-verification-receipt');
  if(existing.receipt_sha256===receipt.receipt_sha256||
      existing.completion_operation_id===receipt.completion_operation_id)
    fail('release-verification-recovery-required');
  const nextBytes=Buffer.from(canonical(receipt));
  const workDir=path.join(root,...String(fields.work_dir).split('/'));
  const sessionCapability=platform.issueProjectStateCapability(root,workDir,
    {role:'session-work-dir',sessionStateCapability:stateCapability});
  const capability=transaction.issueSessionFileCapability({sessionCapability,
    candidate:file,allowedBasenames:[path.basename(file)],
    role:'release-verification-receipt'});
  // The caller has authenticated a new gate-result identity. The ranked target
  // lock serializes invalidation and replacement; this byte comparison rejects
  // any state drift observed before the atomic rename.
  if(!fs.readFileSync(file).equals(existingRecord.bytes))
    fail('release-verification-receipt');
  transaction.atomicWriteSessionFile(capability,nextBytes);
  if(!fs.readFileSync(file).equals(nextBytes))fail('release-verification-receipt');
  return true;
}
function loadPlan(planCapability,plan){
  transaction.revalidateSessionFile(planCapability);
  let current;try{current=JSON.parse(transaction.readSessionFile(planCapability));}
  catch{fail('gate-plan');}
  if(canonical(current)!==canonical(plan)||current.contract_binding?.mode!=='strict-spec')
    fail('gate-plan');
  const authority=planRuntime.compileImmutablePlanAuthorityV2(current);
  if(authority.plan_authority_sha256!==current.plan_authority_sha256)
    fail('gate-plan');
  return current;
}
function producerBindsInputRef({producer,ref,planAuthoritySha256,
  verificationPlanSha256}={}){
  const result=producer?.result;
  if(!result||typeof result!=='object'||Array.isArray(result))return false;
  if(exactKeys(result,['input_kind','input_path','input_sha256',
    'plan_authority_sha256','verification_plan_sha256']))
    return result.input_kind===ref.kind&&result.input_path===ref.path&&
      result.input_sha256===ref.sha256&&
      result.plan_authority_sha256===planAuthoritySha256&&
      result.verification_plan_sha256===verificationPlanSha256;
  if(['finding-ref','semantic-finding-ref','executability-finding-ref']
    .includes(ref.kind))
    return result.finding_ref_path===ref.path&&
      result.finding_ref_artifact_sha256===ref.sha256&&
      result.plan_authority_sha256===planAuthoritySha256;
  const pairs=[['result_path','result_sha256'],
    ['artifact_path','artifact_sha256'],['package_ref','package_sha256'],
    ['receipt_path','receipt_sha256'],['path','sha256']];
  return pairs.some(([pathKey,digestKey])=>
    result[pathKey]===ref.path&&result[digestKey]===ref.sha256);
}
async function authenticateInputRefs({stateCapability,plan,checkerId,inputRefs}){
  const refs=validateCheckerInputRefs(checkerId,inputRefs);
  const project=transaction.projectCapabilityFor(stateCapability);
  const sessionId=transaction.sessionIdFromState(stateCapability),rows=[];
  const fields=frontmatter.parseFrontmatter(
    fs.readFileSync(stateCapability.path,'utf8')).fields;
  const specInputs=checkerId==='spec-gate-v1'?{
    'spec-approval':{spec_approved_hash:fields.spec_approved_hash},
    'spec-contract':parseStateJson(fields.spec_contract_json,
      'gate-input-spec-contract'),
    'spec-gate-result':parseStateJson(fields.spec_gate_result_json,
      'gate-input-spec-gate-result')}:{};
  for(const ref of refs){
    const target=path.resolve(stateCapability.projectRoot,...ref.path.split('/'));
    if(!require('./platform.js').isPathInside(stateCapability.projectRoot,target))
      fail('gate-input-ref');
    const raw=readCanonical(target,'gate-input-ref');
    if(raw.sha256!==ref.sha256)fail('gate-input-ref');
    const producer=await journal.resumeOperation({projectCapability:project,
      operationId:ref.producer_operation_id,sessionId});
    if(producer.stage!=='completed-ledger'||
        !INPUT_PRODUCER_KINDS[ref.kind]?.includes(producer.kind))
      fail('gate-input-producer');
    if(Object.hasOwn(specInputs,ref.kind)){
      const expectedPath=`.deep-work/${sessionId}/release-inputs/${
        ref.kind}.json`;
      const result=producer.result;
      if(ref.path!==expectedPath||
          ref.producer_operation_id!==fields.spec_approval_operation_id||
          producer.kind!=='phase-approval'||
          !exactKeys(result,['status','statePath','stateSha256',
            'patchSha256'])||result.status!=='completed'||
          result.statePath!==stateCapability.path||
          !DIGEST.test(result.stateSha256||'')||
          !DIGEST.test(result.patchSha256||'')||
          canonical(raw.value)!==canonical(specInputs[ref.kind]))
        fail('gate-input-producer');
    }else if(!producerBindsInputRef({producer,ref,
      planAuthoritySha256:plan.plan_authority_sha256,
      verificationPlanSha256:fields.verification_plan_sha256}))
      fail('gate-input-producer');
    rows.push({ref,raw,producer});
  }
  return rows;
}
function parseStateJson(value,code){
  try{const parsed=typeof value==='string'?JSON.parse(value):value;
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail(code);
    return parsed;}
  catch(error){if(error.code===code)throw error;fail(code);}
}
function coverageFrom(value,code){
  const row=value?.contract||value;
  try{return structuredClone(validateCoverage(row));}catch{fail(code);}
}
function deriveFacts(checkerId,rows){
  const byKind=new Map(rows.map((row)=>[row.ref.kind,row.raw.value]));
  if(checkerId==='spec-gate-v1'){
    const approval=byKind.get('spec-approval'),contract=byKind.get('spec-contract');
    const gate=byKind.get('spec-gate-result');
    let specSha256=contract?.spec_sha256;
    if(!DIGEST.test(specSha256||'')){
      try{specSha256=require('./contract-runtime.js').specContractDigest(contract);}
      catch{fail('gate-fact-compute');}
    }
    const facts={spec_sha256:specSha256,
      spec_approved_hash:approval?.spec_approved_hash,
      requirement_coverage:coverageFrom(gate?.requirement_coverage,
        'gate-fact-compute'),
      failure_matrix_coverage:coverageFrom(gate?.failure_matrix_coverage,
        'gate-fact-compute'),pass:gate?.pass===true};
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='release-integrity-v1'){
    const claude=byKind.get('claude-manifest'),codex=byKind.get('codex-manifest'),
      pkg=byKind.get('package-manifest'),runtime=byKind.get('runtime-version'),
      git=byKind.get('git-snapshot'),external=byKind.get('external-operation-index'),
      docs=byKind.get('docs-rule');
    const facts={manifest_versions:{claude:claude?.version,codex:codex?.version},
      package_version:pkg?.version,runtime_version:runtime?.version,
      docs_rule_sha256:docs?.docs_rule_sha256,
      v7_surface_violations:runtime?.v7_surface_violations||[],
      git_state:git,external_effect_operation_ids:external?.operation_ids||[]};
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='single-review-v1'){
    const ref=byKind.get('finding-ref'),execution=byKind.get('review-execution');
    const facts={point:ref?.finding_ref?.point||ref?.point,
      finding_ref_sha256:ref?.finding_ref_sha256,
      review_execution_sha256:execution?.review_execution_sha256,
      blocking_ids:execution?.blocking_ids||[]};
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='mutation-critical-path-v1'){
    const facts={round_result_refs:rows.map((row)=>row.ref),
      survived_count:rows.reduce((sum,row)=>sum+(row.raw.value.survived_count||0),0)};
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='rollback-rehearsal-v1'){
    const row=rows[0],facts={rehearsal_result_ref:row.ref,
      passed:row.raw.value.passed===true};
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='governed-health-v1'){
    const value=byKind.get('health-report'),facts={
      health_report_sha256:value.health_report_sha256,
      required_missing:value.required_missing||[],failed:value.failed||[]};
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='governed-evidence-v1'){
    const pkg=byKind.get('evidence-package'),verification=
      byKind.get('verification-plan');
    const facts={package_sha256:pkg.package_sha256,
      required_ids:verification.required_gate_ids,
      completed_ids:pkg.completed_ids||[],missing_ids:pkg.missing_ids||[],
      invalidated_ids:pkg.invalidated_ids||[]};
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='evidence-redaction-v1'){
    const pkg=byKind.get('evidence-package'),policy=byKind.get('redaction-policy');
    const violations=policy.violation_ids||[];
    const facts={package_sha256:pkg.package_sha256,
      passed:policy.passed===true,violation_ids:violations};
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='dual-final-review-v1'){
    const semantic=byKind.get('semantic-finding-ref'),
      executable=byKind.get('executability-finding-ref'),
      semanticRun=byKind.get('semantic-review-execution'),
      executableRun=byKind.get('executability-review-execution');
    const facts={semantic_finding_ref_sha256:semantic.finding_ref_sha256,
      executability_finding_ref_sha256:executable.finding_ref_sha256,
      blocking_ids:[...(semanticRun.blocking_ids||[]),
        ...(executableRun.blocking_ids||[])].sort((a,b)=>
        Buffer.compare(Buffer.from(a),Buffer.from(b)))};
    if(new Set(facts.blocking_ids).size!==facts.blocking_ids.length)
      fail('gate-fact-compute');
    validateFacts(checkerId,facts);return facts;
  }
  if(checkerId==='human-ack-v1'){
    const value=byKind.get('human-ack'),facts={point:value.point,
      actor:value.actor,at:value.at,ack_sha256:value.ack_sha256};
    validateFacts(checkerId,facts);return facts;
  }
  fail('gate-fact-compute');
}
async function publishGateFact({stateCapability,planCapability,plan,checkerId,
  inputRefs,seam}={}){
  const current=loadPlan(planCapability,plan),sid=
    transaction.sessionIdFromState(stateCapability);
  const fields=frontmatter.parseFrontmatter(
    fs.readFileSync(stateCapability.path,'utf8')).fields;
  if(!DIGEST.test(fields.verification_plan_sha256||''))
    fail('gate-verification-plan');
  const refs=validateCheckerInputRefs(checkerId,inputRefs);
  const preconditions={session_id:sid,plan_authority_sha256:
    current.plan_authority_sha256,verification_plan_sha256:
    fields.verification_plan_sha256,checker_id:checkerId,input_refs:refs};
  const id=operationId('gate-fact-publish-v1',preconditions);
  const project=transaction.projectCapabilityFor(stateCapability);
  const existing=await journal.resumeOperation({projectCapability:project,
    operationId:id,sessionId:sid,kind:'gate-fact-publish'}).catch((error)=>{
      if(error.code==='operation-not-found')return null;throw error;});
  if(existing?.stage==='completed-ledger'){
    const raw=readCanonical(path.join(stateCapability.projectRoot,
      ...existing.result.facts_path.split('/')),'gate-fact-replay');
    const checked=validateGateFactArtifact(raw.value);
    if(raw.sha256!==existing.result.facts_artifact_sha256||
        checked.artifact.facts_sha256!==existing.result.facts_sha256)
      fail('gate-fact-replay');
    return{...existing.result,operation_id:id,operation_receipt:existing,
      adopted:true};
  }
  const rows=await authenticateInputRefs({stateCapability,plan:current,
    checkerId,inputRefs:refs});
  const operation=await journal.beginOperation({projectCapability:project,
    sessionId:sid,kind:'gate-fact-publish',operationId:id,
    preconditions});
  await journal.recordOperationStage(operation,'authority-authenticated',{owned:{
    planAuthoritySha256:current.plan_authority_sha256,
    verificationPlanSha256:fields.verification_plan_sha256}});
  const facts=deriveFacts(checkerId,rows);
  const artifact=buildGateFactArtifact(checkerId,facts);
  const validated=validateGateFactArtifact(artifact);
  await journal.recordOperationStage(operation,'facts-computed',{owned:{
    facts,factsSha256:artifact.facts_sha256,
    factsArtifactSha256:validated.facts_artifact_sha256,
    artifactBytesBase64:Buffer.from(canonical(artifact)).toString('base64')}});
  const relative=`.deep-work/${sid}/gate-facts/${checkerId}-${
    artifact.facts_sha256}.json`;
  seam?.('before-gate-fact-write',{operationId:id,path:relative});
  const artifactSha256=writeExclusive(path.join(stateCapability.projectRoot,
    ...relative.split('/')),artifact,'gate-fact-publish');
  if(artifactSha256!==validated.facts_artifact_sha256)fail('gate-fact-publish');
  await journal.recordOperationStage(operation,'fact-published',{owned:{
    factsPath:relative,factsSha256:artifact.facts_sha256,
    factsArtifactSha256:artifactSha256}});
  const receipt=await journal.completeOperation(operation,{checker_id:checkerId,
    input_refs:refs,facts_path:relative,facts_sha256:artifact.facts_sha256,
    facts_artifact_sha256:artifactSha256,
    plan_authority_sha256:current.plan_authority_sha256,
    verification_plan_sha256:fields.verification_plan_sha256});
  return{...receipt.result,operation_id:id,operation_receipt:receipt,
    adopted:false};
}
async function publishReleaseInputArtifact({stateCapability,plan,
  verificationPlanSha256,inputKind,value}={}){
  if(!INPUT_PRODUCER_KINDS[inputKind]?.includes('release-input-publish')||
      !value||typeof value!=='object'||Array.isArray(value))
    fail('release-input-publish');
  const sid=transaction.sessionIdFromState(stateCapability);
  const bytes=Buffer.from(canonical(value)),inputSha256=journal.sha256(bytes);
  const preconditions={session_id:sid,input_kind:inputKind,
    input_sha256:inputSha256,plan_authority_sha256:
      plan.plan_authority_sha256,verification_plan_sha256:
      verificationPlanSha256};
  const id=operationId('release-input-publish-v1',preconditions);
  const relative=`.deep-work/${sid}/release-inputs/${inputKind}-${
    inputSha256}.json`;
  const project=transaction.projectCapabilityFor(stateCapability);
  const existing=await journal.resumeOperation({projectCapability:project,
    operationId:id,sessionId:sid,kind:'release-input-publish'}).catch((error)=>{
      if(error.code==='operation-not-found')return null;throw error;});
  const terminal={input_kind:inputKind,input_path:relative,
    input_sha256:inputSha256,plan_authority_sha256:
      plan.plan_authority_sha256,verification_plan_sha256:
      verificationPlanSha256};
  if(existing?.stage==='completed-ledger'){
    const raw=readCanonical(path.join(stateCapability.projectRoot,
      ...relative.split('/')),'release-input-replay');
    if(canonical(existing.result)!==canonical(terminal)||
        raw.sha256!==inputSha256||!raw.bytes.equals(bytes))
      fail('release-input-replay');
    return{ref:{kind:inputKind,path:relative,sha256:inputSha256,
      producer_operation_id:id},operation_receipt:existing,adopted:true};
  }
  const operation=await journal.beginOperation({projectCapability:project,
    sessionId:sid,kind:'release-input-publish',operationId:id,preconditions});
  writeExclusive(path.join(stateCapability.projectRoot,...relative.split('/')),
    value,'release-input-publish');
  await journal.recordOperationStage(operation,'input-published',{owned:{
    inputKind,path:relative,sha256:inputSha256}});
  const receipt=await journal.completeOperation(operation,terminal);
  return{ref:{kind:inputKind,path:relative,sha256:inputSha256,
    producer_operation_id:id},operation_receipt:receipt,adopted:false};
}
function parseReleaseGitStatus(bytes){
  const records=bytes.toString('utf8').split('\0').filter(Boolean),paths=[];
  for(let index=0;index<records.length;index++){
    const record=records[index];
    if(record.length<4||record[2]!==' ')fail('release-integrity-git');
    const status=record.slice(0,2),candidate=record.slice(3);
    if(!portable(candidate))fail('release-integrity-git');
    paths.push(candidate);
    if(/[RC]/.test(status)&&records[index+1]){
      const source=records[++index];if(!portable(source))
        fail('release-integrity-git');
      paths.push(source);
    }
  }
  return[...new Set(paths)].sort((a,b)=>
    Buffer.compare(Buffer.from(a),Buffer.from(b)));
}
function readReleaseJson(file,code){
  let stat,bytes,value;try{stat=fs.lstatSync(file);bytes=fs.readFileSync(file);
    value=JSON.parse(bytes);}catch{fail(code);}
  if(!stat.isFile()||stat.isSymbolicLink()||
      !value||typeof value!=='object'||Array.isArray(value))fail(code);
  return value;
}
function releaseDocsRulePath(root,toolchain){
  const local=path.join(root,'docs','DOCS_RULE.md');
  if(fs.existsSync(local))return local;
  const raw=toolchain.runAuthenticatedGit({root,
    args:['rev-parse','--git-common-dir']}).toString('utf8').trim();
  const common=path.resolve(root,raw),main=path.dirname(fs.realpathSync(common));
  const fallback=path.join(main,'docs','DOCS_RULE.md');
  if(!fs.existsSync(fallback))fail('release-integrity-docs-rule');
  return fallback;
}
function legacyV7SurfaceViolations({activeVersion,versions}={}){
  const activeMajor=Number.parseInt(String(activeVersion).split('.')[0],10);
  if(!Number.isSafeInteger(activeMajor)||activeMajor>=7||!Array.isArray(versions))
    return[];
  return versions.filter(([,version])=>/^7\./.test(String(version)))
    .map(([file])=>file).sort((a,b)=>Buffer.compare(Buffer.from(a),
      Buffer.from(b)));
}
function releaseIntegrityValues({stateCapability}={}){
  const root=stateCapability.projectRoot;
  const toolchain=require('./release-toolchain-runtime.js');
  const claude=readReleaseJson(path.join(root,'.claude-plugin','plugin.json'),
    'release-integrity-manifest');
  const codex=readReleaseJson(path.join(root,'.codex-plugin','plugin.json'),
    'release-integrity-manifest');
  const pkg=readReleaseJson(path.join(root,'package.json'),
    'release-integrity-manifest');
  const docsPath=releaseDocsRulePath(root,toolchain),docsStat=
    fs.lstatSync(docsPath),docsBytes=fs.readFileSync(docsPath);
  if(!docsStat.isFile()||docsStat.isSymbolicLink())
    fail('release-integrity-docs-rule');
  const head=toolchain.runAuthenticatedGit({root,
    args:['rev-parse','--verify','HEAD^{commit}']}).toString('utf8').trim();
  const branch=toolchain.runAuthenticatedGit({root,
    args:['symbolic-ref','--short','HEAD']}).toString('utf8').trim();
  const changed=parseReleaseGitStatus(toolchain.runAuthenticatedGit({root,
    args:['status','--porcelain=v1','-z','--untracked-files=all']}))
    .filter((candidate)=>!require('./git-runtime.js').isRuntimePath(candidate)&&
      candidate!=='reviews'&&!candidate.startsWith('reviews/'));
  if(!/^[0-9a-f]{40}$/.test(head)||!branch)fail('release-integrity-git');
  const versions=[['.claude-plugin/plugin.json',claude.version],
    ['.codex-plugin/plugin.json',codex.version],['package.json',pkg.version]];
  const v7=legacyV7SurfaceViolations({activeVersion:pkg.version,versions});
  const external=journal.inspectExternalEffectOperationIds({
    projectCapability:transaction.projectCapabilityFor(stateCapability),
    sessionId:transaction.sessionIdFromState(stateCapability)});
  return{'claude-manifest':{version:claude.version},
    'codex-manifest':{version:codex.version},
    'docs-rule':{docs_rule_sha256:journal.sha256(docsBytes)},
    'external-operation-index':{operation_ids:external},
    'git-snapshot':{head,branch,dirty:changed.length>0,changed_paths:changed},
    'package-manifest':{version:pkg.version},
    'runtime-version':{version:pkg.version,v7_surface_violations:v7}};
}
async function publishReleaseIntegrityGateResult({stateCapability,
  planCapability,plan}={}){
  const current=loadPlan(planCapability,plan);
  const fields=frontmatter.parseFrontmatter(
    fs.readFileSync(stateCapability.path,'utf8')).fields;
  if(!DIGEST.test(fields.verification_plan_sha256||''))
    fail('gate-verification-plan');
  const values=releaseIntegrityValues({stateCapability}),refs=[];
  for(const kind of CHECKER_INPUT_CATALOG['release-integrity-v1']){
    const published=await publishReleaseInputArtifact({stateCapability,
      plan:current,verificationPlanSha256:fields.verification_plan_sha256,
      inputKind:kind,value:values[kind]});
    refs.push(published.ref);
  }
  refs.sort((left,right)=>Buffer.compare(Buffer.from(locatorSortKey(left)),
    Buffer.from(locatorSortKey(right))));
  const fact=await publishGateFact({stateCapability,planCapability,
    plan:current,checkerId:'release-integrity-v1',inputRefs:refs});
  return publishDeterministicGateResult({stateCapability,planCapability,
    plan:current,factOperationId:fact.operation_id});
}
function gateResultRefs({result,operationId:resultOperationId,resultPath,
  ledgerResultSha256}={}){
  validateGateResult(result);
  if(!OPERATION.test(resultOperationId||'')||!portable(resultPath)||
      !DIGEST.test(ledgerResultSha256||''))fail('gate-result-ref');
  return result.gate_ids.map((gateId)=>validateGateResultRef({gate_id:gateId,
    operation_id:resultOperationId,result_path:resultPath,
    result_sha256:result.result_sha256,
    ledger_result_sha256:ledgerResultSha256,checker_id:result.checker_id,
    argv_sha256:result.argv_sha256}));
}
async function publishDeterministicGateResult({stateCapability,planCapability,plan,
  factOperationId,seam}={}){
  const current=loadPlan(planCapability,plan),sid=
    transaction.sessionIdFromState(stateCapability);
  const fields=frontmatter.parseFrontmatter(
    fs.readFileSync(stateCapability.path,'utf8')).fields;
  const project=transaction.projectCapabilityFor(stateCapability);
  const factReceipt=await journal.resumeOperation({projectCapability:project,
    operationId:factOperationId,sessionId:sid,kind:'gate-fact-publish'});
  const factTerminal=factReceipt.result;
  if(factReceipt.stage!=='completed-ledger'||!exactKeys(factTerminal,
      ['checker_id','input_refs','facts_path','facts_sha256',
        'facts_artifact_sha256','plan_authority_sha256',
        'verification_plan_sha256'])||
      factTerminal.plan_authority_sha256!==current.plan_authority_sha256||
      factTerminal.verification_plan_sha256!==fields.verification_plan_sha256)
    fail('release-gate-fact');
  const raw=readCanonical(path.join(stateCapability.projectRoot,
    ...factTerminal.facts_path.split('/')),'release-gate-fact');
  const validated=validateGateFactArtifact(raw.value);
  if(raw.sha256!==factTerminal.facts_artifact_sha256||
      raw.value.facts_sha256!==factTerminal.facts_sha256||
      raw.value.checker_id!==factTerminal.checker_id)
    fail('release-gate-fact');
  const factRef={kind:'gate-fact',path:factTerminal.facts_path,
    sha256:factTerminal.facts_artifact_sha256,
    producer_operation_id:factOperationId};
  const gateIds=DETERMINISTIC_GATE_MAPPING[factTerminal.checker_id];
  if(!gateIds)fail('release-gate-fact');
  const preconditions={session_id:sid,plan_authority_sha256:
    current.plan_authority_sha256,verification_plan_sha256:
    fields.verification_plan_sha256,checker_id:factTerminal.checker_id,
  argv_sha256:argvSha256([]),gate_ids:gateIds,input_refs:[factRef],
  release_environment_sha256:null};
  const id=operationId('release-gate-result-v1',preconditions);
  const existing=await journal.resumeOperation({projectCapability:project,
    operationId:id,sessionId:sid,kind:'release-gate-result'}).catch((error)=>{
      if(error.code==='operation-not-found')return null;throw error;});
  if(existing?.stage==='completed-ledger'){
    const replayRaw=readCanonical(path.join(stateCapability.projectRoot,
      ...existing.result.result_path.split('/')),'release-gate-result-replay');
    const replayResult=validateGateResult(replayRaw.value);
    if(replayResult.result_sha256!==existing.result.result_sha256)
      fail('release-gate-result-replay');
    return{...existing.result,operation_id:id,operation_receipt:existing,
      gate_result_refs:gateResultRefs({result:replayResult,operationId:id,
        resultPath:existing.result.result_path,
        ledgerResultSha256:existing.resultSha256}),adopted:true};
  }
  const operation=await journal.beginOperation({projectCapability:project,
    sessionId:sid,kind:'release-gate-result',operationId:id,preconditions});
  await journal.recordOperationStage(operation,'inputs-authenticated',{owned:{
    factOperationId,factLedgerResultSha256:factReceipt.resultSha256,
    factsArtifactSha256:validated.facts_artifact_sha256}});
  const result=buildDeterministicGateResult({sessionId:sid,
    planAuthoritySha256:current.plan_authority_sha256,
    verificationPlanSha256:fields.verification_plan_sha256,
    checkerId:factTerminal.checker_id,gateIds,factsRef:factRef,
    artifact:raw.value});
  await journal.recordOperationStage(operation,'checker-completed',{owned:{
    status:result.status,resultSha256:result.result_sha256,
    blockingCodes:result.result.blocking_codes}});
  const relative=`.deep-work/${sid}/gate-results/${id}.json`;
  seam?.('before-gate-result-write',{operationId:id,path:relative});
  writeExclusive(path.join(stateCapability.projectRoot,
    ...relative.split('/')),result,'release-gate-result-publish');
  await journal.recordOperationStage(operation,'result-published',{owned:{
    resultPath:relative,resultSha256:result.result_sha256,status:result.status}});
  const receipt=await journal.completeOperation(operation,{checker_id:
    result.checker_id,gate_ids:result.gate_ids,input_refs:result.input_refs,
  result_path:relative,result_sha256:result.result_sha256,status:result.status});
  return{...receipt.result,operation_id:id,operation_receipt:receipt,
    gate_result_refs:gateResultRefs({result,operationId:id,resultPath:relative,
      ledgerResultSha256:receipt.resultSha256}),adopted:false};
}
async function publishCommandGateResult({stateCapability,planCapability,plan,
  commandId,seam}={}){
  const current=loadPlan(planCapability,plan),sid=
    transaction.sessionIdFromState(stateCapability);
  const fields=frontmatter.parseFrontmatter(
    fs.readFileSync(stateCapability.path,'utf8')).fields;
  if(!DIGEST.test(fields.verification_plan_sha256||'')||
      !Object.hasOwn(RELEASE_GATE_CATALOG,commandId))
    fail('release-command-gate');
  const toolchain=require('./release-toolchain-runtime.js');
  const source=await toolchain.publishReleaseSourceGraph({
    stateCapability,cwd:stateCapability.projectRoot});
  const sourceReceipt=source.operation_receipt;
  if(sourceReceipt?.stage!=='completed-ledger'||
      sourceReceipt.kind!=='release-source-graph-publish'||
      sourceReceipt.result?.source_graph_path!==source.graph_ref.path||
      sourceReceipt.result?.source_graph_artifact_sha256!==
        source.graph_ref.sha256||
      sourceReceipt.result?.source_graph_sha256!==
        source.graph.source_graph_sha256)
    fail('release-command-source-graph');
  const entries=[...toolchain.resolveReleaseToolIdentities(source.required_tools),
    ...toolchain.resolveOptionalReleaseToolIdentities(source.optional_tools)]
    .sort((left,right)=>Buffer.compare(Buffer.from(left.name),
      Buffer.from(right.name)));
  const inputRefs=[source.graph_ref];
  const catalog=RELEASE_GATE_CATALOG[commandId];
  const preconditions={session_id:sid,plan_authority_sha256:
    current.plan_authority_sha256,verification_plan_sha256:
    fields.verification_plan_sha256,checker_id:'command-v1',
  argv_sha256:argvSha256(catalog.argv),gate_ids:[...catalog.gate_ids],
  input_refs:inputRefs,source_graph_sha256:source.graph.source_graph_sha256,
  tool_identities:entries};
  const id=operationId('release-gate-result-v1',preconditions);
  const project=transaction.projectCapabilityFor(stateCapability);
  const existing=await journal.resumeOperation({projectCapability:project,
    operationId:id,sessionId:sid,kind:'release-gate-result'}).catch((error)=>{
      if(error.code==='operation-not-found')return null;throw error;});
  if(existing?.stage==='completed-ledger'){
    if(!exactKeys(existing.result,['checker_id','gate_ids','input_refs',
      'result_path','result_sha256','status'])||
        canonical(existing.result.input_refs)!==canonical(inputRefs))
      fail('release-gate-result-replay');
    const replayRaw=readCanonical(path.join(stateCapability.projectRoot,
      ...existing.result.result_path.split('/')),'release-gate-result-replay');
    const replayResult=validateGateResult(replayRaw.value);
    if(replayResult.result_sha256!==existing.result.result_sha256||
        replayResult.argv_sha256!==argvSha256(catalog.argv)||
        replayResult.plan_authority_sha256!==current.plan_authority_sha256||
        replayResult.verification_plan_sha256!==
          fields.verification_plan_sha256)
      fail('release-gate-result-replay');
    return{...existing.result,operation_id:id,operation_receipt:existing,
      gate_result_refs:gateResultRefs({result:replayResult,operationId:id,
        resultPath:existing.result.result_path,
        ledgerResultSha256:existing.resultSha256}),adopted:true};
  }
  const operation=await journal.beginOperation({projectCapability:project,
    sessionId:sid,kind:'release-gate-result',operationId:id,preconditions});
  await journal.recordOperationStage(operation,'inputs-authenticated',{owned:{
    sourceGraphOperationId:source.operation_id,
    sourceGraphLedgerResultSha256:sourceReceipt.resultSha256,
    sourceGraphSha256:source.graph.source_graph_sha256,
    toolIdentitySetSha256:journal.sha256(canonical(entries))}});
  const execution=await toolchain.executeCatalogCommand({commandId,
    cwd:stateCapability.projectRoot,sourceGraphRef:source.graph_ref,
    sourceGraphSha256:source.graph.source_graph_sha256,entries});
  const result=buildCommandGateResult({sessionId:sid,
    planAuthoritySha256:current.plan_authority_sha256,
    verificationPlanSha256:fields.verification_plan_sha256,commandId,
    inputRefs,releaseEnvironmentSha256:
      execution.release_environment_sha256,
    processResult:execution.process_result});
  await journal.recordOperationStage(operation,'checker-completed',{owned:{
    status:result.status,resultSha256:result.result_sha256,
    releaseEnvironmentSha256:execution.release_environment_sha256,
    stdoutSha256:execution.process_result.stdout_sha256,
    stderrSha256:execution.process_result.stderr_sha256}});
  const relative=`.deep-work/${sid}/gate-results/${id}.json`;
  seam?.('before-gate-result-write',{operationId:id,path:relative});
  writeExclusive(path.join(stateCapability.projectRoot,
    ...relative.split('/')),result,'release-gate-result-publish');
  await journal.recordOperationStage(operation,'result-published',{owned:{
    resultPath:relative,resultSha256:result.result_sha256,status:result.status}});
  const receipt=await journal.completeOperation(operation,{checker_id:
    result.checker_id,gate_ids:result.gate_ids,input_refs:result.input_refs,
  result_path:relative,result_sha256:result.result_sha256,status:result.status});
  return{...receipt.result,operation_id:id,operation_receipt:receipt,
    gate_result_refs:gateResultRefs({result,operationId:id,resultPath:relative,
      ledgerResultSha256:receipt.resultSha256}),adopted:false};
}
function gateRefSortKey(ref){return `${ref.gate_id}\0${ref.checker_id}\0${
  ref.operation_id}`;}
async function authenticateGateResultRefs({stateCapability,plan,verificationPlanSha256,
  refs}={}){
  if(!Array.isArray(refs)||refs.length===0||
      refs.some((ref)=>{try{validateGateResultRef(ref);return false;}catch{return true;}})||
      new Set(refs.map((ref)=>ref.gate_id)).size!==refs.length||
      canonical(refs.map(gateRefSortKey))!==canonical(refs.map(gateRefSortKey)
        .sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)))))
    fail('release-verification-gates');
  const project=transaction.projectCapabilityFor(stateCapability);
  const sid=transaction.sessionIdFromState(stateCapability),authenticated=[];
  for(const ref of refs){
    const receipt=await journal.resumeOperation({projectCapability:project,
      operationId:ref.operation_id,sessionId:sid,kind:'release-gate-result'});
    const terminal=receipt.result;
    if(receipt.stage!=='completed-ledger'||receipt.resultSha256!==
        ref.ledger_result_sha256||!exactKeys(terminal,['checker_id','gate_ids',
          'input_refs','result_path','result_sha256','status'])||
        terminal.result_path!==ref.result_path||
        terminal.result_sha256!==ref.result_sha256||
        terminal.checker_id!==ref.checker_id||terminal.status!=='passed'||
        !terminal.gate_ids.includes(ref.gate_id))
      fail('release-verification-gates');
    const raw=readCanonical(path.join(stateCapability.projectRoot,
      ...ref.result_path.split('/')),'release-verification-gates');
    const result=validateGateResult(raw.value);
    if(result.result_sha256!==ref.result_sha256||
        result.plan_authority_sha256!==plan.plan_authority_sha256||
        result.verification_plan_sha256!==verificationPlanSha256||
        result.checker_id!==ref.checker_id||result.argv_sha256!==ref.argv_sha256||
        !result.gate_ids.includes(ref.gate_id)||result.status!=='passed')
      fail('release-verification-gates');
    if(result.checker_id==='command-v1'){
      if(result.input_refs.length!==1||
          result.input_refs[0].kind!=='release-source-graph')
        fail('release-verification-gates');
      try{require('./release-toolchain-runtime.js')
        .authenticateReleaseSourceGraphRef({stateCapability,
          ref:result.input_refs[0]});}
      catch{fail('release-verification-gates');}
    }
    authenticated.push({ref,receipt,result});
  }
  return authenticated;
}
async function authenticateFunctionalReceiptRefs({stateCapability,plan,refs}={}){
  const expected=plan.slices.filter((row)=>row.slice_kind==='functional')
    .map((row)=>row.id).sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
  if(!Array.isArray(refs)||canonical(refs.map((row)=>row?.slice_id))!==
      canonical(expected)||refs.some((row)=>!exactKeys(row,
        ['slice_id','receipt_sha256','completion_operation_id'])||
        !DIGEST.test(row.receipt_sha256||'')||
        !OPERATION.test(row.completion_operation_id||'')))
    fail('release-verification-functional');
  const project=transaction.projectCapabilityFor(stateCapability);
  const sid=transaction.sessionIdFromState(stateCapability),runtime=
    require('./functional-receipt-runtime.js');
  for(const ref of refs){
    const relative=`.deep-work/${sid}/receipts/${ref.slice_id}.json`;
    const raw=readCanonical(path.join(stateCapability.projectRoot,
      ...relative.split('/')),'release-verification-functional');
    const receipt=runtime.validateFunctionalSliceReceiptV2(raw.value);
    const producer=await journal.resumeOperation({projectCapability:project,
      operationId:ref.completion_operation_id,sessionId:sid,
      kind:'functional-slice-complete-v2'});
    if(receipt.receipt_sha256!==ref.receipt_sha256||
        receipt.completion_operation_id!==ref.completion_operation_id||
        receipt.plan_authority_sha256!==plan.plan_authority_sha256||
        producer.stage!=='completed-ledger'||
        producer.result?.receipt_path!==relative||
        producer.result?.receipt_sha256!==ref.receipt_sha256)
      fail('release-verification-functional');
  }
  return structuredClone(refs);
}
function releaseReceiptDigest(value){const copy=structuredClone(value);
  delete copy.receipt_sha256;return journal.sha256(canonical(copy));}
function validateReleaseVerificationReceipt(value){
  if(!exactKeys(value,RELEASE_RECEIPT_KEYS)||value.schema_version!==1||
      !/^SLICE-\d{3}$/.test(value.slice_id||'')||
      !DIGEST.test(value.plan_authority_sha256||'')||
      !DIGEST.test(value.verification_plan_sha256||'')||
      !Array.isArray(value.gate_results)||value.gate_results.length===0||
      value.gate_results.some((ref)=>{
        try{validateGateResultRef(ref);return false;}catch{return true;}
      })||!Array.isArray(value.functional_receipts)||
      value.functional_receipts.some((ref)=>!exactKeys(ref,
        ['slice_id','receipt_sha256','completion_operation_id'])||
        !/^SLICE-\d{3}$/.test(ref.slice_id||'')||
        !DIGEST.test(ref.receipt_sha256||'')||
        !OPERATION.test(ref.completion_operation_id||''))||
      !OPERATION.test(value.completion_operation_id||'')||
      !DIGEST.test(value.receipt_sha256||'')||
      value.receipt_sha256!==releaseReceiptDigest(value))
    fail('release-verification-receipt');
  return structuredClone(value);
}
function reconstructInvalidatedReleaseReceipt(value){
  if(!value||value.status!=='invalidated')fail('release-verification-recovery');
  let candidate;
  if(value.schema_version===1){
    candidate=structuredClone(value);delete candidate.status;
  }else if(value.schema_version==='1.0'){
    if(!exactKeys(value,LEGACY_INVALIDATED_RELEASE_RECEIPT_KEYS))
      fail('release-verification-recovery');
    candidate=Object.fromEntries(RELEASE_RECEIPT_KEYS.map((key)=>
      [key,value[key]]));candidate.schema_version=1;
  }else fail('release-verification-recovery');
  try{validateReleaseVerificationReceipt(candidate);}catch{
    fail('release-verification-recovery');
  }
  if(candidate.receipt_sha256!==value.receipt_sha256)
    fail('release-verification-recovery');
  return candidate;
}
function isInvalidatedReleaseReceipt(value){
  try{reconstructInvalidatedReleaseReceipt(value);return true;}catch{return false;}
}
function validateReleaseCompletionLedger(completed,{sliceId,receiptRelative,
  receipt,operationId}={}){
  const result=completed?.result;
  if(completed?.stage!=='completed-ledger'||!exactKeys(result,
      ['slice_id','receipt_path','receipt_sha256','post_state_sha256'])||
      result.slice_id!==sliceId||result.receipt_path!==receiptRelative||
      result.receipt_sha256!==receipt.receipt_sha256||
      !DIGEST.test(result.post_state_sha256||'')||
      receipt.completion_operation_id!==operationId||
      completed.resultSha256!==journal.sha256(canonical(result)))
    fail('release-verification-adoption');
  return result;
}
async function publishReleaseVerificationReceipt({stateCapability,planCapability,plan,
  sliceId,gateResults,functionalReceipts,seam,_locksHeld=false}={}){
  if(!_locksHeld){
    const root=stateCapability?.projectRoot;
    const sid=transaction.sessionIdFromState(stateCapability);
    const fields=frontmatter.parseFrontmatter(
      fs.readFileSync(stateCapability.path,'utf8')).fields;
    if(typeof fields.work_dir!=='string')fail('release-verification-state');
    const receiptPath=path.join(root,...fields.work_dir.split('/'),'receipts',
      `${sliceId}.json`);
    const locks=releaseReceiptTargetLocks({root,planPath:planCapability.path,
      receiptPath});
    return transaction.withRankedLocks([
      {rank:transaction.RANKS.session,capability:platform.issueProjectStateCapability(
        root,path.join(root,'.claude',`deep-work.${sid}.rank-operation.lock`),
        {allowMissingLeaf:true,role:'lock'})},
      {rank:transaction.RANKS.journal,capability:platform.issueProjectStateCapability(
        root,path.join(root,'.claude',`deep-work.${sid}.rank-journal.lock`),
        {allowMissingLeaf:true,role:'lock'})},
      {rank:transaction.RANKS.state,capability:transaction.stateLock(stateCapability)},
      ...locks,
    ],()=>publishReleaseVerificationReceipt({stateCapability,planCapability,plan,
      sliceId,gateResults,functionalReceipts,seam,_locksHeld:true}));
  }
  const current=loadPlan(planCapability,plan),sid=
    transaction.sessionIdFromState(stateCapability);
  const fields=frontmatter.parseFrontmatter(
    fs.readFileSync(stateCapability.path,'utf8')).fields;
  const slice=current.slices.find((row)=>row.id===sliceId);
  if(!slice||slice.slice_kind!=='release-verification'||
      fields.current_phase!=='test'||!DIGEST.test(fields.verification_plan_sha256||''))
    fail('release-verification-state');
  await authenticateGateResultRefs({stateCapability,plan:current,
    verificationPlanSha256:fields.verification_plan_sha256,refs:gateResults});
  const projected=[...slice.release_gate_ids].sort((a,b)=>
    Buffer.compare(Buffer.from(a),Buffer.from(b)));
  if(canonical(gateResults.map((ref)=>ref.gate_id).sort((a,b)=>
      Buffer.compare(Buffer.from(a),Buffer.from(b))))!==canonical(projected))
    fail('release-verification-gates');
  const functional=await authenticateFunctionalReceiptRefs({stateCapability,
    plan:current,refs:functionalReceipts});
  const preconditions={session_id:sid,slice_id:sliceId,
    plan_authority_sha256:current.plan_authority_sha256,
    verification_plan_sha256:fields.verification_plan_sha256,
    gate_results:gateResults,functional_receipts:functional};
  const id=operationId('release-verification-complete-v1',preconditions);
  const receipt={schema_version:1,slice_id:sliceId,
    plan_authority_sha256:current.plan_authority_sha256,
    verification_plan_sha256:fields.verification_plan_sha256,
    gate_results:structuredClone(gateResults),
    functional_receipts:functional,completion_operation_id:id,
    receipt_sha256:null};
  receipt.receipt_sha256=releaseReceiptDigest(receipt);
  const relative=`.deep-work/${sid}/receipts/${sliceId}.json`;
  const project=transaction.projectCapabilityFor(stateCapability);
  const existing=await journal.resumeOperation({projectCapability:project,
    operationId:id,sessionId:sid,kind:'release-verification-complete'}).catch(
      (error)=>{if(error.code==='operation-not-found')return null;throw error;});
  if(existing?.stage==='completed-ledger'){
    const receiptPath=path.join(stateCapability.projectRoot,...relative.split('/'));
    if(!fs.existsSync(receiptPath))fail('release-verification-recovery-required');
    const raw=readCanonical(receiptPath,'release-verification-adoption').value;
    if(raw.status==='invalidated')fail('release-verification-recovery-required');
    let stored;
    try{stored=validateReleaseVerificationReceipt(raw);}catch{
      fail('release-verification-adoption');
    }
    if(canonical(stored)!==canonical(receipt))fail('release-verification-adoption');
    validateReleaseCompletionLedger(existing,{sliceId,receiptRelative:relative,
      receipt,operationId:id});
    return{...existing.result,operation_id:id,
      operation_receipt:existing,adopted:true};
  }
  if(slice.checked)fail('release-verification-state');
  const operation=await journal.beginOperation({projectCapability:project,
    sessionId:sid,kind:'release-verification-complete',operationId:id,
    preconditions});
  await journal.recordOperationStage(operation,'aggregate-authenticated',{owned:{
    gateCount:gateResults.length,functionalCount:functional.length}});
  seam?.('before-release-receipt-write',{operationId:id,path:relative});
  const replaced=await replaceInvalidatedReleaseReceipt({stateCapability,
    current,fields,sliceId,relative,receipt});
  if(!replaced)writeExclusive(path.join(stateCapability.projectRoot,
    ...relative.split('/')),receipt,'release-verification-receipt');
  await journal.recordOperationStage(operation,'receipt-published',{owned:{
    receiptPath:relative,receiptSha256:receipt.receipt_sha256}});
  const updated=structuredClone(current);
  updated.slices=updated.slices.map((row)=>row.id===sliceId?
    {...row,checked:true}:row);
  if(planRuntime.compileImmutablePlanAuthorityV2(updated).plan_authority_sha256!==
      current.plan_authority_sha256)fail('release-verification-plan');
  transaction.atomicWriteSessionFile(planCapability,canonical(updated));
  const stateBefore=fs.readFileSync(stateCapability.path,'utf8');
  const stateAfter=frontmatter.updateFrontmatterText(stateBefore,{
    release_verification_receipt_sha256:receipt.receipt_sha256,
    release_verification_operation_id:id,test_passed:true});
  platform.atomicWriteFile(stateCapability,stateAfter);
  await journal.recordOperationStage(operation,'progress-committed',{owned:{
    planSha256:journal.sha256(canonical(updated)),
    postStateSha256:journal.sha256(Buffer.from(stateAfter))}});
  const result={slice_id:sliceId,receipt_path:relative,
    receipt_sha256:receipt.receipt_sha256,
    post_state_sha256:journal.sha256(Buffer.from(stateAfter))};
  const operationReceipt=await journal.completeOperation(operation,result);
  return{...result,operation_id:id,operation_receipt:operationReceipt,
    adopted:false};
}

module.exports={RELEASE_GATE_CATALOG,DETERMINISTIC_GATE_MAPPING,
  CHECKER_INPUT_CATALOG,validateCheckerInputRefs,computeBlockingCodes,
  buildGateFactArtifact,validateGateFactArtifact,argvSha256,
  buildDeterministicGateResult,buildCommandGateResult,validateGateResult,
  validateGateResultRef,publishGateFact,publishDeterministicGateResult,
  publishCommandGateResult,
  publishReleaseIntegrityGateResult,
  gateResultRefs,validateReleaseVerificationReceipt,
  reconstructInvalidatedReleaseReceipt,isInvalidatedReleaseReceipt,
  validateReleaseCompletionLedger,replaceInvalidatedReleaseReceipt,
  releaseReceiptTargetLocks,
  publishReleaseVerificationReceipt,semanticDigest,legacyV7SurfaceViolations};
