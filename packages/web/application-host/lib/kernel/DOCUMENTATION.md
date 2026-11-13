# Host adapters for the Rust kernel and Agent runtime

This directory binds product owners to the private Rust component. It does not contain a second
Catalog, file store, execution scheduler or recovery journal. [application-host/index.ts](../../index.ts) creates one
KernelClient and injects existing Documents, extension, model, knowledge, research and Computer owners.

Read [architecture](../../../../../docs/architecture.md), [Agent runtime](../../../../../docs/runtime.md)
and [resource contracts](../../../../../docs/resources.md) for cross-cutting behavior. This document maps
those responsibilities to Host entry points.

## Transport and authority

[kernel-client.ts](kernel-client.ts), [kernel-launch.ts](kernel-launch.ts) and the wire helpers start the real executable, verify packaged
manifest/build/protocol/architecture for installed artifacts, bootstrap the local authenticated epoch and carry separate control
and content streams. [protocol.generated.ts](protocol.generated.ts) comes from [kernel/protocol/schema.json](../../../../../kernel/protocol/schema.json); do not hand-edit it.
Production requires the executable manifest. The explicit development path may use an unmanifested
local binary or Cargo runner; that path is not installed-product verification. Wire compatibility,
Agent Catalog upgrades and resource Storage format validation are separate owner checks.

[Auxiliary model work](../model-text/service.ts) uses its own native Run and original receipt, without
inventing a conversation branch. [Thread naming](../model-text/thread-titles.ts) coordinates Catalog-owned
naming generations and frozen history cuts; settings define frequency. Startup reuses recorded results
or resumes unsent work, never an unknown dispatch. Manual naming and Catalog publication fences protect
later user intent. Credential selection stays with the [model service](../models/DOCUMENTATION.md).

Actor-scoped handles bind Host, epoch, Thread/Run, workspace and capability scope. Global management
is limited to its management operations and cannot silently substitute for an actor grant. Storage resolves
authority from the original branch/pin/record/operation/object owner. A supplied hash is not blob access.

Transport scheduling, inline frames and separate large-body credits are described by the
[kernel transport owner](../../../../../kernel/README.md#transport-lifetime). The Host queue and
codec helpers retain the same lifetime: `close()` drains admitted work and waits for native exit.
The Application Host supplies one `ShutdownDeadline`; expiry rejects without detaching undrained
work or starting another termination timeout. `beginDraining()` stops fresh execution admission,
not control reads or original effect receipts. A late receipt cannot resume Host teardown.
Protocol mismatch, revocation, malformed replies and executable loss remain explicit failures.
Cancelling an observation never reverses a committed effect. Standalone clients without a supplied
deadline continue waiting for their original physical drain.

[context-service.ts](context-service.ts) answers native execution-environment preparation from the actual Source Host.
[source-launch.ts](source-launch.ts) carries the initial trusted program inventory; request preparation refreshes the
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
| [native-workspaces.ts](native-workspaces.ts) | Logical project/branch references, current mount generation and original execution/document leases; Rust owns bytes and mounts |
| [storage-adapter.ts](storage-adapter.ts) | Scoped immutable branches, pins, objects and typed working records |
| [file-resource-backend.ts](file-resource-backend.ts) | Documents/Recovery physical leases and conditional file operations |
| [kernel-recovery-store.ts](kernel-recovery-store.ts) | Original checkpoint, mutation and recovery journal adapters |
| [thread-sources.ts](thread-sources.ts) | Explicit source owner/content/mode selection and original preparation receipts |
| [source-launch.ts](source-launch.ts), [live-source.ts](live-source.ts) | Current physical source admission and exact materialized/live identity |
| [thread-resource-scope.ts](thread-resource-scope.ts), [thread-context.ts](thread-context.ts) | Frozen resource and personalization candidates |
| [resource-owner.ts](resource-owner.ts) | Original invocation/checkpoint-scoped instruction/skill reads |
| [managed-source-bridge.ts](managed-source-bridge.ts), [managed-source-consumers.ts](managed-source-consumers.ts) | Target Source authority and source-specific domain dispatch |

[thread-source-files.ts](thread-source-files.ts) projects composer file/directory metadata from the exact admitted Thread
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

Managed code capture keeps coordinator Thread and external conversation IDs as attribution only.
Its Source authority and Storage snapshot own the capture through publication and cleanup; those IDs
do not identify local Catalog Threads and must not be used for native preparation retention.

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

[history-run-navigation.ts](history-run-navigation.ts) builds the chat rail's metadata-only Run index from native history references,
validating the selected branch/cut even when its immutable prefix is cached. It excludes rewound history;
body pagination and virtual rows never supply Run ordinals. Preview bodies are read only on demand.

[agent-runtime-client.ts](agent-runtime-client.ts) is the typed Catalog client. [thread-routes.ts](thread-routes.ts)
checks public inputs and authorizes actual read/write identifiers through [request-principal.ts](request-principal.ts)
and [ownership-resolver.ts](ownership-resolver.ts). Positive immutable mappings are batched and cached;
missing mappings fail closed. Opaque messages and quoted data are not recursively scanned for authority.
Among authenticated clients, public writes require the Host owner; foreign private work remains
inaccessible to it. Unauthenticated local mode retains its original public-work behavior.

[thread-adapter.ts](thread-adapter.ts) projects one native `thread.view` result and adds only Host-owned
policy preparation, creation defaults and recovery. The native view includes its event cursor and may
return a head-anchored history delta. The AbortSignal fences late reads and continuations, not Run execution.
`inspectMany` reads affected visible summaries without rebuilding the catalog list. Context inspection
uses [the Rust read owner](../../../../../kernel/crates/varin-runtime/src/catalog_context_inspection.rs),
which caches immutable ancestry/composition while refreshing mutable request usage.

[event-hub.ts](event-hub.ts) shares the native durable reader. Subscribers have independent cursor,
principal filtering and progress interests; lagging readers fall back to durable pagination, not dropped events.
The HTTP event writer treats a socket high-water mark as backpressure, retaining subsequent frames in a
per-observer bounded FIFO until `drain`. The already accepted frame is never replayed. An observer that
exceeds its buffer budget receives an explicit `slow-consumer` resync from its last accepted durable
cursor before closing; disconnects release the queue without affecting other observers.
An observation ID is scoped to its principal, so mutable interests cannot alter another client's subscription.
The [client bus](../../../../application-client/src/thread-observation.ts) owns reconnect and local filtering.

Admission, stable-key retries, queue/history projection and explicit user controls are described in
[THREADS.md](THREADS.md). Opening a view does not send messages, resume work or create waits.
[content-maintenance.ts](content-maintenance.ts) follows actual deleted-work settlement and retries busy
readers; original Catalog/ContentStore collection preserves surviving shared references. It is not Storage GC.
UI projections discard stale asynchronous results without retiring tasks or supplying trusted owner records.

[child-profiles.ts](child-profiles.ts) composes the frozen implementation/verification/retrieval choices. [thread-adapter.ts](thread-adapter.ts)
pages the native current/history directory before hydrating selected reports; UI state does not retire tasks.
[child-source-store.ts](child-source-store.ts) captures the selected concrete worktree and carries a reused Agent's changes over
that fixed stage. Managed preparation uses the same original target handoff and restricted preparation grant.

[context-agent.ts](context-agent.ts) prepares the automatic context-organization profile from the existing trusted settings
snapshot. Both manual and automatic ContextJob admission use it; an unset model retains the conversation
binding, and parameter overrides use the existing model owner. Native `runtime.context_job.definition`
supplies the editor's actual prompt parts and tools. ContextJob freezes the selected instructions and model;
recovery reads the admitted job before consulting current profile settings. Agent profile management exposes
this automatic role alongside delegated profiles, while dispatch retains its own preset directory.
[code-exchange.ts](code-exchange.ts) and [managed-code-exchange.ts](managed-code-exchange.ts) compose selected snapshots with the existing Integration,
Documents and recovery owners. Native journal reconciliation publishes passive Agent notices under the original
operation identity. See [collaboration](../../../../../docs/collaboration.md) for the product contract and prompts.

## Model, tool and extension bridges

Model and credential selection uses the native [Host model service](../models/DOCUMENTATION.md). Runtime provider adapters freeze the
selected request contract; Host credentials are retained privately, not stored in snapshots. Purpose-
specific retrieval and memory inference share actual Catalog admission/receipts. Provider details belong to [providers](../../../../../kernel/crates/varin-runtime/src/providers/README.md).

[tool-invocation.ts](tool-invocation.ts), [tool-bridge.ts](tool-bridge.ts), [extension-tool-owner.ts](extension-tool-owner.ts), [nested-tool-owner.ts](nested-tool-owner.ts) and the domain
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
| Explicit notes and prompt edits | [memory-owner.ts](memory-owner.ts), [thread-context.ts](thread-context.ts) | Host personalization / Rust typed record |
| Bot memory and background inference | [bot-memory-owner.ts](bot-memory-owner.ts), [../memory/bot-history.ts](../memory/bot-history.ts), [../memory/memory-inference.ts](../memory/memory-inference.ts) | Bot binding, Catalog MemoryWork and KnowledgeStore receipts |
| Plans | [plan-owner.ts](plan-owner.ts), [plan-service.ts](plan-service.ts) | KnowledgeStore version/CAS/receipt |
| Source queries and language access | [source-query-service.ts](source-query-service.ts), [source-query.ts](source-query.ts), [language-owner.ts](language-owner.ts) | Admitted Source, native compute, language owner and original inference calls |
| Web/documents/materials | [web-runtime.ts](web-runtime.ts), [document-sources.ts](document-sources.ts), material owners | Existing Host material store and original reader grants |
| Research | [research-runtime.ts](research-runtime.ts), [research-source.ts](research-source.ts), [managed-research-source.ts](managed-research-source.ts) | ExperimentService, source Storage and actual backend |
| Computer | [computer-runtime.ts](computer-runtime.ts) | ComputerService assignments/input lane/target receipts |
| Scripts | [script-runtime.ts](script-runtime.ts) | Existing script process/session and retained ordinary-tool dispatch |
| Calendar | [../scheduled-tasks/calendar-owner.ts](../scheduled-tasks/calendar-owner.ts) | Runtime Calendar occurrences and original launch/observation |
| Project schedules | [schedule-tool-owner.ts](schedule-tool-owner.ts), [managed-schedule-service.ts](managed-schedule-service.ts) | Source Host scheduler and Source Storage mutation receipt |
| Recovery/Integration | [managed-recovery-service.ts](managed-recovery-service.ts), integration owners | Existing Recovery/Integration journals and conditional file authority |

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

Managed file recovery is coordinated by [recovery/managed-recovery-coordinator.ts](../recovery/managed-recovery-coordinator.ts) and each target's
[managed-recovery-service.ts](managed-recovery-service.ts). The coordinator persists frozen participant plans before RPCs; targets
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

[thread-export.ts](thread-export.ts) walks the selected immutable history cut through the original Catalog history
reader. It validates the inclusive range before starting the response, spools only reference pages to
private temporary storage, and reads public message bodies in chronological order under stream
backpressure. JSON and Markdown share a named public-semantic projection. Provider originals,
opaque continuations, compaction/checkpoint state and unrelated outer fields are never exported.
Tool details are opt-in. Original attachments and media retain their message association and filename;
bytes come from their original authorized readers, with chunk identity and length checks. Cancellation
closes the stream and removes its temporary metadata. The renderer writes to local disk-backed browser
storage instead of collecting an entire history/attachment Blob in memory. No share link is created.

[thread-remember.ts](../memory/thread-remember.ts) resolves the actual Thread binding before exposing a save destination. Bot/user
memories use `MemoryService` and the existing KnowledgeStore CAS and atomic mutation receipt;
ordinary global/project/Thread notes use the original personalization typed record. The original save
key, content and observed revision survive a lost response. A subsequent unrelated write does not
prevent reading that original receipt. This path has no implicit inference and no command-specific
memory store. Model-assisted drafting is a separately confirmed normal User dispatch, whose original
execution report is reviewed before applying its text.

Export/remember behavior tests cover pinned reads, private-content exclusion, abort, original CAS and
unknown-write receipts. Native dispatch and installed browser/mobile download need their own evidence;
see [verification](#verification).

[thread-user-dispatch.ts](thread-user-dispatch.ts) exposes the original current Run's frozen dispatch catalog and admits a
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

[thread-quotes.ts](thread-quotes.ts) validates/copies original UTF-16 quote ranges and joins captured media/files to
existing input owners. `ThreadAdapter` parses skills and object selections on that original draft;
Rust [input_quotes.rs](../../../../../kernel/crates/varin-runtime/src/input_quotes.rs) alone expands native quote content for model requests. Stored history keeps
compact text, frozen source metadata and occurrence ranges. Provider adapters never receive the
navigation objects. User-directed messages preserve their separate recipient and `replyTo` contract.

Receipt lookup compares original selectors before reading current sources. Prepared file identities
and auto-rendered image media do not change that intent. Queue promotion uses the accepted body;
plain-text edits preserve objects while discarding obsolete ranges. Recovery exposes the original
file/image binding so restoring a file-backed image does not duplicate its visual payload. A
text-only model can receive the original image file with an explicit non-visual notice.

## Conversation organization boundary

[Organization service](../conversation-organization/service.ts) initializes from a successfully validated
Settings project read. The Host coalesces initialization once per principal; failed initialization remains
retryable. Catalog owns the durable generation, tree, placement, local CAS and original command receipts.
Settings still owns project registration/removal, so partial coordination returns its actual outcome.
No Host directory writer, per-user project copy or separate receipt database is introduced.

The principal comes from authentication, never client JSON. Reads and retries preserve public/private
scope, tombstones and original stable keys. Metadata batches use the existing native/external owners;
a deletion replay can still finish pending external cleanup. Frozen creation/dispatch metadata retains the
original project Source, even after navigation moves or Settings changes. See
[organization contract](../../../../../docs/runtime.md#会话组织的原存储边界).

[resource-owner.ts](resource-owner.ts) validates original invocation/Run identity before organization tools
reach Catalog, BotService or external services. Lifecycle operations retain their gates, principal, turn
cleanup and original receipts. Read-only labels return only requested Bot/Settings identities with explicit
missing/unavailable states; they do not create a new profile directory or file authority.
Public Bot activity discloses only authorized work handles. External HTTP checks use retained ownership,
including tombstones and pre-session parent Runs; global invalidations contain no private transcript or identities.

[Inherited-input retry](thread-adapter.ts) compares the original normalized input and reuses only retained
Host-derived Source/tool bindings. It is not a key-only admission path: changed source/model/input/credentials
still conflict. Omitted submit Source inherits; explicit null selects chat-only through the existing context owner.
Receipt lookup precedes mutable Settings/device checks, so temporary unavailability cannot erase accepted work.

### Mixed navigation pages

The authenticated route selects Catalog scope and forwards the original query without a second page cap
or sorting owner. In mixed pages, `items` determines ordered rows; attached ancestor containers are context,
not loaded children. Search project names come from one trusted Settings read and participate in cursor
validation. An unreadable Settings document is not empty search results. Ordinary initialized reads do not
load Settings or contact devices. Client loaded-window refresh and selectors belong to the
[organization store](../../../../ui/src/stores/DOCUMENTATION.md).

Organization invocation validation captures frozen call identity, reads content outside the Catalog lock,
then revalidates the live epoch. It does not relax file-resource checkpoint checks. Explicit-project dispatch
initializes registration metadata before first admission, after original receipt lookup; no project is mounted
merely to initialize navigation. A missing node in an initialized space is a conflict, not implicit recreation.

Frozen project source selection is carried in original creation/child-dispatch metadata, not navigation
nodes. `native_workspace` includes the original adoption operation and logical workspace/branch IDs;
`live_root` explicitly disables later automatic adoption selection. Missing selection retains old
receipt behavior. The target `NativeWorkspaceOwner.prepareSelection` verifies the committed adoption
against the admitted registration's original physical root, then uses the existing open/acquire owners. Managed project configuration adapters use `projectLifecycle` on that same Host owner, sharing original
mount grants, in-flight opens, document views and retained references. They do not instantiate another
filesystem owner for the same branch. Project adoptions retain their original project lifecycle;
only derived temporary snapshots use conversation preparation retention. Managed preparation checks the authenticated target's allowed
directories. The coordinating Host never registers target mount paths as local directories. Scoped
child source snapshots retain their original native scope and use the existing snapshot owner.
