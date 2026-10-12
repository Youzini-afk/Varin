# Bot 产品入口、原记忆与摘要准备

状态：功能整合与所列定向验证通过；基线 `514edfcae204124211ad240095cbf14df530f522`。
本记录仅列已核实的合同和证据。默认 Pi、用户既有资产及验收后全面迁移的分工保持。

## 功能与权威

- [运行时设计](../design/agent-runtime-design.md) §5、§13.2–13.3、§24 要求 Bot 的独立身份、原记忆、
  角色化上下文及可恢复长期工作；[环境设计](../design/execution-environment-design.md) §9.1 要求实际
  执行停止、保留成果和等待、诚实处理共享机器及未知状态。
- BotProfile 的 `entry` 直接区分 Pi session 与 Agent Thread/branch。明确新建 Agent Bot 才准入新身份；
  设置不能暗中切 runtime。配置、默认模型、工作列表和导航沿原 application-client/Host/共享 UI，
  Electron 继续复用 Host。普通会话列表按 Catalog 的实际 Bot 归属排除对应工作。
- native 历史来源来自原 ContentStore；Catalog 验 Bot/Thread/branch/ancestor，worker 读正文。来源的
  Thread/item 是身份，branch/head 是读取见证。UI 和 Host 共用文本投影与 UTF-16 范围，不用 Markdown
  显示偏移、Pi 假会话或文件目录代替身份。
- Bot/user/current-Thread 记忆仍由原 MemoryService/Knowledge 管理。实际 mutation 与其精确 origin、
  intent 和结果同事务持久化；Catalog 只保原执行事实和请求投影。主/子 Thread 不互借本地记忆。
  已提交回执可在观察者取消或 Sleep 后对账；新写入仍受原准入和取消约束。
- Sleep 贯穿原 Run、后台 MemoryWork、Host preparation/domain promise、script 和每个原 Computer
  execution。Rust worker join、原执行器未确认停止、未知效果与模型请求分别保留。共享机器不会被整体
  误停，也不免除当前 Bot 精确释放输入的责任。Wake 沿原 continuation 和 launch 检查。
- 删除先完成同一 Sleep。Catalog 事务只删除 Bot 原关系图；真实外部引用和环境持有会阻止删除。
  原 sleep work 引用支持知识存储清理重试，不删除工作区、Git 或其他 owner 的资产。
- Plan 沿原 PlanView 与用户 Knowledge store，实际 Catalog Bot 关联决定身份，不能仅凭 `mode: bot`
  声明取得能力。source read-only 只约束文件源，已选择的 Plan/notes 修改仍按真实领域准入执行。
  Plan 原历史与 mutation receipts 沿现有用户 store 保留；Bot 删除不代表已清除该 store 的全部历史。

Catalog **65**、私有 wire **24**；旧内部形状直接拒绝并保留资产，没有兼容 reader 或数据迁移器。

## 并行摘要调度

[harness-context §8.4.1–4](../design/harness-context.md#841-一份历史一个固定候选与持续追加的原文) 是既有合同的 native 接入：
首次按可配置准备水位，同 branch/配置的实际摘要耗时和近期输入增长只调整准备提前量。没有样本时保留
默认准备行为，不把缺失视为实测零耗时。默认原文保留规划考虑整个 P/S1/B/N 输入，而非只给 B 分配比例。

候选完成只变为可用；自动请求需要空间时，重新编译实际 S1/B/N，经原 provider 序列化估计后再
提交原 checkpoint CAS。完整输入仍装不下时保留原历史和已完成候选，返回可操作错误；不裁去未经摘要
覆盖的原文、不自动重付费。原 summary Run/receipt、Goal 和费用归属不因后继前台 Run 复用候选而改变。

Bot 的实际记忆状态随原 ContextJob 配方冻结到 ContentStore，checkpoint 通过原 manifest dependency
持有该快照。只有原候选发布 CAS 成功才推进记忆基线；后续请求与候选预览使用同一差量读取，
已摘要的未变记忆不重复加入，迟到的更正与遗忘仍按原事实进入后续请求。

## 当前证据

- 原 consumer 分批运行的 24 项通过覆盖 client、直接认证 Router、Bot 设置/主入口/工作导航、原选段和
  Sleep 只读视图；其最后源码静态检查通过。它们不是完整业务 Host 启动或一次最终全套运行。
- 独立审查复现共享 Computer 的旁路释放早退。修复后，真实 BotService→原 lifecycle→ComputerAutomation
  在 pending release 时保持 sleeping；失败为 sleep-failed，明确重试拿到原停止证据后才 asleep。
  并发 finish 加入同一原释放；冷启动物理 marker 也要求原 driver 证明，其他观察者和共享机器保留。
- 独立实际 MemoryService→Knowledge Node IPC 复现同一记忆被 A/B 记住后 A 关联丢失。修复读取原 spans，
  A/B 均可召回。纠正再遗忘的原失败链也已修复；三个真实知识状态进入 Rust ExecutionEngine 的最终
  RequestSnapshot，保留遗忘事实而不再携带被遗忘正文。
- 已提交 remember 回执在调用者预先取消时仍从原 Knowledge 对账；forget 在明确尚未进入写入时取消，
  原 row 未退役。模型 provider 使用受控结果，这些证据不评价实际模型质量或费用。
- Bot 配置改模型后，取消 Run 的下一草稿确实以新模型 submit；用户随后在对话里的手选不会被普通刷新
  覆盖。主入口重新读取 Host 配置，child 不继承该偏好，Sleep 页面不因查询模型启动入口。
- 摘要原 ContextService 的主/子候选完成、checkpoint 保持、跨 Run 复用和耗时身份隔离通过；原 ContextJob
  成功/失败/取消/非法工具结果、Goal 归属、重复受理/重开及完成唤醒后继请求的增量通过。
- 原摘要 stdio 三条组合实际运行：usage/Goal、child 作用域，以及 completed candidate 在重开后的当前
  Decision→同 serializer 完整预览→CAS→后续模型请求。最后一条全程固定受理时配置，summary 仅一次。
  旧 fixture 输入预算 4384 tokens 小于当前 14 个工具 schema 的约 5437 tokens，因而正确拒绝发布；
  该负向现场保留。正向从受理前使用 7384 输入预算，未中途撤路由、放宽配置或换 key。
- 实际 Host Wake 的新增原 stdio 单例经过 BotService→lifecycle→Rust scope→ThreadAdapter；手动 Pause
  和未触发 Wait 保持原 waitId、Waiting 与 launch gate，没有模型绑定或自动启动。
- 原 Plan owner/Knowledge/Node IPC 的 10 个增量场景通过。受理前取消和原精确 stale-selection 拒绝保留
  未写入证明，进入 transaction 后的未知保持未知；原持久 receipt 优先。原 Policy origin 经过存储后
  对象键序变化不再被误判为另一次调用，nested-call 原身份也保持。
- 原 ThreadCollaboration 的定向 Sleep join→Delete release 失败保留/重试通过，其他 Thread 隔离保持。
- 新 Bot 产品原 stdio 链通过：BotService create/ensureEntry→ThreadAdapter submit→完整 RunAssembly→
  Bot 声明/上下文→MemoryService/Knowledge remember/get/correct/forget→六次实际 RequestSnapshot。
  跨 Bot 秘密未进入请求；模型 provider 受控，原知识数据库及进程通道实际执行。
- 原 Plan 的三个 Rust 场景通过：真实 Bot child 两 origin 与 CAS、真实 Bot/Agent/非所属范围准入，
  以及 executorStopped/未知效果分离。Rust 场景的领域回复受控；它与真实 Host owner/Knowledge IPC 的
  场景分别提供证据，不把两者合称一条完整 Rust→Host→数据库 Plan 验收。
- 最后 Host production declaration、Host tests 类型与 Web 聚合 `tsc --noEmit` 通过；共享 UI 复用同版
  完整类型结果。文档本地链接与 `git diff --check` 通过；这些静态结果不替代业务运行。

- Bot 记忆摘要原组合单例最终通过；两次 collection 均精确断言 `Completed`。原冻结内容、更正/遗忘、
  未变记忆差分及 preview=publication 均在该例中检查，不把 deferred collection 算成 GC 完成。

最终 `cargo build --offline --manifest-path kernel/Cargo.toml -p varin-kernel` 成功，产出本片
`kernel/target/debug/varin-kernel`；构建产物未作为产品监听服务启动。
本轮没有运行产品 HTTP/Unix listener、真实模型账号/ONNX 权重、实际桌面/VM 或全平台安装验收。

## 定向复跑

在仓库根、锁定工具链和依赖就绪后使用原入口；不要把下列有限选择换成完整 listener-bearing 套件：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib product_bot_entry_admission_original_history_knowledge_tools_and_actual_model_requests -- --test-threads=1 --nocapture
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib product_bot_wake_keeps_manual_pause_and_untriggered_wait_at_the_original_host_launch_gate -- --test-threads=1 --nocapture
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib bot_child_plan_keeps_actual_identity_and_source_permissions_for_both_origins -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib bot_plan_reconcile_separates_stopped_executor_from_unknown_effect -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib plan_scope_rejects_role_only_bot_foreign_and_missing_admissions -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test context_job_review bot_summary_freezes_original_knowledge_and_publishes_only_its_baseline_with_gc -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib selected_budget_freezes_summary_and_recovers_original_publication_without_paid_replay -- --ignored --test-threads=1 --nocapture
```

Host 小域案例分别在 `kernel/bot-memory-owner.test.ts`、`knowledge/plan-owner-review.test.ts`、
`memory/memory-work-association.test.ts`、`computer/computer-automation.test.ts` 和
`kernel/thread-collaboration.test.ts`；直接 Router 案例在 `bots/bot-routes.test.ts`，共享 UI 行为在
BotWorkspaceShell、BotSettings、ThreadConversation 和 ThreadMemorySelection 的对应测试。
每份测试仍按其依赖、入口与本次所选行为判断证据，不从文件名推断外部平台可运行。
