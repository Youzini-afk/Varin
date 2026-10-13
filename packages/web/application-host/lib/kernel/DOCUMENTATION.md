# Rust kernel client and storage boundary

The Application Host owns one `KernelClient` for its lifetime. `KernelClient.start()` spawns the
real `varin-kernel` executable, performs the build/protocol/epoch/grant handshake, and keeps the private
authenticated local control/content connections after a stdin-only bootstrap, separate from stderr.
Windows named pipes use overlapped I/O so a pending read cannot serialize the opposite-direction write.
Content bodies use per-stream sequencing, credits and fair chunk rotation; body encoding, assembly and
decoding run on managed workers. The frame bound applies to a packet rather than an entire result.
Both content directions support receiver stop and terminal acknowledgement, including cancellation
before encoding and while a dispatched chunk is blocked. Cancelling observation does not roll back the
domain effect; callers requiring the effect receipt continue receiving it. Generated method classifications
separate control parameters from bounded control responses: large inspections use content streams and
ordinary credits, while Run/Operation cancellation returns metadata without configuration, intent or result
bodies. Durable event cursor notifications coalesce; original events remain available for replay.
The kernel reports a compiled build identity and
target; packaged Hosts verify the adjacent manifest, executable SHA-256 and actual PE/ELF/Mach-O architecture before spawning it. Large blob
uploads and branch create/write batches use acknowledged request chunks through the handshake's request-credit window; `AbortSignal` cancellation
stops queued admission or signals the active kernel operation without returning its credit before native acknowledgement. `close()` drains admitted work, sends shutdown when possible, and waits for the
child to exit. A missing executable, protocol mismatch, malformed response, revoked grant, or child exit is
an explicit Host failure; it never selects the old backend as a fallback.

`kernel-launch.ts` shares executable selection and manifest checks with private helper modes.
On Windows, Documents starts `--watch-directories` as a separate notification process using the same
artifact. Its private JSON-line pipe carries subscription control and metadata only, with no Catalog,
storage owner, file body or tool request. See [Documents observation](../documents/DOCUMENTATION.md#filesystem-observation).

## Immutable object reader settlement

File-resource waits use `file.lease.wait`: Storage keeps the original request queued and grants its
whole resource set when earlier conflicting holders or waiters settle. Disjoint work proceeds;
waiters hold no partial leases and consume no transport credit while queued. Release, revoke,
retained worker completion and cancellation wake the owner directly. `file.lease.acquire` remains
the immediate busy probe. Abort racing a granted receipt still returns that receipt so its original
consumer can release it; an abort does not mean a retained file worker has drained.

The unchanged `getBlob` API uses the original scoped source and byte-range DTO. Abort sends the
existing cancellation control frame and keeps the caller Promise pending until the native response,
so input-transfer `close()` and resource-reader `finally` cannot mistake an abort signal for stopped
hashing or reading. Fixed-source native `file_read` uses the same Storage worker. Original grants,
record slots, branch paths and pins remain the access authority; temporary native read roots protect
bytes through GC without granting access. Worker completion rechecks current authority.

Transport failure is still an explicit disconnected error, not a successful reader-drain receipt.
Native Storage ownership remains held until its real workers stop, independently of a rejected Host
Promise. See the [finite blob-reader acceptance](../../../../../docs/reviews/runtime-blob-reader-2026-10-11.md)
for the native/consumer evidence and the separately unverified full IPC boundary.

## Experiment inputs from managed Sources

`managed-research-source.ts` fixes input in the target Storage; `research-source.ts` transfers verified
bytes into the coordinator's original Experiment input branch. Target paths are provenance, never
coordinator filesystem paths. The target's `experiment.input-capture` record and native branch receipts
retain the original source Operation, including its cleanup command. Live service handles drain before
durable cleanup; after a Host restart, cleanup uses the original address and maintenance authority rather
than recreating a source reader. Input capture does not choose the Experiment execution machine.

See the [implementation evidence](../../../../../docs/reviews/runtime-managed-experiment-input-2026-10-13.md)
for the real two-kernel coverage and the controlled admission/transport boundary.

## Same-task conversation views

The four authenticated `/api/threads/family/{list,runs,read,item}` routes use the original
AgentRuntimeClient and Rust Catalog/ContentStore reader. ThreadAdapter validates the caller's actual
Thread/branch and supplies `callerThreadId`; the nested target request cannot override that identity.
Rust alone derives family membership and validates query/anchor/Run/ancestry. The Host creates no
conversation cache, lineage authority or target model/source preparation. HTTP close cancels only
the original read request. Family replies use the ordinary content response path, not a control frame.

`ThreadFamily` inside the shared ThreadConversation is an on-demand read-only view. It retains actual
Run/item/tool identities, fixed-page cursors, explicit truncated previews and original JSON paging.
Host/caller/target changes abort requests and ignore late replies. Signed view tokens are deliberately
invalid after an owner restart; the user can request a new latest view. Ordinary history chunk hydration
also forwards mandatory `HistoryReference.run_id`, preserving inherited items' original Run owners.
Messages/continuation are not inferred from opening a view. See the
[family read evidence](../../../../../docs/reviews/runtime-family-reads-2026-10-11.md).

## Task-family messages

The authenticated `/api/threads/messages/{send,list,get}` routes use the original Catalog input queue
and ContentStore through AgentRuntimeClient. ThreadAdapter validates the selected Thread/branch and
sets the trusted User sender; the nested send request cannot contain actor or sender overrides. The
Host neither queues a second copy nor prepares a model/source or calls continueLaunch for an inform.
Rust validates the actual family and exact reply peers. Generated parameters accept explicit request
activation but reject tool-only wait/deadline fields: a User message has no original Agent observation owner. Read responses use the ordinary data path.

`ThreadsAPI.messages` and the shared `ThreadMessages` panel separate immutable acceptance from actual
history delivery and request activation. Received/sent lists contain metadata; opening a message reads its original body.
Reply preserves the received message ID and lets the original owner resolve the target. An unknown
send response retains the same body, target and key for retry, including across panel collapse; an
HTTP 400 alone is not evidence of non-acceptance when it reports a lost kernel response. The user can
explicitly leave an uncertain draft without withdrawing an accepted message. Host/identity changes
clear local drafts/views and late replies cannot repopulate them. Passive messages do not imply a
request, a reply Wait, a continuing Goal, or a new child Run.

Request admission belongs to Catalog, including active-Run binding and idle-root/child continuation.
The same durable event/startup pump consumes `ingress.run_ready` through `continueLaunch`; accepted
child requests appear in the original delegated-execution discovery. There is no Host request queue or
separate activation RPC. A new child request uses the exact fixed predecessor source and context path,
while only explicit UserContinuation parses User skill commands. The message panel exposes the chosen
inform/request kind, holds, exact Run/execution linkage and failed/cancelled activation separately from
delivery. Uncertain retries keep the kind as well as body/peer/key. Tree stop remains available even
when a Thread has no active Run or displayed children, so pre-Run requests can be fenced.

The message view also projects the original Agent reply observation, if any: exact wait/Operation/Run,
absolute deadline and replied/expired/cancelled state. The `delivered` flag checks actual lifecycle history,
not merely a terminal Operation. Ending a displayed own observation calls the original Operation cancel
path; peer observations are read-only, sent messages remain, and late replies retain their original link.
User UI sends never create a synthetic Run or Agent tool invocation to obtain a wait.

`runtime.observations.reconcile` is the single native child/process/reply observation consumer. It
replaces the split child/process reconcile RPCs while retaining the original child reports, source/file
results and process receipts. Startup discovery and `observation.run_ready` feed the same continueLaunch
owner. The native worker owns realtime deadline wakeups; the Host has no periodic wait timer, persistent
inbox copy or authority to resume a policy Pause/question/Goal because an observation ended.

## Runtime content maintenance

`POST /api/runtime/content/collect` accepts an empty JSON object under the existing Host authentication.
`AgentRuntimeClient.collectContent(signal)` calls `runtime.content.collect` for the current Agent owner;
callers cannot select another directory, provide a tool grant, or invoke system-kernel Storage GC through
this entry. No Run or input automatically starts collection.

The kernel admits the pass under the short Catalog owner and runs root SQL, content verification and
file deletion on its independent maintenance worker. The generated report preserves completed,
deferred, cancelled and failed states, the actual phase, removed object/byte/staging counts, and a nullable
reason. A partial failure is returned as that report rather than successful zero cleanup. Closing the HTTP
request forwards only this request's cancellation; it does not cancel Runs or erase work already done.
`removedBytes` counts immutable object file bytes; abandoned staging files are counted separately.
An aborted client Promise can reject before the worker stops; a disconnected caller is not guaranteed
to receive the eventual partial report. Native request credit remains owned until its acknowledgement.
The worker retains the original runtime file owner until it stops. This maintenance path is separate
from workspace `storage.gc` and adds no persistent job ledger, automatic retry or shared execution barrier.

## Frozen instruction and skill resources

The Host prepares instruction/skill candidates through the [resource owner](../agent-resources/DOCUMENTATION.md),
using actual Thread scope and the original source capture. ContextCheckpoint is their sole publication
owner. `runtime.resources.snapshot` resolves only the exact checkpoint bound by a real ModelStep or policy
call; the private resource bridge supplies call identity rather than accepting model-selected source handles.
The existing tool directory registers `resource_read`; neither the Host nor that builtin creates a second
resource execution ledger.

`POST /api/threads/resources/refresh` is authenticated and exposed as `ThreadsAPI.resources.refresh`.
It prepares a new candidate and publishes against the displayed context revision. It preserves the original
Thread/project/role, source, summary, memory snapshot and profile composition. Input with an explicit new
source prepares its replacement context before atomic input/Run/source admission. Old calls, forks and
summary recipes retain their original snapshot. Failed or stale candidates leave the active checkpoint intact.

Captured resource bodies read directly from the checkpoint. Additional immutable files use
`KernelStorageAdapter.withResourceRead`: exact branch/revision, original source receipt, scoped read-only
grant, owner pin and finally release/revoke, with no physical root or file-effect authority. The current
execution workspace need not equal the resource's original source. User configuration and installed assets
are captured through their existing owners; unknown capture-only paths require a new candidate.

Initial fixed-source Context preparation uses that same branch-only reader. Source admission inspects
only its pin metadata; the view's explicit `readOriginalSource()` loads the resource capsule when the
Context consumer actually needs it. Documents admits the original registration and current trust without
requiring the former live directory. Public input, launch retry and recovered launch all retain their
original source selection, and Run preparation forwards its existing cancellation signal into the reader.
`AgentRuntimeClient` binds the same Documents registration owner for fresh non-live source grants,
including independent script/research/document consumers. It rechecks before grant issuance, after
source preparation and at the final start RPC after credential/policy/extension/Memory/Plan preparation;
failed preparation revokes its new grant. A missing
owner is unavailable, never implicit permission. Source-less work needs no artificial workspace.
Child continuation preparation and cancelled/orphan source cleanup likewise use the original branch
owner, without obtaining a physical workspace context. Cleanup consumes the original Catalog release
facts even after access is withdrawn; it does not reopen source content.
Research input pins use the same rule: a private cleanup path checks the original Run, Operation,
execution owner and exact `branch.pin` receipt before unpinning with read/maintenance authority.
It cannot capture or read source content, and does not restore permission for new work. Revision
pins are already durable; the `persistent` flag belongs only to current working-root pins.

The materialized key remains tied to its original environment Run and exact managed path. Missing
copies or aliases to another copy reject preparation rather than rematerializing a substitute. Source
failures carry a closed code through public request, persisted launch/child preparation and retrieval
projections. The client/UI and Rust tool output supply short controlled explanations, never upstream
exception bodies.

Explicit user `/skill:name args` runs through `ThreadAdapter` submit/enqueue/edit and the same Host
resource owner. Private prepared material accompanies unchanged user text/media into the original
Catalog input transaction. The Host never accepts renderer-provided snapshots or expanded bodies.
Read-only submit/enqueue receipt queries reuse the original command identity before preparing a new
candidate; accepted retries do not depend on later resource configuration. Queue revision CAS publishes
text, attachments and skill selection together, preserving the old selection for unchanged raw text.
The Thread UI inserts commands into the draft and presents accepted resource metadata separately.

The `resource_read` activation selector is part of its actual persisted call. The bridge derives the
snapshot query selector from that request rather than accepting a second independently supplied value.
Catalog checks the frozen invocation and original input ancestry before choosing its original checkpoint;
current scope/trust and cancellation still apply. Older Pi resource/catalog/command consumers remain a
subsequent convergence step and retain their existing native session authority.

## Explicit follow-ups and source observations

The authenticated `/api/threads/followup/{register,list,get,control}` POST routes implement
`ThreadsAPI.followups`. Registration carries a stable key, selected Thread/branch, original source Run,
one `at` instant, accepted process/Job, exact-source `file`, original research artifact/collection/log condition, or flat `any`/`all` sources,
and the retained instruction.
Host validates the outer request, flat container traversal and selected Run ownership;
Catalog decodes leaf shapes and validates the actual trigger and accepted source. Only actual file
leaves require Host path extraction and their private source grant, not a second kind/field decoder. Agent tools use their own original invocation,
not this User route. Caller-supplied actor, wait and extra trigger fields are rejected by the User API.
List/control stay metadata-only; `get` checks branch scope before hydrating the original instruction.

Catalog owns the definition, occurrence and typed input. Its native worker observes the clock or
actual process stop with no Host timer. Existing input activation binds current lawful work or creates
a real idle-root/delegated-child continuation. The Host consumes `ingress.run_ready` through the shared
`continueLaunch` pump or finds the original pending launch/execution at startup. Current model/source/
credential/tool/policy preparation remains with its existing owner; generic `run.accepted` is not an
automatic launch instruction. Follow-up control cannot resolve an independent policy Pause or question.

The Thread UI supports one-shot local date/time (showing its exact instant), accepted process
selection, source-relative file `exists`/`changed`/`ready`, and `any`/`all` combinations. Each condition displays its original observed cursor or pending
state. Partial `all` progress comes from durable Catalog events; there is no client condition evaluator. It retains source Run, trigger, instruction and key across an uncertain response, including
when a newer Run appears. Reading an accepted instruction is on demand and abortable. Cards distinguish
triggering, input binding, actual delivery, preparation failure and continuation Run/execution. Bound
but undelivered ingress can still be paused/cancelled. The optional Agent observation is separately
cancelled through its original Operation, and does not kill its process or withdraw registration.

Normal terminal child cleanup retires source grants by exact durable Storage Host/Run, including after
Host restart. Retirement closes the old caller but retains stopped-process creation provenance for a
proven delegated successor. Failed preparation and explicit authority revocation still revoke. This
path uses the original grant owner, not a Host ACL/map of permitted old processes. No Pi calendar or
follow-up ledger is written by these native controls.

`followup-source.ts` admits User file leaves with a private exact-path `storage.read` grant after
validating the original launch/source and live Documents owner. Local admission retires that temporary
grant after the request. For a managed source, the original Catalog registration command first saves
its intent and exact source-read scope; B then binds that scope through its original Storage authority.
An uncertain bind is discovered through the same scope, and an accepted definition returns immediately
without acquiring another caller. After all leaf baselines are durable, the original scope is closed
before Catalog admission, retiring duplicate callers and fencing late binds. Accepted observations
retain their own original B receipts. This does not renew a previously accepted receipt or issue
process/write authority. Public
HTTP/tool arguments cannot carry `fileAuthority`, a physical root or a caller-chosen grant.

The authenticated `followup/registrations/pending` route projects original unconfirmed User file
acceptances for this Thread/branch, including after reconnect. `followup/registration/cancel` uses
the same original key and source Run; it acquires no new grant. The UI exposes these retained resources
with an explicit cancel action and preserves identity when cancellation acknowledgement is lost.
Native commands fence late Catalog admission before the original resource owner drains/releases.
Neither a missing definition nor elapsed time alone authorizes discarding an unknown User intent.

`file-observation-owner.ts` adapts the original Documents watcher, capture token and mutation state.
It shares root watchers but gives each open a separate handle. `file-observation-bridge.ts` carries
only epoch-bound private owner queries and disposes cancelled allocations after the owner drains.
`file-observation-service.ts` discovers Catalog's paged observe/paused/release bindings and coalesces
real watcher/managed-writer/Storage-release hints. It preserves dirty hints during a read or pause,
uses the last durably accepted position, and has no persisted condition state. Managed observations
use a transport wake timer to ask their original B owner; the timer is not a file event or condition.
Fixed successful observations stop polling, while failed observation/release acknowledgements remain
recoverable. Independent in-flight entries prevent an unavailable target from blocking another
source's cancellation. B reuses its original accepted file fact when watcher/readiness metadata has
not changed instead of repeatedly hashing the same body. Root hints
and exact receipt hints remain distinct, so fixed observers receive grant revocation without a fake
physical watcher. A managed writer being present gates readiness; it does not erase a stable file
snapshot needed by exists/changed. Broken source
receipts remain explicit per-entry failures without blocking unrelated healthy bindings.

File hashing and authority live in Rust Storage. Live-root identity, materialized original run roots
and immutable fixed revisions remain distinct. Catalog alone commits evidence and occurrence/input;
source gaps and a pending baseline remain visible in the Thread UI. Root unavailable is not leaf
missing. `ready` means a stable regular file with no original managed writer, not universal external
quiescence or semantic completion. Directory-entry invalidations are also consumed by Document
Registry, semantic inventory, LSP open documents and the original Pi write tracker; none treats a
directory notification as proven descendant file content.

Research log leaves are selected from the original Job directory's `observationKinds`, without
another Host/UI domain allowlist. Their registration keeps literal whitespace and byte offset;
short lists show original cursor, EOF, failure and owner-derived exhaustion. Detail reads restore the
original literal intent, and exact occurrence views preserve the accepted byte range after the log
grows. UI history classification retains pending occurrences and an undelivered optional Wait result.
The original Wait owner projects `delivery_pending` separately from actual history delivery; a failed
original Run does not leave an exhausted card waiting for a result it can no longer receive.
The original repeat/occurrence, source authority and independent research-control contracts apply.

## Responsibility table

| Resource | Current authority | Kernel boundary after Stage R |
| --- | --- | --- |
| Thread/Run product catalog | TS `ThreadRegistry` | remains TS; kernel receives an actor/grant and operation IDs |
| Explicit native Thread/Run and follow-up control | Rust runtime `Catalog` | Native identities use their own atomic admission and original execution receipts; no duplicate TS control ledger |
| Pi sessions, models, credentials, extensions | Pi worker/native Pi | remains Pi; kernel never reads provider secrets |
| Unsaved editor buffers and grouped undo | Document Registry | remains Registry; surface receipts are not kernel text authority |
| Knowledge graph/vector stores | Separate private Node storage owners + Host facades | TriviumDB remains authoritative for its domain; native database work does not run in the Host thread |
| Ordinary Agent notes and prompt edits | Rust typed `agent.personalization` record + Host service | separate from Bot knowledge and automatic organization |
| Working roots, immutable nodes, blobs, revisions, pins, GC | Rust kernel SQLite/object store | Production `KernelStorageAdapter` uses actor-scoped `branch.*`, paged roots and CAS; no TS WorkingState catalog write |
| Product records and object references (results, drafts, verification/review, retrieval artifact/receipt) | Rust kernel typed `domain_records`/`domain_record_refs` | `working.*` owns fixed result/draft/verification/review records; retrieval uses exact record identities; branch metadata is stored atomically with the branch rather than as a generic record |
| Recovery checkpoint/turn/mutation records | Rust kernel typed recovery tables and references | Production checkpoint/turn/mutation use `KernelRecoveryStore` directly |
| Combined Recovery/Integration/agent-mutation journal | Rust kernel typed recovery operations/files | Production consumers await Rust phase/terminal CAS; TS coordinates Registry receipts but does not persist a second journal |
| Canonical workspace file resources and controlled disk mutation | Rust kernel `fileResources` | Documents-authorized roots, exact/subtree leases, typed capture, conditional apply, mkdir/remove/rename and restart reconciliation; Documents/Files/Recovery/Integration and production `fs.lock` share this authority |
| Workspace file/structure computation | Rust kernel `compute` + `storage::compute_resources` | Immutable pin/live-root/fixed-object admission; native list/read/bytes/search/tree-sitter structure/chunks, foreground/background scheduling, bounded cursor/backpressure and actual cancellation. TS owns request policy/presentation, tokenizer/embedder/vector store and LSP protocol; no production Host ripgrep/AST corpus fallback |
| Public API and policy | TS Application Host | adapter only; no generic SQL or arbitrary disk method |

Session-facing root/path calls use an immutable `KernelGrantHandle` obtained for the exact session/Thread/Run. Cross-Thread Host lifecycle work uses an explicit workspace `storage.maintenance` grant; it never borrows an arbitrary live session. The
client's Host-management grant is limited to startup, health, grant management and explicit global maintenance;
it is not silently substituted for an actor grant. Rust resolves workspace ownership from the durable resource
(`branch`, `pin`, `operation`, `recovery`, stream or object owner) and applies path scopes to all expanded
entries. Blob bytes can only be read through a branch/pin path that resolves to the requested hash, or through
the exact temporary owner returned to the uploading grant. `KernelClient.scoped(handle)` injects that same explicit handle into each
domain method; it is not a mutable global identity.

The R0 production assembly starts from `application-host/index.ts` for Web/serve and Electron's embedded Host.
Electron stages the executable outside `app.asar`; Web/cloud stage it in package `kernel/`.
The private storage root is `<VARIN_DATA_DIR>/kernel/<hostId>`, with an OS-held owner lock (the
diagnostic record is not the lock) preventing two Hosts from writing it at once. Built-in Recovery shares
this root and reports `application-data` with `storageManagement: false`; it is not independently relocatable.
The source-view partition uses direct kernel record access without a workspace-Recovery decorator.
Its private directory is not registered as a user Documents workspace or checked against the deployment's
allowed work directories; user file access still passes through its ordinary Documents authority.
The public recovery v5 location methods remain available to replacement providers that advertise storage
management, but they do not move this kernel authority. A process epoch invalidates transient handles after
restart; Host, authority, worker generation, session, Thread and Run identity are bound into actor grants.

R1 uses SHA-256 content objects, Rust-typed path states, streamed batch-built immutable roots with a persistent
AVL child index, copy-on-write path updates, CAS on `writeRevision`, explicit fixed revisions, explicit
pins, idempotent `operationId`s, explicit operation/temporary-owner release, recovery roots, and reachability GC. Publish always binds
the expected root and write revision. Objects are streamed through SHA-256, flushed and installed before
a SQLite transaction publishes their references. GC records logical release and durable pending file cleanup;
cleanup failures remain visible and are retried on the next owner start. `branch.read` only expands entries when
explicitly requested; ordinary reads walk the root or selected paths. D-256 adds deep health checks for reachable
nodes and objects.

The working result/draft/verification/review boundary has generated `working.*` DTOs and Rust domain methods.
Rust validates nested documents, explicit branch identity, published root/revision and root-diff `changedPaths`; malformed
or mismatched records are rejected. Result documents also carry `baseRoot` plus per-path `baseStates`/`pathStates`
frozen at publish — Rust validates them against the publish-time baseline and result roots so a later `branch.write`
`baseRef`/`parentRef` rebase cannot rewrite an older revision's provenance. Drafts are dedicated fixed branches. Result
release removes dependent records and its revision atomically while independent pins retain the root. Current state is
read through scoped root/path methods; historical results resolve from their frozen provenance rather than the branch's
live baseline or a Host-side compatibility projection.

The shared wire source is `kernel/protocol/schema.json`; it generates both the TypeScript client shapes and Rust boundary DTOs. Regenerate with
`node scripts/generate-kernel-protocol.mjs` and check drift with
`node scripts/generate-kernel-protocol.mjs --check`. Request/response and cancel have separate envelopes; upload chunks are typed, sequenced
requests and receive ordinary acknowledgements. Rust rejects unknown envelope/method fields before dispatch. The current storage/catalog format is v10; startup validates
its schema fingerprint plus the complete table/index/column shape. Under the storage lock, an older numeric
internal format is discarded and recreated; a current-format mismatch, missing/invalid version, future format or corrupt
catalog fails rather than being repaired or opened as empty. This never touches workspace files, Git, native Pi data
or external configuration and does not add an internal-format upgrade/import path.

The old TS `WorkingStateStore` remains only for unit fixtures. Application Host production assembly uses
`KernelStorageAdapter` and kernel root/path/range APIs for branch reads, writes, pins, history, materializer/delete and result consumers.
Virtual publish pins one exact root through diff/read/publish, and scoped subtree reads are filtered in Rust before paging.
Combined Recovery/Integration/agent-mutation uses `KernelRecoveryStore` directly; intent and file/terminal CAS are awaited before
side effects or public completion. The old local SQLite recovery engine is a test helper and is unreachable from production imports.
There is no transient close-time flush, WorkingState fallback, or optional durable dual-write path.

R0/R6 release closure uses the same boundary in every shipped Host. Web/cloud stage `kernel/{manifest,binary}`;
Electron places it at `resources/kernel`. Release smoke starts emitted Host JavaScript and the executable from an unrelated cwd,
copies the installation and reopens the same catalog under a new epoch, and rejects a bad manifest. Electron no
longer ships or rebuilds `better-sqlite3`, `node-pty`, or `bun-pty`; target TriviumDB and sherpa binaries retain
their own package checks. The emitted Application Host import graph rejects a reachable legacy/test implementation
and prunes unreachable helpers before publication. See D-282 and the status matrix for measured evidence.

R2 adds `fileResources` without exposing a generic arbitrary-filesystem escape hatch. The Host registers a
Documents-authorized canonical execution root for an owning/execution workspace pair, then Rust resolves every
relative path against that root and the caller grant. Exact/subtree leases are the production overlap gate.
`file.captureBatch` is the WorkingState directory-capture path: one admitted batch lease covers
selected paths, and a background worker copies, double-hashes, and syncs staged bodies. The Storage
actor rechecks grant/root ownership before atomically installing verified objects and publishing their
owners in one transaction. Final rename/directory durability still runs in the Storage actor; body I/O
does not. This preserves stable per-file capture, not a simultaneous filesystem snapshot. Cancellation
keeps the request credit and actual lease exclusion until worker completion. Lease release and grant
revocation defer exclusion cleanup while that reader remains active; mutations cannot reuse its lease.
The Host batches paths for bounded protocol responses and waits for the capture's actual receipt before
abandoning owners. Inventory selection, Documents authority, and task isolation remain unchanged.

The selected native tool adapter binds file reads explicitly. `sourceMode: "fixed_branch"`
(the default when omitted) reads the bound immutable `fileSource` revision. `"materialized"`
requires a registered `rootId` and reads that environment's current filesystem through the same
Storage grant/root/lease authority; it rejects a simultaneous `fileSource`. Optional
`materializedSource` records the original branch/revision only and never redirects reads.
Materialized reads share the execution-environment resource claim with process spawning, return
bounded byte ranges, and reject detected concurrent file changes rather than claiming immutable
snapshot consistency. The Host coordinator owns when an exact revision is materialized and bound.

Materialized `file_write` and `file_edit` use the existing `file.apply` journal.
A complete file read or missing-path observation returns a `readVersion` scoped to the grant,
registered root, path, and exact file state. Mutation compares that version before preparing bytes
and supplies the observed state as `file.apply`'s conditional precondition. Partial reads do not
claim a whole-file version. Edits select unique matches in the original text and reject overlaps;
text mutation rejects symlinks and binary/non-UTF-8 content. The original mode is retained, with
BOM preservation and line-ending-aware edit matching. Durable intents retain their exact target
and request identity, so replay does not apply an edit twice. A confirmed apply reports a confirmed
effect; an error after dispatch remains indeterminate. These tools require an explicit materialized
source and Host-selected write permission; fixed-branch bindings are not silently mutated.

Native mutation recovery reads the exact existing `file.apply` journal under a freshly bound grant.
The journal retains its original grant and kernel epoch as provenance; those old credentials never
admit new work. Recovery verifies workspace/Run/Thread/root ownership and the exact frozen tool
arguments before returning a historical applied/conflict receipt. A started intent can be confirmed
only by observing its already-present target; recovery never reruns the edit. Missing provenance,
missing journals, and an unproved target remain unresolved. Canonical receipts omit newly generated
read versions so repeated delivery is idempotent. File observation uses the Storage owner while a
dedicated reconciliation worker keeps the native control actor available.

`file.capture` returns typed missing/file/directory/symlink/unsupported state and installs regular-file bytes as
kernel content objects; `file.apply` is conditional on an expected state and can consume only an authorized
object owner. `file.mkdir`, `file.remove`, and `file.rename` use the same root and lease authority. Started file
operations persist intent before the side effect and are reconciled on root registration after restart; an
unprovable state stays conflict/attention rather than being guessed complete. Recovery maintenance object-owner
rebind is restricted to same-workspace owners created by a `recovery.maintenance` grant.

Production Documents write/move/delete, workspace-scoped Files CRUD, Recovery/Integration disk apply and
compensation, and Harness `fs.lock` use this boundary. Varin-mode Pi `write`/`edit`/`apply_patch` routes real
disk/surface work through Host `document.surfaceWrite`; if that Host mutation backend is unavailable the worker
fails rather than falling back to its own disk writer. Document Registry still owns unsaved buffers and grouped
undo. Workspace/Git/bulk adapters that are not yet native Rust operations register exact/subtree writers with
the same gate.

R3 extends the same file-resource authority to baseline and managed execution directories. `file.scan` pages
Host-admitted filesystem inventories while excluding `.git`/`.varin`; `file.capture` installs the selected
body bytes as same-grant objects so WorkingState branch creation can consume them without owner rebinding.
WorkingState recaptures the selected paths before publishing a baseline or materialized result and refuses a
mixed view when content, metadata, or inventory changes. Git still supplies staged/unstaged/untracked, index
mode, dirty-content identity, and real filter/EOL semantics; frozen capture scopes are merged with Git changes.

`file.materialize` installs one immutable root through operation-specific staging and backup directories,
verifies every content object, reports actual reflink/copy counts, and reconciles an interrupted switch after
restart. Linux attempts FICLONE and macOS `clonefile`; unsupported filesystems use the formal byte-copy backend.
Windows acceptance currently proves copy only and therefore reports zero reflinks. Materialized Git execution
moves only linked-worktree metadata into the Rust-built body, runs `read-tree`/`add`/an internal baseline commit,
and propagates required filter failures without copying workspace bytes through TS. Native result roots replace
production mandatory side snapshots. Reclaim/discard/delete use kernel subtree removal and prune linked-worktree
metadata. `file.measure` reports actual block allocation on Unix; Windows leaves `allocatedBytes` null until a
verified physical-allocation backend exists. Legacy TS materializer/switch/snapshot code remains only as an
injectable test seam.

## Native file and structure compute

R5 is a read-only compute domain over the already admitted R1/R2 resource identities. `compute.start` accepts
exactly one source class: an immutable WorkingState `pinId`, a Host-registered live `rootId`, or explicit fixed
objects. Pin admission clones a short-lived reader pin before dispatch, so caller unpin, branch deletion, and GC
cannot invalidate a running job. Live-root reads revalidate the canonical root and bind every content-bearing
record to the revision actually read; source drift becomes partial/failure evidence rather than a fabricated fixed
snapshot. Registry drafts enter as fixed object overlays, including subtree tombstones, and are applied before
candidate limits.

`compute-runner.ts` acknowledges bounded record cursors and only releases terminal jobs. Rust has two foreground
workers and a separate background worker; output backpressure cannot let catalog/index work occupy interactive
slots. Abort sends `compute.cancel`, waits for the actual worker terminal state, then releases its reader reference.
Grant path scopes and requested roots constrain candidates before search/parse work. Native search uses the Rust
grep/ignore ecosystem plus the fixed Git inventory command for tracked/ignored membership. Native tree-sitter
loads Host-admitted grammar/query recipes and emits bounded symbol/hit/import/call batches or structural units;
there is no Host parse-tree/source cache.

Each native worker retains only the latest compiled tree-sitter recipe in each existing language-cache
entry, keyed by the verified grammar name and hash. The immutable recipe identity minted at admission
selects reuse; a different recipe replaces that entry only after all its queries compile successfully.
Revisiting an evicted recipe compiles it again with its own semantics. There is no separate recipe-history
cache: query retention follows the existing 32-language worker-cache lifetime without limiting which
recipes can run. Active analysis retains its compiled queries through an Arc. Grammar bytes are still
checked against the admitted hash on every use. Workspace and fixed-object bytes are still captured and
validated on each request. That capture's single SHA-256 digest supplies the object identity, native
revision and structural content hash; an opaque Registry draft revision remains unchanged rather than
being replaced with a disk revision.

The Host computes a directory's relative scope from the canonical filesystem identities of both the admitted
root and caller directory. Windows 8.3 names, junctions and symlinks cannot become false parent traversals;
aliases whose actual target lies outside that root remain rejected. Returned and streamed paths stay relative
to the caller's selected directory. Git inventory diagnostics report the actual repository root, whose display
spelling may differ from the caller's path.

Production `search.content`, file find, Harness grep/explore, language catalog, symbol graph and semantic disk
index use the same `KernelComputeService`. A virtual Thread query exposes path/revision plus a pin-bound compute
function; semantic recall invokes `unitsFixed` directly on that pin, so whole branch bodies do not transit through
TypeScript before parsing. Surface drafts still cross as Registry-owned fixed text because Registry is their source
authority. Tokenizer-aware packing, embeddings, vector storage, TriviumDB and Pi inference remain outside the
kernel. LSP remains the language protocol/navigation/diagnostic authority. Host `web-tree-sitter` is retained only
for install-time grammar ABI admission; it is not a workspace source parser. The dead Host JSON outline parser,
TS ripgrep child path, recursive file-search scanner and branch corpus/body mirror have no production consumer.

## Rust source ownership

Web snapshots, material collections and explicit thread-sharing grants use the
kernel's `web.snapshot`, `material.collection` and `material.grant` record types.
Their object references and restart durability are exercised through the real
kernel in `web-materials.native.test.ts`; Host map fixtures alone cannot verify
record-type admission.

The executable `main.rs` only invokes the library runtime. `lib.rs` owns crate assembly and `runtime.rs`
owns handshake, request admission, cancellation, and authorized dispatch; `transport.rs` owns the
authenticated connections and content stream lifecycle. A single
`storage::Storage` owns the SQLite connection, object root, process lock, cancellation state, and active
builders. Its implementation is divided into `core`, `operations`, `authority_store`, `objects`,
`state_tree`, `branches`, `recovery`, `file_resources`, `compute_resources`, `records`, `gc`, `maintenance`, and `dispatch` modules. Read-only compute workers live in crate `compute/{source,inventory,query,structure}` and receive admitted source handles/recipes from the Storage owner; they do not open a writable catalog or bypass grant checks. These are
one transaction/authority boundary with bounded source visibility, not independent stores. Storage domains do not
open their own writable catalog connections or bypass dispatch identity checks.

The Windows release child-process acceptance paths include `packages/web/application-host/lib/kernel/kernel-client.test.ts` and `kernel-compute.native.test.ts`; the current native authority suite covers the original R0/R1 invariants, R2 file root/lease and conditional filesystem apply, R3 filesystem scan/materialization/restart reconciliation, R4 process authority, and R5 immutable-pin/live-root search, scheduling/cancellation, Git inventory and native structure/chunk computation.
The production adapter longitudinal path is assembled in `application-host/index.ts`; actor-bound recovery calls
derive session identity from the persisted turn and use an explicit maintenance grant only for startup/list/GC
operations, never the Host-management grant for domain calls. `KernelRecoveryContentStore` is explicitly bound after adapter construction;
an unbound file store or Documents resource gate fails instead of writing the kernel object directory from TS or running without a gate.

## D-278 authority audit and acceptance boundary

The independent D-278 audit is recorded in [rust-kernel-audit.md](../../../../../docs/archive/rust-kernel-audit.md).
It historically reopened R2/R3 after GC/owner/pin repairs. D-279 closed those findings by exposing pending file
operation disposition/reconcile and durably joining kernel promotion to Git executionBaseline and Thread Registry/
view binding. The audit remains evidence provenance, not the current delivery status.

Physical lease overlap now lives in Rust `storage/file_resource_leases.rs`, across all registered roots. Grant/root
ownership still authorizes access; directional coverage alone authorizes use of an existing lease. Both nested
Host gates and production Documents calls use `file.lease.check`; equal paths do not imply equal scopes.
Root and resolved canonical scope are revalidated. Started remove/rename operations reconcile rather than replay
irreversible actions; ambiguous directory operations remain pending. Fresh materialization refuses uncollected
content, and failed verification preserves live/backup. GC retains pending materialization roots and cancels stale
physical cleanup when a blob has been reinstalled. Old epoch query pins expire while explicit revision pins survive.

`managed-root-admission.ts` separates recorded Thread target ownership from Documents execution workspace identity.
Materialization requires a retained worktree and the existing ownership assertion, not a guessed application-data
prefix. Capture/settle/reclaim use the actual execution workspace. `file.scan` continuations carry an inventory
fingerprint and fail on drift; the implementation still rescans each page and makes no O(page) performance claim.

Run `bun run test:kernel` from the repository root (or invoke its script by absolute path). The dedicated command
requires a release binary and runs Node-only transport tests separately from Vitest authority/adapter/recovery tests.
`--vitest-file=<path>` selects only that Vitest file; the unrelated Node transport suite runs in the default full invocation.
CI uses `node scripts/test-kernel-authority.mjs --build` in the existing Linux/Windows jobs. Generic tests may skip
native cases in an unbuilt checkout; the dedicated acceptance command cannot silently skip them. At D-282 the
command passes 25 Node release-process cases and 70 native Vitest cases, including request-window saturation and
truncated-input restart.

## Native process adapter

`process-service.ts` exposes pipe streams and the sole production PTY provider over generated
`process.*` DTOs. It holds grant/canonical-root context, not a second PID authority. Binary
stdout/stderr, original interaction receipts and actual exit codes come from Rust. PTY display uses an
incremental UTF-8 decoder. Close follows output drainage; failed native release retains the handle
for retry rather than suppressing its actual exit/close events.

Kernel transport loss invalidates live handles, rejects completion and keeps writer status unknown.
Pending launches participate in shutdown; consumers drain while native grants remain valid.
Startup errors carrying an owned child cannot trigger another interpreter as a fallback.
See [process ownership](../process/DOCUMENTATION.md). Web/Electron use the same production injection.

### Acknowledged interactions and original Agent terminal views

`process.write` and `process.resize` require a stable `operationId` and return the actual tagged
`KernelProcessInteractionReceipt`. ProcessManager allocates their shared sequence; callers no longer
allocate stdin counters or treat a queue acknowledgement as a completed write. The write receipt keeps
requested/confirmed bytes and requested/applied EOF, with applied, partial, not_applied or unknown
states. Confirmed bytes are the OS writer's lower bound, not proof of semantic consumption by the child.
The process owner keeps separate accepted-order queues for stdin and resize, so later resize workers
cannot restore an older size and blocked stdin does not hold resize. A long write/resize releases the
shared wire request credit only after the complete body has an owned cancellation identity in Rust.
The short `request-credit-released` envelope is not an effect receipt: the original pending request,
AbortSignal and shutdown drain remain until the final response or disconnect. Ordinary reads/new Run
input and direct process stop therefore do not wait for another process's stdin; stop uses the control
response window. This does not enlarge a window or create a new execution queue.

`process.interaction.inspect` reads the original intent/receipt without resending input. A lost reply or
partial write is never automatically retried under another identity. Pipe EOF closes its writer; PTY
EOF is explicitly unsupported rather than pretending that dropping a cloned PTY writer sends EOF.

The native `process_write` and `process_resize` tools use the same process-domain worker, original
ModelStep or PolicyAction intent, permissions and final external receipt. Storage's existing operation
journal retains the short identity, digest and original/current authority; the guardian persists the final
receipt before confirmation. Large body encoding and OS waits stay outside Storage/Catalog control.
Cancellation stops unissued chunks and keeps an already dispatched blocked chunk owned until its
actual receipt arrives. Reconciliation reads that receipt rather than replaying input.

`POST /api/threads/process/terminal`, through `ThreadsAPI.processes.openTerminal`, validates the selected
Thread/branch and original process Operation. The Host rebinds the durable source under a fresh same-Run
grant, and `runtime.process.access` checks the original process authority. `TerminalRuntime` adopts its
existing PTY through `KernelManagedProcess`; it does not spawn, fabricate a provider call, or maintain
another process ledger. A completed Run can retain its independent job. A follow-up Run's read relation
still grants no stdin/resize/stop authority. Original-grant revocation also closes aliased subscriptions.

Shared terminal protocol generation 4 carries an input identity and a `written` acknowledgement only
after that original native write completes. Renderer `sendInput` waits for it; partial/error or connection
loss rejects the original Promise and never replays that input on reconnect. The identity is scoped to
the original terminal before reaching the process journal. Older generation 3 frames are rejected.

The shared terminal's user input, automatic theme responses, HTTP resize, shell supervisor and remote
shell adapter await actual interaction receipts. Async input failure preserves unknown/partial evidence
and writer protection; a later real process exit can still settle the original command. An Agent terminal
view is retained on close and cannot be restarted as another shell. Host shutdown detaches its projection;
explicit stop cancels the original Catalog Operation and awaits actual tree/output completion. Broken
views may rebind and replay the same retained output without resending input. These projections do not
release the native job's spool. Kernel startup/shutdown itself retains its existing process-tree ownership.

Portable consumer evidence lives in `thread-processes.test.ts`, the owning terminal and shell suites,
and the UI conversation behavior test. Native OS and Catalog evidence lives in the kernel's
`process_interaction_review.rs` and policy domain review. Supplied framed-resource fixtures and actual
guardian tests remain separate evidence from the product Host IPC and cross-platform acceptance.

## Focused native performance observations

`scripts/measure-kernel.mjs` remains the measurement owner. Its `--compute-hotpaths` mode measures a
generated 31,450,000-byte live/pinned search and repeated structure batches over 128 distinct TypeScript
files. For example:

```text
node scripts/measure-kernel.mjs --compute-hotpaths artifacts/compute-hotpaths.json artifacts/kernel-compute-after/varin-kernel.exe
```

The optional final argument selects the built Web package root (default `packages/web`). Both compared
kernels use that package's emitted Host adapters; rebuild Web before attributing an adapter change to this
measurement. Reports include corpus/result hashes, binary identity, first/warm samples and separate process
memory observations. Corpus creation and object upload are outside timing. The OS cache is not flushed.
The owning Rust tests count successful query compilations across distinct documents and check recipe
replacement/revisit semantics, corrupt content rejection and cancellation; latency by itself is not a
compilation/hash counter.

## Ordinary extension tools

`extension-tool-owner.ts` adapts an installed service's single `tool` declaration and exact service
pin into the native ToolDirectory. It reuses the existing catalog, routing and supervisor; it does
not create an MCP server or a second extension lifecycle. Input/output schemas compile once for the
retained binding through the same `@varin/pi-host/tool-schema` compiler used by MCP. The declaration's
read/effect hint never grants permission or proves replay safety.

`AgentRuntimeClient` owns the Run's combined ready MCP/extension snapshot. Cold contributions prepare
independently; the short select/ready publication merges the latest ready set. The kernel activates
that candidate at a closed request/action boundary. A frozen request keeps its actual old endpoint;
explicit revocation still rejects it. Recovery verifies the original package/declaration identity,
and does not substitute a newer artifact when the original is unavailable.

`tool-bridge.ts` and Rust `host_tools.rs` carry real ModelStep, PolicyAction or NestedCall origins. The existing
permission owner checks the exact operation, arguments, schema and selected owner. Host-only invocation
scope is derived from that admitted operation and its immutable Run source. Only the opaque scope ID
crosses the broker boundary; the original owner/generation and active callback determine capability
access. `material-tool-owner.ts` exposes `materials.snapshot` through the existing WebMaterialStore,
snapshot grants, persisted collections and native byte-range reader. The runnable authoring example is
[`material-snapshot-tool`](../../../../../examples/extensions/material-snapshot-tool/README.md).

`nested-tool-owner.ts` exposes the ordinary `runtime.tools` capability only through this active
invocation. The SDK's `call.tools.invoke` supplies a stable local call ID, tool name and JSON arguments;
the Host supplies the verified original parent Operation and executor owner. Rust owns input decoding,
frozen selection and each target's original permission/resource lifecycle. No second tool allowlist
or caller-provided source is used. `withToolInvocation` closes new calls and retains actual registered
RPC promises after callback return; observer abort is not a physical-stop receipt. Independent accepted
Jobs and returned Unknown effects remain with their original owners, not an outer aggregate receipt.
The protocol schema owns deferred-body-credit methods, so accepted nested calls can make further
domain/permission requests without occupying the entire body window. Cancellation and final receipts
still use the original pending identity. See the installable
[`nested-tools` example](../../../../../examples/extensions/nested-tools/README.md).

`script-runtime.ts` binds the ordinary installed `varin.builtin.scripts` declarations to this same
invocation owner. `script_open` returns an original Environment Job ID; `script_run` executes ordered
async JavaScript cells against that exact Run/source/Node binding; `script_close` requests exact
cleanup. `@varin/script-runtime` is the sole Node lexical evaluator and private worker framing owner.
The Pi Computer adapter imports it with its existing Computer SDK rather than maintaining another
REPL or gaining Native tool permissions. Native scripts use `tools.invoke` and the original frozen
directory. Their direct Node I/O is unrestricted execution, not a desktop-only sandbox.

The existing Storage process, interaction journal, output subscriptions and guardian launch and stop
the helper. Process requirements come from the selected declarations; no second process-tool name
list or forced `process_spawn` selection supplies permission. Idle environments remain source writers.
The original Run ending stops only its environments; independent nested Thread Jobs retain their
lifetime. A cell closes admission and waits for its actual accepted callbacks; EOF, a new Host/kernel
epoch or cancellation intent alone never proves physical stop. The original environment Operation
retains unresolved cleanup. A finished close control call projects `environmentStopped` and the
original environment receipt rather than creating another Unknown writer.

Actual Computer dispatches attach their already-authorized desktop and original cancellation hook to
the active cell ancestry. Cleanup starts those controllers before waiting for the Node tree or Catalog.
Desktop Stop selects only matching active cells. Proven same-environment or same-desktop ancestor wait
cycles produce actionable errors; unrelated environments and desktops remain usable. Restart loses
the heap explicitly and never replays source. See the shared evaluator README for the known Node 24
`await Promise.reject(null)` limitation and its typed media output contract.

Cancellation detaches the observer without fabricating a stopped callback or no-effect result.
The existing bridge call retains its actual callback and unacknowledged receipt across a kernel-channel
replacement, using the original external execution identity. Catalog durably commits that evidence
before acknowledgment; reconnect retransmits the fact without re-executing the tool. Full results use
the existing content stream rather than a total-result frame-size clamp.

Authenticated `POST /api/threads/tools/inspect` and `ThreadsAPI.inspectTools` project the activated
directory, selected durable bindings and independent preparation states. Revoked or unrebound owners
are not callable. This metadata is not a permission grant and not a second tool registry. Actual
Host/kernel acceptance and its current environment limitations are recorded in the implementation plan.

## Selected native policy planning models

The installed `varin.agent.policy@4` service declares `modelRoles: ['agentPlanning']` in its
pinned description. Only that selected policy triggers planning preparation. The Host reads the
existing authenticated `settings.get` catalog path, validates `harness.models.agentPlanning` using
`parseHarnessModelSlots`, and resolves it with `resolveHarnessModelSlot(..., null)`. The role has an
explicit model picker in Context settings and never inherits the main model. Disabled, unconfigured,
invalid settings, unavailable catalog/auth, and available selections remain distinct.

`policy-models.ts` resolves registered IDs through `model-authority.ts` and freezes the
configuration identity, purpose, supported operation and nonsecret binding ID. Rust derives the actual
tool-free request binding and retains the selection with the launch. Policies receive only capability
IDs and availability descriptors, never endpoints, provider selectors or credentials. Rebinding
verifies both the selected role and original configuration/account scope; it cannot select a replacement.

The existing private credential bridge keys owners by Run and frozen binding ID. Planning binding IDs
include the strategy generation; candidates cannot replace the active strategy's credential entry.
The main owner has
its own empty binding slot; auxiliary registration cannot replace it. Requests retain their exact
scope, kernel epoch and optional endpoint/payload digest for signing. Run cancellation, release and
transport shutdown retire every bound owner. Parked Run resumption retains an available exact policy
pin, or restores its committed artifact and saved planning configuration. It does not select today's
model settings as a replacement for a saved role. Tokens remain transient private replies, never launch
or policy data. Production Pi,
the default native policy, and policies without declared planning duties do not prepare this role.

## Native live workspace selection

Native Threads expose three explicit source modes: `fixed_branch` reads its immutable revision;
`materialized` creates and continues the existing isolated working copy from a fixed baseline;
`live_root` operates on the selected workspace's actual saved files. The default remains the fixed
snapshot. Selecting live access does not capture the directory or include unsaved editor buffers.
File edits affect the real workspace. Shell cwd and process management are not an OS sandbox.
Live identity pins the admitted canonical pathname on its Host, not a directory inode or a whole-project
snapshot. Native Run preparation observes cancellation and revokes failed launch grants; the public
source preparation/submission API does not promise a general pre-admission AbortSignal contract.

`live-source.ts` is an admission adapter, not a registry. Documents retains the durable
host/workspace/root mapping; Rust retains file/process authority. The Run's existing launch intent
records live mode plus nonsecret host ID, canonical root and deterministic Rust root ID. Submit,
continuation and restart revalidate the exact Documents mapping; each launch gets a fresh scoped
grant and registers that same root. A changed host/root/registration is unavailable, never a reason
to substitute the current project, infer a snapshot, or recapture files. Rust compares the complete
source at launch and mutation reconciliation and validates the registered root on actual access.
The Rust tool boundary rejects process spawning for fixed sources even if a caller supplies a valid
physical root. Read/list/search provenance comes from the verified binding: live results carry their
actual mode/root ID/live descriptor, never a materialized label. File read versions remain observations
of the actual live file; the frozen instruction checkpoint does not pin later file reads.

The initial live AGENTS.md is read through Documents and its actual revision is frozen in the
existing context checkpoint. Later disk changes remain live for file tools but do not retroactively
rewrite that instruction checkpoint. Ordinary instruction/memory refresh retains its existing owner.

Live, fixed and materialized selections expose definition, references, diagnostics, hover, workspace
symbols, hierarchical document symbols and one-query incoming/outgoing call hierarchy. Native tool
contracts, names, grant admission and history remain in the original Rust declarations;
`language-owner.ts` reads the exact original source through the shared `source-query.ts` owner and binds
its text through the existing LanguageViewBinder and selected
LanguageSupervisor. The private epoch-bound language bridge does not own another process, provider
registry or configuration store. It starts no language service during source preparation. Shared
startup and per-query cancellation remain with the existing supervisor; no file lease or Catalog
transaction spans a language wait.

The original project namespace selects provider configuration, while the admitted physical source
selects cwd/root URI/workspace folders and the watcher. The original process service rechecks a trusted
source-owner callback immediately before spawn. Run/grant references retain `agent:source:` views;
query cancellation leaves those references intact. Terminal notification or grant withdrawal starts
retirement, but child result capture separately awaits actual language drain and the existing Rust
directory-writer barrier. A notification/withdrawal ACK is not a stopped-process receipt.

`runtime.source.tools` projects the original Rust declarations and source requirements. Source
preparation and saved launch continuation consume that directory instead of maintaining parallel
Host tool-name lists. Private wire 17 carries the original selection/root/grant, and result provenance
nests source selection separately from the queried document revision. Catalog 58 is unchanged.

Fixed language views use the original Storage `file.materializedView.prepare/check/release` resource
and materialization worker. The Run remains `fixed_branch` with no physical source root; provider
cwd/imports/project configuration use its derived tree. Input and returned target content still come
from the original immutable branch. Supervisor references are the sole logical lifetime owner; Storage
retains only the physical descriptor, original root, directory identity and journal. Shared preparation
uses a Host-private service context, never another Run permission. The original Run must admit the whole
project required by this language backend; a path-limited grant can still use ordinary scoped file reads.
Last-reference retirement waits for actual process drain, releases only that process context, then runs
recursive directory cleanup outside the Storage control owner. Unknown writers retain their resources.
Changed derived trees fail the current query and retire before a later query prepares a new generation.
No query hashes the whole tree or silently falls back to live files. See the
[fixed-language review](../../../../../docs/reviews/runtime-fixed-language-2026-10-12.md).

Navigation positions are zero-based UTF-16. The query records its actual bound document revision,
view, provider and generation. Dependency provenance separates the captured project (`source: fixed_branch`)
from live/working-copy projects (`source: live`); external libraries/configuration remain explicitly
`external: provider_environment`. It does not claim an OS sandbox or fully frozen compiler environment. Both Host and Rust
recheck the input after the query. Rust admits each returned resource under the original Run grant,
observes that target's own content revision and validates range bounds. `observedRevision` is a
post-query observation; cross-file `rangeRevision: null` acknowledges that standard LSP locations do
not prove the target revision used by the server. Native-only strict mapping distinguishes out-of-scope
and unmappable locations; unavailable targets and stale ranges are separate omission counts. A partial
result, including one where all locations were omitted, is not a successful empty query. Diagnostics
return current versioned push or pull evidence; pending/stale/unsupported/unavailable never mean clean.
The native diagnostic projection exposes primary locations rather than nested related-information links.
The currently bundled TypeScript server publishes unversioned diagnostics without pull support; its
native diagnostic result therefore remains pending with `diagnosticVerification: unversioned`.
Actual nonempty observations are retained and admitted, with `rangeRevision: null`; their current
file observation does not prove the diagnostics were computed from that revision. Omissions preserve
pending verification rather than upgrading the observation to verified partial/clean.

Hover markup remains literal provider data with its optional range. Symbols recursively retain their actual
resource: only URI-less document nodes inherit the queried document, while an explicit rejected workspace
URI cannot become a local symbol. The original supervisor's source call query keeps raw prepared items
in query-local memory and sends them back only to that provider; it neither clears shared editor tokens
nor exposes opaque data in tool history. Every relation RPC checks the invoking Run's source authority
and signal after shared preparation, immediately before dispatch. Returned edges use `{from,to,fromRanges}`;
site ranges belong to `from`, including when prepare at an import alias resolves to another file. Rust
admits each resource and range using one query observation cache, without a generic JSON walker or a new
permission registry. See the [language query review](../../../../../docs/reviews/runtime-language-queries-2026-10-12.md).

Host replies are serialized and checked against the existing frame budget before touching the shared
kernel writer. Oversized/nonserializable language replies become a small unavailable receipt. Language
result chunking is not implemented. Oversized transient Rust progress is omitted before the shared
writer; durable tool content remains available through existing chunked history reads. Transport loss
still retires the actual private channel.

Fixed-branch language queries use a Storage-derived captured project while their source identity remains
the original branch/revision. Materialized queries use the actual working copy and report live dependencies.
External symlinks, configuration outside the captured tree and compiler libraries remain provider-environment
inputs; neither a workspace cwd nor a didOpen overlay is an OS sandbox. The
[fixed language review](../../../../../docs/reviews/runtime-fixed-language-2026-10-12.md) records actual
TypeScript, child, Storage/history and reopen evidence, including remaining platform and Worker settlement
boundaries. The preceding [materialized review](../../../../../docs/reviews/runtime-source-language-2026-10-12.md)
retains its historical verification scope.

The native `run_launches` domain is format 3; current Catalog/content versions are recorded in the
[runtime README](../../../../../kernel/crates/varin-runtime/README.md).
This is an intentional incompatible internal encoding change from the old `materialized` boolean.
Existing format 1, missing or malformed launch metadata is rejected before writable SQLite access,
epoch advancement or recovery. Read-only preflight observes committed WAL pages. Original database,
WAL and content assets are preserved; there is no migration, silent inference or alternate reader.
The persisted `live_root` field is required: fixed/materialized encode explicit null and live mode
encodes the exact descriptor. Missing fields do not silently manufacture a legacy source identity.


Native live-language acceptance is recorded by suite in the
[implementation plan](../../../../../docs/plan/agent-runtime-implementation.md#已核验增量live-root-原生语言工具):
Rust rendezvous/framing 5; native controlled-owner 20, source entry 1, real bundled TypeScript loop 1;
portable owner 12 and bridge 3; existing Pi navigation 15 and diagnostics adapter 4; UI 18.
These are focused checks, not an all-repository, fixed-dependency-closure or cross-platform pass.

## Native code retrieval

`code_retrieval` is a live-root read tool. Its private query carries explicit native Run,
Thread, grant and root identities, plus the real persisted invocation origin: ModelStep request and
tool-call IDs, or policy action/node and tool-call IDs. The bridge UUID is transport-only and cannot
identify an inference dispatch. It does not create a Pi session/worker or reuse a Pi Explore actor.
`retrieval-owner.ts` reuses `createExploreQueryRun`, Documents, the existing structure facade,
and Rust compute. Keyword jobs use the actual Run's scoped client, never the Host-wide directory
compute grant. `file.read.check` admits each candidate's canonical resource and regular-file status
under that same grant before Documents reads it; the post-read check rejects changed identities.
No file lease spans structure, semantic or model waits. The kernel re-admits the Run after the Host
wait, checks every returned path/revision/range, and reconstructs source text from observed bytes
rather than trusting a provider's result body. Unknown nested payloads do not enter tool history.

`harness/retrieval-pipeline.ts` holds immutable selected method handles and a `PipelinePlan` with
configuration identity/generation. A query captures its selected immutable service artifact and plan
before retrieval I/O. The composition caller prepares a replacement through its existing capability owner, then publishes it;
failed or superseded candidates preserve the previous selection. This adapter is not another index,
parser, configuration file, or background preparation service. Shared grammar/runtime preparation
still belongs to Structure/KernelComputeService; cancelling a retrieval only detaches that query.

The production selection comes from `varin.retrieval.plan@1` through the existing extension service
routing/configuration path. Three lazy built-ins expose keyword+structure, keyword-only and explicitly
selected keyword+structure+semantic declarations;
no query or source text is sent to the declarative selector. The query's real native Thread key,
accepted Run checkpoint project and admitted canonical workspace directory fix routing scope.
`plan.selection` records provider key, artifact/configuration identity and routing revision. A service
pin survives normal generation retirement for old queries; explicit revocation invalidates its use.
Preparation failure reports failure and preserves the previous published plan without treating it as
the failed new selection. Keyword+structure remains the default; only the explicit semantic declaration
acquires a native semantic owner lease. The declaration cache holds no query lease. Each query pins
its actual backend/configuration/account and published-reader generation, records their nonsecret
identity in `plan.semantic`, and releases that lease with its real service generation pin. The
metadata retains explicit binding state, nullable unavailable backend IDs, and the captured
publication's coverage/lifecycle; a capability implementation ID never substitutes for a missing
model configuration. Live cold or
missing publications do not start indexing or wait for first publication. Non-live queries lazily
prepare their own source view as described below. Semantic selection never
chooses another model, silently selects local embeddings, or performs a paid preparation probe.
The existing embedding settings configure the explicit remote backend. The separately selected
model stage uses the original code-retrieval settings and dedicated rerank binding described below.

Semantic candidates contain index identities, not authoritative source bodies. The owner checks the
original Run grant before query embedding, before and after authorized Documents reads, and before
final delivery. Both the candidate's indexed file revision and the chunk's SHA-256 content hash/range
must match the current admitted snapshot. Stale indexed spans are omitted, never relabeled. Async
lease validation fences explicit backend disable, credential/account changes and owner/epoch loss;
normal replacement retains the originally pinned backend/reader. Native query embedding shares the
original Catalog inference session and ordinal allocator with decision, rerank and Explore. Its actual
request/body/usage survives independently of source delivery; no duplicate receipt travels in the
retrieval result or the background index ledger. A warm query vector cache requires the captured
credential scope and current source authority, adding no request or usage. Missing output-token usage
remains missing, including for Goal's original output-budget gate. Cancellation promptly detaches the
query rendezvous while the original inference owner retains actual HTTP/body drain and receipt
publication. A late settlement cannot revive source delivery. Rust rechecks the Run and suppresses
source on cancellation/revocation. No file lease spans those waits.

Results record per-stage availability and omissions. Cold/missing/unsupported/failed stages do not
become successful empty recall. Large structure units retain the slicer's real kept ranges: native
snippets are contiguous spans, with hit-bearing ranges delivered before signatures under a caller's
snippet cap. Omitted unit bodies are not filled back in. The existing Explore byte budget bounds the
Host pack; framing/reconstructed-body budgets fail or report partial without killing the shared writer.
Each snippet has path, inclusive one-based line bounds and actual Documents revision for a later
`file_read`. Its `readVersion` is a separate authority-bound mutation CAS token, not the
Documents content revision; verify a follow-up full read against the snippet's content digest/bytes.
Live observations do not claim an atomic workspace snapshot.

Fixed/materialized semantic recall also uses the original source adapter: fixed inventories use tree
revision metadata; actual materialized files use per-file capture revisions. Collection paths are
intersected lexically with registered configuration identity, without resolving an old live root.
The first semantic search lazily prepares missing source units/vectors; acquiring the lease never
waits for that work before keyword search starts. A captured immutable publication supplies only
matching source revision/recipe/space rows; the view masks all other base rows and adds exact-source
extras. Completed chunks and vectors use the original byte-budgeted cache. Empty original-owner
readers need no copied publication or new database, and transient coverage is distinct from captured
publication metadata. Foreground document HTTP uses the same native InferenceCall as query embedding,
with a complete source-version check immediately before transport and before candidate installation.
Short Run/source/binding checks remain independent; admitted no-send and already-paid usage remain
original Catalog facts. There is no whole-working-copy atomic snapshot claim. Complete fixed LSP
dependency closure and remote retrieval remain separate work. The default Pi route is unchanged; native semantic recall
uses its own explicit backend/published-reader acquisition through the existing semantic owner rather
than the Pi wrapper that resolves a mutable backend at search time. Query bindings retain actual owner
references, not a frozen wrapper around whichever backend/index happens to be current later.

### Model stages in native source retrieval

`retrieval-model.ts` consumes the existing global `harness.codeRetrieval.decision` selector and
`harness.rerank` connection. The extension plan still selects structural/semantic composition; it
is not a second model selector. `source` dispatches nothing, an explicit unavailable reranker stays
unavailable, and `auto` respects an explicitly enabled Explore model slot before fast-decision rather than silently
choosing a different paid model. A ready Explore LLM plans and jointly selects source; in auto a ready
fast-decision role independently handles actions. An absent/disabled Explore slot continues through the
original classifier and rerank choices, while an explicitly selected unavailable model stays visible. Slot parsing/resolution comes from the shared configuration contract, not another model list.
A query pins its actual credential/configuration binding through the original Host credential owner.
Deleting the original rerank selection is explicit Off and retires retained leases; normal/invalid
replacement candidates leave accepted bindings intact. A nonempty request with no scored documents
is a failed model stage, while its original response and usage evidence are retained.

`knowledge/semantic/inference-requests.ts` is the shared decision/rerank HTTP lifecycle. The real
Kernel invocation scope delegates the query identity; original Catalog Operations/Goal own each
HTTP request, dispatch, raw response and late receipt. No synthetic model tool call or extra ledger
is needed for a cheap read. Source grant and original Documents identity are checked before/after
the model wait, and Rust still reconstructs final snippets from verified revisions and line ranges.
There is no source lease held over HTTP. Cancellation can detach the cheap query while its actual
HTTP child remains pending; local drain is recorded only by the original transport owner.

The original http-rerank parser preserves zero scores and partial results. Scored candidates sort
stably ahead of unscored or over-budget candidates, whose original order remains visible with partial
status. This generic protocol does not define input/output token dimensions: raw usage/meta are
retained, but total tokens are not relabeled as input and output is not invented as zero. Actual
requests therefore retain missing usage under the original Goal barrier. Protocol-specific known
metering and material-purpose consumers remain follow-on work.

`fast-decision` uses the original `ExploreQueryRun` and `runExploreFastDecisionLoop` before
query finish. It judges source-issued views and action candidates, applies successful selections and
executes original followups while sources progress. The query owner checks issued material identities,
Documents bytes/revisions, source binding and original grant before each HTTP and delivery; the model
cannot introduce paths or commands. Quiet frontier, cancellation or the original deadline ends the loop,
not a fixed round limit. A failed batch contributes its observed usage/missing facts but no selection or
actions; earlier successful selections remain. Missing/false/zero answers never grant an action.

`DecisionInferenceLease.run` keeps one original inference session across every classifier batch and SDK
request, so ordinals do not restart and earlier usage is not counted again. `research_decide` uses the
same session interface. Loop summaries omit an unknown token dimension instead of filling it with zero;
Catalog still owns each actual HTTP charge and its unknown-usage barrier. Purpose Off and credential
revocation suppress new work/delivery while preserving the original receipt and actual body-drain facts.

The shared `protocol/explore-model-loop` is also the actual Pi consumer: prompts, planning, retained
joint replacement, explicit empty selection, required groups and race-free source waits have one
implementation. Native adapts the original query directly. The FD loop settles explicitly after the
LLM consumer finishes, so an idle action loop does not deadlock collection. Each role checks its own
configuration/credential revocation; disabling one does not silently assign its paid duty to the other.
Required selection components survive both Host packing and final Rust version/encoded-budget checks;
a stale required member drops its component rather than publishing a partial group as intact.

`runtime.inference.generate` admits native tool-free generation into the same inference ledger.
The original query delegation proves the caller, but the Operation executor is Kernel. Its supervised
worker uses `model_session` adapters and the exact operation-lifetime private credential binding;
Host HTTP settlement endpoints cannot write native receipts. Request snapshots, original provider
items/events/opaque output and full usage stay in ContentStore. Recovery keeps durable checkpoint usage
and never replays generation. Query cancellation may detach before this worker actually drains.
One Host query session allocates every embedding/classifier/rerank/native ordinal, and per-request receipt callbacks
keep concurrent native charges out of the classifier's batch summary.

### Model item identity and committed-history recovery

Provider item IDs are scoped to their response, not globally unique history keys. Native history
uses a deterministic length-prefixed `(requestId, providerItemId)` identity, shared by Catalog append
and the execution cursor. The conversation request identity is the owned Run/epoch/ModelStep; auxiliary
model-purpose operations use their own receipt path. Provider IDs, opaque payloads and durable model
outputs remain unmodified. Duplicate item IDs are rejected within one output batch. Repeating the
exact same committed ModelFinished receipt is a read-only idempotent acknowledgment; a changed body,
owner or epoch is a conflict.

Recovery uses the actual committed history owner rather than recomputing a historical ID. It verifies
the exact consecutive model rows immediately after the frozen request leaf, with branch/thread
ownership, row/header identity, order, content, opaque originals and tool-call sequence. Later tool
results or another step cannot be selected as this output. Only candidate row bodies are hydrated;
unrelated ancestry uses metadata. The actual persisted head then gates continuation. Existing rows
are neither rewritten nor recognized by an old-ID pattern, and inconsistent anchors/bodies fail
explicitly. This changes no Catalog/content format and introduces no migration or alternate reader.

### Acceptance for this increment

The final 0.9.24 kernel has SHA-256
`d04874a6c88c42c32704db2afc3c92609554bf9a16a47a74e661fc1d08b4c630`. Independent acceptance
passed 21 new native authority/pipeline/composition cases, 3 portable pipeline cases, and 2 actual
UI-selector/Host-routing cases. Existing native consumers passed 7 selected cases: live-source and
language concurrency (2), context/initial-context/reopen (3), durable history (1), and pinned history
pagination (1). Rust catalog passed 31 cases, including 4 independent identity/recovery cases;
execution passed 12. The unchanged content owner retained its earlier 7 passing cases. These are
scoped suites, not whole-repository or visual UI acceptance. The [implementation plan](../../../../../docs/plan/agent-runtime-implementation.md)
records the initial provider-ID collision and corrected candidate-publication fixture sequence;
neither initial failure is counted as a passing run. No paid models or huge-frame/kill experiments
were used. These historical checks did not cover model reranking; its later acceptance is recorded
separately below. Fixed-source limits remain in force.

## Native child source and result owners

The authenticated `/api/agent-profiles/{read,save,remove}` API edits the original global
`harness.models[role].agent` and `harness.agents` settings without constructing a Pi Session.
`GlobalSettingsAuthority` reuses the original SettingsManager validation and JSON-file lock/revision CAS;
it owns no parallel profile database. A tools edit changes only the selected runtime key, preserving
the other runtime and unrelated settings. Shared model/instruction/work-mode fields remain shared.
Existing arrays keep their exact names; missing builtin keys use shipped defaults, missing custom keys
are unconfigured, and explicit empty arrays mean no tools. Native defaults come from Rust's owning
capability descriptors. Extension/MCP availability still requires the actual frozen Run bindings.
Owner failures expose short safe codes/messages through the client, not raw upstream errors.

`ThreadCollaboration` consumes committed Catalog collaboration facts. Its maps only coalesce live
preparation, launch and receipt reconciliation. It never starts a Pi session or adds a native child to
ThreadRegistry. `child-profiles.ts` compiles the original global harness settings and shared
`observePresets` resolver and freezes the `runtime.child.capabilities` presentation descriptors.
The actual Rust directory validates native and frozen Host capabilities together, including name
collisions; configuration parsing never rejects a valid Host tool using a native-only list. It creates
no profile registry. Missing, disabled, invalid, unsupported and
unavailable selections remain distinct; the entire explicit preset is validated before overrides.
Native Threads do not infer a work focus from a project or shell: a focus-restricted preset is
unavailable while that scope is unknown. No Pi Session is created to read user settings.

New input and explicit model selection prepare the immutable child catalog before original Catalog
admission. Matching input/model keys retain their first prepared catalog. Model configuration and
credential scope use the existing model authority, including temperature zero and original thinking
settings; configuration changes cannot silently enter an inherited override. The child profile's
original instruction section/provenance survives refresh, compaction and source/resource replacement.

Schema-2 dispatch takes task/preset?/workMode?/tools?. Native children can use the selected implemented
file, resource, question, recursive collaboration and managed process capabilities. The read-only
source projection and private text-write projection remain explicit; process capability additionally
requires real configured/delegated authority and existing permission gates. A private cwd is not an
OS sandbox. Ordinary extensions and MCP use the exact original frozen Host declarations. Language
tools use the actual private materialized source and original supervisor/process owners; Worker defaults
include them, while read-only Retrieval defaults remain source-compatible. Explicit read-only language
selection reports the required physical work mode. Goal and remote child bindings remain unavailable until
their complete owner contracts are connected; no unsupported list is silently trimmed. The UI displays
the frozen native descriptors together with actual Launch Host bindings and selected profile facts.

Explicitly selected native memory and todo tools use the original ordinary owners. `currentThread`
notes resolve to the actual child Thread; admitted project/global scopes remain shared under the same
permissions, while parent/sibling private notes do not transfer. Initial child plans are absent and
belong to the actual child Thread/branch/history. Public plan editing and branch capture use the same
KnowledgeStore CAS and original receipt as tools, independently of tool selection. Source `read_only`
is not a prohibition on explicitly selected note/plan mutations. Bot/context-job scope remains separate.

A child uses the ordinary AgentPolicy lifecycle after durable task admission. `preparePolicy` resolves
its actual Thread/project routing scope, then commits the original artifact and generation through the
same launch preparation. It neither copies the parent's private checkpoint nor acquires additional tools.
The built-in loop remains the default until an explicit matching service-routing rule chooses
an extension policy. Installing a single provider does not select it for unrelated tasks or children.
Policy candidates may change at closed decision boundaries while the child ToolDirectory remains static.
Declared planning roles bind credentials and model Operations to that child Run/generation; saved roles
restore their exact original configuration. Planning usage remains attributed to the original delegated
Goal where one exists; no primary Goal or automatic continuation authority is inherited.
On an explicit new child Run, exact planning configuration and credential scope survive, but the
credential binding belongs to that Run's new policy generation. The Host hashes typed optional model
fields with one missing/null representation matching Rust serialization; zero, false and nested
provider-option values remain distinct. Same-Run restore still verifies the complete configuration
identity and generation without consulting newer settings.
Compaction jobs keep their internal fixed strategy. A policy
can pause/deliver/complete through the existing Thread controls and child report/result consumers.
`createAgentPolicy` derives an independent pin from a still-retained exact policy artifact across ordinary
replacement; after final release or explicit revocation it cannot resurrect the old artifact. The same
full described configuration/identity check applies to retained and freshly installed original bindings.

Child extension scopes hold selected original service pins without subscribing to new routing candidates.
The original supervisor supplies artifact identity for live draining owners as well as active owners;
`HostServiceRegistry.bindPinned` can derive an independent child pin from a retained generation. The
child's fresh invocation scope and current permission policy are checked for every call.

`mcp-child-preparation.ts` uses the same original `McpAuthority`. Each selected server retains its own resource owner,
execution scope and configuration directory/trust alongside its frozen definition; the composition
has no shared owner that can relabel a sibling. Current child preparation still requires a single
original owner; mixed Host child composition belongs to the managed MCP continuation. Workspace MCP receives
the child's real materialized cwd; global MCP keeps the neutral environment. One unused-launch CAS
publishes the actual child binding, after which restoration requires it exactly. Direct tools preserve
their original server and disambiguated public name; discovery cannot expand the frozen server set.

The private ToolBridge acknowledges an original-owner child retention before Catalog accepts dispatch.
Its child holders keep only live resources, independently of parent Run completion and channel reset.
After `runtime.run.start` has successfully bound independent child leases, Host releases the handoff.
The collaboration consumer also releases terminal child holders and old-epoch unaccepted handoffs using
real Catalog facts. A current-epoch missing ChildTask can still be between ACK and accept and is not
prematurely reclaimed. Host shutdown releases its holders; exact unavailable artifacts fail on restart.

A child whose frozen invocation has no file source carries explicit `source.kind: absent` and
`code_result.kind: not_applicable`. The original context preparer/`forSource` accepts null while keeping
role, resources and credential/configuration identity. Initial dispatch and User/message/follow-up/calendar
continuations start the same original Run lifecycle without calling file capture, branch, grant or pin
owners. Null unprepared source and failed source-bearing preparation never take this path.

A durable accepted child precedes slow source capture and context preparation. A fixed source reuses
its original pin. A physical source uses the shared Documents capture window, complete inventory and
state verification, and a bounded original Storage handoff grant. Saved-files capture retains saved
files while explicitly recording omitted unsaved overlays. The actual materialized directory is
registered with Documents; a historical workspace ID never substitutes its unrelated original root.
The branch-create transaction retains provenance through the existing blob/record references. Recovery
reads the original fixed source receipt before attempting any current directory or Git observation.

Initial and continued executions use the same `ThreadCollaboration` lifecycle, keyed by exact
`DelegatedExecution.execution_id`. Only initial dispatch retains/releases the original parent ToolBridge
handoff. Explicit User continuation is durably accepted with the previous Run and head before cold
work. Startup discovery includes accepted executions that do not yet have a Run. For a file-source
predecessor, the Host pins its exact WorkingResult or immutable source, verifies its root, and creates a new branch,
retained pin and materialized source under the execution identity. It does not recapture the parent
directory or reclaim its retired handoff. Unused cancelled preparation is cleaned through the same
Storage owner after local preparation has drained.

Context preparation uses `forSource` with the original checkpoint, preserving summary, history anchor,
role and memory. Explicit skills use the existing input-resource preparer: the outer checkpoint CAS
references the old context, while the input binds the candidate context. New source admission, launch,
MCP and extension preparation all look up the exact execution for the actual Run. Original artifact,
configuration and schema identities remain frozen; fresh execution authority and current permission
checks are not inherited live grants. A second MCP round can change its actual cwd without changing
its admitted server definition, and later restore requires that round's committed binding.

The authenticated `child/continue` route accepts only User key, previous Run, expected head and raw
text/images on the actual child branch. It cannot choose a different actor, configuration or source.
The shared composer uses this path when the child is idle, retains the original key after an uncertain
response, and uses ordinary boundary/interrupt input when active. Snapshot and exact execution report
routes expose separate Run/report/file-result identities; old dispatch cards and Waits remain original
facts. Directed requests use this same continuation owner with a `message_request` trigger and original
message provenance. Correlated reply observations use the same original message facts and native Wait owner.

Child Run termination, report production, process lifetime and file settlement are separate facts.
Actual worker/root leases, original file receipts, guardian-confirmed process stop and original
workspace Host callback stop facts determine when a fixed file candidate may be published. A cancelled
MCP request with unknown execution remains pending until its original owner can prove stop; a protocol
cancel response is not that proof. The Host stops before directory capture if child settlement
still reports pending. Original operation receipts wake settlement even when the delegated execution revision does
not change, including a receipt arriving while an earlier attempt drains.
Storage atomically fixes a candidate and base pins, then prepares its result document on a readonly
worker before the short original branch revision/WorkingResult/receipt commit. An existing candidate
can be published after its physical directory disappears. Cancellation cannot invent no-effect, and
an empty/cancelled report does not discard real file changes. Late original evidence can refine effect
without repeating an already-delivered Wait or creating another result revision.

The authenticated child routes verify native Thread ownership. Snapshot/UI distinguish source
preparation, profile, report outcome, file settlement, fixed publication and uncertain effect. Resource
release follows actual evidence; a parent completing does not terminate its independently admitted
child. The original common context preparer still owns role/project and personalization selection.

Trusted Computer control events follow the original desktop outbox through
`runtime.computer.event.accept`: the native request worker stages Environment content off Catalog,
then commits exact actor/root inputs and returns their acceptance receipt. `runtime.computer.event.cancel`
is a short control request for the original Stop command and exact handback IDs; it does not wait on
fact body work. The existing Computer runtime adapter carries original execution identity, while
Catalog derives family and eligible activation. Naturally completed root/child handback uses the same
launch/continuation preparer; no Pi session, synthetic User message or second grant is created.
The shared execution view displays Computer event/input identity rather than labelling it User input.

Child and tree cancellation use the same original Catalog lineage transaction and return short
TreeCancellationReceipt acknowledgements. They include preparing descendants, completed reports with
live processes and original still-active followups, without walking a Host-maintained child registry.
The parent scope is checked with the child target in Catalog. `runtime.operation.status` reads short
original metadata, so missing intent/result bodies cannot block the ordinary cancel preflight.
The event pump cancels local cold preparation from run.cancel_requested and child reports, while
settlement keeps its own lifetime. UI subtree-stop controls remain available after a final report;
neither a cancellation ACK nor a report is displayed as actual process stop.

Parent integration is explicit through the ordinary installed
[child integration tool](../../../../../examples/extensions/child-integration-tool/README.md).
Schema 2 fixes the child operation, exact execution and publication identities, and supplies real parent Run/Thread/source authority.
The existing IntegrationCoordinator, three-way merge, Documents CAS and typed recovery journal own
its effects. The journal records causal binding and actual path/Surface phases. Physical path leases
protect the short reservation even across overlapping workspace roots; unrelated external Surface
waits do not occupy the workspace metadata queue. `files-only` recovery includes file and Document
content, but not Pi conversation-history rollback. Fixed read-only parents have no implicit disk
writeback target.

A trusted domain effect remains attached to the original service invocation through its actual
promise, even if the extension callback returns early. Its original journal determines effect and
executor-stop evidence, not extension-returned JSON. The same Catalog Host Tool receipt path reads
that journal during recovery by original Operation/execution-owner identity, even when the target
directory no longer exists. It never re-executes the tool. A dispatched native Surface promise drains
through its exact original acknowledgement; cancellation is not stop evidence. A lost owner without
that evidence remains unknown and retains unresolved resource protection.
Native Host IPC acceptance is tracked separately in the implementation plan.

The authenticated `child/report` route verifies parent Thread ownership and reads only a history
item referenced by that child's durable report. `collaboration.readReport` returns a bounded UTF-8
page with byte offsets and total size. The UI replaces pages on explicit continuation rather than
assembling an unbounded report in memory. Status/list contain report metadata only; the original
history content owner remains the sole durable body owner.


## Ordered context transforms

The original ContextCheckpoint personalization field retains `ContextComposition.transforms` in
explicit service-routing order. `thread-context` resolves default user, admitted project/Thread and
its existing resource snapshot's configuration root; a source-free Thread has no workspace route.
The Host calls only selected broker declarations, caching unchanged exact providers and propagating
original preparation cancellation. Declaration bodies persist via the existing unlocked content
publication and checkpoint CAS. Rust ContextRead applies the typed ordered handle outside Catalog's
mutex; immutable model requests, children and recovery keep that checkpoint's exact identities.
Provider disable blocks new candidates, without deleting already admitted context or claiming to
retract an in-flight model request. No new configuration, permission, history or Context store exists.


## Replaceable context budgets

`ContextService` reads the original user/trusted-project compaction settings at the named
`before_model_dispatch` boundary. The default adds one short Context-owner rendezvous for current
settings/selection; Rust keeps estimation, waterlines and ancestor selection local. No candidate IDs,
full histories, provider credentials or tools cross to an unselected extension. Unknown capacity and
disabled compaction do not call a budget extension.

`createContextBudget` resolves only an explicit original service-routing selection of
`varin.context.budget@1`; installing its sole provider does not change the native default. Original
routing caches only scope selection facts. Description values are bound to the actual provider
generation and composition; same-instance unrelated routing changes reuse them, while a new worker
redescribes its activation's configuration. These caches do not hold workers alive. Only the separate
actual `decide` query carries detached estimates
and native candidate metadata. Its selected generation is pinned through describe/decide completion;
ordinary replacement lets it finish, while revocation/cancellation rejects late output. A successful
Decision is immutable data, not a continuing extension permission or callback state.

Rust checks the chosen boundary against its actual request, then the original ContextJob owner checks
source ancestry, complete tool pairs, parent/model authority and checkpoint revision. A new external
background Decision is rejected when the original user settings disable background preparation;
it cannot silently switch to blocking or admit a paid summary. The required
`summaryRecipe` follows the original ContentStore admission, tool-free Run, usage and publication path.
An existing job wins over changed routing, keys or boundaries for the same owner/checkpoint/model and
credential identity, including failed/unknown jobs. A dedicated admission conflict reconciles racing
cold preparations to that original receipt; unrelated errors remain failures. Native background work
may become a current blocking Wait at its waterline. An accepted extension's explicit background mode
is preserved. Neither case creates another generation. Manual compaction explicitly stores its own
native/manual recipe and does not select an automatic extension.


## Managed source consumers

`thread-sources.ts` resolves an explicit source Host through Documents once, then prepares by the
frozen resource owner and workspace identity. Local and managed fixed, materialized and live views
share the same mandatory owner contract. `managed-source-consumers.ts` borrows the original Run
binding for ongoing queries; pre-Run Context reads have a separate native `source_read` authority,
which drains and retires after use. They do not create a target Catalog Run or model ToolCall.

`source-query-service.ts` executes the closed read, compute, language and Context-resource services
on the target’s existing Documents, Storage and language owners. Its target grant is explicitly
injected, never reconstructed from a coordinator path. Context snapshots transfer captured text;
target object hashes are not coordinator ContentStore references. `source-query.ts` and retrieval
consumers route reads and path checks through that original owner. A missing target language provider
is unavailable, and never starts a same-path language process on the coordinator. Releasing service
references is separate from the native process/root-stop evidence.

`extension-source.ts` captures package inputs through that same source owner. Fixed views retain
their original pin; physical views compare complete captured inventories before publishing a manifest.
Local and managed staging use this one capture implementation. The target retains object references;
`package_read` pages only captured file paths into the coordinator's derived compiler tree and verifies
lengths and hashes. Target object addresses never become coordinator Storage references. Package
provenance includes the exact resource owner, Run, Operation and source revision/root.

Managed package captures belong to the caller-retained source authority. Cancelling one service
request joins its reader; authority retirement also closes all completed or undelivered captures.
Language release only withdraws language references. Neither action substitutes for the original
package catalog receipt. Compilation and installation continue through `stageCapturedPackage`:
first installation is disabled, and updates remain candidates for the existing capability review.

The source picker keeps the exact owner/workspace/key/content for uncertain preparation retries.
Managed-source file recovery is currently diagnosed before the local Recovery API is called;
conversation-only navigation remains an explicit available choice.

The coordinator's Catalog remains the only Agent execution owner. The target keeps source scopes
and grants in its existing Storage domain records and executes through the existing KernelToolExecutor,
resource worker and process guardian. It never creates a shadow Catalog Run. `source.resource` carries
the original tool origin and operation; `source.service` is a closed set of source reads, captures,
child preparation and Integration operations, not an arbitrary kernel-method tunnel. Original target
receipts answer uncertain outcomes; transport request IDs are not new effect identities.
Managed tool reads retain their original completed receipt in target Storage operations and blobs
so a lost reply does not require reading changed files again. This durability is confined to the
remote execution boundary; local reads keep their existing fast path. Retiring a grant is not a
delivery acknowledgment and must not delete a receipt still needed for reconciliation.

New Run epochs fence dispatch without withdrawing an accepted Thread-lifetime process's original
authority. Observation, cancellation and cleanup retain the authenticated principal, coordinator,
source authority, resource epoch and original operation even after current access is withdrawn.
Host service cancellation joins the actual admitted work. Process stop additionally needs the
guardian's confirmed tree stop; an HTTP response or local callback finishing is not that evidence.
Run retirement preserves caller-retained authorities; explicit revocation still drains the full scope.

Child source preparation claims the target's original handoff or predecessor result. Its branch,
durable pin, candidate and publication stay on the target, including continuation cleanup and result
recovery after the private directory disappears. Integration reads the target's original journal on
uncertain return. Target object hashes never become coordinator content references without transfer.

Managed file follow-ups use the target's original Documents watch and Storage observation receipt.
The coordinator never opens a watcher on its similarly named local path. Release includes pending
watch opens as well as published handles; Bot deletion retains the original address until that release
is acknowledged. Restart resumes the original receipt and exposes a cursor gap rather than inventing
offline changes. Target-side revocation releases its original pin/watch resources. A paused or fixed
successful definition retains its last accepted fact; without a new observation/control request its
remote-revocation diagnosis can be delayed. Listing that snapshot does not certify current B access.

Managed PTY views, Experiment input capture and package staging use their original source owners.
Persistent script environments resolve the target Host's exact installed Node/worker binding and
spawn a pipe evaluator with that Host's transient environment. The coordinator retains the original
ScriptEnvironment/Cell, nested invocation scopes and callback drain; the target owns only its Source
permit, Storage process and guardian. Losing either channel never replays a heap, cell or old output.

Script stop revokes only the original environment's grants before observing its guardian tree receipt.
Original receipts remain readable after revocation/reopen without reacquiring project trust. The
coordinator follows that physical evidence independently of the revoked pipe subscription and combines
it with actual callback completion; missing acceptance or lost callbacks remain Unknown. Run-end stop
attempts are independently dispatched per original environment, so a slow target does not block durable
notifications for unrelated Runs. Current-Host lost-open callbacks, Host-ready recovery and actual source
reconnection reuse original pending Operations; no replacement task or evaluator is created.

Managed MCP composes A's ready global tools with B's independent project contribution. The closed
source service retains exact views, definitions and revocation tokens. A release fences the original
creation request before disposing its view; it cannot race a late preparation into a new owner. SDK
configuration resolves command/environment only on B. Its stdio adapter spawns with the original
Source grant and root, so Storage retains the process identity across Host restart. Cancellation and
source retirement await original scoped preparations and native guardian completion, not SDK close
alone. Cleanup uses the persisted original address even after the grant is inactive. A native error
response joined with its original absent process receipt proves rejection; a lost reply remains
unknown and is never replayed. Storage records explicit no-spawn proof for setup/admission failures,
so those failures do not wait forever for a guardian that never admitted the target. Focused evidence
covers adapter/controlled owner ports and native pre-spawn/reopen receipts, not a full two-Host
SDK/Kernel lifecycle.

The frozen per-server owner includes its original target Source address. Initial MCP preparation uses
an `mcp_owner` purpose inside the existing Source authority so retaining its daemon cannot extend an
ordinary Run shell grant. Admitted Operation holders are immutable reference/fencing records there;
Catalog remains the only Task/observer state owner. Storage seals new admission before Run retirement,
preserves existing holders without changing resource keys or grants, and explicit revocation bypasses
retention. Final holder release still requires the original native stop before grant retirement.
Managed Task creation now enters one immutable receipt on that original holder before `tools/call`.
Receipt bodies use the original Storage immutable-object store and content lane; holder/control
projections keep short hash/length references. Staging, hashing and hydration occur outside Storage,
and the unreleased holder owns the body's GC root. The receiving Host retains the original SDK handle
without a Task scheduler. A's existing Task owner
polls, cancels and retrieves results, and can recover the original acceptance after a lost response.
An inspection joins a still-running original creation; reopening a missing SDK heap never starts a
replacement daemon. A no-dispatch recovery fence closes only holders without a creation receipt.
Status `cancelled`, a lost session and an absent response do not prove an unidentified Task stopped.

The original Catalog HostJob retains a holder-cleanup obligation independently of its result and stop
facts. A awaits exact target release, final source retirement where required, then records cleanup
acknowledgement. Target release fences new control calls and awaits actual SDK control callbacks;
that local drain does not change remote Task effect or stop facts. Shutdown detaches local projections without discarding that obligation. Original
source-reconnect notifications wake paused Task reconciliation. Target Task polling still uses A's
existing scheduler. Managed resource observers use the same original creation-receipt holder: B keeps
its SDK observer and coalesces only unpublished invalidations by kind; A owns durable ACKs, gaps,
listener incarnations and cleanup acknowledgement. Projection disconnect never unsubscribes B.
Recovery starts a new A listener at B's current watch revision after publishing a gap; it does not
claim remote replay or create a replacement SDK heap. Workspace observers still close when their
original Source explicitly retires. Recovered finite subscribe ACKs and proven failed RPC receipts
settle the original execution barrier without replacing already-published Unknown conversation history.
Focused evidence covers actual coordinator/target modules with controlled ports, native receipt fences
and Catalog persistence; it does not assert a full two-Host SDK lifecycle. The current
internal formats are Storage 19, Agent Catalog 70 and private wire 34; older formats are rejected by
the existing read-only gate with data preserved, without automatic migration or cleanup.

Managed MCP finite reverse interactions and mixed-owner child
preparation, explicit managed cold calendar starts and broader combined cross-Host file recovery
still have separate implementation work. Computer assignments, Agent/Bot identity, global settings and model
credentials remain with their original owners; selecting a file Host does not silently redirect them.

## Managed extension package cleanup

`extension-package-owner.ts` retains a confirmed stage result when source release fails. The original
Catalog Operation and actual executor-stopped delivery receipt drive cleanup independently of staging:
the bound Host tool callback schedules only that Operation, startup replays delivered source cleanup,
and `runtime.source.cleanup` is the explicit source-reconnect wake. None recompiles or restages a package.
The private `package_cleanup` request carries the original saved launch. `managed-package-source.ts`
inspects the original remote scope and retires only the matching source-purpose authority with the same
Operation, Run/Thread and complete Source identity. Remote waits and intent hydration occur outside the
Catalog lock; unconfirmed cleanup leaves the original authority available for a later recovery pass.

On the source Host, `extension.package-capture` records the full authority attribution, capture identity
and package path before acquiring its deterministic revision pin. These are Storage resource cleanup
addresses, not another installation result. Live capture readers drain before cleanup. A reopened Host
uses maintenance authority to release only those recorded pins, without reopening the original project
or reconstructing a capture closure. Native retirement then releases temporary object owners belonging
to that exact original source grant. Other consumers' durable pins retain their existing lifetime.

## Original process terminals across managed Sources

`thread-processes.ts` opens a view of the original Catalog process Operation. For a managed Source it
admits a caller-retained `process_view`, validates the original process through `runtime.process.access`
and `source.process.access`, then gives `KernelManagedProcess` the narrow `managed-process-client.ts`
projection port. The B Storage owner still authorizes the original process, source, principal and Run;
view authorities cannot execute unrelated tools or generic service actions.

`managed-source-processes.ts` and `managed-process-stream.ts` carry the original native stream with
separate data/control acknowledgement. HTTP body reads do not release credits. Input/resize preserve
original native operation receipts and are never replayed after unknown delivery. The original job is
cancelled only through its Catalog Operation. Closing a remote subscription retires its exact view;
UI detach may retain the A terminal projection under the existing TerminalRuntime lifetime.

Native `replayCursor` freezes retained output at subscribe time. Thread views suppress automatic input
responses to historical terminal queries while fresh output keeps normal terminal behavior. Process
creation epoch and current subscription epoch remain distinct after B reopens: retained output can be
observed, but Storage still denies old-epoch control. A failed projection is rebound through original
`openTerminal` before UI reattaches; it is never replaced with a new shell job.

Managed-script focused evidence (2026-10-13): the exact installed-binding helper's filesystem/spawn-input
checks pass (3), private bridge/receipt and delayed tree-stop checks pass (18), and the original Storage
source/guardian test passes (1) for revoked late spawn, principal isolation, unrelated-grant preservation
and original receipt recall after Storage reopen. This is controlled in-process/stdio evidence, not
physical dual-Host or installed-product validation. The wider Host type graph remains blocked by absent
dependencies; no full build/test suite was used as evidence.
