// R4-G2-RED: background bash job admission vs async-result completion.
// Independently synthetic async admission and completion events.
// IDs, timestamps, durations and content are invented; only protocol structure is exercised.
import test from "node:test";
import assert from "node:assert/strict";
import { createProgressForwarder } from "./adapter-fixture.mjs";

const ID = "synthetic_tool_async_01";
const BODY_MARKER = "C_SYNTHETIC_JOB_OUTPUT_BODY invented result";
const LABEL_MARKER = "C_SYNTHETIC_JOB_LABEL run_suite.sh";

const startLine = JSON.stringify({ type: "tool_execution_start", toolCallId: ID, toolName: "bash", args: { command: "true" } });

// Synthetic backgrounded bash admission, not completion.
const admissionEndLine = JSON.stringify({
  type: "tool_execution_end",
  toolCallId: ID,
  toolName: "bash",
  result: {
    content: [{ type: "text", text: "Synthetic background admission for bg_1; synthetic deadline 60 seconds." }],
    details: { async: { state: "running", jobId: "bg_1", type: "bash" }, timeoutSeconds: 60 },
  },
  isError: false,
});

// Synthetic custom completion notice (message_start then message_end).
const asyncMessage = {
  role: "custom",
  customType: "async-result",
  content: `<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n${BODY_MARKER}\nWall time: 1.25 seconds\n</system-notice>`,
  display: true,
  attribution: "agent",
  details: {
    meta: { source: { type: "report", value: "background job delivery" } },
    jobs: [{ jobId: "bg_1", type: "bash", status: "completed", label: LABEL_MARKER, durationMs: 1250 }],
  },
  timestamp: 946684800000,
};
const asyncStartLine = JSON.stringify({ type: "message_start", message: asyncMessage });
const asyncEndLine = JSON.stringify({ type: "message_end", message: asyncMessage });

async function project(lines) {
  const events = [];
  const fwd = createProgressForwarder(async (e) => events.push(e), null, (s) => s);
  await fwd.feed(lines.map((l) => `${l}\n`).join(""));
  await fwd.flush();
  return events;
}

test("A1 background job admission end is not projected as phase=completed", async () => {
  const events = await project([startLine, admissionEndLine]);
  const ends = events.filter((e) => e.eventType === "tool_result" && e.payload?.toolCallId === ID);
  assert.equal(ends.length, 1, "admission must stay visible as exactly one tool_result event");
  assert.notEqual(ends[0].payload.phase, "completed", "a backgrounded job (details.async.state=running) has not completed");
  assert.notEqual(ends[0].payload.phase, "failed");
});

test("A2 async-result completion projects only jobId/status/durationMs, never the output body", async () => {
  const events = await project([startLine, admissionEndLine, asyncStartLine, asyncEndLine]);
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("C_SYNTHETIC_JOB_OUTPUT_BODY"), "job output body must not be projected");
  assert.ok(!serialized.includes("C_SYNTHETIC_JOB_LABEL"), "job label (command text) must not be projected");
  const done = events.filter((e) => e.payload?.jobId === "bg_1" && e.payload?.status === "completed");
  assert.equal(done.length, 1, "exactly one completion event for bg_1 (message_start/message_end deduplicated)");
  assert.equal(done[0].payload.durationMs, 1250);
});

test("A3 guard: plain foreground tool_execution_end still projects phase=completed", async () => {
  const fgEnd = JSON.stringify({ type: "tool_execution_end", toolCallId: "toolu_fg", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  const events = await project([JSON.stringify({ type: "tool_execution_start", toolCallId: "toolu_fg", toolName: "read", args: {} }), fgEnd]);
  assert.deepEqual(events.map((e) => [e.eventType, e.payload.phase]), [["tool_call", "started"], ["tool_result", "completed"]]);
});
