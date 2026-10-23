# omp-local-adapter

Portable rich `omp_local` adapter, not `omp_native_json_local`. The native Paperclip runner owns main execution and cancellation. No extra supervisor, global Map patch, checkpoint or PID-based recovery was added.

## Installation authority

Install as `repo/omp-local-adapter`, beside the parent's `repo/scripts/config.mjs` and `repo/config.schema.json`. The shared loader must consume the existing schema fields `omp.command` and `host.paperclipServerRoot`. The parent must supply its loader's `ajv` dependency. Set `PAPERCLIP_INTEGRATION_CONFIG` in the administrator-controlled server startup environment. This is not a task-level setting.

- `omp.command`: absolute non-NUL executable path.
- `host.paperclipServerRoot`: actual **server package directory**, containing `package.json` and `dist/`, not its containing checkout. It must identify the same installation that loads this adapter. Do not point to another same-version server.
- Parent example/loader/schema copies are in `tests/fixtures/shared/`. They contain synthetic data only. `tests/host-installation.test.mjs` assembles a complete repo-shaped fixture without any author's checkout.

Package `main`/`exports` select `entry.mjs`. It reads shared config once, binds the host SDK with top-level await, then exposes the host-compatible **no-argument** `createServerAdapter()`. Later env changes, task context and supplied factory arguments cannot replace the command or runner. `index.mjs` is a core injection/testing seam, not the installation entry. An isolated npm package lacking the parent shared-loader layout intentionally cannot activate.

### Host SDK singleton binding

`host-binding.mjs` pins server and SDK to `2026.1005.0` and resolves `@paperclipai/adapter-utils/server-utils` **from the canonical host `dist/adapters/utils.js` importer** using a bounded, credential-free Node subprocess running the real ESM `import.meta.resolve` with its parent parameter. It does not use CJS `require.resolve`. The resolver does not import/start a server or OMP.

The binding verifies canonical file URLs, the unbundled host heartbeat → adapters index → utils import chain, required SDK exports, and **actual identity of the host utils `runningProcesses` and SDK map**. It injects that SDK's exact runner into the existing core factory. A same-version/hash candidate-local SDK is deliberately insufficient. The SDK dependency retained in this package supplies stateless helpers and offline tests; it does not own installation-entry dispatch.

Missing/invalid shared configuration or command raises fixed `installation_config_invalid`. Missing/incompatible host, unresolved SDK, unsupported runtime or map-identity mismatch raises fixed `installation_host_binding_invalid`; there is **no local-SDK fallback**.

Supported deployment is ordinary unbundled Node ESM. Rejects `NODE_OPTIONS`, loader/preload/custom-condition flags, `--preserve-symlinks` and `--preserve-symlinks-main`, noncanonical URLs, changed consumer layouts and map mismatch. Do not bundle/transpile the host or adapter, import with cache-busting URLs, dynamically install module hooks, mutate loaded exports, or change resolution after binding. Programmatic hook installation or maliciously modified trusted host code is not a security sandbox this adapter can police. A deployment using such mechanisms is unsupported and must not be activated; the parent must confirm a clean Node bootstrap and actual host-root identity. Cold binding imports the host utils module and its logger (not the server/registry/DB); on a normal host it is already loaded. Host-tier tests use `NODE_ENV=production` to avoid a pretty-logger worker.

No deployed installation or host node_modules was changed. Host package metadata and required source modules were read; real configuration, registration JSON, .env, credentials and provider logs were not read. No symlink was added.

## Verification tiers and dependency closure

Node >=24.11.0; local acceptance used macOS arm64 / Node v26.10.0. See the exact published commit's CI for Linux coverage; Windows is not certified. From the complete repository root:

```sh
npm ci
npm run test:omp-local
node omp-local-adapter/scripts/check.mjs
# Optional explicit real-host tier; this root is supplied by the operator:
npm run test:omp-local -- --host /absolute/path/to/node_modules/@paperclipai/server
```

The repository root lockfile and npm workspace are the normal installation path. An isolated test-only copy outside that workspace can still use this component's lockfile and `node scripts/test.mjs`; installation activation still requires the documented parent shared-loader layout. The default tier uses pinned adapter-utils and ajv, with **no installed-server dependency**. Synthetic host fixtures use local dependencies under `.evidence/tmp`. Per-file isolated workers load a process tripwire; no non-Node OS child is allowed. HOME/temp/run scratch are private, inherited provider/credential environment is removed, and test membership is checked against the explicit manifest.

Explicit host tier additionally requires the selected **installed server 2026.1005.0 dependency closure**, including its adapter-utils, shared, pino/pino-http and logger transitive imports. It does not fetch/install or modify that host. A missing closure is failure, not skip or fallback.

All prior **230 tests and their assertions are retained**. The current default tier has **239** tests; the explicit real-host tier has **3**. Only the old host installation fixture setup now constructs a synthetic host. Added coverage includes invalid host activation, real import-vs-require export selection, map mismatch, unsupported runtime and split-registry process behavior. Local development logs/manifests and repair receipts are deliberately not distributed; committed tests are the reproduction entrypoints.

### What the process proof establishes

1. Behavior RED: the real candidate SDK dispatch creates an owned short-lived Node child, publishes PID metadata, but is invisible to the actual host SDK map. The assertion requiring visibility fails; owned-handle cleanup still runs.
2. Negative control repeats that split intentionally, asserting invisibility and cleanup.
3. Bound runner is strictly identical to the host SDK runner/map; its owned Node child is visible through the host map, signalled through the host's native `signalRunningProcess`, exits with SIGTERM (not timeout), and both maps are clear.
4. Actual repo-shaped **entry → no-argument factory → core execute → host SDK** dispatch registers only the host map. This test translates OMP argv to a bounded synthetic Node program at `child_process.spawn`, below the real runner; it does not replace the registry or runner. The host-map stop gate terminates that exact child and maps clear.

This proves the native registry eligibility/stop primitive in an isolated process using the real installed host modules. It is **not a live heartbeat cancellation API/DB integration test**, real OMP execution, timeout-escalation validation, provider work or deployment acceptance. No server, model or API was started. Only exact owned handles/records are signalled, with cleanup in finally and a bounded self-exit fallback.

## Preserved execution contract

- Local execution only; issue identity, cwd and exact run scratch must validate. Scratch binding is not an OS sandbox.
- `-p --mode json --no-session --cwd ... --max-time timeoutSec`; prompt on stdin. Native hard backstop remains timeout plus grace; native owner handles signals/cleanup.
- Existing approvals, model/thinking selection and matching, skill baseline/staging/pins/cleanup, parser integrity, streaming redaction, metadata/progress failure mapping and usage accounting are unchanged.
- Task `command`, `ompCommand`, `prefixArgs` remain unsupported. Discovery/baseline/main execution use the installation command.
- Deadline classifications remain unchanged. No checkpoint/reserve-budget feature was added.

Before real activation, parent must independently review these frozen bytes, validate its clean unbundled bootstrap/root and shared configuration, supply OMP/credentials/context, register `omp_local`, and verify native live cancellation. If this second bounded repair is still rejected, escalate the remaining architectural decision; do not start an unbounded repair loop.
