# AI configuration guide

**English** | [简体中文](AI_SETUP.zh-CN.md)

[Project home](../README.md) · [AI configuration](AI_SETUP.md) · [Deployment](DEPLOYMENT.md) · [Compatibility and rollback](COMPATIBILITY.md)

For AI assistants preparing configuration, changing deployment targets, or diagnosing failures for an operator.
**Offline preparation → validation → explicitly authorized activation** are separate phases.
If the user only asks for help configuring the integration, stop after offline preparation and validation;
passing tests is not authorization to go live.

## 1. Establish facts and authorization scope

**Inputs**: absolute repository path, user objective, and the target installation scope you may inspect.

**Actions**:

1. Read `README.md`, `docs/DEPLOYMENT.md`, `docs/COMPATIBILITY.md`, `config.schema.json`,
   `integration.example.json`, and `package.json`. The schema is authoritative for field types and
   requirements; actual scripts/implementations are authoritative for commands. Do not invent
   `--help`, installation arguments, or configuration fields.
2. Read `scripts/config.mjs`, `scripts/setup.mjs`, `event-bridge/prompt-contract.mjs`,
   and the components you intend to change. Preserve the three-component structure rather than
   replacing the existing design with a generic deployment framework.
3. Perform read-only checks of `node --version`, `npm --version`, `python3 --version`, target package
   manifests, the existence of explicit paths, and ownership/conflicts of current plugins/services.
   **Do not traverse unauthorized host paths.** This project does not require reading complete user
   configurations, `.env`, authentication files, database contents, logs, or chat history.
4. Use the network only for public dependencies/official documentation. During preparation, do not call
   real business APIs, run agents, start the bridge, or send messages. If a host command might have side
   effects, inspect source/manifests instead; do not start a runtime under the guise of probing it.

**Completion criteria**: list actual versions, directories permitted for reads/writes, existing writers,
missing dependencies, and the current phase. Mark unclear ownership, permissions, or service scope as
“unknown” and ask first; do not automatically stop an existing deployment.

## 2. Derive the field inventory from the schema, then collect sources

**Inputs**: the schema's `required/properties`, synthetic examples, and user-confirmed installation targets.

**Actions**: produce one row for **every actual configuration leaf field**:
`Field | Schema type/constraints | Required/optional | Synthetic example | Actual source | Verified/pending confirmation`.
Read the schema recursively, including `$ref`; this guide is not a second field definition.
Take examples from `integration.example.json`, label them synthetic, and never present them as the user's real identity.

Collect values by source, not by guessing:

| Field family | Acceptable actual sources and stop conditions |
|---|---|
| `version` | The schema's const; do not independently upgrade the protocol |
| `companyId` / `ceoAgentId` | A user-authorized target console/export or read-only API; verify the CEO belongs to the same company. Stop real configuration if either is missing |
| `apiUrl` / `authEnv` | The operator-confirmed API base URL and credential variable **name**; only confirm whether the service manager supplies the variable, without requesting, reading, or printing its value |
| `bridge.*` | The operator-selected private state location, exact adapter package manifest, and existing service label; the state path must not conflict with an old owner that has not stopped |
| `plugin.ownerHome` / `routingHome` | Verify configuration ownership and the actual routing-metadata location through the target profile/host interface; they may differ and must not be inferred from a username |
| `plugin.binding.*` | Read exact host routing metadata only with explicit authorization; see the routing branch below and stop on any inconsistency |
| `plugin.cursorDir` | An operator-confirmed private persistent path; a new directory means a new baseline and must not bypass an existing writer |
| `plugin.instructionsPath` / `readCommand` | Reviewed CEO constraints and the repository's read-only entry point; preserve `{repo}`/`{config}` expansion and keep credentials out of command argv |
| `plugin.enabled` / `accept_nonatomic_risk` / `interval` | Explicit operator choices; enabled=false during preparation. The user must accept session-mode risk; do not set it to true merely to pass validation |
| `omp.command` | The absolute path to the installed OMP executable; this is an installation-level authority, not a value derived from task text |
| `host.*` | Exact installation directories used only for explicit host contract checks; leave unconfigured if not provided and do not claim host checks passed |

**Routing branch**: only `session_key/session_id/platform/transport_profile/origin` metadata is needed;
do not read session bodies, titles, or credentials. The read-only SQL and scope rules in `read_route`
are the implementation authority. Verify consistency among session_key, profile, chat_type, chat_id,
user_id, and thread_id. A group must be an ordinary conversation with an explicit sender and an empty
thread. `/new` may update session_id while preserving the same conversation identity.
**Verify session_key against the host; never construct one from its string format and call it real.**
If that route cannot be obtained, ask the user for metadata without bodies/secrets, or stop at a synthetic preview.

**Path branch**: relative configuration paths resolve against the JSON file's directory, not the shell cwd;
`~` is not expanded. `{repo}` and `{config}` apply only to the readCommand template and are shell-quoted
at runtime. Reconfirm all relative paths when moving the JSON file. Preserve the plugin's dependencies
on the whole repository: deployment uses a symlink, not a standalone copy of a `.py` file.

**Completion criteria**: every field to be activated has a verified source; no synthetic value is treated
as real, and every missing item has been listed separately and raised with the user. Offline example
exercises may continue while items remain unresolved, but the result must not be declared ready to go live.

## 3. Prepare and validate only within the repository

**Inputs**: a repository authorized for writes, locked dependencies, and a configuration draft (or only a synthetic example).

**Actions**: preserve existing local configuration without overwriting it; keep injection disabled when
creating `integration.local.json` from the example. Credentials stay in the operator's existing secure
environment. Do not create `.env` or put secrets in JSON, shell argv, or prompts. Run:

```sh
npm ci
npm test
npm run config:check -- integration.example.json
# Only after a local draft has been created:
npm run config:check -- integration.local.json
npm run setup -- integration.local.json
```

The last command is a preview. `npm run setup -- integration.local.json --apply` only generates
`.local/deploy.sh`; it still performs no host operations. Obtain separate user permission before generating
it. Do not describe this apply operation as going live. Do not use `--once`/`--read` for “offline validation”:
they access the real API; `--run` delivers heartbeats. Although `--check` does not access the network,
it checks credential presence and the installed prompt contract; it is not required for a credential-free quick start.

**Completion criteria**: record each command's actual exit code, test pass/fail/skip counts, and configuration
validation output; the preview must leave the host unchanged. If identity/routing is still missing, label
the result “synthetic example passed; real configuration incomplete,” not “configuration complete.”

## 4. Authorize host checks and activation separately

**Inputs**: explicit user permission for specific targets and changes, stopping the old owner, and the new-baseline policy.

**Actions**:

- When host checks are needed, follow the README's `test:host`, `test:server`, and `test:installed-omp`
  commands with the configuration path as an argument. Host checks are not activation; the last command
  actually starts OMP, which must be disclosed in advance.
- Follow the manual deployment procedure in `DEPLOYMENT.md`. Review the generated script first, then
  confirm the symlink destination is unoccupied. Let the user decide how to handle an existing plugin;
  never force an overwrite. The official `hermes config set` only sets config_path for the selected owner;
  `hermes plugins enable` only enables the target plugin. Do not change global plugin isolation, other
  profiles, or other services.
- Installing an external Paperclip adapter requires instance-admin privileges; the bridge's CEO identity
  is not a substitute. Pass the configuration path to Paperclip's installation environment; tasks must not
  override the execution command. The bridge receives configuration through argv; the exec gate retains
  only the credential variable referenced by that configuration.
- Confirm state ownership before changing `apiUrl` / `companyId` / `ceoAgentId`. The bridge binds state to
  a tuple of normalized API base URL, company, and CEO. Stop on an identity mismatch or legacy state
  without identity; do not automatically modify, clear, add identity to, or replay it. After stopping the
  old owner and retaining its configuration and complete state, obtain operator approval for a new,
  genuinely nonexistent statePath to establish a baseline. Never transfer old pending/tracked/inflight
  entries to the new target; uncertain deliveries still require manual review. Keep statePath when
  restarting with the same identity. Normalization matches requests (URL normalization, trailing slashes,
  and an optional final /api); the deployment path prefix is part of the identity. See “Changing targets
  and ownership of existing state” in DEPLOYMENT.md.
- Only after the user's final activation approval, set enabled=true, load the target messaging gateway,
  and start the sole bridge owner. Preserve cursor/state, do not automatically replay uncertain deliveries,
  and do not treat old history as new work.

**Completion criteria**: separately record “host contract check results,” “changes actually applied,” and
“changes not applied.” Read back the exact target to check consistency of the configuration pointer,
plugin ownership, service PID, and state/cursor. Leave unauthorized steps unexecuted; synthetic output
must never stand in for real verification.

## 5. Layered acceptance and failure recovery

**Inputs**: the actual outputs just collected; use business test events only after the user authorizes a real visibility test.

**Actions/completion criteria**:

1. **Offline**: npm ci + npm test + config:check exit 0 with no skips; this proves only reproducible contracts.
2. **Host**: each of the three explicit commands reports success. Mark any unexecuted command “unverified”;
   two checks are not the full set.
3. **Runtime**: macOS health verifies the target PID/launchd label, reconciliation freshness, promptReady,
   and exact bound cursor. On Linux, use read-only checks from the existing service manager.
   A ready health result proves health, not message receipt.
4. **Visibility**: only after separate authorization, create one explicitly synthetic new event. Check
   the native run, injection acceptance, visibility in the corresponding user session, and consumption
   evidence layer by layer. Do not claim end-to-end completion without evidence at every layer.

| Failure | Next step |
|---|---|
| Configuration schema / binding fails | Report field paths and rules, not values; verify sources rather than changing identities to fit a format |
| Incompatible adapter version/internal export | Stop startup; use the pinned version or make a separate compatibility change, without bypassing checks |
| promptReady=false | Review whether the CEO template contains wakeReason; preserve management constraints rather than clearing the prompt |
| Missing auth environment | Ask the operator to supply it through their secret-management mechanism; verify presence only and do not request plaintext |
| owner_busy / legacy_owner_alive | Identify the existing owner for the user to handle; do not delete live locks or kill processes |
| paused_route / ownerHome mismatch | Reverify exact routing metadata and owner; do not change the group sender as a “fix” |
| uncertain / skipped_needs_review | Manually inspect native runs and preserve state; never retry blindly |
| Missing host paths or dependencies | Report failure explicitly and fall back to offline deliverables; skipping is not passing |
| Unexpected live behavior | Follow COMPATIBILITY.md rollback: stop the target owner, disable the plugin/adapter, and preserve cursor/state |

Finish with a brief report: changed files, commands that actually succeeded, real failures/unexecuted
items, and the next decisions required from the user. Keep all runtime evidence in a private operations
location; the public repository retains synthetic examples only.
