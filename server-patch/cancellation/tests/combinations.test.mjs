import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './route-a1.test.mjs';
import {createHarness} from './cancel-harness.mjs';
test('combined owner+board interrupt+invalid attachment rolls back with zero stops',async()=>{
 const f=fixture({actor:{type:'board',userId:'board-user',companyIds:['company'],agentId:null,runId:null},body:{assigneeAgentId:'new-agent',comment:'cancel',interrupt:true,attachmentIds:['invalid']},attachmentFailure:true});
 await assert.rejects(f.run(),/attachment invalid/);assert.deepEqual(f.calls.cancelled,[]);assert.equal(f.events.some(x=>x.startsWith('goal:')),false);assert.equal(f.committed.actions.length,0);
});
test('noncancel done keeps original pre-persist ownership helper and exact stop ordering',async()=>{
 const h=createHarness({body:{status:'done'}});const events=[];
 h.sandbox.stopRunnerGoalForOwnershipChange=async()=>{events.push('goal');return 'clear';};
 h.sandbox.heartbeat.cancelRun=async id=>{events.push('run:'+id);return {id,status:'cancelled'};};
 const update=h.sandbox.svc.update;h.sandbox.svc.update=async(...args)=>{events.push('persist');return update(...args);};
 const r=await h.run();assert.equal(r.issue.status,'done');assert.deepEqual(events,['goal','run:active-run','persist']);
});
test('nonempty running result without receipt is not a confirmed stop',async()=>{
 const f=fixture();f.sandbox.heartbeat.cancelRun=async id=>({id,companyId:'company',agentId:'agent',status:'running'});const r=await f.run();assert.equal(r.cancelledStatusRunId,null);assert.equal(f.committed.audits.at(-1).details.runOutcome,'unknown');
});
