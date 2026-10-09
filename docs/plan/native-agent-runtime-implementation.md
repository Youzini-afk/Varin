# 原生 Agent 运行时实施

状态：实施中，尚未切换生产运行时。更新：2026-10-09（Asia/Singapore）。

目标是完整实现[完整运行时设计](../design/native-agent-runtime-design.md)和[能力组合设计](../design/native-runtime-extensibility-design.md)共同定义的长期运行底座：及时交互、低开销执行、按真实资源调度、深层能力组合和可替换策略。完成聊天循环、迁移已有工具或删除 Pi 都不是单独的完成标准；Pi 退出是这套设计落地后的一个结果。当前生产仍使用 Pi session worker、TypeScript Host 协调和 Rust 资源内核；现有权威见[架构](../architecture.md)。

## 当前交付

- 工作分支：`implementation/native-agent-runtime`
- 首个纵切：新增独立 `varin-runtime` crate，建立持久身份、历史提交及模型执行的可检验路径；不把未接入的库称为产品能力
- 本文件只追踪实际状态和依赖；具体测试结论须来自对应代码与真实执行结果，未运行不记为通过
- 目前以下各项均未完成生产迁移；Pi、用户资产和现有生产路径保持原权威，禁止新旧循环同时推进同一 Thread
- 已新增局部实现：Catalog持久身份/历史/Operation/Wait，执行loop与事务桥接，RunSupervisor控制，多家族模型适配、输入队列与边界中断、组合依赖解析与绑定；kernel独立control worker和Host显式client已有真实IPC验证，未替代生产Pi路径
- 独立审阅发现并已修复：续接claim后崩溃丢唤醒、后台handoff仍被终态Run阻止；模型完成与历史/工具调用现由同一事务提交。其余交叉边界继续审阅，最终测试结果以稳定代码重跑为准

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
| 5 | 组合计划与既有扩展接线 | 在启用/配置变化时解析依赖与绑定；复用现有 Host/Surface、候选更新；在途绑定保留；观察者不阻塞提交 | 局部通过：原生绑定/pins/撤权、root-reachable依赖解析、候选scope检查及现有调用取消；异步owner装配与原生生产接线未完成 |
| 6 | 领域与产品消费者迁移 | 完成下表全部能力；UI snapshot/cursor；远端身份一致；用户资产一次性导入；逐域单写者切换 | 未完成 |
| 7 | 完整底层的产品交付与实证 | 两份设计的结构不变量和全部领域路径共同成立；默认完整产品与局部替换均可用；冷/热/并发/更新成本有证据；真实平台/发行验证；由此完成单写者切换并删除 Pi 与重复中转 | 未完成 |

步骤可在互不冲突的模块并行，但所有权切换必须依赖前置合同。先后顺序不缩减最终交付范围，也不要求把每个领域都重写为 Rust。

## 完整设计对照与下一工程纵切

2026-10-09 源码核对基线：`24b920ed`。本节同时读取两份设计、runtime/extension 所属文档及下列实际调用实现；描述的是该基线的缺口，不把并行中的未提交文件算作交付。下文简称「总设」为完整运行时设计，「扩设」为能力组合设计。既有通过记录保留在后文；本次对照不新增运行通过结论。

完成判断看真实调用链和用户路径，不看是否已有同名 trait、DTO 或测试文件。每行给出当前 owner、仍缺的不变量、一个可执行的下一步与应取得的证据；它们不是另设审批、通用防御层或测试元数据平台。

| 设计要求 | 当前实际 owner / 已有实现 | 尚缺的不变量或调用路径 | 下一工程纵切 | 验收证据（未执行不得记为通过） |
| --- | --- | --- | --- | --- |
| 扩设 §4–6、§10：同一能力合同与预绑定调用 | `kernel/crates/varin-runtime/src/composition.rs` 的 `CompositionRegistry`/pins；`composition/resolver.rs` 的根可达依赖图；`packages/extension-host/src/service-registry.ts` 的 provider/drain/候选替换 | `varin.context.fragments@1` 已贯穿真实 Host 安装/作用域选择、broker 声明、Rust resolver/registry、预绑定纯变换与实际模型请求；Host 显式 provider 直查及 service 索引已接通。通用检索/工具组合仍未完成，不能把静态工具选择视为统一 registry | 在已验收 context-fragments 纵切上推进真实 Decision/Observer 消费者，再逐域接检索/工具合同；保持内部 Rust 直接调用、仅真实边界编码 | 两个项目选择不同实现；工具/调用方无需修改；加未使用扩展不改变调用扫描范围；普通缺失与选定实现失败分别呈现 |
| 扩设 §5.2–5.4、§9：作用域、共享实例及局部准备 | resolver 已有 `ScopedSelection`/`PreparationKey`/`preparable`，把优先级解析明确交给现有 routing owner；Host supervisor 已有候选及 owner | `broker-supervisor.ts` 的公共 `#queue` 仍包住 prepare/activate/dispose；纯 resolver 的可并行节点不等于真实并行启用。父子作用域差量、共享实例准备仍需接线 | 耗时准备与释放移到实际实例/依赖范围，公共 owner 仅核对并发布选择；同共享键合并准备；不另外建安装器或配置库 | A 的 activate 或 dispose 未完成，独立 B 仍可启用/停用/调用；同依赖只启动一次；可选缺失不吞掉已选实现的启动失败；冲突选择给出实际来源 |
| 扩设 §6：Provider / Transform / Decision / Observer 四类参与方式 | Rust `ModelProvider`、`ToolExecutor`、`AgentPolicy`、`ProgressSink` 和 Catalog durable events 各自存在；Host SDK 有 services/effect/Surface 贡献 | SDK 已有声明式 `provideContextFragments` 与同合同 inspect，内置默认/可安装项目实例经真实模型请求验收。Decision/Observer 作者合同、多变换顺序/冲突及完整观察游标消费仍未完成；非阻塞 progress 不等于第三方执行隔离 | 在上述真实能力纵切中接入一个不可变 Transform、一个明确边界 Decision 和一个经 broker 消费提交事实的 Observer；复用事实游标与既有 worker，慢计算作为真实 Operation | 慢/同步阻塞观察插件不阻止工具提交与无关 worker；观察者重连按游标恢复；变换不修改原历史；决策只阻塞依赖自己的工作；观察者后续动作有新命令来源 |
| 总设 §11、扩设 §7：完整可替换 AgentPolicy | `execution.rs` 已有合法行动检查、版本化 `PolicyCheckpoint` 和默认循环；`model_session.rs` 默认绑定 `DefaultAgentPolicy` | `PolicyAction` 仅有 RequestModel/ExecuteTools/Wait/Complete/Fail；ExecuteTools 只解释模型给出的待结算批次。策略不能通过该合同提交独立工具图/子任务、多模型工作、交付或暂停；配置选择和安全边界替换未接通 | 以研究/计划执行的一条真实策略路径补行动受理与状态关联，接组合选择；慢规划模型用独立推理工作，不在 `decide()` 内做 I/O；保留核心交换配对 | 替换策略后原文/模型 opaque 仍可读；规划等待期间其他 Run 可执行；重开不会重做已受理行动；不兼容私有状态不伪造迁移；策略卸载不删除已受理子任务 |
| 扩设 §9：热变更、旧调用及持久工作寿命 | Composition handle/lease/pins 区分 retired 与 revoked，按实际实现持有引用；HostServiceRegistry 有 inFlight/drain | Rust pins 尚未贯穿生产 Host/Surface 世代发布。现有局部通过不能证明模型生成时更新工具包、无 UI backend、独占资源交接和已提交选择重启恢复 | 让真实工具包的候选选择直接驱动组合发布；旧 ModelStep 保留 schema/实现，后续请求取新绑定；显式禁用沿执行身份取消；Surface 只作为声明的组依赖 | 候选失败保留旧组合；旧参数按旧实现完成；撤权后的新副作用被拒；关窗口不杀后台作业；旧无关实现引用释放；独占能力只暂停自己的新调用 |
| 总设 §7–8：按真实资源的跨 Run 调度和便宜读取 | `execution.rs::execute_tools` 先建合同、按 `contracts_conflict` 排序、独立完成工具；`catalog_execution.rs` 已避免为普通只读结果建立持久 Operation | 当前依赖扫描限于单一模型批次，并为每项就绪工具启动线程。没有 runtime 级任务族公平准入；不同 Run 的同资源冲突不能由这个局部图解决。文件 CAS 是提交保证，不代替资源调度 | 把准入归到共享资源 owner：由已有可信资源计划确定 environment/view/真实目标，跨 Run 排队；短读保留内存身份；执行队列区分交互、阻塞 I/O、CPU 和维护，容量由资源/配置决定 | 两个 Run 的冲突写按资源顺序；不同资源继续；大量检索不会饿死另一个任务的交互；取消排队项不取消共享服务；无需给每个内部 helper 建 Operation |
| 总设 §4.1、§9、§23：单一协议、控制/数据分离、事件推进 | `kernel/protocol/schema.json` 生成边界；native control worker、Host native client 独立 credits；guardian 推送/磁盘输出已有局部实证；历史引用分页已有 HTTP 实证 | 不能由某一进程通道推导所有域完成。`native_tools_discovery.rs` 仍 `compute.read` 加 sleep 等待/收尾；大内容模型请求仍全量序列化/读取；同进程资源桥仍需区分 typed 执行与外部 wire 解码 | 接 compute 终态通知与共享准备等待，删除内部空轮询；沿实际大截图/日志/内容路径核查独立数据流；逐域移除重复 JSON 中转而不新增统一 RPC 层 | 计算、输出或大内容拥塞时取消/状态可受理；完整日志可按游标重读；控制成功不冒充执行已停止；空闲内部等待不持续产生 read RPC |
| 总设 §12–13：模型用途、稳定上下文、即时记忆与压缩 | `providers/`、credential broker、Host credential owner；`catalog_context*.rs`/`context_job.rs`；Host `native-thread-context.ts` | 多家族 fake/loopback 通过不等于真实认证/平台网络完整覆盖；显式摘要不是自动预算策略或完整记忆流程；chat 之外 embedding/rerank/decision/image 仍须按用途接入 | 让内置 ContextCompiler 与可替换上下文策略消费同一来源/记忆 revision；即时写入走现有 memory owner，成功 checkpoint 原子更换稳定系统快照；在实际检索路径绑定非 chat 推理用途 | memory UI/工具交错不丢 revision；压缩候选期间新增尾部保留；失败保留旧 checkpoint；token 预算包含工具/附件/事件；按真实 provider、认证和网络场景分别记录覆盖 |
| 总设 §14–16：源视图、捕获、dispatch、恢复与整合 | Native source launch/selection、Storage 分支/内容/文件事务、Host Documents/WorkingState；native 历史 branch 与文件 journal 恢复已有证据 | 明确 native source 准备不等于主/子任务 dispatch 完成；编辑器草稿、文件副本与 Git/overview 仍需同源关联；报告和代码集成不能混为一物；组合恢复与 Host 启动续接须走完整产品路径 | 以一个有独立源视图的子任务贯穿立即持久回执、批量捕获/共享固定 root、准备取消、执行、报告和条件代码整合；复用底层 writer | 大非 Git 根准备时父任务和控制继续；重开继承真实副本而不重置文件；无改动子任务正常交付；父目录后来修改形成明确冲突；草稿不被聊天分支操作覆盖 |
| 总设 §17、扩设 §5.3：语言/检索及一致环境 | Host `lsp`/`search`/`structure`/`knowledge`，Rust compute；原生 file_list/file_search 已复用 compute 与授权 | 原生直接 file 查询不等于完整 LSP/语义检索迁移；服务共享键须包含 environment/project/config/source view，固定工程的依赖文件也必须一致；远端不能只替换文件 provider | 通过同一能力组合绑定 read/Shell/LSP 源视图；把一个现有 LSP 查询和检索 PipelinePlan 接到原生调用，准备按实例共享、独立预热 | LSP 卡住时 read 与其他环境继续；同名本地/远端路径不串源；只改目标 didOpen 不被误记为完整分支视图；取消一个等待者不杀共享 LSP；pending 与 clean 有区别 |
| 总设 §18：问题、计划、Goal、定时与 Bot | `catalog_questions.rs`/`native_questions.rs` 已出现问题持久路径；Host memory/todo、bots、followups、scheduled-tasks 仍各有领域 owner | 问题记录不代表 Goal/日历发生项全部完成；既有 Host 续接权威还须收敛到统一 Run/Wait；显式 Goal 授权、手动暂停、用量和时区语义不能丢失 | 逐域把领域事件接原生受理和 durable Wait，先完成关闭 UI 后回答/续接与一次日历发生项；计划保留单 revision，Bot 使用相同任务身份而保留独立知识 | 默认答案/到期不是批准；订阅登记窗口不丢唤醒；重启只准入一次 occurrence；分叉不复制自动授权；暂停不被 timer 覆盖；用量不因投影重复累计 |
| 总设 §19、§22：桌面与远端执行资源 | Host `computer`、`packages/computer-driver`、环境服务；既有真实平台能力继续复用 | 尚未贯穿原生 operation/owner/control epoch；断网/Host 重启不证明进程或输入停止；独立桌面与同一物理桌面必须不同调度语义 | 接一个真实桌面作业和一个远端执行环境，固定资源映射与执行端回执；紧急停止直接到执行端，重连查询原 operation，不从聊天状态推导成功 | Catalog 不可写仍能停止输入；释放键和控制分配有证据；接管后旧队列不续发；鼠标移动不擅自接管；远端失联保持未知效果；其他桌面继续 |
| 总设 §20、扩设 §8：MCP、持久脚本、作者合同与发现 | `extension-contract/host/sdk` 已有 Host/Surface、effect、typed workbench API；Pi MCP/codemode 仍为已有入口 | 尚未交付 native 单 registry 的工具直调/发现/codemode 路径；Agent 自助扩展缺实际合同查询到候选包启用的闭环；不得另养文档目录或绕过现有启用授权 | 接既有 MCP 配置/凭据与能力协商；同 registry 提供精确 schema/依赖/选定实现/准备状态/UI slot 查询；用普通 SDK 构建一个领域工具及卡片，再通过原有候选流程更新 | 禁用工具后脚本不能另路使用；完整 async 单元格可等待并保留嵌套调用身份；无 print 仍有必要提交事实；无 UI 工具照常运行；MCP Tasks 只在协商支持时映射 |
| 总设 §21、§24–25：完整产品与单一事实权威 | `application-client` native API、Host authenticated routes、UI native projection/selector 已构成显式纵切；现有 Web/材料/科研/Bot/工作台服务仍可复用 | 显式原生页面不等于所有产品消费者使用相同 revision/identity；报告、任务卡、编辑器、通知及移动/远端仍须接完整合同；用户资产导入与旧在途任务结算未完成 | 沿上述能力逐域更新真实消费者，最后完成默认入口与单 writer 切换；Pi 资产一次性导入保留原文/未知项/opaque，删除旧循环和重复桥 | 同一工作在各投影视图一致，断连按 snapshot/cursor 恢复；用户手改标题不被迟到作业覆盖；导入能核对原 entry/分支/工具配对；无双写、重复付费请求或副作用重放 |
| 总设 §23、§28、扩设 §10–12：成本及发布实证 | 现有明确 Linux、IPC、分页、provider fixture 证据见后文；打包属各 surface/kernel owner | 无冷/热/并发/更新的代表性成本对比；未证明扩展/作用域增加时热路径与旧世代释放成本；局部 Linux 验证不是 macOS/Windows/全部部署验收 | 针对已接通路径记录实际选择次数、编码/存储/读取工作量和等待来源，比较首轮/复用/并发/更新；在目标发行包验证同后端及资源生命周期 | 未用扩展不增加首轮等待，长工作不保留整棵旧实例树；大历史内存/读取成本可解释；安装/升级/无 UI Host 真实运行；收益实测而非预填倍数/毫秒门槛 |

### 当前优先级

1. **先把组合接成真实运行路径**：已有 Rust resolver/pins 足以起步，优先移除 Host 生命周期公共等待，并接一个可替换能力及作者合同。不要先增加另一套泛化调度/插件框架。
2. **并行补跨 Run 资源准入与事件执行**：解决单批调度边界、共享准备与 compute 内部轮询；保留已经通过的取消、回执和短事务合同。
3. **让策略和上下文真正可替换**：用实际多步工作证明行动合同，补齐默认记忆/压缩/推理用途；不以 trait 存在或默认循环能聊天作为完成证据。
4. **沿同一合同接完领域与产品**：协作/源视图、语言/检索、问题/计划/Goal/定时、MCP/脚本、桌面/远端、科研/Bot/UI 各有真实使用路径。迁移可以并行，不能新增第二套领域状态权威。
5. **以实证收尾完整设计**：局部热更新、独立等待、资源公平、成本复用与平台发行都成立，才完成最终切换及 Pi 清理。Pi 删除不是前四项的替代品。

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

本轮 Host/Pi-host 类型、协议生成一致性与文档链接检查通过。已安装的 SDK 补丁实际参与上述测试；cloud lock 按官方 staging 的 production manifests 核对后完成 frozen install。完整发行布局因缺少生成的 Web CLI/UI 产物未验，不据此声明所有平台或 release 包通过。

下表的“现有入口”是迁移来源，不表示其中代码都应保留，亦不把既有实现误记为新原生合同已完成。

| 能力 | 当前入口/权威 | 目标交付 | 原生实现状态 |
| --- | --- | --- | --- |
| 会话、分支、运行中输入 | `packages/pi-host/src/session-host.ts`、`packages/runtime-broker` | ConversationStore + RunCoordinator；队列编辑、steering、停止、重连、历史回读 | 局部实现：持久队列、编辑/取消、边界输入/中断/nextRun；显式原生界面、固定 head 分页与对话分支已接入；默认路由迁移与完整恢复未完成 |
| 模型、认证、推理用途 | Pi SDK、Host `connections`/`pi-config`/`small-model` | 各实际配置 transport、OAuth/云身份、模型覆盖、reasoning/opaque、多模态、usage；chat与embedding/rerank等各自合同 | 未完成 |
| 上下文、记忆checkpoint、压缩 | Pi harness/session history、Host `memory` | 原文保留；来源角色；冻结快照；祖先范围压缩；交付去重；即时记忆写入与稳定system快照 | 原生 checkpoint 与显式摘要 Run 已实现，产品接线验收中；自动预算触发与完整记忆流程未完成 |
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

## 下一阶段：各一条真实 Decision / Observer 消费路径

在当前组合切片独立验收后推进，不把以下范围误记为已交付，也不同时扩到任意工具图和子任务框架。

- **Decision：有界研究/证据收集策略。** 沿现有 Host service 路由选定 `varin.agent.policy@1`，经既有 broker worker 在 `execution.rs::AgentPolicy` 的命名边界计算决定；先按整个 Run 固定策略实例与版本，不声称可热迁移不兼容私有状态。策略只选择继续推理、执行已受理工具交换或结束；原有 `PolicyCheckpoint` / `catalog_recovery.rs` 保持私有状态身份核对，核心 history、provider opaque 项、ModelStep 配对及工具受理仍由现有 owner 控制。跨进程决定调用必须带取消上下文，慢/失联策略只能阻塞本 Run，不能让取消、别的 Run 或 Catalog 事务等待第三方回调。非法决定先按核心规则结算已登记交换；策略不能给自己扩权或重放未知效果。
- **Observer：Run 完成/活动视图扩展。** 复用 `catalog_observe.rs` 的非阻塞通知、`Catalog::events_after` 已提交事实游标及 `Catalog::set_delivery` 的 selected → sent → committed 记录；独立 Host 消费者把所选事实交给 broker，确认精确事实身份后推进交付状态。无需再造事实库或逐 token 持久队列。恢复按 at-least-once 表达，扩展按稳定订阅身份与事实游标去重；后续业务动作必须作为有自身来源、幂等键和授权的新命令受理，不能伪装为原工具成功路径或声称外部效果 exactly-once。观察者慢、崩溃或停用不得延迟生产者提交/工具回执。

验收分别证明：真实选定策略在取消/重开时不破坏交换和私有状态；真实观察 worker 停滞时生产继续，重开重送同一事实可去重。两条路径均复用已有 owner，不引入平行配置、授权或任务状态权威。

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
- Bedrock binary eventstream三项增量：逐字节frame、reasoning签名/工具/尾部usage回放、CRC/截断错误、前置取消，以及真实localhost binary HTTP→adapter通过；仅假Bearer，未验证AWS账号/SigV4
- 缓存完成输出恢复：真实SQLite重开后，不重发已完成模型请求；已结算工具不重做，其余调用维持合法配对；已dispatch且缺回执的effect保持待核实。恢复工具批次的Runnable→Executing真实失败已修复并通过；本轮相关源码hash在测试前后相同
- 已通过失败后修复的交错回归：输入head改变拒绝旧输出后，worker退出不再遗留Generating；持久Waiting/恢复Wait、原始拒绝输出及usage仍可查，重开不污染新历史
- `src/providers/tests.rs`：逐字节SSE、opaque与签名保留、矛盾重复项拒绝、截断/乱序；真实loopback TCP/HTTP→适配器、错误headers及headers/body停滞取消通过；共享transport只建一次client/runtime、并发请求/取消/headers隔离通过。Chat工具分片/finish后usage/DONE边界及Azure显式query/version/deployment/credential header与opaque家族fixture通过。Google/Vertex签名和可选工具ID配对、Mistral思考分片/ID碰撞配对、Codex instructions与绑定account/session headers通过；同家族不同connection identity不转发opaque。这不是各云端真实认证或全API家族验证
- `src/content_tests.rs`及Catalog回归：大请求原文/opaque重开、追加历史块复用、各相位不回写整请求、GC保留live对象、缺失/损坏阻止sweep、孤儿staging清理、转换事务中途失败完整回滚、格式marker冲突拒绝通过。缺对象时public dispatch先写Dispatched的真实反例已修复并复验；另通过格式v2→v3升级不嵌套已有request引用、多领域GC根、拒绝输出及队列编辑/交付GC后重开；不代表模拟真实断电或所有文件系统
- `tests/composition_resolution.rs`：不相关依赖不成屏障，optional不吞实现失败，真实环路/歧义、陈旧准备/作用域变化、集合顺序通过；尚未接上完整生产扩展装配
- context-fragments 独立纵切验收：`packages/web/application-host/lib/kernel/native-context-composition-review.native.test.ts` 5 项真实 broker/原生模型请求通过；内置默认、项目实例、失败保留 checkpoint、同记忆 revision 更新及无关路由不重复 describe。`kernel/crates/varin-runtime/tests/context_composition_review.rs` 1 项证明连续 5 次复用同 binding ID、替换产生新 ID、旧 pins 在移除后可完成纯变换、data 保留 ExternalData。Host tests TypeScript 0 diagnostics；这不覆盖尚未实现的 Decision/Observer。
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
- RequestSnapshot、history正文/provider originals、model_outputs及队列交付正文已持久化为不可变manifest/chunks，ModelStep相位写入保留短引用；追加历史可复用内容块，读取保留完整原文。当前仍全量序列化/读取请求，未实现完整内存工作集优化；跨Run共享资源公平调度、完全独立能力准备尚未完成
- 完整恢复驱动（已完成模型结果/部分工具回执的原生续接已通过，Host完整恢复编排仍未完成）、输入队列的产品接线、压缩与记忆checkpoint、全部provider/OAuth及Host认证迁移、MCP/扩展生产接线、LSP/捕获迁移、UI投影、Pi用户资产导入、跨平台发布和最终Pi退出仍须按能力矩阵交付
