# 原生 Agent 运行时实施

状态：实施中，尚未切换生产运行时。更新：2026-10-10（Asia/Singapore）。

综合结构审阅见[2026-10-09 实现审阅](../reviews/runtime-2026-10-09.md)，后续实现及独立行为验证见[控制路径隔离增量](../reviews/runtime-control-isolation-2026-10-09.md)。前次源码与编译审阅、各阶段行为验证分别记录；历史通过记录不代替当前代码的证据。两份设计的整体交付仍未完成。

目标是完整实现[完整运行时设计](../design/agent-runtime-design.md)和[能力组合设计](../design/runtime-extensibility-design.md)共同定义的长期运行底座：及时交互、低开销执行、按真实资源调度、深层能力组合和可替换策略。完成聊天循环、迁移已有工具或删除 Pi 都不是单独的完成标准；Pi 退出是这套设计落地后的一个结果。当前生产仍使用 Pi session worker、TypeScript Host 协调和 Rust 资源内核；现有权威见[架构](../architecture.md)。

交付边界（2026-10-10 用户确认）：本轮完成两设计能力与可复跑验收入口，整理实现证据、未验范围和迁移前清单，交用户先验收。默认 runtime 切换、Pi 删除和用户资产全面迁移由用户在验收后负责。本分工不缩减设计能力范围，也不把未执行的产品或平台验证算作通过。

## 2026-10-10 增量：显式持续 Goal 与真实用量续接

- 显式 Goal 与单次 Run 分离，保存用户目标、控制状态、可选 output-token 预算和原始推理用量。普通输入和 fork 不自动创建持续授权；一个 branch 同时只有一个未结束 Goal。目标、报告原因和创建意图进入既有 ContentStore，worker 准备正文，Catalog 短事务核对实际 Thread/branch、revision/generation 并提交引用；控制 FIFO 直接返回当次短受理回执，不用后来状态冒充原命令结果。Catalog 内部格式为 **22**，旧格式明确拒绝。
- 主 ModelStep、策略辅助模型 Operation、已受理 child 和 owner-triggered summary 保留实际归属。child 尚未准备时也从原 JobAccepted 固定归属；summary 计入原目标的真实用量，但不注入执行该目标的指令。已派发请求的归属不会因目标更新、完成、取消或同 Run 后来建立新 Goal 而改变。用量从原推理 receipt 同事务汇总，普通工具结果、嵌套投影和重读不重计；失败、中断、取消与被拒绝发布的真实结果同样保留事实。
- actual、estimated、missing、pending 分开展示，input/cache/reasoning 沿 provider 原语义保留，不相加伪造总额或价格。可选预算按实际 output 控制后续推理，允许真实在途工作超出预算；零预算有效。已结束推理缺少实际 output 时，有预算的 Goal 以 `usage_unknown` 阻止继续推理/自动续接，resume 不清除证据，用户明确移除预算才可继续。预算耗尽、明确受阻与目标完成不混同。
- `goal_report` 是原 ToolDirectory 上普通绑定工具，核对原 ModelStep/PolicyAction、Operation、当前 primary Goal 和冻结 generation；状态变更与 canonical 调用回执原子提交，不制造模型调用或每轮必跑的评估链。Goal pause/更新拦截尚未派发的新工具效果，已派发和独立作业继续按原 owner 结算。先处理已受理问题/观察的原 Wait，再结束 Goal 所在轮次，避免留下无法回答的问题。
- 原 followup owner 增加类型化 `run_completed` 与 `goal_requested` 发生项，保留原 process stop 证据；消费发生项和新 Submission/Run/launch 同事务。普通 final 只结束本轮，Goal 仍可沿原身份继续；准入重核目标世代、预算、实际未结算操作、原依赖、用户队列与 branch/source scope。现有 coalesced worker 与 Host launch consumer 消费 `goal.run_ready`，没有第二 timer、任务树或执行账本。手动暂停不会被依赖完成、question answer、重连或预算修改覆盖。
- 整合实测修复了输入和等待组合缺口：终态 Goal 后的新普通输入沿原交付事务解除当前 primary Run 关联，真实下一请求消费它而不续计旧 Goal；active-but-blocked Goal 下的新 Run、报告后的同 Run 输入和失败后 promoted 输入原样停靠，不能被直接标完成。原报告事件与其后的真实 input delivery 区分“已报告结束的本轮”和新工作，显式恢复后再执行。parent Goal 结束不会把未完成 child/summary 伪报成功；原已受理独立进程不被假称停止。
- 公开 protocol/application-client/认证 HTTP/ThreadAdapter/snapshot 与共享 Goal 面板已接线。UI 保留编辑 revision 和草稿，冲突显式重读；不确定 start 重投原 key/objective/budget/Run，已受理但刷新失败不重新创建。分支/Host 晚响应不覆盖当前视图，Goal-owned followup 不提供绕开 Goal pause 的独立控制。
- 最终完整 runtime **297 passed / 0 failed / 2 既有 ignored**，kernel lib **44 passed / 0 failed / 1 既有 ignored**；覆盖原 Engine、Goal tool、child/summary/辅助推理、用量重放、输入/Wait、fork/reopen/过程续接。首次完整回归暴露一个旧测试仍期待恢复 usage 为 absent，已按新明确 Missing 合同改为 typed 未知断言后完整重跑。Portable Host **3 文件 25/25**、UI **4 文件 49/49**，最后已结束目标提示修整后 Goal **8/8** 重跑通过（重叠不累加）。生成协议、Host 生产/测试类型、UI 类型、变更 lint、实际 Host bundle 与文档链接检查通过。Linux x64 开发内核 identity `0.9.25` 已 build/stage，SHA-256 `fd34e8f13b130f32649e861e0f8cb147479a6ed0ae3fbfec4ba1776a8b9d5cee`。
- 独立审查先于实现形成六闭环标准，冻结后跟踪实际消费者。仓库外真实 Catalog/ContentStore 探针验证旧 epoch 候选拒绝、手动暂停跨重开保留、旧历史 fork 不继承授权、实际 GC 删除 orphan 后目标/用量仍可读，以及显式 resume 原子准入后重开仍是同一 Accepted Run、没有第二发生项。本 Goal 增量未发现剩余已证实的新行为阻断；独立恢复探针暴露的既有能力缺口如下保留。
- **明确保留的既有恢复缺口**：RequestPrepared 已持久但 ModelDispatched 尚未提交时崩溃，原 Catalog→Supervisor 重开入口会因 unresolved gate 安全停在 Waiting，不发生 provider 请求，也不伪造用量/完成。独立探针对 Goal 有/无均复现，基线已有同门控；这不是本次 Goal 新回归，但未满足完整“已准入未派发”恢复能力。紧接本阶段先闭合该原生恢复边界，再推进一般策略的提问/计划/进程观察。通用日历/事件和剩余领域仍未完成，实际 Host IPC、真实模型及平台证据仍按原边界保留，默认迁移交用户验收后执行。

## 2026-10-10 增量：原生显式 skill 输入与原版本消费

- `/skill:name args` 从既有 Host 资源 owner 的完整已选列表选择，hidden skill 可由用户显式选择。语法沿锁定 SDK 的起始命令和首个 ASCII 空格，只对参数元数据 trim；原始 text/images 原样保存。Host 解析原 checkpoint 中已捕获的 SKILL.md，材料独立进入原 input-history ContentStore 对象，不伪造模型调用、ToolResult、system 或用户原文，不建立 activation registry/第二队列。
- submit、boundary/interrupt/next-run enqueue 与 edit 共用既有 Catalog 输入事务及 revision。初次或显式切源时材料绑定同次新 context；已有 context 使用 Host 实际读到的 ID。整合发现并修复了已有 A 切源 B 时内层 null（新候选）与外层 A.id（替换 CAS）的混淆。图片-only 编辑保留原选择，任意原文字变化重新选择或清除材料；失败、取消和交付竞争不能半更新。原 submit/enqueue receipt 先于后来派生候选解码/准备，重复 interrupt 不再次中断后续 generation。
- canonical history 把材料投成独立 `ExternalData`，原用户 parts 仍是 `UserInstruction`。正式 activation 从真实 input ID、正文 revision 和 ordinal 派生，ModelStep 与 policy node 只冻结实际保留的类型化材料引用。`resource_read` schema **2** 的 activation selector 由原调用核验，追真实输入祖先、原 checkpoint、descriptor 和 version；当前默认资源刷新到 B 后，旧 A 材料的支持文件仍读取 A，不回退到最新或 live 文件。
- compaction 的既有 recipe/checkpoint 保存小型类型化来源引用，不重复注入全文或从摘要文字恢复授权；fork/reopen 沿真实继承历史恢复，非祖先同 Thread 输入不能借 selector 读取。原 checkpoint/input roots 与 publication 继续承担 GC。已受理正文作为历史保留，后续新资源读取仍检查当前项目 trust、Run/调用取消及 epoch；正文不授予文件/进程权限。Catalog 内部格式升为 **21**，旧格式拒绝，无迁移或双读。
- 实际 Host index、私有生成协议、认证 submit/enqueue/edit 路径与 Thread UI 已接通。UI 插入命令不直接发送，保留草稿/图片；历史和队列分开展示冻结名称、来源和版本。typed resource 失败有安全文案，stale 后保留原草稿并可刷新重试。含 ASCII 空格的名称仍可见且可由资源工具读取，只禁用无法精确表达的命令按钮，不增加 owner 名称硬限制。
- 冻结完整 runtime **281 passed / 0 failed / 2 既有 ignored**，kernel lib **42 passed / 0 failed / 1 既有 ignored**。覆盖原始 RPC receipt 在后来候选 malformed 时复用、首次 interrupt 身份、实际 Engine/ToolDirectory/OwnerChannel 绑定、原子切源、compaction job recipe、fork/reopen、队列修订与 GC；最终三处选择语义文案修改后，资源 owning runtime **11/11**、kernel **2/2** 复跑通过，不重复累计。Linux x64 开发内核按 identity `0.9.25` 编译并 stage，manifest/ELF 核验 SHA-256 `3440e47f1ad61f3d18f6e4938748b76051b774db4fe0818c4fd2d4274809b4f6`。
- Portable Host 组合 **8 文件 65/65**、UI/投影 **3 文件 40/40**，Host 生产声明/测试类型、UI 类型、实际 Host bundle、生成协议一致性、变更 lint 和文档链接检查通过。旧 Pi catalog/command/editor 收敛、Goal/通用日历、后续领域和默认产品迁移仍未完成；实际 Host IPC 验证缺口继续保留，不将独立组件通过拼接为完整端到端通过。
- 独立审查先形成原文/来源/版本/取消/恢复条件，再审完整消费者。仓库外 Host 探针验证实际 bridge → owner → 原 snapshot 参数 → 窄原 A reader，当前 B 下读取 A 的未预捕获支持文件、撤 trust 拒绝与 epoch 变更 stale；其底层 Storage/RPC fixture 范围明确。另一原生探针在真实 Catalog/ContentStore 上执行 next-run A 入队、刷新 B、同文图片编辑、重开、拒旧 epoch 候选、复用原回执与 promotion，仍为 A 的同一正文修订；Responses/Chat/Anthropic/Google 四个真实 serializer 保留原命令、图片与材料来源，不产生 system/tool 假事实。本 H2 范围未发现剩余已知行为阻断。

## 2026-10-10 增量：原生指令与 skills 冻结资源纵切

- Host 新 `agent-resources` owner 统一解释已准入的 SYSTEM/APPEND、目录指令、skill 元数据、包过滤与版本。配置、ProjectTrustStore、安装包和编辑器仍是原有 owner；不执行扩展、不安装包、不创建第二资源库。用户配置与受信项目配置分开，空值、缺失、损坏、无权限、不可用和取消保留各自结果。
- main source 使用原 Documents 协调的稳定完整捕获；Git child 在原 source receipt 同事务补精确资源范围、外部 ancestor/capsule 与 absence/coverage，固定继承复制原 provenance。用户资产、独立安装包由自己的只读 owner 捕获，不假称属于项目 pin。冻结的类型化 `ContextResources` 和完整正文放入既有 ContextCheckpoint ContentStore 对象，GC 复用原 checkpoint 根。
- ModelStep、policy graph 冻结原 `resource_checkpoint_id`。普通 `resource_read` 通过既有工具目录、原调用身份、私有 owner channel 与七态结果消费快照；模型不能选择任意 checkpoint/source/grant。已捕获正文不再开原文件或重新解析 settings。额外固定视图材料按原 branch/revision/root/receipt 重开窄 `storage.read` view，pin/read/release 不授予 file/process 或写权限。目录指令的合法 symlink 沿原 pin 解析，只派生具体最终候选文件 scope；不会给父目录/整根权限。项目 trust 只约束实际依赖它的选中资源，撤销不会阻断独立用户 skill 或目录指令。
- 独立资源 refresh CAS 保留 summary/history anchor、原即时记忆快照、profile/composition、Thread 角色/项目及 source。显式切换 input source 时，Host 准备依据的 checkpoint ID 跟随候选进入原 input/Run/source 事务，覆盖了 Host await 期间的刷新竞争。`runtime.input.receipt` 复用原 command/launch 身份校验，已接受输入的重试不受后来损坏的资源配置影响，也不维护 Host 去重表。fork、compaction、重开及旧调用继续使用原资源正文，fork 不复制执行 source 授权。
- 认证 HTTP、`ThreadsAPI.resources.refresh`、实际 Host index 与 Thread UI 已接同一 owner。UI 只展示版本、来源、指令/skills 元数据及诊断，按显示 revision 显式刷新；冲突保留旧内容。此阶段还未接显式 `/skill:name args` 的输入/队列版本绑定，也未收敛旧 Pi catalog/command/editor 消费，不能称完整 skills 产品迁移完成。
- 最终原生组件验证：runtime **279 passed / 0 failed / 2 既有 ignored**；kernel lib **42 passed / 0 failed / 1 既有 ignored**。新 Linux x64 kernel 已按 build identity `0.9.25` 编译及 manifest/ELF 校验，SHA-256 `d9dd3411be346851baf68818dfd51086d4187c2c5cb4a4607fa0b772c7cf2e34`。覆盖原版本读取/GC/恢复、policy 无 ModelStep 调用、policy 单独取消、只读 pin/ancestor metadata、fixed handoff 原 provenance、原子切源与输入重试；不推断为完整 Host IPC 端到端通过。
- 独立审查先从设计形成验收，再追调用/持久化/取消/只读权限链。仓库外探针复现并复核 Host 准备 CAS、重开原 receipt、fork 无执行 source 仍保原正文、多级同 pin alias、兄弟文件拒绝、取消后租约释放和外部 capsule 不越 bundle 捕获。Windows 路径、显式空 package manifest、FIFO 非阻塞失败也已独立复验。本 H1 范围无剩余已知行为阻断；不以这些探针替代 H2 或 Host IPC 验收。
- 最终 portable Host 组合 **51/51**、原 source receipt 行为 **8/8**、Thread UI 行为 **37/37**、只读 SDK 配置 **2/2** 通过；Host 生产/测试类型、UI 类型、实际 Host bundle、生成协议一致性、变更 lint 和文档链接检查通过。其 source/pin fixture 的严格权限模拟与原生 Storage 行为证据分别记录，不拼接成未执行的 Host IPC 验收。完整 `/skill` 语义、Goal/通用日历与后续领域、默认 Pi 产品迁移继续推进。

## 2026-10-10 增量：进程停止后的显式一次续接

- 用户可在真实 `process_spawn` Job 受理或原执行回执存在后，登记一次 follow-up。定义、独立 next-Run Wait、实际 occurrence 与新 Run 准入全部归原 Catalog；定义冻结原模型、策略、工具、来源选择及上下文作用域。没有从普通输入自动推导 Goal，也不复活已结束 Run 或放宽 run-bound Wait。Catalog 现为格式 **20**，旧内部格式拒绝。
- 触发只认原执行 owner 的真实停止证据。原回执首次确认 executor stopped 时发布通用 `operation.executor_stopped` 短事实；效果未知、JobAccepted、Operation 终态或占用行缺失都不单独证明停止。停止先于登记、甚至先于 JobAccepted 或崩溃，原 identity/opaque epoch 的事实仍可回找；重复回执保持幂等。原 Run 尚活跃、当前 branch 有工作/排队输入、来源或作用域已改变时 occurrence 明确 held，不抢用户输入或偷换来源。
- 内核事件唤醒独立、合并的 continuation worker。先锁外读取原回执并 staging typed EnvironmentFact，再在同一短事务核定义代、原 Operation、当前 head/checkpoint/source、取消与 owner fence，消费 Wait/occurrence 并调用原输入准入事务创建一个 Accepted Run。重复唤醒和准入后/Host 启动前崩溃复用原 receipt；worker 不依赖 Host timer、UI callback 或通知通道可写。原 Run 用户取消原子撤销未消费授权；显式 follow-up pause/resume 不消费策略 Pause。Agent 停止 fence 拦住旧 worker 发布，新 owner 可继续原未消费授权。
- 新 Run 只获得精确原 process 的 inspect/read 关系。Catalog 从原消费 occurrence 推导 source Run，Storage 同时核当前与原 grant、Thread、workspace/物理 root/cwd 和 source 身份；其他 process、同 Thread 无关 Run、stdin/kill 和新的 cross-Run process Wait 不因这个关系获权。换 kernel epoch 后按正常 source 准入重登记原 root，读取既有持久输出，不重发原 process 或旧 grant。
- 认证 HTTP、`ThreadsAPI.followups`、Thread snapshot 与会话 UI 已接同一原生定义。未确认登记回复重试沿原 key，控制带显示 revision，展示 held 原因与实际新 Run receipt；已消费项不再展示误导性取消按钮。Host 仅从特定 `followup.admitted` 事件继续 launch，启动恢复沿已有 pending-launch 枚举，不把所有 run.accepted 都当自动工作。旧 Pi follow-up/日历存储仍是其当前产品路径，未为本次原生 occurrence 双写。
- 冻结验证：完整 runtime **270 passed、0 failed、2 个既有 ignored**，包含 11 项原 Catalog 续接组合；kernel lib **39 passed、0 failed、1 个显式集成 ignored**。Host 组合 **16/16**，UI/投影 **25/25**，完整 Host 声明/测试类型、application-client 构建/类型、UI 类型、定点 lint、生成协议一致性、文档检查及实际 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建并 stage，SHA-256 `0cc452e083a638d38bed0ebc8319e7469c6309af9b50e27b20f422f1a0eed9b4`。
- 额外显式执行的真实 ProcessManager 组件链 **1/1**：KernelToolExecutor → Storage/ProcessManager 启动真实 OS 进程，原守护回执驱动一次准入，精确新 Run 读取原 stdout；同时实测当前/原 grant 撤销、其他 process/无关 Run 拒绝和新 epoch 正常 root 重登记后的持久输出。测试第一次重开漏登记 root、第二次 read 结算漏原调用准入，均由生产权限/事实检查拒绝；补齐真实调用顺序后通过，未放宽生产授权。它不使用 Host IPC 或模型 provider。
- 独立审查先从设计形成条件/取消/恢复/原子准入/单一权威验收，冻结后核完整消费链。仓库外 **3/3** 原生探针分别确认 JobAccepted 前早到停止、停止后/受理前重开仍等待原 Run 终态并复用原回执，以及 continuation 先提交时后到用户输入进入原队列；本阶段无已知生产行为阻断。审查所复跑 Host/UI 子集与上述组合重叠，不重复累计。
- 本轮新增的实际 Host HTTP → kernel → process → 自动新 Run → 模型读取原输出 fixture 已通过类型检查，受现有 IPC 环境限制未执行；其证据不能与 portable Host fixture 或原生组件测试拼成完整端到端通过。通用日历/事件触发、Goal、完整指令/skills 与后续领域、默认 Pi 迁移仍在推进，两份设计尚未整体完成。

## 2026-10-10 增量：ContentStore 显式回收与控制隔离

- Catalog 只准入一轮有归属的 collection，原 conversation.sqlite 的一致只读根扫描、正文校验、目录枚举、删除与 fsync 全部在独立 worker。只读事务在根捕获完成后结束，不用第二数据库、持久 root mirror 或 GC 操作日志。所有既有 history、原始调用/审计回执、policy/context/child 正文根沿原 owner 保留。
- publication/retained-read 的短登记不等内容 I/O gate；单调序号让扫描后的新 publication 即使已完成也使旧 mark 失效。worker 的正文 I/O 与 sweep 使用同一 ContentStore gate，覆盖已有 orphan hash 复用和实际 UUID staging。新 publication 使 sweep 在下一安全点退让；控制状态、取消与元数据提交不等待这个 gate。仅服务 fixture/启动的同步正文便利入口遇 collection 明确冲突，生产仍走 capture → worker → commit。
- collection 持有原 `runtime.owner` 文件的真实寿命。Catalog/Agent 关闭只请求取消，未停止的旧 worker 仍阻止同目录新 owner；完成、错误、取消与 unwind 释放同一临时 collector。mark 失败不删除内容；中途删除/清理失败保留实际阶段及已删计数，未知文件不删。没有恢复旧内存删除列表、无限重试或每个 Run 的清理屏障。
- 当前 Host 的认证 `POST /api/runtime/content/collect` 只接受空对象，经原 AgentRuntimeClient 和生成协议进入 `runtime.content.collect` 独立 maintenance worker。请求保持普通成本类别，不混入 Storage 或 history/receipt 队列，也不成为模型工具。报告明确 completed/deferred/cancelled/failed、实际 phase、对象/字节/staging 删除计数及 nullable reason；HTTP 关闭只取消本次维护，不取消 Run。
- 冻结后的完整 runtime **259 passed、0 failed、2 个既有 ignored**，kernel lib **39/39**。其中 8 组新确定性交错在实际 SQL 行、manifest 校验及已 unlink 后暂停，确认 Catalog status/Run cancel 仍可推进；同时覆盖后发 publication 计数回零、旧 orphan 复用与取消后原回执、实际在途 staging、替换根后的旧 reader、部分删除取消/失败、真实 owner 重开排他和 unwind 释放。原 retention suite 继续验证历史/permission/policy/child 等根，没有靠新增快照数代替正确性。Host 管理入口 **2/2**、完整声明/测试类型、定点 lint、生成一致性、文档链接及实际 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建并 stage，SHA-256 `9933e9db6ab990d4259d5a350d98016f439f7d8392f75c06ab451142c446a612`。
- 独立审查从设计先形成验收，再核实际锁/SQL/正文/owner/取消链与 42 个同步便利入口的生产调用关系，并独立执行冻结二进制的 8 项 race；本阶段无已知代码阻断。主动 AbortSignal 可先拒绝客户端 Promise，不能由此推断 worker 已停或保证断开的调用方收到 partial report；内核仍按原请求身份收尾和释放 credit。更新的 native Host 维护/授权场景仅通过类型检查，实际 IPC 证据留待可用环境补齐。控制隔离不声明固定延迟或物理 I/O 倍率；Goal、事件/日历续接、完整指令/skills、其他领域及产品迁移继续推进。

## 2026-10-10 增量：隔离可写子任务与原结果集成

- 显式 `isolated_write` 与既有 `read_only` 共用原 dispatch/ChildTask/JobAccepted。父来源 whole-root 读取授权形成有界 handoff 后，Catalog 先持久受理独立 Thread/branch，再进行来源捕获、上下文准备和物化。私有子目录的受控文本写入不要求父原来源已有写工具；父方集成是另一个显式授权动作。仍只接受已实现的 `model: parent`，不默开进程、递归派发或任意扩展工具。
- 固定来源复用原 pin；物理来源复用共享 Documents 稳定捕获，读取实际 materialized 目录而非旧分支基线。已保存文件、Git/非 Git inventory、mode/symlink 和未纳入的未保存 overlays 沿原合同处理。来源 provenance 正文由既有 Storage blob/ref 保留，与原 branch-create 回执一起提交；重启先读原回执，不重扫已固定的来源。实际 Documents workspace 身份与 Storage execution workspace 分开，避免受管目录错误命中父原根。
- 子 Run 终态、文本报告、物理写停止和代码结果各自记录。受控写入沿既有 Rust 文件/readVersion/CAS authority；实际 Run worker 与原 root lease 排空后才固定候选。候选与 base pins 原子保存，readonly worker 生成原 WorkingResult，再短事务提交 branch revision、结果 record/ref 与原发布回执。已固定候选在目录消失后仍可发布，重投不新增结果版本；取消和空报告不抹掉已确认修改，未知效果保留未知。
- 普通安装示例 `examples/extensions/child-integration-tool` 通过原 ToolDirectory/权限/Host invocation 调用既有 IntegrationCoordinator。选定 child/publication、实际父 Run/Thread/branch/source 和真实 model/policy origin 组成原 journal 因果绑定；同 Thread/branch 的后续 Run 可以显式集成。没有 Pi 会话伪装、第二结果库、第二效果日志或自动写回。现有三方合并、Documents 脏缓冲区 CAS、条件文件写入和补偿仍是效果 owner；`files-only` 包含文件/Document 内容恢复，不包含 Pi 对话历史回滚。
- 冲突检查沿原物理路径 lease 和原 unresolved journal，识别不同 workspace ID、嵌套根或别名下的相同资源。等待路径 lease 在工作区短元数据队列外，外部 Surface 等待不占该队列。普通扩展 callback 提前返回不能释放已受理的实际 domain promise；真实原回执独立提供效果与停止证据。已派发 native Surface 请求保留精确原 ACK，取消不伪称执行端已停；失去 owner 而无证据的路径仍保持未知及未决资源保护。
- 原 Host Tool 对账只接受 Operation/execution-owner 身份，由 Catalog 派生唯一 Integration journal，worker 核对原因果关系与路径事实。读取原收据不需要仍可访问的物理目录或新的 source grant，也不重执行、扫描补偿或杜撰停止。已真实停止但效果仍未知的回执可释放执行占用，业务不确定性和 journal 冲突保护仍独立保留。公开 child_status、Thread snapshot/UI 同步展示真实 source/provenance、profile、报告与固定结果。Catalog 总格式仍为 **19**，collaboration 域升为 **3**；旧内部域格式拒绝，不提供双读或迁移。
- 整合检查闭合了两个真实事件窗口：child 在旧推进任务排空期间产生新 revision，完成后按原新事实再检查一次；旧 epoch 的 domain discovery 排空时保留新 epoch 唤醒。没有新事实的失败不自旋。来源 grant 从受理就归原 Run 生命周期，撤权失败保留追踪；清理失败只报告，不覆盖已经取得的原效果回执。GC 同步补齐 child Launch 的必需扩展绑定引用，避免受理后尚无子 Run 时误删内容。
- 独立原反例闭合了真实逐路径取消与停止证据：第一条文件 ACK 后取消不再派发下一条；完整冲突与补偿 ACK 能确认执行停止；补偿不触碰从未由本次派发、后来被外部编辑成相同目标的文件；多 Surface owner 只撤销已派发组，不派发后续组。原 journal 保留实际 apply/undo 事实，未派发槽不伪称观察过 safety。Rust 对账接受已有停止证据且无 applied/compensated 声明的原 `external-intent`，仍拒未确认的 `external-dispatched`；终回执丢失后恢复原公开正文且重投幂等。缺失旧目录只保留其原资源身份，不阻碍无关目标；WorkingResult 的 root/baseRoot 沿原记录寿命保留，旧基线经 rebase、源分支删除与 pin 释放后仍可 GC/health。
- 最终完整 runtime **251 passed、0 failed、2 个既有 ignored**，kernel lib **39/39**。Host 组合 **16 文件 263/263** 后，最后取消修复单独复跑 owning Integration **69/69**；该 69 包含此前组合中的 Integration 用例，不作相加。已安装 broker/SDK 的 Integration 用例 **5/5**，原 invocation 生命周期 **3/3**，UI **35/35**。这些证据分别覆盖真实原生 Catalog/Storage、协调器、安装入口和 UI，不冒充同一条 Host 端到端链。完整 Host 声明/测试类型、UI 类型、定点 lint、协议一致性、文档链接与实际 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建并 stage，SHA-256 `e55537a0e4572d6ca4eb99a4da1b71743c8beaefc76e33e04068b67bfb6e0fef`。
- 独立审查按设计核对来源、写入、结果、集成、取消和恢复，保留四项原反例的修前/修后执行证据，并复核真实 Catalog/Storage 的最后回执恢复及 GC 根；本阶段无剩余已知源码行为阻断。**实际 Host/kernel 端到端缺口仍保留**：Unix socket `EPERM` 与官方提升初始化失败未解除，新增私有 child 写入 → 原 WorkingResult → Wait → 重开 native 场景仅通过类型检查，未执行。其余领域、GC 控制隔离、跨平台和默认 Pi 产品迁移仍未完成，两份设计尚未整体交付。

## 2026-10-10 增量：运行中策略安全换绑

- 原 Catalog 保存策略选择命令、候选与激活回执，原 Launch 保存实际 generation 和完整 target。选择同时核对当前活动代与用户看到的 desired selection ID；原命令重投返回原回执。候选描述/依赖/规划模型准备独立执行，ready 不等于 active，失败或被取代候选不撤掉仍有效的活动代。首次准备使用原 launch-bound/checkpoint 事实派生 `policy_preparable`，已经使用的默认策略不会在恢复时被当成未选择策略。
- Run worker 只在真正的新决定边界换绑。旧 decide、已存待执行决定、ModelStep/工具配对、策略图/规划动作和原观察先按原绑定收尾；独立 JobAccepted 不形成整棵任务树的终态屏障。新代的策略和 planning provider 在同一 live slot 发布，主模型、工具和 source 沿各自原权威。原子激活保存新代、私有状态、真实未消费 continuation 与事件，不伪造 Started、模型请求或历史输入。
- `varin.agent.policy@3` 的描述明确 `modelRoles` 与 `stateTransition`。同一完整 target 可保留状态；跨 target 通过显式 `transitionState` 返回 compatible 或 incompatible。没有钩子不猜兼容，也不默默清空状态。不兼容时保留旧代；用户明确的 `restart_state` 只重置策略私有状态，保留会话历史和独立工作。示例、SDK、合同、Host 与 Rust 同步替换旧内部合同，不增加 @2 兼容翻译。
- 原 checkpoint 区分 decision 与 activation，并记录 pending/consumed 和真实续事件引用；同一记录分别保留已提交状态与待执行决定的提议状态。正文在 worker 写入 ContentStore，发布保护与 GC 根覆盖候选 planning 配置、状态、动作和 continuation。激活已提交但下一决定/动作未完成时，重开恢复已提交代及原动作；已读取 ResultChunk 不被较旧图完成事件覆盖。真实 Catalog 重开将未激活候选记为 interrupted，保留 active；原终态 writer 在同一事务结束待选候选，live release 只释放持有者。Catalog 现为格式 **19**，旧内部格式拒绝。
- Host 精确恢复原启用 artifact/配置，不按当前 route 偷换；新 route 只准备下一候选。私有 decide/transition/取消/release 均携带 generation 与 transport epoch，规划模型按原配置/账户重绑并拥有分代凭据。整合修复了旧取消 ACK 迟到中断新候选，以及跨 epoch 旧异步清理删除同一已提交代新凭据的真实窗口；清理只作用于原 attempt/epoch。实际 callback 继续由原 service pin 排空，abort 不是停止证据。
- 认证的策略 inspect/restart/cancel 入口及 `ThreadsAPI`、Thread snapshot/UI 已接通。展示实际 active、持久候选及尚未形成持久 target 的 Host 准备失败。后一类临时诊断随 inspect/snapshot 刷新可见，暂停且无其他事件时尚无独立主动推送。重启/取消使用当前显示的原 selection ID；Pause 期间可准备，但没有候选更新、child 完成或 Host 重连能替代显式 resume。固定 child/context profile 不被策略更新扩大权限。
- 冻结验证：完整 runtime **250 passed、0 failed、2 个既有 ignored**；kernel policy 聚焦 **8/8**，包含旧模型/工具/独立作业受理到下一代、Pause/child 原组合和真实两代规划 HTTP/私有凭据接线。主模型未在规划组合中被误调用；模拟 HTTP 只证明请求/身份/次数，不证明模型质量或真实账号认证。合同/SDK **118/118**，Host 五文件 **42/42**（含真实安装 broker 11 项，其余为明确的管理接口 fixture），UI/投影 **24/24**，application-client **5/5**。完整 Host 测试与 UI 类型、定点 lint、协议一致性及实际 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建通过，SHA-256 `1eafa000321167cdfba011c89f8a7319052a4a817417001a2968792172aad36e`。
- 独立审查复现并修复了激活后旧 Complete 决定败给新输入、输入已交付却随即崩溃时，恢复跳过新决定并错误采用未生效状态的问题。同一原探针精确核对 InputPending，完成修前失败/修后通过；Started、Delivered、Resumed 在 live 与崩溃/GC 后都保留已提交状态，仅重新决定一次。当前本阶段无剩余已证实行为阻断。
- **实际 Host/kernel IPC 端到端仍未验收**：Unix socket `EPERM` 与官方提升入口初始化失败未解除，本轮 native fixtures 只做类型检查。组件、真实安装 broker 和原生 Engine 证据不拼接成未运行的完整端到端成功。可写子任务/条件集成、其余领域出口、GC 控制隔离、跨平台和默认 Pi 产品迁移继续推进；两份设计尚未整体完成。

## 2026-10-10 增量：普通工具目录、执行回执与材料入口

- 已安装普通 service 的单份 `tool` 声明进入与 ModelStep、PolicyAction 共用的 ToolDirectory。说明、输入/输出 schema、示例和 source 元数据沿同一声明保存；共享既有 Ajv 编译器，不新增 schema 引擎。公开协议由原 schema 生成，内部执行类型仍归 Rust。原 MCP 权威作为专用 adapter 接入通用 Host tool bridge，不用伪 MCP 服务包装普通扩展。
- Launch 保留精确 package/artifact/service/declaration 绑定；各贡献独立准备，同一 Run owner 合并 MCP 与普通扩展的 ready snapshot，闭合请求/动作边界才激活。初次 Run 不等待全部冷服务。真实并发反例修复了 A 已 ready、B 随后失败时错误回滚 A，以及旧 candidate 被清除后只恢复 Host map、没有重新发布可激活目录的问题。启动 ACK 前完成的后台贡献等待原启动唤醒取得真实 publication 结果，不能提前成功或吞掉失败；临时 Rust holder 变化也不提前释放 Host candidate 的实际 pin。
- 普通路由替换保留被冻结 owner，明确 disable/revoke 立即撤权；重新启用同一 artifact 取得新世代，不复活旧调用。独立真实安装探针发现并修复了恢复误用当前路由的问题：保存的 A 仍启用且原 artifact 可用时，当前路由已选 B 也能精确恢复 A；下一候选才按 B 准备。当前路由文件损坏不阻碍仍有效 A 的精确恢复，但不能产生新选择或候选；原 artifact 缺失、禁用或完整 binding 不符仍明确失败，不添加旧版本 loader 或静默改用最新实现。
- ToolDispatched 持久记录实际 Kernel/External 执行 owner；调用完成与执行者停止分开。取消观察可以返回 unknown，但原 callback、资源 occupancy 与未确认回执继续归原 owner。重启不把外部 Result 当成本进程已停止；迟到回执按原 invocation/执行 epoch 鉴权，worker 先保存完整正文，再由 Catalog 提交及 ACK。换传输 epoch 只重投原事实，不重执行工具；已确认回执不改原模型配对/调用 completion，不复活终态 Run。输出 schema 不符也保留收到的原 JSON 证据。Catalog 现为格式 18，旧内部格式拒绝。
- 权限使用真实 ModelStep 或 PolicyAction origin，不制造 requestId。Host 从原 Operation、Run 与不可变 source 派生调用域，只把按原 broker owner/generation 核对的 opaque token 送入扩展；调用结束后能力句柄失效。路由读取原 Run 准入 scope 的短元数据查询，null 保持无项目，不读取当前 branch 的 checkpoint 正文；这是 owner 对齐，不宣称已发现正常非终态 Run 的跨项目执行。Source 启动、重绑与后继 Run 统一从原目录投影 source-owned tools，普通扩展不会被误当作原生文件工具。
- `materials.snapshot` 复用原 WebMaterialStore、snapshot grant、持久 collection 和 Rust blob range owner。普通 SDK 示例位于 `examples/extensions/material-snapshot-tool`，保留 UTF-8 范围/哈希、空值、缺失/拒绝、冲突与损坏语义；不造 Pi session 或另一份材料库。真实 native Storage 范围入口已经接线，首次哈希校验仍可能读取完整对象，不声称所有底层 I/O 都受输出页预算限制。
- 认证的 `POST /api/threads/tools/inspect` 与 `ThreadsAPI.inspectTools` 返回实际激活目录、持久绑定和独立准备状态；撤权/未重绑不可调用，正常退休的原 pin 保留可用性。准备完成不等于激活，目录可见不等于已授权。这是当前工具查询出口，完整 service/event/UI slot 查询和 codemode 尚未完成。
- 验证按真实范围分别记录：runtime 库及全部集成目标分段合并覆盖 **246 passed、2 个既有 ignored**，不是单次 full-suite 全绿；旧 JobAccepted fixture 的停止证据修正后相关 39 项通过。实际 Rust bridge/Catalog/RunTools 两项、其余 kernel lib 23 项及 Run scope 查询一项通过，runtime doctest 目标完成但没有用例。最终 portable core 16 项及既有 continuation 8 项、材料域六文件 76 项、application-client 5 项通过；schema 编译器及既有 MCP 消费验证通过。Host 测试类型、UI 类型和协议一致性已核对。真实安装组合使用明确的 Catalog 管理查询 fixture，不能冒称实际 Host/kernel IPC。
- **真实 Host/kernel 端到端仍未验收**：本环境 Unix socket `EPERM` 及官方提升入口初始化失败的既有阻塞未解除，相关 native fixtures 只做类型检查。实际 Linux 开发内核构建为 `0.9.25`，SHA-256 `ea5283e91eb0a46d426a016f4163e0786b33594923abd17293fb37cfe9590950`；这不是正式发行或跨平台验收。默认 Pi 产品路线未切换，完整策略换绑、可写协作/条件集成、其余领域出口及 GC 控制隔离继续推进。

## 2026-10-10 增量：普通工具 SDK 与调用域边界

- 普通 Host service provision 可携带单份 `tool` 声明；`provideTool` 从同一 manifest descriptor 注册 `inspect`/`execute`，保留真实 JSON null/空值，缺失与非 JSON 结果明确失败。工具声明的输入/输出 schema、说明、完成种类和 operation 提示不是权限或可重放证据。本增量只开放 Result 作者合同，没有伪造 Job 接口。
- 工具 activation 必须与冷声明完全一致，漏注册或不匹配的候选不替换旧世代。普通非 tool 服务仍按原 id/version 取 manifest 权威，不因新工具规则要求作者重复声明 `multiple`。整合以真实双 broker 既有路由反例复现并收窄了这项过宽限制。
- 原 `HostServicePin` 增加撤权 signal；正常更新保留被冻结世代，disable/crash/revoke 唤醒调用。Host-only invocation scope 的值不跨 wire，child 仅携带按原 extension owner/generation 核对的 opaque token；SDK 提供调用级 capability client，callback 结束后句柄失效。原 pending/inFlight 等真实 callback response 或 process exit，取消等待和发送 kill 都不冒充已停止。通信失败请求原 supervisor 停止失效 broker，但仍保留其在途 callback 到实际结束。
- 三包 build/typecheck/lint 通过。最后完整合同/SDK/Host source suite **200 项中 199 直接通过**；另一项既有候选 storage 回滚测试仅因新增明确 `IPC disconnected` 文案不在原断言内失败，窄修该断言后原 case **1/1 通过**，候选/catalog/三文档回滚及重试行为断言均保留。已有本地 npm/Git fixture 使用 workspace npm cache，不新增产品依赖。独立真实安装探针验证取消中的 v1 callback 尚活时 v2 可发布和执行，释放旧 model/service pin 后 retirement 仍等待真实旧 callback 返回；本层无剩余行为阻断。
- **本次提交只闭合 SDK/扩展 Host 层**。原生 ToolDirectory、真实 ModelStep/PolicyAction 权限、执行端停止证据及迟到回执恢复、材料 snapshot 入口正在下一增量接线，未计为本层已交付。实际 Host/kernel 全链仍受已记录 Unix socket 环境限制，组件证据不能拼成未运行的端到端成功；Catalog 格式不在本次提交中改变。

## 2026-10-10 增量：独立交付与显式暂停续接

- `varin.agent.policy@2` 已接通 `deliver`、`pause` 及 `delivered`、`resumed`。交付直接沿既有不可变历史写入，来源保留原 PolicyAction 和策略身份；所有 provider 将其序列化为同一 Agent 的 assistant/model 输出，不制造 ModelStep、工具配对或 provider opaque 原文。空串和 Unicode 均保留真实值。正文、历史 envelope 和私有 checkpoint 在 worker 持久化，短事务同次提交原 head、动作和事实。
- Pause 同次提交原策略动作、checkpoint、Wait 与 Run waiting 状态。暂停中输入仅排队，独立 child/job 可以完成，Host 重连和 Catalog 重开都不自动续跑。`runtime.run.resume` 必须指定原 Run/Wait，先查原成功回执，再在公共锁外等待原停靠 worker 退出，原子提交 `policy.resumed`、Wait 消费、Run runnable 和原 launch 的重绑要求。重复旧命令返回原 cursor，不能打断新 worker 或解除下一次 Pause。一般 Wait 续接、Supervisor 准入和最终 Run 状态 writer 共用实际条件，不能越过 Pause；Run 取消按原 owner 结束 Pause，不读取 reason 正文。
- 统一恢复读取最新的实际 graph/model/control action。排队输入进入真实历史时，不覆盖尚未消费的 Delivered/Resumed 边界；下一动作准入败给输入时，未执行动作的私有状态不会提前生效。已有 action/checkpoint/input 事实足以区分原已执行状态和待执行决定，不加第二套事件队列。真实反例覆盖交付已提交而丢回复、Resume 后模型决定已存而新输入先交付再崩溃、原已存决定恢复及旧 resume 命令面对新活 worker。
- Launch 公开 `startable`、`pause` 派生视图，组合 Catalog 与真实 worker/quiescence 状态；Host 提交、恢复、提问/上下文/协作续接汇入原按 Run 单飞入口。现有事件泵启动/重连发现 launch，此后按持久 cursor 定点消费 `policy.resumed`，不等待冷凭据/扩展准备才观察 child/process。冷 context 准备与发布沿同一取消生命周期，旧异步结果不能迟到发布或重绑。独立审查复现了旧 start 回执未返回期间明确 resume 的新唤醒被单飞吞掉：原单飞现在合并期间的新 wake，退场前按有效调用者的 signal/凭据重读同一启动条件，不新增轮询或恢复队列。
- 客户端与 HTTP 分开 `resume(runId, waitId)` 和 `retryPreparation(runId)`，UI 显示原 Pause reason/Wait，重复点击和分支晚响应隔离，排队输入不冒充恢复；pending 准备期间 Stop run 和取消仍可达。新增普通 SDK 示例 `examples/extensions/delivery-pause-policy`，不自行写历史、维护 Wait 或开恢复传输。Catalog 格式为 **17**，旧内部格式直接拒绝；两设计正文仍保留完整目标，页首改为实施中并链接本台账。
- 最终完整 runtime **245 passed、0 failed、2 个既有手动诊断 ignored**；其中真实控制/恢复用例 6 项、provider 角色序列化 1 项。Kernel `policy_review` **3/3** 验证真实 Engine/Catalog/Storage 的原观察/取消及新增 child 完成后父仍 Pause、重开后显式恢复并观察原报告。合同 **3/3**、SDK **2/2**、真实安装 broker **9/9** 与 portable Host/HTTP 消费 **8/8**（分别执行）、UI 行为 **22/22**；最后示例简化后重建安装窄验 **1/1**。Host 全源码/测试类型、UI 类型、定点 lint、协议生成、文档链接和真实 Host bundle 通过。Linux 开发内核 identity `0.9.25` 构建通过，SHA-256 `e70f33144f9d0b2f1e617b486dcdbe720b43ef0d4c81fd07980b7b3834a8edb4`。
- 独立审查按设计复核真实原子性、恢复和取消，并以仓库外原探针完成 Host 丢唤醒修前失败/修后通过；另通过 child 受理 → Deliver → Pause → 子任务完成与重开 → 显式 resume → 原 Wait 报告交付与再重开 → Deliver/Complete 的真实 Engine/Catalog 组合，确认原受理不变、无伪 ModelStep 或重复历史。该探针的源受理为 fixture，不替代 Host 授权验收。本阶段无剩余源码行为阻断。
- **真实 Host 端到端缺口仍保留**：新增已安装 SDK → HTTP 显式恢复 → Catalog/history 的 native 场景仅通过类型检查，未运行。前述 Unix socket `EPERM` 和官方提升初始化失败未解除；未更换产品 transport，也不把 broker 提供事件和原生 fixture 拼成端到端成功。安全策略切换、普通扩展工具/发现、其余领域、实际跨平台及默认产品迁移仍未完成。

## 2026-10-10 增量：策略直接派生与观察子任务

- 已安装策略可在父 ModelStep 之前通过普通 `tool_graph` 调用 `dispatch`，继续自己的独立读取，再用 `wait_child` 观察原任务。核心核对真实 PolicyAction/node、原 ToolIntent、父 Run/Thread、源授权及冻结调用；沿原 ChildTask、独立 Thread、源 pin 与模型/凭据 owner 受理。没有伪造模型调用，也没有增加第二套子任务动作或状态表。子任务仍限定已实现的 `model: parent`、`read_only` 与固定源合同。
- Child/Wait 受理原子保存 canonical JobAccepted；模型调用才写原 `tool_calls` 配对投影，策略图消费同一原始调用事实。快速子任务可在父图消费前发布真实终态，原受理不被覆盖；崩溃恢复只补消费，不重复准备、源 pin、派发或模型请求。Wait 参数/来源在 worker 读取，提交核对原调用与图取消。
- collaboration wrapper 在调用策略之前检查真实待处理观察，保留原私有 checkpoint，避免把一个未执行的新动作的状态提前记账。报告与取消观察沿原 Wait/head 交付，然后续接原图事件。整合还复现并修复了“Wait 已注册、父尚未停靠时取消”的窗口：仅由原 child owner 认证的待交付取消观察可完成停靠，既有交付路径提交一次真实取消事实；其他 cancelled Wait 仍不能进入执行。观察结束或父 Run 结束后，只释放该观察自己的 occupancy/admission，独立 child 的寿命不受影响。
- 新增普通 SDK 示例 `examples/extensions/collaboration-policy`，展示派发、独立读取、显式观察、报告后父回答及 broker 重开后的原身份。Catalog 仍为格式 16、collaboration 域仍为 2；本阶段不改变持久形状，也没有旧格式兼容分支。 独立审查复核真实执行链，并验证迟到原受理不覆盖早到终态、同图多观察中一项取消不消费另一项报告，以及多次重开后的原策略续接；本阶段未留源码行为阻断。
- 最终完整 `varin-runtime` **238 passed、0 failed、2 个既有手动诊断 ignored**。Kernel 聚焦 **5/5** 覆盖真实 Engine/Catalog/Storage 的 source pin、受理后独立推进、原 checkpoint 停靠、报告/取消后续接与观察释放；模拟模型仅证明执行接线，不证明模型质量。真实安装 SDK/broker **3/3**、Host 全测试类型、示例窄类型及定点 lint 通过。 协议生成一致性和文档链接检查通过；实际 Linux 开发内核 identity `0.9.25` 构建通过，SHA-256 `40ec7950ca95d472d24bca5da1c122efe59d9da5247e2b999f6780dea3ee84eb`。
- **真实 Host 纵切继续保留未验边界**：新增的固定源/阻塞准备、SIGKILL 重开、取消观察后三条 Host/kernel 场景尚未执行，原因仍为此前确认的 Unix socket 环境限制。Portable broker 提供事件的检查与原生 Engine/Storage 检查不拼接成端到端通过。独立结果交付、显式暂停/恢复、安全策略切换及其余领域仍继续推进，两份设计与默认产品迁移均未完成。

## 2026-10-10 增量：一般策略工具图与原始调用完成

- `varin.agent.policy@2` 的 `tool_graph` 直接替换旧只读图；Rust、合同/parser、SDK、安装示例和 Host 消费一起更新。节点保留真实 action/node 来源、冻结 schema/源视图/执行端世代和显式依赖，不制造 ModelStep 或 provider 工具交换。合法新图边界可激活已准备工具候选；已受理图恢复仍使用原绑定。
- 模型与策略复用同一单调用准备、授权、完整资源/容量准入、派发重核、执行和结算。可信 opt-in 的纯读 Result 继续轻量；其他调用在派发前进入原 Operation owner。逐节点准备及已完成正文读取独立运行，不阻塞无关节点；图父仅编排，不拥有第二份效果账本。文件对账读取持久 `ToolOrigin`，不从操作 ID 猜模型请求。
- Operation 的 `call_completion` 保存原调用完成，节点回执与模型配对消费同一事实。tag 区分未派发、带必需正文引用的 Result 和 JobAccepted；实际 JSON null 仍有内容引用。JobAccepted 结束受理调用、允许依赖推进，作业终态由原 Operation/执行端回执和显式 Wait 观察。早到或迟到终态不覆盖原受理回执。
- 恢复分别处理原身份未派发重准入、缺失可信纯读重做、已派发效果查询原执行端、canonical 回执已存而图尚未消费。单节点持久取消在重开后仍生效；取消赢得派发提交时，使用精确未进入执行端证据结算，不吞其他提交错误。独立反例还发现并修复了旧恢复分支把只读 Job 的 `Effect::None` 当作已停止、误记 Failed 并拒绝真正终态的问题；现在依据原 Job 合同保留完成未知及占用，等待原回执，不重执行或补造受理。
- memory 策略调用沿既有领域 owner、CAS 和原回执工作。选用 memory evidence 时，核心认证 action/node、canonical 结果身份及原 memory 操作后，仅从候选请求删去同事实的重复 tail；不选择 evidence 时仍由原可信回执/tail 送达。主请求及辅助推理共用原 selected/sent/committed 交付 owner，稳定 system checkpoint 不因写入临时改写。
- 显式选中的旧策略版本不会因安装了唯一新 provider 而被悄悄替换。版本判断复用原作用域 routing/selection，候选准备沿既有 routing revision 与同服务选择快照核对；成功和可选缺失出口都验证同一候选，不新增路由库或重试层。Catalog 当前格式 16，旧内部格式直接拒绝；当前及历史原调用完成、图调用与结果引用参加同一 ContentStore 回收。
- 最终完整 `varin-runtime` 回归为 **231 passed、0 failed、2 个既有手动诊断 ignored**。实际 Engine/Catalog 覆盖上述恢复、Job、取消、零假模型配对和 memory evidence/tail 消费；其中 memory writer 是领域 fixture，不等于 production personalization owner。独立审查按设计复核共享生命周期，并用同一只读 Job 窄探针完成修前失败、修后通过，确认原终态接受、原受理不变、无 stop 不释放占用及父 Run 不复活。
- TypeScript 合同/SDK **114 项**、真实 ApplicationExtensionRuntime/broker 选择 **8 项**、UI 行为 **19 项**通过；完整类型依赖重建、Host 测试类型、UI 类型、Host bundle、改动 TS lint、协议生成一致性及文档链接检查通过。实际 Linux 开发内核 identity `0.9.25` 构建通过，最终 SHA-256 为 `b30ece5a45918defe834c14b74929ca80aec1b5e7e2582d1fe33c09efb8041a4`。
- **真实 Host/kernel 纵切仍未验收**：新增 memory artifact 确实通过 SDK helper 打包，源码包含真实 owner CAS 后崩溃、取消迟到、独立读取、选择/不选 evidence 和失败请求后续发窗口；当前环境的 Unix socket 限制未解除，这些 native 场景未计通过，也未用普通 Engine fixture 或 SDK/broker 通过拼接为端到端成功。上一阶段的具体 IPC 诊断继续适用。
- 本阶段仍不等于完整 PolicyAction 或两设计完成：策略子任务、独立交付/暂停及安全策略切换继续推进；MCP 权限、计划、提问、进程观察和协作的来源接线各自保留真实范围。完整内容回收仍占 Catalog owner，普通扩展工具、其他领域及默认产品迁移另有未闭合项。

## 2026-10-10 增量：工具结果与原始回执正文

- 普通工具结果、未派发原因和原始外部执行回执已进入既有 ContentStore；Catalog 仍是唯一执行事实 owner，只提交内容身份及 outcome/effect 等短元数据。普通正文与权限/策略/等待等短控制状态显式区分，包含 `permission` 等同名键的普通 JSON 不会被当成控制状态。Job 受理只保存原作业身份，不为短回执制造正文对象。
- 写入先在 worker 持久化正文，publication lease 保留至原子事实提交；公开 Operation/events、模型批次配对、记忆信任与投影、文件/计划/进程对账、子任务迟到回执和重启读取统一恢复原内容。当前及历史事件中的引用都是回收 roots，重复内容身份只校验一次。此阶段将 Catalog 格式升至 15，现行版本见上方最新增量；旧内部格式明确拒绝，不引入兼容读法或转换器。
- 进程等待固定 Run/Wait/进程/Operation revision 和分支 head，在 worker 读取原回执并准备生命周期消息，提交重核原边界。取消观察不读取原进程正文、不终止进程；已有交付复用原历史。迟到子任务回执也按同一准备/提交边界结算。
- 最终恢复检查实际复现并修复了旧崩溃窗口：执行端回执已持久化而核心结算尚未完成时重启，重复原回执不能因幂等早退而永久保留未知状态。现在只在原终态事实尚未应用时补结算；已应用的相同回执不新增 revision 或事件，成功/确定效果与失败/确定无效果都使用原证据，不重执行。
- 最终源码的完整 `varin-runtime` 测试通过：225 passed，2 个既有手动诊断 ignored。独立仓库外探针验证 null/空值、控制键碰撞、大 Unicode 正文的公开读取/events/GC/重开往返，正文缺失显式报错而控制取消仍可执行；另独立验证上述成功/无效果恢复与重复幂等。Kernel 编译、实际 Linux 开发构建、Host bundle、Host 测试类型及协议一致性检查通过。
- **真实 Host 消费验收仍受环境阻塞**：冻结 Linux 开发内核 SHA-256 为 `e6d97f9eaf589fab37b4127060999374179e99250180b267b05f2f053b232bb1`。所选文件/进程、计划、记忆、子任务、审批和提问 103 项在业务执行前因本地 Unix socket `EPERM` 失败；官方提升执行又在 sandbox 初始化失败。最小诊断确认 `/tmp` 与 workspace 的 Unix socket 都不可监听，而 loopback TCP 可用。这些用例未计为通过，未修改产品 transport 迁就环境，也未声明正式发行或跨平台验收完成。
- 本阶段补齐结果/回执正文边界；完整内容回收的 mark/verify/sweep 仍占 Catalog owner，另行处理。下一主线回到一般 PolicyAction 工具图、真实子任务、交付及暂停，沿用同一执行/资源/恢复 authority；完整能力组合和默认产品切换仍未完成。

## 当前增量：控制路径隔离

- 模型/工具启动装配归各 Run worker；受理先登记取消 owner 并返回身份，排队 Run 只在提升后装配。选用与辅助策略模型准备也已移出 Agent actor。真实 Catalog 的阻塞准备/独立 Run/取消后无模型派发验证通过；Windows HTTP、凭据等待及队列重启续接六项通过。
- Run 启动恢复在独立 worker 遍历不可变历史并读取正文/回执，发布前重核实际执行边界；控制受理不等待历史恢复。
- 物化的构建、校验和恢复观察离开共享 Storage 队列；Storage 保留物理租约、journal、提升授权和事实提交。恢复目录身份及源回收后的幂等回执缺口已修。
- 模型批次使用必需的无 I/O 预规划合同，各项独立解析、授权和准入；共享资源预约保留可能冲突调用的先后关系，完整资源与容量仍原子取得。
- 普通/策略正文和记忆交付解析在 worker 完成，事务保留真实来源和回执核验。最终取消与辅助模型旧 head 派发两个反例已修。
- 合并后运行时聚焦 79 项、真实物化场景 12 项、Host 物化回归 3 项通过；验证范围、产物和剩余结构边界见[增量审阅](../reviews/runtime-control-isolation-2026-10-09.md)。独立内容传输、冷打开隔离和完整能力组合继续推进，不将本阶段记为全设计完成。

## 当前交付

本次持续实施已接通独立控制/内容连接、冷打开 worker、统一工具端点和模型适配器注册。
真实 Windows 内核已验证双向大内容传输、阻塞内容时的控制/取消、简短取消回执；模型目录保留容量、思考档位与采样配置。
Run 内模型/思考配置已接到安全请求边界：期望选择独立准备，成功后原子激活；旧请求及工具保留绑定，失败不回退付费模型。排队受理固定当时配置，后续受理继承选定目标。真实 HTTP 跨模型工具续接、独立凭据、失败不外发、提问后重新绑定，以及 SQLite 激活后重启均已验证。
自动容量准备已接入现有用户/可信项目设置、独立摘要 Run 和持久上下文等待。候选固定祖先范围，等待期间追加输入保留；取消停止所属摘要，失败不重复付费生成。重启能发布已提交的原输出，派发后未知的请求保留待核对状态，不自动重发。摘要配方已从 Run 配置移入不可变内容，Catalog 只保存归属与边界引用。
超长源已分成固定内容引用；逐段模型输出持久保存，后段继承前段摘要，全部完成才发布。文本范围按 UTF-8 边界保留可回查身份，图片保持多模态材料。预算仍是本地估算，尚不声称精确匹配 provider 分词。
计划及记忆工具的身份判断改读 checkpoint 同次提交的 scope 元数据。记忆投影正文、回执合并及可信回执读取离开 Catalog 控制锁；发布核对实际内容引用和 checkpoint。并发状态变化重新读取 owner，停止后迟到的已确认效果仍可结算。
首次输入、子任务初始上下文及摘要输入统一先准备正文、后提交引用；初始 checkpoint 与输入、launch 同次提交。排队消息只存身份/状态，正文加载、编辑准备和公开查询移到 worker；送入模型时重核所选版本，新增尾部不使已选前缀作废。幂等意图独立保留原输入。真实连接检查发现上传阶段也会乱序，现由控制 offer 在编码/上传前登记同资源顺序，取消唤醒既有准入队列。对应输入 Rust 七项、准入/继承/子任务/摘要十八项及 Host/kernel 六条实际连接链路通过。新 Catalog 的全部域在同一事务安装，实际容量不足失败后可重新打开；旧内部格式不转换。
对话分叉固定捕获的源 head、上下文与记忆引用，祖先/工具配对检查及新正文保存移到 worker；源分支继续追加或换 checkpoint 不使固定候选作废，旧 owner 候选不能迟到提交。线程创建和分叉与输入共用 ingress 顺序。Rust 的配对/冻结捕获及实际 HTTP 的重启、压缩、分叉后续发链路通过。完整子任务记录和内容回收继续拆分。
MCP 工具共享不可变世代，Host 按具体世代及持有者保留连接；旧世代等在途调用释放，等待中的 Run 保留活动 owner。回复、取消及关闭使用事件唤醒，取消仍按实际效果回执结算。统一目录的候选准备不提前退休活动绑定，未变端点复用。配置/工具变化已接到作用域订阅和独立候选准备，闭合 ModelStep 边界发布，失败或过时候选保留活动组合；首次发现不循环取消自己的准备。发布保留不可变组合引用，回收及重启能核对实际选择。直接服务独立冷启动，同作用域共享准备和连接；就绪贡献逐项进入候选，慢服务不挡模型或其他工具。持久 schema 选择与实际活实例身份分开，禁用后重新启用同配置不会复活旧请求。重启只等待已选依赖，并恢复原目录。真实 stdio 验证覆盖授权/按需发现、配置损坏后保留旧组合、生成中更新、禁用及重新启用、慢服务准备中使用快服务及提问重启；SQLite 验证覆盖活动请求拒绝切换、未发布选择不能伪装恢复、回收后重启及旧 epoch 候选拒绝。其余扩展工具发布、MCP 资源/提示/Tasks 和脚本出口继续实施。
启动记录现只保存模型/来源/策略元数据和不可变内容引用。工具、MCP 描述及规划能力的解析、校验、保存和完整查询序列化离开 Catalog；来源/队列继承直接保留引用，工具激活及请求提交核对已准备的内容身份。回收保留各启动引用，损坏工具正文不阻断来源和取消。实际链路还修复了策略准备对旧默认组合名字的耦合，改为核对装配者给出的真实基线，并保留原选择的幂等恢复。Rust 聚焦验证覆盖启动/回收/来源、子任务及摘要共 22 项；真实 Host/kernel 覆盖 MCP 重启/重新启用、dispatch、来源继承、检索策略、规划和精确重绑七条链路。该轮内部 Catalog 使用格式 14、launch 域 3、collaboration 域 2，未保留旧正文读写或格式迁移。

策略 checkpoint 的私有状态及动作已改为不可变正文引用。普通执行、读取图和辅助模型受理先在 worker 保存正文，Catalog 只核对身份并提交引用；继续执行及恢复在锁外读取，Wait 仍核对原 Run 和实际触发/取消事实。回收保留两类引用。相关 Rust 图与辅助模型 33 项通过，手动性能诊断未执行；后续图定义及回执拆分见下段。

读取图和辅助模型的完整意图已改为不可变内容，图内共享工具目录只存一次。节点、依赖和回执由同一 Catalog 逐项索引；节点结算、证据归属和准入查询不解析完整图，也不重写其他节点的回执。恢复在 worker 还原正文及一致的节点快照，回收保留动作与回执引用。Rust 聚焦 34 项及真实 Host/kernel 五条链路通过，覆盖图/规划、精确重绑与问题重启；损坏图正文的反例确认取消和逐节点结算仍可完成。

子任务状态记录已拆出任务文本、配置和工具目录引用。受理在 worker 核对原 dispatch 参数并保存正文，提交核对原 Operation revision 与父任务当前授权；家族调度、取消及资源释放只读取元数据。公开任务视图、初始准备和报告分页在 worker 还原内容。Rust 子任务 12 项、真实源授权交接边界两项及 Host/kernel 启动/取消/重启/长报告四条链路通过；新反例覆盖回收保留与损坏正文下控制可用。报告选取、等待预览及交付正文随后也移到 worker；提交重核原 Run/Wait/分支 head 和取消，不允许迟到候选覆盖新状态，已有可见报告沿祖先记录复用。相关 Rust 13 项及真实 Host/kernel 启动、取消、重启、失通知交付和长报告五条链路通过。新增取消窗口反例确认旧候选不追加消息，新观察仍能收到原报告。
提问作答正文独立准备，收据保存内容身份，提交仍核对原问题/分支/等待及取消。问题查询和 Run 取消只读取本 Run 的相关问题。等待收尾按 Run 协调，join 不占 Catalog 或全局 worker 锁；作答和执行端收尾离开 Agent actor，取消意图仍先在其 FIFO 中提交。聚焦 Rust 反例确认两个等待者不会提前完成，阻塞收尾时取消仍可受理；实际 Host/kernel 的提问和进程等待 11 项覆盖幂等、答复/取消竞态、多问题、两种模型协议、恢复和授权。Windows 正常关闭先取得守护进程的持久停止回执再关控制管道；保留真实 exit code/signal 和 stopApplied，不把无回执说成已确认停止。
真实 Windows Host/kernel 验证覆盖后台、阻塞等待、两种取消、后段失败、完成后发布前崩溃和后段派发中崩溃七条链路；独立 Rust 摘要/内容回收检查覆盖原文、配方及材料保留，分段检查覆盖中文、非 BMP 字符、转义及图片身份。Provider 容量错误恢复、可替换预算策略、完整产品迁移及领域出口继续实施，整体设计尚未交付。

普通工具参数和审批 call/scope 已改为不可变内容引用，在 worker 保存、恢复和还原公开视图；受理及审批消费核对原参数身份，控制事务只处理元数据。todo 授权对完整模型请求的读取也移到锁外，提交前重核 owner 和冻结请求。记忆及文件效果恢复同步使用原参数的公开视图，修复了记忆恢复遗漏的旧格式读取。回收保留已结束审批的审计正文。Rust 聚焦 47 项、真实 Host/kernel 的提问、审批、todo、记忆恢复、子任务和进程等待 11 条链路通过；相关 crate 全目标编译检查、协议和 diff 检查通过。旧回收/进程夹具改用真实 schema 与原工具目录，未放宽生产校验。该轮仍留下普通工具结果和外部回执正文；其后续实现与当前验证边界见开头的 2026-10-10 增量，完整产品切换仍未完成。

- 工作分支：`implementation/native-agent-runtime`
- 首个纵切：新增独立 `varin-runtime` crate，建立持久身份、历史提交及模型执行的可检验路径；不把未接入的库称为产品能力
- 本文件只追踪实际状态和依赖；具体测试结论须来自对应代码与真实执行结果，未运行不记为通过
- 完整默认产品迁移尚未完成；显式原生入口的已验收能力见下文。Pi 与未迁移领域保持原权威，禁止新旧循环同时推进同一 Thread
- 已新增局部实现：Catalog持久身份/历史/Operation/Wait，执行loop与事务桥接，RunSupervisor控制，多家族模型适配、输入队列与边界中断、组合依赖解析与绑定；kernel独立control worker和Host显式client已有真实IPC验证，未替代生产Pi路径
- 独立审阅发现并已修复：续接claim后崩溃丢唤醒、后台handoff仍被终态Run阻止；模型完成与历史/工具调用现由同一事务提交。其余交叉边界继续审阅，最终测试结果以稳定代码重跑为准
- 显式 `live_root` 已接通原生定义、引用和诊断三个语言工具，复用现有 Documents、LanguageViewBinder/LanguageSupervisor 与 Rust 资源授权；同时已接通原生可组合关键词/结构检索，以及显式选择的 published-reader 语义检索和持久 embedding 外发事实。固定/物化依赖闭包、rerank、其余代码智能及完整领域迁移仍未完成。验收与边界见本文件末两节

## 2026-10-09 恢复后的增量

- 历史读取改为固定 head 的引用分页与现有正文分块读取；初始 UI 只载入最近 20 项，按需查看更早历史。已用实际 HTTP/内核验证累计图片历史超过单个 16 MiB IPC 帧仍能完整读取；错误游标、跨线程锚点和切换分支后的迟到响应有独立反例覆盖
- 原生对话分支现在接到 Host/client/UI；分支创建重试在新分支推进后不回退 head，非法工具交换边界拒绝。当前复制对话祖先，不复制活动进程、工作区授权或模型选择
- 显式上下文摘要采用独立持久 Run、固定源祖先和无工具策略；成功发布才切换 checkpoint，追加尾部与原文保留。核心独立验证覆盖正常摘要、失败／取消／工具输出候选与幂等发布；Host/UI 集成验证仍在进行
- 凭据增量接入 configured provider/model headers、仅 header 的连接、环境 key/bearer 和 Vertex 显式 Cloud API key。独立测试使用假凭据；ADC、AWS SigV4 等接线及真实账号验收不包含在本段通过结论中
- 这批工作尚未切换默认聊天、移除 Pi，或完成所有领域能力／平台发布验收。中断前未结束的测试没有计为通过

## 后续已验证增量：来源与认证

- 原生界面可通过现有 Documents/WorkingState 权威准备保存到磁盘的只读快照或可编辑副本；同键并发／重启重试保持同一基线，运行后的省略来源续接在内核受理事务内继承实际环境，不回退文件改动
- 原生 file_list/file_search 复用 compute worker 与读取授权，支持固定修订和物化根；真实内核验证了来源一致性、取消／释放和跨工作区边界。UI/HTTP 已检查旧 Host 迟到准备结果被丢弃
- 原生认证已接入现有 Host 的 Google ADC、AWS SigV4、Anthropic 工作负载身份与订阅 OAuth。独立检查使用官方依赖、假凭据和真实 loopback HTTP，包含签名字节核对、单飞刷新、身份切换、拒绝跨源重定向、工具名往返和签名内容保留；未使用真实账号
- 本阶段完整 varin-runtime 测试通过，类型依赖构建、Host 声明／测试类型及受影响 UI 类型通过。来源 HTTP、compute、UI 和 provider 独立检查有各自记录；不等于各云端真实账号、跨平台代理或正式发行验收
- 仍未自动同步副本回原目录，未完成副本与共享编辑器/Git/overview 绑定、实时记忆流程、默认聊天切换和 Pi 退出

## 实施顺序与出口

| 顺序 | 要完成的工作 | 必须建立的合同和出口 | 当前状态 |
| --- | --- | --- | --- |
| 1 | 原生事实与持久边界 | Thread/branch/Run/ModelStep/Operation/Wait/Delivery 身份；请求幂等；branch CAS；原文/opaque 项；短事务及 outbox；受理与副作用恢复 | 局部通过：真实SQLite两轮模型/工具/最终提交与重开；受理/恢复原语通过。附件保留、跨Run回执隔离与未闭合交换终结限制复验通过，未接生产 |
| 2 | 单一协议与调用分类 | Rust/TS 生成边界类型；持久 command 与内存 query；效果/资源/完成方式合同；错误与游标语义；凭据只存引用 | 局部实现：共享枚举/控制命令生成与显式Host client；全运行协议及UI消费未完成 |
| 3 | 一个完整执行纵切 | 默认 AgentPolicy →冻结 RequestSnapshot→真实协议适配→工具合法配对→历史提交/停止/恢复；模型请求不能成为资源权威 | 局部通过：真实SQLite执行loop、多家族provider协议fixture与本地真实HTTP流/错误/取消；输入队列与序列化窗口中断通过。完整认证迁移、全部provider与产品路径未完成 |
| 4 | 资源执行与 IPC 去公共长等待 | 独立准备/捕获作业；保留文件 CAS/恢复；进程推送流；控制与数据分离；每个取消有实际执行端确认 | 未完成 |
| 5 | 组合计划与既有扩展接线 | 在启用/配置变化时解析依赖与绑定；复用现有 Host/Surface、候选更新；在途绑定保留；观察者不阻塞提交 | 局部通过：原生绑定/pins/撤权、root-reachable依赖解析、候选scope检查及现有调用取消；真实 context/Decision/Observer 与 live-root retrieval 已接线；全域异步owner装配与生产迁移未完成 |
| 6 | 领域与产品消费者迁移 | 完成下表全部能力；UI snapshot/cursor；远端身份一致；用户资产一次性导入；逐域单写者切换 | 未完成 |
| 7 | 完整底层的产品交付与实证 | 两份设计的结构不变量和全部领域路径共同成立；默认完整产品与局部替换均可用；冷/热/并发/更新成本有证据；真实平台/发行验证；由此完成单写者切换并删除 Pi 与重复中转 | 未完成 |

步骤可在互不冲突的模块并行，但所有权切换必须依赖前置合同。先后顺序不缩减最终交付范围，也不要求把每个领域都重写为 Rust。

## 完整设计对照与下一工程纵切

2026-10-10 源码核对：既有对照起点为 `24b920ed`，当前表按正文/回执隔离和一般工具图后的源码及分阶段证据更新。本节同时读取两份设计、runtime/extension 所属文档及实际调用实现；辅助规划模型的冻结构建与独立检查证据单列在下文，局部通过不等于完整设计交付。下文简称「总设」为完整运行时设计，「扩设」为能力组合设计。既有通过记录保留在后文；所有通过结论限于所列实际运行范围。

完成判断看真实调用链和用户路径，不看是否已有同名 trait、DTO 或测试文件。每行给出当前 owner、仍缺的不变量、一个可执行的下一步与应取得的证据；它们不是另设审批、通用防御层或测试元数据平台。

| 设计要求 | 当前实际 owner / 已有实现 | 尚缺的不变量或调用路径 | 下一工程纵切 | 验收证据（未执行不得记为通过） |
| --- | --- | --- | --- | --- |
| 扩设 §4–6、§10：同一能力合同与预绑定调用 | `kernel/crates/varin-runtime/src/composition.rs` 的 `CompositionRegistry`/pins；`composition/resolver.rs` 的根可达依赖图；`packages/extension-host/src/service-registry.ts` 的 provider/drain/候选替换 | `varin.context.fragments@1` 已贯穿真实 Host 安装/作用域选择、broker 声明、Rust resolver/registry、预绑定纯变换与实际模型请求；Host 显式 provider 直查及 service 索引已接通。live-root 检索已通过同一 service routing/CompositionRegistry 选择 keyword-only、keyword+structure 与显式 semantic；更广工具组合仍未完成 | 在已验收的 context、Decision、Observer 和 live-root 检索上继续接其余领域/工具合同；保持内部 Rust 直接调用、仅真实边界编码 | 两个项目选择不同实现；工具/调用方无需修改；加未使用扩展不改变调用扫描范围；普通缺失与选定实现失败分别呈现 |
| 扩设 §5.2–5.4、§9：作用域、共享实例及局部准备 | resolver 已有 `ScopedSelection`/`PreparationKey`/`preparable`，把优先级解析明确交给现有 routing owner；Host supervisor 已有候选及 owner | 公共生命周期长队列已按 owner/依赖拆开，独立准备/释放及共享依赖合并已有后文证据；父子作用域差量、全部能力的共享实例键和局部组合复用仍未完成 | 沿已拆开的 owner/依赖路径接入语言等真实能力；验证共享键、父子作用域差量和局部更新复用，不另外建安装器或配置库 | A 的 activate 或 dispose 未完成，独立 B 仍可启用/停用/调用；同依赖只启动一次；可选缺失不吞掉已选实现的启动失败；冲突选择给出实际来源 |
| 扩设 §6：Provider / Transform / Decision / Observer 四类参与方式 | Rust `ModelProvider`、`ToolExecutor`、`AgentPolicy`、`ProgressSink` 和 Catalog durable events 各自存在；Host SDK 有 services/effect/Surface 贡献 | SDK 已有声明式 `provideContextFragments` 与同合同 inspect，内置默认/可安装项目实例经真实模型请求验收。Decision 与 Observer 已有真实 broker 作者合同、可安装示例及游标消费；跨 branch/Run 的 Observer scope 已按不可变受理 checkpoint 接通；多变换顺序/冲突和更广领域组合仍未完成；非阻塞 progress 不等于第三方执行隔离 | 沿已有 Transform、Decision、Observer 纵切扩展真实领域组合并核对多变换顺序/冲突；复用事实游标与既有 worker，慢计算作为真实 Operation | 慢/同步阻塞观察插件不阻止工具提交与无关 worker；观察者重连按游标恢复；变换不修改原历史；决策只阻塞依赖自己的工作；观察者后续动作有新命令来源 |
| 总设 §11、扩设 §7：完整可替换 AgentPolicy | `execution.rs` 已有合法行动检查、版本化 `PolicyCheckpoint` 和默认循环；`model_session.rs` 默认绑定 `DefaultAgentPolicy` | `PolicyAction` 已支持一般工具图、作用域结果分块及引用证据请求；模型与策略共用单调用执行，ExecuteTools 继续只结算真实模型批次。辅助规划模型保留下述独立证据；一般图的原生恢复与真实 Host 验收边界见本次增量。策略子任务、交付/暂停仍未完成；策略目前按整个 Run 固定 | 以研究/计划执行的一条真实策略路径补行动受理与状态关联，接组合选择；慢规划模型用独立推理工作，不在 `decide()` 内做 I/O；保留核心交换配对 | 替换策略后原文/模型 opaque 仍可读；规划等待期间其他 Run 可执行；重开不会重做已受理行动；不兼容私有状态不伪造迁移；策略卸载不删除已受理子任务 |
| 扩设 §9：热变更、旧调用及持久工作寿命 | Composition handle/lease/pins 区分 retired 与 revoked，按实际实现持有引用；HostServiceRegistry 有 inFlight/drain | `run_tools` 已有 active/candidate、合法请求/图边界激活及原 MCP 世代保留；失败候选不替代活动组合。普通扩展工具/Surface 的完整世代发布、无 UI backend、独占资源交接和全域重启恢复仍未完成 | 让真实工具包的候选选择直接驱动组合发布；旧 ModelStep 保留 schema/实现，后续请求取新绑定；显式禁用沿执行身份取消；Surface 只作为声明的组依赖 | 候选失败保留旧组合；旧参数按旧实现完成；撤权后的新副作用被拒；关窗口不杀后台作业；旧无关实现引用释放；独占能力只暂停自己的新调用 |
| 总设 §7–8：按真实资源的跨 Run 调度和便宜读取 | `ResourceAdmission` 统一冲突前序、完整资源与 local-compute 容量；单调用生命周期用于模型和策略；普通只读结果可不建持久 Operation | 跨 Run 原子资源/FIFO 与 FileSearch 任务族轮转、同源容量预算已有后文综合证据；FileList、复合检索、LSP、provider 配额、维护等分类及 worker 承载尚未全域接齐。文件 CAS 与资源准入分别负责提交和顺序 | 扩展已有家族公平与容量准入到真实分类执行者，核对共享预算与独立等待；新能力由可信资源计划确定 environment/view/目标；短读保留内存身份 | 两个 Run 的冲突写按资源顺序；不同资源继续；大量检索不会饿死另一个任务的交互；取消排队项不取消共享服务；无需给每个内部 helper 建 Operation |
| 总设 §4.1、§9、§23：单一协议、控制/数据分离、事件推进 | `kernel/protocol/schema.json` 生成边界；native control worker、Host native client 独立 credits；guardian 推送/磁盘输出已有局部实证；历史引用分页已有 HTTP 实证 | 不能由某一进程通道推导所有域完成。file_list/file_search 及 compute 背压已使用输出/终态事件而非 10 ms 轮询；大内容模型请求仍全量序列化/读取；同进程资源桥仍需区分 typed 执行与外部 wire 解码 | 沿其他内部等待核查事件通知和共享准备；沿实际大截图/日志/内容路径核查独立数据流；逐域移除重复 JSON 中转而不新增统一 RPC 层 | 计算、输出或大内容拥塞时取消/状态可受理；完整日志可按游标重读；控制成功不冒充执行已停止；空闲内部等待不持续产生 read RPC |
| 总设 §12–13：模型用途、稳定上下文、即时记忆与压缩 | `providers/`、credential broker、Host credential owner；`catalog_context*.rs`/`context_job.rs`；Host `thread-context.ts` | 多家族 fake/loopback 通过不等于真实认证/平台网络完整覆盖。自动容量准备、分段摘要和 ordinary memory 已接原 owner；可替换预算策略、provider 容量错误反馈及全产品记忆流程仍缺。agentPlanning 已有独立 Operation 与局部证据；embedding/rerank/其他 decision/image 仍须按实际用途逐项闭合 | 让内置 ContextCompiler 与可替换上下文策略消费同一来源/记忆 revision；即时写入走现有 memory owner，成功 checkpoint 原子更换稳定系统快照；在实际检索路径绑定非 chat 推理用途 | memory UI/工具交错不丢 revision；压缩候选期间新增尾部保留；失败保留旧 checkpoint；token 预算包含工具/附件/事件；按真实 provider、认证和网络场景分别记录覆盖 |
| 总设 §14–16：源视图、捕获、dispatch、恢复与整合 | Native source launch/selection、Storage 分支/内容/文件事务、Host Documents/WorkingState；native 历史 branch 与文件 journal 恢复已有证据 | 明确 native source 准备不等于主/子任务 dispatch 完成；编辑器草稿、文件副本与 Git/overview 仍需同源关联；报告和代码集成不能混为一物；组合恢复与 Host 启动续接须走完整产品路径 | 以一个有独立源视图的子任务贯穿立即持久回执、批量捕获/共享固定 root、准备取消、执行、报告和条件代码整合；复用底层 writer | 大非 Git 根准备时父任务和控制继续；重开继承真实副本而不重置文件；无改动子任务正常交付；父目录后来修改形成明确冲突；草稿不被聊天分支操作覆盖 |
| 总设 §17、扩设 §5.3：语言/检索及一致环境 | 原生 live_root 语言三工具及可组合关键词/结构/语义检索复用既有 Language、Documents、Structure、semantic owner 与 Rust grant；语义已绑定真实 immutable reader 和持久外发事实 | live_root 检索已进入真实原生历史，语义 revision/chunk hash 分别验证；固定/物化工程依赖闭包、其余 LSP、rerank 和远端映射未完成；语言跨文件 revision 仍仅请求后观察，无版本诊断仍为 pending | 继续建立固定语言/检索依赖闭包与远端一致映射；后续 rerank 沿显式推理用途/持久外发合同接入，保留未知效果和零隐式付费规则 | 语言与检索的独立等待、授权/过期结果、配置/reader切代、撤权、取消和账本恢复证据见后文；固定闭包、远端不串源及大语料成本另证 |
| 总设 §18：问题、计划、Goal、定时与 Bot | `catalog_questions.rs`/`questions.rs` 已出现问题持久路径；Host memory/todo、bots、followups、scheduled-tasks 仍各有领域 owner | 问题记录不代表 Goal/日历发生项全部完成；既有 Host 续接权威还须收敛到统一 Run/Wait；显式 Goal 授权、手动暂停、用量和时区语义不能丢失 | 逐域把领域事件接原生受理和 durable Wait，先完成关闭 UI 后回答/续接与一次日历发生项；计划保留单 revision，Bot 使用相同任务身份而保留独立知识 | 默认答案/到期不是批准；订阅登记窗口不丢唤醒；重启只准入一次 occurrence；分叉不复制自动授权；暂停不被 timer 覆盖；用量不因投影重复累计 |
| 总设 §19、§22：桌面与远端执行资源 | Host `computer`、`packages/computer-driver`、环境服务；既有真实平台能力继续复用 | 尚未贯穿原生 operation/owner/control epoch；断网/Host 重启不证明进程或输入停止；独立桌面与同一物理桌面必须不同调度语义 | 接一个真实桌面作业和一个远端执行环境，固定资源映射与执行端回执；紧急停止直接到执行端，重连查询原 operation，不从聊天状态推导成功 | Catalog 不可写仍能停止输入；释放键和控制分配有证据；接管后旧队列不续发；鼠标移动不擅自接管；远端失联保持未知效果；其他桌面继续 |
| 总设 §20、扩设 §8：MCP、持久脚本、作者合同与发现 | `extension-contract/host/sdk` 已有 Host/Surface、effect、typed workbench API；Pi MCP/codemode 仍为已有入口 | 原生 MCP 直调/发现已复用共享 Host owner 并有局部证据；统一 codemode 路径、MCP Tasks 和完整长输出仍未交付；Agent 自助扩展缺实际合同查询到候选包启用的闭环；不得另养文档目录或绕过现有启用授权 | 接既有 MCP 配置/凭据与能力协商；同 registry 提供精确 schema/依赖/选定实现/准备状态/UI slot 查询；用普通 SDK 构建一个领域工具及卡片，再通过原有候选流程更新 | 禁用工具后脚本不能另路使用；完整 async 单元格可等待并保留嵌套调用身份；无 print 仍有必要提交事实；无 UI 工具照常运行；MCP Tasks 只在协商支持时映射 |
| 总设 §21、§24–25：完整产品与单一事实权威 | `application-client` native API、Host authenticated routes、UI native projection/selector 已构成显式纵切；现有 Web/材料/科研/Bot/工作台服务仍可复用 | 显式原生页面不等于所有产品消费者使用相同 revision/identity；报告、任务卡、编辑器、通知及移动/远端仍须接完整合同；用户资产导入与旧在途任务结算未完成 | 沿上述能力逐域更新真实消费者，最后完成默认入口与单 writer 切换；Pi 资产一次性导入保留原文/未知项/opaque，删除旧循环和重复桥 | 同一工作在各投影视图一致，断连按 snapshot/cursor 恢复；用户手改标题不被迟到作业覆盖；导入能核对原 entry/分支/工具配对；无双写、重复付费请求或副作用重放 |
| 总设 §23、§28、扩设 §10–12：成本及发布实证 | 现有明确 Linux、IPC、分页、provider fixture 证据见后文；打包属各 surface/kernel owner | 无冷/热/并发/更新的代表性成本对比；未证明扩展/作用域增加时热路径与旧世代释放成本；局部 Linux 验证不是 macOS/Windows/全部部署验收 | 针对已接通路径记录实际选择次数、编码/存储/读取工作量和等待来源，比较首轮/复用/并发/更新；在目标发行包验证同后端及资源生命周期 | 未用扩展不增加首轮等待，长工作不保留整棵旧实例树；大历史内存/读取成本可解释；安装/升级/无 UI Host 真实运行；收益实测而非预填倍数/毫秒门槛 |

### 当前优先级

1. **保留已核验策略纵切并继续补行动范围**：安装策略 → 独立规划 Operation → 有界读取图 → 主模型回答已有下述证据；一般工具图本次已接共享执行与持久效果恢复，真实 Host 验收仍受环境阻塞；下一步接策略子任务与交付/暂停，保留取消、凭据隔离和未知效果语义。
2. **扩展已核验的真实源与语言路径**：live_root 三语言工具、可组合关键词/结构检索和显式语义闭环已接通；下一步建立固定/物化的完整依赖闭包、远端一致环境，并按独立推理合同评估 rerank。跨 Run 准入、事件 compute 和 owner 级共享准备继续复用，FileSearch 家族公平已接通，其余分类及全域共享准备仍需补齐。
3. **让策略和上下文真正可替换**：用实际多步工作证明行动合同，补齐默认记忆/压缩/推理用途；不以 trait 存在或默认循环能聊天作为完成证据。
4. **沿同一合同接完领域与产品**：协作/源视图、语言/检索、问题/计划/Goal/定时、MCP/脚本、桌面/远端、科研/Bot/UI 各有真实使用路径。迁移可以并行，不能新增第二套领域状态权威。
5. **以实证收尾完整设计**：局部热更新、独立等待、资源公平、成本复用与平台发行都成立，才完成最终切换及 Pi 清理。Pi 删除不是前四项的替代品。

### 当前领域纵切：live-root 语言与检索已接通，继续补依赖闭包与环境范围

- `SourceMode` 现有 `FixedBranch`、`Materialized`、`LiveRoot`；显式 live_root 不捕获目录，受理、续接和恢复保持同一已验证 host/workspace/root。固定来源仍固定，物化环境仍保留实际副本，不随当前 UI/cwd 改绑。
- live_root 已通过原生注册表执行 `language_definition`、`language_references`、`language_diagnostics`。Rust 拥有工具准入与结果提交，Host 直接使用现有 LanguageViewBinder/LanguageSupervisor 和选定 provider；没有第二个语言进程/config owner、Pi 身份冒充或 decide 内隐藏 I/O。
- 当前 live 路径核对同一 Host 和实际 Documents 环境；同 workspace/provider/view 的准备复用，实际 query 绑定 generation/documentVersion。输入前后 revision 核对，返回目标逐项授权；目标的 observedRevision 不证明语言服务器计算跨文件 range 时使用了该版本。
- fixed_branch/materialized LSP 仍明确不可用：外部/绝对 symlink、tsconfig 等配置与编译器库闭包未固定。仅物化目录或 didOpen 目标文件不能证明全工程固定，cwd 也不是 OS sandbox。草稿、远端同名路径和完整 LSP 功能仍须分别建立合同与证据。
- 同一 live_root 已接入实际检索 PipelinePlan 与显式语义 owner，证据见后文；下一步继续补任务/环境范围的能力组合、固定依赖闭包和恢复。无版本诊断可保留真实非空观测，但仍是 pending，不能称为 current/clean。

## 已核验增量：策略辅助规划模型

- 所选已安装 AgentPolicy 可声明 `agentPlanning` 需求并提交 `request_model_job`。Host 从现有模型槽、连接配置和凭据 owner 准备能力，状态区分未配置、禁用、非法、不可用及可用；无隐式主模型回退，不在 `decide()` 内调用模型。
- 同一真实 Run 内创建独立 `PolicyModelJobV1` Operation，使用 `RequestOrigin::PolicyModelJob`，保留自己的不可变请求、原始输出/opaque、usage 和 dispatch 知识；不是伪造的 ModelStep、摘要 Run 或工具交换。主模型与规划模型分别绑定连接/账号作用域和凭据引用，真实 I/O 由既有 Run worker/模型适配器执行，不占 Catalog/control 锁。
- 图和模型行动共用决策边界与最新行动恢复选择。未派发请求只有在原绑定/快照匹配时才可继续；已有派发意图但缺完成证据时保留 interrupted/indeterminate，不自动重发潜在付费请求或假定零 usage。只在完成项、usage 及终态边界持久化已观察输出，未提交 token 增量可能因崩溃丢失。
- 规划为明确的 tool-free text 能力；若 provider 返回工具调用，原始数据保留但不执行、结果不可用。策略只可分块读取自己 Run/action 的结果，主模型收到带来源标签的不可信模型派生证据，opaque 不伪装成普通文本。
- 可安装 `examples/extensions/planning-policy` 实现上下文读取 → 规划模型 → 严格解析有界读取计划 → 可信只读图 → 主模型证据回答。读取数量、计划字节等是示例的显式配置；此例不代表一般有副作用图、子任务、任意多模型策略或完整 AgentPolicy 已完成。
- 当前 Catalog schema 仍为 3，content format 改为 3，用于带类型来源的请求；旧 content 2 与未知格式在恢复/owner 写入前拒绝并保留资产，不新增转换器或迁移框架。
- 独立反例审阅后在最终冻结构建复验的修复：持久派发后 provider 失败保留 observed usage 并结算 Indeterminate、不重放；终态取消仍保留实际 Prepared dispatch 知识，result/receipt 一致；恢复不覆盖已结算的 Dispatched 本地失败；tool-free adapter 保留带未受理标记的原始越权工具调用，由 Operation owner 判为不可用且不执行。旧二进制曾在真实 Host 路径复现 offending originals 的 items=[]；这条失败复现不计为修复通过。
- 最终 Rust 检查通过：完整 library 79/79、规划模型 13/13；另有既有读取图 16、credential broker 5、model configuration 5、Anthropic subscription 1 项通过。provider library 聚焦 28 项亦通过（属于 library 覆盖，不重复累计），包含辅助请求原始非法工具调用保留和主模型未知 schema 仍拒绝。
- 冻结内核 SHA-256 `4ee07cac8a5fd24a8f7676990f819bad5d61e6fe49074f93f007c51b77b8e68b`：同一二进制的真实 broker/Host/kernel 检查 48/48，通过规划模型 26、既有策略 10、读取图 12。规划 26 项包含 4 项实际打包示例经正常安装/路由的调用：两种真实计划内容分别选择不同文件、非法 JSON 拒绝和路径穿越拒绝。另有 portable credential-owner 23 项通过。读取图一处旧文案前缀断言改为核对当前更明确的来源标签；这属于过时断言修正，不记为产品行为缺陷。
- 协议生成 `--check` 与空白检查通过；Host/UI 类型检查通过，包含全部 26 项规划 fixture 的最终 Host 测试类型复查亦通过（exit 0）。只使用 fake provider/假凭据，不含真实模型质量、账号、收费、性能或跨平台证据。既有超大 MCP 误启动 caveat 保留在后文；不把它计入当前验收，也未补跑超大测试。

## 完整设计结构增量：扩展准备并行

- 公共 ApplicationExtensionRuntime 和 broker supervisor 的长生命周期队列已按 owner/依赖拆开，独立扩展的准备、释放和事件激活可以并行；共享依赖及同 builtin 准备合并
- 选择发布仍保留短的版本核对；独占 provider 使用候选 reservation，失败回滚仅还原所属 owner 的路由。删除数据和同 ID 重装按该 owner 顺序处理
- 独立反例发现并修复：等待 catalog CAS 时 shutdown 后仍发布旧世代；删除数据后的陈旧 reconcile 撤销刚重装的实例
- 9 项独立并发回归、类型检查及局部 lint 通过。完整 extension-host 首轮 60/61，剩余 artifact npm 缓存环境失败在可写缓存下单独重验通过（artifact 15/15）。这不是对组合四类合同、所有热更新/平台路径已经完成的声明

## 能力清单与现有复用入口

### 本轮底层验证与剩余边界

- 跨 Run 的资源准入复用 Catalog 所属协调器，原子申请完整资源集合；冲突请求按队列推进，无关资源可继续。真实多 Engine 反例验证排队取消不派发、独立工作推进、后台 Job 保留占用及重启恢复。发现并修复了同步执行器已死但锁残留、以及执行端已停止却因业务效果未知而保留锁的问题。9 项新增回归、79 项 runtime 单测、8 项 kernel 单测和 26 项文件资源审计通过；Windows/macOS 路径行为未在本 Linux 环境验证。
- 原生 file_list/file_search 已移除 10 ms 轮询，复用 compute 作业的输出/终态通知；生产者背压也改为事件等待。取消注册可移除，完成前先确认 cursor 释放 buffer credit。独立核验包括 1,000 个完成/取消交错、10,000 次正常等待无注册积累、真实超过 1 MiB 结果排空、截断清理及背压中撤权；新构建原生消费者 22/22、资源准入 9/9 和额外撤权反例通过。
- 个性化上下文按已有 catalog 的 revision 刷新，已发模型请求保持原快照，下个请求读取新笔记/配置；固定源 AGENTS 不随工作区漂移。实际 HTTP 验证编辑、删除、重置、摘要冲突和重启重试；重启后对象键顺序改变导致同 revision 哈希不同的问题，已改为规范化键序，未放松 CAS。
- 原生权限走独立 Operation/Wait，实际 HTTP 验证单次许可、拒绝、重复调用、身份/策略漂移、取消和重启。普通用户问题不是权限批准。MCP 共享 Host owner、Pi/原生生产接线、懒发现、冻结 schema、凭据世代与无 UI 释放已通过聚焦核验：真实 MCP 4/4、权限 HTTP 3/3 与 Rust 2/2、凭据刷新/重绑 2/2、控制器/代理/单次项目信任 16/16。超过现有 16 MiB 限制时只结算对应连接/输出失败，不杀共享 kernel，不把未收到的回执说成确定效果；完整长输出保存、MCP Tasks、脚本与多模态映射仍未完成。
- Host 精确世代的预绑定服务句柄及只准备选定 provider 的路径已交付到 `26778086`。独立反例发现并修复了旧 pin 阻塞停用、异步释放期间权限仍可用、强制终止后 reconcile 恢复权限、释放异常遗留 worker 等问题；42 项聚焦测试、类型和空白检查通过。Rust 组合与可替换上下文的生产连接通过 5 项真实原生/broker 测试和 1 项 Rust 绑定测试，包含实际示例安装、项目路由、失败保留旧 checkpoint、旧请求不变及重复读取复用。四类扩展参与合同、策略行动范围及整体成本证据仍未完整实现，不能用这一条纵切代替。

本轮 Host/Pi-host 类型、协议生成一致性与文档链接检查通过。已安装的 SDK 补丁实际参与上述测试；cloud lock 按官方 staging 的 production manifests 核对后完成 frozen install。该轮尚缺生成的 Web CLI/UI 产物，未验完整发行布局；后续 Linux 正式运行包证据见专节，仍不据此声明所有平台通过。

下表的“现有入口”是迁移来源，不表示其中代码都应保留，亦不把既有实现误记为新原生合同已完成。

| 能力 | 当前入口/权威 | 目标交付 | 原生实现状态 |
| --- | --- | --- | --- |
| 会话、分支、运行中输入 | `packages/pi-host/src/session-host.ts`、`packages/runtime-broker` | ConversationStore + RunCoordinator；队列编辑、steering、停止、重连、历史回读 | 局部实现：持久队列、编辑/取消、边界输入/中断/nextRun；显式原生界面、固定 head 分页与对话分支已接入；默认路由迁移与完整恢复未完成 |
| 模型、认证、推理用途 | Pi SDK、Host `connections`/`pi-config`/`small-model` | 各实际配置 transport、OAuth/云身份、模型覆盖、reasoning/opaque、多模态、usage；chat与embedding/rerank等各自合同 | 局部实现：native query/index embedding 复用真实配置/凭据 owner、共享纯transport和持久dispatch/usage事实；rerank及完整认证/模型覆盖未完成 |
| 上下文、记忆checkpoint、压缩 | Pi harness/session history、Host `memory` | 原文保留；来源角色；冻结快照；祖先范围压缩；交付去重；即时记忆写入与稳定system快照 | 原生 checkpoint 与显式摘要 Run 已实现，产品接线验收中；自动预算触发与完整记忆流程未完成 |
| 文件、草稿、恢复 | Rust `storage`；Host `documents`/`recovery`；UI Document Registry | 复用内容对象/条件写入/恢复；明确草稿owner；分支与磁盘效果区分；组合恢复可核对 | 未完成迁移，底层能力已存在 |
| 工作分支、基线与dispatch | Host `harness/thread-services.ts`、`thread-runtime.ts`、`kernel/storage-adapter.ts` | 持久受理立即回执；准备独立作业；批量capture；真实一致性标记；无变更报告与代码集成分开 | 未完成 |
| Shell、PTY、输出、进程树 | Rust `process` guardian；Host `kernel/process-service.ts`/`terminal` | 保留真实进程回执；推送I/O与stdin确认；控制独立；取消观察不同于终止进程 | 未完成迁移，guardian已存在 |
| LSP、结构/关键词/语义检索 | Host `lsp`/`search`/`structure`/`knowledge`；Rust `compute` | 按environment/project/config/view共享服务；来源修订明确；独立准备；不等待无关索引 | 局部实现：live_root 定义/引用/诊断及可组合关键词/结构/显式语义已接原 owner 与原生历史；真实reader切代、撤权和推理账本已验收。fixed/materialized 闭包、其余 LSP、rerank 与远端仍未完成 |
| 任务协作、消息、wait | Host `harness` registry/services | 单一Thread/Run事实；有来源消息；Wait持久化与游标；结果恰当去重；旧世代不污染新执行 | 未完成 |
| 计划、普通记忆、Bot知识 | Host `memory`/`knowledge`；普通Agent notes为Rust typed record | 保留各领域owner、权限和revision；不把所有知识塞入泛化状态库 | 未完成 |
| Goal、自动接续、辅助模型 | Host `bots`/`pi-session-automation`/`run` | 显式Goal授权、暂停/预算/用量；等待不覆盖手动暂停；辅助请求独立身份 | 规划模型独立 Operation 已有局部验收；Goal 和自动接续仍未完成 |
| 问题、follow-up、日历 | Pi extension UI bridge；Host `harness/followups.ts`/`scheduled-tasks` | 问答持久记录；到期非批准；发生项幂等；登记后重查防丢唤醒；时区/遗漏策略 | 未完成 |
| Computer Use、人工接管 | Host `computer`、`packages/computer-driver` | 实际桌面控制epoch；观察/动作/效果分开；紧急停止独立；释放按键与资源有证据 | 未完成；平台既有缺口不因原生化自动消失 |
| MCP、脚本、用户扩展 | Pi MCP/codemode adapters；`extension-contract`/`extension-host`/`extension-sdk` | 原生MCP；单registry；脚本嵌套调用同权限/回执；完整async单元格；不另造插件管理器 | 未完成 |
| 深层策略、发现与工作台 | 既有扩展service registry、Host/Surface和UI shells | CompositionPlan；Provider/Transform/Decision/Observer；AgentPolicy；按需合同查询；无UI后端 | context/Decision/Observer 与只读策略图已有局部验收；辅助规划模型已有局部验收，完整深层组合及工作台未完成 |
| Web/材料/科研/Bot领域工具 | 现有Host领域服务与harness工具 | 通过相同Operations接入；保留材料来源、产物及用户配置行为 | 未完成 |
| Web/Electron/Mobile、远端、发行 | `application-client`/`protocol`、各surface、Host环境服务、kernel packaging | 同一后端生命周期；snapshot/cursor投影；环境绑定/fencing；平台驱动与安装升级实际验证 | 未完成 |
| 用户资产与Pi退出 | Pi JSONL/配置/凭据引用/用户扩展源文件 | 一次性导入保留entry ID、分支、工具配对、压缩、opaque及未知项；原文件保留；切换结算在途工作 | 未开始 |

## 已核验增量：策略主动读取与可恢复结果

- 所选策略现在可在首个 ModelStep 之前提交原生只读依赖图。真实 ToolOrigin 区分模型调用与策略行动，复用可信工具合同、冻结源视图与既有跨 Run 资源准入；不伪造模型请求、工具交换或用户消息。
- 每张图由现有 Catalog 的一个 Run-owned Operation 保存意图和节点回执，策略检查点与图受理原子提交。依赖节点只在前驱成功回执提交后运行；独立节点可并行。恢复保留已完成读取，允许未落回执的纯读按原固定来源重试，不宣称物理读取 exactly-once。
- 策略通过现有 Decision 合同读取自己 Run/action/node 的结果分块，并以拥有的证据引用请求模型。最终 provider 正文带实际来源和不可信外部数据标签，保留 ExternalData 语义；不是把原始结果伪装成模型工具历史。
- 可安装的 evidence-policy v2 先读取固定来源中的小型索引，再根据实际索引内容选择第二个文件，最后引用证据回答。索引的 16 KiB 预算属于该示例的显式配置，不是运行时对所有策略的限制；正文不自动塞入每次 Decision。
- 独立反例审阅促成的修复包括：资源排队后再次核对授权；保留图完成后的新策略检查点；先注册取消接收再读取持久取消；结果保存与回执引用在同一 Catalog 排他区内发布，防止 GC 删除未发布对象；模型请求中可见外部数据来源标签；输入先到而图受理失败时不提前推进私有状态。
- 该已核验读取图阶段的 Catalog/content 格式为 3/2；当前规划模型增量改为 3/3（见前节）。当时删除旧内部表示的自动转换分支，未知或旧格式拒绝并保留已有文件。没有新增迁移框架、第二份图状态库或模型配置权威。
- 最终稳定源码的独立 Rust 检查 107 项通过（78 library、16 graph、9 resource admission、4 context）；真实 broker/Host/内核检查 22 项通过（12 新图、10 既有策略），覆盖安装选择、实际内容决定后续读取、原文/交换保持、作用域伪造、崩溃恢复、取消与新输入受理竞争。最终冻结 debug 内核 buildIdentity 0.9.24，SHA-256 `3716589f55cfb0de488f0cc58d87473a11d67e9319dd5b1675dec28a1fb18c22`；测试前后哈希一致。Host、contract、SDK、示例类型检查及示例构建通过。
- 另有 11 项小型适配器回归通过（MCP 直调/发现 2、permission 3、questions 6），使用输入受理原子性最后修复前的冻结内核 `3bfd171806bf76df88fdc64fdbe1850445e1dea59beb01a71cd25e5ea5e23863`；该最后修复不改这些适配器。一次误启动后中止的未过滤 MCP 整组命令不计入验收：至少一个大载荷用例已启动但停在未批准、未派发阶段，另一旧用例是否执行无法确证；没有据此补记大载荷通过结果。
- 仍有明确边界：当前图只接可信的固定来源只读 Result 能力，MCP 注解不构成只读授权；该阶段未含辅助规划模型，当前实现与验收范围见前节；子任务和有副作用图仍未实现。图结果写入仍占用现有 Catalog 排他区，超大输出的关键区成本未优化。策略帧使用既有编码器预检，但本轮不把超大帧端到端行为计为通过。

## 已核验增量：不可变 Run 作用域与有界签名元数据

- Observer 依据 Run 受理时固定的 context checkpoint 选择 project，包括排队等待的 NextRun；历史无项目 Run 不因以后发布上下文而被重新归属。checkpoint 的 project 元数据随原不可变正文原子发布，只用于查询，不是第二份项目配置权威。
- 同一 Thread 的不同 branch/Run 可以分别选择项目 A、项目 B 或无项目 Observer；订阅、准备与消费独立。内核同时校验读取和 ACK 的精确 project/thread 范围，并保留 source reader 的 throughCursor 上界。
- context domain 格式更新为 2；旧格式明确拒绝并保留已有数据库和内容，不猜测旧 Run 的归属，不添加内部迁移或静默重建。项目身份在受理处拒绝空白及边界 BOM 等非规范拼写，避免 Host 归一化后改变授权范围。
- 独立真实 broker/内核测试 31/31 通过，含历史无项目、两个项目、排队受理、错误 scope/ACK、慢项目独立推进、重开去重、旧资产保留，以及实际 Host 的 BOM/NEL 边界反例。最终测试使用正式 Linux x64 release 内核，buildIdentity 0.9.24，SHA-256 `b5946c5ebe3210af91074382c7f6fa09c31d37d110685269e7c063f65b39b467`；Host 测试类型检查通过。
- Bedrock 私有签名请求仅传 method、endpoint 与由实际请求序列化器计算的 payloadSha256，不再把完整模型正文塞入认证控制帧。Host 使用该散列进行 SigV4 签名并覆盖配置中的同名散列 header；签名元数据入共享写队列前使用同一 framing encoder 预检，失败沿原调用返回并释放等待者。
- 签名独立检查 36 项通过：2 项真实 loopback HTTP 签名字节对照、23 项 Host owner/bridge、4 项 AWS/provider auth、7 项凭据权威检查。均使用假凭据；Unicode、转义正文与独立从实际 HTTP 正文计算的签名一致。超大正文端到端执行未运行，本结论不包含超大认证帧故障时的实际恢复，也不证明真实云账号接入。

## 已核验增量：Linux 正式运行包

- 使用受支持的 Web Host、CLI 和 UI 生产构建，以及正式 optimized release 内核完成真实 cloud runtime staging；冻结安装 665 个生产包，staged lock 与 canonical lock 逐字节一致。没有用 debug 内核替代发行产物。
- 修复 workspace 依赖检查把合法子路径导入误判为未声明包的问题：按包根检查已声明依赖，错误仍报告原完整导入；12 项 layout/helper 检查通过，实际编译 Host 扫描无未声明项。
- 发行内核 manifest smoke 验证无关 cwd、不可变分支、文件应用、搜索、Tree-sitter、shell exit 7、integrity 与错误 manifest 拒绝；复制包中的内置 LSP smoke、CLI help、Pi/扩展解析、PDF.js 和原生 Canvas 检查通过。
- 隔离 HOME/data/agent 的实际 packaged HTTP 启动通过：health 为 ok，apiOnly 为 false，bundled Pi 1.0.4 与 Rust kernel 均 ready，首页和实际 main JS 返回 200，随后正常关闭。默认仍是现有 Pi 产品路径；此证据验证同包中原生内核和完整 UI 可交付，不表示已完成原生默认切换。
- 此处是 Linux x64 源码构建、冻结安装与本地发行布局证据；未构建 Docker 镜像，未发布，也不替代 Windows/macOS 或真实模型账号验收。

## 已核验增量：各一条真实 Decision / Observer 消费路径

这两条受限但实际运行的消费路径已接通，不代表任意工具图、子任务、多模型或完整领域覆盖已经完成。

- **Decision：有界研究/证据收集策略。** 沿现有 Host service 路由选定 `varin.agent.policy@1`，经既有 broker worker 在 `execution.rs::AgentPolicy` 的命名边界计算决定；先按整个 Run 固定策略实例与版本，不声称可热迁移不兼容私有状态。策略只选择继续推理、执行已受理工具交换或结束；原有 `PolicyCheckpoint` / `catalog_recovery.rs` 保持私有状态身份核对，核心 history、provider opaque 项、ModelStep 配对及工具受理仍由现有 owner 控制。跨进程决定调用必须带取消上下文，慢/失联策略只能阻塞本 Run，不能让取消、别的 Run 或 Catalog 事务等待第三方回调。非法决定先按核心规则结算已登记交换；策略不能给自己扩权或重放未知效果。
- **Observer：Run 完成/活动视图扩展。** 复用 `catalog_observe.rs` 的非阻塞通知、`Catalog::events_after` 已提交事实游标及 `Catalog::set_delivery` 的 selected → sent → committed 记录；独立 Host 消费者把所选事实交给 broker，确认精确事实身份后推进交付状态。无需再造事实库或逐 token 持久队列。恢复按 at-least-once 表达，扩展按稳定订阅身份与事实游标去重；后续业务动作必须作为有自身来源、幂等键和授权的新命令受理，不能伪装为原工具成功路径或声称外部效果 exactly-once。观察者慢、崩溃或停用不得延迟生产者提交/工具回执。

独立验收：Decision 10/10 真实 broker/原生测试通过，包括实际 model→tool→model 配对、取消/重开、包内容/配置身份、新旧 generation 与重复启动。Observer 16/16 通过，包括实际投影视图、精确 ACK、重启去重、慢消费者、仅握手重开、scope 查询交错和已处理 throughCursor 上界。共享扩展生命周期 47/47 串行回归通过；并行首轮的旧 1 秒 watchdog 曾因争用超时，单独与串行复跑均通过，未放宽该阈值。

修复包括准备中取消泄漏 pin、旧 Run 拖住新 generation、未合作回调/释放器阻塞停机、初始读取失败后观察不恢复、微任务漏唤醒及跨 project scope 预读。Broker 清理宽限默认 5000 ms、可配置，只在进入释放后计时；强制终止须有实际退出证据，并保留 cleanup_unconfirmed 诊断，不宣称外部效果回滚。

仍有限制：策略先按整个 Run 固定，未实现不兼容私有状态的热迁移；一般工具图和子任务尚未接到策略合同；只读图已有后续验收，辅助规划模型已有本文件单列的局部独立验收。外部副作用执行中崩溃的全部组合与跨平台发行尚未由本轮证明。多项目 Observer 的原临时限制已由前述不可变 Run 作用域增量解除。

## 不可省略的实现决定

这些决定需落实在所属模块的类型、事务或执行协议中，不以额外通用框架代替。

1. **数据资产边界**：新ConversationStore是用户资产，不能沿用可替换kernel internal catalog的重建删除规则。未知格式保留并报错；用户原Pi文件不动
2. **请求/效果边界**：实际发起provider请求、受理tool call、准备副作用、发送效果、结算结果分别记录到足以恢复的边界；网络中断不能从头重放整个Run
3. **分支与配置世代**：branch CAS、冻结provider/schema/config绑定、正常退役与明确撤权分别处理；旧在途工作可按原身份完成，失效执行不能迟到写新Run
4. **事务与内容提交**：对象先持久化再提交引用；关联状态/outbox同事务；数据库锁不包住网络、捕获、用户等待；普通可信读取不写每个阶段
5. **真实资源与授权**：计划完整写集合后准入并再次核对revision；环境read/Shell/LSP一致；配置可见性不是权限；MCP annotations不是授权
6. **输出与停止**：明确日志存储不可写/耗尽时的背压及完整性；不无限缓存或静默丢数据。当前kernel reader取消快路径不得倒退；取消请求不等于已停止
7. **监督与恢复**：窗口关闭与核心退出分开；guardian/远端句柄重接须有真实证据；未知副作用保持indeterminate；紧急输入停止不能依赖Catalog可写
8. **候选组合**：先准备后发布；失败保留旧组合；真正独占资源在静止点交接；不以“热更新”名义启动第二个写入权威

## 验证先从纵切行为取得证据

复用既有行为测试，只为真实新增失败面补充场景；不构建另一套测试元数据平台，不预设毫秒目标、工具次数或无依据硬限制。

首个持久纵切需要证明：

- 同键同输入返回同身份；同键不同输入冲突；重开后仍成立
- branch前置head冲突不覆盖新历史；原文和provider opaque项可往返保存，UI投影不承担原文存储
- 副作用已dispatched但未结算的重开结果保持未知/indeterminate，不自动重发；请求取消不能伪造effect不存在
- 状态与待投递事件一致提交；游标补投不重执行业务；已提交结果未送达可重取
- fake provider可证明请求接线/工具配对，但不证明真实provider完整覆盖、性能或模型质量

接线阶段需要证明：

- 大目录首次捕获、卡住LSP、大输出流同时存在时，受理/普通读取/控制仍独立推进
- 并行工具乱序完成时，UI各自刷新，provider交换合法；用户中断不会执行残缺参数或把旧tool call放进新Run
- 草稿/磁盘/固定分支和跨环境同名路径不混淆；基线来源明确，不将stable capture说成OS原子快照
- 候选扩展失败保留旧组合；旧schema调用可按原绑定收尾；明确禁用立即阻止新的副作用；慢Observer不延迟回执
- Wait登记与事件同时发生、重启、时钟变化、重复回答不会丢唤醒或重复准入
- UI断线不结束后台工作；重连snapshot/cursor一致；Pi历史导入不丢opaque/未知扩展项，不双写或重放外部动作

最终验收还包括设计中的完整provider/API家族、Computer Use真实平台、远端与发行包。静态检查、单crate测试和模拟执行都不能代替这些证据。

## 独立检查与当前缺口

基础提交为 `11ebbe14`，显式模型/资源工具接线提交为 `625f7a7a`；均未切换既有 Pi 产品路由。下面是实际执行证据，不以局部通过替代完整交付。

- 2026-10-09 07:42（Asia/Singapore），`cargo test --manifest-path kernel/Cargo.toml -p varin-runtime` 完整通过：79项unit、5项组合解析、5项凭据broker、5项模型配置，共94项；生成协议`--check`和`git diff --check`通过
- `src/catalog_tests.rs`：受理幂等、branch/epoch、opaque重开、跨Run回执隔离、未闭合交换不能终结；ExternalReceipt早到/晚到、重复/冲突、unknown细化和Wait唤醒均有实际回归
- `src/execution_tests.rs`：真实SQLite两轮模型/工具提交并重开；残缺参数不执行；Catalog锁占用时控制仍可取消；快工具不等独立慢工具；只取消资源队列中的一项不停止整Run；输入到达最终提交/序列化窗口不丢失、不发送旧快照；取消未启动Run释放分支
- Context实际原生loop：摘要以ExternalData进入请求、system/instruction/memory快照冻结、尾部opaque原样；原历史在GC/重开后仍保留。尚不等同完整产品压缩/记忆流程迁移
- Bedrock binary eventstream三项增量：逐字节frame、reasoning签名/工具/尾部usage回放、CRC/截断错误、前置取消，以及真实localhost binary HTTP→adapter通过；当时仅假 Bearer；后续 SigV4 假凭据/真实 loopback 字节验证见前节，仍未验证 AWS 真实账号
- 缓存完成输出恢复：真实SQLite重开后，不重发已完成模型请求；已结算工具不重做，其余调用维持合法配对；已dispatch且缺回执的effect保持待核实。恢复工具批次的Runnable→Executing真实失败已修复并通过；本轮相关源码hash在测试前后相同
- 已通过失败后修复的交错回归：输入head改变拒绝旧输出后，worker退出不再遗留Generating；持久Waiting/恢复Wait、原始拒绝输出及usage仍可查，重开不污染新历史
- `src/providers/tests.rs`：逐字节SSE、opaque与签名保留、矛盾重复项拒绝、截断/乱序；真实loopback TCP/HTTP→适配器、错误headers及headers/body停滞取消通过；共享transport只建一次client/runtime、并发请求/取消/headers隔离通过。Chat工具分片/finish后usage/DONE边界及Azure显式query/version/deployment/credential header与opaque家族fixture通过。Google/Vertex签名和可选工具ID配对、Mistral思考分片/ID碰撞配对、Codex instructions与绑定account/session headers通过；同家族不同connection identity不转发opaque。这不是各云端真实认证或全API家族验证
- `src/content_tests.rs`及Catalog回归：大请求原文/opaque重开、追加历史块复用、各相位不回写整请求、GC保留live对象、缺失/损坏阻止sweep、孤儿staging清理、当时的转换事务中途失败完整回滚、格式 marker 冲突拒绝通过。缺对象时public dispatch先写Dispatched的真实反例已修复并复验；当时另通过格式 v2→v3 升级不嵌套已有 request 引用、多领域 GC 根、拒绝输出及队列编辑/交付 GC 后重开；旧内部格式转换后来已删除，这些历史记录不代表当前支持升级。当前 Catalog/content 为 3/3，旧格式保留并拒绝；不代表模拟真实断电或所有文件系统
- `tests/composition_resolution.rs`：不相关依赖不成屏障，optional不吞实现失败，真实环路/歧义、陈旧准备/作用域变化、集合顺序通过；尚未接上完整生产扩展装配
- context-fragments 独立纵切验收：`packages/web/application-host/lib/kernel/context-composition-review.native.test.ts` 5 项真实 broker/原生模型请求通过；内置默认、项目实例、失败保留 checkpoint、同记忆 revision 更新及无关路由不重复 describe。`kernel/crates/varin-runtime/tests/context_composition_review.rs` 1 项证明连续 5 次复用同 binding ID、替换产生新 ID、旧 pins 在移除后可完成纯变换、data 保留 ExternalData。Host tests TypeScript 0 diagnostics；Decision/Observer 的后续独立证据见上节。
- LaunchSelection在materialization前select持久化，准备途中重开仍可列出并重新绑定（06:18增量2项通过）；同计划绑定幂等，connection/config/schema/source变化拒绝；重开需Host重绑，重绑不允许重发未决ModelStep。当前保存非敏感选择，不保存可复用grant/credential；实际Host恢复编排仍须接线
- `tests/credential_broker.rs`：注入事务store的同reference刷新单飞、不同reference独立、取消等待不丢已轮转token、scope不匹配/持久化失败不给headers；`bind_with_credentials`真实localhost请求不回退环境凭据通过。全部是假凭据；Host既有credential owner接线已有独立TS/真实worker验证，真实OAuth账号仍未验收
- `tests/model_session_configuration.rs`：未知provider不回退、默认不匿名、凭据仅在dispatch解析、不进入request body、无工具绑定不产生工具授权通过
- 真实文件journal恢复（07:32，kernel SHA256 `2b2d66ee293be7aae3918a6818afc419ccd41fbe192a177dd508d4acbcdd4e22`）：SQLite trigger让Storage已落盘后的native工具收据事务失败，随后SIGKILL重开/rebind，读取真实journal补唯一tool result并续接。文件mtime不变、模型write请求不重发；发现并修复Run寿命外部回执误拒、execution recovery Wait名称不一致两项实际缺陷
- 真实Pi worker凭据owner验收（07:09）：生产PiHostClient启动Pi main，创建session、列provider、logout经私有CredentialStoreServer；parent临时owner假凭据删除成功，worker独立agent目录的auth.json不改，公开provider结果不含key；runtime-broker tsc通过。没有真实secret或网络OAuth调用
- 独立TS IPC回归已验证真实kernel原生启动/完成/取消、固定branch文件读取、实际OS子进程与Storage终态；新guardian输出/control分离、磁盘spool、实际终态/取消、两lane credits在进程及IPC独立审阅的冻结构建验收通过；仍不代表完整跨平台发布

近期已由实际失败促成修复的边界还包括：附件静默丢失、续接claim崩溃丢唤醒、扩展cancel发送失败提前drain、早到进程receipt未在handoff应用/未唤醒Wait、丢acceptance后真实完成证据未结算。

仍不能宣称完成：

- 进程层在Linux本次真实OS验收通过；其他目标平台、非合作/异常断电与全部恢复组合仍需各自证据。不能把本次Linux结果推广到Windows/macOS全部行为
- 共享取消桥已统一native token通知，外部wire分lane credits与Host独立窗口对齐；相关进程/IPC并发回归已在冻结构建通过，后续协议变化仍须复验
- RequestSnapshot、history正文/provider originals、model_outputs及队列交付正文已持久化为不可变manifest/chunks，ModelStep相位写入保留短引用；追加历史可复用内容块，读取保留完整原文。当前仍全量序列化/读取请求，未实现完整内存工作集优化；跨 Run 基础原子/FIFO 资源准入已验证，更完整的调度优先级、能力准备和成本证据仍需补齐
- 完整恢复驱动（已完成模型结果/部分工具回执的原生续接已通过，Host完整恢复编排仍未完成）、输入队列的产品接线、自动压缩与完整记忆流程、全部 provider/OAuth 实际部署、MCP Tasks/持久脚本及扩展领域覆盖、其余 LSP/检索与固定依赖闭包/捕获迁移、UI投影、Pi用户资产导入、跨平台发布和最终Pi退出仍须按能力矩阵交付

## 已核验增量：显式 live-root 来源与精确重绑

本纵切新增显式 `live_root`，沿已有 Documents 登记和 Rust file-resource/process owner 访问实际保存文件；
不执行目录捕获，也不改变默认固定快照或既有 Pi 路由。`fixed_branch`、`materialized` 与 `live_root`
分别表达固定读取、独立工作副本和直接修改现场。Run launch 保存真实 host/root 身份，恢复只能重新授权同一来源，
不能把同名目录、当前侧栏选择或物化失败替换成原来源。最初 AGENTS.md 从 Documents 读取并以实际 revision 固定在已有 context checkpoint。

旧实验性原生 launch domain 1 的布尔编码由 domain 2 显式来源模式替代；catalog/content 仍为 3/3。
已有库先以只读 SQLite 检查 domain/表结构及已提交 WAL，再允许可写打开、epoch 变更或恢复。
旧格式、缺失或损坏结构保留原资产并拒绝，不提供静默推断、内部迁移或双读合同。

该 live-source 历史阶段尚未包含原生 LSP；后续三个 live_root 语言工具已按下节接通。它们复用现有
LanguageSupervisor/LanguageViewBinder，且每个返回位置仍经资源授权。外部 symlink、tsconfig 依赖和
编译器库可能来自现场，不能宣称全工程固定；cwd 不是 OS sandbox。

独立验收：Rust 91 项通过（79 个既有 unit、10 个新增来源/格式检查、2 个来源继承检查）；
Host 21 项在同一修正后的真实内核构建通过（10 个新增 live-source、6 个固定来源/继承/context、5 个 process/CAS）；
UI 16 项通过。内核二进制 SHA-256 为 `ef9c0c1d75d465ddd9d9f012a07c12f763f1b5cdcee4951d293654f1b7bb56b6`。
生产 Host、UI 与最终 Host tests 类型检查、共享协议/client 构建、协议生成一致性及 diff 空白检查通过。
模型侧使用本地 fixture；没有真实付费模型调用。本轮运行证据为 Linux，不代表完整跨平台或原生默认路由验收。
来源身份固定 Host 登记的规范路径与 Rust root ID，不固定目录 inode 或承诺整个工程的原子快照；
当前公共来源准备/提交接口没有通用的受理前 AbortSignal 保证，取消验证针对实际 Run 准备链。

本轮真实反例促成的修复包括：缺少 runs 外键的同列 launch 表曾被接受；旧 domain 拒绝过程中可写 SQLite
连接关闭会 checkpoint 已提交 WAL，现改为真正只读预检，保持数据库/WAL 资产；持久 `live_root` 缺字段曾隐式成为 null，
现与协议一致要求显式 null/描述符；即使提供有效 rootId，Rust 也拒绝以 `fixed_branch` 启动进程；
live read 曾误标 materialized，现 read/list/search 统一从已验证绑定输出真实 mode/rootId/liveRoot。
读取不同文件状态、实时文件变化、冻结 AGENTS revision、后续 Run、重启/排队重绑、伪造来源拒绝与准备取消后的 grant 撤销均有本轮独立行为证据。


## 已核验增量：live-root 原生语言工具

`language_definition`、`language_references`、`language_diagnostics` 已进入原生工具选择、
执行及历史提交路径，并由现有 source entry 选入 live_root。工具参数使用相对资源路径、零基 UTF-16 位置。
Rust 通过私有 epoch/查询身份桥接调用既有 Host 语言 owner；Documents 负责文本与编码，LanguageViewBinder
绑定实际 revision，LanguageSupervisor 继续拥有选定 provider、共享准备、会话世代和 Rust 管理的进程。
没有新语言配置库、第二个语言进程管理者、伪造 ModelStep 或在策略 decide 内执行扩展 I/O。

语言准备与请求不占 Catalog/control 长锁或文件租约；取消针对一个等待者，共享准备仍由原 supervisor 按引用处理。
输入在请求后再次核对，返回资源由同一 Run grant 逐项准入并观察实际字节、校验 UTF-16 范围。
越权/unmappable、不可读和范围过期有不同遗漏计数；所有项目被遗漏不冒充正常零结果。
跨文件 `observedRevision` 是请求后读取所得，`rangeRevision: null` 明确没有证明服务器使用的目标版本；
查询自己的 range 只有在绑定及后验 revision 一致时才带该 revision。来源明确报告依赖仍为 live。

诊断保留 pending、stale、unsupported、unavailable 和已验证结果的区别。当前 bundled TypeScript server
没有 pull 能力且发布不带文档版本；同一 LanguageSessionRecord 保留其真实非空错误观测，结果为 pending +
`diagnosticVerification: unversioned`，仍经 Rust 授权和范围检查，`rangeRevision` 始终为 null。
空无版本观测不等于 clean，有遗漏也不把 pending 提升为已验证 partial。原 Pi/editor 的返回形状保持不变。

私有 Host 语言回复先做序列化/既有 framing 预算预检，过大或不可序列化时返回有限 unavailable 回执；
Rust 对超过实际帧预算的 transient progress 不入共享 writer，durable 工具原文继续通过既有分块历史读取。
本轮没有实现语言结果分块，也没有执行超大端到端或共享 writer kill 实验。

最终内核 SHA-256 为 `4432bb14292e36e0fb2ae093e6d66567ba41ed2a6da7e90d49e7177ae180f2a9`，
以正式 build identity `0.9.24` 构建。先前遗漏构建身份的二进制被握手拒绝，未进入产品行为验收；
最终计数均使用修正后的冻结构建，不把该环境阻断记为产品行为失败。

最终独立验收按 suite 分别记录，不是全仓或全部设计通过：

- Rust rendezvous/framing 5 项：epoch、独立取消、迟到回复、关闭及小型真实字节预算边界。
- 同一最终内核上的 native 假 owner 20 项、source entry 1 项、真实 bundled TypeScript 三工具闭环 1 项；
  后者验证真实跨文件定义/引用及 pending 的真实 TS 错误观测，没有补造诊断版本。
- portable owner 12 项、private bridge 3 项、既有 Pi navigation 15 项、diagnostics adapter 4 项。
- UI 18 项；完整 Host tests/UI 类型检查、生产 Host 声明与 application-client 构建、协议生成检查和 diff 检查通过。

最终检查修复或澄清了缺失/伪造 source provenance、非 ready 内容旁路、omissions 额外字段、非法 providerId 类型、
丢失 result/非法 URI/逆向范围冒充零结果、输入变化和 symlink 目标处置。已授权 symlink 叶子按现有文件 owner
保留为 Symlink 且不跟随，因此为 unavailable；父路径越界和未授权目标属于 outOfScope。
既有诊断 fixture 的延迟 watcher 失效竞态先在原基线复现，再按真实失效/重新绑定语义修正验证，没有削弱 ready 断言。

该增量限于 live_root 三工具，不证明 fixed_branch/materialized 的 imports、配置、链接和编译器库闭包；
不完成其他 LSP、结构/语义检索、远端、任务族公平、完整恢复、领域迁移、代表性成本或跨平台发布。
两份完整设计的其余矩阵仍适用，默认运行时与 Pi 退出状态未变。本轮模型侧只有本地 fixture，没有真实付费模型调用。

## 已验收增量：live-root 可组合代码检索

`code_retrieval` 接入真实原生工具/历史路径，复用 Explore 算法、Documents、既有 Structure 和 Rust compute。
私有查询显式携带原生 Run/Thread/来源及真实 grant，不伪造 Pi session/worker。关键词 compute 使用 Run scope；
候选路径在 Documents 读取及可选模型选材之前经同一 grant 的 `file.read.check`，返回后 Rust 再逐项验证来源、
真实 revision 和行范围并从已核对字节重建正文。固定/物化来源明确拒绝，不暗用 live 索引。

查询捕获不可变 `PipelinePlan` 和选定 stage 方法句柄；配置候选准备成功后才发布，新查询可使用新世代，旧查询仍按
原绑定完成。共享语法准备继续归原 owner，取消单个等待者不关闭公共准备。冷缺、不支持、部分覆盖、失效和失败
分别保留；结构大单元使用原 slicer 保留范围的连续片段，不补回省略区再截掉命中。

生产通过既有扩展 service routing 选择 `varin.retrieval.plan@1`，内置 keyword+structure 与 keyword-only
两个惰性声明均可在既有服务配置中选取。查询使用真实 native Thread、Run受理checkpoint项目及已授权canonical目录，
不读取后来侧栏选择；结果记录选定provider/artifact/configuration及路由revision，正常退休和明确撤权分开处理。
该冻结版本的生产内置 semantic/model 明确 disabled。后续语义增量见下节。可组合 seam 支持显式既有语义 handle 与仅针对已授权
片段的模型选材；语义块 SHA-256 与文件 Documents revision 分别验证。尚未接生产语义/模型设置、扩展 worker 的
完整恢复、固定依赖闭包、远端或最终产品默认路由。没有运行真实付费模型。本增量不等同两份完整设计交付。

本轮并发真实反例还暴露原有全局history ID缺陷：不同Run的provider都返回 `item-1` 时，第二个Run曾因
`history.id`唯一约束进入execution-recovery等待，不能误报为检索阶段锁竞争。修复将内部history身份按
真实request/ModelStep与provider item ID确定性分域，原provider ID/opaque/model_outputs原样保留；精确重复
ModelFinished为只读幂等，差异回执冲突。恢复统一读取冻结leaf后精确连续的真实已提交模型行，核对归属/内容/
原文/工具序列后使用实际row ID，不按新公式猜历史head，不重写既有资产或增加格式迁移。独立同ID并发、
后续step、旧已提交ID及恢复继续追加反例均在修复后重新验收；初轮失败不算通过。

最终内核以正式 build identity `0.9.24` 构建，SHA-256 为
`d04874a6c88c42c32704db2afc3c92609554bf9a16a47a74e661fc1d08b4c630`。独立验证按范围分别记录：

- 同一最终内核上的新增 native authority / pipeline / composition 三套共 21 项通过，覆盖真实关键词→结构→
  原生历史→read、逐项权限/撤权、陈旧命中、冷缺阶段、共享准备取消、慢查询并行及实际扩展候选发布/失败保留。
- 既有 native 消费者共 7 项通过：live-source/read-edit 与 language 并行 2 项、HTTP context/
  initial-context 冻结及 reopen/retry/fork 3 项、durable assistant history 1 项、12 回合 pinned-history 分页 1 项。
- portable pipeline 3 项、实际 UI selector 加 Host 路由 2 项通过。
- Rust catalog 31 项（包含独立身份/旧行恢复/错误归属 4 项）、execution 12 项通过；
  此前 v2 的未再修改 content 7 项已通过，不把这些重复算作新增测试。
- protocol/client、扩展 contract/SDK/builtins 和 Host 生产类型构建、完整 Host tests/UI 类型检查、
  协议生成检查、相关 lint、文档和 diff 检查通过。

实际扩展候选 fixture 曾等待候选切换完成却仍持有待退休旧 pin，形成测试自身等待；修正为既有发布/退休
合同的顺序：先观察新代发布、验证旧 pin 可续用，再释放旧 pin 并等待退休。没有延长 timeout 或修改产品以绕过该验证。
以上不是全仓、完整恢复矩阵、真实付费模型或跨平台发布验收。


## 当前增量：真实 published reader 与原生语义推理

本节记录在前一检索增量之后的实现及下列冻结源码/二进制的独立验收；这一受限增量不等于两份完整设计交付。默认仍为 keyword+structure；新增显式 keyword+structure+semantic 声明，首轮限
live_root、明确登记索引目录、已配置远端 embedding 与 source ranking。模型 rerank、固定/物化来源、远端
环境、真实认证/收费、语料检索质量及跨平台性能不在本轮已证范围。

### 单一 owner 与冻结身份

- 原 `workspace-runtime` / `runtime` / semantic storage process 继续唯一维护源索引。没有第二个扫描器、
  配置库、模型下载器或用原生 Thread 冒充 Pi session；native 路径直接使用原 Host 配置/凭据 owner。
- 现有 Trivium mutable `g1` 不是 snapshot。原 storage owner 在既有 quiet/busy/完成 checkpoint 边界用
  `publishGenerationManifest` 形成完整文件集，真复制后以 `immutable` 打开，再发布 reader 指针。
  `.pld.N` 等动态成员来自 native manifest；不 hardlink、不逐 query 全库复制，也不逐 document 强制全库快照。
  publication ID、store epoch、recipe/space、冻结 coverage 与 Documents revision/chunk hash 分开保存。
- 查询只 retain 已经准备好的 published reader；冷查询不打开 writer、不等待全库 scan、不用付费 readiness probe。
  未知维度由明确登记的背景构建首个真实文档 chunk 学得，向量缓存供随后正式 publication 复用。
- 正常新 backend/publication 不改变旧请求的固定绑定；明确禁用、账户/凭据作用域变化、目录移除、grant撤销、
  store/Host epoch变化阻止后续外发和交付。每条命中再经原 Run grant、Documents revision、行范围和chunk hash校验。
  reader release、maintenance 和 shutdown 由原owner收尾，未关闭成功的存储句柄不被当成已清理。

### 付费外发事实与恢复

普通 RetrievalQuery 仍是 read-only Result，不为廉价 keyword 查询创建持久 Operation；之前不能据此声称
所有检索均已有 Rust Operation。选择 semantic 后，实际 embedding 外发先经原 semantic process 的专用
执行事实账本，位于原 Varin dataDir 的 `knowledge/<host>/semantic-inference/ledger.tdb`，独立于可清理的
derived vector cache。该账本仅拥有这类实际外发/回执，不重复写 Run/ModelStep 状态，也不伪造 ModelStep。

Native 来源带真实已提交 model request+tool call，或 policy action+node+tool call。幂等键使用此持久来源
与固定推理 stage；临时 bridge/batch UUID、input hash、模型或 credential epoch 不能更换该键。input和binding
作为不可变 intent 核对，差异明确拒绝。Index-build 使用原 workspace/recipe/vector-binding/输入内容身份，
未决输入的重分批/换顺序也不得重派；确实不同的源码输入或模型世代另有事实，旧 unknown 不消失。

full-sync admission 必须在外发之前得到持久确认；没有 ledger 或确认失败时不发送。已派发但没有可观察
回执保持 indeterminate，attempt 是否确知另存，不把未知 usage 写成零。完整结果先持久结算再交付，重开后
按同一 intent 与当前授权复用；不同 credential scope 的同一完成请求保守拒绝。Warm vector cache 也先核对
账本 intent/unknown，缓存响应按真实零外发结算。原 owner 提供按 Run/scope/state 的只读事实查询，不自动
清除 unknown，不因索引目录清理抹掉可能收费的事实。只对index-build且原transport链已最终结束、
持久receipt证明not-started/attemptsKnown=true/attempts=0的请求，允许同intent重新受理；原零派发事实归档，
新token与admission lineage在同一个full-sync事务发布。单纯尚未更新计数、仍在beforeDispatch等待、
任何unknown/started或原生取消调用都不满足条件。此合同不声称 exactly-once HTTP。

取消及时停止等待者，不无限等待不响应 signal 的 Host callback。它不声称远端已停止；真实 transport 的
晚到回执可以结算原账本成本，但不能恢复取消结果交付。正常原生历史保存可获得的 plan/reader/推理回执，
取消历史可能先返回而没有晚到回执，持久账本仍保留该原 invocation 的独立执行事实。

### 旧入口与验证边界

OpenAI-compatible embedding 纯 transport 移到中立 Node-only 模块，Pi adapter 与 native owner 共用。
新 native query 和背景源索引不调用 Pi worker；旧 Pi semanticRecall / knowledge-vector 仍沿其真实 broker
身份和结算边界，复用同一源索引及共享 transport。它们尚未迁移到原生 invocation，不能假造身份来抹掉这一
边界，也不会与 native owner 同时推进同一个 query。Rerank/decision 等旧能力保持原入口。

实施作者只做构建、类型、格式和静态核对；独立 reviewer 使用真实 storage/IPC、Documents/Structure、
Host credential/settings、Composition 与原生历史，唯一模拟外部对象为本机 deterministic HTTP provider。
最终 Linux x64 内核以正式 build identity `0.9.24` 构建，SHA-256 为
`ada4437138ca313dd928208b9a7c7fd21ca65c21a77656fd59095e8a11bd7ce6`。2026-10-09 独立验收结果：

- 同一最终 v3 内核：新增 native semantic 13/13、既有 retrieval 21/21、legacy 消费者 31/31，
  六文件共 65/65 通过。覆盖真实配置/凭据 owner、实际 Composition 选择、索引 query 到原生历史、
  冷查询零外发、A 查询保留旧 reader 而 B 发布、失败配置候选、禁用/目录移除/账户变化/Run 撤权、
  revision/chunk hash 分别核对、取消及真实 reader/backend/transport 引用归零。
- 最终 portable 五文件 35/35 通过：published reader 8、持久 ledger 9、既有 store 10、
  workspace inference 3、embed scheduler 5 项。
  ledger 反例包括稳定 invocation 的 intent 冲突、unknown 阻止重派、完成复用保留原回执、
  index 输入重分批 fence、独立子进程未 close 的 WAL 重开，以及 beforeDispatch 尚未最终结束时
  拒绝恢复、真正零外发最终结算后并发恢复只发送一次并保留旧 lineage。
- 一个真实并发容量为 1 的测试单独证明：embedding HTTP 阻塞时原生 file read、状态及取消仍可完成。
  A/B 切代 fixture 使用原有 scheduler 的显式 concurrency=3，证明已受理旧 lease 与新 publication
  可并存。初版 fixture 用默认单槽却阻塞 A 再等待 B，两个测试曾失败；修正测试容量后重跑并在最终
  v3 全套通过。未修改生产默认容量，初轮失败没有记作通过。
- 另以纯 Node 导入实际 compiled package exports，验证中立 transport 与旧 Pi adapter 为同一实现，
  并经真实 `BackgroundInferenceRuntime.embed` 调用本机 HTTP provider 通过；未使用 TS/source alias 掩盖包布局。
- 正式构建、Host 生产及测试类型检查、协议生成、文档检查（185 文件、1556 链接、0 错误）和 diff
  检查通过。targeted lint 命令返回非零：唯一诊断为 `index.ts` 既有
  `refreshThreadPersonalization` 的 `prefer-const`，已在 HEAD 核实；其余所查变更文件没有诊断，
  不将此次 lint 写为全部通过。最终验收前后 48 项冻结生产/文档 SHA 全部一致；随后仅补本文验收记录。

这些结果不包含全仓测试、全部恢复矩阵、真实付费供应商、跨平台构建或大语料性能/质量验收。
原 Pi broker 入口的完整持久结算迁移、模型 rerank、固定/远端来源及完整两份设计的其他里程碑仍另行推进。

## 2026-10-09 普通 notes 原生闭环（独立 B 线首出口）

实现沿既有 `agent.personalization` typed record 唯一 writer。`memory` 的 read/search
保持只读；save/delete 在执行前持久化真实 Run/request/call 对应的 intent，以相同 origin 查询原
`storage.record.put` 的原子 receipt。丢回执的核对不会再次修改 notes，UI 与工具写入共用 CAS。
已有合法 `memories/prompts/nextId` 文档继续读取；新增可省略的 latest-revision/last-mutation 元数据，
不迁移、不重置。历史 receipt 复用原 operation 事实，不在每次文档中复制 receipt 列表。

可信受理 scope 显式包含 mode/threadRole/projectId，sessionId 必须为本 Thread。通用 preparer
不默认为 main，主入口薄适配显式受理 main。Bot 普通 notes 隔离；child 初始上下文使用自己的 scope
与固定来源，工具能力由显式 profile 单独授权。实际 Host UI resolver 查持久 Thread/checkpoint，
错误不回退为 Pi main；原生会话入口复用既有 notes 编辑器、CRUD 和 stale revision 提示。

普通 note 编辑不改变系统 memory snapshot。独立 `ContextPreparation` 在普通模型和 policy model job
冻结新请求前同步同源 facts；已冻结/派发请求不重编。每个 RequestSnapshot 保存完整尾部正文和稳定
fact identity，selected/sent/committed 分开记录，跨请求保留到成功压缩覆盖。工具 JSON 仅在匹配
真实 native-memory Operation、origin、调用和原 receipt 时去重，不信任外部同名 JSON。

显式压缩成功才原子发布 summary、memory snapshot 与 effective system；新 note/原会话尾部保留，
失败、取消、profile CAS 或分支变化保留旧资产。删除最后一条 note 可清空对应新 snapshot。
Context domain 3 在可写 SQLite/WAL/epoch 前只读预检；旧、缺失、畸形内部格式不静默重建。

独立审查先后发现并修复了三个真实边界缺陷：`operation.get` 将真正不存在的 operation 与无归属实体
混为授权错误、阻断首次写入；context 预检误接受部分 UNIQUE 索引；ContextPreparation 的取消错误
裸传播导致 Run 进入 waiting。现在 missing 可读 null，foreign/orphan 拒绝，授权与读取在唯一 Storage
worker 同步完成；本域 TEXT PK/UNIQUE 核非 partial、准确 key、BINARY/ASC 与 FK 动作，坏资产只读拒绝。
ASC 是格式合同，不表示 DESC 削弱 uniqueness。取消走正常 Cancelled 结算；其他准备失败同事务写
Failed 与安全的 `context.preparation_failed` 原因，原始 Host 错误不进入公开事件，未受理的新模型
请求/ModelJob 不被伪造成已执行。晚回执再核 token/Run/epoch，不能恢复 Run 或替换 checkpoint。

2026-10-09 最终 v3 独立 Linux x64 验收使用 debug profile、正式 build identity `0.9.24`，内核 SHA-256：
`0ecabc887c4674b0317feabf6f675c4b1f4d2295d62778534417a603cddc5ddb`。

- 原生七文件 **92/92**：memory delivery 16、owner/schema 7、planning 31、retrieval 5、observers 31、
  initial-context 1、live-personalization 1。使用真实 Kernel IPC、Catalog、Host owner、HTTP 路由和模型请求；
  仅外部模型为 loopback deterministic provider。原始回执丢失后重开不重写、精确 CAS、工具读写 effect、
  compaction/profile/尾部竞态、Bot 与可信 child scope、fork/GC/原请求保全、三阶段 delivery 均覆盖。
- Host context callback 人为挂起未释放期间，status 与取消到 Cancelled 的实测样本为 **5.32 ms**，
  严格断言小于 1000 ms，零模型派发；晚回执不复活，新 Run 可继续。普通/planning 的 reject/throw
  四项证明安全失败原因与 Failed 在关闭重开后仍存在，checkpoint 不变且未伪造模型 operation。
- 本域 partial UNIQUE、复合 NOCASE、DESC 和 PK NOCASE 四类不兼容 schema 在任何 epoch 推进前拒绝；
  DB bytes、epoch 与原 history 保持，合法新库正常重开。storage missing/foreign/orphan 与并发同 ID
  所有权反例均通过。
- Rust **19/19**：memory delivery 3、context job 4、execution 12。UI **5/5**：复用真实 notes 编辑器与
  routes、可信 project/currentThread、stale draft CAS、删除、切身份清 draft、Bot 隐藏。
- 生产/测试/UI TypeScript、协议生成检查、生产 Host bundle、依赖隔离与文档检查通过。
  变更生产文件全量 targeted lint 仍有唯一原 HEAD 的 `refreshThreadPersonalization` prefer-const；
  本次新增诊断已修，不写为全 lint 通过。新增/相关无旧诊断的测试文件 lint 通过；
  observer 测试原有 6 条 no-explicit-any、planning 原有 1 条 prefer-const 单独保留，
  最终静态组合命令因这些既有 lint 返回非零，不能写成整个组合命令通过。

v3 build、native 和 Rust 验收绑定同一完整源码 manifest
`b216a594197d0cc8067418b1337f2814e6cc852268ae124683d920b4e11a2176`；最后仅补本文验收记录。
构建及运行命令、source 前后身份、独立 binary 和生成目录 hash 由本批 evidence receipts 保存。
初轮失败未记作通过：除上述生产缺陷外，review fixture 的不合法 recordType、read-graph node/call ID
不一致、将内部 context job 走普通 Run HTTP 入口、手造无效 basis、旧 1 秒 polling 均已独立纠正；
原行为断言保留，polling 改读真实 durable events，未扩大原用例 deadline。

本节不包括全仓测试、完整 MCP 套件、极端并发或性能基准、真实付费供应商和跨平台发布。
自动 budget 压缩、完整 context 设计、全部恢复矩阵、A/B 最终综合验收和 Pi 退出仍另行交付。
## 2026-10-09 并行增量：固定来源只读子任务（分支范围验证，待全局集成）

A worktree 新增原生 `dispatch`、状态与 durable Wait/报告路径，沿已有 Catalog、RunSupervisor、
WorkingState pin/branch 与 source launch 接线，不调用 Pi ThreadRegistry。受理固定真实父 Run/origin、
项目快照、显式 parent model/read_only profile；异步准备调用同一 context owner，子 Thread 不继承父
session notes。只读子任务的正常文本报告与 `no_changes` 代码结果分别保留。取消观察、取消子任务、
父 Run 结束和停止整任务使用各自边界。源授权 pin→Catalog 受理窗口保留原 Operation 归属及恢复清理事实。

本轮报告只持久引用原 child history；状态/list 不复制正文。`child_report` 与认证 HTTP
读取采用 UTF-8 字节页、显式 next_offset 与 64 KiB 输出上限；Wait 含有界的最新文本预览，明确
标记 other-agent data、可能不完整及续读方法。UI 按需替换页，不自动聚合无限正文。

独立 reviewer 在 v3 验证真实 Host/Rust/loopback 20 项和 Catalog 11 项全部通过；真实
Storage pin 返回与 Catalog 受理之间的两个精确撤权边界、P0 受影响既有消费者 62 项在 v2 通过。
v3 相对 v2 的唯一业务源码改动是 collaboration schema 只读预检，未重写工具/受理/Wait 接线。
覆盖固定来源与工具子集、独立 session/project、父终态与 child 寿命分离、迟到准备取消与 pin 清理、
来源信任撤销、模型请求已发后的 crash 不重派、报告丢通知重开、先报告后 Wait、取消观察再 Wait、
fork 前后可见报告去重、100 KB Unicode 报告续页及越权拒绝。缺 unique/FK 或旧报告格式的 Catalog
只读拒绝，测试核对原数据库 bytes 未变。补充反例曾揭示 v2 接受 partial UNIQUE、NOCASE
child/PK 索引及 cascade FK；v3 核对完整非 partial 的精确 BINARY key、PK origin、FK actions/match，
四个真实重开反例全部重验通过。精确 pin→Catalog 窗口用真实 Storage/wrapper 受控断点，
不是在该窗口实际杀进程；对应 orphan 恢复/补偿另有低层与 Host 反例，不扩大这条证据的含义。

作者完成 0.9.24 Cargo check/build、协议生成一致性、protocol/client 构建、Host 生产类型与本树
bundle、UI 类型检查。专属 v3 二进制 SHA256 为
`680ec58a4b731adb5d4ec52cae229622016c41c701885409a996c00b0dfab169`，构建生产输入前后稳定；
分支独立审查汇总保留源码/测试 manifest、命令及失败修订证据。Host 生产/UI 最终类型与新增
20 项的测试类型检查通过；新测试两处可选 API 非空断言修订后，16 项及测试类型重新验证通过。
新增 TS 测试 targeted ESLint 零诊断；Rust 测试有一个 unused import warning 按冻结裁定保留，
不宣称全仓 lint 清零。首轮窄路径源 grant 越权受理反例
曾失败，补 whole-root/read capability 校验后在 v2 重验通过；初版重开 fixture 用正常 close 导致
真实取消，改为该 fixture 独占进程 crash 后验证，未把初轮失败计入通过。

本轮未运行全仓测试、完整恢复矩阵、完整 native MCP authority review、视觉 UI 验收、跨平台构建、
超大帧/共享 writer kill 或付费模型。代码仍待根与独立 memory/context 线集成，子 profile 本轮精确
file-only；集成时仅接共同 context 边界同步，不隐式添加 memory/MCP/dispatch 能力。首轮不包括
递归/任意兄弟协作、写入/代码合并、live 首次隔离捕获、远端环境或完整协作域交付。

## 2026-10-09 固定来源协作与 memory/context 综合验收

本次将上述两个独立增量合并验证；不是仅复用分支各自的通过结果。保留 context v3 与
collaboration v1 两域只读预检、真实 memory owner、精确来源继承与 file-only child 边界。
无来源 Run 的 builtin 精确为 ask_user、child_status、wait_child、child_report、memory，
不含 dispatch、来源工具或 MCP。child 仍经过 context 同步，但不获得 memory mutation 能力。

- 综合真实 Host/Kernel/loopback Responses 与 Anthropic 共 **33/33**：冻结请求字节不被
  新 notes/child report 改写；后续显式 Wait 交付保留实际 sender/owner 与非 system 身份；
  伪造授权不能扩张工具。丢失 memory owner 回复后重开通过原收据协调，不重写 notes，
  不重放父模型请求，独立受理 child 正常恢复。阻塞 child context 时父读与取消仍可完成。
- context/collaboration 九个跨域不兼容格式反例在修改 DB bytes、epoch、history 前拒绝。
  当前 child report 交付需要显式 wait_child，不声称通用自动消息注入已实现。
- 直接消费者 **89 个不同用例**由保留的 **82+7 两批**建立通过证据；涵盖实际 TypeScript LSP、
  retrieval、semantic generation/ledger、来源与 history、memory owner/delivery。
  早先 retrieval disable 曾在原十秒轮询内未完成；不改其超时与行为断言，单例及整文件重跑通过。
  首次超时原因未确认，不据此声称没有性能回退。
- Rust **32/32**：child 11、memory delivery 3、context jobs 4、execution 12、真实
  Storage→Catalog 来源受理边界 2。UI memory 行为 **5/5**。这些为综合源码上的实际执行。
- Host tests/UI 类型、四个改动 TS 测试 targeted lint、diff/schema 检查通过。生产 Host bundle
  串行构建及编译产物 ESM import smoke 通过；后者不是完整打包服务启动验收。
  Rust 的 10 条 warning 与该综合 binary 构建已有诊断逐项相同，不称零 warning 或全仓 lint 通过。

综合 debug binary 使用正式 identity `0.9.24`，SHA256：
`a2cb0a239def0a3724bacfa037cc7c96fa4188fd3482544ca5985dac7d78ac60`。
最终测试源码摘要 `3565f62d748e74222141439e9f76b0464e1285e51a6d1be007e48755860dbab0`；
与实际 binary 构建输入逐文件比较，仅三个测试文件不同，生产实现与协议输入无变化。
最终收据确认源码、专属 binary、14 个实际依赖产物目录前后稳定；验收后只追加本节文档。
早期测试设置错误、setup 轮询超时与并行编译退出 137 均保留，未算成通过；重型编译改为串行。

本节仍不覆盖全仓/完整 MCP 套件、跨平台、付费供应商、极端负载、完整恢复矩阵或全部设计完成。
家族公平调度位于后续独立增量，不包含在本次综合交付中。

## 2026-10-09 家族公平准入首切与综合取消修复

原生已绑定 FileSearch 采用可信 Catalog 父子谱系推导的 task family，与原有资源冲突计划一起
原子取得 local-compute 容量。排队时不占文件资源，冲突 FIFO 保留，可运行家族轮转；默认预算
与实际 foreground compute workers 使用同一进程启动配置。plain read/control/memory 不消耗
该容量。精确 admission inspect 从真实 Run generation、ModelStep/tool 或 policy action/node
反查，区分 queued/active/settled/not_active、未知、过期与越权，不伪造 durable Operation。

与已交付 A+B 综合时，MemoryTools 对非自身工具透传 execution_class/watch_admission，自身
memory read 不注册文件 grant watcher。综合独立验收 **Host 5 个不同用例、Rust 13 个用例**通过：
Host 在真实 memory/context owner 主链验证 capacity 1/3、真实微型搜索和精确身份；Rust 由原
family 8、真实 Supervisor 取消竞态 2、真实 kernel wrapper/Storage 准入 3 构成。
确定性持有同 Catalog 的一个 permit，证明真实 wrapper 下搜索等待、取消在释放 permit 前完成、
释放后真实 Storage 撤权拒绝派发，以及 memory read/Prepare 仍可继续。没有用大扫描制造阻塞。

综合审查真实复现了两个新取消竞态：watch 注册期间真实 Supervisor.cancel 已发生，首次
family 查询通过裸错误传播，把 Run 留在 Waiting/execution-recovery。修复只在未派发阶段的
watch/family/acquire 返回后重读真实取消 token；明确取消走既有取消结算，无取消的基础设施
错误保留原恢复语义。模型和 policy 两个反例由旧版 0/2 变为通过，断言终态、真实回执、零派发、
无排队容量和 guard 残留；未改 context preparation 或 memory delivery 的已有事务。

最终 Host tests 类型、变更测试 lint、协议与 diff 检查通过，client/protocol 和 Host bundle
构建通过。早先 Host 默认 1 秒轮询失败、测试 identity 缺判别字段的类型失败与两个生产取消
红测均保留；仅修测试 identity 后重跑受影响 Host 2 例，不重复计数。无全仓 lint/零 warning 声明。
最终源码摘要 `d9cd7ad416a088c7023f152f829d7af3f305b3e49f88f82950e1823fc94a8963`，
相对实际 v2 binary 构建仅一个 TS 测试 identity 字段变化，生产与 Rust 输入不变；验收后只加本节。
0.9.24 debug binary SHA256：
`0a7a2ea31105dcc50b627bf1f8c58835164779d08ae799e80f7eb5695e966f47`。

边界：kernel 测试观察透传/卸载所用 watcher 为测试提供；真实 Kernel grant 撤销在 permit
仍被持有时立即唤醒排队调用，尚未端到端实证。真实 Storage 撤权后拒派发、真实 Supervisor
取消已分别实证。此首切不覆盖所有 compute 消费者、OS 线程创建失败注入、完整重启矩阵、
统一有界 worker 执行器、优先级老化、性能比较或完整设计交付；下一进程持久等待增量独立推进。

## 2026-10-09 原生进程持久等待与公平主线综合

新增 `wait_process`，从已有同 Run 的 process_spawn Operation 观察真实 executor
终态回执，复用 Catalog Wait/原模型工具交换/Host continuation，不以模型反复 inspect 作为
等待实现，不新建第二进程表。观察取消不等于停止进程，Run 取消不在迟到终态后自动续接；
输出仍由原进程 owner 保留，只交付有界且带来源的生命周期事实与读输出引用。

合法同 Run rebind 后，通过真实 Catalog 原 Operation 与当前合法 source 绑定，只允许精确
原进程的 inspect/read。Storage 每次核原/当前 grant、真实 Run/Thread/source 与物理根；不
复活旧授权、不新建持久 observer grant、不扩 kill/stdin/write/跨 Run 权限。原或当前 grant
显式撤销均拒绝。现有运行中部署 trust/root 变化没有即时撤 grant 监听，该边界仍明确保留。

独立分支已验证 Runtime 7、真实 Host 5、原 source-picker consumer 1，修复恢复伪终态、
观察取消事务窗口和 signal 字符串丢失。与公平主线合并后，在实际
Native→Questions→Collaboration→ProcessWait→Memory（可选 MCP 最外）链上补齐双 hook 透传。
综合 **Host 5、Runtime 7、真实 kernel wrapper 3，共 15 项行为**一次通过，窄测试类型、
定点 lint、协议生成及 diff 检查通过，生产 Host bundle 重新构建通过。kernel 三例保留
确定性 held permit、搜索排队、取消与 guard 释放、真实 Storage 撤权拒派发，以及 memory
read/Prepare 可达断言；未用无关全套重跑代替这些实际接缝。

恢复合同分开验证：仅 Host continuation service 重建，原 kernel 与进程仍活，可在同 Run
继续等待并读到原输出；kernel 关闭会按既有生命周期停止进程，重开交付真实 Failed/Killed
及不完整输出，不重 spawn、不伪称成功。已到达终态、重复终态、提交交付后失续接与观察取消
均有持久反例；原始错误 fixture 和失败日志保留。

综合 0.9.24 debug binary SHA256：
`38245890771009ab23e50c9858256ea5fea495c254de47a3a279f20c8aab8128`。
最终 5198 文件源码摘要 `58f96c5f3867a3d08d02475f1ca6522e532cb8a857694857f69b1bcce6af75c1`。
构建期间仅 cfg(test) 模块接线变化，生产输入稳定；最终验收与构建 after 源码相同，运行收据
绑定专属 binary 和 14 个实际依赖输出目录。验收后仅追加本节文档。
这不是跨 kernel 存活保证、全部进程控制/UI、完整恢复矩阵、跨平台或完整两份设计交付。
