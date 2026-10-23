// ADAPT-OUT-RED-5: JSON safety of stdout log redaction, plus frozen
// output-classification guards using independently synthetic events.
// G1 (expected RED where noted): redacting an OMP NDJSON stdout line must keep
//   every line parseable JSON with the same `type`, and no secret form may
//   survive in any decoded string.
// G2 (synthetic deadline shape), G3 (synthetic advisor shape), G4 (planner ruling: oversized
//   agent_end stays fail-closed; limit not raised) are GREEN guards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_CAPTURE_BYTES } from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE, createServerAdapter, createStreamRedactor, redactText } from "./adapter-fixture.mjs";

const line = (obj) => `${JSON.stringify(obj)}\n`;
const assistant = (text, extra = {}) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "anthropic",
  model: "claude-test",
  usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 0, totalTokens: 21, cost: { total: 0.0123 } },
  stopReason: "stop",
  timestamp: 1,
  ...extra,
});
const SESSION_HEADER = { type: "session", version: 3, id: "omp-session-1", timestamp: "2026-10-12T00:00:00Z", cwd: "/probe/omp-replay" };
const headStdout = (msg) =>
  line(SESSION_HEADER) +
  line({ type: "agent_start" }) +
  line({ type: "turn_start" }) +
  line({ type: "message_end", message: msg }) +
  line({ type: "turn_end", message: msg, toolResults: [] });
const finalLine = (msg) => line({ type: "agent_end", messages: [msg], isTerminal: true, yielded: true });
const stdoutFor = (msg) => headStdout(msg) + finalLine(msg);
const okStdout = (text = "All done.") => stdoutFor(assistant(text));
const deadlineMsg = () => assistant("partial work", { stopReason: "aborted", errorMessage: "Deadline exceeded" });
const advisorMsg = (overrides = {}) => ({
  role: "custom",
  customType: "advisor",
  content: '<advisory advisor="Claim Verify" severity="concern">check the claim</advisory>',
  display: true,
  attribution: "agent",
  details: { notes: [{ note: "check the claim", severity: "concern", advisor: "Claim Verify" }] },
  timestamp: 946684800000,
  ...overrides,
});
const advisorPair = (msg) => line({ type: "message_start", message: msg }) + line({ type: "message_end", message: msg });
const ADVISOR_YIELDED = line({ type: "advisor_yielded" });
const chunked = (text, size = 65_521) => {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
};

// ------------------------------------------------------------------ G1 redaction JSON safety

const uEscape = (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
// Python json.dumps(ensure_ascii=True): non-ASCII as \uXXXX.
const pyAscii = (json) => json.replace(/[\u007f-\uffff]/g, uEscape);
// Go encoding/json default: <, >, & as \u003c, \u003e, \u0026.
const goEscape = (json) => json.replace(/[<>&]/g, uEscape);

const BASE = "sk-live-SECRET-0123456789abcdef";
const mid = (s) => line({ type: "message_update", text: `before ${s} after` });

const CASES = [
  { form: "mid_string", secret: BASE, line: mid },
  { form: "adjacent_close_quote", secret: BASE, line: (s) => line({ type: "message_update", text: `before ${s}` }) },
  { form: "adjacent_close_quote_trailing_backslash", secret: `${BASE}\\`, line: (s) => line({ type: "message_update", text: `path ${s}` }) },
  { form: "escape_quote", secret: `${BASE}"q`, line: mid },
  { form: "escape_backslash", secret: `${BASE}\\b`, line: mid },
  { form: "escape_unicode_nonascii_python", secret: `${BASE}\u00e9\u2603`, line: (s) => pyAscii(mid(s)) },
  { form: "escape_unicode_ascii_go", secret: `${BASE}&<1>`, line: (s) => goEscape(mid(s)) },
  { form: "nested_json_double_escape", secret: `${BASE}"q`, line: (s) => line({ type: "tool_execution_end", result: JSON.stringify({ out: `x ${s} y` }) }) },
  // Secret begins with a JSON escape letter; the line carries "\n" + rest, not the secret.
  { form: "after_escape_sequence", secret: `n${BASE}`, line: () => line({ type: "message_update", text: `a\n${BASE}` }) },
  {
    form: "multi_in_line",
    secret: BASE,
    line: (s) => line({ type: "message_update", text: `${s} and ${s}`, args: { a: s, nested: JSON.stringify({ k: s }) } }),
  },
];

function secretForms(secret) {
  const once = JSON.stringify(secret).slice(1, -1);
  const forms = new Set([secret, once, pyAscii(once), goEscape(once), JSON.stringify(once).slice(1, -1)]);
  return [...forms].filter((f) => f.length > 0);
}

function decodedStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) decodedStrings(v, out);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      decodedStrings(v, out);
    }
  }
  return out;
}

function assertJsonSafe(outText, srcText, secret, label) {
  const src = srcText.split("\n");
  const got = outText.split("\n");
  assert.equal(got.length, src.length, `${label}: line count changed`);
  const forms = secretForms(secret);
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "") {
      assert.equal(got[i], "", `${label}: line ${i} should stay empty`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(got[i]);
    } catch (err) {
      assert.fail(`${label}: line ${i} is no longer JSON (${err.message}): ${got[i].slice(0, 240)}`);
    }
    assert.equal(parsed?.type, JSON.parse(src[i]).type, `${label}: line ${i} type changed`);
    for (const s of decodedStrings(parsed)) {
      for (const f of forms) assert.ok(!s.includes(f), `${label}: line ${i} still carries secret form ${JSON.stringify(f)}`);
    }
  }
}

async function streamRedact(secret, chunks) {
  const out = [];
  const r = createStreamRedactor([secret], async (stream, chunk) => {
    assert.equal(stream, "stdout");
    out.push(chunk);
  });
  for (const chunk of chunks) await r.write("stdout", chunk);
  await r.flush();
  return out.join("");
}

for (const c of CASES) {
  const stdout = line(SESSION_HEADER) + c.line(c.secret) + finalLine(assistant("done"));

  test(`G1 ${c.form} [redactText]`, () => {
    assertJsonSafe(redactText(stdout, [c.secret]), stdout, c.secret, `${c.form}/redactText`);
  });

  test(`G1 ${c.form} [createStreamRedactor, every 2-chunk split + 1-char chunks]`, async () => {
    const start = line(SESSION_HEADER).length;
    const end = stdout.length - finalLine(assistant("done")).length;
    for (let i = start; i <= end; i++) {
      const out = await streamRedact(c.secret, [stdout.slice(0, i), stdout.slice(i)]);
      assertJsonSafe(out, stdout, c.secret, `${c.form}/stream split@${i}`);
    }
    assertJsonSafe(await streamRedact(c.secret, [...stdout]), stdout, c.secret, `${c.form}/stream 1-char`);
  });
}

// ------------------------------------------------------------------ adapter guards G2-G4

const WORKDIR = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "omp-replay-guard-"));
process.on("exit", () => rmSync(WORKDIR, { recursive: true, force: true }));
function baseCtx() {
  const scratchDir = mkdtempSync(path.join(WORKDIR, "run-scratch-"));
  return {
    runId: "run-replay-1",
    agent: { id: "agent-1", companyId: "co-1", name: "OMP", adapterType: ADAPTER_TYPE, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: "/probe/omp-replay", timeoutSec: 120, graceSec: 5, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir } },
    context: {
      taskId: "iss_1",
      issueId: "iss_1",
      wakeReason: "issue_assigned",
      paperclipWake: { reason: "issue_assigned", issue: { id: "iss_1", identifier: "LAB-1", title: "Fix widget", status: "todo" } },
      paperclipScratch: { type: "heartbeat_run", dir: scratchDir },
    },
    authToken: "eyJhbGciOiJIUzI1NiJ9.run-jwt-SECRET-0123456789",
    onLog: async () => {},
    onMeta: async () => {},
    onSpawn: async () => {},
  };
}

// Chunks go through opts.onLog; stdout is what native runChildProcess returns (tail capture).
function fakeRunner(script) {
  return async (runId, command, args, opts) => {
    await opts.onSpawn?.({ pid: 4242, processGroupId: 4242, startedAt: "2026-10-12T00:00:00Z" });
    for (const chunk of script.chunks ?? [script.stdout]) await opts.onLog("stdout", chunk);
    return {
      exitCode: "exitCode" in script ? script.exitCode : 0,
      signal: script.signal ?? null,
      timedOut: script.timedOut ?? false,
      stdout: script.stdout,
      stderr: "",
      pid: 4242,
      startedAt: "2026-10-12T00:00:00Z",
    };
  };
}

const runWith = (script) =>
  createServerAdapter({ runChildProcess: fakeRunner(script), statPath: async () => ({ isDirectory: () => true }) }).execute(baseCtx());

test("G2 guard (synthetic deadline): exit 1, stream > MAX_CAPTURE_BYTES, tail capture, aborted 'Deadline exceeded' -> omp_deadline_exceeded, damage []", async () => {
  const parts = [line(SESSION_HEADER)];
  let size = parts[0].length;
  for (let i = 0; size <= MAX_CAPTURE_BYTES + 256 * 1024; i++) {
    const l = line({ type: "message_update", seq: i, text: "u".repeat(16 * 1024) });
    parts.push(l);
    size += l.length;
  }
  parts.push(stdoutFor(deadlineMsg()));
  const full = parts.join("");
  assert.ok(full.length > MAX_CAPTURE_BYTES, "fixture: stream exceeds capture");
  const stdout = full.slice(-MAX_CAPTURE_BYTES);
  assert.notEqual(full[full.length - MAX_CAPTURE_BYTES - 1], "\n", "fixture: tail capture starts mid-line");
  const r = await runWith({ chunks: chunked(full), stdout, exitCode: 1, timedOut: false });
  assert.equal(r.errorCode, "omp_deadline_exceeded", r.errorMessage);
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.resultJson.diagnostics.damage, []);
  assert.equal(r.resultJson.diagnostics.captureTruncated, true);
});

test("G3 guard (synthetic advisor): agent_end -> 2 advisor message pairs -> advisor_yielded -> succeeded", async () => {
  const other = advisorMsg({ customType: "review-advisor", content: '<advisory advisor="Other">ok</advisory>' });
  const stdout = okStdout("Done with advisors.") + advisorPair(advisorMsg()) + advisorPair(other) + ADVISOR_YIELDED;
  const r = await runWith({ stdout, exitCode: 0 });
  assert.equal(r.errorCode ?? null, null, r.errorMessage);
  assert.equal(r.resultJson.runOutcome, "succeeded");
  assert.deepEqual(r.resultJson.diagnostics.damage, []);
});

test("G4 guard (planner ruling, fail-closed): agent_end single line of maxLineBytes+1 -> omp_output_damaged with oversized_lines", async () => {
  const MAX_LINE_BYTES = 1024 * 1024;
  const end = (text) => JSON.stringify({ type: "agent_end", messages: [assistant(text)], isTerminal: true, yielded: true });
  const endLine = end("x".repeat(MAX_LINE_BYTES + 1 - end("").length));
  assert.equal(Buffer.byteLength(endLine, "utf8"), MAX_LINE_BYTES + 1, "fixture: agent_end line is 1MiB+1 bytes");
  const stdout = headStdout(assistant("done")) + endLine + "\n";
  const r = await runWith({ chunks: chunked(stdout), stdout, exitCode: 0 });
  assert.equal(r.errorCode, "omp_output_damaged", r.errorMessage);
  assert.ok(r.resultJson.diagnostics.damage.includes("oversized_lines"), JSON.stringify(r.resultJson.diagnostics.damage));
});
