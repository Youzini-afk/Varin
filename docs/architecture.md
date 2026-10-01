# Varin architecture

Status: Pi-native workbench/harness in production; Rust system-kernel Stage R complete through D-282.

Current boundary (D-296): the former VS Code companion is retired before AI4S. The companion package,
its build and packaging entrypoints, and companion-only shared surface contracts are not current
product surfaces. The cleanup and root build were locally verified; packaged, cross-platform, and
remote-CI evidence remains owned by their respective release checks. Historical Stage R and migration
evidence may still name that surface where it records work completed before retirement.

Last updated: 2026-09-30

Design direction (D-337, implemented HR0–HR5): [task/resource Harness and continuous retrieval](design/resource-oriented-harness-design.md)
separates project grouping from session/task ownership, resource identity, execution directories and indexes.
HR0–HR5 replaced the mutable session work-context and workspace-bound retrieval model: tools resolve paths
against the session cwd and resource roots at admission, retrieval scopes are per-request, and indexes key
on resource/content version/model. Per-scenario evidence and remaining untested boundaries are recorded in
[status.md](status.md); the process and workspace descriptions below describe
current implementation.

Accepted direction (D-338, incremental implementation pending): [composable execution environments](design/execution-environment-design.md)
defines independent frontend, Harness, work-environment and computer placement, environment preparation, application interfaces,
and cross-environment coordination. Its current-foundation section distinguishes existing code from the proposed combinations;
the process model below remains the implemented architecture.

## 1. Context

Varin is an independent Agent workspace and harness with a bundled Pi runtime. It owns the tool
environment, working state, recovery, retrieval, context policies, and task governance; Pi supplies
the Agent loop, model/provider stack, native session tree, and extension ecosystem. The workbench
originated from the maintainer's OpenChamber fork, whose product capabilities are retained. That
source fork remains read-only; all Varin edits and history live in this repository.

Identity cutover (D-313): [Varin rebrand](design/varin-rebrand-design.md) is implemented across owned packages,
runtime contracts, storage names, product assets and distribution configuration without old-name aliases
or migration layers. The GitHub repository is now `Youzini-afk/Varin`; actual Pi dependencies and native
data retain their names and owners. Process boundaries and capabilities do not change. First new-brand
publication and platform validation boundaries remain in harness status; Fast Decision Model is next.

The production architecture separates a Rust system kernel from the TypeScript product and Agent
orchestration layers. [rust-kernel-design.md](design/rust-kernel-design.md) defines the implemented responsibilities;
[agent-harness-plan.md](plan/agent-harness-plan.md) stage R records the completed R0–R6 transition. Current release and
verification evidence remains in [status.md](status.md).

Desktop was the first surface to ship, and Windows, Linux, and macOS packages are published from
matching runners. The same process and protocol boundaries carry the remote host, browser client, and
companion mobile client, so no surface moves extension execution into an untrusted renderer.

## 2. Goals

1. Provide a pinned bundled Pi runtime by default, while honoring an explicitly selected user-global,
   standalone, custom, or developer Pi runtime. The Host bootstrap resolver loads the selected package
   root; runtime code and the user's native Pi data remain separate.
2. Provide first-class session, model, provider, settings, and package management.
3. Render streaming messages, tools, commands, queues, compaction, retries, and extension UI.
4. Make subagent work visible and controllable from its parent session.
5. Integrate Magic Context, MCP, and Web Access without forking their core algorithms.
6. Associate each user turn with a recoverable conversation and workspace checkpoint.
7. Produce signed-ready desktop installers with deterministic runtime diagnostics.
8. Deliver the Rust workspace, recovery, process, and file/structure computation kernel as stage R,
   preserving one authority per resource and keeping product/model policy in TypeScript.
9. Support a research work focus in which heterogeneous Pi workers and managed compute resources explore a
   scientific problem in parallel, while reusing the same Thread/Run, Host, Rust kernel, context,
   permission, and artifact boundaries.

## 3. Non-goals

- Reimplementing Pi's model/provider stack.
- Parsing terminal escape sequences as an application protocol.
- Running third-party Pi extensions in Electron's renderer or treating arbitrary UI modules as Pi
  packages.
- Treating a tool allowlist or plan mode as an operating-system sandbox.
- Editing Pi session JSONL for ordinary navigation, rename, archive, or branching.
- Bundling arbitrary local extension working trees into a release without an explicit manifest.

## 4. Process model

The following is the current process arrangement after Stage R.

```text
React renderer: Workbench Profile selects a shell extension
    |- shared kernel: Document Registry, Editor Workbench, Pi session state
    |
    | authenticated HTTP + SSE to the application host (documents, search,
    | language, tasks, debug, tests)
    | authenticated Varin v1 WebSocket/postMessage surface protocol (Pi runtime)
    v
Application host: web/Electron shell + Varin broker + extension host
    |- TypeScript product policy, authenticated APIs, Thread/Run lifecycle
    |- Documents/Registry coordination, LSP/DAP protocol, knowledge/model adapters
    |
    |- private Node knowledge storage process
    |    `- workspace/user TriviumDB handle, queries and coalesced checkpoints
    |
    |- private generated varin.kernel.v1 framed protocol
    |    v
    |  Rust kernel
    |    |- immutable working roots, recovery records, objects and GC
    |    |- canonical file authority, capture/materialization and reconciliation
    |    |- PTY/pipe process trees, raw output and writer lifetime
    |    `- fixed/live file search, inventory, tree-sitter structure and chunks
    |
    `- Varin protocol v1 over a private child-process IPC pipe
         v
       Pi session worker (Node >=22.19)
         |- Pi SDK session runtime and model/provider stack
         |- Pi resource and package loader
         |- extension UI bridge
         `- extension-specific structured adapters
```

Electron does not add a parallel backend. It hosts the Web application host in-process, so the
desktop renderer reaches the same HTTP/SSE/WebSocket surfaces over loopback rather than through a
separate Electron IPC protocol. Only genuinely native capability — windows, menus, dialogs,
notifications, updater — crosses the Electron preload boundary.

### 4.0 Rust kernel boundary (D-252, completed by D-282)

One Rust kernel process belongs to each actual Application Host instance. Desktop and Web/remote
deployments use the same private client and packaged executable. Renderer and Pi workers continue to
call the existing authenticated Host boundaries, never a new public kernel endpoint.

The kernel owns workspace file resources, content objects and immutable working-state roots, file
recovery/Integration operations, capture/materialization, PTYs and managed tool processes, and fixed-view
file/structure computation. TypeScript retains the public API and admission policy, Thread/Run product
lifecycle, Document Registry coordination, knowledge-domain services, and model/context orchestration.
Pi worker/session management stays in runtime-broker; credentials and native Pi state remain in Pi.
TriviumDB graph/vector stores keep their current single-writer adapters; changing the implementation
language is not authorization to replace those databases. The workspace/user KnowledgeStore handle
runs in a private Host storage process, outside Electron main, with shared-checkpoint acknowledgement
and no in-main fallback. Derived semantic/vector adapters retain their named owners. See
[knowledge storage](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md).

The process is an implementation component of this Host, shared by all surfaces. It does not create
a second Electron backend. Responsibilities move with all their writers, references, consumers, and
recovery paths; migrated TS code becomes a protocol adapter and the old implementation is removed.
There are no users requiring Varin internal-format compatibility (D-253): obsolete internal stores
can be recreated, with no legacy readers, upgrade importers, or version branches. Workspace files/Git,
native Pi data, and external configuration remain intact; any unfinished real work is handed off
explicitly without preserving its old internal schema. There is no dual writer or silent return to
the old backend on native-runtime failure. Exact protocol, data, lifecycle, performance, and packaging
requirements are in [rust-kernel-design.md](design/rust-kernel-design.md).

Inside the Rust crate, the executable `main.rs` is only the process entry. `lib.rs` assembles the
runtime and storage modules; `runtime.rs` owns framed transport, handshake, admission, and cancellation.
One `storage::Storage` still owns the catalog connection, object root, process lock, cancellation state,
and active builders. Its authority, objects, immutable tree, branches, Recovery, records, GC, health, and
transaction implementations live in bounded `storage/` modules and are entered through one authorized
dispatch. This is a source ownership boundary, not multiple stores or services (D-266).

### 4.1 Renderer

The renderer contains presentation, local view state, and the shared client-side kernel. It never
imports Pi packages, reads credential files, or spawns commands. Production roots now mount a
Workbench Profile whose shell is a Varin extension, and the extension platform supports
declarative, managed, isolated, and explicitly trusted-native Surface entrypoints. None of those
modes authorize loading Pi extension code or private plugin state in the renderer. Every native
operation crosses a typed preload or runtime capability. OpenCode SDK types are removed from feature
code rather than preserved behind a compatibility facade. The former SDK client, sync stores,
optimistic session graph, old chat composer/turn projection, and old session sidebar have no parallel
copy: their unreachable source and tests were deleted after all supported production roots passed type,
lint, test, and bundle validation.

Composer drafts are keyed by Pi runtime and session. Workspace surfaces may seed visible text and
hidden instructions in that draft; if there is no active session they create one in the relevant
cwd first. A Pi session's snapshot/catalog cwd is authoritative, including for worktrees, so Git,
terminal, and pull-request views do not maintain a second session-to-directory or
session-to-worktree map. Varin separately records the product workspace binding selected when it
creates a session: either one registered workspace ID or an explicit unbound/general-chat marker.
That metadata controls navigation grouping only and never replaces the Pi cwd. Native Pi sessions
without Varin metadata are grouped by their cwd, while an explicitly unbound session remains in
Recent even when its runtime cwd happens to sit below a registered workspace. The same workspace
picker, grouping rules, and navigation path are used by Web, Electron, mobile, and the IDE shell
instead of keeping platform-specific workspace state.

The composer keeps three different controls semantically separate. Model and thinking mutate the Pi
session or seed its creation. An Agent target applies only to the next draft and is rendered through
that Agent Provider's declared invocation contract; `Pi` remains the ordinary main-session target.
File and Agent `@` mentions use the shared provider/file catalog rather than a hard-coded role list.
Tool permission is not a cosmetic Varin mode: an enforcing Pi extension must own the `tool_call`
gate, while its Varin adapter may contribute status or controls through the composer action seam.
No shield control is shown when no enforcing plugin is installed.

The conversation renderer follows the Pi-native interaction contract in
[chat-experience.md](design/chat-experience.md): one session record owns preview/live/optimistic/view projections,
messages project into stable turns, the timeline has one virtual-list and scroll owner, and Queue/Steer
state comes only from the Pi runtime. OpenChamber's current chat is reference evidence rather than a
second renderer or state layer.

Session completion and error attention are owned by the Pi session store. They are derived from routed
`agent.event`/`host.error` envelopes, cleared when the session is viewed, and shared by the sidebar,
switcher, and mobile widget snapshot.

### 4.2 Electron/web shell and broker

The retained shell owns windows, web/mobile/remote bootstrap, packaging, and native dialogs. The
Varin broker owns Pi workers and maps one live worker to each opened top-level session, with a
separate catalog worker for discovery. A worker crash
cannot crash the renderer, and a renderer reload does not terminate an active task.

`@varin/runtime-broker` is now the single process client for the worker boundary. It validates protocol
frames and event sequence numbers, correlates concurrent requests, denies project trust by default,
owns catalog/per-session workers, and performs graceful then process-tree shutdown. Electron starts
and handshakes the catalog worker whenever the local runtime is available, verifies that packaged
worker files are unpacked, and awaits broker disposal during ordinary quit, update, relaunch, hard
signals, and startup failure. Electron resolves that external Host entry once and gives the same
absolute path to live Broker generations. A path inside `app.asar` is never
an executable fallback for an external Node process. The three Pi SDK packages are pinned production
dependencies of `@varin/pi-host` in every distribution. Packaging runs default bundled discovery
and a real Host handshake using the packaged Electron executable in Node mode, and rejects SDK entry
paths outside the packaged dependencies. Desktop smoke starts with no runtime selection and requires
bundled Pi to reach `ready`; a source-checkout Pi or the runtime-setup screen cannot satisfy that check.

`@varin/runtime-client` is the browser-safe surface client. The Web server exposes the same
Pi-native method names through `/api/varin/runtime/ws`; it validates every untrusted parameter,
removes worker-only shutdown/trust methods, authenticates UI cookies/client or short-lived URL
tokens, checks Origin, and forwards worker events with explicit
`{workerId, role, sessionId}` routing. The private relay explicitly allowlists this socket and
continues to carry it through the existing encrypted tunnel without injecting credentials.
Varin does not impose renderer payload, pending-request, or buffered-output ceilings by default;
deployments may opt into them with `VARIN_RUNTIME_MAX_PAYLOAD_BYTES`,
`VARIN_RUNTIME_MAX_PENDING_REQUESTS`, and `VARIN_RUNTIME_MAX_BUFFERED_BYTES`.

`@varin/application-client` is the framework-neutral application client boundary. It owns the
`RuntimeAPIs` aggregate interface and the named API interfaces (Terminal, Git, Files, Documents, Settings,
Permissions, Notifications, Extensions, Language, Tasks, Debug, Tests, etc.), typed failures
(DocumentsError, FilesystemError, LanguageServicesError, RunServicesError, WorkspaceSearchError),
pure DTO types (WorktreeMetadata, DraftStarterRef, FileEditorSettingsPatch), and the single desktop
IPC contract (`desktop.ts`, exported as `@varin/application-client/desktop`): the
`VarinDesktopCommandMap` for all 58 `desktop_*` commands, the `VarinDesktopBridge` interface, the
`PreloadBootstrapPayload` discriminated union, exhaustive runtime command/event catalogs, and the
remote-safe command catalog. It has no React, Zustand, or UI component dependencies —
only `@varin/protocol` and `@varin/extension-contract`. Web, Electron main/preload, and
UI non-render code import from it directly rather than reaching into `@varin/ui/lib/api`.

Privileged runtime source and deployable artifacts are intentionally separate. Application Host source
lives in `packages/web/application-host` and emits the stable `packages/web/server` Node ESM runtime;
CLI source lives in `packages/web/cli` and emits the published `packages/web/bin/cli.js`; Electron's
package-root TypeScript modules emit `dist-bundle/main.mjs` and `preload.mjs`. The generated directories
are not tracked, and production does not load TypeScript through `tsx`, `ts-node`, or a loader hook.
Electron type-checking consumes a freshly emitted, type-only Application Host declaration tree so it
does not have to replace a `server/` generation that a running development process may be using.

Desktop first-launch and local recovery use this same authenticated connection and require a
successful Pi host handshake. The surface shows the negotiated Pi, host, Node, and runtime-source
versions; it does not probe OpenCode health, ask for an OpenCode binary, or run an installation
script. Remote host selection remains a separate retained transport choice.

Protocol v1 does not forward Pi SDK objects verbatim. The host projects the append-only session
tree, messages, tool calls/results, streaming updates, compaction, retry state, model metadata, and
provider authentication interactions into Varin-owned discriminated DTOs. Provider response IDs,
thinking/text signatures, callback functions, `AbortSignal`, and credential objects remain inside
the worker. Arbitrary extension/tool details cross only through the JSON-safe protocol projector.

Provider configuration is also Pi-native. The user layer is Pi's canonical
`<agentDir>/models.json`; the trusted project layer is `<workspace>/.pi/models.json`; an operator may
add a `VARIN_MODELS_CONFIG` layer. Project and operator definitions are applied through
`ModelRuntime.registerProvider()` in `user → project → operator` order, without translating through
an OpenCode schema. UI-added API keys use Pi's locked `AuthStorage` flow and are never returned with
provider metadata. Existing literal/env/command keys in native configuration layers remain intact
and usable but are redacted from the surface protocol.

Background embedding, rerank and decision are user-owned inference bindings. Their isolated Pi resolver applies
the user and operator provider layers but excludes trusted project provider overrides, so a repository
cannot redirect a user's stored credential. The Application Host receives only a credential-free hash
of the effective endpoint/API/model binding. These methods and their explicit batch cancellation remain
on the private Application Host-to-worker protocol and are absent from the renderer/web/mobile runtime
method catalog.

The bundled Pi SDK is pinned to 0.99.2. Native catalogs distinguish chat, image and classifier models;
Varin matches type plus ID and preserves non-chat definitions when editing chat providers. Decision
bindings call Pi's native classifier APIs while retaining Varin's typed judge/choose/score results.
Virtual selections remain visible as selections; request budgeting and compaction use the actual
routed chat model. Native context edits and auxiliary usage entries retain their append-only journal
identity. System messages carry current prompt/tool state and are not rendered as conversation bubbles.

Remote model discovery is a separate privileged operation. It uses the provider's host-owned auth
when present and also supports anonymous endpoints. HTTP, HTTPS, localhost, LAN, and URL basic
authentication remain available for explicitly configured providers. Authentication headers are
removed on cross-origin redirects. Discovery has no product-imposed redirect, duration, response,
or model-count ceiling. Deployments may opt into budgets with
`VARIN_PROVIDER_DISCOVERY_MAX_REDIRECTS`, `VARIN_PROVIDER_DISCOVERY_TIMEOUT_MS`, and
`VARIN_PROVIDER_DISCOVERY_MAX_BYTES`; `0` keeps a budget disabled. Exact redirect loops are still
rejected. Google keys are sent in `x-goog-api-key`, not in the URL.

The settings editor may send a credential-free draft provider definition for discovery without
writing it to `models.json`. If the draft includes a one-shot API key, the key travels only through
the typed auth-prompt response and is neither embedded in the discovery request nor persisted.

Concurrent provider-config writes use an atomic owner lock without a product-imposed wait cutoff.
Dead owners are reclaimed by process identity; deployments may opt into a wait budget with
`VARIN_PROVIDER_CONFIG_LOCK_TIMEOUT_MS`, while `0` keeps the budget disabled.

Application settings have one file authority, `@varin/settings-store`, shared by the Web host,
Electron, and the CLI. Reads distinguish a missing file from malformed or
unreadable state. Every mutation re-reads under an owner lock and replaces the document through a
complete temporary file; interrupted Windows replacement retains a complete `.previous` document.
No surface may independently perform a whole-file read-modify-write or treat invalid JSON as an empty
first run. This also serializes first-use identity material such as Relay, APNs, and VAPID keys.

### 4.3 Session workers

Each hot top-level session runs in its own Node worker process and loads the public Pi SDK from the
selected installation. The Host process stays Varin-owned; only
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-ai` are
resolved from the chosen package root. This matches the single-active-session assumptions made by
several Pi extensions while allowing multiple background sessions. Idle sessions are persisted by Pi
and need no live worker.

The broker starts each session worker with the session project's absolute `cwd` as the operating-system
working directory before Pi loads extensions. New sessions already provide that directory; reopened
sessions without an explicit override are resolved from the session header by the selected Pi SDK
before the child process is created. This keeps extensions that read `process.cwd()` during their
factory phase aligned with Pi's session snapshot, project trust, worktrees, and project configuration.
The reusable catalog worker deliberately retains the broker's fixed discovery directory and addresses
per-request resource roots through the Host protocol instead of changing process-wide state.

Opened sessions stay live until explicitly closed or the application exits. An optional hot-worker
budget and idle eviction remain a later deployment optimization; eviction must be graceful: stop
accepting requests, wait for idle or require explicit abort, dispose the SDK runtime, flush
settings, and then stop the process. Subagents remain owned by their supervising extension and are
observed through structured events and lifecycle artifacts.

### 4.4 Why direct SDK workers

Pi's JSON RPC mode is a useful compatibility and diagnostic backend, but direct SDK workers expose
the complete settings, package, model, extension event-bus, and custom UI surfaces needed by the
product. Pi's newer transport-neutral protocol is intentionally tracked, but its experimental
server backend and current command set are not yet sufficient as the sole product foundation.

Direct workers are also where Varin's own agent harness lives. The session worker overrides Pi's
built-in `bash`, `edit`, `write`, and `grep` tools by name through the same `customTools` path the
recovery journal already uses, and mounts in-process extension hooks for tail-appended turn context,
post-tool feedback, and fixed-candidate context preparation (D-284/D-287). On every model request —
including tool-loop continuations — the context hook compares the projected request size against a
configurable waterline of the usable window (context window minus Pi's reserve). Once crossed, the
extension fixes a branch- and model-bound preparation range and starts an internal compaction worker
with the same resolved model and Pi provider/auth configuration. Its Agent loop has scoped read-only queries.
The foreground turn keeps running. When a later request needs space, Pi commits the validated candidate at
a safe paired boundary (or waits for the same candidate), persists the compaction entry, and reports which
original observations remain in the retained context. A `history` tool reads
summarized raw entries back from the session's own branch. The heavy services behind those tools —
shell supervision, ranked search, diagnostics, output storage, and the TriviumDB workspace knowledge
store — run in the application host and are reached over typed worker-to-host requests, never by
handing the worker host credentials. The harness contract, its cache rules, and the profile model
are specified in [agent-harness.md](design/agent-harness.md); which of its capabilities are implemented,
wired into a real session, proven by end-to-end evidence, or on by default is tracked only in
[status.md](status.md).

D-284's replacement context policy is implemented and D-287 closes its consumers: one fixed-range summary is derived from the active
model request near capacity while foreground work continues, then committed with retained original
messages only when a later request needs room. Pi remains the session/history authority; request
budgeting and summary scheduling stay in the TypeScript/Pi layer, not the Rust kernel. The continuous
memory keeper, its coverage-driven takeover path, keeper nudges, block-based compaction coverage, and
memory-mode UI are deleted; plans, user notes, accepted knowledge, and real event delivery remain.
After compaction, observation receipts and material revisions are retained only when their original Pi messages remain in the
active context; Zone 2 then emits changed material instead of rebuilding a dashboard every turn. Background preparation is on by default and can be disabled independently of Pi's own automatic
compaction; a retired `harness.memory.mode: "off"` value still disables preparation as a migration
read, not a running mode. See harness section 8.4 and plan 2.4/2.6.

D-314 implements the [compaction Agent design](design/context-compaction-agent-design.md). The broker owns its
internal child process; query responses route to that worker ID without blocking behind the parent session.
The parent owns the fixed source and native compaction commit. Replaced material is complete; retained
recent messages are supplied verbatim or as explicitly sourced excerpts when space is limited. Both manual
and automatic compaction use this path. Pi message conversion preserves the prior summary and custom
history, and the active-context projection excludes superseded summaries while preserving the native journal.
Parent request admission still uses D-284; the auxiliary loop checks query results and final-output capacity
on every request. It never recursively compacts or waits for a business-thread slot held by its parent.
Frozen-history queries reject missing boundaries; record reads do not advance the parent's observation cursor.

D-301's 7G request preparation is implemented at D-305. It runs before every actual Agent model request:
new environment facts become replayable
history, followed by a complete compact team roster that exists only in that request. Prior rosters
never enter the growing conversation prefix; the full current scoped view is supplied even when
unchanged. Fixed collaboration guidance stays in the system prompt; dynamic observations and the
snapshot use source-labelled user content through the provider adapter. Request capacity includes
both materials. Environment delivery receipts remain distinct from transient snapshot visibility,
and neither UI reads nor a snapshot marker consumes a directed message or result body. Pi's existing
session manager remains the only conversation authority; there is no second context service.

D-302 / 7H is implemented at D-305. Resource-aware tool scheduling runs at the real
Pi execution boundary, while Host authority and Rust file/process owners retain permission, mutation
and lifecycle enforcement. Independent calls can overlap; shared resources and unresolved sequential
barriers preserve order without forcing every independent group to execute one call at a time.
Long shell calls return execution handles promptly; output reads may wait on real events, and completion
facts join 7G's environment deltas without copying logs or updating old history. Observation timeout
does not terminate execution. Idle Agent continuation requires an explicit wait or continuation intent;
output growth alone starts no model call. Ordinary session shells remain distinct from durable research
attempts.

D-286 makes the full context scope explicit: sufficient first presentation of tool material, stable
history, actual request capacity, retained original messages, one continuation summary, history rereads,
and independent plans/knowledge. A task can also start a fresh input view when its prior background is
mostly obsolete. That refresh uses current rules and selected work evidence without discarding files,
results, pending messages or the old Pi transcript, and does not require a background freshness model.

D-285 accepts task-centered collaboration; plan 3.18A–E is implemented and independently corrected by D-287. A normal dispatch requires only
`task` and inherits the caller's current model and active tools; presets are optional, resolve per-Run
execution configuration, and `shared` worktree stays an explicit choice. Each Run freezes its model,
tool allowlist, permission overlay, scope, worktree, prompt fragment, and input origin
(`task`/`inherit`/`continue`/`fresh`) at start, and automatic review is opt-in by default. `thread.send`
carries `inform`/`request`/`replyTo` directed messages between relationship-bound targets inside one
root task — children, the caller's own parent, and same-parent siblings — recorded durably on the
Thread with `requestId` idempotency; `inform` never starts execution while `request` wakes a waiting
target or continues a settled Thread as a new Run. Execution admission is shared per root session
(`countActiveInRoot`): nested Threads count against the same budget, a Thread waiting on a dependency
(`waitingFor: "thread"`) yields its slot, and queued Threads and parked `pendingContinuation` requests
promote through the same `tryDequeue` gate when a slot frees. Result revisions freeze their publish-time
provenance — the kernel `working.result` record carries `baseRoot` plus per-path `baseStates`/`pathStates`
validated against the published roots — so a later baseline rebase cannot rewrite an older revision's
base. `thread.update` (`threadUpdateBaseline`) rebases the calling thread's working branch onto a
selected parent result revision: a three-way plan keeps the thread's own deltas, adopts parent-only
changes, merges clean text edits, and reports divergent paths as conflicts, while the kernel applies the
complete new delta set and the `baseRef`/`parentRef` lineage atomically under the expected
`writeRevision` CAS. Materialized worktrees use a durable staging/Integration handoff with whole-directory
revalidation before the child branch CAS; unfinished handoffs block publish, resume, restore and reclaim until startup or the next update reconciles them.
Ask/Fresh/Note UI controls call the same durable message service as Pi tools with stable request identities.

Harness `bash` creates and attaches PTYs through that same terminal runtime. The runtime allocates
process-wide `sh_N` identities and rejects owner/creation-identity reuse; the per-session supervisor
owns command framing and output presentation but does not own a second process table. Background
completion comes from the PTY exit event, and process-writer ownership remains live until exit and
release actually complete. Reading output is observation, never the completion trigger (D-209).
User terminal tabs inject generation-tagged OSC 633 on bash / PowerShell / zsh; finished commands
with real command text and exit codes become workspace events and the next Zone 2
`<user-terminal>` section. The parser only accepts this session integration's tagged frames.
`/bin/sh` is not treated as Bash. Command/cwd text is encoded before Zone 2.
`putEvent` is idempotent on `targetPiSessionId + commandId`; one terminal command is projected once
to each active Pi session in the workspace. PowerShell uses the command-start `LASTEXITCODE` baseline
and reports `1` when it cannot prove
that an unchanged native status belongs to the current command. The live PTY path does not replay after
Host restart. Missing integration is `not-observed`, not a guessed command (D-226 / D-229 / D-233).

User plan revisions and child Run reports remain observable facts: the UI plan route observes only its
successful user writes, and Registry return notifications bind the actual Run/report. Nested delivery
resolves the active parent's owning session
instead of comparing its materialized execution workspace to the knowledge store.

Retrieval design D-173–D-179 keeps fast `explore` separate from the longer-running `retrieval` role.
D-227 makes that role a real Thread: `thread.dispatch(preset: "retrieval")` freezes the retrieval model
slot, read-only tools, and scope; the child may call explore/read/related/recall and authorized web
tools, then `submit_facts`. The Host verifies local paths/ranges against Documents and the frozen
scope before marking a source source-checked, copies excerpts and output handles to durable
artifacts, requires a Host URL receipt bound to the exact final URL, and projects the sealed
evidence through `thread.read`, Zone 2, and the existing cancel/lost Thread lifecycle. Nested
retrieval is dispatched onto a normal isolated WorkingState branch and, when a real path is needed,
materializes only beneath a Host/backend-authorized persistent managed root. Its settle path seals
evidence and discards the read-only input without publishing directory changes. Web receipts exist only
for the authenticated active retrieval Run; durable temporary references bridge receipt/artifact creation
to pending and sealed evidence, and `thread.read` pages large bodies by UTF-8 byte range
(D-227 / D-230 / D-231 / D-234). The
application host owns search, current document reads, local embedding instances, derived indexes, and
the short-lived explore query context (fixed input-source reference, actor/scope, candidate producers,
read snapshots, candidate views, shared cancellation/deadline). The pi-host session ModelRuntime uses
`models.explore` to submit grouped search plans and complementary source selections with required spans.
Internal phases update that same query; public `explore` remains one tool call. Candidate model input
precedes final selection/formatting and has a separate input budget. The Host can execute grounded
local follow-ups and must retain required source spans; validating their identity does not validate the
model's semantic judgment. This adds no durable conversation or generic workflow framework. Delivery
state is in status.md. Remote embedding and HTTP rerank are user-owned harness bindings,
not chat model slots. When `harness.embedding` is set, the workspace-worker Pi runtime resolves the
provider endpoint and credential, and the application host submits authorized text through
`harness.embed` without receiving secrets. Unconfigured workspaces use local MiniLM only after the user
installs the optional local semantic component. The base distribution contains neither model weights
nor its dedicated transformers/ONNX runtime, and startup never downloads them. Settings can install a
target-specific component or import its archive; verified installation activates it in the current Host.
Without it, lexical and structural/graph retrieval continue with semantic retrieval unavailable (D-288).
Knowledge recall uses the same remote bind when configured, stores vectors in
a derived generation directory, and stays text-only when remote is unset — it does not fall back to
MiniLM. A configured remote failure reports semantic `failed`/`unavailable` and does not silently
mix the local vector space. Dedicated rerank uses `harness.rerank` on already-built explore views and
is skipped when `models.explore` already selected candidates. See harness sections 6.1, 7.5, and 8.5.

D-312 delivers the [Fast Decision Model](design/fast-decision-model-design.md) capability with the `explore`
consumer wired (F0–F4). `harness.fastDecision` is a user-owned default binding with per-purpose override or
`"off"`; the Pi side resolves it into a credential-free `configurationId` binding that each query freezes.
`explore-fast-decision.ts` runs a progressive loop inside the live query: typed judgments decide which real
views enter the answer and which issued action candidates execute — `followup({actions})` runs them through
the existing search, graph, and file authorities. `pi-host/src/harness/native-classifier.ts` maps these
judgments onto Pi's native classifier APIs. Explore freezes its responsibility plan: with a configured
LLM, the classifier chooses actions while the LLM can select complementary material; without that LLM,
the classifier may judge material before configured rerank or source ranking. An already performed
selection is not repeated by another judge. Disabled, failed and cancelled paths retain available material.
Generative search planning remains separate. Pi inference retains credentials and provider transport; the
decision service does not own search, permissions or action execution. Computer Use and other consumers are
future integrations, not delivered features. See harness status for verification and untested boundaries.

D-315 / Stage L is the [Web and research search extension](design/web-research-search-design.md). Its L0–L6
service slices are wired: generic `retrieval` can return natural-language reports with optional Host-validated
`submit_facts`; `websearch` accepts batch query/objective/URL items with per-item status and
provider-minted pagination cursors; `webfetch` pins fetched bodies to durable `web.snapshot` kernel
records with stable line/find/structural positions, refresh minting new snapshots while old references
keep old content; `research_search` queries OpenAlex/Semantic Scholar metadata, open-access locations,
and paged relation expansion; `materials` owns `material.collection` records and explicit
`material.grant` cross-thread read authorization; `research_decide` runs batch fast-decision judgment
over real Web/scholarly candidates through the `web`/`scholarly` purpose bindings. It reuses ordinary
dispatch and native web tools. Content reuse re-checks the reader's own scope and never transfers
another Run's receipt authority. No parallel search scheduler, body store, or Agent runtime
is introduced. Local and network PDFs share the material reader: `document_read` accepts a local path or a fixed
`snapshotId`, while `materials.read` checks the current Host authority for both. The Host authorizes and fixes
local source bytes; `web.fetch` stores network PDF bytes before probing or parsing. `overview`, `text`,
`page-image`, and `structure` are independent views. Overview returns the original `sourceHash`, available
page geometry and text status without requiring a full text extraction. PDF.js and the packaged Canvas renderer
provide native text and page/crop PNGs without Poppler; a page image does not depend on OCR or structure parsing.

Native layout/text is PDF.js-backed. Docling structure extraction and Tesseract OCR are optional Host-managed
processes configured by the user-only `harness.documentReading` (`doclingCommand`, `tesseractCommand`,
`ocrLanguage`; empty values restore `docling`, `tesseract`, and `eng`). The Host launches the configured
executable directly, never as a shell command string, and reports unavailable components without claiming
they were installed. Each derived analysis records its source hash, selected pages, parser identity/version,
configuration, OCR choice, and analysis id. Docling's CLI `parserVersion` and output `schemaVersion` are
separate facts. Original page/region anchors use `sourceHash`, page, and normalized coordinates with the
rotated page's top-left as origin; structure elements additionally carry their `analysisId`, so a parser
change does not rewrite the original-page anchor or require every page to share one parser version.

`varin-material://` citations open the same authenticated `PdfMaterialReader` in the current Harness panel at
the referenced snapshot, page and optional normalized region. Asking about a selection adds its short citation
and actual crop PNG to the current session draft; the user still submits that input. This establishes the read
and handoff path, not a quality claim for complex layouts, table cells, formula/figure extraction, real OCR, or
cross-platform packaged operation.

`WorkspaceSemanticRuntime` is the production assembly for workspace settings, inference transport,
query views, configuration subscriptions, and shutdown (D-235). Materialized sessions use their
execution Documents workspace; virtual sessions require a pinned WorkingState view. Documents
mutations and successful native Pi journal after events invalidate the same index before the tool
response; embedding proceeds asynchronously. Configuration refreshes precede subsequent queries,
and responses from retired workspace workers cannot replace current bindings.

Session knowledge blocks (plans, todos, user notes, accepted knowledge) remain in the Host store. The
renderer reads and edits them only through
UI-authenticated HTTP routes; SSE carries `{workspaceId, sessionId}` invalidation facts, never block
content. The same UI-auth boundary protects the thread metadata route.

The accepted delivery policy in harness decision D-078 is to implement complete usable paths and ship them
as defaults after focused correctness checks. Replay sets and external tester reports support diagnosis
and optimization; they are not mandatory activation gates. Existing explicit user choices remain valid.
D-284 implements that policy for context: a prepared candidate is committed only while its epoch,
branch, model, compaction boundary, and first-kept entry still match the live session; anything stale
is discarded and compaction starts the same worker mechanism from a new fixed preparation or fails honestly without
truncating history. Host restart never promotes an empty in-memory candidate into durable evidence.
The capability matrix records the remaining implementation boundaries.

### 4.5 Composable workbench and document authority

The product UI is not a fixed shell. A Workbench Profile selects which extension provides
`workbench.shell` and which contributions fill the activity bar, sidebars, editor area, panel, and
status bar. Four profiles ship: `default` (general Workbench), `varin.ide` (IDE Workbench),
`varin.research` (Research Workbench), and `varin.bot` (Varin bot). Their shells are ordinary built-in Varin extensions —
`varin.builtin.agent-workspace`, `varin.builtin.ide-workbench`, `varin.builtin.research-workbench`,
and `varin.builtin.bot-workspace` — so a community extension can
replace any shell, or any individual seam, without a product build. There is no global `ideMode`
branch. `@varin/extension-contract` is the single owner of the target, slot, and context-key
constants, and the profile document is revisioned so every mutation is expected-revision checked.

Each shell contribution declares a **shell seam contract** (`VarinWorkbenchShellContributionDataV1`)
that lists which replacement targets and slots the shell supports per surface (`web`, `desktop`,
`mobile`). The contract is validated at manifest parse time and surfaced in the Extensions settings
page via a pure seam projection. Targets the shell does not declare are hidden from the settings UI;
existing selections for those targets are preserved as **dormant** and can be cleared explicitly. The
six IDE structural targets (activity, primary sidebar, editor, secondary sidebar, panel, status) are
real `WorkbenchReplacement` hosts in the IDE shell, not hardcoded layout. Agent Mobile keeps the
session Sheet/sidebar chrome, safe-area and dismissal behavior in the Shell while replacing only its
navigator content; Settings follows the same Shell-owned-frame rule. `workspace.explorer` is not
declared on mobile. The
`editorActions` and `panelViews` slots receive JSON-safe props (workspaceId, groupId, resourceId,
activePanelId) defined in `@varin/extension-contract`. Managed shells can compose sub-regions via
the `VarinWorkbenchCompositionHost` API in `@varin/extension-sdk`; the React binding provides
`useWorkbenchCompositionHost` and `WorkbenchCompositionHostProvider`. The composition host follows
replacement selection and child owner generations, attributes each mount to the child owner, and
disposes all child mounts when the Shell retires. Isolated Shells remain self-contained in v1 and do
not receive a parent-realm DOM composition bridge.

Contribution `when` expressions read the shared context-key projection. Extension writers are
owner-scoped activation resources: managed candidates stage values locally, isolated candidates use the
same semantics over their MessagePort, and values publish only when the generation commits. A retired
writer cannot mutate or clean up a newer generation. Built-in Settings metadata remains below the
workbench layer, while React page composition and official Shell registration live under
`packages/ui/src/workbenches`.

Profile and layout resolution is layered. Layout layers merge `distribution → user → workspace`, and
profile selection resolves `user → active`. Project navigation cannot replace the selected shell.
Workspace-specific layout layers remain. Shell state is reported truthfully as
`builtin`, `disabled`, `failed`, `missing`, or `ready`. A shell transition stages the candidate and
commits the selection only after it mounts, so a failed, superseded, or revision-conflicting
candidate leaves the previous generation active instead of producing a blank window. When no shell is
active the fixed recovery path stays reachable. The IDE's own layout is a separate versioned
split/stack/editor-area document held by the `varin.workbench.layout` v1 host service in profile-
and workspace-scoped extension storage; missing and empty documents fall back to the distribution
default without writing it, while malformed or failed reads keep the last valid in-memory document
and raise a diagnostic rather than overwriting host state.

D-298 implements the first D-297 slice (7A). The titlebar now exposes a Workbench/IDE/Varin bot mode
dropdown with icons; General/Research stays inside Workbench mode. Shell changes use the existing Profile
and Motion transition transaction. The UI remembers the Workbench return profile per Host while IDE or
Bot is open. This preference survives reloads and never overrides the Host's active Profile. The Research
shell composes shared application chrome and resource panels around
the actual research-root and branch projection. Work focus lives independently in broker-owned session
metadata. Creation resolves explicit selection, then the project default, then general/code. Later project
changes do not overwrite existing sessions. A focus change stages the worker configuration and commits
durable metadata before publishing it; failure retains the previous active configuration. The next new
Run applies the selection; the current Run and its queued follow-ups keep their frozen focus.

Research uses the current user Pi session as its principal model. `ResearchRootRuntime` attaches real
`agent_start`/settle events to Registry Thread/Run records, distinguishing attached roots from spawned
child sessions. Settling detaches the live binding while retaining results and branches. No hidden main
session or parallel research catalog exists. Shell changes do not apply focus, call a model or recreate
sessions. D-299 adds the first capability-routing slice: dedicated research model slots and frozen
branch manifests; D-303 closes local experiments, continuation upgrades and collaboration consumers.
Managed remote and multi-machine execution is delivered by D-305. The product
design is [research-cluster-design.md](design/research-cluster-design.md).

D-300 defines execution and collaboration, with local production slices accepted at D-303. Experiment
specifications and attempts use the existing Rust typed catalog and object domain; Host coordinates
authorization, placement and presentation. Local and managed remote executors reuse the Rust process
core; D-305 implements the D-304 / 7I managed-remote path, while native scheduler adapters are deferred. SSH is an
access/transport mechanism, not proof that a job is alive or stopped. Agent Runs, compute attempts,
connection state and artifact collection have separate lifecycles.

The collaboration layer extends the existing Thread message ledger and tools across code,
research and future office work. Natural-language sends can return immediately or wait for a correlated
reply. A compact roster projects actual task/state and roughly 20 visible characters from the latest
completed visible assistant paragraph, with stable source references. Existing output events maintain
it; no status-report task or summarizer model is introduced. D-305 replaces D-300's changed-row presentation with
a full current request-only tail snapshot for every authorized Agent, while environment deltas remain
in history. Explicit messages and established
waits drive continuation; Host does not classify scientific significance to launch stronger models.
These contracts and the local/remote acceptance sequence are specified in
[plan stage 7](plan/agent-harness-plan.md); current implementation is distinguished from follow-up design in status.

D-304 / 7I is implemented at D-305. Existing connection management reaches a remote Rust executor or Varin
Host; the coordinator owns research intent and placement, while the target owns actual jobs, output and
resource confirmation across clients. Stable target identity prevents separate SSH aliases from becoming
independent allocators. The UI exposes the coordinator location: accepted remote jobs survive disconnection,
but unassigned cross-machine work needs its coordinator to remain running. No duplicate queue owner or
copy of local kernel grants is introduced. Code/data/environment reuse and optional batch operations
support experiments that grow naturally from threads; no mandatory matrix or scientific workflow is added.
Operations Agents reuse ordinary threads and authorized tools for environment preparation and fault handling,
optionally dividing responsibility among several threads as scale grows. Programmatic allocation works
without them. Slurm remains outside current scope; the managed-remote, resource and batch paths are implemented.

Text content has one authority. The application host owns a revisioned document service with
workspace resolve, read, write, move, delete, an SSE watch, and crash-recovery journals, exposed
through authenticated routes and a resource-scoped `workspace.documents` capability. Revisions are
opaque and writes are expected-revision checked. Workspace identities and journals are scoped per
application host, so another host never inherits a same-path selection. Watch events carry resource
metadata only; file bodies never reach logs, event payloads, or URLs. `FilesAPI` remains
browse/binary/CRUD and `WorkspaceAPI` remains project/tree/git/upload — the duplicate text
read/write shapes were deleted rather than kept as alternates.

On the client, a per-document registry keyed by `{workspaceId, resourceId}` holds buffers. It keeps
`missing`, `binary`, `unsupported-encoding`, `deleted`, `error`, and `conflict` distinguishable from a
successful empty read, models a real three-way conflict of ancestor plus disk against the live
buffer, attributes external change to `agent` or `disk`, preserves edits typed while a save is in
flight, and preserves encoding, BOM, and line endings. Editor groups, tabs, providers, commands,
context keys, and the panel container live in a shared Editor Workbench Kernel that any shell mounts;
high-frequency cursor and scroll state stays in memory rather than in broad shared state or
per-keystroke persistence.

Session navigation likewise separates presentation readiness from execution readiness. A cold open
asks the already-running catalog Host to read the persisted branch through Pi's `SessionManager` while
the broker activates the session worker in parallel. The read-only preview can populate the timeline
but cannot accept prompts, mutate the tree, or become a second session authority; the live worker's
snapshot and entry stream take over when ready. Already-open sessions switch without another runtime
request, and failed activation restores the previous selection.

The standard desktop/Web text renderer is one shared Monaco path for both Agent and IDE;
mobile and embedded editors retain a lightweight CodeMirror adapter because Monaco does not support
mobile browsers. Monaco models are high-frequency projections of Document Registry records, never a
second content, dirty, conflict, or save authority. A stable internal document-instance identity lets
multiple views share one model across shell changes and resource moves, while runtime/workspace
generation still bounds every model and asynchronous result. Full custom `editor` contributions stay
engine-neutral and may replace the official renderer. Agent/IDE presentation presets only change live
editor options; user settings override them without changing model identity. Monaco basic language
definitions provide syntax tokenization, while semantic language features remain Host-owned. The
shared language contract preserves rich edits, snippets, untrusted Markdown, navigation, symbols,
formatting and semantic presentation without exposing the language-server process to the renderer.
Monaco registrations and markers are owned by provider generation; a provider restart clears the old
projection and resynchronizes every open document from the current in-memory buffer. Internal language
links route through the Workbench resource opener and external links through Varin's HTTP(S) opener.
Rename and code actions prepare an all-or-nothing Document Registry transaction, review cross-file or
annotated changes, and retain one grouped undo action without writing disk. The bundled TypeScript/
JavaScript service is an ordinary disableable brokered Varin extension: its immutable server asset is
materialized and registered lazily by the Application Host, and the server process exits when its last
document closes.
File diffs use Monaco on desktop/Web without creating another content authority: original and staged
models are immutable, reference-counted snapshots, while a working diff binds its modified side to the
live Document Registry model. A nested Git repository is stored as a workspace-relative view identity,
not as another workspace. Chat/PR patch renderers remain specialized read-only surfaces.
The complete model, language, worker,
extension, and migration contract is
[unified-file-editor-platform.md](design/unified-file-editor-platform.md).

Mobile and embedded CodeMirror views submit offset edits against the same captured Document Registry
revision and consume the applicable subset of the shared language DTO. They are separate Surface
adapters, not a desktop compatibility renderer. Public custom editors use the framework-neutral document controller;
extensions that only augment the official desktop/Web editor can request the optional, owner-scoped
`varin.editor.monaco` v1 service. That service exposes serialized view state and declarative actions
or decorations, never a raw model, DOM node, file authority, or process capability.

Search, language, task, debug, and test capability is host-owned. The application host runs the LSP
supervisor and a standard Debug Adapter Protocol implementation with its adapters, test providers,
and task processes under workspace trust and owner generations; renderers send typed requests and
never start a process. Language failures are typed and distinguishable — including
`stale-completion`, `untrusted`, and `unsupported` — stale results are rejected, and hidden views
perform no background work. Agent file changes reconcile with open editors explicitly. On each UI
prompt, steer, or follow-up, the Document Registry copies that surface's dirty buffers into an
immutable Application Host snapshot. Document text travels only over the authenticated Documents
channel; the runtime request carries an opaque reference or an unavailable dirty-path set. Harness
`explore`, `grep`, and the same-name `read` / `find` / `ls` adapters use that fixed snapshot for dirty paths;
other paths keep each tool's established disk source. Root-session `edit` / `write` / `apply_patch` call Host
`document.surfaceWrite` for snapshot-owned paths and write the same Document Registry buffer after owner,
generation, registration, document instance, revision, and editor-buffer hash checks. The UI `bufferHash` is
the normalized editor identity; snapshot text keeps the file's original line endings and is not compared to
that hash directly. Mixed surface/disk batches first validate all disk byte identities under one Documents
resource gate, then persist an `agent-mutation` recovery operation before the first write. The WAL distinguishes
an explicit failed surface receipt from an uncertain dispatched request, records target-after state, and
compensates unchanged paths with the same undo `operationId`; durable attention rows enter Recovery status/UI.
A crash after a disk write but before target-after capture remains explicit `needs-attention`. A later user edit is a conflict and
does not save or write disk. Ordinary disk paths keep the journaled Documents write. Explicit
selection/diff attachments may still quote text in the prompt, and patch accept/reject uses
expected-revision writes so an agent edit cannot silently overwrite a dirty buffer. An agent attachment may quote a test failure or stack frame but never
confers process, debug, or test-runner capability.
Breakpoint mutations are conditional on the observed debug owner, stack/test decorations are scoped to
workspace plus session/run generation, and delayed results from a retired owner are discarded. The
surface that sends the user input is the Agent context owner; its active view and dirty Document Registry
records determine the captured source. File, selection, diff, inline-comment, and patch-review paths therefore
follow one document identity instead of competing projections.

Surface parity is explicit rather than assumed. Agent Workspace declares web, desktop, and mobile;
the official IDE Workbench declares web and desktop only. The full workbench contract, performance
requirements, and per-slice acceptance criteria are in
[composable-workbench.md](design/composable-workbench.md).

## 5. Versioned host protocol

`@varin/protocol` defines the private worker JSONL envelopes and the message-oriented surface
envelopes:

- request: `{v, kind:"request", id, method, params}`
- response: `{v, kind:"response", id, ok, result|error}`
- worker event: `{v, kind:"event", seq, event, data}`
- surface event: `{v, kind:"event", seq, source:{workerId,role,sessionId?}, event, data}`

Unknown methods and malformed routed events are protocol errors, not silently ignored. Request IDs
are unique within a connection. Event sequence numbers are monotonic within each worker lifetime
and clients track them independently by worker ID. Large binary/file payloads use a separate
bounded stream or file grant rather than JSONL.

`session.entries` returns the complete requested scope as `{sessionId, scope, leafId, entries}` with
no implicit pagination or truncation. The leaf and every entry's
`id/parentId` preserve Pi's branch graph; `scope:"branch"` is the active path and `scope:"all"`
contains the complete append-only tree. Streaming `agent.event` messages contain one canonical
message plus a compact typed delta instead of duplicating Pi's mutable `partial` object.

Protocol v1 also exposes native `session.header`, `session.summary`, `session.tree`,
`session.entry`, `session.stats`, `session.rename`, `session.archive`, `session.unarchive`,
`session.delete`, and `thinking.select` operations. It adds surface-owned project trust responses,
the full extension UI request/state bridge, locked global/project JSON changes for arbitrary
extension settings, path-contained extension-owned JSON documents, and conflict-checked JSONC
documents rooted in the agent directory, trusted project, or standard user configuration directory.
Runtime snapshots carry Pi's actual streaming,
compaction, retry, steering, follow-up, queue, model, and thinking state. Archive state is broker-owned
atomic Varin metadata; renames remain native append-only Pi session-info entries.

Interactive agent inputs may carry a content-free `AgentInputContext`. A surface context names the
workspace, dirty paths, and an opaque Application Host snapshot reference; document bodies never
cross the runtime worker protocol. Missing context means a headless/disk source. SessionHost attaches
the accepted context to Harness requests, while the broker actor remains the authority for session,
workspace, scope, and capability.

An initial handshake requires the single Varin v1 contract and reports capabilities. During
pre-release development every product surface changes in lockstep; no historical Varin ABI is
accepted. UI disables unavailable actions instead of guessing from runtime versions.

The application Host side of that handshake also declares optional Harness services.
`harnessThreads`, `harnessLspNavigation`, `harnessWebRead`, and `harnessWebSearch` gate capability paths before an
AgentSession is created; a dormant provider module or configured model slot is not enough. The Web
Host declares its guarded fetch path for `harnessWebRead`; when a reader slot is configured, pi-host
uses the session's own model runtime over that fetched content. Search remains absent until a real
provider exists, so `websearch` is not exposed as a dormant tool.

### 5.1 Agent harness protocol

The agent harness extends the host protocol with worker→host service
requests. Two out-of-band methods ride on the same broker transport as
`workspace.mutation.request`/`respond`:

- `harness.request` — pi-host sends `{ method, params, requestId, timeoutMs? }`
  to invoke a host-side harness service. Session identity is deliberately absent
  from the worker payload: after create/open/fork succeeds, the broker pins the
  worker and attaches a trusted `actor` to its outer event. The Host resolves that
  actor to the registered workspace and frozen structural capability set before
  dispatch. The optional `timeoutMs` overrides the router's default timeout
  (e.g. `thread.wait` carries a longer timeout).
- `harness.respond` — host replies with `{ requestId, sessionId, ok: true, result }` or `{ requestId, sessionId, ok: false, error: HarnessError }`, matching `HarnessRespondParams`.

The `HarnessServiceMap` defines the following method groups:

- **Shell**: `shell.exec`, `shell.read`, `shell.write`, `shell.kill`
- **Output**: `output.store`, `output.read`
- **Search / fixed document source**: `search.content`, `document.readSource`, `document.pathOverlay`, `document.surfaceWrite`, `document.branchWrite`
- **Filesystem**: `fs.lock`
- **LSP**: `lsp.diagnostics`, `lsp.diagnosticsSnapshot`, `lsp.symbols`, `lsp.definition`, `lsp.references`, `lsp.hover`
- **Web**: `web.fetch`, `web.search` (registered when available). A configured
  reader model runs inside pi-host over the `web.fetch` result, so credentials
  and model resolution remain session-local; there is no second Host model stack.
  Web search adapters run in the Host for Brave, Exa, Tavily, Jina, or a
  user-selected SearXNG endpoint. Provider identity is user-owned, keys live in
  fixed search-only Pi auth entries, and the Host advertises `web.search` only
  when startup configuration is usable.
- **Phase 2**: `zone2.assemble`, `compaction.after`, `todo.upsert`, `recall.search`
- **Phase 3 threads**: `thread.dispatch`, `thread.list`, `thread.wait`, `thread.send`, `thread.read`, `thread.merge`, `thread.update`, `thread.kill`

Each has typed params and result in `@varin/protocol`. The host's
`HarnessRouter` dispatches requests to registered services and the
`HostServicesBridge` on the pi-host side resolves the response promise.
The router creates an `AbortController` per request, aborted either by
the per-request timeout or by session shutdown. Services that block
(e.g. `thread.wait`) race on `ctx.signal` so they stop promptly.

Both sides default to a 30s timeout, which a deliberately long call has
to override: `thread.wait` asks the bridge for the wait duration plus a
buffer, the bridge carries it in `harness.request.timeoutMs`, and the
router clamps it to `HARNESS_MAX_REQUEST_TIMEOUT_MS` (1 hour) so a
worker cannot pin a host handler open indefinitely.

Host authorization is non-interactive: `HARNESS_METHOD_CAPABILITY` maps every
method to a structural capability, and path-bearing shell/search/LSP/lock calls
must remain within the actor workspace and the broker-pinned child scope when
one exists. User-facing allow/ask/deny stays at Pi's `tool_call` boundary:
Varin's built-in permission gate is the sole interactive authority for Harness,
Pi built-ins, MCP tools, package tools, and nested-thread tools. It derives the
actual source from Pi's active tool registry and asks the Host to canonicalize
filesystem targets before a decision; unknown or incomplete third-party side
effects ask rather than inheriting authority from a tool name or annotation.
Scope constrains Host-visible paths and search results; it is not an OS sandbox and
does not constrain paths embedded in shell text or Pi tools executing inside the worker.

Large tool output uses an ephemeral `OutputRef` signed by the current Host
generation. FIFO sequence watermarks distinguish `expired` from `not-found`,
and `output.read` offsets, lengths, `nextOffset`, and totals are UTF-8 bytes.
Durable thread reports instead carry a `TranscriptRef` into the Pi session file;
`thread.read(steps)` resolves it through broker-owned session entry reads.

`fs.lock` acquires a complete path batch. The Host resolves every path through
the Documents authority, de-duplicates canonical identities, orders them by
`{authorityId, workspaceId, canonicalResourceId}`, and returns owner-bound
lease IDs. Release carries only a lease ID; a stale path or another session
cannot release the current holder. This is in-process coordination for
Harness-managed writes, not an OS lock over terminals, Git, external programs,
or another Varin Host.

### 5.2 Thread protocol (§9.3)

Thread operations use the harness service protocol. The thread registry
is the single source of truth for thread state, persisted to
one versioned, atomic catalog per workspace under
`VARIN_DATA_DIR/threads/<hostId>/`. The filename is the SHA-256 of the
workspace identity and the document stores `{ schemaVersion, workspaceId,
threads, runs }`; parent sessions and nested threads are graph edges, not
storage owners. Startup reconciliation marks interrupted `starting`/`running`
attempts as `lost`, while malformed, unreadable, and future-schema catalogs
remain distinct failures.

`Thread` owns four independent dimensions: lifecycle
(`queued|active|settled|archived`), attention, integration, and its parent edge.
`ThreadRun` owns one execution attempt (`starting|running|lost|exited`) and its
outcome, session, metrics, and exit reason. A restart ends the old Run as
`lost`; resuming creates `attempt + 1` without rewriting history. Event
sequences resume from the persisted workspace maximum.

The Web/Application Host advertises `harnessThreads` during the private Host
handshake. Only then does pi-host register thread tools. Dispatch atomically
persists a Thread and `starting` Run and returns before worktree/session setup;
the background runtime creates a real persisted Pi child. Its
`ThreadLaunchManifest` freezes scope, worktree mode, preset prompt fragment,
whether the parent block snapshot is carried, and active tool names, while the resolved model is supplied at `session.create`
time. Pi therefore constructs the child with the correct model-family tools
and a read-only preset cannot regain write tools merely because the global
settings expose them. Opening the child from the UI supplies the same frozen
launch values again.

User archive and restore stay on the same catalog and Host runtime. Archive
keeps results, the transcript reference, and the original Pi session file;
restore rematerializes the published result at the recorded path or reports
that the path is occupied. Thread occupancy and reclaim reasons are Host
projections, not a second store.

User-created discussions use authenticated, session-scoped Host routes: the
caller supplies only a persisted message entry and the block-snapshot choice;
the Host derives the parent edge and workspace from the broker-owned session.
The child receives only read-only tools that are actually active in the parent
and remains attached after each `agent_settled`, with `user` attention meaning
it is ready for the next message. Converting a discussion creates an isolated
worktree, ends the discussion Run, starts a new implementation Run, and
reopens the same durable Pi session with the parent's implementation-capable
tools. The conversation therefore continues while the worker/tool boundary is
rebuilt at the only point where a tool-set change is allowed.

Isolated work starts from the parent's full working state. A private baseline
commit inside the child worktree separates pre-existing parent dirt from the
child delta; merge preflights untracked collisions before applying tracked
changes and reports whether Git wrote conflict entries or left the parent
unchanged. One unexpected worker exit automatically creates a new Run in the
same session/worktree. A second consecutive crash becomes `stalled`, avoiding
an unbounded crash loop. Event silence, six identical tool signatures, and
interactive UI requests project `stalled`, `looping`, and `user/permission`
attention without stopping the Run.
Before the broker deletes a parent Pi session file it awaits an Application
Host coordinator. The registry enters draining mode, stops active child
workers, cancels queued/active Runs, and archives every direct child; dequeue is
suppressed throughout so deletion cannot resurrect queued work.
Deleting a child session directly archives its owning Thread and clears the
report whose TranscriptRef is about to disappear; completed Run history keeps
its original outcome.

Thread params do not carry parent or workspace authority — the service resolves
the session parent and workspace from the trusted ActorContext. Observer cursors (`ThreadViewCursor`) enable
incremental views: `thread.list` and `thread.wait` only show changes
since the observer's last cursor. `thread.wait` blocks until a thread
changes state, the timeout fires, or the abort signal fires.

Concurrency is enforced by the registry and shared per root session
(`countActiveInRoot`, 3.18C): a slot is occupied only by an active implementation
Thread whose current Run is `starting` or `running` and which is not waiting on a
dependency (`waitingFor: "thread"` yields its slot while blocked); `queued` means
created but not yet spawned, so it holds nothing. Every Thread under the same
root session — parent and nested children alike — counts against the same
budget. pi-host sends the parent session's frozen
`harness.dispatch.concurrency` with each dispatch (default 12; no unrelated
hard ceiling). When the root count reaches the budget a dispatch is
queued, and any terminal transition promotes the oldest queued Thread or
parked `pendingContinuation` request through `tryDequeue` — ordered by the
parked time or `createdAt` — whenever a Run ends, a queued Thread is cancelled,
or a waiting mark frees admission. `onAdmissionFreed` then drives the deferred
lost-run resume recheck.
Tearing a parent down suppresses dequeue: promoting a queued thread
there would resurrect work the user just deleted.

`HarnessSettings` (in `harness-settings.ts`) configures shell
interpreter selection, output truncation budgets, per-tool enable flags,
the permission mode, model slots, and dispatch concurrency. Thread-runtime
availability is Host capability, not a setting: a Host without a real registry
and spawn runtime cannot expose tools that only fail. The
Settings page contribution lets users toggle tools like grep; when
disabled, the next session does not register the tool and Pi falls back
to its built-in equivalent.

## 6. Data ownership

The following table describes current ownership. Native working state now owns published thread results;
Git and copy directories remain materialization and migration backends as specified immediately after it.

| Data | Authority | Varin behavior |
| --- | --- | --- |
| Pi session tree/messages | Pi SessionManager JSONL | Read and navigate through the SDK; conversation-only rollback stays Pi-native |
| Models/auth | Pi ModelRuntime/AuthStorage + layered native `models.json` | Never mirror secrets into renderer storage; preserve source provenance |
| Pi settings/packages | Pi SettingsManager/PackageManager | Scope-aware JSON settings, extension-owned config documents, and native package updates with source/provenance shown |
| App metadata | Atomic Varin JSON | Archive state and optional session workspace binding now; recovery preference, pin, tags, and view preferences are application-owned additions |
| Project workspace preferences | `~/.config/varin/projects/<path-id>.json` | One Varin-owned, path-derived authority for worktree setup, notes, todos, plans, draft starters, and project actions; writes preserve unknown fields, reject malformed JSON, and fail on external revision conflicts instead of overwriting them |
| Conversation and file rollback | Pi session tree + selected `varin.workspace-recovery@5` Host service | Pi owns branch navigation; the recovery provider journals only affected paths and coordinates the two operations |
| Optional Pi recovery commands | User-installed `pi-workspace-history` / `pi-wtf` packages | Remain ordinary Pi CLI extensions and are not provisioned or treated as Varin recovery authorities |
| Magic Context | Its shared SQLite/config | Read through a maintained adapter; do not duplicate memory state |
| Native harness thread lifecycle and working state | Host atomic Thread/ThreadRun catalog + Pi child session JSONL; Rust content-addressed WorkingState/result/draft/retrieval, recovery/Integration/agent-mutation durable metadata, canonical file resources, fixed baseline/materialization and managed-directory lifecycle; Document Registry remains unsaved-buffer authority | Dispatch asynchronously, project broker events/Fleet/UI from one registry, preserve attempts and transcripts, publish immutable native results, and merge only the child delta; TS coordinates Registry receipts and Git semantics while controlled disk capture/apply, baseline body capture, immutable-root materialization, reclaim and measurement use the Rust R2/R3 file-resource backend |
| MCP | Pi native MCP or the user's replacement extension | Observe the active owner's config/status, invoke its commands, and edit one authorized source at a time without a parallel connection or credential owner |
| Web Access | Varin native `webfetch` / `websearch`; optional `pi-web-access` config/custom entries | Native search defaults to keyless Exa with disclosed Parallel failover; explicit user providers remain available. It does not reuse model-account search. Host-owned SSRF/domain/provider authority and the existing page cache/source projection remain shared. Tools never auto-yield to a package; optional plugins keep their own configuration and stored-result UI. |
| Varin extensions | Varin Extension Manager below `VARIN_DATA_DIR` | Keep installation, desired state, grants, layout, and extension-owned storage separate from Pi packages and plugin-native data |
| Workspace and user knowledge | Per-host workspace/user `.tdb` under `VARIN_DATA_DIR` | Settings catalog and suggestion accept/edit/retire mutate this store with opened-revision CAS; proposals use the authenticated actor workspace, atomically deduplicate against all history, and consume the session's trusted auto-accept policy. Vectors are derived and must not become a second write authority |
| Workspace text documents | Application-host document authority; the file on disk | One revisioned read/write/watch path with opaque revisions; never a second text shape in `FilesAPI`/`WorkspaceAPI` |
| Workspace identity and document recovery journals | Per-host records below `VARIN_DATA_DIR` | Scoped to the owning application host; another host never inherits a same-path selection |
| Workbench profiles and layout layers | Revisioned profile document in extension host storage | Expected-revision mutations; distribution/user/workspace layering; profile selection never silently changes the desired extension set |
| IDE editor layout | `varin.workbench.layout` v1 service, profile- and workspace-scoped | Missing/empty use the distribution default without writing it; malformed keeps the last valid document and raises a diagnostic |
| Open editors and unsaved buffers | Client Document Registry and Editor Workbench Kernel; Host owns immutable per-input snapshots | Dirty buffers and view state stay client-owned; authenticated fixed snapshots feed explore/grep/read/find/ls and dispatch without becoming a second live editor |

### 6.1 Working-state architecture (D-078 / D-079)

Thread and ThreadRun remain the coordination and execution objects. The Application Host owns a
content-addressed working-state store: immutable file objects and path trees, a fixed branch baseline
plus its delta, and versioned result publication. Materialization supplies an actual directory whenever
Pi tools, a language server, an extension, or a command needs filesystem access. Controlled virtual
read and text-mutation tools use the same fixed branch view; live shared mode remains explicit.
User Thread history release removes selected old result versions after rechecking active consumers
under lifecycle/storage/Registry serialization (D-239). Current branches, reports and transcripts are
retained. Metadata is published before reference removal, new writes hold temporary ownership until
publication, and startup reconciles derived references against the durable catalog. Physical collection
uses all remaining owners; completed Integration undo retains its independent safety/target objects.
Same-name `edit` / `write` / `apply_patch` on an isolated Run commit WorkingState deltas with
`writeRevision` CAS and do not write the parent directory. The first bash or LSP navigation tool
freezes that revision, waits for in-flight virtual writes, materializes into staging, and atomically
switches the Run. A failed or cancelled switch re-reads the execution view and keeps the virtual
branch authoritative; crash recovery uses the persisted switch journal so the live path is never
half-switched. After a successful switch, commands write the materialized directory and settlement
folds those changes into a new result before that directory may be reclaimed (D-213 / D-217).

The baseline includes captured disk inputs and revisioned drafts from the window that submitted the
user message. The surface retains mutable-buffer ownership. `thread.dispatch` clones fixed draft
bytes and their revision provenance into persistent WorkingState before creating the Thread; queued and
restarted Runs no longer depend on the ephemeral surface reference. Missing draft content rejects the
dispatch rather than substituting an unlabelled disk version. Isolated dispatch then fixes the
non-draft disk baseline when it creates the WorkingBranch: Git inventories HEAD plus staged,
unstaged, tracked, deleted, and non-ignored untracked workdir bytes; non-Git and unborn repositories
perform one cancellable directory capture. A Git command failure, capture-window parent write,
active Documents writer, or gitlink fails the dispatch instead of inventing a complete branch
(D-218). Parent drift after that boundary cannot enter the child
view. Failed or cancelled capture deletes the Thread (D-214).
A nested isolated child copies the parent branch effective view when the parent is still virtual, or
captures the parent materialized directory otherwise (D-215). Nested merge applies the grandchild
result onto the parent branch or parent worktree; the parent later folds its published result into
the workspace. Directory apply keeps the recovery object library on the owning engine root and writes
the materialized parent through the execution workspace Documents gate (D-219 / D-222).
Branch parent apply is a durable Integration with retry and undo. Child workspace, scope, and the
frozen permission overlay inherit or narrow and enter `session.create/open`; Host rejects expansion,
absolute scope paths, drive-letter paths, and a complete `..` segment, not names that merely contain
consecutive dots (D-223). Nested `captureScopes` inherit the parent WorkingBranch freeze.
Killing or archiving a parent walks descendants in stable post-order and enters each child's own
lifecycle serialization before the parent; restore is refused while an ancestor is archived or the
cascade is in progress (D-223). Role tools come from
the child's own launch manifest.
Whole-Thread deletion first records one operation and the next phase on every node. Descendants reach
their registry commit point before the parent; failed cleanup leaves a durable retry state and startup
resumes it. Session knowledge and retrieval evidence references are required phases (D-254).
Owning workspace (Thread catalog, WorkingState, knowledge, parent/child lifecycle) is distinct from the
execution workspace Documents assigns to a scratch or materialized cwd (D-216 / D-222). Thread services,
Zone 2, lost resume, symbol graph, and knowledge/recall/suggestions read the Host session binding after catalog
reconciliation; they do not treat `ctx.workspaceId` as the catalog key or skip a thread tool allowlist
when the owner is missing. Git materialization uses `git worktree add --detach` (writes `.git/worktrees`) or an
independent `git init`; child Git commands must not discover or mutate the user repository.
Every scratch/worktree record persists its absolute `managedRoot`. Before inspect, snapshot,
materialization, setup, Git attach, reclaim, or discard, the runtime checks canonical containment for the
main and adjacent staging/result paths and asks the Host/backend to re-authorize that root. A persisted
record cannot authorize itself after restart. Application-host virtual scratch lives under
`VARIN_DATA_DIR/thread-scratch/<workspace-hash>`; an old record without managedRoot is refused for
automatic filesystem operations (D-231).
`worktree.base` remains the parent-state identity. Inspect, snapshot, and settle use the execution
repository's persisted `executionBaseline` after init, detach, crash recovery, or rematerialize
(D-220). Reclaim drops that SHA with the deleted child objects. Working-branch reads re-fetch the
current view after the store lease; an explore query copies one immutable snapshot in that lease.
Default new-file mode is computed from umask, never by writing a probe file in the user tree.
Dispatch fingerprints include dirty-path content identities and Git index modes so a mid-scan replacement
or executable-bit change cannot mint a mixed baseline. Materialized settle snapshots before native result
publication, captures the actual worktree bytes, and rechecks the snapshot before committing; it never
replays custom filters or contacts LFS during result publication (D-254).
Nested merge takes parent write/switch authority first, then chooses branch or directory authority,
then opens the store or directory (D-221). No path may hold a WorkingState exclusive lease and then
wait on `VirtualWriteGate`. Branch integration persists an applying intent before the parent CAS and
reconciles before/after slices at startup; generic disk reconcile skips `targetKinds: "branch"` rows.
Startup directory reconcile must resolve the execution Documents gate from the persisted parent
directory; failure is needs-attention, not an owning-gate write (D-222). Queued dequeue passes the
frozen manifest overlay into `session.create`.

Explicit `harness.worktree.copyIgnored` roots are frozen in WorkingBranch `captureScopes` (current catalog schema 4).
Narrow result publication enumerates only those roots, their baseline descendants, and current descendants,
so ignored modifications, additions, and deletions survive result publication and reclamation without a
workspace-wide rescan. Obsolete WorkingState schemas are rejected rather than migrated (D-253/D-254).

Parent-session `explore`, `grep`, and the same-name Pi `read`, `find`, and `ls` overrides consume the immutable surface input.
An isolated Thread Run with a WorkingBranch binding instead consumes `fixed base + branch delta/tombstone` through the same
Host services; exclusive overlays do not merge parent or worktree disk. Search removes dirty disk hits before its bounded
backend counter and merges fixed-draft hits before ranking.
Read asks the Host only to choose disk, fixed draft, or working-branch bytes, then delegates pagination, truncation, and
disk images to Pi's native read definition. Path overlays ask the Host only for
relative fixed file and virtual directory identities plus revisions, then merge
them with native fd/filesystem results through Pi's definitions before limit and
byte truncation unless the overlay authority is the working branch. An unavailable dirty or branch source never falls back to disk. LSP and
fixed-revision sessions remain the next read-view consumers. Surface snapshots
currently describe dirty text file existence only; deletion and rename
tombstones are not represented.

Integration records the selected child result, expected parent states for affected paths and drafts,
actual per-path application, conflicts, index effects, and recovery operations. Existing recovery object,
path-state, and conditional-compensation implementations are reused, with independent working-state and
result retention references. Deleting recovery history cannot delete a still-referenced thread result.
Revision checks coordinate controlled writers; they do not claim atomic isolation from arbitrary native
processes. Conflict resolution and undo preserve later user edits and unrelated staged changes.
Surface targets are classified from Documents dirty publications for the workspace resource, planned with
the same three-way rules as disk, and applied through Document Registry as one unsaved undo group keyed by
the Integration operation id. Unavailable or drifted buffers keep the child result and do not write disk.
`merge-ready` is a bound preview, not “files changed at settlement”.
Published results can carry Host verification records: the actual commands, cwd, exits, and whether
those observations can be bound to that revision. Child-result checks, merge applicability, and
post-merge parent checks stay separate facts. A default, non-blocking review thread may run against
the stored result diff after publish; it does not copy the parent conversation. Command observations
bind authority/session/worker generation/Run plus start and end input identities. Git identity combines
the immutable base or HEAD with states for staged, unstaged, tracked-mode, non-ignored untracked, fixed
draft, and explicit capture-scope changes; this avoids a normal-path whole-directory scan. Non-Git input
without an equivalent fixed identity is reported as uncertain. A parent verification window is keyed by
the applied Integration operation, result revision, and parent session and survives Host restart.
Review completion is keyed by its result, review thread, and review Run, so a late old run cannot satisfy
a new gate (D-207/D-210).

Git trees and resultCommit are valid migration inputs and backend references. Publication switches to
the new authority only after its records and content are readable; failure preserves the previous source.
There is no permanent dual writer. Git can continue as a materialization or export backend, while copy
and filesystem copy-on-write support non-Git and unborn repositories. Writable dependency/build trees are
not hard-linked to the parent by default. Ignored status does not determine whether data is disposable.
Reclamation follows actual result retention and process use, with observable disk usage and configurable
budgets instead of guessed fixed limits. Full capture costs belong to branch creation/update when needed,
not to every prompt or rollback; Merkle sharing does not make initial capture or file hashing constant time.

The detailed contract and implementation sequence are in
[agent-harness.md](design/agent-harness.md) section 9.2.5b and
[agent-harness-plan.md](plan/agent-harness-plan.md) sections 3.4–3.5. These are accepted implementation tasks,
not a candidate direction awaiting a separate benchmark or another consumer.

The implemented disk path uses the recovery engine's selected storage, catalog, file-state primitives,
and workspace lease. Native results are immutable and addressed by branch plus result revision; legacy
Git results are imported before integration. Default integration leaves the user's Git index untouched.
Its final compare/apply/verify and compensation share the same canonical path queue as Documents
read/write/move/delete in that authority instance; directory operations cover descendants while unrelated
paths remain concurrent. This queue does not cover raw filesystem or shell writes in other execution paths.
Reclamation holds the Documents writer barrier through deletion and preserves materializations used by
controlled processes or editor surfaces. Fixed-revision LSP, surface-buffer integration, and the full space
budget UI remain separately tracked in [status.md](status.md); their helper
types do not count as delivered product paths.

## 7. Pi extension integration architecture

### 7.1 Generic bridge

The host implements Pi's standard extension UI primitives: select, confirm, input, editor,
notifications, status, text widgets, title, and editor text. Requests with responses are abortable
and tied to the originating worker. TUI-only custom components are rendered by their own extension
into a surface-owned read-only panel, so Varin does not copy the component's private view model.

Commands, custom session entries, tool details, and extension errors have generic renderers so an
unknown package remains usable before a first-class adapter exists.

The Plugins settings page is a direct client of Pi's typed
`package.list/install/setEnabled/update/remove`
operations. It does not maintain an OpenCode registry, copy extension files, or restrict package
sources: recommended cards are only shortcuts, while any source accepted by Pi's `PackageManager`
can be passed through unchanged. Package mutations target the current live session when one exists,
so Pi reloads the real extension instance; otherwise they use the current workspace catalog context.
Disabling a package keeps its installation and native configuration intact, filters all Pi resource
types from that package, and restores the package's previous native filters when enabled again.

Pi's native MCP, codemode and tool-search factories are the session defaults. They are replaceable
builtins: a user extension that registers the same integration owns it instead. Varin no longer
automatically installs `pi-mcp-adapter`; existing installed, disabled, removed and explicitly restored
package choices retain their native state. Foundational provisioning still uses ordinary Pi package
operations and its existing receipt, not a second package manager. A configured source whose artifact
is missing is reported as broken rather than silently repaired. Settings can explicitly restore an
optional integration. Varin does not auto-update these packages or materialize plugin defaults.

The provisioning receipt is Varin application policy stored under the canonical agent directory at
`varin/package-provisioning.json`. It records only integration identity, intent, and observation;
plugin versions, configuration, credentials, and private state remain Pi-owned. All package writes
for one agent directory share the same cross-process lock and reconcile the receipt after Pi reports
the resulting package catalog.

### 7.2 First-class adapters

- **pi-subagents:** task tree and controls from its event bus; lifecycle artifacts for restart and
  cross-process reconciliation. Fleet consumes its public in-process RPC `fleetStatus/v1`
  projection as the `delegated-agent` provider; private run identifiers and artifact paths remain
  host-side, while the plugin's own inspector/stop/doctor commands retain their validation and
  selectors.
- **pi-background-tasks:** Fleet, not Plugin Settings. The Host speaks the published EventBus v1
  channels (`request`/`response`/`terminal`) and projects running and recent background agents or
  shell tasks. `command`, `cwd`, output paths, PIDs, and delegate/Fusion artifacts never cross to
  the renderer. New-task, bounded logs, and stop use `fleet.action`; Varin does not read `.pi/tasks`
  or parse terminal text.
- **pi-hermes-memory:** one Host-resolved global JSON authority,
  `<active Pi agent directory>/hermes-memory-config.json`. Project Markdown and SQLite stores are
  data, not settings. Runtime observation is the registered `memory-insights` command only.
- **Magic Context:** plugin-owned user/project JSONC configuration, registered `ctx-*` session
  operations, native Pi status component, and persisted public custom entries. Memory,
  compartment, historian/dreamer/sidekick, and diagnostic views read only future public
  plugin/database contracts rather than copied or privately inspected state.
- **MCP:** the session observes its active native manager or replacement extension through
  `varin.mcp/status/v1` and the credential-free config snapshot. Native Pi owns transports, OAuth,
  credentials, tool exposure and reconnects. Native `mcp.json` sources are strict JSON; an installed
  `pi-mcp-adapter` retains its own JSON/JSONC sources and public catalog RPC. Both paths exclude
  arguments, environment, headers, tokens, OAuth data and URL query/user information from status.
  Native settings edits use the existing authorized, revision-checked, locked atomic document writer.
  Enable/disable updates the live owner without a second connection or a Varin OAuth callback route.
  Codemode executes in native QuickJS; child calls still pass Varin's permission and resource hooks.
- **pi-web-access:** Varin edits the extension's agent-level `web-search.json` and discovers its
  current registered commands in the active session. The GUI can open the native Curator, invoke
  Gemini Web account diagnostics, and browse the plugin's stored results. Those plugin commands,
  credentials, health/activity state, persisted results, and optional Curator server remain
  extension-owned. Installing the package does not replace Varin's native `webfetch`/`websearch`;
  users who want a third-party same-name tool explicitly disable the corresponding native tool.

PiDeck-installed local extensions are not product dependencies. Local working trees and other Pi
package sources remain installable directly, and the generic UI bridge allows unknown packages to
work without a Varin-specific adapter.

The page boundaries, native authorities, risk treatment, and adapter acceptance criteria are
defined in [plugin-gui-design.md](design/plugin-gui-design.md). The imported Magic Context, OpenAgent, and
Agent Orchestration screens have been retired; their capability disposition remains documented
there rather than leaving an OpenCode compatibility surface in production code.

### 7.3 Separate Varin extension platform

Varin product/workbench extensions are not Pi packages. They have a separate application-
host manager, manifest, lifecycle, state, asset, contribution, and service model. Pi integration
adapters consume the existing typed Varin protocol while leaving the Pi package independently
installable, configurable, enabled, and usable from the Pi CLI.

The first platform slice is implemented by `@varin/extension-contract` and
`@varin/extension-host`: the application host owns a revisioned catalog and stable identity below
`VARIN_DATA_DIR/extensions`, every applicable Web-derived surface exposes that application-host
catalog rather than the selected Pi Runtime through its Runtime API, and `/extensions/recovery`
remains usable without the main renderer. This slice stores desired and reported actual state but
deliberately executes no third-party code.

The second slice is implemented by `@varin/extension-surface` and the shared UI Surface Registry.
Activations stage owner-scoped contributions and services before one atomic publication; a failed or
superseded candidate leaves the prior generation active, and deactivation withdraws visible records
before asynchronous cleanup. Retained layout references, replacement selection, ordering, and
per-realm actual state live in the registry. Settings pages/sidebars/search and primary Command
Palette commands are now statically linked built-in extensions using that same lifecycle rather than
hard-coded render switches.

The third slice adds `@varin/extension-sdk`, `@varin/extension-react`,
`@varin/extension-loader`, and the content-addressed artifact layer in
`@varin/extension-host`. npm, Git, local, and built-in sources produce immutable browser bundles;
the application host returns authenticated bytes rather than credential-bearing module URLs. A
Surface verifies those bytes, stages every compatible entrypoint plus its styles and object URLs, and
uses one revision-checked candidate-selection transaction. Activation or catalog-commit failure keeps
the previous selected version and active generation. Web and bundled Electron use the same loader
contract.

The platform makes built-in pages and workflows replaceable above a narrow recovery kernel, supports
declarative, managed, isolated, and explicitly trusted-native Surface entrypoints, and defines
truthful dynamic-disable guarantees for each mode. Its target architecture is specified in
[varin-extension-platform.md](design/varin-extension-platform.md). None of those entrypoints authorize
loading Pi extension code or private plugin state in the renderer.

The workbench shell itself is now the largest consumer of this platform: both first-party working
shapes are built-in extensions selected by profile, and the public authoring surface ships through
`@varin/extension-sdk`, `@varin/extension-react`, and `@varin/extension-cli` templates. See
section 4.5 and [varin-extension-authoring.md](ops/varin-extension-authoring.md).

### 7.4 Conversational settings and Agent administration (delivered, D-306–D-311)

[agent-settings-design.md](design/agent-settings-design.md) defines Stage S in the
[harness plan](plan/agent-harness-plan.md#阶段-s对话式设置与-agent-管理d-306). The implemented core field slice makes Settings UI and Agent tools share
discovery metadata, validation sources and owner-backed operations across the existing settings surface.
Application settings, Pi configuration/resources, extensions and client-native behavior retain their
current authorities; the design does not add a settings database or a second Agent-only writer.

A short stable entry advertises the capability. Search returns enough information for simple updates;
targeted reads disclose effective values, provenance, supported scopes, dynamic options and complex
examples on demand. Skills explain compound workflows, while tools supply live facts and execute
operations. Existing login, installation and connection services keep their action/lifecycle semantics.

Target resolution distinguishes owning workspace, execution Host and client Surface. Partial updates
and revision checks preserve concurrent edits; reset removes an actual override. Saved and applied
state remain distinct, frozen Run configuration changes only at its legal boundary, and a tool must
not synchronously reload its own executing session. UI and Agent consumers receive the same owner
state without a write-back loop. Native permission enforcement and credential ownership remain intact.
The shared catalog, app/Pi field path, domain-action adapters, authenticated client-Surface application,
per-owner compound updates and product Skills are wired. UI authentication first grants one exact
session/Surface connection; the Host consumes that binding and checks the broker session again for each
client operation. A session with multiple live Surfaces is deliberately ambiguous instead of accepting a
model-supplied selector. Real asynchronous owner operations use typed kernel identities and status/cancel;
awaited owner calls report their terminal result directly. Entries without an owner API stay unavailable.

### 7.5 Session follow-ups and triggers (delivered, D-307–D-311)

[agent-follow-up-design.md](design/agent-follow-up-design.md) defines Stage W. The implemented slice lets Agents register
conditions and continuation intent against existing sessions/Threads; time, authoritative events and
deterministic source checks decide when facts are delivered. Semantic judgment belongs to the resumed
work at a chosen checkpoint, not a model call for each log chunk or status poll.

Registration may be nonblocking. An explicit waiting action yields model execution and suppresses
Goal's automatic continuation/audit while preserving the objective and actual process resources.
Active targets receive facts through existing request preparation/messages; idle targets with continuation
intent resume through the same broker admission and idempotent delivery path. User input, normal
continuation and trigger delivery must not start duplicate runs or revive cancelled/deleted targets.

Host policy stores lightweight definitions, source positions and occurrence/delivery identities through
the existing Rust durable storage boundary. Pi sessions, Thread/Run, processes and experiments retain
their owners. Ordinary shell lifetime is not upgraded by persisting a follow-up. Existing GUI/CLI/Markdown
calendar tasks share trigger management while preserving their new-session target semantics; actual
run/Goal completion replaces the scheduler's former dispatch-accepted success interpretation.
Time, durable experiment, artifact, file, metric, log, external, ordinary-shell and manual sources, durable
occurrence delivery, Goal waiting, scheduler terminal tracking, managed-remote reattach, Thread/session
lifecycle settlement, kernel workspace enumeration and calendar-task Agent management are wired. Literal
log and live shell reads retain byte cursors and boundary overlap; registration reads output already owned
by the supervisor before subscribing to new chunks. Cross-source `all`/`any` uses hidden leaf definitions;
compatible owner subscriptions and external queries are shared. Thread delivery uses the same directed
message ledger, target lock and admission path as `thread.send`. A local shell is intentionally unavailable
after its owning Host exits, and source events cannot be promised durable before their owner has delivered
them to the Host.

## 8. Recovery model

Conversation-only rollback remains Pi-native: it branches Pi's append-only session tree and restores
editable user text/images without touching files. Combined rollback uses the selected
`varin.workspace-recovery@5` Host service, whose distribution default is the statically shipped,
replaceable `varin.builtin.recovery` extension.

The provider records a lightweight checkpoint for a bound user turn. Pi's built-in `write` and `edit`
tools negotiate a blocking mutation boundary with the Application Host: the old state of the one target
path is durable before the original tool writes, and the final state is recorded afterward. New
sessions and ordinary turns never establish a complete workspace baseline.

Pi recovery navigation reports which entries leave the active branch. The provider folds only the
change sets attached to those entries and restores their affected paths. Matching paths execute
directly from the message action. Later user edits, dirty buffers, incomplete shell/external coverage,
or the always-ask preference produce the small recovery chooser. There is no normal full-manifest
planner, global maintenance mode, safety archive, or new-workspace fallback.

Before applying an inverse, Varin stores the current versions of affected paths for compensation and
redo. A Host restart resolves an interrupted operation from that small set. Generic native processes do
not expose a portable pre-write file list; watcher-only `bash`, terminal, Git, extension, or unrelated
process changes are marked incomplete instead of causing a full-workspace scan.

Storage location, verified transfer, cleanup, and explicit deletion remain provider-owned and
replaceable. Conversation-only fallback remains available when no provider is selected. The complete
contract is documented in [native-workspace-recovery-design.md](design/native-workspace-recovery-design.md).

The v5 provider coordinates dirty buffers across connected document surfaces before affected-path
inspection, uses a durable shared/exclusive lease for cross-process workspace-local storage, and maintains
workspace-scoped object references for configurable retention. Retention has no guessed default ceiling;
configured limits preserve named checkpoints and nonterminal or attention-required operations.

## 9. Trust and security

Project-local Pi resources, MCP commands, and credential command sources can execute code. Project
trust is therefore a host gate, not a decorative preference. The UI shows source, command, cwd,
environment key names, and capability changes before activation.

Workspace containment treats the configured root's `realpath` as the canonical boundary. The
configured spelling may be a symlink, junction, or Windows 8.3 alias and therefore does not need to
be textually nested inside its canonical spelling. Requested paths still pass lexical traversal
checks first, and every existing target or nearest existing parent must resolve inside that one
canonical root before it can be read or written.

See [security.md](design/security.md) for the threat model and release gates.

## 10. Runtime selection

Desktop and the local Web UI can load while their runtime starts. Normal startup resolves only
the user's explicit selection, or bundled Pi when nothing is selected; it does not search PATH or
detect package managers for unrelated installations. The lifecycle starts the production broker
directly: Node starts, the three Pi SDK packages resolve, and that worker's Host handshake must
succeed. No disposable probe worker precedes it. The minimum supported Pi is 0.99.2. The selected SDK
receives the shipped Host integration patches in memory; external installation files are never edited.
Already adapted sources are unchanged. A changed required SDK seam fails explicitly with an adaptation
error. Newer versions have no artificial version ceiling. An older Pi is upgrade-required only. There
is no version ceiling, downgrade action, or silent upgrade. Cloud and headless Web still require a
ready runtime before the server finishes starting.

Onboarding and Settings activate or install through `RuntimeAPIs.piRuntime`. The lifecycle publishes
`ready` only after the production broker completes its Host handshake, and the desktop keeps its
loading view while that handshake is pending. Missing explicitly selected installations are reported
instead of silently switching to another runtime. Runtime snapshots carry a monotonic revision so a delayed
HTTP snapshot cannot overwrite a newer live event. HTTP and WebSocket surfaces use the lifecycle
facade: existing sessions and interactive worker replies stay on their owning generation while new
catalog and session work uses the current generation. Workers that use the user-global install are
stopped before that install is overwritten.

Explicit rediscovery in Settings enumerates the other installations and prepares user-global install
or upgrade actions. An explicit install also refreshes this inventory before planning. It prefers the
owning package manager of an existing install, otherwise the first detected npm, bun, or pnpm, and
otherwise a verified standalone payload that lands in the user-level Pi program directory
(`%LOCALAPPDATA%\Pi` on Windows, `~/.local/share/pi/runtime` plus a user `bin` entry on
macOS/Linux). Runtime code stays out of `~/.pi/agent`; plugins, configuration, and sessions keep
using that data directory.

Development and diagnostics still enumerate:

1. a workspace or cloud-bundled Pi runtime when those packages are present;
2. system-installed Pi on PATH;
3. a standalone user-global payload;
4. an explicit developer source checkout;
5. an explicit custom Node/module path.

The selected source, Pi version, Node version, package root, agent directory, and Git Bash path are
always visible. Application Host discovers the bash executable from the same Windows install roots
and PATH used for Git, and applies `harness.shell` from Pi settings at session register. A source
mismatch is a diagnostic state, never silently repaired.

The production diagnostics surface is Pi-native and shared by About, the desktop Help menu, the
keyboard shortcut, and `window.__varinDebug`. It combines the negotiated host handshake, the
server `/health` snapshot, package/resource/agent-provider diagnostics, fleet and recovery status,
and bounded project/session metadata. It never probes OpenCode endpoints or serializes provider
settings, package source URLs, message content, fleet goals, or unknown health fields.

## 11. Failure semantics

- Protocol parse errors close only the offending connection after a bounded diagnostic.
- Worker crashes retain the session and expose restart/recovery actions.
- A missing or inaccessible application Host is reported as `host-entry-unavailable`, separately from
  Pi installation/version failures; onboarding offers Varin reinstallation and does not suggest that
  upgrading or selecting a different Pi can repair application files.
- Extension failures are attributed to package/source and do not become anonymous chat errors.
- Writes use explicit leases, temporary files, fsync where meaningful, atomic same-volume replace,
  and post-write verification.
- Shutdown is asynchronous and bounded; Pi runtime disposal and active delegated recovery calls are
  awaited before force termination.

## 12. OpenChamber product-base migration

The maintainer's OpenChamber fork is copied into Varin as the authoritative application base.
Its UI, session UX, desktop/web/mobile surfaces, custom providers, remote/cloud access,
workspace operations, terminal, Git, settings, archive restore, and security customizations are
preserved unless a reviewed Pi-native implementation is demonstrably equivalent.

This is a direct migration, not a permanent compatibility stack:

1. copy only from the reviewed clean fork commit without modifying the source worktree;
2. replace OpenCode SDK domain types with Varin-owned Pi session/message/event/provider types;
3. rewrite the sync, lifecycle, provider, command, permission, and question paths against Pi;
4. delete the OpenCode child process, proxy, watcher, downloaded CLI, configuration, and dead code;
5. retain platform services and fork features, adapting each to the new Pi-native data flow;
6. connect Varin recovery at OpenChamber's unified per-message revert action and expose detailed
   history in the right sidebar/settings.

The exact source and non-regression contract are recorded in
[openchamber-pi-migration.md](ops/openchamber-pi-migration.md). Copied MIT material retains its license
notice and will be rebranded before public release.

### Agent harness D-224 state refinements

Integration undo resolves the parent’s current authority before writing. A virtual parent uses its
branch CAS under the virtual write gate; a materialized parent uses the execution workspace
Documents gate and conditionally restores after→before. The undo intent is durable before either
branch or directory mutation, and startup reconciliation distinguishes after, before, and unknown
states. A materialized undo remains `undoing` until both the directory and the non-authoritative
WorkingState branch cache match the before state. Authority is reread after the virtual write gate;
a reclaimed directory returns authority to its WorkingBranch. Registry-owned cascade admission
fences create/dispatch/start/restore for a Thread subtree. Dispatch cleans up its surface draft when
admission closes, while a Thread already owned by the cascade remains for that lifecycle to archive.

The session binding file is rebuilt once at startup from healthy catalogs and only indexes the
current `activeRunId` owner, deduplicating by session and Thread. Historical sessions remain
explicitly stale and cannot fall through to a root session. A new Run records the previous native
revision as its input and immediately removes that default merge pointer. A WorkingBranch merge
therefore defaults only to the current settled Run’s successfully published native revision; a
failed directory inspection or native publish also clears the default before the independent Git
snapshot. Git baseline capture re-lists frozen `captureScopes` and compares complete state identity,
while explore pin receives effective authorized roots and the query’s signal/deadline. The current
flat path catalog still walks metadata, but it does not clone or read file bodies outside the scope;
an O(scope) lookup remains a future Merkle/index property. These
refinements are recorded as D-224; 3.4 / 3.4a / 3.6 remain Partial pending real paid nested Pi and
full desktop restart validation.

D-274 completes the R1 production metadata cutover on catalog format v9. WorkingState consumers use
immutable root/path/domain methods; branch metadata and fixed draft/result identities publish in Rust
transactions. Combined Recovery/Integration/agent-mutation uses the Rust typed operation/file stages as
its only durable writer, while TS coordinates Documents/Registry and disk side effects after the relevant
CAS. The old WorkingState and SQLite recovery engines are test helpers only.

D-275 closes R1. Built-in Recovery shares `<VARIN_DATA_DIR>/kernel/<hostId>` with WorkingState, reports
`application-data`, and advertises `storageManagement: false`; location/migration UI is capability-gated,
while replacement recovery providers may still implement the optional v5 storage-management contract.
R1 durability is evidenced by explicit object-install ordering, filesystem flush/write-through behavior,
SQLite transactions, injected failure windows, and restart reconciliation. Native multi-platform package
smokes remain release-CI evidence, code signing remains optional under the current product contract, and a
physical power-cut campaign is release QA rather than an R1 implementation gate.

D-276 closes R2. Rust `fileResources` owns canonical execution-root registration, exact/subtree overlap
leases, typed file-state capture, content-backed conditional apply, mkdir/remove/rename, and restart
reconciliation after an already-applied side effect loses its terminal response. Documents write/move/delete,
workspace-scoped Files CRUD, Recovery/Integration disk apply and compensation, and production `fs.lock` use
that authority. Registry remains the sole unsaved-buffer/grouped-undo authority; Host surface receipts advance
the durable mixed operation without copying editor text into Rust. Varin `write`/`edit`/`apply_patch` no
longer fall back to direct pi-host disk mutation when the Host backend is unavailable.

D-277 wired major R3 primitives; D-278 reopened full lifecycle acceptance, and D-279 closes those specific gaps. Production baseline inventory and file-body capture now use the same Host-admitted,
same-grant Rust file authority that owns WorkingState objects; Git remains the semantic adapter for staged/
unstaged/untracked paths, index modes and configured clean/filter behavior rather than a second body writer.
Immutable roots materialize through kernel-owned staging/backup/promotion with object verification, truthful
reflink-or-copy reporting and restart reconciliation. Materialized Git execution attaches only linked-worktree
metadata, seeds the real index, and commits an internal execution baseline without copying workspace bytes back
through TypeScript. Settle republishes Rust roots from Git changed paths plus frozen capture scopes, or from the
full Rust inventory for non-Git views. Native result roots replace mandatory production side snapshots;
reclaim/discard/delete use kernel subtree removal and prune linked-worktree metadata. Kernel measurement reports
real allocated blocks where the platform exposes them; Windows currently reports `allocatedBytes: null` rather
than guessing. Thread/Run retention policy, active-writer/command guards, unsaved buffers and Git product policy
remain in their existing Host/Registry domains. R4–R6 are unchanged.

## D-278 audit correction

The [R0–R3 audit](plan/rust-kernel-audit.md) retains the single Rust storage authority and Registry buffer authority,
but reopens R2/R3 completion claims. Independent release-kernel cases reproduced physical-root lease partitioning,
reversed coverage, destructive operation replay, stale GC cleanup, epoch pin leaks, and actual consumer identity
failures. These are repaired without introducing another persistent authority. Native lifecycle acceptance still
requires Host-visible pending file-operation disposition and durable kernel/Git/Registry execution-generation handoff.
CI now has an explicit native authority command; editing that workflow is not evidence that remote CI has passed.

## D-279 R2/R3 acceptance closure

D-279 closes the two concrete acceptance gaps left by D-278 without adding another authority. Low-level file operations are now exposed through typed `file.operation.list/reconcile` state carrying operation identity, paths, disposition and reason; operations such as an unprovable directory rename remain retained/needs-attention rather than being forced to success. Native materialization persists a fixed source root/revision/writeRevision, kernel operationId and durable pin in the Thread Registry handoff, then advances explicit kernel-materialized and Git-attached receipts. Git attachment is idempotent for Varin-owned baselines, the durable pin is released before the handoff intent is cleared, and a failed release leaves the receipt available for restart retry. Setup timeout/abort completes only after the spawned child actually closes. R2 and R3 are therefore Complete; R0 and R4–R6 remain independent.

## D-280 native process authority

The Host injects `KernelProcessService` into the same user/Harness terminal, Thread setup, LSP,
DAP, task and test consumers. Rust owns actual PTYs, piped processes, tagged raw bytes, stdin
receipts and process-tree writers. TypeScript owns OSC/terminal display, protocol clients and
product startup/cancellation; no Node/Bun PTY provider or generic Node spawn is a production fallback.

Format-v10 process records share the single Storage. A per-process guardian is the same packaged
executable, has no database and sends durable native exit evidence. Jobs/sessions and Linux
subreaper observation guard deletion/materialization until tree exit. Unknown outcomes survive as
retained state; a PID is not an ownership transfer. Consuming/releasing output retains launch
identity against replay. All producer disposal occurs while native grants remain valid.

Kernel loss reaches the terminal as error, rejects pending shell/protocol requests and preserves
unconfirmed writers. Async launch is included in stop/replacement, and failed writer close is not
silently cleared. See [the consumer map](../packages/web/application-host/lib/process/DOCUMENTATION.md).
Pi broker processes, short Git semantic commands and bootstrap/discovery adapters retain their
existing ownership; unused native-addon distribution dependencies and full package/performance
acceptance remain R6/R0 work, not a competing process backend.

## D-281 native file and structure compute

R5 adds one read-only compute authority inside the same kernel rather than a second Host scanner.
`compute.start/read/cancel/release` admits either an immutable WorkingState pin, a Host-authorized
canonical live root, or explicit fixed text objects. Immutable queries hold their own short-lived
reader pin, so caller unpin, branch deletion, and concurrent GC cannot change the source mid-job.
Live-root records carry the content revision actually read; source drift is partial/failure evidence,
not an invented immutable snapshot. Path scopes and overlay tombstones are applied before candidate
selection and result limits.

Two foreground workers and a dedicated background worker separate interactive read/search/explore
from catalog/index work. Output is bounded and cursor-acknowledged; cancellation reaches the actual
worker and terminal state is observed before reader references are released. The native search path
uses the Rust grep/ignore ecosystem and Git inventory semantics; native tree-sitter owns workspace
structure/classification/import/call/chunk computation. Application Host adapters only validate and
project records. Surface drafts remain Registry-owned fixed text overlays rather than a disk fallback.

Production `search.content`, file find, Harness grep/explore, language catalog, symbol graph and
semantic disk ingestion all use this boundary. Virtual Thread semantic recall enumerates path/revision
from the existing WorkingState pin and invokes native `unitsFixed` on that same pin; it no longer
copies the branch corpus into TypeScript before parsing. Tokenizer-aware packing, embeddings and vector
storage remain their existing TS/model-domain responsibilities, TriviumDB remains the graph authority,
and LSP remains a protocol/navigation/diagnostic service. Host `web-tree-sitter` is retained only for
grammar-install ABI admission and does not parse workspace source. Generic Files UI reads are not
reclassified as R5 compute; their mutation/resource authority remains the R2 boundary.

Common language grammars and extraction queries ship with the application (D-290). Node-based
TypeScript/JavaScript, Python, HTML/CSS, JSON, YAML and Bash language servers are immutable built-in
extension assets. Rust Analyzer, gopls, clangd and Marksman are prepared in a private Host tooling
directory when first requested, with fixed distribution identities; their actual workspace processes
remain under the same Rust process service and LSP Supervisor. Merely viewing language status starts
neither downloads nor processes. Installation availability, active analysis, missing project toolchains
and unsupported languages remain distinct in Settings.

The removed production paths include Host ripgrep child management, recursive file-search scanning,
WorkingBranch corpus/body mirrors and Host AST/chunker discovery. R5 is therefore Complete under
D-281. D-282 then closes R0/R6 and Stage R as described below.

## D-282 Stage R release and acceptance closure

The kernel handshake now negotiates an acknowledgement-backed request window shared by ordinary calls,
streaming blob chunks and branch builders. Cancellation remains a control frame, so it can reach Rust while
the serial Storage worker is occupied. Credits return on native acknowledgement or disconnect, duplicate
in-flight IDs and malformed/over-window admission terminate the epoch, and truncated input drains the old
worker before a clean restart. Host close waits admitted work and actual child exit instead of treating a
caller-side cancellation as native completion.

Web, cloud, and Electron release layouts carry a manifest-verified kernel. Electron verifies the target
TriviumDB and sherpa binaries and no longer ships or rebuilds `better-sqlite3`, `node-pty` or `bun-pty`;
the Rust kernel owns those former storage/process responsibilities. Application Host build output is audited from its
real runtime entrypoints: a reachable legacy store/test helper fails the build, while unreachable test and old
authority artifacts are pruned before publication. The legacy TS recovery file writer is now an explicit test
helper; production retains only read-only path/hash utilities around the Rust file backend.

Release acceptance covers an arbitrary cwd, copied installation, new epoch over the same current-format data,
manifest mismatch, fixed-root search/structure, conditional file mutation, native shell exit, cross-domain
Registry+disk Integration and awaited Registry shutdown. The native runner matrix builds and smokes Windows
x64/ARM64, Linux x64/ARM64 and macOS x64/ARM64; local evidence is Windows x64 and other runner results remain
platform-specific rather than inferred.

The R6 measurement uses fixed corpus hashes at 128/1024/4096 files and compares the accepted TS product path
with the Rust product path in separate processes. It records cold/warm latency, event-loop delay, Host+kernel
RSS, fixed-root reads, COW tree-node counts and cancellation. Search improves on the small/medium corpora and is
near parity at 4096 files; native inventory and single-file structure parsing cost more in this fixture but stay
bounded. A single-path update remains about 4–5 ms and creates nodes proportional to tree depth, while foreground
fixed reads stay around 11 ms under background backpressure. The data does not support a universal language or
memory multiplier, and none is claimed. R0–R6 are complete; future work uses this authority split rather than
maintaining a migration fallback.
