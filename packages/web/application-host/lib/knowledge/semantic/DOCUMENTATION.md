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
  against current Documents revision. Metadata-only skips keep a range-level partial coverage
  marker, while watcher reset/recovery forces content verification. `workspace-runtime.ts` injects
  the Host fixed-source reader for external child drafts and working-branch aliases.
- Production assembly: `workspace-runtime.ts` owns per-workspace Settings/describe resolution, remote
  transport, config watches, backend refresh, query view selection and shutdown. Application Host uses
  its `semanticRecall` / `harnessSettings` / `rerankExploreViews` directly; tests consume those same methods.
  One Host-owned serial reconciler periodically inventories activated roots to recover additions missed
  by quiet watches. The first interval is at least one minute; later quiet intervals use the prior scan's
  elapsed time to target about 1% wall-time duty. Periodic scans stay detached from query latency, while
  watcher reset/recovery still forces content verification.
  A virtual Thread uses its pinned WorkingBranch files. A materialized Thread indexes its execution
  Documents workspace, never the owning workspace's current files. Both Documents mutations and successful
  native-tool journal completions notify this runtime. Open indexes mask an observed path before the tool
  is acknowledged; embedding runs in the background. Metadata resolution obeys query cancellation, and a
  retired workspace worker or closed Host cannot publish a late binding/watch as current.
- Management: `index-management.ts` owns `semantic-index-settings.json` under the Varin data directory.
  It exposes authenticated status and revisioned configuration routes. The settings page reports the
  active index directory, disk bytes, active-root scan progress, and the embedding model binding.
  The user may select child directories inside a multi-project resource root; the inventory then
  starts at those folders rather than enumerating the entire parent. An empty selection disables
  background semantic indexing, leaving lexical and graph search available.
  Directory selection, storage location and request pacing are frozen when the Host starts. Editing them requires a Host
  restart: an active TriviumDB is never moved while open. A different storage directory begins a
  new derived index; the previous cache is preserved until explicitly cleaned up. This storage
  choice affects the code-semantic index, not the authoritative knowledge database, symbol graph,
  or installed local MiniLM component.
- Remote embedding: Pi sends OpenAI-compatible requests. A provider's 400/413 response to a batch
  causes that rejected batch to split recursively; results retain input order and vector-space
  identity. A single rejected input remains an error and the scan reports partial/failed coverage.
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
