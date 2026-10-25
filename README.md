English | [简体中文](.github/readme/README.zh-CN.md) | [繁體中文](.github/readme/README.zh-TW.md) | [Français](.github/readme/README.fr.md) | [日本語](.github/readme/README.ja.md)

<p align="center">
  <img src=".github/readme/assets/wordmark.svg" alt="Varin" width="720" />
</p>

<p align="center"><strong>An open-source workspace for AI agents.</strong></p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases">Download</a> ·
  <a href="packages/docs/README.md">User guides</a> ·
  <a href="docs/ops/varin-extension-authoring.md">Build extensions</a> ·
  <a href=".github/CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="https://github.com/Youzini-afk/Varin/releases"><img src="https://img.shields.io/github/v/release/Youzini-afk/Varin" alt="Release" /></a>
  <a href="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml"><img src="https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-blue.svg" alt="License: AGPL v3" /></a>
</p>

Bring your models, tools, files, and projects into one workspace. Work with an agent to investigate a problem, write code, read papers, or build an interactive explanation. Follow the work as it happens and review the results in the same conversation.

Varin runs on desktop and the web, with a mobile client for connecting to your Host. Its own Rust runtime manages agent execution and conversation history.

## What you can do

| Your work | In Varin |
| --- | --- |
| Work through a task | Streaming conversations, queued messages, plans, child agents, and scheduled follow-ups. |
| Develop a project | Edit files, inspect diffs, use Git and worktrees, run terminals, and search code with language and retrieval tools. |
| Read and research | Search the web and scholarly sources, read PDFs, and keep source material alongside the conversation. |
| Make something visual | Generate and edit images; create interactive HTML charts and small tools inside a message. |
| Choose your setup | Connect cloud or local models, set permissions, and configure instructions, skills, and MCP servers. |
| Work across machines | Use a local workspace or connect to a remote Host from desktop, a browser, or mobile. |

The bundled Agent, IDE, Research, and Bot workbenches arrange these capabilities for different workflows. IDE is available on desktop and web; the other workbenches also support mobile. [Workbench details](docs/workbench.md)

## Get started

| Where to run | Start here |
| --- | --- |
| Windows, macOS, or Linux desktop | [Download a release](https://github.com/Youzini-afk/Varin/releases). Choose the asset for your OS and CPU architecture. |
| A server or your own machine, accessed in a browser | [Self-host with Docker](docs/ops/cloud-deployment.md). Includes persistent storage, passwords, and remote access. |
| iOS or Android | [Mobile setup](packages/mobile/README.md). The mobile client connects to an existing Host. |
| From source | Follow the development steps below. |

In the app, open Settings to connect a model provider or local service. Select a model, choose a project folder when the task needs one, and start a conversation. The composer lets you choose permissions and switch between general and research work.

Varin is in active development before 1.0. This README describes the current source; [release notes](https://github.com/Youzini-afk/Varin/releases) describe each published build. Back up important application data before upgrading.

## Run from source

Use **Node.js 24**, **Bun 1.3.14**, Git, and the Rust toolchain in [rust-toolchain.toml](kernel/rust-toolchain.toml). Native dependencies also need a C/C++ toolchain and CMake. See the [development guide](docs/development.md) for setup and commands.

```sh
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

Open the UI URL printed in the terminal. The command starts the web interface and Application Host.

For the desktop app, run `bun run electron:dev` from the same checkout. It prepares the native kernel and launches Electron with the development UI. [Desktop development and packaging](packages/electron/README.md#development)

## A workspace you can extend

Varin's harness connects the model to tools, context, permissions, background work, and child agents. A native Rust runtime stores conversations and execution records; the shared Application Host supplies model connections and workspace services.

Common tools are declared directly. Other available capabilities have an index and on-demand descriptions, so discovering a tool keeps the declaration prefix stable. Research tools are available on demand in general mode and declared directly in research mode.

Extensions can add tools, model adapters, panels, and entire workbench layouts. Start with the [authoring guide](docs/ops/varin-extension-authoring.md), [SDK](packages/extension-sdk/README.md), or [working examples](examples/extensions/README.md).

For implementation details, read the [architecture](docs/architecture.md), [runtime](docs/runtime.md), and [documentation index](docs/README.md).

## Contribute

Bug reports, UI improvements, tools, documentation, translations, and platform feedback are welcome. The [contribution guide](.github/CONTRIBUTING.md) covers setup, choosing a change, and submitting a pull request.

[Report a bug](https://github.com/Youzini-afk/Varin/issues/new?template=bug.yml) · [Suggest a feature](https://github.com/Youzini-afk/Varin/issues/new?template=feature.yml) · [Report a vulnerability privately](.github/SECURITY.md)

Thanks to the [LinuxDO](https://linux.do) community for its support.

## License

The project is distributed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Modified versions offered over a network must provide their corresponding source as required by the license. Copyright and third-party notices are preserved in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).
