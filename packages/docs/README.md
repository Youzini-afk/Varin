English | [简体中文](README.zh-CN.md)

# Varin public documentation

This directory contains the user-facing Markdown/MDX documentation for Varin's native
Agent workspace. English is the source locale; eight translated locales cover the same tasks.

- `content/docs/` — English pages at the root and translations in locale directories
- `sidebar.config.json` — English route/label definitions with localized labels
- [CONTRIBUTING.md](CONTRIBUTING.md) — writing, localization and review
- [DEPLOYMENT.md](DEPLOYMENT.md) — validation and current publishing status

From the repository root, run:

```bash
bun run docs:validate
```

The command checks required frontmatter, page/sidebar targets and engineering-document local
links. It does not render MDX, check translation quality or prove product behavior. Verify
examples against current code and package scripts. This directory has no standalone site
renderer or package build.
