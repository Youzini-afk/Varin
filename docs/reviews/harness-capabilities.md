# Harness 能力与证据

Status: current capability map — 当前实现、配置条件与运行证据分别记录。
Last updated: 2026-10-06

源码复核基线：`4b6c604b`。本次没有重跑历史验收、安装包或真实 provider。
[状态](../status.md)给项目概况；本页定位能力 owner 和仍需补充的证据，
[阶段交付日志](../archive/harness-delivery-log.md)保存批次、测量与返工过程。

实现存在、生产接线、默认启用和场景验证是四件事。没有付费模型测评不能反推调用链未接线；
有测试文件也不能证明测试已通过。下面的既有证据只支持当时覆盖的场景。
原逐项测试清单可查[整理前版本](https://github.com/Youzini-afk/Varin/blob/4b6c604b45bc5adb4582638431cd1af84e1c2773/docs/reviews/harness-capabilities.md)，
不把旧版本号、旧工具类别或历史默认值继续当作当前配置。

## 工具、路径与权限

| 能力（原编号） | 当前路径与配置条件 | 证据边界 |
| --- | --- | --- |
| worker→Host、工具元数据（0.3、1.1） | broker 的可信 Actor 经注册表与 Router 解析 authority；不是由请求正文自报身份 | bridge、Router、worker 身份的既有定向证据不等于所有平台安装纵切 |
| bash 与输出（1.3、1.4、3.17） | Host shell supervisor、Rust 进程 authority、OutputRef 和 get_output；保留原文字节、真实退出码与执行身份 | Windows shell/真实进程局部证据已有；macOS/Linux 安装包与完整点击链仍须分别验证 |
| grep、diagnostics、apply_patch（1.5、1.6） | 工具选择与模型/Host 能力控制注册；文件内容沿 Documents/WorkingState 授权路径 | 多文件回滚的完整真实会话、跨平台语言进程与来源失效不能由单项测试外推 |
| 路径与写入协调（1.7、3.2） | 当前任务/资源模型固定每次目标，区分 disk、surface 与 branch；同 Host 受管写入经过其 owner | 租约不隔离任意 shell、Git、外部进程或另一 Host；未知结果不能自动重放 |
| 观察与工具卡（1.8、1.11、3.9） | 输出计数、工具状态、增量游标与实际回执供 UI 消费 | 渲染测试不证明所有浏览器交互；不同观察消费者需要自己的游标身份 |
| 原生权限（3b.1–3b.3） | tool_call 是唯一 Varin 权限门；Smart 需用户选择且配置 permissionJudge；第三方包不因名字或 annotation 获得权限 | 不借主模型替代判断槽位；第三方扩展不能绕过原生确认门 |

实现入口：[Pi Harness](../../packages/pi-host/src/harness/README.md)、
[工具选择](../../packages/pi-host/src/harness/select-tools.ts)、
[Host Harness](../../packages/web/application-host/lib/harness/DOCUMENTATION.md)、
[Documents](../../packages/web/application-host/lib/documents/DOCUMENTATION.md)、
[安全设计](../design/security.md)。
既有 shell、路径、权限与恢复证据见交付日志及 [RR6 剩余验收](../plan/agent-runtime-reliability-plan.md)。

## 设置、提示与上下文

| 能力（原编号） | 当前路径与配置条件 | 证据边界 |
| --- | --- | --- |
| Harness 设置与模型槽位（1.9、2.9） | protocol 定义配置，owner-backed 设置目录与 UI 消费；普通模型槽位、embedding 和 rerank 是不同配置种类 | workspace 不能放宽用户权限或改绑用户 provider；配置生效时机由实际 owner 决定 |
| 系统分段与团队指导（1.2、1.10） | 原生分段装配；实际工具与启用团队改变时更新相应段 | 字节稳定只对同一有效输入成立；不能沿用“注册全部工具后 system 永远不变” |
| Zone 2 与观察材料（2.2、2.3） | Documents、用户终端、Git 与知识材料按来源/修订交付；Agent 自身输出不伪装成人工观察 | 无 shell integration 不造用户命令；Git 在实际刷新后可见；zsh/macOS/Linux 与完整 Host 重启仍缺相应现场证据 |
| todo 与轻记忆（2.5、2.7） | 同一 scope owner 的计划、用户指令和轻记忆；全局/项目/会话的管理沿各自 authority | 存储失败不能退化为空计划；不把轻记忆编辑能力等同 Bot 自动记忆效果 |
| 后台准备、压缩与 history/fresh（2.4A/B、2.6A/B、D-286/287） | 固定范围后台压缩 Agent、候选提交与原文回读；游标在实际压缩后更新 | 水位是配置默认，非实测最优；真实摘要质量、缓存收益和 provider 延迟仍待观察 |
| 下一步建议（2.11） | 独立 nextStep 槽位，用户显式启用后运行 | faux 调用链不证明建议质量或完整桌面流程 |

原 keeper（2.4）及 takeover 压缩（2.6）的产品路径已退役；不因旧计划恢复第二历史库。
现行兼容读取与设置规范以 [HarnessSettings](../../packages/protocol/src/harness-settings.ts)为准。
自动 review 传感器和完成门禁已移除，审阅按普通 Worker/用户配置派发，不再维护旧 review 开关说明。

入口：[上下文设计](../design/harness-context.md)、[压缩设计](../design/context-compaction-agent-design.md)、
[设置设计](../design/agent-settings-design.md)、[轻记忆](../../packages/web/application-host/lib/memory/DOCUMENTATION.md)、
[会话自动化](../../packages/web/application-host/lib/pi-session-automation/DOCUMENTATION.md)。

## 知识、语义与结构检索

| 能力（原编号） | 当前路径与配置条件 | 证据边界 |
| --- | --- | --- |
| 知识存储、recall、Bot 记忆（2.1、2.8、2.10） | TDB 正文与来源由知识服务/私有存储进程管理；已覆盖记忆、来源、处理覆盖与召回，不仅是早期 todo/recall | TriviumDB 版本由[包清单](../../packages/web/package.json)维护；旧 0.8.6 的性能/sidecar 观察是历史证据 |
| 代码语义配置（3.16B） | 有效远程配置优先；本地为显式安装的可配置组件，本基线默认 Bekko a8m | 未安装本地且无远程配置时语义不可用，词法/图继续；远程失败不静默换向量空间 |
| 向量复用与调度（3.16C） | 共享空间/配方身份、chunker、派生索引、缓存和前台优先；本地推理在 worker，采用自适应 CPU 调度 | 不从模型名称或局部测试推断真实语义质量、全量冷扫速度或端到端延迟 |
| 草稿/分支语义（3.16D） | 固定 Documents/WorkingState 来源与修订；未完成向量保留 partial/gap，词法读取继续 | 完整嵌套 dispatch、跨根未保存草稿与安装包启动仍需对应证据 |
| HTTP reranker（3.16E） | 独立配置，在相应检索路径消费；不把聊天或 embedding 接口当 rerank | 真实 provider 质量、费用与延迟未验证 |
| explore、grep、read（3.15、3.2） | 冷目录文本检索、渐进 Explore、固定查询来源、详情句柄与原文续读；模型消费者按配置启用 | faux 与算法测试证明局部行为；120s/8s 等历史预算不是已测 SLO |
| 符号图、related 与 LSP（3.1、3.3、3.8） | 结构采集、定义/引用/调用关系、查询范围及来源语言视图沿现有模块 | 实际语言和 provider 能力分别判断；跨文件版本不能伪称已固定；PageRank/通用多跳及完整桌面冷建不因已有图查询而完成 |

本地默认的直接依据是 [identity.ts](../../packages/web/application-host/lib/knowledge/semantic/identity.ts)
与 `1ff42cb1`；原 MiniLM 测量不能当作当前 Bekko 性能。
知识库语义召回与代码本地组件的启用条件各自独立；不因代码有本地模型就宣称知识召回自动使用它。

入口：[知识模块](../../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)、
[语义模块](../../packages/web/application-host/lib/knowledge/semantic/DOCUMENTATION.md)、
[结构模块](../../packages/web/application-host/lib/structure/DOCUMENTATION.md)、
[LSP](../../packages/web/application-host/lib/lsp/DOCUMENTATION.md)、[检索设计](../design/harness-retrieval.md)。
性能数据只从[性能记录](../performance.md)及[带基线的历史观察](../archive/harness-delivery-log.md)引用；
D-236 的 2520 文件冷建/重扫与 MiniLM 旧样本没有在本次重新测量。

## Web、材料与文档阅读

| 能力（原编号） | 当前路径与配置条件 | 证据边界 |
| --- | --- | --- |
| fetch/search 与原文续读（1b.1–1b.3） | Host 出站策略、固定快照、缓存、域策略和搜索 provider；reader 使用 Pi 的模型/凭据 authority | 免费额度、实际网络可达性与 provider 质量取决于外部环境；真实代理纵切仍列 RR6 |
| Electron 渲染（1b.4） | 桌面适配按 web.render 配置与请求使用同一离屏 helper | 不代表 Web/mobile 有相同能力；本次未跑安装包 |
| 来源、配置代次与插件共存（1b.5–1b.7） | 来源投影由真实材料/会话生成；配置与域限制沿 owner；不按 pi-web-access 包名自动让位 | UI pin/remove 不改变来源正文权威；包存在不授予替代或权限 |
| 学术搜索、共享集合与 PDF（L、D-315–326） | 现有检索线程、材料授权、document_read、原件/解析版本与统一阅读位置；可选 Docling/Tesseract 沿受管进程 | 基础原页、个别论文和 Windows 打包样本证据不证明普遍解析准确率、多语种扫描件或全平台交互 |

入口：[Web/科研检索设计](../design/web-research-search-design.md)、
[出站传输](../../packages/web/application-host/lib/harness/egress.ts)、
[相关决策](../decisions/retrieval.md)。代码接线、可选组件安装、真实 provider 效果分别判断。

## 工作状态、协作与恢复

| 能力（原编号） | 当前路径与配置条件 | 证据边界 |
| --- | --- | --- |
| 任务与普通主线（3.18A–E、3.4/3.5） | Thread/Run、普通 agent-root、研究/Bot attached-root、耐久等待和同任务会话读取已有生产路径 | 真实付费嵌套协作、完整桌面重启和安装包点击流程未由定向证据证明 |
| Worker/retrieval 与团队指导（3.6） | 常规内置类别为 Worker 和 retrieval；普通 dispatch 沿调用者授权配置，预设按有效模型槽位解析 | 未配置预设不能借主模型；不保留 hard-implement/frontend/review/check 的旧内置清单 |
| 检索事实交付（3.6 retrieval） | dispatch、固定来源、submit_facts、settle、wait/read_thread 与授权材料读取已有消费者 | faux 纵切证明接线，不能证明真实检索质量；无模型时不启用对应预设 |
| 按需审阅（3.7） | 普通 Worker/用户配置派发；没有自动 review 门禁 | 一次审阅或可应用性不证明行为兼容 |
| 分支、物化与选定代码提交（3.4a、3.5a、D-339） | Rust WorkingState/Integration 保留固定来源、修订、CAS、结果回执与资源所有权；Documents 管编辑器缓冲 | CoW、Git filter/LFS、跨根草稿、混合写入域、来源失效与结果不明场景按实测分别记录 |
| 任务 UI（3.10） | 共享任务/会话来源投影与提交回执 | 完整归档、回收、恢复和草稿交互需要真实界面证据 |
| 原生恢复（0.2/R1–R3） | 路径级 coverage、journal、checkpoint、redo 和脏状态 barrier 已有实现 | 脏缓冲仍拒绝恢复；同步失败报 dirty-state-unavailable；可确认脏缓冲/降级恢复与 retention/storage management/workspace lease 尚未完成 |

入口：[协作设计及验证](../design/agent-collaboration-design.md)、
[Host 线程服务](../../packages/web/application-host/lib/harness/thread-services.ts)、
[预设目录](../../packages/protocol/src/harness-presets.ts)、
[Rust 内核](../../kernel/README.md)、[恢复设计](../design/native-workspace-recovery-design.md)。
D-339 的既有行为与真实 Rust CAS/重启回执只覆盖其对应场景，不抹去上述其他证据缺口。

## Bot、电脑、环境与研究

- BC0–BC9 的阶段事实、平台实现缺口和未测环境由 [BC 验收](bot-computer-use.md)维护
- EE1–EE6 的环境绑定、资源与应用桥及剩余合同由 [EE 验收](execution-environments.md)维护
- D-300 的完整研究资源管理合同仍未全部交付；本地/受管远程已有切片，Slurm 延后，见[科研设计](../design/research-cluster-design.md)
- O0–O4 办公连续性仍为未实施方向，不以现有应用桥代替完整工作流程

## 可选测量与未验证事项

T4 回放记录器是 [harness-replay.mjs](../../scripts/harness-replay.mjs)及其记录/配对格式。
历史记录没有真实模型配对结果，自动执行配置仍有未闭合项；只在确实安排配对时处理，
不作为其他能力或默认启用的统一前置。

历史记录还没有闭合以下具体观察，本次没有把它们改成通过：多文件 apply_patch 的真实会话回滚、
完整 Electron 离屏渲染、用户终端跨平台/重启去重、嵌套线程桌面启动、授权 Web 抓取、
完整归档/回收/恢复界面链、不同文件系统 CoW、Git filter/LFS，以及真实 embedding/reranker 的质量与费用。
这些是选取后续场景的依据，不自动成为每次发布的新门禁。

新的验收应更新具体场景、构建和结果。平台、provider、目录规模、脏缓冲、跨机行为和安装包是不同的覆盖维度，
不再用一列 Wired Partial 同时表示缺实现与缺实测，也不从历史测试总数生成新的完成结论。
