[English](https://github.com/Youzini-afk/Varin/blob/main/.github/CONTRIBUTING.md) | 简体中文 | [繁體中文](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.zh-TW.md) | [Français](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.fr.md) | [日本語](https://github.com/Youzini-afk/Varin/blob/main/.github/translations/CONTRIBUTING.ja.md)

# 为 Varin 贡献

Varin 是一个应当开箱即用的 Agent Harness。最有价值的贡献，是让同一个模型走得更远，或让默认体验对使用者更好用：

- 工具，以及工具结果如何呈现给模型和对话；
- 上下文、检索与记忆；
- 模型服务商与协议；
- 扩展、模板与示例；
- 编程、科研、办公、通用四种模式的默认配置；
- 文档与翻译；
- 各平台的实测报告：Windows、macOS、Linux、Docker 或远程 Host。

## 从哪里开始

先在 [Issues](https://github.com/Youzini-afk/Varin/issues)、[Pull Requests](https://github.com/Youzini-afk/Varin/pulls) 和[讨论区](https://github.com/Youzini-afk/Varin/discussions)中查找相关工作。第一次贡献可以从一个小而明确、能够复现的问题开始，标有 [good first issue](https://github.com/Youzini-afk/Varin/labels/good%20first%20issue) 的 Issue 适合入手。较大的改动，先在 [Ideas](https://github.com/Youzini-afk/Varin/discussions/categories/ideas) 或功能建议中说明要改善的工作流程，并尽早分享草图或原型。使用问题请到 [Q&A](https://github.com/Youzini-afk/Varin/discussions/categories/q-a)；其他渠道见[获取帮助](SUPPORT.zh-CN.md)。

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
| Agent 循环、工具、上下文、权限、重试与恢复 | [Agent 运行时](../../kernel/crates/varin-runtime/README.md)、[运行时](../../docs/runtime.md)、[检索与上下文](../../docs/retrieval.md) |
| Agent 使用的网页、科研、文档、Office、浏览器与 MCP 服务 | [Host harness 服务](../../packages/web/application-host/lib/harness/DOCUMENTATION.md) |
| 模型服务商、协议与账号 | [模型与账号](../../packages/web/application-host/lib/models/DOCUMENTATION.md) |
| 应用服务与远程访问 | [Application Host](../../packages/web/README.md) |
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

请遵守[行为准则](CODE_OF_CONDUCT.zh-CN.md)。讨论区、Issues 和 Pull Request 是交流项目的公共场所，[获取帮助](SUPPORT.zh-CN.md)说明了各自适合什么。

提交贡献即表示你同意相关内容可按 [AGPL-3.0-only](../../LICENSE) 分发。引入第三方内容时保留其版权与许可声明，详见 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md)。
