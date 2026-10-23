const {test}=require('node:test');
const assert=require('node:assert/strict');
const {harness}=require('./harness.cjs');
const path='/agents/:id/pause';
test('CEO pause uses real role, policy, and true audit identity',async()=>{
 const h=harness(path); await h.invoke(); assert.ok(h.effects.includes('pause'));
 const d=h.decisions[0];assert.equal(d.action,'agent_config:update');assert.equal(d.resource.agentId,'target');assert.equal(d.scope.requiresChangeGrant,true);
 const log=h.effects.find(x=>x.log).log;assert.equal(log.actorType,'agent');assert.equal(log.actorId,'ceo');assert.equal(log.agentId,'ceo');assert.equal(log.runId,'actor-run');assert.equal(log.agentApiKeyId,'key');
});
for(const [name,opts] of Object.entries({ordinary:{caller:{role:'engineer',permissions:{canCreateAgents:true}}},paused:{caller:{status:'paused'}},terminated:{caller:{status:'terminated'}},pending:{caller:{status:'pending_approval'}},demoted:{caller:{role:'manager'}},wrongCompany:{caller:{companyId:'other'}},policyDeny:{policy:{allowed:false,reason:'deny_scope',explanation:'scope denied'}}})) test(`pause denies ${name} without effects`,async()=>{const h=harness(path,opts);await assert.rejects(h.invoke(),e=>e.status===403);assert.deepEqual(h.effects,[]);});
for(const opts of [{target:{companyId:'other'}},{missing:true}]) test('pause invisible target has no effects',async()=>{const h=harness(path,opts);await h.invoke();assert.equal(h.res.statusCode,404);assert.deepEqual(h.effects,[]);});
test('CEO pause cannot bypass pending hire approval (regression)',async()=>{const h=harness(path,{target:{status:'pending_approval'}});await assert.rejects(h.invoke(),/Pending hire/);assert.deepEqual(h.effects,[]);});
test('Board pause pending hire remains unchanged (regression)',async()=>{const h=harness(path,{actor:{type:'board',source:'local_implicit'},target:{status:'pending_approval'}});await h.invoke();assert.ok(h.effects.includes('pause'));});
test('Board pause preserved',async()=>{const h=harness(path,{actor:{type:'board',source:'local_implicit',userId:'board-user'}});await h.invoke();assert.ok(h.effects.includes('pause'));assert.equal(h.effects.find(x=>x.log).log.actorType,'user');});
