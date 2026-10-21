# Paperclip × Hermes integration

让 Paperclip 的任务变化进入明确绑定的 Hermes 会话，让 OMP worker 保留原生执行与模型校验——不另建调度系统。

**[Quick Start](#quick-start) · [让 AI 帮你配置](#让-ai-帮你配置) · [配置与部署](docs/DEPLOYMENT.md) · [兼容性与回滚](docs/COMPATIBILITY.md)**

> English: A portable metadata bridge, sender-scoped Hermes injection plugin and native
> OMP adapter. One nonsecret JSON configuration; synthetic offline tests by default.
> This is an integration candidate, not a production deployment or delivery guarantee.

## 能做什么

- **元信息事件桥**：WebSocket 提示 + 分页 GET 对账，合并事件后唤醒 Paperclip 原生 CEO heartbeat。
- **精确会话注入**：群聊保留 sender 隔离，conversation/topic 的 `/new` 不导致历史重放。
- **原生 OMP worker**：逐任务模型覆盖，核验输出的实际 provider/model，处理取消、超时与输出脱敏。
- **可独立复现**：固定 SDK 与 lockfile；默认测试不依赖作者的 Hermes、OMP、私有 capture 或凭据。

初次运行建立基线；不重放旧事件。`uncertain` 不自动重试。
`accepted`、CEO 终态、health ready **都不等于模型已消费或用户已收到**。

## Quick Start

需要 **Node >=24.11.0、npm、Python 3.9+、macOS/Linux**。只安装公开 npm 依赖，随后离线测试：

```sh
git clone https://github.com/Loveacup/paperclip-hermes-integration.git
cd paperclip-hermes-integration
npm ci
npm test
npm run config:check -- integration.example.json
```

成功判据：安装退出 0；测试全部通过、没有 skip；最后显示 `Configuration valid`。
这些命令不部署服务、不启动真实 OMP/模型、不发送消息。仓库当前按 PRIVATE 准备，克隆需有访问权限；公开需另行决定。

## 让 AI 帮你配置

**准备配置、修改路径/目标会话或排查配置失败时，先让 AI 读取 [AI_SETUP.md](docs/AI_SETUP.md)。**
复制以下提示词到你信任的本地 AI 助手：

```text
请帮我配置这个仓库。先完整阅读 docs/AI_SETUP.md、config.schema.json、
integration.example.json 和相关实现；按指南检查依赖与现状。
先只做离线准备与校验，为每个实际字段列出来源、类型、合成示例和是否必填；
缺少真实身份、路径或精确会话路由时停下询问，不能猜默认值。
密钥只引用环境变量，不向我索取明文、不读取或打印凭据。
在我明确批准激活前，不覆盖现网插件、不改服务或全局隔离、不重放事件、不发送消息。
最后报告实际运行的命令、结果和未验证边界；测试通过不代表线上闭环。
```

## 配置入口

```sh
cp integration.example.json integration.local.json
# 编辑这个 JSON；真实身份/路由须从目标环境核实，示例均为 synthetic
npm run config:check -- integration.local.json
npm run setup -- integration.local.json             # 预览，不改宿主
npm run setup -- integration.local.json --apply     # 仅生成 .local/deploy.sh，仍不执行
```

唯一非秘密配置入口是这份 JSON；类型与必填规则以 [schema](config.schema.json) 为准。
密钥仅通过 `authEnv` 引用环境变量。相对路径以 JSON 所在目录解析；本地配置和状态不入 Git。
Hermes 只保存 `config_path` 指针；Paperclip server 通过安装环境中的
`PAPERCLIP_INTEGRATION_CONFIG` 找到它。**实际部署步骤与权限边界见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)**。

## 结构与支持边界

```text
Paperclip 状态 → 元信息桥 → 原生 CEO heartbeat
                     └→ 精确绑定的 Hermes Telegram 会话
Paperclip 调度 → OMP adapter → 本地 OMP worker
```

Paperclip 负责权限与调度；Hermes 负责选定会话的交互；本仓库只连接边界，不替代两者。

```text
event-bridge/            元信息对账、认证只读入口、服务 ownership、health
tele-injection-plugin/   owner-scoped 配置、精确路由、持久 cursor
omp-adapter/            native JSON worker adapter、synthetic fixtures
scripts/                共享配置校验、离线/宿主测试、部署预览
```

| 边界 | 当前支持/限制 |
|---|---|
| Paperclip SDK / Hermes adapter | 固定 **2026.1005.0**；内部 `buildPrompt` 导出显式校验，不兼容失败 |
| Hermes | 使用官方注入/生命周期接口及精确 routing 元信息；须对目标安装运行宿主契约测试，不承诺任意版本 |
| OMP | 默认只测 synthetic JSON 协议；安装级 command，任务仅能覆盖 model 等受限字段；真实安装探针单独运行 |
| 平台 | POSIX ownership locks；macOS/Linux 候选，health 的 launchd 检查仅 macOS；离线 CI 状态见对应提交的 [Actions 结果](https://github.com/Loveacup/paperclip-hermes-integration/actions) |
| 安全 | 工具 permission 不是 OS 沙箱；注入没有原子 session-id fence；只读查询校验 CEO/company 归属 |

显式宿主检查（不是 Quick Start 的一部分）：

```sh
npm run test:host -- integration.local.json
npm run test:server -- integration.local.json
npm run test:installed-omp -- integration.local.json
```

缺失宿主就失败，不静默 skip。最后一项会真正启动 OMP，但使用隔离 HOME 与离线 synthetic provider。
候选尚未验证真实部署、远端权限、模型执行、Telegram 投递或消费闭环；完整边界与回滚见
[COMPATIBILITY.md](docs/COMPATIBILITY.md)。

## 按需深入

| 你要做什么 | 入口 |
|---|---|
| 让 AI 收集参数、区分准备与激活 | [AI_SETUP.md](docs/AI_SETUP.md) |
| 修改配置、安装目标插件、注册 adapter | [DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| 判断兼容性、验收范围、故障回退 | [COMPATIBILITY.md](docs/COMPATIBILITY.md) |
| 修改实现并提交可复现回归 | [CONTRIBUTING.md](CONTRIBUTING.md) |

## 贡献与许可

欢迎小范围、带回归测试的改动：[贡献指南](CONTRIBUTING.md)。提交前运行 Quick Start 验证，
不要提交本地 JSON、真实 IDs、凭据、cursor、会话或业务日志。更新 SDK/宿主接口时明确说明契约变化。

本项目代码使用 **[MIT](LICENSE)**；依赖与宿主保留各自许可，来源见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
