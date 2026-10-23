# Changelog

All notable changes to Varin are recorded here. The project is pre-1.0; the
private runtime protocol and product surfaces still move together.

## Unreleased

## 0.9.32 - 2026-10-23

### 更新摘要

- 将代码检索转为原生 investigation，改进结构化源码读取与按用途呈现的资源工具，保留原始执行控制和错误诊断。
- 默认采用对话优先布局，支持折叠的实时活动、思考预览、流式文件预览与可编辑计划；统一后续任务生命周期和操作说明。
- 重整设置导航、编辑器与上下文控制，集中管理项目信任并在创建项目时复核目录。
- 恢复记忆与知识的可选本地嵌入组件，改进索引清理的协作取消、恢复与进度反馈。
- 修复 Windows 长路径升级卸载与进度展示，以及进程、发现和工具结果处理的回归。
- 修复回答或取消提问后恢复执行时误将内部回执当作外部输入拒绝的问题，保留原始提问身份与严格输入校验。
- 修复 Host 静态检查和测试替身与当前执行视图、Computer 可用性及内置语法契约不一致的问题，保留原有校验。

### Release highlights

- Move code retrieval to native investigations and improve structural source reads and purpose-specific resource tools while retaining execution controls and failure diagnostics.
- Default to a conversation-first layout with collapsible live activity, thinking and file previews, editable plans, and consistent follow-up task controls.
- Redesign settings navigation and context controls; centralize project trust and review folders during project creation.
- Restore optional local embeddings for memory and knowledge, with cooperative, resumable and observable index cleanup.
- Repair Windows long-path upgrade removal and actual progress reporting, alongside process, discovery and tool-result regressions.
- Repair continuation after answering or cancelling a question by projecting authenticated answer receipts without weakening external input validation.
- Align Host lint and test fixtures with current execution-view, Computer availability and bundled-grammar contracts without weakening validation.

## 0.9.31 - 2026-10-22

### 更新摘要

本版重做快速代码检索，加入可配置的模型请求重试，完善上下文整理、文件恢复和多 Agent 协作界面，并集中修复索引存储、工具诊断与 Windows 安装体验。

#### 检索、模型与上下文

- 快速检索改为围绕证据进行决策：保留来源、候选与已选片段，按实际请求容量安排比较材料；避免每批重复发送整个候选目录，容量不足时给出具体计数和窗口信息。明确区分模型预览与完整检索记录。
- 在「对话默认」加入自动重试设置，支持常见瞬时失败及用户自定义匹配。重试保留原请求身份和尝试记录，停止操作可立即结束等待。
- 普通对话、规划和上下文整理保留配置的重试策略；正确识别冻结规划模型配置中的可选空值，避免误报模型选择已改变。
- 上下文整理按预算选择需要保留的对话原文，并纳入 Agents 设置。Token 计数接入模型元数据和本地 tokenizer，词表缓存支持内存释放、磁盘压缩和旧版本回收。
- 修复辅助模型标题生成的派发与中断恢复；完善决策接口错误和自定义请求路径的说明，移除改动导读模型及其入口。

#### 工具、恢复与可靠性

- 新增按会话轮次查询恢复点和恢复文件的工具，恢复侧栏提供时间线和文件预览。
- 文件读取默认按 64 KiB 分页，并允许显式扩大；符号结果默认按层展开，支持子项展开、翻页和完整树模式。目录游标绑定查询，符号引用检查查询和结果版本。
- 文件写入支持明确的创建和替换模式，保留版本冲突检查；修复 CRLF 多行编辑、缺失目录与空目录的状态区分等问题。
- 模型可停止后台进程；工具参数错误保留字段与原因，子任务失败携带原始运行错误和事件引用。改进 MCP 错误分类、子任务准备过程和上下文准备失败诊断。
- 修复只读检索预设误带恢复工具导致准备失败，以及子任务完成或恢复后父任务偶尔停在“可运行”状态的问题；旧执行线程退出后重新通知继续执行，保留收尾期间的防重入检查。
- Linux 目录监听的同步检查支持完整长度的文件名和系统调用中断重试，失败信息保留具体目录和系统原因。
- HTTP 关闭和进程信号接入完整 Host 资源清理并合并并发关闭；内核断连后的清理不再因诊断管道关闭而中断。
- Host 关闭某项资源失败后继续等待其他资源收尾，避免语义索引异常跳过知识库关闭；保留检查点与退出时的原始存储错误。

#### 会话与桌面体验

- 重整工作概览与子任务侧栏，加入协作消息和文件交流展示；精简操作并提供任务右键菜单，悬浮概览为聊天内容预留空间。
- 共享 Agent 头像库扩充到 64 种，头像随任务身份保留；修复侧栏会话重命名的焦点问题。
- 用量改为一行展示输入、输出及有记录的缓存读取和创建，修复模型渠道归属；重新设计 MCP 摘要，并显示脚本意图和内部工具调用详情。
- 跟随 Agent 输出时保留底部阅读空间，本轮操作按钮在输出完成后显示；修复 Computer Use 深色主题遮罩，清理旧开发服务器预览入口。
- Windows 安装和卸载改用 Varin 产品界面，修复选择目录后的白边、盘符根目录解析、首次安装路径、卸载完成状态和任务栏产品名称。

#### 索引、存储与安全

- 嵌入文本和批次按模型上下文容量拆分并预留余量，修复 Unicode 分段边界；内核丢失后重新获取 tokenizer 租约，缓存文件被手动删除后允许恢复索引清理。
- 回收索引旧发布副本及已删除会话的正文和相关资源，减少持续累积的磁盘占用。
- 目录索引清理按阶段显示实际进度，分批删除代码图并按 ID 倒序回收，避免逐文件往返和原生索引反复搬移；中断后继续回收残留记录，压实完成后不再重复写出整库快照。
- 索引重新打开时保留尚未发布的推理回执，已发布向量对应的重复账本内容仍正常回收。
- 升级 TriviumDB 至 0.8.10，接入保存中断后的原生恢复机制，同步云端锁文件和 Windows ARM64 构建、加载适配；索引清理避免重复执行完整检查点。
- 更新 Wasmtime 至 48.0.7、rustls-webpki 至 0.103.16、webpki-roots 至 1.0.10，修复新披露的 Wasm 执行和证书信任问题。参见 [Wasmtime](https://github.com/bytecodealliance/wasmtime/releases/tag/v48.0.7)、[webpki](https://rustsec.org/advisories/RUSTSEC-2026-0382.html) 和 [根证书公告](https://rustsec.org/advisories/RUSTSEC-2026-0381.html)。

---

### Release highlights

Varin 0.9.31 redesigns fast code retrieval, adds configurable model-request retries, and improves context organization, recovery, Agent collaboration and Windows setup.

#### Retrieval, models and context

- Make fast retrieval evidence-driven. Keep sources, candidates and selected excerpts while arranging comparisons within the actual request capacity, avoiding repeated full candidate catalogs. Report token counts and window details on capacity failure, and distinguish the model preview from the complete retained result.
- Add automatic retry settings under Conversation defaults, including custom error matches. Preserve request identity and attempt records; stopping interrupts retry waits immediately.
- Preserve configured retries through conversation, planning and context-summary wrappers. Normalize optional null fields when restoring frozen planning configurations instead of rejecting an unchanged model selection.
- Let context organization select original conversation material within its budget and configure it in Agents settings. Resolve local tokenizers from model metadata, release vocabulary memory, compress disk caches and reclaim old versions.
- Repair auxiliary-model title dispatch and interrupted work. Clarify decision endpoint errors and custom paths, and remove the change-walkthrough model and interface.

#### Tools and recovery

- Add tools to find recovery points by conversation round and restore files, with a timeline and inline file previews in the recovery sidebar.
- Page file reads at 64 KiB by default with an explicit larger-read option. Return symbol outlines with expansion, pagination and full-tree mode. Bind directory cursors to their query and reject stale symbol references.
- Add explicit create/replace file-write modes while preserving version conflict protection. Repair CRLF edits and distinguish missing directories from empty ones.
- Expose process stopping to models. Preserve argument fields and validation reasons, and include original runtime failures and event references in child reports. Improve MCP error classification and preparation diagnostics.
- Continue ordered Host teardown after individual cleanup failures so a failed semantic index cannot skip closing knowledge stores. Preserve original checkpoint and shutdown storage errors.
- Keep physical recovery tools out of the default read-only retrieval profile. Notify continuation consumers again after the original worker has exited so an early ready event cannot strand a runnable parent. Retain the drain fence against duplicate execution.
- Handle full-length filenames and interrupted system calls in Linux directory synchronization, preserving the directory and original system error on failure.
- Route HTTP and signal shutdown through complete Host resource cleanup and coalesce concurrent stops. Keep kernel disconnect cleanup independent of a closed diagnostic pipe.

#### Conversations and desktop

- Redesign the work overview and task sidebar around progress, collaboration messages and file exchange. Add contextual task actions and reserve chat space for the compact floating overview.
- Expand the shared, persistent Agent avatar library to 64 characters and repair sidebar conversation renaming.
- Show usage in one row, including cache reads and creation when recorded; retain channel attribution. Redesign MCP summaries and expose script intent and nested tool details.
- Leave reading space beneath streaming output and show round actions after completion. Repair the Computer Use dark-theme overlay and remove the retired development-server preview.
- Introduce branded Windows installation and uninstall pages. Repair folder-selection borders, drive-root paths, first-install directory resolution, uninstall completion and taskbar identity.

#### Indexing, storage and security

- Split embedding inputs and batches using the configured model capacity with reserved space. Preserve Unicode boundaries, renew tokenizer leases after kernel loss, and recover cleanup when cache files disappear.
- Reclaim retired index publications and deleted-conversation content and resources.
- Report directory-cleanup phases and actual counts. Remove graph rows cooperatively in descending ID order to avoid per-file round trips and repeated native posting-list shifts, resume orphan cleanup after interruption, and acknowledge compaction without another full snapshot.
- Preserve unpublished inference receipts when reopening indexes while reclaiming duplicate ledger content after vector publication.
- Upgrade TriviumDB to 0.8.10 for interrupted-checkpoint recovery. Synchronize the cloud lockfile and Windows ARM64 build/loader, and avoid duplicate full checkpoints during index cleanup.
- Update Wasmtime to 48.0.7, rustls-webpki to 0.103.16 and webpki-roots to 1.0.10 for upstream Wasm execution and certificate-trust security fixes.

[完整提交记录 / Full changelog](https://github.com/Youzini-afk/Varin/compare/v0.9.30...v0.9.31)

## 0.9.25 - 2026-10-09

### 更新摘要

本版改进工具并发、子任务启动和 Windows Computer Use，修复会话标题、记忆删除与工作概览刷新，完善原生 MCP 设置。

#### 工具与子任务

- 调整只读工具的调度，减少长检索对同批其他工具的阻塞；请求取消贯穿后台准备和文件盘点。
- LSP 按工作区预热，隔离代码视图各自准备。修复 Worker 启动时目录准备依赖尚未登记的会话，导致子任务启动失败的问题。
- 文件监听按实际内容修订核对语言视图，避免延迟事件清除已经更新的诊断；语言扩展激活失败保留明确的失败状态。
- 修复首次语义索引构建失败被显示为空结果的问题。
- Windows 文件工具识别 MSYS 盘符路径和临时目录路径；批量编辑对照原文匹配并检测重叠，编辑失败只显示一次错误。
- Todo 使用明确的进度状态并简化输入；文档多页读取、隐藏文件检索及 Shell 输出标记处理得到修正。
- 修复已结束子任务的待输入状态及过期接续任务控件，减少已结束队友和重复消息对上下文的干扰。

#### Computer Use

- Windows 输入接入原生控制器，改进窗口激活、输入取消和焦点恢复，并修复鼠标输入参数类型错误。
- 区分取消电脑作业、人工接管与交还。取消通知 Agent 并清理作业展示；同一桌面的子任务操作由主任务协调。
- 未派发输入的动作拒绝按拒绝结果记录，取消后重新观察现场再开始新作业。
- 完善鼠标移动、点击和键盘输入反馈，以及工作概览中的电脑作业状态。
- 修复 `computer.run` 的异步脚本执行；观察文本支持截断和续读，截图改为按需请求。

#### 会话、记忆与设置

- 修复配置了小模型后仍不生成会话标题的问题；侧栏新增会话右键菜单。
- 工作概览随已提交的会话状态刷新 Todo、子任务和其他工作项，重连后恢复未回答的问题卡片。
- 修复打包版记忆删除请求解析；记忆提示词使用稳定快照，新增内容先通过工具回执提供，在上下文压缩时更新记忆块。
- 精简工具结果、失败提示和代码检索说明，把模型用途集中展示在代码检索设置中。
- 原生 MCP 设置接管配置来源、服务器和工具管理，移除基础集成中的旧适配器管理入口。
- 调整输入框为凸起表面与柔和焦点光晕，移除 Agent 生成期间的流光效果；完善会话导航和 Agent/IDE 切换。
- 更新 Pi、Electron、PDF、Canvas 等依赖，并适配相关运行时契约。

---

### Release highlights

Varin 0.9.25 improves concurrent tools, child-task startup, Windows Computer Use, conversation updates and native MCP settings.

#### Tools and child tasks

- Adjust read-tool scheduling so long retrieval calls do not unnecessarily hold up other tools in the batch. Propagate cancellation through preparation and file inventory.
- Prewarm workspace language services and prepare isolated code views separately. Fix Worker startup materialization looking up a session before its running-state binding exists.
- Compare watched disk content with the current language binding so delayed events do not clear fresh diagnostics. Preserve explicit language-extension activation failures.
- Report an initial semantic-index build failure instead of an empty result.
- Recognize MSYS drive and temporary paths in Windows file tools. Match batch edits against original content, reject overlaps and display edit failures once.
- Clarify Todo progress states and simplify plan input. Repair multi-page document input, hidden-file search and Shell output framing.
- Refresh finished-task attention and expired continuation controls; reduce repeated settled-teammate and message material.

#### Computer Use

- Use native Windows input control with improved activation, cancellation and focus restoration. Fix the mouse-input parameter type.
- Separate work cancellation, explicit user takeover and return of control. Notify the Agent when work is cancelled and clear its display; coordinate child-task access to each desktop.
- Record rejected input as rejected when nothing was dispatched; re-observe after cancellation before starting fresh work.
- Improve pointer, click and keyboard feedback and computer-work status in the work overview.
- Repair asynchronous `computer.run` scripts. Page observation text and request screenshots explicitly.

#### Conversations, memory and settings

- Generate conversation titles with the configured small model and add contextual menus to the sidebar.
- Refresh the work overview from committed conversation state and restore unanswered question cards after reconnect.
- Repair packaged memory-deletion requests. Keep a stable memory prompt snapshot, return new notes in tool receipts and refresh the memory block at compaction.
- Shorten tool results, failure guidance and retrieval wording; explain retrieval model use in its settings panel.
- Complete native MCP configuration-source, server and tool settings and retire foundational adapter management.
- Refine the elevated composer and diffuse focus halo, remove generation glow sweeps and improve conversation navigation and Agent/IDE transitions.
- Update Pi, Electron, PDF, Canvas and related runtime dependencies.

[完整提交记录 / Full changelog](https://github.com/Youzini-afk/Varin/compare/v0.9.24...v0.9.25)

## 0.9.24 - 2026-10-06

### 更新摘要

本版完善多 Agent 协作和用户提问，调整子线程、任务概览与用量展示，并减少索引的重复维护。

#### 多 Agent 协作与提问

- 常规子 Agent 收敛为 Worker 和检索两类，保留用户自定义配置及科研能力。主 Agent 负责整体设计、
  关键实现、协调与最终整合；协作提示词按实际启用的角色和工具生成，不再在关闭角色后继续推荐它。
- 同一任务的主线、同级和后代可按范围读取彼此会话，通过消息协调接口与依赖。
  事件等待支持显式期限或不限时等待，普通主会话也可持久等待并在条件满足后接续。
- 新增 `submit_code`，向可写成员或主线提交选定文件或精确代码片段，使用原生三方整合保留双方的其他修改。
  待应用、已应用、冲突及失败分别呈现，重复提交和重启对账沿用原操作身份；修复其工具摘要缺失。
- 提问默认立即返回，Agent 可继续不依赖回答的工作；也可设置最长 600 秒的等待。
  未回答和超时都不会被当成选择或授权，稍后回复送回原会话或原子线程。
- 提问改为底部小卡片，默认停留 60 秒，显式等待时使用等待期限。关闭卡片保留草稿和问题；
  工作概览显示未回答项，可重新打开或明确结束问题。重复回复不重复启动执行。
- 修复首次打开会话时读取未绑定 Pi 会话，导致输入框显示 `No Pi session is open` 的问题。
- 修复设置部署目录边界时，私有源快照目录被误当成用户工作区，导致 Web 与容器启动中断的问题。

#### 会话与设置

- 子线程在侧栏显示于主会话下方，提供树状连接；搜索可展开匹配的后代，不再把子会话散放到“最近”。
- 精简子任务卡片，按需收起已结束任务；点击任务打开会话面板，支持跳转到子会话和主会话。
  子任务侧栏提供搜索和状态筛选，压缩历史使用更明确的名称。
- 工作概览默认展开除“来源”外的各节，并按会话记住面板开关和用户的展开选择。
- 用量改为本会话按提供商和模型汇总的 Token 消耗，包括输入、输出、缓存读取与缓存写入。
  移除原提供商额度设置、查询轮询和托盘额度汇总。
- 调整 Agent Harness 设置顺序，将页面命名为“上下文管理”和“Computer Use”，
  文件编辑器及会话选项显示本地化标签，不再直接显示内部枚举值。
- 移除 Fleet 设置页及其插件聚合桥接、代码片段功能及资源库分类；任务和后台命令仍通过现有会话界面查看。
- 工作区历史只展示有实际记录的条目，共享存储大小单独汇总；清理显示真实回收字节和失败原因，
  隐藏后端未支持的历史删除与保留策略入口。

#### 索引与性能

- 文件监听恢复采用增量核对，稳定目录跳过嵌入模型准备和索引检查点写入，
  进度区分索引构建与代码关系维护。
- 默认本地嵌入组件改用多语言 Bekko a8m（384 维），支持配置组件和自适应 CPU 调度。
  原生编码及分词移到独立 Worker，后台批次之间让出执行机会，长生成行减少重复分词探测。
- 同一起点的隔离 Worker 在原始内容身份一致且原生根仍有效时复用基线，
  内容变化时重新捕获，避免反复建立相同的工作起点。

#### 工程与安全

- Bot PR 的 CI、Docker 验证和依赖报告共用后台队列，减少批量更新对主线与发布构建的资源争抢。
- 更新受影响的 Git、HTTP 压缩、代理地址及源码映射依赖，统一移动端 Capacitor 运行库。
  为尚无上游修复版的 `sprintf-js` 应用并验证精度处理补丁；合并和变基仍无需打开编辑器。

---

### Release highlights

Varin 0.9.24 improves Agent collaboration, user questions, conversation navigation and index maintenance.

#### Collaboration and user input

- Consolidate ordinary subagents into Worker and retrieval profiles while retaining custom profiles and
  research capabilities. The main Agent owns overall design, important implementation and integration;
  generated guidance follows the enabled profiles and actual tools.
- Read related main, sibling and descendant conversations by range, coordinate through messages and wait
  on events with an optional deadline. Ordinary main conversations retain their waits for continuation.
- Submit selected file changes or exact snippets with `submit_code`. Native three-way integration keeps
  unrelated edits; application, conflict and failure receipts distinguish acceptance from completion.
  Replays and restart reconciliation keep the original operation identity. Fix its missing tool summary.
- Submit questions without waiting by default, or wait up to 600 seconds. Missing answers are never
  choices or approvals; later replies reach the original conversation or child thread.
- Replace blocking question dialogs with a bottom card. It stays for 60 seconds unless an explicit wait
  supplies the deadline. Hiding preserves drafts; work overview retains unanswered questions for reopening
  or cancellation. Duplicate replies do not start duplicate execution.
- Fix first-session initialization reporting `No Pi session is open` before native session binding.
- Keep private source-view storage separate from user workspace recovery so deployment directory
  boundaries do not reject Web/container startup.

#### Conversations and settings

- Nest child conversations beneath their parents in the sidebar, with tree connectors and descendant search.
  Simplify subtask cards, compact finished work and open conversation panels with parent/child navigation.
- Expand work-overview sections except Sources by default and remember the panel and section choices per conversation.
- Replace provider quota tracking with current-conversation Token totals by provider/model, including input,
  output, cache reads and cache writes; remove quota polling, settings and tray summaries.
- Reorder Harness settings, clarify Context Management and Computer Use, and localize editor/session option labels.
- Remove Fleet settings and its aggregation bridges, along with reusable text snippets and the Library category.
  Show shared recovery storage once, omit empty histories and report actual cleanup outcomes.

#### Indexing and performance

- Reconcile watcher recovery incrementally; unchanged inventories skip model preparation and checkpoints.
  Distinguish index construction from code-relation maintenance in progress.
- Default local embeddings to multilingual Bekko a8m (384 dimensions), with configurable components and adaptive
  CPU scheduling. Run native encoding/tokenization in a separate Worker and yield between background batches.
- Reduce repeated tokenization probes for generated long lines and reuse verified native work baselines when
  source identities match. Changed contents still require a new capture.

#### Engineering and security

- Queue Bot PR CI, Docker verification and dependency reports in one background slot to reduce runner contention.
- Update affected Git, HTTP compression, proxy-address and source-map dependencies, and align mobile Capacitor runtimes.
  Apply and verify the local `sprintf-js` precision repair pending an upstream fix; merge/rebase continuation remains noninteractive.

[完整提交记录 / Full changelog](https://github.com/Youzini-afk/Varin/compare/v0.9.23...v0.9.24)

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
