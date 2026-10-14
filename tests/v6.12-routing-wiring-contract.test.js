'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const ROOT=path.resolve(__dirname,'..');
const {extractRoutingState}=require('../scripts/risk-profile-cli.js');
const {updateFrontmatterText}=require('../runtime/frontmatter.js');

test('public routing CLI uses the explicitly selected provider catalog',()=>{
  for(const [runtime,research,testModel]of [['claude','sonnet','haiku'],['codex','gpt-6.1-sol','gpt-6-luna']]){
    const result=JSON.parse(execFileSync(process.execPath,['scripts/model-routing-cli.js','--root','.',
      '--task','runtime wiring contract probe','--difficulty','medium','--runtime',runtime],{cwd:ROOT,encoding:'utf8'}));
    assert.equal(result.meta.runtime,runtime);assert.equal(result.model_routing.research,research);assert.equal(result.model_routing.test,testModel);
  }
});
test('actual scalar-first routing reader preserves current model and explicit Astra pins',()=>{
  const base='---\nmodel_routing: obsolete\n---\n';
  for(const implement of ['main','gpt-6-astra']){
    const text=updateFrontmatterText(base,{model_routing_json:JSON.stringify({implement}),
      model_routing_meta_json:JSON.stringify({tiers:{implement:'deep'},pinned:{implement:true}})});
    const read=extractRoutingState(text);assert.equal(read.extraction_mode,'scalar');
    assert.equal(read.model_routing.implement,implement);assert.equal(read.pinned.implement,true);
  }
});
test('modern entries delegate state authority to public runtime without literal Agent host inference',()=>{
  for(const name of ['deep-work-orchestrator','deep-research','deep-resume','deep-implement']){
    const body=fs.readFileSync(path.join(ROOT,'skills',name,'SKILL.md'),'utf8');
    assert.ok(body.includes('${CLAUDE_PLUGIN_ROOT}/skills/shared/references/runtime-execution-spine.md'),name);
    assert.doesNotMatch(body,/ROUTING_RUNTIME=|MR_OUT=|model_routing_json[\s\S]*JSON\.stringify/);
  }
});
