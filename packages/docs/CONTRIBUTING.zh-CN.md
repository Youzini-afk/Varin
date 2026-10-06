[English](CONTRIBUTING.md) | 简体中文

# 文档编写指南

本包是 Varin 公开文档的源码。**先写英文，再补译本。**

## 语气与风格

写给想把事情做完的人，而不是在读规格的工程师。假定读者不一定懂技术。一页应该很快读完，
不要像额外作业。

下面这些规则就是现有文档的写法。按它们写，风格才不会因人而异。

### 写给谁

- 假定读者有好奇心，而不是已经懂内部实现。他们知道自己想做什么，不知道 Varin 里面怎么跑。
- 一页只做一件事。如果一页在回答两个不相关的问题，就拆开。

### 写短

- 先写任务，再写背景。第一句就说明这一页是干什么的（「用 `varin tunnel` 把正在运行的
  Varin 暴露出去。」）。
- 删掉不会改变读者下一步动作的内容。
- 普通页面应在一两屏内读完。像「反向代理」这样的长参考页是例外——它们会在第一句说清楚
  （「如果你在……后面运行 Varin，请使用本页。」）。

### 步骤

- 有先后顺序的动作用数字；选项或无序说明用列表。
- 每一步用动词开头：「运行」「打开」「选择」。
- 流程结束时告诉读者成功长什么样，好确认自己做对了。

```mdx
3. 运行 `varin --ui-password be-creative-here`。
4. 打开打印出的 URL（通常是 `http://localhost:3000`）。

你应该看到 Varin 会话列表。如果看到了，说明服务已在运行。
```

### 用白话

- 术语第一次出现时，用括号、日常说法解释：
  - 好：启动一条隧道（指向本机 Varin 的公开链接）
  - 差：启动一条隧道——读者还不知道那是什么
- 能用常见词就不用内部词。「应用」「版本」「页面」优于「surface」「instance」「route」。
  内部词避不开时，解释一次。
- 除非这一页明确是给运维/进阶读者的，否则不要写 `SSE`、`WebSocket`、`buffering` 或请求头名字。

### 列表和句子

- 同一列表里保持一致：要么全是短片段（不用句号），要么全是完整句子（有句号）——不要混用。
- 快速选项用片段；规则、警告、不能读错的内容用完整句子。

### 能链出去就不要重写

- 某一步很可能失败时，当场链到[问题排查](/troubleshooting/)，不要只放在文末。
- 别的页面已经写过的内容，链接过去，不要再写一遍。（快速开始链到安装页拿安装命令，而不是复制一遍。）

### 能展示就不要只讲

- 按钮在哪、屏幕长什么样，一张截图比一段话有用。加图方式见[图片](#图片)。
- 截图必须配一句说明——图是在帮步骤，不是整步只有图。

### 命令和代码

- 代码块要能直接复制：用真实能跑的值。只有值确实因人而异时才用 `<占位符>`，并写清楚
  （例如 `app.example.com`、`~/.secrets/cf-token`）。
- 一个想法一条命令。不要为了看起来紧凑而把无关命令串在一起。

## 新增文档页

1. 在 `packages/docs/content/docs/` 创建英文源文件。
   - 例如：`packages/docs/content/docs/remote-access.mdx`
2. 文件顶部加 frontmatter：

   ```mdx
   ---
   title: Remote access
   description: Access Varin from outside the local network.
   ---
   ```

3. 使用对路由安全的命名：
   - `foo.mdx` -> `/foo/`
   - `folder/index.mdx` -> `/folder/`
   - `folder/bar.mdx` -> `/folder/bar/`
4. 检查翻译覆盖——见[本地化](#本地化)。保持现有译本准确；缺少译本时可以明确链接到英文源文。
5. 如果侧边栏要链到这一页，同时补侧边栏译文——见[翻译侧边栏](#翻译侧边栏)。
6. 跑校验：

   ```bash
   bun run docs:validate
   ```

## 新增侧边栏分组

编辑 `packages/docs/sidebar.config.json`。

示例：

```json
{
  "label": "Advanced",
  "translations": {
    "zh-CN": "进阶"
  },
  "items": [{ "label": "Remote Access", "link": "/remote-access/", "translations": { "zh-CN": "远程访问" } }]
}
```

规则：

- 链接带尾部斜杠（`/page/`）
- 每个侧边栏链接都必须对应已有的英文 MDX 文件
- 分组标题要短，并且面向任务
- `label` 使用英文，其他语言放在 `translations`

## 图片

图片放在文档内容树里，用**相对路径**引用。目前仓库没有渲染器或同步流程；未来接入 Astro 时，
应复制完整内容树，并配置图片优化。

```
content/docs/
  install.mdx          ->  ![桌面应用](./images/desktop.png)
  images/
    desktop.png
```

规则：

- 图片和文档放在一起（例如 `content/docs/images/`）；相对路径 `./images/...` 便于未来渲染器定位图片
- 必须写有意义的 `alt`（并在各语种页面里翻译）
- **不要**把文档图片放到网站仓库的 `public/`——那不是本包内容的权威源
- 原图保持合理大小；未来渲染器应配置响应式变体

译本在图片没有文字时复用同一张共享图。截图里有本地化 UI 文字时，把该语种的图放进对应
locale 目录（例如 `uk/images/...`），并让译本指向它。

预览站点时检查图片文件是否存在、能否正确显示；当前内容校验器不会渲染图片。

### 浅色 / 深色变体

要按主题显示不同截图时，准备 `-light` / `-dark` 一对，并分别加上 `oc-light-only` /
`oc-dark-only`。未来的渲染器需要为这些类提供跟随 Starlight `data-theme` 的 CSS；
仅添加类名不会自动切换图片。

用 `<Image>` 组件，这样图片仍会被优化，同时能加 class。把 import 写在 frontmatter 下面：

```mdx
---
title: 安装
description: ...
---

import { Image } from "astro:assets";
import desktopLight from "./images/desktop-light.png";
import desktopDark from "./images/desktop-dark.png";

<Image src={desktopLight} alt="桌面应用" class="oc-light-only" />
<Image src={desktopDark} alt="桌面应用" class="oc-dark-only" />
```

说明：

- 两张图都和其他文档图片一样放在 `content/docs/`，便于未来渲染器一起读取
- 两张图用同一句 `alt`（并在译本里翻译）
- 只有一张图时，用普通的 `![alt](./path.png)` 即可

## 本地化

文档翻译成与 Varin 应用相同的语言。**英文是源语言，放在 `content/docs/` 根目录。**
其他语言在各自的 locale 目录里镜像同一组文件名。

### 支持的语种

| 语言 | 内容目录 | 侧边栏 `translations` 键 |
| --- | --- | --- |
| English | _（根目录，无文件夹）_ | _（写在 `label`，不要写 `en`）_ |
| 简体中文 | `zh-cn/` | `zh-CN` |
| Українська | `uk/` | `uk` |
| Español | `es/` | `es` |
| Português (Brasil) | `pt-br/` | `pt-BR` |
| 한국어 | `ko/` | `ko` |
| Polski | `pl/` | `pl` |
| Français | `fr/` | `fr` |
| 日本語 | `ja/` | `ja` |

> [!IMPORTANT]
> **内容目录**用小写 locale 键（`en`、`pt-br`）；**侧边栏 `translations`** 用 BCP-47
> （`en`、`pt-BR`）。`pt-br` / `pt-BR` 看起来像，但不能互换——Starlight 用不同规则解析。
> 其余语种（`uk`、`es`、`ko`、`pl`、`fr`、`ja`）两列相同。

以后文档站的 `astro.config.mjs` `locales` 必须与此表一致，并且根 locale 为英文。
增删语言时两边一起改。

### 翻译一页

在每个 locale 目录下镜像英文文件，**文件名和相对路径必须完全相同**。Starlight 靠路径匹配译本。

```
content/docs/
  install.mdx              # English（源语言）
  zh-cn/install.mdx        # 简体中文
  uk/install.mdx           # Українська
  es/install.mdx           # Español
  pt-br/install.mdx        # Português (Brasil)
  ko/install.mdx           # 한국어
  pl/install.mdx           # Polski
  fr/install.mdx           # Français
  ja/install.mdx           # 日本語

  guides/tunnels.mdx       # 嵌套的英文页
  zh-cn/guides/tunnels.mdx # 对应简体中文译本
```

每个译本都要有**自己的译文 frontmatter**（校验要求 `title` 和 `description`）：

```mdx
---
title: Install
description: Install Varin for desktop or web.
---
```

翻译覆盖和质量由内容审查处理，不作为新增的阻断校验规则。保留各语言的有效内容，并同步修正变化的事实。
缺少译本时可以明确链接到英文源文，不必为满足文件数量而创建占位译文。未来接入站点时再验证渲染器的回退行为。

### 翻译侧边栏

**不要**为每种语言单独建侧边栏条目，也**不要**在 `link` 上加 locale 前缀——Starlight 会自动加。
在 `sidebar.config.json` 里给每个分组和条目加 `translations`（键用上表的 BCP-47）：

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

文档源允许缺少部分语种的标签。接入渲染器时，应为缺失译文配置英文 `label` 回退；
本仓库目前尚未运行这一渲染行为。

### 不要翻译这些

- 品牌和产品名：Varin、Pi、VS Code、PWA、GitHub、Discord、macOS、SSH。只有在写第三方
  配额产品时才保留 `OpenCode Go`。不要重新引入 OpenChamber 或 OpenCode 服务器。
- 代码块、shell 命令、文件路径、flag 和配置键
- 页面文件名和侧边栏 `link`（各语种保持相同）

### 校验

`bun run docs:validate` 会遍历 `content/docs/` 下每一个 `.mdx`——**包括译本**——如果缺
`title` 或 `description`，或正文页面链接、侧边栏 `link` 没有目标，就会失败；同时运行工程文档的
本地链接检查。英文保留在内容根目录。加页或翻译后请运行它，并单独审查命令准确性和翻译质量。

## 发布

目前还没有独立的文档站仓库或 `docs-source.yml` 工作流。先保证本包准确；`bun run docs:validate`
是当前门禁。以后加渲染器时，把 `content/docs/*` 和 `sidebar.config.json` 拷进去，并在
[DEPLOYMENT.zh-CN.md](DEPLOYMENT.zh-CN.md) 写明路径。
