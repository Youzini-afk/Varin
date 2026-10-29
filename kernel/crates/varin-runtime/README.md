# Agent runtime crate

`varin-runtime` owns Varin's native Thread/branch history and execution facts through `varin-kernel`.
The product uses this Catalog for conversations, queued input, Runs, Operations and durable events.
It does not import historical Pi sessions or duplicate Host domain asset stores.

Read [runtime ownership and mechanisms](../../../docs/runtime.md) for the cross-layer contract.
This document is the local code map and maintenance boundary, not an implementation timeline.

## Code map

| Responsibility | Entry points |
| --- | --- |
| Single durable owner, short metadata transactions, format preflight | [catalog.rs](src/catalog.rs) |
| Thread titles, archive/pin, read positions and visibility tombstones | [catalog_threads.rs](src/catalog_threads.rs) |
| Transaction-consistent, metadata-only Host attention (including hidden unsettled work) | [catalog_attention.rs](src/catalog_attention.rs) |
| Deleted conversation metadata retirement and surviving reference protection | [catalog_retention.rs](src/catalog_retention.rs) |
| Worker lifecycle, cancellation, policy actions, model/tool settlement | [execution.rs](src/execution.rs), [supervisor.rs](src/supervisor.rs) |
| History/request commit, safe restoration, explicit navigation | [catalog_execution.rs](src/catalog_execution.rs), [catalog_recovery.rs](src/catalog_recovery.rs), [catalog_navigation.rs](src/catalog_navigation.rs) |
| Immutable bodies, media, publication and collection | [content.rs](src/content.rs), [output.rs](src/output.rs), [content_collection.rs](src/content_collection.rs) |
| Scope-local bindings, tools and context transforms | [composition](src/composition.rs) |
| Resource conflict/capacity admission and nested calls | [resource_admission.rs](src/resource_admission.rs), [execution_capacity.rs](src/execution_capacity.rs), [nested_tools.rs](src/nested_tools.rs) |
| Context checkpoint/summary plans and capacity | [context_job.rs](src/context_job.rs), [context_execution.rs](src/context_execution.rs), [catalog_context_jobs.rs](src/catalog_context_jobs.rs), [context_capacity.rs](src/context_capacity.rs) |
| Protocol adapters, frozen bodies and credential resolution | [providers](src/providers/README.md), [request_body.rs](src/request_body.rs) |
| Child/family work, current/history directory, messages and continuation | [catalog_collaboration.rs](src/catalog_collaboration.rs), [catalog_delegated.rs](src/catalog_delegated.rs), [catalog_family.rs](src/catalog_family.rs), [catalog_messages.rs](src/catalog_messages.rs), [catalog_activation.rs](src/catalog_activation.rs) |
| Durable conditions and deliveries | [catalog_observations.rs](src/catalog_observations.rs), [catalog_followups.rs](src/catalog_followups.rs), [catalog_process_wait.rs](src/catalog_process_wait.rs), [catalog_reply_wait.rs](src/catalog_reply_wait.rs) |
| Goals, Bot suspension and memory work | [catalog_goals.rs](src/catalog_goals.rs), [catalog_bot.rs](src/catalog_bot.rs), [catalog_memory_work.rs](src/catalog_memory_work.rs) |
| Independent domain Jobs and calendar occurrences | [catalog_host_jobs.rs](src/catalog_host_jobs.rs), [catalog_calendar.rs](src/catalog_calendar.rs) |

Private domain types stay in Rust. [The kernel schema](../../protocol/schema.json) generates wire
Rust/TypeScript DTOs and shared state enums; `types_generated.rs` is generated output. Current format
constants and read-only validation live beside their domains. Do not copy version numbers into a
second maintenance ledger or add old-format fallback readers.

## Boundaries to preserve

- One `runtime.owner` lock protects `conversation.sqlite`. WAL/FULL transactions commit facts and
  events together. Read-only preflight rejects incompatible/malformed existing formats before epoch
  changes or recovery. A failed open cannot turn history into an empty cache.
- Catalog owns references and identity/CAS checks. Providers, tools, extension callbacks, filesystem
  scans, body hydration/serialization and network work execute outside its lock. Capture the relevant
  epoch/revision/head, prepare on a worker, then recheck at publication.
- Immutable ContentStore bodies are installed before their metadata references. Publication leases
  span staging and commit; GC follows domain roots and typed dependencies. Public media/body reads
  require their actual history/input/Operation/event/family holder, not possession of a hash.
- `RequestPrepared`, dispatch, model completion, tool acceptance and external receipt are distinct
  facts. Never replay an ambiguous dispatched model/effect to repair missing acknowledgement.
- Operation business outcome/effect and `executor_stopped` are independent. Cancellation intent,
  reader abort, output completion and missing occupancy do not prove an external executor stopped.
  Late receipts keep the original executor epoch and cannot settle replacement work.
- A model request pins its actual provider/tool/context bindings. Normal retirement permits retained
  exchanges to finish; revocation rejects/cancels them. Recovery uses the saved composition and
  artifact identities instead of silently applying current routing.
- Branch history has one writer. Background summary, memory and planning work uses separate admitted
  identities. A Wait releases active execution while retaining the dependency/continuation; cancelling
  observation does not cancel the observed Job or withdraw an independent follow-up definition.
- Current memory is a request projection of the existing Memory owner. It is not a second note store.
  Only successful original delivery facts advance acknowledgement; summaries/navigation never delete
  the underlying memory to make a context projection agree.

Thread product metadata is committed with its event and original command receipt. Rename, pin,
archive and delete use a metadata revision; read acknowledgements monotonically advance only through
the observed durable event cursor. Metadata changes do not create unread activity. A delete is a
visibility tombstone that requests content maintenance. It rejects new user input,
messages, explicit child continuations and forks while already accepted queue/child/Run work retains
its original execution and settlement duties. Internal owner discovery includes archived/deleted
Threads; the separate product Catalog query omits tombstones and auxiliary inference Threads.
Maintenance waits for terminal Runs and original executor/model settlement before retiring owned
history, requests and receipts. Surviving branch ancestry and relational consumers keep shared data
reachable. Small Thread/branch identities and deletion receipts remain for stable identity and replay;
ContentStore then collects unreferenced immutable bodies through its existing reader/publication fences.
Inline metadata commands are not ContentStore roots. Active deleted conversations are reconsidered on
durable execution events and Host restart; deletion does not cancel their original execution duties.

## Request and context cost model

`ConversationHistory` shares immutable item `Arc`s across policy views and prepared requests. A Run
worker retains only its latest compiled prefix under exact epoch/Run/branch/checkpoint/ancestry identity;
new steps hydrate the new suffix, while current memory/Goal/policy evidence is freshly projected.
Navigation, changed checkpoints and worker exit discard the derived cache.

The current-teammates projection is appended last and omitted when empty. It is temporary request data;
only the exact request snapshot retains it. Delivery acknowledgements consume reports actually included in
the organizer's completed model exchange. The same indexed lifecycle facts drive current/history UI pages.

`RequestBody` is the only provider-body representation. Responses/Azure/Codex can retain independent
item fragments and tool schemas; Codex also retains the exact ordered system-text join. Grouped
protocols reuse complete messages under their actual source sequence and tool-call dependencies;
changing a trailing group rebuilds that group. Lease validation and credential dispatch checks still run on
every call. The final contiguous bytes are shared with HTTP/signing and retained in snapshots without
JSON rewriting. Vector validation, full-body assembly, persistence/hashing and media processing remain
real costs; fragment reuse does not establish lower peak memory or provider cache savings.

Compaction's Budget Decision and algorithm producer are separate contracts. Frozen text and model-node
DAG plans use the same summary Run/publication path. Its supervised executor loads original material
once and runs ready nodes concurrently, releasing successors as their own dependencies complete.
Original ModelSteps persist each request, dispatch, output and usage; the active-request index remains
exclusive for a conversation or one summary node. Audit history may reflect completion order, while
node inputs follow only the frozen recipe. Pure text produces zero ModelSteps. Complete serialized
capacity is checked before dispatch; reopening consumes completed nodes and never replays an unknown
dispatch. A failed node cancels and joins its remaining workers before the Run settles.

Summary recipes freeze the previous summary and all original material in the selected history range,
including originals retained by the preceding checkpoint. Native automatic compaction selects the latest
complete exchange as its capture boundary. The model returns a summary and original-block references;
it chooses retention throughout that material, rather than inheriting a predetermined recent suffix.
Offline tokenizer counts accompany each retention group, and the continuation budget covers summary plus
originals. User message parts and complete provider/tool exchanges share a group. Costs identify
unmeasured media/provider content and are not provider billing measurements. The original history remains
durable; checkpoint references keep selected items, including their media, alive through collection.
`token_count` loads a generic tokenizer binding frozen in model configuration and request snapshots:
an encoding name or a content-addressed Host-prepared `tokenizer.json` file. The Host owns discovery,
public downloads, gzip cache preparation and collection; Rust decompresses/hashes/parses each live
file binding once. Live counters share both file tokenizers and owned tiktoken encodings through weak
registry entries. A Run compiler retains its lazy counter across tool steps; the last counter releases
the vocabulary. Missing/unusable files use a labeled reference encoding without stopping the Run.
OpenAI mappings come from tiktoken. Matching trims/lowercases identifiers for lookup and recognizes
known model names at channel/deployment/tag boundaries, including suffix paths and fine-tune base IDs.
Numeric versions stay intact, conflicting encodings remain unmatched, and explicit tokenizer bindings
take precedence. The original provider request model is unchanged. Unmatched models use the o200k reference.
No model-specific vocabularies or parallel encoding tables are bundled. Immutable request fragments cache counts; changed
tokenizer bindings invalidate calibration/reuse identities. Summary input uses its own model tokenizer;
retained material uses the frozen conversation tokenizer.
Later input is appended after the frozen cut. Resource/personalization refresh preserves the selection;
forking or navigation that discards the summary also discards its selection.
Model nodes use [summary_tools.rs](src/summary_tools.rs) for read-only original history/output and related
records; normal Tool invocations retain query audit and recovery. Text plans remain tool-free.

## Composition with the kernel and Host

The kernel's [Run assembly](../varin-kernel/src/run_assembly.rs) connects this crate to real source,
resource and tool owners. [Host integration](../../../packages/web/application-host/lib/kernel/DOCUMENTATION.md)
provides authenticated launch/control, credentials, MCP/extension bridges and domain adapters.
[Recovery](../../../packages/web/application-host/lib/recovery/DOCUMENTATION.md) combines original
file journals with guarded history navigation. Source Hosts retain their own resource receipts;
Catalog coordination never makes a remote hash or path local authority.

The [MCP contract](../../../packages/web/application-host/lib/kernel/MCP.md) documents retained server
bindings, Tasks, resources and reverse interactions. Its finite/drained callbacks and physical process
stop are separate evidence. Fixed branches currently provide no workspace-MCP execution cwd; managed
child composition does not merge arbitrary parent Source cuts.

## Verification

Local behavior tests accompany their owning domains; [execution tests](src/execution_tests.rs),
[supervisor waits](src/supervisor_wait_tests.rs), [content tests](src/content_tests.rs) and
[provider tests](src/providers/tests.rs) exercise shared seams. Kernel `*_review.rs` files and Host
`*.native.test.ts` consumers cover real owner composition at their stated fixture/platform boundary.
A source-level fixture is not live-provider, installed-product or physical multi-Host acceptance.

Use [development guidance](../../../docs/development.md) and repository scripts for commands. Choose
checks from the behavior changed; documentation-only consolidation does not require a runtime build.
Keep unresolved external effects, platform limits and unexecuted acceptance explicit rather than
substituting test counts for coverage.
