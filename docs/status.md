# Varin 项目状态

Status: living document — 项目阶段进度与当前缺口的权威入口。Harness 能力逐行交付明细在
[design/harness-capability-matrix.md](design/harness-capability-matrix.md)（implemented / wired / proven / default-on 四级定义见其文件头）；
阶段合同在 [plan/](plan)，设计边界在 [design/](design)，逐阶段交付叙述已归档至 [archive/](archive) 不再更新。
本文件不追加工作日志：新阶段交付事实更新下表与矩阵，历史叙述进归档。

Last updated: 2026-09-28

## 阶段进度

| 阶段 | 状态 | 明细入口 |
| --- | --- | --- |
| Harness 能力（0.x–3b、T4、工作分支/Integration） | 逐行状态与证据 | [design/harness-capability-matrix.md](design/harness-capability-matrix.md) |
| 阶段 Q 测试与 CI | 已验收收口（D-292） | [design/testing-ci-design.md](design/testing-ci-design.md)、[plan/agent-harness-plan.md](plan/agent-harness-plan.md) |
| 阶段 R Rust 系统内核 | D-282 收口；kernel 为转移面生产权威 | [design/rust-kernel-design.md](design/rust-kernel-design.md)、[plan/rust-kernel-audit.md](plan/rust-kernel-audit.md) |
| 阶段 RR 运行时可靠性 | RR0–RR5 代码路径与定向行为已复核；RR6 真实安装包/外部代理平台纵切仍待验证 | [plan/agent-runtime-reliability-plan.md](plan/agent-runtime-reliability-plan.md)；RR2/RR4 旧机制已被 HR 移除 |
| 阶段 7 AI4S 科研集群（7A–7I） | 主体已交付为 Partial（D-298/D-303/D-305）；D-300 修订的 7C–7E 远程执行与资源管理部分仍未作为产品代码交付，Slurm 延后 | [design/research-cluster-design.md](design/research-cluster-design.md) |
| 阶段 S / W / B / F / C / L / N | 已接线；逐能力证据在矩阵 | [plan/agent-harness-plan.md](plan/agent-harness-plan.md) 同名节 |
| 阶段 O 办公连续性 | 设计已接受（D-327），O0–O4 未实施 | [design/office-work-continuity-design.md](design/office-work-continuity-design.md) |
| 阶段 BC Bot、记忆与 Computer Use | 部分实施，BC0–BC2 已补齐并通过聚焦验收（BC0 Bot 人设/模型/管理 UI/跨入口工作层级；BC1–BC2 单一 organizer 生产者的持久覆盖事务：prepared 提案重放、sourceKey 指纹重开、supplements 图边、容量感知分批、Bot 模型继承、进度路由与设置 UI）；BC3–BC4 尚未通过完整交付验收：仍缺无目录模型/向量绑定、真正 Bot 咨询、可中断原生操作、macOS 驱动与 Wayland portal。BC5–BC9 未实施 | [实施计划](plan/bot-computer-use-plan.md)、[验收与剩余项](plan/bot-computer-use-acceptance.md) |
| 阶段 HR 面向任务与资源的 Harness | D-337，HR0–HR5 已接线并收口（2026-09-27）：资源根寻址、会话 cwd 锚定、多资源检索、持续索引、可变 work-context 移除、§12 场景证据 | [design/resource-oriented-harness-design.md](design/resource-oriented-harness-design.md)；交付叙述在归档日志 |
| Phase 0–10、D-296 companion 退役 | 完成 | [archive/roadmap-history.md](archive/roadmap-history.md) |

## 当前缺口

| 缺口 | 现状 |
| --- | --- |
| AI4S 7C–7E 剩余合同 | 远程执行与资源管理部分未交付为产品代码；Slurm/原生集群后端延后 |
| 阶段 O | O0–O4 未实施 |
| 阶段 BC | BC0–BC2 已补齐；BC3–BC4 的具体未完成合同见[验收记录](plan/bot-computer-use-acceptance.md)。已接线不等于阶段完成；macOS 驱动和 Wayland portal 属于尚未实现，Linux 原生输入/捕获与安装包能力属于未验证。实时桌面、远端常驻与虚拟机生命周期属于后续 BC5–BC9。 |
| 平台与真实环境验收 | 打包桌面端的会话重开、目录离线、并发 Agent、跨根草稿完整 Agent 交互纵切；真实代理/fake-IP/远端 CI；macOS/Linux 真机；真实付费模型质量与延迟——均未测，不以源码测试宣称 |
| HR 已知边界 | 外部根未保存草稿不能安全物化进单根隔离子任务（明确返回不可用而非读旧盘）；语义索引仍可能静默漏外部新文件需重扫，大目录资源成本未测；混合 A 虚拟分支+B 独立编辑器的单补丁需拆两次提交；结果不明的编辑器操作需人工处理，无自动跨提交域回滚或完整桌面重启证明 |
| 性能数字 | 无测量不写提升倍数或毫秒承诺 |

## 文档入口

- [architecture.md](architecture.md) — 系统架构（权威）；[development.md](development.md) — 开发入口与验证命令
- [design/](design) — 领域设计与 Harness 模块专卷；[plan/](plan) — 实施计划骨架与在途阶段
- [decisions/](decisions) — D-xxx 决策日志索引与领域分卷；[ops/](ops) — 部署与使用指南
- [archive/](archive) — 已收口阶段的交付叙述与历史快照（不再更新，冲突时以本文件与矩阵为准）
