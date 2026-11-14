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

## 可替换的执行循环

`RunSupervisor` 通过 `RunDriver` 调用本次选定的算法。`DefaultRunDriver` 保留原 Rust
`ExecutionEngine` 及 `policy@4` 行为；`varin.agent.driver@1` 则允许可信 Host 扩展直接组织
并行模型、动态工具、独立上下文和交付，不经过闭集 PolicyAction 解释器。外部 Harness 仍沿自己的
会话协议运行，不为形式统一伪造原生 Run。

设置中的“扩展 → Services → 执行循环”复用现有 service routing。用户默认与实际执行 Source 的工作区
可以分别选择；安装一个 driver 不会自动选中它，显式不可用选择不 fallback。选择只作用于新受理的 Run。
Catalog 固定原 artifact、配置、composition、模型角色和恢复合同；普通更换设置不改写既有 Run。

Host 只为原 callback 建立 Run/内核 epoch/instance 的临时调用 scope，原生 owner 再核验实际 Run epoch。
扩展不能通过 JSON 传入另一个 Run、Operation 或凭据来获取权限。公开原语为：

- `model` 自由接收上下文、补充指令和原目录工具子集，创建真实 ModelStep；不同稳定 ID 可以并行。
  默认循环仍保留自己的单活模型约束。driver 内部模型结果是独立回执，不自动拼成虚假的串行对话。
- `tool` 经原 InvocationRunner、工具权限和资源 owner 受理；请求被拒、真实效果、Job 移交与 executor stop
  保持区别。重复稳定 ID 核对原输入并读原回执，不能重发未知效果。异步工具的 JobAccepted 是原调用的
  完成回执，不会被后台结果覆盖；后续状态与输出经原领域读取工具（如 `question_status`、`process_read`）或 Inbox 读取。
- `context` 显式消费原 Inbox，并重新编译当前指令、资源与工具视图；不建立第二条输入队列。
  原 Agent/Bot 指令已经在编译后的 history 中，不把来源标识当作系统提示词。
- `wait` 订阅原 Catalog 事件后重读本 Run 事实，以 cursor 等待活动变化；`after:null` 只取基线。
  `work` 选择返回的原工作回执，不过滤唤醒原因。自行根据返回条件继续等待是事件驱动，不是轮询。
- `cancel` 只向本实例所指原模型/工具提交停止意图；`receipt` 读原事实；`deliver` 才提交用户可见输出。
  `checkpoint` 在原 Catalog/ContentStore 中追加私有状态和本 Run 的真实工作引用。
- `finish` 在仍活的 callback 内尝试原子终结。它真正提交原 Catalog 完成/失败事务，不是先检查再提交。
  `input_pending` 或 `work_pending` 保持原 scope 可用，由作者消费新输入或等待真实工作后决定下一步；
  `committed` 才关闭新原语。最后一次 `context()` 不能消除其后到达输入的竞态。

算法正常完成/失败须先得到 `finish` 的提交回执，再结束 callback；单独返回 `complete` 不授予终结权。
逻辑终态不等于 callback 已停：Host 终态轮询不能抢先卸掉仍活的原 driver/凭据/工具，原 worker 实际退出后才释放。
callback 结束关闭新调用，并唤醒遗留的观察等待，再排空已受理模型和工具。
私有 closing 通知不是 executor-stopped 回执。普通 provider 退休保留原 pin；撤权立即禁止新能力并请求
原 Run 停止。旧内核退出但原 Host callback 尚未结束时，不能在新 epoch 并行启动同一 Run 的恢复。
可信 Host 代码仍不是 OS sandbox；Varin 的 capability 与资源合同不声称拦截任意直接系统调用。

恢复声明为 `none` 或确切 schema 的 `checkpoint`，后者必须实现独立 `resume` callback。
恢复只重建原仍受信且未撤权的 composition，读取原 checkpoint 和模型/工具回执；不调用当前默认算法、
不把 `run` 重跑当作 `resume`。当前不提供跨 artifact/schema 的自动迁移或活动 Run 原地换算法。
旧格式 Run 在原存储事务中固定为历史内置 driver，而非打开应用时的新默认选择。卸载扩展不删除 Run 证据。

第二种算法见[parallel-driver](../examples/extensions/parallel-driver/README.md)：两个独立模型并行，
较早分支立即执行真实只读工具，汇合后显式消费期间的新输入，再用独立上下文综合并交付。
这是一种作者算法，不是平台强制的阶段或工作流。

## 模式、工具披露与协作

`general`、`code`、`research`、`office` 分别表示通用、Coding、科研和办公。未显式指定的新会话默认通用；
已有项目和 Agent 的选择保持原意。模式选择默认直接披露的工具，不注入平台模式提示词。用户指令、项目指令和
预制自己的说明仍由原上下文机制提供。

Rust 在请求准备时固定 `direct_tools`。provider 函数列表、调用校验和目录中的 `directlyCallable` 使用这份集合；
完整可执行目录仍由原声明拥有。搜索和分组查询给出用途与前置条件，名称查询提供用法，复合工具可按真实操作读取完整契约。
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
标题优先选择设置中的辅助模型。首次输入受理后后台命名，之后按完整用户回合的间隔重新判断；
Catalog 持有命名方式、已检查轮次和冻结的历史位置，Host 只合并并发观察。Host 启动或内核重新就绪后，
沿原始辅助推理回执恢复未完成检查；已发送或结果未知的请求沿原回执处理。手动命名切换为手动方式，
即使文字相同也保留用户意图；置顶等元数据更新不影响标题检查。新增标题域在 Catalog 打开时一次性初始化，
已有会话从当时轮次开始计数，保留可从原命令及子任务关系识别的手动名称。

“对话默认 → 自动重试”配置当前 Host 的模型请求重试；默认值、匹配与退避由
[模型服务](../packages/web/application-host/lib/models/DOCUMENTATION.md)和
[model_retry.rs](../kernel/crates/varin-runtime/src/model_retry.rs)维护。
服务端 `Retry-After` 是独立的最低等待时间；规则测试使用同一原生匹配器，不访问模型服务。

活动执行者在本次请求结束且回执提交后决定是否重试；内核重启或丢失受理/结算 ACK 仍只核对原记录。
普通对话和压缩节点为新尝试建立独立 ModelStep，复用原输入、模型与渠道，不重跑已完成的工具。
辅助文本在原 Operation 内保留各次失败、部分输出和用量，再单独生成下一次结果；每个付费边界重新核验
父任务、Goal 与凭据。停止会立即结束重试等待。没有上报的用量保持未知，不用成功尝试的数值覆盖。

删除会话会隐藏 Thread 并请求空间回收。已受理的任务继续履行原来的执行和结算责任；Catalog
等 Run 结束、实际执行者停止、模型请求结算后，清理该会话拥有的历史、请求和回执。其他会话
分支仍引用的历史与关系记录继续保留，随后由 ContentStore 释放失去引用的正文和媒体。
Thread、branch 的小型身份、创建证据、Bot 直接绑定与删除回执保留，支持稳定身份与删除重试。
创建证据只保存初始 branch、创建域及已知 Bot，不复制 principal；principal 始终由原 Thread 管理。
正文回收不删除 fork 的小型创建输入。显式删除 Bot 同样保留不可再分配的身份，但清除标题、置顶、标题进度及历史 head；
保留的 Bot 绑定不能绕过关闭或缺失的执行 gate。旧库已经回收的绑定不按名称、profile 或 ID 前缀还原，
未知旧身份仍可枚举和清理，但不能被当作普通 Thread 获得执行权限。
Bot 入口由 Catalog 原子核验原 principal／Bot／初始 branch 后选择可用的直接会话或创建新会话；
Host 只重试同一解析请求，不在响应未知时换 UUID。返回旧创建回执不代表当前会话仍可发送。
日程受理身份独立于可回收的 occurrence／input 正文；旧 key 返回原记录或明确的 identity-unavailable，绝不重新触发工作。
“立即运行”在首次分配 key 时固定原定义的不可预测手动 key 前缀，
刷新、同一 Host 重连或失败重试不改旧 key。回执已回收时，界面提示旧操作可能已执行，
只有用户明确确认发起新操作才放弃旧 key；关闭或切换任务上下文不视为确认。旧客户端仍能读取已知回执；没有前缀且证据已丢的旧请求明确拒绝，
新用户操作使用当前前缀仍可在原日程上受理。自动计划的 cursor 和已消费时段不回退。Host 在启动、删除和
后续持久执行事件中推动回收；正在读取内容时沿原有读取保护延后执行。
排空通知只在原执行者确实被移除并完成收尾时发出。对已排空 Run 的重复检查不建立执行屏障、
不再次唤醒维护，避免删除维护在无新变化时循环创建材料访问授权。Storage 按 Run 的派生索引查询
其授权记录，任务收尾不扫描其他会话和 Host 材料读取留下的授权账本。

一个分支只有一个历史提交者。独立工具、子 Thread 和后台工作可以并发，不因此创建第二个
向该分支提交的模型循环。项目归属、Source、策略选择和执行权限分开表达；显示路径或调用参数
里的 Thread ID 不能授予访问权。

## 会话组织的原存储边界

组织领域与原生／外部会话共同位于 Catalog，按原可信 principal 分区。它保存容器身份、单父位置、顺序、
局部 revision、初始化代际与受理证据，不保存第二份聊天、归档状态、项目设置或 Bot 档案。
移动在同一事务验证原位置、受影响父节点、同级锚点与祖先环；不相关分支无需争抢全局目录 revision。
全局 revision 与原事件 cursor 用于观察追平，分页绑定完整查询及排序代际，过期后明确重读。
混合节点分页同时计算容器与会话；页内 `items` 决定顺序，附带的祖先容器只提供路径与修改上下文，
不冒充已加载子项。旧的仅会话分页合同仍可读取原续页。搜索使用原 Settings 的项目名称，
名称索引只经可信 Host 边界提供，不接受客户端自行覆写；相关项目改名使旧搜索续页明确失效。
模型可以携带多次目录读取的 observation，组合不同页中实际读到的对象与父容器版本；
受影响对象的版本互相矛盾时要求重新读取，不在提交时偷读最新版本冒充用户已见事实。
已解散容器的身份被保留为退役身份，旧稳定引用不能重新指向另一个同名组。

首次初始化只消费已成功核验的项目列表与原会话投影，保留多项目关联，无法唯一定位的会话留在根。
后续读取不重新归类已整理内容，旧客户端 Settings 数组也不能解释为删除共享分组。
Host 项目注册与 Catalog 分类是两个原 owner 的提交；第二步失败保留已登记项目并可用同键续办，不造假回滚。
组织命令先核对原回执再检查当前项目登记，已受理请求不因后来的项目移除被误判成从未执行。

## 持久受理与执行生命周期

[Catalog](../kernel/crates/varin-runtime/src/catalog.rs) 通过独占 owner 锁管理 `conversation.sqlite` 的 writer，
使用 SQLite WAL 与 `synchronous=NORMAL` 短事务。原始内容先写入 ContentStore，再提交引用它的记录；
断电可能丢失最近提交，但不能留下引用尚未写入正文的记录。ContentStore 与 Storage 的耐久合同各由原 owner 维护。

初次安装在同一事务建立内部域。已有数据先只读检查格式和结构，再由
[原升级器](../kernel/crates/varin-runtime/src/catalog_upgrade.rs)处理支持的版本。
转换、格式标记和升级事件一起提交，随后才推进 epoch 和恢复执行；失败回滚，不重建用户历史或重放已派发效果。
支持范围不在文档中复制；资产保护与未知格式处理见[架构](architecture.md#数据与交付)。

用户输入与命令 key、分支前置条件、选定配置和受理回执一起提交。相同重试返回原回执，
冲突复用 key 则失败。排队输入保留受理时的配置和 revision；编辑、interrupt、next-Run
交付沿同一输入队列执行。后来更换模型或设置不能反向改写已经受理的工作。

待下一轮发送的用户消息可显式“立即发送”：Catalog 按原输入 revision 和当前 Run 身份，原子地将同一输入
移入当前 Run，并撤销尚未启动的后继 Run。正文、媒体和材料引用保持原样。插话与“立即发送”都只排队，
不打断当前模型生成或工具执行；当前工作自然完成后，在下一次模型请求的输入边界交付。重复请求读取原结果，
不会重复交付。消息已交付时返回实际交付记录，
被编辑或取消的排队消息按真实状态处理，不通过取消后重新提交来拼装此操作。

Run 从 accepted/preparing/runnable 进入生成、工具执行或等待，最后明确完成、失败或取消。
等待必须指向实际对象并保留接续身份。Supervisor 先返回控制句柄，再由 worker 加载历史和
准备资源。只有本次选定工作依赖的能力需要准备，不设“全部服务就绪”的全局门槛。

模型准备固定语义上下文、实际 provider 请求、模型/连接身份、工具 schema 和执行绑定。
`RequestPrepared` 与 `ModelDispatched` 是先后独立的持久事实。默认循环的模型输出、不可变历史及
未结算工具调用一起按预期 head 提交；基于旧 head 准备的请求不能发布到新历史上。driver 的模型结果则保留为独立原始回执，
由显式 `deliver` 在原分支 owner 上追加输出，不把多个并行请求伪装成同一个历史提交。

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
业务 owner 可以在原 `data` 旁保存固定的 `model_data`，不改写原回执。公共 Provider 组合只展示选定的业务数据和有序正文／媒体，
没有数据时省去空包装；空对象、空数组、false 和 0 仍是业务值。来源类型继续决定角色与可信边界，不在每份结果和图片旁重复整个执行链。
模型短引用沿原发布关系固定，用户文字、业务 JSON 和图片顺序保持原样。展示预算先针对原 `data` 或 `model_data` 生成正确回读路径，再映射到适配器的统一可读字段。
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

压缩任务固定可读原材料与独立的来源映射：文字保留原文，工具保留动作、参数与实际结果，媒体保持原有顺序。
真实历史项、投影部分、回读目标与保留组由原 owner 冻结，不能从模型标题反向解析；同条用户输入的正文、引用与图片整体保留。
长材料的分片按固定文字的 UTF-8 边界切割，不再把整段历史 JSON 二次转义。整理输入用整理模型的 tokenizer 计量，
保留成本则按主模型完整可见交换计量，不把仅供恢复的 raw data 再算一遍；原记录与媒体依然完整保留。
新配方持有这些小映射，旧已落盘配方仍沿原分片、组号与计量执行，重启不重新解释或重放模型请求。
公共 `varin.context.compaction@1` 继续只接收原 `{sourceId,item}` 合同；Host 不向既有算法扩展传输私有映射，正文、来源切点 hash 与范围坐标不变。

上下文 checkpoint 保存已发布摘要、指令、记忆/资源及来源边界。新记忆可作为后续请求的投影，
不改写原历史。Knowledge/Memory 仍是笔记写入者；Catalog 只记录观察和请求投递证据。
只有原记忆操作的确认回执可用于去重，失败请求不表示已经交付。

显式历史导航先在锁外准备祖先和合法工具配对，再原子提交 head CAS 与命令回执。
新的回退在同一事务中为原 head 保留一条 HistoryBranch，共享不可变历史，并保留当时的上下文、记忆状态与已捕获计划。
这条路线可以在继续输入及重启后重新打开；相同导航命令的重试复用原回执。文件与外部执行效果仍沿原恢复机制处理。
`runtime.thread.tree` 在独立只读事务中合并存活分支的祖先，按轮次及分岔边界返回结构，正文由原历史读取能力按需提供。
重复命令不会回退后来追加的工作；undo 使用原回执。导航不重写 Run、效果或 usage，
也不恢复已取消的 Goal。跨过摘要边界只清除该摘要对应的上下文基线，不删除实际记忆。

## 读取与观察

[Catalog 读取连接](../kernel/crates/varin-runtime/src/catalog_reads.rs)与 writer 分离，使用只读、query-only WAL 事务。
连接不取得 writer 所有权、不运行恢复或写入 hook；入口与返回时核验原 epoch，读完释放快照。
[读取调度](../kernel/crates/varin-kernel/src/agent_catalog_reads.rs)只分派明确的只读方法，其他操作仍由原 writer 串行受理。
组合读不能在事务中等待模型、Host callback 或可变 Catalog；内容租约保护锁外读取与并行 GC。

[thread.view](../kernel/crates/varin-runtime/src/catalog_thread_view.rs)在同一快照返回当前历史窗口、队列、Operation、
上下文、子任务、Goal 与原 event cursor，Host 只补自己拥有的策略准备、默认值与恢复状态。
`afterHeadId` 仍在可证明的当前窗口内时返回增量，否则回到完整窗口；它不限制历史长度，也不改变显式的旧历史分页。
列表变化通过 `inspectMany` 读取受影响的身份；隐藏、删除或不存在的条目不伪造空记录。
[上下文检查](../kernel/crates/varin-runtime/src/catalog_context_inspection.rs)也由 Rust 组合读取：
按原 branch/head 复用不可变祖先计数和请求 composition，读取时仍核验选定 head 的当前祖先关系；
可变 usage 回执重新读取，不被历史缓存冻结。Host 不再维护另一个扫描历史的 inspection owner。

持久事件在原提交事务写入明确的 `thread_id` / `branch_id`，全局事件用 null；
[事件作用域](../kernel/crates/varin-runtime/src/catalog_event_scope.rs)由生产 owner 决定，不从事件名字或不透明 payload 猜测。
[Host event hub](../packages/web/application-host/lib/kernel/event-hub.ts)共用一个原生持久 reader，并为每个观察者保留 cursor、
主体可见性和进度兴趣。落后于内存 replay 窗口的观察者从 Catalog 追平，缓存大小不是交付或历史上限。
兴趣变更只影响自己的活动观察，不扩张读取权限；断线、慢消费者退出和取消观察都不取消已经受理的执行。

[客户端总线](../packages/application-client/src/thread-observation.ts)按 Host 共享连接与重连，按 Thread、branch、事件种类分发。
订阅就绪和真正重连触发 resync，关闭初始读取与连线间的缺口；增减进度兴趣不重建连接。
UI 的持久投影合并同一轮失效并保留未变化对象，临时流式输出独立按 request 更新。
持久输出只清除对应 request 的临时片段，序列缺口回到权威快照，而非把缺失片段当作成功完成。
具体投影与渲染归属见[UI 说明](../packages/ui/DOCUMENTATION.md)。

## 工具、资源与真实回执

文件与代码检索、进程与脚本、协作、对话、网页、图像生成与编辑、交互 HTML 以及资源读取属于常驻工具。
语言服务器由 IDE 使用；模型的结构读取通过 `file_read` 按需调用 Tree-sitter。
常驻选择取决于工具职责和工作模式，原生和扩展实现使用同一规则；本次可用的声明在请求准备时直接提供给模型。
`tool_describe` 省略参数时从本次冻结的完整目录生成全部可用分组，包含全部工具已直接声明的分组。
`toolCount` 表示组内全部可用工具，`directToolCount` 表示其中本次已直接声明的数量。
`namespace` 浏览分组，`query` 默认返回简短候选；名称、操作、参数中的对象词及声明者的别名参与本地排序，
常见中英文术语、大小写与标点可归一。多个词按相关性排序；查询只描述当前目录的命中范围。
精确名称可直接读取用法；`names` 批量读取。普通工具返回完整参数、必要的结果语义、版本引用与调用入口；
Office、浏览器、材料等复合工具列出原接口的操作，`operation` 可直接读取指定操作，无须先浏览目录。
视图保留共同必填项、引用定义和分支互斥约束，执行仍由原工具验证原 schema。`detail: full` 可读取原完整契约或整组说明。
公共调用规则只在网关说明中出现，单项说明保留当前目标的差异，不附带内部服务和调度信息。

披露按请求冻结的可见输出预算组织，候选和批量详情按完整条目续读；`next` 沿同一入口继续，目录变化时明确提示重新查询。
原契约过大时返回明确的概览及 `path` 结构阅读入口，结构按节点继续，超长原始值可按精确 JSON 文本片段读取。
概览、完整操作、原始结构和文本片段保持区分。读取参数不依赖从 `read_thread` 中拼接被裁断的 schema。
索引随原冻结声明生成并复用，不连接全部 MCP 服务、不引入检索模型或持久披露账本。分组只负责导航，工具可自由组合。
这些详情追加到工具结果和历史中，模型的工具声明列表在披露前后保持一致。

真实执行目录独立保留已授权的原始声明与端点。只有本次模型 `tools` 中已声明的函数允许直接调用；
未声明的目标必须通过已注册的 `tool_invoke`。协议解析与执行前校验共用这一边界，包含扩展模型适配器。
`tool_describe` 返回名称、参数、是否已声明和调用模板；读取说明不注册新函数。实现入口为 [tool_disclosure.rs](../kernel/crates/varin-runtime/src/tool_disclosure.rs)，
[execution.rs](../kernel/crates/varin-runtime/src/execution.rs) 在模型调用受理时仍按原快照核验直接调用集合。
选定操作后，调用模板从该操作的原参数契约提取固定参数值，使用工具真实的 `action`、`view` 等字段；查询用的 `operation` 不会冒充调用参数。
`settings_search` 默认返回简短目录与 `settings_read` 入口，精确 id 或显式 `detail: full` 才附带完整字段契约；分页返回可直接继续的 `next` 参数。
通用入口使用 `tool_invoke({name, arguments})`，按名称解析本次请求冻结目录中的工具；不要求模型提供版本，也不要求先读说明。
执行绑定和参数校验来自原目录，不能越过 Agent 的工具选择。未声明、目录不可用、调用格式错误和参数无效使用独立错误码。界面显示工具名和修正方式，
不复制调用参数或服务端任意错误正文；新错误在会话、工作概览和协作聊天中使用同一组本地化说明。
已关闭、未配置的扩展能力在配置 owner 准备阶段过滤；源依赖沿原 Source 准入，Goal 报告只在绑定 Goal 时可用。
首个模型请求等待当前选中扩展完成准备，后续配置变化仍在请求边界发布。通用模式将已启用的 `research_search`
保留在完整执行目录及研究分组中，按需读取说明后通过 `tool_invoke` 调用；科研模式将它直接声明为常用工具。
`research_decide` 已移除活动声明与专属实现，历史工具回执仍可展示。
Host 将科研模式的展示选择固定在工具元数据中，原绑定恢复时保留该选择；新 Run 按其实际工作模式重新准备。
工作模式决定展示方式，各工具的配置与后端就绪状态决定可用性；披露说明不会动态改变模型工具列表。
已声明函数的直接调用进入原 ModelStep 工具执行流程；`tool_invoke` 按名称解析目标后进入原嵌套调用流程，
实际目标继续执行自己的参数校验、权限检查和资源准入。包装入口保留持久父记录，目标 Operation 独立保存
效果、停止证据和 Job 句柄；返回的文字与媒体保留原输出类型。隐藏能力更新不改变模型工具前缀或本地编码复用键。
子任务委派说明也通过 `tool_describe` 返回，不随目录变化重写系统前缀。
派发读取原始请求时沿 ContentStore 的 snapshot 读取入口解析媒体引用；存储的 `content_ref` 与执行用的媒体字节分属各自阶段。
媒体历史可用于普通派发及快速检索，`inheritContext` 只决定是否把对话背景交给子任务。

失败的工具结果共享 `error:{code,message,details?}` 投影。直调结果、`tool_invoke` 返回数据与脚本 `tools.invoke`
receipt 都能从 `error` 读取；原 `kind/outcome/effect`、目标名称、operation、completion、正文和媒体继续保留。
`NotDispatched` 保存结构化错误及原 reason，持久化和对象回收后续读仍保留详细原因。取消沿原取消状态表达。
成功正文中名为 error 的普通属性不改变原执行状态；扩展与 MCP 的自定义正文也由其实际协议状态判断。
错误码缺失时使用通用失败码并保留消息，不通过解析任意消息前缀猜原因。

嵌套调用在目标工具绑定、计划或准备阶段的明确拒绝返回 `not_dispatched` 回执，不会因参数错误中止整个脚本。
调用身份冲突、环境关闭和通信错误仍拒绝原调用。扩展参数诊断按已选择的操作分支汇总必要字段；输入来源的互斥关系
作为可选形式说明，不堆叠无关分支的错误，也不输出调用者填写的值。
文件写入和定时接续的模型回传省略原生安全描述符及扩展属性字节；文件版本、恢复快照与 Catalog 原始证据保持完整。
接续文件状态额外说明内容、权限或元数据的变化，避免精简后的相同内容摘要掩盖权限变化。

所有工具进入同一份冻结的声明/端点目录。一次绑定保留其 ModelStep、policy node 或
nested call 来源，贯穿准备、资源准入、授权和执行；模型批次直到工具结算都持有实际端点。
普通查询可使用可取消句柄，不为每次读取先制造持久 Job；需要恢复的工作和副作用保留原 Operation。

启动重绑更新基础目录时，已就绪的服务候选会沿当前基础目录重新准备，并保留原服务持有关系直到交接完成。Catalog 先更新、执行目录后安装的间隙也可接收候选，由安装阶段补齐实际目录；模型请求仍在闭合边界切换。

普通 Run 的后续执行和重启恢复使用当前准备的工具目录。工具说明与目录版本独立于 Run 的模型、
来源和 Agent 身份；旧声明不会阻断队列、日程或准备失败后的继续执行。每次历史请求仍保留当时的
工具与参数，恢复沿原回执闭合已发生的工作，不通过重发模型请求或重做操作来适配新目录。

[资源准入](../kernel/crates/varin-runtime/src/resource_admission.rs) 一次取得完整资源计划
和计算容量。冲突请求保持先后顺序，无关工作可以绕过阻塞；已绑定的 local-compute 按真实
任务家族调度。等待容量时不能先占文件资源，慢准备不能占公共控制通道。
这是共享硬件上的逻辑隔离，不是独立 CPU、磁盘或物理故障域的保证。

Linux Host 的科研资源探针读取本进程 cgroup v1/v2、可见祖先 quota/cpuset、内存与 PID 限额，
`capacity` 表示有效上限，不再把宿主机总量当容器容量。`system` 保留物理容量、探测来源、范围与
降级原因；内存/PID headroom、CPU throttle 和 OOM 累计事实进入带时间的 sample，缺失值不造零。
不可见祖先、外部进程和采样竞态仍由实际 OS 约束，逻辑准入不能承诺硬隔离。

`VARIN_RESEARCH_RESERVE_CPU_CORES`、`VARIN_RESEARCH_RESERVE_MEMORY_MB` 是明确的 Host/后台
保留预算，未设置为 0，不根据某个 worker 猜内存成本。科研预算先从有效容量减保留，再减耐久
commitment；当前可读内存 headroom 另外约束新请求，不把真实 usage 和 commitment 重复相减。
容量下降不重写已确认回执。PID 目前只观测 Linux task 数（包括线程），不虚构每任务固定 PID 成本。
这些预算不是 shell、模型、LSP、扩展等所有子进程共用的全局 semaphore。

Rust 继续用同一 `configured_compute_capacity` 连接原子准入和 ComputeManager，默认取
`min(available_parallelism, 2)`，显式覆盖用 `VARIN_COMPUTE_CONCURRENCY`；另保留后台索引 worker。

默认模型工具批次先建立全部原资源排序意图，再分别通过 Ready/Resolve 准备通路完成同步 owner
准备和首次授权。每条准备通路采用硬件派生的 worker 预算（单核 1，否则 2），未派发结算另有
同规模预算；慢 Resolve 不占 Ready 通路，取消未开始项不调用其 owner。完成准备但等待资源或
计算容量的调用由原 Run 线程通过合并通知驱动，不为每个等待项保留 OS 线程。准备线程完成并
join 后才复用名额；实际执行与 nested callback 不持有准备名额，不引入嵌套调用的全局 semaphore。
首次 watch/authorize 仍是同步 owner 回调；同一批次的 Ready 授权都挂起时，后续 Ready 会等待准备
名额，不能声称任意权限交互都能被无界越过。其他 Run 使用各自准备预算。

全计划原子准入、冲突顺序、family 轮转、撤权 watch、派发前授权、持久 dispatch/settlement 和
unknown handoff 仍经过同一 owner。该边界不是工具数量上限：队列数据仍为 O(N)，每个 Run 仍有
原同步执行线程，policy graph、driver、nested 的同步入口仍可能占用调用线程。逻辑容量不等于
整个 Host 的线程/RSS 总量上限。`family_capacity_review` 中显式忽略的
`measure_real_engine_queue_cost` 探针测量真实 Catalog/Engine 配受控 executor 的队列、RSS、独立
工具完成和取消 join 成本，不能代替完整容器/模型/索引混合负载基准。

Operation 分开记录阶段、业务结果、效果和取消。效果可以是 none、dispatched、partial、
confirmed 或 unknown。外部回执另带原执行者 identity/epoch 和真实 `executor_stopped`。
成功文案、空占用表、HTTP abort、丢失的进程响应和取消意图都不能替代停止证据。
原生进程与 managed Source 所有者遵守同一条规则。
原执行者已确认停止但业务效果仍 unknown 时，恢复可以按该原回执闭合工具配对，
不能因此把效果改为成功；没有停止证据的 unknown 仍保留原占用和待结算责任。

取消先留下事实，再推进依赖清理；控制唤醒不依赖正文读取完成。绑定准备保留原 Cancel 或
Bot Sleep 路径，不能把已知取消改写成无关失败。已发出的副作用仍由原执行者结算。
迟到回执不能清算新 Run 或替换后的资源；不明结果保持可查询，不自动重放。

期限按实际 owner 区分：排队/开始期限只有在尚未派发时才能产生 `not_dispatched`；执行期限必须
由原执行 owner 接受并冻结；观察 timeout 仅结束当前等待；stop grace 只限定等待真实停止回执的
时间。Host 实现全链 stop deadline，不给所有 Run 增设统一 queue/execution TTL，
也不对长模型流套一个硬总时长。已有 durable wait、进程等待和观察取消保留原语义。
重启后的未配对交换不会自动重放已派发、结果未知的调用。明确取消可结束普通 Host
`Result` / `Run` 寿命调用的前台观察：按原未知结果配对并真正结束 Run，允许随后新工作；
这不代表取回丢失结果或确认原执行者已停止。旧版本缺失的结果正文只补充“结果未记录”的事实。
原 Operation、owner/epoch、未知效果与资源占用继续保留，attention 仍展示未结算工作；
迟到的原回执可正常归并，只有真实停止证据才能释放原 reader 或 Source 清理屏障。
空资源搜索不会阻塞新搜索，原有冲突资源仍须等待。独立 Job、进程及订阅不采用此前台取消边界。
`tool_invoke` 的内核网关在重启后按中断失败闭合，嵌套 Host 调用保留各自未知事实和占用。
取消结算只恢复原工具批次和历史，不重新准备模型、工具或 Source 执行权限。
正文暂不可读时保留取消与回执；正文修复后可再次取消重试，
原回执变化也会重新检查，未变化的失败边界不会自行循环读取。

脚本嵌套调用复用 ToolDirectory、授权和资源准入。回执关联外层 invocation，不能伪造模型
tool/result 对。持久脚本、PTY、研究 Job 和 MCP Task 各有实际寿命和输出所有者。
`tool_describe.invocation` 给目标的实际调用入口；通用网关和脚本的包装规则在发现入口及脚本环境中说明一次，单项详情不重复教程。
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
外部 Harness 的产品会话、输入、原生 session 绑定和 transport 回执仍由协调 Host 的原 Catalog 管理。
跨 Host 来源冻结完整 `executionSource`，不把目标 cwd 交给协调端 spawn。目标 Host 的原
ExternalAgentsService 解析实际安装程序、profile、版本与环境；环境凭据留在目标。原 Source authority
使用 typed `external` scope 和 `external_harness` purpose，绑定 conversation、transport、process 与真实物理根，
不伪造 Run。字节流、stdin、停止与进程树证明复用 managed Source 原进程资源 owner，四种 Harness
协议适配器仍在协调端使用同一 transport。

Catalog 的 pending／bound transport 保留不确定 dispatch 的原地址；重连先停止并核验旧 executor，再以新
transport 续接同一原生 session，不能把旧 stdout 重放到新协议 peer。无进程记录只有在原 Storage 关闭
scope、撤销 grant 并证明 late spawn 无法受理后才可记为 not-started。断连、删除与重启后清理同样核验
原 receipt，不能以 HTTP abort 或空内存表宣称已停止。确认进程树已停止后，原 Storage 释放输出 spool；只有停止与输出释放均确认才关闭 transport 回执，丢失回应仍以原身份重试。跨设备文件输入通过原 Storage immutable capture／
attachment import 传递字节与目标只读文件视图，不把协调端文件路径作为目标能力。


普通项目来源准备继续使用原目录，不自动启用系统挂载或把旧会话切到另一份文件。显式选择的挂载后端沿原来源准备与受理边界交接，重试保留原输入身份；导航切换不代替来源选择。
项目绑定还固定目标 Documents workspace ID。新绑定和路径变更由原 SourceDirectory 准入；派发时重查
登记项目、完整 resource owner 与原路径，根注册变化明确失败。远端 `isolated_write` 的能力检查与物化
由目标资源 owner 完成，不用协调 Host 的本机 backend 判定另一台设备的能力。
分类和历史读取不调用这条准备路径；已经准备的 Run 不因项目树移动而重新选择来源。


固定捕获的 saved-files/surface-drafts、Git 语义、来源闭包和文件一致性由
[资源合同](resources.md)解释。连续目录观察只用于名称清单；正文复用另由原生文件身份、change time 与已验证对象身份决定，不能只看 mtime/大小或 Git HEAD。
同一有效观察代的首次物理来源准备共用捕获，提示缓存不持有正文引用。已管理来源直接切分原生工作区，未变数据与属性共享，父任务继续推进；新隔离写入不再首次写入物化整库。保存的逻辑 Source 在 Host 重启时重挂，实际路径和 generation 由当前资源 owner 给出。

会话删除的材料回收计划同时选择可回收的派生来源。保存的 Run、子任务背景、阶段来源、外部会话和编辑器均参与保留；尚无 Run 的来源准备归真实 Thread，删除时取消并等待实际退出。
Catalog 的短清理声明阻止并发加入新的保存引用；Storage 负责实际读写、进程、挂载及版本的释放。忙资源沿原记录等待真实 idle 事件，不按轮次完成或目录年龄删除。正文、属性和清理声明在各自最后引用结束后回收。

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
目录收纳依据原执行、投递和交接事实，UI 与按需模型查询共用原 owner。Agent 短码定位同一会话，`短码/序号` 定位一次受理工作；报告、文件结果和复用轮次保留各自原生身份。

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

### 长期事件安排与接收

Catalog 的 `followups` 同时保存原工作的条件接续和显式 Bot 长期安排。后者可无 `source_run_id`，
创建 Run 只是溯源，不是长期定义的生命期。旧条件等待不因创建者属于 Bot 而升级成持续监听。
定义保存原 principal、Bot、实际目标、来源账号、处理意图与时机；接收和运行不依赖当前 UI 选择。

插件来源身份包含 principal、扩展／来源、连接及真实账号；远端来源另固定 Host、受管连接与 endpoint identity。
接收将正文／媒体写入 ContentStore，在短 Catalog 事务里发布引用、稳定事件身份、匹配与游标。
只有该事务确认后才向来源确认。重复事件复用原记录；同对象的新修订保留为新事实。来源游标 CAS 防止在途旧读取覆盖新位置。
重读不变状态、空轮询不生成永久事件正文。插件离线、账号替换和无法补拉的覆盖范围是独立来源状态，不等于没有变化。

共享连接保存一份事件账本，各关注保留独立匹配位置。暂停者不影响其他使用者，恢复时仍可匹配共享账本中的未见变化。
即时、固定窗口、Calendar 到期和被动方式共用 occurrence 与原 input queue。批次冻结实际事件集合、目标和输入来源；
之后到达的内容留给下批，后续改目标或 sender 映射不改写已交付输入。多目标分别保存交付关系，正文共用。
处理时机变更会沿原输入／external turn 的未消费撤回边界取消旧批次，再以事件原接收时间重新计算时机；
已消费或已发送的批次不重排。显式现在处理同时提升未入队的被动批次和已排队输入，保留实际暂停状态。
Calendar 的关联到期只选择事件批次，不再额外提交另一份相同日程提示；不执行的空批次记录为 `skipped`。
暂停、提问、Goal 门控、Bot sleep 与原取消仍由原 ingress／activation 决定，不新增平行 writer。

接续输入围绕安排原意、真实触发事实和结果组织。进程／Job 的业务数据与正文、媒体分别呈现一次；受理结果中仅与同一 Job 最终结果相同的部分被替代，未重复的业务材料保留。
实际停止、结果未知与效果状态仍明确表达，回执身份、代次和原 Job 绑定留在原记录。接续引用在 Catalog 捕获边界登记，正文在锁外加载，发布保护跨越准备和准入，重试与 GC 不重分配已发布的对象引用。
事件来源、可操作的对象／发送者标识及业务内容只呈现一份；内部去重标识、路由和安排代次不进入模型正文。

事件合并发生在实际输入消费边界，不把多条关注合成一个无法单独控制的队列身份。原生输入批次共享重复事件正文，
各 input、occurrence、处理意图与消费回执分别保留。准备结果提交时重新核对各原输入及 hold；期间撤回任一输入，
本次准备失效后按剩余输入重新构建。冷启动先登记的唤醒输入也参与第一次边界：在尚无 model step 时同步更新
其历史展示和 worker 内存；已有请求的历史前缀不再改变。历史保存本次固定表示，原输入及 ContentStore 依赖保留原文，
重启和重读不会因后来事件重新计算旧表示。`follow_up` occurrence 读取返回已准入批次的原始 `events`。

插件可在完整状态快照上声明 `state: { key, sequence, value }`。同一关注内按原来源／账号、对象、发送者和 key 汇集，
按来源 sequence 保留最新正文及 value 的变化过程；sequence 必须是可跨 JSON 传输的非负安全整数，补拉不改写顺序。
相同序号存在多个不同事件时保留原文，不猜先后；未声明 state 的事件和明确映射的个人用户输入不作状态覆盖。
不同筛选关注分别决定哪些状态属于本次交办，再在同一接收边界共用重复正文，不能借另一关注的新状态删掉本关注的依据。

来源对象路由保存真实 Thread/branch 或 external conversation。同一 principal 下的原生与外部 Harness 普通任务可继续，不按 Bot 人为隔离任务池，
但其他 Bot 的入口会话不成为隐式接收目标。个人聊天映射须由已认证用户显式指定 object 与 sender；模型建立普通任务映射不能提升用户身份。
默认不按每个外部对象创建会话。显式 `firstContact: create_bot_session` 仅用于原生 Bot 接收：首次对象事件由原 identity owner 创建
真实 Bot 会话，并与对象路由在同一事务提交。已有路由优先，重试复用同一映射；缺少 objectId 则保持原默认目标。
原路由创建／移除事实防止已移除对象被下次事件自动重建；来源账号变化与首次 principal 认领分别保留其真实身份含义。
外部目标显式保存 `externalConversationId`，原生 thread/branch 仅作为定义归属和回报位置，不伪造外部任务的原生锚点。
批次与原 external turn 在同一 Catalog 事务受理；Host 唤醒现有 external owner，实际发送前再次检查暂停、Bot sleep 与配置身份。
被动输入留在该外部会话原 turn 账本，随下一条真实输入处理；原 turn 已发送或结果未知时不自动重放。
外部 Harness 在 Begin 固定本次可接收的被动输入及连续就绪安排，同一会话内共享正文并沿一次真实 turn 发送；
不越过排队的普通用户消息。各安排仍关联自己的原 turn，通过 `consumedByTurnId` 跟踪实际执行，发送前再次核验全部关联。
撤回领头安排会释放其他尚未发送意图，延期则解除整批绑定，重试按当前控制重新选择。相同 turn 的结果按实际回报目标汇集一次，
并列出所有相关安排；不同回报目标各自收到结果。
每次结果保留本次 turn 的报告身份，经原 Bot work ingress 回到交办位置，不覆盖早先 child dispatch 的完成回执。
外部会话 principal 来自可信 UI 身份或真实 parent Thread，旧数据只沿既有一次性归属初始化迁移，不从会话 ID 或资源分支猜测。

事件回显只有关联到同一来源对象和已确认的原处理 Operation 时才压下；不按「来自自己」一概忽略。
跨 Host 的 operation ID 不是本地效果证明，不能用于误抑制另一主机上的合法变化。

来源 Host 的 Catalog 保留远端 consumer 与未确认水位；目标 Host 经已有 authenticated managed connection 读取原事件，
本地持久接受后才 ACK 原页。consumer 的 generation 区分已释放后重新关注，旧在途 ACK 不得推进新关注。
断线重试沿原账号、订阅和接收游标；取消通过原 consumer 释放，不为了清理而重新连接插件或创建假本地会话。
接收 worker 由 Host 生命周期和插件 generation 管理，Bot sleep 不停止共享监听；Host 退出可取消网络等待，重启恢复原 Catalog 状态。

原文件使用独立 typed `files` 输入提交稳定 fileId、filename、mimeType 与真实字节，不能从插件传任意已存 attachment ref。
ContentStore 保存字节并将依赖随事件和批次历史发布，原 AttachmentDelivery 决定哪个实际接收者可读取。
Host 首次读取或准备执行路径时，把经 Catalog 验证的分页字节交给既有 Storage 附件 owner；文件 hash 是原字节 hash，不是清单地址。
跨 Host 传输重新准入字节，不信任另一主机的附件引用。原收件人删除后，其他仍持有真实交付引用的收件人继续可读，最后引用结束后才回收。

长期定义保留原 work 归属、身份、证据、取消与已交付结果。GC 按实际 definition、匹配、输入与远端未确认水位保留正文，解除引用后释放媒体与材料，
保留必要的紧凑去重身份，避免晚到重试重新执行。没有按天或按数量静默丢弃历史的策略。

具体服务商的 webhook、历史补拉与发送工具仍由插件交付；平台接收合同不假定每个来源支持所有方式。
主链路见 [事件 Catalog](../kernel/crates/varin-runtime/src/catalog_followup_events.rs)、
[跨 Host 账本](../kernel/crates/varin-runtime/src/catalog_followup_event_transport.rs) 与
[Host 接收](../packages/web/application-host/lib/extensions/event-sources.ts)。

## 上下文准备与压缩

设置 → Agent Harness → 上下文管理中的「时间信息」默认关闭。开启后，新用户消息携带发送时刻；
发送时区可跟随当前设备或指定时区，预览与实际发送共用格式。发送设备提供时刻与设备时区，
Host 按用户全局设置转换并随输入保存；未提供设备观察的 API 输入使用 UTC 或用户指定时区。
时间以环境事实紧邻该条用户消息投递，系统指令前缀保持稳定。同轮工具调用、重试与恢复复用
首次受理的时间；队列编辑保留原发送时间。设置变更从后续新消息生效，历史时间保持原值。

有序 Context Transform 处理独立、不可变的输入，明确区分指令与数据来源；section 身份包含
provider，不因本地名称相同而冲突。它不改已受理历史，也不在 Catalog 锁下调用扩展。
记忆、指令、skills 和材料从准入的 Source/context 所有者捕获，不依当前侧栏推断。

普通请求保留稳定配置与增长历史，现有记忆、Goal 和环境事实按各自机制投递。协作消息和原报告进入原输入队列，在历史提交边界追加；执行循环不再逐请求扫描全队状态或追加临时概览。已经送达的正文、引用与历史位置不随改名、状态推进或重新查询改变，正在发送的冻结请求也不会被新报告改写。

报告交付由原历史事务确认，不解析 `teammates:` 正文或 `reportCursor` 来推断。目录读取不消费报告。历史 `agent-status` 回执保持原含义；新报告、显式读取与等待沿同一原执行去重。协作材料作为普通历史参加压缩，不新增协作摘要或强制保留清单。

Catalog 的轻量 typed 引用索引把 `item:`、`file:`、`proc:` 等短引用映射到原 owner、对象与固定观察条件。索引不复制资源正文、不扩张权限，持有者随原历史与操作回收，分配高水位不回退。执行编号与原受理事务提交；旧长身份继续解析，历史正文不批量改写。工具原调用与已固定目标分别保存，同键恢复不重新选择“当前”目标。原始回执保留完整数据，`OutputBody.model_data` 是生产者发布一次的稳定模型投影，UI 和调试仍读取原 `data`。只有契约明确声明的对象字段接入引用服务，正文、代码、URL 与第三方不透明标识不做字符串替换。

请求内容与顺序稳定不等于已经证明 provider 缓存效果；默认诊断不记录完整用户提示词。

环境事实由 Documents 已提交变更、用户终端的带身份 OSC 完成记录和成功 Git 状态查询产生；不启动全盘监听、
LSP 预热或 PTY 输出镜像。Host 按真实本地 Source 分派，固定分支和远端 Source 不借用本机目录。
生产者先固定工作区、捕获身份和观测时间，首次成功查询原生 Source 后才固定接收 Run；这不宣称接收 Run
在观测瞬间已经活动。绑定后重试不改投别的 Source。原文直接提交 Catalog / ContentStore，Knowledge 不再作为新捕获的中间日志。
模型窗口未知或关闭自动压缩时，这条输入链仍然工作，与自动压缩策略无关。

请求边界只选择当时已经持久化的有限事实页，不等待 Host 待提交队列、其他工作区或旧日志导入完成。
后到事实保留在队列，等待后续合法请求；被动环境积压不会否决结束或自行追加付费轮次。用户输入与明确的
Bot 工作通知仍走各自已有的唤醒规则。取消请求只取消观察等待，不伪称原捕获事务已回滚。
Host 已观察、Catalog 已受理、分支已接入和 provider 已投递是不同状态，不能用跨域游标大小推断完成。
未声明模型容量的独立客户端可不安装 Host 容量/诊断服务；仅该可选服务的明确不可用或准备失败不阻断请求，
不将缺失回复伪装成成功诊断。关闭、取消、畸形回复以及原生输入与诊断写入的 Catalog 错误仍按各自边界处理。

原文与模型表示分开保存：新事实冻结版本化表示，正文共享原生展示预算，保留命令身份和退出状态，
明确标出省略字节；`read_thread` 的 observation 查询按历史可见性分页读原文。投递回执确认实际进入请求的
表示，不声称省略的原文已被模型看到。Host 有界队列的 pending、unknown 与 gap 记录进入准备诊断，
不是虚构的环境事实；在首次 Catalog 持久化之前的进程退出仍可能留下观察缺口。

已有 Knowledge 事件仅通过后台只读分页导入，保留原 `observation:<run>:<node>`、正文和摘要身份；导入进度
与原回执一起由 Catalog 事务提交。缺失、损坏或不可用的旧库不替换为空库，也不阻塞模型请求。
计划内容、更新和删除继续通过模型自己的工具结果及 UI 使用，不增加自动 Zone2 计划投递。

容量准备使用选定模型的已知容量、完整文本/工具序列化的本地估算，以及可用的同绑定成功 usage。
校准核对实际前序请求前缀；媒体/provider 未知成本仍未知，不变成账单或远端缓存折扣。
预留量按当前模型的上下文窗口乘以 `compaction.reserveRatio` 向上取整；设置页的「上下文管理」
可调整全局比例，可信项目与模型覆盖沿用同一配置优先级。输入预算为窗口减预留量，超过预算时在下一次请求前
切换到已完成摘要，尚未完成则等待。后台准备按原策略阈值开始，并根据准备耗时与增长速度提前。
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
文本由所选模型的本地 tokenizer 计数；来源、编码识别、下载与缓存由
[模型 tokenizer owner](../packages/web/application-host/lib/models/DOCUMENTATION.md#tokenizer-metadata-and-cache)维护。
请求固定不可变词表引用，后来的配置与下载结果不改已派发输入。当前配置、活动/排队任务、可继续会话与子任务
保留所需词表；失败或未知来源使用明确标注的参考估算，不阻塞普通会话或伪造真实用量。
压缩请求按压缩模型计数，保留原文和摘要按主对话模型计数；整请求结合可用的真实 usage 校准。
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

摘要角色的实际工作指令、输出格式和读取工具由
[context_job.rs](../kernel/crates/varin-runtime/src/context_job.rs)定义，设置页读取同一份定义，不在文档维护翻译副本。

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
`utilityThinkingLevel` 独立控制辅助请求的思考等级；未设置时，单独选择的辅助模型使用其声明的默认等级，
沿用全局默认模型时也沿用 `defaultThinkingLevel`。各 Harness 模型槽的独立等级保存于
`agent.modelSettings.thinkingLevel`，快速检索、下一步建议和规划等请求均将它固定在实际模型绑定中。
请求预算与执行使用同一份配置，设置变化只影响之后的新请求；切换模型时清除旧模型的独立等级。
自动标题频率与输入构造由 [thread-titles.ts](../packages/web/application-host/lib/model-text/thread-titles.ts)和
[标题上下文](../packages/web/application-host/lib/model-text/thread-title-context.ts)维护。命名受理固定历史切点，
失败保留旧标题；手动命名结束自动更新，恢复自动命名是显式操作。迟到输出核对原命名代际，不覆盖新名称。
子 Agent 身份与 Bot 主要长期会话名称保留各自归属，不被普通会话命名接管。

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

设置中的「用量」通过 `runtime.usage.summary` 读取当前 Host 的原生请求用量账本。Catalog 在派发时冻结计费归属，
在原回执落盘的同一事务写入一条不含请求内容的记录；同一请求的回执细化更新原记录，确认未派发时撤回。
对话 ModelStep、上下文、检索、规划、辅助推理和 MCP 采样各由原执行 owner 记账，镜像 ModelStep 不重复计量。
删除原生对话后保留日期、渠道、模型、用途、Token 与价格快照，标题和原文仍由原保留规则回收。
旧库自动升级到当前格式；旧回执没有可靠的完成时间，保留在分支用量中，不伪造日期补入新账本。
Responses 的缓存写入计数读取终态回执的 `input_tokens_details.cache_write_tokens`，缺失或非法值保持未知。
旧计数修复只使用仍保留且身份、协议、计数相符的原始回执，更新对应既有账本；
保留原价格、时间和原文，不为缺少账本或已回收原始证据的请求补造金额。辅助推理及 MCP 采样的旧记录不从聚合回执反推。

models.dev 和模型详情中的自定义单价进入真实请求绑定，价格快照只用于归属和估算，不改变连接、凭据、模型身份或缓存配置代。
计费使用协议的完整输入口径，缓存桶按实际单价计算；长上下文支持多个阈值。缓存写入目前使用冻结配置中的统一写入单价；
服务端报告的不同缓存时长明细保留在原回执中，不按模型名称或时长擅自套用另一价格。已计入输出的推理 Token 使用单列推理价时替换
该部分的输出价，不再叠加收费；无法确定分量的计费保持未知。目录更新不改写已定价请求。补填单价只为原先未计价的记录提供
现价估算，并明确标注；模型别名对应多个不同现价时不任选其一。订阅的 API 标价折算独立于按 Token 计费的合计，本地计费另列。

汇总按时间索引捕获无内容的回执，解析和费用计算在释放 Catalog 锁后完成。客户端提供其本地日期边界，保留夏令时的 23/25 小时日；
Web、桌面、移动端读取同一 Host API。页面沿 `usage.updated` 游标合并更新，不轮询、不开模型请求；外部 Harness 在回合结算时发布同类通知，
自报单轮与累计值单独展示，不与原生账本或彼此重复相加。
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

Application Host 停止入口同步进入 draining，readiness 立即撤销，受理层拒绝新执行和写入，保留
已识别的查询、观察、取消和回执清理。新执行即使还在 Kernel IPC credit 队列，也在派发前再次检查
draining；已派发工作继续由原 owner 结算。HTTP 已进入 handler 的工作不因拒绝后续请求自动消失。
新 Surface service lease 可能激活 provider，不视作只读观察。实时观察协议保留原 pull/cancel；
任意字节的终端、连接、转发和预览桥由原传输 owner 关闭，不能把桥断开当作远端 executor 停止。

`VARIN_SHUTDOWN_TIMEOUT_MS`（默认沿用 10 秒）建立一次单调绝对 deadline，覆盖 producer、进程、
Kernel、Knowledge 和 HTTP close。正常退出记录结构化 `outcome: graceful`。owner 失败或到期记录
`incomplete`、owner、reason、elapsedMs 和 deadlineMs，停止后续依赖拆除，不提前关闭仍有 writer
的数据库，不把超时解释为 executor stopped。迟到的 Kernel drain 回执也不会重启已到期的清理链。
前台 CLI 对正常 SIGTERM 保留退出码 143，不完整关闭为 1；监督者或容器最后负责整个进程故障域。
event loop 被同步代码阻塞时，JS timer 不是硬实时保证，仍需要外部 stop grace，见[部署](ops/cloud-deployment.md)。

冷备份完整保留 WAL、正文对象、原身份与未知效果。恢复副本默认封锁 Host 启动；灾备激活必须核对
原实例 fencing、备份后的外部效果及 workspace/连接绑定。独立可运行的新 Host clone 尚未实现，
不能靠复制或替换 hostId 获得。完整范围和操作入口见[冷备份与隔离恢复](ops/cold-backup.md)。

恢复读取原事实与回执。Prepared 但未 dispatched 的请求可沿原受保护路径继续；
已派发却结果不明的模型请求不自动重发。已保留的摘要/工具结果可以继续投递，不重新生成或执行。
外部工作未知时保留原 owner 和相应占用，等待真实对账；新进程 epoch 不使旧绑定自动可执行。

源码和定向测试证明具体机制，不证明全部 provider/平台等价。真实账号、安装包断连/停止/恢复、
实际代理、物理 managed Host、平台进程/桌面行为及规模性能需要各自的相关验收。
按[开发指南](development.md)和最近 owner 的测试选择检查；原生默认路径已经切换，未执行的实机验收仍保持未验证。
