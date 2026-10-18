[English](README.md) | 简体中文

# Varin 使用指南

从连接模型、开始对话，到使用文件与工具，可以按手头的任务查找指南。这些 Markdown/MDX 文档可直接在仓库中阅读。

## 从这里开始

| 想做什么 | 对应指南 |
| --- | --- |
| 安装并打开 Varin | [安装](content/docs/zh-cn/install.mdx)、[快速开始](content/docs/zh-cn/quickstart.mdx) |
| 连接模型或本地服务 | [提供商与模型](content/docs/zh-cn/providers.mdx) |
| 处理项目 | [项目](content/docs/zh-cn/projects.mdx)、[Git](content/docs/zh-cn/git.mdx)、[worktree](content/docs/zh-cn/worktrees.mdx) |
| 为 Agent 提供上下文和工具 | [上下文](content/docs/zh-cn/context.mdx)、[skills](content/docs/zh-cn/skills.mdx)、[MCP](content/docs/zh-cn/mcp.mdx) |
| 安排后续工作 | [定时任务](content/docs/zh-cn/scheduled-tasks.mdx) |
| 连接另一台设备 | [设备连接](content/docs/zh-cn/connect-devices.mdx)、[移动端](content/docs/zh-cn/mobile.mdx) |
| 排查问题 | [故障排查](content/docs/zh-cn/troubleshooting.mdx) |

## 语言

[English](content/docs/index.mdx) · [简体中文](content/docs/zh-cn/index.mdx) · [Українська](content/docs/uk/index.mdx) · [Español](content/docs/es/index.mdx) · [Português (Brasil)](content/docs/pt-br/index.mdx) · [한국어](content/docs/ko/index.mdx) · [Polski](content/docs/pl/index.mdx) · [Français](content/docs/fr/index.mdx) · [日本語](content/docs/ja/index.mdx)

## 维护这些指南

英文源页位于 `content/docs/`，译本存放在对应语种目录。`sidebar.config.json` 管理路由与导航标签。

页面结构、链接和翻译约定见[编写指南](CONTRIBUTING.zh-CN.md)。在仓库根目录执行 `bun run docs:validate`，检查 frontmatter 与链接。渲染和发布状态见 [DEPLOYMENT.zh-CN.md](DEPLOYMENT.zh-CN.md)；本包当前保存文档源码，尚无独立文档站渲染器。

系统设计与代码贡献入口见[工程文档](../../docs/README.md)和[贡献指南](../../.github/translations/CONTRIBUTING.zh-CN.md)。
