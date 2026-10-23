import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {findPackageJSON,syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import * as candidate from '@paperclipai/adapter-utils/server-utils';
import {bindHostSdk} from '../../host-binding.mjs';
import {registryProbe} from '../registry-probe.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const hostRoot=process.env.OMP_TEST_HOST_ROOT;
assert.ok(hostRoot,'explicit --host tier requires host package root');
const anchor=pathToFileURL(path.join(hostRoot,'dist/adapters/utils.js')).href;
const hostPackage=findPackageJSON('@paperclipai/adapter-utils/server-utils',anchor);
// Independently load the inspected fixed-version export target. No host logger,
// heartbeat service, database, registration, provider or server is initialized.
const host=await import(pathToFileURL(path.join(path.dirname(hostPackage),'dist/server-utils.js')).href);
test('real split SDK negative control: metadata cannot fill host registry',async()=>{
 assert.notEqual(candidate.runningProcesses,host.runningProcesses);
 assert.notEqual(candidate.runChildProcess,host.runChildProcess);
 const report=await registryProbe(candidate,host,root,false);
 assert.equal(report.hostVisible,false);assert.equal(report.mapsCleared,true);
 console.log(JSON.stringify({case:'negative-control',...report}));
});
test('bound runner is the actual host runner; host stop gate terminates owned Node',async()=>{
 const bound=await bindHostSdk(hostRoot);
 assert.equal(bound.runningProcesses,host.runningProcesses);
 assert.equal(bound.runChildProcess,host.runChildProcess);
 const report=await registryProbe(bound,host,root);
 console.log(JSON.stringify({case:'bound-runner',...report}));
});
test('actual installation entry dispatch registers host map, not candidate map',async t=>{
 const repo=fs.mkdtempSync(path.join(process.env.TMPDIR,'entry-dispatch-'));
 t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
 const pkg=path.join(repo,'omp-local-adapter');fs.mkdirSync(pkg);
 for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.mjs')||f==='package.json'))fs.copyFileSync(path.join(root,file),path.join(pkg,file));
 fs.mkdirSync(path.join(repo,'scripts'));
 fs.copyFileSync(path.join(root,'tests/fixtures/shared/config.mjs'),path.join(repo,'scripts/config.mjs'));
 fs.copyFileSync(path.join(root,'tests/fixtures/shared/config.schema.json'),path.join(repo,'config.schema.json'));
 const config=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/shared/integration.example.json')));
 config.omp.command=process.execPath;config.host.paperclipServerRoot=hostRoot;
 const configPath=path.join(repo,'synthetic.json');fs.writeFileSync(configPath,JSON.stringify(config));
 const old=process.env.PAPERCLIP_INTEGRATION_CONFIG;process.env.PAPERCLIP_INTEGRATION_CONFIG=configPath;
 t.after(()=>{if(old===undefined)delete process.env.PAPERCLIP_INTEGRATION_CONFIG;else process.env.PAPERCLIP_INTEGRATION_CONFIG=old;});
 const entry=await import(pathToFileURL(path.join(pkg,'entry.mjs')).href);
 const adapter=entry.createServerAdapter({runChildProcess(){throw Error('untrusted override');}});
 const id=`entry-binding-${process.pid}-${crypto.randomUUID()}`;
 let child,spawnMeta,readyResolve,timer;
 const ready=new Promise(r=>readyResolve=r);
 const original=childProcess.spawn;
 // Test-only argv translation, below the real entry/core/SDK dispatch boundary.
 // The only OS child is our bounded Node fixture. Never starts OMP.
 childProcess.spawn=(command,args,opts)=>{
   assert.equal(command,process.execPath);
   assert.ok(args.includes('--mode'));
   child=original(command,['-e','console.log("READY");setTimeout(()=>process.exit(0),4000)'],{...opts,env:{}});
   return child;
 };
 syncBuiltinESMExports();
 const pending=adapter.execute({runId:id,agent:{id:'synthetic',companyId:'synthetic',name:'synthetic'},
   config:{cwd:repo,env:{PAPERCLIP_RUN_SCRATCH_DIR:repo}},
   context:{taskId:'synthetic-task',paperclipWake:{issue:{id:'synthetic-task',title:'Synthetic task'}},paperclipScratch:{type:'heartbeat_run',dir:repo}},
   onLog:async(_s,text)=>{if(text.includes('READY'))readyResolve();},onSpawn:async m=>{spawnMeta=m;},onMeta:async()=>{},
 });
 try {
   await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('entry_ready_timeout')),2500);})]);
   const tracked=host.runningProcesses.get(id);
   assert.equal(tracked?.child,child);assert.equal(candidate.runningProcesses.has(id),false);
   assert.equal(spawnMeta.pid,child.pid);
   if(tracked)host.signalRunningProcess(tracked,'SIGTERM');
   await pending;
   assert.equal(child.signalCode,'SIGTERM');
   assert.equal(host.runningProcesses.has(id),false);
   assert.equal(candidate.runningProcesses.has(id),false);
   console.log(JSON.stringify({case:'entry-dispatch',pid:child.pid,hostVisible:true,candidateVisible:false,signal:child.signalCode,mapsCleared:true}));
 } finally {
   clearTimeout(timer);
   if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
   await pending;
   childProcess.spawn=original;syncBuiltinESMExports();
 }
});
