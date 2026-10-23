import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServerAdapter} from './index.mjs';
const cwd=fileURLToPath(new URL('.',import.meta.url));
const fake=fileURLToPath(new URL('./repair-fixture.mjs',import.meta.url));
const run=(mode,onLog=async()=>{})=>createServerAdapter({command:process.execPath,prefixArgs:[fake,mode]}).execute({runId:crypto.randomUUID(),agent:{id:'offline',companyId:'offline',adapterConfig:{}},config:{cwd,timeoutSec:5,graceSec:1},context:{taskPrompt:'PRIVATE_PROMPT'},onLog});
test('large legitimate terminal history retains last assistant identity and stop',async()=>{
  const result=await run('large');
  assert.equal(result.exitCode,0);
  assert.equal(result.model,'offline/fixture');
  assert.equal(result.summary,'complete');
});
test('native progress is bounded, metadata-only and callback failure is closed',async()=>{
  const logs=[];
  const result=await run('progress',async(s,c)=>logs.push(c));
  assert.equal(result.exitCode,0);
  const progress=logs.filter(x=>x.startsWith('{')).map(x=>JSON.parse(x));
  assert.ok(progress.length>=4);
  assert.ok(progress.length<=64);
  for(const type of ['turn_start','tool_execution_start','tool_execution_end','turn_end']) assert.ok(progress.some(x=>x.eventType===type));
  assert.doesNotMatch(JSON.stringify([progress,result.resultJson.protocolDiagnostic]),/PRIVATE_/);
  assert.equal(result.resultJson.protocolDiagnostic.eventCounts.other,1);
  const failed=await run('progress',async(s,c)=>{if(c.startsWith('{')) throw Error('PRIVATE_FAILURE');});
  assert.equal(failed.errorCode,'omp_native_publication_failed');
});
test('large provider error remains failure even with exit zero',async()=>{
  const result=await run('large-error');
  assert.equal(result.errorCode,'omp_native_provider_error');
  assert.equal(result.resultJson.providerError,'Deadline exceeded');
  assert.equal(result.model,'offline/fixture');
  assert.equal(result.resultJson.protocolDiagnostic.reason,null);
});
test('existing malformed terminal guards have fixed diagnostics',async()=>{
  const fake=fileURLToPath(new URL('./fake-native.mjs',import.meta.url));
  for(const [mode,reason] of [['malformed','malformed_json'],['truncated','truncated_line'],['missing-stop','missing_terminal'],['duplicate-stop','duplicate_terminal'],['after-stop','activity_after_terminal'],['event-cap','event_limit'],['bad-stop','invalid_assistant'],['long','terminal_text_limit']]) {
    const result=await createServerAdapter({command:process.execPath,prefixArgs:[fake,`fixture:${mode}`]}).execute({runId:crypto.randomUUID(),agent:{id:'offline',companyId:'offline',adapterConfig:{}},config:{cwd},context:{taskPrompt:'offline'},onLog:async()=>{}});
    assert.notEqual(result.exitCode,0);
    assert.equal(result.resultJson.protocolDiagnostic.reason,reason,mode);
  }
});
test('parser diagnostics are fixed codes with bounded metadata only',async()=>{
  for(const [mode,reason] of [['malformed','malformed_json'],['oversize','line_limit']]) {
    const result=await run(mode);
    assert.notEqual(result.exitCode,0);
    assert.equal(result.resultJson.protocolDiagnostic.reason,reason);
    assert.ok(result.resultJson.protocolDiagnostic.maxLineBytes>0);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);
  }
});
