# Semantic index

Code-semantic index for explore’s third recall path (design 6.1 / 3.16, D-166–D-193).
Host-only writer. Not the authoritative workspace `.tdb`. Knowledge-base vectors are a sibling
derived store (`../vectors/`); they reuse `harness.embed` but never this MiniLM fallback.

- Identities: `identity.ts` — vector space, index recipe, `{ scopeKind, scopeId }`. Remote spaces use
  `remoteEmbeddingSpaceId` from protocol parts (no credentials).
- Embedder: `backend.ts` — unconfigured → local MiniLM only when the optional component is installed;
  otherwise the semantic source is unavailable. `harness.embedding` set → `remote-embedder.ts`
  via workspace `harness.embed`. Configured remote never falls back to MiniLM in the same query.
- Chunking: `chunker.ts` — tree-sitter containers, backend input length, continue-split of long lines.
  Semantic eligibility follows recognized text language identities, independently of the tree-sitter
  grammar list. Languages such as Scala use native text units with path, line range and content
  revision; `fallback: true` and file-level parents distinguish these from parsed structure.
  Unsupported file identities remain visible in scan coverage and cannot turn a partial repository
  into a claim of complete coverage merely because its supported auxiliary files finished indexing.
  Continue-splitting probes a bounded prefix near the model window instead of
  re-tokenizing the entire remaining suffix for each piece of a generated line.
  The chunk recipe records this partitioning change; source bytes and offsets
  remain complete.
- Cache / schedule: `vector-cache.ts` (space + purpose + embedText, byte soft budget);
  `embed-scheduler.ts` (configurable concurrent request slots and background start interval;
  waiting foreground work takes the next free slot without an artificial interval). This
  scheduler is shared with knowledge-vector embeddings, so its concurrency setting covers both.
  Local backends expose their actual inference grain. Document publication and
  fixed-view vector work release the shared slot between those model calls, so
  a large input request cannot hide many local batches inside one background slot.
  Cancellation is checked between calls; a currently running native forward is
  allowed to finish. Transport backends retain their own batch protocol.
  Local ONNX inference runs in one component-private worker, keeping native
  forward passes and inference tokenization off the Application Host event loop.
  The Host retains the synchronous tokenizer used for source packing. The worker
  admits query batches ahead of queued background calls; an active forward runs
  to completion. Idle workers do not keep a process alive. Retained model
  bindings close with the semantic Host owner after pending work shuts down.
  Recipes can tune `inferenceBatchSize`, `batchByLength` and
  `preferredCpuThreads`. Length grouping restores results to caller order;
  these are measured execution defaults, not text count quotas. The current
  Bekko research pack uses a two-input grain, length grouping and up to four
  inference threads within the Host's available-parallelism policy.
- Overlay: `query-view.ts` pins surface/thread drafts at query start; masked disk paths cannot leak
  old vectors. Thread view is fixed baseline + this branch’s delta.
- Storage: `store.ts` — Host embedding orchestration over the private semantic
  storage process, separate from plan and memory writes. `store-engine.ts` holds one native TriviumDB generation per
  scope/space, scoped Top-K (D-189) and `publishToken`; open/recovery, queries,
  mutations, full checkpoints and cache maintenance never execute on Electron main.
  Source-index queries use native exact Top-K (scoped graph-first or unrestricted exact search).
  Knowledge-vector recall uses `searchDocumentScores`: one writer snapshot validates expected
  revisions, takes native exact Top-1 over every document's full block set, and ranks documents.
  It sends only document IDs, revisions and scores; code-semantic `search` still returns source hits.
  This generation disables automatic QuIVer construction: checkpoints must not build an ANN graph
  that neither query path consumes. Stores outside this shared generation retain their own search policies.
- Runtime: `runtime.ts` — native directory inventory first returns path and stat metadata without
  reading every file body. New, changed, invalidated and failed paths then enter Documents reads,
  parsing and embedding. Successful document publications retain the metadata from the native byte capture
  with the actual content revision in the same native generation. Unchanged-content verification
  updates that hint only against the matching revision/recipe and publication token. Each completed
  batch retains its hints even when a later batch is interrupted; startup reuses those hints and
  prepares only the remaining/changed paths. Metadata equality remains an unverified hint, and
  explicit verification still reads content. Watcher reset/recovery uses metadata reconciliation,
  preserving stable publications. A normal query never traverses the root; returned old hits are checked
  against current Documents revision. Query-time dimension discovery resumes a deferred scan in the
  existing background owner rather than awaiting the entire inventory. Queries consume published
  generations by default; first-publication waiting is an explicit internal option. Coverage records
  indexed source coverage, not whether every unchanged body was reread this pass: metadata skips do
  not add missing-watch gaps. Actual watcher unavailability, unsupported files and read failures remain
  visible. An unchanged inventory neither prepares the embedding model nor rewrites/flushes the generation.
  `workspace-runtime.ts` injects
  the Host fixed-source reader for external child drafts and working-branch aliases.
- Production assembly: `workspace-runtime.ts` owns per-workspace Settings/describe resolution, remote
  transport, config watches, backend refresh, query view selection and shutdown. Application Host uses
  its `semanticRecall` / `harnessSettings` / `rerankExploreViews` directly; tests consume those same methods.
  One Host-owned serial reconciler periodically inventories selected project folders to recover additions missed
  by quiet watches. The first interval is at least one minute; later quiet intervals use the prior scan's
  elapsed time to target about 1% wall-time duty. Periodic scans stay detached from query latency, while
  watcher reset/recovery requests another incremental inventory without aborting an accepted scan
  to replace it with a full content pass.
  Native content verification compares the published revision before parsing or emitting units; an
  unchanged file never enters tokenizer packing or vector publication. Catalog state is loaded once
  per pass rather than requested again per file. One batch prepares on the native background lane
  while preceding publications use the configured model request concurrency; increasing model slots
  does not multiply outstanding parsing batches. Watch publications retain capture metadata too.
  Remote identity uses the actual embedding wire destination and protocol. Chat API changes,
  implicit/explicit default capability declarations, credential references and equivalent forms of
  the default embeddings URL do not change its configuration identity. Provider/model, destination,
  actual vector dimension and configured packing window still distinguish incompatible spaces.
  A virtual Thread uses its pinned WorkingBranch files. A materialized Thread queries its execution
  Documents workspace; background indexing still requires an explicitly selected source folder. Both Documents mutations and successful
  native-tool journal completions notify this runtime. Open indexes mask an observed path before the tool
  is acknowledged; embedding runs in the background. Metadata resolution obeys query cancellation, and a
  retired workspace worker or closed Host cannot publish a late binding/watch as current.
- Management: `index-management.ts` owns `semantic-index-settings.json` under the Varin data directory.
  It exposes authenticated status and revisioned configuration routes. The settings page reports the
  active index directory, disk bytes, active-root scan progress, and the embedding model binding.
  Directory progress bars show published documents; a separate current-pass check counter
  reports inventory processing. Startup shows the existing generation's document count
  without inventing a zero while enumeration is pending.
  Active work includes the current file and preparation/embedding stage. The current-pass counter is
  transient; published document revisions and metadata survive interruption and process restart.
  The UI distinguishes inventory checks, semantic construction and code-relation maintenance;
  a completed semantic pass does not keep displaying its check counter while the graph is finishing.
  Project entries own their folder collection: `path` is the default execution folder and
  `additionalPaths` contains the other explicitly selected folders. `../index-directories.ts`
  persists directory maintenance state in `index-directories.json`: project folders join by default,
  and users may add independent directories. `../index-scope.ts` intersects the active collection
  with Documents addressing roots for both semantic and symbol inventories. A
  registered root, tool read/write, inference request, or Bot home does not grant indexing eligibility.
  Empty collections disable background source indexing; lexical retrieval and direct structure reads
  remain available. The Host's private Bot homes are excluded even when a selected parent contains them.
  Folder edits cancel work under the old scope and refresh indexing without a restart. Queries mask
  removed folders immediately. A broad addressing root is never recursively watched merely because
  one selected project lives beneath it. Startup activates each selected folder directly.
  Same-file watch bursts cancel superseded work and prepare the latest state once;
  pending paths mask old hits immediately. Native exact-file Git eligibility uses
  literal pathspecs rather than enumerating siblings. A non-Git selected parent
  retains ignore handling and delegates nested repositories to their own Git
  inventories, preserving force-tracked ignored files.
  Pausing cancels background scans and stops incremental maintenance while preserving published
  indexes for query-time revision checks. An explicit update check may refresh a paused directory
  once and requests content verification. Startup, new enrollment and resume use incremental
  reconciliation and never inherit that manual verification flag. The directory's checking/busy
  state is released after both accepted scans finish. More-specific folder settings override
  their parent's state; Host-private exclusions always win.
  Removal first persists a deleting state and stops writers. The semantic workspace maintenance gate
  closes active generation handles; `cache-maintenance.ts` then removes the matching paths from every
  retained/current model space and compacts remaining generations, or removes the whole derived
  workspace cache. The graph storage owner deletes matching source rows and compacts its database,
  preserving memory, sessions and other folders. Source files are untouched. Failed cleanup stays
  visible and retryable; deleting entries resume cleanup on Host restart. Removed entries remain
  tombstones so an unchanged project folder is not silently re-added. Existing on-disk caches are
  listed without enrolling their source roots in background indexing; cleanup also works for missing
  source directories. Cache-directory removal and per-folder cleanup share the management write queue.
  Native inventory reports the actual Git root and whether an empty selected directory is ignored.
  Each selected directory can opt into `includeIgnoredDirectories`; the override is clipped to
  the selected indexing scope and applies to subsequent mutation eligibility as well as scans.
  Structure/chunk reads of an admitted exact file do not apply Git filtering again; visibility
  belongs to enumeration and eligibility, while the explicit content read retains native path grants.
  Other directories retain Git filtering. Status distinguishes visible files, semantic candidates,
  structurally supported files, text fallback files, unsupported files and published documents.
  Storage location, request pacing and ignored-file overrides are frozen when the Host starts. Editing them requires a Host
  restart: an active TriviumDB is never moved while open. A different storage directory begins a
  new derived index; the previous cache is preserved until explicitly cleaned up. This storage
  choice affects the code-semantic index, not the authoritative knowledge database, symbol graph,
  or installed local MiniLM component.
- Remote embedding: Pi sends OpenAI-compatible requests. A provider's 400/413 response to a batch
  causes that rejected batch to split recursively; results retain input order and vector-space
  identity. A single rejected input remains an error and the scan reports partial/failed coverage.
  Temporary HTTP 429/5xx failures retry the same batch with cancellable backoff and Retry-After;
  the adapter defaults to two additional attempts and accepts a configurable retry count. Permanent
  errors remain errors. HTTP rerank sends text strings and maps returned indexes to local material IDs.
- Optional component (D-288): `local-component.ts` owns explicit download/import, manifest and file
  verification, a short native inference check process, and atomic activation under
  `dataDir/optional-components/local-semantic`. `local-component-routes.ts` exposes authenticated
  status/install/import/cancel routes. Startup neither downloads components nor loads native inference.
  `model-store.ts` resolves the active package; `local-embedder.ts` imports its absolute runtime entry and sets
  Node ORT session threads. Installation replaces the local embedder for new workspace operations,
  retaining the model identity held by an in-flight query. Remote bindings are not replaced.
  The encoder loads the exact ONNX graph named by the recipe, with the recipe's
  pooling and dimensions; an installed multilingual graph is not routed to a
  hardcoded MiniLM Q8 filename. Graph filenames distinguish local vector spaces.
- `scripts/build-local-semantic-component.mjs` builds and verifies the separate target-specific archive.
  Its Node inference dependencies and model weights never enter the normal Host or desktop build.
  `--model-source <directory>` builds from a prepared `recipe.json`, tokenizer,
  config, ONNX graph and upstream license/NOTICE. It verifies real inference in
  the staged Electron runtime before writing the archive. The release's default
  build still fetches the pinned MiniLM source; research model packs are explicit
  imports until their release model choice is updated.
  Component manifest v2 includes the worker entry and its file hash. Activation
  checks the real worker transport and inference in a child before committing
  the pointer; it retains the previous package if that check fails.

Checkpoint scheduling is shared with `../persistence.ts`: dirty state clears only after successful
native persistence, a failed checkpoint remains retryable, and native close supplies the final flush.
Active builds use the existing 30-second checkpoint deadline across embedding
gaps, then commit at completion; idle incremental writes retain the quiet period.
