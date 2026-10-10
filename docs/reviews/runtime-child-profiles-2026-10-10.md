# 子任务执行配置与递归生命周期验收

日期：2026-10-10。基线：`0939337de1d8da8c67143fc87e03dce93814cc78`。
本记录只覆盖本次子任务增量；两份设计仍在实施，默认产品运行时仍是 Pi。

## 可验收的能力

- `dispatch` schema 2 使用 `task`、可选 `preset`、`workMode`、`tools`。模型获得原请求冻结的配置目录，UI 展示同一选择及不可用原因。旧内部 `model/profile` 参数直接拒绝。
- 原 harness settings / preset resolver 是配置权威。normal 继承实际父模型和所选工具，显式工具列表可缩减；配置 preset 使用原指令、模型来源、thinking/temperature 和工作视图。整个显式定义先检查，不能用空列表掩盖不支持的工具。默认 normal 也不会静默删除能力。
- 模型、凭据作用域、配置目录与原 ModelStep / PolicyAction 一起冻结。目录正文在原 ContentStore；后代共享引用，不嵌套复制配置树。后来设置变化不改已受理选择；重复原输入或模型选择 key 复用第一次回执。
- 本次子任务目录支持原生文件工具、资源读取、提问、报告/观察、递归 dispatch 与进程 spawn/inspect/read/write/resize/wait。私有副本不是 OS 沙箱。真实原 source、grant、调用身份和权限检查仍决定可访问内容。
- 模型报告与独立进程寿命分开。报告结束后进程仍可写文件，代码结果保持 pending；原文件租约和 guardian 停止证据齐备后才能固定 WorkingResult。未知效果本身不是已停止。
- 指定 child 或 Thread 的子树取消由 Catalog 原谱系决定，包含准备中后代、报告完成但作业仍活跃的后代以及待触发续接。旁支不受影响。短 ACK 只表示请求已受理，不表示所有进程已停。取消预检不读取结果正文。
- 固定候选或已发布结果的恢复复用原 Storage 回执，不需要旧工作目录存在；首次从目录生成候选仍需要真实写入停止和租约排空。

## 本阶段明确未覆盖

现有 Pi `worker` / `retrieval` 等 preset 的 Pi 工具名整组不会自动变成 native 工具；UI/模型目录保留明确的 unsupported 原因。目前可执行的是使用原生工具名配置的 custom/override，或对 normal 的明确工具缩减。MCP、普通扩展、自定义策略、语言/Computer/远端等更广的 child 绑定仍需后续闭合，不能靠移除 child 检查启用。

Native Thread 尚无持久 work-focus 设置。要求特定 work focus 的配置在作用域未知时明确不可用，不用工作台或项目目录推测。当前继承覆盖值绑定原父模型配置/凭据基准；基准改变时拒绝旧候选。

实际 Host Unix IPC 端到端验证沿原环境缺口留待补跑。下面的原生 OS、Catalog、Host 组件和 UI 证据分别成立，不拼接成一次未执行的产品端到端测试。所选不同 child 模型已验证实际 ModelAuthority 配置与 Catalog 冻结，并审过独立 credential owner → RunAssembly 消费链；未验证该组合发出真实 provider HTTP 请求。OS 用例使用无网络模型事实 fixture。未调用真实付费模型；未执行 Windows/macOS 产品验收。

## 已执行证据

- 冻结后的完整 Rust 组合：376 passed、0 failed、12 ignored，其中 runtime 317 passed、kernel lib 59 passed。随后独审发现的目录恢复问题按原失败条件单独 red/green 复验。最终 kernel lib 59 passed / 11 ignored、runtime 子域 40 passed 重跑通过，计数重叠不累加；新增 OS 用例单独显式执行通过。最终定点 rustfmt 后 all-targets check 与正确 identity 二进制重建通过。
- 真实 Linux OS 组合：原 CollaborationTool dispatch、子任务物化、ModelStep ProcessSpawn、guardian 及后代进程；报告后仍写文件，A 子树停止后 A/G 停止、旁支继续；原 Storage 固定实际文件 bytes，删除 cwd 后原候选/发布回执恢复，Catalog/Storage 重开不重跑进程。递归部分还经原 file_write 改 A 的 marker、原 Storage capture/builder 固定、G 物化后原 file_read 读到变化，原父 pin 仍无 marker。它验证真实修改内容的来源传递，不代替完整 Host 目录遍历捕获。
- 独立真实 Catalog 探针：四层与两旁支、错误 parent scope 拒绝、中间子树取消、旧 dispatch/body 和 source-ready/context 迟到拒绝、重开后旁支继续派发，family 身份不变。
- 独立恢复探针覆盖三个固定结果崩溃窗口。原实现错误地在 receipt-only 路径要求 cwd；修复只把目录空闲检查保留在首次实际捕获，重开、删 cwd、重复发布仍沿同一原回执。
- Portable Host 58/58，UI 30/30。覆盖实际配置归属、模型覆盖零值、原选择重试、context 保留、取消作用域、原操作事件唤醒，以及报告结束后仍可停止子树的 UI 行为。
- 共享 preset 消费者 protocol 5 项与 Pi dispatch 4 项通过。另一个既有 Pi 非阻塞提问用例失败：`questions[0]` 缺失；隔离替换为基线原 resolver 后同样失败。未算作通过，也未为本阶段修改无关 Pi 行为。
- 生成协议一致性、ApplicationClient/Host/Host tests/UI/PiHost 类型、变更 lint、实际 Host bundle 和文档链接检查通过。

## 复跑入口

使用[开发指南](../development.md)要求的 Node、Bun 和 Rust 工具链。以下从仓库根目录运行；环境变量示例为 Linux x64。本地二进制必须与当前源码和 build identity 对应。

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel -- --test-threads=2

VARIN_KERNEL_BUILD_IDENTITY=0.9.25 \
VARIN_KERNEL_TARGET=x86_64-unknown-linux-gnu VARIN_KERNEL_ARCH=x64 \
cargo build --manifest-path kernel/Cargo.toml -p varin-kernel --bin varin-kernel --locked

VARIN_TEST_KERNEL_EXECUTABLE="$PWD/kernel/target/debug/varin-kernel" \
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results \
-- --ignored --test-threads=1

cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test child_profiles_review

(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx)
```

Host 组件入口是 `packages/web/application-host/lib/kernel/child-profiles.test.ts`、`thread-continuation.test.ts`、`resource-consumers.test.ts`、`policy-child.test.ts` 和 `credential-owner-review.test.ts`。产品环境补验入口仍是 `child-dispatch-review.native.test.ts` 及原 kernel authority runner；需要可用的 Host IPC，不能将组件 fixture 替代该入口。

相关合同见[运行时 owner](../../kernel/crates/varin-runtime/README.md)、[Host owner](../../packages/web/application-host/lib/kernel/DOCUMENTATION.md)和[实施台账](../plan/agent-runtime-implementation.md)。
