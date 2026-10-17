# Language services

Application-host supervisor for language servers. JSON-RPC, diagnostics, provider selection and
feature requests stay here; production spawn and actual pipe/process-tree lifetime belong to the
Rust kernel. Renderers never spawn language servers.

## Entrypoints

- `supervisor.ts`: `createLanguageSupervisor({ documents, spawn, spawnAdmitted, releaseAdmittedContext, pathModule, env, isTrusted, hostViewIdleMs, hostViewDocumentLimit, now })`
- `language-view.ts`: `createLanguageViewBinder({ documents, supervisor })` — binds one document in the
  Host-owned view to its admitted native source identity or explicit saved-disk revision
- `jsonrpc.ts`: Content-Length framed JSON-RPC client/server
- `routes.ts`: authenticated `/api/language/*` routes and SSE events, pinned to the `surface` view
- `capability.ts`: `workspace.language` Host capability
- `fixture-server.ts`: controlled test server, not a production provider
- `managed-servers.ts`: on-demand native Go (`gopls`), Rust (`rust-analyzer`), C/C++ (`clangd`), and independent Markdown (`marksman`) preparation
- the distribution TypeScript/JavaScript provider and the Python/HTML/CSS/JSON/YAML/Bash providers are
  brokered Varin extensions in `@varin/extension-builtins`. Their self-contained program assets are
  materialized on `workspace-match` activation; actual language processes still start on demand.
- `managed-servers.ts` prepares larger native tools in the Host's private data directory. Preparation
  processes use an explicitly scoped Rust process service for that tooling directory; LSP processes
  use the ordinary admitted workspace process service. No renderer launches or installs programs.

`LanguageSupportAPI` reports program availability separately from live `LanguageServicesAPI` sessions.
Opening Settings only inspects inventory. Its prepare/cancel actions download/install without starting
an empty language session; actual editor/agent requests use the same preparation manager before spawn.
The UI keeps technical package/ABI information in details and uses failure/retry for actual failures,
not for a bundled server that simply has not been needed yet.

The JSON-RPC client handles both request directions without confusing peer-owned IDs. It answers
workspace configuration with the server's native defaults, provides the admitted workspace folders,
and acknowledges progress setup. Unsolicited `workspace/applyEdit` is rejected: edits still go through
Documents. A pending preparation belongs to the session's launch cancellation and cannot spawn after
the workspace is disposed.

Internal synchronization and Host navigation calls accept a separate `{ signal }` option, kept out of
the public JSON request. Text binding and session activation can stop this caller's wait without retiring
shared language startup. An active document-symbol request passes the signal into JSON-RPC: its waiter
and abort listener are released, a `$/cancelRequest` notification names that request ID, and late responses
are ignored. Other requests remain active; cancellation does not degrade or restart the shared server.
The peer can ignore cancellation, so returning from the caller's wait is not proof that server work has
terminated. The notification follows the [LSP cancellation contract](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md#cancellation-support-arrow_right-arrow_left).

## Views

A session is keyed by `(workspaceId, providerId, viewId)` because one server cannot be both the
editor's live buffer and an agent turn's fixed text (D-087):

- `surface` — owned by the renderer. Versions are the editor's `localEditRevision`, the process stops
  after the last editor document closes unless retained for prewarming, and a replacement server receives the current buffers.
- `agent` — the workspace's disk view, owned by the Host. Versions increase throughout the server generation, each open document
  records the `contentRevision` it was synchronized from, and callers assert that revision with
  `expectedRevision`. It starts on the first Host request, closes least-recently-used documents past
  `hostViewDocumentLimit`, releases after `hostViewIdleMs`, and never replays documents on restart.
- `agent:source:<identity>` — an admitted native source, retained by actual Run/grant references; fixed sources prepare their own derived physical view.
  The original project namespace selects configuration; the admitted live root, managed working copy or fixed derived project
  supplies cwd, root URI, workspace folders, file mapping and its watcher. Compatible callers share the
  same supervisor session and startup. Query cancellation does not withdraw its Run's reference, and
  the legacy idle reaper does not retire this view. Last-reference release waits for actual process exit.

Language-capable child runs materialize their existing WorkingState execution directory before the
first prompt. Navigation, diagnostics and LSP structure fallback resolve source aliases to that
directory, so imports and project files are read from the child's workspace. A fixed source uses its
pinned branch's derived project, including drafts captured during source preparation. The binder never
reinterprets a Thread as a session or substitutes a same-path live workspace. Cross-file locations remain
admitted by the source owner rather than being stamped with the queried document's revision.

Provider language families share a process (for example TS/TSX/JS). Document versions are assigned only
after shared startup finishes, in the synchronous notification step. A view revision detects changes to
other synchronized files while a query is answering. Filesystem/Document mutation events invalidate
diagnostics and return changed disk buffers to server filesystem ownership; fixed-source documents remain fixed.
Filesystem invalidations are coalesced by URI into notifications on the existing 20 ms watch cadence.
A feature query flushes pending notifications first, so batching does not query a server before its invalidations.

## Preparation and prewarming

`prewarm.ts` retains the active project's workspaces and live session workspaces. Project selection and
session snapshots start the same provider activation, preparation and initialization used by queries.
Language inventory supplies representative source files, which are opened in the disk view to load
lazy projects. The surface view is initialized without taking ownership of editor buffers. The existing
project-index manager still owns persisted semantic/structure index recovery and incremental updates.

Cancelling one waiter leaves other callers intact; the final cancelled startup waiter aborts its owned
preparation only when no native source owner retains it. Initialization has a configurable 45-second default handshake deadline so a silent server
cannot leave one shared startup promise pending forever. Failed startup closes the owned process before
a later call can replace it. LSP Harness transport follows this lifecycle, rather than applying the generic
deadline over installation and startup. Text acquisition and actual feature requests retain separate
30-second budgets. Project/session release cancels unwanted warmup; idle cleanup preserves active
requests and retained project views, and reclaims unused prewarmed surface views too.

## Diagnostic results

Diagnostics use the caller's code view and exact document binding. Servers with `diagnosticProvider`
are queried through pull diagnostics; others use versioned publications. Unversioned push results may
still be displayed by the editor, but are not labelled as a verified current Agent result. Missing or
stale results are `pending`, never a successful empty list. Incremental cursors advance only after a
current report is returned and delivered. Cache keys include the view and server generation.

`inspectViews()` reports live processes, open documents, and idle time; `releaseIdleHostViews()` is the
asynchronous release, completed only after actual process stop. Both views emit `view` on status and diagnostics events, and the renderer routes
deliver only `surface`.

## Status

Each session is `absent`, `starting`, `ready`, `degraded`, or `failed`. A crash or failure affects only
that session. Stale diagnostics and completions whose `documentVersion` does not match the open
document are dropped; a `contentRevision` mismatch is `stale` with `reason: 'revision'`.

Provider disable/reload clears its diagnostics and generation. Commands are executed only by the Host,
only for the provider/document generation that produced them, and only when the server declared that
command in `executeCommandProvider`.

Project-provided (`source: 'workspace'`) commands require the original project's trust. Ordinary
workspace views use the Host workspace-root guard; native source views re-admit the original Documents
registration and trust through their source owner, including immediately before actual managed spawn.
The managed-copy path does not itself confer trust. There is no HTTP route that registers providers.

## Routes

- `POST /api/language/status|sync|feature|restart|dispose-workspace`; the feature route includes
  generation-bound `executeCommand`
- `GET /api/language/events?workspaceId=` SSE (credentials in headers). Payloads must not include file bodies.

Renderer endpoint/workspace switches release only the surface view. A retained project keeps its
prewarmed process without editor buffers; Agent queries keep their own lifetime. Electron reuses this Web host.

## Managed native servers

`createManagedLanguageServers({ directory, spawn, ... })` owns the private user-data
cache for the native providers. `inspect(languageId)` is side-effect free: it checks
the private cache and PATH and never downloads or runs a process. The application host
calls `ensure(languageId, workspaceRoot, signal?)` only when a real LSP session starts
or the user retries a failed preparation; it returns `{ command, args,
initializationOptions? }` for the supervisor to pass to the injected Rust Kernel
`ManagedSpawn`.

The observable preparation states are `available`, `preparing`, `installed`, `failed`,
`needs-runtime`, and `unsupported`. Go uses an existing `go` toolchain and a private
`GOBIN`, module cache, build cache, and preparation cwd under `language-servers/.cache`.
Rust Analyzer and clangd use fixed official
release assets with committed SHA-256 digests. All archives are staged, verified,
path-checked, and atomically installed; cancellation, failed preparation, and dispose
remove staging directories and never publish a half-written executable. A concurrent
ensure for one server shares one preparation, while a caller cancellation only aborts
the shared job after the last waiter leaves.

Production artifact downloads use the Host's shared egress fetch, including the configured proxy,
environment and desktop system-network policy. They do not bypass it through global Node fetch.
Download failures identify the origin, HTTP status or available transport cause code without putting
URL credentials/query parameters in the generated context; cancellation keeps its original abort reason.
An Explore query that has seen an unavailable outline uses warm-only LSP requests for later files in
that scope/language, avoiding repeated failed cold preparation. This does not change editor preparation,
explicit retries or the ability of a new query to prepare the server.

Marksman is the standalone `artempyanykh/marksman` binary, started with its official
`server` subcommand. Markdown, `md`, and `mdx` requests share this provider; the
download manifest uses the fixed `2026-02-08` release and GitHub asset digests.

## Native owner lifetime

Production receives `KernelProcessService.spawn` with no default Node fallback. Disable/restart,
last-document close and idle release wait for pending startup and native close. Unconfirmed exits
remain degraded/failed with the owner retained. Synchronous fake-child unit seams are explicit;
real LSP initialization/completion/disposal is covered by the
[native consumer tests](../kernel/process-consumers.native.test.ts). See [process ownership](../process/DOCUMENTATION.md).

## Native physical-source queries

Native Threads call this same supervisor through the private native language adapter. They bind the
actual live, fixed or materialized source through the shared `SourceQueryOwner`, using the original frozen
selection, Run grant and Documents registration. `KernelProcessService.spawnAdmitted` consumes a trusted
source-owner callback; it is not a public path/cwd permission. Native navigation opts
into strict URI/range projection and omission reasons; ordinary editor location shapes are unchanged.
The supervisor retains diagnostic publications for native readers. Snapshot reads do not start
a service or wait for a future publication; missing/unversioned evidence is pending, while changed view
or generation is stale. Nonempty unversioned observations may be returned with explicit unversioned
verification and no claimed range revision; empty unversioned publications never certify clean. Its cache is owned by the existing language session and expires with it.

Returned locations are still server observations. The native resource owner separately admits and reads
the target before delivery; a cross-file observed revision does not certify which bytes produced an LSP
range. A materialized source uses its real working copy rather than the old project directory or its
immutable base. A fixed source lazily materializes its original branch tree using the existing Storage
worker; imports, captured configuration and paths resolution then use that actual project view, not just
one substituted didOpen buffer. The original immutable reader still owns query/target content.
Dependency provenance is `{ source: 'fixed_branch' | 'live', external: 'provider_environment' }`.
External SDKs, compiler libraries and explicitly out-of-tree configuration are not claimed frozen.
The service requires the original Run's whole-project read scope; ordinary path-scoped file reads do not.

The supervisor owns one shared preparation and Run reference set. Storage owns only a derived physical
handle, root/journal and directory identity. A changed derived tree becomes stale, drains its process,
and is rebuilt only by a later actual query. Cleanup retains unknown writers and performs recursive
deletion on the original worker lane rather than inside Storage control. The exact stopped process
context is also retired, without withdrawing another view's context.

Terminal Run notifications and explicit grant retirement withdraw source references without treating
their ACK as a process-stop receipt. Writable child result capture separately awaits the same
supervisor's drain and still passes Rust's original directory-writer barrier. Another retained Run can
keep a shared process alive. Epoch loss invalidates old queries but does not manufacture an exit or
replace a still-unconfirmed process. Native language tools use the original Source requirement and are
available to default Worker and read-only Retrieval profiles; the read-only child gains no file-write
or process tool merely because the Host language backend needs a physical view.

Native tests include the bundled TypeScript provider and controlled versioned/pull/cancellation/error
cases. Each establishes its actual source, Host and provider boundary; no claim covers every language,
external compiler environment or deployment platform.

## Source-bound read-only query composition

The native source adapter now consumes the original hover and workspace/document symbol methods as
well as a finite incoming/outgoing call query. Strict source result mapping is distinct from legacy
editor projection: an invalid explicit URI is never converted to an implicit current-file symbol;
real nested DocumentSymbol nodes inherit their actual document. Hover links remain literal markup.

`sourceCallHierarchy` combines prepare and relation requests on the existing supervisor. Raw provider
items stay private to that query and never enter the editor/knowledge token map or durable tool results.
`requestFeature` rechecks this invocation's source admission immediately before every RPC, including
after shared session preparation; the callback belongs to the original SourceQueryOwner, not arbitrary
extension middleware. Original request/session/document fences and cancellation still apply. A caller
losing permission cannot continue using another retained Run's valid source reference.

The source adapter returns mapped edges with sites on the real `from` resource. It does not infer sites
from the input anchor or target. Original Rust post-admission reads every target under the same source
grant and retains actual observations separately from unproven cross-file computation versions. Existing
editor and knowledge APIs continue using their existing methods. This does not move editor commands or
workspace edits into a read-only native call. See the actual source-bound tests beside this module.

For a mutable source file that was opened as a Host-owned disk overlay, a watcher read of changed
text sends that exact reader observation through the original document-version sequence before
closing the overlay. A close notification alone does not guarantee that a provider has dirtied its
cached disk text. The read's original session/open binding must still be current; a delayed success
or failure cannot close a newer query binding. Missing/unreadable text never becomes a fake empty
change. Fixed source views and editor-owned buffers retain their separate invalidation rules.
