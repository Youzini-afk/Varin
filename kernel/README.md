# Private Rust kernel

Each Application Host owns one packaged `varin-kernel` executable. It combines the resource kernel
with the native Agent runtime, using separate domain authorities inside the same private component.
It has no public TCP server and is shared by Web, Electron and remote Hosts.

The workspace also contains [varin-computer-windows](crates/varin-computer-windows/README.md), a
separate lightweight desktop executable. It shares the toolchain/lockfile, not kernel storage or Agent
ownership, and is built and packaged through the Computer driver platform entry.

- [System architecture](../docs/architecture.md): product processes and state ownership
- [Resources and recovery](../docs/resources.md): source selection, files, processes and journals
- [Agent runtime](crates/varin-runtime/README.md): Catalog, execution, context and provider contracts
- [Host adapters](../packages/web/application-host/lib/kernel/DOCUMENTATION.md): actual consumers

## Build and protocol

The toolchain is pinned by [rust-toolchain.toml](rust-toolchain.toml); dependencies are in Cargo.lock.
From the repository root:

```sh
bun run kernel:check
bun run kernel:build
node scripts/generate-kernel-protocol.mjs --check
```

`kernel:build` stages a release executable with Application Host identity and architecture metadata.
A plain Cargo build uses the crate defaults and is not interchangeable with a verified release artifact.
Packaged Hosts check the adjacent manifest, executable hash and actual PE/ELF/Mach-O architecture.
Electron stages it outside `app.asar`; Web/cloud use their package kernel layout.

[protocol/schema.json](protocol/schema.json) is the private wire source. The generator emits Rust and
TypeScript DTOs. Receiving owners reject malformed/unknown shapes and check domain identity rather
than trusting supplied workspace, Run or operation IDs.

## Transport lifetime

The Host provides private local control/content endpoints and a fresh bearer via stdin bootstrap.
Unix uses local sockets; Windows uses overlapped named pipes. Stderr is diagnostic only. Both channels
authenticate the same epoch, and loss of either invalidates it.

Control uses framed JSON. Content uses separately acknowledged stream/sequence chunks, credit and fair
rotation. Frame bounds limit packets, not total content. Body encoding/decoding runs outside the control
reader and domain owner sections. A request is registered before its body arrives, so cancellation can
stop/discard incomplete admission without executing it.

Queued cancellation, observer cancellation and domain completion differ. Returning transport credit
cannot prove an accepted executor stopped. Client/worker shutdown retains original requests, owner locks
and physical resources until their actual work drains. A lost response remains an explicit failure or
unknown outcome, never permission to start a fallback writer.

On Windows/Linux, `--watch-directories` is a separate helper mode of the same executable. It owns only
OS notification handles and private metadata pipes, not Catalog, Storage or tool execution. Its coverage
and reuse limits are in [Documents observation](../packages/web/application-host/lib/documents/DOCUMENTATION.md#filesystem-observation).

## Storage and file authority

Storage has one OS-held `kernel.lock` and its own `catalog.sqlite`, separate from the Agent Catalog.
[core.rs](crates/varin-kernel/src/storage/core.rs) accepts only the current Storage format (22), SQLite
`user_version` (16) and schema fingerprint; it has no older-generation conversion chain. The format
probe precedes opening the writer, and structural validation precedes staging/ephemeral-pin cleanup.
Unsupported/future/malformed/corrupt stores are errors and their assets are preserved. Agent Catalog
upgrades do not upgrade this domain. Workspace files, Git, native Pi data and external configuration
are separate assets; no second TS writer or import fallback is selected.

Native grants bind current Thread/Run authority. The four retired session identity fields remain
null in new serialized grant records for historical decoding; non-null values cannot authorize access
or grant reissue. Legacy session-owned records and candidate owners fail closed for overwrite,
release, preparation replay and publication, including cached receipts. There is no user-asset rewrite.

Storage owns immutable tree roots, revisions, SHA-256 objects, pins, references, typed domain records,
Recovery/Integration phases and idempotent original-operation receipts. Bytes are verified/flushed before
references publish. Logical release and physical cleanup have distinct results; failed deletion remains
retryable and cannot be reported as successful zero-byte cleanup.

Branch imports build unpublished immutable candidates in finite upload transactions. Active builders
retain their base/candidate roots through GC; abort or original-grant revocation releases that retention.
Final publication checks content ownership again before publishing the branch and original receipt.
Namespace batches share both path and child-index ancestor rebuilds and leave untouched subtrees intact.
Sorted child patches are applied together with height-aware AVL joins, rather than retaining an
intermediate index spine for every inserted child. Existing roots and publication receipts are unchanged.
Temporary content owners
can be released in transport-sized batches under their original workspace/grant, without one queued
request per object; a failed cleanup keeps the Host ownership hints available for retry.

`branch.path.inspect/apply` observe and conditionally update paths in that same tree. Disjoint files
can commit without a whole-head revision fence; destructive directory changes require their subtree
identity or a whole-head fence. `branch.rename` atomically grafts an unchanged subtree by identity.
Implicit ancestors are directories, including when a baseline did not store explicit directory metadata.
`branch.fork` selects a current root or exact retained pin in the original transaction; replay does not
reselect a later parent head. All paths, source workspace and pin ownership are checked before replay.
Exact branch/pin blob reads use the actual path state as proof, rather than derived intermediate-root
indexes that GC may release. These are namespace primitives, not mounted filesystem or open-handle APIs.

`workspace_files.rs` provides the native private-byte generation primitive: immutable base objects,
an append-only private log and a structurally shared ordered range map. Snapshotting retains ranges;
later writes/truncation cannot modify an older view. Reads select only the required base gaps and
overwritten ranges. A file worker seals a changed file, retaining its exact hash before installation;
publication reuses path CAS and the original operation transaction. Successful idle publication can
release obsolete ranges while older readers retain their backing; the publication finisher performs
backing cleanup on the file worker after the Storage transaction returns. Revocation closes original handles,
and failed temporary-file cleanup remains visible/retryable through Storage cleanup status.
Durable success follows publication, while an unsealed generation is process-local state.

`workspace_session.rs` supplies an in-process native filesystem session over that same Storage owner.
Metadata uses a synchronous typed control port; range reads/writes use the admitted byte handles directly.
Lookup/stat keeps metadata only. Actual opens retain byte descriptors; clean descriptors end with their
native readers, while unsaved data retains its backing until publication. Directory walks do not open
every file or retain an unbounded set of clean content descriptors. Storage selects/retains a base object
without opening it; the actual native callback opens its read-only descriptor outside the control owner.
One branch/owner reuses one session and one set of open identities. Rename retains handles; unlink and
recreate are different identities. Checkpoints retain the namespace and only dirty range maps, then seal
individual files on a worker while the parent continues writing. The resulting child root includes those
dirty bytes in its actual baseline. Normal session closure preserves previously retained checkpoints;
grant revocation invalidates original access. Generic branch mutations cannot bypass a live session.

`workspace_metadata.rs` stores persistent inode identity, permission bits, owners, nanosecond timestamps,
xattrs and Windows security descriptors in an ordinary private immutable-tree branch. Its typed values
are encoded in private directory leaves, not separate filesystem objects or project files. The existing
branch/pin GC graph retains them without a format migration. Namespace bindings preserve lazy descendant
identities across a directory rename. Creation, chmod and body publication save attributes in the same
original SQLite transaction. Checkpoints pin both **current** roots, including native namespace changes
since the last published revision, and fork dirty attributes with the selected bytes. Deleting the data
branch releases its paired metadata branch; existing pins retain the selected versions. Native metadata
branch identities (`workspace-metadata:<UUID>`) and control records cannot be overwritten/released through
generic public branch/record methods. Stable adoption and file captures preserve recoverable native
attributes; cross-Host entries import those values with fresh local file identities. Normal pins and
published revisions retain their paired attribute roots independently of a WorkingResult's lifetime.
Releasing a historical WorkingResult also releases its own revision and paired revision metadata;
other explicitly retained pins continue to own their selected bytes and attributes. Root directory
metadata uses `.` in result/import contracts and accepts only conditional directory attribute updates.
Namespace replacement assigns a fresh local identity; explicit rebases select the filesystem sidecar
from their original pin/revision instead of borrowing attributes from an equal body hash.

The default `workspace-mount` feature contains WinFsp and Linux/macOS FUSE adapters.
It never installs OS components. New isolated writers use native workspace branches; project settings
can explicitly adopt a primary workspace into a separate mounted directory. WinFsp is delay-loaded;
the original installed DLL is located through its system registration only when starting a mount. Building
this feature on Windows also requires libclang for the bundled SDK bindings. Linux requires a working
FUSE character device and a permitted direct-mount/helper route for actual mounts. Linux negotiates
writeback cache only when the connection offers and accepts FUSE_HAS_SYNCFS, then captures the
checkpoint after its waiting syncfs call completes. An opcode version alone does not enable this
capability on ordinary FUSE mounts. Other connections retain the scoped active-writer obstacle.
Unmount helper errors
retain the mount; detach does not silently become lazy/forced.
macOS first uses the bundled path-resource FSKit executor when macOS 26+ reports the exact staged
extension enabled; otherwise it admits the installed macFUSE VFS backend. Extension state inspection
never opens settings or installs/enables components. The explicit project settings action opens the
Host's bundled control app and system settings. See [native executor](../packages/workspace-driver/macos/README.md).
macFUSE uses runtime loading of the installed libfuse3 session API, avoiding the compat25 break tracked at
https://github.com/cberner/fuser/issues/752. An explicit `fuser/libfuse2` build retains the legacy path;
the default macOS loader never selects compat25 because an SDK happens to contain `fuse.pc`.
The libfuse3 owner retains the session while native callbacks use a duplicated fd and destroys it on
setup failure or after detach. Native OS qualification of this selection is still pending.
`wait_ready` checks the actual mount device/root inode after the dispatcher
starts, while keeping the mount object available for cancellation and cleanup; this covers the asynchronous
readiness distinction at https://github.com/cberner/fuser/issues/736.
`kernel/vendor/fuser/VARIN_PATCHES.md` records the loader, capability and retryable-detach patch. macOS CI
compiles the native Swift extension and Rust transport without enabling an extension. The product
stages/signs the bundle next to the kernel; distribution signing preserves FSKit's dedicated entitlements.
Dependency absence is reported at
mount admission and does not prevent the ordinary application from starting.

The ignored `workspace_mount::review::native_workspace_mounts_share_storage_and_keep_fork_independent`
test starts a separate ordinary process and two real mount paths. Invoke it explicitly with
`cargo test -p varin-kernel --lib --features workspace-mount native_workspace_mounts_share_storage_and_keep_fork_independent -- --ignored --nocapture`
on a machine with that component already enabled. In addition to ordinary process I/O, Unix backends
advertising a post-writeback boundary retain a dirty shared mmap across checkpoint/fork and modify it
again on the parent. No msync/descriptor release substitutes for the native boundary. This opt-in OS
test remains separate from the default Storage/executor suite and is not run by component-free CI.

FUSE callbacks persist chmod/chown/times/xattrs. WinFsp callbacks persist basic attributes and merge
the requested Windows security information with the original descriptor, preserving unrelated parts.
These callbacks do not yet qualify complete ACL enforcement. Positioned resource-fork I/O returns
an explicit unsupported error instead of silently ignoring an offset.
Hard-link names share a live inode and durable metadata within a workspace; forks retain independent
byte generations. Directory moves update stable parent identities instead of rewriting every link.
The FUSE adapter implements link. WinFsp's native protocol has no hard-link operation, and its runtime
capability reports that limitation. Writable native references (including possible mappings) prevent
an unfenceable snapshot within the selected scope; cached I/O and mmap remain enabled.
`workspace.fork` accepts `sourcePath`. It selects a persistent subtree without enumerating its files,
seals only its dirty content, preserves directory origins and filters external hard-link names.
Native writable references are checked against actual inode names under the same namespace lock as
the checkpoint, so unrelated writers do not block it and an outside alias cannot evade the fence.

`workspace_resources.rs` connects these sessions to real Kernel requests and the Host scoped client.
The project filesystem owner and Run/Operation leases have separate lifetimes. Native callbacks return
metadata commands to the one Storage owner; mount startup, sealing, detach and executor shutdown wait
on workers while that owner continues serving callbacks. Inspect stays available during mount/detach.
Shutdown seals native open/create admission and retains the dispatcher until actual file/directory
references close. Its original response remains pending during this drainage. Close/executor events
trigger retries and a wake arriving before the cleanup continuation is retained, without polling.
`workspace.result.prepare` captures only dirty native ranges into the existing WorkingResult pipeline.
Publication appends its selected immutable revision while preserving subsequent writes to the live head.
Its worker compares persistent trees and skips equal path/index subtrees instead of listing both entire
namespaces. Equal content hashes also avoid redundant reads for text line statistics.
Filesystem metadata has independent candidate/result retention; releasing a result or its branch releases
the corresponding metadata record and pins for both the selected attributes and their baseline. Empty
native objects reuse their known content identity without writing/fsyncing an empty staging per inode.
Temporary checkpoint pins recover with the existing ephemeral
pin cleanup. Snapshot pins explicitly identify an immutable root without claiming a published revision.

`workspace.adopt` stabilizes an admitted physical source once on a worker and atomically publishes
its namespace and native metadata. Hardlinks, timestamps, Unix xattrs and Windows descriptors survive
the import. Git common/private administration and local object alternates become a standalone private
`.git`; external administration needs its original admitted root. The original operation reports actual
phase/entry/byte progress. Failed/cancelled candidates and interrupted imports are reclaimed without
changing the original directory. Internal native syscalls do not accumulate a receipt per operation;
lookup-cache eviction follows actual native references while preserving inode numbers and dirty data.

Windows source symlinks and junctions retain their original REPARSE_DATA_BUFFER. WinFsp resolves,
reads, creates, sets and deletes these standard points through the same inode/metadata transaction,
including directory enumeration. Converting a nonempty file/directory or a multiple-name inode is
explicitly rejected because the current shared representation cannot retain hidden backing data.
Unknown reparse tags still require a corresponding shared representation.

Current consumer binding is implemented: the Host [native workspace owner](../packages/web/application-host/lib/kernel/native-workspaces.ts)
opens logical branch identities into an epoch-specific mount generation; Documents and
[external Harness sources](../packages/web/application-host/lib/external-agents/source.ts) acquire that
view rather than persisting its path as authority. [native_sources.rs](crates/varin-kernel/src/storage/native_sources.rs)
admits the corresponding root, and file/process workers keep physical I/O outside the Storage actor
so mount callbacks can reach the same owner. Reopening rebuilds the mount from durable branch state;
it does not preserve old OS handles or prove unpublished process-local writes survived a crash.

Remaining representation limits include lossless native names and opaque reparse backing data.
Writable mappings require the selected backend's actual cache fence; unsupported connections retain
the scoped active-writer obstacle rather than silently promising a snapshot. FSKit selection, mounted
I/O, restart and cleanup still need their stated real-platform acceptance; implementation is not qualification.

Root admission queries an index of pending file operations; protocol traffic is not scanned as
file recovery work. Query indexes are rebuildable and leave the record format unchanged. Ordinary
`storage.health` returns statistics with `integrity: not_checked`; only `deep: true` runs integrity checks.

Host Documents admits a canonical root; scoped Rust file resources own exact/subtree leases, capture,
conditional apply, mkdir/remove/rename, scan/measure/materialize and restart reconciliation. Waiting
plans acquire their whole resource set, not partial leases. Read/read overlaps and disjoint work can
proceed. Original grant/root identity is rechecked at effect/completion boundaries.

Finite file workers perform hashing, cold blob verification, range reading, inventory and materialization
outside Storage's short authority sections. Transient exact-hash references and physical leases remain
until real worker exit. Cancellation/revocation closes access without deleting a reader's in-flight bytes.
These references are retention, not a new authorization grant.

Materialization uses verified staging/backup/promotion and factual restart observations. Linux/macOS can
try clone backends with byte-copy fallback; Windows currently reports copy and unknown allocation.
Interrupted paths are not destructively cleaned up when their identity cannot be proved. Git stays a
semantic inventory/filter/worktree adapter and never becomes a parallel body writer.

## Process authority

`process/` and `storage/process_resources.rs` own admitted pipes/PTYs, raw channel output, sequence-bound
input, resize, kill, release and durable process outcomes. A guardian is the same executable in another
mode and has no SQLite connection. Windows uses named kill-on-close Jobs; Linux uses managed sessions
with subreaper tracking; other Unix platforms retain their supported session observation.

Input and resize have independent ordered queues. Output applies bounded backpressure and termination
does not wait for the observer to consume all bytes. Releasing output retains an identity tombstone.
Active or unknown processes continue protecting their physical execution directory.

Grant retirement closes the old caller while retaining valid stopped-process provenance. Explicit
revocation remains denied; operation-owned grants can outlive their creating Run until actual resource
and receipt drain. Unproven old-epoch exits remain unknown, including after a Host transport failure.
This is lifecycle management, not a hostile-code sandbox or a physical power-loss guarantee.

## Compute and runtime

Native compute reads one admitted source class: immutable pin, live root or fixed objects. It provides
inventory, bytes, search and tree-sitter structure/chunks through bounded cursors with backpressure.
Cancellation reaches traversal/parser work and reader references release only on actual completion.
Live hits carry the observed revision; a scan fingerprint identifies sorted paths, not atomic file bytes.

The Host retains request policy, tokenizer-aware packing, LSP protocol, embeddings, vector/knowledge
stores and product coordination. The separate `varin-runtime` crate implements the Agent Catalog/engine and provider contracts.
Compute and conversation execution retain distinct domain owners inside the packaged kernel; a
compute job does not become a model runtime.

## Verification entry points

`bun run test:rust` runs the default Rust workspace suites under the pinned toolchain; `#[ignore]`
cases do not execute. Host/guardian consumers need built dependencies and a matching absolute
`VARIN_TEST_KERNEL_EXECUTABLE`. `bun run test:kernel` runs Node/Vitest native authority consumers
against a staged release binary, not ignored Rust cases; add `--build` to build that binary first.

To run an ignored case, first verify its current Host fixture and prerequisites, then use
`cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib FILTER --locked -- --ignored`.
A missing retired fixture is an unverified boundary, not permission to restore an obsolete runtime
or claim coverage from the default Cargo pass.

Choose focused cases for the changed owner. Native components, controlled providers, Host IPC,
real OS processes, installed products and physical remote machines establish different facts.
A pass in one category is not evidence that the others ran. See [development](../docs/development.md)
for commands and CI selection.

## File text representation

`text.rs` is the shared strict file codec for native tools, Compute and Host Documents. The
`text.decode` and `text.serialize` RPCs are pure body-worker operations over the existing chunked
content transport, not a second file writer or a single-frame whole-file limit. UTF-8 decoding can
borrow the original text. `text/codecs.rs` owns the shared catalog, alias resolution and explicit
profiles: Unicode, GB18030/GBK, Big5, Japanese/Korean, Windows code pages, ISO-8859, KOI8 and Macintosh.
`text.encodings` exposes actual read/write/BOM capabilities to Documents and every editor, including
remote file owners. No Host/renderer encoding whitelist duplicates it. `gb2312` retains its browser
GBK alias; `gb2312-strict` uses the complete attributed GB2312-80 mapping with its real repertoire.
UTF-16LE/BE use real UTF-16 writers. All encoders reject unmappable characters without replacement.

Detection is separate from codec support: explicit choice, BOM and recognized header declarations
precede normal strict UTF-8; a valid project default then precedes the statistical `chardetng` guess.
ASCII retains a compatible project default. A detector guess is validated against the complete stream,
not accepted because a sample decodes. Very short ambiguous content can still need an explicit
reinterpretation; detection never claims to prove the intended target character repertoire.

A text read version binds both the raw CAS version and its resolved codec. Normal saves retain the
original codec, BOM and line endings. Exact editor edits preserve unchanged raw segments, including
non-bijective GBK bytes and mixed line endings. Full replacement uses a bounded multi-hunk diff only
when the reversible uniform-format fast path is insufficient. A diff deadline may coarsen replacement
semantics, never truncate or silently substitute text. Recovery before-images are original bytes.

Physical reads combine the existing full raw-hash pass with bounded codec validation. UTF-8 range
alignment seeks within three bytes; other pages walk a continuous decoder from a known boundary
using bounded buffers. GB18030 four-byte sequences, multi-scalar Big5 emissions and ISO-2022-JP state
are not approximated with a GBK/UTF-16 byte-width table. Exact edits expand only touched multi-scalar
units; modified stateful files use continuous strict serialization while preserving original EOLs.
Unchanged stateful files retain the original bytes. A late or repeated legacy page is therefore still O(offset), without a whole-file text buffer
or a claimed sparse index. Raw line requests must resolve line boundaries and cannot silently become
an unbounded whole-file response when decoding fails.

Committed format evidence lives in original file operation receipts and a small current source/path
fact in the existing Storage metadata, updated together. These facts retain no file bodies and survive
receipt release without resurrecting older same-byte choices. A disposable scoped projection allows
subsequent reads in the same grant/Run/root to honor a successful conversion only while its raw hash
matches. The projection distinguishes retained operation evidence from the current path fact: replacing
a fact reclaims its already-released predecessor, and release updates only the affected root, branch,
operation and recovery histories. It neither rebuilds the whole index nor invalidates immutable
snapshots already admitted by readers. Source cleanup removes the remaining current facts and their
unretained projections using canonical Storage paths, even after the physical view is gone.
WorkingResult publication freezes the candidate's matching base/child formats and its exact
branch/revision/root projection; new Runs read that small projection under existing branch authority,
not an older Run's private result body. Recovery projects matching before/after formats without changing
raw-state equality. `file.text.conversions`
provides bounded, source-scoped metadata for Host preference reconciliation, which separately checks
current raw hash and the original user-choice revision. No document database or codec-global hash map
is introduced.

## Fixed file attachments

`storage/object_views.rs` owns one-file read-only execution views. Worker I/O does not hold the
Storage actor, and files are copied rather than hard-linked to immutable object storage. Each view
retains the exact source record, current generation and actual Run or external consumer; release
waits for real process exit and preserves unexpected or modified files.

`file.capture` may atomically retain its exact receipt with `retentionRecordId`. Native file-write
receipts publish typed attachment references in the original effect transaction. `file_read` accepts
an authorized reference even without a physical Source, while path reads keep their original grant
checks. `resource_read` exposes content and execution-path views through the frozen resource owner.
