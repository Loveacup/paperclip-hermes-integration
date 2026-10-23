import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {createServerAdapter} from './adapter-fixture.mjs';
import {createOmpOutputParser} from '../output-parser.mjs';
const CAP=4*1024*1024;
test('cap: C1 SYNTHETIC-CAP-A independent frozen regression v1 (complete legal stream at exact capture cap)', async () => {
const line=o=>JSON.stringify(o)+'\n';
const final=line({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop'}],isTerminal:true});
const unit=line({type:'message_update',text:'x'.repeat(1000)});
const n=Math.floor((CAP-final.length-50)/unit.length);
let prefix=unit.repeat(n);
const pad=CAP-prefix.length-final.length;
const empty=line({type:'message_update',text:''});
prefix+=line({type:'message_update',text:'p'.repeat(pad-empty.length)});
const stdout=prefix+final;
assert.equal(stdout.length,CAP);
const parser=createOmpOutputParser();parser.feed(stdout);const parsed=parser.end();
assert.deepEqual(parsed.damage,[]);assert.ok(parsed.final);
const dir=mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR,'boundary-'));
try {
const adapter=createServerAdapter({statPath:async()=>({isDirectory:()=>true}),runChildProcess:async(_r,_c,_a,opts)=>{await opts.onLog('stdout',stdout);return {stdout,stderr:'',exitCode:0,signal:null,timedOut:false};}});
const r=await adapter.execute({runId:'synthetic-cap-a-independent-cap',agent:{id:'judge',companyId:'test',name:'test',adapterType:'omp_local'},runtime:{},config:{cwd:dir,env:{PAPERCLIP_RUN_SCRATCH_DIR:dir}},context:{taskId:'synthetic-cap-a',issueId:'synthetic-cap-a',paperclipScratch:{type:'heartbeat_run',dir},paperclipWake:{reason:'issue_assigned',issue:{id:'synthetic-cap-a',identifier:'SYNTHETIC-CAP-A',title:'test'}}},onLog:async()=>{},onMeta:async()=>{}});
console.log(JSON.stringify({bytes:stdout.length,parserDamage:parsed.damage,errorCode:r.errorCode,diagnostics:r.resultJson?.diagnostics}));
assert.equal(r.errorCode??null,null,'ADAPT-OUT-REV: complete legal stream at capture cap must not fail on capture_cap alone');
} finally {rmSync(dir,{recursive:true,force:true});}
});

// C2/C3 guards (SYNTHETIC-CAP-B). Same exact-cap legal stream as C1; native capture == stdout.
function capStream(padChar='p'){
  const line=o=>JSON.stringify(o)+'\n';
  const final=line({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text:'done'}],stopReason:'stop'}],isTerminal:true});
  const unit=line({type:'message_update',text:'x'.repeat(1000)});
  const n=Math.floor((CAP_BYTES-final.length-50)/unit.length);
  const empty=line({type:'message_update',text:''});
  const body=unit.repeat(n);
  const pad=CAP_BYTES-body.length-final.length;
  const prefix=body+line({type:'message_update',text:padChar.repeat(pad-empty.length)});
  return {prefix,final,stdout:prefix+final};
}
const CAP_BYTES=4*1024*1024;
async function runAtCap(captured, fedChunks){
  const dir=mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.TMPDIR ?? '/tmp','capb-'));
  try {
    const adapter=createServerAdapter({statPath:async()=>({isDirectory:()=>true}),runChildProcess:async(_r,_c,_a,opts)=>{for (const c of fedChunks) await opts.onLog('stdout',c);return {stdout:captured,stderr:'',exitCode:0,signal:null,timedOut:false};}});
    return await adapter.execute({runId:'synthetic-cap-b-cap',agent:{id:'judge',companyId:'test',name:'test',adapterType:'omp_local'},runtime:{},config:{cwd:dir,env:{PAPERCLIP_RUN_SCRATCH_DIR:dir}},context:{taskId:'synthetic-cap-b',issueId:'synthetic-cap-b',paperclipScratch:{type:'heartbeat_run',dir},paperclipWake:{reason:'issue_assigned',issue:{id:'synthetic-cap-b',identifier:'SYNTHETIC-CAP-B',title:'test'}}},onLog:async()=>{},onMeta:async()=>{}});
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test('cap: C2 exact-cap capture with same-length but different onLog bytes keeps capture_cap and fails closed', async () => {
  const {stdout}=capStream('p');
  const fed=capStream('q').stdout;
  assert.equal(stdout.length,CAP_BYTES);
  assert.equal(Buffer.byteLength(fed),Buffer.byteLength(stdout));
  assert.notEqual(fed,stdout);
  const r=await runAtCap(stdout,[fed]);
  assert.equal(r.errorCode,'omp_output_damaged');
  assert.equal(r.resultJson.runOutcome,'failed');
  assert.ok(r.resultJson.diagnostics.damage.includes('capture_cap'),String(r.resultJson.diagnostics.damage));
});

test('cap: C3 exact-cap capture with one onLog chunk missing reports stream_incomplete and fails', async () => {
  const {prefix,final,stdout}=capStream('p');
  assert.equal(stdout.length,CAP_BYTES);
  const r=await runAtCap(stdout,[prefix]);
  assert.ok(final.length>0);
  assert.equal(r.resultJson.runOutcome,'failed');
  assert.ok(r.resultJson.diagnostics.damage.includes('stream_incomplete'),String(r.resultJson.diagnostics.damage));
});
