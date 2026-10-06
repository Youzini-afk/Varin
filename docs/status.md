# Varin 当前状态

Status: maintained delivery summary — 汇总实现边界，具体证据由链接的模块或验收记录保留。
Last updated: 2026-10-06

本页以 `f26cd440` 的代码、近期变更和既有验收记录为整理基线；本次文档核对没有新增运行验收。
版本号、发布任务和在线 CI 结果分别由包清单、发布记录和工作流负责，不从文档中的“完成”推断。
[架构](architecture.md) · [后续路线](roadmap.md) · [验收与证据](reviews/README.md)

## 当前能力

| 领域 | 当前实现 | 仍需区分的边界 | 依据 |
| --- | --- | --- | --- |
| 工作台、Pi 与 Rust 内核 | Agent/IDE/Research/Bot 共享工作台基础；稳定 Pi SDK 会话；Host 与 Rust 的职责分离已实现 | 平台与发行验收按具体构建判断 | [架构](architecture.md)、[Kernel](../kernel/README.md) |
| 常规多 Agent 协作 | Worker/检索、同任务会话互读、持久事件等待、选定代码提交和原生整合已接线 | 相关原生/行为验证不等于付费模型协作质量或完整安装包点击流程 | [D-339 设计与证据](design/agent-collaboration-design.md) |
| 模型输入与工具 | 原生分段装配、动态工具、现有指令/轻记忆、启用团队指导和非阻塞提问有实际入口 | 工具、模式和用户配置共同决定可用能力 | [Pi harness](../packages/pi-host/src/harness/README.md)、[工具选择](../packages/pi-host/src/harness/select-tools.ts) |
| 上下文、知识与检索 | 固定范围后台压缩、原文回读、知识/语义索引、增量 Explore，以及 Web/学术搜索和材料复用已有接线 | 真实 provider 的选材质量与延迟需要独立于模拟调用链证据判断 | [能力明细](reviews/harness-capabilities.md)、[性能](performance.md) |
| 设置、等待与续接 | owner-backed 设置目录、领域动作、耐久条件等待和日历任务已有生产路径 | 配置生效时机、普通 shell 寿命和耐久实验不能混为一谈 | [设置设计](design/agent-settings-design.md)、[续接设计](design/agent-follow-up-design.md) |
| Bot 和记忆 | BC0–BC3 的身份、主动/后台共同来源覆盖、分支恢复、召回及原始片段读取已补齐生产路径 | 真实模型提炼质量、长期运行及缓存效果未由这些定向测试证明 | [Bot 当前验收](reviews/bot-computer-use.md) |
| Computer Use 与虚拟机 | BC4–BC9 有本机控制、观看/交接、远端连接、Linux guest 配方与成果接线 | 正式平台组件仍有实现缺口；完整真机与安装/升级流程未验收 | [BC 分阶段判断](reviews/bot-computer-use.md#分阶段判断) |
| 可组合执行环境 | EE1–EE6 的环境绑定、文件/服务桥、软件配方、浏览器/办公桥和元数据日志已有底层候选实现 | 跨环境资源定位、跨机服务可达性等合同仍未完成；普通活动根已接 Thread，完整环境流程待验 | [EE 当前验收](reviews/execution-environments.md#剩余产品缺口与原生验证) |
| 办公连续性与新工作台体验 | O0–O4 是已接受但未实施的方向；视觉/交互方案仍为候选 | 不把应用桥或候选界面图当成完整办公产品已交付 | [办公设计](design/office-work-continuity-design.md)、[体验候选](design/varin-product-experience.md) |

## 未完成的产品合同

### 执行环境与跨机工作

普通活动根会话已通过 agent-root 接入 Thread/Run，computer 环境工具复用同一绑定服务；
独立环境选择 UI 与完整根会话流程仍待核对，不能再由无绑定会话的拒绝推断整条路径未实施。
已确认的差距是文件/搜索等工具统一按环境资源定位、协调 Host 上的 forward URL 如何被另一台操作电脑使用、
按 Bot scope 取消受理操作、应用进程与可见桌面的身份核验，以及模板的版本/升级合同。
操作证据目前是元数据日志，不是带动作前后画面的完整重演系统。
详见 [EE 剩余合同](reviews/execution-environments.md#剩余产品缺口与原生验证)。

### 平台组件与研究资源管理

macOS 稳定原生组件和 Wayland 正式输入/屏幕会话仍有实现工作；这些不是单纯缺少测试机器。
Linux 托管 guest 已有配方和生命周期接线，但其适用范围与原生运行证据仍受限。
详见 [BC 验收](reviews/bot-computer-use.md)。

科研已有本地与受管远端执行路径，但 D-300 修订后的 7C–7E 资源管理/调度合同并未因此全部完成。
Slurm 等原生集群适配继续延后。完整目标见 [科研设计](design/research-cluster-design.md)，
原实施分解见 [阶段 7 历史计划](archive/agent-harness-plan-2026-10-06.md#阶段-7ai4s-科研集群d-291d-297d-300分阶段实施)。

### 工作区恢复的剩余目标

当前恢复有脏状态 barrier，但遇到未保存缓冲仍拒绝恢复；同步失败返回 dirty-state-unavailable。
可确认的脏缓冲恢复、按 Surface 降级，以及内置 store 的 retention、storage management、workspace lease
尚未实现，删除恢复历史也仍不可用。它们是产品合同缺口，不能并入“只缺安装包测试”。
详见[原生恢复设计](design/native-workspace-recovery-design.md)。

### 尚未进入实现的方向

办公连续性 O0–O4、候选工作台体验，以及动效设计中仍标为未来工作的部分，不混入已交付清单。
选择下一项工作时从 [路线图](roadmap.md) 和各主题合同进入，不延续旧文档中的“下一阶段是 L”等时序描述。

## 尚待补充的运行证据

既有验收记录仍缺完整 Linux/macOS 图形会话、真实 KVM/libvirt guest、跨机浏览器/办公/forward、
安装与升级流程，以及真实付费模型质量/延迟的相应证据。RR6 的安装包与外部代理纵切也未闭合。
代码存在、定向测试通过、原生组件测试和完整产品场景是不同层次的证据。

HR 的跨根未保存草稿物化、混合写入域、来源失效与结果不明操作等场景继续保留在
[任务/资源设计](design/resource-oriented-harness-design.md)和[能力明细](reviews/harness-capabilities.md)中。
本次文档整理没有把这些历史边界重新宣称为已复现或已消除；新的场景验证应回写对应记录。

## 历史阶段如何查

R、Q、S、W、B、F、C、L、N、HR 等编号是定位实施历史的索引，不另维护第二张完成度表。
[Harness 阶段导航](plan/agent-harness-plan.md)连接设计、交付记录和原计划；
[归档目录](archive/README.md)保留 Phase 0–10、Rust 审计、测试治理和上下文修复记录。
