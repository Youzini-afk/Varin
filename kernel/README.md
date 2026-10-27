# Private Rust kernel

Each Application Host owns one packaged `varin-kernel` executable. It combines the resource kernel
with the native Agent runtime, using separate domain authorities inside the same private component.
It has no public TCP server and is shared by Web, Electron and remote Hosts.

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

Storage has one OS-held owner lock and the current typed catalog/object schema. It validates supported
format and structural identity before normal writable recovery. Unsupported/future/malformed/corrupt
stores are errors and their assets are preserved. No second TS writer or internal-format upgrade/import
backend is selected. Workspace files, Git, native Pi data and external configuration are separate assets.

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
Namespace batches share ancestor rebuilds and leave untouched subtrees intact. Temporary content owners
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
