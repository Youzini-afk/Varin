# 决策分卷：工作状态、线程与集成

范围：3.4/3.4a/3.5/3.6/3.7/3.10 工作状态、Thread/Run 生命周期、Integration/恢复应用、P0 存储形状与 T 纵切。

本卷是 [decisions/README.md](README.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-024 · 2026-09-03 · 3.4–3.5
类型：偏离
决定：ThreadRecord 重设计 3.4/3.5 采用"host 持久化注册表 + protocol 事件 + bridge 服务方法"三层架构。(1) `ThreadRegistry`（`thread-registry.ts`）是唯一真相，JSON 持久化到 `PIARIUM_DATA_DIR/threads/<hostId>/<parentSessionId>.json`，内存缓存按 parentSessionId 分组。(2) Protocol 层新增 `harness.thread.changed` / `harness.thread.done` 两个 host 事件（只带状态子集，不带正文），以及 7 个 `HarnessServiceMap` 方法（`thread.dispatch` / `thread.list` / `thread.wait` / `thread.send` / `thread.read` / `thread.merge` / `thread.kill`）。(3) pi-host 的 7 个工具定义通过 `bridge.request` 调用这些服务方法，与 Phase 2 的 todo/recall 模式一致。
原因：(1) 线程状态必须归 host 而非任何一方的上下文——worker 退出后线程仍在跑，状态不能丢。(2) JSON 持久化比知识库 `session` 节点简单，且线程注册表是 per-parent 而非 per-workspace，知识库的 workspace 索引不适合。(3) `completeThread` 幂等设计（已 done 则返回同一记录）确保 `wait` / `read_thread` 多次读取报告字节相同。(4) hidden 线程（review 传感器、记忆 agent）不进父的 `threads` 列表但状态仍在注册表里。(5) `cancelAllForParent` 在父会话删除时批量取消所有运行中线程。
考虑过的替代：(1) 用知识库 `session` 节点存线程——查询复杂，且 `session` 节点是 per-session 而线程是 per-parent。(2) 在 worker-runtime.ts 里直接加 ThreadRecord——worker-runtime 是纯算法模块，不应承担持久化职责。(3) 让 pi-host 直接访问注册表——破坏 worker/host 边界。
影响：`packages/protocol/src/harness-threads.ts`（新文件，ThreadRecord + 7 服务方法类型）；`packages/protocol/src/harness.ts`（7 新 HarnessServiceMap 方法）；`packages/protocol/src/events.ts`（2 新 host 事件）；`packages/protocol/src/harness-tools.ts`（3 新 HARNESS_TOOL_META 条目）；`packages/web/application-host/lib/harness/thread-registry.ts`（新文件，405 行）；`packages/web/application-host/lib/harness/thread-registry.test.ts`（新文件，20 测试）；`packages/web/application-host/lib/harness/service-host.ts`（5 新字段）；`packages/web/application-host/lib/harness/harness-services.ts`（7 新 service factory）；`packages/pi-host/src/harness/thread-tools.ts`（新文件，7 工具定义）；`packages/pi-host/src/harness/select-tools.ts`（注册 7 线程工具）；`packages/pi-host/test/harness/phase3-e2e.test.ts`（新文件，6 e2e 测试）。
状态：已实施（worktree 管理、活性传感器 stalled/looping、观察游标、Zone 2 threads 段、Fleet provider 为 TODO。spawnSession/killSession/applyWorktreeDiff/sendToSession 当前为 mock，需接线到 broker 的 child session 机制。）

### D-026 · 2026-09-03 · 3.4–3.5（§9.3 redo）
类型：偏离
决定：3.4/3.5 线程系统按 §9.3 设计语义重做。D-024 的三层架构（host 持久化注册表 + protocol 事件 + bridge 服务方法）保留，但服务语义全面更新：
(1) **阻塞 wait**：`thread.wait` 不再是瞬时快照，而是通过 `subscribeToChanges` 订阅状态变更，阻塞直到有线程状态变化或超时。超时是正常结果（`timedOut: true`），不是错误。done 线程在 wait 结果中包含完整报告（conclusion / deviations / unresolved / confidence / traceHandle 引用）。
(2) **增量 threads**：`thread.list` 默认增量视图——只显示自上次观察游标以来有变化的线程。`full: true` 参数返回完整快照。无变化时返回 "no changes since last view; use wait to block instead of polling"。
(3) **观察游标**：`ThreadViewCursor`（eventSeq / status / progressVersion / decisionsCount / diffStats / viewedAt）存储在注册表中，按 `(observerSessionId, threadId)` 索引。`threads` / `wait` / `read_thread` 在返回前推进游标。`clearCursorsForSession` 在观察者会话结束时清理。
(4) **read_thread what 参数**：`what: "blocks"|"report"|"steps"` 替代旧的 `steps?` 布尔语义。"blocks"（默认）= 进度/决策/错误结构化摘要；"report" = 完整 ThreadReport；"steps" = 带 `since` 游标的 transcript 切片。`traceHandle` 在结果中返回供 get_output 拉取完整 trace。
(5) **dispatch 并发限制**：`maxConcurrency`（默认 12）限制每父会话的运行+排队线程数。超限时 `dispatch` 返回 `queued: true`，线程状态为 "queued"，不立即 spawn。`tryDequeue` 在运行线程完成时取出最旧的排队线程。
(6) **send 唤醒**：`thread.send` 在线程为 idle 或 waiting-for-input 时自动将状态改为 running 并清除 waitingFor。结果包含 `status` 字段。
(7) **eventSeq**：每个 ThreadRecord 有单调递增的 `eventSeq`，每次 `updateThread` 递增。用于增量视图判断是否有变化。
(8) **TTL 表**：`TtlTable` / `DEFAULT_TTL_TABLE` / `DEFAULT_WAIT_TIMEOUT_MS`（240s）定义在 protocol 层，供 wait 超时和未来 cache TTL 使用。
(9) **kill keepWorktree**：`thread.kill` 新增 `keepWorktree` 参数（默认 true）——半成品工作永不丢失。
原因：D-024 的实现是瞬时快照语义（wait 立即返回、threads 总是全量、read_thread 只有 report），不满足 §9.3 的"阻塞 wait + 增量视图 + 结构化 read"要求。重做后 wait 是真正的阻塞调用（减少轮询），threads 是增量视图（减少噪音），read_thread 按需返回 blocks/report/steps（减少上下文消耗）。
考虑过的替代：(1) 用 SSE/WebSocket 推送代替阻塞 wait——Pi 的 bridge 是请求-响应模型，不支持推送；阻塞 wait 是最接近的语义。(2) 在 worker 侧维护游标——破坏 worker/host 边界，worker 退出后游标丢失。(3) 用时间戳代替 eventSeq——时钟漂移可能导致增量视图漏判。
影响：`packages/protocol/src/harness-threads.ts`（ThreadListParams +ids/full、ThreadListResult +text/diffStats、ThreadWaitResult +timedOut、ThreadSendResult +status、ThreadReadParams what/since、ThreadReadResult +traceHandle、ThreadKillParams +keepWorktree、ThreadDispatchResult +queued、ThreadViewCursor、TtlTable、DEFAULT_TTL_TABLE、DEFAULT_WAIT_TIMEOUT_MS）；`packages/web/application-host/lib/harness/thread-registry.ts`（ThreadRecord +eventSeq、observer cursor store、subscribeToChanges、tryDequeue、maxConcurrency）；`packages/web/application-host/lib/harness/harness-services.ts`（dispatch 并发检查、threads 增量视图、wait 阻塞+订阅、send 唤醒、read_thread what、kill keepWorktree）；`packages/pi-host/src/harness/thread-tools.ts`（全部工具用 ctx.sessionManager.getSessionId()、新参数名 timeout_ms/keep_worktree/what/since/full/ids、promptGuidelines 按 §3.5 spec）；`packages/protocol/test/harness-threads.test.ts`（新文件，15 契约测试）；`packages/web/application-host/lib/harness/thread-registry.test.ts`（+7 新测试）；`packages/pi-host/test/harness/phase3-e2e.test.ts`（更新 3 测试）。
状态：已实施（transcript slice "steps" 当前返回占位文本——需要接线到 thread session 的 memory agent blocksSnapshot；progress/decisions/errors blocks 提取需要 memory agent 接线；spawnSession/killSession/applyWorktreeDiff/sendToSession 仍为 mock。这些在后续阶段填充。）

### D-028 · 2026-09-04 · 3.6 / 3.7 / 3b.1 / 2.6
类型：偏离
决定：验收整改，七项：

(1) **角色目录移到 protocol**。`roles.ts` 的静态部分（`RoleId` / `RoleDefinition` / `ROLE_DEFINITIONS` / `resolveRoles` / `buildTeamPrompt`）移入 `@piarium/protocol/harness-roles.ts`，web 的 `roles.ts` 改为 re-export。原因：`dispatch` 的团队提示与槽位校验必须发生在 worker 侧（冻结的会话设置在那里），而角色目录原先在 web 包里拿不到——上一轮因此把 `TEAM_PROMPT_GUIDELINES = ["team"]` 这个占位常量当成提示塞进了 `promptGuidelines`，真实会话的系统提示里会出现一行只写着 "team"。现在 `dispatch` 的 guidelines 由 `buildTeamPrompt(resolveRoles(...))` 生成，未配置槽位的角色既不出现在提示里也被工具拒绝（返回 `isError` + `unknown role`），不静默回退主模型（不变量 6）。`RoleDefinition` 新增 `teamDescription` 字段，让团队提示的措辞与 plan 3.6 的模板一致而不是从 `systemPromptFragment` 截句子。

(2) **`frontend` 角色回到自己的槽位**。原实现让 `frontend` 复用 `hardImplement` 槽位（因此未配置 `models.frontend` 也会出现在目录里），与设计 9.2.2 的表不符。改为 `slot: "frontend"`，未配置即不注册。`ModelSlotsSettings` 与 `SlotId` 改为复用 protocol 的 `HarnessModelRole`，两处槽位定义不再各写一份。

(3) **`isHighRisk` 统一**。protocol 版原先只认 `bash.command`，web 本地版认 write/edit 的 `path`。合并为一张表，每条带 `tools` 列表，覆盖 `bash`/`write_to_process` 的 command 与 `write`/`edit`/`apply_patch` 的 `path`/`file_path`；`defaultRules` 按同一张表生成 ask 规则。web 的 `permission-gate.ts` 改为纯 re-export。

(4) **高风险与 session-allow 的关系收紧，与 bypass 的关系放开**。判定顺序改为：`deny` → 阻断；`allow` → 放行（含 bypass 与用户显式写的规则）；`ask` → 若非高风险且已有本会话授权则放行，否则弹窗。这样"允许 bash 一整个会话"不会连带批准 `rm -rf`（高风险永不记入 session-allow），而 `bypass` 仍然是"别再问我"。上一轮的实现让 bypass 下的高风险也弹窗，比 plan 3b.1 的"bypass 全 allow"更保守，现已改回。

(5) **压缩接管的条件改为"存在记忆 keeper 写的块"**。原条件是"有任意块或任意 fact"，而生产里记忆 agent 为 null，唯一可能存在的块是 `todo` 写的 `plan`——只凭一张清单就跳过 Pi 的摘要，等于把整段对话换成待办列表。改为要求 `updatedBy === "memory-agent"` 的块；在 2.4 接线之前这等价于"永不接管，由 Pi 摘要"，这是安全的一侧。

(6) **`wait` 的超时进入契约，并加上限**。`HarnessRequestData` 新增 `timeoutMs?`（上一轮靠 spread 塞进事件、router 靠本地 cast 读出来，契约层看不见），router 用 `HARNESS_MAX_REQUEST_TIMEOUT_MS`（1 小时）夹住 worker 传来的值——worker 不该能把 host 的 handler 无限期钉住。同时发现并修了 `wait` 结果的一个缺口：`waiting-for-input` 的线程既不计入 done/running/queued 也不打印，"最常见的卡死其实是在等一个没人看见的确认"（设计 9.3.5）在结果里是隐形的。新增 `waiting` 计数与行渲染（`ThreadWaitResult.waiting`）。

(7) **review 传感器（3.7）移植而非删除**。上一轮因为它 import 了被删的 `WorkerRuntime` 就把模块和 5 个测试一起删了，理由记作"被 thread registry 取代"——不成立：传感器是 host 侧的触发器，注册表是它要调用的东西。已改为 `registry.createThread({ role: 'review', hidden: true, worktree: 'none', carryBlocks: false })`，并补一条测试断言它对父的 `threads` 列表不可见（设计 9.2.3）。`worker-runtime.ts` 的删除保留。

原因：以上除 (7) 外都是"参考形状在真实运行路径上不成立"的修正；(7) 是纠正一次误删。四条边界在这里被守住：未配置槽位不注册、高风险永远问、压缩不能凭清单接管、worker 不能支配 host 的时限。
考虑过的替代：(a) 角色目录留在 web、pi-host 复制一份——两处定义必然漂移，上一轮的 "team" 字面量就是这么来的。(b) 压缩接管条件按"块数 ≥ 2"之类的启发式——阈值没有依据，且 plan 明确记忆块归记忆 agent，按 `updatedBy` 判定是唯一有语义的条件。(c) `wait` 的 `waiting` 只在文本里体现、不进结果类型——工具的 details 是给 UI 渲染的，计数缺失会让面板也漏掉这一状态。
影响：`packages/protocol/src/harness-roles.ts`（新文件）；`packages/protocol/src/{index,harness,harness-settings,harness-threads,permission-gate}.ts`；`packages/pi-host/src/harness/{thread-tools,select-tools,permission-gate-extension}.ts`；`packages/pi-host/src/session-host.ts`（解析 resolvedRoles）；`packages/web/application-host/lib/harness/{roles,model-slots,permission-gate,review-sensor,thread-registry,harness-services,compaction,router}.ts`；测试：`packages/pi-host/test/harness/session-e2e.test.ts`（新文件，8 真 Pi 会话测试）、`phase3-e2e.test.ts`（+3 wait 测试）、`review-sensor.test.ts`（重写，6 测试）、`roles.test.ts`、`compaction.test.ts`（+2）。
状态：已实施

### D-032 · 2026-09-04 · 3.4–3.5（取代 D-024 与 D-026 的对象模型部分）
类型：偏离
决定：线程对象模型改为 **Thread + ThreadRun**，状态改为**正交维度**：

```ts
Thread {
  id; parent: { kind: "session" | "thread"; id: string }; workspaceId; brief; kind;
  lifecycle: "queued" | "active" | "settled" | "archived";
  attention: "none" | "user" | "permission" | "stalled" | "looping";   // 归 Thread：Run 崩了问题还在等
  integration: "none" | "dirty" | "merge-ready" | "conflict" | "merged"; // 归 Thread：worktree 比 Run 活得久
  worktree; report; activeRunId?; hidden; createdAt; updatedAt; eventSeq;
}
ThreadRun {
  id; threadId; attempt; runtimeId /* "pi" */; sessionId;
  workerState: "starting" | "running" | "lost" | "exited";
  outcome?: "success" | "failure" | "cancelled" | "lost"; exitReason?;
  tokens; costUsd; steps; lastToolCall; startedAt; endedAt?;
}
```

worker 崩溃 = 当前 Run 以 `outcome: lost` 结束，恢复 = 新建 `attempt + 1` 的 Run 并更新 `activeRunId`；不再在同一条记录上清 `workerLost` 改回 `running`。`resumeThread` / `markWorkerLost` 因此废弃。存储改为按工作区一个目录：`PIARIUM_DATA_DIR/threads/<hostId>/<workspaceId>/{threads,runs}.json`，带 `schemaVersion`；父会话只是 `parent` 边，不再是目录所有者。读取只吞 `ENOENT`，其余（JSON 损坏、EACCES、未来 schema 版本）抛出且不缓存，绝不用空表覆盖。host 启动时对账：所有 `workerState ∈ {starting, running}` 的 Run 标 `lost`（host 重启后 worker 一定不在），线程 `attention` 按是否有未答问题恢复。
原因：设计 9.3.1 原文把 worker-lost / stalled / looping 描述为横切标志、merged / archived 描述为终态之后，是实现把它们拍进一个 `status` 枚举；`sessionId` / `workerLost` / `tokens` / `exitReason` / `report` 已经是一次执行尝试的全部字段，只是没起名字。这个形状已落盘、已进 protocol 事件，等接真 child session 再拆，改的是有数据的持久格式。JSON catch-all 吞掉一切读取失败并在下次写入时用空表覆盖，直接违反不变量 3。
考虑过的替代：(a) 保持单一 ThreadRecord，接通 child session 后再迁移——持久格式、UI、事件、恢复路径都会先依赖错误结构。(b) 完整 Work Graph（Artifact / Relations / Checkout 对象）——没有消费者之前不建，留在设计 12.2 作目标形态。(c) SQLite——几十条记录单写者，版本化 JSON + 原子写 + 对账足够。
影响：`packages/protocol/src/harness-threads.ts`（`Thread` / `ThreadRun` 替代 `ThreadRecord`，事件载荷同步）；`packages/web/application-host/lib/harness/thread-registry.ts`（重写存储与 API）；`harness-services.ts`、`thread-tools.ts`、所有线程测试；设计 9.3.1 / 9.3.4 回写。
状态：待实施（P0 第 4 项）

### D-033 · 2026-09-04 · 3.5 / 9.2.6（取代 D-026 (8) 的默认超时部分）
类型：偏离
决定：`wait` **只因三种事件返回**：目标线程的状态变化（含 `attention` 翻转、Run 结束、报告就绪）、用户输入或中止（abort signal）、调用方显式给的 `timeout_ms`。不再有按 provider 缓存 TTL 推导的默认唤醒；`DEFAULT_WAIT_TIMEOUT_MS = 240_000` 废弃，默认上限即 router 的 `HARNESS_MAX_REQUEST_TIMEOUT_MS`。"按 TTL 唤醒以续缓存"降级为**默认关的实验开关** `harness.wait.cacheKeepaliveWake`，`DEFAULT_TTL_TABLE` 只作 telemetry。是否启用由回放集数据决定（D-037）。
原因：设计 9.2.6 的 0.7× 对 1.0× 只在 30 分钟任务、5 分钟 TTL、每次唤醒完全续上缓存时成立，超过约 10 个 TTL 周期就比一次冷启动贵；更重要的是每次唤醒都是一次行动机会，防轮询只靠一句提示词，而设计 9.1 自己的原则是"传感器优先于指南"。TTL 唤醒的第二个理由——顺便看到 stalled / looping——不需要 TTL：这两个标志由 host 传感器翻转，翻转就是真实状态变化，`wait` 本来就在那里醒。
考虑过的替代：保留 240s 默认——那事实上就是 TTL 唤醒，只是数字写死了。
影响：`packages/protocol/src/harness-threads.ts`（常量废弃）；`thread-tools.ts` / `harness-services.ts`（wait 默认超时）；设计 2 节决策表"长时间委派"行、9.2.6、12.2 回写。
状态：待实施（P0 第 4 项内一并改）

### D-039 · 2026-09-04 · P0.3–P0.4（线程 catalog 的原子存储形状）

类型：实现澄清

决定：D-032 的 `{threads,runs}.json` 概念形状落为**每 workspace 一个原子 catalog**：
`PIARIUM_DATA_DIR/threads/<hostId>/<sha256(workspaceId)>.json`，正文为
`{ schemaVersion, workspaceId, threads, runs }`。文件名用 workspace identity 的哈希，避免把外部 identity 当路径片段；Thread 与
ThreadRun 在同一次 temp-file + rename 中提交，避免两文件提交窗口。无版本的旧 parent 数组只有在 Host 已知
`(workspaceId, parentSessionId)` 关系时才导入，新 catalog 提交后保留旧文件，不猜 workspace、不静默删除。启动对账逐 catalog
报告 `corrupt / read-failed / future-schema`，健康 workspace 继续收敛；观察回调失败不能把已经落盘的提交伪装成失败。

原因：Thread 与 active Run 的变化是同一个逻辑提交；拆成两个文件需要额外 journal 或补偿协议，却没有带来读取或规模收益。
workspace id 当前通常是 UUID，但协议未来允许其他 runtime，持久路径不应依赖这一偶然格式。

考虑过的替代：(a) 两个 JSON 文件——存在一边 rename 成功、另一边失败的窗口。(b) SQLite——当前是单 Host、几十条记录，成本
高于收益。(c) 原样使用 workspaceId 作为文件名——把未来 adapter 提供的 identity 直接变成路径，不必要。

影响：`packages/web/application-host/lib/harness/thread-registry.ts`、`packages/protocol/src/harness-threads.ts`、设计 9.3.1、
architecture §5.1、plan P0.3–P0.4。

状态：已实施

### D-040 · 2026-09-04 · P0.5（输出句柄强度与旧报告迁移）

类型：实现澄清

决定：`OutputRef` 的 Host generation 与 HMAC 均采用 128 bit（32 hex），不是 plan 草稿里的 32 bit（8 hex）。句柄格式为
`out_<generation>_<sequence-base36>_<mac>`；HMAC 输入含 sessionId 与十进制 sequence，错误 session、伪造 MAC 与从未签发的未来
sequence 返回 `not-found`，旧 generation、FIFO 淘汰、dropSession、旧版 base32 handle 返回 `expired`。`dropSession` 不另建
无依据上限的墓碑集合，而是保留该会话的 `nextSequence / evictedThrough` 水位并清正文。

Thread catalog 因持久报告从 `traceHandle` 改为 `transcriptRef` 由 schema 1 升到 schema 2。schema 1 报告保留结论、文件、偏离与
blocks，转换为 `{ runtimeId: "pi", sessionId, fromEntryId: null, toEntryId: null }`；null 端点明确表示该会话当前分支首项 / 叶项。
读取 schema 1 本身不改盘，下一次真实 mutation 或启动对账需要写入时原子提交 schema 2；未来 schema 仍拒绝。

原因：32-bit MAC 在有错误 oracle 的长期 Host 中不适合作为不可伪造句柄；128-bit 不增加有意义的传输成本。单独墓碑集合迟早还要
猜一个淘汰上限，而单调 sequence 水位已经完整表达同一 Host generation 内的过期历史。旧 `traceHandle` 不能恢复原 entry 范围，
但 Pi session 文件仍是耐久真相，因此显式“全分支”比丢报告或伪造范围诚实。

影响：`packages/protocol/src/{harness,harness-threads,utf8}.ts`、Host `output-store.ts` / `thread-transcript.ts`、pi-host
`tool-result-truncation.ts` / `output-tools.ts`、thread catalog schema 2。

状态：已实施

### D-041 · 2026-09-04 · P0.6（批量规范路径租约）

类型：实现澄清

决定：D-036 的逐路径 `acquire` 落为一次 `fs.lock { action: "acquire", paths[] }`。Router 先让 Documents authority 为每条
路径产出 `{ authorityId, workspaceId, canonicalResourceId }`，Host service 再去重并按三元组全序获取；整批共享一个 30 秒
默认 deadline（显式 timeout 可覆盖），中途失败反向释放已得 lease。成功返回 `leaseIds[]`；release 请求只有 leaseId，Host
另外用 broker Actor 的 session owner 校验令牌归属。`apply_patch` 在执行任何一个文件操作前一次拿齐整批租约。

原因：让 worker 按原始路径逐个 acquire，即使每把锁本身正确，两个多文件调用仍可按相反顺序形成死锁；alias 还会让 worker
无法自行稳定排序。规范化只能由握有 Documents identity 的 Host 做，因此批量请求是让“去重 + 全序”成为真实协议保证的最小形状。

考虑过的替代：(a) worker 对原始字符串排序——Windows 大小写、`..`、符号链接和 alias 会得到不同顺序。(b) Host 提供先
canonicalize 再逐个 acquire 两步——在两步之间引入新竞态，协议也更吵。(c) OS / 跨进程锁——当前威胁模型只要求同一
Application Host 内 Harness 管理的写入互斥，不能借此声称管住终端、Git 或外部程序。

影响：protocol `FsLockParams/FsLockResult`、Host `path-authority.ts` / `path-lock.ts` / `harness-services.ts`、pi-host
`path-lock.ts` / `apply-patch-tool.ts`。

状态：已实施

### D-042 · 2026-09-04 · P0.2（静态 capability 取实际工具集）

类型：实现澄清

决定：RunManifest 尚未落地时，Host capability 从 broker 验证后的 `session.snapshot.activeTools` 与 Host 服务可用性推导，
而不是从 `HarnessSettings.tools.*` 的覆盖开关直接推导。`tools.bash = false` 当前语义是“不注册 Piarium 同名覆盖、回退 Pi 内置
bash”，因此实际 `activeTools` 仍有 bash 时必须保留 `process.shell`；只有会话真实没有 bash 才拒绝 `shell.*`。同理，
`write.document` 在 active tools 含 `write`、`edit` 或 `apply_patch` 任一项时授予，因为三者都会使用 Host 路径租约。

原因：把“关闭某个实现”误读成“撤销整个风险类别”会让内置 fallback 仍可写文件，却被 Host 拒绝其 mutation lease，最终表现为
普通 edit/write 全部失败。能力必须描述当前 Run 实际能做什么，不是某个 UI toggle 的字面值。

影响：`service-host.ts::deriveHarnessCapabilities`、设计 9.1.2、RunManifest 后续契约。

状态：已实施

### D-043 · 2026-09-04 · T1（真实 Pi child 线程纵切）

类型：实现澄清

决定：(1) Application Host 通过私有握手的 `harnessThreads` 能力声明真实线程运行时，删除用户设置里的临时
`threadRuntime`；没有该能力时 pi-host 不注册七个线程工具。(2) `dispatch` 先原子写入 Thread + `starting` Run 后立即返回，
worktree 与 Pi child session 在后台创建。(3) Thread catalog schema 4 新增不可变 `ThreadLaunchManifest { tools, worktree, scope,
systemPromptFragment, concurrency }`，resolved model 也随 Thread 持久化；`session.create/open` 在构造 AgentSession 前接收模型和工具 allowlist，
因此角色工具边界不是提示词。(4) T1 保持基础 system/Zone 0 不变，把角色片段、scope 与 brief 放首条任务消息；子 allowlist 不含
`dispatch`，嵌套留待独立纵切。(5) isolated worktree 在父 dirty 状态上建立内部 baseline commit，merge 只应用 child delta；未跟踪
碰撞先预检，冲突结果区分 Git markers 与 parent-unchanged。(6) 第一次意外 worker 退出在同会话/worktree 开新 Run；连续第二次
崩溃翻 `stalled`，不形成无限重启。无事件 300 秒只告警，连续 6 次相同工具+参数哈希翻 `looping`；交互请求投影为
`user/permission` attention。(7) 同一 registry 投影到七个工具、`piarium-harness` Fleet provider、SSE 与父会话最小桌面侧栏。
(8) broker 删除父会话前调用 Application Host coordinator；它在 registry 的 draining 区间停止 active child、取消 queued/active
Run，并归档全部直接子线程，之后才允许删除 Pi session 文件。若用户直接删除 child session，registry 归档其 Thread 并清除指向
即将删除文件的 report/TranscriptRef，不留下“可读”假引用；历史 Run outcome 不被改写。

原因：如果工具先按默认模型构造、之后再切角色模型，provider 专属工具会错配；如果角色工具只写在提示词里，`check/review`
仍能拿到写工具；如果 dispatch 等待 worktree 与 worker，创建体验会重现此前新会话长时间“正在发送”的问题；如果崩溃无恢复，
ThreadRun 只是日志，若无限恢复又会制造进程崩溃循环。内部 baseline commit 则解决父 dirty patch 被合并两次的确定性错误。

考虑过的替代：(a) 继续用 `HarnessSettings.threadRuntime`——Host 缺服务时会暴露只返回 unavailable 的工具。(b) child 创建后再
`model.select`——工具注册已经完成，太晚。(c) 只靠角色提示词约束——不是能力边界。(d) 每次崩溃都自动恢复——同一损坏会无限
拉起进程。(e) 合并前直接复制 untracked——会在发现后一个冲突前留下部分写入。

影响：protocol `HostHandshakeParams` / `session.create/open` / `ThreadLaunchManifest`（thread catalog schema 4）；runtime-broker launch
投影；pi-host SessionHost、角色工具与 Fleet adapter；Host `thread-runtime.ts` / `thread-worktree.ts` / registry / route；UI
`HarnessThreadsPanel` 与 SSE。尚未包含：scope 的 Host 强制、Zone 2 threads 段、worktree/branch 回收、窄屏与讨论线。

状态：已实施

### D-053 · 2026-09-04 · 3.4（原生线程进入父会话 Zone 2）

类型：实现澄清

决定：(1) `zone2.assemble` 在知识/编辑材料之外，从同一 Host 的 `ThreadRegistry` 投影线程：queued/active（含 waiting、stalled、
looping）每个父回合都作为事实快照出现；settled/archived 仅在该观察者尚未见过其最新 `eventSeq` 时出现，完成结论、偏离与 diff
随该行交付。(2) Zone 2 使用独立的 `zone2-threads` 观察游标，不推进 `threads`/`wait` 工具的游标；压缩和会话结束沿 D-052 一起
重置。(3) child session 通过持久 Run 的 sessionId 反查所属 Thread，嵌套线程以 `{kind: thread, id}` 为父，不错误投到根会话。
(4) Thread 与 active Run 由注册表一次 catalog 快照读取，避免状态转换期间拼出不一致组合。(5) 不新增固定 `zone2Max` 数量限制；
行按现有 Zone 2 总 token 预算动态保留，优先 waiting/stalled/active/conflict，余项折成一行并提示用 `threads` 查看。(6) 注册表读取
失败投影为显式 `<threads status="unavailable">`，不把损坏/权限错误当作“没有线程”。

原因：线程运行时、侧栏和主动工具已经进入生产链，但父 agent 不调用 `wait` 时完全看不到完成或等输入事件。每轮全量重复所有历史
线程又会持续污染上下文。活跃快照 + 终态增量同时满足监督和低重复；预算来自 Zone 2 已有资源边界，比再猜一个固定条数更符合真实
上下文容量。

影响：Host `zone2-threads.ts`、ThreadRegistry atomic snapshot/session lookup、Zone2 material/formatter、3.9 observation store；phase3 E2E；
plan/status 3.4/3.5。

状态：已实施

### D-055 · 2026-09-04 · 3.4（父 blocks 快照与可核验 ThreadReport）

类型：实现澄清

决定：(1) Thread spawn 在创建 child session 前读取父 Pi session 的当前 blocks；非空块以 `<parent-blocks>` 数据段加入初始任务，
明确这是 dispatch 时快照且父可能已前进。空与 unavailable 分开标记；读取失败记 Host error 但不阻止子会话。(2) 初始任务要求最终回答使用
`Conclusion` / `Deviations from brief` / `Unresolved issues` 三个标题。Host 只保守解析这三个受控标题，不从普通散文猜状态；没有结构时
整段仍作为 conclusion。(3) settle 同时读取 child blocks，完整复制为 `blocksSnapshot`；`decisions` 中显式
`Deviation: ...` 与最终回答的 deviation 合并去重。读取失败或 store unavailable 写入 report.unresolved，不伪装为空。(4) metrics、
transcript bounds、worktree diff、blocks 与结构化最终回答收齐后，仍通过 ThreadRegistry 的同一次 `endRun` 原子提交 report 与 Run 终态。

原因：此前 child 启动只拿任务文本，报告又把 `deviations` 和 `blocksSnapshot` 永久写成空值；`read_thread(blocks)` 与 Zone 2 完成行
因此看似结构化，实际没有数据。受控标题与显式 block 标记比对任意自然语言做启发式抽取可靠，同时在 memory shadow 默认关闭时仍能
从最终回答得到报告。

影响：ThreadRuntime session adapter、Application Host knowledge store wiring、真实 Pi child E2E、read_thread/Zone 2 已有消费者；
设计 9.2.5 / 9.3.5，plan/status 3.4。

状态：已实施

### D-056 · 2026-09-04 · 3.6（删除休眠且无依据的 role budget）

类型：设计修正

决定：从 `RoleDefinition` 删除 `budget.maxTurns/maxTokens` 以及六组固定数字。角色继续冻结模型、工具、worktree 和提示片段；Run 继续
记录真实 steps/tokens/cost 并由 Fleet/报告展示。当前不增加自动停止、降级或排队策略。未来若用户显式要求预算，或 T4 同模型回放给出
可定标的分布，再单独设计“用户策略/默认值/告警/硬边界”中的正确层级和 Pi child 执行原语，不能复活仅存在于 catalog 的假字段。

原因：全仓只有定义和“数字大于零”测试，没有生产读取点；Pi child 的一次 Run 也没有 per-role turn/token enforcement。现有
10/15/20/40/50 turns 与 30K–200K tokens 没有协议上限、基础设施数据或回放依据。把它们接成硬拒绝会截断正常长任务，保留则让
状态矩阵长期误报一个不存在的能力，均不如删除。

影响：protocol `harness-roles.ts`、roles tests、plan 3.6、status 3.4/3.5。并发 12 是独立的 Host 背压机制，不受本决定影响。

状态：已实施

### D-057 · 2026-09-04 · 3.4（结果分支先耐久化，live worktree 暂不自动删除）

类型：设计修正

决定：(1) isolated worktree 创建时把内部 `piarium/thread-*` branch 写入持久 `ThreadWorktree`；settle 时将 child 的 staged、tracked 与
untracked 最终状态用 `--no-verify --no-gpg-sign` 提交为内部 result commit，并记录 `resultCommit`。merge 前再次 snapshot，确保等待期间
的新改动也进入分支；snapshot 失败则 merge 不开始，worktree 保留。(2) `base → resultCommit/working tree` 仍是 child delta，既有
plain apply → `--3way` 和 untracked 预检不变。(3) merge 成功暂不自动删除 live worktree，也不启动“默认 7 天”分支计时器；当前线程
侧栏重新打开完整 child session 仍依赖该 cwd，删除会导致打不开，或更危险地把后续对话重定向到父工作区。(4) 真正回收要与“从持久
transcript 只读打开”或显式归档/rehome 同批交付；届时 result commit 是删除前可验证的恢复锚点。没有用户策略或磁盘数据前不猜期限。
(5) registry 已是 `merged` 时再次调用 merge 返回明确 no-op，不重放 patch。
(6) result commit 中相对 base 新增的路径继续走 new-file 预检并从 tracked patch 排除；同路径不同内容时父树保持零写入。复制相对
symlink 时保留 link，自 child worktree 指出的绝对 symlink 不复制，避免父树依赖将来会回收的 child 路径。

原因：旧文档说 merge 后删目录、留分支，但旧分支只有父工作区 baseline，child 结果完全未提交，直接删除会丢唯一独立副本；补上
提交后，又发现 UI 的 thread open 仍使用 `thread.worktree.path`。所以本轮先消除数据丢失前提，不用磁盘回收换取会话生命周期回归。

影响：protocol `ThreadWorktree.branch/resultCommit`（向后兼容可选字段）、ThreadRegistry parser、ThreadWorktreeRuntime snapshot、
ThreadRuntime settle/merge、真实 Git tests；设计 9.2.5b / 9.3.4、plan/status 3.4。

状态：已实施（结果耐久化）；目录/分支回收仍待产品纵切

### D-062 · 2026-09-04 · 3.10（窄屏 session state overlay）

类型：实现澄清

决定：`HarnessThreadsPanel` 的数据加载、SSE 订阅、draft/conflict 状态和 action handlers 保持单实例；`xl` 及以上渲染原右 rail，
更窄窗口在聊天右上显示带实时 item count 的 session state 按钮，打开项目既有 `MobileOverlayPanel`，内部复用同一份
knowledge review / blocks / threads 内容。无任何内容时 rail、按钮、overlay 都不渲染；切换会话时清数据并关闭 overlay。聊天根容器成为
positioning context，按钮不会相对整个应用漂移。移动端没有第二套 store、route 或轮询。

原因：旧 `<aside class="hidden ... xl:flex">` 让普通窄窗口、平板和手机完全无法处理 waiting thread、block 冲突或知识审阅；仅做响应式
样式而没有入口仍不可达。复用现有 overlay 保留项目统一的焦点、关闭和滚动行为。

影响：UI `HarnessThreadsPanel`、`HarnessSessionStateTrigger`、PiChatView positioning、10 locale；plan/status 3.10。

状态：已实施并 proven（响应式触发器 SSR + 既有 panel/overlay 生产链）

### D-063 · 2026-09-05 · 3.10（用户讨论线与同会话转实现）

类型：实现澄清

决定：(1) 时间线只在已持久化且有文本的 user/assistant message 上显示“从这里开一条线”；菜单默认携父 blocks，也提供显式不携带
入口。创建走鉴权的 session-scoped Host route，UI 不提交 workspace 或 parent 身份；Host 从 broker session snapshot 和 registry
反查权威 workspace/父边，并要求 fork point 仍在活动分支。(2) 讨论线只从父会话**实际活跃**的工具里取
`read/grep/find/ls/glob/explore/related/recall/webfetch/websearch` 交集，`worktree:none`；`carryBlocks` 加入冻结的
`ThreadLaunchManifest`，catalog schema 5 将旧 schema 4 明确迁为历史默认 `true`。(3) 讨论线每次 `agent_settled` 只刷新 Run metrics 并
标为等待用户，不生成终态 report、不关闭 worker；空闲讨论不占 implementation dispatch 的并发槽。(4) 用户转实现前要求当前回答已结束，
从父会话当前真实 active tools 中去掉线程控制工具并确认至少有一种 mutation 工具；创建 isolated worktree 后，旧讨论 Run 以
`converted to implementation` 成功结束，新 Run 沿用同一个 sessionId。worker 必须 close/open 才能在 AgentSession 构造边界切换 cwd 与
tool allowlist；随后自动发送转换说明并按普通实现线结算。(5) conversion 的新 Run 在落盘时已经带原 sessionId，Host 若在
registry commit、worker reopen 之间崩溃，现有 lost-Run 对账仍能从同一 transcript 恢复。

原因：只在 UI 增加按钮会立刻撞上两个事实：原 ThreadRuntime 把第一次 `agent_settled` 当整个线程完成并关闭，而已有 worker 的
`session.open` 不会重建工具 allowlist。前者让讨论线无法继续说话，后者会让“转实现”只改标签却仍拿不到写工具。把转换定义为同一
Thread/session 上的新 Run，既保留对话，又让一次执行尝试和一次能力边界对应；session-scoped route 则避免重新引入由 UI 自报
workspace/parent 的身份问题。

考虑过的替代：(a) 复制父完整对话——违背 blocks + brief 的低污染上下文设计；fork point 只记录来源并把该消息作为明确 data prompt。
(b) 讨论回答后直接 settle，再靠 resume 续聊——会伪造多个“崩溃恢复”并产生终态报告。(c) 在现有 worker 上改 manifest——Pi 工具在
AgentSession 构造时冻结，registry 与实际能力会分叉。(d) 给讨论线沿用父全部工具、只靠提示词说别写——不是能力边界。(e) 转换时
另建 session——对话不再延续。

影响：protocol `ThreadLaunchManifest`；Thread catalog schema 5；Host ThreadRuntime/registry/session-scoped routes 与真实 Pi E2E；UI
timeline action、session state conversion、10 locale；设计 9.3.2、plan/status 3.10、architecture 5.2。

状态：已实施并 proven（真实 Pi faux-provider 纵切；时间线线程卡片与归档/恢复 UI 仍待实现）

### D-064 · 2026-09-05 · 3.10（时间线线程标记复用 session feed）

类型：实现澄清

决定：把线程 GET、SSE scope 与 eventSeq 合并从 `HarnessThreadsPanel` 提取为会话级 React provider；右 rail、窄屏 overlay 与父时间线
都消费这一个内存投影。每个带 `forkPoint` 的线程在来源消息下显示紧凑状态标记，点击沿冻结的 model/tools/scope 和记录的 worktree
打开 child session。旧事件不能覆盖较新的 `eventSeq`，archived/hidden 不进入活动投影。时间线本身不发第二次请求、不建轮询器，
也不复制 thread action 状态。

原因：若时间线另建 store 或独立 fetch/SSE，用户会看到侧栏已完成而消息卡仍运行，且 D-062 的单实例约束失效；若只在创建成功时
向时间线塞临时卡，刷新后即丢。会话级 provider 让所有表面共享 Host registry 的同一投影，同时不把 blocks/knowledge 的独立数据
所有权混入线程状态。

影响：UI `HarnessThreadState`、`HarnessThreadMarkers`、`HarnessThreadsPanel`、`PiChatView` 与 timeline SSR；plan/status 3.10。

状态：已实施并 proven（SSR + eventSeq/fork-point 单测；归档/恢复 UI 仍待）

### D-077 · 2026-09-05 · 3.4（worktree 生命周期：setup 命令、目录即缓存、磁盘预算；取代 D-057 的"暂不回收"）

类型：偏离

决定：isolated worktree 的生命周期由三件确定性的事组成，一起交付、缺一不可；闲置计时器只作兜底。

(1) **setup 命令。** `git worktree add` + 父的 diff 与未跟踪文件给出的是源码不是环境：被 `.gitignore` 忽略的 `node_modules` /
`target` / `.venv` / `.env*` 全不会过去，`check` 与并行实现者在里面什么都跑不起来。每工作区一条**用户在 Settings 显式写下**的
`harness.worktree.setup`，worktree 就位后、Run 启动前以 login shell 执行，超时（可配置默认，首版 600 s）或非零退出 → 线程
`outcome: failure` / `exitReason: setup-failed`、输出进 `OutputRef`，不带着坏环境开跑；**只对 `tools` 含 `bash` 的角色按需跑**；
命令须幂等。被忽略文件复制走白名单 `harness.worktree.copyIgnored`（默认空，`.env*` 常含凭据）；依赖共享 `shareDependencies`
（symlink / junction）是显式选项默认关。setup 在用户机器上执行任意命令，属 plan 0.1 暂停类别，本条即其决策：**不从仓库文件推断、
不猜默认，用户配置是唯一来源**。

(2) **目录是缓存，回收发生在边界。** D-057 已让 settle / merge 前把结果提交到 `piarium/<threadId>` 分支；结果一旦在分支且目录里
没有活跃 Run，目录就是冗余的，可用 `git worktree add <原路径> piarium/<threadId>` **在同一路径重建**——重开 child session 的 cwd
不变，D-057 不敢删目录的顾虑由此解除。回收触发点：merge 成功（立即）、cancelled / failed / 用户归档（先快照再回收）、Run 结束后
idle 且无打开会话（`reclaimIdle` 默认 true）。硬前置条件：快照后 `status --porcelain` 为空、无 `starting | running` 的 Run、路径
在 worktree 根之内；任一不满足不删并报 `{ reclaimed: false, reason }`。`ThreadWorktree` 加 `materialized` 字段；`materialize()`
在重开或新建 Run 前重建并按需重跑 setup。

(3) **磁盘预算，超出显式拒绝。** 每工作区 `harness.worktree.budget`（首版 `{ maxBytes: 8 GiB, minFreeRatio: 0.1 }` 取更严者，
experimental），`prepare` 前累计已物化 worktree 占用；超出则 `dispatch` 返回 `unavailable`，文本含个数、总量与可释放候选。不因预算
杀正在跑的线程。这是不变量 3 的磁盘版：把"磁盘被悄悄吃满"变成显式、可行动的失败。

(4) **兜底与对账。** 启动时每工作区 `git worktree prune`，注册表与目录比对：满足前置条件的按 `reclaimIdle` 处理，注册表外的目录标
`orphan` 报给用户不自动删；`branchRetentionDays`（首版 30，experimental）只作用于已回收目录的分支。可见性：线程面板显示
`materialized` 与占用、总量与预算，≥ 80% 时父的 Zone 2 一行，"立即回收"动作。

(5) **写明 index 影响。** 普通 `apply` 不碰 index；退到 `--3way` 且冲突时 Git 会写 unmerged 条目进用户 index，工具文本与 Git 面板
如实说明。合并成功不等于合并后父树通过验证；团队提示要求父合并后自己验证。

原因：D-057 把"暂不自动删除 live worktree"当成安全侧，理由是重开 child session 依赖 cwd——但同路径重建解决了这一点，而"暂不删"
的代价是确定会发生的：并发 12、每个 worktree 装完依赖几百 MB 到几 GB，几天就把用户磁盘填满，远等不到任何"闲置 N 天"。把回收
寄托在计时器上等于把用户磁盘当缓冲区。同时 setup 命令会让每个 worktree 显著变贵，所以它和回收、预算必须同批交付——只加 setup
不加回收，是加速填满磁盘。

考虑过的替代：(a) 只靠闲置计时器——磁盘先满；(b) symlink `node_modules` 作默认——bun hoisting 与平台原生模块不稳，只作显式选项；
(c) 从仓库的 `package.json` / CI 配置推断 setup 命令——在用户机器上执行推断出来的任意命令，违反 0.1 暂停类别的精神；(d) 保留目录、
只做预算——预算会很快命中，然后所有 isolated 派发都被拒绝。

影响：`agent-harness.md` 决策表"线程"行、9.2.5b、9.3.4；`agent-harness-plan.md` 3.4（worktree 生命周期项、测试清单）；protocol
`ThreadWorktree.materialized`、`HarnessSettings.worktree.*`；`thread-worktree.ts`（setup / reclaim / materialize / budget）、
`thread-runtime`、线程面板；status 3.4/3.5 Blocker 列。D-057 在索引标 superseded in part（"暂不回收"部分）。

状态：待实施（T1 硬化；三件一起交付）

### D-079 · 2026-09-05 · 修复工作状态、集成恢复与检索正文的真实调用链

类型：实现修正（D-078 范围内）

决定：保留既有 Thread/Run 和正式原生工作状态方向，替换 a08fbdd5/9b07c9be 中只有表面接线的实现。工作状态通过 recovery engine
提供的可信 storage 访问取得当前实际存储位置、catalog、对象捕获与 workspace queue/lease；基线、结果和未完成集成各自登记引用，
删除恢复历史不得删除它们。操作记录不再同时依赖 workspace 根目录猜测数据库和 best-effort JSON，写前保存真实内容对象与操作阶段。

集成比较实际基线与选定子结果，只处理其变化路径；原始父内容、子内容和恢复内容按哈希读取，不按字节数或文件种类猜相等。Git
和非 Git 使用同一结果/集成语义；非 Git 修订原子发布，重建/第二次捕获不能改变旧结果。默认逐路径集成不修改用户暂存区，不沿
git apply --3way 产生额外 index 改动；已有用户 index 保持其自身状态。漂移、正常冲突、意外失败和重启后的条件恢复分别记录。
这些检查协调受控调用，并不承诺对任意同用户外部进程提供 OS 原子比较交换。
集成的最终比较、写入和补偿与同一 DocumentAuthority 实例的 Documents 读写/移动/删除共用规范路径资源队列；目录操作覆盖子树，
无关路径仍可并行。Harness 路径租约、直接 fs/命令写入与其他 Host 实例的范围单独保持，不能把共享资源队列写成全部进程隔离。
同一结果重试在父相关路径状态仍等于首次输出时复用原冲突操作，不再次写入标记，也不把旧操作的写入数算作本次新写入。

补齐最终操作提交与父回合 checkpoint 的同事务绑定，避免“磁盘已合并、恢复历史没有这次变化”。日志阶段或最终提交失败必须进入
条件补偿；未完成操作先恢复再计算新计划，不能先算 no-op 后回滚旧结果。重启只对当前工作区记录操作对应目录；显式删除恢复历史
清除已完成 Integration 的恢复材料，保留工作分支/结果和仍待处理操作。文本合并按真实重叠区间与独立 mode 三方分类，无效 UTF-8
按不透明内容处理；不可应用的符号链接权限不作为伪造的目标身份。

setup 读取父 Pi 会话实际配置与 projectTrusted，不由 Host 绕过信任直接执行项目配置。目录删除期间持有现有 Documents 写入屏障，
活跃进程和编辑器使用者保留目录；shell 注册写入者失败不得继续执行未登记命令。

检索正文经 Documents 与 Host actor 路径 authority 读取，返回实际磁盘 revision/range。读取失败或搜索后内容变化不得回到
“扩展行号加单行命中”的假片段；可用结果与具体缺口一起返回，全部不可读则明确不可用。确定性检索不保留未接线的 Host 模型、
向量和 PageRank 桩；问题词项使用实际搜索、排序与当前片段，取消和多个请求路径贯通，不新增固定工具输出条数上限。

原因：真实复现确认了父新增文件被当作子删除、空 hash 漏掉内容修改、选旧结果读到新 snapshot、恢复只比 kind 删除用户内容、
Git 协调器立即 fallback，以及检索读取失败仍声明连续正文。单测总数和“已构造对象”不能证明这些行为成立。

影响：Host working-state/thread/recovery、index 生产装配、相关 protocol/Pi 工具、explore 服务和 Documents reader；更新 status
只记录实际调用与验证。窗口草稿/无目录工具等未接面按事实保留待做，不再以 helper 的存在标为交付。

状态：方案已采用并进入实现；最终交付证据见 status.md。

### D-083 · 2026-09-06 · thread.dispatch 持久草稿基线与 surface 集成边界

类型：实现决策（D-078 工作状态、D-082 窗口来源的线程纵切）

决定：`thread.dispatch` 在创建 Thread 之前，同步从 D-082 的不透明 surface snapshot 克隆完整 dirty 集合，并把将来保存会产生的
UTF-8 字节（含 BOM 与原换行）、磁盘 baseRevision、surface localEditRevision 和固定 snapshot revision 写入 WorkingState 的
内容对象与 draft-baseline manifest。它不把临时 snapshot ref 当作 queued Thread 的恢复权威，也不把正文放进 Thread catalog、broker
事件或模型参数。WorkingState catalog 升至 schema 2；Thread catalog 升至 schema 7，`ThreadLaunchManifest.draftBaselineId` 是不可变
launch input，旧 schema 明确迁移为 `null`。Thread 创建失败释放刚建立的 draft baseline；Thread 已创建后该对象随工作保留。

带 dirty baseline 的角色统一使用 isolated worktree，包括通常为 shared/none 的角色。snapshot unavailable、过期、session/workspace 或
完整 dirty path 集不匹配时 dispatch 失败，不创建一个读取磁盘却声称继承窗口状态的 Thread；已验证为空的 surface 保留角色原来的
worktree 策略。正文已复制后，surface snapshot 可正常被下一次输入替换或随 Host 生命周期释放，queued、首次启动与无 session id 的
lost 恢复只依赖持久 baseline id。

Run 首次启动先由现有 Git/copy 后端准备磁盘目录和显式 ignored 输入，再把 draft baseline 叠到相同目录。叠加后的有效路径状态直接
成为 WorkingBranch `baseState`，`headRevision = 0`、`deltas = {}`，`draftBasePaths` 记录来源范围；草稿是父输入，不是子结果。
因此子未修改草稿时结果不含该路径；发布 live 结果时即使 Git 忽略该文件也必须比较所有 draftBasePaths。运行中结果采集明确读取
materialized live 目录，merge 的旧 Git/copy 兼容入口默认读取已选 fixed result，已有 resultCommit/resultPath 不得遮蔽恢复后继续产生的修改。

集成只处理子相对有效基线真正改变的路径。对 draftBasePaths：父磁盘等于子结果时 no-op；父磁盘等于固定草稿基线时可按普通计划应用；
父磁盘同时不同于二者时返回可识别的 `surfaceTargetPaths` 冲突，该路径不生成 target、不写磁盘、不放冲突标记。当前尚无把结果写回
原编辑器缓冲的 Host→surface 操作，因此用户先在父编辑器保存或协调草稿后重试；这项明确的零写入冲突替代把未保存输入偷偷落盘。

边界：非草稿文件仍以 Run 物化时的目录为基线，本决定不声称整个工作区在 dispatch 时固定。Pi 原生 `read`、现有 `grep` 与父工作区
LSP 尚未直接读取 WorkingState 虚拟视图；隔离线程通过真实物化目录获得一致内容。surface buffer 写回/grouped undo、无目录工具、
完整物化预算和归档释放继续按 3.2/3.4/3.5 实施。

原因：持久复制发生在 snapshot 仍可读的 dispatch 请求内，既消除排队/重启对 Host 内存引用的依赖，也保持 surface 是可变编辑缓冲的
唯一所有者。把草稿放进 branch base 让结果、三方合并和 ignored 路径都使用同一个父输入身份；若把它发布成 revision 1 delta，未修改
草稿会被误报为子工作并可能在 merge 时写回磁盘。live/fixed 读取模式分开则同时满足半成品恢复和固定结果消费。

影响：protocol `ThreadLaunchManifest` / `ThreadMergeResult`；UI Documents capture 与 application-client 类型；Application Host
SurfaceSnapshotStore、ThreadRegistry、Thread services/runtime/worktree、WorkingState store/materializer/IntegrationCoordinator；
设计 6.1/9.2.5b/9.3、plan 0.7/3.2/3.4/3.5、status、architecture 与模块文档。

状态：已实施；本地证据和当前未接边界见 status.md。

### D-084 · 2026-09-06 · copyIgnored 成为持久结果捕获范围

类型：实现决策（D-078 工作状态/物化边界的收口）

决定：`harness.worktree.copyIgnored` 在首次 Run 准备并捕获基线时规范化为工作区相对根，写入 WorkingBranch `captureScopes`；
WorkingState catalog 升为 schema 3。schema 1 迁移为空 draft/capture 范围，schema 2 保留 draft baselines 与 draftBasePaths、
captureScopes 为空，schema 3 严格要求该字段。已有 branch 恢复使用持久范围，不重新解释后来变化的 settings。

窄结果发布把后端 changed paths、草稿结构闭包与 captureScopes 合并。每个 capture scope 只枚举该文件或目录子树，并同时比较
baseline 后代与当前后代，因此修改、新增和删除都进入 native WorkingResult；符号链接作为链接捕获，不递归跟随。它不为显式 ignored
输入重新扫描整个工作区。partial publish、lost-run 恢复、directoryMatchesResult、reclaim 与 materialize 继续消费同一个 native
resultRevision，Git status 是否看见该路径不再决定结果是否保存。

原因：copyIgnored 已是用户明确选入的执行输入。只在 prepare 时复制却不把范围留在 branch，会使 Git ignored 修改既进不了
resultCommit 也进不了 native result，最终只能永久保留目录或在错误回收时丢结果。把根随 branch 持久化同时解决重启配置漂移和目录
后代新增/删除，不需要 WorkspaceHead 或每次全仓扫描。

状态：已实施；代码、迁移与验证见 status 3.4a。

### D-201 · 2026-09-10 · 草稿集成写回、绑定预览与冲突处理（3.4C/F、3.5、3.10）

背景：dispatch 已持久化草稿基线，原生结果和磁盘 Integration 已可用。需要编辑器协调的路径只返回 `surfaceTargetPaths`，没有写回缓冲。settle 在“有文件变化”时标 `merge-ready`，不是绑定预览。双修订预览、独立冲突 UI 和验证绑定未交付。

决定：

1. 生产 `IntegrationCoordinator` 注入 Documents `inspectDirtyBuffers`。目标按 workspace + resource 的 dirty publication 分类，不用聚焦窗口。未注入检查时保留原草稿磁盘启发式，以免旧测试/无 Documents 装配改语义。
2. 预览与应用共用 `buildThreeWayMergePlan`。绑定选定子 `resultRevision` 与每路径父身份（磁盘对象修订或 surface `localEditRevision`/`baseRevision`），不依赖整仓 WorkspaceHead。未知、未完成或父/子变化后的旧预览不能标 `merge-ready`。settle 先标 `dirty`，预览干净再升为 `merge-ready`。
3. 磁盘走既有 `applyDurableFileOperation`。surface 返回 `surfaceEdits`；UI 用 Document Registry `prepareWorkspaceEdit`/`applyWorkspaceEdit`，`groupId = operationId`，整组撤销且不保存。ack 把真实 surface 阶段写回同一 Integration `data_json.surfacePhases`。缓冲不可用或修订漂移标 unavailable，保留子结果，不改磁盘。
4. 冲突 UI 展示父/子/基线，文本可编辑，非文本只选版本；提交时按当前目标修订重核。重试复用同一 operation/result，不叠加标记。预览文案只说明可应用性。
5. Thread / `threads` / `wait` / Zone 2 / 线程面板共用 `integration` 与紧凑 `integrationBinding`。重叠提示保持非阻塞。不暗改 D-088 的写入后草稿来源失效。

验证：coordinator 预览/surface/dirty 分类；Document Registry 分组撤销且磁盘不变；thread routes preview/merge/ack；settlement 不再因“有文件”标 merge-ready。浏览器完整点击链未跑。

影响：protocol 线程合并类型；coordinator / runtime / routes / registry / 线程面板；设计 3.4–3.5；status 3.5a / 3.10。

状态：已实施。

### D-202 · 2026-09-10 · 线程归档/恢复与空间治理（3.4E、3.10）

背景：`archiveThread` 只改 lifecycle；用户归档若走会话删除路径会清掉 `report`。UI 投影丢掉 archived。`materialize` 在原路径被其他内容占用时没有明确拒绝。占用统计只加 `stat.size`，预算和归档产品面未接线。

决定：

1. 用户归档走 `threadRuntime.archiveUser`：运行中/等待输入先 abort 并 `endRun(cancelled)`，保留 Pi 会话文件、转录引用、结果和 `report`。不调用 `archiveThreadsForDeletedSession`。恢复沿原 Thread / 原 `sessionId` / 已有结果继续；目录已回收则按结果在原路径重建。
2. 原路径存在且 `materialized === false` 时视为被其他内容占用：报 `path-occupied`，不删除不明目录。ENOSPC 与用户预算不足分别标 `enospc` / `budget-unavailable`。未知占用不记成零；不杀已有任务来腾配额。
3. 占用区分物化目录逻辑大小、`stat.blocks * 512` 分配（拿不到则为 null）、以及内容寻址对象。共享 hash 在工作区只计一次，线程上拆 exclusive/shared。预算只对照用户配置的 `harness.worktree.budget`，不引入 8 GiB / 百分比 / 保留天数默认值。
4. 回收复用结果发布、`directoryMatchesResult`、Documents 写者屏障和 Host 上的后台命令检查。`keep_worktree`、未完 Integration、活跃 Run、写者/编辑器、后台命令、未收集内容或无法核对结果时只保留该目录并写明原因。归档不释放 object_references。
5. 线程面板、`GET ?archived=1`、`GET /space` 与 archive/restore/reclaim/keep-worktree 共用 Host 投影。默认列表仍不展示 archived。

验证：registry 用户归档保留 report；runtime 占用路径不删目录；routes 走 runtime 而不是只调 registry helper；space 共享对象与 unknown≠0；UI 投影在 Host 要求时保留 archived。浏览器完整点击链与真实 ENOSPC 未跑。

影响：protocol 占用类型；thread-space / runtime / routes / registry / worktree / 线程面板；设计 9.3.4；status 3.4 / 3.10。

状态：已实施。

### D-203 · 2026-09-10 · 草稿 Integration 由 Documents 定向执行，确认与撤销共用持久操作

背景：验收 D-201 时，真实文件反例证明旧预览的手工解决可以覆盖预览后的父编辑；纯 surface 操作在缓冲尚未写入时已经记为 complete。调用方传正文、UI 本地应用再按路径 ack，不能证明目标窗口、文档实例或实际写入。预览 GET 还会触发 Thread 更新并再次加载自身。

决定：

1. 预览固定子结果和父完整身份。草稿包括 owner、连接代际/注册、文档实例、base/local 修订、正文哈希与保存格式；磁盘身份含路径状态与 mode。提交必须消费所审阅的 binding 和路径修订，不能重取父正文后套用旧解决。预览读取不刷新 Thread 事件，同值投影不发新事件；父输入变化使绑定失效。
2. Agent 沿本次 inputContext 的 Host 快照解析发起 surface，UI 显式指向自身 owner。Documents 沿已有 dirty-owner 连接发送定向操作；事件只带元数据，正文经已认证的 Documents HTTP 通道读写。回执绑定 request、operation、owner、注册代际与文档实例。缺失记录不自动打开替代；窗口失联不被解释为草稿不存在。
3. 同一 Integration 在执行前持久化磁盘和 surface 目标的 before/after、对象引用、身份与 apply intent。缓冲确认前不能 complete；断连、重启或不明回执保留 needs-attention，恢复不能把 surface 行当磁盘写入。失败条件补偿，撤销走同一 Host 操作并校验当前产物，保留后续用户编辑。
4. UI 与 agent 共用此操作，无调用方正文与裸路径 ack 旁路。缓冲修改仍不保存；同 operation 的重试保留首次撤销基线。已知本次缓冲写入后，旧读取快照不再冒充当前草稿，也不能失效后读回旧磁盘。可应用性与测试验证继续分列。

影响：Documents authority/Registry/客户端、恢复操作、coordinator、线程工具/路由与冲突面板；修订 D-201 的执行与确认方式，沿用 D-078 的原生状态及默认交付方向。

状态：已实施，真实 Documents/Registry/Coordinator 混合集成与撤销、故障与 UI 请求行为证据见 status 3.5a。

### D-204 · 2026-09-10 · 归档等待真实执行退出，物化与预算按整个工作区处理

背景：D-202 的回收检查提前释放写者屏障；准备任务、关闭失败与 native 结果恢复没有闭合。首次物化绕过用户预算，空间统计只覆盖当前父会话；恢复只取消 archived 标记，没有把原会话重新接到 ThreadRun。

决定：

1. 每个 Run 的准备/setup/会话启动有自己的取消与完成生命周期。归档取消并等待实际任务、Pi 会话和 Host shell 退出，再发布待保留结果；任一步失败保留可重试的绑定与目录，不吞错并宣称归档成功。成功关闭的事实绑定该 Run，后续采集或落盘失败重试不再要求已关闭的 provider 再关闭一次。目录创建即登记归属，准备取消仍等待实际生产者结束。
2. 同线程的归档、恢复和回收共用生命周期协调；自动清理跳过正忙的目标，不持有一个线程的锁等待另一个线程。真正删除期间持续持有 Documents 写者屏障，屏障内重核结果和后台命令。dirty/merge-ready 的提示本身不等于未完持久 Integration；已独立保存的结果仍可回收物化目录。
3. 恢复按选定 native resultRevision 重建，沿同一 Thread、原 Pi session 创建并绑定新 Run。`materialize/materializing/setup/ready` 是持久阶段，失败原因只供展示。失败的部分目录重试清理要核对保存的 fingerprint；出现新内容则保留。已结束或已回收但未归档的线程点击打开也先走 Host 恢复；失败保留原可重试生命周期，UI 不打开错误目录。
4. 用户预算适用于首次准备和恢复，按工作区全部父会话的目录与去重对象统计，加上可知新增需求。短临界区预留并发准备的已知需求，慢 setup/会话调用不占工作区锁。未知量保留未知，不能遮住已知超额，也不因未知自动禁止所有任务；没有新增默认配额。优先回收合格目录，不杀已有任务。

影响：Thread runtime/registry、materializer/worktree、space、Host 关闭装配与线程面板；补正 D-202 的生命周期实现。

状态：已实施，真实 Git/native 生命周期、失败与并发反例、React 打开消费证据见 status 3.4/3.5 与 3.10。

### D-207 · 2026-09-10 · 结果验证记录与自动 review

背景：Plan 3.4A / 3.5 / 3.7 要求用户和父 agent 能看到“哪一版结果接受了什么检查、结果如何、哪一版被审阅过”。旧 review-sensor 只在测试里 `createThread({ autoRun: true })`，不 spawn，也不挂已发布结果。父 `agent_settled` 上的 journaled-change 扫描不是受检输入。

决定：

1. 验证记录写在 WorkingState 文档的可选 `verifications`（schema 仍为 3）。Thread catalog 只存投影 `Thread.verification`（schema 仍为 8）。缺失当作 `{}` / 无投影。不恢复每次消息全工作区扫描，不建第二套工作状态权威。
2. 命令成功只看 `exitCode === 0 && !cancelled`。不从报告或 stdout 里的“passed”推断。`allExitedZero` 只描述已记录命令的退出，不是“该结果已通过”。
3. `binding: "bound"` 表示同一 Run、publish 前、cwd 在 worktree 下的现场观察；`bindingReason` 写明发布对象是之后捕获的。cwd 在外为 `unbound`；无法证明则为 `uncertain` 并写原因。
4. 三个事实分开：子结果检查（`childChecks`）、合并可应用性（现有 `integrationBinding`，不复制权威）、合并后父检查（`parentChecks`）。子检查通过不意味着合并后的父工作区通过。草稿合并 `draftUnsaved` 记 `cannot-verify-unsaved-draft`，磁盘命令不能声称验证了未保存缓冲。
5. 自动 review 的生产触发是子线程 `settle()` 在成功发布且 `changedPaths` 非空之后。`onAgentSettled` 对父 journaled 变化失败关闭。调用链是 `createThread` + `startRun` + `spawn`（`autoRun: true` 单独不会跑）。输入是任务 brief、已存储 WorkingResult 的 diff、可选已接受项目知识；`carryBlocks: false`、`worktree: "none"`、`hidden: true`。不复制父完整对话。
6. 同一 `resultRevision` 去重；新修订不继承旧修订的已审阅/检查通过。进行中的旧 review 走现有 `kill()`。完成记录后，不同 `reviewThreadId` 或更早时间戳不能覆盖。结论写回源线程投影和 Zone 2 `<review>`；隐藏 review 线程不进默认列表。
7. 默认 `harness.review = { enabled: true, gate: false }`，用户所有，workspace 不能改。gate 只把源线程标成等待该修订的 review，不阻断 settle。不新增强制全量检查、固定轮数、费用看板或执行者返工循环。

考虑过的替代：(1) 继续用父 `agent_settled` + 现场 diff——受检输入不是固定结果。(2) `createThread({ autoRun: true })` 不 spawn——线程不会跑。(3) 从测试报告文本推断成功——把叙述当成证据。(4) 把合并可应用性再存一份验证权威——与 Integration 双写。

影响：WorkingState / verification-coordinator / review-sensor / thread-runtime settle 与 merge / harness-services Zone 2 / Settings `harness.review` / 线程面板三事实展示；设计 9.2.3 / 9.2.5b / 9.3.1；architecture 6.1；status 3.4 / 3.5 / 3.7。

状态：已实施；调用链与定向证据见 status 3.4 / 3.5 / 3.7。真实付费模型审阅质量与完整浏览器点击链未测。

### D-210 · 2026-09-10 · 3.4 / 3.5 / 3.7（验证绑定采用观察边界身份与一次性运行主体）

类型：问题与解法（补正 D-207）

背景：D-207 初版把同一 Run 中较早的命令在结果发布时统一挂到新 `resultRevision`，没有证明命令执行时的输入就是该结果；父合并后的命令也可能从旧观察中回填。后台完成若依赖读取输出、session 重注册后仍保留旧 actor、review 只按结果修订去重，都会把时间相邻误写成身份相同。为补救而在每条命令前后扫描全目录会重新引入 D-078 已否决的常态全工作区扫描。

决定：

1. 命令观察在 start 时固定 authority instance、session、worker、worker generation、Run 与本次 binding generation，在 end 时再次核对；会话重注册撤销旧 actor 和未完成观察。子线程的持久绑定可以保留等待新 actor，但旧代际不能继续写记录。已消费的完成观察只能绑定一次。
2. Git 工作区的受检输入身份由不可变 base/HEAD 加实际 staged、unstaged、tracked mode 与非忽略 untracked 的变化路径状态组成；子分支还包含固定草稿与显式 `captureScopes`。在命令 start/end 和发布或合并边界核对同一身份。Git 仍承担 index/status 的变化发现成本，但正文捕获与哈希只读变化路径，不为每条命令遍历并哈希整仓字节。普通 ignored 缓存不冒充已覆盖；非 Git 目录在没有便宜固定身份时明确 `uncertain`，不为得到绿色状态扫描全目录。
3. 子检查只有在 thread、Run、branch、actor/binding generation、执行目录和 start/end/publish 身份全部相符时才标 `same-run-matching-result`。命令、cwd、退出码、取消与输出引用仍完整记录；`allExitedZero` 只聚合已绑定命令，不等于行为正确或测试充分。
4. 父检查只在一次 Integration 完整 applied 后，为选定 `resultRevision + operationId + parentSessionId` 打开持久窗口。冲突、补偿、needs-attention、未保存草稿不打开磁盘验证窗口。Host 重启可从 WorkingState 恢复窗口；只有窗口之后且 start/end 都匹配合并后 Git 身份的父命令进入该记录。
5. 自动 review 以 `resultRevision + reviewThreadId + reviewRunId` 识别一次执行；晚到的旧 Run 不能覆盖新记录。gate 的 `waitingFor.review` 保存这组结构身份，只由对应完成/失败/取消清除；失败与取消进入源线程和 Zone 2，不伪装成未运行。删除没有生产调用方的旧 `onAgentSettled` 门面，固定结果发布是唯一自动触发。

影响：WorkingState verification 记录、verification coordinator、shell 生命周期观察、ThreadRuntime settle/merge、review sensor、Thread/Zone 2 投影、设计 9.2.3 / 9.2.5b / 9.3.1、architecture 6.1、status 3.4 / 3.5 / 3.7。

状态：已实施；证据见 status。非 Git 的精确命令输入绑定、真实付费 review 质量及完整浏览器链未验证。

### D-212 · 2026-09-11 · 3.4 / 3.4a（WorkingState 虚拟只读视图接入真实 Thread Run）

类型：问题与解法

背景：WorkingState 已能保存固定 base、draftBasePaths 与 delta/tombstone，但隔离线程的同名只读工具仍读父 live 或物化副本。父在 dispatch/spawn 之后修改未被子线程碰过的路径会泄漏进 child read/grep/find/ls/explore。没有路径绑定工具的隔离 Run 仍复制整仓，把物化目录当成视图权威。

决定：

1. Host 为隔离 Thread Run 绑定 `ThreadExecutionView`（session → workspace/thread/run/branch/revision/mode）。`document.readSource`、`document.pathOverlay`、`search.content` 与 explore reader 在绑定存在时只读 `effectiveState = base ∪ delta`，tombstone 隐藏文件及其后代，并合成仍有子项的虚拟祖先目录。provenance 标明 branch/revision/origin；缺失正文保持 unavailable，不降级到父磁盘或 scratch。
2. 物化资格按实际工具名判断：`bash`、`edit`、`write`、`apply_patch`、`symbols`、`definition`、`references`、`hover` 需要目录。隔离 Run 若不含这些工具，只创建 `.piarium/worktrees/<threadId>` scratch，从父 `sourceRoot` 捕获基线，不复制、不把草稿物化到磁盘。`ThreadWorktree.viewMode: "virtual"` 使恢复不会把 ready scratch 当成未完成复制。结算与归档发布 `publishHeadResult`，不把空 scratch 当成整仓删除。
3. 父会话与 `worktree: none|shared` 仍读 live/surface。路径、scope、actor 与 Run 继续由 Router/Host 强制。本阶段不实现 Merkle、虚拟写入或 dispatch 瞬时整仓基线。

影响：protocol `DocumentReadSourceResult` / path overlay authority / `ThreadWorktree.viewMode`；Host working-branch lookups、search corpus、thread spawn/restore/settle；pi-host read/find/ls；设计 9.2.5b、plan 3.4 C、status 3.4a、architecture 6.1、harness DOCUMENTATION。

状态：已实施；Host router 与 pi-host 同名工具有定向证据。虚拟 edit/write、真实 Git filter/LFS 一致性与完整桌面会话未测。

### D-213 · 2026-09-11 · 3.4 / 3.4a（虚拟 edit/write/apply_patch 与原子物化切换）

类型：问题与解法

背景：D-212 已让隔离 Thread Run 从固定 base+delta 只读。同名 edit/write/apply_patch 仍走父磁盘或 spawn 时复制的目录，父 live 会被子写入污染，兄弟分支也会共享同一可写树。物化资格把文本工具算作需要目录，使纯编辑 Run 在启动时复制整仓。同一 Run 若一边写 delta、一边写目录，就没有单一可写视图。

决定：

1. 隔离 Run 一律从 `viewMode: "virtual"` scratch 启动。同名 `edit` / `write` / `apply_patch` 经 Host `document.branchWrite` 把文本变更提交到 WorkingState delta：内容进入现有对象库，路径状态复用 RecoveryState，每次写入绑定 `writeRevision` 并在分支单写序列内 CAS。迟到的旧修订不能覆盖新头。目录、二进制、符号链接与 unsupported 明确拒绝，不暗改另一种对象。父磁盘保持不变。
2. 物化资格只看实际路径绑定能力：`bash`、`symbols`、`definition`、`references`、`hover`。首次这类工具由 Host 强制：固定当前 branch revision，等待在飞虚拟写入，物化到 staging，再原子换到该 Run 的唯一目录；之后本 Run 的文件工具都走该目录。切换失败删除 staging，保持原虚拟分支可读，不进入半目录半 delta。`lsp.diagnostics` 不触发切换。eligibility 不按角色名猜测。
3. 虚拟结算发布 `publishHeadResult`；物化后的结算把目录变化收回新结果修订。Integration、review 与 verification 只消费该不可变结果。含 bash/LSP 的隔离 Run 在 spawn 时按用户配置预算预占最终物化占用，直到物化成功或 Run 结束；纯文本 Run 不预占复制预算。虚拟 scratch 在 keepReasons 为空时可回收，不按未完成物化残留处理。
4. 本阶段不实现 Merkle、dispatch 瞬时整仓基线、嵌套线程工具装配或跨平台 CoW。

影响：protocol `document.branchWrite` / `workingBranch.ensureMaterialized`、WorkingBranch `writeRevision`；Host writes/gate/runtime/reclaim；pi-host mutation journal 与 apply_patch；设计 9.2.5b、plan 3.4 C、status 3.4 / 3.4a、architecture 6.1、harness DOCUMENTATION。

状态：已实施；Host router 生产链与 pi-host journal 有定向证据。真实 Git filter/LFS 一致性、完整桌面 bash 物化后的跨平台 CoW，以及非 Git 大目录物化墙钟未测。

### D-214 · 2026-09-11 · 3.4 / 3.4a（隔离线程在 dispatch 创建分支时固定磁盘基线）

类型：问题与解法

背景：D-212/D-213 已让隔离 Thread Run 读写 WorkingState 视图，但非草稿路径仍在 Run 启动时捕获。queued 线程在排队期间、以及 dispatch 返回到 spawn 之间，父目录的新增、修改、删除、checkout 或提交会进入子基线。Git blob 与工作目录转换后的字节也不能无条件视为相同。失败捕获若留下可运行 Thread，会假装基线完整。

决定：

1. 隔离 `thread.dispatch` 在 `createThread` 之后、返回之前（含 queued）必须调用 Host `threadPrepareIsolatedBranch`。缺 hook 或捕获失败/取消时清理草稿并 `deleteThread`，不留下可运行但基线不完整的 Thread。`createBranch` 只在捕获完成后发生。
2. Git 工作区在分支创建边界用 `inspectGitBaselineInventory` 固定 HEAD/tree 身份，并枚举 staged、unstaged、tracked mode、已删除与非忽略 untracked。内容一律读取工作目录字节（`fileStore.captureState`），不把 `git cat-file` blob 当作工作区正文。ignored 默认不进；显式 `copyIgnored`/`captureScopes` 必须进入。父之后的漂移不能改变该 base。
3. 非 Git 与 unborn（`baseRef: "zero-commit"`）在同一边界做一次可取消、有进度的目录捕获。这是分支创建成本，不扩散到普通消息、恢复或每次查询。进度写入 `preparationStage: "capturing-baseline"`；不完整不得宣称完整。
4. 固定草稿仍是最高优先级覆盖，并在 dispatch 时进入 branch base。spawn 仅在尚无 `workBranchId` 时补捕获（直接 spawn/测试/遗留）；dispatch 已准备的线程不重扫父盘。不实现持续 WorkspaceHead、全仓 watcher 或 Merkle。

影响：protocol `ThreadWorktree.preparationStage`；Host dispatch/runtime/worktree/WorkingState capture；设计 9.2.5b、plan 3.4 C、status 3.4 / 3.4a、architecture 6.1、harness DOCUMENTATION。

状态：已实施；dispatch 生产链与 Git/非 Git 捕获有定向证据。真实 Git filter/LFS 一致性、Windows 符号链接/执行位、非 Git 大目录墙钟未测。嵌套线程仍待后续纵切。

### D-215 · 2026-09-11 · 3.4 / 3.4a / 3.6（嵌套线程经角色能力与 Host 强制接通）

类型：问题与解法

背景：数据模型已支持 `parent.kind: "thread"`，但子会话 allowlist 不含 dispatch，嵌套只是半支持。提示词不能授权工具。子线程若扫父 live 盘，父在孙 dispatch 之后的写入会污染孙基线。孙结果若直接写根工作区，会跳过父分支这一层可写视图。虚拟文本写入常省略 mode；把未声明的 mode 与磁盘捕获的 mode 做全字段相等，会使合法新文件集成失败并回滚。

决定：

1. `hard-implement` 与 `frontend` 的角色目录包含 `dispatch` / `threads` / `wait` / `send` / `read_thread` / `merge` / `kill`。`review` / `check` / `retrieval` / `quick-implement` 不含。pi-host 按冻结 allowlist 与 Host `control.thread` 装配，不靠提示词告诉子 agent 可以嵌套。
2. `thread.*` 服务用 `getThreadForSession` 把 caller 解析为 owning Thread；`assertOwnerTool` 拒绝冻结 manifest 未列的控制工具。`resolveNestedThreadScope` 只允许继承或收窄；扩 scope 为 `denied`。冻结 `permissions` 写入 `ThreadLaunchManifest`，子线程继承父 overlay，不能从协议扩大。
3. 嵌套隔离基线：父仍虚拟时复制 `effectiveState`，`baseRef = thread-<parent>@<writeRevision>`；父已物化则捕获父目录。不扫根 live 盘。孙 `publishHeadResult` 经 `parentAuthority: branch|directory` 集成到父可写视图；父再发布并合并到工作区。根 `threads` / Zone 2 只列直接子线程，不把孙正文或完整对话复制进根上下文。
4. 不加固定深度上限；复用既有并发与排队。同一 Thread/ThreadRun 注册表、Pi session、review、归档、取消与 `resumeLostForParent`。文本集成时，未声明 mode 的目标只核验已声明字段（`matchesClaimedState`）；已声明 mode 仍全字段相等。父 regular-file 的 mode 在 apply-child 时继承到未声明 mode 的子文本。
5. 本阶段不实现 Merkle、跨平台 CoW、完整 Git LFS/filter 框架、Zone 2 user terminal 或 retrieval/research 扩散。

影响：protocol 角色目录与 `ThreadLaunchManifest.permissions`；Host thread services/runtime/nesting/integration/recovery apply 核验；设计 9.2.5b / 9.3.5、plan 3.6、status 3.4 / 3.4a / 3.6、architecture 6.1、harness DOCUMENTATION。

状态：已实施；Host 嵌套 dispatch/基线/集成与角色装配有定向证据。真实付费嵌套 Pi 会话与完整桌面 Host 重启未测。

### D-216 · 2026-09-11 · 3.4 / 3.4a / 3.6（owning/execution workspace 拆分与物化 Git 边界）

类型：问题与解法

背景：D-212–D-215 把隔离 Run 的 Documents/LSP/路径权威放到 scratch/materialized cwd 上，但 Thread catalog、Zone 2、thread.* 和 lost resume 仍用同一个 `ctx.workspaceId` / snapshot workspace 去查 `getThreadForSession`。Documents 给执行目录分配另一个 workspaceId 后，子会话在错误 catalog 里找不到父 Thread，孙线程写错工作区，`parent.kind` 退化成 session。虚拟物化只是把 WorkingState 目录 rename 进 `.piarium/worktrees/<id>`，该路径仍在用户仓库内，子进程 `git rev-parse --show-toplevel` 会发现父仓库，status/reset/add/commit 会改父 index。

决定：

1. 维持两个身份。owning workspace 是 Thread catalog、WorkingState、知识、review、父子和生命周期所属的原工作区。execution workspace/root 是当前 scratch/materialized 目录的 Documents、LSP、路径与 shell 权威。`session.create/open` 继续把 Documents 解析出的 execution id 交给 Pi；Router `ctx.workspaceId` 继续表示 actor 的 execution workspace。
2. Host 在 `dataDir/threads/<hostId>/session-bindings.json` 持久化 `sessionId → { owningWorkspaceId, threadId, runId, parent }`。`markRunRunning` 写入，session close 删除。thread services、Zone 2、lost resume 和 verification 父窗口只从该 binding 取 owning workspace，不扫全部 catalog，也不用执行路径猜父线程。根会话没有 binding 时，`ctx.workspaceId` 本身就是 owning。
3. Git 工作区物化后必须有独立 Git 上下文。有 HEAD 时使用 `git worktree add --detach <live> <baseRef>`，再把 WorkingState staging 叠到该 worktree 上并保留 `.git` 文件。这会写入用户仓库的 `.git/worktrees`，但不创建 `piarium/<threadId>` 分支，也不把用户当前分支/HEAD/index 当作子仓库。unborn 或执行目录位于其他 Git worktree 内时，在 live 目录 `git init` 成独立仓库。非 Git 且探测不到外层 Git 时保持 Host 管理目录。WorkingState 仍是结果真相；Git 只是执行物化后端。

影响：protocol `ThreadSessionBinding`；Host thread-registry/services/runtime/worktree、Application Host snapshot resume；设计 9.2.5b / 9.3.5、plan 3.4/3.6、status 3.4 / 3.4a / 3.6、architecture 6.1、harness DOCUMENTATION。

状态：已实施；Documents 分配不同 workspaceId 的公开 nested dispatch、Zone 2 / wait / lost resume 与子 Git 不改父状态有定向生产证据。虚拟写入/修订、dispatch 基线诚实和嵌套集成/权限仍待本轮后续阶段。

### D-217 · 2026-09-11 · 3.4 / 3.4a（虚拟写入、修订标签、物化切换恢复与树不变量）

类型：问题与解法

背景：D-213 把文本写入接到 WorkingState，但 `VirtualWriteGate` 在物化 `switching` 之后直接返回 `disk`，失败时仍可能把后续 write 打到非权威 scratch。物化 rename 没有持久阶段，崩溃会留下半切换目录；调用方 abort 也未传到切换。嵌套 merge 直接 `commitVirtualWrites`，不走写 gate，也不更新父 Run 的 `writeRevision`。`effectiveState(branchId, writeRevision)` 去查已发布 result，虚拟写入后 `headRevision` 仍为 0，read/grep/explore 会用错修订标签。symlink 被跟随后当文件改写；环、非法 UTF-8、regular-file 祖先下建子路径会留下错误 delta。公开 explore semantic 未把虚拟 Run 的 WorkingState 钉进 `threadDocuments`。

决定：

1. 文本写入与改父虚拟分支的入口（含 nested integration）走同一 `VirtualWriteGate`。`switching` 结束后重读 execution view：已物化才返回 disk；仍是 virtual 则再写一次 WorkingState。禁止写非权威 scratch。成功后更新活跃父 Run 的 `writeRevision`。
2. 物化绑定确定的 `writeRevision`，并把 `ThreadWorktree.materializationSwitch` 记到 catalog（不涨 schema 版本）。阶段为 `staging-ready` / `live-backed-up` / `staging-promoted`。调用方 abort 能回滚就回滚到 virtual，超时后不得在后台完成切换。重启按 journal 恢复到一个权威视图：未 promote 回 virtual，已 promote 完成 materialized。
3. 读 live deltas 调用 `effectiveState(branchId)`，不用 `writeRevision` 去查 published result。返回的 revision 标签等于实际读取的 `writeRevision`。一次 explore/semantic 查询开始时冻结该视图。
4. 文本 edit/write/delete 不跟随、不改写 symlink；symlink 环、fatal UTF-8、regular-file/symlink/unsupported 祖先下建子路径、同批 file/directory 祖先冲突一律拒绝且不写 delta。

影响：protocol `ThreadWorktree.materializationSwitch`；Host writes/gate/runtime/integration/explore semantic、branch-view；设计 9.2.5b、plan 3.4 C、status 3.4 / 3.4a、architecture 6.1、harness DOCUMENTATION。

状态：已实施；定向生产链覆盖失败物化并发写、孙 merge 后再写再物化、树拒绝、修订标签、semantic pin 与崩溃/abort 恢复。dispatch 基线诚实与嵌套权限/级联终止仍待本轮后续阶段。

### D-218 · 2026-09-11 · 3.4 / 3.4a（dispatch 基线诚实、mode 全字段比较与失败清理）

类型：问题与解法

背景：D-214 已在 dispatch 创建 WorkingBranch，但 `inspectGitBaselineInventory` 把 Git 错误吞成空路径或 `{ kind: "directory" }`，仍能生成看起来完整的分支。捕获窗口内父写入或 Host 已知 writer 不会使捕获失败。gitlink 被当成空目录，unsupported 物化被跳过。`matchesClaimedState` 在目标省略 mode 时忽略权限，用户 apply 后 chmod 仍可能被条件补偿当成未变。`createBranch` 成功而 `setWorkingState` 失败会留下未挂 Thread 的 branch。

决定：

1. 只有“不是 git 仓库”才返回 `{ kind: "directory" }`。unborn HEAD（`ambiguous argument 'HEAD'` / `unknown revision` / `needed a single revision`）记 `baseRef: "zero-commit"`、`unborn: true`，仍收集 `ls-files`，不跑 `diff HEAD`。损坏、权限、取消和其他 Git 失败必须抛出，dispatch 失败。
2. 捕获前取 fingerprint（Git：`baseRef + unborn + paths + gitlinks`；非 Git：目录路径列表），捕获后再检一次。变了或有活跃 Documents writer → `ThreadRuntimeError("unavailable", … baseline-changed, { retryable: true })`。不无限重扫，不加 WorkspaceHead watcher。`ls-files -s` 的 `160000` gitlink 列缺失路径并失败，不把 submodule 当空目录。物化遇到 unsupported 抛错。
3. 撤回全局 `matchesClaimedState`。apply / compensation / reconcile 一律 `sameState`。`commitVirtualWrites` / `publishStates` 给无 mode 的新 regular-file 写入在 `identity.canonicalRoot` 探测到的真实默认 mode（失败则 `0o644`），使直接 integration 与先物化再 integration 的 mode 一致。
4. `prepareIsolatedBranch` 失败时：若 Thread 尚未绑定该 `workBranchId` 则 `deleteBranch`，删除 scratch 与孤儿 staging/backup。draft baseline 仍由 dispatch 的 `captured.cleanup()` + `deleteThread` 负责。

影响：Host inventory/runtime/store/materializer/recovery apply 核验、thread services retryable、设计 9.2.5b、plan 3.4 C、status 3.4 / 3.4a、architecture 6.1、harness DOCUMENTATION。

状态：已实施；Git 失败/gitlink、捕获窗口变化、writer、mode 全字段补偿与失败清理有定向生产证据。嵌套权限冻结与级联终止仍待本轮后续阶段。

### D-219 · 2026-09-11 · 3.4 / 3.4a / 3.6（嵌套权限冻结、耐久集成与级联生命周期）

类型：问题与解法

背景：D-215 把 permissions 写进 manifest，但 `session.create/open` 不传 overlay，pi-host 每次用 live settings 建 gate，父事后放宽会放宽孙。物化父 directory 集成把对象库 `root` 改成父 worktree，recovery objects/staging 会写进父目录。branch 父集成只 `commitVirtualWrites`，不落 operations 表，重试不幂等，无法对账/撤销。kill 跳过 queued、不取消 preparation；archive 不先停子线程。嵌套 captureScopes 重读 live `copyIgnored`。scope 规范化不拒绝绝对路径和 `..`，带草稿的拒绝不 cleanup。

决定：

1. `session.create/open` 带可选 `permissions`。Thread 四处 create/open（立即启动、queued dequeue、lost resume、archive restore）传入 `normalizeFrozenHarnessPermissions(manifest.permissions)`。缺省/`{}` 冻结为 `{ mode: "normal", rules: [] }`，不是跟 live settings。pi-host 把冻结 overlay 当 user/base，live 当 workspace，`mergePolicies` 只能收紧。
2. 物化父 directory 集成只改 `identity.canonicalRoot`（及 execution `workspaceId` / resource gate），对象库 `root` 保持 engine dataDir。branch 父集成写入 `kind: integration` 行（child `branchId`/`resultRevision`、parent before/after `writeRevision` 与 path states、`retryBinding`）。complete 重试同一 operationId；undo 在当前等于 after 时 CAS 写回 before。
3. kill/archive 父线程先递归子：取消 preparation、Run、session，再停父。queued 也走 `threadKillSession`。`runtime.kill` 先 `waitForPreparation`。
4. 嵌套 WorkingBranch 的 `captureScopes` 继承父冻结范围（可用子 scope 收窄），不读 live settings；父空则子空。scope 拒绝绝对路径和 `..`；带 surface 草稿的拒绝先 `cleanup()`。

影响：protocol session.create/open 与 `normalizeFrozenHarnessPermissions`；pi-host session-host/host-controller；runtime-broker/dispatcher；Host integration/runtime/services/registry/nesting、Application Host 装配；设计 9.2.5b / 9.3.5、plan 3.6、status 3.4 / 3.4a / 3.6、architecture 6.1、harness DOCUMENTATION。

状态：已实施；directory 对象库根、branch 集成对账/撤销、冻结 overlay 传入 create、级联 kill/archive、captureScopes 继承与非法 scope cleanup 有定向生产证据。真实付费嵌套 Pi 会话与完整桌面 Host 重启未测。

### D-220 · 2026-09-11 · 3.4 / 3.4a（执行 Git 基线、固定视图与 dispatch 内容身份）

类型：问题与解法

背景：D-216 给物化目录做了独立 `git init` / `--detach`，但仍把 WorkingState 的逻辑 `base`（父 HEAD 或 `thread-<id>@<writeRevision>`）交给执行仓库的 inspect/snapshot/settle。独立 init 后该 SHA 在子仓库不可解析，真实链路会出现 bad object，且 init commit 已包含虚拟写时 inspect 只看见后续 shell 写。D-217 的 revision 标签在取得 store lease 前读旧 view，explore 也未在同一 shared lease 内钉住 immutable snapshot。D-218 的 fingerprint 只比路径集合，两个已 dirty/untracked 文件中途换内容仍能拼出混合基线；新文件 mode 还在用户 source root 写 `.piarium-mode-probe-*`。

决定：

1. `ThreadWorktree.base` / `WorkingBranch.baseRef` 只表示父状态身份。独立 `git init`、detached worktree add、崩溃恢复和 rematerialize 必须取得并持久化执行仓库当前可解析的 `executionBaseline`。inspect/snapshot/settle 的 Git 读使用该执行基线；`importFixedResult` 写入 store 时仍用父身份。reclaim 删除执行目录时清除 `executionBaseline`。rematerialize 只从父仓库导出父仓库能 `rev-parse` 的 commit，不得引用已删子仓库对象。
2. 结算 `publishDirectoryResult` 的候选路径并入当前 `branch.deltas`，使独立 init 后 native result 同时包含已打进执行基线的虚拟写和之后的 shell 写。
3. WorkingBranch 普通读取在取得 shared store lease 后重新取当前 view，正文与 provenance 使用同一 `writeRevision`。`explore.query.start` 在同一个 shared lease 内复制 immutable effective-state snapshot 与 `writeRevision`；词法、结构、语义和原文读取都消费该快照。
4. 新文件默认 mode 按 `0o666 & ~umask()` 计算，不在用户树上创建探测文件。虚拟写、draft overlay 与 integration 使用同一函数。
5. Git/非 Git fingerprint 含 dirty/untracked 路径的内容身份。Documents `beginCapture`/`completeCapture` 与 dirty-state barrier 覆盖整个捕获窗口；窗口内内容替换返回 retryable `baseline-changed`，不留 branch。不增加无限重试、全局 watcher 或无依据硬限制。

影响：protocol `ThreadWorktree.executionBaseline`；Host worktree/runtime/store/lookups/explore query、Application Host 装配；设计 9.2.5b、plan 3.4 C、status 3.4 / 3.4a、architecture 6.1、harness DOCUMENTATION。D-216 / D-217 / D-218 相应部分在索引标 superseded in part。

状态：已实施；Git 父仓库 isolated dispatch → 虚拟写 → ensureMaterialized → shell 写 → settle → native result → merge 根目录、reclaim/rematerialize、staging-promoted 恢复、lease 后重读 view、explore 查询级 pin、无 mode probe、dirty 内容替换拒绝混合基线有定向生产证据。branch Integration 锁顺序/WAL 见 D-221。恢复时 execution identity/权限/知识所有权、级联生命周期与 scope segment 仍待本轮后续阶段。3.4 / 3.4a / 3.6 保持 Partial。

### D-221 · 2026-09-11 · 3.4 / 3.4a（branch Integration 锁顺序与写前日志）

类型：问题与解法

背景：D-219 把嵌套 branch 集成写入 operations，但 `mergeResult` 先持有 WorkingState exclusive lease，再经 `runWhenVirtual` 等待 `VirtualWriteGate`。物化已 `beginSwitch`、等待同一 store 时，嵌套 merge 会与之交叉等待。`runWhenVirtual` 用固定两次重试制造失败。branch 集成在 CAS 之后才写一条终态记录，`targetKinds` 误标为 `disk`，启动对账按磁盘文件处理或完全跳过；CAS 成功、complete 写入前崩溃会留下无对账身份的父分支变更。

决定：

1. 唯一锁顺序：先取得父分支写入/切换权威（`VirtualWriteGate`），再决定 branch 或 directory authority，再打开对应 store/目录。任何代码不得持有 WorkingState exclusive lease 后再等待 gate。传入已打开 store 的 `commitBranchWrites` 不得再 `waitSwitch`。
2. `runWhenVirtual` 按 gate 真实状态、切换结束和取消信号等待或改走 disk，删除固定两次重试。
3. branch Integration 写前日志：修改父 branch 前先持久化 applying intent（before/after revision、目标 states、retry identity、`targetKinds: "branch"`），再 CAS 父 branch，再写 complete/conflict。通用 disk reconcile 跳过这些行。
4. 启动对账比较父 branch `writeRevision` 与 before/after 切片：等于 before 则 aborted/retryable；等于 after 则补 complete；都不等则 needs-attention。undo 仅在当前仍等于 after 时 CAS 回 before。`operationId` 在上述崩溃窗口对账后仍可幂等复用。

影响：Host virtual-write-gate / working-branch-writes / integration-coordinator / durable-file-operation / journal-engine fence、thread-runtime merge、Application Host 装配；设计 9.2.5b、plan 3.4 C、status 3.4 / 3.4a、architecture 6.1、harness DOCUMENTATION。D-219 相应部分在索引标 superseded in part。

状态：已实施；CAS 成功后注入崩溃再经 `fenceUnfinishedOperations` 对账、以及 materialize `beginSwitch` 等待 store 时并发 `runtime.merge` 有定向生产证据。恢复时 execution identity/权限/知识所有权见 D-222。级联生命周期与 scope segment 仍待本轮后续阶段。3.4 / 3.4a / 3.6 保持 Partial。

### D-222 · 2026-09-11 · 3.4 / 3.4a / 3.6（恢复时 execution identity、冻结权限与知识所有权）

类型：问题与解法

背景：D-216 把 catalog 与 Documents 拆开，但启动 directory reconcile 仍用 owning Documents gate 写物化父目录；resolver 失败时还会退回 owning gate。D-219 规定 dequeue 传入冻结 overlay，但 Application Host `onThreadDequeued` 仍把 `permissions: {}` 交给 spawn，`accept-edits` 被冻成 normal。`session-bindings.json` 只是附加 map：catalog 已写、binding 未写或 stale owner 时，`getSessionBinding` 不核对 catalog，`assertOwnerTool` 在 `owner: null` 时跳过 thread tool allowlist。`session.snapshot` 早于 `markRunRunning` 时，knowledge/recall/suggestions/Zone 2 绑到 execution workspace。

决定：

1. directory Integration 持久化 `applyCanonicalRoot` 与 `applyExecutionWorkspaceId`。启动 `fenceUnfinishedOperations` 与 live apply 都经 Documents `resolveWorkspace(directory)` 取得 execution resource gate；对象库 `root` 仍是 owning recovery storage。无法解析或 identity 漂移标 `needs-attention`，不得改用 owning gate 写父目录。
2. 生产 `onThreadDequeued` 把 `thread.manifest.permissions` 交给 `runtime.spawn`；spawn 再 `normalizeFrozenHarnessPermissions`。缺省/`{}` 仍冻成 normal。pi-host 继续把冻结 overlay 当 user/base，live bypass 只能收紧。
3. `session-bindings.json` 是 thread catalog/run 的可重建索引。启动对账从 `run.sessionId` 重建；catalog 已写、binding 未写则补上；stale binding 丢弃。每次 `getSessionBinding` 核对 owning workspace、thread、run、session 与 parent。不匹配且无法从 catalog 派生则拒绝（`stale-binding`），不能以 `owner: null` 跳过 allowlist。
4. Thread session 的 knowledge / recall / suggestions / Zone 2 knowledge 解析到 owning workspace。Documents、LSP、shell、路径与工作区语义索引继续用 execution。`session.snapshot` 若早于 binding，随后 `markRunRunning` 重绑；知识请求惰性读 validated binding。

影响：Host thread-dequeue/registry/services/runtime、durable-file-operation/journal-engine fence、Application Host 装配；设计 9.2.5b / 9.3.5、plan 3.4/3.6、status 3.4 / 3.4a / 3.6、architecture 6.1、harness DOCUMENTATION。D-216 / D-219 相应部分在索引标 superseded in part。

状态：已实施；生产 dequeue → `session.create` 的 accept-edits、directory reconcile 走 execution gate、binding 重建/stale 拒绝、以及 owning≠execution 的 recall/suggest/Zone 2 有定向生产证据。级联生命周期与 scope segment 仍待本轮后续阶段。3.4 / 3.4a / 3.6 保持 Partial。

### D-223 · 2026-09-11 · 3.4 / 3.4a / 3.6（级联生命周期 serialization 与 scope 完整段）

类型：问题与解法

背景：D-219 规定 kill/archive 先停子孙，但 `archiveUser` 只锁父线程后递归子实现，子 restore/reclaim/merge 不进入该子自己的 lifecycle serialization。持有父锁再等子锁会与「子持有子锁再等父」反转。`runtime.kill` 在没有 session 时直接返回，queued 子孙只靠 services 无锁 `cancelThread`。`cancelThread` 会把已归档线程改成 settled。`parseThreadScopePath` 用 `value.includes("..")` 误拒 `src/foo..bar`、`version...txt`。

决定：

1. 父 kill/archive 先标记 cascade，再按 `createdAt` 然后 `id` 的稳定后序，对每个后代单独 `withThreadLifecycle` 执行该节点的 stop/cancel/archive，最后再锁父。不得持有父 lifecycle 后等待子 lock。
2. `merge` 在取得父 `VirtualWriteGate` 之后进入该线程自己的 lifecycle；已归档线程拒绝 merge。
3. restore 在取得本线程 lock 后检查 thread 祖先：祖先 `archived` 或仍在 `cascadingLifecycle` 中则 `conflict`，不能在已归档或正在级联的父下复活。根会话父下的同线程 archive→restore 仍允许。
4. `runtime.kill(threadId, keepWorktree, workspaceId?)` 在已知 owning workspace 时对 queued 无 session 的后代同样 cancel；生产 `thread.kill` 只调一次 cascade。`cancelThread` 不得把 `archived` 改成 settled。
5. scope 只拒绝完整 `..` 段、绝对路径和盘符路径。`src/foo..bar`、`version...txt` 经 `resolveNestedThreadScope` / dispatch 接受。

影响：Host thread-runtime/registry/services/nesting、Application Host 装配；设计 9.1.2 / 9.2.5b / 9.3.4、plan 3.4/3.6、status 3.4 / 3.4a / 3.6、architecture 6.1、harness DOCUMENTATION。D-219 相应部分在索引标 superseded in part。

状态：已实施；父 archive/kill 与子 restore/merge 并发、queued 子孙经生产 `thread.kill` cascade、以及 dotted relative scope 经 dispatch 接受有定向生产证据。3.4 / 3.4a / 3.6 保持 Partial：代码反例已关，真实付费嵌套 Pi 与完整桌面重启未测。

### D-224 · 2026-09-11 · 3.4 / 3.4a / 3.6（集成撤销权威、级联准入与结果身份）

类型：问题与解法

背景：D-221 的 branch Integration undo 在父 session 已物化后仍可能忽略 `holdParentVirtualWrite` 返回的 disk，继续改隐藏 branch 并报告成功；纯 disk undo 也只有 file phase 而没有 row-level undo intent。D-223 的级联标记只存在 runtime 内存，registry 的 create/start 不会观察。session-bindings miss 会重新扫描所有 catalog，且旧 Run/session 可能在重启后落入 root-session 路径。native publish 失败会留下旧默认 resultRevision，Git captureScopes 只比较普通 status/inventory，explore pin 会复制整仓 states。

决定：

1. 集成撤销先解析当前父 authority。virtual 父在 gate 内做 branch CAS；materialized 父必须解析 execution directory、经 Documents resource gate 以 after→before 条件应用，并同步非权威 branch cache。gate 返回后重读父状态；目录已回收（`materialized: false`）时 WorkingBranch 重新成为 authority。任何 authority 缺失、漂移、竞争或观察失败都返回 needs-attention。纯 disk、virtual branch、branch→materialized 三条路径统一写 `undoing` intent，再执行条件 apply/CAS、观察 before；branch→materialized 只有磁盘与 branch cache 都到达 before 后才写 `undone`，启动对账区分仍为 after、已为 before 与两者都不是。
2. registry 持有 cascade admission fence；cascade 开始经 registry mutation tail 原子进入，create/start/restore 检查目标 Thread、父与祖先的 archived/cascading。dispatch 在准备后再次检查并清理 surface draft；尚未进入 lifecycle 的失败 Thread 可删除，已被 cascade 接管的 Thread 保留给该生命周期完成归档，不能与准备失败路径互删。
3. session-bindings 启动只扫描一次健康 catalog 并重建派生索引；坏索引覆盖重建，坏 workspace catalog 跳过且不遮蔽健康 catalog。binding 只指向 thread.activeRunId 的当前 Run，并按 sessionId 与 threadId 去重；历史 session 保留拒绝 tombstone，不得回到 root-session owner。
4. 有 workBranchId 的默认 merge 只消费本次 settled Run 成功发布的 native resultRevision；`resultCommit` 仅作无 branch 的遗留导入。每个新 Run 在创建时把上一默认 revision 记为 `inputRevision` 后撤下默认指针，因此会话创建失败等未进入 settle 的路径也不能复用旧结果。目录 inspect 或 native publish 失败时，在独立 Git snapshot 之前清理默认 revision 并投影 needs-attention/conflict；即使 Git snapshot 也失败，旧 revision 仍不可复活，显式 revision 仍可选择历史结果。Git baseline 捕获前后重列冻结 captureScopes，比较路径、类型、mode、symlink target 与 object/content identity；scope 漂移返回 retryable baseline-changed 并清理 branch。explore pin 接收 authorized roots、同一 signal/deadline，只固定 scope 内文本且可及时取消；不复制未消费的全量 states。当前 catalog 仍是平面 path map，所以会遍历元数据；Merkle 未实现前不把它宣称为 O(scope)。合法默认 mode 0 保持为 0。

影响：Host `durable-file-operation.ts`、IntegrationCoordinator、ThreadRuntime/Registry/Services、WorkingBranch lookups、explore query、workspace baseline 与 WorkingState store；设计/plan/status/architecture 的 3.4、3.4a、3.6 补充 D-224。D-220、D-221、D-223 的相关「已实施」索引状态改为 superseded in part。

状态：已实施；新增 integration materialized undo、drift、crash-reconcile、native result 失效、active Run owner、cascade fence、回收父分支基线与 scoped pin 定向测试。完整桌面重启、真实付费嵌套 Pi 与外部 provider 未测，3.4 / 3.4a / 3.6 继续 Partial；实际验证记录见 status。

### D-225 · 2026-09-11 · 3.2（根会话 edit 消费未保存缓冲）

类型：实现修正（D-089 写入侧对偶：同一正文权威，而不是拦住后要求用户先保存）

决定：公开 Pi `edit` / `write` / `apply_patch` 在 `document.branchWrite` 返回 disk 之后走共享 Host 方法 `document.surfaceWrite`。本轮固定 surface snapshot 拥有的路径按该固定正文匹配，写回同一 Document Registry 缓冲；核对 owner、generation、registration、document instance、`localEditRevision`、`baseRevision` 和正文 hash。用户在计划后继续编辑返回明确 stale/conflict，保留其正文，不写磁盘，不隐式保存。`write` 覆盖已打开的对应 surface 路径同样写缓冲。普通磁盘路径或不属于该 snapshot 的路径返回 `{ status: "disk" }`，沿用既有 journaled disk 写入。成功后 `applyOwnerEdit` 更新同一 snapshot，本轮后续 read/edit 看到新缓冲，不得 `observeAgentWrite` 把它 supersede 到磁盘。删除、NUL 二进制、symlink/mode 等 surface 无法表达的操作 unavailable/conflict。多文件 `apply_patch` 同时含 surface 与 disk 时复用 durable 回执、条件补偿和 grouped undo，按路径返回 applied/conflict/compensated/needs-attention 及实际 target；补偿 CAS 失败则为 needs-attention，不得覆盖用户后续编辑。disk 与 surface 的恢复记录用 `targetKinds` 区分真实写入位置。与固定草稿 read 共用 `harnessDocumentRead` 握手。

原因：D-085 让 read 看屏幕上的未保存正文，D-089 只拦住写盘。用户未保存时首次 `edit` 仍按磁盘匹配 `old_string`，会错误失败或后续实现选择错误写盘。正确对偶是写入与读取使用同一正文权威，而不是把未保存改动先保存。

考虑过的替代：(1) 继续 D-089 拒绝并要求保存——用户未决定保存，agent 无法完成与屏幕一致的编辑。(2) 为三个工具分别打补丁——匹配、写回、混合补偿和恢复记录会分叉。(3) 把混合 apply_patch 做成 Integration `applyDurableFileOperation`——会占用 integration 操作并阻塞其他集成，不是根会话权威。

影响：protocol `document.surfaceWrite`；Documents `surface-mutation.ts` / `applyAgentSurfaceWrite`；Harness router+services+`index.ts`；pi-host journal tools 与 `apply_patch`；设计 5.4/6.1、plan 0.7/3.2、status 窗口读取/3.2、architecture 4/5.1。

状态：已实施；验证见 status 窗口读取/3.2 与本轮 D-225 证据。

### D-227 · 2026-09-11 · 3.6（事实检索 Thread）

类型：问题与解法

背景：快速 explore 已能在一次调用内定位秒级事实。较长开放问题仍缺真实生产形状：角色目录有 `retrieval`，但没有 Host 校验的事实权威、冻结只读工具，也没有公开纵切证明父会话能 dispatch、等待并读到报告。

决定：

1. 公共入口仍是 `thread.dispatch(role: "retrieval")`。不新建任务系统、向量库、daemon 或隐藏会话。未配置 `models.retrievalAgent` 时 pi-host `resolveRoles` 省略该角色，Host 另拒绝无 `params.model` 的 retrieval dispatch，不借主模型。
2. 冻结 allowlist 为只读检索工具加 `submit_facts`：`read` / `grep` / `find` / `ls` / `explore` / `related` / `recall` / LSP 导航，以及 Host 已装配时的 `webfetch` / `websearch`。不含 bash / edit / write / apply_patch / dispatch。`carryBlocks: false`，不复制父完整对话。默认 `worktree: none`；脏 surface 草稿仍走既有 isolated 捕获，以便读草稿，不是为了写工作区。
3. 事实权威是 Host `thread.facts.set`。公开工具 `submit_facts` 仅当冻结 allowlist 含该名时注册，根会话看不到。Host 按冻结 scope 与 Documents 读取核对路径/1-indexed 行范围；scope 外来源进 `attempted.rejected`，不进入 facts。不存在的路径/越界范围不得标 `verified`。URL 仅 http(s)，且须本会话已存 OutputRef 才 verified。超 `harness.output.visibleBytes` 的摘录走现有 OutputStore。报告结构没有 recommendations / priority。
4. settle / cancel 时 Host 封印 `report.evidence`，覆盖模型 conclusion / changedFiles / deviations，避免建议漏进报告。lost 不是结算：保留 `pendingEvidence`，现有 resume 开新 Run 时按既有 `startRun` 清掉。wait / read_thread / Zone 2 读同一份封印报告。取消保留已核实 facts，completion 为 `cancelled`。

原因：不能只靠角色提示词约束只读、范围和“不要给建议”。工具、scope、来源验证和 Thread 权限必须在契约里成立。Retrieval 是可等待的 Thread 工作，与一次调用的 explore 重叠成第二个快速搜索会破坏产品边界。

考虑过的替代：(1) 给 retrieval 一个独立任务运行时——重复 Thread/Run/wait/cancel。(2) 把带写的 shared bash 标成只读并靠提示词约束——权限不真实。(3) 未配置时借主模型——违反模型槽位不变量。(4) 在 lost 时封印报告——会把未结算 Run 写成已交付，并与 `startRun` 清 pending 的既有生命周期冲突。

影响：protocol 角色目录 / `thread.facts.set` / `RetrievalEvidence`；Host `retrieval-evidence.ts`、`thread.facts.set`、registry seal、Zone 2 evidence；pi-host `submit_facts`；设计 6.1/9.2.2/9.3.5、plan 0.7/3.6、status 3.6 retrieval、architecture 4.4。

状态：已实施；验证见 status 3.6 retrieval。真实付费 retrieval 质量仅未实测。

### D-228 · 2026-09-12 · 3.2（纠正 D-225 正文身份、grouped undo 与耐久补偿）

类型：问题与解法

背景：D-225 让根会话写回同一 Registry 缓冲，但验收发现五处生产契约不成立：UI `bufferHash` 被拿去和序列化 snapshot 正文直接比较；补偿 undo 使用伪造的 `${operationId}:undo`；混合写入只记内存 Map；磁盘补偿固定 utf-8/无 BOM；`apply_patch` 在 `readSource` unavailable/stale 时回退磁盘再覆盖 surface。

决定：

1. `bufferHash` 是规范化编辑器 buffer 身份；snapshot `content` 是带原行尾的序列化文件正文。二者不得直接比较。SurfaceSnapshot 持久携带 `bufferHash`、`lineEnding` 和序列化正文。写回 Registry 前转换成编辑器规范形式；写回后的 snapshot 仍按文件行尾呈现。
2. apply 与 undo 使用同一个真实 `operationId`。一次 surface batch 只能整组撤销一次，不能按路径拆开同一 undo group。契约测试必须走真实 Document Registry / `attachLiveSurfaceCompleter`，禁止“看见 undo 就成功”的 mock。
3. 第一笔写入前把 intent、targetKinds、每路径 before/after 身份和阶段记入独立 `agent-mutation` 操作（复用 recovery operations / object references，不冒充 Integration）。取消、I/O throw、UI 断连、Host 中断进入条件补偿或 needs-attention；补偿使用新的 AbortSignal。启动对账只按可观察 before/after 判断；surface owner 不可用时标 needs-attention，不猜成功。
4. 磁盘成员保存并恢复真实 encoding、BOM、缺失/存在状态和 revision；补偿走 `RecoveryFileStore.applyState` 的原始字节，不重编码成 utf-8。
5. `apply_patch` 只有 `document.readSource` 明确返回 `source=disk` 时才能读磁盘。unavailable、stale、传输错误必须停止。整文件替换携带所读 surface revision/hash，应用前匹配。AbortSignal 贯通；部分写入后取消走上述耐久补偿。普通纯磁盘 `apply_patch` 公开行为保持不变。

原因：D-225 的产品方向成立，但身份、事务和补偿实现把编辑器规范正文、文件序列化正文和耐久操作记录混成同一套比较/存储，验收反例会写错缓冲或在已有写入后无记录地抛出。

考虑过的替代：(1) 继续比较 snapshot 原文与 `bufferHash`——CRLF/CR dirty 文件会假冲突。(2) 用 Integration `applyDurableFileOperation` 记根会话 mutation——占用 integration 操作并阻塞其他集成。(3) unavailable 时用磁盘正文算 patch——会在 Host 已声明来源不可用时覆盖 surface。

影响：Documents `surface-mutation` / `authority` / `surface-snapshot-store` / `agent-mutation-operation`；recovery `fenceUnfinishedOperations`；pi-host `apply_patch`；设计 5.4/6.1、plan 0.7/3.2、status 窗口读取/3.2、architecture 4、Documents DOCUMENTATION。D-225 相应部分在本条索引标 superseded in part。不改写 D-225 正文。

状态：已实施定向反例；完整桌面 Registry 与 Host 进程重启仅未实测。验证见 status 窗口读取/3.2。

### D-230 · 2026-09-12 · 3.6（纠正 D-227 事实权威与生命周期）

类型：问题与解法

背景：D-227 接通了可等待的 retrieval Thread，但验收发现生产契约不成立：来源存在被写成 claim `verified`；空 unknowns 被推断为 `complete`；`submit_facts.question` 可替换 Thread brief；`setPendingEvidence` 不绑定 runId，Documents 校验期间 settle/lost→resume 会把旧结果写入新 Run；封印报告保存 session-local ephemeral OutputRef；URL 用任意 OutputRef 背书且短 webfetch 不铸 receipt；source 状态随输入顺序变化；本地摘录不保存当时正文身份；嵌套 retrieval 因 `worktree: none` 回到根 live 工作区。

决定：

1. Host 只能证明 `source-checked` / `source-valid`，不能证明 claim 语义为真。协议、格式化、Zone 2、文档和测试统一使用这些名称。不新增正则建议过滤器或第二个 LLM verifier。「报告没有 recommendations 字段」可以保留。
2. 删除假 completeness。delivery 为 `delivered` / `incomplete` / `cancelled` / `unavailable`。`delivered` 表示 Host 接受了该 Run 的 `submit_facts`，覆盖由 facts/unknowns 自己表达。question 以 Thread brief 为权威。
3. `setPendingEvidence(workspaceId, threadId, runId, evidence)` 在同一 catalog mutation 内检查 `activeRunId` 与 Run outcome。旧 Run 在 Documents 校验期间 settle、cancel 或被新 Run 替换后，迟到结果必须拒绝。
4. 封印报告保存耐久 artifact/source 引用（`retrieval-evidence` object references），不保存 ephemeral OutputRef。父会话在子 close 与 Host 重开后经现有 `read_thread`（可 `offset`/`length` 分页）读同一证据正文。archive 保留引用；真正删除 Thread 时释放。
5. URL 来源必须有 Host 生成且绑定 exact final URL 与正文 hash/revision 的 receipt。短 webfetch 也铸 receipt。任意 OutputRef 不能给另一个 URL 背书。output 来源若接受 ephemeral handle，提交时先复制为耐久 artifact。
6. source 状态聚合与输入顺序无关；每条来源保留自己的 check。
7. 本地来源保存当时核对的 revision/contentHash 与耐久 excerpt。后续磁盘变化不得让报告只能指向已消失的旧 revision。
8. 从虚拟或物化父 Thread dispatch retrieval 时，读取父冻结有效状态：虚拟父复用 `effectiveState` 建只读虚拟基线；物化父固定其目录状态。不得因为 `worktree: none` 回根 live。根会话无草稿保持现有 live 语义；脏 surface 继续既有 isolated capture。

原因：D-227 的产品方向成立，但把来源核对比成语义为真、把提交齐全比成问题 complete、用 ephemeral handle 当跨会话证据、以及 retrieval 子读根 live，都会在验收反例里交付假事实或读到错误工作区。

考虑过的替代：(1) 继续称 `verified`——Host 不能证明 claim。(2) 新增第二个 LLM verifier 或正则建议过滤器——超出 Host 能证明的范围。(3) 另造第二个公共检索工具读证据——`read_thread` 已是父读报告入口。

影响：protocol `RetrievalEvidence` / `FetchResult.receipt` / `thread.read` 分页；Host `retrieval-evidence` / registry pending+runId / artifacts / webfetch receipt / nested baseline；pi-host `submit_facts` / webfetch；设计 6.1/9.2.2/9.3.5、plan 0.7/3.6、status 3.6 retrieval、architecture 4.4。D-227 相应部分在本条索引标 superseded in part。不改写 D-227 正文。

状态：已实施定向反例；真实付费 retrieval、完整桌面 Host 重启与授权 web 抓取仅未实测。验证见 status 3.6 retrieval。

### D-231 · 2026-09-12 · 3.4 / 3.4a / 3.6（受管 retrieval 输入与嵌套基线）

类型：问题与解法

背景：D-230 要求嵌套 retrieval 读取父线程的冻结有效状态，但验收发现当时的实现把虚拟只读 worktree 的 `path` 指向父或根工作目录。任何沿普通 worktree 生命周期进入的 inspect、Git 初始化、snapshot、reclaim 或失败清理都可能读取、重命名、提交或删除用户目录。持久 worktree 记录本身也可以声明任意路径，重启后缺少独立的 Host/backend 归属证明。

决定：

1. 嵌套 retrieval 在 dispatch 返回或入队前就固定 `worktree: isolated`，沿普通 `threadPrepareIsolatedBranch` 从父 WorkingBranch 有效状态或父物化目录建立 revision 0；不再用一条特殊的 live-path 虚拟绑定模拟冻结基线。
2. 虚拟执行目录由 Application Host 分配到 `{PIARIUM_DATA_DIR}/thread-scratch/<workspace-hash>/<threadId>`。`ThreadWorktree` 持久化绝对 `managedRoot`；create-worktree backend 也必须返回自己的受管根。运行时先验证目标及所有 staging/backup/result 邻接路径都规范包含在该根内，再要求 Host/backend 重新授权该根。当前进程刚创建过的根可直接使用；重启后的持久记录不能自证归属。
3. inspect、snapshot、materialize、setup、Git attach、reclaim、discard 等会读取或改变物化状态的入口都执行同一归属检查。旧记录缺 `managedRoot` 或根无法重新授权时拒绝动作并留给显式恢复，不猜路径属于 Piarium。
4. retrieval 分支是冻结的只读输入。LSP 需要真实路径时可以物化，并在独立目录里初始化 Git；settle、partial publish、result snapshot、Integration 与 automatic review 均不发布 retrieval 的目录变化，结束时只封印 evidence 并回收输入目录。
5. 物化父线程的捕获通过父执行目录解析出的 Documents workspace 取得 dirty barrier、正文与 writer 状态；owning workspace 仍只保存 catalog、WorkingState 与证据对象。

原因：隔离必须由实际路径和 backend authority 保证，不能靠角色提示或 `readOnly` 字段保证没有写入。让 retrieval 复用正常分支准备可同时固定 queued 基线、父虚拟新文件和父物化内容，而专门的 settle 分支确保这些输入不会成为可合并结果。

考虑过的替代：(1) 继续把 `path` 指向父目录但约定工具只读——无法约束 Git、LSP、扩展和生命周期清理。(2) 只检查路径字符串含 `.piarium/worktrees`——持久记录可伪造，符号链接和同名目录也会误授权。(3) retrieval 永不物化——会无故移除 LSP 等需要真实路径的只读能力。

影响：protocol `ThreadWorktree.managedRoot/readOnlyInput`；Host `thread-runtime` / `thread-worktree` / `worktree-ownership` / materialization switch / git backend；pi-host retrieval session；设计 9.2.5b/9.3.5、plan/status 3.4/3.4a/3.6、architecture 4.4。D-230 的嵌套基线实现由本条纠正，不改写旧正文。

状态：生产路径已接入并有定向/公开 faux SessionHost 证据；旧记录无受管根时会拒绝自动操作。完整桌面 Host 重启和真实付费 retrieval 仍未实测，3.4 / 3.4a / 3.6 保持 Partial。

### D-232 · 2026-09-12 · 3.2（agent-mutation WAL 与恢复可见性）

类型：问题与解法

背景：D-228 已引入 `agent-mutation`，但验收发现混合 surface/disk batch 仍可能先向编辑器发写入，再发现磁盘 expected identity 已漂移；磁盘写后到 after-state 入库之间崩溃没有可区分阶段；失败回执与无回执被一律当作不确定；补偿遇到一个冲突后会跳过其他可安全恢复路径；needs-attention 只留在数据库，恢复状态与 UI 不可见。另有一个只供测试读取、最多 32 项的非权威内存缓存。

决定：

1. 混合 batch 在同一 Documents resource gate 内先核对所有磁盘成员的实际字节 revision/hash；任何已知冲突都在 surface dispatch 前终止。expected hash 对磁盘原始字节计算，不把 CRLF/LF 规范化后冒充同一身份。
2. WAL 显式记录 external-dispatched、external-compensate-intent、external-safety-observed 与每路径 target-after。编辑器明确返回失败表示未应用，可安全关闭该路径；请求已发出但没有可认证回执才是不确定并进入 needs-attention。
3. 补偿逐路径继续执行：仍等于本操作产物的成员恢复 before；用户后来改过的成员保留并标 needs-attention。状态只能向更确定的终态单调推进，迟到回执不得把 needs-attention 降回 complete/aborted。
4. 启动 fence 与运行时恢复状态从持久 operations 读取 `agent-mutation` 的 needs-attention，并通过现有 Recovery UI 展示 operation/path/message。内存 Map 和无依据的 32 项限制删除；持久 WAL 是唯一跨调用/重启权威。
5. 当前 RecoveryFileStore 只能在磁盘写成功后捕获 target-after。若进程恰在写入与捕获之间崩溃，启动对账不得猜测写入内容，明确留下 needs-attention；这是现有实现的可见失败窗口。

原因：一批跨编辑器缓冲和磁盘的写入无法获得单一文件系统事务，但可以在同一资源序列化边界内消除已知竞态，并用写前 intent、认证回执和条件补偿把未知状态显式化。

考虑过的替代：(1) 先写 surface 再检查磁盘——会制造本可避免的部分应用。(2) 把明确失败也当 needs-attention——让可证明未写入的路径占用人工恢复。(3) 为诊断缓存保留固定条数——它不是权威且没有产品消费者。

影响：Documents `surface-mutation` / `authority` / `agent-mutation-operation`；recovery catalog/engine；Recovery UI；pi-host `apply_patch`；设计 5.4/6.1、plan/status 3.2、Documents/recovery DOCUMENTATION。D-228 的事务与恢复部分由本条纠正。

状态：定向恢复与 Registry 反例已接；完整桌面 Host 进程重启仍未实测。写入到 after-state 捕获窗口按本条保持 needs-attention，3.2 不标 Proven。

### D-234 · 2026-09-12 · 3.6（retrieval receipt、artifact 所有权与公开分页）

类型：问题与解法

背景：D-230 要求耐久证据与 URL receipt，但验收发现 receipt 可在普通 webfetch 上产生、ID 可由正文推导且没有 owning/session/thread/run authority；正文与 receipt 只在内存，Host 重开后无法核验。output artifact 在 catalog 接受前没有引用保护，提交/关闭竞态可被清理；Thread 删除也没有释放未提交 artifact/receipt。`read_thread` 协议虽声明分页，pi-host 工具未公开 offset/length，且读取会先整体载入大 artifact。

决定：

1. 只有当前已认证的 active retrieval Run 才能请求 receipt。receipt 使用随机 ID，绑定 owning workspace、session、thread、run、exact final URL、正文 hash/revision；正文和 receipt metadata 均进入 WorkingState 对象库并由临时 object references 保护。普通 webfetch 仍返回正文与来源信息，不铸 source-check 权威。
2. 本地/output 摘录一写入对象库就获得同 Run 的 temporary reference。`thread.facts.set` 先核验来源，再在同一 catalog mutation 绑定 pending evidence；promotion 事务建立 pending refs并释放对应 receipt/temporary refs。失败且 catalog 未提交时释放临时引用；startup/thread sync 只按 catalog 中 pending/sealed evidence 重建权威引用并清理过期临时对象。
3. 真正删除 Thread 时释放其 pending、sealed、temporary artifact 和 web receipt 引用；archive 继续保留已封印证据。receipt lookup 总是用当前 actor 派生的完整 authority，单独的 receiptId 不授权。
4. `read_thread` 在 pi-host 公开 `offset` / `length`，按 UTF-8 字节直接从耐久对象切片；默认页使用现有 `harness.output.visibleBytes`，不新增专用硬上限。结构化 report 保留引用/短摘录，大正文不先整体载入再裁切。
5. web fetch 的 caller cancel/截止信号贯穿 fetch、body reader、renderer 与 PDF 页读取；取消停止等待并不缓存为普通失败。网络库无法硬中断的迟到结果被丢弃。

原因：来源权威必须绑定实际 Run 与可重读正文，临时对象从创建到 catalog 接管之间也必须有所有者。分页应减少实际读取量，而不只是缩短最终字符串。

考虑过的替代：(1) 让所有 webfetch 都铸 receipt——扩大不必要的持久数据和授权面。(2) 只在 evidence 接受后引用 artifact——提交竞态会先清理正文。(3) 保留 session-local OutputRef——线程/Host 生命周期后不可读。

影响：protocol retrieval/receipt/thread.read；Host retrieval artifacts/evidence/webfetch/thread services/runtime；pi-host webfetch/thread tools；设计 5.1/9.3.5、plan/status 3.6、architecture 4.4、Harness DOCUMENTATION。D-230 的 receipt、耐久引用与分页实现由本条纠正。

状态：公开 faux SessionHost、持久对象重开、删除清理与取消反例已接；真实外部 web、完整桌面 Host 重启和付费 retrieval 质量仍未实测，3.6 保持 Partial。

### D-239 · 2026-09-12 · 3.4 / 3.4a / 3.10（用户释放旧结果与引用持久顺序）

类型：问题与解法

背景：目录可以回收，但历次 WorkingResult 独立持有内容引用，用户没有释放旧版本的入口。直接删引用还会暴露原 persist 的问题：
它在原子 JSON 成功前替换旧所有者，若写入失败，仍被旧目录使用的正文可能被回收。释放需要按实际依赖与耐久目录判断，而不是按年龄猜测。

决定：

1. 在已有线程卡片增加按需历史列表与释放确认。纯 DTO 位于 application-client，鉴权 Host 路由从 session 解析 owning workspace
   和 parent，再核对 Thread；不增加 Agent 删除工具。选择固定 branchId/resultRevisions，过期 branch 或任一被保护版本使整批拒绝。
2. 保护 branch head、Thread 当前结果、active/lost Run 的 inputRevision、活动/排队 review 及未结束或冲突 Integration 的输入。
   包括 review 已创建而 Run 尚未启动的窗口。当前分支、草稿基线、报告、转录及其他所有者的引用保留；本次不删除整个 Thread。
3. 锁顺序为该 Thread lifecycle → owning storage 独占 lease → Registry 快照队列。快照检查与版本目录移除完成后先释放 Registry
   队列，再收集无主对象，不持有它等待文件遍历。完成 Integration 拥有独立 safety/target，undo 不重新读取源 WorkingResult。
4. 删除先原子持久化 WorkingState JSON，再移除 thread-result 引用。普通 WorkingState 写入先保留原所有者、以临时
   working-state-write 所有者保护新增字节；新目录耐久后才替换正式引用。中断时两边的必要正文都在，启动和显式释放按已解析目录
   对账派生引用；先使观察到的目录耐久，再移除旧引用。缺失/损坏目录保留未知所有权并报告，不自动当成空库。
5. API 分开返回 released/missing revisions 与 cleanup complete/failed。目录已删除而清理失败时如实报告、允许同请求重试；
   失败不报零字节成功。列表大小是该版本唯一引用内容的逻辑字节，可能与其他版本共享；实际回收量来自对象删除结果。
6. UI 禁选受保护版本、冻结确认、丢弃换目标后的迟到响应；清理失败的重试请求在同一面板关闭重开后保留。没有新增扫描循环、
   保留年限、默认存储配额或 Thread 自动删除策略，WorkingState schema 保持 3。

验证与边界：真实 Registry/WorkingState/SQLite/Recovery engine 经公开鉴权路由覆盖保护重查、共享对象、原子选择、条件失败与
重试；已完成 Integration 在释放原版本后仍可撤销。JSON 写失败/rename 后失败与 SQLite 引用清理中断有定向测试，UI 有实际组件
交互测试。完整 Electron 浏览器点击、真实卷耗尽和进程级电源故障未实测，既有 3.4/3.4a 的其他 Partial 原因不因此关闭。

### D-242 · 2026-09-12 · 3.10（整条 Thread 删除：UI → 鉴权路由 → 生命周期级联）

类型：问题与解法

背景：用户只能归档 Thread；D-239 提供选定旧结果释放但明确不含整条删除。Thread 行、其 Run 行、Pi 会话文件、
WorkingState 分支/结果/草稿基线、受管目录之间没有一条能完整移除的链——删除记录而留下转录或目录会成为无记录占用。

决定：

1. 入口与归档对称：线程卡片两步确认按钮 → `DELETE /api/harness/sessions/:sessionId/threads/:threadId`（requireAuth）→
   `runtime.deleteUser`。删除走与归档相同的级联形状：`beginCascade` 标记、后序后代各自在自己的 lifecycle turn 删除、
   目标最后；祖先被级联时后代的 restore 仍被拒。
2. 每节点顺序：停活 Run（abort+close 绑定会话、`endRun(cancelled, "deleted by user")`——不铸 partial result，因为级联随即
   释放该修订）→ 删除线程拥有的全部 Pi 会话（`options.deleteSession` → `piRuntimeBroker.deleteSession`：worker、
   转录文件、metadata；其 delete coordinator 的按会话归档对本级联是安全空操作）→ WorkingState 租约内释放该分支全部
   结果修订、删 `workBranchId` 分支头与 `manifest.draftBaselineId` 草稿基线并 collect 无主对象 → 删除受管目录 →
   `registry.removeThread` 原子移除 Thread+Run 行、清游标、解绑这些 Run 的 session binding 并通知 `onThreadRemoved`。
3. 目录删除不适用 `keep_worktree`（记录已删，留下的目录成无记录占用）；但 ownership 断言与 user/writer guard 不变，
   `reclaim` 失败保留 Thread 记录并报原因供重试，不删除仍由线程引用的对象。没有 `deleteSession` 接线而线程确有会话时
   拒绝删除，不留下孤儿转录。
4. 与 D-239 的边界：release 删选定修订保当前分支；delete 删整条线程连分支一起。会话删除路径不变（删除父会话仍归档
   线程，不是删除线程）。

验证与边界：`thread-routes.test.ts` 覆盖 DELETE 的鉴权（401 不进 runtime）、作用域解析与 404；`thread-runtime.test.ts`
覆盖级联（后代先删、活 Run settle、会话清单删除、分支/修订/基线释放、目录回收、行移除）与目录失败保记录。
`i18nParity` 十语言同步。未实测真实 broker 会话文件删除（`deleteSession` 是 broker 的既有生产路径）与 Electron 点击链。

### D-243 · 2026-09-12 · 3.4a（Git filter/LFS 与执行位适配层）

类型：问题与解法

背景：设计（9.3.4 尾部）要求"Git 的过滤器、LFS 与换行转换由适配层处理，记录实际工具所见版本"，此前没有这层：
`importGitPathsToStore` 把仓库 blob 原样塞进对象库——LFS 文件存的是指针字节、CRLF 工作区的文件存的是 LF blob、
自定义 clean/smudge 完全不执行——材料化或比对出来的字节不是工具在真实 checkout 里看到的内容；`captureGitPathStates`
在 Windows 把 index 的 `0o755` 折叠成 `0o666`，执行位永久丢失。

决定：

1. 新建 `working-state/git-adaptation.ts` 为唯一转换层。`check-attr -z --all` 一次探测所有目标路径的
   filter/text/eol/working-tree-encoding。
2. `filter=lfs`：解析指针 blob（`version/oid sha256/size` 三段格式），从 `git rev-parse --git-common-dir` 下的
   `lfs/objects/aa/bb/<oid>` 读本地对象并 sha256 校验；缺失或损坏回退指针字节本身。有意不走 `git lfs smudge` 的
   下载路径——导入是本地操作，不触网；指针字节正是 checkout 在缺对象时写出的内容，worktree `git status` 依然干净。
3. 其他 filter、text/eol、working-tree-encoding：`git cat-file --filters --path=<p>` 跑配置好的 smudge 侧，与 checkout
   同语义；过滤器进程失败时回退原始 blob（checkout 的同样降级）。
4. 执行位：`captureGitPathStates` 与 `captureDirectory`/`publishDirectoryResult`（经 `indexModes` 选项）在 Windows 用
   `ls-files -s` 的 index mode（100644/100755）恢复 0o644/0o755，POSIX 保持 lstat 真值。`stateIdentity`/`sameState`
   在 win32 把普通文件/目录 mode 归一到只读/可写二维——这是该平台唯一可观察的维——所以 index 恢复的 0o755 与 fs
   捕获的 0o666 不产生幻影漂移，POSIX 上两个 mode 仍然是真实的不同。
5. `inspectGitBaselineInventory` 附带 `indexModes`（`ls-files -s` 已采集），`prepareIsolatedBranchCore` 与两条结果发布
   路径经 `inspectIndexModes` 提供给捕获。

验证与边界：`git-adaptation.test.ts` 真实 Git 仓覆盖 LFS 命中/指针降级/eol smudge/无 filter 原样/失败回退/属性探测/
index 执行位/跨平台比较；`git-migration.test.ts` 断言 0o755 真值。有意不做：`git lfs` 远端下载、Windows symlink 提权
创建测试、自定义 filter 的真实双向运行（失败回退已覆盖）；非 Git 目录不受影响。

### D-244 · 2026-09-12 · 3.4a（CoW/reflink 材料化后端）

类型：问题与解法

背景：设计（9.3.4）允许非 Git 目录"copy/CoW"等价记录，但实现里所有复制都是 `copyFile` 全量字节复制；材料化与 recovery
恢复也都经 `writeFile`/`copyFile`。对象库文件与目标通常同卷，reflink 可以把字节成本变成元数据成本——前提是能如实分辨
是否真共享了 extent（Node 的非 FORCE `COPYFILE_FICLONE` 会静默降级）。

决定：

1. `workspace/reflink.ts` 的 `copyFilePreferReflink`：先试 `COPYFILE_FICLONE_FORCE`，命中即真实 reflink；返回码属于
   不支持集合（ENOSYS/ENOTSUP/EOPNOTSUPP/EINVAL/EPERM/EACCES/EXDEV）时退化 `copyFile` 并返回 `"copy"`；
   ENOENT 与其他错误原样上抛（缺源不是"不支持"信号）。
2. 生产接线点统一走该原语：`copyDirRecursive`（非 Git worktree 准备 + `.baseline` 快照）、`copyUntracked`、
   merge/rematerialize 文件复制；`materializeWorkingState` 新增 `objectPathFor`，对象库→目标 reflink/复制并计入
   `MaterializeResult.cow.{reflink,copy}`；recovery `replaceFile` 的对象→临时文件复制也 reflink，保留原子 rename 语义。
3. 跨卷或 NTFS/ext4 上如实 copy——backend 报告让测试与调用方看到真实行为而非"声称 CoW"。

验证与边界：`reflink.test.ts` 覆盖真实 fs、注入失败退化、缺源不重试、材料化对象路径命中与兜底、计数准确性。
未实测真实 ReFS/APFS 卷（环境所限）；extent 共享的正确性由 `FICLONE_FORCE` 语义与字节级结果断言保证。

### D-245 · 2026-09-12 · 3.4a（WorkingState Merkle 结构共享）

类型：问题与解法

背景：path→state 映射在 catalog 里逐分支/逐结果完整展开，每次写都 `structuredClone` 整棵文档树再整体序列化——
`publishStates` 产生的 `pathStates` 与 `branch.deltas` 本就是同一映射却被序列化两遍；`treeIdentityFromStates`
每次全量重哈希。

决定：

1. `working-state/state-trie.ts`：按路径段的持久哈希 trie。节点 = `children` + 可选 `self`（允许 `a` 与其后代
   `a/b` 同为映射键——删除 tombstone 与类型翻转路径真实存在）。`trieSet`/`trieRemove` 路径复制共享未变子树；
   `trieDiff` 按哈希相等跳过共享子树；`trieIdentity` 为根哈希。
2. Catalog schema 4：所有路径映射序列化为 `{trie: <root>}`，节点进共享 `stateNodes` 池——跨分支、结果、
   草稿基线的相同子树只写一次；池每次 persist 由活根重建，天然回收孤儿节点。v1–v3 平铺映射照常解析，
   下次 persist 自动升级。
3. 写路径 `clone(this.document)`（structuredClone 整树）改为 `nextDocument()` 结构共享——只复制被替换的容器；
   `publishStates` 让 `result.pathStates` 与 `branch.deltas` 共享同一对象，持久化坍缩为同一 trie 根。
4. `WeakMap<Record, StateTrie>` 按映射引用缓存——映射对象在写路径上只换不改，未变映射的序列化是 O(1)。
5. `treeIdentityFromStates` 改用 trie 根（仍是 `sha256-` 格式）；旧 verification 记录里的树哈希与新算法不可比，
   属一次性咨询性噪声，不影响绑定判断的布尔语义。

验证与边界：`state-trie.test.ts`（共存路径、子树共享、删除剪枝、diff、持久化形状与重开一致）；
既有 working-state/store/view/draft/virtual-write 套件回归。局限：内存内 `WorkingBranch.baseState` 等仍为平铺
Record（公开类型不动），trie 用于持久化去重与身份——跨重启的 map 级共享收益在磁盘与序列化侧。

### D-248 — D-242 返工：耐久整条 Thread 删除

背景：D-242 接入了 UI 两步确认 → 鉴权 DELETE → 级联删除，但验收发现六处缺陷——
`releaseThreadStore` 用 shared lease 做 GC（真实引擎不会提供 collector）、
session → WorkingState → directory → registry 顺序无持久阶段（任一中断留半删除）、
broker 删除触发 archive coordinator 失败后可能清掉 report、
`KnowledgeStore.deleteSession()` 无生产调用方、
retrieval evidence cleanup 是 registry 删除后的 observational callback（失败被吞）、
UI 确认未说明子孙 Thread、transcript、结果和目录会一起删除。

决定（supersedes in part D-242 的 lease 模式、阶段化、knowledge 清理与 UI 确认
部分；D-242 的 post-order 级联、ownership 断言、cascade admission fence 保留）：

1. **WorkingState 修改与 GC 使用 exclusive lease**：`releaseThreadStore` 从
   `"shared"` 改为 `"exclusive"`，确保 `collectUnreachableObjects` 在独占租约下
   执行——真实引擎不会在 shared lease 下提供 collector。
2. **阶段化删除与结构化结果**：`deleteOneNode` 分四阶段（sessions → store →
   directory → registry），每阶段失败返回 `DeletionNodeResult`（status: complete
   / objects-pending / retryable / needs-attention + phase + error）。`deleteUser`
   聚合所有 node 结果，worst-status-wins。不再 throw——调用方根据 status 决定
   重试或 needs-attention。
3. **幂等重试**：`deleteOneNode` 对已删除 thread 返回 complete（registry 返回 null）。
   `deleteUser` 在进入 cascade 前检查 thread 是否已存在，不存在则直接返回 complete。
   已删 session、已移除目录、已释放引用都能从观察事实继续。
4. **KnowledgeStore.deleteSession 接入生产**：新增 `deleteKnowledgeSession` option，
   在 `deleteThreadSessions` 中对每个 sessionId 调用 `options.deleteSession` 后
   调用 `options.deleteKnowledgeSession`。生产接线在 `index.ts` 通过
   `getKnowledgeStoreForSession` 获取 owning workspace 的 knowledge store 并调用
   `store.deleteSession(sessionId)`。accepted workspace/user knowledge 保留。
   失败不被吞——knowledge 清理失败会 surface 为 retryable。
5. **UI 确认文案明确范围**：所有 10 个 locale 的 `harness.threads.deleteConfirm`
   更新为明确包含"子孙线程、Pi 对话、结果历史、受管目录"。

验证：`thread-runtime.test.ts`（session 失败返回 retryable；store 失败返回
objects-pending；directory 失败返回 retryable；幂等重试不重复调用 deleteSession；
deleteKnowledgeSession 被调用；exclusive lease 验证）；既有 58 项 thread-runtime
套件回归通过。

### D-249 — D-243 返工：Git filter/LFS/EOL 固定修订

背景：D-243 接入了 git-adaptation 层，但验收发现六处缺陷——base/result 转换共用了
当前 result worktree 的 `.gitattributes`（live 配置变化会改变固定结果）、
`probeGitAttributes` 失败被 catch 成空属性继续成功、required filter 失败返回 raw blob
而非 fail/unavailable、`filter=lfs` 绕过了真实 process/smudge/skip-smudge 配置、
fingerprint 使用 `sameState` 的 Windows 比较语义使 0644/0755 确定性碰撞、
捕获期间 `100644 ↔ 100755` 改变不触发 baseline-changed。

决定（supersedes in part D-243 的属性来源、filter 失败处理、LFS smudge 路径与
fingerprint mode 语义；D-243 的 check-attr 探测、cat-file --filters smudge、
index mode 恢复与 win32 mode 归一比较保留）：

1. **base/result 各自绑定 commit 的属性**：`probeGitAttributes` 新增 `commit` 参数，
   使用 `check-attr --source=<commit>` 从 commit 的 tree 解析属性，而非当前 worktree
   的 `.gitattributes`。`importGitPathsToStore` 传入 commit。text/eol 转换改为
   in-process（基于探测到的属性做 LF↔CRLF），不再依赖 `cat-file --filters`（后者
   用 live worktree 的 `.gitattributes`）。
2. **probeGitAttributes 失败必须传播**：`importGitPathsToStore` 移除
   `.catch(() => new Map())`，属性探测失败直接抛出——不能在不知道是否有 required
   filter 的情况下继续存储 raw blob。
3. **required filter 失败必须 fail/unavailable**：`smudgeBlobForWorktree` 对
   `filter=lfs` 先尝试 `cat-file --filters`（尊重 `GIT_LFS_SKIP_SMUDGE`）；失败时
   若 `GIT_LFS_SKIP_SMUDGE=1` 则探测本地 LFS 对象库，否则抛出
   "Required LFS filter failed"——不返回 raw blob。
4. **filter=lfs 尊重 process/smudge/skip-smudge 配置**：先走 `cat-file --filters`
   （运行配置的 smudge process，尊重 `GIT_LFS_SKIP_SMUDGE=1`）；仅在 skip-smudge
   模式下才直接探测本地 LFS 对象库（离线安全，不下载远端对象）。
5. **fingerprint 使用完整 mode**：`stateIdentity` 改用 `persistentMode`（始终返回
   完整 mode），不再用 `comparableMode`（Windows 归一为 0o444/0o666）。`sameState`
   仍用 `comparableMode` 做盘面比较。持久哈希、trie 节点哈希和 fingerprint 在所有
   平台上区分 0644 与 0755——捕获期间 `100644 ↔ 100755` 改变触发 baseline-changed。

验证：`git-adaptation.test.ts`（base 无 eol、result 新增 eol=crlf；base/result 相反
属性；required LFS filter 失败抛出；GIT_LFS_SKIP_SMUDGE=1 缺失对象降级为 pointer；
check-attr 失败抛出；stateIdentity 区分 0644/0755；sameState 在 Windows 仍相等）；
既有 git-migration、state-trie、working-state-store 套件回归通过。

### D-250 — D-244 返工：CoW/reflink 完整性与可观测性

背景：D-244 接入了 reflink 后端，但验收发现四处缺陷——从内容对象 reflink/copy
前未验证 byteLength + SHA-256（损坏对象会进入执行目录）、EACCES/EPERM 被当作
"不支持 reflink"并退化普通 copy（权限/策略错误被静默绕过）、MaterializeResult/backend
统计只在 helper 测试里存在未到达生产消费者、目录型 copyIgnored/capture scope 仍用
递归 fs.cp 绕过逐文件复制原语。

决定（supersedes in part D-244 的错误分类与可观测性；D-244 的 FICLONE_FORCE+
真实 backend 报告、object-path reflink、recovery replaceFile reflink 保留）：

1. **对象完整性验证**：新增 `verifyObjectIntegrity`，在 materializer 从 object path
   reflink/copy 前验证 byteLength + SHA-256。损坏对象抛出而非进入执行目录。哈希比较
   归一化 `sha256-` 前缀以兼容内容寻址存储格式。
2. **EACCES/EPERM 是权限/策略错误**：从 `REFLINK_UNSUPPORTED_CODES` 移除 EACCES/EPERM。
   只有平台级"不支持 clone"或"跨卷"错误（ENOSYS/ENOTSUP/EOPNOTSUPP/EINVAL/EXDEV）
   退化普通 copy。EACCES/EPERM 直接传播——调用方知道 copy 被拒绝而非静默退化。
3. **CoW 统计到达现有消费者**：store 的 `materializeResult`/`materializeStates`
   返回 `MaterializeResult`（含 `cow` 统计）；runtime 的 restore 和 materialization
   switch 路径捕获 cow 统计存入 `cowByThread`；`inspectSpace`/`occupancyFor` 通过
   `ThreadOccupancy.cow` 字段（扩展现有测量，非新增看板）暴露给现有空间消费者。
4. **目录型复制已用逐文件原语**：`copyDirRecursive`/`copyUntracked` 已使用
   `copyFilePreferReflink` 逐文件复制（D-244 已完成），无 `fs.cp` 递归绕过。

验证：`reflink.test.ts` 12 项（损坏对象拒绝、EACCES/EPERM 传播、EXDEV 退化、
backend 汇总、verifyObjectIntegrity）；既有 materializer、working-state-store、
state-trie、thread-runtime 套件回归通过。

### D-251 — D-245 返工：生产级 Merkle WorkingState

背景：D-245 引入了持久哈希 trie，但验收发现多处缺陷——`trieSet`/`trieRemove`
每次复制整个 nodes Record（O(n) per set，`trieFromEntries` 近似 O(n²)）、加载时
未核验 node key 与内容哈希、未检测缺节点/循环/malformed state、node hash 使用
`sameState` 的 Windows 比较语义（0644/0755 确定性碰撞）、`treeIdentityFromStates`
每次从平表重建 trie 而非用现有 root。

决定（supersedes in part D-245 的 trieSet/remove 实现、加载验证与 identity 来源；
D-245 的持久 trie 结构、共享 node pool、schema 4、structural sharing 保留）：

1. **O(1) 单路径更新**：`trieSet`/`trieRemove` 改用 prototype chain over input
   nodes——新节点写入 own properties，未变节点通过原型链查找。单次 set 创建
   O(depth) 新节点，不复制整个池。
2. **O(n·depth) 初始建树**：`trieFromEntries` 改用线性 builder——排序 entries 后
   一次性构建嵌套结构，再 bottom-up 哈希。不再循环调用 `trieSet`。
3. **加载时完整性核验**：新增 `verifyTrie`，在 `parseStateMap` 中调用。核验每个
   node 的内容哈希等于其 key、所有子引用可解析、无循环。损坏/缺失/循环 trie
   抛出而非静默当空树。
4. **平台无关持久 identity**：node hash 使用 `stateIdentity`（含完整 mode），不使用
   `sameState`（平台比较语义）。0644/0755 同内容同路径产生不同 roots。
5. **`treeIdentityFromStates` 仍用 trie root**：保持现有实现（`trieIdentity(trieFromRecord(...))`），
   但底层 `trieFromRecord` 现在是 O(n·depth) 而非 O(n²)。

反例验证：`state-trie.test.ts` 13 项——0644/0755 不同 roots、篡改 node 检测、
缺失 node 检测、自引用 cycle 检测、有效 trie 通过、兄弟分支共享未改子树、
trieSet 创建 O(depth) 新节点（<10，非 O(pool)）、500→1000→2000 线性扩展
（ratio < 8，非 O(n²) 的 ~16x）；既有 working-state-store、thread-runtime 套件
回归通过。

### D-285 · 2026-09-16 · 3.5–3.7 / 3.10 / 3.18（以工作为中心的可续做线程）

类型：默认值调整

背景：现有Thread/Run、固定结果、WorkingState与Integration已能承载真实成果，但公开dispatch必须选角色，模型/工具/工作区
模式绑在角色中；send只接受直接子active/running，不能继续settled实现线程；并发按父节点分别计算，等待不让出名额。
用户接受GPTpro关于任务线程、定向通信和分段成果的方向，并指出旧线程的上下文可能大半过期，复用历史也会浪费。

决定：

1. 主线亲自负责整体理解、关键实现与验收；按独立成果、依赖或不同解法展开线程。普通工具并行与多agent并存，不先建
   planner/manager层、永久团队或DAG。可以以更多调用换时间/探索广度，不只优化主线token。
2. 普通dispatch以task为核心，preset可选，默认明确继承当前模型。现有快捷实现/困难实现/前端/检索/审查预设保留，模型
   来自用户槽位或明示inherit；不把任意模型永久称为便宜/强，不配置专用槽位也不冒充已绑定。
3. Thread保留工作身份与成果，Run冻结当次模型/工具/权限/scope/工作区及输入来源。只读调查转实现可留同Thread，通过新Run
   获得实际授权。写入工作默认独立WorkingState并按需物化，shared显式选择，不由“简单任务”推导共享。
4. 新线程支持task/inherit，继承仅固定派发时实际可用摘要和原文，不恢复全部旧历史、不复制未完成工具执行或裸句柄权限。
   已有相关工作continue；工作延续但背景过期fresh；无关任务新Thread。fresh保留成果、文件与旧转录，按当前规则构造新输入，
   不强制再总结全部历史、不增加新鲜度评分或周期清洗。通用上下文补充见D-286。
5. 复用send作定向通信，父子树管责任，同根已授权的父子/兄弟可交流。Host产生实际发送者；inform投递信息，request请求
   执行，replyTo满足明确等待时恢复一次。普通进度留UI，通知/致谢不无条件唤醒；不靠正则或LLM判消息是否值得处理。
6. 同根嵌套共享用户配置的委派执行名额，默认12可调；父等待依赖让出名额，恢复/续做/显式review与dequeue同样准入。
   会话/进程/文件writer生命周期保持，等待不冒充退出或可回收，不顺手增加全workspace硬上限。
7. 同Thread发布R1、父使用、原线程续做R2，R1按修订仍可读取/集成。代码/表格/报告直接可用，不统一压成极小摘要或裸句柄。
   已启动依赖线程必须显式纳入选定父变更，沿三方Integration保留自身delta并记录新基线；消息和fresh均不等于代码同步。
8. 自动review默认关闭，用户明确enabled/gate保留。实施者正常验证、主线关键验收和按需独立review保持，结果/Run绑定不变；
   不固定追加检查链。线程面板以任务/实际成果呈现，查看历史不自动执行，continue/fresh影响可见，普通横向对话不广播。

原因：复用相关理解与真实成果可以减少交接，线程连续性不必绑定上下文永久累积。把消息、执行请求与文件集成分清，才能使
局部依赖直接解决，同时保留整体工作归属。缓存是输入优化，不是将过期背景带入每次调用的理由。

考虑过的替代：永久职业绑定不适合任务阶段变化；全部消息经主线转述会增加搬运；默认群聊易将过程灌满上下文；所有新任务
沿旧上下文续做会反复读取过期材料；只把send的状态门放宽不能恢复真实Run、结果或执行准入；只发接口变更消息不会更新代码。

影响：设计2/5/8/9/12，plan 0.7/3.5–3.7/3.10/3.18A–E，status与architecture目标说明。D-028的角色绑定、D-055的仅blocks
背景、D-207的自动review默认、D-215的特定角色嵌套/单向通信目标由本条部分取代；权限、结果绑定、级联与Rust资源权威保留。
参考上下文两种起点：[LangChain](https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness)；
任务结构与协调的经验：[Anthropic](https://www.anthropic.com/research/multiagent-systems)。这些不构成Piarium质量/性能结论。

状态：部分实施（3.18A已落地）。dispatch已改为`task`必填、`preset`可选，普通派发继承当前模型与活动工具，shared仅显式
选择，Run冻结模型/工具/权限/scope/工作区/prompt片段/inputOrigin（task/inherit），Thread持久化与UI投影改用`preset`，
自动review默认关闭。仍待实施：continue/fresh输入、定向消息语义、同根共享执行准入与分段成果；send仍只收直接子
active/running，并发仍按parent分别统计，等待仍不让出名额。本次不新增付费模型评测前置或固定审查轮数。

### D-287 · 2026-09-16 · D-284–D-286 验收收口

类型：问题与解法

决定：上下文原文保留、Thread 消息、执行准入和物化 baseline 更新都以各自真实提交边界收口。Pi 的 active context
产生 observation receipt、材料修订和同 Thread 旧 Run 的历史授权；Host 只在响应或 Pi 输入实际接受后推进 cursor/message
状态。Run admission 与 starting Run 在同一 catalog mutation 中完成，spawn/resume/restore/continue 消费该 Run 的冻结配置。
已物化 baseline 更新用 staging branch + Rust durable Integration + 整目录复核 + child branch CAS，并由持久 handoff 阻止
publish/resume/restore/reclaim 越过未决状态。

原因：审计反例表明原实现多次把“准备完成”当作“消费完成”：先计数后 startRun、先 resolved 后 send、先 cursor advance 后
响应、先目录 apply 后 branch CAS。测试 helper 和字段存在不能证明这些跨域状态转换。把接受、执行和确认放回实际权威后，
失败能保留旧结果、原文和用户磁盘内容，也不需要 keeper、第二历史库、TS writer 或固定重试次数。

考虑过的替代：内存锁不能承担崩溃后的消息或物化身份；清空全部 cursor 会重复注入仍在上下文的材料；让 fresh 访问任意
session 会扩大历史权限；固定重试 CAS 会掩盖并发写者；为了测试 double 保留旧 reset/fallback 会形成第二语义。均不采用。

影响：D-284–D-286 的实现状态由本条验收修正。新增 request-level context boundary、retained-context receipts、同 Thread
`history(run)`、Pi passive notify/native request receipt、根级原子 admission、固定 delivery 读取和 materialized baseline
handoff。状态与证据见 status 2.4A/B、2.6A/B、3.18A–E 以及 Harness/Kernel/Recovery
模块文档。

状态：已实施并完成定向验收；真实付费 provider 质量、完整 packaged 点击链、其他平台真机和物理断电没有由本条外推。

### D-339 · 2026-10-05 · 多 Agent 协作收敛

类型：问题与解法

决定：常规子 Agent 收敛为 Worker 和检索，主 Agent 默认亲自推进并持续负责整体设计、关键实现和综合整合。
同任务成员可以定向通信、发现并按范围互读工作记录；等待由事件或可选期限恢复。
代码协作以一次提交选定文件或改动片段到目标为入口，底层固定来源和应用依据，不要求先手动发布版本再拉取。

原因：过细的固定角色增加配置和维护成本，局部任务完成不保证整体实现一致。
已有消息、原生工作状态和合并能力可以支持协作，但主线休眠后的自动恢复、同级互读和精细代码提交仍有缺口。
整个结果集的合并不适合频繁交换局部修改，会引入不相关内容和冲突。

考虑过的替代：独立的常驻调度/合并 Agent 需要再次传递全局背景；主线只分派和读报告会失去综合判断；
周期性让模型查状态产生无效工作；所有代码交流先发布整份结果再拉取增加步骤且粒度不足；
直接覆盖同伴目录不能保留其并发修改。采用现有权威上的事件接续和选定补丁提交。

影响：修订 D-285 中常规预设继续保留的目标，并扩展其工作记录可见性与局部协作合同。
Thread/Run、Pi 会话、Rust WorkingState/Integration、Documents 权威不变；科研、Bot 专有能力和用户配置不据此删除。
完整合同及源码现状见 [agent-collaboration-design.md](../design/agent-collaboration-design.md)，
入口已回写 agent-harness、harness-verification、development、文档索引及 status。

状态：2026-10-06 已实施并接线。Worker/检索、同任务互读、普通主线持久等待、选定代码提交和回执 UI、源基线推进及 Git 基线复用已交付。相关行为回归及真实 Rust 分支 CAS/重启回执验证通过；未打包，付费模型协作质量与完整 UI 点击流程未验证。
