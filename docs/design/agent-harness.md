# Varin agent harness

Status: design accepted; D-284–D-286 are implemented and independently corrected by D-287; delivery facts are in status.md

Last updated: 2026-10-06

正文为中文。English readers: this document specifies the Varin-owned agent harness (tools, retrieval,
knowledge store, context and cache contract, verification, profiles) layered on the Pi agent kernel.
The [current process model](../architecture.md#process-model) locates this contract within the system.

本文档是**边界**。哪项能力做到了哪一级（implemented / wired / proven / default-on）看
[status.md](../status.md)；未完成的纵切与实施规则看 [agent-harness-plan.md](../plan/agent-harness-plan.md)；
每个偏离的理由看 [decisions/README.md](../decisions/README.md)——日志不是规格，被采纳的决定都已回写到本文。

当前上下文、协作和资源合同分别由[上下文](harness-context.md)、[多 Agent 协作](agent-collaboration-design.md)
和 [Rust 内核](rust-kernel-design.md)专卷负责。已完成阶段的时间线留在[交付记录](../archive/harness-delivery-log.md)，
这里不重复阶段清单或把历史缺口当成当前任务。

## 1. 决定

Varin 不再只是 Pi 的图形外围。产品由两部分组成：**工作台**（已交付：文档权威、编辑器内核、
恢复、多端、可组合 Shell）和 **harness**（本文档）。Pi 继续作为 **agent 内核**：模型/provider 栈、
会话树、包管理、扩展模型、内置工具的默认实现。这是发行版模型——内核来自上游，userland 由
Varin 拥有、调优、默认提供，且每一块都可以被用户替换。

决定 harness 质量的四件事——工具环境、检索、上下文管理、验证——全部收回到 Varin 拥有的代码
里。D-282 已完成 D-252 定义的 Rust 系统内核阶段：文件/资源/持久事务、物化、受管进程/PTY 与文件/结构计算由
Application Host 的私有 Rust 子进程接管，TS 保留产品和 Agent 策略，Pi 继续内置。完整边界和实际性能证据见
[rust-kernel-design.md](rust-kernel-design.md) 与 status；不从实现语言外推未测平台或统一提速倍数。

### 1.1 非目标

- 不重写 agent loop、模型抽象或会话存储。Pi 的 `pi-ai` / `pi-agent-core` / `pi-coding-agent` 保持
  为运行时内核。
- 不在"谁的模型更聪明"上竞争。harness 放大模型能力，不替代它。
- 不为第三方 Pi 扩展的上下文注入行为提供归因、节流或代管。第三方扩展在本契约之外；本契约只约束
  Varin 拥有的组件。
- 按已确定的领域用途建设共享接缝，不预建没有消费者的完整框架；不以第二个 profile 是否已经上线决定能否实施接口。
- 不把插件配置页、Pi 包管理或恢复权威并入 harness。它们保持
  [architecture.md](../architecture.md) 记录的归属。

### 1.2 借鉴来源与取舍

本设计的机制来自已在生产中验证的 harness：Claude Code 的分层压缩、工具结果预算、`cache_edits`
微压缩与 `<system-reminder>` 尾部附着；Cognition 的 Fast Context 检索子 agent（专用小模型、并行
工具调用、轮数上限、窄工具集）、Devin Fusion 的压缩时刻换模型、"写单线程、其他 agent 只贡献智力"
的多 agent 原则、Devbox Blueprint 的环境确定性；Manus 团队围绕 KV 缓存的上下文工程原则；Aider
repo map 的符号引用图 PageRank。Varin 不复制它们的实现，只采纳经过验证的形状，并利用自己独有
的资产：host 拥有的 LSP、Document Registry、终端子系统、恢复日志，以及 TriviumDB 嵌入式知识层。

### 1.3 交付政策：正式实施，完成即默认提供（D-078）

本项目处于早期，正式设计中的能力直接推进实现。接通真实使用路径、通过与改动风险相称的正确性验证并能诊断失败后，随交付默认
提供；不再先挂长期 candidate/shadow 标签，也不要求独立回放集、配对实验或测试者报告才能使用。质量、延迟和成本在真实使用中
持续改进，发现具体错误修对应路径，不把局部问题扩张成整项能力禁用。

执行者可以为正式目标调整持久格式、数据 authority、协议与默认值，并更新全部消费者。当前没有用户兼容需求，
旧 Varin 内部格式可直接清除重建；不做旧格式升级导入、双读双写或旧后端 fallback，替换完成即删除旧实现（D-253）。
工作区/Git、原生 Pi 数据及外部配置照常保全，不以“再加一个消费者”或完整通用框架作为前置。

默认提供与用户选择分开：已有显式关闭、模型槽位、凭据、持久知识审阅和权限策略保持有效。缺真实服务、缺配置、版本冲突或压缩
来源不足时，只处理对应请求并说明原因。fallback 是这些具体情形的运行行为，不是把新架构永久放在旧实现后面的交付策略。
本次修改的是设计政策；当前代码仍然关闭或未接线的能力如实记录在 status，不能靠改文档把它们标成已启用。

## 2. 已确定的决策

以下是跨模块的当前约定：

| 主题 | 决定 |
| --- | --- |
| 产品边界 | Varin 拥有工作台与 harness，Pi 拥有 Agent loop；其他 Agent runtime 的接入仍是能力协商设计，不是当前 Pi 的兼容后端 |
| 系统内核 | 阶段 R 已由 D-282 完成：Rust 系统内核 + TS Application Host/产品与 Agent 编排 + 内置 Node/Pi worker；每类系统资源只有一个生产权威，不保留双写、shadow 或旧后端 fallback |
| harness 形态 | 通用内核 + 领域 profile；不是每个领域一套 harness |
| profile 作用域 | Workbench Profile 属于 surface 展示；Agent Profile 属于执行配置。工具与 system 在同一执行配置世代内冻结；同一持久 Pi session 可经用户操作进入新 Run/配置世代，切工作台布局不改变执行配置（D-063/D-072） |
| 工具注入 | 与 Pi 内置工具**同名覆盖**，不并列；覆盖发生在 pi-host 进程内 |
| 重活归属 | Host 服务保持统一入口；工作状态/磁盘恢复/物化、PTY/受管进程、文件与结构计算位于私有 Rust 内核。TS 保留知识库 adapter、LSP 协议/视图、结果呈现与策略；pi-host 保留模型调用、薄工具和钩子 |
| worker→host 通道 | 类型化协议请求（`@varin/protocol`），沿 `workspace.mutation.request` 先例；worker 不持有 host 凭据、不直接打 HTTP |
| 检索分层 | 精确匹配用 grep；快速发现和原文获取用 explore；开放事实追踪用 retrieval。文件/结构/索引操作归 Host，较长语义判断归 agent，持久记忆检索归知识库；三种工具不要求逐级失败后才可使用（D-173） |
| 知识库 | 知识/计划由 Host 的私有 TriviumDB storage owner 持有，派生语义库独立；普通 Agent 笔记由 Rust personalization 记录持有。TriviumDB 非不可替换依赖，具体问题先交用户联系作者处理；当前不迁移 SQLite、不建双写权威（D-071） |
| embedding | 后端可替换，远程接入独立于重排。`harness.embedding` / `harness.rerank` 是用户所有的配置种类，不是聊天模型槽位。未配置远程且用户已安装本地组件时代码语义走 MiniLM，否则语义来源不可用，词法与结构/图检索继续（D-288）；配置有效即按同一 vector space 索引与查询。知识库仍可无向量。来源身份、用途、编码文本与维度决定向量复用，后台建设和查询分别调度；不从模型体积推断速度或跨语言质量（D-173/D-190） |
| shell 形态 | PTY（复用终端运行时，后台 shell 即终端 tab）；每次命令使用显式或请求冻结的 cwd，跨调用不继承 cd / env / venv；stdin 开放且 harness 永不代写；等默认时长后**自动转后台**而非超时杀死；配套 `get_output` / `write_to_process` / `kill_shell`（Devin CLI 与 Codex `unified_exec` 的共同形状）；Git Bash 为默认解释器但 Windows 原生工具可从中调用 |
| 工具并发 | D-305 已把 D-302 / 7H 接入真实 Pi 执行入口：按权限确认后的资源读写关系排序，独立工具并行，未知副作用保留屏障；写入仍经过 Host authority，不做 apply model（5.9） |
| shell 环境 | 解释器按工作区环境选定（原生 Windows → Git Bash，WSL → wsl bash，远程 → 远端 shell），用户可覆盖，模型不按次选；login shell 继承用户工具链；环境变量只改交互与显示，**不设 `CI=1`**，locale 探测不硬编码 |
| web | harness 自做 `webfetch` / `websearch`，参照 `pi-web-access` 能力清单原生实现（来源面板、凭据进 Pi auth、独立浏览器 profile、GitHub 走 octokit）；SSRF 复用 security.md；跨域重定向不跟随；搜索默认走 Exa/Parallel 免密钥服务，用户自配 API provider 优先，不复用模型账户（D-289）；桌面端 Electron 离屏渲染 JS。provider / render / domain policy 按 worker generation 冻结，credential 每次调用实时解析；第三方包存在不会自动替换原生工具（D-283） |
| 模型与预设 | 普通线程明确继承当前模型，不要求 role。专用能力/预设沿现有独立槽位或明示的 inherit 解析，未配置不冒充可用；Worker 默认继承当前模型，旧用户配置保留为可编辑配置。续接摘要沿活动请求派生，不新增凭据栈或费用面板（D-284/D-285） |
| 可关可换 | 每项 harness 能力的关闭行为明确；默认不按插件存在与否偷偷改变行为，同名第三方工具替换必须由用户显式关闭原生工具。设置按**字段所有权**决定用户级与工作区级谁说了算（第 5.10 节），能力可用性由 host 注入。自动压缩沿 Pi 开关，后台准备可由用户关闭；两者与长期知识策略分开，不再暴露 keeper 三态 |
| 编辑格式 | 跟模型家族走：`edit`（str_replace）与 `apply_patch`（Codex 语法）并存，按会话模型启用；两者走同一 mutation boundary |
| OS 沙箱 | Windows 沙箱不在交付计划中（用户选择，D-071）；macOS/Linux 留作后续候选。现有权限与路径边界保持，不把工具限制或 worktree 称为 OS 隔离 |
| 缓存契约 | system/tools 在同一执行配置世代内稳定，原始历史只追加；压缩、用户改配置与权限失效按各自边界处理，不以缓存收益代替正确性 |
| 工作状态归属 | 主 agent 对上下文维护零义务；plan/todo 与用户笔记保持自身所有权，Host 维护事实，Pi 会话历史保持原文。后台摘要只产出固定历史区间的续接表示，不编辑工作块、计划或知识库（D-284） |
| 压缩 | 接近容量时后台准备一次摘要，前台继续追加；真正需要空间时沿 Pi 安全切点切换到新摘要与保留原文。候选绑定被收束的历史前缀，正常新增消息不使其失效；准备与切换分开，不再持续 keeper / coverage 接管（D-284） |
| 长任务连续性 | 正常路径前台无明显整理窗口期；摘要与近期原文承接工作，缺细节按需回读 Pi 历史。provider 慢或输入突增时真实呈现必要等待，不隐蔽裁剪；不以压缩次数强制委派或 Handoff |
| 持久知识治理 | 普通 Agent 管理显式笔记；Bot 使用同一记忆服务处理显式记录与用户启用的自动整理，保留来源、纠正和遗忘语义。见[知识合同](harness-knowledge.md) |
| 多 agent | code profile 由主线按独立成果/探索路线派发；research profile 增加首席研究主线、动态研究分支和按结果升级模型的集群调度。预设可选，允许 task/inherit 与定向父子/兄弟通信；写入线程默认独立 WorkingState，shared 明示选择；同根嵌套共享执行预算，等待让出名额；不建永久管理层或默认群聊（D-285/D-291） |
| 线程与上下文 | Thread 保留工作身份、成果与关系，Run 冻结当次执行和输入。工作相关可继续；背景大半过期可 fresh 而不清成果，无关工作新开线程。结果固定修订，依赖代码须实际纳入，不能仅靠消息同步（D-285/D-286） |
| 审查 | 实施者正常验证、主线关键验收；需要独立审查时派发具有相应工具权限的任务，不固定追加自动审查链。历史 verification/review 记录仍绑定实际结果修订（D-339） |
| 观察类工具 | 可能被反复调用的观察工具（`threads` / `wait` / `read_thread` / `get_output` 对运行中 shell / `diagnostics`）**默认返回自上次查看以来的增量**，全量要显式要；游标由 host 按（观察者，对象）持有，压缩时重置；结果只追加不回改（第 8.7 节） |
| 防过度委派 | 不增加调用配额、任务打分门槛或派发前费用估算；主线判断独立委派是否值得，自己更快更省就自己做。同根线程共享用户配置的执行名额，默认 12、超出排队；"派发前询问"是默认不生效的用户设置 |
| 长时间委派 | wait 默认因真实状态变化、用户输入/中止或调用方时限返回，超时是正常结果。缓存保活是用户可选的额外请求，按实际 provider 契约与用量执行；生命周期不依赖保活。等待中的已有摘要准备可完成，TTL、空闲和子返回本身不启动新的摘要任务 |
| 验证器 | 是有名字的 profile 声明；post-tool 反馈注入是统一通道 |
| 默认 runtime | 内置钉住的 Pi 作为默认；数据目录共享 `~/.pi/agent`；用户自有 Pi 是显式选项并带"未测试版本"诊断 |
| 领域顺序 | code → research → knowledge-work-in-files；SaaS 连接器不在前三个 profile 的范围内 |
| 度量 | 记录错误、重试、输出、缓存、普通会话用量、耗时与人工介入；不建立辅助模型分项费用/Token 看板。直接测试验证正确性，真实使用驱动优化。T4 和检索对照按问题需要使用，不是开发或默认启用门禁；Zone 0 稳定性由契约测试保证（D-078/D-080） |
| harness 的 UI 投影 | 后台 shell 成为可附着的终端 tab；输出句柄在工具卡片内可展开全文；Zone 2 默认折叠、可查看；压缩边界在时间线可见；线程在父会话侧栏成列、点开即完整聊天、可从父对话任意位置"从这里开一条线"（第 9.3.8 节） |
| 检索 | explore 由 Host 持有同一次查询，算法执行搜索/读取，向量提供语义候选，LLM 通过 models.explore 生成分组搜索计划、成组选段并指出具体补查；这些是当前交付项，不等待扩散模型。完整自主调查仍归 retrieval。来源机会、当前原文与必需范围贯穿最终呈现（D-173–D-175） |
| 未保存内容 | 用户输入自动固化发起窗口的 dirty buffers，无显式开启/绑定操作；来源引用由内部协议传播，其他窗口仅打开或聚焦不抢占。Host 读取不可变快照，surface 保持可变缓冲所有权；`explore`、`grep`、同名 `read`/`find`/`ls` 与 thread 基线已消费同一引用，语言服务按视图隔离后消费同一引用（第 6.1 / 6.4 节，D-071/D-082/D-085/D-086/D-087） |
| 结构来源 | LSP 提供语言语义；Rust tree-sitter 提供修订绑定的结构/单元。Host 的 web-tree-sitter 仅作安装时 grammar ABI admission，不再解析工作区正文。见[内核设计](rust-kernel-design.md)与[检索合同](harness-retrieval.md) |
| 检查与执行工具 | 验证任务可能使用读取与命令执行能力，测试/构建可能写缓存和生成物；不因任务叫“检查”就声称其只读，实际权限由工具配置与工作状态决定 |
| 模型家族适配 | 一份基础 + 极薄 overlay；先做 Anthropic 与 OpenAI 两档，其他 provider 走通用 |
| Pi 上游 | 不贡献回上游；Pi 更新后重新适配。能 wrap 的 wrap（`read` / `edit` / `write` / `grep` 装饰 Pi 实现），只有 `bash` 重写 |
| 权限 | Varin 原生 `tool_call` 门是唯一交互式权限权威，覆盖 Harness、Pi 内置、MCP、Pi 包与嵌套线程工具；Host 只验身份/能力/规范路径，不弹窗。未知/证据不完整的第三方动作必须询问，不能靠工具名或 annotation 自授予；会话授权绑定规范化 source/action/workspace/resource 范围（9.1.2，D-283） |
| 知识库保留 | 可配置；默认按时间自动清理原始 `event` 与已结束会话的 `block`，`knowledge` 不按时间过期；删除会话级联删除其 event 与 block |
| 用户级记忆 | 普通 Agent 全局笔记归 personalization；Bot 的用户层知识归 `user.tdb`。设置、来源、纠正与遗忘使用对应 owner，见[知识合同](harness-knowledge.md) |

## 3. 内核与 profile 的边界

harness 拆成层之后，大部分层在所有领域里不变，少数层变，其中一层是决定性的。

| 层 | 跨领域是否变化 | 归属 |
| --- | --- | --- |
| agent loop、会话日志、压缩机制、输出句柄、知识库存取、钩子点、权限框架、子 agent 生成、UI 投影 | 不变 | 内核 |
| 工具集 | 变；shell / 文件 / web / Python 是共享核心 | profile |
| 系统提示片段与技能 | 变 | profile |
| 上下文**策略**（压缩时保留什么、Zone 2 复述什么） | 变 | profile |
| **验证器**（传感器） | 根本不同 | profile |
| 权限默认值 | 变 | profile |
| 工作区形态 | 变 | profile |

验证器一行是分层的理由。编程有强的客观验证器（编译、类型检查、测试），harness 可以自动运行并把结果
注回上下文；科研只有弱验证器（引用是否存在、论断能否追溯到原文、数值能否复现），每一个都要专门构建
且不是二值的；日常工作的验证器是人的确认。三者不能共用传感器，但除此之外的层全部共享。

内核对 profile 暴露的接缝：

- **工具注册表**：profile 声明工具集；注册表支持渐进披露（常驻完整 schema 的核心工具 + 只列名字的延迟
  工具），不把全部工具常驻。
- **钩子点**：pre-tool、post-tool、turn-end、pre-compact。内核把 Pi 的对应事件封装为 profile 可声明的
  验证器挂载点。
- **验证器**：一个有名字的对象，声明触发钩子、作用范围与反馈形状；反馈统一通过 post-tool 结果注入。
- **上下文策略**：profile 提供 Zone 2 组装函数与压缩摘要模板。
- **知识库 schema 扩展**：profile 可以在基础节点/边类型之上追加自己的类型，不改基础类型。

## 4. 进程与代码归属

进程布局统一见[架构总览](../architecture.md#process-model)。Pi 工具经 `HostServicesBridge` 到达
Application Host，Host 再调用私有 Rust kernel；Pi worker 不直接调用 kernel。知识和派生语义存储
分别由 Host 管理的私有 Node 进程持有，不能把同步数据库工作重新放进 Electron 主线程。

Pi 同名工具定义、原生扩展钩子与 Host 服务是现有接缝，不增加 Pi 包或 MCP 跳板。
具体注册与调用归 [Pi harness](../../packages/pi-host/src/harness/README.md) 和
[Host harness](../../packages/web/application-host/lib/harness/DOCUMENTATION.md)。

### 4.1 Pi 钩子到 harness 机制的映射

以下映射对照本检出中 Pi SDK 的扩展事件类型核实：

| harness 机制 | Pi 事件 / API | 用法 |
| --- | --- | --- |
| 工具覆盖 | `customTools` on session create | 同名 `ToolDefinition` 覆盖 `read` / `bash` / `edit` / `write` / `grep`；`read` 只在 Host 声明固定来源服务时覆盖，否则保留 Pi 原生实现；新增 `apply_patch`、`get_output`、`write_to_process`、`kill_shell`、`diagnostics`、`todo`、`dispatch`、`wait`、`webfetch`、`websearch`；`executionMode` 按第 5.9 节声明 |
| 请求前上下文尾部 | `ContextRequestBoundary` → provider request | D-301 / 7G 已统一到每次 Agent 模型请求前准备：环境增量实际送达后留史，完整团队快照只临时附在本次尾部；不动态改写 `systemPrompt` |
| post-tool 反馈注入 | `tool_result` → 替换 `content` / `details` | 把诊断附加到 edit/write 结果；验证器的统一通道 |
| 工具门控 | `tool_call` → `block` | profile 的权限默认值；等价于"mask 不删" |
| 提交压缩 | `session_before_compact` → 返回 `compaction` | 提交已准备的摘要与固定 firstKeptEntryId，保留准备期间新增的原文；尚未准备好时沿同一摘要路径等待或生成 |
| 主 agent 意图 | `customTools`：`todo`（第 5.6 节） | 服务主 agent 自身注意力；主 agent 无块编辑与标记工具，对记忆系统零义务 |
| 请求预算 | 每次真实模型请求前，包括回合内工具继续 | 按当前有效窗口、实际请求输出预留和新输入计量；不能只依赖 Pi 的 agent_end 或用户 prompt 前检查 |
| 后台摘要准备 | 请求/步骤边界的容量检查 | 固定历史前缀与切点，由独立压缩 worker 沿活动请求配置生成续接摘要；可按授权查询历史/事实，不执行工作工具或写知识，主会话继续 |
| 异常容量压力 | 候选未就绪、失败、模型窗口缩小或新材料过大 | 复用在飞任务或同一摘要机制处理可容纳的旧前缀；保留新原文，不静默切回旧 keeper，也不忙循环重试 |
| 压缩后续接 | `session_compact` | 更新实际失去基线的观察游标与 UI 边界；不默认重注入最近文件、技能正文或整个状态面板 |
| 缓存断点 | `before_provider_request`（如需） | pi-ai 的 Anthropic provider 已在 system、tools、最后一条 user 消息设 `cache_control`；仅在 provider 缺失时补 |
| 轨迹采集 | `tool_execution_end`、`turn_end`、host 侧文档 / 终端 / LSP 事件 | 写入知识库，不进上下文 |
| 用户 `!cmd` | `user_bash` → 自定义 `operations` | 与 `bash` 工具共享同一 shell 监督器 |

### 4.2 已修复的前缀漂移与持续契约

`session-features.ts` 曾在 before_agent_start 把变化的目标 token 计数写进 systemPrompt；现已按 status 1.2 修复。
动态目标与运行状态使用尾部消息，不回改静态前缀。修改相关装配时运行现有 Zone 0 契约测试，不把已修缺陷重新列为前置任务。

### 4.3 Rust 系统内核（D-282 完成）

Rust 是文件资源、不可变工作状态、物化、进程/PTY 和文件/结构计算的唯一生产权威。
Documents/Registry、Thread/Run、模型策略和 Pi 原生数据继续由原 owner 负责。
[内核设计](rust-kernel-design.md)拥有资源与事务合同，
[Host kernel 模块](../../packages/web/application-host/lib/kernel/DOCUMENTATION.md)拥有生产装配、协议和平台边界。
旧 TS 后端仅能作为明确的测试 helper，不能成为生产失败时的 fallback 或双写者。

## 模块专卷

原 §5–§9 已拆分为以下领域文档；当前主题从这些入口定位：

- [harness-tools.md](harness-tools.md) — 原 §5 工具集（code profile v1）
- [harness-retrieval.md](harness-retrieval.md) — 原 §6 检索：三层，两个归属
- [harness-knowledge.md](harness-knowledge.md) — 原 §7 知识库（TriviumDB）
- [harness-context.md](harness-context.md) — 原 §8 上下文与缓存契约
- [harness-verification.md](harness-verification.md) — 原 §9 验证与多 agent

## 10. 工作侧重与工作台

### 10.1 与 Workbench Profile 的关系

[composable-workbench.md](composable-workbench.md) 的 **Workbench Profile** 选择 surface 的 Shell 与贡献点。
**Agent Profile** 在产品中称“工作侧重”，声明提示词、工具、技能、团队目录、上下文/验证策略、权限默认值与知识库扩展，
属于执行配置（D-072/D-297）。Workbench Profile 的 `default`/Agent Workspace 也不能与 Agent Profile 混为同一身份。

工作台在现有 Agent/IDE 切换区域提供入口，科研与未来办公使用完整 UIUX 和已有切换动画。
用户打开项目或会话、改变工作侧重时保持当前工作台；界面切换保留会话、文档、任务和执行配置，不调用模型或派发研究。
IDE 是完整开发环境，能继续科研任务；科研工作台也能承载普通编程对话，工具可用性不由 Shell 挂载决定。
具体产品交互见 [科研集群设计第 10 节](research-cluster-design.md#10-产品入口工作台与工作侧重)。

项目设置只提供新对话的默认工作侧重。新对话显式选择优先，未指定时捕获项目默认，再未指定沿用现有通用/编程默认；
工作台类型不参与解析。对话保存自身选择及来源，修改项目默认不改已有对话。对话侧重可手动修改，从下一轮用户请求
沿已有 Run/worker 安全切点应用；当前执行和已派发分支保持冻结配置，新配置失败时保留原配置并报告失败。
切侧重不删除成果或隐式停止任务；停止和继续保持显式的生命周期动作。

产品可以给出独立选择的建议，不能通过选工作台暗中应用执行预设。**模型槽位的值仍 user-only**，Agent Profile 只声明需要的槽位；
工作侧重也不扩大用户授权。办公工作台与 `knowledge-work-in-files` 侧重沿同样边界发展，不要求成对选择。
Agent Profile 的实际绑定随 Run/配置世代记录，单会话实验覆盖先沿已有 launch 接缝提供；完整 RunManifest 待真实消费者逐步收敛。
D-298 已接通独立入口、项目默认/对话覆盖和基础科研 UIUX；D-299 接通首段能力路由。
剩余调度、执行与 D-300 的协作扩展按 plan 后续阶段实施，具体交付事实见 status。

### 10.2 `code`（v1）

上面的[模块专卷](#模块专卷)定义其工具、检索、上下文与验证合同。工作区形态：仓库；验证器：编辑后诊断、可选测试门及按需审查；权限由 Varin 原生
`tool_call` gate 统一管理，并叠加 Host 的非交互 actor/capability/path enforcement（第 9.1.2 节）。

### 10.3 `research` 工作侧重（第二个）

AI4S 科研工作侧重的产品中心是 [科研集群设计](research-cluster-design.md) 定义的异构模型协作，而不是资料或记录管理。
用户面对一条首席研究主线，主线按研究方向派生多个 Thread 分支：强模型负责问题发现、第一性原理分析和跨分支综合，较强模型负责文献深读与实验设计，快速模型负责局部假设、实现、批量分析和异常处理，复核与写作按影响和论证缺口触发。模型按能力路由，分支可以升级、降级或换模型，不把具体型号绑定成永久职业。

研究循环是动态分叉、低成本区分、真实执行、交流综合和下一轮资源分配。普通批处理、进程监控和日志整理由程序完成；
是否因异常或冲突发起综合，由用户/Agent 通过自然语言交流决定，程序只响应明确请求与已建立的等待。
Thread 树负责执行责任，父子和同组分支可授权直连交流。现状取已有输出短摘录，经 Zone 2 持续增量提供，按需展开原文，
不新增交接表、状态汇报或总结模型。这些是通用多 Agent 能力，科研与普通编程、未来办公共同使用。

D-303 收口本机实验与事实消费者；D-305 已实施 D-304 的受管远程、真实进程/job 控制、多机器资源和材料复用，Slurm 暂缓。
Agent Run 与计算 attempt 独立；SSH 连接状态不冒充作业状态，资源请求不冒充 allocation。
Host 负责研究编排，目标 Rust 执行服务拥有实际作业和资源确认；运维角色使用普通 Thread，可按规模由零个发展为多个分管线程，
负责环境准备、故障诊断和授权修复，不替代程序准入、不固定管理层级。研究矩阵自然生长，系统只提供批量便利操作与来源关联，
不要求矩阵对象或参数表。实现边界见 [实验执行设计](research-cluster-design.md#6-实验执行与资源协作) 和 plan 7I。

文献、PDF、代码、数据、Shell、notebook 和领域工具作为工作侧重的材料与执行能力接入。证据、版本、运行和产物自动保留为内部事实基础；证据表、实验协议、Research Diff 和文章结构按需生成，不是研究者的前置表单。写作线从研究中途参与，发现论证缺口后回流检索或实验任务。第一阶段从代码、数据和计算实验开始，后续领域通过 Agent Profile/Adapter 扩展，不把产品固定成论文复现工具。

### 10.4 `knowledge-work-in-files`（第三个，收窄）

以文件为载体的知识工作：笔记、文档、表格、PDF，加浏览器与 web。办公与日常连续性的产品边界见
[office-work-continuity-design.md](office-work-continuity-design.md)。**它的范围不是一个目录**（D-162）：办公的东西天然分散在
Documents / 桌面 / Notes / Downloads，所以这个 profile 的检索范围按第 6 节的分层走——文件名与元数据全用户目录、全文词法
在用户指定的根、语义跟着工作集与钉住的集合——而不是把工作区模型硬套成"一个大目录"，也不是索引整个电脑。它是第 6 节
`scope` 参数化的第一个真实消费者；在它之前 3.16 只须不把门堵死。
SaaS 连接器（邮件、日历、聊天）本质是 MCP server 加不可逆动作的确认 UX，不在此 profile 范围内，未来若做以连接器层
出现，不新建产品形态；结构上它们是"把外部东西变成带身份、内容、修订的文档进同一个索引"，`scope` 多一种。

### 10.5 接缝先于领域

共享接缝围绕当前已确定的 code、research 与文件工作能力发展；一个真实消费者已能说明用途时就实现，不要求凑齐两个实例才允许
抽象。领域组件随自己的使用路径交付，不为尚无用途的功能预建完整框架，也不把 code 的全部长尾工作作为其他 profile 的共同前置。

## 11. 默认 runtime

桌面内置一份钉住的 Pi 作为默认 runtime。`inspectBundledPi()` 与 `includeBundled` 路径已存在并被云镜像使用，桌面端
只需在打包时放入 Pi 包树并设置 `packageRoot`；`nodePath` 使用 Electron 自带 Node。三条约束：

- **runtime 代码内置，数据目录共享。** 内置 Pi 使用用户的 `~/.pi/agent`；CLI 与 GUI 看到同一批会话、包与设置。
  运行时代码与用户数据的分离见[部署边界](../architecture.md#runtime-and-deployment)。
- **用户自有 Pi 是显式选项。** Runtime Manager 的 system / standalone / source / custom 来源保留在 Settings；选择的
  版本超出已测试范围时显示诊断，不阻止。
- **短滞后跟随上游。** 内置版本由与 `cloud-runtime.bun.lock` 相同的流水线更新，避免社区扩展要求的 Pi 版本高于内置
  版本。数据目录格式"旧读新"的风险由短滞后压缩窗口，由显式选项提供出口。

内置 Pi 不内置 Git Bash：Windows 上 `bash` 工具依赖 Git for Windows，Runtime Manager 的就绪检查必须包含它并给出
安装指引，否则"内置 runtime 开箱即用"在 Windows 上不成立。

当前 bundled runtime 已是默认路径；打包与运行细节见[部署边界](../architecture.md#runtime-and-deployment)。

## 12. 实施与证据入口

当前剩余工作见[实施计划](../plan/agent-harness-plan.md)，能力和验证边界见[状态](../status.md)。
已完成的阶段顺序、旧模型预设及 keeper 迁移过程保留在[历史计划](../archive/agent-harness-plan-2026-10-06.md)。
它们不要求恢复旧运行时、旧内部格式或旧产品入口。

## 13. 与其他文档的关系

- [进程模型](../architecture.md#process-model)和[权威归属](../architecture.md#authority-map)：定位 Host 服务、worker 请求与 Pi 原生运行时的分工。
- [rust-kernel-design.md](rust-kernel-design.md)：阶段 R 的最终资源归属、私有协议、存储与恢复、物化/进程/检索计算及发行性能契约。
- [composable-workbench.md](composable-workbench.md)：Workbench Profile 负责界面组合；工作侧重与 Harness 执行配置独立。
- [native-workspace-recovery-design.md](native-workspace-recovery-design.md)：`bash` 的 `process` writer 注册与
  `edit` / `write` 覆盖共存于同一 mutation boundary。
- [security.md](security.md)：知识库内容按工作区数据对待；`webfetch` 复用其私有网段阻断与 cookie opt-in 规则；worker
  不持有 host 凭据。
- [extension-compatibility.md](extension-compatibility.md)：第三方 Pi 扩展不受本契约约束，也不由 harness 管理；可继续通过普通 package
  surface 安装，但 package 存在不会让原生 web 工具或权限 owner 自动让位。

集成、级联删除、固定来源和历史结果的实现细节统一见
[Host harness](../../packages/web/application-host/lib/harness/DOCUMENTATION.md)及
[任务/资源设计](resource-oriented-harness-design.md)。D-224 的修复经过保留在决策和交付记录中。
