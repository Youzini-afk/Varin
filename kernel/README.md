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

Control uses framed JSON independently of data backpressure. The data connection has typed frames:
small messages encode and decode inline, without a worker or per-message handshake. Larger bodies use
worker encoding/hydration and acknowledged stream chunks. A single writer alternates ready chunks with
inline frames; packet bounds never limit total content. Thresholds and admission budgets are defined in
[the protocol schema](protocol/schema.json), not product-level content limits.

In-flight requests and large-body stream credits are independent. Stream credit includes hydration and
returns only when the stream actually settles. Host requests, control-response requests and reverse
bridge replies have independent body admission, so a nested Host↔Rust call cannot consume the credit
needed to finish its parent. Rust codec workers follow available CPU parallelism rather than the
request window. Progress batches enter a bounded FIFO with socket backpressure, not a remote round trip;
the existing producer still coalesces deltas while its consumer is blocked.

A monotonic arrival sequence orders inline requests and stream offers across the two sockets, before
body work. The receiver registers cancellation and input ordering immediately at that arrival. A control
cancel that overtakes an inline frame waits only for that arrival, with no unbounded retired-ID cache.
Stream offers reserve input ordering before encoding or waiting for a body credit; only those streams
need the pre-body cancellation handshake.

Queued cancellation, observer cancellation and domain completion differ. Returning transport credit
cannot prove an accepted executor stopped. Client/worker shutdown retains original requests, owner locks
and physical resources until their actual work drains. A lost response remains an explicit failure or
unknown outcome, never permission to start a fallback writer.

On Windows/Linux, `--watch-directories` is a separate helper mode of the same executable. It owns only
OS notification handles and private metadata pipes, not Catalog, Storage or tool execution. Its coverage
and reuse limits are in [Documents observation](../packages/web/application-host/lib/documents/DOCUMENTATION.md#filesystem-observation).

## Storage and file authority

Storage has one OS-held `kernel.lock` and its own `catalog.sqlite`, separate from the Agent Catalog.
[core.rs](crates/varin-kernel/src/storage/core.rs) defines and accepts the current Storage format, SQLite
`user_version` and schema fingerprint; it has no older-generation conversion chain. The format
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

Native filesystem implementation is split by owner; product behavior and current support are in
[resources](../docs/resources.md#不可变工作状态与物理目录), rather than a second feature list here.

| Entry | Responsibility and non-obvious boundary |
| --- | --- |
| [workspace_files.rs](crates/varin-kernel/src/storage/workspace_files.rs) | Immutable bases, private append-only ranges and retained generations. Sealing and backing cleanup run on workers; durable success follows publication, not a process-local write. |
| [workspace_session.rs](crates/varin-kernel/src/storage/workspace_session.rs) | One session per branch/owner; synchronous metadata commands and admitted byte handles. Directory lookup does not open every body. Rename keeps identity; unlink/recreate does not. |
| [workspace_metadata.rs](crates/varin-kernel/src/storage/workspace_metadata.rs) | Original attributes, stable inode identity and paired immutable metadata roots. Equal body hashes do not justify borrowing another revision's attributes. |
| [workspace_resources.rs](crates/varin-kernel/src/workspace_resources.rs) | Mount generations, leases, checkpoint/result publication and drain. Project filesystem ownership and Run/Operation leases have different lifetimes. |
| [workspace_adoption.rs](crates/varin-kernel/src/workspace_adoption.rs) | One stabilized physical-source import, native attributes and private Git administration. Failure reclaims the unpublished candidate without changing the original directory. |
| [workspace backend](crates/varin-kernel/src/workspace_backend.rs), [mount adapters](crates/varin-kernel/src/workspace_mount) | Explicit capability inspection and actual OS callbacks; compiled support is not installed/authorized platform capability. |

Checkpoints retain the current namespace, attributes and dirty ranges before workers seal files; parent
writes continue into a separate generation. Generic branch mutations cannot bypass a live session.
Metadata uses the existing private-tree/GC graph, not user files or another database. Deleting a branch
releases its paired metadata while retained pins/revisions continue owning their selected values.
Privileged metadata branches/control records are not public mutation targets. Source/root, pin and
operation identity remain authoritative through replay, revocation and publication.

Mount startup, sealing, detach and executor shutdown wait on workers so the Storage owner can serve
callbacks. Closing seals new open/create admission but retains the dispatcher until actual references
close. Close events drive cleanup retries; an unfinished drain never becomes a successful detach.
Result preparation compares persistent subtrees and seals changed ranges, not an entire recapture.
Publication appends the selected immutable revision without overwriting subsequent live writes.

The default mount feature includes WinFsp and Linux/macOS FUSE, but never installs system components.
Windows delay-loads the registered WinFsp DLL at mount admission and needs libclang to build bindings.
Linux requires the actual FUSE device and permitted mount route. Writeback-cache checkpoints require
negotiated FUSE_HAS_SYNCFS and completion of the original syncfs; an opcode version alone is not proof.
Other backends keep their scoped active-writer obstacle while ordinary cached I/O and mmap stay enabled.
Subtree fork checks real inode aliases under the namespace lock, so an unrelated writer does not block
it and an outside hard-link alias cannot evade the selected fence.

macOS selects the staged, enabled [FSKit executor](../packages/workspace-driver/macos/README.md) when
supported, otherwise installed macFUSE. Inspection does not enable extensions or open settings;
only the explicit user action does. macFUSE uses the installed libfuse3 session API, not accidental
compat25 selection. Native callbacks retain the original session/fd until setup failure or actual detach.
See [fuser patches](vendor/fuser/VARIN_PATCHES.md) for loading, capability and retryable-detach details.
The bundled extension is staged/signed with its own entitlements; CI compilation does not enable it.
Missing components fail mount admission, not ordinary application startup.

Mount callbacks preserve native metadata, but that does not qualify complete ACL enforcement.
Positioned resource-fork I/O remains explicitly unsupported. FUSE supports hard links; WinFsp's protocol
does not. Windows symlinks/junctions keep their actual reparse data; unsupported tags or conversion of
nonempty/multiple-name inodes fail rather than discard hidden data. Remaining native-name, mapping and
reparse representation limits are reported honestly. Restore/reopen cannot preserve old OS handles
or unpublished process-local writes.

The ignored `native_workspace_mounts_share_storage_and_keep_fork_independent` test in
[workspace_mount](crates/varin-kernel/src/workspace_mount) uses real processes and mount paths.
Run it explicitly with the mount feature on a host where the component is already enabled; the
[verification entry](#verification-entry-points) explains ignored tests. Cache-fence cases keep a dirty
shared mapping across fork and modify the parent again; msync or closing a descriptor is not substituted
for the native boundary. Component-free CI and compilation do not establish real-platform acceptance.

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

[process/](crates/varin-kernel/src/process) and [storage/process_resources.rs](crates/varin-kernel/src/storage/process_resources.rs) own admitted pipes/PTYs, raw channel output, sequence-bound
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

[text.rs](crates/varin-kernel/src/text.rs) and [codecs](crates/varin-kernel/src/text/codecs.rs) own the
shared strict codec catalog, aliases, detection and serialization. Documents and native tools consume
that catalog rather than maintaining encoding whitelists. Pure text RPCs use the existing body workers
and streaming transport; they are neither a second writer nor a whole-file frame limit.

The [file representation contract](../docs/resources.md#文件准入与观察) describes detection priority,
version binding, paging and conversion. A guess must decode the entire stream. Encoders reject
unmappable characters; edits preserve original raw segments, codec, BOM and line endings where possible.
A bounded diff may coarsen a replacement, never truncate or silently substitute text. Stateful and
multi-scalar codecs use real decoder boundaries, not guessed byte-width tables; late legacy pages may
still cost O(offset). Recovery before-images remain original bytes.

Format evidence is committed with the original operation and current source/path fact in Storage.
Receipt release cannot resurrect an older same-byte codec choice. Disposable scoped projections reuse
evidence only while the raw hash matches; they do not create a document database or global hash map.
WorkingResult publication freezes matching base/child formats with the actual branch/revision/root.
Source cleanup releases the associated facts using canonical Storage identity even if its physical view
has gone. `file.text.conversions` exposes scoped metadata; Host reconciliation separately checks current
bytes and the original user-choice revision.

## Fixed file attachments

[storage/object_views.rs](crates/varin-kernel/src/storage/object_views.rs) owns one-file read-only execution views. Worker I/O does not hold the
Storage actor, and files are copied rather than hard-linked to immutable object storage. Each view
retains the exact source record, current generation and actual Run or external consumer; release
waits for real process exit and preserves unexpected or modified files.

`file.capture` may atomically retain its exact receipt with `retentionRecordId`. Native file-write
receipts publish typed attachment references in the original effect transaction. `file_read` accepts
an authorized reference even without a physical Source, while path reads keep their original grant
checks. `resource_read` exposes content and execution-path views through the frozen resource owner.
