// MODEL-T: frozen RED tests for per-agent default model selection in omp_local.
// Offline only: the native runner is injected; no real OMP, model call or Paperclip server.
// Contract frozen here (MODEL-F must satisfy it without editing this file):
//   adapter.models (array) and/or adapter.listModels() -> array, [] when discovery is unavailable
//   adapter.getConfigSchema() -> schema with a free-text `model` field (no enum-only lock)
//   resultJson.modelSelection = { requestedModel, source, actualModel, mismatch }
//     source: "inherited_omp_default" when config.model is unset, "agent_config" when set.
//   Unknown model id (absent from a non-empty discovered list) fails closed before spawn
//     with errorCode "omp_model_unavailable".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTER_TYPE, createServerAdapter } from "./adapter-fixture.mjs";

const WORKDIR = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "omp-model-test-"));
process.on("exit", () => rmSync(WORKDIR, { recursive: true, force: true }));

const line = (o) => `${JSON.stringify(o)}\n`;
const assistant = (model) => ({
  role: "assistant",
  content: [{ type: "text", text: "ok" }],
  provider: "anthropic",
  model,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  stopReason: "stop",
  timestamp: 1,
});
const okStdout = (model = "claude-test") =>
  line({ type: "session", version: 3, id: "s1", timestamp: "2026-10-15T00:00:00Z", cwd: WORKDIR }) +
  line({ type: "agent_start" }) +
  line({ type: "message_end", message: assistant(model) }) +
  line({ type: "agent_end", messages: [assistant(model)] });

function ctxWith(configExtra = {}) {
  const scratchDir = mkdtempSync(path.join(WORKDIR, "scratch-"));
  return {
    runId: "run-m",
    agent: { id: "agent-m", companyId: "co-1", name: "OMP", adapterType: ADAPTER_TYPE, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: WORKDIR, timeoutSec: 120, graceSec: 5, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir }, ...configExtra },
    context: {
      taskId: "iss_m",
      issueId: "iss_m",
      wakeReason: "issue_assigned",
      paperclipWake: { reason: "issue_assigned", issue: { id: "iss_m", identifier: "LAB-9", title: "t", status: "todo" } },
      paperclipScratch: { type: "heartbeat_run", dir: scratchDir },
    },
    authToken: "tok-SECRET-model-test-0123456789",
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  };
}

function runner(model = "claude-test") {
  const calls = [];
  const run = async (runId, command, args, opts) => {
    calls.push({ command, args });
    await opts.onSpawn?.({ pid: 1, processGroupId: 1, startedAt: "2026-10-15T00:00:00Z" });
    const stdout = okStdout(model);
    await opts.onLog("stdout", stdout);
    return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 1, startedAt: "2026-10-15T00:00:00Z" };
  };
  return { run, calls };
}

const KNOWN = [{ id: "claude-test", label: "claude-test" }, { id: "anthropic/claude-opus-5-5", label: "opus" }];
function adapterWith(r, extra = {}) {
  return createServerAdapter({
    runChildProcess: r.run,
    readOmpSkillBaseline: async () => null,
    listOmpModels: async () => KNOWN,
    ...extra,
  });
}
const modelArg = (args) => {
  const i = args.indexOf("--model");
  return i === -1 ? undefined : args[i + 1];
};

test("M1 adapter exposes model discovery and a free-text model config field", async () => {
  const a = adapterWith(runner());
  assert.ok(Array.isArray(a.models) || typeof a.listModels === "function", "models or listModels must exist");
  assert.equal(typeof a.getConfigSchema, "function", "getConfigSchema must exist");
  const schema = await a.getConfigSchema();
  const text = JSON.stringify(schema);
  assert.match(text, /"model"/, "schema must declare a model field");
  const fields = schema?.fields ?? schema?.properties ?? schema;
  const field = Array.isArray(fields) ? fields.find((f) => f.key === "model" || f.name === "model") : fields?.model;
  assert.ok(field, "model field locatable");
  assert.ok(!Array.isArray(field.enum) || field.allowCustom === true || field.freeText === true, "model must allow free-text ids");
});

test("M1b listModels returns [] (never throws) when OMP model discovery is unavailable", async () => {
  const a = adapterWith(runner(), { listOmpModels: async () => { throw new Error("omp unavailable"); } });
  assert.equal(typeof a.listModels, "function", "listModels must exist");
  assert.deepEqual(await a.listModels(), []);
});

test("M2 unset model: no --model argv and resultJson marks inherited_omp_default", async () => {
  const r = runner();
  const res = await adapterWith(r).execute(ctxWith());
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].args.includes("--model"), false);
  assert.equal(res.resultJson?.modelSelection?.source, "inherited_omp_default");
  assert.equal(res.resultJson?.modelSelection?.requestedModel, null);
});

test("M3 explicit id is passed verbatim as --model", async () => {
  const r = runner("claude-opus-5-5");
  const res = await adapterWith(r).execute(ctxWith({ model: "anthropic/claude-opus-5-5" }));
  assert.equal(r.calls.length, 1);
  assert.equal(modelArg(r.calls[0].args), "anthropic/claude-opus-5-5");
  assert.equal(r.calls[0].args.filter((x) => x === "--model").length, 1);
  assert.equal(res.resultJson?.modelSelection?.source, "agent_config");
});

test("M4 unknown id (absent from discovered list) fails closed with zero spawn", async () => {
  const r = runner();
  const res = await adapterWith(r).execute(ctxWith({ model: "no-such-model-xyz" }));
  assert.equal(r.calls.length, 0, "must not spawn OMP for an unknown model id");
  assert.equal(res.errorCode, "omp_model_unavailable");
});

test("M4b syntactically invalid id stays refused before spawn (guard)", async () => {
  const r = runner();
  const res = await adapterWith(r).execute(ctxWith({ model: "bad model;rm" }));
  assert.equal(r.calls.length, 0);
  assert.ok(res.errorCode, "must carry an error code");
});

test("M5 resultJson separates requestedModel / actualModel and flags mismatch", async () => {
  const r = runner("claude-test");
  const res = await adapterWith(r).execute(ctxWith({ model: "anthropic/claude-opus-5-5" }));
  const sel = res.resultJson?.modelSelection;
  assert.ok(sel, "modelSelection present");
  assert.equal(sel.requestedModel, "anthropic/claude-opus-5-5");
  assert.match(String(sel.actualModel), /claude-test/);
  assert.equal(sel.mismatch, true);

  const r2 = runner("claude-test");
  const res2 = await adapterWith(r2).execute(ctxWith({ model: "claude-test" }));
  assert.equal(res2.resultJson?.modelSelection?.mismatch, false);
});
