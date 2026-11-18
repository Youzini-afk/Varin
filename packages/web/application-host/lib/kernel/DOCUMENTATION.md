# Host adapters for the Rust kernel and Agent runtime

This directory binds Application Host product owners (Documents, Models, Knowledge, Memory, MCP, Extensions, Computer, Research) to the private Rust kernel executable. It does **not** implement a second Catalog, file store, execution scheduler, or recovery journal. [`application-host/index.ts`](../../index.ts) creates one `KernelClient` and injects existing owners.

For cross-cutting architecture and invariants, see [architecture](../../../../../docs/architecture.md), [Agent runtime](../../../../../docs/runtime.md), [resource contracts](../../../../../docs/resources.md), and [THREADS.md](THREADS.md).

## Resource-only assembly

- Full Host: [`host-resource-owners.ts`](host-resource-owners.ts) wires local Storage, file, recovery, and Documents-admitted process/compute owners. [`managed-resource-target.ts`](../harness/managed-resource-target.ts) exposes inbound capacity, job reconciliation, and paired managed routes using the authenticated kernel handshake identity.
- Resource node (`role: "resources"`): negotiated before opening Storage; keeps the exclusive storage-root lock and persistent Host identity without starting an Agent worker or opening a conversation Catalog. [`resource-node.ts`](../../resource-node.ts) runs this standalone listener with pairing, a mandatory shared-directory boundary, and live-source operations only (no UI or conversation service). See [cloud deployment](../../../../../docs/ops/cloud-deployment.md#resource-node-docker-compose-resource-node-yml).

## Transport and authority

- **Launch & wire**: [`kernel-client.ts`](kernel-client.ts), [`kernel-launch.ts`](kernel-launch.ts), and [`kernel-transport.ts`](kernel-transport.ts) spawn the native binary, verify packaged manifest/build/protocol/arch, establish the authenticated epoch, and multiplex control and large-body content streams (see [kernel transport lifetime](../../../../../kernel/README.md#transport-lifetime)). [`protocol.generated.ts`](protocol.generated.ts) is generated from [`kernel/protocol/schema.json`](../../../../../kernel/protocol/schema.json) — do not hand-edit.
- **Shutdown & draining**: `beginDraining()` stops new admission while allowing control reads and original effect receipts; `close()` drains admitted work under one `ShutdownDeadline` without detaching undrained work. Cancelling an observer never reverses a committed effect; `getBlob` keeps callers pending through the native read receipt.
- **Actor-scoped handles**: Bind Host, epoch, Thread/Run, workspace, and capability scope. Global management cannot substitute for an actor grant; a blob hash is not blob access.
- **Execution environment & errors**: [`context-service.ts`](context-service.ts) and [`source-launch.ts`](source-launch.ts) capture trusted program inventory from the actual Source Host into frozen tool context (never using coordinator paths as remote fallback). Ordinary live sources receive device filesystem access unless deployment lockdown is enabled; source-less submissions inherit the Host default live directory as fallback without creating a project/mount. Typed `ExecutionError` payloads survive kernel, managed-source, and script transport in Catalog completion records.
- **Auxiliary model work**: [`../model-text/service.ts`](../model-text/service.ts) and [`../model-text/thread-titles.ts`](../model-text/thread-titles.ts) run standalone native Runs/receipts (using [Models](../models/DOCUMENTATION.md)) without inventing conversation branches or appearing as conversational Runs in attention/status views.

## Source and file adapters

| Entry | Responsibility |
| --- | --- |
| [`native-workspaces.ts`](native-workspaces.ts) | Logical project/branch refs, mount generations, and execution/document leases (explicitly mounted projects only; Rust owns bytes/mounts) |
| [`storage-adapter.ts`](storage-adapter.ts) | Scoped immutable branches, pins, objects, and typed working records (`KernelScopedClient`) |
| [`file-resource-backend.ts`](file-resource-backend.ts) | Documents/Recovery physical leases and conditional file ops (`file.read.check` verifies Run grant + regular-file identity without contesting Documents read leases) |
| [`kernel-recovery-store.ts`](kernel-recovery-store.ts) | Durable checkpoint, mutation, and recovery journal adapters |
| [`thread-sources.ts`](thread-sources.ts), [`source-launch.ts`](source-launch.ts), [`live-source.ts`](live-source.ts) | Source owner/mode selection, physical admission, and durable preparation receipts |
| [`thread-source-files.ts`](thread-source-files.ts) | Composer file/directory metadata projection from the admitted Source (fixed branch, live view, or managed target; skills discover separately) |
| [`thread-resource-scope.ts`](thread-resource-scope.ts), [`thread-context.ts`](thread-context.ts), [`resource-owner.ts`](resource-owner.ts) | Frozen resource/personalization scope and checkpoint-scoped `resource_read` |
| [`managed-source-bridge.ts`](managed-source-bridge.ts), [`managed-source-consumers.ts`](managed-source-consumers.ts) | Target Source authority and source-specific remote domain dispatch |

**Key source invariants**:
- Fixed-source admission can use a saved Documents registration without reopening the live directory, still enforcing current trust and original grants; later disk reads never repair fixed provenance.
- Pinned-source branches fork via native `branch.fork`, preserving exact pins and provenance. Source preparation reads durable receipts before recapture; concurrent observers share preparation and drain on last cancellation.
- Managed code capture treats coordinator Thread/conversation IDs as attribution only (never local Catalog retention keys).

## Native Thread admission and product views

- **Auth & routes**: [`agent-runtime-client.ts`](agent-runtime-client.ts) is the typed Catalog client. [`thread-routes.ts`](thread-routes.ts) validates inputs and authorizes declared Thread/Run/Operation/Input IDs through [`request-principal.ts`](request-principal.ts) and [`ownership-resolver.ts`](ownership-resolver.ts) (batched positive cache; missing IDs fail closed; opaque bodies never scanned). Authenticated public writes require the Host owner; private work is isolated per principal.
- **Views & history**: [`thread-adapter.ts`](thread-adapter.ts) projects native `thread.view` with Host policy/recovery hooks (`inspectMany` refreshes affected summaries without rebuilding the catalog; context inspection delegates to [`catalog_context_inspection.rs`](../../../../../kernel/crates/varin-runtime/src/catalog_context_inspection.rs)). [`history-run-navigation.ts`](history-run-navigation.ts) builds metadata-only Run rail indexes excluding rewound history. Opening a view never sends messages or resumes work.
- **Event streaming**: [`event-hub.ts`](event-hub.ts) fans out the native durable event reader per principal-scoped observation ID. HTTP writers apply bounded per-observer FIFO backpressure and send explicit `slow-consumer` resync from the last accepted cursor rather than dropping frames. Client reconnect lives in [`thread-observation.ts`](../../../../application-client/src/thread-observation.ts).
- **Delegation & context organization**: [`child-profiles.ts`](child-profiles.ts) and [`child-source-store.ts`](child-source-store.ts) compose frozen child presets and staged worktrees. [`context-agent.ts`](context-agent.ts) prepares automatic/manual `ContextJob` profiles (freezing instructions/model at admission). [`code-exchange.ts`](code-exchange.ts) and [`managed-code-exchange.ts`](managed-code-exchange.ts) integrate snapshots via existing Integration/Documents/Recovery owners. [`content-maintenance.ts`](content-maintenance.ts) reclaims deleted Catalog/ContentStore material without touching Storage GC. See [collaboration](../../../../../docs/collaboration.md).

## Model, tool and extension bridges

- [`tool-invocation.ts`](tool-invocation.ts), [`tool-bridge.ts`](tool-bridge.ts), [`extension-tool-owner.ts`](extension-tool-owner.ts), and [`nested-tool-owner.ts`](nested-tool-owner.ts) enforce Run, `ToolOrigin`, call identity, schema, binding, and execution authority. Model-supplied tool names or labels are never authority; nested scripts inherit parent permissions without escalation.
- Extension input schemas validate once at authorization and reuse parsed input at execution. Continuations outliving an extension owner restore exact saved bindings (failing preparation rather than substituting live routing or replaying accepted calls).
- Context transforms and budgets remain ordered, versioned, and separate from immutable sent requests.
- MCP delegates to the shared [Host MCP authority](../mcp/DOCUMENTATION.md); live owner generations differ from config identity, and managed MCP stop awaits exact target drainage before acknowledging. See [MCP.md](MCP.md).

## Existing domain consumers

| Domain | Key adapters | Original authority |
| --- | --- | --- |
| Explicit notes & prompt edits | [`memory-owner.ts`](memory-owner.ts), [`thread-context.ts`](thread-context.ts) | Host personalization / Rust typed record |
| Bot memory & background inference | [`bot-memory-owner.ts`](bot-memory-owner.ts), [`../memory/bot-history.ts`](../memory/bot-history.ts), [`../memory/memory-inference.ts`](../memory/memory-inference.ts) | Bot binding, Catalog `MemoryWork`, KnowledgeStore receipts |
| Plans (`todo`) | [`plan-owner.ts`](plan-owner.ts), [`plan-service.ts`](plan-service.ts) | KnowledgeStore version, `expectedRef` CAS, and mutation receipts |
| Source queries & language | [`source-query-service.ts`](source-query-service.ts), [`source-query.ts`](source-query.ts), [`language-owner.ts`](language-owner.ts) | Admitted Source, native compute, language owner |
| Web, documents & materials | [`web-runtime.ts`](web-runtime.ts), [`document-sources.ts`](document-sources.ts), [`material-tool-owner.ts`](material-tool-owner.ts) | Host material store and reader grants |
| Research | [`research-runtime.ts`](research-runtime.ts), [`research-source.ts`](research-source.ts), [`managed-research-source.ts`](managed-research-source.ts) | ExperimentService, source Storage, execution backend |
| Computer & scripts | [`computer-runtime.ts`](computer-runtime.ts), [`script-runtime.ts`](script-runtime.ts) | ComputerService lane/receipts; script session + retained tool dispatch |
| Calendar & project schedules | [`../scheduled-tasks/calendar-owner.ts`](../scheduled-tasks/calendar-owner.ts), [`schedule-tool-owner.ts`](schedule-tool-owner.ts), [`managed-schedule-service.ts`](managed-schedule-service.ts) | Runtime Calendar / Source Host scheduler + Storage receipt |
| Recovery & integration | [`managed-recovery-service.ts`](managed-recovery-service.ts), [`integration-tool-owner.ts`](integration-tool-owner.ts) | Recovery/Integration journals and conditional file authority |

Settings tools without an explicit revision rebase requested fields after a confirmed CAS rejection via the existing read/merge/write path; validation/CAS rejections have no side effect.

## Managed Source consumers

Coordinating Hosts retain original Run/Source and target address; targets validate paired principal, exact Source, grant, and domain capability without pretending target paths are local to the coordinator. Consumers cover fixed/live source reads, language/retrieval, processes/PTY, MCP, scripts/packages, research inputs, file observations, recovery, and project schedules:

- **Research inputs**: capture verified target bytes into the Experiment input branch; cleanup records survive restarts independently of temporary reader handles.
- **Process terminals**: attach to the original Operation/process and raw offsets; views cannot respawn processes or release spools, and stop awaits input/read/callback drainage.
- **Project schedules**: persist a begin fence on the asset Host before dispatch; reconciliation uses durable callback receipts (unknown started ops never auto-retry) and requires whole-project permission.
- **File recovery**: [`../recovery/managed-recovery-coordinator.ts`](../recovery/managed-recovery-coordinator.ts) persists frozen participant plans; each target's [`managed-recovery-service.ts`](managed-recovery-service.ts) owns its journal and safety objects (no cross-Host atomicity claim).

## Follow-ups, composer workflows and organization

- **Follow-ups** ([`followup-event-owner.ts`](followup-event-owner.ts), [`followup-source.ts`](followup-source.ts), [`metric-followups.ts`](metric-followups.ts)): Host observers hold only transient subscriptions/cursors feeding durable Catalog follow-up ingress (subscribe before recheck; log watches read only published byte high-water; missing metric data is never zero). Ending a Wait does not cancel the watched process or delete the follow-up definition.
- **Export & quick save**: [`thread-export.ts`](thread-export.ts) streams chronological JSON/Markdown from the immutable Catalog cut (excluding provider originals/checkpoints; attachments verified by chunk hash/length). [`../memory/thread-remember.ts`](../memory/thread-remember.ts) saves directly to the bound Bot/user KnowledgeStore or ordinary personalization record with CAS and original receipts.
- **User-authored dispatch & quotes**: [`thread-user-dispatch.ts`](thread-user-dispatch.ts) admits user-authored children with explicit model/source/background cuts using raw-key receipt replay and Catalog preparation/cleanup duties before retaining external dependencies. [`thread-quotes.ts`](thread-quotes.ts) validates UTF-16 quote ranges and file/media bindings; Rust [`input_quotes.rs`](../../../../../kernel/crates/varin-runtime/src/input_quotes.rs) alone expands quotes for model requests.
- **Conversation organization**: [`../conversation-organization/service.ts`](../conversation-organization/service.ts) initializes once per principal from validated Settings; Catalog owns durable tree/placement/CAS/receipts while Settings owns project registration. Frozen project source selection (`native_workspace` vs `live_root`) travels in creation/dispatch metadata, not navigation nodes, and managed project configuration shares `NativeWorkspaceOwner.projectLifecycle` without registering remote mounts locally. Inherited-input retries compare normalized input and check receipts before mutable Settings/device checks.

## Verification

Run `bun run test:kernel` for real Host/release-kernel suites and focused `packages/web` tests for individual adapters. See [development guide](../../../../../docs/development.md) for build prerequisites and test selection.
