# 主与子 Agent 的版本化工作区：按需隔离、平台接入与增量分叉

设计与实现更新：2026-10-28。本轮基于 `5b92a3d01` 的工作区实现及已合并的测试职责重构。独立工作区为按需能力：`dispatch.workMode` 继续默认 `shared`，显式 `isolated_write` 在实际执行 Host 具备相应文件系统能力时执行；缺少依赖或权限时，在重准备之前返回明确失败。普通项目使用不以安装文件系统组件为前提，工具调用不自行安装组件，也不自动将隔离请求改成共享执行。

当前实现使用同一 Rust Storage 保存不可变树、私有写入、文件身份和属性，保留 WinFsp／macFUSE／FUSE 适配器。局部 dirty 文件已发布为平面的不可变区间版本，分叉与 flush 不再强制重建整个文件；普通物理来源首次仍需稳定捕获。首次导入的直接内容写入、硬链接复用和去除重复核验继续保留。

| 范围 | 当前代码 | 验证／剩余边界 |
| --- | --- | --- |
| 文件引擎 | 持久树、私有区间写入、固定区间描述与原正文引用 | 父子独立、重启、精确传输及 GC 有原生回归；实际 mmap／缓存边界沿后端资格处理 |
| 子任务准备 | 固定／native 来源按引用分叉；普通目录首次捕获 | Git 原始目录仍走稳定捕获；Git 对象懒来源和原生 OS 快照属于后续来源适配 |
| 后端检查 | 实际资源 Host 在来源交接前检查，原始 code／details 进入报告 | Shared 不探测；实际挂载另行确认并保留失败阶段 |
| 平台交付 | Windows 可选官方 MSI；deb/rpm 声明 FUSE3；macOS 随包 FSKit 执行扩展及已安装 macFUSE 接入 | 扩展有独立构建、签名及启用检查；三端真实安装／挂载尚未验收 |
| 内容消费者 | 固定读取、原生句柄、搜索／计算、导出、恢复、成果与跨 Host 传输解析同一版本 | 普通导出生成真实正文；跨 Host 保留原文件及树身份 |

Source 保存逻辑 workspace、branch 和可选子目录；mount generation、实际路径及当前 grant 属于本次连接。重启按保存的 Source 重开，旧路径不复用。文件工具、Documents、编辑器、终端、script、workspace MCP、扩展、Office 和外部 Harness 使用同一来源，已有会话保留原选择。显式 FixedBranch 的旧命令物化合同仍保留为独立能力，Native workspace 失败不会回退到它。

当前项目启用先检查实际 Host 后端，再在 worker 完成一次稳定捕获，保留实际属性及 Git 管理状态；进度来自原操作的阶段、条目和字节。原项目不搬移、不覆盖、不双向同步。Windows 安装器集成官方 WinFsp 2026 Beta5（`2.2.26286`，版本与 SHA 固定），明确显示预览版本且默认不勾选；静默更新不安装新系统组件。运行时不安装驱动。项目设置提供实际 Host 状态、帮助和手动刷新。macOS 随包提供自有 FSKit 扩展，按 macOS 26+ 和确切扩展路径的启用事实选择，也可加载已安装 macFUSE 的 libfuse3；不分发 macFUSE。整个应用最低 macOS 13 不变。

文件根登记、租约解析、读取、修改、日志恢复、命名恢复点和进程准入均分离 worker I/O 与原 Storage 提交。挂载断连明确失效，不能将空挂载点当作空项目。关闭、取消和删除保留原资源责任；文件观察使用原 Source 重绑定，持有实际挂载引用。

成果同时固定数据与属性树。普通 pin 和独立发布修订各自持有配对属性，来源分支释放后仍能读选定版本。三方整合合并实际属性，跨 Host 传输选定属性而不搬运原 inode 图；接收方分配本地身份。普通目录导出对平台无法恢复的属性给具体错误，原成果继续保留。

根目录属性以 `.` 进入捕获、成果、来源映射与条件恢复；根仍不可删除或替换。属性摘要包括权限位，单独 chmod 也能进入成果。目录删除／重建会获得新身份；重新选择基线时沿确切 pin／revision 选取属性，不从相同正文 hash 猜测。历史成果释放同时清理其原修订和配对属性，显式保留的其他 pin 继续独立存活。Linux 自动逻辑创建时间不成为普通目录导出的强制条件；macOS 原生属性接口负责创建／备份时间恢复。

会话删除先等待原 Run 和来源准备任务退出，再由 Catalog 检查存活来源引用并短暂封闭新引用，Storage 确认实际挂载、读写和进程寿命后回收派生分支。保存的编辑器标签、草稿、文件观察、子任务及外部会话分别保留引用。失败继续原清理，完成后释放清理记录、相关 pin 和属性树；项目主工作状态不随对话删除。

待回收的来源由实际句柄、进程、编辑写入、草稿与恢复日志的释放事件继续唤醒。编辑器快速关闭再打开的持久引用按用户操作顺序提交，避免冷加载期间反向覆盖。挂载、保存标签和会话各自释放自己的责任，不依靠定期全目录扫描或猜测过期时间。

当前平台边界：WinFsp 协议不提供硬链接创建，Windows 如实报告该能力缺失；共用引擎及 FUSE 支持硬链接。后端尚不能切分活动可写映射时返回具体快照障碍，保留缓存与 mmap。共享路径合同要求可表达的 Unicode 名称；不支持的原生字节名称、特殊重解析 tag、重解析点背后的隐藏正文和 positioned resource-fork I/O 均明确拒绝，不作有损转换。

当前实现说明见[资源](../resources.md)、[运行时](../runtime.md)、[协作](../collaboration.md)与[外部 Agent](../external-agents.md)。本方案接续[上一轮隔离设计](retrieval-isolation-and-tool-reliability.md)，故障证据来自 0.9.33 发布版及后续子任务停在 inventory 的反馈。下文描述目标合同；尚未交付的部分以上表和第 16 节为准。

## 1. 目标与决定

让主 Agent、子 Agent、文件工具、终端、IDE 和外部 Harness 使用同一套版本化文件工作状态。需要隔离时，从当前工作状态分叉；未变化内容共享，每个工作区只保留自己的变化和必要元数据。命令仍为普通进程，通过操作系统可识别的目录访问文件。

固定的是派发时的版本，不是主工作区。派发后主 Agent 继续读写，子 Agent 从相同起点独立推进：

```text
                         R10：派发时固定版本
                         /               \
主工作区：          R11 → R12           S1 → S2：子工作区
                         \               /
                           按三方状态整合
```

| 议题 | 设计决定 |
| --- | --- |
| 主／子工作区 | 使用同一引擎；主工作区也可版本化，不只给子任务套一层虚拟目录 |
| 默认派发 | 继续 `shared`；显式 `isolated_write` 创建独立可写工作状态，不修改 Agent 角色默认 |
| 能力缺失 | 在重准备前拒绝显式独立工作区请求，错误告诉 Agent 原因和可选处理；不全局禁用对话或共享派发 |
| 依赖交付 | 优先复用成熟系统接入，由产品处理安装交付；Agent 工具不自动安装、提权或改系统安全配置 |
| 命令与外部 Harness | 使用普通程序和真实挂载路径，不要求替换成 VFS 专用工具 |
| 内容权威 | Rust Storage 保留树、正文、版本、租约、恢复、整合与回收职责 |
| 对话权威 | 原生执行与外部产品记录仍归 Catalog，外部 Harness 保留自己的执行循环 |
| Git | 支持原生 Git 工作方式；Git 不是所有项目、文件版本或合并的必要前提 |
| 平台 | Windows、macOS、Linux 均为核心目标；首轮确定三端文件访问、版本切分和部署路线，不将任何一端留到架构完成后补适配 |
| 创建成本 | 已管理工作区分叉不全树枚举、不全量哈希、不复制整库；首次接入成本单独表达 |
| 写入成本 | 修改一个文件不触发全工作区物化；数据复制粒度独立设计和度量 |
| 文件可见性 | 主工作区的修改在同一项目视图立即可见，不要求每次导出后才能编辑或运行 |
| 路径切换 | 不自动搬移、覆盖或替换用户原项目路径；启用受管视图时明确实际执行目录 |
| 回收 | 按引用、挂载、打开句柄、进程和成果寿命回收，不能以会话结束代替资源停止 |

本轮采用自有版本引擎与平台文件接入相结合的路线，Windows 优先 WinFsp，Linux 优先 FUSE，macOS 按已满足合同的实际后端开放。系统组件可以随产品安装；派发期间不触发安装。VM、进程拦截和自研内核驱动保留为有明确需求时的替代路线，不成为本轮必做项。版本化工作区负责文件隔离；工作区外的资源访问继续由原权限与进程机制负责。

## 2. 现状、故障与证据

### 2.1 0.9.33 体检

两次 `dispatch(workMode="isolated_write")` 停留在 `preparing_child`，用户观察到应用整体卡住并通过重启恢复。同任务 `shared` 可完成。该证据把问题集中到隔离准备，尚未给出具体等待栈、锁或资源耗尽原因。

实际来源 `D:\project\opencr` 本身不是 Git 仓库，包含多个项目和工作目录。当前隔离不是 `git worktree add`：物理来源经 inventory、内容捕获、核验和工作状态发布，之后按需物化。普通目录枚举不应用 Git ignore，跳过 `.git`、`.varin`，但没有专门略过 `node_modules`、`.worktrees`。在多项目父目录下，任务只需写一行也可能先捕获大量无关字节。

当前 main 的外部 Harness 接入复用这条捕获／物化链，相关抽取未解决其成本结构。非 Git 根目录并非非法来源；在父目录运行 `git worktree list` 失败也不能说明下面每个项目的 Git 登记无效。

故障基线有三类成本：缺少平台依赖导致执行目录无法建立；物理来源进入大范围捕获；分叉前完整封存已修改文件。本轮将依赖失败前移并移除了受管来源的完整 dirty 文件封存；普通目录首次捕获仍有真实成本。后续反馈中的十几万项 inventory 属于来源准备成本，不能只用新的依赖错误文案宣称已修复。

### 2.2 已有基础及缺口

| 现有能力 | 继续复用 | 本次需要改变 |
| --- | --- | --- |
| Storage 内容对象、不可变树、branch root | 节点共享、根引用和版本身份 | 接入懒加载的稳定来源，补齐活跃可写状态 |
| 基线 pin、同代捕获合并、正文复用 | 引用保护和有效身份判断 | 不再让每次派发从物理整目录捕获开始 |
| 固定来源读取、搜索、结构提取 | 精确版本读取 | 首次写入直接更新私有状态，不展开整棵目录 |
| 物化 journal、平台克隆／复制 | 旧路径、明确导出、必要后端的生命周期经验 | 挂载成为普通进程访问同一状态的入口 |
| Documents／Registry | 文档修订、未保存草稿、编辑协调 | 物理路径与虚拟资源身份统一，避免两套文件视图 |
| Recovery／Integration | before/after、三方合并、条件应用、undo | 消费同一工作区版本与实际文件变化 |
| guardian／进程资源 | 进程树、真实停止和输出回执 | 进程绑定准确 workspace 与 mount generation |

现有 [state_tree.rs](../../kernel/crates/varin-kernel/src/storage/state_tree.rs) 已按内容标识保存树节点，`root_apply` 按批共享祖先与未变化节点；[branches.rs](../../kernel/crates/varin-kernel/src/storage/branches.rs) 保存根与修订，[branch_namespace.rs](../../kernel/crates/varin-kernel/src/storage/branch_namespace.rs) 提供逐路径事务与子树移动。它们不等于完整的操作系统文件系统实现。

主要成本入口是 [source-preparation.ts](../../packages/web/application-host/lib/harness/working-state/source-preparation.ts)、[child-source-store.ts](../../packages/web/application-host/lib/kernel/child-source-store.ts)、[source.rs](../../kernel/crates/varin-kernel/src/compute/source.rs) 与 [materialization.rs](../../kernel/crates/varin-kernel/src/storage/materialization.rs)。Windows 的 [file_resources.rs](../../kernel/crates/varin-kernel/src/storage/file_resources.rs) 当前未实现 clone，走校验复制。

本轮另外核对了三处直接证据：[native-workspaces.ts](../../packages/web/application-host/lib/kernel/native-workspaces.ts) 的 `requireNativeWorkspaceBackend` 只将 readiness 转成错误；[preparation-failure.ts](../../packages/web/application-host/lib/kernel/preparation-failure.ts) 可能把该错误归入通用 `preparation_failed` 并只保留文字；[workspace_session.rs](../../kernel/crates/varin-kernel/src/storage/workspace_session.rs) 的 `Checkpoint::install_files` 调用 [workspace_files.rs](../../kernel/crates/varin-kernel/src/storage/workspace_files.rs) 的 `FileSnapshot::seal`，完整读取并生成修改文件的对象。依赖前置检查、面向 Agent 的明确拒绝和低成本分叉是不同的完成项。

## 3. 四种身份与统一访问

区分项目、工作区、版本和挂载，不能再用一个物理目录字符串代替全部身份。

- **Project**：用户导航与配置归属，不因创建子任务变成另一个项目。
- **Workspace**：持续可写的文件状态。主工作区、隔离子工作区结构相同；Shared 多个执行者绑定同一 Workspace。
- **Revision**：该工作区一个已经固定的文件版本，可被子工作区、成果或恢复点保留。
- **Mount**：某 Host 上把 Workspace 暴露为普通路径的连接。断开挂载不删除 Workspace，重挂不是重建任务。

```mermaid
flowchart TD
  UI[文件树 / Documents / 编辑器] --> S[Rust Storage 工作区服务]
  FT[原生文件工具 / 搜索] --> S
  P[终端 / Git / 外部 Harness / 外部编辑器] --> M[操作系统目录挂载]
  M --> S
  S --> W[工作区当前版本与私有写入]
  W --> B[共享不可变树 / 稳定来源 / 内容对象]
  S --> R[原 Recovery / Integration / GC]
```

工具直达 Storage 与程序通过挂载访问，必须有同一个线性化边界、文件身份、缓存失效和修改事实。原生工具不能修改一棵树而挂载层继续返回自己缓存的旧内容；挂载也不能把文件写进一套未被 Storage 接纳的平行数据库。

Source 继续包含资源 owner、权限范围和路径映射。新增工作区绑定放入现有有判别字段的 Source 合同，不将 workspace ID 塞进假物理路径或伪造 Run。私有 wire 实施时由 schema 生成，字段名称在落地时确定。

## 4. 主工作区接入与原项目路径

### 4.1 推荐接入方式

普通项目会话继续使用所选来源，后端已安装也不自动导入全项目或改换执行路径。`isolated_write` 本身表达本次独立工作区需求：Host 检查能力、解析来源并准备子工作区，不要求 Agent 另传 `versionedWorkspace` 或用户先手写项目配置。该字段是已建立的受管项目绑定，不能作为判断系统具不具备独立工作区能力的开关。

对已管理主工作区，Shared 使用同一可写状态，隔离任务固定版本后分叉。对仍在原目录运行的主会话，本次隔离从明确的稳定来源生成子工作区；其首次接入成本按第 5 节处理。持续低成本分叉需要受管主工作区或可保留的稳定快照。父目录已变化时，旧快照仍可保留，但不能冒充当前版本。原目录向受管主工作区的交接是一次明确来源选择，不在派发中暗改正在运行的主任务。

主工作区是此后正常编辑的当前状态，不是只能在任务末尾导出的预览。保存、运行、Git 操作直接发生于它。原始目录作为接入来源／可选发布目标保留，不做隐藏的双向同步；启用时清楚说明用户应在哪个路径继续工作。源位置变化影响 Git 对象依赖或外部链接时，必须先解除相关引用再允许清理。

保持原路径透明接管可以作为后续接入方式，但需处理占用句柄、原目录交接、挂载恢复及卸载后的可访问性。首版不通过自动 rename 原目录、创建联接或安装拦截驱动来冒充透明接入。

既有会话继续绑定原来源，不在运行中静默改 cwd。切换在明确的来源交接边界发生；已有终端、外部 Harness 和打开句柄必须停止或保留原绑定，不能把同一路径换成另一份数据后继续冒用原身份。

### 4.2 外部编辑器与原始目录变化

外部编辑器打开挂载路径时，与主 Agent 共享同一 Workspace。仍在原始目录上的编辑属于另一份来源变化，使用明确的导入／整合操作处理版本冲突，不通过 watcher 事后覆盖主工作区。

外部程序使用绝对路径、symlink/junction 或配置中的原始 cwd，可能越过挂载范围。打开编辑器、传递文件链接、启动 workspace MCP 和执行命令时使用实际执行路径；范围外路径仍沿原权限处理，不重写任意命令文本。平台路径别名进入同一资源身份校验。

### 4.3 saved-files 与草稿

默认分叉当前已保存的工作区状态；未保存草稿仍归 Registry。显式选择 surface-drafts 时，按当前来源合同生成固定草稿覆盖，保留 Surface 身份与原编码／换行。分叉不能悄悄保存用户草稿，来自别的项目或窗口的缓冲不能混入。

## 5. 稳定来源与首次准备成本

### 5.1 稳定性的来源

| 来源 | 取得固定起点的方式 | 仍需支付的成本 |
| --- | --- | --- |
| 已管理 Workspace | 选择已确认 revision，保留根与数据引用 | 切分待提交写入、少量分支元数据 |
| 已有固定 WorkingState | 直接保留原 root | 缺失对象读取及必要校验 |
| Git commit | 固定 tree/blob 身份并保留可达引用，按需获取工作文件 | Git 元数据、filters/LFS 转换、缺失对象获取 |
| Git 当前脏工作区 | 固定上述版本，捕获准确的已保存修改、新增及所需附加文件 | 实际不同内容、暂存状态和外部写入协调 |
| 支持固定快照的文件系统 | 使用实际不可变快照作为来源 | 建立快照、平台准入、后续按需读取 |
| 普通可变目录，无快照 | 明确接入窗口内稳定化为受管来源 | 首次枚举与必要正文捕获；不能承诺即时完成 |

Git 对象引用要能抵抗其原仓库 GC；仅记录 OID 不足以持有内容。可以在自有对象存储中保留所需对象，或使用实际可维护的仓库引用／对象 owner 合同。引用涉及用户原 Git 时，不自动删除其分支、历史或共享对象。

上表中的 Git 对象懒来源和 OS 固定快照是后续可选适配路线，本轮未接入。当前 Git 与普通物理目录都通过已有稳定捕获进入受管树，受管后使用同一区间版本与分叉机制。

未读文件能懒加载，前提是它的来源身份可重读到同一内容。`绝对路径 + mtime + size`、Git HEAD 未变化和普通 watcher 事件都不构成不可变正文。不能让未来的读取从已经变化的原目录补齐旧版本。

### 5.2 普通目录接入

普通目录没有快照，也存在不受 Varin 控制的外部写入时，无法同时满足“立刻创建、完全不读取、取得全目录同一时刻旧内容”。设计应公开实际接入方式，不把混合时点捕获命名为原子快照。

推荐在接入时选择已静止的来源或平台快照，完成一次稳定化；发生无法解释的并发改写则保留前一有效状态，指出受影响范围，不无限自动重试。之后主 Agent 与外部编辑器进入受管主工作区，后续分叉不再回头捕获原目录。

来源范围沿用户选择和 `sourcePath`，不默认把整个多项目父目录当作源码仓库，也不自动缩成某个猜测的子目录。可说明实际选定范围与准备阶段，用户无需为了普通派发手动填一堆性能参数。

首次接入与每次派发分开计量。首次导入将每份普通文件内容直接流式写入不可变对象，同时计算一次内容哈希，随后发布名字与原属性；硬链接复用同一文件对象，不经过空文件创建、编辑日志和二次封存。末尾核对原文件身份、原生 change time、属性和目录变化，不再次读取全部正文或重新递归列目录。外部 Git 控制文件保持单独核对。停止接入时保留原项目、实际已确认记录及可回收临时引用。

### 5.3 来源组合

基线可包含 Git 树、未提交覆盖、稳定依赖和明确附加范围，组合结果固定优先顺序与映射。现有单来源 subtree 映射继续适用；不借此开放任意多 Host 多 parent 自动合并。

内部共享内容路径不能通过目录枚举泄露成项目文件。Varin 自己的 Storage、挂载管理目录和 journal 不放进被其反复捕获的来源；判断依据为受管身份，不仅靠常见目录名称。

### 5.4 来源准备的成本边界

来源选择按已有事实确定：已管理工作区保留当前版本；已固定树或可保留的系统快照按需读取；Git 来源复用固定对象并捕获真实脏状态；普通可变目录才执行必要的首次稳定化。每次派发不重新做后端资格测试、全仓 Git status、全树哈希或完整导入。

同一确切来源版本的准备可以共享，调用者分别持有引用；某一调用取消只释放自己的等待和引用。缓存键需要包含真实版本、所选范围及影响内容的来源配置，不能只用目录名。普通 LiveRoot 没有稳定版本时，不凭 mtime、watcher 未报事件或上一轮成功推断可复用。

写前保留是避免首次全量正文捕获的后续方向：在旧内容被覆盖前保存仍被版本引用的区间，目录删除／重命名也保留旧结构。该方案要求覆盖来源的真实修改入口，包括普通进程和映射写入。当前挂载只接纳挂载路径的写入，不能保护仍由外部程序修改的原目录；因此写前保留不作为现有后端已经具备的能力。watcher 用于通知和发现变化，不承担找回已覆盖字节的职责。

首次接入不采用忽略全部依赖目录来缩减语义。用户选定一个父目录时，范围仍由原 Source 与可选 `sourcePath` 决定；来源能力和真实准备进度说明实际成本。项目导航、取消和其他会话不等待来源枚举结束。

## 6. 分叉、并发写入与版本边界

### 6.1 正常分叉

1. 解析实际来源与执行 Host；显式独立工作区先通过第 9.6 节能力准入，再由 Catalog 固定原 dispatch、选定 Workspace、workMode、权限与 sourcePath。
2. Storage 接纳原幂等请求，为当前工作状态建立可识别的版本边界，持久化被引用的新增范围及元数据。
3. 分叉引用该边界的不可变根与文件区间版本，创建独立 head；父工作区进入后续写入代继续运行。此步骤不以所有 dirty 文件生成完整 blob 为前提。
4. 需要目录的执行获取属于该 Workspace 的挂载；无需真实路径的文件工具可以直接开始。
5. mount readiness 与来源引用均确认后启动子进程／外部 Harness，回执保留真实身份。

固定 root 的发布只处理短元数据，不在锁内扫描树、哈希文件或等待用户输入。分叉不等待整个父 Run 完成，不冻结主模型执行。

### 6.2 活跃写入不能靠根指针掩盖

实际程序可能持有打开的文件、缓存写入和可写内存映射。仅 clone 一个树根，而让其中内容仍指向父进程会原地修改的普通文件，不是固定版本。

写入引擎需要区分稳定内容版本与可写 generation。建立边界时，协调此前已接纳的写入和 OS 缓存，在有限发布段选择一致的根；后续写入进入新的 CoW generation，父侧已有句柄继续指向父 Workspace 的同一文件身份，子侧绑定独立版本。边界前后的顺序由实际文件服务建立，不能依据工具消息时间猜测。

基线有可变 staging backing 时，先将其转为不会被后续原地写入改变的版本：可用原生 extent clone，或由受管页／extent 写入层保留旧数据。处理范围限定为实际尚未固定的变化。现有实现完整封存 dirty 文件的成本按现状报告，第 7.2 节的持久区间版本负责移除此步骤；增加缓存或搬到 worker 不算完成这项改造。

文件 flush、缓存失效和 mmap 写回的协调是后端准入要求。尚不能固定某类活动映射时，返回可定位的快照障碍并让主工作区继续工作，不以无限等待句柄关闭来实现“准备中”。不默认停止全部主进程；需要应用级一致点的任务可在正常阶段边界取版本。

### 6.3 文件一致性与应用一致性

一次工作区版本保证文件服务定义的边界。数据库事务、跨文件生成器、运行中的服务状态未必恰好落在应用完整状态。需要它们时使用应用自身 checkpoint／一致操作边界，不能把目录版本称为进程、内存和数据库状态的完整复制。

Shared 执行者明确共享同一个可写状态，仍可能发生正常并发编辑；`readVersion` 和条件写入保护实际文件，不能把 Shared 包装成隔离。多个主会话可以绑定同一主 Workspace，不按会话重复导入项目。

## 7. 文件内容与命名空间

### 7.1 数据模型示意

```text
Workspace
  id / resourceOwner / projectBinding
  baseRevision / headRevision / namespaceGeneration
  sourceMapping / backendBinding / lifecycle

Revision
  rootRef / stableSourceRefs / fileContentRefs
  namespaceBoundary / durabilityReceipt

Mount
  id / workspaceId / hostId / generation
  actualPath / backend / capabilities / state

FileVersion
  fileIdentity / metadata / contentRef / revision
  contentRef = immutableBlob | stableSourceRange | immutableExtentMap
```

以上映射进既有 Storage 记录和引用图，不新建 TS 持久工作区库。稳定来源引用需有实际读取与保留合同；`stableSourceRange` 不是任意 live 路径。生产 schema 保持已知格式严格校验，不自动迁移或覆盖旧内部存储。

### 7.2 读写与复制粒度

目录和文件元数据按路径需求加载并共享；同一来源版本的相同读取合并，失败不缓存成不存在。二进制、Unicode、空文件和稀疏区间沿真实字节／文件语义处理。

内容模型共享旧范围、保存新范围及长度变化。现有整文件对象继续作为基础内容，新增不可变区间映射保留局部变化；checkpoint、fork 和阶段发布直接引用该映射。完整文件生成只用于需要它的导出、现有格式边界或针对实际读放大的存储整理，移出独立工作区的必经准备链。具体 extent／chunk 大小依据后端与负载确定，本文不猜统一常量。

同一个活跃文件可在短写入事务中更新 working generation；稳定 revision 在 checkpoint／fork／发布边界形成。工具的原子替换通过完整候选与条件发布完成；普通程序分多次写入时保留原程序可观察的中间状态，不伪造文件级原子性。

固定区间版本时，先确认被引用日志范围及长度已经持久化，再发布树与文件版本引用。父侧后续追加或重写使用新的区间映射；旧范围在仍有版本、句柄或恢复点引用时保留。整理后的完整对象或新映射以等价内容替换存储引用，旧读者仍可读原版本。恢复、整合、搜索、导出及 GC 消费同一内容读取接口，不能只有 fork 认识区间版本而其余消费者强制展开或误删日志。

### 7.3 必须实现的行为

| 行为 | 语义 |
| --- | --- |
| 目录枚举 | 合并基线与当前命名空间，支持分页、明确缺失和目录修订 |
| 删除／重建目录 | 删除标记遮住基线；重建目录不让旧后代重新出现 |
| rename／替换保存 | 命名空间事务与打开句柄语义正确，不靠事后扫描推断 |
| hardlink | 同一 Workspace 内共享文件身份；分叉后写入不改另一 Workspace |
| symlink／junction | 保留实际链接语义，解析结果参与范围准入，不能借别名绕开来源 |
| open／unlink／truncate | 遵守对应 OS 的句柄、共享模式与删除语义，不统一成 POSIX 假实现 |
| append／并发写 | 沿文件身份排序与锁语义处理，不以任意最后响应覆盖所有内容 |
| metadata | 保留平台需要的 mode、ACL、大小写规则、时间、可执行位及受支持扩展属性 |
| watch | 发布实际变化与失效，断连／溢出有明确状态，不拿事件计数代替内容版本 |
| mmap／文件锁 | 后端需证明普通程序的缓存、写回、锁与快照边界兼容 |

不要把每个 fork 实现成越来越深的“父 delta 查不到再查祖父”链。优先利用持久化树的结构共享和可定位内容引用；压平针对实际读放大按现有资源调度执行，不预设固定链深上限。

## 8. 命令、外部 Harness 与所有消费者

### 8.1 命令仍为普通进程

Shell、Python、Node、编译器、测试和 Git 继续由原 ProcessManager／guardian 启动。可执行程序一般复用 Host 安装，不为每个 Workspace 复制。`cwd` 指向当前挂载，环境中的 workspace 路径由实际执行来源提供。

一次进程启动固定 workspace、mount generation、实际 cwd 与权限。mount 不可用时不切换解释器、原目录或另一份副本重新执行。进程输出、退出和输出收尾保持既有独立语义。

工作区内的读取来自合成视图，写入进入私有状态；工作区外路径、全局缓存、网络和设备仍是原真实资源。需要加入工作区的额外目录使用明确来源映射，不重写任意 shell 命令或承诺整个操作系统隔离。

### 8.2 统一消费者清单

| 消费者 | 接入要求 |
| --- | --- |
| file_read/write/edit/list/search、Tree-sitter | 同一 Source 与 readVersion，更新后失效挂载缓存 |
| Documents／文件树／编辑器 | 使用 Workspace 资源身份，保留 Registry 脏缓冲与保存冲突 |
| pipe／PTY／script | 获取同一挂载及进程寿命引用；脚本里的原生 fs 不能另走原目录 |
| Codex／Claude Code／Pi／ACP | 使用实际 cwd 和原会话，暂停／恢复仍绑定原 Workspace |
| workspace MCP／扩展工具 | 依赖本地目录时获取同一挂载；已有运行实例不能仅改参数复用到另一工作区 |
| Office／文档／下载／科研执行 | 临时路径和结果写入沿来源 owner，不只改编程工具 |
| IDE／LSP／DAP（实际启用时） | 文件监控、工作根、打开编辑器与调试路径一致；不重新向 Agent 披露已移除的 LSP 能力 |
| 文件链接／打开方式／另存为 | 打开当前实际内容；导出才生成独立文件，不能把内部对象文件当用户文件暴露 |

浏览器页或移动端连接远程 Host 时，挂载发生在资源 Host，不要求客户端也安装文件系统组件。跨 Host 继续传原 Source 引用与命令回执，不把本机 mount path 发给另一机器当执行路径。

### 8.3 调用归属

挂载可以准确观察文件效果，但进程身份不总能精确对应某个工具调用。guardian 派生进程可关联其运行；用户外部编辑器或共享后台服务记录真实来源，无法归属时明确 unknown/external。不得为了填满 UI，把所有挂载写入算到当前最后一次工具调用。

## 9. 跨平台文件访问与 CoW 后端

### 9.1 共同语义与两层能力

Windows、macOS、Linux 同时参与合同制定、原型和验收。现有 Windows 故障是回归场景，不能据此让共用接口只描述 WinFsp，再让其他平台模仿 Windows。

分开设计两类能力：**文件访问后端**负责把 Workspace 呈现给普通程序并接纳实际操作；**数据／快照后端**负责稳定版本、内容共享和写时复制。APFS clone、Linux reflink 等可以减少文件数据复制，但不单独提供所有命令共享的虚拟命名空间。二者可以组合，不强制所有平台使用同一种挂载库或相同数据布局。

共用合同包含普通路径访问、文件身份、缓存一致性、版本切分、持久化、可取消挂载、实际卸载与恢复事实。平台返回具体能力与依赖；不能因调用了 clone 或 mount 就声明整个 Workspace 已稳定可写。

| 平台 | 文件访问路线 | 数据与固定版本路线 | 首轮必须查明 |
| --- | --- | --- | --- |
| Windows | 继续 WinFsp 适配，正式安装包集成官方组件；ProjFS 保留候选 | Storage 增量内容；支持的卷可利用原生克隆 | 普通 NTFS、缓存／mmap、共享句柄与删除、安装／退出 |
| macOS | 现有 macFUSE 按后端资格开放；优先建设自有 FSKit 扩展，旧系统 NFS 为后续候选 | APFS clone 用于稳定文件版本和可写 backing，Storage 保留逻辑根与引用 | 具体 OS／后端版本、通知与缓存、部署许可、扩展启用；未具备时拒绝独立工作区 |
| Linux | 继续 FUSE 适配，发行包处理用户态组件和挂载 helper | Storage 增量内容；实际支持的 reflink／快照可加速 backing | 普通桌面与无桌面 Host、缓存写回、设备与挂载权限、实际文件系统能力 |

明确物理导出／旧复制路径继续是可辨识的独立能力，不作为某个平台的隐性“兼容实现”。不支持 CoW 的卷要记录真实情况；用户选择后端之后也不能悄悄改变已受理操作的隔离或耐久语义。

### 9.2 macOS：APFS 与系统文件接口共同设计

**APFS 数据层。** 利用同卷克隆保留共享数据块，父／子后续写入分别分配变化内容，适合稳定文件版本与私有 backing。克隆目标的命名空间、版本发布和引用仍由 Storage 管理。目录克隆的实际元数据成本、dirty 文件切分和并发写入需要核对，不能把单文件快速 clone 当作任意活动目录的瞬时一致快照。首次导入、跨卷、非 APFS 外置盘和网络来源分别处理，不以“运行在 Mac”判断 clone 一定成功。[Apple APFS 说明](https://developer.apple.com/documentation/foundation/about-apple-file-system)。

**原生 FSKit 访问层。** 将其作为系统支持范围内的重要候选，评估与 Rust 文件服务连接的 app extension，覆盖目录、打开／关闭、读写、同步和需要的元数据操作。Apple 的 passthrough 示例可以帮助确定扩展装配，但其直接访问源目录的行为不能直接用于私有分支。[FSKit](https://developer.apple.com/documentation/fskit/)、[官方示例](https://developer.apple.com/documentation/fskit/building-a-passthrough-file-system)。

**系统版本分别判定。** 当前 [Electron 配置](../../packages/electron/package.json) 声明 macOS 最低 13.0。Apple 的 FSKit 基础接口从 15.4 提供，所选路径型资源 `FSPathURLResource` 与 passthrough 示例要求 26.0；macFUSE 当前首页也以 macOS 26 描述用户态后端。独立工作区根据实际使用的 API 与后端版本开放，不提高整个应用最低版本；未具备后端的系统按第 9.6 节拒绝隔离，正常会话继续使用原来源。[路径资源](https://developer.apple.com/documentation/fskit/fspathurlresource)、[macFUSE 官方说明](https://macfuse.github.io/)。

**macFUSE 候选。** 分别评估 FSKit 和 kernel 两种后端，不只记录一个“已安装 macFUSE”。当前官方说明列出了 FSKit 后端通知 API、部分 mount 选项和性能差异；这些直接影响工具直写后的缓存更新、watch 与交互延迟。kernel 路线涉及系统扩展启用及 Apple Silicon 上的安全配置操作，不作为用户必须接受的默认前提。[后端说明](https://github.com/macfuse/macfuse/wiki/FUSE-Backends)、[安装说明](https://github.com/macfuse/macfuse/wiki/Getting-Started)。

**分发。** macFUSE 当前许可对随商业软件捆绑二进制及自动下载／安装要求事先书面许可；不能套用 WinFsp 的开源例外直接打包。当前已安装后端可按实际能力使用，集成安装需按实际发行方式落实授权。自有 FSKit 扩展随 Varin 签名、公证和更新，用户按系统要求启用扩展；不在工具执行期间改安全策略。[macFUSE 许可](https://github.com/macfuse/macfuse/blob/master/LICENSE.txt)。

**部署与日常使用。** 沿现有签名、公证与应用更新链路打包扩展／helper。核对文件系统 entitlement、扩展启用、用户目录访问、Host 与扩展的连接和卸载恢复；扩展仍是原 Storage 的执行者，不自己打开第二份可写数据库。Apple Silicon 和仍在发行范围内的 Intel 架构分别准备产物；现有 Intel 条件发行策略不在本设计中改变。

Mac 代表性行为包括 Finder／编辑器的替换保存、Git、Node／Python 与实际项目构建、文件监控、可执行位、ACL／扩展属性、大小写与 Unicode 名称、可写映射、睡眠唤醒和外置卷断开。应用关闭、扩展退出或系统重启后，已确认保存的版本继续可恢复；内存中的句柄和进程状态仍按原生命周期处理。

推荐目标是 Rust 工作区引擎＋可用的系统访问后端，APFS 在适用卷上提供数据共享加速。旧系统的本机 NFS 服务可作为后续候选，复用系统客户端，但需要适配锁、缓存、通知和挂载寿命；当前没有实现，不能在 capability 中宣称可用。后端未达到合同即拒绝独立工作区，不要求用户为正常使用 Varin 降低系统安全设置，也不以建设所有替代后端阻塞已成熟平台的交付。

### 9.3 Linux：FUSE、缓存与原生文件系统能力

FUSE 路线直接呈现受管树，目录、文件身份和变化继续由原 Storage 提供。内核页缓存、用户态共享对象缓存和持久文件版本分开管理；`write` 返回、dirty page 写回、fsync 和 snapshot 发布有明确顺序。

Linux FUSE 的 cached/write-through、writeback-cache 与 direct-io 行为不同，涉及 shared mmap、后台写回和数据可见性。不能仅为简化版本切分就全局关闭缓存或 mmap，也不能启用 writeback 后忽略尚在内核中的写入。依据实际内核能力选择并核对 snapshot fence；直接文件工具修改需完成相同缓存协议。[内核 FUSE I/O 文档](https://docs.kernel.org/filesystems/fuse/fuse-io.html)。

reflink／稳定文件系统快照用于数据层加速，依据源／目标卷和实际支持探测。OverlayFS 仅用于已固定 lower；父 Workspace 不能作为仍会变化的 lower 直接挂进去，upper 也必须有准确的封存与后续写入分离机制。[OverlayFS 文档](https://docs.kernel.org/filesystems/overlayfs.html)。

部署覆盖普通桌面与无桌面 Host，核对 FUSE 设备／挂载 helper、用户权限和实际容器环境。不能为了运行文件后端默认给容器 privileged 或提升整台 Host 权限。已有 Shared、远程文件访问与不需要本地 mount 的能力继续按原合同工作。

DEB／RPM 等安装包声明相应 FUSE 用户态与挂载工具依赖，由包管理器处理；便携包可内置普通用户态代码，但仍要检查 `/dev/fuse` 与可用的挂载机制。把 helper 放入 AppImage 不会自动获得系统挂载权限。缺少设备、helper 或执行权限时返回具体原因，由用户在该 Host 的安装／管理流程中处理；客户端不修改远程机器的容器权限或系统配置。[libfuse 部署说明](https://github.com/libfuse/libfuse/blob/master/README.md)。

原型覆盖 inode／hardlink、rename-overwrite、open-unlink、可执行位、锁／mmap、watch、后台进程及 daemon 重启。测试正常发行环境中的 ext4 等普通文件系统，以及实际使用的 CoW 文件系统，不能只在具有快照能力的特制卷上验收。Linux 的行为不替代 macOS 或 Windows 验收。

### 9.4 Windows：完整写入路径与普通 NTFS

WinFsp 为 Windows 的主要接入路线，继续核对 Rust 集成、OS 缓存／映射／锁、文件共享模式和删除时机。它提供文件系统接入点，Varin 保留自己的版本与耐久协议。[设计资料](https://winfsp.dev/doc/WinFsp-Design/)。

正式安装包推荐内置未经修改的官方 MSI，固定已选择版本与校验信息，保留其签名，可离线安装。现有安装器先识别已安装版本：满足所需合同的直接复用，需要时在组件安装步骤安装或升级。驱动安装使用该步骤的系统授权，Varin 日常运行不因此整体提权。安装中明确显示组件名称、进度和实际结果，跳过或失败后独立工作区保持不可用，普通应用仍可安装和使用。[官方安装包](https://winfsp.dev/rel/)。

升级由官方 MSI 维护系统组件。WinFsp 2.x 支持相应免重启升级，旧 1.x 升级等情况按真实安装结果处理；不默认强制重启。已有其他软件使用的兼容组件不被降级；卸载 Varin 释放自己的挂载和文件数据，不自动卸载可能被其他软件共用的 WinFsp。[版本说明](https://github.com/winfsp/winfsp/releases)。

WinFsp 的 FLOSS 例外允许符合条件的开源软件链接其 DLL、分发未经修改的官方安装包，并要求界面和用户文档中的署名与仓库链接，同时约束与非 FLOSS 软件的混合链接／分发。Varin 按当前 AGPL 发行形态及实际组合核对，在关于／第三方许可和发行材料中落实；发行形态变化时重新按许可选择，不能仅凭应用自称开源判断整包合规。[许可原文](https://github.com/winfsp/winfsp/blob/master/License.txt)。

ProjFS 保留候选：它会缓存读取内容，写入后成为 full file，通知有前置／后置之分。重点检查后续实际写入能否进入所需版本切分，以及多 Agent 扫描后的缓存重复占用；不把只读投影或首次懒加载当作完整 writable workspace。[缓存状态](https://learn.microsoft.com/en-us/windows/win32/projfs/cache-state)、[操作通知](https://learn.microsoft.com/en-us/windows/win32/projfs/file-system-operation-notifications)。

普通 NTFS 是代表性环境，具备克隆能力的其他卷可提供数据层优化。保留 PowerShell／Git Bash／CMD、路径别名、长路径、大小写规则、原生进程 Job 与文件占用回执。安装系统组件、升级和卸载沿现有安装器与用户授权，不能通过移除句柄保护来换取“清理成功”。

### 9.5 共用引擎与各平台缓存边界

普通程序通过 mount 写入时，工具直达 Storage 的读取要看到相同已可见状态；工具直接修改时，程序的目录项／属性／页缓存也必须更新。对缺少所需失效接口的后端，采用经同一 mount 入口提交写入等能保持一致的路径，或者明确能力未满足；不能绕过缓存更新后靠 watcher 最终追平。是否可用直达快路由属于后端能力，耐久权威仍然只有 Storage。

跨平台共用测试验证版本、隔离、冲突、持久化和回收；平台测试验证其原生名称、权限、句柄及缓存语义。不强行把所有系统变成大小写不敏感，不全局改写 Unicode 文件名，也不丢弃对目标工具有意义的 mode／扩展属性。跨 Host 导入出现名称碰撞或不支持的元数据时，明确涉及路径并保留原成果。

挂载回调和文件 I/O 在原生资源执行通道处理，不经 renderer、每文件 HTTP 或模型工具 JSON。若采用辅助进程／app extension，它是 Storage 的文件服务执行者，不另建 Catalog／Storage writer；大正文与阻塞 I/O 在短提交段之外，避免每个 syscall 争抢全局会话控制锁。

### 9.6 按需能力准入与失败合同

#### 9.6.1 哪些请求需要检查

| 请求 | 行为 |
| --- | --- |
| 普通对话、LiveRoot 文件操作、原目录 `shared` 派发 | 沿原来源运行，不因独立工作区后端缺失而拒绝 |
| 显式 `isolated_write` | 在实际资源／执行 Host 检查所需后端；不可用时拒绝本次请求 |
| `read_only` 或固定版本文件读取 | 按真实访问需求准入；不因名称是子 Agent 就要求可写挂载 |
| 已绑定 native 工作区上的共享任务、命令或恢复执行 | 需要恢复同一个执行视图；失效时明确报原来源不可用，不改回原目录 |
| 独立工作区续派、刷新来源、外部 Harness 派发 | 遵守相同来源和后端要求，不留下仅普通 dispatch 有检查的旁路 |

工作方式仍按调用选择，不保存到预制 Agent 角色默认。参数保留在工具 schema 中；本机缺少依赖不会全局移除 `dispatch` 或隔离枚举值。某个已运行原生工作区不可用，也不能据此放行原本依赖它的 Shared 请求。

#### 9.6.2 能力事实与检查成本

复用原 `workspace.backend.inspect` 与资源 Host 的服务通道，扩展实际后端、运行平台／版本、编译支持、依赖版本／可加载状态、可知权限和类型化不可用原因。判定独立工作区需要它实际依赖的操作，不要求后端实现本次任务不使用的所有可选文件特性。

现有 `dependenciesReady` 只表示已检查的依赖满足条件。DLL 能加载、设备可打开或 helper 存在后，真实挂载仍可能失败；准入检查与本次挂载结果分别保存。已知缺失尽早返回，挂载阶段错误保留原 code、message、stage 和受影响来源。

轻量检查可复用当前 Host／后端连接代的事实；明确安装／更新、重连、手动刷新和真实失败后重新探测。缺失状态不永久缓存，修复后下一次显式重试即可生效。不为每次派发创建探针工作区、跑测试命令、枚举用户目录或增加定时全盘检查。

检查发生在资源所在 Host。Windows 客户端连接 Mac Host 时读取 Mac 能力；浏览器或移动端不需要安装远端挂载组件。Host 失联返回连接问题，不能把无法查询归类为“依赖未安装”。

#### 9.6.3 派发顺序与已有异步准备

```text
解析参数、权限、来源及实际执行 Host
  → 检查本次独立工作区所需能力
      → 已知不可用：返回原工具失败，结束本次派发
      → 可用：受理派发并固定来源
          → 保留现有稳定版本，或执行必要的首次稳定化
          → 固定增量、创建私有分支、取得挂载
          → 启动子任务
```

确定的缺依赖错误在目录 inventory、内容捕获及执行环境准备之前返回。优先在创建子执行记录前检查，让原 `dispatch` 直接得到原因；为检查取得的短期 grant 沿原 owner 释放。Catalog 的授权与来源选择继续是准入依据，Host 的能力结果不能替代它。

当前异步链可能已受理并保存 preparing 记录后才进入来源服务。实现需要同时覆盖这个位置：没有 Run／外部执行回执时，记录准备失败，保留原工具关联，使 `child_status`、`wait_child`、协作回执和 UI 都看到结束及原因；派发已返回时沿原观察／完成通道送达，不等待用户自行发现。保留已创建资源的实际回收责任，不假称从未受理。已有执行回执时按原执行结果恢复和清理，不覆盖成“子任务未启动”。

这些路径共同保证：已知不具备能力的任务不会进入重准备；检查后能力变化引发的失败及时终止对应准备，不留下永久启动中状态。

#### 9.6.4 面向 Agent 的错误

复用现有工具失败信封、准备失败记录与详细原因通道。统一错误分类可沿用 `workspace_backend_unavailable`，具体原因放入 details；不另建一种裸字符串工具返回。下例只示意错误内容，字段需通过现有协议 schema 落地：

```json
{
  "code": "workspace_backend_unavailable",
  "message": "Cannot create an independent workspace: WinFsp is not installed on the execution Host. The child has not started. Install the component on that Host and retry; if the task permits shared file changes, dispatch again with workMode=shared.",
  "details": {
    "stage": "workspace_preflight",
    "workMode": "isolated_write",
    "platform": "windows",
    "backend": "winfsp",
    "reason": "dependency_missing",
    "executionStarted": false
  }
}
```

`executionStarted` 等事实只在 owner 确认时填写。需要区分未编入后端、系统／版本不支持、组件缺失、组件不兼容、挂载权限不足，以及实际挂载失败；没有具体证据时保留查询或操作原错误，不猜“请安装 WinFsp”。远端错误说明是哪个执行 Host，帮助链接由实际后端提供，不把本机安装作为远端修复方式。

消息表达请求能力、失败原因、是否已启动，以及可行的下一步。Shared 仅作为任务允许时的替代：若隔离是用户要求或任务语义，Agent 应保留该要求并说明阻碍；否则可按原授权重新选择 Shared。平台不自动重放为另一模式，不自动切换整目录复制，也不让 Agent 因同一个缺依赖错误原样循环重试。

`preparationFailure`、managed-source RPC、原生子任务与外部执行错误映射必须保留结构化原因。现有恢复分类可以继续存在，展示与模型结果同时拿到原 code／details，避免只剩 `preparation_failed` 或一段无法判断阶段的文字。

#### 9.6.5 安装、重试与来源寿命

依赖安装由 Varin 安装器或用户明确进入的组件设置处理，按照系统要求授权。缺依赖错误本身不授予安装权限，模型工具和后台准备任务不因失败而自动下载安装器、提权、重启或改变系统安全设置；用户另有明确安装要求时沿原授权流程处理。用户跳过组件安装后，能力不可用仅影响依赖该后端的请求。

安装完成触发能力刷新。失败请求不会仅因为检测到组件就自动重新派发；显式重试沿原失败／幂等合同恢复或创建新的合法调用，原成功回执不重复执行。已有失败分支与临时引用按资源 owner 回收，错误本身不保留一份永不释放的完整副本。

依赖缺失时，不清空已有工作区、历史版本或恢复数据。能沿固定内容接口读取的结果继续可读，需要原挂载的操作明确失败。组件恢复后按原 workspace 身份重新连接，路径和连接代由新连接确认。

### 9.7 披露与用户呈现

`dispatch.workMode` 描述简短说明独立工作区需要执行 Host 的文件系统支持；没有依赖时会给原因。已有 Host 环境披露可提供实际可用性摘要，使模型少做无效尝试，工具准入仍以本次实际状态为准。不新设一组要求 Agent 先探测、安装、挂载、再派发的工具流程。

设置／诊断按实际 Host 显示后端、可用状态及具体原因，提供适用的安装入口、官方帮助与刷新。仅本机安装流程可管理本机组件；远程连接只说明对应 Host 的处理方式。项目层显示已选来源与工作区状态，不要求用户填写内部 `versionedWorkspace` 标记。

已知缺依赖时，工具行直接显示失败及可展开原因。已有子任务记录则更新同一记录，停止“启动中”的呈现；失败不会伪装成新的成功子任务消息。准备期间继续使用真实阶段、条目和字节，依赖准备与来源稳定化分别表达。

### 9.8 其他接入路线的定位

| 路线 | 能解决什么 | 当前取舍 |
| --- | --- | --- |
| 自有文件工具／编辑器直连引擎 | 跨平台虚拟文件读写，无需 OS 路径 | 继续使用；普通程序仍需接入层 |
| 自研系统文件系统／过滤驱动 | 接管更完整的文件请求或原目录写入 | 有明确缺口时考虑，签名、升级、缓存与映射兼容性由 Varin 承担；本轮复用成熟入口 |
| 进程级拦截 | 给受控启动的进程树提供私有文件视图 | 保留候选；需覆盖子进程、文件映射和实际系统调用，不只包装 shell |
| 本机 NFS／SMB | 通过系统客户端访问 Varin 文件服务 | 旧 macOS NFS 为候选；按协议处理缓存、锁、通知和挂载，未实现前不披露为可用 |
| 虚拟磁盘／VM | 独立卷或执行环境中的数据共享与隔离 | 适合单独的执行环境需求，不替代本轮本机文件工作区合同 |

采用系统接口与自研版本引擎并行成立。选择接入路线依据普通程序兼容性、部署体验及真实成本，不以“完全无依赖”作为新硬目标，也不为了去掉一个外部组件而扩大成三套自研内核实现。

## 10. Git 与工作文件

普通项目不需要 Git；Git 项目保留原生 status、add、commit、diff 和需要的分支操作。WorkingState 负责文件版本，Git 负责其 HEAD/index/refs 与 staging 语义，双方不互相冒充。

### 10.1 Git 管理状态私有化

主 Workspace 沿准确的仓库绑定使用 Git；隔离子 Workspace 有自己的 HEAD、index、锁和 rebase/merge 状态。可复用 linked-worktree 或私有管理目录＋对象引用的实现经验，但不能复制父 `.git` 指针后让两边修改同一管理状态。

Git 元数据默认放真实原生文件系统，工作目录通过准确 gitfile／配置与它关联；对象共享、分支 ref 修改和仓库维护由原生 Git 的实际语义管理。共享对象库并不意味着所有 refs 都是私有的，需要在目标支持的 Git 布局中明确操作范围。

派发前不自动 commit/stash 用户工作，不清空暂存区。继承来源的当前文件字节与 Git staged/unstaged 状态分别记录并复制必要元数据；若某后端无法保留 staging，不能对外宣称与原工作区完全相同。

### 10.2 从对象到工作文件

固定 Git blob 不一定是最终工作文件字节。clean/smudge、LFS、EOL、working-tree-encoding、submodule、稀疏配置和可执行位必须通过 Git 来源适配处理。未取得外部对象时显示真实读取失败，不返回 LFS pointer 冒充内容或从最新工作目录填补。

Git index 初建和首次 status 的路径检查成本单独测量；root fork 很轻不代表 Git 已就绪。不能每次分叉自动运行全仓 status＋读写探针再放行。挂载就绪核对实际身份与能力，真实 Git 兼容性由针对性验收承担。

工作区成果不要求全部先变成 Git commit。现有 Integration 对普通文件、二进制与非 Git 项目继续有效；用户需要 Git 工作流时才由 Git 完成相应提交和整合。

## 11. 依赖、缓存和大型文件

稳定依赖可作为共享来源，写入仍进入本 Workspace 的修改层。不能简单将 `.venv`、`node_modules` 设为只读后宣称普通包管理器兼容；它们可能生成缓存或修改安装结果。全局下载／编译缓存是否共享，依据工具自身并发合同与用户配置，不能仅按目录名猜。

本任务安装的新依赖、临时构建输出和工作数据库进入其私有状态。成果捕获与成果发布范围分开：保存真实变化不等于把所有缓存、依赖、Git 管理目录都合并回父工作区。沿原选定路径与 Integration 规则交付，不自动 add/commit ignored 内容。

源码、图片、Office、数据集等使用相同文件引擎。大文件局部写入以实际复制粒度计量；当前整文件封存是待替换的成本点，不作为增量分叉的完成标准。内存不持有全部项目正文，读取与数据写入使用现有流式／分段执行能力。

缓存属于可丢弃派生数据；已确认修改、稳定版本、Git 外部对象依赖和恢复依据具有实际引用。总空间展示区分共享对象、私有新增、读取缓存、可释放和清理失败，不把 reflink 逻辑大小相加当真实占用，也不预设按 Agent 数分配硬配额。

## 12. 交付、恢复与回收

### 12.1 阶段成果与整合

子任务可在运行中发布固定阶段版本，之后继续工作；publish 与终止进程不是同一操作。发布使用第 6 节版本边界，不能把 mutable upper 直接交给接收方。

整合使用三个准确版本：共同基线 B、子成果 S、接收方当前 T。父任务已经从 R10 走到 R12 时，将 S 相对 R10 的变化整合到 R12，不覆盖成 S 的完整目录。不同文件可独立整合，同文件冲突保留双方，sourcePath 映射与 Windows 路径身份参与原核验。

`update`、`submit_code`、最终成果与恢复面板复用原 Integration。对目标已管理 Workspace 使用条件树更新并通知挂载／编辑器；对旧 LiveRoot 明确执行原物理事务。不得先改树再异步无条件覆盖磁盘另一份“主项目”。

### 12.2 持久性与恢复

可见写入、flush 完成和持久 checkpoint 分别表达。普通程序遵守目标 OS 的写入／fsync 合同；返回持久 snapshot 成功前，引用到的正文、树与 journal 必须完成相应落盘。稳定引用不能指向只存在内存或尚未确认写完的 backing file。

重启先恢复原 Storage journal、Workspace 与引用，再判断挂载／进程寿命。断开的 mount 可重连保存状态，但旧文件句柄、mmap 和进程内存不会自动复活；旧进程是否存活依据真实 owner 回执。无法继续的进程显式报错，不静默把原路径替换成空目录或重跑副作用命令。

挂载中的命令写入可扩大 Recovery 的文件覆盖范围；无法精确归属的写入如实记录。文件恢复针对被选择的路径，在当前 Workspace 生成新版本，保留其他后续变化和 redo；不能因为有全树快照就一键回滚所有并行工作。

### 12.3 生命周期和 GC

Workspace 生命周期、Mount 生命周期与 Operation 生命周期独立记录。挂载失败可不改变有效文件版本；Run 完成可仍有后台进程；成果已发布可仍有未发布新改动。

回收先保留需要的成果／恢复版本，撤回新执行准入，等待真实读写句柄和进程释放，确认卸载后删除 owned backing 与管理记录，再按引用图释放对象。取消意图、executor stop、卸载完成和已释放空间分别返回。

base roots、workspace heads、checkpoint、result、Recovery/Integration、Git 来源引用、打开内容句柄及未完成发布都进入现有可达集合。发布与 GC 通过短提交／保留引用协调；不按目录年龄清理，也不增加只增不减的第二份永久账本。清理回执完成后，其不再需要的记录同样进入回收。

## 13. 接口与模块映射

接口示意描述所需行为，不要求增加同名公共工具：

```text
adoptSource(source, captureMode, originalOperation) -> WorkspaceBinding
checkpoint(workspace, boundary, originalOperation) -> RevisionRef
fork(workspace, revision?, scope, originalOperation) -> WorkspaceBinding
acquireExecutionView(workspace, owner, requirements) -> MountLease
publish(workspace, selection, originalOperation) -> ResultRef
integrate(base, result, target, expectedState, originalOperation) -> Receipt
release(binding, originalOperation) -> CleanupObservation
```

所有修改沿已有幂等、授权、真实停止与结果回执合同。模型仍使用 `dispatch.workMode/sourcePath`、文件工具、process 工具和现有交换／恢复能力；不要求模型先 mount、checkpoint、seal、GC 才能完成任务。

| 模块 | 实施责任 |
| --- | --- |
| `storage/state_tree.rs`、`branches.rs`、`workspace_files.rs`、`workspace_session.rs`、对象与引用模块 | 版本树、稳定来源、持久区间内容、分叉与发布、并发及耐久性 |
| `workspace_resources.rs`、`workspace_mount/*`、`native-workspaces.ts` | 实际后端能力、依赖诊断与资源 Host 的检查入口；真实挂载结果单独处理 |
| `source_resources.rs`、Storage 文件／进程资源 | Workspace/Mount 准入、资源身份、挂载服务、句柄和进程引用 |
| `child-source-store.ts`、`child-source-capture.ts`、`source-preparation.ts` | 对已管理来源走 root fork；旧来源走明确接入，退出每次全量捕获 |
| 原生 dispatch、`thread-collaboration.ts`、`managed-source-collaboration.ts`、外部 Agent source | 派发前准入、已受理准备失败、同一来源分叉、进度、取消、发布和回收 |
| `preparation-failure.ts`、私有协议 schema、application-client 与工具结果映射 | 保留后端原 code／details、启动事实及既有恢复分类，不制造另一种失败信封 |
| Documents／application-client／Registry | 文件 API 与实际路径绑定、草稿、watch、冲突和编辑器导航 |
| process／script／MCP／extension／external-agents | 绑定实际执行视图，保持原工具与外部会话身份 |
| Recovery／Integration／materialized_views | 消费新旧来源的准确版本，确认回收，不重复维护成果 |
| Electron／打包／Host 能力发现 | 平台依赖检测、安装与故障呈现，不新增 Electron 文件后端 |

数据密集的文件系统请求不走 Catalog actor。挂载执行者需要直接高效调用 Rust 文件服务；若独立进程通信，复用原私有认证和内容通道思想，避免逐字节 JSON 和每个 write 全树提交。

## 14. 准备响应性与产品呈现

准备状态区分实际来源确认、首次稳定化、版本切分、挂载、后端连接和清理，不用循环动画掩盖未知等待。已知工作量显示已处理条目／字节；未知总量不伪造百分比。

控制请求、取消和观察不排在重 I/O 后面；主会话继续可用。大枚举、排序、正文核验、数据库扫描及挂载回调都检查是否占据 Host 事件循环、Storage 控制锁、Documents barrier 或进度回执通道。真正的取消传播到执行者，返回请求已受理后仍观察停止和清理事实。

UI 保留现有项目、工作概览、子 Agent 和协作设计，只在需要判断时显示：当前来源、是否隔离、实际目录、准备阶段、失败原因及可继续操作。诊断详情提供 backend 与快照能力；不让用户每次派发选择底层文件系统。

主工作区切换目录的说明属于一次明确接入流程。日常 Shared 和隔离派发沿已有授权推进，不追加每次确认、默认配额、统一超时或强制停止主任务。

## 15. 本轮体检的配套修复

| 问题 | 处理方向 | 验收依据 |
| --- | --- | --- |
| D1 隔离准备卡住应用 | 独立定位具体等待／资源争用并修复响应性；结构上替换全量准备路径 | 原故障来源可观察、可取消；其他会话可推进；已管理分叉不复制整库 |
| D2 tool_invoke 层级提示 | 明确目标参数直接放在 `tool_invoke.arguments`，附最小正确示例 | 不出现诱导嵌套的 `arguments.arguments` 文案，真实 schema 可调用 |
| D3 current:before | 明确表示本轮开始前，包含撤销新建；恢复点应能区分轮初和具体 before/after | 选择的范围与逐文件结果一致，undo 保留；不改变既有恢复含义 |
| D4 UI state 重启丢失 | 分开检查 live view 断连和保存状态持久化／重新绑定；现有 saveView 应追踪完整链 | 重启后保存状态可恢复，旧 live 句柄仍如实断开 |
| D5 退出与输出未收尾 | 保持现有区分，不为表面一致提早标完成 | 最后输出不丢，继续读游标正确 |
| D6 编码 | 先验证报告提出的实际反例与现有 encoding 覆盖 | 只对复现的失败修改，不凭推测新增解码策略 |

本提案不声称已经修复上述问题。配套修复可以独立交付，不等待整个 VFS 重构；也不能以改报错或 Shared 可用代替隔离能力验收。

## 16. 实施顺序与完成条件

本轮交付覆盖按需准入、平台组件交付和区间版本闭环。以下给出各实现入口与验收边界；候选来源适配和替代系统后端另列，避免与当前可用能力混淆。

### A. 按需准入与清晰失败

已在 Rust `child_source_handoff` 和 native handoff 入口前置实际资源 Host 检查，Host 项目启用亦先探测再写准备状态。`workspace_backend.rs` 统一类型化原因，Catalog 子任务报告保存可选原始 `ExecutionError`。异步失败仍由原执行结束，Shared 不增加挂载探测。

完成条件：缺少实际依赖时原工具得到可操作错误，不进入 inventory，不启动子 Run；已创建的记录及时失败；依赖修复后可显式重试；没有自动改模式、自动安装或永久启动中。

### B. 平台接入与产品交付

已选定未修改的官方 WinFsp MSI，下载与缓存校验固定 SHA，NSIS 可选页面复用相同或更新版本，并保留跳过、取消、失败及需重启结果。App 关于页与 THIRD_PARTY_NOTICES 保留许可及版权。Windows 检查架构匹配 DLL、SxS 驱动登记、禁用与启动权限，检查本身不启动驱动。Linux deb/rpm 声明 FUSE3，准入核对字符设备、当前 namespace 的直接挂载能力与可执行 helper；卸载保留真实失败。macOS 内置扩展通过私有二进制内容通道调用原 Rust Session，不持有第二份数据库；产品构建、独立 entitlement 签名、精确扩展启用检查、用户打开 Host 设置和原挂载清理已接通。原 macFUSE VFS 路线保留，未满足实际依赖时明确失败。

完成条件：实际发行平台具备可解释的依赖状态与交付流程；跳过或失败仅影响所需能力；组件更新／卸载不破坏其他应用或遗留工作区。未实测的平台如实标注，代码与文档不写成已经通过。

### C. 分叉与发布保留增量版本

`FileSnapshot::freeze` 已替代 checkpoint 与 flush 中整文件 seal：只捕获仍有效的私有区间，平面描述引用原正文。`file_content.rs` 统一读取、物理导出和恢复；计算、成果、跨 Host 精确传输和 GC 均使用该内容合同。新文件／完整覆盖继续保存普通正文。描述身份为 `ranges-sha256-…`，逻辑长度与描述长度分离；不把它冒充重建正文的 SHA。读者引用及取消沿原资源寿命保留。Linux 在协商 FUSE_SYNCFS 后启用对应写回缓存，并在原调用线程的 post-writeback 回调内固定版本；其他 sync 不消耗该边界。macOS 等待当前卷同步后进入短 Session 边界。旧 Linux ABI 保留有范围的活动 writer 障碍。

完成条件：大文件小改动后的分叉只保存必要变化和元数据，未修改内容共享；父后续写入不改变子版本；重启与 GC 后固定版本仍可读取。实际必要的缓存同步单独计量。

### D. 来源与主子工作区接通

已有 fixed／native 来源继续按精确版本分叉。普通目录按所选范围完成首次捕获，从已准入句柄尝试 APFS clone／Linux reflink，共享原数据块并核对固定内容；不支持或跨卷时沿同一句柄流式导入。用户可在项目设置将主来源接入受管工作区，之后分叉不回扫原项目；已有运行与进程保留原来源。文件工具、Documents、终端、script、Office、workspace MCP、扩展、外部 Harness 和 Integration/Recovery 沿原统一 Source。Git 对象懒读、卷级 OS 快照和原路径透明接管仍是来源候选，当前普通目录保存实际文件及私有 Git 状态。

完成条件：受管主工作区持续写入时可派发独立子任务，后续分叉不扫描原项目；物理首次接入成本单独呈现，不被藏到首次命令中。Git／非 Git 项目都能交付与恢复，用户无需填写内部绑定字段。

### E. 回收与有针对性的真实验证

GC 已将区间描述及其原正文依赖纳入树／pin／记录／活动 reader 的可达性，孤儿扫描和实际删除识别各自对象目录。沿现有资源引用保留进程、句柄、挂载和日志寿命。原生回归覆盖大文件小改动、父子继续写、重启读取、精确跨 Host 上传、物理导出与引用回收；另有缺组件前置拒绝和报告错误保留。真实平台安装／挂载及 macOS／Linux 系统行为尚未运行。

FSKit 的私有端点按当前用户保存在短路径资源目录，实际执行者持有 OS 锁。重启回收只认领已经解锁的 UUID 资源，按内核挂载表核对原路径和来源后卸载；失败保留原清理责任，不按年龄判断死亡。SDK 构建同时覆盖 arm64/x64 扩展并验证控制程序弱链接 FSKit；macOS CI 运行 Storage 及执行器回归，真实挂载／dirty mmap 测试保留为显式系统资格验证。

完成条件：不存在无引用仍永久保留的副本或日志；共享数据不被提前清理；关键准备与分叉成本有实际依据。缺少实机证据时记录具体未验证项，继续可完成的实现，不以大规模真机测试作为文档或全部代码推进的前提。

能力准入、平台交付与性能改造分别报告。按需隔离是确定的产品边界；自研三端驱动、所有旧系统替代后端及“完全无系统依赖”均不是本轮完成条件。

## 17. 验收与成本口径

复用现有 owner 的测试，只补能证明新增关键行为的场景。先覆盖发生问题的普通父目录、一个真实 Git 项目，以及少量能区分版本／文件语义的样例，再按发现的问题扩大；不建设常驻评测系统。

共用场景在三端采用等价数据和操作，系统特有行为单独验证。macOS 纳入当前发行的 Apple Silicon 与条件支持的 Intel，具体 OS 版本覆盖实际后端 API 边界；Linux 包含普通无特权 Host，Windows 使用普通 NTFS。CI 编译通过与真实挂载／普通工具验收分别记录，不能拿 mock 后端代替某一平台。

| 必须证明 | 场景与观察 |
| --- | --- |
| 缺依赖前置拒绝 | 本地／远端／外部 Agent 显式隔离缺组件时不进入 inventory、内容捕获或子 Run；工具结果保留具体原因 |
| 正常能力不受误伤 | 后端缺失时 LiveRoot Shared 与普通文件操作仍工作；已有 native 来源失效时明确失败 |
| 准备失败及时结束 | 已受理异步准备失败后原状态、观察与 UI 一致结束，取消／回收责任保留 |
| 修复后显式重试 | 安装／权限修复与刷新后能够重试；不自动重新派发、不切成 Shared、不重放成功调用 |
| 主任务不停止 | 子任务运行时主 Agent 改同名与不同文件，子读取固定起点和自己的修改 |
| 文件工具与程序同源 | 工具写后 Python 读；命令替换后编辑器／搜索看到同版本 |
| Shared 语义 | 两执行者使用同一主 Workspace，条件编辑冲突仍有效 |
| 低成本分叉 | 分开记录首次接入、固定 revision、创建私有状态、挂载、首次有效操作 |
| 真实存储收益 | 记录新增对象／私有数据／读取缓存／物理写入与实际分配，不叠加逻辑目录大小 |
| 持续写入与 snapshot | 打开的文件、原子替换、后台进程及可写映射不破坏已发布版本 |
| Git 与 dirty 来源 | 未暂存、暂存、新增、删除、filters 和实际支持的子模块／LFS 路径分别核对 |
| 大文件与小文件 | 大文件局部修改后不以完整封存作为分叉前提；实际新增／读取字节，以及小文件读取与首次搜索／构建延迟 |
| 结果整合 | 父继续修改后，B/S/T 合并保留双方；冲突、undo 与 sourcePath 映射正确 |
| 取消／重启／卸载 | 原执行停止、已确认修改保留、重复请求不重做副作用、回收失败可继续处理 |
| 多任务资源复用 | 同来源并行任务共享基线，某一取消不释放其他引用，完成后无多份完整副本残留 |
| macOS 系统集成 | APFS clone 的实际共享、FSKit／macFUSE 的能力与 OS 版本、Finder／编辑器保存、扩展启停和睡眠唤醒 |
| Linux 系统集成 | FUSE 缓存写回、普通用户挂载／无桌面 Host、权限／锁／open-unlink、daemon 重启 |
| Windows 系统集成 | NTFS 路径与共享句柄、映射写入、后端安装／退出、原准备挂起场景 |
| 资源 Host 选择 | 不同平台客户端连接同一 Host 时访问同一 Workspace，不借用客户端的路径或后端 |

计量至少区分 `首次接入`、`分叉返回`、`目录可用`、`首次 status/search/build`、`成果发布` 和 `资源实际释放`。不能用预热后的分叉对比旧方案冷启动，也不能把所有成本推到第一次命令后再声称启动完成。

不承诺任意普通目录的零准备，不预设固定毫秒数、并行数、空间倍数或通过阈值。平台能力和真实代表性负载给出结果后再确定产品默认，避免把演示效果当作部署结论。

## 18. 已定边界与剩余技术取舍

已定边界：默认 Shared、按次显式隔离、实际 Host 依赖准入、缺能力明确失败、不自动降级／安装、不要求全平台零依赖。下面的技术取舍不改变这些行为。

| 尚未定下 | 当前推荐 | 依据／改选条件 |
| --- | --- | --- |
| Windows 组件升级 | 当前固定官方 WinFsp 2026 Beta5，复用相同／更新版本 | 后续按上游修复、签名、许可与实机结果更新版本及 SHA；运行时不升级共享组件 |
| macOS 后端 | 可用 macFUSE 按后端资格接入，自有 FSKit 为优先建设方向 | 具体 API 可用版本、通知／缓存、签名启用、许可；旧系统 NFS 保留候选，缺能力时拒绝隔离 |
| Linux 后端 | FUSE 直接呈现受管树，实际原生 CoW 能力加速数据层 | 缓存写回与 snapshot fence、普通用户部署、实际文件系统；OverlayFS 必须具有固定 lower／upper 边界 |
| 三端接口收敛 | 共用语义、平台原生操作与数据能力分层 | 三端首轮原型共同决定接口，不能以单端成功冻结平台特有假设 |
| 主目录路径接入 | 首版明确独立挂载路径，统一所有消费者 | 原路径透明接管需额外文件系统与占用交接证据，不自动实施 |
| 普通目录首次稳定化 | 稳定版本／快照优先，其余明确首次捕获；受管后保持增量 | 写前保留须覆盖真实修改入口才可用于懒接入；原目录持续外改时不谎报固定版本 |
| 内容写入粒度 | 持久树＋不可变区间版本，移除分叉的完整文件封存前提 | 区间持久化、读放大、现有消费者和 GC 共同决定布局；无需统一猜测块大小 |
| Git 管理布局 | 使用原生 Git，隔离管理状态，复用稳定对象 | linked-worktree 或私有 admin 依据平台挂载和 Git 兼容性选择 |
| OS 缓存与 snapshot fence | 文件服务建立实际写入代边界 | mmap／缓存写回证据决定支持范围；不能用工具结束事件代替 |

这些是实施取舍，不新增用户每次操作的必答问题。涉及改变用户项目位置、安装系统组件或采用新持久格式时，在具体可评审结果上遵守原授权与资产规则。

## 19. 资料与复用边界

输入材料：用户提供的 `harness-fix-brief-20261026.md`（0.9.33 实测）与 `Agent_Workspace_CoW_VFS_Research_2026-10-26.md`（构想、开源调研、路线建议）。材料原件保留于用户本地；本文提取与 Varin 决策相关内容，不把外部报告的推荐、基准或限制自动当产品要求。

重点参考如下，项目实现结论限定到所指源码，尚未在 Varin 环境运行其完整后端：

- [SandFS workspace](https://github.com/lydakis/sandfs/blob/a352d82194b929a68399df8d625d72c1d14c1fba/crates/sandfs-core/src/workspace.rs)：共享持久化映射、未读基线内容引用与共享缓存。
- [simgit CoW](https://github.com/abendrothj/simgit/blob/bcb419bf0d4bfd71c82cf8913e2fa3c0848f572f/sg/src/commands/worktree/cow.rs)：稳定基线引用、平台克隆；所读路径不提供 Windows clone。
- [oh-my-pi 任务工作区](https://github.com/can1357/oh-my-pi/blob/13abc1a2b37847e626a3df99f1a2c05e0d577262/packages/coding-agent/src/task/worktree.ts)：报告所述 Git 管理状态与交付闭环参考。
- [Factory VFS 分支](https://github.com/Factory-AI/vfs/blob/4852148cecde9c5413b51e4184eac55015bfe766/crates/vfs-cli/src/cmd/branch.rs)、[artifacts](https://github.com/Factory-AI/vfs/blob/4852148cecde9c5413b51e4184eac55015bfe766/crates/vfs-cli/src/cmd/artifacts.rs)：报告所述发布、引用和 GC；不照搬分叉时复制整份数据库。
- [AgentFS overlay](https://github.com/tursodatabase/agentfs/blob/0a014ebd4918615baff589ed17486e557e7c6a23/sdk/rust/src/filesystem/overlayfs.rs)、[git-lazy-mount Git 层](https://github.com/mohsen1/git-lazy-mount/blob/ecb969a95fdfe714b69e28d3df07292f238a52fd/crates/git-repo/src/lib.rs)：报告所述 copy-up／目录语义与 Git 接入参考。

采用具体第三方代码前按原许可证与 THIRD_PARTY_NOTICES 处理；不整合另一套任务、数据库或版本权威来重复现有 owner。实施完成后，将实际合同回写领域文档，保留未完成边界，避免设计与实现说明矛盾。
