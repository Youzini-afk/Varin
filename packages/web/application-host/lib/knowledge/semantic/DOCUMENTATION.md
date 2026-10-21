# Semantic index

Code-semantic index for Explore’s semantic recall path.
Host-only writer. Not the authoritative workspace `.tdb`. Knowledge-base vectors are a sibling
derived store (`../vectors/`); they reuse retained native inference but never this local-model fallback.

## Purpose-specific Host inference

`runtime-inference.ts` owns retained embedding leases and assembles purpose-specific Host inference.
Native retrieval's query embedding, decision, rerank and optional query expansion consume one original
query session in `inference-requests.ts`, with one ordinal allocator for actual requests. The
`HostCredentialAuthority`, global purpose settings, egress and original protocol adapters remain
their owners. Catalog owns native request admission,
dispatch, original receipt, Goal usage and recovery. Background document indexing retains its
separate existing index owner below. Request/response/raw-usage bodies live in ContentStore. Private retained
credentials/headers never enter those records.

Ordinary configuration edits do not redirect an accepted request. Explicit disable/revocation and
original Goal/parent control fence dispatch. Runtime events reconcile the exact active Operation;
kernel exit aborts local transports immediately. Stop acknowledgement does not prove remote work
stopped: the Host waits for its actual fetch/body reader and records known/unknown effects separately.
The session closes new scheduler admission when its query callback finishes, retaining already-owned
HTTP/body or local worker work until its receipt or existing unknown-usage barrier is acknowledged. Kernel generation
keeps its original execution owner. An unpublished observed receipt remains with its owner for same-identity publication, and prevents
the SDK from interpreting the persistence failure as permission to send another paid request.
The retained embedding tokenizer reopens only its read-only counter after an epoch change; a failed
initial open is not cached as a permanent failure. Original model HTTP dispatches retain the above
settlement rules. Native transport failures publish a content-free stage, I/O kind, OS code and static
protocol reason to the Host log; arbitrary stderr, source text and credentials are not included.

`local-inference.ts` adapts the existing installed encoder for native query vectors. An unconfigured embedding selection uses the installed component; explicit remote, disabled,
invalid or unavailable selections never fall back. The HTTP settings DTO remains unconfigured for index-status consumers when local inference is selected.
Knowledge-vector recall keeps its separate enrollment and embedding policy.
Workspace native selection is one tagged HTTP/local lease. Local Catalog bindings carry the component
ID/version, canonical verified-manifest digest, model revision and worker protocol, with no endpoint or
credential. The digest includes the manifest's model/tokenizer/recipe/runtime hashes and enters the
vector-space/cache identity; it does not reread model weights per query.

Each actual local grain uses the original InferenceCall session/ordinal and Catalog Operation/Goal.
The shared worker selects a queued grain, requests dispatch permission, then enters the encoder only
after original Catalog, settings, source/grant and document-revision fences. Native gated grains are
not coalesced across callers, so an already-authorized grain cannot wait behind another caller's source
check. Existing ungated CPU batches keep their coalescing. A queued cancel is settled by the worker's
never-started acknowledgement; aborting an observer does not settle active forward. Active completion,
error or worker exit supplies the physical-stop evidence. Worker exit after execute but without a
started acknowledgement leaves execution entry unknown, never false. Original results/errors/usage
remain in ContentStore even when their observer has left; current-format recovery never reruns them.

The worker reports untruncated tokenizer counts as estimated input, not actual pipeline tokenization.
Encoder output tokens are known zero after encoder entry; unavailable input evidence remains missing.
There is no invented price. Each completed/failed grain retains its own receipt, including partial
multi-grain requests. Verified query-cache hits make no worker request or Catalog inference receipt.
Component replacement retains accepted query/scan generations until their pins and actual worker work
drain; reimporting identical bytes reuses the active generation. Shutdown closes admission, releases
selection pins and starts real worker termination before waiting for cancelled scans/callbacks.

Raw provider usage, including missing dimensions, is recorded before answer validation. The SDK's
normalized zero defaults are not accounting evidence. Legitimate SDK retries each re-enter original
Goal/config/permission admission as another HTTP Operation; recovery never restarts the paid batch.
Original owner evidence can refine a recovered unknown receipt once without charging twice.
`research_decide` is the first native consumer; it uses the original Thread material reader, including
PDF extraction, and rechecks retained material authority before each dispatch. llama.cpp uses the
original SDK server-root semantics and three exact frozen routes. Tokenization and template HTTPs
are controlled `preparation`; only `/completion` is `model_compute` charged to Goal. Raw
`tokens_evaluated`/`tokens_predicted` supply usage, with native timing/cache evidence retained;
`n_predict` and timing estimates never fill missing dimensions. Retry and probability-depth expansion
are distinct actual computations. The adapter drains every fetch/body even if the SDK fails early
while a sibling preparation is active. Label promises are request-local, so one caller cancellation
cannot poison another. Ordinary partial failures retain completed scores/choices and original order;
explicit cancellation/revocation still suppresses answers.

Native embedding uses the shared OpenAI-compatible wire with zero automatic retries. Raw
`prompt_tokens` supplies input usage; `total_tokens` alone is not relabeled as input, and an absent
output dimension remains missing. An output-budgeted Goal therefore retains its existing unknown-use
barrier when this provider supplies no output dimension. Query vector cache hits require the current
source, binding and captured credential-scope fingerprint; they create no HTTP Operation or usage.
Fixed/materialized and managed source queries use available publications only. Candidate versions are
checked through the original source; missing source documents do not trigger foreground embedding.
Background document indexing retains its own owner and admission. The retrieval callback may deliver
before outstanding inference drains; `inference-requests.ts` keeps its original session and receipt
responsibility until the actual request has settled.
Managed sources use the original target SourceView for inventory, structure and document-version
checks, including live roots. `resourceRoot` is a target coordinate only; `configurationRoot` selects
the coordinator's global inference settings. Workspace/cache identities include the frozen target
Host, connection, endpoint identity and workspace. Coordinator index selection, ignored-directory
settings and same-named local publications cannot redirect that source. Target authorization and
bytes remain at the source owner; model credentials, requests and usage remain with the Agent owner.

## Index and embedding owners

- Identities: `identity.ts` — vector space, index recipe, `{ scopeKind, scopeId }`. Remote spaces use
  `remoteEmbeddingSpaceId` from protocol parts (no credentials).
- Embedder: `backend.ts` — unconfigured → the installed local encoder only when the optional component is installed;
  otherwise the semantic source is unavailable. Configured remote inference uses `remote-embedder.ts`
  through the retained native lease. Configured remote never falls back to the local model in the same query.
- Chunking: `chunker.ts` — tree-sitter containers, backend input length, continue-split of long lines.
  Remote bindings cap the preferred chunk window at 90% of the selected model's context; a smaller
  explicit chunk budget remains effective. Complete decorated text (source, signature, comments and
  path) fits the same window. Packing uses the retained native tokenizer with batched asynchronous
  probes; document-local count reuse ends with that packing operation. If only a reference vocabulary
  is available, UTF-8 bytes provide a conservative bound until the configured tokenizer is ready.
  Continuation boundaries preserve Unicode characters and source offsets without dropping text.
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
  scheduler is shared with remote knowledge-vector embeddings. Local model work uses its own single-model queue and does not consume HTTP request slots.
  Remote batches use token work budgets rather than sending every outstanding chunk together. An
  explicit provider batch-capacity rejection (or HTTP 413) splits into smaller batches under the same
  retained binding, preserving item order and each original inference receipt. The adapter reuses the
  smaller batch grain for later work. Generic HTTP 400, authentication errors and unknown outcomes do
  not trigger this split. Diagnostics distinguish input capacity, batch capacity and ordinary HTTP errors
  without retaining provider messages that might echo source text or credentials.
  Local backends expose their actual inference grain. Document publication and
  fixed-view vector work release the shared slot between those model calls, so
  a large input request cannot hide many local batches inside one background slot.
  Cancellation is checked between calls; a currently running native forward is
  allowed to finish. Transport backends retain their own batch protocol.
  Local ONNX inference runs in one component-private worker, keeping native
  forward passes and inference tokenization off the Application Host event loop.
  The Host retains the synchronous tokenizer used for source packing. The worker
  admits query batches ahead of queued background calls; an active forward runs
  to completion. Idle workers do not keep a process alive. Accepted query/scan pins retain
  their generation across preparation and batch gaps; unused retired generations close after drain.
  The default Bekko export enables adaptive batching (its FP32 transformer was
  verified across batch compositions). Batch size follows padded token work and
  observed inference duration, within the measured 32-input working grain; every
  input is processed. Host token-length preparation yields between short work
  intervals. Already queued foreground requests can share an immediate inference
  batch without waiting to fill it, except native grains awaiting per-call dispatch authorization.
  Cancellation removes queued calls with a worker acknowledgement; a native forward already in
  progress completes. Observer cancellation and owning physical settlement remain distinct.
  `local-cpu-policy.ts` owns auto/efficient/performance preferences and an optional
  user thread ceiling. The model's four-thread hint is a measured starting point,
  not a reserved core count or a universal ceiling. Auto starts within half of
  available parallelism, efficient within one quarter, performance within 90%;
  an explicit thread ceiling replaces that automatic ceiling. Background duty
  follows CPU time and sampled competing system load. Queries bypass the duty
  delay. Stable competing load can reduce threads and recovery restores them at
  background boundaries; changing an ORT session is amortized against its measured
  load time. This does not benchmark all thread counts at startup or claim an
  optimal hardware profile. CPU settings apply after Host restart. Length grouping
  restores caller order. Quantized custom exports without `adaptiveBatching` keep
  fixed grains because their vectors may depend on batch composition.
- Native non-live view: `source-query.ts` captures an already available publication without inventory,
  source parsing or document embedding. Query vectors use the original inference session and credential
  partition. Each returned candidate must match the source owner's actual document revision. Different
  live rows and missing paths are excluded; no matching source-wide publication means partial or empty
  semantic coverage, while lexical retrieval still reads the selected source. This also applies to
  managed sources, whose resource and cache namespaces remain owner-qualified. Releasing a query does
  not cancel independent indexing. Live sources keep their original published-query path.
- Overlay: `query-view.ts` pins surface/thread drafts at query start; masked disk paths cannot leak
  old vectors. Thread view is fixed baseline + this branch’s delta.
  An empty index with no searchable fixed-view content returns before query embedding. Remote dimension
  discovery can still start the background scan; a building index remains incomplete. Published indexes
  and fixed-view overlays continue through the normal query path. A failed build without published
  content reports failure rather than a successful empty result.
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
  Native retrieval leases retain an immutable publication, with an owner epoch and publication
  identity separate from the durable generation directory. At the existing checkpoint boundary,
  TriviumDB's `publishGenerationManifest` performs the flush; the owner copies every manifest-declared
  member and the manifest into a unique private directory, then opens it in native `immutable` mode.
  These copies never use hardlinks, WAL files or writer locks. Acquisition and pinned searches never
  flush or copy the writer. Recovery creates the first publication during store initialization;
  a cold live query has no reader until a checkpoint exists. A non-live transient view may retain an
  empty original-owner backing without publishing a writer generation. Each lease freezes coverage/lifecycle metadata
  and uses the immutable handle's own scoped block-ID cache. New publications preserve retained old
  readers; final release closes retired handles and removes their files. Store close or owner loss
  invalidates all tokens, and startup under the exclusive writer lock removes abandoned copies.
  Same-space embedder replacement affects future document admissions while an admitted batch keeps
  its original binding through preparation and embedding.
- Background index inference facts: `inference-ledger.ts` uses the same private semantic storage process.
  Its sole durable ledger is `VARIN_DATA_DIR/knowledge/<hostId>/semantic-inference/ledger.tdb`, alongside
  the derived `semantic/` subtree rather than inside it. Storage relocation and index-cache purge
  cannot erase admitted external work. This dimension-independent, one-dimensional Trivium store
  uses full-sync WAL transactions: dispatch intent is acknowledged only after persistence, before
  the inference owner may send HTTP. It records whitelisted operation/identity metadata, input
  hashes, attempt/usage receipts and validated completed vectors; it never stores input text,
  credentials, authentication headers or endpoint URLs. There is no second configuration authority
  or writable mirror of native Run state.
  Index-build keys include workspace/recipe, input hashes and vector binding so a new model can build
  a distinct index. Native query requests use the original Catalog and never also write this ledger.
  Obsolete internal query records are rejected, not imported, silently erased or used as a fallback.
  Live admissions track overlapping inputs under the same workspace, recipe and vector binding,
  independent of batch grouping/order. A locally active request keeps its admission until its transport
  finishes; a cancelled waiter alone does not release it. This set is process-local and avoids scanning
  historical receipts for every new batch.
  Transport batch IDs and credential epochs are excluded from deduplication. Completed-result reuse
  additionally requires the original credential-scope fingerprint and the inference caller's current
  authorization; a different account cannot inherit that result. Successful settled vectors can be
  reused after interruption before publication. Failed or interrupted index computations can start
  a new recorded attempt on a later check once their local transport has stopped, including after
  process recovery. The previous attempt is archived as `semantic-inference-attempt`; its usage and
  uncertain provider outcome stay unchanged. Repeating derived-vector computation does not require
  deleting the index or fabricating a successful previous response. A pending pre-dispatch chain
  retains its live admission until it finishes, so cancellation cannot create concurrent duplicate work.
  HTTP failures, invalid vector responses and classified network failures retain distinct diagnostic
  codes and sanitized details instead of being replaced by a generic indeterminate-dispatch error.
  Facts are retained across restarts without automatic
  pruning; future deletion/retention must preserve unresolved-outcome fences. Read-only workspace-scope
  history projections omit vector payloads and dispatch tokens.
- Runtime: `runtime.ts` — native directory inventory first returns path and stat metadata without
  reading every file body. New, changed, invalidated and failed paths then enter Documents reads,
  parsing and embedding. Successful document publications retain the metadata from the native byte capture
  with the actual content revision in the same native generation. Unchanged-content verification
  updates that hint only against the matching revision/recipe and publication token. Each completed
  batch retains its hints even when a later batch is interrupted; startup reuses those hints and
  prepares only the remaining/changed paths. Metadata equality remains an unverified hint, and
  explicit verification still reads content. Watcher reset/recovery uses metadata reconciliation,
  preserving stable publications. A normal live query never traverses the root; returned old hits are checked
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
  Failed generation shutdown retains its workspace owner for another cleanup attempt. Explicit cache
  removal can retire the private semantic process when native close cannot release a damaged or
  externally deleted database: admitted IPC drains, the worker closes its stores and exits, and only
  then may a replacement open the same files. Other semantic stores and the inference ledger reopen
  on their next operation; in-flight failures are not replayed. Knowledge, plans and source files
  remain with their separate owners. Ordinary store shutdown still reports persistence failures.
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
  or installed local encoder component.
- Remote embedding: `runtime-inference.ts` sends OpenAI-compatible requests through the original
  retained binding and Catalog receipt. The native path uses zero automatic HTTP retries; a failed or
  unknown dispatched request is not replayed to repair observation. Results retain input order and
  vector-space identity, and incomplete batches remain partial/failed rather than successful empty
  coverage. Rerank returns scores against the caller's original material IDs.
- Optional component (D-288): `local-component.ts` owns explicit download/import, manifest and file
  verification, a short native inference check process, and atomic activation under
  `dataDir/optional-components/local-semantic`. `local-component-routes.ts` exposes authenticated
  status/install/import/cancel routes. Startup neither downloads components nor loads native inference.
  `model-store.ts` resolves the active package; `local-embedder.ts` imports its absolute runtime entry and sets
  Node ORT session threads. Installation replaces the local embedder for new workspace operations,
  retaining the model identity held by an in-flight query. Remote bindings are not replaced.
  The encoder loads the exact ONNX graph named by the recipe, with the recipe's
  pooling and dimensions; an installed multilingual graph is not routed to a
  hardcoded MiniLM Q8 filename. The verified manifest digest binds graph, tokenizer, recipe and worker bytes in local vector-space identity.
- `scripts/build-local-semantic-component.mjs` builds and verifies the separate target-specific archive.
  Its Node inference dependencies and model weights never enter the normal Host or desktop build.
  `--model-source <directory>` builds from a prepared `recipe.json`, tokenizer,
  config, ONNX graph and upstream license/NOTICE. It verifies real inference in
  the staged Electron runtime before writing the archive. The release's default
  build fetches pinned Bekko a8m source with per-file SHA256 checks; other model packs are explicit
  imports until their release model choice is updated.
  Component manifest v3 requires worker protocol 1. One shared manifest parser is used by
  installation and active selection. Existing v2 component assets remain on disk, but the current Host
  will not start their old worker. Rebuild with the current builder and import its v3 archive;
  there is no old reader or automatic migration. Format/protocol errors report this required action.
  This native-wiring slice does not publish a component release or download real model weights.
  The builder and activation validator both execute the packaged worker protocol. Activation
  checks the real worker transport and inference in a child before committing
  the pointer; it retains the previous package if that check fails.

Checkpoint scheduling is shared with `../persistence.ts`: dirty state clears only after successful
native persistence, a failed checkpoint remains retryable, and native close supplies the final flush.
Active builds use the existing 30-second checkpoint deadline across embedding
gaps, then commit at completion; idle incremental writes retain the quiet period.
