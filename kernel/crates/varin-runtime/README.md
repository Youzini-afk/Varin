# Agent runtime crate

`varin-runtime` owns Agent conversation history and execution facts. The explicit Agent Thread path
uses it through `varin-kernel`; the default product path still uses Pi. This crate does not write Pi
session JSONL or duplicate Host domain asset stores.

Read [runtime ownership and mechanisms](../../../docs/runtime.md) for the cross-layer contract.
This document is the local code map and maintenance boundary, not an implementation timeline.

## Code map

| Responsibility | Entry points |
| --- | --- |
| Single durable owner, short metadata transactions, format preflight | [catalog.rs](src/catalog.rs) |
| Worker lifecycle, cancellation, policy actions, model/tool settlement | [execution.rs](src/execution.rs), [supervisor.rs](src/supervisor.rs) |
| History/request commit, safe restoration, explicit navigation | [catalog_execution.rs](src/catalog_execution.rs), [catalog_recovery.rs](src/catalog_recovery.rs), [catalog_navigation.rs](src/catalog_navigation.rs) |
| Immutable bodies, media, publication and collection | [content.rs](src/content.rs), [output.rs](src/output.rs), [content_collection.rs](src/content_collection.rs) |
| Scope-local bindings, tools and context transforms | [composition](src/composition.rs) |
| Resource conflict/capacity admission and nested calls | [resource_admission.rs](src/resource_admission.rs), [execution_capacity.rs](src/execution_capacity.rs), [nested_tools.rs](src/nested_tools.rs) |
| Context checkpoint/summary plans and capacity | [context_job.rs](src/context_job.rs), [catalog_context_jobs.rs](src/catalog_context_jobs.rs), [context_capacity.rs](src/context_capacity.rs) |
| Protocol adapters, frozen bodies and credential resolution | [providers](src/providers/README.md), [request_body.rs](src/request_body.rs) |
| Child/family work, messages and continuation | [catalog_collaboration.rs](src/catalog_collaboration.rs), [catalog_messages.rs](src/catalog_messages.rs), [catalog_activation.rs](src/catalog_activation.rs) |
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

## Request and context cost model

`ConversationHistory` shares immutable item `Arc`s across policy views and prepared requests. A Run
worker retains only its latest compiled prefix under exact epoch/Run/branch/checkpoint/ancestry identity;
new steps hydrate the new suffix, while current memory/Goal/policy evidence is freshly projected.
Navigation, changed checkpoints and worker exit discard the derived cache.

`RequestBody` is the only provider-body representation. Responses/Azure/Codex can retain independent
item fragments and tool schemas; Codex also retains the exact ordered system-text join. Grouped
protocols keep their complete compiler. Lease validation and credential dispatch checks still run on
every call. The final contiguous bytes are shared with HTTP/signing and retained in snapshots without
JSON rewriting. Vector validation, full-body assembly, persistence/hashing and media processing remain
real costs; fragment reuse does not establish lower peak memory or provider cache savings.

Compaction's Budget Decision and algorithm producer are separate contracts. Frozen text and model-node
DAG plans use the same summary Run/publication path. The current executor is topological and serial.
Pure text produces zero ModelSteps; model nodes retain actual request/usage identities and check the
complete serialized capacity before dispatch. Accepted recipes are not recomputed on reopening.

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
