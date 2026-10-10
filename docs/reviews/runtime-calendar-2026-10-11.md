# 日历定义、实际发生项与执行交接验收

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`ab0e111653771ded696bfb2181eb6c56e67a02c1`。
本切片实现逐定义原生日历及真实消费者；两份设计整体仍在实施。用户先验收，再负责默认切换、Pi 删除与资产全面迁移。

## 一份资产与原执行 owner

GUI 定义仍在原项目配置，Markdown 仍在 canonical `.agents/loops/*.md`，显式 `runtime: agent` 才交原生 owner。Catalog **33**、input **6**、collaboration **7** 保存定义世代、UTC 时槽、游标和发生项；ContentStore 保存原指令/受理正文。旧内部格式拒绝。`catalog_calendar` 共用 `catalog_ingress`、`catalog_activation` 和原 native absolute-deadline worker，不加 Host 日历 timer、原生执行队列或第二个 Run/Goal 状态机。

once/daily/weekly/cron 规则带显式 IANA 时区和 skip/coalesce_once。默认一次逾期补一次、循环离线未观察时槽跳过；在线迟到在 following slot 前仍保原实际时槽。cursor 不因时钟回拨倒退。once 重叠墙时明确取首个 UTC instant，daily/weekly 保留两个真实 fold 时刻；cron `H` 所有方向使用同 definition/generation seed。native timer 的 signed-i64 纳秒范围是实际校验依据，没有沿用 Pi 的五秒 jitter/slack 作为新限制。

受理发生项、绑定执行和实际历史交付各自保留。冷目标先有真实 Thread，再由原 Host source/model/context/skill owner 锁外准备；原事务一起受理 Run、Environment input 和可选 Goal。既有目标沿原项目/ContextScope、最新实际模型/来源、Goal 和 child 固定 WorkingResult，未伪造 User、前轮 Run 或旧 dispatch。零预算沿原 Goal 边界阻止第一次推理。原 Run/Goal 生命周期决定非重叠，paused/waiting/budget-blocked 仍占据自己的工作。

禁用保持未交付 scheduled 项，显式 Run-now 有自己的稳定 key；删除/语义替换取消未消费旧发生项，不删既有工作成果。Run/tree stop 撤当时已受理输入，未来规则仍保留。取消已交付或结束发生项返回原事实；真实 Run 控制通过它自己的身份执行。Catalog 重开后先要求外部资产复核，同一 sync 不重置世代或一次消费。

## 外部资产和跨 owner 交接

原 shared application-client、认证 routes、GUI create/edit/run/status、Markdown CAS 和 ordinary SDK installed broker 示例均已接线。Run-now 返回受理发生项，不报执行成功，不把原生 ID 装进 Pi sessionId。实际结果通过原 ThreadConversation/Run/Goal 导航。一次手动重试保原 key；坏响应不变成成功空列表。

原配置读取以前忽略坏 task，可被解释为空扫描并删除 native 定义；现明确失败。坏 Markdown 保 last-good 并设 asset_invalid hold。独立项目逐一推进、完成 watcher 发现，再报告失败集合，不能因第一个坏文件使健康项目从未同步。

同一次日历意图切执行 owner 不等价 Run-now。原资产 owner 管理短 onceAcceptance；Pi 的原 lastRunAt 只证明受理，不证明成功。scheduledAtMs 描述被消费的 native once 目标时槽，不假称恢复了旧 Pi 的歧义 offset。Agent→Pi 先持久保存原 definition/generation 引用，native 停止新的受理后查原 generation 最后发生项，再持久接续该接受事实；这覆盖“初次读取后、tombstone 前”的迟到受理。交接中崩溃保留原 pending 引用，未完成不能启动 Pi。调用者不能伪造 managed 字段，真实语义更改清原交接证据，独立手动调用仍可执行。没有造假 native occurrence、Run 或成功结果。

Pi 的开始、session-created 和终态写回均在原资产锁内核准确执行意图及 acceptedAt。原 once 消费与状态结算合为一次原文件写入，旧 Pi 晚结果不能取最新任意定义再禁用它。冷 native 准入后，生命周期转交原 Run preparation；原 occurrence preparation signal 退出不能再取消新 Run。

## 独立审查及实际证据

独审先从设计形成验收，再检查冻结源码。确认并复核六个实际问题：DST once 依赖 ambient season、cron H 重抽随机时槽、坏项目阻断健康启动、跨 owner once 重放、native 零预算误拒、旧 Pi 晚终态禁用新定义。最后四个保存的红探针中，H、项目隔离、零预算、旧 Pi 结算均以同源码修后转绿。DST 的原红是保存的 inline 结果，断言文件首次执行时已修复，不声称同文件红绿。跨 owner 重放以实际资产/时序与 owner 代码确认，修后另以真实 Catalog 探针验证。

最终准确 rlib 上，两支原 native 探针不改源码通过：生产算时→真实发生项→冷 Thread/Run/Environment 历史→真实 GC→重开/同 sync 不重放，以及真实短暂停机跨 cron slot、在线迟到/skip、现有活 Run 取消自己的输入、原工作完成后的唯一 successor。独立 handoff 探针验证只消费 cursor、无伪执行事实、重开保留、手动与新语义独立。源码与模型准备部分是明确 fixture，未将其拼成完整 provider/IPC 证据。独审本范围无剩余已确认行为阻断。

最终 runtime **391 passed / 0 failed / 2 ignored**，kernel lib **91 passed / 0 failed / 11 ignored**，workspace all-targets 通过。冷实际 Engine 验证原 Environment 输入/主上下文进入 RequestSnapshot、原 Goal 实际 usage；显式 skill 经 compaction/GC 后仍由原 resource_read 读取；零预算无 model step 或 provider 调用。Linux 原 timerfd deadline 真实唤醒受理一个冷发生项。

Portable Host **12 files / 89 passed**，UI **4 files / 40 passed**；旧 Pi 晚结果回归补入 owning asset suite 后该 4 项再次通过。SDK 示例确实安装、授权并通过原 broker/retained lease 执行；项目文件 owner 真实，native management/calendar port 明确为 fixture。协议生成、Host 全测试类型、UI 类型、变更 lint 和实际 Host bundle（527 reachable / 72 excluded）通过。

同源码 Linux x64 开发 binary 以 identity `0.9.25` 构建及 schema3 manifest/ELF staging，SHA-256 `742ba7e4ab7c5ea322ee4728b975a175b40bb8840b7ea37390db7e48e913f9bc`。251 项构建输入在构建前后逐项一致。准确 binary 上原 guardian/Storage **3/3** 单独通过：真实 child 停止/WorkingResult，以及两条原进程/接续/输出/grant 链。它们属于原 ignored 项的显式运行，不表示其余 ignored 运行过。

完整 Host calendar GUI→IPC→真实 source/context/model→历史→重开的入口已补并类型检查，当前未执行；物理休眠、操作系统时钟变化、Windows/macOS 和真实付费 provider 也没有新增实机证据。

## 验收入口与复跑

GUI 的 Scheduled Tasks 中选择 Agent calendar；新增定义默认禁用，选择实际注册模型、source mode 或准确 existing Thread/branch 后保存。Run now 查看返回发生项，再用 View work 进入原 Thread。Markdown 和普通扩展示例参见[领域说明](../../packages/web/application-host/lib/scheduled-tasks/DOCUMENTATION.md)与[SDK 示例](../../examples/extensions/scheduled-task-tool/README.md)。这些是能力验收入口，不改变默认 runtime。

按[开发指南](../development.md)准备锁定工具链，在仓库根执行：

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib catalog::calendar::tests -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test delegated_continuation_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib native_calendar -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/scheduled-tasks/calendar-owner.test.ts \
  application-host/lib/scheduled-tasks/calendar-routes.test.ts application-host/lib/scheduled-tasks/recurrence.test.ts \
  application-host/lib/kernel/schedule-tool-owner.test.ts application-host/lib/kernel/thread-skill-adapter.test.ts)
(cd packages/ui && bun x vitest run src/components/session/CalendarTaskStatus.behavior.test.tsx)
```

guardian 使用 `VARIN_TEST_KERNEL_EXECUTABLE` 指向同源码准确 identity executable，运行 `actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results` 与 `agent_runtime::followup_process_review` 的原 ignored 用例。支持原 Host IPC 的环境可运行 `context-composition-review.native.test.ts` 中 `calendar GUI assets reach original source/model/context owners, consume a genuine cold Environment input and survive same-key restart`。更广事件条件、其他领域与两设计最终验收继续推进。
