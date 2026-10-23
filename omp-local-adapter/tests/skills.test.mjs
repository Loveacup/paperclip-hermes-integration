// Offline behavioural tests for the omp_local skill hooks (listSkills/syncSkills).
// Contract: adapter-utils types.d.ts AdapterSkillContext/AdapterSkillSnapshot and
// server routes/agents.js, which pass config.paperclipRuntimeSkills (one entry per
// skill directory) and config.paperclipSkillSync (desired keys + optional pins).
// No OMP process, network, Paperclip server or user skill directory is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADAPTER_TYPE, createServerAdapter } from "./adapter-fixture.mjs";

const SCRATCH = mkdtempSync(
  path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.TMPDIR ?? os.tmpdir(), "omp-skills-test-"),
);
process.on("exit", () => rmSync(SCRATCH, { recursive: true, force: true }));

const ROOT = path.join(SCRATCH, "runtime-skills");
const ALPHA = "acme/skills/alpha";
const BETA = "acme/skills/beta";
const GONE = "acme/skills/gone";
const OPERATIONAL = "paperclipai/paperclip/paperclip";

function runtimeSkill(key, runtimeName, extra = {}) {
  return { key, runtimeName, source: path.join(ROOT, runtimeName), sourceStatus: "available", ...extra };
}

function ctx(config) {
  return { agentId: "agent-1", companyId: "company-1", adapterType: ADAPTER_TYPE, config };
}

function entry(snapshot, key) {
  const found = snapshot.entries.find((e) => e.key === key);
  assert.ok(found, `snapshot has entry ${key}`);
  return found;
}

const adapter = createServerAdapter();

test("adapter exposes listSkills(ctx) and syncSkills(ctx, desiredSkills) and requires materialized runtime skills", async () => {
  assert.equal(typeof adapter.listSkills, "function");
  assert.equal(typeof adapter.syncSkills, "function");
  assert.equal(adapter.listSkills.length, 1);
  assert.equal(adapter.syncSkills.length, 2);
  // Since P0-C (D1b fail-closed on unreadable sources) Paperclip must materialize runtime skills.
  assert.equal(adapter.requiresMaterializedRuntimeSkills, true);
  const config = { paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } };
  const listed = adapter.listSkills(ctx(config));
  const synced = adapter.syncSkills(ctx(config), []);
  assert.ok(listed instanceof Promise && synced instanceof Promise);
  for (const snapshot of [await listed, await synced]) {
    assert.equal(snapshot.adapterType, "omp_local");
    assert.deepEqual(snapshot.entries, []);
    assert.deepEqual(snapshot.desiredSkills, []);
  }
});

test("snapshot is honest: runtime delivery unsupported, desired skills configured, never installed", async () => {
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha"), runtimeSkill(BETA, "beta")],
    paperclipSkillSync: { desiredSkills: [ALPHA] },
  };
  const snapshot = await adapter.listSkills(ctx(config));
  assert.equal(snapshot.supported, false);
  assert.equal(snapshot.mode, "unsupported");
  assert.ok(snapshot.warnings.some((w) => /P0-C/.test(w) && /not (implemented|verified)/i.test(w)));

  const alpha = entry(snapshot, ALPHA);
  assert.equal(alpha.state, "configured");
  assert.equal(alpha.desired, true);
  assert.equal(alpha.managed, true);
  assert.match(alpha.detail, /not (loaded|delivered|mounted)/i);
  assert.equal(entry(snapshot, BETA).state, "available");
  assert.equal(entry(snapshot, BETA).desired, false);
  for (const e of snapshot.entries) {
    assert.notEqual(e.state, "installed");
    assert.equal(e.targetPath, null);
  }
});

test("sourcePath is the skill directory itself, never the collection root", async () => {
  const alphaSource = path.join(ROOT, "nested", "alpha-v1");
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha", { source: alphaSource })],
    paperclipSkillSync: { desiredSkills: [ALPHA] },
  };
  const alpha = entry(await adapter.listSkills(ctx(config)), ALPHA);
  assert.equal(alpha.sourcePath, alphaSource);
  assert.equal(alpha.runtimeName, "alpha");
  assert.equal(alpha.targetPath, null);
});

test("unknown desired key stays desired and is reported missing with a warning", async () => {
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha")],
    paperclipSkillSync: { desiredSkills: [ALPHA, "acme/skills/unknown"] },
  };
  const snapshot = await adapter.listSkills(ctx(config));
  assert.deepEqual(snapshot.desiredSkills, [ALPHA, "acme/skills/unknown"]);
  const unknown = entry(snapshot, "acme/skills/unknown");
  assert.equal(unknown.state, "missing");
  assert.equal(unknown.desired, true);
  assert.equal(unknown.sourcePath, null);
  assert.ok(snapshot.warnings.some((w) => w.includes("acme/skills/unknown")));
});

test("missing source keeps platform detail and versions, and is warned when desired", async () => {
  const config = {
    paperclipRuntimeSkills: [
      runtimeSkill(GONE, "gone", {
        sourceStatus: "missing",
        missingDetail: "The selected skill version no longer exists.",
        versionId: "v1",
        currentVersionId: "v2",
      }),
    ],
    paperclipSkillSync: { desiredSkills: [{ key: GONE, versionId: "v1" }] },
  };
  const snapshot = await adapter.listSkills(ctx(config));
  const gone = entry(snapshot, GONE);
  assert.equal(gone.state, "missing");
  assert.equal(gone.detail, "The selected skill version no longer exists.");
  assert.equal(gone.versionId, "v1");
  assert.equal(gone.currentVersionId, "v2");
  assert.equal(gone.sourcePath, null);
  assert.deepEqual(snapshot.desiredSkillEntries, [{ key: GONE, versionId: "v1" }]);
  assert.ok(snapshot.warnings.some((w) => w.includes(GONE)));
});

test("an applied pin is kept and never upgraded to the current version", async () => {
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha", { versionId: "v1", currentVersionId: "v2" })],
    paperclipSkillSync: { desiredSkills: [{ key: ALPHA, versionId: "v1" }] },
  };
  const snapshot = await adapter.listSkills(ctx(config));
  const alpha = entry(snapshot, ALPHA);
  assert.equal(alpha.state, "configured");
  assert.equal(alpha.versionId, "v1");
  assert.equal(alpha.currentVersionId, "v2");
  assert.deepEqual(snapshot.desiredSkillEntries, [{ key: ALPHA, versionId: "v1" }]);
});

test("a pin the platform did not apply is stale, keeps the requested pin and is warned", async () => {
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha", { versionId: "v2", currentVersionId: "v2" })],
    paperclipSkillSync: { desiredSkills: [{ key: ALPHA, versionId: "v1" }] },
  };
  const snapshot = await adapter.listSkills(ctx(config));
  const alpha = entry(snapshot, ALPHA);
  assert.equal(alpha.state, "stale");
  assert.equal(alpha.versionId, "v2");
  assert.match(alpha.detail, /v1/);
  assert.deepEqual(snapshot.desiredSkillEntries, [{ key: ALPHA, versionId: "v1" }]);
  assert.ok(snapshot.warnings.some((w) => w.includes(ALPHA) && w.includes("v1")));
});

test("an unpinned desired skill is not implicitly pinned to the resolved version", async () => {
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha", { versionId: "v2", currentVersionId: "v2" })],
    paperclipSkillSync: { desiredSkills: [ALPHA] },
  };
  const snapshot = await adapter.listSkills(ctx(config));
  assert.equal(entry(snapshot, ALPHA).state, "configured");
  assert.deepEqual(snapshot.desiredSkillEntries, [{ key: ALPHA, versionId: null }]);
});

test("the operational skill is not silently added to the desired set", async () => {
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(OPERATIONAL, "paperclip"), runtimeSkill(ALPHA, "alpha")],
    paperclipSkillSync: { desiredSkills: [ALPHA] },
  };
  const snapshot = await adapter.listSkills(ctx(config));
  assert.deepEqual(snapshot.desiredSkills, [ALPHA]);
  assert.equal(entry(snapshot, OPERATIONAL).desired, false);
  assert.equal(entry(snapshot, OPERATIONAL).state, "available");
});

test("syncSkills applies the desiredSkills argument, canonicalizing runtime names", async () => {
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha"), runtimeSkill(BETA, "beta")],
    paperclipSkillSync: { desiredSkills: [ALPHA] },
  };
  const snapshot = await adapter.syncSkills(ctx(config), ["beta"]);
  assert.deepEqual(snapshot.desiredSkills, [BETA]);
  assert.equal(entry(snapshot, BETA).state, "configured");
  assert.equal(entry(snapshot, ALPHA).state, "available");
});

test("syncSkills keeps a pin recorded in config for the requested key", async () => {
  const config = {
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha", { versionId: "v1", currentVersionId: "v2" })],
    paperclipSkillSync: { desiredSkills: [{ key: ALPHA, versionId: "v1" }] },
  };
  const snapshot = await adapter.syncSkills(ctx(config), [ALPHA]);
  assert.deepEqual(snapshot.desiredSkillEntries, [{ key: ALPHA, versionId: "v1" }]);
  assert.equal(entry(snapshot, ALPHA).state, "configured");
});

test("syncSkills rejects a desired set that is not an array of strings", async () => {
  const config = { paperclipRuntimeSkills: [], paperclipSkillSync: { desiredSkills: [] } };
  await assert.rejects(adapter.syncSkills(ctx(config), "alpha"), TypeError);
  await assert.rejects(adapter.syncSkills(ctx(config), [ALPHA, 7]), TypeError);
});

test("without platform-supplied runtime skills no default directory is scanned", async () => {
  const snapshot = await adapter.listSkills(ctx({ paperclipSkillSync: { desiredSkills: [ALPHA] } }));
  assert.equal(snapshot.entries.length, 1);
  assert.equal(entry(snapshot, ALPHA).state, "missing");
  assert.ok(snapshot.warnings.some((w) => /paperclipRuntimeSkills/.test(w)));
});

test("hooks neither mutate config nor touch the configured HOME", async () => {
  const home = mkdtempSync(path.join(SCRATCH, "home-"));
  const config = {
    env: { HOME: home },
    paperclipRuntimeSkills: [runtimeSkill(ALPHA, "alpha"), runtimeSkill(BETA, "beta")],
    paperclipSkillSync: { desiredSkills: [{ key: ALPHA, versionId: "v1" }] },
  };
  const before = structuredClone(config);
  await adapter.listSkills(ctx(config));
  await adapter.syncSkills(ctx(config), [BETA]);
  assert.deepEqual(config, before);
  assert.deepEqual(readdirSync(home), []);
});
