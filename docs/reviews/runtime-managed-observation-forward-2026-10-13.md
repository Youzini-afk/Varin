# Managed 文件跟进与原服务转发

基线：`db8a7af92f6aca11b21abf2ede8e58cbb022a716`。依据[运行时设计 §18.3、§22、§25](../design/agent-runtime-design.md)及[能力设计 §5.3](../design/runtime-extensibility-design.md#53-环境是一组相互一致的能力)，将已有文件条件和服务转发接到原环境身份与实际消费者。不是新增一套远端进程、条件调度或服务生命周期。

## 原 owner 与消费链

- User 文件注册从 `ThreadsAPI` / `registerUserFollowup` 进入原 Catalog command。完整意图先在锁外写入 ContentStore，短命令持有原 source-read scope，然后才向 B 申请读取。未知 bind/登记按同 scope 和原 key 恢复；已登记或已取消的 key 返回原定义，不重新绑定。
- B 继续使用原 Storage `file.observation` receipt 和 Documents watch/capture。首次基线持久后，丢回包不改成后来文件；全部叶基线就绪后关闭原 read scope，再提交 A 定义。该 fence 同时退休并发重复 caller，并拒绝晚到 bind；不是撤销已接受 observer。
- A 列表只投影冻结元数据，不等待 B 网络，也不在协调机同名目录开 watch。B 观察使用原 cursor、文件事实和独立 writer/readiness 状态；未变化不重新读取、哈希正文。managed 定时器只唤醒传输，条件与 occurrence 仍由原 Catalog 判断。固定来源成功后不持续轮询。
- pause、恢复、取消和 Bot 删除沿同一 receipt。release 包括正在异步打开但尚未入表的 watch；收到真实释放 ACK 后才删除 A 清理地址及其命令正文 root。目标暂不可达保留地址，不持 Catalog 锁等网络。
- 已接受 receipt 可按原址恢复；B 重启暴露 watcher gap，不虚构离线变化。若旧 pending authority 的某叶尚未被 B 接受，旧 epoch 不能重新准入该叶；用户可取消原意图并以新 key 注册，不自动替换 authority。
- B 明确撤权沿原 receipt 释放固定 pin，并使现有/正在打开的 watch 失效。撤权通知自身不是等待全部 Host validation 结束的 ACK；原 file release RPC 才等待该 receipt 的 flight 排空。A 的暂停或固定成功定义保留最后已接受事实；没有另设跨 Host 撤权推送或权限轮询，所以诊断可延迟到下次原观察/恢复/控制。该快照不是当前 B 权限证明。
- 新普通 builtin 工具 `environment_forward`、`environment_forwards`、`environment_forward_get`、`environment_forward_close`、`environment_forward_wait` 使用现有 Host `EnvironmentForwardRuntime`。Pi session 和 Agent operation/Host-epoch 使用明确 tagged owner，只有该原 owner 管 listener/streams。
- 远端转发属于原 Catalog Thread Job。显式目标沿配置连接冻结；未显式指定时采用原 Source owner，无源或显式 local 返回直接地址，不制造 listener 或可达性证明。文件只读不等于禁止另一个已授权网络工具。
- 创建、取消、Bot Sleep、get/list、原 Wait 和恢复共同消费原 Operation。关闭仅证明自己的接入 listener/streams 排空，不能证明目标服务进程已退出。旧 Host epoch 不可证明停止时保留 Unknown，也不偷偷重新打开替代转发。

## 整合中修复的实际问题

- 尚未入表的异步 watch 打开曾可能晚于 release ACK。现 release 使该 generation 失效并等原 flight，借用既有 handle 的 resume 不会误关其他订阅。
- 仅退休最后已知 caller 会遗漏同 key 并发 bind 丢回包的 caller。原 source-read scope 的关闭 fence 统一覆盖这些 caller；命令在 bind 前已保存，可发现和取消未知受理。
- Bot 删除曾可能先删定义，再发现 B 不能释放；现先锁外排空，再在原删除事务核未释放事实，失败保留完整地址。相关登记/取消命令 root 也随原 scope 删除。
- 一条转发慢关闭曾串行阻塞别的 owner 排空；现只按 operation 串行，同域独立 owner 并行。Host dispose 先同步关闭准入，仍完成途中 target resolution 和真实监听排空。
- 终态已提交但响应丢失时，转发原 owner 的短 stopped receipt 曾无法回收。现读取原 Operation 的匹配终态/停止证据后释放，不把空 pending 列表当停止证明。
- 实际 Rust `LateReceipt::apply` 要求 JobAccepted 全体等于原 canonical acceptance。曾经用当前可变 view 重建恢复响应、或在 accept 后取消夹缝改变返回正文，会被真实消费者拒绝。现正常路径持有同一 immutable body，恢复用锁外 `runtime.host_job.acceptance` 读取原 `acceptance_ref`；历史 Unknown completion 与后来 terminal result 均不能冒充该正文。

## 验证记录

当前格式为 Catalog **67**、Storage **17**、wire **27**；旧内部格式直接拒绝，不增加迁移/兼容分支。当前已取得的有限证据：

- 文件 User consumer 与调度 consumer 的受控用例通过，涵盖真实入口调用、未知 key、原 B owner 隔离及固定来源停止轮询；不等同于真实 B Storage。
- 转发 15 项受控行为测试通过；独审另外使用原 listener owner、Job adapter、实际 Bot `stopScope`，8 场景/10 判据通过。它们覆盖准入/排空、历史 Run 与无关 Job 隔离、原 acceptance 精确相等，不执行实际 socket。
- 新 builtin 已由原 TypeScript 和打包脚本构建。共享 Rust `cargo check -p varin-kernel --tests`、完整 Host production/tests `tsc --noEmit`、生成合同检查与文档本地链接检查通过。类型检查发现的新增窄化/fixture 形状错误已修，没有放宽 compiler。
- 原 Documents owner 的独立 pending-open/release 探针通过：release 不早 ACK，晚到分配被关闭，未残留 watcher。
- `managed_file_followup_original_catalog_storage_documents_and_lost_accept` 已通过：实际 User consumer、A Catalog、B Storage/Documents 和 direct Router 沿原 stdio 组合。丢首次 accept 后保原基线；相同 key、关闭 scope、未变化不哈希、暂停、watch reset gap、取消和未收养 scope 回收共同执行。watch reset 不是 Storage 重开，不据此冒称跨进程恢复实测。
- `environment_forward_canonical_acceptance_survives_unknown_and_terminal_host_receipts` 已通过：真实 Catalog 冻结调用拒绝伪 service port，历史 Unknown 后接受 Job，终态后原 acceptance 仍为原字节；真实 `LateReceipt::apply` 拒绝重建 stopped view、接受原 canonical completion，且不篡改历史 Unknown。
- 最终 6 个精确 native 用例通过。扩充上述文件组合接实际 FrozenToolContext/SelectedCall 的 `follow_up` 授权与执行，缺少选定工具时拒绝；Bot 删除首次 B 失联保留原地址，重试成功后清理登记/取消命令内容 root。另覆盖原 Storage 重开、固定 persistent pin 撤权释放、guardian 结束但目标文件不再改变时的 readiness，以及本地同 key/revoke 路径。没有把 SelectedCall 执行说成完整 PolicyEngine。日志中的 corrupt receipt 来自明确注入的另一损坏回执，用例仍核真实撤权与健康 pin 的收尾。
- 独立撤权探针检查生产 Documents owner 的已打开和正在 validation 中的两个 watch，均关闭且不允许同 receipt 晚到重开。它不将异步 revoke 通知宣称为同步 release ACK。

原通用 `bind` 仍先 issue grant 再 open source authority。若 B 恰在两次 RPC 间退出，可能留下未关联的短 grant 元数据；该窗口尚未创建 pin、watch、物化目录或进程，重启后原 Host generation/kernel epoch 不能执行。这里没有将其声称为已回收，也不把它当作已接受资源丢失；原 grant/authority 的原子受理是后续有界收敛项。

复跑入口为 `managed_source_review.rs` 与原 `managed-source-host.test-helper.ts`、`file-observation-service.smoke.test.ts`、`followup-source.smoke.test.ts`、`environment-forward-runtime.test.ts` 和原 forward owner 测试。执行前独立读 imports、hooks、constructor 与实际 transport；不能直接运行会启动默认 KernelClient、HTTP/Unix listener 的邻近测试。

真实网络/双机身份、OS socket 字节与排空、安装及平台长期行为未由这些受控测试证明。managed PTY、持久脚本、跨 Host 文件恢复和其余项目消费者仍有后续工作；两设计整体、产品切换和用户资产迁移均未在本片宣称完成。
