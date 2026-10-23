// OMP skills baseline reader (contract P0-C-BASE-v1, option B: ask OMP itself).
// Invokes `<omp> config get skills.customDirectories --json` and projects ONLY that key.
// Never reads OMP config files directly. Fails closed: any uncertainty -> null.

import { spawn } from "node:child_process";
import { ensurePathInEnv, sanitizeInheritedPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

export const DEFAULT_BASELINE_TIMEOUT_MS = 10000;
export const DEFAULT_BASELINE_MAX_STDOUT_BYTES = 65536;

const KEY = "skills.customDirectories";
const ARGS = Object.freeze(["config", "get", KEY, "--json"]);

// Same keys runChildProcess strips (adapter-utils@2026.1005.0 dist/server-utils.js:3114-3122;
// not exported there, so mirrored here).
const NESTING_ENV_KEYS = Object.freeze([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
]);

// Effective spawn env with runChildProcess semantics (dist/server-utils.js:3108-3126):
// sanitized inherited process.env + opts.env, nesting keys stripped, PATH ensured.
function effectiveEnv(env) {
  const merged = { ...sanitizeInheritedPaperclipEnv(process.env), ...env };
  for (const key of NESTING_ENV_KEYS) delete merged[key];
  return ensurePathInEnv(merged);
}

// Default runner: no shell, stderr discarded, child killed on timeout or stdout overflow.
export function defaultRunCommand(cmd, args, { cwd, env, timeoutMs, maxStdoutBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: effectiveEnv(env),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const chunks = [];
    let bytes = 0;
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    // Timeout/overflow settle immediately after SIGKILL; the partial stdout is never trusted.
    const abort = (flag) =>
      finish(() => {
        child.stdout?.destroy();
        child.kill("SIGKILL");
        resolve({ exitCode: null, stdout: "", timedOut: flag === "timedOut", overflow: flag === "overflow" });
      });

    const timer = setTimeout(() => abort("timedOut"), timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxStdoutBytes) {
        abort("overflow");
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) =>
      finish(() =>
        resolve({
          exitCode: typeof code === "number" ? code : null,
          stdout: Buffer.concat(chunks).toString("utf8"),
          timedOut: false,
          overflow: false,
        }),
      ),
    );
  });
}

function project(stdout) {
  if (typeof stdout !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.key !== KEY || parsed.type !== "array" || !Array.isArray(parsed.value)) return null;
  const dirs = [];
  for (const entry of parsed.value) {
    if (typeof entry !== "string" || entry.length === 0) return null;
    dirs.push(entry);
  }
  return dirs;
}

export async function readOmpSkillBaseline({
  command,
  cwd,
  env,
  runCommand = defaultRunCommand,
  timeoutMs = DEFAULT_BASELINE_TIMEOUT_MS,
  maxStdoutBytes = DEFAULT_BASELINE_MAX_STDOUT_BYTES,
} = {}) {
  if (typeof command !== "string" || command.length === 0) return null;
  let result;
  try {
    result = await runCommand(command, [...ARGS], { cwd, env, timeoutMs, maxStdoutBytes });
  } catch {
    return null;
  }
  if (result === null || typeof result !== "object") return null;
  if (result.exitCode !== 0 || result.timedOut || result.overflow) return null;
  const customDirectories = project(result.stdout);
  if (customDirectories === null) return null;
  return { trusted: true, config: { skills: { customDirectories } } };
}
