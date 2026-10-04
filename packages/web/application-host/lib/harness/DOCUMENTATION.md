# Agent Harness — Host Side

The host-side harness provides task and resource services that the pi-host
agent tools call via the `HostServicesBridge`. All services are registered
on the `HarnessRouter` and dispatched from the broker event stream.

Attached Bot/research roots order request admission after their lifecycle changes, then release the
lifecycle queue while the Router executes the service. A slow handler must not serialize later tools or
the same session's compaction-worker queries. Cancellation still goes directly to the Router, and root
shutdown drains both lifecycle work and admitted requests.

Tool-set snapshots refresh grants for the same worker generation, including a work-focus change.
Registration keeps that worker's live shell and retrieval/input contexts; only a replacement generation
retires them. Pending first registration uses the latest grants received while settings are loading.

A session's project binding supplies organization and a default directory, not a filesystem
boundary. Bound and unbound sessions can read/write explicit external paths and execute with an
external `cwd` through the same path authority. External directories need no prior project
registration; Documents resource roots are internal addressing records. Explicit actor scopes,
Host deployment boundaries and normal operation permissions still apply. An explicit command cwd
does not change the session default. Native acceptance covers cross-root writes/rereads and a
permission-inspected external command followed by a command at the original default directory.

## Architecture

```
broker event stream ──→ HarnessRouter.processEvent()
                           ├── shell.exec   → ShellSupervisor (per-session framing over terminal runtime) + verification start/end
                           ├── shell.read   → ShellSupervisor observation (never a completion trigger)
                           ├── shell.write  → ShellSupervisor
                           ├── shell.kill   → ShellSupervisor
                           ├── output.store → OutputStore (global)
                           ├── output.read  → OutputStore
                           ├── search.content → HarnessSearchService (surface overlay or exclusive WorkingState corpus)
                           ├── document.readSource → fixed surface/working-branch bytes or Host-read authorized disk bytes
                           ├── document.surfaceWrite → shared plan: write the fixed Registry buffer or return the disk sentinel
                           ├── document.pathOverlay → surface merge paths or exclusive working-branch overlay
                           ├── explore.search → same query engine, algorithm-only facade
                           ├── explore.query.* → Host-owned short-lived query (start/plan/views/select/followup/finish/cancel/release)
                           ├── related.query → already-open KnowledgeStore (file-level topology; not lsp.references)
                           ├── fs.lock      → Rust kernel file-resource lease + Documents identity
                           ├── lsp.diagnostics → LspDiagnosticsService
                           ├── lsp.diagnosticsSnapshot → LspDiagnosticsService
                           ├── memory.* → shared MemoryService + scoped KnowledgeStore
                           ├── zone2.assemble → Knowledge material + ThreadRegistry projection + source-thread <review>
                           └── thread.*     → ThreadRegistry + ThreadRuntime + native working state + verification bind / auto review / retrieval facts
```

## Components

### Bot sleep and wake

`bots/bot-service.ts` stores sleep intent, interrupted Run identities, confirmed stop/resume steps,
remote machine progress and errors in the kernel-owned Bot profile. API calls return after intent
is durable; Host-owned work continues independently of an open renderer. Startup resumes unfinished
operations. An unsuccessful stop keeps execution admission closed and exposes its actual error.
Archive uses this operation and only hides the Bot after it is asleep; restore preserves sleep.

The registry gates creation, Run admission, worker publication, dequeue and lost-Run recovery by
the owning Bot scope. Broker execution leases recheck Bot state on every request, including reused
leases; the harness router rejects further tool calls. Due follow-ups retain their definitions while
asleep and reconcile on wake. Project-owned calendar schedules retain their project ownership.
Background memory inference is cancelled by scope and remains suspended until wake.

`bots/bot-lifecycle-runtime.ts` closes the entry and delegated workers, their local supervised shells,
and experiment attempts, retaining worktrees, transcripts and completed results. Managed remote shells
carry Host-derived owner scopes. The target persists its scope admission gate and confirms process-tree
termination through Rust before reporting success. Coordinator-side target receipts survive restart;
an unreachable target is an incomplete stop, never proof of termination.

VM shutdown follows confirmed work termination. It applies only to associated managed VMs without
other recorded work owners or human desktop control, and excludes the coordinator's own guest.
Both desktop associations and remote shell/experiment ownership participate in the sharing check.
ACPI request acceptance is distinct from observed `shutoff`; asynchronous polling has no invented
shutdown deadline and the UI offers explicit retry. This is graceful power-off with disks retained,
not an in-memory VM snapshot. Wake starts only VMs this operation stopped, waits for guest readiness,
then admits continuation. The saved operation/attempt identity deduplicates retries and restart;
completed work and independent user continuations are not replayed. Interrupted external side effects
are not undone: the continuation explicitly inspects current state before acting.

The authenticated UI can read `/api/harness/follow-ups` for the current Host's follow-up overview.
`FollowUpService.listForHost` enumerates the owning workspaces from the kernel and projects visible
definitions; internal composite leaves stay hidden. This read-only management method is not registered
as an Agent tool. The overview uses the same durable authority as per-session strips and does not reconcile
or trigger a model merely by being opened. Mutations still resolve the target session and retain the existing
ownership/revision checks. Temporary enumeration grants are revoked after the query.
Manual UI creation uses `POST /api/harness/sessions/:sessionId/follow-ups`; the Host derives the caller
from that session and ignores request-supplied ownership fields. Shared service validation checks the
trigger and resource scope before persisting it. The update endpoint also accepts a source replacement
with the existing revision check. Neither endpoint introduces a second scheduler or storage authority.

### Research root (`research-root-runtime.ts`, phase 7A)

The research work focus uses the user's existing Pi session and selected model. On a real
`agent_start`, `ResearchRootRuntime` attaches that session to a durable `research-root` Thread and a
new Run. It observes broker lifecycle events and records the actual report, transcript range and cost;
it does not create another model loop. The per-session event tail attaches the root before subsequent
dispatch requests resolve their parent. Root ownership is `attached-root`; ordinary child sessions are
`spawned-child`. Settling an attached root drops its live binding without a child-session tombstone,
and keeps its research branches and results. Child lifecycle code must not close the user's session.

The authenticated session thread projection returns `researchRoot` and `researchBranches` alongside
ordinary threads. User actions on a retained branch are authorized through its durable research-root
ancestry after the principal Run settles. Shell mounting is not an execution event. Capability, model,
tools and resources are frozen per Run; missing model slots are unavailable rather than silently
borrowed. Changing the worktree policy prepares the new Run through the fresh execution path, retaining
the requested continuation identity separately from the actual mode. Managed remote/Slurm adapters
and the full research evaluation remain separate delivery slices.

### Research execution and facts (7B–7F acceptance)

`research-access.ts` derives the model/UI caller from durable session bindings and actual Thread
relationships. Sharing a workspace does not authorize one root to inspect or cancel another root's
attempts. A user root can view its research tree; a worker sees its own related parent, siblings and
children. Read/resource/source capabilities do not grant experiment process control.

`experiments.ts` owns orchestration over kernel records and the backend contract. A spec keeps ordered
arguments and a fixed input root; an attempt owns an independent materialized directory under kernel
storage. `experiment-workspace.ts` captures and checks source bytes through Rust, includes ignored
files under the declared capture scope, excludes the kernel scan's `.git`/`.varin` metadata, and
rewrites internal absolute links to remain inside the captured tree. It does not promise an OS sandbox.
Capturing a large dependency/data tree has a real cost; spec reuse keeps the prior input root.
Submission cancellation reaches grant issuance, native inventory and file capture before an attempt
is admitted, including transport timeout cancellation. Shared startup reconciliation retains its own
lifetime while a cancelled caller stops waiting. Once the attempt intent is durable, its backend and
reconciliation continue to own the accepted outcome.

Machine capacity, observations and Varin commitments share a Host-level kernel catalog domain in
`resources.ts`. Reservations are serialized across owning workspaces and survive service recreation;
they do not claim OS isolation from external processes. Resource release can wake queued attempts in
other workspaces. Unknown CPU/GPU measurements remain unknown. `sources.ts` retains actual object
references; a path or URI locator alone is provenance, not proof that remote content was downloaded.

`experiment-routes.ts` exposes the same authorized facts to the research panel, including paged logs
and streamed artifact downloads. The model's `experiment(action:"artifact")` reads collected text by
byte page; binary bodies stay out of model text. UI refresh uses `/api/varin/events`, invalidates
older requests on session changes, and exposes failures without replacing them with empty facts.

Thread kill/delete closes the worker before stopping its independent attempts and reclaiming state.
Normal Run settlement and archive do not terminate an experiment. Host shutdown detaches observers;
the backend owns execution and reconnection facts. Backend uncertainty is not observed termination.
The local backend is implemented; registering another machine or testing an injected backend does
not provide a managed remote or Slurm implementation. Full desktop restart and real-model research
quality require their own evidence. D-301/7G request preparation and D-302/7H tool execution
use the shared context and shell paths described below.

### HarnessServiceHost (`service-host.ts`)

Global singleton that owns:
- `OutputStore` — large output storage with per-session isolation
- `ObservationCursorStore` — per-observer shell/diagnostics/thread baselines with prepare/commit delivery CAS, reset by compaction
- `PathLockService` contract — production injects `KernelPathLockService`, which maps the already-authorized Documents resource to Rust `file.lease.*`; the in-process implementation remains a unit-test helper only
- `HarnessSearchService` — wraps `createWorkspaceContentSearch`
- `DiagnosticsProvider` — LSP diagnostics (optional)
- Per-session `ShellSupervisor` registry

### HarnessRouter (`router.ts`)

Embedding, reranking and fast decisions resolve operation-specific provider capabilities in Pi.
Their connection/credential defaults and model declarations are independent of the native chat API;
the Host receives only frozen, credential-free bindings. User/operator metadata can override the
operation's address, path and credential owner; project configuration cannot redirect background
inference. Declared models are picker suggestions, and explicit undiscovered IDs remain usable.
See [the provider contract](../../../../pi-host/src/PROVIDERS.md) for storage, precedence and disable behavior.

`web.search` has a Host-owned keyless default (D-289): Exa MCP, then Parallel only on failure.
`web-search.ts` owns direct HTTP/SSE tool calls and normalized source results; no MCP subprocess or
model credentials are involved. Explicit providers retain their own credential contract and never
silently switch to the free route. Settings bind the choice per worker generation; malformed explicit
settings stay unavailable. Final domain filtering applies to all providers, and an empty allow set
makes no network request. A valid empty response is distinct from transport/protocol failure. Default
failover reports its actual provider and cause; cancellation stops the chain. Search snippets are
discovery material, while the existing `web.fetch` service remains the original-page authority.

`research.search` is the D-315 scholarly adapter. It is a Host-owned, read-only service over
OpenAlex and Semantic Scholar with `search`, `paper`, and `relations` actions; relation expansion
(references/citations/related) is server-paginated through provider-minted cursors and keeps the
relation source identity on every edge. Returned records retain provider identity, DOI/author
metadata, optional abstract and open-access URL, and a `content` state (`metadata-only` or
`open-location`). The adapter does not claim that metadata is paper content, does not merge works
on title similarity alone, does not build a global citation graph, and returns provider errors and
empty results distinctly.

`web.fetch` pins fetched bodies as `web.snapshot` kernel records (`web-materials.ts`): content-hash
deduplicated bodies, explicit `refresh` minting a new snapshot id, snapshot-id rereads re-checking
the current domain policy under the caller's authority, and per-waiter cancellation over shared
in-flight requests. Structured reading exposes line ranges and, where the parser supports them,
pages/headings/tables/figures; unsupported aspects report under `unparsed` rather than fabricating
positions. `materials.collections` owns `material.collection` records (snapshot/URL/paper member
references, collection-scoped keyword search, `persisted` workspace-readable sets) and the
`material.grant` records behind `share` — an explicit cross-thread read grant that reuses the
`thread.send` same-root relation rule and releases with the sender's thread. Grants let the
receiver reread under its own session/thread authority; they never transfer the sender's receipts.

Ordinary sessions own materials without a Thread/Run binding. Kernel record responses omit
absent optional identities; JSON null is not a thread owner. Missing/released or unauthorized
snapshots remain unavailable; malformed metadata, missing blob references and storage failures
propagate as failures, including through both web and PDF readers.

Harness deadline/cancellation diagnostics record the request method, admission/service/response
phase, elapsed time, service completion and pending storage method counts. They contain no tool
arguments or material contents. A late completion is recorded separately. Worker response rejection
aborts deferred observation delivery, so a timed-out consumer cannot advance unseen context cursors.

`egress.ts` is the executing Host's shared outbound path for `web.fetch`, Web search and scholarly
search. Harness → Web exposes this Host's `outboundNetwork` setting. Desktop `auto` uses an
isolated Electron network session when no Host environment proxy is configured, so the operating
system owns proxy/PAC, DNS, and virtual-network routing. An explicit HTTP(S) proxy or Host
environment proxy uses the shared CONNECT path; `direct` bypasses proxies. Desktop requests may
intentionally reach local services, while non-desktop Hosts retain connect-time private-address
checks. This boundary depends on the executing Host, never on a machine-specific fake-IP range.
The proxy origin lives in Host settings; authentication lives separately in the Host's Pi auth owner and is
bound to the selected endpoint. Requests freeze their configuration, inspect redirect targets on
every hop, and report whether DNS was local or proxy-side without exposing credentials.

`context.discover` scans only roots the session can already access. The Agent may give an explicit
start path or continue an incomplete scan with the Host-signed cursor; each page reauthorizes
its pending directories. The per-page time budget yields a continuation instead of discarding
deep projects, and an authorized directory that cannot be read is listed under
`unreadablePaths` rather than counted as scanned. Project discovery does not change permissions,
the operation directory, or the query scope.

### PDF material reading (`document-reading.ts`, `material-read-service.ts`, `pdf-engine.ts`)

`document_read(path)` resolves a local path through the Host Documents/scope authority and ingests its
original bytes before probing. `document_read(snapshot_id)` reads an existing web or material snapshot
under the caller's authority. Both call `materials.read`; network `web.fetch` stores PDF source bytes in
the same material store before it asks the reader to inspect them. The source object uses
`representation: "pdf-source-v1"`; `document.source.contentHash` / `sourceHash` identifies the original
PDF bytes, while the current readable snapshot's `contentHash` identifies its body. A derived view's
`document.sourceSnapshotId` points back to the original for provenance. Subsequent reads use the current
result's `snapshot.snapshotId`, not `sourceSnapshotId`.

The four views do separate work:

- `overview` returns source hash, source snapshot id, page count and rotated page geometry when probing
  succeeds, plus `textStatus`; opening the original does not require full-text extraction.
- `text` extracts PDF.js text for selected or all pages and can return page boundaries and literal find
  hits. A text failure is represented separately from an unavailable original.
- `page-image` uses packaged `pdfjs-dist` and `@napi-rs/canvas` to render actual PNG bytes, optionally at
  a scale and normalized region. It does not require OCR or structural analysis, and does not use Poppler.
- `structure` runs a native layout/text analysis or an explicit Docling analysis over the requested pages;
  `ocr: true` separately requests Tesseract for selected pages. Only returned structures are exposed.
  Unsupported, unavailable, missing, and failed results remain distinct from empty content.

`WebDocumentRegion` coordinates are normalized `0..1` on the rotated page with a top-left origin, so a
crop is stable across render scales. `sourceHash + page + region` anchors the original image. A derived
`DocumentAnalysis` carries its own `id`, source hash, parser, actual parser `version`, selected pages, OCR
choice, and status; layout/elements carry that `analysisId`. Parser/config/page-set changes create a new
analysis identity without changing the original-page anchor. Docling's CLI parser version and output
JSON `schemaVersion` are separate fields. A PDF-page link does not need an analysis version when it only
references the original pixels.

The built-in engine path is PDF.js + Canvas. Docling and Tesseract are optional Host-managed processes,
not automatically installed. Trusted user settings `harness.documentReading.doclingCommand`,
`tesseractCommand`, and `ocrLanguage` default to `docling`, `tesseract`, and `eng`; blank values restore
those defaults. Host passes the configured executable and language to the managed process boundary;
these strings are executable names/paths, never shell command text. If a runner or configured executable
is unavailable, the requested operation reports that state. It does not silently claim an installation
or substitute a different parser.

The authenticated reader routes use the same material identity: POST
`/api/harness/sessions/:sessionId/materials/read` selects a view, and GET
`/api/harness/sessions/:sessionId/materials/:snapshotId/page?page=&scale=` returns a rendered PNG.
`varin-material://` UI references resolve to the current readable snapshot, page, optional normalized
region, and optional analysis id. `sourceSnapshotId` remains provenance, not a request locator. Parser
availability does not establish OCR/table/formula quality, cross-platform behavior, or full-package
validation.

`research.decide` (`research-decide.ts`) is the D-315 fast-decision consumer: callers submit real
candidates (URLs, snapshots, paper identities, snapshot sections, or new query text) with a goal and
a judgment kind (`relevance`/`reading-value`/`complementary`/`duplicate`/`continuation`/`next`).
The service resolves the `web`/`scholarly` purpose binding through `fastDecisionStatus`, freezes
`configurationId` for the call, validates snapshot candidates by actually reading them under the
caller's authority, and maps answers to ranked results. Disabled, unconfigured, unavailable,
failed, and cancelled states return honestly with the caller's order preserved (`fallback:"order"`);
missing answers are reported, never zero.

Consumes `harness.request` events from the broker stream and dispatches
to registered services. Responds via `harness.respond` on the broker. The
broker-pinned Actor must match the Host session registry and carry the method's
frozen capability. Path-bearing methods are resolved through Documents and, for
a restricted child Run, must also remain inside its scope.

### Shell discovery (`shell-discovery.ts`)

Host-owned, machine-level discovery. Production `index.ts` calls `discoverShells()`
once when constructing `HarnessServiceHost`. The same Windows program roots used
by Git binary resolution (`ProgramFiles`, `ProgramFiles(x86)`, `LocalAppData`)
plus PATH and an already-resolved `git.exe` home are searched. When both
`Git\bin\bash.exe` and `Git\usr\bin\bash.exe` exist, the Host records the
`usr\bin` executable so the `bin` launcher is not spawned. Missing Git Bash is
reported as such; a present install is not.

`harness.shell` is not a Host-wide freeze. `index.ts` reads the session's Pi
`settings.get` snapshot (user file + trusted project) at session register and
passes that workspace's setting into `registerSession`. A running PTY is not
hot-swapped; a later session or worker generation registers again. Two
workspaces therefore cannot inherit each other's interpreter.
`session-registration.ts` coalesces initialization by broker actor generation.
The Router waits for its generation; close/replacement cancels old initialization,
and late settings cannot restore an obsolete actor. Missing settings produce an
unavailable interpreter rather than silently selecting `auto`.

### ShellSupervisor (`shell-supervisor.ts`)

PTY-based persistent shell per session. Production creates those PTYs through
the terminal runtime (`createTerminalSession`); tests may inject a `ptyProvider`
seam that wraps the same handle contract. There is not a second production
process manager.

- One login shell (git-bash / bash / wsl / powershell) per session
- Commands separated by sentinel markers (`__VARIN_SENTINEL_`)
- cwd/env/venv maintained between commands
- `wait_ms` starts when the Host accepts the call and includes shell setup and
  the foreground observation. If it expires before a PTY is ready, `shell.exec`
  returns `kind: "preparing"` with an `exec_…` identity for read-only
  `get_output`; that identity is not a runtime shell and cannot be written to or
  killed. Once a PTY exists, an active command returns `kind: "background"`
  with its real `sh_N` identity; the next foreground command starts a new shell
- User attach and agent `get_output` / `write_to_process` use that same session
- Owner, creation source, cwd, shell/spawn, writer, and retain identity must all
  match before an existing running handle can be reused. HTTP cannot claim a
  programmatic Harness id, and exited ids require explicit close before reuse.
- Closing a terminal tab detaches only; `kill_shell` / force-kill / dispose
  still wait for real process exit before releasing writers (D-204 / D-205 / D-206 / D-209)
- `registerWriter` callback for `mode: 'process'` writer registration
- Interpreter command is the discovered executable path, including spaces
- PowerShell starts interactively under ConPTY with its own readiness/command wrappers.
- Interrupt delivery does not mark a command exited. Shutdown waits for PTY exit
  and writer release; a failed stop remains observable and retryable. ServiceHost
  retains retiring supervisors after a session drop, and thread close awaits them.
- Background completion is emitted once by PTY exit even when no caller reads
  output. A failed writer release keeps directory protection and is retried by
  disposal instead of being treated as a completed cleanup.
- Shell start/completion enter the workspace Knowledge event owner. `follow_up`
  may bind the returned executionId to exit/status/output-match conditions;
  streamed output remains in the terminal/output owner and only compact match
  and cursor observations are persisted. A Host restart that cannot reattach a
  still-running local PTY marks that source unavailable.
- `waitMs: 0` can return `preparing` before the terminal runtime accepts a
  payload, or `background` with a real `sh_N` if startup completed first. The
  stable `exec_…` reference is queryable during preparation; only a returned
  runtime shell id supports stdin or termination. The foreground wait has no
  process-kill meaning. The default is the session-resolved 10-second soft
  setting, chosen from focused-check versus package-typecheck timings observed
  during 7H and still configurable per workspace. Timing reports accepted,
  sent, first output, detached, exited, and responded stages.
- An explicitly longer `shell.exec` or `shell.read` wait is not shortened by
  the generic one-hour Harness RPC ceiling. The requested wait owns its
  deadline; cancellation and actor disposal still end the observation.
- `shell.read(waitMs)` waits on output/exit events only when an incremental read
  has no unread bytes. Explicit byte slices and static outputs remain immediate.
  Request cancellation removes the observer without terminating the process;
  `shell.write` and `shell.kill` do not share the observation wait and remain usable.
- `shell.exec.toolCallId` and the generated `exec_…` reference resolve to one
  idempotent acceptance record inside the current Host session. Repeating the
  same tool call and command returns the existing foreground response; `shell.read`
  can resolve its execution reference to the preparation state, real `sh_N`, or
  completed output. A command mismatch is rejected. This in-memory map does not
  claim restart durability: old `exec_…` / `sh_N` references report unavailable,
  while paged `out_…` bodies remain Host-ephemeral and report expired after Host
  replacement, session drop, or FIFO eviction.

### OutputStore (`output-store.ts`)

Stores large tool outputs (default 256 MiB per session) with handle-based
retrieval. Handles are `out_XXX` format.
These are authenticated session-local ephemeral references, not durable files or knowledge records.

### Shell output organization (`output-organize/`)

Default `bash` / incremental `get_output` display for vitest, tsc, eslint, and
git (D-197). Full UTF-8 bytes stay in the supervisor buffer or OutputStore.
Explicit `offset`/`length` remains raw. The generic `tool_result` head/tail cut
does not run on `bash` or `get_output`.

### PathLockService (`path-lock.ts`)

The Host first resolves every input through Documents identity, deduplicates
aliases, and acquires the complete path batch in canonical order. The returned
opaque lease IDs are owner-bound. This coordinates Harness-managed writes in
one Application Host; it does not claim to lock terminals, Git, external
processes, or a second Host.

### ThreadRegistry / ThreadRuntime

Native built-in profiles keep optional user customizations in `harness.models[role].agent`; custom
profiles use `harness.agents`. The protocol resolver supplies the same effective names, instructions,
tools, worktree and model parameters to the catalog, ordinary dispatch and research routing.
Review agents are dispatched on demand through that same path; publishing a result never schedules
another review or establishes a review gate. A dispatch copies the profile into the launch manifest and Run snapshot. Temperature/thinking
settings travel through the existing session adapter and broker on create/open, including dequeue,
restore and continuation. Pi records them in a branch custom entry and applies temperature through
its native stream seam; no alternate model loop or provider registry is involved.

The registry persists one versioned atomic catalog per workspace. `Thread` is
durable work; `ThreadRun` is one execution attempt, and
`ThreadLaunchManifest` freezes model-adjacent launch inputs. Isolated `dispatch`
creates the Thread, then captures the disk baseline and WorkingBranch before it
returns — including queued threads. Git inventory failures, capture-window parent
writes, active Documents writers, and gitlinks fail the dispatch instead of
inventing a complete branch. Capture failure or cancellation deletes the
Thread. `dispatch` then commits a `starting` Run and returns immediately. The
runtime later opens a real persisted Pi child session with the preset's or
inherited active-tool allowlist, and projects broker events into
progress, attention, report, durable transcript, integration, and verification
state. A child session whose frozen allowlist includes nest tools can dispatch
again: the Host resolves `parent.kind: "thread"`, narrows scope/permissions, and
copies the parent branch view (or materialized directory) as the grandchild
baseline. The frozen permission overlay is passed through `session.create/open`
and can only be tightened by later live settings. Nested merge writes the
grandchild result onto that parent authority — directory apply keeps recovery
objects in the owning object library, branch apply is a durable Integration —
before the parent result reaches the workspace. Killing or archiving a parent
walks descendants in stable createdAt/id post-order and enters each child's own
lifecycle serialization; restore is refused while an ancestor is archived or the
cascade is in progress. Scope rejects a complete `..` segment, absolute paths,
and drive-letter paths, not names such as `src/foo..bar`. Sibling threads may
exchange directed messages inside their root task (below); they still cannot
read each other's transcripts or control each other's Runs, and the root
session list and Zone 2 projection stay on direct children. After a successful publish, only same-Run observations whose start/end
identity matches the fixed result are bound to that `resultRevision`. The
result is available to the caller without creating another review Thread.
Draft merge records that disk commands cannot verify unsaved buffers.

`thread.dispatch` also freezes the Host-confirmed parent operation directory and query scope
before its first asynchronous step. The launch manifest carries that snapshot through queueing
and restart; spawn maps it only to a child authority with a proven source/clone relationship and
writes the child's own Pi work-context journal before its first model or tool request. A narrowed
scope that excludes the inherited paths, or a virtual parent that cannot materialize a selected
subdirectory, fails explicitly. Later parent and child switches remain independent.

Input origins are frozen per Run (`task`/`inherit`/`continue`/`fresh`). An
`input: "inherit"` dispatch captures the parent session's committed input at
dispatch time through `threadCaptureInputContext` — the last compaction summary
plus the raw committed entries kept after it, rendered bounded — persists it on
the manifest, and renders it in the child's initial prompt; a queued Thread
never re-reads later parent state.
The capture now comes from Pi's actual active context, preserving legal tool-call/result pairs, images and copied durable output bodies while excluding unfinished calls and future parent appends. A `fresh` Run gets a new session; its `history(run)` source is authorized only to retained Runs of that same Thread. Spawn, dequeue, lost resume, restore and continuation consume the new Run's frozen model/tools/permissions/scope rather than reconstructing them from long-lived Thread fields.

`thread.send` carries directed messages inside one root task (3.18C). Reachable
targets are relationship-bound: a Thread caller reaches its children, its
parent (`to: "parent"` resolves the parent Thread or session), and same-parent
siblings; a session caller reaches its direct children; cross-root and
unrelated targets are denied. `inform` only delivers — to a running session it
lands at the next input boundary, to a waiting target it stays `held`, and to a
settled or queued Thread it is recorded durably for the next Run's input; it
never starts execution. `request` asks for execution: on a waiting target it
delivers and clears the wait, on a settled implementation Thread it calls
`threadContinueRun` to start a new Run — `continue` reopens the retained
session and prompts the new task, `fresh` reads the closed transcript through
`sessions.readEntries` (`previewSessionEntries`), assembles a rebuilt input via
`assembleFreshInput`, and spawns a new session on the retained worktree. A
request on an active Thread delivers like inform and never starts a second
Run. Messages persist as `in`/`out` records on the Thread; `requestId` makes
retries observe the recorded outcome instead of duplicating delivery or
execution, and `replyTo` resolves both ledgers and clears the requester's
`waitingFor: "thread"` mark.
Pi accepts `inform` through a persistent non-waking custom message and accepts `request` through an idempotent native execution receipt. Host commits delivery only after that input boundary accepts it; failed delivery cannot resolve a dependency. The authenticated UI and Pi tools use the same message service and stable request identity.

Execution admission is root-wide (`countActiveInRoot`): every implementation
Run under the same root session — including nested Threads — shares the
configured concurrency budget, and dispatch, dequeue, lost-run resume,
continuations, and auto-review all pass through the same count. A Thread
waiting on a real dependency (`waitingFor: "thread"`) relinquishes its slot;
`setAttention` and `endRun` re-evaluate `tryDequeue`, which promotes the oldest
queued Thread or parked `pendingContinuation` in FIFO order. A `request` that
arrives while the budget is full parks on the Thread as `pendingContinuation`
(`delivery: "scheduled"`) and promotes through the same gate when a slot
frees. `onAdmissionFreed` drives the deferred lost-run resume recheck, and a
`wait` blocked on dependencies marks the same yield before subscribing — the
mark itself never wakes the waiter — then re-admits the slot when it returns.

`retrieval` is a Thread preset, not a second explore tool. `thread.dispatch`
freezes the retrieval model slot, read-only allowlist, and scope, and does not
copy parent blocks. The child delivers facts only through `submit_facts` →
`thread.facts.set`. Host checks local paths and compact line ranges against
Documents and the frozen scope, then marks sources source-checked. It does not
prove a claim is true and does not infer completeness from empty unknowns.
Oversized excerpts and child output handles are copied to durable artifacts.
URL sources require a Host receipt bound to the exact final URL and authenticated
owning workspace/session/thread/Run; ordinary webfetch does not mint one. Temporary
artifact and receipt references exist before catalog promotion and are transferred
or released transactionally. Pending evidence is bound to the active `runId`.
Nested retrieval dispatches onto a normal isolated branch, whose scratch path and
adjacent staging/result paths must stay below a persistent Host/backend-authorized
`managedRoot`. It may materialize read-only input for LSP, but settle never publishes
directory changes. Sealed `report.evidence` is visible through wait / UTF-8 byte-paged
`read_thread` / Zone 2. Lost keeps pending evidence until the existing
resume path starts a new Run. The report has no recommendation or priority
fields. Unconfigured `models.retrievalAgent` omits the preset and Host rejects a
retrieval dispatch that has no model.

One unexpected worker exit is resumed in the same session/worktree as a new
Run; a second consecutive crash becomes `stalled` instead of entering a crash
loop. Interactive child prompts, event silence, and six identical tool
signatures project to `permission`/`user`, `stalled`, and `looping`. The Web UI
reads the same registry through `/api/harness/threads` and SSE; the Pi Fleet
registry exposes it through the `varin-harness` provider.

### VerificationCoordinator (`verification-coordinator.ts`)

Session-scoped command observations bind the authority instance, worker
generation, Run, and binding generation at start and recheck them at completion.
Production `shell.exec` records both boundaries; PTY exit completes background
commands independently of `shell.read`. Git inputs use a base/HEAD seed plus the
states of changed and explicitly captured paths, avoiding a per-command full-tree
scan; non-Git inputs remain `uncertain`. Publication consumes eligible observations
once. A fully applied parent merge opens a persisted window keyed by operation,
result revision, and exact parent session; draft-unsaved and incomplete merge
states do not. Review records additionally bind review thread and review Run.


### HarnessSearchService (`search-service.ts`)

Wraps the native workspace/WorkingState compute boundary with hit grouping,
scoring, and formatting. It intersects an explicit request path with the actor
or child scope before dispatch and validates returned resource IDs again.
Root-session search uses the Host-admitted live root plus Registry-owned fixed
draft/tombstone overlays; an isolated Thread uses a `WorkingBranchQuerySnapshot`
whose `search`/`compute` operations remain bound to one immutable pin. There is
no branch corpus/body mirror and no Host ripgrep fallback. Returns
`SearchContentResult` with files, hits, and totals. Regex/fixed/case/glob
semantics, result limits, and context lines are evaluated against the same
native source revision; live-source drift becomes partial/failure evidence
instead of attaching unrelated lines.

### Native read source (`document.readSource`, pi-host `read-tool.ts`)

The Router authorizes the requested path with `allowMissing` so an unsaved new
document can be read. Documents selects fixed surface/WorkingBranch bytes or disk.
For disk, the Host rechecks the authorized canonical target, opens one file handle, reads from
that handle, and checks its identity and the request path again before returning bytes; Pi never
reopens the original path. The normalized path identity is for comparisons and locks; the Host
opens the separately retained, case-preserving resolved path so a Windows case-sensitive
directory cannot redirect `A` to `a`. The Pi wrapper sends its line range and existing Pi
display budget to the Host. `read-page.ts` scans bounded byte chunks and stops after the requested
page; it does not count the remaining lines or encode the whole text file. Binary signatures and
unsupported encodings return a type result before whole-file decoding. Long single lines retain
Pi's output-size boundary without allocating that line. Supported images keep native Pi processing.
Virtual branches hold one native pin while paging object slices; surface drafts page their existing
immutable text; materialized aliases revalidate the owned child target. Disk identity also checks
size and timestamps to reject in-place changes during a read. `apply_patch`
uses the same Host-returned disk bytes for its patch base and conditional hash. This rejects the
tested original-path and parent-junction replacement races; Node has no cross-platform
directory-handle-relative open here, so it is not a proof against every adversarial ABA swap.
The wrapper is registered only when the Host handshake advertises `harnessDocumentRead`.
An isolated Thread Run bound to a WorkingBranch never returns disk bytes
for these tools: `read` / `grep` / `find` / `ls` / `explore` consume
the pinned native fixed view (`base ∪ delta`) with tombstones hidden before
candidate selection, and provenance names the branch, revision, and origin.
`find`/`ls` use native inventory, `grep` uses native search, and structure/chunk
requests execute against that same pin. Missing branch content stays
unavailable; none of these operations may fall back to the parent live tree.

The fixed draft is one turn's input, not a standing authority. A confirmed Host-backed disk write
supersedes that path so later read/search/enumeration/navigation/dispatch return to disk (D-088).
Varin-mode Pi mutation tools do not maintain a second worker-local disk journal/writer. A root-session write
whose path is still owned by this turn's snapshot goes through `document.surfaceWrite`
instead: matching uses the fixed text, the live Registry buffer is updated in
place, and later read/edit in the same turn see the new buffer (D-225). A later
user edit is a conflict; compensation is conditional and must not overwrite that
newer buffer. `agentInputDraftPaths` reports the dirty paths the fixed source
still owns; an expired capture keeps every dirty path there and never degrades
into a silent disk read. Shell and external writes stay unobserved, the same
boundary the recovery journal reports.

### Native surface write (`document.surfaceWrite`)

`write` / `edit` / `apply_patch` share one Host plan after `document.branchWrite`
returns the disk sentinel. Snapshot-owned paths write the Document Registry buffer through
`requestSurfaceOperation`; unowned disk targets stay in the same Host plan and are applied by
Documents through the Rust file-resource backend. Varin does not hand those targets back to a
worker-local writer. Mixed `apply_patch` batches classify each path, persist `targetKinds`, and under
one Rust resource lease validate every disk identity before dispatching a surface write. The typed
recovery operation records external dispatch, compensation intent and observed Registry receipts;
Rust file operations separately persist filesystem intent before their side effects and reconcile a
started operation after kernel restart. Compensation remains conditional (`applied` / `conflict` /
`compensated` / `needs-attention`) and never overwrites a later user edit. An explicit failed surface
receipt proves that path was not applied; a dispatched request without a valid receipt is uncertain.
Delete, NUL bytes, and other states a text buffer cannot express are `unavailable` to the Registry
surface path, while supported disk states remain kernel file-resource operations.

### Native find/ls path overlay (`document.pathOverlay`)

The Router authorizes the requested root with `allowMissing`, so a dirty-only
directory can be traversed. Documents validates the same session, workspace,
and ready surface snapshot before returning content-free entries relative to
that root. Each fixed file carries its surface revision; nested files also
produce virtual directory ancestors. `find` filters those entries with the
same picomatch basename/path semantics as `grep`, merges them with native fd
results before applying the user limit, and reuses Pi's own formatting and
50KB truncation. `ls` merges immediate disk and virtual children through Pi's
native definition. A covered disk path keeps the fixed snapshot's file or
directory type. Unrelated roots return the disk sentinel; an expired related
snapshot returns unavailable and never substitutes disk output. The snapshot
currently represents dirty text file existence only, so it has no deletion or
rename tombstones. A working-branch overlay is exclusive: find/ls do not merge
native disk, and tombstones hide files plus virtual ancestors.

### Explore (`explore-service.ts`, `explore.ts`, `explore-file-reader.ts`)

The Pi tool sends the question, optional literal `anchors`, and optional `paths` through the
normal actor-scoped router. `paths` accepts absolute or session-cwd-relative files/directories;
when present it confines the whole query, including anchor follow-ups. The visible result names
the resolved search scope. Without `paths`, an unbound session searches its cwd. `budgetMs`
controls the shared Host/Pi query deadline (default 120 seconds); expiry returns completed
material with an explicit budget note. `limit` is the excerpt count only, and the selection
model sees that limit before choosing groups. Rejected groups report the Host's reason.
Candidate fetch uses a separate
working budget (and an independent budget for anchors). Candidate mode assigns that budget
breadth-first: one hit per matching file, then another round, until `hitsPerFile` or the budget
is exhausted. A file with hits keeps at least one hit unless the file count itself exceeds the
budget; those omitted files are `filesDropped`, distinct from a hit-level `partial`. That count is
a floor: query terms and search roots match overlapping file sets, so the distinct union cannot be
recovered from per-query counts. Explore carries the largest single-query drop and the body says
"at least", rather than summing and claiming more files than were dropped. The tool schema accepts
blank anchors because the Host filters them and reports them in `details.anchors`; a stricter
schema would reject the whole call. Grep still
depth-first-truncates with `fileScore`. Term groups keep identifier variants, quoted literals,
and anchors together: variants expand matching, co-occurrence across groups raises rank, and
anchors/literals stay the most distinctive seeds without becoming a hard filter.
Search goes through `search-service` with `actor` and `inputContext` so dirty paths are excluded
before the backend counts hits; explore does not match drafts itself. Candidates are ranked from
hit metadata, then materialized on demand with bounded parallelism. Unread files are
`not-requested`, never `empty`. Packing prefers complementary windows across files, then applies
an explore byte budget below the generic 32 KiB truncation, including any `get_output` hint.
The resolved search-scope prefix is inside that budget. The body distinguishes prepared and
visible excerpt counts; `query.finish.snippets` describes the complete blocks actually delivered,
not every excerpt selected before packing. It first preserves the priority pack, then removes child
ranges whose exact text is already present in a delivered range of the same path, revision and source.
A child intersecting a parent's omitted interval, or a required child, is not deduplicated. Recovered space fills omitted blocks
without evicting the remaining priority pack. Actual byte omissions mark the result partial; covered
ranges are distinguished from byte omissions. Concurrent/repeated finish calls reuse the same pack and handle.
Provenance stays in `details`; the model-visible body is `path:start-end`, code, and actionable
gaps. OutputStore keeps the full pack plus unread-candidate refs, and the tool text mentions the
handle only when more content remains. Symbol expansion and optional model enrichment remain
separate planned sources.

`harness.codeRetrieval.decision` is frozen at query start. In `auto`, the configured explore LLM owns
joint selection and may plan searches; a ready fast-decision binding can independently own actions.
Without an LLM, fast decision owns material judgment, or a configured reranker ranks material;
without any model, source retrieval and deterministic packing still run. Explicit `llm`, `fast-decision`,
`rerank`, `source`, and purpose `off` keep their meanings. A failed provider does not start a cascade
of replacement paid requests. Embedding contributes an independent source. Rerank settings and the
fast-decision configuration identity stay fixed for this query.

`query.views({seen,inputBytes})` returns ready ranges, current sequence, pending work and actions;
it does not await all sources or structure. `query.wait({afterSequence})` registers a cancellable,
race-free progress waiter. `plan` and `followup` admit work asynchronously; `actionsAccepted` is not
an execution receipt. Fast-decision provenance counts completed operations separately. `select`
returns the actual retained ranges, including clipped range identities, for the next comparison.
Model bodies are not silently shortened to 8192 characters or a fixed 48 KiB page. Consumers page
using configured capacity; an oversized individual view remains identifiable and provider capacity
errors remain explicit.

The shared executor continues authorized reads while models judge an available batch. The public tool
waits for an in-flight decision before declaring the frontier quiet, allowing selected follow-ups to
execute. The decision loop includes retained evidence and keys action reuse on that context. No graph
is required for unread candidate reads, adjacent ranges, or literal names observed in source. Existing
graph facts add resolved relationship actions. `prepare-structure` explicitly requests optional cold
preparation; ordinary slices use warm structure. All actions remain scoped, version-bound and deduplicated.

The visible delivery planner accounts for scope, headers, source blocks and output handle. Required
members of a group (including overlapping groups) are delivered together or omitted together with a
reported gap. Invalid later selection retains the previous valid selection; an explicit valid empty
selection does not refill the answer with rejected hits. OutputStore is additional material, not a
continued-query capability. No new Agent thread or training dependency is introduced.

### Knowledge context runtime (`../knowledge/context-runtime.ts`)

The context runtime fans committed user-originated Documents changes, version-bound diagnostics, existing Git refreshes, and generation-tagged user-terminal commands to the Pi sessions that own that workspace. Harness writes do not masquerade as user edits. Agent shell completion is a separate source keyed by execution identity, projected as a short terminal fact and output reference. It is distinct from user-terminal history and from the shell output byte cursor; raw retained tool-result receipts suppress duplicate completion notices.

Before every model request, `zone2.assemble` prepares environment changes and new message/result material. `zone2.delivered` confirms their pending observation only after Pi has received a provider response start and retained the actual material in native history. A failed prepare or provider stream that fails before starting does not acknowledge delivery; retained receipts recover a lost ACK. Tool reads retain their own response-delivery cursors. Compaction and branch navigation derive retained receipts from native raw input, never from a ready summary candidate.

`zone2.status` separately returns the complete current authorized team on every request, including unchanged rows. Each progress excerpt cites its real completed visible paragraph and Run. The snapshot has no delivery cursor, does not consume directed messages or result bodies, and is never appended to Pi history. Empty scope and unavailable facts remain distinct. Pi accounts for both additions before capacity admission and rebuilds them after compaction.

Plans, user notes and accepted knowledge keep their existing authorities. `zone2-material.ts` compares revisions with retained Pi messages and only acknowledges fully represented sections. Knowledge identities include user/workspace scope; actual retirement/deletion is distinguished from a different retrieval ranking. Store-owned knowledge revisions invalidate query caches without scanning the whole catalogue on every request. Context usage stays in the normal UI. There is no keeper nudge, coverage takeover, `memory_edit`, decisions-block suggestion loop, or second context store.

Thread message and result material is deduplicated by actual message/body identity, so a step or lifecycle update cannot re-emit old bodies. Nested child sessions resolve their owning Thread from the
Host session binding (`sessionId → owning workspace / thread / run`) after
catalog/run reconciliation, not from the execution workspace Documents assigns
to scratch or materialized cwd. A missing or mismatched owner is denied; it
cannot skip the thread tool allowlist. Knowledge, recall, suggestions, and
Zone 2 knowledge resolve that owning workspace. Documents, LSP, shell, paths,
and workspace semantic index stay on the execution workspace.
A Run whose launch manifest explicitly carries blocks includes a tagged snapshot of the parent's then-current blocks. At
settlement the runtime combines explicitly headed report sections, tagged
decision deviations, the child block snapshot, metrics, transcript bounds, and
worktree facts before the registry commits the terminal Run and report together.
An isolated child fixes its logical baseline during dispatch, before the Pi session starts. Git still inventories
HEAD plus staged, unstaged, tracked, deleted, and non-ignored untracked paths, index modes, and dirty-path content
identities; a command failure is a failed capture, not an empty inventory. Unborn HEAD is `baseRef: "zero-commit"`
and does not run `diff HEAD`. Gitlinks are listed and rejected rather than captured as empty directories. Actual
filesystem inventory and body capture use kernel `file.scan` / `file.capture` through the same Host-admitted root
and scoped grant that will create the WorkingBranch. The complete captured path set is recaptured before publish;
Git inventory/content identity and frozen `captureScopes` are also rechecked, while the Documents capture generation
and dirty-state barrier cover controlled writers. A mixed baseline is retryable `baseline-changed`, never a complete
branch assembled from different moments. New virtual regular files receive the umask-derived default mode without
creating a probe file in the user tree, so apply and compensation compare full `sameState` identities.

Production WorkingState authority is the Rust format-v10 immutable root store; the old TS trie/catalog and local
materializer remain test fixtures only. Direct read, grep/find/ls/explore pin, virtual write, baseline capture,
materialization input, result publication, history release, and deletion use asynchronous root/path/domain APIs and
do not retain an expanded workspace tree or a callback projection as a second production authority. Old internal
WorkingState formats are rejected rather than migrated.
Failed prepare deletes an
unbound branch and scratch without touching a still-attached draft baseline.
Spawn recaptures only when no `workBranchId` exists. The child stays on a
virtual scratch until a path-binding tool runs. Same-name `edit` / `write` / `apply_patch` call `document.branchWrite`,
which commits text into the unpublished WorkingState delta with `writeRevision` CAS
and never writes the parent directory. Directory, binary, symlink, and unsupported
states are rejected. The first `bash` or LSP navigation tool asks `workingBranch.ensureMaterialized`: the Host freezes the current
`writeRevision` and waits for in-flight virtual writes, then the kernel materializes that pinned immutable root
directly into the admitted managed path. Rust owns operation-specific staging/backup/promotion, object verification,
and restart reconciliation; the older TS `materializationSwitch` journal is only a test/legacy seam when a kernel
root store is not injected. Callers that arrive during the switch re-read the execution view: materialized returns
disk, while a still-virtual branch accepts another WorkingState write.

A Git parent receives only execution metadata after the Rust body exists. The Host creates a temporary linked
`--no-checkout --detach` worktree, moves its `.git` admin binding to the live path, seeds the selected tree with
`read-tree`, then runs `git add -A` and an internal baseline commit. Those Git operations establish the real index,
clean/LFS/EOL/filter semantics and `executionBaseline` without copying workspace bytes back through TypeScript;
a required filter failure aborts attachment and leaves the materialized file bytes unchanged. Unborn/inherited
contexts use the existing isolated-init path. Reclaim removes the managed body through the kernel and prunes linked
worktree metadata. Ordinary WorkingBranch reads still re-fetch the current view after the store lease;
`explore.query.start` pins one immutable root/revision for lexical, structural, semantic, and original-text reads.

Settlement publishes `publishHeadResult` while virtual. Once materialized, Git supplies tracked/untracked changed
paths and index modes, while frozen `captureScopes` contribute both prior branch paths and current disk paths so
ignored additions, edits, and deletions remain visible; non-Git views use the complete Rust inventory. Rust captures
and revalidates those states, advances the branch root, and publishes an immutable WorkingResult. That root is the
retained production result/archive identity, so no mandatory adjacent `.snapshot` is created. Merge and reopen read
the selected native revision rather than the live child directory. Combined Integration/recovery uses the Rust typed
operation/file journal and kernel file-resource apply path; there is no production TS SQLite recovery writer.
Nested children reuse the same registry, Run, review, archive, and lost-resume
path. Host restart resumes lost Runs for the snapshot session's owning Thread
parent from the persisted session binding, so an execution-workspace snapshot
cannot look up the wrong catalog.
When dispatch carries dirty editor input, the runtime materializes drafts belonging
to the target root in a persistent WorkingState draft baseline. Independent external
drafts become an immutable `agent.source-view` record and content objects in a
private kernel store; the Thread manifest holds its view ID. A parent/child root
alias of the same physical file resolves to the child's current branch version.
Queued or restarted Runs overlay target-root draft bytes into the branch base
(and into a materialized directory only after a path-binding tool switches the Run)
and use that effective state as branch
revision zero. Virtual publication reads the live branch head; materialized
publication reads the directory. Merge and migration continue to read the selected
fixed result. Draft-derived paths are checked even when Git ignores them.
External fixed drafts remain readable after the parent surface snapshot retires.
Independent external draft writes use the captured editor owner and Documents'
versioned surface operation. A durable pending source-view record precedes the
editor side effect; a confirmed result advances the fixed bytes and version for
subsequent child reads. An intervening user edit conflicts without touching the
buffer. After a Host restart, the next read recovers confirmed writes from Documents'
durable operation result; a prepare with no durable operation may be cleared
only if the live owner, buffer hash, and edit revision still match the capture.
Unknown outcomes remain unavailable instead of replaying the write or
reading stale bytes. Same-file aliases still target the child's branch. Thread deletion releases the
source view; startup reconciliation releases captures that never acquired a Thread.
Configured `copyIgnored` roots are stored as branch `captureScopes`; nested
children inherit or narrow that frozen list and do not reread live settings.
Narrowed publication scans only those roots plus known changed paths, so ignored
additions, updates, and deletions enter the native result and survive
reclaim/materialize.
Draft targets use the originating surface owner and its live Documents registration,
document instance, content hash, revision and format. Agent calls resolve that owner
from their fixed inputContext. Documents directs capture/apply/undo to the owning
Registry; events carry metadata and authenticated requests carry body/receipts.
The durable Integration records both disk and buffer targets before dispatch and
does not complete before confirmation. Nested branch integration first acquires the
parent write/switch gate, then opens the WorkingState store. It persists an applying
intent (before/after revision, target states, retry identity, `targetKinds: "branch"`)
before the parent CAS and writes complete afterward. Startup reconcile compares the
live parent `writeRevision` to those slices; generic disk reconcile skips branch rows.
`runWhenVirtual` waits on the real gate, switch completion, or cancel signal.
Directory apply and startup reconcile resolve the execution Documents gate from
the persisted parent directory; the object library stays on the owning recovery
root. Queued dequeue passes the frozen manifest overlay into `session.create`.
Conditional compensation/undo preserves
subsequent edits; reconnect or restart cannot reinterpret a surface target as disk.
`merge-ready` comes from a bound preview; resolution submissions must consume that
binding. Preview reads and identical projections do not create event feedback loops.
`thread.update` (3.18D) rebases the calling thread's working branch onto a selected
published parent result revision — the explicit file-level counterpart to merge that
directed messages and `fresh` continuation cannot substitute for. A three-way plan
reads the child's revision-0 baseline, its current head, and the chosen parent
revision: parent-only changes are adopted, the child's own deltas are kept, clean
text edits merge, and divergent paths keep the child's bytes and are reported as
conflicts. The kernel `branch.write` `baseRef`/`parentRef` path resolves the new
immutable baseline, applies the complete delta set, and records the lineage under
the expected `writeRevision` CAS, so a concurrent child write cannot be lost.
Result records freeze their publish-time provenance — `baseRoot` plus per-path
`baseStates`/`pathStates` validated by the kernel against the published roots — so
an older revision still resolves against its original baseline after the rebase.
Materialized worktrees are refreshed onto the new baseline under the same gate.
A materialized update creates a staging branch, applies the planned directory change through the Rust durable Integration path, recaptures the complete execution directory, then CAS-updates the child branch. Its Registry handoff blocks bind/spawn/settle/partial publish/continue/restore/reclaim/lost resume until completion or startup reconciliation; deletion releases the staging branch. Virtual rebase performs one revision-bound CAS and reports a conflict instead of running a fixed retry loop.
Idle reclaim runs only after the session closes, a durable result exists, and the
Documents authority confirms that no related controlled writer or user remains.
User archive keeps the report, transcript reference, native results, and original
Pi session file; it does not use the session-delete path that clears `report`.
Restore rematerializes the published result at the same path. If that path is
occupied by other content, Host reports `path-occupied` and does not delete it.
Occupancy uses kernel `file.measure` for production managed directories: logical bytes are always counted from the
observed filesystem, Unix reports actual allocated blocks, and Windows leaves `allocatedBytes` unknown instead of
copying logical size into a physical-allocation field. Shared content-addressed objects remain a separate projection. Reclaim stays
blocked for `keep_worktree`, unfinished Integration, active writers, editor
surfaces, background commands, or unverified/uncollected content. Budget uses
only the user-configured `harness.worktree.budget`, across all parent sessions in
the workspace, including known costs of first materialization and restore. Archive
waits for preparation/setup and real session shutdown, and archives each
descendant on that descendant's lifecycle turn before the parent. Restore binds the original
session to a new Run; a failed restore stays archived and cannot open an occupied
path. Restore of a descendant is refused while an ancestor is archived or being
archived. The Documents reclaim guard remains held through deletion. Thread panel routes
`GET /space` and archive/restore/reclaim share this Host projection.
`POST .../threads/:threadId/send` delivers a directed message for the authenticated
parent session through the same `thread.send` service the Pi Host tools use: the
caller acts as the user, relationship authorization, the durable ledger, requestId
idempotency, held/delivered semantics, and `continue`/`fresh` scheduling are
identical. Service failures map `HarnessServiceError` codes to HTTP
(400/403/404/503) instead of collapsing to 500.
`GET .../threads/:threadId/history` and `POST .../history/release` manage selected
old WorkingResult versions for the authenticated parent. Release holds the Thread
lifecycle, storage lease, then a Registry snapshot guard while validating current
results, Run inputs, review and Integration users. The guard ends before object
collection. The current branch/report/transcript remains; completed Integration
undo keeps its own safety/target objects. Metadata removal and physical cleanup
have separate outcomes and the same branch/revision request can retry cleanup.
`DELETE .../threads/:threadId` (D-242/D-254) removes the whole Thread through the same
post-order cascade shape as archive: each node settles its active Run without
minting a partial result, deletes every Pi session it owned (worker, transcript
file, metadata via `piRuntimeBroker.deleteSession`), releases all result
revisions plus the work branch and draft baseline under the storage lease,
removes the managed directory (ownership assertion and user/writer guard still
apply; keep_worktree does not — the record is being removed), then atomically
removes the Thread and Run rows and unbinds session bindings. The operation,
root thread, next phase, and last error are durable before side effects; Host
restart resumes them. A failed descendant prevents the parent commit point.
Knowledge and retrieval evidence references are required cleanup steps, and a
directory or reference failure keeps the record for retry.
WorkingState publishes metadata before removing old references and protects new
write candidates until durable publication; startup reconciles derived references
without interpreting a missing catalog as empty (D-239).
The session-state sidebar reads/updates blocks through authenticated context
routes. Block writes broadcast only an invalidation identity over SSE, never
the block body. Thread metadata routes use the same UI-auth middleware.
Blocks can be explicitly promoted into workspace or user knowledge suggestions.
The authenticated review API keeps `(scope, id)` identities distinct, uses the
complete opened content/trigger/status/invalidAt revision for every mutation, validates same-scope supersedes before
mutation, and broadcasts only invalidation identities over SSE.
Settings catalog routes list/edit/retire the same workspace and user `.tdb`
rows after Documents workspace resolution. Delete sets `invalidAt` on one id;
it does not cascade to other scopes or supersede neighbors. Derived vectors
are notified through the existing knowledge-change hook.
`memory.remember` and the background organizer write effective memory through
the shared MemoryService and scoped KnowledgeStore. The organizer is the sole
automatic producer: it persists prepared proposals and source coverage before
advancing a cursor, and replays a prepared range after interruption. Existing
`suggested` rows retain their explicit review actions; ordinary conversation
does not invoke the retired `knowledge.suggest` model path. Catalog mutations
send the complete opened content/trigger/status/invalidAt revision;
workspace/scope changes retire the UI request generation so late responses
cannot replace the active catalog. Suggested, dismissed, and superseded
identities do not enter public recall.

Interactive UI inputs carry a content-free `AgentInputContext`. The Documents
authority has already validated and frozen any dirty buffers behind its opaque
reference. `HostServicesBridge` attaches the current context to every Harness
request; Router still derives session/workspace/scope from the broker actor.
`explore.search` and `search.content` remove disk hits for dirty paths and match
the fixed snapshot; the same-name `read` override obtains save-compatible bytes
from `document.readSource`. Expired or unavailable dirty sources never fall back
to disk. Other files retain the existing disk path. Thread dispatch copies the
fixed content into persistent WorkingState before the temporary surface reference
can be released.

Language support status (`LanguageSupportAPI`) is computed when the settings
page asks, not at boot: `searchFilesystemFiles` + `languageIdForPath`, cap
8000 files, `partial` when truncated, 30s per-workspace cache (D-120). A
structure request for an installable-but-missing language records an in-memory
wanted id and still returns `unsupported` (D-121).

### Settings caller and Surface targeting

`settings.read`/`settings.update` resolve client-owned preferences from the
Harness caller's live `sessionId`. The UI first authenticates and binds its
current session through `/api/varin/client-settings/bind`; the event stream
is targetable only after that Host-side binding and live broker validation.
Surface ids are returned as facts and are never accepted as model selectors.
Zero bound Surfaces is `unavailable`; multiple windows bound to one session are
`ambiguous`. A reconnect or deleted session has no binding until the UI binds
again.

`settings.action` returns `operation` only when an owner supplies a real stable
identity and status/cancel adapter. Host metadata is persisted through the Rust
`settings.operation` record with caller session, entry and owner identity in
the record key. Owner calls that await a terminal result report that result;
an asynchronous owner without durable observation is `unavailable`, so the
service does not leave a synthetic operation running across restart.

### Follow-up sources and delivery

`followups.ts` stores definition, occurrence and compact observation identities
through the kernel record boundary. `any`/`all` parents own hidden leaf
definitions; compatible file, metric, attempt and external observers share the
underlying subscription/query. File and metric edges become typed observations
before a definition cursor advances. Ordinary shell start/completion facts are
durable Knowledge events, while output stays with `ShellSupervisor`: registration
first reads bytes already present at its cursor, then consumes live chunks and
persists only match facts. A local shell that disappeared with its Host is
`unavailable`, not restarted.

Thread delivery calls the same directed-message ledger, target lock and
admission path as `thread.send`; an occurrence id is the request identity across
retry/reconcile. Root sessions retain the Pi broker's native receipt path.

An Explore source deadline preserves already prepared, revision-bound windows and marks the result
`partial` / `searchIncomplete`, whether it interrupts the source pump, document materialization or later
graph enrichment. The store's timer may fire while one of those stages is awaiting I/O; partial delivery
does not depend on the pump reaching its next loop turn first. Explicit query/request cancellation and
an abort before the source deadline remain cancellations, never successful partial results.

Raw Document reads and optional outline/classification use separate queues with the existing
preparation parallelism. Output excerpt count no longer limits investigation reads. Each free read
slot reconsiders current candidate ranking, so late sources are not trapped behind a frozen page.
Acquired versioned text is immediately available to incremental consumers. Source deadline, user
cancellation and late completion retain their distinct meanings; stale enhancement results cannot
overwrite windows built from newer query evidence. Source scope and search-backend coverage limits
are preserved and reported.

`explore.search` asks an optional `structureSource` (see
`lib/structure/DOCUMENTATION.md`) for a revision-bound outline after a file is
materialized. Production tries tree-sitter, then the agent-view LSP outline.
Slice units are containers (function/class/interface/…); a hit on an ordinary
value binding stays inside the enclosing function or class (D-098). Small
containers are emitted in full; large ones keep the signature, the hit block,
omission markers, and a full-unit read entry. An earlier `empty` outline or a
ready outline that misses a hit does not hide a later provider; that later call
is `warmOnly` and will not start a cold language server (D-099). When the source
is used for ordinary Explore slices, requests are explicitly `warmOnly`; native parsing remains available,
and the provider chain preserves that caller policy. A chosen `prepare-structure` operation can request
cold preparation through the existing owner and authorization path. When the source
is missing, cold, unsupported, stale, or failed, explore falls back to the ±3
line window and records that status on the snippet and in `details.structure`.
After materialize, tree-sitter may classify hit lines so declaration names
outrank comments and strings in unit-local ranking; unread candidates are not
parsed. It does not call `documentSymbols` itself. `windowScore` is gone.

After excerpts are chosen, an optional `fileRelations` callback may attach
outbound graph facts for those paths only (`details.relations` and a compact
English block in the visible/stored body). Confirmed `connections` stay
distinct from unverified `associations`. That annotation does not change
byte/candidate budgets (D-108 / D-112).

Query parse is object-first (D-144): technical literals, quotes, and anchors
are objects; ordinary sentence words are content and do not drive graph
queries. Relation words are a closed table (register / import / define).

A second, independent graph path (`graphRecall`, already-open store only) may
add **path** candidates. Objects from the question run `findLinks` /
`searchDefinitions` before the first pack (D-146, revising D-137). Seeds
discovered after a read still expand. The graph never supplies line numbers
for excerpts. After `readFile`, explore relocates the symbol name or literal
in the current text and only then writes `hits`; if the name is gone, that
window is omitted — it does not become line 1. Graph why/boost bind to the
window that verified, not the file. Evidence units carry `arrival` / `assessment`
/ `purpose` instead of a single grade; `connects` and `associates` stay different
graph arrivals. `details.graph` reports
`not-requested | ready | empty | unavailable | failed`, with unique-file
`definitions` / `connections` / `associates`. An unusable graph leaves the rg
excerpts in place. Graph `filesDropped` is a unique-path floor and is combined
with rg by taking the maximum, not the sum (D-092). Direct clues get priority
reads inside the existing `maxMaterializeReads` budget; a path already in the
rg pool but not yet read can still be materialized. Ranking is by task-match
tier (D-145); path order is only a tie-break. `limit` is a cap. Content-word
rg skipped because a direct clue verified is `details.skippedQueries`
`direct-verified`, distinct from unread `not-requested` (D-147).

Relations are an annotation, so they never make a successful search fail
(D-112). `fileRelations` throwing — a corrupt store, or no store open for that
workspace — sets `details.relations.status` to `partial` / `unavailable` and
prints one line saying the graph could not answer, without leaking the
underlying error. That is a different result from an absent `relations`, which
means no excerpt path had an edge. A graph revision that differs from the
excerpt is reported as `stale` and printed **without** line numbers, since a
moved line number is worse than none. Relation lines are pushed last in the
visible budget — after omitted supports, unread candidates and issues — and are
capped per file, because the annotation must not crowd out the channels that
tell the agent what the result does not contain.

`related.query` answers file-level topology for one path or symbol name:
definitions, imports (resolved and visibly unresolved), reverse importers, and
connection endpoints. It is not `lsp.references`. A missing open store is
`unavailable`; the read path does not open a database. The text caps each
section and a name anchor's walked paths, saying how many it left out, so a hub
file cannot hand the generic tool-result truncation the choice of which section
disappears; `details` still carries every item (D-139).

### LspNavigationServices (`lsp-nav.ts`)

`symbols` / `definition` / `references` / `hover` bind the queried document in
the Host language view through `createLanguageViewBinder`, following the same
fixed source as `read`/`grep` for this turn, and assert that revision on the
request. A `stale` answer re-binds once and retries. Results carry `revision` and
`source`; positions in other files are marked `[unpinned]` because the language
server read those files itself and LSP does not report the version it used.

### LspDiagnosticsService (`diagnostics-service.ts`)

`lsp.diagnostics` binds the path to its current disk text — the text an agent
just wrote, never the editor buffer — and waits for the publication computed from
that exact revision, returning `pending` on timeout. `lsp.diagnosticsSnapshot`
binds without waiting and stays incremental. Both report `revision` and `source`.
Cache lookups use the exact normalized resource identity.
The adapter converts the language service's zero-based `range.start` to the
one-based line and character positions used by Harness tools.
Snapshot calls are incremental per observer and canonical resource by default;
`full: true` is a non-mutating full view. `shell.read` follows the same rule when
neither `offset` nor `length` is supplied, while static `out_*` handles remain
explicit UTF-8 byte slices.

## Wiring (index.ts)

The harness is wired in `packages/web/application-host/index.ts`:

1. `HarnessServiceHost` instantiated after `workspaceContentSearch` and
   `languageSupervisor` are created.
2. `HarnessRouter` created after `recoveryTurnCoordinator`, with broker response,
   Actor resolution, and Documents-backed path authorization callbacks.
3. `registerHarnessServices()` registers all services on the router.
4. `harnessRouter.processEvent(event)` added to the broker subscription,
   aligned with `recoveryTurnCoordinator.processEvent`.
5. Session registration on `session.snapshot` event with bound workspace.
6. Disposal in `stop()`.

## Session Lifecycle

- **Register**: `session.snapshot` event with `workspace.kind === 'workspace'`
  resolves that workspace's `harness.shell` from Pi settings, then
  `harnessServiceHost.registerSession()` creates a `ShellSupervisor` from the
  Host's discovered interpreters. Unreadable settings and an invalid
  `harness.shell` value are reported as unavailable.
- **Drop**: `harnessServiceHost.dropSession()` retires the shell supervisor
  and clears session-scoped output entries and observation cursors. Its commands remain visible to reclamation
  until `closeSessionShell()` confirms shutdown and writer release.
- **Dispose**: `harnessServiceHost.dispose()` disposes all sessions and
  global services.

## D-278 native lifecycle acceptance correction

See [the authority audit](../../../../../docs/plan/rust-kernel-audit.md). At the D-278 audit point, native materialization,
capture, and root publication primitives were wired but the cross-domain execution-generation transition was not yet
accepted. The audit required a durable Host switch intent connecting selected root/writeRevision, kernel
operationId/receipt, Git executionBaseline, and Registry/view binding; a failed Git attachment or Host exit after
promotion could not be resolved by a new random operationId or a current-branch read. Uncollected live content was
already protected by a kernel conflict rather than overwritten to force a retry through.

Maintenance hints containing only executionWorkspace remain Host operations, not fake session actors. Production
capture/settle/reclaim carries the real execution workspace. Managed materialization admission uses the owning
workspace's retained Thread/worktree and existing ownership assertion; root selection does not create authority.
Branch metadata read failures propagate; incomplete unit fixtures must be corrected instead of swallowing errors.

## D-279 R2/R3 acceptance closure

D-279 closes the D-278 gaps without adding another writer. Pending kernel file operations are surfaced to the Host
with operation identity, affected paths, disposition, reason, and a proof-based reconcile action. Native
materialization persists a fixed root/revision/writeRevision plus operationId and durable pin in the Thread Registry,
then records kernel-materialized and Git-attached receipts. The pin is released before the Registry handoff is cleared;
a release failure leaves the receipt available for restart retry. Setup timeout/abort waits for the actual child
`close` event. R2/R3 are Complete; local platform machines and code signing remain outside those stage gates.

## D-280 native command lifetime

Harness shell and user terminals share the injected Rust PTY backend. The terminal runtime keeps
OSC 633 command framing and display; Rust owns bytes, process tree and directory writer. Shell
request/command errors caused by kernel loss never become exit code zero or a replacement shell.
Incomplete stop keeps the command/writer retained and rejects callers. The old global Node socket
unref workaround is removed. Thread setup also uses native pipes, awaits actual close and keeps
unconfirmed native writers protected. Fixed-result verification accepts an unknown process exit
without converting it to successful evidence. See [the process consumer map](../process/DOCUMENTATION.md).
