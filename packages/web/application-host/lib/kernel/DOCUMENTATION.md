# Host adapters for the Rust kernel and Agent runtime

This directory binds product owners to the private Rust component. It does not contain a second
Catalog, file store, execution scheduler or recovery journal. `application-host/index.ts` creates one
KernelClient and injects existing Documents, extension, model, knowledge, research and Computer owners.

Read [architecture](../../../../../docs/architecture.md), [Agent runtime](../../../../../docs/runtime.md)
and [resource contracts](../../../../../docs/resources.md) for cross-cutting behavior. This document maps
those responsibilities to Host entry points.

## Transport and authority

`kernel-client.ts`, `kernel-launch.ts` and the wire helpers start the real executable, verify packaged
manifest/build/protocol/architecture for installed artifacts, bootstrap the local authenticated epoch and carry separate control
and content streams. `protocol.generated.ts` comes from `kernel/protocol/schema.json`; do not hand-edit it.
Production requires the executable manifest. The explicit development path may use an unmanifested
local binary or Cargo runner; that path is not installed-product verification. Wire compatibility,
Agent Catalog upgrades and resource Storage format validation are separate owner checks.

`../model-text/service.ts` runs auxiliary text work through native inference and its original receipts.
Execution-owner equality compares fields, independent of JSON property order. Standalone text and
knowledge jobs use their own native Run as request context, without a conversation branch/workspace.
`../model-text/thread-titles.ts` coordinates initial and periodic title checks; Catalog owns the
original naming generation, checked-turn count and frozen history cut. The default interval is five
completed user turns; zero keeps initial naming only. `../model-text/thread-title-context.ts` builds the retained
summary/recent-exchange input, and the model-text owner selects the auxiliary model. Startup and
kernel-ready discovery reuse original results or resume unsent work, never replay an unknown dispatch.
Manual naming ends automatic checks; late output must pass the original Catalog publication fence.

Actor-scoped handles bind Host, epoch, Thread/Run, workspace and capability scope. Global management
is limited to its management operations and cannot silently substitute for an actor grant. Storage resolves
authority from the original branch/pin/record/operation/object owner. A supplied hash is not blob access.

Large bodies use sequenced acknowledged streams. Control responses stay metadata-only where specified.
Encoding/decoding and body work run outside the short control owner. `close()` drains admitted work and
waits for native exit. The Application Host passes its single `ShutdownDeadline`; expiry rejects
without detaching an undrained native workspace transport or adding another termination timeout.
A late receipt cannot resume Host teardown. Standalone native-workspace clients without a supplied
deadline still wait for the original physical drain. `beginDraining()` rejects new execution and
queued execution admission, but leaves control requests and original effect receipts owned. Protocol mismatch, revoked grants, malformed replies and executable loss are explicit
failures, with no old-backend fallback. Cancelling observation does not reverse a committed domain effect.

`context-service.ts` answers native execution-environment preparation from the actual Source Host.
`source-launch.ts` carries the initial trusted program inventory; request preparation refreshes the
selection and persists it in the frozen tool context. Managed tool dispatch forwards that same snapshot
to its target owner. A changed default takes effect at the next model request, while accepted commands
retain their interpreter and process identity. No coordinator program path is used as a remote fallback.

Ordinary live sources receive device filesystem access unless the Host explicitly enables deployment
lockdown. The registered directory remains the default working directory, not a project-only file boundary.
Source-less user submissions supply the Host's default live directory as an inheritance fallback; Catalog
atomically retains any existing selected source. No project, inventory, baseline or mount is created for it.
File transactions and recovery keep relative identities inside that directory and absolute identities outside.

Conversation recovery moves the branch head and keeps the original context provenance. Prompt refresh
uses the context checkpoint's revision for publication; the personalization revision belongs to user
settings and need not change when an application update renders the same settings differently. Refresh
still preserves source/scope and memory, including when recovery leaves the branch with an empty history.
Conversation attention reads branch-owned Runs; standalone text/knowledge inference retains its own
product status and must not be decoded as a conversational Run.

Typed `ExecutionError` code/message/details survive kernel, managed-source and script transport.
Original completion state decides whether a model-facing error is projected; opaque successful tool
data is not reclassified. The Catalog stores error details with its existing completion and GC roots,
so subsequent reads retain them without a second receipt store.

`getBlob` keeps its caller pending through the original native read receipt, so a transfer's `finally`
cannot interpret AbortSignal as drained hashing/reading. Native transient references and leases survive
until worker exit independently of a rejected transport Promise.

## Source and file adapters

`native-workspaces.prepare` resolves an explicitly selected mounted project only.
Ordinary project tasks keep their physical source and do not require a mount driver.
Concurrent requests to enable the optional backend share one preparation; subsequent
Threads reuse that selected workspace. A driver-free default isolation backend is
not yet implemented.
Native adoption streams immutable file objects directly and validates native identity,
change time, attributes and directory changes without a second full body read/tree walk.

| Entry | Responsibility |
| --- | --- |
| `native-workspaces.ts` | Logical project/branch references, current mount generation and original execution/document leases; Rust owns bytes and mounts |
| `storage-adapter.ts` | Scoped immutable branches, pins, objects and typed working records |
| `file-resource-backend.ts` | Documents/Recovery physical leases and conditional file operations |
| `kernel-recovery-store.ts` | Original checkpoint, mutation and recovery journal adapters |
| `thread-sources.ts` | Explicit source owner/content/mode selection and original preparation receipts |
| `source-launch.ts`, `live-source.ts` | Current physical source admission and exact materialized/live identity |
| `thread-resource-scope.ts`, `thread-context.ts` | Frozen resource and personalization candidates |
| `resource-owner.ts` | Original invocation/checkpoint-scoped instruction/skill reads |
| `managed-source-bridge.ts`, `managed-source-consumers.ts` | Target Source authority and source-specific domain dispatch |

`thread-source-files.ts` projects composer file/directory metadata from the exact admitted Thread
Source. Fixed sources stay on their original branch revision; live/native/materialized sources retain
their original physical view. Pending drafts use Documents resolution and native metadata listing,
without creating a Thread or opening file bodies. Managed queries execute at the selected target,
through its existing read authority and source-service lifetime. Candidate pages retain only the
requested result budget plus one continuation item; the native traversal completes so an incomplete
read cannot be mistaken for pagination. Continuations bind Source/view, query and type. Skills have
an independent resource discovery path and failures are not combined with file candidates.

A saved Documents registration identifies a configuration namespace. Fixed-source admission can use it
without reopening the old live directory, but current trust and original immutable grant still apply.
Live operations and materialized execution perform their separate physical checks. Main and child
preparation retain capture coverage and exact configuration dependencies; no later read repairs old
fixed provenance by consulting current disk.

`file.read.check` verifies the original Run grant, regular-file identity and canonical path only.
Documents owns the subsequent queued read lease. The identity fences do not contest another legitimate
Documents reader's lease; actual reads and writes continue to enforce the original native lease boundary.

Source preparation reads its durable branch receipt before recapture. Concurrent observers may share
preparation; the last cancelled observer drains the original capture before its call settles. Source
replacement prepares context before publishing the new input/Run/source transaction. A failed or stale
candidate leaves the active source/checkpoint intact.

Pinned-source branch creation calls native `branch.fork`, preserving the exact pin and source
provenance. Preparation grants admit only their original child target and handed-off source/pin;
refreshed continuation forks only its owned merged revision. The Host does not select a later root
or build a second namespace. `KernelScopedClient` exposes path observations, conditional path updates
and atomic subtree rename for the same authority. Existing large bulk integration writes keep their
streamed transaction path; the new per-path calls do not impose a smaller bulk payload limit.

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

Thread snapshot reads retain the caller's AbortSignal through Catalog, history hydration, context policy,
child metadata and recovery reads. Switching conversations or closing the HTTP observer cancels those
reads and their queued continuations; it does not issue Run or child cancellation commands.

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
If a continuation's preparation scope outlives an admitted extension owner, the same attempt restores
the saved exact bindings before starting. It does not substitute current routing, restore revoked grants,
or replay accepted tool calls; unavailable original implementations remain preparation failures.

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
| Source queries and language access | `source-query-service.ts`, `source-query.ts`, `language-owner.ts` | Admitted Source, native compute, language owner and original inference calls |
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

## Composer workflows

`thread-export.ts` walks the selected immutable history cut through the original Catalog history
reader. It validates the inclusive range before starting the response, spools only reference pages to
private temporary storage, and reads public message bodies in chronological order under stream
backpressure. JSON and Markdown share a named public-semantic projection. Provider originals,
opaque continuations, compaction/checkpoint state and unrelated outer fields are never exported.
Tool details are opt-in. Original attachments and media retain their message association and filename;
bytes come from their original authorized readers, with chunk identity and length checks. Cancellation
closes the stream and removes its temporary metadata. The renderer writes to local disk-backed browser
storage instead of collecting an entire history/attachment Blob in memory. No share link is created.

`thread-remember.ts` resolves the actual Thread binding before exposing a save destination. Bot/user
memories use `MemoryService` and the existing KnowledgeStore CAS and atomic mutation receipt;
ordinary global/project/Thread notes use the original personalization typed record. The original save
key, content and observed revision survive a lost response. A subsequent unrelated write does not
prevent reading that original receipt. This path has no implicit inference and no command-specific
memory store. Model-assisted drafting is a separately confirmed normal User dispatch, whose original
execution report is reviewed before applying its text.

Focused export tests cover pinned pagination, inclusive range rejection, public/private boundaries,
media streaming and abort. Remember tests use the real KnowledgeStore for CAS and receipt replay.
UI workflow tests cover independently retained recipient drafts and unknown-send retries, explicit
model invocation, report review and no-model direct saves. These tests do not establish native
kernel dispatch, physical remote-source admission or installed mobile/browser download support;
those remain with their original native and product smoke suites.


`thread-user-dispatch.ts` exposes the original current Run's frozen dispatch catalog and admits a
User-authored child with explicit model/source choices, edited instructions, exact background cuts
and attachment selectors. The raw command key owns receipt replay before dynamic preparation.
Native acceptance uses the existing child/model/source owners, with no ToolOrigin or tool call ACK.
Before external dependency retention, Catalog records a domain preparation/cleanup duty. Unknown
retain ACKs, failed release and restart preserve its frozen dependency cut and original epoch; stopped
attempts never reuse released tokens. Cancellation and tree Stop cover this stage atomically, without
creating an empty child Thread. User child edges do not inherit an old parent Goal. Bot reports use
an AgentReport actor bound to the real child execution, including pre-Run failure, and remain Agent
data through the original durable message ingress. Original tool dispatch/report behavior is retained.

## Frozen quote admission

`thread-quotes.ts` validates/copies original UTF-16 quote ranges and joins captured media/files to
existing input owners. `ThreadAdapter` parses skills and object selections on that original draft;
Rust `input_quotes.rs` alone expands native quote content for model requests. Stored history keeps
compact text, frozen source metadata and occurrence ranges. Provider adapters never receive the
navigation objects. User-directed messages preserve their separate recipient and `replyTo` contract.

Receipt lookup compares original selectors before reading current sources. Prepared file identities
and auto-rendered image media do not change that intent. Queue promotion uses the accepted body;
plain-text edits preserve objects while discarding obsolete ranges. Recovery exposes the original
file/image binding so restoring a file-backed image does not duplicate its visual payload. A
text-only model can receive the original image file with an explicit non-visual notice.
