# 定向请求与真实执行接续验收

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`451eb19773449b33357c68fc1f682dc082cf614e`。
本切片交付 `send(kind=request)` 的持久受理、活动输入边界及空闲 root/child 新 Run；关联回复 Wait、期限和通用多等待继续实施。

## 单一事实与真实消费者

`send` 版本 **2** 在普通 ModelStep 与 PolicyAction 上接受 inform/request，仍拒绝 `wait` 和期限字段。原消息 ID、真实 User/Agent 发送者、目标 branch、replyTo 与正文保持同一受理身份；重试只返回第一次回执。受理、投递、执行激活分别展示，inform 不单独唤醒模型。

原 `input_queue` 保存短激活事实，ContentStore 保存原消息正文，Run/Launch 拥有执行，`delegated_executions` 拥有 child 准备/逐轮报告/文件结果。没有第二个收件箱、Host 持久调度器或假 User 输入。Catalog **30**、input domain **4**、collaboration domain **5**，旧内部格式直接拒绝。

受理事务把请求绑定到当时可接收的实际活动 Run。尚在停止的 Run 不接收后来新请求；新意图保持 Pending，等真实终态后再准入。已绑定旧 Run 的请求取消后不会偷偷转成新工作。普通 User 提交、队列提升和 child 发布也在原事务内领取 Pending 请求，避免 Host 空闲预检与真实分支状态竞态。

空闲时原 thread-continuations worker 捕获短事实，在锁外读取原正文、来源与配置，再以 epoch/head/Run/Launch/checkpoint 修订核对提交。root 复用实际前轮 Launch 与现有配置 owner；child 的 MessageRequest 与显式 UserContinuation 共用新执行准备、精确前轮固定 WorkingResult、独立授权和报告消费。活跃写者仍是来源屏障；真实停止后已发布的固定 root 可以供后继使用，原 Unknown 效果保留。请求文本保持 Agent 消息来源，不因正文形似 `/skill` 获得用户显式 skill 激活。

手动策略 Pause、未答 question、Goal 暂停/预算不被请求覆盖。合法新请求可以结束原 child/process 观察等待，但不杀被观察对象。原完成事件先被 Wait owner 追认，已成功触发的结果保持成功；未完成观察通过原取消入口结算。多条原观察逐一到达合法历史边界后才恢复 Run，避免先吃请求再被另一条旧观察重新停车。失败激活保持明确投影，不制造无条件重试循环。

认证 HTTP、application-client、ThreadAdapter 与原 Host 冷启动协调使用相同原事实。新 root 的 `message.run_ready` 进入唯一 continueLaunch；child 由已有 execution 恢复扫描发现。共享界面支持明确 inform/request、稳定重试 key/kind/目标/正文、Pending/Bound/Cancelled/Failed 与实际 hold 原因、精确 Run/execution；idle 待准备请求也能由原 Stop task and children 取消。已受理正文和旧回执不因取消或激活失败消失。

## 独立失败探针与修复

独审在读实现前从设计建立验收合同，再用仓库外真实 Catalog/Supervisor 探针复现两个生产窗口：

- Stop 已提交但旧 Run 仍在退出，此后受理的新请求被错误绑定旧 Run 并取消。最小修复只让 closing Run 不再接受新绑定；Stop 前请求仍取消，Stop 后请求待真正终态后开不同新 Run。原失败探针修后通过，额外验证重试/重开只有一次绑定。
- 同 Run 的两条观察只取消第一条就崩溃，恢复因当前 Wait 已取消而跳过另一条 live 观察。最小修复幂等补齐原观察集合，并让原交付链处理 cancelled 或已 triggered 的观察。原失败探针修后通过；额外用真实成功 child 报告验证两条 Wait 都保持 Succeeded 和原 trigger cursor，报告只投一次，请求随后同 Run 投递。

原探针源未改，三项全部通过；补充探针包含上述原三项和两个正向区分，共五项通过，不能相加声称八个独立场景。修复未增加第二状态机、永久停止世代或效果重放。

## 已验证范围与边界

最终同源 runtime **360 passed / 0 failed / 2 ignored**；kernel 普通 lib **78 passed / 0 failed / 11 ignored**。实际 request 场景覆盖 root 受理竞态、精确配置/来源、重开、手动 Pause/question/Goal、原观察交付、child 请求新执行与 tree fence。Kernel 两种原调用来源均经过真实 Engine 的普通消息工具。

Portable Host 十个 owning suites **67/67**，共享 ThreadConversation/ThreadMessages **36/36**。这些测试使用实际客户端、认证 route、Adapter、启动协调与组件；底层 Kernel RPC/部分资源 port 是明确 fixture，不能替代完整 Host。扩展后的原 native Host 场景已经类型检查：实际 writable child 第一轮固定结果 → 接受 request 尚无新 Run 时关闭 Host → 修改父目录 → 重开原意图 → 第二轮读取原固定文件并产生独立结果/报告。当前环境没有运行该 IPC 场景。

同源 Linux x64 开发 executable 以 identity `0.9.25`、target `x86_64-unknown-linux-gnu`、arch `x64` 构建并经 ELF/manifest staging，SHA-256 `cef28138ae93cc84d6015384322abc94c2220cd57803c5063663b863d8ab3024`。Fresh binary 的真实 guardian/Storage 场景 **1/1**：Stop 取消先前请求，停止原子树两条实际 writer 且保留 sibling；固定 Published root 后，新请求经 MessageRequest 创建新 source/Run，原文件结果保留。这是普通 suite 中一个 ignored 场景的单独执行，不表示其余 ignored 场景也运行。

组合回归曾发现旧 Goal snapshot fixture 缺少上阶段新增的 `runtime.child.for_thread` RPC，导致一次 400；仅补正常无 child 的 null fixture 后十组全过，生产 Host 未因此修改。Host/UI 类型、变更 lint、生成协议一致性及实际 Host bundle（524 reachable / 72 excluded）通过。workspace all-targets 通过，228 项 Rust/Cargo/schema/构建脚本输入前后逐项 SHA 一致；Host 生产冻结清单也再次核验一致。

## 复跑入口

使用[开发指南](../development.md)的锁定工具链，在仓库根运行：

```bash
export RUSTUP_TOOLCHAIN=1.97.1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test message_request_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test delegated_continuation_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib child_messages_review -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/kernel/thread-messages.test.ts \
  application-host/lib/kernel/thread-continuation.test.ts application-host/lib/kernel/child-continuation-host.test.ts \
  application-host/lib/kernel/mcp-child-preparation.test.ts application-host/lib/kernel/tool-composition.test.ts \
  application-host/lib/kernel/policy-activation.test.ts application-host/lib/kernel/policy-child.test.ts \
  application-host/lib/kernel/thread-skill-adapter.test.ts application-host/lib/kernel/thread-goals.test.ts \
  application-host/lib/kernel/thread-family.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx \
  src/components/thread/ThreadMessages.behavior.test.tsx)
```

真实 guardian 场景另设 `VARIN_TEST_KERNEL_EXECUTABLE` 为同源码、准确 build identity 的可执行文件绝对路径，运行 `cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib -- --ignored --exact agent_runtime::child_process_review::actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results --test-threads=1`。

在支持原 Host IPC 的验收环境，另以同源码和准确 build identity 的 executable 运行原 `child-dispatch-review.native.test.ts` 中 `continues a completed writable child after Host restart` 的 MessageRequest 分支。两份设计仍继续实现；用户先验收再负责全面迁移和默认切换。
