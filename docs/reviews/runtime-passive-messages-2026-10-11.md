# 同任务被动消息与原输入投递验收

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`93cc9d260d0763eeccb49e01a2709a5a5987cd78`。
本切片交付 `inform` 与关联回复、真实发送者和持久被动投递。主动 request、关联 Wait/期限与已完成 child 新 Run 继续实施，未被降级成 inform。

## 原权威与实际行为

普通 `send` 版本 1 使用原 ToolDirectory、冻结 ModelStep 或 PolicyAction/node 和普通 effectful Operation。原 Catalog input_queue 同时拥有唯一消息和投递状态；ContentStore 保存不可变正文、原 command intent 与工具完成结果，在 worker stage 后再短事务提交引用。没有第二 inbox、消息执行账本或 TS 调度器。Catalog 格式 **28**、input domain **3** 直接拒绝旧内部格式。

发送使用明确目标 Thread/branch，或实际收到的 `replyTo`。回复固定回原发送方及其分支，额外目标不一致即拒绝；父、兄弟、后代授权来自真实 ChildTask 家系，无关任务不因共用目录获得权限。Agent 来自实际 Run/Operation/origin，用户入口永远 User，包括从 child UI 发消息。正文中的角色名称不能改变 actor。普通用户输入的 list/inspect/edit/cancel 不把消息投影成可编辑草稿。

未交付 inform 没有虚构接收 Run。空闲、等待或已结束的接收方不因此启动模型、结束 Wait 或恢复旧 Run。合法闭合边界投递到原历史，记录实际接收 `history.run_id`；typed batch 分别携带正文与 activating 事实。Passive 不改成 InputDelivered，不清除原策略决定，不 supersede 失败 ModelStep，不改变 Goal 授权，也不阻止正常 Complete。取消拒绝迟到 prepared delivery，已受理信息保留给同分支下次独立合法 Run。原显式授权的 Goal/process followup 只把 activating 输入视为新用户工作。

接受、交付到历史与实际处理分开。一次最终模型响应后的闭合边界可以提交收到的信息并正常完成，不为确认通知额外请求模型。原 sender 的本地受理是 confirmed effect；消息、完整工具完成回执和 ModelStep 配对在同事务确认。重开读取原收据，不重新发送；同 key 异 intent 明确冲突。Message ID 在同原 Agent Operation 的首次并发准备间稳定。

## 公开消费者

认证 Host → ThreadAdapter → AgentRuntimeClient → `runtime.messages.{send,list,get}` 保留用户身份。Host 不为 inform 调用 continueLaunch 或准备目标模型/source。列表仅返回原 metadata，正文按需单条读取；游标绑定 Thread/branch、方向和受理上界。读 worker 在返回前重核当前 owner epoch。原 queue 与历史根、command/result 引用及 publication 保护全部沿用原 GC。

共享 ThreadConversation 的 Task messages 面板支持收/发列表、原文、明确接收方/分支与 replyTo 回复。文案分别显示 accepted 和 delivered-to-history；未知发送回执保留同 key、正文和目标重试，折叠不丢该草稿。Host 的 HTTP 400 若实际表示 kernel-response-discarded，也不能被当作未受理而换 key。用户可明确放弃本地待确认草稿，但不撤回已接受消息。切 Host/Thread/branch 清理本地视图并拒迟到结果。空白正文的 UI 准入与核心一致，真实发送文本不被裁剪。

## 已验证范围

最终冻结同源 runtime **342 passed / 0 failed / 2 ignored**，kernel lib **77 passed / 0 failed / 11 ignored**。其中 passive 领域六个用例和 kernel 三个公共入口/真实 child assembly 用例已包含在完整套件，不重复相加。覆盖两 origin、User/Agent、固定 reply/family 拒绝、原收据重开、GC、waiting/idle/cancel、ModelCompleted/Interrupted 最后边界、已投递输入与 ExecutionReport 一致、pending policy decision 恢复以及既有 Goal 自然续接。

最终 all-targets 编译通过。准确 Linux x64 identity `0.9.25` 的同源开发 binary 和原 ELF/manifest staging 通过，SHA-256 `fabaa5307aa55180f4b73c7c0a196685f2a394cc4b5013109233317b5573300f`。构建前后 Rust 输入清单完全一致。Fresh binary 的实际 guardian/WorkingResult 组合 **1/1** 验证共享输入/历史消费者仍保持真实停止和结果屏障，不冒充消息 full Host E2E。

Host 三组 **24/24** 通过实际 application-client、认证 route、Adapter 和 RuntimeClient；底层 RPC 事实为显式 fixture，证明真实消费接线与拒绝/关闭语义，不代替 Catalog 持久效果。UI 四组 **38/38** 覆盖新消息面板、原 family/Conversation/projection，含原 ID 回复、未知回执同 key 重试、折叠保留、交付状态变化以及切 Host/branch/关闭后的迟到丢弃。Host/UI 类型、变更 lint、生成协议与实际 Host bundle（524 reachable / 72 excluded）通过。

独审在冻结前从设计定义验收，最终接受本切片，无剩余已确认阻断。仓库外真实 Catalog 探针 **4/4**，对 ModelStep 和 PolicyAction 都严格在首次 admit 前完成两个 capture/load，再核首受理、次重放只有一个消息，MessageReceipt、返回 ToolCompletion 与持久 operation.call_completion 完全一致；重开原回执不变，旧 owner body/list reader 被拒。另对两来源验证 stage 后取消原 Run 拒绝新效果。探针只链接同源 runtime rlib，没有修改生产代码或伪造执行收据。第一次探针构建误选另一 Cargo profile 的 serde_json 依赖，属于构建准备失败；按实际 rlib fingerprint 配对后运行通过，不作产品缺陷或额外成功计数。

整合中收紧了三个实际接缝：原 Agent Operation 的并发候选使用稳定 message ID；已提交 passive batch 在 Interrupted 结束前加入内存报告；原 followup 队列门槛只计算 activating 工作。没有为此增加重试账本、消息轮询或内容限制。

完整 Host IPC 在当前环境仍未执行。已沿原 child-dispatch native fixture 补入实际组合：先结束父 Run，child 普通 send 与 child UI User 消息分别持久接受；关联回复不复活 child；之后自然父 Run 只交付一次，关开后保原消息和原 child receipt。该入口有类型检查但不计通过；没有将 RPC fixture、原生 owner 和 UI 分别成功拼成一场未执行的产品 E2E。真实 provider 账号、安装产品和跨平台仍须用户验收环境补验。

## 复跑入口

按[开发指南](../development.md)使用锁定工具链，从仓库根目录：

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test passive_messages_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib message -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/kernel/thread-messages.test.ts \
  application-host/lib/kernel/thread-family.test.ts application-host/lib/kernel/thread-continuation.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadMessages.behavior.test.tsx \
  src/components/thread/ThreadFamily.behavior.test.tsx src/components/thread/ThreadConversation.behavior.test.tsx \
  src/lib/agent-runtime/thread-projection.test.ts)
```

完整产品环境使用同源码与准确 build identity 的 executable，通过原 kernel authority runner 运行 child-dispatch native 文件。两设计实施与用户验收后自行全面迁移的边界见[实施台账](../plan/agent-runtime-implementation.md)。
