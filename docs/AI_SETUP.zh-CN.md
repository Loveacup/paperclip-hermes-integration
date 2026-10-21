# AI 配置指南

[English](AI_SETUP.md) | **简体中文**

[项目首页](../README.zh-CN.md) · [AI 配置指南](AI_SETUP.zh-CN.md) · [部署指南](DEPLOYMENT.zh-CN.md) · [兼容性与回滚](COMPATIBILITY.zh-CN.md)

给为操作者准备配置、变更部署目标或排查失败的 AI。**离线准备 → 校验 → 明确授权后的激活**
是不同阶段。用户只要求“帮我配置”时，停在离线准备与校验；不要把测试成功解释为上线授权。

## 1. 建立事实与权限范围

**输入**：仓库绝对路径、用户目标、允许检查的目标安装范围。

**动作**：

1. 读 `README.zh-CN.md`、`docs/DEPLOYMENT.zh-CN.md`、`docs/COMPATIBILITY.zh-CN.md`、`config.schema.json`、
   `integration.example.json`、`package.json`。字段类型/必填以 schema 为正本；命令以实际
   scripts/实现为正本，不臆造 `--help`、安装参数或配置字段。
2. 读 `scripts/config.mjs`、`scripts/setup.mjs`、`event-bridge/prompt-contract.mjs`，
   以及要变更的组件。保留三组件结构，不用通用部署框架替换现有设计。
3. 只读检查 `node --version`、`npm --version`、`python3 --version`、目标包 manifest、
   明确路径是否存在、当前插件/服务的所有者和冲突。**未获准的宿主路径不要遍历**。
   本项目不要求读取用户配置全文、`.env`、认证文件、数据库内容、日志或聊天历史。
4. 网络仅用于公开依赖/官方文档；准备阶段不要调用真实业务 API、运行 agent、启动桥或发消息。
   宿主命令有副作用的可能时，改查源码/manifest，不以“探测”为名启动运行时。

**完成判据**：列出实际版本、允许读写目录、存在的旧写入者、缺失依赖及当前阶段。
不明的所有者、权限、服务范围标记“未知”，先询问，不自动关闭旧部署。

## 2. 从 schema 生成字段清单，再收集来源

**输入**：schema 的 `required/properties`、合成示例、用户确认的安装目标。

**动作**：为 **每个实际配置叶子字段** 输出一行：
`字段 | schema 类型/约束 | 必填/可选 | 合成示例 | 实际来源 | 已核实/待确认`。
递归读取 schema，包括 `$ref`；不要把本指南当另一份字段定义。示例取自
`integration.example.json` 并标明 synthetic，绝不填成“用户的真实身份”。

按来源分支收集，不按猜测补值：

| 字段族 | 可接受的实际来源与停止条件 |
|---|---|
| `version` | schema 的 const，不能自行升级协议 |
| `companyId` / `ceoAgentId` | 用户授权的目标控制台/导出或只读接口；核实同公司 CEO。缺任何一个就停止真实配置 |
| `apiUrl` / `authEnv` | 操作者确认的 API 基址与其凭据变量**名称**；仅确认变量是否已由服务管理器供给，不请求、读取或打印其值 |
| `bridge.*` | 操作者选定的私有状态位置、确切 adapter 包 manifest、现有服务 label；状态路径不能与未停旧 owner 冲突 |
| `plugin.ownerHome` / `routingHome` | 从目标 profile/宿主接口核实管理归属与路由元信息的实际存储位置；两者可能不同，不从用户名推导 |
| `plugin.binding.*` | 在明确授权下只读宿主精确路由元信息，见下方路由分支；任何不一致先停止 |
| `plugin.cursorDir` | 操作者确认的私有持久路径；新目录意味着新基线，不能用它绕过已有 writer |
| `plugin.instructionsPath` / `readCommand` | 经审阅的 CEO 约束与仓库只读入口；保留 `{repo}`/`{config}` 展开机制，命令 argv 中没有凭据 |
| `plugin.enabled` / `accept_nonatomic_risk` / `interval` | 操作者明确选择；准备阶段 enabled=false。session 模式风险必须由用户接受，不为通过校验擅自置 true |
| `omp.command` | 已安装 OMP 可执行文件的绝对路径；是安装权限，不来自任务文本 |
| `host.*` | 仅显式宿主契约检查时使用的准确安装目录；未提供时保留为未配置，不能声称宿主通过 |

**路由分支**：只需要 `session_key/session_id/platform/transport_profile/origin` 这些元信息，
不读取会话正文、标题或凭据。`read_route` 的只读 SQL 与 scope 规则是实际实现。
必须核实 session_key、profile、chat_type、chat_id、user_id、thread_id 相互一致；
群必须是明确 sender 的普通 conversation，空 thread；`/new` 可更新 session_id，保持同一
conversation 身份。**session_key 只能从宿主核实，不能根据字符串格式拼一个然后称为真实**。
拿不到这条路由时，请用户提供不含正文/密钥的元信息，或停止在 synthetic 预览。

**路径分支**：配置中的相对路径相对于 JSON 文件目录，而不是 shell cwd；不展开 `~`。
`{repo}` 和 `{config}` 仅用于 readCommand 模板，运行时 shell-quote。将 JSON 放到别处时
重新确认所有相对路径。插件要保留整个仓库依赖关系，部署 symlink 不是单独复制一个 `.py`。

**完成判据**：所有要激活的字段都有核实来源；没有把 synthetic 值当真实值，所有缺项已单独
列出并询问。在缺项未解决时允许继续离线示例演练，但不得产出“可上线”结论。

## 3. 只在仓库内准备与校验

**输入**：授权可写的仓库、已锁定依赖、配置草稿（或仅 synthetic 示例）。

**动作**：先保留已有本地配置，不覆盖；从示例建立 `integration.local.json` 时保持注入关闭。
凭据只存于操作者已有安全环境，不创建 `.env`、不把 secret 写入 JSON、shell argv 或提示词。
运行：

```sh
npm ci
npm test
npm run config:check -- integration.example.json
# 仅在已建立本地草稿时：
npm run config:check -- integration.local.json
npm run setup -- integration.local.json
```

最后一项是预览。`npm run setup -- integration.local.json --apply` 只生成
`.local/deploy.sh`，仍不执行宿主操作；单独得到用户允许才生成。不要把这个 apply 描述为上线。
不要执行 `--once`/`--read` 来“离线校验”：它们会真实访问 API；`--run` 会投递 heartbeat。
`--check` 虽然不访问网络，但检查凭据存在和安装 prompt 契约，不是无凭据快速开始的必要项。

**完成判据**：记录每条命令的真实退出码、测试通过/失败/skip 数、配置校验输出；预览未改变
宿主。若尚缺身份/路由，则结果标为“synthetic 示例通过；真实配置待补”，不是“配置完成”。

## 4. 宿主检查与激活分别授权

**输入**：用户对具体目标、具体改动、停旧 owner 与新基线策略的明确许可。

**动作**：

- 需要检查宿主时按 README 的 `test:host`、`test:server`、`test:installed-omp` 执行，
  配置路径作为参数。宿主检查不等于激活；最后一项实际启动 OMP，必须事先说明。
- 部署按 `DEPLOYMENT.zh-CN.md` 的人工流程。先审阅生成脚本，再确认 symlink 目标为空；已有插件
  交用户决定，不能强制覆盖。官方 `hermes config set` 只设置选定 owner 的 config_path；
  `hermes plugins enable` 只启用目标插件。不要修改全局 plugin isolation、其他 profile 或服务。
- Paperclip 外部 adapter 安装要 instance-admin 权限；桥 CEO 身份不能替代。把配置路径传给
  Paperclip 的安装环境，不允许任务覆盖执行 command。bridge 通过 argv 收到配置；
  exec gate 只保留配置所引用的凭据变量。
- 换 `apiUrl` / `companyId` / `ceoAgentId` 前先确认状态归属。桥用规范化 API 基址与公司/CEO
  元组绑定状态；身份不符或旧无身份状态必须停止，不自动修改、清空、补 identity 或重放。
  停旧 owner 并保留旧配置与完整状态后，由操作者批准新的、真正不存在的 statePath 建立基线。
  不能把旧 pending/tracked/inflight 转给新目标；uncertain 仍需人工核对。同身份重启保持 statePath。
  规范化与请求一致（URL 标准化、尾斜线和可选末尾 /api），部署路径前缀属于身份。
  详见 DEPLOYMENT.zh-CN.md 的“换目标与旧状态归属”。
- 用户最后批准激活时才 enabled=true、加载目标 messaging gateway、启动唯一 bridge owner。
  保持 cursor/state，不自动回放 uncertain，不把旧历史重新作为新工作。

**完成判据**：分别记录“宿主契约检查结果”“实际应用了哪些改动”“哪些没有应用”。
从 exact target 只读回查配置指针/插件归属/服务 PID 与 state/cursor 的一致性。
未被授权的步骤保持未执行，不用 synthetic 输出替代真实验证。

## 5. 分层验收与故障退回

**输入**：刚才的真实输出；仅在用户授权真实可见性测试后才使用业务测试事件。

**动作/完成判据**：

1. **Offline**：npm ci + npm test + config:check 退出 0，无 skip；只证明可复现契约。
2. **Host**：三个显式命令各自报告通过；没执行的标“未验证”。不把其中两项当全测。
3. **Runtime**：macOS health 校验目标 PID/launchd label、对账新鲜度、promptReady 和确切绑定 cursor。
   Linux 使用现有服务管理器的只读检查。health ready 只证明健康，不证明收到消息。
4. **Visibility**：另获授权后才产生一个明确 synthetic 新事件；逐层核对原生 run、注入 acceptance、
   对应用户会话可见性与消费证据。没有每层证据就不宣称端到端完成。

| 失败 | 下一步 |
|---|---|
| 配置 schema / binding 不通过 | 输出字段路径和规则，不输出值；核对来源，不修改身份凑格式 |
| adapter 版本/内部导出不兼容 | 停止启动，使用已固定版本或另做兼容性改动；不绕过检查 |
| promptReady=false | 审核 CEO 模板是否包含 wakeReason；需保留管理约束，不能清空 prompt |
| 缺 auth 环境 | 请操作者用其秘密管理机制供给，仅验证存在；不索取明文 |
| owner_busy / legacy_owner_alive | 找到原所有者由用户处理；不删除活锁/杀进程 |
| paused_route / ownerHome 不匹配 | 再核实 exact routing 元信息及 owner；不改群 sender 来“修复” |
| uncertain / skipped_needs_review | 人工核对原生 run，保持状态，绝不盲重试 |
| 宿主路径或依赖缺失 | 明确失败，退回 offline 成果；不是 skip 后算通过 |
| 线上行为不符 | 使用 COMPATIBILITY.zh-CN.md 回滚：停目标 owner、禁用插件/adapter、保留 cursor/state |

最终交付一段简短报告：改动文件、实际成功命令、真实失败/未执行项、下一步需要的用户决定。
所有运行证据留在私有运维位置，公开仓库仅保留合成例子。
