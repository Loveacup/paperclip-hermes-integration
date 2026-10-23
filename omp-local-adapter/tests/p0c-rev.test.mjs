import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createServerAdapter } from './adapter-fixture.mjs';
const root = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR, 'review-regression-v1-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
let seq = 0;
function context({ scratch, desired = [], signal } = {}) {
  const cwd = path.join(root, `cwd-${++seq}`); mkdirSync(cwd);
  return { runId: `review-${seq}`, agent: { id: 'review-agent', companyId: 'review-company', name: 'review', adapterType: 'omp_local', adapterConfig: {} }, runtime: { sessionId: null, sessionParams: null },
    config: { cwd, timeoutSec: 60, graceSec: 5, env: scratch ? { PAPERCLIP_RUN_SCRATCH_DIR: scratch } : {}, paperclipSkillSync: { desiredSkills: desired } },
    context: { taskId: 'review-issue', issueId: 'review-issue', wakeReason: 'issue_assigned', paperclipWake: { reason: 'issue_assigned', issue: { id: 'review-issue', identifier: 'REVIEW-1', title: 'Review probe', status: 'in_progress' } }, ...(scratch ? { paperclipScratch: { type: 'heartbeat_run', dir: scratch } } : {}) }, signal,
    onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {} };
}
function fake() {
  const calls = [];
  return { calls, run: async (_id, _cmd, args, opts) => { calls.push({ hasOverlay: args.includes('--config'), hasTmpdir: typeof opts.env.TMPDIR === 'string' }); await opts.onSpawn?.({ pid: 1, processGroupId: 1 }); return { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }] }) + '\n', stderr: '' }; } };
}
test('p0c-rev: REV-R1: missing scratch with empty desired must refuse before dispatch (D1a/g)', async () => {
  const r = fake(); const result = await createServerAdapter({ runChildProcess: r.run }).execute(context());
  console.log(JSON.stringify({ case: 'R1', calls: r.calls.length, errorCode: result.errorCode ?? null, observed: r.calls }));
  assert.equal(r.calls.length, 0); assert.equal(result.errorCode, 'omp_skills_scratch_missing');
});
test('p0c-rev: REV-R1b: mismatched scratch with empty desired must refuse before dispatch (D1g)', async () => {
  const scratch = path.join(root, 'mismatch-scratch'); mkdirSync(scratch);
  const ctx = context({ scratch }); ctx.context.paperclipScratch.dir = root;
  const r = fake(); const result = await createServerAdapter({ runChildProcess: r.run }).execute(ctx);
  console.log(JSON.stringify({ case: 'R1b', calls: r.calls.length, errorCode: result.errorCode ?? null, observed: r.calls }));
  assert.equal(r.calls.length, 0); assert.equal(result.errorCode, 'omp_skills_scratch_missing');
});
test('p0c-rev: REV-R2: cancellation during preparation must not dispatch and must clean staging (D1d)', async () => {
  const scratch = path.join(root, 'cancel-scratch'); mkdirSync(scratch);
  const source = path.join(root, 'source'); mkdirSync(source); writeFileSync(path.join(source, 'SKILL.md'), '---\nname: alpha\ndescription: Review fixture.\n---\nBody.\n');
  const ac = new AbortController(); const ctx = context({ scratch, desired: ['review/alpha'], signal: ac.signal });
  ctx.config.paperclipRuntimeSkills = [{ key: 'review/alpha', runtimeName: 'alpha', source, versionId: 'v1', currentVersionId: 'v1', sourceStatus: 'available' }];
  const r = fake(); const ad = createServerAdapter({ runChildProcess: r.run, readOmpSkillBaseline: async () => { ac.abort(); return { trusted: true, config: { skills: { customDirectories: [] } } }; } });
  const result = await ad.execute(ctx);
  console.log(JSON.stringify({ case: 'R2', aborted: ac.signal.aborted, calls: r.calls.length, errorCode: result.errorCode ?? null, remainingStaging: readdirSync(scratch) }));
  assert.deepEqual(readdirSync(scratch), []); assert.equal(r.calls.length, 0); assert.equal(result.errorCode, 'omp_cancelled_before_spawn');
});
// --- P0-C1-R3 additions (contract P0-C-R3-v1): onMeta-0 expectations for R1/R1b, and R2b (abort inside ctx.onMeta).
test('p0c-rev: R1-meta: missing scratch with empty desired must not emit onMeta', async () => {
  const ctx = context(); let metas = 0; ctx.onMeta = async () => { metas++; };
  const r = fake(); const result = await createServerAdapter({ runChildProcess: r.run }).execute(ctx);
  assert.equal(metas, 0); assert.equal(r.calls.length, 0); assert.equal(result.errorCode, 'omp_skills_scratch_missing');
});
test('p0c-rev: R1b-meta: mismatched scratch with empty desired must not emit onMeta', async () => {
  const scratch = path.join(root, 'mismatch-scratch-meta'); mkdirSync(scratch);
  const ctx = context({ scratch }); ctx.context.paperclipScratch.dir = root; let metas = 0; ctx.onMeta = async () => { metas++; };
  const r = fake(); const result = await createServerAdapter({ runChildProcess: r.run }).execute(ctx);
  assert.equal(metas, 0); assert.equal(r.calls.length, 0); assert.equal(result.errorCode, 'omp_skills_scratch_missing');
});
test('p0c-rev: R2b: cancellation inside ctx.onMeta must not dispatch and must clean staging', async () => {
  const scratch = path.join(root, 'meta-cancel-scratch'); mkdirSync(scratch);
  const source = path.join(root, 'source-r2b'); mkdirSync(source); writeFileSync(path.join(source, 'SKILL.md'), '---\nname: alpha\ndescription: Review fixture.\n---\nBody.\n');
  const ac = new AbortController(); const ctx = context({ scratch, desired: ['review/alpha'], signal: ac.signal });
  ctx.config.paperclipRuntimeSkills = [{ key: 'review/alpha', runtimeName: 'alpha', source, versionId: 'v1', currentVersionId: 'v1', sourceStatus: 'available' }];
  ctx.onMeta = async () => { ac.abort(); };
  const r = fake(); const ad = createServerAdapter({ runChildProcess: r.run, readOmpSkillBaseline: async () => ({ trusted: true, config: { skills: { customDirectories: [] } } }) });
  const result = await ad.execute(ctx);
  assert.equal(ac.signal.aborted, true); assert.deepEqual(readdirSync(scratch), []); assert.equal(r.calls.length, 0); assert.equal(result.errorCode, 'omp_cancelled_before_spawn');
});
