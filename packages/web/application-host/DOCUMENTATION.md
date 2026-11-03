# Application Host process boundary

`index.ts` assembles the existing Host owners. Web/CLI import it directly; the
transitional Electron shell embeds it. The Tauri candidate launches
`server/desktop-host.js` with the manifest-selected Node executable. This entry
dynamically imports the same assembly, not another backend or Catalog.

## Managed desktop lifecycle

The parent passes `VARIN_NODE_PATH`, `VARIN_KERNEL_PATH`, `VARIN_DIST_DIR` and
`VARIN_RESOURCES_PATH` from
its verified immutable release. `VARIN_DATA_DIR`, when provided, still selects
the original data root; otherwise `resolveVarinDataDir` retains the established
platform paths. Tauri's own app-data path must not replace that root. Existing
Catalog, Storage and Knowledge owners retain their database paths, locks,
upgrade behavior and drain responsibilities. No database is copied by this entry.

Settings remain under the original transactional settings owner. The entry
reads the existing LAN/password preferences and keeps `desktopLocalPort` when
available. Address-in-use retries affect only the same HTTP listener, first the
normal desktop port and then an OS-assigned port. The Host is never initialized
again after a binding failure. The actual port is committed through the original
settings store. LAN access without a password remains loopback-only.

Readiness is emitted only after the original Host reports ready and its local
credentials are prepared. Existing valid `desktopLocalClientToken` credentials
are reused. A missing/expired credential is minted by the original auth owner,
reusing the desktop-local dedupe identity; the shell never edits remote-clients.
Malformed settings or original stores fail instead of creating an empty profile.

Stop waits for `controller.stop({ exitProcess: false })`. It sends success and
exits only after the original drain completes. A failed stop stays unsuccessful;
there is no timeout that reclassifies an unknown executor as stopped. Closing the
private parent pipe starts the same drain, including if startup is still pending.
The parent may restart only after `restartRequested` **and** successful process
exit. A crash, failed stop, or unknown request outcome is not an automatic retry.
The shell must distinguish closing a window from stopping this owned service.

## Private pipe protocol

The inherited stdin/stdout pair carries UTF-8 newline-delimited JSON. Every frame
has `protocol: "varin-desktop-host"` and `version: 1`. The TypeScript contract is
[`desktop-host-protocol.ts`](desktop-host-protocol.ts). stdout is reserved for
these frames; ordinary console and direct stdout output is redirected to stderr.
The parent must never log raw frames: readiness contains a local bearer token,
and desktop runtime state can contain authorization headers.

- Shell requests: `kind: "request"`, `id: "shell:<unique-id>"`, `method`, optional
  `params`. Replies use `kind: "response"`, the same ID, and either `ok: true,
  result` or `ok: false, error: { code, message }`.
- Supported methods: `status`, `quitRisk`, `stop`, `setDesktopState`,
  `computerControl`, `desktopInvoke`, `browserInvoke`, and `fileGrant`.
- `setDesktopState` supplies `focused`, optional `runtimeConfig` containing
  `apiBaseUrl`/`requestHeaders`, and optional numeric `controlWindows` handles.
  The parent derives these only from the requesting trusted window and its actual
  selected Host, never an arbitrary web page's input.
- `computerControl` requires the original `holderId` and one of `takeover`,
  `handback`, `cancel`. A stale holder cannot operate another execution.
- `desktopInvoke` accepts `{ command, args }` for the eight existing
  `desktop_ssh_*` commands, delegated to `controller.connections`, and the
  shared BrowserOwner's `desktop_browser_*` and `desktop_web_render` operations.
  Browser presentation uses the shell-verified `windowLabel`; it never creates
  an independent browser page owner for the UI.
- `fileGrant` calls the original Host's process-local grant issuer with
  `stat`/`read`/`raw` scopes. A settings helper or browser-only service cannot
  mint a usable grant for the Host, and remote mode cannot mistake a local file
  path for a remote filesystem path.
- Host requests use `host:<unique-id>` for `openFilesystemPath` and native
  `browser.*`, `network.*`, and companion operations. A response means the actual
  operation finished. Losing the pipe leaves a dispatched operation unknown;
  it is not replayed. Unknown native methods return an explicit error.
- Events use `kind: "event"`, `event`, `payload`: `ready` (origin, port, pid and
  clientToken), `stopping`, `stopped`, `restartRequested`, `failed`,
  `notification`, `connectionStatus`, `computerGesture`, `computerControl`.

Direction, version and active request identities are checked. Physical lines
are limited to 1 MiB, including JSON escaping. Larger logical JSON messages use
`kind: "chunk"`, `id: "host:chunk<N>"` (or `shell:chunk<N>`), zero-based
`sequence`, original UTF-8 `totalBytes`, `final`, and UTF-8 `data` of at most
64 KiB. Chunks never split a code point. Transfer numbers increase on first
appearance; transfers may interleave, but each sequence is strict. Duplicate,
out-of-order, oversized, inconsistent or incomplete-at-EOF streams fail closed
and release partial assemblies. There is no retransmission/replay.

Both decoders reserve at most 64 MiB of declared original payload across at most
64 incomplete transfers. These are payload limits, not claims about JSON parser
RSS. Writers use round-robin bulk chunks within a 64 MiB payload budget and a
separate bounded 64-message/4 MiB small-control lane, so a full-size CDP result
cannot exclude stop/cancel/ACK. The Rust consumer has one reliable bounded event
receiver, not a broadcast subscriber that silently loses callbacks. A received
message retains its byte permit through callback completion. Native queue
failure closes the pipe and leaves effects unknown rather than reporting success.

Images use managed file receipts plus explicit release, not chunked control
messages. Model streams and business calls remain on the original authenticated
HTTP/WebSocket APIs; this pipe is not an alternate kernel transport. Repeated
business commands are not replayed when the parent reconnects.

`runManagedDesktopHost` supports trusted in-process injection of the Host start
function for platform adapters and focused lifecycle testing. No CLI/environment
option can load arbitrary replacement application code. BrowserOwner and system
network adapters remain explicit `StartWebUiServerOptions` dependencies. This
entry injects the native browser and system-network adapters through those
original dependencies. Production shell replacement still requires native and
installed-product acceptance, not merely a ready Host.

## Browser-only service and system egress

`server/desktop-browser.js` uses the same private transport and shared browser
owner without importing the Host assembly, opening Catalog/Knowledge, creating
an HTTP listener, or minting local credentials. Readiness is `{ mode: "browser",
pid }`, never an origin/token. When a local Host is already running, browser
operations reuse that process's owner instead of starting a second service.
`web_render` uses a separate transient native request context and finally closes
its own page; it does not borrow the interactive browser's login state.

`native-network-owner.ts` implements the original desktop single-hop fetch seam.
The shell allocates private request/response files; finite request bodies are
spooled completely before Chromium dispatch. This is not an unlimited streaming
upload transport. Existing model-provider calls supply finite JSON/form bodies.
Redirects remain manual and their real status/location reach the original
Host egress policy, which owns redirect validation and credential stripping.

Response headers resolve before body completion. A fixed 1 MiB response ring
supports long-lived SSE without growing disk usage: `available`/`consumed` are
absolute counters, reads wrap at `counter % responseCapacity`, and each consumed
chunk is acknowledged before native overwrite. HTTP errors retain their status
and body. Abort/cancel is intent only; files are released after the native
`complete` receipt and local I/O completion. Pipe loss reports unknown and does
not invent a native cancellation receipt. The native network request context is
isolated from Browser Use cookies while retaining its own connection pool.

## Node descendants

`@varin/protocol/node/runtime` is the sole Node launch selection for Host-owned
Knowledge workers, semantic probes, script evaluators, extension brokers, bundled
language servers, debugger/test/task adapters and internal external-agent SDK
helpers. `VARIN_NODE_PATH` is an absolute executable selected by the release
launcher, not a command to resolve through PATH. Missing/invalid installed
components fail at their real spawn rather than falling back to another runtime.

The helper strips inherited private IPC descriptors and Electron mode. The old
Electron embedding can still use its own executable with Node mode through this
single compatibility boundary until it is retired. Normal system program/PATH
discovery, user terminal environments and explicitly configured third-party
harness commands retain their original owners. Node/npm package discovery is
separate from launching the shipped application runtime.

Focused tests cover real Node pipes and HTTP lifecycle with a substituted Host,
original auth/settings identity continuity, listener fallback and failure paths.
They do not substitute for the existing native kernel, Knowledge, extension,
installed-product or cross-platform suites.

## Shared desktop coordination

`desktop-connections.ts` is the one probe/login business owner for Electron and
the managed service. `desktopPlatformInvoke` routes `desktop_host_probe` and
`desktop_remote_password_login` to it through the native system fetch transport.
A configured expected server identity is checked on unauthenticated `/health`
before bearer/gateway headers are sent; explicit mismatches stop admission while
older servers without that field retain their established compatibility path.
Runtime capability/API and authenticated-session gates are unchanged. Login
retains direct token issuance and the older session-cookie/client-token fallback.
The per-install dedupe identity is read/written by the same transactional settings
store. Only the actual local Host controller can classify a desktop-local target.

Both shells now inspect redirects themselves. At most twenty same-origin hops
are followed; passwords, bearer tokens and custom gateway headers are never
forwarded to a different origin. Probe failure remains `unreachable`; login
returns its original HTTP status or a content-free connection error. The light
service can perform these operations without starting a local Host or Catalog.

`desktop-apps.ts` also retains the original installed-app cache, macOS/Linux
icon discovery, Windows executable discovery and platform launch-spec selection.
Electron paths are thin adapters/re-exports. The managed service emits
`installedAppsUpdated` for the original product event and requests only native
open/reveal/Windows-icon/launch primitives from the shell. User-launched IDEs and
terminals are spawned by the shell outside the managed Node scope, so closing or
recovering Varin does not terminate them.

## OS termination versus business drain

The Rust supervisor launches only its own Node services in an isolated Unix
process group or Windows Job. Windows starts Node suspended, assigns its Job
before the first instruction, then resumes its initial thread. The Job is
kill-on-close. Normal shutdown retains the original Host/Broker/Knowledge drain.
On abnormal pipe loss or Node exit, leftover managed children are terminated by
their own scope; no independent Host or user-launched app is targeted. The
supervisor observes the original Node exit and actual group/Job emptiness before
`wait_for_scope_end` succeeds. It does not erase the original failure or unknown
business outcomes, and `stop` does not become successful merely because cleanup
terminated a scope. No business request is replayed.

Unix groups cover the managed children that inherit this group, not arbitrary
programs deliberately creating another session. The kernel's native process
executors retain their existing private-pipe guardian and durable receipt owner;
Node exit alone is not their completion receipt. Windows Job cleanup and macOS
process-group behavior still require their real platform acceptance suites.
Linux tests cover a genuine extension broker with a never-finishing disposer,
real Node death, actual scope cleanup and an unrelated process left running.
Control-plane tests separately cover a real maximum-sized 64 MiB callback whose
subsequent native close remains serviceable through the reserved control lane.
