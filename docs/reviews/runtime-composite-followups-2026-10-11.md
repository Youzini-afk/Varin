# 组合条件与原续接链验收

日期：2026-10-11（Asia/Singapore，UTC 2026-10-10）。基线：`13b0081583ae00700768ad00d9115838c37b3da9`。
本切片将原一次 At / ProcessStopped 接为 flat any/all；文件、日志、指标、研究及其他领域事件仍需接原 source owner。默认 runtime 和全面迁移仍交用户验收后负责。

## 合同与实际消费者

普通 `follow_up` 版本 **2** 与 User registration 使用同一条件合同。叶子为精确绝对 `atMs` 或原 `process_spawn operationId`；组合非空、不嵌套，不设无依据的数量上限。每个进程叶都沿真实 Run/source 授权，即使前一 At 已满足也不跳过。ModelStep / PolicyAction 的实际调用身份保持，原可选 Job 观察与登记分离。

Catalog **34** 删除 followups 中重复的单一 `operation_id` 字段，以原 trigger 与发生项证据确定来源。每个叶子只保 source_index、原登记 cursor 和实际观察证据，正文仍归 ContentStore。登记和回查已存在停止事实在原事务闭合；ProcessStopped 仍需 executor_stopped，业务终态、Unknown 或空 occupancy 不成为停止证明。

All 的部分命中跨重开保留，已观察时间叶退出下次 deadline；Any 使用该事务当前可见的命中事实冻结一次发生项，不声称能重建离线期间历史谁先到达。实际 At 分支可让 Any 成立，未命中进程仍在执行不会把 OR 变成 AND。原 native continuation worker 只等最近未观察的时间叶，没有 Host timer 或每叶线程。

一个组合只表达一次意图。需要“先按时检查，之后进程停止再继续”时登记两项明确意图，不能将 Any 的一次竞速解释成重复授权。Goal Dependency 的一次时间检查只认发生项里实际 At 证据；仅在定义中列出未来 At 不足以越过原 block。暂停、预算、未知用量和原世代仍由 Goal owner 控制。

原 occurrence → typed input → Environment history → root/child activation 保持唯一执行链。正文准备只展开实际命中的 process receipt，未触发的进程不要求其结果存在；准备后以原定义、发生项、Goal 及原 Operation 事实核对提交。取消 observation 保留登记和进程；取消定义控制未交付 input，已绑定不等于已交付。

Shared application-client、认证 routes、真实 ThreadConversation 均接入新合同。UI 可以编辑 Any/All 条件、读取每叶持久进度，未知受理响应重试保原 Run、key、条件和指令；不在 UI 判定命中或启动执行。原 `ingress.run_ready` 消费者保持，原 Host 冷启动场景扩为 At/ProcessStopped/Any/All 四种，以便在支持 IPC 的环境复跑。

## 验证记录

最终 runtime **400 passed / 0 failed / 2 ignored**（34 个 suite results）、kernel lib **91/0、11 ignored**，workspace all-targets 通过；14 条原未改域 kernel warnings 保留。准确 fresh binary 上显式执行原 ignored guardian/Storage **3/3**：child 的 All[At0, 原process] 经真实停止与 WorkingResult 接续，两条原 process 输出/来源授权链也通过，不将其余 ignored 算成通过。

独审在读 diff 前定义的 **7/7** 外置探针通过，覆盖有真实 Operation 资源占用的 Any At、All 半满足跨 reopen/GC、capture→admit 停止竞态、已满足前叶不跳后叶授权、部分取消、未知业务结果与停止事实分离，以及原 `continuation_wake::drive` + Linux 绝对计时。探针与冻结 production rlib/关键源码前后 SHA 相同，未发现本切片行为阻断。该组 Catalog 进程 fixture 不冒称 OS 停止或 Storage grant 验收；这由上面的准确 binary 独立实测承担。

Portable Host **3 files / 30 tests**、UI **2 files / 35 tests** 通过；原组合编辑、真实 route/client/Adapter 与冷续接消费者已执行，部分资源/RPC port 为明确 fixture，不拼接成完整 IPC 通过。Host 完整测试类型、UI 类型、变更 lint、生成协议检查及实际 Host bundle（527 reachable / 72 excluded）通过。完整 Host 四条件场景只作类型检查，未运行。

Linux x64 开发 executable identity `0.9.25`，target `x86_64-unknown-linux-gnu`，准确 manifest/ELF staging SHA-256 **`a809fef864b19776bd6e12bbbc899ca3704073b999306b281652434d2770ce71`**。251 项构建输入在构建、stage、guardian 验证前后逐项相同。它是本切片可复跑产物，不代表 Windows/macOS 或完整产品安装验收。

## 复跑入口

依[开发指南](../development.md)使用锁定工具链，在仓库根运行：

```bash
export RUSTUP_TOOLCHAIN=1.97.1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime --test followup_continuation -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib followup -- --test-threads=1
(cd packages/web && bun x vitest run application-host/lib/kernel/thread-followups.test.ts \
  application-host/lib/kernel/thread-continuation.test.ts application-host/lib/kernel/child-continuation-host.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadConversation.behavior.test.tsx \
  src/lib/agent-runtime/thread-projection.test.ts)
```

准确同源码 kernel executable 设置到 `VARIN_TEST_KERNEL_EXECUTABLE` 后，可显式执行原 ignored `actual_child_guardians_outlive_reports_and_tree_stop_precedes_fixed_results`，其中原 WorkingResult 链登记 All[At0, ProcessStopped]；并复跑 `followup_process_review` 的两条原进程读/权限链。这不表示所有 ignored 已执行。

完整 Host `process-wait-review.native.test.ts` 的 `admits one %s follow-up without the Host pump, then cold-prepares and reads the original long-lived process output` 已扩展四种条件，本环境不运行此前已确认被拒的 IPC 路径。Windows/macOS、真实休眠/系统时钟调整和付费模型仍无本切片实测证据。
