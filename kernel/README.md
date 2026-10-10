# Varin Rust system kernel

This workspace contains the private kernel executable used by each Application Host. It is not a
public server and it does not expose a TCP port. The Host supplies private local control/content
endpoints and a one-time bearer through stdin bootstrap. Windows uses named pipes with overlapped
I/O; Unix uses local sockets. Both connections authenticate the same fresh kernel epoch. Stderr
is diagnostics only; requests and output no longer share stdin/stdout.

Control envelopes use length-framed JSON. Content uses separately acknowledged UUID/sequence chunks,
rotating between ready streams at the selected socket-buffer granularity. Frame size bounds individual
packets, not total content. JSON body encoding/decoding runs outside the control readers and domain
actors. Closing either connection invalidates that epoch. A request identity is registered before its
body arrives, so cancellation can acknowledge and discard an unfinished upload without executing it.

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
Materialization and its recovery observations run on independent workers. Storage retains the immutable
source through the started journal and holds the actual physical target/staging/backup leases until each
worker stops. Tree traversal, copying, hashing and verification do not occupy the shared resource owner;
authorization, cancellation at promotion, directory moves and factual receipt commits stay with Storage.
Root registration and explicit reconciliation use the same worker path. Interrupted directories are
preserved when their state cannot be proved, and cleanup never recursively deletes later user content.
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
released. Native discovery obtains a typed observation handle from that same admitted job. Empty-page
and terminal waits use coalescing notifications with registration before predicate recheck, outside the
Storage actor; cancellation wakes the caller independently and cleanup retains the reader until the
worker actually stops. Cursor acknowledgement releases producer credit before waiting for more output.
Scoped cancellation registrations are removed on normal completion as well as cancellation.
The Host still owns request policy, DTO projection, grammar installation admission, tokenizer-aware
packing, embeddings/vector stores, TriviumDB, LSP protocol, and Pi/model orchestration. The kernel does not
become another public search service or model runtime.

## Interactive process component acceptance

The original ProcessManager owns identified stdin/EOF and resize effects. Separate per-process stdin
and resize queues preserve their accepted order without making resize wait for blocked input. Native
`process_write` / `process_resize` tools and retained Agent terminal views use the same original process,
Storage intent and guardian receipt. Body-admission credit is distinct from effect completion; the Host
keeps the request's cancellation and shutdown ownership after that transport credit is returned.

After building a fresh, manifest-matched kernel, the focused OS component cases can be run with:

```sh
VARIN_TEST_KERNEL_EXECUTABLE=/absolute/path/to/fresh/varin-kernel \
  cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib process_interaction_review:: -- --ignored --test-threads=1
VARIN_TEST_KERNEL_EXECUTABLE=/absolute/path/to/fresh/varin-kernel \
  cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib native_input_uses_original_model_intent_and_guardian_receipt_then_reads_same_process -- --ignored
VARIN_TEST_KERNEL_EXECUTABLE=/absolute/path/to/fresh/varin-kernel \
  cargo test --manifest-path kernel/Cargo.toml -p varin-kernel --lib policy_todo_question_reopen_process_wait_and_explicit_resume_use_real_domains -- --ignored
```

These use real guardian pipes/PTYs and persistent domain stores with deterministic provider replies.
They require their declared local process/PTY support; they do not constitute Application Host IPC,
renderer/network or cross-platform product acceptance. The owning Host `request-credit.test.ts` and
terminal `input-wire.test.ts` separately exercise actual consumers with in-memory transport fixtures.
The regular native authority suite below remains the real Host-to-kernel acceptance entry.

## Authority regression acceptance

`bun run test:kernel` requires the built release executable and executes the Node transport suite plus the Vitest
authority, storage adapter, and combined Recovery suites. `node scripts/test-kernel-authority.mjs --build` builds
with the toolchain pinned in this workspace before acceptance; existing Linux/Windows CI jobs run it.

The D-278 [audit](../docs/archive/rust-kernel-audit.md) repairs retain independent native regression cases.
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

## Native Run resource admission

The Catalog instance owns one `ResourceAdmission` shared by every supervisor-launched execution
engine. A complete canonical plan is acquired atomically after permission/service readiness, before
durable dispatch. Conflicting pending plans preserve arrival order; unrelated eligible plans bypass
them. Read/read claims overlap. Cancellation and releases notify waiters directly through bounded,
coalescing control channels; waiting never holds a Catalog transaction or a partial resource plan.

Trusted short read-only result calls own transient leases only. Effectful and job calls write
`resource_occupancy` in their existing dispatch transaction; settlement removes synchronous occupancy
in its existing receipt transaction. A background handoff retains operation-owned claims beyond the
model exchange and Run. Cancellation is not stop evidence. Confirmed executor terminal receipts
release occupancy, including receipts arriving before the exchange's handoff. A trusted process
consumer passes actual tree-stop evidence separately from business outcome, so a stopped process
with an indeterminate effect releases occupancy while an unconfirmed disappearance does not.
Startup clears the dead local Result-contract dispatch windows and restores remaining Job occupancy
before admitting new work; it never infers a detached executor stopped from a recovered
indeterminate business effect. A returned synchronous result releases its local dispatch window even
when the business effect is unknown; that outcome still requires reconciliation and is never replayed.

Native file plans use Storage's existing canonical lease identity (including alias roots, parent
symlinks and platform case handling), freeze it before admission, and recheck it at the actual file
effect boundary. File CAS/journal and physical leases remain Storage authority. Fixed-source reads
include immutable branch revision identity. Discovery consumes Storage snapshots without keeping a
whole-directory lease while searching. Arbitrary spawned programs record shared environment writer
activity; a long-lived development server does not exclusively lock every file or later process in
its environment. Logical scheduling cannot isolate arbitrary third-party filesystem effects; use
conditional file versions and real isolated environments where required.

MCP ordinary RPC scope claims serialize local dispatch windows only. A disconnected or cancelled RPC
cannot prove remote execution stopped; its unknown effect is retained without replay, and the scope
claim must not be presented as a remote filesystem/desktop lock or an MCP Tasks terminal receipt.

MCP composition prepares each direct dependency independently over the shared Host authority. Ready
contributions publish at a closed model exchange; unrelated slow preparation does not delay the model.
Durable schema/configuration identity is separate from the ephemeral live owner handle. Re-enabling an
identically described dependency creates a fresh live binding while old revoked exchanges stay revoked.
Recovery waits only for its recorded dependencies and restores that exact selection. Retired connections
drain their holders/calls, and Host shutdown awaits connection cleanup already in progress.

## Selected context composition

Native context checkpoints retain an optional `personalization.contextComposition`: exact Host
provider identity, immutable declaration digest, session scope, originating selection revision and
named instruction/data sections. Ordinary Host service routing selects the brokered provider; the
context contract accepts only a frozen declarative result, with no model/network/effect callback.
The packaged default and `examples/extensions/project-context` use the same SDK contract.

`composition/context.rs` uses the existing resolver and registry to prepare and publish the typed
transform. A branch-local ephemeral cache reuses unchanged bindings; each context read pins its
actual implementation. Body hydration and native transform invocation run outside the Catalog mutex.
The compiled output becomes part of the normal immutable model snapshot; original history is not
rewritten, and data fragments retain external-data provenance. A context-only selection change can
advance its checkpoint without pretending ordinary memory changed. Invalid selected preparation
preserves the previous checkpoint; ordinary absence is distinct from selected-provider failure.

This is one production Provider/Transform slice, not a general policy/observer implementation or a
claim that all extension services have moved into Rust. Independent review covers actual broker
selection and captured model requests, replacement/failure, unchanged binding reuse and old pins.
