# Thread Application Host consumer

`thread-adapter.ts` admits explicitly selected `agent` runtime identities through the
existing Application Host. It never creates, opens or writes a Pi session. Rust owns the
thread/branch, history, queue, Run, Operation and durable events. The Host holds no second
conversation store. `thread-routes.ts` uses the same authentication middleware as
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

Observe installs a notification listener before reading durable events. Presentation
progress is transient; replay reads committed events after the caller's cursor. Consumers
must preserve the last delivered durable cursor and reconnect after stream close, then
refresh snapshots after a progress sequence gap. A slow SSE socket is closed rather than
holding unbounded event buffers. Disconnect does not cancel accepted work. Run/Operation
cancellation returns the authority's actual cancellation/effect state; it does not fabricate
completion of background processes. Operation inspection exposes actual handoff/external
receipt facts.

The Agent workbench has an explicit thread selector using the shared layout and Markdown
renderer. Its projection controller reconstructs durable history, queue and operation facts and
keeps transient progress separate. This is a vertical integration, not Pi parity. Default main-chat
cutover, full multimodal coverage, calendar/general-event scheduling, remaining policy-origin domain
consumers, remote environments and the broader capabilities recorded in the runtime implementation
plan still require their named owners. Memory, questions, automatic summary preparation and bound
MCP/ordinary extension tools already have native paths; each retains its documented scope.
Next-run admission uses the saved launch credential scope and the core environment-owner reference
to retain a materialized directory, rather than resetting files to the original source. Independent
verification owns the restart, source-continuity and HTTP acceptance evidence. No public model endpoint,
credential, grant or arbitrary kernel-method passthrough is accepted by these routes.

Initial input acceptance, source/credential selection and receipt are committed atomically by the
submit-with-launch path. Successor input likewise inherits the nonsecret selection in its
admission transaction; Host restart reacquires current grants against that saved selection. These
recovery contracts require the independent crash/reopen evidence; they do not imply replay of
already-dispatched provider requests or unknown external effects.

Independent acceptance in `thread-http-review.native.test.ts` uses the public HTTP client,
authenticated Express routes, real kernel and loopback model service. It covers atomic initial
credential pinning, completed-submit retry without a second provider call, stable create retry,
history/SSE, mismatched thread/branch rejection, queued input edit/cancel, active cancellation and
credential-bound next-run completion. It uses fake credentials and proves no live-provider parity.

## Image input vertical

Submit/enqueue accept the existing protocol `ImageAttachment` shape (`mimeType`, base64
`data`). The Host validates the HTTP media shape, supplies the `user-upload` source, and maps it
to typed attachments. Images remain in the existing chunked conversation content store;
there is no second upload database. Image-only input has no artificial empty text block.
Text-only queue edits retain accepted images under the same revision CAS; an explicit images
array replaces/removes them. The shared browser file reader and attachment strip are used by
both the existing Pi composer and the conversation.

The trusted model catalog's image capability is frozen in model configuration. Known text-only
models reject image input before admission, including queued edits; provider-specific formats
still follow the actual serializer/remote API contract. PNG/JPEG/WebP, other formats, live-model
behavior and transport limits require their own evidence, not a universal image-support claim.
PDFs and arbitrary URLs/local/blob refs are not accepted as image substitutes.

This path uses the existing HTTP JSON policy (50MB) and framed kernel transport (16MiB). Size
errors retain the UI draft/images and surface an actionable error. Accumulated history is read through head-anchored reference pages and immutable body chunks,
so the Host does not ask one framed RPC to return the complete inline conversation. Individual
input uploads still use the existing request frame boundary. Streaming attachment uploads must
reuse the existing content/attachment authority when that path is implemented.


## Paged conversation projection

Snapshots hydrate the newest 20 history records using `history.page` references and the existing
immutable content chunk reader. Twenty is a display page size, not a conversation/input limit.
`ThreadsAPI.historyPage(identity, {headId, beforeId})` exposes explicit earlier-page reads;
opaque provider material and image bytes are preserved in the hydrated history items.

The Agent workbench's Load earlier history action pins its view to the returned head. Background
Run, input and operation facts remain live. New messages do not get silently concatenated into a
saved historical view; Show latest messages returns to the newest projection. Only pages the
user explicitly loads are retained for that historical view. Switching thread/Host invalidates
in-flight view requests. Active/indeterminate operation discovery comes from the thread
query independently of the visible history page, so older background jobs do not disappear
just because their originating tool message scrolled outside the newest page.

## Conversation branching

The authenticated `fork` route accepts a identity, an immutable ancestor and a stable
client request key. The Host derives the new branch identity; Rust validates the ancestry and
complete tool-call/result exchanges, and owns the idempotent branch creation. Retrying after the
branch advances still refers to its original creation, rather than comparing its mutable head.
The history UI offers this action in both the latest and head-pinned historical views and opens
the returned branch through the same conversation projection. Failed/uncertain requests
retain their creation key; switching Host or conversation invalidates pending navigation.

This action is explicitly conversation-only. It preserves original history and opaque provider
items and the frozen system instructions/memory snapshot. It does not copy an active Run, process,
workspace/tool grant, model selection or conversation summary. A fork replays its original history
through the chosen cut, so a later summary cannot hide earlier messages. The UI explains this before creation and asks for a model on the new branch. Resource
forking and default main-chat replacement remain distinct work; no Pi session is created or used
as a fallback.


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
substitute for those contracts or establish Pi parity. Source branches and ongoing runs remain
independent of the summary job; only a successful explicit publication changes later context views.


## Workspace source preparation

The composer exposes `Prepare workspace`: select a Host workspace folder and either a
read-only file snapshot (read, directory listing and text search) or an isolated editable copy with file and process tools. The public
`source/prepare` route accepts the conversation identity, a stable request key, folder path
and mode. The Host resolves and admits the folder through Documents, then uses the existing
KernelStorageAdapter WorkingState inventory/capture and branch creation. It returns real workspace,
branch and immutable baseline revision identities; the renderer does not invent them. Unsaved
Document Registry buffers are explicitly excluded from this saved-file preparation.

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
release UI are not delivered by this preparation path. Remote environment mapping, dirty-buffer
capture and work-result integration retain their separate implementation requirements.


## Initial trusted context

Production Host admission resolves ordinary main-thread context through `thread-context.ts`.
It reads the existing `agent.personalization` catalog, applies the shared global → project → session
section rules, and renders the matching notes with the existing protocol renderer. Session
scope uses the thread ID; configured project membership is resolved by the Host from the admitted
workspace, never from renderer-supplied project/profile text. Bot personas remain a separate owner.

For a selected workspace, root `AGENTS.md` comes from its exact immutable WorkingState branch/revision
pin. The request records the workspace/branch/revision/root and file-object identity, including an
explicit absent-file identity. Symlinks, invalid text and unavailable content are not silently treated
as empty instructions. This slice does not load ancestor/nested instruction files, `SYSTEM.md`,
`APPEND_SYSTEM.md`, skills or Pi extension resources.

Rust commits the initial effective system prompt, instruction source identities and memory checkpoint
in the same transaction as the first admitted input and launch selection. Failed admission publishes
none of them. Replays keep the admitted checkpoint; later Runs and explicit compaction use its
current committed revision.
User messages remain user instructions, while generated summaries remain external data. Forks carry
the frozen system snapshot while replaying retained original conversation history. Context bodies
use the existing immutable content store and GC roots, not a second memory database.

The checkpoint also records a typed personalization basis: original system sections, their immutable
instruction identities, and the Host-resolved project/thread scopes. The original sections
contain no note catalog. Committed profile/note changes re-render from this basis through the existing
personalization owner, so deleting the last note removes its memory sections and resetting an override
restores the real original section. A later workspace selection does not silently substitute a live
file or change the checkpoint's original scope.

The Host refreshes after committed personalization changes and before ordinary submit/enqueue, fork,
compaction and explicit resume. A post-admission check closes the race where an edit arrived before
the first checkpoint existed. Refresh reads are serialized per branch; failures remain visible and
later admission retries the authoritative read. The kernel CAS rejects stale revisions or changed
source/scope provenance and preserves the current summary, its through-message boundary, and tail.
Already prepared/dispatched ModelStep requests retain their recorded contents and bindings; only later
context compilation sees the new checkpoint. Compaction candidates based on a superseded checkpoint
cannot publish over it, and an explicit compaction request may need retry after a concurrent edit.

Refresh replaces the system snapshot at a committed context boundary. It does not claim Pi's
cache-prefix stability or its tail-message mutation-receipt algorithm. Memory tools, dynamic
workspace instruction reload, skills and Pi extension context remain separate work. Context without
a typed personalization basis cannot be live-refreshed; no inference/import from edited system text
is attempted.

## User clarification

Ordinary Runs include the built-in `ask_user` v1 tool, with a required `question`
and optional string `options`. It accepts a durable question Operation and returns a real job
acceptance, not an answer. The policy parks on the matching existing Wait before another
model request. No Pi session, Promise-owned question store, or additional database is involved.
Compaction jobs do not receive this tool.

The same operation/Wait path serves a model call or a policy tool-graph node. A policy can read
`question_status` for its accepted question in the same Run; only `answered` returns the original
user answer and history ID, while `awaiting_user` and `cancelled` remain distinct. Pending domain
Waits retain the policy's committed private state and original continuation. The UI and authenticated
answer route address the original operation directly and do not require a fabricated model request.

The authenticated `question/answer` route requires the explicit thread/branch identity,
`operationId` and nonempty `answer`. Rust accepts an answer only for the currently waiting question.
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

The authenticated `permission/decide` route checks the selected thread and branch and accepts only
`allow_once` or `deny` for that exact permission ID. The conversation UI shows the tool owner and
arguments with separate Allow once and Deny controls. The live authorizer awaits the decision
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

`thread-goals.ts` exposes start/update/control/list through authenticated Thread routes and the typed
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

`thread-goals.test.ts`, `thread-followups.test.ts` and `thread-continuation.test.ts` exercise the public
HTTP client, authenticated registered routes and actual launch-consumer logic with controlled RPC
facts. UI behavior tests cover retained drafts, conflicts, uncertain writes and late views. Native
Goal authority is separately exercised in Rust; these checks do not claim an unexecuted product
Host/kernel transport round trip. User acceptance precedes user-managed runtime cutover and asset
migration.
