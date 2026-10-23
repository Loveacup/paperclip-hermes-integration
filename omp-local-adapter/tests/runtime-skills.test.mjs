// FROZEN RED tests for P0-C runtime skill delivery (contract P0-C1-v1, from P0-C-v1 D1 a–g).
// Groups: "module:" tests only runtime-skills.mjs; "index:" tests index.mjs execute + fake runner.
//   node --test --test-name-pattern='^module:' ...   /   --test-name-pattern='^index:'
//
// ---------------------------------------------------------------- interface contract
// runtime-skills.mjs MUST export:
//
//   prepareRuntimeSkills({ config, scratchDir, executionId, baseline }) -> Promise<Prepared>
//     config      : adapter config; reads config.paperclipRuntimeSkills (entries: key, runtimeName,
//                   source, versionId, currentVersionId, required, sourceStatus) and
//                   config.paperclipSkillSync.desiredSkills (string keys or {key, versionId}).
//     scratchDir  : the exact PAPERCLIP_RUN_SCRATCH_DIR (absolute, existing directory). Never a fallback.
//     executionId : string, unique per execute(); names the exclusive subdir <scratchDir>/omp-skills-<executionId>.
//     baseline    : { trusted: true, config: object } default provider OMP config to preserve (D1b);
//                   null / trusted!==true means "no trusted baseline".
//     Prepared, desired empty  : { status: "none", args: [], dir: null, delivered: [],
//                                  cleanup: async () => ({ ok: true }) }  — creates nothing.
//     Prepared, desired staged : { status: "staged", dir, skillsDir, overlayPath, args: ["--config", overlayPath],
//                                  delivered: [{ key, versionId, effectiveName, path, readable: true }],
//                                  cleanup: async () => ({ ok: boolean, warning?: string }) }
//       dir        = <scratchDir>/omp-skills-<executionId>          (exclusive to this execute)
//       skillsDir  = <dir>/skills  (the COLLECTION dir; each skill is a real copied dir <skillsDir>/<effectiveName>/SKILL.md,
//                    no symlinks)
//       overlayPath= <dir>/config.json; JSON (valid YAML) = baseline.config deep-merged with
//                    skills.customDirectories = [...baseline.config.skills.customDirectories ?? [], skillsDir]
//                    (arrays are appended, never replace the baseline array).
//       cleanup removes only <dir>; idempotent; never throws (failure -> { ok:false, warning }).
//     Rejects with RuntimeSkillRefusal (instanceof Error, .code string) AFTER removing any partial <dir>:
//       omp_skills_scratch_missing     scratchDir absent / relative / not an existing dir
//       omp_skills_source_missing      desired entry missing, sourceStatus missing, or stale (versionId !== currentVersionId)
//       omp_skills_source_unreadable   source dir/SKILL.md not readable
//       omp_skills_name_invalid        key/runtimeName/frontmatter name invalid (path separators, "..", empty, mismatch)
//       omp_skills_description_invalid SKILL.md frontmatter description missing/empty (loader would skip it)
//       omp_skills_name_conflict       two desired skills bind to the same effective (bare) name
//       omp_skills_baseline_untrusted  baseline null or not trusted
//       omp_skills_required_empty      desired non-empty but resolves to zero deliverable skills
//       omp_skills_staging_failed      copy/write failure while staging
//
//   class RuntimeSkillRefusal extends Error { code }
//   OVERLAY_SKILL_DIRS_KEY = "skills.customDirectories"  (dotted path of the overlay array)
//
// index.mjs execute(ctx) integration (deps.readOmpSkillBaseline: async () => baseline):
//   scratch = ctx.context.paperclipScratch {type:"heartbeat_run", dir} which MUST equal
//             ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR; otherwise refusal errorCode "omp_skills_scratch_missing".
//   Refusals map to result.errorCode = refusal.code, zero runner calls, subdir already removed.
//   Spawn: args include prepared.args; opts.env.TMPDIR is inside scratch (D1g, also when no skills).
//   finally (after the runner settles): prepared.cleanup(); a cleanup failure only sets
//   resultJson.runtimeSkills.cleanupWarning.
//   resultJson.runtimeSkills = { mode: "run_scoped", configured: [keys], delivered: [{key, versionId,
//     effectiveName, readable, spawnBound: true}], baseline: "preserved", isolation: "none" }
//   — never "installed"; no claim of OS sandbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.TMPDIR ?? os.tmpdir(), "omp-rts-test-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
let seq = 0;
const fresh = (p) => {
  const d = path.join(ROOT, `${p}-${++seq}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const loadRts = () => import("../runtime-skills.mjs");
const loadIndex = () => import("./adapter-fixture.mjs");

function skillSource(name, { description = `Does ${name}.`, fmName = name, body = "Body." } = {}) {
  const dir = fresh(`src-${name}`);
  const fm = ["---", fmName === null ? null : `name: ${fmName}`, description === null ? null : `description: ${description}`, "---"].filter((x) => x !== null);
  writeFileSync(path.join(dir, "SKILL.md"), `${fm.join("\n")}\n${body}\n`);
  return dir;
}
function entry(key, source, extra = {}) {
  const runtimeName = key.split("/").pop();
  return { key, runtimeName, source, versionId: "v1", currentVersionId: "v1", required: false, ...extra };
}
function skillConfig(entries, desired = entries.map((e) => e.key)) {
  return { paperclipRuntimeSkills: entries, paperclipSkillSync: { desiredSkills: desired } };
}
const BASELINE = () => ({ trusted: true, config: { skills: { customDirectories: ["/baseline/provider-skills"] }, model: "keep-me" } });
async function refused(promise, code) {
  const { RuntimeSkillRefusal } = await loadRts();
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof RuntimeSkillRefusal, `expected RuntimeSkillRefusal, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}
const children = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
async function prep(config, scratchDir = fresh("scratch"), extra = {}) {
  const { prepareRuntimeSkills } = await loadRts();
  return prepareRuntimeSkills({ config, scratchDir, executionId: extra.executionId ?? `ex${++seq}`, baseline: extra.baseline === undefined ? BASELINE() : extra.baseline });
}

// ================================================================ module:

test("module: exports interface (prepareRuntimeSkills, RuntimeSkillRefusal, OVERLAY_SKILL_DIRS_KEY)", async () => {
  const m = await loadRts();
  assert.equal(typeof m.prepareRuntimeSkills, "function");
  assert.equal(typeof m.RuntimeSkillRefusal, "function");
  assert.ok(new m.RuntimeSkillRefusal("x", "y") instanceof Error);
  assert.equal(m.OVERLAY_SKILL_DIRS_KEY, "skills.customDirectories");
});

test("module: D1a stages only inside exact scratch exclusive subdir", async () => {
  const scratch = fresh("scratch");
  const p = await prep(skillConfig([entry("co/alpha", skillSource("alpha"))]), scratch, { executionId: "exA" });
  assert.equal(p.status, "staged");
  assert.equal(p.dir, path.join(scratch, "omp-skills-exA"));
  assert.ok(p.skillsDir.startsWith(p.dir + path.sep) && p.overlayPath.startsWith(p.dir + path.sep));
  assert.deepEqual(children(scratch), ["omp-skills-exA"]);
  await p.cleanup();
});

test("module: D1a scratch missing/relative/not-dir refused, no fallback to TMPDIR or os.tmpdir", async () => {
  const cfg = skillConfig([entry("co/alpha", skillSource("alpha"))]);
  const file = path.join(fresh("f"), "plain");
  writeFileSync(file, "x");
  const before = children(os.tmpdir()).filter((n) => n.startsWith("omp-skills-")).length;
  const { prepareRuntimeSkills } = await loadRts();
  for (const scratchDir of [undefined, "", "relative/scratch", path.join(ROOT, "does-not-exist"), file]) {
    await refused(prepareRuntimeSkills({ config: cfg, scratchDir, executionId: `ex${++seq}`, baseline: BASELINE() }), "omp_skills_scratch_missing");
  }
  assert.equal(children(os.tmpdir()).filter((n) => n.startsWith("omp-skills-")).length, before);
});

test("module: array overlay must not swallow baseline customDirectories", async () => {
  const p = await prep(skillConfig([entry("co/alpha", skillSource("alpha"))]));
  const overlay = JSON.parse(readFileSync(p.overlayPath, "utf8"));
  assert.deepEqual(overlay.skills.customDirectories, ["/baseline/provider-skills", p.skillsDir]);
  assert.equal(overlay.model, "keep-me");
  assert.deepEqual(p.args, ["--config", p.overlayPath]);
  await p.cleanup();
});

test("module: overlay lists the collection dir, not an entry dir", async () => {
  const p = await prep(skillConfig([entry("co/alpha", skillSource("alpha"))]));
  const dirs = JSON.parse(readFileSync(p.overlayPath, "utf8")).skills.customDirectories;
  assert.ok(dirs.includes(p.skillsDir));
  assert.ok(!dirs.some((d) => existsSync(path.join(d, "SKILL.md"))), "an entry dir was listed as a collection");
  assert.ok(existsSync(path.join(p.skillsDir, "alpha", "SKILL.md")));
  await p.cleanup();
});

test("module: staged skill is a real readable dir (loader ignores links), not a symlink", async () => {
  const p = await prep(skillConfig([entry("co/alpha", skillSource("alpha"))]));
  const staged = path.join(p.skillsDir, "alpha");
  assert.ok(!lstatSync(staged).isSymbolicLink());
  assert.ok(!lstatSync(path.join(staged, "SKILL.md")).isSymbolicLink());
  assert.match(readFileSync(path.join(staged, "SKILL.md"), "utf8"), /description: Does alpha\./);
  assert.deepEqual(
    p.delivered.map(({ key, versionId, effectiveName, readable }) => ({ key, versionId, effectiveName, readable })),
    [{ key: "co/alpha", versionId: "v1", effectiveName: "alpha", readable: true }],
  );
  await p.cleanup();
});

test("module: bare-name conflict refused and partial dir removed", async () => {
  const scratch = fresh("scratch");
  const cfg = skillConfig([entry("a/dup", skillSource("dup")), entry("b/dup", skillSource("dup"))]);
  await refused(prep(cfg, scratch), "omp_skills_name_conflict");
  assert.deepEqual(children(scratch), []);
});

test("module: missing and stale sources refused, partial dir removed", async () => {
  const good = entry("co/ok", skillSource("ok"));
  const cases = [
    skillConfig([good], ["co/ok", "co/ghost"]),
    skillConfig([good, entry("co/gone", path.join(ROOT, "nope-src"), { sourceStatus: "missing" })]),
    skillConfig([good, entry("co/stale", skillSource("stale"), { versionId: "v1", currentVersionId: "v2" })], ["co/ok", { key: "co/stale", versionId: "v1" }]),
  ];
  for (const cfg of cases) {
    const scratch = fresh("scratch");
    await refused(prep(cfg, scratch), "omp_skills_source_missing");
    assert.deepEqual(children(scratch), [], JSON.stringify(cfg.paperclipSkillSync));
  }
});

test("module: unreadable source refused", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root bypasses permissions");
  const src = skillSource("locked");
  chmodSync(path.join(src, "SKILL.md"), 0o000);
  try {
    const scratch = fresh("scratch");
    await refused(prep(skillConfig([entry("co/locked", src)]), scratch), "omp_skills_source_unreadable");
    assert.deepEqual(children(scratch), []);
  } finally {
    chmodSync(path.join(src, "SKILL.md"), 0o644);
  }
});

test("module: invalid names/paths refused", async () => {
  for (const e of [
    entry("co/../escape", skillSource("escape"), { runtimeName: "../escape" }),
    entry("co/slash", skillSource("slash"), { runtimeName: "a/b" }),
    entry("co/mismatch", skillSource("mismatch", { fmName: "other-name" })),
  ]) {
    const scratch = fresh("scratch");
    await refused(prep(skillConfig([e]), scratch), "omp_skills_name_invalid");
    assert.deepEqual(children(scratch), []);
  }
});

test("module: description not satisfying loader refused", async () => {
  for (const description of [null, ""]) {
    const scratch = fresh("scratch");
    await refused(prep(skillConfig([entry("co/nodesc", skillSource("nodesc", { description }))]), scratch), "omp_skills_description_invalid");
    assert.deepEqual(children(scratch), []);
  }
});

test("module: no trusted baseline refused", async () => {
  const cfg = skillConfig([entry("co/alpha", skillSource("alpha"))]);
  for (const baseline of [null, { trusted: false, config: {} }]) {
    const scratch = fresh("scratch");
    await refused(prep(cfg, scratch, { baseline }), "omp_skills_baseline_untrusted");
    assert.deepEqual(children(scratch), []);
  }
});

test("module: required filter resolving to empty refused (not 'none', not 'all')", async () => {
  const scratch = fresh("scratch");
  const cfg = { paperclipRuntimeSkills: [entry("co/alpha", skillSource("alpha"))], paperclipSkillSync: { desiredSkills: ["   "] } };
  await refused(prep(cfg, scratch), "omp_skills_required_empty");
  assert.deepEqual(children(scratch), []);
});

test("module: D1c empty desired creates nothing and does not mean all skills", async () => {
  const scratch = fresh("scratch");
  const p = await prep(skillConfig([entry("co/alpha", skillSource("alpha"))], []), scratch);
  assert.equal(p.status, "none");
  assert.deepEqual(p.args, []);
  assert.deepEqual(p.delivered, []);
  assert.equal(p.dir, null);
  assert.deepEqual(children(scratch), []);
  assert.deepEqual(await p.cleanup(), { ok: true });
});

test("module: overlay serialization survives hostile paths", async () => {
  const scratch = path.join(fresh("scratch"), 'we"ird: #dir\\ ü');
  mkdirSync(scratch);
  const p = await prep(skillConfig([entry("co/alpha", skillSource("alpha"))]), scratch);
  const overlay = JSON.parse(readFileSync(p.overlayPath, "utf8"));
  assert.equal(overlay.skills.customDirectories.at(-1), p.skillsDir);
  assert.ok(existsSync(overlay.skills.customDirectories.at(-1)));
  await p.cleanup();
});

test("module: staging failure refused and partial dir removed", async () => {
  const scratch = fresh("scratch");
  const src = skillSource("big");
  mkdirSync(path.join(src, "sub"));
  writeFileSync(path.join(src, "sub", "f"), "x");
  chmodSync(path.join(src, "sub"), 0o000);
  try {
    await assert.rejects(prep(skillConfig([entry("co/big", src)]), scratch), (e) => ["omp_skills_staging_failed", "omp_skills_source_unreadable"].includes(e.code));
    assert.deepEqual(children(scratch), []);
  } finally {
    chmodSync(path.join(src, "sub"), 0o755);
  }
});

test("module: D1d cleanup removes only own subdir and is idempotent", async () => {
  const scratch = fresh("scratch");
  writeFileSync(path.join(scratch, "keep.txt"), "x");
  const cfg = skillConfig([entry("co/alpha", skillSource("alpha"))]);
  const a = await prep(cfg, scratch, { executionId: "one" });
  const b = await prep(cfg, scratch, { executionId: "two" });
  assert.equal((await a.cleanup()).ok, true);
  assert.equal((await a.cleanup()).ok, true);
  assert.deepEqual(children(scratch).sort(), ["keep.txt", "omp-skills-two"]);
  await b.cleanup();
  assert.deepEqual(children(scratch), ["keep.txt"]);
});

// ================================================================ index:

const line = (o) => `${JSON.stringify(o)}\n`;
const OK_STDOUT = line({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }] });

function runCtx({ scratch = fresh("scratch"), config = {}, runId = `run-${++seq}`, signal, scratchMeta } = {}) {
  const cwd = fresh("cwd");
  return {
    scratch,
    ctx: {
      runId,
      agent: { id: "agent-1", companyId: "co-1", name: "OMP", adapterType: "omp_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd, timeoutSec: 60, graceSec: 5, env: scratch ? { PAPERCLIP_RUN_SCRATCH_DIR: scratch } : {}, ...config },
      context: {
        taskId: "iss_1",
        issueId: "iss_1",
        wakeReason: "issue_assigned",
        paperclipWake: { reason: "issue_assigned", issue: { id: "iss_1", identifier: "LAB-1", title: "T", status: "todo" } },
        paperclipScratch: scratchMeta ?? (scratch ? { type: "heartbeat_run", dir: scratch } : undefined),
      },
      signal,
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
    },
  };
}
function runner(behave = async () => ({})) {
  const calls = [];
  const run = async (runId, command, args, opts) => {
    const i = args.indexOf("--config");
    const overlayPath = i >= 0 ? args[i + 1] : null;
    const seen = { runId, args, opts, overlayPath };
    if (overlayPath) {
      seen.overlay = JSON.parse(readFileSync(overlayPath, "utf8"));
      const dir = seen.overlay.skills.customDirectories.at(-1);
      seen.stagedNames = readdirSync(dir);
      seen.skillTexts = seen.stagedNames.map((n) => readFileSync(path.join(dir, n, "SKILL.md"), "utf8"));
    }
    calls.push(seen);
    await opts.onSpawn?.({ pid: 1, processGroupId: 1, startedAt: "2026-10-12T00:00:00Z" });
    const extra = await behave(seen);
    if (extra?.reject) throw extra.reject;
    await opts.onLog("stdout", OK_STDOUT);
    return { exitCode: 0, signal: null, timedOut: false, stdout: OK_STDOUT, stderr: "", pid: 1, startedAt: "2026-10-12T00:00:00Z", ...extra };
  };
  return { run, calls };
}
async function adapter(r, extra = {}) {
  const { createServerAdapter } = await loadIndex();
  return createServerAdapter({ runChildProcess: r.run, readOmpSkillBaseline: async () => BASELINE(), ...extra });
}
const ownDirs = (scratch) => children(scratch).filter((n) => n.startsWith("omp-skills-"));

test("index: desired skill delivered via --config overlay with evidence, cleaned after settle", async () => {
  const { scratch, ctx } = runCtx({ config: skillConfig([entry("co/alpha", skillSource("alpha"))]) });
  let during;
  const r0 = runner(async () => {
    during = ownDirs(scratch);
  });
  const res = await (await adapter(r0)).execute(ctx);
  assert.equal(r0.calls.length, 1);
  const c = r0.calls[0];
  assert.ok(c.overlayPath.startsWith(scratch + path.sep));
  assert.deepEqual(c.stagedNames, ["alpha"]);
  assert.match(c.skillTexts[0], /description: Does alpha\./);
  assert.deepEqual(c.overlay.skills.customDirectories[0], "/baseline/provider-skills");
  assert.equal(during.length, 1);
  assert.deepEqual(ownDirs(scratch), []);
  const rs = res.resultJson.runtimeSkills;
  assert.deepEqual(rs.configured, ["co/alpha"]);
  assert.deepEqual(rs.delivered, [{ key: "co/alpha", versionId: "v1", effectiveName: "alpha", readable: true, spawnBound: true }]);
  assert.equal(rs.baseline, "preserved");
  assert.ok(!JSON.stringify(res).includes('"installed"'));
});

test("index: D1g child TMPDIR inside run scratch, with and without skills", async () => {
  for (const config of [skillConfig([entry("co/alpha", skillSource("alpha"))]), skillConfig([], [])]) {
    const { scratch, ctx } = runCtx({ config });
    const r0 = runner();
    await (await adapter(r0)).execute(ctx);
    assert.equal(r0.calls.length, 1);
    const tmp = r0.calls[0].opts.env.TMPDIR;
    assert.ok(typeof tmp === "string" && (tmp === scratch || tmp.startsWith(scratch + path.sep)), `TMPDIR=${tmp}`);
  }
});

test("index: D1c empty desired -> no --config, no subdir", async () => {
  const { scratch, ctx } = runCtx({ config: skillConfig([entry("co/alpha", skillSource("alpha"))], []) });
  const r0 = runner(async () => {
    assert.deepEqual(ownDirs(scratch), []);
  });
  const res = await (await adapter(r0)).execute(ctx);
  assert.equal(r0.calls.length, 1);
  assert.ok(!r0.calls[0].args.includes("--config"));
  assert.deepEqual(res.resultJson.runtimeSkills.delivered, []);
});

test("index: D1a/D1b bad inputs refuse before spawn with zero runner calls and no leftovers", async () => {
  const cases = [
    ["omp_skills_scratch_missing", runCtx({ scratch: null, config: skillConfig([entry("co/a", skillSource("a"))]) })],
    ["omp_skills_scratch_missing", runCtx({ config: skillConfig([entry("co/a", skillSource("a"))]), scratchMeta: { type: "heartbeat_run", dir: fresh("other") } })],
    ["omp_skills_source_missing", runCtx({ config: skillConfig([entry("co/a", skillSource("a"))], ["co/a", "co/ghost"]) })],
    ["omp_skills_name_conflict", runCtx({ config: skillConfig([entry("x/d", skillSource("d")), entry("y/d", skillSource("d"))]) })],
    ["omp_skills_description_invalid", runCtx({ config: skillConfig([entry("co/n", skillSource("n", { description: null }))]) })],
    ["omp_skills_name_invalid", runCtx({ config: skillConfig([entry("co/m", skillSource("m", { fmName: "zzz" }))]) })],
  ];
  for (const [code, { scratch, ctx }] of cases) {
    const r0 = runner();
    const res = await (await adapter(r0)).execute(ctx);
    assert.equal(r0.calls.length, 0, code);
    assert.equal(res.errorCode, code);
    if (scratch) assert.deepEqual(ownDirs(scratch), [], code);
  }
});

test("index: untrusted baseline refuses with zero runner calls", async () => {
  const { scratch, ctx } = runCtx({ config: skillConfig([entry("co/a", skillSource("a"))]) });
  const r0 = runner();
  const res = await (await adapter(r0, { readOmpSkillBaseline: async () => null })).execute(ctx);
  assert.equal(r0.calls.length, 0);
  assert.equal(res.errorCode, "omp_skills_baseline_untrusted");
  assert.deepEqual(ownDirs(scratch), []);
});

test("index: two parallel runs on one scratch are mutually invisible and do not delete each other", async () => {
  const scratch = fresh("scratch");
  const a = runCtx({ scratch, runId: "run-A", config: skillConfig([entry("co/alpha", skillSource("alpha"))]) });
  const b = runCtx({ scratch, runId: "run-B", config: skillConfig([entry("co/beta", skillSource("beta"))]) });
  let releaseA;
  const gateA = new Promise((r) => (releaseA = r));
  let bDone;
  const r0 = runner(async (seen) => {
    if (seen.runId === "run-A") {
      await gateA;
      assert.ok(existsSync(seen.overlayPath), "A's overlay deleted by B");
    }
  });
  const ad = await adapter(r0);
  const pa = ad.execute(a.ctx);
  const pb = ad.execute(b.ctx).then((x) => {
    bDone = x;
    releaseA();
    return x;
  });
  const [ra] = await Promise.all([pa, pb]);
  const byRun = Object.fromEntries(r0.calls.map((c) => [c.runId, c]));
  assert.deepEqual(byRun["run-A"].stagedNames, ["alpha"]);
  assert.deepEqual(byRun["run-B"].stagedNames, ["beta"]);
  assert.notEqual(path.dirname(byRun["run-A"].overlayPath), path.dirname(byRun["run-B"].overlayPath));
  assert.equal(ra.resultJson.runtimeSkills.delivered[0].key, "co/alpha");
  assert.equal(bDone.resultJson.runtimeSkills.delivered[0].key, "co/beta");
  assert.deepEqual(ownDirs(scratch), []);
});

test("index: D1d cleanup after runner rejection, timeout and abort", async () => {
  const behaviours = [
    async () => ({ reject: new Error("synthetic dispatch rejection") }),
    async () => ({ timedOut: true, exitCode: null, signal: "SIGTERM" }),
  ];
  for (const behave of behaviours) {
    const { scratch, ctx } = runCtx({ config: skillConfig([entry("co/alpha", skillSource("alpha"))]) });
    const r0 = runner(behave);
    await (await adapter(r0)).execute(ctx);
    assert.equal(r0.calls.length, 1);
    assert.ok(r0.calls[0].overlayPath);
    assert.deepEqual(ownDirs(scratch), []);
  }
  const ac = new AbortController();
  const { scratch, ctx } = runCtx({ signal: ac.signal, config: skillConfig([entry("co/alpha", skillSource("alpha"))]) });
  const r1 = runner(async (seen) => {
    assert.equal(ownDirs(scratch).length, 1, "staged dir must exist until the runner settles");
    ac.abort();
    return { exitCode: null, signal: "SIGTERM" };
  });
  await (await adapter(r1)).execute(ctx);
  assert.equal(r1.calls.length, 1);
  assert.deepEqual(ownDirs(scratch), []);
});

test("index: cancelled before spawn leaves no staged dir", async () => {
  const ac = new AbortController();
  ac.abort();
  const { scratch, ctx } = runCtx({ signal: ac.signal, config: skillConfig([entry("co/alpha", skillSource("alpha"))]) });
  const r0 = runner();
  const res = await (await adapter(r0)).execute(ctx);
  assert.equal(r0.calls.length, 0);
  assert.equal(res.errorCode, "omp_cancelled_before_spawn");
  assert.deepEqual(ownDirs(scratch), []);
  assert.ok(res.resultJson === undefined || res.resultJson.runtimeSkills === undefined || res.resultJson.runtimeSkills.delivered.length === 0);
});

test("index: D1d cleanup failure is only a warning in resultJson", async () => {
  const { scratch, ctx } = runCtx({ config: skillConfig([entry("co/alpha", skillSource("alpha"))]) });
  const r0 = runner(async () => {
    chmodSync(scratch, 0o500);
  });
  try {
    const res = await (await adapter(r0)).execute(ctx);
    assert.equal(res.resultJson.runOutcome, "succeeded");
    assert.equal(typeof res.resultJson.runtimeSkills.cleanupWarning, "string");
  } finally {
    chmodSync(scratch, 0o755);
  }
});

test("index: D1f mention-channel desired keys (paperclipSkillSync) drive delivery without assigneeAdapterOverrides", async () => {
  const entries = [entry("co/alpha", skillSource("alpha")), entry("co/beta", skillSource("beta"))];
  const { ctx } = runCtx({ config: skillConfig(entries, ["co/beta"]) });
  const r0 = runner();
  const res = await (await adapter(r0)).execute(ctx);
  assert.deepEqual(r0.calls[0].stagedNames, ["beta"]);
  assert.deepEqual(res.resultJson.runtimeSkills.configured, ["co/beta"]);
});

test("index: D1e adapter module advertises run-scoped delivery honestly", async () => {
  const { createServerAdapter } = await loadIndex();
  const ad = createServerAdapter();
  assert.equal(ad.requiresMaterializedRuntimeSkills, true);
  const { ctx } = runCtx({ config: skillConfig([entry("co/alpha", skillSource("alpha"))]) });
  const res = await (await adapter(runner())).execute(ctx);
  assert.equal(res.resultJson.runtimeSkills.isolation, "none");
  assert.equal(res.resultJson.runtimeSkills.mode, "run_scoped");
});
