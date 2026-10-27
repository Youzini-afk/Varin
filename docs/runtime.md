# Agent 运行时

Varin 原生对话通过 Rust `varin-runtime` 执行，Thread/branch 历史、输入受理与执行由 Catalog 统一拥有。
既有 Application Host 继续承担模型账号、资源、扩展和领域服务。旧 Pi runtime 与产品入口已经移除，
不自动导入或重写历史用户资产，也不保留第二个对话 writer。
[外部 Agent](external-agents.md) 使用独立程序的原生协议执行，Varin 产品记录仍由同一 Catalog 保存。

[架构](architecture.md)说明包和进程边界；[资源与恢复](resources.md)说明文件、进程和环境；
[检索与知识](retrieval.md)说明材料和推理消费者；[扩展](extensions.md)说明作者接口。
本文只保留运行时自身的机制、归属和关键取舍。可执行合同以
[协议 schema](../kernel/protocol/schema.json)、[运行时 crate](../kernel/crates/varin-runtime/README.md)
及其实际调用方和测试为准。

## 谁拥有事实

- Application Host 认证客户端、解析可信设置和注册模型、准备扩展/MCP，并连接领域服务。
  HTTP 返回、断连和界面状态都不能代替实际执行结果。
- `varin-runtime::Catalog` 拥有 Agent 历史、输入受理、Run、ModelStep、Operation、
  策略 checkpoint、Wait、投递与持久接续。执行引擎在工作线程运行模型、策略和工具。
- `varin-kernel` 将执行引擎连接到原 Storage、进程、计算和授权服务。
  Rust Storage 拥有 WorkingState、文件/对象事务、来源授权与资源回执；它与对话 Catalog 各有职责。
- Knowledge/Memory、Documents、项目日程、MCP、Computer 和扩展包仍由各自领域服务管理。
  Operation 关联这些服务的结果，不另建一份领域资产库。
- UI 经 `ThreadsAPI` 投影这些事实。关闭视图、切换项目或丢失连接，不会产生新任务、改变 Source，
  也不证明执行已经停止。

Thread 是持久工作与对话身份；HistoryBranch 是一条历史祖先路径及其 head；Run 是分支上一次
受理后的执行；ModelStep 是一次实际模型交换。ToolCall 标识模型给出的完整调用，Operation
标识实际工作，后者可以比工具返回活得更久。Source 标识资源视图及其 Host 所有者。
系统 PID、MCP session 和 provider response ID 只是外部关联，不能替代这些本地身份。

## 模式、工具披露与协作

`general`、`code`、`research`、`office` 分别表示通用、Coding、科研和办公。未显式指定的新会话默认通用；
已有项目和 Agent 的选择保持原意。模式选择默认直接披露的工具，不注入平台模式提示词。用户指令、项目指令和
预制自己的说明仍由原上下文机制提供。

Rust 在请求准备时固定 `direct_tools`。provider 函数列表、调用校验和目录中的 `directlyCallable` 使用这份集合；
完整可执行目录仍由原声明拥有。分组查询给出用途、前置条件与相邻入口，具体名称查询提供完整 schema 和调用方式。
按需工具经 `tool_invoke` 执行，读取说明不会改变当前请求的函数表。MCP 保留自己的直接声明和发现入口。

各模式共享 Worker、调研 Agent 和内部快速检索；科研提供科研搭档，Coding 保留验证 Agent。预制的模型由用户保存的
配置或其继承设置决定，派发目录只展示用途与实际可用性。临时派发继承主模型，成员名称和头像沿用实例身份。
`research_decide` 的活动入口已移除；历史记录和其他消费者使用的快速决策能力分别保留。

`dispatch.inheritContext` 默认关闭。开启时，Catalog 固定派发时已经完成的有效对话背景，清除父级系统指令、Goal 指令、
当前团队注入和 provider 私有续接字段；子任务仍使用自己的模型、工具和 Source。原历史通过 ContentStore 引用共享，
接续使用子任务自己的后续历史。材料 owner 核验其中引用的读取权限，并为子任务持有原材料引用，无需复制原文件。

删除维护从原生任务关系取得已停止的删除对象，先释放其浏览器和材料资源，再回收 Catalog 内容。继承材料的子任务、
显式共享和持久资料集保留实际使用中的内容；最后一个临时使用者删除后可释放。删除前已经受理的上传若较晚完成，
仍按它原来的材料命名空间完成清理。归档和关闭视图不触发材料删除。

标题等辅助文本生成使用独立的原生 Run，以自身身份构造模型请求，不依赖对话分支或项目路径。
标题优先选择设置中的辅助模型，结果只替换首条输入产生的临时标题。Host 启动或内核重新就绪后，
会补写已完成的结果，并为确认从未进入模型推理的中断任务建立关联重试；已发送或结果未知的
请求沿原回执处理。用户手动命名优先，置顶等元数据修改发生冲突时复用生成结果重新核对后保存。

“对话默认 → 自动重试”配置当前 Host 的模型请求重试。默认首次失败后最多重试两次，初始等待 1 秒，
指数退避上限 30 秒并带随机浮动；服务端 `Retry-After` 是独立的最低等待时间。用户规则按顺序匹配
HTTP 状态码、错误代码或错误内容，首条命中生效，未命中时处理常见网络故障与临时 HTTP 错误。
正则匹配和设置中的测试共用原生线性时间匹配器，测试不会访问模型服务。

活动执行者在本次请求结束且回执提交后决定是否重试；内核重启或丢失受理/结算 ACK 仍只核对原记录。
普通对话和压缩节点为新尝试建立独立 ModelStep，复用原输入、模型与渠道，不重跑已完成的工具。
辅助文本在原 Operation 内保留各次失败、部分输出和用量，再单独生成下一次结果；每个付费边界重新核验
父任务、Goal 与凭据。停止会立即结束重试等待。没有上报的用量保持未知，不用成功尝试的数值覆盖。

删除会话会隐藏 Thread 并请求空间回收。已受理的任务继续履行原来的执行和结算责任；Catalog
等 Run 结束、实际执行者停止、模型请求结算后，清理该会话拥有的历史、请求和回执。其他会话
分支仍引用的历史与关系记录继续保留，随后由 ContentStore 释放失去引用的正文和媒体。
Thread、branch 的小型身份记录和删除回执保留，支持稳定身份与删除重试。Host 在启动、删除和
后续持久执行事件中推动回收；正在读取内容时沿原有读取保护延后执行。

一个分支只有一个历史提交者。独立工具、子 Thread 和后台工作可以并发，不因此创建第二个
向该分支提交的模型循环。项目归属、Source、策略选择和执行权限分开表达；显示路径或调用参数
里的 Thread ID 不能授予访问权。

## 持久受理与执行生命周期

[Catalog](../kernel/crates/varin-runtime/src/catalog.rs) 通过独占 owner 锁管理
`conversation.sqlite`，使用 SQLite WAL/FULL 短事务。初次安装所有内部域在同一事务完成。
已有数据先只读检查格式，再打开 writer、推进 epoch 和恢复；不支持或损坏的内部格式明确失败，
保留数据，不能像处理缓存一样重建用户历史。

用户输入与命令 key、分支前置条件、选定配置和受理回执一起提交。相同重试返回原回执，
冲突复用 key 则失败。排队输入保留受理时的配置和 revision；编辑、interrupt、next-Run
交付沿同一输入队列执行。后来更换模型或设置不能反向改写已经受理的工作。

Run 从 accepted/preparing/runnable 进入生成、工具执行或等待，最后明确完成、失败或取消。
等待必须指向实际对象并保留接续身份。Supervisor 先返回控制句柄，再由 worker 加载历史和
准备资源。只有本次选定工作依赖的能力需要准备，不设“全部服务就绪”的全局门槛。

模型准备固定语义上下文、实际 provider 请求、模型/连接身份、工具 schema 和执行绑定。
`RequestPrepared` 与 `ModelDispatched` 是先后独立的持久事实。模型输出、不可变历史及
未结算工具调用一起按预期 head 提交；基于旧 head 准备的请求不能发布到新历史上。

Run 结束前应结算前台调用，或保存明确的后台移交回执。模型 final 文本不证明进程、子任务、
Computer 动作或远端 Job 已停止。Operation 的 call/Run/Thread/environment 寿命由合同
在受理时固定，与这次工具返回的时间分开。

入口：[执行引擎](../kernel/crates/varin-runtime/src/execution.rs)、
[Supervisor](../kernel/crates/varin-runtime/src/supervisor.rs)、
[Run 装配](../kernel/crates/varin-kernel/src/run_assembly.rs)。

## 正文、checkpoint 与投递

Catalog 事务保存短元数据和不可变内容引用。历史正文、请求快照、策略状态、执行配方和媒体
存入运行时 ContentStore；worker 负责哈希、序列化和加载。publication lease 保护准备中的
对象，直到带身份检查的事务发布引用。GC 遍历保留的历史、输入、事件、请求、配方及媒体依赖。
内容 hash 只验证一致性，持有 hash 本身不授予任意对象读取权。

历史原文、模型输入和 UI 投影用途不同。Provider 原始续接项单独保留签名、加密推理等内容，
不压平为虚构的普通文本。上下文设置、记忆和服务选择后来变化，也不改已受理请求的字节。
普通输出明确分为 JSON data 和有序 text/media parts；不能根据 JSON 键名猜测控制命令或媒体。
模型输入按 `harness.output.visibleBytes` 为长工具结果分配正文展示预算：JSON 对象保留字段结构和小字段，
数组保留完整的前若干条记录，长字符串与日志保留首尾并优先沿完整行裁剪。预算由大字段共享，小字段先保留；
状态、错误、总数和原游标不会被一个截断信封整体替换。完整回执继续存储，图片保留原媒体类型。
附加的 `outputPreview` 文本说明原始大小、各处省略范围及读取参数，不占用原结果的 JSON 字段。
展示预算控制正文量，续读元数据额外保留；同一条不可变输出的投影在后续请求中复用。
`read_thread` 的 `output` 查询通过条目 ID 和 JSON pointer 直接读取原始 OutputBody 中的文本或数组。
文本以 UTF-8 字节分页，数组以完整记录分页；单条记录超过页预算时仍完整返回，以保证翻页推进。
首个读取返回固定锚点，后续沿该锚点和 `nextOffset` 续读。预览提供的数组读取位置接在已展示记录之后；
读取完本次结果的省略记录，再使用原工具游标获取下一页。`item` 查询仍可读取整条原始历史 JSON。
显式 `file_read.length` 或完整起止行范围、`process_read` 页面和 `read_thread` 的原文页面按原请求返回，模型输入不会再二次裁剪；
这也适用于经 `tool_invoke` 调用的读取。UI 与持久历史继续使用原文。
`threads` 的 `current` 字段直接给出调用方 Thread、branch 和 Run；完整自身条目仍由 `includeSelf` 控制。

上下文 checkpoint 保存已发布摘要、指令、记忆/资源及来源边界。新记忆可作为后续请求的投影，
不改写原历史。Knowledge/Memory 仍是笔记写入者；Catalog 只记录观察和请求投递证据。
只有原记忆操作的确认回执可用于去重，失败请求不表示已经交付。

显式历史导航先在锁外准备祖先和合法工具配对，再原子提交 head CAS 与命令回执。
重复命令不会回退后来追加的工作；undo 使用原回执。导航不重写 Run、效果或 usage，
也不恢复已取消的 Goal。跨过摘要边界只清除该摘要对应的上下文基线，不删除实际记忆。

## 工具、资源与真实回执

文件与代码检索、进程与脚本、协作、对话、网页、图像生成与编辑、交互 HTML 以及资源读取属于常驻工具。
语言服务器由 IDE 使用；模型的结构读取通过 `file_read` 按需调用 Tree-sitter。
常驻选择取决于工具职责和工作模式，原生和扩展实现使用同一规则；本次可用的声明在请求准备时直接提供给模型。
`tool_describe` 省略参数时从本次冻结的完整目录生成全部可用分组，包含全部工具已直接声明的分组。
`toolCount` 表示组内全部可用工具，`directToolCount` 表示其中本次已直接声明的数量。
按 namespace 读取该组工具，按名称读取任意已绑定工具的完整说明、参数、版本引用与调用模板。
`names` 批量取得指定工具说明；`query` 搜索名称、用途和分组说明，默认直接返回匹配项的完整参数与调用模板。
分组浏览默认精简，`detail: full` 可一次取得整组完整说明；`detail: summary` 只取目录摘要。
这些详情追加到工具结果和历史中，模型的工具声明列表在披露前后保持一致。

真实执行目录独立保留已授权的原始声明与端点。只有本次模型 `tools` 中已声明的函数允许直接调用；
未声明的目标必须通过已注册的 `tool_invoke`。协议解析与执行前校验共用这一边界，包含扩展模型适配器。
`tool_describe` 返回名称、参数、是否已声明和调用模板；读取说明不注册新函数。
通用入口按本次请求冻结的完整目录校验目标版本，不能查找后来加入的工具或越过 Agent 的工具选择。
未声明、目录不可用、版本不匹配、调用格式错误和参数无效使用独立错误码。界面显示工具名和修正方式，
不复制调用参数或服务端任意错误正文；新错误在会话、工作概览和协作聊天中使用同一组本地化说明。
已关闭、未配置的扩展能力在配置 owner 准备阶段过滤；源依赖沿原 Source 准入，Goal 报告只在绑定 Goal 时可用。
首个模型请求等待当前选中扩展完成准备，后续配置变化仍在请求边界发布。通用模式将已启用的 `research_search`
保留在完整执行目录及研究分组中，按需读取说明后通过 `tool_invoke` 调用；科研模式将它直接声明为常用工具。
`research_decide` 已移除活动声明与专属实现，历史工具回执仍可展示。
Host 将科研模式的展示选择固定在工具元数据中，原绑定恢复时保留该选择；新 Run 按其实际工作模式重新准备。
工作模式决定展示方式，各工具的配置与后端就绪状态决定可用性；披露说明不会动态改变模型工具列表。
已声明函数的直接调用进入原 ModelStep 工具执行流程；`tool_invoke` 核对版本引用后进入原嵌套调用流程，
实际目标继续执行自己的参数校验、权限检查和资源准入。包装入口保留持久父记录，目标 Operation 独立保存
效果、停止证据和 Job 句柄；返回的文字与媒体保留原输出类型。隐藏能力更新不改变模型工具前缀或本地编码复用键。
子任务委派说明也通过 `tool_describe` 返回，不随目录变化重写系统前缀。
派发读取原始请求时沿 ContentStore 的 snapshot 读取入口解析媒体引用；存储的 `content_ref` 与执行用的媒体字节分属各自阶段。
媒体历史可用于普通派发及快速检索，`inheritContext` 只决定是否把对话背景交给子任务。

失败的工具结果共享 `error:{code,message,details?}` 投影。直调结果、`tool_invoke` 返回数据与脚本 `tools.invoke`
receipt 都能从 `error` 读取；原 `kind/outcome/effect`、目标 reference、operation、completion、正文和媒体继续保留。
`NotDispatched` 保存结构化错误及原 reason，持久化和对象回收后续读仍保留详细原因。取消沿原取消状态表达。
成功正文中名为 error 的普通属性不改变原执行状态；扩展与 MCP 的自定义正文也由其实际协议状态判断。
错误码缺失时使用通用失败码并保留消息，不通过解析任意消息前缀猜原因。

所有工具进入同一份冻结的声明/端点目录。一次绑定保留其 ModelStep、policy node 或
nested call 来源，贯穿准备、资源准入、授权和执行；模型批次直到工具结算都持有实际端点。
普通查询可使用可取消句柄，不为每次读取先制造持久 Job；需要恢复的工作和副作用保留原 Operation。

[资源准入](../kernel/crates/varin-runtime/src/resource_admission.rs) 一次取得完整资源计划
和计算容量。冲突请求保持先后顺序，无关工作可以绕过阻塞；已绑定的 local-compute 按真实
任务家族调度。等待容量时不能先占文件资源，慢准备不能占公共控制通道。
这是共享硬件上的逻辑隔离，不是独立 CPU、磁盘或物理故障域的保证。

Operation 分开记录阶段、业务结果、效果和取消。效果可以是 none、dispatched、partial、
confirmed 或 unknown。外部回执另带原执行者 identity/epoch 和真实 `executor_stopped`。
成功文案、空占用表、HTTP abort、丢失的进程响应和取消意图都不能替代停止证据。
原生进程与 managed Source 所有者遵守同一条规则。
原执行者已确认停止但业务效果仍 unknown 时，恢复可以按该原回执闭合工具配对，
不能因此把效果改为成功；没有停止证据的 unknown 仍保留原占用和待结算责任。

取消先留下事实，再推进依赖清理；控制唤醒不依赖正文读取完成。绑定准备保留原 Cancel 或
Bot Sleep 路径，不能把已知取消改写成无关失败。已发出的副作用仍由原执行者结算。
迟到回执不能清算新 Run 或替换后的资源；不明结果保持可查询，不自动重放。
重启前已取消的未配对交换，在原停止回执到齐后只恢复原工具批次和历史结算，
不重新准备模型、工具或 Source 执行权限。正文暂不可读时保留取消与回执；正文修复后可再次取消重试，
原回执变化也会重新检查，未变化的失败边界不会自行循环读取。

脚本嵌套调用复用 ToolDirectory、授权和资源准入。回执关联外层 invocation，不能伪造模型
tool/result 对。持久脚本、PTY、研究 Job 和 MCP Task 各有实际寿命和输出所有者。
`tool_describe.invocation` 给模型函数调用模板；`scriptInvocation` 给脚本 `tools.invoke` 模板，两者不混用包装层。
脚本先检查 `completion.kind`，`result` 的业务数据在 `completion.content.data`，媒体在 `parts`；`not_dispatched` 表示尚未派发，
`job_accepted` 表示工作已受理，不能只判断 `outcome`。嵌套调用拒绝保留原错误 `code` 和 `message`。
`script_run.title` 是发起模型提供的任务说明，随原调用保存；脚本正文与执行权限仍走原合同。
聊天折叠行展示任务说明、调用数量和异常提示，展开后读取 Catalog 中原嵌套 Operation 的调用树，
具体参数与结果按需读取。脚本已完成和内部调用失败、仍在运行或效果未知分别展示，历史重载不会丢弃调用明细。
关闭终端视图只 detach；停止取消原 Operation。输出回放固定历史边界，重开不会再次回答
历史终端控制查询。文件租约、guardian 和跨平台停止证据详见[资源与恢复](resources.md)。

## Source 与 managed Host 的运行时边界

选定 Source 始终保留 `resource_owner` 和精确 workspace/view 身份：

- `live_root` 绑定已准入 Host、root identity 和规范目录，通过 Documents/Storage 读当前内容。
- `fixed_branch` 绑定不可变分支/revision。命令首次执行时由 Storage 按需准备该版本的物理视图，
  后续文件工具和进程共用派生目录；baseline 保留。workspace MCP 继续使用其显式执行来源合同。
- `materialized` 绑定固定来源及原 execution copy/Run；副本缺失时明确失败，不能以同一身份换建副本。

本地物理 Source 派发只读或 Shared 子 agent 时，直接共享父 Run 的实际执行目录。各 worktree 保留各自的目录身份；
materialized 来源保留原 environment Run，续跑沿用同一个目录，并能读取期间发生的文件变化。
这条路径省去整目录捕获和复制。省略 `workMode` 的派发复用选定来源；只有显式 `isolated_write` 才建立独立工作状态。固定 branch 直接复用原树，managed Host 由目标资源 owner 执行同一准备合同。

固定捕获的 saved-files/surface-drafts、Git 语义、来源闭包和文件一致性由
[资源合同](resources.md)解释。连续目录观察只用于名称清单；正文复用另由原生文件身份、change time 与已验证对象身份决定，不能只看 mtime/大小或 Git HEAD。
同一有效观察代的并发准备共用捕获，原生缓存只存可丢弃的元数据，不持有正文引用；GC 清除这些提示。隔离任务的读取和搜索不要求物化，首次写入或真实路径需求沿原 journal 准备执行目录。

managed Host 场景仍由协调端 Catalog 拥有执行事实；目标端原 Storage、工具和 guardian
拥有资源准入、效果和回执，不另开影子 Agent Run。同名路径或 workspace 不等于同一资源，
目标内容 hash 也不自动成为协调端对象引用。选择文件 Host 不会顺带迁移模型凭据、全局设置、
Computer assignment 或 Bot 身份。

[Source 服务](../kernel/crates/varin-kernel/src/source_resources.rs) 与
[Host 桥](../packages/web/application-host/lib/kernel/managed-source-bridge.ts) 已连接文件、
检索/语言、child/result、进程/PTY/script、Experiment 输入、扩展包、文件观察、workspace MCP、
项目日程和组合文件恢复。各自沿原所有者和回执推进；这些接线不等于完整物理双 Host 验收。

child MCP 保留每个 server 的资源所有者、配置/trust 和精确 definition。local/global 与 managed
贡献可以组合；workspace MCP 使用真实 materialized child cwd，global MCP 保留中性环境。
单个 managed parent Source 可包含多个完整配置所有者；当前不能把任意多个 managed parent
Source cut 合成一份 child 派生证明。这是现有资源映射边界，不是永久禁止更丰富的组合。

## 子任务、结果与恢复

child 受理固定真实父调用、模型/凭据、profile、工具子集和 Source，随后独立准备。
它不继承父策略私有 checkpoint 或任意私有记忆。所选能力不依赖物理来源时可以 source-free。
每个 child 仍使用普通运行时执行与权限检查。
准备进度由原执行记录保存，区分文件列表、捕获、核对、工作区、上下文和启动阶段；已知数量时显示完成数。
本地目录观察失效后在批次边界尽早终止，保留变化路径并释放临时快照；这不替代最终的一致性验证。
`child_cancel` 随协作工具常驻，模型可停止本会话派发的子任务及后代，包括准备阶段；它和界面复用同一取消与清理所有者。
取消回执只确认请求已受理，最终状态仍从原 `child_status`、报告和资源释放事实读取。

child report、固定 WorkingResult 和 executor-stop 分别记录。相关 writer 真正停止后，
原 Storage 才能按结果合同捕获/pin。父 Wait 观察该记录；取消观察不会取消独立受理的 child。
报告固定在原终态 Run 的不可变历史链，不以用户后来导航到的 branch head 取代结果，
报告发布也不修改当前导航。多层 child 的直接父调用与报告访问权限逐层保留。
任务家族消息和历史读取保留真实发送方、祖先和权限；其他 Agent 内容标为数据，不冒充 system 指令。

Agent 用途名、稳定短码、当前／历史目录、独立验证、阶段交接和双向代码交换见[Agent 协作](collaboration.md)。
目录收纳依据原执行、投递和交接事实，UI 和模型尾部共用这份投影。短码负责定位 Thread；
报告、文件结果和复用轮次仍保留各自的原生身份。

应用 child 结果需要显式 Integration，复用原 journal、条件文件写入和 Documents buffer CAS。
它不是自动写回。base、expected、target、safety 都归实际存储所有者，冲突和部分补偿不能隐藏。

对话导航与文件恢复是不同能力，由原 [Recovery 服务](../packages/web/application-host/lib/recovery/DOCUMENTATION.md)
协调。可控制的 write/edit 将 affected-file checkpoint 绑定到原 invocation 的输入和 Source；
任意进程写入没有通用写前拦截，因此不能承诺完整回滚。具体脏缓冲和逐路径补偿规则见
[资源与恢复](resources.md)。

组合恢复先持久化计划、safety 和效果阶段，文件阶段确认后才提交一次历史导航。
跨 Host 时，对话 Host 保存协调记录，各文件 Host 保存原 participant journal；协调端只有
引用和回执，不拥有远端正文。身份在联系目标前持久化，重试恢复同一 participant。
这是可恢复协调，不是跨 Host 原子事务。

取消用短 journal CAS 先记录意图，不排在慢远端观察之后。停止等待并不证明原文件操作已停；
是否补偿仍取原 cancel/read 回执。迟到回复不能抹掉取消事实，不明导航响应要读取原 Catalog
命令回执，不能只比较今天的 head。重开、undo 和清理继续使用这些记录。

## Wait、follow-up 与后台工作

持久 Wait 固定 subject、事件游标和可选绝对期限。提问、child/process/Job、关联回复和上下文
就绪共用接续机制。取消观察、取消操作、撤回未来执行授权是不同动作。
就绪输入进入现有合法 writer，或受理真正的 root/child 接续；普通 Run 事件不授权再开模型循环。

快速检索受理即返回后台 Job，主 Run 继续工作。`retrieval_control` 的 `status` 读取实际最近助手正文
与动作，`wait` 接入原 child Wait，`stop` 取消原调查；取消等待保留调查。结束后的回答由 Catalog
以原任务身份进入父分支消息队列一次，沿当前 Run 的下一闭合边界或原消息激活机制接续。
自动结果携带原 Operation 和真实结束状态；等待只负责唤醒，不重复追加报告。详见[检索](retrieval.md)。

显式 follow-up 保留原指令和来源条件。已有条件包括时间、进程/Job 停止、文件
exists/changed/ready、研究 artifact/collection/log 和机器指标。扁平 Any/All 保存已观察
证据和投递游标；重复 All 配对最早未消费的证据，而非只保留最新快照。
一次性指令不会隐式变成持续授权。

文件 `ready` 表示稳定捕获且无已知 managed writer/lease/process 活动，不证明语义完成或
不存在任何外部 writer。观察断档保持断档，不重建离线 A→B→A 变化。指标使用真实已提交样本，
缺失、过期数据不能当作满足条件或一次 false。managed 连接的唤醒轮询本身也不是文件变化。

Goal 要求明确的持续执行授权，保留暂停、依赖和 usage 预算门控。actual、estimated、missing、
pending 分开；final 或等待到期不能绕过门控。Bot Sleep 挂起原 Run 并排空原 worker，
Wake 重新验证 Bot owner 后释放符合条件的工作，不清除用户取消。

记忆整理使用真实后台 MemoryWork、decision/generation 记录；Memory 服务仍是唯一笔记 writer。
长期工作不会因为临时视图或插件对象释放就丢失，也不会因 Catalog 重开自动复活旧执行世代。

项目定义和 Markdown loop 仍由原项目 scheduler 管理。Agent Calendar occurrence 单独保留
资产 generation、到期身份和 launch preparation。managed `scheduled_task` 在选定 Source
Host 按当前 paired 权限执行；Storage 在 callback dispatch 前提交 begin fence，保存原完成回执。
丢 ACK 时只观察，不重放日程修改；交付后的正文清理不删除调用指纹。
见[日程准入](../packages/web/application-host/lib/kernel/managed-schedule-service.ts)与
[原回执恢复](../kernel/crates/varin-kernel/src/schedule_reconciliation.rs)。

## 上下文准备与压缩

设置 → Agent Harness → 上下文管理中的「时间信息」默认关闭。开启后，新用户消息携带发送时刻；
发送时区可跟随当前设备或指定时区，预览与实际发送共用格式。发送设备提供时刻与设备时区，
Host 按用户全局设置转换并随输入保存；未提供设备观察的 API 输入使用 UTC 或用户指定时区。
时间以环境事实紧邻该条用户消息投递，系统指令前缀保持稳定。同轮工具调用、重试与恢复复用
首次受理的时间；队列编辑保留原发送时间。设置变更从后续新消息生效，历史时间保持原值。

有序 Context Transform 处理独立、不可变的输入，明确区分指令与数据来源；section 身份包含
provider，不因本地名称相同而冲突。它不改已受理历史，也不在 Catalog 锁下调用扩展。
记忆、指令、skills 和材料从准入的 Source/context 所有者捕获，不依当前侧栏推断。

普通请求保留稳定配置与增长历史，现有记忆、Goal 和环境事实按各自机制投递，最后追加临时队友快照。
快照列出当前相关 Agent 的用途名、短码、任务、状态与已有进展；没有相关任务时整段省略。
快照只保留在本次精确 RequestSnapshot 中，不写入分支历史或摘要材料，也不改变工具声明和稳定提示。
结束结果由实际组织者的成功模型请求携带后记录投递，其他队友读到该结果不会提前让它从组织者视图退出。

环境观察在模型容量判断之前准备。模型窗口未知或关闭自动压缩时，编辑、进程、诊断和 Git 等已有观察
仍通过原输入队列与历史边界投递；新到达事实沿下一次边界处理。准备复用原订阅、游标和缓存。
计划内容、更新和删除继续通过模型自己的工具结果及 UI 使用，不增加自动 Zone2 计划投递。

容量准备使用选定模型的已知容量、完整文本/工具序列化的本地估算，以及可用的同绑定成功 usage。
校准核对实际前序请求前缀；媒体/provider 未知成本仍未知，不变成账单或远端缓存折扣。
预留量按当前模型的上下文窗口乘以 `compaction.reserveRatio` 向上取整，默认 10%；设置页的「上下文管理」
可调整全局比例，可信项目与模型覆盖沿用同一配置优先级。输入预算为窗口减预留量，超过预算时在下一次请求前
切换到已完成摘要，尚未完成则等待。后台准备默认从输入预算的 75% 开始，并根据准备耗时与增长速度提前。
最大输出长度参与摘要规划，预留比例独立配置；窗口未知时不推测自动压缩容量。
后台准备不阻塞仍可发送的请求；确实需要压缩的请求在 dispatch 前挂到持久 context Wait。

Agents 设置中的「上下文整理」管理 `harness.models.contextCompaction`：模型默认沿用当前会话，
可以单独选择模型、思考强度、温度与工作指令。自动整理开关控制新自动任务，手动压缩使用同一份配置。
触发阈值、后台准备与预留比例仍在上下文设置中，通过链接打开对应 Agent。规划模型 `agentPlanning`
保留其独立的策略规划用途。上下文整理由 Harness 启动，普通派发目录与对话角色选择只显示可接普通任务的角色。

运行时提供默认工作指令、输出格式、请求与预算模板、`summary_read` 声明；Agents 页面使用这些原始定义
展示提示词组成。工作指令可以替换并恢复默认，输出格式由运行时拼接。新 ContextJob 固定所选模型、参数、
工作指令与原始手动选择；重试、恢复和后续轮次复用已经受理的任务。摘要模型容量用于分批整理，主对话模型
容量和 tokenizer 用于摘要与保留原文的合计预算。

`varin.context.budget@1` 决定何时、在哪个边界压缩；独立的 `varin.context.compaction@1`
提供算法，返回固定文本或 source/node-output DAG。Preview/create 共用原材料加载器；
`sourceCutHash` 固定实际可见正文、角色、记忆/资源及 model budget。完整模型配置与凭据由
launch 另行固定。重开消费已受理 recipe 和 producer/composition，不调用新算法重解释旧工作。

压缩输入包含已有摘要和本次捕获范围内的全部对话原文。上轮保留的原文与后来新增的消息共同参与
选择。内置自动压缩捕获到最新完整工具交换，由模型生成新摘要并返回 `retain` 原文引用列表，原文可以
来自材料中的任意位置。Host 提供摘要与原文合计的预算，沿用现有容量和增长预留；每组材料标注本地
估算 token 数。同一用户输入的各部分、同一模型响应及对应工具结果组成完整保留组，重复引用只计一次。
文本由本地 tokenizer 分词计数。模型元数据可提供编码名称、Hugging Face 仓库及版本、
`tokenizer.json` URL 或执行 Host 的本地文件。Host 按来源准备词表，以内容哈希保存不可变缓存；
请求配置和快照固定词表引用，多个模型可复用同一文件。首次下载在后台进行，当前请求沿用参考计数，
后续准备的请求使用已缓存词表。下载失败可在模型设置中查看，不阻塞会话。
运行时通过通用分词库加载文件；OpenAI 使用 tiktoken 的编码映射，缺少可用来源的模型使用明确标注的
`o200k_base` 参考词表。显式绑定优先于名字推断；自动识别会去除首尾空白、忽略 ASCII 大小写，在名称边界
识别渠道路径、前后缀标签及微调 ID 的基础模型。例如 `vendor/GPT-4O:free` 和
`relay_gpt-4.1-mini/high` 使用已知家族的编码。数字版本不截成另一版本，名称同时指向不同编码时仍用参考计数。
规范化只用于选择词表，发给提供商的模型 ID 保持原值；Hugging Face 仓库、版本、文件路径和 URL 保留大小写。
手填编码名允许大小写、首尾空白与连字符形式，Host 在生成原生绑定时转为标准编码名。
运行中的计数器共享已解析词表，一轮内复用，最后一个使用者结束后释放；
请求片段保留轻量计数结果。磁盘词表使用 gzip，按原始内容哈希标识。Host 在配置变更和旧引用释放后
回收未使用版本，保留当前配置、运行中与排队任务、可继续会话和已派发子任务需要的词表。
压缩请求按压缩模型计数，
保留原文和摘要按主对话模型计数；整请求继续结合可用的真实 usage 校准。
媒体和 provider 专用内容的未知成本单独标识。
已有 `keepRecentTokens` 配置作为原文额度参与合计预算计算，具体保留位置由模型选择。

运行时按原顺序保存所选原文的内容引用，记录摘要与原文合计估算量，并与摘要一起发布 checkpoint。
预算是模型整理内容的目标，实际模型窗口仍由完整请求容量检查负责。普通请求组装新摘要、选中原文和
捕获之后新增的历史；资源与个性化刷新保留这份选择。下一次压缩重新考虑所有留下的原文。
后台新增消息沿原历史追加，原始历史及媒体继续由 ContentStore 持有。分批整理时，各批接收前序摘要和
保留选择及其估算大小，最终模型结果决定本次选择。

模型摘要节点提供只读 `summary_read`：`history` 查询固定来源的 recent/range/search，
`item`／`output` 分页读取原条目和工具输出，`tasks` 查询任务目录，`records` 读取当前跟进、目标和排程。
历史沿摘要捕获的 head，当前记录带观察时间。查询走普通工具调用和原读取所有者，结果保留原审计身份。

摘要角色提示在运行时使用英文，中文对照如下：

> 整理对话上下文，使后续工作能够继续。输入包含已有摘要和附有估算 token 数的对话材料。预算用于新摘要与保留原文的总量。
>
> 根据后续工作的需要，在预算内更新摘要并选择保留的原文。优先保留与当前工作密切相关、概括后容易丢失关键细节的原文，将其他有用信息整理进摘要。保留有效目标、要求与授权、决定及依据、结果和未完成事项；结合后续修正更新旧状态，合并重复信息，删去失效内容，使上下文精炼且足以继续工作。区分用户请求、参考材料、计划和实际结果，按需使用只读查询补充材料。
>
> 返回包含 `summary` 摘要正文和 `retain` 原文引用列表的 JSON。关联的消息部分及工具交换按组保留和计费。分批结果中的选择可以随后续材料修订。

内置 fold 与扩展 DAG 共用摘要 Run。独立节点并行执行，已完成节点立即解锁自己的后继，
不等待同层其他分支。一个受监督的任务拥有就绪队列与取消域，原材料只加载一次；每个节点仍通过
原 ModelStep 保存准备、派发、输出与 usage。数据库按普通会话或摘要节点约束活跃请求，并在派发前
核验声明依赖及完整序列化后的容量。内部摘要历史按完成顺序留下审计记录，后继输入只取固定计划
声明的输出，不以这段历史的先后决定依赖。
文本方案正常完成原 Run，零 ModelStep，只需注册模型的非秘密容量描述，不查询凭据。

发布检查成功完成、祖先关系、取消和 checkpoint/memory CAS。已完成但未发布的候选仍可取消；
过期或过大候选不会替换旧 checkpoint，也不会丢弃未摘要的尾部。已完成摘要可恢复发布，
但不明的模型 dispatch 不自动重发；新请求仍遵守当前 Budget Decision。
入口：[压缩执行](../kernel/crates/varin-runtime/src/context_job.rs)、
[Host 准备](../packages/web/application-host/lib/kernel/context-compaction.ts)。

## 能力组合、模型与授权

设置中的「辅助模型」用于会话标题、Git 提交信息和 PR 说明，未单独配置时使用全局默认模型。
首条用户输入受理后，Host 通过原生文本推理在后台生成标题，当前对话继续执行；生成失败时保留首行标题。
标题写回沿 Catalog 元数据命令核对当前标题与 revision，保留用户在生成期间的手动改名。

Composition 在调用前解析声明依赖和作用域路由。准备就绪的候选在受保护边界发布，
失败或被取代的候选保留旧 active generation；未变化绑定可复用。
普通替换关闭新准入，让持有原 pin 的交换完成；显式撤权取消并拒绝旧 lease。
增删 Host entrypoint 也遵守同一发布/退休规则，不能先拆旧实现再碰运气启动新实现。

AgentPolicy 返回动作和状态，核心负责合法执行与提交。Provider 实现能力，Transform 返回
独立上下文，Decision 在指定边界选择，Observer 消费已提交事实而不阻塞生产者。
策略规划模型使用真正的 model Operation，保留配置和 usage 归属。安装不等于选用；
恢复重建原 dependency graph/artifact，不套用今天的路由。作者合同见[扩展](extensions.md)。

服务可见性和 Source 身份不授予执行。实际 invocation/source、当前 trust、原绑定 generation
和 authority 在执行边界核对；MCP annotation 不能免除权限或副作用记录。
显式关闭 Source 时，先启动真实 process/transport stop，再等待尚未返回的 observer ACK；
完成仍要求原 owner 的实际 drain 证据。详见 [MCP 合同](../packages/web/application-host/lib/kernel/MCP.md)。

[模型适配器](../kernel/crates/varin-runtime/src/providers/README.md)保留各协议的续接和终止语义。
派发前通过[共享 Host 凭据服务](../kernel/crates/varin-runtime/src/providers/AUTH.md)解析认证，
秘密不进入请求快照、公共事件或历史。持久化、HTTP 和 body signing 使用同一份冻结请求字节。

Agent 的渠道、账号与用途设置由 Host [模型服务](../packages/web/application-host/lib/models/DOCUMENTATION.md)
管理，通过领域 API 和配置文件服务设置、发现及登录。渠道目录 ID、实际请求模型 ID、
固定连接和账号身份各有用途；普通配置更新只影响后续准备，明确撤权仍由原执行边界核验。
模型请求快照同时保存当时的渠道目录 ID，用量据此按渠道和模型汇总。已有请求缺少该字段时，只有原 Run 的
连接身份、协议和模型完全匹配才使用其渠道记录；无法确定的归属保留未知，不按当前设置或同名模型猜测。
扩展通过同一 composition 贡献渠道、目录、协议 codec 和认证。耐久 `adapterIdentity` 绑定确切 artifact/组合；
`adapterBindingId` 指向实际活跃实现。原 Run、排队输入及 child 持有原 pin，不按今天的服务名重选。
同账号刷新保留身份，取消等待不放弃真实刷新及保存；网络、用量和实际停止仍由原执行 owner 记录。

Agent [MCP 服务](../packages/web/application-host/lib/mcp/DOCUMENTATION.md) 独立管理配置、账号、连接和缓存。
MCP 原配置决定暴露方式：`direct` 工具及已准入的发现、调用、资源和任务入口直接提供给模型，
通用 `tool_describe` 不再把它们隐藏。`deferred`/`codemode` 的具体工具沿 `mcp_discover` 获取说明、
`mcp_call` 调用，发现结果不会追加到模型的 `tools` 声明；`hidden` 工具沿原 owner 排除。
同名连接整项替换，工具、资源、资源模板和提示目录各自准备；离线缓存不构成执行授权。
HTTP session 失效结束原连接，不重放已派发调用；下一次新 Operation 使用原租约配置重新准备并核对声明。
stdio 沿 Rust 进程服务，Tasks、订阅和交互保留各自真实持有者。旧配置资产不会自动导入或覆盖原生配置。

Run worker 只保留最近的不可变历史前缀，按 epoch/Run/branch/checkpoint/祖先身份复用；
新记忆、Goal 和策略证据仍逐边界投影，导航、checkpoint 变化和 worker 退出会丢弃缓存。
Responses/Azure/Codex 复用独立 item/schema 片段；Chat、Anthropic、Google/Vertex、Mistral、Bedrock、
Pi 按各自协议复用完整消息组。分组还包含工具调用名称、签名和 wire ID 映射等真实依赖；
末组追加或依赖变化只重编受影响的组，当前请求不再使用的组随本次编译释放。
每次调用仍核 lease 和认证；最终组装、序列化存储、hash 和媒体处理仍有成本。
这不表示远端增量发送、普遍降低峰值内存，或已经测得端到端加速。

用途推理沿现有 decision/rerank/embedding 配置与消费者执行，详见[检索与知识](retrieval.md)。
`localBekko` 复用已有本地 ONNX embedding 组件，不是新建本地专用推理栈。

## 图像工具与媒体

Agent 的 `image_generate`、`image_edit` 分别选择生成和编辑模型，不隐式继承对话模型或彼此的配置。
未配置的工具不加入模型工具集合；已配置但不可用则报告准备失败。模型支持的编辑、蒙版和参数能力
参与工具 schema 编译及执行校验，不能由“支持图片输入”推断生图能力。

[Image runtime](../packages/web/application-host/lib/kernel/image-runtime.ts) 在原工具组合边界固定渠道、
请求模型、连接、认证和 schema。后续设置修改不更换在途调用的绑定；恢复必须符合原配置身份。
生成和编辑沿原 Operation、推理请求与用量回执执行，不另建图像任务库。

输入图片与蒙版使用授权资源引用或原 Documents 路径；输出先保存到媒体资源，再返回有序媒体与稳定引用。
临时图片 URL 由原执行方取回，后续编辑保留输入关联。收到的图片即使遇到取消也由原执行方继续保留；
无法保存全部结果时报告部分结果。UI 按媒体合同预览，保存到项目仍经过原文件服务，保存失败不删除已生成资源。
提供方原始用量与缺失值分别保留，不把图片计量强行转为 token。派发后结果不明保持 unknown，读取原回执不会再生成一次。

## 恢复与验证边界

恢复读取原事实与回执。Prepared 但未 dispatched 的请求可沿原受保护路径继续；
已派发却结果不明的模型请求不自动重发。已保留的摘要/工具结果可以继续投递，不重新生成或执行。
外部工作未知时保留原 owner 和相应占用，等待真实对账；新进程 epoch 不使旧绑定自动可执行。

源码和定向测试证明具体机制，不证明全部 provider/平台等价。真实账号、安装包断连/停止/恢复、
实际代理、物理 managed Host、平台进程/桌面行为及规模性能需要各自的相关验收。
按[开发指南](development.md)和最近 owner 的测试选择检查；原生默认路径已经切换，未执行的实机验收仍保持未验证。
