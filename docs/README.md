# Varin Engineering Documentation

For end-user setup and usage, start with [README.md](../README.md) and the [User Guides](../packages/docs/README.md).
For contributing and local setup, see [CONTRIBUTING.md](../.github/CONTRIBUTING.md) and [Development](development.md).

## Domain Guides

| Topic | Document |
| --- | --- |
| Process boundaries & state ownership | [architecture.md](architecture.md) |
| Native Agent runtime, Catalog, Run drivers, retry & deletion | [runtime.md](runtime.md) |
| Multi-agent collaboration, delegation & file handoff | [collaboration.md](collaboration.md) |
| Long-lived assistant (Varin Bot), memory, schedules & attention | [bot.md](bot.md), [bot-appearances.md](bot-appearances.md) |
| External harnesses (Codex, Claude Code, Pi, ACP) | [external-agents.md](external-agents.md) |
| Files, attachments, browser resources, sources & recovery | [resources.md](resources.md) |
| Context preparation, retrieval, materials & knowledge | [retrieval.md](retrieval.md) |
| Workbench shells, profiles, documents & editor chrome | [workbench.md](workbench.md) |
| Interactive chat content, HTML artifacts & quoting | [interactive-content.md](interactive-content.md) |
| Extension contracts, plugin center & runtime composition | [extensions.md](extensions.md) |
| Trust boundaries, auth & privilege limits | [security.md](security.md) |
| Local dev, build graph & verification | [development.md](development.md), [performance.md](performance.md) |
| Real-environment acceptance checklist | [runtime-acceptance.md](runtime-acceptance.md) |
| Deployment, reverse proxy, backup, themes & extension authoring | [ops/README.md](ops/README.md) |

## Source-Adjacent Module Docs

Module-level invariants and code entrypoints live next to their code:

- **Rust kernel**: [kernel/README.md](../kernel/README.md), [varin-runtime](../kernel/crates/varin-runtime/README.md), [providers](../kernel/crates/varin-runtime/src/providers/README.md), [varin-computer-windows](../kernel/crates/varin-computer-windows/README.md)
- **Application Host**: [kernel adapters](../packages/web/application-host/lib/kernel/DOCUMENTATION.md), [harness](../packages/web/application-host/lib/harness/DOCUMENTATION.md), [bots](../packages/web/application-host/lib/bots/DOCUMENTATION.md), [external-agents](../packages/web/application-host/lib/external-agents/DOCUMENTATION.md), [extensions](../packages/web/application-host/lib/extensions/DOCUMENTATION.md), [documents](../packages/web/application-host/lib/documents/DOCUMENTATION.md), [workspace](../packages/web/application-host/lib/workspace/DOCUMENTATION.md), [projects](../packages/web/application-host/lib/projects/DOCUMENTATION.md), [conversation-organization](../packages/web/application-host/lib/conversation-organization/DOCUMENTATION.md), [models](../packages/web/application-host/lib/models/DOCUMENTATION.md), [credentials](../packages/web/application-host/lib/credentials/DOCUMENTATION.md), [knowledge](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md), [memory](../packages/web/application-host/lib/memory/DOCUMENTATION.md), [mcp](../packages/web/application-host/lib/mcp/DOCUMENTATION.md), [computer](../packages/web/application-host/lib/computer/DOCUMENTATION.md), [external-access](../packages/web/application-host/lib/external-access/DOCUMENTATION.md), [ui-auth](../packages/web/application-host/lib/ui-auth/DOCUMENTATION.md)
- **Client & UI**: [application-client](../packages/application-client/README.md), [protocol](../packages/protocol/README.md), [ui](../packages/ui/DOCUMENTATION.md), [electron](../packages/electron/README.md), [mobile](../packages/mobile/README.md)
- **Extensions**: [extension-contract](../packages/extension-contract/README.md), [extension-host](../packages/extension-host/README.md), [extension-sdk](../packages/extension-sdk/README.md)

Code, schemas, tests and package scripts are the executable truth; historical designs and migration logs remain in Git.
