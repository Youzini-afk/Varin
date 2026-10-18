[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | 简体中文 | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# 为 Varin 贡献

修复问题、改进工作流程、开发扩展、编写文档，以及分享平台实测结果，都是参与 Varin 的方式。

## 从哪里开始

先在 [Issues](https://github.com/Youzini-afk/Varin/issues) 和 [Pull Requests](https://github.com/Youzini-afk/Varin/pulls) 中查找相关工作。第一次贡献可以从一个小而明确、能够复现的问题开始。较大的改动，适合尽早说明要改善的工作流程，并分享草图或原型。

问题报告本身也很有帮助。请提供版本、安装方式、实际现象，以及复现步骤或示例。日志和截图中请移除密钥与私人内容。漏洞报告请走[安全策略](SECURITY.zh-CN.md)中的渠道。

## 准备开发环境

Fork 并克隆仓库。源码开发使用 Node.js 24、Bun 1.3.14、Git、Rust、C/C++ 工具链和 CMake。具体环境与命令见[开发指南](../../docs/development.md)。

在仓库根目录运行：

```sh
bun install --frozen-lockfile
git switch -c your-change
bun run dev
```

打开终端打印的 UI 地址。开发桌面端使用 `bun run electron:dev`。改动需要实际运行 Agent 时，在设置中配置模型。

修改前阅读 [AGENTS.md](../../AGENTS.md) 及代码附近的 README 或 DOCUMENTATION。

## 找到对应模块

| 修改内容 | 入口 |
| --- | --- |
| 对话、面板、编辑器和共享界面 | [packages/ui](../../packages/ui/DOCUMENTATION.md) |
| 模型连接、应用服务与远程访问 | [Application Host](../../packages/web/README.md) |
| Agent 执行、历史、文件和进程 | [Rust 内核](../../kernel/README.md) |
| 扩展接口与开发 | [扩展作者指南](../../docs/ops/varin-extension-authoring.md)、[示例](../../examples/extensions/README.md) |
| 使用指南与翻译 | [公开文档编写](../../packages/docs/CONTRIBUTING.zh-CN.md) |
| 系统各部分如何配合 | [架构](../../docs/architecture.md)、[文档索引](../../docs/README.md) |

沿现有职责修改：Rust 运行时管理会话与执行，Application Host 提供可信服务，客户端通过共享 API 呈现这些能力。保留用户文件与数据，扩展沿用既有公开接口。

## 实现与验证

一个 Pull Request 聚焦一个完整的问题。阅读实现及其调用方，沿用已有代码风格与共享 UI 组件，并更新描述该行为的文档。

验证围绕实际改动选择。优先复用已有测试；重要行为或已复现的问题，适合补充小而明确的回归测试。[开发指南](../../docs/development.md#修改与验证)按改动类型列出了检查方式。文档和链接修改使用 `bun run docs:validate`。

界面改动附上对应状态的截图或录屏；性能改动提供有代表性的测量。记录实际执行的命令和结果，以及受环境影响尚未验证的相关行为。

公开使用指南和仓库介绍以英文为源语言。修改行为、命令或链接时，同步现有译本。主工程文档使用中文，包内和源码旁文档沿用已有语言。

## 提交 Pull Request

先说明问题和改动后的行为，再给出相关验证。关联已有 Issue，必要时附图。[PR 模板](../pull_request_template.md)提供了这些信息的填写位置。

提交标题简洁描述改动。解决冲突时核对预期行为，保留与本次修改无关的工作。

## 社区与许可证

请遵守[行为准则](CODE_OF_CONDUCT.zh-CN.md)。

提交贡献即表示你同意相关内容可按 [AGPL-3.0-only](../../LICENSE) 分发。引入第三方内容时保留其版权与许可声明，详见 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)。
