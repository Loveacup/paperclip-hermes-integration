import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './route-a1.test.mjs';
for(const [name,options] of [['successor',{replaceOnCommit:true}],['missing DB session',{noSession:true}]])test(`target: ${name} never falls back or suppresses old-run stop`,async()=>{
 const f=fixture(options);const r=await f.run();assert.equal(r.issue.status,'cancelled');assert.deepEqual(f.calls.cancelled,['active-run']);assert.equal(f.events.some(x=>x.startsWith('goal:')),false);assert.equal(f.committed.audits.at(-1).details.goalOutcome,'not_dispatched');
});
test('pause capability retains real one-shot pause after commit',async()=>{const f=fixture({goalPause:true});await f.run();assert.equal(f.committed.actions[0].action,'pause');assert.equal(f.events.filter(x=>x==='goal:pause').length,1);assert.equal(f.events.indexOf('commit')<f.events.indexOf('goal:pause'),true);});
