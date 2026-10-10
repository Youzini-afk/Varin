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
activation but still reject unsupported wait/deadline fields before acceptance. Read responses use the ordinary data path.

`ThreadsAPI.messages` and the shared `ThreadMessages` panel separate immutable acceptance from actual
history delivery and request activation. Received/sent lists contain metadata; opening a message reads its original body.
Reply preserves the received message ID and lets the original owner resolve the target. An unknown
send response retains the same body, target and key for retry, including across panel collapse; an
HTTP 400 alone is not evidence of non-acceptance when it reports a lost kernel response. The user can
explicitly leave an uncertain draft without withdrawing an accepted message. Host/identity changes
clear local drafts/views and late replies cannot repopulate them. Passive messages do not imply a
request, a reply Wait, a continuing Goal, or a new child Run.

Request admission belongs to Catalog, including active-Run binding and idle-root/child continuation.
The same durable event/startup pump consumes `message.run_ready` through `continueLaunch`; accepted
child requests appear in the original delegated-execution discovery. There is no Host request queue or
separate activation RPC. A new child request uses the exact fixed predecessor source and context path,
while only explicit UserContinuation parses User skill commands. The message panel exposes the chosen
inform/request kind, holds, exact Run/execution linkage and failed/cancelled activation separately from
delivery. Uncertain retries keep the kind as well as body/peer/key. Tree stop remains available even
when a Thread has no active Run or displayed children, so pre-Run requests can be fenced.

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

## Explicit one-time process follow-ups

The authenticated `/api/threads/followup/register`, `/list` and `/control` POST routes are exposed as
`ThreadsAPI.followups`. Registration supplies the selected Thread/branch and exact source Run/Operation;
the Host verifies Run ownership and the Catalog validates the accepted process in its transaction.
The Host does not hydrate the Operation body for this control check. Listing and Thread snapshots
project only the selected branch; definition controls carry the displayed revision.

The Catalog owns the one-shot authorization, next-Run Wait and occurrence. Its independent Kernel
worker consumes real stop evidence and atomically admits the new Run even when the Host is offline.
The Host only discovers `followup.admitted` through its existing durable cursor, or finds the original
pending launch at startup, then calls the shared `continueLaunch` entry. Frozen source/model/credential/
tool/policy selections are rebound through their current authorities. A generic `run.accepted` event is
not a new automatic launch instruction, and no follow-up control consumes an independent policy Pause.

The Thread UI offers registration only for an accepted process, retains a registration key across an
uncertain response, displays held/paused state and removes consumed/cancelled controls from active cards.
Past occurrences retain their actual continuation Run identity. Cancelling an unconsumed definition
does not cancel its process; after consumption the new Run is cancelled separately. Cancelling the
source Run cancels its pending follow-up authorization. This native control path does not write the
older Pi follow-up/calendar ledger or create an implicit Goal.

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

`tool-bridge.ts` and Rust `host_tools.rs` carry real ModelStep or PolicyAction origins. The existing
permission owner checks the exact operation, arguments, schema and selected owner. Host-only invocation
scope is derived from that admitted operation and its immutable Run source. Only the opaque scope ID
crosses the broker boundary; the original owner/generation and active callback determine capability
access. `material-tool-owner.ts` exposes `materials.snapshot` through the existing WebMaterialStore,
snapshot grants, persisted collections and native byte-range reader. The runnable authoring example is
[`material-snapshot-tool`](../../../../../examples/extensions/material-snapshot-tool/README.md).

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

The installed `varin.agent.policy@3` service declares `modelRoles: ['agentPlanning']` in its
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

Live selections also expose `language_definition`, `language_references`, and
`language_diagnostics`. Native tool contracts, grant admission and history remain in Rust;
`language-owner.ts` binds saved text through the existing LanguageViewBinder and selected
LanguageSupervisor. The private epoch-bound language bridge does not own another process, provider
registry or configuration store. It starts no language service during source preparation. Shared
startup and per-query cancellation remain with the existing supervisor; no file lease or Catalog
transaction spans a language wait.

Navigation positions are zero-based UTF-16. The query records its actual bound document revision,
view, provider and generation, and explicitly reports live dependency semantics. Both Host and Rust
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

Host replies are serialized and checked against the existing frame budget before touching the shared
kernel writer. Oversized/nonserializable language replies become a small unavailable receipt. Language
result chunking is not implemented. Oversized transient Rust progress is omitted before the shared
writer; durable tool content remains available through existing chunked history reads. Transport loss
still retires the actual private channel.

Fixed-branch and materialized language selection is explicitly unavailable. Materialized files do not
pin external symlinks, project configuration outside the copy, or compiler libraries; a workspace cwd
and didOpen overlay do not establish a fixed dependency closure.

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
model configuration. Cold or
missing publications do not start indexing or wait for first publication. Semantic selection never
chooses another model, silently selects local embeddings, or performs a paid preparation probe.
The existing embedding settings configure the explicit remote backend; model reranking remains disabled.

Semantic candidates contain index identities, not authoritative source bodies. The owner checks the
original Run grant before query embedding, before and after authorized Documents reads, and before
final delivery. Both the candidate's indexed file revision and the chunk's SHA-256 content hash/range
must match the current admitted snapshot. Stale indexed spans are omitted, never relabeled. Async
lease validation fences explicit backend disable, credential/account changes and owner/epoch loss;
normal replacement retains the originally pinned backend/reader. Inference receipts retain actual
dispatch attempts, known/unknown attempt counts, input item/byte counts, provider-measured or unknown
usage, indeterminate outcomes and an explicit reuse flag for ledger/cache replay. Cancellation promptly detaches the
query rendezvous even if an owner ignores its signal. The semantic store's durable inference ledger
retains actual dispatch facts independently; a late owner settlement cannot revive source delivery.
Rust rechecks the Run and suppresses source on cancellation/revocation, retaining safe inference
receipts when its response was already received. No file lease spans those waits.

Results record per-stage availability and omissions. Cold/missing/unsupported/failed stages do not
become successful empty recall. Large structure units retain the slicer's real kept ranges: native
snippets are contiguous spans, with hit-bearing ranges delivered before signatures under a caller's
snippet cap. Omitted unit bodies are not filled back in. The existing Explore byte budget bounds the
Host pack; framing/reconstructed-body budgets fail or report partial without killing the shared writer.
Each snippet has path, inclusive one-based line bounds and actual Documents revision for a later
`file_read`. Its `readVersion` is a separate authority-bound mutation CAS token, not the
Documents content revision; verify a follow-up full read against the snippet's content digest/bytes.
Live observations do not claim an atomic workspace snapshot.

This increment does not connect production model reranking, fixed/materialized retrieval, a complete
fixed LSP dependency closure or remote retrieval. The default Pi route is unchanged; native recall
uses its own explicit backend/published-reader acquisition through the existing semantic owner rather
than the Pi wrapper that resolves a mutable backend at search time. Query bindings retain actual owner
references, not a frozen wrapper around whichever backend/index happens to be current later.

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
were used. The model reranking and fixed-source limits above remain in force; semantic lease acceptance is recorded separately.

## Native child source and result owners

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
OS sandbox. Ordinary extensions and MCP use the exact original frozen Host declarations. LSP,
Goal, Computer and remote child bindings remain unavailable until
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

`mcp-child-preparation.ts` uses the same original `McpAuthority`. Required provenance includes explicit
execution scope, configuration directory/trust and selected server definitions. Workspace MCP receives
the child's real materialized cwd; global MCP keeps the neutral environment. One unused-launch CAS
publishes the actual child binding, after which restoration requires it exactly. Direct tools preserve
their original server and disambiguated public name; discovery cannot expand the frozen server set.

The private ToolBridge acknowledges an original-owner child retention before Catalog accepts dispatch.
Its child holders keep only live resources, independently of parent Run completion and channel reset.
After `runtime.run.start` has successfully bound independent child leases, Host releases the handoff.
The collaboration consumer also releases terminal child holders and old-epoch unaccepted handoffs using
real Catalog facts. A current-epoch missing ChildTask can still be between ACK and accept and is not
prematurely reclaimed. Host shutdown releases its holders; exact unavailable artifacts fail on restart.

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
work. Startup discovery includes accepted executions that do not yet have a Run. The Host pins the
predecessor's exact WorkingResult or immutable source, verifies its root, and creates a new branch,
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
message provenance; correlated reply Wait/deadline remains separate unfinished work.

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
