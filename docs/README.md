# Varin 文档

## 从这里开始

| 要解决的问题 | 入口 | 这里负责什么 |
| --- | --- | --- |
| 安装、启动和使用 Varin | [项目 README](../README.md)、[用户文档源](../packages/docs/README.md) | 产品使用；用户站以英文原文维护多语言内容 |
| 理解系统如何运行 | [架构总览](architecture.md) | 进程、状态归属、请求流和信任边界 |
| 修改代码或选择验证方式 | [开发指南](development.md) | 开发环境、代码入口、构建与测试 |
| 确认已实现什么、还缺什么 | [当前状态](status.md) | 跨主题的交付概况与未完成边界 |
| 看接下来的工作方向 | [路线图](roadmap.md)、[实施计划](plan/README.md) | 后续范围、依赖与具体执行入口 |
| 理解某个领域的契约和取舍 | [设计目录](design/README.md) | 工具、上下文、协作、工作台、恢复和执行环境 |
| 查某次判断由什么验证支撑 | [验收与证据](reviews/README.md) | 基线、覆盖场景、结果与尚未验证的环境 |
| 部署、运维或维护依赖 | [操作指南](ops/README.md) | 配置和操作步骤，不承担实现进度台账 |
| 查为什么曾经这样决定 | [决策日志](decisions/README.md)、[历史归档](archive/README.md) | 决策原因、已结束阶段与当时的验证记录 |
| 定位性能证据 | [性能说明](performance.md) | 关键路径、测量方法与保留数据 |

## 按领域找实现

开发时先读实际 owner 附近的 `README.md` / `DOCUMENTATION.md`，再按需进入设计。
这些模块文档保留在源码旁，不复制到 `docs/` 再维护一份。

| 领域 | 实现入口 | 设计入口 |
| --- | --- | --- |
| Pi 会话、工具、模型输入 | [Pi harness](../packages/pi-host/src/harness/README.md) | [Harness 总边界](design/agent-harness.md) |
| Thread、Run、协作与工作状态 | [Host harness](../packages/web/application-host/lib/harness/DOCUMENTATION.md) | [协作](design/agent-collaboration-design.md)、[任务与资源](design/resource-oriented-harness-design.md) |
| 文件、草稿和编辑器 | [Host Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md)、[客户端 Registry](../packages/ui/src/lib/documents/DOCUMENTATION.md) | [统一编辑器](design/unified-file-editor-platform.md) |
| Rust、恢复和进程 | [Kernel](../kernel/README.md)、[Recovery](../packages/web/application-host/lib/recovery/DOCUMENTATION.md)、[Terminal](../packages/web/application-host/lib/terminal/DOCUMENTATION.md) | [Rust 边界](design/rust-kernel-design.md)、[原生恢复](design/native-workspace-recovery-design.md) |
| 检索、知识与记忆 | [Search](../packages/web/application-host/lib/search/DOCUMENTATION.md)、[Knowledge](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)、[Memory](../packages/web/application-host/lib/memory/DOCUMENTATION.md) | [检索](design/harness-retrieval.md)、[上下文](design/harness-context.md) |
| 工作台与扩展 | [UI](../packages/ui/DOCUMENTATION.md)、[扩展 Host](../packages/extension-host/README.md)、[内置扩展](../packages/extension-builtins/README.md) | [工作台](design/composable-workbench.md)、[扩展平台](design/varin-extension-platform.md) |
| 客户端与跨进程 API | [Application client](../packages/application-client/README.md)、[Protocol](../packages/protocol/README.md) | [架构与信任边界](architecture.md#protocol-trust-and-failures) |
| 桌面、远端和 Computer Use | [Electron](../packages/electron/README.md)、[连接](../packages/web/application-host/lib/connections/README.md)、[电脑驱动](../packages/computer-driver/README.md) | [Computer Use](design/computer-use-design.md)、[执行环境](design/execution-environment-design.md) |

## 信息放在哪里

`architecture.md` 解释当前系统，`design/` 解释领域契约，`plan/` 记录尚需执行的工作，
`reviews/` 记录验证依据，`archive/` 保存已经结束或被替代的材料。
`status.md` 汇总当前边界，`roadmap.md` 只列后续方向；它们引用依据，不重复复制交付日志。
`decisions/` 保存当时的理由，决策中的“已实施”不等于今天所有环境均可用。

代码、类型、schema、测试和 `package.json` 脚本定义可执行行为。文档说明与之不符时，
核对实际调用链和后续变更，在责任文档中修正；没有重新验证的历史结果保留原基线。
说明功能时区分当前契约、部分实现的目标和候选方案；状态以实现与验证依据为准。

同一事实在所属模块或领域文档中维护，其他入口链接引用。先修正失效正文，不在旧说法后面
不断追加更正。结束的计划移入归档，仍然有效的契约留在设计或模块文档中。
移动文档时更新仓库内引用及章节链接，历史正文只做引用修复，不改写当时判断。
本地可运行 `bun run docs:check` 检查工程文档中的实际路径；`bun run docs:validate` 同时检查
用户页面、侧栏目标和工程链接。`bun run test:docs` 只验证检查器行为，不重复扫描仓库。
检查器不强制状态行、目录组织或翻译覆盖；内容、章节链接和历史结论仍需人工核验。

`references/` 存放文档图片；候选界面图随其设计说明解释，不代表已经应用到产品。
