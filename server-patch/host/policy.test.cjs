const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const {harness,fn,read}=require('./harness.cjs');
// Real central policy functions; only membership/grant persistence is replaced.
function policy({grants={},trust='standard',bridge=false}={}){return async input=>{
 const src=read('services/authorization.js');const c={input,companyId:'c',db:{},getActiveMembership:async()=>({status:'active'}),findGrant:async(c,t,id,key)=>grants[key]||null,LOW_TRUST_REVIEW_PRESET:'low_trust_review'};
 const names=['allow','deny','scopeBoolean','scopeValueList','prefixedScopeValues','scopeValuesForKeys','scopeIncludesId','scopeAllows','decidePrincipalGrant','decideWithProtectedChangeGrants','decideLowTrustAccess','decideTaskBridgeAccess'];
 vm.createContext(c);vm.runInContext(names.map(n=>fn(src,n)).join('\n'),c);
 if(bridge)return c.decideTaskBridgeAccess({actorAgentId:'ceo',action:input.action,resource:input.resource,scope:{kind:'task_bridge'},keyId:'k'});
 const low=await c.decideLowTrustAccess({action:input.action,resource:input.resource,resolution:{kind:trust,boundary:{companyId:'c'}},actorAgentId:'ceo'});if(low)return low;
 return c.decideWithProtectedChangeGrants('agent','ceo',{direct:'agents:configure',suggest:'agents:suggest-changes'});
};}
test('same-company CEO with target-scoped configure grant can pause',async()=>{const h=harness('/agents/:id/pause',{policy:policy({grants:{'agents:configure':{scope:{agentId:'target'}}}})});await h.invoke();assert.ok(h.effects.includes('pause'));});
for(const [name,config] of Object.entries({lowTrust:{trust:'low_trust'},taskBridge:{bridge:true},protectedConsent:{grants:{'agents:suggest-changes':{scope:null}}},wrongScope:{grants:{'agents:configure':{scope:{agentId:'elsewhere'}}}},noGrant:{}}))test(`actual central policy denies ${name}`,async()=>{const h=harness('/agents/:id/pause',{policy:policy(config)});await assert.rejects(h.invoke(),e=>e.status===403);assert.deepEqual(h.effects,[]);});
