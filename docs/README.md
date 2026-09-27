# Documentation index

Status: navigation index — keep current as documents move or change role.
Last updated: 2026-09-27

本目录文档分四类。**现状权威**描述当前实现并以测试/代码为证；**专题设计**描述单一领域的契约，
状态见各文件头部 Status 行；**决策日志**为追加式决策记录；**历史归档**保留交付叙述与被取代的设计，
不再更新。文档与代码冲突时以代码与测试为准，并在同一改动里修正失效的一侧。

## 现状权威（读这些了解"现在是什么"）

- [architecture.md](architecture.md) — 系统架构总览与边界（权威）
- [development.md](development.md) — 开发入口、验证命令、文档目录（权威）
- [agent-harness-status.md](agent-harness-status.md) — Harness 能力状态矩阵与当前缺口（权威，表格为准）
- [agent-harness-plan.md](agent-harness-plan.md) — Harness 实施计划骨架与在途阶段（锚点稳定）
- [agent-harness-decisions.md](agent-harness-decisions.md) — D-xxx 决策日志（追加式）
- [decisions/](decisions/) — 专题决策备忘（harness-tools、documents、retrieval、working-state、test-suite）
- [docs-review-log.md](docs-review-log.md) — 文档审计轮换日志

## 专题设计（状态见各文件 Status 行）

- [agent-harness.md](agent-harness.md) — Harness 总体设计原文（契约仍部分现役；实现细节以 status 为准）
- [research-cluster-design.md](research-cluster-design.md) — AI4S 科研集群（Phase 11）
- [resource-oriented-harness-design.md](resource-oriented-harness-design.md) — HR0–HR5 资源寻址模型（已交付）
- [recovery.md](recovery.md) / [recovery-runtime-authority.md](recovery-runtime-authority.md) — 恢复模型与运行时权威
- [session-model.md](session-model.md) — 会话生命周期模型
- [plugin-gui-design.md](plugin-gui-design.md) / [varin-extension-platform.md](varin-extension-platform.md) — 插件 GUI 与扩展平台
- [agent-follow-up-design.md](agent-follow-up-design.md) / [agent-settings-design.md](agent-settings-design.md) — Agent 续接与设置
- [rust-kernel-design.md](rust-kernel-design.md) / [kernel-crates-ownership.md](kernel-crates-ownership.md) — Rust 内核与 crate 归属
- [testing-ci-design.md](testing-ci-design.md) — Stage Q 测试与 CI 规范
- [web-research-search-design.md](web-research-search-design.md) — 阶段 L Web/科研检索
- [task-division-tree.md](task-division-tree.md) — 线程分治树（实验性，见文件状态）
- [memory-kernel-design.md](memory-kernel-design.md) — 记忆内核设计（探索）
- [quick-decision-model-evaluation-plan.md](quick-decision-model-evaluation-plan.md) — 快速决策模型评测计划
- [research-agent-bootstrap.md](research-agent-bootstrap.md) — 阶段 W 研究 Agent 引导（设计）
- [technology.md](technology.md) / [packaging.md](packaging.md) / [linux-packaging.md](linux-packaging.md) — 技术选型与打包
- [unified-file-editor-platform.md](unified-file-editor-platform.md) — 统一文件编辑器平台（设计）
- [multi-ai-collaboration.md](multi-ai-collaboration.md) — 多 Agent 协作设计
- [openchamber-pi-migration.md](openchamber-pi-migration.md) / [pi-model-capability-catalog.md](pi-model-capability-catalog.md) — Pi 迁移与模型能力
- [rust-kernel-audit.md](rust-kernel-audit.md) — Rust 内核审计（进行中）
- [windows-local-ai-setup.md](windows-local-ai-setup.md) — Windows 本地 AI 环境

## 过程文档

- [roadmap.md](roadmap.md) — 交付路线图与 Phase status 表
- [merge-log.md](merge-log.md) / [upstream-pull.md](upstream-pull.md) — 上游合并记录
- [local-lan-sharing.md](local-lan-sharing.md) — LAN 共享

## 历史归档（[archive/](archive/)）

已收口阶段的交付叙述与被取代的快照，不再更新。与现状文档冲突时以现状文档为准。

- [archive/harness-delivery-log.md](archive/harness-delivery-log.md) — 逐阶段交付叙述与 D-xxx 证据（原 status 主体）
- [archive/agent-harness-plan-detail.md](archive/agent-harness-plan-detail.md) — 已收口阶段的完整计划细节
- [archive/roadmap-history.md](archive/roadmap-history.md) — Phase 0–10 / Stage Q / D-296 历史明细
- [archive/phase-2-desktop.md](archive/phase-2-desktop.md) — 桌面阶段冻结基线
- [archive/testing-ci-audit.md](archive/testing-ci-audit.md) — Stage Q 前置审计
- [archive/openchamber-upstream-20260813.md](archive/openchamber-upstream-20260813.md) — 上游合并检查单
