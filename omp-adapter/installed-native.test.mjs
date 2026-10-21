import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createServerAdapter} from './index.mjs';
const base=fileURLToPath(new URL('.',import.meta.url));
const extension=fileURLToPath(new URL('./offline-provider.ts',import.meta.url));
test('installed OMP native JSON through real SDK: provider failure, tool recovery, success (offline)',async()=>{
  const original={...process.env};
  const command=process.env.OMP_COMMAND;
  assert.ok(command,'Set OMP_COMMAND to an absolute executable path');
  const cwd=await mkdtemp(base+'.installed-native-');
  try {
    // Do not expose host credentials/settings or discover user extensions.
    for(const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env,{PATH:original.PATH,HOME:cwd,TMPDIR:cwd,PI_CODING_AGENT_DIR:cwd+'/agent',NODE_ENV:'production'});
    const observed=[];
    for(const mode of ['provider-error','tool-error','normal']) {
      process.env.OMP_OFFLINE_CASE=mode;
      const logs=[];
      const adapter=createServerAdapter({command,prefixArgs:['--no-skills','--no-rules','--no-title','--extension',extension]});
      const result=await adapter.execute({runId:crypto.randomUUID(),agent:{id:'offline',companyId:'offline',adapterConfig:{}},config:{cwd,model:'adapter-offline/fixture',permission:'all',timeoutSec:15,graceSec:1},context:{taskPrompt:'offline probe'},onLog:async(s,c)=>logs.push(c)});
      observed.push({mode,result,logs});
      if(mode==='provider-error') {
        assert.equal(result.errorCode,'omp_native_provider_error',JSON.stringify(result));
        assert.equal(result.resultJson.processExitCode,1);
        assert.equal(result.resultJson.stopReason,'error');
        assert.equal(result.resultJson.providerError,'Offline provider rejected request');
      } else {
        assert.equal(result.exitCode,0,JSON.stringify(result));
        assert.equal(result.summary,'offline native complete');
        assert.equal(result.resultJson.toolErrorCount,mode==='tool-error'?1:0);
      }
      assert.doesNotMatch(JSON.stringify([result,logs]),/PRIVATE_THOUGHT|RAW_TOOL_FAILURE/);
    }
  } finally {
    for(const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env,original);
    await rm(cwd,{recursive:true,force:true});
  }
});
