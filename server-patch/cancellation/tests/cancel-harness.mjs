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
const targetPath = process.env.REVIEW_CANCEL_SOURCE || fileURLToPath(new URL('../cancel-candidate/issues.js', import.meta.url));
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
function createHarness(options = {}) {
  const issue = { id: 'issue', companyId: 'company', status: 'blocked', assigneeAgentId: 'agent', assigneeUserId: null, checkoutRunId: null, executionRunId: null, executionState: null, executionPolicy: null, parentId: null, reviewPolicy: 'anyone', ...options.issue };
  const calls = { persisted: [], cancelled: [], activity: [] };
  const actor = { type: 'agent', agentId: 'agent', companyId: 'company', runId: 'run', ...options.actor };
  const req = { method: 'PATCH', params: { id: issue.id }, actor, body: { status: 'cancelled', ...options.body } };
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.payload = value; return this; }, on() {}, once() {} };
  const db = {
    select: () => ({ from: t => {
      if (t === sandbox.heartbeatRuns) return query(options.scopeRun ? [options.scopeRun] : []);
      if (t === sandbox.issueWatchdogs) return query([{ id: 'watchdog', companyId: 'company', issueId: 'watched-root', status: 'active' }]);
      if (t === sandbox.issues) return query([{ ...issue, originKind: 'manual' }]);
      return query(options.reviewRows || []);
    } }),
    transaction: async fn => fn(db),
  };
  const svc = {
    getById: async () => issue,
    getByIdForUpdate: async () => ({ ...issue, ...options.lockedIssue }),
    getDependencyReadiness: async () => ({ unresolvedBlockerCount: options.blockers ? 1 : 0, unresolvedBlockerIssueIds: options.blockers ? ['dependency'] : [] }),
    assertCheckoutOwner: async () => { if (options.checkoutConflict) throw errors.conflict('Issue run ownership conflict'); return {}; },
    update: async (id, data) => {
      // Service persistence is a fixture, NOT a claim of real SQL/HTTP integration.
      // Execute the real commit-time cancellation authority function independently.
      const runDb = { select: () => query([{ status: options.revoked ? 'cancelled' : 'running', resultJson: null }]) };
      await sandbox.assertAgentRunWriteAllowed(runDb, issue.companyId, { agentId: data.actorAgentId, runId: data.actorRunId, stopId: data.actorRunStopId });
      calls.persisted.push({ ...data }); return { ...issue, ...data };
    },
  };
  const sandbox = {
    ...errors, ...policy, randomUUID, db, svc, eq, and,
    heartbeatRuns: table('heartbeatRuns'), activityLog: table('activityLog'),
    issues: table('issues'), issueWatchdogs: table('issueWatchdogs'),
    MAX_WATCHDOG_SCOPE_ANCESTRY_DEPTH: 100, TASK_WATCHDOG_ORIGIN_KIND: 'task_watchdog',
    decideIssueAccess: async () => ({ allowed: options.accessDenied !== true, reason: options.defaultOpen === false ? 'allow_assignee' : 'allow_visible_issue_write' }),
    denyIssueWrite: async (_req, response, _issue, code) => { response.status(403).json({ error: code }); return false; },
    issueWriteDenialCodeForDecision: () => 'issue_write_denied',
    access: { decide: async () => ({ allowed: options.override === true }) },
    actorIsLowTrustReview: async () => options.lowTrust === true,
    treeControlSvc: { getActivePauseHoldGate: async () => options.pause ? { holdId: 'hold', rootIssueId: 'root', mode: 'subtree' } : null },
    assertNoAgentHostWorkspaceCommandMutation: () => {}, collectIssueWorkspaceCommandPaths: () => [],
    issueWriteAuthorizationReason: () => 'fixture_access',
    normalizeIssueAssigneeAgentReference: async (_company, value) => value,
    assertIssueEnvironmentSelection: async () => {},
    recoveryActionsSvc: { getActiveForIssue: async () => options.recovery || null },
    getClosedIssueExecutionWorkspace: async () => null,
    assertCrossIssueInfluenceWithinRunCap: async () => { if (options.runCap) { res.status(403).json({ error: 'run influence cap' }); return false; } return true; },
    resolveActiveIssueRun: async () => ({ id: 'active-run', companyId: issue.companyId, agentId: issue.assigneeAgentId }),
    assertCanManageIssueMonitor: async () => {}, monitorPoliciesEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    isConversation: () => false,
    stopRunnerGoalForOwnershipChange: async () => null,
    guardReopenedWorkspaceConsumption: () => {},
    flushIssuePostCommitActions: async () => {}, publishActivity: () => {},
    logActivity: async (_db, event) => calls.activity.push(event),
    heartbeat: { cancelRun: async id => { calls.cancelled.push(id); return { id, companyId: issue.companyId, agentId: issue.assigneeAgentId }; } },
    logger: { warn: () => {} },
  };
  vm.createContext(sandbox);
  const load = (map, names) => { for (const name of names) { assert.ok(map.has(name), name); vm.runInContext(map.get(name), sandbox); } };
  load(authFunctions, ['assertAuthenticated', 'hasCompanyAccess', 'assertCompanyAccess', 'getAccessibleResource', 'getActorInfo']);
  load(runFunctions, ['agentRunWritesRevoked', 'assertAgentRunWriteAllowed']);
  load(reviewFunctions, ['resolveIssueReviewRequester', 'assertIssueReviewVerdictActorAllowed']);
  load(scopeFunctions, ['isPlainRecord', 'readString', 'readTaskWatchdogContext', 'resolveTaskWatchdogMutationScope', 'issueIsInTaskWatchdogSubtree', 'taskWatchdogScopeAllowsIssueMutation']);
  load(routeFunctions, ['requireAgentRunId', 'hasActiveCheckoutManagementOverride', 'isDefaultOpenIssueWriteDecision', 'assertAgentIssueMutationAllowed', 'assertLowTrustControlPlaneDenied', 'assertBoardCommentNotPaused', 'isClosedIssueStatus', 'isExplicitResumeCapableStatus', 'assertExplicitResumeIntentAllowed', 'requireRecoveryActionAuthority', 'activeExecutionParticipantAgentId', 'requireRecoverySourceMutationAuthority', 'shouldHumanCommentResumeInProgressScheduledRetry', 'isAssigneeSelfCommentOnTerminalIssue', 'shouldImplicitlyMoveCommentedIssueToTodo', 'assertInReviewReviewPath']);
  const run = vm.runInContext(`(async (req,res) => {${routeBody}\nreturn {issue,cancelledStatusRunId};})`, sandbox);
  return { issue, req, res, calls, sandbox, run: () => run(req, res) };
}
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

export {createHarness,outcome,routeFunctions,vm};
