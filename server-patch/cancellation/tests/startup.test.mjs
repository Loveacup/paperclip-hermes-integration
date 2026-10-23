import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {HarnessDriverBackend} from './candidate/vendor/paperclip-runner/backends/harness-driver-backend.js';
import * as broker from './candidate/services/runner-goal-control-broker.js';
const read=p=>readFileSync(new URL('./candidate/'+p,import.meta.url),'utf8');
const stateText=read('vendor/paperclip-runner/drivers/codex/codex-session-state.js');
const State=Function(stateText.slice(stateText.indexOf('class AsyncQueue')).replaceAll('export ','')+'\n;return CodexSessionState;')();
const harnessText=read('vendor/paperclip-runner/drivers/codex/codex-harness-session.js');
const Harness=Function('CodexSessionState','randomUUID','initializeCodexSessionEvents','pumpNotifications','parseThreadGoal','CodexRpcError',harnessText.slice(harnessText.indexOf('export class ')).replace('export ','')+'\n;return CodexHarnessSession;')(State,randomUUID,()=>{},async()=>{},x=>x,class extends Error{});
const driverText=read('vendor/paperclip-runner/drivers/codex/codex-app-server-driver-impl.js');
const openText=driverText.slice(driverText.indexOf('    async openSession(input) {'),driverText.indexOf('    async recoverSession('));
const sessionText=driverText.slice(driverText.indexOf('    #session(input) {'),driverText.lastIndexOf('\n}'));
const factory=Function('CodexHarnessSession','validateWorkingDirectory','bootstrapCancellation','createSecuredCodexThreadParams','DRIVER_KIND','return ({'+(openText+','+sessionText).replaceAll('#','_')+'});')(Harness,x=>x,()=>({wait:async x=>x,detach(){},close:async()=>{}}),()=>({}),'codex_app_server');
const runtime=read('vendor/paperclip-runner/native-session-runtime.js');
const apply=Function(runtime.slice(runtime.indexOf('export async function applyNativeSessionGoalControl('),runtime.indexOf('\nfunction sessionGoalResult(')).replace('export ','')+';return applyNativeSessionGoalControl;')();
const native=read('services/native-runtime/native-session-executor.js');
const start=native.indexOf('                    if (session?.goal) {',native.indexOf('onSession: async (session) =>'));
const register=Function('input','session','registerLiveRunnerGoalController','applyNativeSessionGoalControl','let releaseGoalController;'+native.slice(start,native.indexOf('                    if (session &&',start))+';return releaseGoalController');
const runnerd=read('vendor/paperclip-runner/live/runnerd-codex-transport.js');
const requestText=runnerd.slice(runnerd.indexOf('    async request('),runnerd.indexOf('    notify(_method, _params)'));
const resultText=runnerd.slice(runnerd.indexOf('    async #commandResult('),runnerd.indexOf('    async #waitForProviderIdentity('));
const runnerMethods=Function('randomUUID','record','return ({'+(requestText+','+resultText).replaceAll('#','_')+'});')(randomUUID,x=>x&&typeof x==='object'?x:{});
test('normal backend open -> real driver open/factory -> real constructors -> onSession -> targeted clear',async()=>{
 broker.runnerGoalControlBrokerInternals.resetForTests();
 const effects=[],commands=[];let harness,row;
 const actionTable={id:'id',companyId:'companyId',sessionId:'sessionId',requestId:'requestId'};
 const sessionTable={...actionTable};
 const dbSession={id:'db-session',companyId:'company',agentId:'agent',taskKey:'issue',goalRevision:7};
 const db={transaction:async fn=>fn(db),select(){let table;const q={from(t){table=t;return q;},where(){return q;},limit(){return q;},for(){return q;},then(fn){return Promise.resolve(table===sessionTable?[dbSession]:row?[row]:[]).then(fn);}};return q;},insert(){return {values(v){row={...v,id:'row'};return {onConflictDoNothing(){return {returning:async()=>[row]};}};}};},update(){return {set(v){row={...row,...v};return {where:async()=>{}};}};}};
 const goalSource=read('services/runner-goals.js');
 const goalApi=Function('agentTaskSessions','agentSessionGoalActions','and','eq','dispatchLiveRunnerGoalControl','isDeepStrictEqual',goalSource.slice(goalSource.indexOf('export async function registerTargetedRunnerGoalStop('),goalSource.indexOf('// End internal targeted one-shot controls.')).replaceAll('export ','')+';return {registerTargetedRunnerGoalStop,dispatchTargetedRunnerGoalStop};')(sessionTable,actionTable,(...x)=>x,(...x)=>x,broker.dispatchLiveRunnerGoalControl,isDeepStrictEqual);
 const prp=Object.assign(Object.create(runnerMethods),{_closed:false,_pendingWarmRecoveryCompletion:null,_throwIfFailed(){},_core:{store:{state:{commands}},queueCommand(type,payload,commandId){assert.equal(row.resultJson.phase,'consumed','durable consumption precedes PRP dispatch');commands.push({type,payload,commandId,status:'pending'});},getCommand(id){return commands.find(c=>c.commandId===id);}},async _waitCommand(type,id){const command=this._core.getCommand(id);assert.equal(command.type,type);command.status='completed';command.result={result:{}};}});
 // These are bootstrap/security/configuration and transport leaves only. The
 // real openSession builds identity inputs; real #session and both constructors
 // supply every consumer-target identity without a constructor-injected target.
 const transport={setServerRequestHandler(){},async request(method,params){effects.push({method,params});return method==='thread/start'?{thread:{id:'thread'}}:prp.request(method,params);},async close(){}};
 const driver=Object.assign(Object.create(factory),{
 _options:{environment:{},taskEnvelope:{}},_caps:{goals:true,steering:false},_goalCapability:{actions:['clear','pause']},
 _transport:()=>transport,_persistProcessOwnership:async()=>{},_initialize:async()=>({}),_direct:()=>true,_prepared:()=>false,
 _providerDynamicTools:()=>[],_negotiateCollaborationMode:async()=>null,
 _openedThread:()=>({threadId:'thread',providerSessionId:'provider-session',context:{},lineage:{threadId:'thread'}}),_discoverGoal:async()=>null,
 async descriptor(){return {kind:'codex_app_server',capabilities:{steering:false}};},
 });
 const actualOpen=driver.openSession.bind(driver);
 driver.openSession=async input=>{harness=await actualOpen(input);harness.emit=()=>{};harness.emitGoalEvent=()=>{};return harness;};
 const binding={companyId:'company',issueId:'issue',agentId:'agent',runId:'run'};
 const backend=new HarnessDriverBackend(driver);
 const session=await backend.openSession({identity:{...binding,sessionId:'native-session'},workingDirectory:'.'});
 register({execution:{binding}},session,broker.registerLiveRunnerGoalController,apply);
 const captured=broker.captureLiveRunnerGoalController(binding);
 assert.deepEqual({...captured.goalTarget,ownerEpoch:'generated'}, {runId:'run',sessionId:'native-session',threadId:'thread',ownerEpoch:'generated'});
 const registered=await goalApi.registerTargetedRunnerGoalStop(db,{...binding,sessionId:'db-session',action:'clear',requestId:'cancel-real-startup',target:captured});
 assert.equal(commands.length,0);
 const outcome=await goalApi.dispatchTargetedRunnerGoalStop(db,registered);
 const receipt=outcome.effect;
 assert.equal(outcome.outcome,'confirmed');assert.equal(receipt.target.ownerEpoch,captured.goalTarget.ownerEpoch);
 assert.equal(effects.at(-1).method,'thread/goal/clear');
 assert.equal(commands.length,1);assert.equal(commands[0].type,'session.goal.clear');
 await goalApi.dispatchTargetedRunnerGoalStop(db,registered);assert.equal(commands.length,1);
});
