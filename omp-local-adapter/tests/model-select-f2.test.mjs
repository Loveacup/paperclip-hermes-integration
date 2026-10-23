// MODEL-F2: F1 provider-aware model match, F2 `omp models` child env without PAPERCLIP_*.
// Offline only: native runner and node:child_process.spawn are faked; no real OMP or Paperclip server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { ADAPTER_TYPE, createServerAdapter } from "./adapter-fixture.mjs";

const WORKDIR = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "omp-model-f2-"));
process.on("exit", () => rmSync(WORKDIR, { recursive: true, force: true }));

const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (provider, model) => ({
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  provider,
  model,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  stopReason: "stop",
  timestamp: 1,
});
const okStdout = (provider, model) =>
  line({ type: "session", version: 3, id: "s1", timestamp: "2026-10-15T00:00:00Z", cwd: WORKDIR }) +
  line({ type: "agent_start" }) +
  line({ type: "message_end", message: assistant(provider, model) }) +
  line({ type: "agent_end", messages: [assistant(provider, model)] });

function ctxWith(model) {
  const scratchDir = mkdtempSync(path.join(WORKDIR, "scratch-"));
  return {
    runId: "run-f2",
    agent: { id: "agent-f2", companyId: "co-1", name: "OMP", adapterType: ADAPTER_TYPE, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: WORKDIR, timeoutSec: 120, graceSec: 5, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir }, model },
    context: {
      taskId: "iss_f2",
      issueId: "iss_f2",
      wakeReason: "issue_assigned",
      paperclipWake: { reason: "issue_assigned", issue: { id: "iss_f2", identifier: "LAB-10", title: "t", status: "todo" } },
      paperclipScratch: { type: "heartbeat_run", dir: scratchDir },
    },
    authToken: "tok-SECRET-model-f2-0123456789",
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  };
}

// Runs one heartbeat where OMP reports `provider/model` as the actual model; returns modelSelection.
async function selectionFor(requested, provider, model) {
  const adapter = createServerAdapter({
    runChildProcess: async (runId, command, args, opts) => {
      await opts.onSpawn?.({ pid: 1, processGroupId: 1, startedAt: "2026-10-15T00:00:00Z" });
      const stdout = okStdout(provider, model);
      await opts.onLog("stdout", stdout);
      return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 1, startedAt: "2026-10-15T00:00:00Z" };
    },
    // [] = discovery unavailable, so explicit ids pass through to spawn (frozen M1b/MODEL-F contract).
    listOmpModels: async () => [],
  });
  const res = await adapter.execute(ctxWith(requested));
  assert.equal(res.resultJson?.modelSelection?.actualModel, `${provider}/${model}`);
  return res.resultJson.modelSelection;
}

test("F1 provider-qualified request served by a different provider is a mismatch", async () => {
  const sel = await selectionFor("openai/claude-test", "anthropic", "claude-test");
  assert.equal(sel.requestedModel, "openai/claude-test");
  assert.equal(sel.mismatch, true);
});

test("F1 provider-qualified request matches only the exact provider/model", async () => {
  assert.equal((await selectionFor("anthropic/claude-test", "anthropic", "claude-test")).mismatch, false);
  assert.equal((await selectionFor("anthropic/claude-other", "anthropic", "claude-test")).mismatch, true);
});

test("F1 bare id matches the actual model's last segment under any provider", async () => {
  assert.equal((await selectionFor("claude-test", "anthropic", "claude-test")).mismatch, false);
  assert.equal((await selectionFor("claude-test", "openai", "claude-test")).mismatch, false);
  assert.equal((await selectionFor("claude-tes", "anthropic", "claude-test")).mismatch, true);
});

test("F2 `omp models` child env drops every PAPERCLIP_* key and keeps the rest", async (t) => {
  process.env.PAPERCLIP_F2_PROBE_SECRET = "must-not-leak";
  process.env.PAPERCLIP_API_KEY = "must-not-leak-either";
  process.env.F2_PROVIDER_CONFIG = "keep-me";
  const calls = [];
  const realSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, opts) => {
    calls.push({ command, args, opts });
    const child = new EventEmitter();
    child.exitCode = null;
    child.stdout = new EventEmitter();
    child.stdout.destroy = () => {};
    child.unref = () => {};
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("anthropic/claude-x  Claude X\n"));
      child.exitCode = 0;
      child.emit("close", 0);
    });
    return child;
  };
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.spawn = realSpawn;
    syncBuiltinESMExports();
  });

  // No listOmpModels dep: exercises the default `omp models` probe.
  const list = await createServerAdapter({ readOmpSkillBaseline: async () => null }).listModels();
  assert.equal(calls.length, 1, "default discovery spawns exactly one probe");
  const { command, args, opts } = calls[0];
  assert.deepEqual(args, ["models"]);
  assert.equal(opts.shell, false);
  assert.ok(opts.env && typeof opts.env === "object", "spawn must receive an explicit env");
  assert.deepEqual(Object.keys(opts.env).filter((k) => k.startsWith("PAPERCLIP_")), []);
  assert.equal(opts.env.HOME, process.env.HOME);
  assert.equal(opts.env.PATH, process.env.PATH);
  assert.equal(opts.env.F2_PROVIDER_CONFIG, "keep-me");
  assert.ok(typeof command === "string" && command.length > 0);
  assert.deepEqual(list.map((m) => m.id), ["anthropic/claude-x"]);
});
