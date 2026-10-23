// DL-RED: OMP's own --max-time stops the
// agent loop immediately, leaving zero write-back margin. The adapter must expose the authoritative
// absolute deadline to the OMP child so a later contract can save partial work before it.
// D1/D2 are RED against index.mjs e3fa8394…; D3-D5 guard the frozen timeout/deadline contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTER_TYPE, createServerAdapter } from "./adapter-fixture.mjs";

const DEADLINE_KEY = "OMP_PAPERCLIP_DEADLINE_AT";
const TIMEOUT_SEC = 120;
const GRACE_SEC = 5;
const TOLERANCE_MS = 2000;
const ISO_UTC_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

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
const SESSION_HEADER = { type: "session", version: 3, id: "omp-session-dl", timestamp: "2026-10-14T00:00:00Z", cwd: "/probe/omp-dl" };
const stdoutFor = (msg) =>
  line(SESSION_HEADER) +
  line({ type: "agent_start" }) +
  line({ type: "turn_start" }) +
  line({ type: "message_end", message: msg }) +
  line({ type: "turn_end", message: msg, toolResults: [] }) +
  line({ type: "agent_end", messages: [msg], isTerminal: true, yielded: true });

const WORKDIR = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.TMPDIR ?? os.tmpdir(), "omp-deadline-test-"));
process.on("exit", () => rmSync(WORKDIR, { recursive: true, force: true }));

function baseCtx(extraEnv = {}) {
  const scratchDir = mkdtempSync(path.join(WORKDIR, "run-scratch-"));
  return {
    runId: "run-deadline-1",
    agent: { id: "agent-1", companyId: "co-1", name: "OMP", adapterType: ADAPTER_TYPE, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: "/probe/omp-dl", timeoutSec: TIMEOUT_SEC, graceSec: GRACE_SEC, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir, ...extraEnv } },
    context: {
      taskId: "iss_dl",
      issueId: "iss_dl",
      wakeReason: "issue_assigned",
      paperclipWake: { reason: "issue_assigned", issue: { id: "iss_dl", identifier: "LAB-9", title: "Deadline", status: "todo" } },
      paperclipScratch: { type: "heartbeat_run", dir: scratchDir },
    },
    authToken: "eyJhbGciOiJIUzI1NiJ9.run-jwt-SECRET-deadline",
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  };
}

// Records the exact spawn request; "spawn前时刻" is taken right before execute and at runChildProcess entry.
async function runCapture(script = {}, extraEnv = {}) {
  const calls = [];
  const runChildProcess = async (runId, command, args, opts) => {
    calls.push({ atMs: Date.now(), command, args, opts });
    await opts.onSpawn?.({ pid: 4242, processGroupId: 4242, startedAt: new Date().toISOString() });
    const stdout = script.stdout ?? stdoutFor(assistant("All done."));
    await opts.onLog("stdout", stdout);
    return { exitCode: "exitCode" in script ? script.exitCode : 0, signal: null, timedOut: script.timedOut ?? false, stdout, stderr: "", pid: 4242, startedAt: new Date().toISOString() };
  };
  const beforeMs = Date.now();
  const result = await createServerAdapter({ runChildProcess, statPath: async () => ({ isDirectory: () => true }) }).execute(baseCtx(extraEnv));
  return { beforeMs, calls, result };
}

function assertAuthoritativeDeadline(beforeMs, call) {
  const raw = call.opts.env?.[DEADLINE_KEY];
  assert.equal(typeof raw, "string", `${DEADLINE_KEY} must be set on the spawn env`);
  assert.match(raw, ISO_UTC_Z, `${DEADLINE_KEY} must be ISO-8601 UTC ending in Z: ${raw}`);
  const at = Date.parse(raw);
  assert.ok(Number.isFinite(at), `${DEADLINE_KEY} must parse: ${raw}`);
  const expectedLo = beforeMs + TIMEOUT_SEC * 1000 - TOLERANCE_MS;
  const expectedHi = call.atMs + TIMEOUT_SEC * 1000 + TOLERANCE_MS;
  assert.ok(at >= expectedLo && at <= expectedHi, `${raw} must equal pre-spawn + timeoutSec (±2s)`);
  assert.ok(at < beforeMs + (TIMEOUT_SEC + GRACE_SEC) * 1000, `${raw} must be strictly before the native backstop (timeoutSec+graceSec)`);
}

test("D1 RED: spawn env carries OMP_PAPERCLIP_DEADLINE_AT = pre-spawn + timeoutSec, ISO UTC Z, before native backstop", async () => {
  const { beforeMs, calls } = await runCapture();
  assert.equal(calls.length, 1, "execute must spawn exactly once");
  assertAuthoritativeDeadline(beforeMs, calls[0]);
});

test("D2 RED: config.env OMP_PAPERCLIP_DEADLINE_AT cannot override the adapter's authoritative value", async () => {
  const forged = "2099-01-01T00:00:00.000Z";
  const { beforeMs, calls } = await runCapture({}, { [DEADLINE_KEY]: forged });
  assert.equal(calls.length, 1, "execute must still spawn once with the authoritative value");
  assert.notEqual(calls[0].opts.env?.[DEADLINE_KEY], forged, "config.env must not win");
  assertAuthoritativeDeadline(beforeMs, calls[0]);
});

test("D3 guard: --max-time stays String(timeoutSec); native timeoutSec stays timeoutSec+graceSec", async () => {
  const { calls } = await runCapture();
  assert.equal(calls.length, 1);
  const { args, opts } = calls[0];
  const i = args.indexOf("--max-time");
  assert.ok(i >= 0, "--max-time must be passed");
  assert.equal(args[i + 1], String(TIMEOUT_SEC));
  assert.equal(opts.timeoutSec, TIMEOUT_SEC + GRACE_SEC);
  assert.equal(opts.graceSec, GRACE_SEC);
});

test("D4 guard (synthetic deadline shape): exit 1, final aborted 'Deadline exceeded', no damage -> omp_deadline_exceeded, timedOut=false", async () => {
  const msg = assistant("partial work", { stopReason: "aborted", errorMessage: "Deadline exceeded" });
  const { result } = await runCapture({ stdout: stdoutFor(msg), exitCode: 1, timedOut: false });
  assert.equal(result.errorCode, "omp_deadline_exceeded");
  assert.equal(result.timedOut, false);
});

test("D5 guard: exit 1 with errorMessage not exactly 'Deadline exceeded' -> omp_exit_nonzero (no duration inference)", async () => {
  for (const errorMessage of ["deadline exceeded", "Deadline exceeded.", " Deadline exceeded", "Request was aborted"]) {
    const msg = assistant("partial work", { stopReason: "aborted", errorMessage });
    const { result } = await runCapture({ stdout: stdoutFor(msg), exitCode: 1, timedOut: false });
    assert.equal(result.errorCode, "omp_exit_nonzero", `errorMessage=${JSON.stringify(errorMessage)}`);
    assert.equal(result.timedOut, false);
  }
});
