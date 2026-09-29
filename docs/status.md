# Varin 项目状态

Status: living document — 项目阶段进度与当前缺口的权威入口。Harness 能力逐行交付明细在
[design/harness-capability-matrix.md](design/harness-capability-matrix.md)（implemented / wired / proven / default-on 四级定义见其文件头）；
阶段合同在 [plan/](plan)，设计边界在 [design/](design)，逐阶段交付叙述已归档至 [archive/](archive) 不再更新。
本文件不追加工作日志：新阶段交付事实更新下表与矩阵，历史叙述进归档。

Last updated: 2026-09-29

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
| 阶段 BC Bot、记忆与 Computer Use | BC0–BC9 均有生产路径，深入验收结论仍为 Partial。已修复 Bot 生命周期、记忆来源/分支恢复、控制交接、远端 Host/桌面与成果续接；Linux 持久桌面及 Debian/libvirt 托管 guest 的创建、注册、关机升级路径已接线。真实 KVM/Linux 图形会话、macOS 稳定原生组件、Wayland 正式输入会话和发行包实装仍缺证据或实现，不能接受“全部落地”。 | [实施计划](plan/bot-computer-use-plan.md)、[当前深入验收](plan/bot-computer-use-review.md) |
| 阶段 HR 面向任务与资源的 Harness | D-337，HR0–HR5 已接线并收口（2026-09-27）：资源根寻址、会话 cwd 锚定、多资源检索、持续索引、可变 work-context 移除、§12 场景证据 | [design/resource-oriented-harness-design.md](design/resource-oriented-harness-design.md)；交付叙述在归档日志 |
| Phase 0–10、D-296 companion 退役 | 完成 | [archive/roadmap-history.md](archive/roadmap-history.md) |

## 当前缺口

| 缺口 | 现状 |
| --- | --- |
| AI4S 7C–7E 剩余合同 | 远程执行与资源管理部分未交付为产品代码；Slurm/原生集群后端延后 |
| 阶段 O | O0–O4 未实施 |
| 阶段 BC | 实现缺口与环境证据分别见[当前验收](plan/bot-computer-use-review.md)。BC1–BC3 尚缺主动/自动共同来源覆盖、分支来源恢复与完整来源追读；BC6–BC9 尚缺独立桌面准备、VM guest 引导、成果/续接整合和正式平台依赖。Linux/macOS 真机、真实 libvirt、完整远端图形操作及正式安装包未验证。 |
| 平台与真实环境验收 | 打包桌面端的会话重开、目录离线、并发 Agent、跨根草稿完整 Agent 交互纵切；真实代理/fake-IP/远端 CI；macOS/Linux 真机；真实付费模型质量与延迟——均未测，不以源码测试宣称 |
| HR 已知边界 | 外部根未保存草稿不能安全物化进单根隔离子任务（明确返回不可用而非读旧盘）；语义索引仍可能静默漏外部新文件需重扫，大目录资源成本未测；混合 A 虚拟分支+B 独立编辑器的单补丁需拆两次提交；结果不明的编辑器操作需人工处理，无自动跨提交域回滚或完整桌面重启证明 |
| 性能数字 | 无测量不写提升倍数或毫秒承诺 |

## 文档入口

- [architecture.md](architecture.md) — 系统架构（权威）；[development.md](development.md) — 开发入口与验证命令
- [design/](design) — 领域设计与 Harness 模块专卷；[plan/](plan) — 实施计划骨架与在途阶段
- [decisions/](decisions) — D-xxx 决策日志索引与领域分卷；[ops/](ops) — 部署与使用指南
- [archive/](archive) — 已收口阶段的交付叙述与历史快照（不再更新，冲突时以本文件与矩阵为准）
