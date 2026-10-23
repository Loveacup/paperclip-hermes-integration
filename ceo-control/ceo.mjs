#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const fail=code=>{throw Object.assign(new Error(code),{safe:true});};
const fields=new Set('id companyId name title description role status parentId projectId goalId goalIds leadAgentId agentId assigneeAgentId reportsTo identifier priority createdAt updatedAt archivedAt startedAt finishedAt blockedBy blocks permissions canCreateAgents canCreateSkills canAssignTasks content body key version latestRevisionId revisionId format issueId agent approval project goal routine document skill items'.split(' '));
export function project(value){if(Array.isArray(value))return value.map(project);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>fields.has(k)).map(([k,v])=>[k,project(v)]));return value;}
function validatePath(path,company,agent){
 if(typeof path!=='string'||!/^\/[A-Za-z0-9_/-]+(?:\?[A-Za-z0-9_=&,.-]+)?$/.test(path)||path.includes('//'))fail('unsafe_path');
 const [pathname,query='']=path.split('?');const s=pathname.split('/').slice(1);
 if(s.some(x=>!x)||s.some(x=>/^(keys|auth|secrets|configuration|config-revisions|runtime-state|logs|export|import|provider-traces|wakeup)$/.test(x)))fail('unsafe_path');
 const roots=['projects','issues','agents','goals','routines','heartbeat-runs','work-products'];
 if(s[0]==='companies'){
  if(s[1]!==company||!roots.concat('agent-hires','live-runs','skills').includes(s[2]))fail('unsafe_path');
  if(s.length>3&&!(s[2]==='skills'&&s.length<=5&&(!s[4]||['files','versions','comments','rename','fork'].includes(s[4]))))fail('unsupported_route');
 }else{
  if(!roots.includes(s[0])||!s[1])fail('unsafe_path');
  const tail=s.slice(2).join('/');
  const tails={projects:/^(?:workspaces)?$/,issues:/^(?:(?:children|comments|dependencies|documents|work-products|checkout|release)|documents\/[A-Za-z0-9_-]+)?$/,agents:/^(?:permissions|skills(?:\/sync)?|pause|resume|terminate|heartbeat\/invoke)?$/,goals:/^$/,routines:/^(?:triggers|run|revisions|runs)?$/,'heartbeat-runs':/^(?:cancel)?$/,'work-products':/^$/};
  if(!tails[s[0]].test(tail))fail('unsupported_route');
 }
 if(s.includes('heartbeat')&&(s[0]!=='agents'||s[1]!==agent||s.join('/')!==`agents/${agent}/heartbeat/invoke`))fail('self_only');
 const allowed=new Set('includeArchived includeBlockedBy view sortField sortDir limit offset status priority summary minCount'.split(' '));const seen=new Set();for(const [k]of new URLSearchParams(query)){if(!allowed.has(k)||seen.has(k))fail('unsafe_query');seen.add(k);}
 return s;
}
export function parseAuth(text){
 const out={};for(const line of text.split(/\r?\n/)){const m=line.match(/^\s*(?:export\s+)?(PAPERCLIP_BRIDGE_READ_IDENTITY|PAPERCLIP_BRIDGE_READ_API_URL)\s*=\s*(.*?)\s*$/);if(!m)continue;const k=m[1];let v=m[2];if(k in out)fail('duplicate_auth_key');if(v.startsWith('"')||v.startsWith("'")){if(v.length<2||v.at(-1)!==v[0])fail('invalid_auth_literal');v=v.slice(1,-1);}else if(!v||/[\s'"`]/.test(v))fail('invalid_auth_literal');out[k]=v;}return out;
}
export async function main(args,env=process.env,fetcher=fetch){
 const opts={};const pos=[];const optionNames=new Set(['company-id','agent-id','issue-id','config','env-file','page-size','max-pages']);for(let i=0;i<args.length;i++){if(args[i]==='--execute')opts.execute=true;else if(args[i].startsWith('--')){const key=args[i].slice(2);if(!optionNames.has(key)||!args[i+1]||args[i+1].startsWith('--')||key in opts)fail('invalid_option');opts[key]=args[++i];}else pos.push(args[i]);}
 const config=opts.config?JSON.parse(fs.readFileSync(opts.config,'utf8')):{};
 if(!config||Array.isArray(config)||Object.keys(config).some(k=>!['companyId','agentId','apiUrlEnv'].includes(k)))fail('invalid_nonsecret_config');
 const company=opts['company-id']??config.companyId,agent=opts['agent-id']??config.agentId;
 const command=pos[0],method=command==='wake'?'POST':pos[1],path=command==='wake'?`/agents/${agent}/heartbeat/invoke`:pos[2];
 if(!company||!agent||![company,agent].every(x=>/^[a-zA-Z0-9_-]+$/.test(x)))fail('invalid_identity_options');
 const segments=command==='inventory'?[]:validatePath(path,company,agent);
 if(!['inventory','wake'].includes(command)&&(command!=='api'||!['GET','POST','PATCH','PUT','DELETE'].includes(method)))fail('unsupported');
 const write=command!=='inventory'&&method!=='GET';if(write&&!opts.execute)fail('execute_required');
 const native=!!env.PAPERCLIP_API_KEY;
 if(native&&(env.PAPERCLIP_AGENT_ID!==agent||env.PAPERCLIP_COMPANY_ID!==company||!env.PAPERCLIP_RUN_ID||!/^[A-Za-z0-9_-]+$/.test(env.PAPERCLIP_RUN_ID)))fail('native_identity_mismatch');
 const fileEnv=!native&&opts['env-file']?parseAuth(fs.readFileSync(opts['env-file'],'utf8')):{};
 const token=native?env.PAPERCLIP_API_KEY:(env.PAPERCLIP_BRIDGE_READ_IDENTITY||fileEnv.PAPERCLIP_BRIDGE_READ_IDENTITY);
 if(!token)fail('missing_auth');
 if(config.apiUrlEnv&&!['PAPERCLIP_API_URL','PAPERCLIP_BRIDGE_READ_API_URL'].includes(config.apiUrlEnv))fail('invalid_api_url_env');
 const base=((native?env.PAPERCLIP_API_URL:null)||env[config.apiUrlEnv||'PAPERCLIP_BRIDGE_READ_API_URL']||fileEnv.PAPERCLIP_BRIDGE_READ_API_URL||'').replace(/\/+$/,'').replace(/\/api$/,'')+'/api';
 let url;try{url=new URL(base);}catch{fail('invalid_api_base');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/api')fail('invalid_api_base');
 async function request(path,verb='GET',body){
  let r;try{r=await fetcher(base+path,{method:verb,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(native&&verb!=='GET'?{'X-Paperclip-Run-Id':env.PAPERCLIP_RUN_ID}:{})},redirect:'error',signal:AbortSignal.timeout(20000),...(body!==undefined?{body:JSON.stringify(body)}:{})});}catch{fail(verb==='GET'?'request_failed':'unknown_effect_check_target_no_retry');}
  if(!r.ok){if(verb!=='GET'&&r.status>=500)fail('unknown_effect_check_target_no_retry');fail(`http_${r.status}${[403,409].includes(r.status)?'_if_run_context_required_use_wake_no_bypass':''}`);}
  if(r.status===204)return null;try{return await r.json();}catch{fail(verb==='GET'?'invalid_response':'unknown_effect_check_target_no_retry');}
 }
 async function owned(resource){const row=await request(resource);if(!row||row.companyId!==company)fail('cross_company');return row;}
 function checkResponseScope(value){if(!value||typeof value!=='object')return;if('companyId' in value&&value.companyId!==company)fail('cross_company_response');for(const child of Object.values(value))checkResponseScope(child);}
 const me=await request('/agents/me');if(me.id!==agent||me.companyId!==company||me.role!=='ceo'||me.keyScope)fail('identity_mismatch');
 if(native){const run=await owned(`/heartbeat-runs/${env.PAPERCLIP_RUN_ID}`);if(run.id!==env.PAPERCLIP_RUN_ID||run.agentId!==agent||run.status!=='running')fail('native_run_mismatch');}
 const audit={actorSource:native?'native-run':'telegram-agent-key',auditScope:native?'agent_and_verified_run':'agent_only_no_run_context'};
 if(command==='inventory'){
  const size=Number(opts['page-size']??100),max=Number(opts['max-pages']??100);
  if(!Number.isInteger(size)||size<1||size>100||!Number.isInteger(max)||max<1||max>1000)fail('invalid_pagination');
  const root=`/companies/${company}`;
  async function list(p){const rows=await request(p);if(!Array.isArray(rows)||rows.some(r=>!r.id||r.companyId!==company))fail('invalid_list_scope');return rows;}
  async function scan(){const rows=[],seen=new Set();for(let page=0;page<max;page++){
   const batch=await list(`${root}/issues?view=compact&includeBlockedBy=true&includeRoutineExecutions=true&includePluginOperations=true&sortField=id&sortDir=asc&limit=${size}&offset=${page*size}`);
   for(const row of batch){if(seen.has(row.id))return {rows,enumerated:false,reason:'duplicate_or_drift'};seen.add(row.id);rows.push(row);}
   if(batch.length<size)return {rows,enumerated:true,reason:'terminal_short_page'};
  }return {rows,enumerated:false,reason:'page_cap'};}
  const first=await scan(),second=first.enumerated?await scan():null;
  const stable=first.enumerated&&second?.enumerated&&JSON.stringify(project(first.rows))===JSON.stringify(project(second.rows));
  const rows=first.rows.map(r=>({...r,blocks:[]}));const index=new Map(rows.map(r=>[r.id,r]));let dependencies=true;
  for(const row of rows){if(!Array.isArray(row.blockedBy)){dependencies=false;continue;}for(const dep of row.blockedBy){const id=typeof dep==='string'?dep:dep.id;const parent=index.get(id);if(parent)parent.blocks.push({id:row.id});else dependencies=false;}}
  const projects=await list(`${root}/projects?includeArchived=true`),agents=await list(`${root}/agents`),liveRuns=await list(`${root}/live-runs?minCount=0&limit=50`);
  return {...audit,data:{projects:project(projects),issues:project(rows),agents:project(agents),liveRuns:project(liveRuns)},coverage:{complete:false,scope:'actor_visible_non_atomic',projects:{enumerated:true,evidence:'projects.js list includeArchived=true; no route pagination'},agents:{enumerated:true,evidence:'agents.js svc.list then actor filter; no pagination'},issues:{enumerated:!!stable,reason:stable?'two_equal_terminal_scans':first.enumerated?'drift_between_scans':first.reason,count:rows.length,dependenciesComplete:dependencies&&!!stable},liveRuns:{complete:liveRuns.length<50,reason:liveRuns.length>=50?'limit_reached_no_pagination':'below_limit_at_request_time',limit:50,evidence:'agents.js live-runs filters queued/running then LIMIT; no offset; heartbeat-runs also bounded'}}};
 }
 let workProductList;
 if(segments[0]==='work-products'){
  const issue=opts['issue-id'];if(!issue||!/^[A-Za-z0-9_-]+$/.test(issue))fail('issue_id_required');await owned(`/issues/${issue}`);
  workProductList=`/issues/${issue}/work-products`;const rows=await request(workProductList);if(!Array.isArray(rows)||!rows.some(r=>r.id===segments[1]&&r.issueId===issue&&r.companyId===company))fail('work_product_not_in_issue');
 }else if(segments[0]!=='companies')await owned('/'+segments.slice(0,2).join('/'));
 let body;
 if(write){let text='';for await(const c of process.stdin){text+=c;if(text.length>1048576)fail('body_too_large');}try{body=text.trim()?JSON.parse(text):{};}catch{fail('invalid_json');}if(!body||Array.isArray(body)||typeof body!=='object')fail('invalid_json');
  const refs={agentId:'agents',assigneeAgentId:'agents',leadAgentId:'agents',reportsTo:'agents',projectId:'projects',goalId:'goals',goalIds:'goals',issueId:'issues',parentId:segments.includes('goals')?'goals':'issues',blockedByIssueIds:'issues',blocksIssueIds:'issues',dependencyIssueId:'issues'};
  async function check(value){if(!value||typeof value!=='object')return;for(const [k,v]of Object.entries(value)){
   if(k==='companyId'){if(v!==company)fail('cross_company');continue;}
   if(k==='baseRevisionId'&&v!==null){
    if(method!=='PUT'||segments[0]!=='issues'||segments[2]!=='documents'||segments.length!==4||typeof v!=='string')fail('unverified_reference');
    const doc=await request(path.split('?')[0]);checkResponseScope(doc);
    if(doc?.latestRevisionId!==v)fail('stale_document_revision');
    continue;
   }
   if(['skillId','skillIds'].includes(k)&&v!==null){for(const id of Array.isArray(v)?v:[v]){if(typeof id!=='string'||!/^[A-Za-z0-9_-]+$/.test(id))fail('invalid_reference');const skill=await request(`/companies/${company}/skills/${id}`);checkResponseScope(skill);}continue;}
   if(refs[k]&&v!==null){for(const id of Array.isArray(v)?v:[v]){if(typeof id!=='string'||!/^[a-zA-Z0-9_-]+$/.test(id))fail('invalid_reference');await owned(`/${refs[k]}/${id}`);}}
   else if(/(?:Id|Ids)$/.test(k)&&v!==null)fail('unverified_reference');
   await check(v);
  }}await check(body);
 }
 const result=await request(path,method,body);
 checkResponseScope(result);
 if(!write)return {...audit,data:project(result)};
 if(path.endsWith('/heartbeat/invoke')){
  if(result?.status==='skipped')return {...audit,status:'skipped',verification:'no_run_created'};
  if(!result?.id||!/^[a-zA-Z0-9_-]+$/.test(result.id))fail('unknown_effect_check_target_no_retry');
  const run=await owned(`/heartbeat-runs/${result.id}`);if(run.agentId!==agent||run.id!==result.id)fail('wake_run_mismatch');
  return {...audit,status:'accepted',verification:'read_back',data:project(run)};
 }
 let target=workProductList||path.split('?')[0];
 if(method==='POST'){
  const id=result?.id??result?.agent?.id;
  if(id!==undefined){if(typeof id!=='string'||!/^[A-Za-z0-9_-]+$/.test(id))fail('unknown_effect_check_target_no_retry');
   if(segments[0]==='companies')target=segments[2]==='skills'?`/companies/${company}/skills/${id}`:`/${segments[2]==='agent-hires'?'agents':segments[2]}/${id}`;
   // Nested collection creates are verified in their parent-scoped collection.
  }
 }
 if(segments[0]==='agents'&&segments[2]==='permissions')target=`/agents/${segments[1]}`;
 const lifecycleState=method==='POST'&&segments.length===3?
  (segments[0]==='agents'?{pause:'paused',resume:'idle',terminate:'terminated'}[segments[2]]:
   segments[0]==='heartbeat-runs'&&segments[2]==='cancel'?'cancelled':undefined):undefined;
 if(lifecycleState)target='/'+segments.slice(0,2).join('/');
 try{
  const verified=await request(target);checkResponseScope(verified);
  const expectedId=workProductList?segments[1]:(result?.agent?.id??result?.id);
  const observed=Array.isArray(verified)?verified.find(r=>r.id===expectedId):verified;
  if(!observed||(expectedId&&observed.id!==expectedId))fail('read_back_mismatch');
  if(lifecycleState&&observed.status!==lifecycleState)fail('lifecycle_state_not_confirmed');
  const state=segments[0]==='agents'&&segments[2]==='permissions'?observed.permissions:observed;
  if(method==='PATCH'||method==='PUT')for(const [k,v]of Object.entries(project(body))){if(JSON.stringify(state?.[k])!==JSON.stringify(v))fail('read_back_mismatch');}
  return {...audit,status:'accepted',verification:'read_back',data:project(result),observed:project(observed)};
 }catch{return {...audit,status:'accepted_unverified',verification:'read_back_failed_or_mismatch_check_target',data:project(result)};}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main(process.argv.slice(2)).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(JSON.stringify({error:e.safe?e.message:'request_failed'}));process.exitCode=1;});}
