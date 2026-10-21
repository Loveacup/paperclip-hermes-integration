import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {loadConfig} from '../scripts/config.mjs';
import {loadBuildPrompt} from './prompt-contract.mjs';
let installation=process.env.PAPERCLIP_INTEGRATION_CONFIG ? loadConfig() : null;
export let CEO=installation?.ceoAgentId, COMPANY=installation?.companyId;
const terminal = new Set(['succeeded','failed','timed_out','cancelled']);
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function apiBase(value) {
  const url=new URL(value);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('invalid_api_base');
  url.pathname=url.pathname.replace(/\/+$/,'').replace(/\/api$/,'')+'/api';
  return url.href;
}
function stateIdentity() {
  if (!installation) throw Error('integration_config_required');
  return {apiBase:apiBase(installation.apiUrl),companyId:installation.companyId,ceoAgentId:installation.ceoAgentId};
}
function assertIdentity(s) {
  if (!s.identity) throw Error('state_identity_missing: preserve state; choose a new statePath after owner review');
  const expected=stateIdentity();
  if (Object.keys(expected).some(k=>s.identity[k]!==expected[k])) throw Error('state_identity_mismatch: preserve state; restore target or choose a new statePath');
}
export function initialState() {
  return {version:1, identity:stateIdentity(), initialized:false, fingerprints:{}, pending:{}, tracked:{}, inflight:null};
}
export function observe(s, rows) {
  assertIdentity(s);
  for (const r of rows) {
    if ((r.kind === 'run' && r.agentId === CEO) || (r.kind === 'agent' && r.id === CEO)) continue;
    const key = `${r.kind}:${r.id}`, fp = hash(r), previous = s.fingerprints[key];
    if (s.initialized && previous !== fp) {
      // Persist separately: never hash the generated revision or mutate source rows.
      s.revisions ??= {};
      s.revisions[key] = (s.revisions[key] ?? 0) + 1;
      const actionable = r.kind === 'run' ? terminal.has(r.status)
        : r.kind === 'agent' ? ['error','failed'].includes(r.status)
        : r.kind === 'issue' ? ['blocked','in_review','done'].includes(r.status) || previous !== undefined
        : ['pending','pending_approval','revision_requested'].includes(r.status);
      if (actionable) s.pending[key] = {...r, revision:s.revisions[key]};
    }
    s.fingerprints[key] = fp;
    if (r.kind === 'run') {
      if (terminal.has(r.status)) delete s.tracked[r.id];
      else s.tracked[r.id] = r.agentId;
    }
  }
  s.initialized = true;
}

export function relevantEvent(e) {
  const p = e?.payload ?? {};
  if (!['activity.logged','heartbeat.run.status','agent.status'].includes(e?.type)) return false;
  if (e.type !== 'activity.logged') return p.agentId !== CEO && p.id !== CEO;
  // Issue changes authored by CEO are real domain changes; its run/agent telemetry is not.
  return ['issue','approval','issue_interaction','interaction','decision'].includes(p.entityType);
}
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const safeStatus = value => typeof value === 'string' && /^[a-z_]{1,50}$/.test(value) ? value : 'unknown';
export function metadata(kind, r, issueId) {
  if (!safeId(r?.id)) throw Error('invalid_resource_id');
  const out = {kind,id:r.id,status:safeStatus(r.status)};
  if (kind === 'run') out.agentId = safeId(r.agentId);
  if (issueId) out.issueId = issueId;
  if (kind === 'issue') out.blockedBy = (r.blockedBy ?? []).map(b=>({id:safeId(b.id),status:safeStatus(b.status)})).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return out;
}
const array = value => { if (!Array.isArray(value)) throw Error('invalid_list_shape'); return value; };
export async function snapshot(get, s, pageSize=100) {
  assertIdentity(s);
  const root = `/companies/${COMPANY}`, rows=[], seen=new Set();
  let issueCount=0;
  for (let offset=0; ; offset+=pageSize) {
    const page = array(await get(`${root}/issues?view=compact&includeBlockedBy=true&sortField=id&sortDir=asc&limit=${pageSize}&offset=${offset}`));
    for (const r of page) {
      if (seen.has(r.id)) throw Error('pagination_duplicate_or_drift');
      seen.add(r.id); rows.push(metadata('issue',r)); issueCount++;
      // No comment/document/log reads; project away interaction payload immediately.
      for (const item of array(await get(`/issues/${r.id}/interactions`))) rows.push(metadata('interaction',item,r.id));
    }
    if (page.length < pageSize) break;
    if (offset >= 1000000) throw Error('pagination_safety_limit');
  }
  for (const r of array(await get(`${root}/approvals`))) rows.push(metadata('approval',r));
  const rawAgents=array(await get(`${root}/agents`));
  const promptReady=await promptContract(rawAgents.find(r=>r.id===CEO)?.adapterConfig ?? {});
  const agents=rawAgents.map(r=>metadata('agent',r)); rows.push(...agents);
  const recent=array(await get(`${root}/heartbeat-runs?summary=true&limit=1000`)).map(r=>metadata('run',r));
  const runs=new Map(recent.map(r=>[r.id,r]));
  // The recent endpoint has no cursor. Never mistake its window for full run history.
  const ids = new Set(Object.keys(s.tracked));
  if (s.inflight?.runId) ids.add(s.inflight.runId);
  for (const id of ids) runs.set(id,metadata('run',await get(`/heartbeat-runs/${id}`)));
  rows.push(...runs.values());
  const ceo=agents.find(a=>a.id===CEO);
  const busy=!ceo || ceo.status !== 'idle' || [...runs.values()].some(r=>r.agentId===CEO && !terminal.has(r.status));
  return {rows,busy,promptReady,coverage:{issues:'paged_visible_scope',issueCount,runs:'recent_1000_plus_tracked_not_full_history'},deliveryRun:runs.get(s.inflight?.runId)};
}

export function settle(s, r) {
  assertIdentity(s);
  if (!r || r.id !== s.inflight?.runId || !terminal.has(r.status)) return;
  s.lastDelivery={key:s.inflight.key,runId:r.id,runStatus:r.status,batch:s.inflight.batch ?? [],consumed:'unverified'};
  s.inflight=null; // Execution terminal is not an acknowledgement that model acted on every pointer.
}
export async function promptContract(config) {
  if(!installation) throw Error('integration_config_required');
  const buildPrompt=await loadBuildPrompt(installation.bridge.hermesAdapterRoot);
  const marker='regent_metadata_pointer_probe';
  const ctx={context:{wakeReason:marker},agent:{id:CEO,companyId:COMPANY},config,runId:'offline-probe'};
  return [false,true].every(resumedSession=>buildPrompt(ctx,config,{resumedSession}).includes(marker));
}
export function buildBody(batch, key) {
  const pointers=batch.map(r=>`${r.kind}:${r.id}=${r.status}${r.issueId ? ` issue:${r.issueId}` : ''}`).join('; ');
  const message=`Regent事件桥：${pointers}。请核对Paperclip原生状态，按CEO职责处理失败、阻塞、评审和待决定事项；遵守审批与权限，不创建重复任务。`;
  // Installed heartbeat enrichment does NOT copy arbitrary payload fields to context.
  // wakeReason is the proven prompt path; keep the actionable pointers here as well.
  return {reason:message,payload:{message,taskBody:message},idempotencyKey:key};
}
export async function deliver(s, busy, post, save) {
  assertIdentity(s);
  if (busy || s.inflight || !Object.keys(s.pending).length) return;
  const keys=Object.keys(s.pending).sort().slice(0,8), batch=keys.map(k=>s.pending[k]);
  s.sequence=(s.sequence ?? 0)+1;
  const key=`regent-v2:${s.sequence}:${hash(batch)}`;
  s.inflight={key,batch,status:'uncertain',createdAt:new Date().toISOString()};
  for (const k of keys) delete s.pending[k];
  save(); // Write-ahead uncertainty BEFORE the request, including crash-before-send.
  try {
    const response=await post(buildBody(batch,key));
    if (safeId(response?.id)) Object.assign(s.inflight,{status:'accepted',runId:response.id});
    else s.inflight.status=response?.status==='skipped' ? 'skipped_needs_review' : 'uncertain';
  } catch { s.inflight.status='uncertain'; }
  save(); // No automatic retry, even for HTTP errors (server may have committed).
}
export function acquireLock(file) {
  let fd;
  try { fd=fs.openSync(file,'wx',0o600); } catch { throw Error('locked: inspect owner before manually removing stale lock'); }
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})); fs.closeSync(fd);
  let released=false;
  return ()=>{if (!released) {fs.unlinkSync(file); released=true;}};
}

function transport() {
  const token=process.env[installation.authEnv];
  if(!token) throw Error('missing_auth_environment');
  const base=apiBase(installation.apiUrl);
  const headers={Authorization:`Bearer ${token}`};
  return {base,headers,request:async (p,method='GET',body)=>{
    const r=await fetch(base+p,{method,headers:{...headers,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(20000),...(body ? {body:JSON.stringify(body)} : {})});
    if (!r.ok) throw Error(`http_${r.status}`); // Never include response body/URL/credential in error.
    return r.json();
  }};
}
function readState(file) {
  try { fs.lstatSync(file); } catch (error) {
    if (error.code==='ENOENT') return initialState();
    throw error;
  }
  const s=JSON.parse(fs.readFileSync(file,'utf8'));
  if (s.version!==1 || !s.fingerprints || !s.pending || !s.tracked) throw Error('invalid_state');
  assertIdentity(s);
  return s;
}
function persist(file,s) {
  const tmp=file+'.tmp'; const fd=fs.openSync(tmp,'w',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(s,null,2)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp,file);
}
export async function readResource(kind, id, get) {
  if (!['issue','run','comments'].includes(kind) || typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('invalid_read_target');
  const me=await get('/agents/me');
  if (me?.id!==CEO || me.companyId!==COMPANY) throw Error('read_identity_mismatch');
  const row=await get(kind==='run' ? `/heartbeat-runs/${id}` : `/issues/${id}`);
  if (row?.id!==id || row.companyId!==COMPANY) throw Error('read_resource_mismatch');
  if (kind==='comments') {
    const comments=array(await get(`/issues/${id}/comments`));
    const fields=['id','body','authorAgentId','authorUserId','createdAt','updatedAt'];
    return {identity:{agentId:me.id,companyId:me.companyId},kind,resource:{issueId:id,comments:comments.map(c=>Object.fromEntries(fields.filter(k=>k in c).map(k=>[k,c[k]])))}};
  }
  const fields=kind==='run' ? ['id','companyId','agentId','status','errorCode','startedAt','finishedAt'] : ['id','companyId','identifier','title','status','assigneeAgentId','executionRunId','checkoutRunId','executionBlocker','blockedBy','updatedAt','completedAt'];
  return {identity:{agentId:me.id,companyId:me.companyId},kind,resource:Object.fromEntries(fields.filter(k=>k in row).map(k=>[k,row[k]]))};
}

export async function main(args=process.argv.slice(2), deps={}) {
  const print=deps.print ?? (x=>console.log(JSON.stringify(x,null,2)));
  const modes=args.filter(x=>['--once','--run','--status','--check','--read'].includes(x));
  if (modes.length!==1) throw Error('choose_one_mode_once_run_status_check_read');
  const opts={};
  for (let i=0;i<args.length;i++) {
    if (args[i]==='--read') {opts.kind=args[++i];opts.id=args[++i];continue;}
    if (modes.includes(args[i])) continue;
    if (!['--state','--config'].includes(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw Error('invalid_arguments');
    opts[args[i]]=args[++i];
  }
  if(opts['--config']) installation=loadConfig(opts['--config']);
  if(!installation) throw Error('integration_config_required');
  CEO=installation.ceoAgentId; COMPANY=installation.companyId;
  if (modes[0]==='--read' && opts['--state']) throw Error('read_does_not_accept_state');
  const file=path.resolve(opts['--state'] ?? installation.bridge.statePath);
  const s=modes[0]==='--read' ? null : readState(file);
  if (modes[0]==='--status') { print({state:s,lock:fs.existsSync(file+'.lock') ? JSON.parse(fs.readFileSync(file+'.lock','utf8')) : null}); return; }
  if (modes[0]==='--check') {
    // Local-only, no HTTP/WS, no model. Check authentication presence without printing values.
    if (!deps.request) transport();
    await promptContract({promptTemplate:'{{wakeReason}}'});
    print({ok:true,company:COMPANY,agent:CEO,wsDependency:true,network:false,model:false,
      promptPath:'reason -> context.wakeReason (payload arbitrary fields not copied)',
      privacyBoundary:'server responses contain extra fields; only metadata is retained',
      historyCoverage:'recent 1000 plus individually tracked runs'}); return;
  }
  const io=deps.request ? {request:deps.request,base:'http://offline.invalid/api',headers:{}} : transport();
  const get=p=>io.request(p,'GET');
  if (modes[0]==='--read') {print(await readResource(opts.kind,opts.id,get));return;}
  if (modes[0]==='--once') {
    const snap=await snapshot(get,s); print({mode:'once',...snap}); return;
  }
  await promptContract({promptTemplate:'{{wakeReason}}'});
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const release=acquireLock(file+'.lock'), save=()=>persist(file,s);
  let socket, stopped=false, dirty=true, ticking=false, retryAt=0, interval, connecting=false;
  const stop=()=>{stopped=true;clearInterval(interval);socket?.terminate();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);if (!ticking) release();};
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  async function tick() {
    if (stopped || ticking) return;
    ticking=true;
    try {
      if (dirty || Date.now()-(s.lastReconciledMs ?? 0)>30000) {
        dirty=false;
        const snap=await snapshot(get,s);
        const previousDelivery=s.lastDelivery?.key;
        observe(s,snap.rows); settle(s,snap.deliveryRun);
        if (s.lastDelivery?.key && s.lastDelivery.key!==previousDelivery) console.log(JSON.stringify({event:'regent_delivery_terminal',...s.lastDelivery}));
        s.coverage=snap.coverage; s.ceoBusy=snap.busy; s.promptReady=snap.promptReady;
        s.deliveryBlocked=snap.promptReady ? null : 'prompt_missing_wakeReason';
        s.lastReconciledMs=Date.now(); s.lastError=null; save();
        if (!stopped && snap.promptReady) await deliver(s,snap.busy,body=>io.request(`/agents/${CEO}/heartbeat/invoke`,'POST',body),save);
      }
    } catch { s.lastError='reconcile_or_persistence_failed'; dirty=true; try {save();} catch {} }
    finally { ticking=false; if (stopped) release(); }
  }
  function connect() {
    if (stopped || connecting || socket || Date.now()<retryAt) return;
    connecting=true;
    const wsUrl=io.base.replace(/^http/,'ws')+`/companies/${COMPANY}/events/ws`;
    socket=new (deps.WebSocket ?? WebSocket)(wsUrl,{headers:io.headers,handshakeTimeout:10000,maxPayload:1024*1024,followRedirects:false});
    socket.on('open',()=>{connecting=false;s.ws='connected';dirty=true;void tick();});
    socket.on('message',data=>{
      try {
        const e=JSON.parse(data.toString());
        if (!relevantEvent(e)) return;
        const p=e.payload ?? {};
        if (e.type==='heartbeat.run.status' && safeId(p.runId) && safeId(p.agentId) && p.agentId!==CEO) s.tracked[p.runId]=p.agentId;
        dirty=true; // Metadata hints only; GET is authoritative, batches coalesce on next tick.
      } catch { /* Ignore malformed/noise events; periodic GET heals gaps. */ }
    });
    socket.on('error',()=>{s.ws='error';socket?.terminate();});
    socket.on('close',()=>{socket=null;connecting=false;s.ws='disconnected';retryAt=Date.now()+5000;dirty=true;});
  }
  try {
    // Establish the baseline before connecting: old failures/blocked issues never wake CEO.
    await tick();
    if (!stopped) {connect();interval=setInterval(()=>{connect();void tick();},2000);}
  } catch {stop();throw Error('run_start_failed');}
  return {stop,tick,state:s,idle:async()=>{while(ticking) await new Promise(r=>setTimeout(r,1));}};
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error=>{const reason=String(error?.message??'');console.error(JSON.stringify({ok:false,error:/^(state_identity_|incompatible_hermes_|integration_config_|missing_auth_environment|invalid_integration_config|invalid_binding)/.test(reason)?reason:'bridge_failed_check_arguments_auth_state_or_lock'}));process.exitCode=1;});
}


