// ADAPT-OUT-1-v1 frozen RED tests (OUT-DIAG-2; DEC-5 D5-3).
// Frozen: ADAPT-OUT-2/3 must not edit this file; changes need a new planner revision.
// Group "module": streaming parser ./output-parser.mjs (#2-#9 + interface).
// Group "index":  ./index.mjs classification with an injected runChildProcess (#1, #10-#15).
// Synthetic advisor exemption events exercise the protocol shape:
// after agent_end, message_start/message_end carry
// { role: "custom", customType: "advisor", content: "<advisory ...>", display: true, attribution: "agent", details, timestamp },
// then { type: "advisor_yielded" }.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CAPTURE_BYTES } from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE, createServerAdapter } from "./adapter-fixture.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const loadParser = () => import("../output-parser.mjs");

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
const SESSION_HEADER = { type: "session", version: 3, id: "omp-session-1", timestamp: "2026-10-12T00:00:00Z", cwd: "/probe/omp-adapt" };
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
const advisorPair = (start, end = start) => line({ type: "message_start", message: start }) + line({ type: "message_end", message: end });
const ADVISOR_YIELDED = line({ type: "advisor_yielded" });

async function parseAll(chunks, opts = {}) {
  const { createOmpOutputParser } = await loadParser();
  const parser = createOmpOutputParser(opts);
  for (const chunk of chunks) parser.feed(chunk);
  return parser.end();
}

function assertInvalidated(r, label) {
  assert.equal(r.final, null, `${label}: final must be invalidated`);
  assert.equal(r.finalsInvalidated, 1, `${label}: finalsInvalidated`);
}

// ------------------------------------------------------------------ module group

test("module iface: createOmpOutputParser feed/end result shape", async () => {
  const r = await parseAll([okStdout()], { maxLineBytes: 1024 * 1024, maxEvents: 50_000 });
  assert.equal(r.final?.type, "agent_end");
  assert.equal(r.sessionId, "omp-session-1");
  assert.deepEqual(r.damage, []);
  assert.equal(r.finalsInvalidated, 0);
  assert.equal(typeof r.diagnostics, "object");
  assert.notEqual(r.diagnostics, null);
  for (const k of ["lines", "malformedLines", "oversizedLines", "events", "bytesSeen"]) assert.equal(typeof r.counts[k], "number", `counts.${k}`);
});

test("module iface: parseOmpJsonOutput exported and compatible with index.mjs callers", async () => {
  const { parseOmpJsonOutput } = await loadParser();
  const r = parseOmpJsonOutput(okStdout("Compat ok."), { redact: (s) => s });
  assert.equal(r.finalText, "Compat ok.");
  assert.equal(r.finalMessage?.stopReason, "stop");
  assert.deepEqual(r.damage, []);
  for (const k of ["sessionId", "eventCount", "eventCapExceeded", "finalsInvalidated", "malformedLines", "oversizedLines", "truncatedTail", "captureMayBeTruncated", "finalTextTruncated"]) {
    assert.ok(k in r, `parseOmpJsonOutput result keeps ${k}`);
  }
});

test("module #2: a real malformed line in the middle -> malformed_lines", async () => {
  const s = okStdout();
  const cut = s.indexOf("\n") + 1;
  const r = await parseAll([s.slice(0, cut) + "{not json at all\n" + s.slice(cut)]);
  assert.ok(r.damage.includes("malformed_lines"), JSON.stringify(r.damage));
  assert.equal(r.counts.malformedLines, 1);
});

test("module #3: chunks splitting UTF-8 code points and JSON lines are not damage", async () => {
  const TEXT = "完成：中文与表情🙂🙂 done";
  const buf = Buffer.from(stdoutFor(assistant(TEXT)), "utf8");
  const chunks = [];
  for (let i = 0; i < buf.length; i += 5) chunks.push(buf.subarray(i, i + 5));
  const r = await parseAll(chunks);
  assert.deepEqual(r.damage, []);
  assert.equal(r.counts.malformedLines, 0);
  assert.equal(r.counts.lines, 6);
  assert.equal(r.counts.events, 6);
  assert.equal(r.counts.bytesSeen, buf.length);
  assert.equal(r.final?.messages.at(-1).content[0].text, TEXT);
});

test("module #4: trailing half line without newline -> truncated_tail", async () => {
  const r = await parseAll([okStdout(), '{"type":"turn_start"']);
  assert.ok(r.damage.includes("truncated_tail"), JSON.stringify(r.damage));
});

test("module #5: single line above maxLineBytes -> oversized_lines", async () => {
  const big = line({ type: "message_update", text: "x".repeat(4096) });
  const s = okStdout();
  const cut = s.indexOf("\n") + 1;
  const r = await parseAll([s.slice(0, cut), big.slice(0, 1000), big.slice(1000), s.slice(cut)], { maxLineBytes: 1024, maxEvents: 50_000 });
  assert.ok(r.damage.includes("oversized_lines"), JSON.stringify(r.damage));
  assert.equal(r.counts.oversizedLines, 1);
});

test("module #6: more than maxEvents -> event_cap, parser does not retain full text", async () => {
  const chunks = [line(SESSION_HEADER)];
  for (let i = 0; i < 200; i++) chunks.push(line({ type: "message_update", text: `MARKER-${i}-` + "p".repeat(4096) }));
  chunks.push(okStdout());
  const r = await parseAll(chunks, { maxLineBytes: 1024 * 1024, maxEvents: 20 });
  assert.ok(r.damage.includes("event_cap"), JSON.stringify(r.damage));
  assert.ok(r.counts.events <= 20, `events=${r.counts.events}`);
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes("MARKER-199-"), "result must not carry late raw lines");
  assert.ok(dump.length < 64 * 1024, `result size ${dump.length} suggests full-text accumulation`);
});

test("module #7: agent_end(stop) -> advisor start/end pairs -> advisor_yielded keeps final", async () => {
  const other = advisorMsg({ customType: "review-advisor", content: "<advisory advisor=\"Other\">ok</advisory>" });
  const r = await parseAll([okStdout(), advisorPair(advisorMsg()), advisorPair(other), ADVISOR_YIELDED]);
  assert.equal(r.final?.type, "agent_end");
  assert.equal(r.finalsInvalidated, 0);
  assert.deepEqual(r.damage, []);
});

test("module #8: assistant message, message_update or turn_start after final still invalidates", async () => {
  const tails = {
    assistant_message: advisorPair(assistant("late")),
    message_update: line({ type: "message_update", message: assistant("late") }),
    turn_start: line({ type: "turn_start" }),
  };
  for (const [label, tail] of Object.entries(tails)) assertInvalidated(await parseAll([okStdout(), tail]), label);
});

test("module #9: advisor shape mismatch after final invalidates", async () => {
  const { display, ...noDisplay } = advisorMsg();
  const { attribution, ...noAttribution } = advisorMsg();
  const cases = {
    missing_display: advisorPair(noDisplay),
    display_false: advisorPair(advisorMsg({ display: false })),
    missing_attribution: advisorPair(noAttribution),
    empty_customType: advisorPair(advisorMsg({ customType: "" })),
    start_only: line({ type: "message_start", message: advisorMsg() }),
    start_end_mismatch: advisorPair(advisorMsg(), advisorMsg({ content: "<advisory>different</advisory>" })),
  };
  for (const [label, tail] of Object.entries(cases)) assertInvalidated(await parseAll([okStdout(), tail, ADVISOR_YIELDED]), label);
});

// ------------------------------------------------------------------ index group

const WORKDIR = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "omp-adapt-test-"));
process.on("exit", () => rmSync(WORKDIR, { recursive: true, force: true }));
function baseCtx() {
  const scratchDir = mkdtempSync(path.join(WORKDIR, "run-scratch-"));
  return {
    runId: "run-adapt-1",
    agent: { id: "agent-1", companyId: "co-1", name: "OMP", adapterType: ADAPTER_TYPE, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: "/probe/omp-adapt", timeoutSec: 120, graceSec: 5, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir } },
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

// Same shape as index.test.mjs fakeRunner: chunks go through opts.onLog, stdout is what native returns.
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

test("index #1: stream > MAX_CAPTURE_BYTES with legal final -> success, captureTruncated diagnostic", async () => {
  const parts = [line(SESSION_HEADER)];
  let size = parts[0].length;
  for (let i = 0; size <= MAX_CAPTURE_BYTES + 256 * 1024; i++) {
    const l = line({ type: "message_update", seq: i, text: "u".repeat(16 * 1024) });
    parts.push(l);
    size += l.length;
  }
  parts.push(okStdout("Big run done."));
  const full = parts.join("");
  const stdout = full.slice(-MAX_CAPTURE_BYTES);
  assert.notEqual(full[full.length - MAX_CAPTURE_BYTES - 1], "\n", "fixture: native slice must start mid-line");
  const chunks = [];
  for (let i = 0; i < full.length; i += 65_521) chunks.push(full.slice(i, i + 65_521));
  assert.ok(chunks.some((c) => !c.endsWith("\n")), "fixture: chunks cut lines");
  const r = await runWith({ chunks, stdout, exitCode: 0 });
  assert.equal(r.errorCode ?? null, null, r.errorMessage);
  assert.deepEqual(r.resultJson.diagnostics.damage, []);
  assert.equal(r.resultJson.diagnostics.captureTruncated, true);
});

test("index #10: exit 1 + aborted 'Deadline exceeded' final, no damage -> omp_deadline_exceeded", async () => {
  const r = await runWith({ stdout: stdoutFor(deadlineMsg()), exitCode: 1, timedOut: false });
  assert.equal(r.errorCode, "omp_deadline_exceeded");
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.resultJson.diagnostics.deadline, { source: "omp_max_time", nativeTimerFired: false });
});

test("index #11: exit 1 without deadline final -> omp_exit_nonzero", async () => {
  const finals = {
    error_stop: assistant("failed", { stopReason: "error", errorMessage: "provider boom" }),
    aborted_other: assistant("stopped", { stopReason: "aborted", errorMessage: "Request was aborted" }),
  };
  for (const [label, msg] of Object.entries(finals)) {
    const r = await runWith({ stdout: stdoutFor(msg), exitCode: 1 });
    assert.equal(r.errorCode, "omp_exit_nonzero", label);
  }
});

test("index #12: deadline final + damage -> omp_exit_nonzero, damage diagnostics kept", async () => {
  const s = stdoutFor(deadlineMsg());
  const cut = s.indexOf("\n") + 1;
  const r = await runWith({ stdout: s.slice(0, cut) + "{broken line\n" + s.slice(cut), exitCode: 1 });
  assert.equal(r.errorCode, "omp_exit_nonzero");
  assert.ok(r.resultJson.diagnostics.damage.includes("malformed_lines"), JSON.stringify(r.resultJson.diagnostics.damage));
});

test("index #13: native timedOut=true -> omp_timeout", async () => {
  const r = await runWith({ stdout: stdoutFor(deadlineMsg()), exitCode: null, signal: "SIGTERM", timedOut: true });
  assert.equal(r.errorCode, "omp_timeout");
  assert.equal(r.timedOut, true);
});

test("index #14: exit 0 + aborted final -> omp_stop_aborted", async () => {
  const r = await runWith({ stdout: stdoutFor(assistant("stopped", { stopReason: "aborted", errorMessage: "Request was aborted" })), exitCode: 0 });
  assert.equal(r.errorCode, "omp_stop_aborted");
});

test("index #15: streamed bytes fewer than stdout (missing onLog chunk) -> stream_incomplete, fail closed", async () => {
  const s = okStdout("Looks fine.");
  const first = s.indexOf("\n") + 1;
  const second = s.indexOf("\n", first) + 1;
  // The runner drops the agent_start line chunk: onLog sees fewer bytes than native stdout.
  const chunks = [s.slice(0, first), s.slice(second)];
  const r = await runWith({ chunks, stdout: s, exitCode: 0 });
  assert.notEqual(r.errorCode ?? null, null, "must fail closed");
  assert.equal(r.resultJson.runOutcome, "failed");
  assert.ok(r.resultJson.diagnostics.damage.includes("stream_incomplete"), JSON.stringify(r.resultJson.diagnostics.damage));
});
