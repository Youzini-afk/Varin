# Agent 运行时

产品对话通过 Rust `varin-runtime` 执行，Thread/branch 历史、输入受理与执行由 Catalog 统一拥有。
既有 Application Host 继续承担模型账号、资源、扩展和领域服务。旧 Pi runtime 与产品入口已经移除，
不自动导入或重写历史用户资产，也不保留第二个对话 writer。

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

上下文 checkpoint 保存已发布摘要、指令、记忆/资源及来源边界。新记忆可作为后续请求的投影，
不改写原历史。Knowledge/Memory 仍是笔记写入者；Catalog 只记录观察和请求投递证据。
只有原记忆操作的确认回执可用于去重，失败请求不表示已经交付。

显式历史导航先在锁外准备祖先和合法工具配对，再原子提交 head CAS 与命令回执。
重复命令不会回退后来追加的工作；undo 使用原回执。导航不重写 Run、效果或 usage，
也不恢复已取消的 Goal。跨过摘要边界只清除该摘要对应的上下文基线，不删除实际记忆。

## 工具、资源与真实回执

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
关闭终端视图只 detach；停止取消原 Operation。输出回放固定历史边界，重开不会再次回答
历史终端控制查询。文件租约、guardian 和跨平台停止证据详见[资源与恢复](resources.md)。

## Source 与 managed Host 的运行时边界

选定 Source 始终保留 `resource_owner` 和精确 workspace/view 身份：

- `live_root` 绑定已准入 Host、root identity 和规范目录，通过 Documents/Storage 读当前内容。
- `fixed_branch` 绑定不可变分支/revision，可供文件、检索和派生语言视图读取；当前不提供
  可写物理 cwd，也不提供需要该 cwd 的 workspace MCP、shell 或 PTY 执行视图。
- `materialized` 绑定固定来源及原 execution copy/Run；副本缺失时明确失败，不能以同一身份换建副本。

固定捕获的 saved-files/surface-drafts、Git 语义、来源闭包和文件一致性由
[资源合同](resources.md)解释。Linux 的连续目录观察只允许复用名称清单，仍读取并哈希全部
当前文件正文；Windows 和未知覆盖继续全量核对目录。运行时不能据此声称已完成内容增量捕获。

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

child report、固定 WorkingResult 和 executor-stop 分别记录。相关 writer 真正停止后，
原 Storage 才能按结果合同捕获/pin。父 Wait 观察该记录；取消观察不会取消独立受理的 child。
报告固定在原终态 Run 的不可变历史链，不以用户后来导航到的 branch head 取代结果，
报告发布也不修改当前导航。多层 child 的直接父调用与报告访问权限逐层保留。
任务家族消息和历史读取保留真实发送方、祖先和权限；其他 Agent 内容标为数据，不冒充 system 指令。

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

有序 Context Transform 处理独立、不可变的输入，明确区分指令与数据来源；section 身份包含
provider，不因本地名称相同而冲突。它不改已受理历史，也不在 Catalog 锁下调用扩展。
记忆、指令、skills 和材料从准入的 Source/context 所有者捕获，不依当前侧栏推断。

容量准备使用选定模型的已知容量、完整文本/工具序列化的本地估算，以及可用的同绑定成功 usage。
校准核对实际前序请求前缀；媒体/provider 未知成本仍未知，不变成账单或远端缓存折扣。
后台准备不阻塞仍可发送的请求；确实需要压缩的请求在 dispatch 前挂到持久 context Wait。

`varin.context.budget@1` 决定何时、在哪个边界压缩；独立的 `varin.context.compaction@1`
提供算法，返回固定文本或 source/node-output DAG。Preview/create 共用原材料加载器；
`sourceCutHash` 固定实际可见正文、角色、记忆/资源及 model budget。完整模型配置与凭据由
launch 另行固定。重开消费已受理 recipe 和 producer/composition，不调用新算法重解释旧工作。

内置 fold 与扩展 DAG 共用无工具摘要 Run。独立节点并行执行，已完成节点立即解锁自己的后继，
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
扩展通过同一 composition 贡献渠道、目录、协议 codec 和认证。耐久 `adapterIdentity` 绑定确切 artifact/组合；
`adapterBindingId` 指向实际活跃实现。原 Run、排队输入及 child 持有原 pin，不按今天的服务名重选。
同账号刷新保留身份，取消等待不放弃真实刷新及保存；网络、用量和实际停止仍由原执行 owner 记录。

Agent [MCP 服务](../packages/web/application-host/lib/mcp/DOCUMENTATION.md) 独立管理配置、账号、连接和缓存。
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
