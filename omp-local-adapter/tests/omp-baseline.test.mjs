// FROZEN RED tests for P0-C-BASE (contract P0-C-BASE-v1; option B = ask OMP itself).
// All tests are prefixed "baseline:"; zero real spawn (runCommand is always an injected fake).
//   node --test --test-name-pattern='^baseline:' omp-baseline.test.mjs
//
// ---------------------------------------------------------------- interface contract
// omp-baseline.mjs MUST export:
//
//   readOmpSkillBaseline({ command, cwd, env, runCommand, timeoutMs, maxStdoutBytes })
//       -> Promise<{ trusted: true, config: { skills: { customDirectories: string[] } } } | null>
//     command        : OMP executable (non-empty string). Missing / non-string -> null, runCommand NOT called.
//     cwd, env       : the SAME cwd/env as this OMP run; passed to runCommand as-is (same references,
//                      no HOME fabrication, no mutation).
//     runCommand     : (cmd, args, { cwd, env, timeoutMs, maxStdoutBytes })
//                        -> Promise<{ exitCode, stdout, timedOut, overflow }>
//                      called exactly once with cmd === command and
//                      args === ["config", "get", "skills.customDirectories", "--json"].
//     timeoutMs      : default DEFAULT_BASELINE_TIMEOUT_MS when omitted.
//     maxStdoutBytes : default DEFAULT_BASELINE_MAX_STDOUT_BYTES when omitted.
//
//   DEFAULT_BASELINE_TIMEOUT_MS       : finite number, 0 < n <= 30000
//   DEFAULT_BASELINE_MAX_STDOUT_BYTES : finite number, 0 < n <= 65536
//
// OMP 18.10.0 stdout shape: {"key":"skills.customDirectories","value":[...],"type":"array",...}
// Projection: ONLY skills.customDirectories is returned; no other OMP config field, no stderr.
// Fail closed: any uncertainty -> null (-> existing omp_skills_baseline_untrusted). Never "[] on failure".
// The adapter MUST NOT read OMP config files directly; it only invokes the OMP CLI.

import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("../omp-baseline.mjs");

const ARGS = ["config", "get", "skills.customDirectories", "--json"];

function ompJson(value, extra = {}) {
  return (
    JSON.stringify({
      key: "skills.customDirectories",
      value,
      type: "array",
      source: "project",
      path: "/secret/project/.omp/config.yml",
      ...extra,
    }) + "\n"
  );
}

function fakeRunner(result) {
  const calls = [];
  const runCommand = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return typeof result === "function" ? result() : result;
  };
  return { runCommand, calls };
}

const ok = (stdout) => ({ exitCode: 0, stdout, timedOut: false, overflow: false, stderr: "warn: noise" });

async function read(result, overrides = {}) {
  const { readOmpSkillBaseline } = await load();
  const { runCommand, calls } = fakeRunner(result);
  const out = await readOmpSkillBaseline({
    command: "omp",
    cwd: "/work/run-cwd",
    env: { PATH: "/usr/bin", OMP_X: "1" },
    runCommand,
    ...overrides,
  });
  return { out, calls };
}

// ---------------------------------------------------------------- 1. invocation
test("baseline: invokes runCommand once with exact args, command, cwd/env passthrough", async () => {
  const { readOmpSkillBaseline } = await load();
  const { runCommand, calls } = fakeRunner(ok(ompJson(["/a"])));
  const env = { PATH: "/usr/bin", PAPERCLIP_RUN_ID: "r1" }; // deliberately no HOME
  const envSnapshot = structuredClone(env);
  await readOmpSkillBaseline({
    command: "/opt/bin/omp",
    cwd: "/work/run-cwd",
    env,
    runCommand,
    timeoutMs: 1234,
    maxStdoutBytes: 4096,
  });
  assert.equal(calls.length, 1);
  const [{ cmd, args, opts }] = calls;
  assert.equal(cmd, "/opt/bin/omp");
  assert.deepEqual(args, ARGS);
  assert.equal(opts.cwd, "/work/run-cwd");
  assert.equal(opts.env, env, "env must be the same object (no copy, no HOME fabrication)");
  assert.deepEqual(env, envSnapshot, "env must not be mutated");
  assert.equal(Object.hasOwn(opts.env, "HOME"), false);
  assert.equal(opts.timeoutMs, 1234);
  assert.equal(opts.maxStdoutBytes, 4096);
});

// ---------------------------------------------------------------- 2/3. trusted projection
test("baseline: value [/a,/b] -> trusted projection with only skills.customDirectories", async () => {
  const { out } = await read(ok(ompJson(["/a", "/b"])));
  assert.deepEqual(out, { trusted: true, config: { skills: { customDirectories: ["/a", "/b"] } } });
  assert.deepEqual(Object.keys(out), ["trusted", "config"]);
  assert.deepEqual(Object.keys(out.config), ["skills"]);
  assert.deepEqual(Object.keys(out.config.skills), ["customDirectories"]);
  assert.equal(Object.hasOwn(out, "stderr"), false);
});

test("baseline: value [] -> trusted with empty customDirectories", async () => {
  const { out } = await read(ok(ompJson([])));
  assert.deepEqual(out, { trusted: true, config: { skills: { customDirectories: [] } } });
});

// ---------------------------------------------------------------- 4. fail closed -> null
const NULL_CASES = [
  ["exitCode 1", { ...ok(ompJson(["/a"])), exitCode: 1 }],
  ["exitCode null (signal)", { ...ok(ompJson(["/a"])), exitCode: null }],
  ["timedOut", { ...ok(ompJson(["/a"])), timedOut: true }],
  ["overflow", { ...ok(ompJson(["/a"])), overflow: true }],
  ["stdout not JSON", ok("not json\n")],
  ["stdout empty", ok("")],
  ["stdout JSON null", ok("null\n")],
  ["stdout JSON array", ok('["/a"]\n')],
  ["key mismatch", ok(ompJson(["/a"], { key: "skills" }))],
  ["key missing", ok(JSON.stringify({ value: ["/a"], type: "array" }))],
  ["type string", ok(ompJson(["/a"], { type: "string" }))],
  ["type missing", ok(JSON.stringify({ key: "skills.customDirectories", value: ["/a"] }))],
  ["value not array", ok(ompJson("/a"))],
  ["value missing", ok(JSON.stringify({ key: "skills.customDirectories", type: "array" }))],
  ["element number", ok(ompJson(["/a", 1]))],
  ["element null", ok(ompJson([null]))],
  ["element object", ok(ompJson(["/a", {}]))],
  ["element empty string", ok(ompJson(["/a", ""]))],
];

for (const [name, result] of NULL_CASES) {
  test(`baseline: null when ${name}`, async () => {
    const { out, calls } = await read(result);
    assert.equal(calls.length, 1);
    assert.equal(out, null);
  });
}

test("baseline: null when runCommand rejects", async () => {
  const { out } = await read(() => Promise.reject(new Error("spawn ENOENT")));
  assert.equal(out, null);
});

test("baseline: null when runCommand throws synchronously", async () => {
  const { readOmpSkillBaseline } = await load();
  const out = await readOmpSkillBaseline({
    command: "omp",
    cwd: "/w",
    env: {},
    runCommand: () => {
      throw new Error("boom");
    },
  });
  assert.equal(out, null);
});

for (const [name, command] of [
  ["command missing", undefined],
  ["command number", 42],
  ["command array", ["omp"]],
  ["command empty string", ""],
]) {
  test(`baseline: null when ${name} (runCommand not called)`, async () => {
    const { out, calls } = await read(ok(ompJson(["/a"])), { command });
    assert.equal(out, null);
    assert.equal(calls.length, 0);
  });
}

// ---------------------------------------------------------------- 5. bounded defaults
test("baseline: exported default timeout/stdout limits are finite and bounded", async () => {
  const mod = await load();
  const t = mod.DEFAULT_BASELINE_TIMEOUT_MS;
  const b = mod.DEFAULT_BASELINE_MAX_STDOUT_BYTES;
  assert.equal(typeof t, "number");
  assert.equal(typeof b, "number");
  assert.ok(Number.isFinite(t) && t > 0 && t <= 30000, `timeout ${t}`);
  assert.ok(Number.isFinite(b) && b > 0 && b <= 65536, `maxStdoutBytes ${b}`);
});

test("baseline: omitted timeoutMs/maxStdoutBytes pass exported defaults to runCommand", async () => {
  const mod = await load();
  const { calls } = await read(ok(ompJson(["/a"])));
  assert.equal(calls[0].opts.timeoutMs, mod.DEFAULT_BASELINE_TIMEOUT_MS);
  assert.equal(calls[0].opts.maxStdoutBytes, mod.DEFAULT_BASELINE_MAX_STDOUT_BYTES);
});
