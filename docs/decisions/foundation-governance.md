# 决策分卷：基础设施、治理与交付政策

范围：0.x 基础契约、交叉治理（测试卫生、日志治理、执行规则）、交付政策、回放/测量规范与阶段小结。

本卷是 [decisions/README.md](README.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

## 阶段小结 · 阶段 1

本节原为阶段 1 的状态快照（模块 / 接线 / e2e 断言表），按 D-030 已整体迁入 [status.md](../status.md)「历史快照：阶段 1 小结」。它曾存在于 1.11 交付点（提交 `9494a195` 前后）。

### D-001 · 2026-09-03 · 0.1
类型：实验结果
决定：Pi 版本已对齐在 0.84.3，无需变更；计划中"node_modules 为 0.83.0"的描述是写作时的旧状态。
原因：`packages/pi-host/package.json`、`scripts/cloud-runtime.bun.lock`、`docs/design/security.md` 三处均为 0.84.3，`node_modules` 中 0.84.3 已安装且可用。
考虑过的替代：无。
影响：0.1 的版本对齐步骤直接通过，进入钩子形状复核。所有钩子形状（`before_agent_start` 可返回 `{ message, systemPrompt }`、`session_before_compact` 含 `preparation/branchEntries/reason` 且可返回 `{ compaction, cancel }`、`session_compact` 含 `compactionEntry`、`tool_result` 可替换 `content/details/isError`、`tool_call` 可返回 `{ block, reason }`、`turn_end` 含 `turnIndex/message/toolResults`、`before_provider_request` 含 `payload`、`ToolDefinition` 含 `promptSnippet/promptGuidelines/executionMode`）在 0.84.3 的 `types.d.ts` 中核实成立。`customTools` 同名覆盖由 `workspace-mutation-journal.ts` 的既有实现验证。`SessionBeforeCompactResult` 和 `ToolResultEventResult` 未从顶层包导出，编译期断言改用 `SessionBeforeCompactEvent` / `ToolResultEvent` 的事件形状验证。
状态：已实施

### D-002 · 2026-09-03 · 0.2
类型：问题与解法
决定：`changesForEntries` 从所有 checkpoint（包括 incomplete）收集 journaled 变更，而非只从 `status === 'ready'` 的 checkpoint 收集。
原因：一个 turn 可能同时有 journaled 写入（`write`/`edit`）和 unjournaled shell 变更。原实现只从 ready checkpoint 收集变更，导致 incomplete checkpoint 中的 journaled 路径被丢弃，coverage 错误地降为 `none`。正确行为是：incomplete checkpoint 中的 journaled 路径仍然可恢复，只有 unrecorded 路径不可恢复。因此 coverage 应为 `partial` 而非 `none`。
考虑过的替代：(1) 只从 ready checkpoint 收集，incomplete checkpoint 的所有路径都视为不可恢复——错误地丢弃了可恢复的 journaled 路径。(2) 把 incomplete checkpoint 拆成两个虚拟 checkpoint——过度复杂且无存储支撑。
影响：`packages/web/application-host/lib/recovery/journal-engine.ts` `changesForEntries`；`engine.test.ts` 新增 `partial` coverage 测试用例。
状态：已实施

### D-003 · 2026-09-03 · 0.2
类型：问题与解法
决定：范围内存在任何非 ready checkpoint 时 coverage 不能是 `ready`，即使 `uncoveredPaths` 为空。新增 `uncoveredReasons: string[]` 字段到 `WorkspaceCombinedRecoveryPlan`。
原因：worker 退出 / host 停止 / `observationComplete=false` 等情况下 `unrecorded_resource_ids` 可能为空，但 checkpoint 仍为 incomplete。此时声明 `ready` 是过度声明——journal 无法证明它捕获了一切。`uncoveredReasons` 从 binding 的 `failure_json.message` 收集，向用户展示 incomplete 的原因。
考虑过的替代：只在 `uncoveredPaths.length > 0` 时降级——无法覆盖空路径的 incomplete 场景。
影响：`packages/extension-contract/src/recovery.ts`（`uncoveredReasons` 字段 + parser）；`packages/web/application-host/lib/recovery/journal-engine.ts`（`hasIncompleteCheckpoint` + `uncoveredReasons` 收集 + coverage 计算）；`packages/ui/src/components/pi-session/PiRecoveryDialog.tsx`（显示 reasons）；`engine.test.ts` 两个新测试。
状态：已实施

### D-004 · 2026-09-03 · 0.2
类型：问题与解法
决定：`Writer` 接口加 `mode` 字段，`writerScope` 格式从 `${kind}:${id}@gen` 改为 `${mode}/${kind}:${id}@gen`。source 归因按 `process/` → shell、`external/` → external、其他/旧格式 → unknown。
原因：原实现用 `scope.startsWith('process:')` 做归因，但 `writerScope` 实际格式是 `${kind}:${id}@gen`，`kind` 是 `pi-worker` 等而非 `process`。`mode` 字段（`controlled`/`process`/`external`）已在 `mutation-authority.ts` 的 `ActiveWriter` 和 `publicState` 中存在，只是 `turn-coordinator` 的 `Writer` 接口没有声明它。把 `mode` 编码进 `writerScope` 前缀让归因在真实数据中成立。
考虑过的替代：(1) 在 binding 里单独存 `active_writer_modes` 数组——冗余且需要额外存储字段。(2) 用 `kind === 'pi-worker'` 推断 shell——不准确，`kind` 标识 owner 类型而非 writer mode。
影响：`packages/web/application-host/lib/recovery/turn-coordinator.ts`（`Writer.mode` + `writerScope` 格式）；`packages/web/application-host/lib/recovery/journal-engine.ts`（归因逻辑改为 `process/` / `external/` 前缀）；`engine.test.ts` 新增 process writer 注册后断言 `source: 'shell'` 的测试。
状态：已实施

### D-005 · 2026-09-03 · 0.2（已修正）
类型：问题与解法
决定：pi-worker 运行期 lease 的 `mode` 是 `process`（见 `pi-writer-tracker.ts:273`），不是 `controlled`。source 归因按命令窗口进行：pi-worker 自身的 lease scope 在归因时排除，只有 bash 命令执行期间额外注册的 `mode: 'process'` writer 才归因为 shell 写入。
原因：`pi-writer-tracker.ts:273` 明确使用 `mode: 'process'` 注册 pi-worker lease，不是 `controlled`。原 D-005 条目错误地声称 mode 是 `controlled`。归因方案改为按命令窗口：在 bash 命令执行期间注册的 process writer 是 shell 写入，pi-worker 自身的 lease scope 在归因时排除（不归因为 shell）。
考虑过的替代：(1) 用 `kind` 做归因——无法区分 pi-worker lease 和 bash process writer（都是 kind: 'pi-worker'）。(2) 按 mode 归因但包含 pi-worker 自身 lease——会把 pi-worker 的非 shell 写入错误归因为 shell。
影响：阶段 1.3 的 bash 命令级 process writer 注册确保 `mode: 'process'`。归因时排除 pi-worker 自身 lease 的 scope，只归因命令窗口内的 process writer。
状态：已实施（修正）

### D-027 · 2026-09-04 · 2.1–2.10 / 3.4–3.5 / 3b.1（更正 D-023、D-024、D-025、D-026）
类型：问题与解法
决定：把前四条记录里混在"状态"字段中的**未完成**与**偏离**分开，并更正三处与代码不符的描述。本条只追加，不改写被引用的条目。

**更正 1（D-026 (5)）**：原文写"`tryDequeue` 在运行线程完成时取出最旧的排队线程"，但当时代码里 `tryDequeue` 没有任何调用点，排队线程永远不会启动。现已成立：`updateThread` 检测到进入终态（done/failed/cancelled/merged/archived）时调用 `maybeDequeue`，由它比较 `countActive` 与 `maxConcurrency` 后调 `tryDequeue`，再经 `onThreadDequeued` 回调让 host spawn。放在 `updateThread` 而不是各调用点，是因为每条结束线程的路径都要让出槽位，分散实现必然漏（当时 `failed` 就没接）。

**更正 2（D-026 (8)）**：原文写 TTL 表"供 wait 超时使用"，实际 `wait` 只用常量 `DEFAULT_WAIT_TIMEOUT_MS`，`DEFAULT_TTL_TABLE` 定义了但零引用。现状不变（表仍未被消费），按 plan 3.5 判断要点保留 240s 保守默认；`getTtl` 的接线留到能从 provider 元数据拿到缓存 TTL 时再做。

**更正 3（D-025）**：原文称"mode 硬编码为 normal"为待办，现已从 `harnessSettings.permissions.mode` 解析。另外 D-025 说 web 侧"保留本地 `isHighRisk` 扩展版"，这导致 pi-host（用 protocol 版，只认 bash）与 web（用本地版，认 write/edit 的 path）判定不一致——同一个 `.env` 写入在门控里不算高风险、在 smart mode 里算。已统一，见 D-028。

**未完成项（不是偏离，是尚未做的工作，按阶段推进）**：

| 来源 | 未完成 |
| --- | --- |
| D-023 | Zone 2 material 收集（观察者未订阅事件源）；记忆 agent 无 model 访问；user 知识库未打开；todo 的确认通道与"只问一次"未接 |
| D-024/D-026 | worktree 创建与回收；活性传感器 stalled/looping；Zone 2 threads 段；Fleet provider；broker child session（spawn/kill/send/applyWorktreeDiff 仍为 mock）；`read_thread(steps)` 转录切片；progress/decisions/errors 块提取 |
| D-025 | smart mode 未接 permissionJudge 槽位 |
| 3b.3 | 见下条：插件未移除，原生门控与插件并存 |

**3b.3 的真实状态**：D-021 已把 `@gotgenes/pi-permission-system` 的移除回退，插件仍在 `FOUNDATIONAL_PI_PACKAGE_MANIFEST`（revision 2）。roadmap 曾连续三版写成 "Removed (revision 2→3)"，已更正。plan 3b.1 要求的"与插件同时启用时原生优先并在诊断面板提示重复"仍未实现。
影响：`docs/roadmap.md`（3b.3 条目与测试计数更正）。
状态：已实施

### D-029 · 2026-09-04 · 交叉（测试卫生与流程）
类型：问题与解法
决定：(1) 六个测试文件（recall / compaction / memory-agent / knowledge-suggestions / todo / store / embedding / observers）把临时知识库建在 `import.meta.dirname` 下，即 `application-host/lib/**` 源码树内；`architecture.test.ts` 会遍历该目录做"源码全是 TypeScript"检查，于是全量 vitest 随机报 `ENOENT: scandir '.test-recall/store-1'`——上一轮报告的 "0 fail" 是碰巧跑过的一次。全部改为 `join(tmpdir(), "piarium-test-*")`。(2) `thread-registry` 的 `persist` 改为按 parent 串行的 promise 链，临时文件名带 pid+序号：`cancelAllForParent` 会并发取消多条线程，各自触发一次 temp+rename，撞同一路径会丢写或直接失败。(3) `cancelAllForParent` 期间置 draining 标记抑制出队——父会话正在删除时把排队线程提升成新的子会话，等于复活用户刚删掉的工作。(4) `test:node-smoke` 加进 CI（`.github/workflows/ci.yml`），否则那个专门用来暴露 CJS/ESM 互操作问题的 Node smoke 只能靠人手跑，而它要防的正是"vitest 能过、`node server/index.js` 起不来"。
原因：前三条都是"测试和实现里的并发/路径假设在真实运行时不成立"，第四条是让上一轮加的防护真正生效。
影响：上述六个测试文件；`packages/web/application-host/lib/harness/thread-registry.ts`；`.github/workflows/ci.yml`。
状态：已实施

### D-030 · 2026-09-04 · 交叉（决策日志治理）
类型：默认值调整
决定：本日志的治理规则改为四条。(1) **条目只追加，永不改写、重排或删除**，编号乱序（D-013、D-015 早于 D-011、D-012）与 D-005、D-013 的原地修订作为历史保留。(2) 新增"决策索引"一节（见文末），每条记录 `Current status`（active / implementation / experiment-result / superseded / reverted / contradicted / open-question / folded-in）、`Superseded by`、`Folded into`；索引可以随时更新，它不是条目。(3) 分类为 active-design 的条目**必须回写**到 `agent-harness.md` 或 `agent-harness-plan.md`，回写完成后索引标 `folded-in`；日志不是现行规格，执行 agent 以设计文档与 plan 为准，日志只解释"为什么"。(4) 状态快照（测试数、接线表、e2e 断言表）不属于日志，原"阶段小结 · 阶段 1"迁入 `status.md`，原位置保留一行链接。plan 交付完成后本日志**归档为交付历史**，不删除。
原因：三轮验收发现设计漂移的主要来源就是这份日志：D-013、D-014、D-023、D-028 等已成为现行契约的决定只存在于此处，设计与 plan 仍写着旧形状，执行 agent 每次压缩后重读 plan 就会再走一遍旧路径。另一方面，D-026 被原地改写、D-005 被原地修订，说明"只追加"没有被当成硬规则。
考虑过的替代：(a) 把日志直接改写成现行规格——历史消失，之后没人能回答"当时为什么这么定"。(b) 不加索引、靠阅读全文判断哪条还有效——每条的"状态"字段混着未完成与偏离，读不出来（D-027 已经证明这一点）。
影响：本文件（索引节、阶段小结迁出）；`docs/status.md`（新文件）。
状态：已实施

### D-038 · 2026-09-04 · 交叉（执行规则）
类型：默认值调整
决定：plan 0.1 的工作规则改为：

(1) **暂停规则**。以下五类偏离**暂停该工作项**、提交设计差异待验收，不阻塞其他独立工作项：持久格式 / 数据 authority / 破坏性迁移；身份、安全默认值、能力边界；删除、重命名或不兼容修改公共协议；不改签名但改变已有方法核心语义（例：`wait` 从快照改为阻塞）；新增不可逆外部副作用。新增可选字段、可选方法、内部重构照常推进并记日志。

(2) **交付单位**从"一个工作项一个提交"改为"一个可运行纵切一个交付组"：协议 → host → worker → 一条真实 E2E 全部到位才算交付，缺任何一段标 `implemented`（休眠）。

(3) **四级能力状态**：`implemented`（模块存在且单测通过）→ `wired`（进入真实生产调用链）→ `proven`（E2E、崩溃、平台行为验证，证据链接到具体测试或 smoke）→ `default-on`（对普通用户默认启用；影响模型行为的能力需回放对比）。只有 `proven` 算纵切完成。状态矩阵在 `status.md`，由执行 agent 随交付维护，roadmap 只引用它。

(4) **P0 integrity 纵切**的固定边界，七项做完立即进入真实 child session 的线程纵切，不顺手清其他债务：① broker 身份 pin；② Router `ActorContext` + Host 静态授权；③ 注册表错误分类、schema 版本、启动对账；④ 最小 Thread + ThreadRun 与正交状态；⑤ `OutputRef` / `TranscriptRef` 与 UTF-8 偏移；⑥ 工作区级规范路径锁；⑦ 对应的故障注入（崩溃、损坏、跨会话、Unicode）与契约测试。

(5) **范围**：Phase 4（默认 runtime）与 harness 内核正交，继续；Phase 5（外部 agent）、Phase 6（research profile）暂停，等 harness 内核与线程纵切 `proven` 后再开始——是顺序，不是取消。

(6) 报告规则：每条"已实施"附代码位置；"定义了但无调用点"不算已实施；推迟必须说明为什么现有骨架不可用。不做历史重写、不 force-push；误提交用正向删除提交处理。
原因："不停下来问"让权限插件被提前移除又恢复、权限门上线即锁死所有会话；"一个工作项一个提交"产生了 90 个模块测试全绿而生产链路没接通的"完成品"；设计头、plan、日志、roadmap 对"完成"定义不同，执行 agent 才会把单测等同于阶段完成。
考虑过的替代：暂停范围定义为"一切公共协议变更"——每加一个可选字段都要等人，执行会瘫。
影响：`agent-harness-plan.md` 0.1 / 0.4 / 验收节重写；`status.md` 新建。
状态：已实施（文档）

### D-047 · 2026-09-04 · T4（最小回放集与执行边界）

类型：实现澄清

决定：第一版回放集固定 6 个真实 Piarium 历史任务，范围为 5–8 的设计窗口内；每项记录 base/reference full commit、用户任务、
可观察验收和建议检查。reference 是评审证据，不是 exact-diff oracle。每次实验按 `{case, model, pair}` 各跑 `native` 与
`harness-shadow`，只比较成功、总 token、人工介入次数；失败另记 D-037 的分类。记录器默认只校验/建记录/汇总，绝不调用模型、
建 worktree 或改用户 settings。自动运行要等 per-session Harness profile override，不能用修改全局设置的捷径。

原因：当前 Harness 设置在 session 创建时从用户/项目文件冻结，没有实验专用的单会话覆盖；自动切全局设置会影响并行普通会话，
结果也无法证明究竟运行了哪个 profile。先固定任务与证据格式，可以开始人工配对，同时不伪造自动化程度或产生意外 API 费用。

影响：`evaluation/harness/cases.json` / README、`scripts/harness-replay.mjs` 与测试、package scripts、设计 8.6、状态矩阵。

状态：已实施（清单与记录器）；真实 paired runs 尚未执行

### D-071 · 2026-09-05 · 用户取舍与本轮范围

类型：设计修正（用户已决定）

决定：

1. **优先保留 TriviumDB，但不是不可替换依赖。** 不启动 SQLite 迁移。具体缺陷、受影响版本、最小重现和需要的能力先报给用户，
   由用户联系 TriviumDB 作者处理；Piarium 不长期把绕路当目标接口，也不设无依据的修复期限。保持一个可写知识权威。
2. **Agent 默认可读所在窗口的未保存内容。** 不增加显式开启、绑定或每次读取确认。用户从窗口发起消息时，surface 来源随已有鉴权
   请求自动传播；同一会话在别处仅被打开或获得焦点不改变本次工作的来源。后续用户从另一窗口发消息时自动更新来源。后台工作保留
   最近一次已接受用户输入的窗口来源；只读取得带 generation/revision 的不可变快照，不把 Host 变成第二个可变缓冲权威。窗口断开时
   已捕获快照仍可标版本使用，最新内容不可得须明说；不把另一窗口或磁盘冒充当前草稿。无 surface 的 headless 任务使用磁盘。
3. **实施顺序由执行者负责。** 先修已确认的记忆写入/分支、证据版本和观察送达缺口，再补最小实验记录、版本化读取和检索；
   不要求完整跨 runtime RunManifest、数据库迁移或沙箱先全部完成，不重开宽泛 P0。
4. **`check` 是执行检查角色，不是只读角色。** 测试、构建、缓存和生成物可能写文件；它需要执行能力，遵守正常工具权限与恢复边界。
   不规定“bash 只跑不改”，不靠提示词声称只读，不新增一律复制工作区或独立 worktree 的硬规则。工作副本选择按检查目标与真实环境需要决定。
5. **不安排付费记忆协议/缓存对照实验，不建设 Windows 沙箱。** 记忆质量与真实成本由用户招募的测试者在真实使用中验证；本地只准备
   可执行场景、配置记录、用量和失败归因。保留当前 `memory_edit` 路径、活动模型与默认关闭；不借本次评审新增 memory 模型槽位、
   同前缀 JSON 实验或独立记忆会话。Windows 沙箱不再列为待补齐交付项，也不妨碍现有 Windows 能力交付；已有权限与路径边界继续成立。

原因：用户明确选择默认、低摩擦的窗口协作，并要求检查拥有真实执行能力；数据库问题可由作者协作解决，暂无迁移和 Windows 沙箱需求。
默认读取草稿不等于跨窗口混用正文：内部仍需区分来源、世代与版本，用户不用管理这些字段。

影响：设计决策表、第 6.1/7.5/8.4/9.1.1/9.2.2 节；plan 当前顺序与相关任务；status 仅登记缺口。

状态：已回写文档；**本轮只改文档，不推进实现、不运行实验、不提交**。上述新能力不得因设计被接受而标为 wired/proven。

### D-078 · 2026-09-05 · 正式实施、默认交付与工作状态架构（用户重新授权）

类型：设计修正（用户已决定）

决定：

1. **完成可用路径就交付并默认启用。** 用户明确要求当前早期项目大胆推进，撤销 D-037、D-070/D-072 中把独立回放集、配对实验、
   测试者结果作为 explore、记忆、压缩接管和自动 review 默认启用前提的安排。相关生产路径、版本/权限/数据正确性与失败诊断由直接
   测试验证；真实使用继续优化质量、成本和性能。T4 与检索对照保留为可选诊断工具，不新建评测项目充当开发或上线许可证。
2. **权限按已有授权推进。** D-038 的五类变更不再自动暂停。正式设计内的持久格式、数据 authority、私有协议和默认值调整由执行者
   连同迁移、消费者和文档完成，不为保住旧实现长期维持双权威或休眠 fallback。真正超出用户授权的不可逆动作、明确产品分歧或无法
   保留用户数据的迁移才请求决定。决策由执行者及时写回，取消等待另一验收方、固定抽两条 mutation 测试等流程要求。
3. **具体启用策略。** explore 的确定性路径接通后默认注册；辅助模型仍按用户槽位配置。记忆沿现有活动模型与 memory_edit 实现，
   新配置默认维护记忆并在分支、修订、实际覆盖和必要来源检查满足时接管压缩；缺覆盖仅该次交还 Pi。已有明确关闭、assist 等用户
   选择保留，缺省值与显式值在迁移中区分。自动 review 接通后默认作为不阻断传感器，使用已定义的 review 槽位。单会话配置与实际
   用量一起交付，不以 record-only 模式、完整 RunManifest 或缓存对照实验为前置。todo 的自报置信度只作信息，不再默认弹确认。
4. **工作状态与目录分离是正式架构。** Thread/ThreadRun 保留；新增由 Application Host 拥有的内容寻址工作状态、不可变结果修订、
   按需物化与版本化 Integration。状态可 fork，工具读取固定基线加本分支修改；真实执行修改收回状态后目录才可回收。窗口草稿以
   带版本快照加入基线，编辑器仍拥有可变缓冲，草稿集成不自动保存磁盘。非 Git 与无首次 commit 的目录通过 copy/CoW 后端支持。
   Git 是可复用的基线/物化/导出后端，迁移期间既有 resultCommit 是有效结果来源；原生状态持久化并发布成功后切换权威，不建长期双写。
5. **撤销不成立的性能与隔离形状。** 不用 live 父目录加 child delta 冒充固定基线；不默认硬链接可写依赖；不承诺首次采集、文件哈希
   或端到端 fork 是 O(1)。Merkle 结构共享、Git tree 读取、CoW 与按变化路径收集直接实施，必要成本显式计量；不把普通消息变成全仓
   捕获。需要真实路径的 Pi 工具、LSP、扩展与 shell 按需物化；受控工具虚拟分支与 shared 模式明确区分。
6. **D-077 收敛为物化生命周期。** 保留 setup、同路径重建、回收和占用可见性；setup 使用用户配置，按真实环境需要执行，失败可诊断。
   输入、可重建缓存、环境文件按用途处理，ignored 不是可删除或不重要的证明；回收须覆盖待保留结果和实际后台写者，git status 干净
   只是检查之一。撤回未经定标的 8 GiB/10%、600 s、30 天和 80% 固定默认；配置预算可执行，缺省按真实空间、占用与可回收量处理，
   不因猜测配额拒绝派发。结果引用保护实际对象，目录删除不等于释放结果历史。
7. **集成、验证与提示直接实现。** 先修 merge 只消费选定结果修订（含新增文件正文、类型与 mode），再落实逐路径三方分类、受检修订
   绑定和恢复操作；预期冲突保留可处理现场，意外部分失败条件补偿，文件/草稿/index 的实际影响分开记录。重叠提示非阻塞，投机合并
   绑定子结果与父相关路径/草稿版本，不要求完整 WorkspaceHead。两者随调用链交付，不加离线收益门槛。结构感知合并可继续实现和优化，
   不把文本合并成功解释成行为验证通过。

事实更正：当前 thread-services.ts 已提示 conflict markers/index entries；缺口是逐路径应用记录和恢复。thread-runtime.ts 的
withMergeWriter 在 index.ts 只注册 process writer，不是已接通的逐路径 before/after 集成事务。当前 prepare 要求 HEAD，不能声称
无首次 commit 或非 Git 目录已经支持隔离。上述事实已回写 status，不抹去既有 T1 核心交付。

保留：模型槽位/凭据的用户所有权、持久知识审阅、现有权限插件的单一提示权威、真实路径授权、失败分类和用户明确的设置；Windows
沙箱排除与不自行发起付费记忆实验的要求不变。缓存保活仍为用户可选的额外请求，不再以回放作为开关的使用门槛。

原因：项目尚处早期，长期关闭已设计能力、反复申请同类批准和为每个机制另建评测，会让工程流程阻碍实际使用。已证实的错误应修掉，
工程复杂度由实现承担，不能泛化为整项功能的禁用依据。

考虑过的替代：继续只保留候选与旧 Git 权威——违背用户本次决定；不区分实现状态直接改成已上线——会伪造交付；移除所有 fallback
与确认——会破坏已有配置、真实服务缺失和权限边界。采用默认交付、局部失败局部处理与一次性迁移。

影响：agent-harness.md 决策表、工具/记忆/检索/线程/度量；plan 执行规则、当前顺序、2.4–2.6、3.2–3.7 与验收；status 的政策和
待做项；architecture 的目标架构说明。D-077 原始条目保留，已存在的未提交文档改动在其基础上整合。

状态：正式设计已采用；本次只修订文档与验证文档，未修改运行时代码、未切换用户设置、未执行迁移或付费实验。实现进度只看 status。

### D-103 · 2026-09-07 · 测试套件里的挂钟阈值与未捕获 EPIPE

类型：问题与解法

背景：D-102 的并发压测（`packages/web` 完整套件与 `packages/pi-host` 整套同时跑）暴露三处与结构来源无关的既有项，都不是断言逻辑错，而是挂钟阈值贴得太紧或子进程收尾未捕获。

1. `packages/web/application-host/lib/harness/thread-runtime.test.ts`「marks an event-silent Run as stalled and clears it on the next observed event」用 `stalledAfterMs: () => 20`。20ms 阈值在并发负载下失败，单独跑该文件 22/22 通过。由 `036b43e3`（2026-09-04，`feat(harness): run durable child threads`）引入。
2. `packages/web/application-host/lib/run/supervisor.test.ts`「discovers and runs Node tests, and isolates a crashed test provider」在满载时抛未捕获的 `write EPIPE`（`errno -4047`）。**后果是完整 `packages/web` 套件退出码间歇为 1，而 196 个文件、1653 项断言全过**——CI 会红，但红的原因不是任何测试失败。单独跑该文件 3 遍 8/8 且退出码 0。
3. `packages/pi-host/test/harness/harness-e2e.test.ts:198`「background command + get_output retrieves output」。status 3.2 已记「待单独立项」；在 D-092 之前的 `53350ec2` 上同样失败、之后又自行通过，是既有时序抖动。

决定：本条只立项与固定证据，不在 3.11 里修。方向：(1) 与 (3) 把挂钟阈值换成可注入的时钟或事件驱动等待，而不是调大数值——调大只是把抖动推远。(2) 属于崩溃隔离用例向已死子进程写 stdin，应在该测试内捕获 `EPIPE` 或在写入前检查管道存活，使套件退出码只反映断言结果。三项都不改产品行为，只改测试与其时钟来源。

原因：挂钟阈值与 CPU 争抢共享同一个时钟，这类失败会随机器和并发度漂移，长期会训练维护者忽略红色。(2) 尤其有害，因为它让「退出码」与「有测试失败」解耦——按 plan 0.1 的验证纪律，套件的退出码必须能作为判据。

考虑过的替代：(1) 只把 20ms 调大到几百毫秒——延长了单测时间又没有消除负载相关性。(2) 在 CI 上串行跑 `packages/web` 与 `packages/pi-host`——掩盖问题且拖慢反馈。(3) 把 EPIPE 加进 vitest 的 `dangerouslyIgnoreUnhandledErrors`——会一并吞掉真实的未捕获错误。

不改：`STRUCTURE_PARSE_BUDGET_MS`（D-102 已标定）；三处涉及的产品代码；不把这三项算进 3.11 的验收范围。

影响：`lib/harness/thread-runtime.test.ts`；`lib/run/supervisor.test.ts`；`packages/pi-host/test/harness/harness-e2e.test.ts`；status 3.2 已有的「待单独立项」记述。

状态：待实施（不阻塞 3.11 第 4–5 步；建议在下一次触及这三个模块时一并收）。

### D-132 · 2026-09-07 · D-116 至 D-119 是空号

类型：active-design

背景：3.11 第 5 步的实现里有注释引用 D-117 / D-118 / D-119，但这三个编号从未写过条目。按 D-030，编号一旦被引用就该能查到。

决定：D-116、D-117、D-118、D-119 永久空号，不回填。已有引用改指真实条目：D-117 → D-125（清单摘要在发布期生成），D-118 → D-126（捆绑目录优先），D-119 → D-127（按需语言名单）。以后新条目从 D-128 起编号，不复用空号。

原因：回填会让编号顺序和时间顺序对不上；空号比错号便宜。

不改：D-114 / D-115 / D-120 至 D-127 正文。

影响：`refresh-grammar-manifest.mjs`；`tree-sitter-provider.ts` 注释。

状态：已实施。

### D-133 · 2026-09-07 · D-103 第 2 项：崩溃隔离用例忽略已死管道的 EPIPE

类型：问题与解法

背景：D-103 立项三处测试收尾项。第 2 项：`lib/run/supervisor.test.ts`「isolates a crashed test provider」在子进程已死后仍向 stdin 写 `initialized` / RPC，未捕获的 `write EPIPE`（`errno -4047`）让 `packages/web` 完整套件退出码为 1，而断言全过。3.12 要反复跑这个套件，先修这一条。

决定：在 `test-supervisor.ts` 给崩溃隔离用例的子进程 stdin/stdout/stderr 挂 `error` 监听，忽略 `EPIPE` 与 `ERR_STREAM_DESTROYED`。崩溃隔离本身仍被断言。不改产品监督器。D-103 第 1 项（`thread-runtime` 20ms stalled）和第 3 项（pi-host `harness-e2e` #3）本刀不碰。

原因：套件退出码必须能当判据。把 EPIPE 吞进 vitest 全局忽略会一并吞掉真实未捕获错误；只在这条故意崩子进程的路径上忽略已死管道，范围最小。

不改：D-103 正文（历史立项）；两处挂钟阈值；生产 `supervisor.ts`。

影响：`lib/run/test-supervisor.ts`；status 3.2/下一步；D-103 索引行。

状态：已实施。

### D-292 · 2026-09-19 · 阶段 Q：AI4S 前重整测试与 CI 体系

类型：accepted design / implementation planned

背景：长期局部验收和历史约束累积后，测试维护已影响产品推进。2026-09-19 对 `9ca1a359` 的 tracked 测试文件、
执行入口与 CI 日志做了全仓清点和代表性抽查，发现源码文字/固定数量断言、重复执行与构建、跨平台发现差异和错误终态未被检查等问题。
同时云成品仍有真实启动失败，不能把全部红灯归咎于测试。调查不是逐断言审计，具体证据与限制见设计 1.1。

决定：把全仓测试与 CI 重整作为 AI4S 功能实施前的独立阶段 Q。Q0 确定每个维护领域的验证责任和目标结构；
Q1 删除/合并无价值约束、修正错误测试与装配并保留真实风险保护；Q2 统一执行发现、整理构建/CI/发行职责及失败诊断；
Q3 核对实际范围、反馈成本和当前证据引用后收口。本次仅接受设计，尚未修改测试或 CI。

验证按可观察行为和实际权威分层，细节放在所属层、跨层验证新增责任，不要求每个功能跑齐所有层。
允许直接删除无价值测试，不设替换数量、覆盖率、固定分钟数或删减比例；不靠吞错、skip、盲目重试和去掉关键 smoke 换绿灯。
重要数据/权限/进程/发行行为保留可信证据。真正产品故障单独修，不借整理扩大为业务架构重写。

原因：测试目的在于支持开发判断和及时发现重要错误。数量、源码结构一致和重复全绿不能替代真实行为证据，
没有责任划分的局部减负也会再次堆积。AI4S 将增加并行和跨模块行为，应先把现有验证成本和可信度问题解决。

考虑过的替代：只修最近红灯会保留系统性问题；按数量大批删测试会误删有效保护；全部改端到端会增加耗时和定位困难；
再建统一测试平台、强制登记表或新审批门禁会扩大维护负担。因此沿现有 runner、package scripts 和模块边界整理。

影响：[testing-ci-design.md](../design/testing-ci-design.md)；plan 阶段 Q0–Q3 与当前顺序；roadmap、status、development、
agent-harness 及 research-cluster-design 的入口/实施前置。D-291 的科研产品方向不变，Q 后进入 7A–7F。
既有修复和授权发行继续依据各自产物证据推进，不以 Q 尚未完成作为通用阻断。

状态：设计与计划已接受；Q0–Q3 待实施。本条不宣称测试清理、CI 修复或全仓验收完成。

### D-296 · 2026-09-19 · 退役 VS Code companion，进入 AI4S 前的收口阶段

类型：accepted implementation plan / implemented and locally verified

背景：D-294/D-295 已把长期荒废的 VS Code 适配层移出正式产品证据，但仍留下包、开发/构建/打包
入口、共享表面契约、安装与专属文档入口。继续把它作为手动可用的当前产品面会让产品边界与发行
事实分裂。历史 changelog 与既有决策正文继续作为交付证据保留。

决定：在 AI4S 实施前完成一次性完整退役：删除 `packages/vscode` 及其当前入口和发布接线，删除
companion-only shared contracts 与当前安装/Marketplace/配置/开发说明，不保留归档兼容副本。仍有
LSP 包、TextMate 格式、外部编辑器启动或 provenance 含义的 VS Code 文字按原语义保留，并在历史
设计处标明其范围。

计划与状态：文档、根 README/AGENTS、贡献指南、公开 docs-site 与包级文档已同步；代码、配置、脚本、
构建和发布清理由实现 owner 完成。根构建（含 Web Host+Vite、Electron bundle、Mobile assets）与
built-server knowledge smoke 2/2 已本地通过。未把 packaged、跨平台或远端 CI 结果外推为本地证据；AI4S
进入下一阶段。

影响：当前架构/开发/路线图/状态说明、公开 docs-site 和包文档；D-293–D-295 的既有索引状态不扩写，
本条只记录新的退休阶段。

状态：已实施；本地验证通过，未宣称 packaged、跨平台或远端 CI 已完成。

### D-313 · 2026-09-21 · Varin 全面更名，无旧名称兼容层

类型：accepted design / implementation planned

背景：产品已拥有完整 Harness 和工作台能力，Piarium 的名称较长且过度关联 Pi。用户选择新名 Varin，
并明确当前没有已有用户需要迁移，不希望为了更名留下兼容负担；本轮要求把决定写成设计与实施计划。

决定：采用 Varin 为唯一主品牌，阶段 B0–B4 优先于尚未实施的快速决策模型阶段 F。范围包括可见产品、
自有符号/包/CLI/协议/扩展/配置与存储身份、品牌资源、构建发行、部署和当前文档。新名称一次切换，
不增加旧命令别名、环境变量/目录 fallback、双写、多版本分支或自动迁移器。外部分发坐标据实际资源落实，
不把拟用的仓库/npm scope/域名声称为已取得。

真实 Pi SDK、原生配置/凭据/会话与其他上游合同保持准确名称及 owner；工作区文件、实验成果、Git、
第三方归属和历史记录保全。开发者特定数据需要保留时做一次性处理，不加入产品迁移代码，也不批量删除旧数据。
Logo 造型尚未选定，沿现有矢量资产管线落实实际方案；不把文件改名冒充视觉设计完成。

原因：新产品应有清晰独立身份，工程与发行的一致命名比只改 UI 更完整。没有历史用户的条件允许直接替换，
兼容框架不会产生本次需要的产品价值。更名不改变 Pi 的技术职责、运行时 authority 或当前功能布局。

考虑过的替代：只更换显示名会留下混杂的开发/运行/发布身份；双品牌过渡和自动迁移器增加无需求的维护路径；
对所有 `pi` 做替换会损坏上游合同；另建仓库复制代码会割裂项目历史。因此按责任完整更名并保留真实依赖和历史。

影响：[varin-rebrand-design.md](../design/varin-rebrand-design.md)；plan 阶段 B/F 顺序；harness、architecture、status、
roadmap、development 与快速决策设计入口。现有协议版本不为名称机械递增，发布版本与外部操作遵循实际任务授权。

状态：设计与计划已接受，尚未实施。当前代码和发行身份仍为 Piarium；本次不改仓库名、不注册外部资源、不发布新版本。
