# Varin 可组合工作台与 IDE 架构

Status: current architecture and ownership contract; D-297 selection boundary implemented in 7A (D-298)

Current boundary (D-296): the former VS Code companion is retired from the supported product
surface. References to that adapter in older delivery notes are historical and do not define a
current surface contract.

Last updated: 2026-09-19

这份文档规定 Varin 工作台已经交付的架构、固定产品决策，以及文档、编辑器、Profile、语言服务和
调试各自的归属边界。实现进度与历史阶段不在这里保存；当前行为以代码、契约测试和模块文档为准。

正文为中文。英文读者可先看 [architecture.md](../architecture.md) 第 4 节的工作台概述。
跨 Shell 动画、首帧启动投影和不规定页面元素的 Motion 边界见
[varin-motion-platform.md](varin-motion-platform.md)。
desktop/web 官方文件编辑器的新目标、Monaco 与移动 CodeMirror 的分工以及语言智能实施顺序见
[unified-file-editor-platform.md](unified-file-editor-platform.md)。该文档取代本文原先的
CodeMirror-only 引擎决定，但不改变已经交付的 Document Registry、Editor Workbench Kernel、
Profile 或 Host ownership。

## 1. 目标

Varin 是一套可由 Varin 扩展重新组合乃至替换完整 UI/UX 的工作空间平台，当前已交付两套官方工作形态：

- **Agent Workspace**：会话、任务、Fleet、上下文与恢复工作流居中；
- **IDE Workbench**：项目、编辑器、搜索、Git、终端、诊断与调试居中，Agent 是可停靠的一等工作面板。

二者不是 Varin Core 中的两个硬编码 mode，也不是两套应用。它们是普通的第一方 Varin 扩展和 Workbench Profile。用户可以：

- 选择 Agent、IDE 或自建 Profile；
- 替换完整 `workbench.shell`；
- 只替换导航、页面、编辑器、面板、Composer、Timeline 或状态栏；
- 混合使用官方与社区贡献，例如 IDE 中央编辑器、社区 Explorer、官方 Agent 右栏；
- 动态启用、停用和更新这些扩展，而不刷新文档、不重启 Pi Runtime、不丢失共享工作状态。

Pi Packages 与 Varin Extensions 继续是两个系统。前者扩展 Pi Agent；后者扩展 Varin 产品、Surface 与 Application Host。不得把这套架构实现成 Pi 插件配置的另一种表现层。

## 2. 已确定的产品决策

以下决定已经固定,改动它们需要先改这张表：

| 主题 | 决定 |
| --- | --- |
| 产品模型 | Profile + Varin 扩展组合，不增加全局 `ideMode` 或 `agentMode` |
| 官方形态 | Agent Workspace、IDE Workbench、Research Workbench 都是第一方 Varin 扩展 |
| 默认形态与选择 | `default` 是 Agent Workspace 的稳定 ID；所选工作台按 `user → active` 解析，导航项目/会话不自动换 Shell |
| IDE Profile ID | `varin.ide` |
| 编辑器引擎 | desktop/web 官方文件编辑统一使用 Monaco；mobile/embedded 使用 CodeMirror adapter；不 fork Code OSS，不维护 Agent/IDE 两套文件能力 |
| 核心状态 | 文档、会话、终端、Git、Profile、Runtime 身份由共享内核拥有，Shell 只负责表现和布局 |
| 扩展自由度 | 完整 Shell 可自绘 DOM、Canvas、WebGL、WebAssembly 或使用任意框架；不强制 Varin 组件库 |
| Profile 与启停 | 选择 Profile 不暗中启停扩展；“应用扩展集”和“选择布局”保持可观察、可分别失败的明确动作 |
| 动态切换 | 同一 Surface 内热切换；新 Shell 就绪前保留旧 Shell，失败时不提交选择 |
| 故障恢复 | Recovery Shell 由 Core 固定提供；它只负责恢复扩展/Profile，不是第三套日常工作区 |
| 移动端 | 官方移动端继续以 Agent Profile 为主；完整官方 IDE 初始只声明 desktop/web 支持 |
| Pi 插件 | Pi Packages、Plugin Settings 及其原生数据权威不并入 Varin 扩展生命周期 |
| 发布 | 代码交付与 GitHub Release、npm tag、公共 SDK 发布是分别授权的动作 |

### 2.1 工作台 UIUX 与 Agent 工作侧重独立（D-297 / D-298）

科研工作台与未来办公工作台扩展完整 UIUX；入口设在现有 Agent/IDE 切换区域，复用 Workbench Profile、
Shell contribution 和 [Motion 平台](varin-motion-platform.md) 的切换动画。它们不属于项目选择菜单，
也不另建“研究中心”会话库。IDE 仍是完整开发环境，科研任务可以在其中继续；工作台之间共享资源与执行事实。

Agent Profile 在产品中称“工作侧重”，管理提示词、默认激活能力、工具组织、上下文和协作方式。
项目默认侧重只供新对话捕获，对话可以显式覆盖；这些设置不选择 Shell。反向也成立：切换工作台不修改侧重、
权限、模型或 Run，不派发任务、不调用模型；科研工作台可以展示普通对话，IDE 可以继续科研任务。

7A 已移除 workspace Profile selection 的 schema、写入与解析路径，使当前工作台由用户主动选择，
不随打开项目、会话或其工作侧重切换。项目级 panel/editor 布局和资源现场仍可按 workspace 保存，
不能再借项目布局覆盖所选 Shell。调整现有选择权威与持久化作用域，移除旧自动选择路径，不能并存两套科研 mode 状态。
重新打开应用时恢复工作台选择，不从当前会话的 Agent Profile 推测界面。

顶部使用两个相邻控件：「Agent / IDE」切换与「通用 / 科研」工作台菜单。IDE 不在工作台菜单里；进入 IDE
保留原工作台，返回 Agent 时恢复。在 IDE 中选另一工作台只修改返回目标。Surface 按 Host 持久保存这一返回偏好，
不另存或抢占当前 Shell 权威；实际切换仍由 Profile 事务与 Motion 完成。对话工作侧重维持独立控件。

7A 已交付这些选择语义以及 `varin.research` 基础 Shell。科研 Shell 复用共享窗口、导航、权限和资源框架，
中央显示真实研究主线、结果和可展开的分支/材料；后续实验与综合视图在 7B–7E 接入。交付顺序见
[plan 7A](../plan/agent-harness-plan.md#711-分阶段交付)，产品行为以
[科研集群设计第 10 节](research-cluster-design.md#10-产品入口工作台与工作侧重) 为准。办公只复用这一边界，不是科研实施前置。

## 3. 当前实现

当前仓库以一套共享内核承载多种工作台形态：

- `@varin/extension-contract` 定义 manifest、Profile、replacement、slot、context key 和服务契约；
- `@varin/extension-surface`、`extension-loader` 和 SDK 负责 owner/generation、候选激活、原子切换与清理；
- `varin.builtin.agent-workspace` 与 `varin.builtin.ide-workbench` 是普通 built-in Shell contribution；
- Agent Shell 的 `MainLayout.tsx` 是第一方内部组合，不是 Core fallback；IDE 的六个结构区域是真实 replacement host；
- Application Host 的 revisioned Documents authority、客户端 Document Registry 和 Editor Workbench Kernel 是唯一共享文档路径；
- desktop/Web 官方编辑器使用 Monaco，mobile/embedded 使用 CodeMirror adapter；
- Search、Language、Run、Debug 和 Tests 由 Host provider/service 管理，renderer 不启动特权进程；
- 固定 Recovery Shell 只负责修复扩展/Profile，不是第三套日常工作台。

后续拆分大型第一方组件必须服务于明确的 ownership、性能或复用问题，不能为了形式把每个内部组件注册成 contribution，也不能恢复第二个硬编码 Shell 或文档 owner。编辑器细节见 [unified-file-editor-platform.md](unified-file-editor-platform.md)。

## 4. 最终 ownership

### 4.1 Varin Core / Application Host

Core 与 Application Host 是以下状态的唯一权威：

- application-host identity、Runtime endpoint/generation 和 Surface instance identity；
- Workspace descriptor、root 映射、项目信任和文件权限；
- 磁盘文件 revision、原子写入、watch event sequence 和恢复 journal；
- Extension catalog、desired state、capability grants、candidate 和 actual state；
- Workbench Profile、通用 contribution references 和 selected replacements；
- Pi session、终端进程、Git、LSP/DAP/test provider 生命周期；
- Recovery Shell 和扩展修复入口。

### 4.2 Shared Workbench Kernel

Shared Workbench Kernel 位于共享 UI 与其 Application Host services 中，拥有：

- open Document Registry；
- editor group、tab、resource view 和 active editor；
- command、keybinding、context-key、menu projection；
- Problems、Output、Search result 等共享模型；
- Agent context attachment 与 file-change reconciliation；
- 跨 Profile 保留的当前 workspace workbench state。

Kernel 不决定 Shell 长什么样，也不拥有扩展私有配置。

### 4.3 Shell 与普通 Varin 扩展

Shell 与扩展拥有：

- 自己的 DOM、CSS、组件树和内部短期 UI 状态；
- profile-scoped Shell layout；
- 自己声明的 views、editors、commands、providers 和 cleanup；
- 自己 namespace 下的 revisioned extension storage；
- 被授予的 capability client。

它们不得：

- 建立第二份文档磁盘权威；
- 从 renderer 直接访问主机路径、进程、凭据或 Pi 私有状态；
- 把 transport/read failure 投影成空文件、空目录或空扩展列表；
- 用卸载 UI 的方式删除用户项目、Pi package 数据或插件原生数据库。

## 5. 稳定身份模型

所有新状态和异步操作必须携带足够身份，不能只用 path 或 session ID：

```ts
interface VarinWorkspaceIdentity {
  applicationHostId: string;
  workspaceId: string;
}

interface VarinConnectionOwner {
  applicationHostId: string;
  connectionGeneration: number;
}

interface VarinSurfaceIdentity {
  applicationHostId: string;
  surface: 'desktop' | 'web' | 'mobile';
  surfaceInstanceId: string;
}

interface VarinResourceReference {
  workspaceId: string;
  uri: string;          // workspace-scoped opaque URI
  relativePath: string; // display and user intent, not host authority
}
```

要求：

- Application Host 生成稳定、opaque 的 `workspaceId`；
- persisted document/layout key 使用稳定的 application host + workspace identity；连接 generation 只用于拒绝旧异步结果；
- Pi Runtime worker generation 属于 session/Agent 执行，不进入磁盘文档身份。升级或切换 Pi 不得复制同一 workspace 的 Document record；
- 现有单目录工作区映射为一个 root，模型允许未来多个 root；
- 公共扩展 API 使用 workspace resource URI，而不是把远端绝对路径当身份；
- Core 可保留受信任绝对路径用于终端、Pi cwd 和本地“在文件管理器中显示”；
- document、search、diagnostic、editor、layout 和 recovery 状态至少由 host + workspace + resource/surface identity 隔离；
- application-host endpoint/connection 切换后，旧 connection generation 的 load、watch、save、diagnostic 和 activation completion 必须被拒绝；
- 同一 workspace 的多个窗口拥有独立未保存缓冲区，通过文件 revision/watch 发生冲突，不暗中共享编辑内容。

## 6. 公开 Workbench 契约

### 6.1 常量归属

当前 `WORKBENCH_REPLACEMENT_TARGETS` 只存在于 UI 私有模块。公共扩展无法可靠引用。把稳定 target/slot 常量移到 `@varin/extension-contract`，UI 只 import，不保留另一份字符串表。

必须保留并公开现有 targets：

```text
workbench.shell
sessions.navigator
chat.timeline
chat.composer
agents.workbench
mcp.workbench
workspace.explorer
settings.workbench
```

标准可组合工作台 targets：

```text
workbench.activity
workbench.primary-sidebar
workbench.editor
workbench.secondary-sidebar
workbench.panel
workbench.status
```

标准 slots：

```text
workbench.activity.items
workbench.primary-sidebar.views
workbench.editor.actions
workbench.secondary-sidebar.views
workbench.panel.views
workbench.status.items
```

这些是官方 Shell 的稳定组合 seam，不要求完整自定义 Shell 必须渲染全部 slots。一个 Shell 若选择提供某个标准 slot，就必须遵守该 slot 的 props、ownership 和 disposal contract。

### 6.2 Contribution kinds

公开 contribution kinds 包括 `command`、`keybinding`、`menu-item`、`page`、`panel`、`sidebar`、`shell`、renderer，以及：

```text
view
editor
```

- `view` 表示可放入 Shell container/slot 的可复用工作视图；
- `editor` 表示根据 resource selector 打开的 resource editor；
- language/search/debug/test 是 versioned services，不为每种 service 新造 Surface contribution kind；
- `activity-item`、toolbar 和 tab action 使用 placement + command/menu，不增加无必要的专用 kind。

Manifest schema、parser、JSON schema、CLI check/build/test 和 SDK 类型必须同步，禁止 UI 私下接受 schema 不认识的 kind。

### 6.3 Profile 语义

- `default` 是官方 Agent Workspace 的 Workbench Profile 稳定 ID，不新增 alias。持久化 `label` 是稳定 fallback；官方 Surface 通过第一方 locale metadata 显示本地化名称；
- `varin.ide` 与可用的 IDE 扩展、contributions 同时维护；
- Profile selection 是 user/application 级选择；workspace 只参与布局，不覆盖 Shell，详见 2.1；
- `extensionIds` 是显式 desired-set 模板，只有用户执行 Apply set 才改变 enablement；
- 选择 Profile 时若其 Shell extension 未启用，显示“启用并切换”和“只检查配置”动作，不能静默启用；
- built-in 可被 disabled。没有可用 Shell 时进入 Recovery Shell，不阻止用户操作；
- Profile 引用暂时 missing/disabled contribution 时保留 reference，重新启用后恢复布局；
- Profile load failure 保留上次权威 Profile；malformed state 进入诊断，不回写空默认覆盖原文件。

### 6.4 Shell 切换事务

persisted selection 不能在新 Shell 尚未证明可 mount 时先提交。Surface transition controller 按以下顺序工作：

1. 根据指定 Profile 解析 candidate layout，但不更改当前选择；
2. 触发 candidate Shell `contribution-visible` activation；
3. 使用 candidate owner/generation 创建 staging mount；
4. managed/isolated mount promise resolved 后视为 candidate ready；
5. 使用 `expectedRevision` 写入 Profile selection；
6. 写入成功后一次性交换可见 Shell，再逆序 dispose 旧 Shell；
7. revision conflict、activation、mount 或 render 失败时 dispose candidate，继续显示旧 Shell；
8. 启动时 selected Shell 失败则显示 Recovery Shell，保留 selected Profile 和诊断，不伪造切回默认成功。

多窗口各自报告 actual Surface state。一个窗口 mount 失败不能把全局 desired state改成 disabled。

### 6.5 Versioned service IDs

以下服务 ID 是 canonical owner；不得为同一语义再保留第二个别名：

| Service ID | Owner / routing |
| --- | --- |
| `varin.documents` v1 | Core/Application Host 单一 provider，Surface 得到 resource-scoped capability |
| `varin.commands` v1 | Surface Core registry，owner-scoped handlers |
| `varin.context-keys` v1 | Surface Core registry，extension keys namespaced |
| `varin.workbench.layout` v1 | 当前 Shell selected provider，profile-scoped storage |
| `varin.workbench.editors` v1 | Shared Kernel registry，允许多个 editor providers |
| `varin.workspace.search` v1 | Application Host，可由显式 provider routing 替换 |
| `varin.language` v1 | Host multi-provider，按 workspace/language routing |
| `varin.debug` v1 | Host multi-provider，按 workspace/debug type routing |
| `varin.tests` v1 | Host multi-provider，按 workspace/provider routing |

Core services 不通过 renderer global 暴露。官方 UI 使用 `RuntimeAPIs`/registry hooks；managed、isolated 和 Host extensions 使用 SDK capability/service clients。服务缺失、歧义、版本不兼容和 provider failure 是明确状态，不投影成空结果。

## 7. Revisioned Documents API

### 7.1 单一权威

共享 `DocumentsAPI` 是所有文本编辑、预览和扩展 resource editor 的内容访问权威。

当前边界：

- `FilesAPI` 只保留目录浏览、文件搜索和非内容型 workspace 操作；
- `WorkspaceAPI` 可保留项目/归档/Git 管理，但不再拥有另一套文本 read/write；
- 不存在 `FilesAPI.readFile/statFile/writeFile` 与 `WorkspaceAPI.readFile/writeFile` 的重复编辑路径；
- 不保留长期 compatibility wrapper；消费者迁移和旧接口删除属于同一项变更。

### 7.2 DTO 核心语义

具体 spelling 以 `@varin/application-client` 为准，语义必须完整：

```ts
type VarinDocumentReadResult =
  | {
      status: 'ready';
      resource: VarinResourceReference;
      revision: string;       // opaque Host revision
      content: string;
      encoding: string;
      bom: boolean;
      byteLength: number;
      modifiedAt?: string;
    }
  | {
      status: 'missing';
      resource: VarinResourceReference;
    }
  | {
      status: 'binary';
      resource: VarinResourceReference;
      revision: string;
      byteLength: number;
      mime?: string;
    }
  | {
      status: 'unsupported-encoding';
      resource: VarinResourceReference;
      revision: string;
      byteLength: number;
      candidates?: string[];
    };

interface VarinDocumentWriteRequest {
  resource: VarinResourceReference;
  content: string;
  encoding: string;
  bom: boolean;
  expectedRevision: string | null; // null means assert missing/create
  operationId: string;
}

type VarinDocumentWriteResult =
  | { status: 'written'; revision: string; byteLength: number; modifiedAt?: string }
  | { status: 'conflict'; current: Omit<VarinDocumentReadResult, 'content'> };
```

网络、权限、主机和磁盘失败应 reject/返回明确 failed result，使调用者保留旧状态；不得映射为 `missing`、空字符串或 conflict。

Host 不得用 replacement characters 猜测无法可靠解码的文本。`content` 不包含 BOM，但保留原始换行序列；默认保存沿用 snapshot 的 encoding/BOM。新文件使用明确的 workspace/user 默认值。用户显式选择编码或换行格式是独立编辑操作，不在普通保存时悄悄转换。

`DocumentsAPI` 同时提供 revision-checked `move` 和 `delete`。源文件使用 expected revision；目标已存在、源已改变、源缺失是不同结果。用户在 conflict UI 选择“以我的版本覆盖”时，先读取并展示当前 disk candidate，再使用它的最新 revision 写入；不得增加一个绕过 revision 的普通 `force: true` 保存路径。

Revision 算法由 Host 私有实现，必须能检测常见的相同 mtime/不同内容变化。Host 串行化 Varin 对同一 resource 的 mutation，在写入边界再次校验 expected revision，并使用同目录临时文件 + atomic replace。不得向 UI 暴露 revision 的组成，也不得声称普通文件系统可以提供不存在的跨进程强事务保证。

### 7.3 Watch contract

Application Host 为 workspace 提供有序文件事件：

```ts
type VarinWorkspaceFileEvent =
  | { kind: 'created' | 'changed' | 'deleted'; sequence: number; resource: VarinResourceReference; revision?: string }
  | { kind: 'moved'; sequence: number; from: VarinResourceReference; resource: VarinResourceReference; revision?: string }
  | { kind: 'reset'; sequence: number; reason: 'overflow' | 'reconnected' | 'authority-changed' };
```

要求：

- sequence 只在同一 application host + workspace watch generation 内比较；
- reconnect/overflow 发送 `reset`，消费者重新读取打开文档和可见树，不从不完整事件推断删除；
- Web 使用认证后的已有 transport/明确 route；凭据不进入 URL；
- Electron 复用 Web/Application Host，不新增文件系统 preload IPC；
- hosted mobile 复用远端 Web host；本地 Capacitor 文件系统不意外 fall through；
- watcher 只通知元数据，不发送文件正文，不记录正文；
- visible/open resources 驱动读取，隐藏 Shell 不启动第二个 watcher。

## 8. Document Registry 与编辑状态

### 8.1 状态模型

每个文档拥有独立 record：

```text
unloaded -> loading -> ready
                    -> dirty
                    -> saving
                    -> conflict
                    -> deleted
                    -> error
```

Record 至少包含：

- workspace/resource/application-host identity，以及当前异步操作捕获的 connection generation；
- base content/revision；
- current buffer 与 monotonic local edit revision；
- dirty/saving/conflict/deleted/error；
- active save operation ID 和它捕获的 edit revision；
- 外部 candidate snapshot；
- attached editor views 与 language-service subscriptions；
- recovery journal revision。

高频正文不能放进会让整个 React 树或 broad Zustand selector 每个按键重跑的普通对象图。实现一个外部 `DocumentRegistry`，提供 per-document subscription；Zustand 只保存低频导航/布局元数据。编辑器 transaction 进入 document model，再只通知该文档的 views 与服务。

### 8.2 并发不变量

- load 开始时捕获 local edit revision，返回时不能覆盖更新的草稿；
- save 捕获内容、base revision 和 local edit revision；save 成功后若已有新编辑，只推进 base 到已保存版本，文档仍 dirty；
- clean 文档收到新 revision 自动 reload；
- dirty 文档收到新 revision 进入三方 conflict：base、buffer、disk candidate；
- delete/move 事件不会静默关闭 dirty 文档；
- application-host endpoint/workspace switch 前，pending write 要么完成在捕获 owner，要么以明确取消结果保留 recovery journal；
- mode/Profile/Shell 切换不触发 document unload；
- 多窗口各自 buffer，用 revision/watch 发现冲突；不实现隐式协同编辑；
- authoritative read failure 保留现有文档与 dirty 状态；
- no-op file event 不创建新 record 或刷新无关 editor。

### 8.3 恢复 journal

未保存正文属于敏感项目数据。Recovery journal：

- 由 Application Host 写到 `VARIN_DATA_DIR` 下的 Varin 文档恢复 namespace；
- keyed by application host + authenticated user/profile + workspace + recovery session + resource；
- client 在页面重载/窗口恢复范围内保留 recovery session ID；Host 可列出同一用户/workspace 的 orphan journals，让新 Surface 显式接管或丢弃；
- 使用 revisioned/serialized writes；
- 只在有未保存修改时存在；保存或明确放弃后删除；
- 崩溃重启后提供 restore/discard/diff，不自动覆盖项目文件；
- 不写入浏览器 Local Storage 大文本，不写日志，不进入 Pi session JSONL；
- 不使用猜测性的数量/字节/天数硬限制。真实磁盘风险通过可见用量、清理动作和后续测量治理。

## 9. Editor Workbench Kernel

### 9.1 Document 与 Editor View 分离

一个 Document 可同时被多个 Editor View 打开：

- Document 共享正文、base revision、dirty/conflict；
- View 独立保存 cursor、selection、scroll、fold、focus 和临时 UI；
- 同一 Document 的编辑 transaction 广播给其他 views，但不覆盖各自 selection；
- Profile 切换只 unmount/mount views，Document record 继续存在；
- 关闭最后一个 view 时，dirty 文档要求 save/discard/keep-in-recovery 的明确选择。

### 9.2 Editor Group

共享 editor state 包括：

- split tree（horizontal/vertical）；
- group ID、tab order、active tab；
- preview/pinned tab；
- resource + editor provider ID；
- transient diff/preview input；
- per-workspace restore snapshot。

这份状态独立于 Agent/IDE Shell layout。Agent Profile 可以把同一 editor group 显示在右栏；IDE Profile 可以把它显示在中心；没有可见 editor container 时状态仍保留。

### 9.3 Editor provider

公开 `editor` contribution 通过 selector 声明支持的 scheme、mime、language、filename pattern 和 read/write 能力。解析顺序：

1. 用户对该资源/类型的显式关联；
2. 当前 Profile 的 replacement/provider selection；
3. selector specificity 与声明 order；
4. 官方 text/binary fallback。

同优先级歧义显示选择器并可记住用户选择，不依赖加载时序。Editor provider 通过 Document capability 操作内容；只有额外获得 workspace-files capability 时才能执行任意文件操作。

官方 resource editors 至少包括：

- text/code；
- diff；
- Markdown preview；
- image；
- JSON tree/raw；
- PDF；
- Drawio/HTML preview 沿用现有安全边界。

### 9.4 统一文件编辑器层

早期 document-bound CodeMirror adapter 用来证明 Document Registry 与 editor view 分离；当前实现
在不改变文档权威的前提下按 Surface 分工：

- desktop/web 的 Agent 与 IDE 官方文件编辑共用 Monaco model/runtime；
- mobile Agent 与 embedded editors 保留用途明确的 CodeMirror adapter；
- editor transaction 进入 Document Registry，任何引擎都不能成为 dirty/save/conflict 权威；
- language、diagnostics、completion 和 decorations 通过同一 typed LanguageServicesAPI 接入；
- 历史 `MAX_OPEN_FILE_LINES=5000` 产品边界已经退休并由 focused test 防止复活；后续性能工作继续测量代表性大文件，再做 feature 分级或自适应治理，不复制猜测数字；
- 具体 identity、同步、worker、扩展和迁移约定见
  [unified-file-editor-platform.md](unified-file-editor-platform.md)。

### 9.5 官方 Shell layout document

Agent 和 IDE Shell 各自维护 layout schema，不由 Core 强迫第三方采用。官方 IDE 的 v1 layout 至少表达：

```ts
type VarinIdeLayoutNode =
  | { id: string; kind: 'split'; axis: 'horizontal' | 'vertical'; children: string[]; weights: number[] }
  | { id: string; kind: 'stack'; viewIds: string[]; activeViewId?: string }
  | { id: string; kind: 'editor-area' };

interface VarinIdeLayoutDocument {
  schemaVersion: 1;
  rootId: string;
  nodes: Record<string, VarinIdeLayoutNode>;
  floating: Array<{ viewId: string; x: number; y: number; width: number; height: number }>;
  activityVisible: boolean;
  statusVisible: boolean;
}
```

约束：

- `editor-area` 只挂载共享 Editor Groups，不复制 tab/document state；
- stack 中保存 contribution/view IDs，missing/disabled view reference 不删除；
- distribution default、user default 和 workspace override 使用 extension storage 的现有 scope/revision，不把 JSON 塞回 React state；
- malformed/read failure 使用上次有效布局和诊断，不写回空布局；
- resize/reorder writes 捕获 profile/workspace owner，串行并拒绝 stale revision；page hide/freeze 时 flush；
- drag/resize 交互使用 container measurements，不用 viewport breakpoint 猜测；
- floating 是普通 Surface 内浮层。真正的额外 native window 仍由 Electron 能力与明确扩展 grant 管理。

## 10. Command、Keybinding 与 Context Keys

所有官方 Shell 和 IDE 操作通过共享 command service，不继续增加组件私有快捷键分支。

需要：

- owner-scoped command registration/disposal；
- keybinding contribution 和用户 override；
- versioned context-key store；
- menu/toolbar/action 由 command + `when` 投影；
- core keys 如 active workspace、active editor、resource language、dirty、conflict、terminal focus、agent busy；
- extension 自定义 keys 必须 namespace 到 extension ID；
- context key 变化只通知依赖该 key 的 commands/views，不全量重算全部贡献；
- command 执行捕获 Surface、workspace、resource 和 owner generation，晚到 completion 不更新新 owner。

官方命令至少覆盖 Profile/Shell 选择、文件打开/保存/关闭、split、搜索、问题导航、终端、Agent focus/context attachment。

## 11. Search 与 Language Services

### 11.1 Search

- 文件名搜索沿用并收敛现有 Files search authority；
- 内容搜索在 Application Host 执行，可取消、workspace scoped、结果 streaming/batched；
- symbol 搜索来自 language providers；
- query generation 与 workspace identity 进入每个 request/result；
- 搜索取消或失败保留已明确展示的旧结果并显示 stale/failed，不伪装为零结果；
- 不为隐藏 Search view 保持全仓 poll；
- 大仓库优化以真实 scale trace 为依据，优先缩小/索引/增量，不先加任意结果或文件数限制。

### 11.2 Language service

versioned Host service `varin.language` 由多 provider 路由选择具体实现。职责：

- workspace/language/provider generation 维度启动和停止 LSP；
- JSON-RPC transport、restart、diagnostics 和 progress；
- textDocument open/change/save/close 使用 Document local version；
- completion、hover、definition、references、rename、code action、document/workspace symbols；
- stale document version 的 diagnostics/result 不提交；
- 一个 provider 失败不清空其他 provider 的 diagnostics；
- workspace trust 和 capability grant 在 Host spawn 边界执行；
- 不在 renderer、Pi worker 或 Electron preload 中启动 language server；
- 不把所有语言服务器打进普通安装包。第一方/社区 language extension 提供 discovery、command 和配置。

Electron 复用同进程 Web/Application Host。远程 Web 在服务器工作区运行 LSP，不允许浏览器意外 spawn。

## 12. Agent 与编辑器协作

### 12.1 上下文附件

Active editor、selection、Problems、Git diff 都可以形成显式 Agent attachment：

```ts
interface VarinEditorContextAttachment {
  resource: VarinResourceReference;
  documentRevision: string | null;
  localEditRevision: number;
  source: 'saved' | 'unsaved-buffer';
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  languageId?: string;
}
```

- saved attachment 可让 Pi 工具读取磁盘；
- unsaved attachment 的实际文本作为明确的 prompt/context payload 发送，UI 标记“未保存快照”；
- 不创建隐藏 shadow workspace，也不声称 Pi 文件工具能看到未保存 buffer；
- 用户决定附加 selection、完整 buffer 或仅 path；
- provider/model context 上限通过现有 token/usage 反馈呈现，不新增猜测性的固定字符上限。

### 12.2 Agent 文件修改

Pi 和 Pi 插件继续写真实 workspace 文件。Document watcher 负责协调：

- clean open document：载入新 revision，并在 UI 标明 Agent 修改来源（可从 session/tool hint 补充，但文件事件仍是权威）；
- dirty open document：进入 conflict，不 autosave 覆盖；
- closed document：更新 tree/Git/search invalidation；
- rename/delete：保留 dirty buffer 并提供 save as/compare/discard；
- tool diff、timeline changed files 和 editor diff 可以互相导航；
- Patch review 支持逐文件/逐 hunk 接受、拒绝或手工合并，但最终写入仍走 DocumentsAPI revision precondition。

选中的 `varin.workspace-recovery@5` Host 服务拥有受影响文件日志和联合恢复；Document conflict
不复制其日志，也不读取可选 `pi-workspace-history` 包的私有状态。

## 13. Runtime 与 Surface 行为矩阵

| Runtime/Surface | Documents/Watch | Agent Profile | IDE Profile | Host services |
| --- | --- | --- | --- | --- |
| Web 本地/远程 | Web Application Host | 完整 | 完整 | 文件、终端、Git、LSP/DAP 均在服务器 |
| Electron | 复用 Web Host | 完整 | 完整 | 只有窗口/菜单/对话框等原生能力走 Electron IPC |
| Hosted mobile | 复用远端 Web Host | 完整移动布局 | 官方 IDE 初始不声明支持 | 远端 Host |
| Capacitor | 连接 Varin server | 完整移动布局 | 稳定 unsupported | 不直接访问设备项目文件 |
| Headless | Host contract only | 无 Surface | 无 Surface | Documents/search/language provider 可供协议测试 |

每个新增 Runtime API 在共享接口中明确以上行为。Electron 不因为“桌面 IDE”而获得一个并行文件后端。

## 14. 性能契约

不用随意的实体上限掩盖性能问题。先记录真实交互、代表性仓库和当前成本，再决定实现。

结构性要求：

- 隐藏/停用 Shell 和 view 不执行轮询、文件树扫描、Git refresh 或 language request；
- 文件事件成本与受影响 resource/open views 成正比，不与全部项目 × 全部文档相乘；
- 高频 buffer 不进入 broad Zustand state 或每键 durable serialization；
- editor/group/document selectors 保留无关对象引用；
- Search、index 和解析不阻塞主线程交互；
- 同一 workspace 的 watch/search/language service 由 provider 共享，不由每个 view 重复启动；
- Profile 切换不重新读取所有文档、不销毁终端、不重新建立 Pi session；
- inactive extension 的 declarative metadata 可存在，但 executable entrypoint 只按 activation event 加载；
- 记录 Shell mount duration、document count/bytes、watch event backlog、LSP process 和 cleanup failure，先用于 Inspector/诊断，不转化成无依据硬拒绝。

性能验收优先使用 operation count、无关引用稳定性、inactive zero-work 和真实 production build trace。不得仅凭 memo、单个微基准或 type-check 声称性能完成。

## 15. 安全与数据边界

- workspace path containment、symlink 和 project trust 在 Application Host 执行；
- custom editor 默认只得到当前 resource 的 Document client，不自动得到整个文件系统；
- LSP/DAP/task subprocess 必须由 Host capability 启动，renderer 只发送 typed request；
- remote page、preview iframe 和 isolated extension 不继承 Electron 本地权限；
- file contents、unsaved buffers、prompt attachments、credentials、LSP payload 和 recovery journal 不写普通日志；
- trusted-native mode 保持显式，不伪装成隔离；
- Recovery Shell 不加载普通扩展代码；
- 扩展 disable 保留 storage/layout/document data；remove 时 retain/delete 只影响该扩展 namespace；
- 不增加没有真实失败模式依据的文件大小、并发、扩展数、进程数或语言数限制。

## 16. 验证强度按风险分配

每项变更保持可审查、可回退。验证跟着风险走，不靠重复次数堆证据：

1. 迭代时只跑直接受影响的 focused tests；
2. 功能完成时跑归属包的 type-check、lint 和契约测试；
3. 改公共 contract/export 时跑其消费者的 build/type-check，并跑一次 `bun run dead-code`；
4. 只有改 UI Shell 时才跑 production Web build；
5. 只有 Electron startup/package 边界变化时才跑 bundled dev/package smoke；
6. 完整 workspace suite、Windows installer、Docker 和 CI 留给真正跨边界或发布前的收敛；
7. 提交前跑一次 `git diff --check`；
8. 准确记录哪些检查跑了、哪些没跑。

公共 npm tooling 通过真实 tarball conformance 验证，并按相互兼容的版本协调发布。

## 17. 跨领域行为要求

下面是整套工作台必须同时成立的性质。它们的权威证据是代码里的测试和对应包的
`DOCUMENTATION.md`，本文只记录跨领域不变量。

### Profile 与扩展

- Agent 与 IDE 都通过普通 built-in extension manifest 注册；
- 没有 `ideMode` 条件树成为第三个 ownership；
- Profile 选择与 extension set apply 是两个可分别失败的动作；
- Shell candidate ready 后才提交 selection；
- enable/disable/update 不触发 document reload；
- 最后一个 Shell 被停用时 Recovery 仍可用；
- 社区 Shell 可以不使用官方布局或 React。

### 文档与文件

- 只有一个 DocumentsAPI 内容权威；
- expected revision 加原子写入；
- missing、empty、binary、failure 互相可区分；
- clean external update 与 dirty conflict 分开处理；
- save、load、hydration 的竞态有明确结果；
- move、delete、rename 走同一套 revision 校验；
- 崩溃后可恢复；
- application-host endpoint、workspace、多窗口互相隔离；
- 文件内容不进日志。

### Workbench

- 多个 dirty document 同时存在；
- split 与 editor group；
- 同一文档多个视图；
- resource provider 有 fallback；
- Agent/IDE 切换保留状态；
- Shell 私有布局与共享编辑器状态并存；
- 隐藏的视图不做后台工作；
- 键盘、context key 和菜单有明确归属。

### Agent、LSP 与调试

- 未保存内容只在显式附加时进入 Agent；
- Agent 写入遇到 dirty buffer 走冲突流程；
- 过期的语言或调试结果被拒绝；
- provider 相互隔离且能清理；
- 项目信任在 Host 侧判定；
- 远程运行时保持一致行为；
- 不复制任何 Pi 插件的私有状态。

## 18. 主要风险与处理

| 风险 | 处理 |
| --- | --- |
| IDE UI 绕过文档一致性 | IDE Shell 只能组合共享 Documents 与 Editor Kernel |
| MainLayout 迁移时出现两套 Shell owner | 每个 seam 完整迁移后删除 hard-coded branch；不保留永久 wrapper |
| Profile 切换先持久化导致白屏 | staging mount ready 后再 revision commit |
| 外部/Agent 修改覆盖 dirty buffer | expected revision + watch + explicit conflict |
| 每按键全局 rerender/persist | per-document external store，正文不进 broad Zustand |
| 通用布局限制第三方 Shell | Profile 只存通用 refs；Shell layout 属于 profile-scoped service/storage |
| 公共 SDK 过早冻结错误抽象 | 官方 Agent、IDE、editor、LSP 先消费，再按真实使用结果演进公共契约 |
| LSP/DAP 子进程失控 | Application Host supervisor、owner generation、workspace trust、shutdown cleanup |
| Electron 重复后端 | Electron 继续复用 Web/Application Host |
| 为大文件/仓库随意加小上限 | 先测量真实 scale，使用警告、按需加载、索引、背压或可配置策略 |

## 19. 最高风险的边界

复核这套工作台时，按风险排序看下面这些边界，而不是机械重跑全部命令：

1. Shell/Profile stage-and-commit 与 Recovery；
2. Document revision/watch/conflict/recovery；
3. Agent/IDE 热切换状态保留；
4. external extension disable/update cleanup；
5. LSP/DAP provider generation 与 workspace trust；
6. Web/Electron/mobile 明确 parity；
7. 公共 npm tarball 与文档契约一致。
