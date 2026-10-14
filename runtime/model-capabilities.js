'use strict';
const {mergeCatalog,tierForModel}=require('./model-catalog.js');
const CAPABILITIES=Object.freeze({
 'claude-fable-5-1':{runtime:'claude',tier:'deep',efforts:['low','medium','high','max']},
 'gpt-6-astra':{runtime:'codex',tier:'deep',efforts:['low','medium','high','xhigh','max','ultra']},
 'gpt-6.1-sol':{runtime:'codex',tier:'deep',efforts:['low','medium','high','xhigh','max','ultra']},
 'gpt-6-sol':{runtime:'codex',tier:'deep',efforts:['low','medium','high','xhigh','max','ultra']},
 'gpt-6-luna':{runtime:'codex',tier:'light',efforts:['low','medium','high','xhigh','max']},
 'gpt-5.6-sol':{runtime:'codex',tier:'deep',efforts:['low','medium','high','xhigh','max','ultra']},
 'gpt-5.6-terra':{runtime:'codex',tier:'standard',efforts:['low','medium','high','xhigh','max','ultra']},
 'gpt-5.6-luna':{runtime:'codex',tier:'light',efforts:['low','medium','high','xhigh','max']},
 'gpt-5.5-codex':{runtime:'codex',tier:'deep',efforts:['low','medium','high','xhigh']},
 haiku:{runtime:'claude',tier:'light',efforts:[]},sonnet:{runtime:'claude',tier:'standard',efforts:[]},opus:{runtime:'claude',tier:'deep',efforts:[]},
});
function resolveModelCapability({runtime,model,catalogOverride}={}){
 const alias=typeof model==='string'?model.match(/^claude-(opus|sonnet|haiku)-[0-9][A-Za-z0-9.-]*$/)?.[1]:null;
 const known=CAPABILITIES[model]||(alias?CAPABILITIES[alias]:null),catalog=mergeCatalog(catalogOverride);
 const inferred=/^(?:gpt-|o[134](?:-|$))/.test(model||'')?'codex':/^(?:claude-|haiku$|sonnet$|opus$)/.test(model||'')?'claude':null;
 const owner=known?.runtime||inferred;
 const tier=known?.tier||tierForModel(model,runtime,catalog);
 const status=owner&&owner!==runtime?'foreign':model==='main'||known||tier?'recognized':'unverified';
 return {status,runtime,model,nominal_tier:tier,supported_efforts:known?[...known.efforts]:[],observed_model:null};
}
function resolveExecutionMode({explicitMode,explicitModel,teamMode,capabilities={}}={}){
 if(explicitMode!==undefined&&explicitMode!==null&&!['inline','delegate'].includes(explicitMode))throw new Error('execution-mode');
 const mode=explicitMode||(explicitModel&&explicitModel!=='main'||teamMode==='team'?'delegate':'inline');
 return {mode,model:explicitModel||'main',source:explicitMode?'explicit-mode':explicitModel?'explicit-model':teamMode==='team'?'team':'adaptive-current',
   available:mode==='inline'||capabilities.subagent===true||capabilities.cli===true};
}
function matchesModelIdentity({runtime,requested,observed}={}){
 if(typeof observed!=='string'||!observed)return false;if(requested===observed)return true;
 return runtime==='claude'&&['opus','sonnet','haiku'].includes(requested)&&
   new RegExp(`^claude-${requested}-[0-9][A-Za-z0-9.-]*$`).test(observed);
}
module.exports={CAPABILITIES,resolveModelCapability,resolveExecutionMode,matchesModelIdentity};
