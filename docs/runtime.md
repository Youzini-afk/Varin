# Native Agent Runtime

Native Varin conversations run in the Rust `varin-runtime` crate, with Thread, HistoryBranch, Run, Request, ModelStep, Operation, Wait, queues, and usage persisted in `Catalog` (`conversation.sqlite`) + immutable `ContentStore`. Application Host handles auth, model accounts, resources, MCP, and extensions; `varin-kernel` connects the runtime to Storage, processes, compute, and Host bridges. External harnesses keep their own loops while storing bindings/observations in the same Catalog ([external-agents.md](external-agents.md)).

Authoritative schema & code: [kernel/protocol/schema.json](../kernel/protocol/schema.json) · [varin-runtime/README.md](../kernel/crates/varin-runtime/README.md) · [catalog.rs](../kernel/crates/varin-runtime/src/catalog.rs) · [execution.rs](../kernel/crates/varin-runtime/src/execution.rs) · [supervisor.rs](../kernel/crates/varin-runtime/src/supervisor.rs) · [run_assembly.rs](../kernel/crates/varin-kernel/src/run_assembly.rs).

## Core Identities & Single Writer

- **Thread**: Durable conversation/work identity. **HistoryBranch**: Ancestor chain + head (only one active history committer per branch). **Run**: One admitted execution on a branch. **ModelStep**: One provider exchange. **ToolCall**: Model invocation. **Operation**: Real work whose lifetime (`call` / `Run` / `Thread` / `environment`) can outlive the tool return. **Source**: Resource view + Host owner.
- **Durability**: `Catalog` uses an exclusive writer lock, SQLite WAL + `synchronous=NORMAL`, and short transactions. Content bytes flush to `ContentStore` before referencing metadata commits; publication leases guard in-flight objects against concurrent GC.
- **Upgrades**: Handled transactionally on open in [catalog_upgrade.rs](../kernel/crates/varin-runtime/src/catalog_upgrade.rs); unknown/newer/corrupt stores fail closed read-only.
- **Conversation organization**: Lives in Catalog partitioned by authenticated principal (containers, ordering, local revisions, retired dissolved IDs). Does not duplicate chat history, archive state, or Host Settings projects.

## Pluggable Run Drivers (`varin.agent.driver@1`)

- `RunSupervisor` invokes the frozen `RunDriver` for each admitted Run: `DefaultRunDriver` runs the built-in Rust `ExecutionEngine` (`policy@4`); `varin.agent.driver@1` lets a trusted Host extension orchestrate parallel models, dynamic tools, custom context, and delivery directly.
- Selected via Settings → Extensions → Services (scoped per user/workspace; installing never auto-selects; changes apply only to new Runs).
- Host scopes callbacks to `(Run, kernel epoch, instance)` — extensions cannot pass foreign IDs in JSON to gain authority.
- Primitives: `model` (parallelizable by stable ID), `tool` (runs through real `InvocationRunner`/permissions/idempotency; `JobAccepted` is final for async tools), `context` (drains Inbox & recompiles instructions/tools), `wait` (event-driven cursor wait on Run facts), `cancel`, `receipt`, `deliver` (publishes visible output), `checkpoint`, and `finish` (atomic Catalog completion; returns `input_pending` / `work_pending` if new work arrived).
- Recovery declares `none` or exact-schema `checkpoint` with an explicit `resume` callback (never reruns `run` as `resume`). Example: [parallel-driver](../examples/extensions/parallel-driver/README.md).

## Admission, Queues, Retry & Deletion

- **Idempotent admission**: Inputs commit with `(commandKey, branch preconditions, frozen config)`. Same-key retries return the original receipt; queued inputs keep their frozen config/revision.
- **"Send now"**: Atomically moves a queued next-turn message into the active Run and cancels an unstarted successor Run without interrupting in-flight generation/tools; delivers at the next closed model-request boundary.
- **Model retry** ([model_retry.rs](../kernel/crates/varin-runtime/src/model_retry.rs)): Configured host-wide under Conversation Defaults (`enabled`, `maxRetries`, backoff, ordered status/code/message rules; `/api/models/retry/test` evaluates drafts via `runtime.retry.evaluate`). Server `Retry-After` acts as a floor. Conversation/compaction retries create new `ModelStep`s without re-running finished tools; auxiliary inference records attempts on the original Operation. Stop cancels retry waits immediately.
- **Auxiliary runs** (titles, commit messages, PR descriptions, next-step suggestions): Independent native Runs without inventing conversation branches. Auto-title ([thread-titles.ts](../packages/web/application-host/lib/model-text/thread-titles.ts)) names after first turn and re-evaluates at configured intervals (default 5 turns); manual rename freezes auto-naming until explicitly restored.
- **Thread deletion**: Hides Thread and schedules reclamation once active Runs/executors settle and settle billing. Shared history referenced by surviving branches/children stays pinned; compact creation/identity/schedule-dedup records remain so retries never re-trigger deleted work.

## Reads and Observation

- **Dedicated read connection** ([catalog_reads.rs](../kernel/crates/varin-runtime/src/catalog_reads.rs), [agent_catalog_reads.rs](../kernel/crates/varin-kernel/src/agent_catalog_reads.rs)): Read-only WAL snapshots outside the writer lock (bodies read under content leases).
- **Composite views**: [catalog_thread_view.rs](../kernel/crates/varin-runtime/src/catalog_thread_view.rs) returns history window (`afterHeadId` incremental append), queues, Operations, context, children, Goals, `modelActivity`, and event cursor in one snapshot. [catalog_context_inspection.rs](../kernel/crates/varin-runtime/src/catalog_context_inspection.rs) serves context breakdown directly from Rust.
- **Event fan-out**: Durable events carry explicit `(thread_id, branch_id)` ([catalog_event_scope.rs](../kernel/crates/varin-runtime/src/catalog_event_scope.rs)). Host [event-hub.ts](../packages/web/application-host/lib/kernel/event-hub.ts) shares one native reader while tracking per-observer cursor/principal/interest. Client [thread-observation.ts](../packages/application-client/src/thread-observation.ts) multiplexes per Host and resyncs on subscribe/reconnect/gaps.

## Tools, Disclosure, Capacity & Execution Receipts

- **Work focus & disclosure** ([tool_disclosure.rs](../kernel/crates/varin-runtime/src/tool_disclosure.rs)): `general` / `code` / `research` / `office` decide which tools are directly declared in `direct_tools` (no hidden mode prompt injected). Full executable directory stays accessible via `tool_describe` (browse/search/op-specific schemas, never mutating the active function list) and `tool_invoke`. MCP keeps its own `direct` / `deferred` / `codemode` / `hidden` controls ([MCP.md](../packages/web/application-host/lib/kernel/MCP.md)).
- **Output projection & budgets**: Raw `OutputBody.data` stays intact; owners may attach `model_data`. Long outputs budget under `harness.output.visibleBytes` (preserving JSON structure/errors/cursors + `outputPreview` pointers readable via `read_thread({ kind: "output" })`). Explicit `file_read`/`process_read`/`read_thread` pages are never double-truncated.
- **Typed short refs**: `file:`, `proc:`, `env:`, `material:`, `page:`, `obs:`, `item:` map via Catalog's ref index to immutable owners/versions without string-scanning prose or expanding permissions.
- **Resource & compute admission** ([resource_admission.rs](../kernel/crates/varin-runtime/src/resource_admission.rs)): Acquires full resource plan + `configured_compute_capacity` (default `min(cores, 2)`, override `VARIN_COMPUTE_CONCURRENCY`) atomically; non-conflicting work bypasses blocked queues. Linux research probes read cgroup v1/v2 limits (`VARIN_RESEARCH_RESERVE_CPU_CORES`, `VARIN_RESEARCH_RESERVE_MEMORY_MB`).
- **Operation receipts & cancellation**: Track phase, outcome, effect (`none` | `dispatched` | `partial` | `confirmed` | `unknown`), and confirmed `executor_stopped` separately. Cancel writes intent first, then drains owners. Unknown dispatched work is never auto-replayed on restart; explicit foreground cancel can settle a Run while leaving the underlying Operation/occupation open for late reconciliation.
- **Script nested calls**: Reuse frozen `ToolDirectory`, permissions, and resource admission; `script_run.title` labels the collapsible tree of nested Operations in UI.

## Context Preparation & Compaction

- **Timestamp injection**: Opt-in ("Time info" in Context settings, off by default); attached adjacent to each user message so system prompt prefixes stay stable.
- **Environment observations**: Committed Documents edits, user terminal OSC completions, and Git status snapshots commit directly to Catalog/ContentStore (bypassing Knowledge), budgeted into requests without blocking or triggering extra paid turns.
- **Compaction** ([context_job.rs](../kernel/crates/varin-runtime/src/context_job.rs), [context-compaction.ts](../packages/web/application-host/lib/kernel/context-compaction.ts)):
  - Triggered by `varin.context.budget@1` (`compaction.reserveRatio`, background prep ahead of threshold; hard `context-wait` only when next request exceeds budget).
  - Configured under Agents → Context Compaction (`harness.models.contextCompaction`, default inherits session model). Supports `varin.context.compaction@1` custom DAGs (independent DAG nodes run in parallel).
  - Model generates summary + `retain` list of original message-group refs (budgeted with local tokenizers, [models/DOCUMENTATION.md](../packages/web/application-host/lib/models/DOCUMENTATION.md#tokenizer-metadata-and-cache)); read-only `summary_read` lets compaction inspect history/tasks/records.
  - Publishes atomically with checkpoint/memory CAS while preserving messages arrived during background prep.
- **History navigation**: Explicit rewind/branch commits head CAS and preserves the previous head as a surviving `HistoryBranch` sharing immutable history (`runtime.thread.tree` serves the merged branch tree).

## Waits, Follow-Ups & Long-Lived Event Watches

- **Durable Wait**: Suspends a Run on a concrete subject (question, child, process/Job, reply, context-ready) with event cursor + optional deadline.
- **Follow-ups**: Conditional continuations (time, process/Job stop, file `exists`/`changed`/`ready`, research artifacts/metrics, Any/All).
- **Long-lived event watches** ([catalog_followup_events.rs](../kernel/crates/varin-runtime/src/catalog_followup_events.rs), [catalog_followup_event_transport.rs](../kernel/crates/varin-runtime/src/catalog_followup_event_transport.rs), [event-sources.ts](../packages/web/application-host/lib/extensions/event-sources.ts)):
  - Stored in Catalog `followups` without requiring an active `source_run_id`. Shared plugin connections keep one event ledger; each watch maintains its own match cursor.
  - Events persist bodies/files in ContentStore and commit metadata before ACKing the plugin. Supports replaceable state snapshots (`state: { key, sequence, value }`), batching, Calendar-aligned delivery, passive queuing, cross-Host authenticated consumers, and echo suppression tied to confirmed local Operations.
- **Schedules**: Project Markdown schedules run on the Source's asset Host ([managed-schedule-service.ts](../packages/web/application-host/lib/kernel/managed-schedule-service.ts), [schedule_reconciliation.rs](../kernel/crates/varin-kernel/src/schedule_reconciliation.rs)) with begin-fence before callback dispatch.

## Providers, Usage Ledger & Image Tools

- **Providers & Auth**: Native adapters ([providers/README.md](../kernel/crates/varin-runtime/src/providers/README.md), [AUTH.md](../kernel/crates/varin-runtime/src/providers/AUTH.md)) resolve secrets via Host [models](../packages/web/application-host/lib/models/DOCUMENTATION.md) right before dispatch; secrets never enter snapshots, history, or events. Custom extension protocols (`varin.models@1`) pin exact `adapterIdentity` + `adapterBindingId`.
- **Usage ledger**: `runtime.usage.summary` reads content-free per-request billing records frozen at dispatch (retained after conversation deletion; priced from custom or models.dev snapshots in USD; pushed via `usage.updated`). External harnesses report their own turn/cumulative stats separately.
- **Image tools** ([image-runtime.ts](../packages/web/application-host/lib/kernel/image-runtime.ts)): `image_generate` and `image_edit` bind explicitly configured image models (never implicitly inheriting chat models), store outputs as media resources, and preserve raw provider usage units.

## Graceful Shutdown & Cold Backup

- Host shutdown immediately enters `draining` (revoking readiness and rejecting new executions while allowing reads, cancels, and receipt cleanup) under a single monotonic `VARIN_SHUTDOWN_TIMEOUT_MS` deadline (default 10s; exit code 143 on graceful SIGTERM, 1 on incomplete drain without closing active DB writers early).
- Cold backup preserves WAL, ContentStore, and identities with startup fencing enabled by default on restored copies ([ops/cold-backup.md](ops/cold-backup.md)).
- On restart, prepared-but-undispatched requests may proceed; dispatched requests with unknown outcomes never auto-replay.
