import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import net from 'node:net';
import {fixture} from './route-a1.test.mjs';
import {routeFunctions,vm} from './cancel-harness.mjs';
const require=createRequire(process.env.ACORN_PACKAGE);
const express=require('express');
for(const kind of ['access','board-pause','watchdog-invalid','watchdog-stale','missing-run','not-found'])test('HTTP locked '+kind+' sends one response and zero effects',async()=>{
 const f=fixture(kind==='board-pause'?{actor:{type:'board',userId:'board-user',companyIds:['company'],agentId:null,runId:null},body:{comment:'cancel',interrupt:true}}:kind==='missing-run'?{issue:{status:'in_progress',checkoutRunId:'run',executionRunId:'run'}}:{});
 let locked=false;const get=f.sandbox.svc.getByIdForUpdate;
 f.sandbox.svc.getByIdForUpdate=async(...args)=>{locked=true;if(kind==='missing-run')f.req.actor.runId=null;if(kind==='not-found')return null;return get(...args);};
 if(kind==='access')f.sandbox.decideIssueAccess=async()=>({allowed:!locked,reason:'allow_visible_issue_write'});
 if(kind==='board-pause')f.sandbox.treeControlSvc.getActivePauseHoldGate=async()=>locked?{holdId:'hold',rootIssueId:'root'}:null;
 if(kind.startsWith('watchdog')){
  f.sandbox.resolveTaskWatchdogMutationScope=async()=>locked?{kind:'watchdog',watchedIssueId:'root',watchdogId:'wd'}:{kind:'none'};
  f.sandbox.taskWatchdogScopeAllowsIssueMutation=async()=>kind==='watchdog-invalid'?{kind:'invalid',detail:'outside subtree'}:{kind:'allowed'};
  f.sandbox.taskWatchdogsSvc={revalidateMutationScope:async()=>({allowed:false,reason:'stale watchdog source'})};
  vm.runInContext(routeFunctions.get('assertFreshTaskWatchdogSourceMutation'),f.sandbox);
 }
 const replies=[],errors=[];let completed;const done=new Promise(r=>completed=r);
 const app=express();app.patch('/probe',async(_req,res)=>{
  f.res.status=n=>{res.status(n);return f.res;};f.res.json=value=>{replies.push(res.statusCode);res.json(value);return f.res;};
  try{await f.run();if(!res.headersSent)res.status(500).json({error:'missing response'});}catch(e){errors.push(e.code||e.message);if(!res.headersSent)res.status(e.status||500).json({error:e.message});}finally{completed();}
 });
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const port=server.address().port;
 try{
  const response=await fetch(`http://127.0.0.1:${port}/probe`,{method:'PATCH',signal:AbortSignal.timeout(3000)});await response.json();await done;
  const status=kind==='board-pause'||kind==='watchdog-stale'?409:kind==='missing-run'?401:kind==='not-found'?404:403;
  console.log(JSON.stringify({kind,status:response.status,replies,errors,persisted:f.calls.persisted.length,runEffects:f.calls.cancelled.length,actions:f.committed.actions.length}));
  assert.equal(response.status,status);assert.deepEqual(replies,[status]);assert.deepEqual(errors,[]);
  assert.equal(f.calls.persisted.length,0);assert.equal(f.calls.cancelled.length,0);assert.equal(f.committed.actions.length,0);assert.equal(f.events.some(x=>x.startsWith('goal:')),false);
 }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));server.closeAllConnections();}
 const closed=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});socket.once('connect',()=>{socket.destroy();resolve(false)});socket.once('error',e=>resolve(e.code==='ECONNREFUSED'));});assert.equal(closed,true);
});
