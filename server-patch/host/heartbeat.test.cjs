const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const {harness,read,fn,recovery}=require('./harness.cjs');
const source=fn(read('services/heartbeat.js'),'cancelRunInternal');
for(const runtimeMode of ['legacy','native'])test(`real heartbeat cancelRunInternal carries CEO attribution (${runtimeMode})`,async()=>{
 const h=harness('/heartbeat-runs/:runId/cancel');await h.invoke();const options=h.effects.find(x=>x.cancel).cancel;
 let run={id:'run',companyId:'c',agentId:'target',status:'running',runtimeMode,runtimeModeResolvedAt:'resolved',resultJson:{}};const calls=[];
 const c={CANCELLABLE_HEARTBEAT_RUN_STATUSES:['running','queued'],getRun:async()=>run,getAgent:async()=>({id:'target'}),processRunCancellationSettlements:new Map(),runningProcesses:new Map(),captureAdapterStopOwnership:()=>({release(){}}),parseObject:x=>x||{},mergeRunStopMetadataForAgent:(a,s,o)=>o.resultJson,
 heartbeatRuns:{},db:{update:()=>({set:()=>({where:()=>({returning:async()=>[run]})})})},sql:()=>'',and:()=>{},eq:()=>{},inArray:()=>{},
 cancelHeartbeatNativeRun:async()=>{if(runtimeMode==='native')run.resultJson.nativeCancellation={dispatchState:'acknowledged'};},
 setRunStatusFromLive:async(id,status,statuses,patch)=>{run={...run,status,...patch};return {run,updated:true};},setWakeupStatus:async()=>{},appendRunEvent:async()=>{},releaseIssueExecutionAndPromote:async(r,o)=>calls.push(o),finalizeAgentStatus:async()=>{},timerClaimWasFirstHeartbeat:()=>false,startNextQueuedRunForAgent:async()=>{},options};
 vm.createContext(c);vm.runInContext(source,c);const result=await c.cancelRunInternal('run','Cancelled by company CEO',options);
 assert.equal(result.status,'cancelled');assert.equal(result.errorCode,'ceo_cancelled');assert.equal(result.resultJson.cancelledByActorType,'agent');assert.equal(result.resultJson.cancelledByAgentId,'ceo');assert.equal(calls[0].suppressImmediateRecovery,true);assert.equal(recovery(result),true);
 if(runtimeMode==='native')assert.equal(result.resultJson.nativeCancellation.dispatchState,'acknowledged');
});
