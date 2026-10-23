import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {runChildProcess,runningProcesses,signalRunningProcess,MAX_CAPTURE_BYTES} from '@paperclipai/adapter-utils/server-utils';
import {runningProcesses as directRegistry} from './node_modules/@paperclipai/adapter-utils/dist/server-utils.js';
const cwd=fileURLToPath(new URL('.',import.meta.url));
const prelude=`const delay=ms=>new Promise(r=>setTimeout(r,ms)); const write=(s,b)=>new Promise(r=>process[s].write(b,r));`;
async function run(body,extra={}) {
 const id=crypto.randomUUID(), logs={stdout:'',stderr:''}; let active=0,maxActive=0,spawned;
 const result=await runChildProcess(id,process.execPath,['--input-type=module','-e',prelude+body],{
 cwd,env:{HOME:cwd,TMPDIR:cwd},timeoutSec:4,graceSec:1,
 onSpawn:async m=>{spawned=m;}, onLog:async(s,c)=>{active++;maxActive=Math.max(maxActive,active);await delay(2);logs[s]+=c;active--;},...extra});
 assert.equal(runningProcesses.has(id),false);assert.equal(active,0);assert.equal(maxActive,extra.onLog ? 0 : 1);assert.equal(spawned.pid,result.pid);
 return {result,logs};
}
for(const stream of ['stdout','stderr']) test(`${stream}: all byte cuts preserve Chinese emoji and literal replacement character`,async()=>{
 const text='前中后🙂�';const b=Buffer.from(text);
 const {result,logs}=await run(`const b=Buffer.from(${JSON.stringify(text)});for(const byte of b){await write('${stream}',Buffer.from([byte]));await delay(12);}`);
 assert.equal(result.exitCode,0);assert.equal(result[stream],text);assert.equal(logs[stream],text);
});
test('both streams flush truncated UTF8 tail once before close and log completion',async()=>{
 const {result,logs}=await run(`for(const s of ['stdout','stderr']){await write(s,Buffer.from('好'));await write(s,Buffer.from([0xf0,0x9f]));}`);
 for(const s of ['stdout','stderr']){assert.equal(result[s],'好�');assert.equal(logs[s],'好�');}
});
test('large capture retains existing cap while logChain sees full text',async()=>{
 const {result,logs}=await run(`await write('stdout','x'.repeat(${MAX_CAPTURE_BYTES+4096})+'中🙂');`);
 assert.equal(result.stdout.length,MAX_CAPTURE_BYTES);assert.equal(logs.stdout.length,MAX_CAPTURE_BYTES+4099);assert.ok(result.stdout.endsWith('中🙂'));assert.equal(result.exitCode,0);
});
test('nonzero exit retains decoded output',async()=>{
 const {result}=await run(`await write('stderr',Buffer.from([0xe4]));await delay(30);await write('stderr',Buffer.from([0xb8,0xad]));process.exitCode=7;`);
 assert.equal(result.stderr,'中');assert.equal(result.exitCode,7);assert.equal(result.timedOut,false);
});
test('timeout closes process, flushes decoder and clears registry',async()=>{
 const {result,logs}=await run(`await write('stdout',Buffer.from([0xe4]));setInterval(()=>{},1000);`,{timeoutSec:0.25});
 assert.equal(result.timedOut,true);assert.equal(result.signal,'SIGTERM');assert.equal(result.stdout,'�');assert.equal(logs.stdout,'�');
});
test('same SDK registry supports cancellation of owned process without rebinding',async()=>{
 assert.equal(runningProcesses,directRegistry);
 const id=crypto.randomUUID(); let observed=false;
 const result=await runChildProcess(id,process.execPath,['--input-type=module','-e',prelude+`await write('stdout',Buffer.from('中🙂'));setInterval(()=>{},1000);`],{cwd,env:{HOME:cwd},timeoutSec:3,graceSec:1,onLog:async(s,c)=>{
 assert.equal(c,'中🙂');const entry=runningProcesses.get(id);assert.ok(entry);observed=true;signalRunningProcess(entry,'SIGTERM');}});
 assert.equal(observed,true);assert.equal(result.signal,'SIGTERM');assert.equal(result.timedOut,false);assert.equal(result.stdout,'中🙂');assert.equal(runningProcesses.has(id),false);
});
test('rejected log callback still follows original error reporting and settles',async()=>{
 let errors=0;
 const {result}=await run(`await write('stdout','ok');`,{onLog:async()=>{throw new Error('synthetic');},onLogError:()=>{errors++;}}).catch(e=>{if(e.code==='ERR_ASSERTION')throw e;throw e;});
 assert.equal(result.exitCode,0);assert.equal(errors,1);
});
