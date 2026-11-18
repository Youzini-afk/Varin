# Memory ownership and Agent personalization

Varin separates **ordinary Agent memory** (explicit, lightweight notes and prompt overrides stored in a Rust typed record) from **Bot long-term memory** (KnowledgeStore-backed narratives, recall, and background organization). Native instruction/skill resources have a separate owner in [agent-resources/DOCUMENTATION.md](../agent-resources/DOCUMENTATION.md).

## Entrypoints and routes

| File(s) | Responsibility |
| --- | --- |
| [`agent-personalization.ts`](agent-personalization.ts), [`agent-personalization-routes.ts`](agent-personalization-routes.ts), [`personalization-context.ts`](personalization-context.ts), [`prompt-tool-catalog.ts`](prompt-tool-catalog.ts) | Rust `agent.personalization` record owner, `/api/agent-personalization` CRUD routes, prompt projection, and settings tool catalog |
| [`memory-service.ts`](memory-service.ts), [`memory-recall.ts`](memory-recall.ts), [`memory-sources.ts`](memory-sources.ts), [`bot-recall-context.ts`](bot-recall-context.ts) | Bot/user/Thread KnowledgeStore memory CRUD, provenance validation, and recall ranking/context |
| [`bot-history.ts`](bot-history.ts), [`memory-inference.ts`](memory-inference.ts), [`memory-organizer.ts`](memory-organizer.ts) | Native Bot history/span reading, Catalog `MemoryWork` inference, and background organization |
| [`memory-maintenance.ts`](memory-maintenance.ts), [`memory-maintenance-state.ts`](memory-maintenance-state.ts), [`memory-maintenance-material.ts`](memory-maintenance-material.ts) | Local review/rewrite/merge/split maintenance of existing Bot memory accounts |
| [`selection-memory.ts`](selection-memory.ts), [`thread-memory.ts`](thread-memory.ts), [`thread-memory-routes.ts`](thread-memory-routes.ts) | Explicit chat-selection extraction preview, save, and undo |
| [`thread-remember.ts`](thread-remember.ts), [`thread-remember-routes.ts`](thread-remember-routes.ts) | Composer quick-save routing to Bot/user memory or ordinary Agent notes |

Kernel tool bridges live in [`../kernel/memory-owner.ts`](../kernel/memory-owner.ts), [`../kernel/bot-memory-owner.ts`](../kernel/bot-memory-owner.ts), and [`../kernel/thread-context.ts`](../kernel/thread-context.ts).

## Ordinary Agent personalization and Thread context

- **Storage & CAS**: `agent-personalization.ts` owns one Rust typed record (`agent.personalization`) holding global, project (by configured project ID), and Thread (by native Thread ID) notes plus scoped system-prompt edits. No background extraction or implicit import occurs for ordinary chats. New notes append via the serialized writer without a preliminary read; updates/deletes require the observed revision and reuse atomic `storage.record.put` receipts (`runtime.memory.reconcile` settles lost returns without replaying writes).
- **Kernel client lifecycle**: Personalization lives on the Host; its scoped kernel client binds to one kernel epoch and reacquires a fresh grant after kernel exit. Stale internal grants fail as execution-preparation errors, never source-auth loss.
- **Scope isolation**: `kernel/memory-owner.ts` and `kernel/thread-context.ts` enforce admitted Run, operation, and scopes (children do not inherit parent Thread notes or assembled system prompts; Bot contexts exclude ordinary notes/prompt profiles and fail closed on Thread-note writes).
- **Context checkpoints & delivery**:
  - Immutable context checkpoints separate the frozen memory snapshot from editable prompt sections. Note edits are immediately readable via `memory` tools without mutating an already prepared `RequestSnapshot`.
  - `ContextPreparation` runs outside Catalog locks before freezing a new request; pre-admission failures emit a durable `context.preparation_failed` fact without fabricating a ModelStep.
  - Catalog stores a read-only scoped projection of newer note facts (`EnvironmentFact` provenance) until a compaction snapshot covers them. Native tool receipts suppress duplicate delivery only when matching the confirmed Operation, origin, and receipt body. Failed/cancelled requests never mark facts committed; forks copy known-note identities without copying another branch's delivery ACKs.
  - Compaction atomically publishes summary, memory snapshot, and effective system text under profile CAS while preserving newer notes and tail history.
- **Schema & retention**: Read-only SQLite checks validate canonical TEXT primary keys, non-partial BINARY/ASC revision indexes, and FK actions before writable open (malformed stores are preserved, never migrated/reconstructed). Per-note tombstones and typed-record receipts remain retained while old checkpoints or unresolved effects may reference them.

## Bot background inference

- **Ownership & gates**: Bot mode comes from the Catalog Thread binding, never caller flags. `memory-inference.ts` runs organizer narration and selection preview via `models.memoryOrganizer` (falling back to the Bot model only when unset; explicit disable or invalid config never falls back). Bot Sleep closes the gate, cancels durable work, and awaits local executor drain; Wake resumes only proven unsent work and reuses completed output. Dispatched `Unknown` work retains evidence without blocking new entries; prepared mutations recheck the gate before each write while still reconciling already-committed receipts.
- **Catalog `MemoryWork`**: Each organizer/decision/preview stage runs as a separate Catalog `MemoryWork` Run whose frozen sources, ranges, model binding, output, and usage live in ContentStore (`OrganizerProgress.workId` holds only a reference). Complete generation requires `Stop` plus valid citations. Explicit Retry on selection preview creates a linked attempt only after local executor drain (retaining and disclosing unknown provider billing).
- **Source spans & Bot memory tools**: `bot-history.ts` reads immutable `HistoryItem`s, events, and Run reports via Catalog ancestry checks using the same UTF-16 text projection as the UI. `kernel/bot-memory-owner.ts` enforces Run/Bot bindings and scope isolation (children do not inherit a parent's local Thread store; read-only file sources do not block independently admitted memory/plan writes). Mutations commit their `MemoryService` result atomically with the KnowledgeStore write.
- **Bot recall & ContextJob baseline**: `bot-recall-context.ts` enriches recall from current work, matters, and registered project metadata (invalidating cache on metadata changes without granting source access or reading tool logs; forgotten passages are stripped first). `ContextJob` freezes a typed reference to the immutable memory projection and installs it as baseline only on successful publication so subsequent requests project deltas cleanly.

## Continuous Bot memory and maintenance

- **Background collection**: `bot-history.ts` pages recent exchanges via `HistoryPage.afterId` and per-branch `history-cursor:`, hydrating a model-budgeted chronological tail without creating empty stores or calling a model on empty discovery. Explicitly followed ordinary branches require a separate `memory` association.
- **Archive vs forget**: `invalidAt` (archive) marks a memory no longer applicable while keeping history readable; `forgottenAt` (forget) additionally excludes its original source ranges and dependent revisions (`sources.memories`) from future model reads. New exclusions fix `redactedThrough` once, dropping affected provider continuations and rebuilding summaries/history/handoffs without altering UI history.
- **Local maintenance (`memory-maintenance.ts`)**: Coalesced `maintenance:auto:<id>` progress (separate for Bot and shared user stores) reviews existing accounts using `MemoryWork` and commits rewrites, merges, splits, retirements, overviews, and dependency invalidations atomically via `maintainKnowledge` (`source.predecessors` tracks historical inputs; `source.memories` tracks live exact-version dependencies). Organizer batching requires a configured model `contextWindow` (reserving 25% capped by max output when unset). Native `memory` exposes `rewrite`, `organize`, `maintenance_status`, and `maintenance_cancel`.
- **Material release & cleanup**: After commit and drain, `MemoryWork` `release` drops recipe/inference bodies from ContentStore roots while preserving identities, usage, and receipts. Explicit history cleanup compacts retired bodies while retaining lineage, source exclusions, and active conversation tool receipts.

## Composer quick save

[`thread-remember.ts`](thread-remember.ts) resolves destinations from the bound Catalog Thread/branch (Bot/shared-user memory for Bots; Thread/project/global notes for ordinary conversations). Saves keep explicit user-edited text with observed revision and stable mutation ID so lost responses replay the original receipt safely. Optional model-assisted drafting runs as a separately confirmed normal task whose output requires user review before saving.

## Verification

`agent-personalization.native.test.ts` and native memory delivery suites cover Rust persistence, scope isolation, CAS conflicts, and checkpoint publication. See [development guide](../../../../../docs/development.md).
