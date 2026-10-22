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
an empty language session; actual editor or explicit Host requests use the same preparation manager before spawn.
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
editor's live buffer and an admitted source's fixed text. The `agent` names below are internal view identifiers, not model tools:

- `surface` — owned by the renderer. Versions are the editor's `localEditRevision`, the process stops
  after the last editor document closes, and a replacement server receives the current buffers.
- `agent` — the workspace's disk view, owned by the Host. Versions increase throughout the server generation, each open document
  records the `contentRevision` it was synchronized from, and callers assert that revision with
  `expectedRevision`. It starts on the first Host request, closes least-recently-used documents past
  `hostViewDocumentLimit`, releases after `hostViewIdleMs`, and never replays documents on restart.
- `agent:source:<identity>` — an admitted native source, retained by actual Run/grant references; fixed sources prepare their own derived physical view.
  The original project namespace selects configuration; the admitted live root, managed working copy or fixed derived project
  supplies cwd, root URI, workspace folders, file mapping and its watcher. Compatible callers share the
  same supervisor session and startup. Query cancellation does not withdraw its Run's reference, and
  the legacy idle reaper does not retire this view. Last-reference release waits for actual process exit.

Agent/Bot model directories no longer expose language-server tools. Retrieval and common
structural reads use Tree-sitter, including fixed sources, and do not create LSP views.
The source-bound view plumbing remains available to explicit Host/IDE consumers; it
retains the original source identity and authorization independently of model capabilities.

Explicit Rust source queries discover ancestor `Cargo.toml` / `rust-project.json` entries through the admitted native
source, then initialize rust-analyzer with the nearest manifest in `linkedProjects`. Newly queried projects
join that same source view's project configuration; they do not create another whole-source materialization.
Physical source roots, grants, cwd and URI mapping stay with the original workspace; explicitly configured
provider `linkedProjects` take precedence. Fixed sources discover their own manifests, never live copies.

Server work-done progress remains visible separately from protocol initialization. Semantic queries during
reported loading return `pending` with `reason: indexing`; syntax-only document symbols remain available.
LSP ContentModified retains its numeric code and becomes retryable `pending` when the admitted document
itself is unchanged. Timeouts return `unavailable` with `reason: timeout`; empty successful results remain `ready`.

Provider language families share a process (for example TS/TSX/JS). Document versions are assigned only
after shared startup finishes, in the synchronous notification step. A view revision detects changes to
other synchronized files while a query is answering. Filesystem/Document mutation events invalidate
diagnostics and return changed disk buffers to server filesystem ownership; fixed-source documents remain fixed.
Filesystem invalidations are coalesced by URI into notifications on the existing 20 ms watch cadence.
A feature query flushes pending notifications first, so batching does not query a server before its invalidations.

## On-demand preparation

Project selection and conversation snapshots do not prewarm language servers. A real
editor request or explicit prepare action uses the existing provider preparation owner.
There is no semantic-index manager or background LSP dependency in basic retrieval.

Cancelling one waiter leaves other callers intact; the final cancelled startup waiter aborts its owned
preparation only when no native source owner retains it. Initialization has a configurable 45-second default handshake deadline so a silent server
cannot leave one shared startup promise pending forever. Failed startup closes the owned process before
a later call can replace it. LSP Harness transport follows this lifecycle, rather than applying the generic
deadline over installation and startup. Text acquisition and actual feature requests retain separate
30-second budgets. Document/source release withdraws the original reference; idle cleanup
preserves active requests and independently retained source views.

## Diagnostic results

Diagnostics use the caller's code view and exact document binding. Servers with `diagnosticProvider`
are queried through pull diagnostics; others use versioned publications. Unversioned push results may
still be displayed by the editor, but are not labelled as a verified current source result. Missing or
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

Renderer endpoint/workspace switches release only the surface view. Independently retained
Host source views keep their own lifetime. Electron reuses this Web host.

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
Quick retrieval and common structural reads use native Tree-sitter and do not prepare LSP.
Project selection no longer prewarms Agent/editor language views. Actual editor requests and
explicit language features retain this module's original preparation and retry owners.

Marksman is the standalone `artempyanykh/marksman` binary, started with its official
`server` subcommand. Markdown, `md`, and `mdx` requests share this provider; the
download manifest uses the fixed `2026-02-08` release and GitHub asset digests.

## Native owner lifetime

Production receives `KernelProcessService.spawn` with no default Node fallback. Disable/restart,
last-document close and idle release wait for pending startup and native close. Unconfirmed exits
remain degraded/failed with the owner retained. Synchronous fake-child unit seams are explicit;
real LSP initialization/completion/disposal is covered by the
[native consumer tests](../kernel/process-consumers.native.test.ts). See [process ownership](../process/DOCUMENTATION.md).

## Private source-bound views

The private language adapter and `SourceQueryOwner` retain the original live, fixed or
materialized source, Run grant and Documents registration for explicit Host consumers.
A fixed language view may derive a physical project through the original Storage owner;
provider SDKs and out-of-tree configuration retain their real environment semantics.
Whole-project language access is distinct from path-scoped Tree-sitter/file reads.

These adapters do not register `language_*` model tools. The removed model execution,
result paging and post-read adapters are not alternate IDE APIs. Editor navigation and
its native process lifecycle remain covered by the supervisor, source-view and process
consumer tests. The `structure` request in the shared private bridge takes its own
Tree-sitter path and never reaches language-server preparation.

The supervisor retains shared preparation and actual source references. Cancellation of
one query does not retire another caller's session. Source disposal and epoch loss drain
the original process; an acknowledgement does not manufacture a process-stop receipt.

For a mutable source file that was opened as a Host-owned disk overlay, a watcher read of changed
text sends that exact reader observation through the original document-version sequence before
closing the overlay. A close notification alone does not guarantee that a provider has dirtied its
cached disk text. The read's original session/open binding must still be current; a delayed success
or failure cannot close a newer query binding. Missing/unreadable text never becomes a fake empty
change. Fixed source views and editor-owned buffers retain their separate invalidation rules.
