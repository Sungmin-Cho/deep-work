'use strict';const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const {createPublicWorkflowFixture}=require('./helpers/public-workflow-fixtures.js');const plugin=path.resolve(__dirname,'..');
const {scrubHostEnv}=require('../hooks/scripts/test-helpers/run-phase-guard.js');
function hook(f,input,post=false,rootVar='CLAUDE_PLUGIN_ROOT'){
  const config=require('../hooks/hooks.json'),event=post?'PostToolUse':'PreToolUse';
  return cp.spawnSync('bash',['-c',config.hooks[event][0].hooks[0].command],{
    cwd:f.root,encoding:'utf8',input:JSON.stringify(input),timeout:10000,
    env:scrubHostEnv({PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,
      [rootVar]:plugin,DEEP_WORK_SESSION_ID:f.sessionId,CLAUDE_PROJECT_DIR:f.root}),
  });
}
test('registered governed blocks expose their original reason on stderr, including malformed input and exceptions',async t=>{
  const f=await createPublicWorkflowFixture(t,{checkpoint:'spec'});
  const before=fs.readFileSync(f.state);
  for(const rootVar of ['CLAUDE_PLUGIN_ROOT','PLUGIN_ROOT']) {
  for(const input of [
    {tool_name:'Bash',tool_input:null},
    {tool_name:'Bash',tool_input:{command:'echo bad > README.md'}},
    {tool_name:'Write',tool_input:{file_path:path.join(f.root,'README.md'),content:'bad'}},
    {tool_name:'Write',tool_input:{file_path:path.join(f.root,'..','outside.md'),content:'bad'}},
  ]){
    const result=hook(f,input,false,rootVar),decision=JSON.parse(result.stdout);
    assert.equal(result.status,2,result.stderr);
    assert.equal(decision.decision,'block');
    assert.ok(result.stderr.includes(decision.reason),JSON.stringify(result));
  }
  }
  assert.deepEqual(fs.readFileSync(f.state),before);
  // A real capability error reaches main()'s catch before admission/locking.
  fs.copyFileSync(f.state,path.join(f.root,'.claude','deep-work.invalid.md'));
  const failed=hook({...f,sessionId:'invalid'},{tool_name:'Bash',tool_input:{command:'pwd'}});
  assert.equal(failed.status,2,failed.stdout+failed.stderr);
  assert.match(JSON.parse(failed.stdout).reason,/project-state-route/);
  assert.ok(failed.stderr.includes(JSON.parse(failed.stdout).reason),JSON.stringify(failed));
});
test('registered actual hook blocks Spec shell writes and direct native authority edits; exact runtime passes',async t=>{const f=await createPublicWorkflowFixture(t,{checkpoint:'spec'});assert.equal(hook(f,{tool_name:'Bash',tool_input:{command:'echo bad > README.md'}}).status,2);assert.equal(hook(f,{tool_name:'Write',tool_input:{file_path:f.state,content:'forged'}}).status,2);const allowed=hook(f,{tool_name:'Bash',tool_input:{command:`node ${plugin}/scripts/deep-work-runtime.js phase continue --state ${f.state}`}});assert.equal(allowed.status,0,allowed.stdout+allowed.stderr);});
test('governed PostToolUse never upgrades state or receipts',async t=>{const f=await createPublicWorkflowFixture(t);const before=fs.readFileSync(f.state);hook(f,{tool_name:'Write',tool_input:{file_path:path.join(f.root,'README.md'),content:'GREEN'}},true);assert.deepEqual(fs.readFileSync(f.state),before);});
test('outcome source write requires current pending scope even after activation',async t=>{const f=await createPublicWorkflowFixture(t);f.cli(['slice','activate','--state',f.state,'--plan',f.planPath,'--slice','SLICE-001']);const input={tool_name:'Write',tool_input:{file_path:path.join(f.root,'README.md'),content:'New heading'}};assert.equal(hook(f,input).status,2);const authority=require('../runtime/plan-runtime.js').deriveScopedWriteAuthority({plan:f.plan,sliceId:'SLICE-001',writeClass:'production'});f.cli(['implement','write','begin','--state',f.state,'--plan',f.planPath,'--slice','SLICE-001','--class','production','--scope-sha256',authority.sha256]);const admitted=hook(f,input);assert.equal(admitted.status,0,admitted.stdout+admitted.stderr);});
test('hook-enabled Spec can deliver owned-temp bytes without a shell pipe',async t=>{
  const f=await createPublicWorkflowFixture(t,{checkpoint:'spec'});
  const created=f.cli(['temp','create','--state',f.state,'--session',f.sessionId,'--purpose','gate-results']);
  const piped=hook(f,{tool_name:'Bash',tool_input:{command:`printf '%s' '{}' | node ${plugin}/scripts/deep-work-runtime.js temp write --state ${f.state} --session ${f.sessionId} --temp-operation-id ${created.operationId} --stdin`}});
  assert.equal(piped.status,2,piped.stdout+piped.stderr);
  assert.equal(hook(f,{tool_name:'Write',tool_input:{file_path:path.join(f.workDir,'packet-ref.json'),content:'{}'}}).status,2);
  const admitted=hook(f,{tool_name:'Write',tool_input:{file_path:created.path,content:'{"complete":true}'}});
  assert.equal(admitted.status,0,admitted.stdout+admitted.stderr);
  fs.writeFileSync(created.path,'{"complete":true}');
  const adopted=f.cli(['temp','write','--state',f.state,'--session',f.sessionId,'--temp-operation-id',created.operationId]);
  assert.equal(adopted.status,'adopted');
  assert.equal(fs.readFileSync(created.path,'utf8'),'{"complete":true}');
  f.cli(['temp','remove','--state',f.state,'--session',f.sessionId,'--temp-operation-id',created.operationId,'--expected-sha256',adopted.sha256]);
  assert.equal(fs.existsSync(created.path),false);
});

test('governed read guidance keeps compound and sed commands blocked and single reads allowed',async t=>{
  const f=await createPublicWorkflowFixture(t,{checkpoint:'spec'});
  for(const command of ['sed -n 1,5p AGENTS.md','pwd && rg --files','rg --files | head -10']){
    const result=hook(f,{tool_name:'Bash',tool_input:{command}},false,'PLUGIN_ROOT');
    assert.equal(result.status,2,result.stdout+result.stderr);
    assert.match(result.stderr,/one command per tool call/);
    assert.match(result.stderr,/head -n 5 AGENTS.md/);
  }
  for(const command of ['pwd','rg --files','head -n 5 AGENTS.md']){
    const result=hook(f,{tool_name:'Bash',tool_input:{command}},false,'PLUGIN_ROOT');
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.equal(result.stderr,'');
  }
});
