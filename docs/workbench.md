# 工作台、文档与呈现

Varin 的工作台是在共享状态之上的可替换界面。本文说明更换 Shell、编辑器或交互设计时仍须保留的职责边界。
具体类型、行为和失败结果以当前代码及定向测试为准；局部实现入口见 [UI 模块导航](../packages/ui/DOCUMENTATION.md)。
进程关系见[架构](architecture.md)，文件与执行资源见[资源](resources.md)，扩展生命周期见[扩展](extensions.md)，
聊天内的 HTML 作品、画面读取和引用见[交互内容](interactive-content.md)。

## 职责划分

| Owner | 职责 |
| --- | --- |
| Application Host | 工作区准入、磁盘文档、watch、恢复 journal、Profile、扩展目录及特权服务 |
| `@varin/application-client` | 与框架无关的 `RuntimeAPIs`、DTO 和类型化失败 |
| Document Registry | 实时 buffer、base/local revision、dirty/save/conflict 和草稿恢复 |
| Editor Workbench Kernel | 编辑组、tab、provider 选择、view identity、命令和恢复快照 |
| 编辑器 adapter | 引擎 model 投影、视图状态、渲染和语言结果投影 |
| Shell contribution | 布局、呈现和自身短期交互状态 |
| Runtime / 领域 owner | 对话、执行、终端、Git、语言、调试、测试和资源事实 |

Electron 在进程内承载同一套 Web Application Host；移动端连接 Varin server。
它们不另建文件系统或语言进程后端，renderer 也不能通过更换 Shell 或编辑器取得额外权限。

<a id="profiles-and-shell-switching"></a>
## Profile 与 Shell 切换

官方 Profile 的稳定 ID 是 Agent Workspace 的 `default`、IDE 的 `varin.ide`、科研的
`varin.research` 和 Bot 的 `varin.bot`。它们由普通内置扩展提供，可以停用或替换。
固定 Recovery Shell 在选中 Shell 无法运行时提供修复入口，不承担另一套日常工作区。

工作台选择属于 user/application，按用户选择、active profile 依次解析。工作区可以保存布局，
项目或会话导航不会自动选择另一 Shell。工作侧重、模型、权限和已受理 Run 的配置是独立执行事实：
打开科研工作台不派发研究任务，切回 IDE 也不重配 Agent。

模式选择器在进入 IDE 或 Bot 前按 Host 记住普通工作台，作为返回偏好，不另建当前 Profile 权威。
Bot 会话归属继续独立于普通会话导航。

Profile 的 `extensionIds` 是显式扩展集模板；编辑或选择 Profile 不会自动应用整套启停状态，
“Apply set”使用独立的 catalog mutation。当前模式选择器使用“启用并切换”路径时，可以先启用目标
Shell 扩展；Profile 提交失败则回退该次启用。未指定此选项的调用收到 disabled-shell 结果。

[WorkbenchProfileStore](../packages/extension-host/src/workbench-profile-store.ts) 通过 revisioned
extension storage 保存 Profile。读取失败或数据损坏时保留上次有效状态和诊断，不用默认值覆盖原文档。
暂时缺失的 contribution reference 留在布局中，重新启用后可以恢复用户选择。

[Shell 切换事务](../packages/ui/src/lib/extensions/workbench-shell-transition.ts) 捕获 Host、catalog
generation 和 Profile revision，激活候选并验证 mount/render ready，之后才写入选择。
revision 冲突、候选失败或 Host 改变时，旧选择保持权威；成功和失败都释放 staging。
启动时选中 Shell 失败，则显示 Recovery 与诊断，不伪造已经切回默认工作台。

<a id="visual-handoff"></a>
### 视觉交接

`workbench.transition` 在 Shell 外选择 `transition-scene` contribution。
[过渡控制器](../packages/ui/src/lib/workbench/profile-transition.ts) 拥有 transition identity 与
cover/covered/reveal 阶段；scene 拥有画面和声明的时长。Shell 与 scene 可并行准备，选择只在完全覆盖后
提交；揭示新界面还要等目标实际 mount 并跨过浏览器绘制边界。迟到的阶段或 mount 信号不能推进另一事务。

scene 缺失、停用、失败或被撤回时使用 Core 不透明 fallback。事务捕获的 scene owner 保持到交接结束，
不会在 Profile 提交后中途重挂载。清理先保留终帧跨过 paint，再移除 canvas 和资源；减少动态效果偏好
传给 scene。公开合同不要求存在会话列表、页头或其他官方 Shell DOM 元素。

当前启动 splash 是产品实现。扩展派生的 pre-React bootstrap projection 和通用 shared-element/Motion
service 尚不是已实现的公共能力，不能从现有 Profile 动画推断这些接口已经存在。

## 唯一文本内容路径

`DocumentsAPI` 是文本读取和写入入口；`FilesAPI` 保留浏览、二进制与 CRUD，`WorkspaceAPI` 保留
项目、目录树、Git 和上传。它们不拥有第二套编辑 buffer 或文本保存路径。
[Host Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md) 管理准入、revision、
watch、journal 和认证后的 Surface 操作；生产磁盘变更使用绑定的 Rust file-resource owner，
没有 TypeScript 备用 writer。

Workspace ID 属于 Application Host。资源使用 workspace/resource identity，显示路径不是权限。
物理操作重新校验根身份和路径包含关系；离线或已删除目录保留注册，访问时报告 unavailable，
加载注册表不会逐个打开所有目录。另一 Host 上相同的路径不是同一资源。

同一客户端可依据 Host 的 coordination identity，让经过验证的父项目/嵌套项目别名共用一个文档。
不能凭字符串推断别名。不同窗口各有 buffer，通过磁盘 revision/watch 发现冲突，不暗中协同编辑。
Connection generation 用于拒绝迟到结果，不进入持久文件身份。

读取区分有效空文本、missing、binary、unsupported encoding 和 failure。Revision 是 opaque 值。
写入捕获 `expectedRevision` 和 operation ID，创建缺失文件是显式操作；move/delete 沿用同一校验。
冲突不能自动重试为无条件覆盖，普通文件系统的原子替换也不等于跨进程事务。

编辑 buffer 规范化为 LF，文档仍保留 encoding、BOM 和原换行格式，保存及固定输入 capture 据此还原字节。
不能可靠解码的文件返回明确结果，不以 replacement character 猜出可供保存的文本。

Watch 只携带元数据，source/generation/sequence 限定事件顺序。Reset、重连、overflow 或覆盖丢失
要求重新读取权威状态；不完整事件流中没有某文件不代表文件已删除。文件系统通知只使旧知识失效，
并不建立内容 revision。具体 OS 观察保证留在 Host 模块文档中。

## Buffer、保存与恢复

[Document Registry](../packages/ui/src/lib/documents/DOCUMENTATION.md) 是按文档订阅的 external store。
高频正文不进入 broad Zustand state 或 Local Storage。并发首次打开共用一个 Host read，
文档变更只通知相关订阅者，而不是让整个工作台更新。

Record 保留 base content/revision、当前 buffer、local edit revision、save identity、conflict candidate
及 recovery revision。所有编辑器共用以下竞态语义：

- 迟到 load 不覆盖新输入、另一 connection 或重新打开后的 document instance。
- Save 捕获正文和 local revision；保存期间继续输入，旧 save 成功后仍保持 dirty。
- Clean 文档遇外部变化可 reload；dirty 内容不同时保留 ancestor、buffer 和 disk candidate。
- Read failure 不清空 buffer/dirty；delete/move 不静默丢弃草稿。
- 增量编辑先校验捕获 revision 和互不重叠的 offset，再一次性更新状态。
- Shell、Profile、Settings 重挂载保留 record；endpoint 更换则隔离旧操作。

`prepareWorkspaceEdit` 保留文本、创建、重命名和删除的原始顺序，在内存中推演路径、覆盖选项、
中间文档版本与 change annotations；准备不写文件、不保存草稿。纯文本批次重新验证所有目标后，
先发布全部新 buffer 再通知监听器。含资源操作的批次由 Host Documents 在原租约、受影响缓冲 barrier
和 mutation writer 下执行，首次修改前将计划、磁盘原态与各实际窗口草稿写入 Rust Recovery。
创建后的文本仍未保存；重命名迁移 document instance、订阅、标签页与语言服务身份；删除草稿先审阅，
并保留恢复内容。多个窗口可以各自持有受影响文档，只有同一路径正文/版本分歧的文本修改需要解决冲突。

每批只有一个异步撤销入口，条件恢复避免覆盖后续输入或外部修改；无法确定的结果按文件进入恢复界面。
LSP 使用 `undo` failureHandling，不承诺文件系统与编辑器的绝对原子事务。丢失响应只查询原操作，
不会重新执行。code action 在编辑及后续 command 之间保留原语言 provider 身份；改名使用原实例的新路径，
删除后 workspace command 不伪造仍存在的文档版本。普通重构无需 Agent Run。

恢复 journal 位于 Host 的 document-recovery namespace，绑定 workspace、用户/recovery session 和资源。
它是带 revision 的未保存数据，不进入普通日志或对话历史。Restore 产生待审阅草稿，不覆盖项目文件；
旧 workspace epoch 和互相冲突的别名草稿保留区别。Save/discard 和 owner teardown 协调 journal 清理，
不以任意天数、数量或字节上限代替恢复语义。

### Agent 与编辑器协作

Selection、file、diff 和 diagnostic attachment 捕获真实 runtime/session/resource revision；
未保存正文作为显式输入快照。[Agent/editor bridge](../packages/ui/src/lib/agent-editor/DOCUMENTATION.md)
从可见 view owner 取得上下文，隐藏或已销毁的 view 不能成为兜底目标。

固定草稿来源与 Host-directed apply/undo 保留原 Registry owner、document instance、content hash、
base/local revision 和格式。Host 管理 dispatch 与 receipt，Registry 应用核验后的操作，不另开保存路径。
响应丢失保留 uncertain；已确认变更及条件补偿不能擦掉用户的后续编辑。

Agent patch review 使用同一 workspace-edit 事务，接受后仍是待显式保存的 dirty buffer。
磁盘操作走原 Host/Rust authority；来源不可用或过期时，不回退为 worker-local 写盘。
外部程序写入仍走普通 watch/conflict。Workspace recovery 自己拥有 affected-file log 和 restore，
编辑器不复制这份恢复状态。

## 编辑器 model 与 view

[Editor Workbench Kernel](../packages/ui/src/lib/workbench/editors/DOCUMENTATION.md) 拥有 split group、
preview/pinned tab、active editor、provider 和 workspace restore snapshot。Shell layout 与 editor state
分开：Agent 可以把编辑器放在聊天旁边，IDE 放在中央；关闭或隐藏面板不等于销毁共享文档或终端。

Desktop/Web 的 Agent 与 IDE 共用延迟加载的 [Monaco adapter](../packages/ui/src/lib/monaco/DOCUMENTATION.md)。
一个 document instance 投影为一个使用 opaque runtime/document URI 的 Monaco model，多 view 共享正文与
undo，分别保留 cursor/scroll/fold。Rename 保留 instance；tab/resource owner 在 Shell 重挂载期间保留
model，view 只拥有 DOM、observer、listener 和可见语言订阅。Model 从不成为 dirty/conflict/save 权威。

Mobile 与小型嵌入编辑器使用各自用途的 [CodeMirror adapter](../packages/ui/src/lib/codemirror/DOCUMENTATION.md)。
移动文件编辑保留同一文档语义；prompt/settings 编辑器不进入 workspace tab，也不启动文件语言服务。
Desktop Monaco 失败在局部保留 retry/recovery，移动 CodeMirror 不是自动桌面 fallback。

Monaco 只在可见文件编辑路径加载，worker 只负责编辑任务，内置 semantic worker 不复制 Host LSP。
语言请求和诊断携带真实 document/provider generation。Search、LSP、DAP、test 进程仍由 Host 管理，
renderer 不能启动不可信项目命令；provider 失败不使底层 buffer 消失。

Provider 解析使用已启用声明、显式 association、filename/language 匹配和 priority，再使用 text fallback。
同级匹配保留 ambiguous。显式 pinned provider，例如 browser 和 Git diff，不变成资源默认；
停用 pinned provider 返回 unavailable。Git diff 的工作区侧绑定 live buffer，staged/original 侧是不可变
快照；stage/unstage/discard 不与 dirty buffer 抢写。

Theme token、command ID、shortcut override 和有效编辑器设置仍由 Varin 管理。
Profile preset 只调整呈现选项。可选 `varin.editor.monaco` service 暴露 owner-scoped、可序列化的
action/decoration，不暴露可 dispose 的 raw handle，也不授予文件权限。第三方 `editor` contribution
仍可选用其他引擎。

## 对话连续性

Thread 界面通过 `ThreadsAPI` 与 `ThreadProjection` 读取原生 Catalog 的快照、持久历史和临时进度，
不维护第二份执行状态。客户端用 Host、Thread 和 branch 身份隔离草稿，切换后迟到的响应不能写入新视图。

发送保存原 request key、正文、图片、PDF snapshot 和选定配置。明确未受理时可以恢复修改；受理结果未知时保留冻结输入，
重试使用原 key 并核对回执，不重新上传 PDF，也不自动生成另一个输入。成功晚回执只清理原草稿中已受理的内容。
已受理队列沿自身 revision 编辑、取消或交付，不靠清空重建模拟变更。

输入框复用 CodeMirror、模型选择器、语音和附件组件；文件补全使用选定来源的目录，技能补全读取 Host 资源目录。
明确选择的工作区在新会话首次发送时绑定；之后切换侧栏目录不会改变这项来源。PDF 原件由 Host 保存，附件打开同一作用域的
reader；页面选区使用真实图像。submit、三种 enqueue 和 child continuation 都保留相同的固定材料来源。

侧栏按项目组织会话，子任务关系直接来自 Catalog，分支选择使用实际 branch ID。工作概览承载任务、计划、后台操作和资源控制，
不把这些管理表单默认铺在消息正文中。工具调用与结果按 Run 和原调用关联；消息导航和右键引用只作用于当前视图。
共享设置事件可以在客户端控制绑定尚未完成时订阅；向某会话发出客户端设置操作仍需原绑定成功。

新建多 Run 会为各候选记录实际 Thread/worktree 与受理状态。部分失败或结果未知保留已创建对象，供用户核对或继续；
不能为恢复空界面而自动删除可能已经执行的工作。来源选择、导航项目与执行 cwd 分开，切换项目不会隐式搬迁活跃 Run。

界面呈现实报的 usage、mutation receipt 和进度观察。文件 preview 不证明写入成功；工具完成、写入失败、
working branch 和 unsaved draft 分开显示。未知扩展 entry 仍可用 generic/raw detail，扩展 renderer
保持原注册优先级。

右键 quote 只追加当前 draft，不发送。记忆提取核验选中的原生 source，由 personalization/Bot memory
owner 保存。Thread PDF 和 typed media 使用当前 Thread 的 material/holder identity；任意 output JSON
不自动成为 media reference，也不授权访问其中的 URL。

## 设置与呈现状态

共享[设置目录](../packages/application-client/src/settings-catalog.ts) 定义稳定 ID、字段、scope、发现和动作。
[Host settings service](../packages/web/application-host/lib/harness/settings-service.ts) 路由到 app settings、
原生 Agent settings、绑定客户端或原领域 action owner。查询目录不安装软件、不启动推理，也不证明能力已接线。
Owner/channel 缺失、平台不支持、只读和真实可执行动作分别表达。

更新使用 owner revision 和局部语义变更。同 owner 的 app 字段可一次 CAS；跨 owner 返回各自真实结果，
不承诺全局回滚。Saved、applied、awaiting restart、installed、authenticated 是不同事实。
长动作只有具备原 owner 的 query/cancel authority 才暴露 operation handle；设置工具不能同步 reload
正在等待该工具返回的同一会话。

设备本地变更使用认证后的 session-to-Surface binding，并等待实际应用 acknowledgment。
没有绑定客户端返回 unavailable，多个返回 ambiguous，不能广播修改。凭据留在原 owner，只暴露配置状态。

Agent profile 用 `AgentProfilesAPI` 管理模型、指令和工具选择。Editor 保留 Host 和打开时 revision，
刷新不抹掉未保存草稿。省略 tools、显式空集合和 reset 含义不同；已受理 Run 保留冻结配置。

设置按使用偏好、Agent、开发与项目、连接与扩展组织。目录中的 UI 路由只定位唯一管理页面，
不能改变字段 owner。对话默认保留全局/受信任项目继承；Harness 页面编辑当前 Host 的全局配置，
项目已有覆盖仍生效。模型服务管理连接与模型启用，各功能只选择已有模型；模型品牌与接入服务品牌分开。
技能保留目录/正文编辑，命令目录来自有效技能，并不提供另一套命令编辑 authority。

草稿保存单元使用固定操作栏。切页、关闭、项目切换和 Host 切换先处理草稿；失败保存不能放行。
Host 切换先串行完成 guard 阶段，再运行旧 owner teardown，避免用户仍在确认时关闭原 MCP view。
即时设置的成功反馈只在实际 owner 确认后出现。聊天外观预览复用正式时间线、Markdown、工具和 diff
渲染组件，在只读预览上下文中禁用真实文件/终端动作与扩展渲染器。

工作连接页是现有客户端连接、Thread source、Host 资源和具体 desktop 的组合视图，不保存第二套连接
profile。切换 Agent 只切换当前可见 Catalog；已受理 Run 的 source、execution 与 CU 选择不迁移。
资源连接编辑始终通过当前 Agent Host 的 HTTP owner；即使在 Electron 中，也不走本机 IPC。
SSH 配置、连接检测和 localhost 地址归该 Host，视图释放只停止观察，不断开后台 SSH。客户端默认 Agent
与资源 Host 的管理动作分开；资源页不提供切换 Catalog 或在客户端打开 Host 本地地址的操作。
远程资源仍要求 Agent Host 可达的 HTTP(S)/SSH 转发地址，客户端 relay 登录不自动提供资源路由。
桌面可保存下次启动是否运行本地 Host，并独立显示实际运行、环境覆盖和需重启状态；普通重启先走现有退出清理。
没有独立恢复页面的开发构建不能禁用唯一的本地入口。

存储页由 Application Host 统计实际数据根、共享恢复对象和缓存，并明确磁盘总量、Varin 占用与未知状态。
共享对象不按引用次数累加；不能可靠分摊的工作区容量不伪造为零。清理先生成绑定认证主体与作用域的
短期候选预览，再由原生 storage owner 重核对象引用及占用。客户端仅提交候选 ID，不提交删除路径。
设备切换复用当前 Agent 已配置的 managed 连接独立访问目标 Host，不切换 Agent Catalog。
远端预览绑定目标 Host/连接身份、原主体与目标清理回执；确认超时重试同一命令，不重算或改投新设备。
两端都核验权限，目标失联、仅中继、能力缺失和目录限制分别呈现。已接受清理不因观察连接断开而取消。
恢复记录删除/迁移仍由原恢复 owner 管理；空间清理统一进入存储预览。

## 能力降级与验证边界

Web/Electron 共享桌面文件能力；hosted/Capacitor mobile 使用兼容 contribution 与移动编辑器，官方 IDE
不声明 mobile 支持。Headless 可使用 Host 服务而没有任何界面。Provider 声明、module ready、实际可见
是三种不同证据。

隐藏 view 释放视觉 observer 和 demand-driven subscription，不能为保留布局重复扫描、轮询 Git、
准备语言服务或启动模型。大文件、多 model 和长历史需要测量与按功能降级，不能凭猜测设置妨碍基本读写的上限。

Profile transition、Registry、Monaco、client settings 和 Thread consumer 的局部测试描述中断与 stale-owner
行为；它们不证明完整 provider 集成、真机触屏/无障碍、打包 worker 加载或 UI 端到端验收。
平台验证应针对实际变更的 Surface。
