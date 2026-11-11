# Changelog

All notable changes to Varin are recorded here. The project is pre-1.0; the
private runtime protocol and product surfaces still move together.

## Unreleased

## 0.9.44 - 2026-11-11

### English

**Point to the exact part, then keep talking.** Varin 0.9.44 adds precise conversation quotes and movable input markers, improves how Agents receive collaboration updates and source material, and expands file and terminal encoding support.

#### Quote what you mean

- Select text to quote that exact passage, including selections across paragraphs or messages. With no selection, quote the paragraph, list item, code block or table under the pointer. Quoting the whole reply is a separate action.
- Reference images, files, tool calls and interactive results with a fixed preview. Open the captured content or locate its original source from the conversation, including after sending the message.
- Place `[Quote 1]` and `[Image 1]` markers where they belong in your sentence. Click to preview, or hold and drag to move a marker within the input. Cut, paste, undo and redo keep markers, attachments and numbering together; removing one occurrence keeps its attachment available.
- Preserve quotes through queued messages, continued tasks and external Agent conversations. A send confirmation clears only the submitted batch, keeping references added while it was in flight. Annotated images deliver the edited pixels without also attaching an uncovered original.

#### Collaboration with less repeated context

- Deliver task completion reports through the existing message history instead of rebuilding a temporary team overview at every model request. Delivered updates keep their place as the conversation grows; waiting for or reading the same report does not add another automatic copy.
- Let Agents discover tasks through a compact directory and request an overview with recent replies, actual actions and waiting state when needed. Full history and earlier work remain available on demand.
- Use stable short references for Agents, individual executions, files, attachments and history pages. Follow-up actions stay attached to the work or file version originally selected, including across retries and restarts.
- Present tool output, background results, external events and compaction material as readable content, without duplicating their text in internal wrappers. Simplify editor context, skill listings and memory-maintenance input while preserving actual images, business data and source access.

#### File and terminal encodings

- Work with GBK, GB18030, Big5, Japanese/Korean, Windows and other supported text encodings, including a strict GB2312 option. Detection considers explicit choices, BOMs, encoding declarations and project defaults, then validates the complete byte stream.
- Editors and Agent file tools share the same native encoding implementation. Saves preserve the original encoding, BOM and line endings, including unchanged byte ranges in mixed-format files. Encoding choices follow snapshots, recovery and independent workspaces.
- Search the **Reopen with Encoding** and **Save with Encoding** menus. Characters the selected encoding cannot represent produce an error while the original file and editable draft remain intact.
- Configure persistent process input/output encodings or override them for one read or write. Improve decoding across output chunks, channel-specific EOF handling and byte-accurate replay; PTY wire encoding remains separate from project file encoding.

#### Conversation, runtime and usage fixes

- Fix image submissions rejected with HTTP 400, restore draft editing after confirmed rejection, and restore delegated tasks that opened as a blank Workbench.
- Fix Bot navigation being overwritten by an older asynchronous request and a model-selection synchronization loop. New automatically triggered rounds prepare the current tools and extensions; accepted work keeps its original configuration.
- Retain Responses cache-write token counts for usage and price estimates. Recover omitted counts from matching retained receipts while preserving the original prices and settlement times.
- Fix source-development startup so shared package exports are prepared before their consumers, and preserve the browser's original address through the Vite proxy during request validation.

#### AnySearch

- Add AnySearch to search settings and Agent-accessible connection management, with connection testing and an optional API key stored by the Host. Anonymous search is supported.
- Use it through `websearch`, with supported language and `cn` / `intl` zone preferences. Results keep their provider identity, and search excerpts remain separate from fetched page content.

Desktop release targets cover Windows x64/ARM64, Linux x64/ARM64 and macOS Apple Silicon. The signed Android APK connects to an existing Varin Host. Standard and toolbelt Docker images use the container release workflow; optional local embedding components remain separate downloads.

**Source deployments:** rebuild the application and Rust kernel together, then restart the Host. Supported conversation stores upgrade automatically on opening; keep a backup before upgrading.

[Full changelog](https://github.com/Youzini-afk/Varin/compare/v0.9.43...v0.9.44)

### 中文

**指向具体内容，再接着聊。** Varin 0.9.44 加入聊天定点引用与可移动输入标记，改善 Agent 接收协作进展和原始材料的方式，并扩展文件与终端编码支持。

#### 准确引用你想说的内容

- 选中文字即可引用准确选区，也可以跨段落、跨消息选择。没有选区时，引用右键命中的段落、列表项、代码块或表格；引用整轮回答另有明确入口。
- 图片、文件、工具调用和交互结果都可带着固定预览进入草稿。发送后仍可打开当时捕获的内容，或从引用定位原始来源。
- 将 `[引用点1]`、`[图片1]` 放在句子里合适的位置。点击打开预览，长按后可在输入框内拖动；剪切、粘贴、撤销和重做一起维护标记、附件与编号。删除正文中的一处标记后，附件仍可继续使用。
- 引用贯穿排队消息、任务续接和外部 Agent 会话。发送确认只清理本次提交的内容，保留等待期间新加入的引用。标注图片只交付编辑后的画面，不再额外附带未遮挡的原图。

#### 协作进展沿对话延续，减少重复上下文

- 任务完成报告沿现有消息历史送达，移除每次模型请求临时重建的全队概览。已送达内容保留原位置，后续对话继续追加；等待或读取同一报告时，避免再自动投递一份副本。
- Agent 可先从精简目录发现任务，再按需读取最近答复、实际动作和等待状态。完整历史与此前工作仍可继续查看。
- Agent、具体执行、文件、附件和历史续页使用稳定短引用。后续操作固定到原先选中的工作或文件版本，重试与重启后保持对应关系。
- 工具输出、后台结果、外部事件和压缩材料以可读内容提供，减少正文与内部包装重复出现；同时精简编辑器上下文、技能清单和记忆整理输入，保留实际图片、业务数据和原文读取能力。

#### 文件与终端编码

- 支持 GBK、GB18030、Big5、日文、韩文、Windows 等多种文本编码，也提供严格 GB2312 选项。自动识别结合明确选择、BOM、编码声明和项目默认值，再校验完整字节流。
- 编辑器与 Agent 文件工具共用原生编解码实现。保存时保留原编码、BOM 与换行符，也保留混合格式文件中未修改部分的原始字节；编码选择贯穿快照、恢复和独立工作区。
- 「按编码重新打开」和「以指定编码保存」支持搜索。遇到所选编码无法表示的字符时明确报错，保留原文件和可继续编辑的草稿。
- 进程可分别设置持续生效的输入、输出编码，也可在单次读写时覆盖。完善跨块解码、各通道 EOF 处理与字节准确重放；PTY 通信编码与项目文件编码分别处理。

#### 会话、运行时与用量修复

- 修复发送图片时出现的 HTTP 400，明确拒绝后恢复草稿编辑，并修复已派发任务打开后工作台空白的问题。
- 修复 Bot 导航被旧异步请求覆盖，以及模型选择同步引起的界面更新循环。自动触发的新轮次重新准备当前工具与扩展，已经受理的工作保留原配置。
- 补齐 Responses 缓存写入 Token 的采集与费用估算；从仍保留且匹配的原始回执恢复遗漏计数，保留当时价格和结算时间。
- 修复源码开发启动顺序，在消费者启动前准备共享包导出；开发代理进行请求校验时保留浏览器原始访问地址。

#### AnySearch

- 搜索设置与 Agent 连接管理工具均可添加 AnySearch，支持测试连接。API Key 保存在 Host 凭据存储中，也可留空使用匿名搜索。
- 通过 `websearch` 调用，支持接口提供的语言与 `cn` / `intl` 区域偏好。结果保留实际提供商身份，搜索摘录与后续获取的网页原文分别呈现。

桌面发布目标覆盖 Windows x64/ARM64、Linux x64/ARM64 和 macOS Apple Silicon；签名 Android APK 连接已有 Varin Host 使用。标准环境与 toolbelt 环境的 Docker 镜像由容器发布流程交付，可选本地嵌入组件继续单独下载。

**源码部署请注意：**应用与 Rust 内核需要一起重新构建，再重启 Host。受支持的会话存储会在打开时自动升级，升级前请保留备份。

[完整改动](https://github.com/Youzini-afk/Varin/compare/v0.9.43...v0.9.44)

## 0.9.42 - 2026-11-09

### English

Varin 0.9.42 improves conversation responsiveness and fixes races involving drafts, Host switching, desktop startup and background resources.

#### Conversations and responsiveness

- Reduce repeated database work when listing and searching conversations, opening deep history and loading Bot work. History pages decode the items being returned instead of expanding the entire ancestry.
- Start the first message after the conversation is created, without waiting for the full sidebar catalog to refresh. A delayed catalog response can no longer clear a newly opened conversation or overwrite a newer navigation choice.
- Reduce redundant reads when opening a conversation and loading its usage footer. Reuse unchanged Markdown parsing work for embedded interactive content during streaming.
- Avoid decoding a document's full text when file operations only need its encoding, size and revision.

#### Drafts, files and connected Hosts

- Preserve edits made while a document is reloading, saving or checking a conflict. Save receipts record the text actually written, while newer edits remain in the buffer.
- Keep concurrent reads separate when their Host, credentials or transport differ. A queued message stays with the Host where it was accepted.
- Preserve cached descendant paths when renaming a directory in an independent workspace.

#### Desktop startup and background work

- Fix desktop workspace startup after enabling a password and LAN access. The local workspace bootstrap now uses the desktop's local credential, including when another Host is selected.
- Show an error and retry action if the initial extension catalog fails to load, so the startup animation does not remain indefinitely.
- Preserve an already downloaded update across another check for the same installer, including when only the release notes or date change.
- Recreate Computer Use control and feedback windows after they close, and complete native extension cleanup through cancellation, permission revocation and shutdown.

Desktop packages cover Windows x64/ARM64, Linux x64/ARM64 and macOS Apple Silicon. The signed Android APK connects to an existing Varin Host. Docker images are published for the standard and toolbelt environments.

[Full changelog](https://github.com/Youzini-afk/Varin/compare/v0.9.41...v0.9.42)

### 中文

Varin 0.9.42 优化会话读取与响应，修复草稿编辑、切换 Host、桌面启动及后台资源生命周期中的竞态问题。

#### 会话与响应性能

- 减少会话列表、搜索、深层历史和 Bot 工作读取中的重复数据库操作。历史分页只解析返回条目的完整内容，避免展开整条历史链。
- 首条消息在会话创建后即可发送，无需等待整个侧栏目录刷新。晚到的目录响应不会再清除刚打开的会话，也不会覆盖更新的导航选择。
- 减少打开会话和读取用量页脚时的重复请求；流式输出中的交互内容复用未变化部分的 Markdown 解析结果。
- 文件操作只需要编码、大小与版本时，避免额外解码整份文档正文。

#### 草稿、文件与 Host 切换

- 文档重新加载、保存和检查冲突期间，保留用户继续输入的内容。保存回执对应实际写入的文本，新编辑继续留在缓冲区中。
- 并发读取按 Host、凭据和传输通道区分，避免错误复用响应；排队消息继续提交到受理它的原 Host。
- 修复独立工作区重命名目录后，缓存中的子文件路径丢失的问题。

#### 桌面启动与后台工作

- 修复开启密码与局域网访问后，桌面端卡在启动工作区的问题。本地工作区初始化使用桌面本地凭据，选择其他 Host 时也保持正确。
- 首次加载扩展目录失败时显示错误和重试入口，避免启动动画一直停留。
- 再次检查同一安装包的更新时保留已下载状态，更新说明或发布日期变化也不会清空下载记录。
- Computer Use 控制与反馈窗口关闭后可以重新创建；原生扩展在取消、撤销权限和关闭过程中完成资源清理。

桌面安装包覆盖 Windows x64/ARM64、Linux x64/ARM64 和 macOS Apple Silicon；签名 Android APK 连接已有的 Varin Host 使用。同时发布标准环境与 toolbelt 环境的 Docker 镜像。

[完整改动](https://github.com/Youzini-afk/Varin/compare/v0.9.41...v0.9.42)

## 0.9.41 - 2026-11-08

## English

Varin 0.9.41 adds groups and individual appearances for Bots, and fixes several problems when opening conversations and managing schedules.

### Organize and personalize your Bots

- Create, rename and reorder groups in the Bot sidebar. Move Bots with drag-and-drop, keyboard controls or the menu. Removing a group keeps its Bots, conversations and ongoing work.
- Search by Bot, group or conversation name. Search temporarily expands matching groups, then restores your collapsed sections when cleared.
- Choose an appearance for each Bot from its profile settings or right-side profile panel. Keep the original Varin colors, follow the application theme, or choose a fixed color.
- Import PNG, JPEG, WebP or GIF artwork, or a ZIP appearance pack with separate images for different states. Adjust the framing of the large figure and small avatar independently. The selection is shared across clients connected to the same Host.
- Use the selected appearance throughout the sidebar, conversation, work panel and mobile header. See the [appearance-pack format](https://github.com/Youzini-afk/Varin/blob/v0.9.41/docs/bot-appearances.md) to create your own.

### Conversation and scheduling fixes

- Fix Bot conversation navigation after an entry conversation has been deleted or replaced. Confirmed sessions open without waiting for the sidebar catalog to refresh. ([#301](https://github.com/Youzini-afk/Varin/issues/301))
- Fix the HTTP 400 when opening the Bot `@` menu with an empty search. Its hint now describes file and task references. ([#309](https://github.com/Youzini-afk/Varin/issues/309))
- Fix the HTTP 400 in **Schedule → Arrangements and follows**. Connect the missing native request routes for arrangements, event sources and related delivery operations.
- Translate the Agent calendar creation and editing interface into Chinese, including options, validation messages and accessibility labels. Changing the language preserves the current draft and the saved schedule values.

### Runtime and dependencies

- Update Electron, PDF.js, model SDKs, network/authentication libraries and frontend tooling.
- Adapt to the updated SQLite and Windows APIs, synchronize development and production dependency locks, and update the Vite/PostCSS overrides so the intended versions are actually used.

Desktop packages cover Windows x64/ARM64, Linux x64/ARM64 and macOS Apple Silicon. The signed Android APK connects to an existing Varin Host.

**Source deployments:** rebuild the application and native Rust kernel, then restart the Host. Updating only the frontend does not include the scheduling fix.

## 中文

Varin 0.9.41 加入 Bot 分组与独立形象设置，并修复打开会话、引用任务和管理日程时遇到的问题。

### 整理 Bot，也换上自己的形象

- Bot 侧栏支持新建、重命名和排序分组，可通过拖动、键盘或菜单移动 Bot。删除分组会保留其中的 Bot、会话和正在进行的工作。
- 搜索支持 Bot、分组和会话名称，搜索时临时展开匹配结果，清空后恢复原来的折叠选择。
- 在 Bot 档案设置或右侧档案页中更换形象。内置 Varin 可保持原始配色、跟随应用主题，或使用单独指定的颜色。
- 支持导入 PNG、JPEG、WebP、GIF，以及包含不同状态图片的 ZIP 形象包。大形象和小头像可以分别调整构图，同一 Host 下的客户端共享选择。
- 侧栏、聊天、工作面板和手机标题统一使用所选形象。自定义素材的制作方式见[形象包格式说明](https://github.com/Youzini-afk/Varin/blob/v0.9.41/docs/bot-appearances.md)。

### 会话与日程修复

- 修复入口会话被删除或替换后的 Bot 会话跳转。已确认的会话可以直接打开，无需等待侧栏目录刷新。([#301](https://github.com/Youzini-afk/Varin/issues/301))
- 修复 Bot 中只输入 `@` 就返回 HTTP 400 的问题，输入框提示也调整为引用文件或任务。([#309](https://github.com/Youzini-afk/Varin/issues/309))
- 修复右侧“日程 → 安排与关注”的 HTTP 400，补齐安排、事件来源及相关投递操作在内核请求入口的转发。
- Agent 日程创建和编辑界面补齐中文，包括选项、校验提示和无障碍标签。切换语言时保留当前草稿，保存的日程参数也保持正确。

### 运行时与依赖

- 更新 Electron、PDF.js、模型 SDK、网络与认证依赖，以及前端构建工具。
- 完成新版 SQLite 和 Windows API 的适配，同步开发与生产依赖锁文件，并修正 Vite、PostCSS 被旧 override 固定的问题。

桌面安装包覆盖 Windows x64/ARM64、Linux x64/ARM64 和 macOS Apple Silicon；同时提供签名 Android APK，连接已有的 Varin Host 使用。

**源码部署请注意：**需要重新构建应用及 Rust 内核，再重启 Host。只更新前端不会带上这次日程修复。

## 0.9.39 - 2026-11-07

### English

**Mark an image, then send it in the conversation.** Varin 0.9.39 adds editable image annotations, completes the plugin installation and update interface, and makes handing work to a Bot an explicit conversation action.

#### Images you can point at

- Open an attached image to add arrows, rectangles, ellipses, freehand strokes, text, numbered markers or opaque covers. Select, move, resize or delete annotations, zoom and pan, and undo or redo edits with the usual keyboard shortcuts. Each image keeps its own editing history while it remains in the draft.
- Adjust stroke color, width, outline and opacity, with a live preview. New annotations start without an outline; opaque covers remain opaque. Sending exports the annotated pixels while the original stays available for further draft edits.
- Pasting, dropping or choosing images inserts numbered references such as `[Image 1]` at the cursor. The thumbnails remain above the text. Removing an image renumbers the remaining images and their references together; removing all images starts the next one at 1.
- Image references use the theme accent and behave as whole labels when navigating or deleting text. Unsent file attachments show their name and size without download actions or a misleading preparation label.

#### Plugins in one place

- The plugin page separates **Discover** and **Installed**, with search, source information, configuration entry points and update checks. Built-in capabilities and externally installed plugins remain distinguishable.
- Browse the public registry maintained at [Astrmira/Varin-plugins](https://github.com/Astrmira/Varin-plugins). Listings and short descriptions come from the registry; releases and updates come from each plugin's saved author source.
- Preview and install releases from GitHub, npm or a local release archive, and open installation links in Varin. Review the package and requested permissions before applying an installation or update. Shared Host credential services are available to plugin integrations; each plugin owns its account configuration interface.

#### Conversation and runtime fixes

- Fix #300: model connections, web acquisition, search, image reads and explicitly selected browser previews can reach localhost, LAN and Docker-network services in all deployments. Proxy routing, explicit domain rules and request authentication remain in effect.
- Hand off work from the workbench to a chosen Bot conversation with **your own message** and a reference to the original task. The Bot can inspect the task history and continue from there.
- Move conversation-recovery controls out of Varin's message content and remove the inappropriate handoff action from Bot conversations. Restore smooth settings entrance and dismissal.
- Retain the original extension owners when continuing a Run. Restore brokered services in cloud packages and correct Web workspace defaults and Windows path handling.

#### Container deployment change

Starting with this release, **`ghcr.io/youzini-afk/varin` is the standard environment**. Deployments that rely on the extra Java, Go, Rust, LSP or browser toolchain should use **`ghcr.io/youzini-afk/varin-toolbelt`** or the toolbelt Compose overlay. Existing exact 0.9.38 image references retain their original contents. See the [deployment guide](https://github.com/Youzini-afk/Varin/blob/v0.9.39/docs/ops/cloud-deployment.md) before updating a server that follows `latest`.

Desktop release targets are Windows x64/ARM64, macOS Apple Silicon and Linux x64/ARM64, alongside a signed Android APK. Android connects to an existing Varin Host. Optional local embedding components remain separate downloads.

### 中文

**圈出图片上的问题，再接着聊。** Varin 0.9.39 加入图片标注，完善插件安装与更新界面，也让工作台任务交给 Bot 接手的操作更直接。

#### 图片可以直接标注

- 打开附件图片即可添加箭头、矩形、椭圆、自由画笔、文字、编号和不透明遮盖。支持选中、移动、缩放、删除标注，以及图片缩放、平移；撤销和重做支持常用快捷键，每张草稿图片独立保留编辑历史。
- 可调整颜色、线宽、描边和透明度，并实时预览。新标注默认不带描边，遮盖始终保持不透明。发送时导出标注后的图片，草稿中的原图仍可用于继续编辑。
- 粘贴、拖入或选择图片，会在光标位置插入 `[图片1]` 这样的编号引用，缩略图保留在文字上方。删除图片时，剩余缩略图和正文引用一起连续编号；全部删除后，新图片从 1 开始。
- 图片引用使用主题重点色，移动光标和删除时按整块处理。未发送的普通文件附件保留名称、大小等必要信息，去掉下载入口和容易误解的“待准备”字样。

#### 统一管理插件

- 插件页分为**发现**与**已安装**，提供搜索、来源信息、配置入口和更新检查，并区分内置能力与外部安装的插件。
- 公开收录来自 [Astrmira/Varin-plugins](https://github.com/Astrmira/Varin-plugins)。市场列表和简短介绍读取收录目录，版本与更新沿各插件保存的作者来源获取。
- 支持从 GitHub、npm 或本地发行包预览安装，也可通过安装链接在 Varin 中打开。安装和更新前可查看包信息及所需权限。插件集成可复用 Host 的凭据服务，具体账号配置由各插件自己的页面负责。

#### 聊天与运行时修复

- 修复 #300：各部署方式中的模型连接、网页抓取、搜索、图片读取及用户指定的网页预览统一支持本机、局域网和 Docker 内网，保留代理路由、明确配置的域名规则及请求认证。
- 工作台任务可以交给选定的 Bot 会话：**发送内容由你填写**，同时附上原任务引用，Bot 可继续读取任务记录、了解进展。
- 将会话回退的恢复入口移出 Varin 聊天正文，移除 Bot 对话中不合适的交接菜单；恢复设置页面平滑的打开和关闭动效。
- 修复 Run 接续时扩展执行归属的保留，补齐云端产物中的代理服务，并修正 Web 工作区默认值与 Windows 路径处理。

#### 容器部署变更

从本版开始，**`ghcr.io/youzini-afk/varin` 使用标准环境**。需要额外预装 Java、Go、Rust、LSP 或浏览器工具链的部署，请改用 **`ghcr.io/youzini-afk/varin-toolbelt`** 或 toolbelt Compose overlay。已发布的 0.9.38 精确镜像引用保留原有内容。跟随 `latest` 的服务器升级前请查看[部署说明](https://github.com/Youzini-afk/Varin/blob/v0.9.39/docs/ops/cloud-deployment.md)。

发布目标包含 Windows x64/ARM64、macOS Apple Silicon、Linux x64/ARM64，以及签名 Android APK。Android 连接已有的 Varin Host；可选本地嵌入组件继续单独下载。

[Full changelog / 完整改动](https://github.com/Youzini-afk/Varin/compare/v0.9.38...v0.9.39)

## 0.9.34 - 2026-10-29

### English

Varin 0.9.34 brings external agent harnesses into the workspace, introduces versioned workspaces for on-demand isolation, and improves the continuity of chat scrolling. It also addresses retrieval startup failures, pauses when opening child conversations, process-output handling, and several Office and tool-contract issues. Android joins the release build with a signed APK.

#### External agents in the Varin workspace

- Connect Codex, Claude Code, Pi, or an ACP-compatible program installed on the execution Host. Detect and enable backends in **Settings → External Agents**, then choose one when starting a conversation. Each backend keeps its own models, accounts, tools, and project configuration.
- Bind external backends to agent presets so Varin can delegate work through the existing child-task controls. Directed messages, final reports, status, waiting, cancellation, and file exchange remain attached to the original delegated task.
- Present external conversations through the shared chat layouts, thinking previews, tool disclosures, file previews, work overview, and collaboration bubbles. Reconnect conversations created in Varin without automatically replaying an input whose outcome is unknown.

#### Versioned workspaces and responsive execution

- Add versioned file trees and private file changes to the Rust Storage engine. Managed workspaces can fork from a retained version while unchanged content is shared; partial edits retain the changed ranges instead of requiring a complete file copy at every fork or flush.
- Keep delegation shared by default. Explicit `isolated_write` checks the execution Host's filesystem backend before expensive preparation and reports missing dependencies or permissions directly.
- Connect file tools, editors, terminals, recovery points, code integration, and external harnesses to the same selected source. Move file I/O and process preparation off the Storage control thread, and reclaim derived workspaces according to their actual readers, processes, and retained references.
- Stop an idle maintenance wake loop and index temporary run-grant cleanup. These fixes address accumulated bookkeeping and long interface pauses when opening child conversations. Conversation switches also cancel stale reads and show failures for the selected conversation.

#### Chat, scrolling, and model controls

- Smooth discrete mouse-wheel input across chat, settings, and work overviews. Consecutive input carries its momentum; reversing direction takes over immediately. Trackpads retain native scrolling, and scrollbar dragging follows the pointer directly.
- Make live-output following and returning to the latest reply interruptible. Long returns use a transition confined to the chat viewport. Preserve reading positions through disclosure changes, reflow, and revisiting a conversation whose task continued in the background.
- Fade the outer chat scrollbar after user inactivity, keep its thumb synchronized with content, and avoid repeatedly revealing it for background output. Show a new-reply hint while the reader stays in history.
- Add independent thinking-level controls for auxiliary models and quick retrieval. Preserve each task's selected model settings through request preparation and budgeting. Improve model-brand recognition for channel-prefixed names.
- Add an immediate-send action to queued messages, distinguish composer shortcuts with the theme accent, preserve child avatars after reopening history, and stabilize inline HTML sizing to reduce scrollbar flicker.

#### Retrieval and tool reliability

- Fix quick-retrieval startup after a model request is rebound: retain the originating run's exact child-model bindings and preserve the underlying preparation error when a request cannot start.
- Make tool discovery return concise group/search results and focused operation contracts. Continue complete entries through pagination instead of truncating a large disclosure table; discovery does not change invocation permissions or register additional model functions.
- Coordinate file leases when file writes and process launches run together. Allow independent readers to revisit retained process output, align text pages to complete characters, improve mixed UTF-8/Windows-code-page decoding, and resolve direct shell program names using the execution environment.
- Let an explicit process wait cover both exit and output finalization. Distinguish a running process, output still finishing, complete output, and an output error.
- Keep Linux commands alive when their temporary launcher thread exits. Repair isolated-source backend checks and ordinary-user Windows mounting, standard path resolution and shell execution. Release a finished Run's own workspace leases during grant retirement, and admit native workspace sources in structural code reading. Preserve directory metadata through child-file integration and undo.
- Honor the Linux FUSE connection's actual synchronization capabilities instead of waiting for callbacks that ordinary mounts do not provide. Fix shared-source settlement and immutable-result continuation, Windows mounted-directory creation, and scoped file authority during code exchange. Normalize equivalent Windows attribute/security representations while preserving their permissions, and retain the original cause when integration preparation aborts. Run file-exchange reservation queries outside the Storage control thread so mounted-path callbacks can complete. Fix file-attribute round trips when returning isolated work to ordinary Unix project directories. Normalize root metadata paths when recording captured resource coverage without broadening descendant access.
- Repair the Office/download file-lease request contract. Improve export-argument errors, script binding diagnostics after a failed cell, nested tool-validation results, and child-report byte-range errors. Improve code-unit selection feedback and import-unit extraction.
- Remove raw native file metadata from model-facing file/follow-up receipts while retaining it for recovery. Search material titles and source identifiers as well as text, balance multi-directory listings, and make detailed desktop window inventories opt-in.
- Update `ip-address` to 10.7.5 for IPv6 classification, subnet-comparison and parser fixes. Repair `deepmerge` object-prototype handling in build tooling, with behavior checks through the actual PWA consumer before excluding its patched version's advisory.

#### Android and upgrade notes

- **Android:** the release workflow now builds `Varin-0.9.34-android.apk` with a persistent release signing key and publishes its SHA-256 checksum. The app bundles the mobile interface and connects to an existing Varin Host; it does not run the Agent backend on the phone. Firebase is not configured for this release, so native push registration is unavailable.
- **Isolated workspaces:** Windows uses optional WinFsp and supports ordinary user accounts after installation. A local UNC filesystem preserves standard path resolution; workspaces share one per-user drive alias for command execution, while each source keeps its original Storage Session and lifecycle. No system-wide mount setting is changed. Linux requires an available FUSE backend; macOS can use an enabled FSKit extension on macOS 26+ or an installed compatible macFUSE backend. Ordinary project conversations and shared tasks use the original directory. A physical project's first import still requires a stable capture; managed forks reuse the captured state.
- **Private data format:** the Agent Catalog changes from format 78 to 79. Automatic migration of unsupported private stores is not provided. Incompatible stores are preserved and rejected; an installation using an older format may require a separate data directory. Keep important existing data when upgrading.
- Desktop targets remain Windows x64/ARM64, Linux x64/ARM64, and macOS Apple Silicon; macOS Intel is optional. Windows installers are unsigned, and macOS packages are unsigned/not notarized. Android APKs use their own configured signing key. npm extension-authoring packages retain their separate version stream.

---

### 中文

Varin 0.9.34 将外部 Agent Harness 接入工作区，加入按需隔离的版本化工作区，并打磨聊天滚动的连续性。同时修复快速检索启动失败、打开子会话时长时间停顿、进程输出读取，以及 Office 和工具契约中的多处问题。本版发布构建也首次加入签名 Android APK。

#### 在 Varin 中使用外部 Agent

- 接入执行 Host 上已安装的 Codex、Claude Code、Pi，以及兼容 ACP 的程序。在**设置 → 外部 Agent**中检测并启用，再在新建会话时选择后端。各后端继续使用自己的模型、账号、工具和项目配置。
- 为 Agent 预设绑定外部后端，通过已有子任务入口派发工作。定向消息、最终报告、状态查询、等待、取消和文件交换继续关联原来的派发任务。
- 外部会话复用聊天排版、思考预览、工具展开、文件预览、工作概览和协作气泡。可重连在 Varin 中建立的会话；结果尚未确认的输入不会被自动重放。

#### 版本化工作区与执行响应

- Rust Storage 引入版本化文件树和私有文件修改。受管工作区可从保留版本分叉，共享未变内容；局部编辑保留变化区间，减少分叉或刷新时重新复制完整文件的需求。
- 派发继续默认共享。显式选择 `isolated_write` 时，在昂贵的准备工作之前检查实际执行 Host 的文件系统能力，并直接返回缺少的依赖或权限。
- 文件工具、编辑器、终端、恢复点、代码整合与外部 Harness 使用同一选定来源。文件 I/O 和进程准备移出 Storage 控制线程；派生工作区按实际读者、进程与保留引用回收。
- 修复空闲维护的反复唤醒，并为临时运行授权清理加入索引，处理账本积累和打开子会话时界面长时间停顿的问题。切换会话也会取消过期读取，并为选中的会话呈现明确的加载失败。

#### 聊天、滚动与模型控制

- 聊天、设置页和工作概览中的离散鼠标滚轮输入采用连续缓动，连续输入保留速度，反向立即接管。触控板保留原生滚动，滚动条拖动直接跟随指针。
- 流式跟随和返回最新回复均可随时打断。长距离返回使用仅作用于聊天视口的过渡；展开、收起、重新换行，以及返回后台仍在执行的会话时，保留阅读位置。
- 外侧聊天滚动条在用户停留后渐隐，滑块与内容同步，后台输出不反复唤醒滚动条。阅读历史时可通过新回复提示回到最新位置。
- 为辅助模型和快速检索加入独立思考等级，选定模型参数贯穿请求准备与预算计算。完善带渠道前缀的模型名称识别。
- 排队消息增加立即发送操作，输入框快捷提示使用主题强调色；保留重新打开历史后的子 Agent 头像，并稳定内嵌 HTML 的尺寸，减少滚动条闪烁。

#### 检索与工具可靠性

- 修复模型请求重新绑定后的快速检索启动问题：保留原 Run 中准确的子任务模型绑定；无法启动时透出底层准备错误。
- 工具发现返回精简的分组、搜索候选和具体操作契约，通过分页续读完整条目，减少大型披露表被直接截断的问题。读取说明不改变调用权限，也不额外注册模型函数。
- 协调并行文件写入与进程启动的租约。不同读者可独立回读保留的进程输出，文本分页按完整字符对齐；改进 UTF-8 与 Windows 代码页混合输出，并按实际执行环境解析直接启动的 Shell 程序名。
- 显式进程等待同时覆盖退出与输出收尾，区分正在运行、输出仍在收尾、输出完整和输出错误。
- 修复 Linux 临时启动线程结束时误停命令的问题。修正隔离来源的依赖检查，支持 Windows 普通用户挂载、标准路径解析与 Shell 执行；运行授权退休时释放它自己的工作区租约，结构化代码读取接齐原生工作区来源。文件整合及撤销正确处理子文件变动带来的目录时间变化。
- Linux 按实际 FUSE 连接能力选择同步边界，避免等待普通挂载不会提供的回调。修复共享来源结算、固定成果续接、Windows 挂载目录创建及代码交换中的文件授权接线。统一语义相同的 Windows 属性与权限描述表示，保留实际权限；整合准备中止时保留原始原因。将文件交换的冲突路径查询移出 Storage 主线程，修复访问虚拟挂载时的自身等待。修正 Unix 新建文件的默认属性，避免隔离成果回传普通项目目录时因多余的 Windows 标志被误判失败。统一来源资源覆盖记录中的根路径表示，保留原有子目录读取范围。
- 修复 Office 与下载写入的文件租约请求契约。完善导出参数错误、脚本单元失败后的变量提示、嵌套工具参数校验结果和子任务报告的字节范围错误；改进完整代码单元选择反馈与 import 单元提取。
- 模型可见的文件、后续任务回执去除原始原生文件元数据，恢复所需信息继续保留。材料检索覆盖标题、来源标识与正文；平衡多目录列举，并将详细桌面窗口清单改为按需获取。
- 将 `ip-address` 更新至 10.7.5，修复 IPv6 分类、子网比较和解析问题；修复构建依赖 `deepmerge` 的对象原型处理，通过实际 PWA 消费者验证补丁后再排除对应版本告警。

#### Android 与升级说明

- **Android：**发布流程加入使用固定发布密钥签名的 `Varin-0.9.34-android.apk` 及 SHA-256 校验文件。应用包含移动界面，连接已有 Varin Host，Agent 后端仍在 Host 执行。本版尚未配置 Firebase，原生推送注册暂不可用。
- **独立工作区：**Windows 安装可选 WinFsp 后支持普通用户使用。本地 UNC 文件系统兼容标准路径解析，同一 Host 的工作区共享一个当前用户盘符供命令执行，各来源保留原 Storage Session 和独立生命周期，不修改整机挂载设置。Linux 需要可用的 FUSE 后端；macOS 可使用 macOS 26+ 上已启用的 FSKit 扩展，或已安装且兼容的 macFUSE 后端。普通项目会话与共享任务使用原目录。物理项目首次导入仍需稳定捕获，后续受管分叉复用已捕获状态。
- **私有数据格式：**Agent Catalog 从格式 78 改为 79，不提供不受支持私有存储的自动迁移。旧格式会保留原数据并明确拒绝打开；使用旧格式的安装可能需要单独的数据目录。升级时请保留重要的已有数据。
- 桌面目标仍为 Windows x64/ARM64、Linux x64/ARM64 和 macOS Apple Silicon；macOS Intel 可选。Windows 安装包未签名，macOS 产物未签名、未公证；Android APK 使用独立配置的发布签名。npm 扩展开发包继续使用独立版本序列。

[Full changelog / 完整提交记录](https://github.com/Youzini-afk/Varin/compare/v0.9.33...v0.9.34)

## 0.9.33 - 2026-10-26

### English

Varin 0.9.33 expands the shared agent harness for general, coding, research and office work, makes context preparation visible, and brings a coordinated motion system to the workbench. It also improves retrieval, collaboration and model configuration, with explicit changes for self-hosted relay users.

#### Agents, research and office work

- Add distinct General and Office modes alongside Coding and Research. New conversations default to General unless a focus is explicitly selected; existing choices remain intact. Modes determine which tools are immediately visible without imposing a separate workflow or model persona.
- Share Worker and Research Agent presets across modes, add a Research Peer, and retain the Coding verifier. Optional context inheritance gives a child the completed conversation background while preserving its own instructions, model, permissions and material access.
- Add Host-owned reading, creation and targeted editing for DOCX, XLSX and PPTX, plus format conversion, PDF export and spreadsheet recalculation when LibreOffice is available. Browser actions use the existing Electron Chromium session rather than a second browser backend.
- Show directed collaboration messages, dispatch history and child reports in the conversation and work overview. Improve image-viewing receipts, numbered image references, inline color previews and file-menu actions for opening, saving and copying files.

#### Context, retrieval and models

- Show background context preparation, a candidate ready for replacement, actual execution waits, completion and failures as distinct states. The shared context inspector exposes the active summary, preparation history, original messages, resources and controls to stop, regenerate or apply a candidate early.
- Break down persisted request content by system instructions, user and assistant messages, ordinary tools, MCP, summaries and other overhead. Keep these tokenizer-based estimates separate from provider-reported usage and cache accounting, and identify unmeasured media or opaque content.
- Add opt-in, context-aware next-step drafts. Suggestions use conversation history and tokenizer budgets, can be accepted and edited, and remain tied to the original conversation generation; failures do not block ordinary chat.
- Improve fast retrieval, captured-source access and on-demand isolated execution views. Preserve source identity, original execution lifetime, explicit cleanup and permission checks across file, process and child-task operations.
- Infer model metadata from decorated model IDs and custom channels while preserving explicit overrides and routing. Prefer matching provider/owner facts and leave ambiguous model identities unresolved. Settings search now shares the UI's translated labels and descriptions.

#### Workbench and reliability

- Repair context/resource refresh after success or conflicts, preserve frozen source/version and hidden-skill details, prevent duplicate actions, and reject stale UI completions after navigation or Host changes without losing drafts or attachments.
- Introduce shared motion preferences and coordinated transitions for streaming text and code, scrolling, tool activity, sending, sessions, workbenches, sidebars, menus, settings and themes. Mobile session swipes follow the finger; drag-and-drop and work overviews receive matching visual feedback.
- Reduce unnecessary animation and rendering work: pause hidden loops, batch splash drawing, reuse prepared workbench instances, and wait for the destination shell to paint before revealing it. Refine neutral themes, accent colors, reading styles and theme previews.
- Repair file-recovery requests across the Host/native authorization boundary, including conversation source discovery, preview, restore and undo. Preserve authored HTML background/text palettes and root styles in embedded interactive work, and soften the default light theme.
- Restore parent continuation when background retrieval completes or is stopped while its original worker is draining, without replaying the retrieval or its effects.
- Repair Windows PowerShell 5.1 terminal control sequences and close Electron windows before stopping the embedded Host. Improve media dispatch, tool diagnostics and identity-prompt ordering.
- Update vulnerable dependency paths for URI parsing, uploads, script serialization and image-size parsing, with checks through actual installed consumers. Preserve lint and security gates, native runtime acceptance and production-layout verification.

#### Upgrade and deployment notes

- **Private relay:** there is no built-in relay endpoint. Set `VARIN_RELAY_URL` on the Host to your own `ws://` or `wss://` relay, then restart it. Previously saved `privateRelay.relayUrl` values no longer select the endpoint. Without a valid environment setting, relay connections and relay pairing links are unavailable; direct connections are unaffected.
- **Office rendering:** LibreOffice must be installed on the Host for PDF export, format conversion and spreadsheet recalculation. Structural reading, file creation and supported local edits remain available without it. Desktop browser actions require an Electron Host with its browser owner.
- **Research configuration:** `research_decide` and its dedicated implementation are retired. Use the main agent, Research Peer or shared Research Agent as appropriate; existing custom agents and unrelated model bindings remain available.
- Back up important application data before upgrading. Unsupported or malformed private stores are rejected without automatic migration or replacement. This release does not import legacy runtime data.
- The standard desktop build targets Windows x64/ARM64, Linux x64/ARM64 and macOS Apple Silicon. macOS builds are unsigned and not notarized; Windows installers are unsigned when signing credentials are not configured. macOS Intel remains an optional build target. npm extension-authoring packages use their separate version stream and are not bumped to 0.9.33.

---

### 中文

Varin 0.9.33 扩展了通用、编程、科研与办公共用的 Agent 能力，呈现上下文准备与替换的实际过程，并为工作台加入统一动效。同时改进检索、协作和模型配置；自建中继用户请特别留意升级说明。

#### Agent、科研与办公

- 在 Coding 和科研之外，加入独立的通用与办公模式。未显式选择侧重的新会话默认通用，已有选择保持不变。模式决定优先披露哪些工具，不额外强加工作流程或模型人设。
- 各模式共享 Worker 与调研 Agent，新增科研搭档，并保留 Coding 的验证 Agent。可选的历史继承向子任务提供已经完成的对话背景，同时保留子任务自己的指令、模型、权限和材料访问边界。
- 在 Host 中加入 DOCX、XLSX、PPTX 的读取、创建与定向编辑；安装 LibreOffice 后可进行格式转换、PDF 导出和表格重算。浏览器操作复用 Electron 原有的 Chromium 会话，不另建浏览器后端。
- 在聊天和工作概览中呈现定向协作消息、派发历史与子任务报告。完善图片查看回执、编号图片引用、行内颜色预览，以及文件菜单中的打开、保存和复制操作。

#### 上下文、检索与模型

- 分别呈现后台上下文准备、候选等待替换、实际执行等待、完成和失败。统一上下文侧栏提供当前摘要、准备历史、原始消息与资源入口，并支持停止准备、重新生成和提前替换。
- 按系统指令、用户消息、助手消息、普通工具、MCP、摘要及其他开销拆分已持久化请求的内容。分词器估算与服务商上报用量、缓存记账分开显示，未计量的媒体和不透明内容明确标注。
- 加入可选的、理解对话背景的下一步草稿。建议按历史与分词预算生成，可采纳后继续编辑，并绑定原会话这一轮的状态；生成失败不影响正常聊天。
- 改进快速检索、固定来源访问和按需隔离执行视图。文件、进程与子任务操作继续保留来源身份、原始执行寿命、明确清理责任和权限校验。
- 为带前后缀的模型 ID 和自定义渠道推断模型元数据，保留用户显式覆盖与路由配置；优先使用匹配渠道或模型所有者的数据，不猜测有歧义的模型身份。设置搜索复用界面的多语言标题与说明。

#### 工作台与可靠性

- 修复上下文与资源刷新在成功或冲突后的同步，保留固定来源、版本和隐藏技能信息；防止重复操作，忽略导航或 Host 变化后的过期界面回调，同时保留草稿与附件。
- 加入统一动效偏好，协调流式文字与代码、滚动、工具活动、发送、会话切换、工作台、侧栏、菜单、设置和主题过渡。移动端会话滑动跟随手势，文件拖放和工作概览也获得一致的反馈。
- 减少不必要的动画和渲染：暂停不可见的循环动画，批量绘制启动画面，复用准备好的工作台实例，并等待目标界面实际绘制后再揭示。完善中性主题、强调色、阅读样式和主题预览。
- 修复 Host 与原生授权边界之间的文件恢复请求，覆盖对话来源发现、预览、恢复与撤销；嵌入交互作品保留作者成套设置的 HTML 背景、文字与根节点样式，并柔化默认浅色主题。
- 修复后台检索完成或停止时与原执行线程收尾交错、导致父任务未能继续的问题，不重放检索或已发生的效果。
- 修复 Windows PowerShell 5.1 终端控制序列；Electron 退出时先关闭窗口，再停止内嵌 Host。改进媒体派发、工具错误信息和身份提示词顺序。
- 更新 URI 解析、上传、脚本序列化与图片尺寸解析的易受攻击依赖路径，通过实际安装的消费者验证；保留 lint、安全审计、原生运行时验收与生产布局检查。

#### 升级与部署说明

- **私有中继：**不再提供内置中继地址。请在 Host 环境中将 `VARIN_RELAY_URL` 设为自己的 `ws://` 或 `wss://` 中继地址，并重启 Host。旧设置中的 `privateRelay.relayUrl` 不再决定连接地址；没有有效环境配置时，中继连接和中继配对链接不可用，直连不受影响。
- **办公渲染：**PDF 导出、格式转换与表格重算需要 Host 安装 LibreOffice；结构读取、文件创建和支持的局部编辑不依赖它。桌面浏览器操作需要具有浏览器 owner 的 Electron Host。
- **科研配置：**退役 `research_decide` 工具及其专用实现。按任务需要使用主 Agent、科研搭档或共享调研 Agent；已有自定义 Agent 和其他模型绑定继续有效。
- 升级前请备份重要应用数据。不支持或损坏的私有存储会明确拒绝打开，不自动迁移或替换；本版也不导入旧运行时数据。
- 标准桌面构建目标为 Windows x64/ARM64、Linux x64/ARM64 和 macOS Apple Silicon。macOS 产物未签名、未公证；未配置签名凭据时，Windows 安装包也不签名。macOS Intel 仍为可选构建目标。npm 扩展开发包使用独立版本序列，不随桌面版升至 0.9.33。

[Full changelog / 完整提交记录](https://github.com/Youzini-afk/Varin/compare/v0.9.32...v0.9.33)

## 0.9.32 - 2026-10-23

### 更新摘要

- 将代码检索转为原生 investigation，改进结构化源码读取与按用途呈现的资源工具，保留原始执行控制和错误诊断。
- 默认采用对话优先布局，支持折叠的实时活动、思考预览、流式文件预览与可编辑计划；统一后续任务生命周期和操作说明。
- 重整设置导航、编辑器与上下文控制，集中管理项目信任并在创建项目时复核目录。
- 恢复记忆与知识的可选本地嵌入组件，改进索引清理的协作取消、恢复与进度反馈。
- 修复 Windows 长路径升级卸载与进度展示，以及进程、发现和工具结果处理的回归。
- 修复回答或取消提问后恢复执行时误将内部回执当作外部输入拒绝的问题，保留原始提问身份与严格输入校验。
- 修复 Host 静态检查和测试替身与当前执行视图、Computer 可用性及内置语法契约不一致的问题，保留原有校验。
- 升级 Zod 以修复受限集合校验的内存耗尽漏洞，并保留 Bash 语言服务的默认值及环境配置语义。
- 升级 Electron 与请求体解析依赖；通知认证及事件流恢复标准 HTTPS 证书校验，修复 macOS 窗口按钮刷新调用的退役 API。

### Release highlights

- Move code retrieval to native investigations and improve structural source reads and purpose-specific resource tools while retaining execution controls and failure diagnostics.
- Default to a conversation-first layout with collapsible live activity, thinking and file previews, editable plans, and consistent follow-up task controls.
- Redesign settings navigation and context controls; centralize project trust and review folders during project creation.
- Restore optional local embeddings for memory and knowledge, with cooperative, resumable and observable index cleanup.
- Repair Windows long-path upgrade removal and actual progress reporting, alongside process, discovery and tool-result regressions.
- Repair continuation after answering or cancelling a question by projecting authenticated answer receipts without weakening external input validation.
- Align Host lint and test fixtures with current execution-view, Computer availability and bundled-grammar contracts without weakening validation.
- Upgrade Zod to fix memory exhaustion during bounded collection validation while preserving Bash language-server defaults and environment configuration.
- Upgrade Electron and request-body parsing dependencies; restore standard HTTPS certificate verification for notification authentication and streams, and replace the retired macOS window-button positioning API.

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

## 0.9.30 - 2026-10-19

### 更新摘要

Varin 0.9.30 将 Agent 执行切换到原生 Rust 运行时，扩展多 Agent 协作与按需工具发现，并集中改进长会话、快速检索和聊天内 HTML 的使用体验。

#### 原生运行时与上下文

- 由原生 Rust 运行时统一管理对话历史、输入队列、模型请求、工具执行和子任务，移除旧 Pi 运行时入口。完善取消、恢复和工具结果交付，修复内核故障后 Host 服务无法继续工作的问题。
- 改进首条消息的准备与持续流式输出，修复运行状态、工具回执和界面更新之间的衔接问题。
- 恢复后台上下文压缩与摘要读取能力。压缩预算跟随所选模型的上下文窗口，支持按比例配置预留空间；摘要保留近期原文，并可按需查阅历史、工具输出和任务记录。
- 新增可选的消息时间信息，默认关闭。开启后可使用设备时区或指定时区，时间随用户消息保存。

#### 多 Agent 协作

- 实现、验证和检索角色可分别启用并配置模型。主 Agent 可自主完成任务，也可安排实现与独立验证并行推进。
- Agent 支持用途名、稳定的八位短码和改名；已有 Agent 可接收新任务继续工作，历史报告按原轮次保留。
- 增加双向代码交换：Agent 可提交选定文件改动，也可从其他 Agent 拉取改动；使用三方合并协调接收方已有修改。派发或续接任务时，可选择其他 Agent 的阶段成果作为文件基础。
- 本地只读子 Agent 共享派发来源对应的实际工作区，保留不同 worktree 的目录身份，减少整目录捕获与复制。已交付的结束任务自动收纳到历史；工作概览、Agent 列表和上下文状态表同步反映当前相关任务。

#### 工具发现、输出与检索

- 常用工具直接提供，其他可用能力通过稳定索引和 `tool_describe` 按需获取说明，发现工具时保持声明列表稳定。支持直接调用已披露工具，并保留 `tool_invoke` 通用调用入口；不可用能力从模型目录中过滤。
- 通用模式将已启用的研究工具放入按需披露目录，科研模式直接提供这些工具。工具可用性与配置保持一致，修复说明显示可用、实际调用却失败的不一致。
- 长工具结果改用结构化预览，保留状态、错误、总数、游标和完整记录边界；完整输出继续保存，可按引用和位置续读。修复脚本长输出未按展示预算裁剪、异常中断后已打印内容丢失的问题。
- 快速检索在观察器或索引尚未准备完成时使用已有检索路径，减少准备过程对查询的阻塞。检索卡片持续显示阶段、耗时、候选数量和片段位置；多轮检索指令加强证据核对与结果整合。
- 修复文件列表分页与过滤、部分读取的版本标识、进程工作目录及显式路径处理等问题，减少重复核查和额外模型往返。

#### 会话与交互体验

- 长历史采用自动预取与滚动位置保持，减少向上阅读时的手动加载。导航刻度和 Token 统计以完整 Agent 轮次组织，并独立于虚拟列表的当前渲染范围。
- HTML 内容融入消息正文，支持流式预览、源码查看和内容引用。修复会话身份绑定错误造成的预览、源码空白，以及创建过程展示不完整的问题。
- 恢复顶部上下文占用、右侧上下文面板和输入框权限控制；修复运行期间工作概览无法点击的问题，文件改动汇总在 Agent 轮次结束后展示。
- 全局“新建会话”默认创建无项目聊天，项目内入口保留项目范围。新会话在首次发送前保持为本地草稿。

#### 模型与服务设置

- 重整模型服务与能力编辑，提供服务预设、设备账号登录和后台更新的服务／模型目录；支持区分展示名称与实际模型或部署 ID。
- 图像与决策协议移入对应模型设置，预设自动填入标准请求路径，输入框允许自定义。嵌入、重排和决策模型也可配置上下文窗口。
- 统一不同模型协议的工具 Schema 适配，修复无效正则导致的请求拒绝，并修正辅助模型设置中直接显示提供商内部 ID 的问题。

#### 桌面端与终端

- 修复 Windows PowerShell 7（`pwsh`）发现，自动选择优先使用 `pwsh`，随后为 Windows PowerShell 和 CMD。设置显示实际 Shell 路径并支持刷新；macOS/Linux 保留用户 Shell 偏好，登录模式可单独选择。
- UTF-8 用于 Varin 自有传输和环境探测，普通终端保留用户与外部程序的编码设置。改善启动失败后的恢复展示，修正窗口关闭按钮的右上角覆盖范围，并修复 macOS 原生助手构建与架构校验。

**升级提示：** 本版使用原生 Rust 运行时，旧 Pi 运行时的内部会话历史不会自动导入。升级前请备份应用数据，并保留需要查阅的旧版历史。

---

### Release highlights

Varin 0.9.30 moves Agent execution to its native Rust runtime, expands multi-agent collaboration and tool discovery, and improves long conversations, code retrieval and interactive HTML in chat.

#### Native runtime and context

- Use the native Rust runtime to manage conversation history, queued input, model requests, tools and child tasks, replacing the previous Pi runtime entry points. Improve cancellation, recovery and result delivery, including Host service recovery after kernel failure.
- Improve first-message preparation and continuous streaming. Repair coordination between execution state, tool receipts and UI updates.
- Restore background context compaction and summary lookups. Calculate budgets from the selected model's context window with a configurable reserve ratio; retain recent messages and let the summarizer look up history, tool output and task records when needed.
- Add optional message time information, disabled by default. Use the device timezone or a configured timezone and retain the timestamp with the user message.

#### Multi-agent collaboration

- Enable implementation, verification and retrieval roles independently and configure their models. The main Agent can work directly or run implementation and independent verification in parallel.
- Give Agents descriptive names and stable eight-character codes, rename them and continue work with an existing Agent. Preserve reports for their original execution rounds.
- Add code exchange in both directions: submit selected file changes or pull changes from another Agent, using three-way merging to reconcile existing edits. Start or continue a task from another Agent's saved stage.
- Let local read-only child Agents share the actual source workspace while preserving each worktree's directory identity, reducing full-directory capture and copying. Archive settled tasks automatically and keep the work overview, Agent list and context status table consistent with current relevant work.

#### Tool discovery, output and retrieval

- Declare common tools directly and expose other available capabilities through a stable index and on-demand `tool_describe` results. Keep tool declarations stable during discovery, support direct calls to disclosed tools and retain `tool_invoke` as a general entry point. Filter unavailable capabilities out of the model catalog.
- Make enabled research tools discoverable on demand in general mode and declare them directly in research mode. Keep availability consistent with configuration and repair cases where a tool was described as available but could not be invoked.
- Preview large results structurally, preserving status, errors, totals, cursors and complete record boundaries. Retain full output for subsequent reads by reference and position. Apply the display budget to script output and preserve printed content after interruption.
- Use available retrieval paths while watchers or indexes are still preparing. Show live stages, elapsed time, candidate counts and excerpt locations in retrieval cards. Improve the multi-step retrieval instructions for evidence checking and synthesis.
- Repair file-list pagination and filtering, version identifiers on partial reads, process working directories and explicit paths. Reduce redundant checks and extra model round trips.

#### Conversations and interactive content

- Prefetch earlier history automatically and preserve reading position. Organize navigation markers and token usage by complete Agent rounds, independently of the virtual list's rendered range.
- Integrate HTML into the message flow with streaming previews, source viewing and content references. Repair conversation identity binding that caused empty previews and source views, and improve display while content is being created.
- Restore the header context indicator, context sidebar and composer permission controls. Keep the work overview clickable during execution and show the file-change summary after the Agent round ends.
- Create projectless chats from the global New conversation action while keeping project-specific actions scoped to their project. Keep new conversations as local drafts until the first message is sent.

#### Models and service settings

- Reorganize model connections and capability editing, with service presets, device account sign-in and service/model catalogs that refresh in the background. Separate display names from actual model or deployment IDs.
- Configure image and decision protocols within each model. Presets fill in standard request paths that remain editable. Expose context-window settings for embedding, rerank and decision models as well.
- Adapt tool schemas consistently across model protocols, fix invalid regular expressions that caused request rejection, and display provider names instead of internal IDs in auxiliary model settings.

#### Desktop and terminals

- Repair PowerShell 7 (`pwsh`) discovery on Windows. Auto selection prefers `pwsh`, then Windows PowerShell and CMD. Show the resolved shell path and provide refresh in settings; retain user shell preferences on macOS/Linux and make login mode a separate option.
- Use UTF-8 for Varin-owned transport and environment probes while preserving encoding choices in ordinary terminals and external programs. Improve startup recovery, extend the close button to the window's top-right corner and fix macOS native helper builds and architecture verification.

**Upgrade note:** This release uses the native Rust runtime. Conversation history from the previous Pi runtime is not imported automatically. Back up application data before upgrading and retain any older history you need to consult.

[完整提交记录 / Full changelog](https://github.com/Youzini-afk/Varin/compare/v0.9.25...v0.9.30)

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
  paths
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
- Work Status, walkthroughs, and Markdown task loops
- Piarium-owned Android/iOS application IDs, `piarium://` deep links, Widget/notification-service
  targets, App Group, launcher/splash assets, and external release credential boundaries

Known gaps for this release:

- npm packages under `@piarium/*` are not published yet
- optional offline installers and other desktop-platform release assets are not published yet
