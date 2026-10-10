# 子任务独立新 Run 与逐轮结果验收

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`2a580f193c6bfe8846c94bf53fd432fd677d7668`。
本切片交付已结束 child 的显式 User 新 Run，以及同一执行 owner 上逐轮独立的报告、来源和文件结果。主动 request 与关联 Wait/期限继续实施。

## 原权威与实际行为

本切片允许用户在已结束 child 的原 Thread/branch 上明确继续。稳定 `child_tasks` 只保存原分派关系；首轮和续轮共用 `delegated_executions` 的准备、来源、Run 关联、报告与 WorkingResult 消费。Run/Launch/Operation 仍拥有执行和效果，没有复制另一套 Run 状态机。Catalog 格式 **29**、collaboration domain **4**，旧内部格式直接拒绝。

继续命令绑定原 key、精确上一实际 Run、expectedHead 和原输入。受理先于冷准备，重开后仍能发现尚未创建 Run 的原命令；重复返回第一次接受，不重读最新配置或重启旧 Run。取消/失败且没有产生 Run 的准备不永久封死后续新用户意图。活动 child 的 boundary/interrupt 仍走原输入队列，next_run 不能绕过新执行与来源准入。

新 Run 使用上一实际 Run/Launch 的模型、凭据、策略 artifact/规划模型及工具声明。策略从新世代/私有状态开始，普通扩展重新取得独立权限；MCP 从原精确定义/schema 重新准入当前执行目录一次，同 Run 恢复则要求其实际已保存绑定。当前 trust、permission 和撤销继续生效。它不领取已释放的旧父 handoff，也不隐式增加新工具。

可写续轮从上一 WorkingResult 的精确 branch/revision/root 开始；只读或已证实无文件效果的轮次使用精确不可变基线。未停止写者不能靠新目录绕过；真实停止后已固定的结果即使保留 Unknown，也可作为新用户工作的精确基线，旧未知效果不被重放或改写。没有固定结果的 unavailable 仅在实际 None 时复用不可变基线。新 branch、pin、publication 随执行 ID 独立保留，前轮报告、原 JobAccepted 和固定结果不变。报告只引用本 Run 在终态 head 上产生的真实 history；旧 assistant 文本不使新空轮成为成功报告。原 wait_child 始终等待原分派，child_status/child_report 版本 2 和 integrate_child 版本 2 显式选择 execution。

上下文沿原 forSource owner 换源，保留摘要/历史锚、worker 角色和 memory snapshot。外层 replacement CAS 使用旧 checkpoint，显式 skill 输入绑定同次新候选；用户原 text/images 保留原输入来源。Tree cancel 对当时所有已接受执行生效，包括尚无 Run 的准备；迟到 source/context 提交不能复活已取消意图。原 ContentStore publication/GC 与 Storage 固定根继续是唯一内容权威。

## 公开消费者

认证 application-client → HTTP → ThreadAdapter → AgentRuntimeClient → Kernel 接受 User 续接。公开入口不能指定 actor、配置、source 或另一个 child operation。Host ThreadCollaboration 首轮/续轮共用按 execution ID 协调的生命周期，冷准备与持久事实分离；Source、MCP、extension、policy 和启动消费者都按真实 Run 找对应 execution。

共享 ThreadConversation 在 idle child 上提交新 Run 意图，活动时仍提供 boundary/interrupt。未确定受理结果保留原 key/前轮/head/输入；切 Host/Thread/branch 拒绝迟到结果。逐轮卡展示独立 Run、报告与文件 publication，按精确 execution/item 分块读原报告。旧父 child 卡和原 wait_child 不被“最新一轮”替换。父集成工具及原 journal 都保留 child operation、execution 和 publication 三个身份。

## 已验证范围

最终同源 runtime **351 passed / 0 failed / 2 ignored**，kernel 普通 lib **78 passed / 0 failed / 11 ignored**，workspace all-targets 通过。续轮领域九个真实 Catalog 场景已包含在完整套件；Kernel typed continuation → source.ready → prepare → execution.for_run/list → RunAssembly，以及第二 execution 的原 Integration journal 对账也计在完整套件中。既有格式旧版本拒绝、GC、原任务/进程/模型恢复和取消回归仍通过。

同源 Linux x64 开发 executable 按 identity `0.9.25`、target `x86_64-unknown-linux-gnu`、arch `x64` 构建并通过 ELF/manifest staging，SHA-256 `554029a9e5fd7ed91d2695adf0b327f0d79cada174a51362af2a4488a5a92369`。前后 Rust 输入清单完全相同。Fresh binary 的真实 guardian/Storage 纵切 **1/1**：原子树停止前拒绝续接，真实停止和 WorkingResult 发布后，删除旧物理目录，仍从原固定 root 建新 source/Run，原文件结果不变；这是普通 suite 中一个 ignored 场景的单独执行，未运行其余所有 ignored 场景。

最终 Portable Host 十个 owning suites **129/129**，覆盖实际 client/认证 route/Adapter、冷启动协调、精确 MCP stdio 第二执行目录、扩展能力绑定、策略/规划凭据、资源上下文和 Integration 消费。底层 Kernel RPC/部分 Storage port 为明确 fixture；实际 MCP 子进程私有 stdio 与原生 owner 证据分开。共享 ThreadConversation **31/31**，覆盖确切前轮、未知回执同 key 重试、逐轮原报告，以及尚无 Run 的续轮准备可通过原子树停止按钮取消。Host/UI 类型、变更 lint、生成协议一致性及实际 Host bundle（524 reachable / 72 excluded）通过。

独审在看实现前先从设计形成九项验收，最终接受此切片，没有剩余已确认阻断，并核对最终源码/产物 hash。最终原生外部探针 **4/4**：本 Run 报告/空轮不借旧文、首次两个候选与重开原受理、取消迟到 source 与后续新 User 意图、真实 stop 与 Published Unknown 分离、终态 Goal 跨轮隔离。另两条只读 fork 探针和一条 Host → Catalog → Host planner 实际组合通过。原生事实探针并不声称自行执行了物理进程/Storage，后者由上述 guardian 纵切提供独立范围的证据。

本轮闭合的实际接缝：

- 新逐轮列表曾阻断合法 child 历史 fork 的只读 snapshot。隐式列表在非执行 branch 返回空；parent 同 Thread 的历史 fork 沿既有只读范围读确切 execution/report，不增加控制或续接权限。原外部失败探针由红转绿。
- 前轮热切换策略 generation 1 的 planner 凭据 ID 不能直接当作新 Run generation 0 使用。原 worker 持久准备只派生本轮 binding ID，保留全部原配置/凭据/可用状态及合法 tool-free provider binding。真实 Host/Catalog 往返同时暴露可选字段 missing/null 的 hash 差异，现仅统一类型化外层缺省表示，保留 0、false 和 modelOptions 内部 null 的差异。原失败链修后成功，仅首轮读 settings 一次，恢复原凭据一次；没有改 literal hash 或放宽恢复校验。
- 已完成/取消的原 Goal 曾通过稳定 child 关系使新用户 Run 一启动就被取消。新执行关联与 Goal 准入现同事务：已终态 Goal 不再支配新 User 工作，旧 Run/用量不变；仍 Active 的暂停/预算照常保留。原反例红绿验证，并防止后来父 Goal adoption 跨过明确的新 User 边界。
- 原候选把“效果 Unknown”和“写者未停止”合并为永久门槛，过严。现已停止且确实发布的固定结果可用于新用户工作，旧 Unknown 保留；无固定结果仍需真实 None 才可复用 immutable 基线。同步文件工具复用原 ToolSettled、资源 drainage 和 Storage publication，不人为要求另一套外部 executorStopped 字段。

最初 portable tool-composition fixture 仍返回旧 Thread 级 child RPC，实际新 Run 查询使九例失败；更新为精确 execution fixture，并将既有绑定生命周期覆盖首轮与续轮后通过。首次 Kernel 新场景漏传必需 nullable `live_root`，属于场景组装失败，按实际 DTO 修正后通过；不把这两次失败计为成功证据。

完整 Host IPC 组合已补到原 child-dispatch native 文件并通过类型检查，当前环境没有执行。该场景要求真实父分派 → child 实际写入第一轮固定文件/报告 → 已受理 User 续接尚无 Run 时关闭 Host → 修改父物理目录 → 重开恢复同一意图 → child 读取第一轮固定文件并产生第二轮独立结果/报告，原 dispatch 结果不变。组件 RPC/Storage fixture、原生 owner 与 UI 的分别通过不合称这场未执行的 E2E。

## 复跑入口

从仓库根使用[开发指南](../development.md)的锁定工具链：

```bash
export RUSTUP_TOOLCHAIN=1.97.1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test delegated_continuation_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib public_continuation_source_prepare -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/kernel/child-continuation-host.test.ts \
  application-host/lib/kernel/thread-continuation.test.ts application-host/lib/kernel/integration-tool-owner.test.ts \
  application-host/lib/kernel/mcp-child-preparation.test.ts application-host/lib/kernel/thread-messages.test.ts)
(cd packages/web && bun x vitest run application-host/lib/kernel/tool-composition.test.ts \
  application-host/lib/kernel/policy-activation.test.ts application-host/lib/kernel/policy-child.test.ts \
  application-host/lib/kernel/thread-resource-scope.test.ts application-host/lib/harness/working-state/integration-coordinator.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx)
```

产品验收环境另用同源码与准确 build identity 的 executable，通过原 kernel authority runner 运行 child-dispatch native 文件中 `continues a completed writable child after Host restart` 场景。主动 request、关联回复 Wait/期限和多等待屏障继续实施，不因此切换默认 runtime；全面迁移由用户验收后负责。
