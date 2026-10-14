[English](DEPLOYMENT.md) | 简体中文

# 文档校验与发布

本仓库保存公开文档源码，目前未配置文档站渲染器、托管流水线或自动源码同步。

正文位于 `content/docs/`，导航位于 `sidebar.config.json`，英文使用根语种。
语种目录与侧边栏键见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

在仓库根目录运行与 CI 相同的校验：

```bash
bun run docs:validate
```

`.github/workflows/ci.yml` 与 `.github/workflows/desktop-release.yml` 会执行该命令。
它检查 frontmatter 和本地链接，不验证渲染后的站点。未来渲染器应使用本目录，保留现有路由
及语种映射；发布仍需单独配置构建和部署流程。
