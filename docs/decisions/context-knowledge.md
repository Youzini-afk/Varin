# 决策分卷：上下文、知识与记忆

范围：2.x 知识库、Zone 2 组装、host 观察、memory keeper、压缩接管、建议/审阅、模型槽位与召回。

本卷是 [decisions/README.md](README.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-019 · 2026-09-03 · 2.1
类型：偏离
决定：TriviumDB TQL 查询语法在 v0.8.5 上不稳定（FIND 语法对字符串/数字字面量处理不一致，WHERE 子句报类型转换错误）。知识库 store.ts 改用 `allNodeIds()` + `getPayload()` 在 JS 层过滤，不使用 TQL。
原因：TQL 的 `FIND {type: "block", sessionId: "s1"} RETURN *` 报 "Failed to convert napi value String into rust type `f64`" 错误，说明 TQL 解析器对 payload 字段类型推断有 bug。JS 层过滤虽然在大数据集上较慢，但阶段 2 的数据规模（单会话数百 event）完全可接受。
考虑过的替代：(1) 修复 TriviumDB 的 TQL 解析器——是同一维护者的项目，但优先级低于推进阶段 2；(2) 用 `tql` 的 MATCH 语法——同样不稳定。
影响：`packages/web/application-host/lib/knowledge/store.ts`（scanNodes 辅助函数替代所有 TQL 查询）。索引（createIndex/createOrderedIndex）仍创建但不被 JS 层使用，保留供未来 TQL 修复后启用。
状态：已实施（模块已写，尚未接进会话生命周期——待阶段 2 接线）

### D-020 · 2026-09-03 · 2.1
类型：偏离
决定：占位向量模式下 `recall` 不使用 `searchHybrid`，改为 JS 层扫描 accepted knowledge 节点 + 简单词项匹配评分。`searchHybrid` 的全零向量在 v0.8.5 上返回空结果（余弦相似度为 0/NaN）。
原因：计划要求"实施前先在 TriviumDB 上验证全零向量的 search 不报错"——验证发现不报错但返回空结果，无法用于召回。JS 层词项匹配虽然粗糙，但满足阶段 2 的基本需求（按 trigger/content 匹配）。
考虑过的替代：(1) 用单位向量占位——会引入虚假相似度；(2) 只走 TQL 文本查询——TQL 不稳定（见 D-019）。
影响：`packages/web/application-host/lib/knowledge/store.ts`（recall 方法在 `!embedding` 分支改为 JS 扫描）。embedding 模式仍使用 `searchHybrid`。
状态：已实施（模块已写，尚未接进会话生命周期——待阶段 2 接线）

### D-022 · 2026-09-03 · 2.6
类型：实验结果
决定：Pi 0.84.3 按预期消费 `session_before_compact` 钩子返回的 `{ compaction: CompactionResult }`。当扩展返回此字段时，Pi 跳过自身的 LLM 摘要生成，直接使用扩展提供的 `summary` / `firstKeptEntryId` / `tokensBefore`。`session_compact` 事件随后触发，`fromExtension` 标记为 `true`。
原因：plan 2.6 要求"实施前先验证"。通过 `pi-hooks-contract.test.ts` 新增 e2e 测试验证：(1) 扩展注册 `session_before_compact` 处理器并返回 `{ compaction: { summary: "piarium-custom-compaction-summary-marker", firstKeptEntryId, tokensBefore } }`；(2) 4 轮 agent 对话构建足够上下文（每轮 ~7500 tokens，总计 >20000 tokens 超过 `keepRecentTokens`）；(3) 调用 `host.session.compact()` 触发手动压缩；(4) 断言自定义摘要文本出现在会话消息中；(5) 断言 faux provider 调用次数仍为 4（压缩未触发额外 LLM 调用）。源码核实：`agent-session.js` 第 1435-1451 行（手动压缩路径）和第 1709-1725 行（自动压缩路径）均检查 `extensionResult?.compaction` 并跳过 `_runDefaultCompaction`。
考虑过的替代：如果 Pi 不消费此返回值，plan 2.6 的替代路径是在 `session_compact` 事件后追加自定义摘要消息（非接管压缩，而是追加）。实验证明主路径可行，无需走替代路径。
影响：`packages/pi-host/test/pi-hooks-contract.test.ts`（新增 e2e 测试，2/2 pass）。阶段 2 接线可安全使用 `session_before_compact` 返回 `{ compaction }` 实现接管压缩。
状态：已验收

### D-023 · 2026-09-03 · 2.1–2.10
类型：偏离
决定：Phase 2 模块接线采用"provider 注入"模式而非硬编码。`HarnessServiceHost` 新增 `zone2Provider` / `compactionDepsProvider` / `todoDepsProvider` / `recallDepsProvider` 四个可选 provider 函数，由 `index.ts` 在创建 service host 时注入。当 provider 不存在时，对应的 harness service 不注册（router 无 handler → bridge.request 报错 → pi-host extension catch 后返回 undefined → Pi 回退到默认行为）。
原因：(1) 知识库是 per-workspace 的，需要在运行时根据 sessionId 解析 workspaceId 再打开/复用 store，不能在 service host 构造时确定。(2) memory agent 需要 model 访问权限，当前阶段尚未配置，设为 null 不阻塞其他服务。(3) compaction/todo/recall 的 deps 都需要 knowledgeStore + sessionId，通过 provider 函数延迟绑定。(4) zone2 的 material 收集逻辑（events/git/diagnostics/blocks）需要从多个 host 子系统聚合，当前返回空 material（assembler 返回 null → 不发消息），后续逐步填充。
考虑过的替代：(1) 在 service host 构造时打开所有 workspace 的 store——无法知道有哪些 workspace，且浪费资源。(2) 让 pi-host extension 直接访问 knowledge store——破坏了 worker/host 边界（worker 不持有 store 引用）。(3) 不用 provider，直接在 harness-services.ts 里 import knowledge store——循环依赖且无法测试。
影响：`packages/protocol/src/harness.ts`（5 新 HarnessServiceMap 方法）；`packages/web/application-host/lib/harness/service-host.ts`（8 新字段 + 8 新 options）；`packages/web/application-host/lib/harness/harness-services.ts`（5 新 service factory + 注册）；`packages/web/application-host/index.ts`（knowledge store 懒加载 + 4 provider 函数）；`packages/pi-host/src/harness/zone2-extension.ts`（新文件）；`packages/pi-host/src/harness/compaction-extension.ts`（新文件）；`packages/pi-host/src/harness/todo-tool.ts`（新文件）；`packages/pi-host/src/harness/recall-tool.ts`（新文件）；`packages/pi-host/src/harness/select-tools.ts`（注册 todo/recall）；`packages/pi-host/src/session-host.ts`（注册 zone2/compaction extension）；`packages/pi-host/test/harness/phase2-e2e.test.ts`（5 e2e 测试，5/5 pass）。
状态：已实施（zone2 material 和 compaction facts 收集逻辑为 TODO，当前返回空值；memory agent 未接线 model 访问；user knowledge store 未打开。这些在后续阶段逐步填充。）

### D-037 · 2026-09-04 · 2.4 / 2.6 / 8.6（记忆 agent shadow mode 与回放门禁）
类型：偏离
决定：(1) 记忆 agent 以 **shadow mode** 接入：维护块、进 Zone 2、进 UI 面板，但**不接管压缩**；Pi 默认摘要保留。(2) 压缩接管、`explore` 默认开启、TTL 唤醒等**影响模型行为**的能力，`default-on` 的前提是通过**回放集**对比；基础设施类能力（bash / grep 覆盖、截断、权限门）`proven` 即可默认开启。(3) 回放集第一版：5–8 个来自 Piarium 自身历史的真实任务（跨多文件修改、测试失败到修复、长上下文后回忆早前决定、编辑器有未保存改动时的恢复），固定起点（commit + 工作区状态）与判定标准；三个指标：任务是否成功、总 token、人工介入次数；每次失败附一个类别（`retrieval miss` / `lost context` / `wrong edit` / `permission interruption` / `tool-runtime failure` / `coordination failure`）。对比必须同模型、同 provider、同起点。Recovery、安全、崩溃等确定性行为由 E2E 与故障注入验证，不进回放集。(4) 设计 8.6 "不建立独立评测集"改为上述最小回放集。(5) 设计 8.4.1 关于记忆 agent "前缀逐字节相同、整段缓存命中"的论证标为**未验证假设**：记忆 agent 必须带 `memory_edit` 工具才能 `tool_choice`，而不变量 8 禁止主 agent 有此工具，两者的 tools 块必然不同；Anthropic 的缓存层级为 tools → system → messages，tools 变则整段前缀失效。按 provider 实测分段命中后再定记忆 agent 的模型与成本模型。
原因：四个计数器只能回答"贵不贵、吵不吵"，回答不了"任务做对没有"；没有 baseline 就无法判断 explore 是否优于 grep、压缩接管是否丢关键事实、多线程是提速还是制造合并工作。记忆 agent 的成本论证有一个设计层面的洞（tools 不同），在它成立之前不能让压缩正确性依赖它。当前代码的接管条件（D-028 (5)：需存在 keeper 块）在记忆 agent 未接线时等价于 shadow mode，与本条一致。
考虑过的替代：(a) 大 benchmark——超出需要，且会腐烂。(b) 只看计数器——见上。
影响：设计 8.4.1、8.4.2、8.6 回写；`status.md` 的 `Default-on` 列以回放证据为门禁；回放集放 `packages/pi-host/test/replay/`（或独立脚本），与单测分开。
状态：待实施（P0 之后、线程纵切之前建立第一版回放集）

### D-045 · 2026-09-04 · T3（上下文观察与 memory shadow 的生产形状）

类型：实现澄清

决定：(1) Documents authority 在 `write/move/delete` 成功提交后发布结构化 mutation observation，携带规范 workspace/resource、
created/modified/deleted 与已校验 writer owner；观察回调失败只记 Host 错误，不能反噬已经成功的文件提交。同 workspace 的每个活跃
session 各写一条 event，保持 session 删除级联与各自增量游标语义。(2) Zone 2 请求增加 `afterEventId`、query、context usage；返回
`eventCursor`，并把 cursor 写入隐藏的 `piarium-context` custom message。worker 重载从会话历史恢复 cursor，普通重试不重复追加。
相关 accepted knowledge 按当前 prompt 召回；用户修改后的 LSP error/warning 才作为新诊断进入，agent 自己触发的诊断不复述。
(3) memory keeper 的模型调度在 pi-host（它握有真实 system/messages/model），块校验与写入在 Host（它拥有知识库）。两者通过
`memory.blocks.get/apply` 连接。旧 Host runner 的空 sessionId 与陈旧块快照实现删除。(4) `harness.memory.shadowMode` 是 user-only、
默认 false；开启后使用活动会话模型，UI 明示 tools 前缀不同可能产生全价请求。pi-ai 通用 API 只支持 `toolChoice: auto/none`，
所以无 `memory_edit` tool call 就视为未更新，不解释自由文本。(5) `compaction.takeoverEnabled` 默认 false；即使已有 memory-agent
块，shadow 也必须交还 Pi compaction。低置信度 todo 的确认移到 pi-host UI，Host 只接受显式 confirmed 标志并不再用恒真桩。

原因：观察与记忆必须成为真实会话纵切，但在缓存与质量回放之前不能让后台调用静默产生费用或让实验块成为压缩正确性的依赖。
event cursor 放在耐久会话消息里，比 Host 内存游标能承受 worker 重载；写后 observer 则比 watcher 时序推断 writer 来源准确。

考虑过的替代：(a) Host 自己调用模型——拿不到真实 session context/provider runtime；旧 runner 也已证明 session identity 为空。
(b) 默认开启并固定主模型——缓存命中尚无证据。(c) keeper block 一出现就接管压缩——把实验输出变成数据正确性依赖。
(d) 所有 LSP 诊断都进 Zone 2——会重复 agent 刚在工具结果里看到的错误。

影响：protocol memory/Zone 2 方法；Documents observation；knowledge context runtime；pi-host memory/Zone 2/todo 扩展；Harness Settings；
设计 7.3、8.4，plan T3，状态矩阵。

状态：已实施（核心 shadow 纵切；terminal/Git/面板/事件加速仍在状态矩阵）

### D-046 · 2026-09-04 · T3（session blocks 的用户投影与鉴权）

类型：实现澄清

决定：session blocks 与 delegated threads 共用父会话右侧的 session state 侧栏。blocks 的 GET/PUT 与 threads GET 都经过
现有 UI authentication middleware；用户保存写 `updatedBy: user`，并携带打开时的 `updatedAt` 做同一写队列内的乐观并发检查，
后台已更新则返回 409、重取而不覆盖。KnowledgeStore 提交 block 后广播的 SSE 只含
`{workspaceId, sessionId}` 失效通知，正文由 UI 重新走鉴权 GET 获取，避免把记忆/计划内容放进广播载荷。观察/UI 回调失败不能
把已提交的 block 写伪装成失败。

原因：shadow memory 若不可见、不可编辑，就没有用户审计出口；但 blocks 含任务状态和可能的敏感上下文，不能直接塞进 SSE。
实现时同时发现 T1 的 `/api/harness/threads` 未显式挂 UI auth，会暴露任务说明、worktree 路径和报告元数据，必须同批封口。

影响：Host `context-routes.ts` / `thread-routes.ts`、KnowledgeStore block observation、全局 UI event、
`HarnessThreadsPanel` 与 block parser、设计 8.4.1、状态矩阵。

状态：已实施

### D-054 · 2026-09-04 · 2.3（Git 状态观察复用现有刷新边界）

类型：实现澄清

决定：(1) `/api/git/status` 与 `/api/workspace/git/status` 每次成功取得状态后，以 best-effort 回调交给 knowledge runtime；回调失败
不得改变已经成功的 HTTP 响应。(2) adapter 通过 Documents `resolveScopeId` 找包含该 repo/cwd 的已注册 workspace，再投影为
branch、changed file count，以及 ahead/behind/merge/rebase 摘要；不把文件名或 diff 正文复制进事件库。(3) 每个已绑定 session 对
相同摘要做指纹去重，状态真正变化后才写新 event；首次观察作为基线事实进入下一轮 Zone 2，压缩后只清该 session 的去重基线，
下一次现有刷新可重新交付当前事实。(4) 不新增 Git 轮询器或 watcher：复用
IDE/Workspace 已有状态刷新，外部 Git 变化会在下一次状态刷新时被观察；UI 未刷新期间不声称实时。(5) user terminal 暂不接：现有
terminal 是持久 PTY，process exit 只代表整个 shell 退出，不能冒充单条命令完成；命令与 exit code 要等 shell integration 协议。

原因：Git API 已经是当前两个工作台读取 SCM 真相的共同边界，挂一次轻量投影即可获得准确状态且没有额外扫描成本。直接监听文件
变化再运行 Git 会复制现有刷新机制；把终端键盘输入按换行猜成命令则无法处理多行、交互程序、shell quoting 和退出码，会制造假事实。

影响：Platform routes、Git/Workspace Git status routes、Documents workspace resolution、knowledge Git adapter/context runtime、Zone 2；
plan/status 2.3。

状态：已实施（Git）；user terminal 仍待 shell integration

### D-058 · 2026-09-04 · 2.7（用户标记 → 双作用域知识审阅纵切）

类型：实现澄清

决定：(1) 现有 session state 侧栏中的 block 提供“记到项目/记到用户”两个显式动作，只创建 `suggested` 条目；无 suggestions model
时 trigger 留空，由用户在审阅卡编辑。(2) 鉴权 Host routes 同屏读取 workspace store 与 `user.tdb`，每条 identity 是 `(scope,id)`；
每项操作先验证 URL 中的 session 能解析 workspace，再选择目标 store，不能给 user knowledge 伪造来源；user store 拒绝非 user scope
写入。单独保存与接受都携带草稿及打开时原值，写队列内不匹配返回 409；接受在同一个 store task 中完成编辑、状态与取代预检，
accepted/dismissed 条目不能再按 suggested 编辑。(3) 接受时 `supersedes` 必须是同 store、同 scope、当前有效的 accepted knowledge；全部预检后才使旧条目失效并建边，
不删除历史。候选只要 trigger 词有交集就按重合度排序展示，不用无数据依据的 0.5 阈值隐藏；是否取代必须由用户勾选。(4) mutation
SSE 只广播 `{sessionId,scope}` 失效通知，正文重新走鉴权 GET。(5) 删除未接 UI 且“先 dismiss、后模型 create”会在后半失败时吞掉建议
的 regenerate 原型；模型草拟、用户消息识别和 memory decisions 自动提议继续保持未接，不产生静默费用。

原因：此前 suggestion/store helper 虽有单测，但没有路由或组件引用，且 create 固定写 workspace、auto-accept 也固定读 workspace 设置；
它不是可用能力。先交付用户明确标记的无模型纵切，能验证治理、双时态与作用域，而不需要提前决定自动抽取质量。

影响：KnowledgeStore mutation contract、`knowledge-suggestions.ts`、authenticated context routes、global SSE、session state sidebar 与 10 locale；
设计 7.2.2，plan/status 2.7。

状态：已实施并 proven（block user-mark）；其他两类触发与完整 Settings 知识管理仍待实现

### D-060 · 2026-09-04 · 2.7（持久消息与工具结果的显式知识标记）

类型：实现澄清

决定：时间线现有 hover action 区新增一个 knowledge 图标菜单，用户明确选择“记到项目”或“记到用户”；覆盖持久 user message、
assistant answer、配对/独立 tool result、extension-rendered tool result 与 legacy bash output。live 尚未落盘的消息不显示，空文本不显示。
动作只 POST 原文、空 recall trigger 和来源 kind 到 D-058 的 suggested API，不直接接受、不调模型；成功后沿同一 SSE 让审阅侧栏刷新。
scope 在菜单中显式选择，不以当前页面或模型猜测。工具卡的动作放在展开结果尾部，消息动作与复制/分叉同层，不占正文空间。

原因：D-058 只接了 block，设计列出的三个人工来源尚不完整；另建浮层会复制现有消息操作与 scope 选择。只允许持久项避免用户把
尚可能重试/变化的 streaming 文本写成长期建议。

影响：UI `RememberKnowledgeButton` / request projection、`PiTimelineEntries`、10 locale 与 SSR；status/plan 2.7。

状态：已实施并 proven（全部人工 user-mark 来源）

### D-061 · 2026-09-04 · 2.7（memory decisions 的机械建议触发）

类型：实现澄清

决定：(1) KnowledgeStore 在 block 写入成功后向观察者提供 `{previous,current}`，保留原 session invalidation 通知；失败写不发布。
(2) 只处理 `updatedBy: memory-agent` 且 label=`decisions` 的块，只把 Markdown bullet、numbered item 或显式 `Decision:` 行当作 entry；
普通散文、progress、用户编辑块不猜。(3) previous/current 先做新增差分，再与该 session 来源为 `memory-decision` 的全部历史 knowledge
比对；suggested/accepted/dismissed 任一状态已出现都不重提，避免用户驳回后下一次 keeper 重写又出现。(4) 新项固定写 workspace
`suggested`、空 trigger，整批完成后只发一次 scope identity SSE；不调 suggestions model，不读取 auto-accept。per-session 写入串行，错误只报
Host diagnostics，不阻断 memory block 已完成的提交。(5) memory shadow 默认关闭，因此默认不会产生后台 keeper 或建议写入。

原因：这是设计列出的第二个触发，输入已经是 memory keeper 明确维护的结构化 decisions，不需要再让一个模型判断。若从任意新增文本
猜“知识”，会把 progress 和叙述噪音灌进托盘；若不查 dismissed 历史，会违背用户驳回。

影响：KnowledgeStore block observation、`decision-suggestions.ts`、Application Host wiring/global SSE、plan/status 2.7。

状态：已实施并 proven；配置 suggestions model 后的用户消息判断仍未实施

### D-068 · 2026-09-05 · 2.9（模型槽位单一解析与真实用量归因）

类型：实现澄清

决定：(1) 槽位目录、仅 hardImplement/review 回退主模型的解析规则、Anthropic/OpenAI/Gemini 轻量预设归
`@piarium/protocol`，角色解析复用同一函数，不在 Host 复制第二套默认规则。(2) 预设按已连接 provider 的实际 model id 匹配，
不依赖 provider id 必须叫 openai/anthropic/google；只填尚未配置的辅助槽位，不覆盖用户逐槽选择。(3) reader 与
permissionJudge 的每次真实 `completeSimple` 响应按槽位累计 calls、完整 token 分类与 cost，随 `SessionStats` 进入 Context
sidebar；无调用的槽位不造零值。(4) 子线程已由 `ThreadRun` 持久化 role/model/tokens，不再向父会话重复记账；memory shadow
继续按设计使用活动会话模型，不冒充某个槽位。

原因：槽位规则同时被 pi-host、Host 与 Settings 消费，复制默认逻辑会漂移；自定义 API provider 常用用户自己的 id，按 provider
名称猜系列会让有效模型无法使用；用量只有绑定到真实模型响应才可信，配置本身不能算调用；父会话重复累计 child token 会让总成本
失真。

影响：protocol `harness-model-slots.ts` / `harness-roles.ts` / `SessionStats`；pi-host counter 与 reader/Smart judge；Harness
Settings、Context sidebar、10 locale；设计 8.5/8.6、plan/status 2.9。

状态：已实施并 proven（protocol 单测、真实 Pi reader/Smart judge E2E、UI projection）

### D-073 · 2026-09-05 · TriviumDB 问题按数据库职责报告

类型：设计修正（用户补充）

决定：TriviumDB 的问题直接在回复中提供，不另建 Piarium 适配需求文档。区分数据库缺陷、待确认语义和可选通用能力，报告版本与证据范围。
TQL 的字符串类型转换错误应从查询语言/绑定/执行链调查；零向量 hybrid 返回空需先确认参数与算法契约，不先判为缺陷；分词扩展若讨论，
应是数据库通用的 Unicode/可配置分词或预分词能力，而不是要求内置 Piarium 的代码分析器。分支、memory checkpoint、槽位、编辑器等
领域职责留在 Piarium，不能以“保留数据库”为由转嫁给作者。

原因：用户明确该项目首先是数据库；作者协作不等于接受 Piarium 专用需求。D-019/D-020 是 0.8.5 的既有实验记录，本轮不运行新实验，
也不能推断当前上游版本仍有同样问题。

影响：设计 7.5 与 plan 2.1 的问题表述；不改依赖、不迁移存储、不向作者发送消息。

状态：已回写文档；数据库问题在本轮回复说明。

### D-074 · 2026-09-05 · 记忆版本/分支、压缩覆盖、证据标记、观察游标延迟推进

类型：实现决策（纵切 1）

决定：按 plan 0.7 步骤 1 的顺序，完成四项本地可实现的一致性修复，每项包含协议、生产接线、测试和文档同步。

1. **记忆版本与分支归属**。`MemoryBlockSnapshot` 新增 `revision`（store `updatedAt`）；`MemoryEditOp` 新增可选 `expectedRevision`；`memory.blocks.get/apply` params 新增可选 `branchLeafId`；`MemoryApplyResult` 新增可选 `conflicts`。`KnowledgeStore.Block` 和 `BlockInput` 新增 `branchLeafId`，`getBlocks`/`upsertBlock`/`deleteBlock` 按 `(sessionId, branchLeafId, label)` 过滤。旧块（`branchLeafId` undefined）归默认分支（null），保持向后兼容。`applyOps` 检查 `expectedRevision`，不匹配时拒绝并记录 conflict，不静默覆盖。pi-host `memory-agent-extension` 从 `sessionManager.getLeafId()` 获取 branchLeafId，从 get 结果的 revision 附加到 ops 的 expectedRevision。

2. **Keeper plan 变更限制**。`applyOps` 拒绝 keeper 对 `plan` 的 `replace`/`patch`/`create`/`delete`，仅允许 `mark_plan`。原代码允许 `replace`，违反 main agent 对 plan 结构的所有权。

3. **压缩接管覆盖检查**。新增 `KeeperCoverageStore` 跟踪 keeper 连续处理区间。`memory.blocks.apply` 成功后扩展覆盖；`handleBeforeCompact` 在 `firstRemovedTurn`/`lastRemovedTurn` 提供时检查覆盖是否跨越整个移除区间；不满足时返回 `unavailable`，Pi 执行压缩。`compaction.after` 和 `dropSession` 清除覆盖。仅 keeper 块存在不再足够。

4. **证据标记与观察游标延迟推进**。截断标记包含 `ephemeral, generation <gen>` 明确标记 OutputRef 的生命周期。`OutputStore` 全文通过 `output.read` 分页可恢复；Host 重启后 handle 过期返回 `expired`。`ObservationCursorStore` 新增 `prepare`/`commit` 方法：`prepare` 运行任务但不推进游标，`commit` 在响应成功交付后推进，`abort` 不推进使下次观察包含未交付变更。现有 `observe` 保持立即推进语义，消费者按需切换。

原因：D-072 列出的缺口（2.4/2.6/3.9）在当前实现中会导致静默覆盖用户编辑、跨分支污染、keeper 未观察的历史被压缩后丢失、截断输出在 Host 重启后不可恢复、以及观察游标在响应未交付时已推进。这些是协议级完整性问题，不是可选增强。

影响：protocol `memory-agent.ts`/`harness.ts`；application-host `store.ts`/`memory-agent.ts`/`harness-services.ts`/`compaction.ts`/`observation-cursors.ts`/`service-host.ts`/`index.ts`；pi-host `memory-agent-extension.ts`/`session-host.ts`/`tool-result-truncation.ts`。测试：`memory-agent.test.ts`、`compaction.test.ts`、`output-store.test.ts`、`observation-cursors.test.ts`、protocol `memory-agent.test.ts`、`tool-result-truncation.test.ts`、`memory-agent-extension.test.ts`。

未完成：`observe` 调用点未改为 `prepare`/`commit`；后台调用用量归因仍待补；TranscriptRef 恢复仍限于 Pi transcript 持久 entry；真实 Pi session E2E、外部测试者、macOS/Linux smoke、Electron 打包证据未获取。

状态：首个实现候选；后由 D-075/D-076 修正。

### D-075 · 2026-09-05 · D-074 第一轮验收返工

类型：问题与解法（后由 D-076 完成）

决定：第一轮返工把 `branchLeafId` 改为 `sourceLeafId + branchEntryIds`，把已有记录的 revision 检查移入 Store CAS，把覆盖改成 entry ID set，并以 `observedAt` 做 observation CAS。该候选没有通过第二轮验收：写入仍按 source leaf 精确等值，后代无法更新祖先；读取未按每个 label 选择最近祖先，分支删除会物理删除兄弟仍需的祖先；UI、todo、thread snapshot、compaction 未全部使用活动分支。create 未以 `expectedUpdatedAt:null` 断言仍不存在。coverage 把完整 `getBranch()` 冒充 keeper 实际 context，且部分 op 成功即可推进。毫秒时间戳 CAS 会碰撞，clear 后 pending commit 还能复活游标；生产观察调用仍提前推进。

原因：这些问题均由真实最小复现确认，不能靠增加已有 happy-path 测试或修改状态文字解决。本条恢复 D-074 原始记录，纠正此前在未提交工作区直接改写 D-074 的 append-only 违规。

影响：D-076 接管最终实现；D-074/D-075 在索引标为被修正，保留失败形状供后续回归。

状态：superseded by D-076。

### D-076 · 2026-09-05 · 分支块、覆盖水位与送达游标的最终修正

类型：实现修正

决定：

1. block 采用分支 copy-on-write：读取按 `branchEntryIds` 为每个 label 只选最近祖先；后代更新在当前 leaf 写新修订，祖先保留；删除在当前 leaf 写 tombstone，兄弟分支仍继承祖先。create 用 `expectedUpdatedAt:null` 原子断言缺席，update/delete 在 Store 写队列内 CAS，同一 apply 内修订顺序前传。UI route 从 broker 活动分支自动解析，todo、Zone 2、memory、compaction 和 thread blocks snapshot 使用同一分支视图。
2. keeper 单独提交 `coveredEntryIds`，来源是 `SessionManager.buildContextEntries()` 中真实产生 context message 的 entry；Host 先验证其属于提交分支，只有全部 op 接受且确有 material block 更新才扩展水位。compaction 依照 Pi 上一次 compaction 的 boundaryStart 与本次 firstKeptEntryId 推导真正被摘要的 context entry，强制检查后才接管；当前仍 default-off。
3. observation cursor 新增 store-local 单调 revision，pending 在 commit/abort 前持续占有 namespace generation；同毫秒提交不会绕过 CAS，compaction/clear 会使旧 pending 失效。shell、diagnostics、Zone 2 threads 和 thread list/wait 均把游标推进延迟到 Router 成功把响应交给 pi-host；响应失败 abort，线程游标另按 eventSeq 防倒退。持久 tool-result entry acknowledgement 仍是更强的后续边界，不在本次冒充完成。
4. OutputRef 的 ephemeral generation 标记保留，它只说明生命周期，不声称 Host 重启后恢复全文。

原因：分支版本必须保留共同祖先而不是改写或删除它；coverage 必须描述 keeper 真正读到的输入而不是可枚举的整条 transcript；送达优化必须能承受并发、固定时钟和压缩清理。

影响：protocol memory/compaction/todo/Zone 2 参数；KnowledgeStore block revision/tombstone；Host routes/services/router/thread cursors；pi-host memory/compaction/todo；相关测试与 status 2.4/2.6/3.9。

状态：已实施；本地验证与仍缺外部证据见状态矩阵。

### D-080 · 2026-09-06 · 取消辅助模型分项统计，保留正常会话统计

类型：产品简化（用户明确决定）

决定：移除 Context 面板“智能体 Harness → 模型槽位用量”的调用次数、Token 和估算费用明细，并删除专为该区块提供的
modelSlotUsage 聚合与传输。后续记忆、explore、review 不再新增同类成本或辅助 Token 看板。保留右上角原有的普通会话费用、
输入/输出/缓存 Token、上下文容量，以及模型槽位的配置与功能；不修改 SDK 原始用量、单价配置或历史会话记录。

原因：用户认为额外分项统计占用视觉空间、实际意义不大，并明确澄清正常会话已有的费用和 Token 展示需要保留。

考虑过的替代：删除所有费用/Token 展示——超出用户范围，已撤回；把辅助金额换成 Token 看板——仍保留用户不需要的统计区块。

影响：ContextSidebarTab、harnessCounterPresentation、pi-host counter/session 装配、SessionStats、i18n；设计 8.4–8.6、
plan 0.7/2.4/2.9/3.2/3.7 和 status。D-068、D-078 中要求辅助模型分项用量/费用展示的部分由本决定取代，其余规则保留。

状态：已按本范围实施；验证记录见 status.md。

### D-081 · 2026-09-06 · 2.4 / 2.6（默认记忆与逐次压缩接管）

类型：默认值与运行契约落地（D-078）

决定：记忆设置收敛为 `off | assist | takeover` 三态，缺省为 `takeover`。`off` 停止 keeper、排除 Zone 2 中的 memory blocks
并始终交还 Pi 压缩；`assist` 维护和注入 blocks、由 Pi 压缩；`takeover` 在相同维护路径上逐次检查接管条件。旧
`shadowMode:false/true` 分别迁移为 `off/assist`，显式 `mode` 优先；错误类型和值拒绝读取或写入，不吞成默认。memory 是 user-only，
workspace 设置不能覆盖。全局值由活动 `SettingsManager` 实时读取；每个 Pi session 可持久设置覆盖或恢复继承，覆盖独立于分支上的
Goal/Assist 记录，不改全局文件。

接管要求同一次已接受且确有 material block 变化的 keeper 提交提供实际 context entry IDs、当时的完整活动分支祖先路径和可见 block
修订集合。压缩前重新解析 Pi 实际移除区间、当前分支与 block 修订；任何一项缺失、不连续、错分支或过期，都只让这次请求回到 Pi
自身摘要，不阻断会话。Host 重启后的内存 coverage 为空，不能冒充持久 checkpoint；下一次有效 keeper 更新可重新建立证据。
`compaction.after` 清旧 coverage，连续压缩各自重新证明。Host facts 当前只提供事件权威能可靠证明的 touched files；诊断事件缺少
resolution authority、恢复层缺少 session checkpoint 查询，因此暂不伪造“当前未解决诊断”或 checkpoint 正文。

运行失败投影到可选的 `SessionSnapshot.harness.memory`，区分 keeper/compaction，包含配置模式、有效模式、会话模式覆盖和最近失败；Context
可即时切换当前会话，Settings 修改继承中的活动会话。无效设置可在 UI 中修复。成功的同阶段运行或模式变更清除陈旧失败。主会话历史
不写 `memory_edit`，keeper 无文件/shell 工具；D-080 的普通会话费用/Token 展示保留，不恢复辅助分项看板。`record-only` 不加入本次
模式契约，也不作为默认交付前置。

原因：D-076 已提供 block 分支/CAS 与实际 entry 覆盖；此前剩余问题是这些证据未绑定完整分支和 block 修订、设置只在会话构造时读取、
默认仍停在 assist，以及失败对用户不可见。本次直接完成可用路径；局部证据不足时使用已经可靠的 Pi 摘要，比维持整个功能默认关闭更符合
D-078。`off` 若仍注入旧 blocks 也不是真正关闭，因此模式随 Zone 2 请求传递，只排除该来源而保留其他上下文。

考虑过的替代：继续 `shadowMode` 加独立 takeover 开关会保留两个冲突权威；持久化 coverage 会把 Host 进程内观察误写成 durable
checkpoint；无 keeper 证据时同步阻塞跑一次模型会增加压缩等待，当前直接交还 Pi；为当前诊断/checkpoint 造空值会把缺 authority
伪装成已采集事实。

影响：protocol harness settings、session feature/snapshot 与 Zone 2/compaction 请求；pi-host session 装配、memory/compaction/Zone 2
extensions；Application Host coverage、facts 与服务；Harness Settings、Context sidebar、i18n；设计 8.4、plan 0.7/2.4/2.6、status、
architecture 与两侧模块文档。

状态：已实施；本地验证与外部边界见 status.md。

### D-142 · 2026-09-07 · 观察回路：一个读不了的文件不许让整次检索归零

类型：问题与解法

背景：plan 0.7 说下一步「按观察到的『找不到入口』决定词法索引/桥接/embedding」，但产生这个观察的机制从来不存在——T4 回放被 D-078 降级后，
所有证据都是单测与对照数字，**没有一次拿真实问题打过真实仓库然后由人读结果**。而在 D-140 之前这个观察也做不了：枚举要 spawn 4363 个 git 进程、
建目录 18.4 分钟，图来源只会一直报 `empty`。D-140/D-141 之后（枚举 199 ms、建目录 4.8 分钟、`searchSymbols` 11.5 ms）第一次可行。

`packages/web/scripts/explore-observe.ts`（`bun run --cwd packages/web explore:observe`）对本仓库问 10 个真实问题，
走**真实的** `createHarnessServiceHost` / `createExploreSearchService` / rg / 结构来源 / 知识库，把可见正文与 `details` 原样打印。
按 D-140 的教训不做平行实现：三次量错都源于脚本量了产品不跑的形状。`--data-dir` 复用已建目录（一次约 5 分钟，之后每轮 30 秒），
`--only N` 单问，`--full` 打全文。没有编辑器所以没有脏缓冲，`agentInputDraftPaths` 返回空——这正是「无未保存内容」时的生产路径（D-082）。

**第一次运行，10 个问题里 9 个直接抛错**，不是没找到，是根本没返回。追下来是一条四层放大的缺陷链：

1. ripgrep 的约定是 `0` 有匹配、`1` 无匹配、**`2` 完成但过程中出错**（匹配依然有效）。真实工作区里 exit 2 是常态：一个正在被写、
   walk 途中被删、或被短暂锁住的文件就够了。实测拿到的诊断是 `code=2 hitCount=238`——**rg 已经交出 238 条有效命中**。
2. `content.ts` 把 exit 2 当彻底失败，把已解析的 238–432 条命中全部丢弃。
3. `search-service` 把 failure 转成 `unavailable`。
4. `explore-service` 里**任何一个词项模式 `unavailable` 就整次 `explore.search` 抛错**。

于是「某个无关文件恰好被占用」变成「explore 这一轮什么都不返回」。它只在高频查询上发作（词项多、并发 rg 多、撞上概率高），
而单测用小 fixture 永远走不到，这就是它一直没被发现的原因。

决定：exit 2 **且已有命中**时按部分覆盖处理——保留命中，`ready` 带 `incomplete: true`，`search-service` 把它并进 `partial`，
最终落到 explore 的 `searched.incomplete`。exit 2 **且零命中**仍然是 `failure`：此时「确实没匹配」与「根本没搜到」无法区分，按 A2/A6 fail-closed。
同时保留 rg stderr 的第一行（上限 200 字符）到 Host 控制台——原实现整个丢弃 stderr，导致这类问题在生产里无从诊断；正文仍不记录，只记路径与原因。

复验：改前 10 问 9 抛错；改后 **10 问全部返回、0 失败**。

**记两个我自己判断错的地方。** 一是先怀疑「达到上限主动 kill 后把自己杀掉的退出码当失败」——读代码发现 `finish(ready())` 在 `kill()` 之前，
那条路径本来就对，改动已撤。二是先怀疑「冷扫描后同进程搜索超时是堆压力」——实际也是这条 exit-2 路径，触发者是我把观察输出重定向进了仓库，
rg 走到正在被写的那个文件上。两次都是先给结论后验证，顺序错了。

不改：explore 单个模式失败仍会让整次调用抛错（根因修掉后 exit 2 不再产生 `unavailable`；这条降级属于行为变更，另议）；
D-103 第 1、3 项；候选池排序。

遗留（已观察到，未修）：候选池被 lockfile 与文档淹没。问「explore.search 在哪注册」，返回的片段里 `bun.lock` 占多数、其余是
`docs/architecture.md` 与 `docs/roadmap.md`，**源码一个没有**，正确答案 `harness-services.ts` 未出现；图这一路是活的
（`graph.status = ready`，54 个定义候选）但压不住泛词命中。这是观察要回答的下一个问题。

影响：`lib/search/content.ts`（结果类型加 `incomplete`、close 处理、stderr 首行）；`lib/harness/search-service.ts`（并进 `partial`）；
`lib/search/content.test.ts`（+2）；`packages/web/scripts/explore-observe.ts`（新）；`packages/web/package.json`；`.gitignore`。

状态：已实施。

### D-196 · 2026-09-10 · 知识库语义召回走派生代际库（2.8）

背景：权威 workspace/user `.tdb` 以 placeholder 维度打开，`putKnowledge` 与所谓 embedding 召回都写/查零向量。把 `embedding:null` 换成旧 `knowledge/embedding.ts` HTTP helper 不能完成生产接线，且会让 Host 持有密钥或在换维度时重开承载其他节点的权威库。

决定：

1. 知识正文、状态、来源和取代关系仍由现有 `.tdb` 拥有。向量是引用 knowledge id 与 `content+trigger` 修订的派生数据，存在独立代际目录，不因 embedding 维度变化重开或改写权威库。
2. 有效 `harness.embedding` 时，文档与查询都走与代码语义相同的 `harness.embed` / workspace binding / 用户凭据权威。Host 不接收密钥。未配置远程时知识召回保持文本，不使用本地 MiniLM，也不把 placeholder 向量标成 `via:vector`。
3. 默认只在已接受且仍有效的条目上召回。workspace 查询只取本工作区库的 workspace 范围；用户库只取 user 范围。允许集合在 Top-K 之前确定，不先全库再过滤。
4. 文本与向量名次用 RRF（k=60）合并，不把不可比的原始分数相加。命中返回前再核对权威状态与正文修订。写入先提交权威，索引后台建设；旧 token 不能覆盖新修订或复活失效条目。
5. 删除 `knowledge/embedding.ts` 的直接 HTTP adapter 与 meta 旁路，不保留第二套调用链。失败/未完成/无命中分列，不阻断文本或其他来源。

验证：派生库 scoped Top-K 与 `via:vector` 反例；错工作区/未接受/已取代不可见；迟到 embedding 不覆盖；换空间不混入；失败保留文本；Settings 快照 → `resolveInferenceBinding` → `createSemanticBackend` → 公开 `recall.search` / Zone 2。未观察真实外部 embedding 质量。

影响：`knowledge/store.ts`、`knowledge/vectors/`、`recall-tool.ts`、`context-runtime.ts`、Application Host 装配；设计 7.5/8.5；plan/status 2.8。

状态：已实施。

### D-198 · 2026-09-10 · 知识向量的建设生命周期与召回修订收口（2.8）

背景：验收 D-196 的实现发现，自动维度后端在建设入口直接返回，查询解析维度后也不启动建设；绑定解析异常会连文本召回一起抛错。自建的逐条 Trivium 写入器又复制了一套 checkpoint/发布逻辑，缺少配置变更重建、即时失效和关闭收尾。旧修订在向量 Top-K 后过滤，会挤掉有效命中。

决定：

1. 知识向量复用现有 `SemanticGenerationStore`、编码文本缓存、切分与调度机制，以独立知识 scope 存派生数据，权威 `.tdb` 不变。自动维度由真实正文或查询解析，不依赖代码仓库扫描，也不发送探测正文。
2. 打开与空间切换触发对账；普通知识变更合并受影响 id，立即使旧发布失效。建设发布及召回均核对权威状态和修订；有效条目、修订与范围先参与候选约束，再选知识条目 Top-K。长条目完整分块，同一条目的多个块不占多个名额。
3. 一次 workspace/user 召回固定一个远程绑定，在两种范围的有效候选上融合文本/向量名次，只给最终返回条目记召回。绑定异常保留文本并报告来源失败；取消停止本次等待，不误停其他调用共享的工作。
4. Host 使用 actor 的工作区权威身份；不以 `local` 或任取第一个工作区补齐身份。配置刷新通知知识建设；关闭时先取消并收尾派生建设，再关闭权威库。

验证依据：自动维度只发出 query、没有 document 的反例，以及绑定异常导致已有文本结果无法返回，均已在验收用例中复现。后续定向验证覆盖修订失效、配置切换、取消与关闭；真实外部 provider 质量仍不由 faux 测试证明。

影响：`knowledge/vectors/`、共享语义存储、Host recall/Zone 2 装配；设计 7.5；plan/status 2.8。取代 D-196 的独立知识向量写入器形状，保留其正文权威、远程配置和派生数据边界。

状态：待验收。

### D-208 · 2026-09-10 · 2.7 / 2.10（Settings 知识目录与用户消息建议）

背景：D-058/D-060/D-061 接了用户标记、审阅托盘和 keeper decisions，但 Settings 没有全量知识入口，配置 `models.suggestions` 后也不会从用户消息提议。status 仍把这两项写成未接。

决定：

1. 权威正文仍是现有 workspace/user `.tdb`。不迁库、不双写。Settings 与审阅托盘、公开 recall、Zone 2 读同一 store。向量仍是派生；编辑/停用/接受/取代走现有 `notifyKnowledge`。
2. Settings 经鉴权目录路由列表/查看/编辑/停用，并展示来源与 `supersedes` 链。workspace 操作先经 Documents `resolveWorkspace({ workspaceId })`，不给客户端自造 id 开库。user 目录用 `user.tdb`，并拒绝非 user scope 写入。
3. 删除是对该 id 写 `invalidAt`，不物理删节点，不级联其他 scope 或相邻历史。并发编辑继续用打开时的 content/trigger/status/invalidAt 做 409。
4. 已接受条目的 Settings 编辑是同 id 就地改正文（用户纠正这一条）。agent 提议更新仍走建议 + 接受时取代。suggested 编辑复用既有 `updateSuggestedKnowledge`。
5. `models.suggestions` 配置后，pi-host 在 `before_agent_start` 用该槽位 `completeSimple` 草拟；只有解析出的 JSON `{content,trigger}` 才调用 Host `knowledge.suggest`。未配置或模型返回 null 不落库，不借用主模型。失败只记 Host 诊断，不挡用户回合。
6. user-message 建议固定写 workspace，并按规范化正文对 suggested/accepted/dismissed/retired 去重。接受策略沿用现有 `createSuggestion` / auto-accept 设置（生产 HTTP 与 Host 服务当前都读默认关闭的 auto-accept，与既有审阅托盘一致）。

考虑过的替代：(1) 把知识目录塞进 Harness Settings 长页——列表/取代链不合适。(2) Settings 走 session 建议路由——Settings 没有会话。(3) 未配置时借用主模型——违背槽位契约。(4) 物理删除——丢掉取代链。

影响：KnowledgeStore mutation/chain、catalog routes、`knowledge.suggest`、pi-host suggestions extension、Settings `knowledge` 页与 i18n；设计 7.2.2；architecture 数据所有权；status 2.7 / 2.10。

状态：已实施；调用链与定向证据见 status 2.7 / 2.10。真实付费 suggestions 质量与完整浏览器点击链未测。

### D-211 · 2026-09-10 · 2.7 / 2.10（知识目录的完整 CAS、原子去重与 Host 固定提议身份）

类型：问题与解法（补正 D-208）

背景：D-208 初版的 Settings 写操作没有始终携带用户打开条目时的完整修订，接受可能吞掉并发编辑，已停用历史也可能被旧界面继续修改。作用域切换时迟到响应能覆盖新列表。`knowledge.suggest` 还接受 worker 自报 scope/kind，且“先查重、再插入”不在同一写队列临界区，并发提议会生成重复节点。

决定：

1. Settings 与会话审阅托盘的编辑、接受、驳回和停用都携带打开时的 `{content, trigger, status, invalidAt}`；KnowledgeStore 在同一单写队列内核对 scope、当前状态、停用状态和完整期望修订后再变更，不符合返回 conflict。作用域或 workspace 改变立即使旧选择失效；Settings 请求带本地代际与取消，迟到结果不能覆盖当前目录。
2. `knowledge.suggest` 的目标固定为已认证 actor 的 workspace store，来源固定为 `user-message`。worker 协议不再接受 scope 或 kind，无法借内部服务向 user store 或伪造来源写入。
3. 规范化正文的历史去重与插入在同一个 KnowledgeStore 写队列操作中完成，覆盖 suggested、accepted、dismissed 和 retired；并发相同提议只创建一个节点，也不会复活已驳回历史。
4. 用户标记、memory decision 和 suggestions 模型三条创建路径读取同一会话的有效 `knowledge.autoAcceptSuggestions`。trusted project 只能调整 workspace scope，不能打开 user scope；设置不可读时保持默认 suggested，不能静默自动接受。

影响：KnowledgeStore、catalog routes、`knowledge.suggest` protocol/Host/pi-host、Settings Knowledge 页与请求层、设计 7.2.2、architecture 数据所有权、status 2.7 / 2.10。

状态：已实施；CAS、并发去重、跨 scope 伪造与 UI 迟到响应有定向证据。真实 suggestions 模型质量与完整浏览器点击链仍未测。

### D-226 · 2026-09-11 · 2.2 / 2.3 / 2.4（用户终端事件与 memory 加速）

类型：问题与解法

背景：D-023 要求 Zone 2 呈现用户终端命令事实，并用有意义的材料事件加速 memory keeper。Harness bash 已与 terminal runtime 共用进程，但 runtime 没有 OSC 解析，`observeTerminalExit` 未接线，PTY 进程退出不能冒充单条命令完成。keeper 只在 `turn_end` 走 token/cooldown gate。

决定：

1. 只对 `owner: user` 且非显式 `spawn` 的会话注入 Piarium 自有 OSC 633 脚本（bash `--init-file`、PowerShell `-File`、zsh `ZDOTDIR`）。命令正文来自 `E`，退出码来自 `D`，cwd 来自 `P;Cwd=`。没有命令正文不 emit。不解析终端文本、不按提示符正则、不用 PTY exit 编造命令。Harness spawn 不注入、不解析；若程序自己打出 OSC，按 owner 也不会进入 `<user-terminal>`。
2. Runtime `subscribeCommands` 是 Host 观察入口。Documents `resolveScopeId(cwd)` 失败则跳过，不发明 workspace。`observeTerminalCommand` 按 `workspaceId:commandId` 去重后写入 knowledge event；Zone 2 只投影 `source !== agent` 且带 command+exitCode 的增量。送达后游标沿现有 hidden `piarium-context`。WS 重连不重解析 history（633/133 已从 `r` 剥离）。
3. 用户命令入库存后，Host `memory.nudge`（Host→worker，非公开 Runtime 方法）唤醒现有 keeper。off 为零调用；尚无回合为 `no-session-context`（事件仍进 Zone 2）；in-flight/cooldown 合并到一次后续工作。命令只进入 keeper instruction 的 `<material>`，不写入主对话。nudge/keeper 失败只记 Host 错误，不反噬终端或主回合。不新增轮询循环。

原因：用户屏幕上的终端命令是 Zone 2「agent 不在场时发生的事」；PTY 退出是会话生命周期，不是命令生命周期。keeper 已有 event gate，缺的是真实材料入口，不是第二套记忆循环。

考虑过的替代：(1) 用提示符正则从 PTY 文本猜命令——Windows/PowerShell/自定义 prompt 会误报，且违反「不能靠终端文本」。(2) 把 PTY exit 当命令完成——多命令会话会说谎。(3) 给 harness bash 也注入 integration——会破坏 ShellSupervisor 组帧，且 D-054 禁止重复进 Zone 2。

影响：terminal runtime/scripts/parser；knowledge observers/context-runtime/terminal-projection；protocol `memory.nudge`；pi-host memory extension + SessionHost + host-controller；`index.ts` 生产接线；设计 7.3、plan 2.2–2.4、status 2.2/2.3/2.4、architecture 4.4。

状态：已实施；验证见 status 2.2/2.3/2.4。zsh/macOS/Linux 用户终端与完整桌面 Host 重启仅协议接入或未测。

### D-229 · 2026-09-12 · 2.2 / 2.3 / 2.4（纠正 D-226 命令事实）

类型：问题与解法

背景：D-226 把用户终端命令接入 Zone 2 与 `memory.nudge`，但验收发现生产契约不成立：PowerShell 在 prompt 里先做别的工作再读 `$?`；`/restart` 不递增 integration generation、不 reset parser，新进程会结算旧 command/startedAt；`sh` 被当成支持 `--init-file` 的 Bash；默认注入覆盖用户 PROMPT_COMMAND 数组、DEBUG trap、zsh login/profile 与 PowerShell Enter handler；parser 接受任意 OSC 133/633；command/cwd 原文可关闭 Zone 2 标签；`commandId` 去重只在进程内 RAM，重复投递会二次入库并二次 nudge。文档还把 RAM 去重写成 Host 重启去重。

决定：

1. PowerShell `prompt` 在任何赋值、函数或管道之前保存 `$?` 与 `$LASTEXITCODE`。成功为 0；native 非零退出用该码；cmdlet 失败且没有非零 native 码则为 1。
2. `/restart` 与普通 start 共用 `spawnSessionProcess` 的 generation/reset：spawn 成功后才提交新 generation 并 `parser.reset`。新进程初始 D 不得结算旧命令；下一 commandId 属于新 generation。spawn 失败时旧 parser 保持可用。
3. 只有真实 `bash` 才注入 `--init-file`。`sh` / `dash` 等不注入。
4. 默认注入保留用户 shell：Bash 检测 `PROMPT_COMMAND` 数组并前置，且链式已有 DEBUG trap；zsh 物化 `.zshenv` / `.zprofile` / `.zshrc` / `.zlogin` 并在 sourcing 用户文件后恢复 Piarium `ZDOTDIR`；PowerShell 用 `AddToHistoryHandler` 链式已有 handler，不替换 Enter。
5. 脚本发出 `\033]633;pi;<PIARIUM_SHELL_INTEGRATION_ID>;<body>\007`。parser 只接受本 session `terminalId:generation` 的帧。这是来源绑定的 shell 观察，不是无法伪造的安全身份。
6. command/cwd 进入 Zone 2 与 keeper 前经 `encodeHarnessObservationText` 编码，使 `</user-terminal>` 与 C0 控制字符不能关闭标签或变成新指令块。原始文本仍可读。
7. `workspaceId + commandId` 幂等写入落在 knowledge `putEvent`（workspace store 内按 `data.commandId`）。重复事件不入库；projector 只在 `inserted` 时 nudge；keeper 也不重复入队同一 `commandId`。产品链没有 PTY 重播，文档不得声称 Host 重启去重。

原因：D-226 的产品方向成立，但退出码、代际、注入破坏、未绑定 OSC 和 RAM 去重会把别人的输出或旧进程状态写成这次命令事实，或在重复投递时污染 Zone 2 与 keeper。

考虑过的替代：(1) 继续把 `sh` 当 Bash——dash 没有 `--init-file`。(2) 用无法伪造的加密身份——超出 shell observation 范围。(3) 把 Host 重启去重写进文档——产品链不重播 PTY。

影响：Host terminal integration / runtime、knowledge `putEvent` / observers / context-runtime / terminal-projection、Zone 2、pi-host memory keeper、protocol `encodeHarnessObservationText`；设计 7.3、plan 2.2–2.4、status 2.2/2.3/2.4、architecture 4.4。D-226 相应部分在本条索引标 superseded in part。不改写 D-226 正文。

状态：已实施定向反例；zsh/macOS/Linux 真机用户终端与完整桌面 Host 重启仅未实测。验证见 status 2.2/2.3/2.4。

### D-233 · 2026-09-12 · 2.2 / 2.3 / 2.4（用户终端多会话投影与退出事实）

类型：问题与解法

背景：D-229 把终端命令事件按 workspace 写一次，再 fan-out 给多个 Pi 会话。第一个会话写入后会让其余会话被 `workspaceId + commandId` 去重，从而只有一个会话得到自己的 event/Zone 2；生产 adapter 还丢失了 projector 传入的目标 session。PowerShell 沿用旧 `$LASTEXITCODE` 时会把前一条 native 失败码误归给当前 cmdlet，zsh 注入也没有完整保留原 `ZDOTDIR` 是否存在的语义。

决定：

1. projector 固定本次 workspace 的唯一目标 Pi session 列表，对每个目标分别调用 `observeTerminalCommand(event, targetSessionId)`；Application Host adapter 必须原样传递目标身份。只有该目标成功插入时才向它发送一次 `memory.nudge`。
2. knowledge event 持久 `dedupeKey = terminal-command:[targetPiSessionId, commandId]` 并在单写队列内用持久属性索引查重；旧 terminal event 在打开 store 时按同一规则补 key。RAM seen 只能在持久写成功后前移。这个键防重复投递/重开 store，不表示 PTY 能在 Host 重启后重播命令。
3. PowerShell 在命令开始记录 `$LASTEXITCODE` 基线。命令结束时，成功为 0；发生变化的 native 非零码使用真实值；cmdlet 失败或无法证明本命令产生了 native 状态时为 1。PowerShell 没有 `$LASTEXITCODE` 代际计数器，所以连续两条产生完全相同非零码的 native 命令会保守记录 1，不能声称总能保留精确码。
4. zsh 记录用户启动前是否显式设置 `ZDOTDIR`，在 source 用户 `.zshenv/.zprofile/.zshrc/.zlogin` 时恢复其原语义，再切回 Piarium 的注入目录。Windows 本轮无 zsh，可执行脚本测试跳过时不得写成 live 通过。

原因：终端事实的接收者是具体 Pi 会话；workspace 只是知识存储范围，不能替代每个会话自己的事件游标和 keeper 输入。退出码只能报告 shell 能证明属于本命令的事实。

考虑过的替代：(1) workspace 只存一条并让多会话共享游标——现有 Zone 2/event 模型按会话送达，会丢接收者状态。(2) 只在内存 fan-out——store 重开会重复。(3) 无条件使用非零 `$LASTEXITCODE`——会把旧 native 状态归给 cmdlet。

影响：knowledge store/observers/context-runtime/terminal-projection；Application Host 装配；terminal shell scripts；设计 7.3、plan/status 2.2–2.4、architecture 4.4、Harness/terminal DOCUMENTATION。D-229 的幂等键与 PowerShell 结论由本条纠正。

状态：多会话、store 重开、PowerShell 本机与脚本反例已接；zsh/macOS/Linux 真机仍未实测，不声称 Host 重启重播。

### D-238 · 2026-09-12 · 2.4（steering、用户计划与子返回加速现有 keeper）

类型：问题与解法

背景：用户终端已有 `memory.nudge`，但用户改变任务方向、修改计划或子线程带回结果后，keeper 仍需等普通 token 门。
只增加触发名也不够：请求必须携带新材料，且不能把失败 Run 之前保留的旧报告或物化父的 execution 身份当成本次返回。

决定：

1. Pi 接受 steering 并提交输入上下文后投递该消息；用户计划编辑由鉴权 UI 路由在分支/修订校验与持久写入成功后通知。主 agent
   的 todo 和 keeper 自身写块不走这条观察，避免自触发。观察失败不改变已接受输入或已保存计划的结果。
2. Registry 新增提交后的 `onThreadReturned` 观察，携带本次 Run 与新报告。success/failure/cancelled 有本次报告才产生返回事实，
   lost 不冒充结算；同一 endRun 重放不重复发出。既有 success-only 的 `onThreadDone` 保持语义。
3. 根返回送仍注册的父 Pi session；嵌套返回按当前 Thread/Run/session binding 核对 owning 身份。关闭或过期的接收者不重开，
   物化执行目录不代替知识工作区。报告保留真实 outcome，材料身份绑定 workspace/thread/run，不以结论相同判成同一次执行。
4. 新材料使用已有 keeper 的活动模型和 memory_edit 通道；正文作为观察数据编码。外来事件去重与内部等待队列分开，冷却或在飞
   时不会因重新入队而丢正文，重复已接收事件也不触发空材料模型调用。off 不调用模型，没有新事件不启动循环。
5. 初次上下文建立前的新材料等下一次有效 turn。`session_tree` 明确切换分支时清空旧待处理材料并使在飞结果失效；切换后新到
   的事件等新上下文。正常沿同一分支新增 entry 不被当作切换。这是临时加速队列，不承诺跨导航或 Host 重启重播。

验证与边界：生产消费者、定向反例与 faux SessionHost 证据记在 status 2.4。没有新增记忆模型槽位、事件重要性打分或辅助费用面板；
模型输出质量与完整桌面点击链不由本地测试推定。

### D-284 · 2026-09-16 · 2.2–2.7（容量驱动的后台续接压缩）

类型：默认值调整

背景：当前 D-081 为消除压缩时的摘要等待，持续用活动模型维护工作块，再以分支/块修订/entry coverage 接管 Pi 压缩。
keeper 的工具与推理参数不同，不能据同一模型假定共享主请求缓存；块维护、事件 nudge、重复注入与接管检查形成了常态开销。
按需同步摘要能减少维护，但会失去用户要求的前台无明显整理窗口期。用户明确保留无感目标，并接受按容量提前后台准备。

决定：

1. 正式采用“后台固定摘要准备 + 前台原文持续追加 + 需要时切换”。准备属于首版主线，不放到后续优化。单次压缩周期共用
   一个在飞任务/候选；候选 ready 不改变活跃输入，正常新增 entry/steering 不使已固定历史摘要失效。
2. 沿 Pi 会话树与安全切点，先固定旧摘要及待收束 A、保留 B，再生成 S1；新增 N 全部保留。提交结果为 `P + S1 + B + N`。
   摘要范围、来源与 firstKeptEntryId 一起发布；不能事后缩短未被摘要覆盖的 B/N。来源因导航或另一次压缩失效时取消/弃用，
   未提交候选可随 worker 消失，原始 Pi 历史不丢；不建立新数据库或隐藏 Thread。
3. 容量沿模型/provider 的有效窗口、实际输出/推理配置及用户覆盖。每次真实模型请求前检查，包括回合内工具继续；旧 usage、
   cache 字段按实际口径处理。首次准备约75%可用输入作为可配置工程起点，此后结合摘要耗时与输入增长调整提前量；未显式设
   原文保留量时，压缩后总输入规划约60%，包含摘要、原文及准备期间新增尾段。两者是调度默认，不是硬上限或最佳注意力值。
4. 摘要沿 session ModelRuntime 的主请求构造派生，保持适用 system/tools/messages/缓存参数，在尾部说明收束范围。单次
   输出可读摘要，没有工具执行器、memory_edit、独立槽位或凭据栈。摘要调用与切换后首次前缀计算分别记实际 usage/耗时，
   不再声称缓存冷了整理免费，不保证同模型就缓存命中。
5. 摘要请求自己也须装得下；输入突增/模型变小可沿同一机制分次收束可容纳旧前缀，保留新原文。必要时复用在飞摘要并等待，
   不隐蔽裁剪工具结果，不循环生成无进展候选。普通任务结束、空闲、TTL、事件完成本身不新增模型调用。未用候选的费用是
   提前准备的明确取舍；provider 慢与首次新前缀计算仍可能产生可见延迟。
6. 增加当前会话/活动分支 history 查找与原文回读，复用 Pi entry 与现有输出存储。Zone 2 只追加新事实与相关新指针，已保留
   基线不重放；只在实际提交丢失对应原文后重建观察。删除文件/技能批量重注入目标与按压缩次数催促委派的要求。
7. 完整替换持续 keeper 的 token/事件/cooldown 调度、coverage 接管、memory_edit、三态模式与专属 UI；保留 plan/todo、
   用户笔记、accepted knowledge、suggestions 与事件原有权限/版本/送达边界。线程简报/进度/报告不再依赖 keeper 块，删除
   keeper decisions 自动建议来源。停止 keeper 不等于抹掉全部 blocks，不为旧字段另起模型。
8. 自动压缩沿 Pi 开关，后台准备默认启用但可独立关闭。原生会话与外部配置保全，旧关闭意图不静默变成允许后台调用；旧
   memory 字段通过明确诊断/关闭处理退出，不保留旧引擎、内部格式迁移或长期双模式。正常会话 token/费用 UI 保持。

原因：将“生成摘要”与“采用摘要”分开，可以利用前台仍有空间的时间，摘要无需跟随每次新进展重做。减少的是持续维护责任，
同时保留用户要求的正常无感体验。保留较长原文是信息取舍，不能宣称所有成本与质量指标同时改善。

考虑过的替代：仅在窗口放不下时同步总结会把生成等待放回前台；持续 keeper 或每次追加重做候选继续产生常态开销；摘要
ready 立即采用会过早破坏已有缓存；通过降低工具正文预算隐藏等待损害调用用途；另加摘要审查模型与记忆平台没有必要。

影响：设计 2/4/5/7/8/9/12；plan 0.4/0.7/2.2–2.7（2.4A/B、2.6A/B）；status 的新目标与当前运行区分；architecture 4.4。
D-081 的默认 keeper/三态接管、D-076 的 keeper coverage 依赖、D-226/D-238 的模型 nudge 目标由本条取代；D-076 的用户
block 分支/CAS 与观察送达、D-226/D-229/D-233/D-238 的事实来源/归属/幂等边界保持。

状态：已实施（2026-09-16）。请求前预算、固定候选后台准备、`session_before_compact` 提交、history 回读与旧 keeper/
coverage 路径删除已接线并经真 Pi+faux 纵切验证；证据见 status 矩阵 2.4A/B、2.6A/B。真实缓存/质量/延迟在使用中
观察，不以付费实验或新评测平台作为实施前置。

### D-286 · 2026-09-16 · 2.2–2.6 / 3.18B（完整上下文取舍与过期背景重建）

类型：问题与解法

背景：D-284已采纳GPTpro上下文报告与用户的无感要求，但实施不能收窄成“后台启动摘要”一个功能。用户进一步指出，工作
线程接续任务时可能携带大半过期背景；即使模型能自行甄别，重复读取也有成本，系统/项目要求更不能因复用缓存长期沿旧版。

决定：

1. 整套上下文目标共同实施：信息保留优先于单纯减token；工具首次呈现支持实际用途，机械去重与语义淘汰分开；稳定前缀与
   增量尾部；当前请求容量/输出预留；随窗口保留近期原文；保存因果与精确细节的一份续接摘要；缓存友好派生与真实成本；
   退出持续keeper但保留计划/知识；历史回读和实际正文保留；正常用量/UI与少量有用验证。设计8.4.8列出完整映射。
2. 用户的正常前台无明显整理停顿继续为目标，取代报告的默认同步压缩选择。后台固定候选/前台追加/按需提交按D-284，
   不因为补其它原则又改回持续keeper，也不把无感降成以后才做的优化。75%/60%仍是可配置工程默认，不是注意力阈值或实测最优值。
3. 工作连续性与输入连续性分开：同一相关工作可continue，背景大半不适用可在同一工作fresh，无关任务新Thread。调用者/
   用户选择，接收者可提出重建；不按TTL、轮数或token阈值自动判过期，不增加语义评分模型。
4. fresh从当前任务、仍有效用户要求与纠正、当前系统/项目配置、选定成果/工作状态、必要未决问题、活跃动作与历史入口
   构造。旧代码验证仅绑定原修订；模型判断旧调查是否仍有用。加载当前权威规则，不把旧摘要当永远有效的指令源。
5. 复用Pi会话/分支与请求接缝建立新输入世代；保留原始历史、Thread/Run与结果引用。重建不清代码delta、不隐式换权限、
   不丢待处理消息，也不强制调用模型将全部旧历史再概括一遍。候选输入就绪才发布，失败保留原工作现场。
6. 跨压缩有实际引用用途的输出指向现有会话保留正文或artifact，临时句柄不能冒充永久全文；不要求所有输出永久存储。
   用户附件的逐项比较、代码原文和未知错误不能为预算被擅自摘要。利用现有格式器与存储，不建立第二个材料平台。

原因：大窗口允许推迟丢弃信息的决定；按用途提供充分材料可以减少往返。线程复用应复用仍相关的理解与成果，模型甄别能力
不能使过期输入免费。明确fresh不破坏工作结果，就可以在任务阶段变化时更换背景，而不强迫继续累积或重开整件工作。

考虑过的替代：只做后台摘要漏掉输入质量和保留策略；把每次新任务都塞进旧线程浪费上下文；自动新鲜度打分/清洗增加维护；
fresh之前再总结全部历史会把旧负担换个包装带回来；缓存复用优先于当前规则会延续过期指令。

影响：设计8.0/8.4.3/8.4.5/8.4.7/8.4.8、9.3；plan2.4/2.6与3.18B；status与architecture。补充D-284，不撤回其后台准备或
修改历史条目；D-285负责工作线程和执行入口。共享Pi构造/读取接缝，不新增上下文数据库或循环。

状态：上下文侧已随D-284实施（2026-09-16）；`fresh-input`构造接缝已实现并有定向证据，线程spawn消费与continue/fresh
入口待plan3.18B接线。当前运行代码的线程侧仍走旧派发/单向send，不把规格覆盖表当作实现或模型效果证据。

### D-314 · 2026-09-22 · 阶段 C（后台压缩 Agent 与语义续接）

类型：问题与解法

背景：用户确认需要保留近期工具过程与后台准备期间新增的原文，但指出“直接钉住最近 user”过于粗糙：用户消息可能很长、
只是补充或引用资料，应该在压缩工作中理解有效要求。当前实现是一次无工具执行器的总结调用，更新提示较弱，
准备时的近期保留原文没有实际作为参考送入。用户接受把压缩升级为独立后台子进程，按需用工具补查，并确认接近容量时等待摘要。

决定：

1. 新增阶段 C，以内部 compaction worker 复用 Pi loop、模型/provider/auth 与进程生命周期。它可以按需查历史、对应工具输出
   和相关任务记录；清楚的材料直接总结，不强制查询、不增加摘要审查 Agent、固定轮数或额外记忆平台。
2. 保持 D-284 的 S0/A/B/N 固定范围与提交权。B 实际作为理解续接位置的参考，S1 替代 S0+A，近期原文 B 与新增 N 由会话系统接回。
   worker 无权删除 B/N 或自行移动切点；正常新消息不要求候选追赶，分支/输入世代等失效沿原 owner 处理。
3. 首次/更新共享完整提示要求。区分用户指令、引用材料、讨论与决定，按语义保留有效目标/纠正/理由、精确短引用、未完操作与来源。
   不以最近一条 user 或固定轮数作为保留语义，不将旧摘要中的过时要求继续升为当前约束。
4. 查询优先使用有身份的历史记录和版本化产物；实时观察明确标注，不能冒充旧事实。压缩查询不消费主会话的已读、增量观察和送达收据。
   worker 只执行整理所需的查询，历史里的 shell/write/spawn 不重放，不另开业务任务或递归压缩。
5. 继续提前准备、ready 暂存、下一模型请求容量不足时等待同一候选。输出预留不等于工具突增的绝对缓冲；输入估算不是服务端精确计数。
   worker 自身也为查询和摘要留出容量，依当前模型与材料安排，不新增统一硬阈值。业务线程名额不能形成父等摘要、摘要等父释放名额的循环。
6. 复用普通用量、取消和 UI 状态。子进程隔离不直接证明质量更好，额外查询及工具定义变化可能增加耗时/减少缓存命中；不预先声称收益。
   以定向生产行为完成验收，真实付费模型、跨平台完整桌面及语义质量观察不是代码交付前置。

原因：压缩需要理解工作的含义和接续位置，而不是机械删除旧消息或复制最后一条 user。有限职责的查询能力可以弥补来源缺口，
独立运行便于取消与资源管理，原有固定候选机制则保证主会话的并发追加与原文连续性。

考虑过的替代：仅加大近期保留量不能识别长材料中的有效要求；每次都调查会增加无意义调用；普通业务子线程会附带不需要的
工作树/Goal/团队及名额语义；让摘要追赶最新历史会重复消耗并模糊切点；仍保留两套长期摘要引擎增加恢复与维护分歧。

影响：新增 context-compaction-agent-design；harness 8.4、plan C0–C4、status、architecture、roadmap、development 与决策索引。
后续实施涉及 context-preparation/context-request-boundary、session-host、broker worker 生命周期、Host 历史/输出/任务只读入口。
部分取代 D-284 的单次无执行器实现目标，保留其历史 authority、后台准备、候选绑定、容量等待与安全提交。

状态：设计已接受，尚未实施。本次只有文档修改；当前运行仍为 D-284 单次摘要路径。

### D-325 · 2026-09-24 · 阶段 N（会话下一步选择）

类型：问题与解法

背景：现有会话辅助在 `agent_settled` 后固定等待，再借通用小模型从最近一组用户/助手文本生成短回顾和单条下一句；
建议默认开启，模型分工里的 `models.knowledgeSuggestions` 实际承担知识建议。用户希望建议可反映当前局面、按需给出不同方向，
同时要求它保持单次请求、及时且输入很短，并认为自动会话回顾多余。

决定：阶段 N 将下一步选择配置为默认关闭的独立模型分工能力，知识建议槽位明确改名。Host/Pi 从当前分支和已有状态
准备带来源的短事实切片：目标状态、近邻用户原话、最后助手结论及程序可确认的失败/未完状态。项目配置不能打开
用户已关闭的建议；只调用所选模型一次，
无按需历史工具、检索子 Agent、第二轮补查或每轮新增摘要；理解不足和无需后续选择都可返回空。候选方向数量随局面变化，
点击只填草稿。结果绑定分支末尾和配置，过期/关闭/取消不展示；旧自动回顾及重复建议设置退出。

原因：建议是可选的轻量交互，不值得为了覆盖所有长历史歧义增加请求、工具循环和等待。短材料无法解释当前任务时
安静退出，比从缺失上下文猜测用户的下一步更合适。独立模型绑定让后台费用和启用时机由用户控制。

考虑过的替代：复用知识建议槽位会混淆知识库写入与输入框草稿；沿通用小模型默认生成会继续产生未主动选择的调用；
给建议任务完整历史查询能力会损失时效；固定每轮一条或固定方向会把“已答完”的对话也推向下一项工作。

影响：plan 阶段 N；已同步 harness 模型槽位设计、protocol/Host/Pi/UI/设置目录及 status。

状态：已实施；定向 type-check、runtime/session-feature 测试与文档验证通过。真实模型建议质量和完整桌面纵切仍未测。
