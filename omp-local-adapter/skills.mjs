// omp_local skill hooks: listSkills(ctx) / syncSkills(ctx, desiredSkills).
//
// Contract (adapter-utils types.d.ts AdapterSkillContext/AdapterSkillSnapshot,
// server routes/agents.js GET /agents/:id/skills and POST /agents/:id/skills/sync):
//   ctx.config.paperclipRuntimeSkills is the platform-resolved list of runtime
//   skills, one entry per skill directory (`source`), with versionId,
//   currentVersionId and sourceStatus; ctx.config.paperclipSkillSync holds the
//   persisted desired keys and optional version pins. Paperclip persists the
//   desired set itself before calling syncSkills.
//
// Honesty: OMP runs do not mount or deliver skills yet (P0-C), so the snapshot
// is `supported: false, mode: "unsupported"`. A desired skill whose source is
// available and whose pin was applied is "configured" (selection recorded in
// Paperclip only), never "installed"; nothing here claims OMP loaded or used it.
//
// Side effects: none. The hooks read only ctx.config: no filesystem access, no
// default skill-directory scan, no user/global directories, no processes.
import {
  buildRuntimeMountedSkillSnapshot,
  isPaperclipSkillSourceMissing,
  readPaperclipRuntimeSkillEntries,
  readPaperclipSkillSyncPreference,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const ADAPTER_TYPE = "omp_local";

const DELIVERY_WARNING =
  "OMP runtime skill mounting/delivery is not implemented yet (P0-C) and not verified; " +
  "selections are recorded by Paperclip only and no skill is loaded into or used by OMP runs.";
const CONFIGURED_DETAIL =
  "Selected in Paperclip. Not loaded, mounted or delivered to OMP runs: runtime delivery is not implemented yet (P0-C).";
const MISSING_DETAIL = "Paperclip did not supply this skill's source for the OMP adapter.";
const NO_RUNTIME_SKILLS_WARNING =
  "Paperclip did not supply paperclipRuntimeSkills; the OMP adapter does not scan default skill directories.";

function configOf(ctx) {
  const config = ctx?.config;
  return config && typeof config === "object" && !Array.isArray(config) ? config : {};
}

// Only the platform-supplied list is read. When it is absent, the official
// helper would fall back to scanning directories relative to this module,
// which can resolve outside the run's skill sources; that fallback is skipped.
async function readAvailableEntries(config) {
  if (!Array.isArray(config.paperclipRuntimeSkills)) return { entries: [], warnings: [NO_RUNTIME_SKILLS_WARNING] };
  // With an array present the helper returns its normalized entries and never scans moduleDir.
  return { entries: await readPaperclipRuntimeSkillEntries(config, import.meta.dirname), warnings: [] };
}

function canonicalize(references, availableEntries) {
  return resolvePaperclipDesiredSkillNames({ paperclipSkillSync: { desiredSkills: references } }, availableEntries);
}

// Pins recorded in config, keyed by the canonical skill key.
function readPins(config, availableEntries) {
  const pins = new Map();
  for (const { key, versionId } of readPaperclipSkillSyncPreference(config).desiredSkillEntries) {
    const [canonical] = canonicalize([key], availableEntries);
    if (canonical && !pins.has(canonical)) pins.set(canonical, versionId);
  }
  return pins;
}

function buildSnapshot(availableEntries, desiredSkills, pins, baseWarnings) {
  const snapshot = buildRuntimeMountedSkillSnapshot({
    adapterType: ADAPTER_TYPE,
    availableEntries,
    desiredSkills,
    mode: "unsupported",
    supported: false,
    configuredDetail: CONFIGURED_DETAIL,
    unsupportedDetail: CONFIGURED_DETAIL,
    missingDetail: MISSING_DETAIL,
    warnings: [DELIVERY_WARNING, ...baseWarnings],
  });
  const availableByKey = new Map(availableEntries.map((e) => [e.key, e]));
  const entries = snapshot.entries.map((entry) => {
    const available = availableByKey.get(entry.key);
    if (!entry.desired || !available) return entry;
    if (isPaperclipSkillSourceMissing(available)) {
      snapshot.warnings.push(`Desired skill "${entry.key}" has no available source: ${entry.detail}`);
      return entry;
    }
    const pin = pins.get(entry.key) ?? null;
    if (pin !== null && pin !== (available.versionId ?? null)) {
      const resolved = available.versionId ?? "an unpinned version";
      snapshot.warnings.push(`Desired skill "${entry.key}" is pinned to ${pin} but Paperclip resolved ${resolved}.`);
      return {
        ...entry,
        state: "stale",
        detail: `Pinned to version ${pin}, but Paperclip resolved ${resolved}; the pin was not applied and is not upgraded.`,
      };
    }
    return { ...entry, state: "configured", detail: CONFIGURED_DETAIL };
  });
  return {
    ...snapshot,
    entries,
    desiredSkillEntries: desiredSkills.map((key) => ({ key, versionId: pins.get(key) ?? null })),
  };
}

export async function listOmpSkills(ctx) {
  const config = configOf(ctx);
  const available = await readAvailableEntries(config);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, available.entries);
  return buildSnapshot(available.entries, desiredSkills, readPins(config, available.entries), available.warnings);
}

// Paperclip has already persisted the desired set; this reports it without
// installing, copying or mounting anything.
export async function syncOmpSkills(ctx, desiredSkills) {
  if (!Array.isArray(desiredSkills) || desiredSkills.some((key) => typeof key !== "string")) {
    throw new TypeError("syncSkills desiredSkills must be an array of skill keys.");
  }
  const config = configOf(ctx);
  const available = await readAvailableEntries(config);
  const desired = canonicalize(desiredSkills, available.entries);
  return buildSnapshot(available.entries, desired, readPins(config, available.entries), available.warnings);
}
