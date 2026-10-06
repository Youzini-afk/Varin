# Affected-file recovery journal

Varin message recovery is an operation journal, not a workspace archive.

## Normal turn path

1. A bound user turn creates one lightweight checkpoint row. No workspace path is read.
2. Host-backed Pi `write`/`edit` first resolve an isolated branch or the admitted
   `document.surfaceWrite` path; `apply_patch` shares that authority.
3. The Host records intent and before-state, then applies through Rust disk operations or the fixed
   Registry owner/revision. It records the actual final state before returning the mutation result.
4. An unavailable mutation backend fails instead of allowing a parallel Pi-worker disk writer.
   The generic journal-only native-tool wrapper is not this production disk path.
5. Repeated writes preserve the first before-image and last after-image. Settlement compares actual
   watcher observations with the journal; uncontrolled shell/Git/external writes remain uncovered.

New sessions, ordinary prompts, and unchanged turns therefore perform no recursive scan. Work scales
with the files actually written by the journalled tools.

## Restore path

Conversation navigation reports the entry IDs that will leave the active Pi branch. Varin loads the
turn checkpoints bound to those entries and folds their path operations into:

- the expected current state for each affected path;
- the state to restore before the selected message.

Preparation hashes only those paths. Matching paths restore immediately. A later user edit or dirty
buffer becomes a path conflict. Current combined restore requires an affected dirty buffer to be saved
or discarded first; a failed dirty-state synchronization returns retryable `dirty-state-unavailable`.
The proposed confirmable dirty-buffer/per-surface fallback is not implemented. Before any
write, Varin stores the current version of the affected paths as the redo/compensation state. It does
not create a whole-workspace safety checkpoint or enter global maintenance mode.

The durable operation/file record is owned by the Rust kernel. If file application or Pi navigation
fails, Varin compensates only paths already changed by that operation. Startup resolves an interrupted
operation from those recorded paths; it never leaves the workspace locked while waiting for a conversation
step. The former local SQLite recovery engine is test-fixture code only and is not a production fallback.

Thread result integration uses the same selected storage, content objects, exact path-state capture,
conditional apply/compensation phases, and workspace lease through a trusted Host-only adapter. Its
`expected`, `target`, and `safety` states reference readable objects before `apply-intent` is committed.
Startup reconciles both conversation recovery and integration operations through these shared primitives;
integration does not create a second catalog under the workspace root.
For an agent-triggered merge, the final integration state and its safety-to-target changes are appended to
the active parent turn checkpoint in the same SQLite transaction. Normal conversation undo therefore uses
the existing checkpoint path; a missing parent binding prevents any integration write.

Root-session batches that mix Document Registry buffers and disk paths use a separate `agent-mutation`
operation in this catalog. It validates every disk member under the Documents resource gate before any
surface dispatch, records external dispatch/receipt/compensation stages, and restores only paths still equal
to this operation's output. Durable `needs-attention` rows are included in recovery status and the Recovery
panel. The current file store captures target-after following the disk write; a crash between those two
steps remains needs-attention rather than being guessed or silently rolled back (D-232).

## Coverage boundary

Kernel-backed Application Host production contexts expose a Rust `RecoveryDurableOperationPort`. Combined
Recovery, Integration, and agent surface/disk mutation intent and file phases use that port before the first
side effect; local SQLite operation rows remain only in isolated fixtures. The port uses one operation
revision for file CAS and terminal completion, so a lost response is reconciled by operation identity rather
than replaying a mutation.

`write` and `edit` have exact before/after coverage because Varin pauses them at the mutation
boundary. A generic native process can modify unknown paths without a portable pre-write hook. Watcher
events identify those paths only after the change, so such a turn is explicitly incomplete for combined
rollback. Conversation-only rollback remains available.

An independent IDE local-history layer may later preserve more external changes as they pass through
Documents or editor VFS operations. It must not reintroduce a per-turn full scan or claim universal
shell rollback without a real copy-on-write or operating-system interception provider.

## Persistence

The built-in `varin.builtin.recovery` provider shares the Rust kernel storage authority with WorkingState.
Its product location is the Application Host kernel root below `VARIN_DATA_DIR/kernel/<hostId>` and it
reports `{ mode: "application-data" }` with `storageManagement: false`. It cannot be moved independently:
doing so would split recovery references from the WorkingState/object transaction domain that R1 deliberately
made authoritative. The Recovery settings UI therefore exposes location and migration controls only when the
selected replacement provider advertises `storageManagement: true`.

The built-in storage status marks its size/object metrics as `scope: "host"`: catalog and WAL bytes
are shared by kernel domains and are not reclaimable-history bytes for each workspace. The history
inventory contains only registrations with actual checkpoints or durable recovery operations;
workspace size/object attribution remains unknown rather than repeating the host totals. The UI
shows shared database size once and runs shared GC once, without unsupported delete-history or
retention controls. A zero-reclaim result is distinct from cleanup failure. GC receipts include
deleted object-file lengths from both prior/orphan cleanup and the committed release pass; the
Host propagates physical deletion failures instead of reporting successful zero-byte cleanup.

The public recovery v5 contract still permits replacement providers to implement application-data,
workspace-local, workspace-adjacent, or custom locations. For those providers, transfer and cleanup semantics
remain provider-owned. They do not grant direct access to the built-in kernel catalog.

The built-in payload is the kernel catalog plus its content-addressed object and staging directories. Content
objects use SHA-256 over the uncompressed bytes. Checkpoints store only affected-path state references.
Working branches and every published Thread result own independent object references in this catalog, so
releasing recovery history cannot collect result or baseline content that a Thread still retains.

User Thread-history release removes selected old `WorkingResult` metadata before dropping its
`thread-result` references. It uses the owning storage's exclusive lease and rechecks live Thread/Run,
review and Integration users; the current branch, report and transcript are retained. Object collection
is exposed only in that leased Host context and checks all remaining reference owners. A completed
Integration owns its own safety/target objects, so undo does not depend on retaining the source result.

WorkingState publication installs and flushes new objects before a Rust SQLite transaction publishes the
immutable root, domain record and references. Old revisions/results/pins keep independent references until
their explicit release; GC only schedules objects that are unreachable from every live root, recovery
operation and temporary owner. A missing or malformed node/object/catalog makes the operation fail rather than authorizing
deletion. Metadata release and physical cleanup have separate outcomes; cleanup failure keeps a retryable
request and does not report zero bytes as success (D-239/D-282).
