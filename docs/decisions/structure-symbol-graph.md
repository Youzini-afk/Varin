# 决策分卷：结构与符号图

范围：3.1/3.8/3.11/3.12 符号图采集与验收、tree-sitter 结构切片、语法 wasm、LSP 导航。

本卷是 [decisions/README.md](README.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-051 · 2026-09-04 · 3.8（LSP 导航接入真实 LanguageSupervisor）

类型：实现澄清

决定：新增 `lsp.symbols/definition/references/hover` typed Host methods 与同名 pi-host 工具，由 handshake
`harnessLspNavigation` 在 AgentSession 构造前统一开关。所有文件路径先过 Router/Documents authority 与 child scope；Host 使用
authority 给出的 workspace-relative resourceId。未同步文件只在 LanguageSupervisor 尚无 desired document 时从 Documents 读取并
`didOpen`；已有编辑器 buffer 绝不被磁盘内容覆盖。请求携当前 documentVersion，agent 参数 line/character 为一基，进入 LSP 前
转零基，输出位置再转一基。`symbols` 要求代表文件 path 来确定语言 provider。三态保持 ready/empty/unavailable。

原因：旧 `lsp-nav.ts` 是自成一套的假依赖接口，没有生产调用点，也没有适配真实 Supervisor 的 status/value、documentVersion 与
buffer ownership；直接给它补 pi-host 工具仍会是休眠实现。真实 fixture 进程测试还暴露了不携版本会被 Supervisor 正确判 stale。

影响：protocol HarnessServiceMap/handshake；Host router/path authority、LanguageSupervisor 与 nav adapter；pi-host tools/能力门；
工具卡摘要；设计/plan/status 3.8。

状态：已实施

### D-059 · 2026-09-04 · 3.1（Documents 驱动的真实 file/symbol/defines 图）

类型：设计修正

决定：(1) 删除旧 collector 的伪实现：不再用 `event` 节点冒充 file/symbol，不再用 `edgesCreated++` 冒充图边，也不保留无依据的
`maxFiles=200`。(2) KnowledgeStore 新增真实 `file` / `symbol` payload 与 `defines` edge 原语。单文件替换先 batch insert
`active:false` 新符号，再用 TriviumDB `commitTransaction` 同批更新 file generation、删旧符号、激活新符号并建边；崩溃窗口最多留下
不可检索的 inactive staging，下次替换回收。(3) Documents 权威写后 observation 是唯一触发：created/modified 按 path 串行，deleted
删 file graph；不做启动时全仓扫描或额外 watcher。未知语言只 touch file；LSP unavailable 保留最后已知 symbols，`ready + []` 才是
权威清空。(4) 若 LanguageSupervisor 已有 document buffer，直接用其 version，绝不以磁盘覆盖；尚未同步才从 Documents 读取并 open。
(5) workspace store 暴露关键词 symbol search 与按 file 读取真实 defines edge；`user.tdb` 拒绝 file/symbol 写。(6) embedding recall 同批
修正为只返回 accepted、未失效的 knowledge，图节点或 suggested/dismissed 不能混进长期记忆。(7) references/calls/imports 边尚未接；
不能为每个 symbol 无界扇出 references 请求，需在 LSP 能力与实际文件分布上定批处理/背压后单独实现。
Store 打开时一次建立 path→file/symbol ids 的内存索引，后续写后替换不遍历全部 event/knowledge 历史；只有显式 symbol search 扫描
当前 active symbol 集。

原因：旧代码只有看似完整的接口和计数器，接生产会把“采集成功”写成假事实；固定前 200 个 Git 文件还会因排序偶然性永久漏图。
写后单文件替换只为真实变化付费，且沿现有 Documents/LSP 权威边界，不新增扫描成本。

影响：KnowledgeStore graph contract、`symbols.ts`、`symbol-runtime.ts`、Documents mutation fan-out、Application Host lifecycle、user store；
设计 6.2 / 7.2，plan/status 3.1。

状态：已实施并 proven（file/symbol/defines）；跨文件 references/calls/imports 未实施

### D-087 · 2026-09-06 · 3.8 / 3.1（语言服务视图隔离与正文修订绑定）

类型：实现决策（D-082 固定来源的语言服务纵切；含协议与符号图 schema 变更）

决定：`LanguageSupervisor` 的会话键从 `(workspaceId, languageId)` 扩为 `(workspaceId, languageId, viewId)`。`surface` 视图由 UI 独占，
沿用现有 `localEditRevision` 语义与生产行为，renderer 请求不能选择别的视图，事件流也只投递该视图。`agent` 视图由 Application Host
独占，每个文档单独绑定到一个命名的正文身份：导航工具用 D-082 的 `AgentInputContext`（脏路径取 `readAgentInputSnapshot` 的固定草稿，
其余取磁盘），符号采集与诊断只取磁盘。同一视图内两类需求对同一文档冲突时，由修订断言分出胜负——导航重绑一次后重试，采集直接放弃
并保留上一张图，不循环。

agent 视图惰性创建：首次发生 agent 查询或符号采集时才为该语言起进程，空闲超时、`disposeWorkspace` 与 `dispose` 释放它，进程数、
开文档数与空闲时长由 `inspectViews()` 报告。**代价如实记账**：只有一侧活动时仍是一个进程，编辑器与 agent 同时活动才是两个；不常驻
第二套服务器，也不为省内存改回单会话逐次重同步。

文档版本号由 Host 按 (视图, 资源) 自行单调分配，不再与编辑器 `localEditRevision` 共用命名空间；**内容身份**单独携带——固定草稿为
`surface-draft:<ref>:<localEditRevision>`，磁盘为 Documents `revision`。绑定到同一身份时不再发通知、不推进版本。每个 agent 侧结果
声明它实际使用的修订与来源（`disk | surface-draft`）。被查询文档是精确绑定，请求前后都断言该修订，不符即 `stale`；跨文件位置由语言
服务器自己读盘计算，LSP 不报告它使用的版本，因此这些位置一律标为 `unpinned` 并说明原因，不给它们编造修订，也不冒充已绑定。

每个视图拥有自己打开的文档：`surface` 关闭最后一个标签页不再销毁其他视图，agent 视图在回合结束、会话结束或空闲时关闭文档并设开
文档上限，provider 重注册与 restart 只影响本视图。现有 harness 与符号采集只开不关、`desiredDocuments` 单向增长并在服务器重启时全量
重放 `didOpen` 的行为一并修掉。语言身份收敛为 Host 单一解析器（含扩展贡献），harness 与 UI 不再各持一张扩展名表：`.mts/.cts/.mjs/.cjs`
在 agent 侧不再判为 unsupported，`.sh` 不再因 `shellscript`/`shell` 分裂成两个会话。

符号图按用户选择只绑磁盘：`replaceFileSymbols` 要求并记录该文件的 document revision，空修订被拒；旧行缺该字段时读作 `null`（unknown），
可被下一次采集替换，无需数据迁移。脏缓冲算出的范围不入图——采集不再"已同步就沿用别人的正文"，每次都绑定磁盘正文，代价是每次采集
一次 Documents 读取。`explore` 的结构展开只使用带修订且与当前正文一致的范围，不一致时退回行窗口并说明来源状态。
`lsp.symbols/definition/references/hover` 与 `lsp.diagnostics` 的结果一并带修订与来源；诊断适配器按规范化 resourceId 精确查找，删除现有
`endsWith` 双向后缀匹配（`src/lib/a.ts` 会被 `a.ts` 命中）。

**诊断读磁盘。** `lsp.diagnostics` 绑定该路径的当前磁盘正文并等待针对同一修订的发布（默认 5 s，权威空列表就是 clean），超时为
`pending`。理由是它是"刚写完的反馈"，必须描述 agent 自己写上磁盘的正文；导航则跟随本轮固定来源以便与 `read`/`grep` 对齐。两者各自
声明来源，不混。按 D-085 的先例，公开但无生产调用方的 `lsp.diagnostics.afterSnapshot` 参数与其驱动的 provider `syncDocument` 一并从
协议和 provider 契约删除——版本命名空间冲突的唯一可达路径随之消失。

边界与事实更正：`syncedDocumentVersion + 1` 的版本冲突只在调用方传 `afterSnapshot` 时可达，此前没有生产调用方，因此那是潜在故障而非
已发生的用户故障，本决定按结构消除，不声称修复了正在发生的问题。已可复现的是另外两条：文件在编辑器里脏时 agent 的 `lsp.*` 与符号
采集读到未保存缓冲，而同一回合的 `read`/`grep` 按 D-085 给固定草稿；UI 在 agent 查询之间同步一次就让该查询返回 `unavailable`。
**跨文件位置不做 stale 判定**：可用的只有 Documents mutation 观察，而它不覆盖 Pi 原生 `write`/`edit`（不经 Documents authority），在不
完整的信号上标"未变化"等于伪造事实，因此只标 `unpinned`。隔离线程今天已因 `resolveRuntimeWorkspaceId(cwd)` 取得自己的 workspaceId
而拥有独立会话，即每个运行中线程一个语言服务器进程；本切片只度量并说明该成本，进程复用不在范围内。语言身份表是 Host 静态表，
renderer 在运行时由编辑器注册表贡献的语言仍然只在 renderer 可见，agent 侧对它们明确不可用。

原因：三个写者共用一条会话，正文由最后一个写者决定，而版本号是编辑器的计数器。于是 agent 的符号范围取决于用户当时有没有打开该文件、
有没有在打字，跨回合也无法归因到任何一份可取得的正文。在这种结构上只补一个 revision 字段，等于给来源不明的正文贴标签，并让下游开始
信它；隔离视图加内容绑定才让"这些范围来自哪份正文"成为可回答的问题。

考虑过的替代：给草稿文件另一套影子 URI——模块身份改变，import 解析与 references 失真；为父会话每回合物化整个工作区——正是 D-078/D-083
拒绝的普通消息全仓成本；单会话每次查询前重新同步——与编辑器互相覆盖并抬高延迟，等于把当前故障做成机制；始终双进程——内存占用最高
且常见情况没有收益。

影响：`lib/lsp/supervisor.ts`（视图键、版本分配、生命周期）、`lib/lsp/routes.ts`、UI `language-services/session.ts`；
`lib/harness/lsp-nav.ts`、`diagnostics-adapter.ts`、`diagnostics-service.ts`、`lib/knowledge/symbol-runtime.ts` / `symbols.ts` / `store.ts`
（符号 schema 与迁移）、`lib/harness/language-id.ts` 与 UI `language-services/language-id.ts` 合并；protocol `LspNavigationResult` /
`DiagnosticsResult` 增加修订与来源；设计 5.0/6.1/6.2/6.4、plan 0.7/3.1/3.2/3.8、status 3.1/3.2/3.8 与相关模块文档。

状态：已实施；生产接线与验证见 status 3.1/3.2/3.8。

### D-091 · 2026-09-06 · 3.11（结构来源 provider 与 tree-sitter 语法包）

类型：设计决定（解决 D-090 的 tree-sitter 待决项；用户已决定捆绑范围与首刀语言）

决定：引入 tree-sitter 作为 Application Host 的第二个结构来源，与语言服务器**长期共存、不替代**。两者回答不同问题：语言服务器回答
"这个名字指什么"（定义、引用、类型、诊断），tree-sitter 回答"这段文字的形状是什么"（函数边界、命中所在的语法块、字面量与注释、
带字面量的调用形状、import）。它给不了类型、跨文件解析与诊断。

消费者按对现有缺口的直接程度排：explore 结构切片（不等语言服务器起进程）；**命中分类**——6.1 fuse 段"名称、路径、注释、字符串和
函数正文不按同一方式计分"要落地，必须知道命中在哪类节点里，rg 只知道"这一行有这个词"；**连接边识别**——`bridge.request("…")`、
`router.register("…")`、`on("…")` 等调用 + 字面量形状，查询几行可稳定抓出，正则不稳；**冷仓库符号目录**——喂进 6.2 现有
`file → defines → symbol` 图，名字/种类/范围与 `documentRevision` 绑定同一形状；`imports` 边；线程与压缩用的仓库地图。

实施形状：
- 在 Application Host，不进 renderer。编辑器（Monaco、移动端 CodeMirror）各有自己的解析器，不为高亮再加一套；宿主是所有客户端
  共用的，装一次全部受益。
- 用 wasm 版（web-tree-sitter），不用原生绑定。原生版需按平台与 Electron ABI 各编译一份，打包与升级都是负担；wasm 版 Node 到处
  可跑、解析仍是毫秒级，代价只是打包时 `.wasm` 要放在可读位置。
- 语言身份复用 D-087 的 `languageIdForPath`：语法包按同一规范 ID 索引，与语言服务器视图同一把钥匙，不再多一套扩展名映射。
- 解析结果按内容哈希缓存。D-082 的快照存储本来就是内容寻址的：同一正文只解析一次，多次查询与不同线程复用；授权与来源仍每次核验，
  缓存命中不跳过。
- **先定接口。** 结构来源是带修订绑定的可插拔 provider：输入语言 ID、正文、修订；输出符号轮廓（名字/种类/范围）、命中节点分类、
  带字面量的调用、import；能力标志声明本 provider 能给哪些。第一个实现是 6.4 agent 视图的 `documentSymbol`，第二个是 tree-sitter；
  explore 只认接口。定接口这一步不需要新依赖。

语法包：一个可用的包 = 语法 wasm + Piarium 按用途写的查询（定义、带字面量调用、import；字面量与注释由节点种类直接给出）。语法
wasm 用社区现成构建；查询是 Piarium 自己的工作，可从 Aider / nvim-treesitter 的 Apache 2.0 查询改起并注明来源。**因此每种语言的
成本主要在查询，不在字节。** 包由 Piarium 精选、随应用版本锁定 ABI；语法 wasm 与运行时 ABI 不匹配会直接加载失败，所以第一版不接受
任意第三方语法包——用户看到的只会是"装了没用"。

分发：桌面版随应用**捆绑最常用语言**，首批 TS/TSX/JS/JSON（合计个位数 MB），其余按需下载到数据目录，与"本地 embedding 模型选装
下载"同一套同意提示与下载管理；Web/远程部署由宿主下载，同意方式与其他下载一致。**目标是覆盖大部分常用语言**（Python、Go、Rust、
Java、C/C++、C#、Kotlin/Swift、Ruby/PHP、Shell、HTML/CSS、YAML/TOML、Markdown 等），按用户工作区实际出现的语言排优先级，每种语言
一个包一次交付，覆盖进度记在 status。用户自带包留作后续高级选项，带 ABI 校验与明确提示；wasm 在沙箱内运行，风险是卡死或吃内存而非
越权，与其他解析同样受工作预算与取消约束。

UI：设置里"语言支持"页，按工作区实际检测到的语言列出，每种语言两行状态——语言服务器（已有 LSP 配置）与结构包（已装 / 可装 / 暂无），
用户不用面对一百种语言的清单。**第一刀不做包管理器**：只有一种语言时不存在"选"；语言 ≥ 3 种时再做按需下载与设置页。

顺序（接在 D-090 之后）：
1. D-090 第一组：候选获取与物化修正 + `anchors`。
2. 结构来源接口 + LSP `documentSymbol` 实现，explore 切片消费它。无新依赖。
3. 引入 web-tree-sitter + TS/TSX 包作为第二个 provider，同时接命中分类；此步引入依赖与打包路径。准入：第 2 步接口稳定；在本仓库量过
   一次 agent 视图从冷启动到 `documentSymbol` 可用的时间，作为对照基线——记录"好了多少"，不再决定"要不要做"。
4. 连接边查询；冷仓库符号目录喂进符号图；`imports` 边。
5. 语言 ≥ 3 时做按需下载与设置页；之后按工作区语言分布逐个补包。

不做：把 tree-sitter 当"通用 AST 服务"先建完再找消费者——每个消费者是独立工作，接口只承诺已有实现的能力；不替代语言服务器的导航与
诊断；不在 renderer 引入；第一版不接受任意第三方语法包；不声称解析速度或省时数字，实测记 status。

原因：D-090 把它记为待决是因为当时只看到一个消费者、没有冷启动实测。再核对后消费者不止四个，新增命中分类与 `imports` 边，其中
命中分类、连接边、冷仓库目录三项语言服务器给不了，"让 LSP 常驻"只解决冷启动这一项。用户判断"迟早要引入"并确定捆绑与首刀范围。
把决定提前到现在，是为了让第 2 步的接口从一开始就按两个实现设计，避免 explore 切片写死在 LSP 上再返工。

考虑过的替代：原生绑定——更快但平台/Electron ABI 各编一份；全部按需下载——首次使用要等，且 Piarium 自己的 TS 仓库是验证基线，
捆绑最常用几种更稳；任意第三方语法包——ABI 与查询缺失导致"装了没用"，留作高级选项；先做包管理器 UI——一种语言时无可选，是投机性建设。

影响：agent-harness 2（结构来源行）、6.1 fuse/slice 段、6.2、D-078 收口表；plan 0.7、3.2、新增 3.11；status 新增 3.11 行；D-090 索引行
的 tree-sitter 待决改由本条解决。实施待接：Host 结构来源接口与两个 provider、explore 切片消费、web-tree-sitter 依赖与 TS/TSX 包、
打包路径、后续语言包与设置页。

状态：已决定；实施按上述顺序在 D-090 第一组之后开始。

### D-093 · 2026-09-07 · 3.11（小函数 / 大函数切片阈值）

类型：实施拍板

背景：plan 3.11 / D-090 要求小函数全文、大函数签名 + 命中块 + 省略标记 + 完整读取入口，但没有给出「小 / 大」的行数。需要一个具名常量，不能把魔数散在切片里。

决定：`SMALL_STRUCTURE_SPAN_LINES = 24`（含首尾的行数）。依据是一个常见编辑器视口大约能看完的短函数加几行局部变量；超过则按大函数切片。这是工作阈值，不是硬拒绝，也不是测过的产品上限。

不改：不按字符数、AST 深度或「300 字符并入邻居」切；不把阈值做成用户设置；不声称这个数字优化了召回或省时。

影响：`lib/structure/constants.ts`；explore 结构切片；D-091 实施。

状态：已实施。

### D-094 · 2026-09-07 · 3.11（结构切片的协议字段）

类型：实施拍板

背景：`ExploreSearchSnippet` 只有 path/行号/text/why/revision/source。语法单元和结构来源状态若塞进 `why` 或未声明字段，会重复 D-092 修过的漏字段问题；worker—protocol—Host 链也无法在一次 `explore.search` 结果里看见切片契约。

决定：在协议层显式加字段，不另开方法：
- `ExploreSearchSnippet.unit?`：`{ name, kind, startLine, endLine, omitted? }`，行号与 explore 一样是 1-based 闭区间；`omitted` 只出现在大函数。
- `ExploreSearchSnippet.structure?`：`{ provider: "lsp" | "tree-sitter" | null, status }`，status 含 `ready|empty|unavailable|unsupported|stale|failed|cancelled|not-requested`。
- `details.structure.files[]`：按文件记录本次咨询过的 provider/status，让一次工具结果能看见来源，而不只是摘录正文。
LSP 范围是 0-based，转换在 Host 结构模块完成，协议不暴露 0-based。未咨询结构来源时这些字段缺席，避免把「没接线」伪装成「已请求」。

不改：不把结构信息只写在 `why` 或可见文本里；不新增 `explore.symbols` 工具；不在协议里放 AST 节点或 wasm 细节。

影响：`protocol/src/harness.ts`；explore 引擎与 `explore-service`；pi-host 工具 details 原样转发 snippets。

状态：已实施。

### D-095 · 2026-09-07 · 3.11（命中分类只作用在已物化文件）

类型：实施拍板

背景：6.1 fuse 段要求名称 / 路径 / 注释 / 字符串 / 正文不同计分，但候选排序发生在 `readFile` 之前，分类需要正文。把分类前推到读文件之前，就要解析本来不会读的文件；候选预算是 200 个文件，不允许为此解析整个候选池，也不许悄悄放大预算。

决定：分类只作用在已经物化的窗口上——`windowScore` / `packComplementary` / 最终摘录顺序。候选文件排序仍只用词组与锚点权重。已物化窗口上，声明名字 +30、正文 +8、字符串 −4、注释 −10（`STRUCTURE_HIT_CLASS_SCORE`）。未读候选保持 `not-requested`，不解析。

不改：不把分类前推到 `readFile` 之前；不提高 200 文件候选预算或物化读预算来换分类覆盖；不把 hit class 塞进协议 `why`。

影响：`lib/structure/constants.ts`；explore `windowScore`；tree-sitter `classifyHits`。

状态：已实施。

### D-096 · 2026-09-07 · 3.11（语法 wasm 打包与 ASAR 路径）

类型：实施拍板

背景：web-tree-sitter 与 TS/TSX 语法 wasm 必须在 Electron 与 Web 宿主都能读到。另写一套路径解析会和 `extension-builtins` 的 asar / asar.unpacked 重映射分叉。`tree-sitter-wasms@0.1.13` 的预编译文件没有 `dylink.0`，`Language.load` 在 web-tree-sitter 0.27 上失败。

决定：运行时资产放在 `lib/structure/runtime/`，由 `copy-structure-runtime.mjs` 在 Host 编译前刷新，并随 Host 非 TS 资源拷进 `server/`。路径解析复用与 `extension-builtins` 相同的 `ASAR_DIRECTORY_SEGMENT` → `.asar.unpacked` 重映射，不另发明。`web-tree-sitter.wasm` 来自钉住的 `web-tree-sitter@0.27.0`；TS/TSX 语法 wasm 来自钉住的 `tree-sitter-typescript@0.23.2` 发布包（ABI 14，兼容 0.27 的 13–15）。加载失败报 provider `unavailable`。许可与出处按 `LICENSE.typescript` 先例放在同一 runtime 目录。

不改：不把整个 `tree-sitter-wasms` 语言包当运行时依赖；不在 renderer 加载 wasm；不在缓存命中时跳过路径核验；不声称解析速度。

影响：`packages/web` 依赖与 copy/build 脚本；`lib/structure/runtime-path.ts`；D-091 第 3 步。

状态：已实施。

### D-097 · 2026-09-07 · 3.11（结构 provider 顺序：tree-sitter 先于 LSP）

类型：实施拍板

背景：语言服务器冷态时仍要能切出语法单元（与第 2 步 833ms 对照），但 wasm 加载失败时 explore 不能整体挂掉。需要一条固定的 fan-out 顺序，而不是按文件临时挑选。

决定：生产 `structureSource` 先 tree-sitter、后 LSP。`createStructureSource` 对每个文件按这个顺序问 outline；第一个 `ready`/`empty` 获胜，`unavailable`/`failed`/`unsupported` 试下一个。tree-sitter 给出切片时不再等 LSP；两者都不可用时退行 ±3 窗口并标明来源状态。

不改：不删 ±3 降级；不在 wasm 失败时让工具失败；不把连接边 / `imports` 图写进本步（第 4 步）。

影响：`application-host/index.ts`；`lib/structure/source.ts`；explore 切片。

状态：已实施。

### D-098 · 2026-09-07 · 3.11（切片单位是容器，不是最小语法捕获）

类型：问题与解法

背景：验收实测同一 63 行函数只改命中位置：`const needle = 1` 切成 1 行 `variable`，比旧 ±3 窗口更差；`handle(needle)` 才切到外层函数。成因是 `TYPESCRIPT_DEFINITION_QUERY` 把每个 `lexical_declaration` 标成 `@unit`，`enclosingSymbol` 取最小包含范围。同一问题也出现在 interface 成员、`method_signature`、字段、单行 type alias、enum 成员上。

决定：切片只认**容器**（function / method / constructor / class / interface / enum / module / namespace / type / struct / package）。tree-sitter 仍捕获 lexical / var / 字段以便分类，但只有初始化器是函数/箭头/类表达式时才作为单元发出，且 kind 是 `function` / `class`。`enclosingSliceSymbol` 忽略非容器。单行 type alias 仍是容器（它就是整条定义）。D-093 的 24 行阈值不改。

原因：读者必须能判断命中属于哪个函数/类；定义绑定必须继续单独切开，不能整条删掉 lexical 查询。按 kind 过滤比「给小单元并入 ±3」更连贯——后者会把 `const foo = () => {}` 与外层函数糊在一起，或让 1 行 interface 签名看起来像自包含单元。

考虑过的替代：(1) 只在初始化器是函数/类时认 lexical 为单元、切片仍取最小范围——能修 const，但 LSP 仍可能发出 1 行 `method` / `variable`，同一缺陷换来源还会出现。(2) 小单元与外层签名或 ±3 取并——残留「单位就是那个绑定」，status 仍超报，且定义绑定与值绑定要两套下限。(3) 把 `enclosingSymbol` 改成「最小定义型单元」却继续把值绑定当定义——只换名字。

不改：24 行阈值；命中分类分值；JS/JSX 作为目标语言。

影响：`lib/structure/kinds.ts` / `slice.ts` / `tree-sitter-provider.ts` / `queries.ts`；explore 结构切片；agent-harness 6.1 slice、plan 3.2/3.11、status 3.11。

状态：已实施。

### D-099 · 2026-09-07 · 3.11（empty / 覆盖缺口可问后续，但 warmOnly 不冷启动 LSP）

类型：问题与解法

背景：`createStructureSource` 在第一个 `ready` **或 `empty`** 时返回。tree-sitter 对 `var zeta = 1`、`declare function` 等形状会 `empty` 或部分轮廓（namespace 只有内层 `z`）。配合 D-097 的 tree-sitter 优先，阶段 1 的 LSP outline 在这些形状上永不被问，explore 静默退窗口。D-097 把 tree-sitter 放前面正是为了避开 833ms 冷启动；「empty 就问 LSP」会把它请回来。

决定：第一个覆盖全部 `hitLines` 的 `ready` 立即获胜。`empty`、或 `ready` 但有命中落在任何容器外，设置 `priorAnswered` 并以 `warmOnly: true` 问下一个。第一个 provider 的 `unavailable`（缺 wasm）仍允许冷启动。LSP 在 `warmOnly` 下先 `getStatus(workspaceId, languageId, AGENT_LANGUAGE_VIEW)`；不是 `ready`/`degraded` 就返回 `unavailable`，不 `bind`。explore 把证据行传进 `outline`。后续 `ready` **替换**前答，不合并。容器规则（D-098）阻止 LSP 的 1 行 variable 再变成切片单位。顺带扩查询：`variable_declaration`、`function_signature`、`internal_module`/`module`、匿名 `export default class {}`、object-literal `method_definition`；箭头与 `export default function` 实测本来就能出轮廓，之前自评的缺口记错了。

代价：热 LSP 会话上，tree-sitter `empty`/缺口会多一次 `documentSymbols`；冷会话付出的是一次 `getStatus`（不拉起进程）。不阻塞 explore：未就绪就窗口降级。

考虑过的替代：(1) empty 无条件问 LSP——把 833ms 请回每次 explore。(2) 合并两个 outline——需要冲突规则，且会把 LSP 的 1 行成员和 tree-sitter 容器叠在一起。(3) 云端/缺 wasm 才问 LSP——修不了「ready 但有缺口」。

不改：D-097 的生产顺序；不在 renderer 起解析；不把连接边写入本步。

影响：`lib/structure/source.ts` / `types.ts` / `lsp-provider.ts` / `queries.ts`；`explore.ts` 传 `hitLines`。

状态：已实施。

### D-100 · 2026-09-07 · 3.11（云运行时把 web-tree-sitter 当生产能力）

类型：默认值调整

背景：`web-tree-sitter` 在 `packages/web` 的生产依赖里，云镜像构建 `packages/web` 并以其 CLI 为入口，但 `scripts/cloud-runtime.bun.lock` 未锁上它，冒烟 `require` 清单也只有 `better-sqlite3` / `node-pty` / `sherpa-onnx-node`。云部署里 tree-sitter 会是 `unavailable`，只能走 LSP/窗口。

决定：按既有 `--update-lock` 重生成 lock，并把 `require.resolve('web-tree-sitter')` 加入云运行时冒烟。缺依赖必须被构建抓住，而不是运行期才发现 explore 只能降级。

考虑过的替代：明确让云端 explore 走 LSP/窗口、不锁 wasm——省 lock 体积，但云与桌面生产能力分叉，且 D-097 的第一来源在云上永久 `unavailable`。

影响：`scripts/cloud-runtime.bun.lock`；`scripts/build-cloud-runtime.mjs`；`scripts/cloud-runtime-layout.test.js`。

状态：已实施。

### D-101 · 2026-09-07 · 3.11（语法 wasm 以 git 为事实来源）

类型：问题与解法

背景：D-096 记了 wasm 存放位置与 ASAR 重映射，没有记「约 3 MB 二进制 vendor 进 git」这个取舍。`.gitignore` 不排除 `lib/structure/runtime/*.wasm`。`copy-structure-runtime.mjs` 的 `copyIfNeeded` 在目标已存在且 >1024 字节时跳过，所以正常检出下脚本是 no-op，只有 `--force` 才从 npm 包刷新。

决定：接受把 `web-tree-sitter.wasm` 与 TS/TSX grammar wasm 检入仓库。git 是检出后的事实来源；copy 脚本是升级 web-tree-sitter / tree-sitter-typescript 时的刷新工具，不是每次构建的下载步骤。不把「脚本会在缺文件时补上」写成日常路径——新鲜 clone 若缺文件，应视为 git 内容缺失。

原因：wasm 必须在 Electron/Web/云构建里不依赖开发机的 `tree-sitter-typescript` 解析结果；grammar 包是 `devDependency`，生产安装不会带它。检入二进制避免每个环境重跑 copy，并让 ASAR 解包路径稳定。

考虑过的替代：(1) gitignore wasm、构建必跑 copy——云/CI 必须装 `tree-sitter-typescript`，与「语法 wasm 随 Host 走」不一致。(2) 运行期从 npm 解包——多一套失败模式，且 Electron asar 仍要带文件。

不改：D-096 正文（路径与 ABI 选择仍有效）；不声称体积或加载时间。

影响：决策索引中 D-096 的补充说明；`lib/structure/DOCUMENTATION.md`。

状态：已实施。

### D-102 · 2026-09-07 · 3.11（解析预算是跑飞兜底；签名即全体的单元补齐窗口）

类型：问题与解法

背景：D-098 / D-099 验收复跑暴露两件事。其一，`packages/web` 完整套件里 `tree-sitter-provider.native.test.ts`「outlines TypeScript units from the vendored wasm」与 `explore.native.test.ts`「keeps a value-binding hit inside its enclosing function」失败，单独跑同样两个文件 44/44 通过；失败时收到的状态是 `failed`，而那条路径上 `failed` 只由 `STRUCTURE_PARSE_BUDGET_MS` 产生——40ms 挂钟在满载 runner 上被调度延迟吃掉。其二，D-098 只按 kind 认容器，而 `documentSymbol` 把接口调用签名报成 `method`，所以最小容器可以是一行：命中该行时切出 19 字节的 `  needle(): string;`，比它替换掉的 ±3 窗口（145 字节 / 7 行）更少，而 status 3.11 已经写下「至少不差于 ±3」。

决定：(1) 预算定位为跑飞文件的兜底闸，不是延迟目标，默认值上调到 250ms 并在常量注释里写明理由；断言真实解析或断言预算耗尽的测试都自带预算，不继承生产值。(2) 单元的签名范围覆盖整个单元范围时，视为没有自己函数体的片段，按每个命中的 ±3 窗口取并补齐；有函数体的单元仍精确输出。

原因：挂钟预算与 CPU 争抢共享同一个时钟，贴着普通文件解析时间设值会让能力变成负载相关，且降级是静默的（`failed` → 窗口，不是错答案），最难发现。判据用「签名是否即全体」而不是跨度或 kind 表：它对 provider 无关，能同时接住 LSP 的一行 `method`、ambient 声明和单行定义，又不会把自包含的小定义（嵌套 3 行箭头函数）撑宽成外层噪声。

考虑过的替代：(1) 对所有小单元与 ±3 窗口取并——会把 `const foo = () => {}` 这类完整定义也拉进外层签名和右括号，抹掉结构切片相对窗口的全部收益，并推翻已验收的嵌套单元断言。(2) 跨度阈值（容器 ≤ N 行就跳过）——会跳过大函数里真正有用的小嵌套函数。(3) 只扩容器 kind 黑名单——要逐 provider 追 kind 表，且 `method` 既是真方法也是接口签名，无法只靠 kind 区分。(4) 把预算改成按字节相对计算——仍要挑系数，本刀不需要。

不改：`SMALL_STRUCTURE_SPAN_LINES`（24，D-093）；`STRUCTURE_HIT_CLASS_SCORE`（D-095）；容器 kind 集合（D-098）；provider 顺序与 `warmOnly` 契约（D-097 / D-099）。不声称解析耗时或省时比例。

影响：`lib/structure/constants.ts`；`lib/structure/slice.ts`；`lib/structure/slice.test.ts`；`lib/structure/tree-sitter-provider.native.test.ts`；`lib/harness/explore.native.test.ts`；`lib/structure/DOCUMENTATION.md`；status 3.11。

状态：已实施。

### D-104 · 2026-09-07 · 3.11 第 4 步（冷目录只覆盖 TS/TSX）

类型：问题与解法

背景：冷仓库符号目录要把从未改动过的文件写进 6.2 图。tree-sitter 今天只接 `typescript` / `typescriptreact`。若把「扫全仓」写成仓库级覆盖，status 会撒谎。

决定：冷扫描枚举仍走 `searchFilesystemFiles`，但只对 TS/TSX `observe`。非 TS/TSX **跳过**，不 `touchFile`。事件驱动路径保持今天的行为：未知语言 `touchFile`；有 `structureSource` 时 defines/imports/连接边走门面（tree-sitter 先，LSP outline 可作 defines 后备）。

原因：`touchFile` 只声明「见过这个路径」，冷扫描对 Markdown/JS 写这种节点会让消费者以为目录覆盖了那些语言。跳过把「没有符号」和「这种语言还没有采集器」分开。

考虑过的替代：(1) 对非 TS `touchFile`——扩大图却没有符号或边，status 更容易被读成全仓目录。(2) 等第 5 步语言包再做冷扫描——未改动的 TS 文件会继续缺席，第 4 步交不出目录。

不改：JS/JSON 语法包、设置页、按需下载（第 5 步）；仓库级词法索引；LSP 全仓扫描。

影响：`symbol-runtime.ts` `CATALOG_SCAN_LANGUAGES`；`catalog-scan.native.test.ts`；status 3.11 必须写 TS/TSX only。

状态：已实施。

### D-105 · 2026-09-07 · 3.11 第 4 步（加法边与 generation 同寿）

类型：问题与解法

背景：`replaceFileSymbols` 每次换新 generation UUID，并删掉该路径旧 symbol 节点。store 没有 schema version 或 migration runner。新增边若不属于同一事务，重收集会留下悬挂边。`touchFile` 在 unavailable 时「刷新文件事实」，但会抹掉 `documentRevision`，使已提交范围失去身份。

决定：新增节点类型 `link` 与边标签 `imports` / `connects` / `associates`，加法写入，不跑 migration。link 与 symbol 共用该次 `generation`；`replaceFileSymbols` 在同一事务里 `unlinkLabel` 旧出边并删除旧 symbol **和** link。不把 import specifier 解析成文件（没有 tsconfig）。`touchFile` 保留已有 `generation` / `documentRevision`。查询面是 `getFileRelations` / `findLinks`，`danglingEdges` 数目标 payload 已消失的出边。

原因：确认连接与关联候选必须是不同节点/边，不能靠消费者记一个布尔。specifier 字符串是今天能诚实写下的事实。

考虑过的替代：(1) 边直接连 file→file 或 symbol→symbol——没有解析器会写成猜的。(2) 加 schema version + runner——本刀没有不兼容旧库的必要，旧库只是没有 link。(3) 接线未实现的 `related-tool.ts`——store 原先没有邻居 API，草稿会把候选当事实。

不改：`references`、PageRank、跨文件解析后的 `calls`。

影响：`lib/knowledge/store.ts`；collector / symbol-runtime；store 与 smoke 测试。

状态：已实施。

### D-106 · 2026-09-07 · 3.11 第 4 步（门面长出 literalCalls/imports）

类型：问题与解法

背景：`literalCalls` / `imports` 已在 `StructureProvider` 上，tree-sitter 已实现，LSP 报 `unsupported`，但 `StructureSource` 只暴露 outline/classifyHits。分类器必须把确认连接与关联候选分开。

决定：门面按 outline 同样的 fan-out：`cancelled` 立即返回，首个 `ready` 获胜，`empty` 之后 `warmOnly`，先前 `unavailable` 允许后者冷启。没有任何 provider 声明该能力时门面是 `unsupported`，不是 `failed`。确认 callee 允许名单：`request` / `register` / `on` / `once` / `emit` / `subscribe` / `addEventListener`。`require`/`import` 归 imports 查询，不重复写成调用边。其余带字面量的调用是 `associates`。

原因：LSP `unsupported` 是正当能力声明。空成功与缺能力不能合成同一个结果。

考虑过的替代：只让 collector 直接打 tree-sitter——绕过 fan-out 与 `warmOnly`，和 D-097/D-099 分叉。

不改：LSP 补 literalCalls/imports 实现。

影响：`structure/source.ts` / `connections.ts`；symbol-runtime 写边。

状态：已实施。

### D-107 · 2026-09-07 · 3.11 第 4 步（冷扫描不挡启动与首 turn）

类型：问题与解法

背景：全仓扫描若 await 在 `openWorkspaceKnowledge` / 首个 harness turn 上，会把目录建成启动门。

决定：store 打开之后 `queueMicrotask` 火忘 `scanWorkspace`。扫描可取消、按 8 个文件一批 `drain` 后让出事件循环、按磁盘修订幂等跳过。不设硬文件上限（以免静默少扫）；取消或中途停下的文件等下次打开再补。正文/修订/二进制/体积上限走 `documents.read`（内部已是 `inspectDocumentBytes` + `maxReadBytes`）。

原因：目录是增强，不是打开工作区的前置。修订相同则跳过，重入不会把同一磁盘事实再写一遍。

考虑过的替代：(1) 等首个 explore 再扫——从未被 explore 的仓库会一直空。(2) 启动时 await 扫完——违反「不阻塞启动或第一个 turn」。

不改：启动墙钟对照；把扫描进度做成 UI。

影响：`application-host/index.ts`；`symbol-runtime.scanWorkspace`。

状态：已实施。

### D-108 · 2026-09-07 · 3.11 第 4 步（explore 做唯一生产消费者）

类型：问题与解法

背景：符号图此前没有生产读者。`related-tool.ts` 未 import，store 原先没有邻居 API。只写边没有读者是货架代码（plan 0.1）。

决定：选 explore，不选 related 工具，也不改 compaction。`explore.search` 在物化并选出摘录之后，按摘录路径读 `getFileRelations`，写入 `details.relations` 与可见/stored 正文（计入 24 KiB 字节预算）。`connections` 与 `associations` 分列；不把关联文件加入 rg 候选池，不改变 D-090/D-092/D-098/D-102 的字节/候选预算。无 `fileRelations` 依赖时输出字节与现在一致。

原因：explore 已是「这段代码和什么有关」的模型入口；related 草稿会把未实现的 PageRank/邻居假装接上。扩候选池会回归已经收口的预算。

考虑过的替代：(1) 接线 `related-tool.ts`——要先发明邻居 API 和工具面，本刀范围外。(2) 仓库地图进 compaction——没有现成字节预算与验收例子。(3) 按字面量反查把连接文件扩进候选——改变物化集合。

不改：pi-host explore 参数 schema；`related` 工具。

影响：protocol `ExploreSearchResult.details.relations`；`explore.ts` 打包；`explore-service.ts`；`index.ts` `fileRelations`。

状态：已实施。

### D-109 · 2026-09-07 · 关联候选必须真是「同名」，不是「任何带字符串首参的调用」

类型：问题与解法

背景：plan 3.11 第 4 步写的是「无法确认的**同名**字符串标关联候选」——条件是这个字面量和某个已知连接标识同名。首版 `classifyLiteralCall` 只看 callee 名字，凡不在允许名单里就归 `associates`，完全没有同名条件。

在 `application-host/lib` 全部 499 个 TS 文件上实测（真实 wasm 解析）：`connects` 360 条，`associates` **10,711** 条，噪声比约 30:1。前十二位 callee 是 `it` 1518、`join` 1272、`toBe` 827、`toContain` 323、`get` 307、`describe` 296、`writeFile` 292、`post` 274、`startsWith` 210、`includes` 207、`error` 194、`setHeader` 159——测试脚手架、路径拼接、字符串判定、日志，按任何定义都不是连接候选。单这一个目录就是 13,220 个 link 节点，仓库 2,245 个 TS/TSX 文件等比约 5.9 万。每个 link 节点都进 `db.indexText` + `db.indexKeyword`，而 `searchSymbols` 与 `recall` 都是全节点 `scanNodes`，所以这批节点会被永久扫过一遍再丢掉。explore 还会把它们打进可见正文。

决定：`associates` 只在该字面量**已经是某处的确认连接值**时写入。store 增 `connectionLiterals(values)`，用一份按路径引用计数的 connects 值索引回答（open 时从 payload 建，写入/删除时同步维护），不做全表扫描。闸门同时看本批：同一文件里 `register("x")` 与 `log("x")` 是最清楚的同名情形，而 store 还没看到这一代。闸门只看已采集到的连接，所以冷扫描里排在注册文件之前的文件会先丢掉候选——记下这些路径，扫描主循环结束后再补一遍（解析按内容哈希缓存，这一遍便宜，且不递归）。

同一测量在闸门后：`associates` 10,711 → **153**，link 节点 13,220 → 2,662。留下的 153 条都是真正的同名情形。

原因：候选的价值在于「这个标识别处也出现了，但这次的调用形状不能确认」。没有同名条件时它退化成"任何字符串首参调用"，既不是候选也不是信息，只是把预算和索引填满。

考虑过的替代：(1) 扩大 callee 拒绝名单（`it`/`describe`/`toBe`/`join`…）——黑名单永远追不上真实代码，且仍然存不该存的东西。(2) 全部字面量都存、读时再过滤——存储与索引成本照付。(3) 读时用 `findLinks` 反查——需要先存下全部字面量，回到 (2)。(4) 整类去掉只留 `connects`/`imports`——比现状好，但放弃了 plan 明确要的那一类。

不改：`connects` 允许名单（D-106）；`findLinks` 语义；import 边。

影响：`lib/knowledge/store.ts`（`connectionLiterals` 与 connects 值索引）；`lib/knowledge/symbol-runtime.ts`（闸门与补扫一遍）；`symbol-runtime.test.ts`；`store.ts` 顶部节点/边说明。

状态：已实施。

### D-110 · 2026-09-07 · 结构轮廓写进图时的范围转换

类型：问题与解法

背景：`StructureSymbol.range` 是**只有行**的 1-based 闭区间，图里的 `SymbolGraphRange` 是 0-based 字符范围。首版把字符位一律填 0 并把 `endLine` 减一，于是多行符号的范围止于末行第 0 列（排除整个末行），单行符号退化成零宽：`{startLine:0,startCharacter:0,endLine:0,endCharacter:0}`。此前 LSP 路径给的是 `selectionRange`，即名字的真实跨度。

决定：末列取该行**真实长度**（`loadGraphFacts` 手里就有正文，按 `\n` 切分并去掉 `\r` 后取长度），`endLine` 用 `max(startLine, endLine-1)`。范围含义随之从「名字跨度」变为「符号整体跨度」，这是 tree-sitter 轮廓能诚实给出的粒度。

原因：零宽范围通不过任何「这个范围还成立吗」的判断，而 §7.2 要求消费者据修订与范围判断事实是否仍然成立。

考虑过的替代：(1) `endCharacter` 填一个大哨兵值——范围不再对应真实文本。(2) 把 `SymbolGraphRange` 改成只有行——LSP 路径（仍在用，见 D-111）会丢掉已有的列精度。

不改：`SymbolGraphRange` 类型；`validRange`；LSP 路径的 `selectionRange` 语义。

影响：`lib/knowledge/symbol-runtime.ts` `flattenOutlineSymbols`。

状态：已实施。

### D-111 · 2026-09-07 · 边查询被阻塞不得冻结可用的轮廓

类型：问题与解法

背景：首版 `loadGraphFacts` 里 `if (blocked(importsResult.status) || blocked(callsResult.status)) return null;` 与 outline 状态无关。tree-sitter 的能力按语言静态声明，wasm 加载失败后 `imports` 报 `unavailable`，而 LSP 没有 `imports` 能力会被门面跳过，于是门面结果就是 `unavailable`，整个文件走 `touchFile` 保留分支。

实测：outline 仍 `ready`、文件已改名，store 只收到 `touchFile`。也就是说 **wasm 一坏，全部 TS/TSX 文件的符号更新永久冻结**，而 D-104 明说「LSP outline 可作 defines 后备」，D-097 明说 wasm 失败应降级。配合 D-105 让 `touchFile` 保留 `documentRevision`，图会一直上报一个早已不成立的修订。既有测试 `preserves the graph when extraction is unavailable` 只断言图还活着，没断言新鲜度，把这个行为锁成了预期。

决定：由 **outline 单独决定这一代能不能写**——`ready`/`empty` 可写（空集只有在真有 provider 应答时才是权威的），`unsupported` 回落到 LSP `documentSymbol`，其余保留旧图。边查询被阻塞时不再抑制 outline，而是照写 defines、带上已就绪的那部分边，并在文件节点上记 `linksIncomplete`，经 `getFileRelations().linksIncomplete` 透出，explore 显示「edge extraction was incomplete for this revision」。

原因：「没有边」和「边没采集到」必须分开（plan 0.4）。冻结符号是把一个可修复的降级变成静默错误，而且没有任何通道报告。

考虑过的替代：(1) 边被阻塞时保留旧边、只更新符号——`replaceFileSymbols` 是按文件整体事务，做不到部分保留，硬做要引入第二种写路径。(2) 继续全否定但把冻结报出来——图仍然停在旧修订，只是多一行日志。

不改：`replaceFileSymbols` 的事务形状；`touchFile` 保留语义（D-105）。

影响：`lib/knowledge/symbol-runtime.ts`；`lib/knowledge/symbols.ts` `CollectedSymbols.linksIncomplete`；`lib/knowledge/store.ts`（`linksIncomplete` payload 与 `SymbolGraphFileRelations`）；`symbol-runtime.test.ts`。

状态：已实施。

### D-112 · 2026-09-07 · 关系是注解：不许拖垮检索，不许冒充当前

类型：问题与解法

背景：首版把 `fileRelations` 接在 `explore.search` 的成功路径上且无保护。实测一个必然抛错的知识库：检索本身完全成功、摘录已物化，结果整体返回 `{"ok":false,"error":{"code":"failed","message":"knowledge store is corrupt"}}`，内部错误原文还漏给了 agent。这次提交之前 explore 对知识库零依赖。而且 `getKnowledgeStoreForWorkspace` 会按需开库并触发全仓扫描，等于把开库和扫描搬到了读路径上。

另一半：图装的是磁盘已提交事实，摘录可能来自固定草稿或更新的磁盘修订。首版既不比较修订也不打标记。实测摘录在 `disk-r9`、关系在 `disk-r2` 时，可见正文照样印 `- src/router.ts connects register("gone.handler") (L3)`——L3 指向 agent 没在看的那个修订。§7.2 就在这次改动的下一段写着「消费者据修订判断范围是否仍然成立……而不是拿一份无身份的范围继续用」。

决定：三件事。(1) 查询失败或库未打开时降级注解、不失败检索：`details.relations` 增 `status`（`ready` / `partial` / `unavailable`），`unavailable` 与"没有任何出边"（`relations` 缺席）是不同结果，可见正文写一行说明，不透内部错误原文。读路径只用**已打开**的 store，不开库也不触发扫描——会话自身的知识工作负责打开。(2) 关系与摘录修订比较，不同则 `stale: true`，可见正文标 `[stale @<修订>]` 并**去掉行号**——移位的行号比没有行号更坏，边本身仍是证据。(3) 关系排在可见预算的**最后**，在 `Omitted supports`、未读候选与 issue 行之后，每文件上限 12 条并报省略数——注解不得挤掉「这个结果不包含什么」的通道。

原因：装饰性注解的失败必须只降级注解（plan 0.4）。检索成功却整体失败，是把一个增强变成了新的失败源。

考虑过的替代：(1) 只 try/catch 静默吞掉——把「查不到」和「没有边」压成同一个空成功。(2) 过期就整条丢掉——丢掉了"这两个文件之间有连接"这个仍然成立的事实。(3) 保持关系在预算靠前——D-090/D-092 刚把预算收口，注解不该优先于 issue。

不改：候选池（D-108 不扩候选仍然成立）；24 KiB 预算；`ExploreSearchSnippet`。

影响：protocol `ExploreRelationStatus` / `ExploreFileRelation.stale` / `.incomplete` / `details.relations.status`；`lib/harness/explore-service.ts`；`lib/harness/explore.ts` 打包顺序与 `relationLines`；`lib/harness/service-host.ts` `fileRelations` 返回类型（不含 `stale`）；`application-host/index.ts`；`explore.native.test.ts` / `explore-service.native.test.ts`。

状态：已实施。

### D-113 · 2026-09-07 · 切片查询与目录查询是两件事

类型：问题与解法

背景：第 4 步把图的符号来源从 LSP `documentSymbols` 换成了 `structureSource.outline`。TS/TSX 下 tree-sitter 必胜，LSP 永远不会被问，而那份定义查询是按 D-098「切片单位是容器」调的：provider 用 `isSliceUnit` 过滤，普通值绑定根本不进 outline。实测 `export const DEFAULT_BYTE_BUDGET = 24576;` 与 `export const TABLE = { a: 1 };` 从轮廓里整体消失，只剩 `type:Alias` / `function:realFn` / `function:arrow`。于是 `searchSymbols("DEFAULT_BYTE_BUDGET")` 再也找不到——目录的覆盖面被一份为切片调的查询悄悄收窄了。

决定：outline 的收录条件与切片的单位条件分开。outline 收 `isSliceUnit(node) || isModuleLevelBinding(node)`，即容器、定义绑定，再加**模块级与类级**的值绑定（`kind` 为 `variable`）；函数体内的局部绑定仍不收——那不是 `searchSymbols` 要回答的东西，LSP 的 `documentSymbol` 也不给。切片侧无需改动：`enclosingSliceSymbol` 早已按 `isStructureContainerKind` 过滤，`variable` 不是容器种类，所以 D-098 与 `outlineCoversHitLines` 的行为不变。

原因：「哪些跨度值得当作一段代码切出来」和「哪些名字值得被检索到」是不同的判据，复用同一个过滤器会让后者被前者的取舍绑架。

考虑过的替代：(1) 目录改回 LSP `documentSymbols`——事件驱动路径可以，但会让同一张图的符号语义按发现途径分叉，而 plan 3.11 又禁止基于 LSP 的全仓扫描。(2) 在 store 侧补一层——图不该猜 provider 漏了什么。(3) 连局部绑定一起收——`explore.ts` 这类文件会多出大量局部名，`searchSymbols` 的信噪比反而更差。

不改：`TYPESCRIPT_DEFINITION_QUERY`（`lexical_declaration` / `variable_declaration` 早已捕获，被 provider 过滤掉的）；`isSliceUnit`；`isStructureContainerKind`；D-098 的切片行为。

影响：`lib/structure/tree-sitter-provider.ts`（`isModuleLevelBinding` / `isOutlineUnit`）；`tree-sitter-provider.native.test.ts`。

状态：已实施。

### D-114 · 2026-09-07 · 3.11 第 5 步（JSON 进切片、不进目录）

类型：问题与解法

背景：plan 要 JS/JSON 语法包。JSON 键名不是 `searchSymbols` 要回答的东西，全量入图会淹没符号表。但大 JSON 命中若退回 ±3 行窗口，agent 看不到所在对象。D-113 已经把目录查询和切片查询拆开。

决定：JSON **只服务切片**。轮廓收顶层 `pair`、值为 `object`/`array` 的 `pair`（`kind: property`），并额外收 object/array 节点作切片容器；深度上限 **8**、符号上限 **256**，文档根 object/array 始终保留，所以触顶时仍切到根容器而不是裸 ±3。`isJsonStructureContainerKind` 接受 `property`/`object`/`array`，**不**并进 `isStructureContainerKind`（否则会放宽 D-098 对 TS/JS 的 `property`）。JSON 的 `literalCalls`/`imports` 报 `unsupported`。JSON **不进**冷目录扫描。

原因：切片要的是「命中落在哪一段」，目录要的是「这个名字指什么」。JSON 只有前者。

考虑过的替代：(1) JSON 也进目录——`name`/`version`/`scripts` 会淹没 `searchSymbols`。(2) 只出 pair、不出 object/array——顶层数组里的对象命中没有容器。(3) 把 `property` 加进 D-098 容器集合——TS/JS 的 property 成员会变成切片单位。

不改：D-098 的 TS/JS 容器集合；候选池。

影响：`json-outline.ts`；`kinds.ts` `isJsonStructureContainerKind`；`slice.ts` / `source.ts` 按语言选容器谓词；冷扫描跳过 json。

状态：已实施。

### D-115 · 2026-09-07 · 3.11 第 5 步（D-104 被取代：冷目录含 JS）

类型：偏离

背景：D-104 把冷目录收成 TS/TSX，因为当时只有这两份语法。本刀加上 JS/JSX 语法后，再跳过 `.js`/`.jsx` 是把已有能力藏起来。

决定：冷目录语言改为规格表里**带 `importQuery` 的语言**（今日：`typescript` / `typescriptreact` / `javascript` / `javascriptreact`）。JSON 没有 import 查询，继续不进目录（D-114）。D-104 正文不改；本条取代它的覆盖范围。事件驱动路径对未知语言仍 `touchFile`。

原因：目录该覆盖 tree-sitter 已经能诚实抽出 defines/imports/连接边的语言，而不是永远停在第 4 步的 TS/TSX 快照。

考虑过的替代：(1) 继续只扫 TS/TSX——JS 仓库的图是空的。(2) 一切有 outline 的语言都扫——JSON 会进目录，与 D-114 冲突。

不改：D-104 原文；非目录语言的 `touchFile`；扫描不挡启动（D-107）。

影响：`CATALOG_SCAN_LANGUAGES` 改由规格表推导；`catalog-scan.native.test.ts`。

状态：已实施。

### D-120 · 2026-09-07 · 3.11 第 5 步（语言分布现算、上限与缓存）

类型：默认值调整

背景：设置页需要按工作区列出语言，但仓库里没有语言分布索引。开机时扫全仓会挡启动。

决定：`LanguageSupportAPI.getStatus` 被调用时用冷扫描那条 `searchFilesystemFiles` + `languageIdForPath` 现算。文件上限 **8000**，多出来的那一份只用来置 `partial: true`。按工作区缓存 **30 秒**。不落盘，不进启动路径。无 `languageId` 的文件计入扫描数但不占语言行。

原因：设置页是用户主动打开的；几百毫秒可以接受，开机不行。上限避免一次枚举把 Host 拖死。

考虑过的替代：(1) 持久化分布——又一份会过期的索引。(2) 复用冷目录扫描的文件名单——那份只含目录语言，JSON/Python 会消失。

不改：冷目录扫描本身；启动路径。

影响：`lib/language-support/runtime.ts`；`/api/language-support/status`。

状态：已实施。

### D-121 · 2026-09-07 · 3.11 第 5 步（wanted 是内存需求信号）

类型：问题与解法

背景：plan 的「按需」容易被做成 Host 自己下载。本机没有 embedding 下载管道可抄，而且结构请求今天对缺包语言已经返回 `unsupported`。

决定：结构请求在规格表没有、但清单标明可装的语言上，把 languageId 记进**按工作区的内存** wanted 集合，**仍然返回 `unsupported`**。`getStatus` 把 wanted 行排最前。没有工作区 id 的请求不记。Host 不因此发起网络。

原因：「按需」是需求信号，不是自动下载。同意模型是下一刀的明确安装动作。

考虑过的替代：(1) 全局 wanted——A 工作区的 Python 请求会污染 B 的设置页。(2) 请求时自动下载——Host 自发网络。

不改：`unsupported` 语义；D-099 fan-out。

影响：tree-sitter `onLanguageRequest`；`LanguageSupportRuntime.noteRequest`。

状态：已实施。

### D-122 · 2026-09-07 · 3.11 第 5 步（语言支持设置页）

类型：默认值调整

背景：plan 要求设置「语言支持」页按工作区列语言，每种两行状态。`piarium:*` 渲染器会被转成 `PiariumSettingsPage` 分节，本页需要自己的组件。

决定：普通 `language-support` 渲染器，`group: 'pi'`，`order: 38`（紧挨 runtime 39）。页面只读 `LanguageSupportAPI` 与已有的 `LanguageServicesAPI.getStatus`。用户自带 wasm 的导入按钮留到下载管道落地；本页先提供状态与「安装」动作。

原因：设置页不能碰文件系统、网络或 tree-sitter。LSP 状态已有 owner，不另造一份。

考虑过的替代：(1) `piarium:language-support` 分节——会被应用设置壳吞掉。(2) 本页自己扫工作区——越权。

不改：LanguageServicesAPI；Host 下载管道。

影响：`builtin-page-metadata.ts`；`LanguageSupportPage`。

状态：已实施。

### D-123 · 2026-09-07 · 3.11 第 5 步（用户自带 wasm：未验证，不覆盖捆绑）

类型：问题与解法

背景：D-122 把导入按钮留到下载管道。用户自带包是高级选项，不是默认信任。

决定：设置页「导入 .wasm」走桌面选文件 + `importUserGrammar`。同一内容寻址目录，`source: 'user'`，不算清单摘要，ABI 仍在 `Language.load` 窗口里闸。UI 标 `user-unverified`。捆绑语言拒绝导入，避免下载目录永远到不了 TS/JS/JSON。

原因：明确动作即同意；未验证必须看得见。

不改：捆绑优先（D-126）；清单摘要只约束 npm 包。

影响：`grammar-installer.ts`；`LanguageSupportPage`。

状态：已实施。

### D-124 · 2026-09-07 · 3.11 第 5 步（明确动作即同意；Host 不自发网络）

类型：问题与解法

背景：plan 3.11 第 5 步原文写「与本地 embedding 模型同一套同意提示与下载管理」。那套东西不存在：`openWorkspaceKnowledge` 一律 `embedding: null`，听写 `ensureLocalSttModel` 无摘要、无取消、无同意门，缺模型就后台自动下。

决定：不做同意弹窗，不做 `ask`/`always`/`never`。用户点「安装」或「导入」就是同意。Host **从不自己发起**语法包网络请求。wanted 只是需求信号。

原因：抄听写等于给 ABI+摘要双重校验套上两样都没有的管道。

考虑过的替代：(1) 抄听写自动下载。(2) 新做同意设置项——无既有消费者。

不改：听写下载；embedding 仍为 null。

影响：plan 3.11 第 5 步原文；`grammar-installer.ts`。

状态：已实施。

### D-125 · 2026-09-07 · 3.11 第 5 步（清单摘要在发布期生成）

类型：implementation

背景：运行期不能从网络取信。npm tarball 的 integrity 是整包的，不是 wasm 字节的。

决定：`scripts/refresh-grammar-manifest.mjs` 从 npm 拉 tarball、解出 wasm、用 web-tree-sitter 读 ABI、**我们自己算 sha256**，写入提交进 git 的 `grammar-packs.json`。运行期只把下载字节与这份清单比。

原因：与 D-101「checked-in wasm 是权威」同一精神。

不改：`scripts/cloud-runtime.bun.lock`。

影响：`grammar-packs.json`；`createGrammarInstaller`。

状态：已实施。

### D-126 · 2026-09-07 · 3.11 第 5 步（捆绑目录优先于下载目录）

类型：implementation

背景：下载目录若优先，被污染的 `tree-sitter-typescript.wasm` 能遮蔽内置语法。

决定：`resolveStructureRuntimeFile` 先查捆绑 `runtime/`（含 asar 重映射），只有捆绑文件不存在才问 `resolveInstalled`。默认不注入第二级，现有测试无需数据目录。

原因：内置 TS/JS/JSON 必须不可被数据目录覆盖。

不改：asar 重映射；`pathExists` 注入。

影响：`runtime-path.ts`；`createTreeSitterStructureProvider({ resolveInstalled })`。

状态：已实施。

### D-127 · 2026-09-07 · 3.11 第 5 步（按需语言名单与落选原因）

类型：实验结果

背景：plan 覆盖目标是 python、go、rust、java、c、cpp、c-sharp、kotlin、swift、ruby、php、bash、css、html、yaml、toml、markdown、xml。协议 id 是 `csharp` / `shellscript`，不是 `c-sharp` / `bash`。

决定：清单收入 15 种：python、go、rust、java、c、cpp、csharp、kotlin、ruby、php、shellscript、css、html、yaml、toml。落选：swift（`tree-sitter-swift@0.7.1` 无 wasm）、markdown（两个候选包都无 wasm）、xml（两个候选包都无 wasm）。`languageIdForPath` 补 `.cs/.kt/.kts/.swift/.rb/.php/.toml/.cc/.cxx/.hh`，否则分布永远看不到这些语言。下载不做断点续传；C#/C++/Kotlin wasm 超过 1 MB，整包下完再校验。

原因：脚本对每个候选如实判定，没有的记下原因略过。

不改：捆绑的 TS/TSX/JS/JSX/JSON；冷目录仍只含带 `importQuery` 的语言（D-115）。按需语言装上 wasm 但还没有查询规格时，结构仍报 `unsupported`，能力旗标全关。

影响：`grammar-packs.json`；`language-id.ts`。

状态：已实施。

### D-128 · 2026-09-07 · 装下来的语法必须真的出轮廓，否则不许说"已安装"

类型：active-design

背景：D-127 交付时，15 种按需语言只有 wasm，没有 `definitionQuery` / `commentTypes` / `stringTypes`。装完之后 `grammarStatus` 是 `installed`、设置页显示绿色成功，但 `capabilities` 四项全关、`outline` 继续 `unsupported`。用户按了按钮、下了 5 MB、看到"已安装"，检索行为一点没变。这是假可用性，比不提供这个功能更坏。

决定：两件事同时做。

一是接上游 `queries/tags.scm`。tree-sitter 生态里几乎每个语法包都带这个文件，捕获名是跨语言约定：`@definition.function` / `@definition.class` / `@definition.method` / `@definition.interface` / `@definition.module` 等，配套 `@name`。`treeSitterTagsSpec(grammarFile, tagsQuery)` 把这份查询变成一份运行期语言规格：`tagsDefinitionKind` 把 `definition.*` 后缀映射到 `StructureSymbol.kind`，认识的映到对应种类，不认识的映到 `unknown`（进目录，不进切片）；`reference.*` 与裸 `@name` 不产生符号。命中分类退化为按节点类型名判断——`stringTypes` 用 `/string|char/`、`commentTypes` 用 `/comment/` 匹配节点类型，这是 tree-sitter 命名惯例，不是逐语言表。`literalCalls` / `imports` 仍然关闭：那两项需要按语言写的查询，tags 里没有。

二是把这件事变成发布期可验证的。`refresh-grammar-manifest.mjs` 从 tarball 里连 `queries/tags.scm` 一起取出来，**用该包自己的 wasm 编译一遍**，编得过才把 `tagsPath` / `tagsIntegrity` 写进清单；编不过只记 `tagsNote`，清单里 `tagsPath` 为 `null`。安装时 `tags.scm` 和 wasm 一样按摘要校验，摘要不符整个安装失败。清单解析阶段还会丢掉摘要格式不对的 tags 字段——宁可没有轮廓，不要一份没验证过的查询。

结果：15 种里 9 种（python、go、rust、java、c、cpp、csharp、php、ruby）拿到编译通过的 tags 查询，装上就有 `outline` + `classifyHits`。6 种（kotlin、shellscript、css、html、yaml、toml）上游包没带 `queries/tags.scm`，装上只有解析器。

原因：能力旗标是协议事实，不是宣传语。要么让它真的为真，要么在按钮旁边说清楚它为假。

不改：`literalCalls` / `imports` 仍只有手写规格的语言有（TS/TSX/JS/JSX）。JSON 仍按 D-114 只进切片。捆绑语言不受影响。

影响：`structure/languages.ts`（`treeSitterTagsSpec` / `tagsDefinitionKind`）；`structure/tree-sitter-provider.ts`；`grammar-store.ts`（存查询）；`grammar-installer.ts`（校验查询）；`grammar-manifest.ts`（`tagsPath` / `tagsIntegrity`）；`scripts/refresh-grammar-manifest.mjs`；`grammar-packs.json`。

状态：已实施。

### D-129 · 2026-09-07 · 语法索引读不出来是"不知道"，不是"没装"

类型：implementation

背景：`readGrammarIndex` 之前把任何异常都吞成空索引。`index.json` 被截断、被别的进程占住、权限不对，都报"没装任何语法"。这违反 plan 0.4 不变量 10（只有 ENOENT 算空），而且下一次 `put` 会把这份"空"索引写回去——真装过的语言就此消失。

决定：只有 ENOENT 算空。其他 IO 错误、JSON 解析失败、形状不对，都抛 `GrammarStoreUnreadableError`。`index.json` 改成写临时文件再 rename，与 blob 的写法一致，崩在中途不会留下半个索引。

这个错误必须在界面上能看见，不能在 Host 里静静吞掉：`LanguageSupportStatus` 长出 `grammarStore: 'ready' | 'unreadable'`，`grammarStatus` 多一个 `unknown` 值。索引读不出来时，按需语言显示 `unknown`（灰色，不是"没装"的可操作态），安装和导入按钮都停用，页面顶部说明状态未知。捆绑语言不受影响——那张表在代码里，不在索引里。

原因：把"读不出来"报成"没装"，会让用户点安装，然后覆盖掉自己原有的安装记录。

不改：blob 文件名仍是内容地址，索引坏了 blob 还在，修好索引即恢复。

影响：`grammar-store.ts`；`language-support/runtime.ts`；`application-client` 的 `LanguageSupportStatus` / `StructureGrammarStatus`；`presentation.ts`；`LanguageSupportPage.tsx`；五个语言的 settings 词条。

状态：已实施。

### D-130 · 2026-09-07 · 导入端点的路径策略与错误面

类型：implementation

背景：`/api/language-support/import` 把 `readLocal` 的 `error.message` 原样回给调用方。已认证客户端能拿这个端点当文件探针：错误原文里带路径、`EACCES` / `EISDIR` / `ENOENT` 的区别，足以枚举 Host 机器上的文件。另外后缀和体积都没校验，任何文件都会先读进内存再交给 ABI 检查。

决定：读之前先判后缀必须是 `.wasm`，读到的字节超过 `MAX_USER_GRAMMAR_BYTES`（32 MiB）就拒。读失败一律回一句固定文案，不带 `errno`、不带路径。ABI 检查本身也包起来——喂给它一个不是 wasm 的文件会抛，那要变成 `reason: "abi"` 的失败，不是未捕获异常。

原因：D-124 说 Host 不自发网络；同理，Host 也不该把本地文件系统的形状当错误消息往外送。

不改：路径仍来自桌面 `requestFileAccess`，仍要求绝对路径；`source: "user"` 与 D-123 的 `user-unverified` 标记不变。

影响：`grammar-installer.ts`（`importUserGrammar`、`MAX_USER_GRAMMAR_BYTES`）。

状态：已实施。

### D-131 · 2026-09-07 · 清单坏了不许掀翻 Host；刷新脚本按已提交版本可复现

类型：implementation

背景：三处不牢。`loadCommittedGrammarPackManifest()` 在 `main()` 里裸调，`grammar-packs.json` 少一个字段就是 Host 起不来。清单解析不看 ABI 窗口——超窗的包照样列成 `available`，点了必然失败。刷新脚本取 npm `dist-tags.latest`，同一份代码今天明天生成的清单不一样。

决定：`main()` 用 try/catch 包住清单加载，失败退到 `EMPTY_GRAMMAR_PACK_MANIFEST`——按需下载没了，捆绑语言和已装语言照旧工作。解析阶段就按 `minCompatibleAbi` / `maxCompatibleAbi` 筛掉超窗的包，移进 `skipped` 并写原因。刷新脚本默认复用已提交清单里的版本号，`--latest` 才去 npm 问最新；`generatedAt` 取当次运行日期。

同时把重复点安装从"取消上一个"改成"并到同一个 Promise"，ABI 不匹配从 `reason: "failed"` 改成 `reason: "abi"`。

原因：清单是发布期产物，它的问题不该变成运行期启动故障；能装的清单不该列出装不上的东西。

不改：摘要校验仍是硬闸门（D-125）；捆绑优先（D-126）。

影响：`grammar-manifest.ts`；`application-host/index.ts`；`grammar-installer.ts`；`scripts/refresh-grammar-manifest.mjs`。

状态：已实施。

### D-134 · 2026-09-07 · 3.12 先量再决定：查询走已有 path→id 图，不加名字哈希

类型：问题与解法

背景：`searchSymbols` / `findLinks` 曾 `scanNodes` 全节点。上 explore 热路径前要先量本仓库目录规模和单次查询墙钟，再决定要不要内存索引。`connectionLiteralCounts` / `connectionLiteralsByPath` 是「打开时和每次写入维护、不改持久格式」的先例。

决定：查询不再 `scanNodes` 全库。打开与每次写入维护三份内存结构，无新持久格式、无迁移：`symbolQueryByPath`（searchSymbols 扫行而不是 `getPayload`）、`linksByValue`（findLinks 按字面量取值）、`importSpecifiersByPath`（findImporters 仍在查询期解析）。`searchSymbols` 把计分档暴露为 `match: exact | name-contains | path-contains`（分仍是 4/2/1）。对照测量（加缓存前、本仓库 2349 文件 / 24232 符号 / 13969 边）：`searchSymbols("explore", 20)=186.0ms`，`findLinks("explore.search")=73.2ms`，`findImporters(explore.ts)=42.4ms`。186ms × 每个 distinctive 词已经够上 explore 热路径，所以加了行缓存和按值的 link 映射；**不加**按名字的第二份哈希（名字包含仍要扫行）。findImporters 42ms 留在查询期解析，因为解析依赖当时的路径集合。

原因：全节点扫描会把 event/block/knowledge 和符号混在一起数。对照数字说明贵的是逐 id `getPayload`，不是缺一个名字哈希。`connectionLiteralCounts` 就是这个先例。

不改：持久 schema；embedding；词法/BM25 索引。

影响：`knowledge/store.ts`；`scripts/symbol-graph-query.ts`；status 3.1/3.12。

状态：已实施。

### D-135 · 2026-09-07 · 反向 import 查询期解析，未解析可见，不猜

类型：问题与解法

背景：import 边存的是未解析 specifier 字符串（D-105）。`./explore.js` 和 `../harness/explore.js` 是两个键，却常指向同一个文件。`related` 最有用的答案是「谁用了这个文件」。

决定：在查询期解析。相对 specifier 相对于该文件所在目录，尝试常见扩展名和 `index.*`；本仓库需要的 `.js`→`.ts` / `.tsx` 孪生一并试。命中目录里恰好一个已知路径才算解析成功。命中零个或多个孪生 → `unresolved-relative`。包名、别名、`node:`、`#` → `non-relative`。未解析必须出现在结果里，不许悄悄丢掉，更不许在多个孪生里猜一个。

原因：解析写进边会强迫冷扫描做模块解析，D-105 已拒绝。查询期有完整路径集合，相对路径足够确定性；包名没有工作区解析器，猜会撒谎。

不改：边的持久格式；tsconfig paths / package exports。

影响：`knowledge/import-resolve.ts`；`store.findImporters`；`related` 的 imports.unresolved。

状态：已实施。

### D-136 · 2026-09-07 · 本刀取代 D-108 的「不扩候选池」

类型：问题与解法

背景：D-108 把 explore 定为图的唯一生产消费者，但只注解已经选中的摘录，明确不把关联文件加入候选池。3.11 第 4 步因此建了只写的图：冷扫描持续维护符号，没有任何路径读目录做定义优先或连线补全。plan 0.7 要按观察到的「找不到入口」决定下一步；证据已经在库里——`explore.search` 的注册端和请求端是同一字面量的两头，rg 候选预算可能只留下提到它的文件。

决定：explore 增加图路径候选：定义、连线另一端、反向 import。摘录出边注解（`details.relations`）和 D-112 的降级/去行号/可见预算规则保留。D-108 正文不改；本条取代其中「不扩候选池」一句。

原因：图能加的是定义位置、连线配对和反向 import，不是笼统扩大召回。继续只注解已经选中的摘录，兑现不了第 4 步建的东西。

不改：rg 候选预算；24 KiB 字节预算；结构切片；`lsp.references`。

影响：`explore.ts` / `explore-graph.ts` / `explore-service.ts`；protocol `details.graph`；设计 6.1/6.2；plan 3.2/3.12；D-108 索引行。

状态：已实施。

### D-137 · 2026-09-07 · 图召回始终跑定义；连线与反向 import 等第一次打包之后

类型：问题与解法

背景：两级门控要自己定：始终跑图，还是只在 rg 不足时跑。第 1 步对照查询（path→id 扫描，见 D-134）显示单次 `searchSymbols` / `findLinks` / `findImporters` 的墙钟远小于一次 rg 扇出，定义优先的价值在 rg 命中很多时也成立。

决定：store 已打开且目录非空时**始终**跑定义召回（跳过 `path-contains` 档，避免把路径碰巧含该词的文件当定义）。连线补全和反向 import 需要已选中的摘录正文/路径，所以放在第一次 `packComplementary` 之后：只对摘录**正文里出现过**的确认连接字面量做 `findLinks`，只对已打包路径做 `findImporters`。独立预算：定义 40、连线 16、反向 import 每种子 6 / 总共 12。RRF 权重定义 10 / 连线 7 / import 3，打进现有 `rankCandidates`。打包另加 `graphBoost`（定义 30 / 连线 16 / import 4），因为互补打包原先不看 RRF，只提及时会压过定义文件。`filesDropped` 与 rg 取 max。why 写明来源，不伪装成 rg 命中。

原因：定义优先在「rg 已经很多」时仍然要把定义文件排到前面。连线和反向 import 没有查询词就做会把半个仓库拉进来；有了选中摘录才有种子。反向 import 噪声最大，上限宁可少给；同目录、更少 `../` 的 importer 优先。

不改：rg 200/80/20 预算；embedding；模型增强。

影响：`explore.ts`；`explore-graph.ts`；`explore.native.test.ts`。

状态：已实施。

### D-138 · 2026-09-07 · `related` 是文件级拓扑，不是 references，也不做 PageRank

类型：问题与解法

背景：`related-tool.ts` 依赖 store 上不存在的 `findNode` / `getNeighbors` 和 PageRank，还打印不存在的 rank。pi-host 没有工具定义。plan 0.1：不留 facade。

决定：按路径（含扩展名或分隔符）或名字重写。路径：定义、import（解析与未解析分列）、反向 import、连线及另一端。名字：先精确符号，再当连接字面量。空目录（含「这种语言目录不收录」）与「这个路径/名字没扫到」都是 `empty`，不是失败。`linksIncomplete`、未解析 specifier 是不完整。store 未打开返回 `unavailable`，读路径不开库。工具描述必须写明与 `lsp.references` 的分工。不保留 hops/labels/rank。

原因：LSP `references` 已经接线，精确回答谁引用这个符号。图回答它回答不了的：文件级连线和 import 拓扑，而且不需要语言服务器。做一个更差的 references 会和 3.8 抢活。

不改：PageRank、多跳、`references`/`calls` 边（D-059）。

影响：protocol `related.query`；Host `related-tool.ts` / `related-service.ts`；pi-host `related-tool.ts` / `select-tools.ts`；`session-e2e.test.ts`。

状态：已实施。

### D-139 · 2026-09-07 · 3.12 验收复验：图查询按调用次数量，不按单次量

类型：问题与解法

背景：3.12 验收复验重量了一次。D-134 的对照数字是**每种查询各一次**，但 explore 一次调用会做 `catalogStats` 一次、
`searchSymbols` × 每个 distinctive 词、`getFileRelations` × 已选窗口、`findImporters` × 每个种子路径（最多 20）。
`findImporters` 当时在查询期对全库每条 import specifier 重跑一遍 `resolveImportSpecifier`；`catalogStats` 为了 `languages`
逐文件 `getPayload`，而 explore 只要 `symbolCount`。同量级目录（2270 文件 / 23321 符号 / 12370 边）实测**一次 explore
调用的图工作 892.2 ms**，其中 `findImporters` 58.15 ms × 20 个种子是主项——正是 D-134 声称已经消除的那类成本。
另外三处：D-133 的 `error` 监听器只对 EPIPE `return`，else 分支什么也不做，而挂上监听器本身就取消了默认抛出，
于是**所有** stdio 错误都被静音（D-133 正文明确说不要吞真实错误）；打包用的 `graphBoost` 靠 `startsWith("definition of ")`
前缀匹配展示文案得出；图新增候选一次 `Promise.all` 读最多 28 个文件，绕开 `readBudget` 和 `DEFAULT_READ_PARALLELISM = 3`；
`related` 正文没有预算，hub 文件或撞多路径的名字会把「装不下什么」交给通用 32 KiB 头尾截断器，被切掉的通常是中间的
`Imported by`。

决定：

1. **反向 import 建解析后的反向索引。** 按目录形状缓存一次（路径集合变化或任一文件的 specifier 变化即整份失效），
   `findImporters` 变查表。`catalogStats` 的 `languages` 从内存 `fileLanguageByPath` 取，不再逐文件 `getPayload`。
2. **D-133 的处理器只吞已死管道**，其他 stdio 错误重新抛出，恢复默认的未捕获行为。
3. **打包 boost 查表。** evidence 带结构化 `graphSources`（`definition` / `connection` / `import`），
   `GRAPH_PACK_BOOST` 按它取值；`why` 只管展示。
4. **图新增候选复用主物化形状**：`maxMaterializeReads` 定预算、按 `DEFAULT_READ_PARALLELISM` 分批。超预算的仍是候选，
   走既有 `not-requested`，不另计 `filesDropped`（那是「没进候选池」的意思）。主循环与图那一趟的物化合成一个
   `materializeBatch`，不再有两份三十行副本。
5. **`related` 正文按段设可见上限**：每段 40 条，名字锚点最多走 8 个路径，超出写明「还有 N 条，完整在 details」。
   `details` 保持完整——只有正文有上限，与 explore「进通用工具结果之前自己打完包」同口径（设计 6.1）。

复验数字（同一探针、同一机器、`packages` ∩ `CATALOG_SCAN_LANGUAGES` = 2270 文件）：`catalogStats` 14.19 → 1.13 ms；
`findImporters` 58.15 ms/次 → 首次 124.89 ms 建索引、之后 0.164 ms；**一次 explore 调用的图工作 892.2 → 51.7 ms**。
仍是对照数字，不是省时声称。

原因：单次查询的墙钟不是判据，热路径上的调用次数才是。缓存的失效条件必须是「解析结果可能变了」而不是「路径集合变了」——
新增一个文件会让别的文件原本解析不了的 specifier 突然解析得了，所以任一写入都整份丢。EPIPE 那条的范围最小化只有在
真错误仍然抛出时才成立。前缀匹配展示文案会在改一句文案时静默改掉排序。

不改：D-134/D-137 的预算数值与 RRF 权重；持久格式；`related` 的 `details` 完整性；D-103 第 1、3 项。

影响：`knowledge/store.ts`；`harness/explore.ts`；`harness/related-tool.ts`；`run/test-supervisor.ts`；
`store.test.ts` / `related-tool.test.ts`；plan 3.12；status 3.1/3.3/3.12。

状态：已实施。

### D-140 · 2026-09-07 · 3.12 验收：目录建不起来，图就没有可读的东西

类型：问题与解法

背景：3.12 验收复审。D-134/D-139 把**查询**量清楚了，但**目录本身**建不起来这件事只作为对照数字的方法学注脚留在
status（「该路径每个目录 spawn `git check-ignore`，在本机挂了 11+ 分钟」），没有当成未兑现的前置条件立项。而 3.12 的全部价值都
压在目录存在上，且失败是静默的：冷扫描是火忘（D-107），explore 又如实报 `graph: empty`——用户既没有收益也没有信号。

两笔成本都实测了。**枚举**：冷扫描传 `respectGitignore: true` 且无 `limit`，`searchFilesystemFiles` 每个目录 spawn 一个
`git check-ignore`。本仓库 4363 个目录，裸遍历 1.58 s，单次 spawn 84.8 ms，5 路并行投影约 74 s。同一条路还有两个消费者：
设置页语言分布（D-120，上限 8000）和 workbench 的 `/api/find/file`。**建目录**：2358 文件 / 4143 次解析耗 1104500 ms
（18.4 分钟）。`replaceFileSymbols` 每写一个文件 `db.flush()` 一次整库；隔离测量显示在 400 文件的库上 `touchFile`（只写一个
小节点）单次 66.8 ms，同样 20 次作为一批并发则合计 91 ms（4.6 ms/次）——flush 是主项，且成本随库增长，所以整体是二次的。

决定：

1. **枚举一次问 git，不是每目录问一次。** `searchFilesystemFiles` 改成用一次
   `git ls-files -z --cached --others --exclude-standard` 建「未被忽略」的路径集合，文件按集合判定、目录按前缀判定。
   非 Git 目录或 git 不可用时返回 null，等于不声称任何东西被忽略——与旧实现 spawn 失败时的答案一致。
   顺带修正两处语义：被强制 add 的文件（`--cached` 会列出）不再被当成忽略而丢掉；只含被忽略文件的目录不再被下降。
2. **派生图的写入按尾随去抖 flush。** 符号图是派生数据——冷扫描会重建，且按磁盘修订幂等跳过——所以
   `replaceFileSymbols` / `removeFileSymbols` / `touchFile` 改为标脏 + 安静 250 ms 后 flush，并以 30 s 为最大延迟上限，
   让长扫描仍然边跑边落盘。知识、块、事件、会话是用户数据，仍在各自的写入里即时 flush，窗口不变宽。
3. **测量脚本必须量生产做的事。** `symbol-graph-query.ts` 原先逐个 await 写入，量的是产品不会跑的形状。改为按
   `CATALOG_SCAN_BATCH` 成批并发（收集器按路径串行、不同路径并发，所以这也是 store 看到的突发大小），常量从
   `symbol-runtime.ts` 导出而不是抄一遍。脚本头部关于 `searchFilesystemFiles` 挂住的说明同时作废。

**第一次尝试是错的，记下来。** 去抖最初写成看写队列占用（`pending > 1` 就延后）。它在 400 文件探针上显示写入快 8 倍，
但那个探针先把解析 await 完再连续入队；真实形状里每次写入之间隔着约 47 ms 的解析，队列几乎总是只剩一个，于是每次都照样
flush。全库实测 18.4 → 17.6 分钟，等于没动。占用不是判据，安静期才是。

复验数字（同一机器、同一脚本、2358 文件 / 4143 次解析）：

| 项 | 之前 | 之后 |
| --- | --- | --- |
| 枚举（`respectGitignore: true`） | 投影 ≈ 74 s，4363 次 git spawn | **199 ms**，1 次 |
| 建目录 | 1104500 ms（18.4 分钟） | **290502 ms（4.8 分钟）** |
| `searchSymbols` / `findImporters` | 186 / 42 ms（D-134 首测） | 17 / 41 ms |

仍是对照数字，不是省时声称。

原因：派生数据的持久化频率是可以选的，用户数据的不行。把两者混在一个 `db.flush()` 策略里，就只能按用户数据的要求付钱。
枚举那条更简单：忽略规则是仓库级事实，不是每目录事实，按目录问就是把一个 O(1) 的问题问了 O(目录数) 次。

不改：`CATALOG_SCAN_BATCH = 8`；D-107 的火忘；D-115 的语言覆盖；查询侧的内存结构（D-134/D-139）；
`/api/find/file` 与设置页的调用签名（它们免费受益）。

遗留（本条不修，见状态）：4143 次解析对 2358 个文件——同名闸门再访重新解析了 1785 个。D-109 正文称
「解析按内容哈希缓存，这一遍便宜」，但解析缓存上限是 32 条，在这个规模上早已淘汰完，所以再访是完整的第二遍解析
（约 47 ms × 1785 ≈ 84 s，占改进后建目录时间的三成）。要么提高缓存、要么让再访只重跑 `literalCalls`，都是设计改动。

影响：`lib/fs/search.ts`（+ 新增 `search.test.ts`，此前该文件无测试）；`lib/knowledge/store.ts`；
`lib/knowledge/symbol-runtime.ts`（导出 `CATALOG_SCAN_BATCH`）；`scripts/symbol-graph-query.ts`；status 3.1/3.12。

状态：已实施。

### D-141 · 2026-09-07 · TriviumDB 升到 0.8.6：符号图查询改走原生索引，禁用其 payload 缓存

类型：implementation + 实验结果

背景：D-019/D-020 是在 0.8.5 上记的；维护者把问题反馈给了作者，0.8.6 于 9 月 5 日发布。上一轮设计讨论里「派生数据该不该住在
TriviumDB」的主要论据是查询模型不匹配——store 为此叠了八张 JS 内存表（三张路径→id、`linksByValue`、`connectionLiteralCounts`、
`symbolQueryByPath`、`fileLanguageByPath`、import specifier 表），每次写都要维护，每次打开都要走一遍全部节点重建。

**先在隔离目录里量，再动依赖。** 逐条复现记录在案的失败并对照新 API：

| 项 | 0.8.6 结果 |
| --- | --- |
| D-019 原句 `FIND {type: "symbol", name: "exploreSearch"} RETURN *` | 返回正确行 |
| D-020 全零向量 `searchHybrid` | 返回命中；另有不带向量的 `TEXT BM25 / AC` |
| `indexedLookup({type, path})` / `({type:'link', value})` | 精确命中，支持布尔等值，未索引字段自动后过滤 |
| `substringLookup('nameLower', …)` | 命中；**要求 ≥3 个字符** |
| 索引持久性 | flush 后重开全在；**事后建索引会回填**已有行 |
| `maxResults` | 失败即错的行预算（默认 10,000、上限 1,000,000），不是 LIMIT；`maxQueryRows`/`rowOverflow` 只管 TQL |
| TQL `COUNT(*)` | 返回 `null`，不可用 |
| `flush()` 随库增长 | **未修**：1,768→25,568 节点 24.7→66.2 ms（0.8.5）对 28.6→73.0 ms（0.8.6） |

**然后差点被小规模骗过去。** 3,000 条的探针里一切都快；换到 25K–50K 节点，`indexedLookup` 取整类结果 2.7 s（O(N²)），
`getPayload` 单次 60 µs 且随库线性增长（0.8.5 恒定 1.7 µs），冷热两遍一样慢，Rom/Mmap 两种存储模式一样慢，关闭重开后仍慢 10 倍，
`compact()` 后回到最慢。逐个变量排除后定位到 **0.8.6 新加的解析 payload LRU 缓存**（`payloadCacheMb`，默认 64）：设为 0，
`getPayload` 回到 2.0 µs，50K 个 id 的 `indexedLookup` 从 2,689 ms 回到 42 ms；设为 1024 无改善——是簿记算法问题，不是容量问题。

决定：

1. **升到 0.8.6，`payloadCacheMb: 0`。** 没有这一条不升级：`getPayload` 是每条读路径的基础原语，10–30 倍且随规模增长的退化
   压过所有新能力。这一条已作为可复现报告交维护者转给作者。
2. **符号图的八张内存表换成原生索引。** 新增 `kind` / `value` / `nameLower` 哈希索引与 `nameLower` / `pathLower` n-gram 索引；
   符号 payload 多存 `nameLower` / `pathLower` 两个字段供子串查询（子串查询大小写敏感，`searchSymbols` 按小写比较）。
   路径查找、按值找 link、「该字面量是否已是确认连接」、名字子串候选，全部改为索引调用后 `getPayload`。打开时的全节点遍历删除。
   留在内存里的只剩两样：三个懒初始化、写时增减的**计数器**（通过索引数 24K 个 id 仍要约 20 ms，而 explore 每次查询都要问
   `symbolCount`），和一个任一写入即丢、读时懒重建的**形状缓存**（文件路径与语言、解析后的反向 import——解析是 Piarium 的规则，
   数据库不该懂，D-139）。形状缓存分两层，`catalogStats` 只碰便宜的文件层，import 解析只在 `findImporters` 真被问到时付。
3. **短词只精确匹配。** n-gram 拒绝 <3 字符的针，所以 `db` 只能精确命中 `db`，不再命中 `dbPath`，也不匹配路径；≥3 字符的词
   语义与原来的全扫描完全一致（候选集 = 名字或路径含该词的全部符号，评分函数不变）。
4. **整类与子串查询显式传 `maxResults = 1,000,000`**（API 上限），仍是超出即抛而非静默截断——派生数据的诚实失败方式。
   按路径、按值的小结果集查询同样传，不给 10,000 的默认值留意外。
5. **D-019/D-020 的绕路不在本刀拆。** 块/知识/事件的 JS 过滤是几百个节点的小事；`recall` 换 BM25 会改变召回排序，是产品行为
   变更。两处都记为「可换」而非「等修」。

复验数字（本仓库 2,359 文件 / 4,145 次解析 / 24,301 符号 / 14,024 边，同一脚本同一机器）：建目录 290.5 s → **256.7 s**；
`searchSymbols("explore", 20)` 17.1 → **11.5 ms**；`findLinks` 0.27 → 0.97 ms；`findImporters` 首次 125 → 147 ms（含形状重建）。
仍是对照数字，不是省时声称。

原因：查询模型不匹配这条论据被 0.8.6 拿掉了大半，「搬出 TriviumDB」的动机只剩 flush 增长一条——它更适合反馈作者而不是我们绕。
测量纪律再记一次：**只在小规模量过的结论不算量过**，这次三个探针里两个是在 25K+ 才翻的。

不改：知识/块/事件/会话的写入仍在各自写入里即时 flush（D-140 的边界）；`CATALOG_SCAN_BATCH`；import 解析规则（D-135）；
`resolveImportSpecifier`；`related` / explore 的接口。

未验证：Electron 打包后 0.8.6 的 `.node` 与新增 `.pld.<generation>` sidecar（代码里没有按文件名枚举/删除 `.tdb` 的路径，已查）；
多进程只读 Reader；v5–v8 → v9 的格式迁移只在测试临时库上发生过（plan 0.1：无存量用户）。

影响：`packages/web/package.json`（0.8.5 → 0.8.6）；`knowledge/store.ts`（打开选项、索引、八张表 → 计数器 + 形状缓存、
`searchSymbols` / `findLinks` / `connectionLiterals` / `catalogStats` / `findImporters` 改写）；`store.test.ts`（+4）；设计 7.5。

状态：已实施。

### D-143 · 2026-09-07 · 确认连接得先是真的：首参约束、awaited 泛型、提取器版本

类型：implementation

背景：D-142 的观察回路读完 10 问后直接查图：`findLinks("explore.search")` 里有 `harness-services.ts:585 connects register`——
问题 1 和 9 的精确答案。但请求端 `explore-tool.ts:31` 的 `await bridge.request<"explore.search">("explore.search", …)` **不在图里**。
外部设计评审（本轮由维护者委托的设计 agent）核实了两处提取缺陷并给出实验：`router.register(handler, "not-first")` 被提取成连接、
`register("a", "b")` 提取两条；完整 `explore-tool.ts` 提取不到请求端，去掉泛型参数就能。它的结论是「不能直接定为没写泛型查询」，
我的复现进一步定位到：**单独的泛型调用能提取，`await` + 泛型不能**。解析树给出了原因——tree-sitter-typescript 在 `await x.request<T>(…)`
处把 `await` 挂到被调用者上：`(call_expression function: (await_expression …) type_arguments: … arguments: …)`，
我们的查询要求 `function:` 是 `identifier` 或 `member_expression`，于是不匹配。本仓库所有 awaited 泛型 bridge 请求都是这个形状。

决定：

1. **查询加首参锚点。** `(arguments . (string) @literal)`——字符串必须是第一个命名参数。这是 D-106「字符串首参调用」本来就声明的语义，
   查询从未落实。修后 `register(handler, "not-first")` 不再是连接，`register("a", "b")` 只出 `"a"`。
2. **查询接受 `await_expression` 包裹的被调用者。** 不新写"泛型查询"——泛型参数本身可以省略匹配（tree-sitter 查询允许不写出其他子节点），
   问题只在 `await` 改变了树形。查询里的注释写明了这个树形，免得下次有人又去找泛型的原因。
3. **目录记提取器版本。** 目录是（文件内容 × 提取器）的函数，扫描的跳过条件却只看 `documentRevision`——修好的查询永远到不了内容没变的文件。
   `CATALOG_EXTRACTOR_VERSION`（`knowledge/symbols.ts`，现为 2）随每次 `replaceFileSymbols` 写进文件节点，扫描要求修订**和**版本都相同才跳过。
   这是缓存键不是 schema 版本：旧行不被读取或转换，而是从源码重算；D-105「无 schema version / 无 migration」不受影响。
   `touchFile` 保留该字段，测量脚本同样打版本号（D-140 的纪律）。

复验：新查询在六种形状上全部正确（非首参不提取、双字符串取一、awaited 泛型成员/标识符调用都提取、模板字面量不提取、
`explore-tool.ts` 提取出 `request("explore.search") L31`、`harness-services.ts` 仍是 37 条 register）。全库重扫 312.6 s，
2360 文件全部重采（旧行 extractor 为 null），**边数 14040 → 13459**——少的 581 条就是原来不合首参规则的假连接和假关联。
重问问题 9：连线补全**第一次触发**（`other end of connection "explore.search"` 出现在输出里）。

**但正确答案仍然没出现。** 连线另一端指向了 `symbol-graph-query.ts`——那是一条 `associates`（脚本里的 `findLinks("explore.search")`
调用），不是 `connects`：`explore.ts:771` 的循环不看 `end.kind`。真正的 `connects` 端 `harness-services.ts` 按代码路径已在 rg 候选池里，
被 `explore.ts:782` 的 `already` 跳过，进不了 `connectionPaths`，也就进不了补充物化。这两处加上词组内按路径字母序当 RRF 名次
（`explore.ts:310–316`，`bun.lock` 的 `b` 排在一切源码前面）是设计评审指出的三个排名/打包缺陷，属于 §3.13，本条不动。

原因：在让「确认连接」获得更大权重之前，先保证确认连接本身是对的——否则是在放大错误数据。评审把这一条放在报告末尾，
我把它排第一，理由是依赖顺序而不是难度。

不改：`classifyLiteralCall` 的允许名单（D-106）；D-109 闸门；`explore.ts` 的排名、物化、打包（§3.13）。

未验证：其他语言的 tags 适配器不受影响（它们没有 literal-call 查询）；JS/JSX 与 TS 共用同一份查询，测试只覆盖了 TS 形状。

影响：`structure/queries.ts`；`knowledge/symbols.ts`（`CATALOG_EXTRACTOR_VERSION`）；`knowledge/store.ts`（`extractor` 字段与
`SymbolGraphFileRelations.extractor`）；`knowledge/symbol-runtime.ts`（跳过条件）；`scripts/symbol-graph-query.ts`；
`tree-sitter-provider.native.test.ts`（+1）；`catalog-scan.native.test.ts`（+1）。

状态：已实施。

### D-236 · 2026-09-12 · 3.1 / 3.11 / 3.12（符号目录复用关联抽取事实）

类型：问题与解法

背景：D-109 把未确认的关联候选留到冷扫描末尾再访，但保存的只有路径。超过 32 条解析缓存后，再访会重新读文件、解析和替换整份符号图；D-140/D-141 的历史全仓观察中，一次扫描产生约 4,100 次解析，明显超过约 2,360 个输入文件。

决定：

1. 第一次抽取时，把关联候选的 value/line/callee 紧凑保存在当前 file 行，和 document revision、generation、extractor 一起发布。候选不建 link 节点，不进全文/关键词索引，也不保留源码或 AST。
2. 确认连接的同名闸门继续保留。补关系时在 store 写队列里使用当前文件代际和当前 connects 集合；只为已确认候选建立 associates 节点/边。连接被观察到移除时撤销关联，重新出现时可从保存的候选恢复，不重发旧符号。
3. extractor 升到 3，旧目录在下次扫描时重新采集。并发扫描只合并在飞工作；再次显式扫描仍枚举并读取文件修订，不能用“没收到 Documents 事件”推断磁盘没变。外部写入的可见范围仍沿现有目录观察契约。
4. 复用现有目录观察脚本，记录输入文件、结构采集请求、节点/边数量和墙钟。结构 API 请求数与实际 parser 缓存命中分别解释；历史不同语料不能充当受控速度对照。符号目录的改进不代表向量推理或完整语义索引的性能，不扩大解析缓存，也不新增索引开关或工作量硬限制。

原因：昂贵的步骤是重复获取已经抽取过的事实。同名确认只需要字面量和来源身份；保存这些事实比重读源码或为所有候选建图节点更直接。

验证与边界：具体反例和同口径观察记在 status 3.1/3.12。references/calls、外部文件系统的完整事件日志和真实 embedding 性能均不在本次实现范围。

### D-237 · 2026-09-12 · 3.1（目录重扫的删除对账）

类型：问题与解法

背景：D-236 的重扫会更新仍可枚举的文件，但外部直接删除后，旧 file/symbol/link 及其连接仍保留。旧文件搜索返回数组，无法区分完整空目录、读取失败和截断结果，不能直接以列表差集执行删除。

决定：

1. Host 文件枚举提供 complete/incomplete/failed 事实；取消停止请求。数组以非枚举 `enumerationStatus` 保持已有读取形状，此事实只在 Host 直接调用中使用，序列化或缺该字段的来源不得被当作完整 inventory。
2. 只有完整 inventory 才启动旧路径差集对账。Documents 确认 missing，并在读取旧图身份后再次确认；重新出现的 ready 路径交给 collector。删除在 store 写队列中核对预期 documentRevision/generation 和当前取消状态，不能用旧 inventory 删掉已发布的新图。
3. 删除 file/symbol/link 后沿 D-236 重算关联确认，最后一个 connects 消失时撤销关联。失败、不完整、未知和取消保留旧图，不另建 watcher、定时扫描或工作区快照。

验证：fs/search、catalog-scan、store、symbol-runtime 4 个文件 67 项通过，含真实外部删除、空目录、枚举失败/截断、重建竞态、写队列取消与代际条件删除；相关类型和 lint 通过。对账不锁任意外部进程，不宣称跨文件瞬时快照；它只改变可重建图，不删除用户文件。

### D-240 · 2026-09-12 · 6.2 / 3.1 / 3.3 / 3.8 / 3.12（解析后的 references/calls 进符号图与检索链）

类型：问题与解法

背景：符号图只有 tree-sitter 抽取的 defines/imports/connects/associates——「谁引用这个符号」「谁调谁」没有真实边，related 只能
回答文件级拓扑，explore 的图候选也只有静态边。语言服务已经能解析 references 与 callHierarchy（内置 TypeScript server 在
TS ≥3.80 时声明 callHierarchyProvider），缺的是把解析结果作为有修订语义的事实写回图、并让两个消费者真正消费它的生产接线。

决定：

1. 新增 `references`/`calls` 两类 link 行（`SymbolGraphRelationKind`），由 `recordResolvedRelations` 写入站点文件的当前
   generation，按 relation key（kind/value/target/anchor）重解析即替换而非叠重。行携带 `resolvedBy`
   （`lsp.references`/`lsp.definition`/`lsp.callHierarchy.incoming`/`lsp.callHierarchy.outgoing`）、站点修订、目标路径与写入时
   观察到的目标 catalog revision。
2. 修订语义沿用 D-087，不假装更强：锚点文件绑定磁盘 revision 才写（`pinned`）；跨文件站点是语言服务器自己的读盘结果，
   `documentRevision` 为 null、一律 unpinned；草稿绑定答案不持久化为图事实。目标文件 revision 移动后行报 `staleTarget`；
   目标文件被删除时指向它的行随 removeFileSymbols 级联删除；站点文件重新采集时旧 relation 行随 generation 消亡。
3. 解析入口是**有界**的 relation collector：围绕查询锚点，每个定义一次 references + 一次 definition + 一条
   prepareCallHierarchy→incoming/outgoing 链，不做仓库级扫描，也不冷启 LSP。lsp.references/lsp.definition 的磁盘绑定结果
   经 `recordRelations` 写回（write-behind），写失败不挂起导航结果；related.query 对名字锚点的每个精确匹配定义做一次
   collect（≤8 个定义），collector 不在时只回答已存行。
4. 消费者：`related` 增加 references/calls 两段（名字锚点答已存站点与双向 call 边、路径锚点答本文件站点与指向本文件的
   call 边），per-source 状态区分 ready/empty/unavailable/unsupported/partial/failed；`explore` 把 stored 关系边作为第二路
   路径候选（relation 预算 8、权重介于 import 与 connection 之间、arrival 仍为 object-triggered），并在 `details.relations`
   摘录注解里展示带 pinned/staleTarget 标记的站点。
5. supervisor 增加 `prepareCallHierarchy`/`callHierarchyIncoming`/`callHierarchyOutgoing`，item 以会话作用域 token 往返
   （下一次 prepare 清空前次 item）；能力门读 `callHierarchyProvider`，缺能力报 `unsupported` 而非失败。内置 TypeScript
   语言服务侧实现真实 `ts.LanguageService` 解析：definition/references/prepareCallHierarchy/incoming/outgoing 均来自
   `getDefinitionAtPosition`/`findReferences`/`prepareCallHierarchy`/`provideCallHierarchy{Incoming,Outgoing}Calls`，
   项目按工作区根目录脚本枚举，未打开文件经宿主 `ts.sys` 读盘——这正是 unpinned 的来源。

验证与边界：store 层覆盖 relation 行的写入/替换/pinned/staleTarget/级联删除/代际消亡；collector 经真 supervisor+fixture
进程验证 collect→持久化与 piggyback record；fixture server 改为按已同步正文解析（identifierSites/callSites），测试 TS
server 用真 ts.LanguageService 并在宿主读盘下探到未打开文件；supervisor 覆盖 callHierarchy 三方法、token 生命周期与
unsupported；related 覆盖 resolved 段输出与 collector 接线；explore 覆盖 stored 关系边进候选；lsp-nav 覆盖磁盘绑定写回与
草稿不写回。related 的 collect 上限 8 个定义、每定义各一次请求，超出即 `incomplete`；references 边只来自真实查询，
不会主动铺满全图——冷启动工作区的 resolved 覆盖随查询增长，这是有意设计不是缺口。PageRank/多跳扩展仍未做。

### D-246 — D-240 返工：resolved references/calls 生产边界修正

背景：D-240 接入了 references/calls 边与 relation collector，但验收发现五处生产边界缺陷——
LSP 工作区根从首个打开文件的父目录推断、related/explore 未应用 actor scope、权威重解析靠逐个
非空 path 写入无法清掉消失 site、组合状态把任一方向有结果标 ready、explore 公开链未暴露
findReferences/findCallers/findCalls。

决定（supersedes in part D-240 的根推断、scope、批次重解析与组合状态部分；D-240 的 collector +
lsp 导航回写 + related/explore 消费主体保留）：

1. **LSP 工作区根来自 initialize**：`TypescriptWorkspaceOptions.workspaceRoot` 在构造时接收
   真实根；`setWorkspaceRoot` 在 LSP `initialize` 后设置。不再用 `path.dirname([...files.keys()][0])`
   推断。无根时回退 `process.cwd()`，不从首个文件父目录猜——`src/a` 下首个文件不会让 `src/a` 成为根，
   `src/b` 下的 caller 因此不可达（有反例测试）。
2. **actor scope 贯穿 related/explore**：`related-service` 传 `ctx.workspaceScope` 给
   `executeRelated`；`related-tool` 对定义候选、importers、connection otherEnds、references、
   callers、callees、file relations、collector 输入与 LSP 返回站点统一用 `pathInRoots` 过滤；
   `relations.ts` collector 对 LSP 返回 reference/call 站点与持久行按 roots 过滤——范围外内容既不
   返回也不写入图。
3. **权威 anchor 批次重解析**：`KnowledgeStore.replaceResolvedRelationsForAnchor(anchor, rows)`
   一次性删除该 anchor 的全部旧行再插入新行。批次身份是 anchor（path+line），不是逐个非空 path
   写入——结果从两条缩到一条或缩到空集都能清掉消失 site。不同 anchor 的行不受影响。
4. **partial 组合状态**：`RelationSourceStatus` 新增 `partial`。incoming/outgoing 任一方向
   failed/stale/unavailable 时，另一方向有一条结果不能把整组标 ready——collector 的 calls 状态
   与 related-tool 的 relationStatus 都遵循。
5. **explore 公开链暴露 references/calls**：`bindExploreGraphRecall` 接入 `findReferences`、
   `findCallers`、`findCalls`；`fileRelations` 映射包含持久化的 reference/call 行及其 pinning/
   resolvedBy 元数据。不再只在底层 `explore()` 单测里手工注入。

owning/execution/fixed-view 权威：图库归 owning workspace；当前正文、scope 与路径核验归
execution/WorkingBranch 固定视图；无法证明图关系适用于当前固定视图时标 stale/unavailable，不把
live 父图当 child 当前事实。

验证：`typescript-service.test.ts`（显式根、嵌套首文件 cross-file、无根回退 cwd、setWorkspaceRoot
生命周期）；`related-scope.test.ts`（scope 过滤定义/引用/importers/connections、anchor 外拒绝、
权威重解析两缩一缩空、不同 anchor 隔离、partial 组合状态、pathInRoots 一致性）；既有 related-tool /
explore / explore-query-services / explore-service / knowledge/store / knowledge/relations 套件
回归通过。局限：scope 在 Windows 上大小写不敏感（`pathInRoots` 归一），非 Windows 区分。

### D-290 · 2026-09-18 · 3.11（编程语言支持开箱即用）

类型：默认值调整

决定：常用语言结构包随发行提供完整 wasm + 查询；Node 型语言服务器随应用内置；较大的原生服务器在首次实际请求时自动准备。用户不再需要逐项安装基础语言支持。此决定更新 D-124 的手动准备默认与 D-128 的无查询包交付方式，原有外部配置、项目正文和语言进程权威不变。

原因：用户明确要求 agent 面向常见项目开箱即用。轻量语法包的空间节省不足以抵消首次检索缺能力的损失；语言服务器需要按项目启动，但不要求用户了解包名、命令行和可执行路径。

实施边界：

- 结构包以已提交的版本和摘要构建，缺查询的常用语言补提取规则。原生 kernel 仍是运行期结构计算权威，不添加 Host 解析后端。
- 保留 TS/JS 内置扩展，新增 Python、HTML/CSS、JSON、YAML、Shell 的发行语言扩展。资产自包含、随版本固定，不在用户电脑运行 npm 安装这些服务。Markdown 使用独立 Marksman，不使用依赖 VS Code 专属解析/文件 RPC 的 extracted Markdown server。
- Rust、Go、C/C++、Markdown 由 Host 管理私有准备目录，优先复用可用本机程序。Rust/clangd/Marksman 校验固定官方资产摘要；gopls 使用已有 Go 工具链和私有安装位置。服务器的安装不替代项目 SDK、依赖和构建配置。
- 状态查询无下载、无进程启动；真实 LSP 请求或用户“立即准备/重试”才准备。并发请求共享准备，取消不遗留可执行半包；关闭 Host 中止准备并回收所属进程。
- LSP 继续经同一 Supervisor 和 Rust 进程监督运行。补齐 server→client 的配置/工作区请求，双向请求 ID 分开匹配；服务器不能绕过 Documents 自发应用编辑。
- 设置展示结构检索和代码分析能力，将“已内置、按需启动”与“不支持、失败、缺项目运行环境”分开。ABI、包名、导入 wasm 放在技术详情。

影响：extension-builtins 的发行资产与注册、Host structure/LSP/language-support、Application Client 状态 DTO、设置页和十种语言文案、plan 3.11、status。

状态：已实施。15 种新增语法经原生提取验证；六个 Node provider 从复制产物的真实扩展 activate → descriptor → initialize → symbols/hover 验证，Python 另经 Host/Rust 进程链返回类型诊断；Windows 官方 Rust Analyzer/Marksman 下载与原生进程 smoke 通过。具体边界见 status；Java/C# 等尚未接入的服务器不标可用。
