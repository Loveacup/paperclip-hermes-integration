# Rebuild the integration from a clean checkout

[简体中文](REBUILD.zh-CN.md) · [Deployment](DEPLOYMENT.md) · [Acceptance ledger (Chinese)](REBUILD-PLAN.zh-CN.md)

This runbook reconstructs the integration's source and wiring from public, version-pinned inputs. It does not clone an organization's identities, tasks, messages, credentials, cursors or uncertain-write state. Clean installation, local composition and live target acceptance are separate results.

## 1. Reproduce the repository

```sh
git clone https://github.com/Loveacup/paperclip-hermes-integration.git
cd paperclip-hermes-integration
npm ci
npm test
npm run config:check -- integration.example.json
npm run setup -- integration.example.json
```

Root npm workspaces install the rich adapter's dependencies with the root lockfile. Do not copy an author's node_modules, caches or sibling checkout. Default tests are synthetic/local; `setup` only previews a reviewable script and does not install/start the entire stack. Run the same commands on a pinned repository commit when recording acceptance.

Included product boundaries:

- `event-bridge/`: target-bound event reconciliation, authenticated reads, owner locks and health.
- `tele-injection-plugin/`: owner-scoped configuration and exact sender/conversation routing.
- `ceo-control/` plus `scripts/ceo.mjs`: authenticated management with the shared configuration; no permission grants or reconciliation bypass.
- `server-patch/`: fixed-baseline CEO lifecycle changes, explicit root, default check-only application, original authorization and unknown-effect protections.
- `omp-local-adapter/`: rich `omp_local`, with the actual host SDK runner/map bound at installation.
- `omp-adapter/`: separate `omp_native_json_local` protocol/permission contract; not an interchangeable alias for `omp_local`.
- `segmented-qa/`: frozen single-execution QA plus trusted-plan activation and formal report publication.

## 2. Supply explicit host prerequisites

For bounded-output and commit-first cancellation repairs, follow the additional
[version-bound bundle and test instructions](REPAIR-RELEASE.md); root installation
does not silently patch an SDK or server. Keep deployment acceptance separate.

- Node **24.11.0+**, npm and Python **3.9+**, on a supported POSIX target.
- Public Paperclip server/shared/adapter SDK **2026.1005.0**, with the selected installation's dependency closure. The patch's public tarball integrity and six guarded file hashes are in `server-patch/source-baseline.json`.
- A Hermes installation satisfying the documented injection/routing contracts; verify the actual target with the host checks below. This repository does not promise arbitrary Hermes versions or vendor its core.
- An operator-installed OMP executable and its separately protected provider configuration. `omp.command` is installation authority, not a task argument. Local version-only observation found `omp/18.12.5`; that is not execution/compatibility acceptance of this rebuilt adapter. The rich adapter retains the reviewed native JSON/deadline/skills contract; verify your selected CLI before live adoption.

If CEO pause/terminate/cancel capability is required, prepare the exact public pristine server sources and follow [the patch guide](../server-patch/README.md). Preserve the upstream notice. Only apply to an explicitly chosen offline copy after all hashes pass; do not refresh hashes to accept another version. Starting/replacing an installed server requires separate operational approval. The target still needs legitimate configure grants and normal human approvals.

## 3. Configure a new target, not old state

```sh
cp integration.example.json integration.local.json
npm run config:check -- integration.local.json
npm run setup -- integration.local.json
```

Replace synthetic values from verified target metadata. Keep credentials outside JSON; `authEnv` names a protected environment variable. Choose fresh state/cursor directories for a genuinely new target, without importing historical pending/unknown effects. Updating an existing target requires its current owner to stop and release its write scope first.

For rich OMP, `host.paperclipServerRoot` must be the **actual server package directory containing package.json and dist**, not the enclosing checkout or another same-version installation. Set `PAPERCLIP_INTEGRATION_CONFIG` in that server's trusted startup environment. Use ordinary unbundled Node ESM without loader/preload/custom-condition/symlink-preserving overrides. The installation entry validates the host import chain, SDK version/canonical resolution and actual consumer-map identity; a missing/incompatible host fails closed. Never patch a global Map or create another process supervisor to hide a mismatch.

## 4. Verify optional host layers explicitly

```sh
npm run test:host -- integration.local.json
npm run test:server -- integration.local.json
npm run test:omp-local -- --host /absolute/actual/node_modules/@paperclipai/server
npm run test:segmented-qa -- --paperclip-packages /absolute/actual/node_modules/@paperclipai
```

Missing prerequisites fail rather than skip. The rich host tier uses owned synthetic Node children and the real host registry/stop primitive, not a real OMP/model or heartbeat API. The QA host tier uses real SDK factories and synthetic loopback endpoints. The patch's separate 41-case public-source AST/VM tier has its own pinned parser preparation command. These are not DB, provider, message-delivery or production cancellation certification.

The older `npm run test:installed-omp -- integration.local.json` is a distinct opt-in: it actually starts OMP in an isolated HOME with an offline synthetic provider. Do not describe it as a static/no-execution check.

## 5. Assemble only after target-specific approval

Use [DEPLOYMENT.md](DEPLOYMENT.md) for the plugin symlink, official plugin enable/config calls, adapter install API, CEO wake template and bridge service argv. Keep the complete repository layout; adapter entrypoints share the root configuration loader.

For the rich adapter, install the local path `$PWD/omp-local-adapter` through the same pinned host's administrator adapter-install interface, and select **`omp_local`**. For the thin adapter, `$PWD/omp-adapter` supplies **`omp_native_json_local`**. Do not silently switch existing workers between them. Adapter installation requires the proper instance authority, not an impersonated CEO/Board credential.

Use the target's normal management workflow to admit the desired CEO/worker actors and grants. For segmented QA, admit a dedicated model-free `process` actor with organization-management permissions disabled and periodic heartbeat disabled, while allowing native demand/dependency execution. Create a project, its genuine CEO coordinator and three unassigned fresh backlog phase issues. Use their actual returned IDs in the trusted plan described in [NATIVE-WORKFLOW.md](../segmented-qa/NATIVE-WORKFLOW.md). Do not approve a pending hire, reuse a terminal run ID or erase an intent to make activation pass.

The native workflow supplies preparation, reverse-order activation and document publication; it deliberately does not create/approve these resources or invoke heartbeat. Its `plan` operation is pure. `activate/prepare/publish --execute` require the appropriate genuine running native context. Unknown/partial writes stop for reconciliation, not replay.

## 6. Record target acceptance honestly

A live reconstruction is accepted only after the target-specific effects are verified:

1. Exact registered adapter entry, host package and clean bootstrap are confirmed; no conflicting writer remains.
2. A bounded real native task and, where approved, its actual cancel/stop path complete; run status alone is not process-exit evidence.
3. QA dependencies trigger natively, machine executes once, and exact formal document readback precedes closeout completion.
4. The exact intended Hermes conversation consumes the event and the user-visible platform delivery is verified separately.
5. Credentials, state and unknown effects remain owned by this target; no second scheduler or hidden author-machine helper is required.

Until those approved live checks exist, report **source/install/local composition verified; live target acceptance pending**, not complete production reconstruction. Keep broader incident/recovery gaps separate from source packaging. Source publication never authorizes service replacement, permission expansion, model spend or message delivery on its own.
