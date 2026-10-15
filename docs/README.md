# Varin 文档

从[架构](architecture.md)了解进程和状态归属，再沿问题进入下面的领域说明。具体 API、参数和命令以代码、schema、测试及
package.json 为准；文档解释职责、机制、约束和不显然的取舍。旧设计、阶段计划和验收批次保留在 Git 历史，不作为第二套当前合同。

| 要了解什么 | 入口 |
| --- | --- |
| 安装、启动和使用 | [项目 README](../README.md)、[用户文档](../packages/docs/README.md) |
| 系统如何装配、谁拥有状态 | [架构](architecture.md) |
| Agent loop、历史、请求、工具、恢复与续接 | [运行时](runtime.md) |
| 文件来源、WorkingState、进程、跨 Host 和恢复 | [资源](resources.md) |
| 上下文、检索、材料、知识和记忆 | [检索与上下文](retrieval.md) |
| 外壳、Profile、Documents 和编辑器 | [工作台](workbench.md) |
| Varin 扩展和原生运行时能力组合 | [扩展](extensions.md) |
| 信任、权限和特权边界 | [安全](security.md) |
| 开发命令与验证选择 | [开发](development.md)、[性能](performance.md) |
| 仍需真实环境证据的运行时场景 | [运行时验收](runtime-acceptance.md) |
| 部署、恢复、扩展开发和依赖维护 | [操作指南](ops/README.md) |

## 源码旁的说明

源码旁的 README / DOCUMENTATION 保留模块特有的不变量和实际入口：

- [Rust 内核](../kernel/README.md)、[Agent runtime crate](../kernel/crates/varin-runtime/README.md)、[Host adapters](../packages/web/application-host/lib/kernel/DOCUMENTATION.md)
- [Host harness](../packages/web/application-host/lib/harness/DOCUMENTATION.md)
- [Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md)、[UI](../packages/ui/DOCUMENTATION.md)、[Knowledge](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)
- [模型、账号与设置](../packages/web/application-host/lib/models/DOCUMENTATION.md)、[MCP 服务](../packages/web/application-host/lib/mcp/DOCUMENTATION.md)、[Computer Use](../packages/web/application-host/lib/computer/DOCUMENTATION.md)
- [application-client](../packages/application-client/README.md)、[protocol](../packages/protocol/README.md)、[extension-host](../packages/extension-host/README.md)

当前对话由原生 Agent runtime 执行。旧设计、过程记录和已移除运行时的指导留在 Git 历史；
源码接线、定向测试、安装包与真实环境验收分别说明，不互相代替。
