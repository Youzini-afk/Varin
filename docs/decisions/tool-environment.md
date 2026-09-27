# 决策分卷：工具环境

范围：1.x 工具与 shell 监督、输出契约、编辑/诊断、路径租约、计数器、设置与提示、1b.x Web 工具、3.9 观察视图、3.17 命令整理。

本卷是 [decisions/README.md](README.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-006 · 2026-09-03 · 1.1
类型：偏离
决定：`HostServicesBridge` 的 `respond` 方法接受 `{ ok: true; result } | { ok: false; error: HarnessError }` 联合类型，而非 `workspace.mutation.respond` 的 `accepted: boolean`。`session-host.respondHarness` 在 host-controller 层将扁平的 params（`{ ok, result?, error? }`）转换为联合类型再传给 bridge。
原因：harness 服务的返回值是结构化数据（shell 输出、搜索结果、诊断），不是布尔值。`HarnessError` 有 `code` / `message` / `retryable` 三字段，需要完整传递给 worker 侧的 `HarnessRequestError`。host-controller 的 `readString` / `readBoolean` 风格不适用于嵌套的 error 对象，因此在 `respondHarness` 里做一次形状转换。
考虑过的替代：(1) 让 host-controller 直接解析联合类型——需要新的 params 解析器，与现有 `readString` / `readBoolean` 风格不一致。(2) 把 error 展平为三个顶层字段（`error_code` / `error_message` / `error_retryable`）——污染方法签名且与 `HarnessError` 类型不一致。
影响：`packages/protocol/src/harness.ts`（`HarnessRespondParams` 联合类型）；`packages/pi-host/src/host-controller.ts`（`harness.respond` case 传 params 对象）；`packages/pi-host/src/session-host.ts`（`respondHarness` 形状转换）。
状态：已实施

### D-007 · 2026-09-03 · 1.1
决定：`HostServicesBridge` 在 pi-host 进程内构造，与 `WorkspaceMutationJournalBridge` 在同一位置（`#createRuntimeFactory`），共享 `emit` 和 `sessionId`。`harness.respond` 加入 `OUT_OF_BAND_METHODS`，与 `workspace.mutation.respond` 并列。
原因：harness 请求通道与 mutation 请求通道是同一类问题（worker→host 回调），复用已有的 broker 传输路径和 out-of-band 方法处理逻辑。bridge 的生命周期与 session 一致：构造在 runtime factory，dispose 在 `beforeSessionInvalidate` 和 `#disposeRuntime`。
考虑过的替代：(1) 在 host 层（application-host）构造 bridge——破坏了"worker 持有 bridge、host 持有 router"的对称性。(2) 用独立的事件名和 method 名——增加传输层适配成本，无收益。
影响：`packages/pi-host/src/session-host.ts`（`#hostServicesBridge` 字段 + 构造/dispose + `respondHarness`）；`packages/pi-host/src/host-controller.ts`（`OUT_OF_BAND_METHODS` + `harness.respond` case）。
状态：已实施

### D-008 · 2026-09-03 · 1.4
类型：默认值调整
决定：output-store 默认 `maxBytesPerSession = 256 MiB`，tool-result-truncation 默认 `visibleBytes = 32768`，bash 工具使用 0.375 head/tail 比率（其他工具 0.5）。截断时回退到最近的换行符（最多 512 字节）。
原因：256 MiB 足够存储一个典型长会话的所有大输出；32768 字节可见窗口在 4K 终端上约 200 行，足够上下文判断；bash 输出通常头部更重要（命令回显、错误信息），所以给头部更多空间。
考虑过的替代：(1) 128 MiB / 16384——太小，常见构建输出会频繁截断。(2) 512 MiB / 65536——浪费内存，大多数会话用不到。
影响：`packages/web/application-host/lib/harness/output-store.ts`；`packages/pi-host/src/harness/tool-result-truncation.ts`。
状态：已实施

### D-009 · 2026-09-03 · 1.8
类型：问题与解法
决定：`cacheHitRatio` 不在 extension 事件中实时追踪，而是在 `stats()` 查询时从 `getSessionStats().tokens.cacheRead` 和 `.input` 计算。`toolErrors`、`toolRetries`、`outputBytes` 通过 extension 事件实时累积。
原因：Pi 的 `AfterProviderResponseEvent` 不包含 `usage` 字段（只有 `status` 和 `headers`），无法在事件中捕获模型 usage。但 `getSessionStats()` 已经聚合了 `cacheRead` 和 `input`，所以在查询时计算比率是唯一可行的方式。tool 相关计数器没有这个问题，`tool_result` 事件包含所有需要的信息。
考虑过的替代：(1) 从 `TurnEndEvent.message` 中提取 usage——依赖 AgentMessage 内部结构，不稳定。(2) 不提供 cacheHitRatio——丢失重要指标。
影响：`packages/pi-host/src/harness/counter-tracker.ts`；`packages/protocol/src/types.ts`（`SessionStats` 新增可选字段）。
状态：已实施

### D-010 · 2026-09-03 · 1.3
类型：偏离（已回退）
决定：~~shell-supervisor 使用 `child_process.spawn` 而非 PTY 进行命令执行。~~
原因：~~PTY 交互需要 `node-pty` 或 `bun-pty` 原生模块，增加了部署复杂度。~~
状态：已回退——见 D-013。

### D-011 · 2026-09-03 · 1.3
类型：默认值调整
决定：`typebox@1.3.7` 作为 pi-host 的直接依赖添加（与 pi-coding-agent 使用的版本一致）。tool schema 使用 `import { Type } from "typebox"` 而非 `@sinclair/typebox`。
原因：pi-coding-agent 依赖 `typebox`（非 `@sinclair/typebox`），两者是不同的包。pi-host 的 harness 工具需要直接引用 TypeBox 构建参数 schema，但之前没有直接依赖。添加与 pi-coding-agent 相同版本避免兼容性问题。
考虑过的替代：(1) 从 pi-coding-agent re-export TypeBox——修改上游包，不可控。(2) 使用 `@sinclair/typebox@0.34.x`——API 不兼容，schema 构建方式不同。
影响：`packages/pi-host/package.json`；`packages/pi-host/src/harness/bash-tool.ts`；`packages/pi-host/src/harness/grep-tool.ts`。
状态：已实施

### D-012 · 2026-09-03 · 1.6
类型：偏离（已回退）
决定：~~apply_patch 使用 unified diff 语法（--- / +++ / @@ -n,+m @@），单文件。~~
状态：已回退——见 D-014。

### D-013 · 2026-09-03 · 1.3
类型：偏离
决定：shell-supervisor 回到决策表形状：复用 terminal runtime 的 PTY provider（`bun-pty` / `node-pty`），每个会话一个持久 login shell，命令用哨兵分隔，cwd/env/venv 在命令之间保持。后台 shell 保持 PTY 存活，stdin 开放，`write_to_process` 直接写入 PTY。每条命令执行期间通过 `registerWriter` 注册 `mode: 'process'` 的 writer。
原因：决策表要求 shell 形态是边界——持久 shell 保持了 cwd/env/venv 状态，避免了每条命令重新初始化的开销。PTY 支持交互式命令和后台进程的 stdin 写入，这是 `child_process.spawn` 无法做到的。`node-pty` 和 `bun-pty` 已经是 Piarium 的现有依赖（terminal runtime 使用），不增加新的部署复杂度。
考虑过的替代：(1) `child_process.spawn` + pipe——无法保持 shell 状态，无法写入后台进程 stdin（D-010，已回退）。(2) 每条命令创建新 shell——丢失 cwd/env 持续性。
影响：`packages/web/application-host/lib/harness/shell-supervisor.ts`（完全重写）；`packages/web/application-host/lib/harness/service-host.ts`（`registerWriter` 选项）。

#### D-013 偏离记录 · 2026-09-03
**诚实偏离**：D-013 说"复用 terminal runtime 的 PTY provider"，但实际实现复用的是 PTY 模块（`node-pty` / `bun-pty` 的 `spawn` 函数），而非 terminal runtime 本身。具体来说：
- shell-supervisor 直接调用 `loadPtyProvider()` 加载 `node-pty` 或 `bun-pty`，然后 `ptyProvider.spawn()` 创建 PTY 进程。
- 这与 terminal runtime（`lib/terminal/runtime.ts`）是平行的实现，不是通过 terminal runtime 的 API 创建的。
- **后果**：harness 的后台 shell 不是终端 tab。用户无法在 UI 的终端面板中看到或附着到 harness 创建的 shell。这是决策表"边界"要求的缺口。

**修正方案**（进入阶段 2 之前完成）：
1. 在 `lib/terminal/runtime.ts` 暴露程序化创建/附着入口：`createTerminalSession(options) → TerminalHandle` 和 `attachTerminalSession(id) → TerminalHandle`。
2. harness shell-supervisor 经 `createTerminalSession` 创建 PTY，获得 `TerminalHandle`。
3. `TerminalHandle` 暴露 `write`、`onData`、`onExit`、`kill`、`resize` 方法（与当前 PTY provider 接口一致）。
4. UI 终端面板可通过 `attachTerminalSession(id)` 附着到 harness shell，实现"后台 shell 变成终端 tab"。
5. 在此之前，harness shell 与终端面板保持独立。

状态：已实施（PTY 模块复用）；终端 runtime 集成待完成（阶段 2 前置）

### D-014 · 2026-09-03 · 1.6
类型：偏离
决定：apply_patch 回到决策表形状：使用 Codex 语法（*** Begin Patch / *** Update File: / *** Add File: / *** Delete File: / @@ 上下文 / *** End Patch），支持多文件。每个文件的写入经与 edit / write 相同的 workspace.mutation.request before/after。只在会话模型为 OpenAI 家族（provider === "openai" || api === "openai"）时注册。
原因：决策表要求 apply_patch 使用 Codex 语法以与 OpenAI 模型的训练数据对齐。多文件支持减少了工具调用次数。workspace.mutation 集成确保所有文件变更都经过 journal，与 edit/write 工具一致。OpenAI-only 限制避免了在不支持该语法的模型上注册无用工具。
考虑过的替代：(1) unified diff 语法（D-012，已回退）——不匹配 OpenAI 训练数据。(2) 不经过 mutation journal——绕过了 recovery 系统。(3) 所有模型都注册——浪费非 OpenAI 模型的工具槽位。
影响：`packages/pi-host/src/harness/apply-patch-tool.ts`（完全重写）；`packages/pi-host/src/session-host.ts`（OpenAI-only 条件注册 + 传入 mutationJournal）。
状态：已实施

### D-015 · 2026-09-03 · 1.9
类型：决策
决定：HarnessSettings 存储在 Pi settings 的 `harness` 键下，用户级（scope: `global`），不使用项目级覆盖。
原因：harness 工具配置是用户偏好（shell 选择、输出截断大小、命令超时），不是项目协作约定。用户级存储确保同一用户在不同项目中有一致的 harness 行为。工具开关也放在用户级——如果某用户不想用 grep override，这个偏好应跨项目生效。
考虑过的替代：(1) 项目级存储——harness 行为会随项目变化，造成困惑。(2) 混合（工具开关用户级，shell/output 项目级）——增加复杂度，没有实际用例驱动。
影响：`packages/ui/src/components/sections/harness/HarnessSettingsPage.tsx`（写入 `scope: 'global'` 的 `harness` 键）；`packages/pi-host/src/session-host.ts`（从 Pi settings 读取 `harness` 键并 mergeHarnessSettings）。
状态：已实施

### D-016 · 2026-09-03 · 1b.1
类型：决策
决定：HTML 正文提取用 `@mozilla/readability@0.6.0` + `linkedom@0.18.13`（提供 DOM），HTML→Markdown 用 `turndown@7.2.4`。PDF 用 `pdfjs-dist`（动态 import，未加为直接依赖，运行时按需加载）。
原因：`@mozilla/readability` 是 Firefox 阅读模式的实现，业界标准。`linkedom` 比 `jsdom` 轻量得多（无浏览器模拟），足以支撑 Readability 的 DOM 需求。turndown 是 HTML→Markdown 的事实标准。三者均在依赖树中不存在，新加。
考虑过的替代：(1) jsdom——太重，会拉入大量浏览器 API，测试中导致 OOM。(2) cheerio——不支持 Readability 需要的 DOM API。(3) 手写提取——不可靠，无法处理真实页面的复杂性。
影响：`packages/web/package.json`（+3 依赖）；`lib/harness/web-fetch.ts`（动态 import linkedom/readability/turndown）。
状态：已实施

### D-017 · 2026-09-03 · 1b.6
类型：决策
决定：webfetch/websearch 工具在 `selectHarnessTools` 中默认注册，但当 `pi-web-access` Pi 包已加载且启用时让出（yield），由该包提供同名工具。检测方式：从 `settingsManager` 直接读取全局+项目 packages 列表（不调用 `listPackages()`，因为会话创建时尚无活跃会话）。
原因：避免工具名冲突和重复执行。`pi-web-access` 是一等公民 Pi 包，其实现可能比 harness 内置版本更丰富（Curator/browser、GitHub/video/PDF 特殊处理等）。harness 内置版本是后备。
考虑过的替代：(1) 始终注册 harness 版本，忽略 pi-web-access——会导致工具名冲突。(2) 用 MCP 工具名前缀避免冲突——破坏了"让出"语义，用户期望一个 webfetch 而非两个。
影响：`packages/pi-host/src/harness/select-tools.ts`（`computeYieldedTools` + `yieldedTools` 参数）；`packages/pi-host/src/session-host.ts`（从 settingsManager 读取包列表）。

### D-018 · 2026-09-03 · 1.11
类型：决策
决定：工具卡片紧凑渲染的摘要从 `details`（非 `content`）生成，遵循 agent-harness.md 5.1 原则 2。分组逻辑：连续的只读工具调用（grep/read/find/ls/diagnostics/webfetch/websearch）折叠为一组，头部显示"首个摘要 + and N other queries"。写工具和 bash 打断分组且自身永不分组。
原因：`content` 是给模型的（可能被截断/格式化为模型消费），`details` 是给渲染的（结构化、完整）。分组减少了视觉噪音——连续 5 次 grep 调用折叠为一行比 5 个独立卡片更易扫描。
考虑过的替代：(1) 从 content 生成摘要——违反 5.1 原则 2，且 content 可能被截断。(2) 所有工具都分组——写工具需要独立展示 diff 和确认。(3) 不分组——噪音过大。
影响：`packages/ui/src/components/chat/message/parts/toolSummary.ts`（`getToolSummary` + `groupToolCalls`）；`packages/ui/src/components/chat/message/parts/toolSummary.test.ts`（17 测试）。
状态：已实施（纯逻辑模块，尚未接入 PiTimelineEntries.tsx 渲染路径——待阶段 2 UI 集成）

### D-031 · 2026-09-04 · 1.9（取代 D-015）
类型：偏离
决定：`HarnessSettings` 不再作为一个整体决定"用户级"还是"用户级 + 工作区覆盖"，改为**按字段的所有权矩阵**：

| 字段 | 所有权与合并规则 |
| --- | --- |
| `models.*`（模型槽位）、provider 凭据 | user-only；工作区无权设置 |
| `knowledge.autoAcceptSuggestions.user` | user-only；工作区无权设置 |
| `knowledge.autoAcceptSuggestions.workspace`、`knowledge.eventRetentionDays` | 工作区可设置 |
| `tools.*`、`shell`、检索策略、`dispatch.concurrency` | user 默认 + 工作区覆盖 |
| `permissions.mode`、`permissions.rules` | 工作区**只能收紧**：mode 的严格度全序为 `bypass < accept-edits < normal`，工作区只能向右移；工作区可追加 `ask` / `deny` 规则，不能追加 `allow` 规则覆盖用户的 `ask` / `deny`；`smart` 需用户显式开启，工作区不能开 |
| `web.*`（域名策略等） | user 与工作区取更严格的组合 |
| `output.*`、UI 偏好 | user 默认 + 工作区覆盖 |
| `dispatch.askBefore` | 工作区只能增加需要询问的角色，不能取消 |
| `threadRuntime` 及一切能力可用性 | **不是设置**；来自 host / RunManifest 的注入，只读。现有的 `threadRuntime` 设置键是过渡方案，RunManifest 落地后删除 |

工作区级覆盖**只在项目已 trusted 时生效**（复用 Pi 的 project trust；未 trusted 的项目设置整体忽略）。
原因：D-015 说"仅用户级"，plan 1.9 与代码（`session-host.ts:2678` 合并 `getProjectSettings().harness`）却是"用户级 + 工作区覆盖"，两者都不对：`autoAcceptSuggestions` 作为一个对象被工作区整体覆盖，意味着一个仓库的项目配置可以替用户打开"自动写入用户级长期记忆"；`permissions` 被工作区放宽则是仓库替用户降低安全等级。不同字段的 authority 不同，不能用一条规则。
考虑过的替代：(a) 全用户级（D-015 原文）——"这个仓库只能用 PowerShell"这类项目事实无处放。(b) 全部允许覆盖（现代码）——见上。
影响：`packages/protocol/src/harness-settings.ts`（`mergeHarnessSettings` 按矩阵实现，deep-merge 改为字段级）；`packages/pi-host/src/session-host.ts`（trust 门控）；`packages/ui` 设置页需按所有权显示哪些项来自工作区；设计文档 5.10 规则第 2 条与 plan 1.9 回写。D-015 在索引中标 superseded。
状态：待实施（P0 之后的首个设置项工作；实施前 `autoAcceptSuggestions.user` 至少先改为 user-only，因为这是安全侧）

### D-034 · 2026-09-04 · 1.4 / 3.5（输出引用的耐久契约）
类型：偏离
决定：两种引用，两种耐久级别，不再混用。

`TranscriptRef { runtimeId; sessionId; fromEntryId; toEntryId; branchLeafId? }`：**耐久**，指向 Pi 会话文件（每步落盘，就是原始 trace）；`ThreadReport.traceHandle` 改名 `transcriptRef` 并改为此类型；`read_thread(steps)` 经 host 的 `session.entries` 读它。

`OutputRef { handle; durability: "ephemeral"; generation }`：工具结果截断产生的 `out_` 句柄**临时**，不得写入任何持久记录。句柄编码 `out_<hostEpoch>_<sequence>_<mac>`，MAC 用 host 进程内每 epoch 随机密钥；store 按 session 保存 `{ nextSequence, evictedThrough }`，淘汰**必须是 FIFO**（水位方案的前提，写进契约）。判定：epoch 不同 → `expired`；MAC 无效 → `not-found`；`sequence ≤ evictedThrough` → `expired`；在表中 → `ready`；同 epoch、MAC 合法、`sequence ≥ nextSequence` → `not-found`。`dropSession` 后该 session 记入一张"已丢弃"表，其所有句柄判 `expired`。`expired` 与 `not-found` 是不同的错误码（不变量 3）。

偏移单位统一为 **UTF-8 字节**（设计 5.1 与所有 `[output: N bytes]` 文本已经是字节）；切片在字节边界处向最近的字符边界回退；分页结果返回 `nextOffset` 与 `eof`，调用方不得假设 `next = offset + length`。
原因：`OutputStore.total` 用 `Buffer.byteLength`、分页用 `text.slice` 字符索引，中文与 emoji 下两个字段单位不同；`ThreadReport` 落盘却引用 host 重启即消失的内存句柄，两个耐久承诺互相矛盾；淘汰后返回 `not-found` 把"曾经存在"折叠进"从未存在"。
考虑过的替代：(a) 落盘 blob spool——为工具输出建内容寻址存储超出需要，而线程的原始 trace 已经在 Pi 会话文件里。(b) 有限墓碑集合——墓碑被淘汰后旧句柄退化回 `not-found`，三态不稳定，上限也没有依据；FIFO 水位只要一个整数。
影响：`packages/web/application-host/lib/harness/output-store.ts`；`packages/protocol/src/harness.ts`（`OutputSlice` 加 `nextOffset` / `eof`；`HarnessError.code` 加 `expired`）；`harness-threads.ts`（`ThreadReport.transcriptRef`）；`output-tools.ts`、`tool-result-truncation.ts`；设计 5.1 原则 3 回写。
状态：待实施（P0 第 5 项）

### D-036 · 2026-09-04 · 1.7（工作区级规范路径锁）
类型：偏离
决定：编辑锁的键从 `sessionId → path` 改为 `{ authorityId, workspaceId, canonicalResourceId }`；`acquire` 返回 `leaseId`，`release` 只凭 `leaseId`；路径身份规范化（realpath、Windows 大小写与 alias、符号链接）**复用 Documents authority**，harness 不再自行处理。锁只做进程内实现，其保证写明为："同一 Application Host authority 内，所有 Harness 管理的写操作按 workspace / resource 互斥"，不声称阻止其他 Piarium host、终端、Git 或外部进程写文件。
原因：plan 1.7 参考形状原文就是 `Map<sessionId, Map<path, queue>>`，两个会话写同一文件互相看不见；`release(sessionId, path)` 没有所有权 token，同会话内另一个请求可以误释放。所有会话的 harness 服务都在同一个 host 进程内，双 host 共用工作区的情形由 plan 2.1 的"复用运行中的 host"处理，跨进程 lease 不在需要范围内。
考虑过的替代：把锁做成 Documents 的 writer lease——Documents 的 lease 是按 scope 的写者模式，不是按文件互斥，形状不对；只借它的身份规范化。
影响：`packages/web/application-host/lib/harness/path-lock.ts`；`packages/protocol/src/harness.ts`（`fs.lock` 参数与结果）；`packages/pi-host/src/harness/path-lock.ts`（`withPathLock` 持 leaseId）；plan 1.7 回写。
状态：待实施（P0 第 6 项）

### D-048 · 2026-09-04 · 1.11（工具摘要接入真实时间线）

类型：实现澄清

决定：`toolSummary.ts` 接入 `PiTimelineEntries` 的真实 live 渲染。每张卡标题显示 tool name + arguments/details 派生摘要；同一
assistant message 中连续的已知只读工具（read/grep/find/glob/ls/diagnostics/web）2 个以上折叠为一组，写入、shell、thinking/text
与未知扩展工具均打断。组在任一调用运行时展开，结束后可折叠，内部仍是原有完整工具卡与 extension renderer。sorted 模式已有
统一 activity 容器，不再叠一层默认折叠。

原因：原实现只有纯函数和 17 个测试，没有生产 import；同时其“未知且不在写工具名单 = 只读”会把第三方变更工具错误折叠。
未知工具改为不分组，宁可多一行也不伪造 mutation 属性。

影响：UI `toolSummary.ts`、`PiTimelineEntries.tsx` 与 SSR/render tests；设计 5.1、状态矩阵 1.11。

状态：已实施

### D-049 · 2026-09-04 · 1.8（Harness 计数器进入现有 Context 侧栏）

类型：实现澄清

决定：不新建诊断面板。pi-host 已随 `session.stats` 发布的 `toolErrors/toolRetries/outputBytes/cacheHitRatio` 投影到现有 Context
sidebar 的独立 Agent harness 区块。只有至少一个字段真实存在才显示；缺失字段不补 0。输出按二进制单位显示，cache ratio 显示
百分比。真 Pi 会话 E2E 必须证明失败、重复调用和输出字节确实穿过 stats 边界。

原因：计数器的消费者本来就是会话诊断视图；另造 store/route/panel 会复制 SessionStats，并让其他 runtime 的“不支持”看起来像
“全为零”。

影响：UI `ContextSidebarTab` / `harnessCounterPresentation`、pi-host session E2E、设计 8.6、状态矩阵 1.8。

状态：已实施

### D-050 · 2026-09-04 · 1b.2–1b.3（Web 工具按 Host 真实能力注册）

类型：实现澄清

决定：client handshake 新增可选 `harnessWebRead/harnessWebSearch`。pi-host 在 AgentSession 构造前读取并冻结：Host 未声明
`harnessWebSearch` 时不注册 `websearch`；未声明 `harnessWebRead` 时，即使用户配置了 reader model，`webfetch(prompt)` 也直接
返回提取正文，不先请求休眠服务。`pi-web-access` 的显式让位规则保持优先。Web Host 当前两个值均为 false，直到真实 provider
被创建并注入，不能用 `resolveSearchProvider` 返回空数组的 placeholder 冒充能力。

原因：状态矩阵已发现 `websearch` 对真实会话是“工具可见、每次 unavailable”；reader 路径也会多一次注定失败的 round-trip。
线程工具已用同一握手模式解决休眠实现暴露，Web 应复用而非另建探测。

影响：protocol handshake、HostController/SessionHost、`selectHarnessTools`、Web broker factory 与能力 E2E；状态矩阵 1b.2/1b.3。

状态：已实施（能力门）；真实 reader/search provider 仍未实现

### D-052 · 2026-09-04 · 3.9（Host 观察游标与后台 shell 持续采集）

类型：实现澄清

决定：(1) Host 以 `ObservationCursorStore` 持有 `(observerSessionId, objectKind, objectId)` 游标；会话结束与
`compaction.after` 清该观察者的游标，后者同时清线程观察游标。Host 重启天然回到全量基线。(2) `get_output(sh_*)` 仅在
`offset` 和 `length` 都缺席时采用增量语义；`shell.exec` 以已经返回给模型的 `outputSoFar` 字节数预置基线；任一显式分页参数都是
随机访问且不推进游标，静态 `out_*` 始终保持分页语义。同一对象的观察原子串行，压缩/会话清理会使在途旧 epoch 失效，不能在完成后
写回已经重置的游标。
(3) `diagnostics(path)` 首次返回当前基线，此后按完整诊断指纹的多重集差分新增与消失项；`full: true` 返回完整快照且不推进
增量游标。对象身份使用 Router/Documents 已授权的 canonical resource，而不是调用方原始路径。(4) 会话计数器新增
`observationCalls`，只统计实际进入默认观察语义的调用并投影到既有 Context 侧栏。(5) PTY 命令转后台后仍由同一 supervisor
持续收集输出、解析 cwd/exit 哨兵并关闭 writer；同一持久 shell 上仍有后台命令运行时不接受第二条命令，因为该 PTY 无法并发
执行两个前台命令。

原因：仅加游标不足以形成真实能力。旧 supervisor 在 timeout 后把 `pendingCommand` 清空，后续 PTY data 落入初始化缓冲，
`sh_*` 的内容永远停在转后台那一刻，退出哨兵也不会再解析；旧 E2E 又把 `id` 误传给只接受 `handle` 的工具，并仅断言错误文本
非空，形成假绿。增量状态放在 Host 而非 worker，能活过 worker 重载又不写进模型上下文；显式读取不动游标，使调试回看不会改变
下一次默认观察的基线。

影响：protocol `ShellReadResult` / `DiagnosticsResult` / `SessionStats`；Host observation store、shell supervisor、diagnostics 与 compaction
services；pi-host 工具格式与计数器；Context sidebar；plan/status 3.9。

状态：已实施

### D-065 · 2026-09-05 · 1.4 / 1.6（真实 Pi 输出分页与版本化 LSP 诊断）

类型：错误修复与验证补齐

决定：(1) `LanguageSupervisorDiagnosticsProvider` 每个 resource 为每次 `publishDiagnostics` 维护单调 publication revision，snapshot
使用 `{serverGeneration}:{revision}`，不再拿只在进程重启时变化的 server generation 冒充诊断版本。(2) 同步文档时传入由扩展名解析的
`languageId`，并在 supervisor 当前 document version 上递增；不再用 `as never` 隐去缺字段。(3) 编辑后诊断先读取 baseline 与建立订阅，
再发 didOpen/didChange；等待 publication snapshot 变化，新的空列表也作为“错误已全部消失”的 ready，而不是 pending。(4) 用真实
fixture LSP 子进程覆盖 error→clean、pending、unavailable，并再经真实 Pi agent loop 的 `diagnostics` tool/Host bridge 验证。(5) 大文件
read 的截断通过真实 Pi agent loop 验证：模型只收到 UTF-8 预览与 `out_*`，下一步能用 `get_output` 分页，完整尾部不进入上下文。

原因：原适配器漏传 `languageId/documentVersion`，真实 supervisor 会直接拒绝同步；即使已有 LSP，旧 service 又在 sync 后才读取
baseline，可能把同步发布的新诊断吞进旧基线，并且永远观察不到“最后一个错误被清空”。此前直接调用 tool 的 E2E 看不到这两个问题，
也不能证明模型实际拿得到并能消费输出句柄。

影响：Host diagnostics adapter/service 与真实 fixture 测试；pi-host session E2E；status 1.4/1.6。

状态：已实施并 proven

### D-066 · 2026-09-05 · 1b.2（reader 模型归 session，Host 只负责安全抓取）

类型：设计修正

决定：`webfetch(url, prompt)` 始终先且只先调用一次 Host `web.fetch`。配置 `models.reader` 且官方 Host 声明受保护抓取可用时，
pi-host 用本会话的 `ModelRuntime`、provider 配置与凭据对提取正文做一次 `completeSimple(toolChoice:none)`；网页正文明确标为不可信数据。
reader 未配置、模型不存在、调用失败或返回空文本时，保留成功抓取的 Markdown 作为 fallback，不二次请求 URL。删除没有生产调用方的
Host `web.read` service、协议方法和测试；`harnessWebRead` 握手位改为“Host 允许在其 guarded `web.fetch` 结果上使用 session-local
reader”，不再声称 Host 拥有模型栈。

原因：Application Host 不拥有活动 Pi 会话的模型 provider、API 凭据或模型运行时；把 `readerRequest` 放在那里只能继续留桩，或复制
一套最敏感的模型/凭据权威。pi-host 已经为 permission judge 与 memory shadow 使用同一个 `ModelRuntime`，reader 也应在这里。
旧工具先调 `web.read`，失败后再 `web.fetch`，真实接线后还会重复下载页面；单 fetch + 本地 reader 同时解决所有权与重复 I/O。

影响：protocol 删除私有 `web.read` Harness method；pi-host webfetch/select-tools/SessionHost；官方 Web broker capability；Host 删除
web-read service；真实 Pi session E2E；architecture、plan/status 1b.2。

状态：已实施并 proven

### D-067 · 2026-09-05 · 1b.3 / 1b.5（真实搜索 provider 与 transcript 来源投影）

类型：设计修正与实现澄清

决定：(1) 删除会话模型 provider 的三个“search 返回空数组”占位适配器；pi-ai 没有可独立调用并返回来源的 server-side search
契约时，模型可能具备搜索能力不等于 Host 有搜索服务。(2) 实装 Settings 可选的 Brave、Exa、Tavily、Jina 与 SearXNG HTTP adapter；
请求形状分别对照其官方契约（[Brave](https://api-dashboard.search.brave.com/api-reference/web/search/get)、
[Exa](https://exa.ai/docs/reference/search)、[Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search)、
[Jina](https://jina.ai/reader/)、[SearXNG](https://docs.searxng.org/dev/search_api.html)）。provider 的非 2xx、畸形 JSON 与调用错误向上
传播，不能压成“0 results”。domain policy 在 provider 参数之后仍由 Host 对返回 URL 再过滤。(3) 搜索 provider、endpoint 与
credentialRef 为 user-owned；workspace 只能覆盖 fetch 的非身份行为，不能把搜索重定向到仓库指定端点。(4) API key 写入
`piarium-web-search-<provider>` 固定命名的 Pi auth.json 条目，鉴权 route 只返回 configured 布尔值；请求 body 即使伪造
credentialRef 也不能覆盖模型凭据。SearXNG 可显式使用无认证实例，其余 provider 缺 key 时 Host 不声明能力。(5) Host 启动时解析
有效配置并据此握手；因此更改 provider 后 UI 明示需重启，新 session 才构造 `websearch`。(6) webfetch/websearch 的持久 tool result
details 携净化后的 title/URL；PiChatView 从 transcript 投影到现有 session state，稳定键去重，pin/remove 只属本地展示，正文与 key
都不进 UI store。

原因：旧 resolver 把“模型供应商声称支持搜索”变成永远空结果，正是项目禁止的失败→空成功；配置 API 的 adapter 也全部只返回空。
凭据若直接写 Harness settings 会进入普通设置 JSON，若允许 route 接收任意 credentialRef 又可误覆盖模型 key。来源直接从持久
transcript 重建，比让一个未接线的 Zustand store 成为第二真相更可靠。

影响：protocol Harness web settings ownership；Host search adapters、启动 wiring 与 credential routes；pi-host websearch details/真实 Pi E2E；
Harness Settings 与 session state 来源区；10 locale；设计 5.8、plan/status 1b.3/1b.5。

状态：已实施并 proven（外部 live key smoke 需用户实际 provider 凭据，不是默认测试前提）

### D-160 · 2026-09-08 · bash 输出压缩按命令分派规则解析；模型总结只作附加

背景：维护者问"工具输出的裁剪那里，我们现在是直接裁剪的吧，如果专门有个小模型做裁剪或总结呢，可以减少 agent 拉取"。核实：
`tool-result-truncation.ts` 是纯字节头尾切——32 KB，头 50%（bash 37.5%），最近换行，全文进 OutputStore——对内容一无所知，
50 KB 测试输出的失败块在中间就得再拉。AFT 的 `compress/` 是五层规则：20 个命令专用解析器（vitest / jest / tsc / eslint /
biome / git / cargo / pytest / mypy / ruff / playwright / go / npm / pnpm / bun …）→ 输出形状嗅探 → 包管理器通配 →
TOML 声明式规则 → 通用去 ANSI 去重。**没有模型。**

决定：走 AFT 那条路。结构化命令输出本来就有结构，解析器几微秒精确抽出统计行与每个失败块、不会漏；小模型总结 50 KB 输出
可能把一个失败名写错或漏掉，而这个错是**静默的**——agent 以为测试全过就往下写。头尾切至少诚实，agent 知道中间被切了会去拉；
模型总结看起来完整，agent 不会去拉，这正是"减少拉取"的另一面：前提是总结不能错。所以方向对、手段分开：结构化输出按命令
分派规则（先做 Piarium 自己天天跑的 vitest / tsc / eslint / git 四个，每个带真实输出样本的确定性测试）；非结构化输出上模型总结
可以做，但只作**附加**——"这是头、这是尾、这是模型认为重要的几行、全文在句柄"——不替代头尾切，且明确标注是模型挑的行。
全文照旧进 OutputStore，句柄语义不变。

同一问题下维护者还问了"训练小模型做路由判断"。结论：`parseExploreQuery` 里靠正则和词表的推断（relation / domain / preferTests /
16 个英文问句词）在自然语言变化面前确实脆，但训练要标注数据（十条不够，蒸馏可行）、而且黑盒路由与"量具不能撒谎、每个决定说得出
理由"的纪律冲突——AFT 的 `QueryShape` 也选了正则。先用 3.16 反正要引入的嵌入模型做零样本分类（每类几个原型问题，最近原型赢，
不训练、跨语言、出错时看得到匹配了哪个原型），不够用了再谈蒸馏。真正值的"小模型进管线"是重排器（D-158）。

不改：OutputStore 句柄语义；32 KB 可见预算数值。

影响：设计 5.2；plan 3.17。

状态：已决定，待实施（plan 3.17）。

### D-197 · 2026-09-10 · 按命令整理 bash / get_output 默认展示（3.17）

背景：默认展示仍是字节头尾切。失败块在长输出中段时会被切掉；`tool_result` 再切一次会抵消任何命令整理。D-160 已定规则解析，不用模型总结替代。

决定：

1. 整理只改默认展示。`stdout` / incremental `text` 仍是原始 UTF-8；游标按原始 `nextOffset` 推进。显式 `offset`/`length` 与 `out_` 句柄继续读原文。
2. 用命令 token（含 `bunx` / `npx` / `bun run` 与 `&&` 分段）识别 vitest、tsc、eslint、git；无法从命令判断时只认窄输出形状。不执行命令，不调用模型。git 按子命令：status 保留文件状态，diff/show 保留 hunk 与请求正文，log 保留 commit；其余 git 走通用展示。
3. 可见预算仍是既有 32 KiB。超预算时说明省略并指向全文句柄，不新加 per-file/per-hunk 硬上限。退出码只来自进程。
4. 公开 `bash` 与增量 `get_output` 使用 `display`。`tool_result` 不再对这两项做头尾切。未完成或分片输出标明当前观察，不当最终结果。交互提示保留。
5. 本阶段不接 jest 专名、包管理器通配、TOML 规则层或附加模型总结。

验证：真实样本覆盖成功/失败/无法识别、中段失败块、ANSI/CRLF/分片、超预算省略；`createShellExecService` / `createShellReadService` 与公开 bash、get_output 格式化。未做完整 shell 解释器。

影响：`output-organize/`、`harness-services.ts`、`shell-supervisor.ts`、`bash-tool.ts`、`output-tools.ts`、`tool-result-truncation.ts`；设计 5.2；plan/status 3.17。

状态：已实施。

### D-199 · 2026-09-10 · 命令整理保留未知正文与原文读取（3.17）

背景：验收 D-197 复现了 pretty tsc 诊断被统计行遮掉、混合命令丢失前段结果、Vitest 失败位置和分片正文被静默丢弃。未知长输出被当成一个不可装入的块，只剩省略提示；按工具名无条件跳过截断也让旧 Host 的全文越过原可见预算。

决定：

1. 整理器只收起明确识别的成功/重复噪声，保留未知正文、失败上下文、定位和交互提示。统计行不是丢弃其他内容的依据。支持常见 plain/pretty 诊断；分片中的未知内容也保留。
2. 命令识别只使用可靠的执行位置和包装结构；混合输出不能可靠归属时用通用展示，不选择最后一个工具解析整份输出。无需完整 shell 解释器。
3. 通用超预算展示保留可读首尾；大块不能变成只有省略提示的空壳。沿用 32 KiB 展示预算与原文句柄，不增加文件/错误块硬上限。
4. 只有实际获得 Host 整理结果才免于二次裁切；旧 Host 和未整理结果继续沿通用展示路径。显式分页保持请求的原始 UTF-8 内容，游标、进程退出码和原始输出权威不变。

影响：命令识别/解析/展示、shell 默认读取、Pi 工具与 `tool_result` 截断；设计 5.2；plan/status 3.17。补正 D-197 的识别范围及无条件跳过截断，功能默认启用的方向不变。

状态：待验收。

### D-200 · 2026-09-10 · Windows shell 真实发现与按工作区配置接线（1.3）

背景：生产 `index.ts` 创建 `HarnessServiceHost` 时不传 `discoveredShells` / `shellSetting`。Host 因此用 `auto` 加空 discovery。普通 Windows 路径下 `selectInterpreter` 返回 “Git for Windows not found”，即使用户已安装 Git Bash 或在现有设置里选了可用解释器。e2e 里手工塞 `gitBashPath` 不能证明生产装配。

决定：

1. 解释器发现是 Host 机器级责任，复用 Git 服务 / environment runtime 已有的 Windows 安装根、PATH 可执行检查，以及已解析的 `git.exe` 旁边的 bash。优先记录可执行的 `usr\bin\bash.exe`，避免 `bin` 启动器和把 `usr\bin` 误写成 `usr\usr\bin`。WSL 发行版来自 `wsl.exe --list --quiet`（含 UTF-16LE）。不另建配置文件。
2. `harness.shell` 沿现有 Pi `settings.get`（用户默认 + 受信任项目覆盖）在**该会话注册时**解析，按 workspace/session 生效。Host 不再使用单一冻结的 `shellSetting` 作为生产权威。已运行的 PTY 不热切换；新会话或新 worker 代际再注册。两个工作区不能串用对方的解释器。
3. 生产 `index.ts` 在构造 Host 时传入真实 `discoverShells()` 结果；Host 在选项省略时也自己发现一次，避免再次漏接。设置读取失败回退 `auto` + 真实发现；非法 `harness.shell` 记为 unavailable 并给出修复入口，不假装未安装。
4. 本阶段只修可用性和配置接线。后台 shell 变终端 tab、bundled Pi 默认优先级不在此列。WSL 路径、PowerShell、远端和非 Windows 的原有选择规则保留；`auto` 在原生 Windows 上仍要求 Git Bash，不暗降到 PowerShell。

验证：注入式发现/设置单测；缺解释器走公开 `shell.exec` 的 spawn-failed；本机 Windows 上 Host 默认发现 + 公开 `shell.exec` 执行 `echo`。不把 e2e 手工路径当作生产证明。

影响：`shell-discovery.ts`、`harness-shell-settings.ts`、`service-host.ts`、`index.ts`、`shell-supervisor.ts`；设计 5.2；status 1.3；Host DOCUMENTATION。

状态：已实施。

### D-205 · 2026-09-10 · shell 注册按 actor 代际等待，退出以进程和写者完成为准

背景：D-200 的异步 settings 注册存在首个工具请求先到、旧 worker 注册迟到复活的问题。PowerShell 的 `-Command -` 不适用于 ConPTY。Host 丢弃会话时火忘关闭 PTY，也不能作为线程目录可回收的依据。

决定：

1. 注册按 authority/session/worker/generation 归属并去重，工具准入等待自己的注册。换代、会话关闭和 Host 停止使旧等待失效，迟到配置不能复活旧 actor。首次注册不清除已捕获的用户输入快照。
2. 设置读取失败明确 unavailable，替代 D-200 第 3 条的 auto 回退；配置有效时仍按工作区选定并固定解释器。PowerShell 使用真实交互进程与其自身命令包装，Git Bash 继续使用 Bash 包装。
3. 关闭先确认 PTY 退出，再释放命令写者。超时或失败不伪造已停，仍可观察与重试；被 drop/换代移出的 shell 在关闭完成前仍参与回收判断。线程的 sessions.close 等待这条 Host 关闭链，再完成 Pi 会话关闭。
4. `harness.cancel.requestId` 取消同 actor 已准入的请求，不额外要求搜索权限；按 `queryId` 取消 explore 仍要求 `read.search`。公开 merge 的 signal 进入同一取消链，不能因借用 explore 的权限检查而失效。

影响：session registration、Router、shell supervisor、service-host 与 index；不增加解释器设置或后台终端 tab。

状态：已实施，真实 Windows 与定向证据见 status 1.3。

### D-206 · 2026-09-10 · 后台 shell 接入终端 runtime，bundled Pi 默认与 todo 确认

背景：D-013 只复用了 PTY 模块，监督器与用户终端各自创建同类进程。无显式选择时 Runtime Manager 仍偏向 PATH/system。todo 曾因 confidence 低于阈值默认弹确认。

决定：

1. 生产监督器只通过 terminal runtime 的 `createTerminalSession` 取得 PTY。公开 `sh_N` 就是该会话 id。HTTP create 不能指定 `owner` / `spawn` / retain；程序化 API 才允许 harness spawn。用户附着走同一 runtime 的 attach/WebSocket，agent `get_output` / `write_to_process` / `kill_shell` 写同一 handle。关闭查看（DELETE retain 或 tab `closePolicy: detach`）不终止进程；force-kill、`kill_shell` 与 supervisor dispose 仍等真实退出再放写者，后台命令继续按会话 cwd 阻止回收。短命令不自动打开终端。
2. 没有 `selectedId` 且 bundled 为 ready 时，Runtime Manager 优先 bundled Pi。用户明确选择的 system/standalone/custom/source 只要不是 missing 就保持优先。这是 Pi 运行时选择，不是 `harness.shell`。
3. `todo` 的 confidence 只作信息。默认 `requireConfirmation: false`。只有已有、明确启用的审批策略才让 Host 返回等待，并由 pi-host 在该响应之后弹确认。不另造审批框架。

考虑过的替代：(1) 打开终端时重跑命令——不是同一进程。(2) 监督器继续自管 PTY、终端只镜像输出——两套生命周期。(3) 把 bundled 与 `harness.shell` 合成一项——混淆解释器与 Pi 运行时。

影响：terminal runtime / session API、shell supervisor / service-host / index 晚绑定、Runtime Manager 优先序、todo Host/pi-host、UI 时间线“打开终端”；设计 5.2 / 5.6、architecture 10、status 1.3 / 2.5。D-013 的未兑现前置在此收口。

状态：已实施；Windows Git Bash / PowerShell 与定向证据见 status 1.3 / 2.5。macOS / Linux 与完整浏览器点击链未测。

### D-209 · 2026-09-10 · 1.3 / 2.5（终端身份、退出事实与 todo 单一审批边界）

类型：问题与解法（补正 D-206）

背景：D-206 把 Harness shell 接进 terminal runtime，但初版仍由每个 `ShellSupervisor` 从 `sh_1` 开始编号；terminal runtime 是全局表，多个会话会碰撞。`kill_shell` 还可能在只发送中断、PTY 尚未退出时返回成功，强制终止则可能先移除会话再异步等待，导致 exit 事件、写者释放和目录回收互相失真。todo 的 Host 二次确认字段没有生产审批策略消费者，只留下一个看似可用的假契约。

决定：

1. terminal runtime 是 `sh_N` 的唯一分配者，编号在该 runtime 内全局唯一；监督器采用返回 handle 的实际 id。已有 id 只有 owner、创建来源、cwd、shell/spawn、writer 注册与 retain 语义全部一致且仍在运行时才能复用。HTTP 不能接管程序化 Harness 会话，已退出 id 必须先显式关闭。
2. 一条命令的 started/completed 由监督器在真实执行边界发出。后台命令由 PTY exit 完成，不依赖 agent 是否再次调用 `get_output`；重复读取不重复完成记录。
3. `kill_shell`、会话关闭和 force-kill 只在目标 PTY 真实退出、相关 process writer 释放后报告成功。退出或 writer 释放失败保留可观察、可重试状态，并继续阻止相关目录回收；迟到 exit 仍由原 handle 消费。
4. `todo.confidence` 只作内容信息。若 plan mode 或权限策略需要批准，批准发生在既有 pre-tool 流程；`todo.upsert` 不在写入后再问一次。删除没有生产消费者的 `confirmed` / `askedConfirmation` 协议字段，不保留假兼容层。

影响：terminal runtime / Harness bridge / shell supervisor / service-host、公开 shell 工具、todo protocol/Host/pi-host、设计 5.2 / 5.6、architecture 4.4 / 6、status 1.3 / 2.5。

状态：已实施；进程身份、跨监督器冲突、后台自然退出、终止失败和 writer 释放重试有定向证据。完整浏览器点击链与 macOS/Linux 真机仍未测。

### D-241 · 2026-09-12 · 3.17 / 5.2（包管理器通配进命令输出整理）

类型：问题与解法

背景：五层输出整理（设计 5.2）接了专用解析器与输出嗅探，`npm test` / `pnpm run build` 这类包裹命令靠正文形状碰巧
识别内层工具；内层输出被截断、缺页脚或格式不巧时就退回通用首尾。管理层自己的回显（`> name@ver script` 后接
`> 内层命令`、yarn/bun 的 `$` 行）是可靠的执行位置，此前没有被消费。

决定：

1. `identifyFromCommand` 把 `npm`/`pnpm`/`yarn`/`bun` 头的脚本运行与内置命令归为 `package-manager`：`run` 子命令后的
   名字是用户脚本而非工具身份；`exec`/`dlx`/`x` 子命令解析后直接跑二进制，二进制名仍是工具身份（`npm exec vitest` →
   vitest）；`npx`/`bunx` 裸包裹同理，解析不出时仍回 generic。`deno`/`node` 是运行时头，不归管理层。
2. `package-manager` 整理器先取管理器回显的内层命令（顶部窗口内第一个非 `name@ver` 的 `>`/`$` 行，深处的 `>` 行是
   工具正文不算回显），能经 `identifyFromCommand` 认出已知工具就把其后正文交给对应解析器——kind 记为内层工具，包裹
   行留在正文里；回显不可识别或缺失时对内层正文做形状嗅探，仍不识别才走管理器形状整理。
3. 管理器形状：错误块（`npm error`/`ERR_PNPM_`/yarn `error Command failed`）与 install/audit/完成摘要是必需项；
   `npm warn|timing|http|verb|sill`、进度、下载/解析类重复行折叠成计数并给首样本；其余正文原样保留——和 D-199 一样，
   收起只针对明确的重复噪声。内层识别了但正文完全不可认时回退管理器形状，不丢弃。
4. 混合命令（`npm test && git status`）仍按既有规则走通用展示，不把整份输出归给最后一个工具。

验证与边界：`organize.test.ts` 覆盖命令分类（run/exec/dlx/x 三分、PM 头、混合段）、`npm test`→vitest、`yarn test`→tsc、
`bun run test` 的 `$` 回显、echo 指向未识别工具时的正文嗅探、install 摘要+错误块+warn 折叠，以及 `shell.exec` 生产链上
npm 包裹 vitest 的整理结果。未实测 yarn berry（无回显，靠嗅探）与 pnpm 递归脚本；声明式规则与模型总结仍未接。

### D-247 — D-241 返工：包管理器输出整理修正

背景：D-241 接入了包管理器通配层，但验收发现四处缺陷——exec/dlx/x 后未知二进制
被标为 package-manager 而非 generic、所有 `npm warn` 行被折叠丢失唯一 warning、
进度行含 failed/error/checksum/permission 也被折叠、非零退出时可能解释失败的
manager 行未进 required。

决定（supersedes in part D-241 的 exec 未知二进制路由、噪声折叠范围与非零退出
required 部分；D-241 的 PM 头归类、脚本回显识别内层工具、PM 噪声折叠主体保留）：

1. **exec/dlx/x 未知二进制走 generic**：`classifySegment` 在 `WRAPPER_EXEC_SUB`
   分支内直接判断 wrapped 二进制——受支持工具返回其 kind，未知二进制返回 `unknown`，
   不再 fall through 到 `package-manager`。`pnpm dlx custom-tool` 的输出走 generic
   组织，PM 噪声折叠不会隐藏未知工具自身输出。
2. **只折叠可证明重复的噪声**：`isFoldableNoise` 区分 failure-relevant 噪声
   （含 failed/error/checksum/permission/denied/EACCES/EPERM/ENOENT/EBADENGINE/
   ERESOLVE）与可折叠噪声。Warning 行按内容去重——首次出现的唯一 warning 保留，
   重复相同 warning 才折叠。进度/下载行（非 warning、非 failure-relevant）仍可折叠。
3. **非零退出时失败解释行进 required**：`organizePackageManager` 在 `exitCode !== 0`
   时把 failure-relevant 噪声与唯一 warning 放入 `required`（fitBlocks 不裁切），
   而非 `optional`。成功退出时它们进 `optional`，预算压力下可裁切。
4. **原契约不变**：原 stdout、UTF-8 byte cursor、exitCode、OutputRef、显式分页与
   后台增量保持原契约——组织只影响 display text。

验证：`organize.test.ts`（未知 `pnpm dlx custom-tool` 走 generic；唯一 warning
保留、重复折叠；checksum failure 进度行保留；EBADENGINE 唯一 warning 在非零退出
进 required；watch/interactive prompt 保留；分片输出首尾保留）；既有 31 项 organize
与 3 项 observation-services 套件回归通过。

### D-289 · 2026-09-18 · 1b.8（默认网页搜索与原文续读）

类型：默认值调整

决定：`websearch` 是基础能力，Host 提供服务时默认注册。未选择搜索 provider 时，Host 直接使用 Exa 的免密钥远程 MCP 搜索，失败时顺序尝试 Parallel，并返回真实 provider 与换源说明。有效空结果正常返回；取消不换源。显式自配的 Brave/Exa/Tavily/Jina/SearXNG 仍优先，凭据缺失或撤销不能静默转免费服务。用户可显式关闭工具。

原因：原契约把 provider 配置当成上手前提，普通用户完成聊天配置后仍没有搜索。用户认可默认免密钥服务，并明确排除复用模型账户搜索；因此不探测模型的隐藏能力，不调用 Codex/Claude/Gemini 搜索授权，不借聊天凭据，也不增加辅助模型调用。

实现边界：统一原生 `websearch`，远程 MCP 仅作 Host 内部传输，不向用户要求配置 MCP 或安装进程。查询仅在工具调用时发出；设置页说明默认服务的接收方与免费限流。沿已有 user/workspace 域名约束及取消链执行，只有默认路线允许所述两源顺序切换，不并发广播查询、不轮换身份规避额度。来源仍是 URL/title/snippet，通过现有 transcript 来源面板呈现；`webfetch` 增加提取正文内的字面查找和行范围续读，复用已有抓取、缓存、SSRF 与来源收据，不建立第二份正文权威。

考虑过的替代：模型账户搜索由用户明确排除；自建搜索索引、默认浏览器抓 SERP 或让用户安装搜索插件不解决当前的低摩擦上手目标。免密钥入口按供应商当前公开服务工作，不承诺无限免费或长期 SLA。

影响：部分取代 D-050/D-067/D-283 的“未配 provider 不注册”和单 provider 默认要求；原生权限、固定设置代际、显式凭据撤销、域名 ceiling 与第三方工具替换规则保持。设计 5.8、plan 1b.8、status 1b.3 与模块文档同步。

状态：已决策；本轮实施与验证记录以 status 为准。

### D-302 · 2026-09-20 · 7H：工具资源调度与后台长任务交付

类型：设计修订 / 通用 Harness 后续阶段

决定：在当前 D-300 执行任务交付验收后，接续 7H，细化真实 Pi 工具批次调度，并让后台命令的完成事实接入 D-301 / 7G。
独立操作重叠执行，共享可变资源和因果依赖保持顺序；启动、观察等待、进程终止与模型续接分别建模。

原因：当前已有并行工具，但 Pi 0.85.1 的一个 sequential 声明会使整批串行；`apply_patch` 实际仍为 sequential，
原设计把不同路径并行目标写成已具备行为。长 shell 已可转后台并读取/输入/终止，却没有通用的后台完成 Zone 2 通知。
代码还存在 Host 默认 60 s 才转后台、bridge 默认 30 s 的期限失配，不能靠加大超时替代启动/等待责任的正确划分。

契约：

1. Pi 保持 loop/provider/session owner，调度进入真实工具执行接缝；Host 提供授权后资源事实，Rust/既有 owner 提交文件与运行进程。
   不复制 loop，不只做被上游串行挡住的 Host 队列，不在安装目录手改依赖交付。
2. 原生工具按规范资源/子树/branch/shell/线程协调，同资源保序，多文件操作协调完整集合；独立调用可重叠。
   未知 sequential 工具是有序屏障，屏障前后独立组可并行。工具并行不是只读许可，第三方来源/声明和原生权限门保持。
   模型不必填写依赖表，不增加调度模型、apply model 或无依据并发上限。
3. `bash` 短等待后返回完成或后台身份，并支持 `waitMs: 0`；具体默认按场景选定。统一传输与观察期限，
   等待结束不杀进程，清理空参数。启动响应丢失可凭执行关联查询，不盲目重跑；共享 shell 与后台分离后的新 shell 状态边界明确。
4. 现有 `get_output` 增加可选事件等待，默认读增量、显式分页读历史；取消等待与 `kill_shell` 不混淆。
   长等待不锁住控制通路；让出模型名额不释放仍运行的进程资源、writer 或目录保护。
5. 完成/失败/取消确认作为带执行身份、退出码和原文入口的新事实，送入 7G 环境增量并留史；不复制日志、不冒充用户终端，
   不改变团队完整短表的独立职责。终态交付收据与输出字节游标独立，工具已交付终态不再重复，UI 阅读不消费模型收据。
6. 活跃模型在自然请求中获知完成；空闲时仅由明确等待或完成后续做意图恢复既有会话，处理完成先到与自然续接竞态。
   输出增长本身不触发模型；保留合法工具调用/结果配对，不承诺任一并行结果先到就能开启下一模型请求。
7. 普通 shell 沿会话生命周期，不凭后台身份承诺重启恢复或耐久全文；实验沿 D-300 durable attempt 的远程/重附着合同。
   复用进程、输出与事实来源，不强制每条命令登记实验或建立第二套任务数据库/面板。

影响：修订 Harness 5.0/5.2/5.5/5.9，补充 8.1.1 的环境来源；plan 追加 7H，status 明确代码核对与未实施边界。
与 D-301 共用请求前准备，D-300 实验/通信及 D-205/D-206/D-209 的真实退出、writer 释放与目录保护保持。
原任务按收到的 prompt 验收，不能用后续设计追溯判失败；现有调用数或辅助队列测试不能替代真实 Pi→Host→后端并发证据。

状态：设计已接受 / 当前执行任务之后接续 / 尚未实施或验收。源码核对不等于运行时复现，也不证明性能收益。

### D-306 · 2026-09-20 · 阶段 S：对话式设置与 Agent 管理

类型：产品设计 / 通用 Harness 后续阶段

决定：在 D-305 之后新增阶段 S，让设置页与对话管理同一套配置，覆盖现有大部分设置及相关管理动作。
原生查询/修改工具提供实时事实与执行能力；共用描述支持渐进式披露；Skill 按需提供组合方法和复杂示例。

原因：用户希望直接通过对话调整工作环境，不必翻找众多设置页。已有应用设置、Pi/Harness 配置、资源和扩展 API
各有 authority，但缺少统一的 Agent 发现与操作入口。只写 Skill 无法提供真实当前值、动态选项和生效状态，
为每个设置单独注册工具又会扩大上下文并产生重复定义。

契约：

1. 范围覆盖产品主要设置类别，不只少数 Harness 开关。UI、Agent 和生成说明共用描述/校验来源，
   原 owner 继续持久化和执行副作用；不新增配置数据库、并行 resolver、任意 Host RPC 或内部文件写入后门。
2. 常驻短能力入口，search 提供相关设置和简单操作所需信息，read 按需展开复杂参数、动态选项、示例和来源。
   支持分类浏览及已知 ID，不强制 search → read → Skill，不用固定条目截断隐藏目录，不新建查询 LLM/向量库。
3. update 支持局部 set/reset，reset 撤销真实范围覆盖；revision/冲突保留后续用户编辑。
   同 owner 使用原子更新，跨 owner 如实报告部分成功；登录/安装/连接调用原领域动作并返回实际状态。
4. 范围、设备、Host、Surface、owning workspace 与当前运行配置分别解析。D-031 字段所有权和原生权限门保持，
   修改权限按原有效授权检查；凭据只返回状态和使用引用，已有授权内的普通调整直接完成。
5. 保存与实际应用分开，冻结配置在合法 Run/世代边界生效，不同步 reload 正在执行设置工具的自身会话。
   UI 与 Agent 双向同步同一事实，重连/迟到事件/并发编辑不得覆盖新目标和用户新值。
6. Skill 解释组合用法并引用稳定 ID/能力入口，不复制实时配置、参数表和凭据，不成为单项操作的强制前置。
   指南沿产品 Skill 体系按需加载；本决策不要求新增仓库贡献者工作流 Skill。
7. 详细说明进入普通工具结果，相关变化沿 7G 环境增量交付，不改写历史前缀、不重复工具已交付事实，
   不将完整设置放入团队表，不因配置变化唤醒空闲模型或产生额外总结调用。

考虑过的替代：纯 Skill 手册作为唯一入口不能保证实时事实和实际执行；每字段单独工具会膨胀模型输入；
全量设置长文常驻不符合渐进披露；额外配置数据库或 Agent 专用 writer 会使界面与对话各自维护状态，因此不采用。

影响：新增 agent-settings-design；plan 增加 S0–S4；Harness 5.11、architecture、roadmap 与 status 登记计划边界。
后续实施复用现有 Application Host、Pi/broker、设置/扩展/资源服务、原生权限、7G/7H 与 UI 应用机制。
验证围绕真实消费者和具体风险，不以固定设置数、源码断言、测试数量或全平台实测清单作为通用门槛。

状态：设计已接受 / 待实施 / 尚未验收。本文档交付不代表设置工具或完整目录已进入生产。

### D-307 · 2026-09-20 · 阶段 W：会话等待、触发与续接

类型：产品设计 / 通用 Harness 后续阶段

决定：在阶段 S 之后实施 W，让 Agent 自然登记时间、事件或程序条件，以及满足后在原会话/线程继续的工作。
程序负责等待和明确条件检查，只有条件成立或约定评估节点到达才交付；保留周期新建任务，同时收口原 scheduler 的真实运行状态。

原因：长命令和实验期间，反复调用 Agent 检查“是否好了”浪费请求与输入费用。
原定时任务以新建会话派发为主，缺同一工作身份的续接；其成功状态在 agent.prompt 启动接受后就更新，
不能代表任务/Goal 最终完成。现有 7G/7H/7I 提供事件、输出和耐久实验基础，适合直接补齐触发到续接的链路。

契约：

1. 常驻简短能力说明，长任务结果给稳定来源身份与后续入口；简单等待直接登记，复杂条件再按需查询说明，
   不要求强制汇报字段、先读 Skill、额外规划模型或工作流 DSL。
2. 注册后续与立即暂停分开。非阻塞登记允许其他工作继续；明确等待才让出模型名额，并使 Goal 停止空转审计/自动续做，
   保留目标和实际执行资源，不把等待当作完成或 blocked。
3. 优先权威事件，外部无推送来源做程序状态查询；语义判断写进后续指令，在适当节点由模型处理。
   不按每段日志/采样唤醒，不用未知/离线状态伪造失败，频率按任务和来源能力选择，不设统一轮询周期。
4. 时间可独立触发或作事件后备；定义、来源游标、发生及投递关联持久化，持续为真的条件不重复唤醒。
   注册时已满足、同时事件、响应丢失和重启按真实状态/稳定身份处理，不重复派发或重启原实验。
5. 活跃目标通过 7G/既有消息在自然请求中接收，空闲且有继续意图时经过原运行准入恢复同 session/Thread；
   主/子均可用，用户新输入与自然续接竞争不产生第二份运行。取消/替换/归档/删除的旧定义不复活。
6. Pi 保持会话/Run 语义，Host 拥有策略，Rust/原后端存储轻量耐久记录和来源事实；
   不复制 Agent loop、日志和任务数据库，普通 shell 不因等待持久化而获得实验级重启保证。
7. 会话提供轻量等待条目和修改/取消/检查入口；检查事实与主动调用模型区分。
   原 GUI/CLI/Markdown 排程接同服务，目标类型和错过时点策略明确，接受、运行、完成、Goal 终态分别呈现。
8. 触发结果简短、带来源与展开入口，沿既有收据去重，不修改历史前缀。
   省去空转模型调用不等于网络/外部查询无成本，也不宣称长等待后的缓存命中或固定费用收益。

考虑过的替代：固定间隔唤醒 Agent 检查进度仍会空转；所有触发新建会话会丢失当前工作关系；
每条事件先过小模型判断会增加持续成本；为长任务另建工作流引擎会重复已有线程、实验和调度权威，因此不采用。

影响：新增 agent-follow-up-design；plan 增加 W0–W4；Harness 5.9.3、architecture、roadmap、status 和 scheduler 模块文档同步。
现有 7G/7H/7I 与阶段 S 的交付范围保持，完整生产接线和具体风险证据由后续实施补齐。

状态：设计已接受 / 阶段 S 之后待实施 / 尚未验收。仅有原定时任务、Goal 和后台句柄不能标为完整 W 已交付。

### D-308 · 2026-09-20 · 阶段 S/W 验收返工与完成边界更正

类型：问题与解法 / 实施边界更正

决定：保留 D-306/D-307 已接入的核心纵切，但不接受“两个阶段均已交付”的结论。直接修复设置 owner 与
follow-up/scheduler 的生产错误，并将 S/W 继续标为 Partial，直到原设计中的领域动作、客户端 Surface、其余触发来源、
远程续接和生命周期收口实际完成。

原因：验收沿真实消费者发现，设置写入会同步 reload 正在执行工具的 runner，非法 Harness JSON、未信任 project effective、
secret reset 和错误 scope 可以穿过目录；follow-up 存在跨目标访问、注册丢事件、远期 timer 提前触发、旧 revision 回调、
Goal 崩溃窗口与 restart CAS 缺口。scheduler 又在第一轮 settle 误判多轮 Goal，并以 30 分钟 watchdog 在真实任务仍运行时
释放不重叠身份。已有测试通过与“W0–W3”标签不能证明这些契约成立。

实施：设置字段写回在原 owner 写前使用真实 validator，self reload 延迟到安全边界，UI 失效使用 epoch/可排队刷新；
follow-up 保留真实 caller scope，observer/pause intent 先耐久化，绝对时间分段，occurrence/definition CAS 对账，多个等待共享
Goal pause 身份；scheduler 跟随真实普通 Run/Goal 终态，删除无取消能力的 watchdog，补 producer shutdown 和 loop 初建 watcher。

考虑过的替代：仅修改报告会留下实际越权、丢唤醒和重复运行；为每个缺陷新增一套平行服务会破坏 owner；继续增加固定超时、
重试数或全仓测试不能解决状态机。采用原 authority 上的局部契约修复和定向证据。

影响：更正 agent-settings-design、agent-follow-up-design、plan S/W、status、architecture、roadmap 和决策索引；
S 的 action/client/跨 owner/S4 与 W 的其他 source/remote/archive-delete/完整 Agent scheduler 管理继续是未实现或未接线，
不能改称仅未实测。

状态：已实施核心返工 / 定向验证通过 / S 与 W 保持 Partial。

### D-309 · 2026-09-20 · 阶段 S/W 剩余项实施收口

类型：实施 / 交付边界

决定：完成 D-308 留下的 S/W 未接线项。设置侧把 catalog actionRef 域经 `settings-actions.ts` 注册表接到各领域
真实 owner（provider/MCP/Pi 资源/扩展/语言组件/远程/Git identity 等），client owner 经 `client-surfaces.ts`
Surface 桥按调用方会话解析目标应用；`settings_update` 支持 items[] 组合请求；`settings_search` 携带实时值摘要；
产品 Skills 按需种子到 agentDir。follow-up 侧补齐 artifact/file/metric/log/external 来源、受管远程重附着、
目标生命周期 settleTarget 收口与 kernel `storage.list` 跨 workspace 枚举恢复。scheduler 侧经 `schedule.*` harness
方法与 pi-host `scheduled_task` 工具暴露 calendar 管理（workspace→project 解析、loop revision CAS、run 等待真实
settle），并在 syncProject 对账持久化 running 与 overdue 一次性任务补跑。

原因：D-308 明确要求这些项实际完成后才能收口 S/W；本条记录其已接线事实与剩余边界，不提前宣称阶段完成。

实施：协议新增 `harness-scheduled-tasks.ts` 与 `harnessScheduledTasks` 握手能力；HarnessServiceHost 注入
scheduledTaskService 并注册 schedule.*（workspace→project，错误映射，CAS 透传）；pi-host `scheduled_task` 工具
受能力与 `tools.scheduled_task` 门控；runtime 对账 stale running→error、once 补跑一次、持久化创建即写
lastSessionId；设置侧 settings.action + Surface 桥 + items[] + 搜索摘要 + product-skills 种子。

影响：更正 agent-settings-design、agent-follow-up-design、plan S/W、status、architecture、roadmap 与本索引。
仍未实现：跨来源 all/any 复合算子、相容观察去重；仍未实测：真实外部登录/安装、跨平台 Surface、完整桌面重启
与真实模型链。S 与 W 继续保持 Partial。

状态：已实施 / 定向验证通过 / S 与 W 保持 Partial。

### D-310 · 2026-09-21 · 阶段 S/W 第二轮生产验收与边界收缩

类型：问题与解法 / 实施边界更正

决定：不接受 D-309 的“剩余项收口”作为完成结论。保留其真实 owner 纵切，同时修复认证 Surface、secret 投影、
compound revision/result、并发 reload、follow-up 观察/恢复和 calendar 状态机中的生产缺陷。S/W 继续为 Partial；
“全部来源”“按调用方会话解析 Surface”“实验删除已收口”和文件系统级 CAS 等超出现有证据的表述撤回。

原因：验收发现 events/ack 未认证且可由请求选择任意 Surface；跨 owner 共用 revision、重复 path 覆盖和字段失败
仍可被报成 applied；配置原文可能把凭据送入模型。follow-up 的 external poll 与 deadline 共用 timer，log cursor
会漏跨追加匹配，file 观察有 scope/ready/reset 缺口，远端首次离线不登记恢复关系。calendar 又存在 partial upsert
名实不符、once 时区错误、slash Goal 提前成功、run-now 绕过 admission、非原子进程内 loop CAS 和 project status 泄露。

实施：Surface 路由使用 UI auth，并把 ACK 绑定认证主体、Surface 和 connection nonce；多 Surface 在尚无 session 绑定时
返回 ambiguous。设置 action 输出领域白名单事实，删除假 operation handle；compound 使用 owner/scope 自己的 revision，
冲突路径和字段失败显式返回。follow-up 分离 timer，修复 log overlap，等待 file watcher ready 并持久 baseline，校验
workspace scope，delivery 窗口进程内合并并重新 prime；远端重连只 inspect/reconcile。Thread/session lifecycle 可重试，
未存在的 attempt-delete 入口不再宣称接线。calendar 按任务时区、真实 Goal 终态和同一 admission 运行，Piarium 内
loop writer 串行 revision 临界区，启动/停止 generation 与 missed-slot 身份完成对账。

影响：更正 settings/follow-up design、plan S/W、status、architecture、roadmap 与 scheduler 模块文档。仍未实现：
session→Surface 绑定与多 Surface 安全点选、统一耐久 action-operation 域、普通 shell 耐久 source、跨来源 all/any、
相容外部观察共享，以及无耐久历史的 file/metric 短暂边沿在 Host 崩溃窗口的 exactly-once。active inform 被接受后
恰逢 Run settle 再转 continue 的两套 receipt 仍缺统一消费证明。跨平台 Surface、真实外部登录/GitHub、完整桌面重启
和真实模型链继续只是未实测。

状态：生产缺陷已修复 / 定向整合验证通过 / S 与 W 保持 Partial。

### D-311 · 2026-09-21 · 阶段 S/W 生产收口与完成边界

类型：实施 / 生产合同收口

决定：完成 D-310 保留的实际功能缺口，并将阶段 S 与 W 在当前产品范围内收口。设置侧以认证主体、live session、
Surface 和 connection nonce 建立单次绑定；client 操作只解析调用 session 的连接，多窗口不猜选。真实异步 action
使用 Rust typed `settings.operation`，身份绑定 session + catalog entry + owner operation id；没有 status/cancel authority
的 owner 不生成假运行。follow-up 侧交付 `all`/`any` hidden leaves、共享 owner 观察、typed observation、普通 shell
生命周期与输出游标、以及复用 `thread.send` ledger/target lock/admission 的 Thread 投递。

原因：D-310 的 Partial 既包含真实未接线项，也混入了外部实测和 owner 固有限制。本轮沿生产消费者补齐前者：Surface
重连/删除撤销旧绑定，operation lookup 不再按 session 全表碰撞；file/metric 事件在 Host 接收后先耐久化，复合重复来源
不会在 parent delivery 窗口吞掉边沿；普通 shell 登记会补读 supervisor 已有输出，实时 chunk 与 completion 按顺序交付；
暂时投递失败保留同一 occurrence 重试。阶段完成不要求把本地进程改造成跨 Host 作业，也不要求模型选择任意 UI 窗口。

边界：同一 session 同时连接多个 Surface 时返回 ambiguous；无 owner API 的设置 action 返回 unavailable。本地 shell 随
Host 生命周期结束，来源 owner 尚未把 file/metric 边沿交给 Host 前不存在可持久化事实。真实外部登录/安装、跨平台
Surface、完整桌面重启与真实模型链未实测；这些现场不作为本次功能完成门槛，也不标为 proven。

影响：更新 settings/follow-up design、plan S/W、status、architecture、roadmap、Harness 模块文档与决策索引。

状态：已实施并进入生产调用链 / 定向验证 / 阶段 S 与 W 完成。
