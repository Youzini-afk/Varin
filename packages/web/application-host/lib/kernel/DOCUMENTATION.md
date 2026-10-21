# Host adapters for the Rust kernel and Agent runtime

This directory binds product owners to the private Rust component. It does not contain a second
Catalog, file store, execution scheduler or recovery journal. `application-host/index.ts` creates one
KernelClient and injects existing Documents, extension, model, knowledge, research and Computer owners.

Read [architecture](../../../../../docs/architecture.md), [Agent runtime](../../../../../docs/runtime.md)
and [resource contracts](../../../../../docs/resources.md) for cross-cutting behavior. This document maps
those responsibilities to Host entry points.

## Transport and authority

`kernel-client.ts`, `kernel-launch.ts` and the wire helpers start the real executable, verify packaged
manifest/build/protocol/architecture, bootstrap the local authenticated epoch and carry separate control
and content streams. `protocol.generated.ts` comes from `kernel/protocol/schema.json`; do not hand-edit it.

`../model-text/service.ts` runs auxiliary text work through native inference and its original receipts.
Execution-owner equality compares fields, independent of JSON property order. Standalone text and
knowledge jobs use their own native Run as request context, without a conversation branch/workspace.
`thread-titles.ts` selects the configured auxiliary model, then replaces only the original input title.
Startup and kernel-ready discovery reuse completed results or resume linked admissions that never
reached inference. Sent/uncertain requests require an explicit retry; manual titles remain authoritative.
Metadata revision races reuse the generated result while rechecking the current title before publication.

Actor-scoped handles bind Host, epoch, Thread/Run, workspace and capability scope. Global management
is limited to its management operations and cannot silently substitute for an actor grant. Storage resolves
authority from the original branch/pin/record/operation/object owner. A supplied hash is not blob access.

Large bodies use sequenced acknowledged streams. Control responses stay metadata-only where specified.
Encoding/decoding and body work run outside the short control owner. `close()` drains admitted work and
waits for native exit. Protocol mismatch, revoked grants, malformed replies and executable loss are explicit
failures, with no old-backend fallback. Cancelling observation does not reverse a committed domain effect.

`getBlob` keeps its caller pending through the original native read receipt, so a transfer's `finally`
cannot interpret AbortSignal as drained hashing/reading. Native transient references and leases survive
until worker exit independently of a rejected transport Promise.

## Source and file adapters

| Entry | Responsibility |
| --- | --- |
| `storage-adapter.ts` | Scoped immutable branches, pins, objects and typed working records |
| `file-resource-backend.ts` | Documents/Recovery physical leases and conditional file operations |
| `kernel-recovery-store.ts` | Original checkpoint, mutation and recovery journal adapters |
| `thread-sources.ts` | Explicit source owner/content/mode selection and original preparation receipts |
| `source-launch.ts`, `live-source.ts` | Current physical source admission and exact materialized/live identity |
| `thread-resource-scope.ts`, `thread-context.ts` | Frozen resource and personalization candidates |
| `resource-owner.ts` | Original invocation/checkpoint-scoped instruction/skill reads |
| `managed-source-bridge.ts`, `managed-source-consumers.ts` | Target Source authority and source-specific domain dispatch |

A saved Documents registration identifies a configuration namespace. Fixed-source admission can use it
without reopening the old live directory, but current trust and original immutable grant still apply.
Live operations and materialized execution perform their separate physical checks. Main and child
preparation retain capture coverage and exact configuration dependencies; no later read repairs old
fixed provenance by consulting current disk.

Source preparation reads its durable branch receipt before recapture. Concurrent observers may share
preparation; the last cancelled observer drains the original capture before its call settles. Source
replacement prepares context before publishing the new input/Run/source transaction. A failed or stale
candidate leaves the active source/checkpoint intact.

`resource_read` sees the actual ContextCheckpoint attached to the ModelStep/Policy invocation. Captured
bodies need no source reopening. An uncaptured immutable dependency reopens only its original branch
with a narrow reader grant/pin; capture-only sources require explicit refresh. User `/skill:` activation
stores captured material with the original input, keeps raw text unchanged and uses the same queue CAS.
A read selecting old activation still checks its original ancestry and current trust.

## Native Thread admission and product views

`history-run-navigation.ts` builds the chat rail's metadata-only Run index from native history references,
validating the selected branch/cut even when its immutable prefix is cached. It excludes rewound history;
body pagination and virtual rows never supply Run ordinals. Preview bodies are read only on demand.

`agent-runtime-client.ts` is the typed Catalog client. `thread-adapter.ts`, `thread-routes.ts` and related
Thread adapters validate authenticated product requests, prepare actual owners and project results. Rust
owns admission and original command receipts, not an in-memory Host request queue.

- Submit/enqueue retries query their original receipt before preparing another source/model/resource.
- Family reads bind the trusted caller and derive allowed ancestry in Catalog. Opening a view does not
  send a message, create a wait or resume a child. Original content reads retain Run identity.
- Messages distinguish inform/request/reply, accepted input, history delivery and activation. An unknown
  send retains its exact body, target and key for retry. A passive message is not an implicit request.
- `continueLaunch` consumes the existing durable readiness events and startup discovery. It does not
  create a second launch ledger or resume policy Pause/question states because a UI was reopened.
- `runtime.observations.reconcile` consumes original child/process/reply observations. Native realtime
  deadlines and durable waits stay in Catalog; the Host adds no periodic model polling.
- Agent content collection uses the original Catalog/ContentStore maintenance worker. Its partial,
  deferred, cancelled and failed outcomes are distinct; it is not workspace Storage GC.
  `content-maintenance.ts` coalesces Thread deletion requests, rediscovers tombstones at startup,
  retries busy content readers, and follows durable events until original deleted work settles.
  Catalog retires the deleted Thread's owned metadata while preserving surviving shared references;
  the existing content collector releases the resulting unreachable bodies.

UI projections retain exact identities and revisions and discard stale asynchronous results. The same
Host routes serve native product views; a renderer cannot supply prepared snapshots, trusted actors or
operation owner records.

`child-profiles.ts` composes the frozen implementation/verification/retrieval choices. `thread-adapter.ts`
pages the native current/history directory before hydrating selected reports; UI state does not retire tasks.
`child-source-store.ts` captures the selected concrete worktree and carries a reused Agent's changes over
that fixed stage. Managed preparation uses the same original target handoff and restricted preparation grant.

`context-agent.ts` prepares the automatic context-organization profile from the existing trusted settings
snapshot. Both manual and automatic ContextJob admission use it; an unset model retains the conversation
binding, and parameter overrides use the existing model owner. Native `runtime.context_job.definition`
supplies the editor's actual prompt parts and tools. ContextJob freezes the selected instructions and model;
recovery reads the admitted job before consulting current profile settings. Agent profile management exposes
this automatic role alongside delegated profiles, while dispatch retains its own preset directory.
`code-exchange.ts` and `managed-code-exchange.ts` compose selected snapshots with the existing Integration,
Documents and recovery owners. Native journal reconciliation publishes passive Agent notices under the original
operation identity. See [collaboration](../../../../../docs/collaboration.md) for the product contract and prompts.

## Model, tool and extension bridges

Model and credential selection uses the native [Host model service](../models/DOCUMENTATION.md). Runtime provider adapters freeze the
selected request contract; Host credentials are retained privately, not stored in snapshots. Purpose-
specific retrieval and memory inference share actual Catalog admission/receipts. Provider details belong to [providers](../../../../../kernel/crates/varin-runtime/src/providers/README.md).

`tool-invocation.ts`, `tool-bridge.ts`, `extension-tool-owner.ts`, `nested-tool-owner.ts` and the domain
owners validate the original Run, ToolOrigin, operation/call, schema, binding and execution owner.
Extension input schemas are checked once at authorization; execution reuses the parsed input after checking
the original call identity, current permission and binding availability. Read-only callback/schema failures
settle as failed reads. Domain mutation receipts retain their actual effect and executor-stop evidence.
The model's tool name or claimed source is not authority. Nested scripts invoke the same ordinary tools
through retained parent permission; they cannot upgrade read-only or borrowed authority by changing labels.

Context transforms and budgets are selected extension capabilities. Their candidates remain ordered,
versioned and separate from the immutable request already sent. Runtime contract discovery exposes the
actual selected registry metadata, not guessed support from an extension manifest alone.

MCP uses the shared [Host authority](../mcp/DOCUMENTATION.md). Configuration identity and
live owner generation differ: re-enabling an equal configuration creates a fresh binding, while revoked
old exchanges stay revoked. Managed MCP source stop starts the exact target stop before joining its
pending observer acknowledgement. Original stop/receipt/resource cleanup remains necessary; cancelling
HTTP cannot prove remote execution stopped.

## Existing domain consumers

| Domain | Key adapters | Original authority |
| --- | --- | --- |
| Explicit notes and prompt edits | `memory-owner.ts`, `thread-context.ts` | Host personalization / Rust typed record |
| Bot memory and background inference | `bot-memory-owner.ts`, `../memory/bot-history.ts`, `../memory/memory-inference.ts` | Bot binding, Catalog MemoryWork and KnowledgeStore receipts |
| Plans | `plan-owner.ts`, `plan-service.ts` | KnowledgeStore version/CAS/receipt |
| Code and language retrieval | `retrieval-source.ts`, `language-owner.ts` | Admitted Source, native compute, language owner and original inference calls |
| Web/documents/materials | `web-runtime.ts`, `document-sources.ts`, material owners | Existing Host material store and original reader grants |
| Research | `research-runtime.ts`, `research-source.ts`, `managed-research-source.ts` | ExperimentService, source Storage and actual backend |
| Computer | `computer-runtime.ts` | ComputerService assignments/input lane/target receipts |
| Scripts | `script-runtime.ts` | Existing script process/session and retained ordinary-tool dispatch |
| Calendar | `../scheduled-tasks/calendar-owner.ts` | Runtime Calendar occurrences and original launch/observation |
| Project schedules | `schedule-tool-owner.ts`, `managed-schedule-service.ts` | Source Host scheduler and Source Storage mutation receipt |
| Recovery/Integration | `managed-recovery-service.ts`, integration owners | Existing Recovery/Integration journals and conditional file authority |

Agent `todo` updates accept a complete item list without a preliminary read. The plan owner selects the
current visible version within the original branch; optional `expectedRef` preserves explicit version
comparisons. Original mutation receipts deduplicate retries. User editor saves retain their displayed version.

Settings tools obtain execution stages from the existing writer calls. Validation failures and rejected CAS
writes have no effect; applied fields and unresolved dispatched writes retain their respective outcomes.
Updates without an explicit revision rebase their requested fields after a confirmed CAS rejection, preserving
concurrent changes to other fields. This uses the existing read/merge/write path rather than model round trips.

Filename entries are navigation, not a complete API catalog. Consult the actual module and nearest
focused tests before modifying an owner; generated schemas define the concrete method shapes.

## Managed Source consumers

The coordinating Host retains the original Run/Source and target address. The target validates the
paired principal, exact retained Source, grant and domain capability. Read paths and effect paths use
the same resource identity without pretending that the target's path is local to the coordinator.
Current consumers include fixed/live source reads, language/retrieval, original processes/PTY views,
MCP, scripts/packages, research inputs, file observations, recovery and project schedules.

Managed research input capture fixes target bytes and transfers verified objects to the Experiment
input branch; it does not pick an execution machine. Original target cleanup records outlive temporary
reader handles and can be reconciled after restart without recapturing source content.

Managed process terminals attach to the original Operation/process and raw offsets. A terminal view
cannot spawn a replacement, invent an exit, release the spool or inherit unrelated old controls.
Source stop and release wait for actual input/read/callback drainage.

Managed project schedules persist a begin fence before dispatch on the asset Host. Original callback
receipts survive lost responses, source retirement and coordinator delivery cleanup. Reconciliation
uses that receipt; a started operation without one remains unknown, never automatic re-execution.
Current whole-project permission is required because schedules include project assets/user overrides.

Managed file recovery is coordinated by `recovery/managed-recovery-coordinator.ts` and each target's
`managed-recovery-service.ts`. The coordinator persists frozen participant plans before RPCs; targets
use their own existing journal, exact root/Source and current maintenance permission. There is no
coordinator-owned copy of remote file bodies and no cross-Host atomicity claim. Cancellation intent is
durable before slow observations, and original participant/command receipts decide subsequent phases.

## Follow-ups and background work

File, process/Job, time, reply, artifact/collection/log and metric conditions feed original Catalog
follow-up definitions, occurrences and ingress. Host observers hold only transient subscriptions,
coalescing signals and active reads. They subscribe before a recheck, retain accepted cursors and use
original reconciliation after restart. Pause/Cancel can stop further observation independently of a
slow source read, but cleanup still drains that original read.

A file watch is not a history of every offline/coalesced change. Log conditions read only the published
byte high-water and persist exact incremental-match progress; stored but unpublished chunks are not
input. Metric demand starts the existing shared ResourceService sampler; missing/stale/unsupported data
is not zero. Unrelated domains do not share one long cancellation/receipt flight.

Definition triggering, input binding, actual delivery and an optional Agent Wait have different lives.
Ending a wait does not cancel the watched process, retract the message or delete a follow-up definition.
User management routes never fabricate a ModelStep solely to obtain a tool-only observation owner.

## Verification

Use `bun run test:kernel` for the real Host/release-kernel suites and the Web package's focused tests
for adapters. Rust review modules exercise original native owners and deterministic bridges; a fixture
name containing “review” does not prove a real network, desktop or paid-model run. The
[development guide](../../../../../docs/development.md) explains prepared outputs and test selection.
