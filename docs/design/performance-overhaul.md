# 性能整改与文档分层计划

状态：设计计划，未实施（2026-11-13），由执行 agent 分包推进。P0–P6 处理运行时性能（观察、IPC、Catalog 读取、鉴权、
UI 渲染），P7 整理文档分层。本文记录读代码发现的问题、建议的方向，以及做成后应该能看到的效果；具体做法由执行者看
代码实际情况判断，发现更好的路径可以偏离。背景见 [AGENTS.md](../../AGENTS.md) 与[性能](../performance.md#成本与边界)。
各包落地后更新对应模块文档，全部完成后把仍有价值的取舍并入领域文档，删除本文。

## 1. 问题

以下来自代码阅读，P0 负责补实测数据。慢的主因是几层放大叠加，不是单个校验本身：

```text
任意 Thread 的一个持久事件（全局 cursor 前进）
  → Host：每个 SSE 订阅者各自向 Rust 读一次事件
  → UI：每个订阅者各自全量刷新
       当前会话 snapshot + contextInspection + 用量；侧栏全量 list(archived:include)；
       组织树逐页重读；会话树、用量页、陪伴、协作 feed …
  → 一次 snapshot 约 35–60 次 Host→Rust 调用（历史页逐条 historyItem、逐个 operation/run/launch）
  → IPC：请求窗口 2；每个小请求走完整流式握手（open/begin/ready/data/ack/end/ended，经 worker 编解码）
  → Rust：单 actor 线程 + 全局 Mutex<Catalog>；每个请求先 reap()（逐个活跃 operation 查 SQLite）
  另：markRead 再写一个事件，触发新一轮；开启密码或配对客户端时，每个请求还有多次加锁、fsync、重写文件的鉴权事务
```

关键位置：

| 环节 | 位置 |
| --- | --- |
| 会话投影：任何事件都 refresh | `packages/ui/src/lib/agent-runtime/thread-projection.ts` `observe()` |
| 侧栏：任何事件都全量 list | `packages/ui/src/stores/useThreadStore.ts` `bindThreadStore()` |
| 组织树：任何事件逐页重读 | `packages/ui/src/stores/useConversationOrganizationStore.ts` |
| 其他订阅者 | `ConversationTreePanel`、`ThreadTokenUsage`、`ComposerModelAssist`、`collaborationFeed`、`attentionCoordinator`、`useContextJobHistory`、`FileRecoveryTimeline`、`UsageSettingsPage`；`thread-history.ts` 的用量重读以 eventCursor 为键 |
| Host 每订阅者读事件 | `application-host/lib/kernel/thread-adapter.ts` `observe()` |
| snapshot 扇出 | `thread-adapter.ts` `snapshot()`、`readHistoryPage()`、`context()` |
| 线程中间件递归扫 body、逐个 IPC | `application-host/lib/kernel/request-principal.ts` |
| 鉴权重复解析、主体文件事务 | `lib/ui-auth/ui-auth.ts`、`lib/ui-auth/principals.ts`、`lib/client-auth/remote-clients.ts`、`packages/settings-store/src/index.ts` |
| 传输握手与 worker | `lib/kernel/kernel-transport.ts`、`kernel/crates/varin-kernel/src/transport.rs` |
| 请求窗口 2 | `kernel/protocol/schema.json` 的 `requestWindow`，`kernel-client.ts` 与 `runtime.rs` 两端执行 |
| 单 actor、每请求 reap、二次校验 | `varin-kernel/src/agent_runtime.rs` `Command::Request`；`varin-runtime/src/supervisor.rs` `reap()` |
| 目录 N+1 与 json_extract 过滤 | `varin-runtime/src/catalog_threads.rs` `list_thread_catalog()`、`inspect()` |
| 主体过滤的逐事件 UNION 子查询 | `varin-runtime/src/catalog_principals.rs` `events_after_for_principal()`、`SUBJECTS` |
| `synchronous=FULL` | `varin-runtime/src/catalog.rs` `open_with_resource_admission()`、`varin-kernel/src/storage/core.rs` |

## 2. 方向与边界

在 P0 的场景下，大致想达到的效果：

- 打开一个会话只需少数几次 Host→Rust 调用（一次组合视图，加 Host 自有部分）。
- 与当前会话无关的事件不引起当前会话的读取；侧栏不再全量 list，只读取变化的线程。
- 小 IPC 每个方向一帧，不经过 worker；读请求不排在 Catalog 写入或执行中的工作后面。
- 鉴权与设置的读路径不碰磁盘（首次加载除外）。
- 流式输出时，只有流式区域随增量重渲染。

体验边界。用户给出的前提是：实现可以随便改，但下面这些感受不能变差：

1. 首 token 延迟与流式增量间隔；大正文（大文件、长工具输出）仍分块、有背压，不阻塞小消息和界面。
2. 发送、取消、权限审批、问题回答的反馈速度。
3. 侧栏排序、未读、标题和组织树的实时性，以及桌面、手机、远端客户端之间的一致性。
4. 断线、Host 重启、kernel 重启后各视图能自己恢复，不留下长期过期的快照。
5. 多主体（开启密码或配对客户端）下，事件和数据的可见性。

这一轮不打算改变的：取消意图与真实停止的区分、资源寿命与租约、未知效果不重放、Catalog 升级方式、对 renderer 与
远端客户端的输入校验、公开 HTTP API 的语义（可以新增批量接口；删除旧接口时要一并迁移所有消费者）。
私有 Host↔Rust wire 随同一构建发布，不需要兼容旧格式。

## 3. 工作包

### P0 基线与计数

改之前先有一份基线，后面才能比较。现有的 `scripts/measure-interaction-hotpaths.mjs` 和 native 测试入口可以扩展，例如：

- Host：用环境变量开启的计数器，记录每个 kernel 方法的调用次数、窗口等待、往返时间分位，以及 snapshot、list、
  organization read 的次数。`KernelClient.requestRaw` 和相应路由是自然的位置；关闭时不应有成本。
- UI：开发构建下统计 projection refresh、loadCatalog、组织刷新、`ThreadConversation` 渲染次数。
- Rust：按方法记录派发耗时和 Catalog 锁等待，写 stderr 诊断（不含正文）。
- 场景：S1 冷打开 200 条历史、含工具调用和子任务的会话；S2 打开两个会话、侧栏约 300 个线程，在其中一个会话跑一次
  含约 30 次工具调用的 Run；S3 查看会话 A 时后台 Bot 在会话 B 运行；S4 开启密码、用 bearer 客户端重复 S1。
- 体验指标：首 token 延迟、增量到达间隔、发送到 Run 受理、取消到界面停止。

基线记下源码 SHA、构建类型和平台，便于之后对比。计数器留着，也能在回归测试里断言工作量。

### P1 鉴权与设置读取

1. **主体存储常驻内存。** `principals.ts` 启动时读取并解析一次，`ownerId/resolve/isOwner` 直接查内存。首次创建仍用事务写入。
   只有本模块写这个文件，没有运行期修改接口，不需要失效逻辑。
2. **设置存储读路径。** `settings-store`：锁文件去掉 `handle.sync()`；`transact` 返回 `write:false` 时不重写；只读调用改用
   `read()`。在模块级（同一进程内所有实例共享，Electron 与内嵌 Host 同进程）缓存每个路径的文档文本，本进程写入时更新；
   其他进程的写入用目录 watch 失效，watch 不可用时退回按 mtime/size 判断。`readSettingsFromDisk`（约 51 处调用）因此不再读盘；
   缓存文本、每次 `JSON.parse` 返回新对象，避免调用方修改共享对象。
3. **配对客户端。** `remote-clients.ts` 启动时加载并规范化一次，内存中按 tokenHash 建索引；认证只查内存，`lastUsedAt`
   按现有 60 秒节流异步写回；创建、撤销、清理同时更新内存和文件。确保整个 Host 只有一个实例。
4. **认证每请求一次。** `ui-auth.ts` 增加按请求记忆的 `resolveRequestAuth(req)`（WeakMap），`requireAuth`、
   `requirePrincipalAccess`、`resolveAuthContext` 和线程中间件都用它；jwtVerify 每请求一次。
5. **去掉递归扫描。** `request-principal.ts` 只保留：建立主体上下文、Host 资源 `source` 的 owner 检查。归属检查收进
   `OwnershipResolver`：进程内缓存 thread→principal、run→thread、operation→run、input→thread；未命中时用一次批量 Rust 调用
   `runtime.ownership.resolve`（P3 提供；P3 之前可以用现有单项读取填缓存）。thread 的主体只会在 Host 首次
   `principals.initialize` 认领旧记录时改变一次：初始化完成后再开放缓存，或在初始化时清空。
   原中间件的“公开执行的修改需要 Host owner”规则移入 `assertAccess(owner, 'read' | 'write')`，由路由声明读写。
6. **处理函数的归属检查。** 去掉统一扫描后，安全性取决于每个路由都检查了它实际操作的标识（`thread-routes.ts`、
   user dispatch、attachments、interactive-ui）。两个主体的行为测试覆盖全部路由，比逐个人工核对更可靠：用另一个主体的
   ID 调用应被拒绝，公开执行的写操作需要 owner。
7. **观察进度的权限。** `thread-adapter.ts` `observe()` 中按线程调用 `runtime.thread()` 的检查改用 resolver 缓存。
8. **每次发送前的组织读取。** `index.ts` 的 `ensureOrganization` 每次 dispatch 都读一次组织；改为按主体记住“已初始化”，Host 生命周期内只读一次。

做成后：S4 中认证路径没有文件 I/O（计数器或 fs spy 测试）；snapshot 请求的 IPC 少掉中间件那部分；双主体测试全部通过。

### P2 IPC 传输

现在一个只带 `{threadId}` 的请求，要经过约 6–8 次 socket 往返和 4 次 worker 线程跳转；token 流的每一批也是如此，
而且 Rust 的 `send_progress` 要等整条流结束才发下一批。

1. **内联帧。** data 连接的帧增加 1 字节类型：已有的流分块，和新的“完整消息”。不超过 `inlineMaxBytes`（建议 256 KiB，写入
   schema 常量）的消息直接作为一帧发送：发送方在当前线程编码，接收方在当前线程解析，没有 open/begin/ready/ack/end 往返，
   也不经过 worker。
2. **大消息保持现状。** 超过阈值的消息走现有分块、确认、背压和 worker 解码路径。已知会携带大正文的请求（`agent_runtime.rs`
   里“typed body contracts”那组方法，如 `runtime.input.submit`）仍由 worker 编码；其他请求在主线程 stringify，超过阈值时把
   已编码的字节交给分块路径，不再重复编码。
3. **公平。** 写入方在流分块之间穿插内联帧（分块大小已受 socket high water mark 限制），大流不能让小消息排队。
4. **拆分窗口。** `requestWindow` 拆成两个概念：同时进行的大正文流（`streamCredits`，保持小值，如 4）和同时在途的请求数
   （上限只为防止资源耗尽，如 256）。Rust 内容 worker 线程数与它解耦，按 CPU 核数配置。保留现有嵌套 credit 测试证明的
   无死锁性质：Host→Rust 与 Rust→Host 的请求不共享 credit。
5. **流式进度。** `send_progress` 改用内联帧，背压改为等待有界的发送队列，不再等远端确认；Rust 侧“上一批未发出时合并增量”
   的逻辑保留。顺序由单一写入方保证。
6. **取消。** 内联请求到达即登记，取消帧语义不变。只为分块请求保留“正文到达前即可取消”的路径。

改 `kernel/protocol/schema.json` 后运行 `bun run kernel:protocol`。删除内联消息不再需要的握手分支与对应测试。
做成后：`test:kernel` 的 transport 与取消测试通过；小请求往返的 p50/p95 和每次调用的帧数按 P0 对比；
S2 中首 token 延迟与增量间隔不变差（预期更好）；大正文读取期间小请求的延迟不明显上升。

### P3 Catalog 并发读取与组合读取

1. **读连接池。** 新增只读的 Catalog 视图：独立的只读 SQLite 连接（WAL），共享 `ContentStore`（root 加 Arc，可廉价 clone）
   和其他 Arc 字段，不持有 `runtime.owner` 锁。池大小可配置（建议 4）。只读视图上的 `&self` 方法若意外写入，会得到
   `SQLITE_READONLY`，由测试暴露。组合读取在一个读事务内完成，保证快照一致。读事务保持短小，避免拖住 WAL checkpoint。
2. **只读方法分流。** 在 `schema.json` 给方法标注只读，生成 `KERNEL_READ_METHODS`；`agent_runtime.rs` 把这些方法派发到读池线程，
   写方法仍走 actor 和写连接。
3. **reap 离开请求路径。** 不再每个请求都 `reap()`。改为在 worker 结束通知、已有的 `AdvanceRuns` 唤醒中执行，活跃 worker
   存在时加一个低频定时器（如 200 ms）。先用 `git log -L` 和测试找出依赖“请求前已 reap”的写方法，只在这些方法前保留。
4. **只解码一次。** 删除 `validate_method_params` 的通用 schema 校验，参数直接 serde 解码成生成的类型；需要严格拒绝未知字段的
   类型加 `deny_unknown_fields`。相应删除只证明“二次校验存在”的测试。
5. **同步级别。** Catalog 和 kernel Storage 改为 `synchronous=NORMAL`。保留正文在引用提交前 `sync_all` 的顺序，
   断电不能留下指向缺失正文的引用。
6. **组合读取接口。**
   - `runtime.thread.view {threadId, branchId, historyLimit, afterHeadId?}`：在一个读事务内返回 snapshot 中所有 Catalog 部分：
     线程摘要、历史页（条目完整展开，含 model presentation）、inputs、活跃与历史引用的 operations、上下文 checkpoint 与 jobs
     及其 runs、本分支的 followups/goals、children 目录与 executions、子执行的 run/launch 状态、active run、run failure、launch、
     model selections、policy inspection。Host 的 `snapshot()` 只再补自己拥有的 recovery、creationDefaults、context policy。
     `afterHeadId` 给 P4 的增量更新使用：只返回该 head 之后的历史条目。
   - `runtime.thread.inspectMany {threadIds}`：供侧栏按变化批量刷新。
   - `runtime.ownership.resolve {threads, runs, operations, inputs}`：供 P1 的 resolver。
   - contextInspection 改为读池中的一次调用，Rust 侧缓存每个 branch 已扫描的 head。
7. **目录 N+1。** `list_thread_catalog` 改成一条带 join 或窗口函数的查询，取每个分支最新的 Run。内部线程（summary、memory、
   code_retrieval、context job）在创建时写入 `threads.hidden_kind`，不再每次 list 时对 operations body 做 `json_extract`
   和 `NOT EXISTS`。这需要 Catalog 格式 97→98：升级时按现有判定规则回填。

做成后：S1 打开会话的 IPC 次数达到目标；S2 中读请求的 Catalog 锁等待接近零（Rust 计数器）；300 个线程的 list 不再随线程数
发出逐线程查询；`test:rust` 与升级测试（97→98，含回填）通过；断电语义的说明更新到 runtime/resources 文档。

### P4 作用域事件与增量观察

1. **事件带作用域（Catalog 98→99）。** `events` 增加可空的 `thread_id`、`branch_id` 列和 `(thread_id, cursor)` 索引。
   `catalog.rs` 的 `event()` 是唯一的写入点：在写入时根据 subject 解析作用域，合并 `record_activity` 和 `SUBJECTS` 里现有的
   判定逻辑，形成一个解析函数。升级时用 `SUBJECTS` 映射回填。没有线程作用域的事件（如 `organization.changed`）列入显式的
   全局 kind 清单，测试断言“每个写入的 kind 要么有作用域，要么在清单里”。`events_after_for_principal` 改为对 threads 的简单 join。
2. **Host 事件中心。** 新增 `lib/kernel/event-hub.ts`：每个 Host 只有一个 Rust 事件读取者，由 durable 提示唤醒；保留最近一段
   事件的环形缓冲，供订阅者追平，落后超出缓冲时为该订阅者单独补读。订阅时带主体（用 P1 的 resolver 判断可见性）和可选的
   线程兴趣集合。`/api/threads/observe` 和 WebSocket 观察复用都接到它上面。进度事件只发给对该线程感兴趣的订阅者；
   持久事件对所有有权限的订阅者发送（体积小）。
3. **客户端单一事件总线。** `application-client` 提供每个 Host 一条连接的观察总线：`subscribe({threadId?, branchId?, kinds?}, listener)`，
   断线后按 cursor 重连；出现无法追平的缺口时，向订阅者发出 `resync`，各自做一次完整刷新，保证正确。第 1 节列出的
   所有 UI 订阅者迁移到总线，删除各自的 `api.observe` 循环。
4. **消费者按作用域增量更新。**
   - `ThreadProjection`：只处理本线程（含其子执行所在线程）的事件；合并后最多一个在途请求加一次补刷。追加历史用
     `thread.view` 的 `afterHeadId` 增量合并；分支切换、导航、fork、resync 时完整读取。`thread.read` 事件不触发快照。
   - `useThreadStore`：事件只把对应线程标脏，合并后一次 `inspectMany`，按 ID 打补丁；只在启动和 resync 时完整 list。
     新建、删除、归档事件同样按 ID 处理。
   - 组织树：只在 `organization.changed` 和影响排序或标签的线程事件上刷新，合并刷新，只重读已加载的窗口。
   - `thread-history.ts`：用量重读改为由相关 Run 的用量事件触发，不再以 eventCursor 为键。
   - 其余订阅者按各自需要的 kind 和作用域过滤。
5. **markRead。** 保留事件（多端未读需要它），但只更新该线程的未读状态；`ThreadConversation` 只在 `activity_cursor > read_cursor` 时调用。

做成后：S3 中被查看的会话 A 的读取次数为 0，侧栏没有全量 list，会话 B 通过 `inspectMany` 更新；S2 中 snapshot 读取次数约等于
本线程合并后的事件批次数；断线、Host 重启、kernel 重启后自动恢复（native 测试）；双主体下事件可见性测试通过；
体验边界 3–5 与这一包关系最大。

### P5 UI 渲染隔离

1. **流式状态独立。** `progress`、`streamingTools`、`toolProgress`、`progressActivity` 从 `ThreadConversation` 的 state 移到每个线程的
   外部 store（`useSyncExternalStore`），只由流式尾部组件读取。用 requestAnimationFrame 合并发布，每帧最多一次。
2. **快照结构共享。** 新快照与旧快照合并，未变的子对象（按 ID 的历史条目、operations、children 等）保持引用不变，
   让已 memo 的子组件跳过渲染。
3. **store 选择器。** `useConversationOrganization` 等返回整个 store 的 hook 改为按字段选择。

做成后：S2 中每个流式增量只渲染流式区域（React Profiler 或 P0 渲染计数）；输入框打字、滚动跟随不受流式影响；
流式显示的平滑度主观对比不变差。

### P6 残余清理

前面几包完成后，残余的防御代码可以按 [性能](../performance.md#成本与边界) 里的成本判断继续清理。计数器或 profile 能指出成本的
地方最值得动；明显的重复也是：同一请求里重复的检查、`catch(() => {})` 吞掉的错误、为不存在的旧格式保留的回退、
对同一进程产出的值再校验、只为证明“检查存在”的测试。写清删掉了什么、为什么安全，审阅会容易很多。

### P7 文档分层整理

`docs/` 加上模块 README/DOCUMENTATION 约 1.1 万行，其中相当一部分是会过期的现状描述、写死的数字和过程历史，
维护成本高，读的人也难分辨哪些仍然成立。已经出现了不一致：[架构](../architecture.md)写 Catalog `FORMAT` 为 96，
代码里是 97，同一篇后面的升级链又写到了 97。

思路是按变化速度给内容找位置，每层只放这个速度的东西：

| 层 | 适合放的内容 | 变化频率 |
| --- | --- | --- |
| [AGENTS.md](../../AGENTS.md) | 系统形状、真正的边界、成本模型 | 架构大改才变；已按这个标准写好，可作参照 |
| 领域文档 `docs/*.md` | 当前的合同、支持范围、取舍理由 | 随功能变 |
| 模块 README/DOCUMENTATION | 模块入口和不显然的约束 | 随模块变 |
| 代码、schema、测试、package.json | 格式号、版本、方法列表、常量、命令细节 | 随时变；文档链接过去，不抄写 |
| `docs/design/` | 一次性的设计与计划 | 做完并入领域文档后删除 |

可以从这些地方入手（举例，不是清单）：

- **数字与列表改链接。** 格式号、升级链、协议常量、窗口大小这类值，链到定义它的文件。架构文档里 Catalog/Storage
  版本和升级链那两段是现成的例子。
- **历史过程交给 Git。** 每一步升级做了什么、某次迁移的经过、已退役路径的细节，升级代码和提交记录里都有。
  文档留下仍然约束当前行为的理由。
- **代码引用用链接。** 目前约 990 处代码路径写在反引号里，`docs:check` 检查不到；写成 markdown 链接后，文件改名或删除
  会被检查发现。路径值得链接，函数名之类的符号不必强求。
- **同一事实只留一处。** 多处重复时，留在离 owner 最近的那份，其他地方链接过去。
- **流程细节归位。** 例如 [开发](../development.md)里“CI 责任与适用范围”等节，大量描述的是 workflow 实现，更适合放在
  workflow 或脚本旁边，开发文档只说去哪里看。
- **规则式的句子。** 不少“不得、必须、不能”是把某次实现决定写成了规则。按 AGENTS.md 的写法，改成事实和理由；
  真正的安全、数据和执行边界照常保留，说清为什么。
- **性能文档删掉的旧清单。** “既有优化”清单已从[性能](../performance.md)移除（原文见 `git show b914a1940:docs/performance.md`），
  其中仍有价值、模块文档里还没写的条目，可以补到对应模块文档。

和 P1–P5 的关系：观察、传输、Catalog、鉴权相关的段落（运行时文档的观察一节、架构文档的受理、执行与观察一节、
kernel README 的传输一节、Host adapters、THREADS）会被那几包改写，由它们落地时更新。P7 可以先整理其他部分，
这些段落留到对应包完成之后。`packages/docs` 是面向用户的站点，不在这一包里。

做成后：文档总量明显变小；大部分代码引用能被 `docs:check` 覆盖；文档里不再写死版本号和计数；同一事实只有一处描述；
读起来是在讲系统是什么、为什么这样，而不是流程和历史。[文档索引](../README.md)仍然准确。

## 4. 顺序与分工

```text
P0 ─┬─ P1（Host 鉴权，可与 P2/P3 并行）
    ├─ P2（传输协议，独立）
    └─ P3（Rust 读取，Catalog 格式 98）── P4（作用域事件，Catalog 格式 99；用到 P3 的组合读取）── P5 ── P6
P7（文档分层，不依赖 P0，可随时开始；P1–P5 会改的段落放到最后）
```

- P1、P2、P3 互不依赖，可以由不同 agent 并行；P2 与 P3 都改 `schema.json`，合并时重新生成协议即可。
- 两个 Catalog 格式号先分配好（P3 用 98，P4 用 99），避免并行分支撞号。
- 与 P0 基线的前后对比和体验指标，对审阅最有用；没跑的验证说清楚就好。
- 私有 wire 同构建发布，被替代的旧路径和只服务旧路径的测试一般可以直接删除，不需要兼容层或开关。
- P7 和性能各包同时进行时，同一篇文档可能被两边修改，按段落分开处理比较省事。

## 5. 收尾时更新的文档

[性能](../performance.md)（删除“进行中的整改”一节）、[架构](../architecture.md)的受理、执行与观察一节、
[运行时](../runtime.md)的观察与耐久说明、[kernel README](../../kernel/README.md) 的传输一节、
[Host adapters](../../packages/web/application-host/lib/kernel/DOCUMENTATION.md) 与
[THREADS](../../packages/web/application-host/lib/kernel/THREADS.md)、[UI 说明](../../packages/ui/DOCUMENTATION.md)。完成后删除本文。
