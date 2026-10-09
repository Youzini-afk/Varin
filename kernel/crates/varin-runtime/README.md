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
Context domain format 3 owns these columns and the scoped ordinary-memory projection; unsupported older internal formats fail without a
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

Unsupported native catalog/content formats fail without converting or rebuilding stored assets.
Catalog version 3 and content format 3 select the typed-request-origin reader; older request bodies are rejected before owner-epoch or recovery writes. Missing or corrupt referenced
objects fail explicitly. `Catalog::collect_content_objects` marks requests, provider originals,
history, all model outputs (including rejected output), queued-history references, context
checkpoints, and strictly typed policy-graph node and planning-model request/output references. It verifies every live object
before sweeping and preserves unknown files; it never deletes history or invokes system-kernel GC.

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

## Policy-originated read graphs

A pinned AgentPolicy may return `ReadGraph` before any model request. Nodes have unique identities,
frozen schemas/source contexts and explicit acyclic prerequisites. Only trusted executor opt-in for
read-only Result capabilities is eligible; untrusted read-only annotations confer no permission.
`ToolOrigin` distinguishes actual ModelSteps from policy action/node origins. There are no fabricated
requests, tool exchanges or user messages.

Core derives the action identity from the durable Run decision boundary. One Run-owned Operation
stores the strictly tagged `PolicyReadGraphV1` intent and committed node receipts. Admission and the
versioned private policy checkpoint commit atomically; changed intent at the same identity conflicts.
Independent nodes share existing ResourceAdmission and can overlap. Each receipt commits before any
dependent can start. Failed prerequisites produce explicit nonexecution receipts. Grants are checked
again after resource waits; ordinary model-originated reads retain their cheaper batch path.

Restart preserves settled receipts and retries only interrupted pure reads using their retained
schema/source. Recovery works before the first ModelStep and restores later decision checkpoints.
The policy receives owned references and can request bounded `ReadResult` chunks. Selected evidence
enters `RequestModelWithEvidence` as labeled ExternalData, without synthetic provider call/result
pairing. Output references are checked against Run, action and node; no arbitrary object-hash reader
is granted. Chunk and selected-evidence hydration happen outside the Catalog mutex. New graph output
body writes and reference publication retain the Catalog lock, which also excludes content GC;
large-result publication cost remains an explicit optimization boundary, not a claimed speedup.

## Policy-originated planning models

`RequestModelJob` selects an admitted planning capability by ID and supplies pinned policy
instructions plus owned evidence references. It creates one Run-owned `PolicyModelJobV1` Operation,
never a synthetic conversation, compaction Run, ModelStep, or read-only tool. The existing
ModelProvider adapters, credential owners, content store and UsageReceipt remain authoritative.
Provider construction is shared with ordinary chat; no implicit main-model fallback exists.

Admission freezes the current committed context as quoted source data, the exact model/config/account
binding, instructions, evidence, serialized request and private policy checkpoint atomically. Typed
request origin distinguishes conversation requests from policy model work. Graph and model actions
share a decision boundary and latest-action recovery selection. Provider I/O runs on the existing
Run worker, outside the Catalog/control lock, so a stalled planner does not occupy other Runs.

The Operation records prepared versus durable dispatch intent and owns original output, opaque items,
usage and a terminal receipt. A never-dispatched prepared request may resume only with the exact
binding and request. Once dispatch intent is durable, a crash or cancellation without completion
produces an interrupted/indeterminate receipt, never automatic paid replay or assumed zero usage.
Completed-item, usage and terminal boundaries persist observed output; token deltas are transient
until such a boundary. A crash can lose uncommitted deltas. This avoids per-token durable writes;
large completed-item publication remains a content/Catalog optimization boundary.

Tool calls returned by the tool-free provider are retained but never executed and make the plan
unusable. A successful textual plan is exposed through a Run/action-owned reference and bounded
`ReadResult` chunks. Main-model injection labels it as untrusted model-derived evidence. Provider
opaque originals are retained separately and never enter that evidence path. Body creation and
reference publication use the same Catalog exclusion as content GC. Both operation cancellation and
model-generation interruption address the same registered cancellation child.

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

## Explicit source identity and launch format

Launch domain 2 replaces the old source `materialized` boolean with `fixed_branch`, `materialized`,
and `live_root`. Fixed sources require a branch/revision; only materialized copies carry an originating
Run. A live source instead requires its Host/canonical-root/Rust-root identity and cannot claim a fixed
revision. Exact source comparison covers rebinding and inherited launches; live identity is not a grant.

This intentionally breaks the earlier experimental launch encoding without changing catalog/content
format 3. An existing database is opened read-only first, including its committed WAL, and launch
metadata/table shape is validated before a writable connection, epoch update or recovery. Domain 1,
missing and malformed metadata fail preserving assets; no conversion or fallback reader is provided.
The launch preflight checks the real table, columns and runs foreign key including referential actions.
Persisted source `live_root` is explicitly null for fixed/materialized modes; omitting it is invalid.


## Ordinary memory request delivery

The `agent.personalization` typed record remains the sole note mutation owner. The runtime's
`catalog_memory` stores only scoped observed state, known-note identities and request delivery
proofs. Context checkpoints separately retain their immutable memory snapshot, explicit profile
identity and admitted role/project/thread. `ContextPreparation` synchronizes the trusted owner on
the Run worker before freezing a new main or policy-planning request, never under the Catalog lock.
Prepared requests are immutable. Notes newer than the checkpoint are EnvironmentFact tails in the
frozen request, not raw-history rows; they remain in later requests until compaction covers them.

Only the original confirmed native-memory Operation can authenticate a tool's receipt for tail
deduplication. Arbitrary external tool JSON is data. The existing deliveries table uses actual
memory.fact event cursors and records selected, sent and completed-request inclusion independently.
A failed request does not acknowledge facts. Planning requests use their own real operation/request
identity; their quoted source facts do not become instructions or fake ModelSteps.

A successful explicit compaction atomically publishes its fixed candidate personalization together
with the summary and system text. New notes do not advance the checkpoint CAS; explicit profile
changes do. Context domain 3 is verified read-only before writable SQLite open, including table,
key and revision uniqueness contracts. Older or malformed formats are preserved and rejected.
