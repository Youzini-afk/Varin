# 原生运行时实现审阅

日期：2026-10-09。基线：`41ec1cce`，分支 `implementation/native-agent-runtime`。
对照：[完整运行时设计](../design/native-agent-runtime-design.md)、[能力组合设计](../design/native-runtime-extensibility-design.md)。

## 判断

当前是有实际产品入口的部分实现，尚不满足两份设计的整体交付标准。Rust 已经拥有原生历史、Run、操作和等待事实；模型、工具和扩展具有真实接线。这个方向值得继续。默认产品仍用 Pi，若把“可以运行原生对话”作为完成标准，会遗漏此次重构最重要的控制路径隔离、可组合环境及完整产品迁移。

本轮沿设计不变量检查了运行与持久化、资源准入、模型工厂、上下文/记忆、子任务/进程等待、语言/检索、扩展更新、客户端及 UI。下面的结论来自源码与编译检查；没有执行测试、应用、桌面操作、付费请求或性能测量。原实施文档中的测试通过记录属于其当时基线，不能当成本轮通过证据。

## 本轮直接修正

| 问题与影响 | 修正及边界 |
| --- | --- |
| 模型请求、模型输出及工具批次正文在 `Mutex<Catalog>` 内序列化、哈希、落盘；长历史使其他 Run 的控制请求争用同一锁 | 执行提交拆为短锁内取得引用、worker 写正文、短锁内核对并提交引用。发布期间持有内容寿命引用，GC 遇到在途发布本次不清扫，不持 Catalog 等待发布者；回执幂等、历史 CAS 和拒绝输出的保存路径保留。辅助策略结果及启动恢复的其他大内容路径仍见下节 |
| 每次 Run 结束反序列化整个 operations 表；提交事件仅为读取 `kind` 又复制整条执行记录 | 终态查询按当前 `run_id` 判断是否还有前台操作；事件种类按枚举取得，不复制请求/结果正文 |
| 文件工具的资源规划用独立 `CancellationToken::default()`，且授权查询进入 Storage 后只能阻塞等回执 | `ToolExecutor.prepare` 显式接收真实取消信号，所有包装器透传。无副作用的授权/资源身份查询以完成或取消事件唤醒；取消后排队的 owner 请求仍带取消标记。实际修改/进程派发继续等待执行端回执，避免把未知效果当作未发生 |
| 每个工具重新构建全部原生 schema、重复复制本批工具目录和读取来源 | schema 在绑定构造时保存；一个模型批次共享其冻结目录与来源。完整统一 registry 仍未迁移完 |
| 已持久受理的输入仍等待上下文刷新或来源/MCP/凭据重新绑定，准备失败会让发送接口返回失败 | 已受理后返回原回执，准备独立推进并按 Run 合并在途工作；失败记录到原 launch。运行中输入的受理不等待上下文扩展刷新。首次输入受理前的配置/初始上下文准备仍是剩余边界 |
| Host 启动恢复跳过问题/子任务等待，却未跳过进程等待 | `process-wait` 同样交给原进程等待 owner，根据真实终态交付后续接，普通 launch 恢复不提前重新启动它 |
| UI 从 cursor 0 重放所有线程的旧事件来显示一个会话 | snapshot 携带在读取各部分之前取得的 cursor；首次订阅从该 cursor 接续，覆盖快照读取期间的提交。重连仍沿已消费游标继续；后续全局事件的细粒度过滤还未完成 |
| 某分支的操作列表混入同 Thread 其他分支的活动作业；分叉历史也可能暴露原分支作业的取消入口 | Catalog 的活动操作查询支持按 branch 选择；历史回执只补入属于所选 branch 的作业。分叉保留原文，不取得原作业的控制入口 |
| 发送、压缩或失败回调晚于分支切换，可能清空新草稿、准备来源或错误状态；Host 切换只关闭订阅，没有重建 | 异步完成按界面身份核对；切换时重置 pending，Host generation 变化重新建立投影和模型目录 |
| 扩展新世代发布后，旧实例收尾失败仍进入候选回滚，可能恢复已释放的旧 owner | 将发布前回滚与发布后退役分开；收尾失败不销毁已成功发布的新组合 |
| Responses/Azure 工厂没有传递已声明的 `reasoningEffort` | 接到现有 Responses reasoning 字段；完整 UI 思考配置及其他家族的参数适配仍未完成 |
| 原生检索将整个 plan、stages、inference receipts 放进模型工具结果 | 模型结果保留摘录、来源、状态和缺失计数。绑定/内部回复继续核对选中实现与阶段，推理事实仍由原账本记录；现有断言改为在相应 owner 上核对这些事实 |
| 三份已有 Rust 验证文件中 16 个 `ExecutionEngine` 构造漏接 `context_preparation` | 为不涉及上下文同步的已有夹具补 `NoopContextPreparation`，修复编译；没有执行这些测试 |

主要实现入口：

- [执行提交与内容寿命](../../kernel/crates/varin-runtime/src/catalog_execution.rs)、[ContentStore](../../kernel/crates/varin-runtime/src/content.rs)。
- [执行合同/批次](../../kernel/crates/varin-runtime/src/execution.rs)、[原生资源调用](../../kernel/crates/varin-kernel/src/native_tools.rs)。
- [输入与快照适配](../../packages/web/application-host/lib/kernel/native-thread-adapter.ts)、[UI 投影](../../packages/ui/src/lib/native-runtime/thread-projection.ts)、[对话 UI](../../packages/ui/src/components/native-thread/NativeThreadConversation.tsx)。
- [扩展世代发布](../../packages/extension-host/src/broker-supervisor.ts)、[模型工厂](../../kernel/crates/varin-runtime/src/model_session.rs)、[检索工具结果](../../kernel/crates/varin-kernel/src/native_tools_retrieval.rs)。

## 尚未满足的关键结构合同

### 控制路径尚未完全脱离长工作

`native_runtime.rs` 的 `runtime.run.start` 同步调用 `RunSupervisor.start → launch_ready → prepare_recovered_execution`。后者仍会在 Catalog 锁内恢复历史/模型正文，然后才启动 Run worker。策略读取/辅助模型的部分正文发布也仍占 Catalog。此次移走常规模型与工具批次的正文提交，不能代表所有内容路径已经解耦。

`file.captureBatch` 的正文捕获已移到独立 worker，这是实质改进；`file.materialize` 的构建、备份和提升仍在唯一 Storage worker 中同步执行。原生文件/进程资源请求也经过这个 worker，因此物化仍可能阻塞它们。

工具批次先解析全部资源计划，再开始执行；真实路径解析需要询问 Storage。现在这段等待可取消，但一次慢规划仍可能推迟同批其他工具。下一步应让每项调用独立完成准备和受理，保留真实冲突的先后关系，不能仅通过并发派发未知资源的写入来消除屏障。

取消 token 有独立入口，但进程输出、桥接消息和大 JSON 仍依赖现有传输，尚未形成总设 §9 定义的独立控制连接与内容流。不能宣称大图片/输出回压下控制完全不受影响。

证据：[启动](../../kernel/crates/varin-runtime/src/supervisor.rs)、[恢复](../../kernel/crates/varin-runtime/src/catalog_recovery.rs)、[公共资源 worker](../../kernel/crates/varin-kernel/src/runtime.rs)、[物化](../../kernel/crates/varin-kernel/src/storage/file_resources.rs)、[策略正文](../../kernel/crates/varin-runtime/src/catalog_execution.rs)。

### 能力组合已有真实应用，但未贯穿全部执行路径

Rust `CompositionRegistry` 有候选发布、旧世代 pin、撤权及依赖解析；context fragments 实际使用该路径。Host 的服务路由、候选准备、policy lease、Observer 和 retrieval lease 也有真实消费者。普通替换保留旧调用、显式撤权拒绝新执行，这些边界是合适的。

但目前 context、policy、retrieval 和普通工具仍分别装配。普通工具通过 `NativeToolKind`、手写 schema 和多层 `ToolExecutor` 包装器接线；Host 另有名称映射。新增能力仍可能遗漏取消、调度或来源透传。相同结构的私有 request/reply bridge 也有重复实现。

后续应收敛到一份能力声明和绑定结果，让合同决定 schema、资源、完成与取消行为，再让现有平台负责安装和实例寿命。不能把通用 resolver 的存在当作所有工具已经由 CompositionPlan 驱动，也不应为消除重复再建立另一套插件管理器。

策略目前按 Run 固定；现有行动覆盖普通模型、辅助规划模型、只读依赖图和已有等待。完整子任务/一般工具图、结果交付与策略切换边界仍缺。模型工厂仍按支持家族分支构造，尚不是公开的可替换 provider 注册合同。

证据：[组合 registry](../../kernel/crates/varin-runtime/src/composition.rs)、[context 绑定](../../kernel/crates/varin-runtime/src/composition/context.rs)、[Host service binding](../../packages/extension-host/src/service-registry.ts)、[policy](../../packages/web/application-host/lib/kernel/native-agent-policy.ts)、[Observer](../../packages/web/application-host/lib/kernel/native-run-observers.ts)。

### 产品能力与性能目标不能由局部纵切代替

| 设计领域 | 现有接线与判断 | 剩余范围 |
| --- | --- | --- |
| 历史、Run、操作、等待 | 原生 Catalog 与不可变正文实际接通，状态与效果分开；保留这一权威结构 | 全恢复矩阵、内容流、长历史增量编译与吞吐实证 |
| 模型与认证 | 多协议 adapter、opaque 续接项、冻结配置、Host 凭据 owner 已存在 | UI/配置完整参数、所有 provider 行为、统一代理/TLS 等网络设置；当前传输按绑定构造 reqwest/Tokio，未证明跨 Run 复用成本 |
| 上下文与记忆 | 普通 notes 共享原 owner；系统记忆 checkpoint 与新事实分开；显式摘要候选成功后发布 | 自动容量管理/后台压缩、完整指令与技能发现、Bot 角色及已有上下文行为迁移 |
| 文件与来源 | fixed branch、materialized、live root 明确区分，实际授权与修订参与执行 | 完整路径/编码/编辑器/Git/恢复及可替换远端环境接线；来源物化的独立作业 |
| Shell/进程 | spawn、inspect、read 与持久 wait 接通；观察取消不杀原进程符合合同 | 完整 stdin/停止/输出 UI 与寿命交接；全平台恢复与推送式数据通道 |
| LSP 与检索 | 显式 live root 的定义、引用、诊断复用原语言 owner；关键词、结构、语义和来源核验有接线 | 固定视图的依赖闭包、其余代码智能、完整选材模型配置与领域迁移；不能据此认定旧 LSP 问题全消失 |
| 子任务 | 固定来源只读子任务受理、独立准备、结果、取消与等待已接通 | 写入隔离、共享任务、兄弟通信、代码集成、更多执行环境；当前有限 profile 不能称完整 dispatch |
| 计划/提问 | 领域 owner、revision/引用、分支计划及问答 UI 已接通 | 工作概览等现有消费者完整迁移；Goal、日历发生项和长期接续 |
| MCP/扩展 | 复用 MCP 配置/连接/认证权威；Host/Surface 与原生绑定有实际接线 | 最终去 Pi 执行依赖、完整资源/提示/交互/脚本入口、跨世代与环境组合 |
| Computer Use、材料、科研、Bot | 原有 owner 仍承担产品功能 | 原生作业、桌面分配/接管及这些领域的完整合同尚未迁移 |
| UI 与发布 | 显式原生入口可展示历史、输入、问题、计划、来源等 | 默认会话切换、完整标题/概览/工作台、用户资产导入、跨平台安装与性能验收 |

详细迁移清单继续由[实施文档](../plan/native-agent-runtime-implementation.md)维护。本轮没有把这些未交付域标记为完成，也没有切换默认运行时。

## 后续工程判断

优先完成控制与数据路径的隔离：物化、启动恢复、批次资源准备及剩余大内容提交。这直接影响此前反复出现的“一个慢工作拖住后续工具”，应先于新增更多领域包装器。

随后贯通能力 registry 与作用域组合，让新增工具、模型或环境不再依靠多个名称表和包装器同步修改；再按同一合同迁移完整产品领域。现有 Catalog、内容引用、请求快照、真实 owner、候选发布与 pin 应保留，不需要推倒重来。

性能结论仍需实际冷/热启动、长历史、多 Run 和慢服务场景提供证据。现阶段能确认减少了哪些复制、锁内 I/O 和旧事件重放，不能给出未经测量的速度倍数或“性能超强”的验收结论。

## 本轮验证记录

- 使用锁文件同步依赖，并完成类型依赖构建。
- `cargo check --workspace --all-targets --locked` 通过，包含已有测试目标的编译，不执行测试；保留既有未使用字段/方法等 warning。
- Host（含测试源文件）与 UI 的 `tsc --noEmit` 通过；变更 TypeScript 的 ESLint、生成协议 `--check` 和 `git diff --check` 通过。
- 原 Rust 夹具的漏字段已修；既有检索断言保留选中实现、来源、失败和推理收据的检查，改到实际 owner 读取，避免要求把内部信息继续塞回模型正文。
- 未运行测试、应用、付费服务、桌面驱动和性能基准。源码审阅与编译结果不能替代实际行为验收；当前整体结论为“部分实现，尚未通过完整设计验收”。
