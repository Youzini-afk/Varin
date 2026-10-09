# Rust kernel client and storage boundary

The Application Host owns one `KernelClient` for its lifetime. `KernelClient.start()` spawns the
real `varin-kernel` executable, performs the build/protocol/epoch/grant handshake, and keeps the private
length-framed stdin/stdout transport separate from stderr. The kernel reports a compiled build identity and
target; packaged Hosts verify the adjacent manifest, executable SHA-256 and actual PE/ELF/Mach-O architecture before spawning it. Large blob
uploads and branch create/write batches use acknowledged request chunks through the handshake's request-credit window; `AbortSignal` cancellation
stops queued admission or signals the active kernel operation without returning its credit before native acknowledgement. `close()` drains admitted work, sends shutdown when possible, and waits for the
child to exit. A missing executable, protocol mismatch, malformed response, revoked grant, or child exit is
an explicit Host failure; it never selects the old backend as a fallback.

## Responsibility table

| Resource | Current authority | Kernel boundary after Stage R |
| --- | --- | --- |
| Thread/Run product catalog | TS `ThreadRegistry` | remains TS; kernel receives an actor/grant and operation IDs |
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

Materialized `native_file_write` and `native_file_edit` use the existing `file.apply` journal.
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
owns framed transport, handshake, request admission, cancellation, and authorized dispatch. A single
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
stdout/stderr, input sequence receipts and actual exit codes come from Rust. PTY display uses an
incremental UTF-8 decoder. Close follows output drainage; failed native release retains the handle
for retry rather than suppressing its actual exit/close events.

Kernel transport loss invalidates live handles, rejects completion and keeps writer status unknown.
Pending launches participate in shutdown; consumers drain while native grants remain valid.
Startup errors carrying an owned child cannot trigger another interpreter as a fallback.
See [process ownership](../process/DOCUMENTATION.md). Web/Electron use the same production injection.

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

## Selected native policy planning models

The installed `varin.agent.policy` service may declare `capabilities: ['agentPlanning']` in its
pinned description. Only that selected policy triggers planning preparation. The Host reads the
existing authenticated `settings.get` catalog path, validates `harness.models.agentPlanning` using
`parseHarnessModelSlots`, and resolves it with `resolveHarnessModelSlot(..., null)`. The role has an
explicit model picker in Context settings and never inherits the main model. Disabled, unconfigured,
invalid settings, unavailable catalog/auth, and available selections remain distinct.

`native-policy-models.ts` resolves registered IDs through `native-model-authority.ts` and freezes the
configuration identity, purpose, supported operation and nonsecret binding ID. Rust derives the actual
tool-free request binding and retains the selection with the launch. Policies receive only capability
IDs and availability descriptors, never endpoints, provider selectors or credentials. Rebinding
verifies both the selected role and original configuration/account scope; it cannot select a replacement.

The existing private credential bridge keys owners by Run and frozen binding ID. The main owner has
its own empty binding slot; auxiliary registration cannot replace it. Requests retain their exact
scope, kernel epoch and optional endpoint/payload digest for signing. Run cancellation, release and
transport shutdown retire every bound owner. Parked Run resumption re-prepares the pinned policy and
all its owners. Tokens remain transient private replies, never launch or policy data. Production Pi,
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

`native-live-source.ts` is an admission adapter, not a registry. Documents retains the durable
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

Live selections also expose `native_language_definition`, `native_language_references`, and
`native_language_diagnostics`. Native tool contracts, grant admission and history remain in Rust;
`native-language-owner.ts` binds saved text through the existing LanguageViewBinder and selected
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

The experimental native `run_launches` domain is now format 2; catalog/content remain 3/3.
This is an intentional incompatible internal encoding change from the old `materialized` boolean.
Existing format 1, missing or malformed launch metadata is rejected before writable SQLite access,
epoch advancement or recovery. Read-only preflight observes committed WAL pages. Original database,
WAL and content assets are preserved; there is no migration, silent inference or alternate reader.
The persisted `live_root` field is required: fixed/materialized encode explicit null and live mode
encodes the exact descriptor. Missing fields do not silently manufacture a legacy source identity.


Native live-language acceptance is recorded by suite in the
[implementation plan](../../../../../docs/plan/native-agent-runtime-implementation.md#已核验增量live-root-原生语言工具):
Rust rendezvous/framing 5; native controlled-owner 20, source entry 1, real bundled TypeScript loop 1;
portable owner 12 and bridge 3; existing Pi navigation 15 and diagnostics adapter 4; UI 18.
These are focused checks, not an all-repository, fixed-dependency-closure or cross-platform pass.
