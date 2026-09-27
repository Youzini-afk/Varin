# Agent harness — 知识库（优先保留 TriviumDB）

Status: 模块专卷，自 [agent-harness.md](agent-harness.md) 拆出（原文第 知识 节起）；本文保留原节标题层级与锚点。
交付事实见 [../status.md](../status.md)，计划骨架见 [../plan/agent-harness-plan.md](../plan/agent-harness-plan.md)。

## 7. 知识库（优先保留 TriviumDB）

TriviumDB 是当前实现选择，不是不可替换的产品前提（D-071）。遇到具体问题先向用户交付版本、重现与影响，由用户联系作者处理；
当前不迁移 SQLite，也不建设第二个可写知识权威。上层使用 Varin 领域操作，不暴露占位向量或 TQL 绕路。

### 7.1 归属与位置

Application Host 内一个 `knowledge` 服务，通过 napi 进程内加载 `triviumdb`，无服务、无端口。**权威知识存储**每 host 每
workspace 一个文件：`VARIN_DATA_DIR/knowledge/{hostId}/{workspaceId}.tdb`，与
`document-recovery/{hostId}/...` 同构，遵守"另一个 host 不继承同路径选择"的既有不变量。Application Host 是
唯一写者；session worker 与子 agent 只读（TriviumDB 的共享只读 Reader 模型）。

"一个文件"说的是权威知识（events / blocks / knowledge / 符号图），不是全部派生数据。这份库在打开时按配置的嵌入维度定
单一 `dim`（`store.ts`），所以**代码语义索引不进这份库**（3.16，D-161）：代码向量是独立的、可重建的**代际存储**，仍用
TriviumDB，仍由 Host 唯一写。用户换嵌入模型或维度时作废并重建的是这个派生索引，不牵动 blocks、knowledge 与结构图；
它不是第二份可写知识权威，因为它随时能从当前正文重算出来。

代际存储按**范围键**而不是工作区命名（D-162）：`knowledge/{hostId}/semantic/{scopeKind}/{scopeId}/{spaceId}/{generation}`，
`scopeKind` 现在只有 `workspace`，将来有 `roots` / `working-set` / `collection` / `user`；同一台机器上不同范围的索引并列存放、
共用向量空间身份与配方身份，一个范围重建不牵动另一个。索引里的**文档身份是 `{ scopeKind, scopeId, documentId, revision }`**，
`documentId` 对文件范围是相对路径，对将来的连接器范围是连接器给的稳定标识——不把"文件路径"焊进块身份或父单元身份。
已交付（D-167）：路径构造与查询签名只接受范围键；`workspaceScope` 是 `workspaceId` → `scopeId` 的唯一处。

"桌面 + `varin serve` 同机同目录"的两个 host 问题已决定：`serve` 启动时检测到桌面 host 在运行则**复用它**，不起
第二个——一个用户、一台机器、一个 host，知识库与恢复日志都不必面对同一工作区的两份。

### 7.2 基础 schema

六种基础节点类型，profile 可追加不可修改：

| 节点 | 向量 | payload | 文本索引 |
| --- | --- | --- | --- |
| `event` | 事件文本 embedding | `kind`（edit / command / diagnostic / decision / turn）、`at`、`sessionId`、`turnId`、引用 | 事件原文 |
| `file` | 文件摘要 embedding（可选） | `path`、`language`、`modified_at`、`dirty` | 路径与符号名（AC 关键词） |
| `symbol` | 签名 + 文档 embedding | `name`、`kind`、`range`、`file` | 符号名（AC 关键词，精确命中免分词） |
| `session` | 无 | `sessionId`、`profile`、`workspaceId` | 无 |
| `block` | 无 | `sessionId`、`label`、`content`、`revision`、`updatedBy`（agent / user） | 块内容 |
| `knowledge` | 内容 embedding | `scope`（workspace / user）、`content`、`trigger`、`status`（suggested / accepted / dismissed）、`valid_at`、`invalid_at?`、`source`（sessionId、来源种类）、`recalledAt?`、`recallCount` | 内容与触发描述 |

`block` 保留 plan/todo 与用户维护的会话笔记，随会话生命周期；不再要求后台模型维护 progress/decisions 等连续性块。
续接摘要属于 Pi 会话的 compaction 表示，不是知识库 block。`knowledge` 是跨会话的持久条目；会话里的判断不会因为
进入摘要而自动晋升为知识，晋升仍走第 7.2.2 节的审阅流程（D-284）。

基础边：`session → turn(event)`、`event → touched → file`、`event → about → symbol`、`file → defines →
symbol`、`symbol → calls | references | imports → symbol`、`event → fixed_by → event`、`session → owns → block`、
`knowledge → supersedes → knowledge`、`knowledge → derived_from → session`。边带权重（LSP 引用数、时间衰减）。

### 7.2.1 保留与用户级存储

保留策略可配置，默认按时间自动清理：原始 `event` 节点与已结束会话的 `block` 保留 **30 天**后清除（Settings 可改）；
`knowledge` 与 `symbol` / `file` 结构节点不受时间清理影响。删除一个会话级联删除其全部
`event` 与 `block`，与恢复日志的 scoped deletion 同一语义。清理在 host 空闲时段执行，以 TriviumDB 事务进行，不影响
Reader。

用户级记忆存在但刻意轻：独立文件 `VARIN_DATA_DIR/knowledge/{hostId}/user.tdb`，只有 `knowledge` 一种节点，不存
event、block 或文件内容。`recall` 先查工作区库再查用户库，用户库命中在结果中标明来源。

### 7.2.2 持久知识的治理：提议、审阅、取代

持久知识的写入遵循 Devin Knowledge 的形状，更新遵循 Zep 的双时态模型：

- **agent 不直接写持久层，只提议。** 用户标记与已配置的用户消息 knowledgeSuggestions 路径生成
  `knowledge` 建议，`status: suggested`，每条应带**触发描述**（什么时候该想起它，语义
  匹配用）。建议进入审阅托盘；用户编辑后接受、要求重新生成、或驳回。agent 也可以对已接受的条目提议更新。建议的
  草拟与触发描述的生成使用 `models.knowledgeSuggestions` 槽位（第 8.5 节）；未配置时，建议以用户标记或纠正的原文呈现、触发
  描述留空由用户填写，不调用主模型。
- **自动接受是显式选项**，按作用域单独开启（workspace 级、user 级各自），默认关闭。关闭时没有任何东西不经用户看到
  就成为持久知识——这是"保证持久层就是用户的意愿"的机制。
- **更新用取代，不用覆盖。** 与已接受条目冲突的新条目被接受时，旧条目标 `invalid_at`，新条目带 `valid_at`，两者由
  `supersedes` 边相连。不删除、不改写历史；"当前有效"是一个查询（`invalid_at` 为空）。UI 默认显示当前有效条目，
  可展开取代链。
- **召回按触发相关性，不全量。** Zone 2 只放触发匹配当前工作的条目指针；每次召回记录 `recalledAt` 并累加
  `recallCount`。
- **保留由用户裁剪，不按时间过期。** 持久条目没有自动过期；被取代的默认隐藏；Settings 列表按 `recallCount` 与
  `recalledAt` 排序，长期未被召回的条目提示用户裁剪或归档。
- **作用域晋升逐级审阅。** session（块）→ workspace（`knowledge`）→ user（`user.tdb`），每一级晋升都是一条新的建议。

Settings 提供列表视图：每条可见、可编辑、可删除、可查看取代链，并记录来源（哪个会话、由哪类时刻触发、谁接受）。
删除是对该 id 写 `invalidAt`，不物理删节点，也不扩大到其他 scope 或相邻历史。权威正文仍在 workspace/user `.tdb`；
派生向量随同一套 store 变更失效。`models.knowledgeSuggestions` 配置后由 pi-host 对用户消息草拟建议并经 Host 落库；
未配置时保留用户标记，不借用主模型。D-284 删除依赖 keeper decisions 的自动建议来源，不从续接摘要另起知识提炼调用。
已有建议、accepted 条目与取代链保留；未接受、已驳回或已被取代的条目不进入公开 recall。

Settings 目录与会话审阅托盘的写操作携带用户打开条目时的 content、trigger、status 与 invalidAt，store 在同一写队列内核对完整期望修订、scope 和当前状态后
再修改；工作区或作用域切换会使旧选择和迟到响应失效。模型提议的 Host 入口只接受正文与触发描述，workspace 与 `user-message`
来源取自已认证 actor，不能由 worker 自报。规范化正文的历史去重和插入也在同一个写队列操作内完成，包含 dismissed/retired，
所以并发相同提议不会生成两个节点或复活旧建议。用户标记与模型提议都读取同一会话的有效 auto-accept 设置；
trusted project 只能调整 workspace scope，设置不可读时保留 suggested 而不自动接受（D-211）。

### 7.3 写入者

- Document Registry 在成功提交 `write/move/delete` 后发布带已校验 writer owner 的结构化事件；观察失败不反噬文件提交。
  同 workspace 的活动会话各保留自己的 event，agent writer 的事件留作轨迹但不进入 Zone 2。LSP 诊断只有紧跟用户编辑的
  error/warning 才作为“新诊断”投影，避免复述 agent 已在工具结果中见过的诊断。Git status 已复用现有刷新边界接入。User
  terminal 的命令正文、cwd 和退出码只来自本次 session integration 发出的带代际标识的 OSC 133/633 帧；没有
  shell integration 时不编造命令，来源为 `not-observed`，终端仍可正常使用。未带本代际标识的 OSC 或普通程序输出
  不生成命令。代际标识是来源绑定的 shell 观察，不是无法伪造的安全身份。`/bin/sh` 不按 Bash 注入 `--init-file`。
  默认注入不得破坏用户已有 PROMPT_COMMAND / DEBUG trap、zsh login/profile hooks 或 PowerShell Enter/prompt。
  命令与 cwd 进入 Zone 2 前要编码，使 `</user-terminal>` 与控制字符不能关闭标签或变成新指令块。
  每个目标 Pi session 的幂等写入落在 knowledge `putEvent`，键为 `targetPiSessionId + commandId`：同一终端命令会分别送达
  工作区内各活动 Pi 会话，而对同一目标的重复投递不二次入库或注入。PowerShell 只在 `$LASTEXITCODE` 相对命令开始基线
  发生变化时把 native 非零码归给本命令；无法证明时记录 1，因此连续相同 native 非零码不声称精确。
  产品链没有 PTY 重播，因此不声称 Host 重启去重。Harness `bash` 不注入该脚本，也不进入 Zone 2 `<user-terminal>`。
  用户命令、steering、用户计划修改和子线程返回作为各自真实通道的新材料送达；D-284 移除这些事件对 `memory.nudge` 的依赖。
  事件可以增加下一次请求的容量估计，但其类型、完成与空闲本身不触发摘要。
  `kind: edit` 的 event 最终引用恢复日志中已存在的 before/after 内容对象，不再复制一份 diff；恢复日志是唯一的逐路径编辑真相源。
- 主 agent 的 plan/todo 与用户笔记使用既有 block 分支/CAS 写入，不由摘要任务回写。用户修改的成功修订进入尾部观察。
- `knowledge` 建议（第 7.2.2 节）由用户标记与显式配置的 knowledgeSuggestions 路径生成，保持审阅与 auto-accept 策略。
- 用户的“记住这个”沿标记/建议入口保留原意；不为压缩启动额外模型，不给历史附加机器重要性评分。
- profile 自己的采集器（research profile 的文献抓取等）。

### 7.4 读取者

`recall(query, k?)`（`search_hybrid`：AC + BM25 + 向量，再 SA-PPR 扩散；`knowledge` 按触发描述匹配）、`related`
（第 6.2 节）、Zone 2 组装（相关知识的新指针与用户修改）、UI 计划面板、知识审阅托盘、research profile 的图查询。
上下文压缩读取 Pi 当前分支与必要的已交付事实，不以知识库滚动块作为连续性的前提。

### 7.5 已知约束与要求

当前钉住 **0.8.6**（D-141）。下面按「已在该版本核实」与「历史记录」区分；向作者报告数据库本身的类型处理、检索语义和能力边界，
不要求数据库适配 Varin 的领域模型。block 修订、分支归属及代码分词策略由 Varin 自己负责。

- **0.8.6 已核实**：D-019 的 TQL 字符串字面量错误与 D-020 的全零向量空结果都已修复（原句复现通过）；`indexedLookup` /
  `substringLookup` 提供不经 TQL 解析器的索引查找，索引持久且事后创建会回填。符号图的查询据此改走原生索引，不再在 JS 里维护
  一套并行的内存表。三条必须知道的约束：`maxResults` 是失败即错的行预算（默认 10,000、上限 1,000,000），不是 LIMIT；
  n-gram 子串查询要求 ≥3 个字符；**默认开启的解析 payload LRU 缓存把每次 `getPayload` 变成 O(库大小)**（50K 节点时 60 µs
  对 0.8.5 的 1.7 µs），Varin 以 `payloadCacheMb: 0` 关掉它——这是数据库侧的缺陷，已向作者报告。`flush()` 仍随库大小
  线性增长（两版一致），D-140 的派生数据去抖 flush 保留。

- **embedding 后端与存储分别负责**（D-173/D-190/D-196/D-198）。TriviumDB 存向量不产向量。代码语义与知识召回的远程路径都是
  `harness.embed` → OpenAI 兼容 `/embeddings`。知识向量是引用权威知识身份与正文修订的派生代际库，换维度不重开
  workspace/user `.tdb`。未配置远程时知识召回保持文本，不使用本地 MiniLM，也不把 placeholder 向量标成 `via:vector`。
  知识复用同一个代际存储、编码文本缓存和调度器，以独立 scope 隔开代码语料。打开与空间变更做对账，普通知识变更合并受影响 id 并立即使旧发布失效；
  自动维度由真实输入解析后继续建设，长条目完整分块。一次 workspace/user 召回固定远程绑定，按有效状态、修订和 scope 约束后选择知识条目 Top-K，
  多个块不占多个条目名额，文本/向量名次在两种范围内统一融合。取消结束本次等待，Host 关闭时收尾后台建设；绑定失败不阻断已有文本结果。
  后端选择、query/document 用途、缓存身份与取消契约见第 6.1/8.5 节。
  - 未绑定向量的知识库继续提供文本和图能力；当前 `recall` 在有效绑定时对已接受条目做 scoped Top-K 再与文本 RRF 合并。
    不把规划中的 BM25 当成已接。
  - 维度取所选后端实际支持的配置并写入空间身份，不假定所有模型支持同一种截断。切换空间重算派生向量，不混用新查询与旧空间；
    原始知识与代码向量的所有权保持分开，不为代码模型切换重写权威知识库。
  - 用户显式配置远程后端即按该绑定调用，沿现有 provider 凭据与项目受信规则，不另设 embedding 信任门或费用守卫（D-158）。
  - 需向 TriviumDB 确认无向量节点的支持；不支持则以最小维度占位向量建库并禁用向量检索路径。历史记录（D-020）：
    v0.8.5 上全零占位向量的 `searchHybrid` 不报错但返回空结果，因此占位模式下 `recall` 走 JS 层扫描 + 词项匹配。
    **0.8.6 已修**：全零向量的 `searchHybrid` 返回命中，TQL 另有不带向量的 `TEXT BM25 / AC / HYBRID` 稀疏入口。
    `recall` 的 JS 扫描目前仍在——换成 BM25 会改变召回排序，属于产品行为变更，未随存储升级一并动（D-141）。
- **TQL 字符串字面量**（D-019，历史记录）：v0.8.5 上 `FIND {type:"block", sessionId:"s1"}` 报 napi 类型转换错误，知识库改用
  `allNodeIds()` + `getPayload()` 在 JS 层过滤。**0.8.6 已修**。符号图查询已改走 `indexedLookup` / `substringLookup`；
  块、知识、事件那几处 JS 过滤仍在（单会话数百节点，成本可忽略），不再是「等修复」而是「可换但没必要急」（D-141）。
- **分词职责**：现有记录描述 tokenizer 为 ASCII 字母数字段 + CJK 2-gram、camelCase 不拆分，本轮未复核最新上游。
  数据库可说明 Unicode、可配置分词或预分词输入等通用能力；camelCase/snake_case/路径的代码分析策略由 Varin 拥有并版本化，
  不要求数据库为了 Varin 内置一套代码语言分析器。当前 searchSymbols 是 JS 字符串计分，不声称已走 AC/BM25 排序。
- **native 模块**：系统存储与 PTY 已由打包在 `resources/kernel` 的 Rust executable 接管，不再发行或重建
  `better-sqlite3` / `node-pty` / `bun-pty`。Electron 仍核对 TriviumDB 与 `sherpa-onnx-node` 的目标平台预编译，
  并在打包前、after-pack 与 unpacked smoke 中核对 kernel manifest、架构和摘要（D-282）。
- **两个 host 同路径**：按 `hostId` 隔离；`serve` 复用运行中的桌面 host（第 7.1 节），因此正常情况下同一机器只有一个
  host。
- **数据安全**：知识库含文件内容与命令文本，按工作区数据对待——不进日志、不进事件载荷、不进 URL，与
  documents 模块同规。
