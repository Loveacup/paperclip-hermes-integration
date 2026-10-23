# Configuration, deployment, and checks

**English** | [简体中文](DEPLOYMENT.zh-CN.md)

[Project home](../README.md) · [AI configuration](AI_SETUP.md) · [Deployment](DEPLOYMENT.md) · [Compatibility and rollback](COMPATIBILITY.md)

Run the following commands from the repository root. Deployment requires separate explicit authorization;
complete the README's offline Quick Start first.

## One editable configuration entry point

```sh
cp integration.example.json integration.local.json
# Edit integration.local.json; do not add secret values
npm run config:check -- integration.local.json
```

`config.schema.json` strictly rejects unknown fields. All relative paths resolve against the
**directory containing the JSON file**; keep configuration at the repository root or use absolute paths.
Do not split the repository during installation: the Python plugin and adapter reference the shared
root validator. `node` must be on the gateway's and service's PATH.

| Configuration | What to change |
|---|---|
| `companyId` / `ceoAgentId` | Real UUIDs of the target organization and CEO; the examples are synthetic |
| `apiUrl` / `authEnv` | API base URL; credential **environment variable name**, not its value |
| `bridge.statePath` | Persistent state outside the source directory; never share writes with an old deployment |
| `bridge.hermesAdapterRoot` | The validated Hermes adapter package directory; version 2026.1005.0 is pinned and required |
| `bridge.serviceLabel` | macOS launchd label, read only by health |
| `plugin.ownerHome` | Hermes profile home owning the plugin configuration; must equal the plugin's manager.home_path |
| `plugin.routingHome` | Home storing exact gateway_routing; read only this metadata and do not guess the profile DB |
| `plugin.cursorDir` | Persistent cursor directory; binding digests distinguish DM/group/sender, and `/new` in conversation/topic mode does not replay history |
| `plugin.binding` | Complete binding verified in the target environment: profile, platform, chat/user/thread, session_key/session_id |
| `plugin.instructionsPath` | CEO work-constraint document; may point to your deployment's own file |
| `plugin.readCommand` | Read-only command argv template; `{repo}` and `{config}` are expanded and shell-quoted automatically |
| `plugin.enabled` | Set to true only after confirming the target, authorization, and new-baseline policy |
| `omp.command` | **Installation-level** absolute OMP path; task config.command/prefixArgs are not accepted |
| `host.hermesSource` | Explicit Hermes source root for optional host contract tests |
| `host.paperclipServerRoot` | Actual server package directory (package.json plus dist); optional server tests and required rich `omp_local` installation binding, not a default offline-test dependency |

Hermes configuration stores only a `config_path` pointer; its owner scope is unaffected by the current
session's ambient profile. The JSON is a trusted deployer-controlled file, not editable by task content.
Reload the plugin after changes; a detected configuration change during operation stops polling.
The OMP command is fixed when the factory is created; changes require reloading the adapter/service.
Model precedence is task `config.model` > agent default model > OMP default model. Output always requires
the actual provider/model. A mismatch with a full `provider/model` request fails; short model aliases
only report the actual resolved value, without claiming strict matching.

## Deployment (manual confirmation required; not executed by default)

1. Stop the old bridge and old target plugin writers; retain backups of their state. Do not deploy two
   bridges to the same organization in parallel or change cursorDir to bypass an existing target lock.
   A new path establishes a new baseline; historical events are not replayed.
2. Edit the local JSON. Confirm ordinary groups use `mode=conversation`, a negative chat ID, an explicit
   sender, and an empty thread. `session` mode also requires explicit acceptance of non-atomic binding
   risk. Never remove the group sender to turn injection into a broadcast.
3. Validate and generate a script for review:

   ```sh
   npm run setup -- integration.local.json             # Preview only
   npm run setup -- integration.local.json --apply     # Only write .local/deploy.sh
   # Review before execution: creates a plugin symlink and uses official config set / plugins enable
   sh .local/deploy.sh
   ```

   The script refuses to overwrite an existing plugin destination. It does not start a gateway,
   bridge, model, or scheduler. After setting `plugin.enabled=true`, restart the selected messaging
   gateway using your existing service-management method. **Do not load it in a Hermes CLI session
   for injection purposes.** The plugin directory is a symlink that preserves shared-file relationships
   within this repository.
4. Pass `PAPERCLIP_INTEGRATION_CONFIG=/absolute/path/integration.local.json` to the **Paperclip server's
   installation environment**. As an instance admin, install `$PWD/omp-adapter` from a local path in
   Paperclip's adapters management interface. For 2026.1005.0, the management API is
   `POST /api/adapters/install` with body
   `{"packageName":"/absolute/path/to/repository/omp-adapter","isLocalPath":true}`. Authenticate with an instance
   administrator identity; **do not use the bridge's CEO credentials as a substitute for administrator
   credentials**. Cloud-hosted instances may prohibit this operation. This project does not call this
   API automatically. Select `omp_native_json_local` for workers and set cwd, optional model, and permission.

   For the rich implementation, use local path `$PWD/omp-local-adapter` in that same administrator
   interface/API and select `omp_local` instead. Its `host.paperclipServerRoot` must identify this
   exact server package, not an outer checkout or another same-version installation. It binds the
   actual host runner/registry at loading and refuses missing/incompatible hosts; use an ordinary
   unbundled Node ESM bootstrap without loader/preload/custom-condition/symlink-preserving overrides.
   Keep the whole repository layout. Use its supported cwd/model/thinking/approvalMode fields rather
   than assuming the thin adapter's permission contract. Do not silently replace existing workers.
   See [rich adapter boundaries](../omp-local-adapter/README.md) and the [rebuild runbook](REBUILD.md).
5. Configure the CEO's native Hermes adapter with a promptTemplate containing `{{wakeReason}}`, while
   preserving existing management constraints. The default template in the verified version discards
   wakeReason, which causes the bridge to block delivery. The bridge checks both new-session and
   resumed-session paths.
6. Supply credentials through your controlled service environment (see `authEnv` for the variable name),
   never through JSON, argv, the repository, or prompts. Confirm they belong to the CEO of the same company
   and provide the API permissions needed for existing operations. `--check` does not verify remote identity:

   ```sh
   node event-bridge/bridge.mjs --config "$PWD/integration.local.json" --check
   # The next two commands perform real authenticated GETs; --once does not write state, POST, or start WebSocket
   node event-bridge/bridge.mjs --config "$PWD/integration.local.json" --once
   node event-bridge/bridge.mjs --config "$PWD/integration.local.json" --read issue RESOURCE_UUID
   # Read types also include run / comments; /agents/me and resource companyId are checked first
   ```

   `--read` responses may contain task titles/comment bodies; use only in authorized sessions and do not
   commit the responses. The old deployment's `--env-file` is no longer supported; secrets are read only
   from the environment variable referenced by configuration.
7. Configure your existing service manager with the complete service argv from the generated script,
   or start manually in the foreground:

   ```sh
   # STATE_PATH must equal the resolved bridge.statePath; create its parent directory first
   python3 -B event-bridge/service_exec.py --state "$STATE_PATH" \
     --config "$PWD/integration.local.json" -- "$(command -v node)" \
     "$PWD/event-bridge/bridge.mjs" --config "$PWD/integration.local.json" --run
   ```

   `service_exec` sanitizes the environment, retaining only the one credential named by `authEnv` in
   addition to its allowed environment; the configuration path is passed through argv. It adds no
   supervisor. A kernel owner lock prevents multiple writers to the same state, and a live PID lease
   is not evicted automatically. The first `--run` only establishes a baseline; subsequent state changes
   trigger heartbeats. `uncertain` deliveries are never retried automatically.

### Changing targets and ownership of existing state

Bridge state stores an `identity` tuple: normalized `apiBase`, `companyId`, and `ceoAgentId`.
API normalization is shared with requests: normalize the URL (host casing, default ports, and path dot
segments), remove trailing slashes and an optional final `/api`, then append `/api`, preserving the
deployment path prefix. Equivalent API spellings do not change identity.
`--run`, `--once`, `--status`, and `--check` all check state ownership first. An identity mismatch returns
`state_identity_mismatch`; legacy state without identity returns `state_identity_missing`. Neither case
accesses the network, modifies, clears, or replays that state. A new baseline is allowed only when the
state file genuinely does not exist; a corrupt file or dangling symlink does not count as nonexistent.

Before changing API/company/CEO, stop the old owner and retain the old state (including pending, tracked,
inflight, and uncertain) and its configuration backup. Then obtain operator confirmation to select a
**new, nonexistent** `bridge.statePath`. Old state is only for reviewing the original target: do not
manually change its identity, copy its queues to a new target, or delete state to bypass uncertain deliveries.
Legacy state without identity is not automatically assigned one either: manually verify the old target
and pending deliveries, retain the original, and explicitly choose a new baseline. Restarting with the
same identity continues existing state. Legacy state with a bound identity but no revisions retains the
existing semantics of upgrading on real changes.

## Checks and boundaries

```sh
# Local read-only health for macOS launchd; reads the exact group cursor, not a legacy DM cursor
python3 -B event-bridge/health.py --config "$PWD/integration.local.json"
# Explicit opt-in; missing or incompatible hosts fail rather than silently skip
npm run test:host -- integration.local.json
npm run test:server -- integration.local.json
npm run test:installed-omp -- integration.local.json
```

`test:host` checks injector/FIFO contracts in the installed source without starting a real gateway;
`test:server` checks internal server loader/enrichment behavior and fake subprocesses;
`test:installed-omp` **actually starts OMP**, but loads only a synthetic offline provider in an isolated
HOME and does not call a real model. OMP must be able to resolve that test extension's dependencies.
The default tests include none of these three probe categories.

See [Compatibility and rollback](COMPATIBILITY.md) and [Sources and licenses](../THIRD_PARTY_NOTICES.md).
A ready health result, API accepted, and CEO terminal state are not evidence of model consumption or user receipt.
