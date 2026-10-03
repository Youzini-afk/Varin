# 决策分卷：检索与语义

范围：3.2/3.3/3.15/3.16 explore、related、快速检索接线与返工、语义索引、embedding/rerank 与检索量具。

本卷是 [decisions/README.md](README.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-069 · 2026-09-05 · 3.2 / 6.1（explore v2：把 Devin 的多轮展开成结构查询）

类型：偏离

决定：`explore` 从 v1 的"关键词 → rg → 命中密度排序 → ±3 行窗口"改为六阶段管线，四条硬要求：(1) **输出单位是"目标 + 结构
支撑"**（目标函数连同其定义、调用方、测试、配置、co-change 邻居），不是平铺的命中列表；(2) Devin 模型每轮"想"出来的下一跳
（看定义、找调用方、找测试、沿栈帧走）**换成 LSP / 符号图 / git / 文档注册表的确定性并行查询**，中间没有任何等模型思考的
环节；模型只在两处出场且都是一次性、无工具、与主路径并行、超预算即弃的调用——问题无代码词时的意图抽取，和排序分差小
时的"十选一"裁决；(3) **搜索的是当前内容**：rg 搜磁盘的同时对文档权威的脏缓冲做内存匹配，返回前按当前内容重切并校验行号；
已在主上下文里的文件只回一行指针不再返回片段；(4) **默认开启需通过回放门禁**——对照同预算 BM25 / 现有 `grep`，FileRecall@K
与 token 浪费率都不劣才默认注册，只赢延迟不算赢。问题类型（where / how / impact / why）决定扩展方向而不是重要性权重；
低置信时明说并建议 `retrieval` 角色。反馈回路按 Cognition 的口径在线算 recall@k，只做有界的权重微调与"问题 → 文件"记忆。

原因：这是对两份外部证据的直接回应。OpenLocus 研究（`D:\project\opencr\OpenLocus-Lab`）的负结果：给上下文对 agent 成功率
影响巨大（0.25 → 1.0），但更聪明的候选挑选（BEA v0–v0.3）**没有赢过同预算 BM25**（B16-F 打平且更贵）；FD1 失败分解里最大
的桶是"正确文件没进候选池"（ContextBench 62 条）和"花了时间没换来质量"（80 条），"文件对片段错"最小（11 条），正确文件缺席
时改进挑选只能救回 1/119；B16-J 去掉文件名泄漏后，目标 + 支撑 11/11、只给支撑 2/8、只给目标 0/8；FRK-B 纯算法四路索引
（稀疏词 + 符号名 + 路径 + AST 片段）p95 < 10 ms 文件召回@10 very high 而召回@1 只有 medium。这四点分别对应四条硬要求：
钱花在召回与结构扩展上而不是重排器；目标必须带支撑；确定性路径把答案送进前十，模型只负责十选一且默认不调；无差别地开
可选阶段就是最大的浪费桶，所以要门。OpenLocus 设计的 2.4"脏缓冲是一等现实"与 EvidenceCore"候选不是事实、必须按当前源
重物化"对应第 (3) 条。OCE（`D:\project\opencr\oce`）提供两个可借的零件：tree-sitter 切块里"只含签名的小块并入邻居"
（`cast_chunker._merge_small`），与覆盖度优先的两遍贪心打包（`coverage_selector.py`）；OCE 的向量主通道、服务化与 LLM 全量
重排是设计 6.1 明确不选的赌注，不借。

考虑过的替代：(a) 用通用小模型跑 Devin 式 4 轮 tool loop——一轮 2–5 秒、总计十几二十秒，且未训练的模型第二轮乱跳；
(b) 全仓库 embedding 作主通道（OCE 路线）——代码检索上 grep 打 embedding 已被 Claude Code、Cognition 与 OpenLocus 的 BM25
打平数据反复验证，且引入服务依赖；(c) 只调 v1 的权重——v1 的结构（平铺命中、行窗口、只搜磁盘、无支撑）不是权重问题；
(d) 裁决默认开——FD1 的"latency without quality gain"桶说明无差别开可选阶段是最大浪费。

影响：`agent-harness.md` 6.1 第二级重写（六阶段、问题类型表、低置信、反馈回路、门禁）；`agent-harness-plan.md` 3.2 重写为
v2 实施形状（`ExploreContext` / `ExploreTarget` / `ExploreResult` 类型、各阶段与预算、参考形状路径、测试清单、门禁）；
`agent-harness.md` 12.2 "explore 无 LLM 时的查询扩展"待决项关闭；status 3.2 行 Blocker 更新。实施在 T4 回放集就位之后。

状态：待实施（设计已回写；代码仍是 v1）

### D-070 · 2026-09-05 · 3.2 / 6.1（explore v2 降级为候选架构；更正 D-069 的六处）

类型：问题与解法

决定：D-069 保留方向（结构查询替代多轮乱跳、返回前按当前内容重读、默认关闭并与 grep / BM25 对照、带关系的代码单元），但**状态
从"待实施规格"降为"候选架构 / 待验证假设"**，不据此开工、不据此决定默认启用。更正六处：

(1) **组件所有权**。D-069 把整条管线写在 host，却要求 `models.explore` 调用、主上下文文件表、`read` / `edit` 步数、未保存正文、工作台
焦点——这些分属三个进程：模型与 `completeSimple` 在 pi-host（D-068 的 reader / permissionJudge 同路）；主上下文与 `read` 轨迹在
pi-host，host 没有 read 观察链；UI 焦点与选区属于具体 surface，不在 worker 发布的 `session.snapshot` 里；Documents authority 的脏
缓冲发布只有路径、`baseRevision`、`localEditRevision`，**没有正文**（`lib/documents/authority.ts` `DirtyBufferResource`）；LSP
supervisor 的缓存正文没有 surface 所有权。拆为 pi-host `ExploreCoordinator`、host 纯确定性 `ExploreEngine`、UI 可选焦点提示
（带 `surfaceId` / `generation` / `revision`）。

(2) **"已交付依赖"说重了**。`lsp.symbols` 需先给 `path` 选语言 provider，不是跨语言 workspace 符号索引；符号图只有 `file → defines →
symbol`，无 references / calls / imports 边，无 PageRank API；`searchSymbols` 是 JS 扫描 + `includes` 计分（`knowledge/store.ts:800`），
不是 AC / BM25；`related` 只接受注入的 `findNode` / `getNeighbors`，无生产实现；恢复日志知写不知读；git co-change、工作台焦点、
最近失败输出入口都无服务。plan 3.2 改为**依赖矩阵**（available / partial / unavailable），缺失来源只能降级并在结果里报告该来源
状态，不得折叠成一个 `partial: true`。

(3) **外部证据被外推**。OpenLocus 自己标 B16-J 为 *bounded synthetic evidence*；FRK-B 是 R14-S sanity 小套件且报告明确
`runtime_default_method_scale_claim: false`；后续 FRK-E 结论是 *no proxy lift over best baseline*。因此"目标 + 支撑"是优先输出形状
而非硬要求（精确 `where` 可能只需目标），"答案几乎总在前十"是待验证假设而非前提；设计 6.1 改写为假设 H1–H4 各带证据边界，
并把 H1（结构可替代多轮）标为**无直接实证、最需回放集检验**。来源固定到远程与提交：OpenLocus-Lab
<https://github.com/Youzini-afk/OpenLocus-Lab> @ `eecd28b218b2be211074db2bdd9e7dad43100336`；OCE <https://github.com/oce-ai/oce>
@ `a359272560bbbdb321055aaed6c16ba1f4e06887`；本地检出路径不作设计依据。

(4) **T4 无法执行 D-069 写的门禁**。`evaluation/harness/cases.json` 与 `scripts/harness-replay.mjs` 只记成功、token、人工介入、失败
类别，没有查询、目标 / 支撑标注、正确 span、各 baseline 返回包；用 reference commit 的改动文件当正确上下文会把不被修改的支撑
文件算成浪费，"后来读过的 token"会惩罚自包含的好结果。改为**两级门禁**：独立的检索回放集（`evaluation/retrieval/cases.json`，
含 query / questionType / targets / support / commit；B0 现有 grep、B1 独立实现的同输出预算 BM25、B2 explore v2；FileRecall@K、
Span F0.5、首个正确文件位置、返回字节、来源状态）决定是否进入真实会话实验；T4 端到端再决定是否默认注册。

(5) **硬数字无定标依据**。1.5 / 4 s、6000 token、references 20、500 commits、300 字符、60% 重叠、每文件 2 块、分差 0.1、20 条反馈、
步进 0.05 全部没有 Piarium 数据支持，且 host 不知 tokenizer 不能声称"硬 6000 token"。参数分三类：硬边界（父请求取消、workspace
containment、judge 只返回候选 ID）不可配置；软预算与观测目标（延迟、候选数、输出**字节**——token 由 Coordinator 按活动模型换算）
为可配置默认；首版阈值标 experimental，待回放集定标后写回。

(6) **反馈 bandit 不能自动改权重**。"模型随后 read / edit 的文件"有位置偏差、支撑不被改、分析任务无 edit、自包含结果减少 read
反而是成功、压缩后 `inContext` 旧 step 失效、read 后文件已变。第一版只记 telemetry；排序用 **RRF** 融合各来源排名，不做量纲不同
信号的加权和。

另外接受的具体更正：阶段不是"全并行"，画出依赖图（intent 只在 fan-out 结束前回来才补一轮；judge 依赖 fuse 的 top-N）；
`references` 不是调用图、无 call hierarchy，删去"调用图 BFS"；OCE 的 300 字符合并修的是其 AST 切块列切分伪影，不适用于
`documentSymbol`（它本身区分 `range` 与 `selectionRange`），删去；OCE 两遍覆盖度选择器是平铺 chunk 选择器，打包必须 bundle-aware
（先在 bundle 内降级支撑再丢 bundle）；`usedLlm: boolean` 与单一 `partial` 改为每来源 `ready | empty | unavailable | failed | stale`、
每次模型调用 `not-requested | completed | timed-out | failed`；LSP 返回路径与派生支撑路径重新过 workspace scope / realpath 授权；
judge 看到的仓库正文标不可信数据且只能返回候选 ID；标识符用 Unicode `\p{L}`，问题类型分类同时支持中文线索。

原因：D-069 把一个值得做的方向写成了可以照着做的规格，而它的输入、依赖和证据都还不支持这一步。评审方（另一位复审 agent）的
六点全部经代码与来源核实成立。

考虑过的替代：退回 v1——v1 的结构（平铺命中、行窗口、只搜磁盘、无关系）不是权重问题，方向仍以 D-069 为准；立即按 D-069 开工
并在实施中修正——三个进程的所有权与依赖矩阵不先钉，实施必然把 host 写成全能视角。

影响：`agent-harness.md` 6.1 第二级重写（候选架构、H1–H4 与边界、所有权表、依赖图、来源级状态、参数三类、两级门禁、来源提交）；
`agent-harness-plan.md` 3.2 重写（六步交付顺序、所有权表、依赖矩阵、`ExploreSeeds` / `ExploreBundle` / `ExploreResult` 含状态枚举、
参数三类表、检索回放集 schema 与 runner、测试清单）；status 3.2 行；D-069 在索引中标 superseded in part。

状态：已实施（文档）；代码仍是 v1；开工条件见 plan 3.2 交付顺序第 1、2 步

### D-072 · 2026-09-05 · 更正 D-069/D-070，并收口记忆、证据与执行的契约

类型：设计修正

决定：

- explore 保持候选架构和 default-off。H1 改为“结构查询减少机械跳转”；RRF 只融合排名，不用分差充当答案置信度。目标与支撑按问题
  组成 bundle，支撑可为空，预算降级不预置统一的支撑删除顺序。可选 intent/judge/查询修复是待比较的机制，不把任何一种定成必经阶段。
- pi-host Coordinator 拥有上下文、模型/凭据、调度与用量；Host Engine 拥有确定性搜索、来源授权、内容物化、融合/打包与 OutputStore；
  surface 按 D-071 自动提供本窗口草稿。Host 不等待或直接访问 pi-host 模型回调。judge 必须在候选物化后调用，只能返回候选 ID；
  补查若日后采用，也只能提交经过类型和路径校验的查询操作。正文作为不可信数据传入模型。
- 每来源保留 ready/empty/unavailable/failed/stale/timed-out，未请求与取消也独立表达。每次模型调用的真实结局、结果是否采用、用量是否
  可得分别记录；迟到但成功不能伪装成超时，失败/取消不能伪造零费用。Host 计 UTF-8 字节，pi-host 只有拿到真实 tokenizer 时才声称
  精确 token 数，否则保留估算标签。所有未定标数字只作实验候选，不形成产品默认或检索通过条件。
- `inContext` 按实际请求保留的 revision + span + request/context generation 判覆盖，不按文件或 read step 去重。当前不具备该证明时
  返回正文。新建独立 retrieval replay，人工标注目标 span 与可选支撑；baseline 查询不能由正确答案泄漏产生。固定比较预算与 K，记录
  baseline 返回包、召回/片段质量、延迟、输出量与来源状态。离线结果支持进入测试者真实任务验证，不把少量样本包装成统计不劣证明。
- `TranscriptRef` 耐久指向 Pi 持久记录，**不承诺恢复被截断的完整正文**。可重建来源必须有能解析正文的既有对象；不可重建观察要有
  操作所属的耐久产物，或明确临时。OutputRef 不作为压缩恢复的唯一来源，不把所有输出改为永久保存。
- keeper 写入需要读取时版本与分支归属；plan 只能标记条目，不能整块 replace。压缩前的 checkpoint 必须证明相关分支上待移除的
  已处理连续区间；块修订与水位一起提交，部分失败不推进完整水位。缺覆盖或来源不可用时明确降级、保留 Pi 安全切点并回退默认压缩。
  这证明机械覆盖，不保证语义无遗漏；撤销“结构上不叠加损失”的承诺。
- 区分 record-only（只记录/展示）、assist（进入 Zone 2，但 Pi 压缩）、takeover（检查点参与接管）；三者之外保持关闭。现有
  `shadowMode:true` 实际是 assist，保留其行为，不宣称 record-only 已实现。当前 memory 输出协议与模型不变，真实效果由测试者验证。
- Workbench Profile 归展示，Agent Profile 归执行；工具/system 的冻结以一次执行配置世代为界，持久 session 可在用户操作下换新
  Run/配置。单会话实验配置先沿现有 launch 接缝提供，不以完整 RunManifest 为前置。结果/验证/集成应绑定明确版本，操作回执与观察
  送达分别补最小契约，不顺带引入完整 Work Graph、全局并发上限或新的单 Host 禁入规则。

原因：本次代码核对确认 memory get/apply 没有版本与分支字段，`applyOps` 允许 replace plan，compaction 仅检查 keeper 块存在，
截断后的文本才进入 Pi 持久消息，观察游标在结果发送前推进。报告指出的问题成立，但具体新对象与算法仍需按真实消费者逐项实现。
当前 takeover 默认关闭，不能将候选接管缺陷描述成默认已经发生的历史丢失；Host/会话清理会重置游标，送达缺口需按仍保留基线的窗口验证。

外部证据固定在设计 6.1 的远程 commit 链接；D-069 原文中的本地路径按 append-only 保留为历史，不再作为现行证据入口。
Anthropic [工具缓存](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)明确 `tool_choice` 变化使
messages 缓存失效，[上下文清理](https://platform.claude.com/docs/en/build-with-claude/context-editing)明确 tool-result clearing 会触发缓存重写。
OpenAI [Windows 沙箱实现](https://openai.com/index/building-codex-windows-sandbox/)证明存在原生路线；D-071 不实施 Windows 沙箱是用户选择，
不是“没有技术路线”的推断。

影响：设计 2/5.7/6.1/8/9/10/12，plan 0.7/2.4/2.6/3.2 与阶段验收，status 缺口与下一步表。仅文档修订，不升级实现状态。

状态：已回写文档；代码实施与测试者验证尚未开始。

### D-082 · 2026-09-06 · 3.2（发起窗口快照与 draft-aware explore）

类型：实现决策（D-071/D-078 的窗口正文纵切）

决定：用户从 Piarium UI 发送 prompt、steer 或 follow-up 时，Document Registry 自动取得该 surface 在会话 workspace 内的全部
dirty records。没有 dirty buffer 时直接声明 disk，不增加捕获请求；存在 dirty 时，先以现有 owner/generation 发布准确路径、
baseRevision 与 localEditRevision，再经 UI-authenticated Documents HTTP 路径把正文交给 Application Host。Agent runtime 请求只携
`AgentInputContext` 的不透明 snapshot ref，或 capture unavailable 加已知 dirty paths；正文不进入 prompt 参数、broker 事件、日志或广播。

DocumentAuthority 在捕获时核对 workspace、owner/generation、完整 dirty path 集合、每个 base/local revision，并重新做资源 containment
解析；任一变化使本次来源 unavailable，不取磁盘冒充。通过校验的正文复制进 Host 内存的内容寻址 SurfaceSnapshotStore：pending
快照只服务正在送达的输入，Pi 接受输入后 commit 为 active 并释放上一 active，发送失败 release，session drop 清理。后续编辑不改变
已捕获正文；surface 断开不删除 active snapshot。Host 重启会使内存快照过期，后续读取按 dirty paths 明确 unavailable，不声明持久。

SessionHost 在输入执行期间切到新 context，拒绝或发送失败恢复上一 context；CLI/headless 未携来源时切到 disk。快照 commit 属于输入
已接受后的生命周期记账：它失败时将新来源降为 unavailable、尝试释放并写 Host warning，绝不能把已经开始的 Pi run 报成发送失败，
从而诱发重复消息。HostServicesBridge 为 Harness 请求自动附当前 context，模型不能给 `explore` 伪造或选择 surface 参数；Router 仍以
broker actor 校验 session/workspace/capability。

`explore` 对 snapshot 中的 dirty paths 删除 rg 的磁盘命中，在固定草稿正文中执行同一 literal 匹配，再从同一 revision 切片；其他
路径继续读 Documents disk。snapshot 缺失/过期时，已知 dirty path 只返回来源问题。所有草稿路径和派生命中再次经过 actor scope 与
realpath-aware authority；snippet 标明 `disk | surface-draft` 和固定 revision。融合前不以 excerpt limit 删除 draft 候选。连续中文问题
通过 `Intl.Segmenter` 增加可搜索词，同时保留合法 Unicode 标识符和引号字面量。

边界：本次只让 `explore` 消费自动 surface snapshot；Pi 原生 `read`、现有 `grep`、LSP 共享 live buffer 和 isolated thread baseline
尚未切到该固定视图。结构图节点也尚未记录可与正文核对的 document revision，因此不把现有 symbol helper 直接混进结果。下一切片先
复用本引用接线程草稿基线，再为结构来源建立明确版本绑定。

原因：已有 recovery journal 服务于崩溃恢复，会被后续编辑更新，不能充当一轮输入的不可变正文；把正文塞进 runtime prompt 又会绕过
Documents authority。单独捕获、内容寻址、引用传递同时满足窗口所有权、固定读取和低延迟；已知 dirty 失败时禁用该路径的磁盘回退，
避免“功能仍能跑”掩盖读取了错误版本。

考虑过的替代：只把显式 editor attachment 注入 prompt 不能覆盖默认窗口语义，也不能被 thread/工具复用；让 Host 直接读 LSP buffer
会混用另一时刻或另一 surface；把每个 snapshot 永久持久化会在没有恢复消费者前制造新保留权威；捕获失败阻断用户消息则把辅助上下文
故障升级成会话不可用。

影响：protocol runtime/Harness 输入来源；application-client Documents API；UI DocumentRegistry、Pi session store 与 review flow；
runtime-broker dispatcher；pi-host SessionHost/HostServicesBridge；Application Host Documents authority/routes/snapshot store、Harness
router/service/explore；设计 6.1、plan 0.7/3.2、status、architecture 与模块文档。

状态：已实施；本地证据和仍未接的固定视图消费者见 status.md。

### D-085 · 2026-09-06 · 普通 read/grep 消费固定窗口草稿

类型：实现决策（D-082 固定来源的工具纵切）

决定：`search.content` 接收 Router 已校验的 AgentInputContext。surface dirty paths 先按 actor scope、请求 path 与 glob 过滤；
Application Host 在 rg 流式结果计数前按规范化 resourceId 排除它们的旧磁盘命中，再在消息发送时的固定正文上执行 regex/fixed string、
大小写与同一 glob 过滤，合并后统一排序、context 和 limit。已知 dirty snapshot 不可用时返回 unavailable，不从磁盘补值。公开但从未
实现的 `type` 与 files/count mode 从协议和工具 schema 删除；before/after/context、glob、fixedStrings 与 ignoreCase 贯通真实后端。

普通 `read` 继续使用 Pi 0.84.3 的 `createReadToolDefinition`，只新增一个同名 source wrapper。Application Host 声明
`harnessDocumentRead` 后，worker 在每次执行前以受授权 path 请求 `document.readSource`：非 dirty 返回 disk sentinel 并直接执行 Pi
原生 read；dirty 返回固定 revision 的 save-compatible UTF-8 bytes（保留 BOM 与换行），再把这一次 bytes 交给相同 Pi definition。
因此分页、截断、错误和磁盘图片 attachment 不复制实现。Host 未声明能力或用户关闭该覆盖时保留 Pi built-in。来源正文不进入工具参数、
请求事件或日志，surface revision 写入 tool details；Windows 等不区分大小写的工作区按等价 resource identity 查 snapshot。

边界：find/ls 尚未叠加 dirty-only 路径；LSP/符号图还没有与固定正文绑定的独立 revision/session；surface snapshot 仍是 Host 生命周期内
的输入来源，Thread dispatch 已按 D-083 复制为持久基线。上述缺口继续直接实施，不回退已接通的 read/grep。

状态：已实施；生产接线与验证见 status 3.2。

### D-086 · 2026-09-06 · 普通 find/ls 消费固定窗口路径快照

类型：实现决策（D-082 固定来源的目录枚举纵切）

决定：新增内容为空的 `document.pathOverlay` Host method。Router 以 `allowMissing` 授权请求根；Documents 先核对同 session、workspace
和 ready surface snapshot，再返回相对请求根的 fixed dirty file、每路径 revision 和虚拟目录祖先。请求根不在 dirty 集合时返回 disk
sentinel；相关快照过期或不可用返回 Harness `unavailable`，不以磁盘空结果替代。Host 复用 picomatch 的 basename、brace/extglob 和
Windows nocase 语义筛选 find pattern，不在协议或事件中传正文。

`find`/`ls` 仅在 Host handshake 明示 path-overlay capability 且对应 Settings 工具开启时同名覆盖。find 对固定 entries 与原生 fd 结果去重、
确定排序后交回 Pi `createFindToolDefinition`，保留目录后缀、limit、通知和 50KB 截断；ls 通过 Pi `createLsToolDefinition` 合并 immediate
磁盘项和虚拟子项。固定 snapshot 对已覆盖路径的 file/directory 类型优先，避免磁盘漂移被 Pi 原生 stat 循环静默丢弃。

边界：snapshot 当前只表达 dirty text file exists，不表达删除或 rename tombstone；LSP、固定正文 revision 和隔离线程物化仍分别由既有纵切负责。

状态：已实施；生产接线与验证见 status 3.2。

### D-088 · 2026-09-06 · 3.2（写入使固定窗口草稿在该路径上失效）

类型：实现修正（D-082/D-085/D-086 的读取语义缺陷）

决定：固定窗口草稿是一轮输入，不是永久权威。Piarium 观察到某路径被写入后，**该次写入之前捕获的每个 snapshot 都停止用草稿回答这个
路径**：`document.readSource` 返回 disk sentinel（Pi 原生 read 因此读到刚写的字节），`search.content` 与 `explore` 不再排除它的磁盘命中、
改按普通 rg 路径搜索，`document.pathOverlay` 不再枚举它，`lsp.*` 导航按磁盘绑定，`thread.dispatch` 的草稿基线不再叠加它。写入之后
捕获的 snapshot 保留自己的草稿——那份草稿正是用户当时屏幕上的正文。

观察来源两条，都是 Host 侧可靠信号：Documents 权威的 write/move/delete（含用户保存），以及 Pi mutation journal 的 `after` 阶段且
`succeeded === true`（覆盖原生 `write`/`edit`/`apply_patch`）。journal 那条在**确认工具之前**被 await，因此同一回合里紧接着的读取不可能
还看到写前的草稿。journal 记账失败不影响失效判定——文件确实被写了。绝对路径按工作区根解析，落在根外（隔离线程的 worktree）不失效
本工作区的草稿。

完整性检查保留：`thread.dispatch` 仍要求请求的每个 dirty path 都被交代清楚，只是判据从"全部克隆到"变为"克隆到的草稿 ∪ 已失效的路径 ==
请求集合"。已失效路径以 `supersededPaths` 显式返回，不静默消失。`agentInputDraftPaths` 返回"本轮固定来源仍拥有的 dirty 路径"，
过期捕获仍返回全部已知 dirty 路径，因此 D-085 的"已知 dirty 不可用时不回退磁盘"不变；失效与不可用是两件事，前者是磁盘成为更新的
权威，后者是我们丢了本该展示的正文。

边界：shell 与外部进程的写入仍未被观察，与恢复日志同一边界；这类写入之后草稿继续服务该路径。**另一件事本决定不做**：Pi 原生 `edit`
的 `old_string` 匹配的是磁盘正文，而 `read` 给的是草稿，两者不同时首次编辑会报"字符串未找到"。让 `edit` 改按草稿匹配等于把用户未保存
的改动顺带落盘，违反 D-083 明确的"草稿集成不自动保存磁盘"，因此保留为独立产品问题，不在本修正内改。

原因：D-085 让 `read` 消费固定草稿，但没有定义"写入之后草稿还算不算权威"。实际后果不止读不回自己的写：`grep` 会把该文件的磁盘命中
整体排除并只在旧草稿里匹配，agent 刚写的代码对 `grep` 完全不可见；`find`/`ls` 继续枚举旧快照；dispatch 会把旧草稿叠回子线程基线，
覆盖已经写进磁盘的结果。读回自己的写是工具循环的基本前提，缺了它 agent 无法验证自己的编辑。

考虑过的替代：把该路径从 snapshot 的 `resources` 里直接删除——会破坏 `samePaths` 的完整集合校验，把失效误报成过期；让 `read` 在写入后
返回 unavailable——把可用的磁盘正文说成不可读；只修 `read` 不修 grep/find/dispatch——留下更严重的不可见性。

影响：`lib/documents/surface-snapshot-store.ts`（`superseded`、`observeWrite`、`draftPaths`、clone 的 `supersededPaths`）、
`lib/documents/authority.ts`（`publishMutation` 失效、`observeAgentWrite`、`agentInputDraftPaths`）、`lib/recovery/turn-coordinator.ts`
（`observeToolWrite`，确认前 await）、`index.ts` 接线、`lib/harness/search-service.ts` / `explore-service.ts` / `service-host.ts`、
`lib/harness/thread-runtime.ts` 的 dispatch 完整性判据；plan 3.2、status 窗口读取行与 3.2。

状态：已实施；验证见 status 3.2。

### D-089 · 2026-09-06 · 3.2（读写来源不对称：写入前拦住并说清楚）

类型：实现修正（D-085 读取语义的写入侧对偶；用户已决定语义）

决定：新增 Host method `document.writeGuard`（capability `write.document`，路径以 `allowMissing` 授权）。原生 `write` / `edit` /
`apply_patch` 在**同一条路径租约内、写入与 journal before 之前**先请求它；返回 `conflict` 或 `unavailable` 时工具以该原因失败，
磁盘、journal 与工具结果都不产生任何写入痕迹。判据只有一条：**本轮该路径的固定草稿仍有效，且草稿正文与当前磁盘正文不同。**
草稿与磁盘相同（脏缓冲但内容一致）、路径没有草稿、草稿已按 D-088 失效、本轮来源是 disk，全部照旧放行。

拦住时给的是可执行的原因：文件有未保存的编辑器改动、你读到的是草稿而写入落在磁盘、现在写会把用户未保存的改动落盘，本次什么都没写。
消息不含正文，草稿修订以 `revision` 放在结构化结果里。磁盘缺失（只存在于未保存的新建草稿）与磁盘为 binary/unsupported 同样按 conflict
处理——无法证明写入安全就不写。已知脏路径但草稿不可读（快照过期、Host 重启）返回 `unavailable`：既不假称安全，也不谎称冲突。

**本轮唯一的解法是保存，消息只说保存。** 用户保存走 Documents write，因此按 D-088 使该路径草稿失效，重试即是普通写入。放弃不行，
而且不该行：本轮仍按捕获的草稿回答该路径，把它写回磁盘等于把用户刚否决的改动重新落盘，与拦住的初衷同一个错误。消息因此明说放弃不
解除拒绝、需要在后续回合重新读取，避免 agent 在同一条建议上反复重试。`unavailable` 同理不建议原地重试：固定来源已经丢了，本轮内
保存也换不回它（`read` 在快照过期时先于 superseded 判定返回 unavailable），消息让 agent 报告路径并在后续回合重读。

`apply_patch` 在拿到全部文件租约后先逐个预检，任一路径冲突即整体拒绝，不留半应用的树。worker 侧先看本轮 `AgentInputContext`：
来源是 disk 或没有 dirty path 时根本不发这次请求，因此普通写入零额外成本；只有"用户此刻有未保存文件"这个窄窗口才多一次往返。
该检查与固定草稿 read 覆盖共用 `harnessDocumentRead` 握手能力——两者是同一套来源契约的两面，Host 不提供草稿时读写本来同源，
无需守卫。

明确不做：让 `edit` 按草稿匹配 `old_string`、或让 `write` 把草稿正文写回磁盘。那等于把用户尚未决定保存的改动落盘，正是 D-083 在
子线程集成路径上拒绝的事（宁可返回 `surfaceTargetPaths` 零写入）。原生工具的匹配语义完全不动。

边界：守卫协调的是受控写入。shell 命令、外部进程与第三方工具照旧不经过它，与 D-088、恢复日志同一边界。守卫请求本身失败（传输、
超时）按失败处理，写入不发生——在这个窄窗口里无法证明安全就不写；理由随错误消息可诊断。

原因：D-085 让 `read` 消费固定草稿，`write`/`edit` 仍落在磁盘，于是同一路径读写不同源。后果不只是 `edit` 的 `old_string` 匹配失败：
agent 拿不到匹配就会退化成 `write` 全量覆盖，而它手里的正文是草稿加自己的改动，用户未保存的编辑因此被静默写进磁盘。这条路径把
D-083 保护的原则在父会话自己的写入上破掉了，且发生时没有任何提示。

考虑过的替代：把拒绝挂在 journal 的 `accepted` 布尔上——那个布尔的既有语义是"记账是否成功、失败不阻断工具"，复用会让记账故障开始
阻断写入；该路径 read 直接给磁盘——agent 就看不到用户屏幕上的正文，与 D-082 的窗口语义冲突；做成用户设置——先交付明确语义，
需要时再加开关。

影响：protocol `DocumentWriteGuardResult` / 方法表 / capability 映射；`lib/documents/authority.ts` `inspectAgentWriteTarget`；
`lib/harness/harness-services.ts`、`router.ts`、`service-host.ts`、`index.ts` 接线；pi-host `host-services-bridge.ts`（暴露
`inputContext()`）、`workspace-mutation-journal.ts`（`assertWritablePath` 与锁内预检）、`harness/apply-patch-tool.ts`、
`harness/select-tools.ts`、`session-host.ts`；设计 6.1、plan 3.2、status 窗口读取行与 3.2。

状态：已实施；验证见 status 3.2。

### D-090 · 2026-09-06 · 3.2（explore 的快速检索策略：替主 agent 做掉机械步骤）

类型：设计修正 + 实现缺陷清单（D-078 目标重述；用户采纳 2026-09-06 外部设计评审的方向，逐条核对后记录）

决定：`explore` 的目标改写为一句话——**基于主 agent 当前的问题与已知线索，用本地检索和结构追踪取得一小组可直接判断的代码原文；
尽量消除机械性的搜索—阅读往返，保留尚未解决的语义问题。** 优化对象是"主 agent 获得足够证据、能推进下一步的时间"，不是"返回一批
相关文件的时间"。边界只有一条：**机械依赖由 Host 接着走**（找到名字才能查定义、找到定义再找注册点、读到参数再读实现），**语义假设
留给主 agent**（"问题可能不是权限而是缓存键"）。内部存在串行依赖不等于需要串行模型调用。

按主 agent 此刻缺什么分四种情形，各有合适的能力与返回，不塞进一条管线：知道名字不知道位置（符号/路径/字面量定位 → 定义或关键
出现点）；知道概念不知道仓库用什么词（概念到词汇的桥接 → 少量可信入口，保留候选分歧）；找到文件不知道关键部分在哪（文件内定位与
结构化阅读 → 相关语法块、签名、必要条件）；找到入口不知道如何连到另一处（有方向的关系追踪 → 连接两端的原文与关系依据）。

工具分工改写：只需精确匹配用 `grep`；需要定位后顺便理解相关上下文用 `explore`，即使已知确切符号。不是"知道符号用 grep、不知道
用 explore"，`grep → explore → retrieval` 也不是必须逐级失败才能升级的阶梯。

`explore.search` 增加 `anchors?: string[]`：主 agent 已知的符号、方法名、错误文本、路径片段。`question` 回答"想知道什么"，`anchors`
表达"已经知道什么"。锚点是强种子：优先取得候选、有独立于泛词的预算、按字面匹配；但**不是硬过滤**——主 agent 猜错的同义词不能把
正确实现排除掉，它只是候选。不要求主 agent 编写检索计划或正则。

候选获取与融合：词项分组——同一概念的变体（原始标识符与其拆分词、字面量、路径线索、中文分词）用于扩大匹配，不同概念之间的共同命中
才增加相关性；精确符号与引号字面量保留高辨识度。候选预算与输出预算分开：`limit` 只管输出的摘录条数，候选获取用独立的工作预算，
达到扫描预算时明确返回未搜完。`explore` 不继承 `grep` 的展示排序（命中数 + 测试路径惩罚 + 深度惩罚）作为相关性定义，测试目录偏好由
问题决定。脏路径叠加统一走 search-service 一条路径（传 actor 与 inputContext，后端在计数前排除），`explore` 不再自带第二套草稿匹配。
RRF 融合的是不同信息来源的名次，不掩盖单路本身只是命中数排序。

物化：先用便宜信息排候选，按需读取当前来源正文，输出满足后不再无条件读完；未读候选记 `not-requested`，不混进 `empty`。正文读取
可有受控并行，但目标是少做无用读取。

切片单位：**与当前问题相关、尽可能自包含的原文单元**，不固定为完整符号。小函数全文；大函数返回签名、命中所在语法块、必要外围
条件，明确标记省略区间，并保留完整符号的读取入口。不声称自动选出的片段语义完备。冷/热语言服务是显式执行条件："得到可读代码"
不依赖"语言服务器已经热了"，缺结构来源退回行窗口并说明来源状态。结构来源是带修订绑定的可插拔 provider，第一个实现是 6.4 的 agent
视图 `documentSymbol`（语法层请求，不等语义分析完成）。**tree-sitter 作为第二个 provider 是带触发条件的待决项**：出现第二个消费者
（注册/协议字面量等连接边的形状识别，或冷仓库的轻量符号目录），或实测 `documentSymbol` 场景的冷启动不可接受。引入前先在本仓库
量一次 agent 视图从冷启动到 `documentSymbol` 可用的时间。语法包按语言随应用打包、惰性加载，无语法包的语言退回行窗口；
"让 agent 视图对主要语言保持热"是性能开关，按 plan 0.4 不变量 11 正确性不依赖它。

连接点：注册点、协议字面量、配置键、事件名是一等检索连接点（例：`"explore.search"` 把 pi-host 工具、protocol 契约与 Host
`router.register` 连成一条链，LSP 给不出这条边）。查询时只从少数能可靠识别的调用/注册形状取证；无法确认的同名字符串标为关联候选，
不伪装成已解析的运行路径。

打包：内部尽量找全可能性，外部只给能支撑当前判断的材料；片段之间要互补——先比较文件内哪些片段最有用，再考虑集合互补，不做
"每文件最多 N 块"的普遍硬限制。歧义时返回区分依据与各自支撑原文，不急着请 judge 十选一。`explore` 在进入通用工具结果之前按字节预算
完成打包，装不下时说明哪个支撑未展开并保留可读引用；细粒度 provenance 放 `details`，模型正文以代码与可行动缺口为主。OutputStore
句柄保存完整打包正文与未展示候选的引用清单，是展开长材料的后备入口，不是每次的固定下一步。

可选模型增强按"当前缺的那一步"选一种：没有可匹配的仓库词汇 → 意图转换；已搜到材料但目标缺席或线索指向新方向 → 受限查询修复
（必须能提出新词项或入口，只选已有候选 ID 解决不了候选缺席）；候选多、都似成立、阅读成本高 → 候选比较。不默认
intent → judge → repair 全跑；这是策略，不是新的硬轮数不变量。

§6 开头"agentic grep 已被证明优于 embedding RAG"改为"词法、路径、符号是可靠的基础入口；语义召回用于弥补词汇不一致，不承担所有
检索任务，也不是基础可用性的前提"——与同节 H2/H4 自己标注的证据边界一致。embedding 在 Piarium 要回答的问题是"它有没有找回词法与
结构路径没找到的有用入口"。

已观察缺陷（代码可推导，非实测；均在默认开启的工具上）：
1. `explore.ts` 把 `input.limit` 传给 search-service 的 `limit`，后端 `maxResults = 3·limit` 且总命中截到 `limit`——要 3 段摘录时
   每个词项候选池只有 3 条命中。
2. `explore-service.ts` 调 search-service 不传 actor/inputContext，脏文件旧磁盘命中先吃预算再被事后丢弃；两套草稿匹配器语义不同。
3. 标识符、拆分词、中文分词、字面量在 RRF 里对等投票，拆得越碎权重越高；反引号字面量已提取但无优先级。
4. 每一路名次来自 `fileScore`（recency 因 TODO 恒为 1），`explore` 继承了 `grep` 的测试路径与深度先验。
5. 全部有命中文件顺序读完再 `slice(0, limit)`；默认最多 100 个文件串行读只为展示 20 段。
6. 排第一文件的全部窗口先入列，可占满输出；打包单元是按文件排好的命中列表。
7. `explore` 无自身字节预算；通用截断 32 KiB 头尾各半会裁掉中段片段并二次存入 OutputStore；句柄内容与已展示正文相同，
   `get_output` 不含被裁候选。
8. 工具描述 "Open question … broad questions" 超出无词汇桥接时的能力；`_onUpdate` 未用于模型提前消费，不得作为承诺。

顺序：先修上述缺陷并加 `anchors`（不需要新模型、索引或依赖），再让结构展开消费 6.4 带修订的范围（贯穿例子：`explore.search` 的
worker—protocol—Host 链；验收是主 agent 一次结果能否看见这条链，而不是"多了一个 symbols 调用"），再按观察到的"找不到入口"决定
词法索引、仓库文档关联、意图转换或 embedding。这改变 D-087 后"下一步是结构展开"的顺序。

不做：独立 retrieval benchmark 门禁——观察三件事即可：拿到 explore 后还做了多少纯定位动作（验证与新假设所需的阅读是正常工作）、
返回正文是否含关键判断依据（正确文件在列表里不够）、从调用到可用结果的时间与交给模型的正文量（冷/热/无 LSP 分开看）；出问题先分
候选没进来、打包丢掉了、来源不对、主模型没利用。不把 UI 流式早期结果当作主模型等待时间减少的证据。不现在建仓库级索引或引入
tree-sitter。不声称能省多少时间。

原因：§6.1 对"有哪些来源、谁拥有、失败怎么表示"已清楚，对"一次 explore 替主 agent 做哪些查找、返回什么、何时停、为什么省时间"
仍是通用管线形状。外部设计评审指出这一点并给出代码级诊断；逐条核对后代码诊断全部成立，其中 `limit` 耦合与脏路径路径分叉比评审
描述的更确定。评审约三分之一的主张（bundle 支撑可空、不预置删除顺序、模型增强不全开、纯算法默认、只记录不学习、修复接受类型化
搜索/导航）已在 6.1 中，问题在实现未兑现，不重复记为新决策。

考虑过的替代：按原顺序先做结构展开——会建在被前置截断的候选池上；只在工具描述里提示反引号、不加字段——用户选择正式字段；现在
引入 tree-sitter——没有第二个消费者、没有冷启动实测，先定接口不定库；让 LSP 常驻——是性能开关而非正确性条件。

影响：agent-harness 2（检索行）、5.0 工具表、5.7、6 开头、6.1（分工、策略段、seed/fan-out/fuse/slice/pack/模型增强、句柄语义）；
plan 0.7、3.2；status 3.2 与下一步；待实施：protocol `explore.search` params、pi-host `explore-tool.ts`、Host `explore.ts` /
`explore-service.ts` 及其对 search-service 的调用方式、模块文档。

状态：策略已采纳并回写；缺陷修正与 `anchors` 待实施（plan 3.2 "候选获取与物化" 行）；结构展开在其后；tree-sitter 待决（触发条件见上）。

### D-092 · 2026-09-07 · 3.2（候选广度按文件铺开，不按命中数深度优先截断）

类型：验收复验结论 + 修正方向（D-090 缺陷 1 未达成）

背景：D-090 第一组交付后复验。缺陷 2–8 与 `anchors` 成立并有真断言；缺陷 1 只做了一半。候选获取确实不再用 `params.limit`，但
`search-service` 的 `groupAndSort` 在候选模式下仍按"文件路径序逐个吃满总命中预算、吃完即 break"截断。实测：30 个匹配文件、每文件
12 条命中、预算 200 → 只有 17 个文件进入候选，`dir17/file.ts` 之后的 13 个一条命中都没进，`partial: true` 与 `totalFiles: 30` 如实
上报。这与缺陷 1 原本要消除的"大量通用命中把后面的文件挡住"是同一形状，只是阈值从 `limit` 抬到 200、顺序从 `fileScore` 换成字母序。
后端 `maxResults = 预算 × 3` 也按 rg 遍历序截断，两层截断叠加。

放大它的是每文件命中上限与排序所需信息不匹配：排名只读 `evidence.groups`（每文件每词组一票），**一个文件在一个词组里只需 1 条命中
就能确定其排名**，所以 12 个预算槽位里有 11 个花在不可能改变任何文件排名的命中上，候选广度被压缩约一个数量级。

决定：候选模式下按文件广度优先分配预算——先每个匹配文件取 1 条命中铺开，再在剩余预算内逐轮加深到 `hitsPerFile`；或候选模式只对
文件数设上限，不对总命中数做深度优先截断。每文件上限届时只服务窗口生成，不再决定谁能进排序。`search.content` / grep 路径不变。

不改：诚实上报已经到位（`partial` / `searched.incomplete` / 正文写明未搜完），本条不是不变量违规，是召回目标未达成；不引入新索引、
新模型或新依赖来绕过它。

同批复验发现的小项，一并修：`get_output` 提示在 `formatExploreOutput` 应用字节预算之后拼接，`showHandle` 为真时返回文本超预算约
一行；`explore-service` 用对象展开把 `searchIncomplete` 返回到声明的结果类型之外，且与 `searched.incomplete` 重复；单个空 anchor
字符串以 `invalid-params` 否掉整次调用，而 `buildTermGroups` 本就 trim + 过滤空串（anchors 来自模型，应过滤后在 `details.anchors`
说明）；`explore-service` 的 `searchPartial` 是被所有并行 `rgSearch` 共享的单一可变量，终值因再次 OR 而正确但按词项归因错误；
`fileScore` 移进排序比较器后由每文件一次变为 O(n log n) 次（仅 grep 路径，纯浪费）；候选排序中 `GROUP_WEIGHT` 除以 `RRF_K + rank + 1`
后每组贡献 ≤ 0.13，被整数量级的 `evidence.groups.size + 2 × anchors.size` 主导，权重表实际只在组数相同时当平手裁判——输出顺序仍
anchor 优先（打包阶段 `windowScore` 给 anchor +100），故只影响候选数超读取预算时的物化顺序。

交付形状：`8218af95`–`d910ed14` 四个提交在推送前重排为三个（搜索层 / 协议+引擎 / 工具+文档），原因是协议与其唯一生产者分开提交时
中间提交无法编译（实测 `tsc -p tsconfig.application-host.json` 两个错），且四条提交正文缺 plan 0.1 要求的验证与决策编号、并带了
禁止的 `Co-authored-by` 署名。提交未推送，重排不影响他人；`review-backup-d090` 标签留在原 `d910ed14` 上。

影响：plan 0.7、3.2（候选获取与物化行）；status 3.2 行与"下一步"。实施待接：`groupAndSort` 候选模式广度优先分配 + 上述小项。

状态：已复验并记录；候选广度与小项待实施，排在 3.11 第 1 步之前。

### D-144 · 2026-09-08 · 先提取对象，再处理问句

背景：`buildTermGroups` 把 `[$_\p{L}][$_\p{L}\p{M}\p{N}]*` 一律当 identifier（权重 4）。`where is explore.search registered on the host router` 会让 host/service/search/router 各投一票，并拿这些泛词去 `searchDefinitions`。`on`/`do`/`we`/`it` 会填满 40 条定义预算。

决定：先提取并保护对象。完整技术字面量（含 `.`/`-`/`:`）、引号/反引号、显式 anchors 是对象；拆分只作同组回退变体，不再单独投票。普通问句词是内容词，不驱动图、不拿 identifier 权重。关系词是闭表：register/registered/registers/注册/连接、import/imports/imported/导入、define/defined/defines/定义；`registers`/`imported`/`defines` 是同一英语词的屈折，不是新关系。其余一律 unknown。`on(...)` /「名为 on」是对象；单独输入 `on` 保留为短对象查询。中文按对象/关系/内容切，不建完整停用词表。连线值看 `.`/`:` 或协议斜杠，不把 `tree-sitter` 这种连字符包名当连接值；路径对象要有斜杠或真实扩展名，`explore.search` 不是路径。

不改：NLU、词法索引、IDF。本次观察到的文件广度可以软降权词法贡献，但不冒充语料频率，也不做硬判据。

影响：`explore-query.ts`；设计 6.1 seed；plan 3.13。

状态：已实施。

### D-145 · 2026-09-08 · 任务匹配分层，不再混加 RRF 与原始组分

背景：词组内按路径字母序生成名次再送进 RRF，`bun.lock` 在每个词组都是第一名。RRF 分再与 `GROUP_WEIGHT` 混加，五个泛词 +20，图定义权重 10 进 RRF 只贡献约 0.16。

决定：删除这两处。排名层次为：当前正文已核验的直接关系 → 完整对象提及 / connects 线索 → 该对象的精确定义 → associates / 名字含 → 散文词法。词法与文件角色只在同级比较。路径序只作同分稳定 tie-break。观察广度可软降权，不作硬过滤。

不改：既有读预算与字节预算；不引入 BM25。

影响：`explore.ts` rank/pack；设计 6.1 fuse；plan 3.13。

状态：已实施。

### D-146 · 2026-09-08 · 问题对象先查；在池里不等于已验证（修订 D-137）

背景：D-137 把连线种子限制在已选摘录正文。问题 1 的对象 `explore.search` 图里已经有两端，却要等第一次打包。已在 rg 池的 `harness-services.ts` 被 `already → continue` 挡住，永远不进补充物化。

决定：问题本身提供的完整连接值立刻 `findLinks`，明确符号立刻 `searchDefinitions`，明确路径直接读。读后新发现的种子仍按 D-137 展开。直接线索在既有 `maxMaterializeReads` 内优先物化，多个锚点轮流；不是所有 exact 档都保护——`explore` 的定义不是 `explore.search` 注册位置的答案。补充物化看是否已读取、是否已有对应当前证据；已读复用本轮快照。超预算的直接线索仍是 `not-requested`。

不改：D-137 的「读后展开」与独立图预算；D-090/D-139 读预算数值。

影响：`explore.ts`；设计 6.1 fan-out/物化；D-137 索引行。

状态：已实施。

### D-147 · 2026-09-08 · 证据绑定窗口，按所需证据打包，limit 是上限

背景：`graphBoost` 赋给文件里每一个窗口，问题 9 输出 9 段同一 fixture。`findLinks` 把 associates 标成 other end of connection。主循环 `selected.length >= excerptLimit` 即停，前 20 个错误片段把正确答案挡在外面。

决定：图理由只绑定当前核验成立的窗口。同一事实被图和 rg 发现不叠加票数。`connects` 与 `associates` 分等、分文案。对已物化文件复用 `literalCalls` 核验关系；没有结构能力时仍返回原文，理由降成「完整字面量命中；图曾指向这里」，不宣称已确认注册。打包覆盖问题所需证据，不是词组覆盖。`limit` 是上限：定位题找到可用注册片段可早停；「所有注册端」不能找到一个就停；一般问题不伪造语义充分性。因直接线索已验证而未启动的泛词记 `details.skippedQueries.reason=direct-verified`，与读预算 `not-requested` 分开。

不改：字节预算；取消传播；固定草稿。

影响：`explore.ts` pack/verify；protocol `ExploreQueryDetails` / `ExploreSkippedQueries`；设计 6.1 pack。

状态：已实施。

### D-148 · 2026-09-08 · 文件角色按问题决定；测试路径条件式；定义丢弃去重

背景：实现/注册类问题把 lockfile 和文档排在源码前面。D-090「测试路径不默认降权」需要落实为条件，而不是继续中性到让 fixture 压过注册入口。`definitionDropped` 按 hit 递增，同一超预算文件被多个词命中会重复计数。

决定：用文件名/路径/语言 id 轻量分类 source/test/docs/lock。实现/注册/写入优先源码；设计/取舍优先文档；依赖/许可/变更历史才轮到 lockfile。结构来源 `unsupported`/`unavailable` 不得成为相关性惩罚；「图里没有符号所以不是源码」不成立。问题里的 `host` 只是软范围线索，不是目录。问题明确查生产实现/注册时，对象与关系匹配相当则优先非测试；查测试时反过来；无法判断保持中性。`definitionDropped` 与 `details.graph.definitions` 按去重路径。

不改：D-090 原则本身；不按 provider 状态判源码。

影响：`explore-query.ts` fileRole；`explore.ts`；plan 3.13。

状态：已实施。

### D-149 · 2026-09-08 · 观察脚本收紧最小证据、阶段诊断、入口变体

背景：D-142 的 `wants` 是文件列表，过了也看不出图有没有发挥作用。把观察输出重定向进仓库会让 rg 读到正在写的文件。

决定：十问 `wants` 改成最小证据要求，由人写清，看到结果后不放宽。每题从既有 `details` 打阶段诊断（query / direct / target 断在哪一级），不建遥测。对同一入口加五个变体：裸字面量、反引号、英文礼貌句、中文礼貌句、`anchors`。确定性用例进单测，不进观察脚本。观察输出不写回被检索仓库。十问前后比较保持原始问题、预算、运行条件可追溯；足以证明已知入口能被利用，不足以证明泛化。

不改：新评测框架；不把十问当成性能基准。

影响：`scripts/explore-observe.ts`；status 3.13。

状态：已实施。

### D-150 · 2026-09-08 · 观察：已知入口已能利用；无对象的 how 问句仍会被读预算挡住

背景：3.13 十问按收紧后的 wants 重跑（已有目录 `--skip-scan`，输出在进程临时目录，未写回仓库）。不放宽 wants。

决定：相信观察。

- **已知入口可用。** 问题 1：`object=explore.search relation=register`，`harness-services.ts` 的当前 `register("explore.search")` 可见 #2，泛词 `service/host/router` 记 `direct-verified`。问题 9 与变体 V1–V5：注册端与请求端都可见（问题 9 请求端 #1、注册端 #3）。礼貌词、中文、反引号、`anchors` 都没有丢掉完整对象。改前这十问的成功片段里没有源码。
- **无对象的实现问句仍失败。** 问题 2/3/5/7/8/10 没有技术对象，内容词 rg 在 600 处截断，目标文件进了候选池但 `not-requested: read budget`。问题 4 读到了 `languages.ts` 但打包时被挤出。问题 6 读到了 `tree-sitter-provider.ts` 的 runtime 窗口，不是解析预算判定。这不是「图没用」，是对象优先把泛词降权之后，没有对象的问句回到词法洪水——本刀明确不建 IDF/词法索引。
- **连线展开曾按整文件 fileRelations 放大。** 第一轮问题 1/9 的可见包里出现 `shell.exec` / `lsp.diagnostics` 等无关另一端。已改为只展开**当前窗口正文**里出现的连接字面量，另加单测守住。这不是放宽 wants。

不把十问写成质量或速度提升。词法索引/桥接/embedding 仍按 plan 0.7 等下一次观察。

影响：status 3.13；本刀报告。

状态：已实施（观察记录）。

### D-151 · 2026-09-08 · 量具不得在未核验时报「已核验」；注册表窗口的无关另一端降等

背景：3.13 验收复跑发现三处。一，`92e03fa9` 改了设计文档却没 bump 它的 `Last updated`，该提交本身 `docs:validate` 是红的——校验跑在提交之前。二，`stageForTarget` 的 `need` 是可选的，缺省时「该文件有任何窗口可见」就打印 `relation verified`；十问里六个 target 没有 `need`，问题 6 因此报 `parse-budget: … relation verified → visible #2`，而那个窗口是 `ensureRuntime`（只检查 runtime wasm 在不在），与预算判定无关。三，D-150 记的「只展开当前窗口正文里的连接字面量」在生产形状下不构成约束：容器切片（D-098）让种子窗口等于整张注册表 `harness-services.ts:501-588`，37 个字面量全在正文里，所以 `related.query` / `thread.merge` / `surface.snapshot.commit` 的另一端仍以 `connects` 档进包，占据可见 #4–#6。守它的单测没有结构提供者，窗口退化成 ±3 回退，正好绕开了这个形状——与 D-140 同一类错误。

决定：

- 文档头部与提交同批。`docs:validate` 在提交后复跑，不在提交前。
- 观察脚本每个 target 必须写明所需证据（`label` + 匹配式），`need` 不再可选。所需证据从改前写好的 `wants` 推导，不看输出。未命中时打印 `visible #N, but <label> not in that window`，只有真正命中才说 `<label> verified`。量具不得声称自己没核验过的事。
- 按读发现的连线字面量，若问句给了对象而该字面量既不是对象也不含于对象，标 `offTopic`：排序上让本对象的字面量先占连接预算，`windowGrade` 把它降到 `support`。没有对象时不判无关——那时正文里每根线都同等在题。
- 守这条的单测必须跑真解析器的容器切片，且要先验证它在无修复时会红。

不改：连接预算数值；`limit` 与字节预算；无对象问句的行为。

观察（同一目录 `--skip-scan`）：问题 1 的三个无关另一端从 #4/#5/#6 退到 #11/#12/#13，排在全部八个 `explore.search` 窗口之后；`limit=20` 未被更好证据填满时它们仍占尾部槽位，**没有消失**。问题 1/9 与五个变体仍满足 `wants`。问题 4/6 的诊断改为如实报告窗口不含所需证据。尾部噪声与无对象 how 问句留给下一层。

影响：`docs/design/agent-harness.md` 头部；`scripts/explore-observe.ts`；`explore.ts` 连线展开与 `windowGrade`；`explore.native.test.ts`；订正 D-149 的诊断要求与 D-150 第三条。

状态：已实施。

### D-152 · 2026-09-08 · 已读文件的证据要重算；观察脚本自己在污染观察

背景：设计复查指出一条与稀有度无关的控制流缺口，我在 `7740bb5c` 上独立走通了：`prepared.push(...windows)` 只在 `materializeBatch` 里发生，而调度内层 `if (readPaths.has(candidate.path)) continue` 把已读文件挑掉。于是对象词那一趟（`runRg(objectPatterns)`）先读文件、按对象命中冻结窗口，随后内容词那一趟（`runRg(contentPatterns)`）的新命中只进 `byFile`，永远不产生窗口。同一个坑还有第二处：按读发现的连线里 `alreadyRead` 的另一端不进 `connectionPaths`，其 `graphClues` 因此从不被 `applyGraphLocate` 定位。这与 D-146「在池里 ≠ 已验证」是同一类，只是那次修的是调度，没修窗口重建。

有对象的问句才走两趟，所以这条缺口只可能落在十问里的 1、4、6、9 上；1 和 9 的对象本身就是所求关系的操作数，无碍；4 和 6 的对象只说明在谈哪个子系统，真答案在后来的内容词命中里，正是「文件对、窗口错」那两题。其余六题 `objectPatterns` 为空、只有一趟，没有东西可冻结——两个缺陷各管一半，互不替代。

决定：把「快照已取得」与「窗口已针对当前证据算过」分成两个状态。抽出 `buildWindowsFrom(path, snapshot, evidence)`，在内容词一趟之后、以及连线展开之后各跑一次 `refreshReadEvidence()`：已读路径的证据签名变了就用缓存快照重算窗口并替换 `prepared` 里该路径的条目。不消耗新文件读取预算——`snapshots` 按路径缓存；也不重新解析——tree-sitter 的解析缓存按内容哈希命名（32 条、空闲淘汰），同一份正文的第二次 outline/classify 是缓存命中。内容词先在已有正文上核对，再决定要不要为新文件花读取预算。

观察（同一目录 `--skip-scan`）：问题 1、9 与五个变体不变，无回退；问题 4 从可见 #19 升到 #6，问题 6 从 #2 到 #3，**都仍未命中所需证据**；六个无对象问句不变，与上面的划分一致。问题 6 在真实仓库里没翻转的原因不是冻结没修好，而是链条断得更早：`tree-sitter-provider.ts` 的唯一窗口理由仍是 `matched tree-sitter`，说明 `parse`/`budget` 这两个词对该文件的命中根本没回来（撞候选预算），刷新无从下手。合成探针供了这些命中，所以探针能红能绿，真实仓库还需要加权那一步。

另记一项自查发现：`scripts/explore-observe.ts` 里存着十问原文与 `wants`，它因此对每道题都是轻易成立的强词法候选。实测 15 次运行里它每次都进候选，并且**恰好在问题 4 和 6 各占一个可见槽位**——正是打包成为瓶颈的那两题。D-149 只约束了「输出不写回被检索仓库」，没约束问题文本本身也在仓库里。本刀不改问题存放方式，先在阶段诊断加一行 `self:` 把占用量报出来，不藏。

不改：读预算数值；候选广度分配；`limit` 与字节预算；D-151 的降等规则。

影响：`explore.ts` 物化与刷新；`explore-observe.ts` 诊断；plan 3.13 验收项；status 3.13。

状态：已实施。

### D-153 · 2026-09-08 · 查询内区分度：去重文件数、截断三态、不冒充全仓库 IDF

背景：3.13 之后比较器仍把 `breadthPenalty` 埋在 `score` 末位，且惩罚是二值的；命中行数也不是文档频率。所需数据已经在
`filesDropped` 与返回 hits 的去重路径里，不必建持久索引或改搜索协议。`partial` 混了 per-file 命中帽与丢文件，前者不影响
去重文件数。

决定：

- 每次 `explore()` 调用内建一张词组权重表。\(N\) 是本调用候选池去重文件数，\(df(g)\) 是该词组命中的去重文件数。
  公式起点 \(w(g)=1+\ln\frac{N+1}{df(g)+1}\)，只在覆盖为 `complete` 时加上对数项。这叫**查询内区分度**，不是全仓库 IDF——
  池子是命中预算截断后的有偏样本。选这个公式是因为它可执行、对稀有词单调，且未对本仓库定标；换公式要另记决策。
- 覆盖三态：`complete`（该词组已启动的变体都没有丢文件、也没有不完整后端扫描）、`lower-bound`（`filesDropped>0` 或
  后端扫描不完整）、`unknown`（后端命中帽、混合 `partial`、或词组未启动）。per-file 命中帽单独不把覆盖标成不完整。
  覆盖不完整的词权重停在普通匹配贡献 \(1\)，不拿未经证明的稀有奖励。
- 同一概念的变体共一行；同一文件反复命中同一词不增加 \(df\)。表写进 `details.distinctiveness`（`scope: query-pool`）。
- 本检查点**不改** `rankCandidates` 比较顺序。把连续 IDF 塞进现有 `score` 而不动 `tier → roleFit → objectCoverage`
  等于没改，所以权重先可见、后进比较。
- 观察量具加 `details.windows`（path / why / packed / 命中行），阶段诊断分开「匹配窗口从未生成」与「生成了但没被选中」。
  观察脚本把自身路径加入 `excludeResourceIds`。这改变与 `6f92b49c` 基线的槽位可比性：问题 4 和 6 各少一个被问题原文占用的
  可见槽，`wants` 与目标文件不变。`self:` 行仍保留，排除生效时应为 0。

观察（同一目录 `--skip-scan`；脚本路径已排除，相对 `6f92b49c` 问题 4/6 各少一个被问题原文占用的可见槽）：
问题 1 仍满足，`register("explore.search")` 可见 #2；问题 9 请求端 #1、注册端 #3；五个入口变体仍满足。
问题 2/3/5/7/8 仍是读预算；问题 10 仍是 `not acquired`。问题 4 可见 #6，诊断改为「匹配窗口从未生成」
（`capabilitiesFromSpec`/`tagsPath` 没有进入任何窗口）。问题 6 诊断改为「匹配窗口已生成 291-412，未被选中」——
与改前「该文件只有 matched tree-sitter」不同：量具现在能看见正确窗口已经切出来，断点在打包而不是生成。
权重行可读：例如问题 5 的 `associates` 为 complete/df=16/w≈4.05，`code` 为 unknown/w=1；截断词（`after`/`returns`/`when`）
标 `lower-bound` 且权重为 1。排名未改，无对象六题没有因此翻转到可见正文。

不改：排名比较器；`roleFit` 等级墙；窗口等级混淆；打包公式；读预算与字节预算；embedding / BM25 / 持久词法索引；
多词邻近性；D-090「测试路径不默认降权」原则。

影响：`explore-distinctiveness.ts`；`explore.ts` 召回与 `details`；`search-service.ts` `fileCoverage`；
`explore-service.ts` 转发；`scripts/explore-observe.ts`；protocol `details.distinctiveness` / `details.windows` /
`SearchContentResult.fileCoverage`；设计 6.1 词项分组；plan 3.14 检查点一。

状态：已实施（检查点一）。检查点二、三另记。

### D-154 · 2026-09-08 · 加权覆盖进主比较；角色退回有界偏好

背景：D-153 把权重算出来了，但 `rankCandidates` 仍是 `tier → roleFit → objectCoverage → score`。同 tier 同角色下，覆盖 4 个泛词的文件在 `objectCoverage` 就赢了，`breadthPenalty` 与连续权重都没有比较机会。D-148 的 `roleFit` 排在覆盖之前，任意弱相关源码压过任意强相关清单或文档。

决定：已核验且符合所求关系的直接证据仍走 tier 0，这条不动。其余候选的主比较改为 \(L(f)=\sum_g w(g)\,m(g,f)\)，同组不重复，完整原词 \(m=1\)、回退变体 \(m=0.5\)。排序键改为 `tier → L(f) → roleFit → 路径`。`fileRoleFit` 的数值表仍按问题域给明确目标让路（依赖→lockfile，设计→文档），但只在加权覆盖之后作区分，不再是跨不过去的等级墙。区分度在 \(L(f)\) 里，不回到比较器末位。
how 问句不再因为摘录包已满而停读：`limit` 是输出上限，读预算公式与数值未改，只是把名额用尽从停止条件里拿掉（D-151 停读一侧）。只比较「未读 \(L\) 是否高于已读最小 \(L\)」会漏掉同权互补文件，且第一批并行读 3 个文件后包已经满，测不到第四个文件；因此 how 问句直接用完剩余读预算。展开与打包里的 `offTopic` 仍留检查点三。

不改：`maxMaterializeReads` 与字节预算的数值；窗口等级与打包公式（检查点三）；D-090 测试路径原则；结构切片；多词邻近性；无对象问句上未核验 `connects` 仍走 tier 1（D-147）。

观察（同一目录 `--skip-scan`，脚本已自排除）：1/9 与 V1–V5 仍满足。3 的 supersede 可见 #15，observeWrite 仍读预算。5 的 classify 可见 #6，write 已读但匹配窗口从未生成。7 的 `document.writeGuard` 注册可见 #7，inspect 仍读预算。8 的 reclaim 可见 #3。2 已进池仍读预算（17 条未核验 connects 占 tier 1）。10 仍 `not acquired`。4/6 未翻转，断点仍在窗口生成/选择。

影响：`explore.ts` `rankCandidates` / `shouldStop`；设计 6.1 fuse 与物化；plan 3.14 检查点二。订正 D-148：角色表仍成立，它在比较器里先于内容证据的位置不成立。

状态：已实施（检查点二）。

### D-155 · 2026-09-08 · 查询内权重进入局部选择与打包；内容词不再拿完整对象档

背景：`windowsFor` 把 `hasDistinctive`（任何原词命中，含内容词）传给 `windowGrade`，只命中一个泛词的窗口也能拿 `full-object`（×200）。单独修它会让带对象的错误窗口赢得更稳（问题 6 的 `ensureRuntime` 对 `parseDocument`）。打包用新增词组个数和 `sameFile * 40` / `newFile * 8`，同文件互补块无条件让给第二个文件的弱片段。rg 候选预算丢掉的内容词也不会在已读正文里补种窗口。

决定：

- `full-object` 只给对象或锚点的原词命中。内容词原词命中是 `lexical`。
- 物化后在正文里核对全部有效词组。回退变体只更新文件级覆盖，不凭拆分新开窗口。原词命中若与已有同组命中相距超过一个小容器（24 行），另算一簇，最多 3 簇。结构只负责怎么切，不独自决定值不值得读。
- 打包用同一张权重表：自身 \(L\)、相对已选（含同文件已选窗口）新增的词组价值、正文字节成本。同文件出现新的本地词组给互补加分。入口窗口（接口/清单）已经占住的词组，同一文件里尚未选中的函数/方法仍算本地互补——机制片段不必再重复对象。换文件不再是奖励。`sameFile * 40` 拿掉。等级与角色是有界微调，不是墙。函数/方法单元有小幅偏好，不是新的等级墙。不给「文件里还有函数」的入口窗口额外抢位，否则测试夹具里的 function 会把定位题的 register 挤出可见前几条。
- `details.windows` 带上 `grade` 与可选 `unit`。量具用 unit 名判断窗口是否已生成，避免 hit 行只有 `outline: true` 时把 `capabilitiesFromSpec` 误报成从未切出。
- 多词邻近性不做。
- 观察脚本对自身路径做 `excludeResourceIds` 后再按后缀滤一遍 hit。问题 5 仍出现 `self:`：rg 排除之后，反向 import 把脚本重新拉进候选，问题原文在正文重扫里变成高覆盖窗口。这改变与检查点二的槽位可比性，不放宽 `wants`。

观察（同一目录 `--skip-scan`）：1 满足，`register("explore.search")` 在 `harness-services.ts` 可见 #3。9 满足，request #1、register #3。V1–V5 满足（register #2 或 #3）。6：`parseDocument` 进度/超限可见 #2。4：`languages.ts` `capabilitiesFromSpec` 可见 #16，`wants` 成立。5：classify 可见 #15；write 已读，匹配窗口从未生成；`self:` 占 3 个可见槽。7：`document.writeGuard` 注册窗口已生成 501-522，未选中；inspect 仍读预算。3：supersede 可见 #1；8：reclaim 可见 #2。2 仍读预算（未核验 connects 占 tier 1）。10 仍 `not acquired`。不声称质量或速度提升。

不改：读预算与字节预算数值；D-090 测试路径原则；结构切片本身；embedding / BM25 / 持久词法索引。

影响：`explore.ts` 窗口等级、正文重扫、打包；protocol `ExploreWindowTrace.grade` / `unit`；设计 6.1 词项分组与物化；plan 3.14 检查点三。

状态：已实施（检查点三）。

### D-156 · 2026-09-08 · 定位题有直接答案后不再展开或填 offTopic；无法判定无关 ≠ 已经证明有关

背景：D-151 把无关连线降到 `support`，但 `limit` 还有空位时它们仍被 `findLinks` 并填进正文。设计 6.1 写过「问句没有对象时不判无关，那时正文里每根线同等在题」，把「无法判定」写成了「已经证明有关」。

决定：定位题或双端题已经拿到直接答案时，`offTopic` 字面量不再 `findLinks`，打包池直接去掉 `offTopic` 窗口。降位不是省查找成本的替代，也不该继续污染上下文。`limit` 是上限，同时落在停止（D-154）、展开和打包。无对象问句可以按内容词、当前局部证据和可行动缺口做有限展开，不把整张注册表的连接都当潜在支撑。

不改：连接预算数值；无对象 how 问句上未核验 `connects` 的 tier（D-147）。

影响：`explore.ts` 连线展开与 `packComplementary`；设计 6.1 fan-out 与物化。订正 D-151：降等规则仍成立，定位题已有答案后仍用 `offTopic` 填满 `limit` 不成立。

状态：已实施。

### D-157 · 2026-09-08 · 关系相当时优先生产路径；窗口追踪不进生产载荷；正文省略是第三种失败

背景：3.14 验收在 `4b3ae079` 上核出三处，报告未记。

一，**测试夹具压过了生产注册**。问题 1 的可见顺序变成夹具 `explore-service.native.test.ts:19-51` #1、请求端 #2、生产注册 `harness-services.ts:501-588` #3；`6f92b49c` 上是请求端、生产注册、夹具。机制：夹具正文里也写着 `register("explore.search", ...)`，`looksLikeRegister && relation === "register"` 让它拿到同一档；D-154 把 `roleFit` 从第二比较键降到第三，D-155 又只给它 `roleFit * 3`，即 source 2 对 test 0 相差 6 分，对上 `windowWeight * 10` 里几十分的差距完全不够。D-148 那条「查生产实现/注册时，对象与关系匹配相当则优先非测试」因此失效。这是上一轮「角色退回有界偏好」的过度纠正——6 分不是偏好。

二，**`details.windows` 是没有门控、没有上限的观察字段，却进了每一次生产调用的协议载荷**。真实仓库实测：问题 1 为 52 个窗口 / 18.8 KB，问题 6 为 120 / 44 KB，问题 2 为 **482 个窗口 / 185 KB，`details` 总计 295 KB**，而模型可见字节预算是 24 KiB。`hits` 还重复了片段正文已有的文本。它既不进 `visibleText` 也不进 `storedBody`，唯一消费者是观察脚本。

三，**量具的两分法漏了第三种失败**。`stageForTarget` 判「窗口已生成」只比对命中行文本与单元名，不看窗口正文。问题 5 的 `write` 被报成「窗口从未生成」，实际是 `symbol-runtime.ts:147-219 unit loadGraphFacts` 已被选中、容器范围 147-238，而 `links.push({ kind: classified, ... })` 在第 220 行，落在大单元正文组装（D-098 签名 + 命中块 + 省略标记）省略掉的 220-238 区间里。这既不是「未生成」也不是「未选中」，而是**选中了、关键行被正文组装省掉**；省略标记本身已经把含答案的行号范围打印出来了。

决定：

- 关系证据相当时优先生产路径，用**比较**而不是加分表达：`relationRoleRank` 只在问句明确要生产实现（`preferTests === false`）且窗口的等级来自所问关系（`GRADE_RANK >= exact-definition`）时生效，取 `max(0, roleFit)` 作为打包的首键，其余一切不变。权重永远修不了这件事——夹具总能在加权覆盖上赢。
- 窗口追踪改为按需：`createExploreSearchService(host, { traceWindows: true })`，只有观察脚本开。生产调用不再携带。
- 量具补第三态：读目标文件定位所需证据的行号，若它落在被选中单元的范围内、且命中 `unit.omitted` 的任一区间，就报「单元已选中，但所需证据在打包正文之外」。判据取自已有的 `omitted` 标记，不新增遥测。

观察（同一目录 `--skip-scan`）：问题 1 恢复为请求端、生产注册、夹具，`register` 回到可见 #2；问题 5 的 `write` 改报 `unit loadGraphFacts 147-238 selected, but link write with the classified kind sits outside the packed body 147-219`；其余各题与 `4b3ae079` 一致，五个变体仍满足。

未验证：大单元正文组装是命中驱动的，一条没有任何查询词匹配的行永远进不了正文——**加权修不了这类缺口**，这是下一轮的独立材料，本刀不动 D-098。尾部噪声、无对象 how 问句的读预算、Q10 的截断池都未改。

影响：`explore.ts` packComplementary；`explore-service.ts` traceWindows；`scripts/explore-observe.ts`；plan 3.14 验收项；status 3.13/3.14。

状态：已实施。

### D-158 · 2026-09-08 · 语义来源排期 3.16；本地/远程按槽位选；不设信任门与花费守卫

背景：设计 6.1 从 D-090 起就为向量留了位（"配置的向量"、"有 embedding 时语义召回仍休眠"），此后十四个决策（D-144–D-157）全在
打磨词法加结构加图这条管线，每一份设计复查与执行 prompt 都写"不引入 embedding"。这是排序还是立场，维护者问了：**"你们一直在
回避不加嵌入模型，这不是一种保守设计么？"** 复盘后的答案是两半。到现在没加是诊断不是回避——四轮观察证明失败的题目标文件都在
候选池里，是排序、读取、切片、打包在丢，往漏水的管子里加水源没用。继续不加就是拖延——有一类失败词法永远修不了：问题的词和代码
的词对不上（"stale draft" 对 `superseded`；`links.push({ kind: classified })` 不含问题任何一个词）。这类在真实使用里比十问里
多得多。AFT（`cortexkit/aft`，同一问题域、已发布 Pi 适配器）把本地 MiniLM 嵌入、RRF 混合、指纹绑定索引做成了常规模块，
证明这是几个模块的工程量。

我的责任：这几轮我一直在设计 agent 的框架里工作，prompt 里每次照抄"不引入 embedding"，没有一次问它"那什么时候引入"。

决定：

- 语义来源排期为 plan 3.16，与 3.15 管线收敛并行；三件事——嵌入作为第三路路径候选、重排作为打包前的相关性判断、可选查询扩展。
  设计 6.1 的"不是基础可用性的前提"保留，含义是**不依赖**：没配模型、模型挂了、索引作废中，explore 仍返回词法加图。
- 每个环节本地/远程可选，按 `models.embedding` / `models.rerank` 槽位；**配了远程就用（效果更好），没配就本地**。这两个槽位与
  聊天槽位不同：有本地默认值，不存在"未配置退化为无 LLM"——本来也不是 LLM。远程接现有 provider 配置的新 model kind，
  复用 `baseUrl` 与凭据，不另起配置。
- 索引指纹 = 后端 + 模型 + 维度 + 切块版本；指纹变即整个索引作废，期间只有词法加图并如实报状态。这是数学事实不是防御。
- **不设信任门、不设花费守卫。** 维护者明确否决了我最初列的两条防御项，理由成立：用户配置远程提供商这个动作本身就是同意，
  而且他们每一轮聊天已经在把代码（含固定草稿）发给聊天模型，嵌入片段在性质上没有新东西；成本是用户自己的账，全库一次索引
  约两毛钱，编辑后增量重嵌是零头。harness 只做合理优化（增量重嵌、查询嵌入缓存、批量），不拿成本限制设计。这是这几轮里
  维护者第三次要把我从防御反射里推出来，记在这里作为以后写方案时的自查项。
- 远程放开的能力是这个槽位存在的理由：多粒度嵌入、一两百个候选的重排范围、代码专训或大维度模型、查询扩展。本地跑不动的
  东西远程能跑，设计按远程能做到的上限画，本地是降级。
- 本地默认 `all-MiniLM-L6-v2`，模型文件走 3.11 第 5 步为语法包建的分发机制；运行时 `@huggingface/transformers`；
  Electron asar 必须验。

不改：读预算、字节预算、`limit` 数值；D-090"语义召回不承担所有检索任务"的原则；plan 0.1 无兼容层。

影响：设计 6 头、6.1 fan-out 与模型增强、8.5 槽位表；plan 0.7 与 3.16；status。

状态：已决定，待实施（plan 3.16）。

### D-159 · 2026-09-08 · 采纳设计复查的三缺口框架为 3.15；记六处事实修正

背景：3.14 验收（D-157）之后，我把七条设计张力写成 prompt 交设计复查，倾向是"加一个答案规格、全部改字典序、每个候选加一个
stage"。复查对着 `fd394eb8` 核实后否掉了这三个倾向，并把七条归成三个互不替代的缺口：答案要求没贯穿决策（①②⑦、⑤的使用方式）、
选择与呈现没共同决策（③⑥、④一部分）、引擎没统一表达处理结果（④⑤）。它同时纠正了我六处说法，全部对着树复核成立：

1. **读预算不是统一的 23。** 两次 `materializeScheduled` 共用 `reads` 计数器对 23 比；图补充物化（`explore.ts:1349`）是独立切片，
   `reads += slice.length` 不对任何预算比。上限接近 46。我此前说的"17 条 connects 吃掉 23 个名额"这个因果链无法从代码反推。
2. **无对象的六题有部分规格可写。** 没有对象只是不能预先绑定符号，不是不知道要什么材料——Q5 明确要实现代码、机制级阅读、
   目标函数未绑定。
3. **`relationRoleRank` 不是谓词。** 它只查 `GRADE_RANK >= exact-definition`，不查窗口支持哪个对象哪个关系；请求端、任何精确
   定义、未核验连线都能过。且 `preferTests === false` 来自 `preferTestFiles` 对实现域 register 问句的推断，不是用户明说。
4. **管线不是线性七级。** 正文组装在 `windowsFor` 里、打包之前不可逆地发生；打包器拿到的是成品。
5. **`rankCandidates` 字典序不是"零系数"。** "任何 connection → tier 1"是把取舍写成不可补偿的等级，Q2 正在此出事。
6. **量具 `visible #N` 来自字节裁剪前的 `snippets`。** 我发现了这个差别并手工用 `text` 核了三题，但没修量具；复查用 formatter
   探针确认可以出现"在 snippets、在 storedBody、不在 visibleText"。

决定：三缺口框架作为 plan 3.15 的组织原则；目标形态五段写进设计 6.1；实施顺序按依赖（展开理由 → 角色规则共享 →
`AnswerRequest` → 证据单元与联合选择 → 三类记录 → held-out）。采纳它否掉我的三处：不用全局纯字典序（字典序没有消灭取舍，
只是让前一维绝对优先——加权覆盖排在成本前，多命中一个弱词的 20 KiB 片段就永远压过够用的 2 KiB），改"不能补偿的用规则、确实
不确定的用少量评分"；文件角色不持久化到图（角色随测试根配置变，持久化要管失效），共享规则即可；不用单一 `stage` 状态机
（结构是树不是链：一个文件多个单元、每单元多个呈现方案，且 D-152 的刷新让派生结果可过时），改三类记录。补它没给的顺序与
两处成本：设计三与设计四是同一件事的两面必须一起做；`sliceSymbol` 要拆成"给候选范围与字节成本"和"按方案渲染"两步，
3.11 的切片测试要跟着动。

不改：3.13/3.14 的成果；对象优先、区分度表、证据刷新、图作第二路径来源、当前正文重新定位。

影响：设计 6.1"目标形态"；plan 3.15；status。

状态：已决定，待实施（plan 3.15）。

### D-161 · 2026-09-08 · 采纳 3.15/3.16 联合设计；四片串行；三处起点修正

背景：D-158–D-160 排期后，请设计复查在"方向已定、不设信任门与花费守卫"的前提下做 3.15 与 3.16 的联合设计。这次它的姿态与
上轮不同——"不改"只剩五条会伤正确性的（不混用不兼容向量空间、不把索引旧正文冒充当前来源、不让模型改写覆盖用户要求、
不把相关性分数当证明、不让裁剪后正文继承已不存在的证据），其余全是"系统应该做什么"。它对着 `89f3a103` 与 AFT `5df9421d`
核实的断言我逐条复核，全部成立，其中三条改变了起点：

1. **`knowledge/embedding.ts` 已有七家远程适配器**（OpenAI / Voyage / Mistral / Gemini / Jina / Cohere / OpenAI 兼容），是知识库侧
   （plan 2.8）建的，一直"未配置 → 占位模式"。3.16 的适配层不从零开始，是把 `embed(texts)` 接口加厚（query/document 用途、
   取消、实际维度、批次对应；Cohere 路径现固定 `search_document`）。
2. **AFT 的切块是反例不是参照。** `build_embed_text_with_lines`（`semantic_index.rs:4611–4653`）编码的是
   `name + file + kind + signature(400 字符) + body(前 15 行 / 300 字符)`，总长钳 1600。它的"语义搜索"本质是模糊符号名索引，
   大函数后半段的动作（Q5 的 `links.push` 在第 220 行）永远编不进去。Piarium 的容器切片（D-098）是比它好的起点，这是我们相对
   AFT 的一个真实优势。
3. **权威 `.tdb` 开库时定单一 `dim`**（`store.ts:406`）。代码向量若混进去，用户换嵌入维度会牵动 blocks、knowledge、结构图。
   代码语义索引因此是独立的可重建代际存储 `semantic/{spaceId}/{generation}`，仍用 TriviumDB、仍 Host 唯一写；设计 7.1
   "每 workspace 一个文件"收窄为权威知识存储的描述。

它还纠正了我一处：**`all-MiniLM-L6-v2` 模型卡标 English**，D-160 里我说零样本分类"天然跨语言"是错的——中文原型放进去不会得到
中英对齐；跨语言能力按当前模型如实表达，选多语言模型时才启用。

决定（采纳，细节见设计 6.1 / 8.5 / 7.1 与 plan 3.15 / 3.16）：

- **证据单元三字段分开**：`arrival`（怎么找到的）/ `assessment`（对答案要求核验到什么）/ `purpose`（主证据 / 支撑 / 备选），
  替掉揉在一起的 `EvidenceGrade`。语义命中可以 `arrival = semantic`、`assessment = 已确认`、`purpose = primary`，不必先经词法。
- **`focusRanges` 替代 `hitLines` 作证据单元入口**，命中行只是重点范围的一种来源；`sliceStructureWindows` 现在没 hits 返回空，
  这是 3.15④ 第一个要动的接口，也是 3.16 接进来的前提。
- **RRF 恢复但限定**：只吃排名、只在文件级、只管读取调度；来源内先归并（语义多变体 best-rank、词法加权覆盖），来源间再融合；
  最终选择不参与。这与 D-145 拆掉的（原始组权重混加 RRF、路径序当名次）是两回事。
- **重排替掉残余相关性，不叠加**：成功重排的候选用重排顺序，`windowScore` 整个删掉，两套不并存；重排输入含当前正文与呈现方案。
- **三类身份**（向量空间 / 索引配方 / 查询与重排）替代单一指纹；换 API key、换重排器不重嵌。
- **重建是索引生命周期轴**，与查询状态轴分开；建到一半用一半。
- **草稿与线程 overlay**，在捕获时嵌入不在查询时。
- **查询扩展不进 D-153 表**；零样本分类是软路由不是硬要求。
- **顺序**：它给了接缝表没给顺序，我补——3.15 ①②④接口 先做，然后 3.16 四片串行（召回端到端 → 重排 + 远程 → overlay →
  扩展 / 多粒度 / 软路由），一份长任务 prompt 交一个执行 agent，因为有依赖且总量是一个长任务。维护者选串行。
- `rankCandidates` → "答案要求直接取证优先 + 文件级排名融合"；`windowScore` → 删，换"主证据分区 → 重排顺序 → 字节感知联合选择"。
  这两句明写，否则执行会又做成"RRF + 重排分 × 系数"。

不改：D-158 的槽位与无防御项决定；D-159 的三缺口框架；3.13/3.14 成果；读预算 / 字节预算 / `limit` 数值。

影响：设计 6.1 目标形态与 fan-out / 模型增强、7.1、8.5；plan 3.15④ 与 3.16 全节；status。

状态：已决定，待实施（plan 3.15 / 3.16）。

### D-162 · 2026-09-08 · 不索引整个电脑；检索范围分层、语义跟注意力走；范围键与文档身份从 3.16 第一片起参数化

背景：维护者问日常办公场景的快速查询怎么做——"如果不局限于一个工作区么？难道要索引整个电脑么？"这打在设计 §10.4 的假设上：
它把 `knowledge-work-in-files` 写成"目录内的……契合以目录为中心的工作区模型"，但办公的东西本来就分散在 Documents / 桌面 /
Notes / Downloads，还有一半不是文件。整个 Host 又是按 `{hostId}/{workspaceId}` 组织的（知识库、Documents 鉴权、符号图，
以及 D-161 里我写的语义代际存储路径）。

决定：

- **不索引整个电脑。** 理由不是防御：用户目录里二十万个文件绝大部分是缓存、依赖、系统残留，给垃圾建语义索引没有价值；
  范围本身是相关性的第一道过滤，拆了得靠排序补回来、难得多；用户也不要"它什么都知道"（Recall 被撤回重做）。
- **分层**，与 Spotlight / Windows Search / Everything 二十年的结构一致：第零层文件名与元数据全用户目录（近乎免费）；第一层
  全文词法在用户指定的根（OS 文件监听增量）；第二层语义**跟着注意力走不跟着磁盘走**——当前工作区、最近碰过的工作集、
  钉住的跨目录集合、被第一层命中时才嵌入。第二层大小跟用户在做的事成正比。
- **范围（scope）是检索的一等参数，工作区只是范围的一种**：`workspace` / `roots` / `working-set` / `collection` / 将来 `user`。
  用户级索引与工作区索引并列存放、同一套存储与身份模型。知识条目已有 `scope: workspace | user`（§7.2.1），检索索引照此扩。
  这对代码也有用："我在另一个仓库里怎么实现的 X"现在答不了。
- **非文件来源仍在范围之外**（§10.4），但结构上与 Spotlight importer / IFilter 同形——连接器把外部东西变成带身份、内容、修订的
  文档进同一个索引。所以**文档身份不绑文件路径**。
- **对 3.16 第一片的两条约束**（现在就守，其余等 profile 消费者）：代际存储路径与查询接口以 `{ scopeKind, scopeId }` 为参数，
  本片只有 `workspace` 但 `workspaceId` 不许焊进路径、块身份、父单元身份或查询签名；文档身份是
  `{ scopeKind, scopeId, documentId, revision }`，`documentId` 类型上不假定是路径。设计 §7.1 的路径改为
  `knowledge/{hostId}/semantic/{scopeKind}/{scopeId}/{spaceId}/{generation}`。
- 第零、一层与用户级第二层是 `knowledge-work-in-files` 的第一批切片，等它有真实消费者再排（§10.5 接缝先于领域）。

不改：`code` profile 的工作区 = 仓库；D-158 的槽位与无防御项；SaaS 连接器范围之外。

影响：设计 §6 头新增"检索范围"一段、§7.1 路径与文档身份、§10.4；plan 3.16 第一片两条约束。

状态：方向已决定；对 3.16 的约束待随第一片实施；其余待 profile 消费者。

### D-163 · 2026-09-08 · 图线索到达理由；same-container 不拿直接线索与图补充物化

背景：`candidateTier` 与 `isDirectClue` 把任何 `connection` 线索当成 tier 1 / 直接线索。Q2 的十七条未核验 connects
占 tier 1、吃掉图补充物化，是因为一份已读注册表窗口含有它注册的全部字面量，展开后每一端都与「有连接」不可区分。
D-151 的 `offTopic` 只在问句已有对象且定位完成时生效；无对象 how 问句 `literalOffTopic` 一律 false，整张表都升档。
计划 3.15① 要求按到达理由而不是把连接预算改小。

决定：

- 每条图线索记录 `arrivalReason`：`object-triggered`（问题对象的 `searchDefinitions` / `findLinks`）、
  `statement-evidence`（当前窗口**命中行**上的字面量；该语句已经凭词法或对象参与解释）、`same-container`
  （字面量只出现在同一窗口正文的其他行，或反向 import 的 specifier / 种子路径不是问题对象）。
- 无对象问句可以从命中行上的字面量产生新对象（`statement-evidence`），不能机械确认相关性的展开只是普通补充。
- `same-container` 不拿直接线索待遇：不是 tier 1、不进 `isDirectClue`、窗口不升到 `connects-clue`、
  不进入图补充物化名单。连接预算 16 未改，只把它花在前两种到达理由上。
- 同一 `(source, why, locate)` 再到达时保留更强的理由。反向 import 仍可补充物化——它们本来就不是 tier 1，
  现有「import 候选不是 rg 命中」测试依赖这条路径。
- `offTopic` 仍按 D-151 / D-156：定位或两端已验证后不展开无关字面量；未完成时 `statement-evidence` 即使
  与对象名对不上也仍可读另一端（support 档），避免把「语句里的连线」误判成同容器噪音。

已验证：`explore.native.test.ts` 同容器 16 条 wire 在无修复时 extra-read（先红）、修复后不读且 `src/ranking.ts` 仍在包内；
命中行上的 `rank.pipeline.core` 仍 extra-read；原有连线另一端 / 反向 import / 定位后 offTopic 仍绿。explore 相关
89 项通过。

未验证：十问观察（尤其 Q2 读预算是否因此松开）；词汇缺口探针未写；`windowScore` / `EvidenceGrade` 仍在，
到达理由还没有进协议 `details`（3.15④）。

不改：24 KiB / 20 条 / 读预算与图预算数值；不把连接上限改小当作相关性判断。

影响：`explore.ts` GraphClue / candidateTier / isDirectClue / 读后展开；设计 6.1 fan-out；plan 3.15①；status。

状态：已实施。

### D-164 · 2026-09-08 · explore 与 related 共用查询期文件角色；依据三态；不入图

背景：plan 3.15② 要求两份工具用同一套分类，依据是文件名模式 / 项目声明 / 未知。角色随测试根和清单文件变，
写入符号图就要管失效。当时 `classifyFileRole` 只活在 `explore-query.ts`，`related` 不分类。

决定：

- 抽出 `file-role.ts`。`explore` 与 `related` 都走 `classifyFileRole` / `classifyFileRoleDecision`。
- 依据：`filename-pattern` / `project-declaration` / `unknown`。项目声明名单是常见清单文件
  （`package.json`、`tsconfig*.json`、`pyproject.toml`、`go.mod` 等），**角色仍是 `other`**，不新增会改
  `fileRoleFit` 的枚举值——本步是共享规则，不是重调 explore 排序。
- lockfile 继续按文件名模式归 `lock`，即使名字像清单（`package-lock.json`）。
- `related` 结果增加 `roles`（路径 + 角色 + 依据），正文标明 query-time、不在图上。协议字段必填，空结果给 `[]`。

已验证：related 在无 `roles` 时先红后绿；`package.json` 为 `other` + `project-declaration`；explore 的
`classifyFileRole` 是同一函数；既有 file-role / related / explore-query 测试。

未验证：related 正文加 Roles 段对十问无影响（related 不在十问里）；项目声明名单是否该含工作区自有配置文件。

不改：`fileRoleFit` 数值表；符号图 schema。

影响：`file-role.ts`；`related.query` 结果；设计 6.1 / 6.2；plan 3.15②；status。

状态：已实施。

### D-165 · 2026-09-08 · focusRanges 入口；arrival / assessment / purpose；同一连接值才算两端

背景：3.16 语义线索没有命中行，旧 `sliceStructureWindows` 在 `hits.length === 0` 时返回空。`EvidenceGrade`
把怎么找到的、核验到什么、在输出里当什么揉在一起。`hasBothConnectsEnds` 按 callee 集合加正文正则，
`register("other.wire")` 加 `request("explore.search")` 就会早停并跳过内容词。

决定：

- `windowsFor` / `sliceStructureWindows` 入口改为 `focusRanges` `{ startLine, endLine, origin }`。词法命中是
  `lexical-hit`。没有 focusRanges 才返回空。`proposeSymbolSliceSchemes` / `renderSymbolSliceScheme` 拆开，
  本刀只交付 `signature-focus-omit`。
- 证据单元三字段：`arrival`（lexical / graph / semantic，可合并）/ `assessment`
  （`verified-relation` / `object-present` / `name-only` / `unverified`）/ `purpose`
  （打包决定：入包且非 offTopic → primary，offTopic 入包 → support，未入包 → candidate）。
  相似度不进 assessment。协议去掉 `ExploreEvidenceGrade`。
- `hasVerifiedRegister` / `hasBothConnectsEnds` 只看已核验关系；两端必须是**同一连接值**的 register 与 request。
  去掉正文 `/register\(/` `/request\(/` 回退。
- `windowScore` 仍在，只删 `GRADE_RANK * 8`。评估作打包**首槽**分区（加目录定义到达作同等评估下的偏好），
  后续槽位仍走 windowScore，避免硬分区挡住同文件互补块。重排接上之前两套不并存的终局仍待第二片。

已验证：混合字面量两端在无修复时 `skippedQueries=direct-verified`（先红）；修复后内容词仍启动。
`slice.test.ts` 空 focusRanges / 语义块焦点 / 原有切片；explore 74 项；内容词窗口 `assessment=name-only`。
web tsc。

未验证：十问观察；语义 arrival 尚未接线；`windowScore` 其余项未删；AnswerRequest（3.15③）未做。

不改：24 KiB / 20 条 / 读预算与图预算；不建程序切片器。

影响：`slice.ts`；`explore.ts` 证据单元与打包；protocol `ExploreWindowTrace`；设计 6.1；plan 3.15④；status。

状态：已实施。

### D-166 · 2026-09-08 · MiniLM 有效长度 512 写入向量空间身份

背景：同名 `all-MiniLM-L6-v2` 模型卡写 256 word pieces，AFT 覆盖为 512。切块若按字符估，大函数后半段会像 AFT 那样编不进去。

决定：空间身份钉 `maxTokens=512`。这是随发行配方的 ONNX `max_position_embeddings`，不是模型卡的质量提示。切块把这段长度交给所用 tokenizer 计数，不按「几字符约一 token」。256 与 512 是不同空间，换长度必须重嵌。

已验证：`spaceIdOf` 在 256 与 512 下不同；切块测试用注入的计数器卡上限，真解析器覆盖大函数每一行。

未验证：真实 MiniLM tokenizer.json 未随仓库提交（`semantic:copy-model` 现取）；未用 ONNX 对同一段正文量实际 word-piece 数。

不改：不接远程嵌入；不把 256 写成兼容别名。

影响：`semantic/identity.ts`；设计 6.1 身份；plan 3.16 第一片索引侧。

状态：已实施。

### D-167 · 2026-09-08 · 范围键路径与不透明 documentId（兑现 D-162 接缝）

背景：D-162 要求第一片就参数化范围，避免以后焊死 `workspaceId`。

决定：存储路径与查询签名只接受 `{ scopeKind, scopeId }`。`workspaceScope` 是把工作区 id 写成 `scopeId` 的唯一处。块身份 / 父单元身份 / 查询都不读名为 `workspaceId` 的字段。`documentId` 对文件范围恰好是相对路径，类型上当不透明字符串：`encodeURIComponent` 进块 id，不 `path.join`、不按分隔符切、不当 glob。`mail:abc123` 必须能建能查。

已验证：两个 `scopeId` 的代际库互不串；`mail:abc123` 的块身份与近邻查询正常。

未验证：`roots` / `working-set` / `collection` / `user` 范围（本片不实现）。

不改：权威 `{hostId}/{workspaceId}.tdb` 的命名。

影响：`semantic/identity.ts`、`store.ts`、`runtime.ts`；设计 7.1。

状态：已实施。

### D-168 · 2026-09-08 · 结构递归切块；路径和签名不许挤掉正文

背景：AFT `build_embed_text_with_lines`（符号名 + 签名 400 字符 + 正文前 300 字符）是反例。

决定：单元边界复用 3.11 tree-sitter 容器切片，不另写程序切片器。小单元整块；大单元按子容器递归，仍超长再用有重叠行块并记 `fallback`。每个源码行至少落在一个块里。编码材料先保留子块正文，签名 / 名字 / 注释 / `documentId` 只在 tokenizer 还装得下时追加。缺结构能力时整文件走 fallback。切块器不调用 `languageIdForPath(documentId)`——语言由调用方传入。

已验证：大函数真解析器覆盖每一行且 embed 文本不超过注入上限；无结构时重叠 fallback；长路径在字符计数器下被丢掉、正文保留。

未验证：生产 MiniLM tokenizer 下的块数与质量；JSON / 按需语言的切块观感。

不改：24 KiB 可见预算；不建 BM25。

影响：`semantic/chunker.ts`、`embed-text.ts`。

状态：已实施。

### D-169 · 2026-09-08 · 独立代际语义库；Host 绑定工作区；缺包即 unavailable

背景：权威 `.tdb` 开库时定单一 `dim`。语义索引必须能换模型重建而不牵动符号图。

决定：每范围每空间一代一个 TDB，路径
`knowledge/{hostId}/semantic/{scopeKind}/{scopeId}/{spaceId}/{generation}`。`payloadCacheMb: 0`，原生索引，`indexedLookup` 用 1_000_000 封顶。近邻先 `searchExact`，失败再暴力余弦。按文档事务替换块并发布检查点；建到一半 `coverage=partial`、查询已发布部分。Host 在工作区知识库打开时启动扫描，Documents 变更观察增量更新，不依赖聊天 session。模型包走 `semantic-models/` 内容寻址存储，捆绑目录走与语法 wasm 相同的 asar remap；缺 ONNX 时 embedder `unavailable`，扫描空操作。`@huggingface/transformers` 运行时动态加载，未安装不得让 Host 启动失败。intra-op 线程为核数一半。

已验证：半建覆盖 partial；embedder unavailable 不写库、runtime 报 unavailable；asar 路径重写单测。Host `index.ts` 已接线。

未验证：真实 MiniLM / onnxruntime 在 Electron asar 里加载（本刀有脚本、无打包 smoke）；全仓库冷扫描墙钟；TDB `searchExact` 在三万块上的延迟（暴力余弦按设计可接受）。

不改：不进权威 `.tdb`；不设信任门与花费守卫；不接 explore 检索（下一提交）。

影响：`semantic/store.ts`、`runtime.ts`、`model-store.ts`、`minilm.ts`；`application-host/index.ts`。

状态：已实施。

### D-170 · 2026-09-08 · 语义线索进同一证据管线；文件级 RRF 只调度读取

背景：3.15 已把入口改成 `focusRanges` 与三字段证据单元。索引侧（D-166–D-169）能出块，但 explore 仍只认命中行。
词汇缺口的验收是：一条 rg 完全找不到的块，必须出现在可见正文里，且 `arrival = semantic`、`purpose = primary`。

决定：

- Host 把 `semanticIndexRuntime.search(workspaceScope(workspaceId), …)` 绑到 `semanticRecall`。`workspaceId` 只在这一处变成 `scopeId`。
- 查询嵌入原问题，近邻块写成语义线索。`windowsFor` 对每条线索跑 `relocateSemanticFocus`，成功范围以 `origin: semantic-block` 进入切片。哈希一致用原范围；正文平移按父符号与块正文重定位；实质变化重切当前单元，不沿用旧范围，也不因问题词不在正文里丢掉线索。
- 同一窗口合并 lexical / graph / semantic 到达理由，不复制证据单元。
- `rankCandidates`：池里出现语义线索时 `tier → RRF → L(f) → roleFit → 路径`。词法文件排名是加权覆盖序；语义文件排名取该文件最小块名次（十个块不是十票）。\(k=60\)。某来源没有该文件就没有那一项。无语义线索时保持 3.14 的 `tier → L(f) → roleFit → 路径`，避免空 RRF 改变既有顺序。这不是 D-145：RRF 只吃排名、只在文件级、只管读取调度，不进打包。
- 打包仍由 assessment 首槽分区 + `windowScore`（已无 `GRADE_RANK`）。语义单元可以是 `purpose = primary`，不要求先有词法命中。相似度不进 assessment。
- `details.semantic` 始终有：`not-requested`（未绑来源）/ `ready` / `empty` / `unavailable` / `failed` / `stale`，另报 `coverage`、`generation`、`spaceId`、`scope`、`index.lifecycle`、blocks/units/primary。语义失败或不可用时词法加图照出。
- `explore.paths` 过滤在本片把工作区 `documentId` 当相对路径做前缀匹配；类型上仍不把 `documentId` 当成路径去 `join` 或当 glob。

已验证：词汇缺口夹具（问题词与代码零重合）经 `formatExploreOutput.visibleText` 看见目标函数，arrival=semantic、purpose=primary；同一函数 rg+向量只一份单元两条到达；十个语义块不赢过该文件最好名次为 1 的另一文件（读顺序）；哈希失效后重定位躲开占行 1–4 的 decoy；实质改写后可见正文含重切单元里的新标识、旧四行范围装不下它；`coverage: partial` 仍返回已发布块；semantic `unavailable` 仍出词法摘录；`explore-rrf` \(k=60\)；application-host tsc；既有 explore / explore-service 组。

未验证：真实 MiniLM 近邻（夹具注入 `deps.semantic.search`）；十问回归（第六步）；Electron asar 打包加载 transformers；held-out 词汇缺口（维护者写，本刀不参与）；自造探针未写入观察脚本。`windowScore` 未删。

不改：24 KiB / 20 条 / 读预算 / 图预算；不设信任门与花费守卫；不做重排、查询扩展、远程嵌入、摘要、草稿 overlay、零样本分类。

影响：`explore.ts`、`explore-rrf.ts`、`explore-service.ts`、`service-host.ts`、`application-host/index.ts`；protocol `ExploreSemanticDetails`；设计 6.1 fan-out / fuse / pack；plan 3.16 第一片检索侧；status。

状态：已实施。

### D-171 · 2026-09-09 · 观察量具读可见正文；semantic 诊断单独一行

背景：D-159 第 6 条已经写过 `stageForTarget` 读的是字节裁剪前的 `snippets`。3.16 第一片的验收是「进可见正文」，量具再读数组会把超预算摘录算成可见。十问仍是回归护栏，不是这刀的成功标准。

决定：

- `stageForTarget` 从服务返回的 `text` 里按 `--- path:start-end ---` 块判可见并编号。`snippets` 里有所需证据但 `text` 没有，报 `packed snippet has …, not in visible text`，不再报 `visible #N`。
- 阶段诊断加 `semantic:` 一行：`status` / `coverage` / `index.lifecycle` / `blocks` / `units` / `primary`。
- 观察 host 按生产形状绑 `semanticRecall`。`--skip-scan` 不建 MiniLM 代际（会压过目录扫描、也不是十问回归）。缺 ONNX 时该行是 `unavailable`，explore 仍出词法加图。
- 不把开发期词汇缺口探针写进观察脚本。

已验证：`explore-observe-stage.test.ts` 先证明读 snippets 会把裁掉的块报成 visible，再改读 `text`；语义行格式。

未验证：本机十问全跑（提交后用 `$TEMP\piarium-observe --skip-scan`）；真实 MiniLM 近邻改变十问任一条；Electron asar 打包加载。

不改：十问 `wants` 与五个变体；24 KiB 预算。

影响：`scripts/explore-observe.ts`、`explore-observe-stage.ts`；status。

状态：已实施。

### D-172 · 2026-09-08 · 本地嵌入器补上运行时并首次真跑；主证据是分区不是首条；import 到达理由补语句取证

背景：3.15①②④ + 3.16 第一片的验收（D-163–D-171）。管道部分实、范围键守住、探针没进观察脚本、量具改读渲染正文，这些都复核成立；十问我逐格重跑与报告一致。三处报告未列：

**一、本地 MiniLM 在任何环境都没有运行时。** 报告写的是「本机缺 ONNX」「发行包里没有 `@huggingface/transformers`」，实际是**任何 package.json 都没有声明这个依赖**，`node_modules` 里也没有；而 `minilm.ts` 用 `new Function("specifier", "return import(specifier)")` 加载，打包器与 `tsc` 都看不见它，CI 永远不会报缺依赖。`minilm.ts` 110 行零测试引用。所以「本地 MiniLM 端到端」不是未验证，是按当时代码无法验证；D-169 把缺依赖写成了健壮性属性（「未安装不得让 Host 启动失败」）而不是未完成的交付。修的时候暴露出四层都没跑过：`new Function` 形式在测试运行器下直接抛「A dynamic import callback was not specified」；transformers.js 解析本地包要 `env.localModelPath` + 目录名，传 file:// URL 会读错 `tokenizer_config.json` 的基准；权重要按 `dtype` 决定文件名（`q8` → `onnx/model_quantized.onnx`）；而复制脚本把 `onnx/` 子目录拍平了、recipe 里 `onnxFile` 也少了这一层。四处都改。

**二、主证据分区只在挑第一条时生效。** `packComplementary` 里 `const partition = selected.length === 0`，第二条起 `assessment` 一律记 0，而 `GRADE_RANK * 8` 已按上一轮 prompt 从 `windowScore` 删掉——已核验证据从 #2 起没有任何优势。设计说的是「先构造满足要求的主证据，再按相关性填支撑」，那是**所有**满足要求的片段。这一条我有责任：删 `GRADE_RANK` 是我在 prompt 里要的，同时把完整联合选择划到了第二片之外，但「分区」被实现成「只管第一条」是对设计的误读。

**三、`arrivalForImport` 永不返回 `statement-evidence`。** 对比 `arrivalForLiteral` 会查 `literalOnHitLine`，import 那条不查，于是无对象问句的每条反向 import 线索永久是 `same-container`，即使 specifier 就在当前正文的命中行上。

决定：

- `@huggingface/transformers` 进 `packages/web` 依赖；动态加载改为 `await import(/* @vite-ignore */ MODULE_ID)`——仍不进打包器静态图，但真能加载、可测。模型包按上游布局保留 `onnx/` 子目录，`dtype: "q8"`，`env.localModelPath` 指向包的父目录、模型 id 用目录名。
- 新增 `minilm.live.native.test.ts`（包缺失时 `skipIf` 跳过，权重由 `semantic:copy-model` 取、不入库）：真分词、真 384 维归一化向量、**词汇缺口排序**（`how does the runtime discard idle tokens` 对 `reclaimLease` 正文的余弦高于对 CSS 常量），以及**经真运行时的端到端**——真嵌入器扫两个文件、用零词汇重合的问题查回 `lease.ts`，`lifecycle=ready`、`coverage=complete`。这是这一片的招牌交付第一次真的发生。
- 主证据分区改为覆盖全部挑选轮次，成员判据收窄为 `assessment === "verified-relation"`（仅含有对象不算，否则会把只重复对象的窗口抬到同文件机制块前面，与 D-155 冲突）；定义偏好仍只作首条 tie-break（`limit: 1` 的「哪一个窗口定义了 X」本就只关心第一条）。
- `arrivalForImport` 增加 `literalOnHitLine` 判据。

观察（同一目录 `--skip-scan`）：语义状态从 `unavailable` 变为 `empty`——模型包已能解析，索引空是因为观察脚本不触发语义扫描，两态按不变量 3 分开报。分区修复让问题 9 注册端从可见 #5 升到 #3、问题 6 从 #2 到 #3；请求端仍在 #19，**原因未定位**，不是分区造成的。问题 7、8 仍断在读取调度，import 到达理由的修复对它们没有效果——它们的目标不是经反向 import 到达的。

另记两条方法问题：报告的前后对照表**混了两套量具**——3.14/D-157 的位次是 `snippets` 数组下标，本轮量具（D-171）改读渲染正文的段号，两者不可直接相减，而报告把「#16 → #18」当同一标尺呈现并给了「本观察目录、现仓库词法池」的解释。以后跨刀比较位次要注明标尺。问题 8 相对 `5092b682` 的变差，准确说法不是「语义源未参与」：到达理由降等**拿掉了一个原先把 `thread-worktree.ts` 抬进 tier 1 的信号**，而本该补上的语义召回当时是死的——这是步骤一的代价，不是中性变化。

不改：范围键与文档身份接缝；量具读渲染正文；`windowScore` 其余项（等第二片接重排时整体替换）；读预算、字节预算、`limit` 数值。

未验证：全仓库 MiniLM 冷扫描墙钟（观察脚本不触发语义扫描，这一片也没接）；Electron asar 里真实 `import("@huggingface/transformers")`（依赖刚加，未重跑打包 smoke）；问题 9 请求端 #19 的成因。

影响：`explore.ts` packComplementary / arrivalForImport；`semantic/minilm.ts`；`scripts/copy-semantic-model.mjs`；`semantic/runtime/all-minilm-l6-v2/recipe.json`；`packages/web/package.json`；订正 D-169 的交付描述与 D-171 的可比性。

状态：已实施。

### D-173 · 2026-09-09 · 快速检索职责与现行路线收敛（3.15 / 3.16）

类型：设计修订；本条更新设计与实施顺序，不宣称运行时已按新设计交付。

背景：维护者要求重新讨论自然语言快速检索。现行目标是帮助主 agent 找到陌生实现并取得可读原文，实施却把越来越多语义判断交给
词表、来源等级和证据打分；计划又把远程嵌入与重排捆在后一片，使本地 MiniLM 先承担全仓建设。当前代码中
`candidateTier` 把纯语义候选放在 tier 4、普通 import/association 放在 tier 3，RRF 只在 tier 内生效；`windowScore` 继续主要
按词法覆盖选择正文；第一次读取前仍等待三路召回的 `Promise.all`。这些是实际结构问题，不能靠扩大索引或更换模型自行解决。

维护者说明：普通低成本 LLM 循环与已有 retrieval 子 agent 重叠，也没有专训快速检索模型的速度条件。扩散模型的后续方向是
开源基座加后训练，本轮先优化现行设计，不接商用扩散 API、不安排训练项目。此前提出的“全局 sketch + 仅热点正文”并未被采纳：
截取或拼接摘要仍可能丢掉陌生实现；先被其他方法发现才能获得正文向量，会重新留下词汇缺口。当前 CPU 扫描耗时也不足以证明
全仓正文索引或所有本地后端不可行。全仓扫描曾人工中断，不能把 1–2 小时推算记为完整构建实测。

决定：

1. **职责按交付物分开。** `grep` 提供精确匹配；`explore` 用词法、路径、符号和向量快速取得当前代码入口、范围与原文；
   `retrieval` 子 agent 处理需要较长阅读与判断的开放事实问题。复用底层工具，不把普通 LLM 多轮循环藏进 explore，也不合并两种产品职责。
2. **请求保留事实，核验只说明事实。** 沿用 question / anchors / paths，记录用户明确要求与系统推断的区别；收窄 D-159/D-161 的
   `AnswerRequest`，不另建把任意自然语言编译成答案充分性谓词的解释器。已确认同一连接值的 register/request 仍是有用事实，
   不自动等同于“已解释机制”。生产/测试等推断只作偏好，不升级为用户未要求的硬过滤。
3. **语义参与真实竞争。** 明确要求的精确导航有直接读取路径；开放候选取消按来源划定的永久 tier。各来源内先去重并形成真实排名，
   词法与语义再融合；多个改写、多个块不增加同一来源的票数。同分保留并列，路径只稳定展示，不用字母序制造相关性。
   普通图关联没有天然优先权；图提供明确目标时按导航处理，否则保留线索身份，不伪造词法/向量名次。
4. **文件调度与单元选择各用自己的材料。** 文件级融合只决定先读什么；当前代码单元使用落在该单元上的词法/语义证据形成来源排名，
   无重排器时复用排名融合，不能继承整文件的得分或名次。这扩展了 D-161/D-170 的“RRF 只在文件级”限制，而非把文件分数广播到窗口。
   重排器成功评估同一批当前正文时提供该批相关性顺序。`windowScore` 的相关性、角色、重复、关系与字节成本拼盘直接拆除，
   不等待重排器接线；显式范围、重复片段和呈现预算分别处理。最终呈现只决定一次，原文省略不得继续继承已被删掉的选择依据。
5. **查询按来源完成推进。** 可用候选到达后即可安排读取；后续来源可替换尚未执行的候选，已读快照复用。先到的弱候选不能耗尽
   全部读取机会，词法有命中不等同自然语言问题已解决。精确导航完成、来源结束、取消和可配置工作预算是停止依据；超时或迟到
   只影响本次请求，不能改写已经返回的结果。预算按实际资源行为调整，不新猜固定轮数、文件数或秒数。
6. **范围与建设顺序分开。** 工作区仍覆盖其中尚未接触的实现；活动文件、变更和显式范围可影响优先级，不把工作集变成隐式白名单。
   保留正文区域的编码覆盖目标；切块必须逐块适配真实 tokenizer，单条长行继续按 token/字符位置切分，不能用行号已覆盖掩盖正文截断。
   模型最大输入长度是边界，不是每块必须填满的目标。摘要是可另选的导航表示，不替代正文覆盖。
7. **索引作为独立的后台服务。** 按范围合并扫描与变更、批量读取与嵌入、逐批持久发布、从已发布结果恢复。向量按实际编码文本、
   向量空间与 query/document 用途复用，行号移动或同文件其他块变化不要求重算未变文本。计数、检查点和 flush 不逐文档扫描或重写整库。
   前台查询在后台推理批次之间优先取得执行机会；模型初始化合并在飞请求，取消查询不取消共享建设。分别记录冷库首个有用结果、
   热查询、编辑后可查和完整构建成本，不以“后台运行”或 `coverage=complete` 证明交互足够快或召回完整。
8. **远程嵌入独立交付。** 从 D-161 的“重排 + 远程”第二片中拆出配置与远程嵌入，复用已有 provider/credential authority；
   query/document 用途、取消、输入长度、批次对应与实际维度属于后端契约。当前本地 MiniLM 是已接后端，不能从权重大小推断中文
   质量与全仓速度；Node 推理线程配置要落在实际 ONNX session，WASM numThreads 不是 Node CPU 线程数的证据。
   重排独立选后端并随接线按有效绑定启用，不再提前承诺尚未选定的本地 CPU 交叉编码器可作为默认。模型不可用时已有检索继续正常提供。
   当前 SettingsManager/provider/auth 读取依赖 Pi session；后台远程绑定要复用同一 Pi runtime authority 并与聊天寿命分离，
   不创建用户对话或检索 Thread，也不把凭据传给 Host。配置、后台执行上下文与发布失效是同一条接线，不借任意活动会话补洞。
9. **来源一致性保持。** 旧索引可给导航线索，返回代码必须取当前请求来源；实质改写后的正文不继承旧向量相关性。草稿/线程正文
   捕获不等待向量计算，新覆盖层尚未就绪时遮蔽被替代路径的旧磁盘向量并标明缺口。权限、固定草稿和分支身份不交给模型判断。

实施顺序：先收口已有性能与发行修复；3.15 处理平等召回、当前单元排序与一次呈现、来源完成调度；3.16 先接嵌入配置/远程，再完成
向量复用与前台优先、草稿/线程覆盖，重排独立接入。算法与远程接线可以按代码责任独立推进，不再要求四片全部串行。
扩散模型、后训练、生成式摘要、查询改写和零样本路由不作为本轮依赖，也不另建统一评测门。使用具体失败与已有观察工具做定向验证。

证据边界：此前本会话的性能/发行工作仍在未提交工作树，实测与未完成项记录到 status。本文档修改不改变运行默认，也不把
未接配置、查询缓存、前台优先或新的排序方式写成已实现。D-158 的无额外信任门/费用守卫、D-162 的范围键、D-167 的不透明文档身份、
D-169 的独立代际库与部分可查，以及 Documents 来源边界保持。

影响：`agent-harness.md` §2/§5.7/§6/§6.1/§6.2/§7.5/§8.5；plan 0.7/2.8/2.9/3.2/3.15/3.16；
`architecture.md` §4.4 的检索/后台模型目标归属；status 当前顺序与未提交工作树事实；本日志索引。

状态：设计已回写；新的运行行为待按更新后的 plan 实施。

### D-174 · 2026-09-09 · 纠正 LLM 范围：当前快速检索接入局部语义决策

类型：设计纠错；修订 D-173 对当前 LLM 工作范围的误读。

背景：维护者要求扩散模型以后采用开源基座并后训练，“先不考虑”指这个研究方向。主代理在 D-173 中将其扩大成当前 explore
只做算法与向量，把查询理解/表达和候选语义判断也移出实施计划。维护者再次明确：部分语义工作现在就需要引入 LLM。
排除普通低成本模型执行完整自主检索子 agent，不等于排除它承担一次局部语义判断。这是主代理解释错误，不是用户撤回 LLM 方向。

决定：

1. **当前接 LLM 两处消费者。** 查询理解/搜索表达将原问题、锚点和少量仓库概况转为实际可执行的批量搜索输入；候选判断
   使用已读当前原文与呈现方案，返回相关候选 ID、范围和简短依据。Host 执行搜索、验证身份/范围并提取源码，不让模型抄写
   原文或生成替代主 agent 的完整分析。新表达是搜索假设，保留原问题与显式范围，不升级成硬过滤或词项重复票。
2. **消费已有 models.explore。** 复用 pi-host 当前会话的 ModelRuntime、provider/凭据和取消路径，不新建长期子会话/Thread。
   自然语言需要桥接时在召回前使用，已有明确地址时可省略；候选批量判断，材料明确时不强制再调一次。每处围绕明确决策，
   不机械串跑 intent/judge/repair，也不让内部模型自主循环搜索。较长开放追踪继续由 retrieval 承担。
3. **相关性判断只选一份。** LLM 选段与专用 reranker 是同一批候选的执行选择，不默认串跑两者；采用其有效结果后不叠加旧
   规则奖金。模型未参与或失败时仍提供已有算法/向量材料并说明状态，槽位配置后的实际消费者不等待后训练或独立评测启用门。
4. **当前排期是 3.15D。** 查询理解可以先接，与 3.15A 的召回整理共同推进；候选判断消费 3.15B 的当前单元与一次呈现。
   不等待 3.16B 的后台远程嵌入、新模型或全仓索引。验证真实模型请求的输出确实驱动了搜索/选择，并核对修订、取消与最终原文。
5. **D-173 其余取舍保持。** 来源平等、正文范围、索引复用、查询优先、远程嵌入独立交付，以及普通检索子 agent 的职责边界
   不变。扩散基座/后训练、全仓生成式摘要和零样本原型路由留后续；当前 LLM 接线不属于这些研究项。

影响：agent-harness.md §2/§5.7/§5.10/§6.1/§8.5；plan 0.7/3.2/3.15D/3.16E；status 的当前缺口与顺序；architecture §4.4。

状态：设计/计划已纠正；模型消费者尚未实现，没有以改文档冒充运行时已调用 LLM。

### D-175 · 2026-09-09 · 快速检索接线：同一次查询、分组搜索、成组选段与局部补查

背景：D-174 的外部设计复查指出，两个模型步骤如果仅接在现有 explore.search 前后，仍会继承旧候选筛选与呈现丢失，
也无法在正在执行的检索中加入搜索表达。主代理完整阅读评审并核对当前代码：explore-tool 直接调用 Host；explore.ts 在首次
读取前等待三路 Promise.all；explore-service 返回前已选窗口并按 24 KiB 排版；bridge 每次 RPC 重取 inputContext，取消
只清理本地 pending；router 自己的超时驱动 AbortSignal。这些是接线事实，不是新方案收益已得到证明。

决定：

1. **当前 LLM 主线保持。** 先打通 models.explore 实际改变搜索与最终原文的路径，不等待词法/向量全部调优、扩散模型、
   远程嵌入或独立评测工程。工作流按局部决策和交付材料分工，不按固定模型调用次数定义 explore/retrieval 边界。
2. **Host 持有同一次查询。** 短生命周期上下文保存 actor/范围、原问题、输入来源、生产任务、已读快照、候选视图及预算/
   结束状态；pi-host 沿现有 ModelRuntime 发模型请求，交回计划/选择。阶段延续开始来源，已知写入仍终结对应旧草稿；
   取消实传到 Host/模型，阶段共享截止条件，调用方离开时清理，迟到结果不复活。公开仍为一次 explore，无新持久会话、
   Thread 或通用工作流框架，也不把查询 ID 当路径授权。
3. **查询输出可执行的分组计划。** 行为目标、概念分组表达、预期材料保留语义关系，组内变体不重复投票，跨组支持不变成
   强制 AND。模型猜测不改原要求；使用已有目录/入口和已返回锚点正文提供仓库词汇，不等待全仓摘要。原问题检索和明确
   导航与查询模型并行。候选模型重新看原问题/当前源码，能够否定前一阶段假设，不继承不断强化猜测的推理历史。
4. **候选选择交付互补材料与必需范围。** 输入是最终挑选/排版前的当前单元，模型输入容量和输出预算分开，先去重再组织
   有竞争力的候选。输出材料组、候选/视图/范围 ID、必需/辅助范围、用途与缺口；不用全池数值分或固定机制模板。Host
   核验模型看过的正文及身份，不据此宣称语义判断已验证。呈现保留必需范围，装不下时换合法视图、放弃材料组或明确缺口。
5. **允许有依据的局部补查。** 明确符号/连接/路径机械定位；模型可根据当前候选/范围提出具体缺口和保持原问题的补充表达，
   批量执行并去重。明确短结果直接补充，其余仅对已选与新增材料增量判断。首版提供可选补查阶段，“一次”不成为永久
   硬上限；无新材料、预算用尽或需要重构任务、试验和持续开放调查时交回主 agent/retrieval。缺口只描述所见材料范围。
6. **来源机会与模型批次分开。** 调度登记实际候选生产任务，包括在飞查询计划及其后续搜索；多个变体没有多份保留额。
   既有读取预算内保留常规首批机会，其余先读，参与/空/失败/取消/截止后释放；全是已读文件时复用，不补读弱材料凑配额。
   首批处理可触发候选视图冻结，本轮预算也可提前结束等待并保留判断/呈现时间，不建立必须等齐的屏障。迟到材料是未评估，
   必要时增量比较；不每批到达就调模型，也不从模型说“够了”推导全仓充分性。
7. **LLM 与重排共享输入、区分输出。** 普通 reranker 排确定的可展示视图，不假装输出支撑行、材料互补或缺口。视图须符合
   后端实际输入长度；评分后保留被评估内容，不用完整函数的分数代表任意短签名。同批不默认串跑 LLM 与 reranker。
8. **冷库与推理调度补齐实际执行。** 首个兼容发布在本轮来源接收阶段到达时可以启动语义查询，不逐批重查、延长截止或
   唤醒已返回请求。前台优先发生在模型实例队列，当前批之后先服务等待查询，后台保留进展；扫描循环 yield 不能替代它。

验证：既有 faux provider 验证表达实际执行、呈现前候选可选、必需原文可见、局部补查、来源固定及取消/迟到；定向慢来源
验证机会释放与候选视图。真实问题观察首轮原文、后续定位往返、整体等待，必要时比较局部阶段，不强制全组合或新评测系统。
工具描述随消费者同步。来源、范围校验和机制测试不能替代语义效果，也不能把本次改文档记成运行时已交付。

影响：agent-harness.md §2/§5.7/§6.1；plan 0.7/3.2/3.15/3.16C/E；status 当前缺口与顺序；architecture §4.4。

状态：设计/计划已回写；运行时查询上下文、LLM 消费者与局部补查待实施。此前决策正文保留，D-174 的局部范围由本条扩展。

### D-176 · 2026-09-09 · 快速检索接线：查询协议与同一引擎

背景：D-175 要求 Host 持有同一次查询、公开仍为一次 explore。若把模型步骤接在现有 `explore.search` 返回之后，候选已按 24 KiB 筛过；若再建第二套检索，会绕开已有读取/授权。

决定：

1. 协议增加 `explore.query.start|plan|views|select|followup|finish|cancel|release`，均属 `read.search`。`explore.search` 保留为同一 `createExploreQueryRun` 的算法门面：`start → waitForViews → finish`，不走模型。
2. Host `ExploreQueryStore` 按 `sessionId:queryId` 保存短生命周期上下文：原问题、actor/工作区、开始时 `inputContext`、生产任务、已读快照、候选视图、截止与结束状态。查询 ID 不是路径授权。
3. 公开工具仍是 pi-host 的一次 `explore`。阶段 RPC 返回不释放整次查询；`release`、公开工具 `finally`、session drop 与 Host dispose 才清理。
4. 不建持久查询库、新 Thread 或通用 workflow。模型 JSON 与选择校验在 pi-host / Host 边界完成，不复制密钥或模型配置权威。

影响：`packages/protocol/src/harness.ts`、`explore.ts`、`explore-query-store.ts`、`explore-query-services.ts`、`explore-tool.ts`；设计 6.1；plan 3.15 共同上下文。

状态：已实施。

### D-177 · 2026-09-09 · 快速检索接线：取消、共享截止与固定来源

背景：旧 bridge 取消只清本地 pending；router 用本请求超时制造 AbortSignal；每次 RPC 重取 `getInputContext`。阶段会因此换窗口、迟到结果仍可能写入，或 start 成功后把后续检索绑到已结束的 start 信号上。

决定：

1. 增加 `harness.cancel`，可带 `requestId` 和/或 `queryId`。bridge 在 abort 时先发 cancel 再拒绝；信号已经 aborted 时只发 cancel、不再发 `harness.request`。
2. router 中止对应 inflight 控制器，并调用 `cancelExploreQuery`。查询自有 `AbortController`：start 请求 abort 会链接一次；start 成功返回不得中止后续搜索/读取。
3. 本轮 `deadlineAt` 在 start 固定，阶段 RPC 只消耗剩余时间；公开工具预算 120s，`reserveForJudge` 预留判断/呈现。迟到任务看到 `terminal !== active` 即丢弃。
4. 后续阶段使用开始时 pin 的 `inputContext`；pi-host 也把同一份 clone 传给后续 RPC，避免活动窗口切换串入。已知写入仍按既有规则终结对应路径的旧草稿。
5. AbortError 在 router 仍映射为既有 `timeout` 码（取消与超时目前同码）；查询状态与工具结果须另行表达 cancelled，不能把取消写成成功材料。

影响：`events.ts`、`host-services-bridge.ts`、`router.ts`、`explore-query-store.ts`、`application-host/index.ts`；设计 6.1 取消/来源。

状态：已实施。

### D-178 · 2026-09-09 · 快速检索接线：models.explore 消费者

背景：槽位已在，explore-tool 曾直接调 Host。需要真实 ModelRuntime 改变搜索与最终原文，且不得回退主模型或另建分类器。

决定：

1. SessionHost 只在 `harnessSettings.models.explore` 解析到当前会话 `ModelRuntime.getModel` 时注入 `completeExplore`；`completeSimple` 使用 `reasoning: "minimal"`、`toolChoice: "none"` 与查询 signal。解析失败只记诊断，不改用主模型。
2. 纯路径/仅标识符定位且不问机制时省略计划；有锚点但问 how/why/机制，或计划已用过，仍做材料判断。启发式只看问题与已解析对象，不再加路由模型。
3. 计划与选择走 JSON：行为、概念分组表达、材料组、视图/范围 ID、必需范围、缺口与可选 followup。解析失败记 `failed` 并保留已有算法/向量材料。
4. 原问题检索与明确导航在 start 即启动，与计划模型重叠。计划组以 `kind: "plan"` 写入，组内变体不重复投票、不改原词区分度。Host 实际执行新表达。
5. 首版一个可选补查阶段：批量搜索/定位，去重已执行表达与已读材料；增量选择只看已选与新增视图。不是永久一次硬上限；无新材料或剩余预算不足则交回。缺口只描述本批已读材料。
6. 工具描述写明概念名与仓库标识不必字面相同。不新增费用/Token 看板。`ExploreRerankScore` 只占类型位，本轮不实现 reranker，也不与 LLM 默认串跑。

影响：`explore-model.ts`、`explore-tool.ts`、`session-host.ts`、`select-tools.ts`；设计 5.7/6.1/8.5；plan 3.15D。

状态：已实施。faux ModelRuntime 已走过公开 `explore`；真实 `models.explore` 质量未在本轮观察。

### D-179 · 2026-09-09 · 快速检索接线：开放排名、当前单元与首批机会

背景：`candidateTier` 压低纯语义；`windowScore` 把文件拼盘广播到窗口；首次读取前 `Promise.all` 三路；模型若只看旧 24 KiB 输出会丢无查询词机制。

决定：

1. 开放候选取消永久来源等级。词法/语义用真实来源名次做 RRF；无相关性顺序的图路径不按字母序伪造排名。明确导航仍走直接线索读取，不再是永久 tier。
2. 删除 `windowScore`。无模型时用单元自身词法/语义/核验依据；`hasAnchor` 只给该单元有界加分，不恢复来源墙。同源多块与多改写先归并。
3. 呈现前冻结候选视图：去重共享正文，赋予 `vN` / `vN:full` / 命中范围，按模型输入预算（48 KiB）装入，其余 `unevaluated`。选择校验视图、修订与可见范围；自选行号必须落在模型看过的正文。Host 提取原文，不把校验写成语义 verified。
4. formatter 只渲染已决定内容。带 `required` 的范围不中途裁句；装不下则换仍含必需范围的视图、放弃该组或记缺口。
5. 调度区分评分家族与生产任务。在飞主要任务各保留常规首批读取机会，其余共享；参与/空/失败/取消/截止后释放。已有正文复用。首批不是必须等齐屏障：剩余截止可提前冻结并标明 incomplete。
6. 原问题词法若致命失败且候选为空，重新抛出 `HarnessServiceError`，不得吞成空成功。

影响：`explore.ts`、`explore-query.ts`、`explore-distinctiveness.ts`；设计 6.1 召回/单元/呈现；plan 3.15A–C。

状态：已实施。

### D-182 · 2026-09-09 · 快速检索返工：查询身份、授权取消、终态与一条取消链

背景：`763ab2a9` 接通了跨进程骨架，但查询只绑 session/workspace；`queryId` 被当成授权。同一 session 换 worker、generation、run 或缩小 scope 后，新 actor 仍能操作旧查询，搜索/读取闭包却是旧 actor。`harness.cancel` 不解析 actor、不核 capability，按全局 `requestId` 即可中止他人请求。模型调用不受 `deadlineAt` 约束；Host 搜索/读取绑在 start RPC 或内部第二控制器上，`cancel`/`finish`/`release` 不能停在飞来源。`requireQuery` 只拒 cancelled，finished 查询仍接受 select，迟到选择会改最终原文。

决定：

1. 查询绑定启动时的 authority、session、worker、generation、run、workspace 与精确 workspace scope。每个阶段核对该 actor；session 重新注册丢弃旧查询。
2. `harness.cancel` 先 `resolveActor` 并要求 `read.search`。inflight 按该 actor 定位；外会话或外代的 `requestId`/`queryId` 不得中止。
3. 一条查询 `AbortController` 覆盖模型等待、rg、Documents、结构、图和语义。start 请求 abort 只在返回前链接；成功返回后断开。`finish`/`release`/`cancel`/截止中止残余工作。
4. 改变状态的阶段只作用于 active。`finish` 是单次原子终结并缓存结果；已 finished 的再次 finish 返回同一原文。cancelled 不可复活。

影响：`explore-query-identity.ts`、`explore-query-store.ts`、`explore-query-services.ts`、`router.ts`、`service-host.ts`、`explore-tool.ts`。

状态：已实施。纠正 D-176/D-177 把查询 ID 当授权、以及取消/截止未真正停止来源的缺口。

### D-183 · 2026-09-09 · 快速检索返工：原问题词法并行与真实来源结局

背景：`start` 只启动 objectPatterns；普通内容词等所有 primary source 结束后才跑。慢语义会把常见自然语言的 rg 拖到截止附近。截止只改任务状态；`finish` 的 `partial`/`searchIncomplete` 不消费 source states，语义可保持初始 `unavailable`，截止未完成被写成干净成功。

决定：

1. start 同时启动对象词法与原问题内容词法（及语义/图）。仅明确纯导航按契约省略宽搜索。
2. 计划/补查表达进入 rg **和** 当时可用的向量召回。
3. 最终结果冻结并携带 `details.sources`。failed / empty / unavailable / incomplete / cancelled 不折叠。来源因截止未完成必须是 `partial` 且 `searchIncomplete`。
4. formatter 区分“共享截止或来源未完成”与“候选工作预算用尽”。

影响：`explore.ts`；protocol `ExploreSemanticStatus.incomplete`、`details.sources`。

状态：已实施。

### D-184 · 2026-09-09 · 快速检索返工：稳定视图、增量合并、成组 required

背景：followup 重排序后从 v1 重编号，用旧 viewId 集合判断新材料，会把真正的新文件判成旧候选。增量 prompt 只展示 newViews；第二次 `applySelection` 覆盖已选。`limit` 对已 accepted 的 required 组 `slice`，静默丢掉成组证据。

决定：

1. viewId 在查询内按 `path@rev:start-end` 稳定分配，不因重排改号。新旧判断使用该逻辑身份。
2. 增量模型同时看到已选材料与新增材料。`select` 可 `merge`：按 group id 合并，不默认替换。
3. 一个 required 组装不进 `limit` 时整组放弃并记缺口，不得接受后再静默截组。

影响：`explore.ts` applySelection/followup/finish；`explore-tool.ts`；protocol `ExploreQuerySelectParams.merge`。

状态：已实施。

### D-185 · 2026-09-09 · 快速检索返工：删除改名后的混合评分与评估墙

背景：删除 `windowScore` 后，`unitOwnRelevance` / `complementaryScore` 仍混合词组数量、命中类别、implementation 类型、anchor、roleFit、关系端、字节成本、重复惩罚和语义名次。`freezeViews` 先按 assessment 分层再看该分数，对象文本命中能在模型输入预算阶段挤掉纯语义候选。

决定：

1. 模型视图与无模型打包使用单元自身词法名次（本窗口 weight / distinctive）与语义名次的 RRF 融合。
2. 明确导航 / 已核验关系是分区，不是分数加项。去重、角色、范围和字节留在对应阶段。
3. 不恢复 `candidateTier` 或文件分广播。

影响：`explore.ts`。

状态：已实施。纠正 D-179「已删除 windowScore」超过当时代码的表述。

### D-186 · 2026-09-09 · 快速检索返工：模型输入契约与 guided 输出

背景：`vocab()` 只有 symbolCount；packages/entries 无生产者。选段 prompt 不标 range 行号；原文未标不可信。计划表达只进 rg。pi-host 忽略 select 的 accepted/rejected。guided finish 不走 `loadSnippetRelations`。`remaining() > 2000` 静默关闭补查。

决定：

1. 开始返回时从已打开 graph 的 `catalogStats` 取 symbol/file 计数、package.json 父目录与 index/main/cli 入口，不等全仓摘要。
2. 选段 prompt 写明每个 rangeId 的行跨度；源代码包在 `<untrusted-source>` 内，与用户请求和假设分隔。
3. Host 全拒绝时 `model.select` 不得标 `used`。
4. guided `finish` 同样注解 excerpt 关系。
5. 去掉隐藏的 2s 补查门槛。公开 120s 剩余等待与 8s 判断预留保持，并标明不是 SLO，不新增设置 UI。
6. 模型 `complete` 接 `deadlineAt` 与调用者 signal 的合取，provider 卡住不得超过宣称预算。

影响：`explore.ts` vocab；`explore-model.ts`；`explore-tool.ts`；`explore-query-services.ts` pack。

状态：已实施。

### D-187 · 2026-09-09 · 快速检索独立验收：作用域、真实来源状态与迟到工作收口

类型：主代理验收结论 + 实现纠正；补齐 D-182–D-186 超过当时代码的交付表述。

背景：第二轮返工已修正查询身份、公开词法并行、稳定视图和终态，但逐行核对与最小反例仍发现：来源任务把
`empty/unavailable/failed` 写成 `ready`；图、向量和 catalog 词汇只在读文件时才碰路径 authority，受限 actor 会让范围外候选
消耗 Top-K 并泄露路径元数据；语义 adapter 接受 signal 却未传入运行时；bridge 本地 timeout/dispose 与 start 响应未送达不会通知
Host 清理；`complementaryScore` 仍混合多个阶段；晚到同文件语义线索不在 evidence signature 中；被拒 required 选择会留下标记，先到组的
optional 范围还能挤掉后续组的 required 范围。这些都能从当前代码构造反例，不以测试总数覆盖。

决定：

1. start 将显式 `paths` 或 actor 的固定 `workspaceScope` 变成整次查询的有效根；图候选、向量候选、catalog 词汇和模型 path locate
   都在进入查询状态前按它过滤。范围受限时不把全工作区 symbol/file 计数冒充本范围统计。catalog 的 package 词汇从实际会进入符号目录的
   `packages/<name>/…` / `apps/<name>/…` 源码路径推导；不再用生产目录不会收录的 `package.json` 写假测试。
2. `ExploreQueryTaskStatus` 增加 `unavailable`。词法、图、语义任务按本次真实结果写 `ready/empty/unavailable/failed/incomplete`；算法
   `explore.search` 与 guided finish 都返回同一 `details.sources`，截止或失败继续驱动 `partial/searchIncomplete`，可选来源不可用不伪装成失败。
3. 同一个 actor request key 由 authority/session/worker/generation/run/requestId 组成。bridge 的 timeout、dispose、signal abort 都先发
   `harness.cancel`；start 响应未送达通过 Router delivery 回调释放查询；store 在既有 `deadlineAt` 中止无人继续消费的来源。
   semantic runtime 接 signal，取消后立即停止等待并禁止迟到向量写回本查询。当前 native ONNX 推理批本身不能被 JS signal 抢占，可能在后台
   完成该批；这条能力承诺是调用链停止等待和丢弃迟到结果，不虚构硬件级抢占。
4. 文件和单元的词法同分保持同 rank，路径只稳定顺序；纯语义单元不再得到伪造的词法票。删除 `complementaryScore`；导航、角色、
   去重、局部互补与 hit class 逐级处理。机制问题中的 anchor 只在单元词法依据同分时优先，不恢复覆盖纯语义候选的永久墙。
5. 已读文件记录“本次构建实际消费的 evidence signature”，包含语义块身份；来源在 outline/classify 等 await 期间到达会触发重建。
   所有外部来源 await 后再检查 signal，迟到任务不能修改冻结结果。
6. 选择按 item 原子验证范围与整数行号；无效 required 使该材料组拒绝。required 标记只从最终接纳并打包的组计算；所有组的 required
   先于 optional 占用 excerpt limit，后续 required 不再被前组 optional 挤掉。pi-host 只把 Host 真正 accepted 的视图交给增量判断，
   计划/选择/补查的 `used` 也以实际 launched/accepted 为准；补查失败不抹掉已经生效的首轮选择。

验证边界：公开 `explore` 的真 Pi faux-provider 纵切证明 ModelRuntime 计划表达进入 Host 搜索并改变最终原文；定向测试覆盖同文件晚到语义、
受限 actor 不见范围外路径、来源状态、响应未送达、bridge timeout/dispose、语义等待取消、稳定视图、required 组和终态。真实
`models.explore` provider 的质量与墙钟仍未观察，作为使用事实记录，不退回“部分实现”或另设启用门。受限范围的图/向量后端当前仍先做
全工作区 Top-K 再过滤，可能损失范围内召回；3.16 的 scoped 索引/查询优化继续处理，但不得泄露范围外候选。

影响：`explore.ts` / query store/services/identity、router、bridge、semantic runtime、protocol、plan 3.15、status 3.15。

状态：已实施并接入公开工具；真实 provider 观察与 3.16B–E 仍按各自项目推进。

### D-188 · 2026-09-09 · 快速检索验收补项：搜索启动不等于到达即读

类型：主代理验收结论 + 调度修正。

背景：D-179/D-183 要求原检索与计划模型并行、候选到达即读，但 `start()` 只启动来源任务，唯一的 materialization pump 要到 pi-host
完成计划模型后调用 `explore.query.views` 才运行。搜索虽已并行，正文读取仍串在模型之后；计划模型若越过 `deadlineAt - 8s`，pump 会先
看到预算耗尽并冻结空视图。原 `reserveForJudge` 因此没有真实保留判断/呈现材料。测试“rg 在慢语义前启动”不能证明这条行为。

决定：查询 `start()` 在 Host 立即启动唯一的后台 pump；来源到达后按同一调度器读取，`views` 只等待/接续它。计划和补查新增任务时复用
同一个 pump，不能并发启动第二套读取循环。query store 在既有 `deadlineAt - reserveForJudgeMs` 中止来源等待，整体 deadline 仍留给模型选择
与 finish；来源截止后提交的计划/补查不再报告 `launched`。后台错误保存到查询并由阶段调用者取得，不制造未处理 rejection。

验证：`explore-query-run.test.ts` 在只调用 `start()`、尚未调用 `views` 时观察到 `readFile`；原词并行、晚到来源重建、截止冻结与公开
ModelRuntime 纵切继续通过。

影响：`explore.ts` query pump；`explore-query-store.ts` source deadline；plan/status 3.15。

状态：已实施。

### D-189 · 2026-09-09 · 快速检索作用域内 Top-K

背景：D-187 已固定查询开始时的 effective roots，但图符号召回仍在全工作区候选上截断，reverse importer 也在范围过滤前截断；语义召回仍使用全库 `searchExact`，再由 explore 过滤命中。这样范围外高排名候选可以占满 K，丢掉范围内命中。语义索引的文档更新和删除还必须使作用域候选身份保持最新。

决定：

1. 显式 paths 先使用 Router 已授权的 workspace-relative `resourceId`，查询 start 再固定 effective roots 并通过同一次 Host 查询闭包传给图与语义后端；路径匹配复用 `pathInRoots` 的 `.`、分隔符和 Windows 大小写语义，后续阶段不能改范围。
2. 图 `searchSymbols` 在评分和 Top-K slice 前按 roots 丢弃候选；reverse importer 在 `rankReverseImporters` 截取每 seed 的预算前按 roots 过滤。图连接返回继续在既有预算消费前由 query engine 过滤，不扩大公共接口。
3. 受限语义查询枚举当前 generation 的 scope 内 block IDs，使用 TriviumDB 0.8.6 `searchGraphFirst` 在完整 anchor 集合内计算精确 Top-K；`.` / 空 roots 保留 `searchExact` 快路径，不以固定 oversampling 或放大 K 模拟作用域召回。文档→block ID 映射首次按 block 索引惰性建立，已建立后由发布/删除按文档增量维护。
4. scope 过滤发生在后端返回候选前，范围外路径、块正文和计数不进入本次查询材料；没有新增硬上限。既有未受限查询的索引和排序行为保持。

验证：图与语义最小反例都构造“全局前 K 在 scope 外、scope 内仍有命中”；`.` 快路径、文档替换/删除缓存失效、reverse importer 过滤前截断、显式路径归一到已授权 resourceId，以及 start→Host→后端固定 roots 的调用链均有定向测试。未受限语义仍保留现有 `searchExact` 行为。

影响：`workspace/path-scope.ts`、`knowledge/store.ts`、`knowledge/semantic/store.ts` / `runtime.ts`、`explore-query-services.ts` / `explore-service.ts`、`explore-graph.ts`、`explore.ts`、对应测试；设计 §6.1、plan/status 3.15 作用域限制更新。

状态：已实施。

### D-190 · 2026-09-09 · 远程 embedding 配置种类、空间身份与后台绑定（3.16B）

背景：代码语义索引只有本地 MiniLM。不能把任意 chat model id 当成 embedding 模型，也不能借“第一个活动聊天会话”做后台索引。Host 不能持有 provider secret。知识库 `knowledge/embedding.ts` 适配器不是这条生产链。

决定：

1. `harness.embedding` 与 `harness.rerank` 是用户所有的配置种类，不进入 `HarnessModelRole`。工作区设置不能改绑。Settings 使用独立入口，不是聊天模型选择器。
2. 第一条远程协议是 OpenAI 兼容 `POST {baseUrl}/embeddings`。空间身份为 `remoteEmbeddingSpaceParts(protocol, providerId, modelId, maxTokens, dimensions|"auto")` 的 sha256 前 16 位；凭据从不进入 space id。仅凭据轮换不重嵌未变化正文。
3. 后台绑定复用 workspace worker 的 `ModelRuntime` 与同一份 `auth.json`。Host 经 `harness.embed` 只提交已授权正文、用途、批次和绑定。关闭最后一条聊天不终止索引；Host/Pi 重启后从 settings 与 auth.json 恢复。`setRuntimeApiKey` 是进程内覆盖，持久恢复走 AuthStorage。
4. 统一调用契约携带 document/query 用途、vector space、实际输入、取消信号、批次与结果身份。远程响应必须核对数量、唯一 `index` 0..n-1、一致维度和有限数值；错误不得发布部分错位向量。
5. 远程配置有效时，文档索引与查询使用同一 space。失败时语义来源报告 `failed`/`unavailable`，词法与图继续；同一查询不得静默切回本地 MiniLM 或其他 space。provider/model/maxTokens/配置维度改变建立新 space/generation；新空间已发布部分可按 partial 查询，不混入旧空间。

验证：protocol 设置合并（workspace 不能留下 embedding/rerank）；pi-host embeddings 乱序/缺项/维度/NaN/取消；后台绑定 Settings→faux HTTP→不回传密钥；凭据轮换保持 space、换 model 换 space；公开 explore faux-provider E2E。未配置远程时本地 MiniLM 路径保持。

影响：protocol harness-inference/settings/methods；pi-host BackgroundInferenceRuntime；Host remote-embedder/backend；Settings Embedding 段；设计 §8.5；plan/status 3.16B。

状态：已实施。

### D-191 · 2026-09-09 · 向量复用、完整编码与前后台调度（3.16C）

背景：D-173 要求按实际 embedText 复用、长行续切、前台优先和 Node ORT 真 session 线程。先前只有批推理与尺寸查找，缓存与调度未完成。

决定：

1. 向量复用身份是实际 vector space + 用途 + 真正发送的 embedText。路径、位置、revision 或父单元元数据变化且正文未变时复用向量；只重嵌变化块。
2. 查询向量缓存绑定问题文本和 space，只复用向量计算；scope Top-K、路径授权和来源身份每次重做，缓存不能绕过 D-189。
3. 同一 scope 的并发扫描合并到在飞工作。调度器一次只跑一批：已进入推理的当前批完成，随后前台优先于下一批后台，后台保留进度；不把全仓批次预先塞进队列。
4. 冷扫描在 `markBuilding` 之后仍要等本轮第一个兼容发布事件才能查 partial；不按每个批次重查，也不延长原查询截止。迟到旧 revision 不能覆盖新 revision（`publishToken`）。
5. 每块按所选后端的真实输入能力切分。本地 MiniLM 512 token 不套到远程；远程 Host 侧用保守字符长度续切。超长单行必须继续切分，测试从全部 chunks 证明原文范围无缺口。
6. 本地 Node ONNX Runtime 的 `intraOpNumThreads` 写到真实 inference session，不只配 WASM。
7. 扫描结束对账删除与读失败；重启恢复已发布批次和 generation checkpoint。coverage / lifecycle / empty / source failure 保持不同状态。内存向量缓存按向量字节软预算淘汰，满了不拒绝正常查询。

验证：复用/单块重嵌、前后台顺序、scoped 缓存仍做授权 Top-K、长行覆盖、迟到 revision、并发扫描合并与 checkpoint 恢复、partial generation。未编造全仓冷扫时间。

影响：semantic vector-cache/embed-scheduler/chunker/minilm/store/runtime；plan/status 3.16C。

状态：已实施。

### D-192 · 2026-09-09 · 固定草稿与线程分支的语义覆盖（3.16D）

背景：词法/读取已固定 surface draft 与 WorkingState 分支。语义若仍读磁盘向量，会在草稿嵌入完成前泄露旧正文，或把缺向量写成缺正文。

决定：

1. 查询开始时固定 `inputContext`。路径存在固定草稿时立即从本轮候选遮蔽旧磁盘向量，不等草稿 embedding 完成。
2. 草稿正文先供词法与读取；embedding 后台完成。尚未完成时语义来源报告 `draft-vector-pending` / `draft-unavailable` / partial，不读旧磁盘向量冒充草稿，也不把缺向量写成缺正文。
3. 覆盖 dirty-only 新文件、已有文件未保存修改、`content: null`/删除、捕获后继续编辑、写入终结旧草稿后改按新磁盘 revision（`superseded` 不再遮蔽）。
4. 线程语义视图使用父 workspace 上该分支的固定 baseline + 自身 delta，不借 live 父目录；父线程后续改动与兄弟分支的路径/向量互不可见。tombstone、文件替换和新增都生效。
5. 可以复用相同 embedText 的数值向量，但 scope membership、路径权限、revision、surface/thread ownership 分别保存和校验。继续使用 D-189 的 scoped anchor Top-K，不另建先全局召回再过滤的 overlay 查询。

验证：立即遮蔽、dirty/deleted/supersede pin、兄弟线程隔离、working-state extras。线程对象读取失败记 `thread-vector-pending`。

影响：semantic/query-view.ts；runtime overlay/mask；Host `semanticRecall`；thread-runtime `getSessionBinding`；plan/status 3.16D。

状态：已实施。

### D-193 · 2026-09-09 · 专用 HTTP reranker 与 LLM 选择互斥（3.16E）

背景：需要统一排序时不能把 chat completion 改名为 reranker，也不能在 `models.explore` 已经成组选段后再付一次判断。

决定：

1. `harness.rerank` 使用明确 wire contract：`POST {baseUrl}{endpoint||/rerank}`，正文为 `{ model, query, documents: [{ id, text }], return_documents: false }`，结果为 `{ results: [{ id?, index, relevance_score|score }] }`。不宣称 OpenAI chat/embeddings 天然支持 rerank。
2. 输入直接消费 3.15B 已构造的当前候选视图（query、稳定 view ID、revision、拟展示正文）。超过后端限制时先构造仍可展示、身份明确的较小视图；不能让后端静默截断后仍声称评估了完整函数，也不能评分后再裁掉作为依据的正文。
3. reranker 只输出同一批次内的顺序/分数。不推断成组互补、required ranges 或缺口；不把不同模型/批次分数混用；不与词法/语义来源分数相加；未评估候选不补伪造零分。
4. `models.explore` 的 select 为 `used` / `failed` / `cancelled` 时不调用 reranker；仅当 select 为 `skipped` / `unconfigured` 且绑定有效时走 rerank。一次普通查询不无理由同时支付两次判断。
5. 配置有效且本轮符合条件时自动进入公开 explore。失败保留已经取得的来源排名与可读材料，details 报告未参与/失败，explore 整体不失败。

验证：finish-service 在 select=used 时不调用、select=unconfigured 时调用；HTTP 部分响应与非法身份；公开 explore faux-provider E2E 实际打到 `/rerank`。未观察真实 rerank 质量或费用。

影响：pi-host http-rerank；explore-rerank.ts；explore-query-services finish；Settings Rerank 段；设计 §6.1/8.5；plan/status 3.16E。

状态：已实施。

### D-194 · 2026-09-10 · 3.16B–E 身份、配置权威、当前性与取消边界纠正

背景：D-190–D-193 的首轮接线把多个 workspace 共用的 Host 可变绑定、受项目 provider 覆盖污染的 ModelRuntime、可被公开 surface 调用的内部方法、无远端取消的 Promise 等待，以及 provisional `auto` 维度空间误当成已解析身份。扫描和 rerank 还存在旧 revision/旧终态继续产生副作用的竞态。

决定：

1. Application Host 以 workspaceId 保存 cwd、原始 Settings 快照、Pi 解析后的 binding、backend 与 semantic runtime；跨 workspace 仅共享本地 MiniLM、调度器和按完整 space 身份复用的数值向量。每次扫描/查询固定本轮 embedder。活跃 isolated child 直接查询其物化 cwd 的 Documents workspace，不把父 WorkingState `baseState + deltas` 当语义全文，也不把 `copyIgnored` 输入外发。
2. Pi 后台推理使用隔离的 user/operator-only provider runtime；项目 `.pi/models.json` 仍可影响普通聊天，但不能重定向 embedding/rerank 去取得用户 AuthStorage 凭据。Pi 只向 Host 暴露 credential-free `configurationId`。空间身份包含实际采用的去凭据 URL/API、provider/model、切块上限与最终实际维度；自动维度在首个真实输入解析前不打开持久库，凭据轮换不换空间。
3. embedding/rerank parser 仅把字段缺失视为未配置；错误协议、必填项、数值或 endpoint 是 invalid。Settings mutation 在写盘前拒绝 invalid，历史畸形可选项不阻断普通会话与修复入口。UI 保存保留未显示的 dimensions/maxTokens/maxDocumentTokens；只有明确清空 provider 才删除，provider 已选但 model 不完整不解释成删除。
4. `harness.embed`、`harness.rerank`、binding describe 与 inference cancel 是 Application Host→Broker→Pi Host 的内部 HostMethod，不在 renderer/web/mobile RuntimeMethodMap/dispatcher。每个批次使用唯一 ID；Host abort 后立即停止等待并丢弃迟到响应，同时发送显式 cancel，Pi 的 batch AbortController 中止尚未开始的工作或实际 fetch。Host/Pi 双侧核对完整冻结绑定、批次及返回身份。
5. 扫描开始即建立 scope 当前性 gate；旧 checkpoint 在本轮核对前不参与。当前 revision 的 unchanged/published 文档才解除 mask；读失败保留具体 gap 与 partial/incomplete，删除与 mutation token 保证后发变更胜出。设置/provider identity 改变会取消旧扫描并启动该 workspace 新空间扫描，旧空间不混入。
6. rerank 只评分身份与正文完全一致的 view；超预算 view 不截断冒充原 view。finish 已终态先返回冻结结果，malformed/失败/取消只降级 rerank，来源结果保留。来源截止与总查询/取消信号分开，partial 合法分数只重排实际评分项。

验证：protocol missing/invalid 与 public RuntimeMethod 排除；Pi 后台项目 provider 重定向、binding 竞态、endpoint/credential space、显式 cancel 到 faux fetch；Host 双 workspace 交错 transport、自动维度漂移、in-flight 删除、overlay pending、rerank exact view/终态/malformed；UI 隐藏字段 round-trip。真实 provider 质量/费用、完整冷扫墙钟与活跃 child 修改后的整条公开 production-chain 仍未观察，不由手工 consumer 测试代替。

影响：protocol harness inference/settings/runtime；pi-host background inference/Host dispatch；runtime-broker catalog/internal dispatch；Application Host workspace semantic wiring/runtime/store/cache/query view；explore rerank/finish；Harness Settings UI；plan/status 3.16B–E。

状态：身份、配置、取消、当前性与重排边界已实施；真实 provider 与活跃 child 的完整公开纵切仍待观察。

### D-195 · 2026-09-10 · 异步索引发布、文件筛选与查询终结收口

背景：D-194 返工后的关键验收发现，旧发布完成仍可能解除新修改的 mask；扫描删除 token 取得过晚；自动维度在空目录重启后未对账旧库；增量 mutation 没有复用冷扫筛选；收包预登记在畸形请求失败后残留。草稿建设若与查询来源窗口同寿命，快速查询会反复取消它。

决定：

1. 扫描在目录枚举前取得修订 token，逐路径与之后的 mutation 比较；发布与删除完成后再次校验 token，只有当前任务能解除遮蔽。读失败保留 gap/incomplete，成功重扫可恢复。自动维度的空目录扫描不发探针请求，首个真实查询解析维度后对账旧持久库，旧内容不能复活。每次查询与扫描使用已选择的 embedder。
2. 增量 mutation 在读正文前执行与冷扫一致的目录、隐藏文件与 Git 跟踪/忽略筛选。单路径检查不枚举全仓；Git 无法回答不视作允许。非 Git 普通文件沿已有文件范围处理。`copyIgnored` 不自动扩大语义语料；草稿也在固定 roots 内才参与向量建设。
3. 同空间、用途与正文的在飞向量任务可复用。草稿正文在查询中捕获后移交 workspace runtime 的后台索引任务，正常查询结束不会取消建设，runtime 关闭会取消；查询自身的推理与等待仍可取消。只复用数值向量，路径、分支与草稿修订各自保留。
4. Host 首次 workspace 初始化在解析 binding 前不对并发调用者暴露默认 backend；刷新按 workspace 串行，读失败与未配置分列。workspace worker 退出后废弃旧 watch，在下次使用时重新绑定、订阅并恢复扫描。仅配置 reranker 时，首条查询也等到配置解析后保留判断时间；异步准备算在原查询截止内。
5. Pi reservation 按已收 requestId 管理 batch 所有权，所有终结路径释放；重复 batch 不抢占首请求，未知取消不创建记录。并发与重复 explore finish 共用一次 rerank 和冻结结果。字符长度只是远程输入估算，不能称为 tokenizer 上界。

验证：`semantic/runtime.native.test.ts` 的发布/目录/失败/重启/固定 backend/草稿生命周期反例；真实 Git 文件筛选；HostController + MemoryHostTransport 的排队取消、重复 batch 和失败后复用；workspace inference 配置状态测试；finish 异步设置与并发幂等。真实外部 provider、完整桌面多工作区与活跃 child 公开纵切仍按 status 的未观察项记录。

影响：semantic runtime/store/cache、fs search、Application Host 装配、Pi inference dispatch、explore query services/store、plan/status 3.16B–E。

状态：已实施。

### D-235 · 2026-09-12 · 3.16（语义生产装配与原生写入通知）

类型：问题与解法

背景：3.16 的远程 adapter、索引和公开工具各有测试，但 Application Host 的 workspace Settings、binding、watch、查询视图和 rerank 装配仍散落在 `index.ts`。原生 Pi 工具的 journal after 只使旧 surface snapshot 失效，没有通知语义索引；物化 child 在 settle 前可能继续检索旧向量。

决定：

1. `createWorkspaceSemanticRuntime` 承担现有 workspace 装配，Application Host 直接使用它的 `semanticRecall`、`harnessSettings`、`rerankExploreViews`、配置事件和关闭方法。索引、对象、凭据仍沿原权威；测试与生产不再各自拼装这些 callbacks。
2. 成功的原生工具 journal after 在确认给 worker 前，把该 execution workspace 内的路径变化通知同一语义运行时。已打开索引立即遮蔽旧向量，重读 Documents、过滤和嵌入在后台完成，不等待模型才确认编辑。普通 Documents 写入也沿同一路径。未知外部 shell 写入不因此冒充已有精确观察。
3. virtual child 使用查询 pin 的 WorkingBranch 正文；materialized child 使用自身 Documents workspace。虚拟 pin 不可用时明确失败，不换成父 live 或空 scratch。远程配置有效时文档与查询共享 space，失败不改绑本地模型。
4. 新查询等待已入队的配置刷新；workspace worker 退出使旧 binding 不可用，迟到旧响应不得发布。查询取消包括 Settings/describe 等待；关闭后迟到注册的 watch 要释放，不能复活状态。

原因：这次缺的是实际消费者连接及其生命周期。提取同一生产装配单元后，公开工具测试可以覆盖 Settings→远程调用→索引→检索，而原生写入通知修复了单独 adapter 测试无法发现的陈旧结果。

验证与边界：证据在 status 3.16。公开工具与实际 Host 装配模块、Documents、Pi 后台 inference、HTTP/向量存储的本地调用链，不等于完整桌面启动或真实外部 provider 的速度/质量。既有有效配置即启用，不新增实验开关或数值配额。

### D-288 · 2026-09-18 · 3.16（本地语义组件按需安装）

类型：默认值调整

决定：本地 MiniLM 保留为用户主动安装的独立组件。主安装包、普通 Host 构建和首次启动不携带或自动下载模型、transformers、Node/Web ONNX。未安装且未配置远程 embedding 时，词法与结构/图检索继续，语义来源明确不可用；有效远程配置仍优先，不静默回落到本地。

原因：Windows 0.9.11 安装目录实测约 875 MiB、20,840 个文件。专用推理库、浏览器 ONNX、两份模型与重复内核均进入了主包；用户明确要求按需安装，而非让所有安装都承担本地推理成本。文件解压和扫描可能贡献安装等待，尚不能从体积推断用户机器上的耗时比例。

实现边界：Settings → Harness → 检索提供显式下载安装和离线导入。组件按版本/平台/架构独立发行，自含模型和 Node 推理闭包，无须用户安装 npm、Bun 或 Python。安装先验证文件身份、平台和真实推理，再原子启用；失败和取消保留已有完整组件。索引与知识的原有权威不变，TriviumDB 等被正常检索共用的存储仍随应用提供。主安装和可选组件分别验证，不借开发目录中的推理库证明发行包可用。

状态：已决策，实施与验证证据随本次交付回写 status。

### D-312 · 2026-09-21 · 阶段 F（快速决策模型与渐进检索）

类型：默认值调整 / 后续设计

决定：统一产品名称为“快速决策模型（Fast Decision Model）”，建立供应商无关的选择、判断和评分能力，
使用独立配置种类、通用默认绑定及用途覆盖。Jev 为首个 adapter 目标，不以供应商品牌命名公共服务。
首个消费者在现有 `explore` query 内分别判断材料返回价值与下一步探索价值，从当前源码和关系动态产生具体动作候选，
执行后继续增量判断；生成式 `models.explore` 保留新搜索表达职责。选材不再机械串联多个同目的模型。

原因：用户希望利用低延迟判断模型改善语义检索，并为未来 Computer Use 等功能复用。现有文字、图、向量和
原文读取能提供动态候选，新的判断能力可以决定如何探索；简单转发代码虽然不适合直接回答，却可能是重要下一跳。
Jev 当前不生成自由文本，其合法输出不证明判断正确，不能直接替换现有生成式接口或把重排分数当完整检索计划。

考虑过的替代：仅作为 `/rerank` 模型接入无法表达下一步选择与跨用途能力；替换整个生成式检索模型无法生成新表达；
逐层只选一个目录会丢失跨文件线索；全部规则改成模型会把可以精确计算的事实变成不确定判断。采用能力适配、
动态候选、多方向展开与原有确定性执行，未来模型按实际支持的模态/输出加入。

影响：新增 `fast-decision-model-design.md`；plan 增加 F0–F4，harness 6.1/8.5、architecture、roadmap、status 同步。
本决策扩展 D-174–D-193 的局部判断与补查目标，历史交付记录保留。原 query 来源、范围、取消和凭据 authority 不变；
不新增全局深度/轮次/并发/概率硬门槛，不以独立评测或真实付费模型测试作为开发前提。Computer Use 等未来消费者不在本阶段实施。

状态：F0–F4 已实施并接线（wired）；无真实付费调用、实测速度或检索质量结论，其他消费者未注册。

### D-315 · 2026-09-22 · 阶段 L（Web 与科研检索、连续阅读与协作复用）

类型：默认值调整 / 后续设计

决定：把 Web 与科研搜索增强排入阶段 C 之后的 L0–L6。复用已有通用 `retrieval`、科研 `investigation` 和普通
`dispatch(task)`，沿原生搜索/读取增加目标、批量调用、固定原文视图与材料复用；科研补论文身份/版本、引用关系、
集合内段落检索、图表/附录和代码/数据关联。主/检索 Agent 负责问题调整与新表达，快速决策能力批量选材和选动作，
程序拥有执行与来源身份。能力在各工作台共用，研究侧重和 UIUX 选择不成为使用搜索的前置。

同时调整后续 retrieval 交付：自然语言报告可作为正常成果，`submit_facts` 变为按需结构化事实入口。
实施须贯穿提示、类型、settle/seal、耐久报告与 read_thread/wait/上下文/UI，不因未填 facts 覆盖有效报告。
本决定部分替代 D-227/D-230/D-234 的唯一结构化交付要求，保留只读、scope、Run 身份、Host 来源核对和引用保护；
source-checked 不等于 claim-verified。共享原文内容不共享其他 Run 的 receipt authority。

原因：用户希望强化搜索对问题发现、理解与实践的作用，并纠正“只有科研才有检索子 Agent”的误解。
现有通用 retrieval 已含本地与 Web 工具，但缺专用模型时不显露；科研 investigation 是另一个既有 capability。
smartsearch 的能力路由和 Jev 迭代可供参考，其规则候选和普通 research 的机械 gap 收口不足以表达开放调查；
学术原文、关系与共享材料比新增一层研究框架更直接补足当前能力。

考虑过的替代：整套引入社区研究 runtime 会复制 Thread/模型/任务 authority；所有查询自动开子线程或先跑模型路由
会放大简单搜索的成本；只多接 provider 不能改善正文阅读和材料接续；将候选判断当成完整搜索策略会被候选池限制。
采用真实能力查询与渐进披露、灵活的 Agent 探索、按需批量判断和既有可靠执行，不设固定研究流程与统一硬配额。

影响：新增 `web-research-search-design.md`，plan L0–L6；主合同 5.8/6/9.2.2、research-cluster-design 7.5、
fast-decision-model-design、architecture、status、roadmap、development 与决策索引同步。
D-289 默认搜索与用户显式选择继续有效，D-312 现有 explore 消费者不变。L 阶段才注册 Web/学术快速决策用途，
不新建会话库、scheduler、正文 authority 或强制 Skill。专项训练、全球文献索引及全部学科数据库接入另行讨论。

实施进展（2026-09-23）：L0 已将 retrieval 的自然语言报告接为正常结果，`submit_facts` 变为可选的 Host 核验补充；无 pending
facts 时不覆盖 prose 或伪造 source-checked。L2 首个纵切新增 Host `research.search` 与 Pi `research_search`，复用 OpenAlex /
Semantic Scholar 的公开元数据和开放获取入口，支持搜索、详情和 provider 分页游标；关系展开、结构阅读、集合持久化与快速决策
消费者仍未接线。适配器状态不等于已读正文，真实质量/延迟未测。

补充边界（2026-09-23）：检索分支负责材料、原文位置、冲突与未知，不要求中等模型在每轮形成当前判断或“改变判断的条件”。
主线或明确发起的高能力综合任务才把材料汇总为暂时判断；程序不把检索解释自动写入主线状态，也不因新材料到达自动改写已有判断。

实施进展（2026-09-23，L1）：`web.search` 扩展为批量契约（query/objective/queries/urls/cursor），每项独立状态
（ok/empty/unavailable/failed/cancelled/partial/denied/unsupported），分页 cursor 由声明能力的 provider 铸造并绑定
provider 身份与筛选；`web.fetch` 新增 `snapshotId` 回读与 `refresh`，成功正文固定为 `web.snapshot` 内核记录
（内容 hash 去重、parser 表示、获取时间），行/find 位置绑定快照内容。快照回收沿 owner 生命周期处理：Thread 所属快照跨 Run 结算和 workspace reconcile 保留，Thread 删除时回收；无 Thread 的会话快照随 session drop 回收，
被存活记录引用时继续保留。快照读取按当前 session/thread scope 校验，同一 Thread 的后续 Run 可重读，跨 Thread 的显式材料授权留到 L4；
foreign receiptId 不授权。同 URL 在飞读取按
（url/render/策略）共享，逐等待者取消。URL 条目经 Host 真实 web-fetch 路径执行。UI 来源卡展示 snapshotId/hash。
不设固定缓存天数/数量硬配额，不新建正文 authority。

状态：L0、L1 与 L2 首个学术发现纵切已 wired；L2 其余及 L3–L6 仍待实施。无真实付费渠道质量/延迟对比，不预设效果优势，
也不将此作为代码接线的门槛。

### D-316 · 2026-09-23 · L1 验收纠正：快照 owner、刷新身份与读取 scope

背景：L1 首轮实现把同一 URL/内容的快照去重做成 workspace 范围，导致另一个 Thread 可能拿到前一 Thread 的临时记录；`refresh` 在正文未变化时也会复用旧 snapshot；线程 Run 结算和 workspace reconcile 会过早释放仍被 Thread 报告引用的快照；缓存命中没有再次按最终 URL 检查当前域策略。

决定：

1. Thread 所属快照跨 Run 结算和 workspace reconcile 保留，Thread 删除时才回收；无 Thread 的会话快照沿 session drop 回收；存活 evidence/receipt/来源记录仍优先保护其正文对象。
2. 同一 Thread 的后续 Run 可以用自身当前 session/thread scope 重读；跨 Thread 的材料授权留到 L4，不把 snapshotId 当 workspace-wide bearer token。foreign receiptId 仍不能授权。
3. 同一 Thread 和相同内容可以复用 snapshot；显式 `refresh` 即使正文 hash 不变也铸造新的 snapshot identity，旧引用保持不变。共享正文对象继续按内容 hash 复用。
4. cache 命中重新检查最终 URL 的当前 domain policy；缓存或共享结果交付给其他 Run 时重新绑定其材料 owner，不携带前一 Run 的 receipt。
5. PDF 文本解析失败返回明确失败，不把占位错误文本保存成可读正文。

验证：L1 web materials/fetch/retrieval-artifacts/session registration/web search 聚焦套件 63/63；application-host、pi-host、protocol 类型检查和改动文件 lint 通过；文档检查 9/9、378 页/858 链接通过。真实 provider、跨平台和完整桌面重启仍未实测。

状态：已实施并推送。

### D-317 · 2026-09-23 · L2 关系展开与 L3 材料集合/结构阅读

背景：L2 首个纵切只覆盖搜索与详情；L3 需要显式材料集合与结构化阅读，同时要守住"快照 id 不是跨线程 bearer token""元数据不等于正文"两条边界。

决定：

1. 关系结果保留 provider record id、canonical 身份、版本、来源记录、可见/缺失字段与续页游标；DOI/arXiv/provider id 分立存储，标题或语义相似不产生身份合并或引用边。
2. 关系展开按需、分页、可取消（OpenAlex referenced_works/cited_by 过滤，Semantic Scholar /references|/citations）；不固定跳数，不建全库图；关系命中的开放入口经 `webfetch` 进入快照链，入口存在不表示正文已读。
3. 材料集合是 `material.collection` 内核记录：成员为 snapshot/URL/论文身份的引用而非副本，URL 成员经完整 `web.fetch` 授权路径固定为快照；集合的 `references` 让成员正文对象沿 keep-if-referenced 规则存活。
4. 集合内关键词检索先应用集合范围再扫描成员正文，每个成员按调用者自身权限回读，不可读成员单列 `unreadable`；foreign snapshot id 不构成授权。
5. `persisted` 集合跨线程生命周期保留并对工作区可读；临时集合随线程删除、会话 drop 和工作区对账回收；持久化不放开写权限——写仍要求属主身份。
6. 结构阅读用快照 `structure` 如实记录检测到的 headings/tables/figures/pages（PDF 页码由 pdf-text 页边界映射）；`structure-unsupported`（该表示无法表达）与 `position-not-found`（结构在但目标缺失）分态表达，不做占位猜测。重型版式/OCR 仍属可选 adapter，不进基础路径。

验证：material-collections/web-fetch/web-materials 聚焦套件 35/35；pi-host webfetch/websearch/research_search/select-tools 30/30；application-host 与 pi-host typecheck、protocol build 通过。真实 provider、付费渠道与完整桌面路径未实测。

状态：已实施，未推送（待主代理验收）。
[status.md](../status.md)。

### D-321 · 2026-09-23 · L2–L6 主代理验收修正

背景：阶段 L 的聚焦测试覆盖了主要服务，但首次干净类型构建暴露了生产装配和工具注册遗漏；材料集合的持久化与共享语义也需要沿实际读取 authority 补齐。

决定：

1. `HarnessServiceHostOptions` 与生产返回对象必须同时携带 `researchDecideService` 和 `materialCollectionsService`，否则服务只存在于 index 装配而不会进入 router。
2. `research_decide` 在有 Web 搜索能力时即可装配，不能错误依赖 `research_search`；`research_decide` 与 `materials` 加入统一工具元数据和执行资源计划，作为只读、可并行工具。
3. `persisted` 集合的成员在集合仍保留时按工作区材料资产读取；共享集合的 grant 按当前 collection 成员解析，后续加入的成员可被授权线程读取，删除成员或集合立即收回读取权，写权限仍属于集合 owner。
4. 集合检索不使用未声明的固定命中上限；调用方可选提供 `limit`，未提供时由实际输出容量决定披露。

验证：聚焦 web/research/material 套件 50/50、工具选择与协议工具元数据 19/19、完整 `bun run type-check` 通过；新增持久集合跨线程读取、共享集合后续成员读取和 Web-only `research_decide` 覆盖。真实 provider、复杂 PDF/OCR、完整桌面和跨平台仍不作为本轮验证结论。

状态：已实施；主代理验收接受 L2–L5 与 L6 的设置/工具/来源投影接线，L6 完整固定阅读器、集合管理 UI 与复杂 PDF/OCR 保持后续边界。

### D-322 · 2026-09-23 · 复杂 PDF、OCR 与图表视觉阅读

背景：Codex 本地 PDF 能力已经证明“文本层定位 → 选页渲染 → 模型视觉检查”适合一次性回答，但 Varin 当前的 PDF 路径只保存
逐页文本和简单页边界，不能复用表格、公式、图表和区域位置，也不能把视觉材料交给 Agent。

决定：

1. 原始 PDF/页面图像是固定输入权威；文本层、OCR、版面/阅读顺序、表格、公式、图和图注是带输入 hash、解析器身份/版本、配置、
   时间和状态的派生解析版本。换解析器不改变旧版本位置，重新取得文件才产生新原件身份。
2. 结构对象使用统一材料视图表达 page/text/heading/table/table-cell/figure/caption/formula/ocr-block，保留父子、阅读顺序、页码、
   坐标系、页面尺寸、provenance 和不确定/失败状态。表头/单位/脚注、公式原图和图表原图不得在转 Markdown 时丢失。
3. 阅读采用渐进式披露：基础文本和页码先可用；版面/OCR 只升级相关页；图表、公式、表格视觉增强按问题请求。解析任务可取消、可重试、
   相容请求共享，等待者取消不影响其他等待者；复杂组件不进入基础安装包。
4. 公开阅读入口必须能返回真实页面或区域图像，并让结构位置、原件、解析版本和模型派生描述相互可追溯。普通 Agent、科研工作台、Thread 和
   实验复用同一材料/权限 authority，不新增 PDF 专用数据库或研究流程 DSL。
5. 实施分为 L3-P0 原件/页面视觉、L3-P1 版面/OCR/结构适配器、L3-P2 表格/公式/图表增强与阅读器交接；首个解析器与真实论文样本质量
   在实施后记录，不对解析准确率作先验保证。

状态：设计已接受；初始纵切由 D-326 整理为独立阅读能力。原页不再被迫绑定文本解析版本，复杂样本总体质量仍需观察和迭代。

### D-326 · 2026-09-24 · 原件优先的独立文档阅读

背景：原实现将 PDF 全文解析放在网络获取路径内，看原页依赖整篇文字成功；布局启发式不能代表论文结构，像素裁剪也不能与文本位置稳定联动。

决定：

1. 原件先固化到既有 kernel 对象/快照；`document_read` / `materials.read` 独立提供 overview、文字、页面/区域图片、结构视图。`webfetch` 保留下载并读取的便捷入口；本地 WorkingState 与实验 artifact 仍经过各自现有权限取得字节。
2. 原页/区域引用绑定原件 hash、页码、规范化页面坐标；文本与结构元素另外绑定 analysis ID。解析配置、页范围及实际工具版本区分派生视图；Docling 文档 schema 版本不冒充解析器版本。
3. 基础渲染使用随包 PDF.js、Canvas、CMAP 与标准字体。复杂结构使用可选 Docling 及其自带 OCR 流程；独立文字 OCR 使用可选 Tesseract，不覆盖 Docling 的结构正文。`harness.documentReading` 只接受用户级设置，工作区不能替换 Host 上的执行命令。
4. 可选程序以命令和参数数组交给现有 Rust 进程 authority；共享相容工作，逐等待者取消，退出未经确认时保留临时目录。结构解析按连续页段批量执行，避免每页重载解析模型。
5. 结构正文沿 Docling 的实际阅读顺序与位置；表格保留单元格跨度、表头与区域，OCR 文字保留自身坐标。解析失败、未安装和取消如实返回，已有原件仍可读。
6. UI 与 Agent 共用同一读取通路和 `varin-material://` 位置引用；区域提问把真实 PNG 与短引用加入当前会话草稿，由用户发送。运行环境/会话/材料切换后不接纳旧异步结果。
7. 对话 PDF 附件沿既有 WorkspaceAPI 保存到会话 cwd 的 `.varin/attachments`，向草稿加入真实文件路径；保留图片附件原流程。文件是持久工作区材料，取消草稿不删除文件；虚拟 WorkingState 暂不提供磁盘上传，避免写入后对当前运行不可见。

验证边界：已使用真实论文检查 PDF.js 原页和 Docling 正文/表格映射，实际运行 Rust 受管解析与取消，并在 Windows x64 打包产物中渲染 PDF 页面。上述证据不能推导普遍解析准确率。可选组件安装及首次模型准备有独立成本；跨平台完整产品交互与多语种扫描件质量没有据此获得保证。

### D-324 · 2026-09-24 · L3-P1/P2 结构候选、OCR 与视觉交接

类型：实现收口（D-322 P1/P2 基础纵切）

决定：在同一 PDF 快照内保存页面尺寸、文本行/段坐标和明显双栏顺序；程序只把重复列位置形成的表格、数学符号形成的公式、
PDF image operator 对应的图像页标为候选，并携带原页行号/坐标与 `candidate` 置信度。`element=formula` 与既有 table/figure 位置
共用快照读取，不将启发式候选改写成论文事实。`webfetch ocr=true` 只对无文本层页面调用可替换 Tesseract adapter；OCR 结果写回该页
再计算全文页范围，adapter 缺失/失败保留原件、状态和页面视觉入口。

视觉交接沿同一 `webfetch`：`page-image` 可以带 prompt，把真实 PNG 同时交给配置的 reader model；结果正文和图片仍分开记录。新增
`/api/harness/sessions/:sessionId/materials/:snapshotId/page` 受认证页面路由，来源卡可打开固定快照页图，路由再次经过当前 session 的
材料 authority 和域策略。

验证：PDF/material/web-fetch 聚焦套件 34 项、Pi webfetch 11 项、PDF 页面路由 2 项、protocol/application-host/pi-host/ui 类型检查通过；
真实 Tesseract、复杂论文解析准确率、跨平台 Poppler 与完整桌面阅读器交互未实测，不作质量收益结论。

状态：已实施；未推送（待主代理验收）。

### D-323 · 2026-09-23 · L3-P0 原件保存与页面视觉读取

类型：实现收口（D-322 P0）

决定：沿现有 `web.snapshot` authority 保存 PDF 原始字节与抽取文本。`WebSnapshotRef.document` 固定页数、解析器身份和
source content hash；重新解析或刷新产生新的快照身份，旧快照位置不变。`webfetch` 增加 `view=page-image`、一基页码和
可选渲染像素区域，Host 经 Poppler adapter 生成 PNG，Pi 工具把真实图片作为 image content 返回给模型。没有 renderer、原件、
页码或区域不合法时返回明确的 `page-image-unavailable`，不伪造图片；Poppler 通过 `VARIN_PDFTOPPM_PATH` 或 Host PATH 提供，
文本读取不依赖它。

验证：PDF.js 4.10.38 实际读取生成的两页 PDF；Poppler 实际渲染整页与裁剪页；web material / web fetch 聚焦套件 33 项通过，
Pi `webfetch` 工具验证 image content；application-host 与 pi-host 类型检查通过。复杂多栏/OCR/表格/公式/图表解析和阅读器 UI
仍未交付，不据此宣称完整结构阅读。

状态：已实施；未推送（待主代理验收）。

### D-318 · 2026-09-23 · L4 跨线程材料授权

背景：snapshotId 与 foreign receiptId 都不能是 bearer token；跨线程材料复用需要显式授权记录，同时不能把判断/摘要随材料自动继承。

决定：

1. retrieval preset 允许表补入 `send`/`read_thread`/`wait`/`follow_up`，通信继续走 `thread.send`/`thread.read` 的同根关系校验与冻结工具权限，不另建协作 runtime。
2. 新增 `material.grant` 内核记录：`materials.collections` 的 `share` 动作由发送方线程向同根关系内目标线程授权（父子/兄弟，同 thread.send 可达性），覆盖 collectionId 或 snapshotId 集合。
3. 发送方必须自身可读所授权材料；接收方经 `web-materials.read` 的 grant 回退以自身 session/thread scope 回读并另铸 receipt，不继承发送方权威。
4. share 幂等——相同发送方/目标/内容集合的活 grant 复用；grant 随发送方线程删除与工作区对账回收。
5. 持久化集合对工作区可读但写权限仍限属主；grant 只放开读，不放开写。

验证：material-collections 套件 9/9（含 grant 授权、跨根拒绝、不可读快照拒绝、幂等、grant 随线程释放、整集共享后可列可搜不可写）；application-host 与 pi-host typecheck、protocol build 通过。真实线程间端到端（实际 dispatch→send→read 链）以既有 thread-runtime 套件为准，未新增桌面 E2E。

状态：已实施，未推送（待主代理验收）。
[status.md](../status.md)。

### D-319 · 2026-09-23 · L5 Web/学术快速决策消费者

背景：`harness.fastDecision`（D-312）此前只有 `explore` 消费者。阶段 L 需要 Web/学术候选的批量判断，且不得另建模型配置体系、不得借用 `models.explore` 冒充网络研究判断。

决定：

1. `FAST_DECISION_PURPOSES` 新增 `web` 与 `scholarly` 两个用途槽，沿用默认绑定 → purpose 覆盖 → off 的解析顺序与 configurationId 冻结语义；调用开始即冻结绑定，迟到结果不覆盖已结束操作。
2. 新 Host 服务 `research.decide`（`read.web` 能力）+ Pi 工具 `research_decide`（retrieval preset 允许表已补）。候选必须是调用方已取得的材料：websearch URL、webfetch 快照、research_search 论文身份、快照内 section、或新查询文本。
3. snapshot/section 候选在调用者权限下先回读真实正文片段（每候选 ≤2000 字符预算）再送模型；不可读快照、畸形 url/paper/query 候选列入 `rejected`，不送模型也不解释为低价值。
4. `relevance`/`reading-value`/`complementary`/`duplicate`/`continuation` 映射为逐候选 score 问题；`next` 映射为允许显式无合适项的 choose。missing 单列、永不计零；无阈值即完成、无固定轮次/候选数。
5. purpose 未配置/关闭/不可用/失败/取消时返回对应状态 + `fallback:"order"`，`ranked` 保持调用方顺序——直接搜索、来源排序与 Agent 判断继续工作，不借另一模型填空。
6. 结果保留 providerId/modelId/servedModelId/configurationId/usage；settings catalog 说明更新到三用途。

验证：research-decide 套件 7/7（排序、choose 选择、unconfigured/disabled/unavailable 回退、不可读快照拒绝、purpose 推断与覆盖、取消与失败不伪造成绩、畸形输入拒绝）；material-collections 与 explore-fast-decision 回归全绿；protocol build、application-host/pi-host typecheck、改动文件 lint 通过。真实 fastDecision provider 未实测，候选排序质量无数据不宣称收益。

状态：已实施，未推送（待主代理验收）。
[status.md](../status.md)。

### D-320 · 2026-09-23 · L6 设置与工作台收口

背景：阶段 L 的能力需要如实进入设置目录、设置 UI、工具开关与来源展示，不新增强制研究模式，不要求用户手改 JSON 才能使用新用途。

决定：

1. Fast Decision 设置区块按 `explore`/`web`/`scholarly` 三用途逐行暴露 default/off/自定义绑定覆盖；选项写入 `harness.fastDecision.purposes.<purpose>`，与 `resolveFastDecisionPurpose` 的解析顺序一致。
2. 工具设置页新增 `websearch`/`webfetch`/`research_search`/`materials`/`research_decide` 开关，直接写 `harness.tools.<name>`，与 `selectHarnessTools` 的装配条件一致——关掉即不注册，不伪装成 provider 失败。
3. 来源面板为 `materials`（archive-stack）与 `research_decide`（scales-3）分配独立图标；`research_decide` details 的候选 URL 进入既有来源投影并带 `decide:<score>` 标记。不新建研究模式或强制入口。
4. 10 个 locale 的 settings 文案全部补齐（fastDecision 三用途 + 五个工具开关），`explore.default/custom` 键更名为 `purpose.default/custom`；i18nParity 通过。
5. 质量边界不变：真实付费 provider、TypeSafe Jev 实机、完整桌面 E2E、跨平台抓取与排序质量均未实测，状态文档如实记录。

验证：ui 侧 i18nParity 4/4、harness 设置与来源投影测试全绿、ui/pi-host/application-host typecheck 通过、改动文件 lint 干净、test:docs 9/9。

状态：已实施，未推送（待主代理验收）。
[status.md](../status.md)。
