# Bot 原身份与可恢复暂停基础

状态：本有限基础片已通过整合验证与独立审查。基线：`ab9d1f031fddbb293f2e9ffa1aaee4455b41bbcd`。

本片是私有执行基础。尚未开放新建 native Bot；native 历史来源、Bot 召回、产品主入口及完整
Computer/进程/记忆写入排空继续实施。`currentKernelWorkersDrained` 仅描述本片监督的 Rust
worker，不等于整个 Bot 已休眠。默认 Pi 和已有 Bot 资产未切换。

## 原文依据与权威

- [运行时设计](../design/agent-runtime-design.md) §5 的 Thread 身份、§13.2–13.3 的记忆与角色隔离、
  §24 的 Bot 能力行要求独立身份、记忆、主动任务和睡眠/恢复。
- [环境设计](../design/execution-environment-design.md) §9.1 要求停止 Bot 实际执行链，保留等待、
  成果和记忆；共享机器运行不代表 Bot 工作已停止，未知状态不能提前显示全部休眠完成。
- BotService 仍拥有 Bot 档案与 activity。Catalog 仅接收原 record revision/activity ID 的准入投影，
  将 Bot 绑定到原 Thread；child、context job、MemoryWork 沿各自原关系派生归属，不写 Registry 镜像。

## 本片合同

1. 原档案持久写入后发布 gate。旧修订或同修订冲突不能重开准入；新 Catalog epoch 默认关闭，
   直到原 Host 重新读取并发布。KernelClient 退出使 BotService 的旧 scoped grant 失效，下一次读取重新申请原最小权限。
2. Sleep 在短控制准入关闭 gate、捕获原 Run/Operation 引用，再在独立 worker 发出停止并等待真实
   join。显示字段或同 activity checkpoint 推进 profile revision，不撤销已接受的停止捕获。
3. Bot hold 与用户取消分开。原 Wait/trigger、policy checkpoint、手动 pause 和已完成回执保留。
   Prepared 请求不被 Sleep 改成业务取消；Wake 走原 Undispatched recovery，明确关闭旧候选后重新准入，
   不增加另一条 transport resume。已派发 Unknown 不自动重放。
4. 物理停止、效果未知与未决模型分别投影。同一工具 completion 后来的真实停止证明可以幂等精化；
   sampling 原 receipt 和原 Kernel operation worker 真退出共享短停止事件，不从 terminal/effect 推断停止。
   Host preparation 的取消等待可立即返回，其注册仍保留到实际底层 promise 结束。
5. 私有 resume 只解除已满足原屏障的 hold 并返回原 Run IDs；原 Host continuation 仍是执行启动者。
   新输入、child 发布、模型/工具派发和后台 MemoryWork 继续在原提交边界检查 gate。

Catalog 为 **64**，不读取旧内部格式；新增私有方法，wire **23** 的 envelope 与已有 DTO 形状不变。
Host/Kernel 仍按原 manifest 配套。没有旧格式迁移器或别名，也没有删除历史正文资产。

## 验证边界

已运行的组合与回归：

- 原 BotService→KernelClient→真实 Storage/Catalog：创建、Sleep/Wake gate，停止 barrier 前禁止准入，
  同一 Host 实例经历 kernel epoch 丢失后重取 scoped grant，Host preparation 等实际 promise 排空。
- 原 Catalog 模块 90、Execution 模块 14、prepared recovery 12、MCP sampling/Goal 3 项通过，覆盖真实
  child 源发布与 gate 交错、持久 Wait/trigger、手动 pause、原模型/工具证据及重开。
- 原 Bot 后台记忆 stdio 3 项实际运行 107.68 秒，经过真实 Knowledge 子进程、MemoryService、原凭据与
  provider adapter；原结果恢复、显式关联重试、disabled/取消/缺正文的失败投影保持。第一次误用源文件名
  作为 Rust 模块筛选，命中 0 项，没有计入通过；上述证据来自核对真实模块后的独立复跑。
- 既有 BotService 13 项、Host 源码/tests 类型、生产 Host 构建、本片 Host lint 与协议生成检查通过。
  Kernel debug 二进制及 staged 副本 SHA256 相同：
  `70bd0eed809e2e3acd2c0a5b1e580fc806efa88a5fc9becd9efcd0c9aac5d15f`。
- 独立审查先从设计冻结验收，再看实现。其真实 Engine 提交后受控暂停窗口，验证 warm/cold Wake 经原
  Supervisor recovery 恰好一次发送；原候选、proposal 与历史关联不改、不重复。已派发 Unknown 在 warm/cold
  Wake 均零重发；hold 后显式用户 Stop 始终优先。同一探针已作为 `bot_suspension_recovery` integration
  target 纳入仓库并复跑通过，不为制造测试窗口添加生产 hook。

审查还核实 sampling 停止事实来自原 provider 返回/捕获失败后的 receipt，或实际 operation worker 退出；
不是从效果、终态或 worker 数量推断。未知收费结果仍保留，现有回执发布只重试提交，不重发模型。

复跑入口均需先检查测试本身与其导入/初始化路径：

```sh
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib 'catalog::' -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --lib 'execution::tests::' -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test prepared_request_recovery --test mcp_sampling_goals -- --test-threads=2
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test bot_suspension_recovery -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib bot_gate_host_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib 'agent_runtime::memory_work_commands::tests::' -- --ignored --test-threads=1
```

Host 组合沿原 Rust↔Host stdio fixture、真实 KernelClient/Storage/BotService。后台记忆回归另含原
Knowledge Node 子进程 IPC。模型 transport 与部分生命周期目标受控；没有执行产品监听、实际模型服务、
真实桌面、虚拟机或跨平台全验收。不运行包含 listener 的整个 runtime/provider suite。

## 续接

- 将 typed native history/source、MemoryService、原 Knowledge recall 与实际请求材料连通。
- 在原 lifecycle 贯穿 main/child、历史进程、Computer 与底层记忆 mutation 的真实停止/恢复。
- 接通明确新建 Bot 的入口、配置、工作导航、选段与删除，完成后再暴露 native Bot 选项。
- 最终交用户验收；默认切换、Pi 删除和用户资产全面迁移继续由用户负责。
