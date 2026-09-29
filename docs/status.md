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
| 阶段 BC Bot、记忆与 Computer Use | 部分实施。BC0–BC2 的 Bot 入口、统一记忆与可恢复后台整理已接线，来源分段、实际模型容量和清除 Bot 模型偏好的继承已补齐。BC3 的无目录推理、工作关联召回与 Bot discussion 咨询已接线；BC4 的本机服务、取消侧信道及 Windows/Linux/macOS 驱动源码已接线。咨询只读边界、macOS 元素定位、Wayland 截图等待及不安全的 Windows 重启输入清扫在本次验收修正。BC5 已实施：桌面 lane 上的服务端控制归属（takeover 断流+代次失效+释放、handback 重观察失效、持有者断连为待恢复归属）、capture_frame/inject_input 驱动 op（Windows 真机冒烟通过）、SSE 帧流路由与设置页共享桌面视图。BC6 已实施：复用 desktopHosts 配置的远端 catalog 镜像与经认证 HTTP 的 observe/act/control/帧流转发（远端权威保留、observation id 原样透传、传输失败报 unknown 不重放），仅有假 fetch 聚焦测试，真实 Host↔Host 联调未完成。BC7 已实施：virsh/libvirt provider（domain UUID 身份、幂等创建与步骤日志、ACPI 关机、删除默认保留磁盘）、VM 机器记录与设置页管理面；全部经脚本化 exec 验证，真实 libvirt 联调未完成。BC8 已实施：桌面视图成为 context rail 的一等工作台表面（computer 页签模式、按桌面 dedupe 页签、复用同一 ComputerDesktopPane/控制语义）、observe/act 落 desktop.usage 会话关联并在表面投影可跳转、设置页加“在面板中打开”与 coordinator 显示；远端镜像/探测/初始化重写均保留 usage。BC9 已实施：驱动资产随 @varin/web 打包（构建期 staging 到 web/computer-driver 并列入 files）、computerDriverDir 按 env→源码→包内回退解析（三布局已验证）、真实 build:application-host 产物含全部驱动文件；正式安装包产出与真实 libvirt/macOS/Host↔Host 联调仍未完成。Linux/macOS 驱动仍仅静态验证 | [实施计划](plan/bot-computer-use-plan.md)、[验收与剩余项](plan/bot-computer-use-acceptance.md) |
| 阶段 HR 面向任务与资源的 Harness | D-337，HR0–HR5 已接线并收口（2026-09-27）：资源根寻址、会话 cwd 锚定、多资源检索、持续索引、可变 work-context 移除、§12 场景证据 | [design/resource-oriented-harness-design.md](design/resource-oriented-harness-design.md)；交付叙述在归档日志 |
| Phase 0–10、D-296 companion 退役 | 完成 | [archive/roadmap-history.md](archive/roadmap-history.md) |

## 当前缺口

| 缺口 | 现状 |
| --- | --- |
| AI4S 7C–7E 剩余合同 | 远程执行与资源管理部分未交付为产品代码；Slurm/原生集群后端延后 |
| 阶段 O | O0–O4 未实施 |
| 阶段 BC | BC3–BC4 的剩余边界见[验收记录](plan/bot-computer-use-acceptance.md)：macOS/Linux 仅有静态验证，Wayland portal 行为依赖真实桌面授权，原生驱动未进入安装包；驱动崩溃后不能可靠归属并释放先前注入的输入。BC5 实时桌面/接管已落地；BC6 远端 catalog 镜像与经认证转发已接线（仅聚焦测试证据，真实联调未完成）；BC7 libvirt 虚拟机生命周期已接线（脚本化验证，无真实 hypervisor 证据）；BC8 工作台/设置整合与桌面 usage 关联投影已落地（聚焦测试证据）；BC9 驱动资产已进入 @varin/web 打包路径（构建产物验证，正式安装包未产出）。 |
| 平台与真实环境验收 | 打包桌面端的会话重开、目录离线、并发 Agent、跨根草稿完整 Agent 交互纵切；真实代理/fake-IP/远端 CI；macOS/Linux 真机；真实付费模型质量与延迟——均未测，不以源码测试宣称 |
| HR 已知边界 | 外部根未保存草稿不能安全物化进单根隔离子任务（明确返回不可用而非读旧盘）；语义索引仍可能静默漏外部新文件需重扫，大目录资源成本未测；混合 A 虚拟分支+B 独立编辑器的单补丁需拆两次提交；结果不明的编辑器操作需人工处理，无自动跨提交域回滚或完整桌面重启证明 |
| 性能数字 | 无测量不写提升倍数或毫秒承诺 |

## 文档入口

- [architecture.md](architecture.md) — 系统架构（权威）；[development.md](development.md) — 开发入口与验证命令
- [design/](design) — 领域设计与 Harness 模块专卷；[plan/](plan) — 实施计划骨架与在途阶段
- [decisions/](decisions) — D-xxx 决策日志索引与领域分卷；[ops/](ops) — 部署与使用指南
- [archive/](archive) — 已收口阶段的交付叙述与历史快照（不再更新，冲突时以本文件与矩阵为准）
