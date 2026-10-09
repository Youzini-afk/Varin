# Native thread Application Host consumer

`native-thread-adapter.ts` admits explicitly selected `nativeThread` identities through the
existing Application Host. It never creates, opens or writes a Pi session. Rust owns the
thread/branch, history, queue, Run, Operation and durable events. The Host holds no second
conversation store. `native-thread-routes.ts` uses the same authentication middleware as
other Application Host routes; `@varin/application-client` owns its framework-neutral API
and HTTP consumer, installed on Web RuntimeAPIs (including the Web surface in Electron).

Create accepts a stable client request key and derives a namespaced identity. Submit accepts
only a registered provider/model choice, text, expected head and an optional fixed source
selection. Model endpoints and secrets come from the existing credential authority. Source
selection does not grant capabilities: the Host validates its workspace and the kernel binds
fresh grants to the selected revision. Receipt acceptance is distinct from asynchronous
source materialization and execution. A preparation failure records a safe durable failure code and preparation Wait for explicit
resume; it is not reported as successful execution. Startup rebinds eligible saved launches
through the same current credential owner; an unresolved model/effect Wait remains blocked.

Observe installs a native notification listener before reading durable events. Presentation
progress is transient; replay reads committed events after the caller's cursor. Consumers
must preserve the last delivered durable cursor and reconnect after stream close, then
refresh snapshots after a progress sequence gap. A slow SSE socket is closed rather than
holding unbounded event buffers. Disconnect does not cancel accepted work. Run/Operation
cancellation returns the authority's actual cancellation/effect state; it does not fabricate
completion of background processes. Operation inspection exposes actual handoff/external
receipt facts.

The Agent workbench has an explicit nativeThread selector using the shared layout and Markdown
renderer. Its projection controller reconstructs durable history, queue and operation facts and
keeps transient progress separate. This is a vertical integration, not Pi parity. Default main-chat
cutover, full multimodal coverage, automatic context-budget policy, memory, questions, goal/schedule domains, MCP/extension routing,
remote environments, Pi asset import and final Pi removal still require their named owners.
Next-run admission uses the saved launch credential scope and the core environment-owner reference
to retain a materialized directory, rather than resetting files to the original source. Independent
verification owns the restart, source-continuity and HTTP acceptance evidence. No public model endpoint,
credential, grant or arbitrary kernel-method passthrough is accepted by these routes.

Initial input acceptance, source/credential selection and receipt are committed atomically by the
native submit-with-launch path. Successor input likewise inherits the nonsecret selection in its
admission transaction; Host restart reacquires current grants against that saved selection. These
recovery contracts require the independent crash/reopen evidence; they do not imply replay of
already-dispatched provider requests or unknown external effects.

Independent acceptance in `native-thread-http-review.native.test.ts` uses the public HTTP client,
authenticated Express routes, real kernel and loopback model service. It covers atomic initial
credential pinning, completed-submit retry without a second provider call, stable create retry,
history/SSE, mismatched thread/branch rejection, queued input edit/cancel, active cancellation and
credential-bound next-run completion. It uses fake credentials and proves no live-provider parity.

## Image input vertical

Native submit/enqueue accept the existing protocol `ImageAttachment` shape (`mimeType`, base64
`data`). The Host validates the HTTP media shape, supplies the `user-upload` source, and maps it
to native typed attachments. Images remain in the existing chunked conversation content store;
there is no second upload database. Image-only input has no artificial empty text block.
Text-only queue edits retain accepted images under the same revision CAS; an explicit images
array replaces/removes them. The shared browser file reader and attachment strip are used by
both the existing Pi composer and the native conversation.

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
`NativeThreadsAPI.historyPage(identity, {headId, beforeId})` exposes explicit earlier-page reads;
opaque provider material and image bytes are preserved in the hydrated native history items.

The Agent workbench's Load earlier history action pins its view to the returned head. Background
Run, input and operation facts remain live. New messages do not get silently concatenated into a
saved historical view; Show latest messages returns to the newest projection. Only pages the
user explicitly loads are retained for that historical view. Switching thread/Host invalidates
in-flight view requests. Active/indeterminate operation discovery comes from the native thread
query independently of the visible history page, so older background jobs do not disappear
just because their originating tool message scrolled outside the newest page.

## Conversation branching

The authenticated `fork` route accepts a native identity, an immutable ancestor and a stable
client request key. The Host derives the new branch identity; Rust validates the ancestry and
complete tool-call/result exchanges, and owns the idempotent branch creation. Retrying after the
branch advances still refers to its original creation, rather than comparing its mutable head.
The history UI offers this action in both the latest and head-pinned historical views and opens
the returned branch through the same native conversation projection. Failed/uncertain requests
retain their creation key; switching Host or conversation invalidates pending navigation.

This action is explicitly conversation-only. It preserves original history and opaque provider
items and the frozen system instructions/memory snapshot. It does not copy an active Run, process,
workspace/tool grant, model selection or conversation summary. A fork replays its original history
through the chosen cut, so a later summary cannot hide earlier messages. The UI explains this before creation and asks for a model on the new branch. Resource
forking and default main-chat replacement remain distinct work; no Pi session is created or used
as a fallback.


## Explicit context summary jobs

The native history UI can request a summary through a selected immutable message using the
registered model chosen in its composer. The Host resolves model configuration and credentials;
HTTP callers cannot supply a model endpoint, prompt recipe, memory checkpoint or tool binding.
The active native checkpoint supplies its existing effective prompt, instruction sources and
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

This is explicit user-triggered compaction, not automatic budget management, prompt/skill loading,
Agent memory CRUD, or parity with Pi context behavior. Source branches and ongoing runs remain
independent of the summary job; only a successful explicit publication changes later context views.


## Workspace source preparation

The native composer exposes `Prepare workspace`: select a Host workspace folder and either a
read-only file snapshot (read, directory listing and text search) or an isolated editable copy with file and process tools. The public
`source/prepare` route accepts the native conversation identity, a stable request key, folder path
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
snapshots remain rooted alongside the native conversation; native conversation deletion and source
release UI are not delivered by this preparation path. Remote environment mapping, dirty-buffer
capture and work-result integration retain their separate implementation requirements.


## Initial trusted context

Production Host admission resolves ordinary main-thread context through `native-thread-context.ts`.
It reads the existing `agent.personalization` catalog, applies the shared global → project → session
section rules, and renders the matching notes with the existing protocol renderer. Native session
scope uses the native thread ID; configured project membership is resolved by the Host from the admitted
workspace, never from renderer-supplied project/profile text. Bot personas remain a separate owner.

For a selected workspace, root `AGENTS.md` comes from its exact immutable WorkingState branch/revision
pin. The request records the workspace/branch/revision/root and file-object identity, including an
explicit absent-file identity. Symlinks, invalid text and unavailable content are not silently treated
as empty instructions. This slice does not load ancestor/nested instruction files, `SYSTEM.md`,
`APPEND_SYSTEM.md`, skills or Pi extension resources.

Rust commits the initial effective system prompt, instruction source identities and memory checkpoint
in the same transaction as the first admitted input and launch selection. Failed admission publishes
none of them. Replays keep the original checkpoint; later Runs and explicit compaction reuse it.
User messages remain user instructions, while generated summaries remain external data. Forks carry
the frozen system snapshot while replaying retained original conversation history. Context bodies
use the existing immutable content store and GC roots, not a second memory database.

This is a first-input snapshot. Memory/profile edits and workspace selections made afterward do not
replace that frozen prefix, including at explicit compaction. A new conversation captures current
notes and its selected workspace. Memory mutation delivery, snapshot refresh, native memory tools,
and dynamic instruction loading remain separate work; this is not full Pi context parity.

## Native user clarification

Ordinary native Runs include the built-in `native_ask_user` v1 tool, with a required `question`
and optional string `options`. It accepts a durable question Operation and returns a real job
acceptance, not an answer. The native policy parks on the matching existing Wait before another
model request. No Pi session, Promise-owned question store, or additional database is involved.
Compaction jobs do not receive this tool.

The authenticated `question/answer` route requires the explicit native thread/branch identity,
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
