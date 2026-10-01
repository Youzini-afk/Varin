# Varin Rust system kernel

This workspace contains the private kernel executable used by each Application Host. It is not a
public server and it does not expose a TCP port. The Host starts `varin-kernel` with stdin/stdout
framed JSON (`u32` big-endian length followed by one UTF-8 JSON envelope); stderr is diagnostics only.

The wire source is [`protocol/schema.json`](protocol/schema.json). TypeScript DTOs used by the Host
client are generated at `packages/web/application-host/lib/kernel/protocol.generated.ts` and checked by
`bun run kernel:protocol`.

Build locally with:

```text
cargo check --manifest-path kernel/Cargo.toml
bun run kernel:build
```

The native parser uses tree-sitter 0.27 and Wasmtime 48; grammar admission checks the
grammar ABI independently of the JavaScript tooling version. `cargo audit --file kernel/Cargo.lock`
checks the Rust dependency graph in CI alongside the JavaScript audit. Dependabot tracks `/kernel`
so runtime security upgrades also reach the lockfile. Native compute tests accept
`VARIN_TEST_KERNEL_PATH` for a separately built release executable when a running development
Host has locked the default executable on Windows.

Release packaging must copy the resulting executable outside an Electron `app.asar` archive and set
`VARIN_KERNEL_PATH` (or use the release layout resolver). The kernel acquires an owner file in its
storage root, rejects a second writer, recreates obsolete internal catalog formats, and leaves a
corrupt/future catalog as an error rather than an empty store. Recreation never touches workspace files,
Git, native Pi data, or external configuration.

R1 storage commands are domain operations: durable content-object installation, immutable trie roots,
write-revision CAS, published revisions, pins, idempotent operation IDs, recovery records, and GC.

R2 adds a scoped file-resource domain rather than a generic filesystem escape hatch. The Host registers a
Documents-authorized canonical root; the kernel owns exact/subtree overlap leases, typed file capture,
conditional apply, mkdir/remove/rename, and restart reconciliation for started filesystem operations. Regular-file
capture/apply reuses the kernel content-object store. Production Documents/Files/Recovery/Integration and Harness
`fs.lock` share this authority. Registry buffers remain outside Rust.

R3 extends that domain with `file.scan`, `file.measure`, and `file.materialize`. Production WorkingState baseline
capture uses Host-admitted roots and same-grant content owners; immutable roots materialize through verified
staging/backup/promotion with restart reconciliation. Linux/macOS attempt real clone backends and unsupported
filesystems fall back to byte copy; Windows currently reports copy only and leaves physical allocation unknown.
Managed directory reclaim/delete also runs through the kernel. Git remains a semantic adapter for inventory,
index/filter behavior, and linked-worktree metadata; it does not become another workspace-body writer.
There is no arbitrary SQL or arbitrary filesystem-write method on the wire.

R5 adds read-only `compute.start/read/cancel/release` and grammar-recipe registration over those admitted
resources. A job reads exactly one source class: an immutable WorkingState pin, a registered live root, or
explicit fixed objects. Pinned jobs clone a short-lived reader pin; live records carry the revision actually
read; fixed Registry drafts arrive as content objects/tombstones. Scope and requested roots are applied before
candidate selection. Native operations cover list/read/bytes/search and tree-sitter structure/chunks.

Compute output uses bounded cursor records with backpressure. Two foreground workers are isolated from one
background indexing worker, and cancellation reaches traversal/parser work before the reader reference is
released. The Host still owns request policy, DTO projection, grammar installation admission, tokenizer-aware
packing, embeddings/vector stores, TriviumDB, LSP protocol, and Pi/model orchestration. The kernel does not
become another public search service or model runtime.

## Authority regression acceptance

`bun run test:kernel` requires the built release executable and executes the Node transport suite plus the Vitest
authority, storage adapter, and combined Recovery suites. `node scripts/test-kernel-authority.mjs --build` builds
with the toolchain pinned in this workspace before acceptance; existing Linux/Windows CI jobs run it.

The D-278 [audit](../docs/plan/rust-kernel-audit.md) repairs retain independent native regression cases.
D-279 subsequently closes its specific R2 pending-operation and R3 kernel/Git/Registry handoff gaps.
D-280 closes native process authority, and D-281 closes fixed/live file and structure computation through the
production search, Harness, symbol, and semantic consumers.
Current milestone evidence is in [harness status](../docs/status.md).

## R4 native process resources

The format-v10 catalog adds process identities and outcomes to the same Storage. Scoped
`process.spawn/inspect/list/read/write/resize/kill/release` operate on admitted roots/grants.
A guardian is another invocation of this packaged executable, not another kernel/database or Node
PTY shim. It owns a pipe or real PTY and reports a durable native tree-exit receipt.

Raw channel-tagged output has a bounded 1 MiB per-process queue and at most 64 KiB read chunks.
Slow readers apply backpressure. Input has sequence/content identity and acknowledgements;
termination does not wait for output drainage. Release discards output but retains an identity
tombstone to prevent replay. Listing is paged. Command/env plaintext is not in the process catalog.

Windows uses named kill-on-close Jobs; Unix uses managed-session guardians, with Linux subreaper
tracking for adopted descendants. Unproven epoch-loss exits remain unknown and protect directory
reclamation. Storage retains its lock through process drainage. Guardian receipts precede terminal
responses. No hostile OS-sandbox or physical power-cut claim follows from this implementation.

Pipe launches normally escape each argument. The private `windowsRawArguments` field appends an
explicit Windows command-line fragment for shells such as CMD, whose `/c` input must retain its own
quotes and operators. The shell owner supplies this fragment; it participates in the process identity
hash. It is rejected on Unix and PTY launches, which use their normal argument transport.

Use `bun run kernel:build` to supply Application Host build identity and architecture. A plain
Cargo build defaults to the crate identity and is not a production acceptance artifact. See
[the Host consumer map](../packages/web/application-host/lib/process/DOCUMENTATION.md).
