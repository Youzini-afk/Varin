# Varin 统一文件编辑器平台设计

Status: current unified editor architecture and acceptance contract

Current boundary: Web/Electron use Monaco; mobile and embedded editors use purpose-specific
CodeMirror adapters. The former VS Code companion is retired.

Last updated: 2026-10-06

本文规定 Varin 文件编辑能力的产品目标、权威边界、桌面/Web 与移动端分工、Monaco
集成方式、语言智能契约、扩展边界、性能约束和实施顺序。它取代
[composable-workbench.md](composable-workbench.md) 中“所有 Surface
统一使用 CodeMirror 6”的旧引擎决定，但不推翻该文档已经交付的 Document Registry、Editor
Workbench Kernel、Profile、Varin 扩展和 Host ownership。

## 1. 结论

Varin 不维护 Agent 一套文件编辑器、IDE 另一套文件编辑器。官方文件编辑路径只有一套能力
内核：

- desktop/web 的 Agent Workspace 与 IDE Workbench 共用 Monaco Editor；
- Agent 中的文件查看、显式编辑、选区附加和行内评论与 IDE 使用同一 Monaco model、命令、
  语言服务和主题桥；两种 Shell 只使用不同的布局与默认显示密度；
- 官方 mobile Agent 使用轻量 CodeMirror adapter。Monaco 官方明确不支持移动浏览器，因此移动
  端不伪装成 Monaco parity，但仍共用 Document Registry、DocumentsAPI、保存/冲突语义、命令
  ID 和语言服务 DTO；
- 聊天 composer、设置 JSON/JSONC、Prompt 等嵌入式小编辑器继续使用 textarea 或
  CodeMirror。它们不是文件工作台，不建设第二套文件 IDE 能力；
- 桌面/Web 文件 diff 使用 Monaco diff editor；聊天消息、PR 展示等非文件型只读 diff 可以继续
  使用现有专用 renderer；
- 不 fork Code OSS，不把外部编辑器扩展误当成 Varin 扩展；
- 社区扩展仍可通过 `editor` contribution 完整替换官方文件编辑器，使用任意框架或渲染技术。

引擎切换复用已有文档权威，把文件编辑、语言智能和 Agent 协作接到同一条编辑路径。

## 2. 为什么现在改引擎决定

### 2.1 当前基础不是推倒重来

现有架构中最难、也最值得保留的部分已经存在：

- `packages/ui/src/lib/documents` 是唯一客户端正文权威，持有 base revision、buffer、dirty、
  saving、conflict、deleted、外部 candidate 和 recovery journal；
- `packages/ui/src/lib/workbench/editors` 已把 tab、group、provider、view state 和 Shell layout
  分开；
- Agent 的文件面板与 IDE 中央编辑区都经过 `ResourceEditorHost`，不是两条互不相干的产品路径；
- Application Host 已拥有 DocumentsAPI、workspace search、LSP、DAP、task 和 test 进程；
- `editor` contribution 与 `defineEditorMount` 已允许 Varin 扩展替换资源编辑器；
- runtime/workspace generation、expected revision、stale completion 和 owner cleanup 已有明确
  不变量。

因此迁移对象只是官方 text/code/diff renderer 和其语言客户端，不是工作区、文件、保存或扩展
系统。

### 2.2 引擎切换的理由

早期 CodeMirror 文件路径只消费少量语言功能，Agent 与 IDE 容易各自补出一套编辑行为。
现在两种 desktop/Web Shell 共用 Monaco model、命令和 Host language bridge，包含导航、rename、code actions
及 revision-safe WorkspaceEdit。历史缺口解释切换原因，不是当前功能清单。

### 2.3 采用 Monaco 的准确边界

采用当前稳定的 `monaco-editor` ESM 包。实施开始时以 `0.56.0` 为基线：该版本提供受支持的、可
tree-shake 的 editor/features/language entrypoints，并继续支持 Vite 的 module worker 集成。版本
升级仍按正常依赖治理审查，不使用私有 `vs/*` 实现作为长期 API。

Monaco 上游给出的几个事实直接决定本设计：

- model 代表打开的文件，并由唯一 URI 标识；editor view 可以挂载/切换 model；
- editor view 可以保存和恢复独立 view state；
- diagnostics、completion、hover、rename、format、inlay hints 等有公开 provider/marker API；
- Vite 集成必须显式提供 `MonacoEnvironment.getWorker`；
- Monaco 不支持移动浏览器；
- VS Code 扩展不能直接运行在 Monaco 中。

参考：

- [Monaco Editor README](https://github.com/microsoft/monaco-editor)
- [ESM/Vite integration](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md)
- [0.56 changelog](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md)
- [ITextModel API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ITextModel.html)
- [ICodeEditor API](https://microsoft.github.io/monaco-editor/typedoc/interfaces/editor_editor_api.editor.ICodeEditor.html)

## 3. 用户可见的目标体验

### 3.1 Agent 与 IDE 的关系

Agent 和 IDE 不再用“简版能力”和“完整版能力”区分，而只区分呈现：

| 能力 | Agent Workspace | IDE Workbench |
| --- | --- | --- |
| 文件 model、undo/redo、dirty/conflict | 与 IDE 相同 | 与 Agent 相同 |
| 语法、搜索、折叠、多光标、括号、自动缩进 | 完整可用 | 完整可用 |
| completion、hover、diagnostics、navigation、rename、code action | provider 存在时完整可用 | provider 存在时完整可用 |
| 文件选区附加、行内评论、Agent patch review | 主入口 | 同样可用 |
| minimap、breadcrumbs、outline、Problems、debug gutter | 默认更紧凑，可由用户打开 | 默认完整显示 |
| 编辑权限 | 由文档/provider capability 决定，不因 Agent Shell 被禁用 | 同左 |

`agent-compact` 与 `ide-full` 是官方 presentation preset，不是两套组件，也不是新的持久化权威。
用户设置和自定义 Profile 可以覆盖 preset。

### 3.2 官方文件编辑完成标准

没有 LSP 时，文件编辑仍需具备：

- 文件类型识别与语法着色；
- 行号、active line、匹配括号、自动闭合、自动缩进、indent detection；
- 多光标、列选择、选择扩展、拖放、剪贴板、undo/redo；
- find/replace、match count、replace all、go to line；
- folding、word wrap、whitespace、sticky scroll、minimap 与 overview ruler；
- 单文件与多 view 的稳定 cursor/selection/scroll/fold 恢复；
- Varin 主题、字体、字号、tab/space、line ending、format-on-save 等设置；
- `Mod+S`、统一 Command Palette、Varin shortcut override 和可见冲突提示；
- CJK IME、组合输入、屏幕阅读器、高对比主题和纯键盘操作。

语言 provider 存在时，再增加：

- snippets、completion resolve、additional edits 与 auto-import；
- Markdown hover、signature help、parameter hints；
- diagnostics、related information、quick fix 与 source action；
- definition/declaration/type definition/implementation、peek 与 references；
- document/workspace symbols、outline、breadcrumbs；
- rename preview、跨文件 WorkspaceEdit 和可撤销应用；
- document/range/on-type formatting 与 format on save；
- semantic tokens、inlay hints、document highlights、selection/folding ranges；
- document links、colors、code lens 等 provider 实际声明的能力。

provider absent、starting、ready、degraded、failed、untrusted 和 unsupported 必须真实可见；没有
provider 不能伪装成“0 个结果”或健康状态。

## 4. 单一权威与组件职责

| 组件 | 唯一职责 | 明确不拥有 |
| --- | --- | --- |
| Application Host `DocumentsAPI` | 工作区解析、磁盘内容/revision、原子单文件写入、move/delete、watch、recovery journal | cursor、undo、编辑器 DOM |
| Client `DocumentRegistry` | live buffer、base revision、local edit revision、dirty/save/conflict/deleted、恢复状态 | Monaco view、磁盘进程 |
| `FileEditorModelRegistry` | 把一个 Document record 投影成一个 Monaco `ITextModel`，管理同步和生命周期 | 磁盘权威、第二份 dirty/conflict 规则 |
| Monaco editor view | 当前 view 的 selection、cursor、scroll、focus、可视 widgets 与 decorations | 文档 identity、保存策略、工作区进程 |
| Editor Workbench Kernel | tabs、groups、provider resolution、view IDs、Profile-independent open state | 正文与语言进程 |
| `MonacoLanguageBridge` | 把 `RuntimeAPIs.language` 的 typed results 投影成 Monaco providers/markers | spawn、provider selection、私有 LSP transport |
| Varin command/shortcut/theme registries | 命令 ID、用户按键覆盖、主题 token 的产品权威 | Monaco 私有配置存储 |
| Varin `editor` contribution | 完整替换某类资源的 renderer | 绕过 Document controller 写磁盘 |

Monaco model 是高频交互投影，不是第二个文档权威。任何保存、冲突、Agent 外部修改或 recovery
判断都由 Document Registry 完成；任何磁盘 mutation 都由 Host 完成。

## 5. Model identity 与生命周期

### 5.1 身份

新增内部 `documentInstanceId`。它在一个 Document record 首次建立时生成，在该 record move/rename
时保留，在 runtime/workspace registry 重建时失效。它不写入项目文件，也不进入公共 extension
snapshot。

Monaco model URI 使用 Varin 虚拟 scheme，并至少包含 runtime connection key 与
`documentInstanceId`：

```text
varin-document://<runtime-key>/<document-instance-id>
```

真实 `workspaceId/resourceId` 保存在 binding metadata 中，不放入日志或 worker 名称。这样：

- 同一 runtime 中一个 Document 只有一个 model；
- 同一文件的多个 editor view 共享 undo stack 和正文；
- rename/move 不因 Monaco URI 不可变而强制销毁 model；
- 两个 application host 或 runtime generation 不会错误复用 model；
- Host LSP 请求仍使用 authoritative `DocumentIdentity`，不把虚拟 URI 当磁盘路径。

### 5.2 owner 与引用

Model 由 Editor Workbench Kernel 的 open tab/resource owner 获取，而不是由 React editor DOM 的
mount effect 获取。Profile/Shell 切换可以销毁 view DOM，但只要 tab 仍打开，model 不被重建。

生命周期分开计数：

- **model owner**：打开的 tab、diff input 或显式 resource owner；
- **visible view owner**：当前实际挂载的 editor view；
- **language owner**：可见且需要语言能力的 document；
- **recovery owner**：dirty document 的恢复状态。

最后一个 visible view 消失后必须停止 layout、ResizeObserver、view listeners、widgets 和仅可见
语言请求；model 可以因仍有打开 tab 而保持。最后一个 tab 关闭时：

- clean document 可以释放 model；
- dirty document 必须先完成 save、discard 或 keep-in-recovery 的显式选择；
- keep-in-recovery 在 journal 完成后可以释放 model，Document Registry/recovery 仍保留正文；
- runtime/workspace owner 被撤销时统一 dispose model、provider registrations、markers 和 workers
  的本地引用，陈旧异步结果不得重新注册。

这里不增加猜测性的“最多打开 N 个 model”限制。先在诊断面板公开 model 数量、正文字符量、可见
view、worker 和 language subscription，再依据真实数据决定是否需要内存压力下的自适应回收。

### 5.3 view state

`EditorViewState` 改为 provider-owned、带版本的 JSON payload，而不是继续扩充一组引擎特定字段：

```ts
interface EditorProviderViewState {
  providerId: string;
  schemaVersion: number;
  value: JsonValue;
}
```

官方 Monaco provider 保存 `ICodeEditorViewState` 中可序列化的 selection、scroll、fold 和 contribution
state；每个 `viewId` 独立保存。恢复顺序固定为 set model → restore view state → layout → reveal/focus。
malformed 或未来版本 view state 只丢弃视图状态，不影响 Document buffer、dirty 或 tab。

旧 `cursorLine`、`scrollTop`、`foldedLines` 等字段做一次迁移，成功后由新 provider state 接管，
不长期双写。

## 6. Document Registry 与 Monaco 同步协议

### 6.1 Registry API

在现有 `applyTransaction(identity, fullBuffer, {origin, changes})` 基础上收敛出同步的增量入口：

```ts
applyEdits(identity, {
  expectedLocalEditRevision,
  edits: Array<{ from: number; to: number; insert: string }>,
  origin,
}): DocumentEditResult
```

要求：

- edits 基于同一个 captured document revision；
- range 必须有效且互不重叠，非法输入返回 typed failure；
- 一次调用只推进一次 local edit revision；
- Registry 计算新 buffer、dirty 与 `lastChanges`，不让 React 先拼完整字符串再回写；
- 同步失败保留 model 与 Registry 两份 snapshot 到诊断/recovery，不静默丢弃用户刚输入的内容。

公共 `VarinEditorDocumentController` 可以增量增加 framework-neutral `applyEdits`，但不暴露
Monaco 类型。现有 `replaceContent` 继续服务低频或简单 custom editor；是否在下一个公开 SDK major
删除它，应依据真实消费者而不是在本次迁移中制造兼容层。

### 6.2 用户输入

1. Monaco `onDidChangeModelContent` 产生 ordered offset edits；
2. binding 捕获当前 Document local edit revision 与 origin；
3. Registry 同步应用 edits 并发布新 snapshot；
4. 同 origin、同 revision 的回声不再写回当前 model；
5. 其他 view 因共享同一个 model 已自然同步，只更新各自 decorations/context，不改 selection；
6. language sync queue 使用 Registry 接受后的 revision 和 edits。

任何 Monaco action、Vim adapter、format、paste、drop 或扩展产生的 model edit 都经过同一个
`onDidChangeModelContent`，不能另开“程序化编辑”旁路。

### 6.3 Registry 或外部更新

Registry 的 buffer 因 open、recovery、clean disk reload、conflict resolution、Agent patch accept 或
其他 editor provider 发生变化时：

- binding 先比较 document revision/origin；
- conflict candidate 不替换 live model；
- 需要替换 live buffer 时，优先使用已知 incremental edits；只有缺少 edit information 才计算
  content delta；
- update 作为明确的 external/recovery/format source 进入 Monaco undo 边界，不用 `setValue` 粗暴
  清空 undo stack；
- 每个 view 的 selection/scroll 由 Monaco model edit transformation 与独立 view state 保持；
- update 完成后记录 applied document revision，陈旧 async load/theme/language completion 被丢弃。

### 6.4 保存与语言同步

- 手动保存与 auto-save 都只调用 Document Registry `save`；
- save 捕获 base revision、buffer 与 local edit revision；保存期间继续输入时，成功只推进已保存的
  base，document 继续 dirty；
- 保存成功后显式发送 language sync `reason: 'save'`，修复当前 Host 已支持 `didSave` 而 UI 从不
  发送的问题；
- 保存冲突不修改 model，进入现有三方 conflict；
- format-on-save 先取得匹配 document version 的 edits，应用到 Registry/model，再以新 revision
  保存；format 失败不会阻止用户选择原文保存，且不能显示为空成功。

### 6.5 runtime、workspace 与 owner 切换

所有 model binding、provider registration 和 async request 捕获：

```text
runtime connection key + workspaceId + documentInstanceId + local edit revision
```

任一 identity 改变后，旧结果只能完成在旧 owner 或返回 stale/cancelled，不能写入新 runtime、同名
workspace 或新 model。Runtime endpoint 切换前继续使用现有 recovery flush；切换后建立新的 model
registry，不复用旧 URI 或 markers。

## 7. Monaco runtime、worker 与构建

### 7.1 加载边界

主 Agent/chat 启动路径不得静态 import Monaco。只有 desktop/web 的官方 text/code/diff provider
首次真正可见时才加载：

```text
ResourceEditorHost
  -> lazy official text provider
  -> Monaco runtime promise (one per Surface generation)
  -> model registry
  -> editor view
```

移动入口、mini chat、纯设置和没有文件编辑器的 Agent 会话不能预加载 Monaco chunk 或 worker。
生产构建增加 manifest assertion，防止未来静态 import 把 Monaco 拉回首屏。

### 7.2 ESM entrypoints

使用 0.56 的公开 entrypoints：

- `monaco-editor/editor`；
- 官方 editor features 的公开 `register` entrypoints；
- language definitions 的公开 `register` entrypoints；
- 不依赖未版本化的内部实现模块；
- 不 import 会顺带注册全部语言能力的 `monaco-editor` root entrypoint，也不 import
  `editor.main`；
- 初始实现不注册 TypeScript/JavaScript、JSON、CSS、HTML 的 Monaco language *features*。这些
  semantic capability 由 Host-owned `LanguageServicesAPI` 提供；language *definitions* 只负责
  tokenization，不成为第二个 diagnostics/completion authority。

编辑器交互功能不能为了追求一个小数字被随意裁掉。language definition 可以按实际 language ID
动态加载，未知语言诚实回退 plaintext；支持范围来自一个可扩展 registry，而不是硬编码一个很小
的白名单。Phase 1 同时记录 all-definitions 与按需 definitions 的产物/首开数据，再选择实际 bundling
方式。

### 7.3 Worker

`MonacoEnvironment.getWorker` 由一个模块统一注册，使用 Vite module-worker URL。初始实现只注册
editor worker；不得产出或启动 `ts.worker`、`json.worker`、`css.worker`、`html.worker` 等 Monaco
built-in semantic worker。必须验证：

- dev HMR；
- production Web 相对/绝对 base；
- PWA precache 与版本更新；
- Electron `varin-ui://` packaged assets；
- cloud HTTPS 与严格 CSP；
- worker 加载失败显示 editor-local failure，并保留 Document buffer 与恢复/重新加载动作。

Varin 的 Host LSP 不通过 Monaco worker spawn。worker 只承担 Monaco 自身的编辑/本地 tokenization
工作；语言 server 进程继续由 Application Host 管理。

## 8. 主题、设置、命令与按键

### 8.1 单一主题权威

Varin theme token 是唯一主题来源。新增 `createVarinMonacoTheme` 投影：

- editor background/foreground、line number、selection、cursor、inactive selection；
- find match、bracket、indent guide、whitespace、gutter、minimap、overview ruler；
- error/warning/info/hint、diff added/removed/modified、debug current line；
- syntax token rules；
- high-contrast 与用户自定义主题的动态更新。

Theme switch 调用 `defineTheme/setTheme`，不重建 model 或 editor。Monaco 不维护第二份持久化主题
设置。

### 8.2 设置

现有文件编辑设置由统一 editor settings projection 消费，至少包括：

- font family/size/weight/line height/ligatures；
- tab size、insert spaces、detect indentation；
- word wrap、whitespace、line numbers、minimap、sticky scroll、folding；
- auto closing/auto surrounding/format on type/format on save；
- cursor、smooth scrolling、accessibility support；
- `fileEditorKeymap`。

设置缺失使用产品默认；malformed/read failure 保留上次有效值并显示诊断，不把失败当成空设置。

### 8.3 命令与 shortcuts

Varin command registry 是命令 ID 权威。Monaco action 通过 adapter 注册到同一命令层，菜单、
Command Palette 和快捷键不维护第二个互不知情的映射。至少接通 save、save all、find、replace、go
to line/symbol、format、rename、quick fix、definition/references、fold、toggle wrap、toggle minimap、
multi-cursor 和 editor focus group navigation。

用户 shortcut override 高于官方默认；同一按键冲突必须可见。Monaco 自带默认按键作为 editor
上下文内的基础层，不能覆盖用户在 Varin 中显式配置的命令。

当前已持久化的 Vim 设置实际上还没有文件 editor 消费者；迁移不能把这个既有缺口继续带进新的
默认 editor。Phase 1 完成候选 adapter 的源码、依赖与打包审查，Phase 2 把 Vim 在目标 Monaco
版本、IME、search/replace、Varin commands 和 dispose/re-enable 上真实可用列为 desktop/web
cutover 的退出门槛。未通过时不得切换默认文件 renderer。若现成包依赖 Monaco 私有 API，则由
独立 editor behavior extension 包装并固定兼容证据，不让它成为 Core 文档权威。

2026-08-25 的 Phase 1 审查结论：不直接采用 `monaco-vim@0.4.4`。其发布源码仍导入私有
`ShiftCommand`，核心 adapter 使用 `@ts-nocheck` 和旧版数值 option ID，`charCoords` 也没有返回
真实像素坐标。Phase 2 应以现有 `@replit/codemirror-vim` 状态机和 Monaco 0.56 公开 API 建立
Varin-owned adapter，或先修正上述问题并取得可复现的上游版本；不能用 private import 绕过
cutover gate。

## 9. Language intelligence

### 9.1 不直接绕过现有 Host

Monaco 0.56 虽提供 native LSP client/transport API，本阶段不让 renderer 直接连接 language server。
Varin 已有更重要的 Host 语义：workspace trust、provider owner/generation、remote/cloud execution、
typed failure、stale rejection、进程清理和扩展 asset resolution。绕开它会制造第二个 LSP owner。

`MonacoLanguageBridge` 在 renderer 内只做公开类型转换：

```text
Monaco provider request
  -> model binding resolves authoritative DocumentIdentity/revision
  -> RuntimeAPIs.language
  -> Host provider/supervisor
  -> typed result with provider generation + document version
  -> Monaco item/marker/decorations
```

### 9.2 DTO 扩展

先补齐 `LanguageServicesAPI`，再接 Monaco UI。至少需要：

- CompletionItem：kind、range/textEdit、insert/replace range、snippet format、documentation、sort/filter
  text、commit characters、tags、additionalTextEdits、resolve token、command；
- Hover/Signature：plaintext 或 untrusted Markdown、range、active signature/parameter；
- Location/LocationLink：target resource/range/selection range；
- Symbol：kind、container、children、tags、location；
- TextEdit、AnnotatedTextEdit、WorkspaceEdit、documentChanges、resource operations；
- CodeAction：diagnostics、disabled reason、edit、command、resolve token、preferred；
- formatting、semantic tokens、inlay hints、document highlights、folding/selection ranges、links、colors；
- 每个 response 的 provider ID/generation、document version 和 typed absent/stale/failure。

Markdown 一律按不可信内容渲染；URI/commands 经过 Varin opener/command authority，不直接执行任意
scheme。Extension/provider disable 后清除自己的 markers 和 registrations，不影响其他 provider。

### 9.3 WorkspaceEdit

rename、auto-import 和 code action 不能再只返回“哪些位置会改”。新增
`DocumentRegistry.applyWorkspaceEdit`：

1. 解析并加载所有目标 text documents；
2. 校验 workspace、document version、base revision、encoding 和现有 conflict；
3. 在内存中计算全部新 buffer；
4. 全部通过后，以一个 transaction group 原子提交到 Document Registry；
5. 所有文件变为可见 dirty buffer，不在 renderer 中直接写磁盘；
6. 提供 preview、apply、undo group 和逐文件 conflict 结果。

这样跨文件重构不会因第 N 个磁盘写失败留下半套代码。LSP resource create/rename/delete 需要单独的
Host batch mutation/恢复契约；在该契约完成前应返回明确 unsupported，不把多次顺序写伪装成原子
成功。

### 9.4 第一方语言体验

Core 保持 language-neutral，但官方分发应随产品提供可停用、可替换、按需激活的第一方
TypeScript/JavaScript language extension。它通过现有 `defineLanguageProvider` 与 extension asset
path 注册 Host-side server，不在 Web renderer 中 spawn，也不写死进 supervisor。

激活条件是受支持 Surface 上有可见的 JS/TS document；最后一个 owner 消失后按 provider 生命周期
回收。Python、Rust 等沿相同 Varin extension contract 接入。其他第一方 language package 应以
真实用户需求和维护能力增加，不做 Core 白名单。

## 10. Debug、test、Git 与 Agent 协作

- DebugAPI 继续是 breakpoint/session/thread/stack authority；Monaco glyph margin 只是 breakpoint 与
  current instruction 的 view；
- breakpoint mutation 必须带 debug session/workspace identity，stale session decoration 被清除；
- Problems registry 投影为 Monaco markers，按 provider owner 分组；点击问题通过 Workbench command
  打开 resource 和 range；
- test failure 与 stack frame 使用同一 reveal/decorations path，不直接修改 editor state store；
- Git diff 的原始/修改 model 使用稳定、只读、明确 revision 的 model identity；工作区侧仍绑定
  Document Registry live buffer；
- Agent active editor、selection、inline comment 与 attachment 从 Workbench editor context 读取，不
  依赖 Monaco 全局单例；
- Agent patch preview/accept 继续通过 revision-safe transaction，accept 后 model 因 Registry 更新而
  变化；
- 隐藏的 debug/test/Git/Agent editor integration 不保留 rAF、DOM observer 或无消费者 subscription。

## 11. 移动端与嵌入式编辑器

移动端不是降级成另一套产品状态：

- mobile `varin.builtin.text` 使用 document-bound CodeMirror adapter；
- 读取、编辑、保存、冲突、recovery、Agent attachment 和 language DTO 与 desktop/web 相同；
- 移动 adapter 只实现适合触屏的呈现和交互，不承诺 minimap、多列布局或 desktop Vim parity；
- mobile 不下载 Monaco runtime、features、language definitions 或 workers；
- 官方 IDE Profile 继续不声明 mobile 支持；第三方 mobile editor provider 仍可完整替换官方 adapter。

- Phase 4 更新其 DTO/contract fixtures 只是在保持 Runtime parity，不代表给 webview 增加文件编辑器；
- 继续拒绝把 `varin.ide` 或第二套 Settings/Agent Manager/session editor 放回 webview。

聊天 composer、设置 JSON/JSONC、Prompt、命令参数等嵌入式编辑器继续使用适合其交互的轻量
组件。它们可以复用 theme/keybinding 基础，但不注册为 workspace document，不启动 LSP，不进入
Editor Workbench tabs，也不复制文件保存逻辑。

## 12. Varin 扩展自由度

### 12.1 完整替换

现有 `editor` contribution 保持引擎无关。扩展按 language/filename/provider association 选择资源，
通过 `VarinEditorDocumentController` 操作文档，可以使用 Monaco、CodeMirror、Canvas、WASM 或
完全自定义 DOM。官方 Monaco provider 仍使用稳定 ID `varin.builtin.text`，避免用户 association
因内部引擎迁移失效。

### 12.2 增强官方 Monaco

完整替换不等于每个小增强都要重写 editor。Monaco 主路径稳定后，增加一个由官方 text provider
拥有的、Surface-local、versioned optional service，例如 `varin.editor.monaco/v1`。它可以提供：

- active view/model 的只读 identity 与生命周期 signal；
- editor action、context key、keybinding、decoration source、glyph、view zone、content/overlay widget
  的 owner-scoped 注册；
- reveal/selection/focus 等 view action；
- language provider bridge 的扩展注册点；
- deactivate/update 时原子撤销与 leak diagnostics。

该服务不进入 `RuntimeAPIs`，不授权文件或进程能力，也不成为所有 editor provider 必须实现的
Core 接口。扩展必须声明 optional service requirement；官方 Monaco 不活动时得到 truthful absent。
隔离 iframe 使用可序列化的子集，managed/trusted Surface 才能使用 DOM-bound 能力。

公共稳定层不直接暴露可被 dispose 的原始 model/editor 对象。若未来确有高级消费者需要 raw
Monaco handle，应作为单独、明确绑定 Monaco 版本的 authoring package 提供，而不是污染通用
extension SDK。

### 12.3 不混淆两种插件

Pi Package/Pi plugin 继续扩展 Agent runtime；Varin extension 扩展产品与编辑器。语言 server、
editor provider、editor augmentation 属于 Varin extension。不能因为 Monaco 迁移把 Pi plugin
设置、生命周期或私有状态拉进 renderer。

## 13. 性能与可观测性契约

### 13.1 必须成立的结构性约束

- 没有可见文件 editor 时，主 entry 不加载 Monaco；
- 每个 Surface generation 只有一个 Monaco runtime promise 与全局 provider registration owner；
- 每个 Document record 最多一个 Monaco model；多个 view 不复制正文；
- 每次输入只通知该 document/model/language queue，不触发 broad Zustand/React tree；
- inactive editor DOM 不保活，hidden surface 无 ResizeObserver/rAF/viewport work；
- warm tab/Profile 切换不重新读取文件、不重新创建 model、不重启 language server；
- provider/runtime/workspace dispose 后 model、markers、listeners、worker references 可追踪归零；
- worker 或 LSP failure 保留 buffer，并在局部显示失败与 retry，不使整个 Shell 崩溃。

### 13.2 测量而不是猜限制

Phase 1 建立以下 performance marks 和诊断计数：

- `editor.runtime.import.start/end`、`editor.worker.created`、`editor.model.ready`、`editor.first.paint`；
- cold first file open、warm tab switch、Agent ↔ IDE remount；
- input-to-paint 与长任务；
- model/view/character/marker/provider/worker 数量；
- emitted Monaco chunks、首屏 preload graph、worker transfer size；
- Web 与 packaged Electron 分开记录。

在得到本项目的 Web/Electron baseline 前，不编造一个过小的毫秒、行数、文件大小或 model 数量硬
上限。验收先使用可判定的不变量：无首屏 import、无每键 broad render、无 warm reload、无 hidden
work、无 owner leak。真实数据再决定警告、按需关闭昂贵 feature 或内存压力回收；正文读取/保存
能力不因语法/semantic feature 降级而被一并禁止。

## 14. 交付与历史测量

desktop/Web 已使用官方 Monaco 路径，mobile/embedded 保留各自 CodeMirror adapter。
当前实现分别由 [Monaco 模块](../../packages/ui/src/lib/monaco/DOCUMENTATION.md)、
[Document Registry](../../packages/ui/src/lib/documents/DOCUMENTATION.md)和
[Editor Workbench](../../packages/ui/src/lib/workbench/editors/DOCUMENTATION.md)说明。
已完成的逐阶段任务表不再作为重复实施计划；当前验证选择按实际改动风险确定。

以下保留引擎切换时的独有测量，**不是当前提交重新运行的结果，也不是性能门槛**：

- 2026-08-25，Windows packaged Electron 的 50,000 行、1,627,779 字符样本：CodeMirror 的
  model/首绘/编辑到绘制为 4.9/19.9/10.9 ms，Monaco 为 14.6/26.6/8.6 ms；当时 Monaco chunk
  为 3,848.70 kB（gzip 995.25 kB），不进入首屏
- 2026-08-26，Windows 11 x64 最终构建：Monaco chunk 4,278,374 bytes，editor worker
  272,811 bytes，semantic worker 0；普通三个入口没有直接预加载 Monaco
- 同轮 packaged Electron 样本：cold runtime 211.9 ms、model 12.3 ms、first paint 82.3 ms、
  edit-to-paint 9.2 ms；同 model 的 warm view 为 28.6/2.6 ms。created/disposed model 均为 1，
  editor worker 1，unexpected worker request 0
- 同轮 Web/PWA、Electron worker/diff/dispose 与 Windows 包路径有运行记录；mobile HTML 可挂载且不加载
  Monaco。没有 iOS Simulator、Android SDK/真机 touch journey 或 hosted-cloud 手工旅程证据，不能从
  Windows 结果推断这些平台通过

迁移期 CodeMirror/Monaco 对照夹具已退役；现有 smoke 记录 Monaco cold/warm 与 model 生命周期。
旧测试数量、文档页数和构建产物大小都不作为必须复现的固定契约。

## 15. 迁移与失败处理

- desktop/web official text provider 只有 Monaco；不保留运行时“失败就退回
  CodeMirror”的长期双实现。Monaco 加载失败显示局部 failure、retry、open externally 与恢复入口；
  文档 buffer 不丢；
- mobile/embedded CodeMirror 是明确的不同 Surface/用途 adapter，不是 desktop 兼容层；
- provider view-state schema 迁移失败只重置 view state；
- language DTO 变更同步更新 Host、Web、UI 和实际 fixture 消费者，不恢复退休的 VS Code companion；
- first-party language extension failure 不使基础 editor 不可用；
- dependency、worker 或 package 回滚沿 Git 和发行产物，不在产品中堆积内部双协议；
- 任何未实现能力返回明确 absent/unsupported/failed，不做空数组、空字符串或无效按钮的假成功。

## 16. 明确不做

- 不 fork Code OSS；
- 不运行 VS Code extension host；
- 不把 Monaco model 变成文件或 dirty 权威；
- 不让 renderer spawn LSP/DAP/task；
- 不把 raw filesystem path、token 或 server command 放入可见日志/URL；
- 不为 Monaco 新建第二个 Varin contribution registry；
- 不要求第三方 editor provider 使用 Monaco；
- 不用固定 5,000 行、固定 model 数或猜测性的文件大小限制替代测量与分级 feature 降级；
- 不在本计划中把所有聊天、设置和资源小编辑器强行改成 Monaco；
- 不把 Pi package 生命周期并入 Varin editor extension。
