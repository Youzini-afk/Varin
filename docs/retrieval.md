# 上下文、检索与知识

检索提供继续工作所需的事实和原文，上下文保存本次调查的探索历史，知识保存显式保留的信息。
原生 Catalog、Storage 和各领域 owner 共同保证实际来源、授权与结果归属；UI 不另建执行循环。

## 两种检索入口

| 入口 | 执行与交付 | 模型配置 |
| --- | --- | --- |
| `code_retrieval` | 启动原工具 Operation 所属的后台 Agent 调查，立即返回任务身份；回答自动进入父会话输入队列 | `models.explore`，界面为“快速检索模型” |
| 正式检索 Agent | 原协作派发、消息、报告及续接 | `models.retrievalAgent` |

`question` 是快速入口唯一必需的任务信息。已有线索自然附在问题里即可；不要求主 Agent
先写搜索计划、关键词或证据清单。`paths` 是明确的文件调查范围，沿共用搜索/读取生效。
终端沿原 Source 的进程授权执行，路径提示不冒充操作系统沙箱。自然语言中的猜测位置仍是线索。

新配置默认明确沿用当前会话模型，也可独立选择支持工具调用的普通模型和推理设置。
已有显式模型、禁用状态和凭据保持原选择。旧快速决策/重排配置需要用户选择普通模型或继承；
错误、慢响应和容量失败都不暗中切换另一家服务。快速决策与重排保留其他实际消费者的用途。

快速入口和正式检索共用原生 Supervisor、ExecutionEngine、ModelSession、ToolDirectory、
上下文准备与通用压缩。探索按真实模型/工具交换追加；Host 不再维护候选池、选材评分、
补查竞赛或逐轮材料重排。最终回答直接交付，不再调用报告整理模型。
输入小、轮数少、返回片段多都不是独立的质量目标。

## 内部执行归属

快速检索在同一 Catalog 中拥有内部 Thread/branch/Run，归属于原 `code_retrieval` Operation。
内部受理保留原工具调用身份；重连和恢复找到同一内部执行，不伪造 `dispatch` 或重发未知副作用。
内部记录不进入普通会话列表、协作成员、未读计数、自动命名或任务调度。
进程与文件效果仍由实际内部操作记录，外层检索不再宣称任意终端都是只读。

模型、来源、角色和可用工具在受理时冻结；实际能力取角色与父方可委派授权的交集。
未声明的能力沿 `tool_describe` / `tool_invoke`，不能凭工具名绕过目录与权限。
内部检索不递归派发新的快速检索或协作成员。

原工具以 Thread 生命周期的 Job 受理；受理回执闭合本次工具交换，不等待调查完成，也不让父 Run
自动进入等待。主 Agent 可以继续其他工作，后台调查继续使用原执行与资源 owner。
父工具不会在整个调查期间持有阻挡内部进程的宽范围文件租约。

选择、预设模型与来源交接检查在 `code_retrieval` 派发前执行，与 `dispatch` 相同；拒绝时调用未派发。派发后受理前失败（例如 Host 保留子模型或扩展绑定）返回 `retrieval_preparation_failed`，`details.stage` 指出步骤，`details.cause` 保留原 code 与 message；Catalog 没有子任务且本次准备引用已释放时，以原执行者的无副作用回执结算为 failed/none，pin 释放未确认时保留清理说明。已受理的任务失败沿原句柄查询和交付。

父 Run 在 Wait 后重新绑定模型时，先使用本 Run 自己的凭据注册，并按冻结的子任务目录重新保留各预设的确切模型配置与账号范围；某个模型无法重新绑定时，只让对应派发失败。

`retrieval_control` 接受同一会话分支的 `operationId` 与一个动作：

| 动作 | 行为 |
| --- | --- |
| `status` | 立即返回实际状态、经过时间、最近一条助手消息和最近实际工具动作；助手未说话时该项为空 |
| `wait` | 用原生持久 Wait 挂起本轮主 Run，等待该调查停止；取消这次等待保留后台调查 |
| `stop` | 向原调查取消域发出停止请求，返回请求与确认状态；已有回答、工具证据和用量继续保留 |

最近消息直接来自自然产生的公开助手正文，最近动作来自实际工具历史和在途 Operation。
动作只投影工具名、状态、路径、查询或命令等识别信息，不复制文件正文、完整工具结果或思考内容。
不增加进度总结请求，也不要求检索 Agent 为观察接口另写进展。

调查结束并确认资源释放后，原生 Catalog 按原任务身份将回答送入父分支输入队列一次。
主 Run 正在工作时，在下一次闭合工具交换的模型请求边界接收；本轮已经结束时沿原消息接续机制
创建后续 Run。暂停、取消与已有执行门控继续生效。显式 `wait` 和自动交付共用同一份回答，
不会再附加一份子任务报告。已排队的结果和投递身份可重启恢复。
停止保留中断时已有的公开回答，等待真实执行停止后释放资源；请求停止与已确认停止分别显示。
未确认效果仍标为未知，失败或压缩中断保留真实结束状态。

内部实际模型回执计入所属父会话一次，正式子任务继续使用各自归属。
父会话删除同时纳入内部历史、内容引用和派生资源的原回收流程；存活进程或 handoff pin
阻止过早删除。检索详情通过父 Operation 读取真实历史与工具操作。

## 文件来源与终端

| Source | 文件与命令行为 |
| --- | --- |
| LiveRoot | 使用原准入目录，读取当前文件，复用实际执行位置 |
| Materialized | 使用原 environment/Run 的工作副本，不新建另一份检索 worktree |
| Native workspace | 绑定原逻辑 branch 与范围，读取、搜索和命令使用该分支当前挂载的同一原生工作状态 |
| FixedBranch | 初始读取不可变 branch/revision；第一次需要命令时按需物化同一版本 |
| Managed Host | 原资源 Host 持有读取、物化、进程和清理权威 |
| 无来源 | 保留不需要来源的能力；需要 cwd 的命令明确报错 |

固定来源的执行视图由 Rust Storage 的原物化 journal 准备。后续读取、搜索和命令看到同一个
派生目录；最初版本保留为 baseline，旧证据仍指向原观察。准备失败或中断按原 journal 恢复，
不会借用当前项目目录。派发其他检索时，已修改的执行视图通过 Derived handoff 捕获当前内容，
原 pin 和目录引用在交接完成前继续保留。正式 Shared 检索可发布工作结果供后续协作使用。

两种检索默认具有命令启动、输出、输入、状态、等待和停止能力；显式 read-only 选择继续有效。
终端使用原会话权限，不增加检索专用命令白名单，也不自动安装项目依赖。
完整 IDE 拆分及 VSIX 是独立产品方向；Agent/Bot 的注册、目录、披露和子任务配置候选不再包含
`language_*` 工具。IDE 保留自己的语言服务，基础检索不启动 LSP。
续聊的新一轮继承原有工具名称范围，并按当前注册目录更新 schema、移除已退役项；
不会自动增加新工具。历史快照和已经受理的请求保持冻结，重试同一输入仍返回原受理结果。

## 共用搜索、读取与命令

### 搜索和发现

`file_search` 接受一个 `query` 或 `queries` 数组，同一范围和匹配方式共享文件扫描。
批量结果以 `queryIndices` 保留归属；某表达式错误不会抹掉有效表达式的结果。
支持 `paths`、`lines`、`windows` 三种结果：只列匹配文件、匹配行、合并同版本重叠上下文窗口。
`file_list` 保留目录用途。范围、ignore 与隐藏目录设置随结果显示；显式路径可进入被默认忽略的依赖目录。

两种工具的 `nextCursor` 续读原生同一计算任务，绑定来源、查询、过滤和原 grant/epoch。
页面大小可以改变，条件变化须重新查询。游标保留已取得页面和扫描检查点，按需恢复扫描；
结果缓冲达到既有预算时让出线程，等待模型期间不占扫描线程，不建立全仓结果索引。
读取完毕释放任务，Run 撤权回收弃用游标。重启、过期或来源变化给出明确重查指引。

`scanComplete` 表示完整覆盖，`pageComplete` 和 `nextCursor` 表示展示与续读。
已观察数量不是全仓总数；为了计数不会强制继续扫描。无匹配、路径不存在、部分不可读、
取消和整个来源失败保持区别。多路径请求保留其他路径命中及逐路径错误。
LiveRoot 的续读是多次真实观察；检查点文件发生变化时要求重新查询，不冒充整仓快照。

### 原文和结构单元

`file_read` 支持单文件和 `files` 批量，逐项保留状态、精确换行、版本、范围及续读。
同次调用中同来源的重叠范围共用观察；合并结果超过帧时沿原请求分别读取。
显式原文页不再被模型显示预览第二次静默剪裁；`readVersion` 和原文换行始终保留。

可选 `unit: { line, symbol, revision }` 通过按需 Tree-sitter 选取代码单元。
命中行优先最小包围单元，单独符号重名返回候选；返回名称、签名、精确字节/行范围和正文。
`symbol` 位于 `unit` 内，按实际声明名匹配。支持完整 import 单元；空行或独立注释没有包围单元时，回退结果给出最近的前后单元与读取参数。
大单元以 `offset` / `length` 与 `nextRead` 续读；版本变化要求重新选取。
解析缺失、失败、没有包围单元或单元语法不完整时，保留原因并读取普通原文。
按行选择的默认回退含前 20 行、后 60 行上下文，可用 `nextRead` 继续；显式原文读取仍可调整范围。
已开始的单元续读不会悄悄切换成文件偏移。批量读取保留每项的歧义、过期和失败状态。
没有 LSP fallback 或全仓图预热。
结构解析后读取再次校验正文 hash，避免结构和原文来自不同版本。

### 进程

`process_spawn` 以“程序 + 参数列表”或互斥的 `shellCommand` 执行；shell 由实际 Host 决定，
直接参数不再拼接成 shell 字符串。返回原进程身份、实际 cwd、状态和可用首段输出。
`waitMs` 是观察等待，覆盖进程退出和输出收尾，默认 0 立即返回；`maxOutputBytes` 是首段输出目标，不是杀进程期限。
持续任务继续使用 `process_read`、输入、状态、`wait_process` 与停止工具。

原 spool 保留通道、字节和精确 cursor；退出状态与输出是否读完分开表达。
同一通道相邻存储块合并后投影 UTF-8，正常文本在模型中只出现一次。
字符跨页面/通道、二进制或其他编码保留 Base64 与明确原因，脚本仍可按原始字节解码。
发送输入、取消观察、请求停止和已确认退出是不同事实。

## 依赖与存储

基础检索不要求嵌入服务、本地 embedding 组件、代码向量库、持久化符号图或 LSP。
代码索引登记、watch、扫描、自动重建、本地模型准备以及旧 Explore 决策/选材流水线已退出启动链。
Tree-sitter 只解析实际请求的文件；语言服务器保留真实编辑器或显式语言功能消费者，不因选项目预热。

“记忆与知识嵌入”设置提供本地模型组件、远端模型服务和关闭三种选择；未配置模型时使用文本检索。
本地组件支持安装和导入，按实际知识任务加载，CPU 偏好与线程设置在重启 Host 后生效。
本地与远端请求都由原 KnowledgeInference UtilityRun 和推理回执记录，向量空间包含真实模型及组件身份。
旧代码索引的目录登记、维护和清理入口已移除。知识向量仍由独立派生存储 owner 管理，空间统计归入记忆与知识向量。
`optional-components/local-semantic` 保存可选的知识嵌入运行库与模型，不作为旧代码索引清理项。
不为可重建缓存另做完整备份，不在升级时未经说明删除用户源码或知识库。

Bot knowledge-vector 仍有独立用途，使用 `vectors/embedding-owner.ts`、原 KnowledgeStore 和
原生用途推理回执。共享 embedding 分段、tokenizer、凭据与取消机制继续服务实际消费者；
代码检索退出不等于删除这些数据域。

## 交互与验证边界

线程内沿用快速检索专用呈现，显示问题、实际最近动作、回答和可展开的工具过程。
详情复用共用搜索/文件/终端视图，限定滚动区域；在底部时跟随输出，用户上翻后保留阅读位置。
展开/收起使用现有动效并遵循 reduced-motion。正式检索保留协作成员与报告呈现。
运行卡片在父 Run 结束后继续显示调查状态；停止按钮控制原后台任务，关闭详情保留执行。
完成后的回答归入原检索卡片；原调用尚未加载的历史分页位置保留独立结果入口。

原生及真实 Host 接线测试覆盖普通工具循环、固定来源命令后读取、分页、部分失败、
输出游标和回收；测试提供商为本地协议 fixture。真实服务的回答质量、延迟和成本需要在
具体模型、来源和问题上观察；当前实现不把接线测试耗时当作模型性能。

入口：[原生检索](../kernel/crates/varin-kernel/src/tools_retrieval.rs)、
[后台控制](../kernel/crates/varin-kernel/src/retrieval_control.rs)、
[原生结果交付](../kernel/crates/varin-runtime/src/catalog_retrieval.rs)、
[共用发现](../kernel/crates/varin-kernel/src/tools_discovery.rs)、
[共用读取](../kernel/crates/varin-kernel/src/tools_read.rs)、
[执行视图](../kernel/crates/varin-kernel/src/storage/execution_views.rs)、
[Host 协作 owner](../packages/web/application-host/lib/kernel/thread-collaboration.ts)、
[结构服务](../packages/web/application-host/lib/structure/DOCUMENTATION.md)。

## Web、学术与文档材料

### 搜索连接与实际筛选

没有显式搜索配置时，工具准备与执行都启用产品提供的匿名 Exa MCP，失败才沿默认 Parallel MCP
备用路线继续。明确关闭、空连接列表、配置错误和缺失凭据分别表达，不恢复匿名默认来掩盖错误。
用户连接保存稳定 ID、名称、适配器、端点、凭据引用、说明和启用状态；同一服务可以有多个账号或实例。
默认与备用顺序独立配置。旧单渠道设置读取时归一化，首次保存写连接结构，保留原凭据引用。
智能选源开关与岗位模型分别保存，设置页和 Agent 的 `route` 动作均可操作。只保存选源偏好时保留匿名连接；
添加自定义连接后改用用户目录，显式空数组仍表示没有连接。

Agent 通过设置工具的 `harness.web.search.connections` 动作管理这些相同的连接。先 `list` 读取原始 ID、
状态和配置 revision，再按连接 `add`、`patch`、`remove`，或用 `route` 调整默认、备用顺序与智能选择。
修改沿原 AgentSettings 的 revision 检查与权限管理，不覆盖其他连接或设置。`test` 与设置页共用真实测试实现，
只测试指定连接，无自动备用；零命中与失败分开报告。整组 `harness.web.search` 仍支持显式完整替换。

`enter-credential` 在当前对话绑定的已认证界面打开密码输入框，返回原设置动作可查询、可取消的 operation。
用户输入直接送到 Host 原凭据 owner，模型只能看到状态和连接元数据。切换 Host 清空本机输入；取消的请求拒绝后续提交，
端点或凭据引用变化时旧录入请求也会失败。该交互随 Host 会话存在，重启后需要重新发起；已保存的密钥保存在原凭据存储。
`credential-status` 只返回配置状态，`remove-credential` 显式移除该引用的密钥；删除连接本身保留可能共享的凭据。

`websearch` 的 `objective` 是本次目标，与 `query` / `queries` 同时提供时不另发一条目标搜索。
只有目标时可直接搜索。`action:connections` 只返回可用连接及真实能力，不发网络请求。
`connectionId` 精确选择一个连接且不自动换渠道；`connectionIds` 显式进行互补搜索。
自动模式沿启用的默认和备用路线执行，零命中不是故障。批量项保留各自结果、失败、渠道和实际尝试。
上游分页与展示分页分开：先续读当前上游页尚未交付的结果，再请求下一页。续读复用原响应缓存；缓存过期后
重新取得同页时校验其结果与过滤顺序，变化则要求刷新原查询，不把旧偏移应用到新结果。Brave 的合法空网页
分类保留为空结果，损坏的结果结构或错误响应归为协议失败，自动路线可继续备用连接。

适配器将域名、时间、语言与地区条件传到实际支持的接口，同时对可确定的域名范围做结果核验。
`appliedFilters` 说明上游参数、查询操作符、结果过滤或排序，以及日期的真实依据。
`strictFilters` 拒绝不能满足的条件；普通偏好可返回结果，但说明未满足项。
全局和可信项目的来源偏好与网络 allow/block 权限分别保存；当次偏好可覆盖，网络权限不能由搜索参数放宽。

连接测试只运行已保存的连接，用其原凭据 owner 和 Host egress，显示实际测试时间及错误。
配置完整性不冒充连通性。匿名入口有供应商免费使用边界；独立连接用于用户自己的账号和自托管实例。
当前集成 Exa、Parallel 匿名入口及 Brave、Exa、Tavily、Jina、SearXNG、AnySearch 适配器，不把普通模型对话当作联网渠道。
AnySearch 使用普通 HTTP 搜索接口，API Key 可选；没有 Key 时使用供应商的匿名额度。支持语言偏好与 `cn` / `intl`
区域偏好，单次最多返回供应商允许的 10 条结果；域名由结果过滤，时间和其他地区条件会明确标为未应用。
结果保留实际连接及供应商身份，搜索摘录仍是摘录，后续原网页读取继续使用 `webfetch`。

### 原文、问题与获取完整性

`webfetch` 接受 URL、固定 snapshot 或 `ref` 引用，可附 `question`，也可指定行、章节、元素或精确查找。
短文直接返回；默认长文按正文页展示，`maxLines` 调整展示目标，`nextRead` 继续同一份材料。
问题选段使用词项、中文及混合语言切分、标题和技术符号定位原文，返回精确范围、结构和选择依据。
代码、表格和列表沿提取表示保留。找不到匹配时说明范围，保留结构及普通续读，不生成替代原文。

普通获取优先使用 Host egress。显式启用渲染后，可请求实际 BrowserOwner 渲染或在空正文时回退。
Electron 使用同一 BrowserOwner 的目标站点身份，临时隔离页面只经原 Host 网络回调取得 GET/HEAD 资源；
每个资源和重定向重新核验 HTTP(S) 协议与用户配置的域名规则，跨 origin 不转发 cookies/认证。直接 Chromium 网络由拒绝代理封闭，
禁用 worker、frame、弹窗、表单、非 GET/HEAD 和独立 socket。需要这些交互的页面应使用 Browser Use。
渲染省略资源时标记部分提取；不为网页阅读另建持久登录仓库。没有 BrowserOwner 的 Host 明确返回不可用。

下载字节、提取覆盖与当前展示各有完整性状态。UTF-8 跨块解码按实际字节保留；下载截断不是显示分页。
已取得部分页面可作为部分观察保存，刷新取得新观察，不改写旧引用。PDF/Office 路由到原文档 owner，
部分下载不交给二进制解析器。Office 解压另有 Host 资源预算：默认单 part 32 MiB、每次 package 累计
128 MiB、10,000 entries，可由 `VARIN_OFFICE_MAX_ENTRY_BYTES`、`VARIN_OFFICE_MAX_INFLATED_BYTES`、
`VARIN_OFFICE_MAX_ENTRIES` 调整。ZIP 结构和实际展开量均校验，渲染前检查全包；不发布截断 XML，
仍保留能读取的概览和其他部分。

### 来源、引用与继续调查

每个搜索命中保留固定的供应商观察，不把搜索描述、页面摘录、生成摘要或未知内容混为全文。
`research_search` 保留论文身份、关系分页和元数据快照；摘要与开放下载位置都不表示已读论文。
观察包含实际 provider/connection、查询、抓取时间、已知发布日期/作者、表示版本及内容 hash。
长摘录只在当前工具页缩略；完整已观察内容由原 Rust Storage 材料 owner 保存，不建立搜索旁路数据库。

`source.citation` / 网页 `citation` 使用 `varin-material://` 固定 snapshot、revision 和可选行范围。
不连续选段各自返回 `passageCitations`。正文点击引用读取当时的材料，可展开上下文、继续原文、引用到提问草稿
和打开原网页；日期分别显示观察时间与发布日期。
原始网页消失不改变已保存观察。引用字符串只是定位，读取仍经过原 Thread 材料权限。
工具输出附带原生 typed material descriptor，`attachmentRef` 可用于派发和消息的显式附件。
最终报告和压缩摘要只延续已经取得的 typed 来源，不从任意 URL、hash 或正文中的伪造 ID 授权。
接收者、分支与历史保留关系保护其来源；发送方删除不使接收方证据失效，最后真实引用释放后沿原 owner 回收。
准备交付失败时保留已有搜索/阅读结果并报告来源状态，不能宣称接收者已获访问权。

持续调查直接复用现有调研 Agent、续聊、后台任务和消息。工具说明能力与来源性质，不固定调查轮次或模型链。
材料集合保存用户选择的引用和显式跨任务 share grant。集合搜索覆盖标题、来源、论文标识和正文；
只有正文命中携行号。来源失败不变成空文档，刷新、收藏与局部补查沿既有工具和授权完成。

### 可选辅助与执行寿命

智能渠道选择和问题阅读辅助默认关闭，分别使用配置的普通 LLM 或 typed decision 模型。
渠道选择只在自动模式存在多个合适连接时运行；精确指定或单一连接直接执行。
短网页能在本次展示范围内完整返回时直接交付，不调用阅读辅助。长网页的辅助候选覆盖原文结构块，
词项匹配只影响优先顺序，零词项命中仍可处理跨语言问题。容量足够时提供全页；容量不足时交错保留
相关段落与页面不同位置的内容，按实际模型窗口及决策接口选项容量选取，并标明材料不完整。
程序验证返回范围属于本次实际提供的原文，允许相邻段落连读；有效的空选择保留为未找到相关内容。
Token 计数采用对数次缩减，避免每删除一个段落就重算整份材料。不把生成文字作为原文。
岗位模型、思考配置和调用预算独立，实际用量沿原推理请求与 receipt 记录。
确定失败时回到默认路线或确定性选段并说明原因；实际执行停止未确认时返回未知，不自动重发可能计费请求。

搜索缓存绑定完整请求、连接配置和凭据身份；获取缓存绑定方式、Thread/浏览器访问范围与网络策略。
刷新绕过旧观察。相同请求共享生产者，单个观察者退出不停止其他消费者；最后消费者取消后等待实际生产者排空。
过期记录定时清除，Host 关闭取消并排空缓存工作和辅助请求。短期缓存寿命与已引用材料的历史保留分别管理。

### 文档视图与验证边界

Web snapshot 和本地文档捕获保留原件、来源、reader scope 与 revision。PDF 文本、结构与页面图像是同一原件的
不同视图；文本不能证明视觉忠实，页面读取交付真正 typed image。`document_read` 只有来源时默认读取正文；
显式 `view:overview` 保持概览并返回携原 snapshot 的 `nextRead`。Office 保留 section/object/range/query 和实际
nextOffset；没有文字、尚未请求、解析失败与组件不可用分开表达，不自动启用 OCR。

原生输入 PDF/Office upload 经过 ThreadMaterials 校验，保留原始字节。submit、enqueue 与 child continuation
冻结已授权材料；前端只传原件，不提取正文，也不能凭 snapshot ID 获得权限。

固定响应覆盖适配、筛选、回退、取消和辅助失败；原生测试覆盖 typed 引用、报告、压缩、分支、删除与重启。
真实匿名查询只证明当时的连通性与结果，不能替代供应商质量/延迟或辅助模型的成本比较。
Electron 实机登录页面、完整交互和不同平台仍需在对应环境验收。

入口：`harness/web-search.ts`、`web-fetch.ts`、`web-sources.ts`、`web-materials.ts`、`research-search.ts`、
`document-reading.ts`、`material-read-service.ts`、`material-collections.ts`；native 接线位于 `kernel/web-runtime.ts`、
`web-retrieval-assistance.ts`、`document-sources.ts` 及原协作/附件 owner。工具 adapter 不另建材料缓存。

## 普通 Agent 笔记与 Bot 知识

普通 Agent 笔记是 Rust-backed personalization record 中的显式轻文本，范围是 global、project、真实 conversation identity。
写入带 revision，不自动语义提炼。选中对话文字保存普通笔记只打开可编辑文本，不调用 organizer。
用户 prompt override 与 SYSTEM、APPEND、skill 等资源文件分开。

对话保留 system-memory snapshot，避免每次笔记编辑重写前缀；新内容可立即读取，并按真实 receipt 以 request fact/tail 交付。
只有压缩成功发布才替换 snapshot。取消摘要/请求失败不标记已交付，也不丢旧版本。这是稳定输入机制，不保证 provider cache hit
或普遍 token 折扣。

Bot 知识用原 KnowledgeStore 和可选 organizer。Bot owner 来自 Host/Catalog binding，不信任 caller 的 mode label；
Bot 不收到普通 Agent 笔记/prompt override。来源 span 保留真实 Thread/branch/item 身份和精确文字范围，Markdown 渲染不重定义 offset。

Bot 记忆支持自由正文、多处来源和可选分类，事项与实际 incoming 交流参与召回。后台整理按原分支位置增量读取，
按实际模型预算取正文并推进真实覆盖，不每轮展开全部历史。修订和不再适用使派生概述失效；遗忘进一步过滤来源范围，
并在后续请求前重建已经吸收相关内容的有效上下文。原始聊天作为资产保留，详见[长期总助手](bot.md)。

显式保存、自动提议、纠正和遗忘均保留 provenance，推断与明确要求分开。已审来源覆盖包括空判断并可重启恢复，变更来源重开范围。
Prepared proposal 核对原 mutation receipt，不在写入未知时另生成答案。原文 reader 对被引来源返回 changed/missing/unavailable，
不能用另一版文字充当引用。

Organizer 的 MemoryWork 保留固定 recipe、source claim 和 model receipt。Sleep 先关闭新准入，再取消/排空。
显式 Retry 关联原未知计费，不是免费透明重跑。Preview 与 Save/undo 分开。详见[记忆](../packages/web/application-host/lib/memory/DOCUMENTATION.md)。

## Knowledge 与 Plan 的单一 writer

KnowledgeStore 通过私有进程使用 TriviumDB。计划与知识使用原权威；旧符号记录只保留清理入口；派生 semantic/vector 工作有另一进程，
避免长索引占满计划/记忆队列。Host facade 只提供允许的方法，不暴露任意 SQL。

权威写入在 WAL 耐久后确认。Checkpoint 失败保留 dirty，重试持久化而不重放 mutation；进程丢失保留 unknown outcome。
关闭排空已受理工作并等待 native handle，不回退到 Host 内 writer。

Agent Thread plan 在原库中使用不可变 version、branch reference 和 mutation receipt。Catalog 固定原 Tool/Policy invocation
和 ancestry，Knowledge 执行自己的 CAS；这是可恢复协调，不是跨库事务。丢回执返回原结果，不替换后来用户编辑。
只读文件来源不阻止独立准入的 plan/memory 修改。

详见[KnowledgeStore](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)。模型质量、provider 延迟和长期记忆效果
需要对应真实观察，确定性请求接线测试不能证明它们。
