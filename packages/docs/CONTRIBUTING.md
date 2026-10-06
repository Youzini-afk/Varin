English | [简体中文](CONTRIBUTING.zh-CN.md)

# Docs Authoring Guide

This package is the source of truth for Varin docs content.
**Write English first; other locales are translations.**

## Voice & style

Write for someone trying to get something done — not for an engineer reading a
spec. Assume the reader may be non-technical. A page should feel quick to read,
never like a separate chore just to get through one screen.

These rules describe how we already write the docs. Follow them so the style
stays the same no matter who is writing.

### Who you're writing for

- Assume curiosity, not expertise. The reader knows what they want to do, not
  how Varin works inside.
- One page = one job. If a page is answering two unrelated questions, split it.

### Keep it short

- Lead with the task, not background. The first line should say what the page is
  for ("Use `varin tunnel` to expose a running Varin instance.").
- Cut anything that doesn't change what the reader does next.
- A basic page should fit in a screen or two. Long, dense reference pages (like
  Reverse Proxy) are the exception — and they say so in their first line ("Use
  this page if you run Varin behind...").

### Steps

- Number sequential actions; use bullets for options or unordered notes.
- Start each step with a verb: "Run", "Open", "Pick".
- End a procedure by telling the reader what success looks like, so they know
  they did it right.

```mdx
3. Run `varin --ui-password be-creative-here`.
4. Open the printed URL (usually `http://localhost:3000`).

You should land on the Varin session list. If you see it, the server is
running.
```

### Plain language

- Explain a term the first time it appears, in parentheses, in everyday words:
  - good: start a tunnel (a public link to your local Varin)
  - bad: start a tunnel — the reader doesn't know what that is yet
- Prefer common words over internal ones. "App", "version", "page" beat
  "surface", "instance", "route" when the meaning is the same. If an internal
  term is unavoidable, define it once.
- Don't reach for `SSE`, `WebSocket`, `buffering`, or header names unless the
  page is explicitly an advanced/operator page.

### Bullets and sentences

- Be consistent within a single list. Either all short fragments (lowercase, no
  period) or all full sentences (capital letter, period) — don't mix the two in
  one list.
- Use fragments for quick option lists; use full sentences for rules, warnings,
  or anything the reader must not misread.

### Link out instead of re-explaining

- Where a step can realistically fail, link to
  [Troubleshooting](/troubleshooting/) right there, not only at the bottom.
- Don't re-document something another page owns — link to it. (Quickstart points
  at Install for the actual install command instead of copying it.)

### Show, don't only tell

- A screenshot beats a paragraph for anything visual (where a button is, what a
  screen looks like). See [Images](#images) for how to add one.
- Always pair a screenshot with one line of text — the image supports the step,
  it isn't the whole step.

### Commands and code

- Make code blocks copy-paste-ready: real, working values. Only use a
  `<placeholder>` when the value is genuinely user-specific, and make that
  obvious (e.g. `app.example.com`, `~/.secrets/cf-token`).
- One command per idea. Don't chain unrelated commands just to look compact.

## Add a new docs page

1. Create the English source file in `packages/docs/content/docs/`.
   - Example: `packages/docs/content/docs/remote-access.mdx`
2. Add frontmatter at top:

   ```mdx
   ---
   title: Remote access
   description: Access Varin from outside the local network.
   ---
   ```

3. Use route-safe naming:
   - `foo.mdx` -> `/foo/`
   - `folder/index.mdx` -> `/folder/`
   - `folder/bar.mdx` -> `/folder/bar/`
4. Review translation coverage — see [Localization](#localization). Keep existing
   translations accurate; link to the English source when a translation is not available.
5. If the page is linked from the sidebar, add its localized labels too — see
   [Translate the sidebar](#translate-the-sidebar).
6. Run validation:

   ```bash
   bun run docs:validate
   ```

## Add a new sidebar section

Edit `packages/docs/sidebar.config.json`.

Example:

```json
{
  "label": "Advanced",
  "translations": {
    "zh-CN": "进阶"
  },
  "items": [{ "label": "Remote Access", "link": "/remote-access/", "translations": { "zh-CN": "远程访问" } }]
}
```

Rules:

- use trailing slash in links (`/page/`)
- every sidebar link must map to an existing English MDX file
- keep section labels short and task-oriented
- put English in `label`; put other locales in `translations`

## Images

Keep images inside the docs content tree and reference them with a **relative path**.
There is no renderer or sync workflow in this repository yet. A future Astro integration
should copy the complete content tree and configure image optimization.

```
content/docs/
  install.mdx          ->  ![Desktop app](./images/desktop.png)
  images/
    desktop.png
```

Rules:

- co-locate images under `content/docs/` (e.g. `content/docs/images/`); a
  relative `./images/...` reference lets a future renderer resolve the asset
- always set meaningful `alt` text (and translate it in localized pages)
- do **not** put docs images in the website repo's `public/` — it is not the
  source of truth for this content
- keep originals reasonably sized; configure responsive variants in the future renderer

For translations, reuse the same shared image when it carries no text. If a
screenshot contains localized UI text, add a per-locale copy under that locale's
folder (e.g. `uk/images/...`) and point the translated page at it.

Check that image files exist and render correctly when previewing a site; the current
content validator does not render images.

### Light / dark variants

To show a different screenshot per theme, add a `-light` / `-dark` pair and tag
each with `oc-light-only` / `oc-dark-only`. A future renderer must supply CSS for these
classes, keyed on Starlight's `data-theme`; the class names alone do not switch images.

Use the `<Image>` component so the images stay optimized while taking a class.
Add the imports right under the frontmatter:

```mdx
---
title: Install
description: ...
---

import { Image } from "astro:assets";
import desktopLight from "./images/desktop-light.png";
import desktopDark from "./images/desktop-dark.png";

<Image src={desktopLight} alt="Desktop app" class="oc-light-only" />
<Image src={desktopDark} alt="Desktop app" class="oc-dark-only" />
```

Notes:

- both files live under `content/docs/` like any other image
- give both the same `alt` (and translate it in localized pages)
- if you only have one image, just use the normal `![alt](./path.png)` form

## Localization

The docs are translated into the same languages the Varin app ships in.
**English is the source of truth and lives at the root of `content/docs/`.**
Every other language mirrors the English files under a locale folder.

### Supported locales

| Language | Content folder | Sidebar `translations` key |
| --- | --- | --- |
| English | _(root, no folder)_ | _(use `label`, do not add `en`)_ |
| Chinese (Simplified) | `zh-cn/` | `zh-CN` |
| Ukrainian | `uk/` | `uk` |
| Spanish | `es/` | `es` |
| Brazilian Portuguese | `pt-br/` | `pt-BR` |
| Korean | `ko/` | `ko` |
| Polish | `pl/` | `pl` |
| French | `fr/` | `fr` |
| Japanese | `ja/` | `ja` |

> [!IMPORTANT]
> The **content folder** uses the lowercase locale key (`en`, `pt-br`); the
> **sidebar `translations`** key uses the BCP-47 language tag (`en`, `pt-BR`).
> They look similar but are not interchangeable — Starlight resolves them with
> different rules. Everything else (`uk`, `es`, `ko`, `pl`, `fr`, `ja`) is identical
> in both columns.

A future docs site `astro.config.mjs` (`locales`) must match this table, with
English as the root locale. If a language is added or removed, update both places.

### Translate a page

Mirror the English file under each locale folder, keeping the **exact same
filename and path**. Starlight matches a translation to its English page by path.

```
content/docs/
  install.mdx              # English (source of truth)
  zh-cn/install.mdx        # Simplified Chinese
  uk/install.mdx           # Ukrainian
  es/install.mdx           # Spanish
  pt-br/install.mdx        # Brazilian Portuguese
  ko/install.mdx           # Korean
  pl/install.mdx           # Polish
  fr/install.mdx           # French
  ja/install.mdx           # Japanese

  guides/tunnels.mdx       # nested English page
  zh-cn/guides/tunnels.mdx # its Simplified Chinese translation
```

Each translated file needs its **own translated frontmatter** (`title` and
`description` are required by validation):

```mdx
---
title: Встановлення
description: Встановіть Varin для десктопа або вебу.
---
```

Translation coverage and quality are review concerns, not blocking validator rules.
Preserve each locale’s useful content and update changed facts consistently. When a
translation is missing, an explicit link to the English source is acceptable; do not
create placeholder translations just to satisfy a file count. Renderer fallback behavior
must be checked when a site is integrated.

### Translate the sidebar

Do **not** create separate sidebar entries per language and do **not** add a
locale prefix to `link` — Starlight prefixes the active locale automatically.
Instead, add a `translations` map (keyed by the BCP-47 tag from the table above)
to each section and item in `sidebar.config.json`:

```json
{
  "label": "Start here",
  "translations": {
    "zh-CN": "从这里开始",
    "uk": "Почніть тут",
    "es": "Empieza aquí",
    "pt-BR": "Comece aqui",
    "ko": "여기서 시작",
    "pl": "Zacznij tutaj",
    "fr": "Commencer ici",
    "ja": "ここから開始"
  },
  "items": [
    {
      "label": "Install",
      "link": "/install/",
      "translations": {
        "zh-CN": "安装",
        "uk": "Встановлення",
        "es": "Instalación",
        "pt-BR": "Instalação",
        "ko": "설치",
        "pl": "Instalacja",
        "fr": "Installation",
        "ja": "インストール"
      }
    }
  ]
}
```

Translations are optional in this source schema. When a renderer is added,
configure it to use the English `label` where a locale label is missing; this
repository does not yet run that rendering behavior.

### What not to translate

- brand and product nouns: Varin, Pi, VS Code, PWA, GitHub, Discord,
  macOS, SSH. Keep `OpenCode Go` only when documenting that third-party quota
  product. Do not reintroduce OpenChamber or an OpenCode server.
- code blocks, shell commands, file paths, flags, and config keys
- the page filename and the sidebar `link` (these stay identical across locales)

### Validate

`bun run docs:validate` walks every `.mdx` under `content/docs/` — **including
translations** — and fails if any page is missing `title` or `description`
frontmatter, or if an inline page link or sidebar `link` has no target. It also runs
the engineering documentation local-link check. English stays at the root of the content
tree. Run it after adding or translating pages; review command accuracy and localization
separately.

## Publishing

There is no separate docs-site repository or `docs-source.yml` workflow yet.
Keep this package accurate; `bun run docs:validate` is the current gate. When a
renderer is added, copy `content/docs/*` and `sidebar.config.json` into that
site and document the path in `DEPLOYMENT.md`.
