# Changelog

All notable changes to Varin are recorded here. The project is pre-1.0; the
private runtime protocol and product surfaces still move together.

## Unreleased

- Correct recovery-storage reporting: show shared catalog size once, omit empty workspace histories,
  report actual GC file bytes and failures, and hide unsupported history-delete/retention controls.

- Expand work-overview sections by default except Sources. Persist panel visibility and explicit
  section choices per runtime and conversation across navigation, reopen and reload.

- Remove reusable text snippets and the Library settings group, including `#name` pickers,
  send-time expansion requests, settings actions, translations and obsolete help pages.

- Remove the Fleet settings workbench, its runtime API, provider aggregation and plugin task bridges.
  Native subagent work remains in the conversation/work overview, and background commands remain in
  chat tool cards and terminals.

- Reconcile filesystem watcher resets/recovery incrementally instead of rereading every indexed file.
  Stable inventories skip embedding-model preparation and generation checkpoints; metadata skips no
  longer manufacture missing-watch coverage gaps. Distinguish index construction from code-relation
  maintenance in directory progress.

## 0.9.23 - 2026-10-04

### Release highlights

Varin 0.9.23 adds user-editable Agent instructions and scoped lightweight memory, separates
ordinary Agent memory from Bot memory, and improves tool execution and long-session performance.

#### Agent instructions and memory

- Edit the built-in system instructions in Settings, with global, project and conversation scopes.
  Density, style and autonomy presets insert editable text; the full preview includes project
  instructions, skills and memory. Inspect the last model request's system text and restore defaults.
- Add, edit, delete and move ordinary Agent notes between global, project and conversation scopes.
  Matching notes load directly into each subsequent model request. Selected chat text can be saved
  without a background model call, and concurrent settings edits report conflicts.
- Keep Bot instructions, long-term recall and automatic memory organization independent. Ordinary
  Agents no longer expose `recall` or run background memory organization.
- Remove Magic Prompts, prompt-template editors and command-template expansion, along with their
  obsolete configuration and tests. Git, review and plan actions, skills and native instruction files remain.
- Simplify default model instructions and tool descriptions while preserving parsed output contracts.
- Remove the four built-in configuration Skills and their startup generator; configuration guidance
  is provided by the settings tools on demand.
- Filter native Agent choices, dispatch/send parameters and generated team instructions by work focus
  and enabled state. Refresh them at run boundaries; disabled research roles cannot bypass the switch by inheriting a model.

#### Tool reliability and performance

- Let quick retrieval run independently of file reads and writes; cancel abandoned context preparation.
  Yield background association refreshes between files so plan updates and environment observations
  are not held behind one workspace-wide association pass.
- Decouple file-write completion from language diagnostics and index checkpoints, and preserve
  request-stage, queue and late-completion diagnostics for investigating remaining timeouts.
- Fix persisted webpage/PDF snapshot reads, storage record contracts, user-memory storage ownership,
  optional tool parameters, diagnostic line numbers and live-session MCP settings access.
- Keep research tools scoped to research work focus. Recover completed Responses reasoning text
  when needed and hide empty thinking disclosures.
- Reduce repeated document/thread catalog scans, IPC serialization and cross-process retrieval data.
  Isolate live chat updates from historical rows; reuse captured file hashes and compiled language queries.

#### Upgrade notes

- Ordinary Agent notes use a new independent store. Existing knowledge records are not automatically
  imported into the new memory list; Bot long-term memory remains on its existing storage path.
- System-instruction and note changes take effect at the next model request. Native instruction files
  keep their normal Pi loading behavior.
- Earlier builds generated `varin-research-environment`, `varin-multi-agent-models`,
  `varin-retrieval-setup` and `varin-remote-experiments` in the Pi skills directory.
  Delete these guides manually if present; this release stops generating them.

---

### 更新摘要

Varin 0.9.23 开放系统提示词编辑和分范围轻记忆，将普通 Agent 与 Bot 的记忆分开，
并改善工具执行、后台存储和长会话性能。

#### Agent 提示词与记忆

- 在设置中编辑官方内置系统提示词，支持全局、项目和会话范围。信息密度、语言风格、自主程度预设
  会插入可编辑文字；完整预览包含项目指令、技能和记忆，可查看上次模型请求的系统文本并恢复默认。
- 普通 Agent 记忆支持新增、编辑、删除和调整范围；每次后续模型请求直接加载适用的记忆。
  选中的聊天文字可直接保存，无需后台模型提取；并发编辑会明确报告冲突。
- Bot 保留独立指令、长期召回与自动整理。普通 Agent 不再暴露 `recall`，不再后台整理记忆。
- 移除魔法提示词、提示词模板编辑与命令模板展开，清理对应配置和过时测试。
  Git、审阅、计划操作、技能及原生指令文件继续可用。
- 精简默认模型指令和工具描述，保留实际需要解析的输出契约。
- 移除四份内置配置 Skill 及启动生成器；配置说明由设置工具按需提供。
- 子 Agent 派发参数和自动团队提示词按工作侧重与启用状态筛选，在运行边界刷新；
  关闭的科研角色也无法通过继承模型绕过开关。

#### 工具可靠性与性能

- 快速检索与文件读写独立执行，取消已放弃的上下文准备；后台关联刷新在文件之间让出执行机会，
  避免计划更新和环境观察一直排在整工作区关联解析之后。
- 文件写入完成不再同步等待语言诊断与索引检查点；保留请求阶段、排队和迟到完成诊断，便于定位剩余超时。
- 修复网页/PDF 快照持久化后的读取、存储记录契约、用户记忆库归属、可选工具参数、诊断行号和实时会话 MCP 设置读取。
- 科研工具仅在科研工作侧重下提供；补取 Responses 完成事件中的思考文本，隐藏空的思考折叠项。
- 减少文档/线程目录重复扫描、IPC 重复序列化和跨进程检索数据搬运；隔离流式聊天更新与历史行，
  复用文件捕获哈希与已编译的语言查询。

#### 升级说明

- 普通 Agent 轻记忆使用独立存储，旧知识库记录不会自动导入新记忆列表；Bot 长期记忆继续使用原存储。
- 提示词与记忆修改从下一次模型请求生效，原生指令文件保持 Pi 的加载行为。
- 旧版在 Pi 技能目录生成的 `varin-research-environment`、`varin-multi-agent-models`、
  `varin-retrieval-setup`、`varin-remote-experiments` 需手动删除；新版不再自动生成。

[完整提交记录 / Full changelog](https://github.com/Youzini-afk/Varin/compare/v0.9.22...v0.9.23)

## 0.9.22 - 2026-10-03

### Release highlights

Varin 0.9.22 adds a dedicated Bot mode, improves multilingual dictation and chat presentation,
and makes retrieval, indexing, and Agent configuration more practical for everyday work.

#### Bots and execution environments

- Switch between Workbench, IDE, and Varin bot from a compact mode menu. Bot conversations stay
  separate from the other modes, and their private home directories are excluded from background indexing.
- Name new Bots and manage pinning, renaming, profiles, memory, sleep/wake, archive/restore, and deletion
  from their context menus and settings. Deletion stops owned work and cleans Bot-owned sessions and
  generated resources, with durable pending/error state and retry.
- Bind work and computer targets independently; add cross-environment open/file writes, authenticated
  service forwarding, desktop follow-ups, component recipes, and persistent operation evidence.
- Attach Chromium CDP and LibreOffice UNO to the visible Linux desktop session. Linux VM and remote
  desktop integration remains experimental; real target-host validation is still pending.
- Fix Windows computer-driver startup by resolving unpacked script paths and initializing UTF-8 output.

#### Chat and Agent controls

- Refine typography and compact tool disclosures; show actions and usage once per turn, with a wider
  adjustable conversation column and a composer aligned with the persistent work overview.
- Show streamed file edits with additions/deletions and live quick-retrieval progress with source evidence.
  Add chat context menus and memory extraction from selected text.
- Manage queued messages individually, choose queueing or steering the current task, and apply prepared
  context summaries immediately at safe request boundaries.
- Edit built-in, custom, and plugin Agents in a list/detail layout, including names, models, temperature,
  prompts, and tools. Remove automatic review and merge gates; keep review Agents available on demand.
- Upgrade the bundled Pi runtime to 1.0.0 and integrate native runtime references and image usage reporting.

#### Projects, retrieval, and providers

- Create named projects with multiple folders. Manage index directories, pause/resume updates, check
  for changes, and remove generated index resources when deleting a directory.
- Persist scan hints and reuse unchanged index content after restart. Move native index storage work
  off the desktop main thread, coalesce source updates, and reuse immutable chat history during streaming.
- Preserve partial retrieval material at deadlines, progress candidate preparation, and keep delivered
  source windows faithful to the selected results. Add text fallback coverage for unsupported languages.
- Page authorized file bytes before decoding or transport; retain draft/version checks and explicit
  cross-project path authorization. Let cancellation bypass a blocked session request queue.
- Separate chat, embedding, reranking, and fast-decision provider capabilities, expose custom API formats,
  and discover/import models for each enabled capability. Repair projectless inference configuration,
  reranker document formatting, transient embedding retries, and failed model-catalog retry states.

#### Multilingual voice and maintenance

- Add Whisper large-v3 Turbo, Qwen3-ASR 0.6B, and SenseVoice Small; default local dictation to multilingual
  Whisper Turbo, expose language selection, and unify voice preferences and model lifecycle.
- Upgrade Wasmtime to 48.0.4 for upstream security fixes. Apply verified dependency repairs for braces
  and HTTP cache semantics, and stage the Pi patches correctly in Docker builds.

---

### 更新摘要

Varin 0.9.22 加入独立 Bot 模式，改善多语言听写和聊天显示，并完善检索、索引与 Agent 配置。

#### Bot 与执行环境

- 从紧凑的模式菜单切换工作台、IDE 和 Varin bot。Bot 会话与其他模式分开，私有目录不参与后台索引。
- 新建 Bot 时可填写名称；右键菜单和设置支持置顶、重命名、档案、记忆、休眠/唤醒、归档/恢复和删除。
  删除会停止所属工作，清理 Bot 会话及生成资源，并保留可恢复的处理状态、错误和重试入口。
- 分别绑定工作环境与电脑目标，加入跨环境打开/写入文件、认证服务转发、桌面事件跟随、组件配方和持久操作证据。
- Chromium CDP 与 LibreOffice UNO 接入同一可见 Linux 桌面。Linux VM 和远端桌面仍为实验性能力，尚待真实目标主机验证。
- 修复 Windows 电脑驱动启动的解包路径与 UTF-8 输出问题。

#### 聊天与 Agent 控制

- 调整文字排版和工具折叠显示，辅助操作与用量按整轮呈现；聊天宽度可调，输入框与聊天列一起为固定工作概览留出空间。
- 文件编辑实时显示增删变化，快速检索展示进度与来源证据；加入聊天右键菜单和选中文本提取记忆。
- 逐条管理排队消息，可选择排队或补充当前任务；已准备的上下文摘要可在安全请求边界立即应用。
- 用列表和详情编辑器管理内置、自定义与插件 Agent，开放名称、模型、温度、提示词和工具配置。
  移除自动审阅与合并门禁，保留按需派发的审阅 Agent。
- 内置 Pi 升级至 1.0.0，接入原生运行时引用和图像用量统计。

#### 项目、检索与提供商

- 创建项目时可命名并选择多个文件夹；索引目录支持新增、暂停/恢复、检测更新，以及删除对应的索引资源。
- 持久保存扫描提示，重启后复用未变化的索引内容；原生索引存储移出桌面主线程，合并文件更新，并复用流式聊天中的不可变历史。
- 检索到截止时间时保留已取得的材料，推进候选准备，保证选中片段完整呈现；为结构解析未支持的语言加入文本分块覆盖。
- 文件读取在解码和传输前分页，保留草稿、版本与跨项目路径授权；取消请求可绕过阻塞的会话请求队列。
- 分开配置聊天、嵌入、重排和快速决策能力，自定义提供商可选择 API 格式，并为启用的能力拉取和导入模型。
  修复无项目推理配置、重排材料格式、嵌入临时失败重试，以及模型目录失败后的状态与重试入口。

#### 多语言语音与维护

- 新增 Whisper large-v3 Turbo、Qwen3-ASR 0.6B 和 SenseVoice Small；本地听写默认使用多语言 Whisper Turbo，
  支持语言选择，统一语音偏好与模型生命周期。
- Wasmtime 升级至 48.0.4，纳入上游安全修复；验证并修复 braces 和 HTTP 缓存语义问题，修正 Docker 构建的 Pi 补丁路径。

[完整提交记录 / Full changelog](https://github.com/Youzini-afk/Varin/compare/v0.9.21...v0.9.22)

## 0.9.11

Piarium 0.9.11 adopts Electron 44 across the desktop shell, applies upstream security fixes to the
native parsing and compute stack, and repairs the packaged desktop release path end to end.

- Upgrade the desktop shell to Electron 44 with the coupled context-menu update, align Capacitor
  and isolated Pi runtimes, and adapt SQLite cursor and login-startup APIs
- Move native parsing to patched tree-sitter 0.27 and Wasmtime 48 releases, adapt cancellation and
  query captures, enable Cargo dependency updates, and audit the Rust lockfile in CI
- Integrate Dependabot upgrades across Pi, Vite, ESLint, CodeMirror, jose, and Workbox and adapt
  the affected runtime consumers
- Build the Rust kernel before native tests, trim packaged native payloads, supply the missing
  platform binaries, and admit the isolated desktop smoke workspace so packaged releases verify
- Isolate Windows kernel acceptance suites and await process exit when validating truncated
  transport; verify the splash lifecycle without compiler text snapshots

## 0.9.10

Piarium 0.9.10 brings the native Agent Harness and Rust system kernel into the product, with
durable task threads, background context preparation, and a cleaner workspace interface.

- Move working state, recovery records, file operations, materialization, processes, and search
  computation into a private Rust kernel shared by desktop and remote Application Hosts
- Add task-centered threads with isolated branch views, nested dispatch, directed messages,
  continue/fresh execution, fixed-result integration, and archive, restore, and deletion controls
- Preserve unsaved editor drafts through reads, edits, thread baselines, and merge operations;
  retain operation records and conditional compensation for interrupted changes
- Prepare context compaction in the background, retain original recent material, and track observations
  across compaction without repeatedly injecting unchanged context
- Add native code exploration combining lexical, structural, graph, and semantic retrieval, optional
  model-guided selection, configurable embedding/rerank providers, and evidence-focused retrieval threads
- Bring tool permissions, web fetch, and configurable web search under native Harness settings;
  add knowledge management and semantic recall through the existing provider bindings
- Attach background commands to the same terminal process users can inspect and control, organize
  command output, and project user terminal activity into workspace context
- Give Agent Harness its own settings section with focused pages, automatic saving, and editable
  permission rules; simplify the composer, sidebar, and activity presentation
- Refresh built-in themes with neutral reading surfaces, themed buttons and selections, localized
  names and palette previews; separate right-panel restoration from the collapsible icon rail
- Fix Windows development builds locked by running Hosts and strengthen kernel lifecycle, CI,
  Docker builds, and packaged runtime boundaries

## 0.9.9

Piarium 0.9.9 turns the Agent and IDE workbenches into a more complete extension platform, hardens
the native recovery journal, and closes several lifecycle gaps across chat, desktop, and cloud builds.

- Change the composer send action into a real stop control while Pi is responding, without leaving
  queued or in-flight turns behind an inactive send button
- Harden recovery with read-only catalog inspection, per-file crash phases, conflict fingerprints,
  scoped workspace-history deletion, and deterministic compensation after interrupted restores
- Publish truthful Shell seam declarations, mount all six IDE regions through real replacement hosts,
  and let managed Shells compose replacement and slot children with generation-owned cleanup
- Add structured `when` expressions and transactional owner-scoped context keys for managed and isolated
  extensions; failed or superseded candidates cannot leak state into the active workbench
- Retain unsupported contribution contracts in the catalog while preventing their execution, report the
  exact compatibility failure, and make `single`, `selected`, and `all` service binding unambiguous
- Move framework-neutral application APIs and runtime auth/fetch/URL switching into
  `@piarium/application-client`, enforce UI dependency layers, and load official Shells by Surface
- Exercise generated external Shells through real replacement, slot, and disposer behavior, and keep the
  extracted application client in the reproducible cloud/Docker runtime dependency graph

## 0.9.8

Piarium 0.9.8 makes workspace rollback proportional to the files Pi actually changed, while refining
desktop updates and response-usage reporting.

- Show a locked “Restarting Piarium” transition while the desktop updater stops background services
  and hands off to the installer, with interaction restored if the restart request fails
- Keep Host-registered workspace identities valid across project-selection changes so background checkpoints
  and rollback cannot be rejected by stale settings; normalize Windows path identities consistently
- Aggregate token usage across every model call in a user turn and render it once after the final response,
  using compact icons and showing cache-read or cache-write totals only when present
- Replace workspace-wide snapshots and scans with an affected-file journal: Pi write and edit mutations capture
  immutable before-images, while unchanged turns create no workspace payload
- Restore only journaled paths through content-addressed objects, keep redo data, and surface precise conflicts or
  incomplete coverage instead of silently scanning or rewriting the whole workspace
- Apply ordinary rollback directly and reserve the recovery dialog for choices, conflicts, or incomplete external
  mutations, keeping the common path immediate and visually quiet

## 0.9.7

Piarium 0.9.7 fixes packaged desktop Pi startup and makes the chat rendering modes behave as their
names describe.

- Resolve Electron's external Pi Host once for both Runtime Manager probes and live Broker generations;
  never hand an `app.asar` path to Node, and show a Piarium repair action when application Host files
  are missing instead of suggesting a Pi upgrade
- Launch the unpacked Host through a real Runtime Manager probe and live handshake during packaging,
  and require the Windows production application to activate a selected Pi before release
- Implement Sorted chat rendering as a live Activity group for thinking, tool calls, and tool-use
  justification, followed by the completed answer; Live mode keeps the original arrival order
- Preserve extension-owned message renderers, Activity expansion preferences, exact usage reporting,
  and complete locale parity across both rendering modes

## 0.9.6

Piarium 0.9.6 adds native Pi session-tree navigation and makes workspace recovery practical for
large, long-lived projects.

- Add a searchable `/tree` timeline with active-branch context, labels, keyboard navigation, and
  recovery or forking from any user or assistant message
- Move turn checkpoint capture out of prompt admission, serialize background capture per workspace,
  and reuse unchanged workspace heads instead of rescanning before every message
- Honor workspace Git ignore rules, stage only affected restore paths, and make no-file-change recovery
  complete without copying or advancing the workspace timeline
- Split the short filesystem restore transaction from retryable conversation navigation; make
  maintenance process-owned, release it on shutdown, reclaim it after process death, and migrate old
  ownerless locks without blocking new sessions
- Run the development Web Host on Node with crash-exit behavior so a Bun native panic cannot leave the
  renderer indefinitely sending against a dead backend

## 0.9.5

- Refresh distribution-owned Host artifacts by build fingerprint so upgrades cannot keep running stale
  recovery code; restore new-session workspace checkpoints and recovery-history inventory on existing installs

## 0.9.4

- Add a desktop About settings page with the current version, honest update status, automatic and manual
  update checks, release installation, and persistent update preferences
- Add compact Settings, shortcut help, About, and available-update actions to the conversation sidebar footer

## 0.9.3

Piarium 0.9.3 replaces plugin-backed workspace rollback with a Piarium-native recovery system and
makes its storage practical to manage across projects and platforms.

- Bind immutable workspace checkpoints to Pi conversation turns and offer verified conversation-only,
  coordinated in-place, or new-workspace recovery without resetting or cleaning the project Git repository
- Make native recovery a replaceable, versioned Piarium Host service with crash-safe operations, safety
  checkpoints, explicit review states, and recovery undo
- Add global recovery storage defaults plus higher-priority project overrides for application data,
  workspace-local, workspace-adjacent, and custom folders
- Migrate inherited histories through copy-and-verify switching, list histories by recent activity, clean
  unreachable objects in one action, and manage or delete individual workspace histories
- Keep workspace identities usable while roots are offline and unify Windows long, short, namespaced, and
  missing-child path identities without weakening write and restore boundaries
- Preserve portable symlink targets, support long Windows SQLite paths, and keep offline Host-owned recovery
  histories available for maintenance
- Fix Monaco find and replace controls rendering missing-glyph boxes by awaiting and protecting the Codicon font
- Remove the unimplemented anonymous usage-reporting setting and keep the selected recovery preference durable

## 0.9.2

Piarium 0.9.2 makes project navigation, Pi runtime isolation, custom providers, and the IDE editing
workflow substantially more dependable.

- Refine custom provider model capabilities with explicit image, tool-calling, reasoning, supported
  thinking-level, and custom thinking-level controls
- Isolate catalog, workspace, package, and session workers so a stalled extension cannot block the
  session list, another workspace, or recovery through Pi package management
- Rework the session navigator around project-first conversation groups, compact actions, search,
  batch selection, project sorting, tree/flat display, and a quieter context rail
- Make current-file find/replace and related Monaco shortcuts target the editor that received the key,
  remove conflicting desktop accelerators, and open IDE workspace search with `Ctrl/Cmd+Shift+F`
- Jump workspace text results to the exact match, including lines containing Chinese, emoji, or other
  multibyte text
- Make English the default community documentation language and keep the contributor guides and code
  of conduct available in five languages

## 0.9.1

- Provision MCP, permission management, workspace history, and prompt repair for new Pi runtime
  environments while keeping each integration removable and independently configurable
- Use the Piarium-maintained MCP adapter package and preserve existing compatible installations
- Improve foundational package recovery, concurrent package operations, and native desktop release
  packaging across Windows, macOS, and Linux

## 0.9.0

Piarium 0.9.0 turns the Agent Workspace and IDE Workbench into a more cohesive daily workspace,
with a unified editor platform and a substantially refined Pi-native conversation experience.

- Fix packaged desktop language services by resolving built-in ASAR assets to their physical unpacked
  directory, launching Electron-backed language processes in Node mode, and shipping self-contained
  TypeScript runtime metadata
- Use one Monaco-backed file editing platform across desktop/Web Agent and IDE Workbench while keeping
  mobile and embedded CodeMirror views on the same revisioned document authority
- Complete rich Host-owned language features, atomic multi-file edits, file/Git diffs, debug/test
  projections, Agent attachments, conflict recovery, and Profile-safe model reuse
- Publish the framework-neutral editor controller and optional owner-scoped Monaco augmentation service
  through the Piarium extension tooling contract
- Keep Monaco lazy from ordinary Web, mobile, and mini-chat entrypoints and verify cold/warm editor,
  worker, bundle, and owner cleanup behavior in production artifacts
- Make sends transactional, switch and preview sessions without blocking navigation, virtualize long
  conversations, preserve reading position, and keep session actions responsive
- Rework the composer around Pi's real model, thinking, Agent, and permission capabilities; show an
  honest assistant working state and provider-reported input, output, reasoning, cache, and total token
  usage only when those fields are available
- Group conversations by product workspace while retaining explicit general chats, and let the IDE
  select nested Git repositories without creating another workspace authority
- Update the supported Pi runtime to 0.84.3, improve global runtime discovery and Windows upgrades, and
  make packaged TypeScript language services start from their real distribution assets
- Unify Piarium branding around the startup cube and refine the adaptive splash and Workbench transition
  lifecycle across desktop and Web

## 0.8.0

Piarium 0.8.0 focuses on making the existing desktop, Web, IDE, and extension experience more
reliable before broader community use.

- Make remote authentication, passkeys, mobile credentials, notification registration, and
  application settings durable under concurrent updates and partial failure
- Establish one settings, project-configuration, and theme persistence contract across hosts
- Reduce startup work by deferring optional browser capabilities until the UI can use them
- Harden trusted desktop document writes and remove obsolete compatibility and duplicate ownership
  paths left from the OpenChamber product base
- Apply Piarium's Bun patches consistently in clean installs and container builds
- Update the maintained Pi extension integrations for `pi-subagents` 0.55, Magic Context 0.39,
  `pi-web-access` 0.24, `pi-openai-codex-compat` 0.0.9, AFT 0.52, Permission System 27, and
  the maintained `pi-mcp-adapter` 2.27 fork
- Keep Magic Context's published flat configuration and new harness-scoped Pi model configuration
  visible through one version-aware editor without overwriting complex model entries

## 0.7.0

Piarium's Workbench transitions are now extension-owned visual scenes instead of fixed Core UI.

- Refine the full-screen lattice and Pi cube transition used when moving between Agent, IDE, and
  custom Workbench Profiles
- Cover the previous Workbench, commit the new Profile only while fully covered, and then reveal the
  authoritative result with the same captured scene
- Ship the default cube as an enabled-by-default Piarium extension that can be selected, disabled, or
  replaced through `workbench.transition`
- Keep complete scene ownership outside both Shells so a Shell can replace its entire interface
  without inheriting Piarium's official page structure
- Fall back to an opaque Core handoff when a selected scene is missing, malformed, disabled, withdrawn,
  or fails to mount, while preserving the previous authoritative Shell on commit failure
- Publish the Transition Scene contract, framework-neutral SDK mount helper, and React adapter in the
  coordinated `@piarium/*` public tooling release 0.2.0

## 0.6.0

Piarium's IDE Workbench release is now available as native desktop packages across Windows, macOS,
and Linux.

- Switch directly between the Agent Workspace and IDE Workbench from the application header
- Work with the multi-group editor, files, search, source control, run/debug/test, sessions, context,
  and MCP surfaces in one composable workspace
- Download native x64 and ARM64 packages for Windows and Linux, plus Intel and Apple Silicon packages
  for macOS
- Validate every release on its matching native runner, including application startup, renderer
  readiness, health checks, and a real terminal create/close cycle
- Keep separate Windows and Linux architecture channels while merging both macOS architectures into
  the standard macOS updater feed

## 0.5.0

Piarium now includes an optional IDE Workbench alongside the original Agent Workspace.

- Switch directly between Agent and IDE workbench profiles from the application header
- Edit files in a multi-group CodeMirror workbench backed by revisioned document authority
- Browse and search workspaces, use language services, and run, debug, or test projects without
  leaving Piarium
- Keep Agent conversations beside the editor with dedicated Sessions and Context views
- Inspect MCP servers from a compact IDE toolbar panel, with full configuration still available
  from Settings
- Coordinate Agent file changes with dirty editor buffers instead of silently overwriting them
- Extend workbench shells, views, editors, language services, tasks, debug adapters, and tests through
  the Piarium extension platform
- Use VS Code as a focused Piarium companion for chat, session switching, Settings, and sending files
  or selections into the active Pi session
- Faster cloud authentication startup and more reliable restoration of the selected workspace
- Windows installers for x64 and ARM64

## 0.1.0

First public source snapshot of the Pi-native workspace.

- Pi host, broker, and protocol v1 for sessions, models, packages, and extensions
- Shared UI on Web, Electron, VS Code, and Capacitor
- Maintained adapters for Pi packages such as `pi-subagents`, Magic Context,
  `pi-workspace-history`, `pi-wtf`, `pi-mcp-adapter`, and `pi-web-access`
- Cloud image and Compose path with digest-linked promotion
- Pi host loads the selected Pi installation through a bootstrap resolver instead
  of a permanently bundled SDK; cloud images still stage those packages
- Runtime Manager discovers user-global Pi installs, plans upgrade-only package
  manager or standalone installs, and never silently upgrades or downgrades Pi
- Desktop starts without a bundled Pi warmup; onboarding and Settings activate,
  install, or upgrade the user-global runtime without restarting the app; runtime
  state is published monotonically, and sessions already running stay routed to
  the Pi generation that owns them while a newly selected runtime takes over
- Slim and toolbelt container images: Compose defaults to `piarium-slim`; overlay
  `docker-compose.toolbelt.yml` for the language toolbox
- Community files and Renovate config live under `.github/`; install-time patches
  and shadcn config sit with their owners
- Safe Dependabot updates: GitHub Actions majors and `concurrently` /
  `cross-env` / `globals` dev tools
- Piarium extension platform (contract, host, surface, SDK, CLI)
- OpenChamber upstream capability absorption, including Work Status,
  walkthroughs, and Markdown task loops
- Piarium-owned Android/iOS application IDs, `piarium://` deep links, Widget/notification-service
  targets, App Group, launcher/splash assets, and external release credential boundaries

Known gaps for this release:

- npm packages under `@piarium/*` are not published yet
- optional offline installers and other desktop-platform release assets are not published yet
