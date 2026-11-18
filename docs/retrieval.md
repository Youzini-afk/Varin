# Retrieval, Context Materials & Knowledge

Retrieval gathers facts and primary text; context holds the active session's history; Knowledge stores explicitly retained plans and Bot memory. Base code retrieval requires **no** embedding service, code vector store, symbol graph, or LSP.

## Code Retrieval & Shared Exploration Tools

Two retrieval paths share the same native `ExecutionEngine`, `ToolDirectory`, and context compaction (no separate candidate-scoring/reranking pipeline):

| Entry | Model Setting | Behavior |
| --- | --- | --- |
| `code_retrieval` (fast background) | `models.explore` (default: inherit session model) | Starts an internal Thread/Run owned by the tool's Operation; returns immediately as a Thread-lifetime Job; delivers final answer once into parent's input queue. Hidden from normal conversation/collaboration lists. Controlled via `retrieval_control` (`status` / `wait` / `stop`). |
| Research Agent (formal) | `models.retrievalAgent` | Standard delegated agent with collaboration presence, reports, and continuation. |

- **Internal execution boundaries**: `code_retrieval` freezes model/source/tools (intersection of role and delegatable parent grants) at admission, cannot recursively spawn retrievals or teammates, and bills usage to the parent Thread. Failed preparation before Catalog admission returns `retrieval_preparation_failed` with stage/cause.
- **Source execution views**: `LiveRoot` / `Materialized` / `Native workspace` run directly on their real directories; `FixedBranch` reads immutably and materializes on first command via Storage's journal (`execution_views.rs`).
- **No LSP tools for agents**: `language_*` tools are not exposed to Agent/Bot directories (IDE keeps its own LSP consumers); Tree-sitter runs on-demand per requested file only.

### Shared File, Search & Process Primitives

- **`file_search` / `file_list`**: Accepts single or batch `queries` (`paths` | `lines` | `windows` modes). `nextCursor` resumes a native bounded compute task bound to `(source, query, grant, epoch)` without building a repo-wide index; `scanComplete` vs `pageComplete` stay distinct.
- **`file_read`**: Single or batch `files` with exact `readVersion` and line endings. Optional `unit: { line, symbol, revision }` uses on-demand Tree-sitter to extract the smallest enclosing declaration/import (re-verifying content hash after parse; falls back cleanly to line window with reason).
- **`process_spawn`**: Takes either `[program, ...args]` or `shellCommand` (never string-concatenated). `waitMs` (default `0`) observes exit/initial output; `maxOutputBytes` caps initial output, not process lifetime. `process_read` / `wait_process` stream UTF-8 per channel (Base64 fallback for binary/split bytes).

Key entrypoints: [tools_retrieval.rs](../kernel/crates/varin-kernel/src/tools_retrieval.rs) · [retrieval_control.rs](../kernel/crates/varin-kernel/src/retrieval_control.rs) · [catalog_retrieval.rs](../kernel/crates/varin-runtime/src/catalog_retrieval.rs) · [tools_discovery.rs](../kernel/crates/varin-kernel/src/tools_discovery.rs) · [tools_read.rs](../kernel/crates/varin-kernel/src/tools_read.rs) · [execution_views.rs](../kernel/crates/varin-kernel/src/storage/execution_views.rs) · [thread-collaboration.ts](../packages/web/application-host/lib/kernel/thread-collaboration.ts) · [structure/DOCUMENTATION.md](../packages/web/application-host/lib/structure/DOCUMENTATION.md).

## Web, Academic & Document Materials

### Web Search Connections (`websearch`)

- **Defaults**: With no explicit user connections, anonymous **Exa MCP** runs first with **Parallel MCP** fallback. Explicit disable, empty list, misconfiguration, or missing credentials report distinctly without falling back to anonymous defaults.
- **Supported adapters**: Anonymous Exa/Parallel, plus user-configured **Brave, Exa, Tavily, Jina, SearXNG, AnySearch** (configured in Settings or via agent `harness.web.search.connections` with revision CAS; `enter-credential` opens a Host-bound secret input so keys never reach the model).
- **Filtering & Pagination**: `appliedFilters` reports what was actually enforced upstream vs post-filtered; `strictFilters` rejects unfulfillable filters. Network allow/block policies cannot be loosened by tool args. Upstream pages and display pages paginate independently with freshness checks.

### Fetching, Documents & Citations (`webfetch`, `research_search`, `document_read`)

- **`webfetch`**: Fetches via Host egress (optional browser rendering through Electron's isolated `BrowserOwner`, blocking workers/frames/forms/non-GET and re-checking domain rules per redirect). Supports `question` passage localization, line/section ranges, and `nextRead` pagination. Download truncation, partial extraction, and display pagination stay distinct.
- **PDF & Office**: Uploads and fetched binary docs route through `ThreadMaterials` / `document_read` preserving raw bytes (PDF text/structure/rendered page images are separate views; no silent OCR). Office ZIP inflation enforces Host budgets (defaults: 32 MiB/entry, 128 MiB/package, 10,000 entries via `VARIN_OFFICE_MAX_*`).
- **Citations & Retention**: Observations store immutable snapshots in Rust Storage referenced by `varin-material://` (`source.citation` / `passageCitations`) and typed `attachmentRef`s. Material collections hold explicit cross-task share grants. Plain URLs/hashes never grant access; deletion preserves snapshots referenced by surviving recipients/branches.
- **Optional assistance** (off by default): Smart channel selection and long-page question-reading helper use configured LLM or typed-decision models with programmatic span validation and deterministic fallback on definite errors.
- Entrypoints: `packages/web/application-host/lib/harness/` (`web-search.ts`, `web-fetch.ts`, `web-sources.ts`, `web-materials.ts`, `research-search.ts`, `document-reading.ts`, `material-read-service.ts`, `material-collections.ts`) and `lib/kernel/` (`web-runtime.ts`, `web-retrieval-assistance.ts`, `document-sources.ts`).

## Notes, Bot Memory & KnowledgeStore

- **Ordinary Agent notes**: Lightweight revisioned text in Rust personalization records (global, project, or conversation scope), distinct from `SYSTEM`/`APPEND`/skills files. Conversations freeze a `system-memory` snapshot until compaction commits so edits don't bust prompt prefixes; updates deliver incrementally via request facts.
- **Bot knowledge**: Owned by `MemoryService` + `KnowledgeStore`, isolated from ordinary Agent notes (see [bot.md](bot.md#continuous-context-and-memory) and [memory/DOCUMENTATION.md](../packages/web/application-host/lib/memory/DOCUMENTATION.md)).
- **KnowledgeStore single writer**: Runs in a private TriviumDB child process ([knowledge/DOCUMENTATION.md](../packages/web/application-host/lib/knowledge/DOCUMENTATION.md)); derived semantic embeddings/vectors run in a separate process (`optional-components/local-semantic` for optional local models, or remote embedding channels; falls back to text search when disabled).
- **Thread plans**: Stored in KnowledgeStore with immutable versions, branch refs, and CAS mutation receipts coordinated with Catalog (recoverable coordination, not a cross-DB transaction).
