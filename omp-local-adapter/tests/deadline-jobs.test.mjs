// R4-G3-RED: deadline diagnostics must list admitted-but-undelivered background jobs.
// Independently synthetic admission / async-result events: admission =
// tool_execution_end result.details.async{state,jobId}; completion = custom
// message customType=async-result details.jobs[]{jobId,status,durationMs,label}.
// Frozen contract: resultJson.diagnostics.undeliveredJobs = [{ jobId, state|admittedAt, ... }]
// listing only jobs admitted without a completion notice, never job output or secrets.
// J1/J2 are RED against index.mjs 3c2fb50b…; J3/J4 guard the current classification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTER_TYPE, createServerAdapter } from "./adapter-fixture.mjs";

const BODY_MARKER = "C_SYNTHETIC_JOB_OUTPUT_BODY";
const SECRET_MARKER = "SECRET-deadline-jobs";

const line = (obj) => `${JSON.stringify(obj)}\n`;
const assistant = (text, extra = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "anthropic",
  model: "claude-test",
  usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 21, cost: { total: 0.0123 } },
  stopReason: "stop",
  timestamp: 1,
  ...extra,
});
const SESSION_HEADER = { type: "session", version: 3, id: "omp-session-dj", timestamp: "2026-10-15T00:00:00Z", cwd: "/probe/omp-dj" };

const admission = (jobId, callId) => [
  line({ type: "tool_execution_start", toolCallId: callId, toolName: "bash", args: { command: `run_suite.sh --token ${SECRET_MARKER}` } }),
  line({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: "bash",
    result: {
      content: [{ type: "text", text: `Synthetic background admission for ${jobId}; synthetic deadline 60 seconds.` }],
      details: { async: { state: "running", jobId, type: "bash" }, timeoutSeconds: 60 },
    },
    isError: false,
  }),
].join("");

const completion = (jobId) => {
  const message = {
    role: "custom",
    customType: "async-result",
    content: `<system-notice>\nBackground job ${jobId} has completed. Resume your work using the result below.\n${BODY_MARKER} ${SECRET_MARKER}\nWall time: 1.25 seconds\n</system-notice>`,
    display: true,
    attribution: "agent",
    details: {
      meta: { source: { type: "report", value: "background job delivery" } },
      jobs: [{ jobId, type: "bash", status: "completed", label: `C_SYNTHETIC_JOB_LABEL ${SECRET_MARKER}`, durationMs: 1250 }],
    },
    timestamp: 946684800000,
  };
  return line({ type: "message_start", message }) + line({ type: "message_end", message });
};

const stdoutFor = (msg, middle = "") =>
  line(SESSION_HEADER) +
  line({ type: "agent_start" }) +
  line({ type: "turn_start" }) +
  middle +
  line({ type: "message_end", message: msg }) +
  line({ type: "turn_end", message: msg, toolResults: [] }) +
  line({ type: "agent_end", messages: [msg], isTerminal: true, yielded: true });

const deadlineMsg = () => assistant("partial work", { stopReason: "aborted", errorMessage: "Deadline exceeded" });

const WORKDIR = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.TMPDIR ?? os.tmpdir(), "omp-deadline-jobs-test-"));
process.on("exit", () => rmSync(WORKDIR, { recursive: true, force: true }));

function baseCtx() {
  const scratchDir = mkdtempSync(path.join(WORKDIR, "run-scratch-"));
  return {
    runId: "run-deadline-jobs-1",
    agent: { id: "agent-1", companyId: "co-1", name: "OMP", adapterType: ADAPTER_TYPE, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: "/probe/omp-dj", timeoutSec: 120, graceSec: 5, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir } },
    context: {
      taskId: "iss_dj",
      issueId: "iss_dj",
      wakeReason: "issue_assigned",
      paperclipWake: { reason: "issue_assigned", issue: { id: "iss_dj", identifier: "LAB-10", title: "Deadline jobs", status: "todo" } },
      paperclipScratch: { type: "heartbeat_run", dir: scratchDir },
    },
    authToken: `eyJhbGciOiJIUzI1NiJ9.run-jwt-${SECRET_MARKER}`,
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  };
}

async function run({ stdout, exitCode }) {
  const runChildProcess = async (_runId, _command, _args, opts) => {
    await opts.onSpawn?.({ pid: 4343, processGroupId: 4343, startedAt: new Date().toISOString() });
    await opts.onLog("stdout", stdout);
    return { exitCode, signal: null, timedOut: false, stdout, stderr: "", pid: 4343, startedAt: new Date().toISOString() };
  };
  return createServerAdapter({ runChildProcess, statPath: async () => ({ isDirectory: () => true }) }).execute(baseCtx());
}

test("J1 RED: deadline with an admitted, undelivered background job lists it in diagnostics without body/secrets", async () => {
  const result = await run({ stdout: stdoutFor(deadlineMsg(), admission("bg_1", "toolu_dj_1")), exitCode: 1 });
  assert.equal(result.errorCode, "omp_deadline_exceeded");
  const jobs = result.resultJson?.diagnostics?.undeliveredJobs;
  assert.ok(Array.isArray(jobs), "diagnostics.undeliveredJobs must be an array on deadline with pending background jobs");
  assert.deepEqual(jobs.map((j) => j.jobId), ["bg_1"]);
  assert.ok("state" in jobs[0] || "admittedAt" in jobs[0], "each undelivered job carries its admission state or admission time");
  const serialized = JSON.stringify(result.resultJson.diagnostics);
  assert.ok(!serialized.includes(SECRET_MARKER), "diagnostics must not leak command text or secrets");
  assert.ok(!serialized.includes(BODY_MARKER), "diagnostics must not carry job output");
});

test("J2 RED: a job whose async-result completion arrived is not listed as undelivered", async () => {
  const middle = admission("bg_1", "toolu_dj_1") + admission("bg_2", "toolu_dj_2") + completion("bg_1");
  const result = await run({ stdout: stdoutFor(deadlineMsg(), middle), exitCode: 1 });
  assert.equal(result.errorCode, "omp_deadline_exceeded");
  const jobs = result.resultJson?.diagnostics?.undeliveredJobs;
  assert.ok(Array.isArray(jobs), "diagnostics.undeliveredJobs must list the still-pending job");
  assert.deepEqual(jobs.map((j) => j.jobId), ["bg_2"], "completed bg_1 must not be listed; pending bg_2 must be");
  const serialized = JSON.stringify(result.resultJson.diagnostics);
  assert.ok(!serialized.includes(SECRET_MARKER));
  assert.ok(!serialized.includes(BODY_MARKER));
});

test("J3 guard: deadline without background jobs adds no undeliveredJobs noise and keeps errorCode/deadline shape", async () => {
  const result = await run({ stdout: stdoutFor(deadlineMsg()), exitCode: 1 });
  assert.equal(result.errorCode, "omp_deadline_exceeded");
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.resultJson.diagnostics.deadline, { source: "omp_max_time", nativeTimerFired: false });
  assert.ok(!("undeliveredJobs" in result.resultJson.diagnostics), "no background job -> no undeliveredJobs key");
});

test("J4 guard: non-deadline failure with a pending background job keeps its classification", async () => {
  const result = await run({ stdout: stdoutFor(assistant("done"), admission("bg_1", "toolu_dj_1")), exitCode: 2 });
  assert.equal(result.errorCode, "omp_exit_nonzero");
  assert.equal(result.timedOut, false);
  assert.ok(!("deadline" in result.resultJson.diagnostics), "non-deadline failure must not gain deadline diagnostics");
});
