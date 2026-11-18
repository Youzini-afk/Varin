# Knowledge storage

This module owns **plans**, **symbol indexes**, and **Bot/user long-term knowledge** backed by TriviumDB 0.9.1. Ordinary Agent notes and editable system instructions live in the Rust typed-record owner described in [memory/DOCUMENTATION.md](../memory/DOCUMENTATION.md); new environment observations live in the native Catalog/ContentStore via [`environment-observations`](../environment-observations/README.md). See [retrieval.md](../../../../../docs/retrieval.md) for cross-domain retrieval behavior.

## Entrypoints and process architecture

| File(s) | Responsibility |
| --- | --- |
| [`store.ts`](store.ts), [`store-contract.ts`](store-contract.ts), [`store-protocol.ts`](store-protocol.ts) | Async Host facade, DTOs/errors (no native addon load), and typed IPC protocol |
| [`store-process.ts`](store-process.ts), [`store-worker.ts`](store-worker.ts), [`store-engine.ts`](store-engine.ts) | Private Node storage child-process launcher, worker entry, and native engine |
| [`database.ts`](database.ts), [`persistence.ts`](persistence.ts) | Shared native open (incl. 0.8 WAL-only checkpoint upgrade) and WAL/checkpoint scheduler |
| [`plan-store.ts`](plan-store.ts) | Native Thread/branch plan versions, fork captures, and atomic mutation receipts |
| [`symbols.ts`](symbols.ts), [`association-refresh.ts`](association-refresh.ts), [`file-purge.ts`](file-purge.ts), [`file-purge-engine.ts`](file-purge-engine.ts), [`import-resolve.ts`](import-resolve.ts), [`index-scope.ts`](index-scope.ts) | Workspace symbol graph, cooperative association refresh, and stepped catalog purge |
| [`context-publication.ts`](context-publication.ts), [`context-runtime.ts`](context-runtime.ts), [`recall-material.ts`](recall-material.ts) | Read-only legacy event-journal importer and recall material helpers |
| [`semantic/DOCUMENTATION.md`](semantic/DOCUMENTATION.md), [`vectors/DOCUMENTATION.md`](vectors/DOCUMENTATION.md) | Derived semantic vector storage, inference adapters, and Bot knowledge vector index |

- **Two private storage workers per Host generation** (`store-process.ts`): one for authoritative workspace/user `.tdb` stores (plans, Bot/user knowledge, symbol graph) and one for derived semantic vector stores so vector builds cannot block plan/memory IPC. Electron runs its own executable in Node mode; production builds emit `store-worker.js` next to the facade (`app.asar.unpacked` on desktop).
- **IPC & teardown invariants**: Exhaustive method allowlist; one transport batch in flight per owner (64-request scheduling batch, not a rejection limit); contiguous store groups flush before returning. Closing rejects new calls, drains admitted work, and awaits child exit (releasing Windows mmap handles). Process loss rejects pending calls as unknown outcome (never auto-replays writes or falls back in-process). Shutdown collects errors across workers so a semantic close failure never skips durable authority close. Native `TDB_CORRUPTED_FILE` codes survive IPC; corrupt stores are never deleted or auto-recreated.

## Storage engine, upgrades and checkpoints

- **Format & backup**: TriviumDB 0.9.1 writes v13 checkpoints and v6 WAL (`payloadCacheMb: 0`; unused full-text sidecar is not loaded/rebuilt — reads use property/ngram indexes and payloads). Stop all writers and [back up the full file group](../../../../../docs/ops/cold-backup.md) before upgrading; rollback to 0.9.0 requires restoring the pre-upgrade backup.
- **Upgrade & publish safety**: `database.ts` opens 0.8/0.9.0 checkpoints natively; for legacy WAL-only stores without a base checkpoint, it CRC-checks complete WAL frames and runs a short-lived `triviumdb-upgrade-0.8` helper to close a checkpoint before reopening with 0.9.1 (never for read-only opens or corruption). Native checkpoints retain prior committed files behind a `.publish` undo journal until `.tdb/.vec/.pld/.flush_ok` commit; writable opens restore interrupted publications before WAL replay.
- **Durability (`persistence.ts`)**: Authoritative user writes (plans, memories) use `syncMode: "full"` and fsync incremental WAL before acknowledging; derived symbol callbacks temporarily use `normal` WAL mode and restore `full` before another op enters. Full snapshots run on a 30s deadline and at close (closing an unchanged current-format store skips an extra checkpoint). Failed checkpoints retain dirty state, schedule bounded-backoff retry, and must recover before subsequent admitted ops (including reads).
- **Cooperative graph maintenance**:
  - `association-refresh.ts` steps one file per IPC call (`begin/step/releaseAssociationRefresh`, protocol v4) so plan/memory ops interleave freely; only connection-row or candidate-file changes invalidate a pass.
  - `file-purge*.ts` removes file owners before symbols/links in descending ID order in stepped batches so unrelated plan/memory ops continue; directory removal reports per-domain cleanup phases and continues across independent domain errors.
- **Legacy environment-observation import**: `context-publication.ts` is read-only, paging existing stores by numeric ID into native Catalog import transactions without modifying original `observation:<run>:<node>` IDs or creating stores when absent.

## Bot memory storage boundary

- Bot and Thread scopes use filename-safe hashed keys via [`../harness/owner-scope.ts`](../harness/owner-scope.ts) inside the authority storage worker. `user.tdb` is opened exclusively through the Host's user store owner (never reopened by workspace directory discovery).
- Memories carry original-source ranges (HistoryItem, event, or Run report + revision + UTF-16 offsets) and exact same-scope dependencies (`sources.memories`). Updates/retirement invalidate dependent accounts in the same transaction; `invalidAt` archives while `forgottenAt` excludes original spans and dependents from future model reads.
- Organizer progress (`OrganizerProgress.workId`) references Catalog `MemoryWork` stages (the KnowledgeStore is not an inference scheduler). Covered/retired ranges exclude rediscovery; explicit selection preview/save uses [`../memory/thread-memory.ts`](../memory/thread-memory.ts) and [`../memory/thread-memory-routes.ts`](../memory/thread-memory-routes.ts). See [Bot background inference](../memory/DOCUMENTATION.md#bot-background-inference).

## Native Thread plans (`plan-store.ts`)

- Native Agent and Bot (main and child) Thread plans are stored in the shared user store under dedicated record types (excluded from knowledge lists, recall, and vector indexing) keyed by explicit Thread/branch identity.
- **Atomic CAS & receipts**: Updates check `expectedRef` and commit immutable version, branch pointer, and mutation receipt in one `commitTransaction`. Tool receipts match persistent Operation ID + tagged `ToolOrigin` (no fabricated IDs); user command keys scope to `(Thread, branch)` so lost responses replay the original version even after later edits.
- **Fork captures**: Before creating a Catalog branch, the Host captures the visible plan state (including explicit absence); Catalog stores only the capture ref. Historical resolution walks `previousRef` using epoch-bound Catalog parent cursors (≤256 steps/call) outside locks, rechecking the pointer in-transaction. `expectedHeadId` is an HTTP Catalog admission check, not a cross-store transaction.
- **Cancellation & deletion**: Cancellation detaches the observer before the transaction settles; same-epoch receipt lookup checks durable receipts first, then transient stopping evidence (restart loses transient evidence, so absence never proves no-effect; lookup never repeats a mutation). Deleting a Bot removes its Catalog relations and dedicated Bot knowledge store, while historical native plan records in the shared user store remain inaccessible via public APIs (retention boundary, not physical purge).

## Verification

Focused suites (`store.test.ts`, `store-persistence.test.ts`, `persistence.test.ts`, `store-process.test.ts`) exercise the native engine, checkpoint failure/retry, IPC batching, and process-kill recovery. See [development guide](../../../../../docs/development.md).
