# Documentation index

Status: navigation index — keep current as documents move or change role.
Last updated: 2026-10-03

`docs/` 按角色分目录。文档与代码冲突时以代码与测试为准，并在同一改动里修正失效的一侧。

## 根目录（现状权威）

- [architecture.md](architecture.md) — 系统架构总览与边界（权威）
- [development.md](development.md) — 开发入口、验证命令、knowledge map
- [status.md](status.md) — 项目阶段进度与当前缺口（权威；不记工作日志）
- [roadmap.md](roadmap.md) — 交付路线图与 Phase status 表

## [design/](design/) — 领域设计与契约

Harness 总体与模块专卷：

- [design/agent-harness.md](design/agent-harness.md) — 总边界与文档关系；§5–9 已拆为专卷：
  [harness-tools](design/harness-tools.md)（工具集）、[harness-retrieval](design/harness-retrieval.md)（检索三层；§6.1 增量执行与可选模型补位已接入，真实效果未测）、
  [harness-knowledge](design/harness-knowledge.md)（知识库）、[harness-context](design/harness-context.md)（上下文与缓存）、
  [harness-verification](design/harness-verification.md)（验证与多 agent）
- [design/harness-capability-matrix.md](design/harness-capability-matrix.md) — Harness 能力逐行交付明细（唯一权威）

领域设计（各文件头部 Status 行标注 implemented / design-only / superseded）：

- [design/resource-oriented-harness-design.md](design/resource-oriented-harness-design.md) — HR0–HR5 资源寻址模型（已交付）
- [design/research-cluster-design.md](design/research-cluster-design.md) — AI4S 科研集群（Phase 11）
- [design/rust-kernel-design.md](design/rust-kernel-design.md) — Rust 内核边界
- [design/testing-ci-design.md](design/testing-ci-design.md) — Stage Q 测试与 CI 规范
- [design/web-research-search-design.md](design/web-research-search-design.md) — 阶段 L Web/科研检索
- [design/agent-settings-design.md](design/agent-settings-design.md) / [design/agent-follow-up-design.md](design/agent-follow-up-design.md) — Agent 设置与续接
- [design/context-compaction-agent-design.md](design/context-compaction-agent-design.md) / [design/fast-decision-model-design.md](design/fast-decision-model-design.md) — 压缩 Agent 与快速决策模型；后者§4.4与Explore按职责补位设计同步，既有接线与待改造范围分开
- [design/native-workspace-recovery-design.md](design/native-workspace-recovery-design.md) / [design/recovery.md](design/recovery.md) — 恢复模型
- [design/office-work-continuity-design.md](design/office-work-continuity-design.md) — 阶段 O 办公连续性（设计已接受，未实施）
- [design/bot-operated-workbench-design.md](design/bot-operated-workbench-design.md) — 单 Bot、主动/自动记忆、咨询与缓存的设计依据；BC 部分实现，进度见当前验收
- [design/computer-use-design.md](design/computer-use-design.md) — 共享电脑控制与持久桌面设计；BC 部分实现，不能等同于全部阶段已交付
- [design/execution-environment-design.md](design/execution-environment-design.md) — D-338 可组合执行环境：独立部署、精简镜像、应用接口、跨环境联动与生命周期（设计已确认，增量实现待完成）
- [design/composable-workbench.md](design/composable-workbench.md) — 工作台 profile 与扩展组合
- [design/plugin-gui-design.md](design/plugin-gui-design.md) / [design/varin-extension-platform.md](design/varin-extension-platform.md) — 插件 GUI 与扩展平台
- [design/unified-file-editor-platform.md](design/unified-file-editor-platform.md) — 统一文件编辑器平台
- [design/varin-motion-platform.md](design/varin-motion-platform.md) — 动效平台
- [design/varin-product-experience.md](design/varin-product-experience.md) — 工作台视觉与交互候选（布局重组、排版、状态动效及完整功能对照；待评审，未实施）
- [design/varin-rebrand-design.md](design/varin-rebrand-design.md) — 阶段 B 更名
- [design/extension-compatibility.md](design/extension-compatibility.md) — 扩展兼容边界
- [design/chat-experience.md](design/chat-experience.md) — 聊天体验
- [design/security.md](design/security.md) — 安全模型

## [plan/](plan/) — 实施计划

- [plan/agent-context-preparation-review.md](plan/agent-context-preparation-review.md) — Varin-FC 实测问题复核与七项产品修复、验证边界

- [plan/agent-harness-plan.md](plan/agent-harness-plan.md) — Harness 阶段骨架（锚点稳定；已收口阶段细节在 archive）
- [plan/agent-runtime-reliability-plan.md](plan/agent-runtime-reliability-plan.md) — RR0–RR6（RR6 平台纵切未测）
- [plan/bot-computer-use-plan.md](plan/bot-computer-use-plan.md) — BC0–BC9 实施合同；[深入验收](plan/bot-computer-use-review.md)记录当前 Partial 判断、修复和剩余项
- [plan/rust-kernel-audit.md](plan/rust-kernel-audit.md) — Rust 内核审计（进行中）

## [decisions/](decisions/) — 决策日志

- [decisions/README.md](decisions/README.md) — D-xxx 追加式日志索引与条目格式
- 领域分卷：context-knowledge / foundation-governance / permissions / research-cluster / retrieval /
  runtime-reliability / stage-r-kernel / structure-symbol-graph / tool-environment / workingstate-threads

## [ops/](ops/) — 部署与使用指南

- [ops/cloud-deployment.md](ops/cloud-deployment.md) — 云部署与容器合同
- [ops/REVERSE_PROXY.md](ops/REVERSE_PROXY.md) — 反向代理
- [ops/CUSTOM_THEMES.md](ops/CUSTOM_THEMES.md) — 自定义主题
- [ops/varin-extension-authoring.md](ops/varin-extension-authoring.md) — 扩展作者指南
- [ops/openchamber-pi-migration.md](ops/openchamber-pi-migration.md) — OpenChamber→Pi 迁移合同与能力边界

## [archive/](archive/) — 历史归档（不再更新，与现状冲突时以根目录权威为准）

- [archive/harness-delivery-log.md](archive/harness-delivery-log.md) — 逐阶段交付叙述与 D-xxx 证据（原 status 主体 + RR/HR 叙述）
- [archive/agent-harness-plan-detail.md](archive/agent-harness-plan-detail.md) — 已收口阶段的完整计划细节
- [archive/roadmap-history.md](archive/roadmap-history.md) — Phase 0–10 / Stage Q / D-296 历史明细
- [archive/phase-2-desktop.md](archive/phase-2-desktop.md)、[archive/testing-ci-audit.md](archive/testing-ci-audit.md)、
  [archive/openchamber-upstream-20260813.md](archive/openchamber-upstream-20260813.md)

## [references/](references/) — 图片资源
