English | [简体中文](.github/readme/README.zh-CN.md) | [繁體中文](.github/readme/README.zh-TW.md) | [Français](.github/readme/README.fr.md) | [日本語](.github/readme/README.ja.md)

# Varin

<p align="center">
  <img src="packages/electron/resources/icons/app-icon.svg" alt="Varin" width="128" />
</p>

[![CI](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml)
[![Docker Images](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**An independent Agent workspace and full harness for coding, research, and other project work:
usable across desktop, web, and mobile clients.**

It includes a bundled [Pi](https://github.com/earendil-works/pi) runtime, whose model and provider stack,
session tree, package manager, and extension model remain Pi-owned. Varin owns the surrounding tool
environment, working state, recovery, retrieval, context policy, task governance, and workbench surfaces.
It uses Pi's public SDK directly rather than scraping a terminal UI.

Pi remains the default. This branch also provides an opt-in [Rust Agent runtime](docs/runtime.md)
with its own durable Thread/branch history. It does not automatically migrate Pi assets or switch the
product default. Current support and remaining real-environment checks are in the [documentation](docs/README.md).

Workbench Profiles select four bundled shells: **Agent Workspace**, **IDE Workbench**,
**Research Workbench**, and **Varin Bot**. They are ordinary Varin extensions; you can replace
an entire shell or individual parts. Agent Workspace centers on sessions and tasks, while IDE
Workbench combines editors, search, Git, diagnostics, and debugging with a dockable agent.

Agent Workspace, Research Workbench, and Varin Bot support desktop, web, and mobile. IDE Workbench
supports desktop and web. Work focus is separate from the selected shell.

> [!IMPORTANT]
> Varin is pre-1.0 and under active development. Product surfaces and the private runtime protocol
> currently advance together, so older builds are not guaranteed to interoperate with newer ones.
> Back up important workspaces and pin a tested image digest for persistent deployments.

## Product surfaces

The screenshots below come from an isolated `demo-workspace` with anonymous sample files.

### Agent Workspace

Sessions and projects stay visible while the main canvas keeps the active agent, context tools, and
composer in one focused workspace.

![Varin Agent Workspace](.github/readme/assets/agent-workspace.png)

### IDE Workbench

The IDE profile combines workspace navigation and editor infrastructure with a docked, fully capable
Pi agent instead of treating chat as a separate application.

![Varin IDE Workbench](.github/readme/assets/ide-workbench.png)

### Mobile workspace

The responsive workspace keeps the same project, agent controls, context surfaces, and composer on a
phone-sized screen.

<p align="center">
  <img src=".github/readme/assets/mobile-workspace.png" alt="Varin mobile workspace" width="390" />
</p>

## What Varin provides

### Execution, resources and recovery

- Threads coordinate work, while admitted sources distinguish live files, immutable snapshots and
  materialized execution. Selected results use recorded base/source/target identities.
- Tool permissions, resource grants and physical completion are separate. A cancelled observer or
  network connection does not prove a command or remote effect stopped.
- Affected-file recovery journals controlled mutations without scanning the whole project per turn.
  Later edits, unknown dirty state and unjournalled shell/application changes retain explicit limits.
- Host-owned terminals, language servers, debugging, tasks and file tools share the Rust resource
  authority rather than running privileged work in the renderer.

### Context, retrieval and knowledge

- Requests retain their selected context and source revisions. Background compaction publishes only
  a successful candidate; preparing or cancelling a summary leaves the previous context intact.
- Exact search, Explore, graph topology and language navigation offer different evidence paths, with
  explicit partial/stale coverage and optional semantic/model assistance.
- Ordinary Agent notes are explicit scoped text. Bot knowledge and optional background organization
  retain original source ranges, corrections and mutation receipts.
- Web, scholarly and PDF tools separate discovery metadata, retained originals, extracted text and
  actual page images. External providers and Computer/VM capabilities have their own support limits.

### A real coding workspace

- **Pi-native conversations:** streaming, branching, tree navigation, compaction, steering and
  follow-up queues, model and thinking selection, session rename, archive, restore, and deletion.
- **Workspace tooling:** files, diffs, Git, worktrees, terminals, SSH hosts, remote instances,
  comments, and editor context share the active Pi session and workspace.
- **Editor-grade infrastructure:** one revisioned document authority with real conflict handling;
  desktop/Web Agent and IDE surfaces share Monaco models, editor groups, workspace search,
  host-owned language servers, and standards-conformant debug adapters, while mobile and embedded
  editors use a lightweight CodeMirror adapter against the same authority. Agent edits reconcile
  with your unsaved buffers instead of overwriting them.
- **Custom providers:** configure Pi-native provider layers, authentication, model discovery, and
  custom endpoints without mirroring credentials into renderer storage.

### Composable and everywhere

- **Packages without a parallel plugin system:** install, update, remove, and inspect any package
  accepted by Pi's `PackageManager`. Unknown extensions still receive generic command, tool, entry,
  notification, and UI handling.
- **First-class plugin configuration:** maintained plugins get focused GUI surfaces while their own
  native JSON/JSONC files, commands, databases, and migration logic remain authoritative.
- **A recomposable workbench:** pick an Agent, IDE, Research, or Bot profile, or build your own. Replace the whole
  shell or just the navigation, editor, panel, composer, timeline, or status bar, and mix first-party
  with community contributions. Switching happens live, without reloading documents, restarting the
  Pi runtime, or losing shared workspace state.
- **Multiple product surfaces:** a shared React UI powers Electron, Web, and the Capacitor mobile
  shell through explicit runtime capabilities.
- **Cloud and remote operation:** authenticated WebSocket access, relay/tunnel support,
  multi-architecture containers, and atomic SSH deployment with health validation and rollback.

## Maintained extension integrations

Varin does not fork Pi extensions or copy their private state. Maintained adapters consume each
extension's public commands, events, settings files, and capability contracts — including subagent
fleets, context managers, workspace history, MCP servers, web access, memory systems, background
tasks, and LSP/tooling configuration — so package updates can continue to advance independently.

See [maintained extension integration](docs/extensions.md) for the current ownership boundaries and source entry points. Varin does
not certify plugin versions against Pi releases.

## Build Varin extensions

Varin application extensions and Pi packages are separate product objects: the former extend the
Varin workbench, surfaces, and trusted Host, while the latter execute inside the Pi agent. The npm authoring toolchain is implemented in this repository and avoids product-private UI imports.
Use available published versions or the source workflow in the authoring guide:

- `@varin/extension-contract`: manifest, contribution, service, routing, and discovery contracts plus JSON Schema;
- `@varin/extension-sdk`: framework-neutral Surface, isolated-realm, and Host authoring APIs;
- `@varin/extension-react`: optional React 19 adapter;
- `@varin/extension-surface`: lower-level lifecycle and registries for advanced tests or alternate hosts;
- `@varin/extension-cli`: project initialization, validation, building, and conformance testing.

When the packages are available in your registry, create an extension project with:

```sh
npx @varin/extension-cli init ./my-extension --id dev.example.my-extension --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

See the [Varin extension authoring guide](docs/ops/varin-extension-authoring.md) for the complete
manifest, capability, lifecycle, storage, publishing, and testing contracts.

## Download Desktop

Check [GitHub Releases](https://github.com/Youzini-afk/Varin/releases) for published artifacts and their
platform/version information. Source and container workflows are below.

## Get started from source

### Prerequisites

- Node.js 22.19 or newer; Node.js 24 is the supported source-development baseline
- Bun 1.3.14
- A Rust toolchain matching `kernel/rust-toolchain.toml` (rustup selects it automatically)
- Git
- Git for Windows and Git Bash when running Pi shell tools on Windows

The Rust system kernel is a required runtime component, not an optional accelerator. Source
development runs it through Cargo when no staged binary is present; `bun run kernel:build` produces
the manifest-verified release executable that packaged layouts require.

Varin ships a bundled Pi runtime and discovers user-level Pi installations through the Runtime
Manager, which can select, install, or upgrade Pi without downgrading it. Varin becomes ready only
after a real Host handshake and does not need to restart after activation. Electron contains the
Node runtime needed to run the application, while Pi remains an independently managed tool. Packaging and platform support must be checked against the actual artifact and target runner;
a successful source build is not complete desktop/VM/provider acceptance. Containers keep a pinned,
self-contained Pi runtime for reproducible unattended execution.

### Run the Web development surface

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

Open the Vite URL printed in the terminal. Varin selects available development ports and starts
the trusted API/runtime service alongside the UI.

### Run the desktop application

```bash
bun run electron:dev
```

Use the bundled-assets path when testing behavior closer to a packaged build:

```bash
bun run electron:dev:bundled
```

### Build a Windows installer

Run this on Windows:

```powershell
bun run electron:build:win
bun run electron:smoke:win
```

The NSIS installer, update metadata, and blockmap are written to `packages/electron/dist`. Without
code-signing credentials the installer is intentionally unsigned. See the
[desktop packaging guide](packages/electron/README.md#packaging) for signing and platform details.

## Run the cloud image

The Compose file uses the slim image `ghcr.io/youzini-afk/varin-slim:latest` by default. On a Linux
Docker host:

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
umask 077
printf 'VARIN_UI_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

Open `http://127.0.0.1:3000` and use the generated password. Put a TLS reverse proxy or an approved
tunnel in front of any Internet-facing deployment; see [reverse proxy setup](docs/ops/REVERSE_PROXY.md)
for the required forwarding rules. For production, set `VARIN_IMAGE` to a tested immutable digest
instead of relying on a floating tag.

If the agent needs to compile Python, Java, Go, or Rust inside the container, apply the toolbelt
overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

The image workflows target `linux/amd64` and `linux/arm64` with provenance and SBOM attestations. The
complete persistent-path, environment, container, and SSH rollback contract is documented in
[Cloud deployment](docs/ops/cloud-deployment.md).

## Architecture and development

Web, Electron and mobile share the Application Host. Pi workers own Pi conversations; the opt-in
Agent runtime owns its separate Catalog/history. Rust Storage owns files, working state, processes
and recovery; existing Knowledge and extension owners retain their domains. See the
[architecture](docs/architecture.md) for request flow and trust boundaries.

- [Documentation index](docs/README.md)
- [Development and verification](docs/development.md)
- [Agent runtime](docs/runtime.md)
- [Resources and recovery](docs/resources.md)
- [Workbench](docs/workbench.md) and [extensions](docs/extensions.md)
- [Security](docs/security.md)
- [Deployment and operations](docs/ops/README.md)

Package scripts define commands; choose focused checks for the change instead of running every build
and suite for prose edits. Read [CONTRIBUTING](.github/CONTRIBUTING.md) and [AGENTS](AGENTS.md) before contributing.

Thanks to the [LinuxDO](https://linux.do) community for their support.

## Lineage and license

Varin is a Pi-native refactor of the maintainer's OpenChamber fork.

Varin as a combined work is distributed under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Modified versions offered to
users over a network must make their corresponding source available as required by the license.

Third-party notices and retained copyright obligations are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).
