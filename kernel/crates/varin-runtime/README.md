# Agent runtime

This crate owns conversation history and execution facts. The existing Pi product route has
not been cut over. The kernel's explicit `runtime.*` management methods use this authority without
writing Pi session files or the Host harness's existing execution records.

## Implemented boundaries

- `Catalog` locks one `conversation.sqlite` owner and uses SQLite WAL/FULL short transactions.
  Unsupported formats are errors; this user-history database is never recreated as a cache.
  New catalogs install all domains and the initial owner epoch in one transaction; an interrupted
  installation cannot publish a partial internal format.
- Input admission, branch ownership, operations, model request snapshots, waits/resumptions and
  delivery identities survive reopening. Events commit with the corresponding facts.
- Launch records retain model/source/policy ownership and immutable content references. Tool schemas,
  MCP descriptions and planning capabilities are prepared and hydrated outside Catalog. Queue/source
  inheritance copies retained references; model switches and permission checks touch only metadata.
  Tool/request admission compares the prepared content identity and generation at commit. Full launch
  inspection/list serialization runs on workers, and content collection retains every launch reference.
  Policy preparation binds the actual admitted baseline supplied by its assembly owner; the runtime
  does not hard-code a kernel policy wrapper's name.
- `execution` drives a bound model provider and tool executor on a worker. Tool results have stable
  request/call/operation identities, real effect receipts and provider-specific original items.
  The default policy is replaceable; it does not own or mutate the catalog itself.
- `catalog_execution` commits model output, immutable conversation items and unresolved call identities
  together. A frozen request cannot publish against a changed history head.
- User answers prepare content outside Catalog and commit its identity with the original question,
  branch, wait and owner guards. Equal retries deliver once; conflicting answers and late cancelled
  work fail. Waiting/cancellation lookup selects the actual Run's questions instead of decoding all
  operations. Wait teardown is coordinated per Run outside the global worker/control locks.
- `composition` prepares and publishes revision-checked bindings. Retired model pins preserve the
  actual schema/implementation; explicit revocation still rejects execution.
- The kernel's control worker is independent of its Storage queue. The Host client has separate
  request credits. Commands are currently Host-management-only, not delegated tools.
- `composition::tools` assembles tool declarations into one schema/endpoint directory. A ModelStep
  pins its selected endpoints through tool settlement. Each call binds one invocation through
  preparation, resource admission, authorization and execution; revocation cancellation is registered
  at binding. Ordinary replacement preserves old pins. The frozen batch schema is shared by `Arc`.
  Ready directory candidates do not retire the active plan; unchanged endpoints reuse their binding.
  The private Host tool bridge retains concrete MCP/ordinary-extension generations and scope holders. Retired generations drain
  their calls; a waiting Run retains its active owner. Cancellation wakes the call and settles from
  the actual Host receipt. Rechecking an approved action does not open another permission wait.
  Active MCP scopes subscribe to configuration and leased-schema changes. A ready replacement
  becomes active at a closed ModelStep boundary; failed or superseded preparation leaves the
  current directory selected. The activation records an immutable composition reference, retained
  by content collection and checked on recovery. Explicit dependency revocation also ends its
  outstanding authorization wait without requiring a user answer.
  Ordinary installed tool declarations retain their description, input/output schema and service
  metadata in that same directory. Contributions prepare independently; one Run composition owner
  merges ready MCP and extension bindings before a closed-boundary publication. Exact artifact and
  declaration identities survive reopening; an unavailable original implementation fails explicitly.
- `providers::registry` selects typed model adapters through the same composition leases. Factories
  run outside the registry lock; replacement preserves retained implementations and explicit revocation
  cancels active generation. Builtin protocol options are validated by family. The `pi-messages` HTTP
  adapter preserves signed blocks and tool pairing without executing a Pi agent loop. Production model
  bindings share the immutable default outbound connection pool and I/O executor.
- Host model admission retains actual context capacity, thinking mappings and configured sampling
  parameters. Unknown capacity remains unknown. Desired model choices prepare independently and activate
  at the next closed ModelStep boundary; each request retains its actual provider, tool bindings and
  credential owner. Failed choices cannot fall back to a previously active model. Accepted queued Runs
  retain their configuration; later queue admissions inherit the selected target.
- Context compilation walks anchored immutable history on a read worker. Repeated summary jobs freeze
  the previously published checkpoint and summarize its continuation instead of repeatedly loading the
  entire ancestor. A manual earlier boundary can select the original history. Personalization refresh
  stages unchanged/new candidates outside Catalog, preserves the admitted memory snapshot, and publishes
  against the captured active checkpoint. Failed, cancelled or stale candidates leave that checkpoint intact.
- Automatic capacity preparation consumes existing user/trusted-project settings and the actual selected
  model capacity. Local estimates include serialized tools and text; unknown media costs remain unknown.
  A summary is an independent, tool-free Run with its own credential owner. Background preparation leaves
  sendable requests running; a blocking request parks on a durable context Wait before model dispatch.
  Publication or definitive summary failure resumes only that parked owner after worker quiescence.
  Restart publishes retained completed output without another model request; interrupted dispatch stays
  unresolved. Oversized text is partitioned into immutable, UTF-8 aligned excerpts retaining original
  identities and ranges; media remains typed media. Sequential tool-free ModelSteps carry the previous
  summary and publish only after every part completes. Partition budgets are local estimates, not a
  guarantee of provider tokenization. Provider capacity-error recovery and replaceable budget strategies
  remain to be implemented.

The wire source remains `kernel/protocol/schema.json`; it generates the state enums and the
Host request/response DTOs. Domain implementation types remain private to Rust.

## Instruction and skill checkpoint binding

`catalog_resources` retains the Host-selected `ContextResources` snapshot inside the ordinary immutable
ContextCheckpoint object. Captured text has no second database or untracked content root. Catalog only
captures short references and publishes prepared metadata; validation, prompt/body serialization and
hydration run outside the owner. Model requests and policy nodes bind a `resource_checkpoint_id` alongside
their existing context identity. Reading requires the actual Run/origin/call and selected checkpoint.

Resource refresh is a separate compare-and-swap boundary. It preserves summary/history anchor, ordinary
memory snapshot, personalization identity and composition while replacing resource sections/provenance.
An explicit input source change prepares its new resource context and commits both in the original input
transaction. Repeated accepted input keys return the original receipt without validating a newer candidate. The Host
uses the same command/launch contract through read-only `runtime.input.receipt` before preparing new
resources; it does not keep a second input deduplication map. Source replacement includes the checkpoint
from which Host preparation started, so a refresh during that work cannot be silently overwritten.
Fork and compaction retain the original resources; source provenance is not an inherited execution grant.
The Host remains the only parser/selection owner. The kernel builtin uses its private resource channel,
normal read-only tool lifecycle and cancellation/epoch fences; it does not expose arbitrary source selection.

Explicit `/skill:name args` is input material, not a fabricated model/tool exchange. The Host selects
the published descriptor (including skills hidden from automatic model metadata), parses its captured
body, and prepares an adjunct alongside the untouched text and media. Submit, enqueue and edit stage
that material in the existing input ContentStore object and publish through their original transaction
and revision fences. An initial/replaced source uses its same prepared context; existing-context input
uses the exact checkpoint the Host read. Accepted submit/enqueue keys return their original receipt
before interpreting a later resource candidate. Media-only edits retain the original selection; any raw
text change selects anew, or removes the material when changed to ordinary text.

Canonical history projects an independently labelled `ExternalData` item before the original
`UserInstruction` parts. Its typed activation derives from the real input ID, content revision and
ordinal. ModelStep and policy-node contexts retain only activations actually present in their compiled
history. `resource_read` schema 2 accepts an optional activation selector for skill/support-file reads;
Catalog verifies the original call, retained binding, real input ancestry and exact resource version
before opening that checkpoint. Omitting the selector explicitly reads the invocation's current catalog;
the material label tells callers to use its activation for its original supporting files. Refresh never
silently substitutes newer files for a selected activation. Compaction
recipes/checkpoints retain small typed source references without reinserting the full skill body;
fork/recovery derives them from inherited input history. Accepted bodies remain historical material
after trust changes, while a new resource read still requires current authorization. No activation
registry, duplicate queue, JSONL mirror or execution grant is created.

## Run activity scope

Each Run pins the context checkpoint present in its admission transaction, including queued
NextRun admission. The reference records provenance; it does not stop ordinary execution context
refreshes. An absent admission checkpoint stays unscoped even if its branch later gains context.
Immutable checkpoint publication indexes project, mode, role and session scope beside the content
reference. Observer discovery, plan authorization and memory-tool scope checks need no prompt-body
hydration or mutable branch lookup. Body reads verify these derived facts against the referenced value.
Context domain format 4 owns these columns and referenced ordinary-memory projections; unsupported older internal formats fail without a
scope migration or inferred historical binding.

Host subscriptions select independently for each admitted Thread/project scope. Their stable
identity includes service, selected provider, Thread and the exact nullable project (`null` means
no project). Admission requires the project owner’s canonical, non-empty IDs; blank or padded
project IDs fail explicitly instead of being trimmed or treated as no project.
The read and delivery authorities enforce the same scope, reuse original event
cursors and delivery records, and apply the Host's processed `throughCursor` fence. A new branch
or context cannot revoke or relabel another Run's historical activity.

## Same-task conversation reads

`catalog::family` derives root/parent/sibling/descendant membership from the original ChildTask/Thread
relations, shared with task-family scheduling. Ordinary `threads` and `read_thread` calls bind the actual
frozen ModelStep or PolicyAction/node. Listing and reading grant no target execution, source, private
policy-state or cancellation authority, and never prepare the target's model or working directory.
Only capabilities selected in the original child directory are callable after recovery.

History rows now carry the actual producing/receiving `run_id`, committed with the original item and
Run. A fork retains that owner. No item-ID parsing, latest-Run inference or separate history ledger is
used. Fixed branch views include inherited same-Thread Run records and directly admitted Runs;
directory entries retain each original Run's branch. Reader capture holds only metadata and the
existing ContentStore publication protection. Relationship traversal, ancestry, body IO, decoding,
search, serialization and the ordinary `runtime.history.page` traversal run on read workers.

Recent/range/search pages retain original IDs, provenance and actual tool call/result association.
Ranges are exclusive, output chronological, and literal search matches decoded text and paths.
Search scan budgets return a cursor even when the current page has no matches. Signed anchors/cursors
bind caller, target, branch, Run, query and owner epoch: append/fork/rollback cannot retarget an
existing view; reopening requires a new anchor. Original-item reads page semantic conversation JSON,
with exact byte offsets and explicit truncation. A byte budget too small for the next UTF-8 code point
fails explicitly instead of exceeding the requested budget or returning a non-progressing cursor. ProviderOriginal and typed opaque continuation stay in
the original store and are excluded from these shared reads and search; tool/user JSON remains data.

Reply waits and sharing undelivered policy/auxiliary outputs remain separate implementation work.
Directed messages and terminal-child continuation are described below. These readers neither synthesize those records nor revive a
completed child launch. See [the family read evidence](../../../docs/reviews/runtime-family-reads-2026-10-11.md).

## Task-family messages and request activation

Ordinary `send` version 2 accepts `kind: inform` or `kind: request`, an explicit target Thread/branch or a received
`replyTo`, and text. ModelStep and PolicyAction/node use the same frozen declaration, original call
and ordinary effectful Operation. The original message ID and confirmed tool completion are committed
with the message, so recovery does not resend. A reply reverses the original peer/branch; a supplied
target must match. Membership comes from the original task lineage, never a shared directory.

The existing input queue holds typed origin and activation plus one delivery state. A pending inform
has no receiving Run. Its original text and command intent live in ContentStore, staged outside the
Catalog mutex and protected through commit and GC. No inbox mirror or second scheduler is introduced.
Messages remain immutable: ordinary user-input list/inspect/edit/cancel project only UserIngress.
User messages retain User provenance even when sent from a child UI; tool messages retain AgentMessage
provenance and the real sending Run/Operation. The canonical envelope preserves message/peer/reply
identity in both live and recovered history.

Passive delivery at a legal existing boundary adds history without producing an activating InputDelivered
policy event, discarding a decision, superseding a failed ModelStep, changing Goal authorization or
blocking a normal final completion. Waiting and idle work is not woken. Cancellation rejects stale
prepared delivery but keeps accepted information for a later independently admitted Run on that branch.
An existing authorized followup is not blocked merely by an inform. Delivered history records its
actual receiving Run; this does not claim that a model handled the message.

`runtime.messages.send` is the trusted User ingress; list/get provide original incoming/outgoing
metadata and one original body. List cursors fix the identity, direction and upper acceptance cursor.
Body reads and list traversal run on workers with owner-epoch checks. Public reads cannot manufacture
Agent sender identity or execution authority. `send(wait)` is still rejected before effects by this
version's strict schema. Original inform behavior has [separate evidence](../../../docs/reviews/runtime-passive-messages-2026-10-11.md).

A request carries a short tagged activation fact in the same ingress row. Acceptance binds an active
receiver Run in that transaction; idle work stays pending. The existing event-driven continuation worker
captures queue/Run/launch/head/context facts, stages content and planning bindings outside Catalog,
and publishes a new root Run or delegated execution under the original CAS. Intervening User admission
atomically claims pending requests; no Host preflight can create a second branch writer. Root launches
retain the actual predecessor selection and ordinary hot-configuration owners. Child `message_request`
uses the same source, context, report and WorkingResult owner as User continuation, with the original
Message history rather than rewritten User input or implicit skill activation.

Message views distinguish passive, pending, bound, cancelled and failed activation from history delivery.
Hold reasons are projections of the real Run/Goal/source owner, not a second execution state machine.
Manual policy pause, unanswered questions and Goal pause/budget remain effective. A new request may end
all live child/process observations in its receiver Run; each original cancelled observation is delivered
before that Run becomes runnable, without cancelling the observed child or process. Cancelling a Run
or tree fences accepted unconsumed requests, including pending work before a Run exists. Original message
identity/body remain readable; same-key retries cannot launch again. A later genuinely new intent remains
independent. Preparation failures stay visible rather than retrying on every event.

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
without large body writes inside their transactions. The queue stores only ownership/status metadata;
inspection hydrates a separately captured reference on a worker. Boundary delivery hydrates its selected
inputs first, then checks their actual revisions and the execution boundary. Edits/cancels invalidate
that material; a newly appended input does not invalidate an unchanged selected prefix.

First-input, child-context and summary-input bodies use the same required preparation/commit path.
Initial prompt and memory bodies are staged off Catalog; admission atomically freezes their metadata,
scope and references with the input and launch. Command intents are immutable content references,
so edited input never replaces its original idempotency identity. Host input offers reserve conflicting
arrival order before body encoding/upload/hydration; unrelated branches bypass them. Cancellation
wakes/removes the existing resource reservation. Full input validation and public body hydration run
on request workers rather than the Agent actor. Test-only fixture drivers exercise these same APIs.
Conversation forks capture the source head, context and memory references, then validate ancestry/tool
pairing and stage their new prompt on a worker. The commit uses that frozen cut even if the source
appends history or publishes a later context. Branch creation participates in the same ingress ordering;
retries preserve the original fork, and a previous owner cannot publish a late candidate.

Unsupported catalog/content formats fail without converting or rebuilding stored assets.
Catalog version 30, input domain 4 and collaboration domain 5 store input intents/queue bodies and context-job ownership,
source-part and immutable recipe references separately from model
configuration; content format 3 retains typed request origins. Older internal formats are rejected before owner-epoch or recovery writes. Missing or corrupt referenced
objects fail explicitly. The owned content collection worker marks requests, provider originals,
history, all model outputs (including rejected output), original command intents, queued-history references, context
checkpoints, memory projections, summary recipes and source parts, policy action/checkpoint bodies,
and indexed graph calls/receipts, Goal objective/reason/creation-intent references, planning-model request/output references, ordinary tool arguments/results,
external executor receipts and permission call/scope bodies, including historical receipt and completed
permission audit events and original invocation completions. It verifies each distinct live object
before sweeping and preserves unknown files; it never deletes history or invokes system-kernel GC.

Child task records retain ownership/state and references to task text, configuration and launch
descriptions. Admission prepares those bodies and verifies the original dispatch arguments on a worker;
commit rechecks the admitted Operation revision and current parent authority. Family, cancellation and
resource-release queries use metadata. Public child views and report pages hydrate on request workers.
Completed report selection and Wait previews also run on workers. Their commits recheck the original
Run, Wait, branch head and cancellation; changed candidates cannot append stale report messages.
Previously delivered reports are found through branch ancestry without rereading their body.

Ordinary tool calls and Operations retain frozen argument references. Admission compares their
prepared identities; dispatch, settlement and cancellation use metadata. Recovery and public Operation
views load arguments on workers. Permission preparation also stages the exact call and scope outside
Catalog; approval and consumption compare those identities against the admitted action. Public views
restore the original call/scope shape. Plan authorization reads its frozen ModelStep or policy-node
invocation outside Catalog, then rechecks the actual caller and binding. Ordinary tool results and original external
receipt bodies use the same ContentStore. Workers persist bodies before Catalog commits their
identities, outcome/effect facts and events. Internal tagged control state cannot be confused with
arbitrary result JSON; public Operation/event views restore the original shape on read workers.
Tool-batch replay and memory trust checks use the original receipt/content identity. Publication
leases protect staged and captured content through commit or hydration.

Process observations capture their Run, Wait, process and Operation revisions before preparing
lifecycle history on a worker. Publication rechecks those identities and the branch head. A cancelled
observation does not read the process result or terminate the process; an already visible delivery
reuses its original history. Child completion likewise stages the original receipt outside Catalog
and commits only against the same child/parent execution boundary.

Provider serialization still visits and sends full legal requests; chunk reuse is not remote
incremental-context support or a measured speedup claim.

Memory synchronization and confirmed-receipt merges capture immutable references under Catalog,
then load, validate, merge and stage bodies on the worker. Publication compares the actual state and,
for synchronization, active checkpoint identities. A changed basis causes a fresh owner read; an
unchanged owner revision regression remains an error. Late confirmed receipts may settle after Run
cancellation, without reviving the Run or overwriting a newer note. Context compilation reads trusted
receipt bodies on its read worker.

### Explicit content maintenance

`Catalog::prepare_content_collection` performs only short admission. Its owned handle runs after
Catalog is unlocked: it reads roots in one read-only transaction on the original conversation database,
ends that snapshot, verifies live content, and sweeps orphan objects and crash staging. No root mirror,
maintenance journal or second database is created. The actual `runtime.owner` file remains held until
the worker can no longer delete content, including after Catalog or Agent shutdown requests cancellation.

Publication and retained-reader registration never wait for content I/O. A sequence change invalidates
an older collection even if the new publication finishes before sweep. The ContentStore I/O gate also
protects reuse of existing orphan hashes and in-flight staging. A new publication makes sweep yield at
its next safe boundary; Catalog status and cancellation do not wait for that gate. Synchronous fixture
conveniences refuse collection overlap rather than waiting under Catalog; production callers use the
capture, worker, commit path.

The authenticated Host `runtime.content.collect` request runs a separate maintenance worker, not a
Run, Storage job or history/receipt queue entry. It returns a generated `ContentCollectionReport` with
completed, deferred, cancelled or failed status, actual phase and deletion counts. Mark failures delete
nothing; interrupted sweep reports already removed objects without pretending to roll them back.
Unknown files are preserved. There is no automatic timer, per-Run barrier or retry loop; repeated explicit
maintenance can defer while the store is in use. Actual filesystem calls still have their ordinary cost
and cancellation limits; off-lock execution is not a fixed latency or throughput guarantee.

## Execution and trust

Catalog methods do no provider, tool, extension or network I/O. A mutex around Catalog is held only
for a local commit or read. The cancellation token is independent of catalog and progress delivery;
requesting cancellation does not invent a stopped executor or erase an external effect.

A dispatched model request is interrupted on restart and is not automatically sent again. A
persisted `Prepared` request with no dispatch evidence can instead close as `NotDispatched`: the
original frozen request stays retained, without fabricated provider output, usage or input
supersession. Recovery uses the existing capture, unlocked content read and fenced publication path,
then the ordinary engine admits a new request for the same Run and real input. It does not send the
old serialized candidate through a second provider path. A changed or unavailable original launch
binding is rejected; a later explicitly activated selection takes effect only after that old candidate
has closed through its normal boundary.

The pending policy proposal and its committed private-state baseline remain separate until real
`ModelDispatched` commits. Reopen reuses an unchanged unexecuted proposal without deciding twice;
actual new input or a changed Goal invalidates it while preserving the original continuation.
Cancelling a proven-unsent request needs only metadata, even when its body cannot be read. Goal
pause survives reopen and still requires its actual resume. See
[`prepared_request_recovery.rs`](tests/prepared_request_recovery.rs) for the Engine-to-Supervisor
crash boundaries, second reopen, real dispatch exclusion and selection/cancellation behavior.

An unconfirmed external effect becomes indeterminate and requires reconciliation. Wait resumption
uses a durable identity: a crashed claimant can reacquire it, and acknowledgment commits the runnable
continuation state in the same transaction.
An original executor receipt may already be durable before tool settlement or handoff. Reconciliation
applies that same receipt to a recovered unresolved Operation instead of mistaking receipt identity
for completed settlement. Once applied, repeated receipt delivery leaves revisions and events unchanged.

Each dispatched tool records its physical `ExecutorOwner` separately from its tool name. A kernel
restart proves local Result execution ended; it does not prove an external Host callback stopped.
The trusted executor returns completion and stop evidence separately. A cancelled observer can receive
an indeterminate completion while the original callback, resource occupancy and eventual receipt remain
owned. The private bridge authenticates late evidence against the original invocation and external
execution epoch, independently of the replacement transport epoch. Receipt bodies are staged through
ContentStore before Catalog commits or acknowledges them. A later effect receipt never rewrites the
caller's original completion or revives a cancelled Run.

Transient provider progress uses a bounded, nonblocking sink. Durable tool results and model output
remain available independently of whether a viewer consumed progress.

Ordinary execution and policy commits stage immutable requests, outputs and evidence on the Run
worker outside the Catalog mutex. Memory delivery candidates, including quoted planning context,
are parsed there too; transactions authenticate their original receipts and record delivery stages.
A publication reference spans body I/O through metadata commit; collection defers without waiting
under the Catalog lock. Publication rechecks the original execution/branch conditions.

Run startup returns its control handle before history recovery. The worker traverses immutable
history and restores request/output/receipt bodies through read-only SQLite and content handles.
Publication rechecks the Run epoch/revision, branch owner/head and its own relevant event cursor;
unrelated Runs do not invalidate preparation. Queued promotion and cancellation retain their original
identities. See the [control isolation review](../../../docs/reviews/runtime-control-isolation-2026-10-09.md)
for the earlier verified boundaries. Catalog cold opening/recovery now runs on an initialization
worker; authenticated requests wait only for that owner, with their cancellation flags intact.
Explicit context-job capture and publication also stage bodies outside the Catalog lock.

## Policy-originated tool graphs

A pinned AgentPolicy may return `ToolGraph` before any model request. The public Decision contract is
`varin.agent.policy@3`; the old read-graph contract is replaced, not translated. Nodes have unique identities,
frozen schemas/source contexts and explicit acyclic prerequisites. Tool preparation, authorization,
atomic resource/capacity admission, dispatch reauthorization and settlement use the same single-call
execution path as model tools. Untrusted read-only annotations confer no permission.
`ToolOrigin` distinguishes actual ModelSteps from policy action/node origins. There are no fabricated
requests, tool exchanges or user messages.

Core derives the action identity from the durable Run decision boundary. One Run-owned Operation
stores strictly tagged ownership, an immutable definition reference and progress counts. The definition
stores the shared frozen tool directory once. Nodes, dependencies and individual receipts have indexed
rows in the same Catalog; settling a node does not parse the definition or rewrite other receipts.
Admission and the
versioned private policy checkpoint commit atomically; changed intent at the same identity conflicts.
Independent nodes share existing ResourceAdmission and can overlap, including during preparation.
Each receipt commits before any dependent can start. Failed prerequisites produce explicit
`not_dispatched` receipts. Ordinary model-originated reads retain their cheaper batch path.

Trusted opt-in read-only Result calls with read claims may remain transient. Other calls own a normal
Operation with the actual persisted `ToolOrigin`; file recovery does not infer a model request from an
operation-ID string. The Operation's immutable `call_completion` owns the original invocation receipt;
graph nodes and model exchanges consume that fact. `result` and external receipts can subsequently
describe an independent job's terminal state without replacing its original `job_accepted` completion.
Graph dependencies wait for call completion, so Job acceptance permits continuation; observing the
job's terminal result requires its explicit durable Wait.

Restart distinguishes never-dispatched admission, interrupted replayable reads, dispatched work
requiring original-executor reconciliation, and completed calls awaiting graph consumption. It never
reexecutes an uncertain mutation. Recovery works before the first ModelStep and restores later decision
checkpoints. Accepted work retains its frozen schemas/source and executor generation. Cancellation
before executor entry records nonexecution; later confirmed effects remain attributable to their
original Operation and do not revive a cancelled Run.
The policy receives owned references and can request bounded `ReadResult` chunks. Selected evidence
enters `RequestModelWithEvidence` as labeled untrusted policy-tool data, without synthetic provider
call/result pairing. Memory evidence is authenticated against the original memory Operation and
canonical result identity. Facts carried by that evidence replace only their duplicate memory-tail
items in the candidate request; selected/sent/committed delivery remains in the existing memory owner.
Output references are checked against Run, action and node; no arbitrary object-hash reader
is granted. Chunk/evidence reads and new graph output writes happen outside the Catalog mutex.
The publication reference protects uncommitted objects until the short receipt transaction commits.
Graph definition preparation validates all nodes on the worker before atomic admission. Worker reads
restore the exact definition and receipts; cancellation and admission queries require only metadata.
Private policy state and actions are immutable references, loaded outside Catalog when continuing.
Memory mutations and fixed-source child dispatch/observation use their existing domain writers and
receipt recovery. A policy can dispatch a child, continue independent work and later observe it through
`wait_child`, using ordinary graph nodes rather than a second child-action API. `todo`, `ask_user` and
`wait_process` likewise accept the real policy origin. A shared invocation capture restores the
original call, schema directory and history range outside Catalog; the commit rechecks their owner.
The frozen policy boundary records its actual branch/head, rather than deriving a plan view from
today's history. Ordinary extension tools and MCP permissions also carry actual policy origins.
Independent delivery and explicit pause use the control actions below. Other remaining design
domains are tracked in the implementation plan.

Question and process observers reuse the original Job acceptance and Wait owners. A pending observation
parks before an ordinary policy callback, retaining the committed private state and original event.
A failed or indeterminate sibling remains visible to the policy; an unexecuted continuation proposal
cannot advance its private state. Answer/process delivery waits for canonical acceptance to be consumed
by its real model exchange or graph node. Cancelling an observer between registration and parking is
authenticated against that original observer, and does not terminate the observed process.

`question_status` is an ordinary read-only Result tool for an accepted question in the same Run.
It distinguishes `awaiting_user`, `answered` and `cancelled`; only `answered` contains the authentic
answer and its user-history identity. Its worker reads referenced content outside Catalog and rechecks
the caller, question and Wait before returning. It neither changes JobAccepted into a terminal result
nor treats an answer as permission. The ordinary installed
[`domain-policy`](../../../examples/extensions/domain-policy/README.md) example consumes these tools,
owned result chunks and explicit Deliver/Pause/Resume without model inference.

## Safe policy activation

`policy_selections` records immutable selection intents, candidate status and their activation receipt
in the same Catalog. Selection checks both the active generation and the previous desired selection;
repeating the original command returns its original receipt. Preparation retains the exact installed
artifact, declared/configured identity, explicit planning roles and state-transition contract.
Callbacks, provider construction and content staging run outside Catalog. Ready is not active.

The existing Run worker selects a candidate only before a genuinely new decision. Its current
decision, model/tool exchange, policy action and registered observation complete under their original
binding. Independent accepted jobs do not form a global completion barrier. Activation commits the
new launch generation, private state, original unconsumed continuation and event together, then
replaces policy and planning providers in the same live slot. Main-model, source and tool selections
retain their own authorities. Pending decisions and activation checkpoints have distinct tags;
recovery executes an already stored action or delivers its actual continuation, never a fabricated
`Started` event. Within that same checkpoint, committed private state is distinct from a pending
decision's proposed state. Input that defeats action admission invalidates the proposal without
advancing its private state, including after input delivery, a crash and GC. Successful action
admission/consumption promotes the proposal; a registered Wait promotes only when actually parked.
Their content references and prepared publication leases participate in normal GC.

`varin.agent.policy@3` exposes explicit `transitionState` compatibility. An unchanged complete target
can retain state; a different target must accept the original private state explicitly. Incompatibility
leaves the active generation intact. The user's `restart_state` command resets only strategy-private
state, retaining history and independent jobs. Preparing, cancelling or restarting a strategy update
does not resume a paused Run. A child uses this same policy lifecycle while its admitted tool/source
profile remains fixed. Internal context jobs retain their fixed tool-free strategy.

Private policy requests, replies, cancellation and release identify their actual generation and
transport epoch. Planning credentials are likewise generation-scoped and exact saved configuration
is rebound on restart, rather than read from current settings. Retired callbacks retain their real
service pin until callback completion; an abort request is not stop evidence. A true Catalog reopen
marks unactivated candidates interrupted while preserving the committed active selection. Existing
terminal writers close outstanding candidates in their original transaction. Public inspection
separates active selection, durable candidate and transient Host preparation failure. The latter is
visible on inspect/snapshot refresh, without a separate push while a paused Run has no other events. UI restart and
cancel controls target the displayed original selection.

## Independent policy delivery and explicit pause

`Deliver { text }` appends an immutable assistant history item without creating a ModelStep, provider
original or tool exchange. Its `PolicyOutput` provenance retains the original action and policy identity;
all provider adapters serialize it as assistant/model output. Empty text is a real value. The worker
stages its history envelope, action body and private checkpoint before one Catalog transaction commits
the original head, action receipt and `policy.delivered` fact. Lost replies/reopening reuse that action.

`Pause { reason }` atomically commits the same policy-action owner, checkpoint, registered Wait and
waiting Run. The reason is immutable content, not control metadata. Input may queue, independent jobs
may finish, and the Host may reconnect while that Run stays paused. Only `runtime.run.resume` with the
original Run and Wait consumes the pause. It checks the original receipt before touching a newer
worker, joins the original parked worker outside shared locks, then commits the triggered Wait,
terminal action, runnable Run, existing launch rebind requirement and stable `PolicyResumeReceipt`.
Duplicate commands return its original cursor; they cannot release a later pause. Generic Wait
resumption and Run transitions cannot bypass this boundary. Run cancellation ends its owned Pause;
generic operation cancellation cannot silently resume it, and neither control needs the reason body.

The recovery reader selects the latest real policy action across graphs, model jobs and control
actions. An unconsumed `Delivered`/`Resumed` event remains the continuation boundary if queued input
is appended to history. A decision whose admission loses to that input does not advance private
state. Recovery distinguishes the original executed checkpoint from a later pending decision using
the existing action, checkpoint and input facts; actual model dispatch consumes that boundary.

Launch inspection exposes derived `startable` and `pause` views; the kernel combines Catalog
eligibility with the actual worker/quiescence owner. Host submission, recovery and domain continuations
share one cancellable launch entry. Durable `policy.resumed` facts wake that entry without making
child/process observation wait for cold preparation. Wakes received during a delayed earlier start
acknowledgement survive in that same transient launch owner and recheck eligibility after it drains;
a cancelled old epoch cannot erase a newer valid wake. The client separates `resume(runId, waitId)` from
`retryPreparation(runId)`, and the UI uses the exact displayed pause while preserving Stop run during
pending requests. See the ordinary [SDK example](../../../examples/extensions/delivery-pause-policy/README.md).

## One-shot process follow-ups

`runtime.followup.register` explicitly authorizes one continuation of the original work after a
selected accepted `process_spawn` has really stopped and its original Run has ended. The Catalog
requires the canonical JobAccepted or original executor receipt; a tool intent alone is not an
accepted process. The definition freezes the original Thread/branch, launch, configuration and
context scope. Its next-Run Wait and occurrence are distinct from the existing Run-bound process Wait.
No Goal, calendar rule, arbitrary user prompt or restored old Run is created by this command.

The original executor receipt retains monotonic stop evidence; terminal phase, EffectNone and absent
occupancy do not establish it. Registration records the source cursor and rechecks an already stored
stop fact. A Kernel event worker observes durable facts even without an attached Host. It prepares the
typed Environment history on a content worker, then one transaction consumes the occurrence and
admits its new input, Run and frozen launch. Startup discovery and stale preparation reuse those
identities. Current user work, queued inputs, explicit Pause and changed context/source scope hold the
occurrence rather than being overwritten. Same-source head/context refresh does not invalidate an
authorization simply because history advanced.

Independent definition pause/resume/cancel checks its revision. Cancelling the original Run cancels
its independent unconsumed authorizations in the same transaction. A definition associated with an
explicit Goal follows that Goal’s control instead; Run cancellation pauses the Goal and preserves its
real dependency for a later explicit resume. Once consumed, definition controls return the original receipt;
the new Run has its own cancellation identity. Its actual terminal transition settles the occurrence.
Shutdown fences old-worker admission; a later owner can recover unconsumed work. Held states do not
emit repeated events or drive a polling loop. Preparation failures remain visible and explicitly retryable.

The continuation can inspect/read only its exact original process when the retained tool selection
already permits that operation. The Catalog derives the original Run from the consumed occurrence;
Storage checks both original and current grants, Thread, workspace and physical source. No other process,
stdin, kill or new process Wait is delegated, and revoked original authority stays revoked. Process
output remains in its existing owner, not in a second follow-up output store. Definition launch content
and original receipt/history references remain normal ContentStore roots.

## Explicit continuing Goals

`runtime.goal.start` requires explicit user authorization on the latest primary Run, including an
ended Run. Ordinary inputs and conversation forks do not create or duplicate that authorization.
There is at most one unfinished Goal on a branch. Objective, report reason and creation intent use
ContentStore references with publication leases; capture and commit hold only short metadata.
`update` and `control` validate Thread/branch scope and the user-visible revision. Their generation
fences prepared requests, policy boundaries, new tool effects and original `goal_report` calls.
Controls return short admission receipts; reading the current objective and usage is separate.

The original ModelStep or policy-model Operation records the dispatched Goal identity. Children and
owner-triggered summaries inherit their original admitted/delegated ownership, including an accepted
child not yet prepared. Only actual inference receipts update the small derived usage aggregate in
that same transaction. Late and rejected output, cancellation and interrupted recovery retain their
original attribution; reading results, nested tool receipts and repeated projection do not charge again.
A new ordinary input delivered after Goal completion/cancellation detaches the current primary Run
without changing the input's identity or rebilling the already dispatched inference/delegated work.
History changes never rewind usage. Summary requests are charged to their owner but receive no Goal
execution instruction; manual independent summaries have no implicit Goal owner.

An optional budget limits provider-reported output tokens. Actual, estimated, missing and pending
usage are separate; input/cache/reasoning fields retain provider semantics and are not added into a
fabricated total. Already dispatched concurrent work can exceed the budget. Once a settled inference
has no actual output count, a set budget blocks further inference and automatic continuation with
`usage_unknown`. Resume does not erase this evidence; explicitly removing the budget permits progress.
Budget exhaustion is not Goal completion, and zero is a valid budget that admits no new inference.

The ordinary `goal_report` tool completes or blocks only its originating current primary Goal.
Its original Operation/call receipt and Goal change commit atomically, without a fabricated ModelStep
or a mandatory evaluation-model request. A real process dependency registers its original stop Wait;
stop evidence observed before registration is rechecked in that transaction. Manual pause survives
both dependency completion and other domain answers. Already dispatched effects and independent jobs
retain their original lifetime and factual settlement.

The existing followup owner also records typed `run_completed` and explicitly authorized
`goal_requested` occurrences. Consuming an occurrence and admitting its Submission/Run/launch share
one transaction, rechecking Goal generation, actual usage, unsettled operations, original waits,
queued user work and branch/source scope. A normal final answer ends one Run, not its Goal. A Goal
reporting a real blocker does not spin another model request. The original blocked report may end
its own Run; later user work under the same blocked Goal stays parked instead of being marked
completed without consumption. A paused, blocked or budget-limited live Run parks on `goal.ready`; the supervisor quiesces its old worker before durable `goal.run_ready` release.
Question and policy Pause identities remain distinct and require their own valid resolution.

A proven-unsent main ModelStep follows the same recovery boundary described above. A newer Goal
invalidates its old proposal without losing the real input or continuation; manual pause prevents new
provider work until explicitly resumed. Already dispatched inference keeps its original attribution
and is never reclassified as unsent to restart the Goal.

Calendar recurrence and generic event conditions are separate remaining domains; these Goals do not
install another timer loop, scheduler, task tree or execution ledger. See
[`goal_lifecycle.rs`](tests/goal_lifecycle.rs), the existing child/context/policy-model suites, and
[`agent_goals.rs`](../varin-kernel/src/agent_goals.rs) for in-process behavior coverage. Their simulated
providers do not establish model quality, live cost, or product transport/platform acceptance.

## Policy-originated planning models

`RequestModelJob` selects an admitted planning capability by ID and supplies pinned policy
instructions plus owned evidence references. It creates one Run-owned `PolicyModelJobV1` Operation,
never a synthetic conversation, compaction Run, ModelStep, or read-only tool. The existing
ModelProvider adapters, credential owners, content store and UsageReceipt remain authoritative.
Provider construction is shared with ordinary chat; no implicit main-model fallback exists.

Admission freezes the current committed context as quoted source data, the exact model/config/account
binding, instructions, evidence, serialized request and private policy checkpoint atomically. Instructions,
capability configuration and private state reside in the immutable action body. The Operation retains
ownership and references, so dispatch/cancel/recovery checks do not decode that body. Typed
request origin distinguishes conversation requests from policy model work. Graph and model actions
share a decision boundary and latest-action recovery selection. Provider I/O runs on the existing
Run worker, outside the Catalog/control lock, so a stalled planner does not occupy other Runs.

The Operation records prepared versus durable dispatch intent and owns original output, opaque items,
usage and a terminal receipt. A never-dispatched prepared request may resume only with the exact
binding and request. Once dispatch intent is durable, a crash or cancellation without completion
produces an interrupted/indeterminate receipt, never automatic paid replay or assumed zero usage.
Completed-item, usage and terminal boundaries persist observed output; token deltas are transient
until such a boundary. A crash can lose uncommitted deltas. Completed items are stored on the Run
worker before their references and observed usage commit; token deltas do not each write a transaction.

Tool calls returned by the tool-free provider are retained but never executed and make the plan
unusable. A successful textual plan is exposed through a Run/action-owned reference and bounded
`ReadResult` chunks. Main-model injection labels it as untrusted model-derived evidence. Provider
opaque originals are retained separately and never enter that evidence path. Body creation uses a
publication reference across off-lock work. New dispatch verifies the frozen conversation head and
branch owner; already-dispatched output and usage remain recordable after later history changes.
Both operation cancellation and model-generation interruption address the same registered child.

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

The provider adapters and control boundary are foundations for the full cutover, not evidence
of provider/platform parity. Remaining domain and MCP capabilities,
provider capacity-error recovery and replaceable context strategies, broader UI/product coverage and
single-writer ownership transfer remain tracked in
[`docs/plan/agent-runtime-implementation.md`](../../../docs/plan/agent-runtime-implementation.md).
That matrix owns actual validation and incomplete capabilities. No measured speedup or platform
acceptance follows from this implementation alone.

## Explicit source identity and launch format

The source contract replaces the old `materialized` boolean with `fixed_branch`, `materialized`,
and `live_root`. Fixed sources require a branch/revision; only materialized copies carry an originating
Run. A live source instead requires its Host/canonical-root/Rust-root identity and cannot claim a fixed
revision. Exact source comparison covers rebinding and inherited launches; live identity is not a grant.

The current launch domain is 3; current Catalog/content versions are recorded above. An existing
database is opened read-only first, including its committed WAL, and launch
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

Only the original confirmed memory Operation can authenticate a tool's receipt for tail
deduplication. Arbitrary external tool JSON is data. The existing deliveries table uses actual
memory.fact event cursors and records selected, sent and completed-request inclusion independently.
A failed request does not acknowledge facts. Planning requests use their own real operation/request
identity; their quoted source facts do not become instructions or fake ModelSteps.

A successful explicit compaction atomically publishes its fixed candidate personalization together
with the summary and system text. New notes do not advance the checkpoint CAS; explicit profile
changes do. Context domain 4 is verified read-only before writable SQLite open, including table,
key and revision uniqueness contracts. Older or malformed formats are preserved and rejected.
## Isolated child tasks and fixed results

`catalog_collaboration` is the Catalog's parent/child domain. A dispatch binds the committed
ModelStep/tool or PolicyAction/node origin, parent Run/Thread/branch, exact model configuration and
credential scope, admission project, selected profile and original source. Model arguments cannot
select parent identity, project, workspace, source or grants. `dispatch` schema 2 takes `task`, an
optional configured `preset`, `workMode` and explicitly narrowed `tools`; old `model/profile` input
is rejected. The existing Host `harness.models[role].agent`, `harness.agents` and shared preset
resolver remain the configuration authority. Host prepares immutable `ChildDispatchCatalog` content
with explicit inheritance/selection, original model configuration and credential scope. Original input
or model-selection admission commits its reference atomically; retries keep the first accepted snapshot.

`catalog_dispatch` retains these content references through Launch/ModelSelection, actual request and
policy-node binding, and selected ChildTask content. The same closed-boundary preparation freezes the
actual parent model/tool declarations and adds credential-free discovery to the model RequestView.
A later configuration, model or tool selection cannot rewrite an old invocation. GC follows original
nested references and in-flight publication; descendants share the catalog rather than nesting copies.

Normal dispatch inherits its actual model and delegated tool declarations, including ordinary memory
and plan when present; primary Goal authority remains separate. Explicit `tools` may narrow that set; same-name but different
declarations are not reinterpreted as core tools. The default set fails visibly if capabilities are
unsupported. An explicit preset validates its whole declared definition before narrowing or overriding
its work mode; missing, disabled or unsupported choices never fall back. Explicitly selected models
remain selected even if their IDs match the parent. Inherited overrides retain the original parent
basis, including explicit zero temperature and thinking settings.

`read_only` fixes the source and removes known physical capabilities. `isolated_write` preserves the
existing controlled file_write/file_edit projection inside a private materialized source; it does not
add process authority or grant writes over the parent's source. Native children can select file tools,
resources, questions, child dispatch/status/report/wait and managed process spawn/inspect/read/write/resize
and wait. Process access requires the frozen configured capability or actual parent delegation, source
authority and ordinary permission gates. A process cwd is not an OS sandbox. Selected ordinary
extension and MCP tools retain the actual parent request's exact bindings; the child does not discover
new capabilities from later routing or configuration. Ordinary AgentPolicy and its declared planning
roles use the child Run's own policy generations and credentials; the policy cannot expand this frozen
tool directory. Primary Goal, LSP, Computer and remote child bindings remain separate work. Explicit parent Integration is a separate
authorized action.

The frozen dispatch body retains original tool declarations, schema generation, MCP provenance and
extension bindings through ContentStore references. Actual native capability descriptors are included
for presentation; configuration parsing does not invent a second tool directory. Core selection checks
the full configured preset against the real frozen directory before narrowing. Same-name Host tools
remain Host tools and cannot acquire native process or file permissions by spelling.

MCP provenance separates original configuration source and server definition from execution scope,
reference, generation and resources. A workspace dependency is prepared only after the child has its
own physical execution source; a neutral global dependency stays global. The existing unused-launch
preparation transaction permits one child execution-binding derivation, fencing original provenance,
exact declarations and current launch revision. Restore then reuses that committed child binding.
An original global configuration file alone does not imply a global execution scope.

Before durable child acceptance, a short private Host handoff retains original live owners while the
parent's frozen exchange is still held. This performs no service preparation. Parent completion and
channel replacement cannot release accepted child holders; successful independent child Run assembly,
terminal child facts or old-epoch unaccepted recovery release them. Ordinary service replacement can
derive a child pin from the still-retained exact generation. Explicit revocation remains authoritative;
Host restart reconstructs only an available exact artifact/definition and never substitutes latest.

The source owner validates whole-root read authority and records a bounded handoff under the
persisted tool Operation. Fixed sources retain their original revision pin. Physical sources retain
an exact root identity, not a claim that dispatch captured their bytes. Catalog then atomically
creates the independent child Thread/branch, immutable task/model/scope and original JobAccepted.
Slow capture and context preparation happen after durable acceptance. A narrow path grant cannot
silently become whole-root cloning authority. Unaccepted fixed-source handoffs remain discoverable
until their original pins are actually released.

Host preparation reuses an immutable pin or performs the shared stable saved-files capture against
the actual Documents root. Branch creation retains provenance through the existing Storage blob and
record references, including explicitly omitted unsaved overlays. Recovery reads that original
receipt before consulting the current directory or Git state. Public source views hydrate provenance
outside Catalog. The existing input writer commits prepared context, child Run, source launch and
receipt together after rechecking cancellation and source/credential authority. Late cancelled
preparation cannot launch a child.

`child_tasks` retains the stable dispatch relationship; `delegated_executions` owns preparation,
source, Run association, report and fixed result for both the original dispatch and later explicit
User continuations. Run/Launch/Operation remain the execution and effect authorities. Original
ChildTask and `wait_child` always reference the dispatch execution, never whichever round is newest.
Schema-2 `child_status` and `child_report` select exact execution identities. A report reads only
history produced by that execution's actual Run at its terminal head; inherited assistant text is
not a new report. Parent integration schema 2 requires child operation, execution and publication IDs.

A terminal child's `runtime.child.continuation.accept` binds a User key, exact previous actual Run,
expected branch head and original input. Its accepted intent precedes cold source/context work and
is discovered by the same Host collaboration consumer after restart. Identical retries return the
original execution even after configuration changes. Failed or cancelled preparation without a Run
does not permanently prevent a later explicit User intent. Active child boundary/interrupt inputs
still use the original queue; `next_run` cannot bypass delegated source and execution admission.

A new Run retains the predecessor's actual configuration, credential scope, policy artifact/planning
models and frozen tools, with fresh policy generations and no copied private state. A writable round
starts from its predecessor's exact published WorkingResult; a read-only or proved no-effect round
uses its exact immutable baseline. Unstopped writers remain blocking facts. Once Storage has fixed an exact result after writer stop,
its old effect may remain unknown while a new explicit Run uses that root; this never replays or
settles the old effect. An unavailable result without a fixed root requires proved no-effect before
reusing the immutable baseline. Fresh source branch, retained pin and result publication
are keyed by execution ID. Continuation has no original-parent handoff to reclaim. New MCP scope is
re-admitted from the exact prior definitions once; restoration of that same Run requires the actual
committed binding. Current trust, permissions and revocations still apply.

Source replacement preserves the existing context summary/history anchor, role and memory snapshot.
The old checkpoint ID is the outer replacement CAS; explicit skill input binds the same prepared new
context. Original User text and images retain their input provenance. Cancellation fences all
currently accepted executions, including preparation before Run creation, and late source/context
work cannot publish a cancelled command. A later explicit User command is a new intent, not a reset
of cancelled history. A completed/cancelled inherited Goal does not cancel or charge that
new User Run; an admitted still-active Goal keeps its pause and budget. Goal association is bound
after the exact execution trigger in the same submission transaction, and later parent adoption
cannot cross that User boundary. Old execution usage and Goal membership remain unchanged. Relation/execution content references and in-flight publication participate in
the original GC; fixed files remain under Storage's original roots.

The child has an independent Run and grant. Parent final, cancelling only the parent's current Run,
normal extension retirement, or revoking the old parent grant after handoff does not kill the child.
Child/tree cancellation remains explicit; actual higher-level workspace or credential revocation
still applies. Recursive dispatch captures the current child's actual physical source, including its
changes, rather than reverting to its initial immutable baseline or the top parent's directory.
Catalog computes the specified subtree from retained Thread/ChildTask lineage with no depth cap. Its
transaction cancels preparing children, descendant Runs, live process Operations and original active
followup/Goal continuations, including terminal source Runs. Parent and sibling subtrees stay outside
a child target. A short TreeCancellationReceipt acknowledges cancellation intent, not executor stop.
A parent-Thread scope fence is checked in that same transaction. Correlated reply
Wait/deadline, remote environments and the complete collaboration product migration remain separate work.

A report, execution outcome and file result are separate facts. Report outcome follows the original
terminal Run and the presence of a textual report; an earlier failed tool does not permanently turn
a later completed Run into failure. Its failed/unknown Operation and receipt remain unchanged.
A completed report is not proof that every tool succeeded. A read-only textual report is valid
with `no_changes`. A final child report can coexist with independent live processes. Writable children
wait for actual file-worker/root-lease drainage and original process/guardian executor-stop evidence,
along with dispatched workspace MCP and source-scoped extension callback stop facts, before fixing a
candidate through the original Storage owner. Writer classification loads the original child binding
content outside Catalog and then fences its references against current metadata. Neutral global MCP
is not classified as a child-directory writer by name; an undispatched operation needs no invented stop
receipt. The effect summary describes source operations; exact file differences remain in the original
WorkingResult root/base-root, not an inference from a successful callback. Unknown effects remain distinct from
proved stop; neither report completion nor cancellation intent releases the writer barrier. Candidate/base pins and original operation receipts
bridge crashes; an existing candidate can publish without its former physical directory. A readonly
worker prepares the WorkingResult, then Storage atomically publishes its original branch revision,
record references and receipt. Catalog retains only the verified fixed result identity and effect.
Cancellation or an empty report does not erase confirmed changes or convert unknown effects to none.

Parent integration explicitly selects that fixed publication through an ordinary installed tool.
The existing Integration journal owns three-way merge, conditional file/Document changes and
recovery. Its original causal binding and path phases supply the Host Tool receipt; recovery reads
the original journal without re-executing effects or requiring a surviving target directory.
Unresolved external effects remain unknown. Executor stop is separate from effect confirmation,
and cancelling a Run does not turn a pending Surface request into a completed executor.

A fast child may report before the parent's accepted call is consumed. Canonical `call_completion`
retains the original acceptance while the existing external receipt independently settles outcome.
Recovery fills an unconsumed graph receipt from that acceptance without another source handoff,
dispatch, preparation or model request.

`wait_child` registers the original durable Wait and its Job receipt together, including a
retrospective terminal-event check. A parked parent's worker is quiesced before the report is
appended under its true agent provenance, with explicit data-only labeling in the actual provider
text. Run resumption and Wait acknowledgement commit with that history item. A delivered-but-not-
launched continuation remains discoverable after restart, while its report history identity is
idempotent. Cancelling observation delivers an environment fact, leaves the child running, and
does not consume a later child report. Ordinary model dispatch recovery continues to refuse
replaying a dispatched request whose completion is unknown.

The collaboration policy checks a pending observation before invoking the selected strategy. It
parks with the unchanged strategy checkpoint rather than silently advancing private state for an
action it did not execute. Report delivery resumes the original graph completion boundary. If the
observation was cancelled after registration but before parking, the same domain owner permits the
pending cancellation delivery to park; no other cancelled Wait gains permission to resume. The
original cancelled fact is delivered once, and the child remains independent. Wait arguments and
their original tool origin are loaded on a worker; registration rechecks the same operation and graph
admission before committing only metadata.

Collaboration domain version 4 is required by the read-only existing-catalog preflight. An older,
missing or malformed domain is rejected before writable SQLite access or epoch advancement;
there is no schema upgrade, fallback registry, or asset reset. New empty catalogs create the domain
explicitly. Context scope uses the separate context domain version 4 contract.

Child report metadata stores only references to the original child history bodies, plus a short
runtime failure detail when relevant. Status/list and external receipts do not copy report text.
`child_report` reads one referenced text item with a UTF-8 byte offset and an explicit
`next_offset`; pages are capped at 64 KiB, leaving JSON escaping/envelope headroom within the
16 MiB IPC frame. A durable Wait includes only the latest bounded preview, labels it as possibly
partial other-agent data, and exposes all history references for deliberate continuation reads.
A fork after a delivered report reuses its visible ancestor delivery; a fork before that item can
receive its own report. Cancelling an observation never marks the report delivered.

Collaboration preflight verifies complete nonpartial unique keys, their BINARY collation and
ascending key columns, the actual primary-key index origin, and exact FK mappings/actions/match.
A partial or differently collated index cannot stand in for the admitted identity constraints.
These checks precede mutable catalog open and never migrate an unsupported catalog.

## Independent tool preparation

Every bound executor implements a local, nonblocking `plan` contract. `Ready` supplies the complete
canonical contract; `Resolve` supplies resource intents and the trusted execution class before an
owner lookup. Wrappers forward this contract to the actual capability. The shared `ResourceAdmission`
registers these intents in model-call order before preparation workers start. Reservations hold
neither resource leases nor compute capacity. Independent preparation, authorization, dispatch and
settlement proceed per call; provider history still closes the complete exchange in original order.
`Persistence` must return its retained coordinator for all engines, batches and policy calls; there
is no optional admission path or per-batch coordinator/capacity default.

An unresolved intent blocks only later claims that may conflict. Resolution must keep every canonical
claim inside its declared exact key or namespace and cannot promote Read to Write. Admission rejects
a mismatching plan before durable dispatch, narrows valid intents to their actual claims, and acquires
all resources plus compute capacity together. This also orders calls from other Runs and policy graphs
through the same authority. Cancellation wakes the original call; dropping its undispatched
reservation removes its queue entry. Dispatched occupancy still requires the existing executor
receipt/reconciliation contract.

Physical file plans use Storage's canonical file namespace until aliases and junctions are resolved;
workspace/root IDs cannot partition the same physical target. Known process, language, discovery and
fixed-source plans bypass that unresolved namespace. Two physical reads can overlap; a later possible
file conflict waits for enough identity evidence to establish independence. The actual resource owner
revalidates canonical targets at dispatch, as before. No unknown write is speculatively dispatched.

Effectful calls and independent jobs persist their individual admission before dispatch. Plain
read-only Result calls keep in-memory admission and do not add per-stage durable Operation records.
Preparation failure settles only its call; a durable-receipt failure stops pending dispatch without
inventing evidence that active effects stopped. Compilation is separate from behavior acceptance.

## Search capacity and task-family admission

The Catalog-owned `ResourceAdmission` now admits selected local computation together with its whole
resource plan. Pending calls hold neither resource claims nor execution capacity. Conflicting claims
retain FIFO order; runnable local-compute families rotate, so many queued searches from one task do
not put all of that task's work ahead of another waiting task. A family is the root Thread
obtained from the Catalog's existing child/parent Run lineage, never a project, path, or model-supplied
family value. Parent completion does not change that identity. No second task tree or durable scheduler
log is created.

The first classified production capability is bound `ToolKind::FileSearch`, including policy
tool-graph calls. Plain file reads, directory lists, dispatch, questions and control do not consume its
capacity. The trusted executor supplies the classification; wrappers forward capabilities they do not
own. MCP annotations cannot assign local execution classes. FileList, composite retrieval stages,
LSP/service waits, model-provider quotas, maintenance and direct non-`compute.start` consumers
are not yet covered by task-family scheduling. The latter still share the kernel's original compute
queues; this slice does not claim global execution fairness across those callers.

`VARIN_COMPUTE_CONCURRENCY` selects a positive foreground concurrency at process startup.
Absent an override, the existing conservative two-worker budget is retained, reduced to one on a
single-core host. This is a deployment default, not a task/tool-count rejection or a measured optimal
setting. One process-frozen budget configures both the real foreground compute workers and native
admission. Background compute retains its separate worker. Invalid configuration is an error; a
partially created worker pool is not published as full capacity. Configuration changes require restart.

Each pending call retains its actual Run generation and model-request/tool-call or policy-action/node
origin. `runtime.status` exposes only capacity/count summaries. `runtime.admission.inspect` takes the
Run ID/generation and existing origin/call identity (discoverable in model-step/tool history or the
policy Operation), validates ownership, then returns one bounded projection. `admissionId` is a
transient call handle, not proof of a durable Operation. `queued`/`active` describe current admission;
`settled` requires a durable tool/node receipt; `not_active` makes no terminal claim. Unknown calls,
foreign origins and expired generations fail explicitly. Queue reasons distinguish resources,
capacity and family turn. No full unbounded queue is sent in one IPC frame.

Run cancellation and queued grant revocation wake the original call token. A scoped registration in
the existing capability-control owner spans the queue wait; releasing it does not revoke the shared
service or another caller. Dispatch rechecks Run generation and current authorization. Cancellation of
running computation retains occupancy until its actual completion/stop receipt. Already dispatched
model requests and unknown external effects keep their original recovery rules; transient admission
never causes paid replay. Reopened pure-read recovery, when already permitted by the Catalog, derives
family again and reenters the same current capacity budget.

This slice still starts a waiting thread per ready tool/node and uses the existing compute workers.
It does not implement a universal bounded worker executor, priority aging, per-device memory budgets,
or all execution classes. Independent behavior acceptance is required before marking this slice
verified in the implementation matrix.

### Independent slice acceptance (2026-10-09)

The frozen implementation passed 8 runtime Rust cases and 2 Host-source-client/kernel cases.
The latter used the actual diagnostic kernel, configured foreground capacities 1 and 3, real
FileSearch, worker-count observation and precise admission identity/status checks. They are not
packaged-Host acceptance or a saturated control-latency measurement. Rust covers family rotation,
resource FIFO, atomic capacity/resource admission, cancellation retaining running occupancy,
Catalog lineage, trusted executor grant-watch registration and policy read-graph admission.
Two initial reviewer fixtures were corrected (existing receipt state and mismatched node/call IDs);
failed logs were retained and all eight cases rerun. Production source did not change.

The actual kernel binary SHA256 is
`c12c8985f89a1e7059cce156eed3dedabd2f6f8b7769ca7a94d454cfba4771bb`,
with build identity 0.9.24 and debug profile. This evidence does not establish real-Kernel queued
grant-revocation/epoch wakeups, OS thread-creation failure rollback, changed-runtime restart replay
behavior, or fairness for all compute consumers. Integration with the memory/context branch needs
MemoryTools to forward execution_class and watch_admission and separate combined verification.

## Process observation waits

`wait_process({processId})` observes a `process_spawn` Operation of the same
real Run. It registers the existing Catalog Wait and its JobAccepted tool receipt together,
then parks only after the model/tool exchange closes. Terminal facts that precede registration
are found retrospectively. Process state/output remain owned by Storage and the original
process worker; recovery never executes the command again. A recovery-only indeterminate process
does not trigger the Wait: only the original executor's durable receipt can deliver a lifecycle
fact, and an indeterminate receipt is never presented as proof that its tree stopped. History contains only a bounded
lifecycle projection and an existing `process_read` reference, not command arguments or
log contents. Delivery identity deduplicates the same process fact on the visible history chain.

The existing Host continuation coordinator consumes process-wait facts alongside child facts;
there is no timer/model polling loop. It rebinds the same Run through its saved model, source,
and context preparation contracts. Cancelling the observation cancels its Wait, not the process.
Cancelling the actual spawn Operation retains the existing explicit process-stop path.

After legal rebind, inspect/read can observe that exact same-Run process only after
Catalog verifies its original spawn Operation and immutable source selection. Storage rechecks
both the original creating grant (including explicit revocation) and the current authorized
Run/Thread/workspace/source-scope grant on every observation. This is an internal read-only
path, not an observer grant, owner replacement, or maintenance/kill/stdin/write delegation.
Current Host source trust is re-admitted before continuation rebind. The existing Host deployment
root/trust guard has no event bridge that immediately revokes already issued grants when
its deployment configuration changes during a live launch; this unit does not broaden that
existing lifetime or claim to implement such a bridge. Explicit grant revocation is checked on
every delegated observation. Cross-Run observation, even within the same Thread, is excluded.

### Independent process-wait acceptance (2026-10-09)

The independent lane passed runtime 7, actual Host/kernel 5, and one unchanged source-picker
process consumer. Host test types, focused handwritten TypeScript lint and protocol checks passed.
The accepted source, dedicated kernel and actual generated dependencies were stable before/after.
The 0.9.24 debug kernel SHA256 is
`3c663931ba1e94241e0d80f9cbc7aa07b208a74e8e50d24660e1847844ca348d`.

Review closed three defects: synthetic recovery Terminal/Indeterminate is not an executor terminal
receipt; observation cancellation and Wait state must persist atomically and recover committed intent;
portable-pty signal is a string and is preserved rather than silently projected to null.
Tests cover early/duplicate terminal, lost continuation, observation cancellation without process kill,
Run cancellation, exact same-Run/source rebound observation, original/current grant revocation,
foreign Run/source and kill/stdin rejection. Rebuilding only the Host continuation service can resume
the still-live original process; closing the kernel intentionally stops it, and reopening delivers its
actual Failed/Killed and incomplete output without respawning. These are distinct contracts.

The initial fixture incorrectly expected process survival across kernel shutdown and attempted cleanup
through a closed client; those failed logs remain. The corrected tests reflect existing lifecycle rules,
not a new persistence guarantee. Runtime trust/root changes still follow the existing source-grant
lifetime; this lane does not implement an immediate trust-change revocation listener. Fairness-main
integration requires ProcessWaitTools capability/admission-hook forwarding and separate verification.

## Plan identity

`catalog_plan` projects fixed Thread/branch/head identity and an immutable fork basis; it stores no
plan text or mutable plan pointer. New plan-aware forks record the KnowledgeStore capture on
`branch.created`, after checking its source Thread, branch, head and inherited reference.
The Host performs KnowledgeStore capture outside the Catalog lock. Historical cuts, including
null pre-history, remain explicit. Root/legacy branch identity comes from Catalog creation facts;
an unrelated abandoned capture cannot change it. KnowledgeStore owns atomic version/CAS/receipt
publication and verifies the recorded fork basis before resolving plan content.

Plan visibility follows at most 256 immutable parent metadata rows per control request, using
HMAC-authenticated cursors tied to the Catalog-open epoch, Thread, branch, selected head and
candidate. No complete history list crosses the plan bridge. Host cancellation ends between
bounded pages; reopening restarts only pure reads. Existing conversation fork replay/pairing
validation is unchanged and is not claimed to be a new bounded plan-page operation.

`todo` exposes `read` and whole-plan `update` with exact `expectedRef` CAS. The private
bridge derives the fixed invocation head and original Operation identity from Catalog; tool
arguments contain no owner/scope fields. Model and policy-node mutations retain their actual tagged
`ToolOrigin`, call, Run and original effect epoch in the existing KnowledgeStore receipt intent.
Recovery preserves that effect epoch while new execution remains fenced by the current Run/graph owner.
Admitted ordinary main Threads and explicitly selected ordinary children can use the same schema;
dispatch rechecks their persisted scope and real child relationship. A worker role label alone grants
nothing. Each child uses its own Thread/branch/history plan, never a copy of its parent plan.
User plan read/edit/fork remains independent of whether the Agent selected the todo tool. Source-inheritance filters
recognize this built-in without granting source capabilities. An authoritative CAS-conflict
receipt settles `Failed/None`; an unknown dispatch is not relabeled as no effect. Recovery queries
the original Knowledge receipt and never repeats a plan mutation.

### Plan slice verification (2026-10-09)

Independent owner tests passed 22 cases using real TriviumDB and private IPC. Independent Host
integration passed 22 cases against the diagnostic kernel, including HTTP identity/CAS,
fixed and nested forks, bounded membership cursors, model/tool consumption, structured
conflict settlement and lost-reply reconciliation after a later user edit and owner/kernel reopen.
UI/client focused tests passed 18 cases. Cargo check/build, protocol/client builds, the Host raw
bundle, Host test typecheck and full UI typecheck completed. Fixtures were corrected to use actual
persisted context admission; this does not substitute for a production scope grant.

The exact durable no-effect receipt test and 12 existing execution behavior tests also passed.
Integration with the newer process-wait mainline remains a separate pending gate at this snapshot. This is not packaged-surface, power-loss, or full-design
acceptance. Project/Bot/Pi plans and legacy Pi timestamp CAS are unchanged.

### Combined plan/process/capacity acceptance (2026-10-09)

The plan lane is now integrated with durable process observation and family admission. The combined
0.9.24 debug kernel SHA256 is
`b86064f0695382a1560469644d27db666c091376e528856c863c427ad36a379f`.
Actual Host/kernel tests passed 27 cases (plan 22 plus existing process wait 5). The exact durable
no-effect evidence test and three held-permit kernel cases passed. Those three exercise the real
PlanTools -> MemoryTools -> ProcessWaitTools -> CollaborationTools -> Questions -> KernelToolExecutor
chain for queued search, cancellation and post-permit Storage revocation. Plan classification is
unmetered; real plan execution is verified by the Host tests. Immediate queued revocation wakeups
remain outside this fixture's scope.

Protocol/client and Host production builds, focused combined consumer types, changed-filter/test
lint, protocol generation consistency and whitespace checks passed. The independent lane's owner
22, UI 18, full UI types and final Host test types remain separate evidence. Source and dedicated
binary hashes were stable throughout the combined behavior checks; the final addition is this
acceptance text only. No packaged UI, unexpected-crash or full-design acceptance is claimed.

Initial combined Host compilation caught an incomplete conflict resolution, corrected by a fresh
three-way reconstruction and independently checked byte-for-byte before successful rebuilding.
An initially overbroad Cargo invocation also compiled the unchanged policy_model_jobs_review test
fixture, which lacks context_preparation in nine ExecutionEngine initializers. The intended --lib
checks then passed without modifying or claiming that unrelated target passed. Focused whole-file
lint on the independent lane retains the pre-existing index.ts prefer-const error, reproduced on
its base revision; changed plan files and merged filters add no lint errors. These initial failures
and the successful scoped reruns are retained separately.
