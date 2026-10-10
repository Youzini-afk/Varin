# 同任务发现与固定会话互读验收

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`dbc8cd70246448e1cb2ff339e0392c274ce901a6`。
本切片覆盖普通工具、公用读取接口和只读会话界面。两设计仍在实施，最终迁移由用户验收后负责。

## 原权威与读取合同

- 普通 `threads` / `read_thread` 根据原 Catalog ChildTask/Thread 血缘发现任务根、父、兄弟和后代，默认排除自己。同目录/项目或猜到 ID 不授予无关任务读取。ModelStep 和 PolicyAction/node 使用原冻结工具声明、schema 和参数；未选能力在重开后不补入。
- 全部原历史生产者在同一事实事务写入实际 `history.run_id`，初次输入使用延迟外键与 Run 一起提交。用户输入、模型/工具、策略交付、用户回答、子报告和进程观察都保留真正生产/接收 Run。Fork 继承原 Run，不能按 item ID 前缀、最新 Run 或目标 branch 重记归属。Catalog 27 直接拒绝旧内部格式。
- 分支固定 ancestry 内的继承 Run 与该 branch 直接受理的 Run 都可发现/筛读，目录保留原 Run.branchId。原文仅存 ContentStore；没有第二会话、关系或工具效果账本。短 Catalog capture 后，关系遍历、历史 SQL、正文、搜索和序列化都在读 worker，既有 publication 保护在途内容。
- 最近记录、排他范围、解码文本/路径搜索保留原 ID、次序、来源和工具 request/call 关联。返回始终按历史顺序；扫描预算不足时即使无匹配也给续读 cursor。完整 JSON、截断预览和原条目分块各自明确。UTF-8 分块不超出请求字节预算；容不下下一个完整码点时明确失败，不返回无法推进的游标，实际 offset/totalBytes 精确。
- Signed anchor/cursor 绑定 caller、目标 Thread/branch、Run、查询和 epoch。追加、fork 或回滚不漂移原视图；重开后旧 token 明确失败，不能静默切回 latest。ProviderOriginal 与 typed opaque continuation 保留原库，但不参与家庭共享读取/搜索。普通 user/tool JSON 仍是原内容，不把其中同名字段当内部控制状态。
- 读取已停、失败或取消的目标不复活模型、cwd 或原 child launch，不继承 source、权限或控制能力。正文明确标为其他 Agent 数据，不能成为当前用户指令。消息、回复/Wait、新 Run 续接以及未交付策略/辅助模型输出分享仍单独推进。

## 公共消费者

原 AgentRuntimeClient、ThreadAdapter、认证 `/api/threads/family/{list,runs,read,item}` 和 `ThreadsAPI.family` 共用四个 Rust reader。Host 核调用者 Thread/branch，目标放在独立 request；调用者不能从该 request 覆盖 callerThreadId。关闭 HTTP 请求只取消该读请求，不取消目标工作。

共享 ThreadConversation 的按需 Task family 面板可查看真实成员、分支、历史 Run、固定页、搜索/前后范围和原文分块。切 Host、caller、目标、branch 或 Run 会取消原读取并丢弃迟到结果；错误、无记录、无匹配和未完成扫描保持区别。原普通 history chunk 消费也传递真实 run_id，不需要另一个 child 历史编辑器。

## 验证与边界

最终冻结源码：完整 runtime **336 passed / 0 failed / 2 ignored**；kernel lib **74 passed / 0 failed / 11 ignored**。其中 family 原生领域 **12/12** 与原生公共 DTO / 两种真实子调用来源 / 未选工具重开 **4/4** 已包含在上述完整套件，不重复相加。覆盖真实家系、call/schema 绑定、历史 Run/fork、原文/大结果、跨 query/caller token 拒绝、GC、取消和已打开 SQLite 快照后的 owner 替换。

共享历史的全部原生产者及内核消费者均经最终 all-targets 和准确身份构建检查。最终 Linux x64 开发二进制 identity `0.9.25` 已走原 ELF/manifest staging，SHA-256 `a8276462d8d6dade3e9fa31622310aca2952e31dbf41c1b00c3daca639cc4377`。同源 fresh binary 的既有真实 guardian/WorkingResult 回归 **1/1** 通过；它验证共享历史、停止和文件结果消费者，不冒充新的 family Host E2E。构建前后 Rust 输入清单完全一致。

Host 四组 **27/27** 使用真实 API/认证 route/adapter/client，底层 RPC 响应为显式 fixture；验证 caller/target 分离、原 token/Run/字节页保真、请求关闭取消和普通历史 hydration。UI 三组 **35/35** 包含新只读面板及原会话/projection 回归，覆盖按需读取、partial JSON、固定页、切 Host/target/caller 后迟到丢弃。Host/UI 类型、变更 lint、实际 Host bundle（524 reachable / 72 excluded）、生成协议与文档链接通过。

独审按设计另写探针，实际发现并修复两条 P2：选 R1 的前后导航被 R2 制造空跳转；后建已完成 fork 把仍有活动 Run 的根任务误标为 completed。原失败条件均先真实失败、再修后通过；第一版 root 探针自身非法状态转换仅算测试搭建失败，补合法启动后才到达目标断言。修后导航只考虑同 Run 可见上下文，任务目录优先反映真实活动 Run，混合活动状态明确汇总；无活动的根按原 Run admission 次序选最新状态。没有增加状态或历史权威。独审复核最终源码及实际红绿日志，接受本切片，无剩余已确认行为阻断。

完整 Host IPC 组合沿既有 `child-dispatch-review.native.test.ts` 补入：真实 child 两个工具、父历史读取、公开固定页/原文、原 Catalog fork 继承、无关任务拒绝、关开/旧 anchor 失效及零新 provider 请求。当前环境未执行该完整路径，不计通过。原生领域/工具、Host 组件和 UI 证据不会拼成一次未执行的产品 E2E。

## 复跑入口

按[开发指南](../development.md)准备锁定工具链。从仓库根目录：

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test family_history_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib family -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/kernel/thread-family.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadFamily.behavior.test.tsx \
  src/components/thread/ThreadConversation.behavior.test.tsx src/lib/agent-runtime/thread-projection.test.ts)
```

有可用完整产品环境后，经原 kernel authority runner 运行 child-dispatch native 文件，使用同源码、准确 build identity 的二进制。当前总体边界见[实施台账](../plan/agent-runtime-implementation.md)与[运行时 owner](../../kernel/crates/varin-runtime/README.md)。
