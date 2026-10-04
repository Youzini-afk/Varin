# Knowledge storage

The workspace/user KnowledgeStore authority remains TriviumDB 0.8.8. Its existing
`.tdb` files, node IDs, graph links and sidecars are unchanged. There is no migration,
second writer, replacement database or in-main fallback.

The 0.8.6 → 0.8.8 upgrade removes Varin's Windows architecture loader patch:
upstream now chooses the native addon by platform and architecture. Windows ARM64
still builds the missing binary from the exact 0.8.8 release commit. In 0.8.7,
upstream changed parsed-payload cache recency from a linear scan to a logarithmic
index and corrected composite-index `FIND LIMIT` planning. 0.8.8 restores lazy
full-node scanning for unindexed `FIND LIMIT` while preserving residual-filter
correctness. Varin's production graph and knowledge reads use `indexedLookup`
and `substringLookup`, not TQL `FIND` or the new Server/edge-projection APIs.
Those query features do not require a Varin call-site migration.

The authority and derived semantic stores retain `payloadCacheMb: 0` as a memory
and cold-scan choice, rather than as a workaround for the repaired recency bug.
On an isolated 50,000-node Windows x64 fixture, 0.8.8 read all payloads in
98 ms cold / 99 ms warm with no cache, versus 123 ms cold / 93 ms warm with
16 MiB. The indexed all-row lookup took 32 ms versus 22 ms. These single-run
figures show a workload tradeoff; they do not justify enabling a 16–64 MiB cache
for every open store without measurements on real mixed catalogs.

## Execution ownership

`store.ts` is the async Host facade; `store-contract.ts` owns its existing DTOs and
error classes without loading a native addon. `store-process.ts` lazily starts private
Node storage owners per Host module generation: one for authoritative workspace/user
stores and another for derived semantic stores and their maintenance. Semantic vector
work cannot occupy the plan/memory owner's IPC queue. The symbol graph still shares the
authority store and uses the cooperative association refresh below. `store-worker.ts` is their entry; `store-engine.ts`
contains the native implementation. `semantic/store.ts` orchestrates embeddings
through the semantic owner; `semantic/store-engine.ts` owns its native generations.
Opening, indexed reads, graph/vector computations, user writes, checkpoints and
closing run in the corresponding owner. Cache maintenance uses the semantic owner.
Electron uses its own executable in Node mode, like the existing Pi worker boundary.
The Web Host uses the same component. No renderer API or public server is added.

The last successful store close disconnects the process and waits for its exit,
including release of Windows mmap handles. Parent disconnect drains admitted work
and closes the remaining handles. A native close failure retains the handle for
retry. New calls are rejected while a facade is closing; previously admitted calls
are drained first. A lost process rejects pending operations with an unknown-outcome
error and never automatically replays writes or silently switches storage backends.

The private IPC contract has an exhaustive method allowlist, response validation,
advanced serialization for existing Set/Date values, and reconstruction of block
conflict/knowledge mutation errors. Only one transport batch per owner is in flight.
Completed contiguous store groups return after their own durability boundary, before later
groups in that batch. The
64-request scheduling batch is not a data rejection limit: additional requests
remain queued. The boundary snapshots arguments on admission. `removeFileSymbols`
cancellation applies before dispatch; after dispatch the caller receives the actual
native result, not a false cancellation of an already-committed mutation.

Shell start/completion knowledge observations run on their existing owned queue after command verification,
without holding PTY admission, command results or writer release behind an index checkpoint. The next
model request synchronizes that session's observations. Zone 2 reads stop waiting when their request is
cancelled, and do not schedule subsequent reads or recall after that cancellation; accepted storage work
keeps its original durability and outcome. No database writer is killed to satisfy a caller timeout.

## Checkpoints and acknowledgement

`persistence.ts` tracks native data mutations and owns the checkpoint schedule.
Authoritative stores use TriviumDB `syncMode: "full"` for user state: payload/edge writes
fsync their incremental WAL before returning. Derived symbol callbacks keep their
existing `normal` WAL mode and deferred snapshot; the synchronous writer restores
`full` before another operation can enter. Plans, events and memories are
acknowledged on that durable write, without rewriting the entire symbol catalog.
Full snapshots run on the existing 30-second deadline and at close. Contiguous
requests in a store group publish notifications at the end of the group; a batch
is not a rollback transaction.

Authority readers use property/ngram indexes, payload text and graph edges.
The unused full-text/keyword sidecar is neither loaded nor rebuilt. Its text
already exists in payloads; semantic recall continues through derived vectors.
This also keeps acknowledged changes recoverable from WAL without an unlogged
text-index mutation. No user database is deleted or replaced.

A successful complete checkpoint also covers and cancels any pending graph
checkpoint. No-op recall updates/deletions/retention do not request another full
snapshot. A close uses TriviumDB's own final checkpoint rather than calling flush
before native close. Successful authoritative writes require completed WAL fsync;
scheduling a future snapshot alone never acknowledges data.

A failed checkpoint retains the dirty version and pending notifications, reports
its failure and schedules a bounded-backoff retry. The next admitted request must
first recover that checkpoint, including reads and duplicate-write fast paths.
This retries persistence of already-applied state, not the original mutations.
Notifications are observational: observer errors cannot undo a durable write.

The derived semantic and knowledge-vector stores use this checkpoint scheduler
in the separate semantic process, with their existing snapshot acknowledgements
and retryable close/final-flush semantics.
Embedding/provider callbacks and the vector reuse cache stay in the Host.
During an ongoing build, provider gaps do not count as a quiet period: checkpoints
use the existing 30-second deadline, and build completion commits the pending
snapshot. Ordinary incremental updates retain the quiet-period schedule.
New databases recover an uncheckpointed WAL even before the first base file exists.
The database format and full-snapshot cost are unchanged.

Source watch bursts keep one latest-state collection per path. Symbol mutation
admission applies the same Git eligibility as inventory, including unknown file
types; ignored outputs cannot create graph file rows by bypassing structure reads.
After a burst, relation candidates reconcile once per workspace, with another
pass only when new changes arrive during reconciliation.

Association refresh uses one connection-literal set and follows each file's own
association edges. It does not run a global index intersection for every candidate
literal or consumer path. The private `beginAssociationRefresh` / `stepAssociationRefresh` /
`releaseAssociationRefresh` protocol (version 4) processes one file per IPC step, then
returns to the ordinary queue. Plans, context reads and other requests can complete
between files; no full-workspace pass occupies one in-flight transport batch.
Each file's association changes remain a native transaction.

Only changes to connection rows or candidate-bearing file generations invalidate the
completed pass. Ordinary symbol-only files, notes, plans and unchanged repeated requests
do not trigger another scan. If relevant source facts change between steps, the job
refreshes its captured set and file IDs before proceeding. File payloads are read inside
the writer, so a removed/replaced generation cannot be restored by an older snapshot.
Already admitted passes drain before store close; their private state is released after
success/failure and at native close. This changes neither the database format nor its
single-writer ownership, and adds no candidate limit or longer tool timeout.

## Build and verification

### Bot memory implementation boundary

Bot and session scopes use hashed filename-safe keys through `owner-scope.ts`;
these identities are not document workspace roots. They share this storage worker,
not a new database owner. Automatic memory enabled by the user commits effective
`accepted` rows; claim nature and source still distinguish inference from explicit
user requirements. Acceptance is not a persistence receipt or an authority level.

The organizer discovers source events only in workspace and Bot stores. `user.tdb`
is the shared memory destination and is opened exclusively through the Host's user
store owner; directory discovery must not reopen it as a workspace event store.

New organizer proposals can supply the knowledge revision they observed. The
single writer checks both committed and pending mutations before inserting them.
Explicit and automatic memories carry the same original-source ranges (native Pi
entry, event or Run report, revision and text offsets). A paraphrased explicit
record cites `sourceText`; the Host resolves that exact passage on the caller's
branch. Automatic proposals also cite a narrow quote. Covered and retired ranges
are excluded before narration, and the storage writer checks late inferred
proposals against explicit/forgotten evidence. Explicit remembering can
intentionally create a new active row.

Organizer progress retains reviewed ranges, including empty judgments, across all
native Pi branches. List cursors are presentation only; changed source revisions
reopen their ranges. Prepared proposals and their source ranges survive restart;
committed provenance reconciles a crash between memory and coverage writes. This
is recoverable progress, not a cross-store rollback transaction.

Explicit chat selection extraction uses `memory/selection-memory-routes.ts`. Preview validates native
branch text and exact offsets, calls the existing organizer narrator without automatic coverage/commit,
and returns editable drafts with source revisions. Save resolves the session's real owner (including
Bot/session scopes), validates the frozen owner and original revisions, then uses MemoryService.remember.
Source ranges and `user-extracted` provenance use the same memory authority and original-source reader.
Undo verifies the saved row revision and originating session before retiring it. An empty extraction is
a valid result; unconfigured models, invalid envelopes/citations and changed sources remain failures.

`memory get` with `includeSource` and the settings original-passages view read only
the persisted ranges authorized by the selected memory. They report changed or
missing originals instead of presenting another revision as the cited evidence.
Current delivery evidence is in the
[BC acceptance record](../../../../../docs/plan/bot-computer-use-review.md).

### Runtime build

The production Host TypeScript build emits `store-worker.js` next to its facade.
The literal worker URL participates in `scripts/host-production-boundary.mjs`'s
runtime graph. Desktop resolves the physical `app.asar.unpacked` Host entry;
packaged execution needs neither TypeScript source nor a TS loader. Source-development
children explicitly load the repository's tsx package and do not inherit the parent
process's debugger/test-runner arguments.

`store.test.ts` exercises the native implementation directly, including payload-read
complexity instrumentation. Existing context, route, observer, relation and recall
tests exercise its Host consumers. `store-persistence.test.ts` counts real native
checkpoints and injects checkpoint failure; `persistence.test.ts` covers scheduling
and failure-state transitions. `store-process.test.ts` exercises the production
facade/child path, error identity, batching, Set/Date transport, cancellation,
close ordering and recovery of acknowledged data after a real process kill.
Process-kill recovery is not equivalent to a power-loss guarantee.
