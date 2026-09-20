'use strict';
const fs=require('node:fs'),path=require('node:path');const platform=require('./platform.js');
const transaction=require('./transaction-runtime.js'),workflow=require('./workflow-runtime.js');
function block(reason){return {decision:'block',reason:`Governed write denied: ${reason}`};}
function words(command){if(typeof command!=='string'||/[\n\r\x00$`;&|<>]/.test(command))return null;
 const matches=command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)||[];return matches.map(token=>token.replace(/"([^"]*)"|'([^']*)'/g,(_m,a,b)=>a??b));}
function runtimeCommand(command,stateCapability,fields){const argv=words(command);if(!argv||argv.length<2)return false;
 const root=fs.realpathSync(path.resolve(__dirname,'..')),script=path.join(root,'scripts','deep-work-runtime.js');
 try{if(!(['node','node.exe'].includes(argv[0])||path.isAbsolute(argv[0])&&fs.realpathSync(argv[0])===fs.realpathSync(process.execPath))||!path.isAbsolute(argv[1])||fs.realpathSync(argv[1])!==script)return false;
  const parsed=require('../scripts/deep-work-runtime.js').parseDispatcher(argv.slice(2));
  if(parsed.flags.state&&path.resolve(parsed.flags.state)!==stateCapability.path)return false;
  if(parsed.flags.session&&parsed.flags.session!==fields.session_id)return false;
  if(!parsed.entry.allowedPhases.includes(fields.current_phase)&&!parsed.entry.allowedPhases.includes('standalone'))return false;
  if(['session finalize','session state migrate-schema','slice spike','implement override set','implement override clear'].includes(parsed.entry.id))return false;
  return true;
 }catch{return false;}}
function readCommand(command){const argv=words(command);if(!argv?.length)return false;const name=path.basename(argv[0]);
 if(['pwd','ls','cat','head','tail','wc','rg'].includes(name))return !argv.some(v=>v==='--pre'||v.startsWith('--pre='));
 if(name==='git')return ['status','diff','show','log','rev-parse','ls-files','ls-tree'].includes(argv[1])&&!argv.some(v=>/^--(output|ext-diff|textconv)(=|$)/.test(v));
 return name==='node'&&argv.length===2&&argv[1]==='--version';}
function reservedOwnedTemp(stateCapability,fields,targetPaths){
 const workDir=workflow.workDirFor(stateCapability,fields);
 const sessionCapability=platform.issueProjectStateCapability(stateCapability.projectRoot,workDir,{role:'session-work-dir',sessionStateCapability:stateCapability});
 return targetPaths.every(absolute=>{
  const rel=path.relative(workDir,absolute);
  const parts=rel.split(path.sep);
  if(parts[0]!=='.tmp'||parts.length!==3||!/^op-[0-9a-f]{32,64}$/.test(parts[1])||!parts[2].endsWith('.tmp'))return false;
  try{const capability=platform.issueOwnedTempCapability({sessionCapability,operationId:parts[1],purpose:path.basename(parts[2],'.tmp'),allowMissingLeaf:true});
   return capability.path===absolute&&capability.state==='reserved';}
  catch{return false;}});
}
async function admitGovernedWrite({stateCapability,planCapability,toolContext}={}){
 if(!toolContext?.valid)return block('malformed tool context');
 return workflow.withWorkflowLock(stateCapability,async()=>{try{
  const fields=transaction.readState(stateCapability);if(fields.parked===true)return{decision:'allow'};
  const context=toolContext,tool=context.toolName;
  if(tool==='Bash'){
    if(runtimeCommand(context.toolInput.command,stateCapability,fields)||readCommand(context.toolInput.command))return {decision:'allow'};
    return block('use the exact runtime route; arbitrary shell execution has no write authority. For reads, use one command per tool call (for example: pwd, rg --files, or head -n 5 AGENTS.md); sed, pipes, and compound commands are not supported');
  }
  if(!['Write','Edit','MultiEdit','apply_patch','NotebookEdit'].includes(tool))return {decision:'allow'};
  const extracted=require('./hook-context.js').extractMutationTargets(context);if(!extracted.valid||!extracted.targets.length)return block('unknown targets');
  const root=stateCapability.projectRoot,workDir=workflow.workDirFor(stateCapability,fields);
  const targetPaths=extracted.targets.map(target=>{const absolute=path.resolve(root,target);if(!platform.isPathInside(root,absolute)||absolute===root)throw new Error('target-outside-root');let cursor=root;for(const part of path.relative(root,absolute).split(path.sep)){cursor=path.join(cursor,part);try{const stat=fs.lstatSync(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw new Error('target-alias');}catch(error){if(error.code!=='ENOENT')throw error;}}return absolute;});
  const authored={brainstorm:['brainstorm.md'],research:['research.md'],spec:['spec.md',...(require('./artifact-approval-runtime.js').required(stateCapability)?['plan.md']:[])],plan:['plan.md']}[fields.current_phase]||[];
  if(authored.length&&targetPaths.every(p=>authored.some(name=>p===path.join(workDir,name))))return {decision:'allow'};
  if(reservedOwnedTemp(stateCapability,fields,targetPaths))return {decision:'allow'};
  if(fields.current_phase!=='implement')return block(`source write in ${fields.current_phase}`);
  const loaded=workflow.loadExecutionContext({stateCapability,planCapability,sliceId:fields.active_slice});
  const pending=require('./slice-runtime.js').pendingScopedWrite(fields);if(!pending||pending.slice_id!==fields.active_slice||pending.stage!=='begun'||pending.plan_authority_sha256!==loaded.plan.plan_authority_sha256)return block('pending scoped write required');
  const receiptPath=path.join(root,'.claude',`deep-work.${fields.session_id}.scoped-write.${pending.operation_id}.json`);
  const receipt=JSON.parse(workflow.readRegular(receiptPath));if(receipt.status!=='begun'||receipt.operationId!==pending.operation_id||receipt.sliceId!==fields.active_slice)return block('write receipt identity');
  const operation=await require('./operation-journal.js').resumeOperation({projectCapability:transaction.projectCapabilityFor(stateCapability),sessionId:fields.session_id,operationId:pending.operation_id,kind:'delegation-scope-publish'});
  if(operation.stage!=='scoped-write-begun'||operation.preconditions.authoritySha256!==receipt.authority.sha256)return block('write producer identity');
  if(loaded.slice.execution_basis==='strict-tdd-v2')require('./node-tap-policy.js').assertNodeTapPolicyForSpec(loaded.slice.verification_spec,process.versions.node);
  if(fields.tdd_state!==receipt.tddPreState)return block('write state drift');
  const allowed=receipt.authority.authorized_paths.map(p=>path.join(root,p));
  return targetPaths.every(p=>allowed.includes(p))?{decision:'allow'}:block('outside approved pending scope');
 }catch(error){return block(error.code||error.message);}});
}
async function main(){let raw='';for await(const chunk of process.stdin)raw+=chunk;try{const statePath=path.resolve(process.argv[2]),root=platform.resolveProjectRoot(path.dirname(statePath));
 const stateCapability=platform.issueProjectStateCapability(root,statePath,{role:'session-state'}),fields=transaction.readState(stateCapability);
 if(Number(String(fields.created_by_version||'0').split('.')[0])<7){process.exitCode=3;return;}
 const result=await admitGovernedWrite({stateCapability,toolContext:require('./hook-context.js').parseHookContext(raw,process.env)});process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.decision==='block'?2:0;
 }catch(error){process.stdout.write(JSON.stringify(block(error.code||error.message))+'\n');process.exitCode=2;}}
if(require.main===module)void main();module.exports={admitGovernedWrite,runtimeCommand,readCommand};
