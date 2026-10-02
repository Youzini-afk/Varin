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
- Cache / schedule: `vector-cache.ts` (space + purpose + embedText, byte soft budget);
  `embed-scheduler.ts` (configurable concurrent request slots and background start interval;
  waiting foreground work takes the next free slot without an artificial interval). This
  scheduler is shared with knowledge-vector embeddings, so its concurrency setting covers both.
- Overlay: `query-view.ts` pins surface/thread drafts at query start; masked disk paths cannot leak
  old vectors. Thread view is fixed baseline + this branch’s delta.
- Storage: `store.ts` — one TriviumDB generation per scope/space; scoped Top-K (D-189); `publishToken`.
- Runtime: `runtime.ts` — native directory inventory first returns path and stat metadata without
  reading every file body. New, changed, invalidated and failed paths then enter Documents reads,
  parsing and embedding. A normal query never traverses the root; returned old hits are checked
  against current Documents revision. Query-time dimension discovery resumes a deferred scan in the
  existing background owner rather than awaiting the entire inventory. Queries consume published
  generations by default; first-publication waiting is an explicit internal option. Metadata-only skips keep a range-level partial coverage
  marker, while watcher reset/recovery forces content verification. `workspace-runtime.ts` injects
  the Host fixed-source reader for external child drafts and working-branch aliases.
- Production assembly: `workspace-runtime.ts` owns per-workspace Settings/describe resolution, remote
  transport, config watches, backend refresh, query view selection and shutdown. Application Host uses
  its `semanticRecall` / `harnessSettings` / `rerankExploreViews` directly; tests consume those same methods.
  One Host-owned serial reconciler periodically inventories selected project folders to recover additions missed
  by quiet watches. The first interval is at least one minute; later quiet intervals use the prior scan's
  elapsed time to target about 1% wall-time duty. Periodic scans stay detached from query latency, while
  watcher reset/recovery still forces content verification.
  A virtual Thread uses its pinned WorkingBranch files. A materialized Thread queries its execution
  Documents workspace; background indexing still requires an explicitly selected source folder. Both Documents mutations and successful
  native-tool journal completions notify this runtime. Open indexes mask an observed path before the tool
  is acknowledged; embedding runs in the background. Metadata resolution obeys query cancellation, and a
  retired workspace worker or closed Host cannot publish a late binding/watch as current.
- Management: `index-management.ts` owns `semantic-index-settings.json` under the Varin data directory.
  It exposes authenticated status and revisioned configuration routes. The settings page reports the
  active index directory, disk bytes, active-root scan progress, and the embedding model binding.
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
  Pausing cancels background scans and stops incremental maintenance while preserving published
  indexes for query-time revision checks. An explicit update check may refresh a paused directory
  once. More-specific folder settings override their parent's state; Host-private exclusions always win.
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
  `model-store.ts` resolves the active package; `minilm.ts` imports its absolute runtime entry and sets
  Node ORT session threads. Installation replaces the local embedder for new workspace operations,
  retaining the model identity held by an in-flight query. Remote bindings are not replaced.
- `scripts/build-local-semantic-component.mjs` builds and verifies the separate target-specific archive.
  Its Node inference dependencies and model weights never enter the normal Host or desktop build.

Checkpoint scheduling is shared with `../persistence.ts`: dirty state clears only after successful
native persistence, a failed checkpoint remains retryable, and native close supplies the final flush.
This derived semantic store has not moved to the workspace/user knowledge storage process.
