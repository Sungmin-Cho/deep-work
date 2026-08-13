#!/usr/bin/env node
'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {buildDispatcherHandlers,enforceDispatcherPhase}=require('../runtime/dispatcher-routes.js');
const {ROUTE_CONTRACTS}=require('./deep-work-route-contracts.js');

const ACTIVE_PHASES=['brainstorm','research','spec','plan','implement','test'];
const PHASES=[...ACTIVE_PHASES,'idle'];

function fail(code,message){const error=new Error(`[${code}] ${message||code}`);error.code=code;error.validation=true;throw error;}
function words(value){return value.split(' ');}
function grammar(id,required=[],optional=[],enums={}){
  const explicit=ROUTE_CONTRACTS.get(id);if(!explicit)fail('route-contract-missing',id);
  return Object.freeze({id,tokens:Object.freeze(words(id)),required:Object.freeze(required),
    optional:Object.freeze(optional),enums:Object.freeze(enums),destructive:explicit.destructive,
    capabilityKind:explicit.capabilityKind,readSet:Object.freeze(explicit.readSet),writeSet:Object.freeze(explicit.writeSet),
    mutableFields:Object.freeze(explicit.mutableFields),allowedPhases:Object.freeze(explicit.allowedPhases),lockDomain:explicit.lockDomain,
    lockRanks:Object.freeze(explicit.lockRanks),recoveryKind:explicit.recoveryKind,operationKind:explicit.operationKind,
    phase5Allowed:explicit.phase5Allowed});}

const rows=[
  grammar('session context',[],['session']),
  grammar('session authority validate',['state']),
  grammar('git capability'),
  grammar('git changed',['base'],['paths-json']),
  grammar('temp create',['state','session','purpose'],[],{purpose:['artifact-input','review-prompt','verification-spec','phase-result','gate-results','receipt-payload','pr-title','pr-body','handoff-payload','reason','notes','selection']}),
  grammar('temp write',['state','session','temp-operation-id','stdin']),
  grammar('temp remove',['state','session','temp-operation-id','expected-sha256']),
  grammar('session registry read',['project-root']),
  grammar('session registry own',['state','session','path']),
  grammar('session registry touch',['state','session','at']),
  grammar('session registry phase',['state','session','phase','at'],[],{phase:PHASES}),
  grammar('session pointer select',['session']),
  grammar('session repository prepare',['session','mode','task-file','defaults-json'],['profile-json','base-ref'],{mode:['worktree','new-branch','current-branch']}),
  grammar('session fork',['parent','from-phase','reason'],['dirty-resolution'],{
    'from-phase':ACTIVE_PHASES,'dirty-resolution':['commit','stash-apply','abort'],
    reason:['alternative-experiment','independent-review','parallel-slice',
      'recovery','security-isolation']}),
  grammar('session finish merge',['state','session','receipt-payload'],['dirty-resolution'],{'dirty-resolution':['commit','abort']}),
  grammar('session finish publish-pr',['state','session','receipt-payload','title-file','body-file']),
  grammar('session finish keep',['state','session','receipt-payload']),
  grammar('session finish discard',['state','session','receipt-payload'],['force']),
  grammar('session cleanup scan'),
  grammar('session cleanup remove',['state','session','worktree'],['force']),
  grammar('session cache-clear',['session']),
  grammar('session initialize',['task-file','flags-json','profile-json']),
  grammar('session state migrate-schema',['state','session']),
  grammar('session execution set',['state','session','mode'],[],{mode:['inline','delegate','auto']}),
  grammar('session state migrate-model-routing',['state','session']),
  grammar('session recovery worktree',['state','session']),
  grammar('session finalize',['state','session','finished-at']),
  grammar('phase begin',['state','phase','at'],[],{phase:ACTIVE_PHASES}),
  grammar('phase complete',['state','phase','result-json','at'],[],{phase:ACTIVE_PHASES.slice(0,-1)}),
  grammar('phase approve',['state','phase','artifact','at'],[],{phase:['research','plan']}),
  grammar('phase spec enter',['state','at']),
  grammar('phase spec approve',['state','artifact','at'],['spec-review-ref-sha256']),
  grammar('phase advance',['state','from','to','at'],[],{from:ACTIVE_PHASES.slice(0,-1),to:['research','spec','plan','implement','test']}),
  grammar('phase rerun',['state','phase'],['affected-slices-json'],{phase:ACTIVE_PHASES}),
  grammar('phase invalidate-replan',['state','reason','from-risk','to-risk','affected-slices-json','risk-profile-sha256','at'],[],{
    reason:['risk-class-increase','scope-expansion','public-contract','invariant','failure-state','external-side-effect','unplanned-mock','repeated-root-cause','persistent-state-transition','spike-promotion'],
    'from-risk':['low','medium','high'],'to-risk':['medium','high','critical']}),
  grammar('replan discovery publish',['state','plan','observation-json']),
  grammar('replan discovery dispatch',['state','plan','producer-operation-id'],['slice']),
  grammar('replan risk publish',['state','plan','next-risk-profile-json']),
  grammar('replan risk dispatch',['state','plan','producer-operation-id','scope'],
    ['slice'],{scope:['slice','session']}),
  grammar('replan root-cause record',['state','plan','source-kind',
    'source-operation-id'],[],{'source-kind':['debug-root',
      'verification-result']}),
  grammar('replan root-cause derive',['state','plan','operation-id']),
  grammar('replan root-cause dispatch',['state','plan','operation-id']),
  grammar('replan complete',['state','plan']),
  grammar('release gate fact-publish',['state','plan','checker',
    'input-refs-json'],[],{checker:['spec-gate-v1','changed-js-syntax-v1',
      'release-integrity-v1','single-review-v1','mutation-critical-path-v1',
      'rollback-rehearsal-v1','governed-health-v1','governed-evidence-v1',
      'evidence-redaction-v1','dual-final-review-v1','human-ack-v1']}),
  grammar('release gate result-publish',['state','plan','fact-operation-id']),
  grammar('release gate command-run',['state','plan','command'],[],{
    command:['carrier','tdd','replan','integration','targeted','full','pack']}),
  grammar('release gate integrity-run',['state','plan']),
  grammar('release verification complete',['state','plan','slice',
    'gate-results-json','functional-receipts-json']),
  grammar('implement delegation set',['state','plan','assignment-json','snapshot']),
  grammar('implement delegation clear',['state','snapshot']),
  grammar('implement write begin',['state','plan','slice','class','scope-sha256'],['delegation-operation-id','cluster'],{class:['failing-test','production','refactor']}),
  grammar('implement write accept',['state','plan','slice','operation-id','pre-manifest-sha256']),
  grammar('implement tdd transition',['state','plan','slice','to'],['verification-result','verification-sha256','verification-operation-id','sensor-operation-ids','sensor-results-sha256','after-write-operation-id'],{to:['PENDING','RED_VERIFIED','GREEN','SENSOR_RUN','SENSOR_FIX','SENSOR_CLEAN','SPIKE']}),
  grammar('implement slice complete',['state','plan','receipts-dir','slice','receipt-payload']),
  grammar('implement slice complete-v2',['state','plan','slice','green-ref-json',
    'refactor-evidence-json']),
  grammar('implement refactor no-change',['state','plan','slice',
    'green-ref-json','reason'],[],{reason:['no-clarity-gain','no-duplication',
      'risk-outweighs-change']}),
  grammar('implement override set',['state','slice','reason-file']),grammar('implement override clear',['state','slice']),
  grammar('implement takeover set',['state','plan','receipts-dir','cluster-file','delegation-snapshot']),
  grammar('implement takeover clear',['state','plan','receipts-dir','cluster-file','delegation-snapshot']),
  grammar('verification migrate-spec',['plan','scope','id','spec-json'],[],{scope:['slice','quality-gate']}),
  grammar('verification run',['state','plan','spec-json','expected'],['slice','gate-id'],{expected:['must-fail','must-pass']}),
  grammar('verification run-v2',['state','plan','slice'],['expected'],{
    expected:['must-fail','must-pass']}),
  grammar('verification red-transition',['state','plan','slice','verification-operation-id',
    'verification-result-sha256']),
  grammar('verification proof-publish',['state','plan','slice','transition-operation-id']),
  grammar('bootstrap failure-publish',['state','authorization','failure']),
  grammar('bootstrap abort',['state','authorization','failure']),
  grammar('bootstrap finalize',['state','authorization','execution']),
  grammar('bootstrap first-red',['state','plan','authorization','receipt','marker','spec-json','slice','write-receipt']),
  grammar('bootstrap red-adopt',['state','plan','authorization','receipt','marker','slice','bridge-operation-id']),
  grammar('bootstrap proof-publish',['state','plan','slice','transition-operation-id']),
  grammar('evidence record contract',['state','plan','gate-id','spec','evidence-id']),
  grammar('evidence record review',['state','plan','gate-id','review-plan-json','reports-json','evidence-id']),
  grammar('evidence record receipt',['state','plan','gate-id','receipts-json','verification-result-json','evidence-id']),
  grammar('test pass',['state','plan','gate-results-json','at']),
  grammar('test retry',['state','plan','receipts-dir','failed-slices-json','at']),
  grammar('test exhaust',['state','plan','receipts-dir','failed-slices-json','at']),
  grammar('mutation round begin',['state','survived-json','round'],[],{round:['1','2','3']}),
  grammar('mutation round end',['state','verification-json','round'],[],{round:['1','2','3']}),
  grammar('mutation record',['state','result-json']),
  grammar('debug enter',['state','slice']),grammar('debug complete',['state','receipts-dir','slice','note-file','verification-json']),
  grammar('debug exit',['state','verification-json']),
  grammar('phase review record',['state','phase','structural-json','structural-md'],['adversarial-json'],{phase:['brainstorm','research','plan']}),
  grammar('artifact publish',['state','kind','input'],['slice','area','iteration'],{kind:['brainstorm','research','research-area','plan','plan-backup','plan-diff','test-results','quality-gates','cross-slice-review','solid-review','insight-report','drift-report','fidelity-score','debug-root-cause'],area:['architecture','patterns','risks','tech-stack','conventions','data-model']}),
  grammar('analysis drift record',['state','report','score-file']),grammar('receipt dashboard',['state']),
  grammar('receipt view',['state','slice']),grammar('receipt export',['state','format'],[],{format:['json','md','ci']}),
  grammar('history list',['project-root']),grammar('report generate',['state']),
  grammar('git report commit',['state']),
  grammar('slice activate',['state','plan','slice']),grammar('slice spike',['state','slice']),
  grammar('slice reset',['state','plan','receipts-dir','slice']),
  grammar('slice model',['state','slice','model'],[],{model:['haiku','sonnet','opus','main','auto']}),
  grammar('git delegated rollback',['state','receipts-dir','snapshot']),
  grammar('git stash publish',['session','purpose'],['include-untracked'],{purpose:['fork','slice-reset']}),
  grammar('git stash apply',['session','operation-id']),
  grammar('git stash drop',['session','operation-id']),
  grammar('review run',['engine','prompt-file','timeout-ms','mode'],['effort','model'],{
    engine:['codex','gemini'],mode:['read-only'],effort:['medium','high','xhigh','max']}),
  grammar('review envelope validate',['request-json','receipt-json']),
  grammar('review finding-publish',['state','point','round','finding','artifact',
    'artifact-kind']),
  grammar('sensor detect',['project-root']),grammar('sensor run',['kind','process-spec-json','parser','budget-ms'],['state','session','plan','slice','after-write-operation-id'],{kind:['lint','typecheck','coverage','mutation'],parser:['eslint','tsc','ruff','stryker','clang-tidy','generic-json','generic-line','generic','mutation']}),
  grammar('sensor review-check',['project-root'],['topology','changed-files-json','state','session','plan','slice','after-write-operation-id']),
  grammar('topology detect',['project-root']),grammar('health fitness-proposal',['project-root']),
  grammar('health check',['project-root'],['fitness-file','skip-audit']),grammar('health research-state',['state','report-json']),
  grammar('capability detect',['project-root']),grammar('recommender input',['input-json']),
  grammar('recommender validate',['result-file','capability-json']),grammar('ask options',['input-json']),
  grammar('profile migrate',['profile-file'],['initial-preset']),grammar('profile load',['profile-file'],['initial-preset']),
  grammar('profile update',['profile-file','reason','preset','defaults-json'],[],{reason:['setup','first-run-answers']}),
  grammar('flags parse',['arguments-json']),
];

const DISPATCHER_GRAMMAR=Object.freeze(rows);
const PHASE5_DISPATCHER_COMMANDS=Object.freeze(DISPATCHER_GRAMMAR.filter((entry)=>entry.phase5Allowed));
const METADATA_FIELDS=Object.freeze(['capabilityKind','readSet','writeSet','mutableFields','allowedPhases','lockDomain',
  'lockRanks','recoveryKind','operationKind','destructive','phase5Allowed']);
const DISPATCHER_METADATA=new Map(DISPATCHER_GRAMMAR.map((entry)=>[entry.id,Object.freeze(Object.fromEntries(
  METADATA_FIELDS.map((field)=>[field,Array.isArray(entry[field])?Object.freeze([...entry[field]]):entry[field]])))]));
function sameMetadata(left,right){return JSON.stringify(left)===JSON.stringify(right);}
function validateGrammarContract(entry){if(!entry||typeof entry.id!=='string'||!DISPATCHER_METADATA.has(entry.id))fail('grammar-contract',entry?.id);
  const expected=DISPATCHER_METADATA.get(entry.id);for(const field of METADATA_FIELDS)if(!Object.hasOwn(entry,field)||
    !sameMetadata(entry[field],expected[field]))fail('grammar-metadata',`${entry.id}:${field}`);return entry;}
const DISPATCHER_HANDLERS=buildDispatcherHandlers();
if(DISPATCHER_HANDLERS.size!==DISPATCHER_GRAMMAR.length||DISPATCHER_GRAMMAR.some((entry)=>!DISPATCHER_HANDLERS.has(entry.id)))
  fail('dispatcher-handler-contract');
function validGitRef(value){if(typeof value!=='string'||!value||value.length>255||/[\0-\x20\x7f\\:?*\[]/.test(value)||
    value.startsWith('-')||value.endsWith('/')||value.endsWith('.')||value.includes('..')||value.includes('@{')||value.includes('//'))return false;
  if(/^HEAD(?:~[1-9]\d*)?$/.test(value)||/^[0-9a-f]{7,64}$/.test(value))return true;
  return /^(?:refs\/(?:heads|tags)\/)?[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)&&
    value.split('/').every((segment)=>segment&&segment!=='.'&&segment!=='..'&&!segment.endsWith('.lock'));
}

function parseDispatcher(argv){
  if(!Array.isArray(argv)||argv.some((item)=>typeof item!=='string'))fail('dispatcher-argv');
  const matches=DISPATCHER_GRAMMAR.filter((entry)=>entry.tokens.every((token,index)=>argv[index]===token));
  if(!matches.length)fail('unknown-command',argv.join(' '));const entry=matches.sort((a,b)=>b.tokens.length-a.tokens.length)[0];
  const remainder=argv.slice(entry.tokens.length);const flags={};
  for(let index=0;index<remainder.length;index++){
    const token=remainder[index];if(!token.startsWith('--')||token.length<3)fail('unexpected-argument',token);
    const name=token.slice(2);if(Object.hasOwn(flags,name))fail('duplicate-flag',name);
    if(!entry.required.includes(name)&&!entry.optional.includes(name))fail('unknown-flag',name);
    if(['force','include-untracked','skip-audit','stdin'].includes(name)){flags[name]=true;continue;}
    if(index+1>=remainder.length||remainder[index+1].startsWith('--'))fail('missing-flag-value',name);
    flags[name]=remainder[++index];
  }
  for(const name of entry.required)if(!Object.hasOwn(flags,name))fail('missing-required-flag',name);
  for(const [name,values] of Object.entries(entry.enums))if(Object.hasOwn(flags,name)&&!values.includes(flags[name]))fail('invalid-enum',`${name}=${flags[name]}`);
  for(const name of ['session','parent'])if(Object.hasOwn(flags,name)&&!/^s-[0-9a-f]{8}$/.test(flags[name]))fail('session-id',flags[name]);
  for(const name of ['slice'])if(Object.hasOwn(flags,name)&&!/^SLICE-\d{3}$/.test(flags[name]))fail('slice-id',flags[name]);
  for(const name of ['at','finished-at'])if(Object.hasOwn(flags,name)&&!Number.isFinite(Date.parse(flags[name])))fail('timestamp',flags[name]);
  for(const name of ['expected-sha256','scope-sha256','verification-sha256','sensor-results-sha256','pre-manifest-sha256'])
    if(Object.hasOwn(flags,name)&&!/^[0-9a-f]{64}$/.test(flags[name]))fail('sha256',name);
  for(const name of ['bridge-operation-id','transition-operation-id'])
    if(Object.hasOwn(flags,name)&&!/^op-[0-9a-f]{64}$/.test(flags[name]))fail('operation-id',name);
  for(const name of ['temp-operation-id','operation-id','verification-operation-id','after-write-operation-id','delegation-operation-id'])
    if(Object.hasOwn(flags,name)&&!/^op-[0-9a-f]{32,64}$/.test(flags[name]))fail('operation-id',name);
  for(const name of ['snapshot','delegation-snapshot'])if(Object.hasOwn(flags,name)&&
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(flags[name]))fail('git-object-id',name);
  for(const name of ['base','base-ref'])if(Object.hasOwn(flags,name)&&!validGitRef(flags[name]))fail('git-ref',name);
  if(entry.id==='review run'&&Object.hasOwn(flags,'model')&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(flags.model))fail('review-model');
  for(const [name,min,max] of [['timeout-ms',100,600000],['budget-ms',100,600000],['iteration',1,20]]){
    if(Object.hasOwn(flags,name)){const value=Number(flags[name]);if(!Number.isSafeInteger(value)||value<min||value>max)
      fail('numeric-bound',`${name}=${flags[name]}`);}}
  if(entry.id==='implement tdd transition'){
    const verification=['verification-result','verification-sha256','verification-operation-id'];
    const verificationCount=verification.filter((name)=>Object.hasOwn(flags,name)).length;
    const consumesVerification=['RED_VERIFIED','GREEN'].includes(flags.to);
    if(consumesVerification&&verificationCount!==verification.length)fail('verification-flag-group');
    if(!consumesVerification&&verificationCount)fail('verification-flags-extra');
    const sensorFlags=['sensor-operation-ids','sensor-results-sha256','after-write-operation-id'];
    const sensorCount=sensorFlags.filter((name)=>Object.hasOwn(flags,name)).length;
    if(sensorCount&&sensorCount!==sensorFlags.length)fail('sensor-flag-group');
    if(sensorCount&& !['SENSOR_FIX','SENSOR_CLEAN'].includes(flags.to))fail('sensor-flags-extra');
    if(sensorCount){let ids;try{ids=JSON.parse(flags['sensor-operation-ids']);}catch{fail('sensor-operation-ids');}
      if(!Array.isArray(ids)||!ids.length||ids.some((id)=>typeof id!=='string'||!/^op-[0-9a-f]{32,64}$/.test(id))||
          new Set(ids).size!==ids.length||ids.some((id,index)=>index&&Buffer.compare(Buffer.from(ids[index-1]),Buffer.from(id))>=0)||
          JSON.stringify(ids)!==flags['sensor-operation-ids'])fail('sensor-operation-ids');}
  }
  if(entry.id==='sensor run'||entry.id==='sensor review-check'){
    const context=['state','session','plan','slice','after-write-operation-id'];
    const count=context.filter((name)=>Object.hasOwn(flags,name)).length;
    if(count!==0&&count!==context.length)fail('sensor-context-group');
  }
  if(entry.id==='verification run'&&Number(Object.hasOwn(flags,'slice'))+Number(Object.hasOwn(flags,'gate-id'))!==1)
    fail('verification-target');
  if(entry.id==='artifact publish'){
    const hasArea=Object.hasOwn(flags,'area');const hasIteration=Object.hasOwn(flags,'iteration');
    if((flags.kind==='research-area')!==hasArea)fail('artifact-area');
    if((flags.kind==='plan-backup')!==hasIteration)fail('artifact-iteration');
  }
  return {entry,flags};
}

async function dispatch(argv,{cwd=process.cwd(),stdin=''}={}){
  const parsed=parseDispatcher(argv);validateGrammarContract(parsed.entry);const handler=DISPATCHER_HANDLERS.get(parsed.entry.id);
  if(typeof handler!=='function')fail('dispatcher-handler-contract',parsed.entry.id);
  await enforceDispatcherPhase({entry:parsed.entry,f:parsed.flags,cwd});
  return handler({entry:parsed.entry,f:parsed.flags,cwd,stdin});
}

async function main(){try{const result=await dispatch(process.argv.slice(2));process.stdout.write(`${JSON.stringify(result)}\n`);}
  catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=error.validation?1:2;}}
if(require.main===module)void main();
module.exports={DISPATCHER_GRAMMAR,PHASE5_DISPATCHER_COMMANDS,DISPATCHER_HANDLERS,DISPATCHER_METADATA,
  validateGrammarContract,parseDispatcher,dispatch};
