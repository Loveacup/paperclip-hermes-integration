const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const acorn = require(path.join(__dirname, '..', 'host-deps', 'node_modules', 'acorn'));
const ROOT = process.env.BASELINE_ROOT;
const base = process.env.CANDIDATE_ROOT;
if (!ROOT || !base) throw Error('Explicit BASELINE_ROOT and CANDIDATE_ROOT required; use run_host.py');
function read(relative) { return fs.readFileSync(path.join(base, relative), 'utf8'); }
function nodes(src) {
  const out=[]; function walk(n) { if(!n || typeof n!=='object') return; if(n.type) out.push(n); for(const [k,v] of Object.entries(n)) if(k!=='start'&&k!=='end') { if(Array.isArray(v)) v.forEach(walk); else if(v&&typeof v==='object') walk(v); } }
  walk(acorn.parse(src,{ecmaVersion:'latest',sourceType:'module'})); return out;
}
function fn(src,name) { const n=nodes(src).find(n=>n.type==='FunctionDeclaration'&&n.id.name===name); return n ? src.slice(n.start,n.end) : ''; }
function harness(path, opts={}) {
  const effects=[], decisions=[];
  const actor = {type:'agent',agentId:'ceo',companyId:'c',runId:'actor-run',keyId:'key', ...opts.actor};
  const caller={id:'ceo',role:'ceo',status:'idle',companyId:'c', ...opts.caller};
  const target=opts.missing ? null : {id:'target',companyId:'c',status:'idle', ...opts.target};
  const run=opts.missingRun ? null : {id:'run',companyId:'c',agentId:'target',status:'running', ...opts.run};
  const denied = m=>Object.assign(new Error(m),{status:403});
  const context={
    forbidden:denied, notFound:m=>Object.assign(new Error(m),{status:404}), authorizationDeniedDetails:d=>d,
    responsibleUserAuthzShadowMode:()=>false,logger:{warn(){}},HttpError:class extends Error {constructor(status,m){super(m);this.status=status;}},unauthorized:()=>denied('unauthenticated'),
    svc:{getById:async id=>id==='ceo'?caller:target,pause:async()=>{effects.push('pause');return target;},terminate:async()=>{effects.push('terminate');return target;}},
    access:{decide:async input=>{decisions.push(input);return typeof opts.policy === 'function' ? opts.policy(input) : opts.policy || {allowed:true};}},
    heartbeat:{getRun:async()=>run,cancelActiveForAgent:async()=>effects.push('cancelActive'),cancelInvocationsForAgents:async()=>{effects.push('cancelInvocations');return {};},cancelRun:async(id,reason,options)=>{effects.push({cancel:options,reason});return {...run,status:'cancelled',resultJson:options.resultJson};}},
    approvalsSvc:{findOpenHireApprovalForAgent:async()=>({id:'approval'}),reject:async()=>effects.push('rejectApproval')},
    db:{select:()=>({from:()=>({where:async()=>[]})})}, agentsTable:{},eq:()=>{},listInvalidOrgChainDescendantIds:()=>[],
    logActivity:async(db,data)=>effects.push({log:data}),redactAgentRowForResponse:x=>x,readHeartbeatRunId:r=>r.params.runId,
  };
  const auth=fs.readFileSync(`${ROOT}/routes/authz.js`,'utf8');
  const src=read('routes/agents.js');
  const helpers=['assertBoardCanManageAgentsForCompany','getAccessibleAgent','assertCanControlAgentLifecycle'].map(n=>fn(src,n));
  const n=nodes(src).find(n=>n.type==='CallExpression' && n.callee?.object?.name==='router' && n.callee?.property?.name==='post' && n.arguments[0]?.value===path);
  if(!n) throw Error('route missing');
  const handler=n.arguments.at(-1);
  const code=['throwOrShadowResponsibleUserCompanyAccessDeny','assertAuthenticated','assertBoard','assertCompanyAccess','hasCompanyAccess','getAccessibleResource','getActorInfo'].map(n=>fn(auth,n)).join('\n')+'\n'+helpers.join('\n')+`\nhandler = (${src.slice(handler.start,handler.end)});`;
  vm.createContext(context);vm.runInContext(code,context);
  const req={actor,method:'POST',params:{id:'target',runId:'run'},body:{role:'ceo',cancelledByActorType:'user',...opts.body}};
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;}};
  return {effects,decisions,res,async invoke(){await context.handler(req,res);return res;}};
}
function recovery(run) {const src=read('services/recovery/service.js');return vm.runInNewContext(`(${fn(src,'isOperatorCancelledRun')})(run,'target')`,{run,parseObject:x=>x||{},CHAT_CONTROL_RECOVERY_STOP_CODE:'stop',CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE:'unresolved'});}
module.exports={harness,recovery,fn,read,ROOT};
