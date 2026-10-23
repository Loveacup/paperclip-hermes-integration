// Run-scoped OMP skill delivery (contract P0-C-v1 D1, slice P0-C2a).
// Stages desired Paperclip runtime skills as real copied dirs inside an exclusive subdir of the
// exact run scratch dir and emits a `--config` overlay that appends the collection dir to the
// trusted provider baseline. No symlinks, no global/TMPDIR fallback, nothing created when no
// skills are desired. This module does not install skills and provides no OS sandbox.
import { constants as fsConstants, statSync } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const OVERLAY_SKILL_DIRS_KEY = "skills.customDirectories";

const SUBDIR_PREFIX = "omp-skills-";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class RuntimeSkillRefusal extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RuntimeSkillRefusal";
    this.code = code;
  }
}

const refuse = (code, message) => new RuntimeSkillRefusal(code, message);

// D1a/D1g: the only accepted location is the exact, existing, absolute run scratch dir.
// Callers deriving the child TMPDIR must use the dir returned here (never os.tmpdir()/seat TMPDIR).
export function resolveRunScratch(scratchDir) {
  if (typeof scratchDir !== "string" || scratchDir === "" || !path.isAbsolute(scratchDir)) {
    throw refuse("omp_skills_scratch_missing", "run scratch dir missing or not absolute");
  }
  let stat;
  try {
    stat = statSync(scratchDir);
  } catch {
    throw refuse("omp_skills_scratch_missing", "run scratch dir does not exist");
  }
  if (!stat.isDirectory()) throw refuse("omp_skills_scratch_missing", "run scratch path is not a directory");
  return scratchDir;
}

function validName(name) {
  return typeof name === "string" && name !== "." && name !== ".." && NAME_RE.test(name);
}

function normalizeDesired(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const key = typeof item === "string" ? item.trim() : typeof item?.key === "string" ? item.key.trim() : "";
    if (!key) continue;
    const versionId = typeof item === "object" && item !== null && typeof item.versionId === "string" ? item.versionId : null;
    out.push({ key, versionId });
  }
  return { requested: list.length, desired: out };
}

function parseFrontmatter(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const fields = {};
  for (let i = 1; i < end; i += 1) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i].trim());
      value = block.join(" ").trim();
    } else if (/^(["']).*\1$/.test(value) && value.length >= 2) {
      value = value.slice(1, -1);
    }
    fields[m[1]] = value;
  }
  return fields;
}

// D1b: resolve and validate every desired skill before anything is created on disk.
async function resolveSkill(want, entries) {
  const entry = entries.find((e) => e?.key === want.key);
  if (!entry || entry.sourceStatus === "missing") throw refuse("omp_skills_source_missing", `skill ${want.key} missing`);
  const stale = entry.versionId !== entry.currentVersionId || (want.versionId !== null && want.versionId !== entry.currentVersionId);
  if (stale) throw refuse("omp_skills_source_missing", `skill ${want.key} stale`);
  const effectiveName = entry.runtimeName;
  if (!validName(effectiveName)) throw refuse("omp_skills_name_invalid", `skill ${want.key} has invalid runtime name`);
  if (typeof entry.source !== "string" || !path.isAbsolute(entry.source)) {
    throw refuse("omp_skills_source_missing", `skill ${want.key} has no absolute source`);
  }
  let text;
  try {
    await access(entry.source, fsConstants.R_OK | fsConstants.X_OK);
    text = await readFile(path.join(entry.source, "SKILL.md"), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") throw refuse("omp_skills_source_missing", `skill ${want.key} source not found`);
    throw refuse("omp_skills_source_unreadable", `skill ${want.key} source unreadable`);
  }
  const fm = parseFrontmatter(text);
  if (fm?.name !== undefined && fm.name !== effectiveName) {
    throw refuse("omp_skills_name_invalid", `skill ${want.key} frontmatter name does not match runtime name`);
  }
  if (!fm || typeof fm.description !== "string" || fm.description.trim() === "") {
    throw refuse("omp_skills_description_invalid", `skill ${want.key} lacks a loader-valid description`);
  }
  return { key: entry.key, versionId: entry.currentVersionId, effectiveName, source: entry.source };
}

function buildOverlay(baselineConfig, skillsDir) {
  const overlay = structuredClone(baselineConfig);
  const skills = overlay.skills && typeof overlay.skills === "object" && !Array.isArray(overlay.skills) ? overlay.skills : {};
  const existing = Array.isArray(skills.customDirectories) ? skills.customDirectories : [];
  overlay.skills = { ...skills, customDirectories: [...existing, skillsDir] };
  return overlay;
}

// D1d: removes only this execute's subdir; idempotent; never throws.
function makeCleanup(dir) {
  return async () => {
    try {
      await rm(dir, { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, warning: `runtime skills cleanup failed for ${dir}: ${err?.message ?? err}` };
    }
  };
}

export async function prepareRuntimeSkills({ config, scratchDir, executionId, baseline } = {}) {
  const scratch = resolveRunScratch(scratchDir);
  if (typeof executionId !== "string" || !validName(executionId)) {
    throw refuse("omp_skills_staging_failed", "executionId missing or not a safe path segment");
  }
  const { requested, desired } = normalizeDesired(config?.paperclipSkillSync?.desiredSkills);

  // D1c: no preference means no skills — no dir, no overlay, never "all skills".
  if (requested === 0) {
    return { status: "none", args: [], dir: null, delivered: [], cleanup: async () => ({ ok: true }) };
  }
  if (desired.length === 0) throw refuse("omp_skills_required_empty", "desired skills resolve to nothing deliverable");
  if (baseline?.trusted !== true || !baseline.config || typeof baseline.config !== "object" || Array.isArray(baseline.config)) {
    throw refuse("omp_skills_baseline_untrusted", "no trusted provider baseline to preserve");
  }

  const entries = Array.isArray(config?.paperclipRuntimeSkills) ? config.paperclipRuntimeSkills : [];
  const resolved = [];
  const byName = new Map();
  for (const want of desired) {
    if (resolved.some((r) => r.key === want.key)) continue;
    const skill = await resolveSkill(want, entries);
    if (byName.has(skill.effectiveName)) {
      throw refuse("omp_skills_name_conflict", `skills ${byName.get(skill.effectiveName)} and ${skill.key} share name ${skill.effectiveName}`);
    }
    byName.set(skill.effectiveName, skill.key);
    resolved.push(skill);
  }

  // D1a: exclusive per-execute subdir under the exact scratch dir.
  const dir = path.join(scratch, `${SUBDIR_PREFIX}${executionId}`);
  const skillsDir = path.join(dir, "skills");
  const overlayPath = path.join(dir, "config.json");
  const cleanup = makeCleanup(dir);
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    throw refuse("omp_skills_staging_failed", `cannot create exclusive staging dir: ${err?.code ?? err}`);
  }
  try {
    await mkdir(skillsDir, { mode: 0o700 });
    const delivered = [];
    for (const skill of resolved) {
      const target = path.join(skillsDir, skill.effectiveName);
      await cp(skill.source, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
      await access(path.join(target, "SKILL.md"), fsConstants.R_OK);
      delivered.push({ key: skill.key, versionId: skill.versionId, effectiveName: skill.effectiveName, path: target, readable: true });
    }
    await writeFile(overlayPath, `${JSON.stringify(buildOverlay(baseline.config, skillsDir), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { status: "staged", dir, skillsDir, overlayPath, args: ["--config", overlayPath], delivered, cleanup };
  } catch (err) {
    // D1d: the original staging error stays authoritative; the cleanup outcome rides along.
    const cleanupResult = await cleanup();
    const refusal = refuse("omp_skills_staging_failed", `staging failed: ${err?.code ?? err?.message ?? err}`);
    refusal.cleanupResult = cleanupResult;
    throw refusal;
  }
}
