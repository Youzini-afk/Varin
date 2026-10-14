English | [简体中文](DEPLOYMENT.zh-CN.md)

# Documentation validation and publishing

This repository contains the public documentation source. No docs-site renderer, hosting
pipeline or automatic source sync is configured here.

Content is in `content/docs/`; navigation is in `sidebar.config.json`. English is the root
locale. Locale directories and sidebar translation keys are listed in
[CONTRIBUTING.md](CONTRIBUTING.md).

Run the same validation used by CI from the repository root:

```bash
bun run docs:validate
```

`.github/workflows/ci.yml` and `.github/workflows/desktop-release.yml` invoke this check.
It validates frontmatter and local links, not a rendered site. A future renderer should
consume this directory and preserve its routes and locale mapping; publication needs its
own configured build and deployment workflow.
