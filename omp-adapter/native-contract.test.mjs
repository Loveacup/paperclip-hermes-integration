import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createServerAdapter} from './index.mjs';
const cwd=fileURLToPath(new URL('.',import.meta.url));
const replay=fileURLToPath(new URL('./replay-native.mjs',import.meta.url));
function context() {return {runId:crypto.randomUUID(),agent:{id:'offline',companyId:'offline',adapterConfig:{}},config:{cwd},context:{taskPrompt:'offline replay'},onLog:async()=>{}};}
test('native synthetic provider failure preserves structured reason and error even if process exits zero',async()=>{
  for(const exit of ['1','0']) {
    const adapter=createServerAdapter({command:process.execPath,prefixArgs:[replay,'provider-error',exit]});
    const result=await adapter.execute(context());
    assert.equal(result.errorCode,'omp_native_provider_error');
    assert.equal(result.resultJson.stopReason,'error');
    assert.equal(result.resultJson.providerError,'Offline provider rejected request');
    assert.equal(result.resultJson.processExitCode,Number(exit));
    assert.notEqual(result.exitCode,0);
  }
});
test('terminal model identity comes from synthetic assistant, never from the request',async()=>{
  for(const requested of ['requested/not-the-actual-model','wrong/fixture','adapter-offline/wrong',undefined,'adapter-offline/fixture','fixture','fuzzy-fixture']) {
    const ctx=context();
    if(requested!==undefined) ctx.config.model=requested;
    const result=await createServerAdapter({command:process.execPath,prefixArgs:[replay,'normal']}).execute(ctx);
    const mismatch=requested?.includes('/') && requested!=='adapter-offline/fixture';
    assert.equal(result.exitCode,mismatch?1:0,JSON.stringify(result));
    if(mismatch) assert.equal(result.errorCode,'omp_native_model_mismatch');
    assert.equal(result.model,'adapter-offline/fixture');
    assert.equal(result.requestedModel,requested??null);
    assert.equal(result.resolvedProvider,'adapter-offline');
    assert.equal(result.resolvedModel,'fixture');
    assert.equal(result.resultJson.requestedModel,requested??null);
    assert.equal(result.resultJson.resolvedProvider,'adapter-offline');
    assert.equal(result.resultJson.resolvedModel,'fixture');
  }
});
test('synthetic recovered tool failure is observable but does not override clean assistant stop',async()=>{
  const result=await createServerAdapter({command:process.execPath,prefixArgs:[replay,'tool-error']}).execute(context());
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.equal(result.resultJson.toolErrorCount,1);
  assert.equal(result.resultJson.runOutcome,'succeeded');
  assert.equal(result.resultJson.issueCompletion,'not_asserted_by_adapter');
  assert.equal(result.summary,'offline native complete');
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_THOUGHT|RAW_TOOL_FAILURE/);
});
