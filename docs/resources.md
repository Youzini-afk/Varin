# 资源、执行与恢复

项目组织导航，Thread 拥有工作，Source 指定执行读取的字节，资源 Host 拥有实际副作用。它们可以关联，但不能互相代替。
普通会话不需要绑定项目就能使用实际 Host 的文件和命令；一个任务也可以明确选择其他 Host 的来源。

进程归属见[架构](architecture.md)，Catalog 见[运行时](runtime.md)。具体实现入口：
[Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md)、
[WorkingState](../packages/web/application-host/lib/harness/working-state)、
[Native Workspace Host owner](../packages/web/application-host/lib/kernel/native-workspaces.ts)、
[Rust 挂载与租约](../kernel/crates/varin-kernel/src/workspace_resources.rs)、
[进程](../packages/web/application-host/lib/process/DOCUMENTATION.md)、
[Recovery](../packages/web/application-host/lib/recovery/DOCUMENTATION.md)。

## 固定附件与读取

附件是原 owner 固定版本的读取句柄，不是外部可用的下载 URL，也不等同于文件 hash、Source 或目录权限。
Host 的 `thread-attachments` 解析用户上传、现有材料及真实文件回执，Rust Storage 保管不可变对象与 domain record，
Catalog 只保存消息、派发、历史和报告中的 typed 关系。文件正文不经过 Catalog JSON，也不为交付预先调用摘要模型。

普通上传以二进制流保存原件，不设格式白名单。跨 owner 复制复用已有范围内容传输，验证 hash、长度及 descriptor 依赖；
接收端保留完成后才能发布交付。同 owner 转发复用对象并新增准确的收件关系，未知文件类型与空文件都保持原字节。
实时路径只捕获选中的文件；`file.capture` 的 `retentionRecordId` 把一致读取回执与对象保留同时提交，
丢失响应后先恢复该回执。原生文件写入在原效果事务里发布实际写入版本的附件引用，不再读取可能已变化的路径。

`file_read({ref})` 可在无项目、无 Source 的会话读取已获准附件；路径读取仍需要原来源授权。
文档及 Office 工具直接按引用读取原件。`resource_read` 的附件 `content` 视图分页读字节，`path` 视图按需准备一个只读文件，
不物化整个目录、不更改原件权限、不使用可写硬链接。需要修改时显式选择输出位置。

执行路径记录绑定当前 Kernel generation、准确对象和实际 Run 或外部会话。Rust worker 在控制循环外复制并核验文件，
Storage 独立保留该对象；关闭面板、取消观察或协调 Host 重启都不是实际进程退出的证据。
释放路径前核验原进程树已停止，发现文件被替换或修改时保留现场并报告错误，不递归删除未知内容。
路径缓存可回收而稳定附件身份继续存在；实际 Host 离线或未完成准备时返回具体错误，不以协调机路径代替。

附件随接收历史及明确转发关系保留。删除原会话或源文件不影响存活接收者；线程删除清理其材料关系和临时捕获，
共享对象由原 Storage 可达性回收。新发送不扫描正文建立权限，旧格式的历史材料关系仅在 Catalog 升级时转换一次。
未发布准备只有在原操作明确失败或取消、未产生交付且实际读取／传输已停止后才释放。远端 Host 重启后，
缺少原请求停止证据的准备继续保留，待原 Source 合法退休和线程清理确认；不能把空的内存请求表或网络断开当作停止。

## 来源选择

### 用户文件空间

Varin 的文件面板使用显式 `resourceOwner + workspaceId + root`；从任务打开时，Host 根据原 Thread/branch
读取实际 launch，再向那个资源 owner 解析文件视图。原生工作区使用 Documents 核准的实际挂载目录，
不把用于配置的原项目目录当作挂载路径。未提供可浏览路径的固定来源返回不可用，不回退到项目原文件。

`/api/resource-files` 承担位置、分页目录、二进制读取与文件管理。上传经流式原生 blob 写入；复制、重命名和删除
进入原文件事务与租约。跨设备移动先完成目标写入，按实际复制内容的摘要核对源文件，再条件删除；
失败返回已复制、已删除数量及具体原因。符号链接保持链接身份，不把链接目标悄悄变成复制内容。
目录的磁盘发现按需进行，打开一个文件视图不先扫描所有盘符。

文本编辑仍走完整 DocumentsAPI。远端通过已配置连接转发原文档请求和事件流，保留修订、dirty buffer、恢复日志
和真实资源身份；不会临时替换全局当前工作区。当前服务本地文件复用工作台 Registry，远端按资源 owner 隔离。
文件引用由附件 owner 固定到接收会话，匹配原来源时复用既有路径捕获，跨来源传输在 Host 完成，不经前端搬运原文件。
明确限制了目录或写权限的配对客户端继续遵守原授权。

### 执行来源

Agent Thread API 显式选择来源 owner、mode 和内容。本地与 managed-host 是不同的带判别字段 owner。
来源发现是只读操作，知道目录或 workspace 登记并不授予执行权限。

普通 Varin、主 Agent 和共享子任务使用设备文件访问。项目目录只决定相对路径和命令的默认工作目录，
绝对路径可以读写同一资源 Host 上当前系统账户可访问的其他位置，包括 Windows 的其他盘符。
没有项目和既有来源时，Host 以自己的默认目录提供 live 来源；桌面默认为用户主目录，不创建产品项目，
不扫描整目录、不捕获基线、不要求挂载驱动。再次发送沿用已选来源，包括远端或隔离来源；重试保持原受理身份。
显式配置的 Host deployment lockdown 仍约束该 Host，远端路径不会转交协调机解释。

设备文件仍经过同一 Rust 文件租约、版本比较、写入与恢复日志。默认目录内保留既有相对路径标识，
目录外使用绝对路径；文档读取、Office 输出、下载保存与命令共用同一来源授权。
`dispatch.sourcePath` 可以为普通 live 来源选择另一设备目录；只读和独立工作区继续保留各自的工具及文件视图语义。

- **FixedBranch**：读取不可变 branch/revision。原目录移动后，只要当前登记/信任和原对象仍有效，仍能读固定内容。
  命令首次受理时按需准备该版本的执行目录，随后文件工具和进程共用这个视图；旧证据保留原版本。
  workspace MCP 继续要求其显式执行来源；不能因为命令已物化目录就把 FixedBranch 自动当作 MCP cwd。
- **Materialized**：绑定原 environment/Run、受管物理副本和不可变 baseline。副本丢失或身份变化时，不静默重造同一执行。
- **NativeWorkspace**：保存逻辑 workspace、branch 和可选子目录。当前 Host 为它建立独立挂载、generation 和实际路径；重启重开原状态，旧路径失效。新隔离写入采用此来源，文件与程序共用原生文件服务。
- **LiveRoot**：使用当前准入的物理根，选择已保存文件，不是不可变草稿覆盖，也不承诺隔离任意外部 writer。
- **无来源**：所选能力不需文件/进程权限时有效；纯能力 child 或对话无需伪造项目。

固定准备显式区分 saved-files 与 surface-drafts。草稿来自所选 Documents 根和原登记 Surface，其他根的缓冲不能混入。
受管来源目前只接受 saved-files，不能把协调端本地草稿当作远端内容。相同准备 key 先查询原 branch receipt，再决定是否捕获。

指令、skill、ignore 与配置依赖随来源记录。树中没有条目，只有在实际观察覆盖范围内才能证明不存在。
主来源完整捕获与 Git child inventory 的范围不同；child 所需 ignored 依赖必须显式补入原捕获，不能以后读 live 文件填空。
详见[资源 reader](../packages/web/application-host/lib/agent-resources/DOCUMENTATION.md)。

当前多 parent ManagedSources child 保留选定来源及其 owner，不任意自动合并不同来源树。这是现有支持范围，不是未来永久禁令。

## 不可变工作状态与物理目录

Rust Storage 拥有内容寻址对象、不可变树、branch revision、pin、引用和条件发布。pin 保留某版内容，不授予范围外访问。
对象校验、落盘先于引用发布；缺失/损坏对象返回错误，不变成空文件。

原生 `branch.fork` 在一个事务里选择当前树或确切 pin，并共享其不可变根；原请求重放仍返回首次选定的版本。
固定来源派发与续接使用这一入口，不重新上传空分支来表达分叉。普通物理来源的首次捕获仍独立进行。
`branch.path.inspect/apply` 提供逐路径观察和条件更新，不同文件无需竞争同一个全树写入计数；删除或替换目录
必须校验其子树节点或整个写入版本。`branch.rename` 原子移动子树引用，不复制后代正文。隐式父目录也是目录，
删除后重建不恢复旧后代。读取正文以原分支／pin、路径与内容引用核验，GC 清理中间索引不影响仍存活的精确读取。
这些接口沿原工作区和路径权限执行。

内部私有文件构件使用不可变正文与追加范围：修改只写新增字节，冻结出的代际继续保留旧范围，
父侧可以继续写入和截断。局部修改发布为不可变区间描述，只持久化仍有效的修改字节并引用原正文切片；
分叉、flush 和成果发布均不先重建整个 dirty 文件。新文件及完整覆盖仍直接保存普通正文。
普通 `sha256-…` 标识正文，`ranges-sha256-…` 标识区间描述，后者的 `byteLength` 为逻辑文件长度，
不是描述大小或重建正文的 SHA。区间只引用普通正文，反复分叉不会形成祖先读取链；元数据成本随实际区间数增长。
原 Storage 事务在内容耐久后发布路径与依赖引用，消费正文 owner 并确认结果。
已发布且没有后续写入的 backing 可以回收；旧读者仍持有的 backing 保留到实际释放。临时清理失败参与现有清理状态。
发布后的 backing 整理在文件 worker 收尾，Storage 提交只处理引用与回执。
启动只回收已确认当前格式下、属于该构件 UUID 命名空间的未发布临时文件。

原生文件会话已连接上述构件：重命名保留打开身份，unlink 后重建不复用旧句柄；checkpoint 在短边界保留
当前命名空间、元数据树和 dirty 文件范围，父侧继续写入，worker 将当时的 dirty 字节与属性原子纳入子基线。
文件身份、权限、纳秒时间、扩展属性与 Windows 安全描述符保存在同一 Storage 的私有元数据分支中，分叉共享未变化节点；
创建、权限修改和正文发布在原事务内配对保存。目录重命名保留尚未打开的后代身份，删除分支同时释放元数据分支，既有 pin 继续保留原版本。
检查点明确固定当前写入树，包含尚未显式 publish 的创建、删除和重命名。正常关闭保留既有
checkpoint，撤权使原访问失效。会话边界会拒绝绕开它直接修改／固定活跃 branch 的请求；只读分支登记信息与既有不可变修订仍可读取，固定结果续接和代码整合不必重新固定当前工作树。
WinFsp 与 Linux/macOS FUSE 回调由默认 `workspace-mount` feature 编入；缺少系统组件时返回实际依赖，不自动安装。卸载失败保留挂载责任，
成功卸载后等待回调结束，再 flush／关闭会话。FUSE 已接权限、属主、时间与扩展属性回调，WinFsp 已接基本属性与安全描述符读写；
普通来源捕获也带上可恢复的权限、时间、扩展属性及 Windows 安全描述符；导入的文件在接收方获得本地身份。
Windows 安全描述符按固定组件排列生成公开元数据，保留 SID、ACE 顺序与控制位，避免同一权限因偏移布局不同而冲突；NORMAL 视为空属性集。普通 Windows 文件按只读／可写维度核对权限，原生工作区仍保留完整模式。向普通文件导出空属性时显式清除旧属性。
整合冲突查询在文件 worker 解析实际路径及别名，Storage 只准入来源、读取保留记录并核对查询期间记录是否变化；避免主线程访问挂载后等待自身回调。查询保留原挂载读者，完成前重新核对授权与来源。

显式隔离在实际资源 Host 的来源交接入口检查后端，先于物理目录解析、inventory、正文捕获及子 Run。
失败保留 `workspace_backend_unavailable`、`workspace_preflight` 阶段、Host、平台、架构、backend 和具体 reason；
实际挂载失败则保留原错误及 `workspace_mount` 阶段和受影响分支。Shared 不经过此门槛。
`workspace.backend.inspect` 只读取组件事实；Windows 核对本机架构 DLL、对应 SxS 驱动登记、启用状态和现有权限，
不启动驱动或建立探针工作区。项目设置可显式刷新，缺失结果不永久缓存；实际挂载仍独立确认。

固定读取、计算、原生句柄、目录导出、恢复和成果发布通过同一内容 reader 解释区间版本。
跨 Host 传输发送确切描述及其普通正文依赖，接收方核验哈希、区间、长度与原 owner 后发布；文件及树身份保持不变。
普通目录导出生成真实文件正文。GC 从树、pin、记录和活动 reader 追踪区间依赖，描述与原正文分别按实际物理字节回收。
恢复占用统计亦按去重后的描述和共享正文计数，不为每个区间版本重复累计整文件的逻辑长度。
macOS 选择 macFUSE 后端时，默认运行时加载已安装的 libfuse3 session 接口；它不是优先于已启用 FSKit 的后端。
缺少挂载组件不阻止普通应用启动；显式 SDK 构建仍保留 libfuse2/libfuse3 入口。真实挂载仍需平台验收。
原生会话已通过 `workspace.*` 私有协议接入真实 Kernel 与 Host 客户端：项目 owner 持有文件系统，Run／Operation
租约独立接纳和释放；挂载、区间版本持久化、卸载及进程／计算退出的等待都在 worker，原 Storage 继续服务回调。
Windows 使用 WinFsp 本地 UNC 文件系统，普通用户即可挂载，标准 Windows、Rust 和 Node 路径解析保留同一来源身份。
同一 Kernel 的工作区共享一个当前用户盘符，各 generation 路由到各自的原 Storage Session；不修改整机挂载开关，不为子任务分别占用盘符。
来源登记、路径权限与租约使用规范 UNC 路径；进程启动 worker 核验盘符仍解析到原目录后，仅在私有启动配置中切换到该别名，供 cmd、PowerShell 与 MSYS/Bash 使用。
盘符只在本地驱动中映射，没有 SMB 服务或网络传输。原 Session 的句柄与清理独立计数，关闭一个来源保留其他来源；最后一个来源退出后释放盘符与 dispatcher。FUSE 继续使用已存在的空目录。
正常退休运行授权时，先核实该授权的文件操作、计算和进程已结束，再释放它自己的工作区执行租约；项目文件系统 owner 仍需先关闭原 Session。租约与授权退休不再互相等待，也不替其他运行释放来源。
启动失败时标记原 Session 已断开，由来源 owner 关闭并释放，不留下仍等待挂载的来源。
关闭先封闭新的原生 open/create，保留 dispatcher 直到实际文件／目录句柄关闭。原关闭回执等待真实释放，重试由关闭事件触发；清理回执之前到来的关闭事件也会保留，不会漏掉重试。
`workspace.result.prepare` 固定同一数据和属性边界，交给原 WorkingResult 发布；父 head 后续写入继续保留。
发布时的属性引用随成果存活，释放候选不提前释放已发布成果；成果或分支删除会清理相应私有记录和 pin。
属性的成果版本和原始基线分别保留，供后续三方整合使用；普通 pin 与发布修订还独立持有属性根，释放一个成果不提前释放其他版本。空内容对象按固定 hash 共享，已有对象不再逐文件落一次空 staging。
根目录本身的属性在成果中使用 `.`，sourcePath 映射将它对应到选定的目录；只允许带原状态的目录属性更新，不能删除或替换来源根。首次普通目录捕获也保留根属性。历史成果释放沿原合同清理其修订和配对属性，其他显式 pin 继续独立保留准确版本。
创建时间区分挂载内的逻辑时间与必须恢复的已捕获／显式设置时间。Linux 新建文件的自动时间不强加普通文件系统无法完成的 birth-time 恢复；macOS 使用原生属性列表恢复创建／备份时间，Windows 使用 FILE_BASIC_INFO。新文件的 ARCHIVE 标志只在 Windows 默认设置，Unix 创建不附加无法在普通文件上往返的 Windows 标志。明确要求的目标不支持属性仍返回具体错误，不丢弃原成果。
快照 pin 表达独立固定根，当前／子树 pin 也不要求其源分支永远停在原 head。正文提示索引不是结果归属依据。
硬链接名字共享文件身份，目录移动更新稳定父目录身份，分叉后的修改独立。FUSE 提供原生 link，
WinFsp 尚无对应协议，Windows 挂载如实报告不支持。`workspace.fork(sourcePath)` 直接共享选定子树及元数据，
仅固定范围内的 dirty 文件区间；目录外的硬链接名字不计入子工作区。Linux 仅在连接实际提供并接受 FUSE_HAS_SYNCFS 时启用 writeback cache，等待本次 syncfs 完成后固定原 Session；协议包含 SYNCFS 指令本身不证明普通 FUSE 挂载会发送回调，回调头也不充当发起线程回执。没有该能力的连接保留既有的范围内可写句柄障碍，正常关闭后的文件仍可分叉和发布。macOS 先等待对应卷的数据与元数据同步，再固定原 Session。缓存和 mmap 保留。
`workspace.adopt` 在 worker 完成一次来源稳定化、真实属性捕获与私有 Git 布局整理；来源的硬链接、Unix xattrs 与 Windows 安全描述符随原版本保存。
接入的外部 Git 管理目录沿原文件根准入，原仓库不会被修改。原始操作保存准备进度，失败或重启只回收未发布候选。
主工作区及本地／远端／外部 Harness 的隔离准备在捕获前检查实际挂载后端；Windows 使用可选 WinFsp，Linux 核对实际 FUSE 设备和有权限的直接挂载／helper 路径，macOS 优先使用已启用的内置 FSKit 扩展，也可使用已安装的 macFUSE VFS。缺少能力时保留原始原因，不先扫描整个项目。检查不安装组件、不提权、不启用扩展；项目设置可由用户显式打开资源 Host 的扩展设置。
原生系统调用不留下逐次永久回执；干净 lookup 缓存随真实引用结束而释放，活动句柄与 dirty 内容仍被保留。
Windows 标准符号链接和 junction 保存原始重解析数据，并由 WinFsp 呈现、解析和执行创建／设置／删除；非空或多名字 inode 的类型转换保留原数据并明确拒绝，其他 tag 尚未实现。
普通项目会话使用原目录。系统挂载是显式选择的可选后端，项目设置展示其依赖、实际目录及准备进度。导入普通文件从已准入的打开句柄尝试 APFS clone／Linux reflink，在实际支持的卷共享原数据块，再读取固定内容登记 hash；跨卷或不支持 CoW 时沿同一句柄流式导入。硬链接共享内容；结束时核对身份、原生 change time、属性和目录变化，省去全量正文复读与第二次递归遍历。受管来源之后按根与增量区间分叉，不回扫原目录。
任意原生字节名称和活动可写映射切分仍有明确能力边界。实现与实机验收入口见 [kernel README](../kernel/README.md)。

保存的 Native 来源不持久化 mount path。[Host owner](../packages/web/application-host/lib/kernel/native-workspaces.ts)
以逻辑 workspace／branch 重开本次 epoch 的 generation，再获取实际目录；Documents 登记逻辑引用，
编辑器保存的标签、草稿 journal、watch 和操作分别持有自己的寿命。重开恢复的是已持久化分支，
不保证恢复旧 OS 句柄或尚未 seal／发布的进程内 dirty 字节；不能把逻辑来源可重开等同于任意崩溃下零数据损失。
挂载 dispatcher 退出会使原根失效，不再把底下的空目录当作文件结果。文件条件任务重启后沿保存的 Source 绑定原分支，取消继续释放原回执。
会话删除先停止原准备任务和执行者，由 Catalog 检查存活来源引用，再由 Storage 关闭实际挂载、清理派生分支、配对属性与原 pin。
清理失败保留原责任，资源释放事件触发继续；完成后辅助清理记录也删除。项目主状态与已保存编辑器、子任务、外部会话引用继续保留。

显式旧 FixedBranch 命令视图和 Materialized 来源继续按独立导出合同处理 staging、校验、backup、promotion；Native 来源不走这条复制路径。
原 worker 实际停止前，目标/staging/backup 的物理租约持续有效，包括取消和重启协调期间。无法证明的中断目录保留，
清理不能递归删除后来用户写入的内容。Linux/macOS 可尝试 clone 后退回校验复制；Windows 当前报告 copy、物理分配未知。

Git 是 inventory、filter、换行、mode 和 linked-worktree 元数据的语义适配，不是 WorkingState 存储或第二个正文 writer。
结果发布和 Integration 使用记录的 base/source/target，不复制一个未限定的“最新工作区”。结果与恢复各自持有对象引用。

Agent 阶段交接使用选定 Run 的实际来源，保留对应 worktree；物理来源先捕获固定阶段，已发布结果直接复用。
续接更新基础时，原成果与指定来源参与三方合并，实际来源和冲突写入本轮环境事实。
`submit_code`／`update` 只在实际交换时捕获选定文件或片段，使用同一 Integration 与恢复 journal，
不会在每次模型请求前扫描队友工作副本。固定成果可作读取来源；可写交换沿实际执行目录准入。
详见[Agent 协作](collaboration.md)。

## 文件准入与观察

Host Documents 负责根准入、文档修订和 Surface 协调。Rust Storage 负责规范化 exact/subtree 租约及物理捕获、apply、rename、remove。
别名、symlink、平台大小写参与同一资源身份；嵌套调用仍由 Rust 判断租约覆盖，TS 路径字符串相等不够。

会话准备通过 Documents 批量读取已知的指令与配置候选，共用一次覆盖这些 exact 路径的租约。
读取结果与缺失事实只在本次准备内复用；候选文件各自保留错误，外部别名继续由原资源 owner 准入。
目录身份与信任查询走 `getWorkspace`，需要编辑状态的界面才使用 `inspectWorkspace`。

租约约束已准入的冲突工作，不隔离任意第三方进程，也不把 live root 变成 OS 原子快照。文件效果在真正执行时复核身份和
expected state。read/read 可重叠，不冲突的工作可绕过等待项；等待者不提前持有部分资源。

文件通知是失效事实，不是内容 revision。支持的 Linux 本地根在连续覆盖下复用路径 inventory，只重扫 dirty subtree；
inotify/VFS fence 依赖原 mount/root 身份和未丢失事件。这只减少 namespace 枚举。
Windows 和不支持的根保留 unknown coverage，完整复核目录 inventory。重启、overflow 或订阅丢失使 inventory 复用失效；
独立 watcher 不持有 runtime/Storage owner。

正文另由 Rust [capture_resources.rs](../kernel/crates/varin-kernel/src/storage/capture_resources.rs)管理进程内捕获复用：
原 root/path 下的源原生身份与 change time 未变，且原对象仍已验证、对象身份未变时，可复用原正文状态。
缺少身份、对象被回收或身份变化时重新读取；复用不持有 blob，也不能替代当前 grant、租约和提交核验。
这不是仅凭 size/mtime 的缓存，也不同于 Native Workspace adoption 的 clone/reflink 导入。

冷对象验证、正文读取和捕获哈希由有限 native worker 执行。临时 exact-hash 引用保护 GC/退出前的字节，不是访问授权。
完成时再次核验权限；caller 取消不会提前释放仍在读的对象引用或物理租约。
文件捕获按实际文件长度预留缓冲，分配失败返回该文件的读取错误；文件大小仍由实际可用内存决定。
内核重启后，Host 更新文件、计算、进程与 Computer 的授权缓存；新请求绑定新 epoch，旧请求保留原失败与回执。
跨越重启的进程准备会终止，后续显式启动请求重新受理。

物理文件读取的路径解析、资源键校验、打开、流式哈希和读取后文件系统复核全部在 worker，只保留所请求的片段；
缺失、目录与符号链接也沿同一 worker 返回。Storage 完成阶段只复核原授权、登记与租约，不同步访问实际挂载。
文件租约的物理路径解析、捕获的来源准入，以及 `file.apply/mkdir/remove/rename` 的实际 I/O 同样离开控制线程；
租约排队与唤醒继续使用原队列，不在解析阶段占有部分路径。Agent 文本写入在 worker 完成读取和编辑计算，
原读取与条件写入借用同一个保留租约，正文分批交回 Storage 保存；日志与实际效果回执仍由原操作提交。
取消、撤权或显式释放不会提前交出正在执行的租约；写入已经发生时，先保存真实回执，再释放执行引用。
恢复协调不会对仍在执行的文件操作提前推断完成，未晋升的临时文件与未被意图接管的正文 owner 随原 worker 清理。
`process.spawn` 与 Agent 的进程启动同样分段：worker 解析和核验真实 cwd，Storage 写入原进程意图，
worker 启动 guardian，再将原句柄、控制和输出交回同一个 ProcessManager。准备中的进程保持真实 writer 状态；
停止或撤权能作用于尚未就绪的原 guardian，缺少句柄不再被解释为已经退出。读取输出和控制原进程仅核验登记，
不重新访问可能已经删除的 cwd。内核关闭先等待文件／启动 worker 完成交接，再关闭进程与计算服务，最后卸载工作区。
来源登记的真实目录核验、原文件日志的列举与协调也在 worker 执行。列举只观察；协调只依据原目标状态确认已经发生的效果，
不重放写入。观察期间沿原路径租约排除其他受控写入，提交回执仍由原 Storage 完成；正在执行的操作只报告待完成状态。
完整读取和部分读取都返回原文件的 `readVersion`。
该版本的原始状态由根、路径与内容决定；文本读取还将本次实际 codec 绑定到不透明令牌，后续编辑不能因项目设置变化重新解释同一字节。
读写权限仍由原 grant 独立校验。文本分页按实际解码器的字符边界和状态推进（包括 GB18030 四字节、Big5 多字符映射和 ISO-2022-JP），翻页使用返回的 `nextOffset`；
原始字节读取保留精确范围和明确的 base64 编码。`byteLength` 是整文件长度，`returnedBytes` 是本页实际返回字节数。
Agent `file_read` 的默认字节页为 64 KiB，与已有工具续读页面一致；`length` 可显式扩大。
`content.eof` 为 false 时继续传 `content.nextOffset`，到 true 停止；跨页核对 `readVersion`，避免拼接不同版本。
此默认只在工具参数入口应用，底层文件修改、结构分析等完整读取不受影响。
`file_read` 也接受从 1 开始、包含末行的 `startLine` / `endLine`，可直接承接搜索命中的行号；省略末行读取至文件末尾。
行范围与字节范围互斥，保留原换行与完整文件版本，返回实际字节位置和下一行。物理文件与固定来源使用相同的行选择语义。
文件工具入口按词法统一相对路径：Windows 反斜杠转换为资源分隔符，`.`、`./` 与省略查询路径都表示来源根，
`src/./file.ts` 与 `src/file.ts` 使用相同资源身份。绝对路径、上级跳转和 symlink 仍进入原准入检查。
`readVersion` 是条件写入的文件状态令牌，应原样传回；`objectHash` 是内容对象身份。缺失文件的版本记录“目标不存在”这一条件；
Native 来源的版本绑定实际文件状态和同一挂载，重挂后重新读取当前版本；固定来源令牌仍绑定原分支、修订和文件状态。旧 FixedBranch 的首次执行视图只在内容仍匹配时接纳原令牌。子目录来源的恢复 journal 使用映射后的实际父路径。
目录读取返回 `not_a_file`，目录内容通过 `file_list` 获取。
`file_write` 创建新文件时可省略 `readVersion`；替换已有文件与文本编辑使用读取所得版本。
`mode: create` 明确要求目标不存在，`mode: replace` 要求目标存在且提供版本；省略 mode 时按观察到的状态写入。
创建撞名返回 `file_exists`，替换缺失目标返回 `file_missing`；真实版本过期仍为 `file_version_conflict`，带原读取入口。
缺失版本仍校验“目标不存在”，其他写入者先创建文件后，旧缺失版本发生冲突。文本修改准备在一次读取中
取得正文和版本状态，提交时沿原 `file.apply` 校验当前文件，工具回执直接提供结构化 `state`；响应帧大小只约束发往调用方的正文。
正常模型回执省略内部 `reconciled` 字段；是否应用由实际写入状态表达，原恢复 journal 继续保存协调事实。
`file_list` 默认列当前目录的内容，不把被查询目录自身混入条目；`scannedFiles` 统计实际遇到的普通文件。
`recursive` 展开后代，`nextCursor` 配合相同过滤条件继续读取。各目录内部保持路径顺序，多目录交替产出条目，
避免一个大目录占满连续页面。物理目录和固定树的原遍历状态随查询保留，续页不重新遍历已读目录；
游标绑定来源及生效过滤条件，拒绝格式错误或换查询续读，页面大小可调整。物理目录读取仍是实时枚举，不是固定快照。
`includeRevisions` 显式请求正文版本，普通目录列表省略未计算的哈希。
多路径列举附带 `groups`：逐路径返回本页条目数、对应 `records` 的零基索引和状态。`no_entries_on_this_page`
提示继续原游标或单独查询该路径；只有完整的初始查询才能将零条目组标为 `empty`。重复或重叠路径不会重复产出同一文件，分组不复制正文。
显式指定但不存在的路径返回读取失败及路径。`maxBytes` 是分页目标，首条记录可以超过该目标，以便小预算仍能推进游标。
正向 `globs` 同时筛选文件和目录结果；未匹配的目录仍可作为递归路径进入，以找到匹配的后代文件。
普通目录列表显示包括依赖、Git、worktree 和被忽略文件在内的入口。递归发现默认略过 `.git`、`node_modules`、`.worktrees`
及 ignore 规则排除的内容；明确指定的路径作为搜索起点，直接进入该范围，内部的嵌套目录继续应用过滤。
Harness 在同一次遍历中处理路径与过滤，调用方仍可通过 `excludeDirectories`、`respectGitignore` 调整范围。
过滤后零命中返回 `emptyResult`：只说明当前 `scope` 与过滤条件下没有匹配，并列出同一工具可放宽的参数；`scanComplete` 只针对这个范围。工具不会自动关闭过滤或追加全树扫描，也不报告未遍历子树里的文件数。
文件文本由 Rust 的共同 codec 解码和严格序列化，Documents、Agent live/fixed 文件能力与 Compute 共用其结果。
纯 ASCII 采用项目的 ASCII 兼容默认编码，无此默认时使用 UTF-8；不会把普通 ASCII 字节两两拼成 UTF-16。
空文件可采用 UTF-16 默认，新建 UTF-16 文本带对应 BOM，明确关闭 BOM 的操作除外。明确选择、BOM 和识别到的头部编码声明先于一般 UTF-8 判断；非 UTF-8 文本优先采用可解码的项目默认，再由 chardetng 进行统计检测，并严格验证完整字节流。
原生目录统一提供 Unicode、GB18030/GBK、Big5、日文、韩文、Windows、ISO-8859、KOI8 和 Macintosh 等编码，Host、配置和编辑器不再分别写白名单。`gb2312` 按网页标准兼容 GBK；明确的 `gb2312-strict` 使用完整 GB2312-80 映射及字符范围。极短的歧义内容可以通过文件菜单重新解释，不把检测结果当成用户的保存意图。
UTF-16 LE/BE 有独立的实际 writer。不能编码的新增字符返回位置和原因，不用问号或字符实体替代。状态编码修改后采用连续的严格序列化，保留各处原换行；未修改文件仍返回原始字节。
原始 revision、object hash、before-image 与恢复数据始终按原字节保存；零文本与零格式变化复用原字节。
编码/BOM 变更与显式统一换行是不同意图，普通保存保留原换行，明确范围的局部编辑保留未改原片段。
Host 项目配置的 `textEncoding.defaultEncoding` 是候选先验，`files` 是文件或以 `/` 结束的目录规则；精确文件优先，其次最长目录前缀。
用户主动重开或转码的选择使用既有 Host 配置，不写入仓库；普通项目沿原项目命名空间，隔离分支的主动选择按其稳定来源身份保存，不以临时执行目录建立项目，也不修改原 live 目录的选择。
隔离分支的默认读取使用冻结基线加该分支的主动选择；关闭重开后选择仍有效，原固定基线的内容和解释不被倒改。
显式转换的格式与原始版本随原 Storage 写入提交；项目选择的 revision 防止迟到回执覆盖后来的手动解释。
固定来源的编码规则随原分支版本保存，所选结果继承该版本实际格式，不依赖旧 Run 私有结果正文或已离线原目录。
同一 Run 首次命令建立执行副本后，文件能力继续沿用该实际副本；副本的格式变化不回写原固定基线。
Compute 解码后再搜索和解析，搜索列仍使用 UTF-16 单位；结构范围同时保留解码 UTF-8 坐标和原文件字节坐标。
结构结果的 `contentHash` 是解码文本哈希，`rawContentHash` 是原始内容哈希，`sourceObjectHash` 保留所选 Storage 对象身份；范围对象的 descriptor hash 不冒充原始内容哈希。
Compute 的 Unicode 覆盖对象明确按 UTF-8 传递，不再次套用磁盘 GBK 规则；生成实际来源快照时，编辑器草稿按自己的目标文件格式序列化。
文本检测先识别 BOM，再检查二进制特征，不能用 NUL 前缀误拒 UTF-16。

## 进程与 Operation 寿命

Rust ProcessManager/guardian 拥有 pipe/PTY、stdin 序列回执、原始输出、resize、终止和真实进程树退出回执。
guardian 是同一发行 executable 的另一模式，不另开数据库 writer。Host Terminal、shell、task、test、LSP、DAP 适配原 handle。
guardian 的寿命由内核持有的私有控制管道维持；内核正常或突然退出都会关闭管道并触发进程树清理。
Linux 的临时启动线程结束不触发停止，避免把线程退出误当成内核进程退出。

输出观察、业务结果和 executor stop 是不同维度。业务副作用可未知而进程已确认停止；响应丢失也不能证明进程停止。
工具结果未确认时，默认策略将原结果交回模型，允许继续调用工具与回答。原 owner 通过已有回执通道更新原操作，
维护仍在执行的资源；对话的推进与原操作的完成分别处理。
关闭终端视图不杀 Job，取消 Wait 不杀被观察进程。stdin 与 resize 分别有序，使阻塞输入不拖住窗口调整。
`process_stop` 随进程启动能力常驻，使用 `processId` 请求原 guardian 停止进程及其子进程。同一 Thread/branch
在相同来源上的后续 Run 也可停止原进程。回执区分已请求停止与已确认退出；`wait_process` 等待原退出回执，
`process_read` 继续读取保留的输出。
底层输出块保留精确的 `bytesBase64` 和字节游标，终端及 LSP/DAP 等协议消费者继续读原始字节。
Agent 的 `process_read` 默认 `mode: text`，输出可读文本并去掉 ANSI 控制序列；`mode: raw` 返回原始字节。
交互式程序可用 `mode: screen` 读取当前 PTY 屏幕，包含文字、行列大小、光标位置和备用屏幕状态；回车覆盖、清屏、光标移动按终端语义应用，不再把重绘叠成日志。
屏幕在输出到达时增量维护，不重放整份日志；退出时保留最后一屏，输出回收时一起释放。screen 不按字节分页；text/raw 与原始输出仍可独立读取。
字节数和游标始终计入原始控制序列；可见文字较少时不代表输出丢失，不能用显示字符数计算续读位置。
输出读取不消费保留的历史；各读者可以独立续读或回读任意保留字节。帧位置索引只缓存磁盘偏移，不复制正文，输出释放时一并释放。
文本投影与 raw 共用唯一原始字节游标；不会为了凑齐字符回退 `actualCursor`。stdout/stderr 各自连续解码，
一个字符在其最后原始字节所属页发布，`sourceRanges` 可跨页及跨通道间隙。`nextCursor` 只按原字节推进，不能从文字长度推算。
已知编码跨块保留 decoder 状态；按通道记录实际 EOF，最后一个不完整字符只在该通道结束时结算。进程退出不等于两条通道都已排空。
自动解码先看每条通道开头的 BOM、UTF-8，再参考实际进程 Host 的 Windows 代码页；逐行混合判断保留低延迟，
不声称可以唯一识别所有双合法字节或一行内部的编码切换。`encodingSource` 标明实际依据。
`process_spawn.inputEncoding` 与 `outputEncoding` 是该进程持续的独立默认；`process_write.encoding` 与
`process_read.encoding` 仅覆盖本次操作。pipe 的 stdin 文本严格编码，raw bytes 不转码。ConPTY 的 UTF-8 wire 不继承项目文件编码。
POSIX 已明确采用旧编码的 PTY 在 Agent、screen 和打开该会话的 UI 中复用原生文本投影；subscription 的 `textChunks`
保留 ANSI，原始 chunks/cursor 不变。Host 不再另猜一遍 GBK，普通 UTF-8 终端继续使用已有 StringDecoder。
文本投影无法无损解释的片段返回原因、`rawAvailable` 与原位置，原字节仍可通过 `mode: raw` 读取；
不能为了修复一个异常单元吞掉后面的合法字符。顺序读取保留 decoder，随机读取利用可恢复检查点；状态性编码在必要时从起点重放。
`outputSummary` 给出本页原始字节数、实际保留的起止游标及总字节数、页面之后的字节数和续读游标；越界错误也说明可读范围，运行中的末尾仍可能增长。
`process_spawn` 顶层状态与其附带观察使用同一最新快照；`stdinMode` 如实区分 PTY，`input` 说明可写性、EOF 和行结束符。
显式 `waitMs` 在同一等待预算内覆盖进程退出和输出收尾，通过原生通知唤醒并响应取消，不增加固定收尾延迟。
等待预算耗尽时返回实际进展；默认 0 仍立即返回。最终页的完成标志同时用于顶层回执，避免较早进程快照覆盖新读到的 EOF。
`process_write.text` 按 JSON 解码一次；未指定 submit 时原样写入。`submit:true` 将多行文字的换行统一为原进程的 `input.lineEnding`，并在末尾缺少行结束符时补一次 Enter；空文本提交也是 Enter。
普通 Agent 命令与用户交互终端保留原环境，不为显示输出注入 `PYTHONUTF8` 或 `PYTHONIOENCODING`。Host 自己拥有的专用文本协议子进程可声明 UTF-8 stdio；SmartSearch 仅设置缺省 `PYTHONIOENCODING=utf-8`，不改变 Python 普通文件 `open()` 的全局默认，也不覆盖已有同名环境变量。
空 text 可以只提交回车，实际追加字节进入原输入序列及幂等回执。`confirmedBytes` / `state:applied` 确认通道写入；
应用的响应继续读原进程输出。退出与输出收尾分别观察：`outputComplete:false` 保留游标，输出错误显示原错误，
`outputComplete:true` 也仍可能有当前页尚未读到的后续内容。读取到 `nextCursor == endCursor` 只说明已读到当前保留的末尾。
进程观察附带 `outputState`（`running`、`finishing`、`complete`、`output_error` 或 `unknown`），由同一次观察的退出、输出完成与输出错误事实推出；`process_spawn` 顶层状态与其嵌套观察来自同一次读取。
Windows 启动时将规范化路径转换为子进程可用的目录表示，内部资源身份仍保留规范化路径。
进程已退出时，输入和 resize 明确返回 `process_exited`；正在停止时返回 `process_stopping`。

Windows 使用 named Jobs；Linux 使用 managed session 加 subreaper。旧 epoch 无法证明的退出保留 unknown，继续保护目录。
Windows PTY 在创建控制台后、执行用户命令前保留原 Job 基础进程的对象句柄。主进程退出后，先终止并重新核验
后来加入同一 Job 的用户子进程，再关闭 ConPTY 并读取到真实 EOF；原控制台进程保留到最后输出排空之后才清理。
保护对象按原句柄比较，不按进程名或初始数量推断。启动期间无法确认这些对象时，不发布已完成进程树清理的回执。
Host 对可能仍存在 executor 的启动/停止失败保留 owner，不用旧 PID、HTTP abort 或 Promise reject 虚构退出码。
进程启动与文本修改遇到短时文件租约时，进入既有物理资源 FIFO；只有冲突范围等待，Storage 控制线程继续服务。
等待沿用原操作的授权与取消，获准后重新校验来源和物理路径；进程登记启动意图后就释放临时目录租约，不锁住整个进程生命周期。
目录解析或进程受理失败时，Storage 用原进程意图记录确认是否尚未启动；确认未启动的失败返回 `not_dispatched`，
供模型修正参数后继续。`cwd` 使用选中 Source 下的相对目录，空字符串和 `.` 表示根目录；入口统一处理 `./` 和路径分隔符。

### Shell 与基础环境

实际执行 Host 的 `platform/execution-environment.ts` 复用终端 Shell 发现与环境解析。模型请求准备时冻结默认 Shell、
可选程序和基础 PATH；模型只收到平台、Shell ID 与可执行路径。当前请求的启动使用同一快照，设置变化在下一请求生效。
受管来源查询目标 Host，命令、PATH 与目标程序身份不会从协调端拼接到远端。

`process_spawn.shellCommand` 使用公布的默认解释器；可选 `shell` 按实际候选选择。Windows Agent auto 优先有效显式环境选择，
然后 Git Bash、pwsh、Windows PowerShell、CMD；WSL 的 bash 启动入口不属于本机 Shell 候选。
终端面板保留自己的默认偏好和 auto 顺序。`command + args` 继续直接启动程序，不能与 shellCommand/shell 混用。
未显式覆盖 `env` 时，直接启动 `bash` 等已发现的 Shell 名称使用同一冻结候选的可执行文件和附加 PATH；其他程序也继承默认 Shell 的工具目录。
pipe 与 PTY 在原 guardian 中统一按进程自身的 cwd、PATH 和 Windows PATHEXT 查找程序，不借用 guardian 的隐含搜索环境。
绝对或相对程序路径保留显式选择；完整 `env` 覆盖仍按调用方提供的环境查找。
非交互命令按 Shell 家族传递正文且不加载个人 Profile；启动回执记录实际解释器。程序失效时返回 `shell_unavailable`，
不更换语言重新执行正文。Windows PowerShell 5.1 的 curl 别名需要使用 `curl.exe` 才能接收 curl 参数。

Host 将用户及系统 PATH 与产品工具目录统一供给 Agent、终端和 Node 脚本；用户已有工具保持优先。
`env` 显式提供时仍表示完整环境，空数组保持空环境。原生 ripgrep 来自锁定的目标平台 `@vscode/ripgrep-*` 包，
桌面打包到 asar 外的 `resources/tools`，通过普通 PATH 可直接启动，不依赖 Node shim 或其他产品安装目录。

grant retirement 与 revocation 分开：前者在真实 drain 后关闭旧 caller，后者继续拒绝。Operation-owned grant 可以长于 Run，
直到自己的 reader、process 和回执归档完成。原来源仅支持精确限定的 successor 读取，不继承全部旧控制权限。

## 受影响文件恢复

`file_restore` 对实际应用的每个文件返回 `change: created | updated | deleted`；undo 和回执恢复使用同一前后状态计算。

Recovery 保存工具实际改过的文件。首次写入时创建绑定原始输入的轻量记录，在效果前保存原内容，之后记录实际结果；
同一输入下重复写入保留第一次 before 和最后 after。Run 结束事件自动完成已有记录，启动恢复及面板读取补齐遗漏的结算，
只读轮次不创建空恢复点。这些过程读取现有元数据，不递归扫描项目。

文件时间线按完整 Run 聚合，可以选择文件恢复到轮初、轮末或用户命名的位置，并撤销一次文件恢复。
`recovery_points` 与 `file_restore` 是物理工作区中常驻的工具，随原有读写权限提供。
`file_restore` 支持 `current:before`、具体恢复点和原恢复操作的 undo；返回逐文件结果，对话继续运行。
`current:before` 表示整个对话轮开始前，包含删除本轮新建文件；只想撤销某次编辑时应先通过
`recovery_points` 查看对应恢复点和路径，不能把轮初恢复当作“撤销上次编辑”。
普通 shell、Git 和外部应用的未记录改动显示为覆盖不完整，已记录的文件仍然可以独立恢复。
命名恢复点保存当时已记录路径的内容，不要求模型管理快照或预先执行一套确认流程。

恢复只折叠所选历史条目影响的路径，计算 expected-current 与目标状态；验证这些路径，保存 safety/redo 对象，再条件应用。
后来用户编辑按文件返回冲突，可明确选择覆盖该文件。面板的文件恢复通过原 Documents barrier 保留未保存草稿，
这类文件作为待处理项返回，其余文件继续恢复。带对话导航的联合恢复仍使用原 Registry owner、instance、revision
保存和恢复已确认的脏缓冲内容。

对话恢复使用真实 Thread/HistoryBranch 导航。导航响应丢失查原 command receipt，不重复导航，不仅比较当前 head，
也不立即补偿文件。只有明确拒绝才补偿仍等于本操作 output 的路径。Undo/重启继续原 operation/file phase。

Managed 多 Host 恢复由对话 Host 先持久化 metadata-only coordinator 和固定 participant 身份，再联系文件 owner。
目标 Host 在当前权限及原 Source/root 核验下进入自己的原 journal，拥有文件对象和补偿；协调端只持引用与回执。
文件阶段全部确认后才提交原导航。未知响应保持 pending；取消先耐久记录意图，再等待慢观察/原 owner drain。
这是多个事务的可恢复协调，不是跨 Host 原子事务。

Integration 共用条件文件/对象机制。Agent 触发的整合在原 file.apply 事务中记录 parent input 的 before/after，
包括补偿写入。旧整合缺少这一记录时仍标为覆盖不完整。
混合 Surface/disk 修改若无法证明已分发效果，则保留耐久 needs-attention；网络失败不能变成安全空结果。
Undo 在保留执行意图前检查原 Surface owner、回执和新鲜 dirty-state；准入失败仍可用原操作重试。
多 Surface 的原 undo 回执逐组保存，后续 owner 丢失回复不抹掉已确认补偿，也不借用 apply 的停止证据。

内置 provider 将 Recovery 与 WorkingState 同置于 Host kernel 数据根。工作区统计计算其恢复引用实际占用的去重对象；
Host 总览另外显示共享 catalog/WAL。移除恢复点后，仅释放其他恢复点不再需要的记录；撤销操作仍持有自己的安全副本。
GC 核对全部引用 owner 后清理无引用对象。当前没有默认自动保留上限，也不提供内置存储迁移。
替代 provider 可通过现有服务契约声明自己的存储能力。用户操作见[恢复指南](ops/recovery.md)。

## Managed Host、排程与科研

Managed Source 调用固定 coordinator、目标 Host/connection、精确 Source 和原 invocation，并在目标复查 paired-client 权限。
文件、固定捕获、进程、MCP、语言/检索、script/package、research 分别经过所属 owner；能力目录不是任意 dispatch 授权。

项目 `scheduled_task` 在 Source 的资产 Host 执行。该 Host 的 Storage 先存 first-dispatch fence，再存原 callback receipt。
协调端在丢回执/重启后核对同一 Operation；started 但无 receipt 保留 unknown，不重放修改。项目排程涉及全项目资产与用户
override，须 whole-project Source access；只有文件权限不能安排执行。Agent Calendar occurrence 与项目 Markdown schedule 分开。
详见[排程模块](../packages/web/application-host/lib/scheduled-tasks/DOCUMENTATION.md)。

科研 input、执行机器和 output 是不同归属。Managed input 先在目标 Storage 固定字节，再将校验对象传入原 Experiment branch，
不会因此选择实验机器。Job、artifact、metric、log high-water 由原 owner 负责，最大的已存 chunk 不等于已发布输出。
持久条件跟进这些事实，不启动替代工作来猜结果。

Service forward 有自己的 listener/bridge、原操作和清理。选择 Computer 不会重定向它；协调机 loopback 地址只能证明本机可用，
不能直接供另一台操作电脑访问。

## Computer Use 与平台边界

ComputerService 拥有发现、driver、物理输入 lane、assignment、人工控制和远端路由；执行绑定保留真实 Thread/Run。
一个物理桌面同时只有一个 controller，可有多个 observer；不同窗口不是独立桌面。
Windows 观察默认列出目标应用的可见实际窗口，过滤后台、cloaked 和辅助小窗口；显式选定的窗口始终保留在观察结果中。
Windows Host 直接启动配套 `VarinComputer.exe`，构建阶段生成 x64/ARM64 产物，不在运行时加载 PowerShell、C# 或编译器。
UIA 只由 helper 的 MTA 线程持有；同用户本机控制管道与 stdin EOF 监视独立于 UIA，先阻止旧输入再释放跟踪状态。
取消一个请求可保留健康实例；撤权/退出仍等待原实例实际停止。独立 capture 角色不拥有输入或 UIA 状态。
二进制按 Host candidate 发布并核验架构、摘要和真实签名状态；未知动作/旧输入释放状态不因替换 helper 自动清除。

assignment 在资源 Host 预留成功后才发布 grant。输入使用原 assignment/epoch，handback 后需新观察；远端重启不会悄悄续旧 token。
Browser/Office 读取与效果有不同工具合同，任意 JS evaluate 仍属效果，不因 caller 称其只读而变权限。

Stop 指向原执行/assignment，关闭旧准入并排空真实输入 writer。应用调用返回不证明应用后台工作全结束；unknown effect 与
unconfirmed stop 保持分离。证据只留元数据，排除键入文本、脚本、凭据和文件正文，不宣称完整视觉重演。

Linux 已有受管桌面、Chromium/CDP、LibreOffice/UNO，以及 Linux x64 本地 libvirt guest 配方，但不因此证明真实 KVM、
多机 GUI、安装升级或应用身份验收。Windows/macOS 不继承 Linux bridge。macOS 已接入常驻 Swift bundle，使用
AX、ScreenCaptureKit 与 CGEvent；Wayland 已接入常驻 RemoteDesktop/ScreenCast portal、PipeWire 捕获和协商的 D-Bus 输入。
两者共享原 ComputerService 控制与观察 owner，作业取消不等于撤销画面授权。macOS SDK 编译、真实签名与权限流程，
以及真实 Wayland compositor、PipeWire、输入/缩放和授权撤销仍需实机验收；源码接线和替身测试不证明这些结果。
详见 [ComputerService](../packages/web/application-host/lib/computer/DOCUMENTATION.md) 与[driver](../packages/computer-driver/README.md)。
