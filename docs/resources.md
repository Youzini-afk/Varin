# 资源、执行与恢复

项目组织导航，Thread 拥有工作，Source 指定执行读取的字节，资源 Host 拥有实际副作用。它们可以关联，但不能互相代替。
这个边界允许无目录对话，也允许一个任务使用多个 Host 的资源，而不把协调机当作万能工作区。

进程归属见[架构](architecture.md)，Catalog 见[运行时](runtime.md)。具体实现入口：
[Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md)、
[WorkingState](../packages/web/application-host/lib/harness/working-state)、
[进程](../packages/web/application-host/lib/process/DOCUMENTATION.md)、
[Recovery](../packages/web/application-host/lib/recovery/DOCUMENTATION.md)。

## 来源选择

Agent Thread API 显式选择来源 owner、mode 和内容。本地与 managed-host 是不同的带判别字段 owner。
来源发现是只读操作，知道目录或 workspace 登记并不授予执行权限。

- **FixedBranch**：读取不可变 branch/revision。原目录移动后，只要当前登记/信任和原对象仍有效，仍能读固定内容。
  它没有可写物理 cwd，目前不支持需要 cwd 的 MCP 执行。
- **Materialized**：绑定原 environment/Run、受管物理副本和不可变 baseline。副本丢失或身份变化时，不静默重造同一执行。
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

虚拟文本工作可留在不可变树中；需要真实路径的命令物化所选树，经过 staging、校验、backup、promotion。
原 worker 实际停止前，目标/staging/backup 的物理租约持续有效，包括取消和重启协调期间。无法证明的中断目录保留，
清理不能递归删除后来用户写入的内容。Linux/macOS 可尝试 clone 后退回校验复制；Windows 当前报告 copy、物理分配未知。

Git 是 inventory、filter、换行、mode 和 linked-worktree 元数据的语义适配，不是 WorkingState 存储或第二个正文 writer。
结果发布和 Integration 使用记录的 base/source/target，不复制一个未限定的“最新工作区”。结果与恢复各自持有对象引用。

## 文件准入与观察

Host Documents 负责根准入、文档修订和 Surface 协调。Rust Storage 负责规范化 exact/subtree 租约及物理捕获、apply、rename、remove。
别名、symlink、平台大小写参与同一资源身份；嵌套调用仍由 Rust 判断租约覆盖，TS 路径字符串相等不够。

会话准备通过 Documents 批量读取已知的指令与配置候选，共用一次覆盖这些 exact 路径的租约。
读取结果与缺失事实只在本次准备内复用；候选文件各自保留错误，外部别名继续由原资源 owner 准入。
目录身份与信任查询走 `getWorkspace`，需要编辑状态的界面才使用 `inspectWorkspace`。

租约约束已准入的冲突工作，不隔离任意第三方进程，也不把 live root 变成 OS 原子快照。文件效果在真正执行时复核身份和
expected state。read/read 可重叠，不冲突的工作可绕过等待项；等待者不提前持有部分资源。

文件通知是失效事实，不是内容 revision。支持的 Linux 本地根在连续覆盖下复用路径 inventory，只重扫 dirty subtree；
inotify/VFS fence 依赖原 mount/root 身份和未丢失事件。这只减少 namespace 枚举，**仍对所有选中文件正文哈希与校验**。
Windows 和不支持的根保留 unknown coverage，完整复核目录 inventory。重启、overflow 或订阅丢失使复用失效；
独立 watcher 不持有 runtime/Storage owner。

冷对象验证、正文读取和捕获哈希由有限 native worker 执行。临时 exact-hash 引用保护 GC/退出前的字节，不是访问授权。
完成时再次核验权限；caller 取消不会提前释放仍在读的对象引用或物理租约。
文件捕获按实际文件长度预留缓冲，分配失败返回该文件的读取错误；文件大小仍由实际可用内存决定。
内核重启后，Host 更新文件、计算、进程与 Computer 的授权缓存；新请求绑定新 epoch，旧请求保留原失败与回执。
跨越重启的进程准备会终止，后续显式启动请求重新受理。

## 进程与 Operation 寿命

Rust ProcessManager/guardian 拥有 pipe/PTY、stdin 序列回执、原始输出、resize、终止和真实进程树退出回执。
guardian 是同一发行 executable 的另一模式，不另开数据库 writer。Host Terminal、shell、task、test、LSP、DAP 适配原 handle。

输出观察、业务结果和 executor stop 是不同维度。业务副作用可未知而进程已确认停止；响应丢失也不能证明进程停止。
关闭终端视图不杀 Job，取消 Wait 不杀被观察进程。stdin 与 resize 分别有序，使阻塞输入不拖住窗口调整。

Windows 使用 named Jobs；Linux 使用 managed session 加 subreaper。旧 epoch 无法证明的退出保留 unknown，继续保护目录。
Host 对可能仍存在 executor 的启动/停止失败保留 owner，不用旧 PID、HTTP abort 或 Promise reject 虚构退出码。

grant retirement 与 revocation 分开：前者在真实 drain 后关闭旧 caller，后者继续拒绝。Operation-owned grant 可以长于 Run，
直到自己的 reader、process 和回执归档完成。原来源仅支持精确限定的 successor 读取，不继承全部旧控制权限。

## 受影响文件恢复

Recovery 是已知修改的 journal，不是工作区备份。turn 开始只建轻量 checkpoint，不递归扫描项目。
工具写入在效果前记录 intent/before-state，之后记实际 after-state；同 turn 多次写保留第一次 before 和最后 output。
普通 shell/外部应用没有可移植 pre-write hook，未知修改明确标为 uncovered，不能承诺全部撤销。

恢复只折叠所选历史条目影响的路径，计算 expected-current 与目标状态；验证这些路径，保存 safety/redo 对象，再条件应用。
后来用户编辑保留为冲突。确认脏缓冲恢复使用原 Registry owner、instance、revision；离线或未知 dirty-state 仍可重试，
不能当作“没有脏缓冲”。

对话恢复使用真实 Thread/HistoryBranch 导航。导航响应丢失查原 command receipt，不重复导航，不仅比较当前 head，
也不立即补偿文件。只有明确拒绝才补偿仍等于本操作 output 的路径。Undo/重启继续原 operation/file phase。

Managed 多 Host 恢复由对话 Host 先持久化 metadata-only coordinator 和固定 participant 身份，再联系文件 owner。
目标 Host 在当前权限及原 Source/root 核验下进入自己的原 journal，拥有文件对象和补偿；协调端只持引用与回执。
文件阶段全部确认后才提交原导航。未知响应保持 pending；取消先耐久记录意图，再等待慢观察/原 owner drain。
这是多个事务的可恢复协调，不是跨 Host 原子事务。

Integration 共用条件文件/对象机制。Agent 触发的整合将效果接到原 parent turn，普通对话撤销无需第二账本。
混合 Surface/disk 修改若无法证明已分发效果，则保留耐久 needs-attention；网络失败不能变成安全空结果。
Undo 在保留执行意图前检查原 Surface owner、回执和新鲜 dirty-state；准入失败仍可用原操作重试。
多 Surface 的原 undo 回执逐组保存，后续 owner 丢失回复不抹掉已确认补偿，也不借用 apply 的停止证据。

内置 provider 将 Recovery 与 WorkingState 同置于 Host kernel 数据根，目前不提供可迁移存储和 retention/delete-history 控件。
Host catalog/WAL 是共享大小，不能反复当作每工作区可释放历史。GC 核对全部引用 owner，并如实报告物理删除失败。
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
