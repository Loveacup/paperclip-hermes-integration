// Offline behavioural tests for the omp_local adapter.
// The native runner is injected; no real OMP, network or Paperclip server is used.
// Event fixtures follow OMP 18.10.0 packages/coding-agent/src/modes/print-mode.ts:
// optional {"type":"session",...} header line, then one JSON event per line,
// ending in {"type":"agent_end","messages":[...],"willContinue"?:true}.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_CAPTURE_BYTES, selectPaperclipPromptSections, joinPromptSections } from "@paperclipai/adapter-utils/server-utils";
import {
  ADAPTER_TYPE,
  OMP_COMMAND,
  createServerAdapter,
  createProgressForwarder,
  createStreamRedactor,
  parseOmpJsonOutput,
  redactText,
} from "./adapter-fixture.mjs";

const AUTH_TOKEN = "eyJhbGciOiJIUzI1NiJ9.run-jwt-SECRET-0123456789";
const TOOLS_TOKEN = "rt_tools_bearer_SECRET_abcdef123456";
const WORKDIR = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "omp-adapter-test-"));
process.on("exit", () => rmSync(WORKDIR, { recursive: true, force: true }));

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
const SESSION_HEADER = { type: "session", version: 3, id: "omp-session-1", timestamp: "2026-10-12T00:00:00Z", cwd: WORKDIR };
function okStdout(text = "All done.", extra = {}) {
  return (
    line(SESSION_HEADER) +
    line({ type: "agent_start" }) +
    line({ type: "turn_start" }) +
    line({ type: "message_end", message: assistant(text, extra) }) +
    line({ type: "turn_end", message: assistant(text, extra), toolResults: [] }) +
    line({ type: "agent_end", messages: [assistant(text, extra)] })
  );
}

function baseCtx(overrides = {}) {
  const logs = [];
  const metas = [];
  const spawns = [];
  const scratchDir = mkdtempSync(path.join(WORKDIR, "run-scratch-"));
  const ctx = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "OMP", adapterType: ADAPTER_TYPE, adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { cwd: WORKDIR, timeoutSec: 120, graceSec: 5, env: { PAPERCLIP_RUN_SCRATCH_DIR: scratchDir } },
    context: {
      taskId: "iss_1",
      issueId: "iss_1",
      wakeReason: "issue_assigned",
      paperclipWake: { reason: "issue_assigned", issue: { id: "iss_1", identifier: "LAB-1", title: "Fix widget", status: "todo" } },
      paperclipScratch: { type: "heartbeat_run", dir: scratchDir },
    },
    authToken: AUTH_TOKEN,
    runtimeTools: {
      version: 1,
      guidance: "use tools",
      mcpEndpoint: "http://127.0.0.1:3100/mcp",
      rest: { connectionsSearch: "http://127.0.0.1:3100/s", connectionRequest: "http://127.0.0.1:3100/r" },
      bearerToken: TOOLS_TOKEN,
      expiresAt: "2026-10-12T01:00:00Z",
      tools: ["connections_search", "connection_request"],
    },
    onLog: async (stream, chunk) => {
      logs.push([stream, chunk]);
    },
    onMeta: async (meta) => {
      metas.push(meta);
    },
    onSpawn: async (meta) => {
      spawns.push(meta);
    },
    ...overrides,
  };
  return { ctx, logs, metas, spawns };
}

function fakeRunner(script = {}) {
  const calls = [];
  const run = async (runId, command, args, opts) => {
    calls.push({ runId, command, args, opts });
    if (script.reject) throw script.reject;
    await opts.onSpawn?.({ pid: 4242, processGroupId: 4242, startedAt: "2026-10-12T00:00:00Z" });
    const stdout = script.stdout ?? okStdout();
    for (const chunk of script.chunks ?? [stdout]) await opts.onLog("stdout", chunk);
    for (const chunk of script.stderrChunks ?? []) await opts.onLog("stderr", chunk);
    return {
      exitCode: "exitCode" in script ? script.exitCode : 0,
      signal: script.signal ?? null,
      timedOut: script.timedOut ?? false,
      stdout,
      stderr: (script.stderrChunks ?? []).join(""),
      pid: 4242,
      startedAt: "2026-10-12T00:00:00Z",
    };
  };
  return { run, calls };
}

// Mirrors the native runChildProcess ordering (adapter-utils server-utils.js):
// opts.onSpawn(meta).catch(onLogError) runs right after spawn and before the
// runningProcesses registration; onLog rejections go to onLogError, whose
// default is console.warn({ err }).
function nativeLikeRunner(script = {}) {
  const state = { registered: false, usedDefaultOnLogError: null, onLogError: null };
  const run = async (runId, command, args, opts) => {
    state.usedDefaultOnLogError = !opts.onLogError;
    state.onLogError = opts.onLogError;
    const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));
    const spawnPersistPromise = opts.onSpawn
      ? opts.onSpawn({ pid: 4242, processGroupId: 4242, startedAt: "2026-10-12T00:00:00Z" }).catch((err) => {
          onLogError(err, runId, "failed to record child process metadata");
        })
      : Promise.resolve();
    state.registered = true;
    await spawnPersistPromise;
    const stdout = script.stdout ?? okStdout();
    let logChain = Promise.resolve();
    logChain = logChain.then(() => opts.onLog("stdout", stdout)).catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
    await logChain;
    if (script.rejectAfterSpawn) throw script.rejectAfterSpawn;
    return { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 4242, startedAt: "2026-10-12T00:00:00Z" };
  };
  return { run, state };
}

async function withWarnSpy(fn) {
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args);
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warned;
}

function adapterWith(runner, extraDeps = {}) {
  return createServerAdapter({ runChildProcess: runner.run, ...extraDeps });
}

const allText = (value) => JSON.stringify(value);
function assertNoSecrets(value, label) {
  const text = typeof value === "string" ? value : allText(value);
  assert.ok(!text.includes(AUTH_TOKEN), `${label} leaked auth token`);
  assert.ok(!text.includes(TOOLS_TOKEN), `${label} leaked runtime tools token`);
}

test('privacy: Python ensure_ascii JSON Unicode escapes are redacted in nested results and every log split', async()=>{
  const token='clé-SYNTHETIC-123';
  for(const encoded of ['cl\\u00e9-SYNTHETIC-123','cl\\u00E9-SYNTHETIC-123']){
    const nested='{"token":"'+encoded+'"}';
    const raw=okStdout(nested);
    for(let split=0;split<=raw.length;split++){
      const {ctx,logs,metas}=baseCtx({authToken:token});
      const r=await adapterWith(fakeRunner({stdout:raw,chunks:[raw.slice(0,split),raw.slice(split)]})).execute(ctx);
      assert.equal(r.resultJson.runOutcome,'succeeded');
      assert.ok(!JSON.stringify([r,logs,metas]).includes(encoded.replaceAll('\\','\\\\')));
      assert.notEqual(JSON.parse(r.summary).token,token);
    }
    assert.ok(!redactText('x'.repeat(2040)+nested,[token]).includes(encoded));
  }
});

test('native heartbeat connector metadata is accepted without becoming OMP flags', async()=>{
  const {ctx}=baseCtx();
  Object.assign(ctx.config,{paperclipSkillSync:{desiredSkills:[]},paperclipRuntimeSkills:[],paperclipConnectorSkillDigest:null});
  const runner=fakeRunner();
  const r=await adapterWith(runner).execute(ctx);
  assert.equal(r.resultJson.runOutcome,'succeeded');
  assert.equal(runner.calls.length,1);
  assert.ok(!runner.calls[0].args.some(x=>x.includes('paperclipSkill')));
});

test('pre-spawn refusals expose native bootstrap recovery but dispatched rejection never does', async()=>{
  const runner=fakeRunner();
  const {ctx}=baseCtx();
  ctx.context={paperclipScratch:ctx.context.paperclipScratch};
  const r=await adapterWith(runner).execute(ctx);
  assert.deepEqual(r.executionRecovery,{kind:'bootstrap',providerWorkStarted:false});
  assert.equal(runner.calls.length,0);
  const uncertain=await adapterWith(fakeRunner({reject:new Error('synthetic dispatch rejection')})).execute(baseCtx().ctx);
  assert.equal(uncertain.executionRecovery,undefined);
});

test('native terminal agent_end tolerates only exact advisor idle notification',async()=>{
  const end={type:'agent_end',messages:[assistant('done')],isTerminal:true,yielded:true};
  const good=await adapterWith(fakeRunner({stdout:line(end)+line({type:'advisor_yielded'})})).execute(baseCtx().ctx);
  assert.equal(good.resultJson.runOutcome,'succeeded');
  for(const stdout of [line({...end,isTerminal:false}),line(end)+line({type:'advisor_yielded',unexpected:'activity'}),line(end)+line({type:'agent_start'})]){
    const r=await adapterWith(fakeRunner({stdout})).execute(baseCtx().ctx);
    assert.notEqual(r.resultJson.runOutcome,'succeeded');
  }
});

// ---------------------------------------------------------------- module shape

test("factory returns a native external adapter module", () => {
  const adapter = createServerAdapter();
  assert.equal(adapter.type, "omp_local");
  assert.equal(ADAPTER_TYPE, "omp_local");
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.testEnvironment, "function");
  assert.equal(adapter.supportsLocalAgentJwt, true);
  assert.equal(adapter.runtimeToolDelivery, "environment");
  assert.ok(path.isAbsolute(OMP_COMMAND));
});

// ---------------------------------------------------------------- argv / spawn

test("spawns fixed OMP binary with exact argv; prompt goes on stdin, not argv", async () => {
  const runner = fakeRunner();
  const { ctx } = baseCtx();
  await adapterWith(runner).execute(ctx);
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.equal(call.runId, "run-1");
  assert.equal(call.command, OMP_COMMAND);
  assert.deepEqual(call.args, ["-p", "--mode", "json", "--no-session", "--cwd", WORKDIR, "--max-time", "120"]);
  assert.equal(call.opts.cwd, WORKDIR);
  assert.equal(call.opts.timeoutSec, 125, "native timeout = OMP max-time + grace");
  assert.equal(call.opts.graceSec, 5);
  const expected = selectPaperclipPromptSections(ctx.context, { includeExecutionContract: true });
  assert.equal(call.opts.stdin, joinPromptSections([expected.taskContextNote, expected.wakePrompt]));
  assert.ok(call.opts.stdin.includes("Paperclip Wake Payload"));
  assert.ok(!call.args.some((a) => a.includes("Wake Payload")));
});

test("approval mode is omitted when absent and passed only for explicit known values", async () => {
  for (const mode of ["always-ask", "write", "yolo"]) {
    const runner = fakeRunner();
    const { ctx } = baseCtx();
    ctx.config = { ...ctx.config, approvalMode: mode };
    await adapterWith(runner).execute(ctx);
    const args = runner.calls[0].args;
    assert.deepEqual(args.slice(args.indexOf("--approval-mode"), args.indexOf("--approval-mode") + 2), ["--approval-mode", mode]);
  }
  const runner = fakeRunner();
  await adapterWith(runner).execute(baseCtx().ctx);
  assert.ok(!runner.calls[0].args.includes("--approval-mode"));
  assert.ok(!runner.calls[0].args.includes("--yolo"));
  assert.ok(!runner.calls[0].args.includes("--auto-approve"));
});

test("adversarial config is refused before spawn", async () => {
  const bad = [
    { approvalMode: "auto" },
    { approvalMode: "yolo --tools bash" },
    { approvalMode: "" },
    { model: "--tools=bash" },
    { model: "a b" },
    { model: "x\u0000y" },
    { cwd: "relative/dir" },
    { cwd: "--help" },
    { cwd: `${WORKDIR}\u0000/etc` },
    { cwd: path.join(WORKDIR, "missing-subdir") },
    { timeoutSec: 0 },
    { timeoutSec: -5 },
    { timeoutSec: "60; rm -rf /" },
    { timeoutSec: 1e9 },
    { graceSec: 0 },
    { command: "/bin/sh" },
    { extraArgs: ["--approval-mode", "yolo"] },
    { args: ["--yolo"] },
    { env: { "BAD KEY": "x" } },
    { env: { OK: 5 } },
    { env: "PAPERCLIP_API_KEY=x" },
  ];
  for (const patch of bad) {
    const runner = fakeRunner();
    const { ctx, logs } = baseCtx();
    const scratch = ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR;
    ctx.config = { ...ctx.config, ...patch };
    if (patch.env && typeof patch.env === "object") ctx.config.env = { ...patch.env, PAPERCLIP_RUN_SCRATCH_DIR: scratch };
    const result = await adapterWith(runner).execute(ctx);
    assert.equal(runner.calls.length, 0, `spawned for ${JSON.stringify(patch)}`);
    assert.equal(result.errorCode, "omp_config_invalid", JSON.stringify(patch));
    assert.ok(result.errorMessage);
    assertNoSecrets([result, logs], "refusal");
  }
});

test("explicit model is passed as its own argv element", async () => {
  const runner = fakeRunner();
  const { ctx } = baseCtx();
  ctx.config = { ...ctx.config, model: "anthropic/claude-sonnet-4.5" };
  await adapterWith(runner).execute(ctx);
  const args = runner.calls[0].args;
  assert.equal(args[args.indexOf("--model") + 1], "anthropic/claude-sonnet-4.5");
});

// ---------------------------------------------------------------- task identity

test("missing explicit task identity is refused before spawn (never derived from config)", async () => {
  const runner = fakeRunner();
  const { ctx } = baseCtx();
  ctx.context = { wakeReason: "timer", paperclipScratch: ctx.context.paperclipScratch };
  ctx.config = { ...ctx.config, env: { PAPERCLIP_TASK_ID: "iss_from_config", PAPERCLIP_RUN_SCRATCH_DIR: ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR } };
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(runner.calls.length, 0);
  assert.equal(result.errorCode, "omp_task_identity_missing");

  // a config-level taskId is not an identity source at all: unknown key, refused
  const { ctx: c2 } = baseCtx();
  c2.config = { ...c2.config, taskId: "iss_from_config" };
  const r2 = await adapterWith(runner).execute(c2);
  assert.equal(runner.calls.length, 0);
  assert.equal(r2.errorCode, "omp_config_invalid");
});

test("conflicting task identities are refused before spawn", async () => {
  const conflicts = [
    { taskId: "iss_1", issueId: "iss_2" },
    { taskId: "iss_1", issueId: "iss_1", paperclipWake: { reason: "x", issue: { id: "iss_9" } } },
    { taskId: "iss 1; rm" },
  ];
  for (const context of conflicts) {
    const runner = fakeRunner();
    const { ctx } = baseCtx();
    ctx.context = { ...context, paperclipScratch: ctx.context.paperclipScratch };
    const result = await adapterWith(runner).execute(ctx);
    assert.equal(runner.calls.length, 0, JSON.stringify(context));
    assert.match(result.errorCode, /^omp_task_identity_(conflict|invalid)$/);
  }
});

test("empty prompt from native sections is refused before spawn", async () => {
  const runner = fakeRunner();
  const { ctx } = baseCtx();
  ctx.context = { taskId: "iss_1", paperclipScratch: ctx.context.paperclipScratch };
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(runner.calls.length, 0);
  assert.equal(result.errorCode, "omp_prompt_empty");
});

// ---------------------------------------------------------------- env / identity precedence

test("runtime identity wins over config env; config API key is refused", async () => {
  const runner = fakeRunner();
  const { ctx } = baseCtx();
  ctx.config = {
    ...ctx.config,
    env: { PAPERCLIP_AGENT_ID: "evil", PAPERCLIP_TASK_ID: "evil", PAPERCLIP_RUN_ID: "evil", PAPERCLIP_RUNTIME_TOOLS_TOKEN: "evil", OMP_FLAG: "1", PAPERCLIP_RUN_SCRATCH_DIR: ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR },
  };
  await adapterWith(runner).execute(ctx);
  const env = runner.calls[0].opts.env;
  assert.equal(env.PAPERCLIP_AGENT_ID, "agent-1");
  assert.equal(env.PAPERCLIP_COMPANY_ID, "co-1");
  assert.equal(env.PAPERCLIP_TASK_ID, "iss_1");
  assert.equal(env.PAPERCLIP_RUN_ID, "run-1");
  assert.equal(env.PAPERCLIP_WAKE_REASON, "issue_assigned");
  assert.equal(env.PAPERCLIP_API_KEY, AUTH_TOKEN);
  assert.equal(env.PAPERCLIP_RUNTIME_TOOLS_TOKEN, TOOLS_TOKEN);
  assert.equal(env.PAPERCLIP_RUNTIME_TOOLS_MCP_URL, "http://127.0.0.1:3100/mcp");
  assert.equal(env.OMP_FLAG, "1");

  for (const key of ["PAPERCLIP_API_KEY", "PAPERCLIP_WAKE_PAYLOAD_JSON"]) {
    const r2 = fakeRunner();
    const { ctx: c2, logs } = baseCtx();
    c2.config = { ...c2.config, env: { [key]: "config-supplied-key-123", PAPERCLIP_RUN_SCRATCH_DIR: c2.config.env.PAPERCLIP_RUN_SCRATCH_DIR } };
    const result = await adapterWith(r2).execute(c2);
    assert.equal(r2.calls.length, 0, key);
    assert.equal(result.errorCode, "omp_config_invalid");
    assert.ok(!allText([result, logs]).includes("config-supplied-key-123"));
  }
});

test("no authToken means no PAPERCLIP_API_KEY is injected", async () => {
  const runner = fakeRunner();
  const { ctx } = baseCtx({ authToken: undefined });
  await adapterWith(runner).execute(ctx);
  assert.ok(!("PAPERCLIP_API_KEY" in runner.calls[0].opts.env));
});

test("native onSpawn is forwarded", async () => {
  const runner = fakeRunner();
  const { ctx, spawns } = baseCtx();
  await adapterWith(runner).execute(ctx);
  assert.deepEqual(spawns, [{ pid: 4242, processGroupId: 4242, startedAt: "2026-10-12T00:00:00Z" }]);
});

// ---------------------------------------------------------------- secret hygiene

test("secrets never reach argv, prompt, meta, logs or results", async () => {
  const leakyText = `token is ${AUTH_TOKEN} and ${TOOLS_TOKEN}`;
  const stdout = okStdout(leakyText);
  // split each secret across chunk boundaries
  const cut1 = stdout.indexOf(AUTH_TOKEN) + 10;
  const cut2 = stdout.indexOf(TOOLS_TOKEN) + 7;
  const chunks = [stdout.slice(0, cut1), stdout.slice(cut1, cut2), stdout.slice(cut2)];
  const runner = fakeRunner({ stdout, chunks, stderrChunks: [`warn ${AUTH_TOKEN.slice(0, 20)}`, `${AUTH_TOKEN.slice(20)} end\n`] });
  const { ctx, logs, metas } = baseCtx();
  ctx.context = { ...ctx.context, paperclipWake: { ...ctx.context.paperclipWake, comments: [{ id: "c1", body: `pasted ${AUTH_TOKEN}` }] } };
  const result = await adapterWith(runner).execute(ctx);
  const call = runner.calls[0];
  assertNoSecrets(call.args, "argv");
  assertNoSecrets(call.opts.stdin, "prompt");
  assertNoSecrets(metas, "meta");
  assertNoSecrets(result, "result");
  const joined = { stdout: "", stderr: "" };
  for (const [stream, chunk] of logs) joined[stream] += chunk;
  assertNoSecrets(joined.stdout, "stdout log");
  assertNoSecrets(joined.stderr, "stderr log");
  assert.ok(joined.stdout.includes("***REDACTED***"));
  assert.ok(joined.stderr.includes("***REDACTED***"));
  assert.ok(joined.stderr.endsWith(" end\n"), "held-back tail is flushed");
  assert.equal(metas.length, 1);
  assert.equal(metas[0].command, OMP_COMMAND);
  assert.deepEqual(metas[0].commandArgs, call.args);
});

test("config env secret values are redacted from logs", async () => {
  const configSecret = "sk-config-provider-SECRET-9999";
  const runner = fakeRunner({ stdout: okStdout(`echo ${configSecret}`) });
  const { ctx, logs, metas } = baseCtx();
  ctx.config = { ...ctx.config, env: { ANTHROPIC_API_KEY: configSecret, PAPERCLIP_RUN_SCRATCH_DIR: ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR } };
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(runner.calls[0].opts.env.ANTHROPIC_API_KEY, configSecret);
  assert.ok(!allText([logs, metas, result]).includes(configSecret));
});

test("stream redactor handles secrets split at every offset", async () => {
  const secret = "abcdefghijSECRET";
  const text = `xx${secret}yy${secret}`;
  for (let i = 0; i <= text.length; i++) {
    const out = [];
    const r = createStreamRedactor([secret], async (s, c) => out.push(c));
    await r.write("stdout", text.slice(0, i));
    await r.write("stdout", text.slice(i));
    await r.flush();
    assert.equal(out.join(""), "xx***REDACTED***yy***REDACTED***", `offset ${i}`);
  }
});

// ---------------------------------------------------------------- privacy probes (short synthetic tokens)

// Purely synthetic 1-5 char credentials; none occurs in adapter fixed text.
const SHORT = {
  auth: "§",
  tools: "¤q",
  model: "Zx9",
  quote: 'k\\"7',
  pw: "Ωz~¦!",
};
const SHORT_ENV = { MY_TOKEN: SHORT.model, ANTHROPIC_API_KEY: SHORT.quote, DB_PASSWORD: SHORT.pw };
const esc = (s) => JSON.stringify(s).slice(1, -1);
const forms = (s) => [s, esc(s), esc(esc(s))];

function deepStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      deepStrings(v, out);
    }
  }
  return out;
}

function assertNoShortTokens(value, label) {
  const strings = deepStrings(value);
  const serialized = JSON.stringify(value);
  for (const token of Object.values(SHORT)) {
    for (const form of forms(token)) {
      assert.ok(!serialized.includes(form), `${label} serialized leaked ${JSON.stringify(form)}`);
      for (const s of strings) assert.ok(!s.includes(form), `${label} leaked ${JSON.stringify(form)} in ${JSON.stringify(s.slice(0, 80))}`);
    }
  }
}

const PROBE_CWD = `/probe/dir-${SHORT.auth}-${SHORT.tools}-${SHORT.pw}`;
function shortCtx(overrides = {}) {
  const made = baseCtx({ authToken: SHORT.auth, ...overrides });
  made.ctx.runtimeTools = { ...made.ctx.runtimeTools, bearerToken: SHORT.tools };
  made.ctx.config = { cwd: PROBE_CWD, timeoutSec: 120, graceSec: 5, model: `prov/${SHORT.model}-m`, env: { ...SHORT_ENV, PAPERCLIP_RUN_SCRATCH_DIR: made.ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR } };
  return made;
}
const fakeDir = { statPath: async () => ({ isDirectory: () => true }) };

function probeStdout() {
  const finalText = `use ${SHORT.auth} ${SHORT.tools} ${SHORT.quote} ${SHORT.pw} \\path\\${SHORT.tools}`;
  const msg = assistant(finalText, { provider: `prov-${SHORT.pw}`, model: `m-${SHORT.model}` });
  return (
    line({ ...SESSION_HEADER, id: `sess-${SHORT.auth}-${SHORT.model}`, cwd: PROBE_CWD }) +
    line({ type: "tool_execution_end", result: JSON.stringify({ secret: SHORT.quote, pw: SHORT.pw, t: SHORT.tools }) }) +
    line({ type: "message_end", message: msg }) +
    line({ type: "agent_end", messages: [msg] })
  );
}

test("privacy: short/escaped tokens never exit through logs, meta or results at any chunk split", async () => {
  const stdout = probeStdout();
  const stderr = `warn ${SHORT.pw} ${esc(SHORT.quote)} ${SHORT.auth}\n`;
  for (let i = 0; i <= stdout.length; i++) {
    const j = Math.min(i, stderr.length);
    const runner = fakeRunner({ stdout, chunks: [stdout.slice(0, i), stdout.slice(i)], stderrChunks: [stderr.slice(0, j), stderr.slice(j)] });
    const { ctx, logs, metas } = shortCtx();
    const result = await adapterWith(runner, fakeDir).execute(ctx);
    assert.equal(runner.calls.length, 1);
    assert.equal(result.resultJson.runOutcome, "succeeded", `split ${i}: ${result.errorCode}`);
    const joined = { stdout: "", stderr: "" };
    for (const [stream, chunk] of logs) joined[stream] += chunk;
    assertNoShortTokens(joined, `logs@${i}`);
    assertNoShortTokens(metas, `meta@${i}`);
    assertNoShortTokens(result, `result@${i}`);
    assert.ok(joined.stdout.length > 0 && joined.stderr.endsWith("\n"), `split ${i}: logs flushed`);
  }
});

test("privacy: failure paths redact provider error, stderr and session/model/provider", async () => {
  const stdout = okStdout("", { stopReason: "error", errorMessage: `broke ${SHORT.pw} ${SHORT.quote}`, provider: SHORT.tools, model: SHORT.model });
  const runner = fakeRunner({ stdout, exitCode: 1, stderrChunks: [`${SHORT.auth} ${esc(esc(SHORT.quote))}\n`] });
  const { ctx, logs, metas } = shortCtx();
  const result = await adapterWith(runner, fakeDir).execute(ctx);
  assert.equal(result.errorCode, "omp_exit_nonzero");
  assertNoShortTokens([result, logs, metas], "failure");
});

test("privacy: tokens overlapping summary/excerpt/provider-error cut points are redacted before cutting", async () => {
  const pw = SHORT.pw;
  // summary cut at 64 KiB lands inside the token
  const big = okStdout(".".repeat(64 * 1024 - 2) + pw);
  const r1 = await adapterWith(fakeRunner({ stdout: big }), fakeDir).execute(shortCtx().ctx);
  assert.ok(typeof r1.summary === "string" && r1.summary.length > 0);
  assert.ok(!r1.summary.includes(pw.slice(0, 2)), "summary leaked token prefix at cut");
  // stderr excerpt keeps the last 2048 chars; the cut lands inside the token
  const r2 = await adapterWith(fakeRunner({ exitCode: 2, stdout: "", stderrChunks: [pw + ".".repeat(2045)] }), fakeDir).execute(shortCtx().ctx);
  assert.ok(!String(r2.resultJson.stderrExcerpt ?? "").includes(pw.slice(2)), "stderr excerpt leaked token suffix at cut");
  // provider error is limited to 2048 chars; the cut lands inside the token
  const r3 = await adapterWith(fakeRunner({ stdout: okStdout("", { stopReason: "error", errorMessage: ".".repeat(2046) + pw }) }), fakeDir).execute(shortCtx().ctx);
  assert.equal(r3.errorCode, "omp_stop_error");
  assert.ok(!String(r3.resultJson.providerError ?? "").includes(pw.slice(0, 2)), "provider error leaked token prefix at cut");
  for (const r of [r1, r2, r3]) assertNoShortTokens(r, "cut");
});

test("privacy: unknown config keys are never echoed, even with embedded tokens", async () => {
  const { ctx, logs, metas } = shortCtx();
  ctx.config = { ...ctx.config, [`x${SHORT.pw}y`]: 1, zz_unknown_key_name: 2 };
  const runner = fakeRunner();
  const result = await adapterWith(runner, fakeDir).execute(ctx);
  assert.equal(runner.calls.length, 0);
  assert.equal(result.errorCode, "omp_config_invalid");
  assert.ok(!allText(result).includes("zz_unknown_key_name"));
  assertNoShortTokens([result, logs, metas], "unknown key refusal");
});

test("redaction marker never recombines with neighbouring text into a token", async () => {
  for (const token of ["*a", "E", "*", "D***"]) {
    const out = redactText(`x*${token}a${token}${token}E*`, [token]);
    assert.ok(!out.includes(token), `${JSON.stringify(token)} -> ${JSON.stringify(out)}`);
    const streamed = [];
    const r = createStreamRedactor([token], async (s, c) => streamed.push(c));
    await r.write("stdout", `*${token}`);
    await r.write("stdout", `a${token}*`);
    await r.flush();
    assert.ok(!streamed.join("").includes(token), `stream ${JSON.stringify(token)}`);
  }
});

// ---------------------------------------------------------------- final output contract

test("success maps final agent_end assistant message; run success is not issue done or approval", async () => {
  const runner = fakeRunner();
  const { ctx } = baseCtx();
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.ok(!result.errorMessage);
  assert.equal(result.summary, "All done.");
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 });
  assert.equal(result.usageBasis, "per_run");
  assert.equal(result.costUsd, 0.0123);
  assert.equal(result.provider, "anthropic");
  assert.equal(result.model, "claude-test");
  assert.equal(result.sessionId, null, "--no-session baseline does not persist a session");
  assert.equal(result.resultJson.runOutcome, "succeeded");
  assert.equal(result.resultJson.issueCompletion, "not_asserted_by_adapter");
  assert.equal(result.resultJson.approval, "not_asserted_by_adapter");
  assert.equal(result.resultJson.stopReason, "stop");
  assert.equal(result.resultJson.ompSessionId, "omp-session-1");
});

const usageOf = (input, output, cacheRead, cost) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + output + cacheRead, ...(cost === undefined ? {} : { cost: { total: cost } }) });
function turnsStdout(messages) {
  const ends = messages.map((message) => line({ type: "message_end", message })).join("");
  return line(SESSION_HEADER) + line({ type: "agent_start" }) + ends + line({ type: "agent_end", messages });
}

test("usage: per_run sums every assistant turn of the selected final once", async () => {
  const toolCall = assistant("", { usage: usageOf(100, 20, 50, 0.25), stopReason: "toolUse" });
  const toolResult = { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "x" }], usage: usageOf(9999, 9999, 9999, 99) };
  const last = assistant("done", { usage: usageOf(30, 4, 70, 0.125) });
  const result = await adapterWith(fakeRunner({ stdout: turnsStdout([{ role: "user", content: "go" }, toolCall, toolResult, last]) })).execute(baseCtx().ctx);
  assert.equal(result.resultJson.runOutcome, "succeeded", result.errorMessage);
  assert.deepEqual(result.usage, { inputTokens: 130, outputTokens: 24, cachedInputTokens: 120 });
  assert.equal(result.usageBasis, "per_run");
  assert.equal(result.costUsd, 0.375);
});

test("usage: zero turns, duplicate message_end and resumed finals count the selected final once", async () => {
  const zero = await adapterWith(fakeRunner({ stdout: turnsStdout([assistant("z", { usage: usageOf(0, 0, 0, 0) })]) })).execute(baseCtx().ctx);
  assert.deepEqual([zero.usage, zero.usageBasis, zero.costUsd], [{ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, "per_run", 0]);
  assert.equal(zero.resultJson.diagnostics.usageOmitted, undefined);
  const a = assistant("a", { usage: usageOf(1, 2, 3, 0.5), stopReason: "toolUse" });
  const b = assistant("b", { usage: usageOf(10, 20, 30, 0.25) });
  const dup = turnsStdout([a, b]).replace(line({ type: "agent_start" }), line({ type: "agent_start" }) + line({ type: "message_end", message: a }).repeat(3));
  const resumed = line({ type: "agent_end", messages: [a], willContinue: true }) + line({ type: "turn_start" }) + line({ type: "message_end", message: b }) + line({ type: "agent_end", messages: [a, b] });
  for (const stdout of [dup, resumed]) {
    const r = await adapterWith(fakeRunner({ stdout })).execute(baseCtx().ctx);
    assert.equal(r.resultJson.runOutcome, "succeeded", r.errorMessage);
    assert.deepEqual([r.usage, r.costUsd], [{ inputTokens: 11, outputTokens: 22, cachedInputTokens: 33 }, 0.75]);
  }
});

test("usage: incomplete or unattributable turns omit per_run metering without changing the outcome", async () => {
  const good = assistant("a", { usage: usageOf(1, 2, 3, 0.5), stopReason: "toolUse" });
  const lastWith = (usage, extra = {}) => assistant("b", { usage, ...extra });
  const max = Number.MAX_SAFE_INTEGER;
  const cases = {
    missing: [turnsStdout([good, lastWith(undefined)]), "usage_invalid"],
    nullUsage: [turnsStdout([good, lastWith(null)]), "usage_invalid"],
    stringTokens: [turnsStdout([good, lastWith({ ...usageOf(1, 1, 1, 0.1), input: "5" })]), "usage_invalid"],
    negative: [turnsStdout([good, lastWith(usageOf(1, -1, 1, 0.1))]), "usage_invalid"],
    fractional: [turnsStdout([good, lastWith(usageOf(1, 1.5, 1, 0.1))]), "usage_invalid"],
    noCacheRead: [turnsStdout([good, lastWith({ input: 1, output: 1, cost: { total: 0.1 } })]), "usage_invalid"],
    infinite: [turnsStdout([good, lastWith(usageOf(7, 1, 1, 0.1))]).replaceAll('"input":7', '"input":1e309'), "usage_invalid"],
    overflow: [turnsStdout([lastWith(usageOf(max, 1, 1, 0.1), { stopReason: "toolUse" }), lastWith(usageOf(max, 1, 1, 0.1))]), "usage_invalid"],
    otherModel: [turnsStdout([good, lastWith(usageOf(1, 1, 1, 0.1), { model: "claude-other" })]), "multiple_models"],
    otherProvider: [turnsStdout([good, lastWith(usageOf(1, 1, 1, 0.1), { provider: "openai" })]), "multiple_models"],
  };
  for (const [name, [stdout, reason]] of Object.entries(cases)) {
    const r = await adapterWith(fakeRunner({ stdout })).execute(baseCtx().ctx);
    assert.equal(r.resultJson.runOutcome, "succeeded", `${name}: ${r.errorMessage}`);
    assert.deepEqual([r.usage, r.usageBasis, r.costUsd], [undefined, undefined, undefined], name);
    assert.equal(r.resultJson.diagnostics.usageOmitted, reason, name);
  }
  const failed = await adapterWith(fakeRunner({ stdout: turnsStdout([good, lastWith(undefined, { stopReason: "error" })]) })).execute(baseCtx().ctx);
  assert.equal(failed.errorCode, "omp_stop_error");
  assert.equal(failed.resultJson.diagnostics.usageOmitted, "usage_invalid");
});

test("usage: missing or invalid cost omits only costUsd; tokens stay per_run", async () => {
  const good = assistant("a", { usage: usageOf(1, 2, 3, 0.5), stopReason: "toolUse" });
  for (const cost of [undefined, -0.1, "0.1"]) {
    const usage = cost === undefined ? usageOf(10, 20, 30) : { ...usageOf(10, 20, 30), cost: { total: cost } };
    const r = await adapterWith(fakeRunner({ stdout: turnsStdout([good, assistant("b", { usage })]) })).execute(baseCtx().ctx);
    assert.equal(r.resultJson.runOutcome, "succeeded", r.errorMessage);
    assert.deepEqual([r.usage, r.usageBasis, r.costUsd], [{ inputTokens: 11, outputTokens: 22, cachedInputTokens: 33 }, "per_run", undefined], String(cost));
    assert.equal(r.resultJson.diagnostics.costOmitted, "cost_invalid", String(cost));
    assert.equal(r.resultJson.diagnostics.usageOmitted, undefined);
  }
});

test("exit 0 without a terminal agent_end is a failure", async () => {
  const stdout = line(SESSION_HEADER) + line({ type: "agent_start" }) + line({ type: "message_end", message: assistant("partial") });
  const result = await adapterWith(fakeRunner({ stdout })).execute(baseCtx().ctx);
  assert.equal(result.errorCode, "omp_final_event_missing");
  assert.ok(result.errorMessage);
  assert.equal(result.resultJson.runOutcome, "failed");
});

test("non-terminal agent_end (willContinue) is not treated as final", async () => {
  const stdout = line({ type: "agent_end", messages: [assistant("interim")], willContinue: true });
  const result = await adapterWith(fakeRunner({ stdout })).execute(baseCtx().ctx);
  assert.equal(result.errorCode, "omp_final_event_missing");
});

test("agent_end without assistant message is a failure", async () => {
  const stdout = line({ type: "agent_end", messages: [{ role: "user", content: "hi" }] });
  const result = await adapterWith(fakeRunner({ stdout })).execute(baseCtx().ctx);
  assert.equal(result.errorCode, "omp_final_message_missing");
});

test("final assistant stopReason error/aborted is a failure even on exit 0", async () => {
  for (const stopReason of ["error", "aborted"]) {
    const stdout = okStdout("", { stopReason, errorMessage: `provider broke ${AUTH_TOKEN}` });
    const result = await adapterWith(fakeRunner({ stdout })).execute(baseCtx().ctx);
    assert.equal(result.errorCode, `omp_stop_${stopReason}`);
    assertNoSecrets(result, "stop error result");
  }
});

test("invalid JSON lines and truncated tail fail closed and never fabricate a final", async () => {
  const garbage = "not json\n{\"type\":\n" + line({ type: "agent_start" });
  const truncated = garbage + JSON.stringify({ type: "agent_end", messages: [assistant("cut")] }).slice(0, 30);
  const result = await adapterWith(fakeRunner({ stdout: truncated })).execute(baseCtx().ctx);
  assert.equal(result.errorCode, "omp_output_damaged");
  assert.equal(result.resultJson.runOutcome, "failed");
  assert.equal(result.resultJson.diagnostics.malformedLines, 2);
  assert.equal(result.resultJson.diagnostics.truncatedTail, true);

  // Same garbage before an otherwise valid final is still damage, not success.
  const damaged = await adapterWith(fakeRunner({ stdout: garbage + okStdout() })).execute(baseCtx().ctx);
  assert.equal(damaged.exitCode, 0);
  assert.equal(damaged.errorCode, "omp_output_damaged");
  assert.equal(damaged.resultJson.runOutcome, "failed");
  assert.equal(damaged.resultJson.diagnostics.malformedLines, 2);
});

test("damaged or capped captures fail closed even with an otherwise valid final", async () => {
  const valid = okStdout();
  const cases = [
    ["malformed_lines", "not json\n" + valid],
    ["truncated_tail", valid + '{"type":"turn_st'],
    ["oversized_lines", line({ type: "message_update", blob: "x".repeat(1024 * 1024 + 1) }) + valid],
    ["event_cap", line({ type: "turn_start" }).repeat(50_000) + valid],
    ["capture_cap", ...((pad) => [pad("p") + valid, { chunks: [pad("q") + valid] }])((c) => { const u = line({ type: "message_update", text: "x".repeat(1000) }); const k = Math.floor((MAX_CAPTURE_BYTES - valid.length) / u.length) - 1; return u.repeat(k) + line({ type: "message_update", text: c.repeat(MAX_CAPTURE_BYTES - valid.length - k * u.length - line({ type: "message_update", text: "" }).length) }); })],
    ["final_text_cap", okStdout("y".repeat(64 * 1024 + 1))],
  ];
  for (const [reason, stdout, runnerOpts] of cases) {
    if (reason === "capture_cap") assert.equal(stdout.length, MAX_CAPTURE_BYTES);
    const result = await adapterWith(fakeRunner({ stdout, ...runnerOpts })).execute(baseCtx().ctx);
    assert.equal(result.exitCode, 0, reason);
    assert.equal(result.errorCode, "omp_output_damaged", reason);
    assert.equal(result.resultJson.runOutcome, "failed", reason);
    assert.ok(result.resultJson.diagnostics.damage.includes(reason), `${reason}: ${result.resultJson.diagnostics.damage}`);
    assert.equal(result.resultJson.issueCompletion, "not_asserted_by_adapter");
    assert.equal(result.resultJson.approval, "not_asserted_by_adapter");
  }
});

test("only a known success stopReason may succeed; unknown/missing/non-success fail closed", async () => {
  for (const stopReason of ["length", "toolUse"]) {
    const result = await adapterWith(fakeRunner({ stdout: okStdout("x", { stopReason }) })).execute(baseCtx().ctx);
    assert.equal(result.errorCode, `omp_stop_${stopReason}`);
    assert.equal(result.resultJson.runOutcome, "failed");
  }
  for (const stopReason of ["weird_reason_zz", undefined, 7]) {
    const result = await adapterWith(fakeRunner({ stdout: okStdout("x", { stopReason }) })).execute(baseCtx().ctx);
    assert.equal(result.errorCode, "omp_stop_reason_unknown", String(stopReason));
    assert.equal(result.resultJson.runOutcome, "failed");
    assert.equal(result.resultJson.stopReason, null);
    assert.ok(!allText(result).includes("weird_reason_zz"), "unknown stopReason is not echoed");
  }
});

test("a prior final is invalidated by a later continuation or execution event", async () => {
  const cont = okStdout("first") + line({ type: "agent_end", messages: [assistant("interim")], willContinue: true });
  const r1 = await adapterWith(fakeRunner({ stdout: cont })).execute(baseCtx().ctx);
  assert.equal(r1.errorCode, "omp_final_event_missing");
  assert.equal(r1.resultJson.runOutcome, "failed");

  const activity = okStdout("first") + line({ type: "turn_start" }) + line({ type: "message_update", message: assistant("more") });
  const r2 = await adapterWith(fakeRunner({ stdout: activity })).execute(baseCtx().ctx);
  assert.equal(r2.errorCode, "omp_final_event_missing");
  assert.equal(r2.resultJson.runOutcome, "failed");

  // positive control: continuation followed by a clean terminal agent_end
  const resumed = cont + line({ type: "turn_start" }) + line({ type: "agent_end", messages: [assistant("second")] });
  const r3 = await adapterWith(fakeRunner({ stdout: resumed })).execute(baseCtx().ctx);
  assert.ok(!r3.errorCode, r3.errorCode);
  assert.equal(r3.summary, "second");
  assert.equal(r3.resultJson.runOutcome, "succeeded");
});

test("timeout, signal and nonzero exit are failures with distinct codes", async () => {
  const t = await adapterWith(fakeRunner({ exitCode: null, signal: "SIGTERM", timedOut: true, stdout: "" })).execute(baseCtx().ctx);
  assert.equal(t.timedOut, true);
  assert.equal(t.errorCode, "omp_timeout");
  const s = await adapterWith(fakeRunner({ exitCode: null, signal: "SIGKILL", stdout: "" })).execute(baseCtx().ctx);
  assert.equal(s.signal, "SIGKILL");
  assert.equal(s.errorCode, "omp_signal");
  const n = await adapterWith(fakeRunner({ exitCode: 2, stderrChunks: [`bad flag ${AUTH_TOKEN}\n`], stdout: "" })).execute(baseCtx().ctx);
  assert.equal(n.exitCode, 2);
  assert.equal(n.errorCode, "omp_exit_nonzero");
  assertNoSecrets(n, "nonzero result");
  // nonzero exit with a seemingly fine final event is still not success
  const n2 = await adapterWith(fakeRunner({ exitCode: 1 })).execute(baseCtx().ctx);
  assert.equal(n2.errorCode, "omp_exit_nonzero");
  assert.equal(n2.resultJson.runOutcome, "failed");
});

test("runner rejection after dispatch is uncertain, never not_started", async () => {
  const runner = fakeRunner({ reject: new Error(`Failed to start command with ${AUTH_TOKEN}`) });
  const { ctx } = baseCtx();
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(result.errorCode, "omp_runner_rejected");
  assert.equal(result.resultJson.runOutcome, "uncertain");
  assertNoSecrets(result, "spawn failure");
});

test("runner that invokes onSpawn and then rejects is uncertain, not not_started", async () => {
  const runner = nativeLikeRunner({ rejectAfterSpawn: new Error(`child error ${AUTH_TOKEN}`) });
  const { ctx, spawns } = baseCtx();
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(spawns.length, 1);
  assert.equal(result.errorCode, "omp_runner_rejected");
  assert.equal(result.resultJson.runOutcome, "uncertain");
  assert.notEqual(result.resultJson.runOutcome, "not_started");
  assertNoSecrets(result, "post-spawn rejection");
});

test("onSpawn sync throw / async reject keeps native registration and blocks success", async () => {
  const throwers = {
    sync: () => {
      throw new Error(`sync spawn record failure ${AUTH_TOKEN}`);
    },
    async: async () => {
      throw new Error(`async spawn record failure ${AUTH_TOKEN}`);
    },
  };
  for (const [kind, onSpawn] of Object.entries(throwers)) {
    const runner = nativeLikeRunner();
    const { ctx } = baseCtx({ onSpawn });
    let result;
    const warned = await withWarnSpy(async () => {
      result = await adapterWith(runner).execute(ctx);
    });
    assert.equal(runner.state.registered, true, `${kind}: native registration must still execute`);
    assert.equal(runner.state.usedDefaultOnLogError, false, `${kind}: safe onLogError supplied`);
    assert.equal(warned.length, 0, `${kind}: native console.warn must not be reached`);
    assert.equal(result.errorCode, "omp_spawn_record_failed", kind);
    assert.notEqual(result.resultJson.runOutcome, "succeeded", kind);
    assertNoSecrets(result, `${kind} onSpawn failure`);
  }
});

test("onLog rejection is tracked, blocks success and never reaches console.warn", async () => {
  const runner = nativeLikeRunner();
  const { ctx } = baseCtx({
    onLog: async () => {
      throw new Error(`log sink down ${AUTH_TOKEN}`);
    },
  });
  let result;
  const warned = await withWarnSpy(async () => {
    result = await adapterWith(runner).execute(ctx);
    // the supplied onLogError itself must be inert and non-throwing
    assert.equal(typeof runner.state.onLogError, "function");
    assert.doesNotThrow(() => runner.state.onLogError(new Error(`late ${AUTH_TOKEN}`), "run-1", "msg"));
  });
  assert.equal(warned.length, 0);
  assert.equal(result.errorCode, "omp_log_publication_failed");
  assert.notEqual(result.resultJson.runOutcome, "succeeded");
  assertNoSecrets(result, "onLog failure");
});

test("already-aborted run signal does not spawn", async () => {
  const controller = new AbortController();
  controller.abort();
  const runner = fakeRunner();
  const result = await adapterWith(runner).execute(baseCtx({ signal: controller.signal }).ctx);
  assert.equal(runner.calls.length, 0);
  assert.equal(result.errorCode, "omp_cancelled_before_spawn");
});

// ---------------------------------------------------------------- bounded collection

test("parser bounds line size, event count and final text", () => {
  const huge = line({ type: "message_update", blob: "x".repeat(2048) });
  const parsed = parseOmpJsonOutput(huge + line({ type: "agent_end", messages: [assistant("y".repeat(500))] }), {
    maxLineBytes: 1024,
    maxEvents: 10,
    maxFinalTextChars: 100,
  });
  assert.equal(parsed.oversizedLines, 1);
  assert.equal(parsed.finalText.length, 100);
  assert.equal(parsed.finalTextTruncated, true);
  assert.deepEqual(parsed.damage.sort(), ["final_text_cap", "oversized_lines"]);

  const many = Array.from({ length: 50 }, () => line({ type: "turn_start" })).join("") + line({ type: "agent_end", messages: [assistant("z")] });
  const p2 = parseOmpJsonOutput(many, { maxEvents: 10 });
  assert.equal(p2.eventCount, 10, "parsing stops at the event bound");
  assert.equal(p2.eventCapExceeded, true);
  assert.equal(p2.final, null, "no final is accepted beyond the event cap");
  assert.ok(p2.damage.includes("event_cap"));
});

test("parser redacts the entire final text before applying the display limit", () => {
  const parsed = parseOmpJsonOutput(line({ type: "agent_end", messages: [assistant("....SECRET")] }), {
    maxFinalTextChars: 6,
    redact: (s) => redactText(s, ["SECRET"]),
  });
  assert.ok(!parsed.finalText.includes("SE"), parsed.finalText);
  assert.equal(parsed.finalText, "....**");
});

test("capture-limit flag set when native capture may have dropped the head", () => {
  const parsed = parseOmpJsonOutput("x".repeat(64) + "\n", { captureLimitChars: 64 });
  assert.equal(parsed.captureMayBeTruncated, true);
});

// ---------------------------------------------------------------- testEnvironment

test("testEnvironment validates config and probes the binary without launching it", async () => {
  const probed = [];
  const adapter = createServerAdapter({
    runChildProcess: async () => {
      throw new Error("must not launch");
    },
    accessExecutable: async (p) => {
      probed.push(p);
    },
  });
  const ok = await adapter.testEnvironment({ companyId: "co-1", adapterType: ADAPTER_TYPE, config: { cwd: WORKDIR } });
  assert.equal(ok.adapterType, ADAPTER_TYPE);
  assert.equal(ok.status, "pass");
  assert.deepEqual(probed, [OMP_COMMAND]);
  const bad = await adapter.testEnvironment({ companyId: "co-1", adapterType: ADAPTER_TYPE, config: { cwd: WORKDIR, approvalMode: "auto" } });
  assert.equal(bad.status, "fail");
  const missing = await createServerAdapter({
    accessExecutable: async () => {
      throw new Error("ENOENT");
    },
  }).testEnvironment({ companyId: "co-1", adapterType: ADAPTER_TYPE, config: { cwd: WORKDIR } });
  assert.equal(missing.status, "fail");
});

// ---------------------------------------------------------------- workspace cwd
// Consumption protocol of the native Pi adapter (adapter-pi-local
// dist/server/execute.js:160-175): ctx.context.paperclipWorkspace.cwd wins unless
// its source is "agent_home" and config.cwd is set; config.cwd is the fallback.
// context.paperclipWorkspaces is only a hint list and never selects the cwd.

const PROJECT_DIR = path.join(WORKDIR, "project-ws");
const AGENT_HOME_DIR = path.join(WORKDIR, "agent-home");
const PLAIN_FILE = path.join(WORKDIR, "not-a-dir.txt");
mkdirSync(PROJECT_DIR);
mkdirSync(AGENT_HOME_DIR);
writeFileSync(PLAIN_FILE, "x");

function wsCtx({ workspace, config, hints, target, transport } = {}) {
  const made = baseCtx();
  if (workspace !== undefined) made.ctx.context.paperclipWorkspace = workspace;
  if (hints !== undefined) made.ctx.context.paperclipWorkspaces = hints;
  if (config !== undefined) made.ctx.config = { ...config, env: { ...(config.env ?? {}), PAPERCLIP_RUN_SCRATCH_DIR: made.ctx.config.env.PAPERCLIP_RUN_SCRATCH_DIR } };
  if (target !== undefined) made.ctx.executionTarget = target;
  if (transport !== undefined) made.ctx.executionTransport = transport;
  return made;
}
const projectWs = (cwd = PROJECT_DIR) => ({ cwd, source: "project_primary", workspaceId: "ws-1", agentHome: AGENT_HOME_DIR });
const noCwdConfig = { timeoutSec: 120, graceSec: 5 };

function assertSpawnedIn(runner, metas, dir, label) {
  assert.equal(runner.calls.length, 1, `${label}: expected one spawn`);
  const { args, opts } = runner.calls[0];
  assert.equal(args[args.indexOf("--cwd") + 1], dir, `${label}: argv --cwd`);
  assert.equal(opts.cwd, dir, `${label}: runner cwd`);
  assert.equal(metas.length, 1, `${label}: one onMeta`);
  assert.equal(metas[0].cwd, dir, `${label}: onMeta cwd`);
}

function assertRefusedBeforeSpawn(result, runner, metas, code, label) {
  assert.equal(runner.calls.length, 0, `${label}: spawned`);
  assert.equal(metas.length, 0, `${label}: onMeta before refusal`);
  assert.equal(result.errorCode, code, `${label}: errorCode`);
  assert.deepEqual(result.executionRecovery, { kind: "bootstrap", providerWorkStarted: false }, label);
  assert.equal(result.resultJson.runOutcome, "not_started", label);
}

test("workspace: project paperclipWorkspace.cwd overrides config cwd; argv, onMeta and runner agree", async () => {
  const runner = fakeRunner();
  const { ctx, metas } = wsCtx({ workspace: projectWs() });
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(result.resultJson.runOutcome, "succeeded");
  assertSpawnedIn(runner, metas, PROJECT_DIR, "project");
});

test("workspace: agent_home source keeps a nonempty config cwd, else runs in agent home", async () => {
  const home = { cwd: AGENT_HOME_DIR, source: "agent_home", agentHome: AGENT_HOME_DIR };
  const withConfig = fakeRunner();
  const a = wsCtx({ workspace: home });
  await adapterWith(withConfig).execute(a.ctx);
  assertSpawnedIn(withConfig, a.metas, WORKDIR, "agent_home + config");

  for (const config of [noCwdConfig, { ...noCwdConfig, cwd: "" }, { ...noCwdConfig, cwd: null }]) {
    const runner = fakeRunner();
    const b = wsCtx({ workspace: home, config });
    const result = await adapterWith(runner).execute(b.ctx);
    assert.equal(result.resultJson.runOutcome, "succeeded", JSON.stringify(config));
    assertSpawnedIn(runner, b.metas, AGENT_HOME_DIR, `agent_home without config ${JSON.stringify(config)}`);
  }
});

test("workspace: agent_home with an invalid config cwd is refused, never replaced by agent home", async () => {
  for (const cwd of ["relative/dir", `${WORKDIR}\u0000/etc`, path.join(WORKDIR, "missing"), PLAIN_FILE, 7]) {
    const runner = fakeRunner();
    const { ctx, metas } = wsCtx({ workspace: { cwd: AGENT_HOME_DIR, source: "agent_home" }, config: { ...noCwdConfig, cwd } });
    const result = await adapterWith(runner).execute(ctx);
    assertRefusedBeforeSpawn(result, runner, metas, "omp_config_invalid", `agent_home config ${JSON.stringify(cwd)}`);
  }
});

test("workspace: absent workspace cwd falls back to config cwd; hints never select a workspace", async () => {
  const hints = [{ workspaceId: "ws-hint", cwd: PROJECT_DIR, repoUrl: null }];
  for (const workspace of [undefined, null, {}, { source: "project_primary" }, { cwd: null }, { cwd: "" }, "str"]) {
    const runner = fakeRunner();
    const { ctx, metas } = wsCtx({ workspace, hints });
    const result = await adapterWith(runner).execute(ctx);
    assert.equal(result.resultJson.runOutcome, "succeeded", JSON.stringify(workspace));
    assertSpawnedIn(runner, metas, WORKDIR, `fallback ${JSON.stringify(workspace)}`);
  }
  // No workspace cwd and no config cwd: refused, never process.cwd() or a hint.
  const runner = fakeRunner();
  const { ctx, metas } = wsCtx({ workspace: { source: "project_primary" }, hints, config: noCwdConfig });
  const result = await adapterWith(runner).execute(ctx);
  assertRefusedBeforeSpawn(result, runner, metas, "omp_config_invalid", "no cwd anywhere");
});

test("workspace: invalid selected workspace cwd refuses before spawn without falling back", async () => {
  const bad = ["relative/dir", "--help", `${PROJECT_DIR}\u0000/etc`, 42, true, {}, ["/tmp"], path.join(WORKDIR, "missing-ws"), PLAIN_FILE];
  for (const cwd of bad) {
    const runner = fakeRunner();
    const { ctx, metas } = wsCtx({ workspace: projectWs(cwd) });
    const result = await adapterWith(runner).execute(ctx);
    assertRefusedBeforeSpawn(result, runner, metas, "omp_workspace_invalid", `workspace ${JSON.stringify(cwd)}`);
  }
});

test("workspace: missing or invalid unselected config cwd does not block a valid project workspace", async () => {
  const configs = [noCwdConfig, { ...noCwdConfig, cwd: "relative/dir" }, { ...noCwdConfig, cwd: `${WORKDIR}\u0000x` },
    { ...noCwdConfig, cwd: path.join(WORKDIR, "missing") }, { ...noCwdConfig, cwd: PLAIN_FILE }, { ...noCwdConfig, cwd: 5 }];
  for (const config of configs) {
    const runner = fakeRunner();
    const { ctx, metas } = wsCtx({ workspace: projectWs(), config });
    const result = await adapterWith(runner).execute(ctx);
    assert.equal(result.resultJson.runOutcome, "succeeded", JSON.stringify(config));
    assertSpawnedIn(runner, metas, PROJECT_DIR, `config ${JSON.stringify(config)}`);
  }
  // Other config keys are still validated regardless of the selected cwd.
  const runner = fakeRunner();
  const { ctx, metas } = wsCtx({ workspace: projectWs(), config: { ...noCwdConfig, approvalMode: "auto" } });
  assertRefusedBeforeSpawn(await adapterWith(runner).execute(ctx), runner, metas, "omp_config_invalid", "approvalMode");
});

test("workspace: path refusals never echo the path or leak secrets into result, logs or meta", async () => {
  const secretPaths = [path.join(WORKDIR, `missing-${AUTH_TOKEN}`), `rel/${TOOLS_TOKEN}`, `${AUTH_TOKEN}\u0000`];
  for (const cwd of secretPaths) {
    for (const made of [
      wsCtx({ workspace: projectWs(cwd) }),
      wsCtx({ workspace: { cwd: AGENT_HOME_DIR, source: "agent_home" }, config: { ...noCwdConfig, cwd } }),
    ]) {
      const runner = fakeRunner();
      const result = await adapterWith(runner).execute(made.ctx);
      assert.equal(runner.calls.length, 0);
      assert.ok(result.errorMessage);
      assert.ok(!allText(result).includes(cwd), "refusal echoes the rejected path");
      assertNoSecrets([result, made.logs, made.metas], "workspace refusal");
    }
  }
});

test("workspace: remote or unrecognised execution targets are refused before spawn", async () => {
  const privateKey = "-----PRIVATE-KEY-SYNTHETIC-SECRET-----";
  const ssh = { host: "remote.example", port: 22, username: "u", remoteCwd: "/remote/ws", privateKey };
  const refused = [
    { target: { kind: "remote", transport: "ssh", spec: ssh } },
    { target: { kind: "remote", transport: "sandbox", remoteCwd: "/sandbox/ws" } },
    { target: { kind: "remote", transport: "sandbox" } },
    { target: { kind: "elsewhere" } },
    { transport: { remoteExecution: ssh } },
    { target: { kind: "local" }, transport: { remoteExecution: ssh } },
  ];
  for (const patch of refused) {
    const runner = fakeRunner();
    const { ctx, metas, logs } = wsCtx({ workspace: projectWs(), ...patch });
    const result = await adapterWith(runner).execute(ctx);
    assertRefusedBeforeSpawn(result, runner, metas, "omp_execution_target_unsupported", JSON.stringify(patch));
    assert.ok(!JSON.stringify([result, logs]).includes(privateKey));
  }
  for (const target of [undefined, null, { kind: "local" }, { kind: "local", environmentId: "env-1", leaseId: "lease-1" }]) {
    const runner = fakeRunner();
    const { ctx, metas } = wsCtx({ workspace: projectWs(), target });
    const result = await adapterWith(runner).execute(ctx);
    assert.equal(result.resultJson.runOutcome, "succeeded", JSON.stringify(target));
    assertSpawnedIn(runner, metas, PROJECT_DIR, `local target ${JSON.stringify(target)}`);
  }
});

test("workspace: testEnvironment validates only config cwd", async () => {
  const adapter = createServerAdapter({ accessExecutable: async () => {} });
  for (const config of [{}, { cwd: "relative/dir" }, { cwd: path.join(WORKDIR, "missing") }, { cwd: PLAIN_FILE }]) {
    const r = await adapter.testEnvironment({ companyId: "co-1", adapterType: ADAPTER_TYPE, config });
    assert.equal(r.status, "fail", JSON.stringify(config));
    assert.ok(r.checks.some((c) => c.code === "omp_config_invalid"));
  }
  const ok = await adapter.testEnvironment({ companyId: "co-1", adapterType: ADAPTER_TYPE, config: { cwd: PROJECT_DIR } });
  assert.equal(ok.status, "pass");
});

// ---------------------------------------------------------------- S1 pre-dispatch recovery evidence

// Stages one real runtime skill in the run scratch so pre-dispatch cleanup is observable.
function stagedSkillCtx(overrides = {}) {
  const made = baseCtx(overrides);
  const source = mkdtempSync(path.join(WORKDIR, "s1-skill-"));
  writeFileSync(path.join(source, "SKILL.md"), "---\nname: alpha\ndescription: Synthetic S1 skill.\n---\nBody.\n");
  Object.assign(made.ctx.config, {
    paperclipSkillSync: { desiredSkills: ["s1/alpha"] },
    paperclipRuntimeSkills: [{ key: "s1/alpha", runtimeName: "alpha", source, versionId: "v1", currentVersionId: "v1", sourceStatus: "available" }],
  });
  return { ...made, scratchDir: made.ctx.context.paperclipScratch.dir };
}
const trustedBaseline = { readOmpSkillBaseline: async () => ({ trusted: true, config: { skills: { customDirectories: [] } } }) };

function assertBootstrapNotStarted(result, code, label) {
  assert.equal(result.errorCode, code, `${label}: errorCode`);
  assert.deepEqual(result.executionRecovery, { kind: "bootstrap", providerWorkStarted: false }, label);
  assert.equal(result.resultJson.runOutcome, "not_started", label);
  assertNoSecrets(result, label);
}

test("S1: onMeta rejection before dispatch returns bootstrap, cleans staging, and redacts the cause", async () => {
  const runner = fakeRunner();
  let onMetaCalls = 0;
  const { ctx, scratchDir } = stagedSkillCtx({
    onMeta: async () => {
      onMetaCalls++;
      throw new Error(`meta store down ${AUTH_TOKEN}`);
    },
  });
  const result = await adapterWith(runner, trustedBaseline).execute(ctx);
  assert.equal(onMetaCalls, 1);
  assert.equal(runner.calls.length, 0);
  assertBootstrapNotStarted(result, "omp_meta_record_failed", "onMeta reject");
  assert.ok(!allText(result).includes("meta store down"), "raw onMeta error must not be surfaced");
  assert.deepEqual(readdirSync(scratchDir), [], "prepared runtime skills must be cleaned up");
  assert.equal(result.resultJson.runtimeSkills.cleanupWarning, undefined);
});

test("S1: onMeta getter throw before dispatch returns bootstrap; onMeta read once with this=ctx", async () => {
  const runner = fakeRunner();
  let reads = 0;
  const hostile = new Error(`getter boom ${AUTH_TOKEN}`);
  hostile.cause = { toString() { throw new Error(`hostile cause ${AUTH_TOKEN}`); } };
  const { ctx, scratchDir } = stagedSkillCtx({});
  Object.defineProperty(ctx, "onMeta", { configurable: true, get() { reads++; throw hostile; } });
  const result = await adapterWith(runner, trustedBaseline).execute(ctx);
  assert.equal(reads, 1);
  assert.equal(runner.calls.length, 0);
  assertBootstrapNotStarted(result, "omp_meta_record_failed", "onMeta getter");
  assert.ok(!allText(result).includes("getter boom") && !allText(result).includes("hostile cause"));
  assert.deepEqual(readdirSync(scratchDir), []);

  let reads2 = 0;
  let seenThis;
  const made2 = stagedSkillCtx({});
  const fn = async function () { seenThis = this; throw new Error("x"); };
  Object.defineProperty(made2.ctx, "onMeta", { configurable: true, get() { reads2++; return fn; } });
  const r2 = await adapterWith(fakeRunner(), trustedBaseline).execute(made2.ctx);
  assert.equal(reads2, 1);
  assert.equal(seenThis, made2.ctx);
  assertBootstrapNotStarted(r2, "omp_meta_record_failed", "onMeta this");
});

test("S1: non-Refusal pre-dispatch exception after staging returns bootstrap, cleans staging, and redacts the cause", async () => {
  const runner = fakeRunner();
  const metas = [];
  let reads = 0;
  // The first abort check passes; the post-staging re-check throws a plain (non-Refusal) error.
  const signal = {
    get aborted() {
      reads++;
      if (reads > 1) throw new Error(`signal broken ${AUTH_TOKEN}`);
      return false;
    },
  };
  const { ctx, scratchDir } = stagedSkillCtx({ signal, onMeta: async (m) => metas.push(m) });
  const result = await adapterWith(runner, trustedBaseline).execute(ctx);
  assert.equal(reads, 2, "the throw must come from the post-staging re-check");
  assert.equal(runner.calls.length, 0);
  assert.equal(metas.length, 0);
  assertBootstrapNotStarted(result, "omp_preflight_failed", "preflight throw");
  assert.ok(!allText(result).includes("signal broken"), "raw preflight error must not be surfaced");
  assert.deepEqual(readdirSync(scratchDir), [], "prepared runtime skills must be cleaned up");
});

// Explicitly synthetic fixture value; never a real credential.
test("S1 final: onMeta uses callable semantics without reading an overridden call property", async () => {
  let realCalls = 0;
  let overrideCalls = 0;
  let receiver;
  const fn = function () { realCalls++; receiver = this; };
  fn.call = () => { overrideCalls++; };
  const { ctx } = baseCtx({ onMeta: fn });
  const runner = fakeRunner();
  const result = await createServerAdapter({ runChildProcess: runner.run }).execute(ctx);
  assert.equal(realCalls, 1);
  assert.equal(overrideCalls, 0);
  assert.equal(receiver, ctx);
  assert.equal(runner.calls.length, 1);
  assert.equal(result.resultJson.runOutcome, "succeeded");

  let proxyCalls = 0;
  let callReads = 0;
  const proxy = new Proxy(function () { proxyCalls++; }, {
    get(target, key, receiver) {
      if (key === "call") { callReads++; throw new Error("SYNTHETIC-call-getter"); }
      return Reflect.get(target, key, receiver);
    },
  });
  const proxyCtx = baseCtx({ onMeta: proxy }).ctx;
  const proxyRunner = fakeRunner();
  const proxyResult = await createServerAdapter({ runChildProcess: proxyRunner.run }).execute(proxyCtx);
  assert.equal(proxyCalls, 1);
  assert.equal(callReads, 0);
  assert.equal(proxyResult.resultJson.runOutcome, "succeeded");

  let objectCalls = 0;
  const objectCtx = baseCtx({ onMeta: { call() { objectCalls++; } } }).ctx;
  const objectRunner = fakeRunner();
  const objectResult = await createServerAdapter({ runChildProcess: objectRunner.run }).execute(objectCtx);
  assert.equal(objectCalls, 0);
  assert.equal(objectRunner.calls.length, 0);
  assert.equal(objectResult.errorCode, "omp_meta_record_failed");
  assert.deepEqual(objectResult.executionRecovery, { kind: "bootstrap", providerWorkStarted: false });
});

test("S1 final: onMeta thrown cause properties are never inspected", async () => {
  let causeReads = 0;
  const cause = new Proxy({}, { get() { causeReads++; return "SYNTHETIC-hostile-cause"; } });
  const { ctx, scratchDir } = stagedSkillCtx({});
  Object.defineProperty(ctx, "onMeta", { get() { throw cause; } });
  const runner = fakeRunner();
  const result = await adapterWith(runner, trustedBaseline).execute(ctx);
  assert.equal(causeReads, 0);
  assert.equal(result.errorCode, "omp_meta_record_failed");
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(readdirSync(scratchDir), []);
  assert.deepEqual(result.executionRecovery, { kind: "bootstrap", providerWorkStarted: false });
});

test("thinking: absent preserves argv and explicit supported levels are separate CLI arguments", async () => {
  const omitted = fakeRunner();
  await adapterWith(omitted).execute(baseCtx().ctx);
  assert.equal(omitted.calls[0].args.includes("--thinking"), false);
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]) {
    const runner = fakeRunner();
    const { ctx } = baseCtx();
    ctx.config.thinking = level;
    const result = await adapterWith(runner).execute(ctx);
    assert.equal(result.resultJson.runOutcome, "succeeded");
    const i = runner.calls[0].args.indexOf("--thinking");
    assert.notEqual(i, -1);
    assert.equal(runner.calls[0].args[i + 1], level);
    assert.equal(runner.calls[0].args.filter((v) => v === "--thinking").length, 1);
  }
});

test("thinking: invalid values refuse before dispatch without echoing values", async () => {
  for (const value of [null, true, 3, {}, [], "", "HIGH", "low --profile other", AUTH_TOKEN]) {
    const runner = fakeRunner();
    const { ctx } = baseCtx();
    ctx.config.thinking = value;
    const result = await adapterWith(runner).execute(ctx);
    assert.equal(runner.calls.length, 0);
    assert.equal(result.errorCode, "omp_config_invalid");
    assert.deepEqual(result.executionRecovery, { kind: "bootstrap", providerWorkStarted: false });
    assert.equal(result.errorMessage, "config.thinking must be a supported reasoning level.");
    assertNoSecrets(result, "invalid thinking refusal");
  }
});

test("thinking: getter is read once and only that validated level reaches argv", async () => {
  const runner = fakeRunner();
  const { ctx } = baseCtx();
  let reads = 0;
  Object.defineProperty(ctx.config, "thinking", {
    enumerable: true,
    get() { reads++; return reads === 1 ? "low" : "high --profile other"; },
  });
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(result.resultJson.runOutcome, "succeeded");
  assert.equal(reads, 1);
  const i = runner.calls[0].args.indexOf("--thinking");
  assert.equal(runner.calls[0].args[i + 1], "low");
});

const C_SYNTHETIC = "SYNTHETIC-C-FIXTURE-not-a-real-key-7f3a";

test("S1 C1: a throw from the post-onMeta abort re-check returns bootstrap, cleans staging, and redacts the cause", async () => {
  const runner = fakeRunner();
  const metas = [];
  let reads = 0;
  // Preflight and post-staging checks pass; the third read (after onMeta, before dispatch) throws.
  const signal = {
    get aborted() {
      reads++;
      if (reads > 2) throw new Error(`signal broken ${C_SYNTHETIC} ${AUTH_TOKEN}`);
      return false;
    },
  };
  const { ctx, scratchDir } = stagedSkillCtx({ signal, onMeta: async (m) => metas.push(m) });
  const result = await adapterWith(runner, trustedBaseline).execute(ctx);
  assert.equal(reads, 3, "the throw must come from the post-onMeta re-check");
  assert.equal(metas.length, 1);
  assert.equal(runner.calls.length, 0);
  assertBootstrapNotStarted(result, "omp_preflight_failed", "post-onMeta abort throw");
  assert.ok(!allText(result).includes("signal broken"), "raw error must not be surfaced");
  assert.ok(!allText(result).includes(C_SYNTHETIC), "synthetic fixture value must not be surfaced");
  assert.deepEqual(readdirSync(scratchDir), [], "prepared runtime skills must be cleaned up");
  assert.equal(result.resultJson.runtimeSkills.cleanupWarning, undefined);

  // onMeta's first error code keeps priority: the throwing re-check is never reached.
  const runner2 = fakeRunner();
  let reads2 = 0;
  const signal2 = {
    get aborted() {
      reads2++;
      if (reads2 > 2) throw new Error(`signal broken ${C_SYNTHETIC}`);
      return false;
    },
  };
  const staged2 = stagedSkillCtx({ signal: signal2, onMeta: async () => { throw new Error(`meta down ${C_SYNTHETIC}`); } });
  const result2 = await adapterWith(runner2, trustedBaseline).execute(staged2.ctx);
  assert.equal(reads2, 2);
  assert.equal(runner2.calls.length, 0);
  assertBootstrapNotStarted(result2, "omp_meta_record_failed", "onMeta first");
  assert.ok(!allText(result2).includes(C_SYNTHETIC));
  assert.deepEqual(readdirSync(staged2.scratchDir), []);
});

test("S1 C2: a redactor preparation failure returns a fixed bootstrap result without touching the cause", async () => {
  // A thrown value that records any read of its code/message; the adapter must read neither.
  let causeReads = 0;
  const hostile = {
    get code() { causeReads++; return `hostile-code-${C_SYNTHETIC}`; },
    get message() { causeReads++; return `hostile message ${C_SYNTHETIC}`; },
  };
  const triggers = {
    "authToken getter": (ctx) => Object.defineProperty(ctx, "authToken", { get() { throw hostile; } }),
    "runtimeTools.bearerToken getter": (ctx) => Object.defineProperty(ctx.runtimeTools, "bearerToken", { get() { throw new Error(`tools ${C_SYNTHETIC}`); } }),
    "config.env sensitive value getter": (ctx) => Object.defineProperty(ctx.config.env, "API_TOKEN", { enumerable: true, get() { throw new Error(`env ${C_SYNTHETIC}`); } }),
  };
  for (const [label, install] of Object.entries(triggers)) {
    const runner = fakeRunner();
    const { ctx, metas, logs, spawns } = baseCtx();
    install(ctx);
    const result = await adapterWith(runner).execute(ctx);
    assert.deepEqual(
      result,
      {
        exitCode: null,
        signal: null,
        timedOut: false,
        errorCode: "omp_redactor_prepare_failed",
        errorMessage: "Preparing secret redaction failed before OMP started.",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        resultJson: { adapter: ADAPTER_TYPE, runOutcome: "not_started", issueCompletion: "not_asserted_by_adapter", approval: "not_asserted_by_adapter" },
      },
      label,
    );
    assert.equal(runner.calls.length, 0, label);
    assert.deepEqual([metas.length, logs.length, spawns.length], [0, 0, 0], label);
    assert.deepEqual(readdirSync(ctx.context.paperclipScratch.dir), [], label);
    assert.ok(!allText(result).includes(C_SYNTHETIC), label);
  }
  assert.equal(causeReads, 0, "the thrown cause's properties must never be read");
});

// ---------------------------------------------------------------- S2 progress events (ctx.onEvent)
// Synthetic OMP tool events exercising the 18.10 protocol shape:
// {"type":"tool_execution_start","toolCallId","toolName","args","intent"} and
// {"type":"tool_execution_end","toolCallId","toolName","result","isError"}.

const toolStart = (id, name, extra = {}) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args: { path: "login.py" }, intent: "Reading login.py", ...extra });
const toolEnd = (id, name, isError = false, extra = {}) => ({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text: "file body" }] }, isError, ...extra });
function toolStdout(events) {
  return line(SESSION_HEADER) + line({ type: "agent_start" }) + events.map(line).join("") + line({ type: "agent_end", messages: [assistant("All done.")] });
}
function progressCtx(overrides = {}) {
  const events = [];
  const made = baseCtx({ onEvent: async (event) => { events.push(event); }, ...overrides });
  return { ...made, events };
}
const started = (id, name) => ({ eventType: "tool_call", stream: "stdout", payload: { toolName: name, toolCallId: id, phase: "started" } });
const ended = (id, name, phase = "completed") => ({ eventType: "tool_result", stream: "stdout", payload: { toolName: name, toolCallId: id, phase } });

test("S2: real execute forwards OMP tool start/end through ctx.onEvent with allowlisted fields only", async () => {
  const stdout = toolStdout([toolStart("toolu_1", "read"), toolEnd("toolu_1", "read"), toolStart("toolu_2", "bash"), toolEnd("toolu_2", "bash", true)]);
  const runner = fakeRunner({ stdout });
  const { ctx, events } = progressCtx();
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(result.resultJson.runOutcome, "succeeded", result.errorMessage);
  assert.deepEqual(events, [started("toolu_1", "read"), ended("toolu_1", "read"), started("toolu_2", "bash"), ended("toolu_2", "bash", "failed")]);
  assert.ok(!allText(events).includes("login.py") && !allText(events).includes("file body"), "args, intent and results never leave");
  assert.deepEqual(result.resultJson.diagnostics.progressEvents, { delivered: 4, toolCalls: 2, deduplicated: 0, ignoredLines: 0, oversizedLines: 0, capExceeded: false, droppedEvents: 0, failure: null });
});

test("S2: any chunk split (incl. mid surrogate pair) and a final line without newline give the same events", async () => {
  const name = "读取🔧tool";
  const stdout = toolStdout([toolStart("toolu_u", name), toolEnd("toolu_u", name)]);
  const expected = [started("toolu_u", name), ended("toolu_u", name)];
  for (let cut = 1; cut < stdout.length; cut++) {
    const { ctx, events } = progressCtx();
    const result = await adapterWith(fakeRunner({ stdout, chunks: [stdout.slice(0, cut), stdout.slice(cut)] })).execute(ctx);
    assert.deepEqual(events, expected, `split at ${cut}`);
    assert.equal(result.resultJson.runOutcome, "succeeded", `split at ${cut}`);
  }
  const single = progressCtx();
  await adapterWith(fakeRunner({ stdout, chunks: [...stdout] })).execute(single.ctx);
  assert.deepEqual(single.events, expected, "one UTF-16 unit per chunk");

  // A complete tool line without trailing newline is forwarded on flush, while the
  // parser's verdict stays authoritative: the truncated stream is still a failure.
  const tail = line(SESSION_HEADER) + JSON.stringify(toolStart("toolu_t", "edit"));
  const t = progressCtx();
  const tr = await adapterWith(fakeRunner({ stdout: tail, chunks: [tail.slice(0, 40), tail.slice(40)] })).execute(t.ctx);
  assert.deepEqual(t.events, [started("toolu_t", "edit")]);
  assert.equal(tr.errorCode, "omp_output_damaged");
  assert.ok(tr.resultJson.diagnostics.damage.includes("truncated_tail"));
});

test("S2: bad JSON, unknown shapes, other key orders and thinking never produce progress; parser verdict kept", async () => {
  const thinking = { type: "message_update", message: assistant(""), assistantMessageEvent: { type: "thinking_delta", delta: `${JSON.stringify(toolStart("toolu_x", "bash"))} secret plan` } };
  const lines = [
    thinking,
    { type: "message_end", message: { ...assistant("hi"), content: [{ type: "thinking", thinking: line(toolStart("toolu_y", "bash")) }] } },
    { toolCallId: "toolu_k", toolName: "bash", type: "tool_execution_start" }, // other key order: never forged
    { type: "tool_execution_start", toolName: "bash" }, // no id
    { type: "tool_execution_start", toolCallId: "toolu_n", toolName: 7 },
    { type: "tool_execution_end", toolCallId: "toolu_e", toolName: "bash", isError: "yes" },
    { type: "tool_execution_start", toolCallId: "x".repeat(129), toolName: "bash" },
    { type: "tool_execution_start", toolCallId: "toolu_w", toolName: " \u0000\u0007 " }, // empty after normalization
    { type: "tool_execution_update", toolCallId: "toolu_z", toolName: "bash", partialResult: "out" },
  ];
  const { ctx, events } = progressCtx();
  const result = await adapterWith(fakeRunner({ stdout: toolStdout(lines) })).execute(ctx);
  assert.deepEqual(events, []);
  assert.equal(result.resultJson.runOutcome, "succeeded", result.errorMessage);
  assert.equal(result.resultJson.diagnostics.progressEvents.ignoredLines, 5);
  assert.equal(result.resultJson.diagnostics.progressEvents.delivered, 0);

  // Broken JSON behind a valid prefix: no event, and the run still fails on malformed_lines.
  const broken = line(SESSION_HEADER) + '{"type":"tool_execution_start","toolCallId":"toolu_b",\n' + line({ type: "agent_end", messages: [assistant("ok")] });
  const b = progressCtx();
  const br = await adapterWith(fakeRunner({ stdout: broken })).execute(b.ctx);
  assert.deepEqual(b.events, []);
  assert.equal(br.errorCode, "omp_output_damaged");
  assert.ok(br.resultJson.diagnostics.damage.includes("malformed_lines"));
  assert.equal(br.resultJson.diagnostics.progressEvents.ignoredLines, 1);
});

test("S2: secrets in tool names/ids are redacted (raw, \\u-escaped, short) before the display cut", async () => {
  const escapedName = `run ${[...AUTH_TOKEN].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}`;
  const stdout =
    line(SESSION_HEADER) +
    line(toolStart("toolu_a", `bash ${AUTH_TOKEN}`)) +
    `{"type":"tool_execution_start","toolCallId":"toolu_b","toolName":"${escapedName}"}\n` +
    line(toolStart(`id-${TOOLS_TOKEN}`, "read")) +
    line(toolStart("toolu_c", `${"x".repeat(75)}${AUTH_TOKEN}`)) +
    line(toolStart("toolu_d", "multi\nline\u0000tool")) +
    line({ type: "agent_end", messages: [assistant("done")] });
  for (const chunks of [[stdout], [...stdout]]) {
    const { ctx, events } = progressCtx();
    const result = await adapterWith(fakeRunner({ stdout, chunks })).execute(ctx);
    assert.equal(result.resultJson.runOutcome, "succeeded", result.errorMessage);
    assert.equal(events.length, 5);
    assertNoSecrets(events, "progress events");
    for (const e of events) {
      assert.deepEqual(Object.keys(e.payload).sort(), ["phase", "toolCallId", "toolName"]);
      assert.ok(e.payload.toolName.length <= 80 && e.payload.toolCallId.length <= 128);
    }
    assert.equal(
      events[3].payload.toolName,
      redactText(`${"x".repeat(75)}${AUTH_TOKEN}`, [AUTH_TOKEN]).slice(0, 80),
      "whole secret must be redacted before the toolName display cut",
    );
    const text = allText(events);
    assert.ok(!text.includes(AUTH_TOKEN.slice(0, 5)) && !text.includes(TOOLS_TOKEN.slice(0, 6)), "no secret prefix survives the cut");
    assert.equal(events[4].payload.toolName, "multi line tool");
  }

  const s = shortCtx({ onEvent: async (e) => s.events.push(e) });
  s.events = [];
  const shortOut = line(SESSION_HEADER) + line(toolStart(`c-${SHORT.auth}`, `t ${SHORT.pw} ${SHORT.quote} ${SHORT.model}`)) + line({ type: "agent_end", messages: [assistant("ok")] });
  const sr = await adapterWith(fakeRunner({ stdout: shortOut }), fakeDir).execute(s.ctx);
  assert.equal(s.events.length, 1, sr.errorMessage);
  assertNoShortTokens(s.events, "short-token progress");
});

test("S2: absent hook keeps the old result shape; invalid or throwing hook refuses before dispatch", async () => {
  for (const onEvent of [undefined, null]) {
    const runner = fakeRunner({ stdout: toolStdout([toolStart("toolu_1", "read")]) });
    const { ctx } = baseCtx({ onEvent });
    const result = await adapterWith(runner).execute(ctx);
    assert.equal(result.resultJson.runOutcome, "succeeded");
    assert.equal("progressEvents" in result.resultJson.diagnostics, false);
  }

  const runner = fakeRunner();
  const { ctx, logs } = baseCtx({ onEvent: { call() {} } });
  const result = await adapterWith(runner).execute(ctx);
  assert.equal(runner.calls.length, 0);
  assert.equal(logs.length, 0);
  assertBootstrapNotStarted(result, "omp_event_hook_invalid", "non-callable hook");

  let reads = 0;
  let causeReads = 0;
  const cause = new Proxy({}, { get() { causeReads++; return C_SYNTHETIC; } });
  const { ctx: gctx, scratchDir } = stagedSkillCtx({});
  Object.defineProperty(gctx, "onEvent", { get() { reads++; throw cause; } });
  const grunner = fakeRunner();
  const gr = await adapterWith(grunner, trustedBaseline).execute(gctx);
  assert.equal(reads, 1);
  assert.equal(causeReads, 0);
  assert.equal(grunner.calls.length, 0);
  assertBootstrapNotStarted(gr, "omp_preflight_failed", "throwing hook getter");
  assert.deepEqual(readdirSync(scratchDir), [], "staged skills cleaned");
  assert.ok(!allText(gr).includes(C_SYNTHETIC));
});

test("S2: a rejecting or throwing hook after dispatch is a typed failure, never bootstrap or success", async () => {
  const variants = {
    reject: async () => { throw new Error(`event store down ${AUTH_TOKEN} ${C_SYNTHETIC}`); },
    syncThrow: () => { throw new Error(`sync ${C_SYNTHETIC}`); },
  };
  for (const [label, impl] of Object.entries(variants)) {
    let calls = 0;
    let receiver;
    const runner = fakeRunner({ stdout: toolStdout([toolStart("toolu_1", "read"), toolEnd("toolu_1", "read"), toolStart("toolu_2", "bash")]) });
    const made = baseCtx();
    made.ctx.onEvent = function (e) { calls++; receiver = this; return impl(e); };
    const result = await adapterWith(runner).execute(made.ctx);
    assert.equal(runner.calls.length, 1, label);
    assert.equal(calls, 1, `${label}: forwarding stops after the first failure`);
    assert.equal(receiver, made.ctx, `${label}: hook called with this=ctx`);
    assert.equal(result.errorCode, "omp_progress_event_failed", label);
    assert.equal(result.resultJson.runOutcome, "failed", label);
    assert.equal(result.executionRecovery, undefined, `${label}: never bootstrap after dispatch`);
    assert.equal(result.resultJson.diagnostics.progressEvents.failure, "callback_failed", label);
    assert.ok(made.logs.length > 0, `${label}: run log still published`);
    assert.ok(!allText(result).includes(C_SYNTHETIC) && !allText(result).includes("event store down"), `${label}: cause withheld`);
    assertNoSecrets(result, label);
  }
});

test("S2: forwarder unit: sanitizer failure and byte chunks are contained; feed/flush never throw", async () => {
  const events = [];
  const bad = createProgressForwarder(async (e) => events.push(e), null, () => { throw new Error(C_SYNTHETIC); });
  await bad.feed(line(toolStart("toolu_1", "read")) + line(toolStart("toolu_2", "read")));
  await bad.flush();
  assert.deepEqual(events, []);
  assert.equal(bad.summary().failure, "sanitizer_failed");

  const bytes = Buffer.from(line(toolStart("toolu_u", "写入")) + JSON.stringify(toolEnd("toolu_u", "写入")), "utf8");
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = [];
    const fwd = createProgressForwarder(async (e) => got.push(e), null, (s) => s);
    await fwd.feed(bytes.subarray(0, cut));
    await fwd.feed(bytes.subarray(cut));
    await fwd.flush();
    assert.deepEqual(got, [started("toolu_u", "写入"), ended("toolu_u", "写入")], `byte split at ${cut}`);
  }
});

test("S2: caps and dedupe: bounded tool ids, oversized lines and duplicates never fail silently", async () => {
  // Duplicate start/end of one call are delivered once each; anything after the end is dropped.
  const dup = toolStdout([toolStart("toolu_1", "read"), toolStart("toolu_1", "read"), toolEnd("toolu_1", "read"), toolEnd("toolu_1", "read"), toolStart("toolu_1", "read")]);
  const d = progressCtx();
  const dr = await adapterWith(fakeRunner({ stdout: dup })).execute(d.ctx);
  assert.deepEqual(d.events, [started("toolu_1", "read"), ended("toolu_1", "read")]);
  assert.equal(dr.resultJson.diagnostics.progressEvents.deduplicated, 3);

  // More distinct calls than the cap: forwarding stops at the cap and says so.
  const many = [];
  for (let i = 0; i <= 1024; i++) many.push(toolStart(`toolu_${i}`, "read"), toolEnd(`toolu_${i}`, "read"));
  const m = progressCtx();
  const mr = await adapterWith(fakeRunner({ stdout: toolStdout(many) })).execute(m.ctx);
  assert.equal(m.events.length, 2048);
  assert.deepEqual(mr.resultJson.diagnostics.progressEvents, { delivered: 2048, toolCalls: 1024, deduplicated: 0, ignoredLines: 0, oversizedLines: 0, capExceeded: true, droppedEvents: 2, failure: null });
  assert.equal(mr.resultJson.runOutcome, "succeeded", "display cap is a diagnostic, not a run failure");

  // A tool line above the line cap is never buffered past the cap or parsed; the parser
  // independently fails the run on oversized_lines.
  const huge = toolStdout([toolStart("toolu_h", "write", { args: { content: "y".repeat(1024 * 1024) } }), toolStart("toolu_ok", "read")]);
  const h = progressCtx();
  const hr = await adapterWith(fakeRunner({ stdout: huge, chunks: [huge.slice(0, 500_000), huge.slice(500_000)] })).execute(h.ctx);
  assert.deepEqual(h.events, [started("toolu_ok", "read")]);
  assert.equal(hr.resultJson.diagnostics.progressEvents.oversizedLines, 1);
  assert.equal(hr.errorCode, "omp_output_damaged");
  assert.ok(hr.resultJson.diagnostics.damage.includes("oversized_lines"));

  // Same guard with an injected small cap on the forwarder itself.
  const got = [];
  const small = createProgressForwarder(async (e) => got.push(e), null, (s) => s, { maxLineBytes: 100, maxToolCalls: 1 });
  await small.feed(line(toolStart("toolu_big", "read")) + '{"type":"tool_execution_end","toolCallId":"a","toolName":"r"}\n' + '{"type":"tool_execution_end","toolCallId":"b","toolName":"r"}\n');
  await small.flush();
  assert.deepEqual(got, [ended("a", "r")]);
  assert.deepEqual(small.summary(), { delivered: 1, toolCalls: 1, deduplicated: 0, ignoredLines: 0, oversizedLines: 1, capExceeded: true, droppedEvents: 1, failure: null });
});
