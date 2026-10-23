# CEO control CLI

自包含 Node.js ES module，仅使用 Node 内置模块；无 npm 安装、daemon、数据库或模型调用。需要支持全局 fetch、AbortSignal.timeout 和 node:test 的 Node.js（建议 Node 22+）。本轮验证运行时为 Node 26.10.0/macOS；未验证其他操作系统或 Node 版本。测试需允许创建临时目录、启动子进程和绑定 loopback 随机端口。

本组件保留已有 CEO CLI 协议，不安装服务端权限补丁，不部署 Hermes/Paperclip，也不授予权限。实际使用需要外部 Paperclip 服务、匹配版本的 API、已有 CEO 身份及合法凭据。源码可复制到任意目录；相对配置/凭据路径按调用者 cwd 解析。

## 独立配置与外部凭据

本 CLI 的 `--config` **不是**集成仓库的 `integration.example.json`。它只接受下列非秘密字段；统一配置适配由调用方另行接线，不要把集成配置直接传入，也不要在仓库保存凭据：

```json
{"companyId":"COMPANY_ID","agentId":"CEO_ID","apiUrlEnv":"PAPERCLIP_BRIDGE_READ_API_URL"}
```

将占位符替换为自己的 ID。`--company-id`、`--agent-id` 覆盖文件值；没有组织或 agent 默认值。`apiUrlEnv` 仅允许 `PAPERCLIP_API_URL` 或 `PAPERCLIP_BRIDGE_READ_API_URL`。URL 是外部环境值，不是 JSON 中的明文字段。URL 仅允许 http/https、根 API 路径（可带 `/api`），不能包含用户信息、查询或 fragment。远程使用应选可信 HTTPS 主机；本工具不验证宿主是否可信。

- 存在 `PAPERCLIP_API_KEY` 时严格进入 native 模式：`PAPERCLIP_AGENT_ID`、`PAPERCLIP_COMPANY_ID`、`PAPERCLIP_RUN_ID` 必须匹配配置。URL 优先 `PAPERCLIP_API_URL`；身份不匹配不回退其他凭据。预读 run，核对 agent/company/status=running。只有 native 写请求附真实 `X-Paperclip-Run-Id`。
- 非 native 模式使用 `PAPERCLIP_BRIDGE_READ_IDENTITY`、`PAPERCLIP_BRIDGE_READ_API_URL`。历史命名含 READ，但 key 的真实权限由服务端决定。可用 `--env-file PATH` 从外部私密文件读取这两个键；环境值优先。literal parser 不 source/eval，不展开变量/命令，重复键和未闭合引号拒绝。native 模式忽略该文件。
- 每次先 `GET /agents/me` 验证配置 agent/company、role=ceo，并拒绝带 keyScope 的身份。不使用 Board、匿名身份或伪造 runId。
- 凭据不接受 CLI 参数。输出 `actorSource=native-run|telegram-agent-key` 与 `auditScope`；后者是客户端上下文声明，不保证每条服务端 activity 都持久化 runId。

配置好外部环境后，在本目录执行：

```sh
node ceo.mjs --config options.json inventory
node ceo.mjs --config options.json api GET /projects/PROJECT_ID
printf '%s' '{"name":"New project"}' | node ceo.mjs --config options.json --execute api POST /companies/COMPANY_ID/projects
printf '%s' '{"assigneeAgentId":"WORKER_ID","blockedByIssueIds":["BLOCKER_ID"]}' | node ceo.mjs --config options.json --execute api PATCH /issues/ISSUE_ID
printf '%s' '{"reason":"organization management"}' | node ceo.mjs --config options.json --execute wake
```

写示例会真实改变指定服务，不是离线演示。需自行审核目标和授权；无 `--execute` 不发送写请求。JSON 从 stdin 读取，空 stdin 为 `{}`。

## 管理范围与安全边界

`api GET|POST|PATCH|PUT|DELETE /path` 不是任意 HTTP 代理或完整 SDK。服务端仍负责 payload schema 和最终权限。

- 公司作用域集合：projects、issues、agents、agent-hires、goals、routines、skills、live-runs、heartbeat-runs（以及路由白名单中的 work-products）。
- projects：资源及 workspaces。
- issues：资源、children/comments/dependencies/documents/documents/{key}/work-products/checkout/release。依赖可通过 PATCH 的 blockedByIssueIds 管理；文档 baseRevisionId 预读验证。
- agents：资源、permissions、skills、skills/sync、pause/resume/terminate。同公司其他 agent 可以成为管理目标，但不能直接唤醒。
- goals；routines 及 triggers/run/revisions/runs；公司 skills/{id} 及 files/versions/comments/rename/fork。
- work-products/{id} 需 `--issue-id` 预读 issue 和成员列表。
- heartbeat-runs/{id}、cancel；`wake` 仅唤醒自己并精确读回返回 run。skipped 不表示创建成功。

公司路径须匹配配置；其他资源预读父资源验证公司归属。body 中已识别的 agent/project/goal/issue/依赖/skill 引用先校验；未知非 null `*Id/*Ids` 保守拒绝。完整 URL、编码路径/查询键、路径穿越、任意 host、密钥/配置导出/实例接口均拒绝；查询参数只有有限白名单。不会自动扩大授权范围。

上游服务可能将 pause/terminate/cancel 等操作限制为 Board-only。此 CLI 的路由支持**不等于服务端允许**，本组件没有安装或携带权限补丁。403/409 不换身份、不重试；错误中的 wake 建议仅用于需要 native run 上下文的操作，不能绕过 Board-only 权限。PATCH agent status 不证明活跃 run 停止；PATCH issue cancelled 也不能替代精确 run 状态核对。

## 写效果、输出和盘点

写请求只发一次；断线、超时、5xx 或写响应 JSON 无法解析返回 `unknown_effect_check_target_no_retry`，非零退出。先人工核对目标，不自动再次提交。

成功响应后精确读取目标或父作用域集合；PATCH/PUT 对可投影字段逐项比较，权限响应按嵌套 permissions 比较，生命周期按目标资源最终状态比较。`verification=read_back` 不保证未投影字段生效，也不保证 POST 的所有输入被采纳。读回失败/不匹配为 `status=accepted_unverified`（包括 DELETE 后 404）；该状态退出码仍为 0，消费者必须检查 JSON。不是所有写后校验异常都统一为同一状态；wake 等路径可能非零退出，均不得据此自动重试。

固定字段投影排除 adapterConfig/env/runtimeSecrets/private logs/未知字段，不输出原始服务端错误。业务正文仍可能含敏感数据，投影不是通用秘密扫描器。

`inventory` 读取 archived projects、agents、分页 issues 和 bounded live-runs：

- issues 用 compact、includeBlockedBy、includeRoutineExecutions、includePluginOperations，按 id 排序 offset 分页。默认 page-size=100/max-pages=100；可配置 1..100 与 1..1000。两次终止扫描一致才标记 enumerated；重复、漂移和上限明确不完整。
- blocks 仅从可见 issues 反推；缺失依赖或 blockedBy 会影响 dependenciesComplete。
- live-runs 固定 limit=50；达到上限不完整，少于上限仅描述当前端点响应。项目/agent 无分页、活动 run 上限等是现有 API 假设，换服务端版本必须重新验证。
- 顶层永远 `coverage.complete=false, scope=actor_visible_non_atomic`；两个相同扫描不是原子全组织快照，不读取数据库补齐。

## 本地验证

从本目录运行（也可从任意 cwd 用测试文件绝对路径）：

```sh
node --test --test-reporter=tap ceo.test.mjs
node --check ceo.mjs
```

测试仅启动自建 `127.0.0.1` 随机端口合成 API 和独立 CLI 子进程；不继承宿主凭据/模型变量。fixture 的 cwd 与子进程 TMPDIR/TMP/TEMP 均指向测试自建的规范化临时目录。父测试进程使用 `os.tmpdir()`；如需限制全部写入范围，运行前将 TMPDIR 指向自己已创建的隔离目录。只清理自建目录，结束后关闭 fixture 服务。

本轮：原始 22 项回归先通过；新增 1 项 fixture 相对配置/cwd 便携性测试遵循 RED→GREEN。CLI 实现字节未改；旧能力只是复跑回归，不冒称重新进行了 TDD。全部 23 项覆盖身份、同公司引用、显式执行、读回、native header、自唤醒、分页边界、错误/秘密输出和写失败不重试。合成 API 不模拟完整服务端 schema、调度或权限系统，因此不能证明真实部署、全部管理 API、取消竞态、Telegram 消费或生产恢复流程。无线上验收声明。局部运行日志和 manifest 不属于本组件的公开文件。
