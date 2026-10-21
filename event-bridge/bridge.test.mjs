import test from 'node:test';
import assert from 'node:assert/strict';
import * as B from './bridge.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';

test('fake WS reconnect reconciles changes, duplicate hints do not replay unknown POST',async()=>{
  const dir=path.join(import.meta.dirname,'.fake-run'); fs.mkdirSync(dir,{recursive:true});
  let issueStatus='todo', posts=0, gets=0;
  const sockets=[];
  class FakeWS extends EventEmitter {constructor(){super();sockets.push(this)} terminate(){this.emit('close')}}
  const request=async(p,method)=>{
    if(method==='POST') {posts++;throw Error('offline-timeout')}
    gets++;
    if(p.includes('/issues?'))return [{id:'i',status:issueStatus}];
    if(p.endsWith('/agents'))return [{id:B.CEO,status:'idle',adapterConfig:{promptTemplate:'{{wakeReason}}'}}];
    return [];
  };
  const runner=await B.main(['--run','--state',path.join(dir,'state.json')],{request,WebSocket:FakeWS});
  try {
    assert.equal(posts,0); issueStatus='blocked';
    sockets[0].emit('message',Buffer.from(JSON.stringify({type:'activity.logged',payload:{entityType:'issue'}})));
    await runner.tick(); assert.equal(posts,1); assert.equal(runner.state.inflight.status,'uncertain');
    const before=gets;
    sockets[0].emit('open'); await runner.idle();
    assert(gets>before); assert.equal(posts,1);
    sockets[0].emit('message',Buffer.from(JSON.stringify({type:'heartbeat.run.status',payload:{agentId:B.CEO,runId:'echo'}})));
    await runner.tick();assert.equal(posts,1);
  } finally {runner.stop();await runner.idle();fs.rmSync(dir,{recursive:true,force:true});}
});
const scratch = path.join(import.meta.dirname, '.test-state');

test('persisted target mismatch or missing identity fails before any I/O or state mutation',async()=>{
 const dir=fs.mkdtempSync(path.join(import.meta.dirname,'../.local/identity-test-'));
 const example=path.resolve(import.meta.dirname,'../integration.example.json');
 try {
  const original=JSON.parse(fs.readFileSync(example));
  for(const change of ['company','ceo','api','api-path','legacy']) {
   const s=B.initialState();s.initialized=true;
   s.pending['issue:old']={kind:'issue',id:'old',status:'blocked'};
   s.tracked.old='worker';s.inflight={key:'old-key',runId:'old-run',status:'accepted'};
   if(change==='legacy')delete s.identity;
   const bytes=JSON.stringify(s), file=path.join(dir,'state.json');fs.writeFileSync(file,bytes);
   const c=structuredClone(original);c.bridge.hermesAdapterRoot=path.resolve(import.meta.dirname,'../node_modules/@paperclipai/hermes-paperclip-adapter');
   if(change==='company')c.companyId='00000000-0000-4000-8000-000000000003';
   if(change==='ceo')c.ceoAgentId='00000000-0000-4000-8000-000000000004';
   if(change==='api')c.apiUrl='http://offline.invalid/other';
   if(change==='api-path')c.apiUrl=original.apiUrl+'/other';
   const config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify(c));
   let requests=0,sockets=0;
   class NoWS {constructor(){sockets++;throw Error('unexpected_ws')}}
   for(const mode of ['--once','--run','--status','--check']) {
    await assert.rejects(B.main([mode,'--config',config,'--state',file],{request:async()=>{requests++;throw Error('unexpected_request')},WebSocket:NoWS,print:()=>{}}),/state_identity_(missing|mismatch)/);
    assert.equal(fs.readFileSync(file,'utf8'),bytes);
    assert.equal(fs.existsSync(file+'.lock'),false);
   }
   assert.equal(requests,0);assert.equal(sockets,0);
   assert.throws(()=>B.observe(s,[{kind:'issue',id:'new-history',status:'done'}]),/state_identity_(missing|mismatch)/);
   await assert.rejects(B.snapshot(async()=>{requests++;return []},s),/state_identity_(missing|mismatch)/);
   await assert.rejects(B.deliver(s,false,async()=>{requests++},()=>{throw Error('unexpected_save')}),/state_identity_(missing|mismatch)/);
   assert.equal(JSON.stringify(s),bytes);assert.equal(requests,0);
   await B.main(['--status','--config',example,'--state',path.join(dir,'absent.json')],{print:()=>{}});
  }
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('existing unreadable or malformed state is never treated as a fresh baseline',async()=>{
 const dir=fs.mkdtempSync(path.join(import.meta.dirname,'../.local/invalid-state-'));
 const example=path.resolve(import.meta.dirname,'../integration.example.json');
 try {
  for(const kind of ['dangling','invalid-json','directory','version']) {
   const file=path.join(dir,kind);let requests=0;
   if(kind==='dangling')fs.symlinkSync(path.join(dir,'missing-target'),file);
   else if(kind==='directory')fs.mkdirSync(file);
   else fs.writeFileSync(file,kind==='invalid-json'?'{':JSON.stringify({...B.initialState(),version:99}));
   await assert.rejects(B.main(['--once','--config',example,'--state',file],{request:async()=>{requests++;return []}}));
   assert.equal(requests,0);assert.equal(fs.existsSync(file+'.lock'),false);
   if(kind==='dangling')assert.equal(fs.lstatSync(file).isSymbolicLink(),true);
  }
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('new baseline binds normalized request base; same target restart preserves uncertainty and revision upgrades',async()=>{
 const dir=fs.mkdtempSync(path.join(import.meta.dirname,'../.local/restart-test-'));
 const example=path.resolve(import.meta.dirname,'../integration.example.json');
 const config=path.join(dir,'config.json'), state=path.join(dir,'state.json');
 const c=JSON.parse(fs.readFileSync(example));
 c.apiUrl='http://OFFLINE.INVALID:80/prefix/x/../api///';c.authEnv='OFFLINE_REGRESSION_IDENTITY';
 c.bridge.hermesAdapterRoot=path.resolve(import.meta.dirname,'../node_modules/@paperclipai/hermes-paperclip-adapter');
 const previousFetch=globalThis.fetch;const urls=[],sockets=[];let posts=0,issueStatus='blocked',runner;
 class FakeWS extends EventEmitter {constructor(url){super();sockets.push(this);urls.push(url)}terminate(){this.emit('close')}}
 process.env.OFFLINE_REGRESSION_IDENTITY='synthetic';
 globalThis.fetch=async(url,options)=>{
  urls.push(url);
  if(options.method==='POST'){posts++;throw Error('offline-timeout')}
  const p=new URL(url).pathname;
  const rows=p.endsWith('/issues')?[{id:'historical',status:issueStatus}]:p.endsWith('/agents')?[{id:c.ceoAgentId,status:'idle',adapterConfig:{promptTemplate:'{{wakeReason}}'}}]:[];
  return {ok:true,json:async()=>rows};
 };
 try {
  fs.writeFileSync(config,JSON.stringify(c));
  runner=await B.main(['--run','--config',config,'--state',state],{WebSocket:FakeWS});
  assert.equal(posts,0);assert.deepEqual(runner.state.pending,{});
  assert.deepEqual(runner.state.identity,{apiBase:'http://offline.invalid/prefix/api',companyId:c.companyId,ceoAgentId:c.ceoAgentId});
  issueStatus='done';sockets.at(-1).emit('message',Buffer.from(JSON.stringify({type:'activity.logged',payload:{entityType:'issue'}})));
  await runner.tick();assert.equal(posts,1);assert.equal(runner.state.inflight.status,'uncertain');
  runner.stop();await runner.idle();runner=null;
  const saved=JSON.parse(fs.readFileSync(state));delete saved.revisions;fs.writeFileSync(state,JSON.stringify(saved));
  c.apiUrl='http://offline.invalid/prefix/api/';fs.writeFileSync(config,JSON.stringify(c));
  runner=await B.main(['--run','--config',config,'--state',state],{WebSocket:FakeWS});
  assert.equal(posts,1);assert.equal(runner.state.inflight.status,'uncertain');assert.deepEqual(runner.state.pending,{});
  assert.equal(runner.state.revisions,undefined);
  issueStatus='blocked';sockets.at(-1).emit('message',Buffer.from(JSON.stringify({type:'activity.logged',payload:{entityType:'issue'}})));
  await runner.tick();assert.equal(runner.state.pending['issue:historical'].revision,1);assert.equal(posts,1);
  assert(urls.some(url=>url==='http://offline.invalid/prefix/api/agents/'+c.ceoAgentId+'/heartbeat/invoke'));
  assert(urls.some(url=>url==='ws://offline.invalid/prefix/api/companies/'+c.companyId+'/events/ws'));
  assert(urls.every(url=>/^(http|ws):\/\/offline\.invalid\/prefix\/api\//.test(url)));
 } finally {
  if(runner){runner.stop();await runner.idle()}
  globalThis.fetch=previousFetch;delete process.env.OFFLINE_REGRESSION_IDENTITY;
  await B.main(['--status','--config',example,'--state',path.join(dir,'absent.json')],{print:()=>{}});
  fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('legacy state upgrades only on real change; recurring states have monotonic revision',async()=>{
  const s=B.initialState(), row={kind:'issue',id:'revision-test',status:'blocked'};
  B.observe(s,[row]);
  delete s.revisions; // previous persisted version, not a new baseline
  s.pending['issue:revision-test']={...row};
  B.observe(s,[row]);
  assert.equal(s.pending['issue:revision-test'].revision,undefined);
  for (const [status,revision] of [['done',1],['blocked',2],['done',3]]) {
    B.observe(s,[{...row,status}]);
    assert.equal(s.pending['issue:revision-test'].revision,revision);
    const unchanged=JSON.stringify(s);
    B.observe(s,[{...row,status}]);
    assert.equal(JSON.stringify(s),unchanged);
  }
  await B.deliver(s,false,async()=>({id:'revision-run'}),()=>{});
  assert.equal(s.inflight.batch[0].revision,3);
  B.settle(s,{id:'revision-run',status:'succeeded'});
  assert.equal(s.lastDelivery.batch[0].revision,3);
  const restored=JSON.parse(JSON.stringify(s));
  B.observe(restored,[{...row,status:'blocked'}]);
  assert.equal(restored.pending['issue:revision-test'].revision,4);
});

test('installed default prompt drops pointers; explicit wakeReason template carries them',async()=>{
  assert.equal(await B.promptContract({}),false);
  assert.equal(await B.promptContract({promptTemplate:'Regent管理唤醒：{{wakeReason}}'}),true);
});

test('CLI once performs GET only and does not save baseline or acquire lock',async()=>{
  fs.mkdirSync(scratch,{recursive:true}); const stateFile=path.join(scratch,'once.json'); const methods=[];
  const request=async(p,method)=>{methods.push(method); return p.includes('/agents') ? [{id:B.CEO,status:'idle'}] : [];};
  await B.main(['--once','--state',stateFile],{request,print:()=>{}});
  assert(methods.length>0); assert(methods.every(x=>x==='GET'));
  assert.equal(fs.existsSync(stateFile),false); assert.equal(fs.existsSync(stateFile+'.lock'),false);
  fs.rmSync(scratch,{recursive:true,force:true});
});

test('fresh baseline includes historical failures without waking; own agent error ignored',()=>{
  const s=B.initialState();
  const rows=[{kind:'run',id:'historical',agentId:'worker',status:'failed'},{kind:'issue',id:'old',status:'blocked'}];
  B.observe(s,rows); B.observe(s,rows);
  B.observe(s,[{kind:'agent',id:B.CEO,status:'error'}]);
  assert.equal(Object.keys(s.pending).length,0);
});

test('failed delivery run records terminal metadata without claiming consumed',()=>{
  const s=B.initialState(); s.inflight={key:'k',runId:'r',status:'accepted'};
  B.settle(s,{id:'r',status:'failed'});
  assert.equal(s.lastDelivery.runStatus,'failed'); assert.equal(s.lastDelivery.consumed,'unverified');
});

test('CLI config argv works without ambient config; check never sends network',async()=>{
  const {spawnSync}=await import('node:child_process');
  const env={PATH:process.env.PATH,HOME:process.env.HOME,PAPERCLIP_BRIDGE_READ_IDENTITY:'synthetic-check-token'};
  const result=spawnSync(process.execPath,[path.join(import.meta.dirname,'bridge.mjs'),'--config',path.join(import.meta.dirname,'../integration.example.json'),'--check'],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);assert.equal(output.network,false);assert.equal(output.model,false);
  assert.equal(result.stdout.includes('synthetic-check-token'),false);
});

test('failure/timeout/completion tracked, CEO echo and logs ignored', () => {
  const s=B.initialState(); B.observe(s, []);
  for (const status of ['failed','timed_out','succeeded']) {
    B.observe(s,[{kind:'run',id:status,agentId:'worker',status}]);
  }
  B.observe(s,[{kind:'run',id:'self',agentId:B.CEO,status:'failed'}]);
  assert.equal(Object.keys(s.pending).length,3);
  assert.equal(B.relevantEvent({type:'heartbeat.run.status',payload:{agentId:B.CEO}}),false);
  assert.equal(B.relevantEvent({type:'heartbeat.run.log',payload:{agentId:'worker'}}),false);
  assert.equal(B.relevantEvent({type:'activity.logged',payload:{entityType:'issue'}}),true);
});

test('issues paginated, tracked old run individually reconciled beyond recent window', async () => {
  const s=B.initialState(); s.tracked.old='worker'; const calls=[];
  const get=async p=>{calls.push(p);
    if(p.includes('/issues?')) return p.includes('offset=0') ? [{id:'a',status:'blocked',description:'PRIVATE'}] : [];
    if(p.includes('/interactions')) return [{id:'x',status:'pending',payload:{text:'PRIVATE'}}];
    if(p.includes('/agents')) return [{id:B.CEO,status:'idle'}];
    if(p.includes('/approvals')) return [];
    if(p.includes('/heartbeat-runs/old')) return {id:'old',agentId:'worker',status:'failed',stdoutExcerpt:'PRIVATE'};
    if(p.includes('/heartbeat-runs?')) return [];
    throw Error('unexpected');
  };
  const snap=await B.snapshot(get,s,1);
  assert(calls.some(p=>p.includes('offset=1')));
  assert(calls.includes('/heartbeat-runs/old'));
  assert(snap.rows.some(r=>r.id==='old' && r.status==='failed'));
  assert(!JSON.stringify(snap).includes('PRIVATE'));
});

test('busy merges pending; accepted stays in-flight until exact run terminal',async()=>{
  const s=B.initialState(); B.observe(s,[]); let posts=0;
  B.observe(s,[{kind:'issue',id:'i',status:'blocked'}]);
  await B.deliver(s,true,async()=>{posts++},()=>{});
  B.observe(s,[{kind:'issue',id:'i',status:'done'}]);
  assert.equal(posts,0); assert.equal(Object.keys(s.pending).length,1);
  await B.deliver(s,false,async(body)=>{posts++; assert(!('forceFreshSession' in body));return {id:'native-run',status:'queued'}},()=>{});
  assert.equal(s.inflight.status,'accepted'); assert.equal(posts,1);
  await B.deliver(s,false,async()=>{posts++},()=>{}); assert.equal(posts,1);
  B.settle(s,{id:'other',status:'succeeded'}); assert(s.inflight);
  B.settle(s,{id:'native-run',status:'succeeded'}); assert.equal(s.inflight,null);
  assert.equal(s.lastDelivery.consumed,'unverified');
});

test('unknown delivery survives restart/reconnect without replay',async()=>{
  const s=B.initialState(); B.observe(s,[]); B.observe(s,[{kind:'issue',id:'i',status:'blocked'}]);
  let calls=0,saved;
  await B.deliver(s,false,async()=>{calls++;throw Error('timeout SECRET')},()=>{saved=JSON.stringify(s)});
  assert.equal(s.inflight.status,'uncertain'); assert(!saved.includes('SECRET'));
  const restored=JSON.parse(saved); B.observe(restored,[{kind:'issue',id:'i',status:'done'}]);
  await B.deliver(restored,false,async()=>{calls++},()=>{}); assert.equal(calls,1);
});

test('exclusive lock refuses second process and releases',()=>{
  fs.mkdirSync(scratch,{recursive:true}); const lock=path.join(scratch,'lock');
  const release=B.acquireLock(lock);
  try { assert.throws(()=>B.acquireLock(lock),/locked/); } finally {release()}
  B.acquireLock(lock)(); fs.rmSync(scratch,{recursive:true,force:true});
});

test('metadata changes queue once; baseline and repeated snapshots stay quiet', () => {
  const s = B.initialState();
  const rows = [{kind:'issue',id:'i',status:'todo',blockedBy:[]}];
  B.observe(s, rows);
  assert.equal(Object.keys(s.pending).length, 0);
  B.observe(s, [{...rows[0],status:'blocked'}]);
  assert.equal(Object.keys(s.pending).length, 1);
  B.observe(s, [{...rows[0],status:'blocked'}]);
  assert.equal(Object.keys(s.pending).length, 1);
});
