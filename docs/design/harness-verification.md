# Agent harness — 验证与多 agent

Status: 模块专卷，自 [agent-harness.md](agent-harness.md) 拆出（原文第 验证 节起）；本文保留原节标题层级与锚点。
交付事实见 [../status.md](../status.md)，计划骨架见 [../plan/agent-harness-plan.md](../plan/agent-harness-plan.md)。

## 9. 验证与多 agent

### 9.1 传感器优先于指南

指南预测模型会错在哪；传感器在错了之后抓住它，且不随模型进步而腐烂。code profile 的传感器：编辑后诊断（第
5.4 节）、可选的 turn-end 测试门（profile 声明测试命令，失败结果作为 post-tool 反馈注入而非阻断）、危险命令
前置拦截（`tool_call` → `block`，profile 提供规则）。

### 9.1.1 OS 沙箱（后续阶段）

OS 隔离与工具权限保护不同对象。仅隔离 shell 进程树，不能约束仍在普通 worker 内执行的文件工具或第三方扩展。
macOS/Linux 可作为后续平台候选；用户已决定不建设 Windows 沙箱（D-071），它不是当前 Windows 交付阻塞。
这不是没有技术路线：[OpenAI 公开实现](https://openai.com/index/building-codex-windows-sandbox/)使用专用用户、受限 token、ACL 与防火墙，
也需要管理员安装和兼容性维护。当前 Varin 继续准确说明实际的工具权限、Host 身份/路径授权及其未覆盖的同用户进程访问。

### 9.1.2 权限管理：Varin 原生唯一交互门（D-283）

Varin 内置 pi-host `tool_call` extension 是当前唯一的用户确认权威。它覆盖 Harness override、Pi built-in、MCP、普通 Pi package
以及嵌套 Thread 会话里实际注册的工具，不再把未知工具 pass-through 给第二套权限系统。来源身份取自 Pi 活跃 registry 的
`getAllTools().sourceInfo`：只有 Varin SDK Harness override 才按 `HARNESS_TOOL_META` 分类；MCP/package/unknown 缺明确副作用证据时
动作归为 unknown 并询问，不能因为工具恰好叫 `read`、声明 annotation 或说明文字像只读就自动获得权限。

权限对象包含实际 cwd、source/action、候选路径、网络 origin 与 thread scope。路径在提示前通过 Host `permission.inspect` 走与其他
Harness 服务相同的 actor/capability/workspace canonical path authority；Host inspect 失败、组合 shell/sub-shell 等无法完整提取的命令、
未知第三方动作都标为 evidence incomplete，因此不能走 Smart 自动放行或 remembered session grant。当前 shell 证据提取是保守边界，
不是完整 shell 解释器：无法证明完整时询问，而不是靠 regex 猜安全。高风险模式仍覆盖危险命令、Git 变更、包管理器变更与敏感路径。

`normal` / `accept-edits` / `bypass` / `smart` 和用户规则都在同一个 gate 内解析；trusted workspace 仍只能收紧规则。Smart 只有在用户
配置 `models.permissionJudge` 时处理普通、完整、非高风险 ask；模型失败回到 ask，不借主模型。"Allow for this session" 的 key 包含
工具来源、动作、owning/execution workspace、cwd、Host canonical resource IDs、网络目标和 thread scope；未知/高风险/不完整证据不能
记忆。用户可通过 `/varin-permissions` 查看/撤销该会话记忆授权。每次 allow/deny/remember 通过 `permission.audit` 投影
credential/body-free 目标，不新建 permission 数据库，也不把审计正文放进模型上下文。

`@gotgenes/pi-permission-system` 的 foundational provision、session service yield、Varin Plugin Settings/Composer/quick mode/status bridge
已删除；D-044 只保留为历史共存记录。用户仍可通过 Pi 的普通 package surface 自行安装第三方扩展，但第三方 `tool_call` 仍经过
Varin 原生门，不能替换或绕过它。

**三层，不寻找唯一安全边界**（D-035）：

1. **Pi `tool_call` 门**：Varin 原生 gate 做 allow / ask / deny 与确认 UI，并对 worker 内直接执行的内置/扩展工具统一生效。
   `ask` 走现有 `ui.select`（Allow once / Allow for this session scope / Deny）；取消/关闭视为 deny。它不能成为 OS 隔离，但能在工具
   入口阻断 `edit` / `write` / `apply_patch`、MCP/package mutation 与进程工具。
2. **Host 服务授权**：不弹窗、不重算用户策略，只验证 `ActorContext`、RunManifest 里的静态能力集、workspace / path 包含，
   覆盖一切经 host 中介的能力（`shell.*` / `output.*` / `search.*` / `document.readSource` / `thread.*` / `fs.lock` / `lsp.*`）。能力按会话实际冻结的
   `activeTools` 推导：只有没有任何 `bash` 工具时才不含 `process.shell`；关闭 Varin 的同名覆盖若会回退到 Pi 内置 bash，
   仍然具有 process 能力。缺少该能力时绕过工具直接到达的 `shell.exec` 必须被拒——这不是第二套用户策略，是防止
   绕过工具入口。按风险类别授权：`read`（document / search / output / lsp）、`process`（shell）、`control`（thread send / kill /
   merge）、`write`（未来经 host 中介的文档写入）。
3. **OS 沙箱**（第 9.1.1 节）：限制 worker 绕过工具直接访问文件与网络。当前不具备。

`ThreadLaunchManifest.scope` 是任务范围，同时对 Host 能解析出具体路径的服务形成强约束：`search.content` 的返回项、固定来源
`read`、LSP 路径、`fs.lock` 路径与显式 `shell.exec.cwd` 都必须落在 scope 内。规范化只拒绝完整的 `..` 段、绝对路径和盘符路径，
不把 `src/foo..bar` 或 `version...txt` 当成穿越（D-223）。它**不是文件系统沙箱**：shell 命令文本内部可以
改变目录或访问其他路径；Host 未提供固定来源或用户关闭覆盖时，Pi 内置 `read` 也仍在 worker 内直接执行。隔离 worktree 把写入副本与父工作区分开，但只有未来的 OS containment 才能约束
同用户进程能读写的全部路径。

**威胁模型**：worker 是 host 自己 spawn 的、同一 OS 用户的子进程，本来就拥有整个文件系统；第二层防的是**跨会话串线、
陈旧 worker 污染当前会话、第三方 Pi 扩展借 host 能力越权**，不是防同权限下完全恶意的 worker——后者只有第三层能防。

**身份**：`ActorContext { authorityInstanceId, sessionId, runId, workerId, workerGeneration, workspaceId, grantedCapabilities }`
只能由 broker 信封与 host 注册表生成，请求载荷里不再有 `sessionId`。broker 在 `session.open` / `session.create` 的方法
响应成功后 pin 住 `{ sessionId, workerGeneration }`；worker 自己发出的 `session.snapshot` 只能验证与更新状态，不能重绑
身份，不一致视为协议违规；`session.closed` 不能仅凭 worker 自报清空 pin；未 pin 的 worker 发出的 harness 请求一律拒绝。
RunManifest 落地前，host 从 broker 验证后的首次 `session.snapshot.activeTools` 与 Host 实际服务可用性推导能力集并随会话
注册冻结；它不二次读取可能已变化的设置。RunManifest 落地后收敛为显式单一来源。

**第一层的判定顺序**（真值表，实现必须与之一致）：

| 规则匹配 | 高风险类别 | 本会话已授权 | 结果 |
| --- | --- | --- | --- |
| deny | — | — | 阻断 |
| allow（含 bypass 模式、用户显式 allow 规则） | — | — | 放行 |
| ask | 否 | 是 | 放行 |
| ask | 否 | 否 | 弹窗；选 "Allow for this session" 记入本会话授权 |
| ask | 是 | 任意 | 弹窗；"Allow for this session" **不**记入——高风险每次都问 |

高风险类别：`bash` / `write_to_process` 的命令匹配 `rm | sudo | chmod | chown | mkfs | dd`、`git push | reset | checkout |
rebase | clean`、包管理安装 / 卸载、路径含 `.env | id_rsa | .ssh`；`write` / `edit` / `apply_patch` 的路径含
`.env | id_rsa | .ssh`。`bypass` 是用户说"别再问我"，高风险在 bypass 下同样放行。工作区提供的 regex 规则须有 ReDoS
防护（配置长度上限，并在构造 `RegExp` 前拒绝反向引用、lookaround、嵌套量词和量词包裹的分支），工作区只能收紧不能放宽
（第 5.10 节）。

### 9.2 多 agent：持续工作的主线与按任务展开的线程（D-285）

主线是能调查、设计、实现和验收的正常 agent。独立工作值得展开时才委派；共享接口未确定就先解决真实依赖，已经明确就
直接并行，不先设 planner/manager 层，不要求模型规划完整 DAG。主线负责整体取舍、关键验收和最终交付，也亲自推进重要
实现；没有独立工作时等待结果，不重复调查制造忙碌。

多一条执行过程可以缩短等待、并行尝试不同解法，或使用适合任务的模型/工具。可以用费用换速度或探索广度，不把省 token
当作唯一成功标准。批量读取、已知命令和机械转换优先用普通工具并行；需要独立判断和行动过程时再开线程。每条会话独立
使用第 8 节的上下文机制，多 agent 不替代压缩，也不因上下文长而被强制使用。

#### 9.2.1 原生运行时与工作身份

Thread 表示一件可继续的工作，Run 表示一次执行；broker/Pi 提供实际会话和模型调用，Host 持有关系、准入、消息和结果投影，
Rust WorkingState/Integration 保持文件与结果权威。任务身份不会因从调查进入实现而变化；模型、工具、权限和输入来源在
每次 Run 中解析并冻结，上一 Run 的真实配置与结果留存。

复用 Thread 不强制复用全部旧对话。新线程可以接收简洁任务背景或继承当前可用输入；已有线程可以沿用上下文，也可以保留
成果而重新建立输入（8.4.7、9.3.2）。工作区选择、上下文选择与执行预设分别表达；清上下文不清工作分支，发消息不更新代码。
不自动让支线取代用户正在进行的主线，用户点开支线仅改变其当前查看和交流的位置。

#### 9.2.2 普通派发与可选执行预设

模型可见接口为 `dispatch(task, { input?, preset?, scope?, worktree? })`；`task`/`preset`/`input`/`scope`/`worktree`已是
当前协议参数（`input`取`task|inherit`，`worktree`仅接受显式`shared`）。
普通派发不要求 role：默认简洁任务背景、明确继承发起者当前模型和已获准的普通工作能力，写入任务默认独立 WorkingState，
需要 shell/LSP 等真实路径时才物化。shared 是明确需要共同现场时的执行选择，不因“任务简单”或某预设名称而默认共享。

预设只是解析执行配置的快捷方式，不是线程的永久职业。预设说明任务方法与产出，不把用户任意选择的模型永久称为便宜或强。
保留现有模型槽位与用户配置；预设可明确声明使用当前模型，未绑定且未声明继承的专用槽位保持不可用，不静默借主模型。
普通线程本身的模型继承是明确默认，不冒充已配置专用能力。

设置中的 Agents 列表同时管理这些内置预设、科研能力和用户自定义定义。用户自定义 Agent 保存在
`harness.agents.<id>`，通过 `preset: "custom:<id>"` 沿同一 Thread/Run 路径派发；Host 在受理时读取当前定义，
解析工具、指令、工作区与模型并冻结到 Run。自定义定义没有专用模型时沿用发起者当时的模型，
而不是会话启动时缓存的模型。关闭保留配置，但阻止新的角色派发；科研能力切换也不能通过 `model: "inherit"`
绕过开关。已经受理的工作及其重试保留原配置。目录按工作侧重筛选，插件 Agent 的执行与配置仍由插件拥有。

内置 quick-implement、hard-implement、frontend 适用于通用侧重；四项科研能力适用于科研侧重；
review、check、retrieval 为两边共用，自定义定义按其 `workFocus` 生效（空数组表示共用）。
模型可见的派发参数、自动生成的团队说明与实际派发使用同一启用状态和模式范围。
切换侧重、关闭角色或修改定义后，在运行边界刷新参数和系统提示词；已关闭或不适用的角色不列为可用选项。
设置管理目录继续显示关闭项以便编辑和重新启用；用户自写提示词及历史消息不自动改写。

| 可选预设 | 主要用途与工具形状 | 模型来源 |
| --- | --- | --- |
| quick-implement | 已有模式下的实现、局部设计与相关验证；能力边界按任务配置，不强制 shared | models.quickImplement |
| hard-implement | 需要深入推理或跨层协调的实现 | models.hardImplement，可明确继承当前模型 |
| frontend | 界面设计、实现与可用的预览工具 | models.frontend |
| retrieval | 较长事实追踪，读取/检索/授权 web 与可选 submit_facts；无写入和 shell | models.retrievalAgent，未配不可用 |
| review | 对实际成果作独立审查，给具体发现和来源 | models.review，可明确继承当前模型 |
| check | 任务所需的验证与事实核对；执行命令可能写生成物，不称只读 | models.check |

上表记录当前预设。D-315 / 阶段 L 沿同一 retrieval Thread 支持自然语言报告及可选结构化 facts；当前已补上 `research_search`
的学术发现工具，通信、关系、结构阅读与材料复用仍按计划推进。保留来源、scope、Run 和耐久引用的核对，不能只改提示。

工具选择、scope、文件工作状态和权限由 Host 校验并落实到 Run。把预设改成可选不能撤掉真实 allowlist、路径与权限边界。
只读任务转实现时留在同一 Thread，在新 Run 确定获准的写能力；不凭消息里的“开始写”放大权限。允许嵌套的普通执行配置与
预设使用相同调度和父权限继承规则，不把“能派发”永久限在两个角色名上。retrieval 的专门事实协议和干净背景预设继续有效。

#### 9.2.3 验收与可选 review

实施者完成与改动相关的正常验证，主线承担全局理解、关键审查与集成判断。按实际价值安排独立 review/check，不要求每个
worker 结果都经过额外模型，更不设置固定的审查—核验—裁决链。运行命令本身无需包成新 agent。

D-285 将自动 review 默认改为关闭；用户已有明确 enabled/gate 选择保持有效。主动派出的 review 和用户开启的自动 review
仍复用当前 resultRevision + reviewThreadId + reviewRunId 绑定、失败/取消与迟到结果处理，通常使用简洁任务和固定 diff，
不默认继承主线推理。是否独立判断由任务需要决定，不能用一句“独立”代替提供成果、契约和验收依据。
后台摘要是 D-284 的单次模型请求，reader 是其已有能力，两者不因此成为常驻团队或每次交付的附加步骤。

#### 9.2.4 按成果与依赖委派

任务说明用清楚的自然语言交代要完成什么、已有材料和需要交出的成果，不强制表格，也不要求先列完整工作图。共享类型、
存储归属等公共决定先明确，再把能独立推进的部分展开；边界清楚的线程可自主定位和实现。等待时由运行时订阅，不通过
定时推理询问“好了没有”。模型可以选择不同实现路线并行探索，得到足够结果后停止不再需要的工作。

已有工作相关且上下文仍适用，优先原线程续做；工作延续但背景大半过期，原线程 fresh；无关任务建新线程。选择依据是任务
关联和当前输入的价值，不以缓存命中、线程寿命或固定调用次数决定，不为此添加新鲜度评分模型。

并发预算是调度参数，不是目标人数。默认沿用用户可调的12个委派执行名额，在同一根任务的嵌套树中共享；等待子任务的父
让出执行名额，收到所等结果后重新准入。会话仍可保留，后台进程/文件写者的真实占用也仍存在，不能把让出执行名额当成
进程退出或目录可回收。恢复、续做、自动 review 与嵌套派发走同一准入，不按每个父节点再复制一份预算。不同根任务保持
各自配置，Host/provider 的实际资源限制另按既有机制处理，不顺手增加全工作区硬上限。

用户可要求特定预设派发前确认，默认不启用；沿原生权限门处理，不要求模型提交成本估算。既有用量应区分主/子实际调用，
不只看主线变短就宣称总成本下降，也不增加多 agent 财务面板。

#### 9.2.5 定向消息与成果流

以下记录 D-285/D-287 已实施的消息语义；D-300 对公开交互的下一阶段调整见 9.2.5a，尚未接线。

责任关系仍是父子树，通信允许同一根任务内已授权的子问父、父指导子、相关兄弟定向交流。复用 `send(to, message, { kind })`，
发送者身份由 Host actor 解析，不允许模型自报为 user/parent 或仅凭可猜测 threadId 跨任务发送。可交流不授予读取对方全部
转录、改权限、取消或合并兄弟成果的权利；这些仍走各自授权入口。普通 UI 活动不自动广播到其他上下文。

| kind / 材料 | 运行行为 |
| --- | --- |
| 普通进度 | 留在 Thread/UI 活动，不另发消息唤醒模型 |
| inform | 持有并在接收者下一正常输入边界追加，不单独发起执行；若 replyTo/结果明确满足已有等待，则按该等待恢复一次 |
| request | 需要回答、行动或继续执行；接收者正在工作时到下一正常边界交付，等待中可唤醒，settled 线程按 9.3.2 新开 Run |

模型/调用者显式选择信息或请求，运行时不靠“谢谢”正则或另一个 LLM 判断是否执行。答复用 replyTo 关联实际请求，完成等待
不需要再发一个“请读取答案”的执行任务；没有待处理依赖的确认/致谢不继续唤醒。消息包含实际来源、目标和相关工作/结果
引用，沿既有 Host 会话投递路径记录接受与送达，重试不能多起一次执行。accepted 不等于对方已读或完成；失联、归档、删除
分别返回实际状态，普通通知不能静默复活已取消/归档的工作。正在排队的执行请求不因进程未启动被当作已丢失或已执行。

兄弟可以自行确认局部问题；改变公共契约、任务边界或最终使用方式时，把决定和相关产物回告主线，不把全部横向对话灌回去。
root/parent 能读取实际问题与结论，用户仍可进入支线纠正。收到对方材料是信息来源，不自动成为更高优先级指令。

成果沿其真实类型交付：小问题直接给充分答案，大文件/表格/报告给用途、完成范围和读取入口，代码交付固定结果修订。
不要求主线把子成果重新实现，不统一压成很小的摘要，也不只给裸句柄。第一版分阶段交付复用 Run 结束/结果发布：发布R1，
父接入，再让同一Thread续做R2；R2进行中R1仍可按修订读取与使用。普通发现可提前发消息，文件变化必须实际发布与集成。

#### 9.2.5a 自然语言交流与可选等待（D-300，待实施）

通用多 Agent 交互沿同一消息账本演进为“发给谁、说什么、是否等待”。目标用法为 `send(to, message, wait=0)`：
0 立即返回耐久投递回执；正值表示最多等待相应秒数，关联答复到达即返回，超时只结束等待，不取消消息或对方工作。
可用同一 messageId 继续 `wait` 或 `read_thread`；不能为继续等待重复发问题。

不等待仍可向对方提出任务或问题。公开发送不要求每次选择 inform/request，也不要求“发现、影响、依据、替代解释、下一步”字段。
身份、幂等和回复关联由 Host 沿实际投递上下文记录；并存多个问题时可用短消息引用消除歧义，不把任意新消息当作所等回复。
实施时替换被调整的公开 schema 与消费者，不长期保留两套通信 API；内部通知仍可记录为无需发起执行的信息。

父子、兄弟和同组已授权分支可直接讨论，Thread 树继续负责生命周期。消息不授予全文、文件、合并或取消权限。
运行中的接收方在安全输入切点收件；等待中的目标可处理定向来信；空闲且可继续的目标沿既有准入建立新 Run。
归档/删除/不可继续状态明确返回，不隐式复活。等待让出模型名额且不持有生命周期锁，答复先到、同时互问与重连均不能丢信或重复启动。

状态变化只维护可读取事实。模型执行由用户或 Agent 的明确交流、已有 wait/订阅续接，Host 不根据异常、产物或关键词
判定“值得叫强模型综合”；也不自动为每个回复生成确认和再次唤醒。内容的重要性与下一步由阅读材料的 Agent 判断。
详细交互与验收见 [plan 7.5](../plan/agent-harness-plan.md#75-自然语言消息等待与唤醒)。

#### 9.2.5b 工作分支、按需物化与版本化集成（正式架构，D-078）

**工作状态独立于目录。** Application Host 的 Rust kernel 拥有内容寻址的工作状态存储：文件按字节哈希存为不可变对象，目录树引用路径状态，
工作分支引用一个固定基线与自身修改，发布新修订时原子切换分支头。Thread 关联工作分支，ThreadRun 关联本次输入修订及执行目录；
结果是不可变修订，目录是执行载体。需要保留的修改收回持久状态之前，目录不能视为可丢弃缓存。

**D-282 的当前实现：** 本节用户行为继续有效；存储/分支 gate/磁盘操作的最终执行者是 Host 的 Rust kernel。
生产调用使用不可变 root/path/domain、file-resource 与 materialization API，不展开持久全树或打开 TS recovery SQLite。
Thread catalog、Pi 会话和 Registry 保持各自所有权，见 4.3 与 Rust 设计。

| 对象 | 所有权与用途 |
| --- | --- |
| 内容对象 / 路径状态 | Host 存字节与哈希；路径状态复用 missing、file+mode、directory、symlink 原始目标、unsupported 的恢复模型，保留编码与换行；文本/二进制用于合并策略 |
| 工作树 / 工作分支 | 固定 baseState、按路径的 delta/tombstone、单调 revision、草稿路径与显式 captureScopes；目录节点采用 Merkle 结构共享，旧修订不变 |
| 物化记录 | branchId、输入 revision、实际路径、已收集 revision、运行者与未收集改动、环境准备状态、占用；同一分支写入按世代协调 |
| 结果 / 验证记录 | resultRevision、可读取正文的引用、变更路径与来源；验证记录保存 actor/Run/binding generation、观察边界输入身份、命令、cwd、退出与输出引用，运行中输入变了须说明 |
| Integration | 选定子结果、父相关路径/草稿的期望状态、逐路径计划和实际 before/after、冲突、暂存区影响与恢复操作引用 |

这是正式实施目标，不以第二个消费者或独立评测为前置。对象名称是领域责任，不要求每一行另建数据库或服务。Thread/ThreadRun
仍归现有原子 catalog，Pi 对话仍归 SessionManager，Document Registry 仍拥有窗口可变草稿，知识库仍用 TriviumDB。

**基线捕获与读取。** fork 捕获磁盘基线，并叠加发起消息窗口的版本化草稿；没有 surface 的任务读取磁盘。草稿来源自动传递，
不增加用户绑定操作。已知有草稿却拿不到正文时列出缺失路径，不把磁盘称为该窗口版本。基线发布后 read、grep、枚举、explore
读取同一 baseState 加分支 delta；父后来新增、删除或修改的文件不自动进入子分支，更新基线是一次显式记录的新修订。

当前 `thread.dispatch` 纵切在创建 Thread 前同步把固定草稿正文、编码/BOM、原换行和 surface/disk 修订来源复制进 WorkingState；
`ThreadLaunchManifest.draftBaselineId` 只持久化 Host 对象身份，不进入模型参数。带草稿的角色统一使用 isolated worktree。
隔离 dispatch 在创建 Thread 之后、返回之前（含 queued）固定非草稿磁盘基线并创建 WorkingBranch revision 0（D-214）。
Git 工作区固定 HEAD/tree 身份，并捕获 staged、unstaged、tracked mode、已删除与非忽略 untracked 的工作目录字节；
ignored 默认不进，显式 `copyIgnored`/`captureScopes` 必须进入。非 Git 与 unborn 在同一边界做一次可取消、有进度的目录捕获。
Git 命令失败、捕获窗口内父写入、活跃 Documents writer，或 gitlink/unsupported，都不得生成完整分支（D-218）。
捕获失败或取消删除该 Thread，不留下宣称完整的分支。父之后的新增、修改、删除、checkout 或提交不能改变子基线。
新虚拟 regular-file 在形成结果前写入工作区真实默认 mode；apply 与条件补偿按全字段 `sameState` 比较。
同名 `read` / `grep` / `find` / `ls` / `explore` 经 Host 分支视图读取该 base 加 delta/tombstone，provenance 标明
branch/base/delta；父 live 目录与 scratch/worktree 磁盘不能补读未改路径。隔离 Run 从虚拟 scratch 启动；同名
`edit` / `write` / `apply_patch` 把文本变更提交到同一 WorkingState delta，不写父目录（D-213 / D-217）。只有 `bash` 或
LSP 导航（`symbols` / `definition` / `references` / `hover`）首次需要真实路径时，Host 冻结当前 `writeRevision`、等在飞虚拟
写入结束、物化该修订并原子切换整个 Run；此后本 Run 的文件工具都走该目录，结算再把目录变化收回新结果。
切换失败或调用方取消后重读 execution view：仍是 virtual 则继续写分支，不得把 scratch 当权威。崩溃按
`materializationSwitch` 恢复到一个权威视图。read/grep/explore 返回的 revision 等于实际读取的 `writeRevision`。
Git blob 与工作目录转换后的字节不能无条件视为相同；当前基线读取实际输入字节。
具备角色目录嵌套工具的子线程经真实 tool registry 与 `control.thread` 能力调用 `dispatch` / `threads` / `wait` /
`send` / `read_thread` / `merge` / `kill`；Host 把 caller 解析为 `parent.kind: "thread"`，scope 与权限只能继承或收窄
（D-215）。owning workspace 保存 catalog / WorkingState / 父子关系；execution workspace 只覆盖 scratch 或物化目录的
Documents、LSP、路径与 shell（D-216）。子会话注册、thread services、Zone 2、lost resume 和 knowledge/recall/suggestions
从 Host session binding 读取 owning workspace；binding 是 catalog/run 的可重建索引，启动对账并在每次解析时核对
owning/thread/run/session，owner 缺失或 stale 必须拒绝（D-222）。嵌套隔离基线复制父分支有效视图，不扫父 live 盘；孙结果先集成到父分支或父物化目录，再由父结果进入根工作区。
每条受管目录记录持久化绝对 `managedRoot`。inspect、snapshot、materialize、setup、Git attach、reclaim/discard 在访问主路径及
staging/backup/result 邻接路径前，先验证 canonical containment，再要求 Application Host 或 create-worktree backend 重新授权根；
持久记录不能自证删除权。虚拟 scratch 默认在 Application Host 数据目录的 `thread-scratch/<workspace-hash>/<threadId>`，不借父工作区
目录充当执行路径。旧记录缺 managedRoot 时停止自动动作并报告恢复需求（D-231）。
Git 物化使用 `git worktree add --detach`（会写 `.git/worktrees`，不创建用户可见分支）或独立 `git init`，子 Git 命令不得发现或修改父仓库。
`worktree.base` / 分支 `baseRef` 仍是父状态身份；inspect/snapshot/settle 使用执行仓库可解析的 `executionBaseline`（D-220）。
reclaim 清除该执行 SHA；rematerialize 只从父仓库导出父仓库能解析的 commit。结算目录结果并入当前虚拟 delta，避免独立 init
把虚拟写吃进执行基线后丢掉。WorkingBranch 普通读取在取得 store lease 后重取当前 view；一次 explore 查询在同一 lease 内
复制 immutable snapshot，词法/结构/语义/原文都消费它。新文件默认 mode 按 umask 计算，不在用户树写探测文件。
捕获窗口 fingerprint 含 dirty/untracked 内容身份，路径集合不变但正文被替换时拒绝混合基线。
嵌套 merge 先取得父分支写入/切换权威，再决定 branch 或 directory authority，再打开对应 store/目录，不得持有
WorkingState exclusive lease 后再等 `VirtualWriteGate`（D-221）。branch Integration 先持久化 applying intent、before/after
与 retry identity，再 CAS 父 branch，再写 complete；启动对账按当前 revision/切片补 aborted、complete 或 needs-attention。
`runWhenVirtual` 按 gate、切换结束和取消信号等待或改走 disk。
directory 恢复写物化父目录走 execution Documents gate，对象库仍在 owning root；无法解析则 needs-attention（D-222）。
queued dequeue 把 `thread.manifest.permissions` 送进 `session.create`，live bypass 不能放宽冻结 overlay。
父 kill/archive 按稳定后序进入每个后代自己的 lifecycle serialization，不得持有父锁再等子锁；后代 restore/reclaim/merge 与级联并发时不能留下活跃 Run、半归档或在已归档祖先下复活（D-223）。
`scope` 只拒绝完整 `..` 段、绝对路径和盘符路径；`src/foo..bar`、`version...txt` 这类相对名必须接受。
父子树继续确定工作归属，兄弟可按9.2.5定向通信；根上下文不自动复制孙对话正文。不加深度配额，同根嵌套共享执行调度。

`harness.worktree.copyIgnored` 在首次准备后规范化为 WorkingBranch 的持久 `captureScopes`（schema 3）。窄结果发布只枚举这些
显式文件/目录根、其基线后代与当前后代，捕获新增、修改和删除；不会因此重新扫描整个工作区。重启、partial publish、reclaim 和
materialize 使用同一冻结范围，Git 是否忽略该路径不再决定结果是否保存。

Git 后端提供 staged/unstaged/untracked、filter/EOL、index mode 与 execution baseline 语义；文件正文由 kernel `file.scan/capture`
从工具实际看到的工作目录固定。非 Git、尚无首次 commit 的目录走同一捕获。kernel `file.materialize` 从不可变 root 构建 staging，
Linux 尝试 FICLONE、macOS 尝试 `clonefile`，不支持时正式 copy，并返回真实 backend；Windows 当前实测为 copy，不伪报 extent sharing。
初次发现/捕获文件有真实成本，单文件哈希随字节数增长，Merkle 只减少重复树结构；O(1) 只适用于引用已就绪不可变 root。
当前 v10 catalog 由 Rust 持久化 AVL/Merkle 节点、branch/revision/pin 与完整 mode 身份；单路径 CAS 只更新树深相关节点，
不复制整个平表。旧 schema、TS JSON writer 与升级 importer 都不在生产链。
文件监视器提供失效信号，不是完整事务日志；并发外部修改导致捕获不稳定时重读相关路径或报告不完整，不宣称跨文件瞬时一致。
基线采集属于创建/更新分支的工作，不进入普通消息、每轮恢复或每次查询的全仓扫描。Git 的过滤器、LFS 与换行转换由适配层处理，
记录实际工具所见版本，不能把仓库 blob 与物化字节无条件当成相同。（D-254：不再从 commit blob 重放 filter/LFS。
dispatch 捕获已物化给工具的实际 base 字节；settle 先固定 snapshot，再从其真实文件字节发布并在提交 catalog 前复核身份，
因此不会执行自定义 filter 或访问 LFS 网络。Git index mode 只补 Windows 无法观察的 100644/100755，并进入捕获指纹。）

**受控工具与真实执行。** 无目录分支让同名 read/grep/find/ls/edit/write/apply_patch 通过 Host 分支视图工作，保持 schema 与真实
路径授权；不在 live 父目录上搜完只覆盖 child delta。Pi 原生工具、LSP、第三方扩展或 shell 需要真实路径时先物化，所有参与该 Run
的文件工具随执行世代切到同一目录。此时普通命令可按现有权限写源码、快照与生成物；Host 收集这些修改并发布结果修订，不能让
Branch 和目录同时各自接受不相容的写入。shared 模式是有意的实时共享，与虚拟隔离分支不同。

命令返回、后台 shell 退出、Run 结算与重开时收集变化；工具 journal、目录变化记录和后端 diff 一起确定需要读取的路径。发生遗漏
或重启时按后端状态对账，必要时在该物化目录捕获差异；未确认收集完成就保留目录并显示原因。验证观察在命令 start/end 固定
authority/session/worker generation/Run 与 binding generation。Git 输入身份用不可变 base/HEAD 加 staged、unstaged、tracked mode、
非忽略 untracked 的变化路径状态；子分支再含固定草稿和显式 captureScopes。只有 start/end/publish 身份一致的同 Run 命令才能绑定
结果修订，不做每命令全目录扫描。非 Git 在没有便宜固定身份时标 uncertain。格式化、生成源码或后台写入产生新修订，不自动继承旧修订的验证结论。
相关流程直接实现并用故障测试验证，不另建研究门槛（D-210）。

**存储与保留。** kernel 的内容寻址对象、流式捕获、路径状态与条件补偿为工作分支、结果、集成提供独立引用所有者。
恢复历史清理、恢复插件关闭/更换不得删除仍由线程引用的对象；线程删除释放自身引用，只有没有任何所有者的对象才能清理。
用户可以从线程面板释放选定的旧结果版本（D-239）。当前 branch head、Thread 默认结果、active/lost Run 输入、活动 review 和
未结束或冲突 Integration 的输入仍保留；释放旧结果不删除当前分支、报告和转录。已完成 Integration 独立持有 safety/target，
其撤销不依赖原 WorkingResult。版本引用字节包含共享对象，界面只把对象实际删除后的字节报告为本次回收量。

释放绑定 branchId 与 resultRevisions，在 Thread lifecycle、存储独占 lease 和 Registry 快照序列化内重核依赖；任一选中版本
仍在使用时整批拒绝。先持久化版本目录删除，再释放引用和回收无所有者对象；失败分别报告逻辑移除与清理未完成，可用原请求重试。
对象先 flush/安装，SQLite 事务再发布 root/record/reference；result release、pin 与 GC 在同一 Rust 权威下按可达性处理。
启动及显式释放按实际记录对账；缺失或损坏的节点/对象不能被解释为空集。没有新增保留天数、自动删除线程或全仓扫描。

正常的存储位置转移须同时复制新格式对象及引用，不能仅复制 hash。固定 Git resultCommit 可以作为正常导入来源；
这些能力不要求维护旧 Varin 库升级路径。当前内部格式替换按 D-253 直接重建并删除旧写入权威，Git 保留基线/物化/导出职责。

**集成选定结果。** merge 默认选择已发布的最新结果，并把选定 revision 写入操作；调用方可指定旧结果。Git 过渡实现使用
base → resultCommit，patch、新文件正文、类型与 mode 全从该 commit 读取，不能在 snapshot 之后再复制 live worktree。
同一结果的重试复用操作状态，不能仅靠 thread.integration 为 merged 就永远忽略该线程后来的新结果。

逐路径比较 base、parentNow、child：父等于 base 则应用子；父等于子则 no-op；子等于 base 则保留父；其他文本情况做三方合并，
干净则应用，冲突保留标记；二进制、删除/修改、文件/目录或链接类型冲突返回具体选择，不向非文本写冲突标记。按可用语言结构
减少文本假冲突的优化也沿此接口实施，文本合并成功不代表程序行为正确。

**应用与恢复。** 计划是纯计算，应用走 Host 的路径授权、版本检查与恢复操作。写前重检受影响路径和草稿 revision；不符则重算
该路径或返回冲突，不覆盖新的用户修改。受控调用按资源协调，普通外部进程仍可能绕过 Host，不声称这是操作系统级原子比较交换。
记录每个实际写入的 before/after 与阶段；意外部分失败按当前状态条件补偿，补偿遇到后续编辑则保留现场并标 needs-attention。
结果明确区分 applied、conflict、compensated、needs-attention，并附已应用/冲突路径；预期的文本冲突可包含已应用路径和冲突标记，
不把这种正常冲突处理自动撤回。记录的完成状态使用户解决冲突后无需再次重放整个 patch。

草稿来源的最终目标是对应 Document Registry 缓冲，不隐式保存用户未保存内容；磁盘目标经 Host 文件路径写入。同一次集成可能包含
两类目标，共用同一个持久 Integration `operationId`、选定结果修订和逐目标 apply 阶段。草稿按发起 owner、连接注册/代际、文档实例、
base/local 修订、正文哈希与格式核验；agent 的 owner 从 Host 固定 inputContext 解析。Documents 定向请求对应 Registry，事件只带
元数据，正文与确认走认证通道；调用方不能用自报正文或裸路径 ack 替代权威。窗口断连不等于草稿消失；只有磁盘已保存同一基线或
已经等于子结果等可核对情况才按磁盘处理。目标 before/after 和 intent 在执行前持久化并保护对象，缓冲未确认时不 complete；
重启不能把 surface 记录当磁盘目标。条件补偿与整组撤销走同一 Host 操作，重试保留首次撤销基线，后续用户编辑不被覆盖（D-203）。
缓冲不可用或修订漂移保留子结果，不静默改磁盘。其他原生集成直接应用路径状态，不执行 git apply --3way，不修改
用户 index；旧 Git 结果先导入再走同一原生集成。UI、`thread.merge`、`threads`/`wait` 与 Zone 2 共用 Thread `integration` 与
`integrationBinding`。合并预览只说明可应用性，不代表测试通过。

父状态检查只在一次 Integration 完整 applied 后，为选定 `resultRevision + operationId + parentSessionId` 打开持久观察窗口；冲突、补偿、
needs-attention 和未保存草稿不进入磁盘验证。Host 重启可恢复该窗口，只有窗口之后且命令 start/end 都匹配合并后 Git 身份的父命令
才进入记录。退出码是事实，`allExitedZero` 只汇总这些已绑定命令，不表示检查充分或行为兼容（D-210）。

**重叠提示与合并预览。** 已记录的分支变更路径可投影非阻塞重叠提示；恢复日志覆盖不到的 shell 路径标未知，未发现重叠不等于无冲突。
提示不长期占有编辑锁，不阻塞独立分支写者。后台三方预览绑定子 resultRevision 与父受影响路径/草稿版本；输入变更即失效重算，
只显示“此修订可干净合并”或具体冲突。提交解决必须消费所审阅的 binding，不能用旧解决覆盖新父输入。预览读取与同值投影不产生
新的 Thread 事件，避免面板读取触发自身重载。复用 Thread integration 投影，不需要全仓 WorkspaceHead。接通即提供，成本按变化路径计量。

**环境准备。** 使用工作区用户配置的 setup 命令与环境文件规则，按需要执行/分析的工具准备环境；没有命令不伪称已准备，也不因此
禁用不需要准备的任务。setup 幂等，重建或依赖输入变化后重跑；超时由用户配置或既有任务运行时语义处理，不设无依据的 600 秒默认。
Host 通过父 Pi 会话的 settings.get 取得实际设置和 projectTrusted，不能直接重读项目文件绕过项目信任；坏配置明确失败，不当作缺省值。
失败记录 setup-failed、退出码和输出引用，可修复后继续。需要跨重启查看的 setup 记录使用操作所属的耐久输出，OutputRef 只作当前
快速读取句柄，不作为持久报告唯一引用。用户配置一次即授权正常重复执行，不每次再问，不自动执行从仓库猜出的命令。

文件分为需版本化的工作输入/结果、可重建缓存、用户提供的环境文件；ignored 仅作初始选择信号，不能判定重要性。copyIgnored 可显式
选入文件或目录，其规范化根随工作分支持久化并参与每次结果发布。优先文件系统 CoW 克隆（写时分离）和包管理器自身缓存，缺该能力正常复制；可写构建产物不默认硬链接或 junction
到父目录。用户显式共享时显示共享范围。Git 后端不切用户当前分支、不改写提交历史，内部引用可识别；允许必要的 worktree 元数据，
不承诺“用户 .git 一个字节不动”。

#### 9.2.6 等待、资源与缓存

wait由运行时订阅实际依赖，不产生周期性模型调用；结果/答复到达、用户输入/取消或明确超时才恢复处理。等待中的父线程
让出委派执行名额，子线程能准入；唤醒后也走同一调度，不因恢复绕过预算。会话可保持可恢复，实际进程、内存与文件writer
是否释放由它们的生命周期决定，不把线程等待等同物理资源已回收。

缓存可能在等待期间过期，也可能因其他适用请求仍可复用，按provider实际响应计量。默认不为保持热缓存唤醒主模型；用户
已有明确缓存保活选择按其契约保留，真实额外请求记账，不让任务正确性或可恢复性依赖保活。不能只看主线输入减少就宣称
整项任务更便宜，同样也不把用更多调用换更快结果当成失败。

D-284 已启动的摘要准备可在等待期间完成，空闲/TTL/子返回本身不启动新摘要。后续请求按当前容量处理。若新工作背景已
明显过期，选择fresh而不是为旧缓存继续携带它；这不把时间变成自动清历史的阈值。

#### 9.2.7 后续能力

smart friend（便宜主模型遇难题时 fork 完整上下文向配置的强模型求教，Cognition 的 80/20 解法是共享完整上下文的 fork）
——需要一个高于主模型的 `models.smartFriend` 槽位，不进 v1。

### 9.3 线程：一件工作可以多次交付与继续（D-285）

线程在父会话侧栏按任务呈现，用户可打开、提问、调整方向或停止。Thread 的寿命独立于一次模型调用、一个 Run 和一次
结果返回；观察只是订阅，连接断开不等于工作消失。主线保持整体任务归属，用户进入支线不自动改变主线或广播全部讨论。

#### 9.3.1 对象与状态

Thread 是工作本身，ThreadRun 是一次执行。D-285 的职责示意如下；当前 DTO 尚需迁入这些职责，不把示意当作已接线字段：

```text
Thread
  id / parent / workspaceId / brief / 创建与任务关系
  lifecycle / attention / waitingFor / integration
  working branch / published results / reports / activeRunId / eventSeq

ThreadRun
  id / threadId / attempt / runtimeId / sessionId / execution state / outcome
  execution = model + tools + permissions + scope + worktree mode + 配置世代
  input = task | inherit | continue | fresh + 来源边界 + 选定工作状态
  实际用量 / 步骤 / 退出与时间事实
```

每次 Run 的执行配置和输入来源由 Host/broker/Pi 共同解析并冻结；Thread 可投影最新配置供 UI 查看，但不再以永久 role/manifest
决定所有未来执行。换预设、只读转实现或 fresh 都保留 Thread，按既有授权启动新 Run，历史 Run 不被改写。原生 Pi 会话或
分支承担对话；新的输入世代可以使用 SDK 支持的新分支/会话，Thread 保持到原转录与成果的可读关系，不手改 JSONL。

任务状态、Run 结局、集成冲突、待处理消息与执行名额分别表达：settled 表示本次交付已结束，不等于 Thread 永不可继续；
等待释放执行名额不改写为成功/退出，不伪装进程关闭。崩溃仍以 lost 结束该次尝试，恢复新建 Run；记录在既有 workspace
catalog，身份来自 broker/Host，不因状态条目还在就声称 worker 活着。模型资源名额与文件写者/物化占用按各自权威管理。

固定结果与验证仍由 WorkingState 保有修订，Thread 投影子检查、可应用性和父检查。开启下一 Run 不删除之前已发布成果；
旧成果可按明确 revision 使用，新尝试失败不继承旧检查为当前通过。最新交付与当前执行分开显示。

#### 9.3.2 新线程起点与已有线程续做

新建入口仍由用户“从这里开一条线”与模型 dispatch 共用，显式选择任务背景或继承当前输入：

- `task`：默认。任务、必要材料引用、当前项目规则与可选计划/用户笔记；无需父完整对话。适合独立问题和独立审查。
- `inherit`：固定派发时父实际可用的摘要与原文，把子任务加在尾部；不等 dequeue 时取父的未来内容，不复制未完成工具调用
  或正在执行的过程。工具输出/文件引用按新会话的真实读取权限与存储重新绑定，不能只复制失效句柄。

模型/工具相容时保留可复用前缀；需要不同配置时按正确配置构造，不为缓存放弃权限或适用工具。相同历史被多个子模型读取
仍各有实际用量，不把逻辑引用当作共享模型状态。工作区基线与上下文分别固定，父的旧阅读记录不能冒充子现在的磁盘版本。
retrieval 默认 task，保留不携父 blocks 和专门事实协议的选择；预设声明与用户显式输入选择冲突时清楚表达，不偷偷继承。

已有线程继续由执行请求进入：工作和背景仍相关用 `continue`；工作延续但旧背景大半过期用 `fresh`（8.4.7）；不相关新任务
新建 Thread。`send` 的 `kind:"request"` 对 settled 实现线程经 `threadContinueRun` 新建 Run：`continue` 重开保留会话
原样续跑，`fresh` 按 2.6A 组装新输入开新会话（旧转录经 `previewSessionEntries` 可读，工作与结果保留）；普通 `inform`
仍只投递不新建 Run——对 settled/非运行线程作为耐久 held 记录留在 Thread 上，到下一次正常输入边界成批交付。
需要时从选定结果重建已回收目录，沿实际权限和统一执行准入启动；新 Run 记录输入结果身份。普通 inform 不触发这些动作。

只读讨论转实现保留工作与历史，按新 Run 授予实际工具/权限并准备工作分支。上下文可继续，也可 fresh；不强制新建“实现员工”。
重建输入时加载当前规则和适用成果、未解决问题、仍在运行的子任务/进程引用及待处理消息，不依赖旧会话缓存继续沿用旧要求。
这不创建周期性的背景清洗，也不要求新 Run 先让另一个模型概括全历史。

#### 9.3.3 成果续接与代码依赖

线程可以发布一个可用阶段并结束该 Run，父接入后让同一 Thread 继续。消息提前交流发现；代码、表格或报告以实际结果/产物
交付。说明须足以判断用途、已完成部分与缺口，简单问题直接给答案，大材料给必要说明和可读入口，不强制所有结果按极小
预算截断。主线使用真实产物并完成所需集成检查，不根据一份报告重新制造同一成果。

父合入 R1 后，原线程可以从自己的 R1 继续 R2；父此后产生的新公共变更不会自动进入子工作状态。新派发依赖任务时从选定
父状态建基线；已经启动的依赖线程则显式纳入选定父修订，再继续执行。复用 WorkingState 三方计划、原子修订和物化切换，
保留子自己的 delta，冲突按已有 Integration 处理；更新基线与结果来源一起记录，旧 R1/验证引用保持不可变。运行中的写入
在安全边界协调，不能发一句“接口更新了”就宣称同步成功，也不建设任意线程自动双向同步。

上下文重建与代码同步是两个独立选择：fresh 不丢子改动；continue 也不能掩盖代码还在旧基线。父对明确结果 revision 集成，
不依赖“最新报告”别名猜测。兄弟相互确认局部问题即可，涉及公共契约或任务方向的决定带产物/修订回告主线。
报告的偏离来自明确完成字段，缺失如实表达；不借 keeper 块、聊天长度或虚构进度补齐，不自动增加审查链。

#### 9.3.4 生命周期与回收

- **与父的回合、worker 进程解耦。** 线程是持久会话，会话文件每步落盘。父回合结束它继续跑；父 worker 死了它不受影响；
  线程自己的 worker 死了会把当前 `ThreadRun` 结束为 `outcome: lost`：host 在同一会话文件、同一 worktree 上创建下一次
  `attempt`，线程 id 不变，从最后一个
  完成的步继续，Zone 2 告诉它"你被中断过，上一条工具结果可能缺失"。这是恢复子系统"worker 退出 → 标 incomplete、不说谎"
  的推广。
- **完成进入父的下一回合。** 线程完成是一个事件；父在 `wait` 里就立即返回，不在就以 Zone 2 一行进入下一回合（通道 A）：
  "线程 X 完成：一句结论 · 3 个文件 · 相对简报的偏离：…"。父压缩也不丢线程：活跃线程列表是 host 事实，每回合以一行
  一条出现在 Zone 2，超过 N 条折成"另有 K 条"。
- **半成品保留。** 失败、取消或 worker 丢失先收集可取得的修改并发布结果修订；尚未完成收集的目录保留，明确显示未持久化路径。
  已发布结果及其正文由工作状态引用保留，Git 迁移阶段由持久 resultCommit 承担；不能因没有正常结算就丢弃半成品，也不承诺
  从未成功写入存储的内容能够凭空恢复。父或用户可查看结果、继续原线程或开新线。
- **边界回收（D-077 经 D-078 修订）。** merge、取消、失败、归档、无活动使用者的 idle 触发收集与回收，默认执行；目录重开时从
  固定结果在原路径重建，按需重跑 setup。无活跃 Run 之外还要检查相关 shell/process writer 与实际使用者。Git status 干净仅说明
  Git 跟踪范围；需保留的 ignored 输入/结果同样要已保存，已声明可重建缓存允许删除，未知内容保留并报告。路径必须位于该记录的
  受管根内且身份一致。条件不满足仅保留该目录，不禁用其他线程；显式 keep_worktree 选择继续有效。
  归档取消并等待该 Run 的准备/setup/启动、实际会话与 shell 退出，失败保留绑定和目录。删除期间持续持有 Documents 写者屏障并
  重核结果。同线程的归档、恢复和回收互斥，自动清理跳过正忙目标。父 kill/archive 对每个后代进入该后代自己的 lifecycle
  serialization，使用 `createdAt` 再 `id` 的稳定后序，避免递归锁反转；祖先归档或正在级联时拒绝恢复该后代（D-223）。
  恢复从选定 native resultRevision 重建，沿原 session 绑定新 Run；
  普通已结束/已回收线程的打开也走该链。失败保持原生命周期可重试，不开放错误目录；准备进度持久化为明确阶段，部分目录重试清理核对 fingerprint（D-204）。
- **占用与背压。** 记录物化目录、对象库、受引用历史及可回收量，删除目录不等于释放结果对象。共享对象在工作区只计一次。
  优先回收符合条件的缓存；新增物化按用户配置预算、实际可用空间与可知准备需求安排，必要时排队或返回可行动的 unavailable，
  不终止已有线程来腾配额。没有定标时不默认设置 8 GiB/10% 硬拒绝，也不把未知所需空间当 0；运行中的实际空间不足按 I/O 失败
  明确记录（ENOSPC）。线程面板展示 Host 占用、保留原因和立即回收，不设无依据的 80% 统一阈值（D-202）。
  统计覆盖该工作区全部父会话；首次物化与恢复在短临界区预留已知新增需求，慢 setup/会话调用不持工作区锁。未知量不遮住已知超额，也不因此统一拒绝任务（D-204）。
- **启动对账与历史清理。** 对受管记录和目录对账，修复 Git 元数据；能确认属于 Varin 且已保存的无使用者目录正常回收，归属
  不明的目录展示而不猜测删除。历史对象与分支按引用及用户保留配置清理，不以固定 30 天删除仍可继续的结果。分支名虽小，其
  引用会保留内容对象，须计入历史占用；对账和回收不依赖某个 idle 定时器。
- **用户释放旧结果。** 线程卡片按需加载版本、引用大小与保留原因；确认冻结的版本选择后由 Host 重核并释放（D-239）。
  刷新或切换会话不会让旧选择指向新分支，清理失败保留相同请求重试。仍可继续的当前分支和正文转录保持独立生命周期。
- 对话正文不因压缩自动删除；最终报告与计划/用户笔记快照按原有会话、Thread 与知识引用保留，不要求存在后台工作块。
  **用户删除父会话**：现有删除确认说明运行线程将停止并归档；结果保留是否成功按实际执行返回，不预先声称都已保存，不弹第二个模态；
  删除后给可撤销提示；运行中的线程停下（`outcome: cancelled`，快照后目录按上面的规则回收）并归档，归档区提供"恢复为独立线程"
  ——这是产品决定，不是技术约束（另一种可选设计是让它们直接成为工作区级的独立线程）。每条线的花费与占用可见。
  线程报告里的原始 trace 引用是 `TranscriptRef`（第 5.1 节），指向线程自己的会话文件，与线程同寿命。
  **用户删除整条线程（D-242，已接）**：线程卡片的两步确认 → 鉴权 `DELETE /threads/:threadId` → 与归档同一级联形状后序删除
  后代。每个节点先停活 Run（不铸 partial result），再删除该线程拥有的全部 Pi 会话（worker、转录文件、metadata 经
  `piRuntimeBroker.deleteSession`），随后释放工作分支上的全部结果修订、分支头与草稿基线并回收无主对象，然后删除受管目录
  （跳过结果快照 diff，仍过 ownership 断言与 user/writer guard；keep_worktree 对删除不生效，否则目录成无记录占用），
  最后原子移除 Thread+Run 行并解绑 session binding。删除 intent 与下一 phase 先持久化到 Thread catalog；Host 重启可续跑。
  任一后代未完成时父节点不得移除，knowledge/evidence 引用清理属于提交前必需阶段，返回值只列真实删除项（D-254）。

#### 9.3.5 活性与失败分类

活性由 host 从线程的事件流观察，不靠线程自报、不靠父读转录：最近事件时间、工具调用频率、连续相同工具加相同参数的次数、
上下文增长、花费。停滞 = 超过 T 没有事件（T 默认按 provider 缓存 TTL 推，与第 9.2.6 节一致）；循环 = 重复模式。这是
传感器，允许机械判定（它决定的是"提醒谁"，不是"什么重要"）。

T1 的落地值是：无事件 300 秒只翻 `stalled` 告警、不取消 Run；连续 6 次完全相同的 `(tool name, 参数哈希)` 翻
`looping`，下一次不同调用自动清除。第一次非预期 worker 退出会在同一会话/worktree 上自动开新 Run；若新 Run 再连续崩溃，
停止自动重启并翻 `stalled`，避免形成进程崩溃循环。角色模型、工具和冻结 permission overlay 经 `session.create/open` 在 Pi 会话构造前冻结（D-219 / D-222）；`hard-implement` 与 `frontend` 的角色目录含嵌套线程工具，
由 Host 能力与 `assertOwnerTool` 启用，不是提示词授权。`review` / `check` / `retrieval` / `quick-implement` 不含
`dispatch`（D-215）。`retrieval` 通过冻结 allowlist 与 `thread.facts.set` 交付事实：Host 按冻结 scope 与
Documents 读取核对路径/行范围，模型不能自行把不存在或越权来源标成 source-checked；Host 不能把来源存在写成 claim 为真。
大材料与子会话 output 复制为耐久 artifact，URL 必须带 active retrieval Run 铸造、绑定 owning/session/thread/run、exact URL 与
正文 hash 的 Host receipt；普通 webfetch 不生成该权威。临时 artifact/receipt 从创建起有 object reference，提交时转成 pending，
封印后转成 sealed，真正删除 Thread 时一并释放。父 `read_thread` 按 UTF-8 字节从耐久对象分页，不先载入全文。不复制父完整对话
（`carryBlocks: false`），默认不改工作区；嵌套 retrieval 在 dispatch 时建立 isolated 冻结分支，可为 LSP 物化只读输入，settle
只封印 evidence、不发布目录变化（D-227 / D-230 / D-231 / D-234）。

失败有分类，没有"没结果"：Run 的 `success / failure / cancelled / lost` 记录执行结局；Thread 的 `stalled / looping /
user / permission` 记录当前需要关注的原因，`integration` 独立记录合并状态。每种是不同的结果（不变量 3）。等待输入是一等
attention——实践里最常见的"卡死"其实
是在等一个没人看见的权限确认或澄清问题：它出现在 `threads` / `wait` 结果和用户面板里，附问题正文，父 `send` 或人直接
答；权限请求走当前活动权限门的 UI 并带线程徽标，永远不会静默等待。完成报告用受控的
`Conclusion` / `Deviations from brief` / `Unresolved issues` 标题形成，不从普通散文猜，不依赖 keeper decisions；
报告、实际存在的计划/用户笔记快照、diff 统计原子写进注册表，
`done` 之后再 `wait` 仍返回同一份。

#### 9.3.6 线程工具与执行请求

- `dispatch(task, options)`：异步建立任务线程，选 task/inherit、可选预设与工作状态；返回实际准备/排队状态。
- `threads(ids?)`：任务名、当前执行/等待、最近实际活动、可用结果与缺口的增量视图，不伪造 progress。
- `wait(targets?, timeout?)`：由 Host 订阅指定结果、请求答复或需要处理的状态变化；超时是正常观察结果。普通读文件进度留在
  UI，不因每个步骤把等待者唤醒做模型检查。等待明确让出执行名额，完成后按同一队列恢复。
- `send(to, message, { kind, replyTo?, context? })`：inform 投递材料，request 请求回答/执行；replyTo 绑定已有请求，满足显式
  等待时可唤醒一次。context 的 continue/fresh 用于后续执行请求，不改变普通通知。来源由 Host 填入。
- `read_thread(id, what?)`：默认状态/结果说明，可按结果修订读报告、产物、计划/用户笔记或分页转录；不给所有场景统一极小摘要。
- `merge(id, resultRevision?)`：沿现有 Integration 消费固定成果；依赖线程纳入父变化是明确的工作状态更新，不靠 send 模拟。
- `update(resultRevision?)`：把调用方工作分支重订到选定父结果修订；三方规划保留自身 delta、采纳父方变更、干净
  文本合并，分歧路径保留自身字节并报告冲突；kernel 在同一 CAS 写中原子切换基线并记录 `parentRef`，旧结果仍绑定
  其发布时基线。普通消息和 fresh 续做都不能替代这次文件级更新。
- `kill(id)`：停止执行并保留已发布结果，目录按真实 writer 与保留责任回收；普通通知不复活已取消/归档工作。

这些是 D-285 的目标语义；3.18A–E 已实施：任务中心派发与可选预设、task/inherit 与 continue/fresh 续做、inform/request/
replyTo 定向消息、同根共享执行名额与等待让出、不可变结果修订冻结溯源与 `update` 显式纳入父修订均已沿生产链接线。
3.18E 收口：自动 review 默认关（父线程无会话同样默认关，唯一翻案是用户显式 `harness.review.enabled`）；UI 面板提供
Ask/Fresh/Note 定向消息控件与最近消息来源/held 显示，经公开 `POST .../threads/:threadId/send` 走与 Pi Host 工具
相同的 `thread.send` 服务；role-required、单向 send、永久执行 manifest、per-parent 准入等被替换路径已删除。
无需先建设任务市场或通用工作流，公开入口必须能完成“派发—解决依赖—交付—使用—同线程续做”的一条纵切。

D-300 的可选等待发送与自动现状是后续目标，见 9.2.5a 与 9.3.7；这里的现有工具清单不证明新参数已实现。

#### 9.3.7 增量视图与送达

Host 为观察者保存实际交付的事件/结果修订和所属 Pi entry，按8.7提供增量；消息的已接受、已送达和执行完成分别表达。
重复响应/重连不重复入队任务或唤醒，尚未送达的正文沿原有会话/消息持久路径保留。普通状态更新可合并，用户请求、需要
处理的问题和不可替代的结果不能被进度折叠抹掉。

固定上下文准备不改观察游标；提交压缩后，只有确已失去原文基线的对象在下次观察重建。fresh 开始新输入视图，保留旧转录，
当前待处理请求和活动任务引用重新投递一次。用户 UI 的观察仍独立；环境事件按增量提供，不每轮复制完整报告或 keeper 块。
D-301 / 7G 的简短团队快照按 8.1.1 每次附尾，不属于此处的历史事件去重。

**D-300 的后续扩展（待实施）：** 为主线与分支提供“线程 / 任务 / 状态 / 进展”的简短现状表。
任务来自 brief，状态来自 Thread/Run/等待，进展机械摘取该 Agent 最近一段已完成的可见输出，约 20 个可见字符加省略号。
工作说明和最终答复都可作为来源；不要求专门汇报，不用总结模型，不读取隐藏推理。
新消息/结果在进展列标记来源，不能冒充该 Agent 的文字；没有新输出就保留时间和旧引用或显示暂无。
每条预览可由 `read_thread` 展开到显示时对应的原文修订，再逐层读邻近上下文、消息、成果。

Host 从现有事件维护投影。D-300 当时采用首次短表/后续变化行；D-305 的独立 7G 按 D-301 改为每次模型请求
末尾的完整当前短表，覆盖同回合工具续接与等待返回，历次表不进入对话历史，环境增量仍按送达留史。
不能只依赖初始化/`before_agent_start`，也不逐 token 更新输入；固定协作说明与请求角色见 8.1.1。
环境观察确认只覆盖实际送入模型的内容，UI 游标独立；临时表不依赖旧表收据，压缩/fresh 后直接重建当前视图。
大团队按根、关系、关注范围渐进展开并说明未展开范围，读取不启动模型。
完整设计见 [科研集群设计第 7 节](research-cluster-design.md#7-通用多-agent-交流与持续现状)，适用于整个 Harness。

#### 9.3.8 以任务和成果呈现

父侧栏以“摘要请求实现”“设置面板”等任务名展示，模型/预设是辅助信息，不按职位扮演组织公司。点开可直接交流、继续、
重建上下文、停止或查看历史结果；“继续工作”与“保留成果并重建上下文”说明影响，不要求用户手管团队。已有讨论转实现、
归档恢复和结果保留入口继续复用。

定向消息在接收者会话中带真实来源与可展开正文，主线显示影响整体的结果/决定和待处理问题；普通子过程不自动广播。
子线程发布R1后继续R2，UI同时显示已可用成果和当前执行，不能把旧验证标成新结果通过。常规用量包括真实子执行，缺失不
补零；不新增财务看板、聊天量进度或编造完成百分比。rail、overlay、Fleet沿同一Host注册表与事件源投影。
