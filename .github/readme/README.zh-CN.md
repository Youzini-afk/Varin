[English](../../README.md) | 简体中文 | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [日本語](README.ja.md)

<p align="center">
  <img src="../../.github/readme/assets/wordmark.svg" alt="Varin" width="720" />
</p>

<p align="center"><strong>开箱即用的开源 Agent Harness。</strong></p>

<p align="center">模型之外的一切都已备好，开箱即用，也可深度定制。</p>

<p align="center">
  <a href="https://varin.dev/zh-cn/">官网</a> ·
  <a href="https://github.com/Youzini-afk/Varin/releases/latest">下载</a> ·
  <a href="../../packages/docs/README.zh-CN.md">使用指南</a> ·
  <a href="../../docs/ops/varin-extension-authoring.md">开发扩展</a> ·
  <a href="https://github.com/Youzini-afk/Varin/discussions">讨论区</a>
</p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases"><img src="https://img.shields.io/github/v/release/Youzini-afk/Varin" alt="Release" /></a>
  <a href="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml"><img src="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
</p>

<p align="center">
  <img src="assets/code-mode.png" alt="编程模式下的 Varin：Agent 检索项目、修改 profile.js，把回归测试交给验证队友，最后报告测试全部通过" width="960" />
</p>

模型负责思考，Harness 是它周围的一切：工具、上下文、执行、权限、协作与恢复。Varin 把这些都准备好了，同一个模型放进来，能完成更长、更复杂的任务。下载安装，填上自己的 API Key，就能开始。

## 为什么是 Varin

**同一个模型，走得更远。**

- 上下文自整理：后台提前整理，写摘要时保留关键原文；用本地分词计数，并按真实用量校准。
- 持久执行：每一步都有记录，重启后从断点继续；结果不明的操作先停下核对，不会再执行一遍。
- 提问不阻塞：等你回复时，其他工作照常进行；带预算的目标在条件满足时自动接续。
- 工具按需：常用工具常驻，其余按需加载；MCP 服务可以直接暴露，也可以按需发现。

**开箱即用。** 近 80 个原生工具、4 种工作模式、4 个官方工作台、6 个内置语言服务器、8 种原生模型协议，界面支持 10 种语言。

**深度定制，不写代码。** 每个预置 Agent 都能换模型、改指令、调工具，也能自建 Agent；标题生成、上下文整理、规划、生图、嵌入可以分别指定模型。系统指令与记忆可编辑；Skills 兼容 `.claude` 与 `.agents` 目录，也能从 Git 仓库安装；每个工具都能设为允许、询问或拒绝。

**你的 Key，你的数据。** 密钥只保存在你自己的 Host 上，请求直接发往你配置的服务商：OpenAI、Anthropic、Gemini、Vertex AI、Azure OpenAI、Bedrock、Mistral、阿里云百炼、智谱、阶跃星辰，也可以是 Ollama、LM Studio 或任意兼容端点。用量按渠道和模型逐轮记录。

## 四种工作方式

模式决定 Agent 先拿到哪些工具、有哪些队友协助。

| 模式 | 用来做什么 | 例如 |
| --- | --- | --- |
| 编程 | 读改代码、跑命令、开终端，改过的文件按轮次留档。 | 「把登录模块重构一下，测试全部通过再叫我。」 |
| 科研 | 检索 OpenAlex 与 Semantic Scholar，阅读论文和 PDF，一步步推进实验。 | 「找近两年这个方向的论文，做一张能筛选的对比表。」 |
| 办公 | 直接操作 Word、Excel、PPT，以及浏览器和电脑上的应用。 | 「把上个月的订单导出来，整理成带图表的 Excel。」 |
| 通用 | 查资料、写东西、做一个能交互的小工具。 | 「比较这三款相机，做个能调参数的对比图。」 |

<p align="center">
  <img src="assets/research-mode.png" alt="科研模式下的 Varin：在对话里用表格比较近期的几种方案" width="960" />
</p>

## 团队、Bot 与可回退的改动

- **团队**：主 Agent 拆分任务，交给 Worker、调研 Agent、验证 Agent 分头推进。队友之间直接发消息、交接代码（附逐文件差异），完成后汇报；你可以在协作面板里查看讨论，随时插话。
- **Bot**：有自己的名字、指令、模型和工作目录，能同时推进好几件事。它记住的内容可以查看、修正、删除；睡眠时工作挂起，唤醒后从原处继续。
- **文件时间线**：每轮改动的文件都排在时间线上，一键回退，回退也能撤销；你手动改过的文件不会被覆盖。

<p align="center">
  <img src="assets/team.png" alt="主 Agent 把检查交给队友，队友跑完测试后在协作面板里汇报" width="960" />
</p>

## 开始使用

1. 安装 Varin。

   | 使用方式 | 入口 |
   | --- | --- |
   | Windows、macOS 或 Linux | [下载安装包](https://github.com/Youzini-afk/Varin/releases/latest)，选择与系统和 CPU 架构对应的版本。 |
   | 在自己的服务器上运行，用浏览器访问 | [Docker 自托管](../../docs/ops/cloud-deployment.md)，包含持久化目录、密码和远程访问配置。 |
   | 手机 | 在设置中把手机与 Host 配对。原生应用发布前，可以安装网页应用（PWA）。[移动端指南](../../packages/docs/content/docs/zh-cn/mobile.mdx) |
   | 从源码运行 | 见[从源码运行](#从源码运行)。 |

2. 打开设置，填入模型服务商的 API Key，或连接本地服务。[服务商与模型](../../packages/docs/content/docs/zh-cn/providers.mdx)
3. 选择工作模式，任务需要时选一个项目文件夹，开始第一个任务。

Varin 处于 1.0 之前的活跃开发阶段。本页介绍当前源码，[发布说明](https://github.com/Youzini-afk/Varin/releases)记录各发行版的内容。升级前请备份重要的应用数据。

## 从源码运行

使用 **Node.js 24**、**Bun 1.3.14**、Git，以及 [rust-toolchain.toml](../../kernel/rust-toolchain.toml) 指定的 Rust 工具链。原生依赖还需要 C/C++ 工具链与 CMake。环境与命令说明见[开发指南](../../docs/development.md)。

```sh
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

打开终端打印的 UI 地址。该命令会启动网页界面和 Application Host。

开发桌面端时，在同一份源码中运行 `bun run electron:dev`。它会准备原生内核，并启动带开发界面的 Electron 应用。[桌面开发与打包](../../packages/electron/README.md#development)

## 扩展 Varin

官方的 Agent、IDE、科研、Bot 工作台，以及浏览器、Office、电脑操作、语言服务器，本身都是扩展，和第三方扩展用同一套契约。每一个都能停用，工作台也能整个替换。扩展可以添加工具、模型协议、上下文算法、面板，乃至整套工作台。从[扩展作者指南](../../docs/ops/varin-extension-authoring.md)、[SDK](../../packages/extension-sdk/README.md)或[示例](../../examples/extensions/README.md)开始。

想了解各部分如何配合，见[架构](../../docs/architecture.md)、[运行时](../../docs/runtime.md)和[文档索引](../../docs/README.md)。

## 交流与参与

- 使用问题到 [Q&A](https://github.com/Youzini-afk/Varin/discussions/categories/q-a) 提问，作品分享和想法建议在[讨论区](https://github.com/Youzini-afk/Varin/discussions)交流。[获取帮助](../translations/SUPPORT.zh-CN.md)列出了各类问题该去哪里。
- 欢迎贡献：工具与上下文处理、模型服务商适配、扩展、文档与翻译，以及各平台的实测报告。[贡献指南](../translations/CONTRIBUTING.zh-CN.md)介绍了开发准备和 Pull Request 流程。
- [报告问题](https://github.com/Youzini-afk/Varin/issues/new?template=bug.yml) · [提出建议](https://github.com/Youzini-afk/Varin/issues/new?template=feature.yml) · [私下报告安全漏洞](../translations/SECURITY.zh-CN.md)

感谢 [LinuxDO](https://linux.do) 社区的支持。

## 许可证

项目按 [GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）分发。通过网络提供修改版本时，应按许可证要求提供对应源码。版权与第三方声明保留在 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) 中。
