English | [简体中文](.github/readme/README.zh-CN.md) | [繁體中文](.github/readme/README.zh-TW.md) | [Français](.github/readme/README.fr.md) | [日本語](.github/readme/README.ja.md)

# Varin

<p align="center">
  <img src="packages/electron/resources/icons/app-icon.svg" alt="Varin" width="128" />
</p>

[![CI](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/ci.yml)
[![Docker Images](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml/badge.svg)](https://github.com/Youzini-afk/Varin/actions/workflows/docker.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

**An independent Agent workspace and harness for coding, research, and project work across desktop,
web, and mobile.**

Varin uses its native Rust Agent runtime. Its Catalog owns Threads, branches, durable conversation
history, and execution. The shared Application Host owns model connections and accounts, agent
resource setup, MCP configuration, and trusted workspace services. Clients display and control these
services through the same application APIs. See the [architecture](docs/architecture.md).

> [!IMPORTANT]
> Varin is pre-1.0 and under active development. Product surfaces and the private runtime protocol
> advance together; older and newer builds are not guaranteed to interoperate. Back up important
> workspaces and pin a tested image digest for persistent deployments. Existing user assets are not
> automatically imported, migrated, or rewritten; unsupported internal store formats are rejected.

## What Varin provides

- **Native conversations:** Thread and branch history, streaming, queued input, model and thinking
  selection, child tasks, plans, permissions, and recovery, all backed by the native Catalog.
  [Runtime](docs/runtime.md)
- **A coding workspace:** files, diffs, Git, worktrees, terminals, workspace search, language servers,
  and debugging. Desktop and web share Monaco; mobile uses a lightweight editor against the same
  document authority, with explicit unsaved-buffer and conflict handling. [Workbench](docs/workbench.md)
- **Execution and recovery:** admitted sources distinguish live files, snapshots, and materialized
  work. Rust owns storage and execution resources; permissions, cancellation, and actual completion
  remain separate facts. [Resources and recovery](docs/resources.md)
- **Research and context:** exact and semantic retrieval, language navigation, scoped notes, Bot
  knowledge, web and scholarly discovery, and PDF materials with retained sources and page images.
  [Retrieval and context](docs/retrieval.md)
- **Host-owned setup:** configure model channels, accounts, endpoints, agent instructions and skills,
  and MCP connections through dedicated settings. Credentials and privileged execution stay with
  trusted owners. [Models](packages/web/application-host/lib/models/DOCUMENTATION.md),
  [agent resources](packages/web/application-host/lib/agent-resources/DOCUMENTATION.md),
  [MCP](packages/web/application-host/lib/mcp/DOCUMENTATION.md)
- **Local and remote use:** Electron embeds the Application Host; web and Capacitor mobile clients
  connect to it. Remote Hosts, pairing, tunnels, and container/SSH deployment retain explicit access
  and platform boundaries. [Security](docs/security.md) · [Operations](docs/ops/README.md)

Four bundled Workbench Profiles select **Agent Workspace**, **IDE Workbench**, **Research Workbench**,
or **Varin Bot**. Agent, Research, and Bot support desktop, web, and mobile; IDE supports desktop and
web. Profiles are Varin extensions: replace an entire shell or individual contributions while work
focus, documents, and Thread identity remain independent of presentation.

Provider, Computer/VM, and packaging support depend on the actual environment. Focused tests do not
establish complete platform acceptance; see [runtime acceptance](docs/runtime-acceptance.md).

## Build Varin extensions

Varin extensions contribute workbench surfaces and trusted Host capabilities through public contracts.
The authoring packages are `@varin/extension-contract`, `@varin/extension-sdk`, the optional React 19
adapter `@varin/extension-react`, `@varin/extension-surface`, and `@varin/extension-cli`.

When published versions are available in your registry:

```sh
npx @varin/extension-cli init ./my-extension --id dev.example.my-extension --name "My Extension"
cd my-extension
npm install
npx varin-extension build
npx varin-extension test
```

See [extensions](docs/extensions.md) and the [authoring guide](docs/ops/varin-extension-authoring.md)
for the source workflow, manifests, capabilities, lifecycle, publishing, and testing.

## Download Desktop

Check [GitHub Releases](https://github.com/Youzini-afk/Varin/releases) for available artifacts and their
platform/version information. Source and container workflows follow.

## Get started from source

Prerequisites: Node.js 22.19 or newer (Node.js 24 is the source-development baseline), Bun 1.3.14,
Git, and the Rust toolchain selected by [kernel/rust-toolchain.toml](kernel/rust-toolchain.toml).
See the [development guide](docs/development.md) for platform setup and verification.

The Rust kernel is required. Source development can run it through Cargo when no staged binary is
present; `bun run kernel:build` produces the manifest-verified release executable required by packaged
layouts. Readiness is checked against the actual Application Host and native Thread catalog.

### Web development

```bash
git clone https://github.com/Youzini-afk/Varin.git
cd Varin
bun install --frozen-lockfile
bun run dev
```

Open the Vite URL printed in the terminal. This starts the UI and trusted Application Host on available
development ports. Configure model connections and accounts in settings before starting model work.

### Desktop development

```bash
bun run electron:dev
```

To exercise bundled UI assets:

```bash
bun run electron:dev:bundled
```

### Windows installer

Run on Windows:

```powershell
bun run electron:build:win
bun run electron:smoke:win
```

The NSIS installer, update metadata, and blockmap are written to `packages/electron/dist`. Builds
without signing credentials are unsigned. See [desktop packaging](packages/electron/README.md#packaging).

## Run the cloud image

Compose uses `ghcr.io/youzini-afk/varin-slim:latest` by default. On a Linux Docker host:

```bash
mkdir -p data/varin data/ssh data/cloudflared workspaces
sudo chown -R 1000:1000 data workspaces
umask 077
printf 'VARIN_UI_PASSWORD=%s\n' "$(openssl rand -base64 24)" > .env
docker compose up -d
curl --fail http://127.0.0.1:3000/health
```

Open `http://127.0.0.1:3000` and use the generated password. Internet-facing deployments need a TLS
reverse proxy or approved tunnel with the required [forwarding rules](docs/ops/REVERSE_PROXY.md).
For production, set `VARIN_IMAGE` to a tested immutable digest.

For Python, Java, Go, or Rust development tools in the container:

```bash
docker compose -f docker-compose.yml -f docker-compose.toolbelt.yml up -d
```

See [cloud deployment](docs/ops/cloud-deployment.md) for persistent paths, environment variables,
image variants, supported architectures, and SSH deployment with health validation and rollback.

## Architecture and development

Start with the [documentation index](docs/README.md), [architecture](docs/architecture.md), and
[development guide](docs/development.md). The Application Host integrates native Catalog execution,
Rust-owned storage/resources, and the separate knowledge and extension owners; renderers do not own
credentials or durable execution.

Read [CONTRIBUTING](.github/CONTRIBUTING.md) and [AGENTS](AGENTS.md) before contributing. Package scripts
define commands; choose focused checks appropriate to the change.

Thanks to the [LinuxDO](https://linux.do) community for their support.

## Lineage and license

Varin is an independent project originating from the maintainer's OpenChamber fork.

The combined work is distributed under the [GNU Affero General Public License v3.0](LICENSE)
(`AGPL-3.0-only`). Modified versions offered over a network must provide their corresponding source
as required by the license. Retained copyright and third-party obligations are in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md).
