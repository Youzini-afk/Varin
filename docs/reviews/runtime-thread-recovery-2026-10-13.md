# Thread 历史导航与原文件恢复

基线：`af9c1b29c7eff3a07027a587651e31d585364ac5`。依据[运行时设计 §15.4](../design/agent-runtime-design.md#154-回滚草稿与组合恢复)与[原恢复设计](../design/native-workspace-recovery-design.md)，在原 HistoryBranch、Documents、Storage journal 上接入明确恢复。默认运行时保持 Pi。

状态：本片实现收口；下列有限执行证据不代表全部组合路径已经通过。

## 共同合同

- 对话回退使用原 Catalog 命令、head CAS 和持久 receipt。相同 key 的迟到重试返回原事实，不再次回退后来加入的输入；返回已移除后代必须引用原 Undo receipt。旧 Run、用量、已发生效果、Goal 取消和来源选择不随 head 回退。
- 祖先、工具配对和上下文正文在读 worker 准备。新的 context revision 拒绝旧摘要候选；跨过摘要范围时移除摘要专属 Bot baseline，不删除 Knowledge/MemoryState。
- Recovery v6 使用明确的 Pi session / Thread branch conversation 标记；当前内部 Storage 格式为 15，Catalog 65，wire 25。旧内部格式直接拒绝，不保双轨 reader，也不删除实际资产。
- 原工具冻结输入范围决定 checkpoint。文件 before-image 与原 `file.apply` intent、最终 after-image 与原 receipt 同事务关联；不把模型 request ID 伪造成普通输入。每个物理目标保原来源、根与当前权限。
- 组合操作记录逐文件阶段、safety 与原历史命令。明确拒绝后只补偿本操作仍拥有的输出；传输不确定先读原命令事实。启动发现和导航 owner 就绪分别处理，planned 不自行执行，重开继续同一 operation/revision。
- Thread 与原 Pi 页面共享恢复对话框。当前脏缓冲仍须先保存或丢弃；失败不被转换为无冲突。重开投影区别组合 Undo 与仅对话 Undo，不重放旧输入或新建第二份恢复状态。

## 已执行的有限证据

| 路径 | 结果与边界 |
| --- | --- |
| 原 Catalog navigation | `navigation_review` 的原命令、CAS、后续新输入下原 receipt 重试、确切 Undo 和重开用例通过。直接 Rust Catalog，不是完整 Host 产品入口。 |
| 原 Storage 文件 journal | `recovery_journal` 实际 file.apply、重复 receipt、同 Run 多输入、A→B / 外改 C→D 断链及重开保持 incomplete 用例通过。真实临时文件与 Storage，不是完整 UI 恢复。 |
| 原 RunAssembly 后继消费者 | `thread_recovery_review` 用例通过：实际 KernelToolExecutor/file.apply 先 A→B，同 Run 的真实 Boundary 新输入再 B→C，两个 checkpoint 各归原输入；仅对话回退后，显式新输入的实际 Responses 序列化不含两个已移除输入；旧 Run 仍 Completed、物理文件保持先前写入。真实 Rust 执行/文件/序列化链，provider 与进程内资源通道受控，没有调用真实服务或产品 transport。 |
| Bot → 回退 → 下一 Context → GC | 扩展原 `context_job_review` 用例通过：跨摘要回退后下一 Run 仍有未变知识，MemoryState 不变，旧 Bot snapshot 和 summary ModelStep 可读。该用例先发现新命令 intent 内联破坏 GC，修为原 ContentStore 引用后通过。未重跑旧 Bot 全套。 |
| 公共 Router 不确定结果 | 直接认证 Router 检查确认 kernel 断连等结果可为 HTTP 400；UI 保留同一未知命令，不误作未提交。没有启动监听服务。 |
| 原 journal 的中断阶段 | 原 `engine.test.ts` 选择的 3 个用例通过，23 个未运行：文件已恢复但导航响应未知，fresh engine 沿同一 operation/revision 续接；apply-intent 与 compensate-intent 的已写中断分别条件收敛。使用生产 journal-engine/Documents、内存 durable port 与测试 filesystem helper；无 KernelClient，不外推为 Rust/Thread 多根组合执行通过。 |
| Thread / Pi 恢复消费者 | 31 个相关 React 行为用例及 2 个原 policy 用例通过，包括原图片草稿、确切重试、重开发现、非终态同操作续接、Host 切换和 Pi RecoveryPanel 的 Undo 丢回包。API seam 受控，未执行实际磁盘恢复或桌面。 |

UI 整包 TypeScript 与改动文件 ESLint 通过，最后文件名/读取失败投影修改再经类型及聚焦 lint 检查，未重复行为套件。8 个原合同测试文件迁移后，完整 Host tests 与 contract 的 `tsc --noEmit` 均通过，纯 Node recovery contract 6 个用例通过。原 Pi 事件、broker 与 actor 的 sessionId 保留，不盲目迁移非 Recovery 领域。最终 Host production noEmit、协议生成一致性与 diff 检查通过；这些项目检查不等于全仓所有应用的 build/test。

原 `scripts/build-kernel.mjs` release 构建通过，耗时 4m24s，linux/x64、build identity `0.9.25`、protocol `25`。产物 61,219,480 bytes，SHA-256 `65819f1d9eb9873cf375c6c7f6471f8ce256e82a43a3cc92961d492a293e6bbd`。未启动产品 listener。构建仍有 3 条新生成 enum 字段命名 warning 和 13 条 Kernel warning，未隐藏编译诊断、未称零 warning。文档链接检查通过。

## 审查与执行边界

独立审查随功能追到 Bot Context、GC、原 Integration、进程 writer、跨来源对象引用、fork 与重开投影；发现的源码级阻断已由原 owner 修复，不把局部 UI 通过当整链完成。

审查已追到并修复：原 Integration 启动对账只排除自己的确切 reservation，不能删除其他写者 guard；跨 workspace 的 safety 状态在目标写入前沿原 operation 引用转入目标 owner；fork 从同 Thread 保留的原 launch 找恢复工作区，再按真实 branch 过滤。元数据读不要求旧物理根在线，恢复域读取失败明确投影且不吞为成功空列表。Job/child Wait 的迟到交付仍核原身份、head 与 active Run；该关联判断是源码证据，未冒称真实 child 回退场景已执行。

一次拟执行的 KernelClient durability 探针漏查默认 transport。默认 constructor 尝试 Unix `control.sock` listen 时被 EPERM 拒绝，业务未完成，动作已停止；未重试、换 transport 或提升权限。该探针的多物理根/重开场景不计通过。此处与已允许的直接 Router、纯 Rust、既有明确 stdio 入口分列。

完整产品网络 IPC、实际桌面/跨平台文件行为、掉电、真实模型服务和长期性能均需各自环境证据。本片不恢复 Git index，不宣称可无条件覆盖未保存缓冲或任意未记录的 shell/外部文件效果。

## 原入口

- `kernel/crates/varin-runtime/tests/navigation_review.rs`
- `kernel/crates/varin-runtime/tests/context_job_review.rs` 的原 Bot summary 单用例
- `kernel/crates/varin-kernel/src/storage/recovery_journal.rs` 的 owning 用例
- `kernel/crates/varin-kernel/src/thread_recovery_review.rs` 的原 RunAssembly/后继请求用例
- `packages/ui/src/components/thread/ThreadConversation.behavior.test.tsx`
- `packages/ui/src/components/pi-session/PiChatView.transitions.test.tsx`
- `packages/ui/src/components/layout/PiRecoveryPanel.behavior.test.tsx`
- `packages/web/application-host/lib/recovery/engine.test.ts` 的上述 3 个中断阶段用例

复跑应先检查真实入口、imports、hooks 与 constructor/default transport；文件名含 native 或 stdio 本身不能证明它不监听。按本次变更影响选择用例，不机械重跑已有效的 Source/Bot 套件。
