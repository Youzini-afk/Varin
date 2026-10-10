# 一次时间/进程续接与原执行来源验收

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`5030af427b4644ea0e1c499f107f73c5165ce4d2`。
本切片覆盖普通一次 follow-up、真实输入投递与 root/child 接续。日历重复规则、其他事件条件及两份设计剩余领域继续实施。

## 唯一事实与调用合同

普通 `follow_up` **版本1** 在真实 ModelStep 和 PolicyAction 上支持 register/list/get/control。注册保存原指令及绝对 `at` 毫秒时刻，或真实原 `process_spawn` 的 `process_stopped` 条件。实际调用确定 actor、Thread/branch、Operation 和 ToolOrigin，没有 Agent 可填写的伪 User 身份。User 路由另有自己的稳定 key/source Run，不接受工具专属 wait。注册意图、instruction 和实际工具结果正文由 ContentStore 保存，Catalog 事务只提交短引用及回执。list/control 不加载正文，get 按需读取原指令。

无 wait 的注册立即返回原 Result；显式 `wait: {}` 才受理独立 Job/Operation/Wait，加入原 child/process/reply 观察屏障。取消观察保留已确认登记，不撤定义、不杀进程。原受理回执和实际观察交付各自保留，不伪造新的模型工具结果。0 或已经过去的绝对时刻只触发一次，重开或重试不改时刻。Catalog **32**、input **5**、collaboration **6**；旧内部格式拒绝。

原 native continuation worker 使用同一个实际绝对期限源。先提交到期短事实，再加载正文和推进执行；已观察但暂停/受阻的 occurrence 退出最近未触发期限查询，以实际控制/来源事件推进，不保留到期忙转或 Host timer。真实进程的停止依赖原 executor_stopped 证据，业务终态/Unknown/空占用不能替代。登记时重查已有事实，避免先停止后登记丢失唤醒。

## 受理、激活和实际交付

发生项原子登记一个 typed Followup input，复用原 input_queue、ContentStore 和历史。其 provenance 为真实环境事实，保留原注册方、指令、触发证据及 IDs，不伪装 User 或提升级别。活动合法 Run 在原边界消费；空闲 root 依当前真实前轮配置/来源/上下文建立新 Run；空闲 child 经原 delegated execution 和固定 WorkingResult 建立新执行及新 Run。普通 User 输入和发生项共享原子绑定，不能出现两个 branch writer。

消息请求和 follow-up 共用 `catalog_activation`。`ingress.run_ready` 是空闲 root 的唯一当前启动事件，Host 原 durable-cursor/startup pump 交给同一 `continueLaunch`；child 仍由原 execution discovery 准备。整合时将两个真实消费者测试改为这个实际事件，online 启动及启动扫描期间的 admission 均先失败：Host 仍只识别旧的两种事件名。修复只更新该消费者并删除旧分支，两条原反例及 owning suite 随后通过，无第二启动入口或兼容事件。

绑定与交付分开。Bound 但 queued 的发生项仍可暂停/取消，只有原历史实际接受才 consumed。取消定义不取消共享 Run 或观察对象；delivered 后的控制返回原事实，Run 有自己的取消身份。Stop 取消当时已受理集合；Stop 之后、旧 worker 最终终止之前新受理的明确 User 意图不会被旧终态追溯取消。manual Pause、question、Goal 暂停/预算/未知用量保持原守卫。同 ContextScope 的指令/历史刷新可继续；不同来源、项目/角色/会话等变化仍 held。

同一当前 Goal generation 下，明确 At 发生项允许对原 Dependency 做一次真实检查，保留该阻塞和原进程订阅。其他阻塞及暂停/取消/完成/预算没有被绕过。新的 goal_report/control generation 立即使旧检查授权失效；检查结束不形成自动轮询链。自动 Goal 定义和明确 User/Agent 定义的 actor 分开，UI 不因 goal_id 存在而隐藏独立意图。

## 原进程结果与正常来源退役

真实 root At 新 Run 可在同 Thread/branch/source、合法 Thread/Environment lifetime 和当前只读 capability 下读取原长进程。该新 Run 也能以自己的真实 ToolOrigin 登记原进程停止 follow-up，process 的执行权、JobAccepted 和原 Run 不变；不会要求假装成最初 Run。`wait_process` 与交互写入/resize 保持原权限边界。

实际 child 接续会换到固定 WorkingResult 的新物理来源。原 Host 在 child 终态清理时直接 revoke 创建 grant，且仅依赖临时 grant map，因而原 spool 在合法后继 Run 也永久不可读。修复沿原 Storage grant owner 引入单一 **Active/Retired/Revoked** 状态，Storage format **11**。正常 retirement 先确认原进程实际停止，关闭旧 caller/订阅/受理权限但保留创建 provenance；不能靠杀进程或 Unknown 制造停止证明。精确 grant 或 Host/Run selector 查询原持久 grant，Host 重开不依赖旧 map。显式 revoke 不能被以后 retire 降级，inactive ID 也不能重发复活。Storage 外层格式标记与 schema 同为 11；移除旧的自动清库重建分支，格式/表验证前不清理 staging stream，拒旧保留原证据。

Catalog 从每一原 delegated predecessor、source_basis 和真实 WorkingResult 导出临时强类型 lineage。Storage 同时核对当前及原 grant、path scopes、workspace/Host、当前物理 root、原创建相对 cwd 和实际 stopped spool。原物理目录已被合法清理时仍可读其原输出。没有新增 follow-up ACL、旧 root 名单或通用绕过开关；旧文件、stdin、resize、kill 与任意兄弟进程不由此获得权限。

## 独立反例与范围收口

独审在实现前按设计形成验收。其原反例复现：child 原进程业务结果为 Indeterminate/Unknown，但 executor_stopped 已确认、原写者已停止、WorkingResult 已固定 Published；明确登记的 ProcessStopped 已 Observed，却因新加的“source/current 任一 Unknown”全局谓词永远 Held，无法进入原后继执行。同一原已停/固定事实的明确 At 也独立复现相同阻断。两条反例使用实际 Catalog/ContentStore/dispatch/result 合同，并不冒充物理 guardian 测试。

该谓词没有独立失败依据，重复解释了业务结果与来源稳定性。修复删除它及两处调用，不增加 ProcessStopped 豁免名单。真实未停 writer、原 occupancy、child fixed-source、Run/Goal 的已有守卫保持；原 Unknown/Indeterminate 不重写，原效果不重放。自动 Goal 自主续接的未知效果/用量屏障与明确登记意图保持区分。原 At 重开用例也去掉为迁就该错误门槛而加的人工停止前提，核对原未知事实仍在。两份独立原红源码 SHA 保持不变，修后均转绿。

## 验证状态

最终同源完整 runtime **368 passed / 0 failed / 2 ignored**，kernel lib **89 passed / 0 failed / 11 ignored**，workspace all-targets 通过。独审在修后准确 rlib 上复验六条原独立链及两条不改源码的红反例，全部通过；已测范围无剩余确认阻断。171 项原生生产与 13 项 Host/protocol/UI 生产清单均逐项一致。两原红 probe 保留原 SHA，后继使用原 delegated owner 和同一固定 root，原 Unknown/Indeterminate 未被重写。

最终 Linux x64 开发 executable 以 identity `0.9.25`、target `x86_64-unknown-linux-gnu`、arch `x64` 构建并通过 ELF/manifest schema3 staging，SHA-256 `014cfeaa20f228dffb0843f7928786ed70cf6996c9397e90bbb37fcd12379db4`。235 项完整构建输入在构建前后逐项一致。该 staged executable 的原 guardian/Storage 三个场景单独 **3/3**：真实 stdin 原回执回归；root At 在原进程仍运行时读取原输出、后继真实 ModelStep 再登记原进程停止并继续；child 原进程真实停止、发布 WorkingResult、正常退休、删除旧物理目录后原 spool 仍可读，显式 revoke 加晚 retire 仍拒绝。这是普通 suite 中三个 ignored 场景的显式执行，不表示其余 ignored 已运行。

Portable Host 7 个 owning suites **40/40**，UI 原 follow-up/消息/投影 **39/39**。真实 HTTP/client/Adapter、正常退役、当前事件/startup consumer 和组件交互已执行，底层部分 RPC/资源 port 为明确 fixture。原 Host 事件反例两项先红后绿；不能把这些组件证据拼成完整 IPC 通过。生成协议、Host 生产及完整测试类型、UI 类型、变更 lint、文档链接、实际 Host bundle（524 reachable / 72 excluded）通过。

完整 Host 用例扩为 process_stopped/At 两种实际注册：原长进程、Host pump 停止、native 准入、冷 Host 准备及原输出读取；已类型检查，当前环境未运行。Windows/macOS 计时及实际休眠/时钟变化仍无新增实机执行证据。

## 复跑入口

使用[开发指南](../development.md)锁定工具链，在仓库根运行：

```bash
export RUSTUP_TOOLCHAIN=1.97.1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test followup_continuation -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test goal_lifecycle -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib explicit_followup_uses_both_real_origins_and_separates_registration_from_wait -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib native_followup_instant_delivers_original_wait_and_one_active_ingress_without_host_polling -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/kernel/thread-followups.test.ts \
  application-host/lib/kernel/thread-continuation.test.ts application-host/lib/kernel/child-continuation-host.test.ts \
  application-host/lib/kernel/request-credit.test.ts application-host/lib/kernel/child-profiles.test.ts \
  application-host/lib/kernel/policy-child.test.ts application-host/lib/kernel/mcp-child-preparation.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx \
  src/components/thread/ThreadMessages.behavior.test.tsx src/lib/agent-runtime/thread-projection.test.ts)
```

真实 guardian 设置 `VARIN_TEST_KERNEL_EXECUTABLE` 为同源码、准确 build identity executable 的绝对路径，再执行原 ignored `agent_runtime::followup_process_review::{process_followup_reads_real_original_output_and_rechecks_both_grants,native_input_uses_original_model_intent_and_guardian_receipt_then_reads_same_process}` 和 `agent_runtime::child_process_review::actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results`。它们实际运行 guardian/Storage/Catalog，不调用付费模型。

支持原 Host IPC 的环境可运行 `process-wait-review.native.test.ts` 中 `admits one %s follow-up without the Host pump, then cold-prepares and reads the original long-lived process output`。最终默认 runtime 切换、Pi 删除及用户资产全面迁移仍由用户验收后负责。
