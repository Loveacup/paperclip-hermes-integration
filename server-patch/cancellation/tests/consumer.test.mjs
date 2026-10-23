import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import * as broker from './candidate/services/runner-goal-control-broker.js';
const read=p=>readFileSync(new URL('./candidate/'+p,import.meta.url),'utf8');
// Actual complete class methods, with only imported state/reducer/I/O leaves supplied.
const driver=read('vendor/paperclip-runner/drivers/codex/codex-harness-session.js');
let timerHooks;
const Harness=Function('CodexSessionState','randomUUID','parseThreadGoal','CodexRpcError','setTimeout','clearTimeout',driver.slice(driver.indexOf('export class ')).replace('export ','')+'\n;return CodexHarnessSession;')(class {},randomUUID,x=>x,class extends Error{},(fn,ms)=>timerHooks?timerHooks.set(fn,ms):setTimeout(fn,ms),id=>timerHooks?timerHooks.clear(id):clearTimeout(id));
const runtime=read('vendor/paperclip-runner/native-session-runtime.js');
const apply=Function(runtime.slice(runtime.indexOf('export async function applyNativeSessionGoalControl('),runtime.indexOf('\nfunction sessionGoalResult(')).replace('export ','')+';return applyNativeSessionGoalControl;')();
const native=read('services/native-runtime/native-session-executor.js');
const start=native.indexOf('                    if (session?.goal) {',native.indexOf('onSession: async (session) =>'));
const end=native.indexOf('                    if (session &&',start);
const register=Function('input','session','registerLiveRunnerGoalController','applyNativeSessionGoalControl','let releaseGoalController;'+native.slice(start,end)+';return releaseGoalController');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function setup(request=async()=>({})){
 broker.runnerGoalControlBrokerInternals.resetForTests();
 const effects=[];
 // No model, process, network or DB. The actual constructor starts a notification
 // pump; instantiate its prototype to keep those I/O owners explicitly absent.
 const state=Object.assign(Object.create(Harness.prototype),{
 runId:'run',normalizedSessionId:'task-session',opened:{threadId:'thread'},activeTurnId:null,turnStartPending:false,
 pendingRuntimeRequestMap:new Map(),eventQueue:{clear(){},close(){}},cancelPendingRequests(){},terminalTurns:new Set(),goalCapability:{actions:['clear','pause']},
 assertProtocolIntegrity(){},requireCapability(){},emit(){},emitGoalEvent(){},rethrowProtocolIntegrity(){},unsupported(_op,e){return Error(e);},
 transport:{async request(m,p){effects.push({method:m,params:p});return request(m,p);},async attachRun(i){effects.push({attach:i.runId});}},
 });
 const backend=read('vendor/paperclip-runner/backends/harness-driver-backend.js');
 // Real forwarding methods; private identity/protocol fields are not replaced in
 // the product. The capture method has no private dependencies.
 const capStart=backend.indexOf('    captureGoalControlTarget() {');
 const capEnd=backend.indexOf('    goal(input) {',capStart);
 const capture=capStart<0?undefined:Function('return ({'+backend.slice(capStart,capEnd).replaceAll('this.#session','this.session')+'}).captureGoalControlTarget')();
 const session={goal:state.goal.bind(state),...(capture?{captureGoalControlTarget:capture.bind({session:state})}:{})};
 const binding={companyId:'company',issueId:'issue',agentId:'agent',runId:'run'};
 register({execution:{binding}},session,broker.registerLiveRunnerGoalController,apply);
 return {state,effects,binding,captured:broker.captureLiveRunnerGoalController(binding)};
}
test('normal onSession publishes consumer target and returns exact clear receipt',async()=>{
 const s=setup();
 assert.equal(s.captured.goalTarget?.sessionId,'task-session');
 assert.equal(s.captured.goalTarget?.runId,'run');
 assert.equal(s.captured.goalTarget?.threadId,'thread');
 assert.equal(typeof s.captured.goalTarget?.ownerEpoch,'string');
 const result=await broker.dispatchLiveRunnerGoalControl(s.captured,{action:'clear',requestId:'cancel-1',target:s.captured.goalTarget}).completion;
 assert.deepEqual(result,{status:'confirmed',requestId:'cancel-1',action:'clear',target:s.captured.goalTarget});
 assert.deepEqual(s.effects,[{method:'thread/goal/clear',params:{threadId:'thread'}}]);
});
test('same-run autonomous goal revision is not a new execution owner',async()=>{
 const s=setup(); assert.ok(s.captured.goalTarget);
 s.state.currentGoal={objective:'provider revised',revision:900};
 const result=await apply(s.state,{action:'clear',requestId:'same-run',target:s.captured.goalTarget});
 assert.equal(result.status,'confirmed'); assert.equal(s.effects.length,1);
});
test('same thread A to B to A invalidates old consumer target',async()=>{
 const s=setup();assert.ok(s.captured.goalTarget);
 await s.state.attachRun({runId:'B'});await s.state.attachRun({runId:'run'});s.effects.length=0;
 await assert.rejects(apply(s.state,{action:'clear',target:s.captured.goalTarget}),/target_changed/);
 assert.deepEqual(s.effects,[]);
});
test('attachment admitted before goal consumption rejects old target without RPC',async()=>{
 const s=setup(); assert.ok(s.captured.goalTarget);
 const attach=s.state.attachRun({runId:'B'});
 const attempt=apply(s.state,{action:'clear',target:s.captured.goalTarget});
 await attach;await assert.rejects(attempt,/target_changed/);
 assert.equal(s.effects.some(e=>e.method),false);
});
test('takeover waits for in-flight provider effect, not just broker check',async()=>{
 const gate=deferred(), entered=deferred();
 const s=setup(async()=>{entered.resolve();await gate.promise;return {};});assert.ok(s.captured.goalTarget);
 const attempt=apply(s.state,{action:'clear',requestId:'during',target:s.captured.goalTarget});
 await entered.promise;
 const takeover=s.state.attachRun({runId:'B'});
 await Promise.resolve();assert.equal(s.effects.some(e=>e.attach),false);
 gate.resolve();assert.equal((await attempt).status,'confirmed');await takeover;
 assert.equal(s.effects[1].attach,'B');
});
test('uncertain provider effect fences later attachment and never replays goal',async()=>{
 const s=setup(async()=>{throw Error('lost receipt');});assert.ok(s.captured.goalTarget);
 await assert.rejects(apply(s.state,{action:'clear',requestId:'lost',target:s.captured.goalTarget}),/lost receipt/);
 await assert.rejects(s.state.attachRun({runId:'B'}),/goal_control_unconfirmed/);
 assert.equal(s.effects.length,1);
});
test('ordinary clear stays backward compatible',async()=>{
 const s=setup();assert.equal(await apply(s.state,{action:'clear',requestId:'ordinary'}),null);
 assert.deepEqual(s.effects,[{method:'thread/goal/clear',params:{threadId:'thread'}}]);
});

for (const operation of ['close','detachControllerForRestart']) test(`${operation} cannot release provider ownership before targeted effect settles`,async()=>{
 const gate=deferred(),entered=deferred();
 const s=setup(async()=>{entered.resolve();await gate.promise;return {};});
 s.state.transport[operation]=async()=>{s.effects.push({released:true});};
 const effect=apply(s.state,{action:'clear',requestId:'release-race',target:s.captured.goalTarget});
 await entered.promise;
 const release=s.state[operation]();await Promise.resolve();
 assert.equal(s.effects.some(e=>e.released),false);
 gate.resolve();await effect;await release;
 assert.equal(s.effects.at(-1).released,true);
 await assert.rejects(apply(s.state,{action:'clear',requestId:'late',target:s.captured.goalTarget}),/target_changed/);
});
test('unanswered provider RPC times out unknown so exact-owner close is not deadlocked',async()=>{
 const callbacks=[];timerHooks={set(fn,ms){callbacks.push({fn,ms});return 1;},clear(){}};
 const gate=deferred(),entered=deferred();
 const s=setup(async()=>{entered.resolve();await gate.promise;return {};});
 try {
  const attempt=apply(s.state,{action:'clear',requestId:'timeout',target:s.captured.goalTarget});
  await entered.promise;
  assert.equal(callbacks.length,1,'targeted consumer must bound an otherwise unbounded app-server RPC');
  assert.equal(callbacks[0].ms,30000);callbacks[0].fn();
  await assert.rejects(attempt,/goal_control_unconfirmed/);
  await assert.rejects(s.state.attachRun({runId:'B'}),/goal_control_unconfirmed/);
  s.state.transport.close=async()=>{};await s.state.close();
 } finally {gate.resolve();timerHooks=undefined;}
});
