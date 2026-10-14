'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const api=require('./model-capabilities.js');
test('provider metadata for declared Claude aliases has a tier without inventing observed identity',()=>{
 assert.equal(api.resolveModelCapability({runtime:'claude',model:'claude-opus-4-6'}).nominal_tier,'deep');
 assert.equal(api.resolveModelCapability({runtime:'codex',model:'claude-opus-4-6'}).status,'foreign');
 assert.equal(api.matchesModelIdentity({runtime:'claude',requested:'opus',observed:'claude-opus-4-6'}),true);
 assert.equal(api.matchesModelIdentity({runtime:'claude',requested:'opus',observed:'claude-sonnet-4-6'}),false);
 assert.equal(api.matchesModelIdentity({runtime:'codex',requested:'gpt-6-astra',observed:null}),false);
});
test('GPT-6 Codex defaults carry exact efforts and 5.6 ids stay recognized',()=>{
 const efforts=['low','medium','high','xhigh','max','ultra'];
 const sol=api.resolveModelCapability({runtime:'codex',model:'gpt-6.1-sol'}),luna=api.resolveModelCapability({runtime:'codex',model:'gpt-6-luna'});
 assert.equal(sol.status,'recognized');assert.equal(sol.nominal_tier,'deep');assert.deepEqual(sol.supported_efforts,efforts);
 assert.equal(luna.status,'recognized');assert.equal(luna.nominal_tier,'light');
 assert.deepEqual(luna.supported_efforts,['low','medium','high','xhigh','max']);assert.ok(!luna.supported_efforts.includes('ultra'));
 for(const model of ['gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-6-sol'])assert.equal(api.resolveModelCapability({runtime:'codex',model}).status,'recognized');
});
test('a custom catalog model shared by two tiers gets the highest nominal tier',()=>{
 const r=api.resolveModelCapability({runtime:'codex',model:'custom-x',catalogOverride:{codex:{light:'custom-x',standard:'custom-x'}}});
 assert.equal(r.status,'recognized');assert.equal(r.nominal_tier,'standard');assert.deepEqual(r.supported_efforts,[]);
});
