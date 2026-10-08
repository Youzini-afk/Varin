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

## Immutable model request bodies

Model-step metadata holds a content reference, not a serialized full-history request. The runtime
persists content-defined request chunks and their ordered manifest under `content/objects` before
committing the reference in SQLite. SHA-256 identities and object paths are shared with kernel
content primitives; conversation objects have a separate GC domain because kernel storage can be
rebuilt independently. Dispatch, recovery and input-supersession writes preserve the small reference.
The public model-step API and completion consumer resolve and verify the exact frozen request.
Provider serialization still visits and sends full legal requests; chunk reuse is not remote
incremental-context support or a measured speedup claim.

Opening the current inline native format performs one atomic conversion of request fields, preserving
history and provider data. Durable objects precede that transaction; interruption leaves either the
old representation or committed references, never empty history. A format marker selects one current
reader. Missing or corrupt referenced objects fail explicitly. `Catalog::collect_content_objects`
marks every retained model step and verifies its objects before removing unreferenced objects; it
never deletes history or invokes the replaceable system-kernel GC. Conversation history and model
output records remain inline in this slice; request-body extraction does not claim that those other
large-body paths have already been converted.

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

## Remaining integration

The native provider adapters and control boundary are foundations for the full cutover, not evidence
of provider/platform parity. Production configuration/credential routing, all existing tools and
MCP/extension capabilities, context/compaction, running-input queues, UI projections, import and
single-writer ownership transfer remain tracked in
[`docs/plan/native-agent-runtime-implementation.md`](../../../docs/plan/native-agent-runtime-implementation.md).
That matrix owns actual validation and incomplete capabilities. No measured speedup or platform
acceptance follows from this implementation alone.
