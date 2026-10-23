import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import {loadConfig} from '../scripts/config.mjs';
import os from 'node:os';
import { githubBrokerEnvironment } from '@paperclipai/adapter-utils/github-launcher';
import { runChildProcess, runningProcesses, signalRunningProcess, buildRuntimeToolsEnv, buildPaperclipEnv, selectPaperclipPromptSections, joinPromptSections, isForbiddenConfigEnvKey } from '@paperclipai/adapter-utils/server-utils';
const own = (obj,key) => Object.prototype.hasOwnProperty.call(obj,key);
function invalid() { throw new Error('Invalid local adapter input; check cwd, model, timeout, permissions, credential env and prompt.'); }
// SDK-managed reset values must track the installed SDK, not a guessed list.
const managedGitDefaults=githubBrokerEnvironment({}, {url:'',token:''});
function githubEnvAllowed(ctx,key,value) {
  const mode=ctx.context?.githubAuthenticationMode;
  if(mode!=='managed' && mode!=='host') return false;
  // heartbeat.js:16200-16234 always adds these execution-target probe fields.
  if(key==='PAPERCLIP_GITHUB_AUTH_MODE') return value===mode;
  if(key==='PAPERCLIP_RUNNER_NETWORK_ACCESS') return ['enabled','disabled'].includes(value);
  if(['PAPERCLIP_GIT_METADATA_ROOTS','PAPERCLIP_RUNNER_NETWORK_ROOTS'].includes(key)) {
    try {const roots=JSON.parse(value);return Array.isArray(roots)&&roots.every(root=>typeof root==='string'&&path.isAbsolute(root));} catch {return false;}
  }
  if(mode==='host') return /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|PAPERCLIP_GITHUB_HOST_HOME|GH_CONFIG_DIR|GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM|COUNT|KEY_\d+|VALUE_\d+)|GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH_COMMAND|GIT_SSH)$/.test(key);
  if(own(managedGitDefaults,key)) return ['PAPERCLIP_GITHUB_BROKER_URL','PAPERCLIP_GITHUB_BROKER_TOKEN'].includes(key) || value===managedGitDefaults[key];
  if(/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) return value==='';
  // Local launcher paths are run-scoped by execution-target.js:920,1126.
  if(typeof ctx.runId!=='string'||!/^[a-zA-Z0-9_-]+$/.test(ctx.runId)) return false;
  const dir=path.join(os.tmpdir(),'paperclip-github-runtime',ctx.runId);
  if(key==='PAPERCLIP_GITHUB_LAUNCHER_DIR'||key==='ZDOTDIR') return value===dir;
  if(key==='BASH_ENV') return value===path.join(dir,'.bashrc');
  if(key==='GH_CONFIG_DIR') return value===path.join(dir,'gh-config');
  if(key==='PATH') return value===dir||value.startsWith(dir+path.delimiter);
  return false;
}
class EnvInputError extends Error {
  constructor(reason,ctx) {
    super('Invalid adapter environment.');
    this.diagnostic={reason,scratchContextPresent:!!ctx.context?.paperclipScratch,githubContextPresent:['host','managed'].includes(ctx.context?.githubAuthenticationMode)};
  }
}
const scratchKeys=['PAPERCLIP_RUN_SCRATCH_DIR','PAPERCLIP_TASK_SCRATCH_DIR','PAPERCLIP_SCRATCH_DIR','PAPERCLIP_TMPDIR'];
const tempKeys=['TMPDIR','TEMP','TMP'];
async function prepare(ctx) {
  const cfg=ctx.config ?? {};
  if(own(cfg,'command') || own(cfg,'prefixArgs')) invalid(); // installation-only execution authority
  if (ctx.executionTarget && ctx.executionTarget.kind !== 'local' || ctx.executionTransport?.remoteExecution) invalid();
  const ws=ctx.context?.paperclipWorkspace;
  const cwd=ws?.cwd && !(ws.source==='agent_home' && cfg.cwd) ? ws.cwd : cfg.cwd;
  if(typeof cwd!=='string' || !path.isAbsolute(cwd) || cwd.includes('\0')) invalid();
  try { if(!(await stat(cwd)).isDirectory()) invalid(); } catch { invalid(); }
  const agentConfig=ctx.agent.adapterConfig ?? {};
  const model=own(cfg,'model') ? cfg.model : own(agentConfig,'model') ? agentConfig.model : null;
  if(own(cfg,'model') || own(agentConfig,'model')) {
    if(typeof model!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,199}$/.test(model)) invalid();
  }
  const timeoutSec=own(cfg,'timeoutSec') ? cfg.timeoutSec : 900, graceSec=own(cfg,'graceSec') ? cfg.graceSec : 5;
  if(!Number.isInteger(timeoutSec)||timeoutSec<1||timeoutSec>86400||!Number.isInteger(graceSec)||graceSec<1||graceSec>60) invalid();
  const permission=own(cfg,'permission') ? cfg.permission : 'reads';
  if(!['reads','deny','all'].includes(permission)) invalid();
  const env={};
  if(own(cfg,'env')) {
    if(!cfg.env || typeof cfg.env!=='object' || Array.isArray(cfg.env)) invalid();
    for(const [key,value] of Object.entries(cfg.env)) {
      if(typeof value!=='string'||value.includes('\0')) throw new EnvInputError('invalid_env_value',ctx);
      if(isForbiddenConfigEnvKey(key)) throw new EnvInputError('forbidden_control_plane_env',ctx);
      const scratch=ctx.context?.paperclipScratch;
      if(scratchKeys.includes(key)||tempKeys.includes(key)) {
        if(scratch?.type!=='heartbeat_run'||typeof scratch.dir!=='string'||!path.isAbsolute(scratch.dir)||scratch.dir.includes('\0')||value!==scratch.dir||tempKeys.includes(key)&&(!Array.isArray(scratch.tempKeysApplied)||!scratch.tempKeysApplied.includes(key))) throw new EnvInputError('scratch_binding_mismatch',ctx);
      } else if(!githubEnvAllowed(ctx,key,value) && (own(managedGitDefaults,key)||key.startsWith('PAPERCLIP_') || !/^[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key))) {
        throw new EnvInputError(own(managedGitDefaults,key)?'github_enrichment_mismatch':key.startsWith('PAPERCLIP_')?'reserved_runtime_env':'unsupported_config_env',ctx);
      }
      env[key]=value;
    }
  }
  const sections=selectPaperclipPromptSections(ctx.context,{includeExecutionContract:true});
  const prompt=joinPromptSections([sections.taskContextNote,sections.wakePrompt,ctx.context?.taskPrompt]);
  if(!prompt?.trim()||prompt.length>1024*1024) invalid();
  return {cwd,model,timeoutSec,graceSec,permission,env,prompt};
}
function failure(code,message) { return {exitCode:1,signal:null,timedOut:false,errorCode:code,errorMessage:message,clearSession:true,sessionParams:null,sessionId:null}; }
const MAX_LINE_BYTES=8*1024*1024;
const eventTypes=new Set(['agent_start','agent_end','turn_start','turn_end','message_start','message_update','message_end','tool_execution_start','tool_execution_update','tool_execution_end','advisor_yielded']);
function outputCollector() {
  let pending='', text='', stop=null, providerError=null, resolvedProvider=null, resolvedModel=null, failed=false, count=0, toolErrorCount=0;
  let reason=null, maxLineBytes=0, lastEventType=null;
  const eventCounts={}, progress=[];
  let progressCount=0;
  const progressTypes=new Set(['agent_start','turn_start','turn_end','tool_execution_start','tool_execution_end']);
  const fail=code=>{failed=true;reason??=code;};
  const line = (value) => {
    if(!value.trim() || failed) return;
    if(++count>50000) {fail('event_limit');return;}
    try {
      const e=JSON.parse(value);
      if(!e || typeof e.type!=='string' || Array.isArray(e)) {fail('invalid_event');return;}
      lastEventType=eventTypes.has(e.type)?e.type:'other';
      eventCounts[lastEventType]=(eventCounts[lastEventType]??0)+1;
      if(stop!==null && !(e.type==='advisor_yielded' && Object.keys(e).length===1)) {fail(e.type==='agent_end'?'duplicate_terminal':'activity_after_terminal');return;}
      if(progressTypes.has(e.type) && progressCount<64 && (eventCounts[lastEventType]===1 || eventCounts[lastEventType]%100===0)) {
        progressCount++;
        progress.push({kind:'omp_native_progress',eventType:lastEventType,eventCount:count,typeCount:eventCounts[lastEventType],maxLineBytes});
      }
      if(e.type==='tool_execution_end' && e.isError===true) toolErrorCount++;
      if(e.type==='agent_end') {
        if(!Array.isArray(e.messages) || (e.willContinue!==undefined && typeof e.willContinue!=='boolean') || (e.isTerminal!==undefined && typeof e.isTerminal!=='boolean')) {fail('invalid_terminal');return;}
        if(e.willContinue===true || e.isTerminal===false) return;
        const m=e.messages.findLast(m=>m?.role==='assistant');
        if(!m || !['stop','length','toolUse','error','aborted'].includes(m.stopReason) || !Array.isArray(m.content)) {fail('invalid_assistant');return;}
        stop=m.stopReason;
        const identity=value=>typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,199}$/.test(value) ? value : null;
        resolvedProvider=identity(m.provider);
        resolvedModel=identity(m.model);
        providerError=typeof m.errorMessage==='string' ? m.errorMessage : null;
        text=m.content.filter(p=>p?.type==='text'&&typeof p.text==='string').map(p=>p.text).join('\n');
        if(text.length>65536 || (providerError?.length ?? 0)>65536) {fail('terminal_text_limit');text='';providerError=null;}
      }
    } catch {fail('malformed_json');}
  };
  return {
    drainProgress() {return progress.splice(0);},
    feed(chunk) {
      if(failed) return;
      pending+=chunk;
      let index;
      while((index=pending.indexOf('\n'))>=0) {
        maxLineBytes=Math.max(maxLineBytes,Buffer.byteLength(pending.slice(0,index)));
        if(maxLineBytes>MAX_LINE_BYTES) {fail('line_limit');pending='';return;}
        line(pending.slice(0,index)); pending=pending.slice(index+1);
      }
      maxLineBytes=Math.max(maxLineBytes,Buffer.byteLength(pending));
      if(maxLineBytes>MAX_LINE_BYTES) {fail('line_limit');pending='';}
    },
    finish() {if(pending.trim()) fail('truncated_line'); if(!failed&&stop===null) fail('missing_terminal'); return {text,stop,providerError,resolvedProvider,resolvedModel,failed,toolErrorCount,protocolDiagnostic:{reason,eventCount:count,maxLineBytes,lastEventType,eventCounts}};},
  };
}
function redactor(env) {
  const sensitive=([k,v])=>/(key|token|secret|password|authorization|cookie)/i.test(k)&&typeof v==='string';
  const values=[...new Set([...Object.entries(process.env).filter(e=>sensitive(e)&&e[1].length>0),...Object.entries(env).filter(e=>sensitive(e)&&e[1].length>0)].map(([,v])=>v))].sort((a,b)=>b.length-a.length);
  return value=>{
    let clean=stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
    for(const secret of values) clean=clean.split(secret).join('[REDACTED]');
    return clean;
  };
}
export const ADAPTER_TYPE = 'omp_native_json_local';
// Reviewable code-contract identifier, not the installed native OMP version.
export const ADAPTER_IMPLEMENTATION_VERSION = 'omp-native-json-local/observability-v1';
export function createServerAdapter({ command, prefixArgs = [] } = {}) {
  command ??= loadConfig().omp.command;
  if(typeof command!=='string'||!path.isAbsolute(command)||command.includes('\0')||!Array.isArray(prefixArgs)||prefixArgs.some(a=>typeof a!=='string')) throw Error('invalid_installation_command');
  return {
    type: ADAPTER_TYPE, supportsLocalAgentJwt:true, runtimeToolDelivery:'environment',
    getConfigSchema() {return {fields:[
      {key:'cwd',label:'工作目录',type:'text',required:true},
      {key:'model',label:'默认模型（留空时不要保存此键）',type:'text',hint:'任务 adapterConfig.model 可覆盖；省略时沿用 OMP 默认。'},
      {key:'timeoutSec',label:'超时秒数',type:'number',default:900},
      {key:'graceSec',label:'TERM 后 KILL 宽限秒数',type:'number',default:5},
      {key:'permission',label:'内置工具范围（非沙箱）',type:'select',default:'reads',options:[{value:'reads',label:'read/grep/glob'},{value:'deny',label:'禁用内置工具'},{value:'all',label:'默认内置工具自动批准'}]},
    ]};},
    async testEnvironment(ctx) {
      const checks=[];
      try {
        await prepare({...ctx,agent:{adapterConfig:{}},context:{taskPrompt:'Offline configuration probe.'}});
        await access(command,constants.X_OK);
        checks.push({code:'omp_native_local_ready',level:'info',message:'Local config valid and OMP executable accessible; no model or authentication tested.'});
      } catch {checks.push({code:'omp_native_environment_invalid',level:'error',message:'Invalid local config or missing OMP executable.'});}
      return {adapterType:ADAPTER_TYPE,status:checks.some(c=>c.level==='error')?'fail':'pass',checks,testedAt:new Date().toISOString()};
    },
    async execute(ctx) {
      const observability={implementationVersion:ADAPTER_IMPLEMENTATION_VERSION,
        timeoutSource:own(ctx.config??{},'timeoutSec')?'ctx.config.timeoutSec':'adapter_default',
        graceSource:own(ctx.config??{},'graceSec')?'ctx.config.graceSec':'adapter_default',
        timeoutSec:null,graceSec:null};
      // Only the returned SDK result establishes whether its timer fired.
      // A rejected SDK call leaves timing unknown; neither false nor null
      // establishes anything about native/provider deadlines.
      const executionEvidence={sdkTimerStatus:'not_started',dispatchStarted:false,
        timeoutFired:null,nativeDeadline:'not_observed_by_adapter'};
      const outputEvidence={trustedNativeTerminal:false,summaryPublication:'not_attempted'};
      const fail=(code,message)=>({...failure(code,message),resultJson:{adapter:ADAPTER_TYPE,
        observability:{...observability},executionEvidence:{...executionEvidence},
        outputEvidence:{...outputEvidence},
        runOutcome:'failed',issueCompletion:'not_asserted_by_adapter'}});
      let cfg;
      try { cfg=await prepare(ctx); } catch (error) {
        const result=fail('omp_native_input_invalid','Invalid local adapter input; check cwd, model, timeout, permissions, credential env and prompt.');
        if(error instanceof EnvInputError) result.resultJson.inputDiagnostic=error.diagnostic;
        return result;
      }
      observability.timeoutSec=cfg.timeoutSec;observability.graceSec=cfg.graceSec;
      if(ctx.signal?.aborted) return fail('omp_native_cancelled','Run cancelled before dispatch.');
      const {model,prompt}=cfg;
      const args = ['-p','--mode','json','--no-session','--cwd',cfg.cwd,'--no-extensions','--no-lsp','--approval-mode','yolo',...(cfg.permission==='deny'?['--no-tools']:cfg.permission==='reads'?['--tools','read,grep,glob']:[]),...(model ? ['--model',model]:[])];
      const env={...cfg.env,...buildPaperclipEnv(ctx.agent),...buildRuntimeToolsEnv(ctx.runtimeTools)};
      if(ctx.authToken) env.PAPERCLIP_API_KEY=ctx.authToken;
      env.PAPERCLIP_RUN_ID=ctx.runId;
      const taskId=ctx.context?.taskId ?? ctx.context?.issueId ?? ctx.context?.paperclipWake?.issue?.id;
      const wakeReason=ctx.context?.paperclipWake?.reason;
      if(typeof taskId==='string') env.PAPERCLIP_TASK_ID=taskId;
      if(typeof wakeReason==='string') env.PAPERCLIP_WAKE_REASON=wakeReason;
      const clean=redactor(env), output=outputCollector();
      try { await ctx.onMeta?.({adapterType:ADAPTER_TYPE,command,cwd:cfg.cwd,observability:{...observability},executionEvidence:{...executionEvidence},outputEvidence:{...outputEvidence}}); }
      catch {return fail('omp_native_metadata_failed','Run metadata recording failed before dispatch.');}
      if(ctx.signal?.aborted) return fail('omp_native_cancelled','Run cancelled before dispatch.');
      let proc, cancelled=false, cancelDone=null, publicationFailed=false;
      const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      // SDK has a registry but no AbortSignal option. Only signal this run's captured group.
      const checkCancellation=()=>{
        if(!ctx.signal?.aborted) return;
        cancelled=true;
        const running=runningProcesses.get(ctx.runId);
        if(!running || cancelDone) return;
        cancelDone=(async()=>{
          signalRunningProcess(running,'SIGTERM');
          await delay(cfg.graceSec*1000);
          signalRunningProcess(running,'SIGKILL');
        })().catch(()=>{publicationFailed=true;});
      };
      ctx.signal?.addEventListener('abort',checkCancellation);
      const poll=setInterval(checkCancellation,20);
      try {
        await ctx.onCancellationReady?.();
        if(ctx.signal?.aborted) return fail('omp_native_cancelled','Run cancelled before dispatch.');
        executionEvidence.sdkTimerStatus='unknown';
        proc=await runChildProcess(ctx.runId,command,[...prefixArgs,...args],{
          cwd:cfg.cwd,env,timeoutSec:cfg.timeoutSec,graceSec:cfg.graceSec,stdin:prompt,
          onLog:async(stream,chunk)=>{
            if(stream!=='stdout') return;
            output.feed(chunk);
            for(const progress of output.drainProgress()) {
              if(publicationFailed) break;
              try {await ctx.onLog('stdout',JSON.stringify(progress)+'\n');} catch {publicationFailed=true;}
            }
          },
          onLogError:()=>{publicationFailed=true;},
          onSpawn:async(meta)=>{executionEvidence.dispatchStarted=true;ctx.onDispatch?.();await ctx.onSpawn?.(meta);},
        });
        executionEvidence.sdkTimerStatus='result_received';
        executionEvidence.timeoutFired=proc.timedOut;
        if(cancelDone) await cancelDone;
      } catch {
        const parsed=output.finish();
        outputEvidence.trustedNativeTerminal=!parsed.failed&&parsed.stop!==null;
        return fail('omp_native_runner_failed','Local OMP runner failed; do not automatically replay the task.');
      }
      finally {clearInterval(poll);ctx.signal?.removeEventListener('abort',checkCancellation);}
      const parsed=output.finish();
      // Protocol trust is separate from successful stop, model verification,
      // process exit and publication. Malformed/truncated streams are untrusted.
      outputEvidence.trustedNativeTerminal=!parsed.failed&&parsed.stop!==null;
      const actualModel=parsed.resolvedProvider && parsed.resolvedModel ? `${parsed.resolvedProvider}/${parsed.resolvedModel}` : null;
      const modelError=!actualModel ? 'omp_native_model_unresolved' : model?.includes('/') && model!==actualModel ? 'omp_native_model_mismatch' : null;
      const modelFields={requestedModel:model ? clean(model):null,resolvedProvider:parsed.resolvedProvider ? clean(parsed.resolvedProvider):null,resolvedModel:parsed.resolvedModel ? clean(parsed.resolvedModel):null};
      const summary=parsed.failed ? '' : clean(parsed.text);
      try {
        if(summary) {await ctx.onLog('stdout',summary+'\n');outputEvidence.summaryPublication='published';}
      } catch {publicationFailed=true;outputEvidence.summaryPublication='failed';}
      const ok=!cancelled&&!publicationFailed&&proc.exitCode===0&&!proc.signal&&!proc.timedOut&&!parsed.failed&&parsed.stop==='stop'&&!modelError;
      return {exitCode:ok ? 0 : (proc.exitCode || 1),signal:proc.signal,timedOut:proc.timedOut,summary,model:actualModel ? clean(actualModel):null,...modelFields,clearSession:true,sessionId:null,sessionParams:null,
        ...(ok ? {} : {errorCode:cancelled ? 'omp_native_cancelled' : proc.timedOut ? 'omp_native_timeout' : publicationFailed ? 'omp_native_publication_failed' : !parsed.failed&&parsed.stop==='error' ? 'omp_native_provider_error' : !parsed.failed&&parsed.stop==='stop'&&modelError ? modelError : 'omp_native_run_failed',errorMessage:'OMP did not return a clean terminal assistant stop with verified model identity and exit zero.'}),
        resultJson:{adapter:ADAPTER_TYPE,observability,executionEvidence,outputEvidence,...modelFields,protocolDiagnostic:parsed.protocolDiagnostic,stopReason:parsed.stop,providerError:!parsed.failed&&parsed.providerError ? clean(parsed.providerError):null,processExitCode:proc.exitCode,toolErrorCount:parsed.toolErrorCount,runOutcome:ok?'succeeded':'failed',issueCompletion:'not_asserted_by_adapter'},
      };
    },
  };
}
