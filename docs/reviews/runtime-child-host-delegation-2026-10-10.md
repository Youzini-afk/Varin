# 子任务 Host 能力委派验收

日期：2026-10-10。基线：`bea1b38a0a2102fc5470e737c9dbaa41d7af468b`。
本记录覆盖普通扩展和 MCP 子任务绑定；两份设计仍在实施，默认产品运行时仍是 Pi。

## 能力与实际入口

- 配置仍来自原 harness settings / preset resolver。实际 Rust ToolDirectory 将原生声明和原请求冻结的 Host 声明一起解析；完整 preset 先验证，再允许显式缩减。UI 使用同一冻结 native 描述与实际 Launch Host bindings，不再用原生工具名白名单误拒普通扩展。
- ModelStep、PolicyAction 和 ChildTask 保留原 schema generation、工具、MCP、扩展的 ContentStore 引用。普通扩展保留原 artifact、配置与声明身份，child 只准备其实际选中服务，不订阅新路由候选。
- MCP 原配置来源、服务器定义及 global/workspace 执行作用域与真实执行资源身份分开。workspace MCP 在 child 自己的物理工作目录运行；global MCP 保持中立环境。只有原未使用 Launch 事务允许一次实际 child binding 派生，此后精确恢复该绑定。直接工具保留所属服务器与原可见名称；通用 discovery/call 不能扩张到后来新增的服务器。
- 原冻结调用仍持有端点时，private ToolBridge 先确认一次短的 child 资源引用交接，再由 Catalog 受理。这里不启动服务。慢来源、上下文和服务准备发生在受理后。父 Run 结束或 kernel channel 重建不会丢掉已受理 child 的原引用；child 独立 Run 绑定成功、终态事实或旧 epoch 的未受理恢复才释放。
- 原 ServiceRegistry 可从仍持 pin 的旧 generation 派生独立 child pin。MCP 原 authority 可从仍存续的原配置 scope 派生 child 执行连接。明确停用、撤权、当前信任与凭据检查继续生效。Host 自己重启后，不可恢复的旧 artifact/definition 明确失败，不换用最新版本。
- 子任务文件结果同时等待原文件/进程和 workspace Host 调用的真实停止证据。协议取消或 Unknown 回执不证明执行端停止，不能据此固定目录。作用域及身份来自原绑定和 Operation；global MCP 或同名普通工具不会被当作原生进程。文件精确差异仍由原 Storage WorkingResult 决定，成功调用并不自动意味着修改了文件。

## 本轮发现并闭合的条件

独立审查先从设计建立验收条件，再用原 owner 和实际 Catalog 路径验证。本切片无剩余已确认行为阻断；以下三项和同名 Host 工具的取消尾项都按真实触发条件闭合。

1. 普通换代：v2 已发布、v1 原 pin 仍实际可调用时，慢准备 child 原先错误查询最新 artifact 而失败。修复覆盖原引用受理前交接、父终态、child 独立接管和明确撤权，不仅修改一个查找分支。
2. 停止屏障：真实取消后的 workspace MCP Operation 是 Unknown 且 executor_stopped=false，原 process-only 判定仍允许固定文件。修复沿原绑定和原回执分类并等待真实停止；未派发与可信 NotDispatched 不要求不存在的外部停止回执。
3. 取消交错：已有 queued executor 测试实际撞到 worker 先结算 Cancelled、随后持久取消请求被终态快速返回吞掉的竞态。保持及时发出控制信号，只对该已取消结果补记本次真实取消意图一次；结果、重复幂等与其他已完成结果保持原合同。

## 实际证据

- 完整 runtime **324 passed / 0 failed / 2 ignored**；kernel lib **61 passed / 0 failed / 11 ignored**。同名 Host `process_spawn` 的最终 owner 判定修复后，取消、child 与 child Host 聚焦 **24/24** 重跑通过，属于前述范围，不累计为新用例。
- 原 R1/R2 独立失败探针均 red → green；同名 Host 已成功调用不会被原生进程取消规则误改。另以生产 extension preparer/broker 验证旧实现退役更新后 child 独立保留原实现，释放父引用后仍能执行；当前权限查询和执行上下文使用真实 child Run/Thread/branch。
- 最终 all-targets check、新 Linux x64 binary 与真实 guardian 用例 **1/1** 通过。后续只对本轮 Rust 变更区域格式化；独审对 27 个文件逐一验证改前/改后全 rustfmt 结果一致，其余已审源码不变。格式后重新编译并按原 ELF/manifest 入口 stage，identity `0.9.25`，SHA-256 `d79ca6e27516726f5851036e97605960eec1eaa4a785ac69b1c0557a4a3b05de`。
- Portable Host 七组 **50/50**；ServiceRegistry 与普通扩展生命周期 **31/31**；共享 Pi/MCP 消费 **13/13**；UI 行为 **30/30**。这些包括真实 MCP stdio cwd/global/原配置恢复、原 broker 换代和组件交接；fixture 的 kernel inspect/permission 范围另行保留，不代表完整产品 IPC。
- Host 生产/测试类型、UI 类型、PiHost 与 ExtensionHost 构建、变更 TS lint、生成协议检查和实际 Host bundle 通过。文档与 diff 检查通过。既有 ignored 用例未被默认为通过。

## 验证边界

实际 MCP stdio、普通扩展 broker、Catalog、Rust guardian、Host 消费组件的证据分别成立。完整 Host Unix IPC 产品链仍待可用环境补验，不能把这些组件拼接成一次未执行的端到端验收。未执行所选不同 child 模型的 provider HTTP、Windows/macOS 产品验收或付费模型调用。

MCP 协议取消后若原 owner 没有真实停止证据，未知效果及文件结果保持 pending；不会把请求返回、发出 kill、Run 终态或释放观察者当作外部执行已停止。以后取得的原回执可以精化，同一未知调用不会自动重发。

本切片仍未开放 custom AgentPolicy/planning models、memory/plan/Goal、语言、Computer、远端等更广 child 合同。family 定向消息/历史/续接、通用日历事件、统一环境与其他完整设计能力仍是后续工作。用户验收后亲自执行默认切换和全面迁移。

## 复跑入口

使用[开发指南](../development.md)的工具链，从仓库根目录运行：

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test child_host_delegation_review

VARIN_KERNEL_BUILD_IDENTITY=0.9.25 \
VARIN_KERNEL_TARGET=x86_64-unknown-linux-gnu VARIN_KERNEL_ARCH=x64 \
cargo build --manifest-path kernel/Cargo.toml -p varin-kernel --bin varin-kernel --locked

VARIN_TEST_KERNEL_EXECUTABLE="$PWD/kernel/target/debug/varin-kernel" \
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib \
actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results \
-- --ignored --test-threads=1

(cd packages/web && bun x vitest run \
  application-host/lib/kernel/mcp-child-preparation.test.ts \
  application-host/lib/kernel/tool-composition.test.ts \
  application-host/lib/kernel/tool-bridge.test.ts \
  application-host/lib/kernel/extension-tool-owner.test.ts \
  application-host/lib/kernel/thread-continuation.test.ts \
  application-host/lib/kernel/child-profiles.test.ts \
  application-host/lib/kernel/resource-consumers.test.ts)
```

原 service lifecycle 入口是 `packages/extension-host/test/service-binding-review.test.ts`、`service-registry.test.ts`、`lifecycle-parallel.test.ts`、`grant-revocation-review.test.ts` 与 `tool-invocation-scope.test.ts`。共享 MCP/Pi 消费入口是 `packages/pi-host/test/native-mcp-*.test.ts`、`pi-mcp-config-bridge.test.ts`、`pi-native-tools.test.ts`。使用各 package 的 test script；不要把编译旧 dist 当成新源码测试。

产品环境补验仍使用原 kernel authority runner 与 `child-dispatch-review.native.test.ts`。原 ToolBridge 数据/控制帧传输和子任务来源/权限链需要在可用 IPC 环境复跑。

合同见[运行时 owner](../../kernel/crates/varin-runtime/README.md)、[Host owner](../../packages/web/application-host/lib/kernel/DOCUMENTATION.md)、[共享 MCP owner](../../packages/pi-host/src/mcp-authority.md)与[实施台账](../plan/agent-runtime-implementation.md)。
