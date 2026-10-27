# Affected-file recovery journal

Varin message recovery is an operation journal, not a workspace archive.

Native workspace targets retain their logical Source and resolve the current generation on execution
or restart. The original journal, file worker and Storage owner still admit every effect. The selected
directory's own attributes use path `.`; applying it requires both the original and target directory
states. Removing/replacing a source root is rejected before dispatch. Root metadata follows the same
three-way path mapping and safety/undo state as other paths, including a scoped child root mapped to a
directory in its parent. Ordinary source capture retains these attributes in the initial baseline.

## Ordinary workspace edits

Documents refactors use the same Rust operation/file journal as `workspace-edit`, without a conversation
checkpoint or Agent Run. Their first durable row retains the ordered plan, original disk states and
surface draft baselines before any effect. Each dispatch and observed result is recorded on that row.
Undo and startup reconciliation remain conditional on original root/epoch, writer admission and the
last confirmed path or buffer state. Unknown surface outcomes and later edits are needs-attention,
not guessed successes. The existing Recovery panel lists each unresolved resource and exposes its
original draft; it does not replay a batch to recover a lost HTTP response.

## Normal turn path

1. The first controlled write creates a lightweight checkpoint bound to its original Catalog input.
2. Native `file_write`/`file_edit` resolve the admitted physical Source, then Rust retains the
   before-image and commits `file.apply` intent and receipt under that same owner.
3. Repeated writes preserve the first before-image and last after-image.
4. `checkpoint-lifecycle.ts` follows existing terminal `run.changed` events and startup discovery.
   Original Run history is readable after branch navigation; visible metadata reads also repair
   unsettled records. Read-only inputs create no empty checkpoint.
5. Settlement uses original tool effects to identify uncovered external writes. It does not scan
   workspace files or add a polling loop.

Thread tools use the same Storage checkpoint/change tables. The original invocation's frozen history
range binds a write to its latest real input; Environment/Agent input is not relabelled as a user or
model request. `file.apply` commits its before-image intent and eventual receipt references with the
same file-operation transaction. Current-format restart reconciliation completes that original record.
Physical targets retain their original workspace, root, Run and execution workspace. The public
conversation identity retains its native Thread and HistoryBranch. Unsupported persisted conversation
identities are rejected without rewriting or deleting their assets.

New sessions, ordinary prompts, and unchanged turns therefore perform no recursive scan. Work scales
with the files actually written by the journalled tools.

## Restore path

`storage/recovery_points.rs` provides the native file-only path. `recovery_points` and `file_restore`
are resident tools in eligible physical Sources. Points group input checkpoints by Run and expose
stable before/after references plus `current:before`. Each path is compared and applied independently,
using existing `file.apply` and recovery object ownership. A restore retains safety objects for undo;
its own writes enter the active input journal, or a separate user-restore record outside an active Run.
Lost replies resolve through the original operation ID and per-file receipts.

The public `fileRecovery` API resolves original Source launch records, including managed Hosts and
materialized worktrees. Naming a point captures current states of previously recorded paths into
existing recovery operation/object tables. Removing a point hides it immediately; shared journal
records stay until older retained points and named points no longer need them. The old public
label-only `createCheckpoint` endpoint is retired.

`FileRecoveryTimeline` uses this API for selected paths, naming, undo and original-operation readback.
The sidebar expands rounds and file differences in place. Visible round titles come from a batched
`runtime.recovery.labels` read of the original user input, independent of the current branch head.
Inspect reads only path metadata; opening a file reads the current physical file through the native
`file.read` worker and the selected target through its retained recovery reference. Preview does not
create a checkpoint. Large text is paged at UTF-8 boundaries and the viewer checks versions before
appending. Restore history is separately paged, and storage details are requested from the original
resource Host only when opened.
The Host uses Documents barriers for the affected registered paths, preserves unsaved drafts as
per-file results, and lets clean files proceed. File-only recovery keeps the conversation active.

Combined conversation/file recovery continues through the following navigation transaction:

Conversation navigation reports the entry IDs that will leave the selected branch. Varin loads the
turn checkpoints bound to those entries and folds their path operations into:

- the expected current state for each affected path;
- the state to restore before the selected message.

Preparation hashes only those paths. Matching paths restore immediately. A later user edit or dirty
buffer becomes a path conflict. A confirmed dirty buffer retains its actual text and disk base in the
original operation's safety objects; the registered surface applies and compensates under its exact
owner, instance and revision. Unknown or disconnected editor state remains retryable
`dirty-state-unavailable`; confirmation does not bypass the missing observation. Before any
write, Varin stores the current version of the affected paths as the redo/compensation state. It does
not create a whole-workspace safety checkpoint or enter global maintenance mode.

The durable operation/file record is owned by the Rust kernel. If file application or a definite
navigation rejection occurs, Varin compensates only paths already changed by that operation. A lost
Thread navigation response is resolved using the original Catalog command receipt, not current-head
equality and not automatic compensation. Startup discovery is separate from owner-ready resumption:
planned operations remain inert, while interrupted operations continue or compensate from their exact
stored phases. Reopened UI reads the original operation and revision. It never creates a new attempt
merely because an earlier response was lost. The former local SQLite recovery engine is test-fixture
code only and is not a production fallback.

For a Thread range spanning managed Hosts, the conversation Host retains one coordinator operation in
its original recovery catalog. Its metadata-only workspace has no default file authority. Before
contacting file owners, it stores the frozen preparation and deterministic participant identities;
an interrupted preparation resumes the same plans and cannot be applied until complete. Local physical
targets keep their original file owners. Managed targets carry their Host identity for display and are
never resolved against an equal path on the coordinator.

Each managed Host verifies the authenticated coordinator's original Source records and reacquires
current maintenance permission. Its existing journal retains its file plans, objects, safety, dirty
surface phases and compensation. The coordinator retains references and receipts only, not remote
content-object ownership. All participants must confirm the file stage before the original HistoryBranch
head command commits. An unknown response remains pending until the original operation or Catalog
receipt answers; transport closure does not prove stopped work or authorize compensation. A definite
navigation rejection compensates each original owner's unchanged outputs. Cancellation and undo use
those same records. Participant startup waits for authenticated source re-admission and never navigates
a second Thread. This is recoverable coordination across individual file transactions, not cross-Host
atomicity.

Thread result integration uses the same selected storage, content objects, exact path-state capture,
conditional apply/compensation phases, and workspace lease through a trusted Host-only adapter. Its
`expected`, `target`, and `safety` states reference readable objects before `apply-intent` is committed.
Startup reconciles both conversation recovery and integration operations through these shared primitives;
integration does not create a second catalog under the workspace root.
For an agent-triggered merge, the original parent input anchor travels in the integration binding.
Each `file.apply`, including compensation, records its before/after state in the same transaction.
New receipts mark that journal coverage; older integrations retain their original incomplete coverage.

Native Integration and ordinary workspace edits retain their own durable operation kinds, before/target identities, Surface dispatch receipts and conditional compensation. Retired `agent-mutation` operations have no native execution owner. Recovery reports unresolved records as `storage-schema-retired` and leaves their records and resources unchanged; it never replays them or fabricates Thread ownership.

## Coverage boundary

Kernel-backed Application Host production contexts expose a Rust `RecoveryDurableOperationPort`. Combined
Recovery, Integration, and ordinary workspace-edit intent and file phases use that port before the first
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

Storage status with a workspace reports `scope: "workspace"` and counts distinct blobs reachable
through that workspace's recovery references. Host-wide status retains shared catalog/WAL totals.
The history inventory contains registrations with actual checkpoints or durable recovery operations.
Point removal releases unshared records; undo operations retain their own references. Shared GC
reclaims objects after all owners release them. A zero-reclaim result is distinct from cleanup failure. GC receipts include
deleted object-file lengths from both prior/orphan cleanup and the committed release pass; the
Host propagates physical deletion failures instead of reporting successful zero-byte cleanup.

The public recovery v7 contract still permits replacement providers to implement application-data,
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

The Storage settings page also measures managed application directories, including knowledge vectors, through
an authenticated, metadata-only Host inventory. It counts hard-linked files once, leaves shared or
unattributable kernel objects in the shared bucket, and does not scan original project directories.
Its sizes are logical file lengths, separate from filesystem volume capacity. Unreadable paths and
unsupported remote storage channels stay explicit rather than becoming zero-byte measurements.

Storage cleanup uses a short-lived Host preview identity, not a renderer path. The native preview
uses the same complete reachability graph as GC; confirmation passes only the previewed object hashes
and rechecks current roots and readers. It neither releases recovery history nor sweeps unrelated
pending files. Knowledge vectors, working copies and source projects are excluded. Completion
receipts report actual file bytes removed and preserve failures; a lost response is not a zero-byte success.

Previews expire after ten minutes only for first acceptance. Running effects remain attached to their
original confirmation, and completed receipts replay for 24 hours after completion. Expired entries
are pruned without re-executing an old confirmation. Preview identities are bound to the authenticated
Host principal; directory-restricted clients cannot use Host-wide management, and read-only clients
can inspect inventory but cannot confirm cleanup. A workspace link retains its original requested
identity and reports a missing catalog registration instead of silently widening to the whole Host.

Storage's device selector is a resource target, independent of the Agent's Runtime endpoint or Catalog.
The current Host resolves only its configured managed HTTP connections using the existing connection
owner, credentials, endpoint identity and actual target Host handshake. A target advertising `storage`
serves the same local inventory/preview/cleanup owner through a local-only managed route; it cannot
forward another nested target. Relay-only connections and older targets without that capability remain
explicitly unsupported, while failed connections and denied access retain their own states.

A forwarded preview is bound to the current authenticated principal, original connection, endpoint,
target Host, scope and target preview identity. Both Hosts check capabilities and directory restrictions.
Confirmation rechecks the original target and never substitutes another connection or Host. If the
response is lost, the same target preview is replayed; it does not create a fresh cleanup. Receipts and
forwarding associations are retained in the owning Host process for the replay window, not promised
across a Host restart. A lost association reports unconfirmed completion and requires a fresh inventory;
the Rust operation receipt and its original effect remain owned by the target storage authority.
