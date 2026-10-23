// All fixture identities, including zero-prefixed UUIDs, are synthetic.
import {fixture} from './route-a1.test.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Offline only: real AST-extracted route/control functions; explicit in-memory
// service/access fixtures. No HTTP, credentials, DB, live runs or process signals.
const root = process.env.BASELINE_ROOT;
const baselinePath = `${root}/routes/issues.js`;
const baselineHash = '3e337fb732708ed9e9399a9eaedf4a6415e1537ed3b77e3a4319d5580a98a69e';
const require = createRequire(process.env.ACORN_PACKAGE);
const { parse } = require('acorn');
const hash = s => createHash('sha256').update(s).digest('hex');
const baseline = readFileSync(baselinePath, 'utf8');
assert.equal(hash(baseline), baselineHash, 'STOP: installed source drift');
const targetPath = process.env.REVIEW_CANCEL_SOURCE || fileURLToPath(new URL('./issues.js', import.meta.url));
let source = readFileSync(targetPath, 'utf8');
// In-memory mutants never write installed or candidate code.
if (process.env.CANCEL_GUARD_MUTATION === 'all-blocked-open') {
  const needle = '(isBlocked || (isClosed && !isClosedIssueStatus(updateFields.status)))';
  assert.equal(source.split(needle).length, 2);
  source = source.replace(needle, '(isClosed && !isClosedIssueStatus(updateFields.status))');
}
if (process.env.CANCEL_GUARD_MUTATION === 'skip-cancel-helper') {
  const needle = 'agentStatusTransitionRequiresResumeAuthority &&';
  assert.equal(source.split(needle).length, 2);
  source = source.replace(needle, 'agentStatusTransitionRequiresResumeAuthority && updateFields.status !== "cancelled" &&');
}
console.log(JSON.stringify({ baselinePath, baselineHash, targetPath, targetHash: hash(readFileSync(targetPath)), executedHash: hash(source), mutation: process.env.CANCEL_GUARD_MUTATION || null }));
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(n => walk(n, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
function ast(text) { return parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true }); }
function functions(text) {
  const result = new Map();
  walk(ast(text), n => { if (n.type === 'FunctionDeclaration' && n.id) result.set(n.id.name, text.slice(n.start, n.end)); });
  return result;
}
const routeFunctions = functions(source);
const authSource = readFileSync(`${root}/routes/authz.js`, 'utf8');
const authFunctions = functions(authSource);
const runSource = readFileSync(`${root}/agent-run-cancellation.js`, 'utf8');
const runFunctions = functions(runSource);
const reconciliationSource = readFileSync(`${root}/services/execution-recovery-resolution.js`, 'utf8');
const reconciliationFunctions = functions(reconciliationSource);
const reviewSource = readFileSync(`${root}/services/issue-review-policy.js`, 'utf8');
const reviewFunctions = functions(reviewSource);
const scopeFunctions = functions(readFileSync(`${root}/services/task-watchdog-scope.js`, 'utf8'));
const policy = await import(`${root}/services/issue-execution-policy.js`);
const errors = await import(`${root}/errors.js`);
let handler;
walk(ast(source), n => {
  if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'router' && n.callee.property.name === 'patch' && n.arguments[0]?.value === '/issues/:id') handler = n.arguments.at(-1);
});
assert.ok(handler);
// Keep every original handler statement through the complete native run-cancel
// branch. Omit only response enrichment/logging/wake scheduling after that branch.
const end = handler.body.body.find(n => n.type === 'IfStatement' && n.test.type === 'Identifier' && n.test.name === 'titleOrDescriptionChanged');
assert.ok(end);
const routeBody = source.slice(handler.body.start + 1, end.start);
console.log(`route AST slice ${handler.loc.start.line}-${end.loc.start.line - 1}; downstream response/wake tail excluded`);
const table = name => new Proxy({}, { get: (_, key) => `${name}.${String(key)}` });
const eq = (a, b) => ({ field: a, value: b });
const and = (...parts) => ({ parts });
const query = rows => {
  const q = { from: () => q, where: () => q, for: () => q, limit: () => q, orderBy: () => q, then: (yes, no) => Promise.resolve(rows).then(yes, no) };
  return q;
};
const createHarness = fixture;
async function outcome(options) {
  const h = createHarness(options);
  try { h.result = await h.run(); } catch (error) { h.error = error; }
  return h;
}
async function denied(options, status, message) {
  const h = await outcome(options);
  assert.equal(h.error?.status || h.res.statusCode, status, h.error?.stack || JSON.stringify(h.res.payload));
  assert.match(h.error?.message || h.res.payload?.error || '', message);
  assert.deepEqual(h.calls.persisted, []);
  assert.deepEqual(h.calls.cancelled, []);
  return h;
}
for (const [name, setup] of [
  ['unfinished dependency', { blockers: true }],
  ['no assignee', { issue: { assigneeAgentId: null, executionRunId:'active-run' } }],
  ['no assignee and dependency', { blockers: true, issue: { assigneeAgentId: null, executionRunId:'active-run' } }],
]) test(`blocked cancellation reaches native cancellation: ${name}`, async () => {
  const h = await outcome(setup);
  assert.ifError(h.error);
  assert.equal(h.res.statusCode, 200, JSON.stringify(h.res.payload));
  assert.equal(h.result?.issue.status, 'cancelled');
  assert.equal(h.calls.persisted[0]?.status, 'cancelled');
  assert.deepEqual(h.calls.cancelled, ['active-run']);
  assert.equal(h.calls.activity.at(-1)?.details.source, 'issue_status_cancelled');
});
for (const status of ['todo', 'in_progress', 'done']) {
  test(`blocked -> ${status} still rejects dependency`, () => denied({ blockers: true, body: { status } }, 409, /unresolved blockers/));
  test(`blocked -> ${status} still requires assignee`, () => denied({ issue: { assigneeAgentId: null }, body: { status } }, 409, /assigned agent/));
}
for (const body of [{ resume: true, comment: 'continue' }, { reopen: true }]) {
  test(`explicit ${body.resume ? 'resume' : 'reopen'} plus cancel retains dependency gate`, () => denied({ blockers: true, body }, 409, /unresolved blockers/));
  test(`explicit ${body.resume ? 'resume' : 'reopen'} plus cancel retains assignee gate`, () => denied({ issue: { assigneeAgentId: null }, body }, 409, /assigned agent/));
}
test('cancel retains active subtree pause hold', () => denied({ pause: true, blockers: true }, 409, /active subtree pause hold/));
test('cancel retains low trust control plane denial', () => denied({ lowTrust: true }, 403, /Low-trust/));
test('cancel retains assigned-other ownership boundary', () => denied({ issue: { assigneeAgentId: 'other' }, defaultOpen: false }, 403, /another agent/));
test('cancel retains missing agent identity denial', () => denied({ actor: { agentId: null } }, 403, /authentication required/));
test('cross-company cancellation remains hidden', () => denied({ actor: { companyId: 'foreign' } }, 404, /Issue not found/));
test('unauthenticated actor remains hidden', () => denied({ actor: { type: 'none' } }, 404, /Issue not found/));
test('real persisted watchdog subtree scope denial precedes cancel', () => denied({ scopeRun: { id: 'run', companyId: 'company', agentId: 'agent', contextSnapshot: { taskWatchdog: { watchedIssueId: 'watched-root' } } } }, 403, /only mutate the watched issue subtree/));
test('real persisted run agent identity mismatch stays denied', () => denied({ scopeRun: { id: 'run', companyId: 'company', agentId: 'foreign-agent', contextSnapshot: { taskWatchdog: { watchedIssueId: 'watched-root' } } } }, 403, /does not belong to this agent/));
test('real persisted run company mismatch stays denied', () => denied({ scopeRun: { id: 'run', companyId: 'foreign-company', agentId: 'agent', contextSnapshot: { taskWatchdog: { watchedIssueId: 'watched-root' } } } }, 403, /does not belong to this agent/));
test('in-progress checkout conflict remains enforced', () => denied({ issue: { status: 'in_progress' }, checkoutConflict: true }, 409, /ownership conflict/));
test('in-progress owner still needs run id', () => denied({ issue: { status: 'in_progress' }, actor: { runId: null } }, 401, /run id required/));
test('run influence cap denial precedes persistence', () => denied({ runCap: true }, 403, /run influence cap/));
test('real commit-time revoked-run guard rejects cancellation', () => denied({ revoked: true }, 403, /run was cancelled/));
test('recovery owner cannot bypass source ownership', () => denied({ issue: { assigneeAgentId: 'other' }, recovery: { id: 'recovery', ownerAgentId: 'agent' } }, 403, /Recovery ownership does not authorize/));
test('recovery action cannot be resolved by unrelated actor', () => denied({ issue: { assigneeAgentId: 'other' }, recovery: { id: 'recovery', ownerAgentId: 'third' } }, 403, /another owner/));
test('recovery source checkout lock remains enforced', () => denied({ issue: { checkoutRunId: 'other-run' }, recovery: { id: 'recovery', ownerAgentId: 'agent' } }, 409, /locked by another active checkout/));
test('review human-only cancellation verdict stays denied', () => denied({ issue: { status: 'in_review', reviewPolicy: 'human_only' } }, 403, /human_only/));
test('locked review recheck rejects concurrent human-only policy', () => denied({ lockedIssue: { status: 'in_review', reviewPolicy: 'human_only' } }, 403, /human_only/));
test('real reconciliation rejects absent recorded decision', async () => {
  const sandbox = { conflict: errors.conflict };
  vm.createContext(sandbox);
  vm.runInContext(reconciliationFunctions.get('validateExecutionReconciliation'), sandbox);
  await assert.rejects(sandbox.validateExecutionReconciliation({ companyId: 'company', issueId: 'issue', agentId: 'agent', sourceRunId: 'failed-run' }), /Reconcile the recorded execution/);
});
// Whole real pure execution-policy function, not an always-success approval mock.
test('real approval stage rejects non-participant advancement', () => {
  const reviewerId = '00000000-0000-4000-8000-000000000001';
  const ownerId = '00000000-0000-4000-8000-000000000002';
  const stageId = '00000000-0000-4000-8000-000000000003';
  const participant = { type: 'agent', agentId: reviewerId };
  const executionState = { status: 'pending', currentStageId: stageId, currentStageIndex: 0, currentStageType: 'approval', currentParticipant: participant, returnAssignee: { type: 'agent', agentId: ownerId }, reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, monitor: null };
  const executionPolicy = { stages: [{ id: stageId, type: 'approval', approvalsNeeded: 1, participants: [participant] }] };
  assert.throws(() => policy.applyIssueExecutionPolicyTransition({ issue: { status: 'in_review', assigneeAgentId: reviewerId, assigneeUserId: null, executionState }, policy: policy.normalizeIssueExecutionPolicy(executionPolicy), previousPolicy: policy.normalizeIssueExecutionPolicy(executionPolicy), requestedStatus: 'cancelled', requestedAssigneePatch: {}, actor: { agentId: ownerId, userId: null }, allowBoardOverride: false }), /Only the active reviewer or approver/);
});

// ALEA-370 reviewer-only additions. Frozen suite above is an exact byte prefix.
const sharedSchemaModule = await import(new URL('./validators/issue.js', import.meta.resolve('@paperclipai/shared')).href);
const middlewareModule = await import(`${root}/middleware/validate.js`);
function parseReviewBody(body) {
  const request = {body};
  let advanced = false;
  middlewareModule.validateIssueMutationBody(sharedSchemaModule.updateIssueSchema)(request, {}, () => { advanced = true; });
  assert.equal(advanced, true);
  return request.body;
}
for (const status of ['todo', 'in_progress', 'done']) test(`reviewer: injected internal options cannot admit blocked -> ${status}`, async () => {
  const body = parseReviewBody({status, cancelIntent:true, resumeIntent:true, options:{cancelIntent:true}, actor:{type:'board'}});
  assert.deepEqual(body, {status});
  await denied({blockers:true, body},409,/unresolved blockers/);
});
test('reviewer: explicit resume plus injected cancellation still denies', async () => {
  const body = parseReviewBody({status:'cancelled',resume:true,comment:'continue',cancelIntent:true});
  await denied({blockers:true,body},409,/unresolved blockers/);
});
test('reviewer: unassigned cancellation retains issue access denial', () => denied({issue:{assigneeAgentId:null},accessDenied:true},403,/issue_write_denied/));
test('reviewer: unassigned cancellation retains pause denial', () => denied({issue:{assigneeAgentId:null},blockers:true,pause:true},409,/active subtree pause hold/));
test('reviewer: unassigned recovery owner is not source owner', () => denied({issue:{assigneeAgentId:null},recovery:{id:'recovery',ownerAgentId:'agent'}},403,/Recovery ownership does not authorize/));
test('reviewer: assigned-other default-open cancellation is preserved', async () => {
  const h = await outcome({issue:{assigneeAgentId:'other'},blockers:true});
  assert.ifError(h.error); assert.equal(h.result.issue.status,'cancelled');
  assert.deepEqual(h.calls.cancelled,['active-run']);
});
test('reviewer: post-commit cancel failure leaves persisted cancelled, no stop confirmation', async () => {
  const h = createHarness({blockers:true});
  h.sandbox.heartbeat.cancelRun = async () => { throw new Error('reviewer simulated stop failure'); };
  const result = await h.run();
  assert.equal(result.issue.status,'cancelled');
  assert.equal(h.calls.persisted[0].status,'cancelled');
  assert.equal(result.cancelledStatusRunId,null);
  assert.equal(h.calls.activity.at(-1).details.runOutcome,'unknown');
  console.log('REVIEWER_STOP_FAILURE',JSON.stringify({persistedStatus:result.issue.status,confirmedRunId:result.cancelledStatusRunId,activity:h.calls.activity.at(-1).action}));
});
test('A1 replacement: unconfirmed stop retains committed cancellation', async () => {
  const h = createHarness({blockers:true});
  h.sandbox.stopRunnerGoalForOwnershipChange = async () => 'pause';
  h.sandbox.heartbeat.cancelRun = async () => null;
  const result = await h.run();
  assert.equal(result.issue.status,'cancelled');
  assert.equal(result.cancelledStatusRunId,null);
  assert.equal(h.calls.activity.at(-1).details.runOutcome,'unknown');
});
test('reviewer: real active-run fallback does not stop another task', async () => {
  const h = createHarness({blockers:true});
  h.sandbox.heartbeat.getActiveRunForAgent = async () => ({id:'other-run',status:'running',contextSnapshot:{issueId:'another-issue'}});
  vm.runInContext(routeFunctions.get('resolveActiveIssueRun'), h.sandbox);
  const result = await h.run();
  assert.equal(result.issue.status,'cancelled');
  assert.deepEqual(h.calls.cancelled,[]);
});
const reviewerIds = {reviewer:'00000000-0000-4000-8000-000000000001',owner:'00000000-0000-4000-8000-000000000002',stage:'00000000-0000-4000-8000-000000000003'};
function pendingApprovalIssue(status='in_review') {
  const participant={type:'agent',agentId:reviewerIds.reviewer};
  return {status,assigneeAgentId:reviewerIds.reviewer,executionState:{status:'pending',currentStageId:reviewerIds.stage,currentStageIndex:0,currentStageType:'approval',currentParticipant:participant,returnAssignee:{type:'agent',agentId:reviewerIds.owner},reviewRequest:null,completedStageIds:[],lastDecisionId:null,lastDecisionOutcome:null,monitor:null},executionPolicy:{stages:[{id:reviewerIds.stage,type:'approval',approvalsNeeded:1,participants:[participant]}]}};
}
test('reviewer: route-integrated approval denies nonparticipant cancellation', () => denied({issue:pendingApprovalIssue(),actor:{agentId:reviewerIds.owner}},422,/Only the active reviewer or approver/));
test('REGRESSION: blocked pending approval rewritten to in_review must not cancel its active run', async () => {
  const h = createHarness({issue:{...pendingApprovalIssue('blocked'),executionRunId:'active-run'},actor:{agentId:reviewerIds.owner},blockers:true});
  // Real review-path helper; only its interaction query is an empty-data fixture.
  h.sandbox.issueThreadInteractionService = () => ({listForIssue:async()=>[]});
  vm.runInContext(routeFunctions.get('hasExecutionParticipant'),h.sandbox);
  vm.runInContext(routeFunctions.get('authenticatedActorResponsibleUserId'),h.sandbox);
  h.sandbox.heartbeat.getRun = async id => ({id,status:'running',companyId:'company',agentId:reviewerIds.reviewer,contextSnapshot:{issueId:'issue'}});
  vm.runInContext(routeFunctions.get('resolveActiveIssueRun'),h.sandbox);
  h.result = await h.run();
  assert.equal(h.result.issue.status,'in_review');
  assert.equal(h.calls.persisted[0].status,'in_review');
  assert.deepEqual(h.calls.cancelled,[]);
  console.log('REVIEWER_APPROVAL_COUNTEREXAMPLE',JSON.stringify({requestedStatus:'cancelled',persistedStatus:h.result.issue.status,assignee:h.result.issue.assigneeAgentId,cancelledRunIds:h.calls.cancelled}));
});

// Focused service/async-tail probes: real AST code, explicit query fixtures.
const issueServiceSource = readFileSync(`${root}/services/issues.js`,'utf8');
const issueServiceFunctions = functions(issueServiceSource);
let parentEligibilityNode, parentWakeNode;
walk(ast(issueServiceSource),n=>{if(n.type==='Property' && n.key?.name==='getWakeableParentAfterChildCompletion') parentEligibilityNode=n.value;});
walk(ast(source),n=>{if(n.type==='IfStatement' && n.test.type==='LogicalExpression' && n.test.left?.name==='becameTerminal' && n.test.right?.type==='MemberExpression' && n.test.right.object?.name==='issue' && n.test.right.property?.name==='parentId') parentWakeNode=n;});
assert.ok(parentEligibilityNode);assert.ok(parentWakeNode);
function parentWakeHarness(parentStatus='blocked',childStatuses=['done','cancelled']) {
  const parentRow={id:'parent',companyId:'company',assigneeAgentId:'parent-agent',status:parentStatus,conversationAgentId:null};
  const children=childStatuses.map((status,i)=>({id:`child-${i}`,status,title:`child ${i}`}));
  const rows=[[parentRow],children,[]];
  const events=[];
  const sandbox={db:{select:()=>query(rows.shift())},issues:table('issues'),issueComments:table('issueComments'),eq,and,asc:x=>x,desc:x=>x,inArray:(...x)=>x,isNull:x=>x,MAX_CHILD_COMPLETION_SUMMARIES:20,truncateInlineSummary:x=>x};
  vm.createContext(sandbox);
  sandbox.getParent=vm.runInContext(`(${issueServiceSource.slice(parentEligibilityNode.start,parentEligibilityNode.end)})`,sandbox);
  sandbox.svc={getWakeableParentAfterChildCompletion:sandbox.getParent};
  sandbox.becameTerminal=true;
  sandbox.issue={id:'child-1',parentId:'parent',status:'cancelled'};
  sandbox.actor={actorType:'agent',actorId:'agent'};
  sandbox.addWakeup=(agentId,wakeup)=>events.push({agentId,wakeup});
  return {events,run:()=>vm.runInContext(`(async()=>{${source.slice(parentWakeNode.start,parentWakeNode.end)}})()`,sandbox)};
}
test('reviewer counterexample: cancelling final child can enqueue blocked parent completion',async()=>{
  const h=parentWakeHarness();await h.run();
  assert.equal(h.events[0].agentId,'parent-agent');
  assert.equal(h.events[0].wakeup.reason,'issue_children_completed');
  assert.equal(h.events[0].wakeup.payload.issueId,'parent');
  console.log('REVIEWER_PARENT_WAKE',JSON.stringify(h.events));
});
test('reviewer: nonterminal sibling prevents parent completion wake',async()=>{
  const h=parentWakeHarness('blocked',['blocked','cancelled']);await h.run();assert.deepEqual(h.events,[]);
});
test('reviewer: cancelled parent cannot receive completion wake',async()=>{
  const h=parentWakeHarness('cancelled');await h.run();assert.deepEqual(h.events,[]);
});
test('reviewer: cancelled blocker remains unresolved, unlike done blocker',async()=>{
  const sandbox={eq,and,inArray:(...x)=>x,issues:table('issues'),issueRelations:table('issueRelations')};
  vm.createContext(sandbox);
  for(const name of ['createIssueDependencyReadiness','listPendingFinalizeBlockerIssueIds','listIssueDependencyReadinessMap']) vm.runInContext(issueServiceFunctions.get(name),sandbox);
  for(const [blockerStatus,ready] of [['cancelled',false],['done',true]]) {
    const db={select:()=>{const q=query([{issueId:'dependent',blockerIssueId:'root',blockerStatus,blockerExecutionWorkspaceId:null}]);q.innerJoin=()=>q;return q;}};
    const result=(await sandbox.listIssueDependencyReadinessMap(db,'company',['dependent'])).get('dependent');
    assert.equal(result.isDependencyReady,ready);
    assert.equal(result.unresolvedBlockerCount,ready?0:1);
  }
});
