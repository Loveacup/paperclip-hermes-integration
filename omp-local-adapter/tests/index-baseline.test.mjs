import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createServerAdapter, OMP_COMMAND } from "./adapter-fixture.mjs";

const root = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.TMPDIR ?? "/tmp", "index-baseline-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let seq = 0;

function context() {
  const n = ++seq;
  const cwd = path.join(root, `cwd-${n}`); mkdirSync(cwd);
  const scratch = path.join(root, `scratch-${n}`); mkdirSync(scratch);
  const source = path.join(root, `source-${n}`); mkdirSync(source);
  writeFileSync(path.join(source, "SKILL.md"), "---\nname: alpha\ndescription: Baseline fixture.\n---\nBody.\n");
  return {
    runId: `baseline-${n}`,
    agent: { id: "agent-b", companyId: "co-b", name: "b", adapterType: "omp_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null },
    config: { cwd, timeoutSec: 60, graceSec: 5, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratch, BASELINE_PROBE: "from-config" },
      paperclipSkillSync: { desiredSkills: ["b/alpha"] },
      paperclipRuntimeSkills: [{ key: "b/alpha", runtimeName: "alpha", source, versionId: "v1", currentVersionId: "v1", sourceStatus: "available" }] },
    context: { taskId: "iss-b", issueId: "iss-b", wakeReason: "issue_assigned",
      paperclipWake: { reason: "issue_assigned", issue: { id: "iss-b", identifier: "B-1", title: "Baseline", status: "in_progress" } },
      paperclipScratch: { type: "heartbeat_run", dir: scratch } },
    onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {},
  };
}

function spawner() {
  const spawns = [];
  return { spawns, run: async (_id, cmd, args, opts) => {
    const i = args.indexOf("--config");
    const overlay = i >= 0 ? JSON.parse(readFileSync(args[i + 1], "utf8")) : null;
    spawns.push({ cmd, cwd: opts.cwd, env: { ...opts.env }, overlay });
    await opts.onSpawn?.({ pid: 1, processGroupId: 1 });
    return { exitCode: 0, signal: null, timedOut: false, stderr: "",
      stdout: JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }] }) + "\n" };
  } };
}

function baselineCommand(stdoutValue) {
  const calls = [];
  return { calls, run: async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts.cwd, env: { ...opts.env } });
    if (stdoutValue === null) return { exitCode: 1, stdout: "", timedOut: false, overflow: false };
    return { exitCode: 0, stdout: JSON.stringify({ key: "skills.customDirectories", value: stdoutValue, type: "array" }), timedOut: false, overflow: false };
  } };
}

test("index-baseline: default reader gets the spawn command, cwd and env", async () => {
  const ctx = context(); const s = spawner(); const b = baselineCommand(["/base/a"]);
  const result = await createServerAdapter({ runChildProcess: s.run, runOmpBaselineCommand: b.run }).execute(ctx);
  assert.notEqual(result.errorCode, "omp_skills_baseline_untrusted");
  assert.equal(b.calls.length, 1); assert.equal(s.spawns.length, 1);
  assert.equal(b.calls[0].cmd, OMP_COMMAND); assert.equal(b.calls[0].cmd, s.spawns[0].cmd);
  assert.equal(b.calls[0].cwd, ctx.config.cwd); assert.equal(b.calls[0].cwd, s.spawns[0].cwd);
  assert.equal(b.calls[0].env.BASELINE_PROBE, "from-config");
  assert.deepEqual(b.calls[0].env, s.spawns[0].env);
});

test("index-baseline: untrusted baseline refuses with zero spawns", async () => {
  const ctx = context(); const s = spawner(); const b = baselineCommand(null);
  const result = await createServerAdapter({ runChildProcess: s.run, runOmpBaselineCommand: b.run }).execute(ctx);
  assert.equal(b.calls.length, 1); assert.equal(s.spawns.length, 0);
  assert.equal(result.errorCode, "omp_skills_baseline_untrusted");
  assert.deepEqual(readdirSync(ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR), []);
});

test("index-baseline: trusted baseline is preserved before the staged skills dir", async () => {
  const ctx = context(); const s = spawner(); const b = baselineCommand(["/base/a", "/base/b"]);
  const result = await createServerAdapter({ runChildProcess: s.run, runOmpBaselineCommand: b.run }).execute(ctx);
  assert.notEqual(result.errorCode, "omp_skills_baseline_untrusted"); assert.equal(s.spawns.length, 1);
  const dirs = s.spawns[0].overlay.skills.customDirectories;
  assert.equal(dirs.length, 3); assert.deepEqual(dirs.slice(0, 2), ["/base/a", "/base/b"]);
  assert.ok(dirs[2].startsWith(ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR) && dirs[2].endsWith("skills"));
});
