# 完整重建：范围与验收台账

**当前结论：已补齐本轮识别的现役源码交付缺口，隔离安装／本地组合通过；新真实目标验收仍待授权与执行。** 这不是生产全栈已重建或原故障已全部修复的声明。源码与文档版本以本文件所在 Git 提交为准，远端 CI 以该精确提交的 Actions 结果为准。

使用入口：[中文重建指南](REBUILD.zh-CN.md) · [English runbook](REBUILD.md)。

## 目标与不可变边界

从干净检出及公开固定来源开始，补目标环境配置和外部凭据后，能够装配已交付的集成能力，不依赖作者的私有 helper、缓存、相邻 checkout、未登记的 node_modules 手改或私人历史证据。

重建软件和接线，不克隆真实身份、任务、消息、凭据、cursor、锁、UNKNOWN 意图或旧运行状态。第三方宿主作为明确前置条件，不必整套 vendoring；来源、版本、兼容范围及安装／验收方式须可查。

源码发布不授权现役服务替换／重启、组织迁移、权限扩张、真实模型费用或消息发送。Paperclip 仍是唯一任务／依赖／运行 owner；不新增调度器、全局 Map 补丁或常驻监督团队。生产升级与干净目标重建分开验收。

## 源码交付清点

- **已纳入**：事件桥、精确路由注入插件、CEO CLI 及共享配置入口、版本绑定的三文件 CEO 生命周期补丁、`omp_local` 与 `omp_native_json_local` 两种明确不同的适配器，以及分段 QA／原生激活／正式报告发布入口。
- **外部固定来源**：Paperclip server/shared/SDK `2026.1005.0`；补丁记录公开 tarball integrity 与六文件 hash。Node、Python、OMP 和满足契约的 Hermes 作为显式宿主前置条件，见指南。
- **不分发**：真实配置／凭据、源组织资源及运行状态、provider 捕获、旧接受记录、原机依赖树。开发日志与 RED/GREEN 证据不充当新检出的输入。
- **非当前主线**：恢复读取、workspace 引用、wake 参数与过期前 dispatch 门等此前隔离候选，不混称已部署或本轮主线已采用。当前 CEO CLI 以已交付基线为源。通用 checkpoint／任意超时恢复仍未实现；不以分段 QA 冒充。

## 关键实现决定

1. 保留两种 OMP 契约，不用薄适配器静默替换现役 rich 能力。rich 的安装入口必须能被真实宿主无参 factory 加载，命令来自可信安装配置，任务不能指定 command。
2. `host.paperclipServerRoot` 指向真实 server 包。按 ESM 条件解析实际 host consumer 使用的 SDK，核验版本、canonical URL 和 map/runner 实际身份；注入 host runner，缺失或不兼容拒绝，不回退局部 SDK。
3. CEO 权限补丁整体包含 `routes/agents.js`、`services/recovery/service.js`、`services/acknowledged-native-stop.js`，并核验 authz/authorization/heartbeat 依赖。保留目标范围 configure grant、pending-hire 拒绝、真实审计和 native-stop receipt，不提供 role-only fallback。
4. 原生 QA 使用可信计划；全图 fresh backlog 不得带未知 overrides。报告单次 PUT 后精确 GET，再 finish；预期 issue 固定进入再次 native 校验。未知／部分效果保留 intent，不重试、不自动回滚，不手动 heartbeat。
5. 根 npm workspace／lockfile 是统一安装入口。setup 只生成／预览接线脚本，实际注册、资源准入、服务启动由目标权限主体显式完成，不能把 preview 当全栈安装器。

## 已取得的证据

- CEO 切片：`b606f86a94990dbfb354f9c29f5adfe2ff71d644`；双平台 CI `39895592638` 各 167 项。
- 权限补丁切片：`aa2b5788c131479517be1f25e651e44002080423`；双平台 CI `39898379417` 各 183 项；另有父方公开源码 host tier 41 项。
- 原生 QA 切片：`1d5cb378f58768a2cddde45438ab604fb04df491`；双平台 CI `39900254413` 各 206 项。这些是历史切片计数，不是最终总数。
- rich 最后修订独立规格及质量通过；239 默认、3 项真实宿主 primitive 验证通过。真实 synthetic Node 子进程通过 actual entry→factory→core→host SDK 注册，被宿主 stop primitive 终止并清空 map。不是完整 heartbeat API／DB 或真实 OMP 取消验收。
- 最终隔离干净快照使用新 HOME、无原机依赖、含空格目录：安装与根测试 **447 项通过**，35 模块语法、示例配置、setup 预览／仅生成及 shell 语法检查通过。没有执行部署脚本。
- QA 当前默认 **58 项**、显式 SDK host **61 项**。组合测试实际运行参考产品 **23 项**，核对单次 admission、正式文档读回先于 finish、重复调用无新增 HTTP。host 计数包含默认层，不与根测试简单相加。
- 含空格演练发现 A09 夹具把绝对路径写为不支持的裸空格 Markdown 目标。已用 angle destination 修正夹具并保留越界断言；新增回归同时保证产品仍拒绝裸空格。扫描器及原部署源未修改。
- 公共 server 基线与补丁重放一致，完整 MIT 版权／许可来源已保留。npm 包无 gitHead，许可证来源 commit 不冒充 npm 构建 commit。

## 原验收条件逐项状态

1. **干净安装／默认测试与依赖闭包**：隔离快照已通过；最终远端精确提交 CI 另核对。
2. **目标配置校验与归属**：schema、路径与合成身份／状态归属回归通过；真实目标取值与 owner 仍须现场核验。
3. **实际执行适配器安装／注册／加载**：产品闭包、真实宿主 factory 及 runner/registry primitive 已验证；真实目标 REST 注册及 live cancel 待执行，未以另一适配器代测。
4. **CEO CLI 文档入口与边界**：共享配置、native 身份、精确读回和未知效果拒绝回归通过；不替代新目标真实授权检查。
5. **必要宿主补丁可还原且漂移拒绝**：公开包及全部六 hash、精确重放、应用器离线与源码 host tier 通过；非原子多文件写的限制保留，不做整文件旧版回滚。
6. **预览零运行副作用与 owner 门**：生成／预览和已有目标拒绝已测试；真实启用仍须核对活跃 writer 退出及精确权限主体，不自动修改现役安装。
7. **参数化分段 QA 与交付**：真实本地机器执行＋合成 API 组合通过；新目标的原生依赖调度／正式报告持久化仍待真实验收。
8. **Telegram 消费和用户可见交付**：新目标未验证；内部注入、API accepted、run 终态不能替代。
9. **发布隐私与凭据**：仅发布产品白名单及明确合成 fixture；最终 diff／索引扫描与远端读回为发布门，私人证据不入库。
10. **README 与实际执行一致**：上述本地命令已实跑；文档明确区分离线、宿主 primitive 与真实系统，不以旧部署成功替代新目标。

原计划没有因拆层而取消真实验收项。当前可接受的是源码／安装／本地组合层，不能勾选整体生产重建通过。目标启用需要额外明确的环境、身份和副作用授权；保留原事故 issue 中尚未满足的广泛恢复、通知及交付标准。

## 收口与维护

小黄为唯一整合／Git writer 与最终验收者。模块按冻结产物完成规格及质量独审，新增整合／夹具修正由最终整合审查核对；源变更、失败和未决风险才触发复跑。临时执行者完成后退出，不建立永久治理角色。

保留未知效果、Board 对账与人工审批边界。第三方升级需重新核验固定源和 ABI，不刷新 hash 绕门；不把候选、安装、运行成功和业务交付混为一谈。
