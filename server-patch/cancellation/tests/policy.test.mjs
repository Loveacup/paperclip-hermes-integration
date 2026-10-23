import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {directory,makeCore,once} from './durable-fixture.mjs';
test('internal policy only accepts exact targeted pause/clear; cannot change existing delivery semantics',()=>{
 const core=makeCore(directory());
 for(const [type,payload,policy] of [
 ['turn.start',{},once],['session.goal.set',{threadId:'thread',status:'active'},once],
 ['session.goal.set',{threadId:'thread',status:'paused',objective:'replacement'},once],
 ['session.goal.clear',{threadId:'thread'},{mode:'typo'}],
 ['session.goal.clear',{threadId:'thread'},{...once,attemptConsumed:false}],
 ['session.goal.clear',{threadId:'thread'},null]])
 assert.throws(()=>core.queueCommand(type,payload,undefined,false,policy),'invalid delivery metadata rejected');
 core.queueCommand('session.goal.clear',{threadId:'thread'},'target',false,once);
 assert.throws(()=>core.queueCommand('session.goal.clear',{threadId:'thread'},'target',false));
 core.queueCommand('session.goal.clear',{threadId:'thread'},'ordinary');
 assert.throws(()=>core.queueCommand('session.goal.clear',{threadId:'thread'},'ordinary',false,once));
 core.queueCommand('session.goal.set',{threadId:'thread',status:'paused'},'pause',false,once);
 assert.equal(core.store.state.commands.length,3);
});
test('native reload validates policy structure and counter/consumption consistency',()=>{
 for(const corrupt of [
 c=>{c.commands[0].delivery.mode='typo';},
 c=>{c.commands[0].delivery.attemptConsumed='false';},
 c=>{c.commands[0].delivery.extra=true;},
 c=>{c.commands[0].type='turn.start';},
 c=>{c.commands[0].delivery.attemptConsumed=true;},
 c=>{c.commandDeliveryCounts.target=1;},
 ]) {
 const dir=directory(),core=makeCore(dir);
 core.queueCommand('session.goal.clear',{threadId:'thread'},'target',false,once);
 const data=JSON.parse(readFileSync(core.store.path));corrupt(data);
 writeFileSync(core.store.path,JSON.stringify(data));
 assert.throws(()=>makeCore(dir),/invalid/);
 }
});
