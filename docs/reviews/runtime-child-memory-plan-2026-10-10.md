# 子任务普通记忆与计划验收

日期：2026-10-10。基线：`4290f341a9c1110d2f1fcb6d9b869807bdc623ee`。
本记录覆盖普通 child 的 memory/todo、原数据 owner 与报告消费；两设计仍在实施，默认产品未切换。

## 原权威与真实作用域

- 子任务能力由原 `memory`/`todo` 声明投影，经现有 profile/discovery/dispatch 保存准确 schema；普通继承和显式选择共用原目录。RunAssembly 只装配已冻结选择，未选择的工具不自动补回，策略无法自行扩大能力。`read_only` 描述来源/工作目录，不无故禁止已明确选择的记忆或计划更新。
- `currentThread` 记忆绑定实际 child Thread，global 与已准入 project 使用原普通权限；父/兄弟私有笔记不继承。AgentPersonalization 和原 Storage 原子回执仍唯一拥有正文、revision 与写入，Catalog 仅持有原作用域和交付事实。系统记忆快照仍在既有成功压缩边界更新，工具暴露与上下文同步彼此独立。
- child 初始计划不存在，不复制父计划。实际 Thread/branch/history、KnowledgeStore、原 plan ref/CAS 和 mutation receipt 同时服务 ModelStep、PolicyAction 和公开用户编辑/fork。用户编辑计划不以 Agent 选择 todo 工具为前提。普通 worker 角色字符串不制造 child 受理；未准入、外域、Bot 和 context job 不借此获得普通计划。
- 取消、unknown 与真实效果继续分离。重开后按原 Run/operation/origin/epoch/intent 查询原 owner 回执，不重新写入；之后的用户修改不被恢复覆盖。计划与笔记不冒充文件 WorkingResult。

## 报告合同纠正

真实两种 origin 的 CAS 冲突暴露既有不一致：模型工具的失败曾被历史扫描永久聚合为整个 child 报告失败，策略图没有同样的历史形状。依据设计中 Run、Operation、报告和文件效果分离的合同，本次删除该额外失败推断，不给策略图添加另一套永久失败聚合。

报告结果遵循原 Run 终态及是否存在文本报告；一次冲突、读取新 ref、成功修正后可以正常完成。原冲突仍为 Failed/None，未知操作仍为 Unknown，文件/外部执行停止屏障保持原义。Succeeded 报告不表示每个工具成功，也不替用户确认模型对任务的解释正确。Failed/Cancelled Run 不因文本变为成功，无文本仍不伪造成功报告。

## 验证与边界

最终冻结源码上，完整 runtime **324 passed / 0 failed / 2 ignored**；kernel lib **70 passed / 0 failed / 11 ignored**。新增真实 Rust child/RunAssembly 链验证两种 origin、CAS 冲突后读取原 ref 并修正、原操作效果、未选工具不补入、真实 child scope 与取消后重开只读原回执。既有 RunAssembly 组合 **9/9**、capabilities **4/4**、领域与 memory/child 聚焦结果都已包含在完整 suite 中，不重复相加。

Host 四组 **34/34**，ThreadPlan UI **12/12**；Host 生产 bundle（524 reachable / 72 excluded）、测试类型和变更 lint 通过。原 Host main-only gate 的两 origin 失败用例修后通过；独审另复验两条原红，并以真实普通 memory owner 验证共享 global/project 写删与 parent/sibling/外项目私有 ID 越权拒绝。独审的 Storage 原语明确为 fixture。最终 all-targets 与准确身份构建通过；同源 fresh binary 的既有真实 Linux guardian/WorkingResult 消费者 **1/1** 通过。构建前后 Rust 输入清单完全一致。Linux x64 identity `0.9.25` 经原 ELF/manifest staging 校验，SHA-256 `63458e925f0c85cfffc2fcf4dde02d0476b171376d759f41e6ed996e54f00a9c`。该 OS 用例验证共享停止/文件结果消费者，不当作新 memory/plan 完整 Host E2E。独立审查无剩余具体阻断，接受本切片。

实际 KnowledgeStore/private worker、PlanService 和 PlanBridge 组件覆盖 child 初始空计划、父/兄弟隔离、两 origin、用户 CAS、固定 fork、关闭重开和原回执；该组件的 Catalog scope/history 明确是 fixture。普通 memory 组件使用真实 AgentPersonalization/createMemoryOwner，Storage 原语为 fixture，不冒充 Rust 持久化实测。UI 使用既有 ThreadPlan 组件；没有新增 child 专用编辑器或状态库。

完整 Host IPC 组合用例已补入既有 `child-dispatch-review.native.test.ts`，包含真实子任务、原 notes/plan owner、公开用户计划编辑、关开和报告。当前环境不能执行该完整路径，因此不计作通过。真实 provider 账号、平台验收和最终迁移保持各自边界；不把组件与原生日志拼成一次未执行的产品 E2E。

## 复跑入口

按[开发指南](../development.md)准备锁定工具链。从仓库根目录：

```bash
cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib child_memory_plan_review -- --test-threads=1
cargo test --manifest-path kernel/Cargo.toml -p varin-runtime -p varin-kernel -- --test-threads=2
(cd packages/web && bun x vitest run \
  application-host/lib/knowledge/plan-owner-review.test.ts \
  application-host/lib/kernel/memory-owner.test.ts \
  application-host/lib/kernel/child-profiles.test.ts \
  application-host/lib/kernel/policy-child.test.ts)
(cd packages/ui && bun x vitest run src/components/thread/ThreadPlan.behavior.test.tsx)
```

有可用产品环境后沿既有 kernel authority runner 复跑 child-dispatch、memory delivery/owner 与 plan integration native tests，使用相同源码生成的准确身份二进制。

最新状态见[实施台账](../plan/agent-runtime-implementation.md)、[运行时 owner](../../kernel/crates/varin-runtime/README.md)、[Host owner](../../packages/web/application-host/lib/kernel/DOCUMENTATION.md)与[计划数据 owner](../../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)。
