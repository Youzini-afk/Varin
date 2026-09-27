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

Its interface is not a fixed shell. Varin ships two first-party working shapes — an **Agent
Workspace** centered on sessions, tasks, and context, and an **IDE Workbench** centered on editors,
search, Git, diagnostics, and debugging with the agent as a dockable panel — and both are ordinary
Varin extensions selected by a Workbench Profile, so you can replace either one or any individual
part of it.

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

### A governed agent harness

- **Threads, runs, and immutable working state:** work is organized into threads and runs whose
  file changes publish as immutable roots. Agents draft in isolated virtual or materialized
  workspaces and merge reviewed results back, instead of making loose edits to your checkout.
- **One permission gate:** a single `tool_call` confirmation covers harness tools, Pi built-ins,
  MCP tools, package tools, and nested-thread tools. Session grants stay scoped to the tool,
  action, workspace, paths, and network targets they were approved for.
- **Recovery that follows the agent:** the Host-owned recovery service journals agent mutations
  alongside your own edits into combined checkpoints, so affected-file rollback, undo/redo, and
  crash recovery work across tool calls without scanning the whole workspace.
- **A native tool environment:** the shell supervisor runs real PTYs with automatic background
  promotion, `get_output`, `write_to_process`, and `kill_shell`; `edit`/`write`/`apply_patch` carry
  post-edit diagnostics and per-path leases; oversized results become paginated `OutputRef`s; and
  package-manager output is organized instead of dumped raw.

### Context, retrieval, and knowledge

- **Structured context assembly:** a Zone 2 layer injects observed workspace facts — your edits,
  terminal commands, diagnostics, Git status — without touching the system prompt. A memory keeper
  maintains durable memory in off/assist/takeover modes, and Host-side compaction can take over
  summarization without extra model calls.
- **Layered retrieval:** `grep` for exact match, `explore`/`related` for grouped discovery backed
  by a symbol graph and tree-sitter structure, and `recall` against a per-workspace knowledge store
  with optional embeddings and reranking. Each layer is reachable directly; none requires the
  others to fail first.
- **Native web tools:** `webfetch` with SSRF and domain policy, extraction, PDF, and caching;
  `websearch` through user-configured providers; a sources panel; and offscreen page rendering on
  the desktop surface.

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
- **A recomposable workbench:** pick the Agent or IDE profile, or build your own. Replace the whole
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

See [maintained extension integration](docs/design/extension-compatibility.md) for the per-extension
command, event, and native-configuration contract, and which files stay plugin-owned. Varin does
not certify plugin versions against Pi releases.

## Build Varin extensions

Varin application extensions and Pi packages are separate product objects: the former extend the
Varin workbench, surfaces, and trusted Host, while the latter execute inside the Pi agent. The planned
npm toolchain requires neither a Varin source checkout nor imports from the product's private UI; the
`@varin/*` packages are not published yet:

- `@varin/extension-contract`: manifest, contribution, service, routing, and discovery contracts plus JSON Schema;
- `@varin/extension-sdk`: framework-neutral Surface, isolated-realm, and Host authoring APIs;
- `@varin/extension-react`: optional React 19 adapter;
- `@varin/extension-surface`: lower-level lifecycle and registries for advanced tests or alternate hosts;
- `@varin/extension-cli`: project initialization, validation, building, and conformance testing.

After the packages are published, create a complete extension project with:

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

Current Varin desktop packages are not published yet. The [GitHub Releases](https://github.com/Youzini-afk/Varin/releases)
page retains historical assets; use the source or Docker instructions below until a Varin package is released.

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
Node runtime needed to run the application, while Pi remains an independently managed tool. Native
x64/ARM64 desktop packages for Windows, Linux, and macOS are validated on matching runners for
application startup, Runtime Manager, health, and terminal lifecycle; optional offline installers
remain future work. Containers keep a pinned, self-contained Pi runtime for reproducible unattended
execution.

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

Images are published for `linux/amd64` and `linux/arm64` with provenance and SBOM attestations. The
complete persistent-path, environment, container, and SSH rollback contract is documented in
[Cloud deployment](docs/ops/cloud-deployment.md).

## Architecture

```mermaid
flowchart LR
    S["Renderer: a Workbench Profile selects the shell extension"] --> C["@varin/application-client"]
    S --> D["Documents, search, language, and run APIs"]
    C --> T["Authenticated HTTP/WebSocket or editor transport"]
    T --> A["Application host (@varin/web)"]
    D --> A
    A --> K["varin-kernel: private Rust system kernel"]
    A --> B["@varin/runtime-broker"]
    B --> H["Isolated @varin/pi-host workers"]
    H --> P["Pi SDK + trusted Pi packages"]
```

The application host is the single trusted backend. Each host owns a private `varin-kernel` child
process that is the production authority for durable and machine-adjacent resources: immutable
working-state roots, content objects and GC, recovery metadata, canonical file resources and
materialization, PTY and pipe process trees, and fixed-view file and structure computation. The host
keeps product policy — actor admission, document coordination, thread and run lifecycle, knowledge,
and model orchestration — and talks to the kernel over a private framed stdio protocol, never a
public port. There is exactly one production writer per resource; no TypeScript fallback authority
remains behind the kernel.

The broker owns a catalog worker plus per-session workers. A renderer reload does not terminate an
active task, and a Pi worker failure does not crash the renderer. Protocol DTOs cross the process
boundary; SDK callbacks, credential objects, and extension implementation details do not.

Electron runs that same host in its main process rather than adding a parallel desktop backend; only
native capability such as windows, menus, and dialogs crosses the Electron preload boundary.

Third-party Pi packages are executable code with the user's operating-system permissions. Varin
shows observed capabilities and gates project-local executable resources, but it does not claim to
turn trusted extensions into a complete sandbox. Read the [security policy](.github/SECURITY.md) and
[security model](docs/design/security.md) before exposing a remote instance or installing unfamiliar code.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `kernel/` | Private Rust system kernel: working state, file resources, processes, and compute |
| `packages/application-client` | Framework-neutral `RuntimeAPIs`, transports, typed failures, and the desktop IPC contract |
| `packages/ui` | Shared Pi-native React UI, stores, settings, and extension surfaces |
| `packages/web` | Browser/remote frontend, trusted Application Host, and cloud CLI |
| `packages/electron` | Native desktop shell, privileged boundary, packaging, SSH, and updates |
| `packages/mobile` | Capacitor iOS/Android shell connected to a Varin server |
| `packages/protocol` | Versioned, JSON-safe worker and surface protocol |
| `packages/runtime-client` | Browser-safe runtime request/event client |
| `packages/runtime-broker` | Catalog/session worker ownership, routing, and shutdown |
| `packages/pi-host` | Isolated Node worker embedding the Pi SDK and extensions |
| `packages/settings-store` | Atomic settings-file persistence shared by the hosts |
| `packages/extension-contract` | Manifest, contribution, workbench, service, and discovery contracts |
| `packages/extension-surface` | Framework-neutral owner scopes and transactional Surface registries |
| `packages/extension-sdk`, `-react`, `-cli` | Public authoring SDK, React adapter, and author tooling |
| `packages/extension-host` | Trusted application-host catalog, artifacts, storage, and services |
| `packages/extension-loader` | Authenticated managed Surface module loader and isolated realms |
| `packages/extension-builtins` | Manifests for Varin's built-in extensions, including both shells |
| `packages/docs` | User-facing documentation site source |
| `docs` | Architecture, harness, kernel, workbench, migration, recovery, cloud, and security contracts |
| `scripts` | Development, kernel build/measurement, release, cloud, deployment, and validation tooling |

## Development and validation

Use root or package `package.json` scripts as the command source of truth. The broad local baseline
matches the important CI gates:

```bash
bun install --frozen-lockfile
bun run type-check
bun run lint
bun run test:pi
bun run test:kernel
bun run test:cloud
bun run build
bun run test:pi:dist
```

`bun run kernel:check` is the fast Rust compile check; `bun run test:kernel` runs the non-skipping
native authority suite against the built release executable. `bun run test:docs` and
`bun run docs:validate` check engineering and docs-site content.

CI exposes three stable gates with distinct responsibilities: Ubuntu source quality, Windows runtime
behavior, and the Ubuntu production build. Type checking, lint, and the full workspace tests run once
in their authoritative gate; Windows adds only platform-sensitive coverage. Changes to cloud/runtime
inputs make the Docker workflow verify the container contract, build the coupled slim and toolbelt
base/application images, smoke both applications by immutable digest, and promote tags only after
both candidates pass.

Before contributing, read [CONTRIBUTING.md](.github/CONTRIBUTING.md), the repository-specific rules in
[AGENTS.md](AGENTS.md), and the [engineering guide](docs/development.md).

## Design and operations documentation

- [Architecture](docs/architecture.md)
- [Engineering guide](docs/development.md)
- [Roadmap](docs/roadmap.md)
- [Agent harness contract](docs/design/agent-harness.md) (Chinese), with [delivery status](docs/status.md), [plan](docs/plan/agent-harness-plan.md), and [decision log](docs/decisions/README.md)
- [Rust system kernel design](docs/design/rust-kernel-design.md) and [audit record](docs/plan/rust-kernel-audit.md)
- [Composable workbench and IDE contract](docs/design/composable-workbench.md) (Chinese)
- [Unified file editor platform](docs/design/unified-file-editor-platform.md)
- [Varin extension platform](docs/design/varin-extension-platform.md)
- [OpenChamber-to-Pi migration contract](docs/ops/openchamber-pi-migration.md)
- [Plugin GUI and ownership design](docs/design/plugin-gui-design.md)
- [Recovery model](docs/design/recovery.md)
- [Cloud deployment](docs/ops/cloud-deployment.md)
- [Security model](docs/design/security.md)

- Thanks to the [LinuxDO](https://linux.do) community for their support

## Lineage and license

Varin is a Pi-native refactor of the maintainer's OpenChamber fork.

Varin as a combined work is distributed under the
[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). Modified versions offered to
users over a network must make their corresponding source available as required by the license.
