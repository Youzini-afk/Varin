# Thread Application Host consumer

[thread-adapter.ts](thread-adapter.ts) admits native `agent` Thread identities through the Application Host. Rust owns the
thread/branch, history, queue, Run, Operation and durable events. The Host holds no second
conversation store. [thread-routes.ts](thread-routes.ts) uses the same authentication middleware as
other Application Host routes; `@varin/application-client` owns its framework-neutral API
and HTTP consumer, installed on Web RuntimeAPIs (including the Web surface in Electron).

Module and API names describe their domain. The engine discriminator is `agent`; Thread,
branch and plan records use their domain names directly.

Create accepts a stable client request key and derives a namespaced identity. Submit accepts
only a registered provider/model choice, text, expected head and an optional fixed source
selection. Model endpoints and secrets come from the existing credential authority. Source
selection does not grant capabilities: the Host validates its workspace and the kernel binds
fresh grants to the selected revision. Receipt acceptance is distinct from asynchronous
source materialization and execution. A preparation failure records a safe durable failure code and preparation Wait for explicit
resume; it is not reported as successful execution. Startup rebinds eligible saved launches
through the same current credential owner; an unresolved model/effect Wait remains blocked.

Observation uses the shared [Host event hub](event-hub.ts) and
[client bus](../../../../application-client/src/thread-observation.ts). The hub installs its native listener
before reading durable events; each client keeps its cursor, permissions and transient progress interests.
Initial connection readiness, reconnect or a sequence gap causes authoritative resync. Adding a view
updates interests without reconnecting and losing in-flight progress. Slow sockets close without holding
unbounded delivery buffers; lagging cursors replay from Catalog. Disconnect never cancels accepted work.
Run/Operation cancellation returns actual cancellation/effect state, not fabricated executor completion.
The full ownership and transport boundaries live in [Host adapters](DOCUMENTATION.md).

The product workbench and default main conversation use this native path. The projection controller
reconstructs durable history, queue and Operation facts while keeping transient progress separate.
Host/Thread/branch changes fence stale asynchronous results. The multiline composer, skills, editor
context, images and retained PDF attachments use this same admission boundary.

Next-run admission uses the saved launch credential scope and core environment-owner reference to
retain a materialized directory, rather than resetting it to the original source. Public requests
cannot supply arbitrary model endpoints, credentials, grants or kernel methods. A failed or unknown
multi-run submission retains its Thread and worktree for reconciliation instead of destructive rollback.

Initial input acceptance, source/credential selection and receipt are committed atomically by the
submit-with-launch path. Successor input likewise inherits the nonsecret selection in its
admission transaction; Host restart reacquires current grants against that saved selection. These
recovery contracts require the independent crash/reopen evidence; they do not imply replay of
already-dispatched provider requests or unknown external effects.

Independent acceptance in [thread-http-review.native.test.ts](thread-http-review.native.test.ts) uses the public HTTP client,
authenticated Express routes, real kernel and loopback model service. It covers atomic initial
credential pinning, completed-submit retry without a second provider call, stable create retry,
history/SSE, mismatched thread/branch rejection, queued input edit/cancel, active cancellation and
credential-bound next-run completion. It uses fake credentials and proves no live-provider parity.

## Research consumers

[research-runtime.ts](research-runtime.ts) connects the original Experiment/Source/Resource services to genuine Catalog
invocations. The same authenticated `/api/threads/research/*` routes expose the framework-neutral
`ThreadsAPI.research` to `ThreadConversation` and the shared Research facts view. Read scope is the actual task family; control remains the caller Thread
and its descendants. Changing a branch or source does not hide older independent jobs. Historical
read/control and admission of new work are separate decisions.

User submit/rerun carries a stable request ID and exact source selection into a genuine User
Operation. Ordinary Agent submit/observe uses the selected tool declaration and its real ModelStep
or policy origin. Domain acceptance, call completion and physical job terminal are different facts.
Catalog keeps the original domain association and immutable accepted content; ExperimentService
continues to own preparation, execution, cancellation, logs and artifacts. Reconnection reads those
original records rather than submitting another experiment. Research SSE events are invalidation
hints, not durable execution receipts.

The shared UI displays service-derived control permission, preserves rerun intent after an uncertain
response, pages original logs/artifact bytes and rejects stale results after identity changes.
Closing the view cancels observations only; it does not cancel independent experiments.

## Image input vertical

Submit/enqueue accept the existing protocol `ImageAttachment` shape (`mimeType`, base64
`data`). The Host validates the HTTP media shape, supplies the `user-upload` source, and maps it
to typed attachments. Images remain in the existing chunked conversation content store;
there is no second upload database. Image-only input has no artificial empty text block.
Text-only queue edits retain accepted images under the same revision CAS; an explicit images
array replaces/removes them. The shared browser file reader and attachment strip are used by
the native conversation composer.

The trusted model catalog's image capability is frozen in model configuration. Known text-only
models reject image input before admission, including queued edits; provider-specific formats
still follow the actual serializer/remote API contract. PNG/JPEG/WebP, other formats, live-model
behavior and transport limits require their own evidence, not a universal image-support claim.
PDFs and arbitrary URLs/local/blob refs are not accepted as image substitutes.

HTTP upload policy is owned by [Host assembly](../../index.ts). Private frame bounds constrain packets,
not total streamed content; [kernel transport](../../../../../kernel/README.md#transport-lifetime) streams
larger bodies through the same content authority. Size errors retain the UI draft/images. History is
head-anchored and paged rather than returned as one complete inline conversation. PDF attachments use
the scoped material path below.

## Retained PDF attachments

`ThreadsAPI.materials.upload` accepts the filename, PDF MIME type and original base64 bytes under a
validated Thread/branch identity. [web-runtime.ts](web-runtime.ts) checks the scope and bytes, then calls
`documentReader.ingest`; MaterialStore retains the original PDF and returns its fixed source snapshot.
The browser does not extract or replace its contents, and no new Rust PDF transport is introduced.

Submit, all three enqueue modes and child continuation retain that snapshot. The Host resolves each
`snapshotId` through the original scoped material owner and adds verified references to native input;
`document_read` reads the retained original later. The UI opens the same PDF reader and keeps the
captured snapshot across an unknown retry. A known non-admission can release the draft for editing.
Switching Host/Thread/branch or unmounting fences stale upload results.

## Paged conversation projection

Snapshots use one native `runtime.thread.view` read for a coherent current window and event cursor.
The display page default lives in [thread-adapter.ts](thread-adapter.ts), not a conversation/input limit.
A valid `afterHeadId` returns only appended history; a rewind, branch change or out-of-window anchor
returns a full window. Queue, operations, context and child facts remain current in either response.
Host consumer tests supply this native projection and verify scoped transport, cancellation and error preservation.
The Catalog thread-view tests exercise durable history and closed resource-observer reconstruction,
including original producer identity, branch isolation and missing versus corrupt optional records.

`ThreadsAPI.historyPage` reads explicit older pages through the existing immutable content reader,
retaining opaque provider material and image bytes. Load earlier history pins the returned head;
new messages do not silently enter that saved view. Show latest returns to the live projection.
Only requested pages are retained, and Host/Thread/branch changes fence late results. Active or
indeterminate operations are discovered independently of visible history, so old background work does
not disappear when its original message is outside the page.

[Projection](../../../../ui/src/lib/agent-runtime/thread-projection.ts) coalesces affected durable events
with at most one read and a trailing refresh, preserving unchanged object identities.
[Streaming state](../../../../ui/src/lib/agent-runtime/thread-streaming-store.ts) publishes per-request
text/thinking/tool deltas independently of that projection. Durable output clears only its matching
request; rendered historical rows do not rebuild for each live fragment.

## Conversation branching

The authenticated `fork` route accepts an identity, an immutable ancestor and a stable
client request key. The Host derives the new branch identity; Rust validates the ancestry and
complete tool-call/result exchanges, and owns the idempotent branch creation. Retrying after the
branch advances still refers to its original creation, rather than comparing its mutable head.
The history UI offers this action in both the latest and head-pinned historical views and opens
the returned branch through the same conversation projection. Failed/uncertain requests
retain their creation key; switching Host or conversation invalidates pending navigation.

This action is explicitly conversation-only. It preserves original history and opaque provider
items and the frozen system instructions/memory snapshot. It does not copy an active Run, process,
workspace/tool grant, model selection or conversation summary. A fork replays its original history
through the chosen cut, so a later summary cannot hide earlier messages. The UI explains this before creation and asks for a model on the new branch. Resource forking
retains its separate Source and resource authority.


## Explicit context summary jobs

The history UI can request a summary through a selected immutable message using the
registered model chosen in its composer. The Host resolves model configuration and credentials;
HTTP callers cannot supply a model endpoint, prompt recipe, memory checkpoint or tool binding.
The active checkpoint supplies its existing effective prompt, instruction sources and
memory reference. An uncertain retry keeps the job's original recipe even if a checkpoint was
published meanwhile. The core rejects stale checkpoint revisions and incomplete tool exchanges
before generation.

Summary generation is an ordinary authenticated Run on an isolated internal branch, with the
core's tool-free one-generation policy. Its durable job and state appear in the source branch's
snapshot after reconnect or reload. The UI exposes cancellation, explicit preparation resume,
and applying a successfully completed candidate. Publication uses the recorded checkpoint revision;
a candidate does not overwrite a newer checkpoint. Original conversation pages remain available.
The Host recovers eligible summary launches with their saved credential scope after validating
their source branch, and strips the core-owned recipe marker before comparing model configuration.
It does not retry unknown model effects or select a replacement paid model.

This section describes explicit user-triggered compaction. Automatic capacity preparation, frozen
instructions/skills and memory have their own owners and admission contracts; this route does not
substitute for those contracts. Source branches and ongoing runs remain
independent of the summary job; only a successful explicit publication changes later context views.


## Workspace source preparation

The composer exposes `Prepare workspace`: select this Host or a configured managed Host, then a
folder and fixed snapshot, isolated editable copy or live source. `source/resolve` performs the original
Documents resolution once; `source/prepare` accepts the frozen resource owner, workspace ID, stable
key, mode and explicit content selection. It never accepts a path alias as a second preparation route.
The selected Host uses its existing Documents and KernelStorageAdapter inventory/capture and branch
creation. It returns actual workspace, branch and immutable baseline revision identities. Local
snapshots can explicitly capture this window’s Document Registry drafts; managed and live sources
use saved target files. The selected owner stays attached to later Runs and does not follow sidebar
or connection changes.

Concurrent retries join the same preparation. A successful branch creation is its durable baseline
receipt at revision zero; a retry after completion or Host restart does not recapture changed files.
No separate source catalog or filesystem writer is introduced. Preparation is an explicit step before
message admission, with the UI reporting its actual pending state. The prepared source is attached
to the next acknowledged submit and then cleared from the draft, so later submits use the core's
source inheritance rather than resetting the materialized directory. An active Run keeps its own
source; a newly prepared selection cannot be silently discarded into queued input.

Editable copies are separate working directories, not security sandboxes, and commands may have
external effects. Changes are not automatically copied into the selected original folder. Source
snapshots remain rooted alongside the conversation; conversation deletion and source
release are separate resource operations. Managed file/process/query and child-result operations keep
that target Host throughout execution. Cross-Host recovery uses original participant plans and target
receipts; it does not claim cross-Host atomicity. See [managed Source consumers](DOCUMENTATION.md#managed-source-consumers).


## Initial trusted context

[thread-context.ts](thread-context.ts) resolves Host-owned global/project/Thread personalization and
[thread-resource-scope.ts](thread-resource-scope.ts) captures resources from the admitted Source.
Project membership is Host-derived, not renderer profile text; Bot personas retain their separate owner.
Fixed/live/managed Sources keep their original provenance, and resource reads retain their original grants.
Discovery and ancestry contracts live in [resource admission](../agent-resources/DOCUMENTATION.md).

Rust commits the initial effective prompt, instruction identities, typed personalization basis and memory
checkpoint atomically with input/launch admission. Failed admission publishes none; replay retains the
original checkpoint. User text remains instruction, generated summaries external data. Captured content
uses ContentStore, not another memory database.

Committed personalization changes re-render from the original typed basis, preserving source/scope,
summary boundary and tail. Deleting the last note or resetting an override removes it from the effective
prompt without guessing provenance from edited text. Refresh is serialized per branch, including a
post-admission check for concurrent first-input edits; failures remain visible and later admission retries.
Catalog CAS rejects stale candidates. Already dispatched model requests retain their original bytes;
only later compilation sees the new checkpoint. Compaction based on a superseded checkpoint must retry.
Detailed context composition and publication belong to [runtime](../../../../../docs/runtime.md#上下文准备与压缩).

## User clarification

Ordinary Runs include the built-in `ask_user` v1 tool, with a required `question`
and optional string `options`. It accepts a durable question Operation and returns a real job
acceptance, not an answer. The policy parks on the matching existing Wait before another
model request. No Promise-owned question store or additional database is involved.
Compaction jobs do not receive this tool.

The same operation/Wait path serves a model call or a policy tool-graph node. A policy can read
`question_status` for its accepted question in the same Run; only `answered` returns the original
user answer and history ID, while `awaiting_user` and `cancelled` remain distinct. Pending domain
Waits retain the policy's committed private state and original continuation. The UI and authenticated
answer route address the original operation directly and do not require a fabricated model request.

The authenticated `question/answer` route requires the explicit thread/branch identity,
`operationId` and the typed answer payload defined by [thread-routes.ts](thread-routes.ts). Rust accepts
an answer only for the currently waiting question.
The answer history item, terminal Operation, acknowledged Wait and runnable continuation commit
atomically. Identical answer retries return the same receipt; different or late cancelled answers
conflict. Multiple questions are served sequentially through their own Waits. Source selection and
credential identity are rebound from the existing launch record before continuation. Restart keeps
unanswered questions parked and answers available; a committed answer survives a failed launch.

The UI projects questions from Operations, allows suggested or free-text answers, and supports
cancellation. Cancelling an individual question records an explicit no-answer result and continues;
cancelling its Run closes its unanswered questions without resuming. Clarifications never grant,
expand or synthesize filesystem, process, network, or credential permissions. Permission prompting
remains a separate capability owner.

## MCP action permissions

MCP's shared Host owner evaluates the existing permission policy before external dispatch. An
`ask` decision opens a `permission:<nonce>` Wait on the already admitted tool Operation; it does
not call `ask_user`, create a model message, or introduce a second permissions database.
The persisted request binds the exact Run/request/operation/call/arguments, tool schema version,
MCP owner reference and generation, policy generation, credential actor, and execution epoch.

The authenticated `permission/decide` route checks the selected thread and branch and passes the explicit decision
for that exact permission ID to the [permission owner](../mcp/DOCUMENTATION.md). The conversation UI
shows the tool owner and arguments; persistent choices retain the same policy scope, not a blanket grant. The live authorizer awaits the decision
without a catalog lock or resource claim; it consumes an allow-once decision before returning to
dispatch. The MCP owner rechecks current owner and policy immediately at execution, failing closed
on changes rather than reopening a prompt while holding resource claims. One approval cannot
expand tool, file, process, network or credential authority or authorize a different call.

This is an Operation wait inside an executing batch, not a parked Run or an extra model turn.
Cancellation, owner loss and stale UI submissions cannot approve it. Restart invalidates all
nondispatched permission decisions and returns those Operations to admission; recovery must bind
fresh owners and evaluate current policy again. A Host map holds only live wakeup callbacks, never
policy or durable approval authority. Opened/decided/consumed events retain the decision audit.


## Continuing Goals

[thread-goals.ts](thread-goals.ts) exposes start/update/control/list through authenticated Thread routes and the typed
application client. Start checks the selected source Run; every mutation also validates Thread/branch
scope in the Catalog transaction. Objective and optional output-token budget remain separate from
ordinary message input. There is no Host Goal database, inferred authorization or timer.

Start/update return only their accepted identity/revision/generation/control. Control has the same
short receipt contract and never hydrates large objective/report bodies before pause/cancel. Snapshot
reads hydrate current Goals and select the displayed branch. `goal.run_ready` joins the existing
single-flight launch consumer; message/follow-up occurrence Runs use `ingress.run_ready`. Startup discovery
reuses saved launches and the same credential/preparation owner.

The shared Goal panel keeps unsaved drafts and their original editing revision across background
updates, offers explicit conflict review, and separates uncertain writes from accepted writes whose
subsequent refresh failed. An uncertain start retries its frozen key/objective/budget/source Run.
Switching conversation, branch or Host invalidates old asynchronous view results. Actual/estimated/
missing/pending usage and provider-specific token fields remain distinct; no synthetic monetary total
is shown. Complete/cancelled Goals retain their history; Goal-owned process continuations do not expose
independent controls that could bypass a Goal pause.

[thread-goals.test.ts](thread-goals.test.ts), [thread-followups.test.ts](thread-followups.test.ts) and [thread-continuation.test.ts](thread-continuation.test.ts) exercise the public
HTTP client, authenticated registered routes and actual launch-consumer logic with controlled RPC
facts. UI behavior tests cover retained drafts, conflicts, uncertain writes and late views. Native
Goal authority is separately exercised in Rust; these checks do not claim an unexecuted product
Host/kernel transport round trip. Historical assets are preserved without an automatic migration.
