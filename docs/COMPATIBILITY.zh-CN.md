# 兼容性、安全与回滚

[English](COMPATIBILITY.md) | **简体中文**

[项目首页](../README.zh-CN.md) · [AI 配置指南](AI_SETUP.zh-CN.md) · [部署指南](DEPLOYMENT.zh-CN.md) · [兼容性与回滚](COMPATIBILITY.zh-CN.md)

## 兼容性边界

- 固定的 npm SDK 和 Hermes adapter 版本为 **2026.1005.0**，要求 Node >=24.11.0。
  Lockfile 记录公开 registry 依赖。已检查安装包 manifest 和真实 `buildPrompt` 函数导出；
  公开 server 导出**不包含** buildPrompt。已安装的参考包与干净的 npm 包都从内部
  `dist/server/execute.js` 导出该函数。
- 运行时会在启动桥循环之前拒绝其他 Hermes adapter 版本或缺失的内部函数。
  丢失 wakeReason 的模板会阻断投递。升级版本必须重新执行这些契约检查，不能只修改版本号。
- Hermes 插件使用 `ctx.inject_message`、`ctx.on_unload`、owner-scoped `get_config`
  和 host home override API。它仅通过 SQLite 只读模式读取精确的 `gateway_routing` 元信息。
  这些 API/schema 依赖具体安装；本项目不声称任何 Hermes 版本范围普遍受支持。
- 注入 API 没有原子的 expected-session-id fence。conversation 和 topic 模式在 `/new` 后
  继续跟随同一绑定会话；session 模式通过重复检查缩小竞态窗口，但要求明确接受风险。
- POSIX 锁支持 macOS/Linux。health 的 launchd 检查仅适用于 macOS。Linux 需要使用你自己的
  进程管理器进行健康检查；桥/插件测试不会断言 Linux 上存在 launchd。
- OMP 原生 JSON 解析要求终态 assistant 的 provider/model、正常停止以及进程成功退出。
  工具错误可被观测，但后续成功的 assistant stop 可以使运行恢复成功。运行成功不等于关闭 issue。
  默认的 synthetic 测试不认证任何具体已安装 OMP 版本。
- OMP adapter 是**依赖整个仓库的本地路径包**，不是独立发布的 npm 制品：它需要
  `../scripts/config.mjs` 和根目录依赖。原生工具权限不是操作系统沙箱；`all` 表示自动批准工具。

## 验证范围

默认测试套件覆盖 fake HTTP/WS 对账、不重放、不确定投递、只读身份/归属校验、固定版本的 prompt
行为、子进程模型选择、脱敏、取消/超时、精确路由、owner 配置范围、群 sender 隔离、`/new`、
cursor 身份、重复插件写入者和本地服务归属。Fixtures 均为 synthetic，绝不冒充生产采集数据。

已安装 Hermes 的 injector/FIFO 契约、Paperclip server 的 loader/enrichment 契约，以及已安装 OMP
的 offline-provider 探针，需要分别运行独立命令。缺失路径/依赖会失败；不通过 skip 制造“全部测试
通过”的假象。即使这些探针通过，也不代表完成了真实 gateway/Telegram/控制面的验收。

本次候选打包尚未验证：实际 instance-admin adapter 安装、服务重启策略、在线 gateway 的加载/卸载、
远端 API 权限、在线 WebSocket 重连行为、真实模型执行、Telegram 路由/投递，以及模型消费。
启用生产用途前，操作者必须在安全的测试组织中明确验收这些项目。仓库包含的 CI 定义也必须实际
在远端执行后，才能声称 CI 通过。

## 修复截止问题前先核对运行来源

先确认受影响 agent 的真实 adapter type，以及宿主注册的包入口，再选择修复源码。
已部署的 `omp_local` 与本仓库的 `omp_native_json_local` 不是可直接互换的实现。
版本字符串相同或目录名称相似，不证明已加载字节相同；不得覆盖活动适配器来让两者诊断字段一致。

本适配器将进程超时交给固定版本的 SDK；没有实现 OMP 自身 `--max-time` 的检查点或自动会话恢复。
其他适配器中的 OMP 内部截止与 SDK 计时器触发可能是不同事实。应分别记录有效预算、实现身份、
进程超时和终态输出观测，不从整轮墙钟耗时反推计时器是否触发。
[CEO 处理合同](CEO-AGENTS.md)中的“仅证据收口”指导不会凭空产生确定性检查点、关闭任务、
授予 Board 权限或允许重放。

离线候选通过不等于已启用。切换前必须核实精确目标、原 writer/owner 的停写证据及本次启用范围；
保留已部署实现和 cursor，不将源码回归通过说成线上恢复通过。

未绑定来源身份的旧 cursor 必须先由操作者明确对账，才能接收带来源身份的快照；插件会拒绝自动
认领来源，不改 cursor、不发送消息。不要删除或重置投递历史来绕过拒绝。同一快照内，若同一资源
同一 revision 出现内容冲突，同样停止投递、等待核查，不能由输入排列顺序决定播报哪个业务状态。

## 部署不变量

每个配置的状态/组织只能有一个 bridge owner，每个目标只能有一个 plugin owner。锁防止同路径
并发写入，但不同路径/宿主仍可能造成重复工作。不要部署第二个桥，也不要更换 cursor 路径来绕过
归属检查。桥和插件的初始基线刻意不重放历史事件。在可行时保持运行时对源码只读；JSON 配置与
运行状态放在操作者控制的目录中，并限制其权限。

只读 issue/run/comments 查询在投影字段前，会校验精确的 CEO/公司身份及父资源归属。它们使用
GET，不使用调度器状态，也不回退到匿名访问。凭据仅属于进程环境，绝不放入 JSON 或提示词字符串。
桥的 heartbeat 路径使用同一个配置身份，但它不是 instance-admin 凭据。遵循最小权限原则。

## 回滚

1. 在安装 JSON 中设置 `plugin.enabled=false`，并用
   `HERMES_HOME=<ownerHome> hermes plugins disable tele-injection-plugin` 卸载/禁用插件；
   使用现有管理器重新加载选定的 gateway。JSON 变更会停止轮询；卸载会释放其 owner lock。
2. 通过拥有该桥的管理器停止它。不要删除活 PID lease 或 `.owner.lock` inode。
   exec gate 只会清理已证实进程死亡且未发生变化的 PID lease。
3. 在 Paperclip 管理界面禁用 OMP 外部 adapter，恢复之前的 worker adapter 选择。
   不要将删除私有任务工作区作为回滚步骤。
4. 保留 state 和 cursor 文件。针对原生 run 状态人工核查任何 `uncertain`/`skipped_needs_review`
   投递；绝不自动重发。仅恢复代码不得重置投递历史。只恢复一个已核实的 owner。
5. 将私有运维证据记录在本仓库之外。不要提交真实 ID、快照、消息、凭据或输出采集内容。
