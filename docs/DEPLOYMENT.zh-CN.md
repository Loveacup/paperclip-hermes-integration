# 配置、部署与检查

[English](DEPLOYMENT.md) | **简体中文**

[项目首页](../README.zh-CN.md) · [AI 配置指南](AI_SETUP.zh-CN.md) · [部署指南](DEPLOYMENT.zh-CN.md) · [兼容性与回滚](COMPATIBILITY.zh-CN.md)

以下命令从仓库根目录执行。部署操作需要单独明确授权；先完成 README 的离线 Quick Start。

## 一个可编辑配置入口

```sh
cp integration.example.json integration.local.json
# 用编辑器修改 integration.local.json；不要添加密钥值
npm run config:check -- integration.local.json
```

`config.schema.json` 严格拒绝未知字段。所有相对路径以 **JSON 文件所在目录** 为基准；
推荐保留配置于仓库根或使用绝对路径。不要把整棵仓库拆开安装，Python 插件和 adapter
会引用根目录的共享校验器。`node` 必须在网关和服务的 PATH 内。

| 配置 | 修改内容 |
|---|---|
| `companyId` / `ceoAgentId` | 目标组织与 CEO 的真实 UUID；示例是 synthetic |
| `apiUrl` / `authEnv` | API 基址；凭据**环境变量名称**，不是值 |
| `bridge.statePath` | 非源码目录下的持久状态；不能与旧部署共用写入 |
| `bridge.hermesAdapterRoot` | 被校验的 Hermes adapter 包目录，固定要求 2026.1005.0 |
| `bridge.serviceLabel` | macOS launchd label，仅供 health 读取 |
| `plugin.ownerHome` | 拥有插件配置的 Hermes profile home，必须等于插件 manager.home_path |
| `plugin.routingHome` | 存储精确 gateway_routing 的 home；只读此元信息，不能猜 profile DB |
| `plugin.cursorDir` | 持久 cursor 目录；按绑定摘要区分 DM/群/sender，conversation/topic 的 `/new` 不重放 |
| `plugin.binding` | 从目标环境核实的完整绑定：profile、平台、chat/user/thread、session_key/session_id |
| `plugin.instructionsPath` | CEO 工作约束文档，可改为部署自己的文件 |
| `plugin.readCommand` | 只读命令 argv 模板；`{repo}` 与 `{config}` 自动展开并 shell-quote |
| `plugin.enabled` | 确认目标、授权及新基线策略后才改为 true |
| `omp.command` | **安装级** OMP 绝对路径；不接受任务 config.command/prefixArgs |
| `host.hermesSource` | 可选 Hermes 宿主契约测试的显式源码目录 |
| `host.paperclipServerRoot` | 实际 server 包目录（package.json 与 dist）；用于可选 server 测试及 rich `omp_local` 必需的安装绑定，不是默认离线测试依赖 |

Hermes 配置仅保存一个 `config_path` 指针；其 owner scope 不受当前会话的 ambient profile
影响。JSON 是部署者可信文件，不接受任务内容修改。更改后重新加载插件；运行中检测到配置
改变会停止轮询。OMP command 在 factory 创建时固定，更改后须重新加载 adapter/服务。
任务 `config.model` > agent 默认模型 > OMP 默认模型；输出始终要求真实 provider/model，
完整 `provider/model` 请求不一致会失败；短模型别名仅报告实际解析值，不假装严格匹配。

## 部署（必须人工确认，默认不执行）

1. 停掉旧桥和旧目标插件写入者；保留其状态备份。不要并行部署两个桥到相同组织，
   也不要换一个 cursorDir 绕过已有目标锁。新路径会建立新基线，历史事件不重放。
2. 修改本地 JSON。确认普通群使用 `mode=conversation`、负 chat ID、明确 sender、空 thread。
   `session` 模式还必须明确接受非原子绑定风险。禁止删除群 sender 来广播注入。
3. 校验并生成待审脚本：

   ```sh
   npm run setup -- integration.local.json             # 只预览
   npm run setup -- integration.local.json --apply     # 只写 .local/deploy.sh
   # 阅读脚本后才运行；它创建插件 symlink，调用官方 config set / plugins enable
   sh .local/deploy.sh
   ```

   脚本遇到已有插件目标会拒绝覆盖。它不会启动网关、桥、模型或调度器。
   修改 `plugin.enabled=true` 后，使用你现有的服务管理方式重启选定的 messaging gateway；
   **不要在 Hermes CLI 会话加载为注入目的使用**。插件目录以 symlink 保留本仓库共享文件关系。
4. 把 `PAPERCLIP_INTEGRATION_CONFIG=/absolute/path/integration.local.json` 传给 **Paperclip server
   的安装环境**。以 instance admin 在 Paperclip 的 adapters 管理界面从本地路径安装
   `$PWD/omp-adapter`。2026.1005.0 对应管理 API 为 `POST /api/adapters/install`，body 为
   `{"packageName":"/absolute/path/to/repository/omp-adapter","isLocalPath":true}`；认证须使用实例管理身份，
   **不要使用桥的 CEO 凭据冒充管理员**。云托管实例可能禁止此操作。本项目不自动调用该 API。
   给 worker 选择 `omp_native_json_local`，设置 cwd、可选 model 与 permission。

   rich 实现使用同一管理员入口/API，改为本地 `$PWD/omp-local-adapter`，worker 选择 `omp_local`。
   `host.paperclipServerRoot` 必须是本次实际 server 包，不能是外层 checkout 或另一同版本实例。
   加载时绑定真实宿主 runner／登记表，缺失或不兼容拒绝；使用普通未打包 Node ESM，不使用
   loader/preload/custom-condition／保留 symlink 的覆盖模式。保持完整仓库布局，配置其支持的
   cwd/model/thinking/approvalMode，不照搬薄适配器的 permission 契约，不静默替换原 worker。
   详见 [rich 边界（英文）](../omp-local-adapter/README.md)和[重建指南](REBUILD.zh-CN.md)。
5. 给 CEO 原生 Hermes adapter 配置包含 `{{wakeReason}}` 的 promptTemplate，保留原有管理约束。
   默认模板在已核验版本会丢弃 wakeReason，桥对此阻断投递。桥会验证新会话和 resumed 会话路径。
6. 凭据由你的受控服务环境提供（变量名称见 `authEnv`），不要写进 JSON、argv、仓库或提示。
   确认它属于同公司 CEO，且 API 权限满足现有使用范围。`--check` 不验证远端身份：

   ```sh
   node event-bridge/bridge.mjs --config "$PWD/integration.local.json" --check
   # 下面两项会进行真实认证 GET；--once 不写状态、不 POST、不启 WebSocket
   node event-bridge/bridge.mjs --config "$PWD/integration.local.json" --once
   node event-bridge/bridge.mjs --config "$PWD/integration.local.json" --read issue RESOURCE_UUID
   # 只读类型也支持 run / comments；先校验 /agents/me 和资源 companyId
   ```

   `--read` 的返回可能包含任务标题/评论正文，只在授权会话使用，不要提交返回结果。
   不再支持旧部署的 `--env-file`；密钥仅从配置引用的环境变量读取。
7. 使用生成脚本中的完整 service argv 配置现有服务管理器，或人工前台启动：

   ```sh
   # STATE_PATH 必须等于 JSON 解析后的 bridge.statePath；先 mkdir -p 它的父目录
   python3 -B event-bridge/service_exec.py --state "$STATE_PATH" \
     --config "$PWD/integration.local.json" -- "$(command -v node)" \
     "$PWD/event-bridge/bridge.mjs" --config "$PWD/integration.local.json" --run
   ```

   `service_exec` 会清理环境，只额外保留 `authEnv` 指定的一个凭据，配置路径通过 argv
   传递；不增加 supervisor。内核 owner lock 防止同 state 多写，活 PID lease 不自动驱逐。
   首次 `--run` 只建立基线；后续状态变化才触发 heartbeat。`uncertain` 永不自动重试。

### 换目标与旧状态归属

桥状态保存 `identity` 元组：规范化后的 `apiBase`、`companyId`、`ceoAgentId`。
API 与请求共用规范化：URL 标准化（主机大小写、默认端口、路径点段），移除尾斜线和
可选的末尾 `/api` 后补 `/api`，保留部署路径前缀。等价 API 拼写不改变身份。
`--run`、`--once`、`--status`、`--check` 都先核对状态归属；身份不符报
`state_identity_mismatch`，旧无身份状态报 `state_identity_missing`，不会联网、修改、清空或重放它。
只有状态文件真正不存在才允许新基线；损坏文件、悬空 symlink 不算不存在。

更换 API/公司/CEO 时先停旧 owner，保留旧状态（包括 pending、tracked、inflight、uncertain）
及其配置备份，再经操作者确认选择**全新且不存在**的 `bridge.statePath`。旧状态只供原目标
核查，不能给它手工改 identity、复制队列到新目标或用删除状态来绕过 uncertain。
无身份旧状态也不自动补身份：需要人工核对旧目标与未决投递，保留原件，再明确选择新基线。
同身份重启继续已有状态；已绑定身份但没有 revisions 的旧状态保留原有按真实变化升级语义。

## 检查与边界

```sh
# 本地只读 health，macOS launchd 专用；读取精确群 cursor，不读取旧 DM cursor
python3 -B event-bridge/health.py --config "$PWD/integration.local.json"
# 明确 opt-in；缺失宿主或不兼容直接失败，不会静默 skip
npm run test:host -- integration.local.json
npm run test:server -- integration.local.json
npm run test:installed-omp -- integration.local.json
```

`test:host` 检查安装源码的 injector/FIFO 契约，不启动真实 gateway；
`test:server` 检查服务器内部 loader/enrichment 与 fake 子进程；
`test:installed-omp` **实际启动 OMP**，但仅在隔离 HOME 中加载 synthetic offline provider，
不调用真实模型。它要求 OMP 能解析该测试扩展依赖。默认测试不包含这些三类探针。

详见 [兼容性与回滚](COMPATIBILITY.zh-CN.md)、[来源与许可证](../THIRD_PARTY_NOTICES.md)。
health 的 ready、API accepted、CEO terminal 都不是模型消费或用户收件凭证。
