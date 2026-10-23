// BASE-ENV-T (BASE-ENV-01): the OMP skills-baseline reader must see the
// same effective env as the official runChildProcess spawn. A synthetic parent env runs in an
// isolated driver child (this file re-executed with DRIVER_FLAG), so process.env is never mutated
// here and the real HOME is never read. Only a fixed projection crosses back to the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DRIVER_FLAG = "--base-env-t-driver";
const MARKER_KEY = "ALEA110_SYNTHETIC_INHERITED";
const MARKER_VALUE = "synthetic-nonsecret";
const CANARY_KEY = "ALEA145_SYNTHETIC_CANARY_TOKEN";
const CANARY_VALUE = "synthetic-canary-not-a-secret";
const PROJECTION_KEYS = ["HOME", "PI_CONFIG_DIR", "PATH_nonEmpty", MARKER_KEY, "cwd"].sort();
// Projection printed by both runners' child; never the full env.
const PROJECT = `process.stdout.write(JSON.stringify({HOME:process.env.HOME??null,PI_CONFIG_DIR:process.env.PI_CONFIG_DIR??null,PATH_nonEmpty:typeof process.env.PATH==="string"&&process.env.PATH.length>0,${MARKER_KEY}:process.env.${MARKER_KEY}??null,cwd:process.cwd()}))`;

function parseProjection(stdout) {
  try { return JSON.parse(stdout); } catch { return { unparsable: true }; }
}

async function runDriver(root) {
  const { createServerAdapter } = await import("./adapter-fixture.mjs");
  const { defaultRunCommand } = await import("../omp-baseline.mjs");
  const { runChildProcess } = await import("@paperclipai/adapter-utils/server-utils");
  const cwd = path.join(root, "cwd"); mkdirSync(cwd);
  const scratch = path.join(root, "scratch"); mkdirSync(scratch);
  const source = path.join(root, "source"); mkdirSync(source);
  writeFileSync(path.join(source, "SKILL.md"), "---\nname: alpha\ndescription: Env fixture.\n---\nBody.\n");
  const ctx = {
    runId: "base-env-t",
    agent: { id: "agent-e", companyId: "co-e", name: "e", adapterType: "omp_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null },
    config: { cwd, timeoutSec: 60, graceSec: 5, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratch },
      paperclipSkillSync: { desiredSkills: ["e/alpha"] },
      paperclipRuntimeSkills: [{ key: "e/alpha", runtimeName: "alpha", source, versionId: "v1", currentVersionId: "v1", sourceStatus: "available" }] },
    context: { taskId: "iss-e", issueId: "iss-e", wakeReason: "issue_assigned",
      paperclipWake: { reason: "issue_assigned", issue: { id: "iss-e", identifier: "E-1", title: "Env", status: "in_progress" } },
      paperclipScratch: { type: "heartbeat_run", dir: scratch } },
    onLog: async () => {}, onMeta: async () => {}, onSpawn: async () => {},
  };

  // Path 1: index.mjs default baseline runner (omp-baseline defaultRunCommand) with the exact
  // cwd/env/limits index.mjs passes; only cmd/args swap OMP for the node projection (zero model CLI).
  let baseline = null;
  let mainSpawns = 0;
  const result = await createServerAdapter({
    runChildProcess: async () => { mainSpawns += 1; throw new Error("unexpected main spawn"); },
    runOmpBaselineCommand: async (_cmd, _args, opts) => {
      const r = await defaultRunCommand(process.execPath, ["-e", PROJECT], opts);
      baseline = r.exitCode === 0 ? parseProjection(r.stdout) : { exitCode: r.exitCode, timedOut: r.timedOut };
      return { exitCode: 1, stdout: "", timedOut: false, overflow: false };
    },
  }).execute(ctx);

  // Path 2: official adapter-utils runChildProcess, opts.env = PAPERCLIP_RUN_SCRATCH_DIR only.
  const official = await runChildProcess("base-env-t-official", process.execPath, ["-e", PROJECT], {
    cwd, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratch }, timeoutSec: 30, graceSec: 5, onLog: async () => {},
  });
  return {
    baseline,
    official: official.exitCode === 0 ? parseProjection(official.stdout) : { exitCode: official.exitCode },
    refusal: result?.errorCode ?? null,
    mainSpawns,
  };
}

if (process.argv[2] === DRIVER_FLAG) {
  let out;
  try { out = await runDriver(process.argv[3]); } catch (err) { out = { driverError: String(err?.code ?? err?.name ?? "error") }; }
  process.stdout.write(JSON.stringify(out), () => process.exit(0));
} else {
  const root = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.TMPDIR ?? "/tmp", "baseline-env-"));
  process.on("exit", () => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); mkdirSync(home);
  // Synthetic parent env: no inherited tokens, no real HOME.
  const parentEnv = { TMPDIR: process.env.TMPDIR, PAPERCLIP_RUN_SCRATCH_DIR: process.env.PAPERCLIP_RUN_SCRATCH_DIR, HOME: home, PATH: process.env.PATH ?? "", [MARKER_KEY]: MARKER_VALUE, [CANARY_KEY]: CANARY_VALUE };
  const driver = spawnSync(process.execPath, [fileURLToPath(import.meta.url), DRIVER_FLAG, root], {
    cwd: path.dirname(fileURLToPath(import.meta.url)), env: parentEnv, encoding: "utf8", timeout: 60000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const raw = typeof driver.stdout === "string" ? driver.stdout : "";
  const out = parseProjection(raw);

  test("base-env-t E1: default baseline runner env projection equals official runChildProcess", () => {
    assert.equal(out.driverError, undefined);
    assert.equal(out.mainSpawns, 0);
    assert.ok(out.baseline && !("exitCode" in out.baseline), "baseline runner produced a projection");
    assert.ok(out.official && !("exitCode" in out.official), "official runner produced a projection");
    assert.equal(out.official[MARKER_KEY], MARKER_VALUE);
    assert.equal(out.official.HOME, home);
    assert.deepEqual(out.baseline, out.official);
  });

  test("base-env-t E2: only projection keys cross back; no token or full env", () => {
    assert.ok(!raw.includes(CANARY_VALUE) && !raw.includes(CANARY_KEY));
    for (const side of ["baseline", "official"]) {
      const proj = out[side];
      if (!proj || "exitCode" in proj || proj.unparsable) continue;
      assert.deepEqual(Object.keys(proj).sort(), PROJECTION_KEYS);
      for (const value of Object.values(proj)) assert.ok(value === null || typeof value === "boolean" || typeof value === "string");
    }
    assert.deepEqual(Object.keys(out).sort(), ["baseline", "mainSpawns", "official", "refusal"]);
  });
}
