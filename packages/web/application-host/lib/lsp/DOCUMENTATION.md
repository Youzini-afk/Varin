# Language services

Application-host supervisor for language servers. JSON-RPC, diagnostics, provider selection and
feature requests stay here; production spawn and actual pipe/process-tree lifetime belong to the
Rust kernel. Renderers never spawn language servers.

## Entrypoints

- `supervisor.ts`: `createLanguageSupervisor({ documents, spawn, pathModule, env, isTrusted, hostViewIdleMs, hostViewDocumentLimit, now })`
- `language-view.ts`: `createLanguageViewBinder({ documents, supervisor })` — binds one document in the
  Host-owned view to a named text identity (fixed editor draft or disk revision)
- `jsonrpc.ts`: Content-Length framed JSON-RPC client/server
- `routes.ts`: authenticated `/api/language/*` routes and SSE events, pinned to the `surface` view
- `capability.ts`: `workspace.language` Host capability
- `fixture-server.ts` / `typescript-server.ts`: test servers, not production providers
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

Internal `syncDocument` and `documentSymbols` calls accept a separate `{ signal }` option, kept out of
the public JSON request. Text binding and session activation can stop this caller's wait without retiring
shared language startup. An active document-symbol request passes the signal into JSON-RPC: its waiter
and abort listener are released, a `$/cancelRequest` notification names that request ID, and late responses
are ignored. Other requests remain active; cancellation does not degrade or restart the shared server.
The peer can ignore cancellation, so returning from the caller's wait is not proof that server work has
terminated. The notification follows the [LSP cancellation contract](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/specification.md#cancellation-support-arrow_right-arrow_left).

## Views

A session is keyed by `(workspaceId, languageId, viewId)` because one server cannot be both the
editor's live buffer and an agent turn's fixed text (D-087):

- `surface` — owned by the renderer. Versions are the editor's `localEditRevision`, the process stops
  after the last editor document closes, and a replacement server is handed the current buffers.
- `agent` — owned by the Host. Versions are assigned per `(view, resource)`, each open document
  records the `contentRevision` it was synchronized from, and callers assert that revision with
  `expectedRevision`. It starts on the first Host request, closes least-recently-used documents past
  `hostViewDocumentLimit`, releases after `hostViewIdleMs`, and never replays documents on restart.

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

Project-provided (`source: 'workspace'`) commands run only when `isTrusted(root)` is true.
Production Web sets `isTrusted` to false. There is no HTTP route that registers providers.

## Routes

- `POST /api/language/status|sync|feature|restart|dispose-workspace`; the feature route includes
  generation-bound `executeCommand`
- `GET /api/language/events?workspaceId=` SSE (credentials in headers). Payloads must not include file bodies.

Application-host endpoint/workspace switch disposes sessions. Electron reuses this Web host.

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
