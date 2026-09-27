# Varin agent harness

Status: design accepted; D-284–D-286 are implemented and independently corrected by D-287; delivery facts are in status.md

Last updated: 2026-09-22

正文为中文。English readers: this document specifies the Varin-owned agent harness (tools, retrieval,
knowledge store, context and cache contract, verification, profiles) layered on the Pi agent kernel.
Section 4 of [architecture.md](../architecture.md) gives the process model this document extends.

本文档是**边界**。哪项能力做到了哪一级（implemented / wired / proven / default-on）看
[status.md](../status.md)；未完成的纵切与实施规则看 [agent-harness-plan.md](../plan/agent-harness-plan.md)；
每个偏离的理由看 [decisions/README.md](../decisions/README.md)——日志不是规格，被采纳的决定都已回写到本文。

D-284 将上下文管理改为容量驱动的后台摘要准备与按需切换，保留前台无明显整理停顿的目标，已实施：持续 keeper /
takeover 已删除，新链按 2.4A/B、2.6A/B 接线并经真 Pi+faux 纵切验证，当前事实见 status。
D-285 接受以工作为中心的可续做线程、可选预设、定向通信与分段成果；D-286 补齐整套上下文原则及“工作可延续、上下文可重建”。
D-287 已按真实 Pi/Host/Rust 消费者验收并修正上下文收据、Run 准入、消息提交边界和物化 baseline handoff；证据见 status 与验收记录。

D-292 的全仓工程阶段 Q：[测试与 CI 体系重整](testing-ci-design.md) 与 D-296 的旧伴侧插件清理已完成。
D-297 明确 AI4S 的工作台 UIUX 与 Agent 工作侧重独立，设计见第 10 节；科研执行与协作已推进至 D-305，实际交付见 status。
D-312 的快速决策模型与渐进检索已交付并接线（F0–F4），`explore` 为首个消费者；实测边界见 status。
D-313 的 [Varin 全面更名](varin-rebrand-design.md) 已落地：自有产品/代码/配置/发行配置与 GitHub 仓库
一次切换，不留旧名兼容；Pi 的实际依赖与原生数据保留。首次新品牌发行边界见 status，下一实施阶段为 F。

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

以下决定已经固定，改动它们需要先改这张表：

| 主题 | 决定 |
| --- | --- |
| 产品边界 | Varin = 工作台 + harness；Pi = agent 内核；其他 agent 是能力协商的 bring-your-own runtime |
| 系统内核 | 阶段 R 已由 D-282 完成：Rust 系统内核 + TS Application Host/产品与 Agent 编排 + 内置 Node/Pi worker；每类系统资源只有一个生产权威，不保留双写、shadow 或旧后端 fallback |
| harness 形态 | 通用内核 + 领域 profile；不是每个领域一套 harness |
| profile 作用域 | Workbench Profile 属于 surface 展示；Agent Profile 属于执行配置。工具与 system 在同一执行配置世代内冻结；同一持久 Pi session 可经用户操作进入新 Run/配置世代，切工作台布局不改变执行配置（D-063/D-072） |
| 工具注入 | 与 Pi 内置工具**同名覆盖**，不并列；覆盖发生在 pi-host 进程内 |
| 重活归属 | Host 服务保持统一入口；工作状态/磁盘恢复/物化、PTY/受管进程、文件与结构计算位于私有 Rust 内核。TS 保留知识库 adapter、LSP 协议/视图、结果呈现与策略；pi-host 保留模型调用、薄工具和钩子 |
| worker→host 通道 | 类型化协议请求（`@varin/protocol`），沿 `workspace.mutation.request` 先例；worker 不持有 host 凭据、不直接打 HTTP |
| 检索分层 | 精确匹配用 grep；快速发现和原文获取用 explore；开放事实追踪用 retrieval。文件/结构/索引操作归 Host，较长语义判断归 agent，持久记忆检索归知识库；三种工具不要求逐级失败后才可使用（D-173） |
| 知识库 | 优先保留 TriviumDB 嵌入式，每 host 每 workspace 一个 `.tdb`；Application Host 是唯一写者。TriviumDB 非不可替换依赖，具体问题先交用户联系作者处理；当前不迁移 SQLite、不建双写权威（D-071） |
| embedding | 后端可替换，远程接入独立于重排。`harness.embedding` / `harness.rerank` 是用户所有的配置种类，不是聊天模型槽位。未配置远程且用户已安装本地组件时代码语义走 MiniLM，否则语义来源不可用，词法与结构/图检索继续（D-288）；配置有效即按同一 vector space 索引与查询。知识库仍可无向量。来源身份、用途、编码文本与维度决定向量复用，后台建设和查询分别调度；不从模型体积推断速度或跨语言质量（D-173/D-190） |
| shell 形态 | PTY（复用终端运行时，后台 shell 即终端 tab）；持久会话 shell 保持 cwd / env / venv；stdin 开放且 harness 永不代写；等默认时长后**自动转后台**而非超时杀死；配套 `get_output` / `write_to_process` / `kill_shell`（Devin CLI 与 Codex `unified_exec` 的共同形状）；Git Bash 为默认解释器但 Windows 原生工具可从中调用 |
| 工具并发 | D-305 已把 D-302 / 7H 接入真实 Pi 执行入口：按权限确认后的资源读写关系排序，独立工具并行，未知副作用保留屏障；写入仍经过 Host authority，不做 apply model（5.9） |
| shell 环境 | 解释器按工作区环境选定（原生 Windows → Git Bash，WSL → wsl bash，远程 → 远端 shell），用户可覆盖，模型不按次选；login shell 继承用户工具链；环境变量只改交互与显示，**不设 `CI=1`**，locale 探测不硬编码 |
| web | harness 自做 `webfetch` / `websearch`，参照 `pi-web-access` 能力清单原生实现（来源面板、凭据进 Pi auth、独立浏览器 profile、GitHub 走 octokit）；SSRF 复用 security.md；跨域重定向不跟随；搜索默认走 Exa/Parallel 免密钥服务，用户自配 API provider 优先，不复用模型账户（D-289）；桌面端 Electron 离屏渲染 JS。provider / render / domain policy 按 worker generation 冻结，credential 每次调用实时解析；第三方包存在不会自动替换原生工具（D-283） |
| 模型与预设 | 普通线程明确继承当前模型，不要求 role。专用能力/预设沿现有独立槽位或明示的 inherit 解析，未配置不冒充可用；hardImplement/review 的当前模型继承明确展示。续接摘要沿活动请求派生，不新增凭据栈或费用面板（D-284/D-285） |
| 可关可换 | 每项 harness 能力的关闭行为明确；默认不按插件存在与否偷偷改变行为，同名第三方工具替换必须由用户显式关闭原生工具。设置按**字段所有权**决定用户级与工作区级谁说了算（第 5.10 节），能力可用性由 host 注入。自动压缩沿 Pi 开关，后台准备可由用户关闭；两者与长期知识策略分开，不再暴露 keeper 三态 |
| 编辑格式 | 跟模型家族走：`edit`（str_replace）与 `apply_patch`（Codex 语法）并存，按会话模型启用；两者走同一 mutation boundary |
| OS 沙箱 | Windows 沙箱不在交付计划中（用户选择，D-071）；macOS/Linux 留作后续候选。现有权限与路径边界保持，不把工具限制或 worktree 称为 OS 隔离 |
| 缓存契约 | Zone 0 会话内冻结；Zone 1 只追加、序列化确定；所有前缀失效操作批处理到压缩时刻 |
| 工作状态归属 | 主 agent 对上下文维护零义务；plan/todo 与用户笔记保持自身所有权，Host 维护事实，Pi 会话历史保持原文。后台摘要只产出固定历史区间的续接表示，不编辑工作块、计划或知识库（D-284） |
| 压缩 | 接近容量时后台准备一次摘要，前台继续追加；真正需要空间时沿 Pi 安全切点切换到新摘要与保留原文。候选绑定被收束的历史前缀，正常新增消息不使其失效；准备与切换分开，不再持续 keeper / coverage 接管（D-284） |
| 长任务连续性 | 正常路径前台无明显整理窗口期；摘要与近期原文承接工作，缺细节按需回读 Pi 历史。provider 慢或输入突增时真实呈现必要等待，不隐蔽裁剪；不以压缩次数强制委派或 Handoff |
| 持久知识治理 | agent 只提议（带触发描述），用户审阅接受；自动接受按作用域显式开启；更新用双时态取代不覆盖；召回按触发相关性；保留由用户裁剪 |
| 多 agent | code profile 由主线按独立成果/探索路线派发；research profile 增加首席研究主线、动态研究分支和按结果升级模型的集群调度。预设可选，允许 task/inherit 与定向父子/兄弟通信；写入线程默认独立 WorkingState，shared 明示选择；同根嵌套共享执行预算，等待让出名额；不建永久管理层或默认群聊（D-285/D-291） |
| 线程与上下文 | Thread 保留工作身份、成果与关系，Run 冻结当次执行和输入。工作相关可继续；背景大半过期可 fresh 而不清成果，无关工作新开线程。结果固定修订，依赖代码须实际纳入，不能仅靠消息同步（D-285/D-286） |
| 审查 | 实施者正常验证、主线关键验收、按任务安排独立 review/check。自动 review 默认关闭，用户明确开启的选择保留；绑定固定结果与真实 Run，不固定追加审查链（D-285） |
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
| 结构来源 | 语言服务器回答"这个名字指什么"，tree-sitter 回答"这段文字的形状是什么"，两者在 Application Host 长期共存、不替代。结构来源是带修订绑定的可插拔 provider，接口先行，首个实现是 agent 视图 `documentSymbol`，第二个是 web-tree-sitter；语法包 = 语法 wasm + Varin 查询，随版本锁定 ABI，常用语言捆绑（首刀 TS/TSX）、其余按需下载，目标覆盖大部分常用语言；语言 ≥ 3 时才做设置页（第 6.1 / 6.2 节，D-091） |
| 检查角色 | `check` 有读取与执行能力，测试/构建可能写缓存和生成物；不称只读 agent，不规定 bash 只能执行无写入命令，不强制一律使用独立副本（D-071） |
| 模型家族适配 | 一份基础 + 极薄 overlay；先做 Anthropic 与 OpenAI 两档，其他 provider 走通用 |
| Pi 上游 | 不贡献回上游；Pi 更新后重新适配。能 wrap 的 wrap（`read` / `edit` / `write` / `grep` 装饰 Pi 实现），只有 `bash` 重写 |
| 权限 | Varin 原生 `tool_call` 门是唯一交互式权限权威，覆盖 Harness、Pi 内置、MCP、Pi 包与嵌套线程工具；Host 只验身份/能力/规范路径，不弹窗。未知/证据不完整的第三方动作必须询问，不能靠工具名或 annotation 自授予；会话授权绑定规范化 source/action/workspace/resource 范围（9.1.2，D-283） |
| 知识库保留 | 可配置；默认按时间自动清理原始 `event` 与已结束会话的 `block`，`knowledge` 不按时间过期；删除会话级联删除其 event 与 block |
| 用户级记忆 | 存在但轻：独立 `user.tdb`，只放 `knowledge`，不放 event / block；写入需经审阅；在 Settings 中可见、可编辑、可审计 |

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

以下为当前生产形态；Rust 的已完成责任与证据见 4.3、plan 阶段 R 和 status。

```text
Application Host（packages/web/application-host）
  TS：产品策略、公开服务、Thread/Run、Documents/Registry 协调、LSP、知识/模型 adapter
      |
      | 私有生成协议（varin.kernel.v1）
      v
  Rust kernel：WorkingState/Recovery、文件/物化、PTY/受管进程、文件/结构计算
      ^
      | 类型化 worker→host 请求（@varin/protocol，requestId 关联）
      v
pi-host session worker（packages/pi-host）
  harness-tools.ts + 进程内 ExtensionFactory → Pi SDK（用户级或内置安装）
```

pi-host 已经通过 `customTools` 同名覆盖了 Pi 的 `write` / `edit`（恢复日志的 mutation boundary），
并以进程内 `ExtensionFactory` 挂载 `before_agent_start` 等钩子。工具仍沿这两个机制进入 Host，
不新增 Pi 包或 MCP 跳板。Rust kernel 是 Host 私有实现，不向 renderer/Pi 开第二端口；ACP agent 的 MCP 门面仍是后续交付，使用相同 Host 服务。

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
| 后台摘要准备 | 请求/步骤边界的容量检查 | 固定历史前缀与切点，沿当前 ModelRuntime 单次生成续接摘要；主会话继续，没有 memory_edit 或工具执行循环 |
| 异常容量压力 | 候选未就绪、失败、模型窗口缩小或新材料过大 | 复用在飞任务或同一摘要机制处理可容纳的旧前缀；保留新原文，不静默切回旧 keeper，也不忙循环重试 |
| 压缩后续接 | `session_compact` | 更新实际失去基线的观察游标与 UI 边界；不默认重注入最近文件、技能正文或整个状态面板 |
| 缓存断点 | `before_provider_request`（如需） | pi-ai 的 Anthropic provider 已在 system、tools、最后一条 user 消息设 `cache_control`；仅在 provider 缺失时补 |
| 轨迹采集 | `tool_execution_end`、`turn_end`、host 侧文档 / 终端 / LSP 事件 | 写入知识库，不进上下文 |
| 用户 `!cmd` | `user_bash` → 自定义 `operations` | 与 `bash` 工具共享同一 shell 监督器 |

### 4.2 已修复的前缀漂移与持续契约

`session-features.ts` 曾在 before_agent_start 把变化的目标 token 计数写进 systemPrompt；现已按 status 1.2 修复。
动态目标与运行状态使用尾部消息，不回改静态前缀。修改相关装配时运行现有 Zone 0 契约测试，不把已修缺陷重新列为前置任务。

### 4.3 Rust 系统内核（正式架构，D-252；D-282 完成）

内核是 Application Host 管理的私有子进程，沿同一生成协议服务 Electron/Web/远程，不向 renderer 或 Pi 扩展开放新端口。
它统一拥有实际文件资源、分支/对象/引用/恢复事务、物化和进程/PTY 后端，并承担固定视图文件搜索与结构计算。
TS 保留 Thread/Run 与模型策略、公开 API、知识领域、语言协议与 UI 投影；Pi 会话、凭据和扩展继续归原 worker。

恢复与 WorkingState 复用现有 SQLite/对象库模式，在同一存储位置的事务域中发布根/引用/operation，
不继续整份 JSON 加另一引用库的双权威。根成为真实读取/CAS/diff/pin 入口，节点增量持久化；
持久身份保留完整字段，平台磁盘比较不能改变哈希。文件外部写者与 surface 回执仍须按可观察事实恢复。

Document Registry 继续拥有未保存缓冲。混合操作在内核记录同一 operationId 的逐目标阶段，经 TS Documents adapter
调用真实 Registry 的修订检查与 grouped undo，不隐式保存、不建第二缓冲权威。Thread/Pi/知识的跨域清理按持久操作与幂等回执协调。

真实链路是 `Application Host → 私有 KernelClient → varin-kernel 子进程 → framed protocol → kernel SQLite/object store`；
Electron/Web/serve/云从自己的发行目录使用 manifest-verified executable，kernel 不监听公共端口。
R1–R5 已分别接管 immutable root/trie、blob/branch/revision/CAS/pin/Recovery/GC、文件资源与物化、PTY/pipe、固定视图搜索和
tree-sitter 结构计算。所有生产消费者走 root/path/domain/file/process/compute API；旧 TS writer 只保留为明确测试 helper，发行树会
审计并删掉不可达测试/旧实现。

D-282 完成 R0/R6：传输用 acknowledgement-backed request credits，取消可越过数据背压；release smoke 覆盖任意 cwd、安装目录替换、
同一 current-format catalog 重开、坏 manifest、固定 root、条件磁盘写与真实 shell 退出。受控 128/1024/4096 文件对照记录冷/热、
事件循环、RSS、节点和取消，既保留搜索收益，也如实记录 inventory/逐文件 structure 的额外成本。完整契约、数值与平台边界见
[rust-kernel-design.md](rust-kernel-design.md) 和 status。阶段 R 已完成，后续能力直接复用该边界。


## 模块专卷

原 §5–§9 已拆分为独立模块文档，标题与锚点不变：

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

本文档第 5–9 节即其规格。工作区形态：仓库；验证器：编辑后诊断、可选测试门、review 传感器；权限由 Varin 原生
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
  这是 [architecture.md](../architecture.md) 第 10 节既有的分离。
- **用户自有 Pi 是显式选项。** Runtime Manager 的 system / standalone / source / custom 来源保留在 Settings；选择的
  版本超出已测试范围时显示诊断，不阻止。
- **短滞后跟随上游。** 内置版本由与 `cloud-runtime.bun.lock` 相同的流水线更新，避免社区扩展要求的 Pi 版本高于内置
  版本。数据目录格式"旧读新"的风险由短滞后压缩窗口，由显式选项提供出口。

内置 Pi 不内置 Git Bash：Windows 上 `bash` 工具依赖 Git for Windows，Runtime Manager 的就绪检查必须包含它并给出
安装指引，否则"内置 runtime 开箱即用"在 Windows 上不成立。

当前 harness 的具体 Pi 版本依赖已经形成，bundled runtime 直接按阶段 4 交付，不再等待其他能力全部完成。

## 12. 交付顺序与待决问题

### 12.1 顺序

交付单位是用户可用的实际调用链。跨进程工具贯通协议、Host、worker 与实际请求验证；纯 UI 或存储按自己的调用链验证，不强制
走无关层。implemented / wired / proven / default-on 记录在 status。proven 的正式能力随交付默认提供，用户选择继续有效；
不再附加统一的回放批准阶段（D-078）。文件入口与验收要点见 plan。

P0、T1/T2/T3 核心和 D-076 已交付；工作状态/集成、默认记忆、窗口读取/explore 的具体进度见 status。
D-282 已完成 D-252 的阶段 R，后续外部 runtime 和新领域直接复用当前 Rust kernel/TS Host 边界。单会话配置与归因随相关能力完成，
T4、完整 RunManifest、知识数据库迁移或沙箱不作为共同前置。下面是总体范围，实际顺序按 plan 0.7。

0. **前置**：对齐 Pi 版本并在该版本上复核第 4.1 节的钩子形状（已完成，D-001：0.84.3）；恢复的 coverage 从计划级二值改为路径级（见
   [native-workspace-recovery-design.md](native-workspace-recovery-design.md) R1），否则 `bash` 注册为 `process`
   writer 后几乎每一轮都会被标为 incomplete，组合回滚在实践中消失。
1. **工具与 host 服务**：`harness-tools.ts`（`bash` / `grep` / `edit` / `write` 覆盖，`apply_patch`、`get_output` /
   `write_to_process` / `kill_shell`、`diagnostics`）、shell 监督器（按环境选解释器、PTY、login 会话 shell、自动转
   后台）、按路径的编辑锁、`tool_result` 层的通用句柄截断、worker→host 类型化请求、第 4.2 节违规修复、第 8.6 节计数器。
   `bash` 优先——在 Windows 上一天内可感。（`todo` 依赖 `block` 存储，随第 2 阶段交付。）
1b. **web**：`webfetch` / `websearch`、抓取服务（SSRF、提取、PDF 转文本、缓存、Electron 离屏渲染）、搜索 provider 抽象、
   来源面板。可与 2 并行。
2. **上下文层（D-284/D-286/D-287，已完成）**：真实请求前预算、缓存友好的后台摘要准备、固定切点提交与较长近期原文、
   当前/同 Thread 历史回读及 receipt-bound Zone 2 增量。`todo`、用户笔记、知识库与 suggestions 保持各自权威；持续 keeper 与三态接管已删除。
3. **检索与子 agent 层**：`explore` 管线（多路召回、当前原文读取、单元排序与一次呈现；按 D-173 收敛职责与调度）、
   `file` / `symbol` 节点与 LSP / Git 采集器、`related`、LSP 导航工具（`symbols` / `definition` /
   `references` / `hover`）；原生子会话 worker 运行时按**线程**形态（第 9.3 节）交付：host 持久化的线程注册表与状态机、
   worker 丢失恢复、host 观察的活性与循环检测、`dispatch` / `threads` / `wait` / `send` / `read_thread` / `kill`、角色目录
   与独立模型槽位、原生工作分支与按需物化、集成与回收、事件驱动等待、观察游标、线程侧栏与讨论线。D-285/D-287 已接通普通
   派发、task/inherit/continue/fresh、定向消息、分段成果与共享执行调度；自动 review 默认关闭，仅在用户显式启用后运行。
3b. **权限纵切（D-283，已完成）**：Host 静态授权与 scope、Varin 原生唯一 `tool_call` 门、规范化权限对象、session grant / audit、Settings 与 Smart；旧 permission-system 双轨已删除。
R. **Rust 系统内核与 Host 分层（D-252/D-282，已完成）**：R0–R6 已接管工作状态/恢复、磁盘/物化、进程/终端、文件/结构计算，
   并完成数据保留、取消/崩溃恢复、性能定标与发行矩阵接线。TS/Pi 保留上层职责；外部 runtime 和领域扩展沿此边界继续。
4. **默认 runtime**：内置钉住的 Pi。
5. **外部 agent**：host 服务的 MCP 门面、ACP host、能力协商；届时重新评估协议兼容策略。
6. **research profile**：复用已具备的工具/知识库/文档能力，直接建设文献采集、引用核验与 Shell 面，不等 1–3 全部长尾任务结束。

### 12.2 历史决定与实施选择

历史决定（后续修订以当前正文为准）：2026-09-02 的 edit v1 使用直接写盘 + reconcile，后续按 5.4/9.2.5b 实施版本化视图；
`varin serve` 检测到桌面 host 在运行时复用它而不起第二个（第 7.1 节）；子 agent worktree 由父 agent 的 `merge` 工具
合并、Git 面板可选审阅（第 9.2.5b 节）；`event` 默认保留 30 天（第 7.2.1 节）。

2026-09-04 的决定（D-030–D-038，其中默认和回放政策已由 D-078 修订）：Pi 0.84.3 消费 `session_before_compact` 返回的
`{ compaction }` 并跳过自身摘要，`session_compact` 随后触发且 `fromExtension: true`（D-022，前置实验结论，8.4.4 的提交复用此接缝）；
线程对象拆为 Thread + ThreadRun、状态正交（第 9.3.1 节）；wait 默认事件驱动、缓存保活可选
（第 9.2.6 节）；输出引用分 `OutputRef` / `TranscriptRef` 两级、偏移统一 UTF-8 字节（第 5.1 节）；权限三层与 Host 静态
授权（第 9.1.2 节）；设置按字段所有权（第 5.10 节）；D-081 曾交付记忆三态与默认 takeover，D-284 已确定替换目标但尚未改代码；父会话删除
时线程停下并归档、不弹第二个模态（第 9.3.4 节）。

**D-078 的交付政策保持**：正式能力完成后直接提供，不加回放门禁。上下文与线程的新默认分别按D-284–D-286；自动review改为
用户选择，不以“默认交付”推导必须常驻调用。以下列实施选择：

| 范围 | 已确定方向与实施选择 |
| --- | --- |
| Rust 内核 | D-252 已采用、D-282 已完成 R0–R6；完整契约与实际性能边界见 rust-kernel-design/status。生产只有 Rust 系统资源权威；修复后的 TS 路径只作为历史验收/性能 baseline 或显式测试 helper |
| 上下文续接 | D-284：活动请求配置派生摘要，容量临近时后台准备，前台继续，需空间才提交；原文保留随窗口缩放，history 回读；完整替换 keeper/coverage/三态与其消费者。当前实现仍见 status 的 D-081 行 |
| 工作状态与结果 | Host 原生内容对象/树/分支/Integration，Git 基线与物化可复用；独立引用、真实执行写回；旧内部格式按 D-253 直接替换，不建升级导入器 |
| RunManifest | Host 执行意图、runtime 解析模型/工具、Host 确认能力、worker 报实际装配；沿 launch 消费者收敛，不复制凭据权威 |
| 外部 runtime | 对实际 adapter 做版本和能力协商，不先解决全部未来版本兼容问题 |
| 本地 embedding | 按可部署模型与 runtime 选型，显式下载；远端和稀疏模式不等它 |
| 结构来源与语法包 | tree-sitter 作 Host 第二结构来源，wasm 版、接口先行、TS/TSX 首刀；常用语言随应用捆绑、其余按需下载（点安装即同意，Host 不自发网络，与本地 embedding 各走各的，D-124）；发布期清单自算 wasm 与查询摘要，运行期只按摘要装（D-125/D-128）；用户自带 wasm 过 ABI 闸门并标未验证（D-123）；语言 ≥ 3 时设置页（D-091） |
| TriviumDB | 优先保留；按实际版本核实无向量/文本查询，具体数据库问题交用户联系作者，不迁移 SQLite |
| Pi 接口缺口 | 钩子与 provider 能力按本机真实版本适配，缺可选能力仅影响对应路径 |
| explore 增强 | 确定性路径默认；已配槽位后按查询需要 intent/judge/修复，失败保留已有结果；反馈优化不另设研究门禁 |
| 缓存保活 | 用户可选的额外请求策略，直接实现实际 provider 路径，生命周期不依赖保活 |
| 批量修改 | 可沿 quickImplement 与相同 mutation 边界实现正则定位批改；按实际使用价值安排，不先造通用工作图 |

## 13. 与其他文档的关系

- [architecture.md](../architecture.md)：本文档扩展其第 4 节进程模型（新增 host 服务与 worker→host 请求族）与第 7
  节（harness 是 Varin 拥有的进程内扩展，不是 Pi 包适配器）。
- [rust-kernel-design.md](rust-kernel-design.md)：阶段 R 的最终资源归属、私有协议、存储与恢复、物化/进程/检索计算及发行性能契约。
- [composable-workbench.md](composable-workbench.md)：profile 对象在此扩展为同时承载 harness 绑定。
- [native-workspace-recovery-design.md](native-workspace-recovery-design.md)：`bash` 的 `process` writer 注册与
  `edit` / `write` 覆盖共存于同一 mutation boundary。
- [security.md](security.md)：知识库内容按工作区数据对待；`webfetch` 复用其私有网段阻断与 cookie opt-in 规则；worker
  不持有 host 凭据。
- [extension-compatibility.md](extension-compatibility.md)：第三方 Pi 扩展不受本契约约束，也不由 harness 管理；可继续通过普通 package
  surface 安装，但 package 存在不会让原生 web 工具或权限 owner 自动让位。

### D-224 补充：集成、级联与查询身份

集成撤销以当前父 authority 为准：virtual parent 在 `VirtualWriteGate` 内做 branch CAS；materialized parent
解析 execution directory 后经该 workspace 的 Documents resource gate，以 after→before 条件恢复。纯 disk、virtual
branch 与 branch→materialized 的撤销都先持久化 `undoing`，再执行条件变更并观察 before；branch→materialized 只有磁盘与
WorkingState branch cache 都同步到 before 后才写 `undone`，启动对账能区分仍是 after、已经 before 与未知状态。父 gate
返回后重新读取 authority；物化目录已回收时，WorkingBranch 重新成为读写真相。

级联准入由 ThreadRegistry 持有。cascade 进入 registry mutation tail 后，目标 Thread 子树的新 create/dispatch/start/restore
按父与祖先的 archived/cascading 状态拒绝；dispatch 准备期间若准入失效，会清理 surface draft。尚未进入 lifecycle 的失败
Thread 可删除，已经被 cascade 接管的 Thread 由该生命周期归档，准备失败路径不得同时删除。session
bindings 是一次启动重建的派生索引，按当前 `thread.activeRunId` 的 Run/session 建立，并按 sessionId 与 threadId 去重；坏
索引可覆盖重建，坏 workspace catalog 不遮蔽健康 catalog，历史 session 不回落为 root owner。

带 `workBranchId` 的默认 merge 只消费当前 settled Run 成功发布的 native resultRevision；遗留 `resultCommit` 只用于没有
WorkingBranch 的导入。新 Run 把上一 revision 记为 `inputRevision` 后立即撤下默认指针；目录 inspect 或 native publish
失败也都会在独立 Git snapshot 前清除默认 revision 并保留
needs-attention/conflict；snapshot 失败也不能让旧 revision 复活。Git baseline 捕获前后重列冻结
`captureScopes` 并比较路径和内容身份；explore pin 接收 effective authorized roots 与同一 signal/deadline，只固定授权范围。
默认新文件 mode 的合法 0 保持不变。上述实现与证据记录在 D-224；3.4、3.4a、3.6 仍按真实桌面重启和付费嵌套 Pi 的未测范围保持 Partial。
