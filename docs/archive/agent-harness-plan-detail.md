# Agent harness 实施计划 — 交付阶段细节（自 agent-harness-plan.md 迁入）

Status: historical delivery record — archived 2026-09-27。本文件保留已收口阶段的完整交付合同与验收叙述，
**不再更新**；阶段定义骨架与仍在实施的部分见 [agent-harness-plan.md](../agent-harness-plan.md)，
能力现状见 [agent-harness-status.md](../agent-harness-status.md)。

---

## 阶段 0 / 1 / 1b 与 P0：已交付入口

当前事实与证据保留在 status，此处不重复已完成计划与废弃接口。

### P0.1 broker 会话身份 pin

create/open/fork 响应后 pin，snapshot 只校验不重绑，见 runtime-broker 与 status 1.1。

### P0.2 Router Actor 与静态授权

按 activeTools/Host 可用性推导，关闭同名覆盖不等于撤销 Pi 工具，见 status 1.1/1.7/3b。

### P0.3 注册表与启动对账

每 workspace 原子 catalog，损坏/权限/未来版本分开，中断 Run 标 lost；当前 schema 以代码为准。

### P0.4 Thread 与 ThreadRun

lifecycle、attention、integration、Run 结局正交；恢复新建 attempt，不清掉旧 lost 历史。

### P0.5 OutputRef 与 TranscriptRef

临时句柄有 Host generation/FIFO 水位；耐久转录不保证截断全文；分页统一 UTF-8 字节。

### P0.6 路径租约

Host 规范化、完整批次全序获取 owner-bound lease；只保证该 Host 管理的写入互斥。

### P0.7 已有验证

身份、Unicode、跨会话、注册表故障测试已存在，修改相关契约时复用，不重新跑一轮完整 P0。

阶段 1 待做：apply_patch 多文件恢复真会话证据；macOS/Linux 与 Electron 打包验证。
Windows 生产发现与按工作区 `harness.shell` 接线已由 D-200 交付；后台 shell 与 terminal runtime 共用真实进程、全局身份及退出/写者
生命周期已由 D-206/D-209 收口。
websearch provider / render / domain policy 现在按 worker generation 冻结：设置改变后新会话直接使用新绑定，无需重启 Host；
旧会话保持原 provider identity，凭据则每次请求实时解析，撤销后明确 unavailable。

### 1b.7 原生 Web 能力收口（D-283，已完成）

现有 `webfetch`、`websearch`、Host SSRF fetch、Brave/Exa/Tavily/Jina/SearXNG provider、search-only Pi auth 凭据和来源面板
保留为正式实现。本阶段已完成配置和所有权收口，没有重做搜索引擎，也没有新增第二套抓取服务：

1. 删除按 `pi-web-access` 包名/启用状态自动让出 `webfetch` / `websearch` 的会话装配路径。原生工具按 Harness 设置提供；用户要使用
   第三方同名工具时，显式关闭对应原生工具。包的存在本身不改变运行行为，也不保留自动让位兼容分支。
2. 把 provider 与凭据解析做成 Host 管理的配置代际。设置或 credential 改变后，未来创建的会话直接取得新的 provider identity 与
   工具可用性，无需重启应用；已创建会话的工具集和绑定保持冻结。凭据被撤销后，旧调用明确返回 unavailable，不缓存旧密钥或
   静默切换 provider。
3. 为 fetch 与 search 接通同一套 user/workspace 域名策略。workspace 只能收紧；工具参数中的 allowed/blocked domains 与配置求交，
   不能扩大持久策略。Host 在发请求和接受重定向前执行实际策略，来源面板只展示已经通过策略的 URL。
4. `web.render` 必须真实控制 Electron 离屏渲染选择：关闭时不启动 renderer；开启而当前 Host 无 renderer 时明确 unavailable，不能把
   未渲染的 SPA 当成功。Web/云 Host 继续如实声明自身能力。
5. 删除没有生产消费者的 `maxFetchesPerTurn` 配置、UI 和文档。它没有对应的已定标失败模式，不能以未实施的硬次数预算冒充安全
   边界；真实网络取消、provider 限流/错误、输出背压和 SSRF 继续各自表达。
6. 当前单 provider 配置足以交付；本阶段不增加自动多 provider 并发、隐藏回退或模型包装。以后出现真实可用性需求时再扩展 provider
   选择，不把功能数量当收口条件。

验证沿公开 `websearch` / `webfetch` 工具到 Host adapter，覆盖配置变更后的新旧会话、credential 撤销、域名策略交集、跨域
重定向、renderer unavailable 和显式关闭后的第三方替换；对应证据已写入 status。默认搜索行为随后由 D-289 更新如下。

### 1b.8 默认网页搜索与原文续读（D-289，已实施）

1. Host 服务可用时默认注册 `websearch`，无配置选择 Exa 免密钥搜索、明确失败时顺序尝试 Parallel；不使用模型账户、不启动搜索子 Agent、不要求用户安装 MCP。
2. 自配 provider 保留原凭据与固定会话绑定，失败不隐式改绑。默认服务的实际来源/换源原因可见；区分空结果、服务失败和取消，空域名允许集不发网络。
3. Settings 默认显示“无需密钥”，说明 Exa/Parallel、查询发送与供应商限流；保留自配服务和显式关闭。所有已有语言同步。
4. `webfetch` 在原抓取/缓存路径上支持字面查找及提取 Markdown 行范围；结果保留来源与收据，不新增持久页面库或额外模型总结。
5. 验证无搜索配置的公开工具 → bridge/router → Host 默认服务 → 真实 HTTP adapter → 结果与后续原文读取；定向覆盖限流换源、取消不换源、合法空结果、域名 ceiling 与自配凭据错误。实际网络样本只证明当次可用性，不外推免费额度或质量排行。

## 阶段 2：上下文与知识

### 2.1 知识库服务

保留 TriviumDB 单写者和领域操作，复用 Store 队列。0.8.5 TQL/零向量绕路按设计 7.5 记录，不固化到上层、不外推最新上游。
数据库问题给用户版本、重现与影响；补 retention、删除级联、native 打包消费者。批次按负载配置，不照搬 5000 条硬数字。
工作状态/集成引用独立保护；领域元数据与文件内容存储职责分开。验证真实 Store、引用清理与相关 Node/native smoke。

### 2.2 Zone 2

现有 zone2.assemble / 隐藏 varin-context 追加通道保留。D-284 只投递新事实、用户修改与相关的新知识指针，不每轮复制全部
blocks/计划/用量面板；agent 自己的编辑、命令和 todo 已在工具结果中。用量 UI 保留，不为变化的使用率单独追加消息。
保留 event cursor 与送达提交；无材料不造消息。去重绑定来源/修订及其是否仍在保留原文中；压缩实际切点丢失基线才重建
对应观察，不在候选准备时重置。沿现有呈现预算汇总明确机械重复，正常 read 不因读过或临近容量缩短，估算明示。
User terminal 段只投影 `source !== agent` 且带 command+exitCode 的事件；cwd 有则写入。每个目标 Pi session 单独写 event 并推进自己的游标，
幂等键包含目标 session 与终端 commandId。无 integration 不造伪命令。

D-301 的 7G 已由 D-305 将该环境增量接到每次实际模型请求前，并在其后附完整当前团队快照；两类材料的保留/游标规则分别处理。
本项在 D-300 当时只记录接缝；完整 7G 随后由 D-305 交付，详见 7.11。

### 2.3 Host 观察者

Documents post-commit、用户修改后的 LSP 和现有 Git 刷新已接。逐命令终端信息用真实 OSC 133/633 shell integration，
不把 PTY 退出当成命令完成、不按终端文本或提示符正则猜命令。只对 user 会话注入；Harness spawn 不注入、不解析。
观察失败不反噬已经成功的写入/HTTP/终端，具体来源不可用要可见。`targetPiSessionId + commandId` 去重，不重放 history、不倒退 Zone 2 游标。
用户终端、steering、计划修改和子返回的事实送达保留；D-284 删除为持续 keeper 发送 `memory.nudge` 的模型调度依赖。
事件实际带来的新内容计入下次请求预算，事件名称/完成/缓存 TTL 本身不触发摘要。

### 2.4 后台摘要准备（D-284，已实施）

正常路径无明显整理停顿是本阶段的产品目标。后台只为下一次压缩生成固定历史摘要，不持续维护工作块；候选 ready 不提前
提交，前台正常新增 entry 不使候选失效。术语、默认和失败语义统一见设计 8.4。
D-286 明确本阶段吸收完整上下文讨论，不能仅交付无感调度：设计8.0的工具首次呈现、8.1–8.3的缓存/增量、8.4.2的容量与
原文、8.4.3的续接摘要、8.4.5的回读与保留、8.4.6的keeper退出、8.4.7的输入重建都须有对应消费者，范围汇总见8.4.8。

#### 2.4A 真实请求预算与摘要请求派生

- 入口是 session-host/ModelRuntime 与 Pi 的真实模型请求构造，不仅是 `session_before_compact`。覆盖一个回合内工具执行后的
  每次模型继续；现有 Pi prompt 前/agent_end 后的自动摘要不能并行成为第二个调度 owner，也不在已结束任务后做收费整理。
- 有效窗口来自模型/provider 与用户覆盖；读取本次真实输出/推理参数，估算 system/tools、保留消息、新工具结果和用户输入，
  按 provider usage 校正。换模型、压缩后计数重新建立，cache 字段不重复相加；显式自动压缩开关和原文保留量仍有效。
- 从活动主请求派生摘要请求：稳定 system/tools/原消息与适用缓存参数，尾部增加固定范围的总结要求。摘要无工具执行器，
  无 memory_edit，无新槽位/密钥；不自动换 minimal、toolChoice:none 或 cacheRetention:none 后仍宣称共享完整前缀。
- 复用 Pi 会话/切点/compaction entry。若 SDK 接缝不足，在受版本管理的依赖/适配层完成所需接缝；不热改 node_modules、
  不复制新 Agent loop、不靠 UI 隐藏阻塞。将实际入口和支持的 Pi 契约写进模块文档。

验收针对真正出站请求：公开会话一次回合内有连续工具调用，新工具结果参与下一请求检查；摘要请求形状、输出预留、usage
可观察且不会执行返回的工具调用。沿已有真 Pi/faux provider 纵切验证，不先建立外部质量评测平台。

#### 2.4B 固定候选与前台并行

- 固定 `(session, 现有 compaction 边界, 被收束前缀, 输入末端, firstKeptEntryId)`，先决定摘要范围，再调用模型。记录调用配置与
  摘要用量；同一压缩周期复用在飞任务/候选。前台 B+N 原文继续追加，不因正常 steering 或几条新消息重新生成。
- 准备首轮采用约 75% 可用输入的可配置软水位；有同配置的摘要耗时后结合近期增长调整提前量。保留量未显式配置时，以约
  60% 可用输入作为压缩后总目标，预留摘要与准备期间新增尾段空间。两者不是运行硬上限或已经测得的最优比例。
- 主请求在可控制的队列中优先，不用本地串行 ModelRuntime 锁把前台卡在后台摘要后。任务结束不新开准备；关闭/取消/来源
  失效终止无用任务，分支导航取消不适用候选。模型变化重核预算与配置；同分支正常追加不是失效。
- 候选在 worker 内暂存，重启时完整 Pi 历史仍在；不增加候选数据库或持久 daemon。手动压缩复用适用候选，明确不同重点时
  才替换，旧迟到结果不能被提交。

验收用受控延迟的摘要响应证明前台仍完成后续步骤，候选只生成一次，候选 ready 时历史尚未改变；分支导航、取消和新消息
分别核对实际来源与尾段。不能把“异步函数已返回”当作前台不被阻塞的证据。

### 2.5 todo 与计划面板

保留已交付的整表替换 plan、来源和用户版本冲突。confidence 只作信息，用户明确配置审批或 plan mode 才等；
普通计划不中断、显式审批与取消/冲突的既有边界保持，不重新增加记忆维护义务。
停止 keeper 后 plan/todo、用户编辑与笔记继续可见可写；不得沿旧 `memoryMode:off → blocks:[]` 将这些能力一并屏蔽。

### 2.6 按需切换与消费者收口（D-284，已实施）

#### 2.6A 提交、异常容量与历史回读

- 在下一模型请求前，沿 Pi 安全边界核对候选来源、工具配对与当前预算，发布摘要和 firstKeptEntryId，再构造
  `P + S1 + B + N`。保留准备期间新增的用户消息、工具结果和待处理 steering/follow-up，不覆盖或重复重放。
- 切点不能在摘要后向后移动，导致未被收束的原文消失；摘要较短可向前多保留原文。候选偏离 60% 但下一请求可用时直接采纳，
  不为了比例重做摘要。连续压缩替换一份活跃摘要，原始 Pi entry 留存。
- 新材料/窗口缩小导致超窗时，摘要调用自己也要有可用预算：按配对边界分次收束可容纳的旧前缀，保留最新原文。候选未完成
  则复用并等待同一次调用；失败或失效走同一摘要实现，不回到 keeper。每次扩大收束须有进展，单份材料本身超窗要明确
  分页/读取入口或容量错误，不静默裁掉正常结果。
- 公开 `history` 工具复用当前 Pi session/branch 的查找与 entry 读取，支持关键词、路径、entry 与相邻原文；继承 actor
  和父子权限，不向子暴露父完整对话。大输出沿现有分页和保留责任，临时句柄失效与真正全文可读分开表达。
- 补同一工作 fresh 的输入构造接缝：当前任务与仍有效约束、当前系统/项目规则、选定成果与未解决项、必要历史/活跃动作引用。
  原始Pi历史和工作状态保留，旧验证不冒充新修订通过；新输入就绪后才发布世代，不强制再总结一遍旧历史。Thread 的具体
  continue/fresh 入口在3.18B消费这条通用能力，不复制第二个上下文引擎。

验收沿一条真实会话证明“后台准备 → 前台新增 → 容量切换 → 下一次请求 → history 回读”；结合来源漂移/取消、超大新结果、
模型变小与再次压缩的实际反例。候选失败不能先截历史，退出任务无新增总结调用。共享场景合并验证，不按字段机械堆测试。

#### 2.6B 默认切换、UI 与旧依赖删除

- 以新链完整替换持续 keeper：删除 memory-agent 调度与专用 memory_edit/coverage/compaction.before 组块路径，删除
  off/assist/takeover 和 shadow 运行分支、专属状态/UI。保留有实际用户/计划消费者的 block 读写，不按名字删整个知识模块。
- 联动 2.2/2.3：真实事件照常送达，移除 keeper nudge；不重复注入全部 blocks/用量。观察基线绑定交付 entry，只有实际退出
  保留原文的基线才重建；候选 ready 不重置。删除未接线的文件/技能重注入 helper，不再按压缩次数推委派。
- 联动线程：dispatch carryBlocks 只携带计划/用户笔记；read_thread/Zone 2 优先展示真实状态与报告；报告偏离从明确报告字段
  取得，缺失明示。删除依赖 decisions 块的自动报告/建议来源，不另起模型补齐；accepted knowledge 与已有建议保留。
- 自动压缩沿 Pi 开关，后台准备默认启用且 user-owned，可单独关闭并保留必要时的同一同步摘要路径。删除旧引擎，不静默
  改写外部 Pi 配置；旧 memory 字段提示退役，明确关闭后台维护的用户选择继续阻止提前调用，不能误当自动压缩开关。
- UI 在实际提交时展示边界，可展开摘要、前后规模和保留原文；准备不锁 composer，只有实际等待才显示等待。保持正常 token/
  缓存/费用 UI；准备耗时、采纳、等待、真实 usage 与首次续接延迟沿现有诊断记录，不建辅助费用看板。
- 核对工具输入端：搜索一次返回足够判断的片段，read保持请求原文，测试失败块/未知输出不被噪声整理吞掉，附件不擅自替成
  概要；复用现有格式器/存储。跨压缩仍需引用的输出用会话保留正文或已有artifact，不把临时句柄当永久全文。没有问题的
  工具不重写、不逐工具机械加测试；重点检查窗口压力不会改变正常返回质量。

接通新会话控制器时保证同一次压缩只有一个调度/摘要 owner；最终交付前删除旧 keeper 及无消费者的相关协议、测试和文档。
最后以公开消费者验证计划/用户笔记、知识、线程返回仍可用，未到准备水位的正常短任务没有新增摘要调用。真实缓存率与质量
在实际使用中观察，不用测试数冒充结果，也不以付费模型对照作为上线前置。

### 2.7 知识建议与管理

人工标记、suggestions 槽位的用户消息提议和 Settings 全量列表/取代链均已接（D-208/D-211）；未配走已有
无模型路径。Settings 的编辑/接受/驳回/停用以打开时完整修订在同一写队列 CAS，同 scope 预检后提交，旧历史保留；模型提议的
scope/source 由 Host actor 固定，相同正文的历史查重与插入原子完成。自动接受仍按用户显式 scope 设置。
keeper decisions 来源已随 2.6B 移除；不从续接摘要追加自动提炼调用，已有知识/建议不删除。

### 2.8 embedding

生产路径按 D-196 / D-198 接线与收口，交付以 status 为准。权威 workspace/user `.tdb` 仍以 placeholder 维度打开，知识向量复用共享代际存储的独立 scope。有效 `harness.embedding`
时，召回与 Zone 2 注入走同一 `harness.embed` 绑定；未配置保持文本/图。旧 `knowledge/embedding.ts` HTTP adapter 已删除。
知识库不使用本地 MiniLM。建设必须覆盖自动维度、空间切换、正常变更的增量合并、迟到发布与关闭；有效状态/修订在 Top-K 前约束，长条目的多个块按知识身份合并。
公开 recall 与 Zone 2 使用同一绑定、取消和两种范围的融合逻辑，绑定解析异常仍交付文本。验证包含未指定维度的真实 remote adapter 与公开服务消费，faux 证据不外推真实远程质量。

### 2.9 模型槽位与执行配置

当前 protocol/UI 提供十个普通 Harness 槽位；`harness.embedding` / `harness.rerank` 是独立配置种类（3.16B/E）。继续使用用户所属的 Pi
配置与凭据路径，子线程模型记在 ThreadRun；D-285普通线程与预设的明示继承不伪装专用绑定。新增模型 kind 必须同时完成类型、设置、
有效绑定与调用消费者，不能靠 UI 任意填一个 model id 冒充后端能力。D-080 的普通会话统计保持，不增辅助分项看板；完整
RunManifest 不成为这组能力共同前置。

### 2.10 recall

保持 workspace/user 召回和来源标注；suggested/dismissed/失效知识不当有效记忆，user.tdb 不存 event/文件。
补实际查询与管理消费者，不要求评测集。

## 阶段 3：检索、工作状态与线程

### 3.1 符号图

D-237 已补显式重扫的外部删除对账：完整枚举 + Documents missing + store revision/generation 条件删除，排队取消保留旧图；
失败/截断/未知 inventory 不删除，重建路径重新采集，关联随 connects 集合更新。沿现有扫描入口，不新增后台循环。

已有 file/defines/symbol 以及 `imports` / `connects` / `associates`（3.11 第 4 步）。读者是 explore 的路径级候选
（定义 / 连线另一端 / 反向 import / 已解析 references/calls，3.12）和 `related` 工具；摘录出边注解（D-108/D-112）仍在。
D-240 已按实际查询建 `references` / 解析后的跨文件 `calls`：relation collector 围绕锚点有界解析并持久化、lsp 导航回写
磁盘绑定结果，来源/版本明确（resolvedBy + 站点修订 + staleTarget），LSP `references` 不冒充调用图，也不和 `related` 抢活。
复用背压和按变化路径采集，未知语言/不可用不清最后图；不把全图或所有索引完成作为 explore 前置。
范围只从磁盘正文采集并逐文件记 document revision（D-087）；脏缓冲结果不入图。图只选路径，行号在当前正文里重新确认。

### 3.2 explore：正式默认工具

本节提供当前入口；新的查询与索引工作分别在 3.15/3.16 排期，行为契约以设计 6.1 为准（D-173–D-175）。

| 已有能力 | 下一步实际改动 |
| --- | --- |
| 自动 surface snapshot、Documents 当前正文、固定草稿的 read/grep/find/ls 与线程基线；根会话 edit/write/apply_patch 经 `document.surfaceWrite` 写回同一缓冲（D-225） | 语义覆盖沿同一来源（3.16D）；不另建读取权威 |
| question/anchors/paths、对象与词组提取、候选按文件轮转、真实 rg | 保留明确范围和线索，收窄隐式意图判断；路径/符号明确时直接导航 |
| models.explore 经公开 explore 接入查询理解/搜索表达和候选判断 | 沿用 Pi 会话 ModelRuntime；真实槽位质量仍未观察 |
| 结构切片、图定义/连线另一端/反向 import、带版本的 focusRanges | 图只给可核验导航或关联；语义焦点不依赖查询词命中 |
| 词法加权覆盖、本地/远程向量、开放候选按真实来源名次 RRF | 单元自身依据；配置了 rerank 且本轮未用 LLM 选择时走 3.16E，不与 LLM 默认串跑 |
| 原文、provenance、OutputStore 与 UTF-8 预算 | 一次决定实际呈现，原文省略项与最终记录一致 |

3.15 A–D 的查询上下文、开放排名、呈现前单元与 LLM 消费者已交付，见 status 3.15 与 D-182–D-189。工具原生链、Actor 路径、
固定草稿与输出句柄的已验证事实看 status；3.16B–E 接线见 status 3.16，真实 explore/embedding/rerank provider 质量仍未观察。
精确匹配继续用 grep，较长开放问题由 retrieval 处理；快速 explore 用 LLM 做局部语义决策，算法执行批量搜索/读取，不复制
完整自主子 agent 循环。全仓生成式摘要和新词法索引按各自实际需要另行设计。
没有某一路时明确来源状态，其他检索保持可用。

### 3.3 related

✓ 已接线（3.12 + D-240）。工具回答文件级定义、import、反向 import 和连线另一端，并对符号名锚点做有界解析回答已
解析的 references 与双向 call 边（每定义一次 references+definition+callHierarchy，≤8 个定义）；没有与不完整分开表达，
relation 段按 per-source 状态区分。不是 `lsp.references`（按位置精确回答），不做 PageRank / 多跳。store 未打开返回
`unavailable`，不开库。

### 3.4 工作状态、物化与生命周期

沿已交付 Thread/ThreadRun、catalog、角色冻结、异步 dispatch、blocks、传感器、真实 child 和 Fleet 扩展，不重建旧模型。
设计 9.2.5b 为完整行为边界，下列工作直接实施：

D-252 把本节存储、文件事务、物化及对应底层资源的下一轮结构演进纳入阶段 R。已完成的 TS 返工保留并独立验收；
后续按 R1–R3 接管其权威与消费者，不再并行规划第二轮同目标的 TS 存储重写。本文 A–F 的用户行为仍是 Rust 验收输入。

**A. 固定结果。** 物化线程 settle 先建立固定 snapshot，再从该 snapshot 中工具实际看到的文件字节发布 native result；发布
catalog 前复核 snapshot 身份。snapshot 后 live 修改不混入，另发新结果。报告/测试绑定受检修订，输入变化不自动继承通过。

**B. 原生状态与迁移。** Host 建内容对象/路径树、固定基线与 delta/tombstone 分支头，结构共享、原子发布。结果/Integration
独立持有正文引用，复用恢复捕获与路径状态；恢复历史删除不丢线程结果。Git tree 可作基线来源，原生 capture/copy/CoW 支持
非 Git 和无首次 commit。初次采集有真实成本，普通消息不捕获全仓；监视器只作失效信号，变动中捕获重读或报告不完整。
Git 留作基线/物化/导出后端；不从 commit blob 重放可能执行副作用或触网的 filter 来迁移旧内部结果，也不建设升级导入器。
内部格式按 0.1 直接替换并清旧路径。覆盖新格式的读取失败、并发发布、中断、对象保留与原生 Pi 会话消费。

**C. 工具与草稿。** 同名 read/grep/find/ls/edit/write/apply_patch 读写固定 base+delta，父改动不串读，包括子未改路径。
用户消息自动取得草稿快照，来源/版本随分支保留；草稿集成走 Document Registry 的版本化编辑和 grouped undo，不隐式存盘。
原生 Pi 工具、LSP、扩展、shell 需要真实路径时 materialize 并切同一执行视图，不为无目录而禁用正常能力；shared 明示实时共享。

已交付的第一段是 dispatch 草稿基线：请求内复制固定正文与字节格式，Thread catalog 持有不可变 baseline id，queued/lost 恢复从持久
对象重建；有效草稿是 branch revision 0，不是 child delta。dirty 角色强制 isolated，来源不可用则 dispatch 失败。D-214 / D-218 已把非草稿
路径改到 dispatch 创建分支时固定：Git 捕获工作目录身份与变化集，非 Git/unborn 做一次可取消目录捕获；Git 错误、捕获窗口变化、
活跃 writer 与 gitlink 不得发明完整分支；失败删除 Thread。新虚拟文件在形成结果前写入真实默认 mode，apply/补偿按 `sameState`。
父会话的同名 read 与 grep 已消费同一固定 surface snapshot；find/ls 已消费同一快照。surface 写回与绑定预览
已按 D-201 接入线程面板 / Document Registry。D-212 已把隔离 Thread Run 的同名只读工具接到 WorkingState 视图：delta 覆盖 base，
tombstone 隐藏路径，父 drift 不能补读，scope 仍由 Host 拒绝。D-213 / D-217 已把同名 edit/write/apply_patch 接到同一分支视图：虚拟写入
做 writeRevision CAS，不碰父磁盘；首次 bash/LSP 冻结修订、等在飞写入、staging 物化后原子切换。失败或取消后重读
execution view，仍虚拟则继续写分支；崩溃按 `materializationSwitch` 恢复到一个权威视图。修订标签等于实际读取的
`writeRevision`。嵌套改父虚拟分支走同一写 gate。
所有物化/scratch 记录持久化 `managedRoot`，读取或改变目录前同时验证 canonical containment 与 Host/backend 根授权；旧记录不能靠
自己写下的路径取得删除权。Application Host 的虚拟 scratch 位于自身数据目录，不占用父或根工作区路径（D-231）。
D-220：独立 init / detach 后 inspect/settle 使用执行仓库可解析的 `executionBaseline`，`worktree.base` 仍是父状态身份；
reclaim 后 rematerialize 不得引用已删子仓库对象。WorkingBranch 读取在 store lease 后重取当前 view；explore 查询开始时
在同一 shared lease 内复制 immutable snapshot。默认新文件 mode 按 umask 计算，不探测用户树。fingerprint 含 dirty 内容身份。
D-221：嵌套 merge 先取得父分支写入/切换权威，再决定 branch 或 directory，再打开 store/目录；branch 集成先持久化
applying intent，CAS 后再 complete。启动对账按 before/after 补记录。`runWhenVirtual` 不再用固定次数制造失败。
D-222：directory 恢复写物化父目录必须走 execution Documents gate，对象库仍在 owning root；dequeue 把 manifest
permissions 送进 `session.create`；`session-bindings.json` 由 catalog/run 重建并对账；Thread knowledge/recall/Zone 2
解析 owning workspace，Documents/LSP/shell 仍用 execution。
D-223：父 kill/archive 按稳定后序进入每个后代自己的 lifecycle serialization；祖先归档或正在级联时拒绝恢复该后代。
scope 只拒绝完整 `..` 段、绝对路径和盘符路径。
D-215 已把 `parent.kind: "thread"` 接到真实 dispatch/wait/read/merge：角色目录装配嵌套工具，Host 拒绝扩 scope 与未授权
工具；嵌套基线复制父分支视图，孙结果先入父分支再入根工作区。

**D. 环境与执行写回。** Git/copy/CoW 按平台选择，缺 CoW 用正常复制，默认不硬链接可写目录；包管理器缓存可复用。
setup 采用用户工作区配置，配置一次授权正常重复执行，不猜仓库命令；按工具、依赖输入和实际环境需要运行幂等准备。
没有 setup 不伪报已准备，也不禁止已能工作的任务；timeout 可配置，不预置 600 秒硬停止。失败记 setup-failed、退出和可追溯
输出，修正后新 Run 继续。copyIgnored 已以 branch captureScopes 冻结并捕获后续新增/修改/删除；其他规则继续标记版本化输入/结果、
可重建缓存、环境文件，ignored/名字不等于可删除。
用户显式共享显示范围。命令、后台 shell、格式化/生成文件通过后端差异和变化记录收回状态，成功发布 revision。
物化期间受控工具与命令用同一目录，分支按执行世代协调写入；未收集完保留目录，崩溃按实际对账，不重放可能已执行的副作用。

**E. 回收与空间。** D-077 的 merge/cancel/failure/archive/无使用者 idle 边界默认回收；前提是待保留结果保存、相关实际写者
退出，原路径可按结果重建及 setup。git status 干净/无 running Run 不是全部证据，ignored 结果和后台进程也要处理。
未知内容只保留该目录并报原因，不禁其他线程；显式 keep_worktree 有效。统计目录与对象历史占用及可回收量，按用户配置预算、
真实空间/已知需求处理，缺定标不采用 8 GiB/10%/80% 默认。必要时回收/排队/明确不足，不杀已有任务；未知 setup 占用不计零。
真实 ENOSPC 可诊断并保留可恢复结果。启动对账检查受管归属，未知目录不猜删除；历史按引用/用户保留清理，不固定 30 天删结果。

D-239 已接用户旧结果释放：线程卡片按需 GET history，确认 branchId/resultRevisions 后 POST release。Host 在同一生命周期与
存储/Registry 边界重查 head、当前结果、Run 输入、review 和未结束 Integration；先删除版本元数据，再释放其引用并回收无主对象。
中断对账保留当前权威，未知目录不授权清理；返回逻辑移除和实际对象清理两个结果。保留当前分支、报告、转录及其他引用。
验收包括共享内容仍可读、释放旧输入后已完成 Integration 仍可撤销、失败重试与 UI 迟到响应隔离。整个 Thread/当前分支删除不在本切片。

**F. 提示。** 路径重叠非阻塞，未知 shell 覆盖明示，不长期占编辑锁。合并预览绑定子结果与父相关路径/草稿版本，改变即失效，
接 integration/Zone 2/UI，不等全仓 WorkspaceHead 或收益 benchmark。实现与集成共用查询，不复制状态 authority。
预览查询不制造自身 Thread 更新循环；冲突提交消费旧预览的完整 binding，不在重取父正文后复用旧解决（D-203）。

对应验收：固定结果后 live 修改不混入；父改动不串读；子原地写不改父；setup/执行写回；ignored/后台 writer 不误回收；
原路径重建；跨清理/迁移引用；非 Git/无 HEAD；真实 Pi child 创建到执行、结果和重开。平台后端在相应机器验证，不要求所有
平台完成才启用已验证后端；这些是实施测试，不是决定要不要采用架构的研究门。

### 3.5 线程工具与 Integration

dispatch 异步准备、观察增量、固定结果集成与kill保留结果是现有基础。当前send仅接受直接子active/running，并不能续做settled
实现线程；D-285在3.18补新Run、inform/request与目标路由。等待按共享执行准入，压缩基线按D-284保留区间处理。

merge 以选定原生结果和父相关状态生成计划。逐路径三方处理相同/未改、文本、删除/修改、
类型/链接/mode；文本可留标记，非文本给版本选择。无需父 clean 或用户 commit，不切分支、不改历史。
UI/agent 共用 operationId，重试与新结果分别处理。

接恢复逐路径 before/after、apply intent、核对、条件补偿；预期冲突保留现场，意外 I/O 部分失败补偿，后续用户修改不被覆盖。
结果明确 applied/conflict/compensated/needs-attention 并给已应用/冲突路径，不用 merged:0 暗示父完全未改。
冲突解决核对同一操作，不重放已写 patch。草稿在 surface 应用撤销，磁盘经 Host/Rust。原生路径集成不修改 index，不恢复已删除
Git结果导入器或写index的--3way。集成完成与父回合checkpoint绑定；不能把process writer注册等同可撤销日志。
草稿执行复用 Documents owner 连接，绑定实例/代际/修订/哈希；正文与回执经认证通道。磁盘与 surface 在同一持久操作先记 intent，
确认后才完成，崩溃不明保留 needs-attention；撤销与条件补偿校验当前产物。agent 不依赖线程面板代为执行，UI 不自报裸路径完成（D-203）。
合并与验证分别记录；父对合并后状态做相关检查。结构感知优化沿合并策略实施，不把不同函数等同语义无冲突。

验证正常/冲突/部分失败/中断、幂等、父并发、草稿不存盘、index 后续修改和报告绑定；覆盖重叠区间、权限位、无效 UTF-8、日志提交失败
后重试、共享 catalog 工作区隔离，以及删除完成历史仍保留线程结果；用真实文件/Git 与现有 Pi E2E，
不要求新评测集。

### 3.6 可选预设与嵌套（D-285）

目标由3.18交付：role不再必填，普通线程继承当前模型；预设提供任务方法/工具/明确模型来源，工作区和背景另选，执行配置
归Run。保留Host allowlist、capability、父权限和scope，不以消息改变权限。允许普通执行配置嵌套，不限两个角色名；同根
共享执行预算，父子/兄弟允许定向通信。task为默认背景，inherit显式选择，不为所有线程复制长历史，不按轮数或token设新限制。

`retrieval` 是较长事实 Thread，D-285 后当前入口为 `dispatch(task, { preset: "retrieval" })`，事实协议保留。未配置
`models.retrievalAgent` 时角色不出现且 Host 拒绝无 model 的 retrieval dispatch。工具 allowlist 不含写/bash；
web 工具仅在 Host 已装配时可用。交付物由 `submit_facts` → `thread.facts.set` 写入，settle 时 Host 封印
`report.evidence`。Host 标 source-checked 而不是 verified，delivery 不用假 completeness，pending 绑定 runId，
证据走耐久 artifact；receipt 只由 active retrieval Run 铸造并绑定 owning/session/thread/run 与 exact URL，普通 webfetch 不铸权威。
嵌套 retrieval 在 dispatch 时沿 isolated 分支固定父状态，可按需物化只读输入，settle 不发布目录变化（D-227 / D-230 / D-231 / D-234）。
取消/失联复用既有 Thread 生命周期，真正删除 Thread 同时释放 pending/sealed/temporary artifact 与 receipt 引用。

D-315 / 阶段 L 计划将自然语言报告接为正常交付并保留可选 `submit_facts`，详细见
[Web 与科研检索](../web-research-search-design.md)；该合同调整尚未实施，不与上述当前事实协议混写。

### 3.7 自动 review

当前review-sensor默认enabled:true/gate:false。D-285改默认关闭，已有用户显式enabled/gate保持；实施者正常验证、主线关键
验收与按需独立review不变。仍用固定diff/任务/项目知识和resultRevision+reviewThreadId+reviewRunId绑定，迟到旧结论不标
新结果通过；不把每个子结果自动接一轮模型审查。模型来源按预设明示，不新建review流程层。

### 3.8 LSP 导航与语言服务视图（D-087）

保持现有 workspace/scope、一基位置与"编辑器 buffer 不被磁盘覆盖"；隔离线程用自身版本/物化目录，不能借父缓冲冒充子状态。
缺某语言服务器只说明该来源不可用。本切片把共享会话拆成按来源隔离的视图，并让范围携带正文修订，交付顺序：

1. **语言身份统一（已交付）。** `@varin/protocol` 的 `languageIdForPath` 取代 `lib/harness/language-id.ts` 与 UI
   `language-services/language-id.ts` 两张表。`.mts/.cts/.mjs/.cjs` 在 agent 侧不再判 unsupported，`.sh` 统一为 `shellscript`
   （编辑器显示经 `editorLanguageIdForLanguage` 映射回 `shell`）。运行时由编辑器注册表贡献的语言仍只在 renderer 可见。
2. **视图键与版本命名空间（已交付）。** 会话键加 `viewId`；Host 视图按 (视图, 资源) 单调分配版本，`surface` 视图沿用
   `localEditRevision` 且行为不变；renderer 路由固定 `surface`，事件流按视图过滤。
3. **agent 视图的正文绑定（已交付）。** `createLanguageViewBinder` 统一解析正文：导航按 `AgentInputContext` 取固定草稿或磁盘，
   符号采集与诊断只取磁盘；已知脏路径草稿不可用时不回退磁盘。惰性起进程，`inspectViews()` 报告进程数/开文档数/空闲时长。
4. **修订出现在结果里（已交付）。** `LspNavigationResult` / `DiagnosticsResult` 带 `revision` 与 `disk | surface-draft`；被查询
   文档请求前后断言修订，`stale` 重绑一次后重试；跨文件位置标 `unpinned`，不编造修订、不在覆盖不全的信号上判 stale。
5. **生命周期归位（已交付）。** 视图各管自己打开的文档：关标签页只销毁 `surface`，Host 视图按 LRU 设上限、空闲释放、重启不重放
   `didOpen`；`restart` 与 provider 重注册只影响本视图。
6. **符号图记修订（已交付）。** `replaceFileSymbols` 要求 document revision（空值拒绝），旧行缺该字段读作 `null`；脏缓冲结果不
   入图。`explore` 结构展开只用修订一致的范围——该消费者仍待接。
7. **诊断精确化（已交付）。** 删除 `endsWith` 双向后缀匹配；`lsp.diagnostics` 绑定磁盘正文并等待同一修订的发布，超时 `pending`；
   无生产调用方的 `afterSnapshot` 参数与 provider `syncDocument` 一并删除。

已验证：视图隔离与 Host 版本分配、同修订不重复通知、`expectedRevision` 不符即 stale、关闭编辑器最后一个标签页不影响 agent 视图、
LRU 上限与空闲释放、导航的固定草稿与"草稿不可用不回退磁盘"、跨文件 `unpinned`、stale 重试一次后不循环、真实 fixture 进程下
`surface` 视图保持 absent、诊断按磁盘修订变化、后缀同名不串台、符号行携带 revision、语言身份统一。
待接：`explore` 结构展开消费带修订的符号范围；Host 视图占用的 UI 呈现。

### 3.9 观察游标

复用 D-076 prepare/commit/abort、单调 revision 和 namespace generation，响应失败可重放，clear 后 pending 不复活。
对象销毁释放游标，用户 UI 独立观察者。持久 tool-entry acknowledgement 按实际送达需求接，不阻塞现有默认增量工具。

### 3.10 线程 UI

rail/overlay/时间线共用session feed/SSE。已有归档/恢复、结果/占用基础保留；D-285以任务命名，增加继续/fresh和阶段成果选择，
定向消息带来源，普通子过程不广播。浏览历史不自动开始新Run或占执行名额，明确执行请求才恢复；未知占用不补零，文案i18n。
归档等待 Run 准备与真实执行退出，失败保留重试所需身份；恢复原 session 时创建并绑定新 Run。已结束或已回收的普通线程打开也先恢复，失败保留原生命周期。
回收持有写者屏障直到删除完成；同线程生命周期互斥，自动回收跳过忙目标；首次准备/恢复按工作区全局占用预留可知新增需求，慢 setup 不持工作区锁（D-204）。
旧结果历史入口按 D-239 接在同一线程卡片，按需加载与显式确认，不新增后台轮询或浏览器持久状态。

### 3.11 结构来源 provider 与 tree-sitter 语法包（D-091）

语言服务器回答"这个名字指什么"，tree-sitter 回答"这段文字的形状是什么"；两者在 Application Host 长期共存，不进 renderer。
消费者：explore 结构切片、命中分类（6.1 fuse 段"名称/路径/注释/字符串/正文不同计分"的落地）、连接边形状识别、冷仓库符号目录与
`imports` 边、线程/压缩用的仓库地图。它给不了类型、跨文件解析与诊断。第 1–5 步已实施（D-093–D-127）。
交付顺序，每步独立可验证：

1. **结构来源接口 + LSP 实现。** 定义带修订绑定的 provider：输入语言 ID（复用 `languageIdForPath`）、正文、修订；输出符号轮廓
   （名字/种类/范围）、命中节点分类、带字面量调用、import，能力标志声明能给哪些。首个实现包装 6.4 agent 视图的 `documentSymbol`；
   explore 切片只认接口，冷/热为显式条件，缺时退行窗口并说明来源状态。无新依赖。验收：切片单位按 D-090 / D-098（容器：小函数全文、大函数签名 +
   命中语法块 + 省略标记 + 完整读取入口；普通值绑定切所属函数/类），`explore.search` 的 worker—protocol—Host 链能在一次结果里看见。
2. **冷启动对照基线。** 在本仓库量一次 agent 视图从冷启动到 `documentSymbol` 可用的时间，记入 status；这是第 3 步"好了多少"的对照，
   不再是"要不要做"的门。
3. **web-tree-sitter + TS/TSX 包作第二 provider，同时接命中分类。** 引入依赖与 `.wasm` 打包路径（Electron/Web 宿主都能读到）；
   语法包 = 语法 wasm + Varin 查询（定义、带字面量调用、import；从 Aider / nvim-treesitter 的 Apache 2.0 查询改起并注明来源）；
   解析结果按内容哈希缓存，授权与来源仍每次核验；ABI 随应用版本锁定，加载失败按 provider `unavailable` 报告。验收：同一查询在
   语言服务器冷态下由 tree-sitter 给出切片；命中按节点种类分类进入排序；解析受工作预算与取消约束。
4. **连接边查询、冷仓库符号目录、`imports` 边。** ✓ `bridge.request("…")` / `router.register("…")` / `on("…")` 等形状产出确认连接，
   无法确认的同名字符串标关联候选；`searchFilesystemFiles` + Documents 磁盘读把 TS/TSX defines/imports/连接边写进 6.2 现有图，同一
   `documentRevision` 与 generation 绑定，不做基于 LSP 的全仓扫描。生产消费者是 explore 读摘录路径出边（D-104–D-108）。
5. **编程语言支持开箱即用（D-290）。** 常用结构包随发行提供 wasm 和可工作的提取查询，构建校验摘要与查询兼容性；不把只有解析器的安装当作可用结构检索。
   TS/JS、Python、HTML/CSS、JSON、YAML、Shell 的 Node 语言服务器随应用提供，使用现有扩展注册和 Supervisor。
   Rust、Go、C/C++、Markdown 的独立服务器首次实际使用时自动准备到私有目录，优先复用可运行的本机程序；不修改项目依赖、不全局安装工具链。
   固定远端发行版本/摘要，Go 通过官方模块校验；准备可取消、并发去重，只有完整产物才成为安装结果。
   设置页与普通启动不下载、不启动语言进程；编辑器或 agent 请求，以及用户主动准备/重试，才触发对应语言。
   设置按当前工作区展示结构检索与代码分析，分别反映发行可用性和运行状态；包名、ABI、wasm 导入收进技术详情。
   用户自带语法仍走已有存储/ABI校验；失败、未知、缺项目运行环境不能显示为成功。具体语言覆盖与实测证据见 status。

不做：先建"通用 AST 服务"再找消费者；替代语言服务器的导航与诊断；renderer 引入；第一版接受任意第三方语法包；一种语言时做包管理器；
声称解析速度或省时数字（实测记 status）。

### 3.12 符号图读者（explore 路径候选 + `related`）

3.11 第 4 步把 TS/JS 符号和边写进图，但读者只有摘录出边注解（D-108）。`searchSymbols` 没有生产调用方；
`findLinks` 只给 associates 闸门用；`related` 是依赖不存在 API 的 PageRank 空壳。本刀给图真实读者，
并分清图能加什么、不能加什么：

| 图给的 | rg 给不了的 | 是不是新召回 |
| --- | --- | --- |
| 定义优先 | 目录知道 `foo` 在哪儿*定义*、是什么 kind；rg 只知道提到 `foo` 的行 | 否：同一文件 rg 也能命中，图改的是排序与理由 |
| 连线配对 | 同一字面量的 `register` 端和 `request` 端是一根线的两头 | **是**：另一端可能不在 rg 候选里（plan 0.7 的「找不到入口」） |
| 反向 import | 「谁 import 了这个文件」不需要查询词 | 否：问的是拓扑，不是词 |

硬约束：图只选路径，不给行号；物化后必须在当前正文里重新定位符号名/字面量，定位不到就丢掉这个窗口，
不许退化成第 1 行，也不许把图里的行号当真（D-112 已修过的错误类型）。图不可用不得拖垮检索：读路径只用
已经打开的 store，失败/空/未开按来源状态降级，rg 结果照出。目录只覆盖带 `importQuery` 的语言，纯 Python
仓库是 `empty` 不是坏了。图有独立预算，`filesDropped` 跨来源取最大值。不和 `lsp.references` 竞争。
目录只有冷扫描 + Documents mutation 那么新，不另做第二套过期检测。

交付：

1. **退出码（D-103 第 2 项）。** 崩溃隔离用例给已死子进程 stdio 加上 `EPIPE` / `ERR_STREAM_DESTROYED` 处理。
   第 1、3 项（挂钟阈值）本刀不碰。
2. **可查的 store。** 先量再决定要不要内存索引。`searchSymbols` 暴露精确 / 名字含 / 路径含分档。
   反向 import 解析相对 specifier（含 `.js`→`.ts` 孪生）；解析不了可见地报，不猜。
   量要按**热路径上的调用次数**量，不按单次量：反向 import 建解析后的反向索引，写入即整份失效
   （新增一个文件会让别的 specifier 突然解析得了），`catalogStats` 不为了 `languages` 逐文件读 payload（D-139）。
3. **explore 第二候选来源。** 定义候选始终跑（只要 store 开着且目录非空）；连线补全和反向 import 在第一次
   打包之后，用已选中摘录里确认过的字面量/路径。三路进现有 `rankCandidates` RRF，不另起排序。
   取代 D-108 的「不扩候选池」。摘录出边注解仍在。打包 boost 按结构化来源查表，不靠展示文案的前缀；
   图那一趟物化复用主循环的预算与并行度形状，超预算的仍是候选、走 `not-requested`（D-139）。
4. **`related`。** 丢掉 PageRank facade，按路径或名字回答定义 / import / 谁 import 了它 / 连线另一端。
   接进 pi-host（协议 + 工具定义 + 默认注册）。工具描述写明和 `lsp.references` 的分工。
   正文按段设可见上限、`details` 保持完整，不把「装不下什么」交给通用截断器（D-139）。
5. **前置条件：目录得建得起来（D-140）。** 读者再好，目录建不出来就没有可读的东西，而且失败是静默的
   （冷扫描火忘 + `graph: empty`）。枚举一次问 git（`git ls-files -z --cached --others --exclude-standard`），
   不是每目录 spawn 一次 `check-ignore`；派生图写入按安静期去抖 flush，用户数据仍在各自写入里即时 flush；
   测量脚本按 `CATALOG_SCAN_BATCH` 成批并发，量产品真会跑的形状。数字进 status。
   D-236 把同名闸门再访改为 file 行内的修订/代际绑定抽取记录；只更新确认后的关系，不重读源码或重发 symbols。
   未确认候选不建图节点，显式重扫仍核对文件修订；输入语料、结构请求次数、节点数与耗时记入 status。

不做：PageRank、多跳、`references`/`calls` 边、embedding、词法索引、BM25、语法包/设置页、记忆/压缩/线程/权限、
explore 模型增强。不声称检索质量或速度提升；量到的数字进 status，标明是对照数字。

### 3.13 验证已有精确线索，并让验证后的证据决定输出

D-142 观察：8 个成功返回的问题、约 160 个片段，没有一个来自源码——全是 `docs/*.md`、`CHANGELOG.md`、`LICENSE`、`bun.lock`。
图里已经有答案（`findLinks("explore.search")` → `harness-services.ts` 的 `connects register`，D-143 后还有 `explore-tool.ts` 的
`connects request`），explore 没去问。六个核实过的缺陷：词组内按路径字母序当 RRF 名次；原始 `GROUP_WEIGHT` 与 RRF 混加；
`findLinks` 不看 `end.kind`；已在 rg 池的文件被图找到后不进补充物化；`graphBoost` 是文件级；`limit` 凑满即停。

本刀三部分，都不引入 embedding / BM25 / 词法索引 / NLU：

1. **查询入口（D-144）。** 先提取对象，再处理问句。完整技术字面量整体保留；普通问句词是内容词。关系词表写死为注册/连接、
   import、定义。只有对象驱动 `searchDefinitions` / `findLinks`。
2. **候选验证（D-145 / D-146 / D-148）。** 任务匹配分层，路径只作 tie-break。直接线索在既有读预算内优先物化。补充物化看
   是否已读、是否已有当前证据。文件角色按问题决定；测试路径条件式优先。`definitionDropped` 改为去重路径。
3. **证据打包（D-147）。** 理由绑定窗口；`connects` 与 `associates` 分等；核验区分「含有名字」与「在这里定义/注册」。
   `limit` 是上限。因直接线索已验证而跳过的泛词记 `direct-verified`，与读预算 `not-requested` 分开。

观察脚本收紧十问的最小证据要求，每题打印阶段诊断，并对同一入口加五个变体（D-149）。十问足以证明「已知入口现在能被利用」，
不足以证明泛化或普遍性能提升。

验收补第 4 项（D-151）：阶段诊断的所需证据必填，量具不得在未核验时报 `verified`；按读发现的连线字面量与问句对象无关时降到
`support` 档，因为容器切片让注册表窗口含有它注册的全部字面量，「只展开窗口正文里的字面量」在这个形状下不构成约束；守这条的
单测必须跑真解析器的容器切片，并先验证无修复时会红。

第 5 项（D-152）：已读快照按新增证据重算窗口。对象词一趟冻结的窗口不再挡住内容词一趟的命中，连线展开落到已读文件的图线索
也会被定位。复用快照与解析缓存，不消耗新文件读取预算、不重新解析。这条只影响有对象的问句（十问里的 1/4/6/9），无对象的六题
只有一趟、没有冻结可修；两个缺陷各管一半。

**3.14 查询内区分度与片段证据贯通**（已接，D-153–D-156）：

1. **检查点一（已接，D-153）。** 每次调用建一张查询内词组权重表：\(N\) 与 \(df(g)\) 都是本池去重文件数；覆盖三态
   （完整 / 下界 / 无法判断）跟着权重走；完整且稀有才加 \(\ln\frac{N+1}{df+1}\)，截断词不拿未经证明的稀有奖励。
   `details.distinctiveness` 与 `details.windows` 可见。观察脚本区分「正确窗口从未生成」与「生成了但没被选中」，
   并排除自身问题文本。
2. **检查点二（已接，D-154）。** 同 tier 比较加权覆盖 \(L(f)\)；`roleFit` 退到其后作有界偏好。how 问句不因摘录包已满停读。问题 4/6 预期仍不翻转。
3. **检查点三（已接，D-155 / D-156）。** 同一张表进入局部选择与打包；内容词不再拿完整对象档；定位题已有直接答案时
   `offTopic` 不再展开或填正文。多词邻近性仍留到下一次观察。
4. **验收补项（已接，D-157）。** 关系证据相当时生产路径优先必须用**比较**表达：`roleFit` 只作有界偏好时，写着同一个
   `register(...)` 的测试夹具会压过生产注册（问题 1 首条一度是夹具），因为夹具总能在加权覆盖上赢。观察字段不得进生产
   载荷——`details.windows` 改为 `traceWindows` 按需开启。量具补第三态：大单元正文按签名 + 命中块组装，所需证据可以落在
   已选中单元的 `omitted` 区间里，那既不是「未生成」也不是「未选中」。

**后续工作的观察依据**：命中驱动的正文组装曾省略没有查询词的机制行（问题 5 的 `links.push`）。D-165 已增加 focusRanges
接口；当前单元的相关性与最终原文一致性由 3.15B 收口，继续调整词法权重不能代替这项工作。

### 3.15 快速查询：语义决策、召回与呈现（D-173–D-175）

旧编号 ①图到达理由、②共享文件角色、④focusRanges/三字段接口已由 D-163–D-165 接入；下面 A–D 是其上的剩余工作。
请求保存 question/anchors/paths 与可确认的显式要求，规则核验具体事实，取消建设通用 `AnswerRequest` 充分性解释器。
算法与向量消费者继续收敛，同时由 D 接入 LLM 的局部语义判断；两类工作共用请求/当前单元契约，不等待扩散模型或新的索引表示。

**共同查询上下文。** 随第一条真实模型链路接入短生命周期 Host 查询状态，保存 actor/范围、原问题、开始时输入来源、已读快照、
生产任务、候选视图、预算与结束状态。pi-host 使用当前模型绑定执行并提交计划/选择；内部阶段可追加表达、取候选视图及结束/取消，
公开仍为一次 explore，不建持久会话或通用框架。阶段 RPC 沿用查询来源而非重新读取 getInputContext，保留写入终结旧草稿规则；
取消从工具/bridge 传到 Host 查询与模型，公开工具调用结束或所属 worker 关闭时清理，单个阶段 RPC 返回不清理整次查询。
共享后台索引不受影响。所有阶段共用本轮截止条件，旧响应
不能更新已结束查询。候选视图/选择携同一查询身份与修订，复用既有 actor/路径授权。这是 A–D 的执行边界，不独立排成大型前置工程。

D-189 已收口后端作用域：显式 paths 先取 Router 已授权的 workspace-relative 身份，查询 start 固定的 effective roots 再贯穿图符号与语义向量召回；图在评分/截断前过滤，reverse importer 在每 seed
截断前过滤，语义用 scope 内 block anchors 做精确 Top-K。`.` 或空 roots 继续走未受限语义快路径，作用域 block 身份首次惰性建立、文档发布/删除增量维护。

**A. 明确导航与开放候选各归其位。** 明确要求的路径/定义/连接关系直接读取并核实；普通名字出现或关联边不等同于精确导航。
开放候选取消来源 tier，采用去重后的真实来源排名融合，沿用 RRF 的现有 k。来源内同分并列，多块/多变体不重复投票，路径
只作稳定输出顺序。没有相关性排名的图路径不伪造词法/语义票；图提供明确目标时走导航，其余关联保留为探索线索。
验证纯语义第一候选能跨过弱 import 线索、多个同源块不增票、用户明确导航仍能直接取得目标。改动落在候选与读取入口，
不以扩大读预算替代排序修复。

**B. 当前单元选择与一次呈现一起交付。** 为 D 的 LLM 判断或 3.16E 的重排提供最终挑选/排版前的当前单元/视图；模型输入预算
独立于主 agent 的可见输出预算，先去重正文与视图，再按实际模型容量提交竞争候选，未提交者记为未评估。模型未参与时复用 A
的来源归并，但只用当前单元上的词法/语义依据；文件得分不广播给每个窗口，旧正文实质变化后不沿用旧相似度。保留无查询词
的语义 focus，以及同文件不同机制。LLM 输入提供视图/范围 ID，输出可组成互补材料并指定必需范围；Host 验证模型实际看过的
来源与范围，不能据此声称语义正确。原文与展开选项、材料组、去重及真实 UTF-8 预算共同决定呈现。必须保留选择依据，装不下
则改用仍含必需范围的视图、放弃材料组或报告缺口，formatter 不再事后裁掉依据；不预设固定机制模板。
删除 `windowScore` 拼盘：显式范围归请求，局部核验归事实，重复归去重，字节归呈现，不另造同样的加分器或等待 reranker。
最终呈现记录驱动正文、省略提示和观察工具；验证零词汇重合的机制正文可见、同文件互补范围保留、截掉的片段不算已交付。

**C. 来源完成即可推进读取。** 区分评分来源家族与候选生产任务：原问题检索、已启动的查询计划及后续搜索、明确导航各按真实
任务状态登记，多个改写不增加保留额。在既有读取预算与常规批次内给在飞主要任务保留首批机会，其余按当前排名先读；空、失败、
取消、截止或返回已有正文时释放，复用新增 focus，不为公平补读弱文件。后到来源更新待执行队列，不为每路保证输出名额。
首批机会处理/结束后冻结候选视图批量判断；本轮预算也可提前收口等待，给判断与呈现留出执行时间并报告未完成项，不能变成新
的必须等齐屏障。模型在飞时的新增材料仍为未评估，需要时增量比较，不每批到达各调一次模型。明确导航取得原文即可返回；
开放问题按来源结局、读取/补查进展与本轮截止条件结束，不把词法命中、limit 满或模型说“够了”当全仓充分性证明。用可控
慢来源验证早期读取、机会释放、候选视图、取消及结果冻结；不新增固定秒数、文件配额或循环上限。

**D. LLM 搜索计划、成组选段与局部补查（D-174–D-189，已交付）。** 消费已有 models.explore 槽位，在 pi-host 中复用当前会话的
ModelRuntime、provider/凭据及取消路径，接入真实 explore 工具执行，不新建长期会话、Thread 或另一套模型设置。
查询理解输入原问题、锚点/范围和已有仓库词汇，输出行为目标、概念分组表达及预期材料；模型对行为与所需材料的理解仍为推断。
Host 实际执行新表达；
组内扩展、跨组支持可以影响词法源内名次，不强制 AND，不丢单组强线索，不改原问题/范围或原词区分度计数。原问题词法、
可用语义和明确导航与模型并行，不等模型完成才启动原始搜索。已有目录/入口和已返回锚点正文提供词汇，不等待全仓摘要。

候选判断输入 B 的当前正文、视图/范围 ID，与原问题、曾尝试的假设分开呈现；允许否定查询阶段猜测，不积累一段自我强化的
推理历史。输出选中的材料组、必需/辅助范围、互补用途与缺口，不要求全池数值评分或最终分析。Host 验证来源和实际可见范围，
提取原文；无查询词的机制仍可被选中。首版提供可选局部补查阶段：缺口须指向已读候选/范围，表达保持原问题与范围，批量去重
执行；明确短定义直接补充，需要语义比较时只处理已选与新增材料。阶段不是永久一次硬上限，无新材料、预算用尽或需要开放
调查时返回限定于已读材料的缺口；不重跑完整候选池或内部自主研究。

两处按实际需要调用：纯导航省掉不必要步骤；已知文件但问机制时先读再判断，不能因有锚点就省略语义；开放自然语言入口未知时
直接使用查询计划，没有当前正文不对空候选调用判断。LLM 与专用 reranker 共享正文输入但不伪造相同输出契约，同批不默认串跑。
真实槽位已配置就按此路径使用，未配置/失败时保留算法和向量结果并说明模型未参与；不回退主模型，不等独立评测或后训练。
验证真实 Pi 工具→模型请求→分组表达执行→当前材料组选择/补查→必需原文呈现，以及未展示的正确候选不会被旧打包器提前
丢弃、非法 ID/范围、阶段间来源变化、取消和失败。工具描述与示例同步更新。真实问题看首轮关键原文、后续定位往返和整体
等待；按需要观察局部阶段贡献，不跑固定全组合，不把单次生成速度当查询延迟，也不另建大型评测框架。

A–D 已由 D-176–D-189 接入同一引擎与公开工具。不把 3.16 的索引/远程优化做成模型启用前置，也不依赖 3.16B 的后台远程绑定。
保留既有来源、路径、修订与 OutputStore 正确性测试。十问用于回归，必要时加入真实新问题；不先建设完整评测项目，
也不从后续 read/edit 自动学权重。真实 `models.explore` 效果见 status，本计划不把它写成已观察。

### 3.16 嵌入后端、索引与覆盖层（D-173）

本地索引身份/代际库/部分可查已有 D-166–D-169，召回接线与真实本地运行已有 D-170–D-172。下面区分已有工作收口与新的
生产接线；配置、向量缓存、前台优先、重排及 overlay 均不能由 helper 或 UI 字段推定完成。

**A. 收口现有性能与发行修复。** 已提交：`37b12e8e`、`8752e039`（真实批推理、切块尺寸查找、存储增量计数/批事务与中断恢复、
模型配方固定修订、构建准备和 Electron 实际加载 smoke）。完整冷扫时间仍未量得，不能把部分语料或中断扫描外推成全仓性能。

**B. 已接线（D-190 / D-194–D-195，默认发行方式由 D-288 更新）。** 调用边界：Settings `harness.embedding` → Host `settings.get` 与 Pi binding describe（无密钥）→ 确认未配置且用户已安装本地组件才走 MiniLM；
配置后 `createRemoteEmbedder` → workspace `harness.embed` → Pi `BackgroundInferenceRuntime`（workspace worker 的
隔离的 user/operator 配置 ModelRuntime / 用户 `auth.json`）→ OpenAI 兼容 `POST {baseUrl}/embeddings`。Host 提交已授权正文、用途、批次和绑定。空间身份
由 protocol/provider/model/maxTokens、去凭据 endpoint/API 配置身份和最终实际维度命名；自动维度由首个真实输入解析，不持久化 `auto` 空间。知识库召回在 2.8 / D-196
复用同一 `harness.embed` 绑定，向量写独立代际目录，不改权威 `.tdb`。

**C. 已接线（D-191）。** 复用键为 space + purpose + 实际 embedText；查询缓存不绕过 D-189。调度器一次一批，当前批结束后
前台优先于下一批后台。冷扫等本轮第一个兼容发布后再查 partial。远程不套用 MiniLM 512；超长单行续切。Node ORT
`intraOpNumThreads` 写到真实 session。`publishToken`、扫描结束对账、checkpoint 恢复。向量缓存按字节软预算淘汰，不拒绝查询。

**D. 已接线（D-192 / D-194–D-195）。** `pinSemanticQueryView` 固定发起窗口的草稿；对应路径立即遮蔽磁盘向量。
缺向量报告具体 gap，不读旧磁盘、不把缺向量写成缺正文。已捕获草稿的向量建设由 workspace runtime 在后台完成，结束查询不反复取消建设。
活跃隔离线程查询自身物化目录的 Documents workspace，父分支的后续变化不会进入。增量写入和冷扫使用相同的文件筛选，`copyIgnored` 不自动扩大语义语料。仍走 scoped Top-K。

**E. 已接线（D-193）。** 调用边界：`explore.query.finish` 在 select 为 `skipped`/`unconfigured` 且 `harness.rerank` 有效时
→ Host `harness.rerank` → `POST {baseUrl}{endpoint||/rerank}`。select 已 used/failed/cancelled 则不调用。失败保留来源排名，
details 标明 rerank 状态。输入是 3.15B 当前 view；没有 provider tokenizer 时按字符长度估算，超预算 view 不参与评分；该估算不保证满足远程 tokenizer 的限制。

**身份与当前性纠正（D-194）。** Host 装配改为 workspace-keyed，Pi provider 权威限于 user/operator 层，内部 inference 方法从
公开 Runtime surface 移除并增加显式 batch cancel。远程空间在实际维度解析后才稳定命名，并包含去凭据 endpoint/API 配置身份；
设置变化启动新空间扫描。扫描核对当前 revision 后才解除旧行 mask，读失败保持 gap/incomplete。活跃 isolated child 直接查询自身
Documents workspace。rerank 超预算 view 不截断冒充原 ID，finish 冻结配置且终态无二次 HTTP。

**生产装配与原生写入（D-235）。** Application Host 与公开工具纵切共用 `WorkspaceSemanticRuntime`，统一 Settings/describe、
workspace 推理传输、固定查询视图、配置订阅和关闭。成功的 Pi 原生 journal after 在工具答复前通知执行工作区语义索引；后台
重建不等待本回合 settle。验证覆盖真实 SessionHost 的 embedding/rerank HTTP 适配与 Documents，具体证据范围记入 status。

**本地组件发行（D-288）。** 主包和普通构建不准备模型或专用推理运行库。设置中由用户主动下载或导入独立平台组件，验证完整性与真实推理后启用；安装失败/取消不替换已有完整组件。未安装不发起本地扫描、下载或原生模块加载。基础安装的启动/词法/结构检索与可选组件的安装/推理分别验证，发行流水线发布独立组件资产，不把可选能力变成基础安装等待。

工作区仍是包含陌生文件的范围，注意力只改变建设顺序。真实 provider 延迟、质量、成本和完整冷扫时间未观察。扩散模型/
后训练、全仓生成式摘要与零样本路由仍留后续。知识库语义召回已按 2.8 / D-196 单独接线，不与代码语义 MiniLM 回退混写。

### 3.17 bash 输出压缩：按命令分派（D-160 / D-197 / D-199）

已接线前四类：vitest、tsc、eslint、git。Host 在 `shell.exec` 与增量 `shell.read` 上整理默认 `display`，原文仍进
OutputStore / 后台 buffer；显式分页读原始字节。`tool_result` 只对实际取得 Host 整理结果的默认展示免于再次头尾切；旧 Host 未整理结果保留通用截断。
解析器只收起明确的成功/重复噪声，未知正文、pretty 诊断、失败位置、分片续文与提示保留。混合输出不能可靠归属时用通用展示；超预算保留可读首尾与省略事实，不能只剩提示。
包管理器通配已接（D-241 / D-247 返工）：`npm`/`pnpm`/`yarn`/`bun` 头归类、脚本回显识别内层工具、exec/dlx/x 未知二进制走 generic、唯一 warning 保留、failure-relevant 噪声不折叠、非零退出时失败解释行进 required。其余两层
（声明式规则、附加模型总结）未做。**不用小模型总结替代**（漏一个失败是静默的）；模型总结只作非结构化输出上的附加，
且要明确标注"这是模型挑的行，不是全部"。

### 3.18 任务线程、定向协作与连续交付（D-285 / D-286 / D-287；3.18A–E 已实施并验收收口）

在D-284的Pi请求/历史接缝上推进，沿现有Thread/Run、WorkingState、Integration与broker完成，不新建永久团队、消息审查模型
或通用DAG产品。主线亲自负责全局设计和关键实现/验收；派发能独立推进的工作或不同解法，成本判断不变成派发前填表。

#### 3.18A 普通派发、预设与Run配置（已实施）

- 同步protocol、pi-host工具、Host服务与UI：dispatch以task为核心，preset可选；普通线程明确使用发起者当前模型和获准的
  普通能力。专用预设沿现有槽位或明示inherit，不配置不冒充可用；去掉固定便宜/强模型标签与按角色强制shared的绑定。
- 写入任务默认独立WorkingState，shared显式选择。上下文、工作状态和执行配置分别表达；冻结实际model/tools/permissions/
  scope/config generation到Run，Thread仅投影最新配置。只读转实现可在同Thread新Run进行，必须由Host授予实际能力。
- 保持已有嵌套授权、固定基线、级联删除与结果引用；更新Thread manifest旧消费者、恢复/出队/归档路径，不能只让工具role可选。

验收普通零配置派发、显式预设/未配预设、同Thread更换执行配置和权限继承；普通任务获得真实结果，不靠schema解析通过宣称接线。

#### 3.18B 输入起点、继续与fresh（已实施）

- 新线程task默认，inherit显式：固定派发时当前实际输入（已提交摘要+保留原文），把子任务加到尾部；queued不能后读父未来
  状态，未完成派发/其他工具不冒充已执行。依据Pi消息配对接缝构造，输出引用按新会话实际权限/存储重绑或复制合法正文。
- settled实现线程收到明确执行请求时新建Run并恢复选定结果/工作现场，不只放开send状态检查；活跃线程的信息投递不新建Run。
  同一相关工作continue，旧背景大半过期fresh，无关任务新Thread。用户/派发者选择，模型可提出重建，不按TTL/轮数强制清空。
- fresh消费2.6A的输入构造：当前任务/约束/规则、选定成果、未解决问题、活动动作与历史入口；保留已有工作delta/结果/转录，
  不重新总结全部旧历史，不要求额外模型调用。新的背景与执行配置就绪才切换，失败/取消不丢原现场和待处理消息。
- UI“查看历史”只观察，“继续工作/重建上下文后继续”才执行；重开Pi会话与创建实际Run分开，避免浏览完成结果也占名额。

验收任务A刚交付接着修改、同一工作在项目规则/代码变更后fresh、另一任务新建三个场景；确认旧原文可读、当前规则生效、
工作成果不被fresh重置。inherit证据必须来自真实子SessionHost的实际请求，不能只看parentSession元数据或prompt字符串。

#### 3.18C 定向消息与共享执行准入（已实施）

- send支持授权的父子与相关兄弟；from由Host actor生成，目标范围从实际根任务关系解析，不能因同工作区就跨根会话发送。
  inform只投递，request安排执行，replyTo绑定实际请求并完成等待；通知不自动赋予控制/读取对方全部历史的能力。
- 复用既有会话/消息记录接受和送达，待收信息到正常输入边界成批追加。相同消息重试不多起Run；关闭、失联、归档、删除
  都有实际结果。普通确认/致谢无待处理依赖则不唤醒，不靠文字正则或另一个模型决定要不要执行。
- 同根嵌套共享用户配置的委派执行名额，默认12可调。等待依赖的父让出名额，子可运行；答复/结果到达后重新准入。派发、
  dequeue、lost恢复、续做与显式自动review共用准入，不按每个父重新获得一池，不在startRun侧绕过检查。
- wait只为实际依赖/需处理变化恢复，不让每个UI活动触发模型进度检查。执行名额释放不代表会话、后台进程或文件writer释放；
  保留现有物化回收与真实退出边界，不新增内存/目录硬上限。

验收UI线程问Host线程并收到对应答复、inform不启动模型、request续做、跨根目标拒绝、重复交付不重复执行；用小并发预算
证明父等待时子可准入、唤醒后重排、嵌套不乘法扩张。测试等真实事件，避免固定sleep或循环让模型报状态。

#### 3.18D 阶段结果与依赖代码更新（已实施）

- 沿现有Run settle发布R1，父按修订使用，原Thread继续R2；R2运行/失败时R1仍可明确读取/集成。实际代码、材料表、报告
  直接交付，说明服务于使用，不统一塞进极小摘要，不靠主线重新生成成果。
- 新派发依赖任务从选定父状态建立基线；已启动线程提供显式纳入父修订的入口，复用三方Integration与受控物化切换，保留子
  delta与冲突。记录新基线/输入来源，旧结果/验证仍绑定原修订；普通消息和fresh不能替代该文件更新。
- 主线收到影响公共接口/任务方向的决定与产物引用，不读取全部横向对话。普通发现提前发消息，可使用文件则必须发布。

验收同一公共接口R1被主线使用、依赖线程真实获得新字节、原线程继续发布R2；父/子各有修改时条件集成不覆盖；newRun不把
旧验证复制成当前通过。保留现有Rust存储/文件权威，不造任意线程双向同步系统。

#### 3.18E 默认、UI与旧路径收口（已实施）

- 自动review默认关闭，已有显式enabled/gate保留；主动review与现有结果/Run绑定不变。删除每次交付自动追加检查的提示，
  保留主线关键验收和实施者正常验证，不把check强制变成纯跑命令代理。
- UI按任务名/真实成果显示，提供continue/fresh、结果修订、定向问题与来源；原文、状态和费用继续来自既有权威，不做虚构
  进度或财务面板。总效果评价包括实际子调用，不只比较主线token。
- 删除role-required/单向send/永久Thread执行manifest/per-parent准入等被替换路径与重复夹具，按当前内部格式直接切换；
  用户配置、原生Pi历史和工作成果照常保全，不保留双实现兼容层。

最终沿公开生产链走通“普通派发 → 合适背景 → 定向解决依赖 → 交付可用成果 → 主线使用 → 原线程continue/fresh → 再交付”，
并观察独立并行路线能被选择/停止。已有共享场景合并验证，不按本节每句话各建一个test，不要求固定审查轮数或新评测平台。

## 阶段 3b：原生权限唯一权威（D-283，已完成）

当前交付事实：Varin 内置 `tool_call` extension 是唯一交互式确认权威，覆盖 Harness、Pi 内置、MCP、Pi package 与嵌套线程工具。
`normal` / `accept-edits` / `bypass` / `smart`、用户规则、workspace 只收紧和 `permissionJudge` 都作用于这条唯一链；Host 继续只做
非交互 actor/capability/workspace/path enforcement。D-283 完成了以下纵切：

1. pi-host 内置 `tool_call` extension 成为 Varin 会话唯一的用户确认权威。它在会话构造时取得所有实际工具的稳定身份与来源，覆盖
   Harness、Pi 内置、MCP、Pi 包工具和嵌套线程允许集；不能再以“非 Harness 工具”直接放行。Host 继续只验证 broker actor、冻结
   capability、workspace/path scope 与资源 authority，不弹第二次确认，也不替 worker 内执行的工具假装做交互门。
2. 工具装配生成规范化的权限对象：工具来源、动作类别、实际 cwd、命令、规范路径集合、网络目标和子线程范围。Harness/Pi 内置工具
   使用项目维护的明确描述；MCP annotations 与第三方声明只作为输入证据，不能自行授予权限。缺少副作用描述的第三方工具按未知动作
   询问，不能默认当只读。
3. 命令与路径判断覆盖实际选择的 shell、命令组合、重定向和子进程入口；路径在确认前相对真实 execution cwd 解析，并核对规范路径、
   符号链接/reparse 与工作区外目标。不能只靠当前关键字 regex 判断 `rm`、`git` 或敏感文件，也不能用提示词代替解析和 Host path
   authority。
4. 保留现有四种模式与从上到下的用户规则；workspace 仍只能追加 ask/deny、不能放宽用户策略。Smart 只在用户配置
   `permissionJudge` 后参与普通 ask，高影响或证据不完整的动作仍走确定性策略；模型失败回到 ask，不借主模型。
5. “本会话允许”绑定工具来源、动作类别、owning/execution workspace 与明确资源范围，UI 显示将被记住的范围；不能再只按 tool name
   放行整个 `bash` 或未知工具。嵌套线程继承创建时冻结的 overlay，只能收紧；父会话之后切到 bypass 不放宽已运行子线程。
6. 每次 allow/deny/ask、规则来源、规范化目标、用户选择和 policy generation 进入现有 session/Thread 事件与审计投影；敏感正文和凭据
   不进入日志。不新建另一套 permission 数据库或把审计写进模型上下文。
7. 单一 Varin 权限 UI 负责确认卡片、会话授权撤销、模式与规则。完成覆盖后，从 foundational manifest 删除
   `@gotgenes/pi-permission-system`，并删除 session service 让位、permission-system Plugin Settings/quick mode/status bridge、专属 i18n 与
   测试路径；不保留默认关闭、旧配置 reader 或双重提示兼容层。

实现使用 Pi `getAllTools().sourceInfo` 识别实际来源，SDK Harness override 才按 Harness 元数据分类；MCP/package/未知工具缺副作用证据时
进入 unknown/ask，不能借同名 `read` 等默认规则放行。路径证据经 Host `permission.inspect` 复用既有规范路径 authority；shell 解析保持
保守，组合/子 shell 等无法完整归一时标 evidence incomplete，因此不能走 Smart 或 session grant。会话 grant 绑定来源、动作、owning /
execution workspace、cwd、规范资源、网络目标和 thread scope，`/varin-permissions` 可撤销。每次决定经 `permission.audit` 投影，不含正文/
凭据。foundational manifest 已升 revision 3 且只保留 MCP；permission-system 的 service 让位、状态桥、Plugin Settings、Composer quick mode、
专属 i18n 与测试路径已物理删除。公开反例与跨包类型/lint 证据见 status 3b.1–3b.3。

## 阶段 R：Rust 系统内核与 Host 分层（D-252）

目标架构、资源归属和失败语义见 [rust-kernel-design.md](../rust-kernel-design.md)。D-282 已在 R0–R5 各自接管后完成 R6 汇总验收，
因此阶段 R 整体完成。模块迁移后的生产默认只有新写者；TS 保留产品编排、Pi runtime、Document Registry、知识领域和模型/索引装饰层。

| 里程碑 | 交付范围 | 必须接通的消费者与删除的旧路径 |
| --- | --- | --- |
| R0 | **Complete（D-282）**：framed kernel、同源 DTO、epoch/grant、acknowledgement-backed request window、取消/断线/关闭与 release identity | 真实 Host/release binary 覆盖饱和、queued cancel、截断输入、任意 cwd、relocated restart 与 manifest mismatch；Web/Electron/云/VS Code 都从自己的发行目录启动同一 kernel。支持平台的 native build/smoke 是 release workflow gate；本机证据只声明 Windows x64 |
| R1 | **Complete**：format v10（D-280 增 process records）、typed path state、AVL immutable root/trie、revision pin、recordRevision CAS、blob/source authority、workspace/actor-scoped identity、分页 root read、typed recovery 与 GC | Application Host 的 WorkingState、result/draft/verification/review/retrieval/history/materialize/delete 和 combined Recovery/Integration/agent-mutation 元数据均走 Rust root/path/domain/recovery API；TS 不再有生产 compatibility projection 或 SQLite recovery writer。旧实现仅保留为测试 helper。内置 Recovery 固定共用 kernel application-data root，`storageManagement:false`；可替换 provider 的位置管理仍是公开 v5 可选能力。落盘顺序、事务故障注入与重启对账构成 R1 durability evidence |
| R2 | **Complete**：单一 Rust file authority + Host-visible pending-operation disposition | Registry 保持 buffer authority；low-level operationId/path/reason/disposition 可列举并可安全 reconcile，证据不足保留 needs-attention；不恢复 TS writer |
| R3 | **Complete**：fixed baseline + kernel materialization + durable Host/Git/Registry handoff | native operationId/root/writeRevision、persistent handoff pin、Git executionBaseline、Registry/binding 使用同一可重入 intent/receipt；setup timeout/abort 等真实 child close 后才结束；旧 seam 仍仅为测试夹具 |
| R4 | **Complete（D-280）**：统一 Rust PTY/pipe、process tree/raw output/writer authority | 用户终端、Harness shell、Thread setup、LSP/DAP、任务/测试均经实际 native backend；未确认退出/失联保留 writer，控制不依赖输出排空；Host 保留协议与启动取消编排。Pi broker 仍拥有 Pi worker；Git 短命令和 shell 发现留作领域适配，不另建通用进程 authority |
| R5 | **Complete（D-281）**：固定 pin/live revision-bound 文件检索、遍历/哈希、native tree-sitter 结构解析/切块，前后台 lane + 实际取消 | read/grep/find/ls/explore、file find、语言/符号/语义目录建设均复用 kernel compute；virtual WorkingBranch semantic 直接在 pin 上 `unitsFixed`，不跨 Host 搬整分支正文。旧 TS ripgrep/recursive scan、branch corpus/body mirror、Host AST/chunker discovery 已退出生产链；Registry draft、TriviumDB/vector/embedder/Pi/LSP 仍按原领域权威 |
| R6 | **Complete（D-282）**：完整生产/故障验收、受控结构与资源测量、发行更新、遗留实现清理 | Desktop/Web/云/VS Code 的实际 release layout 均带 manifest-verified kernel；Windows unpacked 与 cross-domain surface 纵切已跑。旧 PTY/SQLite authority 发行依赖、TS file writer 和 emitted legacy/test artifacts 已退出生产；当前文档指向唯一实现 |

### R0. 契约、运行时与发行基础

盘点目标模块的入口/写者/持久对象/后台任务，以设计职责表落实模块边界；复用已经存在的公开协议和错误语义。
Rust 内核通过私有进程管道连接一个 Host，生成跨语言 DTO/schema，不复制 Pi provider/凭据栈。控制与数据流分开，
批量范围/内容引用避免整树往返。actor grant、workspace/execution/storage identity、kernel epoch、request/operationId、
取消/事件/回执均在第一版协议内形成可执行契约；不靠后续补一层“安全包装”。

真实 Host 装配需验证启动、协议不匹配、损坏帧、背压、取消、关闭和内核退出后的状态。Windows/macOS/Linux 的仓库发行
target 从此步开始构建，不把二进制打包、Node/Electron 协同和许可证检查留到最后才发现。R0 只标运行时基础完成，
尚未迁移的功能保持原生产所有者。

D-282 完成本节。握手发布 `requestWindow`，Host credit 只在 Rust 响应/断线时释放；blob chunk、branch builder 和普通请求共用
acknowledged request window，cancel 控制帧可在数据背压时到达。重复 request id、超窗发送、坏帧和截断输入结束本 epoch，关闭先等
已准入工作，再发 shutdown 或关闭 stdin，不把未确认工作报成功。真实 release smoke 从任意 cwd 启动，核对 build/target/arch/hash，
复制到另一安装目录后用新 epoch 重开同一 v10 catalog；坏 manifest 明确拒绝。Web、Electron、云和 VS Code 分别携带自己的 kernel+
manifest，支持平台由 native runner 构建，不需要客户端安装 Rust。

### R1. 工作状态与恢复存储接管

沿现有 SQLite + 内容对象库建立原生存储。WorkingState 根/修订、结果/草稿、节点、对象所有者和 recovery operation/checkpoint
在同一存储事务域发布。不可变根成为真实内存/持久入口，单路径写直接更新受影响索引页；宽目录不整表复制。
树哈希保留完整 mode 等声明字段，与平台磁盘比较分开；损坏/缺节点/循环明确失败。对象先耐久，事务再发布引用，
pin/GC/并发发布保证可达正文；不每次更新重写整个 JSON/node pool 或扫描全部历史。

Rust 接管同一 storage location 的所有元数据 writer，TS storage adapter 只调用领域操作。在活动写者退出后切换代码，
直接初始化唯一的新内部格式、重建夹具和派生数据；不导入旧 WorkingState/catalog/恢复元数据，不实现旧格式转换阶段机。
需要保全的实际工作成果先作具体交接；跨 Thread catalog 的正常发布/释放仍有持久意图与幂等确认。
尚未迁移的文件编排通过新 storage adapter 工作，不直接连 SQLite；分支写 gate/CAS 随分支权威一起迁移。

验证真实 Host client→Rust→重开后的分支读写、跨分支 sharing、mode/字节身份、固定查询、CAS 冲突、pin 与 GC 并发、
新格式发布关键窗口故障，以及旧实现/数据移除后从新库启动。复用本轮反例；节点数/读写字节从生产调用计量，不能仅测一个 trie helper。

本轮 D-274 完成了 D-273 要求的生产切换：catalog/握手格式统一为 v9；WorkingState 所有生产 consumer 使用 root/path/domain API；branch metadata、draft/result/verification/review 与引用释放由 Rust 事务绑定；combined Recovery/Integration/agent-mutation 的唯一耐久元数据 writer 是 Rust typed recovery，所有 phase/terminal 调用被等待，文件或 Registry 副作用发生在对应 CAS 之后。旧 WorkingState 与 SQLite recovery engine 只保留为测试 helper。D-275 进一步收口 storage location：内置 Recovery 与 WorkingState 共用 kernel application-data root，不支持独立 relocation，UI 按 `storageManagement` capability gating；replacement provider 的公开 v5 storage management 保持可选。R1 的 durability gate 以落盘顺序、故障注入和 restart reconciliation 为准，跨平台 package smoke 归 R0/发行 CI，签名不是当前产品硬要求，物理断电 campaign 留作发行 QA。R1 因此完成，R2–R6 不变。

D-266 已把 Rust crate 的进程入口、transport 与存储领域实现分开，并用一个授权 dispatch 限制 runtime 可见面；它不改变
R1 数据格式或消费者状态。后续 R1/R2 直接进入对应 `storage/recovery.rs`、`storage/branches.rs` 和新的文件资源模块，不能再把
领域实现堆回 `main.rs` 或在各模块自行打开 SQLite。

### R2. 文件权威、Documents 与恢复事务

迁移 canonical 文件资源、路径 gate、磁盘 before/after、三方计划/应用/条件补偿及启动对账。
完整接入 Documents 保存、Files CRUD、原生工具 mutation、Integration、恢复 provider 和内部文件消费者；
尚未迁移的 Git/进程 adapter 向相同资源服务登记写者，不保留另一个决定“可写/可回收”的 TS gate。

surface 权威留在 Registry，Rust 维护混合操作的 operationId/intent/回执阶段，Host 定向执行 Registry CAS/grouped undo。
等待外部回执不持数据库事务或形成反向锁等待；断线/迟到不得伪报完成，surface 无正文不能改写磁盘。
恢复仍是受影响路径变更集，不把 Rust 捕获能力用于普通回合全仓快照。

验证公开 Pi edit/write/apply_patch 与真实 Documents/Registry，磁盘/草稿混合、编码/BOM/换行、用户后写、
缺回执/取消/进程重启、嵌套 branch/directory merge 和恢复导航；实际 Rust 子进程必须参与。

D-276 已完成本阶段生产接管：kernel `fileResources` 注册 Documents-authorized canonical execution root，负责 exact/subtree lease、稳定 file state capture、内容对象安装、条件 apply、mkdir/remove/rename 以及 side-effect 后 terminal 丢失的 restart reconciliation。Documents write/move/delete、workspace-scoped Files CRUD、Recovery/Integration disk apply/compensation 和生产 `fs.lock` 使用该同一权威；Registry 仍拥有未保存正文和 grouped undo，Host 只在 kernel intent/file phase 已持久化后定向执行 surface 操作，等待 Registry 回执期间不持 SQLite transaction。

Varin 模式的 Pi `write` / `edit` / `apply_patch` 先走 virtual `document.branchWrite`，disk/surface target 统一由 `document.surfaceWrite` 进入 Host Documents；Host mutation backend 不可用时明确失败，不再退回 pi-host 本地 `writeFile/rm`。WorkspaceAPI/Git/bulk/external adapter 尚未迁移其领域实现，但在执行时向同一 kernel exact/subtree gate 登记 writer；这满足 R2 的 single-gate 要求。D-278 曾因 low-level pending operation 处置缺口重新打开 R2；D-279 通过 `file.operation.list/reconcile` 与真实 restart audit 关闭该 gate。R4–R6 不变。

### R3. 基线、物化与资源生命周期

Git 与非 Git/unborn 共用固定根、受管目录及执行世代；保留 dispatch 时捕获、草稿优先与 frozen captureScopes。
Git 的 base/result 属性、执行 baseline、LFS/filter/EOL 和真实 index mode 各有身份，不静默吞过滤器错误。
虚拟→物化的 staging/切换/重启、shell 写回发布、原路径重建、普通复制/真实 CoW 与空间事实全部迁到同一内核。

Thread/Run 与级联产品策略继续归 Registry，Rust 提供可重试资源操作；会话/知识清理由各领域 adapter 确认。
archive 保留引用；history release/delete 先核依赖和真实写者，再释放根和清理目录，返回阶段化结果。
旧目录、未知进程、未收集内容不得因换格式而获得删除许可。

验收 Git/非 Git/无 HEAD、queued/nested/virtual+shell 两阶段编辑、固定结果后 live 变动、filter 配置、
共享引用删除、回收恢复、目录占用和 ENOSPC/中断。实际 clone 与普通 copy 分别报告；未测文件系统不能称已证明 CoW。

D-277 已接入本阶段主要原语和生产消费者；D-278 重新打开整体完成度，具体缺口见 [审查记录](../rust-kernel-audit.md)：WorkingState baseline 的 filesystem inventory/body capture 改由 kernel `file.scan` / `file.capture` 完成，且使用 Host-admitted root 与创建 branch 的同一 scoped grant；Git 继续提供 staged/unstaged/untracked、index mode、dirty-content identity 和真实 filter/EOL 语义。完整 capture 后重读同一路径集合，Git/目录 inventory 与 frozen captureScopes 也在窗口两端核对，变化时不发布混合 root。

virtual→materialized 使用 kernel `file.materialize` 从固定 root 构建 operation-specific staging，校验对象后执行真实 clone backend 或正式 copy fallback，以 backup/promotion + restart reconciliation 切换 execution generation。Git 只附加 linked-worktree metadata，并经 `read-tree`、`add -A`、内部 baseline commit 建立执行 Git 身份；required filter 失败直接中止，不把 TS copy 当退路。materialized settle 由 Git changed paths + prior/current captureScopes 或非 Git完整 Rust inventory 发布 immutable result root；native archive/history 不再依赖旁路 snapshot。reclaim/discard/delete 走 kernel subtree remove 并 prune linked-worktree metadata；`file.measure` 在 Unix 使用实际 block 计数，Windows 未有已验证 physical-allocation backend 时明确返回 unknown。Windows release-kernel 的 scan/measure/materialize 与 live-backup-before-promote restart 反例已通过；Windows 当前只证明普通 copy，未测文件系统不称已证明 CoW。D-278 当时据此只承认原语和部分消费者证据，并要求补跨域持久 switch、真实退出/回收交接。D-279 已补齐该 gate：Thread Registry 先持久化固定 root/revision/writeRevision、operationId 与 pinId，kernel persistent pin 保活固定源；materialize 和 Git attach 各持久 receipt，同一 operationId 重入；git-attached receipt 在 pin release 成功前不会清除，setup timeout/abort 等 child close。R3 因而完成；R0 与 R4–R6 不变。

### R4. 进程与终端底层

Rust 接管现有 terminal runtime 实际进程，TS 保留 UI/API/命令整理/Zone 2 adapter；Agent 与用户仍附着同一 handle。
stdin/resize、输出原字节/游标、自动后台、退出码、终止与 writer 释放均由实际进程决定。外部 LSP/DAP/任务/测试
采用同一通用进程服务；Pi session/catalog/inference worker 的会话与协议生命周期继续归 runtime-broker。

接管发生在实际进程生命周期边界，不把 PID 当可移交 PTY。Host 或 kernel 崩溃后，按平台进程证据处置遗留进程，
不重放命令、不在未知状态回收目录；恢复新 epoch 后旧 handle 不复用。用户 shell hooks 与现有 OSC 命令事实不退化为猜测。
验证本机真实 shell、UI attach/输入、后台自然退出、停止失败、Host/kernel 单独退出、LSP/DAP 流和已有任务消费者。

D-280 已完成本节生产接管，消费者与 native failure evidence 见 [唯一状态记录](../agent-harness-status.md) 及 [process ownership](../../packages/web/application-host/lib/process/DOCUMENTATION.md)。kernel 使用同一 executable 的 guardian 隔离阻塞 I/O/进程树；guardian 不开 SQLite，唯一 Storage 保留 durable identity/tombstone。Window Job、Unix session（Linux subreaper）提供实际生命周期证据；未证明旧进程退出就保持 unknown。不存在 Node/Bun PTY 生产 fallback，也不把死亡会话重启成另一个 shell。进程作用域与 R2 file gate 共用物理目录边界。

R4 不声称新增恶意代码 OS sandbox，也不要求用户本地其他平台/签名/物理断电。旧分发依赖与 rebuild probe 的移除、完整 packaged smoke、受控多进程性能仍按 R0/R6；已定义的短命 Git 语义命令和发现/bootstrap 探测不因此迁成第二套 Rust 调度器。

### R5. 文件与结构检索计算

用内核 pin 直接执行固定视图范围读、枚举、搜索、结构解析/切块，scope 在候选选择前约束。
前台请求与后台扫描分开调度，取消到达实际任务；图/语义提供线索，原文依旧绑定实际 revision。
复用 rg、tree-sitter 与已有原生计算，不为 Rust 重建搜索算法、TriviumDB、向量库或 ONNX；
图/向量库继续经已有 TS adapter 单写，LLM 计划/选段与远程推理继续经 Pi。

生产消费必须覆盖 read/grep/find/ls/explore 及索引输入，不只给新工具加一个旁路。
验证父 live 漂移、草稿覆盖、嵌套 view、scope、查询取消/partial/终态、结构批量传输与后台负载下前台响应。
删除对应旧扫描/解析/缓存路径；跨边界只传需要的记录/范围，不传整库。

D-281 完成本节：`compute.start/read/cancel/release` 使用 bounded cursor 和 2 foreground + 1 background worker；immutable WorkingState query 复制短生命周期 reader pin，caller unpin/branch delete/GC 不改变正在读取的 root。live workspace 通过 Host-admitted canonical root 读取并给正文/结构结果绑定实际 content revision，读取窗口漂移只能 partial/failed，不被宣传为 immutable snapshot。surface draft 是 Registry 捕获后上传的 fixed object overlay，ancestor tombstone 在候选预算前遮蔽。`search.content`、file find、Harness grep/explore、language catalog、symbol graph 与 semantic disk scan 统一走该 native boundary；virtual Thread semantic 只枚举 pin 内 path/revision，tree-sitter `unitsFixed` 在 pin 上直接产生结构 unit，再由 TS tokenizer/embedder 装饰，不再复制整分支正文到 Host。Host 保留 grammar 安装 ABI 校验与 LSP 协议，不把它们当第二套 workspace parser；TriviumDB/vector store/remote inference/Pi 归属不变。R5 因此 Complete；D-281 当时不改变 R0/R6，二者随后由 D-282 收口。

### R6. 完整验收与发行收口

采用已修正并验收的 TS 基线，同机同语料区分冷/热，测端到端耗时、写放大、Host+kernel+Pi 总内存与资源释放。
复用现有观察脚本，记录语料/文件字节/并发和节点/存储操作计数，避免把算法修复、缓存预热或省略耐久写当语言收益。
性能目标按设计第 8 节：已有根操作不扫描全树、增量写不改无关状态、后台计算不阻塞前台；具体延迟/容量根据证据定标。
结构回归和系统性性能退化必须解释并处理，不要求付费模型或独立研究评测才能验收。

从真实发行目录启动 kernel，验证更新/退出、数据位置接管、Host+kernel 重启、文件与 shell 公开纵切；覆盖仓库支持的
平台构建，真机证据按平台分别登记。移除全部已接管的旧 TS writer/重复状态/临时桥接，模块文档记录唯一调用链。
现有薄的公共 API adapter 是架构组成，不因“清旧”误删。R0–R5 的消费者、故障和资源证据齐备后再把阶段 R 标成完成。

依赖关系：R0 → R1 → R2 → R3；R4 在 R0/R2 的身份与 writer 契约确定后可独立推进，R5 依赖 R1/R2 的固定视图。
R6 汇总所有里程碑并完成发行验收。并行不能让两个任务各改一份共享协议/存储权威；共同契约由一个整合者负责。

D-282 已完成本节。`scripts/measure-kernel.mjs` 对固定语料和 D-280 后/R5 前的 TS 产品路径做交替顺序的冷/热对照，记录语料 hash、
脚本/kernel identity、事件循环、分阶段 RSS、root 节点、WAL 文件长度变化与实际取消；结果见 status，不从瞬时 RSS/WAL 长度推导物理
写放大，也不把结构解析或 inventory 的额外成本藏掉。`smoke-kernel-release.mjs`、Windows unpacked smoke、VS Code native-search smoke
和云运行时 verify 脚本都从发行树运行，覆盖重启、固定 root、文件条件应用、结构读取、shell 退出与句柄释放。

生产依赖已删除 `node-pty`、`bun-pty`、`better-sqlite3` authority 与 Electron rebuild 脚本；TriviumDB/sherpa 仍按各自领域的预编译
binary 验证。Application Host build 会对 emitted import graph 做运行时可达性审计，拒绝可达的旧 store/test helper，并从发行树删掉不可达
测试/旧实现；源码测试 helper 不构成生产 fallback。Document Registry 关闭等待最后 journal/owner release，Web/VS Code 的 surface operation
事件不再被 watch adapter 丢弃。R0–R6 均完成，阶段 R 的下一步是使用与优化，不再维护迁移待办。

## 阶段 4–6：既有默认 runtime 与后续领域

- 默认 runtime：直接交付 bundled Pi、Runtime Manager 默认选择与 Git Bash 就绪说明，保留自有 runtime；实际 Electron smoke。
  已有版本依赖明确，不等 harness 全部完成。
- 外部 runtime：排在 D-283 的原生权限与 web 收口之后；届时按实际 Host 服务接 MCP/ACP/能力协商，选定 adapter 的协议版本在实现中完成，不先预建全部未来兼容框架。
- research/文件知识工作：以 [科研集群设计](../research-cluster-design.md) 为准，沿共享工具、存储、文档、线程、调度和验证器实现
  异构模型并行研究。首个纵切从开放计算问题开始，包含问题发现、文献/代码调查、实验设计、快速执行、自然交流与综合和写作回流；
  论文复现只是场景，不先建设科研管理表单或第二套 Agent runtime。工作台 UIUX 和 Agent 工作侧重独立；科研消费者发展公共接口，不要求先交付办公场景。
  SaaS 连接器与 Windows 沙箱保持范围之外。

默认 bundled Pi 的已交付路径保持。阶段 R 已由 D-282 收口；外部 adapter 和新领域 profile 使用当前 Rust kernel/TS Host 边界，
不另建一套资源、存储或进程后端。

## 阶段 Q：测试与 CI 体系重整（D-292，已验收收口）

设计权威为 [testing-ci-design.md](../testing-ci-design.md)，现状审计与处置结果见 [testing-ci-audit.md](archive/testing-ci-audit.md)。本阶段覆盖全仓；其后 D-296 已收口，再开始 AI4S 的 7A–7F。
先建立整体判断，再分责任完成修改；不得把它交付成只修近期几处失败、只删源码断言或只移动 workflow 的局部补丁。
当前状态是 Q0–Q3 已实施并经主代理验收收口（D-293/D-295）；D-296 已完成原 VS Code
companion 的完整退役，故它不再是当前 required CI 或手动入口。以下编号保留为实施记录，不构成每次
日常开发都要重复的检查流程。

### Q0. 全仓现状、责任和目标结构

1. 从当前 tracked 文件、各 package scripts、runner 配置、Cargo 与独立 smoke/workflow 入口建立测试家族与执行关系。
   覆盖 UI/Web/CLI/Electron/Mobile、Pi/broker/client、protocol/settings/extensions、kernel、构建/部署脚本；
   排除依赖和产物副本。统计测试文件与实际发现/执行集合时分别标明口径，不用 grep 出来的声明数量冒充通过用例数。
2. 复用近期 CI 日志，定位时间集中项、重复运行/构建、失败和未执行入口。对代表性慢测试、易碎测试与关键正确性链读取
   完整装配和消费者，区分产品问题、测试问题、环境故障。不能仅按 `mock`、`readFile`、文件长度等关键词判定删除。
3. 按能力列出简短处置：现有证据层/入口、保留或删除/合并/替换、受影响消费者和未知。以模块/测试家族为粒度，放在本节
   实施记录或所属模块文档；不维护几千行用例台账，不要求每个测试新增标签或决策号。
4. 确定目标套件职责和构建依赖图，再进入 Q1/Q2。根 scripts、共享 fixture 和 workflow 的修改由同一整合者负责；
   模块内清理可独立推进，但不能各自新增一套发现机制、重复入口或相冲突的测试基类。

交付：每个维护领域都有处置结论和真实入口，成本基线标明提交/环境/范围；已有证据足够时直接推进，不为清点先全量重跑。
原始调查见设计 1.1，只作起点，不把抽查包装成全仓已审完。

### Q1. 清理无效约束，修正测试行为与装配

按 Q0 的能力分组完成整套处置，先处理高维护成本和错误证据，不以文件数作为工作量或成果指标：

| 工作面 | 具体处理 | 保留的结果保证 |
| --- | --- | --- |
| 源码/清单/历史门禁 | 删除无现行需求的固定条数、workflow 字面结构、旧迁移符号、日期/Git 历史比较；类型/lint/构建边界各归原 owner | 真实协议、依赖边界、文档链接与用户可见契约 |
| 重复场景 | 比较每层新增的风险，同义输入合并，底层详细覆盖、上层代表性连接；删除无人消费的旧辅助实现及专属测试 | 重要行为在正确责任层仍被验证 |
| UI/设置/平台适配 | 优先调用实际投影、处理函数或必要交互；去掉只核对组件源码措辞的证明 | 设置生效、状态呈现、导航与权限等具体结果 |
| Harness/Pi 上下文与线程 | 检查 faux 回复、工具继续、正常/错误终态、provider/会话隔离与释放；关键流程走真实 consumer | 结果归属、上下文续接、取消/等待/恢复不被中间采样冒充 |
| Rust/文件/恢复/进程 | 策略 fake 与真实权威验收分清；退役实现不能替现行生产后端背书 | 文件/草稿保全、scope、CAS、durable recovery、实际进程退出 |
| 构建/部署/发行 | 把重要行为从源码字符串转到产物/运行观察；已有有效 smoke 直接复用 | 内置 runtime/kernel 可用，失败部署可恢复，产物身份正确 |

实施注意：

- 对 Zone 0 等已发现异常测试，先复现正确的输入/工具步数、回复耗尽和结束原因，再修 fixture/断言；不得只提高 timeout。
- 局部时序使用事件或可控时间。真实 OS 生命周期测试继续观察进程和 I/O；资源竞争按实际来源隔离，不全仓无差别串行。
- fixture 只共享必要启动/隔离/清理，默认不用付费服务、真实个人设置和不受控外网；外部兼容性观察单独表达。
- 预期故障显式断言，未预期异步异常/子进程失败不能吞掉。即使断言失败也释放本测试拥有的资源。
- 不要求每个删除项补一个新测试；如果删除会丢失唯一的重要保护，把该行为在同一改动移到正确层即可。
- 为测试便利改变生产接口时，说明具体接缝需求；不得复制第二套业务逻辑、恢复旧 writer 或添加只为测试通过的产品限制。

交付：分组修改可审阅，说明被删除/合并证据的去向与保留的实际行为；针对改变的责任运行必要验证，不每组重复整个仓库。

### Q2. 统一发现与执行，重组构建和 CI

1. **先修执行集合。** 核实 Linux/Windows 对 `test/**/*.test.ts` 的展开，消除相同命令漏根目录文件等差异。
   使用现有 runner 或简单可移植脚本，分别列出公共与平台专属文件；确保 targeted 参数实际缩小运行范围。
   node:test、Vitest、Cargo 和 smoke 不互相误收集，也不扫描构建副本。保留本地完整适用验证入口。
2. **给每项验证一个明确归属。** 处理 kernel 专项与 Web 全包、i18n 与 UI 全包、Electron runtime 与 updater、
   CI/Docker/release 源码检查的实际重叠。不同平台或构建产物的有效独立证据保留，不能仅为减少 job 数删除。
3. **整理构建依赖。** 类型依赖/生产构建/dist smoke 不反复重建相同包；按提交、依赖、工具链、配置、平台/架构复用
   可用产物。先消除同 job 冗余，再判断跨 job 传输/缓存是否值得，不为缓存建设单独服务。
4. **按职责组织反馈。** 快速源码/行为检查、平台运行检查、发行成品验证清楚分工；任务拆分与并发取决于真实耗时和资源，
   不预设三个 job 或整仓切成固定份数。Windows/Linux 不机械重复全部无平台差异的测试，实际平台消费者继续运行。
5. **按依赖选择触发。** 文档改动无需重建无关原生/容器产物；协议/kernel/依赖锁/构建和 workflow 变动扩大到相关消费者。
   不确定影响范围时运行相关完整套件。比较代表性变更实际选择的任务，避免 path filter 漏测或 required check 永久 pending。
6. **让失败直接可定位。** 保留相应子进程退出、stderr 与最小必要日志，区分装配和产品故障，不输出凭据/用户正文。
   当前云首次启动失败等具体问题先取得真正错误，不再仅凭 wrapper 报错猜测、重跑或改超时；确认产品缺陷则独立修复。
7. **衔接分支与发行。** required checks 随 job/聚合责任更新；不得清空规则、使用 continue-on-error 或盲目重试换绿灯。
   发布只复用适用于同一源修订/构建条件的证据，保留对应成品 smoke；不重打或覆盖正在发行的已选产物来混入本阶段改动。

交付：统一且可本地运行的命令、互不重复的执行责任、可核对的发现集合和工作流；相关模块/开发说明同步到实际入口。
Q1 与 Q2 可在责任明确后交错推进，但不得先隐藏未解决失败再把新入口标为完成。

### Q3. 验证整理效果并收口

- 从文档、UI、Host、kernel/共享协议、打包配置的代表性变更核对任务选择、公共/平台集合和产物来源；
  使用 runner 清单、现有提交差异和实际任务即可，不新造永久 CI 元测试框架。
- 对保留的关键行为与已修缺陷取得相称证据。数据、权限、上下文终态、线程生命周期和目标发行启动不能因清理而失去保护。
  一个错误不要求从协议到 UI 每层各补一遍完整复现。
- 与 Q0 对比墙钟、重复构建/执行和失败定位路径；环境或测试范围改变单列。正常重构是否仍被源码文字断言绊住，也是判断项。
  不把缩小覆盖面的时间节省全部算成执行提速，不设置删减百分比、覆盖率和固定测试总数门槛。
- 更新开发指南、模块 README、status 当前证据引用及 plan；退役测试不再作为当前 `proven` 依据，历史决策正文不改写。
  交付报告以保护的能力、清理原因、实际验证和剩余限制为主，不用通过数代替结果。

完成条件见设计第 7 节：全仓各责任已处理，已确认的错误成功/漏执行/无效约束已关闭，关键行为仍有可信证据，CI 的重复成本和
诊断问题已收口。当前重大产品错误不得冒充测试噪声；无关外部服务短暂失败和可选优化不把本阶段变成无限验收。
不要求固定次数全绿、付费模型实验、全量 mutation testing 或新增监控平台。

Q 完成后已实施 D-296；AI4S 直接沿用整理后的职责与脚本，不为科研另建一套验证体系。

## D-296：退役原 VS Code companion（AI4S 前）

D-296 紧接阶段 Q，完成 AI4S 7A–7F 之前的产品边界收口。实现范围是删除 companion 包、开发/构建/打包
入口、companion-only shared contracts，以及当前安装、Marketplace、配置和开发说明；不保留归档兼容副本。
涉及 LSP 包、TextMate 格式、外部编辑器启动或 provenance 的文字按原语义保留，历史 changelog、决策正文
和阶段 R 交付证据不改写。

当前状态：文档与公共入口说明已同步；代码、配置、脚本和发布链已完成。根构建（含 Web
Host+Vite、Electron bundle、Mobile assets）与 built-server knowledge smoke 2/2 已本地通过。未把
packaged、跨平台或远端 CI 结果外推为本地证据；D-296 已完成，下一阶段进入 AI4S。

## 阶段 S：对话式设置与 Agent 管理（D-306）

状态：**S0–S4 已完成并经 D-308/D-310/D-311 收口**（2026-09-21）。共用目录、查询披露、
app/Pi/client/action 写入、session→Surface 绑定、typed action-operation、组合更新与产品 Skill 已接线。
同一 session 同时连接多个 Surface 时明确返回 ambiguous，不允许模型猜选本地窗口；无 owner API 的条目如实 unavailable。
外部登录/安装与跨平台 Surface 现场未实测，但不构成当前生产通路的未实现项。设计 authority 为
[agent-settings-design.md](../agent-settings-design.md)，本节只规定实施责任和完成边界。
实施现状见 [agent-harness-status.md](../agent-harness-status.md) 的 D-306 记录。

目标是设置页与对话管理同一套配置，覆盖现有主要设置类别及相关管理动作，不只交付几个 Harness 开关。
现有 settings.get/update、resource CRUD、扩展管理 API 是基础；尚不能据此声明 Agent 设置能力已接线。
S0–S4 是同一完整阶段内的实施顺序，不是把剩余设置长期列为可选扩展；按真实完成范围提交并更新 status。

### S0：全量覆盖映射与共用定义

- 从现有设置页面、搜索索引、协议和 owner 梳理可读项、可改项、管理动作、只读诊断、平台项与系统交互入口。
  在所属设计/模块文档维护覆盖映射，不再新增一次性审计报告或按固定设置数验收。
- 共用描述包含稳定 ID、分类、i18n/关键词、类型/单位、校验与选项来源、owner、真实范围、可用性、
  生效方式、设置页和复杂说明入口。静态定义与实时值分离，UI 无关契约不导入 React。
- 复用 Pi 原生配置、应用设置、扩展和客户端 owner，确定哪个操作绑定 owning workspace、Host 或 Surface。
  不为每个设置虚构全局/项目/会话覆盖，不增加配置数据库、独立 resolver 或任意 RPC 执行口。

交付：共用定义能表达全部现有主要设置领域的真实差异，并被实际目录消费者使用；只有一份手写清单不算完成。

### S1：目录、实时查询与渐进式披露

- 接入参考工具 `settings_search` / `settings_read`，通过当前 actor 与目标查询原 owner 的实际值、
  effective/source、revision 和动态可选项。搜索、分类浏览、已知 ID 定位共用一套目录。
- 简单项查询即提供可修改信息；复杂项可继续展开规则、相关字段、选项、示例和指南。大目录/动态选项沿已有分页与输出引用续读，
  不设置无依据截断，也不要求每次固定 search → read → Skill。
- 将当前 UI 设置搜索接到共用描述，保留现有页面定位和自定义控件。模型侧入口保持短且稳定，
  不把完整目录放进 system、不动态注册每个字段为工具、不增加设置搜索 LLM/向量库。
- 缺匹配、不可用、配置损坏、权限不足分别表达。读操作不触发登录、安装、下载或模型调用；凭据只返回状态和引用。

交付：从真实 Pi 工具入口取得与设置页一致的配置事实，简单项和复杂项的披露深度可按实际需要选择。

### S2：修改、恢复默认与领域管理动作

- 接入参考工具 `settings_update`，在同一原生权限/Host 能力边界中执行 set/reset，支持多项请求。
  UI 与 Agent 共用实际写入、校验和生效服务；替换重复写入路径，不用编辑内部文件绕过服务。
- 按真实 owner 处理局部变更和 revision 冲突，保留不相关用户编辑；reset 删除该范围覆盖再重新解析。
  不能把非法字段/值静默过滤成成功，也不能把 user-only 字段写入项目层伪装生效。
- 资源描述接入 7H 调度；同一全局配置不能因来自不同工作区而失去协调。同 owner 原子提交，
  跨 owner 如实报告逐项结果，不承诺跨进程全局事务或无条件回滚用户后续修改。
- 目录引用登录、安装、启停、准备、连接等原领域动作；缺 Agent 入口的正式管理项补同 owner 的类型化工具适配。
  Skill/提示词管理走 resource API，Pi 包与 Varin 扩展保持各自 authority。
- 自身会话配置写入和 reload 先在原 owner/broker 拆清责任，避免设置工具等待自己的运行队列；
  生效规则随写入合同实现，不能先接一个会中途重载 Agent 的临时版本。

交付：各主要设置领域都可由 Agent 写回真实 owner；相关操作有实际执行与状态入口，系统交互步骤明确且可继续。

### S3：界面同步、运行时应用与目标切换

- 将 owner/target/revision 关联的变更通知接到原 UI 应用逻辑；Agent 修改自动保存并可见，
  用户手改后 Agent 读取同一结果，应用权威快照不产生反向保存循环。
- 重连重新读取权威状态，旧事件/旧 Host 响应不能覆盖新目标；未保存的用户编辑按字段处理冲突。
  区分远程执行 Host、本地设备和具体 Surface，客户端缺席或目标不明确不能假装已操作本地界面。
- 显示 saved、applied、待配置边界/重启、动作进行中与失败的真实区别。当前 Run 的模型/工具配置继续冻结，
  在原有合法边界应用新世代；权限撤销照常实时生效。
- 响应丢失与观察取消按 owner 状态/操作身份核实后继续，不盲目重做安装或多项更新。
  设置变化只按 7G 向相关会话提供必要增量，工具已交付的不重复，不唤醒空闲模型。

交付：对话中的成功结论对应真实保存和应用状态，原设置页可以继续管理同一配置，本地/远程身份没有串用。

### S4：组合 Skills、覆盖收口与交付

- 提供精简管理说明及有实际复用价值的组合 Skill，例如配置科研工作环境；沿产品 Skill 发现/加载体系按需读取，
  不创建仓库贡献者工作流 Skill，不把普通设置操作变成强制读指南流程。
- Skills 引用稳定设置 ID/能力入口，描述方法与组合示例；参数、可选项与当前值来自查询工具。
  生成参考说明复用共用定义，删除重复手写目录、旧 Agent 配置副本和过期适配分支。
- 对照 S0 覆盖映射收齐外观/聊天/通知/编辑器/终端/模型/Harness/检索/Web/扩展及相关设置页的生产通路。
  真正的平台或外部系统限制注明原因与可用入口；尚未接线的核心项仍是未完成，不能改名为“仅未实测”。
- 按具体风险核对原生权限、真实 Pi 工具 → Host → owner → UI 的代表性路径，
  补必要的并发、范围、reset、生效/自身 reload、部分成功和目标切换证据；不按设置数量复制测试。
  没有新失败或实际风险时不扩大为全平台点击、付费模型评测或全仓重跑。
- 同步设计/状态/架构/模块文档及 i18n，完成的正式能力默认提供，无 shadow 或第二条写入路径。

阶段完成以可用功能与真实消费者为准：大部分现有设置能够被发现、解释、修改并准确呈现生效结果，
用户和 Agent 可以交替操作同一配置；简单操作短路径、复杂操作可展开、组合任务有按需指南。
代码核对与定向验证支持交付；未开展的真实模型、外部登录/安装和跨平台现场实测在 status 记明，不自动阻断已完成通路。

## 阶段 W：会话等待、触发与续接（D-307）

状态：**W0–W4 已完成并经 D-308/D-310/D-311 收口**（2026-09-21）。时间、实验、产物、指标、日志、文件、
外部查询、普通 shell 与 manual 来源，跨来源 `all`/`any`，共享观察，受管远程续接，Thread/session 生命周期及
calendar Agent 管理均已接线。普通 shell 仍遵循本地进程 owner 生命周期，Host 重启后无法重附着时转 unavailable；
file/metric 在 Host 收到边沿后先耐久化 observation，不能把来源 owner 尚未送达的瞬时事件宣称为跨进程 exactly-once。设计 authority 为
[agent-follow-up-design.md](../agent-follow-up-design.md)。本阶段复用 7G/7H/7I、现有 Thread/Run、Goal、
原生权限和 scheduler 服务；支持原会话续接，并保留按日历新建工作的用途。
实施进展与未覆盖边界见 [agent-harness-status.md](../agent-harness-status.md) 的 D-307 记录。

### W0：续接合同、来源与状态责任

- 核对现有 scheduled-tasks、Pi executor、Goal quiet-window、Thread 消息/准入、后台 shell、实验和 7G 送达接缝。
  区分注册、观察、触发、投递接受、真实运行、结束和 Goal 终态；记录现有仅派发即 success 的缺口。
- 定义轻量 follow-up、来源引用、目标类型、definition revision、occurrence 和投递关联，
  通过现有 Rust durable storage 类型化边界持久化，不创建第二任务数据库或复制日志。
- 明确时间、执行/实验终态、文件/产物 ready、结构化指标、日志匹配与外部状态查询的实际能力合同。
  身份从会话/Thread 与 owning workspace 解析，native source、Host、Surface 不混用；权限与生命周期沿原 owner。
- 登记和主动暂停分开，机械条件与后续自然语言指令分开；不新增强制进展表、研究流程 DSL 或判断模型。

交付：合同被真实触发/工具适配消费者采用，能表达已有工作续接与周期新建任务，不以仅有 DTO/文档收口。

### W1：程序触发与耐久观察

- 接入现有后台执行、实验/产物和文件观察事件；snapshot/subscribe/cursor 配合处理登记前及登记期间完成。
  条件持续为真按事件/修订/阈值跨越消费，不每次采样唤醒。文件刚出现与产物真正 ready 区分。
- 时间驱动保存绝对到期身份和时区语义；支持一次性时间、明确重复、事件加时间后备，
  同时满足合并交付，后备检查后仍可等待终态。没有用户意图不生成无限重复任务。
- 无可靠事件的授权来源用确定性状态查询，共享相容观察，频率按任务和来源能力选择。
  无模型参与机械检查，失败/未知/断连不当成业务条件命中，不建设任意脚本执行式条件引擎。
- 重启重建观察并对账未完成触发；普通 shell 和耐久实验按原能力分别处理。
  一次性到期恢复后执行一次有效后续，周期条件检查当前状态，日历新任务按明确 missed-time 策略处理。
- 保护所需来源/目标引用，取消或删除释放；观察不占模型槽或持久文件锁，不假装释放仍运行的 GPU/进程资源。

交付：程序能准确形成可恢复的触发事实，不通过循环调用 Agent 代替观察，也不把事件回调当作模型已完成工作。

### W2：Agent 自然操作与同一目标续接

- 提供参考 `follow_up` 原生管理入口，支持登记、查看/列出、更新、取消、立即检查及明确暂停等待。
  长任务工具返回身份时给简短后续入口；简单场景可直接登记，复杂来源再渐进披露参数/示例。
  复用 Stage S 的能力发现思路和产品 Skill 加载，无强制先读指南步骤。
- 参考工具只要求实际来源/时间和后续意图等必要输入，身份由 Host 补齐；修改/取消与发生中的触发按 revision 协调。
  同一操作响应丢失按稳定身份查询，不重复创建等待或重复提交后续。
- 目标活跃时经 7G/现有消息通路交付，空闲且有继续意图时经 broker 准入恢复原 session/Thread。
  主/子同样适用，不新建隐藏主会话；原 Run 已结束时依法开始同 Thread 的新 Run。
- 触发与用户新输入/自然续接竞争时使用同一投递关联和准入，不发生两次并行运行；
  取消、归档、删除和被替换定义不能被迟到回调复活，凭据/能力撤销仍实时检查。
- 显式等待抑制 Goal 的空转审计/自动续做并让出模型槽；非阻塞登记不停止其他工作。
  通知、事实交付、模型恢复分开，普通状态采样不会唤醒模型或自动切高级模型。

交付：真实 Pi 工具 → Host 触发服务 → 7G/消息/运行准入 → 原目标继续工作，等待期间不靠模型轮询维持活性。

### W3：现有排程收口与会话 UI

- 原 GUI/CLI/Markdown 项目排程接同一触发服务，新建工作与续接目标明确；原定义文件继续为 authority。
  Markdown 变更和 Agent 管理动作有实际同步路径，不依赖打开任务列表才启用。
- 修复 scheduler 仅派发就成功的状态；从实际会话/Run/Goal 生命周期跟踪每次发生、错误与取消。
  并发和不重叠按真实工作生命周期协调，清理仅遮盖启动状态的 watchdog/重复限制，复用现有执行准入。
- 会话显示轻量等待条目，详情含条件、来源、后续意图、协调 Host 与状态；支持修改、取消、立即检查和打开工作现场。
  程序检查与明确让 Agent 现在接手是不同动作，取消等待不暗中停止进程。
- 既有计划任务列表显示真实运行/完成结果和可追溯会话入口；无客户端但 Host 在线可触发，Host 退出不承诺按时执行。
  各工作台沿共享服务呈现，模型可见英文说明、UI i18n 和权限交互共同接通。

交付：用户能通过对话自然设置后续，界面可见可控，原有日历任务的管理和结果也使用真实合同。

### W4：合并交付、恢复与文档验收

- 核对代表性生产路径：执行完成/失败、时间后备、外部机械检查、活跃/空闲主子线程、Goal 等待和原新会话排程。
  对具体疑点选择注册竞态、重复事件、响应丢失、取消/删除、用户新输入、重启/断连等定向证据。
- 同一事实已由工具/消息/7G 交付则不重复；触发输入短且可展开日志/产物，压缩后必要关联可恢复。
  避免全量日志灌上下文、重复模型请求和固定间隔的无变化唤醒；时间式评估保留用户明确选择。
- 清理旧派发成功语义、平行 scheduler/续接 writer 与未消费回调；同步设计、状态、模块文档、原用户任务文档和 CLI 帮助。
  原来存在的能力不能仅由新工具名或 helper 测试重新宣称完整交付。
- 已有证据足够就收口，不新增测试数量/固定并发/墙钟限额、不把全平台/外部 provider/付费模型实测当统一门槛。
  尚未接线的核心行为和仅未实测部分在 status 分开，默认交付实际完成的正式能力。

完成判据：Agent 可以自然登记并管理后续，时间/事件/程序条件有效触发，等待不制造模型空转；
发起工作在正确 session/Thread 中续接，UI 和定时任务结果对应真实执行，取消/重启/重复交付不破坏工作身份。

## 阶段 B：Varin 全面更名（D-313）

状态：**源码、品牌资源、构建配置与 GitHub 仓库已切换并通过本地生产链检查；新品牌公开发行待发布**。
设计 authority 为 [Varin 全面更名](../varin-rebrand-design.md)，实际证据与 npm/发行边界见 status。
B0–B4 的内部实现完成，后续进入 F；没有新旧共存机制，也不把未发布的新坐标标成已有下载产物。

### B0：命名映射与真实消费入口

- 从跟踪文件定位 Piarium/piarium/PIARIUM、自有派生符号和文件名，再按 UI、包/构建、运行时合同、
  数据/配置、发行/外部资源、文档划分入口；搜索生成源而非批改 node_modules、缓存和输出目录。
- 采用设计的命名表，追踪 package/filter/import、事件发送/消费、kernel 生成/启动、appId/原生工程、
  asset/feed 等实际依赖。不新增另一个永远需要维护的命名数据库或品牌服务。
- 区分上游 Pi API/原生数据、来源归属、历史记录与当前自有品牌；确认外部目标是否可用及操作权限，
  对尚未切换的资源记录实际状态，不先把目标 URL 宣称可用。

交付判据：所有维护中的产品面和构建/发行 owner 都有明确改动位置；保留项基于语义，未把全词 `pi` 当替换规则。

### B1：包、运行时合同与数据身份一起切换

- 根包、`@varin/*` workspace、CLI、品牌化模块/文件、import/export、filter 与构建复制规则一起更新；
  用对应工具更新 Bun/Cargo 和 cloud production lock，清除仅为旧名称转发的入口。
- kernel crate/二进制/manifest/生成协议与 Host 启动器一致；UI/Host/worker/broker/preload/SSE 和
  扩展/工作台默认注册同步使用新自有身份。普通 Pi 技术模块继续准确表达适配职责。
- 环境变量、app-owned 配置路径与存储 key、凭据 service 标识、临时前缀及系统服务注册统一新名；
  原生 Pi AuthStorage/JSONL、第三方合同、显式自定义路径能力保留，不增加旧名读取或迁移入口。
- 开发者已有数据不批量删除。需要处理的本地成果单独一次性交接，可再生输出仅在确认路径后清理。

交付判据：新包和新二进制能被真实消费者解析；跨进程身份一致；新自有数据路径独立工作，旧名不会隐式兜底。

### B2：全端产品呈现与品牌资源

- 桌面/Web/移动的标题、Agent 名称、设置/关于/错误页面、通知、manifest、安装和系统入口统一 Varin；
  各语言保持品牌拼写，产品描述准确体现独立工作台与 Harness。
- 按用户评阅保留原方块 π 造型，图标组件/资源身份采用 Varin，沿共同生成链同步各端；
  新 Logo 留待后续独立设计，不把临时 V 替换当作新品牌视觉交付。
- appId、桌面开发态、Linux desktop、Capacitor 与 Android/iOS 标识对应；不改变两个界面切换、工作侧重、
  配色体系和功能布局，不引入多品牌运行时。

交付判据：当前入口和实际产物使用一致品牌；当前平台的呈现/资源接线有相称证据，未测平台如实记录。

### B3：发行、部署、外部资源与文档

- 当前仓库、包发布、镜像、部署脚本、下载链接、更新 feed、asset 匹配器、校验和、可选组件及 CI 变量
  形成完整新坐标。优先原仓库改名，不复制成另一个断裂历史的仓库；外部动作在授权内执行。
- 目标 npm scope、域名、OAuth/签名或仓库配置若不可用，说明具体缺口并解决那个分发坐标，不回落旧品牌。
  代码准备完成与外部切换完成分开报告；不用虚构地址填充成功状态。
- 当前 README、AGENTS、用户/开发/模块/架构文档和示例采用 Varin，品牌化文档文件名与链接同改；
  历史决策正文、changelog、已有 tag/资产和第三方归属保留事实。版本按本次实际发行授权处理。
- 新产品不支持升级旧 Piarium，不保留旧更新通道、重定向 shim 或双发包逻辑，也不额外删除旧历史发行物。

交付判据：新安装/部署/下载/更新使用一致命名，实际外部切换状态可核对，当前文档不再指引使用旧自有入口。

### B4：闭合验证与阶段收口

- 按 B1–B3 已有证据核对干净依赖解析、生成和构建，复用适用的当前启动/packaged smoke，
  确认新 UI→Host→worker/kernel 通路及一项工作能力，不为每个切片重复全量测试。
- 残留检索用于本次人工判断：修漏掉的当前自有名称，保留历史/第三方语义；不新增永久零命中门禁、
  固定数量断言、旧名例外大表或为了更名搭一套测试平台。
- 同步 status、architecture、roadmap 及所属模块文档，报告产品代码、外部资源、产物和未实测部分。
  阶段 F 接着使用新命名；更名自身不证明其模型能力已经实现。

完成判据：Varin 是唯一当前产品身份，开发、运行、发行及当前文档相互对应，没有新增历史兼容负担；
用户成果、真实依赖和项目历史得以保留。未完成的 Logo/外部接线不能被文件替换数量掩盖。

## 阶段 F：快速决策模型与渐进检索（D-312）

状态：**F0–F4 已实施并进入生产调用链（wired）；交付事实与未实测项见 status**。承接 S/W 收口，并在 D-313 阶段 B 完成后使用新产品命名；设计 authority 为
[快速决策模型与渐进检索](../fast-decision-model-design.md)。本阶段交付通用能力及代码检索消费者，
Jev 是首个 adapter；不实现 Computer Use，不扩成新的长期 Agent runtime。

### F0：能力合同、绑定与设置入口

- 在 protocol 定义供应商无关的选择/判断/评分与能力描述，区分可选置信信息、相对分布和独立概率；
  消费者只依赖所需能力，不要求所有后端长成 Jev 的三个 primitives。
- 拟新增 `harness.fastDecision` 独立配置种类：默认绑定、已注册用途覆盖和显式关闭，复用 user/operator
  设置及 Pi 凭据 authority。默认未配置，不借主模型；同 query 冻结绑定，下一次 query 使用新配置。
- 设置页统一“快速决策模型”，接模型分工、真实能力展示、i18n 与共用设置目录；Agent 查询/修改和 UI 使用同一 owner。
  不只在 UI 保存一个生产端无人消费的 modelId，也不从普通聊天 registry 推断判断能力。

交付判据：用户能实际配置或关闭默认/检索用途绑定，运行端解析与界面显示一致；未配置时原检索可用。

### F1：共用推理通路与 Jev adapter

- 沿 pi-host 后台 inference / broker / Host 接入显式快速决策服务；TypeSafe provider 注册和认证仍归原凭据系统。
  Host 提交用途、目标、授权材料和候选身份；adapter 映射原生请求与结果，不走伪造的 chat completion 或 `/rerank`。
- 处理实际能力/容量、批处理、模型版本、取消、返回 ID 和不完整结果；不把 missing 当 false 或零分，
  不补造用量/置信度，也不把供应商置信度写成事实成立概率。
- 当前 Jev 只承担给定选项的判断；不能生成的新表达继续由既有生成式能力或真实源码提取提供。
  复用查询 provenance；不新建长期会话、密钥表、决策数据库或独立费用面板。

交付判据：生产 Host 经实际协议和同一 adapter 发请求，按 ID 得到可用判断；关闭/取消与失败具有真实结果。
验证可沿既有装配与 faux provider，不要求真实付费账户往返才继续实现消费者。

### F2：`explore` 选材接线和模型职责拆分

- 进入公开 `explore.query.*` 路径，使用当前 query 的原文视图；新增模型输入在最终展示预算裁剪之前组织。
- 分别判断材料返回价值、下一步探索价值；用当前候选/范围 ID 选择，不要求 Jev 输出自由文本分析或缺口描述。
  选材考虑已选材料与新增贡献，避免同一机制的重复片段占满结果。
- 快速决策有效时承担对应选择，`models.explore` 保留按需生成搜索表达；同一项判断不再串普通重排和 LLM 选择。
  未配置时沿原流程。失败保留已读材料与来源顺序并说明状态，不自动切另一付费模型。
- 删除已被替代的重复评分路径；精确定位、词法/向量/结构召回与无模型路径继续保留，不能只改一个 model 名字。

交付判据：公开工具确实使用快速决策选出的当前原文；现有配置继续有效；重复评分、非法范围和失败丢材料的问题可被发现。

### F3：动态动作候选与逐步探索

- 在现有 query owner 中管理待执行动作、已读材料和已执行身份。从真实符号、语句、关系、目录/大纲生成下一步候选；
  动作含完整目标和依据，模型只选择 action ID，授权与执行由原服务完成。
- 执行选择的独立方向后，增量生成/评价新材料；支持保留备选方向、回到其他入口和跨文件关系展开。
  入口不足时可用目录/大纲和生成式计划提供新线索，不把一次目录低分变成永久子树排除。
- 转发函数即使不适合最终呈现，也能因探索价值而继续追踪。检查重名符号与连接线索的实际原文，
  不把共现当成真实调用，不把没有候选当成仓库没有实现。
- 沿原范围、来源修订、取消/截止和输出句柄；去重后无新材料不重复调用。模型的充分性判断限定于已读材料，
  未完成来源仍披露；没有统一新加深度、轮次、文件数量和概率阈值。

交付判据：一个公开工具调用可依据第一批材料选择下一步、取得第二批真实代码，再选择互补原文返回。
至少检验转发入口与多个独立方向这类区别于静态 rerank 的实际行为；不能用模拟的最终文件清单证明逐步探索已接线。

### F4：交付收口与实际使用观察

- 沿 F0–F3 的已有证据核对设置→推理→查询→读取/关系展开→原文结果，关注迟到结果、修订变化和取消后不复活。
  检查没有第二个 query/runtime、重复权限门或为了模型改造而复制的检索/索引实现。
- UI 与 Agent 设置入口使用一致名称和能力信息；同步模块文档、设计、status、architecture 和 roadmap。
  配置有效就交付正式路径，尚未实现的其他消费者不注册成可用能力。
- 质量与性能按实际问题反馈观察，可记录入口命中、关键材料覆盖、无关正文、补搜次数和端到端等待。
  不搭独立评测平台，不强制全量测试、全平台、真实模型或“优于 Devin”证明；缺少实测与功能未接线分开记录。

完成判据：快速决策是可复用的显式模型能力，Jev 适配和 `explore` 选材/逐步探索为真实生产路径，
未配置与失败情况下仍提供诚实可用的已有材料；其他用途可以沿同一合同追加，而无需重做供应商接入。

## 阶段 C：后台压缩 Agent 与语义续接（D-314）

状态：**已交付（wired）**。承接已交付的阶段 F；D-284/D-286 的固定候选、较长原文、历史权威与
容量驱动仍是基础。设计 authority 为 [context-compaction-agent-design.md](../context-compaction-agent-design.md)。
顺序为 C0 → C1 → C2 → C3 → C4；生产路径为 broker 派生的专用 `compaction` worker 沿同一机制替换旧单次摘要，
无双引擎或新增 keeper；交付状态见 [agent-harness-status.md](../agent-harness-status.md)。

### C0：固定材料、来源与共同提示词

- 从 `context-preparation.ts` / `context-request-boundary.ts` 的生产调用开始，明确 S0/A/B/N、固定末端、
  `firstKeptEntryId`、compaction 边界、输入世代与模型配置的单一 owner。切点归程序，摘要模型无权删改保留原文。
- 提供准备时的 B 作为只读参考，保留 role、工具配对、entry 与范围标记。超大输入使用明确的分段/分页方案，
  不能只传标记冒充已经呈现，也不能静默截去 A 的内容。
- 首次与更新共用语义提示：有效目标/纠正、引用材料与用户要求、决定及原因、真实执行状态、未决事项与来源。
  替换“最近 user 全文钉住”的机械策略；不固定最近 N 轮，不为每种语义分配死板字数或 JSON 栏目。

完成判据：输入能明确区分待替换与待保留材料；后续压缩不丢失首次的完整职责；已有摘要不是不经判断的永恒指令。

### C1：内部子进程与查询能力

- 沿 runtime-broker / pi-host 的真实 worker 生命周期加入内部 compaction 用途，复用 Pi loop、模型认证、退出与取消。
  父 session 持候选与提交权；不通过业务 Thread/Goal 派发，不建立工作树、Integration 或新的会话数据库。
- 接线历史搜索/读取、对应输出/artifact 读取、相关任务/线程记录；复用实际 authority 与关系授权。
  固定来源读取与实时观察可区分，不把当前文件内容当成旧版本证据，缺失/过期正文如实返回。
- 查询不得消费父会话的消息、增量观察或 7G 送达收据；缺少无副作用读取接口时补齐 owner 接口，不能借用父游标。
- worker 只加载本任务查询执行器；历史中的业务工具调用不重执行，不在 worker 内再次启动压缩、自动 follow-up 或业务派发。
  复用进程时清除旧任务绑定，取消沿模型请求和在飞查询传递。
- 核对普通业务执行名额用满时的进度条件：等待摘要的父会话不能占住压缩所必需的唯一准入路径。
  复用已有后台/provider 调度，无新增固定配额；外部串行限制如实等待。

完成判据：通过生产 broker 启动 worker，能实际读取获准历史/输出并完成；退出/取消释放资源，主会话状态和已读游标不变。

### C2：语义摘要与候选结果接线

- 以当前会话模型配置启动，材料充分时直接返回；有必要才自主调用查询，不强制调查轮数，不另加审查模型。
  统一提示词按设计 §6 落地，手动压缩重点只是补充，不替代基本要求。
- 最终正文进入原候选类型；模型不填写 session/切点/授权元数据。程序核验实际来源身份、完成状态、可用正文与容量。
  查询过程留在内部任务，不作为主 Agent 的普通消息或新成果发布。
- 将历史要求与引用材料、提议与决定、执行与验证的区别体现在可见输入及提示中；精确信息可以短引用，
  不保证可控假模型能证明真实语义质量。
- 比较主请求和 worker 的实际 system/tools/messages/options；可复用前缀尽量复用，变化如实计量，
  不为缓存承诺保留虚假的工具能力，也不重新包装全部历史为一个巨大 user 字符串。

完成判据：会话自动准备确实经过新 worker/查询链，ready 结果仍绑定同一个 A；后台新增 N 不触发追赶或重复准备。

### C3：主会话等待、worker 容量与安全提交

- 每次真实主模型请求前计入 7G 与新增工具结果后检查输入和输出预留；容量不足则等待同一个在飞 worker，
  不启动第二个总结。摘要 ready 仅暂存，尚有容量时前台继续。
- worker 自身每次请求计入查询结果及最终输出预留，启动材料为必要查询留有可用空间；沿模型与材料实际能力规划，
  不凭空增加统一“安全百分比”。超大材料分页，无法可靠覆盖 A 时明确失败或重新划定范围，不递归压缩自己。
- 提交前从最新活动分支组合 S1+B+N，核对工具配对、来源身份与真实容量；由原 Pi writer 发布，再刷新 loop 的当前输入。
  不覆盖准备期间新用户消息，不丢工具结果，不把保留历史再当新事件重放。
- 分支/fresh/模型变化、手动重点改变、取消、worker 崩溃及迟到结果均走原 owner 的失效/错误处理。
  尚无 ready 摘要就失败时保留历史并显示原因；多次压缩无容量进展时停止该循环，不进入静默双引擎兜底。
- 75% 准备水位与 60% 规划目标延续已有语义，关闭后台准备/自动压缩与手动入口沿既有用户配置保持一致。

完成判据：后台挂起时前台可正常追加；容量不足时等待；就绪后以最新尾部继续；失败/取消没有提交半成品。

### C4：消费者、文档与验收收口

- 删除被新生产路径替换的单次摘要执行入口和弱化更新提示；保留 Pi 历史、已有 compaction 记录及原观察恢复语义。
- 沿已有状态/UI 展示真实准备与等待，不增加普通业务线程或要求用户维护的新设置页；用量和错误仍进入既有通道。
- 复用现有 context preparation、session/Pi 集成与 history 覆盖，选择能暴露新故障的定向行为：
  B 确实送达、查询不消费父游标、等待期间新用户纠正与工具交换保留、过期候选拒绝、业务名额满时无自等待。
  不新增逐提示词文字断言、固定测试数或重复全平台 smoke。
- 同步设计、status、模块文档和 architecture。真实付费语义质量、完整桌面/跨平台效果如实列为未测，
  不把它们设为代码与功能已完善阶段的交付门槛。

完成判据：准备、查询、等待、提交为一条真实生产通路，当前实现与文档一致；质量/延迟收益没有实测前不声称已证明。

## 阶段 L：Web 与科研检索（D-315）

状态：**L0–L6 均已交付并接线**。设计 authority 为
[Web 与科研检索](../web-research-search-design.md)。本阶段承接 C，不与已交付的 7H 工具并发/长命令阶段混淆。
使用现有 Pi Agent、Thread/Run、Host 网络服务、Rust 对象/记录与快速决策服务；默认 Web 能力和用户已有选择继续有效。
实现阶段按下列依赖交付，不一次性重写全部搜索。每个切片接上公开工具和必要消费者，再记录其完成范围。

### L0：现有检索线程、结果合同与能力发现

- 对照 `harness-presets.ts`、`research-capabilities.ts`、`thread-tools.ts`、Thread 初始提示、事实服务与 settle 消费者，
  沿已有通用 `retrieval` 和科研 `investigation` 改进，不新造 Web researcher。检索专用模型缺失时提示原因，
  保留普通派发明确继承当前模型的路径；不静默借模型，不把学术工具限在科研 UI。
- 调整 retrieval 唯一交付要求：自然语言 report 可正常形成结果，`submit_facts` 用作可选的结构化事实。
  同步预设提示、初始提示、类型、settle/seal、持久报告、read_thread/wait、上下文和 UI；
  不能因缺 pendingEvidence 就覆盖有效自然语言报告，也不能把没有结构化校验的 prose 标成 source-checked。
- 保留事实来源 Host 核对、Run 绑定、scope 与 artifact 引用；自然语言和结构化材料共同指向同一报告，
  取消/失败保留已取得部分。保持无写入/shell 的检索职责，模型不因给出建议而接管主线。
- 在工具指导中提供搜索/读取/学术能力的发现入口，动态字段和 provider 能力由实时工具披露。
  不增加独占 CLI、固定研究格式或必须安装的新 Skill。

完成判据：现有检索线程可以交付可回读的自然语言调查结果，按需提交结构化事实；父线程与 UI 能读到真实结果，
两种交付都不会提升未经核对的来源状态。普通/科研及未配置专用模型的行为可明确区分。

### L1：连续 Web 搜索、阅读视图与复用（已交付，wired）

- 扩展现有 `websearch`/`webfetch` 与 Host 服务：可选自然语言目标、独立查询/URL 批量、每项状态、分页/展开、
  provider 实际能力与筛选语义。已知 URL 与简单查询直接执行，默认 Exa/Parallel 和显式 provider 选择沿 D-289。
- 关联搜索条目、固定正文快照和段落/行位置，保留 URL 与最终 URL、获取时间、内容身份、解析来源。
  搜索 snippet、原始摘录、摘要和生成答案区分；当前正文不覆盖旧报告引用。普通材料视图与 Run-bound receipt 分开。
- 共用现有 receipt/artifact/source/kernel authority；不新建第二套正文库。原始抓取可在授权范围合并复用，
  按问题的摘要/选段以目标与模型绑定区分。共享请求取消仅撤下当前等待者，其他使用者仍可完成。
- 新鲜度按请求与材料表达，支持明确刷新；失败/空结果/缺 renderer/未取得正文不能折叠。
  来源卡片可展开实际原文位置，保存材料沿原 owner，不仅在后台定义未被消费的 handle。

完成判据：同一会话/Thread 可从结果进入固定原文并继续展开；同一 Thread 的后续 Run 仍按自身 scope 重读，跨 Thread 的显式材料授权由 L4 处理；部分失败/取消不抹去已成功材料。
重启后持久引用能回读，临时网络请求不冒称耐久执行。

### L2：学术身份、发现与关系追踪（已交付，wired）

- 接入 OpenAlex / Semantic Scholar 的论文搜索、详情、引用/参考文献与开放材料位置，按真实 API 分别声明能力；
  可配置 Sciverse 提供段落语义/读取等增强，独立可用，不能以所有密钥齐全作为前提。
- 保留 DOI/arXiv/provider 标识、版本和关系；可信身份合并作品，主文/附录/预印本版本保留独立材料。
  标题相似、语义相关和真实引文有不同来源，不凭模型评分永久合并或生成引用边。
- 学术能力查询按需披露字段、筛选、分页与全文可得性；查询与返回真实能力一致，不因有论文元数据就标为已读。
  引文按需向前/向后展开，缺数据/部分页和取消如实返回，不造全库图或固定展开跳数。
- 沿 L1 材料身份与已有 source 列表展示论文、摘要/全文状态、关系和线上入口；正文不可得的候选仍可参与发现。

完成判据：公开工具可从自然语言/论文标识找到真实论文记录，再取得相关论文及可读来源，元数据和实际内容级别不混淆。
第一批学术 adapter 的生产接线可用受控 HTTP 响应验证，不依赖购买账户才闭合调用链。

### L3：材料集合、结构阅读与实践交接（基础与 P0–P2 纵切已接线；质量仍需真实样本观察）

- 支持明确论文/材料集合内的关键词与可用语义检索，范围在召回前应用，命中能回到固定文档位置；
  不复制代码 `explore` 或要求先建立全球论文索引，无向量配置时仍可文本检索与读取。
- L3-P0 固定原件后提供互不依赖的 `overview`、`text`、`page-image`、`structure` 读取。`document_read` 接本地授权路径或固定
  `snapshot_id`，二者通过同一 `materials.read` Host authority；Web PDF 在探测/解析前先保存原始字节。原件 `sourceHash` 与当前可读
  `snapshotId` 分开，`overview` 可只返回原件 hash、页数/页面几何和文字状态，不先抽取全文。页图由包内 PDF.js + Canvas renderer
  直接生成 PNG 和可选区域裁剪；不要求 Poppler，也不依赖文字或结构解析。
- L3-P1 按请求页生成文字、版面/结构或 OCR 视图。轻量原生读取使用 PDF.js；Docling 的结构解析与 Tesseract OCR 是可选 Host
  组件，用户级 `harness.documentReading` 配置可执行文件名/路径和 OCR 语言，空值恢复 `docling`、`tesseract`、`eng` 默认。
  Host 通过受管进程直接启动配置的 executable，不拼接 shell 命令；不自动安装，也不因组件不可用而禁用独立文字或页图读取。
- 原件 `sourceHash` + 页码/区域是跨分析的原件锚；结构元素和布局额外带该派生结果的 `analysisId`。分析身份随解析器、实际
  parser version、配置、OCR 和页范围变化；无需把所有原页绑定成同一 parser 版本。Docling 的 CLI parser version 与输出 JSON 的
  `schemaVersion` 单独记录。页面几何与区域统一以旋转后的页面为基准、左上为原点、坐标范围 `0..1`。
- L3-P2 的阅读器共用本地 PDF 与 Web 快照：打开先看 overview，随后可查看页图、查文字、按需请求结构；`varin-material://`
  引用回到当前可读快照和指定页/区域。选区提问把短引用及实际 crop PNG 放进当前会话草稿，只有用户提交后才进入输入；普通 Agent
  与科研工作台沿同一材料权限服务读取。
- 阅读结果可关联代码版本、数据和补充材料，交给既有 Thread/实验作为输入；source/对象引用保持原生命周期，
  从阅读转实践仍由正常工具权限执行，正文中的命令不自动执行。
- 暂存集合和显式保存集合使用同一来源 authority。解析失败、缺失和未支持分别表达，不能将空正文或 schema version 冒充成功解析。

验收分别核对原件先固化、各视图独立读回、页/区域锚、分析身份和 UI 引用回跳；不能仅凭 PDF 转成文本宣称结构阅读完成。
解析候选不等于内容质量：复杂版式、单元格/公式/图表准确性、真实 OCR/Docling 样本质量和跨平台完整发行仍需单独验证，
本计划不将它们描述为已达标。

### L4：协作复用与按需继续调查（已交付，wired）

- 复用 Thread/Run 的派发、消息、continue/fresh、read_thread 与准入；相关调查沿原线程，独立问题按价值并发。
  在 retrieval 的实际 allowlist/能力装配中补齐必要通信与线程读取，保留同根关系和 scope，不只改提示。
- 自动归集已查询表达、取得材料、读取范围和失败等程序事实；其他线程可按授权查询和复用原文，判断与摘要各自留存。
  接收线程自己的访问与 receipt 重新确认，不能直接复用另一 Run 的来源核对权威。
- 搜索/阅读完成事实接已有 7G 增量，完整活动按需查询；团队现状沿已有输出投影，不要求 Agent 另写状态报告。
  调查的新解释通过自然语言消息交流，不机械检测关键词触发高级模型。
- 长调查与条件等待使用现有 wait/follow_up，处理取消、终态和恢复；不建立新的 scheduler 或把普通网络请求变耐久实验。

完成判据：一个调查线程的新发现能被相关线程读到、继续追问并复用材料，省去重复抓取和手工登记；
工具执行事实与语义进展、消息送达与权限分别成立。

### L5：快速决策消费者与动态候选

- 在已有 `harness.fastDecision` 增加真实 Web/学术用途，沿默认绑定/覆盖/off、configurationId、Pi 认证、取消及用量；
  消费者对应设置目录/UI，未配置仍保留直接搜索和 Agent 判断，不拿 `models.explore` 隐式处理网络研究。
- 将候选相关性、原文选段、互补贡献和下一步探索交给批量判断；动作来自实际 URL、章节、关系、术语和 Agent 新查询。
  新表达由生成式主/检索 Agent 按需产生，不能将固定后缀与静态列表称为完整语义探索。
- 区分返回价值和继续探索价值，低分候选仍可展开；容量裁剪披露未见范围；充分性只辅助当前任务判断，
  missing/失败不当零分、不把有正文或分数过线当研究完成。删除同目的重复 LLM/rerank 判断。
- 检索/读取执行仍走 Host；同一操作绑定冻结，迟到结果不改已结束状态。按真实 provider 容量分批，
  不新增统一轮次/深度/候选数/概率门槛。

完成判据：公开工具生产链确实使用判断结果选择互补材料或下一步，并能够根据新材料继续生长候选；
关闭/不可用时原结果正常交付，取消与配置漂移不产生虚假完成或静默模型切换。

### L6：工作台、设置与交付收口

- 核对直接搜索、通用 retrieval、科研 investigation 和普通派发都可使用其获准的新能力；
  搜索/阅读/保存/引用/后续实验为真实通路，工作侧重与 UIUX 解耦。
- 补齐 provider/能力状态、凭据引用、快速决策用途的设置目录、Agent 设置工具和 UI 同步及 i18n；
  未配置项如实显示，不要求用户改 JSON 或重开科研 UI 才能用。
- 对自然语言报告、来源核对、快照引用、恢复与跨线程共享选择风险相关检查；沿前面切片证据收口，
  不把真实付费模型、全平台/完整桌面重启、独立跑分作为通用门禁。
- 同步本设计、主合同、status、模块文档和 architecture；删除被替代的唯一结构化交付分支与重复查询/存储路径。
  实测未知与未实现分开记，质量与速度无数据不作结论。

完成判据：三层能力在日常任务中可用，资料和线程延续形成同一条生产链；训练、全球索引和未接入领域 API 仍明确为后续。

## 阶段 N：会话下一步选择（D-325，已实施）

当前 `pi-session-automation/runtime.ts` 在 `agent_settled` 后立即准备一次短请求，从当前分支的近邻用户消息、助手结论和可确认状态调用专用模型，
返回零条或多条候选；用户级 `harness.nextStep.enabled` 默认关闭，模型分工的 `models.knowledgeSuggestions` 用于知识库建议，
不控制这条会话建议。本阶段替换该生产路径，不把已交付的知识建议误当成同一功能。

### N0：配置、模型权威与旧路径清理

- 在模型分工中给“下一步选择”独立的启用状态与专用模型槽位，用户级默认关闭；只有启用且绑定有效才发起生成。
  项目配置不能打开用户已关闭的后台建议。未配置或模型不可用时如实不生成，不借通用小模型、当前会话模型或其他槽位。
  批量模型预设不得自动开启后台建议。
  绑定沿会话可信 Pi 设置和现有 provider/凭据权威解析，不由客户端请求指定模型；配置变更对下一次生成生效。
- 将现有 `models.knowledgeSuggestions` 在协议、设置目录、UI 与消费者中明确命名为“知识建议”，与“下一步选择”分开。
  直接更新当前内部契约与消费者，不保留两个同义旧槽位。用户可通过设置页及 `settings_search/read/update` 发现和管理新能力。
- 移除自动 recap 的生成提示、持久字段、开关、设置目录和输入框展示；移除原 `sessionSuggestionEnabled` 的重复配置来源。
  上下文压缩仍由既有压缩链负责，知识库建议及其审阅托盘不随本阶段删除。

### N1：一次短请求理解当前局面

- `agent_settled` 后立即异步准备请求，不沿用固定 60 秒延迟；活动目标仍会自动续接、会话忙碌或已有新用户输入时不生成。
  同一分支末尾至多形成一次结果。请求使用 N0 选定的模型，短输出；不启动检索子 Agent，不调用 history/output/records，
  不作前置判断模型调用、第二轮补查或每轮新增会话摘要。
- 输入是从当前 Pi 分支和会话状态抽取的短事实切片：存在时的明确目标及状态、最近连续的用户原话（保留补充和纠正的顺序）、
  最后一轮助手结论，以及程序已知的本轮失败/未完成状态。原话和状态保留来源身份；不附整段工具输出、全量历史、
  无关子任务或整份压缩摘要。按交互时延约束设置短输入预算，不填满模型窗口；优先装完整短轮次，而非机械截固定条数。
  长材料只给带来源的可用片段并标明省略。材料不足以可靠理解指代或当前结果时，本次返回零建议，
  不用第二次请求换取猜测。
- 同一模型请求判断是否存在值得用户选择的下一步，并生成可编辑的用户消息草稿。允许零条；有真实不同方向时可给多条，
  不规定固定类别、每轮必有建议或“推进工作”的单一方向。传输使用可解析的候选列表，但不要求模型填写研究判断表。
  当前任务已答完、用户未请求配置变更等场景允许安静结束；建议文本不代表用户授权执行。

### N2：结果身份、展示与取消

- 结果绑定会话、当前分支末尾 entry 和生成所用配置；空结果、失败和驳回也记录本轮已处理，不在同一轮重复调用。
  模型返回时再次核对会话仍空闲、分支未前进且功能仍启用；过期结果丢弃，不覆盖下一轮状态。失败只影响建议，
  不改变主会话回答、目标状态或输入草稿。
- 输入框上方按可用空间显示少量不同方向的建议，点击只写入可编辑草稿，不自动发送；输入框已有内容时不抢位置。
  支持关闭当前轮建议和从设置入口关闭功能。自动 recap 行与相关状态一起退出，不隐藏一条仍在后台生成的旧回顾。
- 已同步 `agent-harness.md` 的模型槽位说明、设置目录、i18n、模块文档与 status；旧 recap 状态、设置来源和过时测试已删除，
  没有建立第二套会话历史或模型凭据栈。

完成判据：默认状态没有建议模型调用；显式启用且模型有效时，每个稳定的已结算轮次只发生一次短请求。
定向验证已回答问题可返回空、补充或“继续”能利用随包提供的近邻原话、真实分歧可显示不同草稿、
失败与模型不可用不影响会话、用户新消息/自动续接/设置关闭使迟到结果失效、点击不自动发送。
验证已覆盖模型请求与 UI 消费的真实通路、默认关闭、用户级配置、空结果持久去重、补充消息短事实切片、迟到结果和点击不自动发送；真实模型建议质量需实际使用观察，
不把测试夹具的文本当质量证明。
