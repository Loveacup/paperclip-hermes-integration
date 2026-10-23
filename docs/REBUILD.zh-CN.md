# 从干净检出重建集成

[English](REBUILD.md) · [部署指南](DEPLOYMENT.zh-CN.md) · [验收台账](REBUILD-PLAN.zh-CN.md)

本指南从固定公开来源恢复集成的软件和接线，不复制原组织的身份、任务、消息、凭据、cursor 或未知写意图。干净安装、本地组合与真实目标验收分别报告。

## 1. 复现仓库

```sh
git clone https://github.com/Loveacup/paperclip-hermes-integration.git
cd paperclip-hermes-integration
npm ci
npm test
npm run config:check -- integration.example.json
npm run setup -- integration.example.json
```

根 npm workspace 和根 lockfile 一起安装 rich 适配器依赖，不需要作者的 node_modules、缓存或相邻 checkout。默认测试只用合成／本地输入；setup 仅预览可审阅脚本，不安装或启动全栈。记录验收时固定仓库提交，再执行同一流程。

仓库已包含的产品边界：

- `event-bridge/`：目标绑定的事件对账、认证读取、owner lock 与健康检查。
- `tele-injection-plugin/`：owner 作用域配置及精确发送者／会话路由。
- `ceo-control/` 和 `scripts/ceo.mjs`：使用共享配置的认证管理，不自动授权或绕过对账。
- `server-patch/`：固定基线 CEO 生命周期补丁，显式 root、默认只检查，保留原授权和未知效果保护。
- `omp-local-adapter/`：rich `omp_local`，安装时绑定实际宿主 SDK runner／登记表。
- `omp-adapter/`：另一种 `omp_native_json_local` 协议与权限契约，不是前者的可互换别名。
- `segmented-qa/`：冻结单次执行 QA，以及可信计划驱动的激活和正式报告发布。

## 2. 明确提供宿主前置条件

- 支持的 POSIX 目标，Node **24.11.0+**、npm、Python **3.9+**。
- 公开 Paperclip server/shared/adapter SDK **2026.1005.0** 及所选安装的完整依赖。补丁包固定 tarball 完整性和六个源文件哈希，见 `server-patch/source-baseline.json`。
- 满足文档中注入与路由契约的 Hermes 安装，并使用下方 host 检查核验实际目标。本仓库不承诺任意 Hermes 版本，也不内置其核心源码。
- 操作者安装的 OMP 及独立保护的 provider 配置。`omp.command` 属安装权限，不接受任务替换。本机仅版本查询观察到 `omp/18.12.5`，不能据此宣布重建适配器已完成真实执行兼容验收。rich 适配器保留已审查的原生 JSON／deadline／skills 契约，真实启用前核对所选 CLI。

若需要 CEO pause/terminate/cancel 能力，从精确公开 pristine 包按[补丁说明（英文）](../server-patch/README.md)准备，保留上游许可。全部哈希通过后，仅对明确选定的离线副本应用；不刷新哈希来接受未知版本。启动或替换现役服务另需针对性授权；目标仍须有合法 configure grant 并遵守人工审批。

## 3. 配置新目标，而不是复制旧状态

```sh
cp integration.example.json integration.local.json
npm run config:check -- integration.local.json
npm run setup -- integration.local.json
```

用目标环境核实的元信息替换合成值。JSON 不放凭据，只由 `authEnv` 引用受保护环境变量。真正新目标选择新的 state/cursor 目录，不导入旧 pending／UNKNOWN；更新既有目标则先由其当前 owner 停写并释放范围。

rich OMP 的 `host.paperclipServerRoot` 必须指向**实际 server 包目录，内含 package.json 与 dist**，不能是外层 checkout 或另一个同版本实例。把 `PAPERCLIP_INTEGRATION_CONFIG` 放在服务端可信启动环境。使用普通未打包 Node ESM，不使用 loader/preload/custom-condition／保留 symlink 的覆盖模式。安装入口核对宿主导入链、SDK 版本与 canonical 解析及实际 consumer map 身份；缺失／不兼容拒绝，不回退本地 SDK。不得用全局 Map monkeypatch 或第二监督器掩盖错误绑定。

## 4. 显式验证宿主层

```sh
npm run test:host -- integration.local.json
npm run test:server -- integration.local.json
npm run test:omp-local -- --host /absolute/actual/node_modules/@paperclipai/server
npm run test:segmented-qa -- --paperclip-packages /absolute/actual/node_modules/@paperclipai
```

前置缺失明确失败，不静默跳过。rich host tier 使用测试拥有的合成 Node 子进程和真实宿主登记表／停止 primitive，不是实际 OMP／模型或 heartbeat API。QA host tier 使用真实 SDK factory 与合成 loopback 端点。补丁另有 41 项公开源码 AST／VM 层，按其说明安装固定 parser。这些都不能替代 DB、provider、消息投递或生产取消验收。

旧的 `npm run test:installed-omp -- integration.local.json` 是另一项 opt-in：它确实会启动 OMP，但使用隔离 HOME 和离线合成 provider；不要称为静态或零执行检查。

## 5. 取得目标授权后装配

按[部署指南](DEPLOYMENT.zh-CN.md)安装插件 symlink、调用官方 enable/config 入口、注册适配器、配置 CEO wake 模板及桥服务 argv。保持完整仓库布局，适配器入口会共享根配置加载器。

rich 适配器通过同一固定宿主的管理员 adapter-install 入口安装本地 `$PWD/omp-local-adapter`，worker 选择 **`omp_local`**；薄适配器 `$PWD/omp-adapter` 对应 **`omp_native_json_local`**。不静默切换原 worker 的执行契约。安装需要真实实例权限，不能冒用 CEO／Board 凭据。

通过目标的正常管理流程准入 CEO／worker 与所需 grant。分段 QA 使用专用、无模型的 `process` actor，组织管理权限关闭、周期 heartbeat 关闭，但允许原生需求／依赖执行。创建项目、真实 CEO 协调任务及三个未分配的 fresh backlog phase issue。把实际返回 ID 写入[原生工作流计划（英文）](../segmented-qa/NATIVE-WORKFLOW.md)。不能代批 pending hire、借终态 run ID 或清除 intent 来强行通过。

原生工作流已提供准备、逆序激活和正式文档发布，但不自动创建／审批这些资源，也不手动 invoke heartbeat。plan 操作纯生成；activate/prepare/publish --execute 仅在对应真实活跃 native 上下文内运行。未知或部分写入停止对账，不重放。

## 6. 如实记录目标验收

真实重建只有在以下目标效果得到核验后才可接受：

1. 精确注册入口、宿主包和干净 bootstrap 已确认，无冲突 writer。
2. 有界真实 native task 完成；获准的实际 cancel/stop 路径也核对完毕。run 终态不替代进程退出证据。
3. QA 依赖原生接续，机器只运行一次，正式文档精确读回先于 closeout 完成。
4. 精确目标 Hermes 会话实际消费事件，用户可见的平台投递另行确认。
5. 凭据、状态和未知效果仍由该目标拥有，不依赖第二调度器或作者机器的隐藏 helper。

没有这些已授权的真实检查时，结论应为**源码／安装／本地组合已验证，真实目标验收待完成**，不能称生产全栈重建通过。原事故的其他恢复缺口与源码打包分开。发布源码不自动授权服务替换、权限扩张、模型费用或真实消息发送。
