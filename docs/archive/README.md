# 历史归档

Status: historical navigation — 保存当时的判断与证据，不作为当前工作指令。
Last updated: 2026-10-06

今天的行为从[架构](../architecture.md)、[状态](../status.md)及源码旁文档进入。
归档正文保留原基线；路径调整只修复引用，不把后来的结果写回过去。

## 阶段与迁移历史

| 记录 | 内容 |
| --- | --- |
| [Harness 交付日志](harness-delivery-log.md) | 逐阶段交付、RR/HR 与相关决策证据 |
| [早期 Harness 计划明细](agent-harness-plan-detail.md) | 原阶段完整合同与实施任务 |
| [Harness 计划快照](agent-harness-plan-2026-10-06.md) | 整理前的阶段 0–N 和 AI4S 分解；保留原章节链接 |
| [架构快照](architecture-2026-10-06.md) | 整理前的完整架构、迁移与审计叙述；当前概览已另行维护 |
| [路线历史](roadmap-history.md) | Phase 0–10、Stage Q、companion 退役与早期阶段 |
| [桌面原型](phase-2-desktop.md) | Phase 2 原型记录 |
| [OpenChamber 上游快照](openchamber-upstream-20260813.md) | 2026-08-13 的上游能力研究 |

## 已结束的审计与修复

| 记录 | 内容 |
| --- | --- |
| [Rust 内核审计](rust-kernel-audit.md) | D-278/D-279 的缺陷、返工与证据；不是正在进行的新审计 |
| [测试与 CI 审计](testing-ci-audit.md) | Stage Q 及后续测试整理的历史处置与结果 |
| [上下文准备问题复核](agent-context-preparation-review.md) | Varin-FC 报告复核与对应修复 |
| [BC 早期实现记录](bot-computer-use-acceptance.md) | 被[当前 BC 验收](../reviews/bot-computer-use.md)后续判断覆盖的交付记录 |
| [工具链体检修复](tool-health-repair-2026-10-04.md) | 2026-10-04 材料、记忆句柄、参数及工具链修复 |

追加式决策正文仍在[决策分卷](../decisions/README.md)，没有再复制一套到归档目录。

## 已完成计划与保留事项

Harness 的已结束阶段沿上表查历史；RR 的已交付/被替代部分沿交付日志查，
当前只保留 [RR6 验收计划](../plan/agent-runtime-reliability-plan.md)。BC 没有整体结项，
其[剩余交付计划](../plan/bot-computer-use-plan.md)保留平台实现与原生场景，已补齐批次不再重复安排。
BC/EE 的当前验收保留有用的基线与场景结果；旧逐批全文通过各页的固定提交链接查阅，不再复制进另一份大日志。
