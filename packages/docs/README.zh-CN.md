[English](README.md) | 简体中文

# Varin 文档源码

本包是 Varin 公开文档的源码。**英文是默认语言和源语言。**

## 目录

- `content/docs/*.mdx` — 英文文档页（源语言，无前缀路径）
- `content/docs/zh-cn/*.mdx` — 简体中文译本
- `content/docs/<locale>/*.mdx` — 其他语种译本（如 `uk/`、`pt-br/`、`fr/`）；见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md) 的「本地化」
- `sidebar.config.json` — Starlight 侧边栏；`label` 为英文，其他语种写在 `translations`
- `CONTRIBUTING.md` — 英文编写指南
- `CONTRIBUTING.zh-CN.md` — 简体中文编写指南
- `DEPLOYMENT.md` — 校验与尚未自动化的发布说明

未来的 Starlight 站点应把根 locale 配成英文：

```js
locales: {
  root: { label: "English", lang: "en" },
  "zh-CN": { label: "简体中文", lang: "zh-CN" },
  // ...
}
```

## 本地校验

在仓库根目录运行：

```bash
bun run docs:validate
```

会检查：

- 每个 MDX 页都有 `title`、`description` frontmatter
- 侧边栏链接能对应到默认（英文）路由
- 正文 Markdown 页面链接有目标；同时检查工程文档的本地链接

它不检查品牌、翻译质量，也不检查命令是否仍与代码一致。

## 发布模型

文档源码在本仓库。`.github/workflows` 里还没有独立的文档站工作流。在公开站点上线前，
这些页面就是 GitHub 和未来 Starlight 渲染器的权威内容。
