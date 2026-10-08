# 原生 Agent 运行时实施

状态：实施中，尚未切换生产运行时。更新：2026-10-09（Asia/Singapore）。

目标由[完整运行时设计](../design/native-agent-runtime-design.md)和[能力组合设计](../design/native-runtime-extensibility-design.md)共同定义。完成一个原生聊天循环不代表完整替代完成。当前生产仍使用 Pi session worker、TypeScript Host 协调和 Rust 资源内核；现有权威见[架构](../architecture.md)。

## 当前交付

- 工作分支：`implementation/native-agent-runtime`
- 首个纵切：新增独立 `varin-runtime` crate，建立持久身份、历史提交及模型执行的可检验路径；不把未接入的库称为产品能力
- 本文件只追踪实际状态和依赖；具体测试结论须来自对应代码与真实执行结果，未运行不记为通过
- 目前以下各项均未完成生产迁移；Pi、用户资产和现有生产路径保持原权威，禁止新旧循环同时推进同一 Thread
- 已新增局部实现：Catalog持久身份/历史/Operation/Wait，执行loop与事务桥接，RunSupervisor控制，多家族模型适配、输入队列与边界中断、组合依赖解析与绑定；kernel独立control worker和Host显式client已有真实IPC验证，未替代生产Pi路径
- 独立审阅发现并已修复：续接claim后崩溃丢唤醒、后台handoff仍被终态Run阻止；模型完成与历史/工具调用现由同一事务提交。其余交叉边界继续审阅，最终测试结果以稳定代码重跑为准

## 实施顺序与出口

| 顺序 | 要完成的工作 | 必须建立的合同和出口 | 当前状态 |
| --- | --- | --- | --- |
| 1 | 原生事实与持久边界 | Thread/branch/Run/ModelStep/Operation/Wait/Delivery 身份；请求幂等；branch CAS；原文/opaque 项；短事务及 outbox；受理与副作用恢复 | 局部通过：真实SQLite两轮模型/工具/最终提交与重开；受理/恢复原语通过。附件保留、跨Run回执隔离与未闭合交换终结限制复验通过，未接生产 |
| 2 | 单一协议与调用分类 | Rust/TS 生成边界类型；持久 command 与内存 query；效果/资源/完成方式合同；错误与游标语义；凭据只存引用 | 局部实现：共享枚举/控制命令生成与显式Host client；全运行协议及UI消费未完成 |
| 3 | 一个完整执行纵切 | 默认 AgentPolicy →冻结 RequestSnapshot→真实协议适配→工具合法配对→历史提交/停止/恢复；模型请求不能成为资源权威 | 局部通过：真实SQLite执行loop、多家族provider协议fixture与本地真实HTTP流/错误/取消；输入队列与序列化窗口中断通过。完整认证迁移、全部provider与产品路径未完成 |
| 4 | 资源执行与 IPC 去公共长等待 | 独立准备/捕获作业；保留文件 CAS/恢复；进程推送流；控制与数据分离；每个取消有实际执行端确认 | 未完成 |
| 5 | 组合计划与既有扩展接线 | 在启用/配置变化时解析依赖与绑定；复用现有 Host/Surface、候选更新；在途绑定保留；观察者不阻塞提交 | 局部通过：原生绑定/pins/撤权、root-reachable依赖解析、候选scope检查及现有调用取消；异步owner装配与原生生产接线未完成 |
| 6 | 领域与产品消费者迁移 | 完成下表全部能力；UI snapshot/cursor；远端身份一致；用户资产一次性导入；逐域单写者切换 | 未完成 |
| 7 | 全量替代与发布验收 | 所有目标路径接生产；移除 Pi loop、SDK patches、session workers 和重复中转；真实平台/发行验证 | 未开始 |

步骤可在互不冲突的模块并行，但所有权切换必须依赖前置合同。先后顺序不缩减最终交付范围，也不要求把每个领域都重写为 Rust。

## 能力清单与现有复用入口

下表的“现有入口”是迁移来源，不表示其中代码都应保留，亦不把既有实现误记为新原生合同已完成。

| 能力 | 当前入口/权威 | 目标交付 | 原生替代状态 |
| --- | --- | --- | --- |
| 会话、分支、运行中输入 | `packages/pi-host/src/session-host.ts`、`packages/runtime-broker` | ConversationStore + RunCoordinator；队列编辑、steering、停止、重连、历史回读 | 局部实现：持久队列、编辑/取消、边界输入/中断/nextRun；产品迁移与完整恢复未完成 |
| 模型、认证、推理用途 | Pi SDK、Host `connections`/`pi-config`/`small-model` | 各实际配置 transport、OAuth/云身份、模型覆盖、reasoning/opaque、多模态、usage；chat与embedding/rerank等各自合同 | 未完成 |
| 上下文、记忆checkpoint、压缩 | Pi harness/session history、Host `memory` | 原文保留；来源角色；冻结快照；祖先范围压缩；交付去重；即时记忆写入与稳定system快照 | 未完成 |
| 文件、草稿、恢复 | Rust `storage`；Host `documents`/`recovery`；UI Document Registry | 复用内容对象/条件写入/恢复；明确草稿owner；分支与磁盘效果区分；组合恢复可核对 | 未完成迁移，底层能力已存在 |
| 工作分支、基线与dispatch | Host `harness/thread-services.ts`、`thread-runtime.ts`、`kernel/storage-adapter.ts` | 持久受理立即回执；准备独立作业；批量capture；真实一致性标记；无变更报告与代码集成分开 | 未完成 |
| Shell、PTY、输出、进程树 | Rust `process` guardian；Host `kernel/process-service.ts`/`terminal` | 保留真实进程回执；推送I/O与stdin确认；控制独立；取消观察不同于终止进程 | 未完成迁移，guardian已存在 |
| LSP、结构/关键词/语义检索 | Host `lsp`/`search`/`structure`/`knowledge`；Rust `compute` | 按environment/project/config/view共享服务；来源修订明确；独立准备；不等待无关索引 | 未完成 |
| 任务协作、消息、wait | Host `harness` registry/services | 单一Thread/Run事实；有来源消息；Wait持久化与游标；结果恰当去重；旧世代不污染新执行 | 未完成 |
| 计划、普通记忆、Bot知识 | Host `memory`/`knowledge`；普通Agent notes为Rust typed record | 保留各领域owner、权限和revision；不把所有知识塞入泛化状态库 | 未完成 |
| Goal、自动接续、辅助模型 | Host `bots`/`pi-session-automation`/`run` | 显式Goal授权、暂停/预算/用量；等待不覆盖手动暂停；辅助请求独立身份 | 未完成 |
| 问题、follow-up、日历 | Pi extension UI bridge；Host `harness/followups.ts`/`scheduled-tasks` | 问答持久记录；到期非批准；发生项幂等；登记后重查防丢唤醒；时区/遗漏策略 | 未完成 |
| Computer Use、人工接管 | Host `computer`、`packages/computer-driver` | 实际桌面控制epoch；观察/动作/效果分开；紧急停止独立；释放按键与资源有证据 | 未完成；平台既有缺口不因原生化自动消失 |
| MCP、脚本、用户扩展 | Pi MCP/codemode adapters；`extension-contract`/`extension-host`/`extension-sdk` | 原生MCP；单registry；脚本嵌套调用同权限/回执；完整async单元格；不另造插件管理器 | 未完成 |
| 深层策略、发现与工作台 | 既有扩展service registry、Host/Surface和UI shells | CompositionPlan；Provider/Transform/Decision/Observer；AgentPolicy；按需合同查询；无UI后端 | 未完成 |
| Web/材料/科研/Bot领域工具 | 现有Host领域服务与harness工具 | 通过相同Operations接入；保留材料来源、产物及用户配置行为 | 未完成 |
| Web/Electron/Mobile、远端、发行 | `application-client`/`protocol`、各surface、Host环境服务、kernel packaging | 同一后端生命周期；snapshot/cursor投影；环境绑定/fencing；平台驱动与安装升级实际验证 | 未完成 |
| 用户资产与Pi退出 | Pi JSONL/配置/凭据引用/用户扩展源文件 | 一次性导入保留entry ID、分支、工具配对、压缩、opaque及未知项；原文件保留；切换结算在途工作 | 未开始 |

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

- 2026-10-09 06:15（Asia/Singapore），`cargo test --manifest-path kernel/Cargo.toml -p varin-runtime` 完整通过：70项unit、5项组合解析、5项凭据broker、5项模型配置，共85项；生成协议`--check`和`git diff --check`通过
- `src/catalog_tests.rs`：受理幂等、branch/epoch、opaque重开、跨Run回执隔离、未闭合交换不能终结；ExternalReceipt早到/晚到、重复/冲突、unknown细化和Wait唤醒均有实际回归
- `src/execution_tests.rs`：真实SQLite两轮模型/工具提交并重开；残缺参数不执行；Catalog锁占用时控制仍可取消；快工具不等独立慢工具；只取消资源队列中的一项不停止整Run；输入到达最终提交/序列化窗口不丢失、不发送旧快照；取消未启动Run释放分支
- 已通过失败后修复的交错回归：输入head改变拒绝旧输出后，worker退出不再遗留Generating；持久Waiting/恢复Wait、原始拒绝输出及usage仍可查，重开不污染新历史
- `src/providers/tests.rs`：逐字节SSE、opaque与签名保留、矛盾重复项拒绝、截断/乱序；真实loopback TCP/HTTP→适配器、错误headers及headers/body停滞取消通过；共享transport只建一次client/runtime、并发请求/取消/headers隔离通过。Chat工具分片/finish后usage/DONE边界及Azure显式query/version/deployment/credential header与opaque家族fixture通过。Google/Vertex签名和可选工具ID配对、Mistral思考分片/ID碰撞配对、Codex instructions与绑定account/session headers通过；同家族不同connection identity不转发opaque。这不是各云端真实认证或全API家族验证
- `src/content_tests.rs`及Catalog回归：大请求原文/opaque重开、追加历史块复用、各相位不回写整请求、GC保留live对象、缺失/损坏阻止sweep、孤儿staging清理、转换事务中途失败完整回滚、格式marker冲突拒绝通过。缺对象时public dispatch先写Dispatched的真实反例已修复并复验；另通过格式v2→v3升级不嵌套已有request引用、多领域GC根、拒绝输出及队列编辑/交付GC后重开；不代表模拟真实断电或所有文件系统
- `tests/composition_resolution.rs`：不相关依赖不成屏障，optional不吞实现失败，真实环路/歧义、陈旧准备/作用域变化、集合顺序通过；尚未接上完整生产扩展装配
- LaunchSelection在materialization前select持久化，准备途中重开仍可列出并重新绑定（06:18增量2项通过）；同计划绑定幂等，connection/config/schema/source变化拒绝；重开需Host重绑，重绑不允许重发未决ModelStep。当前保存非敏感选择，不保存可复用grant/credential；实际Host恢复编排仍须接线
- `tests/credential_broker.rs`：注入事务store的同reference刷新单飞、不同reference独立、取消等待不丢已轮转token、scope不匹配/持久化失败不给headers；`bind_with_credentials`真实localhost请求不回退环境凭据通过。全部是假凭据；尚未交付Host权威secret store或真实OAuth账号迁移
- `tests/model_session_configuration.rs`：未知provider不回退、默认不匿名、凭据仅在dispatch解析、不进入request body、无工具绑定不产生工具授权通过
- 独立TS IPC回归已验证真实kernel原生启动/完成/取消、固定branch文件读取、实际OS子进程与Storage终态；新guardian输出/control分离、磁盘spool、实际终态/取消、两lane credits在进程及IPC独立审阅的冻结构建验收通过；仍不代表完整跨平台发布

近期已由实际失败促成修复的边界还包括：附件静默丢失、续接claim崩溃丢唤醒、扩展cancel发送失败提前drain、早到进程receipt未在handoff应用/未唤醒Wait、丢acceptance后真实完成证据未结算。

仍不能宣称完成：

- 进程层在Linux本次真实OS验收通过；其他目标平台、非合作/异常断电与全部恢复组合仍需各自证据。不能把本次Linux结果推广到Windows/macOS全部行为
- 共享取消桥已统一native token通知，外部wire分lane credits与Host独立窗口对齐；相关进程/IPC并发回归已在冻结构建通过，后续协议变化仍须复验
- RequestSnapshot、history正文/provider originals、model_outputs及队列交付正文已持久化为不可变manifest/chunks，ModelStep相位写入保留短引用；追加历史可复用内容块，读取保留完整原文。当前仍全量序列化/读取请求，未实现完整内存工作集优化；跨Run共享资源公平调度、完全独立能力准备尚未完成
- 完整恢复驱动（含已完成模型结果的继续推进）、输入队列的产品接线、压缩与记忆checkpoint、全部provider/OAuth及Host认证迁移、MCP/扩展生产接线、LSP/捕获迁移、UI投影、Pi用户资产导入、跨平台发布和最终Pi退出仍须按能力矩阵交付
