# Native agent runtime

This crate owns native conversation history and execution facts. The existing Pi product route has
not been cut over. The kernel's explicit `runtime.*` management methods use this authority without
writing Pi session files or the Host harness's existing execution records.

## Implemented boundaries

- `Catalog` locks one `conversation.sqlite` owner and uses SQLite WAL/FULL short transactions.
  Unsupported formats are errors; this user-history database is never recreated as a cache.
- Input admission, branch ownership, operations, model request snapshots, waits/resumptions and
  delivery identities survive reopening. Events commit with the corresponding facts.
- `execution` drives a bound model provider and tool executor on a worker. Tool results have stable
  request/call/operation identities, real effect receipts and provider-specific original items.
  The default policy is replaceable; it does not own or mutate the catalog itself.
- `catalog_execution` commits model output, immutable conversation items and unresolved call identities
  together. A frozen request cannot publish against a changed history head.
- `composition` prepares and publishes revision-checked bindings. Retired model pins preserve the
  actual schema/implementation; explicit revocation still rejects execution.
- The kernel's native control worker is independent of its Storage queue. The Host client has separate
  native request credits. Native commands are currently Host-management-only, not delegated tools.

The wire source remains `kernel/protocol/schema.json`; it generates the native state enums and the
Host request/response DTOs. Domain implementation types remain private to Rust.

## Run activity scope

Each Run pins the context checkpoint present in its admission transaction, including queued
NextRun admission. The reference records provenance; it does not stop ordinary execution context
refreshes. An absent admission checkpoint stays unscoped even if its branch later gains context.
Immutable checkpoint publication indexes its project identity beside the content reference, so
observer discovery, reads, and ACK checks need no prompt-body hydration or mutable branch lookup.
Context domain format 2 owns these columns; unsupported older internal formats fail without a
scope migration or inferred historical binding.

Host subscriptions select independently for each admitted Thread/project scope. Their stable
identity includes service, selected provider, Thread and the exact nullable project (`null` means
no project). Admission requires the project owner’s canonical, non-empty IDs; blank or padded
project IDs fail explicitly instead of being trimmed or treated as no project.
The native read and delivery authorities enforce the same scope, reuse original event
cursors and delivery records, and apply the Host's processed `throughCursor` fence. A new branch
or context cannot revoke or relabel another Run's historical activity.

## Immutable conversation and model bodies

Model-step metadata holds content references for frozen requests and provider originals. History
rows retain identity, ancestry and provenance, while their original content and provider payloads
live in immutable objects. Committed and rejected model outputs are also referenced objects. The
runtime persists content-defined chunks and ordered manifests under `content/objects` before
committing references in SQLite. SHA-256 identities and object paths are shared with kernel content
primitives; conversation objects have a separate GC domain because kernel storage can be rebuilt
independently. Dispatch, recovery and input-supersession writes preserve small references. Public
history, model-step and model-output APIs verify and hydrate their original values; completion
resolves the exact frozen request before its metadata transaction.

Queue admission and edits persist the eventual history payload before atomically recording its
reference in `input_history_content`. Delivery and next-run promotion can therefore attach history
without large body writes inside their transactions. Queue metadata still includes the accepted
input for its current public API; cancellation preserves its content reference. Command-idempotency
and tool-receipt records remain their existing inline domains in this slice.

Opening previous native content formats performs one atomic conversion, retaining existing request
references and preserving history, opaque originals and unknown history metadata. Durable objects
precede the conversion transaction; interruption leaves either the old representation or committed
references, never empty history. Catalog version 3 and content format 2 select one current reader
and prevent older binaries from treating references as inline payloads. Missing or corrupt referenced
objects fail explicitly. `Catalog::collect_content_objects` marks requests, provider originals,
history, all model outputs (including rejected output), and queued-history references, verifies live
objects before sweeping, and preserves unknown files. It never deletes history or invokes the
replaceable system-kernel GC.

Provider serialization still visits and sends full legal requests; chunk reuse is not remote
incremental-context support or a measured speedup claim.

## Execution and trust

Catalog methods do no provider, tool, extension or network I/O. A mutex around Catalog is held only
for a local commit or read. The cancellation token is independent of catalog and progress delivery;
requesting cancellation does not invent a stopped executor or erase an external effect.

A dispatched model request is interrupted on restart and is not automatically sent again. An
unconfirmed external effect becomes indeterminate and requires reconciliation. Wait resumption uses
a durable identity: a crashed claimant can reacquire it, and acknowledgment commits the runnable
continuation state in the same transaction.

Transient provider progress uses a bounded, nonblocking sink. Durable tool results and model output
remain available independently of whether a viewer consumed progress.

## Explicit context compaction

`Catalog::create_context_job` admits a summarization Run and its dedicated branch atomically. The
job fixes an original-history ancestor, checkpoint revision and continuation instruction/memory
snapshot. Its model launch uses the normal durable request, output, cancellation and recovery paths;
`context_job::configure_compaction_start` supplies a one-generation policy and a tool-free provider
binding. Historical source items are quoted with their identities and roles as external data under
summarizer instructions, rather than replayed as live user instructions or tool calls.

The source branch remains usable while the job runs. `publish_context_job` accepts only that Run's
single successful, complete textual generation and rechecks the source ancestor and checkpoint
revision. Publishing preserves both original history and newly appended tail items. A failed,
cancelled, incomplete or stale candidate does not replace the active checkpoint. Job branches reject
additional input; list/inspect APIs retain the original admission and make pending work discoverable
after restart. This is explicitly requested compaction, not an automatic token-budget trigger or a
complete migration of the existing Pi memory workflow.

## Remaining integration

The native provider adapters and control boundary are foundations for the full cutover, not evidence
of provider/platform parity. Production configuration/credential routing, all existing tools and
MCP/extension capabilities, automatic context/compaction and memory workflow, running-input queues, UI projections, import and
single-writer ownership transfer remain tracked in
[`docs/plan/native-agent-runtime-implementation.md`](../../../docs/plan/native-agent-runtime-implementation.md).
That matrix owns actual validation and incomplete capabilities. No measured speedup or platform
acceptance follows from this implementation alone.
