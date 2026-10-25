[English](../../README.md) | 简体中文 | [繁體中文](README.zh-TW.md) | [Français](README.fr.md) | [日本語](README.ja.md)

<p align="center">
  <img src="../../.github/readme/assets/wordmark.svg" alt="Varin" width="720" />
</p>

<p align="center"><strong>开源的通用 Agent 工作台。</strong></p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases">下载</a> ·
  <a href="../../packages/docs/README.zh-CN.md">使用指南</a> ·
  <a href="../../docs/ops/varin-extension-authoring.md">开发扩展</a> ·
  <a href="../../.github/translations/CONTRIBUTING.zh-CN.md">参与贡献</a>
</p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases"><img src="https://img.shields.io/github/v/release/Youzini-afk/Varin" alt="Release" /></a>
  <a href="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml"><img src="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
</p>

把模型、工具、文件和项目放在同一个工作空间里。你可以和 Agent 一起排查问题、编写代码、查阅论文，或制作交互式说明；执行过程和结果都留在对话中，方便查看与继续工作。

Varin 提供桌面端和网页端，也有连接 Host 的移动客户端。它使用自己的 Rust 运行时管理 Agent 执行和会话历史。

## 用 Varin 做什么

| 手头的工作 | Varin 提供的能力 |
| --- | --- |
| 推进一项任务 | 流式对话、消息队列、计划、子 Agent 和定时接续。 |
| 开发项目 | 文件编辑、差异查看、Git 与 worktree、终端，以及代码检索和语言工具。 |
| 阅读与研究 | 网页与学术检索、PDF 阅读，在对话旁保留原始材料。 |
| 制作可视化内容 | 生成和编辑图像，在消息中制作交互式 HTML 图表和小工具。 |
| 组织自己的工具 | 连接云端或本地模型，设置权限，配置指令、skills 和 MCP 服务。 |
| 跨设备工作 | 使用本地工作区，或从桌面、浏览器和移动端连接远程 Host。 |

内置的 Agent、IDE、Research 和 Bot 工作台为不同任务提供相应布局。IDE 支持桌面与网页，其他工作台也支持移动端。[工作台说明](../../docs/workbench.md)

## 开始使用

| 使用方式 | 入口 |
| --- | --- |
| Windows、macOS 或 Linux 桌面端 | [下载发行版](https://github.com/Youzini-afk/Varin/releases)，选择与你的系统和 CPU 架构对应的安装包。 |
| 在自己的电脑或服务器上运行，通过浏览器访问 | [Docker 自托管](../../docs/ops/cloud-deployment.md)，包含持久化目录、密码和远程访问配置。 |
| iOS 或 Android | [移动端配置](../../packages/mobile/README.md)。移动客户端连接已有 Host。 |
| 从源码运行 | 见下方开发步骤。 |

打开应用后，先在设置中连接模型提供商或本地服务。选择模型，按任务需要选择项目文件夹，即可开始对话。输入框中可以选择权限，并切换通用或科研工作模式。

Varin 正处于 1.0 之前的活跃开发阶段。本页介绍当前源码，[发布说明](https://github.com/Youzini-afk/Varin/releases)记录各发行版的内容。升级前请备份重要的应用数据。

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

## 扩展你的工作台

Varin 的 Harness 负责连接模型、工具、上下文、权限、后台工作和子 Agent。原生 Rust 运行时保存会话与执行记录，共享的 Application Host 提供模型连接和工作区服务。

常用工具直接声明，其他可用能力通过索引和按需说明提供。读取说明时保持工具声明前缀稳定。研究工具在通用模式下按需披露，在科研模式下直接常驻。

扩展可以添加工具、模型适配器、面板，乃至整套工作台布局。从[扩展作者指南](../../docs/ops/varin-extension-authoring.md)、[SDK](../../packages/extension-sdk/README.md)或[示例](../../examples/extensions/README.md)开始。

实现细节见[架构](../../docs/architecture.md)、[运行时](../../docs/runtime.md)和[文档索引](../../docs/README.md)。

## 参与贡献

欢迎提交问题报告、改进界面和工具、补充文档与翻译，或分享平台实测结果。[贡献指南](../translations/CONTRIBUTING.zh-CN.md)介绍开发准备、如何选择改动和提交 Pull Request。

[报告问题](https://github.com/Youzini-afk/Varin/issues/new?template=bug.yml) · [提出建议](https://github.com/Youzini-afk/Varin/issues/new?template=feature.yml) · [私下报告安全漏洞](../translations/SECURITY.zh-CN.md)

感谢 [LinuxDO](https://linux.do) 社区的支持。

## 许可证

项目按 [GNU Affero General Public License v3.0](../../LICENSE)（`AGPL-3.0-only`）分发。通过网络提供修改版本时，应按许可证要求提供对应源码。版权与第三方声明保留在 [THIRD_PARTY_NOTICES](../../THIRD_PARTY_NOTICES.md) 中。
