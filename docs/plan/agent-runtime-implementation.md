# 原生 Agent 运行时实施

状态：实施中，尚未切换生产运行时。更新：2026-10-13（Asia/Singapore）。

综合结构审阅见[2026-10-09 实现审阅](../reviews/runtime-2026-10-09.md)，后续实现及独立行为验证见[控制路径隔离增量](../reviews/runtime-control-isolation-2026-10-09.md)。前次源码与编译审阅、各阶段行为验证分别记录；历史通过记录不代替当前代码的证据。两份设计的整体交付仍未完成。

目标是完整实现[完整运行时设计](../design/agent-runtime-design.md)和[能力组合设计](../design/runtime-extensibility-design.md)共同定义的长期运行底座：及时交互、低开销执行、按真实资源调度、深层能力组合和可替换策略。完成聊天循环、迁移已有工具或删除 Pi 都不是单独的完成标准；Pi 退出是这套设计落地后的一个结果。当前生产仍使用 Pi session worker、TypeScript Host 协调和 Rust 资源内核；现有权威见[架构](../architecture.md)。

交付边界（2026-10-10 用户确认）：本轮完成两设计能力与可复跑验收入口，整理实现证据、未验范围和迁移前清单，交用户先验收。默认 runtime 切换、Pi 删除和用户资产全面迁移由用户在验收后负责。本分工不缩减设计能力范围，也不把未执行的产品或平台验证算作通过。

## 2026-10-13 增量：原 managed PTY 与包来源清理恢复

原 Thread/branch/Operation 的 PTY 可沿冻结 B 来源重新准入仅供视图的 authority，通过原
Storage 进程流、独立 data/control credit 和写入回执投影到现有 Terminal。UI 关闭只 detach；
停止仍取消原 Operation。历史输出带固定 replay 边界，重新打开不重复回答历史终端查询；
B cwd 与资源 owner 保留，不用于 A 本地目录解析或 localhost 预览。断连后的重试重新准入
原进程视图，旧进程的创建 epoch 与当前查看 epoch 分开。

包 stage 后首次 B 清理失败现在沿原已交付 Operation 在恢复时推进；B 的原 package capture
清理身份与确切 revision pin 进入已有 Storage record，重开不依赖 Host 内存 map，也不重放 stage。
wire **29**。[PTY 证据](../reviews/runtime-managed-pty-2026-10-13.md)和
[包清理审查及修复](../reviews/runtime-managed-package-lifecycle-audit-2026-10-13.md)分别记录
实际定点证据与未执行路径。本轮按用户调整暂不安排实机/物理多机验收；这些未验事实保留，
不作为代码阶段继续推进的阻碍。完整类型/Host集成证据因当前依赖不可取得而有限。

## 2026-10-13 增量：资源等待与受确认的草稿恢复

文件租约改为原 Storage owner 的事件等待，移除 Host 的 5ms 重试；原取消、撤权及 worker 排空回执
继续决定真实释放。检索计划的发行实现和 SDK 共用可查询合同。确认恢复现在保存并更新实际草稿与磁盘
基线，支持撤销取回未保存内容；同时修复协议联合类型、Registry 重读竞争和恢复重新排入自身队列的问题。
恢复按实际操作协调，文件效果仍沿原路径租约。wire **28**。

[验收记录](../reviews/runtime-resource-recovery-2026-10-13.md)分列真实 worker、IPC、broker、
Kernel/Authority/Registry 证据与未验边界。未知草稿状态的确认设计、压缩算法扩展、增量输入/捕获、
其余 managed 消费者及完整平台/性能验收继续推进；用户最终迁移分工不变。

## 2026-10-13 增量：共享固定请求快照

ModelStep 执行与 `RequestPrepared` 共用一份不可变快照；持久媒体投影借用 provider 原请求正文，
避免再次深复制。存储 JSON 和原媒体/opaque 内容合同不变。独立 hack 复用执行、取消、重开与 GC
测试，并补实际快照媒体往返，35 项通过；两 crate 测试构造编译通过。
这一步消除同一次请求内的重复副本，尚未实现历史编译和 provider 序列化的稳定前缀复用。

## 2026-10-13 增量：Managed Source 扩展包

本地及来源 Host 共用包捕获 owner；冻结目录和分页原字节进入原 compiler/artifact/catalog，
完整来源身份随候选保存。取消与 authority retirement 收尾实际 reader 和捕获引用，语言准备单独
排空。原候选撤回也补齐就绪组形成前的取消与 join；不强杀已完成准备。
[本轮证据](../reviews/runtime-managed-package-2026-10-13.md)分列双 Storage/Router、原本地链、
语言准备和候选生命周期。交互 PTY、持久脚本、Experiment 输入、项目 MCP/日历、跨 Host 恢复及
真实平台/网络验收仍继续按原 owner 实现。

## 2026-10-13 增量：请求编译与摘要材料副本

适配器借用固定历史、输出 parts 和续接数据，已构造的媒体块及消息数组直接进入最终请求；Codex
不再复制整个视图，摘要准备转移原 parts。协议内容、回执文字、原媒体/来源及存储合同不变。
独立验证适配器 34、摘要材料 2、原 Catalog 执行链 2 项通过；本地前后探针的 10 家族完整请求字节一致，样本中的单次
编译分配字节减少 78.6%–84.5%。[实现和测量边界](../reviews/runtime-request-compilation-2026-10-13.md)
区分局部编译成本与整体性能；跨 ModelStep 的稳定前缀复用、容量估计和目录捕获的增量工作仍未完成。

## 2026-10-13 增量：Managed Source 实验输入

来源 Host 固定实时、固定修订或原物化副本的实验输入，协调端按实际分页字节安装并核对完整 root，
再沿原 Experiment spec/物化/执行 owner 消费。来源读取与内部 Storage 写入分开授权，原捕获与
清理回执支持取消、丢回复及 Host/Storage 重开；B 的路径不用于解析 A 的输入。
[实现与验证范围](../reviews/runtime-managed-experiment-input-2026-10-13.md)记录双内核探针和
原服务检查。交互 PTY、持久脚本、项目 MCP/日历、跨 Host 组合恢复及完整平台/网络验收仍待完成。

## 2026-10-13 Windows 整合验收

同步到 `4b14f3aa` 后沿真实 HTTP、内核 IPC、扩展 broker、文件/进程和控制通知复检。
修复错误帧协议版本、工具持久回执 ACK 竞态、共享事实的历史游标、桌面释放写入冲突、
脚本与多桌面清理互相等待、路由请求体、预设选择、Windows 路径/长路径和更新组清理。
Windows 只读枚举引起的目录访问/写入时间通知也已在观察边界修复：原生通知区分内容与名称/属性/权限，
并确认订阅就绪及事件交付；静态目录捕获、真实修改与重连已通过验证。
证据与剩余范围见[整合验收](../reviews/runtime-2026-10-13.md)；两设计整体交付及性能目标尚不能标为通过。

## 2026-10-12 范围与兼容约束纠正

- 当前合同直接替代旧版本，不为历史字段、scalar 形状、旧 schema 或双轨选择入口保留兼容分支。消费者一起更新；既有在途调用冻结、当前格式恢复、世代排空和真实异构 provider 协商仍是当前语义。不得据此删除用户实际文件、成果或提前切换默认 runtime。
- 推理用途接入不等于每个用途都有本地推理包。已有提供商 decision/rerank/embedding 的配置、真实消费者与原生执行合同仍需保留/接通；本地包当前只有已有 Bekko。用户本轮明确暂缓 native 图像生成，不计剩余交付范围；旧 Pi 的 `models.generateImages()` 基础不等于 native 已实现。§18.1/§24 的建议/评估限定已有配置的辅助请求，不能扩成默认模型链；没有另设独立“材料 rerank”产品的任务。此前清单混用用途、消费者和本地包，现以这些明确边界纠正，历史台账不充当新需求。
- 已有本地嵌入是 `bekko-embedding-v1-a8m` 的 `local-semantic` ONNX 组件。下述增量已将其原安装/校验/worker 接入 native query 和前台文档向量，HTTP 仍是显式配置的另一执行器。HTTP 或受控本地模型的执行验证不代表用户配置了外部服务，也不代表实际 ONNX 权重、硬件质量/性能已验收；当前组件协议需按原 builder 构建 v3 包后导入。

## 2026-10-13 增量：Managed 文件跟进与原服务转发

- User 文件跟进先保存原 Catalog command/scope，再绑定 B；丢 accept 后恢复原基线，全部叶就绪后关闭原 scope 再提交定义。Documents watch、Storage receipt/pin、同 key 取消和 Bot 删除继续由原 owner 收尾，A 不访问同名本地路径。固定成功/paused 不为权限诊断另增轮询，B 撤权实际释放资源，A 保留最后事实并可延迟更新诊断。
- 普通 environment forward 工具接原 Host listener owner 与 Catalog Thread Job，冻结连接/Host epoch。实际关闭、Wait、Bot Sleep 和恢复沿原 Operation；listener 停止不等于远端服务进程停止。恢复只读原 canonical acceptance，未知旧 Host 不创建替代转发。
- Catalog **67**、Storage **17**、wire **27**。[当前记录](../reviews/runtime-managed-observation-forward-2026-10-13.md)分列真实 User→Catalog→Storage/Documents 组合、Rust receipt gate、受控 forward/consumer、类型检查及未验范围。交互 PTY 与余下 managed 消费者继续独立推进；不把本片当全部多环境设计完成。

## 2026-10-13 增量：同源 managed Host 执行

- 将固定、物化和 live Source 的 resource owner 贯穿 picker/client/认证 Router、原 Run 工具、同源检索/语言、child 与 journal。协调端 Catalog 保意图和交付，目标 Host 原 Storage/KernelToolExecutor/进程 guardian 保执行事实；不制造目标端影子 Run，不将目标 hash 当协调端对象引用。Catalog **66**、Storage **16**、wire **26**直接采用当前合同。
- B Documents 解析一次来源，后续按冻结连接/工作区准入；失联、换 epoch、取消与结果查询沿原 authority/operation。目标文件/进程/上下文和派生语义缓存不再误用协调机同名根。原 child pin/result/Integration 与 caller-retained lifetime 同 owner；未交付正文保原回执，持久交付后精确回收，Bot 删除失败保留原清理地址。
- [本轮记录](../reviews/runtime-managed-source-2026-10-13.md)分列最终 5 个真实资源组合和有限 consumer/独立 bridge 证据。当时缺少的文件事件已在上方增量接入；跨 Host 文件恢复、PTY/script 及部分项目消费者仍有明确缺口，不把整体 managed 环境或两设计标为完成。Computer 应用工具沿独立原 actor/driver 并行推进。

## 2026-10-13 增量：Computer 应用工具

- 原 builtin、broker 与 native invocation 接通 Computer control/open/put/install、browser/Office、evidence 和环境读取。实际 actor、peer assignment、输入 lane 和 driver 继续独占权限与效果；新控制租约后重新观察，child observer 不清除 root 的手动交还要求。
- 明确目标前置拒绝、未知效果、媒体编码错误、安装/helper 真正退出和嵌套脚本取消分别保原事实。受控双 owner 与认证 Router 已复验正常 control → snapshot → act、撤销 assignment、丢控制 ACK 和晚到取消；原包构建与完整 Host 类型检查通过。[功能证据](../reviews/runtime-computer-applications-2026-10-13.md)保留真实桌面、双机网络和平台未验边界。
- 后续同域增量已接 managed desktop prepare/start/stop 与原 artifact/Bot 工作消费者。实际目标 reset 的分配回执覆盖途中 observer，保 reset 后新 grant；目标 peer 不制造本地 Thread，明确 not-found 与故障分开。新 13 个精确入口、独立跨 owner 反例、产包与最终 Host 类型检查已通过；setup helper 无合作中断时仍等真实退出。native placement/forward Job 保明确缺口。

## 2026-10-13 增量：Thread 历史导航与原文件恢复

- 原 HistoryBranch 使用锁外祖先/上下文准备、head CAS 与持久命令 receipt；原 key 的未知重试不回退后来新输入，Undo 只沿原 receipt。Run、用量、效果、Goal 取消和当前来源保留，跨摘要范围时只清摘要专属 Bot baseline。
- 真实工具冻结的输入范围进入原 affected-file journal；同 Run 的 Boundary 输入各自绑定 checkpoint。物理目标、原来源和多根同名路径分别核对；条件写入、safety、补偿、当前 writer/reservation 和原 Storage 引用保持同一 owner。fork、旧根离线及重开投影不由当前 sidebar 推断。
- Thread 与 Pi 原恢复消费者同步使用 v6 tagged conversation；未知结果保同一 operation/revision，启动发现与导航 owner 就绪分开。元数据读取不要求物理根在线，失败明确投影；脏缓冲仍需先保存/丢弃。Catalog **65**、Storage **15**、wire **25**。
- [本轮记录](../reviews/runtime-thread-recovery-2026-10-13.md)分列真实 RunAssembly/文件写入/后继请求、Catalog/Storage、Bot Context/GC、原纯 journal saga 和 React/Router 证据。被拒的 Unix listener 探针保持停止，Rust/Host 多物理根组合恢复、实际产品 IPC 与跨平台恢复未计通过。本增量实现原恢复接线，不恢复 Git index，也不将全部两设计或平台验收标为完成。

## 2026-10-12 增量：Documents 草稿与固定来源

- 原 Source picker/client/认证 Router 用一次 Documents 注册后的 workspaceId，显式选择 saved-files/surface-drafts/captureScopes，并冻结完整重试意图。Thread 快照不可变，Pi 原 own-write 消费保持；BOM/行尾、文档实例/修订经原 provenance 引用保存，正文进入既有 WorkingState root。
- 设置/指令/skills 与文件正文消费同一草稿覆盖视图。Git 子目录的 inventory/hash 使用真实选定根，原 index identity 参与稳定性判断；原 branch-create receipt 先读，移根/过期快照重试仍返回同一固定来源，当前信任及物理执行准入不混用。
- 共享准备取消只在最后观察者退出时排空原作业，未转移对象沿原 owner 释放。fixed child 继承原 pin/baseRef 与来源关系，没有第二草稿库。[本轮记录](../reviews/runtime-document-source-2026-10-12.md)区分 UI/Documents、受控树、真实 Rust/Host 与构建证据。Catalog **65**、wire **24**保持。
- 本片捕获不等于恢复 Git index、外部修改或编辑器缓冲。其后对话回退与组合文件恢复的实现及未验范围见上方增量。

## 2026-10-12 增量：Bot 产品与原记忆/Plan、摘要准备

- 新建 Agent Bot 的实际 Thread/branch 已沿原 BotProfile、client、认证 Router 与共享工作台接通；默认仍 Pi。原 MemoryService/Knowledge 处理 typed native 历史来源、Bot/user/current-Thread 召回及原事务回执，实际 RequestSnapshot 消费同一状态。Sleep/Wake 保留原等待与手动暂停，加入原 Host domain/preparation、子任务与 Computer 执行停止证据；删除另沿原 owner 释放确切引用。
- Bot 记忆随原 ContextJob 配方冻结，并由原 ContentStore manifest/checkpoint 引用持有；只有发布 CAS 推进摘要基线。后台摘要按实际耗时/输入增长提前准备，当前 Decision 及实际 provider 序列化的完整输入决定自动发布，超预算保留原候选与原文，不自动重新收费。
- 原 Plan 域接实际 Bot 身份和 selected Tool/Operation。文件 source 的 read-only 不是所有领域只读；不新增禁止独立 notes/plan 修改的权限表。原持久 mutation receipt 与同 epoch 执行停止事实各保其语义。
- Catalog **65**、wire **24**。[本轮记录](../reviews/runtime-bot-product-context-2026-10-12.md)分列真实 Bot stdio、记忆基线 GC、Plan child/Host 和 UI/direct Router 的证据，未把受控 provider 当实际模型验收。后续 Documents 草稿/Git 来源的当前合同见上方增量；明确恢复继续复用原 journal 和历史 owner。

## 2026-10-12 增量：私有 Bot 身份与可恢复暂停基础

- 原 BotService profile/activity 仍唯一决定身份和工作准入。Catalog **64**、wire **23** 将短来源 gate 绑定当前 epoch，root Thread 仅存 Bot 关联；child、context job、MemoryWork 从各自原关系派生，不复制 ThreadRegistry 或新建生命周期账本。
- 原 Run 的 Bot hold 与用户 Stop 分开；Sleep 保留 Prepared/proposal、Wait/trigger 和手动 pause，Wake 沿原 recovery 和 continuation。实际 worker join、原 executor stop、未知 effect/模型分列；同 completion 的迟到停止证据支持幂等精化。Host preparation 注册等底层工作真正结束。
- [本片验证记录](../reviews/runtime-bot-suspension-foundation-2026-10-12.md)分列真实 BotService/Storage epoch、原后台记忆消费者及独立 warm/cold 单次发送证据；原 probe 已入仓复跑。该基础片当时尚未开放 native Bot 创建，也未将局部 status 当完整 asleep。
- 后续 typed 来源、召回、产品入口及完整生命周期的当前进展见上方新记录；不提前切换默认或迁移用户资产。

## 2026-10-12 增量：原 Bot 整理与选段的后台推理

- 已有 organizer 和显式选段 preview 接入独立 MemoryWork Run/decision/generation stages，原 Catalog 与 ContentStore 保存完整固定批次、真实请求和回执；Knowledge 仅保进度/提案，MemoryService 仍唯一写入。原 Bot 身份、配置、Sleep gate 和模型/凭据权威保留，不假借 conversation Tool/Explore/Goal。Catalog **63**、wire **23**。
- 原成功结果/可选 classifier 原字节恢复不重发；同选区观察复用 requestKey，明确 Retry 在已证本地停止后建立关联新 attempt，原 Unknown 费用不被抹掉。Sleep 用短状态取消并等实际排空，Wake 只恢复已证未派发的原 generation。来源范围、目标 CAS、忘记与已写记忆/coverage 对账继续同 owner。
- [本片合同及验收记录](../reviews/runtime-bot-memory-inference-2026-10-12.md)分列原领域、UI/direct Router、Rust↔Host 与 Knowledge 子进程的组合证据。整合发现进程期 Knowledge revision 被误持久化，按原短期 fence 与持久目标 CAS 分工收口，不新建持久版本库。
- 本片仅后台整理与选段。Bot 主入口、native 历史来源/召回/checkpoint 和完整 main/child/Computer Sleep 仍需接入；普通 Agent 不新增自动抽取。随后还须保留原 harness-context §8.4.2 已有的摘要耗时与输入增长自适应准备水位，不能把它扩成 provider 错误学习或自动收费重试。

## 2026-10-12 增量：原成功 usage 校准请求预算

- 原 harness-context §8.4.2 要求沿上一次有效 usage 与完整新增材料估算；本片接通该已有行为，不新增“provider 容量错误学习”或自动收费重试产品。原 provider adapter 声明真实序列化与输入计数语义，原 Catalog/ContentStore 保存请求和回执，不另存可变校准账。
- 新请求在 worker 读取同 branch 最新成功、实际 input 的原 ModelStep；完整 binding、语义历史和实际 wire prefix 不匹配时保留本地估算，不寻找更旧匹配样本。正文/媒体解引用与比较在 Catalog 锁外，取消和派发仍沿原 Run/epoch。估值不改原始 usage、Goal 归属或已准备请求；Catalog **62**、wire **22** 保持。
- 真实整合发现原固定 child 说明尾插且使用 Run ID，使普通 main 后续请求不能校准并违反 Google system 前缀；已修为原 owner 固定说明在增长历史前、身份沿原冻结内容，Goal 保持 user 权限。独审另复现并修复 Pi 的零 total 未填语义，原 raw/账务保持。[合同和复跑入口](../reviews/runtime-context-usage-2026-10-12.md)分列真实 main/Goal→Host→预算扩展、原取消恢复回归、受控模型与未验产品边界。
- 下一沿既有 Bot organizer/选文提取及其真实 MemoryService、来源、Sleep 和后台推理 owner 推进；普通 Agent 已有显式 notes 不因此新增自动抽取。剩余清单须依据设计及已有消费者，不能将此前含混“容量反馈”当新需求。

## 2026-10-12 增量：Scoped 冻结依赖与共享实例

- 原 ServiceRoutingStore 统一可变选择；旧 registry/Surface 全局 selection 与公开 setter 删除。Host/Surface requirement 明确 `realms`，activate 前冻结实际 selected/single/all/optional 图。同图共享，不同依赖图隔离，当前 selection、旧调用 pin 与实际 callback 分别持有原实例引用；不把 Thread ID 或 routing revision 当实例身份。
- SDK、broker、trusted-native、Context/Budget/retrieval/observer、tool/policy、Surface/client 和实际 Settings 同步消费。嵌套依赖调用沿原 Run/Operation/权限，撤权沿确切图；旧代的普通排空不变成已取消。Surface 的单认证响应 stream 持有真实 owner 组合，关闭后在途调用独立排空，无静默重连换 handle。
- Catalog **62**、wire **22**。完整 policy/tool graph 沿原 ContentStore/launch/delegated 引用持久化，短控制事实不内联大图；GC、重开与 child 恢复消费原图，不用当前 routing 替换旧选择。原生 WorkbenchLayout 保留真实非包 owner，不造 artifact 或 alias。
- [本片合同、反例与复跑入口](../reviews/runtime-scoped-composition-2026-10-12.md)记录真实 client/认证 Router/broker、原 policy/工具及恢复链。独审五条原反例与原作者产包整链的 manifest owner 挂载回归均已闭合，普通和 grouped 两条原业务全链通过。后续已有自动记忆/Bot 等按设计原文及真实消费者推进；容量估算与反馈也须区分当前合同和可选优化，不把推测性功能扩成必做产品。

## 2026-10-12 增量：已有 Bekko 原生推理归属

- 原已安装组件在 embedding 未配置时供 native semantic 查询；明确 provider 选择、禁用和无效状态不暗回退。主任务与 child 的 query、fixed/materialized 文档计算沿原 InferenceCall parent/ordinal、Catalog、Goal 与 ContentStore，每个实际 CPU 粒度有原回执。Catalog **61**、wire **21**，HTTP/local tagged 执行器共同接线，无假 endpoint/credential 或第二前台账本。
- 原共享 worker 区分排队 ACK、实际派发、观察者取消与真正排空；晚到结果/错误/estimated 用量保留，execute 后丢失 started ACK 保持 Unknown，pending 和重开不改成 no-send、不重跑。组件代与 query/scan pin 在真实停止后释放，同字节重新导入复用，旧组件协议直接拒绝且保留资产。
- [本片证据与复跑入口](../reviews/runtime-bekko-inference-2026-10-12.md)记录原组件导入/active/default→主与 child→Source→worker→Catalog/Goal 的真实链、原 HTTP 回归和证据边界。模型模块受控；实际 ONNX 包构建/安装、质量/性能和完整产品/平台验收仍待外层验证，本片未发布 Release 或下载权重。
- 本片当时将扩展唯一 scoped 选择、冻结依赖及共享实例/组合引用寿命留给下一增量；当前接线见上方新记录，不能把早期数组改名当作该生命周期已经完成的证据。容量反馈、自动记忆/Bot 与其余两设计的确认范围继续推进。

## 2026-10-12 增量：唯一数组 routing 合同

- 原规则、resolution 和公开 selection 统一 `providerKeys`/`providerIds` 数组，删除旧 scalar 解析/写入/投影。一个 provider 的稳定 `providerKey` 和精确 generation `providerId` 仍各指一个实现；准备阶段的 extension 身份不冒充实际 generation。
- single 消费必须恰一项；ordered 按完整顺序及每成员声明执行，显式 `[]` 不等于 unset。单候选/default/显式 handle 同样不能绕过 ordered 合同；缺成员只允许原整规则 fallback，不截断集合。组合语义来自消费合同和同源 descriptor 投影，不新增配置名单。
- 原 Settings 控件/store、client、认证 Router、文件 CAS/重开和 metadata 同步迁移；存储真实 schema marker 不再被覆盖成当前常量。Budget/Policy/tool/observer 的 single 与 Context Transform 的 collection 继续沿原准备和冻结 owner，[本片证据](../reviews/runtime-array-routing-2026-10-12.md)区分真实 native 组合、Node broker、DOM/direct Router 和未执行入口。
- 旧 registry/Surface 全局选择表尚未删除。其 selected 冷依赖及不同项目捕获不同依赖的实例共享/释放需要一个完整生命周期片，不能用数组改名冒充单权威已完成。下一先接已有 Bekko 本地执行器，再闭合该设计项。

## 2026-10-12 增量：声明与 Catalog 的有界历史兼容删除

- `provideContextFragments` 固定注册同源完整 descriptor，发行内置与作者示例同时迁移；删除 `declareContract` opt-in，不影响其他合法未声明 metadata 的异构服务。
- tool 与 method/event 的 source 使用同一包内相对路径/行号合同，发布 schema 同步引用；无效声明在准入拒绝，metadata 不再捕获错误后假装没有 source。合法元数据仍沿原 slot/integrity 读取不可变包内文件。
- 删除 builtin Catalog 在严格解析前的 raw-record repair、专用 reader 和 repaired 写回。当前格式的正常发行更新、用户停用状态、外部 candidate/grants、原 CAS/原子写和诊断快照保留，不删除实际用户资产。
- 原 SDK→实际 broker、source 元数据→原字节、当前 Catalog→正常更新/坏字节拒绝，以及原 native Transform 请求/child/重开组合已复跑；独审接受，[本片证据](../reviews/runtime-current-extension-contracts-2026-10-12.md)记录旧 storage-sync 测试未命中故障的纠正。下一有界片统一数组 routing；registry/Surface 第二选择表的删除必须连同真实 scoped selected 依赖与共享实例生命周期实施，不能只删字段后宣称闭环。这项真实设计实现排在已有 Bekko 接入之后，本片未半迁移。

## 2026-10-12 增量：可替换 Context Budget Decision

- 设计依据为扩设 §6/§11 的命名压缩 Decision 和总设 §13.2 的固定祖先 `摘要(A)+B+N`。原 settings、service routing、Run、ContextJob 与 ContentStore 继续各司其职；默认原生预算只做短设置查询，不执行未选择扩展。选中普通策略只接收候选边界/估量元数据，核心仍验证祖先、工具配对及用户后台开关。
- 当前 ContextJob 必须保存原 `summaryRecipe`，包含策略/包/配置身份、blocking/background 模式和摘要指导；手动压缩显式构造 manual 配方。Catalog **60**、wire **20**直接拒绝旧格式，不写缺字段补旧逻辑。相同 owner/checkpoint/model/credential 的并发候选只受理一份，失败/未知收费工作不靠换 key 自动重试。
- 真正 Settings/client/Router、普通 broker、主 Run/summary、child 准入后的 scope、取消/换代以及完成摘要在重开后发布已验证。独审发现外部策略可越过用户禁后台设置，已由 Rust 唯一决策边界修复并在真实整链复验。[本片合同与证据](../reviews/runtime-context-budget-2026-10-12.md)区分真实生命周期、受控推理和未验平台。
- 当时记录的“provider 容量错误反馈”范围过宽；现已核原设计要求的是成功 usage 校准，见上方当前增量。完整自动记忆/Bot 等继续推进；本段当时保留的兼容/Bekko/routing 工作以各后续增量为准，不继续保留旧选择轨。

## 2026-10-12 增量：有序纯 Context Transform

- 原 service routing 支持明确 `providerKeys` 顺序、空选择和原单值资产；组合能力由合同声明，设置页共用原 parser/CAS 与实际 metadata。Context 接原 user/session/project 及已准入 workspace 配置身份，不另造工具名单或授予来源权限。Catalog **59**、wire **19**直接拒旧。
- 原 Host 准备仅选中成员、复用未变声明；Rust 在读 worker 合成带独立 provider/content/section 身份的 Instruction/Data。固定请求和 checkpoint 不随新选择或撤权被改写，失败/取消/陈旧候选保旧。
- 实际 broker→ThreadContext→原 Rust 准入→模型序列化、无文件源 child 准入/ContextRead、GC 重开，以及实际设置控件→client→direct Router→文件 CAS 已闭合；独立六个取消/失败样本通过。[本片证据与复跑入口](../reviews/runtime-context-transforms-2026-10-12.md)区分受控模型、真实 owner 与外层未验范围。更广能力组合及其余两设计继续推进。

## 2026-10-12 增量：显式 Host/Surface 更新就绪组

- `updateReadiness` 只将明确列出的本包 Surface 成员与 Host 成组更新。普通 apply 保原申请事实，缺就绪时保持旧 selected/active；首装、已提交恢复和未声明组的后台保持原无窗口行为。Catalog **58**、wire **18** 无变化。
- 原 Host instance、实际 Loader/Surface/Workbench 准备与原 Catalog 短提交校验贯穿真实 client/route 取消；提交后原选择胜过断连，旧 pin 与新合法请求分开。真实坏挂载保旧、好更新及历史/GC/重开已复验；独审闭合准备后 crash、已选 storage 误回滚及无关 slot 更新误取消，[本片证据](../reviews/runtime-readiness-groups-2026-10-12.md)分列实际边界。
- trusted-native 不能并存实例的热接管仍未实现，保明确 disable/apply/restart/enable 路径；更广 Provider/Transform/共享 key、组合计划及其余两设计能力继续推进。

## 2026-10-12 增量：Agent 产包与原 Host/Surface 消费

- 普通 `extension_package` 沿原发行目录、调用授权和 Source/Storage 捕获 stage/apply；首次禁用且无 grant，更新保原能力审查与 candidate。原 ArtifactStore/Catalog/supervisor 独占字节、选择和执行事实，无第二安装器或回执权威。Catalog **58**、wire **18** 保持。
- 冷启动真实 FileRead/FileWrite→捕获→编译→认证启用→普通工具和实际 Surface watch/mount，继续 Model/Policy 两次同版本更新、坏挂载保旧、好更新释放、旧 pin 与新请求、GC/重开。冻结请求只在合法后续边界换目录，不为了验收撤销原绑定。
- 独审与整合闭合候选 context、捕获外编译配置、观察者篡改回执、发布等待旧 pin 环、多代无用保活及可选 UI/单调用取消共享选择；[本片证据](../reviews/runtime-authored-extensions-2026-10-12.md)分列真实整链、受控取消恢复、类型/构建及未验边界。显式 required Host+Surface 组、更广能力组合和其余两设计能力继续推进。

## 2026-10-12 增量：同一不可变扩展版本的源码读取

- 原 `runtime_contract` 与公开 query API 支持按需 UTF-8 源码页，使用原 selected/candidate artifact 与文件 hash；list/describe 仍纯元数据，不激活或物化包、不跟随可变 checkout。Catalog **58**、wire **18** 保持。
- 原 package/artifact owner 核精确版本、异步全文件校验、页边界和取消；结果仍走原工具/Policy/child 的 ContentStore 与历史。目录准入断开窗口和同 semver/schema 仅改实现时的旧 provider/新源码错误配对已修，后者由独审原发布 gate 复验。
- [有限验收与证据边界](../reviews/runtime-extension-source-2026-10-12.md)分别记录真实 stdio 整链、直接 Router 消费、类型、取消流与实际产品/平台未验范围。下一步仍须 Agent 产包→原授权候选→实际 Surface 挂载释放，以及更广合同/组合；源码查询不是这些生命周期的替代。

## 2026-10-12 增量：Web 跨层测试类型归属收口

- 旧 disk/editor Integration native test 改用既有 `#application-host` 边界：编译时是原 Host 新生成声明，运行时仍是原 Host source。Host Node 与 browser DOM 编译范围保持，测试体及 native 发现入口未变。
- 原完整 Web aggregate 现在先检查/生成 Host 声明，再检查 Host tests、browser 与 CLI；正式命令 exit 0，上一片记录的 113 条旧诊断已清零。独审用真实 consumer 的三条错误参数/DTO 验证仍能拒绝，未通过 any、扩大 lib 或排除测试吞错。
- [精确验收](../reviews/runtime-type-boundary-2026-10-12.md)区分类型闭合与仍未运行的产品 IPC fixture。Catalog 58/wire 18、全部生产行为与两设计剩余能力范围保持，下一片继续能力实现。

## 2026-10-12 增量：同源合同发现与真实调用工具目录

- 普通 `runtime_contract` 区分 `current_catalog` 的 service/method/event/UI slot 与 `accepted_run` 的原冻结工具。SDK `call.tools.list/describe` 本片才真正补齐，旧能力表的提前完成表述已纠正。Catalog **58**、私有 wire **18**。
- 查询复用原 manifest/routing/registry/workbench 与 live invocation；无 provider inspect/冷激活、无目录注入、无第二安装/授权目录。method/event 声明与激活一致，六 UI slot props 类型/schema 同源；未知合同和实际 mount 状态诚实表示。
- 原 client/认证 route、普通 broker/SDK/Policy/nested/child、结果与 GC 重开路径及独审与整合发现的真实边界修复见[本片记录](../reviews/runtime-contract-discovery-2026-10-12.md)。Host/UI 类型通过；完整 Web 类型仍有与 HEAD 源码逐条一致的 113 条旧跨层测试归属诊断，未标通过。全部 legacy service metadata、完整 API/实现源码查询、Agent 产包至实际挂载/释放和更深组合继续推进，未以此宣称扩展设计全部完成。

## 2026-10-12 增量：原来源的更多只读语言查询

- 原 Rust 工具声明新增 hover、工程/文档 symbols 与单查询双向 call hierarchy；既有三语言工具与显式用户数组保留，默认目录按原声明发现。Catalog **58**、私有 wire **17**。
- 原 source/binder/supervisor/executor 接三种本地来源；树形节点与 call 的 from/to/sites 分别保原资源授权和实际字节。Opaque item 仅本次查询私有，后续 RPC 仍检查当前 Run 权限/取消，不复用 editor token 或伪造 range revision。
- 真实 TypeScript 的 live/fixed/materialized、默认 child 和 Policy graph 消费及 GC 重开五条链已复验，结果与有限边界见[本片记录](../reviews/runtime-language-queries-2026-10-12.md)。其他语言/编辑器/草稿/远端、完整 nested rich-result 组合及外层验收不由本片自动成立。

## 2026-10-12 增量：固定工程语言视图与真实 child 消费

- fixed_branch 沿原 Storage 物化器准备完整的已捕获工程，Run 仍保原 source/revision；supervisor 独占引用/共享准备，派生目录与原 Run 权限分开。Catalog **58**、私有 wire **16**。
- 原语言工具目录现支持默认只读 Retrieval 与 Worker；原 Run 必须准入该后端所需的完整工程读取范围，不因 Host service context 获得额外路径或 process 工具。
- 真正 TypeScript 主链覆盖固定/不同 live 的依赖与配置、同 revision 共享/新 revision 隔离、精确排空与目录回收、GC 后重开新查询；实际 child dispatch/Run/report 分别走固定和物化源。Worker code-result 发布并未由本片假称完成。
- 四个旧 continuation startup fixture 已按原 adapter/store 修复并精确归因。当前复验与边界见[本片记录](../reviews/runtime-fixed-language-2026-10-12.md)；外部 provider environment、远端来源、全平台/产品验证与其余设计能力仍分别推进。

## 2026-10-12 增量：物化来源的原语言服务

- 原三语言工具接实际 materialized working copy，共用 SourceQueryOwner、原 Documents 注册/信任、Run grant、supervisor 与 Rust 进程。原配置身份不充当 cwd，dependency 明确 live；Catalog **58**、私有 wire **15**直接拒旧。
- source 工具目录来自 Rust 原声明，删 Host 重复名单；Worker 默认包含 Physical 语言工具，只读 Retrieval 默认保持兼容。显式用户数组由原准入给可操作诊断，不静默重写。
- query 取消、Run 引用、撤权 ACK 与实际停止分开；child capture 等同 owner 排空及原 writer 屏障。真实整链和独审闭合 file.read 早返回、失败 watcher 恢复、无关 view 互等、较早终态引用的退役关联、跨语言取消误关 watch。
- 当前真实 TypeScript/源码配置/15份原历史/重开、独立反例及共享消费者证据见[本片记录](../reviews/runtime-source-language-2026-10-12.md)。冷 alias、diagnostics 测试 gate、主 Run 实际执行与 child 目录准入分别留证；固定闭包、实际 child LSP 执行、远端来源和完整平台/产品验收仍需推进。

## 2026-10-11 整合验收

本次按两份设计复核最新实现，并运行 Windows Host → IPC → Rust 的实际业务链路。
修复控制/正文请求额度归属不一致、重复工具/字段名单漂移、来源继承、子任务交接、授权重建、
Windows 路径、策略隐式选择及工作区结果对象转交；已结束接续项收进历史。
详见[整合验收](../reviews/runtime-2026-10-11.md)。分层通过记录不等于完整交付或性能目标已达成；
两设计余项与用户负责最终切换的分工保持。

用户完成本轮验收并推送 `3dcd65ac` 后，已明确恢复后续实现；下文 reader 阶段的暂停是历史状态。
本轮先处理验收指出的执行预设与设置入口，以下增量记录该片结果；随后继续日志与其余能力。

## 2026-10-12 增量：固定与物化来源的语义候选

- 原 Source owner 枚举实际固定 revision 或 managed copy；配置目录只提供集合限制，不读取旧 live 根。原 units/packing、已捕获 publication 的精确 revision/recipe/space 与差分缓存共同形成 query-owned transient view，完整遮蔽不属于该来源的旧行，不新增按分支复制的索引库。
- 冷准备延迟至 semantic search，原关键词工作可独立推进。实际 document/query HTTP 共用原 InferenceCall/Catalog/Goal；完整文件版本在真实外发和候选安装处检查，短授权独立重复。缓存只复用派生资产，不复用旧付费请求；换 key 保兼容 document 数值，query cache 仍分账号。
- semantic-only 原生产至 Rust history、真实 working copy 修改/陈旧窗口、cheap search 与取消排空、原 Storage/Catalog 重开及共享 owner 证据见[本片记录](../reviews/runtime-fixed-semantic-2026-10-12.md)。本片没有建立持久的固定来源索引；完整 LSP/远端来源、本地 native embedding 与其余设计能力继续推进。

## 2026-10-12 增量：原查询 embedding 与统一推理会话

- native query embedding 接原 Catalog/Goal，与同查询的 decision/rerank/Explore 共用一次真实调用准入和连续 ordinal。原配置、凭据、egress 与 wire parser 保持，后台 index ledger 只管 index-build，移除 retrieval response 重复 receipt；Catalog **58** 保持、私有 wire **14**直接拒旧。
- 原 usage 先于向量有效性结算，total-only 不改成 input、缺 output 不补零；原 Goal 预算未知门与 not-dispatched 事实保留。带当前来源/账号授权的 warm cache 不产生假 HTTP/收费；恢复不重发原付费请求。query observer 可结束，原 session 保实际 HTTP/body/receipt 寿命并拒晚到 scheduler 新工作。
- 原真实 scan/publication、semantic+rerank 与 semantic+FD+Explore 组合、取消、Catalog 重开、背景索引恢复及共享 SDK/receipt 故障证据见[本片记录](../reviews/runtime-query-embedding-2026-10-12.md)。这是 non-live semantic 的必要前置片，固定/物化 semantic、完整 LSP/远端来源仍未完成，未提前移除 unsupported 声明。

## 2026-10-12 增量：原来源生命周期与公开诊断

- fixed/materialized 的公开新输入、Context/指令、原 Run 重绑及 child 分支准备沿 Documents 持久注册与当前信任、Storage 精确 revision/pin；不再为元数据准入要求旧 live 目录。首次捕获、live 与真实文件效果仍保物理根检查，配置命名空间不成为执行 cwd。
- 原 AgentRuntimeClient 在 fresh source grant 前、来源准备后及冷准备完成的实际 start RPC 前调用同一 Documents owner；撤权拒绝新工作并释放已签 grant/凭据。child 原 pin/分支清理按 Catalog 释放事实进行；研究输入 pin 的原 receipt 清理也不被撤权阻断，真实 revision pin producer 已对齐 Rust 合同。资源正文只在真实 Context 消费时读取。
- materialized 继续使用原 environment Run 派生的实际 managed copy，缺失或换成另一 managed key 的链接均明确失败，不自动重建。来源诊断沿原私有 wire **13**、公开 client/route、持久 launch/child 和 UI；Catalog **58** 无新增记录域。
- 原公开入口、Context/Memory/RunAssembly、Storage/Catalog 真实重开和受控模型的证据见[本片验收](../reviews/runtime-source-lifecycle-2026-10-12.md)。完整 source semantic/LSP、远端及其余设计能力继续推进；完整产品 IPC/平台与用户最终迁移保持各自边界。

## 2026-10-12 增量：固定与物化来源的原检索

- 普通 code_retrieval 直接消费原 LaunchSource/ToolBinding/grant；固定 revision 沿原 compute/tree/blob，materialized 读真实 working copy，完整分页与原 Documents 解码保持。私有 wire **12** 替换旧 live-only 查询字段，Catalog **58** 无新记录域。
- 原 source/rerank/fast-decision/Explore LLM 复用同一 source adapter。配置 routing 使用持久 workspace 身份；不因原 live 目录改名去读另一根。外发前版本由原模型 guard 校验，Host 最后仅短授权，Rust 唯一重建 spans/revision/required groups。
- 原 builtin 声明将 code_retrieval 作为 Source 工具开放 Worker/Retrieval 缺省目录，固定 policy 读保精确来源；显式用户数组不被改写。非 live 结构只用原 tree-sitter，selected semantic 未支持有真实说明，不回退到 live LSP/索引。
- 源版本、真实 CAS working copy、child 派发/source/新 Run、原模型排空/Goal 与历史/GC 的有限证据见[本片验收](../reviews/runtime-source-retrieval-2026-10-12.md)。完整 source semantic/LSP、远端、后述其余设计能力与外层验收继续推进；原新输入/重绑定的目录依赖单列，不以运行中 query 验收替代。

## 2026-10-12 增量：原 Explore LLM 规划与联合选材

- Native live_root code_retrieval 接原 Explore slot/模型配置/凭据与原生 adapter。Pi 与 Native 共用原完整渐进规划、联合选择、replacement/retained/显式空选和 followup；auto 的 LLM 选材与 fast-decision actions 各守自身 Off/凭据边界，不互相接管付费职责。
- 原 inference ledger 统一 query session 与全部真实请求 ordinal；调用委派和 Kernel 实际执行 owner 分开。Catalog **58**、wire **11**直接拒旧，原 ContentStore 保 request/snapshot/provider items/opaque/raw usage，原 Goal 保真实用量与未知屏障，没有第二推理任务或计量库。
- required group 沿 Host 原 pack 与 Rust 真实字节重建，版本/范围/预算不截成残组。普通 source 排序保原语义；原取消可先释放 query，生成实际排空才有停止事实，恢复不重放任何已记录的收费发生项。
- 有限跨层验收与复跑入口见[本片记录](../reviews/runtime-explore-llm-2026-10-12.md)。真实组合、两条独审反例修复和同源打包分别留证。固定/物化/远端来源、其他用途及完整平台/产品验收仍分别推进；用户负责最终默认切换与全面迁移。

## 2026-10-12 增量：原渐进检索 fast-decision

- Native live_root code_retrieval 复用原 ExploreQueryRun/fast-decision loop，在 finish 前判断实际材料和原 action、执行 followup 并接后续批次。原 selector、purpose/default/Off、Documents/grant 与 source owner 保持，未造第二 planner 或权限目录。
- classifier 同一 query session 延续所有真实 HTTP ordinal，research_decide 也迁入该唯一接口。逐批用量只投影该批原 receipt，未知维度不补零；原 Catalog/Goal 继续唯一计费，Catalog **57**、wire **10** 无变化。
- 失败批不应用答案/动作，前批成功选择仍保留；实际 source、配置/凭据撤权和 Stop 均抑制新工作，HTTP 真正排空后才结算。材料只来自原签发 view，附送的未询问路径不获权限。
- 实际来源/action/Storage/Goal/原历史/GC重开和公开取消、独立审查及可复跑边界见[本片验收](../reviews/runtime-progressive-retrieval-2026-10-12.md)。Native Explore LLM、固定/物化/远端检索、其余用途/组合和外层验收仍分别推进；用户负责最终默认切换与全面迁移。

## 2026-10-12 增量：live-root 检索的原 rerank

- 原 `code_retrieval` model stage 接 dedicated http-rerank，实际 Documents/Storage/grant、版本/行段和 Rust 最终正文重建保持。原 codeRetrieval 选择器与 rerank 连接唯一，extension plan 不再兼任模型设置；显式尚不支持的用途有真实投影。
- Catalog **57**、wire **10**；decision/rerank 共享原 HTTP lifecycle。廉价读的实际 invocation scope 委派查询身份，HTTP child 独立持 Operation/Goal/回执；不造持久父工具或第二计量账。真实 handoff 允许查询及时取消，HTTP 未排空仍保 pending，迟到回执不复活结果。
- 部分排名保真实零分及未评分项原序；原 source/credential/明确 Off 继续约束外发。common rerank raw usage/meta 全保留，未定义 input/output 的协议保 Missing，不把总 token 或缺省零当计量。
- 当前真实组合、取消阻断修复、独立消费者审查和复跑边界见[本片验收](../reviews/runtime-retrieval-rerank-2026-10-12.md)。仍需其余检索/材料模型消费者、协议特定已知计量和后述全设计余项；最终默认切换/Pi 删除/资产迁移由用户验收后负责。

## 2026-10-12 增量：llama.cpp decision 的准备与真实计算

- 原 llama.cpp SDK 接普通 `research_decide`，沿同一配置/credential/egress/材料与 Catalog/Goal owner。Catalog **56**、wire **9**；每个真实 HTTP 保原 Operation，准备请求仍受控制但不伪造模型计费，completion 的重试/概率深度扩展逐次记真实 raw usage。
- 单协议路线声明冻结原 server-root；真实 keyless 连接在原凭据 owner 内绑定，错误 key/helper 不降级匿名。SDK label promise 限单请求，已完成答案不会被后题失败清掉；真实 body 排空先于返回。原 Pi custom classifier route/usage 保留。
- 实际 candidate prompt 缺目标、SDK 跨请求取消污染、并发准备提前返回、Host keyless 前置拒绝和冷安装 MCP patch offset 均已最小修复。普通部分失败保真实零分/原顺序/missing，Stop/撤权仍抑制答案且保费用。
- 原 SDK/Host/实际 Catalog/Goal/stdout 组合、GC/重开、公开精确 Stop 与独审原失败路径的有限证据见[本片验收](../reviews/runtime-llama-decisions-2026-10-12.md)。受控 HTTP 不证明真实模型/账户/性能，完整产品 IPC 与全部平台仍单列。
- 接续 rerank、其余用途/环境/Bot、来源/检索/组合能力。两份设计整体尚未完成；最终默认切换、Pi 删除和资产全面迁移仍由用户验收后负责。

## 2026-10-12 增量：独立 decision 与原推理回执

- 普通 `research_decide` 单声明接原 TypeSafe/Cloudflare 分类器与真实材料/PDF reader，原 purpose 配置与凭据 owner 独立于主聊天模型。实际 reader hash/range/派生来源及正文预算进入材料身份，原 ACL 在派发前重核。
- 原 Catalog **55**、wire **9**；每次 SDK HTTP（包括合法重试）均有原 Operation/执行 owner/Goal，原始正文锁外持久化，当前与历史 GC roots 保完整回执。用量先于答案解析/取消保存，缺失不补零；新收费工作受预算与 Unknown 屏障约束。
- 精确 Stop 等待真实 HTTP/body 排空，body 已完成后的取消仍传到工具投影但保留费用；发布失败沿原短 Missing 屏障与原 body 重投，不再执行 HTTP。恢复仅接确切原 owner 细化，不重播整批收费请求。
- 原材料→decision→历史/Goal/GC/重开、public client/认证 route→精确取消、SDK 重试与原发布失败窗口的证据见[本片验收](../reviews/runtime-background-decisions-2026-10-12.md)。Policy/nested/child 本轮为实际源码消费者追踪，旧 Pi broker 失败投影、外部 provider 与完整产品 IPC 仍保各自边界。
- 接续 Native Llama、rerank 与其余用途/环境/Bot、来源/检索/组合能力。两设计整体与外层验收尚未完成；最终默认切换/Pi 删除/资产迁移仍由用户负责。

## 2026-10-12 增量：原学术 metadata 与普通工具

- 独立普通 builtin 的单声明接原 OpenAlex/Semantic Scholar `research.search` owner，保 search/paper/relations、provider identity、单页 cursor 与内容可用性。metadata 不冒充纸本正文；明确选入材料或获取 URL 才走原材料/PDF owner。
- 原 extension policy/调用/Run/Operation/config 仍唯一准入；只冻结原 scholarly enabled 设置，不依赖无关 Web/auth 配置或 Pi session。模型、Policy 与 source-less child 复用同一执行合同，普通结果/历史/GC 仍唯一 ContentStore。
- 独审五条原失败链已复验修复：OA 首 cursor、S2 坏 offset、畸形响应假空、取消后追加请求和 HTTP 错误正文未排空；合法缺省字段保留。实际安装入口、明确材料/PDF公共读取与重开的有限证据见[本片验收](../reviews/runtime-scholarly-discovery-2026-10-12.md)。
- 继续原 fast-decision/rerank 的独立推理用途、Goal/计量与真实材料权限，而非套主聊天模型；环境/Bot、来源/检索/上下文/provider 等余能力仍未完。最终产品/平台验收与用户全面迁移分别保留。

## 2026-10-12 增量：原材料集合与明确分享

- 普通 `materials` 单声明接同一原 collection domain，Pi 仅适配原 session；实际 Catalog Thread/family 生成 scope。私有材料 service grant 只在可信 owner 内部使用，原材料 ACL 唯一，maintenance 不含写能力。持久集合只读共享、写入仍限原 owner；同家系不自动读私有材料。
- 原 Storage `record.put`/operation receipt 是唯一 mutation 事实。调用持短身份投影，URL/正文/搜索不持 mutation serializer；取消、未知与真实写者停止分开。原 private LateReceipt 对账旧原调用，无重新 fetch/put 或伪旧 lease，原 Unknown 历史不覆写。
- 原 PDF body/source 引用与显式再次转授、sender 清理/后续 orphan reconciliation 一起闭合。独审原四反例、paper 附猜测 snapshot 提权、重定向来源丢失，以及实核 failed-CAS 回执归属丢失均最小修复并复验。
- 实际普通模型/Policy、source-less child、原 Storage、client/认证 route/PDF reader、GC/完整重开与丢提交回应对账的范围见[本片验收](../reviews/runtime-material-collections-2026-10-12.md)。本片没有新增 collection browser/member 按钮/公开 mutation API；实际材料结果的 snapshot 可由既有 reader 使用，document_read 的真实 PDF 投影仍接原按钮。
- 接续学术/decision、其余环境/Bot、来源/检索/上下文/provider 能力；两设计整体未完，完整产品/平台证据与用户负责最终迁移仍分别保留。

## 2026-10-12 增量：本地与实验 PDF 原来源

- 普通 `document_read` 直接复用原 Run source grant/Storage：fixed 精确分支版本、live 原 Documents 注册、materialized 当前工作副本；不要求另选 file/experiment 工具，不伪造来源。原临时 capture owner、分页读取与授权释放按实际排空。
- 实验产物沿原 Catalog research scope 与 ExperimentService 读取，材料归实际 reader Thread。公开 `readArtifact` 带原 sourceRunId，Research ArtifactRow 首次导入后复用 snapshot/共享 PDF reader；框选回到现有本 Thread 草稿。原研究 source-less 限制仍明确报错，未开放公共任意路径读取。
- 独审实际复现并修复大 PDF 在材料库重读时超过单帧，以及 Research PDF 缺失选区入草稿动作。原材料 owner 分页同 immutable record proof，无总长上限或第二数据权威；原草稿 callback 保 Thread/Host/source Run fence。
- 本片证据与边界见[PDF 原来源验收](../reviews/runtime-pdf-sources-2026-10-12.md)。模型/策略、三个来源、原实验产物/public reader/GC/重开与取消分别验证；完整产品 IPC、外部计算产物生产、全部 family/nested 组合与 OCR/字体质量未由本片建立。
- 接续材料集合/分享、学术/decision 与其余环境/Bot、来源/检索/上下文/provider 能力；两设计整体未完，用户仍负责最终默认切换/Pi 删除与资产迁移。

## 2026-10-12 增量：原 Web 工具与固定 PDF 材料

- 普通 builtin 单声明接入 `websearch`、`webfetch`、`document_read`，复用原搜索/egress/HTML/PDF/材料与 Rust Storage owner。实际 Thread/family 生成无源逻辑 scope；窄 grant 与 record 仍归真实 Thread，家系/可猜 snapshot 不自动授跨 Thread 读取。接受时冻结配置、派发时取原凭据，公共读取重核当前策略。
- HTTP/HTML/PDF 只共享原内容/分析；各活跃调用独立提交材料，最后 waiter 与已开始 commit 按实际排空。原材料在 Run 完成、GC、Host/Storage 重开后保留，显式 refresh 不覆旧 snapshot；PDF 图片进入同一 typed media/原 provider 编译。
- 独审三条实际失败路径已复验修复：网页 find 静默忽略、倒置行范围假成功、免凭据默认搜索误依赖无关 auth。共享原纯文本选择器且保 position/find 原行号；无第二算法、权限名单或推测性 PDF 校验。Web 配置错误仅影响实际 Web 选择。
- 真实 client→认证 route→原 reader 与共享 UI 贯通，无 Pi session。原生 engine/installed builtin/权限/Storage/Policy/公开读/重开整链、独立取消探针、旧 Pi/UI 与同源构建分层通过；见[有限验收与复跑](../reviews/runtime-web-materials-2026-10-12.md)。未由此片证明全部 child/nested Web 组合、真外站、产品 IPC、OCR/字体质量或平台性能。
- 后续优先原本地/实验 PDF ingestion、材料集合/分享、学术/decision 与其余环境/Bot、来源/检索/上下文/provider 能力；完整两设计未完成，最终默认切换、Pi 删除与资产迁移仍由用户验收后负责。

## 2026-10-12 增量：原 MCP sampling 与双重用户审查

- 原 authority/client 在 initialize 前只协商 basic sampling，真实 HTTP 原响应流或 accepted Task 保 Operation/endpoint/权限关联。原 Catalog **54**、wire **9**直接拒旧；原 interaction 链接真实独立 generation Operation，唯一 RunSupervisor 执行，未造 ModelStep、Run、主会话历史或第二推理服务。
- 第一次公开 review 审改完整请求并从真实模型 owner 明确选模型，原 adapter/serializer/private credential 执行；第二次确认后才返原 server。采样保自身 system/user/assistant 角色，但不导入主上下文或工具；原 tool origin 的 FrozenGoal 仍按原账核预算、pending 与实录/缺失计量。Task 父 Run 自然结束不误释放独立 operation credential，原撤权/取消/恢复门仍在。
- 六处真实接缝已修并原条件复验：取消先丢已到达输出；Goal 预算/用量漏账；模型目录前置拒绝把 UI 锁成发送未知；同键改模型冲突被旧结果吞掉；短 token cap 破坏已选 thinking 预算；新 sampling 角色映射改变旧 policy typed 输出角色。没有用重复名单、第二计量库或自动收费重放兜底。
- 原 MCP **15** 组真实组合、provider/Goal/HostJob/公共入口/UI 回归与独立原红探针按同冻结源通过；fresh wire9 kernel、Host/Web/CLI/cloud 布局已核。有限合同、复跑入口、SHA 与分层证据见[本片验收](../reviews/runtime-mcp-sampling-2026-10-11.md)。当前是 text/image 输入、text 输出；tools/context/audio/provider metadata/task-augmented sampling 明确不支持，不把有限实现称全协议或整产品验收。
- 后续继续两设计中的环境/Web/材料/PDF/学术/Bot、来源/检索/上下文/provider 等能力及必要 MCP 组合；先依据真实产品 owner 复核下一片，不按提交数推完成率。最终默认切换、Pi 删除与资产迁移仍交用户验收后负责。

## 2026-10-12 增量：原 RPC 错误的 MCP URL 要求

- 原 SDK pending-response 位置保完整 `-32042` 与真实 outgoing ID，普通工具、资源/prompt、显式订阅清理、Task 创建/get/result/cancel 同合同；不伪造 inbound request。Catalog **53**、wire **8**直接拒旧，正文仍唯一 ContentStore，共享错误正文一次 stage、多个短记录原子发布；公开分页不重复携带完整错误。
- 实际 client/认证 route/Adapter/UI 保原 Thread 身份，本地选择、URL 明确打开、远端完成和原错误/Unknown 回执分开。自然失败后可复核，撤权/重开后历史仍可读答但不恢复旧自动关联。非终态 Task 提前 result 错误保诊断，不缓存成未来结果；已知终态原错误仍是最终错误。
- 四条实际失败链已最小修复并原探针复验：取消/source/Goal/reopen 后迟到完成越过 owner fence；同 client 冲突 ID 被第三 RPC 重绑；自然 Task 终态误撤回已接受 URL completion；已可见错误的显式重查被旧 Host ACK 吞掉。普通在途 get 合法 join 保留，无猜测重放或新权限 owner。
- 最终原 MCP **14** 条 Rust/Host/SDK/公共消费链、原 Goal/HostJob、SDK/Host/UI/完整类型，以及独审 native/wire/public 原探针分层通过。fresh wire8 二进制、Host/Web 与交付布局沿同冻结源核验；完整证据与复跑见[本片验收](../reviews/runtime-mcp-error-interactions-2026-10-11.md)。完整产品 IPC、真实桌面/浏览器/外部 provider 和平台性能未由受控 peer 证明。
- 接续 sampling 及其真实 provider/用户 review 合同，再推进环境/Web/材料/PDF/学术/Bot、来源/检索/上下文/provider 余能力。两设计整体未完，最终默认切换/Pi/资产迁移仍交用户验收后负责。

## 2026-10-11 增量：原 MCP 用户交互

- 原 authority/实际 client 在 initialize 前按已安装 receiver 协商 form/URL；Pi 先连、Native 后用仍共用原连接。HTTP 原响应流与已受理 Task 保确切关联，已知 Task 优先；无关联普通 stdio 明确不可用，不猜当前 Thread。
- 原 Catalog **52** 短记录连接真实 Operation，request/presentation/response 经同 ContentStore/publication/GC；wire **7**直接拒旧。选择、发送准入、发送确认/未知与 URL 外部完成分开，不造 User/history、工具权限、Wait 或旧 Run 接续。原 source/Goal/cancel/client/grant 继续约束发送，Task 可在父 Run 完成后交互。
- 实际公开 client/认证 route/UI 按 Thread/branch 分页读答，保 false/0/空串/枚举数组，URL 只经明确点击打开。原 HTTP/stdio→Rust、PolicyAction、无源 child 和已安装 SDK nested 消费链通过；原共享 MCP 11 链、Goal/HostJob、公开消费者、独审失败复验及同源打包完成。准确有限范围见[本片验收](../reviews/runtime-mcp-interactions-2026-10-11.md)，未以局部测试量宣称完整交付。
- 随后仍需 sampling、独立 error-source URL 交互等 MCP 合同，再继续环境/Web/材料/PDF/学术/Bot、来源/检索/上下文/provider 余能力。用户负责验收后的全面迁移与默认切换。

## 2026-10-11 增量：原 MCP 资源观察

- 原 schema 声明 subscribe/unsubscribe，finite Result/Thread 的原 Operation 保 observer facet；真实 McpAuthority/client/URI 共享 holder、配置/grant 与 Catalog/ContentStore/输入队列仍各有唯一 owner。Catalog **51**、input **7**、wire **6**直接拒旧，无第二任务库或兼容 reader。
- 通知只成为被动 Environment 事实，不自动读 URI 或创建 Run。精确 URI 保原 params；无法归属的子资源通知只给当前 holder 短诊断，不扩散其他 URI/metadata。原模型、policy、无源 child 与安装 SDK nested 都用真实origin；共享 observer 一方退出不停止另一方。
- 原 source 释放前先短 fence、同步 detach、确认本地元数据，慢正文/remote cleanup 不阻 unpin；原 tree/Goal Stop 包含终态 Run observer，首次创建复用原 FrozenGoal authority。已收 ACK、原 Unknown 交换、local release/远端 ACK/unknown 各自保留；同身份本地发布和 reopen gap 不冒称远端重放。
- 实际通知进下一模型的 canonical history ID、普通配置换代旧 holder、清理后撤权重验、Goal 结束/显式新 Goal handoff、本地 begin 未派发、已知 ACK 自动对账/有限 RPC 停止证据及迟到 snapshot 清理倒退均已修后复验。独审接受有限两工具合同；真实资源四链与原 Tasks 三链、40条受影响runtime回归、Host34/UI77、完整types及fresh wire6二进制/Host/布局证据分别见[本片验收](../reviews/runtime-mcp-resources-2026-10-11.md)。历史Tasks的Pi生产build与full test types表述也已纠正，局部通过不代表两设计完成。
- 接续 MCP 服务端交互，再沿两总设计推进环境/Web/材料/PDF/学术/Bot、来源/检索/上下文/provider 余能力。完整产品/外部部署/平台性能验收及用户负责最终迁移的边界不变。

## 2026-10-11 增量：原 MCP Tasks 与持久结果观察

- 原 McpAuthority/installed client 与 Catalog Operation/HostJob 共同接 negotiated Tasks，无第二任务库、transport 或 grant owner。schema 单声明 required/optional/forbidden 双 gate 与 start/get/wait/cancel typed routes；HostJob subject 明确 Workspace/MCP，global/source-less 不伪造来源。Catalog **50**、wire **5**直接拒旧，其他正文/策略域保持。
- 接受释放原 server dispatch 占用而非远端停止；completed/failed 状态、最终结果、cancel ACK/Unknown 独立。原 caller acceptance/已交 Unknown 与迟到完整 JSON/媒体分开，原 Wait/followup、公开 holder、历史/GC/reopen 消费同一事实。受理前后丢本地回应均只对账原 ID，不重发 tools/call 或借列表猜任务。
- 独审五条原失败链已修后复验：roots related-task metadata、管理工具原权限、新 Wait 误取旧 unavailable、Wait typed parts 索引错位、取消控制失败污染结果观察。原短发布 queue 保当前事实，实际网络 get/result/cancel 独立；input_required 仅原 roots 可用，sampling/elicitation 尚未宣称支持。
- 三条真实 Engine/Host/实际 stdio 整链覆盖模型/策略、source-less child、实际安装 SDK nested、Run退役/并发取消/重开/Wait媒体，以及提交前后丢受理回应。95 条受影响原消费者与47条Catalog回归、全runtime目标编译、Host/SDK/UI/认证媒体路由、真实二进制/Host与cloud布局分别通过；准确证据及边界见[本片验收](../reviews/runtime-mcp-tasks-2026-10-11.md)。完整产品socket IPC/桌面/外部账号和平台性能验收保持待用户环境补。
- 接续 MCP 资源订阅/更新和服务端交互，再沿两总设计推进环境/Web/材料/PDF/学术/Bot、来源/检索/上下文/provider 余能力。两设计整体未完，最终默认切换、Pi与资产迁移仍交用户验收后负责。

## 2026-10-11 增量：原 MCP 内容、资源与提示

- 原唯一 McpAuthority/connection 接入资源与模板分页、资源读取、提示分页/get；schema 单声明生成六个 helper 与 typed routes，原 Rust/child/恢复绑定不再手抄名字判断。配置、OAuth/grant、权限与旧 retained contribution 保原 owner；Catalog **49**、wire **4**直接拒旧，content/manifest/policy 未改。
- 协议明确字段映射同一有序 Text/Media，原 URI/role/annotations/_meta/opaque JSON 完整保留，不猜图、不自动取 resource link，也不把 prompt role 升为指令。完整页顶层 metadata、prompt descriptor/通知失效与迟到 page、service-only 无源 child/作用域/恢复都沿实际消费者。
- 本地真实 admission 错误经原 Host/Rust 桥成为可操作短码，远端伪码/错误正文不获信任。独审确证并修复跳过自动重试同时漏掉 HTTP session 失效 owner 的接缝：单次请求不重放、旧在途不误关，真实 expired-session RPC 停止与 Unknown 效果分开。默认策略仍停在 Unknown，显式策略选择的新操作才验证同 server 占用释放与新 session 成功。
- 原 Engine → Host/PermissionService → 实际 MCP stdio → 原 provider 编译、PolicyAction、公开内容读取、fork/GC/reopen 整链通过；HTTP 使用原 transport 的受控 fetch，无 listener。定向运行时/Host、SDK 原 owner、单独无源 child、类型/协议/实际 bundle 与独审证据见[本片验收](../reviews/runtime-mcp-content-2026-10-11.md)。局部条目不替代整设计或产品/平台最终验收。
- MCP Tasks/持久远端任务、资源订阅/更新和服务端交互仍是随后能力，Web/材料/Bot、其余来源/检索/上下文/provider 也继续按总设计推进；默认切换与全面迁移交用户验收后负责。

## 2026-10-11 增量：原工具与持久脚本的 typed media

- 单一 `OutputBody` 保 opaque data 与有序 Text/Media；Incoming 只有字节/MIME，原调用/输入 owner 赋真实来源，Stored 引用既有 ContentStore，worker 才解引用。Computer 抽取同次 observation/action 截图并保 metadata；Node 显式 emitImage、普通 Result SDK call.output 与原结果/回执共用正文，print/普通 JSON 不猜图，nested 只显式转出、不造模型调用。
- 原 provider serializer 真正编译图片块，Chat/Google 在完整原工具批次后附图；无能力/MIME 不支持明确失败。原 publication、typed manifest dependencies、输入修订、event/family/policy/child holder、fork/context/GC/reopen 一起闭合，无自由 hash 读取或另建媒体库。Catalog **48**、content **4**、manifest **2**、wire **3**、policy **4**直接替换内部格式，普通默认与外部资产不迁移。
- typed Deliver 的原 child report、后继 execution 和 parent fork 经过同一报告与媒体 owner，User/client/认证 route/共享 UI 保精确身份、分页、取消和错误。五策略示例、原安装消费者与保留 Pi evaluator 一起接新合同；MCP 图片/audio/resource producer 尚未由此片接入。
- 真实组合抓到内容格式写读不一致、typed child report 漏消费、managed Job 被送进 HostJob 专用 reader，以及 struct/Value 编码不同误拒原 None 图片回执，均已按原 owner 修复。独审另复现坏 base64 擦除已确认效果；SDK 在登记前拒绝，Rust 仅将未准入媒体替同位置诊断，保原 data/outcome/effect/停止事实及有效 parts。HostJob 晚到 acceptance_ref 与首次 Unknown 交换保持独立，不放宽效果验证。
- Runtime **461/0，2 ignored、9 socket excluded**；kernel **148/0，18 ignored、3 socket excluded**。准确 fresh binary 的原 Node **6**、child guardian **1**、进程/接续 **2**全部通过；新增整链真实进入下一 Responses 请求，再经 family/fork/GC/关闭重开读原图。独审有限 producer/provider/Catalog/context/client/late 反例修后通过；完整同源、公开消费者、SDK/UI、真实 bundle 与复跑见[本片验收](../reviews/runtime-typed-media-2026-10-11.md)。不扩大为真桌面、产品 socket IPC、外部模型、浏览器或平台验收。
- 继续 MCP 实际内容与剩余 resources/prompts/Tasks、Web/材料/PDF/学术/Bot、环境与来源/检索/上下文/provider 等设计能力。两设计总体与性能/产品验收未完成；用户最终默认切换/Pi 删除及全面资产迁移分工保持。

## 2026-10-11 增量：受管持久 JavaScript 环境

- 发行普通 `script_open/run/close` 沿原 SDK/broker/冻结工具调用进入真实 Node、Storage 与 guardian；open 是 Run 所属 Environment Job，各 cell 保独立 Operation。共享 Node REPL 保词法/对象/完整 async 单元与原嵌套工具，内层 memory 已提交后外层报错仍进入下一真实请求；不回放丢失 heap，不把进程隔离称作 OS 沙箱。
- 单份 `ToolSchema.requirements` 声明真实 source/physical/live 与 process 依赖，目录/child/原 grant 一起消费。仅选择 scripts 也可运行，不要求另外勾选 process/file 工具；warm/cold/dynamic 自动发现按原 source 局部不可用，显式 required 不降级。坏 Node 配置仅影响自身工具。Catalog **47**、Kernel wire **2** 直接更新内部合同，打包读取同一版本源。
- 树停止与已受理 Host callback 排空分开；同步死循环可由原 guardian 停止，held callback 不被冒充结束。精确 policy node Stop 绑定同一原 token；Run 结束只收所属环境，独立 Thread Job 保原寿命。重复 close 复用已确认原终态，Unknown 留原环境而不复制控制调用 writer；Computer hook 只跟真实当前环境/desktop。
- 原合法 fixed 父→isolated_write 子任务因过早 source 校验曾失败，已把非执行 ChildTask 意图的结构读写与 Ready 后真实 Run 全校验分清，未伪造 source/改变父夹具。原 child guardian 的真实派生、可写子/孙子、树 Stop 与固定结果重跑通过；旧手工 process fixture 补回原 bound 的 typed association 前置，不放宽产品屏障。
- 原跨 owner Node **5 条**、真实 child guardian **1 条**、原进程输入/接续 **2 条**修后通过；完整原生、原 installed scripts broker、Host/Pi/UI/包装证据及可复跑命令见[本片验收](../reviews/runtime-managed-scripts-2026-10-11.md)。Node 24 public REPL 的单点 `await Promise.reject(null)` 歧义明确保留；完整产品 IPC、真桌面/远端/跨平台包与 child-script 全链未由这些测试证明。
- 接续 typed media/图片等环境能力，以及 Web/材料/Bot、MCP 剩余合同、来源/检索/上下文/provider 和性能/产品验收。两设计整体仍未完成；用户验收后自行全面迁移、默认切换与 Pi/资产处理的分工不变。

## 2026-10-11 增量：原真实嵌套工具调用

- 普通 SDK `call.tools.invoke` 经实际 broker/Host 活调用进入原冻结工具目录；真实 `NestedCall` 保父 Operation，不伪造模型 request/工具配对，也不复制 enabled 名单或 grant。完整参数只由 Rust decoder 判合法，父身份、source、epoch 和 executor 来自原 scope；Model/Policy/Nested 共用单调用执行、授权、资源与结算 owner。Catalog **46**直接拒旧。
- scope 先关闭新准入，再等实际已注册调用；父取消与精确内层 Stop 保实际 token。已返回 Unknown 与未返回 foreground 分开，原内层 Operation/occupancy 等自身证据，外层不复制永久未知屏障。独立 Job 保原寿命；纯读仍轻路径。原记忆提交/下一请求事实/重开不依赖扩展输出，即使外层随后失败也保真实提交。
- 原协议额度在完整 nested body 已交实际worker后归还，保原 pending/取消/最终回执；窗口2并发及深一层可继续原permission/domain请求。原family/source/dispatch/Goal/计划/检索与Host公开消费者一起接新origin，安装示例用真实SDK声明与回执。
- 实际安装示例/broker/Host memory owner，以及真实child Engine/MemoryTools→同Host memory owner两段交叉验收分别注明受控边界；独审真实question Job早答/外层完成后可答、无源child Computer原assignment/拒绝和pending/Unknown证据分列。Runtime最终458、kernel150/12ignored与显式memory/fresh guardian各1，Host24+7、types/协议/真实bundle通过；原失败与修后范围见[嵌套工具验收](../reviews/runtime-nested-tools-2026-10-11.md)。完整产品socket IPC仍待外部验收。
- 本片是持久脚本的必要前置。接着实现原选定环境/进程owner下的持久async单元格与绑定寿命、typed media实际模型消费，再继续两设计其余领域；没有将任意Host Node权限包装成Computer-only沙箱。用户最终迁移分工保持。

## 2026-10-11 校正：辅助作业来源与实际执行分支

- 真实 producer 与公开 API 核实：ContextJob 的 `request.branch_id` 是摘要来源，actual Run 固定在独立 context-job Thread/branch。上一片“同 branch 辅助 Run 误选已修复”的文字证据不成立；原测试只证明真实 helper 与 handback 共存，未证明同 branch。
- 不开展据此推测的 selector 大改。只移除 shared latest_run 没有实际触发依据的 context_jobs 排除查询，两原回归明确断言来源与实际执行身份不同；共用读取接口保留，不新增格式/状态/owner。原输入/来源/模型继承、followup/calendar/Goal/公开projection 的真实 API 探针均正常，辅助目的、Goal归属与恢复保原语义。
- Computer 四条实际 service 红测修复与独审证据保持分列；独立公开API 5项、受影响runtime87、原root/child回归与fresh binary guardian分别通过，详细校正和有限复验见[同一验收记录](../reviews/runtime-computer-control-facts-2026-10-11.md)。继续持久 Computer scripts 与两设计余能力，不把被证伪的疑点算成剩余缺口。

## 2026-10-11 增量：可信 Computer 控制事实与真实接续

- 原 ComputerService/driver 与 Catalog 各保物理控制和执行输入唯一权威。原 desktop outbox 按稳定 kind/ID 转交 takeover/cancel/handback，正文先锁外持久化；原 actor 与 Catalog 派生 root 输入原子受理，丢 ACK 不重复。Catalog **45**、desktop runtime **4** 直接拒旧，不迁外部资产。
- takeover/cancel 与 root 通知保持被动 Environment；合法 handback 进入原 active Run 边界，或沿原冻结 launch/context 产生真实 root/child 后继（含无源 child）。自然终态只释放旧权限/assignment，原 handoff provenance 保留；returned 不冒充 human operator 或旧 Run 授权。新真实 controller 更新 generation，观察者不覆盖。
- Computer Stop 捕获原确切 actor/desktop，短撤销独立于慢正文与物理停止，旧 Stop 重试不扫同 Run 新事实；tree Stop 保已终态 Run 的原命令事实以挡迟到 outbox。Goal/pause/question 与无关 Wait 保原合同。既交付 history/已启动后继不被通知撤销重写。
- 独审实际复现并修复无关 desktop 坏记录污染 Stop、自然终态删 handoff 断链、远端未知释放误报确认、returned 短撤销失败被 UI 投影遗漏四处接缝；原失败条件复验已通过。原 root/child handback保冻结policy；辅助Run的来源/执行分支证据已按上节校正。最终runtime受影响266、kernel149/11 ignored后fresh guardian1、Host23+owner86/排除socket1、UI71及独立13组真实owner探针分层通过；完整同源、四条修复及未验边界见[本片验收](../reviews/runtime-computer-control-facts-2026-10-11.md)。
- 继续持久 Computer scripts、其余环境/Web/材料/Bot/MCP/source/context/provider 能力。整体两设计与产品/平台验收未完成；用户最后默认切换/Pi 与资产迁移分工不变。

## 2026-10-11 增量：无文件来源的真实子任务

- 原真实 dispatch 现在可从无文件来源 Run 受理 ChildTask，两调用 origin 经过原冻结目录、权限、context 与 child RunAssembly/Engine。显式 `Absent` 与文件结果 `NotApplicable` 区分准备中/缺失/成功/停止，不造目录、grant、pin 或文件分支；Catalog **44**、collaboration **8**直接拒旧。
- 发行默认由原配置 owner 的 default/explicit 事实及同一 frozen source/descriptor 编译，显式保存数组与自定义空选择原样保留并给可操作来源诊断。删重复 physical 工具名单与校验，MCP 按真实 execution_scope，普通 extension effects 保各自权限，read_only 不再误当所有领域只读。
- 原报告/Wait 与 User/message/followup/calendar 后继都消费同一 absence 合同。真实嵌套 Thread Job 不因上层终态/无文件结果而被伪结算，后继可按原 Run/report 规则继续；重开、树取消、原有源读写结果与 release 保各自权威。共享 UI 明示无文件来源/文件结果不适用，不隐藏效果、报告或 Stop。
- 独审真实 settings/context 输出进入原 Catalog 和 context compiler；真实 stdio MCP 两 origin/拒绝/恢复及 scope 反例通过。Runtime 受影响组合301、kernel148/11 ignored 后准确 fresh binary 原有源 guardian/树停止/固定结果1项、Host28、UI71、类型/协议/实际bundle 分层通过，源身份与准确 fresh binary/未验边界见[本片验收](../reviews/runtime-source-free-children-2026-10-11.md)。这不是完整 IPC、真实桌面、全平台或两设计最终验收。
- 原 child 无源受理缺口已闭合；下一步可信 Computer 人工交还的原环境输入/接续，然后持久 Computer scripts 与其余环境、Web/材料/Bot、MCP/script、来源/检索/上下文/provider 能力。用户最后默认切换/Pi 与资产迁移分工保持。

## 2026-10-11 增量：Native child Computer 请求与持久观察

- 本片贯穿**原真实有文件来源的 ChildTask**，两调用 origin 的 request/access/grant/deny/Wait 共用发行工具与原执行权限。请求受理不是授权；原 Catalog 短请求/决定/Operation/Wait 与原 Computer 物理 assignment、input/release 仍各有唯一权威，reason/history 先锁外持久化。Catalog **43**、desktop runtime **3**直接拒旧，外部资产保留。
- 原 typed Environment input 与请求同事务受理，idle root 沿真实 launch/Goal/pause/question 入口新 Run；只中断实际观察请求 child 的依赖 Wait，不取消 child 或误报完成，也不破坏无关等待。请求 child 先结束会撤销未交付唤醒。显式 Computer Wait 独立释放调用槽、恢复一次交付；结束观察不撤销真实桌面。
- root tool 与认证 User 决定共享原 revision/key/choice/reason，idle root 不造 Run。先实际 reservation 再发布 grant，取消赢发布则释放原 assignment；丢回应只对账原 claim，不因新 Host/缺失 assignment 重发。Native child 跟自身 Run 生命周期，root 自然终态不停止独立 child；精确 Stop 与三种自然终态沿原物理 owner 排空。
- 实际 client/认证 route/UI 可决定请求、idle root 可停止明确 child assignment。独审已修概览漏 Stop、正文故障阻清理、原 claim 恢复读正文与 pending marker 等 Catalog 才停止的接缝；新请求投影通知沿短 invalidation→真实 parser/hook→原 state API 闭合，坏正文显式错误不堵受理；旧 Host SSE 回调不再串到新连接。原失败链已复验，独审接受；原生组合253、最后Host23、owner87/1明确排除、最后UI24与实际发行包/broker/认证route链分层通过。fresh binary、实际bundle、同源证据与准确范围见[本片验收](../reviews/runtime-computer-requests-2026-10-11.md)。
- **无文件来源的纯能力 child 仍缺真实受理，是紧接优先片**；不靠假目录、伪文件源或控制端手插记录冒称支持。可信人工 handback 接续、持久 Computer scripts 和两设计其他环境/领域能力仍继续。完整 IPC/实际桌面/平台与性能验收独立，用户最后默认切换/Pi 与资产迁移边界保持。

## 2026-10-11 增量：Native Root Computer 与原物理 owner

- 发行 `varin.builtin.computer` 的六个普通单调用工具接原 SDK/broker、真实 ModelStep/PolicyAction、原 ToolBridge/回执和 ComputerService；无文件来源也可执行。共享声明拥有 schema，原配置/权限与 immutable binding 仍生效，默认桌面按 Run 冻结。坏 Computer 默认配置只让该 service candidate 不可用，不阻断无依赖的普通工具，required 原绑定不降级。
- Rust 只投影原 Thread/branch/family 与 active Run，辅助上下文 Run 不冒充当前工作。Pi/Native work 与 execution 显式区分，idle 为 null；认证 client/Host、共享会话概览与桌面 Stop 使用真实身份和确切 Run/控制 epoch，旧回包不能消掉新的未确认清理。自然终态由原通知唤醒并核真实 Catalog 后收尾，不要求模型先调用 release。
- 原 desktop runtime metadata **版本2** 在 input 前保存物理 owner；新 Host/helper、空 peer map、probe ready 不证明旧输入释放。效果、调用 writer 排空和旧 assignment/按键释放各按原证据结算，Unknown 不重放。原 release ACK 与 callback drain 后持久清理失败可按同一证明重试。旧/坏 metadata 明确不可用且保目录与其他桌面独立，不迁外部资产。
- 独审实际发行包/broker→普通 bridge→原 Computer owner、真实客户端→已注册认证 route、自然三终态及实际 bridge reset/reconnect 均通过，边界仍是受控 Catalog/driver 与内存 HTTP。原失败探针修后复验通过；Rust scope、Host/消费者、完整 types、实际 bundle/binary 证据与复跑入口见[本片验收](../reviews/runtime-computer-root-2026-10-11.md)。完整真实 IPC fixture 已修整并类型检查，尚未运行；不扩称真机/平台或两设计完成。
- 接续 Native child request/grant/持久 Wait、可信环境通知/人工交还、持久 Computer scripts 和剩余环境能力。当前 child 可发现能力，缺 assignment 的目标操作明确拒绝；Native handback 原事件保 pending，未伪投 Pi。全面迁移和默认切换仍由用户验收后负责。

## 2026-10-11 增量：原 Computer 紧急停止前置边界

- 接 Native Computer 前先闭合原 owner 的确认缺口：已有本地输入执行时，public cancel、takeover 和实际控制条 automation.cancelDesktop 会等目录、脚本撤销或控制写入才请求物理 release。四条独立交错均复现，不把 cancel flag 当按键已释放。
- 原 ComputerService 的已解析本地 lane 先做原准入/fence并启动既有 driver interrupt，再等实际 ack、旧回调排空与持久/通知结果。原 assignment release 共用该路径；observer 不停他人 controller，未知/remote 仍走实际 owner。释放失败保 unconfirmed；物理已释放但控制持久失败明确报告，不假称成功或恢复旧输入。无新权限、队列、数据库或格式。
- 原 owner 组合 **80 passed / 1 socket case excluded**、Host生产/测试types、lint、真实bundle及文档检查通过。独审原四反例修后与七组边界全部通过，无剩余确认阻断；具体范围和5,231输入同源见[Computer停止前置验收](../reviews/runtime-computer-stop-2026-10-11.md)。真实桌面/平台/远端/完整IPC均未执行。
- 本小片没有新增 Native Computer 工具或身份，不能算该领域完成。接着贯穿真实 Native actor、普通单调用回执与公开projection/Stop，再闭合原请求/Wait、可信环境input与人工交回；两设计余项与用户最后迁移边界不变。

## 2026-10-11 增量：原机器指标与自动采样续接

- 普通 follow_up **版本8** 与 User/API/UI 接入 `metric`：原 machineId、CPU/内存或稳定 GPU UUID、严格 above/below 及有限阈值，独立或 flat Any/All。内存用 MiB，百分比用 %；真实 research/source 身份逐叶核验，Any 另一叶已满足不绕过。Catalog **42** 直接拒旧，原 ResourceService/Storage 保唯一机器与样本事实，无复制历史库或采样 Job。
- 原资源 owner 新增共享、按需求自动采样；无需打开资源面板，订阅本身不创造需求，多消费者不重置既有 cadence。OS/GPU 探测不占机器承诺锁，释放不等慢探测；最后需求撤销请求取消，真实 child close/管道排空才算停止。旧 probe 全程保捕获的原 grant，跨 epoch 不借新授权写旧测量。远端没有实际 producer 时明确 unavailable。
- 原样本 revision 区分同毫秒事实；逐叶 FIFO 保 callback 当时由 owner 判定的可用性，慢读/慢受理/丢回应不丢已观察 false→true，恢复 head 仍按当前 freshness 判定。unknown 不冒充 false；初次已真一次，each 只认真实新边沿；原 Any/All、occurrence、Wait/input/root/child 新 Run 与重开去重闭合。Pause/Cancel 独立释放观察需求，不杀机器或实验。
- 有限公开入口保持 client→认证 Host route→原 Rust decoder，同一 schema 同时供 ModelStep、PolicyAction 与 frozen child；删除 FollowupWait.kind 的重复名单。UI 读原目录、显示 UUID/未知/间隙与真实事件，保不确定请求和迟到回复栅栏。Pi 观察组共享原采样 owner，未改成 Native 事件语义。
- 原跨 owner 独审反例确认并修复积压超 freshness 窗口导致已知 crossing 被撤销的问题，原失败条件复验通过。原生、Host、公开 route 与 UI 的最终证据及完整 IPC 未验边界见[指标条件验收与复跑](../reviews/runtime-metric-followups-2026-10-11.md)。
- 接着继续 Computer/环境、Web/材料/Bot、MCP/script 和来源/检索/上下文/provider 等两设计余项；真实远端指标 producer 仍待实现。完整产品/平台/外部系统及性能验收独立，用户最终默认切换/Pi 与资产迁移分工保持。

## 2026-10-11 增量：原研究日志条件与真实接续

- 普通 follow_up **版本7** 与 User/API/UI 接入原 accepted Job 的 stdout/stderr `log_literal`、`log_end`，独立或 flat Any/All。literal 按精确 UTF-8 字节、默认从0读取已发布历史；each 包含重叠命中。EOF 只认真实输出排空，空流可结束，产物收集独立，未来offset不倒退。
- 原 ExperimentService 的 Job 字节高水位 CAS 是发布权威，Storage 原 chunk 索引/对象是唯一字节来源；Catalog 只存短 offset/prefix/ended 与原事件、发生项。每次游标和最多一个命中原子提交，恢复保重叠余项；原 command intent/ContentStore 保存 literal，公开详情锁外读取、原 GC 保活。Catalog **41**、Storage **14** 直接拒旧，不加日志库/观察作业。
- 无匹配EOF不造 input；原队列派生耗尽，保未配对 All 事实及已受理发生项，不能继续的组合释放原 watch/timer/其他领域观察。原 Wait 独立结算，先有匹配后EOF不篡改首个事件；失败旧Run的 delivery_pending 从原状态派生，保真实 delivered=false，不再让不可交付结果永久占活动区。
- 独审还以真实client→Host route反例找出旧手抄trigger名单的400拒绝；本片删除该重复嵌套decoder，保认证/外层身份/实际file path准入，合法性回原Rust。新增trigger有限入口映射及原route→decoder复验完成，没有另补授权名单或裁掉非法字段。两确认反例均修后通过，独审接受。
- 广Rust runtime **442/0、2 ignored**、kernel **144/0、11 ignored** 在末尾两项小修前通过；最终受影响 followup **58/58**、真实child双origin Wait六路径、all-targets、fresh binary guardian **1/1**、Host原组合 **53/53**与最终route **14/14**、UI **59/59**、types/lint/协议/生产bundle均通过。原Service→字节reader→matcher→控制/通知跨owner独立probe通过。真实完整HTTP/IPC/process→新Run→重开用例已添加并类型检查，本环境未执行；准确同源/证据边界见[日志条件验收与复跑](../reviews/runtime-log-followups-2026-10-11.md)。
- 下一步继续指标与Computer/环境、Web/材料/Bot、MCP/script和来源/检索/上下文/provider等两设计余项。各层通过不相加冒称完整产品/平台/性能验收；用户最终默认切换/Pi与资产迁移分工保持。

## 2026-10-11 增量：真实运行时预设与独立设置入口

- 原 settings.json、SettingsManager 和 revision CAS 继续唯一拥有配置。原工具数组保持显式用户选择；同一字段可分别选择 Pi/Agent，空数组、缺失运行时、自定义和发行默认各有明确语义。Rust owning declarations 同时投影实际 schema、来源要求和默认成员，删除 Native 设置依赖 Pi provider 的入口错位，没有新增工具白名单、配置库或 grant。
- application-client、认证 Host 和共享设置页贯穿同一 owner；新建用所选 runtime 的实际 retrieval 默认，显式自定义不静默换名。模型/指令等共享字段与删除范围清楚显示，冲突保草稿，旧 Host/runtime 的迟到结果不覆盖当前选择。原 frozen child 仍拥有实际可用性与受理配置，设置显示 configured 而不假称任意 Run 均 available。
- 已受理 child 保原配置与来源，后续编辑/坏配置不重写其重开回执。Catalog **40** 直接拒旧，外部旧数组及既有 legacy profile 归一化资产保留。跨 owner 核查闭合旧 profile 读写身份错位、外部 CAS 后活动 Pi 下一 prompt 读取新配置、旧 SDK setter/flush 不覆盖新配置，以及 pending reload 中 compact 可取消且不派发的实际窗口。
- Runtime **436/0、2 ignored**、kernel **142/0、11 ignored**，最终 capability **5/5**、fresh guardian/固定结果 **1/1**；Protocol/Pi **22/22**、Host **7/7**、client **2/2**、UI **26/26**，类型、all-targets、协议、lint 与实际 Host bundle 通过。独立真实 owner→compiler→提交捕获→Catalog 的选择、取消迟到与重开探针通过；真实 IPC 三条产品用例已改用新设置 API，但本环境未运行，具体证据边界见[验收与复跑](../reviews/runtime-agent-profiles-2026-10-11.md)。
- 接着推进原日志条件及两设计其余领域；用户基线 Windows78 与本轮分层证据分别成立。完整 Host/产品/平台/性能验收和用户最后全面迁移仍独立，不能按测试或提交数量推算设计完成度。

## 2026-10-11 增量：共享 immutable object reader；完成本片后暂停

- 原 getBlob 与 fixed-source file_read 共享已有 file worker：短 admission/finish、同句柄 cold 全 hash/range 读取与正文转换锁外；原四种 source/grant 仍独占访问权威。短暂 exact-hash 引用只保原 GC/删除生命周期，不增加权限、持久读 Operation 或格式。
- Host getBlob 等实际取消终态，原 input transfer close 不再先 retire 尚在读取的 grant。独立精确基线模块+原 consumer 的同两条反例修后通过；native worker、同 hash 多读/GC、撤权、Drop 及真实 fixed reply 分层验证。详见[本片验收与复跑入口](../reviews/runtime-blob-reader-2026-10-11.md)。
- 按用户最新要求，完整收尾与发布本片后暂停，不进入 log literal/log_end 或下一个领域。日志条件仅有方案，尚未实现；其他两设计能力和外层验收缺口见该验收记录的续接清单。两设计整体仍未完成，默认 runtime/用户资产迁移仍归用户验收后负责。

## 2026-10-11 增量：原研究产物与收集事实续接

- 普通 follow_up **版本6** 与 User/API/UI 新增独立 artifact/collection 叶，原 accepted Job binding 与实际 family 读权限贯穿。artifact 可按ID或name选择，once读当前适用快照、each按原每件revision；真实collection完成与产物可用、空收集、失败/未知分开。明确Any才同时消费两者，不因一次收集完成偷加模型轮。
- 原 ExperimentService/Storage 仍唯一拥有记录、字节及收集，completion身份落原最终CAS。Catalog **39**、Storage **13**直接拒旧；原索引分页和source事件高水位去重，metadata锁外ContentStore准备，原event/occurrence/GC保确切旧事实。短历史与按需 occurrence 详情贯穿工具、SDK、Host和UI，不制造历史字节快照或新授权。
- 原Job对账与metadata飞行分开，逐产物提交唤醒既有订阅，Job停止后仍发现观察工作；Pause丢未启动旧页，读中/结算窗口通知不丢。已accepted HostJob重开保原owner和回执，不冒充普通本地中断。原root/child新Run、两调用origin、Wait和真实metadata input/history沿共同执行owner闭合。
- 原真实反例已闭合：双重产物持久化失败误记done、metadata拖住取消、accepted User Job重开失败、Pause旧页新读、scan结算丢通知，以及宽套件发现的新增索引列表顺序。修复保原失败探针与原恢复/权限校验，没有另加调度器或结果库。最终runtime **435/0、2 ignored**、kernel **135/0、11 ignored**、all-targets、准确fresh binary原guardian **1/1**、Host组合 **57/57**、UI **57/57**、types/lint/协议/真实bundle通过；独审接受，**5,216**项广输入指纹同源，完整证据见[产物与收集验收](../reviews/runtime-artifact-followups-2026-10-11.md)。
- 接着推进原日志、指标与其他领域来源，以及两设计其余能力。完整Host/实际浏览器、平台/真实外部环境与用户最终迁移分别保留边界，不能用组件通过代替。

## 2026-10-11 增量：明确重复授权与原发生项

- 普通 follow_up **版本5** 和 User/API/UI 明确 repeat once/each，默认仍once。首条真实可重复source是原文件changed；each Any每accepted leafedge一次且有限叶不重放，each All按FIFO保留未配对事实。原事件accepted cursor与因果trigger cursor分开，与叶消费和原occurrence同事务，无新队列/Host调度器。
- Catalog **38**直接拒旧。所有prepare/failure/Wait/Goal/ingress/交付按exact occurrence；O2进度不撤销已冻结O1，真正控制/来源/epoch仍有栅栏。持续定义保观察，Pause保已受理事实，Cancel撤销未来与所有未消费项但保已交付结果；当前Run明确Stop围住既有brancheach，历史或晚到终态不扩大取消范围。
- 原短latest/pending与独立历史分页供SDK/Host/UI读取，控制revision不冒充历史新鲜度。旧失败不会被最新成功遮住显式重试；历史Run复用原只读family消费者。原Storage实际文件两次读取→active root输入、两origin原Wait O1，以及Job→At真实idle/active child组合分别有证据，不宣称固定来源文件变化。
- 最终同源 runtime **430/0、2 ignored**、kernel **133/0、11 ignored**、all-targets、准确fresh binary原guardian **1/1**、Host组合 **19/19**、UI **48/48**、类型/lint/协议/实际bundle通过；独立通知接缝probe **1/1**。独立审查接受、无确认阻断，1,391项广输入指纹一致，完整边界见[重复发生项验收](../reviews/runtime-repeated-followups-2026-10-11.md)。
- 下一片继续原产物/日志/指标领域事实及两设计余项。各层证据不合并冒称完整Host IPC、平台或性能通过；用户最终全面迁移分工保持。

## 2026-10-11 增量：原 accepted Job 停止事件与续接

- 普通 follow_up **版本4** 与 User/API/UI 接入 job_stopped 独立或 flat Any/All。原 Catalog 已接受 HostJobBinding 是唯一目标身份；jobs/jobSources 短查询沿实际家系索引覆盖历史、独立User及child/sibling工作，不依赖active operations或一页历史。目标sourceRunId只归因，续接始终使用当前实际调用/所选工作来源。
- 原 stop event 保当时短 receipt metadata，合法 Unknown→known 细化不能替换已赢的叶证据/正文；worker和公开event解引用、GC原root完整，Catalog **37**直接拒旧，Storage不变。接受、Run结束、取消观察、collection与真正executor-stopped区分，Unknown保真实标签而不形成重复永久封禁。
- 复用原 occurrence→typed input→activation，真实双origin、active root/child、idle root及新DelegatedExecution/source/context/Run消费；原Goal/Pause/question/source/单writer继续守卫。定义取消、观察取消、目标Job及treeStop的受理集合分别结算，后来的明确User意图独立。原research/domain订阅对账原subject，无新poller或作业重提。
- 最终 runtime **423/0、2 ignored**，kernel **131/0、11 ignored**，all-targets、准确fresh binary原guardian/固定source组合 **1/1**；Host **39/39**、UI **40/40**，类型/lint/协议/生产bundle通过。独立自动通知probe **1/1**不用显式reconcile，原snapshot读取中通知与重建对账均通过；独审接受无确认阻断，1,390输入指纹一致。完整入口和证据边界见[Job事件续接验收](../reviews/runtime-job-followups-2026-10-11.md)。
- 下一切片建立明确重复事件/发生项语义和真实原source消费者，然后继续日志/产物/指标及其余设计能力；当前Job触发仍是显式一次意图。完整Host/平台/真实外部环境和用户最终迁移分工保持。

## 2026-10-11 增量：单文件正文 capture 与原消费者

- 原 file.capture 进入共同 CaptureTask/file_workers，Single/Batch/Observation 共享唯一 read/hash/verify/stage 算法。原单结果和 non-indexed object owner 保留，batch仍indexed；旧重复同步store分支删除。原mutation/reconciliation观察只作同算法同步适配，该其他控制边界仍明确保留。
- 显式lease和未显式绑定的single读取都沿原file_leases保物理排他到实际worker停止；后者用原表内短寿命exact lease，不造Job。一次canonical资源用于原overlap核对及insert；原pending取消表覆盖single。正文先durable，原Storage短安装/owner事务保持GC顺序。
- 真实FileResourceBackend gate传原signal，嵌套合并本层/外层取消并共用同lease；原Experiment backend等实际collection回执再释放。旧epoch/失效credit拒绝断线后的lease/process释放，新Kernel owner lock仍证明旧reader退出，不把Promise拒绝伪称drain。
- 最终Kernel **128/0、11 ignored**、all-targets、Host **30/30**、类型/lint/协议/真实bundle通过；准确fresh binary原child guardian/固定source组合 **1/1**，1,262输入指纹一致。独立真实consumer窄探针 **4/4**、原生GC/Drop两项 **2/2**，最终指纹吻合，独审接受无确认代码阻断；完整证据与边界见[单文件capture验收](../reviews/runtime-file-capture-2026-10-11.md)。
- 下一步回到领域事件与两设计能力余项，保留同步mutation/GC、增量inventory和产品/平台验收的明确剩余；不因本片读路径闭合就宣称整个文件域或两设计完成。用户最终默认切换/Pi与资产全面迁移分工不变。

## 2026-10-11 增量：文件 inventory 与真实 reader 排空

- 原 file.scan/measure 复用 Kernel file_workers 和原 pending/cancel/完成链。Storage 只持原 grant/root/参数短事实；实际路径解析、目录遍历/stat、排序/hash/结果构造在 worker，公共 envelope 移动原结果。旧同步两实现删除，无新 Job、数据库或快照缓存。
- Experiment 前后两次扫描用可选 leaseId 保原 source lease，与 captureBatch 共用实际 drain tracking；取消帧先行但 Promise 等真响应，断线不伪造排空。原 release/revoke/retire 只在实际 worker 完成后移除 retained lease，原同 scope 重获与 Storage owner lock 继续证明恢复排空。普通未绑定扫描/measure 不新建锁。
- 保留 scope、symlink、缺失/null、Unix allocation 和分页错误。Fingerprint 是路径集合而非正文/OS snapshot，每页仍重扫，不宣称性能目标全部达成。单次 OS 调用和排序仍按实际结束保 ownership。
- 冻结 Kernel **119/0、11 ignored**、all-targets、Host **17/17**、类型/lint/协议与实际 bundle 通过；准确 fresh binary 的原 process/Storage 回归 **1/1**。独立实际 Host consumer→client wire 窄探针 **4/4** 通过，冻结指纹吻合，独审接受且无确认代码阻断。入口、同源 SHA 和分层边界见[文件 inventory 验收](../reviews/runtime-file-inventory-2026-10-11.md)。
- 下一片沿实际本地实验 artifact / FileResourceBackend 收口原单文件 file.capture 正文路径，然后继续其余领域事件和两设计能力；不把 metadata 隔离当作所有文件操作都已锁外。完整 Host/平台验收与用户最终迁移边界保持。

## 2026-10-11 增量：原生研究 Job 与真实消费者

- 原 Catalog Operation 关联确切 domain/version/workspace/subject，Job 接受正文与 User 原意图沿 ContentStore；已计划不等已接受，调用接受与执行终态分开。普通已安装 research-tools 经真实 ModelStep/PolicyAction/ToolDirectory，User 命令同事务持久原意图与 subject，不伪装模型轮。Canonical settlement 在真实两执行路径消费同一原接受，不重写已交付 Unknown 或重放未知工作。
- 原 Experiment/Source/Resource/backend 仍各自唯一拥有领域事实。精确 live/materialized/fixed 来源、family 读取/后代控制、历史 sourceRun 可见和实际权限同步贯穿。Operation-owned grant 保真实 Run 归因，普通 Run 结束不切断独立作业；恢复按原授权记录与实际 writer/reader 排空退役。Catalog **36**、Storage **12**，直接拒旧。
- 原 durable Wait 只认实际 executor-stopped，历史 Unknown 不冒充停止；取消观察保作业，树停止依原受理顺序。认证 User API、shared application-client、ThreadConversation 和共享研究面板消费原受理/输出，未知 rerun 保原键意图，产物与日志按原游标读取。
- 独审实证并修复 artifact I/O 拖住已停止执行/计算资源及日志 EOF 错依赖 collection 两条接缝。先短提交 terminal/pending，再独立收集；原 holder 单飞跨通知重入、detach/recreate 和手动 collect，真实 reader drain 后才释放授权。两原失败探针及额外持读重建探针最终全绿，无剩余确认阻断。
- 最终 runtime **415/0、2 ignored**，kernel **110/0、11 ignored**，同源 fresh binary 原 guardian/Storage **3/3**；领域组合 **46/46**、公开/信用消费者 **11/11**、ToolInvocation **4/4**、extension-contract **103/103**、Pi **16/16**、UI **53/53**，类型/lint/all-targets/协议与实际 Host bundle 通过。源指纹、准确 binary、入口和证据边界见[研究作业验收](../reviews/runtime-research-jobs-2026-10-11.md)。新 source adapter→实际 Storage 字节和完整 Host IPC 尚未实跑，不能合称端到端通过。
- 下一步先收口原 file.scan/measure 同步 metadata 遍历对 Storage 控制的占用，再继续其他领域事件、Computer/环境、Web/材料/Bot、MCP/script、语言/上下文/provider 与组合能力余项。两设计整体未完成；用户负责最终默认切换和全面迁移的边界保持。

## 2026-10-11 增量：研究实验短受理与独立准备

- 原 ExperimentService 已把规范化请求、真实 caller 的 source/retry 授权和固定来源元数据短受理为 durable attempt，再独立 capture/spec/resource/prepare/spawn。原 Storage experiment/spec/job/artifact 与 ResourceService 继续唯一拥有领域事实；spec/specId 可为 null，cancelRequested 与真实排空分开。Pi 工具与现有 User/Research UI 展示原受理，未知 rerun 回应复用同键/原意图，取消不等全 workspace 恢复。
- 原 source lease、capture-batch、materialize 与远端准备都按实际 ACK/原 receipt/真实物理 lease 排空；资源受理丢回应只向原分配 owner 查询，missing 不当未分配，不盲重 admit/prepare/spawn。Late spawn 按原 handle 停止，恢复 observer 重读原取消；明确 terminal status、writer inactive 和日志 cursor drain 才终结。候选 branch→spec 先存确切接收者，取消和去重失败者只清理自己原候选，丢 delete ACK 查原 operation。
- 独审原七条失败反例最终 **7/7** 修后通过：来源权限、稳定显式请求跨 Run、两种 branch 清理、非法资源自困、恢复取消与不可互读 Thread 的 spec 去重。Inline spec 以原创建 Thread/session 为归属，同 owner 跨 Run 可去重，显式跨 owner 引用仍核原权限，没有新权限缓存或第二状态库。
- 最终 portable Host **43/43**、Pi **16/16**、UI **15/15**，Host/Pi/UI 类型、协议构建、全部 TS lint 与真实 Host bundle（531 reachable / 72 excluded）通过，23 个冻结源码/测试指纹保持一致。独审接受本基础片；实际 Storage/process IPC、真实 managed machine 与平台验收未执行。原 Rust inventory metadata scan 仍同步，后续继续其控制边界。详见[验收与复跑](../reviews/runtime-experiment-admission-2026-10-11.md)。
- Native 研究调用身份、普通目录 Job/Wait、child/source 与 native User 消费仍是下一纵切，不能以本基础片的 Host/Pi 行为替代。完整设计和用户负责最终迁移的分工保持。

## 2026-10-11 增量：原来源文件条件与取消恢复

- 普通 `follow_up` **版本3** 与 User API 接入 file exists/changed/ready，单独或 flat Any/All 共用原 occurrence/input/Goal/root/child 链。Catalog **35** 保存原叶基线、实际 FileState、持久接受的 watch position 和 gap；Storage 原 operations/operation_owners 保存精确只读来源受理，ContentStore 保持正文 owner。live_root、原 materialized run root、fixed_branch 精确 revision 分别核验，不随 child 新结果改读来源。
- 原 watcher 在基线前 ready，每次 open 独立 handle，同根共享 watcher；真实文件 capture/hash 在锁外 worker。busy/不稳定可保存 null baseline_pending，首次稳定基线不虚构 changed；gap 不证明离线 A→B→A。快照稳定与受管 writer/lease/process 空闲分开，持续 writer 不阻稳定 exists/changed，ready 不靠 quiet timer。原 Documents 目录 entry invalidation 同步接 Registry、semantic、LSP 与 Pi tracker。
- 正常 grant retire 保 provenance，明确 revoke 拒新读并精确唤醒 fixed receipt。取消先挡原 generation，再等实际 reader drain；取消可选 tool Wait 不撤条件或杀进程。Storage 已受理但 Catalog 未提交的 User 意图可从原 pending projection 看到并明确取消，原 commands fence 防迟到受理、原 observer/pin 幂等释放；未知 key 不创建提前封禁，已交付定义和原 key 重试保留。没有第二清理库或过期推断。
- 原 guardian 回执晚到且目标不再写的恢复窗口，复用一个临时 receipt 目录通知后按原 process/epoch/treeStopped 核短回执；不扫描 spool、不造第二终态、不以业务 Unknown 代替停止。实际组合还修复原工具登记 mutex 析构重入、同 key watch 误关和 reader 相互阻塞。
- 最终 runtime **405/0、2 ignored**，kernel **109/0、11 ignored**，准确 fresh binary 原 guardian/Storage **3/3**；Host **83/1 skipped**、UI **75/75**、类型/lint/all-targets/协议与实际 bundle 通过。独审最终 Catalog7、Host5组和 Linux receipt-wake2项全绿，三个确认缺陷原条件复验闭合；构建同源和未验边界见[文件条件验收](../reviews/runtime-file-followups-2026-10-11.md)。其他领域事件、完整 Host/平台验收与两设计余项继续，默认切换和全面迁移仍交用户先验收后负责。

## 2026-10-11 增量：组合条件与原发生项

- 普通 `follow_up` **版本2** 和 User API 接入 flat Any/All，逐叶授权原 At/ProcessStopped；Catalog **34** 保存每叶游标与实际观察证据，删除重复单一 operation_id，无新调度/正文 owner。All 部分命中跨 reopen/GC 保留，已到期叶退出 deadline；Any 实际 At 不等未命中进程，发生项冻结真实观察快照，后续来源不重触发。
- 原 input/activation/Environment/root/child 链保持，准备只读实际命中进程回执；原 Goal 时间检查仅认发生项里真正观察的 At，未来 At 不能被借来绕过 Dependency。原 tool observation、定义取消与 Run/进程控制分开。GUI 条件编辑和逐叶进度、认证 route、同 key 不确定重试及真实事件消费者同步接线。
- 最终 runtime **400/0、2 ignored**，kernel **91/0、11 ignored**，准确 binary 原 guardian/Storage **3/3**；独审预先定义七条探针全过，无已确认阻断。Host **30/30**、UI **35/35**、all-targets、类型/lint/生成协议和实际 Host bundle 通过。构建同源与复跑入口见[组合条件验收](../reviews/runtime-composite-followups-2026-10-11.md)。完整 Host 四条件冷续接已类型检查，未运行。
- 本步完成现有时刻/停止事件的组合，不把文件、日志、指标、研究/远端来源记成已接入。下一步继续真实 source owner 与两设计余项；默认切换和全面迁移仍交用户验收后负责。

## 2026-10-11 增量：日历资产与真实发生项

- GUI/Markdown 仍由原项目资产 owner 管理；逐定义明确 `runtime: agent`，原 Pi 默认保留。Catalog **33**、input **6**、collaboration **7** 持有定义世代、UTC slot、游标和发生项，ContentStore 保存原指令。共享原 native deadline、typed ingress、Run/Goal 和 child execution；无 Host 原生 timer/执行状态库、假 Pi session 或假前轮 Run。
- once/daily/weekly/cron、IANA 时区、skip/coalesce_once 以实际发生时刻恢复；冷新工作经真实 Thread/source/model/context/显式 skill 原子进入 Run 和可选 Goal。既有工作保原项目/来源/模型/权限，原 Goal 和 child fixed WorkingResult 继续守卫。取消未交付发生项、停当前工作、禁用和删除定义的作用范围分开，旧结果保留。
- 原 GUI/API、认证 routes、shared application-client、普通 SDK installed broker 示例、原始 Markdown CAS、实际 Run/Goal 导航已接线。跨 owner once 交接只携原受理事实，不把改 executor 当 Run-now；Agent→Pi 的原 generation pending 引用覆盖“读取后、tombstone 前”迟到受理。旧 Pi timer/session/终态写回沿原资产锁核准确被受理意图，不得禁用新定义或重放旧副作用。
- 独审已实证并修复 once DST 依赖 ambient offset、`H` cron 随机换槽、坏项目阻断健康冷启动、native 零预算误拒和 once 跨 owner 重放；旧 Pi 晚结算误写新定义的原反例也已同源码复验通过。默认切换和全面迁移仍交用户验收后负责；两设计整体仍未完成。
- 最终 runtime **391/0、2 ignored**，kernel **91/0、11 ignored**，准确 fresh binary 的原 guardian/Storage **3/3**；Host **89/89**、UI **40/40**，all-targets、类型/lint/协议与实际 Host bundle 通过。独审六个确认问题均闭合，同源证据及用户入口见[本切片验收](../reviews/runtime-calendar-2026-10-11.md)。完整 Host IPC 场景已补、类型检查，当前未执行。继续通用事件条件及其余领域能力。

## 2026-10-11 增量：一次时间/进程意图与真实来源接续

- 普通 `follow_up` **版本1** 支持真实 ModelStep/PolicyAction 的 register/list/get/control；明确原指令与 At/ProcessStopped 条件持久保存。注册不隐式停车，只有显式 wait 才进入原 Job/Operation/共同观察屏障；取消观察保登记，取消定义只取消未交付 ingress。User API、认证 route、原正文按需读取及时间/进程 UI 同步接线，未知响应保原 key/trigger/body/source。Catalog **32**、input **5**、collaboration **6**，旧内部格式拒绝。
- 原 occurrence 使用 typed Followup input 与 message request 共用 `catalog_activation`。活动 Run 在原边界消费，idle root/child 按当前真实前轮配置/来源和原 delegated owner 接续，不克隆旧 dispatch。绑定不算交付，queued 仍可暂停/取消；Stop 后新 User 意图不被旧 worker 终态追溯取消。原 native 期限源先记真实到期，held 项不保留过去 deadline 忙转。Goal Dependency 可作同世代一次明确 At 检查，保原 block/订阅与暂停/预算；报告换代后不续自动链。
- Host 真实 online/startup 消费者原来漏掉统一 `ingress.run_ready`，两条原用例先红后修复，删旧事件分支而非新增重复通知。正常 terminal child 按持久 Storage Host/Run 退休来源 grant，单一 Active/Retired/Revoked 状态区分关闭 caller 与撤销 provenance。准确前轮/固定 WorkingResult 链允许同工作环境新物理目录读取原 stopped spool；原 revoke 仍拒绝，旧文件/交互权限不扩张。Storage marker/schema **11**，旧数字版本不再自动清库，拒旧前保留 catalog/objects/in-flight stream。
- 独审两原反例证实新增全局 Unknown gate 把已停止、已固定 child 的明确 ProcessStopped/At 永远挡住。最小修复删除重复谓词，不建例外名单，保原效果、实际 writer/occupancy/source 和自主 Goal 守卫。两原探针不改源转绿，六条原生命周期链也在最终 rlib 复验通过。该结论不把业务未知伪造为成功，也不重放效果。
- 最终同源 runtime **368/0、2 ignored**，kernel **89/0、11 ignored**，all-targets 通过；Portable Host **40/40**、UI **39/39**，生成协议/类型/lint/实际 Host bundle 通过。准确 artifact 已 stage，同源真实 guardian/Storage **3/3**；构建证据和可复跑入口见[本切片验收](../reviews/runtime-time-followups-2026-10-11.md)。完整 Host IPC 双触发冷启动用例已类型检查但未运行，平台/组合证据边界保留。
- 下一步继续日历发生项/重复规则、通用事件条件和其他领域。两设计整体未完成；默认 runtime、Pi 删除及资产全面迁移仍交用户先验收后执行。

## 2026-10-11 增量：关联回复、实际期限与共同观察屏障

- 普通 `send` **版本3** 支持显式无期限或带 `timeoutMs` 的关联回复观察。消息、Confirmed 效果、原 JobAccepted、Operation/Wait 同事务受理，两实际调用来源保留原回执。`acceptedAtMs` 与绝对期限重试/重开不变；早于期限受理的原关联回复获胜，截止及之后为迟到消息，已确定事实不被时钟回拨或取消重写。Catalog **31**、input **4**、collaboration **5**，旧内部格式拒绝。
- 原 child/process/reply 共用观察选择、停车和消费边界；已就绪项可交付，最后一项原观察及原调用消费闭合后才继续模型。question/manual Pause/Goal 仍独立守卫。新输入可结束观察而不撤消息、不杀观察对象；Run 终止与实际历史交付分开。回复正文沿原 input_queue/ContentStore/history 一次进入，观察只保存原 ID 和生命周期事实。
- 原 native continuation worker 使用真实事件与最近绝对期限。Linux timerfd/eventfd 已实际运行；Windows/macOS 后端目前仅源码核查。无每 Wait 线程、Host timer、系统唤醒权限或模型轮询。先解析期限短事实，再推进各原域；某个 Goal/followup 错误不会撤掉正常 future timer。
- 独立原反例闭合未观察 child 坏报告阻塞其他回复期限及健康 child 的门槛：逐 report/receipt/Wait 在锁外加载、原 owner 短提交，坏项保原错误，健康项继续；固定点只跟随实际进展。原 child 命令已提交后的 ACK 不再被全 Catalog 报告对账绑住。Host 对账错误仍可见，原 saved launch/event 继续消费；没有第二调度器、伪造成功或正文重试层。
- 最终 runtime **363/0、2 ignored**，kernel **85/0、11 ignored**，fresh guardian/Storage **1/1**；准确 binary 与冻结输入证据见[本切片验收与复跑](../reviews/runtime-reply-waits-2026-10-11.md)。Host **70/70**，UI **37/37**，措辞修正后其中 owning 6 项另复跑。独审七组原反例/基础检查及一次真实历史/模型消费增强通过。完整 Host 双回复重开用例已补并类型检查，当前未运行；分层证据不合称 E2E。
- 下一步继续通用事件/时间续接和日历发生项，并推进其余领域与最终用户验收准备。两设计整体未完成，全面迁移和默认切换仍交用户验收后执行。

## 2026-10-11 增量：定向请求与真实执行接续

- 普通 `send` **版本2** 与公开 User 入口支持 inform/request，真实两调用来源与家系/replyTo 身份不变。受理、原历史投递和执行激活分开；原 input_queue、ContentStore、Run/Launch 和 delegated execution 继续各自唯一拥有事实。Catalog **30**、input **4**、collaboration **5**，旧内部格式拒绝。关联 Wait/期限尚不接受，避免把未实现字段默默吞掉。
- 活动请求在 Catalog 事务内绑定可接收的真实 Run；空闲请求由原 coalesced continuation worker 锁外准备、按精确前轮/来源/上下文核对后创建 root 或 child 新 Run。普通 User 准入与 child 发布同事务领取 Pending 请求。child MessageRequest 与 User 续接共用原执行 owner，正文不伪装成 User 或激活 slash skill；真实停止、固定 WorkingResult、当前权限与旧 Unknown 事实保持独立。
- manual Pause、question 和 Goal 暂停/预算仍挡执行。请求可结束原 child/process 观察等待，保留已经成功触发的结果，不停止观察对象；所有原观察交付完才回到模型边界。公开 Host/API/UI 显示实际激活、hold、Run/execution 与原消息，未确定受理保原 key/kind/正文重试；idle 准备也可经原 Stop task and children 取消。
- 独审真实复现并最小修复两个窗口：Stop 提交后、旧 Run 尚未结束时受理的新请求不能被旧停止追溯取消；多观察只取消第一项即崩溃，恢复须幂等补完其余原观察。原失败探针源未改并转绿，另验证真实成功报告/trigger 保留、前后停止集合及新 Run 一次绑定。无第二账本、永久停止世代或效果重放。
- 最终同源 runtime **360/0、2 ignored**，kernel **78/0、11 ignored**；Portable Host **67/67**、UI **36/36**。完整 Host IPC 的 MessageRequest 恢复/真实文件来源场景已补并类型检查，当前未执行，不与组件证据合称 E2E。准确 binary、真实 guardian 和最终构建证据见[本切片验收与复跑](../reviews/runtime-request-activation-2026-10-11.md)。
- 接着实现关联回复 Wait、实际期限与多等待消费；更广事件/日历和剩余领域继续。两设计整体未完成，用户验收后自行全面迁移的分工不变。

## 2026-10-11 增量：子任务独立新 Run 与逐轮结果

- 已结束 child 的明确 User 输入现在通过原任务关系下的独立 execution 受理，新建 Run，不重启原 dispatch 或改写前轮回执。首轮和续轮共用一个执行准备/来源/报告/结果 owner；Run/Launch/Operation 仍拥有执行和效果。Catalog **29**、collaboration **4**，旧内部格式拒绝。原 wait_child 保持首轮，child_status/child_report 与普通 integrate_child **版本2** 按确切 execution/publication 消费。
- 配置来自上一实际 Run/Launch，包括用户已热切换的模型/策略和原规划模型/凭据；新轮策略从独立世代开始。新文件源来自精确前轮 WorkingResult 或合法 immutable 基线，Host 不领取旧父 handoff。未停写者不能绕过；真停止并已发布的固定 root 即使旧效果 Unknown，也可承接新用户工作，旧事实保留。每轮报告只含本 Run 真正产生的原文。
- 公开 client/认证 HTTP/Host/UI、MCP/扩展/资源/显式 skill、原 Integration journal 和启动发现均已接线。accepted-before-Run 可重开恢复、精确重试及原子树停止；历史 fork 继续可读，父页按需查看续轮原报告/结果。原 family、GC、tree cancel 和 Goal 消费同步更新，未建第二调度器或配置库。
- 独审与整合闭合四个实际接缝：历史 fork 只读误拒；前轮 planner 世代 ID 和 Host/Rust optional-null 配置 hash 错位；将已停止/已固定的 Unknown 效果误当永久来源屏障；旧终态 Goal 把新 User Run 即刻取消。原失败探针修后逐一绿；Active Goal 的暂停/预算仍保留，旧 Run/用量和未停执行者没有被放宽。
- 最终同源 runtime **351/0、2 ignored**，kernel **78/0、11 ignored**，fresh guardian/Storage → 前轮固定根 → 新 source/Run **1/1**，Host **129/129**、UI **31/31**。all-targets、类型/lint/协议/文档、真实 Host bundle 与准确 Linux x64 `0.9.25` binary/staging 通过；前后 Rust 输入清单一致。独审最终四条原生 probe、fork 与真实 Host→Catalog→Host planner 组合通过，接受此切片。完整 Host IPC 场景已补但未执行，证据分层见[验收与复跑](../reviews/runtime-child-continuation-2026-10-11.md)。
- 主动 request、关联回复 Wait/期限和多等待屏障继续推进；本阶段的 User 新 Run 入口为其共享执行基础，不把尚未实现的消息激活算作完成。两设计整体与用户验收后自行全面迁移的分工保持。

## 2026-10-11 增量：同任务被动消息与关联回复

- 普通 `send` 版本 1 和公开 User 入口支持 `inform`、固定 Thread/branch 与原 `replyTo`。真实 Agent 来自冻结 ModelStep/PolicyAction 和原 Operation，用户从 child UI 发出仍是 User；家系授权不依赖 cwd。消息与完整工具回执同事务确认，同一原调用的并发准备/重开只返回原事实。
- 原 input_queue 泛化 typed origin/activation，未交付 inform 没有接收 Run；正文、原 intent 和回执仍在 ContentStore，无新 inbox 或调度权威。Idle/Waiting 不醒，合法闭合边界交付不造 InputDelivered、不清策略决定、不改 Goal、不强迫最终回答多一轮模型。取消拒迟到提交，原消息可由下一自然合法 Run 一次消费；显式已授权 followup 不被普通信息挡住。Catalog **28**、input domain **3**，旧格式直接拒绝。
- 认证 Host/application-client 与共享消息面板保留真实 User、原目标/reply ID和原文，受理/历史交付/处理分开；未知回执保同 key/正文/目标重试，切 Host/身份拒迟到结果。原普通用户队列编辑/取消不能改写消息。
- 同源 runtime **342/0、2 ignored**，kernel **77/0、11 ignored**，fresh guardian **1/1**；Host **24/24**、UI **38/38**。all-targets、类型/lint/协议、实际 Host bundle、准确 Linux x64 `0.9.25` binary 与 staging 通过，前后 Rust 清单一致。独审四条外部真实 Catalog 探针通过，接受本切片；首次提交前两候选、取消和旧 epoch 均按原窗口复核。
- 主动 `request`、关联 Wait/期限、多等待屏障、已完成 child 新 Run 与其新资源/报告/结果仍继续，未做部分在严格 schema 中副作用前拒绝，不降级为 inform。完整 Host IPC 组合已补入口但未执行；完整设计与用户验收后自行迁移的分工不变。见[验收与复跑](../reviews/runtime-passive-messages-2026-10-11.md)。

## 2026-10-11 增量：同任务发现与按需会话互读

- 普通 `threads`/`read_thread` 与四个公开 family reader 共用 Catalog 的真实任务血缘，支持根/父/兄弟/后代、历史 Run、固定最近/范围/搜索页和原 JSON 分块。当前 Thread 可以按需读其他已完成/取消会话，不启动目标模型或 cwd，不获得其控制、文件或私有策略状态权限；ModelStep 和 PolicyAction 都核实际冻结声明与 origin，未选工具重开不补入。
- 所有原 history writer 在同事务保存实际生产/接收 Run，Catalog 格式 **27**。Fork 不重记旧记录 owner，继承 Run 可发现/筛读且保留原 branch。原 ContentStore 继续唯一拥有正文，Catalog 只捕获短事实和在途保护；普通旧 history.page 也迁出锁内遍历。原文读取/搜索排除 ProviderOriginal 和 typed opaque continuation，不改变普通 user/tool JSON。Signed view 在同 epoch 的追加/fork/回滚间固定，重开后明确失效；已进旧 SQLite 快照的 reader 在返回前用当前连接重核 epoch/caller。
- 认证 Host→application-client→共享 ThreadConversation 按需只读面板保留真实 caller/target、原文 ID/Run/tool 关联、部分结果和续读位置。切 Host/target/branch/Run 取消原读且丢弃迟到结果。独审两条真实错位已红绿修复：Run 过滤后的前后导航，以及后建已完成 fork 遮蔽仍活动根任务；状态和导航由原事实推导，不建第二状态表。
- 最终 runtime **336/0、2 ignored**，kernel lib **74/0、11 ignored**；原生 family12与双来源/public4计在完整套件内。Host **27/27**、UI **35/35**、原 fresh binary guardian组合 **1/1** 通过。all-targets、同源准确身份 Linux x64 `0.9.25` 构建及 staging、类型/lint/实际 Host bundle/协议/文档检查通过。独审接受本切片。完整 Host IPC 用例保留可复跑入口但未执行；定向消息、关联 Wait/期限、新 Run 续接及未交付策略/辅助结果共享仍继续，不能把本切片称完整协作。详见[验收记录](../reviews/runtime-family-reads-2026-10-11.md)。

## 2026-10-10 增量：子任务普通记忆、自身计划与报告事实

- 已冻结选择的 child memory/todo 通过原声明、ToolDirectory、ModelStep 或 PolicyAction 执行。普通继承可包含父目录中实际存在的 ordinary memory/plan；明确未选不自动补回。`read_only` 只描述来源/工作目录，不禁止已选择的普通 notes/plan 更新。Bot/context/伪造角色不借此成为真实 child 受理。
- `currentThread` 笔记归实际 child Thread；project/global 仍按原普通权限，父/兄弟私有笔记不继承。AgentPersonalization/Storage 与 KnowledgeStore 继续唯一拥有正文、CAS、原 mutation receipt。child 初始计划为空，不复制父计划；公共 Thread 计划读写/fork 与 Agent 工具使用相同 revision/历史选择。用户编辑计划不依赖 Agent 是否选 todo。
- 真实两 origin CAS 冲突链暴露既有 child 报告的次级推断：历史任一失败模型工具曾永久使报告失败，而策略图没有同样历史形状。本次按设计删除该永久聚合，由原 Run 终态与真实文本报告决定结果。冲突后读新 ref、合法更新、正常完成可交报告；原冲突 Failed/None、未知效果及文件停止屏障仍原样保留。报告完成不宣称每个工具成功。
- 最终 runtime **324/0、2 ignored**，kernel **70/0、11 ignored**；真实两 origin、未选工具、在途取消→重开原 receipt、不覆盖之后 UI 修改，以及既有策略/协作消费者均通过。Fresh binary 的真实 guardian/WorkingResult **1/1** 保持独立文件结果事实。准确 Linux x64 identity `0.9.25` stage SHA-256 `63458e925f0c85cfffc2fcf4dde02d0476b171376d759f41e6ed996e54f00a9c`；构建前后 Rust 输入清单一致。
- Host **34/34**、ThreadPlan UI **12/12**，Host 类型/lint/实际 bundle、all-targets 与生成协议/文档检查通过。独审原 Host 两 origin 红例复验通过，另验证 shared global/project 写删和 parent/sibling/外项目私有 ID 拒绝。组件中的 Catalog scope/history 与 notes Storage 原语明确为 fixture；计划数据库/private worker 是实际 owner。完整 Host IPC 组合已补复跑入口但未执行，不计成功。
- 后续继续同任务发现/会话互读、定向消息/等待/新续接，以及 Goal/LSP/Computer/远端等剩余领域。用户验收后负责全面迁移的边界不变。见[本阶段验收记录](../reviews/runtime-child-memory-plan-2026-10-10.md)。

## 2026-10-10 增量：子任务独立策略与规划模型

- 已受理 child Run 现在使用原 AgentPolicy/PolicyBridge，而非固定默认循环。首次准备按真实 child Thread 与已准入 project 路由，原 Launch/generation 提交完整 artifact/configuration；不复制父策略私有状态、不增加 preset 配置源。恢复先恢复原提交身份与保存的 planning 模型，再按原候选协议处理后来路由。
- Child 的策略/规划 generation 可在闭合边界变更，原 tools/source/profile/MCP/extensions 仍使用静态冻结目录。真实 PolicyAction ToolGraph 走相同权限/Operation/执行回执；未委派 memory 工具在派发前拒绝。内部 compaction job 仍固定且 tool-free，没有为 child 新建策略或执行账本。
- 规划调用使用 child Run/generation 的原凭据与真实模型 Operation，产出/usage 被原消费者读取并计入已存在的 delegated Goal；child 不继承 primary Goal 或自动续接授权。Prepared 与 dispatched 的恢复边界不变，未知已派发请求不自动重发。换代后 Pause→重开→Resume、报告正文及 no_changes 都由原 Run/ChildTask 交付；实际独立作业与文件结果仍按原停止屏障结算。
- 普通策略更新保留真实旧 pin；精确重绑可恢复仍存续的原 artifact。独审复现了同 artifact 多代配置下错误取首个实例的恢复缺口，修复只在原 artifact 候选内匹配完整 described identity、失配释放临时 pin。原双向探针修后确认新/旧配置都恢复，不存在配置拒绝；明确停用及最后引用释放后不复活，没有缓存权威或 latest fallback。
- 最终 runtime **324/0、2 ignored**，kernel lib **65/0、11 ignored**，Host **57/57**；all-targets、Host类型/lint/bundle、文档检查通过。Fresh binary 的真实 writable-child guardian / WorkingResult **1/1** 是共享消费者回归；新的 custom child policy 成功链走 Host helper 与 no_changes，不冒称自定义策略文件写入 E2E。Linux x64 identity `0.9.25` stage SHA-256 `ebe413729c39fe8108f7a4010e4c25c7134be567c7c1a86a8299d29073bf30bd`。
- 本地取消用例停在已存 dispatch intent 后、credential reply 前，尚无 HTTP 发出；它证明取消与晚到栅栏，不证明远端在途取消。实际 loopback adapter/usage、真实 SDK broker与组件 RPC 的证据分别记录；完整 Host IPC、真实 provider 账号与跨平台仍保留边界。child memory/plan/Goal/LSP/Computer/远端及 family 通信等完整设计工作继续，具体复跑见[本阶段验收记录](../reviews/runtime-child-policy-2026-10-10.md)。

## 2026-10-10 增量：普通扩展与 MCP 子任务委派

- Child dispatch 现在以原 ToolDirectory、schema generation、工具与 Host bindings 冻结实际配置；native 描述只投影原 owner 声明，UI 与 Host 不再用第二份原生工具名白名单。普通扩展保留原 artifact/configuration/declaration，不因名字相同获得原生进程/文件权限。完整 preset 先验证，缩减不掩盖不可用项。
- MCP 冻结配置来源、服务器定义和 global/workspace 执行作用域；子任务受理后在自己的实际目录派生执行资源，原未使用 Launch 仅允许一次精确绑定事务，恢复复用该原绑定。直接工具与 gateway 保留原可见服务器集合及别名，不能借新配置扩权；global server 仍用中立环境。Catalog 内部格式 **26**，直接拒绝旧格式。
- private ToolBridge 在原端点仍活跃时交接轻量 child 引用，确认后 Catalog 才受理；不在该控制步骤启动服务。原 ServiceRegistry pin 与 MCP scope 支持仍存续旧实现的独立 child 接管，父结束/通道重建不丢已受理引用，取消、未受理恢复、child 接管及终态按原身份释放。原停用/撤权和当前权限继续生效，不保存第二份执行账本或伪造父授权。
- 原停止屏障现在覆盖 workspace MCP 与 invocation-scoped 扩展的实际已派发调用，必须取得原执行端停止证据才能固定子目录。未知结果、协议取消或 Run 结束不被当作停止；同名 Host `process_spawn` / `wait_process` 不进入原生进程回放、观察和取消。文件差异仍由原 WorkingResult 计算。已取消 worker 与稍晚的明确取消请求交错，现在只补记真实意图一次，保持结果和重复幂等。
- 独审按设计独立复现普通扩展更新后 child 丢原绑定、workspace MCP 未停却允许固定目录两个生产缺口，修后原探针均绿；同名 Host 取消尾项原探针也绿。完整 runtime **324/0、2 ignored**，kernel lib **61/0、11 ignored**，最终相关子域 **24/24**、真实 guardian **1/1**。Portable Host **50/50**、普通扩展 lifecycle **31/31**、共享 Pi/MCP **13/13**、UI **30/30**。类型、生成协议、lint、实际 Host bundle、all-targets、新 binary 与文档检查通过；最后格式改动已独审逐字规范化核对。Linux x64 staged binary identity `0.9.25`，SHA-256 `d79ca6e27516726f5851036e97605960eec1eaa4a785ac69b1c0557a4a3b05de`。
- 本切片仍未完成 custom child AgentPolicy/planning、memory/plan/Goal、语言/Computer/远端等更广能力和 family 通信；两设计继续实施。完整 Host IPC 与不同 child provider HTTP 的未验范围不与组件证据混计。具体入口与边界见[本阶段验收记录](../reviews/runtime-child-host-delegation-2026-10-10.md)。

## 2026-10-10 增量：子任务执行配置、递归协作与真实进程结果

- 原 harness settings / preset resolver 现在编译 native dispatch 的冻结目录，配置仍只有原 owner；模型与 UI 看同一目录、原指令和不可用原因。`dispatch` schema **2** 接 `task/preset/workMode/tools`，替换旧 `model/profile` 内部格式。normal 继承实际父模型和工具，显式工具可缩减；配置 preset 先检查完整定义，不能用缩减掩盖不支持项。继承与显式选择的模型来源分开，thinking/temperature 由原模型 owner 规范化，显式零值不被 catalog 默认温度覆盖。
- 目录正文归原 ContentStore，Launch/模型选择/ModelStep/PolicyAction/ChildTask 冻结引用，后代共享而不递归复制。原输入与模型选择回执先于后来配置候选准备；相同 key 保留第一次选择。模型切换与目录按原世代原子生效。原 child profile 指令在 context 刷新、压缩和切源中保留。Catalog 内部格式 **25**，旧格式直接拒绝。
- 原生子任务支持所选文件/资源/问题/协作及完整现有进程工具，可从实际子任务工作目录递归 dispatch。私有副本不是 OS 沙箱；process 能力来自原配置/委派、source/grant 和当前权限，不由工作视图字符串制造。report 与进程寿命分开，独立进程仍活跃时文件结果保持 pending；真实写入租约排空与 guardian 停止证据齐备后才固定 WorkingResult。
- Catalog 原谱系承担指定子树取消，覆盖准备中后代、报告已结束但作业仍存续的 Run 及未消费续接，旁支不变。原事务同时核 expectedParentThreadId；短 ACK 不代表已经停机。新增短 `runtime.operation.status` 供取消预检，不依赖大正文可读。Host 由原 run.cancel_requested 中止冷准备，原 operation 事件即使 ChildTask revision 不变也唤醒结果核对；UI 在 report 后仍保留子树停止入口。
- 独审复现并修好固定结果恢复缺口：已有候选/发布回执时错误要求旧 cwd；现在只有首次实际目录捕获检查目录写入空闲，receipt-only 恢复仍核原 Storage 回执和 Catalog 停止事实。三种崩溃窗口删 cwd 重开复用同一结果。另一独立真实 Catalog 探针验证四层/两旁支、中间子树取消、错 scope 拒绝、旧派发和 source/context 迟到拒绝，重开后旁支继续。
- 冻结完整 Rust 组合 **376 passed / 0 failed / 12 ignored**（runtime 317、kernel lib 59）；后续局部恢复修复独立 red/green 通过；最终 kernel lib **59/0、11 ignored**、runtime 子域 **40/0** 重跑通过，不重复累计。真实 Linux guardian 组合 **1/1**，覆盖 report 后后代仍写文件、定向停止 A/G 而旁支继续、原 Storage 固定实际 bytes、删 cwd 重开复用结果且不重跑。Portable Host **58/58**、UI **30/30**，共享 protocol **5/5** 与 Pi dispatch **4/4**；另一个既有 Pi 非阻塞提问用例同基线失败，未算通过。生成协议、类型、lint、实际 Host bundle 与文档检查通过。Linux x64 开发二进制 identity `0.9.25` 已 stage，SHA-256 `3b1ae65ddc73c6b8610e2c1d1846f5d36f0cbe1e086d1b41ee64213cef87e37e`。
- 本阶段可执行的是 native 工具名配置的 custom/override 或 normal 的明确缩减。现有 Pi worker/retrieval 工具组不会被静默映射；MCP、扩展、自定义策略、语言/Computer/远端等 child 绑定仍需继续。Native Thread 尚无持久 work focus，限制该作用域的配置明确不可用。实际 Host IPC 产品链与跨平台证据仍待补，默认切换交用户验收后执行。具体边界和复跑命令见[本阶段验收记录](../reviews/runtime-child-profiles-2026-10-10.md)。

## 2026-10-10 增量：交互进程回执与原任务终端

- `process_write`、`process_resize` 现在沿真实 ModelStep 或 PolicyAction/node、冻结 schema、原 source/grant 与 Operation 执行。ProcessManager 统一分配进程序号并串行 stdin，resize 不排在阻塞写入后；调用者不再维护独立 sequence。底层 `process.write` / `process.resize` 直接以 operationId 和原始意图取代旧 queued 成功合同，所有现有 shell、远程 shell、LSP/终端与 stream 消费者都等待实际回执，没有旧协议兼容分支。
- 既有 Storage operations/operation_owners 保存短意图与原授权身份，guardian 原回执保存实际已写字节下界、EOF、尺寸、取消及 applied/partial/not_applied/unknown。正文摘要、块传输和持久 I/O 在执行 worker；没有第二进程执行账本。管道 EOF 真实关闭输入，PTY 不伪造 EOF；尺寸约束来自原生 u16 协议。已写字节不等于子程序已处理命令，unknown 不自动重发。取消停止尚未发送的块，已阻塞写入保留原 owner 等待实际确认，不以取消输入观察杀死进程。
- `runtime.run.reconcile` 按 Catalog 原 native invocation 和 Storage 原 process/root/grant/intent 私有读取已存 guardian 回执，覆盖原 grant 在写入后撤销、Catalog 尚未结算的恢复；不会复活旧授权或重新发送内容。公共 inspect/input 继续核当前与原 grant，follow-up 的跨 Run 观察关系不授予写入。已知 unknown 仍能从随后出现的原最终回执精化；确认过的相同调用不重复写入。
- 认证 `ThreadsAPI.processes.openTerminal` → 原 Thread/branch/Operation → 冻结来源重新准入窄 grant → `runtime.process.access` → retained KernelManagedProcess → 既有 TerminalRuntime/UI，展示和输入都是原 PTY。不会再启动替代进程；关闭视图/Host detach 不停止独立 Agent 作业，也不删除其 spool。明确停止仍取消原 Operation 并等待真实停止，错误视图可重新绑定原 spool 而不重发输入。终端 cwd 使用进程真实子目录；自然退出的输出/exit 先交付，再完成 projection。
- 原终端协议统一为 v4：renderer 发送 inputId，Host 绑定原 session 的 operationId，只有原写入 Promise 获真实回执才返回 written。断连或 partial/unknown 使原 UI 调用保持明确未确认，不把 WebSocket.send 当完成，也不自动重播旧按键/命令。旧 shell supervisor 的异步输入失败保留实际 writer；之后真实退出仍能结算，不能误报为从未启动。安装示例 `domain-policy` 现在实际编排 PTY spawn → resize → write → wait → inspect，并拒绝把不确定输入当作成功继续。
- 独审复现两条消费缺口并按原失败条件修复：两条阻塞 stdin 原先会占满共享 request window，拖住无关读取/新输入及旧直接 kill；现在完整正文进入原可取消执行 owner 后单独确认释放传输 credit，原效果 Promise 和关闭 drain 仍保留到最终回执，直接 kill 使用原控制 response window。并发 resize 现在有独立于 stdin 的原进程 FIFO；实测先受理 A 并暂停其 worker、先运行 B，B 不再越过 A 把最终尺寸倒退。没有扩大窗口、转堵取消通道或新增全局执行队列。
- 最终原生验证：完整 runtime **311 passed / 0 failed / 2 既有 ignored**；kernel lib **56 passed / 0 failed / 10 ignored**，其中独立显式执行的真实进程交互 **7/7**、原 ModelStep 输入/撤权恢复 **1/1**、一般策略完整领域链 **1/1** 均通过。实际覆盖 PTY resize/input、blocked pipe 的部分写入取消与可用控制、回执文件发布故障后已写下界、重复/重开、原授权撤销后私有恢复；没有使用付费模型。Linux x64 kernel identity `0.9.25` 已新编译并按 manifest/ELF 校验，SHA-256 `94f268521a6be3ca4e8fc5bb7f231b67b68d90ff150bc238e1c725923ea21d70`。
- 最终实际 Host 消费组合 **89 passed / 3 skipped**，含两个真实 renderer transport → Host handler 内存帧交互，原 source/client/projection/TerminalRuntime 绑定及已安装策略；UI 行为 **39/39**；实际 KernelClient 传输 credit/取消/drain 与原窗口行为 **5/5**。Host 生产/测试类型、UI/example 类型、实际 Host bundle 与生成协议检查通过。内存帧用例不监听网络；这组证据与真实 Rust OS 用例分别成立，未执行的完整 Host IPC、真实网络 websocket 与跨平台验收仍单独保留，不拼接成产品端到端通过。
- 独立审查先从两设计建立验收，再追真实消费者；原 credit 失败探针修后通过，真实 PTY 交错独立复跑通过，最终 stage 指纹前后相同。本切片无剩余已知实现阻断。可复跑原生组件入口见 [kernel README](../../kernel/README.md#interactive-process-component-acceptance)；子任务能力/profile/模型选择、递归协作及其进程停止/文件结果边界等设计余项继续推进。

## 2026-10-10 增量：一般策略的计划、提问与进程观察

- `todo`、`ask_user` 和 `wait_process` 现在接受真实 `PolicyAction`/node，与模型调用共用原 Operation、权限、资源准入、领域 owner 和 canonical 调用回执。只有 ModelStep 写 provider 工具配对；JobAccepted 始终只是受理，图节点消费与领域终态分别保留。共享短 Job 校验替代子任务、问题和进程各自的模型专用分支，没有第二份执行、计划、问题或进程账本。
- 原策略边界保存真实 `history_range`；计划桥接从冻结调用、schema 和原 head 形成视图，正文在 Catalog 外加载后核对原身份。KnowledgeStore 的工具来源直接使用既有 tagged `ToolOrigin`，保留原 Operation/Run/call/effect epoch，旧 flat requestId 不作兼容兜底。实测修复了已写计划、ToolSettled 前重开把 epoch 改成新 owner 而无法读取原回执的问题：已派发效果保留原 epoch，新执行仍受当前 Run/graph 栅栏约束；原图恢复只查询已有回执，不重做 mutation，也不覆盖后来的用户计划编辑。
- 问题/进程 Wait 在普通策略回调前停靠，保存已提交私有状态和原 continuation；真实失败/indeterminate 同图节点仍可交策略决定 Fail。被 Wait 替换、尚未执行的提案不推进私有状态。回答/进程交付先核对原 model exchange 或 graph node 已消费 JobAccepted；注册与停靠之间取消观察只解除原观察，不停止独立进程。真实回答和取消继续走原 Thread/branch/Operation/Wait，Goal 手动暂停不被回答清除。
- 新增普通纯读 `question_status`，只读取同 Run 已受理问题，明确区分 awaiting_user、answered、cancelled；只有 answered 返回原用户答案和 history identity。读取引用正文和重核 caller/question/Wait 分离，策略通过既有 ToolGraph→ReadResult 消费，没有任意历史/对象读取接口，也不把答案作为权限。普通已安装示例 [domain-policy](../../examples/extensions/domain-policy/README.md) 完成计划 CAS→提问→答案读取→可选固定进程→观察→Deliver/Pause/Resume，不调用模型或把答案拼成命令。
- 实际 Host source-start/rebind 组合发现旧负向内置工具列表把 `goal_report` 和新增 `question_status` 当作 source 工具，导致 durable tools 冲突；已改用 source 准入和投影共用的明确 source 能力集合。公开问题卡和回答路由仍消费原 Operation，无需 ModelStep 身份。Catalog 内部格式为 **24**，旧格式在 owner/recovery 写入前拒绝。
- 独立审查还复现并阻断了模型混合链：有状态策略 RequestModel→真实 provider 工具输出 ask_user→ExecuteTools→Wait→用户回答后，正常续跑与重开均错误退为 Started。最小修复只把最新、已消费、同 Run 的实际 Wait checkpoint 识别为恢复边界，保留原 ToolsCompleted；真实 input 交付后、下一决策前崩溃则交 InputDelivered，保留已提交私有基线。两条原独立失败探针均修后 Completed，原模型/Job 配对不变；新输入窗口也先红后绿，没有用任意旧 checkpoint 兜底。
- 修后完整 runtime **311 passed / 0 failed / 2 既有 ignored**，kernel lib **55 passed / 0 failed / 2 ignored**。领域 focused **11/11** 覆盖上述混合恢复与原图/Goal/回执；process Wait **10/10**，计数与完整套件重叠。真实 guardian 纵切单独通过 **1/1**：原生 Engine/Catalog/Storage 中计划→提问→重开→真实答复→进程 spawn/wait/inspect→交付/暂停/恢复，零 ModelStep；其中计划 owner reply 明确为 fixture。Portable Host **4 文件 52/52** 包括实际 PrivatePlanBridge→KnowledgeStore worker/数据库的原回执重开，以及真实安装 artifact/broker 的策略消费者；后者提供已提交领域事件夹具。现有 UI 两个 owning suites **40/40**，涵盖 policy-node 问题的回答重试与过期禁用及计划编辑。上述各层不合称完整 Host IPC 验收。
- 生成协议一致性、Host 生产/完整测试类型、UI 类型、示例窄类型、变更 lint、实际 Host bundle 与文档链接检查通过。最终 Linux x64 开发内核按 build identity `0.9.25`、target `x86_64-unknown-linux-gnu`、arch `x64` 编译并 stage，SHA-256 `befd0b599059ffdc9d65eda18cdb307583602b59a985021ad68da5f94e420377`；该二进制的真实 guardian 纵切再次 **1/1**。独立审查接受本切片，没有剩余已证实的行为阻断。实际 Host IPC、真实模型和跨平台证据仍按原范围待补；用户验收后的默认切换与全面迁移分工不变，其余设计能力继续推进。

## 2026-10-10 增量：已持久但未派发模型候选的原生恢复

- 闭合前一 Goal 阶段独立探针确认的原生恢复缺口：真实 Engine 提交 `RequestPrepared` 后、`ModelDispatched` 前崩溃，现经原 Catalog→RunSupervisor 路径恢复同一 Run 和真实输入。原候选明确终结为 `NotDispatched`，完整冻结请求继续保留；没有合成 `ModelFinished`、provider 正文、零用量或输入 supersession，也不直接重发旧序列化 transport。
- 策略的 pending proposal 与已提交私有状态基线一直分开，直到实际 `ModelDispatched` 同事务消费。未变候选重开复用原未执行决策，不重复推进私有状态；真实 boundary/interrupt 输入或 Goal 世代变化使旧提案失效，但保留已交付正文、opaque originals 和真实 continuation。第二次崩溃发生在旧候选已闭合、新 engine 尚未进入时也可恢复。
- 复用既有 capture、worker 锁外读取和 publish 核对，不新增恢复队列、执行账本或 provider 路径。原 Run/epoch、head、policy checkpoint、Goal 绑定与 launch 身份共同阻止迟到准备覆盖新事实；仍活动的原候选不能借恢复换 model/credential/tools。旧候选明确闭合后，显式新选择通过原 select/prepare/activate 接口生效。
- Supervisor 无 worker 的取消也沿 metadata-only 关闭未派发候选，损坏请求正文不阻碍取消。准备期 worker 失败保留真实非派发事实；手动 Goal pause 跨重开保持，仅显式 resume 后才允许当前世代推理。真正已派发请求仍是 Interrupted/明确 Missing 用量，不会被重分类后重复发送；既有外部效果和模型工具配对恢复门控未放宽。
- Catalog 内部格式为 **23**，旧消费时点格式在 owner epoch/恢复写入前拒绝。生成协议与公共 `ModelStepState` 增加 `not_dispatched`，实际 Host 生产声明和完整测试类型检查通过。
- 初次冻结完整 runtime **309 passed / 0 failed / 2 既有 ignored**，kernel lib **44 passed / 0 failed / 1 既有 ignored**。新增十二项真实 Engine/Catalog/Supervisor 场景覆盖原失败边界、再次重开、真实输入、Goal 变化/暂停、原策略基线、损坏正文取消、重复错误绑定拒绝和正常显式模型选择。独立审查随后发现一个真实 continuation 窗口：恢复重准入的 Prepared 后、dispatch 前新 interrupt，使内存状态过早消费原 Delivered。已把这一内存消费点同步推迟到实际 dispatch 成功；强化原二次重开用例由红转绿，同一仓库外独立探针也确认原 Delivered/committed state、一次 provider 调用和原无用量候选均保留。最终修后完整 runtime **309/0/2 既有 ignored**、kernel lib **44/0/1 既有 ignored** 再次通过。Linux x64 开发内核按 identity `0.9.25` 编译并 stage，manifest/ELF 验证 SHA-256 `566ed04aa086f4bc71c00f620187db32cb9add60d9fce311b4be0b5b64501786`。独立审查确认原失败探针修后闭合，本恢复范围没有剩余已证实的行为阻断；不据此宣称实际 Host IPC、真实模型或完整设计已验收。

## 2026-10-10 增量：显式持续 Goal 与真实用量续接

- 显式 Goal 与单次 Run 分离，保存用户目标、控制状态、可选 output-token 预算和原始推理用量。普通输入和 fork 不自动创建持续授权；一个 branch 同时只有一个未结束 Goal。目标、报告原因和创建意图进入既有 ContentStore，worker 准备正文，Catalog 短事务核对实际 Thread/branch、revision/generation 并提交引用；控制 FIFO 直接返回当次短受理回执，不用后来状态冒充原命令结果。Catalog 内部格式为 **22**，旧格式明确拒绝。
- 主 ModelStep、策略辅助模型 Operation、已受理 child 和 owner-triggered summary 保留实际归属。child 尚未准备时也从原 JobAccepted 固定归属；summary 计入原目标的真实用量，但不注入执行该目标的指令。已派发请求的归属不会因目标更新、完成、取消或同 Run 后来建立新 Goal 而改变。用量从原推理 receipt 同事务汇总，普通工具结果、嵌套投影和重读不重计；失败、中断、取消与被拒绝发布的真实结果同样保留事实。
- actual、estimated、missing、pending 分开展示，input/cache/reasoning 沿 provider 原语义保留，不相加伪造总额或价格。可选预算按实际 output 控制后续推理，允许真实在途工作超出预算；零预算有效。已结束推理缺少实际 output 时，有预算的 Goal 以 `usage_unknown` 阻止继续推理/自动续接，resume 不清除证据，用户明确移除预算才可继续。预算耗尽、明确受阻与目标完成不混同。
- `goal_report` 是原 ToolDirectory 上普通绑定工具，核对原 ModelStep/PolicyAction、Operation、当前 primary Goal 和冻结 generation；状态变更与 canonical 调用回执原子提交，不制造模型调用或每轮必跑的评估链。Goal pause/更新拦截尚未派发的新工具效果，已派发和独立作业继续按原 owner 结算。先处理已受理问题/观察的原 Wait，再结束 Goal 所在轮次，避免留下无法回答的问题。
- 原 followup owner 增加类型化 `run_completed` 与 `goal_requested` 发生项，保留原 process stop 证据；消费发生项和新 Submission/Run/launch 同事务。普通 final 只结束本轮，Goal 仍可沿原身份继续；准入重核目标世代、预算、实际未结算操作、原依赖、用户队列与 branch/source scope。现有 coalesced worker 与 Host launch consumer 消费 `goal.run_ready`，没有第二 timer、任务树或执行账本。手动暂停不会被依赖完成、question answer、重连或预算修改覆盖。
- 整合实测修复了输入和等待组合缺口：终态 Goal 后的新普通输入沿原交付事务解除当前 primary Run 关联，真实下一请求消费它而不续计旧 Goal；active-but-blocked Goal 下的新 Run、报告后的同 Run 输入和失败后 promoted 输入原样停靠，不能被直接标完成。原报告事件与其后的真实 input delivery 区分“已报告结束的本轮”和新工作，显式恢复后再执行。parent Goal 结束不会把未完成 child/summary 伪报成功；原已受理独立进程不被假称停止。
- 公开 protocol/application-client/认证 HTTP/ThreadAdapter/snapshot 与共享 Goal 面板已接线。UI 保留编辑 revision 和草稿，冲突显式重读；不确定 start 重投原 key/objective/budget/Run，已受理但刷新失败不重新创建。分支/Host 晚响应不覆盖当前视图，Goal-owned followup 不提供绕开 Goal pause 的独立控制。
- 最终完整 runtime **297 passed / 0 failed / 2 既有 ignored**，kernel lib **44 passed / 0 failed / 1 既有 ignored**；覆盖原 Engine、Goal tool、child/summary/辅助推理、用量重放、输入/Wait、fork/reopen/过程续接。首次完整回归暴露一个旧测试仍期待恢复 usage 为 absent，已按新明确 Missing 合同改为 typed 未知断言后完整重跑。Portable Host **3 文件 25/25**、UI **4 文件 49/49**，最后已结束目标提示修整后 Goal **8/8** 重跑通过（重叠不累加）。生成协议、Host 生产/测试类型、UI 类型、变更 lint、实际 Host bundle 与文档链接检查通过。Linux x64 开发内核 identity `0.9.25` 已 build/stage，SHA-256 `fd34e8f13b130f32649e861e0f8cb147479a6ed0ae3fbfec4ba1776a8b9d5cee`。
- 独立审查先于实现形成六闭环标准，冻结后跟踪实际消费者。仓库外真实 Catalog/ContentStore 探针验证旧 epoch 候选拒绝、手动暂停跨重开保留、旧历史 fork 不继承授权、实际 GC 删除 orphan 后目标/用量仍可读，以及显式 resume 原子准入后重开仍是同一 Accepted Run、没有第二发生项。本 Goal 增量未发现剩余已证实的新行为阻断；独立恢复探针暴露的既有能力缺口如下保留。
- **本次 Goal 交付时保留、后由上方未派发恢复增量闭合的缺口**：RequestPrepared 已持久但 ModelDispatched 尚未提交时崩溃，原 Catalog→Supervisor 重开入口会因 unresolved gate 安全停在 Waiting，不发生 provider 请求，也不伪造用量/完成。独立探针对 Goal 有/无均复现，基线已有同门控；这不是本次 Goal 新回归，但未满足完整“已准入未派发”恢复能力。后续已先闭合该原生恢复边界，再推进一般策略的提问/计划/进程观察。通用日历/事件和剩余领域仍未完成，实际 Host IPC、真实模型及平台证据仍按原边界保留，默认迁移交用户验收后执行。

## 2026-10-10 增量：原生显式 skill 输入与原版本消费

- `/skill:name args` 从既有 Host 资源 owner 的完整已选列表选择，hidden skill 可由用户显式选择。语法沿锁定 SDK 的起始命令和首个 ASCII 空格，只对参数元数据 trim；原始 text/images 原样保存。Host 解析原 checkpoint 中已捕获的 SKILL.md，材料独立进入原 input-history ContentStore 对象，不伪造模型调用、ToolResult、system 或用户原文，不建立 activation registry/第二队列。
- submit、boundary/interrupt/next-run enqueue 与 edit 共用既有 Catalog 输入事务及 revision。初次或显式切源时材料绑定同次新 context；已有 context 使用 Host 实际读到的 ID。整合发现并修复了已有 A 切源 B 时内层 null（新候选）与外层 A.id（替换 CAS）的混淆。图片-only 编辑保留原选择，任意原文字变化重新选择或清除材料；失败、取消和交付竞争不能半更新。原 submit/enqueue receipt 先于后来派生候选解码/准备，重复 interrupt 不再次中断后续 generation。
- canonical history 把材料投成独立 `ExternalData`，原用户 parts 仍是 `UserInstruction`。正式 activation 从真实 input ID、正文 revision 和 ordinal 派生，ModelStep 与 policy node 只冻结实际保留的类型化材料引用。`resource_read` schema **2** 的 activation selector 由原调用核验，追真实输入祖先、原 checkpoint、descriptor 和 version；当前默认资源刷新到 B 后，旧 A 材料的支持文件仍读取 A，不回退到最新或 live 文件。
- compaction 的既有 recipe/checkpoint 保存小型类型化来源引用，不重复注入全文或从摘要文字恢复授权；fork/reopen 沿真实继承历史恢复，非祖先同 Thread 输入不能借 selector 读取。原 checkpoint/input roots 与 publication 继续承担 GC。已受理正文作为历史保留，后续新资源读取仍检查当前项目 trust、Run/调用取消及 epoch；正文不授予文件/进程权限。Catalog 内部格式升为 **21**，旧格式拒绝，无迁移或双读。
- 实际 Host index、私有生成协议、认证 submit/enqueue/edit 路径与 Thread UI 已接通。UI 插入命令不直接发送，保留草稿/图片；历史和队列分开展示冻结名称、来源和版本。typed resource 失败有安全文案，stale 后保留原草稿并可刷新重试。含 ASCII 空格的名称仍可见且可由资源工具读取，只禁用无法精确表达的命令按钮，不增加 owner 名称硬限制。
- 冻结完整 runtime **281 passed / 0 failed / 2 既有 ignored**，kernel lib **42 passed / 0 failed / 1 既有 ignored**。覆盖原始 RPC receipt 在后来候选 malformed 时复用、首次 interrupt 身份、实际 Engine/ToolDirectory/OwnerChannel 绑定、原子切源、compaction job recipe、fork/reopen、队列修订与 GC；最终三处选择语义文案修改后，资源 owning runtime **11/11**、kernel **2/2** 复跑通过，不重复累计。Linux x64 开发内核按 identity `0.9.25` 编译并 stage，manifest/ELF 核验 SHA-256 `3440e47f1ad61f3d18f6e4938748b76051b774db4fe0818c4fd2d4274809b4f6`。
- Portable Host 组合 **8 文件 65/65**、UI/投影 **3 文件 40/40**，Host 生产声明/测试类型、UI 类型、实际 Host bundle、生成协议一致性、变更 lint 和文档链接检查通过。旧 Pi catalog/command/editor 收敛、Goal/通用日历、后续领域和默认产品迁移仍未完成；实际 Host IPC 验证缺口继续保留，不将独立组件通过拼接为完整端到端通过。
- 独立审查先形成原文/来源/版本/取消/恢复条件，再审完整消费者。仓库外 Host 探针验证实际 bridge → owner → 原 snapshot 参数 → 窄原 A reader，当前 B 下读取 A 的未预捕获支持文件、撤 trust 拒绝与 epoch 变更 stale；其底层 Storage/RPC fixture 范围明确。另一原生探针在真实 Catalog/ContentStore 上执行 next-run A 入队、刷新 B、同文图片编辑、重开、拒旧 epoch 候选、复用原回执与 promotion，仍为 A 的同一正文修订；Responses/Chat/Anthropic/Google 四个真实 serializer 保留原命令、图片与材料来源，不产生 system/tool 假事实。本 H2 范围未发现剩余已知行为阻断。

## 2026-10-10 增量：原生指令与 skills 冻结资源纵切

- Host 新 `agent-resources` owner 统一解释已准入的 SYSTEM/APPEND、目录指令、skill 元数据、包过滤与版本。配置、ProjectTrustStore、安装包和编辑器仍是原有 owner；不执行扩展、不安装包、不创建第二资源库。用户配置与受信项目配置分开，空值、缺失、损坏、无权限、不可用和取消保留各自结果。
- main source 使用原 Documents 协调的稳定完整捕获；Git child 在原 source receipt 同事务补精确资源范围、外部 ancestor/capsule 与 absence/coverage，固定继承复制原 provenance。用户资产、独立安装包由自己的只读 owner 捕获，不假称属于项目 pin。冻结的类型化 `ContextResources` 和完整正文放入既有 ContextCheckpoint ContentStore 对象，GC 复用原 checkpoint 根。
- ModelStep、policy graph 冻结原 `resource_checkpoint_id`。普通 `resource_read` 通过既有工具目录、原调用身份、私有 owner channel 与七态结果消费快照；模型不能选择任意 checkpoint/source/grant。已捕获正文不再开原文件或重新解析 settings。额外固定视图材料按原 branch/revision/root/receipt 重开窄 `storage.read` view，pin/read/release 不授予 file/process 或写权限。目录指令的合法 symlink 沿原 pin 解析，只派生具体最终候选文件 scope；不会给父目录/整根权限。项目 trust 只约束实际依赖它的选中资源，撤销不会阻断独立用户 skill 或目录指令。
- 独立资源 refresh CAS 保留 summary/history anchor、原即时记忆快照、profile/composition、Thread 角色/项目及 source。显式切换 input source 时，Host 准备依据的 checkpoint ID 跟随候选进入原 input/Run/source 事务，覆盖了 Host await 期间的刷新竞争。`runtime.input.receipt` 复用原 command/launch 身份校验，已接受输入的重试不受后来损坏的资源配置影响，也不维护 Host 去重表。fork、compaction、重开及旧调用继续使用原资源正文，fork 不复制执行 source 授权。
- 认证 HTTP、`ThreadsAPI.resources.refresh`、实际 Host index 与 Thread UI 已接同一 owner。UI 只展示版本、来源、指令/skills 元数据及诊断，按显示 revision 显式刷新；冲突保留旧内容。此阶段还未接显式 `/skill:name args` 的输入/队列版本绑定，也未收敛旧 Pi catalog/command/editor 消费，不能称完整 skills 产品迁移完成。
- 最终原生组件验证：runtime **279 passed / 0 failed / 2 既有 ignored**；kernel lib **42 passed / 0 failed / 1 既有 ignored**。新 Linux x64 kernel 已按 build identity `0.9.25` 编译及 manifest/ELF 校验，SHA-256 `d9dd3411be346851baf68818dfd51086d4187c2c5cb4a4607fa0b772c7cf2e34`。覆盖原版本读取/GC/恢复、policy 无 ModelStep 调用、policy 单独取消、只读 pin/ancestor metadata、fixed handoff 原 provenance、原子切源与输入重试；不推断为完整 Host IPC 端到端通过。
- 独立审查先从设计形成验收，再追调用/持久化/取消/只读权限链。仓库外探针复现并复核 Host 准备 CAS、重开原 receipt、fork 无执行 source 仍保原正文、多级同 pin alias、兄弟文件拒绝、取消后租约释放和外部 capsule 不越 bundle 捕获。Windows 路径、显式空 package manifest、FIFO 非阻塞失败也已独立复验。本 H1 范围无剩余已知行为阻断；不以这些探针替代 H2 或 Host IPC 验收。
- 最终 portable Host 组合 **51/51**、原 source receipt 行为 **8/8**、Thread UI 行为 **37/37**、只读 SDK 配置 **2/2** 通过；Host 生产/测试类型、UI 类型、实际 Host bundle、生成协议一致性、变更 lint 和文档链接检查通过。其 source/pin fixture 的严格权限模拟与原生 Storage 行为证据分别记录，不拼接成未执行的 Host IPC 验收。完整 `/skill` 语义、Goal/通用日历与后续领域、默认 Pi 产品迁移继续推进。

## 2026-10-10 增量：进程停止后的显式一次续接

- 用户可在真实 `process_spawn` Job 受理或原执行回执存在后，登记一次 follow-up。定义、独立 next-Run Wait、实际 occurrence 与新 Run 准入全部归原 Catalog；定义冻结原模型、策略、工具、来源选择及上下文作用域。没有从普通输入自动推导 Goal，也不复活已结束 Run 或放宽 run-bound Wait。Catalog 现为格式 **20**，旧内部格式拒绝。
- 触发只认原执行 owner 的真实停止证据。原回执首次确认 executor stopped 时发布通用 `operation.executor_stopped` 短事实；效果未知、JobAccepted、Operation 终态或占用行缺失都不单独证明停止。停止先于登记、甚至先于 JobAccepted 或崩溃，原 identity/opaque epoch 的事实仍可回找；重复回执保持幂等。原 Run 尚活跃、当前 branch 有工作/排队输入、来源或作用域已改变时 occurrence 明确 held，不抢用户输入或偷换来源。
- 内核事件唤醒独立、合并的 continuation worker。先锁外读取原回执并 staging typed EnvironmentFact，再在同一短事务核定义代、原 Operation、当前 head/checkpoint/source、取消与 owner fence，消费 Wait/occurrence 并调用原输入准入事务创建一个 Accepted Run。重复唤醒和准入后/Host 启动前崩溃复用原 receipt；worker 不依赖 Host timer、UI callback 或通知通道可写。原 Run 用户取消原子撤销未消费授权；显式 follow-up pause/resume 不消费策略 Pause。Agent 停止 fence 拦住旧 worker 发布，新 owner 可继续原未消费授权。
- 新 Run 只获得精确原 process 的 inspect/read 关系。Catalog 从原消费 occurrence 推导 source Run，Storage 同时核当前与原 grant、Thread、workspace/物理 root/cwd 和 source 身份；其他 process、同 Thread 无关 Run、stdin/kill 和新的 cross-Run process Wait 不因这个关系获权。换 kernel epoch 后按正常 source 准入重登记原 root，读取既有持久输出，不重发原 process 或旧 grant。
- 认证 HTTP、`ThreadsAPI.followups`、Thread snapshot 与会话 UI 已接同一原生定义。未确认登记回复重试沿原 key，控制带显示 revision，展示 held 原因与实际新 Run receipt；已消费项不再展示误导性取消按钮。Host 仅从特定 `followup.admitted` 事件继续 launch，启动恢复沿已有 pending-launch 枚举，不把所有 run.accepted 都当自动工作。旧 Pi follow-up/日历存储仍是其当前产品路径，未为本次原生 occurrence 双写。
- 冻结验证：完整 runtime **270 passed、0 failed、2 个既有 ignored**，包含 11 项原 Catalog 续接组合；kernel lib **39 passed、0 failed、1 个显式集成 ignored**。Host 组合 **16/16**，UI/投影 **25/25**，完整 Host 声明/测试类型、application-client 构建/类型、UI 类型、定点 lint、生成协议一致性、文档检查及实际 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建并 stage，SHA-256 `0cc452e083a638d38bed0ebc8319e7469c6309af9b50e27b20f422f1a0eed9b4`。
- 额外显式执行的真实 ProcessManager 组件链 **1/1**：KernelToolExecutor → Storage/ProcessManager 启动真实 OS 进程，原守护回执驱动一次准入，精确新 Run 读取原 stdout；同时实测当前/原 grant 撤销、其他 process/无关 Run 拒绝和新 epoch 正常 root 重登记后的持久输出。测试第一次重开漏登记 root、第二次 read 结算漏原调用准入，均由生产权限/事实检查拒绝；补齐真实调用顺序后通过，未放宽生产授权。它不使用 Host IPC 或模型 provider。
- 独立审查先从设计形成条件/取消/恢复/原子准入/单一权威验收，冻结后核完整消费链。仓库外 **3/3** 原生探针分别确认 JobAccepted 前早到停止、停止后/受理前重开仍等待原 Run 终态并复用原回执，以及 continuation 先提交时后到用户输入进入原队列；本阶段无已知生产行为阻断。审查所复跑 Host/UI 子集与上述组合重叠，不重复累计。
- 本轮新增的实际 Host HTTP → kernel → process → 自动新 Run → 模型读取原输出 fixture 已通过类型检查，受现有 IPC 环境限制未执行；其证据不能与 portable Host fixture 或原生组件测试拼成完整端到端通过。通用日历/事件触发、Goal、完整指令/skills 与后续领域、默认 Pi 迁移仍在推进，两份设计尚未整体完成。

## 2026-10-10 增量：ContentStore 显式回收与控制隔离

- Catalog 只准入一轮有归属的 collection，原 conversation.sqlite 的一致只读根扫描、正文校验、目录枚举、删除与 fsync 全部在独立 worker。只读事务在根捕获完成后结束，不用第二数据库、持久 root mirror 或 GC 操作日志。所有既有 history、原始调用/审计回执、policy/context/child 正文根沿原 owner 保留。
- publication/retained-read 的短登记不等内容 I/O gate；单调序号让扫描后的新 publication 即使已完成也使旧 mark 失效。worker 的正文 I/O 与 sweep 使用同一 ContentStore gate，覆盖已有 orphan hash 复用和实际 UUID staging。新 publication 使 sweep 在下一安全点退让；控制状态、取消与元数据提交不等待这个 gate。仅服务 fixture/启动的同步正文便利入口遇 collection 明确冲突，生产仍走 capture → worker → commit。
- collection 持有原 `runtime.owner` 文件的真实寿命。Catalog/Agent 关闭只请求取消，未停止的旧 worker 仍阻止同目录新 owner；完成、错误、取消与 unwind 释放同一临时 collector。mark 失败不删除内容；中途删除/清理失败保留实际阶段及已删计数，未知文件不删。没有恢复旧内存删除列表、无限重试或每个 Run 的清理屏障。
- 当前 Host 的认证 `POST /api/runtime/content/collect` 只接受空对象，经原 AgentRuntimeClient 和生成协议进入 `runtime.content.collect` 独立 maintenance worker。请求保持普通成本类别，不混入 Storage 或 history/receipt 队列，也不成为模型工具。报告明确 completed/deferred/cancelled/failed、实际 phase、对象/字节/staging 删除计数及 nullable reason；HTTP 关闭只取消本次维护，不取消 Run。
- 冻结后的完整 runtime **259 passed、0 failed、2 个既有 ignored**，kernel lib **39/39**。其中 8 组新确定性交错在实际 SQL 行、manifest 校验及已 unlink 后暂停，确认 Catalog status/Run cancel 仍可推进；同时覆盖后发 publication 计数回零、旧 orphan 复用与取消后原回执、实际在途 staging、替换根后的旧 reader、部分删除取消/失败、真实 owner 重开排他和 unwind 释放。原 retention suite 继续验证历史/permission/policy/child 等根，没有靠新增快照数代替正确性。Host 管理入口 **2/2**、完整声明/测试类型、定点 lint、生成一致性、文档链接及实际 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建并 stage，SHA-256 `9933e9db6ab990d4259d5a350d98016f439f7d8392f75c06ab451142c446a612`。
- 独立审查从设计先形成验收，再核实际锁/SQL/正文/owner/取消链与 42 个同步便利入口的生产调用关系，并独立执行冻结二进制的 8 项 race；本阶段无已知代码阻断。主动 AbortSignal 可先拒绝客户端 Promise，不能由此推断 worker 已停或保证断开的调用方收到 partial report；内核仍按原请求身份收尾和释放 credit。更新的 native Host 维护/授权场景仅通过类型检查，实际 IPC 证据留待可用环境补齐。控制隔离不声明固定延迟或物理 I/O 倍率；Goal、事件/日历续接、完整指令/skills、其他领域及产品迁移继续推进。

## 2026-10-10 增量：隔离可写子任务与原结果集成

- 显式 `isolated_write` 与既有 `read_only` 共用原 dispatch/ChildTask/JobAccepted。父来源 whole-root 读取授权形成有界 handoff 后，Catalog 先持久受理独立 Thread/branch，再进行来源捕获、上下文准备和物化。私有子目录的受控文本写入不要求父原来源已有写工具；父方集成是另一个显式授权动作。仍只接受已实现的 `model: parent`，不默开进程、递归派发或任意扩展工具。
- 固定来源复用原 pin；物理来源复用共享 Documents 稳定捕获，读取实际 materialized 目录而非旧分支基线。已保存文件、Git/非 Git inventory、mode/symlink 和未纳入的未保存 overlays 沿原合同处理。来源 provenance 正文由既有 Storage blob/ref 保留，与原 branch-create 回执一起提交；重启先读原回执，不重扫已固定的来源。实际 Documents workspace 身份与 Storage execution workspace 分开，避免受管目录错误命中父原根。
- 子 Run 终态、文本报告、物理写停止和代码结果各自记录。受控写入沿既有 Rust 文件/readVersion/CAS authority；实际 Run worker 与原 root lease 排空后才固定候选。候选与 base pins 原子保存，readonly worker 生成原 WorkingResult，再短事务提交 branch revision、结果 record/ref 与原发布回执。已固定候选在目录消失后仍可发布，重投不新增结果版本；取消和空报告不抹掉已确认修改，未知效果保留未知。
- 普通安装示例 `examples/extensions/child-integration-tool` 通过原 ToolDirectory/权限/Host invocation 调用既有 IntegrationCoordinator。选定 child/publication、实际父 Run/Thread/branch/source 和真实 model/policy origin 组成原 journal 因果绑定；同 Thread/branch 的后续 Run 可以显式集成。没有 Pi 会话伪装、第二结果库、第二效果日志或自动写回。现有三方合并、Documents 脏缓冲区 CAS、条件文件写入和补偿仍是效果 owner；`files-only` 包含文件/Document 内容恢复，不包含 Pi 对话历史回滚。
- 冲突检查沿原物理路径 lease 和原 unresolved journal，识别不同 workspace ID、嵌套根或别名下的相同资源。等待路径 lease 在工作区短元数据队列外，外部 Surface 等待不占该队列。普通扩展 callback 提前返回不能释放已受理的实际 domain promise；真实原回执独立提供效果与停止证据。已派发 native Surface 请求保留精确原 ACK，取消不伪称执行端已停；失去 owner 而无证据的路径仍保持未知及未决资源保护。
- 原 Host Tool 对账只接受 Operation/execution-owner 身份，由 Catalog 派生唯一 Integration journal，worker 核对原因果关系与路径事实。读取原收据不需要仍可访问的物理目录或新的 source grant，也不重执行、扫描补偿或杜撰停止。已真实停止但效果仍未知的回执可释放执行占用，业务不确定性和 journal 冲突保护仍独立保留。公开 child_status、Thread snapshot/UI 同步展示真实 source/provenance、profile、报告与固定结果。Catalog 总格式仍为 **19**，collaboration 域升为 **3**；旧内部域格式拒绝，不提供双读或迁移。
- 整合检查闭合了两个真实事件窗口：child 在旧推进任务排空期间产生新 revision，完成后按原新事实再检查一次；旧 epoch 的 domain discovery 排空时保留新 epoch 唤醒。没有新事实的失败不自旋。来源 grant 从受理就归原 Run 生命周期，撤权失败保留追踪；清理失败只报告，不覆盖已经取得的原效果回执。GC 同步补齐 child Launch 的必需扩展绑定引用，避免受理后尚无子 Run 时误删内容。
- 独立原反例闭合了真实逐路径取消与停止证据：第一条文件 ACK 后取消不再派发下一条；完整冲突与补偿 ACK 能确认执行停止；补偿不触碰从未由本次派发、后来被外部编辑成相同目标的文件；多 Surface owner 只撤销已派发组，不派发后续组。原 journal 保留实际 apply/undo 事实，未派发槽不伪称观察过 safety。Rust 对账接受已有停止证据且无 applied/compensated 声明的原 `external-intent`，仍拒未确认的 `external-dispatched`；终回执丢失后恢复原公开正文且重投幂等。缺失旧目录只保留其原资源身份，不阻碍无关目标；WorkingResult 的 root/baseRoot 沿原记录寿命保留，旧基线经 rebase、源分支删除与 pin 释放后仍可 GC/health。
- 最终完整 runtime **251 passed、0 failed、2 个既有 ignored**，kernel lib **39/39**。Host 组合 **16 文件 263/263** 后，最后取消修复单独复跑 owning Integration **69/69**；该 69 包含此前组合中的 Integration 用例，不作相加。已安装 broker/SDK 的 Integration 用例 **5/5**，原 invocation 生命周期 **3/3**，UI **35/35**。这些证据分别覆盖真实原生 Catalog/Storage、协调器、安装入口和 UI，不冒充同一条 Host 端到端链。完整 Host 声明/测试类型、UI 类型、定点 lint、协议一致性、文档链接与实际 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建并 stage，SHA-256 `e55537a0e4572d6ca4eb99a4da1b71743c8beaefc76e33e04068b67bfb6e0fef`。
- 独立审查按设计核对来源、写入、结果、集成、取消和恢复，保留四项原反例的修前/修后执行证据，并复核真实 Catalog/Storage 的最后回执恢复及 GC 根；本阶段无剩余已知源码行为阻断。**实际 Host/kernel 端到端缺口仍保留**：Unix socket `EPERM` 与官方提升初始化失败未解除，新增私有 child 写入 → 原 WorkingResult → Wait → 重开 native 场景仅通过类型检查，未执行。其余领域、GC 控制隔离、跨平台和默认 Pi 产品迁移仍未完成，两份设计尚未整体交付。

## 2026-10-10 增量：运行中策略安全换绑

- 原 Catalog 保存策略选择命令、候选与激活回执，原 Launch 保存实际 generation 和完整 target。选择同时核对当前活动代与用户看到的 desired selection ID；原命令重投返回原回执。候选描述/依赖/规划模型准备独立执行，ready 不等于 active，失败或被取代候选不撤掉仍有效的活动代。首次准备使用原 launch-bound/checkpoint 事实派生 `policy_preparable`，已经使用的默认策略不会在恢复时被当成未选择策略。
- Run worker 只在真正的新决定边界换绑。旧 decide、已存待执行决定、ModelStep/工具配对、策略图/规划动作和原观察先按原绑定收尾；独立 JobAccepted 不形成整棵任务树的终态屏障。新代的策略和 planning provider 在同一 live slot 发布，主模型、工具和 source 沿各自原权威。原子激活保存新代、私有状态、真实未消费 continuation 与事件，不伪造 Started、模型请求或历史输入。
- `varin.agent.policy@3` 的描述明确 `modelRoles` 与 `stateTransition`。同一完整 target 可保留状态；跨 target 通过显式 `transitionState` 返回 compatible 或 incompatible。没有钩子不猜兼容，也不默默清空状态。不兼容时保留旧代；用户明确的 `restart_state` 只重置策略私有状态，保留会话历史和独立工作。示例、SDK、合同、Host 与 Rust 同步替换旧内部合同，不增加 @2 兼容翻译。
- 原 checkpoint 区分 decision 与 activation，并记录 pending/consumed 和真实续事件引用；同一记录分别保留已提交状态与待执行决定的提议状态。正文在 worker 写入 ContentStore，发布保护与 GC 根覆盖候选 planning 配置、状态、动作和 continuation。激活已提交但下一决定/动作未完成时，重开恢复已提交代及原动作；已读取 ResultChunk 不被较旧图完成事件覆盖。真实 Catalog 重开将未激活候选记为 interrupted，保留 active；原终态 writer 在同一事务结束待选候选，live release 只释放持有者。Catalog 现为格式 **19**，旧内部格式拒绝。
- Host 精确恢复原启用 artifact/配置，不按当前 route 偷换；新 route 只准备下一候选。私有 decide/transition/取消/release 均携带 generation 与 transport epoch，规划模型按原配置/账户重绑并拥有分代凭据。整合修复了旧取消 ACK 迟到中断新候选，以及跨 epoch 旧异步清理删除同一已提交代新凭据的真实窗口；清理只作用于原 attempt/epoch。实际 callback 继续由原 service pin 排空，abort 不是停止证据。
- 认证的策略 inspect/restart/cancel 入口及 `ThreadsAPI`、Thread snapshot/UI 已接通。展示实际 active、持久候选及尚未形成持久 target 的 Host 准备失败。后一类临时诊断随 inspect/snapshot 刷新可见，暂停且无其他事件时尚无独立主动推送。重启/取消使用当前显示的原 selection ID；Pause 期间可准备，但没有候选更新、child 完成或 Host 重连能替代显式 resume。固定 child/context profile 不被策略更新扩大权限。
- 冻结验证：完整 runtime **250 passed、0 failed、2 个既有 ignored**；kernel policy 聚焦 **8/8**，包含旧模型/工具/独立作业受理到下一代、Pause/child 原组合和真实两代规划 HTTP/私有凭据接线。主模型未在规划组合中被误调用；模拟 HTTP 只证明请求/身份/次数，不证明模型质量或真实账号认证。合同/SDK **118/118**，Host 五文件 **42/42**（含真实安装 broker 11 项，其余为明确的管理接口 fixture），UI/投影 **24/24**，application-client **5/5**。完整 Host 测试与 UI 类型、定点 lint、协议一致性及实际 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建通过，SHA-256 `1eafa000321167cdfba011c89f8a7319052a4a817417001a2968792172aad36e`。
- 独立审查复现并修复了激活后旧 Complete 决定败给新输入、输入已交付却随即崩溃时，恢复跳过新决定并错误采用未生效状态的问题。同一原探针精确核对 InputPending，完成修前失败/修后通过；Started、Delivered、Resumed 在 live 与崩溃/GC 后都保留已提交状态，仅重新决定一次。当前本阶段无剩余已证实行为阻断。
- **实际 Host/kernel IPC 端到端仍未验收**：Unix socket `EPERM` 与官方提升入口初始化失败未解除，本轮 native fixtures 只做类型检查。组件、真实安装 broker 和原生 Engine 证据不拼接成未运行的完整端到端成功。可写子任务/条件集成、其余领域出口、GC 控制隔离、跨平台和默认 Pi 产品迁移继续推进；两份设计尚未整体完成。

## 2026-10-10 增量：普通工具目录、执行回执与材料入口

- 已安装普通 service 的单份 `tool` 声明进入与 ModelStep、PolicyAction 共用的 ToolDirectory。说明、输入/输出 schema、示例和 source 元数据沿同一声明保存；共享既有 Ajv 编译器，不新增 schema 引擎。公开协议由原 schema 生成，内部执行类型仍归 Rust。原 MCP 权威作为专用 adapter 接入通用 Host tool bridge，不用伪 MCP 服务包装普通扩展。
- Launch 保留精确 package/artifact/service/declaration 绑定；各贡献独立准备，同一 Run owner 合并 MCP 与普通扩展的 ready snapshot，闭合请求/动作边界才激活。初次 Run 不等待全部冷服务。真实并发反例修复了 A 已 ready、B 随后失败时错误回滚 A，以及旧 candidate 被清除后只恢复 Host map、没有重新发布可激活目录的问题。启动 ACK 前完成的后台贡献等待原启动唤醒取得真实 publication 结果，不能提前成功或吞掉失败；临时 Rust holder 变化也不提前释放 Host candidate 的实际 pin。
- 普通路由替换保留被冻结 owner，明确 disable/revoke 立即撤权；重新启用同一 artifact 取得新世代，不复活旧调用。独立真实安装探针发现并修复了恢复误用当前路由的问题：保存的 A 仍启用且原 artifact 可用时，当前路由已选 B 也能精确恢复 A；下一候选才按 B 准备。当前路由文件损坏不阻碍仍有效 A 的精确恢复，但不能产生新选择或候选；原 artifact 缺失、禁用或完整 binding 不符仍明确失败，不添加旧版本 loader 或静默改用最新实现。
- ToolDispatched 持久记录实际 Kernel/External 执行 owner；调用完成与执行者停止分开。取消观察可以返回 unknown，但原 callback、资源 occupancy 与未确认回执继续归原 owner。重启不把外部 Result 当成本进程已停止；迟到回执按原 invocation/执行 epoch 鉴权，worker 先保存完整正文，再由 Catalog 提交及 ACK。换传输 epoch 只重投原事实，不重执行工具；已确认回执不改原模型配对/调用 completion，不复活终态 Run。输出 schema 不符也保留收到的原 JSON 证据。Catalog 现为格式 18，旧内部格式拒绝。
- 权限使用真实 ModelStep 或 PolicyAction origin，不制造 requestId。Host 从原 Operation、Run 与不可变 source 派生调用域，只把按原 broker owner/generation 核对的 opaque token 送入扩展；调用结束后能力句柄失效。路由读取原 Run 准入 scope 的短元数据查询，null 保持无项目，不读取当前 branch 的 checkpoint 正文；这是 owner 对齐，不宣称已发现正常非终态 Run 的跨项目执行。Source 启动、重绑与后继 Run 统一从原目录投影 source-owned tools，普通扩展不会被误当作原生文件工具。
- `materials.snapshot` 复用原 WebMaterialStore、snapshot grant、持久 collection 和 Rust blob range owner。普通 SDK 示例位于 `examples/extensions/material-snapshot-tool`，保留 UTF-8 范围/哈希、空值、缺失/拒绝、冲突与损坏语义；不造 Pi session 或另一份材料库。真实 native Storage 范围入口已经接线，首次哈希校验仍可能读取完整对象，不声称所有底层 I/O 都受输出页预算限制。
- 认证的 `POST /api/threads/tools/inspect` 与 `ThreadsAPI.inspectTools` 返回实际激活目录、持久绑定和独立准备状态；撤权/未重绑不可调用，正常退休的原 pin 保留可用性。准备完成不等于激活，目录可见不等于已授权。这是当前工具查询出口，完整 service/event/UI slot 查询和 codemode 尚未完成。
- 验证按真实范围分别记录：runtime 库及全部集成目标分段合并覆盖 **246 passed、2 个既有 ignored**，不是单次 full-suite 全绿；旧 JobAccepted fixture 的停止证据修正后相关 39 项通过。实际 Rust bridge/Catalog/RunTools 两项、其余 kernel lib 23 项及 Run scope 查询一项通过，runtime doctest 目标完成但没有用例。最终 portable core 16 项及既有 continuation 8 项、材料域六文件 76 项、application-client 5 项通过；schema 编译器及既有 MCP 消费验证通过。Host 测试类型、UI 类型和协议一致性已核对。真实安装组合使用明确的 Catalog 管理查询 fixture，不能冒称实际 Host/kernel IPC。
- **真实 Host/kernel 端到端仍未验收**：本环境 Unix socket `EPERM` 及官方提升入口初始化失败的既有阻塞未解除，相关 native fixtures 只做类型检查。实际 Linux 开发内核构建为 `0.9.25`，SHA-256 `ea5283e91eb0a46d426a016f4163e0786b33594923abd17293fb37cfe9590950`；这不是正式发行或跨平台验收。默认 Pi 产品路线未切换，完整策略换绑、可写协作/条件集成、其余领域出口及 GC 控制隔离继续推进。

## 2026-10-10 增量：普通工具 SDK 与调用域边界

- 普通 Host service provision 可携带单份 `tool` 声明；`provideTool` 从同一 manifest descriptor 注册 `inspect`/`execute`，保留真实 JSON null/空值，缺失与非 JSON 结果明确失败。工具声明的输入/输出 schema、说明、完成种类和 operation 提示不是权限或可重放证据。本增量只开放 Result 作者合同，没有伪造 Job 接口。
- 工具 activation 必须与冷声明完全一致，漏注册或不匹配的候选不替换旧世代。普通非 tool 服务仍按原 id/version 取 manifest 权威，不因新工具规则要求作者重复声明 `multiple`。整合以真实双 broker 既有路由反例复现并收窄了这项过宽限制。
- 原 `HostServicePin` 增加撤权 signal；正常更新保留被冻结世代，disable/crash/revoke 唤醒调用。Host-only invocation scope 的值不跨 wire，child 仅携带按原 extension owner/generation 核对的 opaque token；SDK 提供调用级 capability client，callback 结束后句柄失效。原 pending/inFlight 等真实 callback response 或 process exit，取消等待和发送 kill 都不冒充已停止。通信失败请求原 supervisor 停止失效 broker，但仍保留其在途 callback 到实际结束。
- 三包 build/typecheck/lint 通过。最后完整合同/SDK/Host source suite **200 项中 199 直接通过**；另一项既有候选 storage 回滚测试仅因新增明确 `IPC disconnected` 文案不在原断言内失败，窄修该断言后原 case **1/1 通过**，候选/catalog/三文档回滚及重试行为断言均保留。已有本地 npm/Git fixture 使用 workspace npm cache，不新增产品依赖。独立真实安装探针验证取消中的 v1 callback 尚活时 v2 可发布和执行，释放旧 model/service pin 后 retirement 仍等待真实旧 callback 返回；本层无剩余行为阻断。
- **本次提交只闭合 SDK/扩展 Host 层**。原生 ToolDirectory、真实 ModelStep/PolicyAction 权限、执行端停止证据及迟到回执恢复、材料 snapshot 入口正在下一增量接线，未计为本层已交付。实际 Host/kernel 全链仍受已记录 Unix socket 环境限制，组件证据不能拼成未运行的端到端成功；Catalog 格式不在本次提交中改变。

## 2026-10-10 增量：独立交付与显式暂停续接

- `varin.agent.policy@2` 已接通 `deliver`、`pause` 及 `delivered`、`resumed`。交付直接沿既有不可变历史写入，来源保留原 PolicyAction 和策略身份；所有 provider 将其序列化为同一 Agent 的 assistant/model 输出，不制造 ModelStep、工具配对或 provider opaque 原文。空串和 Unicode 均保留真实值。正文、历史 envelope 和私有 checkpoint 在 worker 持久化，短事务同次提交原 head、动作和事实。
- Pause 同次提交原策略动作、checkpoint、Wait 与 Run waiting 状态。暂停中输入仅排队，独立 child/job 可以完成，Host 重连和 Catalog 重开都不自动续跑。`runtime.run.resume` 必须指定原 Run/Wait，先查原成功回执，再在公共锁外等待原停靠 worker 退出，原子提交 `policy.resumed`、Wait 消费、Run runnable 和原 launch 的重绑要求。重复旧命令返回原 cursor，不能打断新 worker 或解除下一次 Pause。一般 Wait 续接、Supervisor 准入和最终 Run 状态 writer 共用实际条件，不能越过 Pause；Run 取消按原 owner 结束 Pause，不读取 reason 正文。
- 统一恢复读取最新的实际 graph/model/control action。排队输入进入真实历史时，不覆盖尚未消费的 Delivered/Resumed 边界；下一动作准入败给输入时，未执行动作的私有状态不会提前生效。已有 action/checkpoint/input 事实足以区分原已执行状态和待执行决定，不加第二套事件队列。真实反例覆盖交付已提交而丢回复、Resume 后模型决定已存而新输入先交付再崩溃、原已存决定恢复及旧 resume 命令面对新活 worker。
- Launch 公开 `startable`、`pause` 派生视图，组合 Catalog 与真实 worker/quiescence 状态；Host 提交、恢复、提问/上下文/协作续接汇入原按 Run 单飞入口。现有事件泵启动/重连发现 launch，此后按持久 cursor 定点消费 `policy.resumed`，不等待冷凭据/扩展准备才观察 child/process。冷 context 准备与发布沿同一取消生命周期，旧异步结果不能迟到发布或重绑。独立审查复现了旧 start 回执未返回期间明确 resume 的新唤醒被单飞吞掉：原单飞现在合并期间的新 wake，退场前按有效调用者的 signal/凭据重读同一启动条件，不新增轮询或恢复队列。
- 客户端与 HTTP 分开 `resume(runId, waitId)` 和 `retryPreparation(runId)`，UI 显示原 Pause reason/Wait，重复点击和分支晚响应隔离，排队输入不冒充恢复；pending 准备期间 Stop run 和取消仍可达。新增普通 SDK 示例 `examples/extensions/delivery-pause-policy`，不自行写历史、维护 Wait 或开恢复传输。Catalog 格式为 **17**，旧内部格式直接拒绝；两设计正文仍保留完整目标，页首改为实施中并链接本台账。
- 最终完整 runtime **245 passed、0 failed、2 个既有手动诊断 ignored**；其中真实控制/恢复用例 6 项、provider 角色序列化 1 项。Kernel `policy_review` **3/3** 验证真实 Engine/Catalog/Storage 的原观察/取消及新增 child 完成后父仍 Pause、重开后显式恢复并观察原报告。合同 **3/3**、SDK **2/2**、真实安装 broker **9/9** 与 portable Host/HTTP 消费 **8/8**（分别执行）、UI 行为 **22/22**；最后示例简化后重建安装窄验 **1/1**。Host 全源码/测试类型、UI 类型、定点 lint、协议生成、文档链接和真实 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建通过，SHA-256 `e70f33144f9d0b2f1e617b486dcdbe720b43ef0d4c81fd07980b7b3834a8edb4`。
- 独立审查按设计复核真实原子性、恢复和取消，并以仓库外原探针完成 Host 丢唤醒修前失败/修后通过；另通过 child 受理 → Deliver → Pause → 子任务完成与重开 → 显式 resume → 原 Wait 报告交付与再重开 → Deliver/Complete 的真实 Engine/Catalog 组合，确认原受理不变、无伪 ModelStep 或重复历史。该探针的源受理为 fixture，不替代 Host 授权验收。本阶段无剩余源码行为阻断。
- **真实 Host 端到端缺口仍保留**：新增已安装 SDK → HTTP 显式恢复 → Catalog/history 的 native 场景仅通过类型检查，未运行。前述 Unix socket `EPERM` 和官方提升初始化失败未解除；未更换产品 transport，也不把 broker 提供事件和原生 fixture 拼成端到端成功。安全策略切换、普通扩展工具/发现、其余领域、实际跨平台及默认产品迁移仍未完成。

## 2026-10-10 增量：策略直接派生与观察子任务

- 已安装策略可在父 ModelStep 之前通过普通 `tool_graph` 调用 `dispatch`，继续自己的独立读取，再用 `wait_child` 观察原任务。核心核对真实 PolicyAction/node、原 ToolIntent、父 Run/Thread、源授权及冻结调用；沿原 ChildTask、独立 Thread、源 pin 与模型/凭据 owner 受理。没有伪造模型调用，也没有增加第二套子任务动作或状态表。子任务仍限定已实现的 `model: parent`、`read_only` 与固定源合同。
- Child/Wait 受理原子保存 canonical JobAccepted；模型调用才写原 `tool_calls` 配对投影，策略图消费同一原始调用事实。快速子任务可在父图消费前发布真实终态，原受理不被覆盖；崩溃恢复只补消费，不重复准备、源 pin、派发或模型请求。Wait 参数/来源在 worker 读取，提交核对原调用与图取消。
- collaboration wrapper 在调用策略之前检查真实待处理观察，保留原私有 checkpoint，避免把一个未执行的新动作的状态提前记账。报告与取消观察沿原 Wait/head 交付，然后续接原图事件。整合还复现并修复了“Wait 已注册、父尚未停靠时取消”的窗口：仅由原 child owner 认证的待交付取消观察可完成停靠，既有交付路径提交一次真实取消事实；其他 cancelled Wait 仍不能进入执行。观察结束或父 Run 结束后，只释放该观察自己的 occupancy/admission，独立 child 的寿命不受影响。
- 新增普通 SDK 示例 `examples/extensions/collaboration-policy`，展示派发、独立读取、显式观察、报告后父回答及 broker 重开后的原身份。Catalog 仍为格式 16、collaboration 域仍为 2；本阶段不改变持久形状，也没有旧格式兼容分支。 独立审查复核真实执行链，并验证迟到原受理不覆盖早到终态、同图多观察中一项取消不消费另一项报告，以及多次重开后的原策略续接；本阶段未留源码行为阻断。
- 最终完整 `varin-runtime` **238 passed、0 failed、2 个既有手动诊断 ignored**。Kernel 聚焦 **5/5** 覆盖真实 Engine/Catalog/Storage 的 source pin、受理后独立推进、原 checkpoint 停靠、报告/取消后续接与观察释放；模拟模型仅证明执行接线，不证明模型质量。真实安装 SDK/broker **3/3**、Host 全测试类型、示例窄类型及定点 lint 通过。 协议生成一致性和文档链接检查通过；实际 Linux 开发内核 identity `0.9.25` 构建通过，SHA-256 `40ec7950ca95d472d24bca5da1c122efe59d9da5247e2b999f6780dea3ee84eb`。
- **真实 Host 纵切继续保留未验边界**：新增的固定源/阻塞准备、SIGKILL 重开、取消观察后三条 Host/kernel 场景尚未执行，原因仍为此前确认的 Unix socket 环境限制。Portable broker 提供事件的检查与原生 Engine/Storage 检查不拼接成端到端通过。独立结果交付、显式暂停/恢复、安全策略切换及其余领域仍继续推进，两份设计与默认产品迁移均未完成。

## 2026-10-10 增量：一般策略工具图与原始调用完成

- `varin.agent.policy@2` 的 `tool_graph` 直接替换旧只读图；Rust、合同/parser、SDK、安装示例和 Host 消费一起更新。节点保留真实 action/node 来源、冻结 schema/源视图/执行端世代和显式依赖，不制造 ModelStep 或 provider 工具交换。合法新图边界可激活已准备工具候选；已受理图恢复仍使用原绑定。
- 模型与策略复用同一单调用准备、授权、完整资源/容量准入、派发重核、执行和结算。可信 opt-in 的纯读 Result 继续轻量；其他调用在派发前进入原 Operation owner。逐节点准备及已完成正文读取独立运行，不阻塞无关节点；图父仅编排，不拥有第二份效果账本。文件对账读取持久 `ToolOrigin`，不从操作 ID 猜模型请求。
- Operation 的 `call_completion` 保存原调用完成，节点回执与模型配对消费同一事实。tag 区分未派发、带必需正文引用的 Result 和 JobAccepted；实际 JSON null 仍有内容引用。JobAccepted 结束受理调用、允许依赖推进，作业终态由原 Operation/执行端回执和显式 Wait 观察。早到或迟到终态不覆盖原受理回执。
- 恢复分别处理原身份未派发重准入、缺失可信纯读重做、已派发效果查询原执行端、canonical 回执已存而图尚未消费。单节点持久取消在重开后仍生效；取消赢得派发提交时，使用精确未进入执行端证据结算，不吞其他提交错误。独立反例还发现并修复了旧恢复分支把只读 Job 的 `Effect::None` 当作已停止、误记 Failed 并拒绝真正终态的问题；现在依据原 Job 合同保留完成未知及占用，等待原回执，不重执行或补造受理。
- memory 策略调用沿既有领域 owner、CAS 和原回执工作。选用 memory evidence 时，核心认证 action/node、canonical 结果身份及原 memory 操作后，仅从候选请求删去同事实的重复 tail；不选择 evidence 时仍由原可信回执/tail 送达。主请求及辅助推理共用原 selected/sent/committed 交付 owner，稳定 system checkpoint 不因写入临时改写。
- 显式选中的旧策略版本不会因安装了唯一新 provider 而被悄悄替换。版本判断复用原作用域 routing/selection，候选准备沿既有 routing revision 与同服务选择快照核对；成功和可选缺失出口都验证同一候选，不新增路由库或重试层。Catalog 当前格式 16，旧内部格式直接拒绝；当前及历史原调用完成、图调用与结果引用参加同一 ContentStore 回收。
- 最终完整 `varin-runtime` 回归为 **231 passed、0 failed、2 个既有手动诊断 ignored**。实际 Engine/Catalog 覆盖上述恢复、Job、取消、零假模型配对和 memory evidence/tail 消费；其中 memory writer 是领域 fixture，不等于 production personalization owner。独立审查按设计复核共享生命周期，并用同一只读 Job 窄探针完成修前失败、修后通过，确认原终态接受、原受理不变、无 stop 不释放占用及父 Run 不复活。
- TypeScript 合同/SDK **114 项**、真实 ApplicationExtensionRuntime/broker 选择 **8 项**、UI 行为 **19 项**通过；完整类型依赖重建、Host 测试类型、UI 类型、Host bundle、改动 TS lint、协议生成一致性及文档链接检查通过。实际 Linux 开发内核 identity `0.9.25` 构建通过，最终 SHA-256 为 `b30ece5a45918defe834c14b74929ca80aec1b5e7e2582d1fe33c09efb8041a4`。
- **真实 Host/kernel 纵切仍未验收**：新增 memory artifact 确实通过 SDK helper 打包，源码包含真实 owner CAS 后崩溃、取消迟到、独立读取、选择/不选 evidence 和失败请求后续发窗口；当前环境的 Unix socket 限制未解除，这些 native 场景未计通过，也未用普通 Engine fixture 或 SDK/broker 通过拼接为端到端成功。上一阶段的具体 IPC 诊断继续适用。
- 本阶段仍不等于完整 PolicyAction 或两设计完成：策略子任务、独立交付/暂停及安全策略切换继续推进；MCP 权限、计划、提问、进程观察和协作的来源接线各自保留真实范围。完整内容回收仍占 Catalog owner，普通扩展工具、其他领域及默认产品迁移另有未闭合项。

## 2026-10-10 增量：工具结果与原始回执正文

- 普通工具结果、未派发原因和原始外部执行回执已进入既有 ContentStore；Catalog 仍是唯一执行事实 owner，只提交内容身份及 outcome/effect 等短元数据。普通正文与权限/策略/等待等短控制状态显式区分，包含 `permission` 等同名键的普通 JSON 不会被当成控制状态。Job 受理只保存原作业身份，不为短回执制造正文对象。
- 写入先在 worker 持久化正文，publication lease 保留至原子事实提交；公开 Operation/events、模型批次配对、记忆信任与投影、文件/计划/进程对账、子任务迟到回执和重启读取统一恢复原内容。当前及历史事件中的引用都是回收 roots，重复内容身份只校验一次。此阶段将 Catalog 格式升至 15，现行版本见上方最新增量；旧内部格式明确拒绝，不引入兼容读法或转换器。
- 进程等待固定 Run/Wait/进程/Operation revision 和分支 head，在 worker 读取原回执并准备生命周期消息，提交重核原边界。取消观察不读取原进程正文、不终止进程；已有交付复用原历史。迟到子任务回执也按同一准备/提交边界结算。
- 最终恢复检查实际复现并修复了旧崩溃窗口：执行端回执已持久化而核心结算尚未完成时重启，重复原回执不能因幂等早退而永久保留未知状态。现在只在原终态事实尚未应用时补结算；已应用的相同回执不新增 revision 或事件，成功/确定效果与失败/确定无效果都使用原证据，不重执行。
- 最终源码的完整 `varin-runtime` 测试通过：225 passed，2 个既有手动诊断 ignored。独立仓库外探针验证 null/空值、控制键碰撞、大 Unicode 正文的公开读取/events/GC/重开往返，正文缺失显式报错而控制取消仍可执行；另独立验证上述成功/无效果恢复与重复幂等。Kernel 编译、实际 Linux 开发构建、Host bundle、Host 测试类型及协议一致性检查通过。
- **真实 Host 消费验收仍受环境阻塞**：冻结 Linux 开发内核 SHA-256 为 `e6d97f9eaf589fab37b4127060999374179e99250180b267b05f2f053b232bb1`。所选文件/进程、计划、记忆、子任务、审批和提问 103 项在业务执行前因本地 Unix socket `EPERM` 失败；官方提升执行又在 sandbox 初始化失败。最小诊断确认 `/tmp` 与 workspace 的 Unix socket 都不可监听，而 loopback TCP 可用。这些用例未计为通过，未修改产品 transport 迁就环境，也未声明正式发行或跨平台验收完成。
- 本阶段补齐结果/回执正文边界；完整内容回收的 mark/verify/sweep 仍占 Catalog owner，另行处理。下一主线回到一般 PolicyAction 工具图、真实子任务、交付及暂停，沿用同一执行/资源/恢复 authority；完整能力组合和默认产品切换仍未完成。

## 当前增量：控制路径隔离

- 模型/工具启动装配归各 Run worker；受理先登记取消 owner 并返回身份，排队 Run 只在提升后装配。选用与辅助策略模型准备也已移出 Agent actor。真实 Catalog 的阻塞准备/独立 Run/取消后无模型派发验证通过；Windows HTTP、凭据等待及队列重启续接六项通过。
- Run 启动恢复在独立 worker 遍历不可变历史并读取正文/回执，发布前重核实际执行边界；控制受理不等待历史恢复。
- 物化的构建、校验和恢复观察离开共享 Storage 队列；Storage 保留物理租约、journal、提升授权和事实提交。恢复目录身份及源回收后的幂等回执缺口已修。
- 模型批次使用必需的无 I/O 预规划合同，各项独立解析、授权和准入；共享资源预约保留可能冲突调用的先后关系，完整资源与容量仍原子取得。
- 普通/策略正文和记忆交付解析在 worker 完成，事务保留真实来源和回执核验。最终取消与辅助模型旧 head 派发两个反例已修。
- 合并后运行时聚焦 79 项、真实物化场景 12 项、Host 物化回归 3 项通过；验证范围、产物和剩余结构边界见[增量审阅](../reviews/runtime-control-isolation-2026-10-09.md)。独立内容传输、冷打开隔离和完整能力组合继续推进，不将本阶段记为全设计完成。

## 当前交付

本次持续实施已接通独立控制/内容连接、冷打开 worker、统一工具端点和模型适配器注册。
真实 Windows 内核已验证双向大内容传输、阻塞内容时的控制/取消、简短取消回执；模型目录保留容量、思考档位与采样配置。
Run 内模型/思考配置已接到安全请求边界：期望选择独立准备，成功后原子激活；旧请求及工具保留绑定，失败不回退付费模型。排队受理固定当时配置，后续受理继承选定目标。真实 HTTP 跨模型工具续接、独立凭据、失败不外发、提问后重新绑定，以及 SQLite 激活后重启均已验证。
自动容量准备已接入现有用户/可信项目设置、独立摘要 Run 和持久上下文等待。候选固定祖先范围，等待期间追加输入保留；取消停止所属摘要，失败不重复付费生成。重启能发布已提交的原输出，派发后未知的请求保留待核对状态，不自动重发。摘要配方已从 Run 配置移入不可变内容，Catalog 只保存归属与边界引用。
超长源已分成固定内容引用；逐段模型输出持久保存，后段继承前段摘要，全部完成才发布。文本范围按 UTF-8 边界保留可回查身份，图片保持多模态材料。预算仍是本地估算，尚不声称精确匹配 provider 分词。
计划及记忆工具的身份判断改读 checkpoint 同次提交的 scope 元数据。记忆投影正文、回执合并及可信回执读取离开 Catalog 控制锁；发布核对实际内容引用和 checkpoint。并发状态变化重新读取 owner，停止后迟到的已确认效果仍可结算。
首次输入、子任务初始上下文及摘要输入统一先准备正文、后提交引用；初始 checkpoint 与输入、launch 同次提交。排队消息只存身份/状态，正文加载、编辑准备和公开查询移到 worker；送入模型时重核所选版本，新增尾部不使已选前缀作废。幂等意图独立保留原输入。真实连接检查发现上传阶段也会乱序，现由控制 offer 在编码/上传前登记同资源顺序，取消唤醒既有准入队列。对应输入 Rust 七项、准入/继承/子任务/摘要十八项及 Host/kernel 六条实际连接链路通过。新 Catalog 的全部域在同一事务安装，实际容量不足失败后可重新打开；旧内部格式不转换。
对话分叉固定捕获的源 head、上下文与记忆引用，祖先/工具配对检查及新正文保存移到 worker；源分支继续追加或换 checkpoint 不使固定候选作废，旧 owner 候选不能迟到提交。线程创建和分叉与输入共用 ingress 顺序。Rust 的配对/冻结捕获及实际 HTTP 的重启、压缩、分叉后续发链路通过。完整子任务记录和内容回收继续拆分。
MCP 工具共享不可变世代，Host 按具体世代及持有者保留连接；旧世代等在途调用释放，等待中的 Run 保留活动 owner。回复、取消及关闭使用事件唤醒，取消仍按实际效果回执结算。统一目录的候选准备不提前退休活动绑定，未变端点复用。配置/工具变化已接到作用域订阅和独立候选准备，闭合 ModelStep 边界发布，失败或过时候选保留活动组合；首次发现不循环取消自己的准备。发布保留不可变组合引用，回收及重启能核对实际选择。直接服务独立冷启动，同作用域共享准备和连接；就绪贡献逐项进入候选，慢服务不挡模型或其他工具。持久 schema 选择与实际活实例身份分开，禁用后重新启用同配置不会复活旧请求。重启只等待已选依赖，并恢复原目录。真实 stdio 验证覆盖授权/按需发现、配置损坏后保留旧组合、生成中更新、禁用及重新启用、慢服务准备中使用快服务及提问重启；SQLite 验证覆盖活动请求拒绝切换、未发布选择不能伪装恢复、回收后重启及旧 epoch 候选拒绝。其余扩展工具发布、MCP 资源/提示/Tasks 和脚本出口继续实施。
启动记录现只保存模型/来源/策略元数据和不可变内容引用。工具、MCP 描述及规划能力的解析、校验、保存和完整查询序列化离开 Catalog；来源/队列继承直接保留引用，工具激活及请求提交核对已准备的内容身份。回收保留各启动引用，损坏工具正文不阻断来源和取消。实际链路还修复了策略准备对旧默认组合名字的耦合，改为核对装配者给出的真实基线，并保留原选择的幂等恢复。Rust 聚焦验证覆盖启动/回收/来源、子任务及摘要共 22 项；真实 Host/kernel 覆盖 MCP 重启/重新启用、dispatch、来源继承、检索策略、规划和精确重绑七条链路。该轮内部 Catalog 使用格式 14、launch 域 3、collaboration 域 2，未保留旧正文读写或格式迁移。

策略 checkpoint 的私有状态及动作已改为不可变正文引用。普通执行、读取图和辅助模型受理先在 worker 保存正文，Catalog 只核对身份并提交引用；继续执行及恢复在锁外读取，Wait 仍核对原 Run 和实际触发/取消事实。回收保留两类引用。相关 Rust 图与辅助模型 33 项通过，手动性能诊断未执行；后续图定义及回执拆分见下段。

读取图和辅助模型的完整意图已改为不可变内容，图内共享工具目录只存一次。节点、依赖和回执由同一 Catalog 逐项索引；节点结算、证据归属和准入查询不解析完整图，也不重写其他节点的回执。恢复在 worker 还原正文及一致的节点快照，回收保留动作与回执引用。Rust 聚焦 34 项及真实 Host/kernel 五条链路通过，覆盖图/规划、精确重绑与问题重启；损坏图正文的反例确认取消和逐节点结算仍可完成。

子任务状态记录已拆出任务文本、配置和工具目录引用。受理在 worker 核对原 dispatch 参数并保存正文，提交核对原 Operation revision 与父任务当前授权；家族调度、取消及资源释放只读取元数据。公开任务视图、初始准备和报告分页在 worker 还原内容。Rust 子任务 12 项、真实源授权交接边界两项及 Host/kernel 启动/取消/重启/长报告四条链路通过；新反例覆盖回收保留与损坏正文下控制可用。报告选取、等待预览及交付正文随后也移到 worker；提交重核原 Run/Wait/分支 head 和取消，不允许迟到候选覆盖新状态，已有可见报告沿祖先记录复用。相关 Rust 13 项及真实 Host/kernel 启动、取消、重启、失通知交付和长报告五条链路通过。新增取消窗口反例确认旧候选不追加消息，新观察仍能收到原报告。
提问作答正文独立准备，收据保存内容身份，提交仍核对原问题/分支/等待及取消。问题查询和 Run 取消只读取本 Run 的相关问题。等待收尾按 Run 协调，join 不占 Catalog 或全局 worker 锁；作答和执行端收尾离开 Agent actor，取消意图仍先在其 FIFO 中提交。聚焦 Rust 反例确认两个等待者不会提前完成，阻塞收尾时取消仍可受理；实际 Host/kernel 的提问和进程等待 11 项覆盖幂等、答复/取消竞态、多问题、两种模型协议、恢复和授权。Windows 正常关闭先取得守护进程的持久停止回执再关控制管道；保留真实 exit code/signal 和 stopApplied，不把无回执说成已确认停止。
真实 Windows Host/kernel 验证覆盖后台、阻塞等待、两种取消、后段失败、完成后发布前崩溃和后段派发中崩溃七条链路；独立 Rust 摘要/内容回收检查覆盖原文、配方及材料保留，分段检查覆盖中文、非 BMP 字符、转义及图片身份。Provider 容量错误恢复、可替换预算策略、完整产品迁移及领域出口继续实施，整体设计尚未交付。

普通工具参数和审批 call/scope 已改为不可变内容引用，在 worker 保存、恢复和还原公开视图；受理及审批消费核对原参数身份，控制事务只处理元数据。todo 授权对完整模型请求的读取也移到锁外，提交前重核 owner 和冻结请求。记忆及文件效果恢复同步使用原参数的公开视图，修复了记忆恢复遗漏的旧格式读取。回收保留已结束审批的审计正文。Rust 聚焦 47 项、真实 Host/kernel 的提问、审批、todo、记忆恢复、子任务和进程等待 11 条链路通过；相关 crate 全目标编译检查、协议和 diff 检查通过。旧回收/进程夹具改用真实 schema 与原工具目录，未放宽生产校验。该轮仍留下普通工具结果和外部回执正文；其后续实现与当前验证边界见开头的 2026-10-10 增量，完整产品切换仍未完成。

- 工作分支：`implementation/native-agent-runtime`
- 首个纵切：新增独立 `varin-runtime` crate，建立持久身份、历史提交及模型执行的可检验路径；不把未接入的库称为产品能力
- 本文件只追踪实际状态和依赖；具体测试结论须来自对应代码与真实执行结果，未运行不记为通过
- 完整默认产品迁移尚未完成；显式原生入口的已验收能力见下文。Pi 与未迁移领域保持原权威，禁止新旧循环同时推进同一 Thread
- 已新增局部实现：Catalog持久身份/历史/Operation/Wait，执行loop与事务桥接，RunSupervisor控制，多家族模型适配、输入队列与边界中断、组合依赖解析与绑定；kernel独立control worker和Host显式client已有真实IPC验证，未替代生产Pi路径
- 独立审阅发现并已修复：续接claim后崩溃丢唤醒、后台handoff仍被终态Run阻止；模型完成与历史/工具调用现由同一事务提交。其余交叉边界继续审阅，最终测试结果以稳定代码重跑为准
- 显式 `live_root` 已接通原生定义、引用和诊断三个语言工具，复用现有 Documents、LanguageViewBinder/LanguageSupervisor 与 Rust 资源授权；同时已接通原生可组合关键词/结构检索，以及显式选择的 published-reader 语义检索和持久 embedding 外发事实。固定/物化依赖闭包、其余检索模型用途/代码智能及完整领域迁移仍未完成；dedicated rerank 的 native live_root 消费见最新增量。验收与边界见本文件末两节

## 2026-10-09 恢复后的增量

- 历史读取改为固定 head 的引用分页与现有正文分块读取；初始 UI 只载入最近 20 项，按需查看更早历史。已用实际 HTTP/内核验证累计图片历史超过单个 16 MiB IPC 帧仍能完整读取；错误游标、跨线程锚点和切换分支后的迟到响应有独立反例覆盖
- 原生对话分支现在接到 Host/client/UI；分支创建重试在新分支推进后不回退 head，非法工具交换边界拒绝。当前复制对话祖先，不复制活动进程、工作区授权或模型选择
- 显式上下文摘要采用独立持久 Run、固定源祖先和无工具策略；成功发布才切换 checkpoint，追加尾部与原文保留。核心独立验证覆盖正常摘要、失败／取消／工具输出候选与幂等发布；Host/UI 集成验证仍在进行
- 凭据增量接入 configured provider/model headers、仅 header 的连接、环境 key/bearer 和 Vertex 显式 Cloud API key。独立测试使用假凭据；ADC、AWS SigV4 等接线及真实账号验收不包含在本段通过结论中
- 这批工作尚未切换默认聊天、移除 Pi，或完成所有领域能力／平台发布验收。中断前未结束的测试没有计为通过

## 后续已验证增量：来源与认证

- 原生界面可通过现有 Documents/WorkingState 权威准备保存到磁盘的只读快照或可编辑副本；同键并发／重启重试保持同一基线，运行后的省略来源续接在内核受理事务内继承实际环境，不回退文件改动
- 原生 file_list/file_search 复用 compute worker 与读取授权，支持固定修订和物化根；真实内核验证了来源一致性、取消／释放和跨工作区边界。UI/HTTP 已检查旧 Host 迟到准备结果被丢弃
- 原生认证已接入现有 Host 的 Google ADC、AWS SigV4、Anthropic 工作负载身份与订阅 OAuth。独立检查使用官方依赖、假凭据和真实 loopback HTTP，包含签名字节核对、单飞刷新、身份切换、拒绝跨源重定向、工具名往返和签名内容保留；未使用真实账号
- 本阶段完整 varin-runtime 测试通过，类型依赖构建、Host 声明／测试类型及受影响 UI 类型通过。来源 HTTP、compute、UI 和 provider 独立检查有各自记录；不等于各云端真实账号、跨平台代理或正式发行验收
- 仍未自动同步副本回原目录，未完成副本与共享编辑器/Git/overview 绑定、实时记忆流程、默认聊天切换和 Pi 退出

## 初始实施顺序与出口（历史规划）

本表保留最初的依赖排序及当时状态，不是当前完成度；最新余项以紧接的“完整设计对照与剩余工程范围”和文件开头的发布增量为准。最终默认切换与 Pi/资产迁移的执行归属已由用户明确接手。

| 顺序 | 要完成的工作 | 必须建立的合同和出口 | 当前状态 |
| --- | --- | --- | --- |
| 1 | 原生事实与持久边界 | Thread/branch/Run/ModelStep/Operation/Wait/Delivery 身份；请求幂等；branch CAS；原文/opaque 项；短事务及 outbox；受理与副作用恢复 | 局部通过：真实SQLite两轮模型/工具/最终提交与重开；受理/恢复原语通过。附件保留、跨Run回执隔离与未闭合交换终结限制复验通过，未接生产 |
| 2 | 单一协议与调用分类 | Rust/TS 生成边界类型；持久 command 与内存 query；效果/资源/完成方式合同；错误与游标语义；凭据只存引用 | 局部实现：共享枚举/控制命令生成与显式Host client；全运行协议及UI消费未完成 |
| 3 | 一个完整执行纵切 | 默认 AgentPolicy →冻结 RequestSnapshot→真实协议适配→工具合法配对→历史提交/停止/恢复；模型请求不能成为资源权威 | 局部通过：真实SQLite执行loop、多家族provider协议fixture与本地真实HTTP流/错误/取消；输入队列与序列化窗口中断通过。完整认证迁移、全部provider与产品路径未完成 |
| 4 | 资源执行与 IPC 去公共长等待 | 独立准备/捕获作业；保留文件 CAS/恢复；进程推送流；控制与数据分离；每个取消有实际执行端确认 | 未完成 |
| 5 | 组合计划与既有扩展接线 | 在启用/配置变化时解析依赖与绑定；复用现有 Host/Surface、候选更新；在途绑定保留；观察者不阻塞提交 | 局部通过：原生绑定/pins/撤权、root-reachable依赖解析、候选scope检查及现有调用取消；真实 context/Decision/Observer 与 live-root retrieval 已接线；全域异步owner装配与生产迁移未完成 |
| 6 | 领域与产品消费者能力 | 完成下表全部能力；UI snapshot/cursor；远端身份一致；为用户验收和资产迁移提供明确入口与支持边界 | 未完成 |
| 7 | 完整能力交付与用户验收 | 两份设计的结构不变量和全部领域路径共同成立；完整产品与局部替换能力可用；冷/热/并发/更新成本及真实平台/发行证据；交付验收与迁移前清单。默认切换、Pi 删除和全面资产迁移由用户执行 | 未完成 |

步骤可在互不冲突的模块并行，但所有权切换必须依赖前置合同。先后顺序不缩减最终交付范围，也不要求把每个领域都重写为 Rust。

## 完整设计对照与剩余工程范围

2026-10-13 按两份设计、当前源码和本文件最新增量重新核对。此表替代早期仍把 Goal、策略子任务、MCP Tasks、Computer 或自动容量压缩列为未实现的中间对照；各历史阶段的原始验证记录仍保留。decision 已完成 TypeSafe/Cloudflare/llama.cpp 与 research_decide 有限片；dedicated rerank、原渐进 fast-decision、Explore LLM 和 query embedding 已接原推理回执及固定/物化/live_root code_retrieval。这些是既有可选调用路径的接线证据，不代表用户启用了相应模型；已有 Bekko 已接 native 查询、文档向量与主/child 生命周期，受控模型证据与实际 ONNX 包/硬件验收分开；scoped 冻结依赖和成功 usage 校准也已接通原消费者。实现、真实产品组合与外部平台验证分别判断，不按提交数、测试数或条目数估计完成比例。

以下顺序是 decision/rerank 后的工程优先级；可独立交付的领域可以并行。默认 runtime 切换、Pi 删除与全面用户资产迁移由用户验收后执行，我们负责迁移前能力、验收入口和交接清单。

| 设计要求 / 剩余类别 | 已有实际能力，不再作为从零缺口 | 仍需实现或闭合的实际路径 | 验收重点 |
| --- | --- | --- | --- |
| 总设 §15–17：来源、语言与检索 | 固定/物化/live_root 来源、隔离可写 child 与逐项结果集成；三类来源的定义/引用/诊断/hover/symbols/call hierarchy、关键词/结构/显式语义、dedicated rerank、渐进 fast-decision 与 Explore LLM；原 immutable reader、撤权和推理账本；固定工程派生视图及实际 child 消费；已有 Bekko 本地执行器的 query/文档向量、真实 worker 归属；managed Host 的文件/进程/检索/语言已沿同一冻结来源接通 | 其余编辑器语言/编辑候选与跨文件计算版本证据；已有 Bekko 实际 ONNX 包/硬件与质量性能验收；更多 provider/工程规模下的来源合同验证与真实双机网络验收 | 固定捕获树不能悄悄读 live 配置，目录外 provider environment 明确标识；同名远端路径不串源；旧 reader/配置切代与取消恢复；正常可选缺失不吞选定实现失败 |
| 总设 §12–13、§18、§24：推理用途、记忆与 Bot | 多 API 家族原生适配及原 credential owner；规划模型、embedding、TypeSafe/Cloudflare/llama.cpp decision 与真实 research_decide；自动容量水位、可替换预算 Decision/冻结摘要配方、分段摘要、普通 notes/计划和稳定 memory checkpoint；同绑定成功 usage 校准；Goal/预算/暂停/各种持久触发；原 Bot 自动整理/选文、native 主入口/身份/召回/Plan/Sleep，冻结摘要基线与原自适应准备水位 | 完整压缩算法替换，当前摘要执行仍为固定 ContextJob/SummaryPolicy；现有实际模型配置、协议特定回执、长期睡眠恢复及产品组合的外部验收。图像生成按用户本轮指令暂缓；不另设建议/评估新产品、材料重排产品或其他用途本地包 | 每次实际外发按用途、原凭据、来源和 Goal 受理；未知 usage 不变成零；不重放潜在收费请求；原记忆 revision 和祖先压缩边界保持 |
| 扩设 §4–9：完整能力组合与作者接口 | Provider/Transform/Decision/Observer 已有真实切片；ToolGraph、直接 child、Deliver/Pause、运行中策略换绑；SDK tools.invoke；原冻结tools.list/describe与普通runtime_contract、同源service/method/event/UI slot/props/准备状态及精确不可变包源码有限查询；Agent产包/原授权候选/实际工作台挂载释放、显式Host/Surface就绪组；有序纯Context Transform、同名来源隔离与未变成员复用；唯一 scoped 选择、冻结依赖 DAG、同图实例共享及实际 Surface lease；本地/managed Source 共用原捕获与产包链，未就绪候选的精确撤回和排空 | 其余当前异构 service 的元数据声明、完整API/更广UI贡献查询；更广领域Provider/Transform和结构化patch冲突合同、更多实际作用域组合验证；trusted-native不能并存实例的热交接仍需沿原owner实现 | 不另养能力名单或第二安装器；失败候选保留旧实例；旧调用保留真实绑定；关闭 UI 不取消后台业务；仅依赖自己的工作等待准备 |
| 总设 §14–16、§21、§24：文件与产品工作流 | 原文件工具/CAS/捕获、child 报告与 WorkingResult、family 消息/读取/Wait、历史引用与分支、Storage 与 Catalog GC 锁外准备；Documents 草稿/BOM/行尾与同源资源闭包、Git 子目录捕获；原输入 checkpoint、Thread 导航和原 journal 组合恢复；受确认草稿恢复及原磁盘/未保存内容撤销，Storage 事件租约等待 | Rust/Host 多物理来源组合恢复及跨平台文件行为的实际验收；未知草稿状态的可确认冲突；现有 IDE/Research/Bot、Documents/Git/overview/通知的组合消费核对。Git index 恢复不是聊天回退的隐含能力 | 草稿不是聊天回滚副作用；重开保留真实副本与效果；报告和代码集成各有事实；各视图不能有第二份状态权威 |
| 总设 §19–20、§22：环境、Computer 与 MCP | Computer 原本地/远端操作、assignment/精确 stop、source-less child request/Wait/handback、持久 async 脚本；MCP tools/content/Tasks/resource observers/有限交互和两次审阅 sampling；typed media 的存储与跨层消费；managed Source 文件/进程/检索/语言、原 PTY 视图、Experiment 输入、文件跟进与服务转发；Computer open/put/browser/office/evidence/environment 工具消费者 | managed Source 持久脚本和项目 MCP 普通 tools/resource-read/prompts 已接；项目 MCP Tasks 已接原创建回执、跨 Run holder 与 A 原 HostJob 清理确认；持续 observer、有限反向交互与 mixed-owner child 仍待，新建日历工作的显式资源 owner 和跨 Host 组合文件恢复仍待；已有消费者的组合证据按实际受影响风险补充。平台组件及实际产品组合。Wayland 仍需正式 RemoteDesktop/ScreenCast 会话组件；macOS 实机与稳定 bundle/ScreenCaptureKit 继续闭合 | 同物理桌面共享占用、独立桌面并行；失联不证明停止；旧 epoch 不续发；MCP 可选音频/toolChoice 等明确有限支持不自动扩成整份协议实现任务；实际配置与权限流程不能被省略 |
| 总设 §7–9、§23、§27–28，扩设 §10–12：全局组合与发行实证 | 跨 Run 原子资源/FIFO、FileSearch 任务族公平、事件背压、正文/回执 ContentStore、锁外捕获/GC、分层产品投影已各有真实纵切；同 ModelStep 共享不可变请求、provider 正文借用与事件文件租约 | 稳定前缀编译/序列化和非 Git 增量目录账本；原始控制隔离的组合负载；Web/Electron/Mobile/无 UI Host 的完整后端寿命、安装升级/数据保留；代表性冷/热/并发/更新成本 | 只跑源码或受控 stdio 不称产品 IPC/真机/真账号通过；不预设性能倍数或任意门槛；未用扩展不增加热路径扫描；旧世代按实际引用释放；验证中发现的产品缺陷仍需修复 |

### 实现与验证的边界

- 现有 Goal、follow-up、时区日历、Job/文件/日志/指标触发、family 协作、Web/PDF/材料分享/科研作业/学术发现不是剩余从零实现项；仍须保持真实消费者及取消恢复的组合证据。
- Worker 已有隔离可写 child、WorkingResult、逐项集成与报告；Documents 草稿与历史/journal 恢复已分别接入。剩余组合与外部验收仍须具体到真实消费者，不能将“完整产品交付待验”误记为这些原语尚未实现。
- 当前已适配的模型家族不能由早期 provider README 中的局部清单推断为缺失。具体字段、认证/网络、服务器续接和多模态能力逐项以实际配置与可执行 adapter 为准；真实账号/平台验证仍单列。
- 既有平台组件不等于真实平台已验；反过来，缺真实机证据也不等于该平台完全没有实现。完整产品验证可能发现接线问题，不能提前把全部余项称为“只剩测试”。
- 完整能力交付后提供用户验收方法、明确支持边界及迁移前清单；不擅自切默认 runtime、删除 Pi 或做全面资产迁移。

### 当前领域纵切：三类本地来源的语言与检索已接通，继续补编辑器与环境范围

- `SourceMode` 现有 `FixedBranch`、`Materialized`、`LiveRoot`；显式 live_root 不捕获目录，受理、续接和恢复保持同一已验证 host/workspace/root。固定来源仍固定，物化环境仍保留实际副本，不随当前 UI/cwd 改绑。
- live_root、fixed_branch 与 materialized 已通过原生注册表执行 `language_definition`、`language_references`、`language_diagnostics`、hover、工程/文档 symbols 和单查询 call hierarchy。Rust 拥有工具准入与结果提交，Host 直接使用现有 LanguageViewBinder/LanguageSupervisor 和选定 provider；没有第二个语言进程/config owner、Pi 身份冒充或 decide 内隐藏 I/O。
- 当前 live 路径核对同一 Host 和实际 Documents 环境；同 workspace/provider/view 的准备复用，实际 query 绑定 generation/documentVersion。输入前后 revision 核对，返回目标逐项授权；目标的 observedRevision 不证明语言服务器计算跨文件 range 时使用了该版本。
- fixed_branch 的捕获树、相对 imports/配置与路径映射由原 Storage 准备派生工程；materialized 使用原真实 working copy。返回正文始终取原来源；目录外 SDK、显式外部配置与 symlink 属于明确标识的 provider environment，不称为完整 OS 快照。真实固定与物化 child 已执行语言工具、原报告/历史、停止与 GC 重开；Worker 代码发布保持单独验收。
- 三类来源已接实际检索 PipelinePlan 与显式语义 owner；继续补其余查询、草稿、远端同名路径和跨层产品范围。无版本诊断可保留真实非空观测，但仍是 pending，不能称为 current/clean。

## 已核验增量：策略辅助规划模型

- 所选已安装 AgentPolicy 可声明 `agentPlanning` 需求并提交 `request_model_job`。Host 从现有模型槽、连接配置和凭据 owner 准备能力，状态区分未配置、禁用、非法、不可用及可用；无隐式主模型回退，不在 `decide()` 内调用模型。
- 同一真实 Run 内创建独立 `PolicyModelJobV1` Operation，使用 `RequestOrigin::PolicyModelJob`，保留自己的不可变请求、原始输出/opaque、usage 和 dispatch 知识；不是伪造的 ModelStep、摘要 Run 或工具交换。主模型与规划模型分别绑定连接/账号作用域和凭据引用，真实 I/O 由既有 Run worker/模型适配器执行，不占 Catalog/control 锁。
- 图和模型行动共用决策边界与最新行动恢复选择。未派发请求只有在原绑定/快照匹配时才可继续；已有派发意图但缺完成证据时保留 interrupted/indeterminate，不自动重发潜在付费请求或假定零 usage。只在完成项、usage 及终态边界持久化已观察输出，未提交 token 增量可能因崩溃丢失。
- 规划为明确的 tool-free text 能力；若 provider 返回工具调用，原始数据保留但不执行、结果不可用。策略只可分块读取自己 Run/action 的结果，主模型收到带来源标签的不可信模型派生证据，opaque 不伪装成普通文本。
- 可安装 `examples/extensions/planning-policy` 实现上下文读取 → 规划模型 → 严格解析有界读取计划 → 可信只读图 → 主模型证据回答。读取数量、计划字节等是示例的显式配置；此例不代表一般有副作用图、子任务、任意多模型策略或完整 AgentPolicy 已完成。
- 当前 Catalog schema 仍为 3，content format 改为 3，用于带类型来源的请求；旧 content 2 与未知格式在恢复/owner 写入前拒绝并保留资产，不新增转换器或迁移框架。
- 独立反例审阅后在最终冻结构建复验的修复：持久派发后 provider 失败保留 observed usage 并结算 Indeterminate、不重放；终态取消仍保留实际 Prepared dispatch 知识，result/receipt 一致；恢复不覆盖已结算的 Dispatched 本地失败；tool-free adapter 保留带未受理标记的原始越权工具调用，由 Operation owner 判为不可用且不执行。旧二进制曾在真实 Host 路径复现 offending originals 的 items=[]；这条失败复现不计为修复通过。
- 最终 Rust 检查通过：完整 library 79/79、规划模型 13/13；另有既有读取图 16、credential broker 5、model configuration 5、Anthropic subscription 1 项通过。provider library 聚焦 28 项亦通过（属于 library 覆盖，不重复累计），包含辅助请求原始非法工具调用保留和主模型未知 schema 仍拒绝。
- 冻结内核 SHA-256 `4ee07cac8a5fd24a8f7676990f819bad5d61e6fe49074f93f007c51b77b8e68b`：同一二进制的真实 broker/Host/kernel 检查 48/48，通过规划模型 26、既有策略 10、读取图 12。规划 26 项包含 4 项实际打包示例经正常安装/路由的调用：两种真实计划内容分别选择不同文件、非法 JSON 拒绝和路径穿越拒绝。另有 portable credential-owner 23 项通过。读取图一处旧文案前缀断言改为核对当前更明确的来源标签；这属于过时断言修正，不记为产品行为缺陷。
- 协议生成 `--check` 与空白检查通过；Host/UI 类型检查通过，包含全部 26 项规划 fixture 的最终 Host 测试类型复查亦通过（exit 0）。只使用 fake provider/假凭据，不含真实模型质量、账号、收费、性能或跨平台证据。既有超大 MCP 误启动 caveat 保留在后文；不把它计入当前验收，也未补跑超大测试。

## 完整设计结构增量：扩展准备并行

- 公共 ApplicationExtensionRuntime 和 broker supervisor 的长生命周期队列已按 owner/依赖拆开，独立扩展的准备、释放和事件激活可以并行；共享依赖及同 builtin 准备合并
- 选择发布仍保留短的版本核对；独占 provider 使用候选 reservation，失败回滚仅还原所属 owner 的路由。删除数据和同 ID 重装按该 owner 顺序处理
- 独立反例发现并修复：等待 catalog CAS 时 shutdown 后仍发布旧世代；删除数据后的陈旧 reconcile 撤销刚重装的实例
- 9 项独立并发回归、类型检查及局部 lint 通过。完整 extension-host 首轮 60/61，剩余 artifact npm 缓存环境失败在可写缓存下单独重验通过（artifact 15/15）。这不是对组合四类合同、所有热更新/平台路径已经完成的声明

## 能力清单与现有复用入口

### 早期底层验证（历史证据）

- 跨 Run 的资源准入复用 Catalog 所属协调器，原子申请完整资源集合；冲突请求按队列推进，无关资源可继续。真实多 Engine 反例验证排队取消不派发、独立工作推进、后台 Job 保留占用及重启恢复。发现并修复了同步执行器已死但锁残留、以及执行端已停止却因业务效果未知而保留锁的问题。9 项新增回归、79 项 runtime 单测、8 项 kernel 单测和 26 项文件资源审计通过；Windows/macOS 路径行为未在本 Linux 环境验证。
- 原生 file_list/file_search 已移除 10 ms 轮询，复用 compute 作业的输出/终态通知；生产者背压也改为事件等待。取消注册可移除，完成前先确认 cursor 释放 buffer credit。独立核验包括 1,000 个完成/取消交错、10,000 次正常等待无注册积累、真实超过 1 MiB 结果排空、截断清理及背压中撤权；新构建原生消费者 22/22、资源准入 9/9 和额外撤权反例通过。
- 个性化上下文按已有 catalog 的 revision 刷新，已发模型请求保持原快照，下个请求读取新笔记/配置；固定源 AGENTS 不随工作区漂移。实际 HTTP 验证编辑、删除、重置、摘要冲突和重启重试；重启后对象键顺序改变导致同 revision 哈希不同的问题，已改为规范化键序，未放松 CAS。
- 原生权限走独立 Operation/Wait，实际 HTTP 验证单次许可、拒绝、重复调用、身份/策略漂移、取消和重启。普通用户问题不是权限批准。MCP 共享 Host owner、Pi/原生生产接线、懒发现、冻结 schema、凭据世代与无 UI 释放已通过聚焦核验：真实 MCP 4/4、权限 HTTP 3/3 与 Rust 2/2、凭据刷新/重绑 2/2、控制器/代理/单次项目信任 16/16。超过现有 16 MiB 限制时只结算对应连接/输出失败，不杀共享 kernel，不把未收到的回执说成确定效果；完整长输出保存、MCP Tasks、脚本与多模态映射仍未完成。
- Host 精确世代的预绑定服务句柄及只准备选定 provider 的路径已交付到 `26778086`。独立反例发现并修复了旧 pin 阻塞停用、异步释放期间权限仍可用、强制终止后 reconcile 恢复权限、释放异常遗留 worker 等问题；42 项聚焦测试、类型和空白检查通过。Rust 组合与可替换上下文的生产连接通过 5 项真实原生/broker 测试和 1 项 Rust 绑定测试，包含实际示例安装、项目路由、失败保留旧 checkpoint、旧请求不变及重复读取复用。四类扩展参与合同、策略行动范围及整体成本证据仍未完整实现，不能用这一条纵切代替。

本轮 Host/Pi-host 类型、协议生成一致性与文档链接检查通过。已安装的 SDK 补丁实际参与上述测试；cloud lock 按官方 staging 的 production manifests 核对后完成 frozen install。该轮尚缺生成的 Web CLI/UI 产物，未验完整发行布局；后续 Linux 正式运行包证据见专节，仍不据此声明所有平台通过。

下表按当前已发布增量更新；具体证据以上方各阶段记录为准。“现有入口”是复用来源，不表示其中代码都应保留，亦不把既有实现误记为新原生合同已完成。完整 Host/平台验收与用户负责的最终迁移另列，不混入源码能力状态。

| 能力 | 当前入口/权威 | 目标交付 | 原生实现状态 |
| --- | --- | --- | --- |
| 会话、分支、运行中输入 | `packages/pi-host/src/session-host.ts`、`packages/runtime-broker` | ConversationStore + RunCoordinator；队列编辑、steering、停止、重连、历史回读 | 局部实现：持久队列、编辑/取消、边界输入/中断/nextRun；显式原生界面、固定 head 分页与对话分支已接入；默认路由迁移与完整恢复未完成 |
| 模型、认证、推理用途 | Pi SDK、Host `connections`/`pi-config`/`small-model` | 各实际配置 transport、OAuth/云身份、模型覆盖、reasoning/opaque、多模态、usage；chat与embedding/rerank等各自合同 | native query/index 的 HTTP 与已有 Bekko 执行器、TypeSafe/Cloudflare/llama.cpp decision 复用原配置、凭据、dispatch 与 usage；dedicated rerank、渐进 fast-decision 与 Explore LLM 已接原检索消费者。Bekko 真实权重/安装与完整认证/平台验证另待；本轮图像生成已由用户暂缓 |
| 上下文、记忆checkpoint、压缩 | Pi harness/session history、Host `memory` | 原文保留；来源角色；冻结快照；祖先范围压缩；交付去重；即时记忆写入与稳定system快照 | 原生 checkpoint、自动容量水位、分段摘要 Run 与可替换预算 Decision 已接；完整自动记忆产品流程仍待。容量的无法精确部分应诚实标记估算，不据此默认新增模型反馈学习或自动收费重试 |
| 文件、草稿、恢复 | Rust `storage`；Host `documents`/`recovery`；UI Document Registry | 复用内容对象/条件写入/恢复；明确草稿owner；分支与磁盘效果区分；组合恢复可核对 | 原生文件工具、固定/可写来源、结果保留与逐项集成已有闭环；完整草稿与历史/磁盘组合恢复的产品接线仍需完成 |
| 工作分支、基线与dispatch | Host `harness/thread-services.ts`、`thread-runtime.ts`、`kernel/storage-adapter.ts` | 持久受理立即回执；准备独立作业；批量capture；真实一致性标记；无变更报告与代码集成分开 | 固定与可写 child 持久受理、原来源准备、递归取消、报告/WorkingResult 与逐项集成已接；更广捕获与恢复产品组合仍待 |
| Shell、PTY、输出、进程树 | Rust `process` guardian；Host `kernel/process-service.ts`/`terminal` | 保留真实进程回执；推送I/O与stdin确认；控制独立；取消观察不同于终止进程 | 原生 spawn/持久观察/停止、PTY input/resize 回执、原进程终端与恢复已接；平台和产品完整验收仍待 |
| LSP、结构/关键词/语义检索 | Host `lsp`/`search`/`structure`/`knowledge`；Rust `compute` | 按environment/project/config/view共享服务；来源修订明确；独立准备；不等待无关索引 | 三类本地来源的定义/引用/诊断、关键词/结构/显式语义和实际 child 消费已接；固定捕获工程与目录外 provider environment 分开。dedicated rerank、渐进 fast-decision、Explore LLM 与 query embedding 共用原回执。其余 LSP/模型消费者、草稿、远端和完整产品验证仍未完成 |
| 任务协作、消息、wait | Host `harness` registry/services | 单一Thread/Run事实；有来源消息；Wait持久化与游标；结果恰当去重；旧世代不污染新执行 | 真实 family 发现/互读、inform/request/reply、关联 Wait/期限、多观察屏障、child 独立新 Run 已接；完整 Host 与平台验收仍待 |
| 计划、普通记忆、Bot知识 | Host `memory`/`knowledge`；普通Agent notes为Rust typed record | 保留各领域owner、权限和revision；不把所有知识塞入泛化状态库 | 普通 notes、真实自身计划、root/child 两调用来源、CAS 和原回执恢复已接；Bot 知识与完整自动记忆流程仍待 |
| Goal、自动接续、辅助模型 | Host `bots`/`pi-session-automation`/`run` | 显式Goal授权、暂停/预算/用量；等待不覆盖手动暂停；辅助请求独立身份 | 显式 Goal、原用量/预算、暂停、依赖、root/child 自动接续及独立规划模型已接；其他辅助用途与完整产品验收仍待 |
| 问题、follow-up、日历 | Pi extension UI bridge；Host `harness/followups.ts`/`scheduled-tasks` | 问答持久记录；到期非批准；发生项幂等；登记后重查防丢唤醒；时区/遗漏策略 | 问题/回答、一次 At/ProcessStopped、Any/All 与带时区日历发生项已接；原来源文件 exists/changed/ready 已接，其他领域来源继续 |
| Computer Use、人工接管 | Host `computer`、`packages/computer-driver` | 实际桌面控制epoch；观察/动作/效果分开；紧急停止独立；释放按键与资源有证据 | 原 Computer 工具、精确停止、source-less child 请求/Wait/handback 与持久脚本已接；真实桌面平台/远端及完整产品验收仍待 |
| MCP、脚本、用户扩展 | Pi MCP/codemode adapters；`extension-contract`/`extension-host`/`extension-sdk` | 原生MCP；单registry；脚本嵌套调用同权限/回执；完整async单元格；不另造插件管理器 | 原 MCP tools/content/Tasks/resource observers/有限 interaction/sampling、普通扩展 tools/SDK、child/nested、持久 async 脚本与 typed media 已接；managed 脚本现沿原 A Environment/Cell 与 B Storage guardian，原停止/撤权/reopen 已有定点证据；managed MCP 普通 RPC、精确 view 释放与原 Source grant 下的 native stdio 已接；managed Tasks 已接原一次创建/接受恢复/持有清理；持续 observers/反向交互/mixed-owner child 与更广组合仍待 |
| 深层策略、发现与工作台 | 原 ServiceRoutingStore、扩展 registry、Host/Surface和UI shells | CompositionPlan；Provider/Transform/Decision/Observer；AgentPolicy；按需合同查询；无UI后端 | ToolGraph、child、Deliver/Pause、策略换绑、有序 Context Transform、预算 Decision、Observer、合同/源码发现和作者产包已接。Scoped DAG、跨消费者共享准备/实例、真实 Surface lease 与冻结恢复本片闭合；不能共存的 trusted-native 热接管及完整工作台/平台验证仍待 |
| Web/材料/科研/Bot领域工具 | 现有Host领域服务与harness工具 | 通过相同Operations接入；保留材料来源、产物及用户配置行为 | 原 Web/固定材料/PDF 原来源、材料集合/明确分享、学术 metadata 与 research_decide 已接同一 owner，原科研作业/产物/观察已接；其他 decision provider、Bot 等其余领域继续 |
| Web/Electron/Mobile、远端、发行 | `application-client`/`protocol`、各surface、Host环境服务、kernel packaging | 同一后端生命周期；snapshot/cursor投影；环境绑定/fencing；平台驱动与安装升级实际验证 | 未完成 |
| 用户资产与Pi退出 | Pi JSONL/配置/凭据引用/用户扩展源文件 | 一次性导入保留entry ID、分支、工具配对、压缩、opaque及未知项；原文件保留；切换结算在途工作 | 交付迁移前验收入口与清单；用户验收后负责默认切换、Pi 删除及资产全面迁移，当前未执行 |

## 已核验增量：策略主动读取与可恢复结果

- 所选策略现在可在首个 ModelStep 之前提交原生只读依赖图。真实 ToolOrigin 区分模型调用与策略行动，复用可信工具合同、冻结源视图与既有跨 Run 资源准入；不伪造模型请求、工具交换或用户消息。
- 每张图由现有 Catalog 的一个 Run-owned Operation 保存意图和节点回执，策略检查点与图受理原子提交。依赖节点只在前驱成功回执提交后运行；独立节点可并行。恢复保留已完成读取，允许未落回执的纯读按原固定来源重试，不宣称物理读取 exactly-once。
- 策略通过现有 Decision 合同读取自己 Run/action/node 的结果分块，并以拥有的证据引用请求模型。最终 provider 正文带实际来源和不可信外部数据标签，保留 ExternalData 语义；不是把原始结果伪装成模型工具历史。
- 可安装的 evidence-policy v2 先读取固定来源中的小型索引，再根据实际索引内容选择第二个文件，最后引用证据回答。索引的 16 KiB 预算属于该示例的显式配置，不是运行时对所有策略的限制；正文不自动塞入每次 Decision。
- 独立反例审阅促成的修复包括：资源排队后再次核对授权；保留图完成后的新策略检查点；先注册取消接收再读取持久取消；结果保存与回执引用在同一 Catalog 排他区内发布，防止 GC 删除未发布对象；模型请求中可见外部数据来源标签；输入先到而图受理失败时不提前推进私有状态。
- 该已核验读取图阶段的 Catalog/content 格式为 3/2；当前规划模型增量改为 3/3（见前节）。当时删除旧内部表示的自动转换分支，未知或旧格式拒绝并保留已有文件。没有新增迁移框架、第二份图状态库或模型配置权威。
- 最终稳定源码的独立 Rust 检查 107 项通过（78 library、16 graph、9 resource admission、4 context）；真实 broker/Host/内核检查 22 项通过（12 新图、10 既有策略），覆盖安装选择、实际内容决定后续读取、原文/交换保持、作用域伪造、崩溃恢复、取消与新输入受理竞争。最终冻结 debug 内核 buildIdentity 0.9.24，SHA-256 `3716589f55cfb0de488f0cc58d87473a11d67e9319dd5b1675dec28a1fb18c22`；测试前后哈希一致。Host、contract、SDK、示例类型检查及示例构建通过。
- 另有 11 项小型适配器回归通过（MCP 直调/发现 2、permission 3、questions 6），使用输入受理原子性最后修复前的冻结内核 `3bfd171806bf76df88fdc64fdbe1850445e1dea59beb01a71cd25e5ea5e23863`；该最后修复不改这些适配器。一次误启动后中止的未过滤 MCP 整组命令不计入验收：至少一个大载荷用例已启动但停在未批准、未派发阶段，另一旧用例是否执行无法确证；没有据此补记大载荷通过结果。
- 仍有明确边界：当前图只接可信的固定来源只读 Result 能力，MCP 注解不构成只读授权；该阶段未含辅助规划模型，当前实现与验收范围见前节；子任务和有副作用图仍未实现。图结果写入仍占用现有 Catalog 排他区，超大输出的关键区成本未优化。策略帧使用既有编码器预检，但本轮不把超大帧端到端行为计为通过。

## 已核验增量：不可变 Run 作用域与有界签名元数据

- Observer 依据 Run 受理时固定的 context checkpoint 选择 project，包括排队等待的 NextRun；历史无项目 Run 不因以后发布上下文而被重新归属。checkpoint 的 project 元数据随原不可变正文原子发布，只用于查询，不是第二份项目配置权威。
- 同一 Thread 的不同 branch/Run 可以分别选择项目 A、项目 B 或无项目 Observer；订阅、准备与消费独立。内核同时校验读取和 ACK 的精确 project/thread 范围，并保留 source reader 的 throughCursor 上界。
- context domain 格式更新为 2；旧格式明确拒绝并保留已有数据库和内容，不猜测旧 Run 的归属，不添加内部迁移或静默重建。项目身份在受理处拒绝空白及边界 BOM 等非规范拼写，避免 Host 归一化后改变授权范围。
- 独立真实 broker/内核测试 31/31 通过，含历史无项目、两个项目、排队受理、错误 scope/ACK、慢项目独立推进、重开去重、旧资产保留，以及实际 Host 的 BOM/NEL 边界反例。最终测试使用正式 Linux x64 release 内核，buildIdentity 0.9.24，SHA-256 `b5946c5ebe3210af91074382c7f6fa09c31d37d110685269e7c063f65b39b467`；Host 测试类型检查通过。
- Bedrock 私有签名请求仅传 method、endpoint 与由实际请求序列化器计算的 payloadSha256，不再把完整模型正文塞入认证控制帧。Host 使用该散列进行 SigV4 签名并覆盖配置中的同名散列 header；签名元数据入共享写队列前使用同一 framing encoder 预检，失败沿原调用返回并释放等待者。
- 签名独立检查 36 项通过：2 项真实 loopback HTTP 签名字节对照、23 项 Host owner/bridge、4 项 AWS/provider auth、7 项凭据权威检查。均使用假凭据；Unicode、转义正文与独立从实际 HTTP 正文计算的签名一致。超大正文端到端执行未运行，本结论不包含超大认证帧故障时的实际恢复，也不证明真实云账号接入。

## 已核验增量：Linux 正式运行包

- 使用受支持的 Web Host、CLI 和 UI 生产构建，以及正式 optimized release 内核完成真实 cloud runtime staging；冻结安装 665 个生产包，staged lock 与 canonical lock 逐字节一致。没有用 debug 内核替代发行产物。
- 修复 workspace 依赖检查把合法子路径导入误判为未声明包的问题：按包根检查已声明依赖，错误仍报告原完整导入；12 项 layout/helper 检查通过，实际编译 Host 扫描无未声明项。
- 发行内核 manifest smoke 验证无关 cwd、不可变分支、文件应用、搜索、Tree-sitter、shell exit 7、integrity 与错误 manifest 拒绝；复制包中的内置 LSP smoke、CLI help、Pi/扩展解析、PDF.js 和原生 Canvas 检查通过。
- 隔离 HOME/data/agent 的实际 packaged HTTP 启动通过：health 为 ok，apiOnly 为 false，bundled Pi 1.0.4 与 Rust kernel 均 ready，首页和实际 main JS 返回 200，随后正常关闭。默认仍是现有 Pi 产品路径；此证据验证同包中原生内核和完整 UI 可交付，不表示已完成原生默认切换。
- 此处是 Linux x64 源码构建、冻结安装与本地发行布局证据；未构建 Docker 镜像，未发布，也不替代 Windows/macOS 或真实模型账号验收。

## 已核验增量：各一条真实 Decision / Observer 消费路径

这两条受限但实际运行的消费路径已接通，不代表任意工具图、子任务、多模型或完整领域覆盖已经完成。

- **Decision：有界研究/证据收集策略。** 沿现有 Host service 路由选定 `varin.agent.policy@1`，经既有 broker worker 在 `execution.rs::AgentPolicy` 的命名边界计算决定；先按整个 Run 固定策略实例与版本，不声称可热迁移不兼容私有状态。策略只选择继续推理、执行已受理工具交换或结束；原有 `PolicyCheckpoint` / `catalog_recovery.rs` 保持私有状态身份核对，核心 history、provider opaque 项、ModelStep 配对及工具受理仍由现有 owner 控制。跨进程决定调用必须带取消上下文，慢/失联策略只能阻塞本 Run，不能让取消、别的 Run 或 Catalog 事务等待第三方回调。非法决定先按核心规则结算已登记交换；策略不能给自己扩权或重放未知效果。
- **Observer：Run 完成/活动视图扩展。** 复用 `catalog_observe.rs` 的非阻塞通知、`Catalog::events_after` 已提交事实游标及 `Catalog::set_delivery` 的 selected → sent → committed 记录；独立 Host 消费者把所选事实交给 broker，确认精确事实身份后推进交付状态。无需再造事实库或逐 token 持久队列。恢复按 at-least-once 表达，扩展按稳定订阅身份与事实游标去重；后续业务动作必须作为有自身来源、幂等键和授权的新命令受理，不能伪装为原工具成功路径或声称外部效果 exactly-once。观察者慢、崩溃或停用不得延迟生产者提交/工具回执。

独立验收：Decision 10/10 真实 broker/原生测试通过，包括实际 model→tool→model 配对、取消/重开、包内容/配置身份、新旧 generation 与重复启动。Observer 16/16 通过，包括实际投影视图、精确 ACK、重启去重、慢消费者、仅握手重开、scope 查询交错和已处理 throughCursor 上界。共享扩展生命周期 47/47 串行回归通过；并行首轮的旧 1 秒 watchdog 曾因争用超时，单独与串行复跑均通过，未放宽该阈值。

修复包括准备中取消泄漏 pin、旧 Run 拖住新 generation、未合作回调/释放器阻塞停机、初始读取失败后观察不恢复、微任务漏唤醒及跨 project scope 预读。Broker 清理宽限默认 5000 ms、可配置，只在进入释放后计时；强制终止须有实际退出证据，并保留 cleanup_unconfirmed 诊断，不宣称外部效果回滚。

仍有限制：策略先按整个 Run 固定，未实现不兼容私有状态的热迁移；一般工具图和子任务尚未接到策略合同；只读图已有后续验收，辅助规划模型已有本文件单列的局部独立验收。外部副作用执行中崩溃的全部组合与跨平台发行尚未由本轮证明。多项目 Observer 的原临时限制已由前述不可变 Run 作用域增量解除。

## 不可省略的实现决定

这些决定需落实在所属模块的类型、事务或执行协议中，不以额外通用框架代替。

1. **数据资产边界**：新ConversationStore是用户资产，不能沿用可替换kernel internal catalog的重建删除规则。未知格式保留并报错；用户原Pi文件不动
2. **请求/效果边界**：实际发起provider请求、受理tool call、准备副作用、发送效果、结算结果分别记录到足以恢复的边界；网络中断不能从头重放整个Run
3. **分支与配置世代**：branch CAS、冻结provider/schema/config绑定、正常退役与明确撤权分别处理；旧在途工作可按原身份完成，失效执行不能迟到写新Run
4. **事务与内容提交**：对象先持久化再提交引用；关联状态/outbox同事务；数据库锁不包住网络、捕获、用户等待；普通可信读取不写每个阶段
5. **真实资源与授权**：计划完整写集合后准入并再次核对revision；环境read/Shell/LSP一致；配置可见性不是权限；MCP annotations不是授权
6. **输出与停止**：明确日志存储不可写/耗尽时的背压及完整性；不无限缓存或静默丢数据。当前kernel reader取消快路径不得倒退；取消请求不等于已停止
7. **监督与恢复**：窗口关闭与核心退出分开；guardian/远端句柄重接须有真实证据；未知副作用保持indeterminate；紧急输入停止不能依赖Catalog可写
8. **候选组合**：先准备后发布；失败保留旧组合；真正独占资源在静止点交接；不以“热更新”名义启动第二个写入权威

## 验证先从纵切行为取得证据

复用既有行为测试，只为真实新增失败面补充场景；不构建另一套测试元数据平台，不预设毫秒目标、工具次数或无依据硬限制。

首个持久纵切需要证明：

- 同键同输入返回同身份；同键不同输入冲突；重开后仍成立
- branch前置head冲突不覆盖新历史；原文和provider opaque项可往返保存，UI投影不承担原文存储
- 副作用已dispatched但未结算的重开结果保持未知/indeterminate，不自动重发；请求取消不能伪造effect不存在
- 状态与待投递事件一致提交；游标补投不重执行业务；已提交结果未送达可重取
- fake provider可证明请求接线/工具配对，但不证明真实provider完整覆盖、性能或模型质量

接线阶段需要证明：

- 大目录首次捕获、卡住LSP、大输出流同时存在时，受理/普通读取/控制仍独立推进
- 并行工具乱序完成时，UI各自刷新，provider交换合法；用户中断不会执行残缺参数或把旧tool call放进新Run
- 草稿/磁盘/固定分支和跨环境同名路径不混淆；基线来源明确，不将stable capture说成OS原子快照
- 候选扩展失败保留旧组合；旧schema调用可按原绑定收尾；明确禁用立即阻止新的副作用；慢Observer不延迟回执
- Wait登记与事件同时发生、重启、时钟变化、重复回答不会丢唤醒或重复准入
- UI断线不结束后台工作；重连snapshot/cursor一致；Pi历史导入不丢opaque/未知扩展项，不双写或重放外部动作

最终验收还包括设计中的完整provider/API家族、Computer Use真实平台、远端与发行包。静态检查、单crate测试和模拟执行都不能代替这些证据。

## 独立检查与当前缺口

基础提交为 `11ebbe14`，显式模型/资源工具接线提交为 `625f7a7a`；均未切换既有 Pi 产品路由。下面是实际执行证据，不以局部通过替代完整交付。

- 2026-10-09 07:42（Asia/Singapore），`cargo test --manifest-path kernel/Cargo.toml -p varin-runtime` 完整通过：79项unit、5项组合解析、5项凭据broker、5项模型配置，共94项；生成协议`--check`和`git diff --check`通过
- `src/catalog_tests.rs`：受理幂等、branch/epoch、opaque重开、跨Run回执隔离、未闭合交换不能终结；ExternalReceipt早到/晚到、重复/冲突、unknown细化和Wait唤醒均有实际回归
- `src/execution_tests.rs`：真实SQLite两轮模型/工具提交并重开；残缺参数不执行；Catalog锁占用时控制仍可取消；快工具不等独立慢工具；只取消资源队列中的一项不停止整Run；输入到达最终提交/序列化窗口不丢失、不发送旧快照；取消未启动Run释放分支
- Context实际原生loop：摘要以ExternalData进入请求、system/instruction/memory快照冻结、尾部opaque原样；原历史在GC/重开后仍保留。尚不等同完整产品压缩/记忆流程迁移
- Bedrock binary eventstream三项增量：逐字节frame、reasoning签名/工具/尾部usage回放、CRC/截断错误、前置取消，以及真实localhost binary HTTP→adapter通过；当时仅假 Bearer；后续 SigV4 假凭据/真实 loopback 字节验证见前节，仍未验证 AWS 真实账号
- 缓存完成输出恢复：真实SQLite重开后，不重发已完成模型请求；已结算工具不重做，其余调用维持合法配对；已dispatch且缺回执的effect保持待核实。恢复工具批次的Runnable→Executing真实失败已修复并通过；本轮相关源码hash在测试前后相同
- 已通过失败后修复的交错回归：输入head改变拒绝旧输出后，worker退出不再遗留Generating；持久Waiting/恢复Wait、原始拒绝输出及usage仍可查，重开不污染新历史
- `src/providers/tests.rs`：逐字节SSE、opaque与签名保留、矛盾重复项拒绝、截断/乱序；真实loopback TCP/HTTP→适配器、错误headers及headers/body停滞取消通过；共享transport只建一次client/runtime、并发请求/取消/headers隔离通过。Chat工具分片/finish后usage/DONE边界及Azure显式query/version/deployment/credential header与opaque家族fixture通过。Google/Vertex签名和可选工具ID配对、Mistral思考分片/ID碰撞配对、Codex instructions与绑定account/session headers通过；同家族不同connection identity不转发opaque。这不是各云端真实认证或全API家族验证
- `src/content_tests.rs`及Catalog回归：大请求原文/opaque重开、追加历史块复用、各相位不回写整请求、GC保留live对象、缺失/损坏阻止sweep、孤儿staging清理、当时的转换事务中途失败完整回滚、格式 marker 冲突拒绝通过。缺对象时public dispatch先写Dispatched的真实反例已修复并复验；当时另通过格式 v2→v3 升级不嵌套已有 request 引用、多领域 GC 根、拒绝输出及队列编辑/交付 GC 后重开；旧内部格式转换后来已删除，这些历史记录不代表当前支持升级。当前 Catalog/content 为 3/3，旧格式保留并拒绝；不代表模拟真实断电或所有文件系统
- `tests/composition_resolution.rs`：不相关依赖不成屏障，optional不吞实现失败，真实环路/歧义、陈旧准备/作用域变化、集合顺序通过；尚未接上完整生产扩展装配
- context-fragments 独立纵切验收：`packages/web/application-host/lib/kernel/context-composition-review.native.test.ts` 5 项真实 broker/原生模型请求通过；内置默认、项目实例、失败保留 checkpoint、同记忆 revision 更新及无关路由不重复 describe。`kernel/crates/varin-runtime/tests/context_composition_review.rs` 1 项证明连续 5 次复用同 binding ID、替换产生新 ID、旧 pins 在移除后可完成纯变换、data 保留 ExternalData。Host tests TypeScript 0 diagnostics；Decision/Observer 的后续独立证据见上节。
- LaunchSelection在materialization前select持久化，准备途中重开仍可列出并重新绑定（06:18增量2项通过）；同计划绑定幂等，connection/config/schema/source变化拒绝；重开需Host重绑，重绑不允许重发未决ModelStep。当前保存非敏感选择，不保存可复用grant/credential；实际Host恢复编排仍须接线
- `tests/credential_broker.rs`：注入事务store的同reference刷新单飞、不同reference独立、取消等待不丢已轮转token、scope不匹配/持久化失败不给headers；`bind_with_credentials`真实localhost请求不回退环境凭据通过。全部是假凭据；Host既有credential owner接线已有独立TS/真实worker验证，真实OAuth账号仍未验收
- `tests/model_session_configuration.rs`：未知provider不回退、默认不匿名、凭据仅在dispatch解析、不进入request body、无工具绑定不产生工具授权通过
- 真实文件journal恢复（07:32，kernel SHA256 `2b2d66ee293be7aae3918a6818afc419ccd41fbe192a177dd508d4acbcdd4e22`）：SQLite trigger让Storage已落盘后的native工具收据事务失败，随后SIGKILL重开/rebind，读取真实journal补唯一tool result并续接。文件mtime不变、模型write请求不重发；发现并修复Run寿命外部回执误拒、execution recovery Wait名称不一致两项实际缺陷
- 真实Pi worker凭据owner验收（07:09）：生产PiHostClient启动Pi main，创建session、列provider、logout经私有CredentialStoreServer；parent临时owner假凭据删除成功，worker独立agent目录的auth.json不改，公开provider结果不含key；runtime-broker tsc通过。没有真实secret或网络OAuth调用
- 独立TS IPC回归已验证真实kernel原生启动/完成/取消、固定branch文件读取、实际OS子进程与Storage终态；新guardian输出/control分离、磁盘spool、实际终态/取消、两lane credits在进程及IPC独立审阅的冻结构建验收通过；仍不代表完整跨平台发布

近期已由实际失败促成修复的边界还包括：附件静默丢失、续接claim崩溃丢唤醒、扩展cancel发送失败提前drain、早到进程receipt未在handoff应用/未唤醒Wait、丢acceptance后真实完成证据未结算。

仍不能宣称完成：

- 进程层在Linux本次真实OS验收通过；其他目标平台、非合作/异常断电与全部恢复组合仍需各自证据。不能把本次Linux结果推广到Windows/macOS全部行为
- 共享取消桥已统一native token通知，外部wire分lane credits与Host独立窗口对齐；相关进程/IPC并发回归已在冻结构建通过，后续协议变化仍须复验
- RequestSnapshot、history正文/provider originals、model_outputs及队列交付正文已持久化为不可变manifest/chunks，ModelStep相位写入保留短引用；追加历史可复用内容块，读取保留完整原文。当前仍全量序列化/读取请求，未实现完整内存工作集优化；跨 Run 基础原子/FIFO 资源准入已验证，更完整的调度优先级、能力准备和成本证据仍需补齐
- 完整恢复驱动（已完成模型结果/部分工具回执的原生续接已通过，Host完整恢复编排仍未完成）、输入队列的产品接线、自动压缩与完整记忆流程、全部 provider/OAuth 实际部署、MCP Tasks/持久脚本及扩展领域覆盖、其余 LSP/检索与固定依赖闭包/捕获迁移、UI投影、Pi用户资产导入、跨平台发布和最终Pi退出仍须按能力矩阵交付

## 已核验增量：显式 live-root 来源与精确重绑

本纵切新增显式 `live_root`，沿已有 Documents 登记和 Rust file-resource/process owner 访问实际保存文件；
不执行目录捕获，也不改变默认固定快照或既有 Pi 路由。`fixed_branch`、`materialized` 与 `live_root`
分别表达固定读取、独立工作副本和直接修改现场。Run launch 保存真实 host/root 身份，恢复只能重新授权同一来源，
不能把同名目录、当前侧栏选择或物化失败替换成原来源。最初 AGENTS.md 从 Documents 读取并以实际 revision 固定在已有 context checkpoint。

旧实验性原生 launch domain 1 的布尔编码由 domain 2 显式来源模式替代；catalog/content 仍为 3/3。
已有库先以只读 SQLite 检查 domain/表结构及已提交 WAL，再允许可写打开、epoch 变更或恢复。
旧格式、缺失或损坏结构保留原资产并拒绝，不提供静默推断、内部迁移或双读合同。

该 live-source 历史阶段尚未包含原生 LSP；后续三个 live_root 语言工具已按下节接通。它们复用现有
LanguageSupervisor/LanguageViewBinder，且每个返回位置仍经资源授权。外部 symlink、tsconfig 依赖和
编译器库可能来自现场，不能宣称全工程固定；cwd 不是 OS sandbox。

独立验收：Rust 91 项通过（79 个既有 unit、10 个新增来源/格式检查、2 个来源继承检查）；
Host 21 项在同一修正后的真实内核构建通过（10 个新增 live-source、6 个固定来源/继承/context、5 个 process/CAS）；
UI 16 项通过。内核二进制 SHA-256 为 `ef9c0c1d75d465ddd9d9f012a07c12f763f1b5cdcee4951d293654f1b7bb56b6`。
生产 Host、UI 与最终 Host tests 类型检查、共享协议/client 构建、协议生成一致性及 diff 空白检查通过。
模型侧使用本地 fixture；没有真实付费模型调用。本轮运行证据为 Linux，不代表完整跨平台或原生默认路由验收。
来源身份固定 Host 登记的规范路径与 Rust root ID，不固定目录 inode 或承诺整个工程的原子快照；
当前公共来源准备/提交接口没有通用的受理前 AbortSignal 保证，取消验证针对实际 Run 准备链。

本轮真实反例促成的修复包括：缺少 runs 外键的同列 launch 表曾被接受；旧 domain 拒绝过程中可写 SQLite
连接关闭会 checkpoint 已提交 WAL，现改为真正只读预检，保持数据库/WAL 资产；持久 `live_root` 缺字段曾隐式成为 null，
现与协议一致要求显式 null/描述符；即使提供有效 rootId，Rust 也拒绝以 `fixed_branch` 启动进程；
live read 曾误标 materialized，现 read/list/search 统一从已验证绑定输出真实 mode/rootId/liveRoot。
读取不同文件状态、实时文件变化、冻结 AGENTS revision、后续 Run、重启/排队重绑、伪造来源拒绝与准备取消后的 grant 撤销均有本轮独立行为证据。


## 已核验增量：live-root 原生语言工具

`language_definition`、`language_references`、`language_diagnostics` 已进入原生工具选择、
执行及历史提交路径，并由现有 source entry 选入 live_root。工具参数使用相对资源路径、零基 UTF-16 位置。
Rust 通过私有 epoch/查询身份桥接调用既有 Host 语言 owner；Documents 负责文本与编码，LanguageViewBinder
绑定实际 revision，LanguageSupervisor 继续拥有选定 provider、共享准备、会话世代和 Rust 管理的进程。
没有新语言配置库、第二个语言进程管理者、伪造 ModelStep 或在策略 decide 内执行扩展 I/O。

语言准备与请求不占 Catalog/control 长锁或文件租约；取消针对一个等待者，共享准备仍由原 supervisor 按引用处理。
输入在请求后再次核对，返回资源由同一 Run grant 逐项准入并观察实际字节、校验 UTF-16 范围。
越权/unmappable、不可读和范围过期有不同遗漏计数；所有项目被遗漏不冒充正常零结果。
跨文件 `observedRevision` 是请求后读取所得，`rangeRevision: null` 明确没有证明服务器使用的目标版本；
查询自己的 range 只有在绑定及后验 revision 一致时才带该 revision。来源明确报告依赖仍为 live。

诊断保留 pending、stale、unsupported、unavailable 和已验证结果的区别。当前 bundled TypeScript server
没有 pull 能力且发布不带文档版本；同一 LanguageSessionRecord 保留其真实非空错误观测，结果为 pending +
`diagnosticVerification: unversioned`，仍经 Rust 授权和范围检查，`rangeRevision` 始终为 null。
空无版本观测不等于 clean，有遗漏也不把 pending 提升为已验证 partial。原 Pi/editor 的返回形状保持不变。

私有 Host 语言回复先做序列化/既有 framing 预算预检，过大或不可序列化时返回有限 unavailable 回执；
Rust 对超过实际帧预算的 transient progress 不入共享 writer，durable 工具原文继续通过既有分块历史读取。
本轮没有实现语言结果分块，也没有执行超大端到端或共享 writer kill 实验。

最终内核 SHA-256 为 `4432bb14292e36e0fb2ae093e6d66567ba41ed2a6da7e90d49e7177ae180f2a9`，
以正式 build identity `0.9.24` 构建。先前遗漏构建身份的二进制被握手拒绝，未进入产品行为验收；
最终计数均使用修正后的冻结构建，不把该环境阻断记为产品行为失败。

最终独立验收按 suite 分别记录，不是全仓或全部设计通过：

- Rust rendezvous/framing 5 项：epoch、独立取消、迟到回复、关闭及小型真实字节预算边界。
- 同一最终内核上的 native 假 owner 20 项、source entry 1 项、真实 bundled TypeScript 三工具闭环 1 项；
  后者验证真实跨文件定义/引用及 pending 的真实 TS 错误观测，没有补造诊断版本。
- portable owner 12 项、private bridge 3 项、既有 Pi navigation 15 项、diagnostics adapter 4 项。
- UI 18 项；完整 Host tests/UI 类型检查、生产 Host 声明与 application-client 构建、协议生成检查和 diff 检查通过。

最终检查修复或澄清了缺失/伪造 source provenance、非 ready 内容旁路、omissions 额外字段、非法 providerId 类型、
丢失 result/非法 URI/逆向范围冒充零结果、输入变化和 symlink 目标处置。已授权 symlink 叶子按现有文件 owner
保留为 Symlink 且不跟随，因此为 unavailable；父路径越界和未授权目标属于 outOfScope。
既有诊断 fixture 的延迟 watcher 失效竞态先在原基线复现，再按真实失效/重新绑定语义修正验证，没有削弱 ready 断言。

该增量限于 live_root 三工具，不证明 fixed_branch/materialized 的 imports、配置、链接和编译器库闭包；
不完成其他 LSP、结构/语义检索、远端、任务族公平、完整恢复、领域迁移、代表性成本或跨平台发布。
两份完整设计的其余矩阵仍适用，默认运行时与 Pi 退出状态未变。本轮模型侧只有本地 fixture，没有真实付费模型调用。

## 已验收增量：live-root 可组合代码检索

`code_retrieval` 接入真实原生工具/历史路径，复用 Explore 算法、Documents、既有 Structure 和 Rust compute。
私有查询显式携带原生 Run/Thread/来源及真实 grant，不伪造 Pi session/worker。关键词 compute 使用 Run scope；
候选路径在 Documents 读取及可选模型选材之前经同一 grant 的 `file.read.check`，返回后 Rust 再逐项验证来源、
真实 revision 和行范围并从已核对字节重建正文。固定/物化来源明确拒绝，不暗用 live 索引。

查询捕获不可变 `PipelinePlan` 和选定 stage 方法句柄；配置候选准备成功后才发布，新查询可使用新世代，旧查询仍按
原绑定完成。共享语法准备继续归原 owner，取消单个等待者不关闭公共准备。冷缺、不支持、部分覆盖、失效和失败
分别保留；结构大单元使用原 slicer 保留范围的连续片段，不补回省略区再截掉命中。

生产通过既有扩展 service routing 选择 `varin.retrieval.plan@1`，内置 keyword+structure 与 keyword-only
两个惰性声明均可在既有服务配置中选取。查询使用真实 native Thread、Run受理checkpoint项目及已授权canonical目录，
不读取后来侧栏选择；结果记录选定provider/artifact/configuration及路由revision，正常退休和明确撤权分开处理。
该冻结版本的生产内置 semantic/model 明确 disabled。后续语义增量见下节。可组合 seam 支持显式既有语义 handle 与仅针对已授权
片段的模型选材；语义块 SHA-256 与文件 Documents revision 分别验证。尚未接生产语义/模型设置、扩展 worker 的
完整恢复、固定依赖闭包、远端或最终产品默认路由。没有运行真实付费模型。本增量不等同两份完整设计交付。

本轮并发真实反例还暴露原有全局history ID缺陷：不同Run的provider都返回 `item-1` 时，第二个Run曾因
`history.id`唯一约束进入execution-recovery等待，不能误报为检索阶段锁竞争。修复将内部history身份按
真实request/ModelStep与provider item ID确定性分域，原provider ID/opaque/model_outputs原样保留；精确重复
ModelFinished为只读幂等，差异回执冲突。恢复统一读取冻结leaf后精确连续的真实已提交模型行，核对归属/内容/
原文/工具序列后使用实际row ID，不按新公式猜历史head，不重写既有资产或增加格式迁移。独立同ID并发、
后续step、旧已提交ID及恢复继续追加反例均在修复后重新验收；初轮失败不算通过。

最终内核以正式 build identity `0.9.24` 构建，SHA-256 为
`d04874a6c88c42c32704db2afc3c92609554bf9a16a47a74e661fc1d08b4c630`。独立验证按范围分别记录：

- 同一最终内核上的新增 native authority / pipeline / composition 三套共 21 项通过，覆盖真实关键词→结构→
  原生历史→read、逐项权限/撤权、陈旧命中、冷缺阶段、共享准备取消、慢查询并行及实际扩展候选发布/失败保留。
- 既有 native 消费者共 7 项通过：live-source/read-edit 与 language 并行 2 项、HTTP context/
  initial-context 冻结及 reopen/retry/fork 3 项、durable assistant history 1 项、12 回合 pinned-history 分页 1 项。
- portable pipeline 3 项、实际 UI selector 加 Host 路由 2 项通过。
- Rust catalog 31 项（包含独立身份/旧行恢复/错误归属 4 项）、execution 12 项通过；
  此前 v2 的未再修改 content 7 项已通过，不把这些重复算作新增测试。
- protocol/client、扩展 contract/SDK/builtins 和 Host 生产类型构建、完整 Host tests/UI 类型检查、
  协议生成检查、相关 lint、文档和 diff 检查通过。

实际扩展候选 fixture 曾等待候选切换完成却仍持有待退休旧 pin，形成测试自身等待；修正为既有发布/退休
合同的顺序：先观察新代发布、验证旧 pin 可续用，再释放旧 pin 并等待退休。没有延长 timeout 或修改产品以绕过该验证。
以上不是全仓、完整恢复矩阵、真实付费模型或跨平台发布验收。


## 当前增量：真实 published reader 与原生语义推理

本节记录在前一检索增量之后的实现及下列冻结源码/二进制的独立验收；这一受限增量不等于两份完整设计交付。默认仍为 keyword+structure；新增显式 keyword+structure+semantic 声明，首轮限
live_root、明确登记索引目录、已配置远端 embedding 与 source ranking。模型 rerank、固定/物化来源、远端
环境、真实认证/收费、语料检索质量及跨平台性能不在本轮已证范围。

### 单一 owner 与冻结身份

- 原 `workspace-runtime` / `runtime` / semantic storage process 继续唯一维护源索引。没有第二个扫描器、
  配置库、模型下载器或用原生 Thread 冒充 Pi session；native 路径直接使用原 Host 配置/凭据 owner。
- 现有 Trivium mutable `g1` 不是 snapshot。原 storage owner 在既有 quiet/busy/完成 checkpoint 边界用
  `publishGenerationManifest` 形成完整文件集，真复制后以 `immutable` 打开，再发布 reader 指针。
  `.pld.N` 等动态成员来自 native manifest；不 hardlink、不逐 query 全库复制，也不逐 document 强制全库快照。
  publication ID、store epoch、recipe/space、冻结 coverage 与 Documents revision/chunk hash 分开保存。
- 查询只 retain 已经准备好的 published reader；冷查询不打开 writer、不等待全库 scan、不用付费 readiness probe。
  未知维度由明确登记的背景构建首个真实文档 chunk 学得，向量缓存供随后正式 publication 复用。
- 正常新 backend/publication 不改变旧请求的固定绑定；明确禁用、账户/凭据作用域变化、目录移除、grant撤销、
  store/Host epoch变化阻止后续外发和交付。每条命中再经原 Run grant、Documents revision、行范围和chunk hash校验。
  reader release、maintenance 和 shutdown 由原owner收尾，未关闭成功的存储句柄不被当成已清理。

### 付费外发事实与恢复

普通 RetrievalQuery 仍是 read-only Result，不为廉价 keyword 查询创建持久 Operation；之前不能据此声称
所有检索均已有 Rust Operation。选择 semantic 后，实际 embedding 外发先经原 semantic process 的专用
执行事实账本，位于原 Varin dataDir 的 `knowledge/<host>/semantic-inference/ledger.tdb`，独立于可清理的
derived vector cache。该账本仅拥有这类实际外发/回执，不重复写 Run/ModelStep 状态，也不伪造 ModelStep。

Native 来源带真实已提交 model request+tool call，或 policy action+node+tool call。幂等键使用此持久来源
与固定推理 stage；临时 bridge/batch UUID、input hash、模型或 credential epoch 不能更换该键。input和binding
作为不可变 intent 核对，差异明确拒绝。Index-build 使用原 workspace/recipe/vector-binding/输入内容身份，
未决输入的重分批/换顺序也不得重派；确实不同的源码输入或模型世代另有事实，旧 unknown 不消失。

full-sync admission 必须在外发之前得到持久确认；没有 ledger 或确认失败时不发送。已派发但没有可观察
回执保持 indeterminate，attempt 是否确知另存，不把未知 usage 写成零。完整结果先持久结算再交付，重开后
按同一 intent 与当前授权复用；不同 credential scope 的同一完成请求保守拒绝。Warm vector cache 也先核对
账本 intent/unknown，缓存响应按真实零外发结算。原 owner 提供按 Run/scope/state 的只读事实查询，不自动
清除 unknown，不因索引目录清理抹掉可能收费的事实。只对index-build且原transport链已最终结束、
持久receipt证明not-started/attemptsKnown=true/attempts=0的请求，允许同intent重新受理；原零派发事实归档，
新token与admission lineage在同一个full-sync事务发布。单纯尚未更新计数、仍在beforeDispatch等待、
任何unknown/started或原生取消调用都不满足条件。此合同不声称 exactly-once HTTP。

取消及时停止等待者，不无限等待不响应 signal 的 Host callback。它不声称远端已停止；真实 transport 的
晚到回执可以结算原账本成本，但不能恢复取消结果交付。正常原生历史保存可获得的 plan/reader/推理回执，
取消历史可能先返回而没有晚到回执，持久账本仍保留该原 invocation 的独立执行事实。

### 旧入口与验证边界

OpenAI-compatible embedding 纯 transport 移到中立 Node-only 模块，Pi adapter 与 native owner 共用。
新 native query 和背景源索引不调用 Pi worker；旧 Pi semanticRecall / knowledge-vector 仍沿其真实 broker
身份和结算边界，复用同一源索引及共享 transport。它们尚未迁移到原生 invocation，不能假造身份来抹掉这一
边界，也不会与 native owner 同时推进同一个 query。Rerank/decision 等旧能力保持原入口。

实施作者只做构建、类型、格式和静态核对；独立 reviewer 使用真实 storage/IPC、Documents/Structure、
Host credential/settings、Composition 与原生历史，唯一模拟外部对象为本机 deterministic HTTP provider。
最终 Linux x64 内核以正式 build identity `0.9.24` 构建，SHA-256 为
`ada4437138ca313dd928208b9a7c7fd21ca65c21a77656fd59095e8a11bd7ce6`。2026-10-09 独立验收结果：

- 同一最终 v3 内核：新增 native semantic 13/13、既有 retrieval 21/21、legacy 消费者 31/31，
  六文件共 65/65 通过。覆盖真实配置/凭据 owner、实际 Composition 选择、索引 query 到原生历史、
  冷查询零外发、A 查询保留旧 reader 而 B 发布、失败配置候选、禁用/目录移除/账户变化/Run 撤权、
  revision/chunk hash 分别核对、取消及真实 reader/backend/transport 引用归零。
- 最终 portable 五文件 35/35 通过：published reader 8、持久 ledger 9、既有 store 10、
  workspace inference 3、embed scheduler 5 项。
  ledger 反例包括稳定 invocation 的 intent 冲突、unknown 阻止重派、完成复用保留原回执、
  index 输入重分批 fence、独立子进程未 close 的 WAL 重开，以及 beforeDispatch 尚未最终结束时
  拒绝恢复、真正零外发最终结算后并发恢复只发送一次并保留旧 lineage。
- 一个真实并发容量为 1 的测试单独证明：embedding HTTP 阻塞时原生 file read、状态及取消仍可完成。
  A/B 切代 fixture 使用原有 scheduler 的显式 concurrency=3，证明已受理旧 lease 与新 publication
  可并存。初版 fixture 用默认单槽却阻塞 A 再等待 B，两个测试曾失败；修正测试容量后重跑并在最终
  v3 全套通过。未修改生产默认容量，初轮失败没有记作通过。
- 另以纯 Node 导入实际 compiled package exports，验证中立 transport 与旧 Pi adapter 为同一实现，
  并经真实 `BackgroundInferenceRuntime.embed` 调用本机 HTTP provider 通过；未使用 TS/source alias 掩盖包布局。
- 正式构建、Host 生产及测试类型检查、协议生成、文档检查（185 文件、1556 链接、0 错误）和 diff
  检查通过。targeted lint 命令返回非零：唯一诊断为 `index.ts` 既有
  `refreshThreadPersonalization` 的 `prefer-const`，已在 HEAD 核实；其余所查变更文件没有诊断，
  不将此次 lint 写为全部通过。最终验收前后 48 项冻结生产/文档 SHA 全部一致；随后仅补本文验收记录。

这些结果不包含全仓测试、全部恢复矩阵、真实付费供应商、跨平台构建或大语料性能/质量验收。
原 Pi broker 入口的完整持久结算迁移、模型 rerank、固定/远端来源及完整两份设计的其他里程碑仍另行推进。

## 2026-10-09 普通 notes 原生闭环（独立 B 线首出口）

实现沿既有 `agent.personalization` typed record 唯一 writer。`memory` 的 read/search
保持只读；save/delete 在执行前持久化真实 Run/request/call 对应的 intent，以相同 origin 查询原
`storage.record.put` 的原子 receipt。丢回执的核对不会再次修改 notes，UI 与工具写入共用 CAS。
已有合法 `memories/prompts/nextId` 文档继续读取；新增可省略的 latest-revision/last-mutation 元数据，
不迁移、不重置。历史 receipt 复用原 operation 事实，不在每次文档中复制 receipt 列表。

可信受理 scope 显式包含 mode/threadRole/projectId，sessionId 必须为本 Thread。通用 preparer
不默认为 main，主入口薄适配显式受理 main。Bot 普通 notes 隔离；child 初始上下文使用自己的 scope
与固定来源，工具能力由显式 profile 单独授权。实际 Host UI resolver 查持久 Thread/checkpoint，
错误不回退为 Pi main；原生会话入口复用既有 notes 编辑器、CRUD 和 stale revision 提示。

普通 note 编辑不改变系统 memory snapshot。独立 `ContextPreparation` 在普通模型和 policy model job
冻结新请求前同步同源 facts；已冻结/派发请求不重编。每个 RequestSnapshot 保存完整尾部正文和稳定
fact identity，selected/sent/committed 分开记录，跨请求保留到成功压缩覆盖。工具 JSON 仅在匹配
真实 native-memory Operation、origin、调用和原 receipt 时去重，不信任外部同名 JSON。

显式压缩成功才原子发布 summary、memory snapshot 与 effective system；新 note/原会话尾部保留，
失败、取消、profile CAS 或分支变化保留旧资产。删除最后一条 note 可清空对应新 snapshot。
Context domain 3 在可写 SQLite/WAL/epoch 前只读预检；旧、缺失、畸形内部格式不静默重建。

独立审查先后发现并修复了三个真实边界缺陷：`operation.get` 将真正不存在的 operation 与无归属实体
混为授权错误、阻断首次写入；context 预检误接受部分 UNIQUE 索引；ContextPreparation 的取消错误
裸传播导致 Run 进入 waiting。现在 missing 可读 null，foreign/orphan 拒绝，授权与读取在唯一 Storage
worker 同步完成；本域 TEXT PK/UNIQUE 核非 partial、准确 key、BINARY/ASC 与 FK 动作，坏资产只读拒绝。
ASC 是格式合同，不表示 DESC 削弱 uniqueness。取消走正常 Cancelled 结算；其他准备失败同事务写
Failed 与安全的 `context.preparation_failed` 原因，原始 Host 错误不进入公开事件，未受理的新模型
请求/ModelJob 不被伪造成已执行。晚回执再核 token/Run/epoch，不能恢复 Run 或替换 checkpoint。

2026-10-09 最终 v3 独立 Linux x64 验收使用 debug profile、正式 build identity `0.9.24`，内核 SHA-256：
`0ecabc887c4674b0317feabf6f675c4b1f4d2295d62778534417a603cddc5ddb`。

- 原生七文件 **92/92**：memory delivery 16、owner/schema 7、planning 31、retrieval 5、observers 31、
  initial-context 1、live-personalization 1。使用真实 Kernel IPC、Catalog、Host owner、HTTP 路由和模型请求；
  仅外部模型为 loopback deterministic provider。原始回执丢失后重开不重写、精确 CAS、工具读写 effect、
  compaction/profile/尾部竞态、Bot 与可信 child scope、fork/GC/原请求保全、三阶段 delivery 均覆盖。
- Host context callback 人为挂起未释放期间，status 与取消到 Cancelled 的实测样本为 **5.32 ms**，
  严格断言小于 1000 ms，零模型派发；晚回执不复活，新 Run 可继续。普通/planning 的 reject/throw
  四项证明安全失败原因与 Failed 在关闭重开后仍存在，checkpoint 不变且未伪造模型 operation。
- 本域 partial UNIQUE、复合 NOCASE、DESC 和 PK NOCASE 四类不兼容 schema 在任何 epoch 推进前拒绝；
  DB bytes、epoch 与原 history 保持，合法新库正常重开。storage missing/foreign/orphan 与并发同 ID
  所有权反例均通过。
- Rust **19/19**：memory delivery 3、context job 4、execution 12。UI **5/5**：复用真实 notes 编辑器与
  routes、可信 project/currentThread、stale draft CAS、删除、切身份清 draft、Bot 隐藏。
- 生产/测试/UI TypeScript、协议生成检查、生产 Host bundle、依赖隔离与文档检查通过。
  变更生产文件全量 targeted lint 仍有唯一原 HEAD 的 `refreshThreadPersonalization` prefer-const；
  本次新增诊断已修，不写为全 lint 通过。新增/相关无旧诊断的测试文件 lint 通过；
  observer 测试原有 6 条 no-explicit-any、planning 原有 1 条 prefer-const 单独保留，
  最终静态组合命令因这些既有 lint 返回非零，不能写成整个组合命令通过。

v3 build、native 和 Rust 验收绑定同一完整源码 manifest
`b216a594197d0cc8067418b1337f2814e6cc852268ae124683d920b4e11a2176`；最后仅补本文验收记录。
构建及运行命令、source 前后身份、独立 binary 和生成目录 hash 由本批 evidence receipts 保存。
初轮失败未记作通过：除上述生产缺陷外，review fixture 的不合法 recordType、read-graph node/call ID
不一致、将内部 context job 走普通 Run HTTP 入口、手造无效 basis、旧 1 秒 polling 均已独立纠正；
原行为断言保留，polling 改读真实 durable events，未扩大原用例 deadline。

本节不包括全仓测试、完整 MCP 套件、极端并发或性能基准、真实付费供应商和跨平台发布。
自动 budget 压缩、完整 context 设计、全部恢复矩阵、A/B 最终综合验收和 Pi 退出仍另行交付。
## 2026-10-09 并行增量：固定来源只读子任务（分支范围验证，待全局集成）

A worktree 新增原生 `dispatch`、状态与 durable Wait/报告路径，沿已有 Catalog、RunSupervisor、
WorkingState pin/branch 与 source launch 接线，不调用 Pi ThreadRegistry。受理固定真实父 Run/origin、
项目快照、显式 parent model/read_only profile；异步准备调用同一 context owner，子 Thread 不继承父
session notes。只读子任务的正常文本报告与 `no_changes` 代码结果分别保留。取消观察、取消子任务、
父 Run 结束和停止整任务使用各自边界。源授权 pin→Catalog 受理窗口保留原 Operation 归属及恢复清理事实。

本轮报告只持久引用原 child history；状态/list 不复制正文。`child_report` 与认证 HTTP
读取采用 UTF-8 字节页、显式 next_offset 与 64 KiB 输出上限；Wait 含有界的最新文本预览，明确
标记 other-agent data、可能不完整及续读方法。UI 按需替换页，不自动聚合无限正文。

独立 reviewer 在 v3 验证真实 Host/Rust/loopback 20 项和 Catalog 11 项全部通过；真实
Storage pin 返回与 Catalog 受理之间的两个精确撤权边界、P0 受影响既有消费者 62 项在 v2 通过。
v3 相对 v2 的唯一业务源码改动是 collaboration schema 只读预检，未重写工具/受理/Wait 接线。
覆盖固定来源与工具子集、独立 session/project、父终态与 child 寿命分离、迟到准备取消与 pin 清理、
来源信任撤销、模型请求已发后的 crash 不重派、报告丢通知重开、先报告后 Wait、取消观察再 Wait、
fork 前后可见报告去重、100 KB Unicode 报告续页及越权拒绝。缺 unique/FK 或旧报告格式的 Catalog
只读拒绝，测试核对原数据库 bytes 未变。补充反例曾揭示 v2 接受 partial UNIQUE、NOCASE
child/PK 索引及 cascade FK；v3 核对完整非 partial 的精确 BINARY key、PK origin、FK actions/match，
四个真实重开反例全部重验通过。精确 pin→Catalog 窗口用真实 Storage/wrapper 受控断点，
不是在该窗口实际杀进程；对应 orphan 恢复/补偿另有低层与 Host 反例，不扩大这条证据的含义。

作者完成 0.9.24 Cargo check/build、协议生成一致性、protocol/client 构建、Host 生产类型与本树
bundle、UI 类型检查。专属 v3 二进制 SHA256 为
`680ec58a4b731adb5d4ec52cae229622016c41c701885409a996c00b0dfab169`，构建生产输入前后稳定；
分支独立审查汇总保留源码/测试 manifest、命令及失败修订证据。Host 生产/UI 最终类型与新增
20 项的测试类型检查通过；新测试两处可选 API 非空断言修订后，16 项及测试类型重新验证通过。
新增 TS 测试 targeted ESLint 零诊断；Rust 测试有一个 unused import warning 按冻结裁定保留，
不宣称全仓 lint 清零。首轮窄路径源 grant 越权受理反例
曾失败，补 whole-root/read capability 校验后在 v2 重验通过；初版重开 fixture 用正常 close 导致
真实取消，改为该 fixture 独占进程 crash 后验证，未把初轮失败计入通过。

本轮未运行全仓测试、完整恢复矩阵、完整 native MCP authority review、视觉 UI 验收、跨平台构建、
超大帧/共享 writer kill 或付费模型。代码仍待根与独立 memory/context 线集成，子 profile 本轮精确
file-only；集成时仅接共同 context 边界同步，不隐式添加 memory/MCP/dispatch 能力。首轮不包括
递归/任意兄弟协作、写入/代码合并、live 首次隔离捕获、远端环境或完整协作域交付。

## 2026-10-09 固定来源协作与 memory/context 综合验收

本次将上述两个独立增量合并验证；不是仅复用分支各自的通过结果。保留 context v3 与
collaboration v1 两域只读预检、真实 memory owner、精确来源继承与 file-only child 边界。
无来源 Run 的 builtin 精确为 ask_user、child_status、wait_child、child_report、memory，
不含 dispatch、来源工具或 MCP。child 仍经过 context 同步，但不获得 memory mutation 能力。

- 综合真实 Host/Kernel/loopback Responses 与 Anthropic 共 **33/33**：冻结请求字节不被
  新 notes/child report 改写；后续显式 Wait 交付保留实际 sender/owner 与非 system 身份；
  伪造授权不能扩张工具。丢失 memory owner 回复后重开通过原收据协调，不重写 notes，
  不重放父模型请求，独立受理 child 正常恢复。阻塞 child context 时父读与取消仍可完成。
- context/collaboration 九个跨域不兼容格式反例在修改 DB bytes、epoch、history 前拒绝。
  当前 child report 交付需要显式 wait_child，不声称通用自动消息注入已实现。
- 直接消费者 **89 个不同用例**由保留的 **82+7 两批**建立通过证据；涵盖实际 TypeScript LSP、
  retrieval、semantic generation/ledger、来源与 history、memory owner/delivery。
  早先 retrieval disable 曾在原十秒轮询内未完成；不改其超时与行为断言，单例及整文件重跑通过。
  首次超时原因未确认，不据此声称没有性能回退。
- Rust **32/32**：child 11、memory delivery 3、context jobs 4、execution 12、真实
  Storage→Catalog 来源受理边界 2。UI memory 行为 **5/5**。这些为综合源码上的实际执行。
- Host tests/UI 类型、四个改动 TS 测试 targeted lint、diff/schema 检查通过。生产 Host bundle
  串行构建及编译产物 ESM import smoke 通过；后者不是完整打包服务启动验收。
  Rust 的 10 条 warning 与该综合 binary 构建已有诊断逐项相同，不称零 warning 或全仓 lint 通过。

综合 debug binary 使用正式 identity `0.9.24`，SHA256：
`a2cb0a239def0a3724bacfa037cc7c96fa4188fd3482544ca5985dac7d78ac60`。
最终测试源码摘要 `3565f62d748e74222141439e9f76b0464e1285e51a6d1be007e48755860dbab0`；
与实际 binary 构建输入逐文件比较，仅三个测试文件不同，生产实现与协议输入无变化。
最终收据确认源码、专属 binary、14 个实际依赖产物目录前后稳定；验收后只追加本节文档。
早期测试设置错误、setup 轮询超时与并行编译退出 137 均保留，未算成通过；重型编译改为串行。

本节仍不覆盖全仓/完整 MCP 套件、跨平台、付费供应商、极端负载、完整恢复矩阵或全部设计完成。
家族公平调度位于后续独立增量，不包含在本次综合交付中。

## 2026-10-09 家族公平准入首切与综合取消修复

原生已绑定 FileSearch 采用可信 Catalog 父子谱系推导的 task family，与原有资源冲突计划一起
原子取得 local-compute 容量。排队时不占文件资源，冲突 FIFO 保留，可运行家族轮转；默认预算
与实际 foreground compute workers 使用同一进程启动配置。plain read/control/memory 不消耗
该容量。精确 admission inspect 从真实 Run generation、ModelStep/tool 或 policy action/node
反查，区分 queued/active/settled/not_active、未知、过期与越权，不伪造 durable Operation。

与已交付 A+B 综合时，MemoryTools 对非自身工具透传 execution_class/watch_admission，自身
memory read 不注册文件 grant watcher。综合独立验收 **Host 5 个不同用例、Rust 13 个用例**通过：
Host 在真实 memory/context owner 主链验证 capacity 1/3、真实微型搜索和精确身份；Rust 由原
family 8、真实 Supervisor 取消竞态 2、真实 kernel wrapper/Storage 准入 3 构成。
确定性持有同 Catalog 的一个 permit，证明真实 wrapper 下搜索等待、取消在释放 permit 前完成、
释放后真实 Storage 撤权拒绝派发，以及 memory read/Prepare 仍可继续。没有用大扫描制造阻塞。

综合审查真实复现了两个新取消竞态：watch 注册期间真实 Supervisor.cancel 已发生，首次
family 查询通过裸错误传播，把 Run 留在 Waiting/execution-recovery。修复只在未派发阶段的
watch/family/acquire 返回后重读真实取消 token；明确取消走既有取消结算，无取消的基础设施
错误保留原恢复语义。模型和 policy 两个反例由旧版 0/2 变为通过，断言终态、真实回执、零派发、
无排队容量和 guard 残留；未改 context preparation 或 memory delivery 的已有事务。

最终 Host tests 类型、变更测试 lint、协议与 diff 检查通过，client/protocol 和 Host bundle
构建通过。早先 Host 默认 1 秒轮询失败、测试 identity 缺判别字段的类型失败与两个生产取消
红测均保留；仅修测试 identity 后重跑受影响 Host 2 例，不重复计数。无全仓 lint/零 warning 声明。
最终源码摘要 `d9cd7ad416a088c7023f152f829d7af3f305b3e49f88f82950e1823fc94a8963`，
相对实际 v2 binary 构建仅一个 TS 测试 identity 字段变化，生产与 Rust 输入不变；验收后只加本节。
0.9.24 debug binary SHA256：
`0a7a2ea31105dcc50b627bf1f8c58835164779d08ae799e80f7eb5695e966f47`。

边界：kernel 测试观察透传/卸载所用 watcher 为测试提供；真实 Kernel grant 撤销在 permit
仍被持有时立即唤醒排队调用，尚未端到端实证。真实 Storage 撤权后拒派发、真实 Supervisor
取消已分别实证。此首切不覆盖所有 compute 消费者、OS 线程创建失败注入、完整重启矩阵、
统一有界 worker 执行器、优先级老化、性能比较或完整设计交付；下一进程持久等待增量独立推进。

## 2026-10-09 原生进程持久等待与公平主线综合

新增 `wait_process`，从已有同 Run 的 process_spawn Operation 观察真实 executor
终态回执，复用 Catalog Wait/原模型工具交换/Host continuation，不以模型反复 inspect 作为
等待实现，不新建第二进程表。观察取消不等于停止进程，Run 取消不在迟到终态后自动续接；
输出仍由原进程 owner 保留，只交付有界且带来源的生命周期事实与读输出引用。

合法同 Run rebind 后，通过真实 Catalog 原 Operation 与当前合法 source 绑定，只允许精确
原进程的 inspect/read。Storage 每次核原/当前 grant、真实 Run/Thread/source 与物理根；不
复活旧授权、不新建持久 observer grant、不扩 kill/stdin/write/跨 Run 权限。原或当前 grant
显式撤销均拒绝。现有运行中部署 trust/root 变化没有即时撤 grant 监听，该边界仍明确保留。

独立分支已验证 Runtime 7、真实 Host 5、原 source-picker consumer 1，修复恢复伪终态、
观察取消事务窗口和 signal 字符串丢失。与公平主线合并后，在实际
Native→Questions→Collaboration→ProcessWait→Memory（可选 MCP 最外）链上补齐双 hook 透传。
综合 **Host 5、Runtime 7、真实 kernel wrapper 3，共 15 项行为**一次通过，窄测试类型、
定点 lint、协议生成及 diff 检查通过，生产 Host bundle 重新构建通过。kernel 三例保留
确定性 held permit、搜索排队、取消与 guard 释放、真实 Storage 撤权拒派发，以及 memory
read/Prepare 可达断言；未用无关全套重跑代替这些实际接缝。

恢复合同分开验证：仅 Host continuation service 重建，原 kernel 与进程仍活，可在同 Run
继续等待并读到原输出；kernel 关闭会按既有生命周期停止进程，重开交付真实 Failed/Killed
及不完整输出，不重 spawn、不伪称成功。已到达终态、重复终态、提交交付后失续接与观察取消
均有持久反例；原始错误 fixture 和失败日志保留。

综合 0.9.24 debug binary SHA256：
`38245890771009ab23e50c9858256ea5fea495c254de47a3a279f20c8aab8128`。
最终 5198 文件源码摘要 `58f96c5f3867a3d08d02475f1ca6522e532cb8a857694857f69b1bcce6af75c1`。
构建期间仅 cfg(test) 模块接线变化，生产输入稳定；最终验收与构建 after 源码相同，运行收据
绑定专属 binary 和 14 个实际依赖输出目录。验收后仅追加本节文档。
这不是跨 kernel 存活保证、全部进程控制/UI、完整恢复矩阵、跨平台或完整两份设计交付。
