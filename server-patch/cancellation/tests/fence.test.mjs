import test from 'node:test';
import assert from 'node:assert/strict';
import {directory,makeCore,connection,once,wires,result,identity} from './durable-fixture.mjs';
test('unconfirmed terminal results preserve durable owner fence across reload and block successor queue',()=>{
 for(const status of ['indeterminate','failed','rejected']) {
 const dir=directory(),core=makeCore(dir),frames=[],c=connection(core,f=>frames.push(f));
 const cmd=core.queueCommand('session.goal.clear',{threadId:'thread'},'stop',true,once);
 result(core,c,cmd,status);
 const reopened=makeCore(dir),c2=connection(reopened,f=>frames.push(f));
 assert.equal(reopened.getCommand('stop').status,status,'retain actual runner result for reconciliation');
 assert.throws(()=>reopened.rotateRunIdentity({...identity,runId:'successor'},{}));
 reopened.queueCommand('run.attach',{},'successor-attach',true);reopened._welcome(c2,null);
 assert.deepEqual(wires(frames).map(c=>c.commandId),['stop']);
 }
});
