# 决策分卷：阶段 R：Rust 系统内核

范围：D-252~D-283 Rust 系统内核迁移全程（R0–R6）与 D-283 权限/Web 收口。

本卷是 [decisions/README.md](README.md) 的分卷；条目只追加、不改写，索引状态以总索引为准。

### D-252 · 2026-09-12 · 阶段 R：Rust 系统内核与 Host 分层

类型：架构决定（用户授权的正式计划阶段）

决定：Piarium 作为独立 Agent 工作环境，采用 Rust 系统内核 + TypeScript 产品/Agent 编排 + 内置 Node/Pi runtime。
将其立为 plan R0–R6 的完整架构演进阶段，覆盖协议与运行时、工作状态/恢复存储、文件/草稿协调、物化/Git/CoW、
进程/终端、文件/结构计算，以及性能、故障和发行收口；不以最小原生函数、只读演示或长期 shadow/fallback 交付代替。

原因：项目已有持久分支、恢复事务、真实执行与多 Agent 并发，需要长期明确的资源边界、增量存储和可控制的计算/进程生命周期。
Rust 可用于集中这些责任，TS 继续利用产品与 Pi 生态。最近验收暴露的哈希、基线、授权与恢复错误仍是需要独立修复的设计/实现问题，
不能把“改写 Rust”视为已修复或把降低语言层开销当作全部性能收益。

具体决定：

1. 每个实际 Application Host 管理一个私有 Rust 子进程，跨语言 schema 单一来源并生成 client；公开 API、Pi worker 通道保持。
   这扩展原 Host 的系统后端，取代设计第 4 节“不引入新的进程边界”的约束，不创建 Electron 专属第二后端。
2. Rust 统一文件资源、WorkingState/对象/引用、磁盘恢复/Integration、物化、PTY/受管工具进程与文件/结构计算。
   Thread/Run 产品 lifecycle、Document Registry、知识 `.tdb`/图/向量 adapter、模型策略与 Pi 会话/凭据各保留原所有者。
3. 工作状态沿现有 SQLite + 内容对象库接管，在同一存储位置内把根/修订/引用/operation/checkpoint 纳入同一事务域；
   树根成为生产读写入口、节点增量持久，不把整份 JSON/node pool 换个语言继续全写。此为 D-245/D-251 后的目标演进，
   不改写其实施记录、不据此裁定刚完成的返工。
4. 一次接管一个完整权威及全部消费者。尚未接管的不同职责可以继续 TS；同一状态/进程只有一个写者，接管后删除旧实现。
   runtime 故障不静默回到旧后端；取消、未知执行、epoch、幂等重试与重启按真实副作用设计。
5. 澄清 plan 0.1 的旧格式政策：不承诺历史格式兼容、不建设长期双读/双写；可重建缓存/夹具可直接替换。
   真实工作区/Git、Pi 会话与设置、知识及需保留的结果/草稿/恢复正文不能按“未发布”自动删除。
   一次性权威接管所需的数据转换、验证和中断恢复随阶段交付，不要求先丢弃当前工作。
6. D-246–D-251 先独立验收，重要错误关闭后进入 R；已有实现/反例作为基线，不回退提交、不重复建设同目标 TS 框架。
   外部 MCP/ACP、research profile、新模型在此阶段之后；不引入知识库替换、Electron 壳替换或 OS 沙箱。
7. 性能对照使用健康 TS 基线、同机同语料/构建模式，报告端到端时间、写放大、总进程内存和资源释放。
   结构目标与产品调用链一起验收，不虚构倍数/容量上限、不新建通用评测平台。发行 target 从 R0 构建，R6 收口真实产物。

考虑过的替代：整体后端翻译 Rust 会连带重写变化快的 Pi/产品生态；只迁哈希函数不能收口资源和事务边界；
继续 TS 并只做 worker 隔离可缓解事件循环阻塞，但不落实本次选择的原生系统内核；保留双后端会形成两份持久权威。
因此选择按完整职责迁移的正式阶段。

影响：[rust-kernel-design.md](../design/rust-kernel-design.md)、architecture 第 1/2/4 节、agent-harness 第 1/2/4/9.2.5b/12 节、
plan 0.1/0.7/3.4/阶段 R、status 阶段 R、roadmap、AGENTS 与 native recovery 的目标边界。
本条只追加，D-001–D-251 正文保持原样。

状态：设计与计划已采用；本次仅修改文档。Rust 内核、生产接管、迁移执行和性能/故障证据均未交付，事实以 status 为准。

### D-253 · 2026-09-12 · 无用户阶段直接替换内部格式

类型：用户澄清；修订 D-252 第 5 项及 R1 的默认存储转换要求

决定：当前没有用户使用 Piarium，不建设旧内部格式兼容。旧内部 catalog、WorkingState、缓存、索引和恢复元数据
可以直接清除重建；消费者更新到唯一新契约，旧 reader/writer、升级导入器、多版本分支、双写与旧后端 fallback 一并删除。
撤回 D-252 把“一次性旧库转换与转换中断恢复”列为 Rust 阶段必交付工作的要求。

原因：没有实际用户升级需求时，为旧内部状态设计转换机制会扩大维护范围，并使执行者继续保留旧格式和路径。
用户明确要求直接替换。代码权威的完整接管仍要做，历史内部数据升级不再是接管的前提。

边界：工作区文件/Git 历史、原生 Pi 数据和外部配置照常保全；若有尚未写回的实际成果，先保存/导出所需内容，
做具体交接，不产品化旧 schema importer。新格式运行期间的事务、引用保留、取消/崩溃恢复和损坏报错不削弱。
本次只更正文档，不删除本地数据，不修改执行 agent 的实现。

影响：AGENTS、plan 0.1/3.4/R1、Rust 设计第 9/10 节、architecture 4.0、harness 1.3/9.2.5b/12.2、status R1。
状态：设计与计划已修订；阶段 R 仍未实现。D-001–D-252 原文保持。

### D-254 · 2026-09-12 · D-240–D-251 独立验收收口

类型：验收发现与实现纠正；supersedes in part D-246–D-251

验收没有接受执行报告本身作为交付证据。实际代码仍有五组决定性问题：图存储继续按 execution workspace 查找，直接 LSP
结果可带出 actor scope；Thread 删除阶段只存在于返回 DTO，子节点失败后仍会删除父节点，retrieval 引用清理仍是吞错 observer；
旧 worktree 的 `importFixedResult` 才使用 Git filter 适配层，该链既是 D-253 已撤销的兼容路径，也会通过 `cat-file --filters`
触发未知 filter/LFS 副作用，Git index mode 又没有进入捕获指纹；目录型 `copyIgnored` 仍绕过 reflink 原语；trie 校验把合法
共享子树误判为循环，prototype-chain 节点序列化漏掉继承节点，引用对账会把 schema 4 写回平表。

决定：

1. 图库解析以 session binding 的 owning workspace 为准；Documents/LSP/路径仍使用 execution workspace。`related` 只有在
   owning 与 execution 相同且没有固定脏缓冲时才能直接陈述存量图位置；隔离视图返回 unavailable。`explore` 可把 owning 图
   当候选来源，但最终材料仍由固定 execution view 读取。公开 LSP 的正文、raw value 与写后图行统一按 actor scope 过滤；
   navigation 的权威空结果按 anchor + relation kind 替换旧行。
2. 整条 Thread 删除先把 operationId、rootThreadId 与“下一阶段”写入所有待删节点，再执行 sessions → store → directory →
   registry。阶段副作用完成后才推进持久 phase；失败保留 error 并可在 Host 重启后续跑。任一后代未完成时父节点不得进入
   删除提交点，`deletedThreadIds` 只列真实移除项。knowledge 在 session binding 消失前清理；retrieval evidence/receipt/artifact
   引用成为 store 阶段的必需动作，不再依赖 `onThreadRemoved` observer。
3. 删除 `importFixedResult`、`git-migration.ts` 和 commit-blob smudge/LFS 重建链。当前线程在 dispatch 已有 WorkingBranch
   基线；物化线程 settle 时先生成固定 snapshot，再从该 snapshot 的真实工作区字节发布 native result，并在发布 catalog 前
   复核 snapshot 身份。该路径不执行 filter，不访问 LFS 网络。Git index 100644/100755 仍覆盖 Windows 捕获并进入 capture
   fingerprint。旧内部 worktree 记录不迁移，符合 D-253。
4. 目录型 `copyIgnored` 逐文件走 `copyFilePreferReflink`，不再调用递归 `fs.cp`。
5. trie 完整性校验区分 recursion stack 与已验证 DAG 节点，校验 empty root；持久化按 root 遍历所有可达节点，不能依赖
   own-property 枚举；引用对账也必须走唯一 schema 4 serializer。schema 1–3 与 schema 4 平表均直接拒绝。当前 TS
   `WorkingBranch` 仍是平表内存权威，Merkle 只承担当前 schema 的持久去重与 tree identity；不得把它写成生产 root authority。
   真正的 root 读写入口、增量节点事务与取消 whole-pool rewrite 归阶段 R1，一次接管，当前不再复制建设一套 TS 内核。
6. D-241/D-247 的未知 exec、warning 与失败块本轮复验没有发现新的阻塞错误，保持现状。

状态：已实施并有定向反例；完整证据与仍未实测环境见 status。D-246–D-251 的历史正文不改，本条覆盖其上述错误声明。

### D-255 · 2026-09-12 · 阶段 R0/R1 首个执行纵切

类型：实施选择与状态纠正

决定：按 D-252/D-253/D-254 建立一个 Cargo workspace 和一个 `piarium-kernel` 可执行入口，采用长度前缀 JSON
控制帧、stderr 分离、单一 generated TS DTO；R0 由真实 Application Host client 管理子进程并在启动/关闭路径执行握手与
epoch 校验。R1 首刀把内容对象、不可变 trie 节点、branch/revision/pin、CAS、operation/recovery record 与 GC 做成
Rust SQLite/object store 领域 API。kernel storage root 使用 `<PIARIUM_DATA_DIR>/kernel/<hostId>`，owner file 拒绝同一
存储位置的第二 Host；对象先 fsync+rename，再在 SQLite 事务中发布引用。

原因：当前仓库没有 Rust runtime 或跨语言协议；先把真实进程、协议和 R1 根/对象语义立起来，才能从 D-254 的 TS trie
“持久去重但仍平表/整 catalog 写”进入生产接管。协议保持领域方法，不提供任意 SQL/磁盘写接口，也不把 Thread/Pi/Registry/
TriviumDB 的既有所有权误并入 kernel。

考虑过的替代：继续在 TS 中复制一套 trie 过渡内核（会形成第二 writer）；通过公开 TCP 端口连接（扩大权限边界）；把 Rust
编译器作为用户运行时依赖（发行包应携带可执行文件）。均未采用。

影响：新增 `kernel/` Cargo workspace、`kernel/protocol/schema.json`、Host `KernelClient` 与真实启动/停止接线、Web/Electron
staging 脚本、R0/R1 文档和本机 child-process 证据。R2–R6 不因本条提前完成；现有 TS WorkingState/Recovery 全消费者仍需后续
按责任表切换，不能把本条写成旧 writer 已删除。

状态：R0 已在本机 wired/proven；R1 kernel vertical wired，完整生产 consumer cutover 待继续

### D-256 · 2026-09-13 · R0/R1 首个纵切返工

类型：错误修复与契约收口

决定：保留 D-255 及其全部提交，在其上把内核纵切收口为当前唯一 Rust 格式与真实进程契约：(1) 显式 revision 永远从
revisions 表解析固定 root，当前可写 head 与固定 view 分开；(2) operation begin、节点/CAS/root/revision/ref 与完成结果
在一个 SQLite 事务内提交，失败回滚为可重试状态，完成响应丢失可用 operation 查询；恢复多阶段 update 保持同一逻辑 operation 的
身份，并保留首阶段输入用于启动对账；(3) branch 删除不撤销独立 pin，GC 从
branch/revision/pin/recovery root 和 root-parent/blob 引用保留正文；批量初建只在 builder 内使用有序临时表，运行时子项索引不回退到平表；GC 的逻辑释放、实际对象删除和清理失败写入 durable pending
记录，重启重试；(4) 路径状态改为 Rust enum，AVL 子项索引做结构共享，初建
使用批量 builder，文件/目录替换和重复/非法路径显式失败；(5) Host 握手绑定 build/protocol/epoch/storage identity，grant
绑定 generation、workspace、能力和 scope，撤销与旧代际拒绝；(6) stdio 进程改为可接收 cancel 的 worker/writer 状态机，正文
上传使用 data chunk，method 参数未知字段在 Rust 边界拒绝，kernel health 提供按需 deep integrity 检查。协议 DTO、runtime、authority、model、error、protocol 责任
拆分为独立模块。

明确不做：本轮不进入 R2，不接管 TS WorkingState/Recovery 的全部生产消费者，不引入旧格式 importer、shadow backend 或
公开 TCP 端口；event envelope 在没有真实消费者时不保留。

依据：D-255 的首个纵切仍把可变 head 当固定 revision、operation completion 与状态提交分裂、pin 随 branch 删除、BTreeMap
宽目录和任意 JSON state 当权威；这些错误会让“节点恒定”证据失真，并在断线/重试/跨工作区读取时产生错误事实。D-256 的
release child-process 反例覆盖固定 revision、事务失败重试、pin/GC、grant/revoke、取消与分块传输；结构取样记录节点与
payload 增量，但不宣称跨平台或受控性能提升。

影响：`kernel/rust-toolchain.toml`、`kernel/crates/piarium-kernel/src/{runtime,authority,error,model,protocol}.rs`、kernel protocol schema/generated DTO、
Host KernelClient、R0/R1 status 与本模块文档。完整 consumer cutover 仍是后续 R1 工作，R2–R6 不变。

状态：R0 本机 release proven；R1 Rust storage vertical proven，TS consumer cutover 未完成。

### D-257 · 2026-09-13 · R0/R1 基础返工与重新验收边界

类型：实施纠正与状态收口；部分取代 D-256 的交付状态表述，不改写 D-256 正文

决定：在保留 D-256 全部提交的前提下，补齐承载真实消费者所需的基础不变量：(1) KernelClient 只保留 Host-management grant，产品域调用显式携带不可变 scoped grant；Rust 从持久 branch/pin/operation/recovery/stream/object-owner 身份解析 workspace，并在所有展开读取上执行 path scope；(2) stdin request 与 stdout response 使用有界 channel，控制帧有上限，正文只使用 begin/data/finish 流，撤销先做 admission 阻断并取消排队 token，cancel 核对完整 epoch/grant/request 归属；(3) kernel 返回编译期 build identity/target/arch，staging manifest 携带 protocol、kernel version、target、arch、identity 与 SHA-256，Host/after-pack 逐项核对；(4) storage 增加对象临时 owner/branch attachment、授权的 root/revision/pin `baseRef` fork、pin/recovery identity、publish CAS、format v5 原子初始化、pending GC containment 与 deep relation/AVL/path 检查。

原因：D-256 的纵切已经能在本机子进程完成一组 Rust storage 操作，但旧 client 的全局 actor 身份、排队 revoke、单帧正文、Host buildVersion 回显、对象 owner 缺失和跨 root 授权缺口会在真实 TS consumer 接入后产生跨 workspace 读取、假取消、伪匹配或不可对账的持久事实。先修这些基础契约，才能一次性切换 WorkingState/Recovery/结果/草稿/evidence/materializer，不建设 shadow backend 或兼容 importer。

影响：`kernel/crates/piarium-kernel/src/{runtime,main,protocol,authority,model,storage_schema}.rs`、generated protocol schema/DTO、KernelClient、build/after-pack 脚本与 R0/R1 status/documentation 更新。当前 Application Host 仍只负责 kernel 生命周期；Thread/Run catalog、Registry 缓冲、Pi 会话/模型/凭据、TriviumDB/adapter 与全部产品 storage consumers 维持原所有权。R2–R6 不因本条完成。

证据边界：Windows 本机真实 release 子进程覆盖 scoped scope 读取、owner/跨 workspace、revoke queued write、cancel、restart、pin/GC、baseRef 和事务失败重试；`cargo check --workspace --locked`、generated DTO `--check`、application-host type-check 与 staging manifest smoke 已执行。macOS/Linux 真机、断电级故障、完整 Electron cross-target/package smoke 和产品 consumer cutover 尚未执行，R0 记 Partial（implemented/wired），R1 记 implemented（kernel foundations），不标 wired/proven/default-on。

### D-258 · 2026-09-13 · R0/R1 协议与存储不变量收口

类型：验收返工；部分取代 D-257 的具体协议、格式和证据表述，不改写 D-257 正文

决定：在产品 consumer cutover 前直接更换当前私有 kernel 契约，不保留旧方法或格式兼容：(1) `storage.getBlob` 必须绑定
`branchId + path (+ revision)`、`pinId + path` 或当前 grant 的临时 `ownerId`，hash 和 workspace 归属本身不构成路径授权；
(2) blob upload 返回一对一 owner，branch entry/change 显式消费具体 owner；复用已有正文则绑定 base/current root 上同一路径或授权范围内的
`sourcePath`，不能拿 workspace 内任意 hash 搬运范围外正文。release 不复用 upload operationId；已完成 operation
另有显式 release 生命周期；(3) branch create/write 都使用 begin/append/finish/abort 的有背压构建器，控制帧不再承载整棵初始树或
整批变化；(4) publish 强制同时携带 expected writeRevision 与 root；合法未发布 head 与最后发布 revision 分开检查；
(5) Rust method DTO 与 TS DTO 同由 `kernel/protocol/schema.json` 生成并在构建中检查；请求/响应队列各只保留一个待交接 envelope，
因为 worker/writer 本来就是串行；(6) catalog 直接启用 format v6，核验 user version、schema fingerprint、完整表/索引/列，
旧 v5 或缺表的 v6 都拒绝，不补表、不迁移；(7) Application Host build identity 与编译期 kernel identity 必须一致，构建和
after-pack 从 PE/ELF/Mach-O 正文核验实际 platform/architecture，不能只信 manifest 标签；(8) 对象安装使用流式 hash、目标文件 flush、
Windows write-through rename，Unix 同步 source/target/新 shard 的目录项。断电级保证仍需真实故障证据。

原因：D-257 的实现仍允许同 workspace 的 scope 外 hash 读取、无 CAS publish、临时 owner 误消费/无法释放、损坏 catalog 静默补表、
合法 dirty head 误报 degraded，以及大 branch 在 16 MiB 控制帧前直接失败。真实背压又暴露 Host pending Promise 的未处理拒绝，
正常 shutdown 也因未释放 response sender 每次等待五秒强杀。这些都是进入 R1 consumer cutover 前必须消除的基础错误。

影响：协议删除直接 `branch.create` / `branch.write`，新增流式 builder 与 `operation.release`；blob result 增加 `ownerId`；
storage format 从 v5 直接换成 v6。当前没有用户，按 D-253 不提供 importer、dual-read 或 fallback。Application Host 仍只接管
kernel 生命周期，WorkingState/Recovery/result/draft/evidence/materializer 的生产 consumer 尚未切换，R1 仍为 implemented，
不是 wired/proven/default-on；R2–R6 不变。

证据边界：Windows release 子进程覆盖 16 MiB 以上 branch 输入、同 hash 双 owner、scope 外 blob、强制 publish CAS、dirty head deep
health、损坏 v6 缺表拒绝且不修补、取消/revoke、operation release、关闭重开；Rust 单测覆盖 malformed revoke admission。
实际 Windows x64 binary header 已在 build 中核验，macOS/Linux 与真正 cross-target 产物、断电注入、签名安装包和完整 product consumer
仍未实测。旧 `nodePayloadBytes` 数字只统计 SQLite TEXT 字符，不能作为持久写放大；本条改为明确的 node JSON UTF-8 bytes 与
catalog/WAL 文件大小观测，尚不据此给性能倍数。

### D-259 · 2026-09-13 · R1 production WorkingState/retrieval consumer cutover

类型：实施选择与阶段边界

决定：在不保留 TS/Rust 双写的前提下，Application Host 的生产 WorkingState branch/draft/result/publish/CAS、分页固定根读取、materializer 输入和 retrieval artifact/receipt/evidence 引用改由 actor-scoped `KernelStorageAdapter` 写入 Rust format v6 的 `domain_records`/`domain_record_refs`；新增的 record/reference wire DTO、record-bound blob read 和 branch page cursor 继续从 `kernel/protocol/schema.json` 生成。TS `WorkingStateStore` 只保留给旧夹具/单测，生产装配不再调用其 JSON/node-pool writer。

原因：仅增加 adapter 而让 `createWorkspaceWorkingStateAccess` 继续打开 recovery SQLite 会留下同一资源两个写者，也无法证明公开 branchWrite/retrieval 走真实 kernel。typed record/reference 让结果、verification/review 和 retrieval 生命周期不再依赖 `context.database`/`object_references` SQL；分页根读取避免大树响应跨 16 MiB 控制帧。

考虑过的替代：继续把 Rust 结果复制回 TS WorkingState 平表（违反 R1 root authority）；在 adapter 中提供通用 SQL/kv（绕过领域身份）；把 recovery SQLite 一并伪装为 kernel facade（会把 R2 文件阶段和新的记录契约混成双写）。均未采用。

影响：`kernel/protocol/schema.json`、generated TS/Rust DTO、Rust `domain_records`/`domain_record_refs` 与 record-bound blob read、Host `KernelStorageAdapter`/`KernelWorkingStateStore`、生产 `application-host/index.ts`、retrieval artifact/receipt access 及 release test 夹具；TS recovery checkpoint/turn/operation 和 Integration durable journal 仍为下一段 R1 工作，R1 暂不标 proven/default-on。

证据边界：`cargo check --manifest-path kernel/Cargo.toml`、protocol `--check`、Application Host source/test type-check 已通过；新增真实 release child-process record/reference/paged-root 测试入口，但本机本轮未完成带新 build identity 的 release binary smoke，Recovery durable records、旧 SQLite 删除、断电级故障及跨平台发行仍未证明。

状态：WorkingState/retrieval wired；Recovery cutover 待实施

### D-260 · 2026-09-13 · D-259 release-path evidence correction

类型：实验结果；更正 D-259 的证据边界，不改写 D-259 正文

决定：补记带当前 schema/build identity 的 Windows x64 release `piarium-kernel` 真实子进程证据：现有 kernel-client 反例 12/12 通过，新增 typed durable record/reference、record-bound blob read 与分页/空根边界通过；Host adapter 的 dispatch → virtual write → publish 纵切也经同一 release child process 验证。D-259 对“本轮未完成 release smoke”的暂时表述由本条取代。

原因：首次验证时 release binary 仍是旧 build identity，随后用 Visual Studio Build Tools 环境重新构建并复跑，确认新增 `domain_records`/`domain_record_refs` catalog fingerprint 和 record-bound authorization 实际被 kernel 执行。

影响：status R0/R1 证据、kernel module documentation；Recovery durable record、旧 recovery SQLite 删除、断电级故障和跨平台发行仍未证明。

状态：已验收（WorkingState/retrieval vertical）；Recovery 仍待实施

### D-261 · 2026-09-13 · Recovery record seam extension

类型：实施补充；不改写 D-259/D-260

决定：Application Host recovery capability 的 checkpoint、turn binding 和 mutation before/after 记录先经 kernel typed record facade 持久化，保留 TS engine 负责文件计划、Documents 协调以及尚未迁移的 combined operation/operation-file 阶段。相同 operation/record identity 继续由 kernel `storage.record.*` 做幂等与 actor/workspace 校验。

原因：turn coordinator 是真实公开工具链的耐久入口，若继续直接打开 recovery SQLite，会让 R1 consumer map 同时存在两份 writer；但把 combined file apply/Integration 阶段一起搬动会越过 R2 边界。分离 record seam 可以先关闭重启后 turn/checkpoint 丢失，再继续清理 operation-file writer。

影响：新增 `kernel/recovery-record-adapter.ts`，`application-host/index.ts` 的 recovery capability/启动 facade 使用它；`recovery/journal-catalog.ts` 仍只服务尚未迁移的 combined Recovery/Integration 路径，R1 继续 Partial。

状态：已实施；combined Recovery/Integration 待继续

### D-262 · 2026-09-13 · Kernel recovery catalog and operation-file cutover

类型：问题与解法；不改写 D-259–D-261

决定：生产 recovery engine 使用内存 SQL-shaped 工作视图，打开/关闭时把 checkpoint、change、turn、operation、operation-file、metadata 行按稳定 record identity flush 到 Rust `domain_records`/`domain_record_refs`；内容对象由同一 recovery grant 上传到 kernel blob store，Rust 负责引用消费和 GC。旧 BetterSqlite3 recovery catalog 只保留给现有离线夹具，不再由 Application Host 生产装配打开。

原因：现有 combined recovery、Integration coordinator 和 thread-runtime 仍通过 `context.database` 查询，直接删除接口会在没有迁移消费者的情况下断生产链；把 SQL 视图限制为进程内工作副本可以保持既有文件计划/实际 apply 编排，同时让唯一耐久 writer、引用生命周期和重启对账落到 kernel。每个 Host/workspace 复用短生命周期 WorkingState projection，避免每个 consumer callback 再次展开整棵树。

考虑过的替代：继续把 recovery rows 写入 workspace `catalog.sqlite`（保留双 authority）；为所有旧 SQL 调用临时发明通用 SQL RPC（绕过领域约束）；复制 rows 到 TS JSON 并在失败时回退（违反无双写/无 fallback）。均未采用。

影响：新增 `kernel/kernel-recovery-catalog.ts`，`journal-engine.ts` 支持 catalog backend 与 kernel content store，生产 `application-host/index.ts` 注入该 backend，删除无调用方的旧 recovery record facade；Recovery 文件计划、Documents barrier 和实际磁盘 apply 仍属于 R2，Thread/Run/Pi/Registry/TriviumDB 权威不变。

证据边界：真实 Windows release kernel 子进程通过 turn/checkpoint → before/after blob → settle、关闭重开列出/resolve、combined prepare/apply、kernel GC smoke；`kernel-client.test.ts` 12/12、协议生成、Host 类型检查和 Host 启停 smoke 通过。macOS/Linux、断电、完整桌面点击链和受控性能测量仍未实测。

状态：已实施；R1 durable recovery records wired，文件 apply/materializer 与跨平台发行仍未完成

### D-263 · 2026-09-13 · Direct recovery record path and composite actor identity

类型：返工修正；不改写 D-259/D-262 正文

决定：checkpoint、turn binding、mutation before/after、checkpoint list/resolve 在生产 recovery facade 中直接调用 kernel `storage.record.*`，不再经过内存 SQLite；kernel `domain_records` 改为 `(workspace_id, record_id)` 复合主键，references 同样携带 workspace，get/list/blob read/release 按 session/thread/run actor 校验，并为 workspace maintenance grant 保留明确的 `recovery.maintenance` 能力。

原因：全局 record id 允许不同 workspace 互相覆盖，workspace-only read 也允许不同 Thread/Run 读取彼此记录；transient catalog 关闭时 flush 不能表达阶段提交或响应丢失。直接路径先关闭公开 turn/checkpoint durable 入口，并用 release 子进程反例验证跨 workspace/actor 隔离。

考虑过的替代：继续扩大内存 catalog facade；按字符串前缀制造全局 record id；让所有读者拥有 storage.admin。均未采用。

影响：kernel catalog schema/authorization、generated record-put expectedRevision 字段、Host `kernel-recovery-store.ts` 与生产 recovery facade、真实 kernel-client scope test；combined operation/operation-file direct API、WorkingState root projection、旧 transient catalog 清理、真实 session resolver 和 recovery location 迁移仍待后续提交。

证据边界：Windows release 子进程 kernel-client 测试 14/14 通过，新增相同 record id 的双 workspace、错误 actor 拒绝和 Recovery checkpoint/turn/mutation 重启测试；Host 类型检查及 release build 通过。崩溃窗口、跨平台、完整 operation stage 和性能仍未实测。

状态：已实施；R1 仍 Partial，未宣称 wired/proven/default-on

### D-264 · 2026-09-13 · Typed recovery stages replace the transient catalog seam

类型：返工修正；只追加，不改写 D-259/D-262/D-263 正文

决定：生产 Host 删除 `KernelRecoveryCatalogBackend` 与 `:memory:` flush 路径，Recovery 的 checkpoint/turn/change 与 operation/operation-file 使用 Rust typed recovery methods。Rust 在同一 SQLite 事务内发布 operation 及其 files，文件 phase、turn settle、terminal operation 都携带 revision/state CAS；对象引用进入 Rust `recovery_refs`，GC 以这些引用为根。kernel catalog format 升为 v7，新增明确的 recovery tables/DTO/参数校验和 phase fault injection。

原因：关闭时逐行 flush 不能表达提交前后故障窗口、响应丢失或 operation-file 的单文件 CAS，也会把 durable owner 与 TS SQL 快照分成两份权威。typed method 的输入边界让 workspace/actor/revision 关系在 Rust 内验证，并为后续直接迁移 combined/integration 编排提供真实事务 seam。

影响：删除 `kernel-recovery-catalog.ts`，生产装配使用 `kernel-recovery-store.ts`；旧 local journal 仅供尚未迁移的测试/编排路径，不能作为 kernel recovery fallback。新增真实 release child-process operation transaction/CAS 与 actor turn-read 反例；R1 仍不标 wired/proven/default-on，因为 combined file apply、WorkingState root adapter、完整 actor resolver、location migration 与跨平台/断电证据尚未完成。

证据边界：Windows release kernel typed recovery tests、checkpoint/turn/mutation restart test、protocol generation、cargo check/release build 和 Application Host type-check 通过；完整 public combined/integration stage、跨平台和硬断电窗口仍未实测。

状态：部分实施；D-259 与 D-262 的 transient/record-facade 部分由本决定 superseded in part，其余未迁移消费者保持原边界。

### D-265 · 2026-09-13 · R1 root、record 与生产编排边界返工

类型：验收修正；部分取代 D-259、D-262、D-264 的交付表述，不改写其历史正文

验收没有接受“已有 typed API”作为生产 consumer 已迁移的证据。实际代码仍有五个会改变行为的错误：未发布
WorkingState 不能建立真正的 kernel pin，删除新路径会留下 tombstone；`domain_records.revision` 同时承担产品身份和
记录 CAS，且更新可以无条件覆盖；生产 actor resolver 会任选工作区内第一个 session，而同步 consumer 又绕过 resolver；
父分支不能消费只由 result record 保留的 child blob；combined Integration 仍读取 TS SQLite，但 kernel WorkingState context
没有把该 journal 与 Documents gate 接回来，并暴露了可直接写 kernel object 目录的默认 TS file store 和无操作 gate。

决定：

1. kernel catalog 直接使用 format v8。branch 的 revision 0/root 是创建完成后的真实基线；非目录状态写回基线时移除
   overlay 而不留下 tombstone。`branch.pin` 可用 `expectedWriteRevision + expectedRoot` 原子固定未发布 current root，
   `pin.read` 支持 path/pagination；query pin 绑定 grant，grant revoke 会释放它，显式 revision pin 仍可独立保留。
2. `domain_records` 增加独立、单调的 `recordRevision`；产品 `revision/resultRevision` 保持不可变身份。已有记录更新必须携带
   `expectedRecordRevision`。grant 增加 authority/worker/generation 身份；生产 resolver 只接受准确 session，并从 session binding
   恢复 owning workspace、Thread、Run、execution workspace 与相对 scope。Host lifecycle 的跨 Thread 操作使用显式
   `storage.maintenance`，不再伪装成任意一个活跃 session。
3. retrieval artifact ref 在公开 protocol 中携带 record/workspace/session/thread/run 身份；读取必须与 durable record 全字段一致，
   相同 hash 的不同 Run 不折叠。record-backed branch write 只允许 Host storage maintenance，并由 Rust 核对 record slot/hash；
   普通 scoped actor 不能借 record 绕过 path scope。
4. WorkingState 的 read/grep/find/ls/explore、virtual write 和 materializer 输入改用异步 root/path/range API；Host 不再长期缓存
   展开的 workspace tree。current query pin 在 semantic/explore 完成后显式 release。尚未异步迁移的 ThreadRuntime/
   IntegrationCoordinator 每次 callback 临时展开后丢弃，不得写成完整 root consumer cutover。
5. combined Integration 的 durable journal 尚未迁入 typed Rust operation API。当前生产必须明确组合 kernel branch/object authority
   与仍属 TS recovery engine 的物理 SQLite journal/真实 Documents gate；启动在 WorkingState 可用后再对账 branch integration。
   KernelStorageAdapter 必须显式绑定 `KernelRecoveryContentStore`，未绑定 file store 或 resource gate 直接失败，不能出现第二对象写者
   或绕过 Documents。typed Rust recovery API 保留为下一步替换 seam，不冒充当前 consumer。

状态：R0 的 Windows release 纵切与 R1 root/path 纵切已有反例；R1 仍为 Partial。剩余阻塞是 combined Recovery/Integration/
agent-mutation consumer 的 typed API 切换、同步 ThreadRuntime/IntegrationCoordinator 的 async root 改造、draft/result/verification/review
的完整 typed DTO、recovery location 收口，以及跨平台/硬故障证据。没有 feature flag、shadow backend 或旧格式 importer。

### D-266 · 2026-09-13 · Rust kernel 按领域拆分存储实现

类型：内部架构重构；不改变协议、catalog 格式或产品行为

问题：`piarium-kernel/src/main.rs` 已增长到 6483 行、约 275 KiB，一个 `impl Storage` 同时包含进程入口、catalog、授权、
对象、状态树、分支、Recovery、领域记录、GC、完整性检查和协议分发。事务使用同一个 SQLite 连接是正确的，但把全部实现放在
一个入口文件里会掩盖领域和事务边界，也会让 R2 的文件协调继续扩大一个任何修改都能触及的实现面。

决定：二进制 `main.rs` 只调用 library 入口；`lib.rs` 装配 kernel crate；`runtime.rs` 只处理 framed transport、握手、
admission/cancel 和少量生命周期入口。`Storage` 继续唯一持有 SQLite 连接、对象根、进程锁、取消状态和在建流，不复制 store、
不引入 trait facade 或第二套事务框架。其实现拆入 `storage/{core,operations,authority_store,objects,state_tree,branches,recovery,
records,gc,maintenance,dispatch}.rs`。领域方法默认只在 `storage` 父模块内可见；runtime 经一个授权后的 dispatch 进入，只有打开、
grant、data chunk 和取消所需入口保持 crate 可见。

状态：已实施。Rust workspace 单测、Windows release build 与既有真实 Host→release-kernel 子进程反例保持通过。此条只收口源码
责任边界，不提高 R0/R1 的交付等级，也不提前完成 combined journal cutover 或 R2。

### D-267 · 2026-09-13 · WorkingState 产品记录使用领域 wire 方法

类型：R1 consumer cutover；只追加，不改写 D-265/D-266 正文

result、draft、child/parent verification、review 现在拥有独立的 protocol method/DTO。Application Host 的 kernel storage context 通过这些方法发布和读取记录；通用 `storage.record.*` 仍仅保留给 branch metadata、retrieval 等尚未拥有专门领域 DTO 的记录。result 的 kernel 持久 envelope 只保存 branch、固定 root/revision、changed paths、diff identity 和时间，重启时按 root/path 读取结果内容，不再把 `baseStates/pathStates` 写入 result payload。

Rust 在领域入口校验 workspace、branch/root/revision、thread/run 绑定和 record CAS，并复用同一 SQLite 事务维护 object references。当前 WorkingState callback 投影仍存在，且 draft/verification/review 的完整 root consumer 尚未完成，因此本决策只标记 A 阶段 wired，不提升 R1 的 proven/default-on 等级。

### D-268 · 2026-09-13 · Root/path consumer seam and durable operation port

类型：R1 consumer cutover；只追加，不改写 D-265–D-267 正文

WorkingState root access now exposes immutable result lookup and selected state slices. The integration preview path and the ThreadRuntime branch-view/footprint reads use the root/path API, so these operations do not open a snapshot or rebuild a complete branch map. The root callback carries only the storage identity/file store context needed for directory inspection. A shared `RecoveryDurableOperationPort` is present on kernel-backed recovery contexts; directory integration intent/file phases/terminal completion use the Rust typed operation API before applying disk effects. Legacy callback consumers and undo/reconcile paths remain to be migrated, so R1 remains Partial.

### D-269 · 2026-09-13 · Agent mutation durable port

类型：R1 recovery consumer cutover；只追加，不改写 D-265–D-268 正文

Kernel-backed `WorkspaceRecoveryStorageContext` now carries a Rust-owned `RecoveryDurableOperationPort`. Agent surface/disk mutation intent creation, file phase transitions, compensation markers and terminal completion use the port; production `surface-mutation` awaits the atomic operation/file intent before applying the first surface or disk side effect. Startup reconciliation reads unfinished agent-mutation operations and performs conditional disk observation through the same operation revision. Local test contexts without the port retain their isolated SQLite fixture helpers. Combined recovery’s older public engine methods and branch undo/reconcile remain outstanding and keep R1 Partial.

### D-270 · 2026-09-13 · R1 acceptance boundary after consumer slices

类型：验收记录；只追加，不改写 D-265–D-269 正文

本轮新增的生产证据是：生成式 `working.*` DTO 在真实 release 子进程中发布 root-bound result；result envelope 不含 `pathStates`；root preview/selected identity 不调用 branch snapshot；directory Integration 和 agent surface/disk mutation 在 kernel operation intent/file CAS/terminal revision 上运行。旧 `WorkingStateStore` callback 适配器已改名并明确为迁移兼容层，仍有 publish/materialize/history、branch undo/reconcile 和 combined Recovery public methods 尚未完全切换，因此不宣称 R1 完成。R0/R1 仍按实际证据保持 Partial，R2–R6 未变。

### D-271 · 2026-09-13 · Result publication uses root store CAS

类型：R1 root consumer continuation；只追加，不改写 D-270 正文

ThreadRuntime partial/settle result publication now invokes the async root store. Directory capture only sends the requested changed paths; the kernel performs branch writeRevision/root CAS and publishes the immutable result record through `working.result.put`. Virtual publication uses the current branch root and fixed revision identity. The callback compatibility adapter remains for draft/verification/history and other not-yet-converted consumers.

### D-272 · 2026-09-13 · Selected result publication regression guard

类型：R1 反例修正；只追加，不改写 D-271 正文

The root publication path now tolerates a selected-path read that reports an absent entry as a `missing` state before building the three-way preview. This preserves delete/new-file semantics when a result was published from a narrow changed-path set and prevents the compatibility projection from reintroducing an undefined flat-map entry. The production storage-adapter integration test passes through the real kernel branch authority and durable journal composition.

### D-273 · 2026-09-13 · Acceptance correction: Rust-only recovery, ordered phases, pinned publish, and concrete working DTOs

类型：验收退回与返工约束；只追加，不改写 D-265–D-272 正文

D-267–D-272 的“wired”表述不代表生产 consumer 已迁移。返工必须关闭以下事实：surface Integration 的 external/receipt/undo/reconcile 仍可回到 TS SQLite；agent mutation 的 durable phase queue 仍可能 fire-and-forget；result publish 尚未把 current-root pin 贯穿 diff/read/publish；working DTO 仍含 `unknown`；生产 callback compatibility adapter 与 `withStore` 仍能展开全树；combined Recovery/Integration/agent-mutation/startup fence 仍存在双路径。

本轮验收门槛改为：生产 durable context 不要求 database；所有 durable phase/terminal 方法返回并等待 Promise；surface/disk side effect 只能发生在对应 Rust CAS 完成后；result 的 diff、changed-path read 和 publish 必须绑定同一 pin/root/writeRevision；working record 使用生成的具体嵌套 DTO 并核验真实 branch/result identity；生产装配删除 compatibility projection、TS recovery writer、SQLite fallback 和 optional dual path。测试 fake 只能通过同一 `RecoveryDurableOperationPort` 注入。R1 在所有门槛满足前保持 Partial。

### D-274 · 2026-09-14 · R1 production metadata cutover uses immutable roots and one Rust recovery writer

类型：D-273 验收收口；只追加，不改写 D-273 正文

R1 的生产 WorkingState consumer 统一使用异步 immutable root/path/domain API；Application Host 不再提供 callback 全树 compatibility adapter。branch metadata 在 branch create 事务内发布，draft 是固定 branch/revision/root，result/verification/review 明确绑定 branch 与 revision。scope 在 Rust 遍历前执行；pin/diff/blob read 核验来源。result/draft/branch release 与 revision、依赖记录和对象引用由 Rust 事务协调，独立 pin 保留仍可达的 root。

combined Recovery/Integration/agent-mutation 的唯一生产耐久元数据 writer 是 `KernelRecoveryStore`。TS Documents/Registry 和文件副作用只在对应 Rust operation/file phase CAS 后执行；phase 和 terminal Promise 必须等待。导航提交的响应丢失时，启动对账以同 operationId 重放幂等导航；无法确认时进入 needs-attention，不得补偿文件并造成会话/磁盘分裂。旧 WorkingState 与 local SQLite recovery engine 仅可作为测试 helper，生产 import graph 不可达，不保留 dual write 或 fallback。

Rust catalog `user_version` 与握手 storage format 同为 v9。R1 仍为 Partial：storage location 的产品语义、macOS/Linux 与签名包、断电级故障窗口尚无证据；Documents/Registry、真实磁盘 apply 和物化资源后端属于 R2/R3，不能因元数据切换而冒充完成。

### D-275 · 2026-09-14 · R1 收口：内置 kernel storage 固定共址，发行签名与物理断电不是 R1 gate

类型：R1 acceptance closure；只追加，不改写 D-274 的历史实施事实

问题：D-274 已完成 production metadata cutover，但把 storage location、macOS/Linux/签名包和断电级验证一起留作 R1 blocker。这里混合了三个不同层次：内置 provider 的产品语义、R0/发行 CI 的平台 package evidence，以及无法在普通开发测试中诚实证明的物理掉电 QA。与此同时，Recovery Settings 仍无条件展示旧 SQLite provider 的 location/migration 控件，而 Rust facade 已正确声明 `storageManagement:false`，形成产品合同不一致。

决定：

1. `piarium.builtin.recovery` 与 WorkingState 使用同一 `<PIARIUM_DATA_DIR>/kernel/<hostId>` Rust storage authority。它公开报告 `application-data` / `storageManagement:false`，不提供 workspace-local、adjacent、custom 或独立 migration；把 Recovery 单独搬走会重新拆开 R1 已统一的 object/reference/transaction authority。Recovery UI 必须按 provider capability gating location/migration 控件。
2. recovery v5 的四种 location 与 move 方法继续作为 replacement provider 的可选能力；provider 只有声明 `storageManagement:true` 才需要实现。内置 kernel 的选择不删除公共扩展合同，也不允许 replacement provider 直接移动 kernel 私有 catalog。
3. R1 durability 的可执行验收是：内容对象先 flush/install 后发布引用，平台对应的 rename/目录持久化顺序明确，SQLite 事务保持单 writer；operation/recovery 关键事务窗口有 fault injection；GC physical cleanup failure、terminal response loss 和 unfinished operation 能在 restart 后对账。真实物理断电 campaign 可以作为后续 release QA，但不作为无法稳定自动化的 R1 实现门槛。
4. native macOS/Linux/Windows package smoke 属于现有 release CI/R0 发行进程证据；开发者不需要拥有所有平台。当前产品文档明确允许 unsigned Windows installer，并且 public macOS workflow 有意产出 unsigned artifacts，因此代码签名不是 R1 gate。

结果：R1 状态与存储标记为 Complete。R0 保留其独立的 process/package evidence 状态；Documents/Registry、真实磁盘 resource gate/file apply 属于 R2，baseline/materialization/CoW 属于 R3，R4–R6 均不因本决定提前完成。

### D-276 · 2026-09-14 · R2 收口：一个 Rust file-resource authority，Registry 保持 buffer 权威

类型：R2 production file authority closure；只追加，不改写 D-275 及更早历史事实

问题：R1 已把 WorkingState 与 Recovery/Integration/agent-mutation 的耐久元数据统一到 Rust，但真实磁盘副作用仍可能经过 Documents、Files、RecoveryFileStore、Workspace/API adapter 与 pi-host 原生工具各自的路径锁/写盘实现。若只把 Recovery `applyState` 改写成 Rust 而保留 TS `PathLockService`、pi-host `writeFile/rm` fallback 或 adapter 自己决定“现在可写/可回收”，R2 会留下第二套资源权威，并且 mixed Registry/disk 操作仍无法可靠解释 terminal response loss。

决定：

1. Rust kernel `fileResources` 是 Piarium 生产的 canonical file-resource authority。Application Host 先用 Documents 授权后的 canonical execution root 注册 epoch-local root；Rust 再核验 grant owning/execution identity、path scope、ancestor canonicalization 与 symlink/reparse escape。exact/subtree overlap lease、稳定 typed file-state capture、内容对象安装、条件 apply、mkdir/remove/rename 与 started-operation restart reconciliation 都在该 authority 中执行。
2. Documents write/move/delete、workspace-scoped Files CRUD、Recovery/Integration disk apply/compensation 和生产 `fs.lock` 共用该 Rust backend。TS Documents 继续拥有 workspace registration、公开 revisioned API、watch、surface orchestration 与 mutation token；它不再拥有独立生产磁盘 queue。测试或未装配环境可以注入本地 helper，但生产不得 fallback。
3. Document Registry 继续是未保存正文、document instance 与 grouped undo 的唯一权威。Rust 持久化 mixed operation intent/file phase 和磁盘事实；Host 定向请求固定 Registry owner 做 CAS/apply/undo 并把回执推进耐久状态。等待 Registry 或其他外部回执时不持 SQLite transaction；无回执或状态不可证明时进入 conflict/needs-attention，而不是把 disk 当 surface 或猜成成功。
4. Piarium 模式下，Pi `write` / `edit` / `apply_patch` 先尝试 `document.branchWrite`；需要真实 workspace/surface mutation 时统一调用 Host `document.surfaceWrite`。若 Host mutation backend 不可用，worker 明确失败，不再调用 Pi worker 的本地 `writeFile/rm` 作为平行生产 writer。无 Host bridge 的独立测试/standalone Pi helper 不属于 Piarium Application Host 权威，可继续验证其自身行为。
5. 尚未迁移到 Rust 领域实现的 WorkspaceAPI/Git/bulk/external adapter，在执行副作用前向同一个 kernel gate 注册 exact/subtree writer；不保留另一套可写/可回收 gate。Git baseline、materialization staging/CoW、shell settle/writeback、执行目录回收与 Thread 目录生命周期仍属于 R3，不能因 R2 single-gate 收口提前宣称迁移。
6. Recovery maintenance capture 创建的临时 object owner 只能在同 workspace 且源 grant 具备 `recovery.maintenance` 时 rebind 到精确 recovery actor；通用 storage writer 不能借该接口接管别人的临时对象。

证据：Windows release `piarium-kernel` child-process suite 23/23，通过 file root/lease、scope/escape、conditional apply/stale CAS、finish-failure→restart reconcile 与生产 `fs.lock`→Rust lease；真实 `kernel-durable-engine.test.ts` 通过 combined Recovery + lost navigation response + kernel restart + undo。Documents/surface/Files/Workspace/external focused tests 106/106；pi-host mutation/apply_patch focused tests 18/18；Application Host type-check 与 pi-host source build 通过。`integration-coordinator.test.ts` 的 17 个旧 SQLite test-helper 失败在 R1 基线 `ad71ea78` 上同样为 17 fail / 20 pass，因此不是本次 R2 新回归，也不据此恢复生产 TS writer。

结果：R2 文件与恢复标记为 Complete。R0 保留独立 process/package evidence；R3–R6 不因本决定提前完成。

### D-277 · 2026-09-14 · R3 收口：固定 baseline、durable materialization 与受管目录生命周期统一到 kernel

类型：R3 production baseline/materialization closure；只追加，不改写 D-276 及更早历史事实

问题：R2 已统一文件 resource gate 和受控磁盘 mutation，但 baseline 枚举/正文捕获、virtual→materialized staging/rename、Git execution body copy、materialized result snapshot、reclaim/space measurement 仍有 TS 文件系统实现。如果只把物化写文件改成 Rust、却继续让 ThreadRuntime 自己扫描/复制/交换目录或让 Git worktree checkout 重写正文，仍会存在第二个 execution-directory writer；如果把 Git filter/LFS/EOL/index 语义直接重写成 Rust，又会丢失 Git 真实配置。R3 还必须能解释 staging 已完成、live 已移成 backup、进程在 promote 前崩溃的中间状态，而不是只覆盖成功路径。

决定：

1. 生产 baseline 的 filesystem inventory 与 body capture 统一使用 kernel `file.scan` / `file.capture`。Application Host 先按 Documents 或受管 application-data root 做 admission，WorkingState 使用创建 branch 的同一 scoped grant 注册 file root，因此 capture object owner 可被 branch create 原子消费，不需要放松 R2 的跨 grant owner 规则。Git 继续负责 staged/unstaged/untracked、index mode、dirty-content identity 与 gitlink/filter 身份；完整 capture 后再按同一路径集合核对 typed file state，并在 Git/目录 inventory 与 frozen `captureScopes` 两端复核，变化即 `baseline-changed`。
2. `file.materialize` 从 immutable root 构建 operation-specific staging，逐对象验证 hash/length 后安装正文。Linux 尝试 FICLONE、macOS 尝试 `clonefile`，能力不支持时普通 byte copy 是正式后端；权限/对象损坏等真实错误不降级。Windows 当前实现和本机验收只证明普通 copy，因此 `reflink:0`；未测文件系统不得因代码存在 clone 调用就声称已证明 CoW。
3. materialization 切换由 kernel durable operation 拥有 staging/backup/promotion。live 已移到 backup 后、staging promote 前的故障有专用注入反例；重启重新注册 root 时，若 staging 可证明等于 source root 则完成 promotion，若 staging 不完整而 backup 可用则恢复 backup 并返回 conflict，若 live 被后写则保留可证明状态而不猜成功。native result root 是生产 archive/history 的固定身份，不再要求相邻 `.snapshot` 才算结果已保留；旧 TS materializer/snapshot/materialization-switch 只保留测试/未注入 kernel store 的 seam，不是生产 fallback。
4. Git execution context 不再通过 `live→overlay→git checkout→copy body back` 建立。Host 只创建临时 `--no-checkout --detach` linked-worktree metadata，把 `.git` admin binding 指向已由 Rust 构造的 live body，然后执行 `read-tree`、`git add -A` 与内部 baseline commit。这样真实 `.gitattributes`、clean/LFS/EOL/working-tree-encoding/index 语义继续由 Git 决定；required clean filter 失败必须中止并保持 materialized bytes 不变。reclaim 后 prune linked-worktree metadata。
5. materialized settle/writeback 对 Git 使用其真实 changed paths/index modes，并把 branch 冻结 `captureScopes` 的 prior/current 路径并入 Rust capture，因此 ignored scope 的新增、修改、删除不会遗漏；非 Git 使用完整 Rust inventory。capture 后再次 Rust recapture，稳定后才推进 WorkingState root/result。reclaim、retrieval discard 与 Thread delete 在生产通过 kernel subtree remove；Thread/Run 是否允许回收、活动 writer/command/editor/Integration guard 仍由 Host/Registry policy 决定。
6. `file.measure` 把执行目录空间扫描迁进 kernel。Unix 使用 `stat.blocks * 512` 报实际 allocated bytes；Windows 当前没有已验证 physical-allocation backend，故 `allocatedBytes:null`，不以 logical bytes 猜测。共享 object store 的空间引用仍由 R1 GC/引用规则单独统计。

证据：Windows release `piarium-kernel` child-process suite 25/25，其中 R3 真实子进程反例覆盖 scan/capture→immutable root→materialize/reclaim/rematerialize、Windows truthful copy/measure，以及 `live→backup` 后故障→kernel restart→staging promotion/operation reconciliation；R1/R2 原 23 项同时保持全绿。真实 release-kernel `storage-adapter.test.ts` 5/5；ThreadRuntime 66/66；ThreadWorktree 23 pass / 1 platform skip，并新增 required clean filter 失败时正文不变和 linked-worktree metadata reclaim；execution-baseline 与 materialization-switch focused tests继续通过。Application Host source/test TypeScript、Rust cargo check、release build均通过。未在本机证明的 Linux/macOS filesystem clone 行为只作为实现能力，后续 release/platform QA 可补证据但不反向制造 Windows R3 blocker。

结果：R3 基线、物化与资源生命周期标记为 Complete。R0 保留独立 process/package evidence；R4–R6 不因本决定提前完成。Registry 仍拥有 unsaved buffer；Git 仍拥有 Git 语义；Thread/Run 生命周期策略仍归 Host。

### D-278 · 2026-09-14 · R0–R3 审查返工：修复物理租约、GC、操作重试与实际装配，重新打开 R2/R3 完成度

类型：独立反例审查与正确性返工；只追加，不改写 D-275–D-277 的历史正文

问题：在 `e465e2df` 的真实 release kernel 上，新写的十个反例全部失败，涉及跨 root/alias 同盘 writer、反向 lease coverage、租约重用、root 替换、rename 假成功、remove 重试误删用户新文件、跨 grant owner 和 execution-only maintenance 装配。进一步复现了 GC 陈旧物理删除意图伤害重新引用的 blob、未完成 operation 被释放、ephemeral query pin 跨 epoch 保留及 Documents nested exact/subtree shortcut。原 combined kernel recovery 测试使用 fake Documents/no-op gate，不能作为完整生产组合证据。

决定：

1. `file_resource_leases.rs` 作为同一 Storage 的独立物理互斥模块，跨 root 检查 canonical paths；overlap 对称而 coverage 有方向。leaseId 重用绑定相同资源和身份，生产 nested Host/Documents gate 调用生成协议 `file.lease.check`，不由 TS 自行扩大租约。
2. 每次解析重核 root 与 canonical scope；apply 验证临时 owner 的 workspace/hash/grant。remove/rename 中断后先观察可证明事实，不重放不可逆副作用，不把无关 target 当成功。物化保护未收集内容，验证失败保留 live/backup，readonly 安装和目录同步按实际句柄/层级完成。
3. GC 尊重重新安装的 catalog fact、started file operation 及其 materialization source root；operation.release 不释放未完成操作。旧 epoch query pins 清除，显式 revision pins 保留。owner 不以 INSERT OR REPLACE 覆盖其他身份。
4. managed-root admission 依据 owning workspace 的真实 Thread 记录和既有 ownership assertion，不以 data-directory 前缀或目标自身的新 Documents root 猜权限。baseline/settle/reclaim 继续携带实际 execution identity。失败的 branch metadata 读取不得吞为 null 来迁就不完整 fixture。
5. file.scan continuation 绑定 inventory fingerprint；变化直接失败，不伪造稳定分页。此修复不声称消除了每页重扫或逐文件 RPC。Node/Vitest 测试入口拆开；`test:kernel` 拒绝缺失 release binary，现有 Linux/Windows CI job 显式构建并执行 native authority tests。

状态修正：R1 核心 production metadata cutover 保持 Complete，本轮修复其 GC/pin 正确性。R2 改为 Partial（生产文件权威已接通，低层 pending operation 到 Host 可见处置仍待闭环）；R3 改为 Partial（kernel 原语/主要消费者已接通，kernel promotion→Git executionBaseline→Thread Registry/execution view 尚无贯穿的 durable switch intent/receipt，setup 停止与真实退出也需验收）。这不是新增签名、本地跨平台或物理断电门槛，也不恢复 TS writer。R0 保持 Partial，R4–R6 不变。

证据与未决项详见 [rust-kernel-audit.md](../plan/rust-kernel-audit.md)。新增反例在真实 release kernel 上运行；真实 DocumentAuthority 的保存/移动/删除、独立 owning/execution 的 materialize/publish/restore，以及去掉 no-op gate 的 combined Recovery/restart/undo 均纳入同一验收。更新 workflow 不冒充远端 CI 已绿，legacy seam 单测不冒充 native 生命周期证明。

### D-279 · 2026-09-14 · R2/R3 复核收口：未决文件操作可处置，物化跨域 handoff 可重入

类型：D-278 reopen gate closure；只追加，不改写 D-276–D-278 的历史事实

问题：D-278 保留了 R1 单 writer 与 R2/R3 主要原语，但指出两个不能用局部成功替代的缺口。第一，kernel 能保留低层 pending file operation，却只把数量带回 root registration；Host 无法列出“哪次操作、哪些路径、为什么未决、能否安全重试”，目录 rename 这类证据不足窗口会在产品层隐身。第二，kernel 的 materialization staging/promotion 可恢复，但 native Host 路径没有一条跨 source root/writeRevision、operationId、Git executionBaseline、Thread Registry 与 execution view 的持久握手；setup timeout/abort 还把 kill 请求当成已经退出。同期 IntegrationCoordinator 的旧 fixture 仍直接读取退役 SQLite 内部表，并暴露 operationId 复用、parent-turn binding 与 terminal commit/reconcile 的真实行为缺口。

决定：

1. R2 不新增 TS 恢复数据库。kernel 以 typed `file.operation.list/reconcile` 暴露未决 file operation；Host registration 保存 identity/disposition/reason，并提供显式安全 reconcile。reconcile 只执行现有证据能证明的对账；目录 rename 若不能从保存的 source state 与当前目录事实证明完成，则继续 retained/needs-attention，不提供强制成功或破坏性重放。
2. R3 native materialization 使用 Thread Registry `materializationHandoff` 作为 Host 持久 intent/receipt：固定 branch/root/revision/writeRevision、kernel operationId、pinId、stage、Git kind/executionBaseline。current root 由 maintenance-scoped persistent kernel pin 保活；revision view 使用固定 revision pin。kernel materialize 与 Git attach 分阶段持久化，同一 operationId 重入，不重读“当前最新 root”冒充原操作。
3. Git attach 只认可 Piarium 自己创建且可证明 parent/HEAD/clean 状态的 execution baseline；重复 attach 返回同一 receipt，未知 `.git` 明确失败。`git-attached` handoff 必须先成功 release durable pin，再清 Registry intent；release 失败保留 receipt，restart 重试同一 unpin/commit，不制造孤儿 pin。persistent current-root pin 进入 protocol schema，并在 deep health 中按 branch head_root/writeRevision 校验而不是误当 published revision。
4. setup timeout/abort 的“已请求终止”和“进程已退出”分开：发送 kill 后只有 child `close` 才结束 setup promise，目录生命周期不能在真实退出前进入可回收状态。R4 仍负责通用 PTY/process backend，本条只关闭 R3 现有 setup 交接。
5. IntegrationCoordinator 的验收迁到 production `journal-engine` + durable operation port 语义，不再打开旧 SQLite operation tables。文件副作用后先进入 `awaiting-turn-binding`，把 `thread.merge` before/after 绑定到 active parent turn，再 terminal CAS；restart 从 operation-file phase 重建 applied paths。terminal CAS 失败执行 conditional compensation；同 result/resulting-parent-state 的 terminal retry 复用原 operationId。legacy WorkingState/SQLite 仅保留独立 test fixture，不恢复生产双 writer。

证据：正式 `bun run kernel:build` 构建的 Windows release kernel 下，统一 `bun run test:kernel` 57 passed：`kernel-client.test.ts` 25/25（含 persistent current-root pin 跨 Host restart 与 maintenance release）、`file-resource-audit.test.ts` 26/26、`storage-adapter.test.ts` 5/5、`kernel-durable-engine.test.ts` 1/1。IntegrationCoordinator 37/37；ThreadRuntime/ThreadWorktree 91 passed / 1 platform skip，覆盖 pin release 失败保留 git-attached receipt、重试完成、Git attach 幂等和 setup 等真实 close。Application Host source/test type-check、protocol generation check、Rust release build、`git diff --check` 通过。

结果：D-278 重新打开的 R2/R3 两个具体验收 gate 均关闭；R2 与 R3 恢复为 Complete。R1 保持 Complete。R0 仍为 Partial，R4–R6 不变；远端 CI、未测平台 CoW、签名和物理断电不被新增为本决定门槛。

### D-280 · 2026-09-14 · R4 原生进程权威：共享 PTY/pipe、实际退出与 writer 生命周期

类型：R4 production process authority closure；只追加，不改写 D-279 历史证据

背景：R1–R3 已接管状态、文件与物化，但 TS terminal/provider、setup 和 LSP/DAP/tasks/tests 仍自行拥有 OS process。只搬一个 spawn 函数会留下平行 PTY、失联假退出、异步启动取消漏 child 和提前释放目录等问题。

决定：Rust format-v10 catalog 在唯一 Storage 中持久 process identity/status/tombstone；生成 `process.*` 契约，scope/canonical root/grant 和已有文件资源边界共同准入。阻塞 PTY/pipe 工作由同一 executable 的 guardian 持有，guardian 无数据库、无公网端口，不重建 Pi broker。原字节 channel/cursor、bounded output backpressure、stdin sequence/content/ack、resize、kill/实际树退出与 release 属于该后端。Windows Job、Unix managed session 与 Linux subreaper 为实际退出提供证据；旧 epoch 无证据时 unknown，不盲杀 PID、不重放命令。

Host 注入同一 native service 到用户终端、Harness shell、Thread setup、LSP/DAP、task、Node test 和测试 provider；TS 保留协议、展示、provider selection 与 product startup owner。pending launch 纳入取消/替换/dispose；失败 handoff 携带 child，停止失败保留 row/writer。RPC/pipe 断开不伪造 exit，kernel loss 使 terminal/shell/protocol 明确失败；writer close 失败可重试，不吞错。startup owning/execution admission 由真实 retained Thread 与 Documents 注册证明，不根据临时目录前缀猜授权。

实现中反例修复：spawn 参数误传给 process.read；stdin/close cleanup race；取消期间晚到 child；Node-test 的 exit-only wait；协议流 error 回调抛出；terminal shutdown 先删 owner 后忽略 kill failure；shell unknown exit 被投影为 0；全局 Socket unref workaround；ConPTY 最后输出尚未排完就清理 console-host Job 成员所造成的输出/exit receipt 丢失。最后一项以 12 次连续真实 PTY startup/resize/final-output/code-0 验证，未放宽断言。

边界：Pi session/catalog/inference worker 生命周期仍归 runtime-broker；Git 短命令、shell 发现/bootstrap 留作既有领域适配，不另造统一调度框架。生产不选择 Node/Bun PTY；剩余 unused distribution dependency/rebuild probe 清理属于 R6。没有新增敌对代码 OS sandbox、物理断电、付费模型、本地 macOS/Linux 或签名验收门槛。旧内部 catalog 直接按 v10 校验，不自动迁移或删除用户 Workspace/Pi/Git 数据。

证据：Windows release `bun run test:kernel` 80 passed（Node 25 + authority audit 26 + storage 5 + combined Recovery 1 + native process 16 + consumer/admission 7）；affected focused suites 233 passed / 1 platform symlink skip；Application Host source/test、Protocol 与 UI 类型检查、Protocol build、targeted lint 通过。Rust release build、check、unit tests 4/4 与 format/protocol drift 已验证。独立真实 Host 进程退出、kernel death/restart、后代进程清理、kill refusal、lease/revoke、backpressure 和不重放均有原生反例。另有显式授权 temp workspace 的真实 Application Host HTTP terminal create/inspect/delete/stop smoke；不是完整 browser/Electron smoke，远端 CI 结果另行记录。准确证据与后续范围见 [status](../status.md)。

结果：R4 按生产 process authority/consumer/failure 契约 Complete，R1–R3 保持 Complete。R0 Partial，R5/R6 未完成；整个阶段 R 未完成。

### D-281 · 2026-09-15 · R5 原生文件/结构计算：固定视图、生产消费者与索引输入收口

类型：R5 production file/structure compute authority closure；只追加，不改写 D-280 及更早历史事实

背景：R1–R4 已完成状态/文件/物化/进程权威接管，但 R5 原型最初仍有两个不能用“native helper 已存在”替代的生产缺口。第一，search/file-find/catalog 的旧测试与部分入口仍围绕 Host `spawn`/ripgrep、递归 filesystem scan 和 WorkingBranch corpus/body mirror；如果保留兼容路径，Rust compute 只是旁路。第二，semantic/symbol 索引虽然开始调用 native tree-sitter，但 disk 和 virtual Thread 仍可能先把完整正文读到 TS，再传回 kernel 解析，无法满足固定 pin 与跨边界只传必要记录的目标。

决定：

1. `compute.start/read/cancel/release` 是同一 kernel 内的 read-only job boundary。source 必须是 immutable WorkingState pin、Host-admitted live root 或显式 fixed objects 之一。pin admission 复制短生命周期 reader pin；caller unpin、branch delete、GC 不能改变正在执行的 source。live root 不冒充 immutable snapshot：正文/结构记录绑定实际 native revision，读取窗口漂移只允许 partial/failed。Registry draft 作为 fixed object/tombstone overlay，并在候选预算前遮蔽 parent source。
2. Rust compute 使用两个 foreground worker 和一个独立 background worker；bounded record queue/cursor 提供背压。取消请求到达实际 worker，caller 必须观察 terminal 再 release reader。scope、requested roots/files、exclude/tombstone 在 candidate matching 与 maxResults 前应用。Git ignore/tracked membership 使用固定 `git ls-files` inventory adapter；文本匹配使用 Rust grep/ignore ecosystem，不保留 Host ripgrep process fallback。
3. workspace `search.content`、file find、Harness grep/explore、language catalog、project-icon candidate search、symbol graph 和 semantic disk scan 统一复用 `KernelComputeService`/native file inventory。目录枚举携带 revision，使 catalog/index 可在不先读正文的情况下跳过当前文件。旧 `SearchChild`、`branchCorpus/searchCorpus`、Host recursive file-search path 已从生产契约删除；对应测试也迁到 native contract，而不是重新加兼容参数。
4. tree-sitter parser/query/structure/chunk computation归 Rust。Host 只注册 grammar/query recipe、验证 bounded DTO 并做产品投影。disk graph 通过 `analyzeFile` 直接得到同一 revision 的 outline/import/call/line-length；semantic disk scan 通过 `unitsFile` 获取结构 unit。virtual Thread query 不再暴露 bulk `visitDocuments/files[]`：pin 只提供 path/revision + pin-bound `compute`，semantic 通过 `unitsFixed` 在同一 immutable root 上产生结构 unit，再由 TS tokenizer/embedder 处理。surface draft 仍可传 text，因为未保存正文的权威就是 Registry。
5. R5 不迁移不属于该领域的权威。TriviumDB/图写入、semantic vector store、tokenizer/embedder、remote inference/Pi 保持现有 TS/Pi owner；LSP 保留导航/诊断/协议职责。Host `web-tree-sitter` 只用于 grammar 安装 ABI admission，不解析 workspace source，因此不是第二套 R5 parser。generic Files UI 读接口也不因 R5 被重分类为 compute authority；其受控 mutation/resource 边界仍由 R2 定义。
6. 删除零调用方 Host JSON outline parser，并移除生产 TS ripgrep/recursive scan、WorkingBranch corpus/body mirror、Host AST/chunker discovery。内部没有用户兼容要求，不为这些路径保留默认关闭、失败回退或 shadow 双实现。

证据：正式 Windows release kernel build 通过。`kernel-compute.test.ts` 10/10，覆盖 immutable pin 对 parent live drift、draft/tombstone、scope、UTF-16 column、reader+GC、foreground/background backpressure、实际 cancel、Git ignore + force-tracked、native tree-sitter fixed text/live disk/fixed pin chunks 和 root replacement failure。R5 focused consumer 回归 13 files / 118 tests 全绿。完整 `bun run test:kernel` 90/90（Node transport/storage 25 + native Vitest authority/adapter/recovery/process/R5 65），证明 R1–R4 既有 native contract 未退化。Application Host source/test TypeScript 通过；protocol generation `--check` 通过；Windows VS Build Tools 环境下 `cargo check` 通过，Rust unit tests 4/4；51 个改动 source/test TS/TSX 的 ESLint 通过（generated protocol 由 generator/type-check/drift gate 验证）；docs tests 19/19，docs validation 378 pages / 323 local links；`git diff --check` 通过。普通 PowerShell 未加载 MSVC 时 `kernel:check` 会因缺 `cl.exe` 失败，显式加载仓库已安装的 VS Build Tools 后相同 cargo check 成功，这是本机环境差异，不是代码失败。

结果：R5 按 native compute / production consumer / index-input / cancellation-scheduling 契约标记为 Complete。R1–R4 保持 Complete。R0 仍为 Partial，R6 仍未完成，因此阶段 R 整体仍未完成；packaged/跨平台发行与端到端性能定标留给 R0/R6，不反向制造 R5 blocker。

### D-282 · 2026-09-15 · R0/R6 收口：有回执的传输窗口、真实发行面、遗留清理与受控资源证据

类型：R0 process/package 与 R6 complete acceptance closure；只追加，不改写 D-281 及更早历史事实

背景：D-281 已完成 R1–R5 的资源权威接管，但阶段 R 仍缺两组整体证据。R0 的 Host transport 虽有单请求背压与取消，blob data frame 没有逐块回执，串行 worker 忙时也缺少“控制仍可到达且在飞请求有界”的真实饱和证明；截断输入、任意 cwd 和安装目录替换后的同库重开尚未形成一个 release 契约。R6 还没有把 Web/云/Electron/VS Code 的真实发行树、旧 Node PTY/SQLite authority 清理、surface shutdown/纵切与同机同语料资源测量合成一个可复现验收。只把 workflow 写出来或把 Rust helper 跑绿，仍不足以关闭阶段 R。

决定：

1. kernel handshake 发布 `requestWindow`，当前值 2 是 transport credit，不是产品并发配额。普通 request、blob chunk 与 branch builder batch 在 Host 编码前取得 credit，只有匹配的 native response 或连接终止才能释放；caller cancel 先拒绝等待者并发送独立 cancel 控制帧，但在 Rust 回执前不归还 credit。Rust admission queue 使用同一常量，拒绝重复在飞 request id、畸形 request 和超窗发送。旧无回执 `kind:data` 删除；chunk 是有序、每块不超过 64 KiB 的 typed request。截断/损坏输入结束该 epoch、取消剩余 token、排空 worker/writer，之后可用新 epoch 重开同一 current-format catalog。
2. 发行目录是 R0/R6 的运行权威。Web/云携带 `packages/web/kernel` 和独立 verify 脚本；Electron 携带 `resources/kernel`，package 前、after-pack 和 unpacked smoke 都核对 build/target/arch/SHA-256；VS Code companion 携带 `dist/kernel`，workspace search 直接使用同一 Host compute 实现。缺 kernel/manifest 明确失败，不允许 Cargo、source loader 或 ripgrep fallback。release smoke 必须从无关 cwd 启动，复制到另一安装目录后以新 epoch 重开同一数据，并拒绝坏 manifest。
3. 删除 Web/Electron 生产 `node-pty`、`bun-pty`、`better-sqlite3` 依赖和 Electron rebuild 脚本。TriviumDB、sherpa 和 Pi 仍按各自领域验证，不因阶段 R 被移入 kernel。Application Host build 对实际 emitted `index.js`/`public-contract.js` 及 worker URL 做 import-graph 审计：可达旧 store/test helper 失败，不可达测试/旧 authority artifact 在发布前删除并生成 manifest。旧 TS recovery file writer 移到显式 test helper；生产 `journal-files` 只保留 path/hash reader。
4. Web 与 VS Code Documents watch 必须传递 `surface-operation`，不能只传 dirty barrier；Document Registry `dispose()` 返回同一个 Promise 并等待最终 journal 与 dirty-owner release。原先位于 Application Host 目录、可能随生产 emit 的 surface vertical JS 测试改为 Web test，使用真实 release Rust storage/file/recovery authority 与 Registry 完成 disk+surface apply/undo。
5. R6 性能/资源证据使用 `scripts/measure-kernel.mjs`。固定 128/1024/4096 文件的路径、UTF-8 字节与语料 hash；D-280 后/R5 前的 TS 产品路径从固定 commit 导出到临时树，当前 Rust 产品路径从 staged release 运行；两者独立进程、交替顺序，记录首调、2 次 warmup、8 次热样本、事件循环、分阶段 RSS。Rust 另记录固定 root create/read、单路径 write、node 增量、WAL 文件长度变化、后台背压下前台读取和 cancel→terminal/release。WAL 文件长度不是物理写放大，瞬时 RSS 未覆盖 baseline 短命 rg 子进程；不得据此给统一 Rust 倍数或内存胜负。
6. 性能结果按实际数据接受：Rust warm content search 在 128/1024/4096 文件为 45.696/278.325/1166.156 ms，对应 TS 192.042/435.825/1229.434 ms；三档均改善，4096 文件差距较小。Rust inventory 9.073/20.914/77.911 ms 与单文件 structure 35.939/37.346/51.432 ms 慢于 TS 的 1.318/7.210/23.862 和 20.887/22.502/22.304 ms，但保持有界且没有系统性事件循环阻塞。固定 root 单路径写 p50 4.005/4.484/4.540 ms，只新增 12/15/17 个节点；后台背压时前台读约 11 ms，取消至 terminal+release 为 13.919/18.321/22.373 ms。这里不为更好看的结论隐藏负项，也不因此恢复旧 backend。

证据：`bun run test:kernel` 通过 Node release child-process 25 项和 native Vitest 70 项；新增饱和窗口、并行流式上传、queued/active cancellation、截断输入与重启。`smoke-kernel-release.mjs` 覆盖任意 cwd、manifest identity、固定 root search/structure、条件 file apply、真实 shell exit 7、安装目录复制和同库重开。VS Code native search 2/2、真实 Rust+Registry Integration 1/1、Document Registry 29/29、production graph audit 7/7。Windows unpacked Electron smoke 返回 Host health、builtin recovery、native semantic/structure 与 terminal create/close，两个 smoke stderr 均为空；production boundary 为 385 个 runtime module、移除 52 个 artifact、禁止引用 0。Windows release build 成功；直接在未加载 VS SDK 的普通 shell 执行 `cargo check` 会缺 C headers，仓库 `kernel:build` 自动加载 VS Build Tools 后成功，该环境差异不记为代码失败。

发行平台边界：本机只证明 Windows x64。Windows ARM64、Linux x64/ARM64、macOS x64/ARM64 的 matching native runner build/verify/package/smoke 已成为 release workflow gate，当前提交尚未观察远端结果，不把 Windows 结果冒充其他平台实测。当前产品允许 unsigned Windows/macOS artifact，签名不是 R0/R6 gate；真实 ReFS/APFS extent sharing、物理断电 campaign 与付费模型质量继续单列环境/领域证据。

结果：R0 与 R6 标记 Complete；R1–R5 保持 Complete，阶段 R 整体完成。后续外部 MCP/ACP、research profile、新模型和产品优化直接使用 Rust kernel/TS Host/Pi worker 的现行边界，不再维护迁移 fallback 或重复 TS 系统权威。

### D-283 · 2026-09-15 · 现有 Harness 优先收口：原生权限唯一权威与 Web 配置闭环

类型：产品与实施顺序调整；本条定义下一阶段，不把未实施目标写成当前交付

背景：阶段 R 已完成，继续优先建设对外 MCP/ACP 会绕开现有 Harness 的两个所有权缺口。权限方面，foundational
`@gotgenes/pi-permission-system` 当前仍在会话发布 service 后独占用户确认，Piarium 原生门只覆盖 Harness 工具并让非 Harness 工具
通过；因此原生权限设置通常只是 fallback，产品同时存在 Harness 权限与 Plugin Settings 两套入口。Web 方面，`webfetch` /
`websearch` 已是可运行的 Host/Harness 原生实现，但启用 `pi-web-access` 会按包检测自动让位，搜索 provider 在 Host 启动时冻结且修改
需要重启；文档承诺的域名策略未进入生产装配，`maxFetchesPerTurn` 已进入协议却没有消费者。

决定：

1. 外部 MCP façade、ACP host 与 research profile 暂不作为下一实施主线。先完成现有 Harness 的权限和 web 收口；它们完成后再按产品
   价值选择外部 runtime 或新领域。
2. Piarium 原生 pi-host `tool_call` 门成为唯一交互式权限权威，覆盖 Harness、Pi 内置、MCP、Pi 包工具与嵌套线程。Host 的
   actor/capability/workspace/path enforcement 保持独立且不弹窗。工具来源与动作、命令、规范路径、网络目标和线程范围在真实工具
   装配中形成权限对象；未知副作用不默认当只读，MCP/第三方 annotations 不能自行授予权限。
3. 原生实现保留 `normal` / `accept-edits` / `bypass` / `smart`、用户规则、workspace 只收紧与可选 `permissionJudge`，并补齐实际
   shell/路径解析、会话授权范围、嵌套冻结、撤销和审计。实现不得把 session grant 只绑定 tool name，也不得用 Host 静态 capability
   代替用户确认。
4. 原生覆盖所有真实消费者后，删除 permission-system foundational provision、session service 让位、插件专属设置/快捷模式/状态桥与
   兼容路径。迁移过程不能先删门再补覆盖；最终生产只有一个确认 UI 和一份 Piarium policy authority。
5. `webfetch` / `websearch` 保持原生默认，不再因 `pi-web-access` 存在而自动让位。第三方替换通过用户显式关闭原生工具完成。搜索
   provider/credential 使用配置代际，使新会话无需重启取得新绑定，旧会话保持冻结；credential 撤销明确 unavailable。
6. fetch/search 使用 user 与 trusted workspace 取更严格结果的域名策略，工具参数只能收紧；`web.render` 接到真实 renderer 选择。
   删除未定标且未接线的 `maxFetchesPerTurn` 配置，不以硬次数预算冒充 SSRF、取消、provider 限流或输出背压。
7. 本阶段不增加多 provider 并发/隐藏回退、第二套抓取服务、第二个 permission store 或新的 OS 沙箱。当前交付状态在生产消费者与
   对应反例完成前不提升。

影响：`agent-harness-plan.md` 0.4/0.7/1b.7/3b/阶段 4–6；后续实现将涉及 protocol permission/web settings、pi-host tool assembly 与
permission gate、Application Host web runtime、foundational package provision、Harness/Plugin Settings UI、session/Thread 审计和相应
文档。D-044 的历史共存理由保留为当时事实，其目标架构由本条取代。

实施收口（2026-09-15）：D-283 已进入生产链。Piarium 内置 `tool_call` gate 现在覆盖实际工具注册表，来源取自 Pi
`getAllTools().sourceInfo`，Host `permission.inspect` 复用 actor/capability/path authority 规范化 cwd/资源；第三方 unknown 或证据不完整
动作不能借工具名自动放行，也不能进入 Smart/session grant。grant 绑定 source/action/owning+execution workspace/cwd/规范资源/网络/thread
scope，`/piarium-permissions` 可撤销，`permission.audit` 只投影无正文/凭据决策。foundational manifest revision 3 只保留 MCP，旧
permission-system service 让位、状态桥、Plugin Settings/Composer/quick mode/config model/专属 i18n 已删除。

Web 侧不再按 `pi-web-access` 自动让位；provider/render/domain policy 按 worker generation 冻结，新会话读新设置且无需 Host 重启，
credential 每次调用从 Pi auth 实时解析，撤销明确 `unavailable`。fetch/search 共用 user + trusted workspace 的域名 ceiling，工具过滤只能
继续收紧；Electron Application Host 与既有 `desktop_web_render` 共用一个离屏 renderer helper，`web.render=false` 时不启动 renderer，
无 renderer 时保持 `renderer-unavailable`。未使用的 `maxFetchesPerTurn` 已从协议/UI/文档删除。定向验证为 protocol 22、pi-host 35、
Application Host 57、i18n 6 项通过；protocol/pi-host/web/UI/Electron type-check 与相关 lint 通过。本轮未重跑完整 packaged Electron smoke，
也未用真实付费搜索 provider 做外网调用，因此这些范围不提升为额外平台/provider 证明。
