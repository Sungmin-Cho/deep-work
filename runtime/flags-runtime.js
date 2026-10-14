'use strict';

const { TIERS, MAIN, allConcreteModels } = require('./model-catalog.js');
const { CAPABILITIES } = require('./model-capabilities.js');

function fail(code,message){const error=new Error(`[${code}] ${message||code}`);error.code=code;throw error;}
const ENUMS=Object.freeze({tdd:new Set(['adaptive','strict','relaxed','coaching','spike']),
  team:new Set(['solo','team']),exec:new Set(['inline','delegate'])});
const RECOMMENDER_ALLOWLIST=/^(haiku|sonnet|opus)$/;const EXEC_ALLOWLIST=/^(inline|delegate)$/;
const PROFILE_NAME_ALLOWLIST=/^[a-z0-9][a-z0-9_-]{0,30}$/i;const TDD_ALLOWLIST=/^(adaptive|strict|relaxed|coaching|spike)$/;
const RESUME_FROM_ALLOWLIST=/^(brainstorm|research|spec|plan|implement|test)$/;const SESSION_ALLOWLIST=/^[\w.-]+$/;
const POLICY_ALLOWLIST=/^(adaptive|shadow)$/;const RISK_ALLOWLIST=/^(low|medium|high|critical)$/;
const REVIEW_ALLOWLIST=/^(auto|single|dual)$/;
const WORKTREE_PATH_BLOCKLIST=/[;|&`$(){}[\]<>!#*?\\]/;
const MODEL_ROUTING_PHASES=new Set(['brainstorm','research','plan','implement','test']);
function parseModelRoutingValue(raw){const warnings=[];const entries=[];
  const allowed=new Set([...TIERS,MAIN,...allConcreteModels(),...Object.keys(CAPABILITIES)]);
  for(const entry of String(raw||'').split(',')){
    const m=entry.match(/^([a-z]+)=([A-Za-z0-9._-]+)$/);
    if(!m||!MODEL_ROUTING_PHASES.has(m[1])){
      warnings.push(`--model-routing 항목 '${entry}' 무효 — 무시. 형식: phase=tier|model (공백 불가)`);continue;}
    if(!allowed.has(m[2]))warnings.push(`model '${m[2]}' requires runtime capability verification; pin preserved`);
    entries.push(`${m[1]}=${m[2]}`);}
  return{entries,warnings};}

function parseDeepWorkFlags(argumentTokens){
  if(!Array.isArray(argumentTokens)||argumentTokens.some((token)=>typeof token!=='string'))fail('argument-array');
  const result={tdd:null,team:null,positionals:[],execution:null};const seen=new Set();
  for(const token of argumentTokens){
    if(token==='--')continue;
    if(token==='--autonomous'||token==='--interactive-gates'){const mode=token==='--autonomous'?'autonomous':'interactive';
      if(result.continuation_mode&&result.continuation_mode!==mode)fail('continuation-conflict');result.continuation_mode=mode;continue;}
    if(!token.startsWith('--')){result.positionals.push(token);continue;}
    const match=token.match(/^--(tdd|team|exec)=(.+)$/);
    if(!match)fail('unknown-flag',token);
    const [,key,value]=match;if(seen.has(key))fail('duplicate-flag',key);seen.add(key);
    if(!ENUMS[key].has(value))fail('flag-enum',`${key}=${value}`);
    if(key==='exec')result.execution=value;else result[key]=value;
  }
  return result;
}
function parseFlags(args){if(!Array.isArray(args)||args.some((arg)=>typeof arg!=='string'))fail('argument-array');
  const flags={profile:null,recommender:null,no_ask:false,no_recommender:false,team:false,zero_base:false,
    skip_research:false,skip_brainstorm:false,skip_review:false,no_branch:false,skip_to_implement:false,
    skip_integrate:false,setup:false,tdd_mode:null,resume_from:null,exec_mode:null,session:null,worktree:null,
    cross_model:false,no_cross_model:false,force_rerun:false,model_routing:null,
    continuation_mode:null,policy:'adaptive',risk:null,review:'auto',task:'',warnings:[]};const task=[];
  const bools={'--no-ask':'no_ask','--no-recommender':'no_recommender','--setup':'setup','--team':'team',
    '--zero-base':'zero_base','--skip-research':'skip_research','--skip-brainstorm':'skip_brainstorm',
    '--skip-review':'skip_review','--no-branch':'no_branch','--skip-to-implement':'skip_to_implement',
    '--skip-integrate':'skip_integrate','--cross-model':'cross_model','--no-cross-model':'no_cross_model',
    '--force-rerun':'force_rerun'};
  for(const arg of args){if(arg==='--')continue;
    if(arg==='--autonomous'||arg==='--interactive-gates'){const mode=arg==='--autonomous'?'autonomous':'interactive';
      if(flags.continuation_mode&&flags.continuation_mode!==mode)fail('continuation-conflict');flags.continuation_mode=mode;continue;}if(Object.hasOwn(bools,arg)){flags[bools[arg]]=true;continue;}
    if(arg.startsWith('--profile=')){const v=arg.slice(10);if(!v)flags.warnings.push('--profile= 빈 값 — 무시');
      else if(PROFILE_NAME_ALLOWLIST.test(v))flags.profile=v;else flags.warnings.push(`'${v}' 잘못된 프리셋 이름 — 영문/숫자/-/_만 허용 (≤31자), 무시`);}
    else if(arg.startsWith('--tdd=')){const v=arg.slice(6);if(!v)flags.warnings.push('--tdd= 빈 값 — 무시. 허용: strict|relaxed|coaching|spike');
      else if(TDD_ALLOWLIST.test(v))flags.tdd_mode=v;else flags.warnings.push(`'${v}' 허용되지 않는 tdd 모드 — 무시. 허용: strict|relaxed|coaching|spike`);}
    else if(arg.startsWith('--exec=')){const v=arg.slice(7);if(!v)flags.warnings.push('--exec=가 빈 값 — 무시. 허용: inline|delegate');
      else if(EXEC_ALLOWLIST.test(v))flags.exec_mode=v;else flags.warnings.push(`'${v}'은(는) 허용되지 않는 exec 모드 — 무시. 허용: inline|delegate`);}
    else if(arg.startsWith('--recommender=')){const v=arg.slice(14);if(RECOMMENDER_ALLOWLIST.test(v))flags.recommender=v;
      else flags.warnings.push(`'${v}'은(는) 허용되지 않는 recommender 모델 — sonnet으로 fallback. 허용: haiku|sonnet|opus`);}
    else if(arg.startsWith('--resume-from=')){const v=arg.slice(14);if(!v)flags.warnings.push('--resume-from= 빈 값 — 무시. 허용: brainstorm|research|spec|plan|implement|test');
      else if(RESUME_FROM_ALLOWLIST.test(v))flags.resume_from=v;else flags.warnings.push(`'${v}' 허용되지 않는 resume phase — 무시. 허용: brainstorm|research|spec|plan|implement|test`);}
    else if(arg.startsWith('--session=')){const v=arg.slice(10);if(!v)flags.warnings.push('--session= 빈 값 — 무시');
      else if(SESSION_ALLOWLIST.test(v))flags.session=v;else flags.warnings.push(`'${v}' 잘못된 session ID — 영문/숫자/dash/dot만 허용, 무시`);}
    else if(arg.startsWith('--worktree=')){const v=arg.slice(11);if(!v)flags.warnings.push('--worktree= 빈 값 — 무시');
      else if(WORKTREE_PATH_BLOCKLIST.test(v))flags.warnings.push(`'${v}' 잘못된 worktree 경로 — shell 메타문자 포함 불가, 무시`);else flags.worktree=v;}
    else if(arg.startsWith('--model-routing=')){const v=arg.slice(16);
      const{entries,warnings:mw}=parseModelRoutingValue(v);flags.warnings.push(...mw);
      flags.model_routing=entries.length?entries.join(','):null;}
    else if(arg.startsWith('--policy=')){const v=arg.slice(9);
      if(POLICY_ALLOWLIST.test(v))flags.policy=v;
      else flags.warnings.push(`--policy '${v}' 무효 — 무시. 허용: adaptive|shadow`);}
    else if(arg.startsWith('--risk=')){const v=arg.slice(7);
      if(RISK_ALLOWLIST.test(v))flags.risk=v;
      else flags.warnings.push(`--risk '${v}' 무효 — 무시. 허용: low|medium|high|critical`);}
    else if(arg.startsWith('--review=')){const v=arg.slice(9);
      if(REVIEW_ALLOWLIST.test(v))flags.review=v;
      else flags.warnings.push(`--review '${v}' 무효 — 무시. 허용: auto|single|dual`);}
    else task.push(arg);
  }
  flags.task=task.join(' ');if(flags.no_recommender&&flags.recommender){flags.warnings.push('--no-recommender 활성 — --recommender 인자는 무시됨');flags.recommender=null;}
  if(flags.no_ask&&flags.recommender){flags.warnings.push('--no-ask 활성 — recommender는 호출되지 않음');flags.recommender=null;}
  if(!flags.recommender&&!flags.no_ask&&!flags.no_recommender)flags.recommender='sonnet';
  const provided=new Set(),named={profile:'profile',recommender:'recommender',tdd:'tdd_mode',exec:'exec_mode','resume-from':'resume_from',session:'session',worktree:'worktree','model-routing':'model_routing',policy:'policy',risk:'risk',review:'review'};
  for(const arg of args){if(Object.hasOwn(bools,arg))provided.add(bools[arg]);if(['--autonomous','--interactive-gates'].includes(arg))provided.add('continuation_mode');const match=arg.match(/^--([^=]+)=(.+)$/);if(!match||!named[match[1]])continue;const field=named[match[1]];if(flags[field]===match[2]||field==='model_routing'&&parseModelRoutingValue(match[2]).entries.length>0)provided.add(field);}
  return {...flags,parser_origin:'deep-work-flags-v1',provided_options:[...provided].sort()};}
module.exports={parseDeepWorkFlags,parseFlags,parseModelRoutingValue,RECOMMENDER_ALLOWLIST,EXEC_ALLOWLIST,
  PROFILE_NAME_ALLOWLIST,TDD_ALLOWLIST,RESUME_FROM_ALLOWLIST,SESSION_ALLOWLIST,WORKTREE_PATH_BLOCKLIST,
  POLICY_ALLOWLIST,RISK_ALLOWLIST,REVIEW_ALLOWLIST};
