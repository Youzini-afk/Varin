# 领域设计与契约

Status: topic index — 设计的实施状态由各文件说明，交付概况见[当前状态](../status.md)。

这里按领域定位契约和设计依据。当前系统的进程图、owner 和请求流从[架构总览](../architecture.md)进入；
不需要为了修改一个模块把所有设计从头读一遍。

## Harness 与 Agent

| 主题 | 文档 |
| --- | --- |
| 总体边界、工作侧重与专卷关系 | [Agent Harness](agent-harness.md) |
| 自有运行核心、性能与完整 Pi 替代 | [Varin 原生 Agent 运行时](native-agent-runtime-design.md)（设计草案，未实施） |
| 原生能力组合、Agent 策略与扩展生命周期 | [原生运行时扩展设计](native-runtime-extensibility-design.md)（设计草案，未实施） |
| 工具参数、执行与反馈 | [工具](harness-tools.md) |
| 源码检索、结构和语义来源 | [检索](harness-retrieval.md)、[快速决策](fast-decision-model-design.md) |
| Web、论文与材料复用 | [Web 与科研检索](web-research-search-design.md) |
| Agent 笔记、Bot 知识与上下文 | [记忆归属](../../packages/web/application-host/lib/memory/DOCUMENTATION.md)、[知识库](harness-knowledge.md)、[上下文](harness-context.md)、[压缩 Agent](context-compaction-agent-design.md) |
| 常规多 Agent 的角色、通信和代码协作 | [协作设计](agent-collaboration-design.md)；[验证专卷](harness-verification.md)保留基础验证与工作状态合同 |
| 对话设置和会话等待 | [设置](agent-settings-design.md)、[续接](agent-follow-up-design.md) |

## 状态、资源与执行环境

| 主题 | 文档 |
| --- | --- |
| 任务 scope、cwd、资源根与索引 | [任务/资源模型](resource-oriented-harness-design.md) |
| Rust 系统内核与 Host 分工 | [Rust 内核](rust-kernel-design.md) |
| 文件与会话恢复 | [原生恢复](native-workspace-recovery-design.md)；实际操作见[恢复指南](../ops/recovery.md) |
| 科研分支、实验与资源目标 | [科研集群](research-cluster-design.md) |
| Bot 长期工作和 Computer Use | [Bot 工作台](bot-operated-workbench-design.md)、[电脑控制](computer-use-design.md) |
| 前端、Harness、工作环境与电脑的位置组合 | [执行环境](execution-environment-design.md)；实际缺口见[验收](../reviews/execution-environments.md) |
| 材料到可编辑成果、日常工作续接 | [办公连续性](office-work-continuity-design.md)（已接受，未实施） |

## 工作台、UI 与扩展

| 主题 | 文档 |
| --- | --- |
| Shell、Profile 和共享工作台 | [可组合工作台](composable-workbench.md) |
| 文件和编辑器权威 | [统一编辑器](unified-file-editor-platform.md) |
| 会话呈现 | [聊天体验](chat-experience.md) |
| Pi 扩展的图形适配 | [插件 GUI](plugin-gui-design.md)、[维护中的集成契约](extension-compatibility.md) |
| Varin 扩展的 Host/Surface 能力 | [扩展平台](varin-extension-platform.md)、[编写指南](../ops/varin-extension-authoring.md) |
| 动效和布局方向 | [动效平台](varin-motion-platform.md)、[工作台体验候选](varin-product-experience.md)（候选不是产品现状） |
| 产品命名的历史决定 | [Varin 更名](varin-rebrand-design.md) |

## 工程边界

[安全模型](security.md)解释信任和资源边界，[测试与 CI](testing-ci-design.md)解释验证责任。
逐能力的实现与证据已从设计目录移至[能力明细](../reviews/harness-capabilities.md)。
