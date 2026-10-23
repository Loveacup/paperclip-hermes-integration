# Bounded output and commit-first cancellation repair

## Published source versus deployment and acceptance

This revision packages the product repairs previously activated on one separately
approved installation. That installation's bounded acceptance covered a genuine
native self-cancellation with process exit, SDK UTF-8 regressions and the installed
OMP CLI using a synthetic offline provider. It did not certify a real rich-OMP
model/API run, a complete provider goal workflow or every cancellation race.
Publishing this repository does not deploy it. Private manifests, activation
journals, identities and logs are deliberately excluded.

Before publication, the portable default suite passed 465 tests; the explicit
repair host tier passed SDK 8 plus cancellation 114, separately from the existing
41-case lifecycle tier. These are local pre-publication results, not a claim about
any later commit or CI. Use the exact commit's Actions jobs and release test record
for remote/fresh-clone acceptance. No live service is changed by these tests.

Remaining: complete live OMP/provider goal E2E, automatic business checkpoint,
soft-closeout and arbitrary failure continuation are not accepted/implemented by
this repair. Historical failures, unknown effects and reconciliation gates remain;
GitHub issue #1 remains open for its broader criteria.

## Product mapping

| Input capability | Portable source |
| --- | --- |
| Native JSON 8 MiB bounded terminal, fixed metadata diagnostics/progress | `omp-adapter/index.mjs` |
| Rich terminal-only 8 MiB envelope, ordinary 1 MiB events and explicit caller caps | `omp-local-adapter/index.mjs`, `output-parser.mjs` |
| Actual shared SDK incremental UTF-8 decoding on both streams | `server-patch/sdk/manifest.json` (one generated dist target) |
| Commit-first cancellation; locked authorization snapshot; one denial response | `server-patch/cancellation/manifest.json`: `routes/issues.js` |
| One-shot registration/consumption and recovery exclusion | same bundle: `services/runner-goals.js`, `services/heartbeat.js` |
| Exact old controller generation / session / run / thread / owner epoch | same bundle: broker, native executor, harness backend, Codex session, native runtime |
| Durable pre-wire attempt consumption, reload/no-resend and unknown queue fence | same bundle: durable control plane and runnerd transport |

The cancellation bundle has ten targets; SDK has one; adapters have three source
files. All eleven generated product outputs match the frozen repair bytes. The
adapter ports retain existing installation-owned configuration and native timing
observability rather than overwriting them with instance-bound defaults. Tests use
synthetic IDs (including explicitly zero-prefixed UUIDs), not live identities.

No entire upstream server or private node_modules is published. The existing
check/preview/apply generator handles all bundles without weakening baseline,
candidate hash, path, symlink, hardlink or partial-write refusal. No automatic
rollback/retry or service activation is added. No change to a native SDK registry
singleton is made by the UTF-8 repair.

## Reproduce

```sh
npm ci
npm test
npm run config:check -- integration.example.json
npm run setup -- integration.example.json
```

The default suite includes native/rich boundary regressions and eight tests that
copy the installed pinned SDK to a temporary directory, apply the published patch
and import that actual generated SDK. The installed dependency is not modified.
Default tests have no server download or private-host prerequisite.

For optional public-source tests, obtain the pristine server tarball following
[the existing integrity instructions](../server-patch/README.md). Its version,
tarball SHA-256 / SHA-512 and target SHA-256 values are also recorded in
`server-patch/cancellation/source-baseline.json`. Do not use an installed/patched
server as a pristine baseline. Use only a disposable offline copy.

```sh
npm --prefix server-patch/host-deps ci --ignore-scripts --no-audit --no-fund
python3 -B server-patch/run_host.py --root /operator/work/server/package/dist
python3 -B server-patch/run_repair.py --server-root /operator/work/server/package/dist
```

The second command is the existing lifecycle AST/VM tier. The third imports or
extracts real generated functions/classes, including real durable-file persistence
and loopback Express responses; DB, provider transport and process/network leaves
are explicit fixtures. It is not the full application's JWT/service-factory or
PostgreSQL transaction/concurrency integration suite. Missing prerequisites fail;
not requesting this tier is not a passing result.

Apply checks are explicit and default to read-only:

```sh
python3 -B server-patch/apply.py --bundle cancellation --root /operator/work/server/package/dist
python3 -B server-patch/apply.py --bundle sdk --root /operator/work/adapter-utils/package/dist
# Add --apply only for an exclusively owned, disposable/offline copy.
```

The original lifecycle bundle is still the default. Its three targets are disjoint
from cancellation targets; it reads heartbeat as a pristine dependency, so apply
lifecycle before cancellation when assembling both. For SDK installation, identify
the actual host-resolved SDK first: patching another identical package does not
patch the host's runner. Root `npm ci` intentionally restores pristine dependencies;
there is no hidden postinstall activation.

Never let an older runtime replay the new targeted-stop durable journal. Inspect
journal compatibility before an operator-approved upgrade or rollback; retain
unknown fences and the sole lifecycle writer. No permission to reconcile unknown
historical effects is implied.

## 本次发布范围与限制

本轮将已受控激活的 14 个产品文件映射为便携源码：server 10、SDK 1、两类
OMP 共 3。11 个补丁生成输出保持冻结产品字节；OMP 保留便携安装配置及已有
超时观测字段。固定版本/完整性拒绝、协议/模型/文本上限、单 writer 与 UNKNOWN
对账保护不变，不发布私人证据或整包依赖。

默认 465 项、显式 SDK 8 项及取消链路 114 项为发布前本地实测，不冒称远端提交
或 CI 已通过。推送后须从精确远端提交、含空格新目录及独立 HOME/TMPDIR 重跑，
并核对该 SHA 的 Ubuntu/macOS jobs。使用上方命令可复现。

已部署样本仅包括原生自取消/进程退出及离线 provider 的 OMP CLI；本仓库发布
不自动部署。真实 rich OMP 模型/API、完整 provider goal E2E 未验收，通用自动
checkpoint/soft-closeout/任意失败续办未实现或未验收。完整 PostgreSQL/JWT 应用
层未纳入本次便携套件，GitHub issue #1 的宽泛标准保持 OPEN。
