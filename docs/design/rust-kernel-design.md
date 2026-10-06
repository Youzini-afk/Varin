# Rust 系统内核与 Host 分层

Status: implemented architecture; R0–R6 and Stage R complete through D-282.

Last updated: 2026-10-06

本文规定 Varin Rust 系统内核的当前职责和跨进程契约。R0–R6 的实施记录见
[历史计划的阶段 R](../archive/agent-harness-plan-2026-10-06.md)，实际交付只看
[status.md](../status.md)。本阶段以长期稳定性、工作区规模、并发执行和可维护性为目标；
不是原生加速函数试验，也不以完成一个存储 helper 宣告整体迁移完成。

R1 已将 WorkingState root/revision、内容对象与 Recovery/Integration durable metadata 接到唯一 Rust writer；内置 storage 固定共址于 application data，Registry 继续拥有未保存正文。D-278 通过真实反例修复物理租约、owner、GC、重试和实际 root admission，并重新打开 R2/R3；D-279 随后完成 low-level pending operation 的 Host-visible disposition/reconcile，以及 kernel/Git/Registry 的 durable materialization handoff 和真实 setup 退出确认。D-280 把实际 PTY/pipe、process tree、原始输出与 writer 生命周期接到 Rust。D-281 再把固定 WorkingState pin、live revision-bound file search/inventory、native tree-sitter structure/chunks 以及 symbol/semantic 索引输入接入同一 kernel compute boundary，并删除生产 TS ripgrep/branch-corpus/Host AST 扫描路径。D-282 完成 transport/request-credit、发行 surface、旧 authority 清理、真实 release smoke 与受控资源测量；R0–R6 现均按各自可执行契约完成。[审查记录](../archive/rust-kernel-audit.md) 保留 D-278 的历史缺口与 D-279 的关闭证据。

## 1. 产品与阶段目标

Varin 是拥有工作台和 Agent Harness 的独立产品，默认内置钉住版本的 Pi。Pi 提供 Agent loop、模型/provider、
会话树和扩展生态；Varin 拥有工作状态、工具环境、任务治理与用户交互。产品归属不要求统一实现语言。

目标架构由三部分组成：Rust 系统内核、TypeScript Application Host/产品层、TypeScript/Node Pi worker。
Rust 负责文件与资源的实际操作、工作状态和恢复事务、进程/PTY 底层、文件与结构计算；TS 负责模型和任务策略、
公开 API、编辑器协调、知识领域操作与呈现。Electron、Web/远程与移动端沿同一服务契约使用内核。

本阶段必须形成这些结果：

- 工作状态的根、引用、修订和恢复操作在明确的事务域内发布，实际写入者只有一个。
- 工作区规模增长时，单路径编辑与已有快照的分支创建不反复复制全仓元数据；重计算不占据 UI/Host 请求循环。
- 虚拟分支、物化目录、用户磁盘和未保存缓冲的身份及转换可追溯；终止、取消、故障和重启不产生假完成。
- 同一 shell 进程继续服务用户终端与 Agent 工具；文件/搜索/LSP/任务消费者使用相同的资源身份。
- 发行包包含真实可启动的内核，运行不要求用户安装 Rust 工具链；旧实现随各职责接管删除。

语言不是正确性证明。Rust 的资源所有权和类型检查用于表达约束，锁顺序、文件外部修改、哈希定义、事务阶段与
恢复仍需设计和验证。不得把已经发现的 TS 缺陷原样翻译，也不得把模型/网络等待归入 Rust 性能收益。

## 2. 最终进程边界与职责

```text
Electron / Web / Mobile surface
    | 既有 authenticated application / runtime API
    v
TypeScript Application Host
    |-- public routes, actor admission, Documents surface coordination
    |-- Thread/Run product lifecycle, knowledge, context, model orchestration
    |
    | 私有、有代际身份的进程管道
    +--> Rust system kernel
    |      |-- workspace resources, working state, object references, recovery
    |      |-- capture, Git adaptation, materialization, disk mutation
    |      |-- PTY / managed command and language-tool processes
    |      `-- fixed-view file search, traversal, structure computation
    |
    `--> runtime-broker --> Node Pi session / catalog / inference workers
                              `-- bundled Pi SDK / explicit user runtime
```

每个实际 Application Host 实例管理一个 Rust 内核进程；内核内按工作区和存储位置隔离资源，不按 Thread 建一套内核。
现有桌面/serve 的 Host 复用保持。相同存储位置的写入所有权还须由进程间锁保证，不能只靠“通常只有一个 Host”。
Rust 不监听新的公共端口，renderer/Pi 扩展不直接连接它。它是共享 Application Host 的系统后端，不是 Electron 专属的第二套服务。

| 责任 | 最终权威 | 边界 |
| --- | --- | --- |
| 模型、凭据、Pi 会话与包 | Pi worker / 原生 Pi 存储 | Rust 不加载 Pi 扩展、不读 provider secret、不重建会话树 |
| Thread/Run、角色、队列、review/retrieval、用户策略 | TS Host / Thread catalog | Rust 使用经授权的 Thread/Run 身份；不再建一个调度器或 Thread catalog |
| workspace/root 注册与 actor 授权 | TS Host 注册意图，Rust 验证并持有文件资源身份 | owning、execution、storage root 分开；实际文件访问在内核核验 |
| 分支、快照、结果、草稿、verification/review、retrieval artifact/receipt、内容对象、引用 | Rust 内核 | TS 只持 ID、修订和短生命周期投影，不直接打开同一可写存储 |
| 未保存缓冲、文档实例、grouped undo | 现有 Document Registry | Documents 保留公开入口；Rust 不另存一份可变编辑器权威 |
| 受控磁盘写入、路径 gate、条件补偿 | Rust 内核 | Documents、Files、Git/任务写者等现有消费者全部纳入同一资源边界 |
| shell/终端的 PTY、进程状态、原始输出及 writer 生命周期 | Rust 内核 | TS 保留命令展示/上下文投影；UI 与工具使用同一 handle |
| Pi worker 的创建、协议与会话生命周期 | TS runtime-broker | 不在本阶段重写 Pi broker；其执行写者向内核注册，并由真实进程证据释放 |
| LSP/DAP/测试协议、语言视图和诊断策略 | TS 领域服务 | 通用子进程与字节流走 Rust；内置 TS LanguageService 继续留在 TS |
| 文件遍历、固定视图搜索、结构解析/切块 | Rust 内核 | 复用成熟搜索/解析实现；输出绑定实际正文修订和 scope |
| 知识 `.tdb`、符号图/语义代际库、远程推理绑定 | 现有 TS adapter 与 TriviumDB/Pi | 不因换语言迁移知识数据库，不复制向量库/密钥；原生数据库计算继续复用 |

Rust 代码按协议、工作状态/存储、工作区、进程、检索模块划分。拟采用一个 Cargo workspace 和一个可执行入口，
TS 增加私有 kernel client；具体 crate/package 拆分服从这些依赖边界，不按工具名拆成多个服务。
共享 wire schema 在内核协议模块定义，生成 TS DTO/schema 并验证运行时输入；不手工维护两份漂移的契约。
前端的 `application-client` 和 Pi 的 `protocol` 保持各自的公共契约，由 Host 适配，不泄露数据库结构。

D-266 已把当前单 crate 的实现按这些边界落地：`main.rs` 只启动 library；`runtime.rs` 持有 framed transport、握手、
admission 与取消；`storage/mod.rs` 是唯一 SQLite/对象根/锁/取消/在建流 owner；授权、对象、不可变状态树、分支、typed
Recovery、领域记录、GC/完整性和幂等事务分别位于 `storage/` 子模块。它们仍共享同一 `Storage` 和事务域，不能各自打开连接。
协议 runtime 通过统一的授权 dispatch 进入领域实现，避免重新暴露一组可绕过身份检查的底层方法。

## 3. IPC、权限与执行身份

控制消息使用有长度帧的结构化编码，经 Host 创建的私有管道传输；正文/PTY 等大数据按可背压的数据流传送。
stderr 用于诊断，不与协议混流。文件正文不通过整树 JSON、base64 全量目录或逐字节 RPC 传输。
操作按领域批量执行，例如 pin view、read ranges、apply edits、publish result、integrate、materialize、spawn/attach。
TS 不通过通用 SQL 或“任意磁盘写”接口绕过领域不变量。

握手绑定 application build、protocol version、Host generation、kernel epoch 和可用能力。发行包内 client/kernel 使用匹配协议；
版本不匹配、二进制缺失和启动失败分别诊断，不悄悄切回旧 TS 实现。没有消费者的未来版本兼容框架不在本阶段建设。

Host 从 broker/session registry 确认 actor 后，向内核注册 grant。grant 绑定 Host/worker generation、session、Thread/Run、
owning workspace、execution view 与允许的能力/路径；不适用的身份显式为空。模型给出的 queryId、路径、branchId 不能当授权。
内核自行检查路径别名、符号链接/重解析点、受管根与存储位置；嵌套 scope 只继承或收窄。跨进程权限撤销先阻止新操作，
排队请求和每次实际副作用重新核对代际；已经完成的副作用按真实状态记录，不倒写成“从未执行”。

每个请求带关联 ID；有持久副作用的请求另有 operationId、目标身份及期望修订。连接中断不能确定操作是否执行：
重连查询原 operation，不重放 bash、删除或已提交编辑。相同 operationId 不得接受不同参数；旧 epoch 的瞬时句柄失效，
耐久结果/operation 可以经重新授权取得。取消区分未启动、已停止等待、执行已中止和已提交；提交后取消不撤销成功事实。

跨语言修订/字节偏移的编码不得超出 JS 可精确表示范围后静默取整；大整数按 schema 使用无损表示。
文本行列与 UTF-8 字节游标保持既有区别，二进制不文本化，平台路径不使用有损转换。Rust 内部以不同类型表达
owning/execution/storage 身份以及读/写/发布能力，私有构造器限制租约来源；类型检查辅助运行时授权，不能替代它。

数据流满时使用传输背压；控制帧之外的 `data` 帧只承载有序正文块，前台读取/编辑与后台扫描分开调度。队列、磁盘和输出沿现有配置，外部能力约束如实表达，
不为换语言新增任务数、文件数、token、大小或运行时长硬上限。需要切批由真实资源和取消响应选择，不把调度预算变成功能拒绝。

## 4. 存储、根与持久发布

工作状态复用现有 recovery storage 的 SQLite + 内容对象模式；这是已有恢复库的内核接管，不是把 TriviumDB 换成 SQLite。
在同一选定存储位置内，分支根/修订、结果、草稿引用、verification/review、retrieval evidence/receipt、树节点、对象所有者和恢复 operation/checkpoint 元数据归一个事务域。
不继续用整份 WorkingState JSON 加另一份 SQLite 引用表作为两个写入权威。

### 4.1 内容与树的身份

- blob 身份为原始字节 SHA-256，保留编码、BOM、换行和二进制。导入/使用对象路径前校验内容身份，CoW 不绕过验证。
- 路径状态复用 missing/file/directory/symlink/unsupported。持久哈希包含类型、完整声明字段、mode 和原始链接目标，
  使用有版本和类型区分的确定编码；平台能观察哪些 mode 只影响磁盘比较，不改变存储哈希。
- 分支/结果持有不可变根和修订。根是实际读取、更新、diff、query pin 的入口，不在每次调用时从平表重建。
- 节点独立按内容寻址持久化，增量写新增节点；宽目录的子项索引也采用结构共享，避免每改一个文件复制/排序全部兄弟。
  初建用批量 builder；具体索引形状须确定、可校验，并使工作量随输入字节、索引高度和受影响页增长。
- 验证缺节点、内容不符、非法路径状态与循环，失败不能解释为空目录。读取按需解析，缓存可丢弃而权威不能丢弃。

### 4.2 发布与清理

发布先把新对象可靠安装到对象库，再在一个 SQLite 事务内提交新增节点、根 CAS、修订及全部引用/操作状态。
外部对象写入与数据库提交不是一个文件系统事务：提交前孤儿使用明确 staging/临时保留，提交后根不得指向未耐久对象。
fsync/rename 与数据库持久性设置按平台实现并测试，不能用“Rust/SQLite 是安全的”代替落盘顺序。

读者 pin 保留所选根；更新不修改旧节点。Thread 当前输入、已发布结果、草稿、review、未完操作、撤销所需 safety/target，
以及正在发布的临时所有者都进入引用规则。GC 从活根及节点边判断可达性，并与并发发布/pin 协调；
既不能只保护 root hash，也不能每次编辑遍历所有历史。逻辑释放、实际删除字节、失败重试分别记录。

Thread catalog 和 Pi JSONL 留在原所有者。跨 Thread 删除/结果发布/会话清理，用现有业务操作及幂等回执连接两个权威：
先持久意图与资源 pin，再执行各自本地事务，最后确认；不宣称存在跨 SQLite、JSONL 和编辑器的单次原子提交。
归档保留结果；真正删除只释放自身引用，仍被其他工作和已完成可撤销集成持有的对象继续可读。

## 5. Documents、磁盘与 Integration

DocumentsAPI 仍是统一文本入口。固定 surface 快照、虚拟 branch、物化 execution 和根磁盘是不同 view，
每次读取与写入携带同一个 view identity/revision；查询 pin 固定该次所用正文，父 live 变化不能补读子未改路径。
监视器仅作失效线索。普通消息/无写入回合不扫描全仓；首次 dispatch 捕获和明确重建承担必要枚举成本。

Rust 接管路径资源 gate、磁盘 before/after 捕获、条件应用、Integration 和恢复的阶段机。
UI/Agent/文件保存/恢复等使用相同 gate，不能迁走恢复却留下绕过它的 TS 磁盘 writer。
外部编辑器、命令和 Git 仍可绕过受控 gate；只记录能证明的结果，不称为 OS 原子 CAS 或全命令可撤销。

纯 branch 操作在 Rust 内完成 gate、期望修订校验、根 CAS 与日志提交。目录操作先持久 intent/可读 before 与 target，
再实施并记录各路径实况；意外部分失败仅补偿仍等于本次产物的路径。冲突、applied、compensated、needs-attention 沿现有契约。
锁顺序按操作实际资源确定，禁止持有数据库事务或跨域锁等待反向 Host 回调；依赖外部参与者时使用持久阶段与期望修订再入。

混合 surface/disk 操作由 Rust 维护同一 operationId 的阶段，TS Documents adapter 定向调用原 Registry：
写前绑定 owner/连接代际/文档实例/修订/格式；回执带实际应用状态；多个缓冲沿 operationId grouped undo。
等待缓冲回执时不持有数据库写事务。内核区分 surface 与 disk 目标，断线或未知回执保留 needs-attention，
禁止把未保存正文改写成磁盘恢复。启动后重新授权并查询可观察 before/after，再继续或补偿，绝不凭过期 ack 完成新操作。

恢复 provider 的公开协议与可替换性保留。内置 provider 调用 Rust 后端；其他 provider 不获得直接读写内核私有数据库的接口。

## 6. 基线、Git 与物化

Git/非 Git/unborn 共同使用固定状态与受管目录。Git 的逻辑 base 与执行仓库可解析的 baseline 分开；
dispatch 含 staged/unstaged/untracked/mode 与冻结 captureScopes，草稿覆盖盘面。捕获过程中输入变动要重核或给出具体不完整原因。

Git 适配绑定选定修订的属性与实际 checkout 配置。LFS/process/smudge、EOL 和 working-tree-encoding 不能用临时规则模拟；
required filter 失败不得成功返回原始 blob，skip-smudge 的真实行为保持。导入不擅自下载 LFS 对象。
继续复用 Git 可执行程序的相关语义，不因采用 Rust 就重写完整 Git；用户分支/index/历史与既有工作树资产保全。

materialize 冻结根和执行世代、等待在飞虚拟写、构建 staging、核验后切换 Run 权威，命令从该世代启动。
失败或中断可从阶段记录定位 staging/旧目录/新目录，不把部分物化当成功。已物化后受控工具和命令共用目录，
settle 收回变化并发布新结果；结果未耐久、后台写者未退出、未知占用时保留对应目录。

文件复制使用平台真实 clone/CoW 能力，普通复制是能力不支持时的正式后端；权限/对象损坏等错误正常传播。
不以硬链接共享可写文件替代 CoW。目录复制、ignored 输入、恢复临时文件均走同一原语，结果保留 bytes/backend/失败原因，
在既有空间/操作投影中呈现。真实磁盘占用不能从逻辑大小猜测。

D-277 的生产实现使用 kernel `file.scan` / `file.capture` 形成固定 baseline，并在完整捕获后再次按同一路径集合核对 file state；Git dirty inventory 额外保留内容身份窗口，目录 inventory 变化同样拒绝混合 root。Git materialized settle 由 Git 提供 tracked/untracked/index-mode 与真实 filter 语义，冻结 `captureScopes` 的 prior/current 路径再并入 Rust capture；非 Git 结果由 Rust inventory 收全。`file.materialize` 从 immutable root 构建 operation-specific staging，验证对象后在 Linux 尝试 FICLONE、macOS 尝试 `clonefile`，不支持时正式退回 byte copy；Windows 当前验收只证明 copy，因此报告 `reflink:0`，不能据实现代码宣称该平台已有 CoW。staging/backup/promotion 在 durable operation 下可重入；live backup 后崩溃的真实 release-kernel 反例会在重启 root registration 时完成 staging promotion，无法证明时恢复 backup 或报告 conflict。`file.measure` 在 Unix 使用实际 block 计数；Windows 当前没有已验证的 physical-allocation backend，`allocatedBytes` 明确为 `null` 而不是用 logical bytes 猜测。reclaim/discard/delete 的生产受管目录走 kernel subtree remove，linked Git worktree 只迁移/清理 admin metadata；Thread/Run 是否允许回收仍由 Registry/Host policy 决定。

## 7. 进程、终端与重启

Rust 接管现有 terminal runtime 的 PTY、受管命令、进程树、原始输出缓冲与进程 writer；TS adapter 保留原公开 API。
tab attach、bash/get_output/write/kill、任务与测试消费者都引用同一进程。关闭 tab 只 detach，退出码来自真实退出；
发出终止信号、RPC 结束或停止读取都不能提前释放 writer/目录。用户 shell 配置、cwd/env、输入、resize 和现有 OSC 事实保持。

LSP/DAP 外部进程使用该进程服务的流和退出机制，协议客户端、文档视图和 diagnostics generation 留在 TS。
不为每种工具单建一套 spawn/kill/回放表；Pi worker 继续由已有 broker 管理并登记自己的写者身份。

正常停机先停止新 admission，再处置受管工作、确认进程退出和 writer 释放、落盘并关闭内核。
内核意外退出时 Host 立即使旧 epoch 的句柄失效，操作状态取日志；Rust 持有的 PTY 可以丢失连接，
不承诺跨内核崩溃无损续接。平台进程组/Job 等机制和 Host 监督共同处置遗留子进程，只有确认退出才解除目录保护。
无法确认的进程/路径记为 unknown/needs-attention。恢复可重新建立服务，不自动再次执行可能已产生副作用的命令。
Host 自身崩溃也要覆盖该路径；用户根工作区不因进程清理而删除。

## 8. 检索与性能边界

Rust 承担授权范围枚举、固定视图文本搜索、文件读取、哈希、结构解析和批量切块，直接消费内核 snapshot/branch。
虚拟搜索不能在父 live 目录搜索后只覆盖 delta。tree-sitter/rg 等成熟实现继续复用，语言包选择、模型策略与结果呈现留在 TS。
scope 在候选选择前约束；结果、范围和 provenance 必须来自实际使用的同一视图。
解析后端更换同时处理语法/查询包 ABI、配方身份和发行加载路径，保留已支持的语言与范围语义；
旧派生缓存不能冒充新解析结果，也不为换语言缩减现有结构来源。

TriviumDB 已承担图/向量的原生查询，现有单写者 adapter 保留；remote embedding/rerank/LLM select 仍归 Pi/TS，
本地 ONNX 保留其运行时契约。内核按批输出结构记录/引用给它们，禁止每个符号一次同步往返或搬运全库候选来获取“Rust 加速”。
前台请求能先于下一批后台扫描运行；取消遍历、解析和子进程须到达实际任务。不能中断的调用如实表达停止等待与实际停止的区别。

性能验收同时回答端到端成本与结构原因：

| 操作 | 必须达成的结构目标 | 实际记录 |
| --- | --- | --- |
| 已就绪根 fork/pin | 元数据成本不随全树文件数线性增长 | 文件读取数、节点访问/新增数、持久写入字节、墙钟 |
| 单路径/批量编辑 | 处理变化字节和受影响索引，不重写整 catalog/node pool | 不同树规模下的写放大、CPU、内存、延迟 |
| 初次 capture/materialize | 流式、有背压和取消；必要全量成本透明 | 文件/字节规模、峰值内存、真实 clone/copy、完成时间 |
| 后台索引与前台并行 | 重计算不阻塞 Host 消息循环；无背景整批占满导致的串行等待 | 前台读取/编辑的分布与 Host event-loop delay |
| 多线程与反复启动/关闭 | 资源随活跃工作与缓存预算变化，结束后无持续泄漏 | Host+kernel+Pi 总内存、进程/句柄、线程数、重启恢复时间 |

同一机器/语料/构建模式下比较已修正并验收的 TS 基线与 Rust，分别记录冷/热及实际文件数、字节量、并发负载。
纯计算、存储、IPC、模型/网络时间分开；旧算法缺陷修复的收益不全归功语言。扩展现有观测脚本和反例，
不另建通用评测平台、辅助费用看板或固定评审轮数。绝对延迟/容量目标依据基线和支持平台定标，不预填“快十倍”或硬性运行配额。
没有明显收益的迁移必须检查边界和实现；若为耐久性付出成本，记录具体差值及取舍，不能以编译通过替代性能结论。

## 9. 接管、数据与阶段边界

迁移单位是完整资源权威及其所有写入消费者，不是按 TS 文件逐个翻译。阶段内可以继续存在尚未迁移的不同职责，
同一对象库、分支或进程不允许 TS/Rust 同时当写者。接管后的 TS 代码只适配公开契约，旧存储/锁/写入实现一起删除。
原实现仅在尚未接管其职责时继续运行，不设置新实现默认关闭、shadow 或运行失败回到旧写者的常驻机制。

**当前没有用户，不建设旧 Varin 内部格式兼容（D-253）。** 旧 catalog、WorkingState、缓存、索引和恢复元数据可直接
清除重建。消费者一次更新为新契约，旧 reader/writer、升级导入器、多版本分支和旧后端 fallback 一起删除。
Rust R1 从唯一的新内部格式启动，不要求建设 D-252 原先提出的“一次性存储转换”或旧库接管恢复阶段机。

工作区文件/Git 历史、原生 Pi 会话/设置/凭据及外部配置不是可随内部格式重建的数据。若开发中有尚未写回的真实成果要带走，
先保存/导出所需内容，做具体交接；不把完整旧分支/恢复历史保留变成架构要求，也不为此留下产品化旧 schema importer。
活动进程退出后再切换底层写入者，不把 PID 当作 PTY 所有权移交。新格式运行后的根/引用保护、事务、回执与崩溃恢复
仍按本文实现；格式替换不是在正常读取损坏或权限失败时静默创建空库的理由。

本轮 D-246–D-251 的执行报告与 Rust 计划分开验收。重要数据/权限缺陷仍须关闭；已完成的修复和反例作为接管基线，
不 reset/revert，不为迁移重复实现一套没有剩余生产用途的 TS 框架。本阶段不包含 Electron→其他 UI 壳、Pi loop 重写、
知识库替换、OS 沙箱、扩散模型或外部 MCP/ACP/research profile；这些不影响已定义的内核目标。

## 10. 发行与完整完成条件

构建从阶段 R0 起就覆盖仓库实际支持的 Windows/macOS/Linux target 与架构；Cargo 工具链、依赖锁和产物元数据可复现。
内核随 Electron 的可执行资源、Web/serve 和远程部署一起发布，不能留在 asar 内作为不可启动路径，
也不能仅在开发机经 cargo run 才可用。现有签名/校验、许可清单、更新和退出流程包含它；客户端设备不额外安装 Rust。

R0–R6 都是本阶段交付范围。每个里程碑记录生产消费者、已迁移权威、移除旧路径与故障证据；R0 握手或 R1 存储完成
只代表该里程碑，不代表阶段 R 完成。最终验收需包含：

1. 公开工具的根草稿/磁盘编辑、虚拟/物化/嵌套 Thread、结果发布/集成/撤销/删除及共享引用的完整行为。
2. 真实 Host↔Rust 子进程的断线、迟到、取消、进程退出与重启；存储发布、文件应用和 surface 回执关键窗口的故障注入。
3. 用户终端与 Agent 同进程附着、真实 shell 退出、输出字节分页，以及关联目录不提前回收。
4. scoped 检索和固定视图：图/向量可能是线索，最终原文不可混入父 live 或范围外正文；已有来源失败契约保持。
5. 第 8 节的结构与资源证据，以及实际发行产物在支持平台的启动/工作区操作 smoke。某平台缺真机证据单列，
   不能把注入式 clone 成功当作真实文件系统共享，也不禁用已验证平台的交付。
6. 旧 TS 权威及相关重复缓存/锁/存储实现已清理，代码、协议、模块文档和状态一致；不存在旧内部格式兼容路径，
   工作区/Git、原生 Pi 数据与外部配置保持完整，新格式从空库启动及正常重启均可用。

这些是该架构本身需要成立的交付契约，不是“是否准许引入 Rust”的研究门槛。真实付费模型质量和新研究 profile 不作为验收前置。

## 参考依据

- [Rust shared-state concurrency](https://doc.rust-lang.org/book/ch16-03-shared-state.html)：所有权有助于并发资源使用，不能消除所有逻辑错误/死锁。
- [Node.js event loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)：重计算和大对象操作对共享请求循环的影响。
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html)：数据库事务的原子性依赖其存储/刷新协议，不自动覆盖数据库外文件。
- [Child process transport](https://nodejs.org/api/child_process.html)：Node Host 的子进程与 stdio 传输机制；实现按仓库钉住的 Node/Electron 验证。

## 历史验收与当前实现入口

D-280、D-281、D-282 分别收口进程权威、原生计算与发行/传输边界。当前实现细节分别由
[进程模块](../../packages/web/application-host/lib/process/DOCUMENTATION.md)和
[Host kernel 模块](../../packages/web/application-host/lib/kernel/DOCUMENTATION.md)维护；
本设计不再追加第二份按提交排列的消费者和测试清单。

D-282 的同机夹具比较记录了不同成本：Rust search 在 128/1024 文件更快、4096 文件接近持平；
native inventory 和逐文件 structure 较慢但保持有界；单路径写约 4–5 ms，新增节点随树深增长；
后台背压下前台固定读约 11 ms。这是历史负载证据，非当前提交重测、跨平台承诺或统一语言提速。
瞬时 RSS 未覆盖基线短命 rg 子进程，WAL 文件长度也不等于物理写放大。测量入口仍为
`scripts/measure-kernel.mjs`，完整经过见[交付记录](../archive/harness-delivery-log.md)。

由此第 10 节的六类完成条件均有生产实现与相称证据，Stage R 完成。真实 ReFS/APFS extent sharing、物理断电 campaign、付费模型
质量和尚未运行的其他平台 release workflow 结果继续按各自环境登记，不恢复旧实现或把已验证平台置回候选状态。
