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
Catalog version 19, input domain 2 and collaboration domain 2 store input intents/queue bodies and context-job ownership,
source-part and immutable recipe references separately from model
configuration; content format 3 retains typed request origins. Older internal formats are rejected before owner-epoch or recovery writes. Missing or corrupt referenced
objects fail explicitly. `Catalog::collect_content_objects` marks requests, provider originals,
history, all model outputs (including rejected output), original command intents, queued-history references, context
checkpoints, memory projections, summary recipes and source parts, policy action/checkpoint bodies,
and indexed graph calls/receipts, planning-model request/output references, ordinary tool arguments/results,
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
restore the original call/scope shape. Plan authorization reads its frozen model request outside Catalog,
then rechecks the current owner and request reference. Ordinary tool results and original external
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
receipt bodies on its read worker. Content collection still performs its complete mark/verify/sweep
under Catalog ownership; removing that long control-path work remains a separate implementation step.

## Execution and trust

Catalog methods do no provider, tool, extension or network I/O. A mutex around Catalog is held only
for a local commit or read. The cancellation token is independent of catalog and progress delivery;
requesting cancellation does not invent a stopped executor or erase an external effect.

A dispatched model request is interrupted on restart and is not automatically sent again. An
unconfirmed external effect becomes indeterminate and requires reconciliation. Wait resumption uses
a durable identity: a crashed claimant can reacquire it, and acknowledgment commits the runnable
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
`wait_child`, using ordinary graph nodes rather than a second child-action API. Plan
tools, process observation and questions retain their explicit origin restrictions until their own
policy-origin consumers are connected. Independent delivery and explicit pause use the control actions
below. Ordinary extension tools and MCP permissions now carry actual policy origins. Other remaining
design domains are tracked in the implementation plan.

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
does not resume a paused Run. Fixed child/context policies retain their admitted profile.

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
the existing action, checkpoint and input facts; an admitted model request consumes that boundary.

Launch inspection exposes derived `startable` and `pause` views; the kernel combines Catalog
eligibility with the actual worker/quiescence owner. Host submission, recovery and domain continuations
share one cancellable launch entry. Durable `policy.resumed` facts wake that entry without making
child/process observation wait for cold preparation. Wakes received during a delayed earlier start
acknowledgement survive in that same transient launch owner and recheck eligibility after it drains;
a cancelled old epoch cannot erase a newer valid wake. The client separates `resume(runId, waitId)` from
`retryPreparation(runId)`, and the UI uses the exact displayed pause while preserving Stop run during
pending requests. See the ordinary [SDK example](../../../examples/extensions/delivery-pause-policy/README.md).

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
changes do. Context domain 3 is verified read-only before writable SQLite open, including table,
key and revision uniqueness contracts. Older or malformed formats are preserved and rejected.
## Fixed-source child tasks

`catalog_collaboration` is the Catalog's parent/child domain. A dispatch binds the committed
ModelStep/tool or PolicyAction/node origin, parent Run/Thread/branch, exact model configuration and credential scope,
admission project, explicit `read_only` profile and fixed source. Model arguments cannot select
parent identity, project, workspace, source or grants. The initial implementation accepts explicit
`model: parent` and inherits only the parent's selected file read/list/search subset. Child Runs do
not acquire MCP, questions, recursive dispatch, process, file mutation or memory mutation tools.

The source owner first validates the actual parent grant and records an immutable revision pin
under the already persisted tool Operation identity. Whole-root read authority is necessary for
this whole-root handoff; a narrow path grant cannot be silently widened by cloning its root. That
source-authorization receipt and the Catalog child acceptance are separate facts. The Catalog's
short transaction creates the independent child Thread/branch, immutable task/model/source/scope
and operation handoff, and persists the original JobAccepted receipt. Its operation ID is the
usable handle for `child_status` and `wait_child`, not a claim that preparation or
execution has finished. A stopped dispatch with a source receipt but no child is rediscovered from
its original Operation and exact pin identity. Host cleanup records `child.source_released` only
after the existing WorkingState owner releases the pin; failed cleanup remains discoverable.

Host preparation clones the fixed root through `createBranchFromPin`, without recapturing the
workspace, and invokes the same context owner with explicit agent/worker/admitted-project scope.
Session notes are keyed by the child's Thread. The existing input writer atomically commits
the prepared context, child Run, source launch and child receipt after rechecking cancellation.
Source and credential owners are revalidated before launch. A late cancelled context callback
cannot publish or launch; closing a Host leaves durable preparation for the next owner.

The child has an independent Run and grant. Parent final, cancelling the parent's current Run,
normal extension retirement, or revoking only the old parent grant after a successful source
handoff do not implicitly kill the delegated child. Cancelling the child or the task tree is a
separate action; higher-level workspace or credential disablement still applies at its actual
owner boundary. The first slice does not implement arbitrary siblings, remote/live first capture,
write-capable children, code integration or a complete collaboration product migration.

Completion retains actual child history references and a separate `no_changes` code result. A
read-only textual report is a successful result, not an empty code merge. Failed/cancelled tools
and empty textual completion are not converted to empty success. A very fast child may publish
its report before the parent's accepted call is consumed by its model exchange or policy graph.
The canonical `call_completion` retains the original acceptance while the existing external receipt
owner independently settles the child outcome. Recovery fills an unconsumed graph receipt from that
acceptance without another source pin, dispatch, preparation or model request.

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

Collaboration domain version 2 is required by the read-only existing-catalog preflight. An older,
missing or malformed domain is rejected before writable SQLite access or epoch advancement;
there is no schema upgrade, fallback registry, or asset reset. New empty catalogs create the domain
explicitly. Context scope uses the separate context domain version 3 contract.

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
bridge derives the fixed request head and original Operation identity from Catalog; model
arguments contain no owner/scope fields. Only admitted ordinary main Threads receive the schema,
and dispatch rechecks their persisted role and child relationship. Source-inheritance filters
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
