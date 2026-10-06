# Harness 工作与阶段导航

Status: work map — 当前工作入口与历史阶段索引，不是逐阶段再次执行的指令。
Last updated: 2026-10-06

[当前状态](../status.md)负责交付概况，[路线图](../roadmap.md)负责后续方向。
本页连接仍有效的领域合同与原实施分解，不再重复架构、验证规章和已结束的阶段流水账。
原 978 行计划保留为[带基线的历史快照](../archive/agent-harness-plan-2026-10-06.md)，
更早的完整阶段合同仍在[计划明细归档](../archive/agent-harness-plan-detail.md)。

## 当前工作入口

| 工作范围 | 合同或计划 | 当前缺口与证据 |
| --- | --- | --- |
| 可组合执行环境 | [环境设计](../design/execution-environment-design.md) | [EE 验收](../reviews/execution-environments.md) |
| Bot / Computer Use / 持久电脑 | [BC 计划](bot-computer-use-plan.md) | [BC 验收](../reviews/bot-computer-use.md) |
| 科研执行与资源管理剩余项 | [科研设计](../design/research-cluster-design.md) | [当前状态](../status.md#平台组件与研究资源管理)；原分解见下表阶段 7 |
| 运行时平台纵切 | [RR 计划](agent-runtime-reliability-plan.md) | RR6；旧 RR2/RR4 已被 HR 任务/资源模型替代 |
| 办公连续性 | [O0–O4 设计](../design/office-work-continuity-design.md) | 尚未实施，与既有浏览器/办公桥分开 |

具体推进从对应主题的未完成合同开始。已结束阶段不会因为旧计划里还有任务式语气就重新进入工作队列。
新的运行结果写入对应验收记录，修改当前行为则回写设计或源码旁文档。

## 阶段索引

此表解释编号并定位材料，不维护第二套完成状态。

| 编号 | 主题 | 契约入口 | 历史实施入口 |
| --- | --- | --- | --- |
| 0 / 1 / 1b / P0 | 基础、工具、Web 和可信身份 | [Harness](../design/agent-harness.md)、[工具](../design/harness-tools.md) | [早期计划](../archive/agent-harness-plan-detail.md) |
| 2 / 2.4 / 2.6 | 知识、上下文准备和按需压缩 | [知识](../design/harness-knowledge.md)、[上下文](../design/harness-context.md) | [阶段快照](../archive/agent-harness-plan-2026-10-06.md#阶段-2上下文与知识) |
| 3 / 3.18A–E | 检索、工作状态、任务线程 | [检索](../design/harness-retrieval.md)、[协作](../design/agent-collaboration-design.md) | [阶段快照](../archive/agent-harness-plan-2026-10-06.md#阶段-3检索工作状态与线程) |
| 3b | 原生权限边界 | [安全](../design/security.md) | [早期计划](../archive/agent-harness-plan-detail.md) |
| R | Rust 系统内核 R0–R6 | [Rust 设计](../design/rust-kernel-design.md) | [D-278/D-279 审计](../archive/rust-kernel-audit.md)、[内核决策](../decisions/stage-r-kernel.md) |
| Q | 测试与 CI | [测试设计](../design/testing-ci-design.md) | [审计与后续清理](../archive/testing-ci-audit.md) |
| D-296 | 退役 VS Code companion | [当前架构](../architecture.md) | [路线历史](../archive/roadmap-history.md) |
| 7（路线图 Phase 11） | AI4S 7A–7I | [科研设计](../design/research-cluster-design.md) | [阶段 7 分解](../archive/agent-harness-plan-2026-10-06.md#阶段-7ai4s-科研集群d-291d-297d-300分阶段实施) |
| S / W | 对话设置与会话续接 | [设置](../design/agent-settings-design.md)、[续接](../design/agent-follow-up-design.md) | [交付记录](../archive/harness-delivery-log.md) |
| B | Varin 更名 | [命名决定](../design/varin-rebrand-design.md) | [交付记录](../archive/harness-delivery-log.md) |
| F / L | 快速决策、Web 与科研检索 | [快速决策](../design/fast-decision-model-design.md)、[Web/科研](../design/web-research-search-design.md) | [阶段快照](../archive/agent-harness-plan-2026-10-06.md) |
| C / N | 压缩 Agent、下一步选择 | [压缩](../design/context-compaction-agent-design.md)、[会话自动化](../../packages/web/application-host/lib/pi-session-automation/DOCUMENTATION.md) | [阶段快照](../archive/agent-harness-plan-2026-10-06.md) |
| HR / D-337 | 任务、资源与持续检索 | [资源模型](../design/resource-oriented-harness-design.md) | [能力明细](../reviews/harness-capabilities.md) |
| D-339 | 综合主线、Worker、通信与选定代码提交 | [协作设计](../design/agent-collaboration-design.md) | 同文档的实施与验证节 |

## 找旧章节

旧链接中的 S0–S4、W0–W4、7.11 等章节已指向历史快照，原有标题和编号保留。
它们用于理解当时的拆解；今天的工具集合、预设、权限与资源模型以当前领域合同及实现为准。
普通开发方式和命令只在[开发指南](../development.md)与包脚本维护。
