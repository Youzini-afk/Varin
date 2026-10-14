English | [简体中文](CONTRIBUTING.zh-CN.md)

# Writing public docs

Write for someone trying to finish a task. Lead with what to do, keep procedures short,
and explain what success or a recoverable failure looks like. Use the current UI and
Host implementation to verify labels, commands, ownership and behavior.

Conversations use native Threads and branches. The Application Host owns model channels,
accounts, resource configuration and MCP connections. A navigation project, a conversation
and its execution source are distinct; describe the relevant selection rather than assuming
that switching a folder retargets work. Preserve useful instructions when updating a page.

## Pages and links

English lives at `content/docs/`; translations use the same filename under their locale.
Every page needs translated `title` and `description` frontmatter:

```mdx
---
title: Example task
description: A short description of what the reader can do.
---
```

- `example.mdx` maps to `/example/`; `guides/example.mdx` maps to `/guides/example/`.
- Use trailing slashes in page links and locale prefixes in translated body links.
- Keep code, paths, API names and product identifiers unchanged in translations.
- Keep existing translations aligned with behavior changes. Do not create empty placeholders
  to meet a page count; link to the source if a translation is genuinely unavailable.
- Put short English labels and unprefixed routes in `sidebar.config.json`; localized labels
  belong in each item's `translations` map.

## Locales

| Language | Folder | Sidebar key |
| --- | --- | --- |
| English | root | `label` |
| Simplified Chinese | `zh-cn` | `zh-CN` |
| Ukrainian | `uk` | `uk` |
| Spanish | `es` | `es` |
| Brazilian Portuguese | `pt-br` | `pt-BR` |
| Korean | `ko` | `ko` |
| Polish | `pl` | `pl` |
| French | `fr` | `fr` |
| Japanese | `ja` | `ja` |

## Examples and images

Use commands that match repository scripts. Clearly mark user-specific values. Never include
credentials or private user data. Explain meaningful limits and uncertainty; a failed response
does not prove that an operation did not run.

Only use screenshots from the current product. Store any new docs images under the content
tree, reference them with relative paths, and provide meaningful translated alt text. Remove
obsolete screenshots and references rather than presenting them as the current UI. The content
validator does not render images or MDX components.

## Check your changes

From the repository root:

```bash
bun run docs:validate
```

This checks required frontmatter, page/sidebar routes and engineering-document local links.
Review behavior, translations and executable examples separately. Rendering and publishing are
described in [DEPLOYMENT.md](DEPLOYMENT.md); this package currently has no site renderer.
