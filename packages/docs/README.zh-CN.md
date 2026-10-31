[English](README.md) | 简体中文

# Varin 使用指南

从连接模型、开始对话，到使用文件与工具，可以按手头的任务查找指南。可以在 [varin.dev/docs](https://varin.dev/docs/) 阅读，也可以直接在仓库中阅读这些 Markdown/MDX 文件。

## 从这里开始

| 想做什么 | 对应指南 |
| --- | --- |
| 安装并打开 Varin | [安装](content/docs/zh-cn/install.mdx)、[快速开始](content/docs/zh-cn/quickstart.mdx) |
| 连接模型或本地服务 | [模型渠道](content/docs/zh-cn/providers.mdx) |
| 处理项目 | [项目](content/docs/zh-cn/projects.mdx)、[Git](content/docs/zh-cn/git.mdx)、[worktree](content/docs/zh-cn/worktrees.mdx) |
| 为 Agent 提供上下文和工具 | [上下文](content/docs/zh-cn/context.mdx)、[skills](content/docs/zh-cn/skills.mdx)、[MCP](content/docs/zh-cn/mcp.mdx) |
| 安排后续工作 | [定时任务](content/docs/zh-cn/scheduled-tasks.mdx) |
| 连接另一台设备 | [设备连接](content/docs/zh-cn/connect-devices.mdx)、[移动端](content/docs/zh-cn/mobile.mdx) |
| 排查问题 | [故障排查](content/docs/zh-cn/troubleshooting.mdx) |

## 语言

[English](content/docs/index.mdx) · [简体中文](content/docs/zh-cn/index.mdx) · [繁體中文](content/docs/zh-tw/index.mdx) · [Français](content/docs/fr/index.mdx) · [日本語](content/docs/ja/index.mdx)

## 维护这些指南

英文源页位于 `content/docs/`，译本存放在对应语种目录。`sidebar.config.json` 管理路由与导航标签。

页面结构、链接和翻译约定见[编写指南](CONTRIBUTING.zh-CN.md)。在仓库根目录执行 `bun run docs:validate`，检查 frontmatter 与链接。页面由官网渲染并发布，见 [DEPLOYMENT.zh-CN.md](DEPLOYMENT.zh-CN.md)。

系统设计与代码贡献入口见[工程文档](../../docs/README.md)和[贡献指南](../../.github/translations/CONTRIBUTING.zh-CN.md)。
