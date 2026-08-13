'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {canonicalJson}=require('./operation-journal.js');
const {validateVerificationSpec,executeVerificationInMemory}=require('./verification-runtime.js');
const gateCatalog=require('./verification-gate-catalog.js');

const MAX_TEXT_BYTES=1_048_576;
const ROLLING_BASE=257n,ROLLING_MASK=(1n<<64n)-1n;
const RULE_ORDER=Object.freeze(['exact-secret','pem-private-key','authorization','token-family','sensitive-assignment','home-prefix']);
const PRODUCER_BY_KIND=Object.freeze({command:'capture-command-evidence',contract:'capture-contract-evidence',
  review:'capture-review-evidence',receipt:'capture-receipt-evidence',adapter:'run-evidence-adapter',
  sensor:'capture-runtime-projection',health:'capture-runtime-projection'});
const TEST_PUBLISH_TAILS=new WeakMap();

function fail(code,message){const error=new Error(`[${code}] ${message||code}`);error.code=code;throw error;}
function sha256(value){return crypto.createHash('sha256').update(Buffer.isBuffer(value)?value:String(value)).digest('hex');}
function isDigest(value){return /^[0-9a-f]{64}$/.test(value||'');}
function sorted(values=[]){if(!Array.isArray(values))fail('evidence-trace');return gateCatalog.ordered(values);}
function exact(value,expected){return canonicalJson(value)===canonicalJson(expected);}
function exactKeys(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&
  exact(Object.keys(value).sort(),[...keys].sort());}
function escape(value){return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function replace(source,pattern,marker,rule,state,replacer){return source.replace(pattern,(...args)=>{
  state.rules.add(rule);state.count+=1;return replacer?replacer(...args):marker;});}
function normalizePolicy(policy={}){if(policy===null||typeof policy!=='object'||Array.isArray(policy))fail('redaction-policy');
  const secrets=policy.exact_secret_values||policy.secrets||[];
  if(!Array.isArray(secrets)||secrets.length>64||secrets.some((value)=>typeof value!=='string'||!value||
      Buffer.byteLength(value)>4096))fail('redaction-policy');
  const home=policy.home===undefined?null:policy.home;if(home!==null&&(typeof home!=='string'||!home))fail('redaction-policy');
  return{schema_version:1,exact_secret_values:[...new Set(secrets)].sort((a,b)=>b.length-a.length||
    Buffer.compare(Buffer.from(a),Buffer.from(b))),home};}

function redactEvidenceText(text,policy={}){
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX_TEXT_BYTES)fail('redaction-text-bounds');
  const checked=normalizePolicy(policy);const state={rules:new Set(),count:0};let output=text;
  for(const secret of checked.exact_secret_values)output=replace(output,new RegExp(escape(secret),'g'),
    '<REDACTED:exact-secret>','exact-secret',state);
  output=replace(output,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    '<REDACTED:pem-private-key>','pem-private-key',state);
  output=replace(output,/\b(Authorization\s*:\s*)(?:Bearer|Basic)\s+(?!<REDACTED:)[^\s,;]+/gi,'',
    'authorization',state,(_all,prefix)=>`${prefix}<REDACTED:authorization>`);
  output=replace(output,/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    '<REDACTED:token-family>','token-family',state);
  const key='(?:password|passwd|secret|token|api_key|access_key|private_key|credential|client_secret)';
  output=replace(output,new RegExp(`("${key}"\\s*:\\s*")(?!<REDACTED:)[^"]*(")`,'gi'),'',
    'sensitive-assignment',state,(_all,prefix,suffix)=>`${prefix}<REDACTED:sensitive-assignment>${suffix}`);
  output=replace(output,new RegExp(`(\\b${key}\\s*=\\s*)(?!<REDACTED:)[^\\s,;]+`,'gi'),'',
    'sensitive-assignment',state,(_all,prefix)=>`${prefix}<REDACTED:sensitive-assignment>`);
  if(checked.home)output=replace(output,new RegExp(escape(checked.home),'g'),'<HOME>','home-prefix',state);
  return{text:output,applied_rules:RULE_ORDER.filter((rule)=>state.rules.has(rule)),match_count:state.count,passed:true};
}

function rollingHash(bytes){let value=0n;for(const byte of bytes)value=((value*ROLLING_BASE)+BigInt(byte+1))&ROLLING_MASK;return value;}
function exactSecretFingerprints(evidenceId,policy={}){const checked=normalizePolicy(policy);return checked.exact_secret_values.map((secret)=>({
  schema_version:1,algorithm:'sha256-evidence-id-v1',utf8_bytes:Buffer.byteLength(secret),characters:[...secret].length,
  rolling_hash:rollingHash(Buffer.from(secret)).toString(16).padStart(16,'0'),digest_sha256:sha256(`${evidenceId}\0${secret}`)}))
  .sort((a,b)=>Buffer.compare(Buffer.from(a.digest_sha256),Buffer.from(b.digest_sha256)));}
function persistedStrings(value){const strings=[],seen=new Set();let bytes=0,bounded=true;const visit=(candidate,key)=>{
    if(key==='exact_secret_fingerprints')return;if(typeof candidate==='string'){bytes+=Buffer.byteLength(candidate);if(bytes>4_194_304){bounded=false;return;}
      strings.push(candidate);return;}if(!candidate||typeof candidate!=='object'||seen.has(candidate))return;seen.add(candidate);
    if(Array.isArray(candidate)){for(const row of candidate)visit(row,null);return;}for(const [childKey,row] of Object.entries(candidate)){
      if(childKey==='exact_secret_fingerprints')continue;visit(childKey,null);visit(row,childKey);}};
  visit(value,null);return{strings,bounded};}
function fingerprintHits(value){const records=Array.isArray(value?.records)?value.records:[value],fingerprints=[];
  for(const record of records){if(record?.kind!=='command')continue;for(const row of record.redaction?.exact_secret_fingerprints||[])
    fingerprints.push({...row,evidence_id:record.evidence_id});}if(!fingerprints.length)return[];const persisted=persistedStrings(value);
  if(!persisted.bounded)return['exact-secret-scan-bounds'];const groups=new Map();
  for(const row of fingerprints){if(row?.schema_version!==1||row.algorithm!=='sha256-evidence-id-v1'||!isDigest(row.digest_sha256)||
        !/^[0-9a-f]{16}$/.test(row.rolling_hash||'')||
        !Number.isSafeInteger(row.utf8_bytes)||row.utf8_bytes<1||row.utf8_bytes>4096||
        !Number.isSafeInteger(row.characters)||row.characters<1||row.characters>4096)return['exact-secret-fingerprint'];
    const key=`${row.utf8_bytes}:${row.rolling_hash}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  for(const string of persisted.strings){const bytes=Buffer.from(string);for(const rows of groups.values()){const width=rows[0].utf8_bytes;
      if(width>bytes.length)continue;let power=1n;for(let index=1;index<width;index++)power=(power*ROLLING_BASE)&ROLLING_MASK;
      let rolling=rollingHash(bytes.subarray(0,width));for(let start=0;;start++){if(rolling.toString(16).padStart(16,'0')===rows[0].rolling_hash){
          const candidate=bytes.subarray(start,start+width).toString('utf8');if(Buffer.byteLength(candidate)===width)
            for(const row of rows)if([...candidate].length===row.characters&&sha256(`${row.evidence_id}\0${candidate}`)===row.digest_sha256)
              return['exact-secret'];}if(start+width>=bytes.length)break;rolling=(rolling-(BigInt(bytes[start]+1)*power))&ROLLING_MASK;
        rolling=((rolling*ROLLING_BASE)+BigInt(bytes[start+width]+1))&ROLLING_MASK;}}
  }
  return[];}
function secretHits(value){const text=typeof value==='string'?value:canonicalJson(value);const patterns=[
  ['pem-private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ['authorization',/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+(?!<REDACTED:)[^\s,;]+/i],
  ['token-family',/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/i],
  ['sensitive-assignment',/(?:"(?:password|passwd|secret|token|api_key|access_key|private_key|credential|client_secret)"\s*:\s*"(?!<REDACTED:)[^"]+"|\b(?:password|passwd|secret|token|api_key|access_key|private_key|credential|client_secret)\s*=\s*(?!<REDACTED:)[^\s,;]+)/i],
  ];return[...new Set([...patterns.filter(([,pattern])=>pattern.test(text)).map(([id])=>id),...fingerprintHits(value)])];}

function producerPreimage(record,producerName){const value=structuredClone(record);delete value.producer_proof;
  return{schema_version:1,producer:producerName,kind:value.kind,record:value};}
function sealRecord(record,producerName=PRODUCER_BY_KIND[record?.kind]){if(!producerName)fail('protected-evidence-producer');
  const value=structuredClone(record);value.producer_proof={schema_version:1,producer:producerName,kind:value.kind,
    proof_sha256:sha256(canonicalJson(producerPreimage(value,producerName)))};return Object.freeze(value);}
function validateProducerProof(record){const expected=PRODUCER_BY_KIND[record?.kind],proof=record?.producer_proof;
  return Boolean(expected&&proof?.schema_version===1&&proof.producer===expected&&proof.kind===record.kind&&
    isDigest(proof.proof_sha256)&&proof.proof_sha256===sha256(canonicalJson(producerPreimage(record,expected))));}

function normalizeRunnerResult(ran){const raw=ran?.result||ran||{};return{exitCode:raw.exitCode,signal:raw.signal??null,
  timedOut:Boolean(raw.timedOut),outputOverflow:Boolean(raw.outputOverflow),stdout:String(raw.stdout||''),
  stderr:String(raw.stderr||''),durationMs:Number.isFinite(raw.durationMs)?raw.durationMs:0,resolved:ran?.resolved||null};}
async function captureCommandEvidence(input={},deps={}){
  if(input.command!==undefined||input.args!==undefined)fail('structured-verification');
  const spec=validateVerificationSpec(input.verification_spec);const expected=input.expected_outcome;
  if(!['must-pass','must-fail'].includes(expected))fail('verification-outcome');
  if(expected==='must-fail'&&!spec.red_failure_literal)fail('verification-red-literal');
  const runner=deps.runner||((request)=>executeVerificationInMemory({...request,enforceOutcome:false}));
  const ran=normalizeRunnerResult(await runner({checked:spec,expectedOutcome:expected,cwd:input.cwd,
    toolchainCapability:deps.toolchainCapability}));
  const redSignal=expected==='must-fail'&&ran.exitCode!==0&&!ran.timedOut&&!ran.outputOverflow&&
    `${ran.stdout}\n${ran.stderr}`.includes(spec.red_failure_literal);
  const satisfied=expected==='must-pass'?ran.exitCode===0&&!ran.timedOut&&!ran.outputOverflow:redSignal;
  const stdout=redactEvidenceText(ran.stdout,input.redaction_policy),stderr=redactEvidenceText(ran.stderr,input.redaction_policy);
  const argsProjection=redactEvidenceText(spec.args.join(' '),input.redaction_policy);
  const applied=RULE_ORDER.filter((rule)=>stdout.applied_rules.includes(rule)||stderr.applied_rules.includes(rule)||
    argsProjection.applied_rules.includes(rule));const output={stdout:stdout.text,stderr:stderr.text};
  const record={schema_version:2,evidence_id:input.evidence_id,gate_id:input.gate_id,kind:'command',status:satisfied?'pass':'fail',
    outcome:ran.timedOut?'timeout':ran.outputOverflow?'overflow':ran.exitCode===0?'passed':'failed',
    requirement_ids:sorted(input.requirement_ids),invariant_ids:sorted(input.invariant_ids),
    failure_mode_ids:sorted(input.failure_mode_ids),negative_test_ids:sorted(input.negative_test_ids),
    command:{spec_sha256:sha256(canonicalJson(spec)),executable_kind:spec.executable.kind,
      redacted_display:argsProjection.text,redacted_args_sha256:sha256(argsProjection.text),cwd_role:spec.cwd_role},
    result:{exit_code:ran.exitCode,signal:ran.signal,timed_out:ran.timedOut,output_overflow:ran.outputOverflow,
      red_signal_matched:redSignal,redacted_output_sha256:sha256(canonicalJson(output)),duration_ms:ran.durationMs},
    redacted_output:output,host:{runtime:input.host?.runtime||'codex',platform:input.host?.platform||process.platform,
      adapter:'command',actual_host:input.host?.actual_host!==false},
    redaction:{policy_version:1,applied_rules:applied,match_count:stdout.match_count+stderr.match_count+
      argsProjection.match_count,passed:true,exact_secret_fingerprints:exactSecretFingerprints(input.evidence_id,input.redaction_policy)}};
  if(!/^EVID-[A-Z0-9-]+$/.test(record.evidence_id||'')||!/^GATE-[a-z0-9-]+$/.test(record.gate_id||''))
    fail('evidence-identity');return sealRecord(record);
}

function validateVerificationPlan(plan){const result=require('./verification-policy-runtime.js').validateVerificationPlan(plan);
  if(!result.pass)fail(result.errors[0]?.code||'evidence-verification-plan');return structuredClone(plan);}
function gateFor(plan,gateId,adapter){const checked=validateVerificationPlan(plan),gate=checked.gates.find((row)=>row.id===gateId);
  if(!gate||gate.adapter!==adapter||gate.disposition!=='required')fail('evidence-gate-authority');return{plan:checked,gate};}

function captureContractEvidence(input={}){const {plan,gate}=gateFor(input.verificationPlan,input.gate_id,'contract');
  const runtime=require('./contract-runtime.js');const result=runtime.validateSpecContract(input.specContract,
    {riskClass:input.specContract?.risk_class,...(input.slices?{slices:input.slices}:{})});
  if(!result.pass||runtime.specContractDigest(input.specContract)!==plan.spec_sha256||input.specContract.spec_id!==plan.spec_id)
    fail('contract-evidence-validation');return sealRecord({schema_version:2,evidence_id:input.evidence_id,gate_id:gate.id,
      kind:'contract',status:'pass',requirement_ids:sorted(gate.requirement_ids),invariant_ids:sorted(input.invariant_ids||[]),
      failure_mode_ids:sorted(gate.failure_mode_ids),negative_test_ids:sorted(input.negative_test_ids||[]),
      result:{spec_id:plan.spec_id,spec_sha256:plan.spec_sha256,spec_approved_hash:plan.spec_approved_hash,
        requirement_coverage:result.requirementCoverage,failure_matrix_coverage:result.failureMatrixCoverage},
      redaction:{policy_version:1,applied_rules:[],match_count:0,passed:true}});}
function captureReviewEvidence(input={}){const {plan,gate}=gateFor(input.verificationPlan,input.gate_id,'review');
  const reviewPlan=input.reviewPlan,reports=input.reports;if(!reviewPlan||!Array.isArray(reports))fail('review-evidence-authority');
  const required=(reviewPlan.reviewers||[]).filter((row)=>row.required),byRole=new Map(reports.map((row)=>[row.role,row]));
  for(const reviewer of required){const report=byRole.get(reviewer.role);if(!report||report.status!=='completed'||
      report.channel!==reviewer.channel||!isDigest(report.sha256)||typeof report.report_ref!=='string')fail('review-evidence-authority');}
  const policy=reviewPlan.mode||input.review_policy||'single';if(policy==='dual'&&(required.length<2||
      new Set(required.map((row)=>byRole.get(row.role).sha256)).size!==required.length))fail('review-evidence-independent');
  const evaluated=require('./review-policy-runtime.js').evaluateReviewExecution(reviewPlan,reports);
  if(evaluated.decision!=='proceed')fail('review-evidence-authority');return sealRecord({schema_version:2,
    evidence_id:input.evidence_id,gate_id:gate.id,kind:'review',status:'pass',requirement_ids:sorted(gate.requirement_ids),
    invariant_ids:[],failure_mode_ids:sorted(gate.failure_mode_ids),negative_test_ids:[],review_policy:policy,
    verification_plan_sha256:plan.plan_sha256,reports:reports.map((row)=>({role:row.role,channel:row.channel,
      report_ref:row.report_ref,sha256:row.sha256})).sort((a,b)=>Buffer.compare(Buffer.from(a.role),Buffer.from(b.role))),
    redaction:{policy_version:1,applied_rules:[],match_count:0,passed:true}});}
function captureReceiptEvidence(input={}){const {plan,gate}=gateFor(input.verificationPlan,input.gate_id,'receipt');
  if(!Array.isArray(input.receipts)||!input.verificationResult||input.verificationResult.pass!==true||
      (input.verificationResult.errors||[]).length)fail('receipt-evidence-validation');
  const sliceIds=sorted(input.receipts.map((row)=>row.slice_id)),expected=sorted(input.plan?.slices?.map((row)=>row.id)||[]);
  if(!exact(sliceIds,expected))fail('receipt-evidence-validation');return sealRecord({schema_version:2,
    evidence_id:input.evidence_id,gate_id:gate.id,kind:'receipt',status:'pass',requirement_ids:sorted(gate.requirement_ids),
    invariant_ids:sorted(input.invariant_ids||[]),failure_mode_ids:sorted(gate.failure_mode_ids),
    negative_test_ids:sorted(input.negative_test_ids||[]),result:{receipt_set_sha256:sha256(canonicalJson(input.receipts)),
      verification_result_sha256:sha256(canonicalJson(input.verificationResult)),item_count:9,
      verification_plan_sha256:plan.plan_sha256,risk_profile_sha256:plan.risk_profile_sha256},
    redaction:{policy_version:1,applied_rules:[],match_count:0,passed:true}});}

function validateAdapterPlan(candidate){const keys=['schema_version','adapter','gate_id','slice_id','verification_plan_sha256',
  'spec_sha256','isolation','required_capabilities','steps','timeout_ms','max_output_bytes'];
  if(!exactKeys(candidate,keys)||candidate.schema_version!==1||!['fault','recovery','host-smoke'].includes(candidate.adapter)||
      !/^GATE-[a-z0-9-]+$/.test(candidate.gate_id||'')||!/^SLICE-\d{3}$/.test(candidate.slice_id||'')||
      !isDigest(candidate.verification_plan_sha256)||!isDigest(candidate.spec_sha256)||!candidate.isolation||
      !['fixture','disposable-worktree','disposable-environment','actual-host-readonly'].includes(candidate.isolation.kind)||
      typeof candidate.isolation.resource_id!=='string'||!candidate.isolation.resource_id||
      !Array.isArray(candidate.required_capabilities)||!Array.isArray(candidate.steps)||!candidate.steps.length||candidate.steps.length>64||
      !Number.isSafeInteger(candidate.timeout_ms)||candidate.timeout_ms<1000||candidate.timeout_ms>600000||
      !Number.isSafeInteger(candidate.max_output_bytes)||candidate.max_output_bytes<4096||candidate.max_output_bytes>1048576)
    fail('adapter-plan-schema');
  const ids=new Set(),seen=new Set();let hasAct=false,cleanup=0;for(const step of candidate.steps){const stepKeys=['id','phase',
    'depends_on','verification_spec','expected','trace_ids','always_run'];if(!exactKeys(step,stepKeys)||!/^STEP-\d{3}$/.test(step.id||'')||
      ids.has(step.id)||!['prepare','act','observe','recover','assert','cleanup'].includes(step.phase)||!Array.isArray(step.depends_on)||
      step.depends_on.some((id)=>!seen.has(id))||!['must-pass','must-fail'].includes(step.expected)||!Array.isArray(step.trace_ids)||
      typeof step.always_run!=='boolean')fail('adapter-plan-step');validateVerificationSpec(step.verification_spec);
    if(step.verification_spec.timeout_ms>candidate.timeout_ms||step.verification_spec.max_output_bytes>candidate.max_output_bytes)
      fail('adapter-plan-bounds');if(step.phase==='act')hasAct=true;if(step.phase==='cleanup'){cleanup+=1;
      if(!step.always_run)fail('adapter-plan-cleanup');}ids.add(step.id);seen.add(step.id);}
  if((hasAct&&cleanup!==1)||(candidate.isolation.kind==='actual-host-readonly'&&hasAct))fail('adapter-plan-cleanup');
  return structuredClone(candidate);}
async function runEvidenceAdapter(candidate,deps={}){const plan=validateAdapterPlan(candidate);if(typeof deps.runStep!=='function')
  fail('adapter-runner');const children=[],transitions=['validated'];let failed=false,cleanupPassed=false,actualHost=false;
  deps.recordStage&&await deps.recordStage('validated',{plan_sha256:sha256(canonicalJson(plan))});
  for(const step of plan.steps){if(failed&&step.phase!=='cleanup'&&!step.always_run)continue;let result;
    try{result=await deps.runStep(structuredClone(step));}catch(error){result={status:'fail',code:error.code||'adapter-step-error'};}
    const passed=result?.status==='pass';children.push({step_id:step.id,phase:step.phase,status:passed?'pass':'fail',
      evidence_id:result?.evidence_id||null,result_sha256:sha256(canonicalJson(result||{}))});
    if(step.phase==='cleanup')cleanupPassed=passed;if(plan.isolation.kind==='actual-host-readonly'&&result?.actual_host===true)actualHost=true;
    if(!passed&&step.phase!=='cleanup'){failed=true;transitions.push('failed-pending-cleanup');}
    else if(step.phase==='cleanup')transitions.push(passed?'cleanup-run':'cleanup-failed');
    else transitions.push({prepare:'prepared',act:'acted',observe:'observed',recover:'recovered',assert:'asserted'}[step.phase]);
    deps.recordStage&&await deps.recordStage(transitions.at(-1),{step_id:step.id,result_sha256:children.at(-1).result_sha256});}
  const requiredActual=plan.isolation.kind==='actual-host-readonly',passed=!failed&&cleanupPassed&&(!requiredActual||actualHost);
  transitions.push(passed?'complete':cleanupPassed?'failed-pending-cleanup':'cleanup-failed');return sealRecord({schema_version:2,
    evidence_id:deps.evidence_id||`EVID-${sha256(canonicalJson(plan)).slice(0,16).toUpperCase()}`,gate_id:plan.gate_id,
    kind:'adapter',adapter:plan.adapter,status:passed?'pass':'fail',slice_id:plan.slice_id,
    verification_plan_sha256:plan.verification_plan_sha256,spec_sha256:plan.spec_sha256,transitions,children,
    cleanup:{required:true,passed:cleanupPassed},actual_host:actualHost,requirement_ids:sorted(deps.requirement_ids||[]),
    invariant_ids:sorted(deps.invariant_ids||[]),failure_mode_ids:sorted(deps.failure_mode_ids||[]),
    negative_test_ids:sorted(deps.negative_test_ids||[]),redaction:{policy_version:1,applied_rules:[],match_count:0,passed:true}});}
function captureRuntimeProjectionEvidence(input={}){if(!['sensor','health'].includes(input.kind)||
    !/^op-[0-9a-f]{32,64}$/.test(input.operation?.operationId||'')||!isDigest(input.result_sha256)||
    sha256(canonicalJson(input.result))!==input.result_sha256||input.result?.status!=='pass')fail('runtime-evidence-authority');
  const {plan,gate}=gateFor(input.verificationPlan,input.gate_id,input.kind);return sealRecord({schema_version:2,
    evidence_id:input.evidence_id,gate_id:gate.id,kind:input.kind,status:'pass',operation_id:input.operation.operationId,
    result_sha256:input.result_sha256,verification_plan_sha256:plan.plan_sha256,requirement_ids:sorted(gate.requirement_ids),
    invariant_ids:sorted(input.invariant_ids||[]),failure_mode_ids:sorted(gate.failure_mode_ids),negative_test_ids:[],
    redaction:{policy_version:1,applied_rules:[],match_count:0,passed:true}});}

function durableJson(target,value){const bytes=Buffer.from(canonicalJson(value));fs.mkdirSync(path.dirname(target),{recursive:true});
  if(fs.existsSync(target)){const current=fs.readFileSync(target);if(!current.equals(bytes))fail('evidence-immutable-conflict');}
  else{const temp=`${target}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`,fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,target);}
  return{bytes,sha256:sha256(bytes)};}
function safeEvidencePath(root,relative){if(typeof root!=='string'||!root||typeof relative!=='string'||
    !/^evidence\/(?:commands|packages)\/[A-Za-z0-9.-]+\.json$/.test(relative))fail('evidence-artifact-ref');
  const target=path.resolve(root,...relative.split('/'));if(!target.startsWith(`${path.resolve(root)}${path.sep}`))fail('evidence-artifact-ref');return target;}
function publishRedactedEvidenceArtifactUnderLock({projectRoot,record}={}){if(!projectRoot||!record||
    !/^EVID-[A-Z0-9-]+$/.test(record.evidence_id||'')||record.kind!=='command'||!validateProducerProof(record))
    fail('evidence-artifact-input');
  const artifact={schema_version:2,evidence_id:record.evidence_id,gate_id:record.gate_id,kind:'command',
    redacted_output:structuredClone(record.redacted_output||{}),result:structuredClone(record.result||{}),
    redaction:structuredClone(record.redaction)};if(secretHits(artifact).length)fail('evidence-redaction');
  const relative=`evidence/commands/${record.evidence_id}.json`,written=durableJson(safeEvidencePath(projectRoot,relative),artifact);
  return{artifact_ref:relative,artifact_sha256:written.sha256};}
function materializeRecordUnderLock({artifactRoot,record}={}){if(record?.kind!=='command')return structuredClone(record);
  if(record.artifact_ref&&record.artifact_sha256&&!record.redacted_output)return structuredClone(record);
  const ref=publishRedactedEvidenceArtifactUnderLock({projectRoot:artifactRoot,record}),next=structuredClone(record);
  delete next.redacted_output;next.artifact_ref=ref.artifact_ref;next.artifact_sha256=ref.artifact_sha256;
  return sealRecord(next,'capture-command-evidence');}
function loadArtifact(artifactRoot,record){if(!artifactRoot||!record?.artifact_ref||!isDigest(record.artifact_sha256))
  fail('evidence-artifact-required');const target=safeEvidencePath(artifactRoot,record.artifact_ref),stat=fs.lstatSync(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_TEXT_BYTES)fail('evidence-artifact-input');const bytes=fs.readFileSync(target);
  if(sha256(bytes)!==record.artifact_sha256)fail('evidence-artifact-digest');let artifact;try{artifact=JSON.parse(bytes);}catch{fail('evidence-artifact-json');}
  if(artifact.schema_version!==2||artifact.evidence_id!==record.evidence_id||artifact.gate_id!==record.gate_id||
      artifact.kind!=='command'||artifact.result?.redacted_output_sha256!==sha256(canonicalJson(artifact.redacted_output))||
      secretHits(artifact).length)fail('evidence-artifact-authentication');return artifact;}

function validateRecord(record,plan,{artifactRoot}={}){const gate=plan.gates.find((row)=>row.id===record?.gate_id),errors=[];
  if(!/^EVID-[A-Z0-9-]+$/.test(record?.evidence_id||'')||record?.schema_version!==2||record.status!=='pass')
    errors.push({code:'evidence-record'});
  if(!gate||gate.disposition!=='required'||gateCatalog.recordKindForAdapter(gate.adapter)!==record?.kind||
      (record?.kind==='adapter'&&record.adapter!==gate?.adapter))errors.push({code:'evidence-record-adapter'});
  if(gate&&(!exact(sorted(record.requirement_ids||[]),sorted(gate.requirement_ids||[]))||
      !exact(sorted(record.failure_mode_ids||[]),sorted(gate.failure_mode_ids||[]))))errors.push({code:'evidence-record-trace'});
  if(!validateProducerProof(record))errors.push({code:'protected-evidence-producer'});
  if(record?.redaction?.passed!==true||secretHits(record).length)errors.push({code:'evidence-redaction'});
  if(record?.kind==='command'&&(!Array.isArray(record.redaction?.exact_secret_fingerprints)||
      record.redaction.exact_secret_fingerprints.length>64))errors.push({code:'evidence-redaction-policy'});
  if(record?.kind==='command'){if(record.redacted_output)errors.push({code:'evidence-inline-output'});
    try{loadArtifact(artifactRoot,record);}catch(error){errors.push({code:error.code||'evidence-artifact'});}}
  if(record?.kind==='contract'&&(record.result?.spec_id!==plan.spec_id||record.result?.spec_sha256!==plan.spec_sha256||
      record.result?.spec_approved_hash!==plan.spec_approved_hash))errors.push({code:'contract-evidence-validation'});
  if(record?.kind==='receipt'&&(record.result?.verification_plan_sha256!==plan.plan_sha256||
      record.result?.risk_profile_sha256!==plan.risk_profile_sha256||!isDigest(record.result?.receipt_set_sha256)||
      !isDigest(record.result?.verification_result_sha256)))errors.push({code:'receipt-evidence-validation'});
  if(record?.kind==='review'&&(record.verification_plan_sha256!==plan.plan_sha256||!Array.isArray(record.reports)||
      record.reports.some((row)=>!isDigest(row.sha256)||typeof row.report_ref!=='string')||
      (record.review_policy==='dual'&&new Set(record.reports.map((row)=>row.sha256)).size!==record.reports.length)))
    errors.push({code:'review-evidence-authority'});
  if(record?.kind==='adapter'&&(record.verification_plan_sha256!==plan.plan_sha256||record.spec_sha256!==plan.spec_sha256||
      record.cleanup?.passed!==true||!record.transitions?.includes('complete')))errors.push({code:'adapter-evidence-validation'});
  if(['sensor','health'].includes(record?.kind)&&(record.verification_plan_sha256!==plan.plan_sha256||
      !/^op-[0-9a-f]{32,64}$/.test(record.operation_id||'')||!isDigest(record.result_sha256)))
    errors.push({code:'runtime-evidence-authority'});return errors;}
function ratio(total,covered,reason){return total===0?{total:0,covered:0,ratio:null,not_applicable_reason:reason}:
  {total,covered,ratio:covered/total};}
function sortedRecords(records){if(!Array.isArray(records))fail('evidence-records');return structuredClone(records).sort((a,b)=>
  Buffer.compare(Buffer.from(a.evidence_id||''),Buffer.from(b.evidence_id||'')));}
function packagePreimage(pkg){const copy=structuredClone(pkg);delete copy.package_sha256;return copy;}
function buildEvidencePackage(input={}){const plan=validateVerificationPlan(input.verificationPlan),records=sortedRecords(input.records||[]);
  let methodologyPolicy=null;if(plan.methodology_policy_sha256){try{
    methodologyPolicy=require('./policy-runtime.js').validateMethodologyAuthority(input.policySnapshot);
  }catch{fail('evidence-policy-authority');}
    if(methodologyPolicy.policy_sha256!==plan.methodology_policy_sha256)fail('evidence-policy-authority');}
  const ids=new Set();for(const record of records){if(ids.has(record.evidence_id))fail('evidence-record-identity');ids.add(record.evidence_id);
    const errors=validateRecord(record,plan,{artifactRoot:input.artifactRoot});if(errors.length)fail(errors[0].code);}
  const satisfied=sorted(records.map((row)=>row.gate_id)),required=plan.evidence_required_gate_ids,
    missing=required.filter((id)=>!satisfied.includes(id));
  const requirementIds=sorted(plan.gates.flatMap((row)=>row.requirement_ids)),failureIds=sorted(plan.gates.flatMap((row)=>row.failure_mode_ids));
  const coveredRequirements=requirementIds.filter((id)=>records.some((row)=>row.requirement_ids.includes(id)));
  const coveredFailures=failureIds.filter((id)=>records.some((row)=>row.failure_mode_ids.includes(id)));
  const pkg={schema_version:2,scope:structuredClone(input.scope),verification_plan_sha256:plan.plan_sha256,spec_id:plan.spec_id,
    spec_sha256:plan.spec_sha256,spec_approved_hash:plan.spec_approved_hash,risk_profile_sha256:plan.risk_profile_sha256,
    risk_snapshot:structuredClone(input.riskSnapshot||{class:plan.risk_class,score:null,triggers:[]}),
    policy_snapshot:structuredClone(input.policySnapshot||{profile:plan.profile,tdd:null,review:null,verification:plan.source_policy_label}),
    contract_trace:structuredClone(input.contractTrace||{slice_id:input.scope?.kind==='slice'?input.scope.id:null,
      requirements:requirementIds,invariants:[],failure_cases:failureIds}),records,
    coverage:{requirements:ratio(requirementIds.length,coveredRequirements.length,'no contract requirements'),
      failure_matrix:ratio(failureIds.length,coveredFailures.length,'risk class has no failure matrix obligation')},
    completeness:{evidence_required_gate_ids:[...required],satisfied_gate_ids:satisfied,missing_gate_ids:missing,
      complete:missing.length===0},reviews:structuredClone(input.reviews||{policy:plan.profile==='standard'?'single':plan.profile,
      findings:[],dispositions:[]}),unverified_areas:missing.map((gateId)=>({gate_id:gateId,reason:'missing-required-evidence'})),
    residual_risk:structuredClone(input.residualRisk||{class:missing.length?'high':'low',accepted_by:null,reason:null})};
  if(methodologyPolicy)pkg.methodology_policy_sha256=methodologyPolicy.policy_sha256;
  if(secretHits(pkg).length)fail('evidence-redaction');pkg.package_sha256=sha256(canonicalJson(packagePreimage(pkg)));return pkg;}
function validateEvidencePackage(pkg,verificationPlan,options={}){const errors=[];let plan;
  try{plan=validateVerificationPlan(verificationPlan);}catch(error){return{pass:false,errors:[{code:error.code||'evidence-verification-plan'}]};}
  if(!pkg||pkg.schema_version!==2||!isDigest(pkg.package_sha256))errors.push({code:'evidence-schema'});
  else if(sha256(canonicalJson(packagePreimage(pkg)))!==pkg.package_sha256)errors.push({code:'evidence-digest'});
  for(const [key,expected] of [['verification_plan_sha256',plan.plan_sha256],['spec_id',plan.spec_id],['spec_sha256',plan.spec_sha256],
    ['spec_approved_hash',plan.spec_approved_hash],['risk_profile_sha256',plan.risk_profile_sha256]])
    if(pkg?.[key]!==expected)errors.push({code:'evidence-identity',path:key});
  if(plan.methodology_policy_sha256){let policy=null;try{
      policy=require('./policy-runtime.js').validateMethodologyAuthority(pkg?.policy_snapshot);
    }catch{}
    if(pkg?.methodology_policy_sha256!==plan.methodology_policy_sha256||
        policy?.policy_sha256!==plan.methodology_policy_sha256)
      errors.push({code:'evidence-policy-authority'});
  }else if(Object.hasOwn(pkg||{},'methodology_policy_sha256'))
    errors.push({code:'evidence-identity',path:'methodology_policy_sha256'});
  const ids=new Set();for(const record of pkg?.records||[]){if(ids.has(record.evidence_id))errors.push({code:'evidence-record-identity'});
    ids.add(record.evidence_id);errors.push(...validateRecord(record,plan,options));}
  const satisfied=sorted((pkg?.records||[]).filter((row)=>row.status==='pass').map((row)=>row.gate_id));
  const missing=plan.evidence_required_gate_ids.filter((id)=>!satisfied.includes(id));
  if(!exact(pkg?.completeness?.evidence_required_gate_ids,plan.evidence_required_gate_ids)||
      !exact(pkg?.completeness?.satisfied_gate_ids,satisfied)||!exact(pkg?.completeness?.missing_gate_ids,missing)||
      pkg?.completeness?.complete!==(missing.length===0))errors.push({code:'evidence-completeness'});
  if(secretHits(pkg||{}).length)errors.push({code:'evidence-redaction'});return{pass:errors.length===0,errors};}
function evaluateEvidenceCompleteness(pkg,plan,options={}){const validation=validateEvidencePackage(pkg,plan,options);
  let required=[];try{required=validateVerificationPlan(plan).evidence_required_gate_ids;}catch{}
  const satisfied=sorted((pkg?.records||[]).filter((row)=>row.status==='pass').map((row)=>row.gate_id));
  const missing=required.filter((id)=>!satisfied.includes(id));return{schema_version:2,complete:validation.pass&&missing.length===0,
    satisfied_gate_ids:satisfied,missing_gate_ids:missing,coverage:structuredClone(pkg?.coverage||{}),
    unverified_areas:missing.map((gateId)=>({gate_id:gateId,reason:'missing-required-evidence'})),
    redaction:{passed:validation.pass&&!validation.errors.some((row)=>row.code==='evidence-redaction')}};}
function invalidatedReceiptEvidenceIds(pkg,plan,invalidations=[],options={}){
  if(!Array.isArray(invalidations))fail('receipt-invalidations-state');const receipts=(pkg?.records||[]).filter((row)=>
    row?.kind==='receipt'&&isDigest(row.result?.receipt_set_sha256));const sliceId=options.sliceId||null;return sorted(receipts.filter((record)=>
    invalidations.some((row)=>(!sliceId||row?.slice_id===sliceId)&&row?.receipt_sha256===record.result.receipt_set_sha256&&
      row?.prior_plan_sha256===plan?.plan_projection_sha256&&row?.prior_risk_profile_sha256===plan?.risk_profile_sha256))
    .map((row)=>row.evidence_id));}
function unionEvidenceRecords(left=[],right=[]){const byId=new Map();for(const record of [...left,...right]){const existing=byId.get(record.evidence_id);
  if(existing&&!exact(existing,record))fail('evidence-record-conflict');byId.set(record.evidence_id,record);}return sortedRecords([...byId.values()]);}

function publishContentAddressedEvidencePackage({projectRoot,package:pkg,verificationPlan}={}){
  const valid=validateEvidencePackage(pkg,verificationPlan,{artifactRoot:projectRoot});if(!valid.pass)fail('evidence-package-invalid',
    valid.errors.map((row)=>row.code).join(','));const relative=`evidence/packages/${pkg.package_sha256}.json`;
  durableJson(safeEvidencePath(projectRoot,relative),pkg);return{package_ref:relative,package_sha256:pkg.package_sha256};}
function loadCommittedPackage(root,pointer,plan){if(!pointer?.package_ref||!isDigest(pointer.package_sha256))return null;
  const target=safeEvidencePath(root,pointer.package_ref),stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||
      stat.size>4_194_304)fail('evidence-package-file');const bytes=fs.readFileSync(target);let pkg;try{pkg=JSON.parse(bytes);}catch{fail('evidence-package-json');}
  if(pkg.package_sha256!==pointer.package_sha256||sha256(canonicalJson(packagePreimage(pkg)))!==pointer.package_sha256)
    fail('evidence-package-digest');const valid=validateEvidencePackage(pkg,plan,{artifactRoot:root});
  if(!valid.pass)fail('evidence-package-invalid',valid.errors.map((row)=>row.code).join(','));return pkg;}
function workDirFromFields(stateCapability,fields){const relative=fields.work_dir;if(typeof relative!=='string'||!relative||
    relative.includes('..')||path.isAbsolute(relative))fail('evidence-work-dir');const root=path.resolve(stateCapability.projectRoot,...relative.split('/'));
  if(!root.startsWith(`${path.resolve(stateCapability.projectRoot)}${path.sep}`))fail('evidence-work-dir');const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('evidence-work-dir');return root;}
function parseObject(value,code){if(value&&typeof value==='object'&&!Array.isArray(value))return structuredClone(value);
  try{const parsed=JSON.parse(value||'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))return parsed;}catch{}
  fail(code);}
function evidenceStateProjection(pointer,summary,plan,slices={}){return{schema_version:2,package_ref:pointer.package_ref,
  package_sha256:pointer.package_sha256,verification_plan_sha256:plan.plan_sha256,spec_sha256:plan.spec_sha256,
  risk_profile_sha256:plan.risk_profile_sha256,summary,complete:summary.complete,missing_gate_ids:summary.missing_gate_ids,
  requirement_coverage:summary.coverage?.requirements||null,failure_matrix_coverage:summary.coverage?.failure_matrix||null,
  redaction_passed:summary.redaction?.passed===true,slice_packages:slices};}
async function publishEvidenceUpdate(input={},deps={}){
  if(input.stateCapability){const transaction=require('./transaction-runtime.js');let publication;
    await transaction.journaledStateMutation({stateCapability:input.stateCapability,kind:'evidence-publish',
      preconditions:{evidenceId:input.record?.evidence_id,gateId:input.record?.gate_id,
        expectedBaseSha256:input.expectedBase?.package_sha256||input.expectedBase?.sha256||null},
      retainCompletedJournal:true,
      prepareUnderLock:async(operation)=>{const fields=transaction.readState(input.stateCapability),
        plan=parseObject(fields.verification_plan_json,'evidence-verification-plan-state');
        if(!validateVerificationPlan(plan)||plan.plan_sha256!==fields.verification_plan_sha256||
            (input.verificationPlan&&!exact(input.verificationPlan,plan)))fail('evidence-verification-plan-state');
        const root=workDirFromFields(input.stateCapability,fields),review=parseObject(fields.review_execution_json||'{}','evidence-review-state');
        const currentPointer=review.evidence||null,current=loadCommittedPackage(root,currentPointer,plan);
        const expected=input.expectedBase?.package_sha256||input.expectedBase?.sha256||null;
        if(expected&&currentPointer?.package_sha256!==expected){const baseIds=new Set((input.basePackage?.records||[]).map((row)=>row.evidence_id));
          if(!current||[...baseIds].some((id)=>!current.records.some((row)=>row.evidence_id===id)))fail('evidence-base-stale');}
        const record=materializeRecordUnderLock({artifactRoot:root,record:input.record});
        if(record.artifact_ref)await operation.recordStage('artifact-written',{owned:{artifact_ref:record.artifact_ref,
          artifact_sha256:record.artifact_sha256,evidence_id:record.evidence_id}});
        const records=unionEvidenceRecords(current?.records||input.basePackage?.records||[],[record]),scope=input.scope||{kind:'session',
          id:transaction.sessionIdFromState(input.stateCapability)};const packageInput={...input.packageInput,verificationPlan:plan,scope,
          artifactRoot:root,riskSnapshot:input.riskSnapshot||parseObject(fields.risk_profile_json||'{}','evidence-risk-state'),
          policySnapshot:input.policySnapshot||parseObject(fields.methodology_policy_json||'{}','evidence-policy-state'),records};
        const pkg=buildEvidencePackage(packageInput),pointer=publishContentAddressedEvidencePackage({projectRoot:root,package:pkg,
          verificationPlan:plan}),summary=evaluateEvidenceCompleteness(pkg,plan,{artifactRoot:root});
        await operation.recordStage('package-written',{owned:{...pointer,evidence_id:record.evidence_id}});
        const slicePointers=structuredClone(currentPointer?.slice_packages||{});if(scope.kind==='slice')slicePointers[scope.id]=pointer;
        review.evidence=evidenceStateProjection(pointer,summary,plan,slicePointers);publication={beforeStateSha256:sha256(canonicalJson(fields)),
          patch:{review_execution_json:canonicalJson(review)},package:pkg,summary,record,pointer,plan,root};},
      reducer:async(fields)=>{if(!publication||sha256(canonicalJson(fields))!==publication.beforeStateSha256)
          fail('evidence-publish-state-changed');return publication.patch;},
      afterStateCommitUnderLock:async(operation)=>{if(!publication)fail('evidence-publish-preparation');
        const fields=transaction.readState(input.stateCapability),review=parseObject(fields.review_execution_json||'{}','evidence-review-state'),
          committed=review.evidence,loaded=loadCommittedPackage(publication.root,committed,publication.plan);
        if(!loaded||loaded.package_sha256!==publication.package.package_sha256||!exact(committed,
            evidenceStateProjection(publication.pointer,publication.summary,publication.plan,committed.slice_packages||{})))
          fail('evidence-pointer-postcondition');
        await operation.recordStage('pointer-committed',{owned:{...publication.pointer,evidence_id:publication.record.evidence_id,
          summary_sha256:sha256(canonicalJson(publication.summary))}});}});return{package:publication.package,summary:publication.summary,
      record:publication.record,pointer:publication.pointer};
  }
  if(typeof deps.readCurrentBase!=='function'||typeof deps.commitCandidate!=='function')fail('evidence-publisher-capability');
  const previous=TEST_PUBLISH_TAILS.get(deps)||Promise.resolve();let release;const barrier=new Promise((resolve)=>{release=resolve;});
  TEST_PUBLISH_TAILS.set(deps,previous.catch(()=>{}).then(()=>barrier));await previous.catch(()=>{});try{
  const current=await deps.readCurrentBase();let base=input.basePackage;if(!exact(current,input.expectedBase)){
    if(!current?.package||current.package.package_sha256!==current.sha256||
        !validateEvidencePackage(current.package,input.packageInput.verificationPlan,{artifactRoot:input.packageInput.artifactRoot}).pass)
      fail('evidence-base-stale');const expectedIds=new Set((input.basePackage?.records||[]).map((row)=>row.evidence_id));
    if([...expectedIds].some((id)=>!current.package.records.some((row)=>row.evidence_id===id)))fail('evidence-base-stale');base=current.package;}
  const records=unionEvidenceRecords(base?.records||[],[input.record]),pkg=buildEvidencePackage({...input.packageInput,records});
  const summary=evaluateEvidenceCompleteness(pkg,input.packageInput.verificationPlan,{artifactRoot:input.packageInput.artifactRoot});
  await deps.commitCandidate({package:pkg,summary,currentBase:current});return{package:pkg,summary};}finally{release();}}
async function publishAuthenticatedRecord(record,context={}){if(!validateProducerProof(record))fail('protected-evidence-producer');
  if(!context.stateCapability)fail('evidence-publisher-capability');return publishEvidenceUpdate({...context,record});}
async function publishEvidenceUpdateWithinFinishOperation(input={},finishContext,deps={}){const binding=
  require('./session-store.js').validateActiveFinishContext(finishContext,{sessionId:input.sessionId,
    stateCapability:input.stateCapability,outcome:input.outcome});if(typeof deps.commitWithinLock!=='function')
    fail('finish-evidence-publisher');return deps.commitWithinLock(input,Object.freeze({projectCapability:binding.projectCapability,
      caps:binding.caps,finishContext}));}

function loadFinishGateContext(input={}){const plan=input.verificationPlan,pkg=input.evidencePackage,
  policy=require('./verification-policy-runtime.js'),artifactRoot=input.artifactRoot;
  if(!policy.validateVerificationPlan(plan).pass||!validateEvidencePackage(pkg,plan,{artifactRoot}).pass)fail('finish-gate-context');
  if(input.compatibilityMode!==plan.compatibility_mode)fail('finish-gate-context');
  const summary=evaluateEvidenceCompleteness(pkg,plan,{artifactRoot}),invalidations=input.receiptInvalidations||[];
  const invalidatedEvidenceIds=invalidatedReceiptEvidenceIds(pkg,plan,invalidations);
  const residual=policy.computeResidualRisk({initialRisk:input.initialRisk,finalRisk:input.finalRisk,evidenceSummary:summary,
    unverifiedAreas:summary.unverified_areas,riskAcceptances:input.riskAcceptances||[]});
  const satisfied=require('./governed-context-runtime.js').deriveAdmissionSatisfiedGateIds(
    summary,summary.satisfied_gate_ids,{humanAckSatisfied:input.humanAckSatisfied===true&&
      plan.risk_class==='critical'});const endpoint=input.enforcementPoint||'finish';const required=
    policy.requiredGateIds(plan,{at:endpoint});for(const id of policy.requiredGateIds(plan,{at:'finish'})){const gate=
      plan.gates.find((row)=>row.id===id);if(gate?.enforcement_point==='test-and-finish')required.push(id);}return{
    compatibility_mode:input.compatibilityMode||plan.compatibility_mode,evidence_summary:summary,residual_risk:residual,
    invalidated_evidence_ids:sorted(invalidatedEvidenceIds),required_gate_ids:sorted([...new Set(required)]),
    satisfied_gate_ids:sorted(satisfied),verification_plan:plan,
    package_sha256:pkg.package_sha256};}
function attachEvidenceToReceipt(payload,{package:pkg,summary,verificationPlan,state={},artifactRoot}={}){
  if(!payload||payload.schema_version!=='1.0')fail('receipt-schema-version');const projections=['evidence','risk_snapshot',
    'policy_snapshot','contract_trace','reviews','unverified_areas','methodology','risk_acceptances','review_summary',
    'spec_contract','context_policy'];for(const key of [...projections,'verification_summary','residual_risk'])
    if(Object.hasOwn(payload,key))fail('receipt-evidence-conflict');if(payload.risk&&Object.hasOwn(payload.risk,'residual'))
    fail('receipt-evidence-conflict');const validation=verificationPlan?validateEvidencePackage(pkg,verificationPlan,{artifactRoot}):
      {pass:Boolean(summary?.complete)};const completeness=verificationPlan?evaluateEvidenceCompleteness(pkg,verificationPlan,{artifactRoot}):summary;
  if(!pkg||pkg.schema_version!==2||!validation.pass||!completeness?.complete)fail('receipt-evidence-incomplete');
  const next={...structuredClone(payload),evidence:structuredClone(pkg),risk_snapshot:structuredClone(pkg.risk_snapshot),
    policy_snapshot:structuredClone(pkg.policy_snapshot),contract_trace:structuredClone(pkg.contract_trace),
    reviews:structuredClone(pkg.reviews),unverified_areas:structuredClone(completeness.unverified_areas||pkg.unverified_areas)};
  for(const [target,source] of [['methodology','methodology'],['risk_acceptances','risk_acceptances_json'],
    ['review_summary','review_execution_json'],['spec_contract','spec_contract_json'],['context_policy','context_policy_json']]){
    if(state[source]!==undefined&&state[source]!==null&&state[source]!==''){let value=state[source];
      if(typeof value==='string'&&source.endsWith('_json'))try{value=JSON.parse(value);}catch{fail('receipt-state-projection');}
      next[target]=structuredClone(value);}}return next;}

module.exports={redactEvidenceText,captureCommandEvidence,buildEvidencePackage,validateEvidencePackage,
  evaluateEvidenceCompleteness,validateVerificationPlan,publishEvidenceUpdate,attachEvidenceToReceipt,
  publishEvidenceUpdateWithinFinishOperation,captureContractEvidence,captureReviewEvidence,captureReceiptEvidence,
  validateAdapterPlan,runEvidenceAdapter,captureRuntimeProjectionEvidence,publishAuthenticatedRecord,
  publishRedactedEvidenceArtifactUnderLock,publishContentAddressedEvidencePackage,unionEvidenceRecords,
  loadFinishGateContext,loadCommittedPackage,materializeRecordUnderLock,secretHits,validateProducerProof,
  invalidatedReceiptEvidenceIds};
