import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {bindHostSdk} from '../host-binding.mjs';
import {syntheticHost} from './fixtures/synthetic-host.mjs';
import * as local from '@paperclipai/adapter-utils/server-utils';
const root=path.resolve(import.meta.dirname,'..');
function fixture(t){const dir=fs.mkdtempSync(path.join(process.env.TMPDIR,'binding-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return syntheticHost(dir);}
test('offline ESM host anchor binds actual canonical SDK objects',async t=>{
 const host=fixture(t), binding=await bindHostSdk(host);
 assert.equal(binding.runningProcesses,local.runningProcesses);
 assert.equal(binding.runChildProcess,local.runChildProcess);
 assert.equal(binding.signalRunningProcess,local.signalRunningProcess);
 assert.ok(binding.url.startsWith('file:'));
});
test('real ESM import condition wins over incompatible require condition',async t=>{
 const host=fixture(t),pkg=path.join(host,'node_modules/@paperclipai/adapter-utils');
 fs.mkdirSync(path.join(pkg,'esm'),{recursive:true});
 fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'@paperclipai/adapter-utils',version:'2026.1005.0',type:'module',exports:{'./server-utils':{import:'./esm/runner.js',require:'./wrong.cjs'}}}));
 fs.writeFileSync(path.join(pkg,'esm/runner.js'),'export const runningProcesses=new Map();export function runChildProcess(){};export function signalRunningProcess(){};');
 fs.writeFileSync(path.join(pkg,'wrong.cjs'),'throw Error("CJS must not be selected");');
 const binding=await bindHostSdk(host);
 assert.equal(binding.url,pathToFileURL(path.join(pkg,'esm/runner.js')).href);
});
test('actual consumer map mismatch refuses despite matching source markers',async t=>{
 const host=fixture(t),file=path.join(host,'dist/adapters/utils.js');
 const source=fs.readFileSync(file,'utf8');
 fs.writeFileSync(file,source.replace('export const runningProcesses = serverUtils.runningProcesses;','// export const runningProcesses = serverUtils.runningProcesses;\nexport const runningProcesses = new Map();'));
 await assert.rejects(bindHostSdk(host),{message:'installation_host_binding_invalid'});
});
test('missing/relative/wrong host refuses with fixed safe error',async()=>{
 for(const value of [undefined,'relative','/synthetic/absent'])await assert.rejects(bindHostSdk(value),{message:'installation_host_binding_invalid'});
});
test('wrong pinned version refuses',async t=>{
 const host=fixture(t),p=path.join(host,'package.json'),pkg=JSON.parse(fs.readFileSync(p));pkg.version='2026.1004.0';fs.writeFileSync(p,JSON.stringify(pkg));
 await assert.rejects(bindHostSdk(host),{message:'installation_host_binding_invalid'});
});
test('bundled host without SDK registry import refuses',async t=>{
 const host=fixture(t);fs.writeFileSync(path.join(host,'dist/adapters/utils.js'),'export const runningProcesses = new Map();');
 await assert.rejects(bindHostSdk(host),{message:'installation_host_binding_invalid'});
});
test('unsafe runtime modes refuse before any host lookup',async()=>{
 const old=process.env.NODE_OPTIONS;
 try {process.env.NODE_OPTIONS='--preserve-symlinks';await assert.rejects(bindHostSdk('/synthetic'),{message:'installation_host_binding_invalid'});}finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
 for(const flag of ['--preserve-symlinks','--preserve-symlinks-main','--loader=x','--import=x','--conditions=x','-r']){
  process.execArgv.push(flag);try{await assert.rejects(bindHostSdk('/synthetic'),{message:'installation_host_binding_invalid'});}finally{process.execArgv.pop();}
 }
});
test('real preserve-symlinks process refuses a valid host',t=>{
 const host=fixture(t),module=pathToFileURL(path.join(root,'host-binding.mjs')).href;
 const result=spawnSync(process.execPath,['--preserve-symlinks','--input-type=module','-e',`import {bindHostSdk} from ${JSON.stringify(module)}; try {await bindHostSdk(${JSON.stringify(host)});process.exitCode=9;}catch(e){if(e.message!=='installation_host_binding_invalid')process.exitCode=8;}`],{env:{},encoding:'utf8',timeout:5000});
 assert.equal(result.status,0);
});
