# Varin 文档

第一次使用，从[项目介绍](../.github/readme/README.zh-CN.md)和[使用指南](../packages/docs/README.zh-CN.md)开始。
准备参与开发，先看[贡献指南](../.github/translations/CONTRIBUTING.zh-CN.md)和[开发环境](development.md)。
下面按问题整理实现说明，方便定位相关模块。

| 要了解什么 | 入口 |
| --- | --- |
| 安装、启动和使用 | [项目 README](../.github/readme/README.zh-CN.md)、[用户文档](../packages/docs/README.zh-CN.md) |
| 系统如何装配、谁拥有状态 | [架构](architecture.md) |
| Agent loop、历史、请求、工具、恢复与续接 | [运行时](runtime.md) |
| 角色、任务复用、文件交接、状态收纳和代码交换 | [Agent 协作](collaboration.md) |
| 长期总助手、事项、后台回报与连续记忆 | [Bot](bot.md) |
| Codex、Claude Code、Pi、ACP 的会话与派发 | [外部 Agent](external-agents.md) |
| 文件来源、WorkingState、进程、跨 Host 和恢复 | [资源](resources.md) |
| 上下文、检索、材料、知识和记忆 | [检索与上下文](retrieval.md) |
| 外壳、Profile、Documents 和编辑器 | [工作台](workbench.md) |
| 聊天 HTML、流式作品、画面读取与引用 | [交互内容](interactive-content.md) |
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

具体 API、参数和命令以代码、schema 与 package scripts 为准。文档说明当前机制及取舍，历史设计保留在 Git 中。

## 设计与交互参考

以下保留产品取舍、视觉稿或尚待继续讨论的设计。实际行为以领域文档和代码为准；原型使用示例数据，不连接 Host。

- [长期总助手、连续上下文与记忆](design/bot-assistant.md)：当前合同见[长期总助手](bot.md)。
- [设置体验](design/chat-settings-experience.md)、[设置设计稿](design/settings-redesign.html)：已接入生产设置页；[聊天与设置的早期设计稿](design/chat-settings-preview.html)中的设置部分已被取代。
- [用量与价格](design/usage-dashboard.md)、[用量页面交互稿](design/usage-preview/index.html)：已接入设置页；当前统计口径见[运行时](runtime.md)和[工作台](workbench.md)。
- [上下文准备与替换交互稿](design/context-compaction/index.html)：当前行为见[工作台](workbench.md#上下文准备与替换)和[运行时](runtime.md)。
- [快速检索、按需隔离与工具可靠性](design/retrieval-isolation-and-tool-reliability.md)：边界见原文第 17 节；隔离的后续架构由下面的版本化工作区设计接续。
- [外部 Harness 接入与跨 Agent 协作](design/external-harness-integration.md)：当前支持边界见[外部 Agent](external-agents.md)；CLI / Skills / MCP 共享按产品决定暂缓。
- [Varin 形象：趴窗台](design/varin-figure.md)、[交互设计稿](design/varin-figure-preview/index.html)、[舞台设计稿](design/varin-figure-preview/stage.html)：已实现为 `BotFigure` 和 Bot 区舞台。

## 持续演进的设计

- [聊天定点引用与可拖动输入标记](design/chat-quoting-and-draggable-markers.md)：实施中；按选区／正文块或具体对象引用，在输入框用可拖动的引用与图片标记安排位置，统一撤销、附件交付和历史定位，内部来源信息不再拼入模型正文。
- [文件与终端编码](design/text-encoding.md)：设计提案；GBK／GB2312 项目的无感读改写、原格式保存、统一文件文本能力，以及独立的终端 I/O 合同，尚未实施。
- [插件中心、公开收录目录与作者发行来源](design/plugin-center-and-marketplace.md)：设计方案；市场维护列表展示资料，安装更新直连作者来源，插件配置与业务状态由插件页面负责。包含公开站点、发行包、账号接入及实施验收设计。
- [Varin 总助手：持续交流、工作概览与设备空间](design/varin-conversation-and-workspaces.md)：独立发送默认、工作详情、电脑与文件空间、设备连接和手机状态胶囊已接入；当前合同见 [Bot](bot.md)、[资源](resources.md)和[工作台](workbench.md)。[交互稿](design/varin-conversation-preview/index.html)保留视觉与布局参考。
- [外部 Agent 输入框后续演进](design/external-agent-composer.md)：自动准备、空闲回收、能力缓存、默认值、统一工具栏与协议上下文已接入；当前合同见[外部 Agent](external-agents.md)。失败分类和配置变化提示留待后续。
- [Computer Use 原生辅助程序与构建交付](design/native-computer-helper.md)：Windows 已改为随包原生 `VarinComputer.exe` 并接通构建、签名配置和 Host 生命周期；正式证书签名与平台实机验收仍待完成。
- [聊天正文、交互内容与原生能力联动](design/conversation-content-and-interaction.md)：核心链路已实施；记录正文交互、作品修订、草稿联动、状态继承与回收的设计及验收边界。当前合同见[交互内容](interactive-content.md)。
- [联网检索后续验证与扩展](design/web-retrieval.md)：核心合同已接入，见[检索](retrieval.md#web学术与文档材料)；保留真实任务比较、平台验收和新增渠道的选择空间。
- [增量上下文管理](design/incremental-context-management.md)：待讨论；摘要块、原文回读等为候选思路，需重新判断理解连续性、总成本与实现必要性，尚未确定实施方向。
- [可替换执行循环：Run Driver](design/pluggable-run-drivers.md)：设计提案；默认 Rust driver、自由循环与真实执行 owner 的边界，尚未实现。

- [Bot 工作台：界面、交互与动效](design/bot-ui.md)、[交互稿](design/bot-preview/index.html)：桌面主体、形象和舞台已实施（第 12 节），其余部分见原文。
- [动效与交互：丝滑到底](design/motion-and-interaction.md)、[可交互原型](design/motion-preview/index.html)：P0–P4 已在 main 上实施；真机、Electron 和读屏验收（第 7 节）仍待进行。
- [主与子 Agent 的版本化工作区](design/versioned-agent-workspaces.md)：引擎和 WinFsp / macFUSE / FUSE 适配器已接入，平台安装与挂载的实际行为以对应环境验收为准；目标合同见第 16 节。
- [Q 版桌宠与主题差分](design/desktop-companion.md)：桌宠设计的总入口，已合入 main 并接入多会话 Bot 归属，美术逐帧验收与 Windows/macOS 原生验证仍待进行。同一系列的当前稿：
  - [主管式桌宠](design/desktop-companion-director.md)、[主管演出](design/desktop-companion-director-performance.md)
  - [动作语言 v5](design/desktop-companion-motion-language-v5.md)、[虚拟案卷与身体接触](design/desktop-companion-prop-contact-v5.md)
  - [多任务注意力](design/desktop-companion-multitask-attention.md)：只读注意力和面板底座已实施，主管演出仍是候选。
  - 视觉资料与进度见独立仓库 Varin-companion-assets 的[桌宠素材索引](https://github.com/Youzini-afk/Varin-companion-assets/blob/main/source/README.md)。
