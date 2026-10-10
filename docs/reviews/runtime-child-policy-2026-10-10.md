# 子任务策略与规划模型验收

日期：2026-10-10。基线：`79e8d2a4153c52d3f429f8e6e96ccb51f6d0ffaf`。
本记录覆盖已受理 native child 的 AgentPolicy 和显式规划模型；默认产品仍为 Pi，两设计继续实施。

## 原权威与能力边界

- ChildTask 仍先受理，随后才准备自己的真实 Thread/project 作用域策略。既有路由、ServiceRegistry、PolicyBridge、Launch 和 policy generation 负责初次选定、候选准备与闭合边界激活；没有 child 专用策略引擎、配置或私有状态账本。父策略检查点不复制给 child。
- 自定义策略及其声明的 agentPlanning 能力归 child 自己的 Run/generation。规划是独立模型 Operation，使用原凭据 owner，恢复精确已提交配置，保留实际输出/用量。已存在的 delegated Goal 继续计量，不赋予 primary Goal 或自动续接权限。
- 策略世代可以变化，原 child tools/source/MCP/extensions/profile 仍冻结。普通 ToolGraph 经过同一个 ToolDirectory、ToolOrigin、权限、Operation 与回执路径；策略不能凭名字获得未委派能力。内部 compaction job 仍使用固定、无工具的策略。
- 普通策略换代后仍被真实 pin 持有的原 artifact 可以派生独立恢复 pin；完整 artifact/configuration/declared identity 仍精确核对。最后原引用释放或明确撤权后不能复活旧实例，也不改用最新 artifact 冒充恢复。
- Deliver、Pause/Resume、报告和文件结果继续使用原 child/Run/Wait/WorkingResult 消费者；策略更新不解除暂停，不把报告终态当作外部作业已停止。

## 验证与边界

本切片无剩余已确认行为阻断。独立审查按设计检查实际消费者，并复现、复验以下 exact-rebind 缺陷：同一 artifact 存在不同配置的旧 draining / 新 active generation 时，仅选择首个 artifact 相同的实例会拒绝仍可用的准确配置。修复在原 owner 的同 artifact 候选内逐一核完整描述身份，失配释放临时 pin；独立原探针确认新旧两向恢复都成功，不存在的配置仍拒绝，没有跨 artifact fallback 或新增 registry。

- 最终完整 runtime **324 passed / 0 failed / 2 ignored**；kernel lib **65 passed / 0 failed / 11 ignored**，包含四个新 child policy 行为与原冻结 owner 装配。原生成功链实际经过 child 首次 null 私有状态、两代独立规划、闭合边界换代、合法 PolicyAction Host 工具/原回执、generation 1 Pause→Catalog 重开→Resume、原报告读取及 no_changes。原 Goal 计入两次实际 usage，child 不获得自动 Goal 权限。未委派 memory 图在派发前拒绝。
- Prepared 和 dispatched 两种 Catalog 重开复用原规划 Operation，已派发未知请求不重发；各自 Pause 后再次重开仍交真实 Resume。取消及迟到凭据/候选保持原终态，证据范围见下。
- 最终 all-targets check 与准确身份二进制构建通过。fresh binary 上既有真实 Linux writable-child guardian / WorkingResult 消费回归 **1/1** 通过；它是共享文件消费者回归，新 custom-policy 成功链本身使用 Host helper 与 no_changes，不能称自定义策略写文件端到端通过。
- 最终 Host 六组 **57/57**，Host 生产/测试类型、变更 lint、实际 Host bundle 与文档检查通过。前面的 23/23、56/56 是其增量/重跑，不重复累计。上述 ignored 用例不计作通过。
- Linux x64 stage identity `0.9.25`，经原 ELF/manifest 入口核验，SHA-256 `ebe413729c39fe8108f7a4010e4c25c7134be567c7c1a86a8299d29073bf30bd`。

真实 SDK broker 验证父/child 的不同 Thread 路由、原策略退役时的精确重绑，以及最后释放/停用后的拒绝。Host AgentRuntimeClient/PolicyBridge 组件验证 child Run-bound 凭据、初次选择、保存配置恢复和候选取消；其 Catalog RPC 是明确 fixture，不作为完整 Host IPC 证据。

原生规划用本地 loopback provider 验证真实 adapter 请求、原凭据和 usage 流程，不代表真实账号、模型质量或付费服务验收。取消用例暂停在持久 dispatch intent 之后的 credential reply 之前，尚未发送 HTTP；它验证本地取消与迟到身份栅栏，不声称已验证远端在途 HTTP 取消。现有模型失败合同在该边界保守保留 Interrupted/Missing，未新增未知效果自动重发。

完整 Host Unix IPC 产品链、真实 child provider 账号/HTTP 与跨平台仍需相应环境证据。本切片未添加 child memory/plan/Goal/LSP/Computer/remote 等剩余能力，也不执行默认切换或资产迁移。

## 复跑入口

从仓库根目录使用[开发指南](../development.md)工具链：

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib child_policy_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel -- --test-threads=2

(cd packages/web && bun x vitest run \
  application-host/lib/kernel/agent-policy.test.ts \
  application-host/lib/kernel/policy-activation.test.ts \
  application-host/lib/kernel/policy-child.test.ts \
  application-host/lib/kernel/policy-domains.test.ts \
  application-host/lib/kernel/thread-continuation.test.ts \
  application-host/lib/kernel/tool-composition.test.ts)
```

产品环境补验沿既有 kernel authority runner、policy/child native tests 与原 Thread 路由；不要拼接 fixture 与原生组件日志为一场未执行的完整 IPC 验收。

合同与最新状态见[运行时 owner](../../kernel/crates/varin-runtime/README.md)、[Host owner](../../packages/web/application-host/lib/kernel/DOCUMENTATION.md)和[实施台账](../plan/agent-runtime-implementation.md)。
