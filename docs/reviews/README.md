# 验收与证据

Status: evidence navigation — 区分当前边界、当时的验证结果和待评估候选。
Last updated: 2026-10-11

[当前状态](../status.md)引用这里的结论，不复制长篇验证记录。每份记录以自身的基线和场景为准；
本目录的存在不意味着本次文档整理重新运行了全部产品验收。

| 记录 | 负责什么 |
| --- | --- |
| [同任务发现与固定会话互读（2026-10-11）](runtime-family-reads-2026-10-11.md) | 原任务家系、真实 Run/固定原文、双调用来源、公开只读消费及取消/恢复边界 |
| [子任务普通记忆与计划（2026-10-10）](runtime-child-memory-plan-2026-10-10.md) | 原 notes/plan owner、子作用域、CAS/恢复、报告事实及复跑边界 |
| [子任务策略与规划模型（2026-10-10）](runtime-child-policy-2026-10-10.md) | child 策略/模型独立身份、静态工具范围、换代恢复与证据边界 |
| [子任务 Host 能力委派（2026-10-10）](runtime-child-host-delegation-2026-10-10.md) | 普通扩展与 MCP 原绑定、独立资源交接、子目录停止屏障及复跑边界 |
| [子任务执行配置与递归生命周期（2026-10-10）](runtime-child-profiles-2026-10-10.md) | 原配置/模型冻结、真实进程与代码结果、子树取消、恢复及复跑边界 |
| [原生运行时实现审阅（2026-10-09）](runtime-2026-10-09.md) | 两份设计的源码对照、本轮直接修正及仍阻止整体验收的结构/产品缺口 |
| [Harness 能力明细](harness-capabilities.md) | 按能力定位当前 owner、启用条件和证据边界；旧逐项清单与测量通过历史入口保留 |
| [Bot 与 Computer Use](bot-computer-use.md) | BC0–BC9 的后续补齐、当前实现缺口与原生平台证据 |
| [可组合执行环境](execution-environments.md) | EE1–EE6 当前接线、已记录的独立验收及剩余产品/跨机合同 |
| [Pi durable runtime](pi-durable-runtime.md) | 针对 Pi 1.0 的已记录评估，不代表采用了另一套生产 runtime |
| [性能记录](../performance.md) | 当前关键路径与可复现数据；性能不是按测试数量推算 |
| [协作设计中的验证节](../design/agent-collaboration-design.md) | D-339 角色、等待、会话互读和选定代码提交的已有验证 |

一次已结束的修复审计放入[历史归档](../archive/README.md)，而不是长期留在“当前验收”入口。
记录新验证时更新真正覆盖的场景和基线；未运行的平台或 provider 保留原边界。
