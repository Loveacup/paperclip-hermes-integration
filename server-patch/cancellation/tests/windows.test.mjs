import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {directory,makeCore,loadCore,connection,once,wires,result} from './durable-fixture.mjs';
for(const path of ['immediate','welcome']) {
 test(`${path}: persist errors before rename and after rename/fsync never send; poisoned owner cannot overwrite evidence`,()=>{
  for(const stage of ['before-rename','directory-fsync']) {
   let armed=false;const dir=directory(),frames=[];
   const Core=loadCore({renameSync(a,b){if(armed&&stage==='before-rename')throw Error('injected rename');return fs.renameSync(a,b);},fsyncSync(fd){if(armed&&stage==='directory-fsync'&&fs.fstatSync(fd).isDirectory())throw Error('injected fsync');return fs.fsyncSync(fd);}});
   const core=makeCore(dir,Core);core.queueCommand('session.goal.clear',{threadId:'thread'},'stop',false,once);
   const c=connection(core,f=>frames.push(f));armed=true;
   assert.throws(()=>path==='welcome'?core._welcome(c,null):core._sendNextCommand(c),/injected/);
   assert.equal(wires(frames).length,0);
   armed=false;
   assert.throws(()=>core._sendNextCommand(c),/indeterminate/);
   const reopened=makeCore(dir);const c2=connection(reopened,f=>frames.push(f));reopened._welcome(c2,null);
   assert.equal(wires(frames).length,stage==='before-rename'?1:0,'no committed eligibility means first attempt still possible; ambiguous committed mark never retries');
  }
 });
 for(const afterWire of [false,true])test(`${path}: crash ${afterWire?'during wire':'after consume before wire'} survives owner reconstruction`,()=>{
  const dir=directory(),core=makeCore(dir),frames=[];
  core.queueCommand('session.goal.clear',{threadId:'thread'},'stop',false,once);
  const c=connection(core,f=>{
   assert.equal(JSON.parse(fs.readFileSync(core.store.path)).commands[0].delivery.attemptConsumed,true);
   if(afterWire)frames.push(f);throw Error('injected disconnect');
  });
  assert.throws(()=>path==='welcome'?core._welcome(c,null):core._sendNextCommand(c),/disconnect/);
  const reopened=makeCore(dir),c2=connection(reopened,f=>frames.push(f));
  reopened._welcome(c2,null);reopened._sendNextCommand(c2);
  assert.equal(wires(frames).length,afterWire?1:0);
  assert.equal(reopened.getCommand('stop').status,'pending');
 });
}
test('welcome first delivery and ordinary pending retransmission remain distinct after reload',()=>{
 for(const policy of [undefined,once]) {
  const dir=directory(),core=makeCore(dir),frames=[];
  core.queueCommand('session.goal.clear',{threadId:'thread'},'command',false,policy);
  const c=connection(core,f=>frames.push(f));core._welcome(c,null);
  const reopened=makeCore(dir),c2=connection(reopened,f=>frames.push(f));reopened._welcome(c2,null);
  assert.equal(wires(frames).length,policy?1:2);
  assert.equal(wires(frames)[0].delivery,undefined);
 }
});
test('unknown stop blocks later sequence until actual result; late duplicate never resends stop',()=>{
 const core=makeCore(directory()),frames=[],c=connection(core,f=>frames.push(f));
 const cmd=core.queueCommand('session.goal.clear',{threadId:'thread'},'stop',true,once);
 core.queueCommand('session.goal.get',{threadId:'thread'},'get',true);
 core._welcome(c,null);assert.deepEqual(wires(frames).map(c=>c.commandId),['stop']);
 result(core,c,cmd);result(core,c,cmd);
 assert.equal(wires(frames).filter(c=>c.commandId==='stop').length,1);
 assert.ok(wires(frames).some(c=>c.commandId==='get'));
});
test('targeted result must match consumed command type and sequence before releasing fence',()=>{
 for(const bad of [{commandType:'session.goal.get'},{controllerSeq:999}]) {
  const core=makeCore(directory()),c=connection(core);
  const cmd=core.queueCommand('session.goal.clear',{threadId:'thread'},'stop',true,once);
  core._commandResult(c,{payload:{commandId:cmd.commandId,commandType:cmd.type,controllerSeq:cmd.controllerSeq,status:'completed',result:{},...bad}});
  assert.equal(core.getCommand('stop').status,'pending');assert.equal(c.closed,true);
 }
 const core=makeCore(directory()),cmd=core.queueCommand('session.goal.clear',{threadId:'thread'},'stop',false,once),c=connection(core);
 result(core,c,cmd);assert.equal(core.getCommand('stop').status,'pending');assert.equal(c.closed,true);
});
