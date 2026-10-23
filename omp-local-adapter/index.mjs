// omp_local: external Paperclip server adapter that runs OMP (oh-my-pi) once per
// heartbeat through the native runChildProcess. Paperclip owns the process
// lifecycle (spawn, cancel, TERM/KILL timeout); this module only validates
// input, builds argv/env/prompt, redacts logs and maps OMP's JSON output.
//
// OMP contract (18.10.0, packages/coding-agent/src/modes/print-mode.ts):
//   `omp -p --mode json` prints an optional {"type":"session",...} header line,
//   then one JSON event per line; the run ends with
//   {"type":"agent_end","messages":[...],"willContinue"?:true}. Exit code is 1
//   when the last assistant message has stopReason "error"/"aborted".
//   With a non-TTY stdin the prompt is read from piped stdin.
//   Assistant stopReason is one of "stop" | "length" | "toolUse" | "error" |
//   "aborted"; only "stop" is a clean completion.
//
// Native runChildProcess contract (adapter-utils server-utils.js):
//   opts.onSpawn(meta).catch(onLogError) runs after spawn and before the
//   runningProcesses registration, so onSpawn must never throw synchronously;
//   onLog rejections and onSpawn rejections go to opts.onLogError, whose
//   default console.warn({ err }) could print secrets. Captures keep only the
//   last MAX_CAPTURE_BYTES characters.
import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  MAX_CAPTURE_BYTES,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  isForbiddenConfigEnvKey,
  joinPromptSections,
  redactEnvForLogs,
  runChildProcess as nativeRunChildProcess,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { adapterExecutionTargetIsRemote, readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { listOmpSkills, syncOmpSkills } from "./skills.mjs";
import { RuntimeSkillRefusal, prepareRuntimeSkills } from "./runtime-skills.mjs";
import { createOmpOutputParser } from "./output-parser.mjs";
import { readOmpSkillBaseline as readOmpSkillBaselineFromCli } from "./omp-baseline.mjs";

export const ADAPTER_TYPE = "omp_local";

export const APPROVAL_MODES = Object.freeze(["always-ask", "write", "yolo"]);
export const REDACTED = "***REDACTED***";

const DEFAULT_TIMEOUT_SEC = 900;
const MAX_TIMEOUT_SEC = 24 * 60 * 60;
const DEFAULT_GRACE_SEC = 15;
const MAX_GRACE_SEC = 300;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENTS = 50_000;
const DEFAULT_MAX_FINAL_TEXT_CHARS = 64 * 1024;
const STDERR_EXCERPT_CHARS = 2048;
const MAX_LABEL_CHARS = 200;

const KNOWN_CONFIG_KEYS = new Set(["cwd", "timeoutSec", "graceSec", "approvalMode", "model", "thinking", "env",
  // Native heartbeat connector-runtime overlays these even with no skills.
  // They are metadata only, never interpreted as command flags or credentials.
  "paperclipSkillSync", "paperclipRuntimeSkills", "paperclipConnectorSkillDigest"]);
const SUCCESS_STOP_REASON = "stop";
const KNOWN_STOP_REASONS = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const IDENTITY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SENSITIVE_KEY_RE = /(key|token|secret|password|passwd|authorization|cookie)/i;

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- config

// Refusal messages are fixed text: config keys and values are never echoed.
// cwd is validated separately: execute validates only the selected directory.
function validateConfig(config) {
  const cfg = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) throw new Refusal("omp_config_invalid", "Adapter config contains an unsupported key.");
  }

  const timeoutSec = cfg.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TIMEOUT_SEC) {
    throw new Refusal("omp_config_invalid", `config.timeoutSec must be an integer in 1..${MAX_TIMEOUT_SEC}.`);
  }
  const graceSec = cfg.graceSec ?? DEFAULT_GRACE_SEC;
  if (!Number.isInteger(graceSec) || graceSec < 1 || graceSec > MAX_GRACE_SEC) {
    throw new Refusal("omp_config_invalid", `config.graceSec must be an integer in 1..${MAX_GRACE_SEC}.`);
  }

  let approvalMode = null;
  if (cfg.approvalMode !== undefined) {
    if (!APPROVAL_MODES.includes(cfg.approvalMode)) {
      throw new Refusal("omp_config_invalid", `config.approvalMode must be one of ${APPROVAL_MODES.join(", ")} when set.`);
    }
    approvalMode = cfg.approvalMode;
  }

  let model = null;
  if (cfg.model !== undefined) {
    if (typeof cfg.model !== "string" || !MODEL_RE.test(cfg.model)) {
      throw new Refusal("omp_config_invalid", "config.model contains unsupported characters.");
    }
    model = cfg.model;
  }

  const rawThinking = cfg.thinking;
  let thinking = null;
  if (rawThinking !== undefined) {
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"].includes(rawThinking)) {
      throw new Refusal("omp_config_invalid", "config.thinking must be a supported reasoning level.");
    }
    thinking = rawThinking;
  }

  const env = {};
  if (cfg.env !== undefined) {
    if (!cfg.env || typeof cfg.env !== "object" || Array.isArray(cfg.env)) {
      throw new Refusal("omp_config_invalid", "config.env must be an object of string values.");
    }
    for (const [key, value] of Object.entries(cfg.env)) {
      if (!ENV_KEY_RE.test(key)) throw new Refusal("omp_config_invalid", "config.env has an invalid key name.");
      if (isForbiddenConfigEnvKey(key)) {
        throw new Refusal("omp_config_invalid", "config.env must not set Paperclip-owned keys; the run token is supplied by Paperclip.");
      }
      if (typeof value !== "string" || value.includes("\u0000")) {
        throw new Refusal("omp_config_invalid", "config.env values must be strings.");
      }
      env[key] = value;
    }
  }

  return { cwd: cfg.cwd, timeoutSec, graceSec, approvalMode, model, thinking, env };
}

// ---------------------------------------------------------------- workspace

const CONFIG_CWD = Object.freeze({ code: "omp_config_invalid", label: "config.cwd" });

// Same notion of "set" as the native Pi adapter (asString(value, "")): only
// undefined, null and "" count as absent. Any other value is validated, never skipped.
function cwdProvided(value) {
  return value !== undefined && value !== null && value !== "";
}

/**
 * Selects the run cwd following the native Pi adapter consumption protocol
 * (adapter-pi-local dist/server/execute.js:160-175): an explicit
 * context.paperclipWorkspace.cwd wins, except that source "agent_home" yields
 * to a set config.cwd; without a workspace cwd, config.cwd is used.
 * context.paperclipWorkspaces is a hint list and never selects the cwd.
 * There is no process.cwd() fallback.
 */
function selectCwd(context, configCwd) {
  const workspace = context?.paperclipWorkspace;
  const ws = workspace && typeof workspace === "object" && !Array.isArray(workspace) ? workspace : {};
  const useConfig = !cwdProvided(ws.cwd) || (ws.source === "agent_home" && cwdProvided(configCwd));
  if (useConfig) return { ...CONFIG_CWD, value: configCwd };
  return { value: ws.cwd, code: "omp_workspace_invalid", label: "paperclipWorkspace.cwd" };
}

// Messages name the source only; the rejected path is never echoed.
async function assertCwd(statPath, { value, code, label }) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || !path.isAbsolute(value)) {
    throw new Refusal(code, `${label} must be an absolute directory path.`);
  }
  let stats;
  try {
    stats = await statPath(value);
  } catch {
    throw new Refusal(code, `${label} does not exist.`);
  }
  if (!stats.isDirectory()) throw new Refusal(code, `${label} is not a directory.`);
  return value;
}

// Only local execution is supported: a cwd chosen here is a host path. Any
// remote, unrecognised or legacy remote-transport target is refused pre-spawn.
function assertLocalExecutionTarget(ctx) {
  const legacyRemoteExecution = ctx.executionTransport?.remoteExecution ?? null;
  const target = readAdapterExecutionTarget({ executionTarget: ctx.executionTarget, legacyRemoteExecution });
  const local = !adapterExecutionTargetIsRemote(target) && legacyRemoteExecution === null &&
    (ctx.executionTarget == null || target?.kind === "local");
  if (!local) {
    throw new Refusal("omp_execution_target_unsupported", "omp_local runs only on the local host; remote execution targets are not supported.");
  }
}

// ---------------------------------------------------------------- identity

function readId(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveTaskIdentity(context) {
  const candidates = [
    readId(context?.taskId),
    readId(context?.issueId),
    readId(context?.paperclipWake?.issue?.id),
  ].filter(Boolean);
  if (candidates.length === 0) {
    throw new Refusal("omp_task_identity_missing", "Run context has no explicit taskId/issueId; refusing to start OMP.");
  }
  if (new Set(candidates).size > 1) {
    throw new Refusal("omp_task_identity_conflict", "Run context carries conflicting task identities.");
  }
  if (!IDENTITY_RE.test(candidates[0])) {
    throw new Refusal("omp_task_identity_invalid", "Run context task identity has unsupported characters.");
  }
  return candidates[0];
}

// ---------------------------------------------------------------- redaction

// Every nonempty known credential is protected, whatever its length. Config is
// read best-effort so refusals of invalid config are sanitized too.
function collectSecrets(ctx) {
  const secrets = new Set();
  const add = (v) => {
    if (typeof v === "string" && v.length > 0) secrets.add(v);
  };
  add(ctx.authToken);
  add(ctx.runtimeTools?.bearerToken);
  const configEnv = ctx.config?.env;
  if (configEnv && typeof configEnv === "object" && !Array.isArray(configEnv)) {
    for (const [key, value] of Object.entries(configEnv)) {
      if (SENSITIVE_KEY_RE.test(key)) add(value);
    }
  }
  return [...secrets];
}

// Raw, JSON-escaped and doubly JSON-escaped forms (OMP prints JSON lines whose
// strings may themselves carry JSON). Longest first, so a containing form wins.
function secretVariants(secrets) {
  const set = new Set();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length === 0) continue;
    const once = JSON.stringify(secret).slice(1, -1);
    // Python json.dumps(ensure_ascii=True) is a normal JSON producer.
    // Work per UTF-16 unit so astral characters use JSON surrogate pairs.
    const ascii = once.replace(/[\u007f-\uffff]/g, uEscapeUnit);
    // Go encoding/json escapes <, >, & (and U+2028/U+2029) as \u00XX.
    const go = once.replace(/[<>&\u2028\u2029]/g, uEscapeUnit);
    const asciiGo = ascii.replace(/[<>&]/g, uEscapeUnit);
    const upper = (s) => s.replace(/\\u([0-9a-f]{4})/g, (_m, hex) => '\\u' + hex.toUpperCase());
    for (const form of [secret, once, ascii, upper(ascii), go, upper(go), asciiGo, upper(asciiGo)]) {
      set.add(form);
      const outer = JSON.stringify(form).slice(1, -1);
      set.add(outer).add(JSON.stringify(outer).slice(1, -1));
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

function uEscapeUnit(c) {
  return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
}

// Start of the JSON escape sequence (`\x` or `\uXXXX`) covering position p,
// or p when p is not inside one. Parity is counted inside `raw` only, which is
// sound because callers never cut `raw` inside an escape sequence.
function escapeStart(raw, p) {
  for (let j = p - 1; j >= Math.max(0, p - 5); j--) {
    if (raw[j] !== "\\") continue;
    let run = 0;
    for (let q = j; q >= 0 && raw[q] === "\\"; q--) run++;
    if (run % 2 === 0) continue;
    const end = raw[j + 1] === "u" ? j + 6 : j + 2;
    if (p < end) return j;
  }
  return p;
}

// End (exclusive) of the escape sequence covering position e - 1 when e cuts it.
function escapeEnd(raw, e) {
  const j = escapeStart(raw, e);
  if (j === e) return e;
  return raw[j + 1] === "u" || j + 1 >= raw.length ? j + 6 : j + 2;
}

// True when a variant could reappear by joining a marker with neighbouring text.
function overlapsMarker(variant, marker) {
  if (variant.includes(marker) || marker.includes(variant)) return true;
  for (let k = 1; k < Math.min(variant.length, marker.length); k++) {
    if (marker.endsWith(variant.slice(0, k)) || marker.startsWith(variant.slice(-k))) return true;
  }
  return false;
}

function pickMarker(variants) {
  for (const marker of [REDACTED, "[REDACTED]", "<redacted>"]) {
    if (!variants.some((v) => overlapsMarker(v, marker))) return marker;
  }
  for (let cp = 0x2588; ; cp++) {
    const marker = String.fromCodePoint(cp);
    if (!variants.some((v) => v.includes(marker))) return marker;
  }
}

const JSON_SIMPLE_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const MAX_DECODE_DEPTH = 2;
// Worst-case raw length of one UTF-16 unit at MAX_DECODE_DEPTH (`\uXXXX` of `\uXXXX`).
const MAX_UNIT_ENCODED = 6 ** MAX_DECODE_DEPTH;

/**
 * Decodes one character of `raw` at position p after `depth` levels of JSON
 * string escaping (depth 0 = literal). Hex digits are case-insensitive, so any
 * mix of literal, `\x` and `\uXXXX` forms decodes to the same unit.
 * Returns [char, end] or null when p does not start a valid sequence.
 */
function decodeUnit(raw, p, depth) {
  if (p >= raw.length) return null;
  if (depth === 0) return [raw[p], p + 1];
  const a = decodeUnit(raw, p, depth - 1);
  if (!a || a[0] !== "\\") return a;
  const b = decodeUnit(raw, a[1], depth - 1);
  if (!b) return null;
  if (Object.hasOwn(JSON_SIMPLE_ESCAPES, b[0])) return [JSON_SIMPLE_ESCAPES[b[0]], b[1]];
  if (b[0] !== "u") return null;
  let end = b[1];
  let hex = "";
  for (let k = 0; k < 4; k++) {
    const h = decodeUnit(raw, end, depth - 1);
    if (!h || !/^[0-9a-fA-F]$/.test(h[0])) return null;
    hex += h[0];
    end = h[1];
  }
  return [String.fromCharCode(parseInt(hex, 16)), end];
}

// End of a decoded match of `secret` starting at p, or -1.
function decodedMatchEnd(raw, p, secret, depth) {
  let e = p;
  for (let k = 0; k < secret.length; k++) {
    const r = decodeUnit(raw, e, depth);
    if (!r || r[0] !== secret[k]) return -1;
    e = r[1];
  }
  return e;
}

/**
 * Earliest (then longest) occurrence at or after `from` and before `limit` of
 * any literal variant or any JSON-escaped encoding (up to MAX_DECODE_DEPTH) of
 * a secret. Returns [start, end] or null.
 */
function findSecret(raw, from, limit, variants, secrets) {
  let best = null;
  for (const v of variants) {
    const idx = raw.indexOf(v, from);
    if (idx !== -1 && idx < limit && (!best || idx < best[0] || (idx === best[0] && idx + v.length > best[1]))) best = [idx, idx + v.length];
  }
  const stop = best ? best[0] + 1 : limit;
  for (let p = from; p < stop; p++) {
    let end = -1;
    for (const secret of secrets) {
      for (let d = 1; d <= MAX_DECODE_DEPTH; d++) end = Math.max(end, decodedMatchEnd(raw, p, secret, d));
    }
    if (end !== -1) return best && best[0] === p ? [p, Math.max(end, best[1])] : [p, end];
  }
  return best;
}

/**
 * Leftmost-longest replacement over raw (never previously redacted) text.
 * Replacements are widened to whole JSON escape sequences so a marker never
 * splits `\x` / `\uXXXX` and NDJSON lines stay parseable. Unless `final`, the
 * tail where a variant (or a cut escape) could still be completed by later
 * input is returned unprocessed as `rest`; that cut never lands inside an escape.
 */
function scanRedact(raw, variants, secrets, marker, final) {
  const literalMax = variants.length > 0 ? variants[0].length : 0;
  const secretMax = secrets.reduce((m, s) => Math.max(m, s.length), 0);
  const maxLen = Math.max(literalMax, secretMax * MAX_UNIT_ENCODED);
  let limit = final ? raw.length : Math.max(0, raw.length - maxLen - 5);
  if (!final) limit = escapeStart(raw, limit);
  let out = "";
  let i = 0;
  while (i < limit) {
    const hit = findSecret(raw, i, limit, variants, secrets);
    if (!hit) break;
    const start = Math.max(i, escapeStart(raw, hit[0]));
    const end = Math.min(raw.length, escapeEnd(raw, hit[1]));
    out += raw.slice(i, start) + marker;
    i = end;
  }
  if (i < limit) {
    out += raw.slice(i, limit);
    i = limit;
  }
  return { out, rest: raw.slice(i) };
}

function compileRedactor(secrets) {
  const variants = secretVariants(secrets);
  const plain = [...new Set((secrets ?? []).filter((s) => typeof s === "string" && s.length > 0))];
  const marker = pickMarker(variants);
  const redact = (text) => {
    const raw = String(text ?? "");
    if (variants.length === 0) return raw;
    const { out } = scanRedact(raw, variants, plain, marker, true);
    // Belt and braces: never return a string that still carries a known form.
    return findSecret(out, 0, out.length, variants, plain) ? "" : out;
  };
  // Applied once to every object leaving the adapter (meta, refusals, results).
  const sanitize = (value, seen = new WeakSet()) => {
    if (typeof value === "string") return redact(value);
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => sanitize(v, seen));
    const out = {};
    for (const [key, v] of Object.entries(value)) out[redact(key)] = sanitize(v, seen);
    return out;
  };
  return { variants, plain, marker, redact, sanitize };
}

export function redactText(text, secrets) {
  return compileRedactor(secrets).redact(text);
}

/**
 * Redacts known secrets from streamed chunks. Raw text is held back per stream
 * until no secret form could still straddle the next chunk, then redacted once.
 */
export function createStreamRedactor(secrets, emit) {
  const { variants, plain, marker } = compileRedactor(secrets);
  const pending = { stdout: "", stderr: "" };
  return {
    async write(stream, chunk) {
      if (variants.length === 0) return emit(stream, chunk);
      const { out, rest } = scanRedact((pending[stream] ?? "") + chunk, variants, plain, marker, false);
      pending[stream] = rest;
      if (out.length > 0) await emit(stream, out);
    },
    async flush() {
      for (const stream of Object.keys(pending)) {
        const { out } = scanRedact(pending[stream], variants, plain, marker, true);
        pending[stream] = "";
        if (out.length > 0) await emit(stream, out);
      }
    },
  };
}

// ---------------------------------------------------------------- OMP output

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return typeof message?.content === "string" ? message.content : "";
  return message.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Parses OMP `--mode json` stdout. Only a complete, newline-terminated
 * agent_end without willContinue that is not followed by any other event counts
 * as final. Collection is bounded: parsing stops after maxEvents nonblank lines.
 * Any damage (malformed/oversized lines, truncated tail, capture or event cap,
 * capped final text) is listed in `damage`; callers must fail closed on it.
 */
export function parseOmpJsonOutput(stdout, limits = {}) {
  const maxLineBytes = limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxEvents = limits.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxFinalTextChars = limits.maxFinalTextChars ?? DEFAULT_MAX_FINAL_TEXT_CHARS;
  const captureLimitChars = limits.captureLimitChars ?? MAX_CAPTURE_BYTES;
  const redact = typeof limits.redact === "function" ? limits.redact : (s) => s;
  const text = typeof stdout === "string" ? stdout : "";

  const out = {
    sessionId: null,
    final: null,
    finalMessage: null,
    finalText: "",
    finalTextTruncated: false,
    eventCount: 0,
    eventCapExceeded: false,
    finalsInvalidated: 0,
    malformedLines: 0,
    oversizedLines: 0,
    truncatedTail: false,
    // Native capture keeps only the last captureLimitChars; the head may be gone.
    captureMayBeTruncated: text.length >= captureLimitChars,
    damage: [],
  };

  let pos = 0;
  let linesSeen = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    if (nl === -1) {
      if (text.slice(pos).trim().length > 0) out.truncatedTail = true;
      break;
    }
    const lineText = text.slice(pos, nl).trim();
    pos = nl + 1;
    if (lineText.length === 0) continue;
    if (linesSeen >= maxEvents) {
      out.eventCapExceeded = true;
      break;
    }
    linesSeen += 1;
    if (Buffer.byteLength(lineText, "utf8") > maxLineBytes) {
      out.oversizedLines += 1;
      continue;
    }
    let event;
    try {
      event = JSON.parse(lineText);
    } catch {
      out.malformedLines += 1;
      continue;
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      out.malformedLines += 1;
      continue;
    }
    out.eventCount += 1;
    // OMP 18.10 emits a payload-free advisor idle notification after final.
    // Only this observed inert shape is exempt; other trailing events invalidate.
    if (out.final && event.type === "advisor_yielded" && Object.keys(event).length === 1) continue;
    if (out.final) {
      out.final = null;
      out.finalsInvalidated += 1;
    }
    if (event.type === "session") {
      if (typeof event.id === "string" && out.sessionId === null) out.sessionId = event.id;
    } else if (event.type === "agent_end") {
      if (!Array.isArray(event.messages) || (event.willContinue !== undefined && typeof event.willContinue !== "boolean") || (event.isTerminal !== undefined && typeof event.isTerminal !== "boolean")) {
        out.malformedLines += 1;
      } else if (event.willContinue !== true && event.isTerminal !== false) {
        out.final = event;
      }
    }
  }

  if (out.final) {
    const assistants = out.final.messages.filter((m) => m && m.role === "assistant");
    out.finalMessage = assistants.length > 0 ? assistants[assistants.length - 1] : null;
    const full = textOf(out.finalMessage);
    out.finalTextTruncated = full.length > maxFinalTextChars;
    // Redact the whole text before cutting so a secret cannot straddle the cut.
    out.finalText = redact(full).slice(0, maxFinalTextChars);
  }

  if (out.malformedLines > 0) out.damage.push("malformed_lines");
  if (out.oversizedLines > 0) out.damage.push("oversized_lines");
  if (out.truncatedTail) out.damage.push("truncated_tail");
  if (out.captureMayBeTruncated) out.damage.push("capture_cap");
  if (out.eventCapExceeded) out.damage.push("event_cap");
  if (out.finalTextTruncated) out.damage.push("final_text_cap");
  return out;
}

/**
 * ADAPT-OUT-3: terminal state and damage come from the stream parser that saw
 * every raw stdout chunk. The native capture keeps only the tail, so it is used
 * solely to prove the stream saw at least what was captured: a capture at the
 * cap with more streamed bytes is a diagnostic (captureTruncated), never damage;
 * any other byte mismatch or feed failure is stream_incomplete and fails closed.
 */
function finishStreamParse(parser, streamState, stdout, redact) {
  const r = parser.end();
  const captured = typeof stdout === "string" ? stdout : "";
  const capturedBytes = Buffer.byteLength(captured, "utf8");
  const bytesSeen = r.counts.bytesSeen;
  const captureAtCap = captured.length >= MAX_CAPTURE_BYTES;
  const captureTruncated = captureAtCap && bytesSeen > capturedBytes;
  const streamComplete = !streamState.feedFailed && (bytesSeen === capturedBytes || captureTruncated);
  // F-CAP-BOUNDARY-01: at the cap with equal byte counts, the incremental digest
  // of every streamed stdout byte must equal the capture's digest to prove the
  // stream saw exactly what native kept; a missing or failed digest fails closed.
  const streamDigest = streamState.hashFailed || !streamState.hash ? null : streamState.hash.digest("hex");
  const captureProven =
    captureAtCap && bytesSeen === capturedBytes && streamDigest !== null &&
    streamDigest === createHash("sha256").update(captured, "utf8").digest("hex");
  const out = {
    sessionId: r.sessionId,
    final: r.final,
    finalMessage: null,
    finalText: "",
    finalTextTruncated: false,
    eventCount: r.counts.events,
    eventCapExceeded: r.diagnostics.eventCapExceeded,
    finalsInvalidated: r.finalsInvalidated,
    malformedLines: r.counts.malformedLines,
    oversizedLines: r.counts.oversizedLines,
    truncatedTail: r.diagnostics.truncatedTail,
    captureTruncated,
    streamBytesSeen: bytesSeen,
    capturedBytes,
    damage: [...r.damage],
  };
  if (out.final) {
    const assistants = out.final.messages.filter((m) => m && m.role === "assistant");
    out.finalMessage = assistants.length > 0 ? assistants[assistants.length - 1] : null;
    const full = textOf(out.finalMessage);
    out.finalTextTruncated = full.length > DEFAULT_MAX_FINAL_TEXT_CHARS;
    out.finalText = redact(full).slice(0, DEFAULT_MAX_FINAL_TEXT_CHARS);
  }
  // A capture at the cap that the stream never exceeded is accepted only when the
  // byte-for-byte digest proof holds; otherwise keep capture_cap (fail closed).
  if (captureAtCap && !captureTruncated && !captureProven) out.damage.push("capture_cap");
  if (out.finalTextTruncated) out.damage.push("final_text_cap");
  if (!streamComplete) out.damage.push("stream_incomplete");
  return out;
}

// Frozen #10/#12: only a clean exit-1 run whose final assistant message is OMP's
// own --max-time abort counts; damage or publication failure keeps exit_nonzero.
function isOmpDeadlineEvidence(proc, parsed, msg, knownStop, publication) {
  return (
    proc.exitCode === 1 &&
    parsed.damage.length === 0 &&
    !publication.spawnRecordFailed &&
    !publication.logFailed &&
    !publication.progress?.failure &&
    parsed.final !== null &&
    knownStop === "aborted" &&
    msg?.errorMessage === "Deadline exceeded"
  );
}

// ---------------------------------------------------------------- progress events

// S2: live progress for the platform's ctx.onEvent (AdapterRuntimeEvent, adapter-utils
// types.d.ts). The server derives currentToolName from payload.toolName (cut to 80
// chars) and shows "Using <tool>". eventType "tool_call"/"tool_result" follows the
// official Kimi adapter; "tool.execution.*" is avoided because the server's native
// chat-progress and safe-replacement paths give those events extra meaning.
// Display only: no issue status, comment, timer or process control is derived here.
export const PROGRESS_LIMITS = Object.freeze({
  // A tool line above the parser's own line cap is already output damage.
  maxLineBytes: DEFAULT_MAX_LINE_BYTES,
  // Distinct tool calls tracked per run; each yields at most a start and an end event.
  maxToolCalls: 1024,
  toolNameChars: 80,
  toolCallIdChars: 128,
  jobStatusChars: 32,
});
// OMP 18.10 serializes these events with "type" first (print-mode JSON.stringify of
// {type, toolCallId, toolName, ...}). Only lines starting with one of these prefixes
// are buffered and parsed, so large message/thinking lines are never parsed twice;
// any other key order simply yields no progress (never a forged one).
// The async-result prefix is the exact OMP 18.10 custom-message serialization; only
// message_end is matched, so message_start/message_end of one notice yield one event.
const ASYNC_RESULT_PREFIX = '{"type":"message_end","message":{"role":"custom","customType":"async-result",';
const PROGRESS_LINE_PREFIXES = Object.freeze(['{"type":"tool_execution_start",', '{"type":"tool_execution_end",', ASYNC_RESULT_PREFIX]);

// Deadline diagnostics: background jobs admitted (tool_execution_end details.async.state
// "running") with no async-result completion notice. Only jobId/state leave; command
// text, labels and job output never do. Bounded by maxToolCalls like tool ids.
function undeliveredJobs(stdout, redact) {
  const pending = new Map();
  for (const text of String(stdout ?? "").split("\n")) {
    const isEnd = text.startsWith('{"type":"tool_execution_end",');
    if (!isEnd && !text.startsWith(ASYNC_RESULT_PREFIX)) continue;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (isEnd) {
      const async = event?.result?.details?.async;
      if (async?.state === "running" && event.isError !== true && typeof async.jobId === "string") pending.set(async.jobId, "running");
    } else if (Array.isArray(event?.message?.details?.jobs)) {
      for (const job of event.message.details.jobs) if (typeof job?.jobId === "string") pending.delete(job.jobId);
    }
  }
  const jobs = [];
  for (const [rawId, state] of pending) {
    if (jobs.length >= PROGRESS_LIMITS.maxToolCalls) break;
    const jobId = progressText(rawId, redact, PROGRESS_LIMITS.toolCallIdChars);
    if (jobId) jobs.push({ jobId, state });
  }
  return jobs;
}
const PROGRESS_PREFIX_CHARS = Math.max(...PROGRESS_LINE_PREFIXES.map((p) => p.length));
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

// Normalize, redact the whole value, then cut: a secret can never straddle the cut.
function progressText(value, redact, maxChars) {
  let text = redact(value.replace(CONTROL_CHARS_RE, " ")).trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  }
  return text.length > 0 ? text : null;
}

/**
 * Forwards OMP tool_execution_start/end stdout lines to onEvent as
 * { eventType, stream, payload: { toolName, toolCallId, phase } } and nothing
 * else: args, intent, results, thinking and message text never leave. Chunks may
 * split lines and UTF-16 pairs anywhere; a final line without newline is handled
 * by flush(). State is run-local and bounded (one line buffer <= maxLineBytes, at
 * most maxToolCalls ids of <= toolCallIdChars). The first redaction or callback
 * failure stops forwarding and is reported in summary().failure; feed/flush never
 * throw. The thrown cause is never read.
 */
export function createProgressForwarder(onEvent, receiver, redact, limits = {}) {
  const maxLineBytes = limits.maxLineBytes ?? PROGRESS_LIMITS.maxLineBytes;
  const maxToolCalls = limits.maxToolCalls ?? PROGRESS_LIMITS.maxToolCalls;
  const stats = { delivered: 0, toolCalls: 0, deduplicated: 0, ignoredLines: 0, oversizedLines: 0, capExceeded: false, droppedEvents: 0, failure: null };
  const phases = new Map(); // raw toolCallId -> 1 started | 2 ended
  const jobResults = new Set(); // sanitized "jobId\0status" already delivered
  let decoder = null;
  let mode = "head"; // "head": deciding on the prefix; "capture": tool line; "skip": rest of line ignored
  let head = "";
  let parts = [];
  let bytes = 0;

  function append(text) {
    if (text.length === 0) return;
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxLineBytes) {
      stats.oversizedLines += 1;
      mode = "skip";
      parts = [];
      return;
    }
    parts.push(text);
  }

  function take(text, start, stop) {
    if (mode === "skip" || stop <= start) return;
    if (mode === "head") {
      const piece = text.slice(start, Math.min(stop, start + PROGRESS_PREFIX_CHARS - head.length));
      head += piece;
      start += piece.length;
      if (PROGRESS_LINE_PREFIXES.some((p) => head.startsWith(p))) {
        mode = "capture";
        append(head);
        head = "";
      } else if (PROGRESS_LINE_PREFIXES.some((p) => p.startsWith(head))) {
        return; // still undecided: the chunk ended inside the prefix
      } else {
        mode = "skip";
        head = "";
        return;
      }
    }
    if (mode === "capture") append(text.slice(start, stop));
  }

  async function deliver(event) {
    try {
      await Reflect.apply(onEvent, receiver, [event]);
      stats.delivered += 1;
    } catch {
      stats.failure = "callback_failed";
    }
  }

  // Background job completion: only jobId/status/durationMs leave; content, label and
  // type (command text, job output) never do. Bounded by maxToolCalls like tool ids.
  async function handleAsyncResult(jobs) {
    if (!Array.isArray(jobs)) {
      stats.ignoredLines += 1;
      return;
    }
    for (const job of jobs) {
      if (stats.failure) return;
      if (typeof job?.jobId !== "string" || typeof job.status !== "string") {
        stats.ignoredLines += 1;
        continue;
      }
      let jobId;
      let status;
      try {
        jobId = progressText(job.jobId, redact, PROGRESS_LIMITS.toolCallIdChars);
        status = progressText(job.status, redact, PROGRESS_LIMITS.jobStatusChars);
      } catch {
        stats.failure = "sanitizer_failed";
        return;
      }
      if (!jobId || !status) {
        stats.ignoredLines += 1;
        continue;
      }
      const key = `${jobId}\u0000${status}`;
      if (jobResults.has(key)) {
        stats.deduplicated += 1;
        continue;
      }
      if (jobResults.size >= maxToolCalls) {
        stats.capExceeded = true;
        stats.droppedEvents += 1;
        continue;
      }
      jobResults.add(key);
      const payload = { jobId, status };
      if (Number.isFinite(job.durationMs) && job.durationMs >= 0) payload.durationMs = job.durationMs;
      await deliver({ eventType: "async_result", stream: "stdout", payload });
    }
  }

  async function handleLine(text) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      stats.ignoredLines += 1;
      return;
    }
    if (event?.type === "message_end" && event.message?.role === "custom" && event.message.customType === "async-result") {
      await handleAsyncResult(event.message.details?.jobs);
      return;
    }
    const isStart = event?.type === "tool_execution_start";
    const isEnd = event?.type === "tool_execution_end";
    const id = event?.toolCallId;
    if (
      (!isStart && !isEnd) ||
      typeof id !== "string" || id.length === 0 || id.length > PROGRESS_LIMITS.toolCallIdChars ||
      typeof event.toolName !== "string" ||
      (isEnd && event.isError !== undefined && typeof event.isError !== "boolean")
    ) {
      stats.ignoredLines += 1;
      return;
    }
    const seen = phases.get(id);
    // Same call and phase, or anything after the call's terminal end: deliver once.
    if (seen !== undefined && (seen & 2 || (isStart && seen & 1))) {
      stats.deduplicated += 1;
      return;
    }
    if (seen === undefined && phases.size >= maxToolCalls) {
      stats.capExceeded = true;
      stats.droppedEvents += 1;
      return;
    }
    let toolName;
    let toolCallId;
    try {
      toolName = progressText(event.toolName, redact, PROGRESS_LIMITS.toolNameChars);
      toolCallId = progressText(id, redact, PROGRESS_LIMITS.toolCallIdChars);
    } catch {
      stats.failure = "sanitizer_failed";
      return;
    }
    if (!toolName || !toolCallId) {
      stats.ignoredLines += 1;
      return;
    }
    if (seen === undefined) stats.toolCalls += 1;
    phases.set(id, (seen ?? 0) | (isStart ? 1 : 2));
    // A backgrounded call ends with details.async.state="running": admitted, not completed.
    const async = isEnd ? event.result?.details?.async : undefined;
    if (isEnd && async?.state === "running" && event.isError !== true) {
      const payload = { toolName, toolCallId, phase: "backgrounded" };
      try {
        const jobId = typeof async.jobId === "string" ? progressText(async.jobId, redact, PROGRESS_LIMITS.toolCallIdChars) : null;
        if (jobId) payload.jobId = jobId;
      } catch {
        stats.failure = "sanitizer_failed";
        return;
      }
      await deliver({ eventType: "tool_result", stream: "stdout", payload });
      return;
    }
    const phase = isStart ? "started" : event.isError === true ? "failed" : "completed";
    await deliver({ eventType: isStart ? "tool_call" : "tool_result", stream: "stdout", payload: { toolName, toolCallId, phase } });
  }

  async function endLine() {
    const captured = mode === "capture" ? parts.join("") : null;
    mode = "head";
    head = "";
    parts = [];
    bytes = 0;
    if (captured !== null) await handleLine(captured);
  }

  async function consume(text) {
    let pos = 0;
    while (pos < text.length && !stats.failure) {
      const nl = text.indexOf("\n", pos);
      take(text, pos, nl === -1 ? text.length : nl);
      if (nl === -1) return;
      await endLine();
      pos = nl + 1;
    }
  }

  return {
    async feed(chunk) {
      if (stats.failure) return;
      try {
        if (typeof chunk === "string") await consume(chunk);
        else await consume((decoder ??= new TextDecoder()).decode(chunk, { stream: true }));
      } catch {
        stats.failure ??= "internal_error";
      }
    },
    async flush() {
      if (stats.failure) return;
      try {
        if (decoder) await consume(decoder.decode());
        if (!stats.failure) await endLine();
      } catch {
        stats.failure ??= "internal_error";
      }
    },
    summary() {
      return { ...stats };
    },
  };
}

// ---------------------------------------------------------------- results

function semantics(runOutcome) {
  // A successful process run is not an issue disposition and not an approval:
  // OMP records those through the Paperclip API; this adapter never infers them.
  return { runOutcome, issueCompletion: "not_asserted_by_adapter", approval: "not_asserted_by_adapter" };
}

function refusalResult(err) {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorCode: err.code,
    errorMessage: err.message,
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    resultJson: { adapter: ADAPTER_TYPE, ...semantics("not_started") },
  };
}

function label(value, redact) {
  return typeof value === "string" ? redact(value).slice(0, MAX_LABEL_CHARS) : null;
}

// Sums every assistant turn of the selected terminal agent_end exactly once
// (message_end events are never summed, so duplicates cannot double-count).
// Tokens are all-or-nothing: an invalid turn or a run spanning several
// models/providers omits metering with a fixed reason. A missing or invalid
// cost omits only costUsd. Returned diagnostics never change the run outcome.
function runUsage(messages) {
  const assistants = messages.filter((m) => m?.role === "assistant");
  const total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let costUsd = 0;
  for (const m of assistants) {
    if (m.provider !== assistants[0].provider || m.model !== assistants[0].model) return { usageOmitted: "multiple_models" };
    const u = m.usage;
    if (!u || typeof u !== "object") return { usageOmitted: "usage_invalid" };
    for (const [key, field] of [["inputTokens", "input"], ["outputTokens", "output"], ["cachedInputTokens", "cacheRead"]]) {
      if (!Number.isSafeInteger(u[field]) || u[field] < 0) return { usageOmitted: "usage_invalid" };
      total[key] += u[field];
      if (!Number.isSafeInteger(total[key])) return { usageOmitted: "usage_invalid" };
    }
    const cost = u.cost?.total;
    costUsd = typeof cost === "number" && cost >= 0 ? costUsd + cost : NaN;
  }
  return Number.isFinite(costUsd) ? { usage: total, costUsd } : { usage: total, costOmitted: "cost_invalid" };
}

function mapRunResult(proc, parsed, redactor, publication) {
  const { redact } = redactor;
  const stderrRaw = String(proc.stderr ?? "");
  const stderrCaptureMayBeTruncated = stderrRaw.length >= MAX_CAPTURE_BYTES;
  const diagnostics = {
    eventCount: parsed.eventCount,
    eventCapExceeded: parsed.eventCapExceeded,
    finalsInvalidated: parsed.finalsInvalidated,
    malformedLines: parsed.malformedLines,
    oversizedLines: parsed.oversizedLines,
    truncatedTail: parsed.truncatedTail,
    captureTruncated: parsed.captureTruncated,
    streamBytesSeen: parsed.streamBytesSeen,
    capturedBytes: parsed.capturedBytes,
    stderrCaptureMayBeTruncated,
    finalTextTruncated: parsed.finalTextTruncated,
    damage: parsed.damage,
    spawnRecordFailed: publication.spawnRecordFailed,
    logPublicationFailed: publication.logFailed,
  };
  // Present only when the platform supplied ctx.onEvent (absent hook: unchanged shape).
  if (publication.progress) diagnostics.progressEvents = publication.progress;
  const msg = parsed.finalMessage;
  const knownStop = KNOWN_STOP_REASONS.has(msg?.stopReason) ? msg.stopReason : null;
  const base = {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut === true,
    sessionId: null,
    provider: label(msg?.provider, redact),
    model: label(msg?.model, redact),
  };
  const metered = msg ? runUsage(parsed.final.messages) : null;
  if (metered?.usage) {
    base.usage = metered.usage;
    base.usageBasis = "per_run";
    if (metered.costUsd !== undefined) base.costUsd = metered.costUsd;
  }
  if (metered?.usageOmitted) diagnostics.usageOmitted = metered.usageOmitted;
  if (metered?.costOmitted) diagnostics.costOmitted = metered.costOmitted;

  let errorCode = null;
  let errorMessage = null;
  if (proc.timedOut) {
    errorCode = "omp_timeout";
    errorMessage = "OMP exceeded the native timeout and was stopped by Paperclip.";
  } else if (proc.signal) {
    errorCode = "omp_signal";
    errorMessage = `OMP exited on signal ${proc.signal}.`;
  } else if (isOmpDeadlineEvidence(proc, parsed, msg, knownStop, publication)) {
    // OMP stopped itself at --max-time; the native timer did not fire, so
    // timedOut stays false and no retry is implied.
    errorCode = "omp_deadline_exceeded";
    errorMessage = "OMP stopped at its --max-time deadline before finishing.";
    diagnostics.deadline = { source: "omp_max_time", nativeTimerFired: false };
    const jobs = undeliveredJobs(proc.stdout, redact);
    if (jobs.length > 0) diagnostics.undeliveredJobs = jobs;
  } else if (proc.exitCode !== 0) {
    errorCode = "omp_exit_nonzero";
    errorMessage = `OMP exited with code ${proc.exitCode}.`;
  } else if (publication.spawnRecordFailed) {
    errorCode = "omp_spawn_record_failed";
    errorMessage = "Paperclip could not record the OMP process metadata; the run is not treated as successful.";
  } else if (publication.logFailed) {
    errorCode = "omp_log_publication_failed";
    errorMessage = "Publishing OMP output to the run log failed; the run is not treated as successful.";
  } else if (publication.progress?.failure) {
    errorCode = "omp_progress_event_failed";
    errorMessage = `Delivering OMP progress events to the run event hook failed (${publication.progress.failure}); the run is not treated as successful.`;
  } else if (parsed.damage.length > 0) {
    errorCode = "omp_output_damaged";
    errorMessage = `OMP output capture is damaged or incomplete (${parsed.damage.join(", ")}); the run is not treated as successful.`;
  } else if (!parsed.final) {
    errorCode = "omp_final_event_missing";
    errorMessage = "OMP exited 0 but no terminal agent_end event ended the output.";
  } else if (!msg) {
    errorCode = "omp_final_message_missing";
    errorMessage = "OMP agent_end carried no assistant message.";
  } else if (knownStop === null) {
    errorCode = "omp_stop_reason_unknown";
    errorMessage = "OMP final assistant message has a missing or unknown stopReason.";
  } else if (knownStop !== SUCCESS_STOP_REASON) {
    errorCode = `omp_stop_${knownStop}`;
    errorMessage = `OMP final assistant message stopped with "${knownStop}".`;
  }

  const resultJson = {
    adapter: ADAPTER_TYPE,
    ...semantics(errorCode ? "failed" : "succeeded"),
    stopReason: knownStop,
    ompSessionId: label(parsed.sessionId, redact),
    diagnostics,
  };
  if (errorCode) {
    // Redact the whole capture before cutting; omit the excerpt when the
    // capture head may have been dropped mid-secret.
    resultJson.stderrExcerpt = stderrCaptureMayBeTruncated ? null : redact(stderrRaw).slice(-STDERR_EXCERPT_CHARS);
    if (typeof msg?.errorMessage === "string") resultJson.providerError = redact(msg.errorMessage).slice(0, STDERR_EXCERPT_CHARS);
    return { ...base, errorCode, errorMessage, summary: parsed.finalText || null, resultJson };
  }
  return { ...base, summary: parsed.finalText, resultJson };
}

// ---------------------------------------------------------------- adapter

function buildEnv(ctx, configEnv, taskId, timeoutSec) {
  const env = {};
  // Config env first; Paperclip runtime keys are always re-applied after it.
  for (const [key, value] of Object.entries(configEnv)) env[key] = value;
  Object.assign(env, buildPaperclipEnv(ctx.agent), buildRuntimeToolsEnv(ctx.runtimeTools));
  env.PAPERCLIP_RUN_ID = ctx.runId;
  env.PAPERCLIP_TASK_ID = taskId;
  const wakeReason = readId(ctx.context?.wakeReason);
  // Run-scoped identity keys come only from the runtime, never from config.
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  else delete env.PAPERCLIP_WAKE_REASON;
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  // DL-FIX: absolute OMP deadline (pre-spawn + timeoutSec), applied after config.env so config cannot override.
  env.OMP_PAPERCLIP_DEADLINE_AT = new Date(Date.now() + timeoutSec * 1000).toISOString();
  return env;
}

function buildArgs(cfg) {
  const args = ["-p", "--mode", "json", "--no-session", "--cwd", cfg.cwd, "--max-time", String(cfg.timeoutSec)];
  if (cfg.approvalMode) args.push("--approval-mode", cfg.approvalMode);
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.thinking) args.push("--thinking", cfg.thinking);
  return args;
}

// The exact run scratch: paperclipScratch.dir must equal config.env
// PAPERCLIP_RUN_SCRATCH_DIR; anything else is "no scratch" (never a fallback).
function resolveScratchDir(ctx) {
  const meta = ctx.context?.paperclipScratch;
  const envDir = ctx.config?.env?.PAPERCLIP_RUN_SCRATCH_DIR;
  if (!meta || meta.type !== "heartbeat_run" || typeof meta.dir !== "string") return null;
  return meta.dir === envDir ? meta.dir : null;
}

// D1f: run-scoped desired keys arrive through the mention channel
// (heartbeat applyRunScopedMentionedSkillKeys -> config.paperclipSkillSync).
function configuredSkillKeys(config) {
  const raw = config?.paperclipSkillSync?.desiredSkills;
  if (!Array.isArray(raw)) return [];
  const keys = raw.map((d) => (typeof d === "string" ? d : d?.key)).filter((k) => typeof k === "string" && k.length > 0);
  return [...new Set(keys)];
}

const NO_RUNTIME_SKILLS = Object.freeze({ status: "none", args: [], dir: null, delivered: [], cleanup: async () => ({ ok: true }) });

// D1e: configured (desired keys) vs this run's actual delivery; never "installed",
// no OS sandbox claim. spawnBound only when the runner observed the spawn.
function runtimeSkillsEvidence(configured, prepared, spawnObserved, cleanup) {
  const evidence = {
    mode: "run_scoped",
    configured,
    delivered: prepared.delivered.map((d) => ({
      key: d.key,
      versionId: d.versionId,
      effectiveName: d.effectiveName,
      readable: d.readable === true,
      spawnBound: spawnObserved === true,
    })),
    baseline: "preserved",
    isolation: "none",
  };
  if (cleanup && cleanup.ok !== true) evidence.cleanupWarning = String(cleanup.warning ?? "runtime skills cleanup failed");
  return evidence;
}

// MODEL-F: `omp models` is the read-only enumeration (synthetic HOME prints "No models available").
// Bounded: shell:false, hard 5s timer (resolves without waiting for stdio close), 256 KiB stdout cap,
// SIGKILL on timeout/overflow; any failure, timeout or unparsed output -> [] (list unavailable).
// One in-flight/settled result is shared per process for 60s so callers never stack slow probes.
const MODEL_LIST_TIMEOUT_MS = 5_000;
const MODEL_LIST_MAX_STDOUT = 256 * 1024;
const MODEL_LIST_TTL_MS = 60_000;
const modelListCache = new Map();
async function probeOmpModels(ompCommand) {
  const { spawn } = await import("node:child_process");
  const stdout = await new Promise((resolve) => {
    let child;
    let out = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === "" && child && child.exitCode === null) {
        try { child.kill("SIGKILL"); } catch {}
      }
      try { child?.stdout?.destroy(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(""), MODEL_LIST_TIMEOUT_MS);
    timer.unref?.();
    try {
      // F2: never hand Paperclip run credentials/context to the probe; HOME/PATH/provider config stay.
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PAPERCLIP_")));
      child = spawn(ompCommand, ["models"], { shell: false, env, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish("");
      return;
    }
    child.unref();
    child.on("error", () => finish(""));
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      if (out.length > MODEL_LIST_MAX_STDOUT) finish("");
    });
    child.on("close", (code) => finish(code === 0 ? out : ""));
  });
  const ids = new Set();
  for (const raw of stdout.split("\n")) {
    const m = /^\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.:@-]+)(?:\s|$)/.exec(raw);
    if (m) ids.add(m[1]);
  }
  return [...ids].map((id) => ({ id, label: id }));
}
function defaultListOmpModels(ompCommand) {
  const now = Date.now();
  let cached = modelListCache.get(ompCommand);
  if (!cached || now - cached.at > MODEL_LIST_TTL_MS) {
    cached = { at: now, promise: probeOmpModels(ompCommand).catch(() => []) };
    modelListCache.set(ompCommand, cached);
  }
  return cached.promise;
}

// M5: requested vs actual (from the last assistant message); OMP fuzzy-matches, so never fold a mismatch into success.
// F1: a provider-qualified request ("p/m") matches only that exact provider/model; a bare id matches the actual's last segment.
function modelSelection(requested, stdout) {
  let actual = null;
  for (const raw of String(stdout ?? "").split("\n")) {
    if (!raw.includes("\"message_end\"")) continue;
    try {
      const ev = JSON.parse(raw);
      const msg = ev?.message;
      if (ev?.type === "message_end" && msg?.role === "assistant" && typeof msg.model === "string") {
        actual = typeof msg.provider === "string" ? `${msg.provider}/${msg.model}` : msg.model;
      }
    } catch {}
  }
  if (!requested) return { source: "inherited_omp_default", requestedModel: null, actualModel: actual, mismatch: null };
  const matched = actual !== null &&
    (requested.includes("/") ? actual === requested : actual.split("/").pop() === requested);
  return { source: "agent_config", requestedModel: requested, actualModel: actual,
    mismatch: actual === null ? null : !matched, actualUnknown: actual === null };
}

export function createServerAdapter(deps = {}) {
  // Installation authority only: never read this from a run's ctx.config or env.
  const ompCommand = deps.ompCommand;
  if (typeof ompCommand !== "string" || !path.isAbsolute(ompCommand) || ompCommand.includes("\u0000")) {
    throw new Error("invalid_installation_command");
  }
  const runChildProcess = deps.runChildProcess ?? nativeRunChildProcess;
  // MODEL-F: read-only discovery. [] means unavailable (never throws); then explicit ids pass through.
  const listOmpModels = deps.listOmpModels ?? (() => defaultListOmpModels(ompCommand));
  async function listModels() {
    try {
      const list = await listOmpModels();
      return Array.isArray(list) ? list.filter((m) => m && typeof m.id === "string") : [];
    } catch {
      return [];
    }
  }
  async function getConfigSchema() {
    const models = await listModels();
    return {
      fields: [
        { key: "model", type: "combobox", label: "Model", required: false, freeText: true, allowCustom: true,
          options: models.map((m) => ({ value: m.id, label: m.label ?? m.id })),
          hint: "Explicit OMP model id; unset inherits the OMP default." },
      ],
    };
  }
  const statPath = deps.statPath ?? ((p) => fs.stat(p));
  const accessExecutable = deps.accessExecutable ?? ((p) => fs.access(p, fsConstants.X_OK));
  // Trusted default-provider OMP config to preserve under --config (D1b): ask the OMP CLI
  // for skills.customDirectories with the exact spawn command/cwd/env; null = untrusted.
  const runOmpBaselineCommand = deps.runOmpBaselineCommand;
  const readOmpSkillBaseline =
    deps.readOmpSkillBaseline ??
    ((args) => readOmpSkillBaselineFromCli(runOmpBaselineCommand ? { ...args, runCommand: runOmpBaselineCommand } : args));

  async function execute(ctx) {
    let redactor;
    let secrets;
    try {
      secrets = collectSecrets(ctx);
      redactor = compileRedactor(secrets);
    } catch {
      // Nothing prepared and no redactor: a fixed result; the cause is never read.
      return refusalResult(new Refusal("omp_redactor_prepare_failed", "Preparing secret redaction failed before OMP started."));
    }
    let cfg;
    let procStdout = null;
    let taskId;
    let prompt;
    let configured = [];
    let env;
    let scratchDir = null;
    let prepared = NO_RUNTIME_SKILLS;
    let args;
    let streamRedactor;
    let streamParser;
    let streamState;
    let progress = null;
    try {
      cfg = validateConfig(ctx.config);
      assertLocalExecutionTarget(ctx);
      // The selected directory is the single cwd for argv --cwd, onMeta and the runner.
      cfg.cwd = await assertCwd(statPath, selectCwd(ctx.context, cfg.cwd));
      taskId = resolveTaskIdentity(ctx.context);
      // M4: a non-empty discovered list is authoritative; an empty list allows free input (M5 records the outcome).
      if (cfg.model) {
        const known = await listModels();
        if (known.length > 0 && !known.some((m) => m.id === cfg.model)) {
          throw new Refusal("omp_model_unavailable", "config.model is not in the discovered OMP model list.");
        }
      }
      const sections = selectPaperclipPromptSections(ctx.context, { includeExecutionContract: true });
      prompt = redactor.redact(joinPromptSections([sections.taskContextNote, sections.wakePrompt]));
      if (prompt.trim().length === 0) throw new Refusal("omp_prompt_empty", "Paperclip prompt sections are empty for this run.");
      // Preflight only: a later abort is handled by the native owner, not proven here.
      if (ctx.signal?.aborted) throw new Refusal("omp_cancelled_before_spawn", "Run was cancelled before OMP started.");
      // D1a/b/c: stage desired skills in this execute's exclusive scratch subdir;
      // any refusal has already removed partial staging and spawns nothing.
      configured = configuredSkillKeys(ctx.config);
      scratchDir = resolveScratchDir(ctx);
      // F1: every dispatch requires the exact, absolute, existing run scratch.
      const scratchStat = scratchDir && scratchDir.startsWith("/") ? await fs.stat(scratchDir).catch(() => null) : null;
      if (!scratchStat?.isDirectory()) {
        scratchDir = null;
        throw new Refusal("omp_skills_scratch_missing", "The exact Paperclip run scratch directory is missing.");
      }
      // The baseline reader sees the same env object the spawn uses (inherited + config.env).
      env = buildEnv(ctx, cfg.env, taskId, cfg.timeoutSec);
      // D1g / B-SCRATCH-01: the child's temp dir is the exact run scratch.
      env.TMPDIR = scratchDir;
      if (configured.length > 0) {
        const baseline = await readOmpSkillBaseline({ command: ompCommand, cwd: cfg.cwd, env }).catch(() => null);
        prepared = await prepareRuntimeSkills({ config: ctx.config, scratchDir, executionId: randomUUID(), baseline });
      }
      // F2: re-check cancellation after staging; prepared dirs are cleaned below.
      if (ctx.signal?.aborted) throw new Refusal("omp_cancelled_before_spawn", "Run was cancelled before OMP started.");
      // Still before dispatch: any throw here must also leave bootstrap evidence.
      args = [...buildArgs(cfg), ...prepared.args];
      streamRedactor = createStreamRedactor(secrets, (stream, chunk) => ctx.onLog(stream, chunk));
      streamParser = createOmpOutputParser({ maxLineBytes: DEFAULT_MAX_LINE_BYTES, maxEvents: DEFAULT_MAX_EVENTS });
      // S2: ctx.onEvent is read exactly once, before dispatch, so a throwing getter or
      // a non-callable hook is a bootstrap refusal; absent means no progress forwarding.
      const onEvent = ctx.onEvent;
      if (onEvent !== undefined && onEvent !== null) {
        if (typeof onEvent !== "function") throw new Refusal("omp_event_hook_invalid", "The run event hook is not callable; OMP was not started.");
        progress = createProgressForwarder(onEvent, ctx, redactor.redact);
      }
      streamState = { feedFailed: false, hash: createHash("sha256"), hashFailed: false };
    } catch (caught) {
      // OMP was never dispatched: a non-Refusal cause becomes a fixed, bounded refusal
      // (raw message withheld) so recovery sees bootstrap, not an execution failure.
      const err =
        caught instanceof Refusal || caught instanceof RuntimeSkillRefusal
          ? caught
          : new Refusal("omp_preflight_failed", "OMP preflight failed before OMP started.");
      // D1d: surface every failed cleanup (this execute's prepared dir and any staging
      // cleanup carried by the refusal); the refusal code stays authoritative.
      const ownCleanup = await prepared.cleanup().catch((e) => ({ ok: false, warning: `runtime skills cleanup failed: ${e?.message ?? e}` }));
      const failedCleanups = [err.cleanupResult, ownCleanup].filter((c) => c && c.ok !== true);
      const result = refusalResult(err);
      if (failedCleanups.length > 0) {
        const warning = failedCleanups.map((c) => String(c.warning ?? "runtime skills cleanup failed")).join("; ");
        result.resultJson.runtimeSkills = runtimeSkillsEvidence(configured, prepared, false, { ok: false, warning });
      }
      return redactor.sanitize(result);
    }

    const publication = { spawnObserved: false, spawnRecordFailed: false, logFailed: false, progress: null };
    const flushLogs = async () => {
      try {
        await streamRedactor.flush();
      } catch {
        publication.logFailed = true;
      }
    };

    let result;
    let cleaned;
    try {
    {
      try {
        const onMeta = ctx.onMeta;
        if (onMeta) await Reflect.apply(onMeta, ctx, [
          redactor.sanitize({
            adapterType: ADAPTER_TYPE,
            command: ompCommand,
            cwd: cfg.cwd,
            commandArgs: args,
            commandNotes: ["prompt delivered on stdin", "--no-session baseline: no OMP session is persisted or resumed"],
            env: redactEnvForLogs(env),
            promptMetrics: { promptChars: prompt.length },
          })],
        );
      } catch {
        // Before dispatch: OMP never started; the raw cause is not surfaced. finally cleans.
        result = refusalResult(new Refusal("omp_meta_record_failed", "Recording run metadata failed before OMP started."));
      }
    }

    // F2: cancellation after onMeta still refuses before dispatch; finally cleans.
    // onMeta's own refusal keeps priority; a throwing re-check is a fixed preflight refusal.
    if (!result) {
      try {
        if (ctx.signal?.aborted) result = refusalResult(new Refusal("omp_cancelled_before_spawn", "Run was cancelled before OMP started."));
      } catch {
        result = refusalResult(new Refusal("omp_preflight_failed", "OMP preflight failed before OMP started."));
      }
    }
    let proc;
    if (!result) try {
      proc = await runChildProcess(ctx.runId, ompCommand, args, {
        cwd: cfg.cwd,
        env,
        // OMP stops itself at --max-time; the native timeout is the hard backstop.
        timeoutSec: cfg.timeoutSec + cfg.graceSec,
        graceSec: cfg.graceSec,
        onLog: async (stream, chunk) => {
          if (stream === "stdout") {
            // ADAPT-OUT-3: the raw chunk feeds the stream parser before redaction.
            try {
              streamParser.feed(chunk);
            } catch {
              streamState.feedFailed = true;
            }
            try {
              streamState.hash.update(chunk);
            } catch {
              streamState.hashFailed = true;
            }
          }
          try {
            await streamRedactor.write(stream, chunk);
          } catch {
            publication.logFailed = true;
          }
          // After the raw log path; never throws (failures land in summary().failure).
          if (stream === "stdout" && progress) await progress.feed(chunk);
        },
        // Async so a synchronous throw becomes a handled rejection and the
        // native registration that follows onSpawn always runs.
        onSpawn: async (meta) => {
          publication.spawnObserved = true;
          try {
            await ctx.onSpawn?.(meta);
          } catch {
            publication.spawnRecordFailed = true;
          }
        },
        // Replaces the native console.warn({ err }) default; must never throw.
        onLogError: () => {
          publication.logFailed = true;
        },
        stdin: prompt,
      });
    } catch {
      // Dispatched: OMP may or may not have started; never report not_started.
      await flushLogs();
      result = {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "omp_runner_rejected",
        errorMessage: "The native runner rejected after dispatch; whether OMP started is uncertain.",
        resultJson: {
          adapter: ADAPTER_TYPE,
          ...semantics("uncertain"),
          diagnostics: { spawnObserved: publication.spawnObserved, spawnRecordFailed: publication.spawnRecordFailed },
        },
      };
    }
    if (!result) {
      await flushLogs();
      if (progress) {
        await progress.flush();
        publication.progress = progress.summary();
      }
      procStdout = proc.stdout;
      const parsed = finishStreamParse(streamParser, streamState, proc.stdout, redactor.redact);
      result = mapRunResult(proc, parsed, redactor, publication);
    }
    } finally {
      // D1d: only after the runner settled; a cleanup failure is a warning only.
      cleaned = await prepared.cleanup();
    }
    if (result.resultJson) {
      result.resultJson.runtimeSkills = runtimeSkillsEvidence(configured, prepared, publication.spawnObserved, cleaned);
      result.resultJson.modelSelection = modelSelection(cfg?.model ?? null, procStdout);
    }
    return redactor.sanitize(result);
  }

  async function testEnvironment(ctx) {
    const checks = [];
    try {
      const cfg = validateConfig(ctx.config);
      await assertCwd(statPath, { ...CONFIG_CWD, value: cfg.cwd });
      checks.push({ code: "omp_config_valid", level: "info", message: "Adapter config is valid." });
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      checks.push({ code: err.code, level: "error", message: err.message });
    }
    try {
      await accessExecutable(ompCommand);
      checks.push({ code: "omp_command_executable", level: "info", message: `${ompCommand} is executable.` });
    } catch {
      checks.push({ code: "omp_command_missing", level: "error", message: `${ompCommand} is not executable.` });
    }
    const status = checks.some((c) => c.level === "error") ? "fail" : "pass";
    return { adapterType: ADAPTER_TYPE, status, checks, testedAt: new Date().toISOString() };
  }

  return {
    type: ADAPTER_TYPE,
    execute,
    listModels,
    getConfigSchema,
    testEnvironment,
    // Snapshot-only hooks (skills.mjs): no install, mount or delivery to OMP runs yet.
    listSkills: listOmpSkills,
    syncSkills: syncOmpSkills,
    // P0-C fails closed on unreadable skill sources (D1b), so Paperclip must
    // materialize runtime skills before launch (plan r20).
    requiresMaterializedRuntimeSkills: true,
    supportsLocalAgentJwt: true,
    runtimeToolDelivery: "environment",
  };
}
