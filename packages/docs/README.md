English | [简体中文](README.zh-CN.md)

# Varin user guides

Connect a model, start a conversation, and work with files and tools. You can read these Markdown/MDX guides directly in the repository.

## Start here

| You want to | Guide |
| --- | --- |
| Install and open Varin | [Installation](content/docs/install.mdx), [quickstart](content/docs/quickstart.mdx) |
| Connect a model or local service | [Providers and models](content/docs/providers.mdx) |
| Work with a project | [Projects](content/docs/projects.mdx), [Git](content/docs/git.mdx), [worktrees](content/docs/worktrees.mdx) |
| Give an agent context and tools | [Context](content/docs/context.mdx), [skills](content/docs/skills.mdx), [MCP](content/docs/mcp.mdx) |
| Schedule work | [Scheduled tasks](content/docs/scheduled-tasks.mdx) |
| Connect another device | [Device connections](content/docs/connect-devices.mdx), [mobile](content/docs/mobile.mdx) |
| Investigate a problem | [Troubleshooting](content/docs/troubleshooting.mdx) |

## Languages

[English](content/docs/index.mdx) · [简体中文](content/docs/zh-cn/index.mdx) · [Українська](content/docs/uk/index.mdx) · [Español](content/docs/es/index.mdx) · [Português (Brasil)](content/docs/pt-br/index.mdx) · [한국어](content/docs/ko/index.mdx) · [Polski](content/docs/pl/index.mdx) · [Français](content/docs/fr/index.mdx) · [日本語](content/docs/ja/index.mdx)

## Maintain these guides

English source pages live at `content/docs/`; translations use locale directories. `sidebar.config.json` defines routes and navigation labels.

Read the [writing guide](CONTRIBUTING.md) for page structure, links, and translations. Run `bun run docs:validate` from the repository root to check frontmatter and links. Rendering and publishing status are described in [DEPLOYMENT.md](DEPLOYMENT.md); this package currently contains documentation source, without a standalone site renderer.

For system design and code contributions, see the [engineering documentation](../../docs/README.md) and [contribution guide](../../.github/CONTRIBUTING.md).
