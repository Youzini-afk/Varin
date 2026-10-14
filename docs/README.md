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
| Varin 扩展、Pi 集成和运行时能力组合 | [扩展](extensions.md) |
| 信任、权限和特权边界 | [安全](security.md) |
| 开发命令与验证选择 | [开发](development.md)、[性能](performance.md) |
| 仍需真实环境证据的运行时场景 | [运行时验收](runtime-acceptance.md) |
| 部署、恢复、扩展开发和依赖维护 | [操作指南](ops/README.md) |

## 进行中的设计

[能力补齐设计](capability-design.md)：Documents 批量修改、分别配置模型的图像生成与编辑工具、
同进程扩展更新交接，以及 macOS / Wayland Computer Use。

[模型渠道、认证与 MCP 服务设计](model-mcp-design.md)：渠道接入与模型管理、独立认证与配置服务、
MCP 实现接入，以及这些能力对 Pi SDK 依赖的替换。这些方案尚待实施完成，与上面的当前系统说明分开阅读。

## 源码旁的说明

源码旁的 README / DOCUMENTATION 保留模块特有的不变量和实际入口：

- [Rust 内核](../kernel/README.md)、[Agent runtime crate](../kernel/crates/varin-runtime/README.md)、[Host adapters](../packages/web/application-host/lib/kernel/DOCUMENTATION.md)
- [Pi harness](../packages/pi-host/src/harness/README.md)、[Host harness](../packages/web/application-host/lib/harness/DOCUMENTATION.md)
- [Documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md)、[UI](../packages/ui/DOCUMENTATION.md)、[Knowledge](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)
- [application-client](../packages/application-client/README.md)、[protocol](../packages/protocol/README.md)、[extension-host](../packages/extension-host/README.md)

当前默认仍是 Pi；Agent runtime 为显式选择。支持边界写在所属领域，不能从旧的“阶段完成”推导默认已切换、Pi 已移除，
或所有安装包、模型、双机和桌面平台都已通过验证。
