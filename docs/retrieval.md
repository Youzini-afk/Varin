# 上下文、检索与知识

检索给出证据，上下文决定某次请求实际收到什么，知识保存显式保留的信息。三者共享来源身份，不能互相代替：索引可以重建，
记忆可以纠正，已经受理的请求仍须保留当时使用的精确材料。

[Agent runtime](runtime.md) 拥有不可变 request/context 与后台 inference，消费既有 Host 领域服务；
执行适配器不另造文件、文档或知识权威。

快速检索在直接搜索/读取与独立检索 Agent 之间，交付可继续工作的代码证据。它属于原工具 Operation，不创建协作成员、worktree 或独立聊天。
上下文充分是前提：优化复用和无收益扩展，需要联合理解的代码共同进入判断，输入小不是独立目标。

## 证据先绑定来源

文件命中与 excerpt 属于实际读取的来源：准入 live root 及观察 revision、固定 branch/revision，或显式捕获的草稿。
项目 ID、路径、旧图索引行号不足以证明来源。范围在匹配排序前生效，固定依赖缺失不能改读当前磁盘。
详见[资源](resources.md)和 [Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md)。

Host 搜索将 inventory/content 计算交给 Rust compute，保留原来源及可选固定草稿覆盖，不再启动生产 ripgrep child 或维护第二
递归 JS scanner。结果区分 empty、partial、cancelled、failed；NDJSON 以背压交付有限 batch，JSON 完整结果走同一计算。
显式 result limit 与静默遗漏剩余搜索范围不同。

## 精确搜索、Explore 与语言语义

这些能力解决不同问题，可以直接调用，不要求前一层失败后才能使用下一层。

- 精确 content/name 搜索定位准入范围内的字面证据。
- Explore 汇合 literal/identifier、graph path、可选 semantic 候选，读取真实来源并按问题打包窗口。材料可增量交付，
  慢的可选来源不会抹掉已经可用的证据。
- `related` 描述文件级 import、reverse import 与 connection topology，不等同于 LSP references；association 不冒充确认连接。
- LSP 使用所属语言进程与版本化文档视图。固定来源必须使用自己的文本/环境，不能借用不一致的 live server 结果。

共享上下文组织与生成式判断在 `packages/protocol`；Host 的 `ExploreQueryRun` 保存原问题、版本化材料、已尝试工作、选择与来源状态。
同一文件快照在多轮间复用，相同正文的新增命中依据合并；不可变 view 引用与材料位置、来源 revision 分开。
原生入口接入已经打开的本地符号图，关系只在源文件版本吻合时使用。远端来源继续由原 Host 读取，不借用协调端同名目录的图。

一次查询只有一套选材与行动判断：

| 设置 | 选材与补查 | 生成式模型用途 |
| --- | --- | --- |
| 自动 | 优先快速决策；未配置时依次采用 Explore LLM、重排、来源排序 | 快速决策按需请求查询扩展 |
| 快速决策 | 比较材料贡献与下一步；交付也是正常选项 | 按需扩展仓库用语与搜索表达 |
| Explore LLM | 同一材料/动作契约下的生成式判断 | 规划、选材和补查 |
| 重排 | 对已取得材料排序 | 不运行自主补查循环 |
| 来源排序 | 字面、已有关系、语义召回与确定性整理 | 不调用选材模型 |

决策比较具体动作、等待某个已有结果、直接交付，不再将达到固定概率的所有动作同时排入队列。
已选服务失败保留证据与原因，同次调用不更换付费提供商。配置、凭据和 tokenizer 在本次查询中固定；显式撤权仍即时生效。
独立检索 Agent 使用 `models.retrievalAgent`；快速检索的生成式能力使用 `models.explore`，职责不混用。

`models/token-count.ts` 租用 Rust 原生 TokenCounter，复用模型 tokenizer 获取、匹配质量与词表释放机制。
分批计数包括序列化的问题、证据、选项、说明和生成输出空间，模型输入容量按实际绑定传递。
同文件证据优先共同进入判断，分批保留共同背景和已选位置，无法完整容纳的片段报告容量原因。
所有候选仍留在查询中，出现新关系后可以再次比较；没有逐轮摘要调用。相同判断输入和计数结果在查询内复用，提供商 usage 继续取原始回执。
模型请求期间的结构增强不会使原快照失效；文件内容变化则刷新该文件的视图及动作依赖，保留其他文件的选择，再判断新的证据。
模型窗口是输入边界，预览条数是展示选择，两者不控制删除已选证据。

同轮同匹配规则的字面表达式合并成一次原生搜索，并保留各表达式的命中归属。
默认发现遵守 ignore；显式 `paths` 在原授权范围内搜索隐藏/依赖目录，不沿用默认目录剪枝。
快照由原来源准入，模型发送与应用结果时校验实际涉及的材料，最终 Rust 按文件读取并重建真实原文。

快速检索卡片显示问题、实际阶段、已读片段和已选标记。Host 通过私有检索桥发送元数据快照，
Rust 保留原 Thread/branch/Run/Operation 身份转发；慢消费者合并快照，正文按需从该查询读取。
界面中的“摘录”读取当时快照；点击文件位置打开当前文件。二者具有明确的版本含义。
直接调用和 `tool_invoke` 使用相同卡片，界面预览不进入主模型上下文。

“使用已有材料”经原 Operation 的 `runtime.retrieval.finish` 控制交付，与取消整轮对话分开。
它在准备、读取或判断期间都能到达。查询冻结已有结果、关闭新增工作；原推理 owner 继续持有已发请求，
接收回执、保留 usage 并排空资源。最终结果不再等待剩余可选来源或慢观察者，独立后台索引继续运行。

最终输出分开保留 `snippets`、`coverage`、`diagnostics` 和 `completion`。未探索范围、索引覆盖、服务失败与用户结束各有自己的事实。
不存在检索专用 24 KiB 丢弃层；完整选中原文写入原工具历史，统一输出预览负责正文预算及 `read_thread` 引用。
`limit` 只约束直接展开的片段数，必要材料组不在预览中拆半，续读指向同一次保存的完整结果。

候选量/来源预算是覆盖事实，不是置信度。graph/index 缺口保持可见。Graph 给 path，真正文本须重读并重新定位 symbol/literal
才输出位置；过期关系可以不带行号。可选 relation enrichment 不能让成功文本搜索失败，也不能挤掉 unread/partial 提示。

Structure 使用 native tree-sitter grammar/recipe 与适用 LSP fallback。小单元可完整呈现，大单元保留签名、命中块、省略标记和
全文入口。普通 Explore slice 不为装饰启动 cold language server；显式 preparation 才经过现有 owner 请求它。
结构不支持/失败时保留短文本窗口和诊断，不丢命中。

入口：[workspace search](../packages/web/application-host/lib/search/DOCUMENTATION.md)、
[Explore](../packages/web/application-host/lib/harness/explore.ts)、
[structure/graph](../packages/web/application-host/lib/structure/DOCUMENTATION.md)、
[LSP](../packages/web/application-host/lib/lsp/DOCUMENTATION.md)。

## 派生索引与 inference

代码 semantic 和 knowledge-vector 是目的不同的派生库。身份包括实际 content/revision、model/vector space 和 recipe。
新 generation 发布不会改写已有 reader 的 pin；相同路径或 provider 展示名不足以复用。

文件观察器启动和后台索引独立于前台查询准入。观察器尚未就绪时，查询使用当前可用索引和检索路径，
标明覆盖未完成；观察器就绪后统一补齐扫描。多个查询复用同一次观察器准备。
固定版本、物化 worktree 与 managed 来源同样只查询已有发布。候选逐文件核对实际版本，变更或未索引文件仍参加文本检索；
前台不枚举整个来源来补建文档向量，索引覆盖单独报告。无已发布索引时也不会为这次查询冷建索引。

Native 前台 query embedding、rerank、decision、generation 使用原 query session 和递增 ordinal。
Catalog 管受理、dispatch、usage、receipt 与恢复；Host 配置、凭据、egress、protocol adapter 保持原归属。辅助推理直接使用原生 inference 路径。后台文档索引继续使用现有 index owner。

`localBekko` 是已有本地 embedding 组件。Native 未配置 embedding 选择可用它；显式 remote、disabled、invalid、unavailable
不得偷偷 fallback。组件身份包括经过验证的 manifest/model/tokenizer/recipe/runtime。
它只承担相应 embedding 工作；knowledge-vector 的原有配置与索引 owner 保持独立。

本地 grain 在 encoder entry 前取得原 dispatch 许可；排队取消、实际完成和 worker exit 提供不同回执。
observer abort 不能证明 active compute 停止。Provider usage 在答案校验前保留，缺维度仍缺，估算不能变成真实 token/价格。
缓存命中不捏造付费请求；恢复不自动重发 unknown dispatched call。

详见[semantic](../packages/web/application-host/lib/knowledge/semantic/DOCUMENTATION.md)、
[knowledge vectors](../packages/web/application-host/lib/knowledge/vectors/DOCUMENTATION.md)与
[provider](../kernel/crates/varin-runtime/src/providers/README.md)。

## Web、学术与文档材料

发现返回来源引用与逐项状态；provider failure/fallback 可见，snippet 不冒充全文。Host egress 管目标策略、redirect、
DNS/proxy/TLS 和取消，外部 URL 仍是不可信输入。

Web snapshot 和本地文档捕获保留原件、来源、reader scope 与 revision。提取文本、outline/table/figure 与 page image 是同一材料
的不同视图。PDF 文本不能证明视觉忠实，页面读取交付真正 typed image。刷新 URL 产生新观察，不改写已引用来源。

原生输入的 PDF upload 经过 ThreadMaterials 作用域校验，用 documentReader 与 MaterialStore 保留原始字节。
submit、三种 enqueue 与 child continuation 冻结已授权 snapshot 的来源信息，`document_read` 继续读取同一原件；
浏览器只传原始文件，既不提取正文，也不把任意 snapshot ID 变成访问授权。

材料集合保存引用和显式跨任务 share grant，知道他人 material ID 不等于有权限。读取/模型选材重查原 grant；来源失败不变空文档。
artifact、collection、log follow-up 使用原发布事实和耐久 occurrence。

实现位于 `harness/web-search.ts`、`web-fetch.ts`、`web-materials.ts`、`research-search.ts`、`document-reading.ts`、
`material-read-service.ts`、`material-collections.ts`。Native adapter 在 `kernel/web-runtime.ts`、`document-sources.ts`
及材料 owner；工具 adapter 不再建一层材料缓存。

## 普通 Agent 笔记与 Bot 知识

普通 Agent 笔记是 Rust-backed personalization record 中的显式轻文本，范围是 global、project、真实 conversation identity。
写入带 revision，不自动语义提炼。选中对话文字保存普通笔记只打开可编辑文本，不调用 organizer。
用户 prompt override 与 SYSTEM、APPEND、skill 等资源文件分开。

对话保留 system-memory snapshot，避免每次笔记编辑重写前缀；新内容可立即读取，并按真实 receipt 以 request fact/tail 交付。
只有压缩成功发布才替换 snapshot。取消摘要/请求失败不标记已交付，也不丢旧版本。这是稳定输入机制，不保证 provider cache hit
或普遍 token 折扣。

Bot 知识用原 KnowledgeStore 和可选 organizer。Bot owner 来自 Host/Catalog binding，不信任 caller 的 mode label；
Bot 不收到普通 Agent 笔记/prompt override。来源 span 保留真实 Thread/branch/item 身份和精确文字范围，Markdown 渲染不重定义 offset。

显式保存、自动提议、纠正和遗忘均保留 provenance，推断与明确要求分开。已审来源覆盖包括空判断并可重启恢复，变更来源重开范围。
Prepared proposal 核对原 mutation receipt，不在写入未知时另生成答案。原文 reader 对被引来源返回 changed/missing/unavailable，
不能用另一版文字充当引用。

Organizer 的 MemoryWork 保留固定 recipe、source claim 和 model receipt。Sleep 先关闭新准入，再取消/排空。
显式 Retry 关联原未知计费，不是免费透明重跑。Preview 与 Save/undo 分开。详见[记忆](../packages/web/application-host/lib/memory/DOCUMENTATION.md)。

## Knowledge 与 Plan 的单一 writer

KnowledgeStore 通过私有进程使用 TriviumDB。计划、知识和符号图共用原权威；派生 semantic/vector 工作有另一进程，
避免长索引占满计划/记忆队列。Host facade 只提供允许的方法，不暴露任意 SQL。

权威写入在 WAL 耐久后确认。Checkpoint 失败保留 dirty，重试持久化而不重放 mutation；进程丢失保留 unknown outcome。
关闭排空已受理工作并等待 native handle，不回退到 Host 内 writer。符号 association refresh 按文件让出队列。

Agent Thread plan 在原库中使用不可变 version、branch reference 和 mutation receipt。Catalog 固定原 Tool/Policy invocation
和 ancestry，Knowledge 执行自己的 CAS；这是可恢复协调，不是跨库事务。丢回执返回原结果，不替换后来用户编辑。
只读文件来源不阻止独立准入的 plan/memory 修改。

详见[KnowledgeStore](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)。模型质量、provider 延迟和长期记忆效果
需要对应真实观察，确定性请求接线测试不能证明它们。
