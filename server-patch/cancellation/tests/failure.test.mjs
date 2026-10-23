import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './route-a1.test.mjs';
for(const [name,options] of Object.entries({goal:{goalFailure:true},receipt:{outcomeWriteFailure:true},audit:{logFailure:true},run:{runFailure:true},oldTerminal:{oldTerminal:true}}))test(`failure: ${name} never rolls cancellation back or suppresses old-run attempt`,async()=>{
 const f=fixture(options);const r=await f.run();assert.equal(r.issue.status,'cancelled');assert.deepEqual(f.calls.cancelled,['active-run']);assert.equal(f.committed.issue.status,'cancelled');
 if(name==='oldTerminal'||name==='run')assert.equal(r.cancelledStatusRunId,null);
 if(name==='goal'||name==='receipt')assert.equal(f.committed.audits.at(-1).details.goalOutcome,'unknown');
 if(name==='oldTerminal')assert.equal(f.committed.audits.at(-1).details.runOutcome,'already_terminal');
});
for(const [name,options,pattern] of [
 ['locked policy',{lockedIssue:{status:'in_review',reviewPolicy:'human_only'}},/human_only/],
 ['commit rollback',{commitFailure:true},/commit failed/],
 ['attachment rollback',{body:{comment:'cancel',attachmentIds:['upload']},attachmentFailure:true},/attachment invalid/],
 ['revoked actor',{revoked:true},/run was cancelled/],
 ['changed owner',{lockedIssue:{assigneeAgentId:'successor'}},/context changed/],
])test(`denial: ${name} commits no receipt and stops nothing`,async()=>{
 const f=fixture(options);await assert.rejects(f.run(),pattern);assert.equal(f.committed.actions.length,0);assert.deepEqual(f.calls.cancelled,[]);assert.equal(f.events.some(x=>x.startsWith('goal:')),false);
});
for(const body of [{assigneeAgentId:'new-agent'},{comment:'cancel',interrupt:true},{assigneeAgentId:'new-agent',comment:'cancel',interrupt:true,attachmentIds:['upload']}])test(`combined cancel ${JSON.stringify(body)} stops only after commit`,async()=>{
 const f=fixture({body,actor:{type:'board',userId:'board-user',companyIds:['company'],agentId:null,runId:null}});const r=await f.run();assert.equal(r.issue.status,'cancelled');assert.deepEqual(f.calls.cancelled,['active-run']);assert.equal(f.events.filter(x=>x.startsWith('goal:')).length,1);
});
