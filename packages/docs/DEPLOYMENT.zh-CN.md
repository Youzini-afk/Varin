[English](DEPLOYMENT.md) | 简体中文

# 文档校验与发布

本目录是公开使用指南的源码。指南由官网仓库 [Varin-web](https://github.com/Youzini-afk/Varin-web)
用 Starlight 渲染，发布在 [varin.dev/docs](https://varin.dev/docs/)。只在这里编辑指南；官网在构建时复制本目录，
不保留自己的副本。

正文位于 `content/docs/`，导航位于 `sidebar.config.json`，英文使用根语种。
语种目录与侧边栏键见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

在仓库根目录运行与 CI 相同的校验：

```bash
bun run docs:validate
```

`.github/workflows/ci.yml` 与 `.github/workflows/desktop-release.yml` 会执行该命令。
它检查 frontmatter 和本地链接，不验证渲染后的站点。

## 改动如何到达官网

官网构建时从 `main` 复制本目录：英文页面放在 `/docs/` 下，各语种放在 `/<语种>/docs/` 下。
`/install/`、`/zh-cn/install/` 这类根路径链接会改写为 `/docs/install/`、`/zh-cn/docs/install/`；
与 frontmatter 标题重复的第一个 `# 标题` 会去掉，因为站点自己显示标题。链接和标题按现有页面的写法即可。

推送到 `main` 且改动了 `packages/docs` 后，`.github/workflows/docs-site.yml` 会调用官网的 Cloudflare Pages
部署钩子，钩子地址保存在仓库密钥 `DOCS_SITE_DEPLOY_HOOK` 中。没有这个密钥时，工作流只报告未触发重建，
需要在 Cloudflare 控制台里重新部署最新版本。本地预览时把两个仓库放在同级目录，在 Varin-web 里运行
`bun run dev`，它会直接读取 `../Varin/packages/docs`。
