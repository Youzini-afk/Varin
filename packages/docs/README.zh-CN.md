[English](README.md) | 简体中文

# Varin 公开文档

本目录保存 Varin 原生 Agent 工作空间的用户 Markdown/MDX 文档。
英文为源语言，另外八种译本覆盖相同任务。

- `content/docs/` — 根目录是英文，语种目录存放译本
- `sidebar.config.json` — 英文路由、标签及本地化标签
- [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) — 编写、本地化与检查
- [DEPLOYMENT.zh-CN.md](DEPLOYMENT.zh-CN.md) — 校验与当前发布状态

在仓库根目录运行：

```bash
bun run docs:validate
```

该命令检查 frontmatter、页面与侧边栏目标、工程文档本地链接，不渲染 MDX、检查翻译质量
或证明产品行为。请用当前代码和 package scripts 核实示例。本目录没有独立文档站渲染器或构建包。
