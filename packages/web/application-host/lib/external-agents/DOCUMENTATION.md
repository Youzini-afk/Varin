# External Agents module

Bridges external coding-agent CLIs and harnesses (Codex, Claude Code, Pi RPC, and ACP-compatible programs such as OpenCode, Gemini CLI, Hermes, etc.) into Varin's Catalog, observation stream, attachment capture, and managed remote-Host execution. See [docs/external-agents.md](../../../../../docs/external-agents.md).

## Key files

| File(s) | Responsibility |
| --- | --- |
| [`service.ts`](service.ts), [`routes.ts`](routes.ts) | `ExternalAgentsService` lifecycle/connection pool, SSE observation (`/api/external-agents/observe`), and `/api/external-agents/*` action & attachment routes |
| [`adapter.ts`](adapter.ts), [`transport.ts`](transport.ts), [`context-usage.ts`](context-usage.ts), [`interaction-form.ts`](interaction-form.ts) | Common `HarnessConnection` contract, JSON-RPC/process transport, protocol context-usage tracking, and structured interaction forms |
| [`codex.ts`](codex.ts), [`claude.ts`](claude.ts), [`claude-bridge.ts`](claude-bridge.ts), [`claude-worker.ts`](claude-worker.ts), [`claude-content.ts`](claude-content.ts) | Dedicated Codex and Claude Code SDK/worker adapters |
| [`pi.ts`](pi.ts), [`pi-content.ts`](pi-content.ts), [`pi-version.ts`](pi-version.ts) | Pi >=1.5 delta-only RPC adapter and version gate |
| [`acp.ts`](acp.ts), [`acp-content.ts`](acp-content.ts), [`acp-files.ts`](acp-files.ts), [`acp-interactions.ts`](acp-interactions.ts), [`acp-options.ts`](acp-options.ts), [`hermes-gateway.ts`](hermes-gateway.ts) | Generic ACP protocol adapter, native-owner file bridge, permission/form interactions, and Hermes gateway bridge |
| [`profiles.ts`](profiles.ts), [`profile-launch.ts`](profile-launch.ts), [`dedicated-options.ts`](dedicated-options.ts), [`installations.ts`](installations.ts), [`installed-executable.ts`](installed-executable.ts), [`executor-discovery.ts`](executor-discovery.ts), [`capability-cache.ts`](capability-cache.ts) | Built-in CLI profiles, executable discovery/installation, delegation executor choices, and launch-keyed capability cache |
| [`source.ts`](source.ts), [`attachments.ts`](attachments.ts), [`attachment-capture.ts`](attachment-capture.ts), [`code-exchange.ts`](code-exchange.ts) | Prepared workspace/child sources, immutable file attachment capture, and three-way code exchange |
| [`managed-transport.ts`](managed-transport.ts), [`managed-capture.ts`](managed-capture.ts), [`managed-child-source.ts`](managed-child-source.ts), [`managed-project-source.ts`](managed-project-source.ts), [`managed-code-exchange.ts`](managed-code-exchange.ts) | Coordinator-to-target managed remote Host transport, capture, source preparation, and remote code exchange |

## Ownership and invariants

- **Catalog & principal isolation**: Product conversation records, revisions, and child-operation bindings live in the coordinator's Rust Catalog. `/api/external-agents/*` authorizes every conversation/child against the authenticated principal; `configure`, `installations`, and `installation-log` require Host configuration/execution access.
- **Process & file boundaries**: External adapters run inside Rust-owned process trees (`createKernelProcessService`). ACP file edits route through [`acp-files.ts`](acp-files.ts) into the native file owner with version conflicts rather than bypassing Documents/Storage.
- **Immutable inputs & receipts**: Attachments are captured into immutable storage (`attachment-capture.ts`) before reaching an adapter—never forwarded as raw untrusted paths. Steering acknowledgements (`HarnessSteeringReceipt`) are native transport ACKs, never proof the model read the input.
- **Capability cache & usage**: `capability-cache.ts` keys only on launch identity (`command`/`args`), caching protocol metadata only (never auth methods, credentials, or transient errors). `context-usage.ts` reports self-reported protocol values separately from Varin's native usage ledger.
- **Managed remote execution**: Target Hosts retain source bytes, capture, and code-exchange mutations locally without creating a target product Thread; the coordinator holds only Catalog records and receipts.
