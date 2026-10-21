import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as B from './bridge.mjs';
const ID='00000000-0000-4000-8000-000000000003';

test('read comments checks parent ownership before returning authenticated comment data',async()=>{
  const calls=[];
  const result=await B.readResource('comments',ID,async p=>{
    calls.push(p);
    if(p==='/agents/me')return {id:B.CEO,companyId:B.COMPANY};
    if(p==='/issues/'+ID)return {id:ID,companyId:B.COMPANY};
    assert.equal(p,'/issues/'+ID+'/comments');
    return [{id:'comment-1',body:'actual review',authorAgentId:B.CEO,hidden:'omit'}];
  });
  assert.equal(result.resource.issueId,ID);
  assert.equal(result.resource.comments[0].body,'actual review');
  assert.equal('hidden' in result.resource.comments[0],false);
  assert.equal(calls.length,3);
});

test('read CLI resolves a run pointer with the same authenticated identity',async()=>{
  const calls=[], output=[];
  await B.main(['--read','run',ID],{request:async(p,method)=>{
    calls.push({p,method});
    if(p==='/agents/me')return {id:B.CEO,companyId:B.COMPANY};
    assert.equal(p,'/heartbeat-runs/'+ID);
    return {id:ID,companyId:B.COMPANY,agentId:B.CEO,status:'succeeded',errorCode:null};
  },print:x=>output.push(x)});
  assert.equal(output[0].resource.status,'succeeded');
  assert.equal(output[0].resource.agentId,B.CEO);
  assert(calls.every(x=>x.method==='GET'));
});

test('read rejects malformed paths, writes, other identities and foreign resources',async()=>{
  for (const [kind,id] of [['POST',ID],['issue',ID+'/comments'],['issue','bad%2Fid']]) {
    let calls=0;
    await assert.rejects(B.readResource(kind,id,async()=>{calls++;}),/invalid_read_target/);
    assert.equal(calls,0);
  }
  const seen=[];
  await assert.rejects(B.readResource('issue',ID,async p=>{seen.push(p);return {id:'other-agent',companyId:B.COMPANY};}),/identity_mismatch/);
  assert.deepEqual(seen,['/agents/me']);
  const paths=[];
  await assert.rejects(B.readResource('comments',ID,async p=>{
    paths.push(p);return p==='/agents/me' ? {id:B.CEO,companyId:B.COMPANY} : {id:ID,companyId:'foreign'};
  }),/resource_mismatch/);
  assert.deepEqual(paths,['/agents/me','/issues/'+ID]);
  await assert.rejects(B.main(['--read','issue',ID,'--run'],{request:()=>assert.fail('no request')}),/choose_one_mode/);
  await assert.rejects(B.main(['--read','issue',ID,'--state','unused'],{request:()=>assert.fail('no request')}),/read_does_not_accept_state/);
});

test('read CLI performs no state file opens, writes or directory creation',async()=>{
  const original=Object.fromEntries(['mkdirSync','openSync','writeFileSync'].map(k=>[k,fs[k]]));
  try {
    for(const k of Object.keys(original))fs[k]=()=>assert.fail('read unexpectedly called fs.'+k);
    await B.main(['--read','issue',ID],{request:async p=>p==='/agents/me' ? {id:B.CEO,companyId:B.COMPANY} : {id:ID,companyId:B.COMPANY,status:'done'},print:()=>{}});
  }finally{Object.assign(fs,original);}
});

test('read CLI authenticates same CEO and queries exact issue without scheduler/state effects',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'regent-read-'));
  const calls=[], output=[];
  try {
    await B.main(['--read','issue',ID],{
      request:async(p,method)=>{
        calls.push({p,method});
        if(p==='/agents/me')return {id:B.CEO,companyId:B.COMPANY};
        assert.equal(p,'/issues/'+ID);
        return {id:ID,identifier:'SYNTH-1',companyId:B.COMPANY,status:'done',title:'notification test',secretField:'not projected'};
      },
      print:value=>output.push(value),
      WebSocket:class {constructor(){assert.fail('read must not open WS');}}
    });
    assert.deepEqual(calls,[{p:'/agents/me',method:'GET'},{p:'/issues/'+ID,method:'GET'}]);
    assert.equal(output.length,1);
    assert.equal(output[0].resource.status,'done');
    assert.equal(output[0].resource.identifier,'SYNTH-1');
    assert.equal(output[0].identity.agentId,B.CEO);
    assert.equal(JSON.stringify(output).includes('secretField'),false);
    assert.deepEqual(fs.readdirSync(dir),[]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
