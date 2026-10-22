# Compatibility, safety and rollback

**English** | [简体中文](COMPATIBILITY.zh-CN.md)

[Project home](../README.md) · [AI configuration](AI_SETUP.md) · [Deployment](DEPLOYMENT.md) · [Compatibility and rollback](COMPATIBILITY.md)

## Compatibility boundary

- Pinned npm SDK and Hermes adapter: **2026.1005.0**, Node >=24.11.0. Lockfile
  records public registry dependencies. The installed package manifest and real
  `buildPrompt` function export were checked; the public server export does **not**
  contain buildPrompt. Both the installed reference and clean npm package expose
  it from internal `dist/server/execute.js`.
- Runtime rejects another Hermes adapter version or a missing internal function,
  before starting the bridge loop. A template that loses wakeReason blocks delivery.
  Updating the version requires re-running these contracts, not just editing a number.
- Hermes plugin uses `ctx.inject_message`, `ctx.on_unload`, owner-scoped `get_config`
  and host home override API. It reads only exact `gateway_routing` metadata through
  SQLite read-only mode. Those APIs/schema are installation-sensitive; no Hermes
  version range is claimed to be universally supported.
- There is no atomic expected-session-id fence in the injection API. Conversation
  and topic modes follow the same bound conversation through `/new`; session mode
  narrows a race with rechecks but requires an explicit risk acknowledgement.
- POSIX locks support macOS/Linux. Health's launchd check is macOS-only. Linux
  requires your own process-manager health check; the bridge/plugin tests do not
  assert launchd is available on Linux.
- OMP native JSON parsing requires terminal assistant provider/model and a clean
  stop plus successful process exit. Tool errors are observable but can be recovered
  by a later successful assistant stop. A successful run does not close an issue.
  No particular installed OMP version is certified by default synthetic tests.
- The OMP adapter is a **whole-repository local-path package**, not an independently
  published npm artifact: it needs `../scripts/config.mjs` and root dependencies.
  Native tools permission is not an OS sandbox; `all` is automatic tool approval.

## Verification scope

The default test suite covers fake HTTP/WS reconciliation, no replay, uncertainty,
read identity/ownership, pinned prompt behavior, subprocess model selection, redaction,
cancellation/timeouts, exact routing, owner configuration scope, group sender isolation,
`/new`, cursor identity, duplicate plugin writers, and local service ownership.
Fixtures are synthetic and are never represented as production captures.

Separate commands are needed for installed Hermes injector/FIFO contracts, Paperclip
server loader/enrichment contracts and installed OMP offline-provider probes. Missing
paths/dependencies fail; no skip means no false “all tests” claim. Even passing these
probes is not a real gateway/Telegram/control-plane acceptance test.

Not verified by this candidate packaging: actual instance-admin adapter installation,
service restart policy, live gateway loader/unloader, remote API permissions, live
WebSocket reconnect behavior, real model execution, Telegram routing/delivery, and
model consumption. Operator acceptance must explicitly cover these in a safe test
organization before enabling production use. The included CI definition also requires
an actual remote CI run before claiming CI passed.

## Runtime provenance before timeout repair

Verify the affected agent's actual adapter type and the host's registered package
entrypoint before selecting a source tree to repair. A deployed `omp_local` adapter
is not interchangeable with this repository's `omp_native_json_local` adapter.
Matching package version strings or a similarly named directory do not prove
matching loaded bytes. Do not overwrite an active adapter to make its diagnostics
match another implementation.

This adapter delegates its process timeout to the pinned SDK; it does not implement
OMP's own `--max-time` checkpoint or automatic session resume. An OMP-internal
deadline can therefore be a different fact from the SDK timer firing in another
adapter. Record effective budgets, implementation identity, process timeout and
terminal-output observations separately; never infer a timer from total wall time.
The evidence-only closeout guidance in [CEO-AGENTS.md](CEO-AGENTS.md) does not create
a deterministic checkpoint, close an issue, grant Board access or authorize replay.

An offline candidate validated here remains unactivated until its exact target,
previous writer/owner stop evidence and scoped activation are verified. Preserve
the deployed implementation and cursor; source-side regression success is not a
live recovery pass.

Notification cursors created without source identity require explicit operator
reconciliation before accepting a source-bound snapshot. The plugin refuses that
automatic migration without changing the cursor or sending a message. Do not delete
or reset delivery history to bypass the refusal. Conflicting content for the same
resource revision in a snapshot also stops delivery for manual review; input order
must never decide which business state is announced.

## Deployment invariants

One bridge owner per configured state/organization and one plugin owner per target.
Locks prevent same-path concurrent writes; different paths/hosts can still duplicate
work. Do not deploy a second bridge or change cursor paths to bypass ownership.
The initial bridge and plugin baselines intentionally do not replay historical events.
Keep source read-only to the runtime where practical; place JSON configuration and
runtime state under operator-controlled directories. Restrict their permissions.

Read-only issue/run/comments queries verify exact CEO/company identity and parent
resource ownership before projecting fields. They use GET, no scheduler state and no
anonymous fallback. Credentials belong only in process environments, never JSON or
prompt strings. The bridge heartbeat path uses the same configured identity but is
not an instance-admin credential. Follow least privilege.

## Rollback

1. Set `plugin.enabled=false` in the installation JSON and unload/disable the plugin
   with `HERMES_HOME=<ownerHome> hermes plugins disable tele-injection-plugin`; reload
   the selected gateway with your existing manager. The JSON change stops polling;
   unloading releases its owner lock.
2. Stop the bridge through the manager that owns it. Do not delete a live PID lease
   or `.owner.lock` inode. The exec gate only clears a proven dead, unchanged PID lease.
3. Disable the OMP external adapter in Paperclip management and restore the previous
   worker adapter selection. Do not delete private task workspaces as a rollback step.
4. Keep state and cursor files. Inspect any `uncertain`/`skipped_needs_review` delivery
   manually against native run state; never automatically resend. Restoring code alone
   must not reset delivery history. Resume only one verified owner.
5. Record private operational evidence outside this repository. Do not commit real
   IDs, snapshots, messages, credentials or output captures.
