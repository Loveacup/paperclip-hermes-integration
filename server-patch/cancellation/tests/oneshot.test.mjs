import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
const read=p=>readFileSync(new URL('./candidate/'+p,import.meta.url),'utf8');
const source=read('services/runner-goals.js');
const start=source.indexOf('export async function registerTargetedRunnerGoalStop(');
const end=source.indexOf('// End internal targeted one-shot controls.',start);
// Full real exported functions, SQL builders and storage are explicit leaves.
const table={id:'id',sessionId:'sessionId',companyId:'companyId',requestId:'requestId'};
function fixture({online=true,completion,phase}={}){
 const writes=[],dispatches=[];let row;
 const session={id:'session',companyId:'company',agentId:'agent',taskKey:'issue',goalRevision:7};
 const db={async transaction(fn){return fn(this);},select(){let which;const q={from(t){which=t;return q;},where(){return q;},limit(){return q;},for(){return q;},then(resolve){return Promise.resolve(which===sessions?[session]:row?[row]:[]).then(resolve);}};return q;},insert(){return {values(v){writes.push(v);row={...v,id:'action'};return {onConflictDoNothing(){return {returning:async()=>[row]};}};}};},update(){return {set(v){writes.push(v);row={...row,...v};return {where:async()=>{}};}};}};
 const sessions={...table};
 const dispatch=(target,control)=>{dispatches.push({target,control});return online?{completion:Promise.resolve(completion??{status:'confirmed',requestId:control.requestId,action:control.action,target:control.target})}:null;};
 const body=start<0?'return {}':source.slice(start,end).replaceAll('export ','');
 const api=Function('agentTaskSessions','agentSessionGoalActions','and','eq','dispatchLiveRunnerGoalControl','isDeepStrictEqual',body+';return {registerTargetedRunnerGoalStop: typeof registerTargetedRunnerGoalStop === "undefined" ? undefined : registerTargetedRunnerGoalStop, dispatchTargetedRunnerGoalStop: typeof dispatchTargetedRunnerGoalStop === "undefined" ? undefined : dispatchTargetedRunnerGoalStop};')(sessions,table,(...a)=>a,(...a)=>a,dispatch,isDeepStrictEqual);
 const target={companyId:'company',issueId:'issue',agentId:'agent',runId:'run',controllerGeneration:'generation',goalTarget:{sessionId:'native-session',runId:'run',threadId:'thread',ownerEpoch:'epoch'}};
 const input={companyId:'company',issueId:'issue',agentId:'agent',runId:'run',sessionId:'session',requestId:'cancel',action:'clear',target};
 return {api,db,writes,dispatches,input,get row(){return row;}};
}
test('one-shot first durable write cannot enter recovery and repeated consumption has one dispatch',async()=>{
 const f=fixture();assert.equal(typeof f.api.registerTargetedRunnerGoalStop,'function');
 const receipt=await f.api.registerTargetedRunnerGoalStop(f.db,f.input);
 assert.equal(f.writes[0].status,'failed');assert.equal(f.writes[0].payloadJson.deliveryMode,'targeted_one_shot');
 assert.equal(f.dispatches.length,0);
 const reordered=Object.fromEntries(Object.entries(f.input.target).reverse());
 await f.api.registerTargetedRunnerGoalStop(f.db,{...f.input,target:reordered});
 const result=await f.api.dispatchTargetedRunnerGoalStop(f.db,receipt);
 assert.equal(result.outcome,'confirmed');assert.equal(f.row.status,'completed');
 await f.api.dispatchTargetedRunnerGoalStop(f.db,receipt);assert.equal(f.dispatches.length,1);
});
test('offline one-shot records not_dispatched without recovery enqueue',async()=>{
 const f=fixture({online:false});assert.equal(typeof f.api.registerTargetedRunnerGoalStop,'function');
 const receipt=await f.api.registerTargetedRunnerGoalStop(f.db,f.input);
 const result=await f.api.dispatchTargetedRunnerGoalStop(f.db,receipt);
 assert.equal(result.outcome,'not_dispatched');assert.equal(f.row.status,'failed');
});
test('ambiguous receipt remains unknown and is never retried',async()=>{
 const f=fixture({completion:{status:'confirmed',target:{threadId:'other'}}});assert.equal(typeof f.api.registerTargetedRunnerGoalStop,'function');
 const receipt=await f.api.registerTargetedRunnerGoalStop(f.db,f.input);
 assert.equal((await f.api.dispatchTargetedRunnerGoalStop(f.db,receipt)).outcome,'unknown');
 await f.api.dispatchTargetedRunnerGoalStop(f.db,receipt);assert.equal(f.dispatches.length,1);
});
test('actual recovery consumer skips one-shot rows while ordinary action enqueues',async()=>{
 const heartbeat=read('services/heartbeat.js');
 const block=heartbeat.slice(heartbeat.indexOf('    async function recoverPendingSessionGoalActions() {'),heartbeat.indexOf('    async function reconcileStrandedAssignedIssues()',heartbeat.indexOf('    async function recoverPendingSessionGoalActions() {')));
 let enqueues=0;
 const rows=[{id:'once',requestId:'cancel',payload:{requestId:'cancel',action:'clear',deliveryMode:'targeted_one_shot'}},{id:'ordinary',requestId:'regular',payload:{requestId:'regular',action:'clear'}}];
 let selections=0;
 const db={select(){let q={from(){return q;},innerJoin(){return q;},where(){return q;},orderBy:async()=>rows,then(resolve){return Promise.resolve([]).then(resolve);}};selections++;return q;}};
 const sql=()=>'';
 const recover=Function('db','getSchedulingSuppression','agentSessionGoalActions','agentTaskSessions','issues','and','eq','sql','inArray','asc','parseNativeSessionGoalControl','failRunnerGoalAction','heartbeatRuns','readNonEmptyString','parseObject','enqueueWakeup',block+';return recoverPendingSessionGoalActions;')(db,async()=>({suppressed:false}),table,table,table,()=>0,()=>0,sql,()=>0,()=>0,x=>x,async()=>{},table,x=>x,x=>x,async()=>{enqueues++;return {};});
 const result=await recover();assert.equal(enqueues,1);assert.equal(result.enqueued,1);
});
