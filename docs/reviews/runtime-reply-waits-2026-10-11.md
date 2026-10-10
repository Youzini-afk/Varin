# 关联回复、实际期限与共同观察屏障验收

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`9907bd21594c33a7dc74a76756854043b9cd1e41`。
本切片交付普通 `send(wait)`、持久实际期限及 child/process/reply 的共同观察消费。通用事件/日历及其他设计领域继续实施。

## 单一事实与真实消费者

`send` **版本3** 在实际 ModelStep 和 PolicyAction 上支持可选 `wait`：不传保持原 Result；`{}` 无期限；`{timeoutMs:n}` 在第一次受理时固定绝对到期时间，0 表示立即到期。原消息、Confirmed 发送效果、原 JobAccepted、Operation 和 Wait 同事务提交。调用受理与观察结束各自保留，取消观察不撤消息、不杀接收方，也不把已发送效果改成 None。普通公开 User 消息入口没有执行观察 owner，继续拒绝这个工具专属字段。

只有原 reverse-peer/branch 且 replyTo 精确关联的已受理回复能满足等待。公开 `acceptedAtMs` 来自原命令回执；严格早于截止时刻的真实受理回复获胜，截止时刻及之后的回复保留为迟到消息，即使 timer 尚未调度。重开先追认原 eligible event，再判断到期；相同原调用重试不刷新期限，已经提交的触发不会被取消或时钟回拨重写。Catalog **31**、input domain **4**、collaboration domain **5**，旧内部格式直接拒绝。

原 `catalog::observations` 同时选择 child/process/reply。已就绪观察可以独立交付，仍有未就绪观察则 Run 继续停车；所有原 JobAccepted/graph receipt 已消费、全部观察结算后才允许模型继续。单个 ObservationPolicy 替代分立 child/process wrapper；真实 question、manual Pause、Goal 授权仍由原 owner 决定。合法新输入结束相关观察，已有成功触发保留。Run 终止关闭剩余观察，但不能据此声称事实已经进入历史。

回复正文只经原 input_queue/ContentStore/history 进入一次。观察历史只含原 message/Wait/reply ID 和仍待回复的消息 ID，不复制正文、不制造 User 输入或第二份 ToolResult。公开 `replyWait` 的 waiting/replied/expired/cancelled、实际 Run/Operation、reply ID 与 delivered 均投影原事实；delivered 检查实际原历史记录。客户端、认证 route、Host 冷启动和 UI 同步消费。原 `runtime.observations.reconcile` 与 `observation.run_ready` 进入唯一 continueLaunch；移除旧分裂 reconciliation RPC。取消仍调用原 operation.cancel。

## 期限唤醒与故障隔离

原 native continuation worker 共用真实事件和最近持久期限，不为每个 Wait 开线程，也不增加 Host timer 或模型轮询。Linux 使用 eventfd/timerfd 的绝对 CLOCK_REALTIME 与 clock-change 通知；Windows 使用 event/absolute UTC waitable timer；macOS 使用 dispatch walltime。未请求唤醒已休眠电脑的权限。计时原语只发提示，最后结算仍由 Catalog 复核实际期限和原事件。

原实现曾把 Goal/followup 对账错误与期限共用一个 failed 标志，因而关闭另一正常 Wait 的未来 timer。整合时用真实 native worker 注入一个独立坏 followup 记录，正常回复 Wait 的完整事实不变，原用例在期限后未恢复而失败。最小修复先解析 Wait 短事实，再分别推进原域；已 triggered Wait 自然退出期限查询，各域只在错误边沿记录失败。原失败用例修后通过，没有周期重试或第二调度器。新共同选择器也只读取实际 waiting Run，避免每个事件在锁内反序列化全部历史 Run；不据此宣称固定延迟或性能倍率。

平台依据：[Linux timerfd](https://man7.org/linux/man-pages/man2/timerfd_settime.2.html)、[Windows SetWaitableTimer](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-setwaitabletimer)、[Apple dispatch clocks](https://developer.apple.com/library/archive/documentation/General/Conceptual/ConcurrencyProgrammingGuide/GCDWorkQueues/GCDWorkQueues.html)。这些来源支持 API 语义，不代替平台执行证据。未修改系统时钟；可控原事实验证前跳/后跳、登记前回复、截止相等和无期限。期限只受实际整数/native signed-nanosecond 可表示范围约束，没有任意 HTTP 超时或静默截断。

## 验证与独审

独审从设计先形成合同，再独立链接冻结的真实 runtime 和生产 send/ObservationPolicy/native wake。它进一步复现公共 child 报告门槛：一个未被观察的已完成 child，其报告正文不可读，会阻止无关正常 reply Wait 交付；真实 timer 已将其标为 Expired，但 Run 仍 Waiting、delivered=false。修复先在原 Supervisor 协调入口让各观察域与合法消息激活独立推进，并保留原失败。沿同一真实触发补查时，另一健康 child 的原报告/Wait 仍受全批报告加载门槛阻塞；据此在原 child owner 内逐项读取/提交，不补造报告、不重试正文或复制调度器。Host 同时保留 reconciliation RPC 的原错误，却继续发现已经持久提交的原 saved launch/event；原冷启动失败用例也已红转绿。原 child fail/settle/candidate/result 命令已提交自己的事实后，不再同步等待全 Catalog 报告对账才回 ACK；原 commit event 交给同一个 native continuation owner，具体命令自身的权限、事务和读取错误照常返回。

两个独立原失败探针源文保持不变，修后均通过；坏对象仍缺失、坏报告未伪造成功、原错误仍返回。独审七组原反例/基础检查通过，另一次同域消费增强验证健康报告恰入历史一次、真实 Engine 恰发一次最终模型请求并 Completed，之后不因重开/对账复活。两种原调用来源、三域混合、Stop 后晚回复、原 branch、期限和 GC 同时复核。最终原生生产、Host 生产及完整构建输入清单逐项一致；独审结论为已测范围内无剩余确认阻断。

最终同源完整 runtime 363 passed / 0 failed / 2 ignored。完整 kernel lib 85 passed / 0 failed / 11 ignored。两调用来源均经过真实 Engine：两条消息只回一条仍停，重开后第二回复触发同一原 Run 恢复到 Completed，实际 provider 只被调用一次，两回复正文各出现一次；ModelStep 保留两原 ToolResult，PolicyAction 不伪造 ToolResult，原 send 无重发。原 native drive + timerfd + Catalog/Supervisor 的到期和独立故障隔离实测通过。

Portable Host 十个 owning suites 70/70，ThreadConversation/ThreadMessages 37/37。实际客户端、认证路由、Adapter、恢复协调和 UI 通过；底层 RPC/部分资源 port 有明确 fixture。新的完整 Host 场景已类型检查但没有运行：两条原 send 观察、第一次回复后仍停车、关闭/重开 Host、重复旧回复幂等、第二回复后真实 child 模型只续一次并报告。当前环境仍缺这一实际 IPC 证据。

最终 Linux x64 开发 executable 以 identity `0.9.25`、target `x86_64-unknown-linux-gnu`、arch `x64` 构建并通过 ELF/manifest staging，SHA-256 `331794b89bd75dfc83ae7c5760066e435732e7087a9d56ae0a305f2387c1329d`。Fresh binary 的原 guardian/Storage → 子任务报告/真实停止 → 固定 WorkingResult 场景单独 **1/1**，是普通 suite 中一个 ignored 场景的显式执行，不表示其余 ignored 也运行。workspace all-targets、234 项构建输入前后 SHA、167 项原生生产冻结和 7 项 Host 生产冻结清单全部一致。Host/UI 类型、变更 lint、生成协议、文档链接及实际 Host bundle（524 reachable / 72 excluded）通过。UI 投影措辞改为中性“未交付”后，原 37 项中的 owning 6 项复跑通过，不重复相加。

## 复跑入口

使用[开发指南](../development.md)的锁定工具链，在仓库根运行：

```bash
export RUSTUP_TOOLCHAIN=1.97.1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib wait_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib continuation_wake -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib reply_deadline_short_facts -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test process_wait_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test message_request_review -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/kernel/thread-messages.test.ts \
  application-host/lib/kernel/thread-continuation.test.ts application-host/lib/kernel/child-continuation-host.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx \
  src/components/thread/ThreadMessages.behavior.test.tsx)
```

真实 guardian 场景设置 `VARIN_TEST_KERNEL_EXECUTABLE` 为同源码、准确 build identity 的 executable 绝对路径，运行 `cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib -- --ignored --exact agent_runtime::child_process_review::actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results --test-threads=1`。

支持原 Host IPC 的环境可用同源码/准确 build identity executable，运行 `child-dispatch-review.native.test.ts` 的 `two real send observations retain their original requests across Host restart and resume only after both linked replies`。Linux 实际 timer/guardian 与受控时间事实不能冒充 Windows/macOS 运行或休眠实机验收。

两份设计仍在实现。接下来闭合通用事件/时间续接与日历发生项，保留更广领域和最终组合验收。默认 runtime 切换、Pi 删除和用户资产全面迁移由用户验收后负责。
