import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServerAdapter } from './index.mjs';
// Public-output fixture assertions must not depend on host credential values
// (a host sensitive flag may legitimately contain common text such as "true").
const inheritedSecrets=Object.entries(process.env).filter(([key])=>/(key|token|secret|password|authorization|cookie)/i.test(key));
for(const [key] of inheritedSecrets) delete process.env[key];
test.after(()=>{for(const [key,value] of inheritedSecrets) process.env[key]=value;});
const cwd = fileURLToPath(new URL('.', import.meta.url));
const fake = fileURLToPath(new URL('./fake-native.mjs', import.meta.url));
const make = (mode = 'normal') => createServerAdapter({ command: process.execPath, prefixArgs: [fake, `fixture:${mode}`] });
function context(config = {}, extra = {}) {
  return { runId: `offline-${crypto.randomUUID()}`, agent: { id:'agent', companyId:'company', adapterConfig:{model:'agent/model'} },
    config: { cwd, ...config }, context: { taskPrompt:'offline prompt' }, runtime:{}, onLog:async()=>{}, ...extra };
}
test('observability: stable implementation and effective budget agree in metadata and result', async () => {
  for(const config of [{timeoutSec:600,graceSec:2},{}]) {
    const metas=[];let dispatches=0;
    const result=await make().execute(context(config,{onMeta:async m=>metas.push(m),onDispatch:()=>dispatches++}));
    assert.equal(result.exitCode,0);
    assert.equal(dispatches,1);
    assert.equal(metas.length,1);
    const evidence=result.resultJson.observability;
    assert.ok(evidence,'result must carry implementation/budget evidence');
    assert.equal(evidence.implementationVersion,'omp-native-json-local/observability-v1');
    assert.deepEqual(evidence,metas[0].observability);
    assert.equal(evidence.timeoutSource,'timeoutSec' in config?'ctx.config.timeoutSec':'adapter_default');
    assert.equal(evidence.graceSource,'graceSec' in config?'ctx.config.graceSec':'adapter_default');
    assert.equal(evidence.timeoutSec,config.timeoutSec??900);
    assert.equal(evidence.graceSec,config.graceSec??5);
    assert.equal(result.resultJson.issueCompletion,'not_asserted_by_adapter');
  }
});
test('observability: early failures distinguish no SDK invocation from unknown runner timing', async () => {
  const ac=new AbortController();ac.abort();
  for(const [config,extra,adapter,code,timer] of [
    [{timeoutSec:0},{},make(),'omp_native_input_invalid','not_started'],
    [{},{signal:ac.signal},make(),'omp_native_cancelled','not_started'],
    [{},{onMeta:async()=>{throw Error('secret-cause');}},make(),'omp_native_metadata_failed','not_started'],
    [{},{onCancellationReady:async()=>{throw Error('secret-cause');}},make(),'omp_native_runner_failed','not_started'],
    [{},{},createServerAdapter({command:'/no-such-executable'}),'omp_native_runner_failed','unknown'],
  ]) {
    let dispatches=0;
    const result=await adapter.execute(context(config,{...extra,onDispatch:()=>dispatches++}));
    assert.equal(result.errorCode,code);
    assert.equal(dispatches,0);
    assert.ok(result.resultJson?.observability,'early result must retain safe provenance');
    assert.equal(result.resultJson.observability.implementationVersion,'omp-native-json-local/observability-v1');
    assert.equal(result.resultJson.observability.timeoutSec,config.timeoutSec===0?null:900);
    assert.equal(result.resultJson.observability.timeoutSource,config.timeoutSec===0?'ctx.config.timeoutSec':'adapter_default');
    assert.equal(result.resultJson.executionEvidence.sdkTimerStatus,timer);
    assert.equal(result.resultJson.executionEvidence.dispatchStarted,false);
    assert.equal(result.resultJson.executionEvidence.timeoutFired,null);
    assert.equal(result.resultJson.executionEvidence.nativeDeadline,'not_observed_by_adapter');
    assert.deepEqual(result.resultJson.outputEvidence,{trustedNativeTerminal:false,summaryPublication:'not_attempted'});
    assert.equal(result.resultJson.issueCompletion,'not_asserted_by_adapter');
    assert.doesNotMatch(JSON.stringify(result),/secret-cause/);
  }
});
test('observability: SDK result is the source of timeout fact, not native deadline inference',async()=>{
  let meta;
  const result=await make().execute(context({timeoutSec:600},{onMeta:async m=>{meta=m;}}));
  assert.deepEqual(meta.executionEvidence,{sdkTimerStatus:'not_started',dispatchStarted:false,timeoutFired:null,nativeDeadline:'not_observed_by_adapter'});
  assert.deepEqual(meta.outputEvidence,{trustedNativeTerminal:false,summaryPublication:'not_attempted'});
  assert.deepEqual(result.resultJson.executionEvidence,{sdkTimerStatus:'result_received',dispatchStarted:true,timeoutFired:false,nativeDeadline:'not_observed_by_adapter'});
});
test('task model > agent model > no --model (OMP default), passed to actual subprocess', async () => {
  for (const [config, agentModel, expected] of [[{model:'task/model'}, 'agent/model','task/model'],[{},'agent/model','agent/model'],[{},undefined,null]]) {
    const ctx = context(config); ctx.agent.adapterConfig = agentModel ? {model:agentModel} : {};
    const result = await make().execute(ctx);
    assert.equal(result.exitCode,0,JSON.stringify(result));
    const observed = JSON.parse(result.summary);
    assert.deepEqual(observed.argv, ['-p','--mode','json','--no-session','--cwd',cwd,'--no-extensions','--no-lsp','--approval-mode','yolo','--tools','read,grep,glob',...(expected ? ['--model',expected]:[])]);
    assert.match(observed.stdin,/offline prompt/);
    assert.equal(result.requestedModel, expected);
    assert.equal(result.model, expected??'default/fixture');
    assert.equal(`${result.resolvedProvider}/${result.resolvedModel}`,result.model);
    assert.equal(result.clearSession,true);
  }
});
test('missing or blank terminal provider/model cannot succeed even with no requested model',async()=>{
  for(const mode of ['missing-provider','missing-model','blank-provider','blank-model']) {
    for(const requested of [null,'agent/model']) {
      const ctx=context();ctx.agent.adapterConfig=requested?{model:requested}:{};
      const result=await make(mode).execute(ctx);
      assert.equal(result.exitCode,1,JSON.stringify(result));
      assert.equal(result.errorCode,'omp_native_model_unresolved');
      assert.equal(result.model,null);
      assert.equal(result.resultJson.runOutcome,'failed');
    }
  }
});
test('inherited short secrets are redacted in providerError, summary and public logs',async()=>{
  const prior=process.env.REVIEW_PROBE_TOKEN;
  try {
    for(const secret of ['abc1237','z']) {
      process.env.REVIEW_PROBE_TOKEN=secret;
      for(const mode of ['inherited-secret-error','inherited-secret']) {
        const logs=[];
        const result=await make(mode).execute(context({},{onLog:async(s,c)=>logs.push(c)}));
        assert.equal(result.exitCode,mode==='inherited-secret'?0:1);
        assert.equal(result.resultJson.providerError,'provider [REDACTED]');
        assert.equal(result.summary,'public [REDACTED]');
        assert.deepEqual(logs,['public [REDACTED]\n']);
        assert.equal(JSON.stringify([result.summary,result.resultJson.providerError,logs]).includes(secret),false);
      }
    }
  } finally {
    if(prior===undefined) delete process.env.REVIEW_PROBE_TOKEN;else process.env.REVIEW_PROBE_TOKEN=prior;
  }
});
test('invalid inputs refuse before spawn without echoing values', async () => {
  for (const config of [{command:'/bin/sh'},{prefixArgs:['-c']},{model:''},{model:null},{model:'--bad'},{model:'a b'},{model:'x\nsecret'},{model:42},{timeoutSec:0},{timeoutSec:null},{timeoutSec:Infinity},{timeoutSec:86401},{graceSec:0},{graceSec:null},{permission:null},{permission:'yolo'},{cwd:'relative'},{cwd:'/directory-does-not-exist'},{env:{PAPERCLIP_API_KEY:'secret'}},{env:{NODE_OPTIONS:'--bad'}},{env:{A:4}}]) {
    let spawned=false; const result=await make().execute(context(config,{onSpawn:async()=>{spawned=true;}}));
    assert.equal(spawned,false,JSON.stringify(config));
    assert.equal(result.errorCode,'omp_native_input_invalid',JSON.stringify(config));
    assert.equal(result.exitCode,1);
    assert.doesNotMatch(JSON.stringify(result),/secret|--bad/);
  }
});
test('an explicitly invalid agent default model is rejected, not treated as absent',async()=>{
  for(const model of [null,'',42,'bad model']) {
    const ctx=context();ctx.agent.adapterConfig={model};
    const result=await make().execute(ctx);
    assert.equal(result.errorCode,'omp_native_input_invalid');
  }
});
const readProcessState=(pid)=>execFileSync('ps',['-o','stat=','-p',String(pid)],{
  encoding:'utf8',timeout:1000,stdio:['ignore','pipe','pipe']
}).trim();
function assertTerminated(pid, {signal=process.kill, readState=readProcessState}={}) {
  assert.ok(Number.isSafeInteger(pid)&&pid>0,'fixture PID must be a positive integer');
  try {signal(pid,0);} catch(error) {
    if(error.code==='ESRCH') return;
    throw error;
  }
  let state;
  try {state=readState(pid);} catch(error) {
    // A successfully probed PID may be reaped before ps reads it. Only ESRCH,
    // not a failed query or a permissions error, establishes absence.
    try {signal(pid,0);} catch(probeError) {
      if(probeError.code==='ESRCH') return;
      throw probeError;
    }
    throw error;
  }
  // kill(pid, 0) also succeeds for a zombie: execution has ended, but its
  // parent (possibly PID 1) has not reaped the process record yet.
  assert.match(state,/^Z[+<NslL]*$/,`Fixture PID ${pid} has not terminated (state ${JSON.stringify(state)})`);
}
test('termination oracle recognizes an exited zombie rather than a running process',()=>{
  assertTerminated(424242,{signal:()=>{},readState:()=> 'Z'});
});
test('termination oracle still rejects running, sleeping, stopped, and unknown states',()=>{
  for(const state of ['R','S','D','T','I','?','', 'Z malformed']) {
    assert.throws(()=>assertTerminated(424242,{signal:()=>{},readState:()=>state}),{code:'ERR_ASSERTION'});
  }
  // Real negative control: the test runner itself must never look terminated.
  assert.throws(()=>assertTerminated(process.pid),{code:'ERR_ASSERTION'});
});
test('termination oracle accepts ESRCH without querying process state',()=>{
  assertTerminated(424242,{
    signal:()=>{throw Object.assign(new Error('gone'),{code:'ESRCH'});},
    readState:()=>{assert.fail('must not query a reaped PID');}
  });
});
test('termination oracle does not confuse permission or process-query errors with exit',()=>{
  for(const code of ['EPERM','EACCES']) {
    assert.throws(()=>assertTerminated(424242,{
      signal:()=>{throw Object.assign(new Error(code),{code});},
      readState:()=>{assert.fail('must not query an unprobeable PID');}
    } ),{code});
  }
  assert.throws(()=>assertTerminated(424242,{
    signal:()=>{},readState:()=>{throw Object.assign(new Error('ps failed'),{code:'EIO'});}
  }),{code:'EIO'});
});
test('termination oracle handles a PID reaped between the signal probe and ps',()=>{
  let probes=0;
  assertTerminated(424242,{
    signal:()=>{if(++probes===2) throw Object.assign(new Error('gone'),{code:'ESRCH'});},
    readState:()=>{throw Object.assign(new Error('no matching PID'),{status:1});}
  });
  assert.equal(probes,2);
});
test('termination oracle accepts a real retained zombie, not just a synthetic state',async()=>{
  const holder=spawn('python3',['-u','-c',`
import os, subprocess, sys, time
pid = os.fork()
if pid == 0:
    os._exit(0)
try:
    for _ in range(100):
        state = subprocess.check_output(['ps', '-o', 'stat=', '-p', str(pid)], text=True).strip()
        if state.startswith('Z'):
            print(pid, flush=True)
            sys.stdin.read(1)
            break
        time.sleep(0.01)
    else:
        raise RuntimeError('owned child did not become a zombie')
finally:
    os.waitpid(pid, 0)
  `],{stdio:['pipe','pipe','pipe']});
  const closed=once(holder,'close');
  // Attach a handler immediately so a failed spawn cannot be an unhandled rejection.
  closed.catch(()=>{});
  try {
    const [line]=await once(holder.stdout,'data',{signal:AbortSignal.timeout(5000)});
    const pid=Number(line.toString().trim());
    assert.match(readProcessState(pid),/^Z[+<NslL]*$/);
    // Prove the old assertion fails on this actual kernel state.
    assert.equal(process.kill(pid,0),true);
    assertTerminated(pid);
  } finally {
    if(!holder.stdin.destroyed) holder.stdin.end('\n');
    const [code]=await closed;
    assert.equal(code,0,'zombie holder must reap its owned child and exit cleanly');
  }
});
test('bounded timeout kills owned process group including SIGTERM-resistant descendant',async()=>{
  const result=await make('hang').execute(context({timeoutSec:1,graceSec:1}));
  assert.equal(result.timedOut,true);
  assert.equal(result.errorCode,'omp_native_timeout');
  const pids=JSON.parse(result.summary);
  for(const pid of [pids.pid,pids.descendant]) assertTerminated(pid);
  assert.deepEqual(result.resultJson.outputEvidence,{trustedNativeTerminal:true,summaryPublication:'published'});
  assert.equal(result.resultJson.executionEvidence.timeoutFired,true);
  assert.equal(result.resultJson.runOutcome,'failed');
});
test('timeout facts survive a failing public-output callback',async()=>{
  const result=await make('hang').execute(context({timeoutSec:1,graceSec:1},{onLog:async()=>{throw new Error('offline log failure');}}));
  assert.equal(result.timedOut,true);
  assert.equal(result.errorCode,'omp_native_timeout');
  assert.notEqual(result.signal,null);
  assert.deepEqual(result.resultJson.outputEvidence,{trustedNativeTerminal:true,summaryPublication:'failed'});
  assert.equal(result.resultJson.executionEvidence.timeoutFired,true);
});
test('observability: no terminal hang has no fabricated summary or publication',async()=>{
  let dispatches=0;const logs=[];
  const result=await make('hang-no-terminal').execute(context({timeoutSec:1,graceSec:1},{onDispatch:()=>dispatches++,onLog:async(s,c)=>logs.push(c)}));
  assert.equal(dispatches,1);
  assert.equal(result.errorCode,'omp_native_timeout');
  assert.equal(result.summary,'');
  assert.deepEqual(logs.map(x=>JSON.parse(x)),[{kind:'omp_native_progress',eventType:'agent_start',eventCount:1,typeCount:1,maxLineBytes:22}]);
  assert.equal(result.resultJson.executionEvidence.timeoutFired,true);
  assert.deepEqual(result.resultJson.outputEvidence,{trustedNativeTerminal:false,summaryPublication:'not_attempted'});
});
test('observability: terminal trust and summary publication are independent of process success',async()=>{
  for(const [mode,trusted,publication] of [['normal',true,'published'],['empty',true,'not_attempted'],['error',true,'not_attempted'],['missing-stop',false,'not_attempted'],['nonterminal',false,'not_attempted'],['continuing',false,'not_attempted'],['duplicate-stop',false,'not_attempted'],['after-stop',false,'not_attempted'],['truncated',false,'not_attempted'],['malformed',false,'not_attempted']]) {
    const result=await make(mode).execute(context());
    assert.deepEqual(result.resultJson.outputEvidence,{trustedNativeTerminal:trusted,summaryPublication:publication},mode);
  }
  const failed=await make().execute(context({},{onLog:async()=>{throw Error('private failure');}}));
  assert.equal(failed.errorCode,'omp_native_publication_failed');
  assert.deepEqual(failed.resultJson.outputEvidence,{trustedNativeTerminal:true,summaryPublication:'failed'});
  const spawnFailed=await make().execute(context({},{onSpawn:async()=>{throw Error('private failure');}}));
  assert.equal(spawnFailed.errorCode,'omp_native_publication_failed');
  assert.equal(spawnFailed.resultJson.outputEvidence.summaryPublication,'published');
  assert.doesNotMatch(JSON.stringify([failed,spawnFailed]),/private failure/);
});
test('Paperclip AbortSignal cancels running group, preserves cancellation result and clears registry',async()=>{
  const {runningProcesses}=await import('@paperclipai/adapter-utils/server-utils');
  const ac=new AbortController(); let spawned;
  const ctx=context({timeoutSec:10,graceSec:1},{signal:ac.signal,onSpawn:async(meta)=>{spawned=meta;setTimeout(()=>ac.abort(),150);}});
  const started=Date.now(); const result=await make('hang').execute(ctx);
  assert.equal(result.errorCode,'omp_native_cancelled');
  assert.equal(result.timedOut,false);
  assert.ok(Date.now()-started<4000);
  assert.equal(runningProcesses.has(ctx.runId),false);
  assert.throws(()=>process.kill(spawned.pid,0),{code:'ESRCH'});
});
test('pre-aborted and cancellation during metadata never dispatch',async()=>{
  for(const early of [true,false]) {
    const ac=new AbortController();let spawned=false;
    if(early) ac.abort();
    const result=await make().execute(context({},{signal:ac.signal,onMeta:async()=>{ac.abort();},onSpawn:async()=>{spawned=true;}}));
    assert.equal(result.errorCode,'omp_native_cancelled');assert.equal(spawned,false);
  }
});
test('run task identity and scoped runtime-tools token delivered only to child env',async()=>{
  const runtimeTools={mcpEndpoint:'http://offline.invalid/mcp',bearerToken:'offline-tools-token',expiresAt:'offline',rest:{connectionsSearch:'http://offline.invalid/search',connectionRequest:'http://offline.invalid/request'},tools:['connections_search','connection_request'],guidance:'offline tools'};
  const result=await make('identity').execute(context({},{context:{taskPrompt:'offline prompt',issueId:'offline-issue',paperclipWake:{reason:'issue_assigned'}},runtimeTools}));
  assert.equal(result.exitCode,0);
  assert.deepEqual(JSON.parse(result.summary),{taskId:'offline-issue',wakeReason:'issue_assigned',toolsTokenReceived:true});
  assert.doesNotMatch(JSON.stringify(result),/offline-tools-token/);
});
test('cancellation in synchronous onSpawn race only stops its owned run',async()=>{
  const ac=new AbortController();
  const cancelled=context({timeoutSec:5,graceSec:1},{signal:ac.signal,onSpawn:async()=>{ac.abort();}});
  const [a,b]=await Promise.all([make('hang').execute(cancelled),make().execute(context())]);
  assert.equal(a.errorCode,'omp_native_cancelled');assert.equal(b.exitCode,0);
});
test('public text only, ANSI stripped and split credentials redacted; credentials env-only',async()=>{
  const logs=[]; const meta=[];
  const result=await make('secrets').execute(context({env:{TEST_CREDENTIAL_TOKEN:'offline-fixture-secret'}},{authToken:'offline-run-auth',onLog:async(s,c)=>logs.push(c),onMeta:async(m)=>meta.push(m)}));
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.match(result.summary,/received-env:true/);
  assert.match(result.summary,/\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify([result,logs,meta]),/offline-fixture-secret|offline-run-auth|PRIVATE_THOUGHT|RAW_TOOL|RAW_STDERR|\\u001b/);
  assert.equal(meta.length,1);
  assert.equal(meta[0].env,undefined);
  assert.equal(meta[0].prompt,undefined);
});
test('malformed, missing terminal, native error, truncated and nonzero exits never report success',async()=>{
  for(const mode of ['malformed','missing-stop','error','long','bad-stop','duplicate-stop','truncated','nonzero','length','toolUse','aborted','nonterminal','continuing','after-stop','event-cap']) {
    const result=await make(mode).execute(context());
    assert.notEqual(result.exitCode,0,mode);
    assert.ok(result.errorCode,mode);
  }
});
test('metadata failure, callback failure and missing executable fail without exposing causes',async()=>{
  for(const opts of [{onMeta:async()=>{throw new Error('hidden-cause');}},{onSpawn:async()=>{throw new Error('hidden-cause');}},{onLog:async()=>{throw new Error('hidden-cause');}}]) {
    const result=await make().execute(context({},opts));
    assert.notEqual(result.exitCode,0);assert.ok(result.errorCode);assert.doesNotMatch(JSON.stringify(result),/hidden-cause/);
  }
  const missing=await createServerAdapter({command:'/no-such-executable'}).execute(context());
  assert.equal(missing.errorCode,'omp_native_runner_failed');
});
test('workspace wins except agent_home; native write permission enters argv, SDK owns timeout',async()=>{
  const ctx=context({cwd:'/invalid-agent-home',permission:'all',timeoutSec:7},{context:{taskPrompt:'offline prompt',paperclipWorkspace:{cwd,source:'project'}}});
  const result=await make().execute(ctx);
  assert.equal(result.exitCode,0);
  const argv=JSON.parse(result.summary).argv;
  assert.equal(argv[argv.indexOf('--approval-mode')+1],'yolo');assert.equal(argv.includes('--tools'),false);assert.equal(argv.includes('--timeout'),false);
});
test('clean empty output and error-like public prose remain successful; deny uses native no-tools',async()=>{
  for(const mode of ['empty','error-prose']) {
    const result=await make(mode).execute(context({permission:'deny'}));
    assert.equal(result.exitCode,0,JSON.stringify(result));
  }
  const result=await make().execute(context({permission:'deny'}));
  const argv=JSON.parse(result.summary).argv;
  assert.ok(argv.includes('--no-tools'));
  assert.equal(argv.includes('--tools'),false);
});
test('default factory explicitly launches installed OMP, not ACPX or shell',async()=>{
  const ac=new AbortController();let metadata;
  const result=await createServerAdapter().execute(context({},{signal:ac.signal,onMeta:async m=>{metadata=m;ac.abort();}}));
  assert.equal(metadata.command,'/usr/local/bin/omp');
  assert.equal(result.errorCode,'omp_native_cancelled');
});
test('structured provider error is credential-redacted, not published as thought or raw stderr',async()=>{
  const logs=[];
  const result=await make('error').execute(context({env:{TEST_CREDENTIAL_TOKEN:'offline-secret'}},{onLog:async(s,c)=>logs.push(c)}));
  assert.equal(result.errorCode,'omp_native_provider_error');
  assert.equal(result.resultJson.providerError,'offline failure [REDACTED]');
  assert.doesNotMatch(JSON.stringify([result,logs]),/offline-secret|PRIVATE_THOUGHT/);
});
test('local-only and missing prompt refuse before dispatch',async()=>{
  for (const extra of [{executionTarget:{kind:'ssh'}},{executionTransport:{remoteExecution:{host:'remote'}}},{context:{}}]) {
    const result=await make().execute(context({},extra));
    assert.equal(result.errorCode,'omp_native_input_invalid');
  }
});
