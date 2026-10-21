import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServerAdapter } from './index.mjs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const host=p=>import(pathToFileURL(path.join(process.env.PAPERCLIP_SERVER_ROOT,'dist',p)));
const {prepareHeartbeatGitHubLaunchers}=await host('services/heartbeat-github-launchers.js');
import { cleanupGitHubOperationLaunchers } from '@paperclipai/adapter-utils/execution-target';
const {buildHeartbeatRunScratchEnv,HEARTBEAT_RUN_SCRATCH_MARKER}=await host('services/run-scratch.js');
// Match the other public-output tests: inherited sensitive flags can equal "true".
// Keep values in memory only; never log or persist host credentials.
const inheritedSecrets=Object.entries(process.env).filter(([key])=>/(key|token|secret|password|authorization|cookie)/i.test(key));
for(const [key] of inheritedSecrets) delete process.env[key];
test.after(()=>{for(const [key,value] of inheritedSecrets) process.env[key]=value;});
const base=fileURLToPath(new URL('.',import.meta.url));
const fake=fileURLToPath(new URL('./fake-native.mjs',import.meta.url));
const adapter=createServerAdapter({command:process.execPath,prefixArgs:[fake,'fixture:normal']});
function context(dir,existing={}) {
  const scratch=buildHeartbeatRunScratchEnv(existing,{dir});
  return {runId:'offline-enrichment-run',agent:{id:'offline-agent',companyId:'offline-company',adapterConfig:{}},config:{cwd:base,env:{...existing,...scratch.env}},context:{taskPrompt:'offline enrichment probe',paperclipScratch:{type:'heartbeat_run',dir,cleanupPolicy:'terminal_run',marker:HEARTBEAT_RUN_SCRATCH_MARKER,tempKeysApplied:scratch.tempKeysApplied}},onLog:async()=>{}};
}
test('real heartbeat scratch builder enrichment passes through actual SDK subprocess',async()=>{
  const dir=await mkdtemp(base+'.enrichment-');
  try {
    const ctx=context(dir);
    let spawned=false;ctx.onSpawn=async()=>{spawned=true;};
    const result=await adapter.execute(ctx);
    assert.equal(result.exitCode,0,JSON.stringify(result));
    assert.equal(spawned,true);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('env rejection diagnostics distinguish scratch binding, forbidden identity, and unknown keys without values',async()=>{
  const dir=await mkdtemp(base+'.enrichment-');
  try {
    for(const [mutate,reason] of [
      [ctx=>{ctx.config.env.PAPERCLIP_SCRATCH_DIR=dir+'/other';},'scratch_binding_mismatch'],
      [ctx=>{delete ctx.context.paperclipScratch;},'scratch_binding_mismatch'],
      [ctx=>{ctx.context.paperclipScratch.tempKeysApplied=[];},'scratch_binding_mismatch'],
      [ctx=>{ctx.context.paperclipScratch.tempKeysApplied='TMPDIR TEMP TMP';},'scratch_binding_mismatch'],
      [ctx=>{ctx.context.githubAuthenticationMode='managed';ctx.config.env.GH_TOKEN='synthetic-forged-identity';},'github_enrichment_mismatch'],
      [ctx=>{ctx.config.env.PAPERCLIP_API_KEY='synthetic-forged-identity';},'forbidden_control_plane_env'],
      [ctx=>{ctx.config.env.PAPERCLIP_AGENT_TOKEN='synthetic-forged-identity';},'reserved_runtime_env'],
      [ctx=>{ctx.config.env.NODE_OPTIONS='synthetic-forged-identity';},'unsupported_config_env'],
    ]) {
      const ctx=context(dir);mutate(ctx);let spawned=false;ctx.onSpawn=async()=>{spawned=true;};
      const result=await adapter.execute(ctx);
      assert.equal(spawned,false);
      assert.equal(result.errorCode,'omp_native_input_invalid');
      assert.equal(result.resultJson?.inputDiagnostic?.reason,reason);
      assert.doesNotMatch(JSON.stringify(result),/synthetic-forged-identity|\.enrichment-/);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('host GitHub metadata is mode-scoped and does not open arbitrary config env',async()=>{
  const ctx=context(base);ctx.context.githubAuthenticationMode='host';
  Object.assign(ctx.config.env,{PAPERCLIP_GITHUB_AUTH_MODE:'host',PAPERCLIP_GITHUB_HOST_HOME:base,GH_CONFIG_DIR:base+'/gh',GIT_AUTHOR_NAME:'Offline Author',GIT_AUTHOR_EMAIL:'offline@example.invalid',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'safe.fixture',GIT_CONFIG_VALUE_0:'fixture',GIT_SSH_COMMAND:'ssh -F /dev/null',SSH_AUTH_SOCK:'',PAPERCLIP_GIT_METADATA_ROOTS:JSON.stringify([base+'/metadata']),PAPERCLIP_RUNNER_NETWORK_ROOTS:'[]',PAPERCLIP_RUNNER_NETWORK_ACCESS:'disabled'});
  assert.equal((await adapter.execute(ctx)).exitCode,0);
  ctx.config.env.UNRECOGNIZED_PLATFORM_METADATA='not-allowed';
  assert.equal((await adapter.execute(ctx)).errorCode,'omp_native_input_invalid');
});
test('each scratch alias and applied temp key must exactly match current context dir',async()=>{
  for(const key of ['PAPERCLIP_RUN_SCRATCH_DIR','PAPERCLIP_TASK_SCRATCH_DIR','PAPERCLIP_SCRATCH_DIR','PAPERCLIP_TMPDIR','TMPDIR','TEMP','TMP']) {
    const ctx=context(base);ctx.config.env[key]=base+'other';
    assert.equal((await adapter.execute(ctx)).resultJson.inputDiagnostic.reason,'scratch_binding_mismatch');
  }
  const ctx=context(base,{TMPDIR:base});
  // The official helper preserves pre-existing TMPDIR; it is not platform-added.
  assert.equal(ctx.context.paperclipScratch.tempKeysApplied.includes('TMPDIR'),false);
  assert.equal((await adapter.execute(ctx)).errorCode,'omp_native_input_invalid');
  delete ctx.config.env.TMPDIR;
  assert.equal((await adapter.execute(ctx)).exitCode,0);
});
test('installed heartbeat GitHub launcher and SDK enrichment accepted without invoking Git',async()=>{
  const dir=await mkdtemp(base+'.enrichment-');
  const previous=process.env.TMPDIR;process.env.TMPDIR=dir;
  const ctx=context(dir);ctx.context.githubAuthenticationMode='managed';
  try {
    // These four fields are the read-only probe output contract at execution-target.js:1074;
    // do not call prepareGitHubExecutionEnvironment here: it invokes Git.
    const enriched={...ctx.config.env,PAPERCLIP_GIT_METADATA_ROOTS:'[]',PAPERCLIP_RUNNER_NETWORK_ROOTS:'[]',PAPERCLIP_GITHUB_AUTH_MODE:'managed',PAPERCLIP_RUNNER_NETWORK_ACCESS:'enabled'};
    const launchers=await prepareHeartbeatGitHubLaunchers({native:false,githubConfigured:false,agentId:ctx.agent.id,runId:ctx.runId,target:null,cwd:base,env:enriched,brokerUrl:'http://offline.invalid',createBrokerToken:()=> 'synthetic-broker-fixture'});
    ctx.config.env=launchers.env;ctx.authToken='synthetic-run-fixture';
    const probe=createServerAdapter({command:process.execPath,prefixArgs:[fake,'fixture:enrichment']});
    const result=await probe.execute(ctx);
    assert.equal(result.exitCode,0,JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.summary),{scratch:true,identity:true,managed:true,launcher:true});
    assert.doesNotMatch(JSON.stringify(result),/synthetic-run-fixture|synthetic-broker-fixture/);
    for(const mutate of [
      ctx=>{ctx.config.env.BASH_ENV+='.other';},
      ctx=>{ctx.config.env.GIT_CONFIG_GLOBAL='/unsafe';},
      ctx=>{ctx.config.env.PAPERCLIP_GITHUB_AUTH_MODE='host';},
      ctx=>{ctx.config.env.PAPERCLIP_RUNNER_NETWORK_ROOTS='["relative"]';},
      ctx=>{ctx.config.env.PATH='/unsafe';},
      ctx=>{delete ctx.context.githubAuthenticationMode;},
    ]) {
      const bad=structuredClone({runId:ctx.runId,agent:ctx.agent,config:ctx.config,context:ctx.context});
      bad.onLog=async()=>{};mutate(bad);let spawned=false;bad.onSpawn=async()=>{spawned=true;};
      const rejected=await probe.execute(bad);
      assert.equal(spawned,false);assert.equal(rejected.errorCode,'omp_native_input_invalid');
      assert.doesNotMatch(JSON.stringify(rejected),/synthetic-broker-fixture|\.enrichment-|\/unsafe/);
    }
  } finally {
    await cleanupGitHubOperationLaunchers({runId:ctx.runId,target:null});
    if(previous===undefined) delete process.env.TMPDIR;else process.env.TMPDIR=previous;
    await rm(dir,{recursive:true,force:true});
  }
});
